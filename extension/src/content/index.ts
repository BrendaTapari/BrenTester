import type { LogEntry, Step } from "../shared/types";
import { MessageType } from "../shared/messages";
import { blobToBase64 } from "../shared/blob-utils";
import { cropScreenshot, pickRegion, removeRegionOverlay } from "./region-picker";

let isRecording = false;

const TAG_LABELS: Record<string, string> = {
  button: "botón",
  input: "campo",
  textarea: "área de texto",
  select: "selector",
  a: "enlace",
  label: "etiqueta",
  div: "contenedor",
  span: "texto",
  img: "imagen",
  form: "formulario",
  h1: "título",
  h2: "título",
  h3: "título",
  li: "elemento de lista",
  td: "celda",
  th: "encabezado",
};

function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

function sendMessage(payload: { type: string; step?: Step; log?: LogEntry }): void {
  void chrome.runtime.sendMessage(payload).catch(() => {});
}

function describeElement(element: Element): {
  tag: string;
  selector: string;
  text: string;
} {
  const tag = element.tagName.toLowerCase();
  const htmlElement = element as HTMLElement;
  const inputElement = element as HTMLInputElement;

  const id = element.id ? `#${element.id}` : "";
  const name = inputElement.name ? `[name="${inputElement.name}"]` : "";
  const ariaLabel = element.getAttribute("aria-label");
  const placeholder = inputElement.placeholder;
  const classes =
    element.classList.length > 0
      ? `.${Array.from(element.classList).slice(0, 2).join(".")}`
      : "";

  const selector = id || name || (ariaLabel ? `[aria-label="${ariaLabel}"]` : "") || classes || tag;
  const text =
    ariaLabel ||
    placeholder ||
    htmlElement.innerText?.trim().slice(0, 80) ||
    inputElement.value?.slice(0, 80) ||
    tag;

  return { tag, selector, text };
}

function pushStep(action: string, element: Element, value?: string): void {
  if (!isRecording) {
    return;
  }

  const { tag, selector, text } = describeElement(element);
  const elementLabel = tagLabel(tag);
  const readable =
    action === "click"
      ? `Clic en ${elementLabel} '${text}'`
      : `Escribió en ${elementLabel} '${text}'${value ? `: "${value}"` : ""}`;

  const step: Step = {
    action,
    description: readable,
    selector,
    tag,
    text,
    value,
    timestamp: Date.now(),
    url: window.location.href,
  };

  sendMessage({ type: MessageType.CAPTURE_STEP, step });
}

function pushLog(log: Omit<LogEntry, "timestamp" | "url">): void {
  if (!isRecording) {
    return;
  }

  sendMessage({
    type: MessageType.CAPTURE_LOG,
    log: {
      ...log,
      timestamp: Date.now(),
      url: window.location.href,
    },
  });
}

function installConsoleInterceptors(): void {
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    pushLog({
      type: "console.error",
      message: args.map((arg) => String(arg)).join(" "),
    });
    originalConsoleError(...args);
  };

  console.warn = (...args: unknown[]) => {
    pushLog({
      type: "console.warn",
      message: args.map((arg) => String(arg)).join(" "),
    });
    originalConsoleWarn(...args);
  };

  window.addEventListener(
    "error",
    (event) => {
      pushLog({
        type: "window.error",
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    pushLog({
      type: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

function installEventListeners(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("#brentester-region-overlay")) {
        return;
      }
      pushStep("click", target);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }
      pushStep("input", target, target.value);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) {
        return;
      }
      pushStep("input", target, target.value);
    },
    { capture: true, passive: true },
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MessageType.CONTENT_RECORDING_START) {
    isRecording = true;
    return false;
  }

  if (message?.type === MessageType.CONTENT_RECORDING_STOP) {
    isRecording = false;
    return false;
  }

  if (message?.type === MessageType.CONTENT_START_REGION_PICKER) {
    pickRegion()
      .then((region) => sendResponse({ ok: true, region }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.CONTENT_CROP_SCREENSHOT) {
    cropScreenshot(message.dataUrl, message.region)
      .then((screenshotBlob) => blobToBase64(screenshotBlob))
      .then((screenshotBase64) => sendResponse({ ok: true, screenshotBase64 }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.CONTENT_REMOVE_REGION_OVERLAY) {
    removeRegionOverlay();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function syncRecordingState(): void {
  chrome.runtime.sendMessage({ type: MessageType.CONTENT_SYNC_RECORDING }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }
    if (response?.isRecording) {
      isRecording = true;
    }
  });
}

syncRecordingState();

installConsoleInterceptors();
installEventListeners();
