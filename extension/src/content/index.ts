import type { LogEntry, Step } from "../shared/types";
import { MessageType } from "../shared/messages";
import { blobToBase64 } from "../shared/blob-utils";
import { cropScreenshot, pickRegion, removeRegionOverlay } from "./region-picker";

let isRecording = false;
let lastSavedStepDescription: string | null = null;

const MAX_CLICK_TEXT_LENGTH = 35;
const MAX_DROPDOWN_OPTION_LENGTH = 30;

const ICON_CLASS_PATTERN =
  /material-icons|material-symbols|material-symbols-outlined|fa-|fas\b|far\b|fab\b|icon-|icon\b|material/i;

const NAV_CONTEXT_PATTERN = /menu|sidebar|drawer|tabs|nav/i;

const ICON_GHOST_WORDS = [
  "workspaces",
  "settings",
  "home",
  "menu",
  "person",
  "dashboard",
];

const SILENT_WRAPPER_PATTERN =
  /mat-checkbox-inner-container|mat-select-placeholder|card-grid/i;

/** Traducciones forzadas para botones e íconos. Claves en minúsculas, sin espacios. */
const CUSTOM_DICTIONARY: Record<string, string> = {
  menu: "menú hamburguesa",
  btnmenu: "menú hamburguesa",
  "fa-bars": "menú hamburguesa",
  search: "buscar",
  edit: "editar",
  close: "cerrar",
};

const ICON_TEXT_MAP: Record<string, string> = {
  edit: "editar",
  delete: "eliminar",
  close: "cerrar",
  search: "buscar",
  add: "agregar",
  remove: "quitar",
  menu: "menú",
  more_vert: "más opciones",
  expand_more: "expandir",
  expand_less: "contraer",
  chevron_right: "siguiente",
  chevron_left: "anterior",
  arrow_back: "volver",
  save: "guardar",
  cancel: "cancelar",
  check: "confirmar",
  clear: "limpiar",
  filter_list: "filtrar",
  sort: "ordenar",
  visibility: "ver",
  visibility_off: "ocultar",
  download: "descargar",
  upload: "subir",
  refresh: "actualizar",
  settings: "configuración",
  home: "inicio",
  info: "información",
  warning: "advertencia",
  error: "error",
  help: "ayuda",
  lock: "bloquear",
  lock_open: "desbloquear",
};

const TAG_LABELS: Record<string, string> = {
  button: "botón",
  input: "campo",
  textarea: "área de texto",
  select: "selector",
  a: "enlace",
  label: "etiqueta",
  span: "texto",
  img: "imagen",
  form: "formulario",
  h1: "título",
  h2: "título",
  h3: "título",
  li: "elemento de lista",
  td: "celda",
  th: "encabezado",
};

function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

function sendMessage(payload: { type: string; step?: Step; log?: LogEntry }): void {
  void chrome.runtime.sendMessage(payload).catch(() => {});
}

function isIconElement(element: Element): boolean {
  const tag = element.tagName;
  if (tag === "I" || tag === "SVG") {
    return true;
  }

  const className = element.className?.toString() ?? "";
  if (ICON_CLASS_PATTERN.test(className)) {
    return true;
  }

  if (tag === "SPAN" && /icon|material|fa-/i.test(className)) {
    return true;
  }

  if (element instanceof HTMLElement) {
    const fontFamily = window.getComputedStyle(element).fontFamily.toLowerCase();
    if (fontFamily.includes("material symbols") || fontFamily.includes("material icons")) {
      return true;
    }
  }

  return false;
}

function toMenuOptionCase(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return normalized;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function isNavigationContext(element: Element): boolean {
  if (element.closest("mat-slide-toggle, mat-checkbox, mat-select, mat-form-field")) {
    return false;
  }

  if (
    element.closest(
      "mat-table, table, mat-row, tr, [role='grid'], [role='table'], .mat-mdc-table, cdk-table",
    )
  ) {
    return false;
  }

  if (element.closest("nav, aside")) {
    return true;
  }

  const listParent = element.closest("ul");
  if (
    listParent?.closest(
      'nav, aside, [class*="sidebar"], [class*="drawer"], [class*="menu"], [id*="menu"], [id*="sidebar"], [id*="drawer"]',
    )
  ) {
    return true;
  }

  let current: Element | null = element;
  while (current && current !== document.body) {
    const id = current.id ?? "";
    const className = current.className?.toString() ?? "";
    if (NAV_CONTEXT_PATTERN.test(id) || NAV_CONTEXT_PATTERN.test(className)) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function isIgnorableClickTarget(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === "html" || tag === "body";
}

function hasSilentWrapperClass(element: Element): boolean {
  let current: Element | null = element;
  while (current && current !== document.body) {
    const className = current.className?.toString() ?? "";
    if (SILENT_WRAPPER_PATTERN.test(className)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function cleanElementId(id: string): string {
  let cleaned = id.trim().replace(/^btn[-_]?/i, "");
  cleaned = cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  cleaned = cleaned.replace(/[-_]/g, " ");
  return cleaned.trim().toLowerCase();
}

function normalizeDictionaryKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

function resolveDisplayName(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const dictionaryKey = normalizeDictionaryKey(trimmed);
  if (CUSTOM_DICTIONARY[dictionaryKey]) {
    return CUSTOM_DICTIONARY[dictionaryKey];
  }

  return cleanCapturedText(trimmed);
}

function getIconClassToken(element: Element): string | null {
  for (const icon of element.querySelectorAll("i, span, svg")) {
    const className = icon.className?.toString() ?? "";
    const faMatch = className.match(/\b(fa-[a-z0-9-]+)\b/i);
    if (faMatch) {
      return faMatch[1].toLowerCase();
    }
  }
  return null;
}

function getButtonName(element: Element): string | null {
  const visibleText = stripKnownIconPrefixes(stripGhostIconWords(getVisibleLabelText(element)));
  if (visibleText) {
    return resolveDisplayName(visibleText);
  }

  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    return resolveDisplayName(ariaLabel);
  }

  const title = element.getAttribute("title")?.trim();
  if (title) {
    return resolveDisplayName(title);
  }

  const iconClass = getIconClassToken(element);
  if (iconClass) {
    const fromClass = resolveDisplayName(iconClass);
    if (fromClass) {
      return fromClass;
    }
  }

  const iconText = getIconOnlyText(element);
  if (iconText) {
    return resolveDisplayName(iconText);
  }

  if (element.id) {
    const fromId = cleanElementId(element.id);
    if (fromId) {
      return resolveDisplayName(fromId);
    }
  }

  return null;
}

function cleanLabelText(text: string): string {
  let cleaned = text.trim().replace(/\s+/g, " ");
  cleaned = cleaned.replace(/:\s*\*$/u, "");
  cleaned = cleaned.replace(/\s+\*$/u, "");
  return cleaned;
}

function isAutoGeneratedMatId(id: string): boolean {
  return /^mat-(checkbox|radio|slide-toggle|select)-\d+$/i.test(id);
}

function shouldIgnoreButtonName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return true;
  }
  if (CUSTOM_DICTIONARY[normalizeDictionaryKey(trimmed)]) {
    return false;
  }
  return trimmed.length <= 2;
}

function findOpenMatSelect(): Element | null {
  return (
    document.querySelector("mat-select[aria-expanded='true']") ??
    document.querySelector("mat-select.mat-select-open") ??
    document.querySelector("mat-select[aria-controls]")
  );
}

function findMatFormFieldLabel(matSelect: Element): string | null {
  const formField = matSelect.closest("mat-form-field, .mat-mdc-form-field");
  if (formField) {
    const labelElement = formField.querySelector(
      "mat-label, .mat-mdc-floating-label, .mdc-floating-label, label",
    );
    if (labelElement) {
      const text = getVisibleLabelText(labelElement) || labelElement.textContent?.trim() || "";
      if (text) {
        return cleanLabelText(text);
      }
    }
  }

  const ariaLabel = matSelect.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    return cleanLabelText(ariaLabel);
  }

  const labelledBy = matSelect.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelElement = document.getElementById(labelledBy);
    if (labelElement) {
      const text = getVisibleLabelText(labelElement) || labelElement.textContent?.trim() || "";
      if (text) {
        return cleanLabelText(text);
      }
    }
  }

  return null;
}

function formatMatSelectChoice(value: string, matSelect: Element | null): string {
  const fieldLabel = matSelect ? findMatFormFieldLabel(matSelect) : null;
  if (fieldLabel) {
    return `Seleccionar ${fieldLabel}, por ej. ${value}`;
  }
  return `Seleccionar opción, por ej. ${value}`;
}

function findMatSelectForOption(matOption: Element): Element | null {
  const openSelect = findOpenMatSelect();
  if (openSelect) {
    return openSelect;
  }

  const panel = matOption.closest(
    '[role="listbox"], .mat-mdc-select-panel, .mat-select-panel, .mat-select-panel',
  );
  if (panel?.id) {
    const linkedSelect = document.querySelector(`mat-select[aria-controls="${panel.id}"]`);
    if (linkedSelect) {
      return linkedSelect;
    }
  }

  if (panel) {
    for (const select of document.querySelectorAll("mat-select")) {
      const controls = select.getAttribute("aria-controls");
      if (controls && panel.id === controls) {
        return select;
      }
    }
  }

  return matOption.closest("mat-select");
}

function formatMatOptionClick(matOption: Element): string | null {
  const text =
    getVisibleLabelText(matOption) || matOption.textContent?.trim().replace(/\s+/g, " ") || "";
  if (!text || text.length > MAX_DROPDOWN_OPTION_LENGTH) {
    return null;
  }

  return formatMatSelectChoice(text, findMatSelectForOption(matOption));
}

function findMatSlideToggleLabel(matSlideToggle: Element): string {
  const labelElement = matSlideToggle.querySelector(
    ".mat-slide-toggle-content, .mdc-label, label, .mat-slide-toggle-label",
  );
  if (labelElement) {
    const text = getVisibleLabelText(labelElement) || labelElement.textContent?.trim() || "";
    if (text) {
      return cleanLabelText(text);
    }
  }

  const text = getVisibleLabelText(matSlideToggle);
  if (text) {
    return cleanLabelText(text);
  }

  const ariaLabel = matSlideToggle.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    return cleanLabelText(ariaLabel);
  }

  return "switch sin nombre";
}

function formatMatSlideToggleClick(matSlideToggle: Element): string {
  return `Presionar switch para cambiar a ${findMatSlideToggleLabel(matSlideToggle)}`;
}

function findMatCheckboxLabel(matCheckbox: Element): string {
  const labelSelectors = [
    ".mat-checkbox-label",
    ".mdc-label",
    '[class*="checkbox-label"]',
  ];
  for (const selector of labelSelectors) {
    const labelElement = matCheckbox.querySelector(selector);
    if (labelElement) {
      const text = getVisibleLabelText(labelElement);
      if (text) {
        return cleanLabelText(text);
      }
    }
  }

  const ariaLabel = matCheckbox.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    return cleanLabelText(ariaLabel);
  }

  const labelledBy = matCheckbox.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelElement = document.getElementById(labelledBy);
    if (labelElement) {
      const text = getVisibleLabelText(labelElement);
      if (text) {
        return cleanLabelText(text);
      }
    }
  }

  const associatedLabel = findAssociatedLabelText(matCheckbox);
  if (associatedLabel) {
    return cleanLabelText(associatedLabel);
  }

  return "switch sin nombre";
}

function isMatSelectFieldClick(element: Element): boolean {
  if (element.closest("mat-option")) {
    return false;
  }

  if (element.closest("mat-select, .mat-select-trigger")) {
    return true;
  }

  const formField = element.closest("mat-form-field, .mat-mdc-form-field");
  return Boolean(formField?.querySelector("mat-select"));
}

function formatMatCheckboxClick(matCheckbox: Element): string {
  return `Presionar switch para cambiar a ${findMatCheckboxLabel(matCheckbox)}`;
}

type ClickResolution =
  | { type: "silent" }
  | { type: "ready"; element: Element; description: string }
  | { type: "continue"; element: Element };

function resolveClickContext(rawElement: Element): ClickResolution {
  const matOption = rawElement.closest("mat-option");
  if (matOption) {
    const description = formatMatOptionClick(matOption);
    if (description) {
      return { type: "ready", element: matOption, description };
    }
  }

  if (hasSilentWrapperClass(rawElement)) {
    return { type: "silent" };
  }

  if (isMatSelectFieldClick(rawElement)) {
    return { type: "silent" };
  }

  const matCheckbox = rawElement.closest("mat-checkbox");
  if (matCheckbox) {
    return {
      type: "ready",
      element: matCheckbox,
      description: formatMatCheckboxClick(matCheckbox),
    };
  }

  const matSlideToggle = rawElement.closest("mat-slide-toggle");
  if (matSlideToggle) {
    return {
      type: "ready",
      element: matSlideToggle,
      description: formatMatSlideToggleClick(matSlideToggle),
    };
  }

  const button = rawElement.closest("button, mat-icon-button, [mat-icon-button]");
  if (button) {
    return { type: "continue", element: button };
  }

  return { type: "continue", element: getActionableElement(rawElement) };
}

function isButtonElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "mat-icon-button") {
    return true;
  }
  if (element.hasAttribute("mat-icon-button")) {
    return true;
  }
  return element.getAttribute("role") === "button";
}

function cleanCapturedText(text: string): string {
  let cleaned = text.trim().replace(/\s+/g, " ");
  cleaned = cleaned.replace(/:\s*\*$/u, "");
  cleaned = cleaned.replace(/\s+\*$/u, "");
  return cleaned.toLowerCase();
}

function translateIconText(text: string): string {
  const dictionaryKey = normalizeDictionaryKey(text);
  if (CUSTOM_DICTIONARY[dictionaryKey]) {
    return CUSTOM_DICTIONARY[dictionaryKey];
  }

  const iconKey = text.trim().toLowerCase().replace(/\s+/g, "_");
  if (ICON_TEXT_MAP[iconKey]) {
    return ICON_TEXT_MAP[iconKey];
  }

  return cleanCapturedText(text);
}

function getTextWithoutIcons(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  const iconElements: Element[] = [];
  clone.querySelectorAll("*").forEach((element) => {
    if (isIconElement(element)) {
      iconElements.push(element);
    }
  });
  iconElements.forEach((element) => element.remove());
  clone.querySelectorAll("i, svg").forEach((element) => element.remove());
  return clone.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

function getVisibleLabelText(root: Element): string {
  const withoutIcons = getTextWithoutIcons(root);
  if (withoutIcons) {
    return withoutIcons;
  }

  const parts: string[] = [];
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent?.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (child instanceof Element && !isIconElement(child)) {
      const text = getTextWithoutIcons(child);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join(" ").trim();
}

function stripGhostIconWords(text: string): string {
  let result = text.trim();
  for (const word of ICON_GHOST_WORDS) {
    result = result.replace(new RegExp(`^${word}(?=\\s)`, "i"), "");
    result = result.replace(new RegExp(`^${word}(?=[A-ZÁÉÍÓÚÑ])`, "i"), "");
    result = result.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  }
  return result.replace(/\s+/g, " ").trim();
}

function stripKnownIconPrefixes(text: string): string {
  for (const iconName of Object.keys(ICON_TEXT_MAP)) {
    const pattern = new RegExp(`^${iconName.replace(/_/g, "[\\s_]+")}`, "i");
    if (pattern.test(text)) {
      const rest = text.replace(pattern, "").trim();
      if (rest) {
        return rest;
      }
    }
  }
  return text;
}

function getIconOnlyText(element: Element): string | null {
  for (const icon of element.querySelectorAll("i, svg, span")) {
    if (!isIconElement(icon)) {
      continue;
    }
    const iconText = icon.textContent?.trim();
    if (iconText) {
      return iconText;
    }
  }
  return element.getAttribute("aria-label")?.trim() ?? null;
}

function getCleanClickText(element: Element): string {
  let text = getVisibleLabelText(element);
  text = stripGhostIconWords(text);
  text = stripKnownIconPrefixes(text);
  text = cleanCapturedText(text);

  if (!text) {
    const iconClass = getIconClassToken(element);
    if (iconClass) {
      text = resolveDisplayName(iconClass);
    }
  }

  if (!text) {
    const iconOnly = getIconOnlyText(element);
    if (iconOnly && !ICON_GHOST_WORDS.includes(iconOnly.toLowerCase())) {
      text = translateIconText(iconOnly);
    }
  }

  return resolveDisplayName(text);
}

function findAssociatedLabelText(element: Element): string | null {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelElement = document.getElementById(labelledBy);
    if (labelElement) {
      const text = getVisibleLabelText(labelElement);
      if (text) {
        return cleanCapturedText(text);
      }
    }
  }

  if (element instanceof HTMLInputElement && element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (label) {
      const text = getVisibleLabelText(label);
      if (text) {
        return cleanCapturedText(text);
      }
    }
  }

  const parentLabel = element.closest("label");
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as Element;
    clone
      .querySelectorAll('input, [role="switch"], [role="checkbox"]')
      .forEach((control) => control.remove());
    const labelText = getVisibleLabelText(clone);
    if (labelText) {
      return cleanCapturedText(labelText);
    }
  }

  const nextSibling = element.nextElementSibling;
  if (nextSibling?.tagName === "LABEL") {
    const text = getVisibleLabelText(nextSibling);
    if (text) {
      return cleanCapturedText(text);
    }
  }

  const previousSibling = element.previousElementSibling;
  if (previousSibling?.tagName === "LABEL") {
    const text = getVisibleLabelText(previousSibling);
    if (text) {
      return cleanCapturedText(text);
    }
  }

  return null;
}

function findToggleName(element: Element): string {
  const matSlideToggle = element.closest("mat-slide-toggle");
  if (matSlideToggle) {
    return findMatSlideToggleLabel(matSlideToggle);
  }

  const matCheckbox = element.closest("mat-checkbox");
  if (matCheckbox) {
    return findMatCheckboxLabel(matCheckbox);
  }

  const labelText = findAssociatedLabelText(element);
  if (labelText) {
    return labelText;
  }

  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    return cleanCapturedText(ariaLabel);
  }

  const title = element.getAttribute("title")?.trim();
  if (title) {
    return cleanCapturedText(title);
  }

  if (element instanceof HTMLInputElement && element.name) {
    return cleanCapturedText(element.name);
  }

  if (element.id && !isAutoGeneratedMatId(element.id)) {
    return cleanCapturedText(element.id);
  }

  return "switch sin nombre";
}

function isToggleControl(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    return element.type === "checkbox" || element.type === "radio";
  }
  const role = element.getAttribute("role");
  return role === "switch" || role === "checkbox";
}

function getActionableElement(element: Element): Element {
  const matOption = element.closest("mat-option");
  if (matOption) {
    return matOption;
  }

  const button = element.closest("button, mat-icon-button, [mat-icon-button], [role='button']");
  if (button) {
    return button;
  }

  const matCheckbox = element.closest("mat-checkbox");
  if (matCheckbox) {
    return matCheckbox;
  }

  const matSlideToggle = element.closest("mat-slide-toggle");
  if (matSlideToggle) {
    return matSlideToggle;
  }

  const matSelect = element.closest("mat-select, .mat-select-trigger");
  if (matSelect) {
    return matSelect;
  }

  return (
    element.closest(
      [
        "a",
        '[role="button"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[role="checkbox"]',
        'input[type="checkbox"]',
        'input[type="radio"]',
        "li",
        "tr",
        "td",
        "mat-row",
        "mat-cell",
      ].join(", "),
    ) ?? element
  );
}

function describeElement(element: Element): {
  tag: string;
  selector: string;
  text: string;
} {
  const tag = element.tagName.toLowerCase();
  const inputElement = element as HTMLInputElement;

  const id = element.id ? `#${element.id}` : "";
  const name = inputElement.name ? `[name="${inputElement.name}"]` : "";
  const ariaLabel = element.getAttribute("aria-label");
  const placeholder = inputElement.placeholder;
  const classes =
    element.classList.length > 0
      ? `.${Array.from(element.classList).slice(0, 2).join(".")}`
      : "";

  const selector = id || name || (ariaLabel ? `[aria-label="${ariaLabel}"]` : "") || classes || tag;
  const visibleText = getVisibleLabelText(element);
  const text =
    ariaLabel ||
    placeholder ||
    visibleText.slice(0, 80) ||
    (inputElement.type !== "checkbox" && inputElement.type !== "radio"
      ? inputElement.value?.slice(0, 80)
      : "") ||
    tag;

  return { tag, selector, text };
}

function isFormControl(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

const MAX_ROW_IDENTIFIER_LENGTH = 40;

function getTableRow(element: Element): Element | null {
  return element.closest("tr, mat-row, [role='row']");
}

function isTableRowInteractiveAction(element: Element): boolean {
  if (!getTableRow(element)) {
    return false;
  }

  const interactive =
    element.closest("button, mat-icon-button, [mat-icon-button], a, [role='button']") ?? element;
  const tag = interactive.tagName.toLowerCase();

  return (
    tag === "button" ||
    tag === "a" ||
    tag === "mat-icon-button" ||
    interactive.getAttribute("role") === "button" ||
    interactive.hasAttribute("mat-icon-button")
  );
}

function extractDataCellText(cell: Element): string | null {
  const clone = cell.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "button, mat-icon-button, [mat-icon-button], [role='button'], a, i, svg, .material-icons, .material-symbols",
    )
    .forEach((child) => child.remove());

  const text = (getVisibleLabelText(clone) || clone.textContent?.trim() || "").replace(/\s+/g, " ");
  if (!text || text.includes("\n") || shouldIgnoreButtonName(text)) {
    return null;
  }
  return text.length > MAX_CLICK_TEXT_LENGTH ? text.slice(0, MAX_CLICK_TEXT_LENGTH).trim() : text;
}

function isActionOnlyCell(cell: Element): boolean {
  const hasActionControl = cell.querySelector(
    "button, mat-icon-button, [mat-icon-button], [role='button'], a.mat-icon-button",
  );
  if (!hasActionControl) {
    return false;
  }

  const clone = cell.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "button, mat-icon-button, [mat-icon-button], [role='button'], i, svg, .material-icons, .material-symbols",
    )
    .forEach((element) => element.remove());
  const remaining = getVisibleLabelText(clone).trim();
  return !remaining || remaining.length <= 2;
}

function getRowCellText(cell: Element): string | null {
  if (isActionOnlyCell(cell)) {
    return null;
  }

  const text = getVisibleLabelText(cell) || (cell.textContent?.trim().replace(/\s+/g, " ") ?? "");
  if (!text || text.includes("\n") || text.length > MAX_CLICK_TEXT_LENGTH) {
    return null;
  }
  return text;
}

function buildRowIdentifier(row: Element): string | null {
  const cells = row.querySelectorAll("td, th, mat-cell, cdk-cell");
  const cellTexts: string[] = [];

  for (const cell of cells) {
    const text = getRowCellText(cell) ?? extractDataCellText(cell);
    if (!text) {
      continue;
    }
    cellTexts.push(text);
    if (cellTexts.length >= 2) {
      break;
    }
  }

  if (cellTexts.length === 0 && cells.length > 0) {
    const firstCellText = extractDataCellText(cells[0]);
    if (firstCellText) {
      cellTexts.push(firstCellText);
    }
  }

  if (cellTexts.length === 0) {
    return null;
  }

  let rowIdentifier =
    cellTexts.length >= 2 ? `${cellTexts[0]} - ${cellTexts[1]}` : cellTexts[0];

  if (rowIdentifier.length > MAX_ROW_IDENTIFIER_LENGTH) {
    rowIdentifier = cellTexts[0];
    if (rowIdentifier.length > MAX_ROW_IDENTIFIER_LENGTH) {
      rowIdentifier = rowIdentifier.slice(0, MAX_ROW_IDENTIFIER_LENGTH).trim();
    }
  }

  return rowIdentifier || null;
}

function formatButtonWithRowContext(element: Element, buttonName: string): string | null {
  if (shouldIgnoreButtonName(buttonName)) {
    return null;
  }

  const row = getTableRow(element);
  if (!row) {
    return `Presionar botón ${buttonName}`;
  }

  const rowIdentifier = buildRowIdentifier(row);
  if (!rowIdentifier) {
    return `Presionar botón ${buttonName}`;
  }

  return `Presionar botón ${buttonName} del registro, por ej. ${rowIdentifier}`;
}

function getCleanCellText(cell: Element): string | null {
  const text = cell.textContent?.trim() ?? "";
  if (!text || text.includes("\n") || text.length > MAX_CLICK_TEXT_LENGTH) {
    return null;
  }
  return text;
}

function findFirstCleanCellText(row: HTMLTableRowElement): string | null {
  for (const cell of row.querySelectorAll("td, th")) {
    const text = getCleanCellText(cell);
    if (text) {
      return text;
    }
  }
  return null;
}

function formatTableRowClick(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  const row =
    tag === "tr" || tag === "mat-row"
      ? element
      : element.closest("tr, mat-row");
  if (!row) {
    return null;
  }
  const rowIdentifier = buildRowIdentifier(row);
  if (!rowIdentifier) {
    return null;
  }
  return `Seleccionar registro de tabla, por ej. ${rowIdentifier}`;
}

function formatListboxOptionClick(element: Element): string | null {
  const matOption = element.closest("mat-option");
  if (matOption) {
    return formatMatOptionClick(matOption);
  }

  const option =
    element.closest('[role="option"]') ??
    (element.tagName === "LI" && element.closest('[role="listbox"], [role="menu"], .MuiMenu-list, .MuiAutocomplete-listbox')
      ? element
      : null);

  if (!option) {
    return null;
  }

  const listbox = option.closest('[role="listbox"], [role="menu"], .MuiMenu-list, .MuiAutocomplete-listbox');
  if (!listbox) {
    return null;
  }

  const text = getCleanClickText(option);
  if (!text || text.length > MAX_DROPDOWN_OPTION_LENGTH) {
    return null;
  }

  return `Seleccionar opción, por ej. ${text}`;
}

function formatToggleDescription(element: Element): string {
  return `Presionar switch para cambiar a ${findToggleName(element)}`;
}

function formatFallbackClick(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const className = element.className?.toString().trim();
  const classPart = className
    ? `.${className.split(/\s+/).slice(0, 2).join(".")}`
    : "";
  const identifier = id || classPart || "(sin identificar)";
  return `Interacción manual requerida en elemento: <${tag}> ${identifier}`;
}

function formatPressDescription(element: Element, cleanedText: string): string | null {
  if (isTableRowInteractiveAction(element)) {
    return formatButtonWithRowContext(element, cleanedText);
  }

  if (isNavigationContext(element)) {
    return `Presionar la opción "${toMenuOptionCase(cleanedText)}"`;
  }

  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");

  if (tag === "button" || role === "button" || element.closest("mat-icon-button, [mat-icon-button]")) {
    return formatButtonWithRowContext(element, cleanedText);
  }

  if (tag === "a") {
    return `Presionar enlace ${cleanedText}`;
  }

  if (
    role === "menuitem" ||
    element.closest('[role="menu"], [role="menubar"], [class*="MuiDrawer"], [class*="MuiList"]')
  ) {
    return `Presionar la opción "${toMenuOptionCase(cleanedText)}"`;
  }

  return `Presionar la opción "${toMenuOptionCase(cleanedText)}"`;
}

function formatClickDescription(actionable: Element): string | null {
  if (isIgnorableClickTarget(actionable)) {
    return null;
  }

  const matOption = actionable.closest("mat-option");
  if (matOption) {
    return formatMatOptionClick(matOption);
  }

  const tag = actionable.tagName.toLowerCase();

  if (tag === "tr" || tag === "td" || tag === "mat-row" || tag === "mat-cell") {
    const tableStep = formatTableRowClick(actionable);
    if (tableStep) {
      return tableStep;
    }
  }

  const listboxOption = formatListboxOptionClick(actionable);
  if (listboxOption) {
    return listboxOption;
  }

  if (actionable.closest("mat-checkbox")) {
    return formatMatCheckboxClick(actionable.closest("mat-checkbox")!);
  }

  if (actionable.closest("mat-slide-toggle")) {
    return formatMatSlideToggleClick(actionable.closest("mat-slide-toggle")!);
  }

  if (isMatSelectFieldClick(actionable)) {
    return null;
  }

  if (
    actionable instanceof HTMLInputElement &&
    (actionable.type === "checkbox" || actionable.type === "radio")
  ) {
    return formatToggleDescription(actionable);
  }

  const role = actionable.getAttribute("role");
  if (role === "switch" || role === "checkbox") {
    return formatToggleDescription(actionable);
  }

  const cleanedText = getCleanClickText(actionable);

  if (isTableRowInteractiveAction(actionable)) {
    const tableActionName = getButtonName(actionable) || cleanedText;
    if (tableActionName && !shouldIgnoreButtonName(tableActionName)) {
      return formatButtonWithRowContext(actionable, tableActionName);
    }
  }

  if (!cleanedText) {
    if (isButtonElement(actionable)) {
      const buttonName = getButtonName(actionable);
      if (buttonName) {
        return formatButtonWithRowContext(actionable, buttonName);
      }
    }

    if (isFormControl(actionable)) {
      const input = actionable as HTMLInputElement;
      const fallback =
        input.getAttribute("aria-label")?.trim() ||
        input.placeholder?.trim() ||
        input.name?.trim() ||
        "";
      if (
        fallback &&
        !fallback.includes("\n") &&
        fallback.length <= MAX_CLICK_TEXT_LENGTH
      ) {
        return formatPressDescription(actionable, cleanCapturedText(fallback));
      }
    }
    return formatFallbackClick(actionable);
  }

  if (isButtonElement(actionable) && shouldIgnoreButtonName(cleanedText)) {
    return null;
  }

  if (
    !isFormControl(actionable) &&
    (cleanedText.includes("\n") || cleanedText.length > MAX_CLICK_TEXT_LENGTH)
  ) {
    return formatFallbackClick(actionable);
  }

  return formatPressDescription(actionable, cleanedText);
}

function resolveClickTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Text && target.parentElement) {
    return target.parentElement;
  }
  return null;
}

function pushCapturedStep(
  action: string,
  element: Element,
  description: string,
  extra?: Pick<Step, "value">,
): void {
  if (!isRecording) {
    return;
  }
  if (description === lastSavedStepDescription) {
    return;
  }
  lastSavedStepDescription = description;

  const { tag, selector, text } = describeElement(element);
  const step: Step = {
    action,
    description,
    selector,
    tag,
    text,
    value: extra?.value,
    timestamp: Date.now(),
    url: window.location.href,
  };

  sendMessage({ type: MessageType.CAPTURE_STEP, step });
}

function pushClickStep(rawTarget: Element): void {
  if (isIgnorableClickTarget(rawTarget)) {
    return;
  }

  const context = resolveClickContext(rawTarget);
  if (context.type === "silent") {
    return;
  }

  if (context.type === "ready") {
    pushCapturedStep("click", context.element, context.description);
    return;
  }

  const description = formatClickDescription(context.element);
  if (!description) {
    return;
  }
  pushCapturedStep("click", context.element, description);
}

function pushToggleStep(element: HTMLInputElement): void {
  pushCapturedStep("toggle", element, formatToggleDescription(element));
}

function pushStep(action: string, element: Element, value?: string): void {
  if (!isRecording) {
    return;
  }

  const { tag, selector, text } = describeElement(element);
  const elementLabel = tagLabel(tag);
  const readable = `Escribió en ${elementLabel} '${text}'${value ? `: "${value}"` : ""}`;

  pushCapturedStep(action, element, readable, { value });
}

function pushLog(log: Omit<LogEntry, "timestamp" | "url">): void {
  if (!isRecording) {
    return;
  }

  sendMessage({
    type: MessageType.CAPTURE_LOG,
    log: {
      ...log,
      timestamp: Date.now(),
      url: window.location.href,
    },
  });
}

function installConsoleInterceptors(): void {
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    pushLog({
      type: "console.error",
      message: args.map((arg) => String(arg)).join(" "),
    });
    originalConsoleError(...args);
  };

  console.warn = (...args: unknown[]) => {
    pushLog({
      type: "console.warn",
      message: args.map((arg) => String(arg)).join(" "),
    });
    originalConsoleWarn(...args);
  };

  window.addEventListener(
    "error",
    (event) => {
      pushLog({
        type: "window.error",
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    pushLog({
      type: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

function installEventListeners(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = resolveClickTarget(event.target);
      if (!target) {
        return;
      }
      if (target.closest("#brentester-region-overlay")) {
        return;
      }
      pushClickStep(target);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }
      if (target instanceof HTMLInputElement && isToggleControl(target)) {
        return;
      }
      pushStep("input", target, target.value);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement) {
        pushStep("input", target, target.value);
        return;
      }
      if (target instanceof HTMLInputElement && isToggleControl(target)) {
        const matCheckbox = target.closest("mat-checkbox");
        if (matCheckbox) {
          pushCapturedStep("toggle", matCheckbox, formatMatCheckboxClick(matCheckbox));
          return;
        }
        pushToggleStep(target);
      }
    },
    { capture: true, passive: true },
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MessageType.CONTENT_RECORDING_START) {
    isRecording = true;
    lastSavedStepDescription = null;
    return false;
  }

  if (message?.type === MessageType.CONTENT_RECORDING_STOP) {
    isRecording = false;
    lastSavedStepDescription = null;
    return false;
  }

  if (message?.type === MessageType.CONTENT_START_REGION_PICKER) {
    pickRegion()
      .then((region) => sendResponse({ ok: true, region }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.CONTENT_CROP_SCREENSHOT) {
    cropScreenshot(message.dataUrl, message.region)
      .then((screenshotBlob) => blobToBase64(screenshotBlob))
      .then((screenshotBase64) => sendResponse({ ok: true, screenshotBase64 }))
      .catch((error: Error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message?.type === MessageType.CONTENT_REMOVE_REGION_OVERLAY) {
    removeRegionOverlay();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function syncRecordingState(): void {
  chrome.runtime.sendMessage({ type: MessageType.CONTENT_SYNC_RECORDING }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }
    if (response?.isRecording) {
      isRecording = true;
    }
  });
}

syncRecordingState();

installConsoleInterceptors();
installEventListeners();
