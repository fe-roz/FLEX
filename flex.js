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
  notifySearchPinsChanged,
} from "./session.js";
import { initSpaceMouse } from "./spacemouse.js";
import { breakoutToPlt, isBreakoutFile } from "./breakout.js";
import { readWallsShapefileSets, wallsToPlt, isWallsSelection } from "./walls.js";
import { parsePLT, utmToLatLon, setupCompassPlt } from "./client/src/modules/compass-plt.js";
import { rampColor, rampRgb, rampCss, percentileRange, lazyPick, materialize, installLazyPick,
         addLinePrimitive, addStationLayer, removePrimitive,
         lrudWH, steepScore, whRgb, wallHardRgb, hardLegendRows, HARD_UNKNOWN } from "./cave_layers.js";
import { levelFrame, planGroundGrid, pushFootLine, sampleGroundGrid, gridCovers, depthBelowGround,
         binLidarGround, mergeLidarGround, gridFromLidar } from "./cave_ground.js";

// A line icon (icons.js) in front of a label in HTML built here: `${_ic('pin')}Label`.
const _ic = name => (window.icon ? window.icon(name, '1.15em', 'ico-l') : '');

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

import { setupSearchPins } from "./client/src/modules/search-pins.js";
import { setupSelectionMonitor } from "./client/src/modules/selection-monitor.js";
import { setupUpdateChecker } from "./client/src/modules/update-checker.js";
import { setupPoiList } from "./client/src/modules/poi-list.js";
import { setupWorkspaceHooks } from "./client/src/modules/workspace-hooks.js";
import { setupMeasureMode } from "./client/src/modules/measure-mode.js";
import { setupHtmlLabels } from "./client/src/modules/html-labels.js";
// Moved to client/src/modules/search-pins.js: search pins (geocoder result -> pin + fly-in), window._clearSearchPins.
const { escapeHtml: _escapeHtml } = setupSearchPins({ Cesium, cesiumViewer, savedSession: _savedSession, notifySearchPinsChanged });
// Moved to client/src/modules/poi-list.js (called here, earlier than its old line: renderPoiList is reached from
// callbacks that can run before it).
const { renderPoiList } = setupPoiList({ Cesium, cesiumViewer, downloadBlob });

// Moved to client/src/modules/selection-monitor.js: the floating "Add Point Cloud" button and the
// 100 ms watcher of the selected entity.
setupSelectionMonitor({
  cesiumViewer, workflowState, ic: _ic, onWorkflowEntitySelected, hideProcessAreaLayer, stopWorkflowPolling,
  updateWorkflowSelectionLabels, updateWorkflowPanelVisibility, updateStatusCards, updateWorkflowButtons,
  refreshServerMonitor,
});

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

// Potree starts its own animation loop in its constructor
// (viewer.js:320, setAnimationLoop) regardless of useDefaultRenderLoop - the
// check that was supposed to gate it is commented out upstream. That loop ran
// update() and render() every frame while FLEX's own loop rendered a second
// time, so the cloud was drawn twice, and worse, updateVisibility picked LOD
// nodes BEFORE the Cesium camera had been synced to Potree. LOD was being
// decided against a camera one frame stale. FLEX drives both itself now, in
// the right order, at the end of loop().
potreeViewer.renderer.setAnimationLoop(null);

// Four requests in flight starves the near field when the falloff below makes
// it the only thing worth loading.
Potree.maxNodesLoading = 8;

// A node smaller than this on screen is not refined. Potree's own default
// is 30, which is permissive enough that an oblique view spends the budget
// on the horizon. 90 was picked in the field. The Detail slider overrides
// this once the UI wires up; this is the value if it never does.
potreeViewer.setMinNodeSize(90);
potreeViewer.loadSettingsFromURL();
potreeViewer.setBackground(null);
potreeViewer.useHQ = false;
// potreeViewer.setLengthUnit('m');
potreeViewer.setDescription("");


// Cave survey loaded on demand via #lp-cave-toggle in the Layers panel


Cesium.Math.setRandomNumberSeed(0);
// ── LiDAR footprints, backend catalog, OpenTopography, Data Files ─────────────
// Moved to client/src/modules/cesium-datasources.js (setupCesiumDatasources).
import { setupCesiumDatasources } from "./client/src/modules/cesium-datasources.js";
const { setLidarFootprintsVisible, setOtFootprintsVisible, loadBackendCatalog, _otHandleClick,
        loadedDataFiles, renderDataFileList, addDataFile, removeDataFile } = setupCesiumDatasources({
  Cesium, cesiumViewer, viewModel, ProxyUrlGenerator, getBackendBaseUrl, toAbsoluteUrl, notifyDataFilesChanged,
});



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


import { setupCompass } from "./client/src/modules/navigation-aids/compass.js";
import { setupMinimap } from "./client/src/modules/navigation-aids/minimap.js";
import { setupMinimapSync } from "./client/src/modules/navigation-aids/minimap-sync.js";
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

// The 3D north compass, the minimap and its per-frame sync live in
// client/src/modules/navigation-aids/ (compass.js, minimap.js, minimap-sync.js).
// miniMapMap / miniMapUserHidden / miniMapCaltopoSource are used further down
// (the CalTopo code, the toggle flag), so they stay here behind a get/set object.
let miniMapMap = null;
let miniMapUserHidden = false;
let miniMapCaltopoSource = null;
const miniMapState = {
  get miniMapMap() { return miniMapMap; },
  set miniMapMap(v) { miniMapMap = v; },
  get miniMapUserHidden() { return miniMapUserHidden; },
  set miniMapUserHidden(v) { miniMapUserHidden = v; },
  get miniMapCaltopoSource() { return miniMapCaltopoSource; },
  set miniMapCaltopoSource(v) { miniMapCaltopoSource = v; },
};
const { cycleCompassStyle, initNorthCompass, updateNorthCompass } = setupCompass({ Cesium, THREE, cesiumViewer, ellipsoid });
const miniMapApi = setupMinimap({ Cesium, ol, cesiumViewer, state: miniMapState });
const { initMiniMap, loadAttentionGrid, saveAttentionGrid, syncMinimapCaltopoFeatures } = miniMapApi;
const { syncMiniMapFrame, sampleHeightAboveGround, _globeGroundNow } = setupMinimapSync({ Cesium, ol, cesiumViewer, scene, state: miniMapState, mm: miniMapApi.shared });

Cesium.knockout.track(viewModel);
const _layersReady = loadLayers().catch((error) => console.error("Layer loading error:", error));
loadAttentionGrid();
initMiniMap();
initializeContextMenu({ Cesium, cesiumViewer });

// Init session system (wires auto-save triggers, exposes window._sessionSave)
initSession(cesiumViewer, viewModel);

// Shared helper: apply the correct Z matrix to a loaded point cloud based on
// current toggle state.  Called at load time and on every toggle change.
//   egm96 ON  → precise EGM96 geoid lookup (pcZscale + meanSeaLevel offset; credits: THIRD_PARTY.md)
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
      // Caves follow the point clouds' datum shift (_pcDatumDz).
      _caveImports.forEach((imp, i) => { if (imp.georef) window._rerenderCave(i); });
      _caveColourChanged();
    });
  });

  renderLayerList();
});

// Restore saved state after full init (addPC interceptor and CalTopo fns are defined below this point)
const _projectAtStart = (() => { try { return localStorage.getItem('flex.project') || ''; } catch (_) { return ''; } })();
setTimeout(() => {
  // With a project open, project_workspace.js loads its point clouds, CalTopo
  // maps and data files; the prompts below are for FLEX without a project.
  if (_savedSession?.pointClouds?.length && !_projectAtStart) {
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
  if (_savedSession?.caltopoUrl && !_projectAtStart) {
    const input = document.getElementById('caltopo_url_input');
    const sel   = document.getElementById('caltopo_interval_select');
    if (input) input.value = _savedSession.caltopoUrl;
    if (sel && _savedSession.caltopoInterval != null) {
      sel.value = String(_savedSession.caltopoInterval);
    }
    loadCaltopoKml(_savedSession.caltopoUrl, _savedSession.caltopoInterval ?? 60);
  }

  // Data files: My data's (it takes in URL files the old saved view still lists)
  if (!_projectAtStart && window._myData) {
    window._myData.filesToRestore(_savedSession?.dataFiles || []).then(list => list.forEach(f =>
      addDataFile(f.url, f.label, { myId: f.id }).catch(e => console.warn('[my data] data file restore failed:', e))))
      .catch(e => console.warn('[my data] data files:', e));
  } else if (_savedSession?.dataFiles?.length && !_projectAtStart) {
    for (const f of _savedSession.dataFiles) {
      addDataFile(f.url, f.label).catch(e => console.warn('[session] data file restore failed:', e));
    }
  }
  // Points of interest kept in My data
  if (window._myData) window._myData.points().then(ps => {
    ps.forEach(p => cesiumViewer.entities.add({ name: p.name, label: { scale: p.scale, text: p.name, show: p.label !== false }, position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h),
      properties: { isUserLabel: true, myFeature: p.id }, point: p.color ? { color: Cesium.Color.fromCssColorString(p.color) } : {} }));
    if (ps.length) renderPoiList();
  }).catch(e => console.warn('[my data] points:', e));

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

// Moved to client/src/modules/update-checker.js (window._checkForUpdates).
setupUpdateChecker();
import { setupPotreePointcloud } from "./client/src/modules/potree-pointcloud.js";
import { setupPointcloudIncidence } from "./client/src/modules/pointcloud-incidence.js";
import { setupPointcloudHag } from "./client/src/modules/pointcloud-hag.js";
import { setupEntwineLocal } from "./client/src/modules/entwine-local.js";

// addPC, the addPC interceptor (tracks loaded URLs), the restore banner and the
// Point Cloud list moved to client/src/modules/potree-pointcloud.js (flex.js split, wave 2).
const { renderPcList, removePc, showPcRestorePrompt, pcUrlByName: _pcUrlByName } = setupPotreePointcloud({
  THREE, Potree, proj4, potreeViewer, viewModel, applyPcMatrix, notifyPcLoaded, saveSession,
});

// ── CalTopo KML Network Link ──────────────────────────────────────────────────
// Moved to client/src/modules/caltopo-map.js (the map link, its JSON -> entities,
// status row, key and bookmarklet login). The Layers panel header (_lpToggle) is in layer-list.js.
import { setupCaltopoMap } from "./client/src/modules/caltopo-map.js";
const { caltopoState, loadCaltopoKml, clearCaltopo, renderCaltopoStatus, _fetchCaltopoKml, _showCaltopoLoggedIn } = setupCaltopoMap({
  Cesium, cesiumViewer, ProxyUrlGenerator, ic: _ic, notifyCaltopoChanged,
  miniMapState, syncMinimapCaltopoFeatures,
});

// ── Point Cloud list ──────────────────────────────────────────────────────────
// renderPcList / removePc moved to client/src/modules/potree-pointcloud.js (flex.js split, wave 2).
window._renderPcList = renderPcList;

// ── Data Files list ───────────────────────────────────────────────────────────
// Moved to client/src/modules/cesium-datasources.js (set up at "LiDAR footprints" above).

// Moved to client/src/modules/poi-list.js (renderPoiList, window._exportPoi); set up early, at "Search pins" above,
// because renderPoiList is reached from callbacks that can run before this line.
// ── CalTopo status row ────────────────────────────────────────────────────────
// Moved to client/src/modules/caltopo-map.js (renderCaltopoStatus).

import { setupCaveImport } from "./client/src/modules/cave-import.js";
import { setupCaveGeoref, computeWarpedOffset as _computeWarpedOffset } from "./client/src/modules/cave-georef.js";
// ── Cave Survey ───────────────────────────────────────────────────────────────
// Moved to client/src/modules/cave-import.js: recents (EPT + PLT), cave sets,
// loading a survey (wizard, Walls, Breakout), replace survey, globe pick,
// anchored / UTM render. This file keeps the shared state and the wiring.
//
// Each imported survey is stored as:
//   { name, parsed, entities: Cesium.EntityCollection-like[], visible: true }
// Entities are added directly to cesiumViewer.entities (not a DataSource)
// so we have fine-grained control over each polyline / point.

let _caveImports = [];       // Array of { name, parsed, cesiumIds, visible }
// flex.js is an ES module, so its top-level names are invisible to the inline
// scripts in index.html — the export collector reads the cave list (LRUDs,
// survey names, passage walls) through this window reference. The array is
// only ever mutated in place, never reassigned, so the reference stays valid.
window._caveImports = _caveImports;
let _cwizParsed  = null;     // Holds last-parsed PLT data while wizard is open
let _recents = { ept: [], plt: [], pltSets: [] };   // pltSets: saved selections of caves
let _cavePickMode = false;   // globe pick (cave-import.js; the canvas click handler near the top reads these)
let _cavePickResolve = null;
const caveImportState = {
  get recents() { return _recents; },               set recents(v) { _recents = v; },
  get cwizParsed() { return _cwizParsed; },         set cwizParsed(v) { _cwizParsed = v; },
  get cavePickMode() { return _cavePickMode; },     set cavePickMode(v) { _cavePickMode = v; },
  get cavePickResolve() { return _cavePickResolve; }, set cavePickResolve(v) { _cavePickResolve = v; },
};
const {
  addPltRecent: _addPltRecent, fetchPltCache: _fetchPltCache, finishCaveLoad: _finishCaveLoad,
  placeCave: _placeCave, initPltRestoreInput: _initPltRestoreInput, loadRecents: _loadRecents,
  removePltRecent: _removePltRecent, startGlobePick: _startGlobePick, displayUpdateRecent: _displayUpdateRecent,
} = setupCaveImport({
  Cesium, cesiumViewer, viewModel, caveImports: _caveImports, state: caveImportState,
  isWallsSelection, readWallsShapefileSets, wallsToPlt, isBreakoutFile, breakoutToPlt,
  caveColourChanged: (...a) => _caveColourChanged(...a), notifyCaveVisibilityChanged,
  rerenderCave: (...a) => window._rerenderCave(...a), renderCaveList: () => _renderCaveList(),
  defaultDisplayOptions: (...a) => _defaultDisplayOptions(...a), escapeHtml: (...a) => _escapeHtml(...a), icon: (...a) => _ic(...a),
});


// Moved to client/src/modules/workspace-hooks.js: window._ws (workspace hooks for projects) and _caveGeometry.
setupWorkspaceHooks({
  Cesium, cesiumViewer, viewModel, parsePLT, restoreCamera, restoreLayerState, state: caveImportState,
  _caveImports, _pcUrlByName, caltopoState, loadedDataFiles, _placeCave, _finishCaveLoad, removePc,
  loadCaltopoKml, clearCaltopo, renderDataFileList, addDataFile, removeDataFile, _fetchPltCache,
  _addPltRecent, _removePltRecent, _caveUtmConvertFn,
});
// ── Compass PLT: parser, UTM → WGS84, PLT → Cartesian3 ───────────────────────
// Moved to client/src/modules/compass-plt.js (parsePLT and utmToLatLon are imported
// at the top). _pltToCartesian has no callers today; the binding is kept as before.
const { pltToCartesian: _pltToCartesian } = setupCompassPlt({ Cesium });

import { setupCaveUtm } from "./client/src/modules/cave-utm.js";
import { setupCaveDepth } from "./client/src/modules/cave-depth.js";
import { setupCavePassages } from "./client/src/modules/cave-passages.js";
import { setupCaveLeadsLabels } from "./client/src/modules/cave-leads-labels.js";
import { setupCaveDisplay, defaultDisplayOptions as _defaultDisplayOptions, CAVE_COLOUR_MODES } from "./client/src/modules/cave-display.js";
import { setupCaveStylePanel } from "./client/src/modules/cave-style-panel.js";

// ── Cave list, drawing, passage walls, leads, area labels, colour by, depth ──
// Moved to client/src/modules/cave-{display,passages,leads-labels,depth,utm}.js
// (flex.js split, wave 1). Set up in this order; the lazy wrappers reach the
// modules set up after them.

// The "colour by" mode stays here: cave-display, cave-passages and cave-depth read
// and write it through caveColourState.
let _caveColourMode = (() => {
  try { const m = localStorage.getItem('flex.caveColour'); return CAVE_COLOUR_MODES.includes(m) ? m : 'survey'; }
  catch (_) { return 'survey'; }
})();
const caveColourState = {
  get colourMode() { return _caveColourMode; },
  set colourMode(v) { _caveColourMode = v; },
};

const caveUtm = setupCaveUtm({
  Cesium, viewModel, meanSeaLevel, utmToLatLon,
  computeWarpedOffset: (...a) => _computeWarpedOffset(...a),     // georectification (later in this file)
});
const caveDepth = setupCaveDepth({
  Cesium, cesiumViewer, viewModel, state: caveColourState, caveImports: _caveImports,
  caveColourChanged: (...a) => caveDisplay.caveColourChanged(...a),
  renderCaveColourUI: (...a) => caveDisplay.renderCaveColourUI(...a),
  levelFrame, planGroundGrid, pushFootLine, sampleGroundGrid, gridCovers,
  binLidarGround, mergeLidarGround, gridFromLidar,
});
const cavePassages = setupCavePassages({
  Cesium, cesiumViewer, state: caveColourState, defaultDisplayOptions: _defaultDisplayOptions,
  caveColourRgb: (...a) => caveDisplay.caveColourRgb(...a),
  lrudWH, steepScore, wallHardRgb, HARD_UNKNOWN,
});
const caveLeadsLabels = setupCaveLeadsLabels({
  Cesium, cesiumViewer, caveImports: _caveImports, ic: _ic, escapeHtml: _escapeHtml,
  renderCaveList: (...a) => caveDisplay.renderCaveList(...a),
  setCaveLayersVisible: (...a) => caveDisplay.setCaveLayersVisible(...a),
  displayUpdateRecent: (...a) => _displayUpdateRecent(...a),     // cave import (later in this file)
});
const caveDisplay = setupCaveDisplay({
  Cesium, cesiumViewer, state: caveColourState, caveImports: _caveImports,
  ic: _ic, startGlobePick: (...a) => _startGlobePick(...a), notifyCaveVisibilityChanged,
  installLazyPick, lazyPick, addLinePrimitive, addStationLayer, removePrimitive,
  rampRgb, rampCss, percentileRange, lrudWH, steepScore, whRgb, hardLegendRows, depthBelowGround,
  pcDatumDz: caveUtm.pcDatumDz, caveUtmConvertFn: caveUtm.caveUtmConvertFn,
  computeWarpedOffset: (...a) => _computeWarpedOffset(...a),
  buildCavePassages: cavePassages.buildCavePassages, removeCavePassages: cavePassages.removeCavePassages,
  setCavePassageVisible: cavePassages.setCavePassageVisible,
  caveStationPts: caveDepth.caveStationPts, caveFrame: caveDepth.caveFrame,
  caveGroundValid: caveDepth.caveGroundValid, caveGround: caveDepth.caveGround,
  loadedClouds: caveDepth.loadedClouds, lidar: caveDepth.lidar,
  isLeadEntity: caveLeadsLabels.isLeadEntity, isAreaLabelEntity: caveLeadsLabels.isAreaLabelEntity,
  areaLabelsShown: caveLeadsLabels.areaLabelsShown, leadsVisible: caveLeadsLabels.leadsVisible,
  areaLabelsVisible: caveLeadsLabels.areaLabelsVisible, caveAreaLabelList: caveLeadsLabels.caveAreaLabelList,
  addCaveLeads: caveLeadsLabels.addCaveLeads, addCaveAreaLabels: caveLeadsLabels.addCaveAreaLabels,
});

// Hoisted forwarders for the five functions the rest of this file calls (they used
// to be function declarations; code that runs before this point, or passes them
// into a setup call earlier in the file, still finds them).
function setCaveSurveyVisible(...a) { return caveDisplay.setCaveSurveyVisible(...a); }
function _renderCaveList(...a) { return caveDisplay.renderCaveList(...a); }
function _buildCaveStations(...a) { return caveDisplay.buildCaveStations(...a); }
function _caveColourChanged(...a) { return caveDisplay.caveColourChanged(...a); }
function _caveUtmConvertFn(...a) { return caveUtm.caveUtmConvertFn(...a); }

// ── Globe pick mode, cave render (anchor / UTM), Wizard UI ───────────────────
// Moved to client/src/modules/cave-import.js (setupCaveImport, called at "Cave Survey" above).


// ── Overlay drag-and-drop, Layer list, CalTopo login ─────────────────────────
// The layer list moved to client/src/modules/layer-list.js; the CalTopo key and
// bookmarklet login to client/src/modules/caltopo-map.js (set up at "CalTopo KML Network Link").
import { setupLayerList } from "./client/src/modules/layer-list.js";
const { subscribeLayerToSession, renderLayerList } = setupLayerList({
  Cesium, viewModel, LAYER_CATALOG, addCatalogLayer, removeCatalogLayer,
  updateLayerList, saveSession, notifyPanelSectionToggled,
});

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

  // Detail: minimumNodePixelSize, the smallest a node may appear before Potree
  // refuses to refine it. viewer.update() pushes this onto every point cloud
  // each frame, so it has to be set on the viewer - writing
  // pointcloud.minimumNodePixelSize directly is overwritten next frame.
  const detailSlider = document.getElementById('lp-lod-detail');
  const detailLabel  = document.getElementById('lp-lod-detail-label');
  function _applyDetail(px) {
    potreeViewer.setMinNodeSize(px);
    if (detailSlider) detailSlider.value = px;
    if (detailLabel)  detailLabel.textContent = px + ' px';
  }
  if (detailSlider) {
    _applyDetail(parseInt(detailSlider.value, 10));
    detailSlider.addEventListener('input',
      () => _applyDetail(parseInt(detailSlider.value, 10)));
  }

  // Load priority range: the knee of the loading-order falloff. Inside it a
  // node keeps its full weight; beyond it weight falls as 1/(1+(d/near)^2).
  const nearSlider = document.getElementById('lp-lod-near');
  const nearLabel  = document.getElementById('lp-lod-near-label');
  function _applyNear(metres) {
    Potree.lodNearDistance = metres;
    if (nearLabel) nearLabel.textContent = metres > 0 ? metres + ' m' : 'off';
  }
  if (nearSlider) {
    _applyNear(parseInt(nearSlider.value, 10));
    nearSlider.addEventListener('input',
      () => _applyNear(parseInt(nearSlider.value, 10)));
  }

  // Far cutoff: past this distance a node must be lodFarPenalty times larger
  // on screen before it refines, so the horizon stops eating the budget.
  const farSelect = document.getElementById('lp-lod-far');
  const farLabel  = document.getElementById('lp-lod-far-label');
  function _applyFar(metres) {
    Potree.lodFarDistance = metres;
    if (farLabel) farLabel.textContent = metres > 0
      ? (metres / 1609.344).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' mi'
      : 'off';
  }
  if (farSelect) {
    _applyFar(parseFloat(farSelect.value));
    farSelect.addEventListener('change',
      () => _applyFar(parseFloat(farSelect.value)));
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

import { setupCesiumInteractions, downloadBlob } from "./client/src/modules/cesium-interactions.js";
// Moved to client/src/modules/cesium-interactions.js: camera mouse buttons, SpaceMouse init, input handler,
// fly speed, key flags (keydown/keyup), touch fly and the fly tick. The variables below stay here.
const interactionState = {
  get pointCounter() { return pointCounter; },       set pointCounter(v) { pointCounter = v; },
  get creatingRoute() { return creatingRoute; },     set creatingRoute(v) { creatingRoute = v; },
  get routePoints() { return routePoints; },         set routePoints(v) { routePoints = v; },
  get currentEntity() { return currentEntity; },     set currentEntity(v) { currentEntity = v; },
  get miniMapUserHidden() { return miniMapUserHidden; }, set miniMapUserHidden(v) { miniMapUserHidden = v; },
  get miniMapMap() { return miniMapMap; },
};
const { handler, spaceMouse: _spaceMouse, getFlyMultiplier } = setupCesiumInteractions({
  Cesium, cesiumViewer, scene, canvas, flags, viewModel, potreeViewer, workflowState,
  state: interactionState,
  initSpaceMouse, sampleHeightAboveGround: (...a) => sampleHeightAboveGround(...a),
  otHandleClick: (...a) => _otHandleClick(...a),
  globeGroundNow: (...a) => _globeGroundNow(...a),
  stopAoiDrawMode: (...a) => stopAoiDrawMode(...a),
  renderPcList: (...a) => renderPcList(...a),
  renderPoiList: (...a) => renderPoiList(...a),
  cycleCompassStyle: (...a) => cycleCompassStyle(...a),
  toggleMeasureMode: (...a) => toggleMeasureMode(...a),
});

// ── Angle of Incidence Visualization ────────────────────────────────
// Moved to client/src/modules/pointcloud-incidence.js (flex.js split, wave 2); the
// render loop below reads incidenceState and calls updateIncidenceLines.
const { incidenceState, updateIncidenceLines } = setupPointcloudIncidence({ THREE, potreeViewer });

// Moved to client/src/modules/measure-mode.js (depth / distance measurement, V) and
// html-labels.js (screen-space label overlay); loop() calls the two update functions.
const { toggleMeasureMode, updateMeasureDisplay } = setupMeasureMode({ Cesium, cesiumViewer, ic: _ic });
const { updateHtmlLabels } = setupHtmlLabels({ Cesium, cesiumViewer, notifyPoiVisibilityChanged });
function loop(timestamp){
  requestAnimationFrame(loop);
  if (_spaceMouse) _spaceMouse.update(timestamp);
  onCameraFrame();

  // console.log(timestamp);

  // (LOD update + render happen at the end of this function, after the
  //  camera sync - see potreeViewer.update below.)

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
  document.getElementById("elev_display").innerText = "Height: " + cCamHeight.toFixed(0) + "m" +
    (flags.Fly ? "  ·  fly ×" + +getFlyMultiplier().toPrecision(2) : "");
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

  // Now that the Cesium camera has been synced onto the Potree camera, decide
  // LOD and draw. Order matters: update() is what runs updateVisibility, so it
  // has to see the camera we are about to render from.
  potreeViewer.update(potreeViewer.clock.getDelta(), timestamp);
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
// Moved to client/src/modules/entwine-local.js (flex.js split, wave 2); the
// window._entwine* hooks are defined there.
const { loadEntwineConfig: _loadEntwineConfig } = setupEntwineLocal({ ic: _ic });

_loadRecents();        // populate EPT + PLT recent lists
_initPltRestoreInput(); // wire the hidden PLT cache-miss file picker
_loadEntwineConfig();   // restore local Entwine server state

// ── Cave style panel, and one style setting for every loaded cave ────────────
// Moved to client/src/modules/cave-style-panel.js (flex.js split, wave 1).
setupCaveStylePanel({
  caveImports: _caveImports,
  buildCaveStations: (...a) => _buildCaveStations(...a),
  setCaveLayersVisible: (...a) => caveDisplay.setCaveLayersVisible(...a),
  displayUpdateRecent: (...a) => _displayUpdateRecent(...a),     // cave import (later in this file)
});

// ── Georectification and warp algorithm ──────────────────────────────────────
// Moved to client/src/modules/cave-georef.js (rectify panel, control points,
// warp maths); computeWarpedOffset is imported at the top of the cave-import section.
setupCaveGeoref({
  Cesium, cesiumViewer, viewModel, caveImports: _caveImports, materialize,
  addPltRecent: _addPltRecent, displayUpdateRecent: _displayUpdateRecent,
  rerenderCave: (...a) => window._rerenderCave(...a), renderCaveList: () => _renderCaveList(),
  caveColourChanged: (...a) => _caveColourChanged(...a), buildCaveStations: (...a) => _buildCaveStations(...a),
});

requestAnimationFrame(loop);


// ── Height-Above-Ground live filter ──────────────────────────────────────────
// Moved to client/src/modules/pointcloud-hag.js (flex.js split, wave 2); window._hag
// and the window._hag* hooks are defined there.
setupPointcloudHag({ potreeViewer });
