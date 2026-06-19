import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { uploadBugReport } from "../shared/api";
import { isValidBlob } from "../shared/blob-utils";
import { loadRecordingSession } from "../shared/db";
import type { LogEntry, NetworkEntry, RecordingSession, Step } from "../shared/types";
import "./review.css";

function formatNetworkEntry(entry: NetworkEntry): string {
  const status = entry.status !== undefined ? String(entry.status) : entry.error ?? "error";
  const duration =
    entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : "";
  return `${entry.method} ${status} ${entry.url}${duration}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function getSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("sessionId");
}

function resolveVideoDuration(video: HTMLVideoElement): Promise<number> {
  return new Promise((resolve) => {
    const applyDuration = () => {
      const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      resolve(total);
    };

    if (Number.isFinite(video.duration) && video.duration > 0 && video.duration !== Infinity) {
      applyDuration();
      return;
    }

    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      applyDuration();
    };

    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = Number.MAX_SAFE_INTEGER;
    } catch {
      applyDuration();
    }
  });
}

function ReviewPage() {
  const sessionId = useMemo(() => getSessionIdFromUrl(), []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [screenshotBlob, setScreenshotBlob] = useState<Blob | null>(null);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setError("No se encontró el identificador de sesión.");
      setLoading(false);
      return;
    }

    let videoObjectUrl: string | null = null;
    let screenshotObjectUrl: string | null = null;

    loadRecordingSession(sessionId)
      .then((result) => {
        if (!result) {
          throw new Error("No se encontró la grabación en almacenamiento local.");
        }

        setSession(result.session);

        if (isValidBlob(result.videoBlob)) {
          videoObjectUrl = URL.createObjectURL(result.videoBlob);
          setVideoBlob(result.videoBlob);
          setVideoUrl(videoObjectUrl);
        } else {
          setVideoBlob(null);
          setVideoUrl(null);
        }

        if (isValidBlob(result.screenshotBlob)) {
          screenshotObjectUrl = URL.createObjectURL(result.screenshotBlob);
          setScreenshotBlob(result.screenshotBlob);
          setScreenshotUrl(screenshotObjectUrl);
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));

    return () => {
      if (videoObjectUrl) {
        URL.revokeObjectURL(videoObjectUrl);
      }
      if (screenshotObjectUrl) {
        URL.revokeObjectURL(screenshotObjectUrl);
      }
    };
  }, [sessionId]);

  const initializeDuration = async (
    video: HTMLVideoElement,
    recordingMode: RecordingSession["recordingMode"],
  ) => {
    const total = await resolveVideoDuration(video);
    setDuration(total);

    if (recordingMode === "buffer" && total > 10) {
      const segmentStart = Math.max(0, total - 10);
      setStartTime(segmentStart);
      setEndTime(total);
      video.currentTime = segmentStart;
    } else {
      setStartTime(0);
      setEndTime(total);
      video.currentTime = 0;
    }
  };

  const handleStartChange = (value: number) => {
    const nextStart = Math.min(value, endTime - 0.1);
    const clamped = Math.max(0, nextStart);
    setStartTime(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
  };

  const handleEndChange = (value: number) => {
    const nextEnd = Math.max(value, startTime + 0.1);
    const clamped = Math.min(duration, nextEnd);
    setEndTime(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
  };

  const shouldApplyTrim = (): boolean => {
    if (duration <= 0) {
      return false;
    }
    return startTime > 0.05 || endTime < duration - 0.05;
  };

  const hasVideo = Boolean(videoBlob && videoBlob.size > 0);

  const getUploadTrim = (): { startTime?: number; endTime?: number } => {
    if (!hasVideo || duration <= 0) {
      return {};
    }

    if (shouldApplyTrim()) {
      return { startTime, endTime };
    }

    return {};
  };

  const applyLastSeconds = (seconds: number) => {
    if (duration <= 0) {
      return;
    }
    const segmentStart = Math.max(0, duration - seconds);
    setStartTime(segmentStart);
    setEndTime(duration);
    if (videoRef.current) {
      videoRef.current.currentTime = segmentStart;
    }
  };

  const handleSave = async () => {
    if (!session) {
      return;
    }

    if (!hasVideo && !screenshotBlob) {
      setError("No hay foto ni video para enviar.");
      return;
    }

    setUploading(true);
    setError(null);
    setSuccess(null);

    try {
      const trim = getUploadTrim();
      const result = await uploadBugReport({
        videoBlob: hasVideo ? videoBlob : null,
        steps: session.steps as Step[],
        logs: session.logs as LogEntry[],
        networks: (session.networks ?? []) as NetworkEntry[],
        screenshotBlob,
        startTime: trim.startTime,
        endTime: trim.endTime,
      });

      const screenshotNote = result.screenshot ? ` Captura: ${result.screenshot}.` : "";
      const trimNote = result.trimmed ? " Video recortado." : "";
      setSuccess(`${result.message} Carpeta: ${result.folder}.${trimNote}${screenshotNote}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al enviar el reporte.");
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <main className="review-page">
        <p>Cargando grabación...</p>
      </main>
    );
  }

  if (error && !session) {
    return (
      <main className="review-page">
        <p className="error">{error}</p>
      </main>
    );
  }

  const isManual = session?.recordingMode === "manual";

  return (
    <main className="review-page">
      <header>
        <h1>BrenTester — Revisar reporte</h1>
        <p>
          {isManual
            ? "Grabación manual: mové los sliders para recortar el tramo que querés enviar."
            : "Sesión: elegí qué tramo del último minuto querés guardar (por defecto, los últimos 10 s)."}
        </p>
      </header>

      <section className="panel">
        {videoUrl && hasVideo ? (
          <video
            ref={videoRef}
            className="player"
            src={videoUrl}
            controls
            onLoadedMetadata={(event) => {
              if (session) {
                void initializeDuration(event.currentTarget, session.recordingMode);
              }
            }}
          />
        ) : (
          <p className="trim-hint">Sin video en esta captura. Se enviarán la foto, los pasos y los logs.</p>
        )}

        {screenshotUrl ? (
          <div className="screenshot-block">
            <h2>Captura de pantalla</h2>
            <img className="screenshot" src={screenshotUrl} alt="Captura del bug" />
          </div>
        ) : null}

        {hasVideo ? (
          <div className="trim-controls">
          <p className="trim-hint">
            Recorte: {formatTime(startTime)} → {formatTime(endTime)}
            {duration > 0 ? ` (duración total ${formatTime(duration)})` : ""}
          </p>

          {!isManual ? (
            <div className="trim-presets">
              <button type="button" className="preset" onClick={() => applyLastSeconds(10)}>
                Últimos 10 s
              </button>
              <button type="button" className="preset" onClick={() => applyLastSeconds(30)}>
                Últimos 30 s
              </button>
              <button
                type="button"
                className="preset"
                onClick={() => {
                  setStartTime(0);
                  setEndTime(duration);
                  if (videoRef.current) {
                    videoRef.current.currentTime = 0;
                  }
                }}
              >
                Minuto completo
              </button>
            </div>
          ) : null}

          <label>
            Inicio: {formatTime(startTime)}
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={startTime}
              disabled={!duration}
              onChange={(event) => handleStartChange(Number(event.target.value))}
            />
          </label>

          <label>
            Fin: {formatTime(endTime)}
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={endTime}
              disabled={!duration}
              onChange={(event) => handleEndChange(Number(event.target.value))}
            />
          </label>
        </div>
        ) : null}

        <button type="button" onClick={handleSave} disabled={uploading || (!hasVideo && !screenshotBlob)}>
          {uploading ? "Enviando..." : "Guardar reporte de bug"}
        </button>

        {success ? <p className="success">{success}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel meta">
        <h2>Pasos para llegar aquí (último minuto)</h2>
        <p>Pasos registrados: {session?.steps.length ?? 0}</p>
        <p>Logs de consola: {session?.logs.length ?? 0}</p>
        <p>Peticiones de red: {session?.networks?.length ?? 0}</p>
        <p>URL: {session?.tabUrl || "N/A"}</p>

        <details open>
          <summary>Ver pasos</summary>
          <ul>
            {(session?.steps ?? []).map((step, index) => (
              <li key={`${step.timestamp}-${index}`}>{step.description}</li>
            ))}
          </ul>
        </details>

        <details open>
          <summary>Ver logs de consola</summary>
          <ul>
            {(session?.logs ?? []).map((log, index) => (
              <li key={`${log.timestamp}-${index}`}>
                [{log.type}] {log.message}
              </li>
            ))}
          </ul>
        </details>

        <details open>
          <summary>Ver peticiones de red</summary>
          <ul>
            {(session?.networks ?? []).map((entry, index) => (
              <li key={`${entry.timestamp}-${index}`}>{formatNetworkEntry(entry)}</li>
            ))}
          </ul>
        </details>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReviewPage />
  </StrictMode>,
);
