import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { uploadBugReport } from "../shared/api";
import { isValidBlob } from "../shared/blob-utils";
import { BUFFER_WINDOW_MS } from "../shared/constants";
import { loadRecordingSession } from "../shared/db";
import type { LogEntry, NetworkEntry, RecordingSession, Step } from "../shared/types";
import "./review.css";
import { Pencil, Type, Copy, Undo, Check, X } from "lucide-react";

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

  // — Anotaciones —
  const [annotationMode, setAnnotationMode] = useState(false);
  const [drawColor, setDrawColor] = useState("#000000");
  const [toolMode, setToolMode] = useState<"pen" | "text" | "rect">("pen");
  const [isDrawing, setIsDrawing] = useState(false);
  const [textPos, setTextPos] = useState<{ x: number; y: number } | null>(null);
  const [textInputValue, setTextInputValue] = useState("");
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const historyRef = useRef<ImageData[]>([]);

  // — Zoom —
  const ZOOM_MIN  = 0.25;
  const ZOOM_MAX  = 3.0;
  const ZOOM_STEP = 0.25;
  const [zoom, setZoom] = useState(1.0);
  // Dimensiones lógicas del canvas (píxeles del canvas attribute), guardadas al inicializar
  const [canvasNaturalSize, setCanvasNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const zoomIn  = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX,  parseFloat((z + ZOOM_STEP).toFixed(2)))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(ZOOM_MIN, parseFloat((z - ZOOM_STEP).toFixed(2)))), []);

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

  // ── Annotation helpers ──────────────────────────────────────────────
  const PEN_WIDTH = 4;
  const TEXT_FONT = "bold 18px sans-serif";
  const canvasScrollRef = useRef<HTMLDivElement>(null);

  const getCanvasCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = annotationCanvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * canvas.width,
        y: ((e.clientY - rect.top) / rect.height) * canvas.height,
      };
    },
    [],
  );

  const saveHistory = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.length > 40) historyRef.current.shift();
  }, []);

  const undoAnnotation = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || historyRef.current.length === 0) return;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(historyRef.current.pop()!, 0, 0);
    setTextPos(null);
  }, []);

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (toolMode === "text") return;

      saveHistory();
      const pos = getCanvasCoords(e);
      setIsDrawing(true);

      if (toolMode === "rect") {
        rectStartRef.current = pos;
        return;
      }

      // pen
      lastPointRef.current = pos;
      const ctx = annotationCanvasRef.current!.getContext("2d")!;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, PEN_WIDTH / 2, 0, Math.PI * 2);
      ctx.fillStyle = drawColor;
      ctx.fill();
    },
    [toolMode, drawColor, saveHistory, getCanvasCoords],
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing || toolMode === "text") return;

      const pos = getCanvasCoords(e);

      if (toolMode === "rect") {
        if (!rectStartRef.current) return;
        const preview = previewCanvasRef.current;
        if (!preview) return;
        const pctx = preview.getContext("2d")!;
        pctx.clearRect(0, 0, preview.width, preview.height);
        const x = Math.min(rectStartRef.current.x, pos.x);
        const y = Math.min(rectStartRef.current.y, pos.y);
        const w = Math.abs(pos.x - rectStartRef.current.x);
        const h = Math.abs(pos.y - rectStartRef.current.y);
        pctx.strokeStyle = drawColor;
        pctx.lineWidth = PEN_WIDTH;
        pctx.strokeRect(x, y, w, h);
        return;
      }

      // pen
      if (!lastPointRef.current) return;
      const ctx = annotationCanvasRef.current!.getContext("2d")!;
      ctx.beginPath();
      ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = PEN_WIDTH;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      lastPointRef.current = pos;
    },
    [isDrawing, toolMode, drawColor, getCanvasCoords],
  );

  const handleCanvasMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (toolMode === "rect" && isDrawing && rectStartRef.current) {
        const pos = getCanvasCoords(e);
        const canvas = annotationCanvasRef.current!;
        const ctx = canvas.getContext("2d")!;
        const x = Math.min(rectStartRef.current.x, pos.x);
        const y = Math.min(rectStartRef.current.y, pos.y);
        const w = Math.abs(pos.x - rectStartRef.current.x);
        const h = Math.abs(pos.y - rectStartRef.current.y);
        // Only draw if the rect has some size
        if (w > 1 || h > 1) {
          ctx.strokeStyle = drawColor;
          ctx.lineWidth = PEN_WIDTH;
          ctx.strokeRect(x, y, w, h);
        } else {
          // tiny click in rect mode — undo the history snapshot
          if (historyRef.current.length > 0) {
            ctx.putImageData(historyRef.current.pop()!, 0, 0);
          }
        }
        const preview = previewCanvasRef.current;
        if (preview) preview.getContext("2d")!.clearRect(0, 0, preview.width, preview.height);
        rectStartRef.current = null;
      }
      setIsDrawing(false);
      lastPointRef.current = null;
    },
    [toolMode, isDrawing, drawColor, getCanvasCoords],
  );

  /** Mouse-leave: abort any in-progress rect without committing it. */
  const abortDrawing = useCallback(() => {
    if (toolMode === "rect" && isDrawing) {
      const preview = previewCanvasRef.current;
      if (preview) preview.getContext("2d")!.clearRect(0, 0, preview.width, preview.height);
      // undo the saveHistory called on mousedown
      const canvas = annotationCanvasRef.current;
      if (canvas && historyRef.current.length > 0) {
        canvas.getContext("2d")!.putImageData(historyRef.current.pop()!, 0, 0);
      }
      rectStartRef.current = null;
    }
    setIsDrawing(false);
    lastPointRef.current = null;
  }, [toolMode, isDrawing]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (toolMode !== "text") return; // rect uses mouseup; pen has no click action
      const pos = getCanvasCoords(e);
      setTextPos(pos);
      setTextInputValue("");
    },
    [toolMode, getCanvasCoords],
  );

  const confirmText = useCallback(() => {
    if (!textPos || !textInputValue.trim()) {
      setTextPos(null);
      setTextInputValue("");
      return;
    }
    saveHistory();
    const ctx = annotationCanvasRef.current!.getContext("2d")!;
    ctx.font = TEXT_FONT;
    ctx.fillStyle = drawColor;
    ctx.fillText(textInputValue, textPos.x, textPos.y);
    setTextPos(null);
    setTextInputValue("");
  }, [textPos, textInputValue, drawColor, saveHistory]);

  const confirmAnnotation = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const preview = previewCanvasRef.current;
    if (preview) preview.getContext("2d")!.clearRect(0, 0, preview.width, preview.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
      setScreenshotBlob(blob);
      setScreenshotUrl(URL.createObjectURL(blob));
      setAnnotationMode(false);
      setCanvasNaturalSize(null);
      setZoom(1.0);
      historyRef.current = [];
      rectStartRef.current = null;
    }, "image/png");
  }, [screenshotUrl]);

  const cancelAnnotation = useCallback(() => {
    const preview = previewCanvasRef.current;
    if (preview) preview.getContext("2d")!.clearRect(0, 0, preview.width, preview.height);
    rectStartRef.current = null;
    setAnnotationMode(false);
    setTextPos(null);
    setTextInputValue("");
    setCanvasNaturalSize(null);
    setZoom(1.0);
    historyRef.current = [];
  }, []);

  const [copyImageStatus, setCopyImageStatus] = useState<"idle" | "ok" | "err">("idle");

  const copyImage = useCallback(async () => {
    let blobToCopy: Blob | null = null;

    if (annotationMode && annotationCanvasRef.current) {
      blobToCopy = await new Promise<Blob | null>((resolve) =>
        annotationCanvasRef.current!.toBlob((b) => resolve(b), "image/png"),
      );
    } else {
      blobToCopy = screenshotBlob;
    }

    if (!blobToCopy) return;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blobToCopy }),
      ]);
      setCopyImageStatus("ok");
      window.setTimeout(() => setCopyImageStatus("idle"), 2000);
    } catch {
      setCopyImageStatus("err");
      window.setTimeout(() => setCopyImageStatus("idle"), 2500);
    }
  }, [annotationMode, screenshotBlob]);

  // Initialize canvas when entering annotation mode
  useEffect(() => {
    if (!annotationMode || !screenshotUrl) return;
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;

    const img = new Image();
    img.onload = () => {
      // El blob ya tiene el banner de URL integrado (addUrlBannerToImage o stitchBrowserFrame)
      // → el canvas replica el blob exactamente, sin superponer un segundo banner.
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;

      // Sync preview canvas size
      const preview = previewCanvasRef.current;
      if (preview) {
        preview.width  = canvas.width;
        preview.height = canvas.height;
      }

      // Zoom inicial tipo "object-fit: contain": entra completa sin scroll inicial.
      // containerH: clientHeight puede ser 0 antes del primer paint → fallback a 60 % del vh.
      const scrollEl   = canvasScrollRef.current;
      const containerW = scrollEl && scrollEl.clientWidth  > 0 ? scrollEl.clientWidth  - 16 : canvas.width;
      const containerH = scrollEl && scrollEl.clientHeight > 0 ? scrollEl.clientHeight - 16 : window.innerHeight * 0.60;
      const zoomByW    = containerW / canvas.width;
      const zoomByH    = containerH / canvas.height;
      const fitZoom    = parseFloat(Math.min(1.0, zoomByW, zoomByH).toFixed(2));
      setCanvasNaturalSize({ w: canvas.width, h: canvas.height });
      setZoom(fitZoom);

      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      historyRef.current = [];
    };
    img.src = screenshotUrl;
  }, [annotationMode, screenshotUrl]);

  // ── End annotation helpers ──────────────────────────────────────────

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
    <main className={`review-page${annotationMode ? " review-page--annotating" : ""}`}>
      <header>
        <h1>BrenTester — Revisar reporte</h1>
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
            <div className="screenshot-block-header">
              <h2>Captura de pantalla</h2>
              <div className="screenshot-header-actions">
                {!annotationMode && (
                  <button type="button" className="btn-annotate" onClick={() => setAnnotationMode(true)}>
                    <Pencil /> Anotar
                  </button>
                )}
                <button
                  type="button"
                  className={`btn-copy-image${copyImageStatus === "ok" ? " copied" : copyImageStatus === "err" ? " copy-err" : ""}`}
                  onClick={() => void copyImage()}
                >
                  {copyImageStatus === "ok" ? "✔ Copiada" : copyImageStatus === "err" ? "✕ Error" : (<>
                    <Copy /> {" "}Copiar
                  
                  </>)}
                </button>
              </div>
            </div>

            {annotationMode ? (
              <div className="annotation-wrap">
                <div className="annotation-toolbar">
                  <span className="annotation-toolbar-label">Herramienta:</span>
                  <button
                    type="button"
                    className={`annotation-tool-btn${toolMode === "pen" ? " active" : ""}`}
                    onClick={() => { setToolMode("pen"); setTextPos(null); }}
                  >
                    <Pencil /> {" "}Fibrón
                  </button>
                  <button
                    type="button"
                    className={`annotation-tool-btn${toolMode === "text" ? " active" : ""}`}
                    onClick={() => { setToolMode("text"); setIsDrawing(false); }}
                  >
                    <Type/> {" "}Texto
                  </button>
                  <button
                    type="button"
                    className={`annotation-tool-btn${toolMode === "rect" ? " active" : ""}`}
                    onClick={() => { setToolMode("rect"); setIsDrawing(false); setTextPos(null); }}
                    title="Rectángulo"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ verticalAlign: "middle" }}>
                      <rect x="1.5" y="3.5" width="13" height="9" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
                    </svg>
                    {" "}Rect
                  </button>
                  <span className="annotation-toolbar-label">Color:</span>
                  <button
                    type="button"
                    className={`annotation-color-btn${drawColor === "#000000" ? " active" : ""}`}
                    style={{ background: "#000000" }}
                    onClick={() => setDrawColor("#000000")}
                    title="Negro"
                  />
                  <button
                    type="button"
                    className={`annotation-color-btn${drawColor === "#e11d48" ? " active" : ""}`}
                    style={{ background: "#e11d48" }}
                    onClick={() => setDrawColor("#e11d48")}
                    title="Rojo"
                  />
                  <button type="button" className="annotation-action-btn" onClick={undoAnnotation} title="Deshacer último trazo">
                    <Undo /> {" "}Deshacer
                  </button>

                  {/* Controles de zoom */}
                  <div className="annotation-zoom-group">
                    <button
                      type="button"
                      className="annotation-zoom-btn"
                      onClick={zoomOut}
                      disabled={zoom <= ZOOM_MIN}
                      title={`Alejar (mín ${ZOOM_MIN * 100}%)`}
                    >−</button>
                    <span className="annotation-zoom-label">{Math.round(zoom * 100)}%</span>
                    <button
                      type="button"
                      className="annotation-zoom-btn"
                      onClick={zoomIn}
                      disabled={zoom >= ZOOM_MAX}
                      title={`Acercar (máx ${ZOOM_MAX * 100}%)`}
                    >+</button>
                  </div>

                  <div className="annotation-toolbar-spacer" />
                  <button type="button" className="annotation-action-btn confirm" onClick={confirmAnnotation}>
                    <Check /> {" "}Confirmar
                  </button>
                  <button type="button" className="annotation-action-btn cancel" onClick={cancelAnnotation}>
                    <X /> {" "}Cancelar
                  </button>
                </div>

                <div className="annotation-canvas-scroll" ref={canvasScrollRef}>
                <div className="annotation-canvas-wrap">
                  {/*
                    CSS width/height = canvasNaturalSize * zoom.
                    El canvas attribute (width/height) siempre es la resolución lógica completa.
                    getBoundingClientRect() devolverá el tamaño CSS → getCanvasCoords corrige
                    automáticamente las coordenadas del mouse sin ningún cambio extra.
                  */}
                  <canvas
                    ref={annotationCanvasRef}
                    className={`annotation-canvas annotation-cursor-${toolMode}`}
                    style={canvasNaturalSize ? {
                      width:  `${Math.round(canvasNaturalSize.w * zoom)}px`,
                      height: `${Math.round(canvasNaturalSize.h * zoom)}px`,
                    } : undefined}
                    onMouseDown={handleCanvasMouseDown}
                    onMouseMove={handleCanvasMouseMove}
                    onMouseUp={handleCanvasMouseUp}
                    onMouseLeave={abortDrawing}
                    onClick={handleCanvasClick}
                  />
                  {/* Preview canvas: mismas dimensiones visuales, pointer-events: none */}
                  <canvas
                    ref={previewCanvasRef}
                    className="annotation-canvas annotation-canvas-preview"
                    style={canvasNaturalSize ? {
                      width:  `${Math.round(canvasNaturalSize.w * zoom)}px`,
                      height: `${Math.round(canvasNaturalSize.h * zoom)}px`,
                    } : undefined}
                    aria-hidden="true"
                  />
                  {textPos && (
                    <div
                      className="annotation-text-input-wrap"
                      style={{
                        left: `${(textPos.x / (annotationCanvasRef.current?.width ?? 1)) * 100}%`,
                        top: `${(textPos.y / (annotationCanvasRef.current?.height ?? 1)) * 100}%`,
                      }}
                    >
                      <input
                        autoFocus
                        type="text"
                        className="annotation-text-input"
                        value={textInputValue}
                        onChange={(e) => setTextInputValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") confirmText();
                          if (e.key === "Escape") { setTextPos(null); setTextInputValue(""); }
                        }}
                        placeholder="Escribí y presioná Enter"
                      />
                    </div>
                  )}
                </div>
                </div> {/* annotation-canvas-scroll */}
              </div>
            ) : (
              <div className="screenshot-scroll">
                <img className="screenshot" src={screenshotUrl} alt="Captura del bug" />
              </div>
            )}
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
              <button type="button" className="preset" onClick={() => applyLastSeconds(60)}>
                Último minuto
              </button>
              <button type="button" className="preset" onClick={() => applyLastSeconds(BUFFER_WINDOW_MS / 1000)}>
                Últimos 2 min
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
