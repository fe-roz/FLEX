import * as THREE from "./PotreeCopied/libs/three.js/build/three.module.js";
import { meanSeaLevel } from 'https://esm.sh/egm96-universal@1.1.1';

import "../Tokens.js";

import {
  getBackendBaseUrl,
  toAbsoluteUrl,
  workflowState,
  backendApi,
  setText,
  appendWorkflowLog,
  setWorkflowActionStatus,
  setWorkflowBusy,
  registerUpdateWorkflowButtons
} from "./api.js";

import { viewModel, loadLayers, updateLayerList, LAYER_CATALOG, addCatalogLayer, removeCatalogLayer } from "./layers.js";
import { initializeContextMenu } from "./context-menu.js";
import {
  initSession, notifyPcLoaded, notifyCaltopoChanged, saveSession, loadSession,
  restoreCamera, restoreLayerState, onCameraFrame,
  notifyDataFilesChanged, notifyCaveVisibilityChanged, notifyPoiVisibilityChanged,
  notifyPanelSectionToggled, notifyPointBudgetChanged,
} from "./session.js";

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
  if (!workflowState.serverConnected) {
    return;
  }
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

async function connectToServer() {
  const statusEl = document.getElementById("top_server_status_btn");
  const controlsEl = document.getElementById("server_connected_controls");
  if (statusEl) {
    statusEl.textContent = "Connecting...";
    statusEl.style.background = "";
    statusEl.style.borderColor = "";
  }
  try {
    await backendApi("/api/v1/health");
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = "Server: Offline";
      statusEl.style.background = "rgba(120, 120, 120, 0.35)";
      statusEl.style.borderColor = "rgba(170, 170, 170, 0.8)";
    }
    appendWorkflowLog(`Could not reach server: ${error.message}`, "error");
    // Brief delay then reset button so user can retry
    setTimeout(() => {
      if (!workflowState.serverConnected && statusEl) {
        statusEl.textContent = "Connect to LAN Server";
        statusEl.style.background = "";
        statusEl.style.borderColor = "";
      }
    }, 3000);
    return;
  }
  workflowState.serverConnected = true;
  if (controlsEl) {
    controlsEl.style.display = "block";
  }
  if (statusEl) {
    statusEl.textContent = "Server: Online";
    statusEl.style.background = "rgba(46, 125, 50, 0.35)";
    statusEl.style.borderColor = "rgba(102, 187, 106, 0.8)";
  }
  appendWorkflowLog("Connected to LAN server.");

  // Start the periodic health check
  if (!workflowState.serverMonitorTimer) {
    workflowState.serverMonitorTimer = setInterval(() => {
      refreshServerMonitor().catch(() => {});
    }, 3000);
  }

  // Load server data now that we are connected
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
  loadAoiCatalogToMap().catch((error) => {
    appendWorkflowLog(`Failed to load AOI catalog: ${error.message}`, "error");
  });

  // Load backend EPT catalog
  if (window.serverConfig?.backend?.autoLoadCatalog) {
    loadBackendCatalog();
  }
}

function disconnectFromServer() {
  workflowState.serverConnected = false;
  const statusEl = document.getElementById("top_server_status_btn");
  const controlsEl = document.getElementById("server_connected_controls");
  if (workflowState.serverMonitorTimer) {
    clearInterval(workflowState.serverMonitorTimer);
    workflowState.serverMonitorTimer = null;
  }
  stopWorkflowPolling();
  stopQueuePolling();
  if (statusEl) {
    statusEl.textContent = "Connect to LAN Server";
    statusEl.style.background = "";
    statusEl.style.borderColor = "";
  }
  if (controlsEl) {
    controlsEl.style.display = "none";
  }
  appendWorkflowLog("Disconnected from LAN server.");
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

// Register updateWorkflowButtons so the shared api module can call it
// from setWorkflowBusy without a circular import.
registerUpdateWorkflowButtons(updateWorkflowButtons);

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

  // Server connection is manual — user clicks "Connect to LAN Server"
  const serverBtn = document.getElementById("top_server_status_btn");
  if (serverBtn) {
    serverBtn.addEventListener("click", () => {
      if (!workflowState.serverConnected) {
        connectToServer();
      }
    });
  }
  const disconnectBtn = document.getElementById("top_server_disconnect_btn");
  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", () => {
      disconnectFromServer();
    });
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

// Restore camera from last session immediately (before anything else moves the camera)
const _savedSession = loadSession();
if (_savedSession) restoreCamera(_savedSession, cesiumViewer);

// Cesium's InfoBox uses a sandboxed iframe that blocks scripts by default.
// Remove the sandbox entirely so entity description HTML renders correctly.
const infoBoxFrame = cesiumViewer.infoBox?.frame;
if (infoBoxFrame) {
  infoBoxFrame.removeAttribute("sandbox");
}

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
            const eptUrl = url.endsWith('/ept.json') ? url : url.replace(/\/+$/, '') + '/ept.json';
    window.addPC(eptUrl);
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


// Cave survey loaded on demand via #lp-cave-toggle in the Layers panel


Cesium.Math.setRandomNumberSeed(0);
const lidarFootprintSources = {
  usgs: null,
  backend: null,
  noaa: null
};

function setLidarFootprintsVisible(visible) {
  if (lidarFootprintSources.usgs) {
    lidarFootprintSources.usgs.show = !!visible;
  }
  if (lidarFootprintSources.backend) {
    lidarFootprintSources.backend.show = !!visible;
  }
  if (lidarFootprintSources.noaa) {
    lidarFootprintSources.noaa.show = !!visible;
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

function loadBackendCatalog() {
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

// ── OpenTopography WMS imagery layer ─────────────────────────────────────────

function _showToast(msg, durationMs) {
  var existing = document.getElementById('lp-ot-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'lp-ot-toast';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '36px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(12,18,28,0.92)', color: '#ccc',
    border: '1px solid rgba(100,170,255,0.25)', borderRadius: '6px',
    padding: '6px 16px', fontSize: '12px', zIndex: '9997',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
  });
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, durationMs || 4000);
}

function _otSetStatus(msg) {
  var el = document.getElementById('lp-ot-status');
  if (el) el.textContent = msg;
}

var otWmsLayer = null;

function setOtFootprintsVisible(visible) {
  if (otWmsLayer) {
    otWmsLayer.show = !!visible;
  } else if (visible) {
    loadOtWms();
  }
}

function loadOtWms() {
  _otSetStatus('WMS');
  try {
    var provider = new Cesium.WebMapServiceImageryProvider({
      url: '/ot-wms',
      layers: 'OPENTOPO:datasets_view',
      parameters: {
        transparent: 'true',
        format: 'image/png',
        CQL_FILTER: "is_global=false AND host<>'USGS'"
      },
      tileWidth: 256,
      tileHeight: 256
    });
    otWmsLayer = cesiumViewer.imageryLayers.addImageryProvider(provider);
    otWmsLayer.show = !!viewModel.showOpenTopo;
    otWmsLayer.alpha = 0.75;
    console.log('OpenTopography WMS layer added.');
  } catch(err) {
    _otSetStatus('Error');
    console.error('OpenTopography WMS error:', err);
  }
}
// ── end OpenTopography ────────────────────────────────────────────────────────
// ── OpenTopography click-to-query ─────────────────────────────────────────────

function _otShowPopup(props, screenPos) {
  var name      = props.projectname || props.name || 'Dataset';
  var host      = props.host || '';
  var urlPath   = props.url || '';
  var platform  = props.collection_platform || '';
  var startDate = (props.start_date || '').slice(0, 10);
  var isRestr   = props.is_restricted || false;
  var portalUrl = urlPath ? 'https://portal.opentopography.org' + urlPath : '';
  var noaaId = null;
  if (urlPath.indexOf('noaaID=') !== -1) {
    noaaId = urlPath.split('noaaID=')[1].split('&')[0];
  }
  var eptUrl = noaaId
    ? 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/' + noaaId + '/ept.json'
    : null;
  var html =
    '<div style="font-family:sans-serif;font-size:13px;">' +
    '<b style="font-size:14px;">' + name + '</b><br>' +
    (host      ? '<span style="color:#aaa;font-size:11px;">Source: ' + host + '</span><br>' : '') +
    (platform  ? '<span style="color:#aaa;font-size:11px;">' + platform + '</span><br>' : '') +
    (startDate ? '<span style="color:#aaa;font-size:11px;">Collected: ' + startDate + '</span><br>' : '') +
    (isRestr   ? '<span style="color:#f88;font-size:11px;">&#9888; Restricted</span><br>' : '') +
    '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">';
  if (portalUrl) {
    html += '<a href="' + portalUrl + '" target="_blank" ' +
      'style="color:#6af;text-decoration:none;font-size:12px;">&#8599; View on OpenTopography</a>';
  }
  if (eptUrl) {
    html += '<button id="ot-load-ept-btn" ' +
      'style="background:#0d2a44;color:#6af;border:1px solid rgba(100,170,255,0.5);' +
      'border-radius:4px;padding:5px 10px;cursor:pointer;font-size:12px;text-align:left;">' +
      '&#8853; Load EPT in FLEX</button>';
  }
  html += '</div></div>';
  var popup = document.getElementById('ot-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'ot-popup';
    Object.assign(popup.style, {
      position: 'fixed', background: 'rgba(12,18,28,0.94)', color: '#ccc',
      border: '1px solid rgba(100,170,255,0.28)', borderRadius: '8px',
      padding: '12px 32px 12px 14px', maxWidth: '290px',
      zIndex: '9998', boxShadow: '0 4px 22px rgba(0,0,0,0.65)',
      pointerEvents: 'auto', lineHeight: '1.5'
    });
    var closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute', top: '6px', right: '10px',
      cursor: 'pointer', color: '#888', fontSize: '14px', lineHeight: '1'
    });
    closeBtn.onclick = function() { popup.style.display = 'none'; };
    popup.appendChild(closeBtn);
    var content = document.createElement('div');
    content.id = 'ot-popup-content';
    popup.appendChild(content);
    document.body.appendChild(popup);
  }
  document.getElementById('ot-popup-content').innerHTML = html;
  var px = Math.min(screenPos.x + 18, window.innerWidth - 320);
  var py = Math.max(10, Math.min(screenPos.y - 20, window.innerHeight - 260));
  popup.style.left = px + 'px';
  popup.style.top  = py + 'px';
  popup.style.display = 'block';
  if (eptUrl) {
    var btn = document.getElementById('ot-load-ept-btn');
    if (btn) btn.onclick = function() {
      popup.style.display = 'none';
      window.addPC(eptUrl);
      _showToast('⏳ Loading: ' + name, 6000);
    };
  }
}

function _otHandleClick(screenPos) {
  if (!otWmsLayer || !otWmsLayer.show) return;
  var picked = cesiumViewer.scene.pick(screenPos);
  if (picked && picked.id) return;
  var ray = cesiumViewer.camera.getPickRay(screenPos);
  if (!ray) return;
  var cartesian = cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene);
  if (!cartesian) return;
  var carto = Cesium.Cartographic.fromCartesian(cartesian);
  var lon = Cesium.Math.toDegrees(carto.longitude);
  var lat = Cesium.Math.toDegrees(carto.latitude);
  var d = 0.3;
  var bbox = (lon-d) + ',' + (lat-d) + ',' + (lon+d) + ',' + (lat+d);
  var qs = '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo' +
    '&LAYERS=OPENTOPO%3Adatasets_view' +
    '&QUERY_LAYERS=OPENTOPO%3Adatasets_view' +
    '&CQL_FILTER=is_global%3Dfalse%20AND%20host%3C%3E%27USGS%27' +
    '&INFO_FORMAT=application%2Fjson' +
    '&FEATURE_COUNT=1' +
    '&X=128&Y=128&WIDTH=256&HEIGHT=256' +
    '&SRS=EPSG%3A4326' +
    '&BBOX=' + encodeURIComponent(bbox);
  fetch('/ot-wms' + qs)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.features || !data.features.length) return;
      _otShowPopup(data.features[0].properties, screenPos);
    })
    .catch(function(e) { console.warn('OT feature info error:', e); });
}
// ── end OpenTopography click-to-query ─────────────────────────────────────────



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

// Cave survey globe-pick: intercept LEFT_CLICK when pick mode is active
{
  const cavePickHandler = new Cesium.ScreenSpaceEventHandler(canvas);
  cavePickHandler.setInputAction(function(click) {
    if (!_cavePickMode) return;
    _cavePickMode = false;
    const banner = document.getElementById('cave-pick-banner');
    if (banner) banner.style.display = 'none';
    document.getElementById('cave-wizard-overlay').style.display = 'flex';
    const resolve = _cavePickResolve;
    _cavePickResolve = null;
    if (!resolve) return;

    // scene.pickPosition fails when globe translucency is on — use ray/globe instead.
    // globe.pick returns the position on the actual rendered terrain surface.
    const ray = cesiumViewer.camera.getPickRay(click.position);
    let pos = ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
    if (!pos || !Cesium.defined(pos)) {
      // Fallback: project onto smooth ellipsoid (no terrain elevation)
      pos = cesiumViewer.camera.pickEllipsoid(click.position, cesiumViewer.scene.globe.ellipsoid);
    }
    if (pos && Cesium.defined(pos)) {
      const carto = Cesium.Cartographic.fromCartesian(pos);
      resolve({
        lat:  Cesium.Math.toDegrees(carto.latitude),
        lon:  Cesium.Math.toDegrees(carto.longitude),
        elev: carto.height,
      });
    } else {
      resolve(null);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}


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

let miniMapMap = null;
let miniMapView = null;
let miniMapBaseLayer = null;
let miniMapAttentionLayer = null;
let miniMapAttentionSource = null;
let miniMapLabelLayer = null;
let miniMapLabelSource = null;
let miniMapCaltopoSource = null;
let miniMapCaltopoLayer = null;
let miniMapCenterLayer = null;
let miniMapCenterFeature = null;
let miniMapAttentionEnabled = true;
let miniMapHoverLabelElement = null;
let miniMapVisibilityHeight = 15000;
let miniMapUserHidden = false;
let miniMapZoomOffset = 0;  // scroll-wheel baseline adjustment (integer zoom steps)
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

/**
 * Populate the CalTopo minimap layer from a freshly-loaded Cesium KmlDataSource.
 * Called after every successful KML fetch.  Handles Points, Polylines, and Polygons.
 */
function syncMinimapCaltopoFeatures(ds) {
  if (!miniMapCaltopoSource || !ds) return;
  miniMapCaltopoSource.clear();

  const now = Cesium.JulianDate.now();

  // Shared styles
  const pointStyle = new ol.style.Style({
    image: new ol.style.Circle({
      radius: 5,
      fill:   new ol.style.Fill({ color: 'rgba(255,160,0,0.9)' }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
    }),
    text: new ol.style.Text({
      offsetY: -12,
      font:    'bold 11px sans-serif',
      fill:    new ol.style.Fill({ color: '#fff' }),
      stroke:  new ol.style.Stroke({ color: 'rgba(0,0,0,0.7)', width: 3 }),
    }),
  });

  const lineStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: 'rgba(255,160,0,0.9)', width: 2 }),
  });

  const polyStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: 'rgba(255,160,0,0.9)', width: 2 }),
    fill:   new ol.style.Fill({ color: 'rgba(255,160,0,0.15)' }),
  });

  function cartToLonLat(c3) {
    const c = Cesium.Cartographic.fromCartesian(c3);
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
  }

  for (const entity of ds.entities.values) {
    try {
      // ── Point / Billboard ──────────────────────────────────────────────────
      if (entity.position) {
        const pos = entity.position.getValue(now);
        if (!pos) continue;
        const ll = cartToLonLat(pos);
        if (!isFinite(ll[0]) || !isFinite(ll[1])) continue;
        const feat = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat(ll)) });
        const name = entity.name || '';
        // Clone style so we can set per-feature text
        const st = pointStyle.clone();
        if (name) st.getText().setText(name);
        feat.setStyle(st);
        feat.set('caltopoName', name);
        miniMapCaltopoSource.addFeature(feat);
      }
      // ── Polyline ───────────────────────────────────────────────────────────
      else if (entity.polyline) {
        const positions = entity.polyline.positions?.getValue(now);
        if (!positions || positions.length < 2) continue;
        const coords = positions.map(cartToLonLat).filter(ll => isFinite(ll[0]));
        if (coords.length < 2) continue;
        const feat = new ol.Feature({
          geometry: new ol.geom.LineString(coords.map(ll => ol.proj.fromLonLat(ll)))
        });
        feat.setStyle(lineStyle);
        if (entity.name) feat.set('caltopoName', entity.name);
        miniMapCaltopoSource.addFeature(feat);
      }
      // ── Polygon ────────────────────────────────────────────────────────────
      else if (entity.polygon) {
        const hierarchy = entity.polygon.hierarchy?.getValue(now);
        if (!hierarchy?.positions) continue;
        const ring = hierarchy.positions.map(cartToLonLat).filter(ll => isFinite(ll[0]));
        if (ring.length < 3) continue;
        const feat = new ol.Feature({
          geometry: new ol.geom.Polygon([ring.map(ll => ol.proj.fromLonLat(ll))])
        });
        feat.setStyle(polyStyle);
        if (entity.name) feat.set('caltopoName', entity.name);
        miniMapCaltopoSource.addFeature(feat);
      }
    } catch (err) {
      // Skip malformed entities silently
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
  miniMapCaltopoSource = new ol.source.Vector();
  miniMapCaltopoLayer = new ol.layer.Vector({
    source: miniMapCaltopoSource
  });
  miniMapCenterFeature = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([0, 0]))
  });
  miniMapCenterFeature.setStyle(
    new ol.style.Style({
      image: new ol.style.Circle({
        radius: 4,
        fill: new ol.style.Fill({ color: "rgba(0,220,80,1)" }),
        stroke: new ol.style.Stroke({ color: "rgba(0,0,0,0.85)", width: 2 })
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
    layers: [miniMapBaseLayer, miniMapAttentionLayer, miniMapCaltopoLayer, miniMapLabelLayer, miniMapCenterLayer],
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
  initMiniMapWindow();
}

function initMiniMapWindow() {
  const STORAGE_KEY = 'flex_minimap_window_v2';
  const container = document.getElementById('mini_map_container');
  const titlebar  = document.getElementById('mini_map_titlebar');
  const closeBtn  = document.getElementById('mini_map_close_btn');
  if (!container || !titlebar) return;

  const MIN_W = 160, MIN_H = 135;

  // Default position: bottom-right corner
  function defaultGeometry() {
    return {
      left:   window.innerWidth  - 18 - 260,
      top:    window.innerHeight - 18 - 285,
      width:  260,
      height: 285,
    };
  }

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(_) {}
  let geo = Object.assign(defaultGeometry(), saved || {});

  function applyGeometry(g) {
    const vw = window.innerWidth, vh = window.innerHeight;
    g.width  = Math.max(MIN_W, Math.min(g.width,  vw - 10));
    g.height = Math.max(MIN_H, Math.min(g.height, vh - 10));
    g.left   = Math.max(0, Math.min(g.left, vw - g.width));
    g.top    = Math.max(0, Math.min(g.top,  vh - g.height));
    container.style.left   = g.left   + 'px';
    container.style.top    = g.top    + 'px';
    container.style.width  = g.width  + 'px';
    container.style.height = g.height + 'px';
    container.style.right  = '';
    container.style.bottom = '';
    geo = { left: g.left, top: g.top, width: g.width, height: g.height };
    if (miniMapMap) miniMapMap.updateSize();
  }

  function saveGeometry() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(geo)); } catch(_) {}
  }

  applyGeometry(geo);

  // --- Drag (titlebar) ---
  titlebar.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = geo.left, startTop = geo.top;
    function onMove(e) {
      applyGeometry({ ...geo, left: startLeft + (e.clientX - startX), top: startTop + (e.clientY - startY) });
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveGeometry();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // --- Resize (4 corners) ---
  // Each corner encodes which edges move via data-corner: nw / ne / sw / se
  container.querySelectorAll('.mini_map_resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const corner   = handle.dataset.corner; // 'nw','ne','sw','se'
      const startX   = e.clientX, startY = e.clientY;
      const startGeo = { ...geo };

      function onMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const g = { ...startGeo };

        // Horizontal: 'w' side moves left edge, 'e' side moves right edge
        if (corner.includes('w')) {
          g.left  = startGeo.left  + dx;
          g.width = startGeo.width - dx;
        } else {
          g.width = startGeo.width + dx;
        }

        // Vertical: 'n' side moves top edge, 's' side moves bottom edge
        if (corner.includes('n')) {
          g.top    = startGeo.top    + dy;
          g.height = startGeo.height - dy;
        } else {
          g.height = startGeo.height + dy;
        }

        applyGeometry(g);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveGeometry();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // --- Scroll wheel: adjust baseline zoom offset ---
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Each detent zooms in or out by 1 step (clamp to ±6 so it can't go crazy)
    miniMapZoomOffset = Cesium.Math.clamp(
      miniMapZoomOffset + (e.deltaY < 0 ? 1 : -1),
      -6, 6
    );
  }, { passive: false });

  // --- Close button ---
  closeBtn.addEventListener('click', () => {
    miniMapUserHidden = true;
    container.style.display = 'none';
  });

  // Re-clamp if browser window resizes
  window.addEventListener('resize', () => applyGeometry({ ...geo }));
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
  const showMiniMap = !miniMapUserHidden && heightAboveGround <= miniMapVisibilityHeight;
  if (container) {
    container.style.display = showMiniMap ? "block" : "none";
  }
  if (!showMiniMap) {
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
    const zoom = Cesium.Math.clamp(17 - Math.log2(Math.max(200, minimapHeight) / 75) + miniMapZoomOffset, 3, 18);
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

Cesium.knockout.track(viewModel);
const _layersReady = loadLayers().catch((error) => console.error("Layer loading error:", error));
loadAttentionGrid();
initMiniMap();
initializeContextMenu({ Cesium, cesiumViewer });

// Init session system (wires auto-save triggers, exposes window._sessionSave)
initSession(cesiumViewer, viewModel);

// Shared helper: apply the correct Z matrix to a loaded point cloud based on
// current toggle state.  Called at load time and on every toggle change.
//   egm96 ON  → Matt's EGM96 precise geoid lookup (pcZscale + meanSeaLevel offset)
//   usgsRef ON → fixed -32 m geoid lift (original USGS correction)
//   both OFF   → original default: scale=1, fixed -32*0.766 offset
function applyPcMatrix(pc) {
  const z = pc._pcZscale || 1;
  if (viewModel.egm96) {
    const h = meanSeaLevel(pc._pcLat || 0, pc._pcLon || 0);
    pc.matrix.set(1,0,0,0, 0,1,0,0, 0,0,z, h*z, 0,0,0,1);
  } else if (viewModel.usgsRef) {
    pc.matrix.set(1,0,0,0, 0,1,0,0, 0,0,z, -32*z, 0,0,0,1);
  } else {
    pc.matrix.set(1,0,0,0, 0,1,0,0, 0,0,1, -32*0.766, 0,0,0,1);
  }
}

// Activate layers — either from saved session or first-run defaults.
// loadLayers() now only strips Cesium's built-in layer and builds the catalog;
// it adds nothing to the scene.  We add layers here so the session controls
// exactly which catalog entries are in the active stack.
_layersReady.then(async () => {
  const savedLayers = _savedSession?.layers?.layers;

  if (savedLayers?.length) {
    // Session exists: re-add saved layers.  They're stored top→bottom in
    // viewModel order, so add in reverse so index-0 ends up on top.
    for (let i = savedLayers.length - 1; i >= 0; i--) {
      const { name, show, alpha } = savedLayers[i];
      const layer = await addCatalogLayer(name, show, alpha);
      if (layer) subscribeLayerToSession(layer);
    }
    if (_savedSession.layers.usgsRef !== undefined) {
      viewModel.usgsRef = _savedSession.layers.usgsRef;
    }
  } else {
    // No session: add the four default active layers (bottom → top order).
    // Only OSM is visible; the others are in the list but toggled off.
    const defaults = [
      { name: 'Bing Maps Aerial', show: false, alpha: 1.0 },
      { name: 'NGMDB Mosaic',     show: false, alpha: 1.0 },
      { name: 'Slope Angle',      show: false, alpha: 1.0 },
      { name: 'OpenStreetMaps',   show: true,  alpha: 1.0 },
    ];
    for (const d of defaults) {
      const layer = await addCatalogLayer(d.name, d.show, d.alpha);
      if (layer) subscribeLayerToSession(layer);
    }
  }

  // Subscribe viewModel-level settings that should persist + live-update loaded clouds
  ['usgsRef', 'egm96'].forEach(key => {
    Cesium.knockout.getObservable(viewModel, key).subscribe(() => {
      saveSession();
      potreeViewer.scene.pointclouds.forEach(applyPcMatrix);
    });
  });

  renderLayerList();
});

// Restore saved state after full init (addPC interceptor and CalTopo fns are defined below this point)
setTimeout(() => {
  if (_savedSession?.pointClouds?.length) {
    showPcRestorePrompt(_savedSession.pointClouds);
  }
  // Check if server still has an active CalTopo session
  fetch('/caltopo/status').then(r => r.json()).then(data => {
    if (data.loggedIn) _showCaltopoLoggedIn();
  }).catch(() => {});

  // Poll for bookmarklet login (updates UI within 3s of clicking bookmark)
  setInterval(() => {
    const loginSection = document.getElementById('caltopo_login_section');
    if (!loginSection || loginSection.style.display === 'none') return;
    fetch('/caltopo/status').then(r => r.json()).then(data => {
      if (data.loggedIn) {
        _showCaltopoLoggedIn();
        if (caltopoState.url) _fetchCaltopoKml();
      }
    }).catch(() => {});
  }, 3000);

  // Auto-restore CalTopo KML (no prompt — it's a live feed, should just resume)
  if (_savedSession?.caltopoUrl) {
    const input = document.getElementById('caltopo_url_input');
    const sel   = document.getElementById('caltopo_interval_select');
    if (input) input.value = _savedSession.caltopoUrl;
    if (sel && _savedSession.caltopoInterval != null) {
      sel.value = String(_savedSession.caltopoInterval);
    }
    loadCaltopoKml(_savedSession.caltopoUrl, _savedSession.caltopoInterval ?? 30);
  }

  // Auto-restore URL-sourced data files silently
  if (_savedSession?.dataFiles?.length) {
    for (const f of _savedSession.dataFiles) {
      addDataFile(f.url, f.label).catch(e => console.warn('[session] data file restore failed:', e));
    }
  }

  // Restore cave visibility
  if (_savedSession?.caveVisible) {
    const caveToggle = document.getElementById('lp-cave-toggle');
    if (caveToggle) caveToggle.checked = true;
    setCaveSurveyVisible(true);
  }

  // Restore POI visibility
  if (_savedSession?.poiVisible === false) {
    const poiToggle = document.getElementById('html_labels_toggle');
    if (poiToggle) { poiToggle.checked = false; poiToggle.dispatchEvent(new Event('change')); }
  }

  // Restore panel section open/closed state
  if (_savedSession?.panelSections) {
    for (const [id, open] of Object.entries(_savedSession.panelSections)) {
      const body = document.getElementById(id);
      if (!body) continue;
      body.classList.toggle('open', open);
      const arrow = body.previousElementSibling?.querySelector('.lp-section-arrow');
      if (arrow) arrow.style.transform = open ? '' : 'rotate(-90deg)';
    }
  }
}, 0);
window.addEventListener("beforeunload", () => {
  saveSession();
  saveAttentionGrid(true);
  stopWorkflowPolling();
  if (workflowState.serverMonitorTimer) {
    clearInterval(workflowState.serverMonitorTimer);
    workflowState.serverMonitorTimer = null;
  }
  stopAoiDrawMode("AOI draw mode ended.");
});
initWorkflowPanel();

// ── Update checker ────────────────────────────────────────────────────────────
window._checkForUpdates = async function () {
  const btn       = document.getElementById('update_check_btn');
  const indicator = document.getElementById('update_status_indicator');
  if (!indicator) return;

  const _setStatus = (msg, color) => {
    indicator.textContent = msg;
    indicator.style.color = color;
    indicator.style.display = 'inline';
  };

  if (btn) btn.disabled = true;
  _setStatus('Checking…', '#aaa');

  try {
    const res  = await fetch('/api/updates/check');
    const data = await res.json();

    if (!data.ok) {
      _setStatus('⚠ ' + (data.error || 'Check failed'), '#f77');
      return;
    }

    if (data.behind === 0) {
      _setStatus(`✓ Up to date (${data.currentHash})`, '#aaffaa');
      return;
    }

    // There are updates available — ask to apply
    const apply = confirm(
      `${data.behind} update${data.behind === 1 ? '' : 's'} available ` +
      `(${data.currentHash} → ${data.remoteHash}).\n\nApply now? ` +
      `(FLEX will need to be restarted after)`
    );
    if (!apply) {
      _setStatus(`${data.behind} update${data.behind === 1 ? '' : 's'} available`, '#ffdd88');
      return;
    }

    _setStatus('Applying…', '#aaa');
    const applyRes  = await fetch('/api/updates/apply', { method: 'POST' });
    const applyData = await applyRes.json();

    if (applyData.ok) {
      _setStatus('✓ Updated — please restart FLEX', '#aaffaa');
      console.log('[updates]', applyData.output);
    } else {
      _setStatus('✗ Update failed — see console', '#f77');
      console.error('[updates] git pull failed:\n', applyData.output);
    }
  } catch (e) {
    _setStatus('✗ Server unreachable', '#f77');
    console.error('[updates] fetch error:', e);
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.addPC = function(url){

// Derive a readable name from the URL: use the path segment before /ept.json
const _pcName = (function() {
  try {
    const parts = url.replace(/\/ept\.json.*$/i, '').split('/');
    return parts[parts.length - 1] || url;
  } catch(_) { return url; }
})();

Potree.loadPointCloud(url, _pcName, function(e){
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
  e.pointcloud._pcZscale = pcZscale;       // stash for live toggle updates
  e.pointcloud._pcLat   = pcCenterC[1];   // stash for EGM96 reactive re-apply
  e.pointcloud._pcLon   = pcCenterC[0];
  // console.log(pcZscale);
  applyPcMatrix(e.pointcloud);
  

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

// Intercept addPC to track loaded URLs for session persistence and update panel
const _origAddPC = window.addPC;
window.addPC = function(url) {
  notifyPcLoaded(url);
  const pcsBefore = (potreeViewer?.scene?.pointclouds || []).length;
  const statusEl = document.getElementById('lp-pc-status');
  const result = _origAddPC(url);
  // Potree loads async; poll until the new cloud appears (success) or give up (failure)
  let tries = 0;
  const poll = setInterval(() => {
    const pcs = potreeViewer?.scene?.pointclouds || [];
    renderPcList();
    if (pcs.length > pcsBefore) {
      clearInterval(poll);
      if (statusEl) {
        const loaded = pcs[pcs.length - 1];
        statusEl.textContent = '✓ Loaded: ' + (loaded?.name || 'point cloud');
        statusEl.style.color = '#5d5';
      }
      // Auto-hide the LiDAR dataset footprints — no longer needed once a cloud is loaded
      if (viewModel.showlidar) viewModel.showlidar = false;
    } else if (++tries >= 30) {
      // ~9 seconds with no new cloud — likely a bad URL or CORS/proxy error
      clearInterval(poll);
      if (statusEl) {
        statusEl.textContent = '✗ Failed to load — check URL and server';
        statusEl.style.color = '#f77';
      }
    }
  }, 300);
  return result;
};

// Show a dismissible banner prompting to restore saved point clouds
function showPcRestorePrompt(urls) {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;
  const n = urls.length;
  const banner = document.createElement('div');
  banner.id = 'session_pc_prompt';
  banner.className = 'alert alert-info alert-dismissible';
  banner.style.cssText = 'font-size:12px; padding:6px 12px; margin:4px 0 0; display:flex; align-items:center; gap:8px;';
  banner.innerHTML = `
    <span>Restore ${n} point cloud${n > 1 ? 's' : ''} from last session?</span>
    <button id="session_pc_yes" class="btn btn-sm btn-primary" style="padding:1px 8px; font-size:11px;">Yes</button>
    <button id="session_pc_no"  class="btn btn-sm btn-secondary" style="padding:1px 8px; font-size:11px;">No</button>
  `;
  toolbar.prepend(banner);
  document.getElementById('session_pc_yes').addEventListener('click', () => {
    urls.forEach(url => window.addPC(url));
    banner.remove();
  });
  document.getElementById('session_pc_no').addEventListener('click', () => banner.remove());
}


// ── CalTopo KML Network Link ──────────────────────────────────────────────────

const caltopoState = {
  url:        null,
  interval:   30,
  dataSource: null,
  pollTimer:  null,
};

/** Normalize various CalTopo URL forms → the canonical ?format=kml data URL, or null.
 *  Accepted forms:
 *    https://caltopo.com/m/UUQ119H
 *    https://caltopo.com/m/UUQ119H?format=kml   (already correct)
 *    UUQ119H                                     (bare map ID)
 */
function _normalizeCaltopoUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  // Bare map ID — alphanumeric, 3-10 chars
  if (/^[A-Za-z0-9]{3,10}$/.test(trimmed)) {
    return `https://caltopo.com/m/${trimmed}?format=kml`;
  }
  // Any caltopo.com/m/ID form (with or without ?format=kml)
  const match = trimmed.match(/caltopo\.com\/m\/([A-Za-z0-9]+)/i);
  if (match) {
    return `https://caltopo.com/m/${match[1]}?format=kml`;
  }
  return null;
}

function _setCaltopoStatus(msg, color) {
  const el = document.getElementById('caltopo_status');
  if (el) { el.textContent = msg; el.style.color = color || '#ccc'; }
}

async function _fetchCaltopoKml() {
  if (!caltopoState.url) return;
  const proxiedUrl = ProxyUrlGenerator.generateProxyUrl(caltopoState.url);
  try {
    _setCaltopoStatus('updating…', '#aaa');
    const ds = await Cesium.KmlDataSource.load(proxiedUrl, {
      camera:        cesiumViewer.scene.camera,
      canvas:        cesiumViewer.scene.canvas,
      clampToGround: true,
    });
    if (caltopoState.dataSource) {
      cesiumViewer.dataSources.remove(caltopoState.dataSource, true);
    }
    ds.name = 'CalTopo';
    cesiumViewer.dataSources.add(ds);
    caltopoState.dataSource = ds;
    syncMinimapCaltopoFeatures(ds);
    const t = new Date().toLocaleTimeString();
    _setCaltopoStatus(`✓ loaded ${t}`, '#8f8');
    renderCaltopoStatus();
  } catch (e) {
    console.warn('[caltopo] load failed:', e);
    _setCaltopoStatus('⚠ load failed — check URL/proxy', '#f88');
    renderCaltopoStatus();
  }
}

async function loadCaltopoKml(rawUrl, intervalSecs) {
  const kmlUrl = _normalizeCaltopoUrl(rawUrl);
  if (!kmlUrl) {
    _setCaltopoStatus('⚠ invalid CalTopo URL', '#f88');
    return;
  }
  _clearCaltopoTimers();
  caltopoState.url      = kmlUrl;
  caltopoState.interval = intervalSecs;

  await _fetchCaltopoKml();

  if (intervalSecs > 0) {
    caltopoState.pollTimer = setInterval(_fetchCaltopoKml, intervalSecs * 1000);
  }

  notifyCaltopoChanged(kmlUrl, intervalSecs);
}

function _clearCaltopoTimers() {
  if (caltopoState.pollTimer) {
    clearInterval(caltopoState.pollTimer);
    caltopoState.pollTimer = null;
  }
}

function clearCaltopo() {
  _clearCaltopoTimers();
  if (caltopoState.dataSource) {
    cesiumViewer.dataSources.remove(caltopoState.dataSource, true);
    caltopoState.dataSource = null;
  }
  if (miniMapCaltopoSource) miniMapCaltopoSource.clear();
  caltopoState.url = null;
  _setCaltopoStatus('', '');
  notifyCaltopoChanged(null, 30);
  renderCaltopoStatus();
}

// ── Layers Panel ──────────────────────────────────────────────────────────────

/** Toggle a .lp-section-body open/closed */
window._lpToggle = function(headerEl) {
  const body  = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector('.lp-section-arrow');
  const open  = body.classList.toggle('open');
  if (arrow) arrow.style.transform = open ? '' : 'rotate(-90deg)';
  // Persist collapse state if this section has an ID
  if (body.id) notifyPanelSectionToggled(body.id, open);
};

// ── Point Cloud list ──────────────────────────────────────────────────────────

function renderPcList() {
  const container = document.getElementById('lp-pc-list');
  if (!container) return;
  const pcs = potreeViewer?.scene?.pointclouds || [];
  if (pcs.length === 0) {
    container.innerHTML = '<div class="lp-empty">No point clouds loaded</div>';
    return;
  }
  container.innerHTML = '';
  pcs.forEach((pc, i) => {
    const row = document.createElement('div');
    row.className = 'lp-row';
    const name = pc.name || pc.pcoGeometry?.url?.split('/').slice(-2, -1)[0] || `PC ${i + 1}`;
    row.innerHTML =
      `<button class="lp-eye-btn" title="Toggle visibility">${pc.visible !== false ? '👁' : '🚫'}</button>` +
      `<span class="lp-row-name" title="${name}">${name}</span>` +
      `<button class="lp-remove-btn" title="Remove">✕</button>`;
    row.querySelector('.lp-eye-btn').addEventListener('click', () => {
      pc.visible = pc.visible === false ? true : false;
      renderPcList();
    });
    row.querySelector('.lp-remove-btn').addEventListener('click', () => removePc(pc));
    container.appendChild(row);
  });
}

function removePc(pc) {
  const pcs = potreeViewer.scene.pointclouds;
  const children = potreeViewer.scene.scenePointCloud.children;
  const ci = children.indexOf(pc);
  if (ci !== -1) children.splice(ci, 1);
  const pi = pcs.indexOf(pc);
  if (pi !== -1) pcs.splice(pi, 1);
  renderPcList();
  saveSession();
}


// ── Data Files list ───────────────────────────────────────────────────────────

const loadedDataFiles = [];
let _dataFileIdCounter = 0;

function renderDataFileList() {
  const container = document.getElementById('lp-data-list');
  if (!container) return;
  if (loadedDataFiles.length === 0) {
    container.innerHTML = '<div class="lp-empty">No data files loaded</div>';
    return;
  }
  container.innerHTML = '';
  loadedDataFiles.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'lp-row';
    row.innerHTML =
      `<button class="lp-eye-btn" title="Toggle visibility">${entry.show ? '👁' : '🚫'}</button>` +
      `<span class="lp-row-name" title="${entry.label}">${entry.label}</span>` +
      `<span class="lp-badge">${entry.type}</span>` +
      `<button class="lp-remove-btn" title="Remove">✕</button>`;
    row.querySelector('.lp-eye-btn').addEventListener('click', () => {
      entry.show = !entry.show;
      if (entry.dataSource) entry.dataSource.show = entry.show;
      renderDataFileList();
    });
    row.querySelector('.lp-remove-btn').addEventListener('click', () => removeDataFile(entry.id));
    container.appendChild(row);
  });
}

async function addDataFile(fileOrUrl, label) {
  let ds, type, entryLabel;
  try {
    if (typeof fileOrUrl === 'string') {
      const url = fileOrUrl;
      const ext = url.split('?')[0].split('.').pop().toLowerCase();
      type = (ext === 'geojson' || ext === 'json') ? 'geojson' : (ext === 'kmz' ? 'kmz' : 'kml');
      entryLabel = label || url.split('/').pop().split('?')[0] || url;
      const proxied = url.startsWith('http') ? ProxyUrlGenerator.generateProxyUrl(url) : url;
      if (type === 'geojson' || type === 'json') {
        ds = await Cesium.GeoJsonDataSource.load(proxied);
      } else {
        ds = await Cesium.KmlDataSource.load(proxied, {
          camera: cesiumViewer.scene.camera,
          canvas: cesiumViewer.scene.canvas,
          clampToGround: true,
        });
      }
    } else {
      // File object
      const file = fileOrUrl;
      const ext = file.name.split('.').pop().toLowerCase();
      type = (ext === 'geojson' || ext === 'json') ? 'geojson' : (ext === 'kmz' ? 'kmz' : 'kml');
      entryLabel = label || file.name;
      const objectUrl = URL.createObjectURL(file);
      if (type === 'geojson' || type === 'json') {
        ds = await Cesium.GeoJsonDataSource.load(objectUrl);
      } else {
        ds = await Cesium.KmlDataSource.load(objectUrl, {
          camera: cesiumViewer.scene.camera,
          canvas: cesiumViewer.scene.canvas,
          clampToGround: true,
        });
      }
    }
    cesiumViewer.dataSources.add(ds);
    const entry = {
      id: ++_dataFileIdCounter,
      label: entryLabel,
      type,
      url: typeof fileOrUrl === 'string' ? fileOrUrl : null,
      dataSource: ds,
      show: true,
    };
    loadedDataFiles.push(entry);
    renderDataFileList();
    notifyDataFilesChanged(loadedDataFiles);
  } catch (err) {
    console.error('[layers] addDataFile failed:', err);
    alert('Failed to load file: ' + err.message);
  }
}

function removeDataFile(id) {
  const idx = loadedDataFiles.findIndex(e => e.id === id);
  if (idx === -1) return;
  const entry = loadedDataFiles[idx];
  if (entry.dataSource) cesiumViewer.dataSources.remove(entry.dataSource, true);
  loadedDataFiles.splice(idx, 1);
  renderDataFileList();
  notifyDataFilesChanged(loadedDataFiles);
}

window._addDataFile = function() {
  // Try file picker first, fall back to URL prompt
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.kml,.kmz,.geojson,.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (file) addDataFile(file);
  };
  input.click();
};

window.addKMZ = function() { window._addDataFile(); };

// ── Points of Interest panel list ─────────────────────────────────────────────

function renderPoiList() {
  const list   = document.getElementById('lp-poi-list');
  const group  = document.getElementById('lp-poi-group');
  const badge  = document.getElementById('lp-poi-count-badge');
  if (!list) return;

  const entities = cesiumViewer.entities.values.filter(
    e => e.properties && e.properties.isUserLabel
  );

  // Update count badge
  if (badge) {
    badge.textContent = entities.length;
    badge.style.display = entities.length ? 'inline' : 'none';
  }
  if (group) group.style.display = entities.length ? 'block' : 'none';

  list.innerHTML = '';
  entities.forEach(entity => {
    const name = (entity.label && entity.label.text && entity.label.text.getValue
      ? entity.label.text.getValue(Cesium.JulianDate.now())
      : entity.label?.text) || entity.id;
    const row = document.createElement('div');
    row.className = 'lp-row';
    row.innerHTML =
      `<span class="lp-row-name" style="font-size:10px;" title="${name}">${name}</span>` +
      `<button class="lp-remove-btn" title="Delete">✕</button>`;
    row.querySelector('.lp-remove-btn').addEventListener('click', () => {
      cesiumViewer.entities.remove(entity);
      renderPoiList();
    });
    list.appendChild(row);
  });
}

window._exportPoi = function(format) {
  const entities = new Cesium.EntityCollection();
  cesiumViewer.entities.values
    .filter(e => e.properties && e.properties.isUserLabel)
    .forEach(e => entities.add(e));

  if (format === 'kmz') {
    Cesium.exportKml({ entities, kmz: true })
      .then(r => downloadBlob('points_of_interest.kmz', r.kmz))
      .catch(console.error);
  } else {
    // GeoJSON — build manually from entity positions
    const features = cesiumViewer.entities.values
      .filter(e => e.properties && e.properties.isUserLabel && e.position)
      .map(e => {
        const cart = e.position.getValue(Cesium.JulianDate.now());
        const carto = Cesium.Cartographic.fromCartesian(cart);
        const name = (e.label?.text?.getValue
          ? e.label.text.getValue(Cesium.JulianDate.now())
          : e.label?.text) || '';
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [
            Cesium.Math.toDegrees(carto.longitude),
            Cesium.Math.toDegrees(carto.latitude),
            carto.height
          ]},
          properties: { name }
        };
      });
    const geojson = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    const blob = new Blob([geojson], { type: 'application/geo+json' });
    downloadBlob('points_of_interest.geojson', blob);
  }
};

// ── CalTopo status row ────────────────────────────────────────────────────────

function renderCaltopoStatus() {
  const dot  = document.getElementById('lp-ct-dot');
  const text = document.getElementById('lp-ct-text');
  if (!dot || !text) return;
  if (caltopoState.url) {
    const id = (caltopoState.url.match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || caltopoState.url;
    dot.style.color  = '#4f4';
    text.textContent = `Active — ${id}`;
  } else {
    dot.style.color  = 'rgba(255,255,255,0.3)';
    text.textContent = 'Not loaded';
  }
}

// ── Cave Survey ───────────────────────────────────────────────────────────────
//
// Each imported survey is stored as:
//   { name, parsed, entities: Cesium.EntityCollection-like[], visible: true }
// Entities are added directly to cesiumViewer.entities (not a DataSource)
// so we have fine-grained control over each polyline / point.

let _caveImports = [];       // Array of { name, parsed, cesiumIds, visible }
let _cwizParsed  = null;     // Holds last-parsed PLT data while wizard is open

// ── Recents (EPT + PLT) ───────────────────────────────────────────────────────
// recents.json stores only lightweight metadata — NO rawText.
// PLT file contents are stored as individual files via /api/plt-cache so that
// large PLT files (600KB+) don't bloat the JSON payload and cause silent failures.
let _recents = { ept: [], plt: [] };
const RECENTS_MAX = 12;

async function _loadRecents() {
  try {
    const r = await fetch('/api/recents');
    if (r.ok) _recents = await r.json();
    if (!Array.isArray(_recents.ept)) _recents.ept = [];
    if (!Array.isArray(_recents.plt)) _recents.plt = [];
  } catch(e) {
    console.warn('[recents] load failed:', e);
    _recents = { ept: [], plt: [] };
  }
  _renderEptRecents();
  _renderPltRecents();
}

async function _saveRecents() {
  // Strip any legacy rawText before saving so the payload stays small
  const payload = {
    ept: _recents.ept,
    plt: _recents.plt.map(({ rawText: _drop, ...rest }) => rest),
  };
  try {
    const r = await fetch('/api/recents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.warn('[recents] save returned', r.status);
  } catch(e) {
    console.warn('[recents] save failed:', e);
  }
}

async function _savePltCache(name, rawText) {
  try {
    const r = await fetch('/api/plt-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text: rawText }),
    });
    if (!r.ok) console.warn('[plt-cache] save returned', r.status);
  } catch(e) {
    console.warn('[plt-cache] save failed:', e);
  }
}

async function _fetchPltCache(name) {
  try {
    const r = await fetch('/api/plt-cache?name=' + encodeURIComponent(name));
    if (r.ok) return await r.text();
    console.warn('[plt-cache] fetch returned', r.status, 'for', name);
  } catch(e) {
    console.warn('[plt-cache] fetch failed:', e);
  }
  return null;
}

function _addEptRecent(url, name) {
  _recents.ept = _recents.ept.filter(r => r.url !== url);
  _recents.ept.unshift({ url, name, lastUsed: new Date().toISOString() });
  if (_recents.ept.length > RECENTS_MAX) _recents.ept.length = RECENTS_MAX;
  _saveRecents();
  _renderEptRecents();
}

function _addPltRecent(name, rawText, georef, displayOptions) {
  // Save raw text to its own server-side file, not into recents.json
  _savePltCache(name, rawText);
  // Only lightweight metadata goes into recents index
  _recents.plt = _recents.plt.filter(r => r.name !== name);
  _recents.plt.unshift({ name, georef, displayOptions: displayOptions || null, lastUsed: new Date().toISOString() });
  if (_recents.plt.length > RECENTS_MAX) _recents.plt.length = RECENTS_MAX;
  _saveRecents();
  _renderPltRecents();
}

function _removeEptRecent(url) {
  _recents.ept = _recents.ept.filter(r => r.url !== url);
  _saveRecents();
  _renderEptRecents();
}

function _removePltRecent(name) {
  _recents.plt = _recents.plt.filter(r => r.name !== name);
  _saveRecents();
  _renderPltRecents();
}

function _renderEptRecents() {
  const el = document.getElementById('lp-ept-recents');
  if (!el) return;
  if (!_recents.ept.length) { el.innerHTML = ''; return; }
  const rows = _recents.ept.map((r, i) => {
    const label = r.name || r.url;
    const shortUrl = r.url.length > 60 ? '…' + r.url.slice(-57) : r.url;
    return `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:9px;color:rgba(255,255,255,0.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${r.url}">${label}</div>
        <div style="font-size:8px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortUrl}</div>
      </div>
      <button onclick="window._loadEptRecent(${i})" style="font-size:9px;padding:1px 6px;background:rgba(0,120,255,0.2);border:1px solid rgba(0,120,255,0.35);color:#8cf;border-radius:3px;cursor:pointer;white-space:nowrap;flex-shrink:0;">Load</button>
      <button onclick="window._removeEptRecent(${i})" title="Remove" style="font-size:9px;padding:1px 4px;background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;flex-shrink:0;">✕</button>
    </div>`;
  }).join('');
  el.innerHTML = `<div style="margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.08);">
    <div style="font-size:9px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:3px;">Recent EPT</div>
    ${rows}
  </div>`;
}

function _renderPltRecents() {
  const el = document.getElementById('lp-plt-recents');
  if (!el) return;
  if (!_recents.plt.length) { el.innerHTML = ''; return; }
  const rows = _recents.plt.map((r, i) => {
    const georefLabel = r.georef
      ? (r.georef.mode === 'anchor'
        ? `${Number(r.georef.lat).toFixed(4)}°, ${Number(r.georef.lon).toFixed(4)}°`
        : `UTM ${r.georef.zone}${r.georef.south ? 'S' : 'N'}`)
      : 'no georef stored';
    return `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:9px;color:rgba(255,255,255,0.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.name}</div>
        <div style="font-size:8px;color:rgba(255,255,255,0.35);">${georefLabel}</div>
      </div>
      <button onclick="window._loadPltRecent(${i})" style="font-size:9px;padding:1px 6px;background:rgba(0,200,120,0.15);border:1px solid rgba(0,200,120,0.3);color:#8fa;border-radius:3px;cursor:pointer;white-space:nowrap;flex-shrink:0;">Load</button>
      <button onclick="window._removePltRecent(${i})" title="Remove" style="font-size:9px;padding:1px 4px;background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;flex-shrink:0;">✕</button>
    </div>`;
  }).join('');
  el.innerHTML = `<div style="margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.08);">
    <div style="font-size:9px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:3px;">Recent PLT</div>
    ${rows}
  </div>`;
}

window._loadEptRecent = function(i) {
  const r = _recents.ept[i];
  if (!r) return;
  const statusEl = document.getElementById('lp-pc-status');
  if (statusEl) { statusEl.textContent = '⏳ Loading…'; statusEl.style.color = '#aaa'; }
  try { window.addPC(r.url); } catch(e) {
    if (statusEl) { statusEl.textContent = '✗ ' + (e.message || e); statusEl.style.color = '#f77'; }
  }
};

window._removeEptRecent = function(i) {
  if (_recents.ept[i]) { _recents.ept.splice(i, 1); _saveRecents(); _renderEptRecents(); }
};

window._removePltRecent = function(i) {
  if (_recents.plt[i]) { _recents.plt.splice(i, 1); _saveRecents(); _renderPltRecents(); }
};

// Holds pending georef when cache misses and user must re-select the PLT file
let _pltRestorePending = null;

// Wire the hidden restore input once DOM is ready (called at init time below)
function _initPltRestoreInput() {
  const inp = document.getElementById('plt-restore-input');
  if (!inp) return;
  inp.addEventListener('change', () => {
    const file = inp.files[0];
    inp.value = '';
    if (!file || !_pltRestorePending) return;
    const pending = _pltRestorePending;
    _pltRestorePending = null;
    const reader = new FileReader();
    reader.onload = ev => {
      const rawText = ev.target.result;
      let parsed;
      try { parsed = parsePLT(rawText); } catch(e) {
        console.error('[cave] restore re-parse failed:', e); return;
      }
      parsed._fileName = file.name.replace(/\.plt$/i, '');
      parsed._rawText  = rawText;
      // Re-cache so next Load works without the file picker
      _savePltCache(pending.name, rawText);
      if (!pending.georef) {
        _cwizParsed = parsed;
        window._importCavePLT();
        return;
      }
      let entry;
      if (pending.georef.mode === 'anchor') {
        entry = renderCaveSurveyAnchored(pending.name, parsed, pending.georef.station, pending.georef.lat, pending.georef.lon, pending.georef.elev, pending.georef.survey || '', pending.georef.declination ?? null);
      } else {
        entry = renderCaveSurveyUTM(pending.name, parsed, pending.georef.zone, pending.georef.south);
      }
      _finishCaveLoad(entry);
    };
    reader.readAsText(file);
  });
}

window._loadPltRecent = async function(i) {
  const r = _recents.plt[i];
  if (!r) return;

  // Fetch the cached PLT text from the server — no file picker needed
  const rawText = await _fetchPltCache(r.name);
  if (!rawText) {
    // Cache miss (server restarted or first load). Ask user to re-select the file;
    // georef will be applied automatically — no wizard needed.
    console.warn('[cave] PLT cache missing for', r.name, '— prompting re-select');
    _pltRestorePending = { name: r.name, georef: r.georef };
    const inp = document.getElementById('plt-restore-input');
    if (inp) {
      // Show a small banner in the recents area, then trigger picker
      const el = document.getElementById('lp-plt-recents');
      if (el) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:10px;color:#fa0;padding:3px 6px;border:1px solid rgba(255,160,0,0.3);border-radius:3px;margin-bottom:4px;';
        note.textContent = '⚠ Cache expired for “' + r.name + '” — re-select the .plt file to reload.';
        el.prepend(note);
        setTimeout(() => { try { el.removeChild(note); } catch(_) {} }, 6000);
      }
      inp.click();
    } else {
      alert('PLT file cache missing for "' + r.name + '".\nPlease use the + Cave Import button to re-load the file.');
    }
    return;
  }

  let parsed;
  try { parsed = parsePLT(rawText); } catch(e) {
    console.error('[cave] PLT re-parse failed:', e); return;
  }
  parsed._fileName = r.name;
  parsed._rawText  = rawText;

  if (!r.georef) {
    // No georef saved — open wizard pre-loaded
    _cwizParsed = parsed;
    window._importCavePLT();
    return;
  }
  // Georef saved — skip wizard and place directly
  let entry;
  if (r.georef.mode === 'anchor') {
    entry = renderCaveSurveyAnchored(r.name, parsed, r.georef.station, r.georef.lat, r.georef.lon, r.georef.elev, r.georef.survey || '', r.georef.declination ?? null);
    // Restore saved control points and re-warp
    if (entry && r.georef.controlPoints && r.georef.controlPoints.length) {
      entry.georef.controlPoints = r.georef.controlPoints;
    }
    // Restore saved display options
    if (entry && r.displayOptions) {
      entry.displayOptions = r.displayOptions;
    } else if (entry) {
      entry.displayOptions = _defaultDisplayOptions(entry.parsed);
    }
    if (entry) _rerenderCave(_caveImports.indexOf(entry));
  } else {
    entry = renderCaveSurveyUTM(r.name, parsed, r.georef.zone, r.georef.south);
  }
  _finishCaveLoad(entry);
};

// ── UTM → WGS84 (Transverse Mercator inverse, WGS84 ellipsoid) ───────────────
function utmToLatLon(easting, northing, zoneNum, isNorth) {
  const a  = 6378137.0;
  const f  = 1 / 298.257223563;
  const e2 = 2*f - f*f;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const E0 = 500000;
  const N0 = isNorth ? 0 : 10000000;

  const lon0 = ((zoneNum - 1) * 6 - 180 + 3) * Math.PI / 180;
  const M    = (northing - N0) / k0;
  const mu   = M / (a * (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256));

  const e1  = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3*e1/2 - 27*Math.pow(e1,3)/32) * Math.sin(2*mu)
    + (21*e1*e1/16 - 55*Math.pow(e1,4)/32) * Math.sin(4*mu)
    + (151*Math.pow(e1,3)/96) * Math.sin(6*mu);

  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1)**2);
  const T1 = Math.tan(phi1)**2;
  const C1 = ep2 * Math.cos(phi1)**2;
  const R1 = a*(1-e2) / Math.pow(1 - e2*Math.sin(phi1)**2, 1.5);
  const D  = (easting - E0) / (N1 * k0);

  const lat = phi1 - (N1*Math.tan(phi1)/R1) * (
    D*D/2
    - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * Math.pow(D,4)/24
    + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * Math.pow(D,6)/720
  );

  const lon = lon0 + (
    D
    - (1 + 2*T1 + C1) * Math.pow(D,3)/6
    + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * Math.pow(D,5)/120
  ) / Math.cos(phi1);

  return { lat: lat*180/Math.PI, lon: lon*180/Math.PI };
}

// ── Compass PLT parser ────────────────────────────────────────────────────────
// Returns { segments, stations, fixedStations, utmZone, utmSouth, datum }
// All metric distances in metres; coords are survey-local N/E/V in metres.
function parsePLT(text) {
  const lines = text.split(/\r?\n/);
  const result = {
    segments:      [],  // [{points:[{n,e,v,excluded}], survey?}]
    stations:      [],  // [{n,e,v,name,survey,surveyDesc}]
    fixedStations: [],  // [{name,n,e,v}] — UTM metres
    surveys:       [],  // [{code,desc}] in order encountered
    utmZone:       null,
    utmSouth:      false,
    datum:         null,
  };

  let currentSeg    = null;
  let lastPt        = null;
  let currentSurvey = null;  // {code, desc}

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Fixed station: P<name><whitespace><N> <E> <V>
    // Matches lines like:  PSURVEYBASE 4136789.3 567234.1 1234.5
    if (/^P\S+\s+[\d.\-]+\s+[\d.\-]+\s+[\d.\-]+/.test(line)) {
      const m = line.match(/^P(\S+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
      if (m) {
        result.fixedStations.push({
          name: m[1],
          n: parseFloat(m[2]) * 0.3048,  // feet → metres
          e: parseFloat(m[3]) * 0.3048,
          v: parseFloat(m[4]) * 0.3048,
        });
      }
      continue;
    }

    const cmd  = line[0];
    const rest = line.slice(1).trim();

    if (cmd === 'O') {
      result.datum = rest;
    } else if (cmd === 'N') {
      // Survey name line: N<code> <day-of-week> <month> <day> <year> C<description>
      // e.g. "NME D 3 24 2013 CMeatgrinder via Osterizer"
      const nCode = rest.split(/\s+/)[0] || rest;
      const nDescM = rest.match(/C(.+)$/);
      const nDesc = nDescM ? nDescM[1].trim() : '';
      currentSurvey = { code: nCode, desc: nDesc };
      result.surveys.push({ code: nCode, desc: nDesc });
      // New survey starts a new segment context
      currentSeg = null;
      lastPt = null;
    } else if (cmd === 'G') {
      const z = parseInt(rest, 10);
      result.utmZone  = Math.abs(z);
      result.utmSouth = z < 0;
    } else if (cmd === 'M' || cmd === 'D' || cmd === 'd') {
      // Strip trailing quoted comment ("...") then tokenize
      const _commentMatch = rest.match(/"([^"]*)"$/);
      const stripped = _commentMatch ? rest.slice(0, _commentMatch.index).trim() : rest.trim();
      const _lineComment = _commentMatch ? _commentMatch[1].trim() : null;
      const parts = stripped.split(/\s+/);
      if (parts.length >= 3) {
        const pt = {
          n:        parseFloat(parts[0]) * 0.3048,
          e:        parseFloat(parts[1]) * 0.3048,
          v:        parseFloat(parts[2]) * 0.3048,
          excluded: cmd === 'd',
          comment:  _lineComment || null,
        };
        if (cmd === 'M') {
          currentSeg = { points: [pt], survey: currentSurvey?.code || '', surveyDesc: currentSurvey?.desc || '' };
          result.segments.push(currentSeg);
        } else if (currentSeg) {
          currentSeg.points.push(pt);
        }
        lastPt = pt;

        // Parse inline tokens after the three coordinates:
        //   S<name>               → station name
        //   P <l> <u> <d> <r>    → LRUD passage dimensions
        //   I <dist>              → distance from entrance
        //   F or F<flags>         → flags (skip)
        let ti = 3;
        while (ti < parts.length) {
          const tok = parts[ti];
          if (tok.length > 1 && tok[0] === 'S') {
            // Inline station name: S<name> (e.g. S0, SA1, SDA11, SBC2, SC2a)
            pt.name = tok.slice(1).trim();
          } else if (tok === 'P' && ti + 4 < parts.length) {
            // Inline LRUD dimensions
            pt.lrud = {
              l: parseFloat(parts[ti+1]) * 0.3048,
              u: parseFloat(parts[ti+2]) * 0.3048,
              d: parseFloat(parts[ti+3]) * 0.3048,
              r: parseFloat(parts[ti+4]) * 0.3048,
            };
            ti += 4;
          } else if (tok === 'I' && ti + 1 < parts.length) {
            // Inline distance from entrance
            pt.dist = parseFloat(parts[ti+1]) * 0.3048;
            ti += 1;
          } else if (tok[0] === 'F') {
            pt.flags = tok.slice(1);  // e.g. 'S'=surface, 'L'=loop, 'P'=passage
            if (pt.flags.includes('S')) {
              if (currentSeg) currentSeg.isSurface = true;
              pt.isSurface = true;
            }
          }
          ti++;
        }
        // If station name found inline, add to stations list
        if (pt.name) {
          result.stations.push({ ...pt, survey: currentSurvey?.code || '', surveyDesc: currentSurvey?.desc || '' });
        }
      }
    } else if (cmd === 'S' && lastPt && !lastPt.name) {
      // Standalone S line: only use if point doesn't already have an inline name
      const sname = rest.trim();
      if (sname && !/^[A-Z]\s/.test(sname)) {  // skip survey-header S lines like "SBIGFOOT-MF"
        lastPt.name = sname;
        result.stations.push({ ...lastPt, name: sname, survey: currentSurvey?.code || '', surveyDesc: currentSurvey?.desc || '' });
      }
    } else if (cmd === 'P' && lastPt && !lastPt.lrud && /^[\d.\-]+\s/.test(rest)) {
      // Standalone P line for LRUD (only if not already set inline)
      const parts = rest.split(/\s+/);
      if (parts.length >= 4) {
        lastPt.lrud = {
          l: parseFloat(parts[0]) * 0.3048,
          u: parseFloat(parts[1]) * 0.3048,
          d: parseFloat(parts[2]) * 0.3048,
          r: parseFloat(parts[3]) * 0.3048,
        };
      }
    } else if (cmd === 'I' && lastPt && lastPt.dist == null) {
      // Standalone I line for distance (only if not already set inline)
      lastPt.dist = parseFloat(rest) * 0.3048;
    }
  }

  // Post-parse: mark stations as surface if:
  //   1. Their coordinates appear in a surface-flagged segment (FS flag), OR
  //   2. Their survey has no shots at all (station-only surveys = surface benchmarks)
  const _surveyHasShots = new Set(result.segments.map(s => s.survey));
  const _surfaceKeys = new Set();
  for (const seg of result.segments) {
    if (seg.isSurface) {
      for (const pt of seg.points) {
        _surfaceKeys.add(`${pt.e.toFixed(2)},${pt.n.toFixed(2)},${pt.v.toFixed(2)}`);
      }
    }
  }
  for (const stn of result.stations) {
    if (!_surveyHasShots.has(stn.survey)) { stn.isSurface = true; continue; }
    const key = `${stn.e.toFixed(2)},${stn.n.toFixed(2)},${stn.v.toFixed(2)}`;
    if (_surfaceKeys.has(key)) stn.isSurface = true;
  }

  return result;
}

// ── Convert parsed PLT coords → Cesium Cartesian3 positions ──────────────────
// Uses the UTM zone from the file (or override from wizard).
// Returns null if georef fails.
function _pltToCartesian(parsed, zoneOverride, southOverride) {
  const zone   = zoneOverride  ?? parsed.utmZone;
  const isNorth = southOverride !== undefined ? !southOverride : !parsed.utmSouth;

  if (!zone) return null;

  const convert = (n, e, v) => {
    const { lat, lon } = utmToLatLon(e, n, zone, isNorth);
    return Cesium.Cartesian3.fromDegrees(lon, lat, v);
  };

  // Build polyline position arrays per segment
  const segPositions = parsed.segments.map(seg =>
    seg.points
      .filter(p => !p.excluded)
      .map(p => convert(p.n, p.e, p.v))
      .filter(Boolean)
  ).filter(arr => arr.length >= 2);

  // Station positions
  const stationPositions = parsed.stations.map(s => ({
    pos:  convert(s.n, s.e, s.v),
    name: s.name,
    dist: s.dist,
  })).filter(x => x.pos);

  return { segPositions, stationPositions };
}

// ── Show / hide all cave survey entities ─────────────────────────────────────
function setCaveSurveyVisible(visible) {
  for (const imp of _caveImports) {
    imp.visible = visible;
    for (const id of imp.cesiumIds) {
      const e = cesiumViewer.entities.getById(id);
      if (e) e.show = visible;
    }
  }
  notifyCaveVisibilityChanged(visible);
}

// ── Render the cave import list in the panel ──────────────────────────────────
function _renderCaveList() {
  const list = document.getElementById('lp-cave-list');
  if (!list) return;
  if (!_caveImports.length) { list.innerHTML = ''; return; }

  list.innerHTML = _caveImports.map((imp, i) => {
    const g = imp.georef;
    let infoHtml = '';
    if (g) {
      if (g.mode === 'anchor') {
        const cpCount = (g.controlPoints && g.controlPoints.length) || 0;
        infoHtml = `
          <div style="font-size:10px; color:rgba(255,255,255,0.55); padding:5px 0 3px; border-top:1px solid rgba(255,255,255,0.08); margin-top:3px;">
            <div style="opacity:0.45; font-size:9px; margin-bottom:6px;">
              ${imp.parsed.segments.length} segs · ${imp.parsed.stations.length} stations${cpCount ? ' · <b style="color:#fd8;">' + cpCount + ' CPs</b>' : ''}
            </div>
            <div style="display:flex; gap:5px;">
              <button onclick="window._openRectifyPanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(255,200,50,0.15);border:1px solid rgba(255,200,50,0.4);color:#fd8;border-radius:4px;cursor:pointer;flex:1;" title="Georeference by pinning stations to known positions">
                🎯 Rectify${cpCount ? ' (' + cpCount + ')' : ''}
              </button>
              <button onclick="window._openStylePanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(180,100,255,0.15);border:1px solid rgba(180,100,255,0.4);color:#c8a0ff;border-radius:4px;cursor:pointer;flex:1;" title="Survey display options">
                🎨 Style
              </button>
            </div>
          </div>`;
      } else if (g.mode === 'utm') {
        infoHtml = `
          <div style="font-size:10px; color:rgba(255,255,255,0.55); padding:5px 0 3px; border-top:1px solid rgba(255,255,255,0.08); margin-top:3px;">
            <div>Mode: UTM Zone <b>${g.zone}${g.south ? 'S' : 'N'}</b></div>
            <div style="margin-top:4px; opacity:0.45; font-size:9px;">
              ${imp.parsed.segments.length} segments · ${imp.parsed.stations.length} stations
            </div>
          </div>`;
      }
    } else {
      infoHtml = `<div style="font-size:9px; color:rgba(255,255,255,0.3); padding:3px 0; border-top:1px solid rgba(255,255,255,0.08); margin-top:3px;">No georef info stored</div>`;
    }

    return `
      <div style="padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
        <div class="lp-row" style="gap:4px;">
          <input type="checkbox" ${imp.visible ? 'checked' : ''} onchange="window._toggleCaveImport(${i}, this.checked)" style="margin:0; flex-shrink:0;">
          <span class="lp-row-name" style="font-size:10px; cursor:pointer;" title="${imp.name}" onclick="window._toggleCaveInfo(${i})">${imp.name}</span>
          <button onclick="window._toggleCaveInfo(${i})" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0;" title="Info / Edit">ℹ</button>
          <button onclick="window._removeCaveImport(${i})" style="background:none;border:none;color:#f88;cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0;" title="Remove">✕</button>
        </div>
        <div id="cave-info-${i}" style="display:none; padding-left:14px;">${infoHtml}</div>
      </div>`;
  }).join('');
}

window._toggleCaveInfo = function(i) {
  const panel = document.getElementById(`cave-info-${i}`);
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

// When a cave entity is selected on the globe, expand and highlight its survey in the list
cesiumViewer.selectedEntityChanged.addEventListener(function(entity) {
  if (!entity) return;
  const props = entity.properties;
  if (!props) return;
  const isCave = props.isCaveSurvey && props.isCaveSurvey.getValue();
  if (!isCave) return;
  const surveyName = props.surveyName && props.surveyName.getValue();
  if (!surveyName) return;

  const idx = _caveImports.findIndex(imp => imp.name === surveyName);
  if (idx < 0) return;

  const surveyCode = props.surveyCode ? props.surveyCode.getValue() : '';

  // Open style panel for this import (or refresh if already open for it)
  window._openStylePanel(idx);

  // After the panel renders, find and highlight the matching survey color row
  requestAnimationFrame(() => {
    const list = document.getElementById('style-survey-list');
    if (!list) return;
    const rows = list.querySelectorAll('[data-survey-code]');
    rows.forEach(r => r.style.background = '');
    const target = list.querySelector(`[data-survey-code="${CSS.escape(surveyCode)}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      target.style.transition = 'background 0.15s';
      target.style.background = 'rgba(255,220,80,0.25)';
      setTimeout(() => { target.style.background = ''; }, 1400);
    }
  });
});

window._editCaveAnchor = function(i, field, val) {
  const imp = _caveImports[i];
  if (!imp || !imp.georef) return;
  imp.georef[field] = val;
};

window._fetchCaveDecl = async function(i) {
  const imp = _caveImports[i];
  if (!imp || !imp.georef) return;
  const g = imp.georef;
  const inp = document.getElementById('cave-decl-input-' + i);
  if (!inp) return;
  const origColor = inp.style.color;
  inp.disabled = true;
  inp.style.color = '#aaa';
  try {
    const year = new Date().getFullYear();
    const r = await fetch('/api/declination?lat=' + g.lat + '&lon=' + g.lon + '&year=' + year);
    const data = await r.json();
    if (data.declination != null) {
      g.declination = data.declination;
      inp.value = data.declination.toFixed(2);
      inp.style.color = '#8fa';
      setTimeout(() => { inp.style.color = origColor; inp.disabled = false; }, 2000);
    } else {
      inp.style.color = '#f88';
      setTimeout(() => { inp.style.color = origColor; inp.disabled = false; }, 2000);
    }
  } catch(e) {
    inp.style.color = '#f88';
    setTimeout(() => { inp.style.color = origColor; inp.disabled = false; }, 2000);
  }
};

window._reanchorCave = async function(i) {
  const imp = _caveImports[i];
  if (!imp || !imp.georef || imp.georef.mode !== 'anchor') return;
  const result = await _startGlobePick('cesium');
  if (!result) return;
  imp.georef.lat  = result.lat;
  imp.georef.lon  = result.lon;
  imp.georef.elev = result.elev;
  window._rerenderCave(i);
};

// ── Cave display options ─────────────────────────────────────────────────────
const SURVEY_PALETTE = [
  '#00e5ff','#ff6b6b','#ffd93d','#6bcb77','#ff922b',
  '#cc5de8','#74c0fc','#f783ac','#a9e34b','#ffa94d',
  '#66d9e8','#d9480f','#e64980','#2f9e44','#1971c2',
];

function _defaultDisplayOptions(parsed) {
  const opts = { surveyColors: {}, hiddenSurveys: {}, surfaceSurveys: {}, showSurface: false, showLabels: false, showStations: true, stationColor: '#ffeb3b', stationSize: 5 };
  (parsed.surveys || []).forEach((sv, i) => {
    opts.surveyColors[sv.code] = SURVEY_PALETTE[i % SURVEY_PALETTE.length];
  });
  // Default: no surveys parsed → single color
  if (!parsed.surveys || !parsed.surveys.length) opts.surveyColors[''] = '#00e5ff';
  return opts;
}

window._rerenderCave = function(i) {
  const imp = _caveImports[i];
  if (!imp || !imp.georef) return;
  // Remove old entities
  for (const id of imp.cesiumIds) {
    const e = cesiumViewer.entities.getById(id);
    if (e) cesiumViewer.entities.remove(e);
  }
  imp.cesiumIds = [];
  // Re-render with updated georef
  const g = imp.georef;
  if (g.mode === 'anchor') {
    const anchorLocal = g.station === '__first__'
      ? imp.parsed.segments[0]?.points[0]
      : imp.parsed.stations.find(s => s.name === g.station) || imp.parsed.segments[0]?.points[0];
    if (!anchorLocal) return;
    const anchorCart = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.elev);
    let enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(anchorCart);
    const decl = g.declination;
    if (decl != null && decl !== 0) {
      const declRad = Cesium.Math.toRadians(decl);
      const rotZ = Cesium.Matrix4.fromRotationTranslation(
        Cesium.Matrix3.fromRotationZ(declRad), Cesium.Cartesian3.ZERO);
      enuMatrix = Cesium.Matrix4.multiply(enuMatrix, rotZ, new Cesium.Matrix4());
    }
    // Build control-point pairs in survey-ENU space (for warp)
    const controlPairsENU = [];
    if (g.controlPoints && g.controlPoints.length) {
      const invENU = Cesium.Matrix4.inverseTransformation(enuMatrix, new Cesium.Matrix4());
      for (const cp of g.controlPoints) {
        const stn = imp.parsed.stations.find(s => s.name === cp.station);
        if (!stn) continue;
        const src = { e: stn.e - anchorLocal.e, n: stn.n - anchorLocal.n, v: stn.v - anchorLocal.v };
        const cpCart = Cesium.Cartesian3.fromDegrees(cp.lon, cp.lat, cp.elev);
        const cpOff  = Cesium.Cartesian3.subtract(cpCart, anchorCart, new Cesium.Cartesian3());
        const cpENU  = Cesium.Matrix4.multiplyByPointAsVector(invENU, cpOff, new Cesium.Cartesian3());
        const dst = { e: cpENU.x, n: cpENU.y, v: cpENU.z };
        controlPairsENU.push({ src, dst });
      }
    }
    const convertFn  = (n, e, v) => {
      let dE = e - anchorLocal.e, dN = n - anchorLocal.n, dV = v - anchorLocal.v;
      if (controlPairsENU.length) {
        const warped = _computeWarpedOffset(dE, dN, dV, controlPairsENU);
        dE = warped.e; dN = warped.n; dV = warped.v;
      }
      const off = new Cesium.Cartesian4(dE, dN, dV, 0);
      const w   = Cesium.Matrix4.multiplyByVector(enuMatrix, off, new Cesium.Cartesian4());
      return new Cesium.Cartesian3(anchorCart.x + w.x, anchorCart.y + w.y, anchorCart.z + w.z);
    };
    // Build entities inline — uses displayOptions for per-survey colors, surface, labels
    const dopt = imp.displayOptions || _defaultDisplayOptions(imp.parsed);
    const stationCesiumColor = Cesium.Color.fromCssColorString(dopt.stationColor || '#ffeb3b');
    for (const seg of imp.parsed.segments) {
      if (dopt.hiddenSurveys && dopt.hiddenSurveys[seg.survey]) continue;
      const _segSurface = seg.isSurface || !!(dopt.surfaceSurveys && dopt.surfaceSurveys[seg.survey]);
      if (_segSurface && !dopt.showSurface) continue;
      const _activePts = seg.points.filter(p => !p.excluded);
      if (_activePts.length < 2) continue;
      const hexColor = dopt.surveyColors[seg.survey] || dopt.surveyColors[''] || '#00e5ff';
      const segColor = Cesium.Color.fromCssColorString(hexColor).withAlpha(_segSurface ? 0.45 : 0.9);
      const _segLabel = seg.survey ? (seg.survey + (seg.surveyDesc ? ' — ' + seg.surveyDesc : '')) : imp.name;
      for (let _si = 0; _si < _activePts.length - 1; _si++) {
        const _ptA = _activePts[_si], _ptB = _activePts[_si + 1];
        const _posA = convertFn(_ptA.n, _ptA.e, _ptA.v), _posB = convertFn(_ptB.n, _ptB.e, _ptB.v);
        if (!_posA || !_posB) continue;
        const _dx = _ptB.e - _ptA.e, _dy = _ptB.n - _ptA.n, _dz = _ptB.v - _ptA.v;
        const _shotLen = Math.sqrt(_dx*_dx + _dy*_dy + _dz*_dz);
        const _fromName = _ptA.name || '';
        const _toName = _ptB.name || '';
        const _shotLabel = (_fromName && _toName) ? `${_fromName} → ${_toName}` : _segLabel;
        const _shotDesc = [
          (_fromName || _toName) ? `<b>${_fromName || '?'} → ${_toName || '?'}</b>` : null,
          `<b>Survey: ${_segLabel}</b>`,
          _segSurface ? `<span style='color:#ffd93d'>▲ Surface shot</span>` : null,
          `Length: ${_shotLen.toFixed(2)} m`,
          _ptB.dist != null ? `Distance from entrance: ${_ptB.dist.toFixed(1)} m` : null,
          _ptB.lrud ? `Passage L/R/U/D: ${[_ptB.lrud.l, _ptB.lrud.r, _ptB.lrud.u, _ptB.lrud.d].map(v => v.toFixed(1)).join(' / ')} m` : null,
          _ptB.comment ? `<i>${_ptB.comment}</i>` : null,
          `File: ${imp.name}`,
        ].filter(Boolean).join('<br>');
        const e = cesiumViewer.entities.add({
          name: _shotLabel,
          polyline: { positions: [_posA, _posB], width: _segSurface ? 1 : 1.5, arcType: Cesium.ArcType.NONE,
            material: new Cesium.ColorMaterialProperty(segColor), clampToGround: false },
          description: _shotDesc,
          properties: { isCaveSurvey: true, surveyName: imp.name, surveyCode: seg.survey || '', isSurface: _segSurface || false },
        });
        imp.cesiumIds.push(e.id);
      }
    }
    const _surveysWithShots = new Set(imp.parsed.segments.map(sg => sg.survey));
    if (dopt.showStations !== false) {
      for (const s of imp.parsed.stations) {
        if (dopt.hiddenSurveys && dopt.hiddenSurveys[s.survey]) continue;
        const _stnSurface = s.isSurface
          || !!(dopt.surfaceSurveys && dopt.surfaceSurveys[s.survey])
          || !_surveysWithShots.has(s.survey);   // survey has no shots → surface landmark
        if (_stnSurface && !dopt.showSurface) continue;
        const pos = convertFn(s.n, s.e, s.v);
        if (!pos) continue;
        const desc = [
          `<b>${s.name}</b>`,
          s.isSurface ? `<span style='color:#ffd93d'>&#9650; Surface shot</span>` : null,
          s.dist != null ? `Distance from entrance: ${s.dist.toFixed(1)} m` : null,
          s.comment ? `<i>${s.comment}</i>` : null,
          s.lrud ? `Passage L/R/U/D: ${Object.values(s.lrud).map(v=>v.toFixed(1)).join(' / ')} m` : null,
          s.survey ? `Survey: ${s.survey}${s.surveyDesc ? ' — ' + s.surveyDesc : ''}` : null,
        ].filter(Boolean).join('<br>');
        const e = cesiumViewer.entities.add({
          name: s.name || imp.name, position: pos,
          point: { pixelSize: dopt.stationSize || 5, color: stationCesiumColor, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: 5000 },
          label: { text: s.name || '', show: dopt.showLabels, font: '10px sans-serif',
            fillColor: Cesium.Color.WHITE, style: Cesium.LabelStyle.FILL,
            pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: 5000 },
          description: desc,
          properties: { isCaveSurvey: true, surveyName: imp.name, surveyCode: s.survey || '' },
        });
        imp.cesiumIds.push(e.id);
      }
    }
  }
  _renderCaveList();
  console.log(`[cave] Re-rendered "${imp.name}" at (${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}, ${g.elev.toFixed(0)}m)`);
};

window._toggleCaveImport = function(i, visible) {
  const imp = _caveImports[i];
  if (!imp) return;
  imp.visible = visible;
  for (const id of imp.cesiumIds) {
    const e = cesiumViewer.entities.getById(id);
    if (e) e.show = visible;
  }
};

window._removeCaveImport = function(i) {
  const imp = _caveImports[i];
  if (!imp) return;
  for (const id of imp.cesiumIds) {
    const e = cesiumViewer.entities.getById(id);
    if (e) cesiumViewer.entities.remove(e);
  }
  _caveImports.splice(i, 1);
  _renderCaveList();
  if (_caveImports.length === 0) {
    const chk = document.getElementById('lp-cave-toggle');
    if (chk) chk.checked = false;
    notifyCaveVisibilityChanged(false);
  }
};

// ── Globe pick mode ──────────────────────────────────────────────────────────
let _cavePickMode = false;
let _cavePickResolve = null;

function _startGlobePick(source = 'cesium') {
  return new Promise(resolve => {
    const banner = document.getElementById('cave-pick-banner');
    const wizOverlay = document.getElementById('cave-wizard-overlay');

    if (source === 'potree') {
      // ── Potree pick: listen for click on Potree canvas, resolve with Cesium coords ──
      // The cameras are synced, so screen (clientX, clientY) maps to the same
      // geographic position in both Potree and Cesium.
      const ptCanvas = potreeViewer?.renderer?.domElement;
      if (!ptCanvas) { resolve(null); return; }
      if (wizOverlay) wizOverlay.style.display = 'none';
      if (banner) {
        banner.querySelector && (banner.querySelector('span:first-child').textContent =
          '☁ Click on the point cloud to set the anchor · Esc to cancel');
        banner.style.display = 'block';
      }
      const clickH = (event) => {
        event.stopPropagation();
        ptCanvas.removeEventListener('click', clickH, true);
        document.removeEventListener('keydown', escH);
        if (banner) banner.style.display = 'none';
        if (wizOverlay) wizOverlay.style.display = 'flex';
        // Use Cesium for geographic coords at the same screen position
        const screenPos = new Cesium.Cartesian2(event.clientX, event.clientY);
        const ray = cesiumViewer.camera.getPickRay(screenPos);
        let cart = ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
        if (!cart || !Cesium.defined(cart)) {
          cart = cesiumViewer.camera.pickEllipsoid(screenPos, cesiumViewer.scene.globe.ellipsoid);
        }
        if (cart && Cesium.defined(cart)) {
          const carto = Cesium.Cartographic.fromCartesian(cart);
          resolve({
            lat:  Cesium.Math.toDegrees(carto.latitude),
            lon:  Cesium.Math.toDegrees(carto.longitude),
            elev: carto.height,
          });
        } else {
          resolve(null);
        }
      };
      const escH = (e) => {
        if (e.key !== 'Escape') return;
        ptCanvas.removeEventListener('click', clickH, true);
        document.removeEventListener('keydown', escH);
        if (banner) banner.style.display = 'none';
        if (wizOverlay) wizOverlay.style.display = 'flex';
        resolve(null);
      };
      ptCanvas.addEventListener('click', clickH, true);
      document.addEventListener('keydown', escH);
      return;
    }

    // ── Cesium pick (default) ─────────────────────────────────────────────────
    _cavePickMode = true;
    _cavePickResolve = resolve;
    if (banner) banner.style.display = 'block';
    if (wizOverlay) wizOverlay.style.display = 'none';

    const onEsc = e => {
      if (e.key === 'Escape') { _cancelGlobePick(); document.removeEventListener('keydown', onEsc); }
    };
    document.addEventListener('keydown', onEsc);
  });
}

function _cancelGlobePick() {
  _cavePickMode = false;
  const banner = document.getElementById('cave-pick-banner');
  if (banner) banner.style.display = 'none';
  document.getElementById('cave-wizard-overlay').style.display = 'flex';
  if (_cavePickResolve) { _cavePickResolve(null); _cavePickResolve = null; }
}

// Wired into Cesium canvas click handler (called from main click handler)
function _onCavePickClick(windowPos) {
  if (!_cavePickMode) return false;
  _cavePickMode = false;
  const banner = document.getElementById('cave-pick-banner');
  if (banner) banner.style.display = 'none';

  let cart3 = cesiumViewer.scene.pickPosition(windowPos);
  if (!cart3 || !Cesium.defined(cart3)) {
    // Fallback: pick on ellipsoid surface
    cart3 = cesiumViewer.camera.pickEllipsoid(windowPos, cesiumViewer.scene.globe.ellipsoid);
  }

  const resolve = _cavePickResolve;
  _cavePickResolve = null;
  document.getElementById('cave-wizard-overlay').style.display = 'flex';

  if (cart3 && resolve) {
    const carto = Cesium.Cartographic.fromCartesian(cart3);
    resolve({
      lat:  Cesium.Math.toDegrees(carto.latitude),
      lon:  Cesium.Math.toDegrees(carto.longitude),
      elev: carto.height,
    });
  } else if (resolve) {
    resolve(null);
  }
  return true;
}
// Canvas click handler for pick mode is wired below (in the canvas section).

// ── ENU-based cave render (anchor mode) ──────────────────────────────────────
// anchorStationName: survey station name (required; must match a parsed station)
// anchorLat/Lon/Elev: real-world position of that station (degrees, metres)
//
// Multi-anchor groundwork: this function accepts a single anchor point.
// A future version will accept an array of anchors:
//   anchors: [{stationName, lat, lon, elev}, ...] (2+ points → least-squares fit)
// For now the single-anchor ENU transform is exact and sufficient.
// anchorStationName: survey station name (required; must match a parsed station)
// surveyName: the survey the station belongs to (for multi-survey PLTs), or ''
// declinationDeg: magnetic declination correction in degrees (positive = east), or null
function renderCaveSurveyAnchored(name, parsed, anchorStationName, anchorLat, anchorLon, anchorElevM, surveyName = '', declinationDeg = null) {
  // Find anchor station local coords (metres in survey space)
  let anchorLocal;
  if (!anchorStationName) {
    anchorLocal = parsed.segments[0]?.points[0];
    console.warn('[cave] No station specified; falling back to first point');
  } else {
    const nameNorm = String(anchorStationName).trim();
    anchorLocal = parsed.stations.find(s => s.name === nameNorm || s.name === nameNorm.split(/[./]/)[1]);
    if (!anchorLocal) {
      anchorLocal = parsed.segments[0]?.points[0];
      console.warn(`[cave] Station "${anchorStationName}" not found; using first point`);
    }
  }
  if (!anchorLocal) { console.error('[cave] No anchor point available'); return null; }

  // World position of anchor
  const anchorCart = Cesium.Cartesian3.fromDegrees(anchorLon, anchorLat, anchorElevM);

  // ENU frame at anchor — gives East/North/Up axes as world vectors
  // Optionally rotate by magnetic declination so survey north matches geographic north
  let enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(anchorCart);
  if (declinationDeg != null && declinationDeg !== 0) {
    const declRad = Cesium.Math.toRadians(declinationDeg);
    const rotZ = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromRotationZ(declRad),
      Cesium.Cartesian3.ZERO
    );
    enuMatrix = Cesium.Matrix4.multiply(enuMatrix, rotZ, new Cesium.Matrix4());
  }

  const convert = (n, e, v) => {
    const dE = e - anchorLocal.e;   // metres east  of anchor
    const dN = n - anchorLocal.n;   // metres north of anchor
    const dU = v - anchorLocal.v;   // metres up    of anchor
    // ENU: column 0 = East, column 1 = North, column 2 = Up
    const offset = new Cesium.Cartesian4(dE, dN, dU, 0);
    const worldOff = Cesium.Matrix4.multiplyByVector(enuMatrix, offset, new Cesium.Cartesian4());
    return new Cesium.Cartesian3(
      anchorCart.x + worldOff.x,
      anchorCart.y + worldOff.y,
      anchorCart.z + worldOff.z
    );
  };

  const entry = _buildCaveEntities(name, parsed, convert);
  if (entry) {
    entry.georef = {
      mode: 'anchor',
      station: anchorStationName,
      survey: surveyName,
      lat: anchorLat,
      lon: anchorLon,
      elev: anchorElevM,
      declination: declinationDeg,
    };
    if (!entry.displayOptions) entry.displayOptions = _defaultDisplayOptions(entry.parsed);
    _renderCaveList();
  }
  return entry;
}

// ── UTM-based cave render (file-coords-as-is mode) ────────────────────────────
function renderCaveSurveyUTM(name, parsed, zoneOverride, southOverride) {
  const converted = _pltToCartesian(parsed, zoneOverride, southOverride);
  if (!converted) return null;
  if (converted.error) {
    console.warn('[cave] UTM render failed:', converted.error);
    return null;
  }
  // _buildCaveEntities expects a convert function; since _pltToCartesian already gives
  // us position arrays, we use a wrapper that just returns pre-computed positions.
  const color = Cesium.Color.fromCssColorString('#00e5ff').withAlpha(0.9);
  const stationColor = Cesium.Color.fromCssColorString('#ffeb3b');
  const ids = [];
  for (const positions of converted.segPositions) {
    const e = cesiumViewer.entities.add({
      name, polyline: {
        positions, width: 1.5, arcType: Cesium.ArcType.NONE,
        material: new Cesium.ColorMaterialProperty(color), clampToGround: false,
      },
      properties: { isCaveSurvey: true, surveyName: name },
    });
    ids.push(e.id);
  }
  for (const { pos, name: sname, dist } of converted.stationPositions) {
    const e = cesiumViewer.entities.add({
      name: sname || name, position: pos,
      point: { pixelSize: 5, color: stationColor, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: 5000 },
      label: { text: sname || '', show: false, font: '10px sans-serif', fillColor: Cesium.Color.WHITE, style: Cesium.LabelStyle.FILL, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: 5000 },
      description: dist != null ? `<b>${sname}</b><br>Distance from entrance: ${dist.toFixed(1)} m` : `<b>${sname}</b>`,
      properties: { isCaveSurvey: true, surveyName: name },
    });
    ids.push(e.id);
  }
  const entry = { name, parsed, cesiumIds: ids, visible: true, georef: { mode: 'utm', zone: zoneOverride, south: southOverride } };
  _caveImports.push(entry);
  _renderCaveList();
  console.log(`[cave] UTM render "${name}": ${converted.segPositions.length} segs, ${converted.stationPositions.length} stations`);
  return entry;
}

// ── Shared entity builder (used by anchor mode) ───────────────────────────────
function _buildCaveEntities(name, parsed, convertFn) {
  const color = Cesium.Color.fromCssColorString('#00e5ff').withAlpha(0.9);
  const stationColor = Cesium.Color.fromCssColorString('#ffeb3b');
  const ids = [];

  for (const seg of parsed.segments) {
    const positions = seg.points
      .filter(p => !p.excluded)
      .map(p => convertFn(p.n, p.e, p.v))
      .filter(Boolean);
    if (positions.length < 2) continue;
    const e = cesiumViewer.entities.add({
      name, polyline: {
        positions, width: 1.5, arcType: Cesium.ArcType.NONE,
        material: new Cesium.ColorMaterialProperty(color), clampToGround: false,
      },
      properties: { isCaveSurvey: true, surveyName: name },
    });
    ids.push(e.id);
  }

  for (const s of parsed.stations) {
    const pos = convertFn(s.n, s.e, s.v);
    if (!pos) continue;
    const e = cesiumViewer.entities.add({
      name: s.name || name, position: pos,
      point: { pixelSize: 5, color: stationColor, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: 5000 },
      label: { text: s.name || '', show: false, font: '10px sans-serif', fillColor: Cesium.Color.WHITE, style: Cesium.LabelStyle.FILL, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: 5000 },
      description: s.dist != null ? `<b>${s.name}</b><br>Distance from entrance: ${s.dist.toFixed(1)} m` : `<b>${s.name}</b>`,
      properties: { isCaveSurvey: true, surveyName: name },
    });
    ids.push(e.id);
  }

  const entry = { name, parsed, cesiumIds: ids, visible: true, georef: null };
  // georef filled in by renderCaveSurveyAnchored after calling this
  _caveImports.push(entry);
  _renderCaveList();
  console.log(`[cave] Anchored render "${name}": ${ids.length} entities`);
  return entry;
}

// Keep old renderCaveSurvey as alias for UTM mode
function renderCaveSurvey(name, parsed, zoneOverride, southOverride) {
  return renderCaveSurveyUTM(name, parsed, zoneOverride, southOverride);
}

// ── Wizard UI ─────────────────────────────────────────────────────────────────
window._importCavePLT = function() {
  _cwizParsed = null;
  const overlay     = document.getElementById('cave-wizard-overlay');
  const fileInput   = document.getElementById('cwiz-file-input');
  const fileInfo    = document.getElementById('cwiz-file-info');
  const georef      = document.getElementById('cwiz-step-georef');
  const stats       = document.getElementById('cwiz-stats');
  const errDiv      = document.getElementById('cwiz-error');
  const loadBtn     = document.getElementById('cwiz-load');
  const utmZoneRow  = document.getElementById('cwiz-utm-zone-row');
  const anchorBody  = document.getElementById('cwiz-anchor-body');
  const utmHint     = document.getElementById('cwiz-utm-hint');

  // Reset
  fileInput.value = '';
  fileInfo.textContent = '';
  stats.style.display = 'none';
  georef.style.display = 'none';
  errDiv.style.display = 'none';
  loadBtn.disabled = true;
  overlay.style.display = 'flex';

  // Radio change handlers
  const utmRadio    = document.getElementById('cwiz-radio-utm');
  const anchorRadio = document.getElementById('cwiz-radio-anchor');

  function updateModeUI() {
    const isAnchor = anchorRadio.checked;
    anchorBody.style.display  = isAnchor ? 'block' : 'none';
    utmZoneRow.style.display  = isAnchor ? 'none'  : 'flex';
  }
  utmRadio.onchange    = updateModeUI;
  anchorRadio.onchange = updateModeUI;

  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = parsePLT(ev.target.result);
        _cwizParsed = parsed;
        _cwizParsed._fileName = file.name.replace(/\.plt$/i, '');
        _cwizParsed._rawText  = ev.target.result;

        // Stats
        const totalPts = parsed.segments.reduce((s, seg) => s + seg.points.length, 0);
        const allN = parsed.segments.flatMap(s => s.points.map(p => p.n));
        const maxAbsN = allN.length ? Math.max(...allN.map(Math.abs)) : 0;
        const isAbsUTM = maxAbsN > 500000;
        let statsHtml = `${parsed.segments.length} segments &nbsp;·&nbsp; ${parsed.stations.length} stations &nbsp;·&nbsp; ${totalPts} points`;
        statsHtml += `<br>Coord type: <b>${isAbsUTM ? 'Absolute UTM' : 'Local survey (offset from origin)'}</b>`;
        if (parsed.fixedStations.length) {
          statsHtml += `<br>Fixed ref stations in file: <b>${parsed.fixedStations.map(s => s.name).join(', ')}</b>`;
        }
        if (parsed.utmZone) {
          statsHtml += `<br>Zone in file: <b>${parsed.utmZone}${parsed.utmSouth ? 'S' : 'N'}</b>${parsed.datum ? ' &nbsp;(' + parsed.datum + ')' : ''}`;
        }
        stats.innerHTML = statsHtml;
        stats.style.display = 'block';

        // Set recommended defaults
        if (isAbsUTM) {
          utmRadio.checked = true;
          utmHint.innerHTML = `Absolute UTM detected (max northing ${(maxAbsN/1000).toFixed(0)} km)`;
          document.getElementById('cwiz-zone-input').value = parsed.utmZone || 17;
          document.getElementById('cwiz-hemi-input').value = parsed.utmSouth ? 'S' : 'N';
        } else {
          anchorRadio.checked = true;
          utmHint.innerHTML = 'Local coords — use "Anchor" mode instead for correct placement';
        }

        // Populate station dropdown — grouped by survey (N-line code + description), naturally sorted
        const sel = document.getElementById('cwiz-station-select');
        sel.innerHTML = '<option value="">-- Select a station --</option>';

        if (parsed.stations.length > 0) {
          function _naturalCmp(a, b) {
            const re = /(\d+)|(\D+)/g;
            const pa = String(a).match(re) || [];
            const pb = String(b).match(re) || [];
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
              const ca = pa[i] || '';
              const cb = pb[i] || '';
              const na = parseInt(ca, 10), nb = parseInt(cb, 10);
              const diff = (!isNaN(na) && !isNaN(nb)) ? na - nb : ca.localeCompare(cb);
              if (diff !== 0) return diff;
            }
            return 0;
          }

          // Group stations by survey code, preserving survey order from file
          // Use a Map keyed by "surveyCode|||surveyDesc" to keep unique entries in order
          const surveyOrder = [];
          const groups = {};
          for (const st of parsed.stations) {
            const code = st.survey || '';
            const desc = st.surveyDesc || '';
            const key  = code + '|||' + desc;
            if (!groups[key]) {
              groups[key] = [];
              surveyOrder.push({ key, code, desc });
            }
            groups[key].push(st);
          }

          // Within each survey, sort stations naturally by name
          for (const { key, code, desc } of surveyOrder) {
            const sts = groups[key];
            sts.sort((a, b) => _naturalCmp(a.name, b.name));
            const label = code && desc ? `${code} — ${desc}`
                        : code        ? `Survey ${code}`
                        :               '(unsurveyed)';
            const grp = document.createElement('optgroup');
            grp.label = label;
            for (const st of sts) {
              const opt = document.createElement('option');
              // Value encodes both survey code and station name to disambiguate duplicates
              opt.value = JSON.stringify({ survey: code, name: st.name });
              // Show station name + local coords (N/E in metres) — NOT "m from entrance"
              // because we're choosing which station IS the anchor, not measuring from it
              const coordHint = `N${st.n.toFixed(0)} E${st.e.toFixed(0)} V${st.v.toFixed(0)}`;
              opt.textContent = `${st.name}  (${coordHint})`;
              grp.appendChild(opt);
            }
            sel.appendChild(grp);
          }
        }

        updateModeUI();
        georef.style.display = 'block';
        fileInfo.textContent = `✓ ${file.name}`;
        errDiv.style.display = 'none';
        loadBtn.disabled = false;
      } catch(e) {
        errDiv.textContent = 'Parse error: ' + e.message;
        errDiv.style.display = 'block';
        loadBtn.disabled = true;
      }
    };
    reader.readAsText(file);
  };

  // ── Pick location buttons ────────────────────────────────────────────────
  function _fillAnchorCoords(result) {
    if (!result) return;
    document.getElementById('cwiz-anc-lat').value  = result.lat.toFixed(7);
    document.getElementById('cwiz-anc-lon').value  = result.lon.toFixed(7);
    document.getElementById('cwiz-anc-elev').value = result.elev.toFixed(1);
  }

  // Cesium globe pick
  document.getElementById('cwiz-pick-cesium').onclick = async () => {
    _fillAnchorCoords(await _startGlobePick('cesium'));
  };

  // Potree point cloud pick (placeholder — full impl when Potree pick API is wired)
  document.getElementById('cwiz-pick-potree').onclick = () => {
    // TODO: potreeViewer.scene pick → resolve with {lat, lon, elev}
    // Disabled visually for now
  };

  // Manual — just focus the lat field
  document.getElementById('cwiz-pick-manual').onclick = () => {
    document.getElementById('cwiz-anc-lat').focus();
  };

  // Auto-fetch magnetic declination from NOAA WMM proxy
  document.getElementById('cwiz-decl-fetch').onclick = async () => {
    const lat = parseFloat(document.getElementById('cwiz-anc-lat').value);
    const lon = parseFloat(document.getElementById('cwiz-anc-lon').value);
    const statusEl = document.getElementById('cwiz-decl-status');
    if (isNaN(lat) || isNaN(lon)) {
      statusEl.style.color = '#f88';
      statusEl.textContent = 'Enter lat/lon first';
      return;
    }
    statusEl.style.color = 'rgba(255,255,255,0.35)';
    statusEl.textContent = 'Fetching…';
    try {
      const year = new Date().getFullYear();
      const r = await fetch('/api/declination?lat=' + lat + '&lon=' + lon + '&year=' + year);
      const data = await r.json();
      if (data.declination != null) {
        document.getElementById('cwiz-decl-input').value = data.declination.toFixed(2);
        statusEl.style.color = '#8fa';
        statusEl.textContent = '✓ ' + data.declination.toFixed(2) + '° (' + data.year + ')';
      } else {
        statusEl.style.color = '#f88';
        statusEl.textContent = 'Error: ' + (data.error || 'unknown');
      }
    } catch(e) {
      statusEl.style.color = '#f88';
      statusEl.textContent = 'Fetch failed: ' + e.message;
    }
  };

  // Screen-center quick-fill
  document.getElementById('cwiz-pick-screen-center').onclick = async () => {
    const canvas = cesiumViewer.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = cesiumViewer.camera.getPickRay(center);
    let cart = ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
    if (!cart) cart = cesiumViewer.camera.pickEllipsoid(center, cesiumViewer.scene.globe.ellipsoid);
    if (!cart) { alert('Could not determine globe position at screen center.'); return; }
    const carto = Cesium.Cartographic.fromCartesian(cart);
    const lat  = Cesium.Math.toDegrees(carto.latitude);
    const lon  = Cesium.Math.toDegrees(carto.longitude);
    const elev = carto.height ?? 0;
    document.getElementById('cwiz-anc-lat').value  = lat.toFixed(6);
    document.getElementById('cwiz-anc-lon').value  = lon.toFixed(6);
    document.getElementById('cwiz-anc-elev').value = elev.toFixed(1);
    // Auto-select __first__ anchor station if none chosen
    const sel = document.getElementById('cwiz-station-select');
    if (!sel.value) {
      // pick the first real option
      for (const opt of sel.options) { if (opt.value) { sel.value = opt.value; break; } }
    }
    // Switch to anchor radio if not already
    document.getElementById('cwiz-radio-anchor').checked = true;
    updateModeUI();
  };

  document.getElementById('cwiz-cancel').onclick = () => {
    overlay.style.display = 'none';
    _cwizParsed = null;
  };

  loadBtn.onclick = () => {
    if (!_cwizParsed) return;
    errDiv.style.display = 'none';
    const isAnchor = anchorRadio.checked;

    if (isAnchor) {
      const lat  = parseFloat(document.getElementById('cwiz-anc-lat').value);
      const lon  = parseFloat(document.getElementById('cwiz-anc-lon').value);
      const elev = parseFloat(document.getElementById('cwiz-anc-elev').value) || 0;
      if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        errDiv.textContent = 'Please enter valid latitude (−90 to 90) and longitude (−180 to 180), or click "Click on globe..."';
        errDiv.style.display = 'block';
        return;
      }
      const stationRaw = document.getElementById('cwiz-station-select').value;
      if (!stationRaw) {
        errDiv.textContent = 'Please select a survey station to anchor the survey.';
        errDiv.style.display = 'block';
        return;
      }
      // Station value is JSON {survey, name} to disambiguate duplicates across surveys
      let stationSurvey = '', stationName = stationRaw;
      try {
        const parsed2 = JSON.parse(stationRaw);
        stationSurvey = parsed2.survey || '';
        stationName   = parsed2.name   || stationRaw;
      } catch(_) { /* plain string fallback */ }
      overlay.style.display = 'none';
      const declVal  = parseFloat(document.getElementById('cwiz-decl-input')?.value);
      const declInput = isNaN(declVal) ? null : declVal;
      const entry = renderCaveSurveyAnchored(_cwizParsed._fileName, _cwizParsed, stationName, lat, lon, elev, stationSurvey, declInput);
      _cwizParsed = null;
      _finishCaveLoad(entry);
    } else {
      // UTM mode
      let zone  = _cwizParsed.utmZone;
      let south = _cwizParsed.utmSouth;
      const forceManual = !document.getElementById('cwiz-radio-utm').checked || !zone;
      if (forceManual) {
        zone  = parseInt(document.getElementById('cwiz-zone-input').value, 10);
        south = document.getElementById('cwiz-hemi-input').value === 'S';
      }
      if (!zone || zone < 1 || zone > 60) {
        errDiv.textContent = 'Enter a valid UTM zone (1–60).';
        errDiv.style.display = 'block';
        return;
      }
      overlay.style.display = 'none';
      const entry = renderCaveSurveyUTM(_cwizParsed._fileName, _cwizParsed, zone, south);
      _cwizParsed = null;
      _finishCaveLoad(entry);
    }
  };
};

function _finishCaveLoad(entry) {
  if (!entry) return;
  const chk = document.getElementById('lp-cave-toggle');
  if (chk && !chk.checked) { chk.checked = true; notifyCaveVisibilityChanged(true); }
  const ids = entry.cesiumIds;
  if (ids.length) {
    cesiumViewer.flyTo(
      ids.map(id => cesiumViewer.entities.getById(id)).filter(Boolean),
      { duration: 2.5, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 0) }
    );
  }
  // Persist to PLT recents (raw text stored in parsed._rawText)
  if (entry.parsed && entry.parsed._rawText) {
    _addPltRecent(entry.name, entry.parsed?._rawText || '', entry.georef || null, entry.displayOptions || null);
  }
}

// ── Overlay drag-and-drop ─────────────────────────────────────────────────────

// ── Layer list (fully manual render — no Knockout foreach) ───────────────────
// viewModel.layers[] is the source of truth. We own the DOM and sync back.

/**
 * Wire a freshly-added ImageryLayer to the session save system.
 * Must be called once per layer after addCatalogLayer() resolves.
 */
function subscribeLayerToSession(layer) {
  if (!layer?.name) return;
  Cesium.knockout.getObservable(layer, 'show')?.subscribe(() => saveSession());
  Cesium.knockout.getObservable(layer, 'alpha')?.subscribe(() => saveSession());
}

function renderLayerList() {
  const body = document.getElementById('lp-layers-body');
  if (!body) return;
  body.innerHTML = '';

  // All active layers in one flat list (top → bottom in viewModel order).
  const active = viewModel.layers.filter(l => l.name);

  // ── Mouse-event drag state ─────────────────────────────────────────────
  // We use mousedown → document mousemove/mouseup instead of the HTML5 DnD
  // API because Cesium's event handling disrupts native drag events.
  let _dragSrcIdx = null;
  let _dragGhost  = null;
  let _isDragging = false;
  let _dragStartY = 0;

  // Rows get a secondary class so we can find only layer rows (not other
  // .lp-row elements that appear in the panel for other sections).
  const LP_ROW_CLS = 'lp-layer-row';
  const _lrows = () => Array.from(body.querySelectorAll('.' + LP_ROW_CLS));

  function _cleanupDrag() {
    if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }
    _lrows().forEach(r => { r.style.opacity = ''; r.classList.remove('lp-drag-over'); });
    _dragSrcIdx = null;
    _isDragging = false;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup',   _onDragUp);
  }

  function _onDragMove(e) {
    if (_dragSrcIdx === null) return;
    if (!_isDragging) {
      if (Math.abs(e.clientY - _dragStartY) < 4) return;  // 4px dead zone
      _isDragging = true;
      const rs = _lrows();
      if (rs[_dragSrcIdx]) rs[_dragSrcIdx].style.opacity = '0.35';
    }
    if (_dragGhost) {
      _dragGhost.style.left = (e.clientX + 14) + 'px';
      _dragGhost.style.top  = (e.clientY - 10) + 'px';
    }
    // Highlight the row closest to the cursor
    const rs = _lrows();
    rs.forEach(r => r.classList.remove('lp-drag-over'));
    let best = null, bestDist = Infinity;
    for (const r of rs) {
      const rect = r.getBoundingClientRect();
      const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    if (best) best.classList.add('lp-drag-over');
  }

  function _onDragUp(e) {
    const srcIdx      = _dragSrcIdx;
    const wasDragging = _isDragging;
    // Read row positions BEFORE cleanupDrag wipes state
    const rs = _lrows();
    let targetIdx = null, bestDist = Infinity;
    for (let j = 0; j < rs.length; j++) {
      const rect = rs[j].getBoundingClientRect();
      const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
      if (dist < bestDist) { bestDist = dist; targetIdx = j; }
    }
    _cleanupDrag();
    if (!wasDragging || srcIdx === null || targetIdx === null || targetIdx === srcIdx) return;
    const movedLayer = active[srcIdx];
    const steps = targetIdx - srcIdx;
    if (steps < 0) {
      for (let s = 0; s < -steps; s++) viewModel.raise(movedLayer);
    } else {
      for (let s = 0; s < steps; s++) viewModel.lower(movedLayer);
    }
    saveSession();
    renderLayerList();
  }
  // ── End of drag state setup ────────────────────────────────────────────

  active.forEach((layer, i) => {
    const row = document.createElement('div');
    row.className = 'lp-row ' + LP_ROW_CLS;
    row.style.cssText = 'display:flex; align-items:center; padding:2px 0; gap:4px;';

    // ⠿ drag handle (visual affordance only — the whole row is draggable)
    const handle = document.createElement('span');
    handle.textContent = '⠿';
    handle.className = 'lp-drag-handle';
    handle.style.userSelect = 'none';
    handle.title = 'Drag to reorder';

    // Visibility checkbox
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!layer.show;
    chk.style.margin = '0';
    chk.addEventListener('change', () => { layer.show = chk.checked; });

    // Name label
    const nameSpan = document.createElement('span');
    nameSpan.textContent = layer.name;
    nameSpan.style.cssText = 'flex:1; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

    // Opacity slider
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '1'; slider.step = '0.01';
    slider.value = String(layer.alpha ?? 1);
    slider.style.cssText = 'width:62px; flex-shrink:0;';
    slider.addEventListener('input', () => { layer.alpha = parseFloat(slider.value); });

    // × Remove button
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from active layers';
    removeBtn.style.cssText = 'background:none; border:none; cursor:pointer; color:rgba(255,100,100,0.65); font-size:15px; flex-shrink:0; padding:0 2px; line-height:1;';
    removeBtn.addEventListener('mouseenter', () => { removeBtn.style.color = 'rgba(255,60,60,1)'; });
    removeBtn.addEventListener('mouseleave', () => { removeBtn.style.color = 'rgba(255,100,100,0.65)'; });
    removeBtn.addEventListener('click', () => {
      removeCatalogLayer(layer);
      saveSession();
      renderLayerList();
    });

    row.appendChild(handle);
    row.appendChild(chk);
    row.appendChild(nameSpan);
    row.appendChild(slider);
    row.appendChild(removeBtn);
    body.appendChild(row);

    // ── Reorder via mousedown → document mousemove/mouseup ───────────────
    row.addEventListener('mousedown', e => {
      // Let checkboxes, sliders, and buttons handle their own clicks
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      if (e.button !== 0) return;
      e.preventDefault();   // prevent text selection while dragging
      _dragSrcIdx = i;
      _dragStartY = e.clientY;
      _isDragging = false;
      // Floating ghost label that follows the cursor
      _dragGhost = document.createElement('div');
      _dragGhost.textContent = '⠿ ' + layer.name;
      _dragGhost.style.cssText =
        'position:fixed;z-index:99999;pointer-events:none;white-space:nowrap;' +
        'padding:3px 10px;border-radius:4px;font-size:11px;' +
        'background:rgba(28,32,50,0.97);border:1px solid rgba(255,255,255,0.3);' +
        'color:rgba(255,255,255,0.9);box-shadow:0 3px 12px rgba(0,0,0,0.6);' +
        `left:${e.clientX + 14}px;top:${e.clientY - 10}px;`;
      document.body.appendChild(_dragGhost);
      document.addEventListener('mousemove', _onDragMove);
      document.addEventListener('mouseup',   _onDragUp);
    });
  });

  // ── Add layer button + picker dropdown ───────────────────────────────────
  const activeNames = new Set(active.map(l => l.name));
  const available   = LAYER_CATALOG.filter(d => !activeNames.has(d.name));

  const footer = document.createElement('div');
  footer.style.cssText = 'margin-top:5px; position:relative;';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add layer';
  addBtn.style.cssText = [
    'width:100%; font-size:10px; padding:3px 0;',
    'background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.2);',
    'border-radius:4px; color:rgba(255,255,255,0.75); cursor:pointer; letter-spacing:0.03em;',
  ].join('');
  if (available.length === 0) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.38';
    addBtn.title = 'All catalog layers are already active';
  }
  footer.appendChild(addBtn);

  // Picker panel (hidden until + is clicked)
  const picker = document.createElement('div');
  picker.style.cssText = [
    'display:none; position:absolute; top:calc(100% + 2px); left:0; right:0; z-index:60;',
    'background:rgba(18,20,28,0.98); border:1px solid rgba(255,255,255,0.2);',
    'border-radius:6px; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,0.55);',
    'max-height:220px; overflow-y:auto;',
  ].join('');

  available.forEach(def => {
    const item = document.createElement('div');
    item.textContent = def.name;
    item.style.cssText = 'padding:6px 10px; font-size:11px; color:rgba(255,255,255,0.85); cursor:pointer; white-space:nowrap;';
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.1)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', async () => {
      picker.style.display = 'none';
      addBtn.disabled = true;
      addBtn.textContent = `⏳ Adding ${def.name}…`;
      const newLayer = await addCatalogLayer(def.name, true, 1.0);
      if (newLayer) {
        subscribeLayerToSession(newLayer);
        saveSession();
      }
      renderLayerList();   // re-render with the new layer in the active list
    });
    picker.appendChild(item);
  });

  footer.appendChild(picker);
  body.appendChild(footer);

  // Toggle picker on button click; close when clicking anywhere outside
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = picker.style.display === 'none';
    picker.style.display = opening ? 'block' : 'none';
    if (opening) {
      const onOutside = (e2) => {
        if (!footer.contains(e2.target)) {
          picker.style.display = 'none';
          document.removeEventListener('click', onOutside, true);
        }
      };
      // Defer so the opening click itself isn't captured
      setTimeout(() => document.addEventListener('click', onOutside, true), 0);
    }
  });
}

// Expose to toolbar onclick handlers (can't use ES module imports from inline HTML)
window._loadCaltopo = () => {
  const url      = (document.getElementById('caltopo_url_input')?.value || '').trim();
  const interval = parseInt(document.getElementById('caltopo_interval_select')?.value || '30', 10);
  if (url) loadCaltopoKml(url, interval);
};
window._clearCaltopo = () => clearCaltopo();

// ── CalTopo authentication (bookmarklet-based) ────────────────────────────────

async function caltopoLogin(cookie) {
  if (!cookie) return;
  _setCaltopoStatus('applying session…', '#aaa');
  try {
    const r    = await fetch('/caltopo/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cookie }),
    });
    const data = await r.json();
    if (data.ok) {
      _showCaltopoLoggedIn();
      _setCaltopoStatus('', '');
      if (caltopoState.url) _fetchCaltopoKml();
    } else {
      _setCaltopoStatus(`⚠ ${data.error}`, '#f88');
    }
  } catch (e) {
    _setCaltopoStatus('⚠ request failed', '#f88');
  }
}

async function caltopoLogout() {
  await fetch('/caltopo/logout', { method: 'POST' }).catch(() => {});
  _showCaltopoLoginForm();
  _setCaltopoStatus('', '');
}

function _showCaltopoLoggedIn() {
  const loginEl = document.getElementById('caltopo_login_section');
  const inEl    = document.getElementById('caltopo_loggedin_section');
  if (loginEl) loginEl.style.display = 'none';
  if (inEl)    inEl.style.display    = 'flex';
}

function _showCaltopoLoginForm() {
  const loginEl = document.getElementById('caltopo_login_section');
  const inEl    = document.getElementById('caltopo_loggedin_section');
  if (loginEl) loginEl.style.display = 'flex';
  if (inEl)    inEl.style.display    = 'none';
}

window._caltopoLogout = () => caltopoLogout();

// Build bookmarklet href dynamically — runs on caltopo.com, sends document.cookie to FLEX
(function _initCaltopoBookmarklet() {
  const origin = window.location.origin;
  const code = `(function(){` +
    `fetch('${origin}/caltopo/login',{` +
      `method:'POST',` +
      `headers:{'Content-Type':'application/json'},` +
      `body:JSON.stringify({cookie:document.cookie})` +
    `}).then(function(r){return r.json()})` +
    `.then(function(d){alert(d.ok?'\u2713 FLEX connected to CalTopo!':'\u26a0 '+d.error)})` +
    `.catch(function(){alert('\u26a0 Could not reach FLEX \u2014 is the server running?')})` +
  `})()`;
  const link = document.getElementById('caltopo_bookmarklet_link');
  if (link) link.href = 'javascript:' + code;
}());

const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

// Init layers panel interactivity (after Knockout owns the DOM)
renderPcList();
renderDataFileList();
renderCaltopoStatus();
renderPoiList();

// Cave survey toggle
{
  const caveToggle = document.getElementById('lp-cave-toggle');
  if (caveToggle) {
    if (flags.displayCave) {
      caveToggle.checked = true;
      setCaveSurveyVisible(true);
    }
    caveToggle.addEventListener('change', () => setCaveSurveyVisible(caveToggle.checked));
  }
}

// Scene section checkboxes + Point Budget slider — wire directly
{
  const lidarChk = document.getElementById('lp-showlidar-chk');
  const mapsChk  = document.getElementById('lp-googlemaps-chk');
  if (lidarChk) {
    lidarChk.checked = !!viewModel.showlidar;
    lidarChk.addEventListener('change', () => { viewModel.showlidar = lidarChk.checked; });
    // Keep in sync when [L] key toggles it
    Cesium.knockout.getObservable(viewModel, 'showlidar').subscribe(v => { lidarChk.checked = !!v; });
  }
  if (mapsChk) {
    mapsChk.checked = !!viewModel.googleMapsOn;
    mapsChk.addEventListener('change', () => { viewModel.googleMapsOn = mapsChk.checked; });
    Cesium.knockout.getObservable(viewModel, 'googleMapsOn').subscribe(v => { mapsChk.checked = !!v; });
  }
  const otChk = document.getElementById('lp-showopentopo-chk');
  if (otChk) {
    otChk.checked = !!viewModel.showOpenTopo;
    otChk.addEventListener('change', () => { viewModel.showOpenTopo = otChk.checked; });
    Cesium.knockout.getObservable(viewModel, 'showOpenTopo').subscribe(v => { otChk.checked = !!v; });
  }

  // Point Budget slider
  const budgetSlider = document.getElementById('lp-point-budget');
  const budgetLabel  = document.getElementById('lp-point-budget-label');

  function _applyPointBudget(v) {
    potreeViewer.setPointBudget(v);
    if (budgetSlider) budgetSlider.value = v;
    if (budgetLabel)  budgetLabel.textContent =
      v >= 1_000_000 ? (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' M'
                     : (v / 1_000).toFixed(0) + ' K';
  }

  if (budgetSlider) {
    // Restore saved value, or keep the hardcoded default
    const savedBudget = _savedSession?.pointBudget;
    if (savedBudget) _applyPointBudget(savedBudget);

    budgetSlider.addEventListener('input', () => {
      const v = parseInt(budgetSlider.value, 10);
      _applyPointBudget(v);
      notifyPointBudgetChanged(v);
    });
  }

}

// (selectedLayer subscriber removed — all layers are now managed uniformly
//  via eye-toggle in renderLayerList; no separate base-layer dropdown.)

Cesium.knockout.getObservable(viewModel, "showlidar").subscribe(
function (newValue) {
  setLidarFootprintsVisible(newValue);
}
);
Cesium.knockout.getObservable(viewModel, "showOpenTopo").subscribe(
function (newValue) {
  setOtFootprintsVisible(newValue);
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

handler.setInputAction(function (click) {
  _otHandleClick(click.position);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

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
  case "0".charCodeAt(0):
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
    return "measureDepth";
  case "R".charCodeAt(0):
    return "route";
  case "B".charCodeAt(0):
    return "routePoint";
  case "K".charCodeAt(0):
    return "downloadPoints";
  case "H".charCodeAt(0):
    return "hideCesium";
  case "P".charCodeAt(0):
    return "displayPC";
  case "I".charCodeAt(0):
    return "displayCave";
  case "O".charCodeAt(0):
    return "showOpenTopo";
  case "N".charCodeAt(0):
    return "cycleCompassStyle";
  case "M".charCodeAt(0):
    return "toggleMiniMap";
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
  const tag = document.activeElement && document.activeElement.tagName;
  const isTyping = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable;
  if (isTyping) {
    return;
  }
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
    }else if (flagName == "showOpenTopo" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
    }else if (flagName == "cycleCompassStyle"){
      cycleCompassStyle();
    }else if (flagName == "toggleMiniMap"){
      miniMapUserHidden = !miniMapUserHidden;
      const container = document.getElementById("mini_map_container");
      if (container) {
        container.style.display = miniMapUserHidden ? "none" : "block";
        if (!miniMapUserHidden && miniMapMap) miniMapMap.updateSize();
      }
    }else if (flagName == "measureDepth"){
      toggleMeasureMode();
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
      console.log("Added point of Small interest: S".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: { scale: 0.75, text: "S: ".concat(labelName) },
        position: cesiumViewer.camera.position,
        properties: { isUserLabel: true },
        point: {},
      });
      renderPoiList();
    }else if (flagName == "pointM"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Medium interest ".concat(pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Medium interest: M".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: { scale: 1, text: "M: ".concat(labelName) },
        position: cesiumViewer.camera.position,
        properties: { isUserLabel: true },
        point: {},
      });
      renderPoiList();
    }else if (flagName == "pointL"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Large interest ".concat(pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Large interest: L".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: { scale: 1.5, text: "L: ".concat(labelName) },
        position: cesiumViewer.camera.position,
        properties: { isUserLabel: true },
        point: {},
      });
      renderPoiList();
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
  if ((typeof flagName !== "undefined")&&(flagName !== "Fly")&&(flagName !== "TouchFly")&&(flagName !== "hideCesium")&&(flagName !== "showlidar")&&(flagName !== "removePC")&&(flagName !== "toggleOther")&&(flagName !== "toggleGround")&&(flagName !== "toggleVeg")&&(flagName !== "toggleLowNoise")&&(flagName !== "toggleAll")&&(flagName !== "displayPC")&&(flagName !== "displayCave")&&(flagName !== "showOpenTopo")&&(flagName !== "cycleCompassStyle")&&(flagName !== "measureDepth")&&(flagName !== "toggleMiniMap")) {
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
  renderPcList();
}
if (flags.showlidar){
  viewModel.showlidar = !viewModel.showlidar;
  flags.showlidar = false;
}
if (flags.showOpenTopo){
  viewModel.showOpenTopo = !viewModel.showOpenTopo;
  flags.showOpenTopo = false;
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

// ── Angle of Incidence Visualization ────────────────────────────────
const incidenceState = {
  enabled: false,
  lineLength: 2,
  cylRadius: 0.05,
  maxPoints: 20000,
  maxDistance: 200, // metres from camera in projected coords
  colorMode: 'flightline', // 'angle' or 'flightline'
  flipSign: 1, // 1 or -1 — flips scan angle sign for datasets with opposite convention
  classFilter: new Set([7]), // default: only low noise (class 7)
  linesGroup: new THREE.Group(),
  lastCamPos: new THREE.Vector3(),
  refreshDistSq: 50 * 50, // only refresh when camera moves 50m
  needsRefresh: true, // force first draw
  lastRefreshTime: 0,
  minRefreshInterval: 2000, // minimum 2 seconds between refreshes
  // Shared cylinder geometry: unit height along Y, centered at origin
  cylGeom: new THREE.CylinderGeometry(1, 1, 1, 6, 1),
  // Material supports per-instance color
  cylMat: new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.8 }),
};
// Pre-generate distinct flight line colors (golden-angle hue spacing)
const _flightLineColors = {};
function getFlightLineColor(sourceId) {
  if (_flightLineColors[sourceId]) return _flightLineColors[sourceId];
  const hue = (Object.keys(_flightLineColors).length * 0.618034) % 1.0;
  const c = new THREE.Color().setHSL(hue, 0.9, 0.5);
  _flightLineColors[sourceId] = c;
  return c;
}
function getAngleColor(angleDeg) {
  // Green (nadir, 0°) → Yellow (15°) → Red (30°+)
  const t = Math.min(Math.abs(angleDeg) / 30, 1);
  return new THREE.Color().setHSL((1 - t) * 0.33, 0.9, 0.5);
}

function clearIncidenceLines() {
  const g = incidenceState.linesGroup;
  while (g.children.length > 0) {
    const child = g.children[0];
    g.remove(child);
    if (child.instanceMatrix) {
      child.dispose(); // InstancedMesh: cleans up instance buffers
    } else {
      if (child.geometry) child.geometry.dispose();
      if (child.material && child.material !== incidenceState.cylMat) child.material.dispose();
    }
  }
}

// Estimate flight paths per Point Source ID.
// Strategy: collect near-nadir points (scan angle near 0°), fit a straight
// line through them via least-squares, use GPS time for direction, and
// place the path at a configurable altitude (default 3000m ASL).
function estimateFlightDirections(pointclouds) {
  const FLIGHT_ALT = 4000; // meters ASL — typical airborne LiDAR altitude
  const NADIR_THRESHOLD = 0.25; // degrees — points within this are "near nadir"

  const samples = new Map(); // sourceId -> { nadirPts: [], allPts: [] }
  const _v = new THREE.Vector3();

  for (const pc of pointclouds) {
    if (!pc.visible || !pc.visibleNodes) continue;
    for (const node of pc.visibleNodes) {
      if (!node.sceneNode) continue;
      const gn = node.geometryNode || node;
      const g = gn.geometry;
      if (!g) continue;
      const posAttr = g.attributes.position;
      const psAttr = g.attributes['source id'];
      const saAttr = g.attributes['scan angle'];
      const gpsAttr = g.attributes.gpsTime;
      if (!posAttr || !psAttr || !saAttr) continue;
      const snMatrix = node.sceneNode.matrixWorld;
      const numPts = posAttr.count;
      const stride = Math.max(1, Math.floor(numPts / 40));
      for (let i = 0; i < numPts; i += stride) {
        _v.set(posAttr.array[i*3], posAttr.array[i*3+1], posAttr.array[i*3+2])
          .applyMatrix4(snMatrix);
        const sid = psAttr.array[i];
        const sa = saAttr.array[i];
        const gps = gpsAttr ? gpsAttr.array[i] : 0;
        if (!samples.has(sid)) samples.set(sid, { nadirPts: [], allPts: [] });
        const s = samples.get(sid);
        const pt = { x: _v.x, y: _v.y, z: _v.z, scanAngle: sa, gpsTime: gps };
        s.allPts.push(pt);
        if (Math.abs(sa) <= NADIR_THRESHOLD) {
          s.nadirPts.push(pt);
        }
      }
    }
  }

  const headings = new Map();
  for (const [sid, s] of samples) {
    // Use nadir points for line fitting; fall back to all points
    const fitPts = s.nadirPts.length >= 3 ? s.nadirPts : s.allPts;
    if (fitPts.length < 3) continue;

    // Least-squares fit of a straight line in XY through nadir points.
    // Line parameterized as: P(t) = centroid + t * direction
    const n = fitPts.length;
    let sx = 0, sy = 0;
    for (const p of fitPts) { sx += p.x; sy += p.y; }
    const cx = sx / n, cy = sy / n;

    // Covariance for PCA (only on near-nadir points = clean signal)
    let cxx = 0, cxy = 0, cyy = 0;
    for (const p of fitPts) {
      const dx = p.x - cx, dy = p.y - cy;
      cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
    }

    // Primary eigenvector = flight direction
    const trace = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const eigenval1 = trace / 2 + Math.sqrt(Math.max(0, trace * trace / 4 - det));
    let alongX, alongY;
    if (Math.abs(cxy) > 1e-10) {
      alongX = eigenval1 - cyy;
      alongY = cxy;
    } else {
      alongX = cxx >= cyy ? 1 : 0;
      alongY = cxx >= cyy ? 0 : 1;
    }
    const len = Math.sqrt(alongX * alongX + alongY * alongY);
    if (len < 1e-10) continue;
    alongX /= len; alongY /= len;

    // Orient by GPS time: increasing time = positive direction
    const hasGps = s.allPts.some(p => p.gpsTime !== 0);
    if (hasGps) {
      let tMin = Infinity, tMax = -Infinity, pMin = null, pMax = null;
      for (const p of s.allPts) {
        if (p.gpsTime < tMin) { tMin = p.gpsTime; pMin = p; }
        if (p.gpsTime > tMax) { tMax = p.gpsTime; pMax = p; }
      }
      if (pMin && pMax && tMax > tMin) {
        const dot = (pMax.x - pMin.x) * alongX + (pMax.y - pMin.y) * alongY;
        if (dot < 0) { alongX = -alongX; alongY = -alongY; }
      }
    }

    // Across-track = 90° CCW rotation
    const acrossX = -alongY, acrossY = alongX;

    // Build flight path as a STRAIGHT LINE at FLIGHT_ALT.
    // Project the extent of sampled points onto the along-track axis
    // to find the start and end of the line.
    let tMin = Infinity, tMax = -Infinity;
    for (const p of s.allPts) {
      const t = (p.x - cx) * alongX + (p.y - cy) * alongY;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }

    // Extend slightly beyond the data extent
    tMin -= 50; tMax += 50;

    const pathPts = [
      { x: cx + tMin * alongX, y: cy + tMin * alongY, z: FLIGHT_ALT },
      { x: cx + tMax * alongX, y: cy + tMax * alongY, z: FLIGHT_ALT },
    ];

    headings.set(sid, {
      acrossX, acrossY, alongX, alongY,
      flightHeight: FLIGHT_ALT,
      pathPts,
    });
  }

  return headings;
}

function updateIncidenceLines() {
  clearIncidenceLines();

  if (!incidenceState.enabled) return;

  const pointclouds = potreeViewer.scene.pointclouds;
  if (!pointclouds || pointclouds.length === 0) return;

  const classFilter = incidenceState.classFilter;
  if (classFilter.size === 0) return;

  const cam = potreeViewer.scene.getActiveCamera();
  const camX = cam.position.x;
  const camY = cam.position.y;
  const maxDist = incidenceState.maxDistance;
  const maxDistSq = maxDist * maxDist;

  const maxPts = incidenceState.maxPoints;
  const lineLen = incidenceState.lineLength;
  const cylR = incidenceState.cylRadius;
  const colorMode = incidenceState.colorMode;

  // Estimate flight headings from point distribution per flight line
  const headings = estimateFlightDirections(pointclouds);

  // Reusable objects
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0); // cylinder default axis
  const _dir = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _s = new THREE.Vector3(cylR, lineLen, cylR);
  const _color = new THREE.Color();

  // Collect matching points across all nodes
  const instances = [];

  for (const pc of pointclouds) {
    if (!pc.visible || !pc.visibleNodes) continue;

    for (const node of pc.visibleNodes) {
      if (instances.length >= maxPts) break;
      if (!node.sceneNode) continue;

      const geomNode = node.geometryNode || node;
      const geometry = geomNode.geometry;
      if (!geometry) continue;

      const posAttr = geometry.attributes.position;
      const saAttr = geometry.attributes['scan angle'];
      const clsAttr = geometry.attributes.classification;
      if (!posAttr || !saAttr || !clsAttr) continue;

      const snMatrix = node.sceneNode.matrixWorld;

      // Quick 2D node-level distance check
      const bb = geomNode.boundingBox;
      if (bb) {
        _v.set(
          (bb.max.x - bb.min.x) * 0.5,
          (bb.max.y - bb.min.y) * 0.5,
          (bb.max.z - bb.min.z) * 0.5
        ).applyMatrix4(snMatrix);
        const dx = _v.x - camX, dy = _v.y - camY;
        const nodeRadius = bb.getSize(new THREE.Vector3()).length() * 0.5;
        if (Math.sqrt(dx*dx + dy*dy) - nodeRadius > maxDist) continue;
      }

      const originX = snMatrix.elements[12];
      const originY = snMatrix.elements[13];
      const originZ = snMatrix.elements[14];

      const psAttr = geometry.attributes['source id'];

      const numPts = posAttr.count;
      for (let i = 0; i < numPts; i++) {
        if (instances.length >= maxPts) break;

        const cls = clsAttr.array[i] & 31;
        if (!classFilter.has(cls)) continue;

        _v.set(
          posAttr.array[i * 3],
          posAttr.array[i * 3 + 1],
          posAttr.array[i * 3 + 2]
        ).applyMatrix4(snMatrix);

        const dx = _v.x - camX, dy = _v.y - camY;
        if (dx*dx + dy*dy > maxDistSq) continue;

        const angleDeg = saAttr.array[i];
        const sourceId = psAttr ? psAttr.array[i] : 0;

        instances.push({
          rx: _v.x - originX, ry: _v.y - originY, rz: _v.z - originZ,
          originX, originY, originZ,
          angleDeg, sourceId,
        });
      }
    }
    if (instances.length >= maxPts) break;
  }

  if (instances.length === 0) {
    incidenceState.lastRefreshTime = performance.now();
    return;
  }

  // Group instances by origin to keep Float32 values small
  const groups = new Map();
  for (const inst of instances) {
    const key = `${inst.originX},${inst.originY},${inst.originZ}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inst);
  }

  for (const [key, group] of groups) {
    const { originX, originY, originZ } = group[0];
    const count = group.length;

    const mesh = new THREE.InstancedMesh(incidenceState.cylGeom, incidenceState.cylMat, count);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);

    for (let j = 0; j < count; j++) {
      const inst = group[j];
      const angleRad = incidenceState.flipSign * inst.angleDeg * (Math.PI / 180);

      // Get the estimated across-track direction for this flight line.
      // Scan angle is measured perpendicular to flight path:
      //   positive = right of flight direction
      //   negative = left of flight direction
      const heading = headings.get(inst.sourceId);
      let acrossX, acrossY;
      if (heading) {
        acrossX = heading.acrossX;
        acrossY = heading.acrossY;
      } else {
        // Fallback: assume E-W across-track
        acrossX = 1; acrossY = 0;
      }

      // Direction from point toward sensor:
      // Horizontal component = scan angle tilt along across-track direction
      // Vertical component = cos(angle) upward
      const sinA = Math.sin(angleRad);
      const cosA = Math.cos(Math.abs(angleRad));
      _dir.set(
        sinA * acrossX,  // X (east/west component of across-track tilt)
        sinA * acrossY,  // Y (north/south component of across-track tilt)
        cosA             // Z (upward toward sensor)
      ).normalize();

      // Quaternion to rotate cylinder from Y-up to _dir
      _q.setFromUnitVectors(_up, _dir);

      // Position: midpoint of the cylinder
      const mx = inst.rx + _dir.x * lineLen * 0.5;
      const my = inst.ry + _dir.y * lineLen * 0.5;
      const mz = inst.rz + _dir.z * lineLen * 0.5;

      _m.compose(
        _v.set(mx, my, mz),
        _q,
        _s
      );
      mesh.setMatrixAt(j, _m);

      // Color
      if (colorMode === 'flightline') {
        _color.copy(getFlightLineColor(inst.sourceId));
      } else {
        _color.copy(getAngleColor(inst.angleDeg));
      }
      mesh.instanceColor.setXYZ(j, _color.r, _color.g, _color.b);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.position.set(originX, originY, originZ);
    incidenceState.linesGroup.add(mesh);
  }

  // Render flight path lines for each flight line with a known heading
  for (const [sid, h] of headings) {
    if (!h.pathPts || h.pathPts.length < 2) continue;
    const pts = h.pathPts;
    const color = getFlightLineColor(sid);

    // Use first point as origin for Float32 precision
    const ox = pts[0].x, oy = pts[0].y, oz = pts[0].z;

    // Build line strip as pairs of segments
    const lineVerts = [];
    for (let i = 0; i < pts.length - 1; i++) {
      lineVerts.push(pts[i].x - ox, pts[i].y - oy, pts[i].z - oz);
      lineVerts.push(pts[i+1].x - ox, pts[i+1].y - oy, pts[i+1].z - oz);
    }

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
    const lineMat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
    const line = new THREE.LineSegments(lineGeom, lineMat);
    line.position.set(ox, oy, oz);
    incidenceState.linesGroup.add(line);
  }

  incidenceState.lastRefreshTime = performance.now();
}

// Wire up UI controls
{
  const toggle = document.getElementById('incidence_toggle');
  const lengthSlider = document.getElementById('incidence_length');
  const lengthLabel = document.getElementById('incidence_length_label');
  const radiusSlider = document.getElementById('incidence_radius');
  const radiusLabel = document.getElementById('incidence_radius_label');
  const maxSlider = document.getElementById('incidence_max_points');
  const maxLabel = document.getElementById('incidence_max_points_label');
  const colorSelect = document.getElementById('incidence_color_mode');

  if (toggle) {
    toggle.addEventListener('change', () => {
      incidenceState.enabled = toggle.checked;
      if (toggle.checked) {
        incidenceState.needsRefresh = true;
      } else {
        clearIncidenceLines();
      }
    });
  }
  if (lengthSlider) {
    lengthSlider.addEventListener('input', () => {
      incidenceState.lineLength = parseFloat(lengthSlider.value);
      if (lengthLabel) lengthLabel.textContent = lengthSlider.value + 'm';
    });
  }
  if (radiusSlider) {
    radiusSlider.addEventListener('input', () => {
      incidenceState.cylRadius = parseFloat(radiusSlider.value);
      if (radiusLabel) radiusLabel.textContent = radiusSlider.value + 'm';
    });
  }
  if (maxSlider) {
    maxSlider.addEventListener('input', () => {
      incidenceState.maxPoints = parseInt(maxSlider.value);
      if (maxLabel) maxLabel.textContent = (parseInt(maxSlider.value) / 1000) + 'k';
    });
  }
  if (colorSelect) {
    colorSelect.addEventListener('change', () => {
      incidenceState.colorMode = colorSelect.value;
      if (incidenceState.enabled) incidenceState.needsRefresh = true;
    });
  }

  // Per-class checkboxes
  const classCheckboxes = [
    { id: 'incidence_cls_2', cls: 2 },
    { id: 'incidence_cls_3', cls: 3 },
    { id: 'incidence_cls_4', cls: 4 },
    { id: 'incidence_cls_5', cls: 5 },
    { id: 'incidence_cls_6', cls: 6 },
    { id: 'incidence_cls_7', cls: 7 },
  ];
  for (const { id, cls } of classCheckboxes) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        if (el.checked) incidenceState.classFilter.add(cls);
        else incidenceState.classFilter.delete(cls);
      });
    }
  }
  // Flip angle sign button
  const flipBtn = document.getElementById('incidence_flip');
  if (flipBtn) {
    flipBtn.addEventListener('click', () => {
      incidenceState.flipSign *= -1;
      flipBtn.textContent = incidenceState.flipSign === 1 ? 'Flip Angles' : 'Flip Angles (flipped)';
      if (incidenceState.enabled) incidenceState.needsRefresh = true;
    });
  }

  // "Other / Unclassified" covers 0, 1, 8, 9, 12, and anything not in the named list
  const otherEl = document.getElementById('incidence_cls_other');
  if (otherEl) {
    otherEl.addEventListener('change', () => {
      const otherClasses = [0, 1, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
      for (const c of otherClasses) {
        if (otherEl.checked) incidenceState.classFilter.add(c);
        else incidenceState.classFilter.delete(c);
      }
    });
  }
}

// Add lines group to Potree's regular Three.js scene (rendered by standard renderer)
potreeViewer.scene.scene.add(incidenceState.linesGroup);

// Add lights to scene.scene for shaded incidence cylinders
{
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(0, 0, 1); // light from above (Z-up in Potree)
  potreeViewer.scene.scene.add(ambient);
  potreeViewer.scene.scene.add(directional);
}


// ── Depth / distance measurement mode ────────────────────────────────────────
// Press V to set an origin at the current camera position.
// A live readout shows vertical, horizontal, and total distance from that point.
// Press V again to clear.

const measureState = {
  active:     false,
  origin:     null,  // Cesium.Cartesian3
  originCart: null,  // Cesium.Cartographic
  panel:      null,  // readout DOM element
  originDiv:  null,  // HTML marker at origin
  readoutEl:  null,  // child div updated each frame
  unit:       'm',   // 'm' or 'ft'
  _last:      null,  // { total, horizontal, vertical, azimuth, inclination }
};

function toggleMeasureMode() {
  if (measureState.active) {
    // --- Turn off ---
    measureState.active     = false;
    measureState.origin     = null;
    measureState.originCart = null;
    if (measureState.panel) measureState.panel.style.display = 'none';
    if (measureState.originDiv) { measureState.originDiv.style.display = 'none'; }
  } else {
    // --- Turn on: snapshot current camera position as origin ---
    const pos  = cesiumViewer.camera.position.clone();
    const cart = Cesium.Cartographic.fromCartesian(pos);
    measureState.active     = true;
    measureState.origin     = pos;
    measureState.originCart = cart;
    if (measureState.panel) measureState.panel.style.display = 'block';
  }
}

function _copySurveyShot() {
  const s = measureState._last;
  if (!s) return;
  const factor = measureState.unit === 'ft' ? 3.28084 : 1;
  const dist = (s.total * factor).toFixed(2);
  const az   = s.azimuth.toFixed(1);
  const inc  = s.inclination.toFixed(1);
  const unit = measureState.unit;
  const text = `${dist}\t${az}\t${inc}\t(${unit})`;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('measure_copy_btn');
    if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500); }
  }).catch(() => {
    console.warn('[measure] clipboard write failed');
  });
}

function updateMeasureDisplay() {
  if (!measureState.active || !measureState.origin) return;

  // Lazy-create the panel (static structure — only built once)
  if (!measureState.panel) {
    const panel = document.createElement('div');
    panel.id = 'measure_panel';
    panel.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(10,12,18,0.88)',
      'border:1px solid rgba(255,255,255,0.25)',
      'border-radius:8px', 'padding:8px 16px',
      'color:#fff', 'font-size:13px', 'font-family:monospace',
      'z-index:25', 'pointer-events:auto',
      'white-space:nowrap', 'text-align:center',
      'box-shadow:0 4px 14px rgba(0,0,0,0.5)',
      'min-width:420px',
    ].join(';');

    // Static header row with unit toggle + copy button
    const btnStyle = [
      'font-size:11px', 'padding:1px 7px', 'margin-left:6px',
      'background:rgba(255,255,255,0.12)', 'color:#fff',
      'border:1px solid rgba(255,255,255,0.3)', 'border-radius:4px',
      'cursor:pointer',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'margin-bottom:5px; display:flex; justify-content:space-between; align-items:center;';
    header.innerHTML =
      `<span style="opacity:0.6;font-size:11px;">📐 Measuring from origin &nbsp;|&nbsp; press V to clear</span>` +
      `<span>` +
        `<button id="measure_unit_btn" style="${btnStyle}">[m]</button>` +
        `<button id="measure_copy_btn" style="${btnStyle}">📋 Copy</button>` +
      `</span>`;
    panel.appendChild(header);

    // Dynamic readout updated each frame
    const readout = document.createElement('div');
    readout.id = 'measure_readout';
    panel.appendChild(readout);

    document.body.appendChild(panel);
    measureState.panel    = panel;
    measureState.readoutEl = readout;

    // Unit toggle
    document.getElementById('measure_unit_btn').addEventListener('click', () => {
      measureState.unit = measureState.unit === 'm' ? 'ft' : 'm';
      document.getElementById('measure_unit_btn').textContent =
        measureState.unit === 'm' ? '[m]' : '[ft]';
    });

    // Copy button
    document.getElementById('measure_copy_btn').addEventListener('click', _copySurveyShot);

  }

  if (!measureState.originDiv) {
    const d = document.createElement('div');
    d.id = 'measure_origin_marker';
    d.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:24',
      'width:14px', 'height:14px',
      'border:2px solid #ff6600',
      'border-radius:50%',
      'background:rgba(255,102,0,0.35)',
      'transform:translate(-50%,-50%)',
      'box-shadow:0 0 6px rgba(255,102,0,0.8)',
    ].join(';');
    document.getElementById('html_label_container').appendChild(d);
    measureState.originDiv = d;
  }

  // Update origin marker screen position
  const originScreen = cesiumViewer.scene.cartesianToCanvasCoordinates(measureState.origin);
  if (originScreen) {
    measureState.originDiv.style.display = 'block';
    measureState.originDiv.style.left    = Math.round(originScreen.x) + 'px';
    measureState.originDiv.style.top     = Math.round(originScreen.y) + 'px';
  } else {
    measureState.originDiv.style.display = 'none';
  }

  // Compute distances
  const curPos  = cesiumViewer.camera.position;
  const curCart = Cesium.Cartographic.fromCartesian(curPos);

  const total      = Cesium.Cartesian3.distance(curPos, measureState.origin);
  const vertical   = curCart.height - measureState.originCart.height;
  const horizontal = Math.sqrt(Math.max(0, total * total - vertical * vertical));

  // Compute azimuth + inclination in ENU frame at origin
  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(measureState.origin);
  const inv   = Cesium.Matrix4.inverseTransformation(enuTransform, new Cesium.Matrix4());
  const delta = Cesium.Cartesian3.subtract(curPos, measureState.origin, new Cesium.Cartesian3());
  const local = Cesium.Matrix4.multiplyByPointAsVector(inv, delta, new Cesium.Cartesian3());
  // local.x = East, local.y = North, local.z = Up
  const azimuth     = (Math.atan2(local.x, local.y) * 180 / Math.PI + 360) % 360;
  const inclination = Math.atan2(local.z, horizontal) * 180 / Math.PI;

  // Store for copy button
  measureState._last = { total, horizontal, vertical, azimuth, inclination };

  // Apply unit conversion for display
  const factor   = measureState.unit === 'ft' ? 3.28084 : 1;
  const unitSfx  = measureState.unit;
  const fmt      = n => (n * factor).toFixed(1) + ' ' + unitSfx;
  const vDir     = vertical < 0 ? '▼' : '▲';
  const vCol     = vertical < 0 ? '#6af' : '#fa6';

  measureState.readoutEl.innerHTML =
    `<span style="color:${vCol}">${vDir} Vert: <b>${fmt(Math.abs(vertical))}</b></span>` +
    `&nbsp;&nbsp;` +
    `<span style="color:#8f8">→ Horiz: <b>${fmt(horizontal)}</b></span>` +
    `&nbsp;&nbsp;` +
    `<span style="color:#fff">⤢ Total: <b>${fmt(total)}</b></span>` +
    `<br>` +
    `<span style="color:#fc9; font-size:12px;">` +
      `Az: <b>${azimuth.toFixed(1)}°</b>` +
      `&nbsp;&nbsp;Inc: <b>${inclination.toFixed(1)}°</b>` +
    `</span>`;
}

// ── HTML screen-space label overlay ──────────────────────────────────────────
// Projects isUserLabel entity positions to screen coords each frame and renders
// them as DOM divs on top of both the Cesium and Potree canvases.

const htmlLabelState = {
  enabled: true,
  container: document.getElementById('html_label_container'),
  // Map from entity.id → <div> element
  divs: new Map(),
};

// Wire POI / HTML labels toggle checkbox
{
  const toggle = document.getElementById('html_labels_toggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      htmlLabelState.enabled = toggle.checked;
      notifyPoiVisibilityChanged(toggle.checked);
      if (!htmlLabelState.enabled) {
        // Clear all HTML divs and re-show native Cesium labels
        htmlLabelState.divs.forEach(div => div.remove());
        htmlLabelState.divs.clear();
        cesiumViewer.entities.values.forEach(e => {
          if (e.label && (
            (e.properties && e.properties.isUserLabel) ||
            (e.polyline && e.label)
          )) {
            e.label.show = true;
          }
        });
      }
    });
  }
}

function updateHtmlLabels() {
  if (!htmlLabelState.enabled || !htmlLabelState.container) return;

  const scene    = cesiumViewer.scene;
  const entities = cesiumViewer.entities.values;
  const now      = Cesium.JulianDate.now();
  const liveIds  = new Set(); // all entity IDs that should have a label div

  for (const entity of entities) {
    // Match user POI labels (Z/X/C) AND route labels (have label but no isUserLabel)
    if (!entity.label) continue;
    const isUserPoi   = entity.properties && entity.properties.isUserLabel;
    const isRoutLabel = entity.polyline && entity.label; // route entities have polyline + label
    if (!isUserPoi && !isRoutLabel) continue;
    if (!entity.position) continue;

    // Always suppress native Cesium label when HTML mode is on
    entity.label.show = false;

    liveIds.add(entity.id);

    const worldPos = entity.position.getValue(now);
    if (!worldPos) continue;

    // Project to canvas coords — cartesianToCanvasCoordinates returns null if behind camera
    const screenPos = scene.cartesianToCanvasCoordinates(worldPos);
    if (!screenPos) {
      const div = htmlLabelState.divs.get(entity.id);
      if (div) div.style.display = 'none';
      continue;
    }

    // Off-screen cull (with margin so labels near edges don't pop)
    const margin = 60;
    if (screenPos.x < -margin || screenPos.x > window.innerWidth  + margin ||
        screenPos.y < -margin || screenPos.y > window.innerHeight + margin) {
      const div = htmlLabelState.divs.get(entity.id);
      if (div) div.style.display = 'none';
      continue;
    }

    // Create div on first appearance
    let div = htmlLabelState.divs.get(entity.id);
    if (!div) {
      div = document.createElement('div');
      div.className = 'html-label';
      const text = entity.label.text && entity.label.text.getValue
        ? entity.label.text.getValue(now)
        : (entity.label.text || entity.name || '');
      div.textContent = text;
      htmlLabelState.container.appendChild(div);
      htmlLabelState.divs.set(entity.id, div);
    }

    div.style.display = 'block';
    div.style.left    = Math.round(screenPos.x) + 'px';
    div.style.top     = Math.round(screenPos.y) + 'px';
  }

  // Remove divs for entities that have been deleted from the scene
  for (const [id, div] of htmlLabelState.divs) {
    if (!liveIds.has(id)) {
      div.remove();
      htmlLabelState.divs.delete(id);
    }
  }
}

function loop(timestamp){
  requestAnimationFrame(loop);
  onCameraFrame();

  // console.log(timestamp);

  // potreeViewer.update(potreeViewer.clock.getDelta(), timestamp);

  cesiumViewer.resize();
  // potreeViewer.resize();

  if (viewModel.cesiumRender) {
    cesiumViewer.render();
  }

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
    
    // Camera Z correction mirrors the point cloud matrix: pcZscale is needed whenever
    // the cloud matrix uses it (usgsRef or egm96 ON). Original OFF mode uses scale=1 on
    // the cloud, so the camera height is also left uncorrected for consistency.
    let cCamHeightCorrected = cCamHeight;
    if (viewModel.usgsRef || viewModel.egm96) {
      cCamHeightCorrected = cCamHeight / Math.cos(cCamPosCart.latitude);
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

  // Update incidence angle lines when camera moves 50m+ (with 2s minimum interval)
  if (incidenceState.enabled) {
    const cam = potreeViewer.scene.getActiveCamera();
    const dSq = cam.position.distanceToSquared(incidenceState.lastCamPos);
    const elapsed = performance.now() - incidenceState.lastRefreshTime;
    if (incidenceState.needsRefresh || (dSq > incidenceState.refreshDistSq && elapsed > incidenceState.minRefreshInterval)) {
      incidenceState.needsRefresh = false;
      incidenceState.lastCamPos.copy(cam.position);
      updateIncidenceLines();
    }
  }

  updateNorthCompass();
  updateHtmlLabels();
  updateMeasureDisplay();
}
initNorthCompass();

// ── Local Entwine server integration ─────────────────────────────────────────
let _entwineConfig = null;  // null = not linked; { path, url, enabled } = linked

async function _loadEntwineConfig() {
  try {
    const r = await fetch('/api/entwine/config');
    const data = await r.json();
    _entwineConfig = data.linked === false ? null : data;
  } catch(e) {
    _entwineConfig = null;
  }
  _renderEntwineBtn();
}

function _renderEntwineBtn() {
  const btn = document.getElementById('entwine-btn');
  if (!btn) return;
  if (!_entwineConfig) {
    btn.textContent = '🔗 Link Entwine';
    btn.style.background = 'rgba(80,180,120,0.1)';
    btn.style.borderColor = 'rgba(80,180,120,0.3)';
    btn.style.color = '#8ecfa8';
    btn.title = 'Link your local Entwine server';
  } else if (!_entwineConfig.enabled) {
    btn.textContent = '▶ Enable Entwine';
    btn.style.background = 'rgba(255,200,80,0.1)';
    btn.style.borderColor = 'rgba(255,200,80,0.3)';
    btn.style.color = '#f5c842';
    btn.title = 'Enable local Entwine server (' + _entwineConfig.url + ')';
  } else {
    btn.textContent = '📂 Entwine Datasets';
    btn.style.background = 'rgba(80,180,120,0.2)';
    btn.style.borderColor = 'rgba(80,180,120,0.45)';
    btn.style.color = '#6ee08a';
    btn.title = 'Browse local EPT datasets';
  }
}

window._entwineBtn = function() {
  if (!_entwineConfig) {
    window._entwineLink();
  } else if (!_entwineConfig.enabled) {
    window._entwineEnable();
  } else {
    window._entwineOpen();
  }
};

window._entwineLink = function() {
  const pathInp = document.getElementById('entwine-path-input');
  const urlInp  = document.getElementById('entwine-url-input');
  const errDiv  = document.getElementById('entwine-link-error');
  const exeInp  = document.getElementById('entwine-exe-input');
  if (pathInp) pathInp.value = (_entwineConfig && _entwineConfig.path) || '~/entwine';
  if (urlInp)  urlInp.value  = (_entwineConfig && _entwineConfig.url)  || 'http://localhost:8083';
  if (exeInp)  exeInp.value  = (_entwineConfig && _entwineConfig.exe)  || '';
  if (errDiv)  errDiv.style.display = 'none';
  const ov = document.getElementById('entwine-link-overlay');
  if (ov) ov.style.display = 'flex';
};

window._entwineConfirmLink = async function() {
  const pathVal = (document.getElementById('entwine-path-input')?.value || '').trim();
  const urlVal  = (document.getElementById('entwine-url-input')?.value  || '').trim();
  const exeVal  = (document.getElementById('entwine-exe-input')?.value   || '').trim();
  const errDiv  = document.getElementById('entwine-link-error');
  if (!pathVal || !urlVal) {
    if (errDiv) { errDiv.textContent = 'Both fields are required.'; errDiv.style.display = 'block'; }
    return;
  }
  const cfg = { path: pathVal, url: urlVal.replace(/\/$/, ''), enabled: true };
  if (exeVal) cfg.exe = exeVal;
  try {
    const r = await fetch('/api/entwine/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Save failed');
    _entwineConfig = cfg;
    document.getElementById('entwine-link-overlay').style.display = 'none';
    _renderEntwineBtn();
    // Auto-open picker after linking
    window._entwineOpen();
  } catch(e) {
    if (errDiv) { errDiv.textContent = e.message; errDiv.style.display = 'block'; }
  }
};

window._entwineEnable = async function() {
  if (!_entwineConfig) return;
  _entwineConfig.enabled = true;
  try {
    await fetch('/api/entwine/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_entwineConfig) });
  } catch(e) { /* non-fatal */ }
  _renderEntwineBtn();
};

window._entwineOpen = async function() {
  const ov   = document.getElementById('entwine-picker-overlay');
  const list = document.getElementById('entwine-picker-list');
  const urlEl = document.getElementById('entwine-picker-url');
  if (!ov || !list) return;
  if (urlEl) urlEl.textContent = _entwineConfig?.url || '';
  list.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:11px;padding:8px 0;">Checking server…</div>';
  ov.style.display = 'flex';
  try {
    const statusR = await fetch('/api/entwine/status');
    const status = await statusR.json();
    if (!status.running) {
      list.innerHTML = `<div style="text-align:center;padding:16px 0;">
        <div style="color:rgba(255,255,255,0.45);font-size:11px;margin-bottom:12px;">Entwine server is not running</div>
        <button id="entwine-start-btn" onclick="window._entwineStartServer()"
          style="padding:5px 18px;background:rgba(80,180,120,0.2);border:1px solid rgba(80,180,120,0.5);border-radius:4px;color:#8ecfa8;cursor:pointer;font-size:12px;">▶ Start Server</button>
      </div>`;
      return;
    }
    const r = await fetch('/api/entwine/datasets');
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Failed to list datasets');
    if (!data.datasets.length) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:11px;padding:8px 0;">No datasets found in ' + (_entwineConfig?.path || '') + '.<br>Make sure each dataset has an ept.json file.</div>';
      return;
    }
    list.innerHTML = data.datasets.map(d => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="font-size:12px;color:#ddd;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${d.url}">${d.name}</span>
        <button onclick="window._entwineLoad('${d.url.replace(/'/g,"\'")}','${d.name.replace(/'/g,"\'")}')""
          style="margin-left:8px;flex-shrink:0;padding:3px 10px;background:rgba(80,180,120,0.2);border:1px solid rgba(80,180,120,0.4);border-radius:3px;color:#8ecfa8;cursor:pointer;font-size:11px;">Load</button>
      </div>`).join('');
  } catch(e) {
    list.innerHTML = '<div style="color:#f88;font-size:11px;padding:8px 0;">Error: ' + e.message + '</div>';
  }
};

window._entwineStartServer = async function() {
  const btn = document.getElementById('entwine-start-btn');
  const list = document.getElementById('entwine-picker-list');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting…'; }
  try {
    const r = await fetch('/api/entwine/start', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Failed to start');
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(res => setTimeout(res, 500));
      try {
        const s = await fetch('/api/entwine/status');
        const st = await s.json();
        if (st.running) { ready = true; break; }
      } catch(e) {}
      if (btn) btn.textContent = '⏳ Starting' + '.'.repeat((i % 3) + 1);
    }
    if (ready) {
      window._entwineOpen();
    } else {
      // Show server log so user can debug
      let logHtml = '';
      try {
        const ls = await fetch('/api/entwine/status');
        const lst = await ls.json();
        if (lst.log && lst.log.length) logHtml = '<pre style="font-size:10px;color:#aaa;margin-top:8px;white-space:pre-wrap;word-break:break-all;">' + lst.log.join('\n') + '</pre>';
      } catch(e) {}
      if (list) list.innerHTML = '<div style="color:#f88;font-size:11px;padding:8px 0;">Server started but not responding. Check entwine is in your PATH.' + logHtml + '</div>';
    }
  } catch(e) {
    if (list) list.innerHTML = '<div style="color:#f88;font-size:11px;padding:8px 0;">Error: ' + e.message + '</div>';
  }
};

window._entwineLoad = function(url, name) {
  document.getElementById('entwine-picker-overlay').style.display = 'none';
  const statusEl = document.getElementById('lp-pc-status');
  if (statusEl) { statusEl.textContent = '⏳ Loading ' + name + '…'; statusEl.style.color = '#aaa'; }
  try {
    const eptUrl = url.endsWith('/ept.json') ? url : url.replace(/\/+$/, '') + '/ept.json';
    window.addPC(eptUrl);
  } catch(e) {
    if (statusEl) { statusEl.textContent = '✗ ' + (e.message || e); statusEl.style.color = '#f77'; }
  }
};

window._entwineUnlink = async function() {
  if (!confirm('Unlink local Entwine server?')) return;
  try {
    await fetch('/api/entwine/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linked: false }) });
  } catch(e) { /* non-fatal */ }
  _entwineConfig = null;
  document.getElementById('entwine-picker-overlay').style.display = 'none';
  _renderEntwineBtn();
};

_loadRecents();        // populate EPT + PLT recent lists
_initPltRestoreInput(); // wire the hidden PLT cache-miss file picker
_loadEntwineConfig();   // restore local Entwine server state


// ── Cave style panel ─────────────────────────────────────────────────────────
let _styleIdx = null;

window._openStylePanel = function(i) {
  const imp = _caveImports[i];
  if (!imp) return;
  _styleIdx = i;
  if (!imp.displayOptions) imp.displayOptions = _defaultDisplayOptions(imp.parsed);
  const dopt = imp.displayOptions;
  // Ensure inline panel content is in the DOM
  const _ip = document.getElementById('cave-inline-panel');
  if (_ip && !document.getElementById('cave-inline-style')) {
    const t1 = document.getElementById('tmpl-style-panel');
    if (t1) _ip.appendChild(t1.content.cloneNode(true));
    const t2 = document.getElementById('tmpl-rectify-panel');
    if (t2) _ip.appendChild(t2.content.cloneNode(true));
  }

  document.getElementById('style-survey-name').textContent = imp.name;

  // Surface toggle
  document.getElementById('style-surface-toggle').checked = dopt.showSurface;

  // Labels toggle
  document.getElementById('style-labels-toggle').checked = dopt.showLabels;

  // Station controls
  document.getElementById('style-stations-toggle').checked = dopt.showStations !== false;
  document.getElementById('style-station-color').value = dopt.stationColor || '#ffeb3b';
  document.getElementById('style-station-size').value = dopt.stationSize || 5;
  document.getElementById('style-station-size-val').textContent = (dopt.stationSize || 5) + 'px';

  // Survey color list
  const list = document.getElementById('style-survey-list');
  const surveys = imp.parsed.surveys && imp.parsed.surveys.length
    ? imp.parsed.surveys
    : [{ code: '', desc: 'All segments' }];

  list.innerHTML = surveys.map((sv, si) => {
    const col = dopt.surveyColors[sv.code] || SURVEY_PALETTE[si % SURVEY_PALETTE.length];
    const label = sv.code && sv.desc ? `${sv.code} — ${sv.desc}` : sv.code || '(default)';
    const hasSurface = imp.parsed.segments.some(s => s.survey === sv.code && s.isSurface);
    const isHidden = !!(dopt.hiddenSurveys && dopt.hiddenSurveys[sv.code]);
    const isMarkedSurface = !!(dopt.surfaceSurveys && dopt.surfaceSurveys[sv.code]);
    const rowStyle = isHidden ? 'opacity:0.4;' : '';
    return `<div data-survey-code="${sv.code}" style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);${rowStyle}">
      <button onclick="window._styleSurveyToggle('${sv.code}')" title="${isHidden ? 'Show' : 'Hide'} this survey"
        style="background:none;border:none;cursor:pointer;font-size:13px;padding:0;flex-shrink:0;line-height:1;">${isHidden ? '🙈' : '👁'}</button>
      <button onclick="window._styleSurveyMarkSurface('${sv.code}')" title="${isMarkedSurface ? 'Unmark as surface' : 'Mark as surface (hides with surface toggle)'}"
        style="background:none;border:none;cursor:pointer;font-size:12px;padding:0;flex-shrink:0;line-height:1;opacity:${isMarkedSurface ? '1' : '0.3'};">☀</button>
      <input type="color" value="${col}" data-survey="${sv.code}"
        onchange="window._styleColorChange(this)"
        style="width:26px;height:20px;border:none;background:none;cursor:pointer;padding:0;border-radius:3px;flex-shrink:0;">
      <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isMarkedSurface ? '#ffd93d' : '#ccc'};" title="${label}">${label}</span>
      ${hasSurface ? '<span style="font-size:9px;color:rgba(255,200,80,0.6);padding:1px 4px;border:1px solid rgba(255,200,80,0.3);border-radius:2px;flex-shrink:0;">FS</span>' : ''}
    </div>`;
  }).join('');

  const _sip = document.getElementById('cave-inline-panel');
  const _sis = document.getElementById('cave-inline-style');
  const _sir = document.getElementById('cave-inline-rectify');
  if (_sip) _sip.style.display = 'block';
  if (_sis) _sis.style.display = 'block';
  if (_sir) _sir.style.display = 'none';
  if (_sip) _sip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window._styleColorChange = function(input) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions.surveyColors[input.dataset.survey] = input.value;
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
};

window._styleToggleSurface = function(chk) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions.showSurface = chk.checked;
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
};

window._styleToggleLabels = function(chk) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions.showLabels = chk.checked;
  // Update label visibility live without full re-render
  for (const id of imp.cesiumIds) {
    const e = cesiumViewer.entities.getById(id);
    if (e && e.label) e.label.show = chk.checked;
  }
  _displayUpdateRecent(imp);
};

window._styleToggleStations = function(chk) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions.showStations = chk.checked;
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
};

window._styleStationColor = function(input) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions.stationColor = input.value;
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
};

window._styleStationSize = function(input) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions.stationSize = parseInt(input.value);
  document.getElementById('style-station-size-val').textContent = input.value + 'px';
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
};

window._styleSurveyToggle = function(code) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  if (!imp.displayOptions.hiddenSurveys) imp.displayOptions.hiddenSurveys = {};
  imp.displayOptions.hiddenSurveys[code] = !imp.displayOptions.hiddenSurveys[code];
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
  window._openStylePanel(_styleIdx);  // refresh eye icons
};

window._styleSurveyMarkSurface = function(code) {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  if (!imp.displayOptions.surfaceSurveys) imp.displayOptions.surfaceSurveys = {};
  imp.displayOptions.surfaceSurveys[code] = !imp.displayOptions.surfaceSurveys[code];
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
  window._openStylePanel(_styleIdx);
};

window._styleResetColors = function() {
  const imp = _caveImports[_styleIdx];
  if (!imp) return;
  imp.displayOptions = _defaultDisplayOptions(imp.parsed);
  _rerenderCave(_styleIdx);
  _displayUpdateRecent(imp);
  window._openStylePanel(_styleIdx);  // refresh panel
};

window._styleClose = function() {
  const _sc = document.getElementById('cave-inline-style');
  if (_sc) _sc.style.display = 'none';
  const _sr = document.getElementById('cave-inline-rectify');
  if (!_sr || _sr.style.display === 'none') { const _sp = document.getElementById('cave-inline-panel'); if (_sp) _sp.style.display = 'none'; }
  _styleIdx = null;
};

// ── Georectification ─────────────────────────────────────────────────────────
// State
let _rectifyIdx      = null;   // which _caveImports entry we're editing
let _rectifyPending  = null;   // {station, lat, lon, elev} being positioned
let _rectifyMarker   = null;   // temporary Cesium entity
let _rectifyPickMode = false;  // waiting for globe click
let _rectifyStationPickMode = false;  // waiting for station entity click

// Open the rectify panel for survey i
window._openRectifyPanel = function(i) {
  const imp = _caveImports[i];
  if (!imp) return;
  if (!imp.georef) { alert('This survey has no anchor set yet. Set an anchor first.'); return; }
  _rectifyIdx = i;
  // Ensure inline panel content is in the DOM
  const _ip = document.getElementById('cave-inline-panel');
  if (_ip && !document.getElementById('cave-inline-style')) {
    const t1 = document.getElementById('tmpl-style-panel');
    if (t1) _ip.appendChild(t1.content.cloneNode(true));
    const t2 = document.getElementById('tmpl-rectify-panel');
    if (t2) _ip.appendChild(t2.content.cloneNode(true));
  }

  document.getElementById('rectify-survey-name').textContent = imp.name;
  // Populate station dropdown
  const sel = document.getElementById('rectify-station-select');
  sel.innerHTML = '<option value="">-- Select station --</option>';
  (imp.parsed.stations || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name + (imp.georef.station === s.name ? ' (anchor)' : '');
    sel.appendChild(opt);
  });
  _rectifyRenderCPList();
  const _rip = document.getElementById('cave-inline-panel');
  const _rir = document.getElementById('cave-inline-rectify');
  const _ris = document.getElementById('cave-inline-style');
  if (_rip) _rip.style.display = 'block';
  if (_rir) _rir.style.display = 'block';
  if (_ris) _ris.style.display = 'none';
  if (_rip) _rip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window._rectifyClose = function() {
  const _rc = document.getElementById('cave-inline-rectify');
  if (_rc) _rc.style.display = 'none';
  const _rs = document.getElementById('cave-inline-style');
  if (!_rs || _rs.style.display === 'none') { const _rp = document.getElementById('cave-inline-panel'); if (_rp) _rp.style.display = 'none'; }
  _rectifyIdx = null;
};

// Render the control point list inside the panel
function _rectifyRenderCPList() {
  const imp = _caveImports[_rectifyIdx];
  const list = document.getElementById('rectify-cp-list');
  if (!list || !imp) return;
  const cps = imp.georef.controlPoints || [];
  if (!cps.length) {
    list.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:11px;padding:8px 0;">No control points yet. Select a station and click + Add.</div>';
    return;
  }
  list.innerHTML = cps.map((cp, ci) => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
      <span style="font-size:11px;color:#8ecfa8;min-width:50px;font-weight:600;">${cp.station}</span>
      <span style="font-size:10px;color:#aaa;flex:1;font-family:monospace;">${cp.lat.toFixed(6)}, ${cp.lon.toFixed(6)}, ${cp.elev.toFixed(1)}m</span>
      <button onclick="window._rectifyEditCP(${ci})" style="font-size:10px;padding:1px 7px;background:rgba(80,150,255,0.15);border:1px solid rgba(80,150,255,0.3);border-radius:3px;color:#8af;cursor:pointer;">Move</button>
      <button onclick="window._rectifyRemoveCP(${ci})" style="font-size:10px;padding:1px 7px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.25);border-radius:3px;color:#f88;cursor:pointer;">✕</button>
    </div>`).join('');
}

// Start picking — hide panel, show banner, wait for globe click
window._rectifyStartPick = function() {
  const sel = document.getElementById('rectify-station-select');
  const station = sel.value;
  if (!station) {
    const err = document.getElementById('rectify-panel-error');
    if (err) { err.textContent = 'Select a station first.'; err.style.display = 'block'; }
    return;
  }
  document.getElementById('rectify-panel-error').style.display = 'none';
  _rectifyPending = { station };
  { const _xr=document.getElementById('cave-inline-rectify'); if(_xr)_xr.style.display='none'; const _xs=document.getElementById('cave-inline-style'); if(!_xs||_xs.style.display==='none'){const _xp=document.getElementById('cave-inline-panel');if(_xp)_xp.style.display='none';} }
  _rectifyEnterPickMode();
};

window._rectifyEditCP = function(ci) {
  const imp = _caveImports[_rectifyIdx];
  const cp = (imp.georef.controlPoints || [])[ci];
  if (!cp) return;
  imp.georef.controlPoints.splice(ci, 1);
  _rectifyPending = { station: cp.station };
  { const _xr=document.getElementById('cave-inline-rectify'); if(_xr)_xr.style.display='none'; const _xs=document.getElementById('cave-inline-style'); if(!_xs||_xs.style.display==='none'){const _xp=document.getElementById('cave-inline-panel');if(_xp)_xp.style.display='none';} }
  _rectifyEnterPickMode();
};

window._rectifyRemoveCP = function(ci) {
  const imp = _caveImports[_rectifyIdx];
  if (!imp.georef.controlPoints) return;
  imp.georef.controlPoints.splice(ci, 1);
  _rectifyRenderCPList();
  _rerenderCave(_rectifyIdx);
  _sessionSave && _sessionSave();
  _rectifyUpdateRecent(_rectifyIdx);
};

window._rectifyPickStationOnMap = function() {
  { const _xr=document.getElementById('cave-inline-rectify'); if(_xr)_xr.style.display='none'; const _xs=document.getElementById('cave-inline-style'); if(!_xs||_xs.style.display==='none'){const _xp=document.getElementById('cave-inline-panel');if(_xp)_xp.style.display='none';} }
  _rectifyStationPickMode = true;
  const banner = document.getElementById('rectify-station-pick-banner');
  if (banner) banner.style.display = 'block';
  cesiumViewer.canvas.style.cursor = 'pointer';
};

function _rectifyExitStationPickMode() {
  _rectifyStationPickMode = false;
  const banner = document.getElementById('rectify-station-pick-banner');
  if (banner) banner.style.display = 'none';
  cesiumViewer.canvas.style.cursor = '';
}

function _rectifyEnterPickMode() {
  _rectifyPickMode = true;
  const banner = document.getElementById('rectify-pick-banner');
  const nameEl = document.getElementById('rectify-pick-station-name');
  if (nameEl) nameEl.textContent = _rectifyPending.station;
  if (banner) banner.style.display = 'block';
  cesiumViewer.canvas.style.cursor = 'crosshair';
}

function _rectifyExitPickMode() {
  _rectifyPickMode = false;
  const banner = document.getElementById('rectify-pick-banner');
  if (banner) banner.style.display = 'none';
  cesiumViewer.canvas.style.cursor = '';
}

window._rectifyCancelAdjust = function() {
  const adj = document.getElementById('rectify-adjust-overlay');
  if (adj) adj.style.display = 'none';
  _rectifyExitPickMode();
  _rectifyExitStationPickMode();
  _rectifyRemoveMarker();
  _rectifyPending = null;
  if (_rectifyIdx !== null) {
    { const _yr=document.getElementById('cave-inline-panel'); const _yrr=document.getElementById('cave-inline-rectify'); if(_yr)_yr.style.display='block'; if(_yrr)_yrr.style.display='block'; }
  }
};

// Called by the globe click handler (see below)
function _rectifyHandleGlobeClick(lon, lat, elev) {
  _rectifyExitPickMode();
  _rectifyPending.lat  = lat;
  _rectifyPending.lon  = lon;
  _rectifyPending.elev = elev;
  _rectifyPlaceMarker(lat, lon, elev);
  _rectifyShowAdjust();
}

function _rectifyShowAdjust() {
  const p = _rectifyPending;
  document.getElementById('rectify-adj-station').textContent = p.station;
  document.getElementById('rectify-adj-lat').textContent  = p.lat.toFixed(7);
  document.getElementById('rectify-adj-lon').textContent  = p.lon.toFixed(7);
  document.getElementById('rectify-adj-elev').textContent = p.elev.toFixed(2) + ' m';
  document.getElementById('rectify-adjust-overlay').style.display = 'block';
}

function _rectifyPlaceMarker(lat, lon, elev) {
  _rectifyRemoveMarker();
  _rectifyMarker = cesiumViewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, elev),
    point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#ff6e00'),
      outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
    label: {
      text: _rectifyPending.station,
      font: 'bold 12px sans-serif',
      fillColor: Cesium.Color.fromCssColorString('#ff6e00'),
      outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -20),
      disableDepthTestDistance: Infinity,
    }
  });
}

function _rectifyRemoveMarker() {
  if (_rectifyMarker) { cesiumViewer.entities.remove(_rectifyMarker); _rectifyMarker = null; }
}

// dE/dN/dV in metres, applied in ENU at current position
window._rectifyNudge = function(dE, dN, dV) {
  if (!_rectifyPending) return;
  const step = parseFloat(document.getElementById('rectify-step-select')?.value || 1);
  const p = _rectifyPending;
  const cart = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.elev);
  const enu  = Cesium.Transforms.eastNorthUpToFixedFrame(cart);
  const nudgeECEF = Cesium.Matrix4.multiplyByPoint(enu,
    new Cesium.Cartesian3(dE * step, dN * step, dV * step), new Cesium.Cartesian3());
  const carto = Cesium.Cartographic.fromCartesian(nudgeECEF);
  p.lat  = Cesium.Math.toDegrees(carto.latitude);
  p.lon  = Cesium.Math.toDegrees(carto.longitude);
  p.elev += dV * step;
  _rectifyPlaceMarker(p.lat, p.lon, p.elev);
  _rectifyShowAdjust();
};

function _rectifyUpdateRecent(idx) {
  const imp = _caveImports[idx != null ? idx : _rectifyIdx];
  if (imp && imp.parsed && imp.parsed._rawText && imp.georef) {
    _addPltRecent(imp.name, imp.parsed._rawText, imp.georef, imp.displayOptions);
  }
}

// Save displayOptions changes to recent
function _displayUpdateRecent(imp) {
  if (imp && imp.parsed && imp.parsed._rawText && imp.georef) {
    _addPltRecent(imp.name, imp.parsed._rawText, imp.georef, imp.displayOptions);
  }
}

window._rectifySaveToRecent = function() {
  _rectifyUpdateRecent(_rectifyIdx);
  const err = document.getElementById('rectify-panel-error');
  if (err) { err.style.color = '#8fa'; err.textContent = '✓ Rectification saved to recent files.'; err.style.display = 'block'; setTimeout(() => { err.style.display = 'none'; err.style.color = '#f88'; }, 2500); }
};

window._rectifyConfirmCP = function() {
  const p = _rectifyPending;
  if (!p || p.lat == null) return;
  const imp = _caveImports[_rectifyIdx];
  if (!imp.georef.controlPoints) imp.georef.controlPoints = [];
  imp.georef.controlPoints = imp.georef.controlPoints.filter(c => c.station !== p.station);
  imp.georef.controlPoints.push({ station: p.station, lat: p.lat, lon: p.lon, elev: p.elev });
  _rectifyRemoveMarker();
  _rectifyPending = null;
  document.getElementById('rectify-adjust-overlay').style.display = 'none';
  _rerenderCave(_rectifyIdx);
  _renderCaveList();
  _sessionSave && _sessionSave();
  _rectifyUpdateRecent(_rectifyIdx);
  { const _yr=document.getElementById('cave-inline-panel'); const _yrr=document.getElementById('cave-inline-rectify'); if(_yr)_yr.style.display='block'; if(_yrr)_yrr.style.display='block'; }
  _rectifyRenderCPList();
};

window._rectifyReset = function() {
  const imp = _caveImports[_rectifyIdx];
  if (!imp) return;
  if (!confirm('Remove all control points for this survey?')) return;
  imp.georef.controlPoints = [];
  _rectifyRenderCPList();
  _rerenderCave(_rectifyIdx);
  _renderCaveList();
  _sessionSave && _sessionSave();
  _rectifyUpdateRecent(_rectifyIdx);
};

// Wire globe click for pick mode
(function() {
  const handler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);
  handler.setInputAction(function(click) {
    // Station-pick mode: user clicks a station entity to select it
    if (_rectifyStationPickMode) {
      const picked = cesiumViewer.scene.pick(click.position);
      if (picked && picked.id) {
        const entity = picked.id;
        const imp = _caveImports[_rectifyIdx];
        if (imp && entity.properties && entity.properties.surveyName &&
            entity.properties.surveyName.getValue() === imp.name) {
          const stName = entity.name;
          if (imp.parsed.stations.find(s => s.name === stName)) {
            _rectifyExitStationPickMode();
            // Also pre-select in dropdown for reference
            const sel = document.getElementById('rectify-station-select');
            if (sel) sel.value = stName;
            _rectifyPending = { station: stName };
            _rectifyEnterPickMode();
            return;
          }
        }
      }
      // Clicked terrain or wrong survey — ignore (user can click again or Esc)
      return;
    }
    if (!_rectifyPickMode) return;
    const ray = cesiumViewer.camera.getPickRay(click.position);
    if (!ray) return;
    const cart = cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene);
    if (!cart) return;
    const carto = Cesium.Cartographic.fromCartesian(cart);
    const lat  = Cesium.Math.toDegrees(carto.latitude);
    const lon  = Cesium.Math.toDegrees(carto.longitude);
    const elev = carto.height;
    _rectifyHandleGlobeClick(lon, lat, elev);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (_rectifyPickMode || _rectifyStationPickMode)) { window._rectifyCancelAdjust(); }
  });
})();

// ── Warp algorithm ────────────────────────────────────────────────────────────
function _computeWarpedOffset(dE, dN, dV, controlPairsENU) {
  const N = controlPairsENU.length;
  if (N === 0) return { e: dE, n: dN, v: dV };

  if (N === 1) {
    const t = { e: controlPairsENU[0].dst.e - controlPairsENU[0].src.e,
                n: controlPairsENU[0].dst.n - controlPairsENU[0].src.n,
                v: controlPairsENU[0].dst.v - controlPairsENU[0].src.v };
    return { e: dE + t.e, n: dN + t.n, v: dV + t.v };
  }

  const srcs = controlPairsENU.map(p => p.src);
  const dsts = controlPairsENU.map(p => p.dst);
  let cx_s = 0, cy_s = 0, cx_d = 0, cy_d = 0;
  srcs.forEach(p => { cx_s += p.e; cy_s += p.n; });
  dsts.forEach(p => { cx_d += p.e; cy_d += p.n; });
  cx_s /= N; cy_s /= N; cx_d /= N; cy_d /= N;
  let ss = 0, dot = 0, cross = 0;
  for (let i = 0; i < N; i++) {
    const ax = srcs[i].e - cx_s, ay = srcs[i].n - cy_s;
    const bx = dsts[i].e - cx_d, by = dsts[i].n - cy_d;
    ss += ax*ax + ay*ay;
    dot   += ax*bx + ay*by;
    cross += ax*by - ay*bx;
  }
  const mag = Math.sqrt(dot*dot + cross*cross);
  const scale = ss > 1e-6 ? mag / ss : 1;
  const cos_t = mag > 1e-10 ? dot / mag : 1;
  const sin_t = mag > 1e-10 ? cross / mag : 0;
  const tx = cx_d - scale * (cos_t * cx_s - sin_t * cy_s);
  const ty = cy_d - scale * (sin_t * cx_s + cos_t * cy_s);

  const re = scale * (cos_t * dE - sin_t * dN) + tx;
  const rn = scale * (sin_t * dE + cos_t * dN) + ty;

  let sumWv = 0, dvv = 0;
  for (let i = 0; i < N; i++) {
    const de = dE - srcs[i].e, dn = dN - srcs[i].n;
    const d2 = de*de + dn*dn;
    if (d2 < 1e-6) { dvv = dsts[i].v - srcs[i].v; sumWv = 1; break; }
    const w = 1 / d2;
    sumWv += w;
    dvv += w * (dsts[i].v - srcs[i].v);
  }
  const rv = dV + (sumWv > 0 ? dvv / sumWv : 0);

  if (N < 3) return { e: re, n: rn, v: rv };

  const rigidSrcs = srcs.map(p => ({
    e: scale * (cos_t * p.e - sin_t * p.n) + tx,
    n: scale * (sin_t * p.e + cos_t * p.n) + ty,
  }));
  const residuals = dsts.map((d, i) => ({ e: d.e - rigidSrcs[i].e, n: d.n - rigidSrcs[i].n }));
  let sumW = 0, corrE = 0, corrN = 0;
  for (let i = 0; i < N; i++) {
    const de = re - rigidSrcs[i].e, dn = rn - rigidSrcs[i].n;
    const d2 = de*de + dn*dn;
    if (d2 < 1e-6) { corrE = residuals[i].e; corrN = residuals[i].n; sumW = 1; break; }
    const w = 1 / d2;
    sumW += w;
    corrE += w * residuals[i].e;
    corrN += w * residuals[i].n;
  }
  return { e: re + (sumW > 0 ? corrE/sumW : 0), n: rn + (sumW > 0 ? corrN/sumW : 0), v: rv };
}

requestAnimationFrame(loop);
