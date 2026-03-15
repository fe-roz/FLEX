/**
 * api.js — Shared backend communication, URL helpers, workflow state, and logging utilities.
 *
 * Extracted from flex.js so that future modules can import these without
 * depending on the monolithic file.
 */

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function getBackendBaseUrl() {
  if (window.serverConfig && window.serverConfig.backend && window.serverConfig.backend.baseUrl) {
    return window.serverConfig.backend.baseUrl.replace(/\/$/, "");
  }
  return "http://127.0.0.1:8083";
}

export function toAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== "string") {
    return null;
  }
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const base = getBackendBaseUrl();
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

// ---------------------------------------------------------------------------
// Shared workflow state
// ---------------------------------------------------------------------------

export const workflowState = {
  selectedAoiId: null,
  selectedAoiName: null,
  selectedProcessAreaId: null,
  selectedProcessAreaName: null,
  aoiDataSource: null,
  processAreaDataSource: null,
  aoiVisible: true,
  busy: false,
  logs: [],
  pollTimer: null,
  latestDownloadStatus: null,
  latestIntegrityStatus: null,
  latestEptStatus: null,
  aoiStatusById: {},
  drawModeActive: false,
  drawHandler: null,
  drawPositions: [],
  drawVertexEntities: [],
  drawLineEntity: null,
  drawPolygonEntity: null,
  serverConnected: false,
  serverMonitorTimer: null,
  queuePanelOpen: false,
  queuePollTimer: null,
  latestQueueOverview: null
};

// ---------------------------------------------------------------------------
// Backend API caller
// ---------------------------------------------------------------------------

export async function backendApi(path, options = {}) {
  const target = toAbsoluteUrl(path);
  const requestOptions = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };
  if (options.body !== undefined) {
    requestOptions.body = JSON.stringify(options.body);
  }
  const response = await fetch(target, requestOptions);
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      payload = { raw: responseText };
    }
  }
  if (!response.ok) {
    const detail = payload && payload.detail ? payload.detail : `${response.status} ${response.statusText}`;
    throw new Error(`${path}: ${detail}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// UI helpers (logging / status)
// ---------------------------------------------------------------------------

export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

export function appendWorkflowLog(message, level = "info") {
  const timestamp = new Date().toLocaleTimeString();
  workflowState.logs.unshift(`[${timestamp}] ${level.toUpperCase()} ${message}`);
  workflowState.logs = workflowState.logs.slice(0, 20);
  const logEl = document.getElementById("workflow_log");
  if (logEl) {
    logEl.textContent = workflowState.logs.join("\n");
  }
}

export function setWorkflowActionStatus(message, isError = false) {
  const el = document.getElementById("wf_action_status");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.style.background = isError ? "rgba(211, 47, 47, 0.25)" : "rgba(255, 255, 255, 0.08)";
}

// Note: updateWorkflowButtons is defined in flex.js — we accept it as a
// dependency that callers must supply when needed rather than creating a
// circular import.  For now setWorkflowBusy lives here and calls
// updateWorkflowButtons only if it has been registered.

let _updateWorkflowButtons = null;

export function registerUpdateWorkflowButtons(fn) {
  _updateWorkflowButtons = fn;
}

export function setWorkflowBusy(busy, message) {
  workflowState.busy = busy;
  if (message) {
    setWorkflowActionStatus(message, false);
  }
  if (_updateWorkflowButtons) {
    _updateWorkflowButtons();
  }
}
