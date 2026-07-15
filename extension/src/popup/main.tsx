import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageType } from "../shared/messages";
import type { ScreenshotMode } from "../shared/types";
import "./popup.css";
import { Fullscreen, Video, PictureInPicture } from "lucide-react";

interface StatusResponse {
  isRecording: boolean;
  tabId: number | null;
  sessionId: string | null;
  mode: "buffer" | "manual" | null;
}

interface ActionResponse {
  ok: boolean;
  message?: string;
}

function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T> {
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

function Popup() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMode, setRecordingMode] = useState<"buffer" | "manual" | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const status = await sendRuntimeMessage<StatusResponse>({
      type: MessageType.GET_STATUS,
    });
    setIsRecording(status.isRecording);
    setRecordingMode(status.mode);
  }, []);

  useEffect(() => {
    refreshStatus().catch((err: Error) => setError(err.message));
  }, [refreshStatus]);

  const handleStartBuffer = async () => {
    setIsBusy(true);
    setError(null);
    setInfo(null);

    try {
      const response = await sendRuntimeMessage<ActionResponse>({
        type: MessageType.START_BUFFER_SESSION,
      });

      if (!response.ok) {
        throw new Error(response.message ?? "No se pudo iniciar la sesión.");
      }

      setIsRecording(true);
      setRecordingMode("buffer");
      setInfo(
        "Sesión activa sin límite de tiempo. Al detener o capturar un bug se guarda el último minuto.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartManual = async () => {
    setIsBusy(true);
    setError(null);
    setInfo(null);

    try {
      const response = await sendRuntimeMessage<ActionResponse>({
        type: MessageType.START_MANUAL_RECORDING,
      });

      if (!response.ok) {
        throw new Error(response.message ?? "No se pudo iniciar la grabación.");
      }

      setIsRecording(true);
      setRecordingMode("manual");
      setInfo("Grabando video completo hasta que detengas. Se guarda todo el video, no solo el último minuto.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setIsBusy(false);
    }
  };

  const handleCaptureFullPage = async () => {
    try {
      const response = await sendRuntimeMessage<ActionResponse>({
        type: MessageType.CAPTURE_FULL_PAGE,
      });
      if (!response.ok) {
        console.error(response.message ?? "No se pudo capturar la página completa.");
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      window.close();
    }
  };

  const handleCaptureBug = async (screenshotMode: ScreenshotMode) => {
    try {
      const response = await sendRuntimeMessage<ActionResponse>({
        type: MessageType.CAPTURE_BUG,
        screenshotMode,
      });

      if (!response.ok) {
        console.error(response.message ?? "No se pudo capturar el bug.");
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      window.close();
    }
  };

  const handleReset = async () => {
    setIsBusy(true);
    setError(null);
    setInfo(null);

    try {
      const response = await sendRuntimeMessage<ActionResponse>({
        type: MessageType.RESET_RECORDING,
      });

      if (!response.ok) {
        throw new Error(response.message ?? "No se pudo cerrar la sesión.");
      }

      setIsRecording(false);
      setRecordingMode(null);
      setInfo("Sesión cerrada. Podés iniciar una nueva.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setIsBusy(false);
    }
  };

  const handleStop = async () => {
    setIsBusy(true);
    setError(null);
    setInfo(null);

    try {
      const response = await sendRuntimeMessage<ActionResponse>({
        type: MessageType.STOP_RECORDING,
      });

      if (!response.ok) {
        throw new Error(response.message ?? "No se pudo detener la grabación.");
      }

      setIsRecording(false);
      setRecordingMode(null);
      setInfo("Grabación detenida. Se abrirá la pantalla de revisión.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setIsBusy(false);
    }
  };

  const statusLabel =
    recordingMode === "buffer"
      ? "● Sesión activa (guarda último minuto al detener)"
      : recordingMode === "manual"
        ? "● Grabando video completo"
        : "○ Inactivo";

  return (
    <main className="popup">
      <header>
        <h1>BrenTester</h1>
        <p className="subtitle">
          Sesión sin límite de tiempo. Al detener o capturar un bug se guarda el último minuto.
        </p>
      </header>

      <div className={`status ${isRecording ? "recording" : "idle"}`}>{statusLabel}</div>

      <div className="actions">
        <button type="button" onClick={handleStartBuffer} disabled={isBusy || isRecording}>
          Iniciar sesión
        </button>
        <button type="button" onClick={handleStartManual} disabled={isBusy || isRecording}>
          <Video />
          Grabar video
        </button>
      </div>

      <div className="capture-group">
        <p className="capture-label">Capturar bug:</p>
        <button
          type="button"
          className="capture"
          onClick={() => handleCaptureBug("full")}
          disabled={isBusy || !isRecording}
        >
          Foto de pantalla
        </button>
        <button
          type="button"
          className="capture secondary"
          onClick={() => handleCaptureBug("region")}
          disabled={isBusy || !isRecording}
        >
          <PictureInPicture />
          Foto de un sector
        </button>
      </div>

      <div className="capture-group">
        <p className="capture-label">Captura de página completa (con URL):</p>
        <button
          type="button"
          className="capture fullpage"
          onClick={handleCaptureFullPage}
          disabled={isBusy}
        >
          <Fullscreen />
          Captura completa
        </button>
      </div>

      <div className="actions">
        <button
          type="button"
          className="danger"
          onClick={handleStop}
          disabled={isBusy || !isRecording}
        >
          Detener y guardar
        </button>
        {isRecording ? (
          <button type="button" className="secondary" onClick={handleReset} disabled={isBusy}>
            Cerrar sesión
          </button>
        ) : null}
      </div>

      {info ? <p className="info">{info}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <footer>
        <small>Backend: http://localhost:8000</small>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
