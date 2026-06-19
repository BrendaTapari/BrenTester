# BrenTester — Extensión Chrome

Extensión Manifest V3 con React para capturar video de pestaña, pasos de usuario, logs de consola y enviar reportes al backend **BrenTester** (`http://localhost:8000`).

## Requisitos

- Node.js 18+
- Backend BrenTester corriendo en `http://localhost:8000` (carpeta raíz del proyecto)
- Google Chrome

## Instalación

```bash
cd extension
npm install
npm run build
```

Modo desarrollo con recarga automática:

```bash
npm run dev
```

## Cargar en Chrome

1. Abre `chrome://extensions`
2. Activa **Modo de desarrollador**
3. Click en **Cargar descomprimida**
4. Selecciona la carpeta `BrenTester/extension/dist`

## Flujo de uso

1. Levanta el backend desde la raíz de BrenTester.
2. Abre la web que quieres testear y recarga la pestaña.
3. Click en **BrenTester** → **Iniciar grabación** (buffer circular de 1 minuto).
4. Testeá el flujo normalmente; solo se conserva el último minuto de video, pasos y logs.
5. Cuando veas un bug → **Capturar bug**:
   - Se cierra el popup.
   - Arrastrás un rectángulo sobre el sector a capturar.
   - Se guarda video del último minuto + pasos + logs + screenshot de esa región.
   - La grabación **sigue activa** para seguir testeando.
6. En la pantalla de revisión, enviá el reporte al backend.
7. Al **Detener grabación**, también se exporta el último minuto capturado.

## Icono

La extensión usa `public/icons/brentester-icon.png` en todos los tamaños del manifest (16, 48, 128).

## Estructura

```
BrenTester/
├── main.py                 # Backend FastAPI
├── docker-compose.yml
├── bug_reports/            # Reportes guardados
└── extension/
    ├── manifest.config.ts  # Nombre: BrenTester
    ├── public/icons/brentester-icon.png
    └── src/
        ├── background/
        ├── content/
        ├── offscreen/
        ├── popup/
        ├── review/
        └── shared/         # API → http://localhost:8000/api/upload-bug
```

## Notas

- Si la captura de pasos/logs no funciona, recarga la pestaña antes de grabar.
- Los videos se guardan temporalmente en IndexedDB (`brentester`) hasta enviarse al backend.
