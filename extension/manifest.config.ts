import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "BrenTester",
  version: "1.0.0",
  description:
    "Graba la pestaña activa, captura pasos y logs, y envía reportes de bug al backend BrenTester.",
  permissions: ["activeTab", "tabCapture", "storage", "scripting", "offscreen", "webRequest", "debugger"],
  host_permissions: ["http://localhost:8000/*", "http://*/*", "https://*/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "BrenTester",
    default_icon: {
      "16": "public/icons/brentester-icon.png",
      "48": "public/icons/brentester-icon.png",
      "128": "public/icons/brentester-icon.png",
    },
  },
  icons: {
    "16": "public/icons/brentester-icon.png",
    "48": "public/icons/brentester-icon.png",
    "128": "public/icons/brentester-icon.png",
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/index.ts"],
      run_at: "document_start",
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      resources: ["src/review/index.html"],
      matches: ["<all_urls>"],
    },
  ],
});
