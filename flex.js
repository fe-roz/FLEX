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
window.addPC = function(url){

// Derive a readable name from the URL: use the path segment before /ept.json
const _pcName = (function() {
  try {
    const parts = url.replace(/\/ept\.json.*$/i, '').split('/');
    return parts[parts.length - 1] || url;
  } catch(_) { return url; }
})();

const _loadPC = () => Potree.loadPointCloud(url, _pcName, function(e){
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

// Potree's EptLoader fetches ept.json inside a promise nobody can catch, so an
// unreachable cloud was an uncaught page error and nothing on screen. Fetch it
// here first (the browser caches it for Potree) and say so if it fails.
if (/ept\.json/i.test(url)) {
  fetch(url)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(() => _loadPC(), err => {
      console.warn(`[pointcloud] couldn't load "${_pcName}" (${url}): ${err && err.message || err}`);
      if (window._pjApi && window._pjApi.toast) window._pjApi.toast(`Couldn't load the point cloud "${_pcName}" — its server didn't answer`);
    });
} else {
  _loadPC();
}

}

// Intercept addPC to track loaded URLs for session persistence and update panel
const _origAddPC = window.addPC;
const _pcUrlByName = {};       // cloud name → the URL it was loaded from (project workspace)
window.addPC = function(url) {
  try { _pcUrlByName[url.replace(/\/ept\.json.*$/i, '').split('/').filter(Boolean).pop() || url] = url; } catch (_) {}
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
// Moved to client/src/modules/caltopo-map.js (the map link, its JSON -> entities,
// status row, key and bookmarklet login). The Layers panel header (_lpToggle) is in layer-list.js.
import { setupCaltopoMap } from "./client/src/modules/caltopo-map.js";
const { caltopoState, loadCaltopoKml, clearCaltopo, renderCaltopoStatus, _fetchCaltopoKml, _showCaltopoLoggedIn } = setupCaltopoMap({
  Cesium, cesiumViewer, ProxyUrlGenerator, ic: _ic, notifyCaltopoChanged,
  miniMapState, syncMinimapCaltopoFeatures,
});

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
      `<button class="lp-eye-btn ui-eye${pc.visible !== false ? ' on' : ' half'}" title="${pc.visible !== false ? 'Hide' : 'Show'}"></button>` +
      `<span class="lp-row-name" title="${name}">${name}</span>` +
      `<button class="lp-remove-btn" title="Remove">✕</button>`;
    row.querySelector('.lp-eye-btn').addEventListener('click', () => {
      pc.visible = pc.visible === false ? true : false;
      renderPcList();
    });
    row.querySelector('.lp-remove-btn').addEventListener('click', () => removePc(pc));
    if (window._pjWs && window._pjWs.pcRow) window._pjWs.pcRow(row, _pcUrlByName[pc.name]);   // 📁 in / add to the open project
    container.appendChild(row);
  });
}
window._renderPcList = renderPcList;

function removePc(pc) {
  if (window._pjWs && !window._ws.switching && _pcUrlByName[pc.name]) window._pjWs.removed('pointcloud', _pcUrlByName[pc.name]);
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
      const gpsAttr = g.attributes['gps-time'] || g.attributes.gpsTime; // Potree 1.8.2 names it 'gps-time'
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
    btn.innerHTML = _ic('server') + 'Link Entwine';
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
    btn.innerHTML = _ic('folder-open') + 'Entwine Datasets';
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
//
// Restores the filter removed in bdecc3f0 ("the Z-coordinate mapping between the
// JS ground-grid scan and the GLSL shader could not be reconciled reliably").
// The cause was a coordinate-space mismatch, not anything dataset-specific:
// Potree sets sceneNode.position to each node's boundingBox.min
// (PointCloudOctree.js ~213), so the raw `position` attribute is relative to
// that node's own corner. The old code binned by raw `position` while anchoring
// the grid at pc.pcoGeometry.boundingBox, so points from different nodes landed
// in the same cells and the stored "ground" was physically meaningless. Both
// this scan and the shader now work in WORLD space.
//
// THE RULE: this never drops a point for being classified noise. Class 2 is used
// only to decide where the ground is. Sub-ground returns are the signal here.
// Cells with no ground data pass everything through unfiltered.

// Two grids, two jobs. Keeping them separate is the whole point:
//
//   DETAIL grid   — the terrain reference. Its cell size IS the resolution the
//                   filter measures against, so it is small (0.25-10 m) and set
//                   by the user, exactly like a DEM's cell size. It is fixed at
//                   2048^2 cells, so the area it covers is a CONSEQUENCE of the
//                   cell size, never the other way round.
//   FALLBACK grid — a deliberately coarse, wide-area net so that points far
//                   from the camera still have some ground reference instead of
//                   none. 1024^2 cells at 16x the detail cell, clamped to
//                   4-32 m. It is only ever read where the detail grid has no
//                   data, and it can be switched off.
//
// The earlier version had one grid and derived its cell size from the area it
// had to cover, which is backwards: at a county-wide extent that produced 172 m
// cells, where a single cell spans a hillside and its minimum Z (the valley
// floor) becomes the "ground" for everything above it.
//
// THE RULE: neither grid ever drops a point for being classified noise. Class 2
// decides where the ground is; everything else is only ever measured against
// it. A cell with no ground data filters nothing.

const _HAG_NONE = 1e30;
const _HAG_DETAIL_DIM   = 2048;   // 2048^2: ~50 MB of typed arrays, 16 MB on the GPU
const _HAG_FALLBACK_DIM = 1024;
const _HAG_SHIFT_MS = 1000;        // don't chase the camera faster than this
const _HAG_CELL_MIN = 0.25, _HAG_CELL_MAX = 10;
const _HAG_SPREAD_MAX = 128.0;     // metres the 8-bit spread byte spans
const _HAG_TIME_BUDGET = 14;       // ms of binning per pass
const _HAG_CATCHUP_MS  = 25;       // gap between passes while there is a backlog

function _hagMakeGrid(dim, label) {
  const n = dim * dim;
  return {
    label, dim,
    cell: 1, originX: 0, originY: 0,
    // The ground in a cell is a BAND, not a number. One height per cell is
    // what broke cliffs: a cell straddling a 30 m drop stored the base, so
    // anyone standing on the top read +30 m and was culled. Keeping the class-2
    // minimum and maximum lets the low cutoff measure from the bottom of the
    // local ground and the high cutoff from the top of it.
    ground:    new Float32Array(n).fill(_HAG_NONE),    // lowest class-2 return
    groundMax: new Float32Array(n).fill(-_HAG_NONE),   // highest class-2 return
    fallback:  new Float32Array(n).fill(_HAG_NONE),    // lowest of everything else, only where no class 2
    // RGBA8: RGB are the height as 24 bits, A is provenance —
    // 255 = an actual class-2 return, 128 = the lowest non-ground return in
    // that cell (a guess), 0 = nothing. The shader prefers 255 anywhere over
    // 128 anywhere, which is what stops a canopy-only cell in dense forest
    // from reporting its lowest leaf as the ground.
    upload:   new Uint8Array(n * 4),
    texture:  null,
    filled:   0,        // cells with any height at all
    groundCells: 0,     // subset of those backed by an actual class-2 return
    dirty:    false,
  };
}

const _hag = {
  detail:   null,
  fallbackGrid: null,
  cellSize: 0.5,        // metres — the DETAIL cell size. The user's DEM resolution.
  useFallback: true,
  debugColor: false,
  // The bushwhack highlight: a second band that recolours instead of
  // culling, so it runs with the filter on, off, or on its own.
  bushOn: false,
  bushLo: 1.0, bushHi: 3.0,     // metres, about 3 to 10 ft
  // How far a class-2 return reaches when it defines the local ground, in
  // cells. 0 keeps each cell to its own returns, which fixes clifftops but not
  // undercuts. 2 is the default because it is what holds up in the field: it
  // reaches far enough behind a lip to rescue points under an overhang, and on
  // flat ground the neighbours agree so the band stays closed and nothing
  // changes.
  envRadius: 2,
  zMin: 0, zSpan: 1, zInv: 0,   // shared 24-bit decode window, widened from the data
  obsLo: Infinity, obsHi: -Infinity,
  processed: new Map(),   // node key -> its world bbox, so a shift can re-queue selectively
  enabled: false,
  // A generous default: wide enough to leave real terrain, vegetation and
  // sub-ground features alone, tight enough to drop obvious garbage. Narrow it
  // deliberately rather than starting narrow.
  minHag: -20.0,
  maxHag: 20.0,
  _uploadTimer: null,
  _scan: null,
  _lastShift: 0,
  _catchup: null,
  _pointsSeen: 0,
};

/** Coarse cell size for the wide-area net, never fine, never absurd. */
function _hagFallbackCell(detailCell) {
  return Math.max(4, Math.min(32, detailCell * 16));
}

function _hagCoverage() {
  return {
    detail:   _HAG_DETAIL_DIM   * _hag.cellSize,
    fallback: _HAG_FALLBACK_DIM * _hagFallbackCell(_hag.cellSize),
  };
}

/**
 * Where the user is actually looking, in world XY.
 *
 * NOT the union of visibleNodes' bounding boxes. The octree root is always
 * visible and its bounding box is the whole EPT dataset — a county for a USGS
 * 3DEP tile. The deepest LOD levels currently streaming are, by construction,
 * the nodes near the camera; their centroid is the region of interest.
 */
function _hagViewCenter() {
  const pcs = (typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [];
  let deepest = -1;
  const entries = [];
  for (const pc of pcs) {
    if (!pc.visible) continue;
    for (const node of (pc.visibleNodes || [])) {
      if (!node.sceneNode) continue;
      const bb = node.boundingBox || node.geometryNode?.boundingBox;
      if (!bb) continue;
      let lvl = 0;
      if (typeof node.getLevel === 'function') lvl = node.getLevel();
      else if (typeof node.level === 'number') lvl = node.level;
      else if (typeof node.geometryNode?.level === 'number') lvl = node.geometryNode.level;
      entries.push({ bb, lvl, pc });
      if (lvl > deepest) deepest = lvl;
    }
  }
  if (deepest < 0) return null;

  const minLevel = Math.max(0, deepest - 1);
  let sx = 0, sy = 0, n = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of entries) {
    if (e.lvl < minLevel) continue;
    const b = e.bb.clone().applyMatrix4(e.pc.matrixWorld);
    sx += (b.min.x + b.max.x) * 0.5;
    sy += (b.min.y + b.max.y) * 0.5;
    if (b.min.x < x0) x0 = b.min.x;
    if (b.min.y < y0) y0 = b.min.y;
    if (b.max.x > x1) x1 = b.max.x;
    if (b.max.y > y1) y1 = b.max.y;
    n++;
  }
  if (!n) return null;

  // "The deepest nodes are the ones near the camera" holds while something is
  // refining locally. Zoom out past the LOD far cutoff and nothing refines
  // anywhere, so the deepest level is uniform across the whole dataset and its
  // centroid is just the dataset centre - which would anchor the grid miles
  // from what is on screen. When the deepest level is spread wider than the
  // grid could ever cover, trust the camera instead.
  const cov = _HAG_DETAIL_DIM * _hag.cellSize;
  if (Math.max(x1 - x0, y1 - y0) > cov * 2) {
    const cam = (typeof potreeViewer !== 'undefined') &&
                potreeViewer?.scene?.getActiveCamera?.();
    if (cam && Number.isFinite(cam.position?.x)) {
      return { x: cam.position.x, y: cam.position.y,
               level: deepest, nodes: n, fromCamera: true };
    }
  }
  return { x: sx / n, y: sy / n, level: deepest, nodes: n };
}

/**
 * Allocate once, for the life of the page. Dimensions never change — only the
 * cell size and the origin do — so the typed arrays and the GL textures can be
 * reused. That also avoids leaking a GL texture on every recenter: Potree's
 * renderer caches WebGLTextures in a Map that three.js's dispose() never
 * touches.
 */
function _hagAlloc() {
  if (_hag.detail) return;
  _hag.detail       = _hagMakeGrid(_HAG_DETAIL_DIM,   'detail');
  _hag.fallbackGrid = _hagMakeGrid(_HAG_FALLBACK_DIM, 'fallback');
  for (const g of [_hag.detail, _hag.fallbackGrid]) {
    // NOT a THREE.DataTexture. Potree's renderer uploads textures through a
    // helper that branches on "instanceof THREE.DataTexture" against the
    // three.js bundled inside potree.js, which is a different module instance
    // from the global three.js this file uses. Every branch missed, texImage2D
    // was never called, and the shader sampled an incomplete texture as
    // (0,0,0,1) -- opaque black, which decodes to the bottom of the height
    // window and reads as perfectly valid ground. The filter measured every
    // point against nothing for four rounds of debugging.
    //
    // A plain descriptor, uploaded by raw GL calls in PotreeRenderer, cannot
    // fail that way. RGBA8 also sidesteps paramThreeToGL, which has no branch
    // for single-channel float formats and throws on them.
    g.texture = { width: g.dim, height: g.dim, data: g.upload, version: 1 };
  }
}

/** World rectangle a grid currently covers. */
function _hagExtent(g) {
  const cov = g.dim * g.cell;
  return { minX: g.originX, minY: g.originY,
           maxX: g.originX + cov, maxY: g.originY + cov,
           cx: g.originX + cov / 2, cy: g.originY + cov / 2 };
}

/**
 * Translate a grid in place by whole cells, clearing only what scrolls in.
 *
 * Because every origin is snapped to the cell lattice, moving the window is a
 * pure array translation: the cells that stay in view keep their accumulated
 * minima and only the newly exposed margin starts empty. Rebuilding from
 * scratch instead meant re-binning every visible point after a few seconds of
 * panning — several seconds during which nothing was filtered and the whole
 * cloud reappeared.
 *
 * Data at cell (x, y) moves to (x - dx, y - dy).
 */
function _hagTranslate(arr, dim, stride, dx, dy, fill) {
  if (Math.abs(dx) >= dim || Math.abs(dy) >= dim) { arr.fill(fill); return; }
  const row = dim * stride;

  // Source rows and columns that survive the move.
  const sy0 = Math.max(0, dy), sy1 = Math.min(dim, dim + dy);
  const sx0 = Math.max(0, dx), sx1 = Math.min(dim, dim + dx);

  if (sy1 > sy0 && sx1 > sx0) {
    // Walk rows away from the destination so an overlapping copy never eats
    // its own source; copyWithin already has memmove semantics within a row.
    const n = sy1 - sy0;
    for (let i = 0; i < n; i++) {
      const sy = dy >= 0 ? sy0 + i : sy1 - 1 - i;
      const ny = sy - dy;
      arr.copyWithin(ny * row + (sx0 - dx) * stride,
                     sy * row + sx0 * stride,
                     sy * row + sx1 * stride);
    }
  }

  // Everything not written above is newly exposed and must start empty.
  const ky0 = Math.max(0, sy0 - dy), ky1 = Math.min(dim, sy1 - dy);
  const kx0 = Math.max(0, sx0 - dx), kx1 = Math.min(dim, sx1 - dx);
  for (let y = 0; y < dim; y++) {
    const base = y * row;
    if (y < ky0 || y >= ky1) { arr.fill(fill, base, base + row); continue; }
    if (kx0 > 0)   arr.fill(fill, base, base + kx0 * stride);
    if (kx1 < dim) arr.fill(fill, base + kx1 * stride, base + row);
  }
}

/** Recount coverage after a translation, from the provenance byte. */
function _hagRecount(g) {
  const u = g.upload;
  let filled = 0, ground = 0;
  for (let t = 3; t < u.length; t += 4) {
    const a = u[t];
    if (a !== 0) { filled++; if (a === 255) ground++; }
  }
  g.filled = filled; g.groundCells = ground;
}

/** Throw a grid away and re-anchor it. Only for the first build and a resolution change. */
function _hagAnchor(g, cell, cx, cy) {
  const cov = g.dim * cell;
  g.cell = cell;
  g.originX = Math.floor((cx - cov / 2) / cell) * cell;
  g.originY = Math.floor((cy - cov / 2) / cell) * cell;
  g.ground.fill(_HAG_NONE);
  g.groundMax.fill(-_HAG_NONE);
  g.fallback.fill(_HAG_NONE);
  g.upload.fill(0);
  g.texture.version++;
  g.filled = 0; g.groundCells = 0;
}

/** Move a grid to sit on (cx, cy), keeping everything still in range. */
function _hagShift(g, cx, cy) {
  const cov = g.dim * g.cell;
  const nx = Math.floor((cx - cov / 2) / g.cell) * g.cell;
  const ny = Math.floor((cy - cov / 2) / g.cell) * g.cell;
  const dx = Math.round((nx - g.originX) / g.cell);
  const dy = Math.round((ny - g.originY) / g.cell);
  if (dx === 0 && dy === 0) return false;
  _hagTranslate(g.ground,    g.dim, 1, dx, dy, _HAG_NONE);
  _hagTranslate(g.groundMax, g.dim, 1, dx, dy, -_HAG_NONE);
  _hagTranslate(g.fallback,  g.dim, 1, dx, dy, _HAG_NONE);
  _hagTranslate(g.upload,   g.dim, 4, dx, dy, 0);
  g.originX = nx; g.originY = ny;
  g.texture.version++;
  _hagRecount(g);
  return true;
}

/** Build both grids for the first time, or after a resolution change. */
function _hagReset(cx, cy) {
  _hagAlloc();
  _hagAnchor(_hag.detail,       _hag.cellSize,                    cx, cy);
  _hagAnchor(_hag.fallbackGrid, _hagFallbackCell(_hag.cellSize),  cx, cy);
  _hag.processed.clear();
  _hag._pointsSeen = 0;
  _hag.obsLo = Infinity; _hag.obsHi = -Infinity;   // the pack window itself survives
  _hag._lastShift = performance.now();
  const cov = _hagCoverage();
  console.log(`[hag] detail ${_hag.detail.cell} m x ${_HAG_DETAIL_DIM} = ` +
              `${(cov.detail/1000).toFixed(2)} km · fallback ${_hag.fallbackGrid.cell} m x ` +
              `${_HAG_FALLBACK_DIM} = ${(cov.fallback/1000).toFixed(1)} km`);
}

const _hagOverlaps = (b, e) =>
  b.maxX > e.minX && b.minX < e.maxX && b.maxY > e.minY && b.minY < e.maxY;

/**
 * The ground a grid covers now that it did not cover before: at most an L of
 * two rectangles. Only nodes touching this have anything new to contribute —
 * everything else travelled with the translation. Testing "not wholly inside
 * the old window" instead would needlessly re-bin every node hanging off the
 * opposite edge.
 */
function _hagExposed(before, after) {
  const ix0 = Math.max(before.minX, after.minX), ix1 = Math.min(before.maxX, after.maxX);
  const iy0 = Math.max(before.minY, after.minY), iy1 = Math.min(before.maxY, after.maxY);
  if (ix1 <= ix0 || iy1 <= iy0) return [after];          // no overlap at all
  const out = [];
  if (after.minX < ix0) out.push({ minX: after.minX, maxX: ix0, minY: after.minY, maxY: after.maxY });
  if (after.maxX > ix1) out.push({ minX: ix1, maxX: after.maxX, minY: after.minY, maxY: after.maxY });
  if (after.minY < iy0) out.push({ minX: ix0, maxX: ix1, minY: after.minY, maxY: iy0 });
  if (after.maxY > iy1) out.push({ minX: ix0, maxX: ix1, minY: iy1, maxY: after.maxY });
  return out;
}

function _hagSetCellSize(v) {
  v = Math.max(_HAG_CELL_MIN, Math.min(_HAG_CELL_MAX, +v || 1));
  if (v === _hag.cellSize) return;
  _hag.cellSize = v;
  if (!_hag.detail) return;         // nothing built yet; the first scan will use it
  // A resolution change cannot be translated, only rebuilt.
  const e = _hagExtent(_hag.detail);
  _hagReset(e.cx, e.cy);
  _hagPushUniforms();
}

/**
 * How far a class-2 return reaches when it defines the local ground.
 *
 * 0 keeps every cell to its own returns. That already fixes clifftops, because
 * a cell straddling the lip holds returns from both the top and the base, so
 * its band spans the drop. It does nothing for a cell wholly on the clifftop
 * next to a cell wholly at the base — the undercut case — because neither cell
 * has ever seen the other's ground. Radius 1 lets them borrow from each other.
 *
 * Changing it cannot be applied to what is already accumulated, so this rebuilds.
 */
function _hagSetEnvRadius(r) {
  r = Math.max(0, Math.min(3, r | 0));
  if (r === _hag.envRadius) return;
  _hag.envRadius = r;
  if (!_hag.detail) return;
  const e = _hagExtent(_hag.detail);
  _hagReset(e.cx, e.cy);
  _hagPushUniforms();
}

function _hagSetFallback(on) {
  _hag.useFallback = !!on;
  _hagPushUniforms();
}

/**
 * Paint every point by what the filter decided, instead of hiding anything.
 *
 * The filter lives in a vertex shader and a vertex shader cannot be read back,
 * so when it misbehaves there is nothing to inspect — the cloud is simply gone
 * and every uniform looks fine from JS. This turns the shader's own decision
 * into something visible:
 *
 *   white     the uniforms never reached the GPU (upload bug, not a grid bug)
 *   magenta   no ground reference in either grid; the point is passed through
 *   green     inside the band
 *   orange    below the band
 *   blue      above the band
 *   darker    the reference came from the coarse fallback grid
 */
function _hagSetDebugColor(on) {
  _hag.debugColor = !!on;
  _hagApplyDefine();
}

/**
 * The 24-bit packing window, widened from what has actually been binned.
 *
 * An earlier version took this from the octree bounding box so it would be a
 * constant. That is one indirection too many: the window then depends on what
 * Potree means by pcoGeometry.boundingBox for a given loader, and if it does
 * not contain the real heights every packed value clamps to an end of the
 * window and the decoded ground is metres to kilometres wrong — which culls the
 * entire cloud rather than failing quietly. Deriving it from the data cannot be
 * wrong by construction. The padding is generous so widening is rare; each
 * widen costs one full repack.
 */
function _hagWindowFrom(lo, hi) {
  const pad = Math.max(50, (hi - lo) * 0.25);
  _hag.zMin  = lo - pad;
  _hag.zSpan = Math.max(100, (hi - lo) + 2 * pad);
  _hag.zInv  = 65535 / _hag.zSpan;
}

/** Rewrite both grids' textures from the accumulators. Only on a range change. */
function _hagRepackAll() {
  if (!_hag.detail) return;
  const zMin = _hag.zMin, invLo = 65535 / _hag.zSpan, spreadQ = 255 / _HAG_SPREAD_MAX;
  for (const g of [_hag.detail, _hag.fallbackGrid]) {
    const lo = g.ground, hi = g.groundMax, fb = g.fallback, u = g.upload;
    let filled = 0, ground = 0;
    for (let i = 0; i < lo.length; i++) {
      const t = i * 4;
      let vLo, vHi, prov;
      if (lo[i] < _HAG_NONE)      { vLo = lo[i]; vHi = hi[i] > -_HAG_NONE ? hi[i] : lo[i]; prov = 255; }
      else if (fb[i] < _HAG_NONE) { vLo = fb[i]; vHi = fb[i]; prov = 128; }
      else { u[t] = u[t+1] = u[t+2] = u[t+3] = 0; continue; }
      let q = ((vLo - zMin) * invLo) | 0;
      if (q < 1) q = 1; else if (q > 65535) q = 65535;
      u[t] = (q >>> 8) & 255; u[t+1] = q & 255;
      let sp = vHi - vLo;
      if (sp < 0) sp = 0; else if (sp > _HAG_SPREAD_MAX) sp = _HAG_SPREAD_MAX;
      u[t+2] = (sp * spreadQ) | 0;
      u[t+3] = prov;
      filled++; if (prov === 255) ground++;
    }
    g.filled = filled; g.groundCells = ground;
    g.texture.version++;
  }
}

function _hagScan() {
  const pcs = (typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [];
  if (!pcs.length) return;

  // Nothing reads the grid unless the filter, the highlight or the diagnose
  // colours are on. It used to be maintained regardless, from page load, which
  // cost up to a third of the main thread while a cloud was streaming - and it
  // competed for exactly the frames the point cloud was trying to load in. The
  // trade is that switching a feature on now starts from an empty grid and
  // takes a few seconds of catch-up to fill.
  if (!_hag.enabled && !_hag.bushOn && !_hag.debugColor) return;

  const view = _hagViewCenter();
  if (!view) return;

  if (!_hag.detail) {
    _hagReset(view.x, view.y);
    _hagPushUniforms();
  } else if (performance.now() - _hag._lastShift > _HAG_SHIFT_MS) {
    // Each grid follows the view on its own schedule, against its own coverage.
    // The fallback grid is 8-32 km wide, so in practice it almost never moves
    // and keeps answering while the detail grid is refilling its margin.
    const before = [_hagExtent(_hag.detail), _hagExtent(_hag.fallbackGrid)];
    const movedIdx = [];
    [_hag.detail, _hag.fallbackGrid].forEach((g, i) => {
      const cov = g.dim * g.cell;
      const e = before[i];
      if (Math.max(Math.abs(view.x - e.cx), Math.abs(view.y - e.cy)) > cov * 0.25 &&
          _hagShift(g, view.x, view.y)) movedIdx.push(i);
    });
    if (movedIdx.length) {
      // A node only has to be re-binned if a grid moved over ground it never
      // covered before; everything already accumulated travelled with the
      // translation.
      const after = [_hagExtent(_hag.detail), _hagExtent(_hag.fallbackGrid)];
      const exposed = [];
      for (const i of movedIdx) exposed.push(..._hagExposed(before[i], after[i]));
      let requeued = 0;
      for (const [key, bb] of _hag.processed) {
        for (const rect of exposed) {
          if (_hagOverlaps(bb, rect)) { _hag.processed.delete(key); requeued++; break; }
        }
      }
      _hag._lastShift = performance.now();
      _hagPushUniforms();
      console.log(`[hag] shifted ${movedIdx.map(i => i ? 'fallback' : 'detail').join('+')}` +
                  `, ${requeued} of ${requeued + _hag.processed.size} nodes to re-bin`);
    }
  }

  const D = _hag.detail, F = _hag.fallbackGrid;
  const dDim = D.dim, dCell = D.cell, dox = D.originX, doy = D.originY;
  const fDim = F.dim, fCell = F.cell, fox = F.originX, foy = F.originY;
  const dG = D.ground, dMx = D.groundMax, dF = D.fallback;
  const fG = F.ground, fMx = F.groundMax, fF = F.fallback;
  const winLo = _hag.zMin, winHi = _hag.zMin + _hag.zSpan;
  const invLo = 65535 / _hag.zSpan, spreadQ = 255 / _HAG_SPREAD_MAX;
  const R = _hag.envRadius;

  // Pack one cell: RG = 16-bit low ground, B = how far the ground rises above
  // it inside the envelope, A = provenance. 16 bits over a few hundred metres
  // is ~1 cm, far finer than a threshold needs, and it buys the byte that
  // carries the band. Returns false when the value did not fit the current
  // packing window, which schedules a repack.
  function packCell(g, k) {
    const u = g.upload, t = k * 4;
    const lo = g.ground[k], hiRaw = g.groundMax[k];
    let vLo, vHi, prov;
    if (lo < _HAG_NONE)             { vLo = lo; vHi = hiRaw > -_HAG_NONE ? hiRaw : lo; prov = 255; }
    else if (g.fallback[k] < _HAG_NONE) { vLo = g.fallback[k]; vHi = vLo; prov = 128; }
    else {
      if (u[t+3] !== 0) { g.filled--; if (u[t+3] === 255) g.groundCells--; }
      u[t] = u[t+1] = u[t+2] = u[t+3] = 0; g.dirty = true; return true;
    }
    if (u[t+3] === 0) g.filled++;
    if (prov === 255 && u[t+3] !== 255) g.groundCells++;
    // Never emit 0 for the height. An incomplete WebGL texture samples as
    // (0,0,0,1) -- opaque black that would decode to a plausible ground height.
    // Reserving zero lets the shader tell "never uploaded" from "ground is low".
    let q = ((vLo - winLo) * invLo) | 0;
    if (q < 1) q = 1; else if (q > 65535) q = 65535;
    u[t] = (q >>> 8) & 255; u[t+1] = q & 255;
    let sp = vHi - vLo;
    if (sp < 0) sp = 0; else if (sp > _HAG_SPREAD_MAX) sp = _HAG_SPREAD_MAX;
    u[t+2] = (sp * spreadQ) | 0;
    u[t+3] = prov;
    g.dirty = true;
    return vLo >= winLo && vHi <= winHi;
  }
  let obsLo = _hag.obsLo, obsHi = _hag.obsHi;
  let needRepack = !_hag.zInv;            // no window yet: pack after this pass
  let updated = false;

  // Binning costs roughly 100 ns a point, so a whole visible set arriving at
  // once would be a half-second freeze. Spend a bounded slice of wall clock per
  // pass and come back sooner while there is a backlog: a node is atomic, so
  // the real ceiling is one node past the budget. This is also what makes the
  // grid fill in progressively as a cloud streams rather than all at the end.
  const tStart = performance.now();
  let backlog = false;

  outer:
  for (const pc of pcs) {
    if (!pc.visible) continue;
    for (const node of (pc.visibleNodes || [])) {
      if (performance.now() - tStart > _HAG_TIME_BUDGET) { backlog = true; break outer; }
      if (!node.sceneNode) continue;
      const key = (pc.name || '') + '/' + (node.name || node.id || '?');
      if (_hag.processed.has(key)) continue;

      const geom = node.geometryNode?.geometry || node.geometry;
      const pos = geom?.attributes?.position?.array;
      if (!pos || pos.length < 3) continue;
      const nbb = (node.boundingBox || node.geometryNode?.boundingBox)
        ?.clone().applyMatrix4(pc.matrixWorld);
      _hag.processed.set(key, nbb
        ? { minX: nbb.min.x, minY: nbb.min.y, maxX: nbb.max.x, maxY: nbb.max.y }
        : { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity });
      const cls = geom.attributes?.classification?.array;

      // Node-local -> world. Inlined from matrixWorld.elements: nine multiplies
      // per point and no allocation, which matters at a few million points.
      const e = node.sceneNode.matrixWorld.elements;
      const e0=e[0],e4=e[4],e8=e[8],e12=e[12];
      const e1=e[1],e5=e[5],e9=e[9],e13=e[13];
      const e2=e[2],e6=e[6],e10=e[10],e14=e[14];

      const nPts = pos.length / 3;
      for (let i = 0, o = 0; i < nPts; i++, o += 3) {
        const x = pos[o], y = pos[o+1], z = pos[o+2];
        const wx = e0*x + e4*y + e8*z  + e12;
        const wy = e1*x + e5*y + e9*z  + e13;

        const dx = ((wx - dox) / dCell) | 0;
        const dy = ((wy - doy) / dCell) | 0;
        const fx = ((wx - fox) / fCell) | 0;
        const fy = ((wy - foy) / fCell) | 0;
        const inD = dx >= 0 && dx < dDim && dy >= 0 && dy < dDim;
        const inF = fx >= 0 && fx < fDim && fy >= 0 && fy < fDim;
        if (!inD && !inF) continue;

        const wz = e2*x + e6*y + e10*z + e14;
        _hag._pointsSeen++;

        // Class 2 is authoritative. Everything else only ever writes the
        // per-cell fallback, so a pit's own sub-ground returns can never become
        // the ground reference and hide the pit from the filter.
        const isGround = !!cls && Math.round(cls[i]) === 2;

        // Class 2 widens the ground band of every cell inside the envelope
        // radius. Both ends are monotone -- the low only falls, the high only
        // rises -- so this needs no rescan and never has to shrink.
        if (inD) {
          if (isGround) {
            for (let oy = -R; oy <= R; oy++) {
              const ny = dy + oy; if (ny < 0 || ny >= dDim) continue;
              const rowBase = ny * dDim;
              for (let ox = -R; ox <= R; ox++) {
                const nx = dx + ox; if (nx < 0 || nx >= dDim) continue;
                const kk = rowBase + nx;
                let ch = false;
                if (wz < dG[kk])  { dG[kk]  = wz; ch = true; }
                if (wz > dMx[kk]) { dMx[kk] = wz; ch = true; }
                if (ch) { if (!packCell(D, kk)) needRepack = true; updated = true; }
              }
            }
            if (wz < obsLo) obsLo = wz;
            if (wz > obsHi) obsHi = wz;
          } else {
            const k = dy * dDim + dx;
            if (wz < dF[k]) {
              dF[k] = wz;
              if (dG[k] >= _HAG_NONE) {      // ground, once known, always wins
                if (!packCell(D, k)) needRepack = true;
                updated = true;
                if (wz < obsLo) obsLo = wz;
                if (wz > obsHi) obsHi = wz;
              }
            }
          }
        }

        if (inF) {
          const k = fy * fDim + fx;
          if (isGround) {
            let ch = false;
            if (wz < fG[k])  { fG[k]  = wz; ch = true; }
            if (wz > fMx[k]) { fMx[k] = wz; ch = true; }
            if (ch) {
              if (!packCell(F, k)) needRepack = true;
              updated = true;
              if (wz < obsLo) obsLo = wz;
              if (wz > obsHi) obsHi = wz;
            }
          } else if (wz < fF[k]) {
            fF[k] = wz;
            if (fG[k] >= _HAG_NONE) {
              if (!packCell(F, k)) needRepack = true;
              updated = true;
              if (wz < obsLo) obsLo = wz;
              if (wz > obsHi) obsHi = wz;
            }
          }
        }
      }
    }
  }

  // Still work queued: come back in 25 ms rather than waiting out the idle
  // interval, so catching up takes a second rather than several.
  if (backlog && !_hag._catchup) {
    _hag._catchup = setTimeout(() => {
      _hag._catchup = null;
      try { _hagScan(); } catch (err) { console.warn('[hag]', err); }
    }, _HAG_CATCHUP_MS);
  }

  _hag.obsLo = obsLo; _hag.obsHi = obsHi;
  if (needRepack && obsLo <= obsHi) {
    _hagWindowFrom(obsLo, obsHi);
    _hagRepackAll();
    _hagPushUniforms();                   // the decode uniform must move with it
    console.log(`[hag] pack window ${_hag.zMin.toFixed(1)} .. ` +
                `${(_hag.zMin + _hag.zSpan).toFixed(1)} m (observed ` +
                `${obsLo.toFixed(1)} .. ${obsHi.toFixed(1)})`);
  }

  // Uploading a 16 MB texture is the expensive part now, so coalesce: one
  // upload per idle window no matter how many nodes landed.
  if (updated && !_hag._uploadTimer) {
    _hag._uploadTimer = setTimeout(() => {
      _hag._uploadTimer = null;
      // Re-uploading a 16 MB texture that did not change is pure bus traffic;
      // the coarse grid in particular settles after the first few nodes.
      for (const g of [_hag.detail, _hag.fallbackGrid]) {
        if (g.dirty) { g.texture.version++; g.dirty = false; }
      }
      _hagPushUniforms();
      _hagUpdateStats();
    }, 250);
  }
}

function _hagPct(v, total) {
  const p = v / total * 100;
  return (p > 0 && p < 1) ? p.toFixed(2) : p.toFixed(0);
}
function _hagCover(g) {
  const n = g.dim * g.dim;
  return `${_hagPct(g.groundCells, n)}% ground, ${_hagPct(g.filled - g.groundCells, n)}% est`;
}

/**
 * The bundle and flex.js are separate downloads and the browser caches the
 * 2.4 MB bundle hard, so it is entirely possible to be running new JS against
 * an old shader — which looks exactly like a logic bug and has wasted a lot of
 * time. uHagDebug is the newest uniform; if a loaded cloud's material has no
 * idea what that is, the bundle on the page predates the shader this JS talks
 * to. Say so instead of letting it look like a filter problem.
 */
function _hagBundleStale() {
  for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [])) {
    const u = pc.material?.uniforms;
    if (u && u.uGroundTex && !u.uHagDebug) return true;
  }
  return false;
}

function _hagUpdateStats() {
  const el = document.getElementById('lp-hag-stats');
  if (!el) return;
  if (_hagBundleStale()) {
    el.innerHTML = '<span style="color:#ff6b6b;">Potree bundle is out of date &mdash; ' +
                   'hard-reload with Ctrl+Shift+R. The filter will not work until you do.</span>';
    return;
  }
  if (!_hag.detail) return;
  const cov = _hagCoverage();
  const D = _hag.detail, F = _hag.fallbackGrid;
  let txt = `detail ${D.cell} m · ${(cov.detail/1000).toFixed(2)} km · ${_hagCover(D)}`;
  txt += _hag.useFallback
    ? ` | fallback ${F.cell} m · ${(cov.fallback/1000).toFixed(1)} km · ${_hagCover(F)}`
    : ' | fallback off';
  txt += ` | ${_hag._pointsSeen.toLocaleString()} pts binned`;
  el.textContent = txt;

  const win = document.getElementById('lp-hag-window');
  if (win) win.textContent =
    `${_HAG_DETAIL_DIM}×${_HAG_DETAIL_DIM} cells = ${(cov.detail/1000).toFixed(2)} km across`;
  const fb = document.getElementById('lp-hag-fallback-note');
  if (fb) fb.textContent =
    `${_hagFallbackCell(_hag.cellSize)} m cells over ${(cov.fallback/1000).toFixed(1)} km`;
}

function _hagPushUniforms() {
  if (!_hag.detail) return;
  const D = _hag.detail, F = _hag.fallbackGrid;
  for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [])) {
    const u = pc.material?.uniforms;
    if (!u || !u.uGroundTex) continue;
    u.uGroundTex.value       = D.texture;
    u.uGroundOrigin.value    = [D.originX, D.originY];
    u.uGroundCellSize.value  = D.cell;
    u.uGroundTexSize.value   = [D.dim, D.dim];
    u.uGroundZRange.value    = [_hag.zMin, _hag.zSpan];
    u.uHagRange.value        = [_hag.minHag, _hag.maxHag];
    // Fallback grid. Its XY is reached from the detail grid's by a small shift
    // rather than a second model matrix: both origins are known here in float64
    // and their difference is at most half the fallback coverage, so it casts to
    // float32 losslessly enough (sub-millimetre at 16 km).
    // The texture stays bound either way; a null sampler would read whatever is
    // on texture unit 0. The flag is what turns the second lookup off.
    u.uGroundTexC.value        = F.texture;
    u.uGroundFallbackOn.value  = _hag.useFallback ? 1.0 : 0.0;
    u.uGroundCellSizeC.value = F.cell;
    u.uGroundTexSizeC.value  = [F.dim, F.dim];
    u.uGroundShiftC.value    = [D.originX - F.originX, D.originY - F.originY];
    if (u.uHagDebug) u.uHagDebug.value = _hag.debugColor ? 1.0 : 0.0;
    if (u.uGroundSpreadMax) u.uGroundSpreadMax.value = _HAG_SPREAD_MAX;
    if (u.uHagCull)   u.uHagCull.value   = _hag.enabled ? 1.0 : 0.0;
    if (u.uBushOn)    u.uBushOn.value    = _hag.bushOn  ? 1.0 : 0.0;
    if (u.uBushRange) u.uBushRange.value = [_hag.bushLo, _hag.bushHi];
    // Point clouds can finish loading long after the checkbox was ticked, and
    // the grid may not have existed when it was. Re-assert the define here so
    // enabling the filter never depends on the order those two happen in.
    if ((_hag.enabled || _hag.bushOn || _hag.debugColor) && pc.material.defines &&
        !pc.material.defines.get('clip_hag_enabled')) {
      pc.material.setDefine('clip_hag_enabled', '#define clip_hag_enabled');
    }
  }
}

/**
 * Compile the ground-grid machinery in or out.
 *
 * The define no longer means "filter". Three separate things need it — the
 * keep-band, the bushwhack highlight and the diagnose colours — and any of
 * them can run without the others, so whether points are actually culled is
 * uHagCull, not the define. Recompiling costs a shader link, so this only
 * touches a material whose state is wrong.
 */
function _hagApplyDefine() {
  const want = !!_hag.detail && (_hag.enabled || _hag.bushOn || _hag.debugColor);
  for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [])) {
    if (!pc.material) continue;
    const has = !!pc.material.defines?.get('clip_hag_enabled');
    if (want && !has) {
      // Only switch it on once a texture exists: an unbound sampler reads
      // whatever is on texture unit 0, which would behave unpredictably.
      pc.material.setDefine('clip_hag_enabled', '#define clip_hag_enabled');
    } else if (!want && has) {
      pc.material.removeDefine('clip_hag_enabled');
      pc.material.updateShaderSource();
    }
  }
  if (want) _hagPushUniforms();
}

function _hagEnable(on) {
  _hag.enabled = !!on;
  _hagApplyDefine();
}

/** Paint points sitting 0.3-1.5 m over the ground. A display mode, not a filter. */
function _hagSetBush(on) {
  _hag.bushOn = !!on;
  _hagApplyDefine();
}

function _hagSetBushRange(lo, hi) {
  _hag.bushLo = lo; _hag.bushHi = hi;
  _hagPushUniforms();
}

function _hagSetRange(min, max) {
  _hag.minHag = min; _hag.maxHag = max;
  if (_hag.enabled) _hagPushUniforms();
}

/**
 * One-call diagnosis from the console. The GPU side cannot be read back, so
 * this prints the JS state and recomputes HAG for real points exactly the way
 * the shader does. If these numbers look right and the view still does not
 * change, the problem is the define or the uniform upload, not the grids.
 */
function _hagDebug() {
  const pcs = (typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [];
  const cov = _hagCoverage();
  const D = _hag.detail, F = _hag.fallbackGrid;
  const out = {
    enabled: _hag.enabled,
    detailCell: D?.cell, detailCoverageM: cov.detail, detailCover: D ? _hagCover(D) : null,
    cullOn: _hag.enabled,
    bushOn: _hag.bushOn,
    bushRange: [_hag.bushLo, _hag.bushHi],
    fallbackOn: _hag.useFallback,
    envRadius: _hag.envRadius,
    fallbackCell: F?.cell, fallbackCoverageM: cov.fallback, fallbackCover: F ? _hagCover(F) : null,
    detailExtent: D ? _hagExtent(D) : null,
    packWindow: [_hag.zMin, _hag.zMin + _hag.zSpan],
    observedZ: [_hag.obsLo, _hag.obsHi],
    windowContainsData: _hag.obsLo >= _hag.zMin && _hag.obsHi <= _hag.zMin + _hag.zSpan,
    range: [_hag.minHag, _hag.maxHag],
    pointsBinned: _hag._pointsSeen,
    defineOn: pcs.map(pc => !!pc.material?.defines?.get('clip_hag_enabled')),
    uniformsPresent: pcs.map(pc => !!pc.material?.uniforms?.uGroundTex),
    texBound: pcs.map(pc => pc.material?.uniforms?.uGroundTex?.value === D?.texture),
  };
  console.log(out);
  if (!D) return out;

  // Same preference order as the shader: a real class-2 return anywhere beats
  // an estimate anywhere, and only then is the finer grid preferred.
  const read = (g, wx, wy) => {
    const cx = ((wx - g.originX) / g.cell) | 0, cy = ((wy - g.originY) / g.cell) | 0;
    if (cx < 0 || cx >= g.dim || cy < 0 || cy >= g.dim) return null;
    const t = (cy * g.dim + cx) * 4;
    const a = g.upload[t+3];
    if (a === 0) return null;
    const q = (g.upload[t] << 8) | g.upload[t+1];
    const lo = _hag.zMin + (q / 65535) * _hag.zSpan;
    return { z: lo, hi: lo + (g.upload[t+2] / 255) * _HAG_SPREAD_MAX, ground: a > 191 };
  };
  const lookup = (wx, wy) => {
    const d = read(D, wx, wy);
    const c = _hag.useFallback ? read(F, wx, wy) : null;
    if (d && d.ground) return { ...d, src: 'detail/ground' };
    if (c && c.ground) return { ...c, src: 'fallback/ground' };
    if (d)             return { ...d, src: 'detail/est' };
    if (c)             return { ...c, src: 'fallback/est' };
    return null;
  };

  const samples = [];
  outer:
  for (const pc of pcs) {
    for (const node of (pc.visibleNodes || [])) {
      const geom = node.geometryNode?.geometry || node.geometry;
      const pos = geom?.attributes?.position?.array;
      if (!pos) continue;
      const cls = geom.attributes?.classification?.array;
      const e = node.sceneNode.matrixWorld.elements;
      const n = pos.length / 3;
      for (let i = 0; i < n && samples.length < 12; i += Math.max(1, (n / 40) | 0)) {
        const o = i * 3, x = pos[o], y = pos[o+1], z = pos[o+2];
        const wx = e[0]*x + e[4]*y + e[8]*z  + e[12];
        const wy = e[1]*x + e[5]*y + e[9]*z  + e[13];
        const wz = e[2]*x + e[6]*y + e[10]*z + e[14];
        const hit = lookup(wx, wy);
        samples.push({
          cls: cls ? Math.round(cls[i]) : '?',
          z: +wz.toFixed(2),
          source: hit ? hit.src : 'none',
          groundLo: hit ? +hit.z.toFixed(2) : null,
          band: hit ? +(hit.hi - hit.z).toFixed(2) : null,
          hag: hit ? +(wz - hit.z).toFixed(2) : null,
          kept: !hit || (wz - hit.z >= _hag.minHag && wz - hit.hi <= _hag.maxHag),
        });
        if (samples.length >= 12) break outer;
      }
    }
  }
  console.log('sample points, as the shader sees them:');
  (console.table || console.log)(samples);
  return out;
}

// Self-initialising: no hook into addPC, so nothing in the existing load path
// changes. The first tick that sees visible nodes builds the grids.
if (typeof window !== 'undefined') {
  window._hag = _hag;
  window._hagEnable = _hagEnable;
  window._hagSetRange = _hagSetRange;
  window._hagSetCellSize = _hagSetCellSize;
  window._hagSetFallback = _hagSetFallback;
  window._hagSetEnvRadius = _hagSetEnvRadius;
  window._hagSetBush = _hagSetBush;
  window._hagSetBushRange = _hagSetBushRange;
  window._hagSetDebugColor = _hagSetDebugColor;
  window._hagDebug = _hagDebug;
  window._hagScan = _hagScan;
  if (!_hag._scan) _hag._scan = setInterval(() => { try { _hagScan(); } catch (err) { console.warn('[hag]', err); } }, 250);
}
