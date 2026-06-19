export interface Step {
  action: string;
  description: string;
  selector: string;
  tag: string;
  text: string;
  value?: string;
  timestamp: number;
  url: string;
}

export interface LogEntry {
  type: string;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  timestamp: number;
  url: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  timestamp: number;
  durationMs?: number;
  error?: string;
  pageUrl: string;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenshotMode = "full" | "region" | "none";

export interface RecordingSession {
  sessionId: string;
  tabId: number;
  tabUrl: string;
  steps: Step[];
  logs: LogEntry[];
  networks: NetworkEntry[];
  mimeType: string;
  createdAt: number;
  capturedAt: number;
  hasScreenshot: boolean;
  recordingMode: "buffer" | "manual";
  screenshotMode?: ScreenshotMode;
}

export interface UploadResult {
  message: string;
  folder: string;
  video?: string;
  screenshot?: string;
  trimmed: boolean;
}
