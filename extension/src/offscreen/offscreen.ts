import { saveRecordingSession } from "../shared/db";
import { blobToBase64 } from "../shared/blob-utils";
import {
  BUFFER_CHUNK_MS,
  BUFFER_VIDEO_BITRATE,
  BUFFER_WINDOW_MS,
  MANUAL_VIDEO_BITRATE,
  type RecordingMode,
} from "../shared/constants";
import type { RecordingSession } from "../shared/types";
import { MessageType } from "../shared/messages";

interface TimestampedChunk {
  blob: Blob;
  timestamp: number;
}

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let chunks: TimestampedChunk[] = [];
let activeSessionId: string | null = null;
let activeMode: RecordingMode = "buffer";
let activeMimeType = "video/webm";

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm",
    "video/mp4",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}

function getVideoBitrate(): number {
  return activeMode === "buffer" ? BUFFER_VIDEO_BITRATE : MANUAL_VIDEO_BITRATE;
}

function waitForVideoEvent(video: HTMLVideoElement, event: "loadedmetadata" | "seeked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = () => {
      cleanup();
      reject(new Error("No se pudo leer el video."));
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function getBlobDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.src = url;

  try {
    await waitForVideoEvent(video, "loadedmetadata");
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
  }
}

async function trimToLastMinute(sourceBlob: Blob): Promise<Blob> {
  const duration = await getBlobDuration(sourceBlob);
  if (duration <= 61) {
    return sourceBlob;
  }

  const url = URL.createObjectURL(sourceBlob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForVideoEvent(video, "loadedmetadata");
    const startAt = Math.max(0, video.duration - 60);
    video.currentTime = startAt;
    await waitForVideoEvent(video, "seeked");

    const captured = video.captureStream();
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(captured, {
      mimeType,
      videoBitsPerSecond: BUFFER_VIDEO_BITRATE,
    });

    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        parts.push(event.data);
      }
    };

    await new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error("No se pudo recortar el video."));
      recorder.start(1000);
      void video.play().catch(reject);

      window.setTimeout(() => {
        video.pause();
        if (recorder.state === "recording") {
          recorder.stop();
        } else {
          resolve();
        }
      }, 60_500);
    });

    const trimmed = new Blob(parts, { type: mimeType });
    return trimmed.size > 0 ? trimmed : sourceBlob;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
  }
}

async function finalizeBufferVideo(rawBlob: Blob): Promise<Blob> {
  if (activeMode !== "buffer" || rawBlob.size === 0) {
    return rawBlob;
  }

  return trimToLastMinute(rawBlob);
}

async function stopRecorderOnly(): Promise<void> {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise<void>((resolve, reject) => {
      const recorder = mediaRecorder!;
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error("Error deteniendo MediaRecorder"));
      recorder.stop();
    });
  }

  mediaRecorder = null;
}

function pruneBufferChunks(): void {
  if (activeMode !== "buffer" || chunks.length <= 1) {
    return;
  }

  // chunk[0] always contains the WebM init segment — never prune it.
  const initChunk = chunks[0];
  const cutoff = Date.now() - BUFFER_WINDOW_MS;
  const dataChunks = chunks.slice(1).filter((c) => c.timestamp >= cutoff);
  chunks = [initChunk, ...dataChunks];
}

function flushPendingChunk(): Promise<void> {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const recorder = mediaRecorder!;
    const previousHandler = recorder.ondataavailable;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push({
          blob: event.data,
          timestamp: Date.now(),
        });
        pruneBufferChunks();
      }
      recorder.ondataavailable = previousHandler;
      resolve();
    };

    recorder.requestData();
  });
}

function buildVideoBlob(): Blob {
  if (chunks.length === 0) {
    return new Blob([], { type: activeMimeType });
  }

  return new Blob(
    chunks.map((chunk) => chunk.blob),
    { type: activeMimeType },
  );
}

function startRecorder(): void {
  if (!mediaStream) {
    throw new Error("No hay stream de video activo.");
  }

  activeMimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: activeMimeType,
    videoBitsPerSecond: getVideoBitrate(),
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push({
        blob: event.data,
        timestamp: Date.now(),
      });
      pruneBufferChunks();
    }
  };

  mediaRecorder.start(BUFFER_CHUNK_MS);
}

async function startRecording(
  streamId: string,
  sessionId: string,
  mode: RecordingMode,
): Promise<void> {
  if (activeSessionId === sessionId && mediaRecorder?.state === "recording") {
    return;
  }

  if (mediaRecorder || mediaStream) {
    await stopMedia();
    chunks = [];
    activeSessionId = null;
  }

  activeSessionId = sessionId;
  activeMode = mode;
  chunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
  });

  startRecorder();

  chrome.runtime.sendMessage({
    type: MessageType.OFFSCREEN_RECORDING_READY,
    sessionId,
  });
}

async function stopMedia(): Promise<void> {
  await stopRecorderOnly();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

async function getCurrentVideoBlob(): Promise<Blob> {
  await flushPendingChunk();
  const rawBlob = buildVideoBlob();
  return finalizeBufferVideo(rawBlob);
}

async function stopRecording(sessionId: string, session: RecordingSession): Promise<void> {
  if (activeSessionId !== sessionId) {
    throw new Error("No hay una grabación activa en offscreen.");
  }

  await flushPendingChunk();
  const rawBlob = buildVideoBlob();
  const videoBlob =
    session.recordingMode === "buffer" ? await finalizeBufferVideo(rawBlob) : rawBlob;

  await stopMedia();

  activeSessionId = null;
  chunks = [];

  const completeSession: RecordingSession = {
    ...session,
    mimeType: activeMimeType,
  };

  await saveRecordingSession(completeSession, videoBlob);

  chrome.runtime.sendMessage({
    type: MessageType.OFFSCREEN_RECORDING_COMPLETE,
    session: completeSession,
  });
}

async function getBufferVideo(
  sessionId: string,
): Promise<{ videoBase64: string; mimeType: string }> {
  if (activeSessionId !== sessionId) {
    throw new Error("No hay una grabación activa en offscreen.");
  }

  const videoBlob = await getCurrentVideoBlob();
  if (videoBlob.size === 0) {
    throw new Error("Aún no hay video en el buffer.");
  }

  const videoBase64 = await blobToBase64(videoBlob);
  return { videoBase64, mimeType: activeMimeType };
}

async function forceStop(): Promise<void> {
  await stopMedia();
  activeSessionId = null;
  chunks = [];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MessageType.OFFSCREEN_START) {
    startRecording(message.streamId, message.sessionId, message.mode ?? "buffer")
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.OFFSCREEN_STOP) {
    stopRecording(message.sessionId, message.session)
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.OFFSCREEN_GET_BUFFER) {
    getBufferVideo(message.sessionId)
      .then(({ videoBase64, mimeType }) => sendResponse({ ok: true, videoBase64, mimeType }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.OFFSCREEN_GET_STATUS) {
    sendResponse({
      ok: true,
      sessionId: activeSessionId,
      isRecording: mediaRecorder?.state === "recording",
      mode: activeMode,
    });
    return false;
  }

  if (message?.type === MessageType.OFFSCREEN_FORCE_STOP) {
    forceStop()
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  return false;
});
