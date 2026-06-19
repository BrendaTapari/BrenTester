# BrenTester

Herramienta de QA personalizada: extensión Chrome + backend FastAPI para capturar bugs con video, pasos y logs.

## Estructura

| Carpeta / archivo | Descripción |
|---|---|
| `main.py` | Backend FastAPI en `http://localhost:8000` |
| `extension/` | Extensión Chrome **BrenTester** (React + Manifest V3) |
| `bug_reports/` | Reportes guardados por el backend |
| `docker-compose.yml` | Levanta la API con FFmpeg |

## Inicio rápido

### Backend

```bash
# Opción 1: local (requiere FFmpeg)
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Opción 2: Docker
docker compose up --build
```

### Extensión

```bash
cd extension
npm install
npm run build
```

Carga `extension/dist` en `chrome://extensions` (modo desarrollador).

## Conexión extensión ↔ backend

- **Upload:** `POST http://localhost:8000/api/upload-bug`
- **Health:** `GET http://localhost:8000/health`
- **CORS:** habilitado para todos los orígenes (extensión inyectada en cualquier dominio)

## Branding

- **Nombre de la extensión:** BrenTester
- **Icono:** `extension/public/icons/brentester-icon.png`
