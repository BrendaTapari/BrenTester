import type { NetworkEntry } from "../shared/types";

const pendingRequests = new Map<
  string,
  { method: string; url: string; resourceType: string; startedAt: number }
>();

const IGNORED_URL_PREFIXES = ["chrome-extension:", "chrome:", "data:", "blob:"];
const IGNORED_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media", "ping", "script", "other"]);
const TRACKED_RESOURCE_TYPES = new Set(["xmlhttprequest", "fetch"]);

function shouldTrack(details: chrome.webRequest.WebRequestBodyDetails): boolean {
  if (details.tabId < 0) {
    return false;
  }

  if (IGNORED_RESOURCE_TYPES.has(details.type)) {
    return false;
  }

  if (!TRACKED_RESOURCE_TYPES.has(details.type)) {
    return false;
  }

  return !IGNORED_URL_PREFIXES.some((prefix) => details.url.startsWith(prefix));
}

export function installNetworkMonitor(
  getRecordingTabId: () => number | null,
  getPageUrl: () => string,
  pushNetwork: (entry: NetworkEntry) => void,
): void {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const tabId = getRecordingTabId();
      if (tabId === null || details.tabId !== tabId || !shouldTrack(details)) {
        return;
      }

      pendingRequests.set(details.requestId, {
        method: details.method,
        url: details.url,
        resourceType: details.type,
        startedAt: details.timeStamp,
      });
    },
    { urls: ["http://*/*", "https://*/*"] },
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const tabId = getRecordingTabId();
      if (tabId === null || details.tabId !== tabId) {
        return;
      }

      const pending = pendingRequests.get(details.requestId);
      if (!pending) {
        return;
      }

      pendingRequests.delete(details.requestId);

      pushNetwork({
        method: pending.method,
        url: pending.url,
        resourceType: pending.resourceType,
        timestamp: Math.round(pending.startedAt),
        pageUrl: getPageUrl(),
        status: details.statusCode,
        durationMs: Math.round(details.timeStamp - pending.startedAt),
      });
    },
    { urls: ["http://*/*", "https://*/*"] },
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const tabId = getRecordingTabId();
      if (tabId === null || details.tabId !== tabId) {
        return;
      }

      const pending = pendingRequests.get(details.requestId);
      if (!pending) {
        return;
      }

      pendingRequests.delete(details.requestId);

      pushNetwork({
        method: pending.method,
        url: pending.url,
        resourceType: pending.resourceType,
        timestamp: Math.round(pending.startedAt),
        pageUrl: getPageUrl(),
        error: details.error,
      });
    },
    { urls: ["http://*/*", "https://*/*"] },
  );
}
