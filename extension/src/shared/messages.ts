import type { LogEntry, RecordingSession, RegionRect, ScreenshotMode, Step } from "./types";
export type { ScreenshotMode };

export const MessageType = {
  GET_STATUS: "GET_STATUS",
  CAPTURE_FULL_PAGE: "CAPTURE_FULL_PAGE",
  START_BUFFER_SESSION: "START_BUFFER_SESSION",
  START_MANUAL_RECORDING: "START_MANUAL_RECORDING",
  STOP_RECORDING: "STOP_RECORDING",
  RESET_RECORDING: "RESET_RECORDING",
  CAPTURE_BUG: "CAPTURE_BUG",
  RECORDING_STARTED: "RECORDING_STARTED",
  RECORDING_STOPPED: "RECORDING_STOPPED",
  RECORDING_ERROR: "RECORDING_ERROR",
  CAPTURE_STEP: "CAPTURE_STEP",
  CAPTURE_LOG: "CAPTURE_LOG",
  CONTENT_RECORDING_START: "CONTENT_RECORDING_START",
  CONTENT_RECORDING_STOP: "CONTENT_RECORDING_STOP",
  CONTENT_START_REGION_PICKER: "CONTENT_START_REGION_PICKER",
  CONTENT_CROP_SCREENSHOT: "CONTENT_CROP_SCREENSHOT",
  CONTENT_REMOVE_REGION_OVERLAY: "CONTENT_REMOVE_REGION_OVERLAY",
  CONTENT_SYNC_RECORDING: "CONTENT_SYNC_RECORDING",
  OFFSCREEN_START: "OFFSCREEN_START",
  OFFSCREEN_STOP: "OFFSCREEN_STOP",
  OFFSCREEN_GET_BUFFER: "OFFSCREEN_GET_BUFFER",
  OFFSCREEN_GET_STATUS: "OFFSCREEN_GET_STATUS",
  OFFSCREEN_FORCE_STOP: "OFFSCREEN_FORCE_STOP",
  OFFSCREEN_RECORDING_READY: "OFFSCREEN_RECORDING_READY",
  OFFSCREEN_RECORDING_COMPLETE: "OFFSCREEN_RECORDING_COMPLETE",
  OFFSCREEN_CAPTURE_FRAME: "OFFSCREEN_CAPTURE_FRAME",
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export type RuntimeMessage =
  | { type: typeof MessageType.GET_STATUS }
  | { type: typeof MessageType.CAPTURE_FULL_PAGE }
  | { type: typeof MessageType.START_BUFFER_SESSION }
  | { type: typeof MessageType.START_MANUAL_RECORDING }
  | { type: typeof MessageType.STOP_RECORDING }
  | { type: typeof MessageType.RESET_RECORDING }
  | { type: typeof MessageType.CAPTURE_BUG; screenshotMode: ScreenshotMode }
  | { type: typeof MessageType.RECORDING_STARTED; tabId: number }
  | { type: typeof MessageType.RECORDING_STOPPED; sessionId: string }
  | { type: typeof MessageType.RECORDING_ERROR; message: string }
  | { type: typeof MessageType.CAPTURE_STEP; step: Step }
  | { type: typeof MessageType.CAPTURE_LOG; log: LogEntry }
  | { type: typeof MessageType.CONTENT_RECORDING_START }
  | { type: typeof MessageType.CONTENT_RECORDING_STOP }
  | { type: typeof MessageType.CONTENT_START_REGION_PICKER }
  | {
      type: typeof MessageType.CONTENT_CROP_SCREENSHOT;
      dataUrl: string;
      region: RegionRect;
    }
  | { type: typeof MessageType.CONTENT_REMOVE_REGION_OVERLAY }
  | { type: typeof MessageType.CONTENT_SYNC_RECORDING }
  | {
      type: typeof MessageType.OFFSCREEN_START;
      streamId: string;
      sessionId: string;
      mode: "buffer" | "manual";
    }
  | {
      type: typeof MessageType.OFFSCREEN_STOP;
      sessionId: string;
      session: RecordingSession;
    }
  | { type: typeof MessageType.OFFSCREEN_GET_BUFFER; sessionId: string }
  | { type: typeof MessageType.OFFSCREEN_GET_STATUS }
  | { type: typeof MessageType.OFFSCREEN_FORCE_STOP }
  | { type: typeof MessageType.OFFSCREEN_CAPTURE_FRAME }
  | { type: typeof MessageType.OFFSCREEN_RECORDING_READY; sessionId: string }
  | {
      type: typeof MessageType.OFFSCREEN_RECORDING_COMPLETE;
      session: RecordingSession;
    };

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}
