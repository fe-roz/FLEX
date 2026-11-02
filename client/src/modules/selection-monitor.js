// The floating "Add Point Cloud" button and the 100 ms watcher of the selected
// entity (workflow selection / deselection). Moved out of flex.js unchanged
// (flex.js split, wave 2; see client/src/README.md).
//
// Setup: setupSelectionMonitor({ cesiumViewer, workflowState, ic, onWorkflowEntitySelected, hideProcessAreaLayer,
//   stopWorkflowPolling, updateWorkflowSelectionLabels, updateWorkflowPanelVisibility, updateStatusCards,
//   updateWorkflowButtons, refreshServerMonitor })

export function setupSelectionMonitor({ cesiumViewer, workflowState, ic: _ic, onWorkflowEntitySelected, hideProcessAreaLayer,
    stopWorkflowPolling, updateWorkflowSelectionLabels, updateWorkflowPanelVisibility, updateStatusCards,
    updateWorkflowButtons, refreshServerMonitor }) {
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
      ">${_ic('cloud')}Add Point Cloud</button>
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
      // "Add Point Cloud" only for things that link to one (LiDAR dataset
      // outlines); it shows in the details panel (inspector.js).
      const pcUrl = currentEntity && currentEntity.properties && currentEntity.properties._url && currentEntity.properties._url._value;
      if (currentEntity && pcUrl) showFloatingButton(); else hideFloatingButton();
      if (currentEntity && !lastSelectedEntity) {
        // Entity was selected
        console.log('Entity selected:', currentEntity.id);
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
}
