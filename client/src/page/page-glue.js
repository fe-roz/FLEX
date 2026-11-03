// Page glue moved out of index.html <head> (classic script, runs at parse time as before):
// copyCoords, addEPT, addKMZ and the rail/nav-panel toggle wiring.
    function copyCoords() {
        // function for copying the displayed camera coordinates to clipboard
        var copyText = document.getElementById("coord_display").innerText;
        navigator.clipboard.writeText(copyText);
        }
    
        function addEPT(){
          var link = prompt("EPT link", "http://localhost:8083/example/ept.json");
          if (!link || !link.trim()) return;
          link = link.trim();
          // Do NOT proxy the URL — Potree resolves sub-files (ept-hierarchy/, ept-data/, …)
          // relative to the base URL; wrapping in /proxy?url= corrupts that resolution.
          var statusEl = document.getElementById('lp-pc-status');
          if (statusEl) {
            statusEl.textContent = '⏳ Loading…';
            statusEl.style.color = '#aaa';
          }
          try {
            window.addPC(link);
          } catch (error) {
            console.error('Error adding EPT: ' + error);
            if (statusEl) {
              statusEl.textContent = '✗ ' + (error.message || error);
              statusEl.style.color = '#f77';
            }
          }
        }
    
        function addKMZ(){ 
        var input = document.createElement('input');
        input.type = 'file';
    
        input.onchange = e => { 
            var file = e.target.files[0]; 
            cesiumViewer.dataSources.add(Cesium.KmlDataSource.load(file));
        }
    
        input.click();
        // var link = prompt("KMZ File link", "example/link/file.kmz");
        // var fullLink = "ProxyUrlGenerator.generateProxyUrl(link);
        //   try {
        //    window.addPC(fullLink);
        //  } catch (error) {
        //    console.error(
        //      `There was an error while adding ${fullLink}. ${error}`
        //    );
        //  }
        }

        document.addEventListener('DOMContentLoaded', function() {
          // All collapsible nav panels — clicking a button toggles its panel
          // and closes all others (accordion behaviour).
          const navPanelIds = [
            '#mapLayersCollapsible',
            '#featuresCollapsible',
            '#caveCollapsible',
            '#lidarCollapsible',
            '#terrainCollapsible',
            '#settingsCollapsible',
            '#exportCollapsible',
            '#projectCollapsible',
            '#docsCollapsible',
            '#leadsCollapsible',
            '#reviewCollapsible',
            '#lidarDeriveCollapsible',
          ];

          document.querySelectorAll('#flex-rail [data-target], #pj-top-btn').forEach(button => {
            const targetId = button.getAttribute('data-target');
            const target   = document.querySelector(targetId);
            if (!target) return;

            button.addEventListener('click', () => {
              const isOpen = target.classList.contains('show');
              // Close all nav panels
              navPanelIds.forEach(id => {
                const el = document.querySelector(id);
                if (el) el.classList.remove('show');
              });
              // Toggle the clicked one open (unless it was already open)
              if (!isOpen) target.classList.add('show');
            });
          });
        });
