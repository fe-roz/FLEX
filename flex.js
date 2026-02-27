import * as THREE from "./PotreeCopied/libs/three.js/build/three.module.js";

import "../Tokens.js";

function getBackendBaseUrl() {
  if (window.serverConfig && window.serverConfig.backend && window.serverConfig.backend.baseUrl) {
    return window.serverConfig.backend.baseUrl.replace(/\/$/, "");
  }
  return "http://127.0.0.1:8083";
}

function toAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== "string") {
    return null;
  }
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const base = getBackendBaseUrl();
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

const workflowState = {
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
  serverMonitorTimer: null,
  queuePanelOpen: false,
  queuePollTimer: null,
  latestQueueOverview: null
};

function isAoiGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return false;
  }
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

function pickMapPosition(screenPosition) {
  const scene = cesiumViewer.scene;
  const ray = cesiumViewer.camera.getPickRay(screenPosition);
  if (!ray) {
    return null;
  }

  // Prefer terrain/globe intersection so AOI draw clicks stay on visible ground.
  let cartesian = scene.globe.pick(ray, scene);
  if (!Cesium.defined(cartesian) && scene.pickPositionSupported) {
    cartesian = scene.pickPosition(screenPosition);
  }
  if (!Cesium.defined(cartesian)) {
    return null;
  }

  // Safety guard: reject any point that falls behind the camera view direction.
  const toPoint = Cesium.Cartesian3.subtract(
    cartesian,
    cesiumViewer.camera.positionWC,
    new Cesium.Cartesian3()
  );
  if (Cesium.Cartesian3.dot(toPoint, cesiumViewer.camera.directionWC) <= 0) {
    return null;
  }
  return cartesian;
}

function setAoiVisibility(visible) {
  workflowState.aoiVisible = !!visible;
  if (workflowState.aoiDataSource) {
    workflowState.aoiDataSource.show = workflowState.aoiVisible;
  }
  const btn = document.getElementById("top_toggle_aois_btn");
  if (btn) {
    btn.textContent = workflowState.aoiVisible ? "Hide Areas Of Interest" : "Show Areas Of Interest";
  }
}

function clearDrawEntities() {
  for (const entity of workflowState.drawVertexEntities) {
    cesiumViewer.entities.remove(entity);
  }
  workflowState.drawVertexEntities = [];
  if (workflowState.drawLineEntity) {
    cesiumViewer.entities.remove(workflowState.drawLineEntity);
    workflowState.drawLineEntity = null;
  }
  if (workflowState.drawPolygonEntity) {
    cesiumViewer.entities.remove(workflowState.drawPolygonEntity);
    workflowState.drawPolygonEntity = null;
  }
}

function stopAoiDrawMode(message = "AOI draw mode ended.") {
  if (workflowState.drawHandler) {
    workflowState.drawHandler.destroy();
    workflowState.drawHandler = null;
  }
  clearDrawEntities();
  workflowState.drawPositions = [];
  workflowState.drawModeActive = false;
  const drawStatus = document.getElementById("top_draw_status");
  if (drawStatus) {
    drawStatus.textContent = message;
  }
  const drawBtn = document.getElementById("top_draw_aoi_btn");
  if (drawBtn) {
    drawBtn.disabled = false;
  }
  const uploadBtn = document.getElementById("top_upload_aoi_btn");
  if (uploadBtn) {
    uploadBtn.disabled = false;
  }
}

async function finishAoiDrawMode() {
  if (workflowState.drawPositions.length < 3) {
    throw new Error("Need at least 3 vertices to create an AOI polygon.");
  }
  const coords = workflowState.drawPositions.map((pos) => {
    const c = Cesium.Cartographic.fromCartesian(pos);
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
  });
  const closed = [...coords, coords[0]];
  const name = window.prompt("Name this AOI:", `AOI ${new Date().toLocaleString()}`);
  if (!name || !name.trim()) {
    throw new Error("AOI creation canceled (no name provided).");
  }
  const confirmed = window.confirm(`Create AOI \"${name.trim()}\" with ${coords.length} vertices?`);
  if (!confirmed) {
    throw new Error("AOI creation canceled.");
  }
  const created = await backendApi("/api/v1/aois", {
    method: "POST",
    body: {
      name: name.trim(),
      geometry: { type: "Polygon", coordinates: [closed] }
    }
  });
  await loadAoiCatalogToMap();
  workflowState.selectedAoiId = created.id;
  workflowState.selectedAoiName = created.name;
  workflowState.selectedProcessAreaId = null;
  workflowState.selectedProcessAreaName = null;
  updateWorkflowSelectionLabels();
  updateWorkflowPanelVisibility();
  styleAoiEntities();
  appendWorkflowLog(`Created AOI ${created.name} via draw mode.`);
}

function startAoiDrawMode() {
  if (workflowState.drawModeActive) {
    return;
  }
  workflowState.drawModeActive = true;
  workflowState.drawPositions = [];
  const drawStatus = document.getElementById("top_draw_status");
  if (drawStatus) {
    drawStatus.textContent = "Draw mode: left-click vertices, right-click to finish.";
  }
  const drawBtn = document.getElementById("top_draw_aoi_btn");
  if (drawBtn) {
    drawBtn.disabled = true;
  }
  const uploadBtn = document.getElementById("top_upload_aoi_btn");
  if (uploadBtn) {
    uploadBtn.disabled = true;
  }
  workflowState.drawLineEntity = cesiumViewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => workflowState.drawPositions, false),
      width: 2,
      clampToGround: true,
      material: Cesium.Color.LIME
    }
  });
  workflowState.drawPolygonEntity = cesiumViewer.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => {
        if (workflowState.drawPositions.length < 3) {
          return null;
        }
        return new Cesium.PolygonHierarchy(workflowState.drawPositions);
      }, false),
      material: Cesium.Color.LIME.withAlpha(0.2),
      outline: true,
      outlineColor: Cesium.Color.LIME
    }
  });
  workflowState.drawHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);
  workflowState.drawHandler.setInputAction((movement) => {
    const position = pickMapPosition(movement.position);
    if (!position) {
      if (drawStatus) {
        drawStatus.textContent = "Could not place vertex at this location. Try a different view.";
      }
      return;
    }
    workflowState.drawPositions.push(position);
    const marker = cesiumViewer.entities.add({
      position,
      point: {
        pixelSize: 8,
        color: Cesium.Color.LIME,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      }
    });
    workflowState.drawVertexEntities.push(marker);
    if (drawStatus) {
      drawStatus.textContent = `Draw mode: ${workflowState.drawPositions.length} vertex(es). Right-click to finish.`;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  workflowState.drawHandler.setInputAction(async () => {
    try {
      await finishAoiDrawMode();
      stopAoiDrawMode("AOI created from drawing.");
    } catch (error) {
      appendWorkflowLog(error.message, "error");
      stopAoiDrawMode(error.message);
    }
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
}

function uploadAoiFromFile(accept, parser) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async (e) => {
      try {
        const file = e.target.files && e.target.files[0];
        if (!file) {
          reject(new Error("No file selected."));
          return;
        }
        const text = await file.text();
        await parser(file, text);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

async function createAoiFromGeoJsonUpload() {
  await uploadAoiFromFile(".geojson,.json,application/geo+json,application/json", async (file, text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("Invalid GeoJSON file.");
    }
    let geometry = null;
    if (parsed.type === "Feature") {
      geometry = parsed.geometry;
    } else if (parsed.type === "FeatureCollection" && Array.isArray(parsed.features) && parsed.features[0]) {
      geometry = parsed.features[0].geometry;
    } else {
      geometry = parsed;
    }
    if (!isAoiGeometry(geometry)) {
      throw new Error("GeoJSON must contain a Polygon or MultiPolygon.");
    }
    const defaultName = file.name.replace(/\.[^.]+$/, "");
    const name = window.prompt("AOI name:", defaultName);
    if (!name || !name.trim()) {
      throw new Error("AOI upload canceled.");
    }
    const created = await backendApi("/api/v1/aois", {
      method: "POST",
      body: { name: name.trim(), geometry }
    });
    await loadAoiCatalogToMap();
    workflowState.selectedAoiId = created.id;
    workflowState.selectedAoiName = created.name;
    workflowState.selectedProcessAreaId = null;
    workflowState.selectedProcessAreaName = null;
    updateWorkflowSelectionLabels();
    updateWorkflowPanelVisibility();
    styleAoiEntities();
    appendWorkflowLog(`Created AOI ${created.name} from GeoJSON upload.`);
  });
}

async function createAoiFromKmlUpload() {
  await uploadAoiFromFile(".kml,application/vnd.google-earth.kml+xml,application/xml,text/xml", async (file, text) => {
    const defaultPrefix = file.name.replace(/\.[^.]+$/, "");
    const imported = await backendApi("/api/v1/aois/kml/import", {
      method: "POST",
      body: { kml: text, default_name_prefix: defaultPrefix }
    });
    await loadAoiCatalogToMap();
    const createdList = Array.isArray(imported.created) ? imported.created : [];
    if (createdList.length > 0) {
      const first = createdList[0];
      workflowState.selectedAoiId = first.id;
      workflowState.selectedAoiName = first.name;
    } else {
      workflowState.selectedAoiId = null;
      workflowState.selectedAoiName = null;
    }
    workflowState.selectedProcessAreaId = null;
    workflowState.selectedProcessAreaName = null;
    updateWorkflowSelectionLabels();
    updateWorkflowPanelVisibility();
    styleAoiEntities();
    const skippedCount = Number(imported.skipped_count || 0);
    appendWorkflowLog(
      `KML import complete: created ${imported.created_count || 0}/${imported.discovered || 0} AOIs` +
      (skippedCount > 0 ? ` (skipped ${skippedCount})` : "") +
      "."
    );
  });
}

function updateWorkflowPanelVisibility() {
  const panel = document.getElementById("workflow_panel");
  if (!panel) {
    return;
  }
  const hasAoi = !!workflowState.selectedAoiId;
  const hasPa = !!workflowState.selectedProcessAreaId;
  const aoiOps = document.getElementById("wf_aoi_ops_section");
  const paOps = document.getElementById("wf_pa_ops_section");
  const activity = document.getElementById("wf_activity_section");
  panel.style.display = hasAoi || hasPa ? "block" : "none";
  if (aoiOps) {
    aoiOps.style.display = hasAoi && !hasPa ? "block" : "none";
  }
  if (paOps) {
    paOps.style.display = hasPa ? "block" : "none";
  }
  if (activity) {
    activity.style.display = hasAoi || hasPa ? "block" : "none";
  }
}

function hideProcessAreaLayer() {
  if (workflowState.processAreaDataSource) {
    cesiumViewer.dataSources.remove(workflowState.processAreaDataSource, true);
    workflowState.processAreaDataSource = null;
  }
}

async function refreshServerMonitor() {
  const statusEl = document.getElementById("top_server_status_btn");
  const connEl = document.getElementById("sv_connection_status");
  const taskEl = document.getElementById("sv_task_summary");
  try {
    await backendApi("/api/v1/health");
    if (statusEl) {
      statusEl.textContent = "Server: Online";
      statusEl.style.background = "rgba(46, 125, 50, 0.35)";
      statusEl.style.borderColor = "rgba(102, 187, 106, 0.8)";
    }
    if (connEl) {
      connEl.textContent = "Connected";
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = "Server: Offline";
      statusEl.style.background = "rgba(120, 120, 120, 0.35)";
      statusEl.style.borderColor = "rgba(170, 170, 170, 0.8)";
    }
    if (connEl) {
      connEl.textContent = "Disconnected";
    }
    if (taskEl) {
      taskEl.textContent = "No task data available (backend offline).";
    }
    return;
  }
  if (!taskEl) {
    return;
  }
  const queueRunning = !!workflowState.latestQueueOverview?.service?.running;
  const queueText = queueRunning ? "Queue: running" : "Queue: stopped";
  if (!workflowState.selectedProcessAreaId) {
    taskEl.textContent = `${queueText} | No process area selected.`;
    return;
  }
  const dl = workflowState.latestDownloadStatus;
  const ept = workflowState.latestEptStatus;
  const dlText = dl
    ? `Download: ${dl.status} (${dl.files_completed}/${dl.files_total})`
    : "Download: n/a";
  const eptJob = ept && ept.latest_job ? ept.latest_job : null;
  const eptText = eptJob
    ? `EPT: ${eptJob.status} (${eptJob.stage || "n/a"})`
    : `EPT: ${ept && ept.ept_ready ? "Ready" : "n/a"}`;
  taskEl.textContent = `${queueText} | ${dlText} | ${eptText}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatQueueStepStatus(step, row) {
  if (step === "download") {
    const raw = row?.download?.status || "NotStarted";
    if (raw === "Downloaded") {
      return "LAZ Downloaded";
    }
    if (raw === "Downloading") {
      return "LAZ Downloading";
    }
    if (raw === "Queued") {
      return "LAZ Queued";
    }
    if (raw === "Paused") {
      return "LAZ Paused";
    }
    if (raw === "Error") {
      return "LAZ Error";
    }
    if (raw === "Incomplete") {
      return "LAZ Incomplete";
    }
    return "LAZ Not Started";
  }
  if (step === "ept") {
    if (row?.ept?.ready) {
      return "EPT Ready";
    }
    const raw = row?.ept?.status || "NotStarted";
    if (raw === "Running") {
      return "EPT Building";
    }
    if (raw === "Queued") {
      return "EPT Queued";
    }
    if (raw === "Failed") {
      return "EPT Failed";
    }
    if (raw === "Succeeded") {
      return "EPT Ready";
    }
    return "EPT Not Started";
  }
  return "n/a";
}

function queueCell(statusLabel, pct, subtitle) {
  const safeStatus = escapeHtml(statusLabel || "n/a");
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const sub = subtitle ? `<div>${escapeHtml(subtitle)}</div>` : "";
  return `
    <div class="qm_col_title">${safeStatus}</div>
    <div class="qm_progress">
      <div class="qm_progress_fill" style="width:${clamped.toFixed(1)}%;"></div>
      <div class="qm_progress_label">${clamped.toFixed(1)}%</div>
    </div>
    ${sub}
  `;
}

function renderQueueOverview(overview) {
  const container = document.getElementById("qm_table_container");
  const statusEl = document.getElementById("qm_status");
  if (!container || !statusEl) {
    return;
  }
  if (!overview || !Array.isArray(overview.groups)) {
    container.innerHTML = "";
    statusEl.textContent = "Queue unavailable.";
    return;
  }
  const service = overview.service || {};
  statusEl.textContent = service.running
    ? "Auto queue is running. Refresh every 1 second."
    : "Auto queue is stopped.";

  const blocks = [];
  const selectedAoiId = workflowState.selectedAoiId || "";
  for (const group of overview.groups) {
    const rows = Array.isArray(group.rows) ? group.rows : [];
    const rowHtml = rows.map((row) => {
      const stateClass = row.overall_state === "green"
        ? "qm_state_green"
        : row.overall_state === "yellow"
          ? "qm_state_yellow"
          : "qm_state_grey";
      const downloadSub = `${row.download.files_completed}/${row.download.files_total}`;
      const eptSub = row.ept.ready ? "ready" : (row.ept.stage || "n/a");
      const downloadStatusLabel = formatQueueStepStatus("download", row);
      const eptStatusLabel = formatQueueStepStatus("ept", row);
      return `
        <div class="qm_row ${stateClass}">
          <div>
            <div class="qm_col_title">${escapeHtml(row.display_name)}</div>
            <div>${escapeHtml(row.project || "project")} / ${escapeHtml(row.workunit || "workunit")}</div>
            <div>State: ${escapeHtml(row.status || "n/a")} ${row.is_irrelevant ? "(irrelevant)" : ""}</div>
            <div>Why: ${escapeHtml(row.why_waiting || "n/a")}</div>
          </div>
          <div>${queueCell(downloadStatusLabel, row.download.progress_pct, downloadSub)}</div>
          <div>${queueCell(eptStatusLabel, row.ept.progress_pct, eptSub)}</div>
          <div class="qm_actions">
            <button data-qm-action="toggle-irrelevant" data-pa-id="${escapeHtml(row.process_area_id)}" data-irrelevant="${row.is_irrelevant ? "0" : "1"}">${row.is_irrelevant ? "Unskip" : "Skip"}</button>
            <button data-qm-action="select-pa" data-pa-id="${escapeHtml(row.process_area_id)}">Select</button>
          </div>
        </div>
      `;
    }).join("");
    const groupSelectedClass = selectedAoiId && group.aoi_id === selectedAoiId ? "qm_group_selected" : "";
    blocks.push(`
      <div class="qm_group_header ${groupSelectedClass}" data-qm-aoi-group="${escapeHtml(group.aoi_id)}">
        <div>${escapeHtml(group.aoi_name)} (${rows.length})</div>
        <div>
          <button data-qm-action="move-aoi" data-aoi-id="${escapeHtml(group.aoi_id)}" data-dir="top">AOI Top</button>
          <button data-qm-action="move-aoi" data-aoi-id="${escapeHtml(group.aoi_id)}" data-dir="up">AOI Up</button>
          <button data-qm-action="move-aoi" data-aoi-id="${escapeHtml(group.aoi_id)}" data-dir="down">AOI Down</button>
          <button data-qm-action="move-aoi" data-aoi-id="${escapeHtml(group.aoi_id)}" data-dir="bottom">AOI Bottom</button>
        </div>
      </div>
      <div class="qm_rows">${rowHtml || "<div class='qm_row qm_state_grey'>No process areas.</div>"}</div>
    `);
  }
  container.innerHTML = blocks.join("") || "<div class='qm_row qm_state_grey'>Queue is empty.</div>";
  scrollQueueToSelectedAoi();
}

function scrollQueueToSelectedAoi() {
  const selectedAoiId = workflowState.selectedAoiId;
  if (!selectedAoiId) {
    return;
  }
  const container = document.getElementById("qm_table_container");
  if (!container) {
    return;
  }
  const target = container.querySelector(`[data-qm-aoi-group="${selectedAoiId}"]`);
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function summarizeQueueGenerationResult(result) {
  if (!result || typeof result !== "object") {
    return "PA generation log unavailable.";
  }
  const requested = Number(result.requested_aois || 0);
  const generated = Number(result.generated || 0);
  const failed = Number(result.failed_aois || 0);
  return `PA generation: requested ${requested}, created ${generated}, failed AOIs ${failed}.`;
}

function renderQueueGenerationLog(result) {
  const el = document.getElementById("qm_generation_log");
  if (!el) {
    return;
  }
  if (!result || typeof result !== "object") {
    el.textContent = "PA generation log: unavailable.";
    return;
  }
  const lines = [summarizeQueueGenerationResult(result)];
  const details = Array.isArray(result.details) ? result.details : [];
  if (details.length === 0) {
    lines.push("No AOI-level detail yet.");
  } else {
    for (const detail of details.slice(0, 40)) {
      if (detail.status === "error") {
        lines.push(`ERROR ${detail.aoi_name || detail.aoi_id}: ${detail.error || "unknown error"}`);
      } else {
        lines.push(
          `OK ${detail.aoi_name || detail.aoi_id}: discovered ${detail.discovered || 0}, created ${detail.created || 0}`
        );
      }
    }
  }
  el.textContent = lines.join("\n");
}

async function refreshQueueOverview() {
  const overview = await backendApi("/api/v1/queue/overview");
  workflowState.latestQueueOverview = overview;
  renderQueueOverview(overview);
  try {
    const lastRun = await backendApi("/api/v1/queue/generate-missing-pas/last-run");
    renderQueueGenerationLog(lastRun);
  } catch (error) {
    renderQueueGenerationLog(null);
  }
  refreshServerMonitor().catch(() => {});
}

function stopQueuePolling() {
  if (workflowState.queuePollTimer) {
    clearInterval(workflowState.queuePollTimer);
    workflowState.queuePollTimer = null;
  }
}

function startQueuePolling() {
  stopQueuePolling();
  workflowState.queuePollTimer = setInterval(() => {
    refreshQueueOverview().catch((error) => {
      const statusEl = document.getElementById("qm_status");
      if (statusEl) {
        statusEl.textContent = `Queue refresh failed: ${error.message}`;
      }
    });
  }, 1000);
}

function getPropertyValue(entity, key) {
  if (!entity || !entity.properties || !entity.properties[key]) {
    return null;
  }
  const prop = entity.properties[key];
  if (prop && typeof prop.getValue === "function") {
    return prop.getValue(Cesium.JulianDate.now());
  }
  return prop;
}

async function backendApi(path, options = {}) {
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

function appendWorkflowLog(message, level = "info") {
  const timestamp = new Date().toLocaleTimeString();
  workflowState.logs.unshift(`[${timestamp}] ${level.toUpperCase()} ${message}`);
  workflowState.logs = workflowState.logs.slice(0, 20);
  const logEl = document.getElementById("workflow_log");
  if (logEl) {
    logEl.textContent = workflowState.logs.join("\n");
  }
}

function setWorkflowActionStatus(message, isError = false) {
  const el = document.getElementById("wf_action_status");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.style.background = isError ? "rgba(211, 47, 47, 0.25)" : "rgba(255, 255, 255, 0.08)";
}

function setWorkflowBusy(busy, message) {
  workflowState.busy = busy;
  if (message) {
    setWorkflowActionStatus(message, false);
  }
  updateWorkflowButtons();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

function updateWorkflowSelectionLabels() {
  setText("wf_selected_aoi", workflowState.selectedAoiName || "None");
  setText("wf_selected_process_area", workflowState.selectedProcessAreaName || "None");
}

function updateWorkflowButtons() {
  const hasAoi = !!workflowState.selectedAoiId;
  const hasArea = !!workflowState.selectedProcessAreaId;
  const isBusy = workflowState.busy;
  const processStatus = workflowState.latestDownloadStatus?.status;
  const eptReady = !!workflowState.latestEptStatus?.ept_ready;
  const allowEpt = processStatus === "Downloaded" || processStatus === "ProcessingEPT" || processStatus === "Ready";
  const primaryLabel = processStatus === "Paused" ? "Resume Download" : "Start Download";
  const canStartOrResume = hasArea && !isBusy && (
    !processStatus ||
    processStatus === "NotStarted" ||
    processStatus === "Incomplete" ||
    processStatus === "Error" ||
    processStatus === "Paused"
  );
  const showPause = processStatus === "Downloading" || processStatus === "Queued";
  const buttonRules = {
    wf_create_aoi_btn: !isBusy,
    wf_reload_aoi_btn: !isBusy,
    wf_create_process_areas_btn: hasAoi && !isBusy,
    wf_show_process_areas_btn: hasAoi && !isBusy,
    wf_rename_aoi_btn: hasAoi && !isBusy,
    wf_delete_aoi_btn: hasAoi && !isBusy,
    wf_download_primary_btn: canStartOrResume,
    wf_download_toggle_btn: hasArea && !isBusy && showPause,
    wf_integrity_btn: hasArea && !isBusy,
    wf_ept_build_btn: hasArea && allowEpt && !isBusy && !eptReady
  };
  Object.entries(buttonRules).forEach(([id, enabled]) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = !enabled;
    }
  });
  const primaryBtn = document.getElementById("wf_download_primary_btn");
  if (primaryBtn) {
    primaryBtn.textContent = primaryLabel;
  }
  const toggleBtn = document.getElementById("wf_download_toggle_btn");
  if (toggleBtn) {
    toggleBtn.textContent = "Pause Download";
    toggleBtn.style.display = showPause ? "inline-block" : "none";
  }
  const eptBtn = document.getElementById("wf_ept_build_btn");
  if (eptBtn) {
    eptBtn.textContent = eptReady ? "EPT Ready" : "Process EPT";
  }
}

function formatDownloadStatus(status) {
  if (!status) {
    return {
      text: "Download status: n/a\nFiles: n/a\nSpeed: n/a\nSize: n/a\nETA: n/a",
      badgeLabel: "N/A",
      badgeClass: "wf_status_default"
    };
  }
  const statusLabel = status.status === "Downloaded" ? "Complete" : status.status;
  const speed = typeof status.download_speed_mbps === "number"
    ? `${status.download_speed_mbps.toFixed(2)} MB/s`
    : "n/a";
  const active = status.active_file_downloads ?? status.files_downloading ?? 0;
  const downloadedMb = typeof status.downloaded_mb === "number" ? status.downloaded_mb.toFixed(2) : "n/a";
  const totalMb = typeof status.estimated_total_mb === "number" ? status.estimated_total_mb.toFixed(2) : "n/a";
  const etaSeconds = status.estimated_eta_seconds;
  let etaText = "ETA: n/a";
  if (typeof etaSeconds === "number" && Number.isFinite(etaSeconds)) {
    const totalSeconds = Math.max(0, Math.round(etaSeconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      etaText = `ETA: ${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      etaText = `ETA: ${minutes}m ${seconds}s`;
    } else {
      etaText = `ETA: ${seconds}s`;
    }
  }
  let badgeClass = "wf_status_default";
  if (statusLabel === "Complete") {
    badgeClass = "wf_status_complete";
  } else if (statusLabel === "Downloading" || statusLabel === "Queued") {
    badgeClass = "wf_status_downloading";
  } else if (statusLabel === "Paused") {
    badgeClass = "wf_status_paused";
  } else if (statusLabel === "Error") {
    badgeClass = "wf_status_error";
  }

  return {
    text: [
    `Download status: ${statusLabel} (${active})`,
    `Files: ${status.files_completed}/${status.files_total} (failed ${status.files_failed})`,
    `Speed: ${speed}`,
    `Size: downloaded ${downloadedMb} MB/total ${totalMb} MB`,
    etaText,
    ].join("\n"),
    badgeLabel: statusLabel,
    badgeClass
  };
}

function formatIntegrityStatus(status) {
  if (!status) {
    return "Integrity: n/a";
  }
  const latest = status.latest_job;
  return [
    `Integrity latest: ${latest ? latest.status : "none"}`,
    `Stage: ${latest && latest.stage ? latest.stage : "n/a"}`,
    `Report: ${status.report_exists ? "present" : "not generated"}`
  ].join("\n");
}

function formatEptStatus(status) {
  if (!status) {
    return "EPT: n/a";
  }
  const latest = status.latest_job;
  const progress = latest && typeof latest.progress_pct === "number"
    ? `${latest.progress_pct.toFixed(1)}%`
    : "n/a";
  const elapsed = Number.isFinite(status.elapsed_seconds)
    ? `${Math.floor(status.elapsed_seconds / 60)}m ${status.elapsed_seconds % 60}s`
    : "n/a";
  const tail = Array.isArray(status.log_tail) ? status.log_tail.slice(-3) : [];
  return [
    `EPT latest: ${latest ? latest.status : "none"}`,
    `Stage: ${latest && latest.stage ? latest.stage : "n/a"}`,
    `Progress: ${progress}`,
    `Elapsed: ${elapsed}`,
    `Ready: ${status.ept_ready ? "yes" : "no"}`,
    ...(tail.length ? ["Log:", ...tail.map((line) => `- ${line}`)] : [])
  ].join("\n");
}

function updateStatusCards() {
  const downloadCard = document.getElementById("wf_download_status");
  const download = formatDownloadStatus(workflowState.latestDownloadStatus);
  if (downloadCard) {
    const lines = download.text.split("\n");
    const first = lines.shift() || "Download status: n/a";
    const escaped = (value) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const body = lines.map((line) => escaped(line)).join("<br>");
    downloadCard.innerHTML = `<span>${escaped(first)}</span><span class="wf_status_badge ${download.badgeClass}">${escaped(download.badgeLabel)}</span><br>${body}`;
  }
  setText("wf_integrity_status", formatIntegrityStatus(workflowState.latestIntegrityStatus));
  setText("wf_ept_status", formatEptStatus(workflowState.latestEptStatus));
}

function tagEntityForWorkflow(entity, type, id, name) {
  if (!entity.properties) {
    entity.properties = new Cesium.PropertyBag({});
  }
  if (!entity.properties._workflowType) {
    entity.properties.addProperty("_workflowType");
  }
  if (!entity.properties._workflowId) {
    entity.properties.addProperty("_workflowId");
  }
  if (!entity.properties._workflowName) {
    entity.properties.addProperty("_workflowName");
  }
  entity.properties._workflowType = type;
  entity.properties._workflowId = id;
  entity.properties._workflowName = name;
}

function styleAoiEntities() {
  if (!workflowState.aoiDataSource) {
    return;
  }
  const selectedId = workflowState.selectedAoiId;
  const now = Cesium.JulianDate.now();
  const entities = workflowState.aoiDataSource.entities.values;
  for (const entity of entities) {
    if (!entity.polygon) {
      continue;
    }
    const entityId = getPropertyValue(entity, "_workflowId");
    const isSelected = selectedId && entityId === selectedId;
    const aggregateStatus = workflowState.aoiStatusById?.[entityId] || "NotStarted";
    let baseColor = Cesium.Color.LIGHTGRAY.withAlpha(0.38);
    let baseOutline = Cesium.Color.LIGHTGRAY.withAlpha(1.0);
    if (aggregateStatus === "Ready") {
      baseColor = Cesium.Color.LIME.withAlpha(0.34);
      baseOutline = Cesium.Color.LIME.withAlpha(1.0);
    } else if (aggregateStatus === "NoPAs") {
      baseColor = Cesium.Color.ORANGE.withAlpha(0.36);
      baseOutline = Cesium.Color.ORANGE.withAlpha(1.0);
    } else if (aggregateStatus === "InProgress") {
      baseColor = Cesium.Color.YELLOW.withAlpha(0.34);
      baseOutline = Cesium.Color.YELLOW.withAlpha(1.0);
    }
    entity.polygon.material = isSelected
      ? Cesium.Color.CYAN.withAlpha(0.45)
      : baseColor;
    // Avoid Cesium polygon-outline geometry path (can crash on tiny/degenerate edges).
    entity.polygon.outline = false;
    entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
    const hierarchy = entity.polygon.hierarchy && typeof entity.polygon.hierarchy.getValue === "function"
      ? entity.polygon.hierarchy.getValue(now)
      : null;
    const positions = hierarchy && Array.isArray(hierarchy.positions) ? hierarchy.positions : null;
    if (positions && positions.length >= 3) {
      entity.polyline = {
        positions: positions,
        clampToGround: true,
        width: isSelected ? 4 : 3,
        material: isSelected ? Cesium.Color.CYAN.withAlpha(1.0) : baseOutline,
      };
    }

    const center = polygonCenterCartesian(entity, now);
    if (center) {
      entity.position = center;
      const labelText = (getPropertyValue(entity, "_workflowName") || entity.name || "AOI").toString();
      entity.label = {
        text: labelText,
        font: "11px sans-serif",
        scale: isSelected ? 0.95 : 0.85,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: isSelected ? Cesium.Color.CYAN : Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      };
    }
  }
}

function polygonCenterCartesian(entity, when) {
  if (!entity || !entity.polygon || !entity.polygon.hierarchy || typeof entity.polygon.hierarchy.getValue !== "function") {
    return null;
  }
  const hierarchy = entity.polygon.hierarchy.getValue(when);
  const positions = hierarchy && Array.isArray(hierarchy.positions) ? hierarchy.positions : null;
  if (!positions || positions.length < 3) {
    return null;
  }
  let lonSum = 0;
  let latSum = 0;
  let count = 0;
  for (const position of positions) {
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    if (!cartographic) {
      continue;
    }
    lonSum += cartographic.longitude;
    latSum += cartographic.latitude;
    count += 1;
  }
  if (count === 0) {
    return null;
  }
  return Cesium.Cartesian3.fromRadians(lonSum / count, latSum / count, 0);
}

async function refreshAoiAggregateStatuses() {
  const statusById = {};
  try {
    const overview = await backendApi("/api/v1/queue/overview");
    const groups = Array.isArray(overview?.groups) ? overview.groups : [];
    for (const group of groups) {
      const rows = Array.isArray(group.rows) ? group.rows : [];
      if (!group.aoi_id) {
        continue;
      }
      if (rows.length === 0) {
        statusById[group.aoi_id] = "NotStarted";
        continue;
      }
      let hasReady = false;
      let hasInProgress = false;
      for (const row of rows) {
        const status = (row?.status || "").toString();
        if (status === "Ready") {
          hasReady = true;
          continue;
        }
        if (
          status === "Downloaded" ||
          status === "ProcessingEPT" ||
          status === "Downloading" ||
          status === "Queued" ||
          status === "Paused" ||
          status === "Incomplete"
        ) {
          hasInProgress = true;
        }
      }
      statusById[group.aoi_id] = hasReady ? "Ready" : (hasInProgress ? "InProgress" : "NotStarted");
    }
  } catch (error) {
    // Non-fatal fallback: AOIs default to neutral style when status aggregation fails.
  }
  workflowState.aoiStatusById = statusById;
}

function styleProcessAreaEntities() {
  if (!workflowState.processAreaDataSource) {
    return;
  }
  const selectedId = workflowState.selectedProcessAreaId;
  const entities = workflowState.processAreaDataSource.entities.values;
  for (const entity of entities) {
    if (!entity.polygon) {
      continue;
    }
    const entityId = getPropertyValue(entity, "_workflowId");
    const isSelected = selectedId && entityId === selectedId;
    const status = (getPropertyValue(entity, "status") || "").toString();
    let baseColor = Cesium.Color.ORANGE.withAlpha(0.22);
    let baseOutline = Cesium.Color.ORANGE.withAlpha(0.8);
    if (status === "Ready") {
      baseColor = Cesium.Color.LIME.withAlpha(0.24);
      baseOutline = Cesium.Color.LIME.withAlpha(0.9);
    } else if (status === "Downloaded" || status === "ProcessingEPT") {
      baseColor = Cesium.Color.YELLOW.withAlpha(0.24);
      baseOutline = Cesium.Color.YELLOW.withAlpha(0.9);
    } else if (status === "NotStarted") {
      baseColor = Cesium.Color.LIGHTGRAY.withAlpha(0.24);
      baseOutline = Cesium.Color.LIGHTGRAY.withAlpha(0.85);
    }
    entity.polygon.material = isSelected
      ? Cesium.Color.CYAN.withAlpha(0.5)
      : baseColor;
    // Keep fill-based styling only; disable polygon outline to avoid render crash path.
    entity.polygon.outline = false;
    entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
  }
}

async function loadAoiCatalogToMap() {
  await refreshAoiAggregateStatuses();
  const catalog = await backendApi("/api/v1/catalog/aois.geojson");
  if (catalog && Array.isArray(catalog.features)) {
    for (const feature of catalog.features) {
      const id = feature && feature.id;
      if (!id) {
        continue;
      }
      if (!workflowState.aoiStatusById[id]) {
        workflowState.aoiStatusById[id] = "NoPAs";
      }
    }
  }
  const ds = await Cesium.GeoJsonDataSource.load(catalog, { clampToGround: true });
  ds.name = "Backend AOIs";
  ds.show = workflowState.aoiVisible;
  const entities = ds.entities.values;
  for (const entity of entities) {
    const id = entity.id;
    const name = entity.name || `AOI ${id}`;
    tagEntityForWorkflow(entity, "aoi", id, name);
  }
  if (workflowState.aoiDataSource) {
    cesiumViewer.dataSources.remove(workflowState.aoiDataSource, true);
  }
  workflowState.aoiDataSource = ds;
  cesiumViewer.dataSources.add(ds);
  styleAoiEntities();
  appendWorkflowLog(`Loaded ${entities.length} AOI feature(s).`);
}

async function showProcessAreasForSelectedAoi() {
  if (!workflowState.selectedAoiId) {
    throw new Error("Select an AOI first.");
  }
  const processAreas = await backendApi(`/api/v1/aois/${workflowState.selectedAoiId}/process-areas`);
  const featureCollection = {
    type: "FeatureCollection",
    features: processAreas
      .filter((item) => item.geometry_geojson)
      .map((item) => ({
        type: "Feature",
        id: item.id,
        geometry: item.geometry_geojson,
        properties: {
          id: item.id,
          name: `${workflowState.selectedAoiName || "AOI"} - ${item.project || "project"}/${item.workunit || "workunit"}`,
          status: item.status,
          aoi_id: item.aoi_id,
          project: item.project,
          workunit: item.workunit
        }
      }))
  };
  const ds = await Cesium.GeoJsonDataSource.load(featureCollection, { clampToGround: true });
  ds.name = "AOI Process Areas";
  for (const entity of ds.entities.values) {
    const id = getPropertyValue(entity, "id") || entity.id;
    const name = getPropertyValue(entity, "name") || entity.name || id;
    tagEntityForWorkflow(entity, "process_area", id, name);
    entity.name = name;
  }
  if (workflowState.processAreaDataSource) {
    cesiumViewer.dataSources.remove(workflowState.processAreaDataSource, true);
  }
  workflowState.processAreaDataSource = ds;
  cesiumViewer.dataSources.add(ds);
  styleAoiEntities();
  styleProcessAreaEntities();
  appendWorkflowLog(`Rendered ${ds.entities.values.length} process area(s).`);
}

async function runWorkflowAction(name, fn) {
  try {
    setWorkflowBusy(true, `${name}...`);
    appendWorkflowLog(`${name} started.`);
    await fn();
    setWorkflowActionStatus(`${name} completed.`);
    appendWorkflowLog(`${name} completed.`);
  } catch (error) {
    console.error(error);
    setWorkflowActionStatus(`${name} failed: ${error.message}`, true);
    appendWorkflowLog(`${name} failed: ${error.message}`, "error");
  } finally {
    setWorkflowBusy(false);
    refreshServerMonitor().catch(() => {});
  }
}

async function refreshProcessAreaStatus() {
  if (!workflowState.selectedProcessAreaId) {
    workflowState.latestDownloadStatus = null;
    workflowState.latestIntegrityStatus = null;
    workflowState.latestEptStatus = null;
    updateStatusCards();
    updateWorkflowButtons();
    return;
  }
  const areaId = workflowState.selectedProcessAreaId;
  const [downloadStatus, integrityStatus, eptStatus] = await Promise.all([
    backendApi(`/api/v1/process-areas/${areaId}/download/status`),
    backendApi(`/api/v1/process-areas/${areaId}/integrity/status`),
    backendApi(`/api/v1/process-areas/${areaId}/ept/status`)
  ]);
  workflowState.latestDownloadStatus = downloadStatus;
  workflowState.latestIntegrityStatus = integrityStatus;
  workflowState.latestEptStatus = eptStatus;
  updateStatusCards();
  updateWorkflowButtons();
  refreshServerMonitor().catch(() => {});
}

function stopWorkflowPolling() {
  if (workflowState.pollTimer) {
    clearInterval(workflowState.pollTimer);
    workflowState.pollTimer = null;
  }
}

function startWorkflowPolling() {
  stopWorkflowPolling();
  workflowState.pollTimer = setInterval(() => {
    refreshProcessAreaStatus().catch((error) => {
      appendWorkflowLog(`Polling error: ${error.message}`, "error");
    });
  }, 1500);
}

function onWorkflowEntitySelected(entity) {
  const type = getPropertyValue(entity, "_workflowType");
  const id = getPropertyValue(entity, "_workflowId");
  const name = getPropertyValue(entity, "_workflowName") || entity.name;
  if (type === "aoi") {
    workflowState.selectedAoiId = id;
    workflowState.selectedAoiName = name;
    workflowState.selectedProcessAreaId = null;
    workflowState.selectedProcessAreaName = null;
    hideProcessAreaLayer();
    workflowState.latestDownloadStatus = null;
    workflowState.latestIntegrityStatus = null;
    workflowState.latestEptStatus = null;
    stopWorkflowPolling();
    updateStatusCards();
    appendWorkflowLog(`Selected AOI ${name}.`);
  } else if (type === "process_area") {
    workflowState.selectedProcessAreaId = id;
    workflowState.selectedProcessAreaName = name;
    const processAreaAoiId = getPropertyValue(entity, "aoi_id");
    if (processAreaAoiId) {
      workflowState.selectedAoiId = processAreaAoiId;
    }
    appendWorkflowLog(`Selected process area ${name}.`);
    startWorkflowPolling();
    refreshProcessAreaStatus().catch((error) => appendWorkflowLog(error.message, "error"));
  }
  updateWorkflowSelectionLabels();
  updateWorkflowPanelVisibility();
  styleAoiEntities();
  styleProcessAreaEntities();
  updateWorkflowButtons();
  if (workflowState.queuePanelOpen) {
    refreshQueueOverview().catch(() => {});
  }
  refreshServerMonitor().catch(() => {});
}

function initWorkflowPanel() {
  const createAoiBtn = document.getElementById("wf_create_aoi_btn");
  const reloadAoiBtn = document.getElementById("wf_reload_aoi_btn");
  const createProcessBtn = document.getElementById("wf_create_process_areas_btn");
  const showProcessBtn = document.getElementById("wf_show_process_areas_btn");
  const renameAoiBtn = document.getElementById("wf_rename_aoi_btn");
  const deleteAoiBtn = document.getElementById("wf_delete_aoi_btn");
  const downloadPrimaryBtn = document.getElementById("wf_download_primary_btn");
  const downloadToggleBtn = document.getElementById("wf_download_toggle_btn");
  const integrityBtn = document.getElementById("wf_integrity_btn");
  const eptBuildBtn = document.getElementById("wf_ept_build_btn");
  const toggleAoisBtn = document.getElementById("top_toggle_aois_btn");
  const drawAoiTopBtn = document.getElementById("top_draw_aoi_btn");
  const uploadAoiTopBtn = document.getElementById("top_upload_aoi_btn");
  const queueManagerBtn = document.getElementById("top_queue_manager_btn");
  const queueWindow = document.getElementById("queue_manager_window");
  const queueCloseBtn = document.getElementById("qm_close_btn");
  const queueGenerateBtn = document.getElementById("qm_generate_btn");
  const queueStartBtn = document.getElementById("qm_start_btn");
  const queueStopBtn = document.getElementById("qm_stop_btn");
  const queueRefreshBtn = document.getElementById("qm_refresh_btn");
  const queueTable = document.getElementById("qm_table_container");

  if (!createAoiBtn || !reloadAoiBtn) {
    return;
  }

  if (toggleAoisBtn) {
    toggleAoisBtn.addEventListener("click", () => {
      setAoiVisibility(!workflowState.aoiVisible);
      appendWorkflowLog(`AOIs ${workflowState.aoiVisible ? "shown" : "hidden"}.`);
    });
    setAoiVisibility(workflowState.aoiVisible);
  }

  if (drawAoiTopBtn) {
    drawAoiTopBtn.addEventListener("click", async () => {
      if (!workflowState.aoiVisible) {
        setWorkflowActionStatus("Enable AOIs first to draw a new AOI.", true);
        return;
      }
      try {
        startAoiDrawMode();
      } catch (error) {
        setWorkflowActionStatus(`Draw AOI failed: ${error.message}`, true);
        appendWorkflowLog(`Draw AOI failed: ${error.message}`, "error");
      }
    });
  }

  if (uploadAoiTopBtn) {
    uploadAoiTopBtn.addEventListener("click", async () => {
      if (!workflowState.aoiVisible) {
        setWorkflowActionStatus("Enable AOIs first to upload AOIs.", true);
        return;
      }
      const choice = window.prompt(
        "Upload AOIs:\n1) Upload GeoJSON\n2) Upload KML\nEnter 1 or 2",
        "2"
      );
      if (!choice) {
        return;
      }
      const normalized = choice.trim();
      try {
        if (normalized === "1") {
          await createAoiFromGeoJsonUpload();
        } else if (normalized === "2") {
          await createAoiFromKmlUpload();
        } else {
          setWorkflowActionStatus("Invalid AOI upload choice.", true);
          return;
        }
        await refreshQueueOverview().catch(() => {});
      } catch (error) {
        setWorkflowActionStatus(`Upload AOIs failed: ${error.message}`, true);
        appendWorkflowLog(`Upload AOIs failed: ${error.message}`, "error");
      }
    });
  }

  if (queueManagerBtn && queueWindow) {
    queueManagerBtn.addEventListener("click", async () => {
      workflowState.queuePanelOpen = !workflowState.queuePanelOpen;
      queueWindow.style.display = workflowState.queuePanelOpen ? "block" : "none";
      if (workflowState.queuePanelOpen) {
        await refreshQueueOverview();
        startQueuePolling();
      } else if (!workflowState.latestQueueOverview?.service?.running) {
        stopQueuePolling();
      }
    });
  }
  if (queueCloseBtn && queueWindow) {
    queueCloseBtn.addEventListener("click", () => {
      workflowState.queuePanelOpen = false;
      queueWindow.style.display = "none";
      if (!workflowState.latestQueueOverview?.service?.running) {
        stopQueuePolling();
      }
    });
  }
  if (queueGenerateBtn) {
    queueGenerateBtn.addEventListener("click", async () => {
      const statusEl = document.getElementById("qm_status");
      if (statusEl) {
        statusEl.textContent = "Generating PAs for AOIs... this may take a while.";
      }
      renderQueueGenerationLog({
        requested_aois: 0,
        generated: 0,
        failed_aois: 0,
        details: [{ status: "ok", aoi_name: "Running", discovered: 0, created: 0 }],
      });
      const result = await backendApi("/api/v1/queue/generate-missing-pas", { method: "POST", body: {} });
      await refreshQueueOverview();
      appendWorkflowLog(summarizeQueueGenerationResult(result));
      renderQueueGenerationLog(result);
      const details = Array.isArray(result?.details) ? result.details : [];
      for (const detail of details.slice(0, 8)) {
        if (detail.status === "error") {
          appendWorkflowLog(`PA generation error for ${detail.aoi_name}: ${detail.error}`, "error");
        } else {
          appendWorkflowLog(`PA generation ${detail.aoi_name}: discovered ${detail.discovered}, created ${detail.created}`);
        }
      }
    });
  }
  if (queueStartBtn) {
    queueStartBtn.addEventListener("click", async () => {
      await backendApi("/api/v1/queue/service/start", { method: "POST", body: {} });
      await refreshQueueOverview();
      startQueuePolling();
      appendWorkflowLog("Auto queue started.");
    });
  }
  if (queueStopBtn) {
    queueStopBtn.addEventListener("click", async () => {
      await backendApi("/api/v1/queue/service/stop", { method: "POST", body: {} });
      await refreshQueueOverview();
      if (!workflowState.queuePanelOpen) {
        stopQueuePolling();
      }
      appendWorkflowLog("Auto queue stopped.");
    });
  }
  if (queueRefreshBtn) {
    queueRefreshBtn.addEventListener("click", () => {
      refreshQueueOverview().catch((error) => appendWorkflowLog(error.message, "error"));
    });
  }
  if (queueTable) {
    queueTable.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const action = target.getAttribute("data-qm-action");
      if (!action) {
        return;
      }
      try {
        if (action === "move-pa") {
          const paId = target.getAttribute("data-pa-id");
          const dir = target.getAttribute("data-dir");
          if (paId && dir) {
            await backendApi("/api/v1/queue/reorder", {
              method: "POST",
              body: { entity_type: "process_area", target_id: paId, direction: dir }
            });
          }
        } else if (action === "move-aoi") {
          const aoiId = target.getAttribute("data-aoi-id");
          const dir = target.getAttribute("data-dir");
          if (aoiId && dir) {
            await backendApi("/api/v1/queue/reorder", {
              method: "POST",
              body: { entity_type: "aoi", target_id: aoiId, direction: dir }
            });
          }
        } else if (action === "toggle-irrelevant") {
          const paId = target.getAttribute("data-pa-id");
          const next = target.getAttribute("data-irrelevant") === "1";
          if (paId) {
            await backendApi(`/api/v1/queue/${paId}/irrelevant`, {
              method: "POST",
              body: { is_irrelevant: next }
            });
          }
        } else if (action === "select-pa") {
          const paId = target.getAttribute("data-pa-id");
          if (paId) {
            workflowState.selectedProcessAreaId = paId;
            workflowState.selectedProcessAreaName = paId;
            updateWorkflowSelectionLabels();
            updateWorkflowPanelVisibility();
            startWorkflowPolling();
            await refreshProcessAreaStatus();
          }
        }
        await refreshQueueOverview();
      } catch (error) {
        appendWorkflowLog(`Queue action failed: ${error.message}`, "error");
      }
    });
  }

  createAoiBtn.addEventListener("click", () => {
    runWorkflowAction("Create AOI", async () => {
      let name = document.getElementById("wf_aoi_name").value.trim();
      const geojsonText = document.getElementById("wf_aoi_geojson").value.trim();
      if (!name) {
        const prompted = window.prompt("Name this AOI:", `AOI ${new Date().toLocaleString()}`);
        if (!prompted || !prompted.trim()) {
          throw new Error("AOI creation canceled (no name provided).");
        }
        name = prompted.trim();
      }
      if (!geojsonText) {
        throw new Error("AOI GeoJSON is required.");
      }
      let geometry;
      try {
        geometry = JSON.parse(geojsonText);
      } catch (error) {
        throw new Error("Invalid AOI GeoJSON JSON format.");
      }
      const created = await backendApi("/api/v1/aois", {
        method: "POST",
        body: { name, geometry }
      });
      workflowState.selectedAoiId = created.id;
      workflowState.selectedAoiName = created.name;
      updateWorkflowSelectionLabels();
      updateWorkflowPanelVisibility();
      await loadAoiCatalogToMap();
      styleAoiEntities();
    });
  });

  reloadAoiBtn.addEventListener("click", () => {
    runWorkflowAction("Reload AOIs", async () => {
      await loadAoiCatalogToMap();
    });
  });

  createProcessBtn.addEventListener("click", () => {
    runWorkflowAction("Create/Update Process Areas", async () => {
      if (!workflowState.selectedAoiId) {
        throw new Error("Select an AOI first.");
      }
      const preview = await backendApi(
        `/api/v1/aois/${workflowState.selectedAoiId}/process-areas/create-or-update`,
        {
          method: "POST",
          body: { force_refresh: false, preview_only: true }
        }
      );
      const wouldChange = preview.would_change_count || 0;
      const existingCount = preview.existing_count || 0;
      if (existingCount > 0 && wouldChange > 0) {
        const lines = (preview.preview || [])
          .filter((item) => item.would_change)
          .map((item) => `- ${item.project}/${item.workunit}: ${item.changed_fields.join(", ")}`);
        const confirmed = window.confirm(
          `Updating this AOI will modify ${wouldChange} existing Process Area(s):\n\n${lines.join("\n")}\n\nContinue?`
        );
        if (!confirmed) {
          appendWorkflowLog("Process area update canceled by user.");
          return;
        }
      }
      const result = await backendApi(
        `/api/v1/aois/${workflowState.selectedAoiId}/process-areas/create-or-update`,
        {
          method: "POST",
          body: { force_refresh: false, preview_only: false }
        }
      );
      appendWorkflowLog(
        `Discovery complete: discovered=${result.discovered || 0}, created=${result.created_or_updated || 0}.`
      );
      await showProcessAreasForSelectedAoi();
    });
  });

  showProcessBtn.addEventListener("click", () => {
    runWorkflowAction("Show Process Areas", async () => {
      await showProcessAreasForSelectedAoi();
    });
  });

  if (renameAoiBtn) {
    renameAoiBtn.addEventListener("click", () => {
      runWorkflowAction("Rename AOI", async () => {
        if (!workflowState.selectedAoiId) {
          throw new Error("Select an AOI first.");
        }
        const currentName = workflowState.selectedAoiName || "AOI";
        const nextName = window.prompt("New AOI name:", currentName);
        if (!nextName || !nextName.trim()) {
          throw new Error("Rename canceled (no name provided).");
        }
        await backendApi(`/api/v1/aois/${workflowState.selectedAoiId}`, {
          method: "PATCH",
          body: { name: nextName.trim() }
        });
        workflowState.selectedAoiName = nextName.trim();
        updateWorkflowSelectionLabels();
        await loadAoiCatalogToMap();
        await showProcessAreasForSelectedAoi();
      });
    });
  }

  if (deleteAoiBtn) {
    deleteAoiBtn.addEventListener("click", () => {
      runWorkflowAction("Delete AOI", async () => {
        if (!workflowState.selectedAoiId) {
          throw new Error("Select an AOI first.");
        }
        const aoiName = workflowState.selectedAoiName || workflowState.selectedAoiId;
        const confirmed = window.confirm(
          `Delete AOI \"${aoiName}\" and all related Process Areas?\n\n` +
          "This will move AOI/PA folders to storage/trash and remove them from active lists."
        );
        if (!confirmed) {
          throw new Error("Delete canceled.");
        }
        await backendApi(`/api/v1/aois/${workflowState.selectedAoiId}`, {
          method: "DELETE"
        });
        workflowState.selectedAoiId = null;
        workflowState.selectedAoiName = null;
        workflowState.selectedProcessAreaId = null;
        workflowState.selectedProcessAreaName = null;
        hideProcessAreaLayer();
        workflowState.latestDownloadStatus = null;
        workflowState.latestIntegrityStatus = null;
        workflowState.latestEptStatus = null;
        stopWorkflowPolling();
        await loadAoiCatalogToMap();
        await refreshQueueOverview().catch(() => {});
        updateWorkflowSelectionLabels();
        updateWorkflowPanelVisibility();
        updateStatusCards();
        updateWorkflowButtons();
      });
    });
  }

  downloadPrimaryBtn.addEventListener("click", () => {
    const status = workflowState.latestDownloadStatus?.status;
    const action = status === "Paused" ? "resume" : "start";
    runWorkflowAction(action === "resume" ? "Download Resume" : "Download Start", async () => {
      await backendApi(`/api/v1/process-areas/${workflowState.selectedProcessAreaId}/download/${action}`, {
        method: "POST",
        body: {}
      });
      startWorkflowPolling();
      await refreshProcessAreaStatus();
    });
  });

  downloadToggleBtn.addEventListener("click", () => {
    const current = workflowState.latestDownloadStatus?.status;
    runWorkflowAction("Download Pause", async () => {
      await backendApi(`/api/v1/process-areas/${workflowState.selectedProcessAreaId}/download/pause`, {
        method: "POST",
        body: {}
      });
      startWorkflowPolling();
      await refreshProcessAreaStatus();
    });
  });

  integrityBtn.addEventListener("click", () => {
    runWorkflowAction("Integrity Check", async () => {
      await backendApi(`/api/v1/process-areas/${workflowState.selectedProcessAreaId}/integrity/check`, {
        method: "POST",
        body: {}
      });
      startWorkflowPolling();
      await refreshProcessAreaStatus();
    });
  });

  eptBuildBtn.addEventListener("click", async () => {
    try {
      if (!workflowState.selectedProcessAreaId) {
        throw new Error("Select a process area first.");
      }
      setWorkflowBusy(true, "Queueing EPT Build...");
      appendWorkflowLog("EPT Build started.");
      await backendApi(`/api/v1/process-areas/${workflowState.selectedProcessAreaId}/ept/build`, {
        method: "POST",
        body: {}
      });
      startWorkflowPolling();
      await refreshProcessAreaStatus();
      setWorkflowActionStatus("EPT Build queued. Running in background.");
      appendWorkflowLog("EPT Build queued.");
    } catch (error) {
      console.error(error);
      setWorkflowActionStatus(`EPT Build failed: ${error.message}`, true);
      appendWorkflowLog(`EPT Build failed: ${error.message}`, "error");
    } finally {
      setWorkflowBusy(false);
    }
  });

  updateWorkflowSelectionLabels();
  updateStatusCards();
  updateWorkflowButtons();
  updateWorkflowPanelVisibility();
  refreshServerMonitor().catch(() => {});
  refreshQueueOverview()
    .then(() => {
      if (workflowState.latestQueueOverview?.service?.running) {
        startQueuePolling();
      }
    })
    .catch(() => {});
  backendApi("/api/v1/queue/generate-missing-pas/last-run")
    .then((result) => {
      if ((result?.requested_aois || 0) > 0) {
        appendWorkflowLog(summarizeQueueGenerationResult(result));
      }
    })
    .catch(() => {});
  if (!workflowState.serverMonitorTimer) {
    workflowState.serverMonitorTimer = setInterval(() => {
      refreshServerMonitor().catch(() => {});
    }, 3000);
  }
}

window.cesiumViewer = new Cesium.Viewer('cesiumContainer', {
useDefaultRenderLoop: false,
terrainProvider: await Cesium.createWorldTerrainAsync(), 
animation: false,
baseLayerPicker: false,
timeline: false,
navigationHelpButton: false,
terrainShadows: Cesium.ShadowMode.DISABLED,
// clampToGround : true,

});
cesiumViewer.camera.frustum.fov = (90*Cesium.Math.PI)/180;

// Add a floating action button that appears when an entity is selected
let floatingButton = null;

// Create the floating button once
function createFloatingButton() {
  if (floatingButton) return;
  
  floatingButton = document.createElement('div');
  floatingButton.innerHTML = `
    <button id="floating-action-btn" style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: #0078d4; 
      color: white; 
      border: none; 
      padding: 12px 20px; 
      border-radius: 8px; 
      cursor: pointer;
      font-size: 16px;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: none;
      transition: all 0.3s ease;
    ">📊 Add Point Cloud</button>
  `;
  
  // Add click handler
  const btn = floatingButton.querySelector('#floating-action-btn');
  if (btn) {
          btn.onclick = function() {
        if (cesiumViewer.selectedEntity) {

          const properties = cesiumViewer.selectedEntity.properties;
          if (properties && properties._url && properties._url._value) {
            const url = properties._url._value;
            // console.log('Found URL in properties:', url);
            window.addPC(url);
          } else {
            console.log('No URL found in properties');
            console.log('Properties object:', properties);
          }
        }
      };
  }
  
  // Add to body
  document.body.appendChild(floatingButton);
  console.log('Floating button created');
}

// Monitor entity selection
let lastSelectedEntity = null;

setInterval(() => {
  if (workflowState.drawModeActive) {
    return;
  }
  const currentEntity = cesiumViewer.selectedEntity;
  
  // Entity selection changed
  if (currentEntity !== lastSelectedEntity) {
    if (currentEntity && !lastSelectedEntity) {
      // Entity was selected
      console.log('Entity selected:', currentEntity.id);
      showFloatingButton();
      onWorkflowEntitySelected(currentEntity);
    } else if (currentEntity && lastSelectedEntity) {
      onWorkflowEntitySelected(currentEntity);
    } else if (!currentEntity && lastSelectedEntity) {
      // Entity was deselected
      console.log('Entity deselected');
      hideFloatingButton();
      workflowState.selectedAoiId = null;
      workflowState.selectedAoiName = null;
      workflowState.selectedProcessAreaId = null;
      workflowState.selectedProcessAreaName = null;
      hideProcessAreaLayer();
      workflowState.latestDownloadStatus = null;
      workflowState.latestIntegrityStatus = null;
      workflowState.latestEptStatus = null;
      stopWorkflowPolling();
      updateWorkflowSelectionLabels();
      updateWorkflowPanelVisibility();
      updateStatusCards();
      updateWorkflowButtons();
      refreshServerMonitor().catch(() => {});
    }
    lastSelectedEntity = currentEntity;
  }
}, 100);

function showFloatingButton() {
  if (!floatingButton) {
    createFloatingButton();
  }
  
  const btn = floatingButton.querySelector('#floating-action-btn');
  if (btn) {
    btn.style.display = 'block';
    btn.style.transform = 'scale(1)';
    console.log('Floating button shown');
  }
}

function hideFloatingButton() {
  if (floatingButton) {
    const btn = floatingButton.querySelector('#floating-action-btn');
    if (btn) {
      btn.style.display = 'none';
      btn.style.transform = 'scale(0.8)';
      console.log('Floating button hidden');
    }
  }
}

// Add fog at the distance so we don't see the other side of the world?
// Make a way to toggle this map.

try {
  const tileset = await Cesium.createGooglePhotorealistic3DTileset();
  cesiumViewer.scene.primitives.add(tileset);
  cesiumViewer.scene.primitives._primitives[0].show = false;
} catch (error) {
  console.log(`Error creating tileset: ${error}`);
}


// CODE THAT WILL HELP ADD WAYPOINTS

//   cesiumViewer.infoBox.frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-forms allow-scripts allow-top-navigation');

//   cesiumViewer.selectedEntity = entity;

//   var entity = cesiumViewer.entities.add({
//     name : 'Point',
//     position : Cesium.Cartesian3.fromDegrees(-100, 50),
//     point : {
//           pixelSize : 10,
//           color : Cesium.Color.RED
//       }
//   });

//   cesiumViewer.infoBox.frame.addEventListener('load', function() {
//       cesiumViewer.infoBox.frame.contentDocument.body.addEventListener('click', function(e) {
//       if (e.target && e.target.className === 'click-test-button') {
//           var LatValue = cesiumViewer.infoBox.frame.contentDocument.getElementsByName("Latitude")[0].value;
//           var LongValue = cesiumViewer.infoBox.frame.contentDocument.getElementsByName("Longitude")[0].value;
//           alert(LatValue + "\n" + LongValue);
//           }
//       }, false);
//   }, false);

//   function getValues(event) {
//       var LatValue = document.getElementsByName('Latitude')[0].value;
//       var LongValue = document.getElementsByName('Longitude')[0].value;
//       alert(LatValue + "\n" + LongValue);
    
//   }

// entity.description = '\
//     Name: <input type="text" name="Name" id="Name" value="Name"><br>\
//     Latitude: <input type="text" name="Latitude" id="Latitude" value="50"><br>\
//     Longitude: <input type="text" name="Longitude" id="Longitude" value="50"><br>\
//     <div style="padding:15px"><button class="click-test-button">\
//     Click here</button></div>';

const flags = {
looking: false,
moveForward: false,
moveBackward: false,
moveUp: false,
moveDown: false,
moveLeft: false,
moveRight: false,
Fly: false,
Speed: false,
faster: false,
toggleOther: true,
toggleGround: true,
toggleVegetation: true,
toggleLowNoise: true,
toggleAll: true,
point: false,
downloadPoints: false,
hideCesium: false,
displayCave: false,
displayPC: false,

};

var pointCounter = 0;
var creatingRoute = "";
var routePoints = [];
var currentEntity = new Cesium.Entity();

var ClassificationScheme = {
  0:       { visible: flags.toggleOther, name: 'never classified'  , color: [0.5,  0.5,  0.5,  1.0] },
  1:       { visible: flags.toggleOther, name: 'unclassified'      , color: [0.5,  0.5,  0.5,  1.0] },
  2:       { visible: flags.toggleGround, name: 'ground'            , color: [0.63, 0.32, 0.18, 1.0] },
  3:       { visible: flags.toggleVegetation, name: 'low vegetation'    , color: [0.0,  1.0,  0.0,  1.0] },
  4:       { visible: flags.toggleVegetation, name: 'medium vegetation' , color: [0.0,  0.8,  0.0,  1.0] },
  5:       { visible: flags.toggleVegetation, name: 'high vegetation'   , color: [0.0,  0.6,  0.0,  1.0] },
  6:       { visible: flags.toggleVegetation, name: 'building'          , color: [1.0,  0.66, 0.0,  1.0] },
  7:       { visible: flags.toggleLowNoise, name: 'low point(noise)'  , color: [1.0,  1.0,  1.0,  1.0] },
  8:       { visible: flags.toggleOther, name: 'key-point'         , color: [1.0,  0.0,  0.0,  1.0] },
  9:       { visible: flags.toggleOther, name: 'water'             , color: [0.0,  0.0,  1.0,  1.0] },
  12:      { visible: flags.toggleOther, name: 'overlap'           , color: [1.0,  1.0,  0.0,  1.0] },
  DEFAULT: { visible: flags.toggleOther, name: 'default'           , color: [0.4,  0.4,  0.4,  0.5] },
};
// console.log(ClassificationScheme);

window.potreeViewer = new Potree.Viewer(document.getElementById("potree_render_area"), {
  useDefaultRenderLoop: false
});
potreeViewer.setEDLEnabled(true);
potreeViewer.setEDLRadius(3.5); //2.0
potreeViewer.setEDLStrength(0.4);
potreeViewer.setFOV(60);
potreeViewer.setPointBudget(10_000_000);
potreeViewer.classifications = ClassificationScheme;
// potreeViewer.setMinNodeSize(50);
potreeViewer.loadSettingsFromURL();
potreeViewer.setBackground(null);
potreeViewer.useHQ = false;
// potreeViewer.setLengthUnit('m');
potreeViewer.setDescription("");


if (flags.displayCave){
  const promise2 = Cesium.GeoJsonDataSource.load(
    "./user_files/.geojson"
    );
    promise2
      .then(function (dataSource) {
        cesiumViewer.dataSources.add(dataSource);


      })
      .catch(function (error) {
        //Display any errrors encountered while loading.
        window.alert(error);
      });

};


Cesium.Math.setRandomNumberSeed(0);
const lidarFootprintSources = {
  usgs: null,
  backend: null
};

function setLidarFootprintsVisible(visible) {
  if (lidarFootprintSources.usgs) {
    lidarFootprintSources.usgs.show = !!visible;
  }
  if (lidarFootprintSources.backend) {
    lidarFootprintSources.backend.show = !!visible;
  }
}

const promise = Cesium.GeoJsonDataSource.load(
  ProxyUrlGenerator.generateProxyUrl("https://usgs.entwine.io/boundaries/resources.geojson")
);
promise
  .then(function (dataSource) {
    cesiumViewer.dataSources.add(dataSource);
    lidarFootprintSources.usgs = dataSource;
    dataSource.name = "USGS Entwine Boundaries";
    dataSource.show = !!viewModel.showlidar;

    //Get the array of entities
    const entities = dataSource.entities.values;

    const colorHash = {};
    for (let i = 0; i < entities.length; i++) {
      //For each entity, create a random color based on the state name.
      //Some states have multiple entities, so we store the color in a
      //hash so that we use the same color for the entire state.
      const entity = entities[i];
      const name = entity.name;
      let color = colorHash[name];
      if (!color) {
        color = Cesium.Color.fromRandom({
          alpha: 0.5,
        });
        colorHash[name] = color;
      }

      if (!entity.polygon) {
        continue;
      }
      //Set the polygon material to our random color.
      entity.polygon.material = color;
      //Remove the outlines.
      entity.polygon.outline = false;
      entity.polygon.extrudedHeight = 3000;
    }
  })
  .catch(function (error) {
    //Display any errrors encountered while loading.
    window.alert(error);
  });

if (window.serverConfig?.backend?.autoLoadCatalog) {
  const backendCatalogUrl = `${getBackendBaseUrl()}/api/v1/catalog/ept_datasets.geojson`;
  const backendCatalogPromise = Cesium.GeoJsonDataSource.load(backendCatalogUrl);
  backendCatalogPromise
    .then(function (dataSource) {
      dataSource.name = "Backend EPT Catalog";
      cesiumViewer.dataSources.add(dataSource);
      lidarFootprintSources.backend = dataSource;
      dataSource.show = !!viewModel.showlidar;
      const entities = dataSource.entities.values;
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const properties = entity.properties;
        if (properties && properties.ept_url && properties.ept_url._value) {
          const absoluteEptUrl = toAbsoluteUrl(properties.ept_url._value);
          if (absoluteEptUrl) {
            entity.properties.addProperty("_url");
            entity.properties._url = absoluteEptUrl;
          }
        }
        if (entity.polygon) {
          entity.polygon.material = Cesium.Color.CYAN.withAlpha(0.35);
          entity.polygon.outline = false;
          entity.polygon.extrudedHeight = undefined;
        }
      }
      console.log(`Loaded backend EPT catalog with ${entities.length} feature(s).`);
    })
    .catch(function (error) {
      console.warn("Failed to load backend EPT catalog:", error);
    });
}



//   const promise2 = Cesium.GeoJsonDataSource.load(
//     ProxyUrlGenerator.generateProxyUrl(
//       "https://feroz.us/RWUTS.geojson"
//     )
//   );
// promise2
//   .then(function (dataSource) {
//     cesiumViewer.dataSources.add(dataSource);

//     //Get the array of entities
    
//     dataSource.show = true;
    
//   })
//   .catch(function (error) {
//     //Display any errrors encountered while loading.
//     window.alert(error);
//   });
const scene = cesiumViewer.scene;
scene.screenSpaceCameraController.enableCollisionDetection = false;
const canvas = cesiumViewer.canvas;
canvas.setAttribute("tabindex", "0"); // needed to put focus on the canvas
canvas.onclick = function () {
canvas.focus();
};


const ellipsoid = scene.globe.ellipsoid;
scene.globe.translucency.enabled = true 
scene.globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(
400.0,
0.0,
1000.0,
1.0
);
scene.globe.translucency.frontFaceAlphaByDistance.nearValue = 0.7;
scene.globe.translucency.frontFaceAlphaByDistance.farValue = 1;
let compassRenderer = null;
let compassOverlayElement = null;
let compassLabelElement = null;
let compassScene = null;
let compassCamera = null;
let compassGroup = null;
const compassStyleGroups = {};
let compassStyleIndex = 2;
const compassStyles = [
  "needle-rose",
  "triad-gizmo",
  "orbital-rings",
  "north-beacon"
];
const enuFrameScratch = new Cesium.Matrix4();
const eastWorldScratch = new Cesium.Cartesian3();
const northWorldScratch = new Cesium.Cartesian3();
const upWorldScratch = new Cesium.Cartesian3();
const localNorthScratch = new Cesium.Cartesian3();
const localUpScratch = new Cesium.Cartesian3();
const compassNorthAxis = new THREE.Vector3();
const compassUpAxis = new THREE.Vector3();
const compassEastAxis = new THREE.Vector3();
const compassMatrix = new THREE.Matrix4();
const cardinalPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compassSizeByStyle = {
  "needle-rose": { width: 150, height: 150 },
  "triad-gizmo": { width: 140, height: 140 },
  "orbital-rings": { width: 150, height: 150 },
  "north-beacon": { width: 130, height: 130 }
};

function normalizeDegrees(value) {
  let wrapped = value % 360;
  if (wrapped < 0) {
    wrapped += 360;
  }
  return wrapped;
}

function getCardinalLabel(angleDegrees) {
  const index = Math.round(normalizeDegrees(angleDegrees) / 45) % 8;
  return cardinalPoints[index];
}

function createNeedleRoseGroup() {
  const group = new THREE.Group();

  const ringGeometry = new THREE.TorusGeometry(1.5, 0.04, 12, 48);
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: 0xdddddd,
    transparent: true,
    opacity: 0.85
  });
  group.add(new THREE.Mesh(ringGeometry, ringMaterial));

  const shaftGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 12);
  const northShaft = new THREE.Mesh(
    shaftGeometry,
    new THREE.MeshStandardMaterial({ color: 0xff2b2b })
  );
  northShaft.position.y = 0.8;
  group.add(northShaft);

  const southShaft = new THREE.Mesh(
    shaftGeometry,
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  southShaft.position.y = -0.8;
  group.add(southShaft);

  const tipGeometry = new THREE.ConeGeometry(0.14, 0.38, 16);
  const northTip = new THREE.Mesh(
    tipGeometry,
    new THREE.MeshStandardMaterial({ color: 0xff2b2b })
  );
  northTip.position.y = 1.74;
  group.add(northTip);

  const southTip = new THREE.Mesh(
    tipGeometry,
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  southTip.position.y = -1.74;
  southTip.rotation.x = Math.PI;
  group.add(southTip);

  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  group.add(hub);

  return group;
}

function createTriadGizmoGroup() {
  const group = new THREE.Group();
  const origin = new THREE.Vector3(0, 0, 0);
  group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, 2.0, 0xff2b2b, 0.45, 0.24));
  group.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, 1.6, 0x4aa3ff, 0.35, 0.2));
  group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), origin, 1.6, 0x44dd88, 0.35, 0.2));

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.45, 0.025, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  group.add(ring);

  return group;
}

function createOrbitalRingsGroup() {
  const group = new THREE.Group();

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 14),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  group.add(sphere);

  const ringMain = new THREE.Mesh(
    new THREE.TorusGeometry(1.35, 0.04, 14, 64),
    new THREE.MeshStandardMaterial({ color: 0xe5e5e5, transparent: true, opacity: 0.8 })
  );
  group.add(ringMain);

  const ringTilt = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.03, 12, 48),
    new THREE.MeshStandardMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.8 })
  );
  ringTilt.rotation.x = Math.PI / 2;
  group.add(ringTilt);

  const northArrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.48, 18),
    new THREE.MeshStandardMaterial({ color: 0xff2b2b })
  );
  northArrow.position.y = 1.72;
  group.add(northArrow);

  return group;
}

function createNorthBeaconGroup() {
  const group = new THREE.Group();
  const materialRed = new THREE.MeshStandardMaterial({ color: 0xff3a3a });
  const materialWhite = new THREE.MeshStandardMaterial({ color: 0xffffff });

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 2.3, 16),
    materialWhite
  );
  group.add(shaft);

  const northHead = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.7, 20),
    materialRed
  );
  northHead.position.y = 1.5;
  group.add(northHead);

  return group;
}

function applyCompassStyleLayout() {
  if (!compassOverlayElement || !compassRenderer) {
    return;
  }

  const styleName = compassStyles[compassStyleIndex];
  const size = compassSizeByStyle[styleName] || compassSizeByStyle["needle-rose"];
  compassOverlayElement.style.width = `${size.width}px`;
  compassOverlayElement.style.height = `${size.height}px`;
  compassRenderer.setSize(size.width, size.height, false);

  if (compassCamera) {
    compassCamera.aspect = size.width / size.height;
    compassCamera.updateProjectionMatrix();
  }
}

function setCompassStyle(styleName) {
  const nextIndex = compassStyles.indexOf(styleName);
  if (nextIndex === -1) {
    console.warn(`Unknown compass style: ${styleName}`);
    return;
  }
  compassStyleIndex = nextIndex;
  applyCompassStyleLayout();
  Object.keys(compassStyleGroups).forEach((key) => {
    compassStyleGroups[key].visible = key === styleName;
  });
  if (compassLabelElement) {
    compassLabelElement.innerText = `Style: ${styleName}`;
  }
  console.log(`Compass style: ${styleName}`);
}

function cycleCompassStyle() {
  compassStyleIndex = (compassStyleIndex + 1) % compassStyles.length;
  setCompassStyle(compassStyles[compassStyleIndex]);
}

function initNorthCompass() {
  compassOverlayElement = document.getElementById("north_compass_overlay");
  if (!compassOverlayElement) {
    console.warn("North compass overlay element was not found.");
    return;
  }
  compassOverlayElement.innerHTML = "";

  compassRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  compassRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  compassRenderer.setClearColor(0x000000, 0);
  compassOverlayElement.appendChild(compassRenderer.domElement);

  compassLabelElement = document.createElement("div");
  compassLabelElement.style.position = "absolute";
  compassLabelElement.style.left = "0";
  compassLabelElement.style.top = "-8px";
  compassLabelElement.style.width = "100%";
  compassLabelElement.style.textAlign = "center";
  compassLabelElement.style.font = "11px sans-serif";
  compassLabelElement.style.lineHeight = "1.15";
  compassLabelElement.style.color = "#d8d8d8";
  compassLabelElement.style.textShadow = "0 0 4px rgba(0,0,0,0.85)";
  compassOverlayElement.appendChild(compassLabelElement);

  compassScene = new THREE.Scene();
  compassCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  compassCamera.position.set(0, 0, 6.5);
  compassCamera.lookAt(0, 0, 0);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(4, 5, 6);
  compassScene.add(ambientLight);
  compassScene.add(keyLight);

  compassGroup = new THREE.Group();
  compassStyleGroups["needle-rose"] = createNeedleRoseGroup();
  compassStyleGroups["triad-gizmo"] = createTriadGizmoGroup();
  compassStyleGroups["orbital-rings"] = createOrbitalRingsGroup();
  compassStyleGroups["north-beacon"] = createNorthBeaconGroup();
  Object.keys(compassStyleGroups).forEach((key) => {
    compassStyleGroups[key].visible = false;
    compassGroup.add(compassStyleGroups[key]);
  });
  compassScene.add(compassGroup);

  setCompassStyle(compassStyles[compassStyleIndex]);
  window.setCompassStyle = setCompassStyle;
  window.cycleCompassStyle = cycleCompassStyle;
  console.log("Press N to cycle compass styles.");
}

function updateNorthCompass() {
  if (!compassRenderer || !compassScene || !compassCamera || !compassGroup) {
    return;
  }

  const camera = cesiumViewer.camera;
  const cameraPosition = camera.positionWC;
  const cameraDirection = camera.directionWC;
  const cameraRight = camera.rightWC;
  const cameraUp = camera.upWC;

  Cesium.Transforms.eastNorthUpToFixedFrame(
    cameraPosition,
    ellipsoid,
    enuFrameScratch
  );

  northWorldScratch.x = enuFrameScratch[4];
  northWorldScratch.y = enuFrameScratch[5];
  northWorldScratch.z = enuFrameScratch[6];
  Cesium.Cartesian3.normalize(northWorldScratch, northWorldScratch);
  eastWorldScratch.x = enuFrameScratch[0];
  eastWorldScratch.y = enuFrameScratch[1];
  eastWorldScratch.z = enuFrameScratch[2];
  Cesium.Cartesian3.normalize(eastWorldScratch, eastWorldScratch);
  upWorldScratch.x = enuFrameScratch[8];
  upWorldScratch.y = enuFrameScratch[9];
  upWorldScratch.z = enuFrameScratch[10];
  Cesium.Cartesian3.normalize(upWorldScratch, upWorldScratch);

  localNorthScratch.x = Cesium.Cartesian3.dot(northWorldScratch, cameraRight);
  localNorthScratch.y = Cesium.Cartesian3.dot(northWorldScratch, cameraUp);
  localNorthScratch.z = -Cesium.Cartesian3.dot(northWorldScratch, cameraDirection);
  localUpScratch.x = Cesium.Cartesian3.dot(upWorldScratch, cameraRight);
  localUpScratch.y = Cesium.Cartesian3.dot(upWorldScratch, cameraUp);
  localUpScratch.z = -Cesium.Cartesian3.dot(upWorldScratch, cameraDirection);

  if (
    Cesium.Cartesian3.magnitudeSquared(localNorthScratch) < 1e-8 ||
    Cesium.Cartesian3.magnitudeSquared(localUpScratch) < 1e-8
  ) {
    return;
  }

  Cesium.Cartesian3.normalize(localNorthScratch, localNorthScratch);
  Cesium.Cartesian3.normalize(localUpScratch, localUpScratch);

  compassNorthAxis.set(
    localNorthScratch.x,
    localNorthScratch.y,
    localNorthScratch.z
  );
  compassUpAxis.set(
    localUpScratch.x,
    localUpScratch.y,
    localUpScratch.z
  );
  compassEastAxis.crossVectors(compassNorthAxis, compassUpAxis);
  if (compassEastAxis.lengthSq() < 1e-8) {
    return;
  }
  compassEastAxis.normalize();
  compassNorthAxis.crossVectors(compassUpAxis, compassEastAxis).normalize();

  const styleName = compassStyles[compassStyleIndex];
  const headingRadians = Math.atan2(
    Cesium.Cartesian3.dot(cameraDirection, eastWorldScratch),
    Cesium.Cartesian3.dot(cameraDirection, northWorldScratch)
  );
  const headingDegrees = normalizeDegrees((headingRadians * 180) / Math.PI);
  const upDotDirection = Cesium.Cartesian3.dot(cameraDirection, upWorldScratch);
  const clampedUpDot = Math.max(-1, Math.min(1, upDotDirection));
  const inclinationDegrees = (Math.asin(clampedUpDot) * 180) / Math.PI;
  compassMatrix.makeBasis(compassEastAxis, compassNorthAxis, compassUpAxis);
  compassGroup.setRotationFromMatrix(compassMatrix);
  compassRenderer.render(compassScene, compassCamera);
  compassLabelElement.innerHTML =
    `${Math.round(headingDegrees)}° ${getCardinalLabel(headingDegrees)}<br>` +
    `${inclinationDegrees >= 0 ? "+" : ""}${inclinationDegrees.toFixed(1)}°`;
}

const imageryLayers = cesiumViewer.imageryLayers;

const viewModel = {
showlidar  : false,
googleMapsOn  : false,
usgsRef : false,
layers: [],
baseLayers: [],
upLayer: null,
downLayer: null,
selectedLayer: null,
isSelectableLayer: function (layer) {
  return this.baseLayers.indexOf(layer) >= 0;
},
raise: function (layer, index) {
  imageryLayers.raise(layer);
  viewModel.upLayer = layer;
  var v = (index - 1);
  if (v < 0){
    v = 0;
  }
  viewModel.downLayer = viewModel.layers[v];
  updateLayerList();
  window.setTimeout(function () {
    viewModel.upLayer = viewModel.downLayer = null;
  }, 10);
},
lower: function (layer, index) {
  imageryLayers.lower(layer);
  var v = (viewModel.layers.length - 1);
  if ((viewModel.layers.length - 1) > (index + 1)){
    v = (index + 1);
  }
  viewModel.upLayer =
    viewModel.layers[v];
  viewModel.downLayer = layer;
  updateLayerList();
  window.setTimeout(function () {
    viewModel.upLayer = viewModel.downLayer = null;
  }, 10);
},
canRaise: function (layerIndex) {
  return layerIndex > 0;
},
canLower: function (layerIndex) {
  return layerIndex >= 0 && layerIndex < imageryLayers.length - 1;
},
};
const baseLayers = viewModel.baseLayers;
const layerCatalog = [];
let miniMapMap = null;
let miniMapView = null;
let miniMapBaseLayer = null;
let miniMapAttentionLayer = null;
let miniMapAttentionSource = null;
let miniMapLabelLayer = null;
let miniMapLabelSource = null;
let miniMapCenterLayer = null;
let miniMapCenterFeature = null;
let miniMapAttentionEnabled = true;
let miniMapHoverLabelElement = null;
let miniMapVisibilityHeight = 15000;
let miniMapLastSyncTimestamp = 0;
let miniMapLastCameraPosition = null;
let miniMapLastHeading = 0;
let miniMapLastSavedAt = 0;
let miniMapLastRenderAt = 0;
let miniMapLastAttentionRenderAt = 0;
let miniMapLastLabelSyncAt = 0;
const miniMapLabelEntities = new Map();
const ATTENTION_STORAGE_KEY = "flex_minimap_attention_v1";
const ATTENTION_CELL_METERS = 15;
const ATTENTION_SAVE_INTERVAL_MS = 10000;
const ATTENTION_MAX_POINTS_RENDER = 320;
const MINIMAP_RENDER_INTERVAL_MOVING_MS = 120;
const MINIMAP_RENDER_INTERVAL_IDLE_MS = 420;
const MINIMAP_ATTENTION_RENDER_INTERVAL_MS = 900;
const MINIMAP_LABEL_SYNC_INTERVAL_MS = 1400;
const attentionGrid = {};
let attentionDirty = false;
let miniMapCurrentRadiusMeters = 500;
const ENABLE_MINIMAP_HEATMAP = false;

function proxifyOlSource(source) {
  if (!source || typeof source.getTileLoadFunction !== "function") {
    return source;
  }
  const defaultTileLoad = source.getTileLoadFunction();
  source.setTileLoadFunction((tile, src) => {
    const proxySrc = ProxyUrlGenerator.generateProxyUrl(src);
    defaultTileLoad(tile, proxySrc || src);
  });
  return source;
}

const miniMapLayerDefs = [
  {
    name: "Bing Maps Aerial",
    createSource: () =>
      proxifyOlSource(new ol.source.XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        crossOrigin: "anonymous",
        maxZoom: 19
      }))
  },
  {
    name: "OpenStreetMaps",
    createSource: () => proxifyOlSource(new ol.source.OSM())
  },
  {
    name: "Slope Angle",
    createSource: () =>
      proxifyOlSource(new ol.source.XYZ({
        url: "https://caltopo.com/tile/sg/{z}/{x}/{y}.png",
        crossOrigin: "anonymous",
        maxZoom: 18
      }))
  },
  {
    name: "US Karst Map",
    createSource: () =>
      proxifyOlSource(new ol.source.XYZ({
        url: "https://tiles.arcgis.com/tiles/hoKRg7d6zCP8hwp2/arcgis/rest/services/Carbonate_Karst/MapServer/tile/{z}/{y}/{x}?blankTile=false",
        crossOrigin: "anonymous",
        maxZoom: 18
      }))
  },
  {
    name: "NGMDB Mosaic",
    createSource: () =>
      proxifyOlSource(
        new ol.source.TileArcGISRest({
          url: "https://ngmdb-tiles.usgs.gov/arcgis/rest/services/mapview/ngmdbMosaic/ImageServer",
          params: {
            FORMAT: "jpgpng",
            F: "image"
          },
          crossOrigin: "anonymous"
        })
      )
  }
];

Cesium.knockout.track(viewModel);
function buildLayerCatalog() {
  layerCatalog.splice(0, layerCatalog.length);
  layerCatalog.push(
    {
      name: "Bing Maps Aerial",
      kind: "base",
      createProvider: () => Cesium.createWorldImageryAsync()
    },
    {
      name: "Bing Maps Road",
      kind: "base",
      createProvider: () =>
        Cesium.createWorldImageryAsync({
          style: Cesium.IonWorldImageryStyle.ROAD
        })
    },
    {
      name: "ArcGIS World Street Maps",
      kind: "base",
      createProvider: () =>
        Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer"
        )
    },
    {
      name: "OpenStreetMaps",
      kind: "base",
      createProvider: () => new Cesium.OpenStreetMapImageryProvider()
    },
    {
      name: "Stamen Maps",
      kind: "base",
      createProvider: () =>
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://stamen-tiles.a.ssl.fastly.net/watercolor/",
          fileExtension: "jpg",
          credit:
            "Map tiles by Stamen Design, under CC BY 3.0. Data by OpenStreetMap, under CC BY SA."
        })
    },
    {
      name: "Natural Earth II (local)",
      kind: "base",
      createProvider: () =>
        Cesium.TileMapServiceImageryProvider.fromUrl(
          Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
        )
    },
    {
      name: "USGS Shaded Relief (via WMTS)",
      kind: "base",
      createProvider: () =>
        new Cesium.WebMapTileServiceImageryProvider({
          url:
            "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/WMTS",
          layer: "USGSShadedReliefOnly",
          style: "default",
          format: "image/jpeg",
          tileMatrixSetID: "default028mm",
          maximumLevel: 19,
          credit: "U. S. Geological Survey"
        })
    },
    {
      name: "Slope Angle",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: ProxyUrlGenerator.generateProxyUrl(Cesium.buildModuleUrl("https://caltopo.com/tile/sg") + "/{z}/{x}/{y}.png"),
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name: "US Karst Map",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: Cesium.buildModuleUrl("https://tiles.arcgis.com/tiles/hoKRg7d6zCP8hwp2/arcgis/rest/services/Carbonate_Karst/MapServer/tile") + "/{z}/{y}/{x}?blankTile=false",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name: "OpenTopo datasets",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://portal.opentopography.org/geoserver/OPENTOPO/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image%2Fpng&TRANSPARENT=true&STYLES&LAYERS=OPENTOPO%3Adatasets_view&CQL_FILTER=is_global%20%3D%20false&SRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&BBOX={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}",
          tilingScheme: new Cesium.GeographicTilingScheme(),
          enablePickFeatures: false,
          pickFeaturesUrl: "https://portal.opentopography.org/geoserver/OPENTOPO/wms?0=C&1=Q&2=L&3=_&4=F&5=I&6=L&7=T&8=E&9=R&10=%20&11=%3D&12=%20&13=i&14=s&15=_&16=g&17=l&18=o&19=b&20=a&21=l&22=%20&23=%3D&24=%20&25=f&26=a&27=l&28=s&29=e&service=WMS&version=1.1.1&request=GetFeatureInfo&layers=OPENTOPO%3Adatasets_view&BBOX={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&width=256&height=256&srs=EPSG%3A4326&query_layers=OPENTOPO%3Adatasets_view&info_format=application%2Fjson&x={i}&y={j}",
          maximumLevel: 18
        })
    },
    {
      name: "NGMDB Mosaic",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: ProxyUrlGenerator.generateProxyUrl("https://ngmdb-tiles.usgs.gov/arcgis/rest/services/mapview/ngmdbMosaic/ImageServer/exportImage?f=image&bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&format=jpgpng&mosaicRule=%7Bascending%3Atrue%7D"),
          maximumLevel: 15
        })
    },
    {
      name: "Snow Depth",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export?bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&bboxSR=102100&imageSR=102100&format=png32&transparent=true&layers=show%3A3&f=image",
          maximumLevel: 15
        })
    },
    {
      name: "Tile Coordinates",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () => new Cesium.TileCoordinatesImageryProvider()
    }
  );
}

function setupLayers() {
  for (const layerDef of layerCatalog) {
    if (layerDef.kind === "base") {
      addBaseLayerOption(layerDef.name, layerDef.createProvider());
    } else {
      addLayerOption(
        layerDef.name,
        layerDef.createProvider(),
        layerDef.alpha,
        layerDef.show
      );
    }
  }
}
async function addBaseLayerOption(name, imageryProviderPromise) {
try {
  const imageryProvider = await Promise.resolve(
    imageryProviderPromise
  );

  const layer = new Cesium.ImageryLayer(imageryProvider);
  layer.name = name;
  baseLayers.push(layer);
  updateLayerList();
} catch (error) {
  console.error(
    `There was an error while creating ${name}. ${error}`
  );
}
}
async function addLayerOption(
name,
imageryProviderPromise,
alpha,
show
) {
try {
  const imageryProvider = await Promise.resolve(
    imageryProviderPromise
  );
  // var imageryLayer = viewer.scene.imageryLayers.addImageryProvider(imageryProvider).alpha = 0.9;
  const layer = imageryLayers.addImageryProvider(imageryProvider);
  layer.alpha = Cesium.defaultValue(alpha, 0.5);
  layer.show = Cesium.defaultValue(show, true);
  layer.name = name;
  Cesium.knockout.track(layer, ["alpha", "show", "name"]);
  updateLayerList();
} catch (error) {
  console.error(
    `There was an error while creating ${name}. ${error}`
  );
}
}


function updateLayerList() {
const numLayers = imageryLayers.length;
viewModel.layers.splice(0, viewModel.layers.length);
for (let i = numLayers - 1; i >= 0; --i) {
  viewModel.layers.push(imageryLayers.get(i));
}
// viewModel.showlidar.push();  
// console.log(cesiumViewer.dataSources);
}

function loadAttentionGrid() {
  if (!ENABLE_MINIMAP_HEATMAP) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(ATTENTION_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.grid) {
      return;
    }
    Object.assign(attentionGrid, parsed.grid);
  } catch (error) {
    console.warn("Unable to load minimap attention data.", error);
  }
}

function saveAttentionGrid(force) {
  if (!ENABLE_MINIMAP_HEATMAP) {
    return;
  }
  const now = Date.now();
  if (!force && (!attentionDirty || now - miniMapLastSavedAt < ATTENTION_SAVE_INTERVAL_MS)) {
    return;
  }
  try {
    window.localStorage.setItem(
      ATTENTION_STORAGE_KEY,
      JSON.stringify({
        savedAt: now,
        grid: attentionGrid
      })
    );
    attentionDirty = false;
    miniMapLastSavedAt = now;
  } catch (error) {
    console.warn("Unable to persist minimap attention data.", error);
  }
}

function getAttentionKey(lonDeg, latDeg) {
  const cellDeg = ATTENTION_CELL_METERS / 111320;
  const lonKey = Math.round(lonDeg / cellDeg);
  const latKey = Math.round(latDeg / cellDeg);
  return `${lonKey},${latKey}`;
}

function unpackAttentionKey(key) {
  const parts = key.split(",");
  const cellDeg = ATTENTION_CELL_METERS / 111320;
  const lon = Number(parts[0]) * cellDeg;
  const lat = Number(parts[1]) * cellDeg;
  return { lon, lat };
}

function addAttentionAt(lonDeg, latDeg, radiusMeters, amount) {
  if (!ENABLE_MINIMAP_HEATMAP) {
    return;
  }
  const radiusCells = Math.max(1, Math.ceil(radiusMeters / ATTENTION_CELL_METERS));
  for (let ix = -radiusCells; ix <= radiusCells; ix++) {
    for (let iy = -radiusCells; iy <= radiusCells; iy++) {
      const distanceMeters = Math.hypot(ix * ATTENTION_CELL_METERS, iy * ATTENTION_CELL_METERS);
      if (distanceMeters > radiusMeters) {
        continue;
      }
      const lon = lonDeg + (ix * ATTENTION_CELL_METERS) / 111320;
      const lat = latDeg + (iy * ATTENTION_CELL_METERS) / 111320;
      const key = getAttentionKey(lon, lat);
      const radialWeight = 1 - distanceMeters / Math.max(radiusMeters, 1);
      const previous = attentionGrid[key] || 0;
      attentionGrid[key] = previous + amount * radialWeight;
    }
  }
  attentionDirty = true;
}

function renderMiniMapAttention(centerLonDeg, centerLatDeg) {
  if (!ENABLE_MINIMAP_HEATMAP) {
    return;
  }
  if (!miniMapMap || !miniMapAttentionSource) {
    return;
  }
  miniMapAttentionSource.clear();
  if (!miniMapAttentionEnabled) {
    return;
  }

  const maxDistance = Math.max(350, miniMapCurrentRadiusMeters * 1.4);
  const maxLonDelta = maxDistance / (111320 * Math.max(0.2, Math.cos((centerLatDeg * Math.PI) / 180)));
  const maxLatDelta = maxDistance / 111320;
  const entries = [];
  for (const [key, score] of Object.entries(attentionGrid)) {
    if (score <= 0) {
      continue;
    }
    const unpacked = unpackAttentionKey(key);
    if (Math.abs(unpacked.lon - centerLonDeg) > maxLonDelta || Math.abs(unpacked.lat - centerLatDeg) > maxLatDelta) {
      continue;
    }
    entries.push({ ...unpacked, score });
  }
  entries.sort((a, b) => b.score - a.score);
  const visible = entries.slice(0, ATTENTION_MAX_POINTS_RENDER);
  const peak = visible.length ? visible[0].score : 1;
  for (const item of visible) {
    const normalized = Math.min(1, item.score / peak);
    const feature = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([item.lon, item.lat]))
    });
    feature.setStyle(
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 1.8 + normalized * 4.2,
          fill: new ol.style.Fill({
            color: `rgba(255, ${Math.round(220 - normalized * 120)}, 50, ${0.25 + normalized * 0.7})`
          }),
          stroke: new ol.style.Stroke({
            color: "rgba(255,255,255,0.3)",
            width: 0.5
          })
        })
      })
    );
    miniMapAttentionSource.addFeature(feature);
  }
}

function initMiniMapLayerControls() {
  const layerSelect = document.getElementById("mini_map_layer_select");
  const heatToggle = document.getElementById("mini_map_attention_toggle");
  const heatToggleLabel = heatToggle ? heatToggle.parentElement : null;
  miniMapHoverLabelElement = document.getElementById("mini_map_hover_label");
  if (!layerSelect || !heatToggle) {
    return;
  }
  layerSelect.innerHTML = "";
  for (const layerDef of miniMapLayerDefs) {
    const option = document.createElement("option");
    option.value = layerDef.name;
    option.innerText = layerDef.name;
    layerSelect.appendChild(option);
  }
  layerSelect.value = "Bing Maps Aerial";
  layerSelect.addEventListener("change", () => {
    applyMiniMapLayer(layerSelect.value);
  });
  if (!ENABLE_MINIMAP_HEATMAP) {
    miniMapAttentionEnabled = false;
    heatToggle.checked = false;
    if (heatToggleLabel) {
      heatToggleLabel.style.display = "none";
    }
  } else {
    heatToggle.checked = miniMapAttentionEnabled;
    heatToggle.addEventListener("change", () => {
      miniMapAttentionEnabled = heatToggle.checked;
    });
  }
}

async function applyMiniMapLayer(layerName) {
  if (!miniMapBaseLayer) {
    return;
  }
  const layerDef = miniMapLayerDefs.find((entry) => entry.name === layerName);
  if (!layerDef) {
    return;
  }
  try {
    const source = await Promise.resolve(layerDef.createSource());
    miniMapBaseLayer.setSource(source);
  } catch (error) {
    console.error(`Unable to set minimap layer ${layerName}.`, error);
  }
}

function syncMiniMapLabels() {
  if (!miniMapLabelSource) {
    return;
  }
  const mainEntities = cesiumViewer.entities.values;
  const aliveIds = new Set();
  for (const entity of mainEntities) {
    if (!entity || !entity.position || !entity.label || !entity.properties || !entity.properties.isUserLabel) {
      continue;
    }
    aliveIds.add(entity.id);
    const positionNow = entity.position.getValue(Cesium.JulianDate.now());
    if (!positionNow) {
      continue;
    }
    const cart = Cesium.Cartographic.fromCartesian(positionNow);
    const lon = Cesium.Math.toDegrees(cart.longitude);
    const lat = Cesium.Math.toDegrees(cart.latitude);
    const labelText = entity.label.text.getValue ? entity.label.text.getValue(Cesium.JulianDate.now()) : entity.label.text;
    if (!miniMapLabelEntities.has(entity.id)) {
      const feature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
      });
      feature.set("labelText", labelText);
      feature.setStyle(
        new ol.style.Style({
          image: new ol.style.Circle({
            radius: 3.5,
            fill: new ol.style.Fill({ color: "rgba(80,220,255,0.95)" }),
            stroke: new ol.style.Stroke({ color: "rgba(0,0,0,0.9)", width: 1 })
          })
        })
      );
      miniMapLabelSource.addFeature(feature);
      miniMapLabelEntities.set(entity.id, feature);
    } else {
      const feature = miniMapLabelEntities.get(entity.id);
      feature.getGeometry().setCoordinates(ol.proj.fromLonLat([lon, lat]));
      feature.set("labelText", labelText);
    }
  }
  for (const [mainId, feature] of miniMapLabelEntities.entries()) {
    if (!aliveIds.has(mainId)) {
      miniMapLabelSource.removeFeature(feature);
      miniMapLabelEntities.delete(mainId);
    }
  }
}

function initMiniMapHover() {
  if (!miniMapMap || !miniMapHoverLabelElement) {
    return;
  }
  miniMapMap.on("pointermove", (event) => {
    const feature = miniMapMap.forEachFeatureAtPixel(event.pixel, (hitFeature) => hitFeature);
    const foundText = feature ? feature.get("labelText") : "";
    if (foundText && typeof foundText === "string") {
      miniMapHoverLabelElement.style.display = "block";
      miniMapHoverLabelElement.innerText = foundText;
    } else {
      miniMapHoverLabelElement.style.display = "none";
      miniMapHoverLabelElement.innerText = "";
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function initMiniMap() {
  const miniMapContainer = document.getElementById("mini_map_canvas");
  if (!miniMapContainer) {
    return;
  }

  miniMapBaseLayer = new ol.layer.Tile({
    source: new ol.source.OSM()
  });
  miniMapAttentionSource = new ol.source.Vector();
  miniMapAttentionLayer = new ol.layer.Vector({
    source: miniMapAttentionSource
  });
  miniMapLabelSource = new ol.source.Vector();
  miniMapLabelLayer = new ol.layer.Vector({
    source: miniMapLabelSource
  });
  miniMapCenterFeature = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([0, 0]))
  });
  miniMapCenterFeature.setStyle(
    new ol.style.Style({
      image: new ol.style.Circle({
        radius: 4,
        fill: new ol.style.Fill({ color: "rgba(255,255,255,1)" }),
        stroke: new ol.style.Stroke({ color: "rgba(0,0,0,0.95)", width: 2 })
      })
    })
  );
  miniMapCenterLayer = new ol.layer.Vector({
    source: new ol.source.Vector({
      features: [miniMapCenterFeature]
    })
  });
  miniMapView = new ol.View({
    center: ol.proj.fromLonLat([0, 0]),
    zoom: 13,
    rotation: 0,
    constrainRotation: false
  });
  miniMapMap = new ol.Map({
    target: "mini_map_canvas",
    layers: [miniMapBaseLayer, miniMapAttentionLayer, miniMapLabelLayer, miniMapCenterLayer],
    view: miniMapView,
    controls: [],
    interactions: ol.interaction.defaults({
      dragPan: false,
      mouseWheelZoom: false,
      doubleClickZoom: false,
      pinchZoom: false,
      keyboard: false,
      altShiftDragRotate: false,
      pinchRotate: false
    })
  });
  initMiniMapLayerControls();
  initMiniMapHover();
  applyMiniMapLayer("Bing Maps Aerial");
}

function sampleHeightAboveGround(positionCartographic) {
  const groundHeight = scene.globe.getHeight(positionCartographic);
  if (groundHeight === undefined || Number.isNaN(groundHeight)) {
    return Math.max(positionCartographic.height, 0);
  }
  return positionCartographic.height - groundHeight;
}

function syncMiniMapFrame(timestampMs, cameraCartographic) {
  if (!miniMapMap || !miniMapView || !cameraCartographic) {
    return;
  }

  const lonDeg = Cesium.Math.toDegrees(cameraCartographic.longitude);
  const latDeg = Cesium.Math.toDegrees(cameraCartographic.latitude);
  const heightAboveGround = Math.max(sampleHeightAboveGround(cameraCartographic), 0);
  const container = document.getElementById("mini_map_container");
  if (container) {
    container.style.display = heightAboveGround <= miniMapVisibilityHeight ? "block" : "none";
  }
  if (heightAboveGround > miniMapVisibilityHeight) {
    return;
  }

  const heading = cesiumViewer.camera.heading;
  const minimapHeight = Cesium.Math.clamp(heightAboveGround * 4.0 + 600, 800, 30000);
  miniMapCurrentRadiusMeters = minimapHeight * 0.55;

  let isMoving = false;
  let headingDelta = 0;
  if (miniMapLastCameraPosition !== null) {
    const distanceMoved = Cesium.Cartesian3.distance(cesiumViewer.camera.positionWC, miniMapLastCameraPosition);
    headingDelta = Math.abs(Cesium.Math.negativePiToPi(heading - miniMapLastHeading));
    const deltaSeconds = Math.max((timestampMs - miniMapLastSyncTimestamp) / 1000, 0.001);
    isMoving = distanceMoved > 2 || headingDelta > Cesium.Math.toRadians(1.5);
    if (isMoving) {
      const speed = distanceMoved / deltaSeconds;
      const proximityWeight = 1 / (1 + heightAboveGround / 350);
      const movementWeight = Math.min(3.5, 0.3 + speed / 18);
      const attentionAmount = proximityWeight * movementWeight * deltaSeconds;
      const radiusMeters = Cesium.Math.clamp(heightAboveGround * 0.85 + 20, 20, 900);
      addAttentionAt(lonDeg, latDeg, radiusMeters, attentionAmount);
    }
  }

  const renderIntervalMs = isMoving ? MINIMAP_RENDER_INTERVAL_MOVING_MS : MINIMAP_RENDER_INTERVAL_IDLE_MS;
  const shouldRenderFrame =
    timestampMs - miniMapLastRenderAt >= renderIntervalMs ||
    headingDelta > Cesium.Math.toRadians(0.25);
  const attentionIntervalMs = isMoving
    ? MINIMAP_ATTENTION_RENDER_INTERVAL_MS
    : MINIMAP_ATTENTION_RENDER_INTERVAL_MS * 2;
  const shouldRenderAttention = timestampMs - miniMapLastAttentionRenderAt >= attentionIntervalMs;
  const shouldSyncLabels = timestampMs - miniMapLastLabelSyncAt >= MINIMAP_LABEL_SYNC_INTERVAL_MS;

  if (shouldRenderAttention) {
    renderMiniMapAttention(lonDeg, latDeg);
    miniMapLastAttentionRenderAt = timestampMs;
  }

  if (shouldSyncLabels) {
    syncMiniMapLabels();
    miniMapLastLabelSyncAt = timestampMs;
  }

  if (shouldRenderFrame) {
    const center = ol.proj.fromLonLat([lonDeg, latDeg]);
    const zoom = Cesium.Math.clamp(17 - Math.log2(Math.max(200, minimapHeight) / 75), 3, 18);
    miniMapView.setCenter(center);
    miniMapView.setRotation(-heading);
    miniMapView.setZoom(zoom);
    miniMapCenterFeature.getGeometry().setCoordinates(center);
    miniMapLastRenderAt = timestampMs;
  }

  saveAttentionGrid(false);
  miniMapLastCameraPosition = Cesium.Cartesian3.clone(cesiumViewer.camera.positionWC, miniMapLastCameraPosition || new Cesium.Cartesian3());
  miniMapLastHeading = heading;
  miniMapLastSyncTimestamp = timestampMs;
}

buildLayerCatalog();
setupLayers();
loadAttentionGrid();
initMiniMap();
window.addEventListener("beforeunload", () => {
  saveAttentionGrid(true);
  stopWorkflowPolling();
  if (workflowState.serverMonitorTimer) {
    clearInterval(workflowState.serverMonitorTimer);
    workflowState.serverMonitorTimer = null;
  }
  stopAoiDrawMode("AOI draw mode ended.");
});
initWorkflowPanel();
loadAoiCatalogToMap().catch((error) => {
  appendWorkflowLog(`Failed to load AOI catalog: ${error.message}`, "error");
});

window.addPC = function(url){

Potree.loadPointCloud(url, "test", function(e){
  let potreeScene = potreeViewer.scene;
  let pointcloudProjection = proj4.defs("EPSG:3857");
  potreeScene.addPointCloud(e.pointcloud);
  console.log(e.pointcloud);
  if (e.pointcloud.projection !== null){
    pointcloudProjection = e.pointcloud.projection;
  } else{
    console.log("Assuming PC Projection is EPSG:3857");
  }
  
  let mapProjection = proj4.defs("WGS84");
  // console.log(e.pointcloud.projection);

  window.toMap = proj4(pointcloudProjection, mapProjection);
  window.toScene = proj4(mapProjection, pointcloudProjection);

  e.pointcloud.matrixAutoUpdate = false;
  // e.pointcloud.matrix.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, Zshift, 1);
  var pcx = ((e.pointcloud.boundingBox.max.x + e.pointcloud.boundingBox.min.x)/2);
  var pcy = ((e.pointcloud.boundingBox.max.y + e.pointcloud.boundingBox.min.y)/2);
  var pcz = ((e.pointcloud.boundingBox.max.z + e.pointcloud.boundingBox.min.z)/2);
  var pcCenterC = toMap.forward([pcx,pcy,pcz]);
  var pcZscale = 1/(Math.cos((pcCenterC[1]*Math.PI)/180));
  // console.log(pcZscale);
  if (viewModel.usgsRef){
    e.pointcloud.matrix.set(1, 0, 0, 0,
                          0, 1, 0, 0,
                          0, 0, pcZscale, -32*pcZscale, //0, 0, pcZscale, -32*pcZscale,
                          0, 0, 0, 1);
} else {
e.pointcloud.matrix.set(1, 0, 0, 0,
                          0, 1, 0, 0,
                          0, 0, 1, -32*0.766, //0, 0, pcZscale, -32*pcZscale,
                          0, 0, 0, 1);
}
  

  let material = e.pointcloud.material;
  
  material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
  material.size = 0.29;
  material.weightRGB = 0;
  material.weightIntensity = 1;
  material.weightClassification = 1;
  material.intensityRange = [0,65536];
  material.intensityGamma = 3.02;
  material.intensityContrast = 0.71;
  material.intensityBrightness = 0.45;

  material.shape = Potree.PointShape.CIRCLE;
  material.activeAttributeName = "composite"; // composite
  // console.dir(e.pointcloud.material.classification);
  
  // let pointcloudProjection = "+proj=utm +zone=33 +ellps=WGS84 +datum=WGS84 +units=m +no_defs";
  {
    // proj4.defs("pointcloud", e.pointcloud.projection);
    // proj4.defs("WGS84", "+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs");
    // let toScene2 = proj4("WGS84", "pointcloud");
    
    let featureToScene2Node = (feature, color) => {
      let geometry = feature.geometry;
      
      var color = color ? color : new THREE.Color(1, 1, 1);
      
      if(feature.geometry.type === "Point"){
        let sg = new THREE.SphereGeometry(1, 18, 18);
        let sm = new THREE.MeshNormalMaterial();
        let s = new THREE.Mesh(sg, sm);
        
        let [long, lat] = geometry.coordinates;
        let pos = toScene.forward([long, lat]);
        
        s.position.set(...pos, 20);
        
        s.scale.set(10, 10, 10);
        
        return s;
      }else if(geometry.type === "LineString"){
        let coordinates = [];
        
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        for(let i = 0; i < geometry.coordinates.length; i++){
          let [long, lat] = geometry.coordinates[i];
          let pos = toScene.forward([long, lat]);
          
          min.x = Math.min(min.x, pos[0]);
          min.y = Math.min(min.y, pos[1]);
          min.z = Math.min(min.z, 20);
          
          coordinates.push(...pos, 20);
          if(i > 0 && i < geometry.coordinates.length - 1){
            coordinates.push(...pos, 20);
          }
        }
        
        for(let i = 0; i < coordinates.length; i += 3){
          coordinates[i+0] -= min.x;
          coordinates[i+1] -= min.y;
          coordinates[i+2] -= min.z;
        }
        
        let positions = new Float32Array(coordinates);
        
        let lineGeometry = new THREE.BufferGeometry();
        lineGeometry.addAttribute("position", new THREE.BufferAttribute(positions, 3));
        
        let material = new THREE.LineBasicMaterial( { color: color} );
        let line = new THREE.LineSegments(lineGeometry, material);
        line.position.copy(min);
        
        return line;
      }else if(geometry.type === "Polygon"){
        for(let pc of geometry.coordinates){
          let coordinates = [];
          
          let min = new THREE.Vector3(Infinity, Infinity, Infinity);
          for(let i = 0; i < pc.length; i++){
            let [long, lat] = pc[i];
            let pos = toScene.forward([long, lat]);
            
            min.x = Math.min(min.x, pos[0]);
            min.y = Math.min(min.y, pos[1]);
            min.z = Math.min(min.z, 20);
            
            coordinates.push(...pos, 20);
            if(i > 0 && i < pc.length - 1){
              coordinates.push(...pos, 20);
            }
          }
          
          for(let i = 0; i < coordinates.length; i += 3){
            coordinates[i+0] -= min.x;
            coordinates[i+1] -= min.y;
            coordinates[i+2] -= min.z;
          }
          
          let positions = new Float32Array(coordinates);
          
          let lineGeometry = new THREE.BufferGeometry();
          lineGeometry.addAttribute("position", new THREE.BufferAttribute(positions, 3));
          
          let material = new THREE.LineBasicMaterial( { color: color} );
          let line = new THREE.LineSegments(lineGeometry, material);
          line.position.copy(min);
          
          return line;
        }
      }else{
        console.log("unhandled feature: ", feature);
      }
    };

    let shapeNode = new THREE.Object3D();
    potreeViewer.scene.scene.add(shapeNode);
    
    // Potree.Utils.loadShapefileFeatures(ProxyUrlGenerator.generateProxyUrl("https://feroz.us/Marbles-attempt-1.shp"), features => {
    //   for(let feature of features){
    //     let node = featureToSceneNode(feature, 0x00ff00);
    //     shapeNode.add(node);
    //   }
    // });
    

    // viewer.onGUILoaded(() => {
    //   // Add entry to object list in sidebar
    //   let tree = $(`#jstree_scene`);
    //   let parentNode = "other";
    //   let nodeID = tree.jstree('create_node', parentNode, { 
    //       "text": "shapefile", 
    //       "icon": `${Potree.resourcePath}/icons/triangle.svg`,
    //       "object": shapeNode
    //     }, 
    //     "last", false, false);
    //   tree.jstree(shapeNode.visible ? "check_node" : "uncheck_node", nodeID);
    // });
    
  }
  }
);

}
if (flags.displayPC){
  // window.addPC("http://10.3.90.211:8083/MK/ept.json");
  // window.addPC("http://localhost:8083/marbles/ept.json");
  // window.addPC("http://localhost:8083/B22_10/D/ept.json");
// window.addPC("http://localhost:8083/EMK/ept.json");
// window.addPC("http://localhost:8083/KMFA/ept.json");
// window.addPC("http://localhost:8083/BC/ept.json");
// window.addPC("http://localhost:8083/H1/ept.json");
// window.addPC("http://localhost:8083/H2/ept.json");
// window.addPC("http://localhost:8083/H3/ept.json");
// window.addPC("http://localhost:8083/H4/ept.json");
// window.addPC("http://localhost:8083/H8/ept.json");
// window.addPC("http://localhost:8083/SFK0/ept.json");
// window.addPC("http://localhost:8083/SFK1/ept.json");
// window.addPC("http://localhost:8083/SFK2/ept.json");
// window.addPC("http://localhost:8083/SFK3/ept.json");
// window.addPC("http://localhost:8083/SFK4/ept.json");
// window.addPC("http://localhost:8083/LS/ept.json");
// window.addPC("http://localhost:8083/M4/ept.json");
// window.addPC("http://localhost:8083/2IFG/ept.json");
// window.addPC("http://localhost:8083/TIFG/ept.json");
// window.addPC("http://localhost:8083/YM/ept.json");
//https://ot-process2.sdsc.edu/appEntwineEPTService1710109846278868656237/pc1710109735500
// window.addPC("https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/9262/ept.json"); // NorCal Kangaroo Mtn, Skorp?
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1714692934285-1026035806/pc1714692403090/ept.json")); // LS Bluffs North of the Marbles
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1710112615372926451108/pc1710112504574/ept.json"));
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1710113099587-473228176/pc1710112958845/ept.json"));
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1710109846278868656237/pc1710109735500/ept.json"));
//https://ot-process2.sdsc.edu/appEntwineEPTService1710113099587-473228176/pc1710112958845
//https://ot-process2.sdsc.edu/appEntwineEPTService1710112615372926451108/pc1710112504574
// window.addPC("http://localhost:8083/PC/ept.json");
// window.addPC("https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/9782/ept.json");
// window.addPC("http://localhost:8083/T2/ept.json");
}




//Bind the viewModel to the DOM elements of the UI that call for it.
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

Cesium.knockout
.getObservable(viewModel, "selectedLayer")
.subscribe(function (baseLayer) {
  // Handle changes to the drop-down base layer selector.
  let activeLayerIndex = 0;
  const numLayers = viewModel.layers.length;
  for (let i = 0; i < numLayers; ++i) {
    if (viewModel.isSelectableLayer(viewModel.layers[i])) {
      activeLayerIndex = i;
      break;
    }
  }
  const activeLayer = viewModel.layers[activeLayerIndex];
  const show = activeLayer.show;
  const alpha = activeLayer.alpha;
  imageryLayers.remove(activeLayer, false);
  imageryLayers.add(baseLayer, numLayers - activeLayerIndex - 1);
  baseLayer.show = show;
  baseLayer.alpha = alpha;
  updateLayerList();
});

Cesium.knockout.getObservable(viewModel, "showlidar").subscribe(
function (newValue) {
  setLidarFootprintsVisible(newValue);
}
);
Cesium.knockout.getObservable(viewModel, "googleMapsOn").subscribe(
function (newValue) {
  cesiumViewer.scene.primitives._primitives[0].show = newValue;
  // cesiumViewer.scene.fog.enabled = newValue;
}
);

// disable the default event handlers
scene.screenSpaceCameraController.enableRotate = false;
scene.screenSpaceCameraController.enableTranslate = true;
scene.screenSpaceCameraController.enableZoom = true;
scene.screenSpaceCameraController.enableTilt = true;
scene.screenSpaceCameraController.enableLook = true;

let startMousePosition;
let moveRate = 100;
let moverRateMultiplyer = 1;
let mousePosition;
let lastMousePosition;


const handler = new Cesium.ScreenSpaceEventHandler(canvas);

handler.setInputAction(function (movement) {
flags.looking = true;
mousePosition = startMousePosition = Cesium.Cartesian3.clone(
  movement.position
);
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);

handler.setInputAction(function (movement) {
mousePosition = movement.endPosition;
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction(function (position) {
flags.looking = false;
}, Cesium.ScreenSpaceEventType.LEFT_UP);

// handler.setInputAction(function (movement) {
//   if (flags.looking != true){
//     console.log(event);
//   } else {
//     console.log(event);
//     if (event.deltaY < 0)
//    {
//     moverRateMultiplyer*=1.15;
//    }
//    else if (event.deltaY > 0)
//    {
//     moverRateMultiplyer/=1.15;
//    }
//   }
//   }, Cesium.ScreenSpaceEventType.PINCH_MOVE);

// Allow for speed adjustment when flying
window.addEventListener('wheel', function(event)
{
if (event.deltaY < 0)
{
moverRateMultiplyer*=1.15;
}
else if (event.deltaY > 0)
{
moverRateMultiplyer/=1.15;
}
});


// const entity = cesiumViewer.entities.add({
//   label: {
//     show: false,
//     showBackground: false,
//     font: "14px monospace",
//     horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
//     verticalOrigin: Cesium.VerticalOrigin.TOP,
//     pixelOffset: new Cesium.Cartesian2(15, 0),
//     disableDepthTestDistance: 1.2742018*10**7, // Diameter of Earth
//   },
// });
// const cart = new Cesium.Cartesian3(1,1,1);
// // Mouse over the globe to see the cartographic position
// handler.setInputAction(function (movement) {
//   mousePosition = movement.endPosition;
//   if (flags.selecting){
//     scene.pickTranslucentDepth = true;
//     scene.pickPosition(
//       movement.endPosition, cart
//     );
//     if (cart) {
//       const cartographic = Cesium.Cartographic.fromCartesian(
//         cart
//       );
//       const longitudeString = Cesium.Math.toDegrees(
//         cartographic.longitude
//       ).toFixed(5);
//       const latitudeString = Cesium.Math.toDegrees(
//         cartographic.latitude
//       ).toFixed(5);

//       entity.position = cart;
//       entity.label.show = true;
//       entity.label.text =
//         `Lon: ${`   ${longitudeString}`.slice(-7)}\u00B0` +
//         `\nLat: ${`   ${latitudeString}`.slice(-7)}\u00B0`;
//     } else {
//       entity.label.show = false;
//     }
//   }
//   else {
//       entity.label.show = false;
//   }

// }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
function getFlagForKeyCode(keyCode) {
switch (keyCode) {
  case "R".charCodeAt(0):
    return "removePC";
  case "L".charCodeAt(0):
    return "showlidar";
  case "W".charCodeAt(0):
    return "moveForward";
  case "S".charCodeAt(0):
    return "moveBackward";
  case "E".charCodeAt(0):
    return "moveUp";
  case "Q".charCodeAt(0):
    return "moveDown";
  case "D".charCodeAt(0):
    return "moveRight";
  case "A".charCodeAt(0):
    return "moveLeft";
  case "F".charCodeAt(0):
    return "Fly";
  case "T".charCodeAt(0):
    return "TouchFly";
  case "1".charCodeAt(0):
    return "toggleOther";
  case "2".charCodeAt(0):
    return "toggleGround";
  case "3".charCodeAt(0):
    return "toggleVeg";
  case "4".charCodeAt(0):
    return "toggleLowNoise";
  case "5".charCodeAt(0):
    return "toggleAll";
  case "Z".charCodeAt(0):
    return "pointS";
  case "X".charCodeAt(0):
    return "pointM";
  case "C".charCodeAt(0):
    return "pointL";
  case "V".charCodeAt(0):
    return "route";
  case "B".charCodeAt(0):
    return "routePoint";
  case "K".charCodeAt(0):
    return "downloadPoints";
  case "H".charCodeAt(0):
    return "hideCesium";
  case "P".charCodeAt(0):
    return "displayPC";
  case "O".charCodeAt(0):
    return "displayCave";
  case "N".charCodeAt(0):
    return "cycleCompassStyle";
  default:
    return undefined;
}
}

// array to store left side pointers
var pointersLeft = [];

// array to store right side pointers
var pointersRight = [];

var touchFlyDirection = Cesium.Cartesian3.clone(cesiumViewer.camera.direction);

function addPointer(e) { 
// console.log(e);
const width = canvas.clientWidth;
let pointer = {
  ID: e.pointerId,
  startX: e.clientX,
  currentX: e.clientX,
  startY: e.clientY,
  currentY: e.clientY
};
if (e.clientX >= (width*0.5)){
  pointersRight.push(pointer);
} else {
  pointersLeft.push(pointer);
}
} 

// Change below to work with nested arrays from above
// function removePointer(e) { 
//   const index = pointersRight.indexOf(e.pointerId);
//   if (index > -1) { // only splice array when item is found
//     pointersRight.splice(index, 1);
//   } else {
//     const indexL = pointersLeft.indexOf(e.pointerId);
//     if (index > -1) { // only splice array when item is found
//       pointersLeft.splice(index, 1);
//     } else {
//       // console.log("did not find pointer to remove");
//     }
//   } 
// }

function runTouchFly (e) {
const width = canvas.clientWidth;
if (e.clientX >= (width*0.5)){
  let index = pointersRight.findIndex((element) => element.ID == e.pointerId);
  pointersRight[index].currentX = e.clientX;
  pointersRight[index].currentY = e.clientY;
  console.log(pointersRight[index]);
} else {
  let index = pointersLeft.findIndex((element) => element.ID == e.pointerId);
  pointersLeft[index].currentX = e.clientX;
  pointersLeft[index].currentY = e.clientY;
}
//Check if moved point is on left or right 
// 
// if right: 
//   if one: look around
//     if two: look around + use some attribute to change speed



// if left:
//   count how many points we have:
//   if one: 
//     translate camera by distance along moving plane
//   if two: tilt moving plane relative to frustum

}

function initializeTouchFlyPointers() {

document.addEventListener("pointerdown", function (e) {addPointer(e)}, true); 
document.addEventListener("pointerup", function (e) {removePointer(e)}, true); 
document.addEventListener("pointercancel", function (e) {removePointer(e)}, true);
document.addEventListener("pointermove", function (e) {runTouchFly(e)}, false);

// disable usual cesium navigation
// cesiumViewer.scene.screenSpaceCameraController.enableRotate = false;
// cesiumViewer.scene.screenSpaceCameraController.enableTranslate = false;
// cesiumViewer.scene.screenSpaceCameraController.enableZoom = false;
// cesiumViewer.scene.screenSpaceCameraController.enableTilt = false;
// cesiumViewer.scene.screenSpaceCameraController.enableLook = false;

// update the camera direction (unsure if needed)
touchFlyDirection = Cesium.Cartesian3.clone(cesiumViewer.camera.direction);


}
// function removeTouchFlyPointers() {
//   document.removeEventListener("pointerdown", addPointer, true); 
//   document.removeEventListener("pointerup", removePointer, true); 
//   document.removeEventListener("pointercancel", removePointer, true);
//   document.removeEventListener("pointermove", function (e) {runTouchFly(e)}, false);
// }


document.addEventListener(
"keydown",
function (e) {
  if (workflowState.drawModeActive && e.key === "Escape") {
    stopAoiDrawMode("AOI draw canceled.");
    return;
  }
  const flagName = getFlagForKeyCode(e.keyCode);
  if (typeof flagName !== "undefined") {
    if (flagName == "Fly" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
      moverRateMultiplyer=1;
    }else if (flagName == "TouchFly" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
      if (flags[flagName]){
        initializeTouchFlyPointers();
        console.log("initialized TouchFly");
      }else {
        // removeTouchFlyPointers();
        // console.log("removed TouchFly");
      }
      moverRateMultiplyer=1;
    }else if (flagName == "hideCesium" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
      cesiumViewer.scene.globe.show = !flags[flagName];
      cesiumViewer.scene.skyAtmosphere.show = !flags[flagName];
      // cesiumViewer.scene.skyBox.show = !flags[flagName];
    }else if (flagName == "displayPC" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
    }else if (flagName == "displayCave" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
    }else if (flagName == "cycleCompassStyle"){
      cycleCompassStyle();
    }else if (flagName == "toggleOther"){
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(0,flags[flagName]);
      potreeViewer.setClassificationVisibility(1,flags[flagName]);
      potreeViewer.setClassificationVisibility(8,flags[flagName]);
      potreeViewer.setClassificationVisibility(9,flags[flagName]);
      potreeViewer.setClassificationVisibility(12,flags[flagName]);
      potreeViewer.setClassificationVisibility("DEFAULT",flags[flagName]);
    }else if (flagName == "toggleGround"){
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(2,flags[flagName]);
    }else if (flagName == "toggleVeg"){
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(3,flags[flagName]);
      potreeViewer.setClassificationVisibility(4,flags[flagName]);
      potreeViewer.setClassificationVisibility(5,flags[flagName]);
      potreeViewer.setClassificationVisibility(6,flags[flagName]);
    }else if (flagName == "toggleLowNoise"){ 
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(7,flags[flagName]);
    }else if (flagName == "toggleAll"){
      flags[flagName] = !flags[flagName];
      // if toggleall is turning off: turn off all toggles that are on
      potreeViewer.setClassificationVisibility(0,flags[flagName]);
      potreeViewer.setClassificationVisibility(1,flags[flagName]);
      potreeViewer.setClassificationVisibility(8,flags[flagName]);
      potreeViewer.setClassificationVisibility(9,flags[flagName]);
      potreeViewer.setClassificationVisibility(12,flags[flagName]);
      potreeViewer.setClassificationVisibility("DEFAULT",flags[flagName]);
      potreeViewer.setClassificationVisibility(2,flags[flagName]);
      potreeViewer.setClassificationVisibility(3,flags[flagName]);
      potreeViewer.setClassificationVisibility(4,flags[flagName]);
      potreeViewer.setClassificationVisibility(5,flags[flagName]);
      potreeViewer.setClassificationVisibility(6,flags[flagName]);
      potreeViewer.setClassificationVisibility(7,flags[flagName]);
    }else if (flagName == "pointS"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Small interest ".concat(pointCounter.toString());
      let labelName = preview;
      // let labelName = prompt("Name", preview);
      console.log("Added point of Small interest: S".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: {
          scale: 0.75,
          text: "S".concat(labelName),
        },
        position: cesiumViewer.camera.position,
        properties: {
          isUserLabel: true
        },
        point: {},
      });
    }else if (flagName == "pointM"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Medium interest ".concat(pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Medium interest: M".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: {
          scale: 1,
          text: "M".concat(labelName),
        },
        position: cesiumViewer.camera.position,
        properties: {
          isUserLabel: true
        },
        point: {},
      });
    }else if (flagName == "pointL"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Large interest ".concat(pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Large interest: L".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: {
          scale: 1.5,
          text: "L".concat(labelName),
        },
        position: cesiumViewer.camera.position,
        properties: {
          isUserLabel: true
        },
        point: {},
      });
    }else if (flagName == "route"){ // startor stop recording route. If starting, add route point where camera is currently located.
      if (creatingRoute == ""){
        let preview = "Route ";
        let labelName = prompt("Press B to add route points, press V again to finish route. Name:", preview);
        console.log("Started creating Route");
        routePoints.push(cesiumViewer.camera.position.clone());
        creatingRoute = labelName;
      }else{
        routePoints = [];
        console.log("Finished creating route");
        creatingRoute = "";
      }
      
    }else if (flagName == "routePoint"){ // Adds point to route
      if (creatingRoute == ""){
        console.log("Start route to add points");
      }else{
        routePoints.push(cesiumViewer.camera.position.clone());
        console.log("Added point to route");
        cesiumViewer.entities.remove(currentEntity);
        currentEntity = cesiumViewer.entities.add({
          label: {
            scale: 1.5,
            text: creatingRoute,
            show: true,
          },
          name: creatingRoute,
          polyline: {
            positions: routePoints,
            width: 2,
            arcType: Cesium.ArcType.NONE,
            material: Cesium.Color.RED,
            clampToGround: false,
          },
        });
        console.log(cesiumViewer.entities);
      }
    }else if (flagName == "downloadPoints"){ // download all points added
      Cesium.exportKml({
        entities: cesiumViewer.entities,
        kmz: true,
        // modelCallback: modelCallback,
      }).then(function (result) {
          downloadBlob("TestExport.kmz", result.kmz);
        })
        .catch(console.error);
      // flags[flagName] = !flags[flagName];
    }else{
      flags[flagName] = true;
    }
    
  }
},
false
);

function downloadBlob(filename, blob) {
if (window.navigator.msSaveOrOpenBlob) {
  window.navigator.msSaveBlob(blob, filename);
} else {
  const elem = window.document.createElement("a");
  elem.href = window.URL.createObjectURL(blob);
  elem.download = filename;
  document.body.appendChild(elem);
  elem.click();
  document.body.removeChild(elem);
}
}

document.addEventListener(
"keyup",
function (e) {
  const flagName = getFlagForKeyCode(e.keyCode);
  if ((typeof flagName !== "undefined")&&(flagName !== "Fly")&&(flagName !== "TouchFly")&&(flagName !== "hideCesium")&&(flagName !== "showlidar")&&(flagName !== "removePC")&&(flagName !== "toggleOther")&&(flagName !== "toggleGround")&&(flagName !== "toggleVeg")&&(flagName !== "toggleLowNoise")&&(flagName !== "toggleAll")&&(flagName !== "displayPC")&&(flagName !== "displayCave")&&(flagName !== "cycleCompassStyle")) {
    flags[flagName] = false;
  }
},
false
);

cesiumViewer.clock.onTick.addEventListener(function (clock) {
const camera = cesiumViewer.camera;
// camera.frustum.fov = (Math.PI/2);

if (flags.removePC){
  while (potreeViewer.scene.pointclouds.length > 0) { 
    potreeViewer.scene.scenePointCloud.children.splice(potreeViewer.scene.scenePointCloud.children.indexOf(potreeViewer.scene.pointclouds[0]), 1,); 
    potreeViewer.scene.pointclouds.splice(0, 1); }
  console.log("Removed Point Clouds");
  flags.removePC = false;
}
if (flags.showlidar){
  viewModel.showlidar = !viewModel.showlidar;
  flags.showlidar = false;
}

if ((flags.looking) && (flags.Fly)) {
  // const width = canvas.clientWidth;
  // const height = canvas.clientHeight;

  const lookFactor = 0.0018;

  // Coordinate (0.0, 0.0) will be where the mouse was clicked.

  
  const y = -(mousePosition.y - startMousePosition.y);
  if (mousePosition.x != startMousePosition.x){
    const x = (mousePosition.x - startMousePosition.x);
    startMousePosition.x = mousePosition.x;
    // console.log(startMousePosition.x, mousePosition.x);
    camera.lookRight(x * lookFactor);
  }
  if (mousePosition.y != startMousePosition.y){
    const y = (mousePosition.y - startMousePosition.y);
    startMousePosition.y = mousePosition.y;
    camera.lookUp(-y * lookFactor);
  }
  
  camera.setView({
    orientation:{
      heading: camera.heading,
      pitch: camera.pitch,
      roll: 0.0,
    },
  });
}

if ((flags.looking) && (flags.TouchFly)) {
  // figure out which pointer is controlling the tilt
  // always right array [0]? lets start with that

  if (pointersRight.length > 0){
    const lookFactor = 0.0018;
    let controlPointer = pointersRight[0];
  // Coordinate (0.0, 0.0) will be where the mouse was clicked.

  
  const y = -(controlPointer.startY - controlPointer.currentY);
  if (controlPointer.currentX != controlPointer.startX){
    const x = (controlPointer.currentX - controlPointer.startX);
    pointersRight[0].startX = controlPointer.currentX;
    camera.lookRight(x * lookFactor);
  }
  if (controlPointer.currentY != controlPointer.startY){
    const y = (controlPointer.currentY != controlPointer.startY);
    pointersRight[0].startY = controlPointer.currentY;
    camera.lookUp(-y * lookFactor);

  }
  
  camera.setView({
    orientation:{
      heading: camera.heading,
      pitch: camera.pitch,
      roll: 0.0,
    },
  }); 
  }

  
}

// if (flags.TouchFly) {
//   // Change movement speed based on the distance of the camera to the surface of the ellipsoid.
//   const cameraHeight = ellipsoid.cartesianToCartographic(
//     camera.position
//   ).height;
//   // console.log(cameraHeight);
//   // sampleTerrain(viewer.terrainProvider, 5, [camera.positionCartographic])
//   // .then(function(samples) {
//   //   moveRate = ((cameraHeight-samples[0].height)/200.0);
//     moveRate = ((cameraHeight+1000)/200.0);
//     if (moveRate <0){
//       moveRate = -moveRate;
//     }
//     if (moveRate <0.5){ // make sure we can go underground
//       moveRate = 0.5;
//     }

//     if (moveRate > 6000){ // setting some limits
//         moveRate = 6000;
//     }

//     if (moverRateMultiplyer > 16){
//       moverRateMultiplyer = 16;
//     }
//     if (moverRateMultiplyer < 0.01){
//       moverRateMultiplyer = 0.01;
//     }

//     moveRate = moveRate*moverRateMultiplyer;

//   scene.screenSpaceCameraController.enableZoom = false;
//   scene.screenSpaceCameraController.enableRotate = false;
//   if (flags.touchFlying) {
//     camera.move(touchFlyDirection, moveRate);
//   }else{
//   scene.screenSpaceCameraController.enableZoom = true;
//   scene.screenSpaceCameraController.enableRotate = true;
// }


if (flags.Fly) {
  // Change movement speed based on the distance of the camera to the surface of the ellipsoid.
  const cameraHeight = ellipsoid.cartesianToCartographic(
    camera.position
  ).height;
  // console.log(cameraHeight);
  // sampleTerrain(viewer.terrainProvider, 5, [camera.positionCartographic])
  // .then(function(samples) {
  //   moveRate = ((cameraHeight-samples[0].height)/200.0);
    moveRate = ((cameraHeight+1000)/200.0);
    if (moveRate <0){
      moveRate = -moveRate;
    }
    if (moveRate <0.2){ // make sure we can go underground
      moveRate = 0.2;
    }

    if (moveRate > 6000){ // setting some limits
        moveRate = 6000;
    }

    if (moverRateMultiplyer > 16){
      moverRateMultiplyer = 16;
    }
    if (moverRateMultiplyer < 0.01){
      moverRateMultiplyer = 0.01;
    }

    moveRate = moveRate*moverRateMultiplyer;

  scene.screenSpaceCameraController.enableZoom = false;
  scene.screenSpaceCameraController.enableRotate = false;
  if (flags.moveForward) {
    camera.moveForward(moveRate);
  }
  if (flags.moveBackward) {
    camera.moveBackward(moveRate);
  }
  if (flags.moveUp) {
    camera.moveUp(moveRate*0.75);
  }
  if (flags.moveDown) {
    camera.moveDown(moveRate*0.75);
  }
  if (flags.moveLeft) {
    camera.moveLeft(moveRate*0.75);
  }
  if (flags.moveRight) {
    camera.moveRight(moveRate*0.75);
  }
}else{
  scene.screenSpaceCameraController.enableZoom = true;
  scene.screenSpaceCameraController.enableRotate = true;
}
});

function loop(timestamp){
  requestAnimationFrame(loop);

  // console.log(timestamp);

  // potreeViewer.update(potreeViewer.clock.getDelta(), timestamp);

  cesiumViewer.resize();
  // potreeViewer.resize();

  cesiumViewer.render();

  let cCamPosCart = ellipsoid.cartesianToCartographic(cesiumViewer.camera.position);

  let cCamLong = cCamPosCart.longitude * (180 / Math.PI);
  let cCamLat = cCamPosCart.latitude * (180 / Math.PI);
  let cCamHeight = cCamPosCart.height;
  let coords = cCamLat.toFixed(5) + ", " + cCamLong.toFixed(5);
  document.getElementById("coord_display").innerText = coords;
  document.getElementById("elev_display").innerText = "Height: " + cCamHeight.toFixed(0) + "m";
  syncMiniMapFrame(timestamp, cCamPosCart);

  if(window.toScene !== undefined){
    // do fun proj4 stuff with camera settings
    // cesiumViewer.camera.up = new Cesium.Cartesian3(0,0,1);
    // cesiumViewer.camera.up = Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y);

    // let cCamPos = cesiumViewer.camera.positionCartographic;

    let cCamCenterObject = new Cesium.Cartesian3;
    let cCamDir = cesiumViewer.camera.direction;
    Cesium.Cartesian3.multiplyByScalar(cCamDir, 1000, cCamDir);
    Cesium.Cartesian3.add(cesiumViewer.camera.position, cCamDir, cCamCenterObject);
    
    let cCamCenterObjectPosCart = ellipsoid.cartesianToCartographic(cCamCenterObject);

    let cCamCenterObjectLong = cCamCenterObjectPosCart.longitude * (180 / Math.PI);
    let cCamCenterObjectLat = cCamCenterObjectPosCart.latitude * (180 / Math.PI);
    let cCamCenterObjectHeight = cCamCenterObjectPosCart.height;

    // console.log(cCamPosCart.height);
    // console.log(cCamCenterObjectPosCart.height);
    
    let cCamHeightCorrected = cCamHeight;
    if (viewModel.usgsRef){
    cCamHeightCorrected = cCamHeight/Math.cos(cCamPosCart.latitude);
} 
    let pCamPos = toScene.forward([cCamLong, cCamLat, cCamHeightCorrected]);

    let pCamCenterObjectPos = toScene.forward([cCamCenterObjectLong, cCamCenterObjectLat, cCamCenterObjectHeight]);

    potreeViewer.scene.view.setView(
      [pCamPos[0],pCamPos[1],pCamPos[2]],
      [pCamCenterObjectPos[0],pCamCenterObjectPos[1],pCamCenterObjectPos[2]],
    );
    potreeViewer.scene.view.pitch = cesiumViewer.camera.pitch;
    // potreeViewer.scene.view.nearValue = 0.1;
    // potreeViewer.scene.view.farValue = 100;
    // console.log(potreeViewer.scene.view.position.z, cCamHeight);
    // potreeViewer.scene.view.position.set(pCamPos[0],pCamPos[1],pCamPos[2]);
    // potreeViewer.scene.view.lookAt(pCamCenterObjectPos[0],pCamCenterObjectPos[1],pCamCenterObjectPos[2]);

    let fov = cesiumViewer.camera.frustum.fov;
    let fovy = cesiumViewer.camera.frustum.fovy;
    
    let aspect = cesiumViewer.camera.frustum.aspectRatio;
    // potreeViewer.camera.frustum.aspect = aspect;

    // console.log(cesiumViewer.camera.up);
    
    if(aspect < 1){
      let pfovy =  (180 * fov)/Math.PI;
      potreeViewer.setFOV(pfovy);
      // let fovyp = Math.PI * (potreeViewer.scene.getActiveCamera().fov / 180);
      // cesiumViewer.camera.frustum.fov = fovyp;
    }else{
      let pfovy = (180 * fovy)/Math.PI;
      potreeViewer.setFOV(pfovy);
      // let fovyp = Math.PI * (potreeViewer.scene.getActiveCamera().fov / 180);
      // let fovxp = Math.atan(Math.tan(0.5 * fovyp) * aspect) * 2
      // cesiumViewer.camera.frustum.fov = fovxp;
    }
    // console.log(potreeViewer.scene.cameraP.fov);
      // console.log("Cesium FOV: ", fov, "|Potree FOV: ", fovy);

  }

  potreeViewer.render();
  updateNorthCompass();
}
initNorthCompass();
requestAnimationFrame(loop);
