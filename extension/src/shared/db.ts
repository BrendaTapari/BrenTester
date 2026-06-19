import type { RecordingSession } from "./types";
import { base64ToBlob, isValidBlob } from "./blob-utils";

const DB_NAME = "brentester";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

interface StoredSessionRow {
  sessionId: string;
  videoBlob: Blob;
  videoBase64: string | null;
  screenshotBlob: Blob | null;
  screenshotBase64: string | null;
  session: RecordingSession;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir IndexedDB"));
  });
}

export async function saveRecordingSession(
  session: RecordingSession,
  videoBlob: Blob | null,
  screenshotBlob: Blob | null = null,
): Promise<void> {
  const db = await openDb();

  let screenshotBase64: string | null = null;
  if (isValidBlob(screenshotBlob)) {
    screenshotBase64 = await blobToBase64Safe(screenshotBlob);
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const row: StoredSessionRow = {
      sessionId: session.sessionId,
      videoBlob: isValidBlob(videoBlob) ? videoBlob : new Blob([], { type: "video/webm" }),
      videoBase64: null,
      screenshotBlob: isValidBlob(screenshotBlob) ? screenshotBlob : null,
      screenshotBase64,
      session,
    };
    store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Error guardando sesión"));
  });

  db.close();
}

async function blobToBase64Safe(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("No se pudo serializar la captura."));
        return;
      }
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error("No se pudo serializar la captura."));
    reader.readAsDataURL(blob);
  });
}

export async function loadRecordingSession(sessionId: string): Promise<{
  session: RecordingSession;
  videoBlob: Blob | null;
  screenshotBlob: Blob | null;
} | null> {
  const db = await openDb();

  const row = await new Promise<StoredSessionRow | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(sessionId);
    request.onsuccess = () => resolve(request.result as StoredSessionRow | undefined);
    request.onerror = () => reject(request.error ?? new Error("Error leyendo sesión"));
  });

  db.close();

  if (!row) {
    return null;
  }

  let screenshotBlob: Blob | null = isValidBlob(row.screenshotBlob) ? row.screenshotBlob : null;
  if (!screenshotBlob && row.screenshotBase64) {
    screenshotBlob = base64ToBlob(row.screenshotBase64);
  }

  let videoBlob: Blob | null = isValidBlob(row.videoBlob) ? row.videoBlob : null;
  if (!videoBlob && row.videoBase64) {
    videoBlob = base64ToBlob(row.videoBase64, row.session.mimeType ?? "video/webm");
  }

  return {
    session: row.session,
    videoBlob,
    screenshotBlob,
  };
}

export async function deleteRecordingSession(sessionId: string): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Error eliminando sesión"));
  });

  db.close();
}
