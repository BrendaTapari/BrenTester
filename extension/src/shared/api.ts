import type { LogEntry, NetworkEntry, Step, UploadResult } from "./types";

export const API_UPLOAD_URL = "http://localhost:8000/api/upload-bug";

export async function uploadBugReport(params: {
  videoBlob?: Blob | null;
  steps: Step[];
  logs: LogEntry[];
  networks: NetworkEntry[];
  screenshotBlob?: Blob | null;
  startTime?: number;
  endTime?: number;
  bugName?: string;
}): Promise<UploadResult> {
  const formData = new FormData();

  if (params.videoBlob && params.videoBlob.size > 0) {
    const extension = params.videoBlob.type.includes("mp4") ? "mp4" : "webm";
    formData.append("video", params.videoBlob, `recording.${extension}`);
  }

  formData.append("steps", JSON.stringify(params.steps));
  formData.append("console_logs", JSON.stringify(params.logs));
  formData.append("network_logs", JSON.stringify(params.networks));

  if (params.screenshotBlob && params.screenshotBlob.size > 0) {
    formData.append("screenshot", params.screenshotBlob, "screenshot.png");
  }

  if (params.startTime !== undefined && params.endTime !== undefined) {
    formData.append("start_time", String(params.startTime));
    formData.append("end_time", String(params.endTime));
  }

  const bugName = params.bugName?.trim();
  if (bugName) {
    formData.append("bug_name", bugName);
  }

  const response = await fetch(API_UPLOAD_URL, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let detail = `Error HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: string | Array<{ msg: string }> };
      if (typeof payload.detail === "string") {
        detail = payload.detail;
      } else if (Array.isArray(payload.detail)) {
        detail = payload.detail.map((item) => item.msg).join(", ");
      }
    } catch {
      // Mantener mensaje genérico si el cuerpo no es JSON.
    }
    throw new Error(detail);
  }

  return (await response.json()) as UploadResult;
}
