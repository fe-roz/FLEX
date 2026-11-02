// AOI drawing, the LAN-server connection, the processing queue and the workflow panel (Areas Of Interest,
// process areas, download / integrity / EPT actions, queue manager). Moved out of flex.js (flex.js split, wave 4).
// The workflow state object, the backend api and the log / status helpers live in api.js and come in as arguments.

export function isAoiGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return false;
  }
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatDownloadStatus(status) {
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

export function formatIntegrityStatus(status) {
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

export function formatEptStatus(status) {
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

export function setupWorkflowPanel({
  Cesium, cesiumViewer, workflowState, backendApi, setText, appendWorkflowLog, setWorkflowActionStatus,
  setWorkflowBusy, registerUpdateWorkflowButtons, loadBackendCatalog,
}) {
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
  return {
    initWorkflowPanel, updateWorkflowButtons, stopAoiDrawMode, stopWorkflowPolling, refreshServerMonitor,
    onWorkflowEntitySelected, hideProcessAreaLayer, updateWorkflowSelectionLabels, updateWorkflowPanelVisibility,
    updateStatusCards,
  };
}
