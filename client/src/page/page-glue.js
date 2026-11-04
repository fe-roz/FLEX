// Page glue moved out of index.html <head> (classic script, runs at parse time as before):
// copyCoords, addEPT and the rail/nav-panel toggle wiring.
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
    
        document.addEventListener('DOMContentLoaded', function() {
          // All collapsible nav panels — clicking a button toggles its panel
          // and closes all others (accordion behaviour).
          const navPanelIds = [
            '#mapLayersCollapsible',
            '#featuresCollapsible',
            '#caveCollapsible',
            '#lidarCollapsible',
            '#terrainCollapsible',
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
