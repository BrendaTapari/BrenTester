import type { RegionRect } from "../shared/types";

const OVERLAY_ID = "brentester-region-overlay";

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export function removeRegionOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

export function pickRegion(): Promise<RegionRect> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(OVERLAY_ID)) {
      reject(new Error("Ya hay una selección de región en curso."));
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      background: "rgba(15, 23, 42, 0.45)",
      userSelect: "none",
    });

    const hint = document.createElement("div");
    hint.textContent = "Arrastrá para seleccionar el sector. ESC para cancelar.";
    Object.assign(hint.style, {
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 14px",
      borderRadius: "8px",
      background: "rgba(15, 23, 42, 0.92)",
      color: "#e2e8f0",
      font: "600 14px/1.4 system-ui, sans-serif",
      pointerEvents: "none",
    });

    const selection = document.createElement("div");
    Object.assign(selection.style, {
      position: "fixed",
      border: "2px solid #38bdf8",
      background: "rgba(56, 189, 248, 0.15)",
      display: "none",
      pointerEvents: "none",
      boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.35)",
    });

    overlay.append(hint, selection);
    document.documentElement.append(overlay);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const cleanup = () => {
      removeRegionOverlay();
      window.removeEventListener("keydown", onKeyDown, true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cleanup();
        reject(new Error("Selección de región cancelada."));
      }
    };

    const updateSelection = (x: number, y: number) => {
      const left = Math.min(startX, x);
      const top = Math.min(startY, y);
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);

      Object.assign(selection.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        display: width > 2 && height > 2 ? "block" : "none",
      });
    };

    overlay.addEventListener("mousedown", (event) => {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      updateSelection(startX, startY);
    });

    overlay.addEventListener("mousemove", (event) => {
      if (!dragging) {
        return;
      }
      updateSelection(event.clientX, event.clientY);
    });

    overlay.addEventListener("mouseup", (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;

      const region: RegionRect = {
        x: Math.min(startX, event.clientX),
        y: Math.min(startY, event.clientY),
        width: Math.abs(event.clientX - startX),
        height: Math.abs(event.clientY - startY),
      };

      if (region.width < 10 || region.height < 10) {
        cleanup();
        reject(new Error("La región seleccionada es demasiado pequeña."));
        return;
      }

      overlay.style.display = "none";
      window.removeEventListener("keydown", onKeyDown, true);

      void waitForPaint().then(() => resolve(region));
    });

    window.addEventListener("keydown", onKeyDown, true);
  });
}

export async function cropScreenshot(dataUrl: string, region: RegionRect): Promise<Blob> {
  const image = await loadImage(dataUrl);
  const dpr = window.devicePixelRatio || 1;

  const sx = Math.round(region.x * dpr);
  const sy = Math.round(region.y * dpr);
  const sw = Math.round(region.width * dpr);
  const sh = Math.round(region.height * dpr);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("No se pudo crear el canvas para recortar la captura.");
  }

  context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("No se pudo generar la captura recortada."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("No se pudo cargar la captura de pantalla."));
    image.src = dataUrl;
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}
