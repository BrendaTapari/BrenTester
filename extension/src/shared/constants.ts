/** Ventana deslizante: video, pasos y logs de los últimos dos minutos (modo sesión). */
export const BUFFER_WINDOW_MS = 120_000;

/** Intervalo entre trozos de video (ms). Más alto = menos CPU. */
export const BUFFER_CHUNK_MS = 2_000;

/** Tope de trozos en memoria (red de seguridad). */
export const BUFFER_MAX_CHUNKS = 35;

/** Bitrate del buffer circular (modo sesión). */
export const BUFFER_VIDEO_BITRATE = 750_000;

/** Bitrate de grabación manual completa. */
export const MANUAL_VIDEO_BITRATE = 1_500_000;

/** Máximo de eventos de red guardados en memoria. */
export const MAX_NETWORK_ENTRIES = 80;

/** Mínimo de pasos que siempre se conservan, aunque sean más viejos que la ventana. */
export const BUFFER_MIN_STEPS = 15;

export type RecordingMode = "buffer" | "manual";
