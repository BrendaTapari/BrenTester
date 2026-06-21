from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
BUG_REPORTS_DIR = BASE_DIR / "bug_reports"

app = FastAPI(
    title="BrenTester API",
    description="Backend de BrenTester: recibe reportes de bugs, recorta video y guarda metadatos.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ensure_bug_reports_dir() -> Path:
    BUG_REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    return BUG_REPORTS_DIR


def sanitize_bug_folder_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r'[<>:"/\\|?*]', "", cleaned)
    cleaned = re.sub(r"\s+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)
    return cleaned.strip("._")[:80]


def create_bug_folder(bug_name: str | None = None) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = sanitize_bug_folder_name(bug_name or "")
    folder_name = f"{slug}_{timestamp}" if slug else f"bug_{timestamp}"
    folder = ensure_bug_reports_dir() / folder_name
    folder.mkdir(parents=True, exist_ok=False)
    return folder


def parse_steps(steps_raw: str) -> tuple[list[Any], str]:
    try:
        parsed = json.loads(steps_raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"El campo 'steps' no contiene JSON válido: {exc.msg}",
        ) from exc

    if not isinstance(parsed, list):
        raise HTTPException(
            status_code=400,
            detail="El campo 'steps' debe ser una lista JSON.",
        )

    return parsed, json.dumps(parsed, indent=2, ensure_ascii=False)


def save_steps(bug_folder: Path, steps: list[Any], formatted_json: str) -> None:
    steps_json_path = bug_folder / "steps.json"
    steps_json_path.write_text(formatted_json, encoding="utf-8")

    lines: list[str] = []
    for index, step in enumerate(steps, start=1):
        if isinstance(step, dict):
            description = step.get("description")
            if description:
                lines.append(f"{index}. {description}")
                continue
            action = step.get("action", step.get("type", "acción"))
            details = ", ".join(
                f"{key}={value}"
                for key, value in step.items()
                if key not in {"action", "type"}
            )
            lines.append(f"{index}. [{action}] {details}".strip())
        else:
            lines.append(f"{index}. {step}")

    (bug_folder / "steps.txt").write_text("\n".join(lines), encoding="utf-8")


def save_console_logs(bug_folder: Path, console_logs: str) -> None:
    content = console_logs.strip()
    try:
        parsed = json.loads(content)
        if isinstance(parsed, (list, dict)):
            content = json.dumps(parsed, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        pass

    (bug_folder / "logs.txt").write_text(content + "\n", encoding="utf-8")


def save_network_logs(bug_folder: Path, network_logs: str) -> None:
    content = network_logs.strip() or "[]"
    try:
        parsed = json.loads(content)
        if isinstance(parsed, list):
            lines: list[str] = []
            for index, entry in enumerate(parsed, start=1):
                if isinstance(entry, dict):
                    method = entry.get("method", "?")
                    status = entry.get("status", entry.get("error", "?"))
                    url = entry.get("url", "")
                    duration = entry.get("durationMs")
                    duration_text = f" ({duration}ms)" if duration is not None else ""
                    lines.append(f"{index}. [{method}] {status} {url}{duration_text}")
                else:
                    lines.append(f"{index}. {entry}")
            content = "\n".join(lines)
        elif isinstance(parsed, dict):
            content = json.dumps(parsed, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        pass

    (bug_folder / "networks.txt").write_text(content + "\n", encoding="utf-8")


def validate_trim_times(start_time: float | None, end_time: float | None) -> None:
    if start_time is None and end_time is None:
        return

    if start_time is None or end_time is None:
        raise HTTPException(
            status_code=400,
            detail="Debes enviar 'start_time' y 'end_time' juntos, o ninguno.",
        )

    if start_time < 0 or end_time < 0:
        raise HTTPException(
            status_code=400,
            detail="Los tiempos de recorte no pueden ser negativos.",
        )

    if start_time >= end_time:
        raise HTTPException(
            status_code=400,
            detail="'start_time' debe ser menor que 'end_time'.",
        )


def run_ffmpeg(command: list[str]) -> None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail="FFmpeg no está instalado o no está disponible en el PATH.",
        ) from exc

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        logger.error("FFmpeg falló: %s", stderr)
        raise HTTPException(
            status_code=500,
            detail=f"Error al procesar el video con FFmpeg: {stderr or 'error desconocido'}",
        )


def build_ffmpeg_commands(
    input_path: Path,
    output_path: Path,
    start_time: float | None,
    end_time: float | None,
) -> list[list[str]]:
    trim_args: list[str] = []
    if start_time is not None and end_time is not None:
        trim_args = ["-ss", str(start_time), "-to", str(end_time)]

    suffix = input_path.suffix.lower()
    commands: list[list[str]] = []

    if suffix == ".mp4":
        commands.append(
            [
                "ffmpeg",
                "-y",
                *trim_args,
                "-i",
                str(input_path),
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                str(output_path),
            ]
        )

    commands.append(
        [
            "ffmpeg",
            "-y",
            *trim_args,
            "-i",
            str(input_path),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )

    return commands


def process_video(
    input_path: Path,
    output_path: Path,
    start_time: float | None,
    end_time: float | None,
) -> None:
    last_error: HTTPException | None = None

    for command in build_ffmpeg_commands(input_path, output_path, start_time, end_time):
        try:
            run_ffmpeg(command)
            if output_path.exists() and output_path.stat().st_size > 0:
                return
        except HTTPException as exc:
            last_error = exc
            if output_path.exists():
                output_path.unlink(missing_ok=True)

    if last_error is not None:
        raise last_error

    raise HTTPException(
        status_code=500,
        detail="No se pudo generar el archivo de video de salida.",
    )


def resolve_upload_extension(filename: str | None, content_type: str | None) -> str:
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix in {".webm", ".mp4", ".mkv", ".mov"}:
            return suffix

    if content_type:
        mapping = {
            "video/webm": ".webm",
            "video/mp4": ".mp4",
            "video/x-matroska": ".mkv",
            "video/quicktime": ".mov",
        }
        if content_type in mapping:
            return mapping[content_type]

    return ".webm"


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


def save_screenshot(bug_folder: Path, screenshot: UploadFile) -> None:
    screenshot_path = bug_folder / "screenshot.png"
    with screenshot_path.open("wb") as buffer:
        shutil.copyfileobj(screenshot.file, buffer)


@app.post("/api/upload-bug")
async def upload_bug(
    steps: str = Form(..., description="Lista JSON con las acciones del usuario"),
    console_logs: str = Form(..., description="Logs de consola"),
    network_logs: str = Form("[]", description="Peticiones HTTP capturadas"),
    video: UploadFile | None = File(None, description="Video original capturado por la extensión"),
    screenshot: UploadFile | None = File(None, description="Captura de pantalla"),
    start_time: float | None = Form(None, description="Segundo de inicio del recorte"),
    end_time: float | None = Form(None, description="Segundo de fin del recorte"),
    bug_name: str | None = Form(None, description="Nombre descriptivo del bug para la carpeta"),
) -> dict[str, Any]:
    has_video = video is not None and bool(video.filename or video.content_type)
    has_screenshot = (
        screenshot is not None
        and screenshot.content_type
        and screenshot.content_type.startswith("image/")
    )

    if not has_video and not has_screenshot:
        raise HTTPException(
            status_code=400,
            detail="Debes enviar al menos un video o una captura de pantalla.",
        )

    validate_trim_times(start_time, end_time)
    steps_data, steps_formatted = parse_steps(steps)

    bug_folder = create_bug_folder(bug_name)
    saved_screenshot: str | None = None
    saved_video: str | None = None
    trimmed = False

    try:
        save_steps(bug_folder, steps_data, steps_formatted)
        save_console_logs(bug_folder, console_logs)
        save_network_logs(bug_folder, network_logs)

        if has_screenshot and screenshot is not None:
            save_screenshot(bug_folder, screenshot)
            saved_screenshot = "screenshot.png"

        if has_video and video is not None:
            extension = resolve_upload_extension(video.filename, video.content_type)
            temp_video_path = bug_folder / f"original{extension}"
            final_video_path = bug_folder / "video.mp4"

            with temp_video_path.open("wb") as buffer:
                shutil.copyfileobj(video.file, buffer)

            if temp_video_path.stat().st_size == 0:
                raise HTTPException(status_code=400, detail="El archivo de video está vacío.")

            process_video(temp_video_path, final_video_path, start_time, end_time)
            temp_video_path.unlink(missing_ok=True)
            saved_video = "video.mp4"
            trimmed = start_time is not None and end_time is not None

    except HTTPException:
        if bug_folder.exists():
            shutil.rmtree(bug_folder, ignore_errors=True)
        raise
    except Exception as exc:
        logger.exception("Error inesperado procesando bug report")
        if bug_folder.exists():
            shutil.rmtree(bug_folder, ignore_errors=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error inesperado al procesar el reporte: {exc}",
        ) from exc
    finally:
        if video is not None:
            await video.close()
        if screenshot is not None:
            await screenshot.close()

    response: dict[str, Any] = {
        "message": "Bug report guardado correctamente.",
        "folder": str(bug_folder.relative_to(BASE_DIR)).replace("\\", "/"),
        "trimmed": trimmed,
    }
    if saved_video:
        response["video"] = saved_video
    if saved_screenshot:
        response["screenshot"] = saved_screenshot
    return response
