import { StrictMode, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { uploadBugReport } from "../shared/api";
import { isValidBlob } from "../shared/blob-utils";
import { loadRecordingSession } from "../shared/db";
import type { LogEntry, NetworkEntry, RecordingSession, Step } from "../shared/types";
import "./review.css";

type EditedStep = Step & { editId: string };

function createEditId(): string {
  return crypto.randomUUID();
}

function toEditedStep(step: Step): EditedStep {
  return { ...step, editId: createEditId() };
}


const ENTORNO_TEST = import.meta.env.VITE_ENTORNO_TEST;
const ENTORNO_UAT = import.meta.env.VITE_ENTORNO_UAT;
const ENTORNO_PRODUCCION = import.meta.env.VITE_ENTORNO_PRODUCCION;
const ENTORNO_TODOS = import.meta.env.VITE_ENTORNO_TODOS;
const PERFIL_INTERNO = import.meta.env.VITE_PERFIL_INTERNO;
const PERFIL_EXTERNO = import.meta.env.VITE_PERFIL_EXTERNO;
const ROL_TODOS = import.meta.env.VITE_ROL_TODOS;
const CUIT_USUARIO_INTERNO = import.meta.env.VITE_CUIT_USUARIO_INTERNO;
const CONTRASENA_USUARIO_INTERNO = import.meta.env.VITE_CONTRASENA_USUARIO_INTERNO;
const CUIT_USUARIO_EXTERNO = import.meta.env.VITE_CUIT_USUARIO_EXTERNO;
const CONTRASENA_USUARIO_EXTERNO = import.meta.env.VITE_CONTRASENA_USUARIO_EXTERNO;

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

function buildTicketText(options: {
  entornos: string[];
  perfil: string;
  rol: string;
  cuit: string;
  contrasena: string;
  steps: Step[];
  resultadoObtenido: string;
  resultadoEsperado: string;
}): string {
  const pasos =
    options.steps.length > 0
      ? options.steps.map((step, index) => `${index + 1}. ${step.description}`).join("\n")
      : "Sin pasos registrados.";

  const entornoLabel =
    options.entornos.length === 0
      ? "sin especificar"
      : options.entornos.map((e) => e.toLowerCase()).join(", ");

  return [
    `Entorno: ${entornoLabel}`,
    `Perfil: ${options.perfil}`,
    `Rol: ${options.rol}`,
    "Usuario:",
    `• ${options.cuit}`,
    `• ${options.contrasena}`,
    "",
    "Pasos:",
    pasos,
    "",
    `Resultado obtenido: ${options.resultadoObtenido.trim()}`,
    "",
    `Resultado esperado: ${options.resultadoEsperado.trim()}`,
  ].join("\n");
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
  const [nombreBug, setNombreBug] = useState("");
  const [formatearTicket, setFormatearTicket] = useState(false);
  const [entornos, setEntornosState] = useState<string[]>([ENTORNO_TEST]);
  const [perfil, setPerfilState] = useState(PERFIL_INTERNO);
  const [rol, setRolState] = useState(ROL_TODOS);
  const [cuit, setCuitState] = useState(CUIT_USUARIO_INTERNO);
  const [contrasena, setContrasenaState] = useState(CONTRASENA_USUARIO_INTERNO);
  const [resultadoObtenido, setResultadoObtenido] = useState("");
  const [resultadoEsperado, setResultadoEsperado] = useState("");
  const [ticketTexto, setTicketTexto] = useState<string | null>(null);
  const [ticketCopiado, setTicketCopiado] = useState(false);
  const [editedSteps, setEditedSteps] = useState<EditedStep[]>([]);
  const [draggedStepIndex, setDraggedStepIndex] = useState<number | null>(null);
  const [dragOverStepIndex, setDragOverStepIndex] = useState<number | null>(null);

  function createManualStep(description = ""): EditedStep {
    return {
      action: "manual",
      description,
      selector: "",
      tag: "",
      text: "",
      timestamp: Date.now(),
      url: session?.tabUrl ?? window.location.href,
      editId: createEditId(),
    };
  }
  function updateStepDescription(index: number, description: string) {
    setEditedSteps((previous) =>
      previous.map((step, stepIndex) =>
        stepIndex === index ? { ...step, description } : step,
      ),
    );
  }
  function removeStep(index: number) {
    setEditedSteps((previous) => previous.filter((_, stepIndex) => stepIndex !== index));
  }
  function addStep() {
    setEditedSteps((previous) => [...previous, createManualStep()]);
  }
  function insertStepAfter(index: number) {
    setEditedSteps((previous) => [
      ...previous.slice(0, index + 1),
      createManualStep(),
      ...previous.slice(index + 1),
    ]);
  }
  function moveStep(fromIndex: number, toIndex: number) {
    setEditedSteps((previous) => {
      if (
        fromIndex < 0 ||
        fromIndex >= previous.length ||
        toIndex < 0 ||
        toIndex >= previous.length ||
        fromIndex === toIndex
      ) {
        return previous;
      }
      const next = [...previous];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }
  function handleStepDragStart(index: number, event: DragEvent<HTMLButtonElement>) {
    setDraggedStepIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }
  function handleStepDragEnd() {
    setDraggedStepIndex(null);
    setDragOverStepIndex(null);
  }
  function handleStepDragOver(index: number, event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverStepIndex !== index) {
      setDragOverStepIndex(index);
    }
  }
  function handleStepDrop(index: number, event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (draggedStepIndex !== null) {
      moveStep(draggedStepIndex, index);
    }
    setDraggedStepIndex(null);
    setDragOverStepIndex(null);
  }
  function keepLastSteps(count: number) {
    setEditedSteps((previous) => previous.slice(-count));
  }

  function toggleEntorno(value: string) {
    setEntornosState((prev) =>
      prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value],
    );
  }
  function setPerfil(perfil: string) {
    setPerfilState(perfil);
    if (perfil === PERFIL_INTERNO) {
      setCuitState(CUIT_USUARIO_INTERNO);
      setContrasenaState(CONTRASENA_USUARIO_INTERNO);
    } else {
      setCuitState(CUIT_USUARIO_EXTERNO);
      setContrasenaState(CONTRASENA_USUARIO_EXTERNO);
    }
  }
  function setRol(rol: string) {
    setRolState(rol);
  }
  function setCuit(cuit: string) {
    setCuitState(cuit);
  }
  function setContrasena(contrasena: string) {
    setContrasenaState(contrasena);
  }
  function formatTicket() {
    setFormatearTicket(!formatearTicket);
    if (formatearTicket) {
      setTicketTexto(null);
    }
  }
  function aceptarTicket() {
    setTicketTexto(
      buildTicketText({
        entornos,
        perfil,
        rol,
        cuit,
        contrasena,
        steps: editedSteps,
        resultadoObtenido,
        resultadoEsperado,
      }),
    );
  }
  function volverAEditarTicket() {
    setTicketTexto(null);
    setTicketCopiado(false);
  }
  async function copiarTicket() {
    if (!ticketTexto) {
      return;
    }

    try {
      await navigator.clipboard.writeText(ticketTexto);
      setTicketCopiado(true);
      window.setTimeout(() => setTicketCopiado(false), 2000);
      return;
    } catch {
      // Fallback si el portapapeles no está disponible.
    }

    const textarea = document.createElement("textarea");
    textarea.value = ticketTexto;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    setTicketCopiado(true);
    window.setTimeout(() => setTicketCopiado(false), 2000);
  }

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
        setEditedSteps(result.session.steps.map((step) => toEditedStep(step)));

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

    const bugName = nombreBug.trim();
    if (!bugName) {
      setError("Ingresá un nombre para el bug antes de guardar.");
      return;
    }

    setUploading(true);
    setError(null);
    setSuccess(null);

    try {
      const trim = getUploadTrim();
      const result = await uploadBugReport({
        videoBlob: hasVideo ? videoBlob : null,
        steps: editedSteps,
        logs: session.logs as LogEntry[],
        networks: (session.networks ?? []) as NetworkEntry[],
        screenshotBlob,
        startTime: trim.startTime,
        endTime: trim.endTime,
        bugName,
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
                onClick={() => applyLastSeconds(60)}
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

        <label>
          Nombre del bug:
          <input
            type="text"
            className="bug-name-input"
            value={nombreBug}
            onChange={(event) => setNombreBug(event.target.value)}
            placeholder="Ej: error al ordenar columnas"
            disabled={uploading}
          />
        </label>

        <button
          type="button"
          onClick={handleSave}
          disabled={uploading || (!hasVideo && !screenshotBlob) || !nombreBug.trim()}
        >
          {uploading ? "Enviando..." : "Guardar reporte de bug"}
        </button>

        {success ? <p className="success">{success}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel steps-panel">
        <h2>Editar pasos</h2>
        <p className="trim-hint">
          Arrastrá los pasos por el asa (⠿) para reordenarlos. También podés corregir, insertar (+) o borrar.
        </p>

        <div className="steps-editor">
          {editedSteps.length === 0 ? (
            <p className="trim-hint">No hay pasos. Agregá uno manualmente.</p>
          ) : (
            editedSteps.map((step, index) => (
              <div
                key={step.editId}
                className={[
                  "step-row",
                  draggedStepIndex === index ? "step-row-dragging" : "",
                  dragOverStepIndex === index && draggedStepIndex !== index
                    ? "step-row-drag-over"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragOver={(event) => handleStepDragOver(index, event)}
                onDrop={(event) => handleStepDrop(index, event)}
                onDragLeave={() => {
                  if (dragOverStepIndex === index) {
                    setDragOverStepIndex(null);
                  }
                }}
              >
                <button
                  type="button"
                  className="step-drag-handle"
                  draggable
                  onDragStart={(event) => handleStepDragStart(index, event)}
                  onDragEnd={handleStepDragEnd}
                  title="Arrastrar para reordenar"
                  aria-label="Arrastrar paso"
                >
                  ⠿
                </button>
                <span className="step-number">{index + 1}.</span>
                <input
                  type="text"
                  className="step-input"
                  value={step.description}
                  onChange={(event) => updateStepDescription(index, event.target.value)}
                  placeholder="Descripción del paso..."
                />
                <div className="step-row-actions">
                  <button
                    type="button"
                    className="step-insert"
                    onClick={() => insertStepAfter(index)}
                    title="Insertar paso debajo"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="step-delete"
                    onClick={() => removeStep(index)}
                    title="Borrar paso"
                  >
                    Borrar
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="steps-editor-actions">
          <button type="button" className="preset" onClick={addStep}>
            Agregar paso
          </button>
          {editedSteps.length > 5 ? (
            <button type="button" className="preset" onClick={() => keepLastSteps(5)}>
              Quedarme con los últimos 5
            </button>
          ) : null}
        </div>
      </section>

      <button type="button" className="btn-format-ticket" onClick={formatTicket}>Formatear ticket</button>
      {formatearTicket ? (
        <section className="panel ticket-panel">
          {ticketTexto ? (
            <div className="ticket-output">
              <h2>Ticket listo para copiar</h2>
              <textarea
                className="ticket-text"
                readOnly
                value={ticketTexto}
                onFocus={(event) => event.currentTarget.select()}
              />
              <div className="ticket-actions">
                <button type="button" onClick={() => void copiarTicket()}>
                  {ticketCopiado ? "¡Copiado!" : "Copiar ticket"}
                </button>
                <button type="button" className="ticket-secondary" onClick={volverAEditarTicket}>
                  Volver a editar
                </button>
              </div>
            </div>
          ) : (
            <div className="ticket-form">
              <h2>Formatear ticket</h2>
              <div>
                <p>Entorno:</p>
                <div className="entorno-checkboxes">
                  {[ENTORNO_TEST, ENTORNO_UAT, ENTORNO_PRODUCCION, ENTORNO_TODOS].map((opcion) => (
                    <label key={opcion} className="entorno-checkbox-label">
                      <input
                        type="checkbox"
                        checked={entornos.includes(opcion)}
                        onChange={() => toggleEntorno(opcion)}
                      />
                      {opcion}
                    </label>
                  ))}
                </div>
                <p>Perfil:</p>
                <select value={perfil} onChange={(event) => setPerfil(event.target.value)}>
                  <option value={PERFIL_INTERNO}>{PERFIL_INTERNO}</option>
                  <option value={PERFIL_EXTERNO}>{PERFIL_EXTERNO}</option>
                </select>
                <p>Rol:</p>
                <select value={rol} onChange={(event) => setRol(event.target.value)}>
                  <option value={ROL_TODOS}>{ROL_TODOS}</option>
                </select>
                <p>Usuario:</p>
                <p>• {cuit}</p>
                <p>• {contrasena}</p>
                <p>Pasos (editados):</p>
                <ol className="ticket-steps-preview">
                  {editedSteps.map((step, index) => (
                    <li key={`${step.timestamp}-${index}`}>{step.description || "(sin descripción)"}</li>
                  ))}
                </ol>
                <label>
                  Resultado obtenido:
                  <textarea
                    value={resultadoObtenido}
                    onChange={(event) => setResultadoObtenido(event.target.value)}
                    rows={3}
                    placeholder="Describí qué pasó al reproducir el bug..."
                  />
                </label>
                <label>
                  Resultado esperado:
                  <textarea
                    value={resultadoEsperado}
                    onChange={(event) => setResultadoEsperado(event.target.value)}
                    rows={3}
                    placeholder="Describí el comportamiento correcto..."
                  />
                </label>
                <button type="button" className="btn-aceptar" onClick={aceptarTicket}>Aceptar</button>
              </div>
            </div>
          )}
        </section>
      ) : null}
      <section className="panel meta">
        <h2>Detalles de la sesión</h2>
        <p>Pasos en el ticket: {editedSteps.length}</p>
        <p>Logs de consola: {session?.logs.length ?? 0}</p>
        <p>Peticiones de red: {session?.networks?.length ?? 0}</p>
        <p>URL: {session?.tabUrl || "N/A"}</p>

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
