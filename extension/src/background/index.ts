import { saveRecordingSession } from "../shared/db";
import { dataUrlToBlob, base64ToBlob, isValidBlob } from "../shared/blob-utils";
import { BUFFER_MIN_STEPS, BUFFER_WINDOW_MS, MAX_NETWORK_ENTRIES, type RecordingMode } from "../shared/constants";
import { MessageType, isRuntimeMessage } from "../shared/messages";
import type {
  LogEntry,
  NetworkEntry,
  RecordingSession,
  RegionRect,
  ScreenshotMode,
  Step,
} from "../shared/types";
import { installNetworkMonitor } from "./network-monitor";

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const RECORDING_META_KEY = "recordingMeta";

interface RecordingMeta {
  sessionId: string;
  tabId: number;
  tabUrl: string;
  startedAt: number;
  mode: RecordingMode;
}

interface RecordingState {
  sessionId: string;
  tabId: number;
  tabUrl: string;
  steps: Step[];
  logs: LogEntry[];
  networks: NetworkEntry[];
  startedAt: number;
  mode: RecordingMode;
}

let recordingState: RecordingState | null = null;
let offscreenReady = false;

function createSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneRecordingState(state: RecordingState): void {
  if (state.mode !== "buffer") {
    return;
  }

  const cutoff = Date.now() - BUFFER_WINDOW_MS;

  // Pasos: filtrar por ventana, pero nunca quedar con menos de BUFFER_MIN_STEPS.
  const recentSteps = state.steps.filter((step) => step.timestamp >= cutoff);
  state.steps =
    recentSteps.length >= BUFFER_MIN_STEPS
      ? recentSteps
      : state.steps.slice(-BUFFER_MIN_STEPS);

  state.logs = state.logs.filter((log) => log.timestamp >= cutoff);
  state.networks = state.networks.filter((entry) => entry.timestamp >= cutoff);
}

function getCaptureEvents(state: RecordingState): {
  steps: Step[];
  logs: LogEntry[];
  networks: NetworkEntry[];
} {
  const cutoff = Date.now() - BUFFER_WINDOW_MS;
  const recentSteps = state.steps.filter((step) => step.timestamp >= cutoff);
  const logs = state.logs.filter((log) => log.timestamp >= cutoff);
  const networks = state.networks.filter((entry) => entry.timestamp >= cutoff);

  // Siempre devolver al menos los últimos BUFFER_MIN_STEPS pasos.
  const steps =
    recentSteps.length >= BUFFER_MIN_STEPS
      ? recentSteps
      : state.steps.slice(-BUFFER_MIN_STEPS);

  return { steps, logs, networks };
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) {
    return;
  }

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  if (existingContexts.length > 0) {
    offscreenReady = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Grabar la pestaña activa para reportes de QA con BrenTester.",
  });

  offscreenReady = true;
}

function closeOffscreenDocument(): void {
  offscreenReady = false;
  void chrome.offscreen.closeDocument().catch(() => {});
}

async function saveRecordingMeta(state: RecordingState): Promise<void> {
  const meta: RecordingMeta = {
    sessionId: state.sessionId,
    tabId: state.tabId,
    tabUrl: state.tabUrl,
    startedAt: state.startedAt,
    mode: state.mode,
  };
  await chrome.storage.session.set({ [RECORDING_META_KEY]: meta });
}

async function clearRecordingMeta(): Promise<void> {
  await chrome.storage.session.remove(RECORDING_META_KEY);
}

async function getOffscreenStatus(): Promise<{
  ok: boolean;
  sessionId?: string | null;
  isRecording?: boolean;
}> {
  try {
    return await sendOffscreenMessage({
      type: MessageType.OFFSCREEN_GET_STATUS,
    });
  } catch {
    return { ok: false, sessionId: null, isRecording: false };
  }
}

async function ensureActiveOffscreenRecording(): Promise<void> {
  if (!recordingState) {
    throw new Error("No hay una grabación activa.");
  }

  await ensureOffscreenDocument();

  const status = await getOffscreenStatus();
  if (status.ok && status.sessionId === recordingState.sessionId && status.isRecording) {
    return;
  }

  const streamId = await getMediaStreamId(recordingState.tabId);
  const response = await sendOffscreenMessage<{ ok: boolean; message?: string }>({
    type: MessageType.OFFSCREEN_START,
    streamId,
    sessionId: recordingState.sessionId,
    mode: recordingState.mode,
  });

  if (!response.ok) {
    throw new Error(response.message ?? "No se pudo reconectar la grabación en segundo plano.");
  }
}

async function clearStaleRecording(): Promise<void> {
  if (!recordingState) {
    await clearRecordingMeta();
    return;
  }

  const tabId = recordingState.tabId;
  recordingState = null;
  await clearRecordingMeta();

  await notifyContentScript(tabId, MessageType.CONTENT_RECORDING_STOP).catch(() => {});
  await sendOffscreenMessage({ type: MessageType.OFFSCREEN_FORCE_STOP }).catch(() => {});
  closeOffscreenDocument();
}

async function restoreRecordingIfNeeded(): Promise<void> {
  if (recordingState) {
    return;
  }

  const stored = await chrome.storage.session.get(RECORDING_META_KEY);
  const meta = stored[RECORDING_META_KEY] as RecordingMeta | undefined;
  if (!meta) {
    return;
  }

  try {
    await chrome.tabs.get(meta.tabId);
    recordingState = {
      sessionId: meta.sessionId,
      tabId: meta.tabId,
      tabUrl: meta.tabUrl,
      startedAt: meta.startedAt,
      mode: meta.mode,
      steps: [],
      logs: [],
      networks: [],
    };
    await ensureActiveOffscreenRecording();
    await notifyContentScript(meta.tabId, MessageType.CONTENT_RECORDING_START).catch(() => {});
  } catch {
    recordingState = null;
    await clearRecordingMeta();
  }
}

async function notifyContentScript(tabId: number, type: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    throw new Error(
      "No se pudo comunicar con la pestaña. Recarga la página e intenta de nuevo.",
    );
  }
}

function sendTabMessage<T>(tabId: number, message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response as T);
    });
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No se encontró una pestaña activa para grabar.");
  }
  return tab;
}

async function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) {
        reject(new Error(error?.message ?? "No se pudo capturar la pestaña."));
        return;
      }
      resolve(streamId);
    });
  });
}

function sendOffscreenMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response as T);
    });
  });
}

function getEventsForExport(state: RecordingState): {
  steps: Step[];
  logs: LogEntry[];
  networks: NetworkEntry[];
} {
  if (state.mode === "manual") {
    return {
      steps: [...state.steps],
      logs: [...state.logs],
      networks: [...state.networks],
    };
  }

  return getCaptureEvents(state);
}

async function captureScreenshot(tabId: number, mode: ScreenshotMode): Promise<Blob | null> {
  if (mode === "none") {
    return null;
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.windowId) {
    throw new Error("No se pudo obtener la ventana de la pestaña.");
  }

  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  if (mode === "full") {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const blob = await dataUrlToBlob(dataUrl);
    if (!isValidBlob(blob)) {
      throw new Error("La captura de pantalla quedó vacía.");
    }
    return blob;
  }

  const pickerResponse = await sendTabMessage<{
    ok: boolean;
    region?: RegionRect;
    message?: string;
  }>(tabId, { type: MessageType.CONTENT_START_REGION_PICKER });

  if (!pickerResponse.ok || !pickerResponse.region) {
    throw new Error(pickerResponse.message ?? "No se pudo seleccionar la región.");
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

    const cropResponse = await sendTabMessage<{
      ok: boolean;
      screenshotBase64?: string;
      message?: string;
    }>(tabId, {
      type: MessageType.CONTENT_CROP_SCREENSHOT,
      dataUrl,
      region: pickerResponse.region,
    });

    if (!cropResponse.ok || !cropResponse.screenshotBase64) {
      throw new Error(cropResponse.message ?? "No se pudo recortar la captura.");
    }

    const blob = base64ToBlob(cropResponse.screenshotBase64);
    if (!isValidBlob(blob)) {
      throw new Error("La captura recortada quedó vacía.");
    }

    return blob;
  } finally {
    await sendTabMessage(tabId, { type: MessageType.CONTENT_REMOVE_REGION_OVERLAY }).catch(() => {});
  }
}

async function getBufferVideo(sessionId: string): Promise<Blob> {
  const response = await sendOffscreenMessage<{
    ok: boolean;
    videoBase64?: string;
    mimeType?: string;
    message?: string;
  }>({
    type: MessageType.OFFSCREEN_GET_BUFFER,
    sessionId,
  });

  if (!response.ok || !response.videoBase64) {
    throw new Error(response.message ?? "No se pudo obtener el video del último minuto.");
  }

  const blob = base64ToBlob(response.videoBase64, response.mimeType ?? "video/webm");
  if (!isValidBlob(blob)) {
    throw new Error("Aún no hay video en el buffer. Esperá unos segundos e intentá de nuevo.");
  }

  return blob;
}

async function tryGetVideo(sessionId: string): Promise<Blob | null> {
  try {
    return await getBufferVideo(sessionId);
  } catch {
    return null;
  }
}

async function persistSnapshot(params: {
  state: RecordingState;
  videoBlob: Blob | null;
  screenshotBlob: Blob | null;
  mimeType: string;
  screenshotMode: ScreenshotMode;
}): Promise<string> {
  const sessionId = createSessionId();
  const { steps, logs, networks } = getEventsForExport(params.state);

  const session: RecordingSession = {
    sessionId,
    tabId: params.state.tabId,
    tabUrl: params.state.tabUrl,
    steps,
    logs,
    networks,
    mimeType: params.mimeType,
    createdAt: params.state.startedAt,
    capturedAt: Date.now(),
    hasScreenshot: params.screenshotBlob !== null,
    recordingMode: params.state.mode,
    screenshotMode: params.screenshotMode,
  };

  await saveRecordingSession(session, params.videoBlob, params.screenshotBlob);
  return sessionId;
}

async function startRecording(mode: RecordingMode): Promise<{ tabId: number; mode: RecordingMode }> {
  if (recordingState) {
    try {
      await ensureActiveOffscreenRecording();
      throw new Error("Ya hay una grabación en curso.");
    } catch (error) {
      if (error instanceof Error && error.message === "Ya hay una grabación en curso.") {
        throw error;
      }
      await clearStaleRecording();
    }
  }

  const tab = await getActiveTab();
  const tabId = tab.id!;

  recordingState = {
    sessionId: createSessionId(),
    tabId,
    tabUrl: tab.url ?? "",
    steps: [],
    logs: [],
    networks: [],
    startedAt: Date.now(),
    mode,
  };

  await saveRecordingMeta(recordingState);
  await notifyContentScript(tabId, MessageType.CONTENT_RECORDING_START);
  await ensureOffscreenDocument();

  const streamId = await getMediaStreamId(tabId);
  const response = await sendOffscreenMessage<{ ok: boolean; message?: string }>({
    type: MessageType.OFFSCREEN_START,
    streamId,
    sessionId: recordingState.sessionId,
    mode,
  });

  if (!response.ok) {
    recordingState = null;
    await clearRecordingMeta();
    await notifyContentScript(tabId, MessageType.CONTENT_RECORDING_STOP);
    throw new Error(response.message ?? "No se pudo iniciar la grabación.");
  }

  return { tabId, mode };
}

async function resetRecording(): Promise<void> {
  await clearStaleRecording();
}

async function stopRecording(): Promise<{ sessionId: string }> {
  if (!recordingState) {
    throw new Error("No hay una grabación activa.");
  }

  const currentState = recordingState;

  try {
    await ensureActiveOffscreenRecording();
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `${error.message} Usá «Cerrar sesión» para liberar la grabación.`
        : "La grabación en segundo plano se desconectó. Usá «Cerrar sesión» para liberar la grabación.",
    );
  }

  recordingState = null;
  await clearRecordingMeta();

  await notifyContentScript(currentState.tabId, MessageType.CONTENT_RECORDING_STOP);

  const { steps, logs, networks } = getEventsForExport(currentState);
  const session: RecordingSession = {
    sessionId: currentState.sessionId,
    tabId: currentState.tabId,
    tabUrl: currentState.tabUrl,
    steps,
    logs,
    networks,
    mimeType: "video/webm",
    createdAt: currentState.startedAt,
    capturedAt: Date.now(),
    hasScreenshot: false,
    recordingMode: currentState.mode,
  };

  const response = await sendOffscreenMessage<{ ok: boolean; message?: string }>({
    type: MessageType.OFFSCREEN_STOP,
    sessionId: currentState.sessionId,
    session,
  });

  if (!response.ok) {
    recordingState = currentState;
    await saveRecordingMeta(currentState);
    await notifyContentScript(currentState.tabId, MessageType.CONTENT_RECORDING_START);
    throw new Error(response.message ?? "No se pudo detener la grabación.");
  }

  return { sessionId: currentState.sessionId };
}

async function captureBug(screenshotMode: ScreenshotMode): Promise<{ sessionId: string }> {
  if (!recordingState) {
    throw new Error("Iniciá una sesión o grabación antes de capturar un bug.");
  }

  const currentState = recordingState;
  pruneRecordingState(currentState);

  await ensureActiveOffscreenRecording().catch(() => {});

  const screenshotBlob = await captureScreenshot(currentState.tabId, screenshotMode);
  const videoBlob = await tryGetVideo(currentState.sessionId);

  if (!isValidBlob(screenshotBlob) && !isValidBlob(videoBlob)) {
    throw new Error(
      "No hay foto ni video disponible. Esperá unos segundos o elegí una captura de pantalla.",
    );
  }

  const sessionId = await persistSnapshot({
    state: currentState,
    videoBlob: isValidBlob(videoBlob) ? videoBlob : null,
    screenshotBlob: isValidBlob(screenshotBlob) ? screenshotBlob : null,
    mimeType: "video/webm",
    screenshotMode,
  });

  await openReviewPage(sessionId);
  return { sessionId };
}

async function openReviewPage(sessionId: string): Promise<void> {
  const reviewUrl = chrome.runtime.getURL(`src/review/index.html?sessionId=${sessionId}`);
  await chrome.tabs.create({ url: reviewUrl });
}

// ── Full-page screenshot via CDP ────────────────────────────────────────────

/**
 * Altura en píxeles del strip del frame de video que se usa como "browser chrome"
 * (pestañas + barra de URL). Ajustable si la densidad de pantalla varía.
 */
const BROWSER_CHROME_STRIP_PX = 100;

/**
 * Fusiona la franja superior de un frame del stream de video (que contiene
 * la barra de URL real) con el screenshot completo de la página capturado por CDP.
 *
 * frameBase64  → PNG base64 de un frame del MediaStream activo
 * domBase64    → PNG base64 del screenshot CDP (full-page, sin browser chrome)
 */
async function stitchBrowserFrame(frameBase64: string, domBase64: string): Promise<Blob> {
  const [frameBitmap, domBitmap] = await Promise.all([
    createImageBitmap(base64ToBlob(frameBase64, "image/png")),
    createImageBitmap(base64ToBlob(domBase64,   "image/png")),
  ]);

  const stripH = Math.min(BROWSER_CHROME_STRIP_PX, frameBitmap.height);
  const finalW = domBitmap.width;
  const finalH = stripH + domBitmap.height;

  const canvas = new OffscreenCanvas(finalW, finalH);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  // Franja superior: escala el frame al ancho del DOM screenshot
  ctx.drawImage(frameBitmap, 0, 0, frameBitmap.width, stripH, 0, 0, finalW, stripH);
  // DOM completo debajo de la franja
  ctx.drawImage(domBitmap, 0, stripH);

  frameBitmap.close();
  domBitmap.close();

  return canvas.convertToBlob({ type: "image/png" });
}

function sendDebuggerCommand<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(result as T);
      }
    });
  });
}

async function attachDebugger(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(`No se pudo conectar el debugger: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
}

async function detachDebugger(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      chrome.runtime.lastError; // consume
      resolve();
    });
  });
}

async function addUrlBannerToImage(imageBlob: Blob, url: string): Promise<Blob> {
  const bitmap = await createImageBitmap(imageBlob);
  const BANNER_H = 42;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height + BANNER_H);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, canvas.width, BANNER_H);

  ctx.font = "bold 13px monospace";
  ctx.fillStyle = "#93c5fd";
  ctx.fillText("URL:", 10, 27);

  ctx.font = "13px monospace";
  ctx.fillStyle = "#e2e8f0";
  const maxChars = Math.floor((bitmap.width - 60) / 7.8);
  const label = url.length > maxChars ? `${url.slice(0, maxChars)}…` : url;
  ctx.fillText(label, 52, 27);

  ctx.drawImage(bitmap, 0, BANNER_H);
  bitmap.close();

  return canvas.convertToBlob({ type: "image/png" });
}

async function captureFullPage(): Promise<{ sessionId: string }> {
  const tab = await getActiveTab();
  const tabId = tab.id!;
  const tabUrl = tab.url ?? "";

  await chrome.tabs.update(tabId, { active: true });

  // ── Paso previo: intentar capturar un frame del stream activo ─────────────
  // El frame contiene la barra de URL si el stream es pantalla completa
  // (getDisplayMedia). Con tabCapture solo tiene contenido de la pestaña.
  let liveFrameBase64: string | null = null;
  try {
    const frameResp = await sendOffscreenMessage<{ ok: boolean; frameBase64?: string }>(
      { type: MessageType.OFFSCREEN_CAPTURE_FRAME },
    );
    if (frameResp.ok && frameResp.frameBase64) {
      liveFrameBase64 = frameResp.frameBase64;
    }
  } catch {
    // No hay stream activo — se usará el banner de URL como fallback
  }

  let attached = false;
  let metricsOverrideActive = false;

  try {
    await attachDebugger(tabId);
    attached = true;

    await sendDebuggerCommand(tabId, "Page.enable");

    // ── PASO 1: obtener dimensiones reales del documento ──────────────────
    const evalResult = await sendDebuggerCommand<{
      result: { value: { width: number; height: number } };
    }>(tabId, "Runtime.evaluate", {
      expression: `(function () {
        var el = document.documentElement;
        return {
          width:  Math.max(el.scrollWidth,  el.offsetWidth,  el.clientWidth),
          height: Math.max(el.scrollHeight, el.offsetHeight, el.clientHeight)
        };
      })()`,
      returnByValue: true,
    });

    const fullWidth  = Math.ceil(evalResult.result.value.width);
    const fullHeight = Math.ceil(evalResult.result.value.height);

    // ── PASO 2: forzar al motor a renderizar toda la página ───────────────
    // setDeviceMetricsOverride le dice a Chrome que el "viewport" es tan
    // grande como el documento completo → pinta todo el DOM.
    await sendDebuggerCommand(tabId, "Emulation.setDeviceMetricsOverride", {
      width:             fullWidth,
      height:            fullHeight,
      deviceScaleFactor: 1,
      mobile:            false,
    });
    metricsOverrideActive = true;

    // ── PASO 3: pausa para que el motor de renderizado pinte el área nueva ─
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    // ── PASO 4: captura ───────────────────────────────────────────────────
    const { data } = await sendDebuggerCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      {
        format:               "png",
        captureBeyondViewport: true,
        fromSurface:           true,
      },
    );

    // ── PASO 5: restaurar viewport ANTES de cualquier otra operación ───────
    await sendDebuggerCommand(tabId, "Emulation.clearDeviceMetricsOverride");
    metricsOverrideActive = false;

    const rawBlob = base64ToBlob(data, "image/png");
    if (!isValidBlob(rawBlob)) {
      throw new Error("La captura de página completa quedó vacía.");
    }

    // Si hay un frame del stream activo, fusionamos la franja del browser chrome.
    // Si no, agregamos el banner de URL programático como fallback.
    const screenshotBlob = liveFrameBase64
      ? await stitchBrowserFrame(liveFrameBase64, data)
      : await addUrlBannerToImage(rawBlob, tabUrl);

    const sessionId = createSessionId();
    const session: RecordingSession = {
      sessionId,
      tabId,
      tabUrl,
      steps:    recordingState?.tabId === tabId ? [...(recordingState.steps    ?? [])] : [],
      logs:     recordingState?.tabId === tabId ? [...(recordingState.logs     ?? [])] : [],
      networks: recordingState?.tabId === tabId ? [...(recordingState.networks ?? [])] : [],
      mimeType:      "video/webm",
      createdAt:     Date.now(),
      capturedAt:    Date.now(),
      hasScreenshot: true,
      recordingMode: "buffer",
      screenshotMode: "full",
    };

    await saveRecordingSession(session, null, screenshotBlob);
    await openReviewPage(sessionId);
    return { sessionId };

  } finally {
    // Limpieza garantizada: si algo lanzó antes del clear explícito, lo hacemos acá.
    if (metricsOverrideActive) {
      await sendDebuggerCommand(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
    if (attached) {
      await detachDebugger(tabId);
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return false;
  }

  if (message.type === MessageType.GET_STATUS) {
    void ensureActiveOffscreenRecording().catch(() => {});

    sendResponse({
      isRecording: recordingState !== null,
      tabId: recordingState?.tabId ?? null,
      sessionId: recordingState?.sessionId ?? null,
      mode: recordingState?.mode ?? null,
    });
    return false;
  }

  if (message.type === MessageType.CAPTURE_FULL_PAGE) {
    captureFullPage()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === MessageType.START_BUFFER_SESSION) {
    startRecording("buffer")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === MessageType.START_MANUAL_RECORDING) {
    startRecording("manual")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === MessageType.STOP_RECORDING) {
    stopRecording()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === MessageType.RESET_RECORDING) {
    resetRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === MessageType.CAPTURE_BUG) {
    captureBug(message.screenshotMode ?? "full")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === MessageType.CAPTURE_STEP && recordingState) {
    recordingState.steps.push(message.step);
    pruneRecordingState(recordingState);
    return false;
  }

  if (message.type === MessageType.CAPTURE_LOG && recordingState) {
    recordingState.logs.push(message.log);
    pruneRecordingState(recordingState);
    return false;
  }

  if (message.type === MessageType.CONTENT_SYNC_RECORDING) {
    const tabId = _sender.tab?.id;
    sendResponse({
      isRecording:
        recordingState !== null &&
        tabId !== undefined &&
        recordingState.tabId === tabId,
    });
    return false;
  }

  if (message.type === MessageType.OFFSCREEN_RECORDING_COMPLETE) {
    void openReviewPage(message.session.sessionId)
      .then(() => closeOffscreenDocument())
      .catch((error: Error) => {
        console.error("Error abriendo revisión:", error);
      });

    return false;
  }

  return false;
});

installNetworkMonitor(
  () => recordingState?.tabId ?? null,
  () => recordingState?.tabUrl ?? "",
  (entry) => {
    if (!recordingState) {
      return;
    }

    recordingState.networks.push(entry);
    if (recordingState.networks.length > MAX_NETWORK_ENTRIES) {
      recordingState.networks = recordingState.networks.slice(-MAX_NETWORK_ENTRIES);
    }
    pruneRecordingState(recordingState);
  },
);

void restoreRecordingIfNeeded();
