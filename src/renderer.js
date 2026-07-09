  let currentZoom = 100;
  let inspectorActive = false;
  let sectionMode = null;
  let commentMode = false;
  let netProbeMode = false; // "which endpoint fills this?" selection mode
  let webviewReady = false;
  let currentFilePath = null;
  let toolbarVertical = false;
  // True once the panel-dock state (panelColW/panelOrder/…) is initialized. Guards
  // early callers (e.g. the default setToolbarPosition at load) from invoking
  // adjustPanelsMargin before those `let`s exist → would throw a TDZ error and
  // break the whole renderer (empty state, no session restore).
  let dockReady = false;
  // Flow (layout) mode — declared early so activateTab can read it safely.
  // Markdown engine (render + WYSIWYG serialize) is a shared pure module.
  const { escapeHtml, escMd, inlineMd, cellWithSwatch, highlightCode, renderMarkdown, htmlToMd } = window.OhanaMD;
  let flowMode = false;

  // Show toolbar/zoom/info after content loads
  function showUI() {
    toolbar.style.display = "flex";
    document.getElementById("hdr-controls").style.display = "flex";
    document.getElementById("hdr-tools").classList.add("show");
  }
  // Single source of truth for the high-level view. Derives what's shown from the
  // state (tabs + activeKey + flowMode) and enforces the invariants — so states like
  // "Moka open with no tab" are impossible no matter which transition ran.
  function syncView() {
    const hasTab = !!activeTab();
    if (!hasTab) flowMode = false;            // INVARIANT: no tab ⇒ never in Moka
    const moka = flowMode && hasTab;          // INVARIANT: Moka requires a tab
    const fc = document.getElementById("flow-canvas");
    if (fc) fc.classList.toggle("visible", moka);
    document.body.classList.toggle("flow-active", moka);
    // No mode switch: the toolbar context follows the open artifact (board →
    // Moka tools · html/repo → preview tools · .md editing → markdown tools).
    document.getElementById("empty-state").classList.toggle("hidden", hasTab); // empty ⇔ no tab
    if (typeof updateNavVisibility === "function") updateNavVisibility();
  }

  const canvas = document.getElementById("canvas");
  const emptyState = document.getElementById("empty-state");
  const sectionHintEl = document.getElementById("section-hint");
  const zoomDisplay = document.getElementById("zoom-display");
  const titleText = document.getElementById("title-text");
  const liveDot = document.getElementById("live-dot");
  const infoDot = document.getElementById("info-dot");
  const infoStatus = document.getElementById("info-status");
  const toolbar = document.getElementById("toolbar");

  let webview = null;

  // ─── Breakpoints ───
  const BREAKPOINTS = [
    { name: "Responsive", width: 0, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
    { name: "Mobile S", width: 320, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01" stroke-width="2"/></svg>' },
    { name: "Mobile M", width: 375, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01" stroke-width="2"/></svg>' },
    { name: "Mobile L", width: 425, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01" stroke-width="2"/></svg>' },
    { name: "Tablet", width: 768, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01" stroke-width="2"/></svg>' },
    { name: "Laptop", width: 1024, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/></svg>' },
    { name: "Laptop L", width: 1440, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
  ];
  let currentBP = BREAKPOINTS[0];

  // Build breakpoint menu
  const bpMenu = document.getElementById("bp-menu");
  BREAKPOINTS.forEach((bp, i) => {
    const item = document.createElement("div");
    item.className = "bp-item" + (i === 0 ? " active" : "");
    item.dataset.index = i;
    item.innerHTML = `
      <div class="bp-item-left">
        <span class="bp-item-icon">${bp.icon}</span>
        <span class="bp-item-name">${bp.name}</span>
      </div>
      <span class="bp-item-size">${bp.width ? bp.width + "px" : "Auto"}</span>
    `;
    item.onclick = () => setBreakpoint(i);
    bpMenu.appendChild(item);
  });

  function setBreakpoint(index) {
    currentBP = BREAKPOINTS[index];
    // Update menu active state
    bpMenu.querySelectorAll(".bp-item").forEach((el, i) => {
      el.classList.toggle("active", i === index);
    });
    // Update selector label
    document.getElementById("bp-name").textContent = currentBP.name;
    document.getElementById("bp-size-label").textContent = currentBP.width ? currentBP.width + "px" : "";
    // Apply to webview
    applyBreakpoint();
    // Re-lay out the panel dock for the new breakpoint (so resize/reorder
    // handles stay correct whether or not the webview is constrained).
    if (dockReady) adjustPanelsMargin();
    // Close menu
    bpMenu.classList.remove("visible");
  }

  function applyBreakpoint() {
    if (!webview) return;
    if (currentBP.width === 0) {
      // Responsive — full width
      webview.classList.remove("bp-constrained");
      webview.style.maxWidth = "";
      webview.style.width = "";
      webview.style.left = "8px";
      webview.style.right = "8px";
      webview.style.transform = "";
      // Sync overlay
      inspectOverlay.style.maxWidth = "";
      inspectOverlay.style.width = "";
      inspectOverlay.style.left = "8px";
      inspectOverlay.style.right = "8px";
      inspectOverlay.style.transform = "";
      inspectOverlay.classList.remove("bp-constrained");
    } else {
      // Constrained width
      webview.classList.add("bp-constrained");
      webview.style.maxWidth = currentBP.width + "px";
      webview.style.width = currentBP.width + "px";
      webview.style.left = "50%";
      webview.style.right = "auto";
      webview.style.transform = "translateX(-50%)";
      // Sync overlay to match webview position
      inspectOverlay.classList.add("bp-constrained");
      inspectOverlay.style.maxWidth = currentBP.width + "px";
      inspectOverlay.style.width = currentBP.width + "px";
      inspectOverlay.style.left = "50%";
      inspectOverlay.style.right = "auto";
      inspectOverlay.style.transform = "translateX(-50%)";
    }
  }

  // Toggle breakpoint menu
  document.getElementById("bp-selector").onclick = (e) => {
    e.stopPropagation();
    bpMenu.classList.toggle("visible");
  };
  // Close menu on click outside
  document.addEventListener("click", () => bpMenu.classList.remove("visible"));

  // ─── Inspector injection script ───
  // ARCHITECTURE V3: The injected script is VISUAL-ONLY (mousemove highlight).
  // It NEVER blocks clicks. Click interception is handled by a transparent
  // overlay div in the RENDERER that sits on top of the webview.
  // This eliminates all async race conditions — showing/hiding the overlay
  // is a synchronous renderer-side operation.
  const INSPECTOR_SCRIPT = `
    (function() {
      if (window.__hdv_injected) return;
      window.__hdv_injected = true;
      let highlightEl = null;

      function isActive() {
        return document.documentElement.getAttribute('data-hdv-inspect') === '1';
      }

      function createHL() {
        const el = document.createElement('div');
        el.id = '__hdv_hl';
        el.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;border:2px solid #3b82f6;background:rgba(59,130,246,0.06);border-radius:3px;transition:all 0.06s ease;display:none;';
        const label = document.createElement('div');
        label.id = '__hdv_label';
        label.style.cssText = 'position:absolute;top:-22px;left:2px;font:500 10px -apple-system,sans-serif;color:#3b82f6;background:rgba(15,23,42,0.92);padding:2px 7px;border-radius:4px;white-space:nowrap;';
        el.appendChild(label);
        document.body.appendChild(el);
        return el;
      }

      document.addEventListener('mousemove', (e) => {
        if (!isActive()) {
          if (highlightEl) highlightEl.style.display = 'none';
          return;
        }
        if (!highlightEl) highlightEl = createHL();
        const t = e.target;
        if (t.id === '__hdv_hl' || t.id === '__hdv_label') return;
        const r = t.getBoundingClientRect();
        highlightEl.style.display = 'block';
        highlightEl.style.left = r.left + 'px';
        highlightEl.style.top = r.top + 'px';
        highlightEl.style.width = r.width + 'px';
        highlightEl.style.height = r.height + 'px';
        const tag = t.tagName.toLowerCase();
        const cls = t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '';
        const idStr = t.id && t.id !== '__hdv_hl' && t.id !== '__hdv_label' ? '#' + t.id : '';
        highlightEl.querySelector('#__hdv_label').textContent = tag + idStr + cls + '  ' + Math.round(r.width) + '\\u00d7' + Math.round(r.height);
      });
      // NOTE: No click handler here. Clicks are intercepted by the
      // renderer overlay (#inspect-overlay), not inside the webview.
    })()
  `;

  const inspectOverlay = document.getElementById("inspect-overlay");

  // ─── Webview ───
  // Each tab owns its OWN <webview> (stored on t.wv, readiness on t.wvReady),
  // kept alive while the tab is open. The module globals `webview` /
  // `webviewReady` are just pointers to the ACTIVE tab's values, so the rest of
  // the code keeps using `webview` unchanged. Switching tabs only shows/hides —
  // it never recreates — so you never lose your place (scroll, form, SPA route).
  function newWebviewEl() {
    const wv = document.createElement("webview");
    wv.setAttribute("partition", "persist:viewer");
    // Hardened: isolated + sandboxed content, no node, no popups (main routes
    // window.open targets to a URL tab), no insecure-content allowance. Pins
    // and inspector still work — they inject via executeJavaScript (page world).
    wv.setAttribute("webpreferences", "contextIsolation=yes,sandbox=yes,nodeIntegration=no");
    return wv;
  }

  // Show the given tab's webview (creating it the first time), hide the rest.
  // Never reloads an already-built webview → no lost state on tab switch.
  function mountWebview(t) {
    emptyState.classList.add("hidden");
    if (typeof hidePreviewError === "function") hidePreviewError(); // clear a prior tab's error state
    const np = document.getElementById("new-proto"); if (np) np.classList.remove("visible");
    showUI();
    if (!t.wv) {
      t.wvReady = false;
      t.wv = (t.kind === "file" || t.previewPath) ? buildFileWebview(t) : buildURLWebview(t);
      canvas.appendChild(t.wv);
    } else if (t.wvFailed) {
      // Coming back to a tab whose load failed earlier (e.g. the dev server
      // wasn't up at session restore): rebuild NOW instead of spinning a loader
      // over a dead error page (reload() there is useless).
      try { t.wv.remove(); } catch (e) {}
      t.wvReady = false;
      t.wv = (t.kind === "file" || t.previewPath) ? buildFileWebview(t) : buildURLWebview(t);
      canvas.appendChild(t.wv);
    }
    tabs.forEach((x) => { if (x.wv) x.wv.classList.toggle("wv-hidden", x !== t); });
    webview = t.wv;
    webviewReady = !!t.wvReady;
    if (typeof syncNetPanelToActiveTab === "function") syncNetPanelToActiveTab(); // per-tab network log + mocks
    applyBreakpoint();
    if (webviewReady) {
      hidePreviewLoader();
      updateZoom();
      syncInspectorVisual();
      // Tab switch → reload THIS prototype's findings from disk (comments are
      // per project; pins must exist as soon as you open it, not only after
      // the panel opens or the file changes).
      webview.executeJavaScript(PINS_SCRIPT).then(() => loadFindings()).catch(() => {});
    } else {
      showPreviewLoader(); // slow prototype/dev-server load → the app's bento breathes meanwhile
    }
  }
  // Preview loading state: hide the (native, always-on-top) webview until it's
  // ready and show the bento loader in its place.
  function showPreviewLoader() {
    if (webview) webview.style.visibility = "hidden";
    startBento(document.getElementById("preview-loader"));
  }
  function hidePreviewLoader() {
    stopBento(document.getElementById("preview-loader"));
    if (webview && !document.getElementById("preview-error").classList.contains("visible")) webview.style.visibility = "";
  }

  // Preview error state — the webview (a native layer) is hidden and this HTML overlay
  // takes over, with a paste-to-terminal prompt an agent can act on.
  function showPreviewError(t, desc) {
    const el = document.getElementById("preview-error"); if (!el) return;
    const isFile = t.kind === "file";
    document.getElementById("preview-error-title").textContent = isFile ? "Couldn't load the file" : "The preview didn't load";
    document.getElementById("preview-error-msg").textContent = isFile
      ? "Ohana couldn't open this prototype. Does the file exist and is it valid HTML?"
      : "The page didn't respond" + (desc ? " (" + desc + ")" : "") + ". If it's a dev server, it may not be running.";
    document.getElementById("preview-error-prompt").textContent = isFile
      ? "This prototype's file (" + (t.src || "") + ") couldn't be loaded in Ohana. Check that it exists, that the path is correct, and that it's valid HTML; if I moved or renamed it, update the reference."
      : "The preview of " + (t.src || "") + " didn't load" + (desc ? " (" + desc + ")" : "") + ". If it's a dev server (localhost), start it (e.g. `npm run dev`) and confirm the port; if it's a remote URL, check that it's available.";
    if (typeof stopBento === "function") stopBento(document.getElementById("preview-loader")); // error replaces the loader
    if (webview) webview.style.visibility = "hidden";
    el.classList.add("visible");
  }
  function hidePreviewError() { const el = document.getElementById("preview-error"); if (el) el.classList.remove("visible"); if (webview) webview.style.visibility = ""; }

  function buildFileWebview(t) {
    const wv = newWebviewEl();
    wv.src = "file://" + (t.previewPath || t.src);

    wv.addEventListener("did-fail-load", (e) => {
      if (e.errorCode === -3) return; // aborted (normal)
      if (wv === webview) showPreviewError(t, e.errorDescription);
    });
    wv.addEventListener("dom-ready", () => {
      t.wvReady = true;
      try { t.wcId = wv.getWebContentsId(); } catch (e) {} // per-tab network capture key
      if (wv === webview) { hidePreviewError(); hidePreviewLoader(); }
      wv.executeJavaScript(INSPECTOR_SCRIPT).catch(() => {});
      wv.executeJavaScript(PINS_SCRIPT).then(() => { if (wv === webview) loadFindings(); }).catch(() => {});
      if (wv !== webview) return; // background tab \u2014 don't touch active UI
      webviewReady = true;
      syncInspectorVisual();
      updateZoom();
      wv.executeJavaScript(`
        document.documentElement.scrollWidth + '\u00d7' + document.documentElement.scrollHeight
      `).then(size => {
        document.getElementById("bp-size-label").textContent =
          currentBP.width ? currentBP.width + "px" : size;
      }).catch(() => {});
    });

    // Pin clicks bridged out via console.log (only the visible webview can be
    // clicked, but bind to wv regardless).
    wv.addEventListener("console-message", (e) => {
      if (e.message && e.message.indexOf("__OHANA_PIN_MOVE__") === 0) {
        // Pin dragged onto another element → re-anchor the comment there.
        try {
          const mv = JSON.parse(e.message.slice("__OHANA_PIN_MOVE__".length));
          const f = findingsData[parseInt(mv.id, 10)];
          if (f) {
            f.anchor = { aiId: mv.aiId || null, selector: mv.selector || null, label: mv.label || mv.aiId || mv.selector || "element" };
            saveFindings(); syncPins(); renderFindings();
            showToast("Comment moved to " + (f.anchor.label || "element"), "check");
          }
        } catch (err) {}
        return;
      }
      if (e.message && e.message.indexOf("__OHANA_PIN__") === 0) {
        const idx = parseInt(e.message.slice("__OHANA_PIN__".length), 10);
        if (!isNaN(idx)) openThread(idx);
      }
      // Onboarding (and any prototype) can trigger the app's Open dialog from inside the webview.
      if (e.message === "__OHANA_OPEN__" && typeof openOpenDialog === "function") openOpenDialog();
    });

    wv.addEventListener("will-navigate", (e) => {
      const url = e.url;
      if (url.startsWith("file://") && t.kind === "file") {
        const newPath = decodeURIComponent(url.replace("file://", ""));
        t.key = newPath; t.src = newPath; t.name = tabName(newPath);
        t.dir = newPath.slice(0, newPath.lastIndexOf("/"));
        if (wv === webview) {
          currentFilePath = newPath;
          activeKey = newPath;
          renderTabs();
          window.api.navigated(newPath);
        }
      }
    });

    wv.addEventListener("did-navigate", () => {
      wv.executeJavaScript(INSPECTOR_SCRIPT).catch(() => {});
      if (wv === webview) syncInspectorVisual();
    });
    wv.addEventListener("did-navigate-in-page", () => {
      wv.executeJavaScript(INSPECTOR_SCRIPT).catch(() => {});
      if (wv === webview) syncInspectorVisual();
    });
    return wv;
  }

  function reloadWebview(filePath) {
    const wv = webview;
    if (wv && webviewReady) {
      // The webview's own dom-ready handler re-injects inspector + pins for the
      // active tab; just reload it. (No global-webview closure → no cross-tab.)
      wv.reload();
    } else {
      const t = activeTab();
      if (t) { if (t.wv) { t.wv.remove(); t.wv = null; t.wvReady = false; } mountWebview(t); }
    }
    showToast("File updated", "check");
  }

  // ─── Sync inspector VISUAL state into webview ───
  // This ONLY controls the highlight overlay inside the webview (cosmetic).
  // If this fails, the worst case is the highlight doesn't show/hide —
  // but clicks are NEVER affected because click interception is handled
  // by the renderer overlay, not inside the webview.
  function syncInspectorVisual() {
    if (!webview || !webviewReady) return;
    const on = !!sectionMode || inspectorActive || commentMode || netProbeMode;
    webview.executeJavaScript(`
      document.documentElement.setAttribute('data-hdv-inspect', '${on ? "1" : "0"}');
      if (!${on}) {
        const hl = document.getElementById('__hdv_hl');
        if (hl) hl.style.display = 'none';
      }
    `).catch(() => {});
    // Show/hide the overlay (SYNCHRONOUS, renderer-side, never fails)
    inspectOverlay.classList.toggle("active", on);
  }

  // ─── Overlay click handler ───
  // When inspector/section mode is active, the overlay sits on top of the
  // webview and captures clicks. We translate click coords to webview-relative
  // coords, then query the webview for the element at that position.
  inspectOverlay.addEventListener("click", async (e) => {
    if (!webview || !webviewReady) return;
    if (!sectionMode && !inspectorActive && !commentMode && !netProbeMode) return;
    // Translate click to webview-relative coordinates
    const wvRect = webview.getBoundingClientRect();
    const zf = currentZoom / 100;
    const relX = (e.clientX - wvRect.left) / zf;
    const relY = (e.clientY - wvRect.top) / zf;

    // "Which endpoint fills this?": grab the section's text and match it against
    // captured response bodies to find the request that feeds it.
    if (netProbeMode) {
      let txt = "";
      try {
        txt = await webview.executeJavaScript(
          '(function(){ var t=document.elementFromPoint(' + relX + ',' + relY + '); return t ? (t.innerText || t.textContent || "") : ""; })()'
        );
      } catch (err) {}
      setNetProbe(false);
      probeEndpoint(txt);
      return;
    }

    // Comment mode: resolve the clicked element and open the composer
    if (commentMode) {
      let anchor = null;
      try {
        const anchorStr = await webview.executeJavaScript(resolveAnchorScript(relX, relY));
        if (anchorStr) anchor = JSON.parse(anchorStr);
      } catch (err) {
        console.log("[ohana] anchor resolve failed:", err && err.message);
      }
      // Clicked an existing pin → open its thread instead of creating a new one
      if (anchor && anchor.pinId != null) {
        openThread(parseInt(anchor.pinId, 10));
        releaseCommentMode();
        return;
      }
      openComposer(e.clientX, e.clientY, anchor);
      releaseCommentMode(); // anchor placed — drop the tool, finish in the composer
      return;
    }

    // Inspector mode: select the element, open the live editor panel, and
    // release the tool — you've picked your target, now you work in the panel
    // (no more selection mask following the cursor everywhere).
    if (inspectorActive) {
      try {
        const dataStr = await webview.executeJavaScript(readElementScript(relX, relY));
        if (dataStr) { openInspector(JSON.parse(dataStr)); releaseInspectorMode(); }
      } catch (err) {
        console.log("[ohana] inspect read failed:", err && err.message);
      }
      return;
    }

    try {
      const dataStr = await webview.executeJavaScript(`
        (function() {
          const hl = document.getElementById('__hdv_hl');
          if (hl) hl.style.display = 'none';
          const t = document.elementFromPoint(${relX}, ${relY});
          if (!t || t.id === '__hdv_hl' || t.id === '__hdv_label') return null;
          const r = t.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, html: t.outerHTML });
        })()
      `);
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (sectionMode) {
        handleSectionClick(data);
      }
    } catch(err) {}
  });

  // Forward mousemove on the overlay to the webview for highlight
  inspectOverlay.addEventListener("mousemove", (e) => {
    if (!webview || !webviewReady) return;
    const wvRect = webview.getBoundingClientRect();
    const zf = currentZoom / 100;
    const relX = (e.clientX - wvRect.left) / zf;
    const relY = (e.clientY - wvRect.top) / zf;
    webview.executeJavaScript(`
      (function() {
        let hl = document.getElementById('__hdv_hl');
        if (!hl) {
          hl = document.createElement('div');
          hl.id = '__hdv_hl';
          hl.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;border:2px solid #3b82f6;background:rgba(59,130,246,0.06);border-radius:3px;transition:all 0.06s ease;display:none;';
          const label = document.createElement('div');
          label.id = '__hdv_label';
          label.style.cssText = 'position:absolute;top:-22px;left:2px;font:500 10px -apple-system,sans-serif;color:#3b82f6;background:rgba(15,23,42,0.92);padding:2px 7px;border-radius:4px;white-space:nowrap;';
          hl.appendChild(label);
          document.body.appendChild(hl);
        }
        const t = document.elementFromPoint(${relX}, ${relY});
        if (!t || t.id === '__hdv_hl' || t.id === '__hdv_label') return;
        const r = t.getBoundingClientRect();
        hl.style.display = 'block';
        hl.style.left = r.left + 'px';
        hl.style.top = r.top + 'px';
        hl.style.width = r.width + 'px';
        hl.style.height = r.height + 'px';
        const tag = t.tagName.toLowerCase();
        const cls = t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '';
        const idStr = t.id && t.id !== '__hdv_hl' && t.id !== '__hdv_label' ? '#' + t.id : '';
        hl.querySelector('#__hdv_label').textContent = tag + idStr + cls + '  ' + Math.round(r.width) + '\\u00d7' + Math.round(r.height);
      })()
    `).catch(() => {});
  });

  // ─── Zoom ───
  function updateZoom() {
    zoomDisplay.textContent = currentZoom + "%";
    if (webview && webviewReady) webview.setZoomFactor(currentZoom / 100);
  }
  function zoomIn() { currentZoom = Math.min(300, currentZoom + 10); updateZoom(); }
  function zoomOut() { currentZoom = Math.max(25, currentZoom - 10); updateZoom(); }
  function zoomReset() { currentZoom = 100; updateZoom(); }

  // ─── Inspector ───
  function toggleInspector() {
    if (sectionMode) exitSectionMode();
    inspectorActive = !inspectorActive;
    document.getElementById("btn-inspector").classList.toggle("active", inspectorActive);
    if (!inspectorActive) closeInspector();
    syncInspectorVisual();
  }

  // Deactivate the inspector TOOL after a selection, but keep the panel open —
  // the mask stops following the cursor and you work on the selected element.
  function releaseInspectorMode() {
    inspectorActive = false;
    document.getElementById("btn-inspector").classList.remove("active");
    syncInspectorVisual();
  }

  // ─── Toolbar position (fixed presets) ───
  // The toolbar is ALWAYS docked at the bottom (floating glass). No position
  // presets — kept simple so it never interferes with the viewport.
  let currentTBPos = "bottom";
  function setToolbarPosition() {
    toolbar.classList.remove("pos-left", "pos-right", "pos-top", "pos-center");
    toolbar.style.left = ""; toolbar.style.right = ""; toolbar.style.top = ""; toolbar.style.bottom = ""; toolbar.style.transform = "";
    toolbar.classList.add("pos-bottom");
    currentTBPos = "bottom";
    if (dockReady) adjustPanelsMargin();
  }
  setToolbarPosition();

  // ─── Full Screenshot → clipboard ───
  async function takeFullScreenshot() {
    if (!webview || !webviewReady) return;
    if (sectionMode) exitSectionMode();
    try {
      await hidePinsDuringCapture(true);
      const image = await webview.capturePage();
      await hidePinsDuringCapture(false);
      const dataURL = image.toDataURL();
      await window.api.copyImage(dataURL);
      showToast("Screenshot copied to clipboard", "check");
    } catch (err) { await hidePinsDuringCapture(false); showToast("Screenshot failed", "warn"); }
  }

  // ─── Section mode ───
  function enterSectionMode(mode) {
    if (!webview || !webviewReady) return;
    // Toggle off if same mode
    if (sectionMode === mode) { exitSectionMode(); return; }

    // Turn off standalone inspector if it was active
    if (inspectorActive) {
      inspectorActive = false;
      document.getElementById("btn-inspector").classList.remove("active");
      closeInspector();
    }

    // If switching from another section mode, only clean up UI (don't touch
    // webview inspector — avoids async race where disable arrives after enable)
    if (sectionMode) {
      document.removeEventListener("keydown", sectionEscHandler);
      document.getElementById("btn-section-screenshot").classList.remove("active");
      document.getElementById("btn-copy-section-html").classList.remove("active");
    }

    sectionMode = mode;

    sectionHintEl.textContent =
      mode === "screenshot"
        ? "Click sections to capture screenshots · Esc to exit"
        : "Click sections to copy HTML code · Esc to exit";
    sectionHintEl.classList.add("visible");

    document.getElementById("btn-section-screenshot").classList.toggle("active", mode === "screenshot");
    document.getElementById("btn-copy-section-html").classList.toggle("active", mode === "copyhtml");

    // Enable overlay + visual highlight
    syncInspectorVisual();

    document.addEventListener("keydown", sectionEscHandler);
  }

  function sectionEscHandler(e) {
    if (e.key === "Escape") exitSectionMode();
  }

  async function handleSectionClick(data) {
    if (!sectionMode || !webview || !webviewReady) return;
    const mode = sectionMode;
    try {
      if (mode === "screenshot") {
        const zf = currentZoom / 100;
        const image = await webview.capturePage({
          x: Math.round(data.x * zf),
          y: Math.round(data.y * zf),
          width: Math.round(data.w * zf),
          height: Math.round(data.h * zf),
        });
        await window.api.copyImage(image.toDataURL());
        showToast("Section screenshot copied", "check");
      } else {
        if (data.html) {
          await window.api.copyText(data.html);
          showToast("Section code copied", "check");
        }
      }
    } catch (err) {
      showToast("Capture failed", "warn");
    }
    // Captured what you wanted → release the tool (you're off to use the
    // result). Re-activate from the toolbar to grab another section.
    exitSectionMode();
  }

  function exitSectionMode() {
    sectionMode = null;
    sectionHintEl.classList.remove("visible");
    document.removeEventListener("keydown", sectionEscHandler);

    document.getElementById("btn-section-screenshot").classList.remove("active");
    document.getElementById("btn-copy-section-html").classList.remove("active");

    // Sync visual state (overlay hide is instant, no race possible)
    syncInspectorVisual();
  }

  // ─── Zustand State Capture ───
  // Reads from window.__ZUSTAND_STORES__ if exposed, or tries common patterns.
  // The React project should expose stores for debug: window.__ZUSTAND_STORES__ = { storeName: useStore }
  async function captureZustandState() {
    if (!webview || !webviewReady) return null;
    try {
      const stateJson = await webview.executeJavaScript(`
        (function() {
          var state = {};

          // Method 1: Explicit exposure via window.__ZUSTAND_STORES__
          if (window.__ZUSTAND_STORES__) {
            var storeNames = Object.keys(window.__ZUSTAND_STORES__);
            for (var i = 0; i < storeNames.length; i++) {
              var name = storeNames[i];
              try {
                var store = window.__ZUSTAND_STORES__[name];
                var s = null;
                if (store && typeof store.getState === 'function') {
                  s = store.getState();
                } else if (store && typeof store === 'function') {
                  s = store();
                }
                if (s) {
                  // Only include primitive and simple object values (skip functions)
                  var clean = {};
                  Object.keys(s).forEach(function(k) {
                    var v = s[k];
                    if (typeof v !== 'function') {
                      if (typeof v === 'object' && v !== null) {
                        // Shallow serialize — avoid huge nested objects
                        try {
                          var str = JSON.stringify(v);
                          if (str.length < 500) clean[k] = v;
                          else clean[k] = '[Object ' + Object.keys(v).length + ' keys]';
                        } catch(e) { clean[k] = '[circular]'; }
                      } else {
                        clean[k] = v;
                      }
                    }
                  });
                  state[name] = clean;
                }
              } catch(e) {}
            }
            if (Object.keys(state).length > 0) return JSON.stringify(state);
          }

          // Method 2: Try Redux DevTools (some Zustand setups use it)
          if (window.__REDUX_DEVTOOLS_EXTENSION__) {
            try {
              var devtools = window.__REDUX_DEVTOOLS_EXTENSION__;
              if (devtools && devtools.connect) {
                state._note = 'Redux DevTools detected — use window.__ZUSTAND_STORES__ for full capture';
              }
            } catch(e) {}
          }

          // Method 3: Check for React Query devtools data
          if (window.__REACT_QUERY_DEVTOOLS_STATE__) {
            state._reactQuery = 'devtools available';
          }

          return JSON.stringify(state);
        })()
      `);
      if (stateJson && stateJson !== "{}") return JSON.parse(stateJson);
      return null;
    } catch(e) { return null; }
  }

  // ─── Command file watcher (.ohana/commands.json) ───
  // Claude writes commands, Ohana executes them
  async function processCommands() {
    try {
      const content = await window.api.ohanaReadFile("commands.json");
      if (!content) return;
      const commands = JSON.parse(content);
      if (!Array.isArray(commands) || commands.length === 0) return;

      for (const cmd of commands) {
        if (cmd.done) continue;
        cmd.done = true;

        switch (cmd.action) {
          case "capture-screenshot":
            // Take full screenshot and save to .ohana/
            if (webview && webviewReady) {
              const image = await webview.capturePage();
              const dataURL = image.toDataURL();
              const base64 = dataURL.replace(/^data:image\/png;base64,/, "");
              const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
              const ssName = "screenshots/" + currentFilePath.split("/").pop().replace(/\.(html|htm)$/, "") + "." + ts + ".png";
              await window.api.ohanaWriteFile({ filename: ssName, content: "__base64__" + base64 });
              showToast("Screenshot saved (agent request)", "check");
            }
            break;
          case "add-finding":
            // Add a finding to findings.json
            if (cmd.finding) {
              const existing = await window.api.ohanaReadFile("findings.json");
              const findings = existing ? JSON.parse(existing) : [];
              findings.push(cmd.finding);
              await window.api.ohanaWriteFile({ filename: "findings.json", content: JSON.stringify(findings, null, 2) });
            }
            break;
          case "clear-findings":
            await window.api.ohanaWriteFile({ filename: "findings.json", content: "[]" });
            break;
          case "fix-finding":
            // Claude processed a fix — this is informational, the actual fix
            // happens in Claude Code. The finding status is updated separately.
            break;
          case "resolve-finding":
            // Claude finished fixing — mark as resolved
            if (cmd.findingIdx !== undefined) {
              const fData = await window.api.ohanaReadFile("findings.json");
              if (fData) {
                const findings = JSON.parse(fData);
                if (findings[cmd.findingIdx]) {
                  findings[cmd.findingIdx].status = "resolved";
                  findings[cmd.findingIdx].statusAt = new Date().toISOString();
                  findings[cmd.findingIdx].fixNote = cmd.note || "";
                  await window.api.ohanaWriteFile({ filename: "findings.json", content: JSON.stringify(findings, null, 2) });
                }
              }
            }
            break;
          case "reply-comment":
            // Claude replies to a comment thread by index
            if (cmd.findingIdx !== undefined && cmd.message) {
              const rData = await window.api.ohanaReadFile("findings.json");
              if (rData) {
                const findings = JSON.parse(rData);
                const target = findings[cmd.findingIdx];
                if (target) {
                  if (!target.replies) target.replies = [];
                  target.replies.push({
                    author: cmd.author || "Agente",
                    authorType: "agent",
                    message: cmd.message,
                    at: new Date().toISOString(),
                  });
                  if (cmd.resolve) { target.status = "resolved"; target.statusAt = new Date().toISOString(); }
                  await window.api.ohanaWriteFile({ filename: "findings.json", content: JSON.stringify(findings, null, 2) });
                }
              }
            }
            break;
          case "execute-flow":
            await executeFlow(cmd);
            break;
        }
      }

      // Write back with done flags
      await window.api.ohanaWriteFile({ filename: "commands.json", content: JSON.stringify(commands, null, 2) });
    } catch (e) {
      // Silent — command processing should never interrupt
    }
  }

  // ─── Flow Executor ─────────────────────────────────────────────────
  // Claude writes { action: "execute-flow", flowName, steps } to commands.json
  // Ohana simulates user interactions step by step and writes results
  // to .ohana/flow-results.json for Claude to read and evaluate.
  //
  // Step types:
  //   click      — Click element (by: text|ai-id|css|aria)
  //   type       — Type value into input (by: text|ai-id|css, value: string)
  //   select     — Select option from dropdown (target: select element, value: option text)
  //   wait       — Pause ms milliseconds
  //   wait-for   — Wait until state key or element becomes visible (timeout: ms)
  //   assert-visible / assert-hidden — Check element visibility
  //   assert-state   — Check Alpine.js state (key, expected or truthy)
  //   assert-text    — Check element text content (contains or expected)
  //   screenshot     — Capture screenshot (label: filename suffix)
  //   capture-state  — Snapshot full Alpine state
  //
  // Target resolution (by):
  //   text   — Match visible text on buttons/links/interactive elements (default)
  //   ai-id  — Match data-ai-id attribute
  //   css    — Match CSS selector
  //   aria   — Match aria-label attribute

  let flowRunning = false;
  let flowIndicatorEl = null;

  function flowSleep(ms) {
    return new Promise(function(r) { setTimeout(r, ms); });
  }

  function showFlowIndicator(stepNum, total, label) {
    if (!flowIndicatorEl) {
      flowIndicatorEl = document.createElement("div");
      flowIndicatorEl.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:99999;background:rgba(15,23,42,0.95);color:#e2e8f0;font:500 12px/1.4 -apple-system,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.3);border:1px solid rgba(99,102,241,0.4);display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);transition:opacity 0.3s;";
      document.body.appendChild(flowIndicatorEl);
    }
    flowIndicatorEl.innerHTML = '<span style="color:#818cf8;font-size:14px">▶</span> <span>Step ' + stepNum + '/' + total + '</span> <span style="color:#94a3b8">— ' + label + '</span>';
    flowIndicatorEl.style.opacity = "1";
  }

  function endFlowIndicator(status) {
    if (!flowIndicatorEl) return;
    var color = status === "pass" ? "#22c55e" : "#ef4444";
    var icon = status === "pass" ? "✓" : "✗";
    flowIndicatorEl.innerHTML = '<span style="color:' + color + ';font-size:14px">' + icon + '</span> <span>Flow ' + status + '</span>';
    setTimeout(function() {
      if (flowIndicatorEl) {
        flowIndicatorEl.style.opacity = "0";
        setTimeout(function() { if (flowIndicatorEl) { flowIndicatorEl.remove(); flowIndicatorEl = null; } }, 300);
      }
    }, 3000);
  }

  function flowDescribe(step) {
    switch (step.do) {
      case "click": return 'Click "' + step.target + '"';
      case "type": return 'Type in "' + step.target + '"';
      case "select": return 'Select in "' + step.target + '"';
      case "wait": return "Wait " + (step.ms || 300) + "ms";
      case "wait-for": return "Wait for " + (step.key || step.target);
      case "assert-visible": return "Visible: " + step.target;
      case "assert-hidden": return "Hidden: " + step.target;
      case "assert-state": return "State: " + step.key;
      case "assert-text": return "Text: " + step.target;
      case "screenshot": return "Screenshot";
      case "capture-state": return "Capture state";
      default: return step.do || "?";
    }
  }

  // Capture state from the webview — auto-detects Alpine.js or Zustand
  async function flowCaptureState() {
    if (!webview || !webviewReady) return {};

    // In repo mode, try Zustand first
    if (repoMode) {
      const zustandState = await captureZustandState();
      if (zustandState && Object.keys(zustandState).length > 0) return zustandState;
    }

    // Fallback to Alpine.js (works for HTML mode and mixed cases)
    try {
      const json = await webview.executeJavaScript(`
        (function() {
          var xd = document.querySelector('[x-data]');
          if (!xd) return '{}';
          var d = null;
          if (typeof Alpine !== 'undefined' && Alpine.$data) {
            try { d = Alpine.$data(xd); } catch(e) {}
          }
          if (!d && xd._x_dataStack && xd._x_dataStack.length) {
            d = xd._x_dataStack[0];
          }
          if (!d && xd.__x) { d = xd.__x.$data; }
          if (!d) return '{}';
          var keys = ['viewMode','anomalyViewMode','analyzing','pageState','currentProblem',
            'showRunsPanel','collaborationDrawer','heatmapExpanded','showPlaybook',
            'showRelatedTable','postponeModal','confirmModal','toast','anomalyProcessing',
            'activeFilterCount','navDropdownOpen','filterTablero','filterAssignee'];
          var s = {};
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (d[k] !== undefined) s[k] = d[k];
          }
          if (d.current) {
            s['current.id'] = d.current.id;
            s['current.name'] = d.current.name;
            s['current.severity'] = d.current.severity;
            s['current.isRoot'] = d.current.isRoot;
          }
          return JSON.stringify(s);
        })()
      `);
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  // Find element in webview by different strategies and optionally act on it
  // action: "find" | "click" | "type"
  // Returns { found, tag, text, visible, aiId, acted }
  // within: optional data-ai-id to scope the search (e.g. "confirm-reject" to search only inside that modal)
  async function flowFindElement(target, by, action, value, within) {
    if (!webview || !webviewReady || !target) return null;
    const script = `
      (function() {
        var target = ${JSON.stringify(String(target))};
        var by = ${JSON.stringify(String(by || "text"))};
        var within = ${JSON.stringify(within || "")};
        var scope = within ? document.querySelector('[data-ai-id="' + within + '"]') : document;
        if (!scope) return JSON.stringify({ found: false, note: "Scope not found: " + within });
        var el = null;

        if (by === "ai-id") {
          el = scope.querySelector('[data-ai-id="' + target + '"]');
        } else if (by === "css") {
          try { el = scope.querySelector(target); } catch(e) {}
        } else if (by === "aria") {
          el = scope.querySelector('[aria-label="' + target + '"]');
        } else {
          // by text — search interactive elements within scope
          var selectors = 'button, a, [role="button"], label, input[type="submit"], summary, [tabindex="0"]';
          var btns = scope.querySelectorAll(selectors);
          // Pass 1: exact match on visible elements
          for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            var r = b.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            var cs = getComputedStyle(b);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            var txt = b.textContent.replace(/\\s+/g, " ").trim();
            if (txt === target) { el = b; break; }
          }
          // Pass 2: includes match (partial text)
          if (!el) {
            for (var i = 0; i < btns.length; i++) {
              var b = btns[i];
              var r = b.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              var cs = getComputedStyle(b);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              if (b.textContent.replace(/\\s+/g, " ").trim().indexOf(target) !== -1) { el = b; break; }
            }
          }
          // Pass 3: inputs by placeholder or aria-label
          if (!el) {
            var inputs = scope.querySelectorAll('input, textarea, select');
            for (var j = 0; j < inputs.length; j++) {
              var inp = inputs[j];
              if ((inp.placeholder || '').indexOf(target) !== -1) { el = inp; break; }
              if ((inp.getAttribute('aria-label') || '').indexOf(target) !== -1) { el = inp; break; }
            }
          }
        }

        if (!el) return JSON.stringify({ found: false });

        var rect = el.getBoundingClientRect();
        var vis = rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
        var result = {
          found: true,
          tag: el.tagName,
          text: (el.textContent || "").replace(/\\s+/g, " ").trim().substring(0, 120),
          visible: vis,
          aiId: el.getAttribute("data-ai-id") || null
        };

        var action = ${JSON.stringify(String(action || "find"))};

        if (action === "click" && vis) {
          // Visual highlight before click
          var prev = el.style.cssText;
          el.style.outline = "3px solid #818cf8";
          el.style.outlineOffset = "2px";
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          setTimeout(function() { el.style.cssText = prev; }, 500);
          result.acted = "clicked";
        } else if (action === "type" && vis) {
          el.focus();
          el.value = ${JSON.stringify(String(value || ""))};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          result.acted = "typed";
        }

        return JSON.stringify(result);
      })()
    `;
    try {
      const str = await webview.executeJavaScript(script);
      return str ? JSON.parse(str) : null;
    } catch (e) { return null; }
  }

  async function executeFlow(cmd) {
    if (flowRunning || !webview || !webviewReady) return;
    flowRunning = true;

    try {
    const flowName = cmd.flowName || "unnamed";
    const steps = cmd.steps || [];
    const results = {
      flowName: flowName,
      description: cmd.description || "",
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      duration: 0,
      totalSteps: steps.length,
      passedSteps: 0,
      failedSteps: 0,
      steps: [],
      screenshots: [],
      initialState: await flowCaptureState(),
      finalState: null
    };

    const t0 = Date.now();
    let failed = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      showFlowIndicator(i + 1, steps.length, flowDescribe(step));

      const sr = {
        step: i + 1,
        do: step.do,
        target: step.target || null,
        by: step.by || null,
        status: "pass",
        duration: 0,
        note: "",
        stateSnapshot: null
      };
      const st = Date.now();

      try {
        switch (step.do) {
          case "click": {
            const r = await flowFindElement(step.target, step.by, "click", null, step.within);
            if (!r || !r.found) { sr.status = "fail"; sr.note = "Element not found: \"" + step.target + "\""; }
            else if (!r.visible) { sr.status = "fail"; sr.note = "Element found but not visible"; }
            else { sr.note = "Clicked " + r.tag + (r.aiId ? " [" + r.aiId + "]" : "") + (r.text ? ": \"" + r.text.substring(0, 40) + "\"" : ""); }
            await flowSleep(200);
            break;
          }
          case "type": {
            const r = await flowFindElement(step.target, step.by, "type", step.value, step.within);
            if (!r || !r.found) { sr.status = "fail"; sr.note = "Input not found: \"" + step.target + "\""; }
            else { sr.note = "Typed \"" + (step.value || "").substring(0, 50) + "\" into " + r.tag; }
            await flowSleep(150);
            break;
          }
          case "select": {
            // Click to open, wait, then click option by text
            const r = await flowFindElement(step.target, step.by, "click", null, step.within);
            if (!r || !r.found) { sr.status = "fail"; sr.note = "Select trigger not found: \"" + step.target + "\""; break; }
            await flowSleep(300);
            const opt = await flowFindElement(step.value, "text", "click", null, step.within);
            if (!opt || !opt.found) { sr.status = "fail"; sr.note = "Option not found: \"" + step.value + "\""; }
            else { sr.note = "Selected \"" + step.value + "\" from \"" + step.target + "\""; }
            await flowSleep(200);
            break;
          }
          case "wait": {
            await flowSleep(step.ms || 300);
            break;
          }
          case "wait-for": {
            const timeout = step.timeout || 5000;
            const deadline = Date.now() + timeout;
            let met = false;
            while (Date.now() < deadline) {
              if (step.key) {
                const state = await flowCaptureState();
                const parts = step.key.split(".");
                let val = state;
                for (let p = 0; p < parts.length; p++) { val = val ? val[parts[p]] : undefined; }
                if (step.expected !== undefined) { if (val == step.expected) { met = true; break; } }
                else { if (val) { met = true; break; } }
              } else if (step.target) {
                const r = await flowFindElement(step.target, step.by || "ai-id", "find", null, step.within);
                if (r && r.found && r.visible) { met = true; break; }
              }
              await flowSleep(150);
            }
            if (!met) { sr.status = "fail"; sr.note = "Timeout (" + timeout + "ms) waiting for " + (step.key || step.target); }
            else { sr.note = "Condition met in " + (Date.now() - st) + "ms"; }
            break;
          }
          case "assert-visible": {
            const r = await flowFindElement(step.target, step.by || "ai-id", "find", null, step.within);
            if (!r || !r.found) { sr.status = "fail"; sr.note = "Not found: " + step.target; }
            else if (!r.visible) { sr.status = "fail"; sr.note = "Exists but not visible: " + step.target; }
            else { sr.note = "Visible ✓ — " + r.tag + (r.aiId ? " [" + r.aiId + "]" : ""); }
            break;
          }
          case "assert-hidden": {
            const r = await flowFindElement(step.target, step.by || "ai-id", "find", null, step.within);
            if (r && r.found && r.visible) { sr.status = "fail"; sr.note = "Should be hidden but is visible: " + step.target; }
            else { sr.note = "Hidden ✓"; }
            break;
          }
          case "assert-state": {
            const state = await flowCaptureState();
            const parts = step.key.split(".");
            let val = state;
            for (let p = 0; p < parts.length; p++) { val = val ? val[parts[p]] : undefined; }
            if (step.expected !== undefined) {
              if (val != step.expected) { sr.status = "fail"; sr.note = step.key + ": expected " + JSON.stringify(step.expected) + ", got " + JSON.stringify(val); }
              else { sr.note = step.key + " = " + JSON.stringify(val) + " ✓"; }
            } else if (step.truthy !== undefined) {
              if (step.truthy && !val) { sr.status = "fail"; sr.note = step.key + " should be truthy, got " + JSON.stringify(val); }
              else if (!step.truthy && val) { sr.status = "fail"; sr.note = step.key + " should be falsy, got " + JSON.stringify(val); }
              else { sr.note = step.key + " = " + JSON.stringify(val) + " ✓"; }
            }
            break;
          }
          case "assert-text": {
            const r = await flowFindElement(step.target, step.by || "ai-id", "find", null, step.within);
            if (!r || !r.found) { sr.status = "fail"; sr.note = "Not found: " + step.target; }
            else if (step.contains && !r.text.includes(step.contains)) {
              sr.status = "fail"; sr.note = "\"" + r.text.substring(0, 80) + "\" does not contain \"" + step.contains + "\"";
            } else if (step.expected !== undefined && r.text !== step.expected) {
              sr.status = "fail"; sr.note = "Expected \"" + step.expected + "\", got \"" + r.text.substring(0, 80) + "\"";
            } else { sr.note = "Text matches ✓"; }
            break;
          }
          case "screenshot": {
            try {
              const image = await webview.capturePage();
              const dataURL = image.toDataURL();
              const b64 = dataURL.replace(/^data:image\/png;base64,/, "");
              const label = step.label || ("step-" + sr.step);
              const ssName = "screenshots/flow-" + flowName + "-" + label + ".png";
              await window.api.ohanaWriteFile({ filename: ssName, content: "__base64__" + b64 });
              results.screenshots.push(ssName);
              sr.note = "Saved: " + ssName;
            } catch (e) { sr.note = "Screenshot failed: " + e.message; }
            break;
          }
          case "capture-state": {
            sr.stateSnapshot = await flowCaptureState();
            sr.note = Object.keys(sr.stateSnapshot).length + " keys captured";
            break;
          }
          default:
            sr.status = "fail";
            sr.note = "Unknown step type: " + step.do;
        }
      } catch (err) {
        sr.status = "fail";
        sr.note = err.message || String(err);
      }

      sr.duration = Date.now() - st;

      // Auto-capture state after interactive steps
      if (!sr.stateSnapshot && step.do !== "wait" && step.do !== "screenshot") {
        try { sr.stateSnapshot = await flowCaptureState(); } catch (e) {}
      }

      results.steps.push(sr);
      if (sr.status === "pass") results.passedSteps++;
      else results.failedSteps++;

      // Write partial results so Claude can monitor progress
      results.duration = Date.now() - t0;
      await window.api.ohanaWriteFile({
        filename: "flow-results.json",
        content: JSON.stringify(results, null, 2)
      });

      if (sr.status === "fail") {
        failed = true;
        if (!step.continueOnFail) break;
      }

      // Pause between steps for UI to settle
      if (i < steps.length - 1 && step.do !== "wait") {
        await flowSleep(step.pauseAfter || 150);
      }
    }

    results.status = failed ? "fail" : "pass";
    results.completedAt = new Date().toISOString();
    results.duration = Date.now() - t0;
    try { results.finalState = await flowCaptureState(); } catch (e) {}

    // Write final results
    await window.api.ohanaWriteFile({
      filename: "flow-results.json",
      content: JSON.stringify(results, null, 2)
    });

    endFlowIndicator(results.status);
    showToast("Flow \"" + flowName + "\" " + results.status + " (" + results.passedSteps + "/" + results.totalSteps + " steps, " + results.duration + "ms)", results.status === "pass" ? "check" : "warn");
    } catch (outerErr) {
      showToast("Flow error: " + (outerErr.message || outerErr), "warn");
      // Write error to results file so Claude can see it
      try {
        await window.api.ohanaWriteFile({
          filename: "flow-results.json",
          content: JSON.stringify({ status: "error", error: outerErr.message || String(outerErr), stack: outerErr.stack || "" }, null, 2)
        });
      } catch (e) {}
    }
    flowRunning = false;
  }

  // ─── Findings Panel ───
  let findingsVisible = false;
  let findingsData = [];
  let findingsFilter = "all";

  // ── Reply / resolve notifications ──
  // Detect when Claude adds an agent reply (or resolves) a comment and surface
  // it: targeted toast, a native notification when Ohana is in the background,
  // and an unread badge so you can find it without watching the panel.
  let prevAgentCounts = null;   // id -> count of agent replies (baseline)
  let unreadIds = new Set();    // comments changed since you last looked
  function agentReplyCount(f) { return (f.replies || []).filter((r) => r.authorType === "agent").length; }
  function snapshotAgent(arr) { const m = new Map(); (arr || []).forEach((f) => m.set(f.id, agentReplyCount(f))); return m; }
  function pinNumForId(id) { const i = findingsData.findIndex((f) => f.id === id); return i >= 0 ? computePinNum(i) : null; }
  function updateFindingsBadge() {
    const btn = document.getElementById("btn-findings");
    if (!btn) return;
    let b = btn.querySelector(".hdr-badge");
    const n = unreadIds.size;
    if (n > 0) {
      if (!b) { b = document.createElement("span"); b.className = "hdr-badge"; btn.appendChild(b); }
      b.textContent = n > 9 ? "9+" : String(n);
    } else if (b) { b.remove(); }
  }
  function notifyCommentChanges(changed) {
    let title, body;
    if (changed.length === 1) {
      const f = changed[0];
      const n = pinNumForId(f.id);
      const resolved = f.status === "resolved";
      const last = (f.replies || []).filter((r) => r.authorType === "agent").slice(-1)[0];
      title = resolved ? "Comment resolved" : "The agent replied";
      body = (n ? "#" + n + " — " : "") + (last ? last.message : "");
      showToast(title + (n ? " · #" + n : ""), "check");
    } else {
      title = "The agent updated comments";
      body = changed.length + " comments with new replies";
      showToast(body, "check");
    }
    if (!document.hasFocus()) window.api.notify(title, body);
  }
  // Compare new findings against the baseline; notify on new agent replies
  // (which is also how Claude resolves — it replies + resolves together).
  function diffAndNotifyFindings() {
    if (prevAgentCounts) {
      const changed = findingsData.filter((f) => agentReplyCount(f) > (prevAgentCounts.get(f.id) || 0));
      if (changed.length) {
        changed.forEach((f) => unreadIds.add(f.id));
        notifyCommentChanges(changed);
        updateFindingsBadge();
      }
    }
    prevAgentCounts = snapshotAgent(findingsData);
  }

  function toggleFindings() {
    findingsVisible = !findingsVisible;
    document.getElementById("findings-panel").classList.toggle("visible", findingsVisible);
    document.getElementById("btn-findings").classList.toggle("active", findingsVisible);
    if (findingsVisible) { unreadIds.clear(); updateFindingsBadge(); loadFindings(); }
    adjustPanelsMargin();
  }

  async function loadFindings() {
    try {
      const content = await window.api.ohanaReadFile("findings.json");
      if (content) {
        findingsData = JSON.parse(content);
        prevAgentCounts = snapshotAgent(findingsData); // re-baseline for this prototype
        renderFindings();
        syncPins();
      }
    } catch (e) {
      findingsData = [];
      renderFindings();
      syncPins();
    }
  }

  function renderFindings() {
    const list = document.getElementById("fp-list");
    const empty = document.getElementById("fp-empty");
    const countEl = document.getElementById("fp-count");
    const footerInfo = document.getElementById("fp-footer-info");

    // Comments only — sorted open-first, newest within each group
    const all = findingsData.slice().sort((a, b) => {
      const rank = (f) => (f.status === "resolved" ? 1 : 0);
      return rank(a) - rank(b);
    });

    let filtered = all;
    if (findingsFilter === "open") {
      filtered = all.filter(f => f.status !== "resolved");
    } else if (findingsFilter === "resolved") {
      filtered = all.filter(f => f.status === "resolved");
    }

    const openCount = findingsData.filter(f => f.status !== "resolved").length;
    const resolvedCount = findingsData.filter(f => f.status === "resolved").length;
    countEl.textContent = openCount;
    footerInfo.textContent = openCount + " open · " + resolvedCount + " resolved";

    list.querySelectorAll(".fp-item").forEach(el => el.remove());
    if (filtered.length === 0) {
      empty.style.display = "flex";
      return;
    }
    empty.style.display = "none";

    filtered.forEach((finding) => {
      const realIdx = findingsData.indexOf(finding);
      const item = document.createElement("div");
      const resolved = finding.status === "resolved";
      item.className = "fp-item clickable" + (resolved ? " resolved" : "") + (unreadIds.has(finding.id) ? " unread" : "");
      item.dataset.threadIdx = realIdx;
      const anchorId = (finding.anchor && finding.anchor.aiId) || finding.component;
      const anchorLabel = (finding.anchor && finding.anchor.label) || finding.component || "unanchored";
      if (anchorId) item.dataset.component = anchorId;
      const pinNum = computePinNum(realIdx);
      const replyCount = (finding.replies || []).length;
      const replyTag = replyCount ? `<span class="fp-component"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;vertical-align:-1.5px"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg> ${replyCount}</span>` : "";
      const statusBadge = resolved ? '<span class="fp-status-badge resolved">Resolved</span>' : "";

      item.innerHTML = `
        <div class="fp-item-head">
          <span class="thread-pin-num${resolved ? ' resolved' : ''}" style="width:18px;height:18px;font-size:10px;">${pinNum || "•"}</span>
          <span class="fp-author">${escapeHtml(finding.author || "You")}</span>
          <span class="fp-component">◎ ${escapeHtml(anchorLabel)}</span>
          ${replyTag}
          ${statusBadge}
        </div>
        <div class="fp-message">${escapeHtml(finding.message || '')}</div>
        <div class="fp-actions">
          <button class="fp-act" data-act="resolve">${resolved ? "Reopen" : "Resolve"}</button>
          <button class="fp-act danger" data-act="delete">Delete</button>
        </div>
      `;
      list.appendChild(item);
    });
  }

  // escapeHtml → src/lib/markdown.js (window.OhanaMD)

  // Panel item click → toggle the thread (open it, or close it if it's already
  // the open one) + flash the anchored element. Toggling from the panel means
  // you can always close a thread here even if its card landed off-screen.
  document.getElementById("fp-list").addEventListener("click", async (e) => {
    const item = e.target.closest(".fp-item[data-thread-idx]");
    if (!item) return;
    const idx = parseInt(item.dataset.threadIdx, 10);
    if (isNaN(idx)) return;
    // Quick actions on the item itself — resolve/reopen or delete without
    // having to open the floating thread card.
    const act = e.target.closest(".fp-act");
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === "delete") {
        await deleteFinding(idx);
        if (idx === threadIdx) closeThread();
      } else if (act.dataset.act === "resolve") {
        const f = findingsData[idx];
        await setFindingResolved(idx, f && f.status !== "resolved");
        if (idx === threadIdx && threadCard.classList.contains("visible")) openThread(idx);
      }
      return;
    }
    if (idx === threadIdx && threadCard.classList.contains("visible")) { closeThread(); return; }
    openThread(idx);
    if (item.dataset.component) flashAnchor(item.dataset.component);
  });

  // Scroll to + briefly highlight an anchored element by data-ai-id
  async function flashAnchor(componentId) {
    if (!webview || !webviewReady) return;
    try {
      await webview.executeJavaScript(`
        (function() {
          var prev = document.getElementById('__ohana_highlight');
          if (prev) prev.remove();
          var el = document.querySelector('[data-ai-id="${String(componentId).replace(/["\\]/g, "\\$&")}"]');
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var rect = el.getBoundingClientRect();
          var hl = document.createElement('div');
          hl.id = '__ohana_highlight';
          hl.style.cssText = 'position:fixed;z-index:99988;pointer-events:none;' +
            'border:2px solid #7cb0ff;background:rgba(96,165,250,0.10);border-radius:6px;' +
            'transition:opacity 0.3s;' +
            'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
            'width:' + rect.width + 'px;height:' + rect.height + 'px;';
          document.body.appendChild(hl);
          setTimeout(function() { hl.style.opacity = '0'; setTimeout(function(){ hl.remove(); }, 300); }, 2000);
        })()
      `);
    } catch (err) {}
  }

  // Findings filter clicks
  document.getElementById("fp-filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".fp-filter");
    if (!btn) return;
    findingsFilter = btn.dataset.filter;
    document.querySelectorAll(".fp-filter").forEach(f => f.classList.remove("active"));
    btn.classList.add("active");
    renderFindings();
  });

  document.getElementById("fp-close").onclick = toggleFindings;
  document.getElementById("fp-refresh-btn").onclick = loadFindings;
  document.getElementById("btn-findings").onclick = toggleFindings;

  // ════════════════════════════════════════════════════════════════════
  //  Comments (Figma-style) — people drop pins anchored to elements,
  //  Claude reads/replies via the same .ohana/findings.json file.
  // ════════════════════════════════════════════════════════════════════
  // Comment author: localStorage override → system username → "You".
  // Resolved on init (see resolveCommentAuthor) and editable in the composer.
  let commentAuthor = localStorage.getItem("ohana.author") || "You";
  async function resolveCommentAuthor() {
    if (!localStorage.getItem("ohana.author")) {
      try {
        const u = await window.api.getUsername();
        if (u) commentAuthor = u;
      } catch (e) {}
    }
    const input = document.getElementById("cmt-author");
    if (input) input.value = commentAuthor;
  }
  resolveCommentAuthor();

  // ── Pins layer injected into the webview (tracks elements via rAF) ──
  const PINS_SCRIPT = `
    (function() {
      if (window.__ohanaPinsInit) return;
      window.__ohanaPinsInit = true;
      var layer = document.createElement('div');
      layer.id = '__ohana_pins';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99990;';
      (document.body || document.documentElement).appendChild(layer);
      var pins = [];
      function esc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }
      function resolveEl(p){
        var el = null;
        if (p.aiId) { try { el = document.querySelector('[data-ai-id="' + esc(p.aiId) + '"]'); } catch(e){} }
        if (!el && p.selector) { try { el = document.querySelector(p.selector); } catch(e){} }
        return el;
      }
      window.__ohanaSetPins = function(json){
        try { pins = JSON.parse(json) || []; } catch(e){ pins = []; }
        layer.innerHTML = '';
        pins.forEach(function(p){
          var b = document.createElement('div');
          b.dataset.id = p.id;
          var resolved = p.status === 'resolved';
          b.style.cssText = 'position:fixed;pointer-events:auto;cursor:pointer;width:26px;height:26px;' +
            'border-radius:50% 50% 50% 2px;display:flex;align-items:center;justify-content:center;' +
            'font:700 12px -apple-system,system-ui,sans-serif;color:#fff;' +
            'background:' + (resolved ? '#10b981' : '#2563eb') + ';' +
            'box-shadow:0 2px 8px rgba(0,0,0,0.4),0 0 0 2px rgba(255,255,255,0.92);' +
            'transition:transform 0.1s ease;opacity:' + (resolved ? '0.8' : '1') + ';';
          b.textContent = p.num;
          b.title = (p.author || 'Comment') + ': ' + (p.preview || '');
          b.addEventListener('mouseenter', function(){ if (!p._drag) b.style.transform = 'scale(1.15)'; });
          b.addEventListener('mouseleave', function(){ b.style.transform = 'scale(1)'; });
          // Click = open the thread. Drag = move the pin: on drop it re-anchors
          // to the element under the cursor (Figma-style move).
          b.addEventListener('mousedown', function(ev){
            ev.stopPropagation(); ev.preventDefault();
            var sx = ev.clientX, sy = ev.clientY, moved = false;
            function mv(e){
              if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 6){ moved = true; p._drag = true; b.style.opacity = '0.75'; b.style.transform = 'scale(1.15)'; }
              if (moved){ b.style.left = (e.clientX - 13) + 'px'; b.style.top = (e.clientY - 13) + 'px'; }
            }
            function up(e){
              document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
              if (!moved){ console.log('__OHANA_PIN__' + p.id); return; }
              p._drag = false; b.style.opacity = ''; b.style.transform = 'scale(1)';
              b.style.pointerEvents = 'none';
              var t = document.elementFromPoint(e.clientX, e.clientY);
              b.style.pointerEvents = 'auto';
              if (!t || t === document.documentElement || t === document.body){ return; } // dropped on nothing → snap back to its anchor
              var aiId = null, node = t;
              while (node && node !== document.documentElement){ if (node.dataset && node.dataset.aiId){ aiId = node.dataset.aiId; break; } node = node.parentElement; }
              var anchorEl = aiId ? node : t;
              function sel(el){
                if (!el || el.nodeType !== 1) return '';
                if (el.id) return '#' + CSS.escape(el.id);
                var parts = [];
                while (el && el.nodeType === 1 && el !== document.body){
                  var part = el.tagName.toLowerCase();
                  var pp = el.parentElement;
                  if (pp){ var sibs = Array.prototype.filter.call(pp.children, function(c){ return c.tagName === el.tagName; }); if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')'; }
                  parts.unshift(part); el = pp;
                }
                return parts.join(' > ');
              }
              var tag = anchorEl.tagName.toLowerCase();
              var label = aiId ? aiId : (tag + (anchorEl.id ? '#' + anchorEl.id : (anchorEl.className && typeof anchorEl.className === 'string' && anchorEl.className.trim() ? '.' + anchorEl.className.trim().split(/\\s+/)[0] : '')));
              console.log('__OHANA_PIN_MOVE__' + JSON.stringify({ id: p.id, aiId: aiId, selector: sel(anchorEl), label: label }));
            }
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
          });
          layer.appendChild(b);
          p._el = b;
        });
      };
      window.__ohanaHidePins = function(hide){ layer.style.display = hide ? 'none' : 'block'; };
      // A pin belongs to the VIEW you're looking at: if its anchor is hidden
      // (display:none / zero-size — e.g. another SPA screen), the pin hides too
      // instead of collapsing to the top-left corner. It reappears as you navigate.
      function visibleRect(t){
        var r = t.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) return null;
        try { var st = getComputedStyle(t); if (st.display === 'none' || st.visibility === 'hidden') return null; } catch(e){}
        return r;
      }
      function positionAll(){
        for (var i = 0; i < pins.length; i++){
          var p = pins[i]; if (!p._el) continue;
          if (p._drag) continue; // being dragged — follows the cursor, not the anchor
          var t = resolveEl(p);
          var r = t && visibleRect(t);
          if (!r){ p._el.style.display = 'none'; continue; }
          p._el.style.display = 'flex';
          p._el.style.left = (r.left - 6) + 'px';
          p._el.style.top = (r.top - 6) + 'px';
        }
        requestAnimationFrame(positionAll);
      }
      requestAnimationFrame(positionAll);
    })()
  `;

  // ── Returns a script that resolves the nearest data-ai-id anchor at a point ──
  function resolveAnchorScript(relX, relY) {
    return `
      (function() {
        var hl = document.getElementById('__hdv_hl'); if (hl) hl.style.display = 'none';
        var t = document.elementFromPoint(${relX}, ${relY});
        if (!t || t.id === '__hdv_hl' || t.id === '__hdv_label') return null;
        // Did the click land on an existing pin? → open its thread
        if (t.dataset && t.dataset.id != null && t.parentElement && t.parentElement.id === '__ohana_pins') {
          return JSON.stringify({ pinId: t.dataset.id });
        }
        // Walk up to the nearest element carrying a data-ai-id
        var aiId = null, node = t;
        while (node && node !== document.documentElement) {
          if (node.dataset && node.dataset.aiId) { aiId = node.dataset.aiId; break; }
          node = node.parentElement;
        }
        var anchorEl = aiId ? node : t;
        // Build a reasonably stable CSS selector as a fallback
        function sel(el){
          if (!el || el.nodeType !== 1) return '';
          if (el.id) return '#' + CSS.escape(el.id);
          var parts = [];
          while (el && el.nodeType === 1 && el !== document.body) {
            var part = el.tagName.toLowerCase();
            var p = el.parentElement;
            if (p) {
              var sibs = Array.prototype.filter.call(p.children, function(c){ return c.tagName === el.tagName; });
              if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
            }
            parts.unshift(part);
            el = p;
          }
          return parts.join(' > ');
        }
        var tag = anchorEl.tagName.toLowerCase();
        var label = aiId ? aiId : (tag + (anchorEl.id ? '#' + anchorEl.id : (anchorEl.className && typeof anchorEl.className === 'string' ? '.' + anchorEl.className.split(' ')[0] : '')));
        return JSON.stringify({ aiId: aiId, selector: sel(anchorEl), label: label });
      })()
    `;
  }

  // ── Build the pin payload from findingsData (numbered, anchored items) ──
  function syncPins() {
    if (!webview || !webviewReady) return;
    const pins = [];
    let n = 0;
    findingsData.forEach((f, idx) => {
      const aiId = (f.anchor && f.anchor.aiId) || f.component || null;
      const selector = f.anchor && f.anchor.selector;
      if (!aiId && !selector) return; // not anchored → no pin
      n++;
      pins.push({
        id: String(idx),
        num: n,
        aiId: aiId,
        selector: selector || null,
        status: f.status,
        author: f.author || f.agent || "",
        preview: (f.message || "").slice(0, 60),
      });
    });
    const json = JSON.stringify(pins);
    webview.executeJavaScript(
      `window.__ohanaSetPins && window.__ohanaSetPins(${JSON.stringify(json)})`
    ).catch(() => {});
    if (pinsHidden) hidePinsDuringCapture(true); // keep them hidden across re-syncs (reload/tab switch)
  }

  function hidePinsDuringCapture(hide) {
    if (!webview || !webviewReady) return Promise.resolve();
    return webview.executeJavaScript(
      `window.__ohanaHidePins && window.__ohanaHidePins(${hide ? "true" : "false"})`
    ).catch(() => {});
  }

  // ── Header: hide/show comment pins ──
  let pinsHidden = false;
  function togglePinsVisible() {
    pinsHidden = !pinsHidden;
    hidePinsDuringCapture(pinsHidden);
    const btn = document.getElementById("btn-toggle-pins");
    if (btn) {
      btn.classList.toggle("active", pinsHidden);
      const slash = btn.querySelector(".tp-slash"); if (slash) slash.style.display = pinsHidden ? "" : "none";
      btn.dataset.tip = pinsHidden ? "Show comments" : "Hide comments";
    }
    showToast(pinsHidden ? "Comments hidden" : "Comments visible", "check");
  }
  document.getElementById("btn-toggle-pins").onclick = togglePinsVisible;

  // ── Header: presentation mode — hide the whole UI around the viewport ──
  // For demos: nav, panels, toolbar and Moka chrome disappear; the content takes
  // the full frame. The header stays (it holds the way back); Esc also exits.
  let presenting = false;
  function togglePresent(force) {
    presenting = (force !== undefined) ? !!force : !presenting;
    document.body.classList.toggle("presenting", presenting);
    const btn = document.getElementById("btn-present"); if (btn) btn.classList.toggle("active", presenting);
    if (typeof dockReady !== "undefined" && dockReady) adjustPanelsMargin();
  }
  document.getElementById("btn-present").onclick = () => togglePresent();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && presenting) togglePresent(false); });

  // ── Comment mode ──
  function toggleCommentMode() {
    if (!webview || !webviewReady) {
      showToast("Open a file first to comment", "warn");
      return;
    }
    if (sectionMode) exitSectionMode();
    if (inspectorActive) {
      inspectorActive = false;
      document.getElementById("btn-inspector").classList.remove("active");
      closeInspector();
    }
    commentMode = !commentMode;
    document.getElementById("btn-comment").classList.toggle("active", commentMode);
    inspectOverlay.classList.toggle("comment-mode", commentMode);
    if (commentMode) {
      sectionHintEl.textContent = "Click any element to comment · Esc to exit";
      sectionHintEl.classList.add("visible");
      document.addEventListener("keydown", commentEscHandler);
      syncPins(); // make sure existing comment pins are visible
    } else {
      sectionHintEl.classList.remove("visible");
      document.removeEventListener("keydown", commentEscHandler);
      closeComposer();
    }
    syncInspectorVisual();
  }
  // Drop the comment TOOL after an anchor is placed, but leave the composer /
  // thread open so you can finish writing. Esc still closes the composer.
  function releaseCommentMode() {
    commentMode = false;
    document.getElementById("btn-comment").classList.remove("active");
    inspectOverlay.classList.remove("comment-mode");
    sectionHintEl.classList.remove("visible");
    syncInspectorVisual();
  }
  function commentEscHandler(e) {
    if (e.key === "Escape") {
      if (document.getElementById("cmt-composer").classList.contains("visible")) { closeComposer(); return; }
      if (commentMode) toggleCommentMode();
    }
  }

  // ── Composer ──
  let pendingAnchor = null;
  const composerEl = document.getElementById("cmt-composer");
  const cmtInput = document.getElementById("cmt-input");
  const cmtAnchorTag = document.getElementById("cmt-anchor-tag");

  function openComposer(screenX, screenY, anchor) {
    pendingAnchor = anchor;
    if (anchor && anchor.aiId) {
      cmtAnchorTag.textContent = "◎ " + anchor.label;
      cmtAnchorTag.classList.remove("orphan");
    } else if (anchor && anchor.selector) {
      cmtAnchorTag.textContent = "◎ " + (anchor.label || anchor.selector);
      cmtAnchorTag.classList.remove("orphan");
    } else {
      cmtAnchorTag.textContent = "no element";
      cmtAnchorTag.classList.add("orphan");
    }
    // Clamp within viewport
    const w = 268, h = 150;
    let x = Math.min(screenX + 8, window.innerWidth - w - 12);
    let y = Math.min(screenY + 8, window.innerHeight - h - 12);
    composerEl.style.left = Math.max(12, x) + "px";
    composerEl.style.top = Math.max(48, y) + "px";
    composerEl.classList.add("visible");
    cmtInput.value = "";
    setTimeout(() => cmtInput.focus(), 0);
  }
  function closeComposer() {
    composerEl.classList.remove("visible");
    pendingAnchor = null;
  }
  async function postComment() {
    const msg = cmtInput.value.trim();
    if (!msg) return;
    const items = findingsData.slice();
    items.push({
      id: "cmt_" + Date.now().toString(36),
      kind: "comment",
      author: commentAuthor,
      authorType: "person",
      anchor: pendingAnchor || null,
      component: pendingAnchor && pendingAnchor.aiId ? pendingAnchor.aiId : undefined,
      message: msg,
      status: "open",
      createdAt: new Date().toISOString(),
      replies: [],
    });
    findingsData = items;
    await saveFindings();
    renderFindings();
    syncPins();
    closeComposer();
    showToast("Comment added", "check");
  }
  document.getElementById("cmt-post").onclick = postComment;
  document.getElementById("cmt-cancel").onclick = closeComposer;
  // Editable author — persists across sessions
  document.getElementById("cmt-author").addEventListener("input", (e) => {
    commentAuthor = e.target.value.trim() || "You";
    localStorage.setItem("ohana.author", commentAuthor);
  });
  cmtInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
    if (e.key === "Escape") { e.preventDefault(); closeComposer(); }
  });

  async function saveFindings() {
    await window.api.ohanaWriteFile({
      filename: "findings.json",
      content: JSON.stringify(findingsData, null, 2),
    });
  }

  // ── Thread card ──
  let threadIdx = null;
  let threadMoved = false; // user dragged it → don't re-anchor on re-render
  const threadCard = document.getElementById("thread-card");

  function fmtTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  async function openThread(idx) {
    const f = findingsData[idx];
    if (!f) return;
    if (unreadIds.delete(f.id)) updateFindingsBadge();
    // Opening a DIFFERENT thread re-anchors it to that pin; re-rendering the
    // same thread (reply/resolve) keeps wherever the user dragged it.
    const isNewThread = idx !== threadIdx;
    if (isNewThread) threadMoved = false;
    threadIdx = idx;
    const resolved = f.status === "resolved";
    const pinNum = computePinNum(idx);

    document.getElementById("thread-pin-num").textContent = pinNum || "•";
    document.getElementById("thread-pin-num").classList.toggle("resolved", resolved);
    const anchorLabel = (f.anchor && f.anchor.label) || f.component || "unanchored";
    document.getElementById("thread-anchor").textContent = "◎ " + anchorLabel;

    // Build the message + replies list
    const body = document.getElementById("thread-body");
    body.innerHTML = "";
    body.appendChild(renderMsg(f.author || f.agent || "unknown", f.authorType || (f.agent ? "agent" : "person"), f.message, f.createdAt));
    (f.replies || []).forEach((r) => {
      body.appendChild(renderMsg(r.author, r.authorType, r.message, r.at));
    });

    // Status slot + resolve button label
    const statusSlot = document.getElementById("thread-status-slot");
    const resolveBtn = document.getElementById("thread-resolve");
    if (resolved) {
      statusSlot.innerHTML = '<span class="thread-resolved-tag">✓ Resolved</span>';
      resolveBtn.textContent = "Reopen";
    } else {
      statusSlot.innerHTML = "";
      resolveBtn.textContent = "Resolve";
    }

    threadCard.classList.add("visible");
    document.getElementById("thread-reply-input").value = "";
    threadCard.classList.toggle("moved", threadMoved);
    if (isNewThread || !threadMoved) positionThreadCard(f);
  }

  function renderMsg(author, authorType, text, at) {
    const wrap = document.createElement("div");
    wrap.className = "thread-msg";
    const isAgent = authorType === "agent";
    wrap.innerHTML =
      '<div class="thread-msg-head">' +
        '<span class="thread-author' + (isAgent ? " agent" : "") + '">' + escapeHtml(author || "unknown") + "</span>" +
        '<span class="thread-time">' + escapeHtml(fmtTime(at)) + "</span>" +
      "</div>" +
      '<div class="thread-text">' + escapeHtml(text || "") + "</div>";
    return wrap;
  }

  function computePinNum(idx) {
    let n = 0;
    for (let i = 0; i < findingsData.length; i++) {
      const f = findingsData[i];
      const anchored = (f.anchor && (f.anchor.aiId || f.anchor.selector)) || f.component;
      if (anchored) n++;
      if (i === idx) return anchored ? n : null;
    }
    return null;
  }

  async function positionThreadCard(f) {
    // Default: right side, below titlebar (final position is clamped below)
    let left = window.innerWidth - 396, top = 60;
    const aiId = (f.anchor && f.anchor.aiId) || f.component;
    const selector = f.anchor && f.anchor.selector;
    if (webview && webviewReady && (aiId || selector)) {
      try {
        const aiSel = aiId ? '[data-ai-id="' + String(aiId).replace(/["\\]/g, "\\$&") + '"]' : null;
        const rectStr = await webview.executeJavaScript(`
          (function(){
            var el = null;
            ${aiSel ? `try{ el = document.querySelector(${JSON.stringify(aiSel)}); }catch(e){}` : ""}
            ${selector ? `if(!el){ try{ el = document.querySelector(${JSON.stringify(selector)}); }catch(e){} }` : ""}
            if(!el) return null;
            var r = el.getBoundingClientRect();
            return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height});
          })()
        `);
        if (rectStr) {
          const r = JSON.parse(rectStr);
          // A hidden anchor (another SPA view) has a zero rect → keep the default
          // side position instead of jumping to the top-left corner.
          if (r.w > 0 || r.h > 0) {
            const wvRect = webview.getBoundingClientRect();
            const zf = currentZoom / 100;
            // Figma-style: the card opens NEXT TO THE PIN (element's top-left),
            // left-aligned to it — not off the element's far right edge.
            const pinX = wvRect.left + r.x * zf;
            const pinY = wvRect.top + r.y * zf;
            left = pinX + 28;
            top = Math.max(60, pinY - 6);
          }
        }
      } catch (e) {}
    }
    // Clamp fully on-screen using the card's ACTUAL rendered size (it grows with
    // replies, capped at max-height:70vh with an internal scroll), so the header
    // + close button are always reachable and the card never runs off the edge.
    const rect = threadCard.getBoundingClientRect();
    const cardW = rect.width || 300;
    const cardH = rect.height || 280;
    left = Math.min(left, window.innerWidth - cardW - 12);
    left = Math.max(12, left);
    top = Math.min(top, window.innerHeight - cardH - 12);
    top = Math.max(12, top);
    threadCard.style.left = left + "px";
    threadCard.style.top = top + "px";
  }

  function closeThread() {
    threadCard.classList.remove("visible");
    threadIdx = null;
  }
  document.getElementById("thread-close").onclick = closeThread;

  // Drag the thread card by its header so it doesn't stay anchored over what
  // you're working on. Clamped to stay fully on-screen.
  (function makeThreadDraggable() {
    const head = threadCard.querySelector(".thread-head");
    if (!head) return;
    let dragging = false, offX = 0, offY = 0;
    head.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".thread-close")) return;
      const r = threadCard.getBoundingClientRect();
      dragging = true; offX = e.clientX - r.left; offY = e.clientY - r.top;
      head.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const r = threadCard.getBoundingClientRect();
      let left = e.clientX - offX, top = e.clientY - offY;
      left = Math.max(12, Math.min(left, window.innerWidth - r.width - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - r.height - 12));
      threadCard.style.left = left + "px";
      threadCard.style.top = top + "px";
      threadMoved = true;
      threadCard.classList.add("moved");
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; head.classList.remove("dragging");
    });
  })();

  document.getElementById("thread-reply-btn").onclick = async () => {
    if (threadIdx === null) return;
    const input = document.getElementById("thread-reply-input");
    const msg = input.value.trim();
    if (!msg) return;
    const f = findingsData[threadIdx];
    if (!f.replies) f.replies = [];
    f.replies.push({ author: commentAuthor, authorType: "person", message: msg, at: new Date().toISOString() });
    await saveFindings();
    renderFindings();
    openThread(threadIdx); // re-render thread
  };
  document.getElementById("thread-reply-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.getElementById("thread-reply-btn").click(); }
  });

  // "Pedir a Claude" — turn this comment into a task for the active tab's
  // terminal: open it, type a ready instruction (element + the note + a request
  // to reply via ohana_reply when done), and let you review before pressing Enter.
  document.getElementById("thread-fix").onclick = () => {
    if (threadIdx === null) return;
    const f = findingsData[threadIdx];
    const at = activeTab();
    if (!f || !at) return;
    const pinNum = computePinNum(threadIdx);
    const sel = (f.anchor && f.anchor.aiId) ? '[data-ai-id="' + f.anchor.aiId + '"]'
      : (f.anchor && f.anchor.selector) ? f.anchor.selector
      : ((f.anchor && f.anchor.label) || f.component || "");
    const note = (f.message || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    const prompt = "Address this Ohana comment"
      + (sel ? " on the element `" + sel + "`" : "")
      + ': "' + note + '".'
      + (pinNum ? " When you're done, reply to comment #" + pinNum + " with the ohana_reply tool (resolve it if it's ready)." : "");
    if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
    setTimeout(() => window.api.termInput({ tabKey: at.key, data: prompt }), 280);
    showToast("Sent to the terminal — review and hit Enter", "check");
  };

  // Reusable comment actions — shared by the thread card AND the per-item
  // quick actions in the comments panel.
  async function setFindingResolved(idx, resolved) {
    const f = findingsData[idx]; if (!f) return;
    f.status = resolved ? "resolved" : "open";
    f.statusAt = new Date().toISOString();
    await saveFindings();
    renderFindings();
    syncPins();
  }
  async function deleteFinding(idx) {
    if (idx == null || idx < 0 || !findingsData[idx]) return;
    findingsData.splice(idx, 1);
    await saveFindings();
    renderFindings();
    syncPins();
    showToast("Comment deleted", "check");
  }

  document.getElementById("thread-resolve").onclick = async () => {
    if (threadIdx === null) return;
    const f = findingsData[threadIdx];
    await setFindingResolved(threadIdx, f.status !== "resolved");
    openThread(threadIdx);
  };

  document.getElementById("thread-delete").onclick = async () => {
    if (threadIdx === null) return;
    await deleteFinding(threadIdx);
    closeThread();
  };

  // Wire the toolbar comment button
  document.getElementById("btn-comment").onclick = toggleCommentMode;

  // ════════════════════════════════════════════════════════════════════
  //  Design Notes (design.md) — the design source of truth, edited in
  //  Ohana and maintained by Claude. Lives next to the prototype.
  // ════════════════════════════════════════════════════════════════════
  let designVisible = false;
  let designMode = "preview"; // "preview" | "edit"
  let designDirty = false;
  const designPanel = document.getElementById("design-panel");
  const dpPreview = document.getElementById("dp-preview");
  const dpEditor = document.getElementById("dp-editor");
  const dpPath = document.getElementById("dp-path");
  const dpSave = document.getElementById("dp-save");

  // Panels float ON TOP of the canvas now — the webview is never resized.
  // Docking layout: panels claim edges and the webview shrinks to fit, so
  // nothing overlaps and nothing covers the preview (VS Code-style).
  // ─── Panel dock (resizable + reorderable) ───
  // All open side panels stack vertically in one right column. The column width
  // (horizontal resize), each panel's share of the height (vertical resize via
  // dividers), and the stacking order (drag a grip) are all user-adjustable and
  // persisted. adjustPanelsMargin() is the single layout authority.
  // One vertical rhythm for everything: panels, nav and the content viewport all
  // span from CANVAS_TOP to DOCK_GAP off the bottom, so their heights match.
  const DOCK_GAP = 8, CANVAS_TOP = 48, DOCK_TOP = 48, DOCK_BOTTOM = 8;
  const ALL_PANEL_IDS = ["findings-panel", "design-panel", "inspector-panel", "context-panel", "components-panel", "network-panel", "term-panel"];
  const PANEL_MIN_H = 90;
  function clampColW(w) {
    const max = Math.max(320, Math.round(window.innerWidth * 0.72));
    return Math.max(280, Math.min(w || 360, max));
  }
  let panelColW = clampColW(parseInt(localStorage.getItem("ohana.panelColW"), 10) || 360);
  let panelOrder = (function () {
    try { const a = JSON.parse(localStorage.getItem("ohana.panelOrder")); if (Array.isArray(a)) return a; } catch (e) {}
    return ALL_PANEL_IDS.slice();
  })();
  let panelFlex = (function () {
    try { return JSON.parse(localStorage.getItem("ohana.panelFlex")) || {}; } catch (e) { return {}; }
  })();
  let _dockPanelRight = DOCK_BOTTOM; // updated each layout (accounts for right toolbar)
  dockReady = true; // dock state is now initialized — safe to call adjustPanelsMargin
  function persistDock() {
    try {
      localStorage.setItem("ohana.panelColW", String(panelColW));
      localStorage.setItem("ohana.panelOrder", JSON.stringify(panelOrder));
      localStorage.setItem("ohana.panelFlex", JSON.stringify(panelFlex));
    } catch (e) {}
  }
  function orderedVisiblePanels() {
    const order = panelOrder.filter((id) => ALL_PANEL_IDS.includes(id));
    ALL_PANEL_IDS.forEach((id) => { if (!order.includes(id)) order.push(id); });
    panelOrder = order;
    return order.map((id) => document.getElementById(id)).filter((el) => el && el.classList.contains("visible"));
  }

  function adjustPanelsMargin() {
    const els = orderedVisiblePanels();
    // In a constrained breakpoint the webview is a fixed-width centered device
    // frame (managed by applyBreakpoint), so we DON'T inset it for the panels —
    // but the panel dock (layout + resize/reorder handles) still works the same.
    const constrained = !!(currentBP && currentBP.width);
    const tbReserve = (typeof currentTBPos !== "undefined" && currentTBPos === "right" && toolbar)
      ? toolbar.offsetWidth + 12 : 0;
    const panelRight = DOCK_BOTTOM + tbReserve;
    _dockPanelRight = panelRight;
    const colW = (panelColW = clampColW(panelColW));
    // Left rail inset (floating nav): its left gap + width + gap. Persistent in
    // every mode, so the content viewport (preview AND Moka) starts to its right.
    // Presentation mode: no nav, no panels — the content takes the full frame.
    const presentingNow = document.body.classList.contains("presenting");
    const navAvail = !presentingNow && document.body.classList.contains("nav-avail");
    const navW = document.body.classList.contains("nav-collapsed") ? 44 : 240;
    const contentLeft = navAvail ? (DOCK_GAP + navW + DOCK_GAP) : DOCK_GAP;
    const wr = (els.length && !presentingNow) ? panelRight + colW + DOCK_GAP : DOCK_GAP;

    // Webview inset — only in Responsive (the right column shrinks the preview).
    if (!constrained) {
      if (webview) {
        webview.style.left = contentLeft + "px"; webview.style.right = wr + "px";
        webview.style.top = CANVAS_TOP + "px"; webview.style.bottom = DOCK_GAP + "px";
        webview.style.borderRadius = "14px";
      }
      inspectOverlay.style.left = contentLeft + "px"; inspectOverlay.style.right = wr + "px"; inspectOverlay.style.top = CANVAS_TOP + "px"; inspectOverlay.style.bottom = DOCK_GAP + "px";
    }

    // Moka shares the SAME viewport rect (rounded, inset by nav + panels) so it
    // reads as the same container as the preview — never covering the left rail.
    const overlay = (typeof flowCanvas !== "undefined" && flowCanvas.classList.contains("visible")) ? flowCanvas : null;
    if (overlay) { overlay.style.left = contentLeft + "px"; overlay.style.right = wr + "px"; overlay.style.top = CANVAS_TOP + "px"; overlay.style.bottom = DOCK_GAP + "px"; }

    // The preview loader centers on the VISIBLE viewport rect (same insets as the
    // webview), never on the whole window — so the bento never looks off-center.
    const pl = document.getElementById("preview-loader");
    if (pl) { pl.style.left = contentLeft + "px"; pl.style.right = wr + "px"; pl.style.top = CANVAS_TOP + "px"; pl.style.bottom = DOCK_GAP + "px"; }
    // The .md reader is a first-class viewport too: the right panels push it
    // exactly like they push the preview and Moka.
    const rd = document.getElementById("proj-reader");
    if (rd) { rd.style.left = contentLeft + "px"; rd.style.right = wr + "px"; rd.style.top = CANVAS_TOP + "px"; rd.style.bottom = DOCK_GAP + "px"; }

    // Stack the open panels vertically, sized by their weights (ALWAYS).
    if (els.length) {
      const colTop = DOCK_TOP;
      const colH = window.innerHeight - colTop - DOCK_BOTTOM;
      const n = els.length;
      const avail = colH - (n - 1) * DOCK_GAP;
      const weights = els.map((el) => Math.max(0.2, panelFlex[el.id] || 1));
      const W = weights.reduce((a, b) => a + b, 0) || 1;
      let y = colTop;
      els.forEach((el, i) => {
        let h = (i === n - 1) ? (colTop + colH - y) : Math.round(avail * weights[i] / W);
        h = Math.max(PANEL_MIN_H, h);
        el.style.right = panelRight + "px";
        el.style.left = "auto";
        el.style.width = colW + "px";
        el.style.top = y + "px";
        el.style.height = h + "px";
        el.style.bottom = "auto";
        y += h + DOCK_GAP;
      });
    }
    layoutDockHandles(els);

    // Keep the floating toolbar from overlapping the panel column. The
    // centered (top/bottom) positions get re-centered over the VISIBLE canvas
    // (left of the panels); left/right edges are already handled (right reserves
    // toolbar width via tbReserve).
    // Center the bottom toolbar over the VISIBLE viewport (between the left nav
    // and the right panels), not the whole window.
    if (toolbar) {
      const rightEdge = els.length ? (window.innerWidth - panelRight - colW) : window.innerWidth;
      toolbar.style.left = ((contentLeft + rightEdge) / 2) + "px";
    }

    if (typeof termVisible !== "undefined" && termVisible && typeof activeTermInstance === "function") {
      const inst = activeTermInstance();
      if (inst) setTimeout(() => { try { inst.fitAddon.fit(); termSendResizeFor(inst); } catch (e) {} }, 40);
    }
  }

  // Lazily-created handle pool: 1 width bar + (N-1) dividers + N grips.
  let _dock = null;
  function ensureDock() {
    if (_dock) return _dock;
    const shield = document.createElement("div"); shield.id = "drag-shield"; document.body.appendChild(shield);
    const wh = document.createElement("div"); wh.className = "dock-h dock-wh"; document.body.appendChild(wh);
    const dividers = [], grips = [];
    for (let i = 0; i < ALL_PANEL_IDS.length - 1; i++) { const d = document.createElement("div"); d.className = "dock-h dock-dv"; document.body.appendChild(d); dividers.push(d); }
    for (let i = 0; i < ALL_PANEL_IDS.length; i++) { const g = document.createElement("div"); g.className = "dock-grip"; g.title = "Drag to reorder"; document.body.appendChild(g); grips.push(g); }
    _dock = { shield, wh, dividers, grips };
    wireDockHandles(_dock);
    return _dock;
  }

  function layoutDockHandles(els) {
    const d = ensureDock();
    const show = (el, on) => el.classList.toggle("show", !!on);
    const n = els ? els.length : 0;
    if (!n) { show(d.wh, false); d.dividers.forEach((x) => show(x, false)); d.grips.forEach((x) => show(x, false)); return; }
    const colLeft = window.innerWidth - _dockPanelRight - panelColW;
    const colTop = DOCK_TOP, colBottom = window.innerHeight - DOCK_BOTTOM;
    // Width handle on the column's left edge.
    show(d.wh, true);
    d.wh.style.left = (colLeft - 5) + "px"; d.wh.style.top = colTop + "px";
    d.wh.style.width = "10px"; d.wh.style.height = (colBottom - colTop) + "px";
    // Dividers in each gap; grips at each panel's top-left.
    d.dividers.forEach((dv, i) => {
      if (i < n - 1) {
        const a = els[i], b = els[i + 1];
        const r = a.getBoundingClientRect();
        show(dv, true);
        dv.style.left = colLeft + "px"; dv.style.width = panelColW + "px";
        dv.style.top = (r.bottom + DOCK_GAP / 2 - 5) + "px"; dv.style.height = "10px";
        dv.dataset.aboveId = a.id; dv.dataset.belowId = b.id;
      } else { show(dv, false); }
    });
    d.grips.forEach((g, i) => {
      if (i < n && n > 1) {
        const el = els[i]; const r = el.getBoundingClientRect();
        show(g, true);
        g.style.position = "fixed"; g.style.zIndex = 201;
        // Centered pill spanning the top edge of the panel header (clear of the
        // left icon and the right close button).
        const w = 70;
        g.style.width = w + "px"; g.style.height = "16px";
        g.style.left = (r.left + (panelColW - w) / 2) + "px"; g.style.top = (r.top + 3) + "px";
        g.dataset.panelId = el.id;
      } else { show(g, false); }
    });
  }

  function wireDockHandles(d) {
    const beginDrag = (cls, target, onMove) => {
      d.shield.classList.add("active");
      if (target) target.classList.add("drag");
      const move = (e) => onMove(e);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        d.shield.classList.remove("active");
        if (target) target.classList.remove("drag");
        persistDock();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
    // Width
    d.wh.addEventListener("mousedown", (e) => {
      e.preventDefault();
      beginDrag("wh", d.wh, (ev) => {
        panelColW = clampColW(window.innerWidth - _dockPanelRight - ev.clientX);
        adjustPanelsMargin();
      });
    });
    // Dividers (height split between two adjacent panels)
    d.dividers.forEach((dv) => {
      dv.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const aId = dv.dataset.aboveId, bId = dv.dataset.belowId;
        // Freeze ALL visible panels' weights to their current pixel heights so the
        // ratios stay stable while we shift just these two.
        const visible = orderedVisiblePanels();
        visible.forEach((el) => { panelFlex[el.id] = el.getBoundingClientRect().height; });
        const startY = e.clientY;
        const a0 = panelFlex[aId], b0 = panelFlex[bId];
        beginDrag("dv", dv, (ev) => {
          let delta = ev.clientY - startY;
          let na = a0 + delta, nb = b0 - delta;
          if (na < PANEL_MIN_H) { nb -= (PANEL_MIN_H - na); na = PANEL_MIN_H; }
          if (nb < PANEL_MIN_H) { na -= (PANEL_MIN_H - nb); nb = PANEL_MIN_H; }
          panelFlex[aId] = na; panelFlex[bId] = nb;
          adjustPanelsMargin();
        });
      });
    });
    // Grips (reorder the stack)
    d.grips.forEach((g) => {
      g.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const dragId = g.dataset.panelId;
        g.classList.add("drag");
        beginDrag("grip", g, (ev) => {
          const visible = orderedVisiblePanels();
          // Which visible panel is the pointer over?
          let targetId = null;
          for (const el of visible) {
            const r = el.getBoundingClientRect();
            if (ev.clientY >= r.top && ev.clientY <= r.bottom) { targetId = el.id; break; }
          }
          if (!targetId || targetId === dragId) return;
          // Move dragId to just before targetId in the full order.
          const ord = panelOrder.slice();
          ord.splice(ord.indexOf(dragId), 1);
          ord.splice(ord.indexOf(targetId), 0, dragId);
          panelOrder = ord;
          adjustPanelsMargin();
        });
      });
    });
    // Keep the dock laid out on window resize.
    window.addEventListener("resize", () => { panelColW = clampColW(panelColW); adjustPanelsMargin(); });
  }
  const termPanelEl = document.getElementById("term-panel");

  function toggleDesign() {
    designVisible = !designVisible;
    designPanel.classList.toggle("visible", designVisible);
    const b = document.getElementById("btn-design"); if (b) b.classList.toggle("active", designVisible); // header button removed — design.md lives in the left navigator
    if (designVisible) loadDesign();
    adjustPanelsMargin();
  }

  async function loadDesign() {
    const res = await window.api.designRead();
    dpPath.textContent = res.path || "";
    if (!res.exists) {
      designPanel.classList.add("empty");
      dpEditor.value = "";
      dpPreview.innerHTML = "";
      return;
    }
    designPanel.classList.remove("empty");
    dpEditor.value = res.content;
    dpPreview.innerHTML = renderMarkdown(res.content);
    designDirty = false;
    dpSave.style.display = "none";
  }

  function setDesignMode(mode) {
    designMode = mode;
    designPanel.classList.toggle("mode-edit", mode === "edit");
    document.getElementById("dp-tab-preview").classList.toggle("active", mode === "preview");
    document.getElementById("dp-tab-edit").classList.toggle("active", mode === "edit");
    if (mode === "preview") {
      // refresh preview from editor content
      dpPreview.innerHTML = renderMarkdown(dpEditor.value);
    } else {
      setTimeout(() => dpEditor.focus(), 0);
    }
  }

  async function saveDesign() {
    const ok = await window.api.designWrite(dpEditor.value);
    if (ok) {
      designDirty = false;
      dpSave.style.display = "none";
      dpPreview.innerHTML = renderMarkdown(dpEditor.value);
      showToast("design.md saved", "check");
    } else {
      showToast("Could not save design.md", "warn");
    }
  }

  document.getElementById("dp-close").onclick = toggleDesign;
  document.getElementById("dp-tab-preview").onclick = () => setDesignMode("preview");
  document.getElementById("dp-tab-edit").onclick = () => setDesignMode("edit");
  document.getElementById("dp-save").onclick = saveDesign;
  document.getElementById("dp-create").onclick = async () => {
    const content = await window.api.designCreate();
    if (content != null) {
      designPanel.classList.remove("empty");
      dpEditor.value = content;
      dpPreview.innerHTML = renderMarkdown(content);
      setDesignMode("edit");
    }
  };
  dpEditor.addEventListener("input", () => {
    designDirty = true;
    dpSave.style.display = "inline-flex";
  });
  dpEditor.addEventListener("keydown", (e) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveDesign(); }
  });
  // Open external links from the rendered markdown in the system browser
  dpPreview.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-href]");
    if (!a) return;
    e.preventDefault();
    window.api.openExternal(a.dataset.href);
  });

  window.api.on("tools:toggleDesign", toggleDesign);
  window.api.on("design:updated", (content) => {
    // Tokens come from design.md → keep the inspector's token list current.
    designTokens = parseDesignTokens(content);
    if (inspectorPanel.classList.contains("visible")) renderTokenPalette();
    // External edit (e.g. Claude). Refresh unless the user is mid-edit with unsaved changes.
    if (!designVisible) return;
    if (designMode === "edit" && designDirty) {
      showToast("design.md changed on disk", "warn");
      return;
    }
    designPanel.classList.remove("empty");
    dpEditor.value = content;
    dpPreview.innerHTML = renderMarkdown(content);
    if (designMode === "preview") showToast("Design updated", "check");
  });

  // ── Tiny markdown renderer (headings, lists, tables, code, quotes, links) ──
  // escMd / inlineMd / cellWithSwatch / highlightCode / renderMarkdown → src/lib/markdown.js (window.OhanaMD)
  // Listen for external findings updates (Claude writing to findings.json)
  window.api.on("ohana:findingsUpdated", (content) => {
    try {
      findingsData = JSON.parse(content);
      diffAndNotifyFindings(); // targeted toast/notification on new agent replies
      renderFindings();
      syncPins();
      // If the thread card is open, refresh it (Claude may have replied)
      if (threadIdx !== null && threadCard.classList.contains("visible")) openThread(threadIdx);
    } catch (e) {}
  });

  window.api.on("tools:toggleFindings", toggleFindings);
  window.api.on("tools:toggleComment", toggleCommentMode);

  // Listen for commands from Claude
  window.api.on("ohana:commandsUpdated", processCommands);

  // ─── Copy helpers ───
  async function copyURL() {
    const at = activeTab();
    if (at && (at.kind === "url" || at.kind === "repo")) {
      await window.api.copyText(at.src);
      showToast("URL copied", "check");
      return;
    }
    if (!currentFilePath) return showToast("No file loaded", "warn");
    await window.api.copyText("file://" + currentFilePath);
    showToast("URL copied", "check");
  }

  async function copyFullHTML() {
    if (sectionMode) exitSectionMode();
    const html = await window.api.getHTML();
    if (html) { await window.api.copyText(html); showToast("Full HTML copied", "check"); }
    else showToast("No file loaded", "warn");
  }

  // ─── Toast ───
  let toastTimeout;
  function showToast(msg, type) {
    const toast = document.getElementById("toast");
    const icon = toast.querySelector("svg");
    document.getElementById("toast-text").textContent = msg;
    icon.className = type === "warn" ? "t-warn" : "t-check";
    toast.classList.add("visible");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("visible"), 2200);
  }

  function setConnected(on) {
    liveDot.classList.toggle("off", !on);
    infoDot.classList.toggle("off", !on);
    infoStatus.textContent = on ? "Watching" : "No file";
  }

  // ─── Repo Mode ───
  let repoMode = false;
  let repoUrl = null;

  // ── Run dialog: choose the command + URL before launching a repo ──
  let rdDir = null, rdInfo = null;
  function rdCommandFor(info, script) {
    return info.pkgManager === "npm" ? "npm run " + script : info.pkgManager + " " + script;
  }
  function rdGuessUrl(info, script) {
    const proto = info.framework === "rsbuild" ? "https" : "http";
    let port = info.port || 5173;
    if (/storybook/.test(script || "")) port = 6006;
    return proto + "://localhost:" + port;
  }
  function openRunDialog(dir, info) {
    rdDir = dir; rdInfo = info;
    document.getElementById("rd-name").textContent = info.name + " · " + info.framework;
    const script = info.devScript || (info.scripts && info.scripts[0]) || "dev";
    document.getElementById("rd-command").value = rdCommandFor(info, script);
    document.getElementById("rd-url").value = rdGuessUrl(info, script);
    const chips = document.getElementById("rd-scripts");
    chips.innerHTML = "";
    (info.scripts || []).forEach((s) => {
      const b = document.createElement("button"); b.className = "rd-chip"; b.textContent = s;
      b.onclick = () => {
        document.getElementById("rd-command").value = rdCommandFor(info, s);
        document.getElementById("rd-url").value = rdGuessUrl(info, s);
      };
      chips.appendChild(b);
    });
    document.getElementById("run-dialog").classList.add("visible");
    setTimeout(() => document.getElementById("rd-command").focus(), 0);
  }
  function closeRunDialog() { document.getElementById("run-dialog").classList.remove("visible"); }
  document.getElementById("rd-close").onclick = closeRunDialog;
  document.getElementById("run-dialog").addEventListener("mousedown", (e) => { if (e.target.id === "run-dialog") closeRunDialog(); });

  document.getElementById("rd-connect").onclick = async () => {
    const url = normalizeURL(document.getElementById("rd-url").value);
    if (!url) return;
    closeRunDialog();
    await window.api.repoConnectExisting({ dir: rdDir, url });
    openRepoTab(rdDir, url);
    showToast("Connected to " + url, "check");
  };

  document.getElementById("rd-run").onclick = async () => {
    const command = document.getElementById("rd-command").value.trim();
    const url = normalizeURL(document.getElementById("rd-url").value);
    if (!command) return;
    closeRunDialog();
    const loadingEl = document.getElementById("repo-loading");
    const statusEl = document.getElementById("repo-status-text");
    const subEl = document.getElementById("repo-sub-text");
    loadingEl.classList.add("active");
    statusEl.textContent = "Running " + (rdInfo ? rdInfo.name : "") + "…";
    subEl.textContent = command;
    try {
      const result = await window.api.repoStart({ dir: rdDir, command, url });
      if (result.error) { loadingEl.classList.remove("active"); showToast("Failed: " + result.error, "warn"); return; }
      statusEl.textContent = "Ready"; subEl.textContent = result.url;
      openRepoTab(rdDir, result.url, command);
      setTimeout(() => loadingEl.classList.remove("active"), 500);
      showToast("Repo loaded — " + result.url, "check");
    } catch (err) {
      loadingEl.classList.remove("active");
      showToast("Couldn't start the server", "warn");
    }
  };

  let hmrDebounce = null;

  function buildURLWebview(t) {
    const wv = newWebviewEl();
    const isRepo = t.kind === "repo";
    wv.src = t.src;

    wv.addEventListener("did-fail-load", (e) => {
      console.error("Webview load failed:", e.errorCode, e.errorDescription, e.validatedURL);
      if (e.errorCode === -3) return; // Aborted (normal during HMR)
      wv._failedLoad = true; // the error page will fire did-finish-load/dom-ready — don't read those as success
      if (wv === webview) showPreviewError(t, e.errorDescription);
      // Dev servers come and go (session restore races them, restarts, crashes):
      // for connection-type failures keep knocking every few seconds while the
      // tab lives, so the preview self-heals the moment the server answers.
      const transient = [-2, -101, -102, -104, -105, -106, -118, -324].includes(e.errorCode);
      if (!transient) return;
      t.wvFailed = true;
      t._wvRetries = (t._wvRetries || 0) + 1;
      if (t._wvRetries > 80) return; // ~4 min — beyond any dev server boot
      // reload() on a never-committed navigation is a no-op — rebuild the
      // element so the retry actually re-navigates.
      clearTimeout(t._wvRetryTimer);
      t._wvRetryTimer = setTimeout(() => {
        if (t.wv !== wv) return;
        try { wv.remove(); } catch (err) {}
        t.wv = null; t.wvReady = false;
        if (webview === wv) mountWebview(t); // active tab → remount visibly
        else { t.wv = buildURLWebview(t); t.wv.classList.add("wv-hidden"); canvas.appendChild(t.wv); }
      }, 3000);
      const msg = document.getElementById("preview-error-msg");
      if (wv === webview && msg && !/Retrying/.test(msg.textContent)) msg.textContent += " Retrying automatically…";
      // A dev server launched BY Ohana is a child process — it dies with the
      // app, so a restored repo tab points at a dead localhost. Relaunch the
      // SAME server it had (remembered command; for older sessions, infer:
      // port 6006 → storybook script) and let the retry loop reconnect.
      if (t.kind === "repo" && t.dir && !t._devAutoStart) {
        t._devAutoStart = true;
        if (wv === webview) showToast("Bringing up the dev server…", "refresh-cw");
        const startP = t.devCommand
          ? window.api.repoStart({ dir: t.dir, command: t.devCommand, url: t.src })
          : window.api.repoDetect(t.dir).then((info) => {
              if (!info) return null;
              let script = info.devScript;
              const port = (t.src.match(/:(\d+)/) || [])[1];
              if (port === "6006") { const sb = (info.scripts || []).find((s) => /storybook/i.test(s)); if (sb) script = sb; }
              return script ? window.api.repoStart({ dir: t.dir, url: t.src, script }) : null;
            });
        startP.then((r) => {
          if (!r || !r.url) return;
          if (r.command && !t.devCommand) { t.devCommand = r.command; saveSession(); } // learned — next restore skips the guess
          if (r.url !== t.src) {
            t.src = r.url; t.repoUrl = r.url;
            if (t.wv) { try { t.wv.remove(); } catch (err) {} t.wv = null; t.wvReady = false; }
            if (activeTab() === t) mountWebview(t);
          }
        }).catch(() => {});
      }
    });
    wv.addEventListener("did-finish-load", () => {
      // A failed navigation COMMITS chrome-error://chromewebdata and then fires
      // did-finish-load — that's not a success; keep the retry loop alive.
      let u = ""; try { u = wv.getURL() || ""; } catch (e) {}
      if (wv._failedLoad || /^chrome-error:/.test(u)) { wv._failedLoad = false; return; }
      t.wvFailed = false; t._wvRetries = 0; clearTimeout(t._wvRetryTimer);
    });

    wv.addEventListener("dom-ready", () => {
      // dom-ready also fires for the committed error page — a tab must not be
      // marked ready (nor hide its error overlay) for chrome-error content.
      let u = ""; try { u = wv.getURL() || ""; } catch (e) {}
      if (wv._failedLoad || /^chrome-error:/.test(u)) return;
      t.wvReady = true;
      try { t.wcId = wv.getWebContentsId(); } catch (e) {} // per-tab network capture key
      if (wv === webview) { hidePreviewError(); hidePreviewLoader(); }
      wv.executeJavaScript(INSPECTOR_SCRIPT).catch(() => {});
      // Inject comment pins (delay for React hydration)
      setTimeout(() => { wv.executeJavaScript(PINS_SCRIPT).then(() => { if (wv === webview) syncPins(); }).catch(() => {}); }, isRepo ? 1500 : 0);
      if (wv !== webview) return;
      webviewReady = true;
      syncInspectorVisual();
      updateZoom();

      wv.executeJavaScript(`
        document.documentElement.scrollWidth + '\u00d7' + document.documentElement.scrollHeight
      `).then(size => {
        document.getElementById("bp-size-label").textContent =
          currentBP.width ? currentBP.width + "px" : size;
      }).catch(() => {});
    });

    // Detect HMR updates from console messages (RSBuild, Vite, Webpack)
    wv.addEventListener("console-message", (e) => {
      if (!isRepo) return;
      const msg = e.message || "";
      if (
        msg.includes("[HMR]") ||
        msg.includes("[hmr]") ||
        msg.includes("hmr update") ||
        msg.includes("[vite] hot updated") ||
        msg.includes("hot module replacement")
      ) {
        clearTimeout(hmrDebounce);
        hmrDebounce = setTimeout(() => {
          wv.executeJavaScript(PINS_SCRIPT).then(() => { if (wv === webview) syncPins(); }).catch(() => {});
        }, 800);
      }
    });

    // Re-inject comment pins on HMR/navigation (DOM rebuilds)
    wv.addEventListener("did-navigate", () => {
      wv.executeJavaScript(INSPECTOR_SCRIPT).catch(() => {});
      wv.executeJavaScript(PINS_SCRIPT).then(() => { if (wv === webview) syncPins(); }).catch(() => {});
      if (wv === webview) syncInspectorVisual();
    });
    wv.addEventListener("did-navigate-in-page", () => {
      wv.executeJavaScript(INSPECTOR_SCRIPT).catch(() => {});
      if (wv === webview) syncInspectorVisual();
      if (isRepo) {
        // SPA navigation in React — re-render comment pins
        clearTimeout(hmrDebounce);
        hmrDebounce = setTimeout(() => { wv.executeJavaScript(PINS_SCRIPT).then(() => { if (wv === webview) syncPins(); }).catch(() => {}); }, 500);
      }
    });

    setConnected(true);
    liveDot.classList.remove("off");
    return wv;
  }

  // Listen for repo ready event
  window.api.on("repo:ready", (data) => {
    repoMode = true;
    repoUrl = data.url;
  });

  // Reload webview (Cmd+R)
  // Reload ONLY the active tab's webview. Capture it in a local so a tab switch
  // mid-reload can't redirect the post-reload work to another tab. The webview's
  // OWN dom-ready handler re-injects inspector + pins (gated on being active).
  window.api.on("repo:reloadWebview", () => {
    const wv = webview;
    if (!wv || !webviewReady) return;
    showToast("Reloading...", "refresh-cw");
    wv.reload();
  });

  // Hard reload — clear cache + reload, active tab only (Cmd+Shift+R)
  window.api.on("repo:hardReload", () => {
    const wv = webview;
    if (!wv || !webviewReady) return;
    showToast("Hard reload...", "refresh-cw");
    wv.reloadIgnoringCache();
  });

  // Listen for source file changes (React HMR trigger)
  let sourceChangeDebounce = null;
  window.api.on("repo:sourceChanged", (data) => {
    const wv = webview;
    if (!repoMode || !wv || !webviewReady) return;
    // HMR will rebuild the DOM. Wait for it, then re-render comment pins — on the
    // captured webview, and only if it's still the active tab (no cross-tab).
    clearTimeout(sourceChangeDebounce);
    sourceChangeDebounce = setTimeout(() => {
      wv.executeJavaScript(PINS_SCRIPT).then(() => { if (wv === webview) syncPins(); }).catch(() => {});
    }, 1200);
  });

  // ─── Button bindings ───
  document.getElementById("btn-open").onclick = () => openOpenDialog();
  document.getElementById("btn-empty-open").onclick = () => openOpenDialog();
  document.getElementById("btn-empty-tutorial").onclick = () => window.api.openOnboarding();
  document.getElementById("btn-inspector").onclick = toggleInspector;

  // ─── Unified "Open" modal — URL vs File/Folder ───
  const openDialogEl = document.getElementById("open-dialog");
  const odUrlInput = document.getElementById("od-url-input");
  function openOpenDialog() {
    openDialogEl.classList.add("visible");
    openDialogEl.classList.remove("url-mode");
    setTimeout(() => document.getElementById("od-file").focus(), 0);
  }
  function closeOpenDialog() { openDialogEl.classList.remove("visible", "url-mode"); }
  document.getElementById("od-url").onclick = () => {
    openDialogEl.classList.add("url-mode");
    const at = activeTab();
    odUrlInput.value = (at && (at.kind === "url" || at.kind === "repo")) ? at.src : "localhost:3000";
    setTimeout(() => { odUrlInput.focus(); odUrlInput.select(); }, 0);
  };
  odUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const v = odUrlInput.value; closeOpenDialog(); if (v.trim()) openFromURL(v); }
    if (e.key === "Escape") { e.preventDefault(); closeOpenDialog(); }
  });
  document.getElementById("od-file").onclick = async () => {
    closeOpenDialog();
    const r = await window.api.openFileOrFolder();
    if (!r) return;
    if (r.kind === "folder") {
      // A folder is ALWAYS a project workspace (flows/prototypes/handoff/design).
      // Running its dev server as a localhost repo is the explicit «Repo» option —
      // opening a folder must never force the run dialog.
      startNewPrototype(r.path);
    } else if (r.kind === "file") {
      // main already emitted file:load → the tab opens itself
    } else {
      showToast("Choose an .html file or a folder", "warn");
    }
  };
  // «Repo»: pick a folder with a dev server and run/connect it (localhost, blue tab).
  document.getElementById("od-repo").onclick = async () => {
    closeOpenDialog();
    const dir = await window.api.pickFolder();
    if (!dir) return;
    const info = await window.api.repoDetect(dir);
    if (!info) { showToast("That folder has no package.json — open it as a Project", "warn"); return; }
    openRunDialog(dir, info);
  };
  openDialogEl.addEventListener("mousedown", (e) => { if (e.target === openDialogEl) closeOpenDialog(); });
  window.api.on("view:openDialog", openOpenDialog);

  // Open a folder as a PROJECT tab (workspace). Its artifacts live in the left
  // navigator; there's no guidance panel — you create things with the nav's «+».
  async function startNewPrototype(dir) {
    const name = (dir.split("/").pop() || "Project");
    // Scaffold the workspace structure once (prototypes/ plans/ handoff/ design/
    // + .ohana/ for flows) so every artifact has a home from the start.
    try { await window.api.projectInit(dir); } catch (e) {}
    upsertTab({ key: "new:" + dir, kind: "new", src: dir, dir: dir, name: name });
    activateTab("new:" + dir);
    window.api.tabSyncContext({ kind: "none", dir: dir, url: null, src: dir });
  }
  // Empty project view: just the canvas + the left navigator (no webview).
  function showNewProto(t) {
    emptyState.classList.add("hidden"); showUI();
    tabs.forEach((x) => { if (x.wv) x.wv.classList.add("wv-hidden"); });
    webview = null; webviewReady = false;
    hideProjReader();
  }
  document.getElementById("btn-screenshot").onclick = takeFullScreenshot;
  document.getElementById("btn-section-screenshot").onclick = () => enterSectionMode("screenshot");
  document.getElementById("btn-copy-section-html").onclick = () => enterSectionMode("copyhtml");
  document.getElementById("btn-copy-full-html").onclick = copyFullHTML;
  // btn-orient removed — replaced by tb-settings position presets

  // ─── A11y: give icon-only buttons an accessible name ───
  // Toolbar buttons are icon-only; their visible tooltip lives in data-tip.
  // Mirror it into aria-label (minus the keyboard shortcut) so screen
  // readers announce a meaningful name. WCAG 4.1.2 (Name, Role, Value).
  document.querySelectorAll("[data-tip]").forEach((btn) => {
    if (btn.getAttribute("aria-label")) return;
    // Strip trailing shortcut glyphs (⌘ ⇧ ⌥ ⌃ and following keys)
    const label = btn.dataset.tip.replace(/\s{2,}[⌘⇧⌥⌃].*$/, "").trim();
    if (label) btn.setAttribute("aria-label", label);
  });

  document.getElementById("tb-zoom-in").onclick = zoomIn;
  document.getElementById("tb-zoom-out").onclick = zoomOut;
  zoomDisplay.addEventListener("dblclick", zoomReset);

  // ─── IPC from main process ───
  window.api.on("file:load", (data) => {
    // An .html ALWAYS opens inside its folder's project (left navigator visible),
    // as the Prototipo artifact — bare file tabs without a workspace no longer
    // exist. (Applies to open dialog, drag&drop, file associations and links.)
    const dir = data.dir, key = "new:" + dir;
    const old = findTab(data.path); // legacy file-tab for this same html (old sessions)
    if (old && old.kind === "file") { tabs = tabs.filter((x) => x !== old); if (old.wv) old.wv.remove(); }
    if (!findTab(key)) upsertTab({ key, kind: "new", src: dir, dir: dir, name: dir.split("/").pop() || "Project" });
    activateTab(key);
    window.api.tabSyncContext({ kind: "none", dir: dir, url: null, src: dir });
    openPrototypeArtifact(findTab(key), data.path);
  });
  window.api.on("file:reload", (data) => {
    currentFilePath = data.path;
    reloadWebview(data.path);
    flashPreview(); // visual "something changed" cue over the preview
    const changed = data.changedFile ? data.changedFile.split("/").pop() : null;
    showToast(changed ? "Updated · " + changed : "Updated", "refresh-cw");
  });

  // Brief accent ring over the preview so you notice a change landed.
  function flashPreview() {
    if (!webview) return;
    try {
      const r = webview.getBoundingClientRect();
      if (!r.width) return;
      const fl = document.createElement("div");
      fl.className = "reload-flash";
      fl.style.cssText = "left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;";
      document.body.appendChild(fl);
      setTimeout(() => { if (fl.parentNode) fl.parentNode.removeChild(fl); }, 650);
    } catch (e) {}
  }
  // Project files changed on disk (agent or external) → rescan the navigator.
  window.api.on("project:changed", () => { if (typeof renderProjectNav === "function") renderProjectNav(true); });
  // Popups from previewed content arrive here as a request to open a URL tab.
  window.api.on("url:openTab", (url) => { if (url) openFromURL(url); });
  window.api.on("toast:show", (msg) => { if (msg) showToast(msg, "warn"); });
  window.api.on("view:toggleSidebar", () => {
    // Toggle the left project navigator (the toolbar is fixed at the bottom now).
    navCollapsed = !navCollapsed;
    if (typeof updateNavVisibility === "function") { updateNavVisibility(); renderProjectNav(); }
  });
  window.api.on("view:toggleInspector", toggleInspector);
  window.api.on("view:zoomIn", zoomIn);
  window.api.on("view:zoomOut", zoomOut);
  window.api.on("view:zoomReset", zoomReset);
  window.api.on("tools:screenshotFull", takeFullScreenshot);
  window.api.on("tools:screenshotSection", () => enterSectionMode("screenshot"));
  window.api.on("tools:copyURL", copyURL);
  window.api.on("tools:copyHTML", copyFullHTML);
  window.api.on("tools:copySectionHTML", () => enterSectionMode("copyhtml"));

  // ─── Drag & Drop ───
  const dropOverlay = document.getElementById("drop-overlay");
  const dropZone = dropOverlay.querySelector(".drop-zone");
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) dropOverlay.classList.add("active");
  });

  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove("active");
      dropZone.classList.remove("hover");
    }
  });

  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropZone.classList.add("hover");
  });

  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove("active");
    dropZone.classList.remove("hover");

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const filePath = file.path;
      if (filePath && (filePath.endsWith(".html") || filePath.endsWith(".htm"))) {
        const loaded = await window.api.loadDropped(filePath);
        if (!loaded) showToast("Not a valid HTML file", "warn");
      } else {
        showToast("Drop an .html file", "warn");
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  Inspector — click an element to edit its text, styles, CSS variables
  //  and raw inline CSS live. Changes preview instantly; "Copy styles"
  //  copies a paste-ready instruction to the clipboard for Claude.
  // ════════════════════════════════════════════════════════════════════
  const STYLE_FIELDS = [
    { k: "color", label: "Color", type: "color" },
    { k: "background-color", label: "Background", type: "color" },
    { k: "font-size", label: "Size", type: "stepper" },
    { k: "font-weight", label: "Weight", type: "text" },
    { k: "line-height", label: "Line height", type: "stepper" },
    { k: "text-align", label: "Alignment", type: "align" },
    { k: "border-radius", label: "Radius", type: "stepper" },
    { k: "width", label: "Width", type: "text", px: true },
    { k: "height", label: "Height", type: "text", px: true },
    { k: "opacity", label: "Opacity", type: "slider" },
    { k: "display", label: "Display", type: "text" },
  ];
  const ALIGN_OPTS = [
    { v: "left", icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>' },
    { v: "center", icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>' },
    { v: "right", icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>' },
    { v: "justify", icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>' },
  ];
  let inspectorEdits = null;
  const inspectorPanel = document.getElementById("inspector-panel");

  // Webview-side: select element at point, tag it, return its editable data.
  function readElementScript(relX, relY) {
    return `
      (function() {
        var hl = document.getElementById('__hdv_hl'); if (hl) hl.style.display = 'none';
        var t = document.elementFromPoint(${relX}, ${relY});
        if (!t || t.id === '__hdv_hl' || t.id === '__hdv_label') return null;
        var prev = document.querySelector('[data-ohana-inspect]'); if (prev) prev.removeAttribute('data-ohana-inspect');
        t.setAttribute('data-ohana-inspect', '1');
        var st = document.getElementById('__ohana_inspect_style');
        if (!st) { st = document.createElement('style'); st.id = '__ohana_inspect_style';
          st.textContent = '[data-ohana-inspect]{outline:2px solid #7cb0ff !important;outline-offset:1px;}';
          document.head.appendChild(st); }
        function sel(el){
          if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
          var parts = [];
          while (el && el.nodeType === 1 && el !== document.body) {
            var p = el.tagName.toLowerCase(); var par = el.parentElement;
            if (par) { var sib = Array.prototype.filter.call(par.children, function(c){ return c.tagName === el.tagName; });
              if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')'; }
            parts.unshift(p); el = par;
          }
          return parts.join(' > ');
        }
        var aiId = t.getAttribute('data-ai-id') || null;
        var tag = t.tagName.toLowerCase();
        var cls = (t.className && typeof t.className === 'string') ? '.' + t.className.split(' ')[0] : '';
        var label = aiId || (tag + (t.id ? '#' + t.id : cls));
        var hasChildEls = t.children && t.children.length > 0;
        var text = hasChildEls ? null : (t.textContent || '');
        var cs = getComputedStyle(t);
        var keys = ['color','background-color','font-size','font-weight','line-height','text-align','padding','margin','padding-top','padding-right','padding-bottom','padding-left','margin-top','margin-right','margin-bottom','margin-left','border-radius','width','height','opacity','display','flex-direction','justify-content','align-items','gap','flex-wrap'];
        var computed = {}; keys.forEach(function(k){ computed[k] = cs.getPropertyValue(k).trim(); });
        var order = { index: 0, count: 0 };
        if (t.parentElement) { var kids = t.parentElement.children; order.count = kids.length; order.index = Array.prototype.indexOf.call(kids, t); }
        var inlineStyle = t.getAttribute('style') || '';
        var classes = (t.className && typeof t.className === 'string') ? t.className.split(/\s+/).filter(Boolean) : [];
        var fullText = (t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        return JSON.stringify({ selector: sel(t), aiId: aiId, tag: tag, label: label, text: text, computed: computed, order: order, inlineStyle: inlineStyle, classes: classes, fullText: fullText });
      })()
    `;
  }

  function inspectApply(js) {
    if (!webview || !webviewReady) return;
    webview.executeJavaScript('(function(){var el=document.querySelector(\'[data-ohana-inspect="1"]\'); if(!el) return; ' + js + ' })()').catch(function(){});
  }
  function ip_setStyle(prop, val) { if (!inspectorEdits) return; inspectorEdits.styles[prop] = val; inspectApply('el.style.setProperty(' + JSON.stringify(prop) + ',' + JSON.stringify(val) + ');'); updateSendButton(); }
  function ip_setText(val) { if (!inspectorEdits) return; inspectorEdits.text = val; inspectApply('el.textContent=' + JSON.stringify(val) + ';'); updateSendButton(); }
  function ip_setRaw(val) { if (!inspectorEdits) return; inspectorEdits.rawStyle = val; inspectApply('el.setAttribute("style",' + JSON.stringify(val) + ');'); updateSendButton(); }

  // ── Design-system component awareness (pluggable source) ──
  let componentMeta = [];
  let componentSource = "none";
  let componentCss = null;   // optional DS stylesheet (for inline-HTML previews)
  let sbBase = null;         // active Storybook base URL (for iframe previews)
  let sbMap = null;          // componentKey → [{id,name}] from Storybook index
  async function loadComponentMeta(opts) {
    try {
      const at = activeTab();
      const dir = at && at.componentsDir ? at.componentsDir : undefined;
      const res = await window.api.componentsRead(Object.assign({ dir }, opts || {}));
      if (Array.isArray(res)) { componentMeta = res; componentSource = res.length ? "components.json" : "none"; componentCss = null; }
      else if (res && Array.isArray(res.components)) {
        componentMeta = res.components; componentSource = res.source || "none"; componentCss = res.css || null;
        // Default this tab's Storybook URL from project config, if not set yet.
        if (at && !at.storybookUrl && res.storybookUrl) at.storybookUrl = res.storybookUrl;
      }
      else { componentMeta = []; componentSource = "none"; componentCss = null; }
    } catch (e) { componentMeta = []; componentSource = "none"; componentCss = null; }
    await loadStorybookIndex();
    if (typeof componentsVisible !== "undefined" && componentsVisible) renderComponents();
  }

  // Fetch the Storybook index for this tab's URL → component→story map.
  async function loadStorybookIndex() {
    const at = activeTab();
    const url = at && at.storybookUrl;
    if (!url) { sbBase = null; sbMap = null; return; }
    try {
      const res = await window.api.storybookIndex(url);
      if (res && res.ok) { sbBase = res.base; sbMap = res.map; }
      else { sbBase = null; sbMap = null; }
    } catch (e) { sbBase = null; sbMap = null; }
  }
  // Pick the best story id for a component name (prefer Default/Primary/Basic).
  function storyIdFor(name) {
    if (!sbMap || !name) return null;
    const key = String(name).toLowerCase().replace(/[\s_-]+/g, "");
    const list = sbMap[key];
    if (!list || !list.length) return null;
    const pref = list.find((s) => /^(default|primary|basic)$/i.test(s.name || ""));
    return (pref || list[0]).id;
  }
  const COMPONENT_SOURCE_LABEL = {
    "config": "source: config (.ohana/config.json)",
    "components.json": "source: project's components.json",
    "ohana-field": "source: design system (package.json · ohana)",
    "mcp-context": "source: design system (mcp-context)",
    "storybook": "source: Storybook",
    "folder": "source: folder scan (names only)",
    "none": "",
  };
  // Match the inspected element to a known component by class / data-ai-id.
  function detectComponent(data) {
    if (!data || !componentMeta.length) return null;
    const classes = data.classes || [];
    for (const c of componentMeta) {
      const m = c.match || {};
      if (Array.isArray(m.anyClass) && m.anyClass.some((cl) => classes.includes(cl))) return c;
      if (m.class && classes.includes(m.class)) return c;
      if (m.aiId && data.aiId === m.aiId) return c;
    }
    return null;
  }
  function currentPropValue(p, classes) {
    if (!p.classMap) return "";
    let dflt = "";
    for (const opt of (p.options || [])) {
      const cl = p.classMap[opt];
      if (cl && classes.indexOf(cl) !== -1) return opt; // a modifier class is present
      if (cl === "") dflt = opt; // the base/no-modifier option
    }
    return dflt; // none of the modifier classes present → the default option
  }
  // Change a component prop: live-preview by swapping its mapped classes, and
  // record the intent so "Apply to code" asks the agent to set the prop.
  function ip_setProp(p, value) {
    if (!inspectorEdits) return;
    inspectorEdits.props = inspectorEdits.props || {};
    inspectorEdits.props[p.name] = value;
    if (p.classMap) {
      const all = Object.keys(p.classMap).map((k) => p.classMap[k]).filter(Boolean);
      const add = p.classMap[value];
      const js = JSON.stringify(all) + '.forEach(function(c){ el.classList.remove(c); });'
        + (add ? 'el.classList.add(' + JSON.stringify(add) + ');' : '');
      inspectApply(js);
    }
    updateSendButton();
  }
  function buildComponentSection(comp, data) {
    const sec = document.getElementById("ip-sec-component");
    if (!comp) { sec.classList.add("hidden"); return; }
    sec.classList.remove("hidden");
    document.getElementById("ip-comp-name").textContent = comp.name || "Component";
    const wrap = document.getElementById("ip-component");
    wrap.innerHTML = "";
    (comp.props || []).forEach((p) => {
      if (!(p.options || []).length) return; // name-only prop → no live switch possible
      const row = document.createElement("div"); row.className = "ip-field";
      const lab = document.createElement("label"); lab.textContent = p.label || p.name; row.appendChild(lab);
      const sel = document.createElement("select"); sel.className = "ip-token-select";
      (p.options || []).forEach((o) => { const op = document.createElement("option"); op.value = o; op.textContent = o; sel.appendChild(op); });
      sel.value = currentPropValue(p, data.classes || []);
      sel.addEventListener("change", () => ip_setProp(p, sel.value));
      row.appendChild(sel);
      wrap.appendChild(row);
    });
    const note = document.getElementById("ip-comp-note");
    let html = "";
    if (comp.use) html += '<div class="ip-comp-use">' + escapeHtml(comp.use) + "</div>";
    if (comp.antiPatterns && comp.antiPatterns.length) {
      html += '<ul class="ip-comp-anti">' + comp.antiPatterns.map((a) => "<li>" + escapeHtml(a) + "</li>").join("") + "</ul>";
    }
    note.innerHTML = html;
  }

  function openInspector(data) {
    inspectorEdits = { selector: data.selector, aiId: data.aiId, label: data.label, text: null, styles: {}, rawStyle: null, order: null, props: {}, component: null };
    document.getElementById("ip-target").textContent = "◎ " + data.label;
    // Component-aware mode: if the element is a known design-system component,
    // offer its variants/props. Otherwise show the generic guardrail in repos.
    const comp = detectComponent(data);
    inspectorEdits.component = comp ? comp.name : null;
    buildComponentSection(comp, data);
    const at = activeTab();
    document.getElementById("ip-ds-hint").style.display = (!comp && at && at.kind === "repo") ? "block" : "none";
    inspectorFindApi(data);

    buildLayout(data);

    const textSec = document.getElementById("ip-sec-text");
    const textEl = document.getElementById("ip-text");
    if (data.text === null || data.text === undefined) {
      textSec.classList.add("hidden");
    } else {
      textSec.classList.remove("hidden");
      textEl.value = data.text;
    }

    buildBoxModel(data);
    buildStyleFields(data);

    renderTokenPalette();

    document.getElementById("ip-raw").value = data.inlineStyle || "";
    updateSendButton();
    inspectorPanel.classList.add("visible");
    adjustPanelsMargin();
  }

  function closeInspector() {
    inspectorPanel.classList.remove("visible");
    inspectorEdits = null;
    if (webview && webviewReady) {
      webview.executeJavaScript('(function(){var p=document.querySelector("[data-ohana-inspect]"); if(p) p.removeAttribute("data-ohana-inspect"); var s=document.getElementById("__ohana_inspect_style"); if(s) s.remove();})()').catch(function(){});
    }
    adjustPanelsMargin();
  }

  function inspectorChangeCount() {
    if (!inspectorEdits) return 0;
    const e = inspectorEdits;
    return (e.text !== null ? 1 : 0) + Object.keys(e.styles).length +
      (e.rawStyle !== null ? 1 : 0) + (e.order !== null ? 1 : 0) + Object.keys(e.props || {}).length;
  }
  function updateSendButton() {
    const n = inspectorChangeCount();
    const apply = document.getElementById("ip-apply");
    const send = document.getElementById("ip-send");
    if (apply) {
      apply.textContent = n > 0 ? "Apply to code (" + n + ")" : "Apply to code";
      apply.disabled = n === 0;
      apply.style.opacity = n === 0 ? "0.45" : "1";
    }
    if (send) {
      send.disabled = n === 0;
      send.style.opacity = n === 0 ? "0.45" : "1";
    }
  }
  // Build a paste-ready instruction for Claude describing the element + changes.
  function buildStylePrompt() {
    const e = inspectorEdits;
    const where = e.aiId ? '`[data-ai-id="' + e.aiId + '"]`' : "`" + e.selector + "`";
    const what = e.component ? ("the " + e.component + " component (" + where + ")") : ("the element " + where);
    const lines = ["On " + what + " apply these changes:"];
    const propKeys = Object.keys(e.props || {});
    if (propKeys.length) {
      lines.push("- Component props (adjust the prop, not the CSS):");
      propKeys.forEach((k) => lines.push("    " + k + " = " + e.props[k]));
    }
    if (e.text !== null) lines.push('- Text: "' + e.text + '"');
    const styleKeys = Object.keys(e.styles);
    if (styleKeys.length) {
      lines.push("- Styles (CSS):");
      styleKeys.forEach((k) => lines.push("    " + k + ": " + e.styles[k] + ";"));
    }
    if (e.rawStyle !== null) lines.push("- Full inline style: " + e.rawStyle);
    if (e.order !== null) lines.push("- Move the element to position " + (e.order + 1) + " among its siblings.");
    return lines.join("\n");
  }
  async function copyInspectorStyles() {
    if (!inspectorEdits || inspectorChangeCount() === 0) { showToast("No changes to copy", "warn"); return; }
    await window.api.copyText(buildStylePrompt());
    showToast("Instruction copied — paste it to the agent", "check");
  }

  // Wrap the change list with a directive that tells the agent HOW to persist:
  // free CSS edits on a prototype, but idiomatic variant/prop changes in a repo
  // (so we never hardcode CSS that breaks the design system).
  function buildApplyPrompt(isRepo) {
    const head = isRepo
      ? "Apply these changes from Ohana's inspector to the code. IMPORTANT: this element is part of the project's design system — do NOT inject CSS or inline styles that break the system. If it's a component, adjust its variant/prop (or use the right token). If the change doesn't fit within the system, tell me instead of forcing it.\n\n"
      : "Apply these changes from Ohana's inspector to the code (it's an HTML prototype, you can edit it freely):\n\n";
    return head + buildStylePrompt();
  }

  // "Apply to code" — send the accumulated edits to the active tab's
  // terminal so the agent writes them to source. Review before pressing Enter.
  function applyInspectorEdits() {
    if (!inspectorEdits || inspectorChangeCount() === 0) { showToast("No changes to apply", "warn"); return; }
    const at = activeTab();
    if (!at) { showToast("Open a prototype first", "warn"); return; }
    const isRepo = at.kind === "repo";
    const prompt = buildApplyPrompt(isRepo);
    if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
    setTimeout(() => window.api.termInput({ tabKey: at.key, data: prompt }), 280);
    showToast(isRepo
      ? "Sent to the agent — it will apply by variant/prop (review and hit Enter)"
      : "Sent to the terminal — review and hit Enter", "check");
  }

  document.getElementById("ip-text").addEventListener("input", (e) => ip_setText(e.target.value));
  document.getElementById("ip-raw").addEventListener("input", (e) => ip_setRaw(e.target.value));
  document.getElementById("ip-close").onclick = closeInspector;
  document.getElementById("ip-send").onclick = copyInspectorStyles;
  document.getElementById("ip-apply").onclick = applyInspectorEdits;
  document.getElementById("ip-reset").onclick = () => {
    // Discard the live preview edits by reloading the prototype
    closeInspector();
    if (webview && webviewReady) webview.reload();
    showToast("Changes discarded", "check");
  };

  // ── Inspector · Auto Layout (visual flexbox controls) ──
  let layoutState = null;
  const ALIGN_P = ["flex-start", "center", "flex-end"];
  function pIdx(v) {
    v = v || "";
    if (v.indexOf("center") >= 0) return 1;
    if (v.indexOf("end") >= 0 || v.indexOf("right") >= 0 || v.indexOf("bottom") >= 0 || v.indexOf("between") >= 0) return 2;
    return 0;
  }
  function lyNum(v) {
    v = (v || "").trim();
    if (v === "" || v === "normal") return "";
    return /^[0-9.]+$/.test(v) ? v + "px" : v;
  }
  function gapDisplay(v) {
    if (!v || v === "normal") return "";
    return v.split(" ")[0]; // first track
  }

  function buildLayout(data) {
    const c = data.computed || {};
    layoutState = {
      flex: /flex/.test(c.display || ""),
      dir: (c["flex-direction"] || "row").indexOf("column") === 0 ? "column" : "row",
      justify: c["justify-content"] || "flex-start",
      align: c["align-items"] || "stretch",
      gap: gapDisplay(c.gap),
      padding: c.padding || "",
      index: data.order ? data.order.index : 0,
      count: data.order ? data.order.count : 0,
    };
    renderLayout();
  }

  function renderLayout() {
    const wrap = document.getElementById("ip-layout");
    const s = layoutState;
    if (!s) { wrap.innerHTML = ""; return; }
    let html = "";

    if (!s.flex) {
      html += '<div class="ly-enable"><span style="color:var(--text-m);font-size:11px;">No auto layout</span>' +
        '<button class="ly-btn" data-act="enable">Use Auto layout</button></div>';
    } else {
      html += '<div class="ly-enable"><span style="font-size:11px;">Active</span>' +
        '<button class="icon-btn" data-act="disable" title="Remove auto layout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>';
      html += '<div class="ly-controls">';
      // Direction
      html += '<div class="ly-row"><span class="ly-label">Direction</span><div class="seg">' +
        '<button data-act="dir" data-val="row" class="' + (s.dir === "row" ? "on" : "") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>Row</button>' +
        '<button data-act="dir" data-val="column" class="' + (s.dir === "column" ? "on" : "") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>Column</button>' +
        "</div></div>";
      // Alignment grid + gap/padding
      const ji = pIdx(s.justify), ai = pIdx(s.align);
      let onCol, onRow;
      if (s.dir === "row") { onCol = ji; onRow = ai; } else { onRow = ji; onCol = ai; }
      let grid = '<div class="align-grid">';
      for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) {
        grid += '<button class="align-cell' + (col === onCol && r === onRow ? " on" : "") + '" data-act="align" data-col="' + col + '" data-row="' + r + '"></button>';
      }
      grid += "</div>";
      html += '<div class="ly-row">' + grid +
        '<div class="ly-fields">' +
        '<div class="ly-field"><span class="ly-cap">Gap</span><input class="ly-num" data-act="gap" value="' + s.gap + '" placeholder="0"></div>' +
        "</div></div>";
      html += "</div>";
    }

    // Order among siblings (always shown when there are siblings)
    if (s.count > 1) {
      html += '<div class="ly-row" style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;">' +
        '<span class="ly-label">Order</span><div class="ly-order">' +
        '<button class="icon-btn" data-act="up"' + (s.index <= 0 ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg></button>' +
        '<button class="icon-btn" data-act="down"' + (s.index >= s.count - 1 ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>' +
        '<span class="ly-pos">' + (s.index + 1) + " of " + s.count + "</span></div></div>";
    }
    wrap.innerHTML = html;
  }

  function ip_reorder(dir) {
    if (!inspectorEdits || !webview || !webviewReady) return;
    webview.executeJavaScript(
      '(function(){var el=document.querySelector(\'[data-ohana-inspect="1"]\'); if(!el||!el.parentElement) return null; var p=el.parentElement;' +
      (dir < 0
        ? 'var prev=el.previousElementSibling; if(prev) p.insertBefore(el, prev);'
        : 'var next=el.nextElementSibling; if(next) p.insertBefore(next, el);') +
      ' return Array.prototype.indexOf.call(p.children, el); })()'
    ).then(function (idx) {
      if (idx == null) return;
      layoutState.index = idx;
      inspectorEdits.order = idx;
      updateSendButton();
      renderLayout();
    }).catch(function () {});
  }

  // Delegated handlers for the layout controls
  document.getElementById("ip-layout").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !layoutState) return;
    const act = b.dataset.act;
    if (act === "enable") { layoutState.flex = true; layoutState.dir = "row"; ip_setStyle("display", "flex"); renderLayout(); }
    else if (act === "disable") { layoutState.flex = false; ip_setStyle("display", "block"); renderLayout(); }
    else if (act === "dir") { layoutState.dir = b.dataset.val; ip_setStyle("flex-direction", b.dataset.val); renderLayout(); }
    else if (act === "align") {
      const col = +b.dataset.col, row = +b.dataset.row;
      let justify, align;
      if (layoutState.dir === "row") { justify = ALIGN_P[col]; align = ALIGN_P[row]; }
      else { justify = ALIGN_P[row]; align = ALIGN_P[col]; }
      layoutState.justify = justify; layoutState.align = align;
      ip_setStyle("justify-content", justify); ip_setStyle("align-items", align);
      renderLayout();
    }
    else if (act === "up") ip_reorder(-1);
    else if (act === "down") ip_reorder(1);
  });
  document.getElementById("ip-layout").addEventListener("input", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !layoutState) return;
    if (b.dataset.act === "gap") { layoutState.gap = b.value; ip_setStyle("gap", lyNum(b.value)); }
    else if (b.dataset.act === "padding") { layoutState.padding = b.value; ip_setStyle("padding", lyNum(b.value)); }
  });

  // ════════════════════════════════════════════════════════════════════
  //  Tabs — every open surface (HTML file, URL, or repo) is a tab. Opening
  //  a new one NEVER closes the others. Each tab carries its own kind, key,
  //  directory (cwd) and — via main — its own terminal + .md context.
  // ════════════════════════════════════════════════════════════════════
  let tabs = [];        // [{ key, kind:'file'|'url'|'repo', src, name, dir, repoDir, repoUrl }]
  let activeKey = null; // key of the active tab
  let workingTabs = new Set(); // tabKeys whose terminal is currently producing output

  function setTabWorking(key, on) {
    const safe = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
    const el = tabsEl.querySelector('.tab[data-key="' + safe + '"]');
    if (el) el.classList.toggle("working", on);
  }
  window.api.on("term:activity", (p) => {
    if (!p) return;
    if (p.active) workingTabs.add(p.tabKey); else workingTabs.delete(p.tabKey);
    setTabWorking(p.tabKey, !!p.active);
  });
  const tabsEl = document.getElementById("tabs");
  const titleCenterEl = document.getElementById("title-center");
  const urlBar = document.getElementById("url-bar");

  function tabName(p) { return (p || "").split("/").filter(Boolean).pop() || p; }
  function urlLabel(u) {
    try { const x = new URL(u); return x.host + (x.pathname && x.pathname !== "/" ? x.pathname : ""); }
    catch (e) { return (u || "").replace(/^https?:\/\//, ""); }
  }
  function findTab(key) { return tabs.find((t) => t.key === key); }
  function activeTab() { return findTab(activeKey); }
  function upsertTab(tab) {
    const ex = findTab(tab.key);
    if (ex) { Object.assign(ex, tab); return ex; }
    tabs.push(tab); return tab;
  }

  // Persist the session (tabs + active + toolbar position) so the next launch
  // reopens exactly here. Debounced; main validates on restore.
  let _saveSessionT = null;
  function saveSession() {
    if (_saveSessionT) clearTimeout(_saveSessionT);
    _saveSessionT = setTimeout(() => {
      _saveSessionT = null;
      window.api.sessionSave({
        tabs: tabs.map((t) => ({
          key: t.key, kind: t.kind, src: t.src, name: t.name,
          dir: t.dir || null, repoDir: t.repoDir || null, repoUrl: t.repoUrl || null,
          componentsDir: t.componentsDir || null, storybookUrl: t.storybookUrl || null,
          devCommand: t.devCommand || null, // how its dev server was launched — restore relaunches the same
          artifact: t.artifact || null, previewPath: t.previewPath || null, // each tab reopens on ITS artifact
        })),
        activeKey: activeKey,
        toolbarPos: currentTBPos,
      });
    }, 400);
  }

  // Reopen tabs saved from a previous session (sent by main on launch).
  window.api.on("session:restore", (s) => {
    if (!s || !Array.isArray(s.tabs) || !s.tabs.length) return;
    tabs = s.tabs.map((t) => ({
      key: t.key, kind: t.kind, src: t.src, name: t.name,
      dir: t.dir || null, repoDir: t.repoDir || null, repoUrl: t.repoUrl || null,
      componentsDir: t.componentsDir || null, storybookUrl: t.storybookUrl || null,
      devCommand: t.devCommand || null,
      artifact: t.artifact || null, previewPath: t.previewPath || null,
    }));
    if (s.toolbarPos) setToolbarPosition(s.toolbarPos);
    renderTabs(); syncHeader();
    emptyState.classList.add("hidden"); // there are tabs → never leave the empty-state overlapping the webview
    const active = findTab(s.activeKey) || tabs[0];
    activeKey = null; // force activation to proceed
    if (active.kind === "file") {
      window.api.loadDropped(active.src); // main → file:load → activateTab
    } else {
      activateTab(active.key);
      window.api.tabSyncContext({ kind: active.kind, dir: active.dir || null, url: active.src, src: active.src });
    }
  });

  // Normalize a typed address into a loadable URL (allow "localhost:3000")
  function normalizeURL(u) {
    u = (u || "").trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = "http://" + u;
    return u;
  }

  const TAB_ICONS = {
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>',
    url:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
    repo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
  };

  // The header shows the tab strip whenever there are tabs; the editable URL
  // bar appears additionally only when the active tab is a url/repo.
  function syncHeader() {
    const has = tabs.length > 0;
    tabsEl.classList.toggle("show", has);
    titleCenterEl.style.display = has ? "none" : "";
  }
  // URL editor popover: opens under a repo/url tab when you click it while active.
  const urlPop = document.getElementById("url-pop");
  function openUrlPop(t, tabEl) {
    const r = tabEl.getBoundingClientRect();
    urlPop.style.left = Math.min(r.left, window.innerWidth - 404) + "px";
    urlPop.style.top = (r.bottom + 6) + "px";
    urlBar.value = t.src || "";
    urlPop.classList.add("visible");
    setTimeout(() => { urlBar.focus(); urlBar.select(); }, 0);
  }
  function hideUrlPop() { urlPop.classList.remove("visible"); }
  document.addEventListener("mousedown", (e) => { if (urlPop.classList.contains("visible") && !urlPop.contains(e.target)) hideUrlPop(); });

  function renderTabs() {
    tabsEl.innerHTML = "";
    tabs.forEach((t) => {
      const tab = document.createElement("div");
      tab.className = "tab kind-" + t.kind + (t.key === activeKey ? " active" : "") + (workingTabs.has(t.key) ? " working" : "");
      tab.dataset.key = t.key;
      tab.title = t.src;
      const work = document.createElement("span");
      work.className = "tab-work";
      tab.appendChild(work);
      const ic = document.createElement("span");
      ic.className = "tab-ic";
      ic.innerHTML = TAB_ICONS[t.kind] || TAB_ICONS.file;
      tab.appendChild(ic);
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = t.name;
      tab.appendChild(name);
      const close = document.createElement("span");
      close.className = "tab-close";
      close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      close.onclick = (e) => { e.stopPropagation(); closeTab(t.key); };
      tab.appendChild(close);
      tab.onclick = () => {
        // Clicking the ACTIVE repo/url tab opens the URL editor under it.
        if (t.key === activeKey && (t.kind === "url" || t.kind === "repo")) { openUrlPop(t, tab); return; }
        switchTab(t.key);
      };
      tabsEl.appendChild(tab);
    });
    const add = document.createElement("button");
    add.className = "tab-add";
    add.title = "Open  ⌘O";
    add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    add.onclick = () => openOpenDialog();
    tabsEl.appendChild(add);
  }

  // ─── Per-tab tools/panels ───
  // Each tab remembers which panels it had open, so switching tabs restores its
  // own set of tools (terminal, inspector, design, …) instead of carrying one
  // global state across every tab.
  function capturePanels() {
    return {
      inspector: inspectorActive,
      findings: findingsVisible,
      design: designVisible,
      context: contextVisible,
      components: componentsVisible,
      network: networkVisible,
      terminal: termVisible,
    };
  }
  function applyPanels(p) {
    p = p || {};
    if (!!p.inspector !== inspectorActive) toggleInspector();
    if (!!p.findings !== findingsVisible) toggleFindings();
    // design/context dock panels were absorbed by the left navigator — never
    // restore them from old sessions (their header buttons are gone).
    if (designVisible) toggleDesign();
    if (contextVisible) toggleContext();
    if (!!p.components !== componentsVisible) toggleComponents();
    if (!!p.network !== networkVisible) toggleNetwork();
    if (!!p.terminal !== termVisible) toggleTerminal();
  }

  // Activate a tab locally: show its (persistent) webview, update derived
  // globals + header, switch the per-tab terminal/context, and restore the
  // tab's own panels. File tabs reach here via file:load (main owns their
  // watcher); url/repo come straight here. Switching NEVER reloads the webview.
  function activateTab(key) {
    const t = findTab(key);
    if (!t) return;
    // Persist any pending debounced Moka edit BEFORE anything re-points main to
    // the incoming tab (IPC is FIFO: this write lands on the outgoing project).
    if (typeof flushFlowSave === "function") flushFlowSave();
    // Save the outgoing tab's open tools before we switch away from it.
    const outgoing = activeTab();
    if (outgoing && outgoing !== t) outgoing.panels = capturePanels();
    // New prototype context → reset comment baseline + unread (re-baselined on
    // the next findings load) so we don't notify on another file's history.
    prevAgentCounts = null;
    unreadIds.clear();
    updateFindingsBadge();
    activeKey = key;
    // Tabs are fully INDEPENDENT workspaces: each restores ITS artifact on
    // activation (a project on its html/md/board, a repo/url its browser).
    if (t.artifact && t.artifact.kind !== "md") { saveReaderDoc(); hideProjReader(); }
    if (t.kind === "file") {
      currentFilePath = t.src; repoMode = false; repoUrl = null;
      mountWebview(t);
      refreshDesignTokens();
    } else if (t.kind === "new") {
      currentFilePath = null; repoMode = false; repoUrl = null;
      const art = t.artifact;
      if (art && art.kind === "md") openDocArtifact(art.path, art.path.split("/").pop(), art.rel || null); // reopen its doc
      else if (art && art.kind === "html" && t.previewPath) mountWebview(t); // its prototype preview
      else { saveReaderDoc(); hideProjReader(); showNewProto(t); }           // board (Moka takes over) or empty
    } else {
      saveReaderDoc(); hideProjReader(); // repo/url are browsers — never show another tab's reader
      currentFilePath = null; repoMode = (t.kind === "repo"); repoUrl = t.src;
      mountWebview(t);
    }
    setConnected(true);
    syncHeader();
    renderTabs();
    switchTerminalTo(t);
    loadContextForTab(t);
    applyPanels(t.panels); // restore this tab's own tools
    // mountWebview→applyBreakpoint resets the webview to full width; re-run the
    // dock layout so the preview stays inset for whatever panels are open (even
    // when applyPanels toggled nothing because both tabs had the same set).
    adjustPanelsMargin();
    // The mode follows the TAB's open artifact (a URL tab is a browser, a tab
    // that was on a board comes back to Moka) — flowMode is never global.
    flowMode = !!(t.artifact && t.artifact.kind === "board");
    syncView(); // enforce the view invariants for the newly-active tab
    // Re-point the MAIN process to THIS tab's project BEFORE reading its flow.json /
    // scanning its folder — otherwise those IPC reads hit the previously-active tab's
    // .ohana (cross-tab flow mixing / lost edits). File tabs are owned by file:load.
    if (t.kind !== "file") window.api.tabSyncContext({ kind: t.kind, dir: t.dir || null, url: t.src, src: t.src });
    loadComponentMeta(); // after the re-point: its fallback reads main's project dir
    if (flowMode && typeof loadFlowForActive === "function") loadFlowForActive(); // flow follows the active project
    if (typeof renderProjectNav === "function") renderProjectNav(); // refresh the left rail for this project
    saveSession();
  }

  function switchTab(key) {
    if (key === activeKey) return;
    const t = findTab(key);
    if (!t) return;
    if (t.kind === "file") {
      // file:load re-points main BEFORE activateTab runs → flush the outgoing
      // tab's pending Moka save now, while main still points at its project.
      if (typeof flushFlowSave === "function") flushFlowSave();
      window.api.loadDropped(t.src); // main → file:load → activateTab
    } else {
      activateTab(key);
      window.api.tabSyncContext({ kind: t.kind, dir: t.dir || null, url: t.src, src: t.src });
    }
  }

  // Open a URL as its own tab (never replaces the others)
  function openFromURL(raw) {
    const url = normalizeURL(raw);
    if (!url) return;
    const key = "url:" + url;
    upsertTab({ key, kind: "url", src: url, name: urlLabel(url), dir: null });
    activateTab(key);
    window.api.tabSyncContext({ kind: "url", dir: null, url, src: url });
  }

  // Open a running repo as its own tab. Main already set repoDir/mode in
  // repo:start / repo:connectExisting before this is called. `command` is the
  // shell line that launched its dev server — remembered so a session restore
  // can relaunch the SAME server (storybook vs dev vs custom), not a guess.
  function openRepoTab(dir, url, command) {
    const key = "repo:" + dir;
    upsertTab({ key, kind: "repo", src: url, name: tabName(dir) || urlLabel(url), dir, repoDir: dir, repoUrl: url, devCommand: command || (findTab(key) || {}).devCommand || null });
    activateTab(key);
  }

  urlBar.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); urlBar.blur();
      const url = normalizeURL(urlBar.value);
      if (!url) return;
      const at = activeTab();
      if (at && (at.kind === "url" || at.kind === "repo")) {
        at.src = url;
        if (at.kind === "url") at.name = urlLabel(url);
        repoUrl = url;
        // Navigating the address bar replaces this tab's content: rebuild its
        // own webview (other tabs keep their state).
        if (at.wv) { at.wv.remove(); at.wv = null; at.wvReady = false; }
        mountWebview(at);
        syncHeader(); renderTabs();
        window.api.tabSyncContext({ kind: at.kind, dir: at.dir || null, url, src: at.src });
      } else {
        openFromURL(url);
      }
      hideUrlPop();
    }
    if (e.key === "Escape") { hideUrlPop(); urlBar.blur(); }
  });

  function closeTab(key) {
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx === -1) return;
    const t = tabs[idx];
    // Closing the active board with an edit pending: write it home before the
    // switch to the next tab re-points main (else the timer fires cross-project).
    if (typeof flushFlowSave === "function") flushFlowSave();
    if (t.wv) { t.wv.remove(); t.wv = null; t.wvReady = false; } // tear down its webview
    const wasActive = key === activeKey;
    tabs.splice(idx, 1);
    closeTerminalFor(key);
    if (!wasActive) { renderTabs(); saveSession(); return; }
    flowMode = false; // closing the active tab exits Moka (syncView enforces it downstream)
    if (tabs.length === 0) { resetToEmpty(); return; }
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeKey = null; // force switchTab to proceed
    switchTab(next.key); // → activateTab → syncView
  }

  function resetToEmpty() {
    currentFilePath = null;
    activeKey = null;
    repoMode = false; repoUrl = null;
    if (webview) { webview.remove(); webview = null; webviewReady = false; }
    // Clear any preview error/loader overlay from the closed tab — otherwise it
    // stays painted on top of the empty state (overlapping-text bug).
    hidePreviewError(); hidePreviewLoader();
    tabsEl.classList.remove("show");
    hideUrlPop();
    titleCenterEl.style.display = "";
    titleText.textContent = "Ohana";
    setConnected(false);
    syncView(); // no tab → empty state, out of Moka (enforced in one place)
    toolbar.style.display = "none";
    document.getElementById("hdr-controls").style.display = "none";
    document.getElementById("hdr-tools").classList.remove("show");
    loadContextForTab(null);
    window.api.tabSyncContext({ kind: "none" });
    saveSession();
  }

  // ── Inspector · graphical style builders ──
  function buildColorControl(k, val) {
    const wrap = document.createElement("div"); wrap.className = "ip-input-wrap";
    const sel = document.createElement("select"); sel.className = "ip-token-select";
    const tokens = colorTokens();
    const optC = document.createElement("option"); optC.value = ""; optC.textContent = "Custom…"; sel.appendChild(optC);
    tokens.forEach((t) => {
      const o = document.createElement("option"); o.value = t.name; o.textContent = t.name + " · " + t.value;
      sel.appendChild(o);
    });
    sel.value = matchTokenInValue(val);
    const sw = document.createElement("button"); sw.type = "button"; sw.className = "ip-swatch";
    sw.style.background = resolveColor(val);
    sel.addEventListener("change", () => {
      if (!sel.value) return; // Personalizado → use the swatch picker
      const t = tokenByName(sel.value);
      // Apply the token's CONCRETE value (same path as the color picker). The
      // previewed prototype may not define the CSS custom property, so applying
      // var(--token) would silently fail to resolve and nothing would change.
      const applied = t ? t.value : sel.value;
      sw.style.background = resolveColor(applied);
      ip_setStyle(k, applied);
    });
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      openColorPicker(sw, sw.style.background, (v) => { sel.value = ""; sw.style.background = v; ip_setStyle(k, v); });
    });
    wrap.appendChild(sel); wrap.appendChild(sw); return wrap;
  }
  function buildText(k, val, px) {
    const inp = document.createElement("input"); inp.type = "text"; inp.className = "ip-input"; inp.value = val;
    inp.addEventListener("input", () => ip_setStyle(k, px ? lyNum(inp.value) : inp.value));
    return inp;
  }
  function buildStepper(k, val) {
    const wrap = document.createElement("div"); wrap.className = "stepper";
    const dec = document.createElement("button"); dec.textContent = "−"; dec.tabIndex = -1;
    const inp = document.createElement("input"); inp.className = "mono"; inp.value = val;
    const inc = document.createElement("button"); inc.textContent = "+"; inc.tabIndex = -1;
    const unitless = (k === "line-height");
    const baseStep = unitless ? 0.1 : 1;
    function bump(d) {
      const m = (inp.value || "").match(/^(-?[\d.]+)(.*)$/);
      let n = m ? parseFloat(m[1]) : 0;
      let u = m && m[2] ? m[2] : (unitless ? "" : "px");
      n = Math.round((n + d * baseStep) * 1000) / 1000;
      if (n < 0 && k.indexOf("margin") !== 0) n = 0;
      inp.value = n + u; ip_setStyle(k, inp.value);
    }
    dec.onclick = () => bump(-1); inc.onclick = () => bump(1);
    // Typing a value also applies it (add px to bare numbers, except line-height)
    inp.addEventListener("input", () => ip_setStyle(k, unitless ? inp.value : lyNum(inp.value)));
    wrap.appendChild(dec); wrap.appendChild(inp); wrap.appendChild(inc);
    return wrap;
  }
  function buildSlider(k, val) {
    const wrap = document.createElement("div"); wrap.className = "ip-slider";
    const r = document.createElement("input"); r.type = "range"; r.min = "0"; r.max = "1"; r.step = "0.01";
    let n = parseFloat(val); if (isNaN(n)) n = 1; r.value = n;
    const v = document.createElement("span"); v.className = "val"; v.textContent = Math.round(n * 100) + "%";
    r.addEventListener("input", () => { v.textContent = Math.round(r.value * 100) + "%"; ip_setStyle(k, r.value); });
    wrap.appendChild(r); wrap.appendChild(v); return wrap;
  }
  function buildAlign(k, val) {
    const seg = document.createElement("div"); seg.className = "seg small";
    const cur = val === "start" ? "left" : (val === "end" ? "right" : (val || "left"));
    ALIGN_OPTS.forEach((o) => {
      const b = document.createElement("button");
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + o.icon + "</svg>";
      if (cur === o.v) b.classList.add("on");
      b.onclick = () => { seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); ip_setStyle(k, o.v); };
      seg.appendChild(b);
    });
    return seg;
  }
  function buildStyleFields(data) {
    const wrap = document.getElementById("ip-styles");
    wrap.innerHTML = "";
    STYLE_FIELDS.forEach((def) => {
      const val = (data.computed && data.computed[def.k]) || "";
      const row = document.createElement("div");
      row.className = "ip-field" + (def.type === "color" ? " color" : "");
      const lab = document.createElement("label"); lab.textContent = def.label; row.appendChild(lab);
      let control;
      if (def.type === "color") control = buildColorControl(def.k, val);
      else if (def.type === "stepper") control = buildStepper(def.k, val);
      else if (def.type === "slider") control = buildSlider(def.k, val);
      else if (def.type === "align") control = buildAlign(def.k, val);
      else control = buildText(def.k, val, def.px);
      row.appendChild(control);
      wrap.appendChild(row);
    });
  }
  function buildBoxModel(data) {
    const c = data.computed || {};
    const wrap = document.getElementById("ip-boxmodel");
    wrap.innerHTML = "";
    function px(v) { v = (v || "").trim(); return (v === "0px" || v === "0" || v === "") ? "" : v.replace("px", ""); }
    function mkBox(kind) {
      const box = document.createElement("div");
      box.className = "bm-box bm-" + kind;
      box.innerHTML = '<span class="bm-tag">' + kind + "</span>";
      ["top", "right", "bottom", "left"].forEach((side) => {
        const i = document.createElement("input");
        i.className = "bm-in bm-" + side[0];
        i.placeholder = "0";
        i.value = px(c[kind + "-" + side]);
        i.addEventListener("input", () => ip_setStyle(kind + "-" + side, lyNum(i.value)));
        box.appendChild(i);
      });
      return box;
    }
    const wrapEl = document.createElement("div"); wrapEl.className = "boxmodel";
    const mBox = mkBox("margin");
    const pBox = mkBox("padding");
    const center = document.createElement("div"); center.className = "bm-center"; center.textContent = data.tag || "box";
    pBox.appendChild(center);
    mBox.appendChild(pBox);
    wrapEl.appendChild(mBox);
    wrap.appendChild(wrapEl);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Custom color picker — dark/glass, matches the app (replaces native)
  // ════════════════════════════════════════════════════════════════════
  const colorPop = document.getElementById("color-pop");
  const cpSV = document.getElementById("cp-sv");
  const cpThumb = document.getElementById("cp-sv-thumb");
  const cpHueEl = document.getElementById("cp-hue");
  const cpPrev = document.getElementById("cp-prev");
  const cpHexEl = document.getElementById("cp-hex");
  let cpApply = null, cpH = 0, cpS = 0, cpV = 0, cpDragging = false;

  function hsvToRgb(h, s, v) {
    h /= 360; let r, g, b; const i = Math.floor(h * 6); const f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break; case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break; default: r = v; g = p; b = q;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0; const s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, s, v];
  }
  function toHex(r, g, b) { const h = (n) => ("0" + n.toString(16)).slice(-2); return "#" + h(r) + h(g) + h(b); }
  function parseColor(str) {
    str = (str || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(str)) return [parseInt(str.slice(1, 3), 16), parseInt(str.slice(3, 5), 16), parseInt(str.slice(5, 7), 16)];
    if (/^#[0-9a-f]{3}$/i.test(str)) return [parseInt(str[1] + str[1], 16), parseInt(str[2] + str[2], 16), parseInt(str[3] + str[3], 16)];
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }
  function cpRender() {
    cpSV.style.background =
      "linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), hsl(" + cpH + ",100%,50%)";
    cpThumb.style.left = cpS * 100 + "%";
    cpThumb.style.top = (1 - cpV) * 100 + "%";
    const rgb = hsvToRgb(cpH, cpS, cpV);
    const hex = toHex(rgb[0], rgb[1], rgb[2]);
    cpPrev.style.background = hex;
    if (document.activeElement !== cpHexEl) cpHexEl.value = hex;
    return hex;
  }
  function cpCommit() { const hex = cpRender(); if (cpApply) cpApply(hex); }

  function openColorPicker(anchor, initial, apply) {
    cpApply = apply;
    const rgb = parseColor(initial) || [0, 0, 0];
    const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    cpH = hsv[0]; cpS = hsv[1]; cpV = hsv[2];
    cpHueEl.value = Math.round(cpH);
    cpRender();
    const r = anchor.getBoundingClientRect();
    let left = r.left - 210;
    if (left < 8) left = r.right + 8;
    const top = Math.min(Math.max(48, r.top), window.innerHeight - 210);
    colorPop.style.left = Math.max(8, Math.min(left, window.innerWidth - 208)) + "px";
    colorPop.style.top = top + "px";
    colorPop.classList.add("visible");
  }
  function closeColorPicker() { colorPop.classList.remove("visible"); cpApply = null; }

  function cpFromEvent(e) {
    const rect = cpSV.getBoundingClientRect();
    cpS = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    cpV = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    cpCommit();
  }
  cpSV.addEventListener("pointerdown", (e) => { cpDragging = true; cpSV.setPointerCapture(e.pointerId); cpFromEvent(e); });
  cpSV.addEventListener("pointermove", (e) => { if (cpDragging) cpFromEvent(e); });
  cpSV.addEventListener("pointerup", () => { cpDragging = false; });
  cpHueEl.addEventListener("input", () => { cpH = +cpHueEl.value; cpCommit(); });
  cpHexEl.addEventListener("input", () => {
    const rgb = parseColor(cpHexEl.value);
    if (!rgb) return;
    const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    cpH = hsv[0]; cpS = hsv[1]; cpV = hsv[2]; cpHueEl.value = Math.round(cpH);
    cpRender(); if (cpApply) cpApply(toHex(rgb[0], rgb[1], rgb[2]));
  });
  document.addEventListener("mousedown", (e) => {
    if (!colorPop.classList.contains("visible")) return;
    if (colorPop.contains(e.target)) return;
    if (e.target.classList && e.target.classList.contains("ip-swatch")) return;
    closeColorPicker();
  });

  // ════════════════════════════════════════════════════════════════════
  //  Design tokens — design.md is the source of truth. The inspector READS
  //  these (you pick among them); to change a token's value, edit design.md.
  // ════════════════════════════════════════════════════════════════════
  let designTokens = []; // [{ name, value, kind: 'color'|'size'|'other' }]
  const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/;
  const SIZE_RE = /\b\d+(\.\d+)?(px|rem|em|%)\b/;

  function parseDesignTokens(md) {
    const out = []; const seen = new Set();
    function add(name, value) {
      // Markdown table cells wrap values in backticks and often add annotations
      // (e.g. "`#18181B` (hsl 240 6% 10%)"). Strip the backticks and extract the
      // first usable CSS color/size so the value can be applied to elements
      // directly — otherwise setProperty() silently rejects it.
      name = (name || "").replace(/`/g, "").trim();
      value = (value || "").replace(/`/g, "").trim();
      if (!name || !value || seen.has(name)) return;
      const cm = value.match(COLOR_RE);
      const sm = value.match(SIZE_RE);
      const kind = cm ? "color" : (sm ? "size" : "other");
      seen.add(name);
      out.push({ name, value: cm ? cm[0] : (sm ? sm[0] : value), kind });
    }
    (md || "").split("\n").forEach((line) => {
      if (/^\s*\|/.test(line)) {
        const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (cells.length < 2) return;
        if (/^[-:\s]+$/.test(cells[0])) return; // separator row
        if (/^(token|name|nombre)$/i.test(cells[0])) return; // header row
        const name = cells[0];
        const value = cells.slice(1).find((c) => COLOR_RE.test(c) || SIZE_RE.test(c)) || cells[1];
        if (name && value && (name.indexOf("--") === 0 || COLOR_RE.test(value) || SIZE_RE.test(value))) add(name, value);
        return;
      }
      const m = line.match(/(--[\w-]+)\s*:\s*([^;]+)/);
      if (m) add(m[1], m[2]);
    });
    return out;
  }

  async function refreshDesignTokens() {
    try {
      const res = await window.api.designRead();
      designTokens = res && res.exists ? parseDesignTokens(res.content) : [];
    } catch (e) { designTokens = []; }
    if (inspectorPanel.classList.contains("visible")) renderTokenPalette();
  }

  function colorTokens() { return designTokens.filter((t) => t.kind === "color"); }
  function tokenByName(name) { return designTokens.find((t) => t.name === name) || null; }
  // If a style value already references a token (var(--x)) preselect it
  function matchTokenInValue(val) {
    const m = (val || "").match(/var\((--[\w-]+)\)/);
    if (m && tokenByName(m[1])) return m[1];
    return "";
  }
  // Resolve a value to a displayable color for the swatch
  function resolveColor(val) {
    const m = (val || "").match(/var\((--[\w-]+)\)/);
    if (m) { const t = tokenByName(m[1]); if (t) return t.value; }
    return val || "#000";
  }

  function renderTokenPalette() {
    const wrap = document.getElementById("ip-vars");
    wrap.innerHTML = "";
    if (designTokens.length === 0) {
      wrap.innerHTML = '<div class="token-empty">No tokens in <b>design.md</b>. Define them there (Tokens section) and they will show up here to apply.</div>';
      return;
    }
    const note = document.createElement("div");
    note.className = "ip-token-note";
    note.innerHTML = "Source of truth: <b>design.md</b>. To change a value, edit design.md (⇧⌘D).";
    wrap.appendChild(note);
    const chips = document.createElement("div"); chips.className = "token-chips";
    designTokens.forEach((t) => {
      const chip = document.createElement("div"); chip.className = "token-chip";
      if (t.kind === "color") {
        const sw = document.createElement("span"); sw.className = "tc-sw"; sw.style.background = t.value; chip.appendChild(sw);
      }
      const name = document.createElement("span"); name.className = "tc-name"; name.textContent = t.name; chip.appendChild(name);
      const val = document.createElement("span"); val.className = "tc-val"; val.textContent = t.value; chip.appendChild(val);
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Embedded terminal — xterm.js UI + node-pty (in main). Run Claude Code
  //  and any command inside Ohana, in the active project's directory.
  // ════════════════════════════════════════════════════════════════════
  // One xterm + node-pty per tab, so the agent in tab A is fully independent
  // from tab B (own shell, own cwd). Instances live in term-mount; only the
  // active tab's pane is shown.
  let termVisible = false;
  let activeTermKey = null;
  const termInstances = new Map(); // tabKey -> { term, fitAddon, mount, started, key, roP }
  const termPanel = document.getElementById("term-panel");
  const TERM_THEME = {
    background: "#16161c", foreground: "#ffffff", cursor: "#7cb0ff",
    selectionBackground: "rgba(124,176,255,0.30)",
    black: "#282a36", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#ffffff",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
    brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff",
  };

  // Route pty output/exit to the right tab's xterm (registered once).
  window.api.on("term:data", (p) => {
    const inst = p && termInstances.get(p.tabKey);
    if (inst) inst.term.write(p.data);
  });
  window.api.on("term:exit", (p) => {
    const inst = p && termInstances.get(p.tabKey);
    if (inst) { inst.term.write("\r\n\x1b[90m[shell terminated]\x1b[0m\r\n"); inst.started = false; }
  });

  function ensureTermInstance(tab) {
    if (termInstances.has(tab.key)) return termInstances.get(tab.key);
    const mount = document.createElement("div");
    mount.className = "term-pane";
    document.getElementById("term-mount").appendChild(mount);
    const term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12, cursorBlink: true, theme: TERM_THEME,
      // Force readable contrast: xterm auto-adjusts any text color that lands
      // too close to the background (dim/gray output, dark ANSI colors). Without
      // this, Claude Code's muted text becomes illegible on the dark panel.
      minimumContrastRatio: 4.5,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(mount);
    term.onData((d) => window.api.termInput({ tabKey: tab.key, data: d }));
    const inst = { term, fitAddon, mount, started: false, key: tab.key, roP: null };
    const ro = new ResizeObserver(() => {
      if (!termVisible || activeTermKey !== inst.key) return;
      clearTimeout(inst.roP);
      inst.roP = setTimeout(() => { try { fitAddon.fit(); termSendResizeFor(inst); } catch (e) {} }, 30);
    });
    ro.observe(mount);
    termInstances.set(tab.key, inst);
    return inst;
  }

  function termSendResizeFor(inst) {
    const d = inst.fitAddon.proposeDimensions();
    if (d && d.cols && d.rows) window.api.termResize({ tabKey: inst.key, cols: d.cols, rows: d.rows });
  }

  async function startTermSessionFor(inst, tab) {
    const d = inst.fitAddon.proposeDimensions() || { cols: 80, rows: 24 };
    // Each tab's shell opens in *that tab's* own dir: repo root for repo tabs,
    // the file's folder for file tabs. URL/none tabs have no local dir.
    // For a prototype file, also hand the shell the file itself (siblings share a
    // folder, so cwd alone can't say which file this tab is about).
    const cwd = tab.repoDir || tab.dir || null;
    const file = tab.kind === "file" ? (tab.src || null) : null;
    const res = await window.api.termStart({ tabKey: inst.key, cols: d.cols, rows: d.rows, cwd: cwd, file: file });
    if (res && res.error) {
      inst.term.write("\x1b[31mCouldn't start the terminal: " + res.error + "\x1b[0m\r\n");
      return;
    }
    inst.started = true;
    if (res && res.cwd) {
      inst.term.write("\x1b[90m" + res.cwd + "\x1b[0m\r\n");
      if (file) inst.term.write("\x1b[90mthis tab's file: " + file.split("/").pop() + "  ($OHANA_FILE)\x1b[0m\r\n");
    }
  }

  // Show the active tab's terminal (called from activateTab). Lazily creates +
  // starts the shell the first time the panel is open for that tab.
  function switchTerminalTo(tab) {
    activeTermKey = tab ? tab.key : null;
    termInstances.forEach((inst, key) => { inst.mount.style.display = (key === activeTermKey) ? "block" : "none"; });
    if (!termVisible || !tab) return;
    const inst = ensureTermInstance(tab);
    inst.mount.style.display = "block";
    setTimeout(async () => {
      try { inst.fitAddon.fit(); } catch (e) {}
      if (!inst.started) await startTermSessionFor(inst, tab);
      termSendResizeFor(inst);
      inst.term.focus();
    }, 60);
  }

  // Tear down a tab's terminal when its tab closes.
  function closeTerminalFor(key) {
    const inst = termInstances.get(key);
    if (!inst) return;
    window.api.termKill({ tabKey: key });
    try { inst.term.dispose(); } catch (e) {}
    if (inst.mount && inst.mount.parentNode) inst.mount.parentNode.removeChild(inst.mount);
    termInstances.delete(key);
    if (activeTermKey === key) activeTermKey = null;
  }

  function activeTermInstance() { return activeTermKey ? termInstances.get(activeTermKey) : null; }

  function toggleTerminal() {
    termVisible = !termVisible;
    termPanel.classList.toggle("visible", termVisible);
    document.getElementById("btn-terminal").classList.toggle("active", termVisible);
    adjustPanelsMargin(); // dock: webview shrinks to make room (or expands back)
    if (termVisible) switchTerminalTo(activeTab());
  }

  // ════════════════════════════════════════════════════════════════════
  //  Context panel — every .md under the active tab's folder, so you can
  //  see (and hand to the agent) the docs it can read. Read-only; refreshes
  //  on tab switch. HTML-only tabs show only .md siblings of the file.
  // ════════════════════════════════════════════════════════════════════
  let contextVisible = false;
  let contextFiles = [];
  let contextActiveTab = null;
  const contextPanel = document.getElementById("context-panel");

  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  async function loadContextForTab(tab) {
    contextActiveTab = tab;
    if (!contextVisible) return;
    const dir = tab && tab.dir ? tab.dir : null;
    if (!dir) { contextFiles = []; renderContext(); return; }
    try { contextFiles = (await window.api.contextList(dir)) || []; }
    catch (e) { contextFiles = []; }
    renderContext();
  }

  function renderContext() {
    const list = document.getElementById("ctx-list");
    const empty = document.getElementById("ctx-empty");
    const back = document.getElementById("ctx-preview");
    if (back) back.classList.remove("visible");
    list.innerHTML = "";
    if (!contextFiles.length) {
      empty.style.display = "";
      empty.textContent = contextActiveTab
        ? "No .md files in this folder."
        : "Open a file or repo to see its context.";
      return;
    }
    empty.style.display = "none";
    contextFiles.forEach((f) => {
      const row = document.createElement("div");
      row.className = "ctx-item";
      row.innerHTML =
        '<svg class="ctx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>' +
        '<span class="ctx-meta"><span class="ctx-name"></span><span class="ctx-rel"></span></span>' +
        '<button class="ctx-ref" title="Insert @path into the terminal">@</button>';
      row.querySelector(".ctx-name").textContent = f.name;
      row.querySelector(".ctx-rel").textContent = f.rel + (f.size ? " · " + fmtBytes(f.size) : "");
      row.querySelector(".ctx-ref").onclick = (e) => { e.stopPropagation(); insertContextRef(f); };
      row.onclick = () => previewContext(f);
      list.appendChild(row);
    });
  }

  async function previewContext(f) {
    const back = document.getElementById("ctx-preview");
    const body = document.getElementById("ctx-preview-body");
    document.getElementById("ctx-preview-name").textContent = f.name;
    body.textContent = "Loading…";
    back.classList.add("visible");
    const content = await window.api.contextRead(f.path);
    if (content != null) body.innerHTML = renderMarkdown(content);
    else body.textContent = "Couldn't read the file.";
  }

  // Write "@rel/path " into the active tab's terminal prompt (opening the
  // terminal if needed) so you can hand the file to the agent.
  function insertContextRef(f) {
    const at = activeTab();
    if (!at) return;
    if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
    setTimeout(() => window.api.termInput({ tabKey: at.key, data: "@" + f.rel + " " }), 260);
    showToast("Inserted @" + f.rel + " into the terminal", "check");
  }

  function toggleContext() {
    contextVisible = !contextVisible;
    contextPanel.classList.toggle("visible", contextVisible);
    const b = document.getElementById("btn-context"); if (b) b.classList.toggle("active", contextVisible); // header button removed — markdown lives in the left navigator
    adjustPanelsMargin();
    if (contextVisible) loadContextForTab(activeTab());
  }
  document.getElementById("ctx-close").onclick = toggleContext;
  document.getElementById("ctx-preview-back").onclick = () =>
    document.getElementById("ctx-preview").classList.remove("visible");
  document.getElementById("ctx-refresh").onclick = () => loadContextForTab(activeTab());

  // ════════════════════════════════════════════════════════════════════
  // Project navigator (floating panel) — a folder workspace's artifacts:
  // Flows (Moka boards) · Prototypes (.html) · Handoff · Design.
  // Collapsible per-section; collapses to an icon rail.
  // ════════════════════════════════════════════════════════════════════
  let projManifest = null, navCollapsed = false, navSecCollapsed = {};
  const NAV_SECTIONS = [
    { key: "boards", title: "Flows", art: "board", add: true },
    { key: "prototypes", title: "Prototypes", art: "html" },
    { key: "plans", title: "Plans", art: "md" },
    { key: "handoff", title: "Handoff", art: "md" },
    { key: "design", title: "Design", art: "md" },
  ];
  const FILE_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>';
  // Distinct glyphs per artifact type (like flow icons): .html = file with </>,
  // .md = file with text lines.
  const HTML_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/><path d="M10.5 12.5L8.5 14.5l2 2M13.5 12.5l2 2-2 2"/></svg>';
  const MD_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>';
  function navSecIcon(key) {
    if (key === "boards") return FI.workflow || FILE_IC;
    if (key === "prototypes") return FI.eye || FILE_IC;
    if (key === "plans") return FI.listChecks;
    if (key === "handoff") return FI.box || FILE_IC;
    if (key === "design") return FI.palette || FILE_IC;
    return FILE_IC;
  }
  function boardIc(b) { return b === "sitemap" ? (FI.workflow || FILE_IC) : FI.arrowRight; }
  function isProjectTab(t) { return !!(t && (t.kind === "new" || t.kind === "project") && t.dir); }
  // Repos get the navigator too (they're folders: flows/plans/handoff/design),
  // EXCEPT the Prototypes section — a repo's "prototype" is its running localhost.
  function isNavTab(t) { return isProjectTab(t) || !!(t && t.kind === "repo" && t.dir); }
  // Sync visibility + inset (runs cheaply on every view change).
  function updateNavVisibility() {
    const avail = isNavTab(activeTab());
    document.body.classList.toggle("nav-avail", avail);
    document.body.classList.toggle("nav-collapsed", avail && navCollapsed);
    if (typeof dockReady !== "undefined" && dockReady) adjustPanelsMargin();
  }
  function hideProjReader() {
    const r = document.getElementById("proj-reader"); if (r) r.classList.remove("visible");
    document.body.classList.remove("md-reading", "md-editing"); // toolbar context back to the artifact
  }
  // Scan cache — the disk walk (project:scan) + tags.json read are expensive to
  // run on every tab switch / flow:updated burst. We cache the manifest per dir
  // and only re-scan when it's stale or forced; concurrent calls coalesce.
  let _navScanDir = null, _navScanAt = 0, _navScanning = false, _navScanQueued = false;
  async function renderProjectNav(force) {
    updateNavVisibility();
    refreshGitCard(); // footer git card follows the same visibility (cheap: 8s cache)
    const at = activeTab();
    if (!isNavTab(at)) { projManifest = null; return; }
    document.getElementById("pn-name").textContent = at.name || "Project";
    const fresh = projManifest && _navScanDir === at.dir && (performance.now() - _navScanAt) < 600;
    if (fresh && !force) { paintProjectNav(at); return; }      // paint from cache, no disk I/O
    if (_navScanning) { _navScanQueued = true; return; }        // a scan is already running → let it repaint
    _navScanning = true;
    let m = null, tags = {};
    try { m = await window.api.projectScan(at.dir); } catch (e) {}
    try { const c = await window.api.ohanaReadFile("tags.json"); tags = c ? JSON.parse(c) : {}; } catch (e) {}
    _navScanning = false;
    if (activeTab() !== at) { if (_navScanQueued) { _navScanQueued = false; renderProjectNav(true); } return; }
    projManifest = m || { boards: [], prototypes: [], handoff: [], design: [], plans: [] };
    projTags = tags; _navScanDir = at.dir; _navScanAt = performance.now();
    paintProjectNav(at);
    if (_navScanQueued) { _navScanQueued = false; renderProjectNav(true); } // fold queued calls into one more scan
  }
  // Sync paint from the cached manifest/tags — no disk I/O.
  function paintProjectNav(at) {
    const m = projManifest || { boards: [], prototypes: [], handoff: [], design: [], plans: [] };
    const tags = projTags || {};
    const sections = at.kind === "repo" ? NAV_SECTIONS.filter((s) => s.key !== "prototypes") : NAV_SECTIONS;
    const body = document.getElementById("pn-body");
    // A repo tab's "prototype" is its running localhost — it's not a file the
    // scan can list, so give it a fixed card at the top to come back to after
    // opening design.md / a board (the reader replaces the center view).
    const REPO_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
    const repoActive = at.kind === "repo" && !at.artifact && !flowMode;
    const repoCard = at.kind === "repo"
      ? '<div class="pn-repo-card' + (repoActive ? " active" : "") + '" data-repoview="1" title="Back to the repo preview">' +
        '<span class="pn-repo-ic">' + REPO_IC + '</span>' +
        '<div class="pn-repo-txt"><span class="pn-repo-name">Preview</span>' +
        '<span class="pn-repo-url">' + escapeHtml((at.src || "").replace(/^https?:\/\//, "")) + '</span></div>' +
        '<span class="pn-repo-dot"></span></div>'
      : "";
    // Collapsed → icon rail (keeps the section icons visible).
    if (navCollapsed) {
      const repoRail = at.kind === "repo"
        ? '<div class="pn-rail-ic pn-rail-repo' + (repoActive ? " active" : "") + '" data-repoview="1" title="Repo preview">' + REPO_IC + '</div>'
        : "";
      body.innerHTML = '<div class="pn-rail">' + repoRail + sections.map((s) => {
        const n = (m[s.key] || []).length;
        return '<div class="pn-rail-ic" data-sec="' + s.key + '" title="' + escapeHtml(s.title) + '">' + navSecIcon(s.key) + (n ? '<span class="pn-rail-count">' + n + '</span>' : "") + '</div>';
      }).join("") + '</div>';
      return;
    }
    const art = at.artifact || {};
    const activeBoard = flowMode ? flowDoc.active : null;
    const moreBtn = '<button class="pn-more" title="Options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>';
    const item = (ic, icCls, label, attrs, activeItem, hasRef, rel, name, tagKey) => {
      const tg = tags[tagKey];
      const chip = tg && tg.name ? '<span class="pn-tag" style="--tc:' + escapeHtml(tg.color || "#7cb0ff") + '">' + escapeHtml(tg.name) + '</span>' : "";
      return '<div class="pn-item' + (activeItem ? " active" : "") + '" ' + attrs + (rel ? ' data-rel="' + escapeHtml(rel) + '"' : "") + ' data-name="' + escapeHtml(name || label) + '" data-tagkey="' + escapeHtml(tagKey || "") + '">' +
        '<span class="pn-ic ' + (icCls || "") + '">' + ic + '</span><span class="pn-label">' + escapeHtml(label) + '</span>' + chip +
        (hasRef ? '<button class="pn-ref" title="@ to the terminal">@</button>' : "") + moreBtn + '</div>';
    };
    body.innerHTML = repoCard + sections.map((s) => {
      let rows;
      if (s.art === "board") rows = (m.boards || []).map((b) => item(boardIc(b.board), "type-" + b.board, b.name, 'data-art="board" data-ref="' + b.id + '"', activeBoard === b.id, false, null, b.name, "board:" + b.id)).join("");
      else rows = (m[s.key] || []).map((p) => item(s.art === "html" ? HTML_IC : MD_IC, "type-" + s.art, p.name, 'data-art="' + s.art + '" data-ref="' + escapeHtml(p.path) + '"', art.path === p.path, true, p.rel, p.name, p.rel)).join("");
      const col = navSecCollapsed[s.key] ? " collapsed" : "";
      // Section header actions: Flows gets «+», Handoff gets ✦ generate + ↗ to-repo.
      let acts = "";
      if (s.key === "boards") acts = '<span class="pn-add" data-add="board" title="New flow">+</span>';
      if (s.key === "handoff") acts =
        '<span class="pn-add" data-add="handoff" title="Generate handoff — the agent distills the project">' + FI.sparkle + '</span>' +
        '<span class="pn-add" data-add="torepo" title="Take to a repository — implement the handoff">' + FI.arrowUpRight + '</span>';
      return '<div class="pn-sec' + col + '"><div class="pn-sec-h" data-sech="' + s.key + '">' +
        '<svg class="pn-sec-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>' +
        '<span class="pn-sec-hic">' + navSecIcon(s.key) + '</span>' +
        '<span class="pn-sec-title">' + escapeHtml(s.title) + '</span>' + acts + '</div>' +
        '<div class="pn-sec-items">' + (rows || '<div class="pn-empty">—</div>') + '</div></div>';
    }).join("");
  }
  // ── Git footer card (VS Code-style) ──────────────────────────────────
  // Branch + ahead/behind + pending changes for ANY nav tab (project or repo)
  // whose folder is a git worktree; folders without git never show it. Counts
  // are against the last-fetched upstream — no network calls.
  const pnGit = document.getElementById("pn-git");
  const GIT_BRANCH_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  const GIT_CHECK_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
  let _gitDir = null, _gitAt = 0, _gitBusy = false, _gitLast = null;
  async function refreshGitCard(force) {
    const at = activeTab();
    if (!isNavTab(at)) { pnGit.classList.remove("visible"); _gitDir = null; return; }
    const fresh = _gitDir === at.dir && (performance.now() - _gitAt) < 8000;
    if ((fresh && !force) || _gitBusy) return;
    _gitBusy = true;
    let st = null;
    try { st = await window.api.gitStatus(at.dir); } catch (e) {}
    _gitBusy = false;
    const cur = activeTab();
    if (!cur || cur.dir !== at.dir) { refreshGitCard(true); return; } // switched tab mid-flight
    _gitDir = at.dir; _gitAt = performance.now();
    if (!st || !st.git) { pnGit.classList.remove("visible"); return; }
    const synced = st.upstream && !st.ahead && !st.behind && !st.changes;
    let badges = "";
    if (synced) badges = '<span class="pn-git-ok">' + GIT_CHECK_IC + 'Synced</span>';
    else {
      if (st.upstream) badges += '<span class="pn-git-badge" title="Commits to pull / push">↓' + st.behind + " ↑" + st.ahead + "</span>";
      else badges += '<span class="pn-git-badge pn-git-noup" title="The branch has no upstream">no remote</span>';
      if (st.changes) badges += '<span class="pn-git-badge pn-git-dirty" title="Files with uncommitted changes">●' + st.changes + "</span>";
    }
    pnGit.innerHTML = '<span class="pn-git-ic">' + GIT_BRANCH_IC + '</span>' +
      '<span class="pn-git-branch">' + escapeHtml(st.branch) + '</span>' + badges;
    pnGit.title = "git — " + st.branch + (st.upstream ? " · ↓" + st.behind + " to pull · ↑" + st.ahead + " to push" : " · no upstream") + " · " + st.changes + " local changes. Click to see the details.";
    pnGit.classList.add("visible");
    _gitLast = st;
    if (document.querySelector(".pn-git-pop")) paintGitPopover(); // live-update an open popover
  }
  setInterval(() => { if (document.body.classList.contains("nav-avail")) refreshGitCard(); }, 10000);

  // Detail popover (VS Code's SCM view, in miniature): upstream + sync counts +
  // changed files with their status letter, plus a hand-off to the tab's agent.
  const GIT_ST_LABEL = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "New (untracked)", C: "Copied", T: "Type changed" };
  function closeGitPopover() { document.querySelectorAll(".pn-git-pop").forEach((n) => n.remove()); }
  function paintGitPopover() {
    const pop = document.querySelector(".pn-git-pop"); const st = _gitLast;
    if (!pop || !st) return;
    const syncLine = st.upstream
      ? (st.ahead || st.behind
        ? "↓" + st.behind + " to pull · ↑" + st.ahead + " to push"
        : "Up to date with " + escapeHtml(st.upstreamName || "the remote"))
      : "The branch has no upstream";
    const rows = (st.files || []).map((f) =>
      '<div class="pn-git-file" title="' + escapeHtml((GIT_ST_LABEL[f.st] || f.st) + " — " + f.path) + '">' +
      '<span class="pn-git-st st-' + escapeHtml(f.st) + '">' + escapeHtml(f.st) + '</span>' +
      '<span class="pn-git-path">' + escapeHtml(f.path) + '</span></div>').join("");
    const more = st.changes > (st.files || []).length ? '<div class="pn-git-more">+' + (st.changes - st.files.length) + ' more</div>' : "";
    const action = st.changes
      ? '<button class="pn-git-act" data-act="commit">Commit with the agent</button>'
      : (st.upstream && (st.ahead || st.behind) ? '<button class="pn-git-act" data-act="sync">Sync with the agent</button>' : "");
    pop.innerHTML =
      '<div class="pn-git-pop-h">' + GIT_BRANCH_IC + '<b>' + escapeHtml(st.branch) + '</b>' +
      (st.upstreamName ? '<span class="pn-git-up">→ ' + escapeHtml(st.upstreamName) + '</span>' : "") + '</div>' +
      '<div class="pn-git-sync">' + syncLine + '</div>' +
      (st.changes ? '<div class="pn-git-sec">Local changes (' + st.changes + ')</div><div class="pn-git-files">' + rows + more + '</div>' : "") +
      (action ? '<div class="pn-git-pop-f">' + action + '</div>' : "");
    const act = pop.querySelector(".pn-git-act");
    if (act) act.onclick = () => {
      const at = activeTab(); if (!at) return;
      const md = act.dataset.act === "commit"
        ? "Commit this repo's pending changes: review `git status` and `git diff`, group related changes together, and write clear messages. Don't push without confirming with me first."
        : "Sync this repo with its upstream: `git pull` first (let me know if there are conflicts instead of resolving them by force) and then `git push` if there are local commits.";
      if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
      setTimeout(() => window.api.termInput({ tabKey: at.key, data: md }), 240);
      closeGitPopover(); showToast("Sent to the terminal", "check");
    };
  }
  pnGit.addEventListener("click", () => {
    if (document.querySelector(".pn-git-pop")) { closeGitPopover(); return; }
    const pop = document.createElement("div"); pop.className = "pn-git-pop";
    const r = pnGit.getBoundingClientRect();
    pop.style.left = r.left + "px";
    pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
    document.body.appendChild(pop);
    paintGitPopover(); // instant paint from cache…
    refreshGitCard(true); // …then repaint with fresh data when it lands
    const out = (ev) => { if (!pop.contains(ev.target) && !pnGit.contains(ev.target)) { closeGitPopover(); document.removeEventListener("mousedown", out, true); } };
    setTimeout(() => document.addEventListener("mousedown", out, true), 0);
  });

  // ⋯ menu per item: Duplicate / Delete.
  // ── Phase 3: Handoff → Repository (Ohana orchestrates, the agent executes) ──
  // «Generate handoff»: the agent distills the whole project into handoff/*.md.
  function runHandoffGenerate() {
    const at = requireAnchor(); if (!at) return;
    const md =
      "Generate the HANDOFF documentation for this project in the `handoff/` folder (create it if missing). It's the package a team takes to a repository: short, actionable, ready to become Linear issues.\n\n" +
      "SOURCES (read them before writing):\n" +
      "- The Moka boards: use the MCP tools (`ohana_status`, `ohana_flow_list`, `ohana_flow_read`) or `.ohana/flow.json` — screens with their handles (P1…), sections→components, connections with their semantics (Yes/No, Success/Error labels), APIs, and linked views.\n" +
      "- The prototypes in `" + projDirNames().prototypes + "/*.html` (visual and interaction reference).\n" +
      "- `design.md` (tokens, voice and tone, principles) and the plans in `" + projDirNames().plans + "/`.\n" +
      "- The prototype comments (`ohana_list_comments`): the resolved ones are decisions already made.\n\n" +
      "OUTPUT STRUCTURE:\n" +
      "- `handoff/00-overview.md` — project vision, scope, flow map (name them by name + board type).\n" +
      "- One doc per flow: `handoff/<n>-<flow-slug>.md` with: epic and context · user stories with acceptance criteria (Given/When/Then) · screen references by handle (P1…) · card endpoints/APIs · states and branches (positive/negative) · link to the prototype if one exists.\n\n" +
      "RULES: clear neutral English; do NOT invent scope that isn't in the boards/prototypes/comments; if something is ambiguous, mark it as «Open question». The docs appear live in Ohana's Handoff panel.";
    sendToTerminal(at, md, "Instruction sent — the docs will appear in Handoff");
  }
  // «Llevar a repositorio»: pick the destination repo and ask the agent to implement the handoff there.
  async function takeToRepo() {
    const at = requireAnchor(); if (!at) return;
    const m = projManifest || {};
    if (!(m.handoff || []).length) { showToast("Generate the handoff first (✦)", "warn"); return; }
    const dir = await window.api.pickFolder(); if (!dir) return;
    const md =
      "Implement in the repository `" + dir + "` what's defined in this project's handoff documentation (`" + (at.dir || "") + "/handoff/`).\n" +
      "- Read ALL the .md files in `handoff/` (and `design.md` for tokens/voice) BEFORE touching code.\n" +
      "- Respect the destination repo's stack and conventions (check its package.json, README, and structure).\n" +
      "- Work story by story, in the order of the docs; if the repo uses git, one commit per story (don't push).\n" +
      "- The prototypes in `" + projDirNames().prototypes + "/*.html` are the visual reference — replicate the intent, not the literal HTML.\n" +
      "- When you're done: summarize what got implemented, what's still pending, and how to run the project.";
    sendToTerminal(at, md, "Instruction sent — when the dev server runs, open it as a Repo");
  }
  // Folder names this project actually uses (legacy Spanish `prototipos/planes`
  // or English `prototypes/plans`) — resolved by main during the last scan.
  function projDirNames() { return (projManifest && projManifest.dirs) || { prototypes: "prototypes", plans: "plans" }; }
  let projTags = {}; // current project's tags (loaded on nav render)
  function saveProjTags() { try { window.api.ohanaWriteFile({ filename: "tags.json", content: JSON.stringify(projTags, null, 2) }); } catch (e) {} }
  function openNavItemMenu(itemEl, x, y) {
    const art = itemEl.dataset.art, ref = itemEl.dataset.ref, name = itemEl.dataset.name || "", tagKey = itemEl.dataset.tagkey || "";
    document.querySelectorAll(".pn-menu").forEach((n) => n.remove());
    const menu = document.createElement("div"); menu.className = "pn-menu"; menu.style.cssText = "left:" + x + "px;top:" + y + "px;";
    menu.innerHTML =
      '<button data-a="ren">' + FI.edit + 'Rename</button>' +
      '<button data-a="tag">' + FI.tag + 'Tag…</button>' +
      '<button data-a="dup">' + FI.dup + 'Duplicate</button>' +
      '<button data-a="del" class="danger">' + FI.trash + 'Delete</button>';
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener("mousedown", out, true); };
    const out = (ev) => { if (!menu.contains(ev.target)) close(); };
    menu.querySelector('[data-a="ren"]').onclick = () => { close(); openRenamePopover(art, ref, name, x, y); };
    menu.querySelector('[data-a="tag"]').onclick = () => { close(); openTagPopover(tagKey, x, y); };
    menu.querySelector('[data-a="dup"]').onclick = () => { close(); if (art === "board") duplicateBoard(ref); else duplicateFile(ref); };
    menu.querySelector('[data-a="del"]').onclick = () => { close(); if (art === "board") deleteBoard(ref); else deleteFile(ref, name); };
    setTimeout(() => document.addEventListener("mousedown", out, true), 0);
  }
  // Rename: boards rename inside flow.json; files rename on disk (keeps the extension).
  function openRenamePopover(art, ref, currentName, x, y) {
    document.querySelectorAll(".pn-menu").forEach((n) => n.remove());
    const pop = document.createElement("div"); pop.className = "pn-menu pn-form"; pop.style.cssText = "left:" + x + "px;top:" + y + "px;";
    pop.innerHTML = '<input class="pn-input" spellcheck="false" placeholder="New name" />';
    document.body.appendChild(pop);
    const inp = pop.querySelector("input"); inp.value = currentName; inp.focus(); inp.select();
    const close = () => { pop.remove(); document.removeEventListener("mousedown", out, true); };
    const out = (ev) => { if (!pop.contains(ev.target)) close(); };
    inp.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Enter") return;
      const nv = inp.value.trim(); close();
      if (!nv || nv === currentName) return;
      if (art === "board") {
        await loadFlowForActive({ noEnsure: true });
        const f = (flowDoc.flows || []).find((b) => b.id === ref); if (!f) return;
        f.name = nv; saveFlow(); writeFlowFile(); renderFlowSwitcher(); renderProjectNav(true); showToast("Flow renamed", "check");
      } else {
        const dest = await window.api.projectRenameFile({ path: ref, newName: nv });
        if (!dest) { showToast("Couldn't rename (name in use?)", "warn"); return; }
        const at = activeTab();
        // Keep references + tag in sync with the new path.
        const oldRel = (Array.prototype.find.call(document.querySelectorAll(".pn-item"), (el) => el.dataset.ref === ref) || {}).dataset;
        if (at && at.artifact && at.artifact.path === ref) at.artifact.path = dest;
        if (at && at.previewPath === ref) { at.previewPath = dest; if (at.wv) { at.wv.remove(); at.wv = null; at.wvReady = false; } if (at.artifact && at.artifact.kind === "html") mountWebview(at); }
        const relOld = oldRel && oldRel.tagkey; const relNew = at && at.dir ? dest.slice(at.dir.length + 1) : dest;
        if (relOld && projTags[relOld]) { projTags[relNew] = projTags[relOld]; delete projTags[relOld]; saveProjTags(); }
        renderProjectNav(true); showToast("Renamed", "check");
      }
    });
    setTimeout(() => document.addEventListener("mousedown", out, true), 0);
  }
  // Tag: name + color per item, stored per project (.ohana/tags.json).
  const TAG_COLORS = ["#7cb0ff", "#f5d90a", "#46c890", "#f87171", "#a78bfa", "#fb923c", "#9aa3b2"];
  function openTagPopover(tagKey, x, y) {
    if (!tagKey) return;
    document.querySelectorAll(".pn-menu").forEach((n) => n.remove());
    const cur = projTags[tagKey] || {};
    const pop = document.createElement("div"); pop.className = "pn-menu pn-form"; pop.style.cssText = "left:" + x + "px;top:" + y + "px;";
    pop.innerHTML =
      '<input class="pn-input" spellcheck="false" placeholder="Tag name" />' +
      '<div class="pn-swatches">' + TAG_COLORS.map((c) => '<button class="pn-sw' + (cur.color === c ? " on" : "") + '" data-c="' + c + '" style="--c:' + c + '"></button>').join("") + '</div>' +
      '<div class="pn-form-actions"><button class="pn-fbtn" data-a="clear">Remove</button><button class="pn-fbtn accent" data-a="save">Save</button></div>';
    document.body.appendChild(pop);
    const inp = pop.querySelector("input"); inp.value = cur.name || ""; inp.focus();
    let color = cur.color || TAG_COLORS[0];
    pop.querySelectorAll(".pn-sw").forEach((b) => b.onclick = () => { color = b.dataset.c; pop.querySelectorAll(".pn-sw").forEach((x2) => x2.classList.toggle("on", x2 === b)); });
    const close = () => { pop.remove(); document.removeEventListener("mousedown", out, true); };
    const out = (ev) => { if (!pop.contains(ev.target)) close(); };
    const save = () => { const nm = inp.value.trim(); close(); if (!nm) { delete projTags[tagKey]; } else { projTags[tagKey] = { name: nm, color: color }; } saveProjTags(); renderProjectNav(true); };
    pop.querySelector('[data-a="save"]').onclick = save;
    pop.querySelector('[data-a="clear"]').onclick = () => { close(); delete projTags[tagKey]; saveProjTags(); renderProjectNav(true); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") close(); });
    setTimeout(() => document.addEventListener("mousedown", out, true), 0);
  }
  async function duplicateBoard(id) {
    await loadFlowForActive({ noEnsure: true });
    const f = (flowDoc.flows || []).find((x) => x.id === id); if (!f) return;
    const c = JSON.parse(JSON.stringify(f)); c.id = flowGenId(); c.name = (f.name || "Flow") + " copy";
    flowDoc.flows.push(c); saveFlow(); writeFlowFile(); // flush now — the nav rescans from disk
    renderFlowSwitcher(); renderProjectNav(true); showToast("Flow duplicated", "check");
  }
  async function deleteBoard(id) {
    await loadFlowForActive({ noEnsure: true });
    const i = (flowDoc.flows || []).findIndex((x) => x.id === id); if (i < 0) return;
    flowDoc.flows.splice(i, 1);
    if (flowDoc.active === id) flowDoc.active = flowDoc.flows[0] ? flowDoc.flows[0].id : null;
    if (flow && flow.id === id) { flowMode = false; syncView(); }
    saveFlow(); writeFlowFile(); // flush now — the nav rescans from disk
    renderFlowSwitcher(); renderProjectNav(true); showToast("Flow deleted", "refresh-cw");
  }
  async function duplicateFile(p) {
    try { const r = await window.api.projectDuplicateFile(p); if (r) { showToast("File duplicated", "check"); renderProjectNav(true); } else showToast("Couldn't duplicate", "warn"); } catch (e) { showToast("Couldn't duplicate", "warn"); }
  }
  async function deleteFile(p, name) {
    try {
      const r = await window.api.projectDeleteFile(p); if (!r) { showToast("Couldn't delete", "warn"); return; }
      const at = activeTab();
      if (prPath === p) { prPath = null; prDirty = false; } // never auto-save a file we just deleted
      if (at && at.artifact && at.artifact.path === p) { at.artifact = null; hideProjReader(); if (at.previewPath === p) { at.previewPath = null; if (at.wv) { at.wv.remove(); at.wv = null; at.wvReady = false; } syncView(); } }
      showToast("Deleted " + (name || ""), "refresh-cw"); renderProjectNav(true);
    } catch (e) { showToast("Couldn't delete", "warn"); }
  }
  // Open a Moka board in place (bypasses the disk reload so any board of the
  // project shows, regardless of its src owner).
  async function openBoard(id) {
    const at = activeTab(); if (!at) return;
    // The mode switch is gone, so flowDoc may not be loaded yet — always sync
    // from disk before operating (also protects against clobbering flow.json).
    await loadFlowForActive({ noEnsure: true });
    const f = (flowDoc.flows || []).find((x) => x.id === id); if (!f) return;
    saveReaderDoc(); // auto-save any doc being edited before leaving the reader
    hideProjReader();
    // Boards belong to the PROJECT (folder). Claim this one to the project's src so
    // both the on-disk reload and the agent's MCP (which targets by src) operate on
    // the board you're actually viewing — no more per-file ownership surprises.
    const owner = at.src || at.dir; if (owner) f.src = owner;
    at.artifact = { kind: "board", id: id }; saveSession(); // per-tab memory: this tab is on a board
    flowDoc.active = id; bindTabFlow(id);
    flow = f; flowSel = new Set();
    flowMode = true; syncView(); closeFlowMenu();
    saveFlow(); writeFlowFile(); // flush now — the nav rescans from disk
    renderFlow(); renderFlowSwitcher(); renderProjectNav(true);
  }
  async function createBoard(type) {
    const at = activeTab(); if (!at) return;
    await loadFlowForActive({ noEnsure: true }); // fresh doc from disk — never clobber existing boards
    const n = (flowDoc.flows || []).length + 1;
    const f = { id: flowGenId(), name: (type === "sitemap" ? "Sitemap " : "Flow ") + n, board: type === "sitemap" ? "sitemap" : "userflow", src: at.src || at.dir || null, screens: [], edges: [] };
    flowDoc.flows.push(f); flowDoc.active = f.id; bindTabFlow(f.id);
    at.artifact = { kind: "board", id: f.id }; // per-tab memory
    flow = f; flowSel = new Set(); flowView = { x: 40, y: 40, s: 1 };
    flowMode = true; syncView(); closeFlowMenu();
    saveFlow(); writeFlowFile(); // flush now — the nav rescans from disk
    renderFlow(); renderFlowSwitcher(); renderProjectNav(true);
  }
  // Tiny type picker for "+ Flow" (type is chosen at creation, no toggle).
  // Uses the same glass menu style as the ⋯ menu for consistency.
  function openBoardCreator(x, y) {
    document.querySelectorAll(".pn-menu").forEach((n) => n.remove());
    const m = document.createElement("div"); m.className = "pn-menu"; m.style.cssText = "left:" + x + "px;top:" + y + "px;";
    m.innerHTML = '<button data-t="userflow">' + boardIc("userflow") + 'User flow</button><button data-t="sitemap">' + boardIc("sitemap") + 'Sitemap</button>';
    document.body.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener("mousedown", out, true); };
    const out = (ev) => { if (!m.contains(ev.target)) close(); };
    m.querySelectorAll("button").forEach((b) => b.onclick = () => { createBoard(b.dataset.t); close(); });
    setTimeout(() => document.addEventListener("mousedown", out, true), 0);
  }
  function openPrototypeArtifact(t, p) {
    saveReaderDoc(); // auto-save any doc being edited before leaving the reader
    hideProjReader();
    if (flowMode) { flowMode = false; syncView(); }
    t.artifact = { kind: "html", path: p };
    if (t.previewPath !== p) { if (t.wv) { t.wv.remove(); t.wv = null; t.wvReady = false; } t.previewPath = p; }
    mountWebview(t);
    renderProjectNav(); saveSession();
  }
  // Back to a repo tab's localhost preview (its "prototype"): drop whatever
  // artifact owns the center (reader/board) and remount the repo webview.
  async function openRepoPreview() {
    const t = activeTab(); if (!t || t.kind !== "repo") return;
    await saveReaderDoc();
    hideProjReader();
    if (flowMode) { flowMode = false; syncView(); }
    t.artifact = null;
    mountWebview(t);
    renderProjectNav(); saveSession();
  }
  let prPath = null, prRel = null, prDirty = false, prSource = "";
  // Serialize the rendered (contenteditable) DOM back to markdown — covers the
  // subset renderMarkdown produces: headings, p/div, lists, quote, pre, table, hr,
  // strong/em/code/links. Decorative spans (swatches, highlights) fold into text.
  // htmlToMd → src/lib/markdown.js (window.OhanaMD)
  async function openDocArtifact(p, name, rel) {
    await saveReaderDoc(); // auto-save whatever doc was being edited before switching
    if (flowMode) { flowMode = false; syncView(); }
    tabs.forEach((x) => { if (x.wv) x.wv.classList.add("wv-hidden"); }); // reader is HTML; hide native webviews behind it
    const at = activeTab(); if (at) { at.artifact = { kind: "md", path: p, rel: rel || null }; saveSession(); }
    renderProjectNav();
    prPath = p; prRel = rel || name; prDirty = false; prSource = "";
    document.getElementById("pr-name").textContent = name || p.split("/").pop();
    document.getElementById("pr-project").textContent = at ? (at.name || "") : ""; // project name, like Moka's topbar
    const reader = document.getElementById("proj-reader");
    setReaderMode("preview");
    reader.classList.add("visible");
    document.body.classList.add("md-reading"); // reader owns the center → toolbar goes quiet
    const body = document.getElementById("pr-body"); body.textContent = "Loading…";
    const content = await window.api.contextRead(p);
    if (prPath !== p) return; // opened another doc meanwhile
    prSource = content != null ? content : "";
    body.innerHTML = content != null ? renderMarkdown(prSource) : "Couldn't read the file.";
  }
  function setReaderMode(mode) {
    const reader = document.getElementById("proj-reader");
    const body = document.getElementById("pr-body");
    reader.classList.toggle("mode-edit", mode === "edit");
    document.getElementById("pr-tab-preview").classList.toggle("active", mode !== "edit");
    document.getElementById("pr-tab-edit").classList.toggle("active", mode === "edit");
    // WYSIWYG: editing happens ON the render itself, never on raw markdown.
    body.contentEditable = mode === "edit" ? "true" : "false";
    document.body.classList.toggle("md-editing", mode === "edit"); // toolbar shows the markdown text tools
    if (mode === "edit") { try { document.execCommand("styleWithCSS", false, false); } catch (e) {} setTimeout(() => body.focus(), 0); }
  }
  // Markdown text tools (toolbar, edit mode): headings, bold/italic/code, lists, quote.
  function mdCmd(a) {
    const body = document.getElementById("pr-body"); body.focus();
    const block = () => (document.queryCommandValue("formatBlock") || "").toLowerCase();
    if (a === "h1" || a === "h2" || a === "h3") document.execCommand("formatBlock", false, block() === a ? "P" : a.toUpperCase());
    else if (a === "bold") document.execCommand("bold");
    else if (a === "italic") document.execCommand("italic");
    else if (a === "ul") document.execCommand("insertUnorderedList");
    else if (a === "ol") document.execCommand("insertOrderedList");
    else if (a === "quote") document.execCommand("formatBlock", false, block() === "blockquote" ? "P" : "BLOCKQUOTE");
    else if (a === "code") {
      const sel = window.getSelection();
      if (sel.rangeCount && !sel.isCollapsed) {
        const r = sel.getRangeAt(0), c = document.createElement("code");
        try { r.surroundContents(c); } catch (e) { document.execCommand("insertHTML", false, "<code>" + sel.toString().replace(/</g, "&lt;") + "</code>"); }
      }
    }
    prDirty = true;
  }
  document.querySelectorAll("#toolbar [data-md]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection alive
    b.addEventListener("click", () => mdCmd(b.dataset.md));
  });
  async function saveReaderDoc() {
    if (!prPath || !prDirty) return true;
    prSource = htmlToMd(document.getElementById("pr-body"));
    const ok = await window.api.projectWriteFile({ path: prPath, content: prSource });
    if (ok) { prDirty = false; showToast("Saved", "check"); } else showToast("Couldn't save", "warn");
    return ok;
  }
  document.getElementById("pn-body").addEventListener("click", (e) => {
    // Collapsed rail → click an icon to expand.
    const rail = e.target.closest(".pn-rail-ic");
    if (rail) { navCollapsed = false; updateNavVisibility(); renderProjectNav(); return; }
    // Section header → toggle that section (unless an action was clicked).
    const add = e.target.closest(".pn-add");
    if (add) {
      const r = add.getBoundingClientRect();
      if (add.dataset.add === "handoff") runHandoffGenerate();
      else if (add.dataset.add === "torepo") takeToRepo();
      else openBoardCreator(r.left, r.bottom + 4);
      return;
    }
    const sech = e.target.closest(".pn-sec-h");
    if (sech) { const k = sech.dataset.sech; navSecCollapsed[k] = !navSecCollapsed[k]; renderProjectNav(); return; }
    if (e.target.closest("[data-repoview]")) { openRepoPreview(); return; }
    const item = e.target.closest(".pn-item"); if (!item) return;
    if (e.target.closest(".pn-more")) { const r = e.target.closest(".pn-more").getBoundingClientRect(); openNavItemMenu(item, Math.max(8, r.right - 150), r.bottom + 4); return; }
    if (e.target.closest(".pn-ref")) {
      const at = activeTab(); const rel = item.dataset.rel;
      if (at && rel) { if (!termVisible) toggleTerminal(); else switchTerminalTo(at); setTimeout(() => window.api.termInput({ tabKey: at.key, data: "@" + rel + " " }), 240); showToast("Inserted @" + rel, "check"); }
      return;
    }
    const at = activeTab(); if (!at) return;
    const art = item.dataset.art, ref = item.dataset.ref;
    if (art === "board") openBoard(ref);
    else if (art === "html") openPrototypeArtifact(at, ref);
    else if (art === "md") openDocArtifact(ref, item.dataset.name, item.dataset.rel);
  });
  document.getElementById("pn-collapse").onclick = () => { navCollapsed = !navCollapsed; updateNavVisibility(); renderProjectNav(); };
  document.getElementById("pr-tab-preview").onclick = async () => {
    await saveReaderDoc(); // auto-save on switching back to preview
    setReaderMode("preview");
    document.getElementById("pr-body").innerHTML = renderMarkdown(prSource); // clean re-render
  };
  document.getElementById("pr-tab-edit").onclick = () => setReaderMode("edit");
  document.getElementById("pr-body").addEventListener("input", () => { if (document.getElementById("proj-reader").classList.contains("mode-edit")) prDirty = true; });
  document.getElementById("pr-body").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveReaderDoc(); } });
  document.getElementById("pr-ref").onclick = () => { const a = activeTab(); if (a && prRel) { if (!termVisible) toggleTerminal(); else switchTerminalTo(a); setTimeout(() => window.api.termInput({ tabKey: a.key, data: "@" + prRel + " " }), 240); showToast("Inserted @" + prRel, "check"); } };
  document.getElementById("pr-close").onclick = async () => { await saveReaderDoc(); hideProjReader(); const at = activeTab(); if (at) { at.artifact = null; if (at.previewPath || at.kind === "repo") mountWebview(at); } renderProjectNav(); };

  // ════════════════════════════════════════════════════════════════════
  //  Components panel — browse the design system's components (from
  //  components.json): variants, usage, anti-patterns. A reference while you
  //  prototype, plus insert a component reference into the tab's terminal.
  // ════════════════════════════════════════════════════════════════════
  let componentsVisible = false;
  const componentsPanel = document.getElementById("components-panel");

  function renderComponents() {
    const list = document.getElementById("cp-list");
    const empty = document.getElementById("cp-empty");
    const srcEl = document.getElementById("cp-source");
    if (_sbObserver) { _sbObserver.disconnect(); _sbObserver = null; } // stale iframes get re-observed below
    list.innerHTML = "";
    const at = activeTab();
    const sbInput = document.getElementById("cp-sb-url");
    if (sbInput && document.activeElement !== sbInput) sbInput.value = (at && at.storybookUrl) || "";
    const pickedEl = document.getElementById("cp-picked");
    if (pickedEl) pickedEl.textContent = (at && at.componentsDir) ? ("Folder: " + at.componentsDir) : "";
    if (srcEl) {
      const label = COMPONENT_SOURCE_LABEL[componentSource] || "";
      srcEl.textContent = componentMeta.length ? (componentMeta.length + " components · " + label) : "";
      srcEl.style.display = (componentMeta.length && label) ? "" : "none";
    }
    if (!componentMeta.length) { empty.style.display = ""; return; }
    empty.style.display = "none";
    componentMeta.forEach((c) => {
      const card = document.createElement("div"); card.className = "cp-card";
      const head = document.createElement("div"); head.className = "cp-card-head";
      const name = document.createElement("span"); name.className = "cp-name"; name.textContent = c.name || "Component";
      const ins = document.createElement("button"); ins.className = "ctx-ref"; ins.textContent = "@"; ins.title = "Insert reference into the terminal";
      ins.onclick = (e) => { e.stopPropagation(); insertComponentRef(c); };
      head.appendChild(name); head.appendChild(ins); card.appendChild(head);
      const pv = buildComponentPreview(c);
      if (pv) card.appendChild(pv);
      if (c.use) { const u = document.createElement("div"); u.className = "cp-use"; u.textContent = c.use; card.appendChild(u); }
      (c.props || []).forEach((p) => {
        const row = document.createElement("div"); row.className = "cp-prop";
        const hasOpts = (p.options || []).length > 0;
        const nm = document.createElement("span"); nm.className = "cp-prop-name"; nm.textContent = (p.label || p.name) + (hasOpts ? ":" : "");
        const op = document.createElement("span"); op.className = "cp-prop-opts"; op.textContent = hasOpts ? p.options.join(" · ") : "";
        row.appendChild(nm); row.appendChild(op); card.appendChild(row);
      });
      if (c.antiPatterns && c.antiPatterns.length) {
        const anti = document.createElement("ul"); anti.className = "cp-anti";
        c.antiPatterns.forEach((a) => { const li = document.createElement("li"); li.textContent = a; anti.appendChild(li); });
        card.appendChild(anti);
      }
      list.appendChild(card);
    });
  }
  // Visual preview of a component in the panel, when the catalog provides one.
  //  - c.preview as an image (data:/http/.png/.svg…) → <img>
  //  - c.preview as an HTML snippet → sandboxed iframe (+ the DS stylesheet if
  //    the catalog declared one), so you see the real component + its look.
  // Degrades to nothing when the catalog ships no preview data.
  let _sbObserver = null;
  function buildComponentPreview(c) {
    const p = c.preview || c.thumbnail;
    // 1. Catalog-provided preview (image or inline HTML)
    if (p && typeof p === "string") {
      const isImg = /^data:image\//.test(p) || /\.(png|jpe?g|svg|webp|gif)(\?|$)/i.test(p);
      const box = document.createElement("div"); box.className = "cp-preview";
      if (isImg) {
        const img = document.createElement("img"); img.className = "cp-preview-img"; img.loading = "lazy"; img.src = p;
        img.onerror = () => box.remove();
        box.appendChild(img); return box;
      }
      if (p.indexOf("<") !== -1) {
        const cssLink = componentCss ? '<link rel="stylesheet" href="' + componentCss.replace(/"/g, "&quot;") + '">' : "";
        const doc = '<!doctype html><meta charset="utf-8">' + cssLink
          + '<style>html,body{margin:0;padding:10px;background:transparent;font-family:system-ui,sans-serif;}</style>'
          + '<body>' + p + '</body>';
        const ifr = document.createElement("iframe");
        ifr.className = "cp-preview-frame"; ifr.setAttribute("sandbox", "allow-same-origin"); ifr.srcdoc = doc;
        box.appendChild(ifr); return box;
      }
    }
    // 2. Storybook preview (real component render). Lazy-loaded on scroll so we
    //    don't spin up dozens of iframes at once.
    const sid = storyIdFor(c.name);
    if (sbBase && sid) {
      const box = document.createElement("div"); box.className = "cp-preview";
      const ifr = document.createElement("iframe");
      ifr.className = "cp-preview-frame";
      // Storybook is a JS app (needs scripts), but cross-origin to Ohana — sandbox
      // it so it can render but not navigate the top window or open popups.
      ifr.setAttribute("sandbox", "allow-scripts allow-same-origin");
      ifr.setAttribute("referrerpolicy", "no-referrer");
      ifr.dataset.src = sbBase + "/iframe.html?id=" + encodeURIComponent(sid) + "&viewMode=story&singleStory=true&shortcuts=false";
      box.appendChild(ifr);
      if (!_sbObserver) {
        _sbObserver = new IntersectionObserver((ents) => {
          ents.forEach((e) => { if (e.isIntersecting && e.target.dataset.src) { e.target.src = e.target.dataset.src; delete e.target.dataset.src; _sbObserver.unobserve(e.target); } });
        }, { root: null, rootMargin: "200px" });
      }
      _sbObserver.observe(ifr);
      return box;
    }
    return null;
  }

  function insertComponentRef(c) {
    const at = activeTab();
    if (!at) return;
    if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
    const variants = (c.props || []).map((p) => (p.label || p.name) + " (" + (p.options || []).join("/") + ")").join(", ");
    const ref = "the " + (c.name || "") + " component" + (variants ? " [" + variants + "]" : "") + " ";
    setTimeout(() => window.api.termInput({ tabKey: at.key, data: ref }), 260);
    showToast("Inserted: " + (c.name || "component"), "check");
  }
  function toggleComponents() {
    componentsVisible = !componentsVisible;
    componentsPanel.classList.toggle("visible", componentsVisible);
    document.getElementById("btn-components").classList.toggle("active", componentsVisible);
    adjustPanelsMargin();
    if (componentsVisible) renderComponents();
  }
  document.getElementById("btn-components").onclick = toggleComponents;
  document.getElementById("cp-close").onclick = toggleComponents;
  document.getElementById("cp-refresh").onclick = async () => { await loadComponentMeta({ force: true }); renderComponents(); };
  // Point this tab's component catalog at a folder on disk (for URL/localhost
  // tabs whose repo dir Ohana can't infer). Remembered per tab + persisted.
  // Connect a Storybook URL for this tab → live previews in the panel.
  document.getElementById("cp-sb-set").onclick = async () => {
    const at = activeTab(); if (!at) return;
    const v = document.getElementById("cp-sb-url").value.trim();
    at.storybookUrl = v || null;
    saveSession();
    await loadStorybookIndex();
    renderComponents();
    showToast(sbBase ? ("Storybook connected · " + Object.keys(sbMap || {}).length + " components") : (v ? "Couldn't read Storybook" : "Storybook disconnected"), sbBase ? "check" : "warn");
  };
  document.getElementById("cp-sb-url").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("cp-sb-set").click(); });

  document.getElementById("cp-pick").onclick = async () => {
    const dir = await window.api.pickFolder();
    if (!dir) return;
    const at = activeTab();
    if (at) { at.componentsDir = dir; saveSession(); }
    showToast("Folder: " + dir.split("/").pop(), "check");
    await loadComponentMeta({ force: true });
    renderComponents();
  };
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); toggleComponents(); }
  });

  // ════════════════════════════════════════════════════════════════════
  //  Network panel — devtools amables. Focused list of the preview's requests
  //  (API by default), response bodies on demand, and one-click cache clear.
  // ════════════════════════════════════════════════════════════════════
  let networkVisible = false;
  let netData = [];
  let consoleData = [];
  let netFilter = "api"; // "api" (XHR/Fetch) | "all" | "console"
  let netQuery = "";     // general URL search
  let netPreviewing = null; // the request currently shown in the preview
  const networkPanel = document.getElementById("network-panel");

  // Per-tab capture: main tags every list with the webview's webContents id.
  // Cache it on the owning tab; only the ACTIVE tab's data drives the panel.
  window.api.on("net:list", (msg) => {
    const t = tabs.find((x) => x.wcId === msg.wcId);
    if (t) t._netData = msg.list || [];
    const at = activeTab();
    if (!at || at.wcId !== msg.wcId) return; // background tab — cache only
    netData = msg.list || [];
    // Refresh the LIST only. Never touch an open detail — replacing it while the
    // user is reading made the response "disappear" whenever a newer request to
    // the same endpoint arrived. The detail stays until they go back or pick another.
    if (networkVisible && netFilter !== "console") renderNetwork();
  });
  window.api.on("console:list", (msg) => {
    const t = tabs.find((x) => x.wcId === msg.wcId);
    if (t) t._consoleData = msg.list || [];
    const at = activeTab();
    if (!at || at.wcId !== msg.wcId) return;
    consoleData = msg.list || [];
    updateNetErrBadge();
    if (networkVisible && netFilter === "console") renderNetwork();
  });
  // On tab switch, swap the panel to the incoming tab's cached capture + mocks.
  let _netPanelKey = null;
  function syncNetPanelToActiveTab() {
    const at = activeTab();
    netData = (at && at._netData) || [];
    consoleData = (at && at._consoleData) || [];
    const key = at ? at.key : null;
    if (key !== _netPanelKey) { _netPanelKey = key; netPreviewing = null; } // keep an open detail on same-tab remounts
    updateNetErrBadge();
    if (networkVisible) renderNetwork();
    renderMocksBar();
  }
  function updateNetErrBadge() {
    const btn = document.getElementById("btn-network");
    if (!btn) return;
    let b = btn.querySelector(".hdr-badge");
    const n = consoleData.filter((c) => c.level === "error").length;
    const showing = networkVisible && netFilter === "console";
    if (n > 0 && !showing) {
      if (!b) { b = document.createElement("span"); b.className = "hdr-badge err"; btn.appendChild(b); }
      b.textContent = n > 9 ? "9+" : String(n);
    } else if (b) { b.remove(); }
  }

  function netIsApi(r) { return r.type === "XHR" || r.type === "Fetch"; }
  function netPath(u) { try { const x = new URL(u); return x.pathname + (x.search || ""); } catch (e) { return u; } }
  function netStatusClass(s) {
    if (s === -1 || s >= 500) return "err";
    if (s >= 400) return "warn";
    if (s >= 200 && s < 300) return "ok";
    return "";
  }
  function renderNetwork() {
    const list = document.getElementById("np-list");
    const empty = document.getElementById("np-empty");
    list.innerHTML = "";

    // Console view: only errors + warnings (the "is something broken?" view)
    if (netFilter === "console") {
      updateNetErrBadge();
      if (!consoleData.length) { empty.style.display = ""; empty.textContent = "No errors or warnings. 🎉"; return; }
      empty.style.display = "none";
      consoleData.slice().reverse().forEach((c) => {
        const row = document.createElement("div"); row.className = "np-con np-con-" + c.level;
        const lvl = document.createElement("span"); lvl.className = "np-con-lvl"; lvl.textContent = c.level === "error" ? "✕" : "!";
        const t = document.createElement("span"); t.className = "np-con-text"; t.textContent = c.text;
        row.appendChild(lvl); row.appendChild(t); list.appendChild(row);
      });
      return;
    }

    const q = netQuery;
    const rows = netData.filter((r) => (netFilter === "all" ? true : netIsApi(r)) && (!q || r.url.toLowerCase().indexOf(q) !== -1));
    if (!rows.length) {
      empty.style.display = "";
      if (q) empty.textContent = "No requests match your search.";
      else if (netData.length) empty.textContent = "No API calls — check 'All'.";
      else empty.innerHTML = "Your app's calls show up here.<br><br>Navigate the preview or reload (⌘R) to capture them. Then click one to see its response or <b>mock it</b> (return whatever JSON you want).";
      return;
    }
    empty.style.display = "none";
    rows.slice().reverse().forEach((r) => {
      const row = document.createElement("div"); row.className = "np-item";
      const m = document.createElement("span"); m.className = "np-method"; m.textContent = r.method;
      const p = document.createElement("span"); p.className = "np-path"; p.textContent = netPath(r.url); p.title = r.url;
      const ov = overrideFor(r.url);
      if (ov) { const mk = document.createElement("span"); mk.className = "np-mock-badge"; mk.textContent = overrideLabel(ov); row.appendChild(mk); }
      const st = document.createElement("span"); st.className = "np-status " + netStatusClass(r.status);
      st.textContent = r.failed ? "✕" : (r.status == null ? "…" : r.status);
      const cp = document.createElement("button"); cp.className = "np-copy"; cp.title = "Copy the BE URL";
      cp.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      cp.onclick = (e) => { e.stopPropagation(); window.api.copyText(r.url); showToast("URL copied", "check"); };
      row.appendChild(m); row.appendChild(p); row.appendChild(st); row.appendChild(cp);
      row.onclick = () => previewNet(r);
      list.appendChild(row);
    });
  }
  async function previewNet(r) {
    netPreviewing = r;
    syncForceButtons();
    document.getElementById("np-prev-name").textContent = r.method + " " + netPath(r.url);
    const body = document.getElementById("np-prev-body");
    body.textContent = "Loading…";
    document.getElementById("np-preview").classList.add("visible");
    const res = await window.api.netGetBody({ wcId: (activeTab() || {}).wcId, requestId: r.requestId });
    let txt = res && res.body ? res.body : "";
    if (res && res.base64Encoded) { try { txt = atob(txt); } catch (e) {} }
    let isJson = false;
    try { txt = JSON.stringify(JSON.parse(txt), null, 2); isJson = true; } catch (e) {}
    netPreviewingBody = txt; // remember the real body for "use the real one"
    // Header (url + status) plain, then the body — JSON gets syntax colors.
    const header = escMd(r.url) + "\n" + (r.status != null ? "Status: " + r.status : "") + "\n\n";
    // highlightCode escapes internally; hlJson was never exported from OhanaMD
    // (pre-existing crash: any JSON body left the detail stuck on "Loading…").
    const bodyHtml = txt ? (isJson ? highlightCode(txt, "json") : escMd(txt)) : "(no body available)";
    body.innerHTML = header + bodyHtml;
    // If no custom mock is set for this endpoint, seed the editor with the real body
    const ta = document.getElementById("np-mock-body");
    const ov = overrideFor(r.url);
    if (ta && !(ov && ov.state === "custom") && !ta.value) ta.value = txt;
  }
  function toggleNetwork() {
    networkVisible = !networkVisible;
    networkPanel.classList.toggle("visible", networkVisible);
    document.getElementById("btn-network").classList.toggle("active", networkVisible);
    adjustPanelsMargin();
    if (networkVisible) renderNetwork();
  }
  document.getElementById("btn-network").onclick = toggleNetwork;
  document.getElementById("np-close").onclick = toggleNetwork;
  document.getElementById("np-back").onclick = () => document.getElementById("np-preview").classList.remove("visible");
  document.getElementById("np-clear").onclick = async () => { await window.api.netClear((activeTab() || {}).wcId); };
  document.getElementById("np-cache").onclick = async () => {
    const ok = await window.api.cacheClear();
    showToast(ok ? "Cache and cookies cleared — reload with ⌘R" : "Couldn't clear the cache", ok ? "check" : "warn");
  };
  document.querySelectorAll(".np-tab").forEach((t) => {
    t.onclick = () => {
      netFilter = t.dataset.f;
      document.querySelectorAll(".np-tab").forEach((x) => x.classList.toggle("active", x === t));
      const onConsole = (netFilter === "console");
      document.getElementById("np-search-wrap").style.display = onConsole ? "none" : "";
      if (onConsole) document.getElementById("np-mocks").style.display = "none"; else renderMocksBar();
      document.getElementById("np-preview").classList.remove("visible"); // close detail on tab switch
      renderNetwork();
    };
  });
  document.getElementById("np-search").addEventListener("input", (e) => { netQuery = e.target.value.toLowerCase().trim(); renderNetwork(); });
  document.getElementById("np-copy").onclick = () => { if (netPreviewing) { window.api.copyText(netPreviewing.url); showToast("URL copied", "check"); } };

  // ── Mock data states — PER ENDPOINT (page-side shim, no CDP) ──
  // Each override = { match, state, status? }. Applies ONLY to requests whose
  // URL matches that pathname, so you mock one API without touching the rest.
  // state: normal | loading | empty | many | status (status uses any code 200–599).
  // Overrides live ON the tab: each tab mocks its own app independently.
  function tabOverrides() { const at = activeTab(); return at ? (at.dataOverrides = at.dataOverrides || []) : []; }
  let netPreviewingBody = ""; // raw body of the request shown in the detail (for "use the real one")
  const DATA_STATE_LABEL = { normal: "Normal", loading: "Loading", empty: "Empty", many: "Many rows", custom: "Mock" };
  function pathOnly(u) { try { return new URL(u, location.href).pathname; } catch (e) { return (u || "").split("?")[0]; } }
  function overrideFor(url) {
    const p = pathOnly(url);
    return tabOverrides().find((x) => x.match && (p.indexOf(x.match) !== -1 || (url || "").indexOf(x.match) !== -1)) || null;
  }
  // Status code → reason phrase, so you know which state you're simulating.
  const STATUS_TEXT = { 200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };
  function overrideLabel(ov) { return ov.state === "status" ? String(ov.status) : (DATA_STATE_LABEL[ov.state] || ov.state); }
  // Plain-text description of what a state simulates (shown in the detail).
  function stateDescription(ov) {
    if (!ov || ov.state === "normal") return "Not simulated — the endpoint's real response.";
    if (ov.state === "loading") return "Loading — the request never responds (perpetual spinner).";
    if (ov.state === "empty") return "Empty — responds [] (empty list).";
    if (ov.state === "many") return "Many rows — duplicates the real response ×40.";
    if (ov.state === "status") return "Status " + ov.status + " " + (STATUS_TEXT[ov.status] || "") + " — forces that code (keeps the real body).";
    if (ov.state === "custom") return "Mock — returns your JSON" + (ov.status && ov.status !== 200 ? " with status " + ov.status + " " + (STATUS_TEXT[ov.status] || "") : "") + ".";
    return "";
  }
  function renderMocksBar() {
    const bar = document.getElementById("np-mocks");
    if (!bar) return;
    const ovs = tabOverrides();
    if (!ovs.length) { bar.style.display = "none"; return; }
    bar.style.display = "";
    const n = ovs.length;
    document.getElementById("np-mocks-label").textContent = n + (n === 1 ? " endpoint mocked" : " endpoints mocked");
  }
  function applyOverrides(reload) {
    if (webview && webviewReady) {
      // Persist to sessionStorage so the viewer preload re-applies it at
      // document-start on reload (catches the page's initial requests), and set
      // it live for the already-loaded shim.
      const json = JSON.stringify(tabOverrides());
      webview.executeJavaScript("try{sessionStorage.setItem('__ohanaOverrides'," + JSON.stringify(json) + ");}catch(e){} window.__ohanaOverrides=" + json + ";").catch(function () {});
      if (reload) webview.reload();
    }
    renderMocksBar();
    renderNetwork();
  }
  function setOverride(match, ov) {
    if (!match) return;
    const at = activeTab(); if (!at) return;
    at.dataOverrides = tabOverrides().filter((x) => x.match !== match);
    const state = ov && ov.state;
    if (state && state !== "normal") at.dataOverrides.push({ match: match, state: state, status: ov.status, body: ov.body });
    syncForceButtons();
    applyOverrides(true);
    const what = !state || state === "normal" ? "normal" : (state === "custom" ? "mock JSON" : (state === "status" ? "status " + ov.status : (DATA_STATE_LABEL[state] || state)));
    showToast("Forced " + what + " on " + match + " — reloading…", "refresh-cw");
  }
  function clearOverrides() { const at = activeTab(); if (at) at.dataOverrides = []; syncForceButtons(); applyOverrides(true); showToast("Mocks cleared — reloading…", "refresh-cw"); }
  // Reflect the active override of the currently-previewed endpoint in the controls
  function syncForceButtons() {
    if (!netPreviewing) return;
    const ov = overrideFor(netPreviewing.url);
    const loadingChk = document.getElementById("np-loading");
    if (loadingChk) loadingChk.checked = !!(ov && ov.state === "loading");
    const sel = document.getElementById("np-status");
    if (sel) sel.value = (ov && ov.status) ? String(ov.status) : "";
    const ta = document.getElementById("np-mock-body");
    if (ta) ta.value = (ov && ov.state === "custom") ? (ov.body || "") : "";
    const desc = document.getElementById("np-force-desc");
    if (desc) desc.textContent = stateDescription(ov || { state: "normal" });
  }
  // Duplicate a JSON array (or first array field) ~40× to stress the layout.
  function duplicateBody(txt) {
    try {
      const d = JSON.parse(txt); const N = 40, CAP = 500;
      const du = (a) => { const o = []; for (let i = 0; i < N && o.length < CAP; i++) o.push(...a); return o; };
      if (Array.isArray(d)) return JSON.stringify(d.length ? du(d) : d, null, 2);
      if (d && typeof d === "object") { for (const k of Object.keys(d)) { if (Array.isArray(d[k]) && d[k].length) { d[k] = du(d[k]); return JSON.stringify(d, null, 2); } } }
      return txt;
    } catch (e) { return txt; }
  }
  // The textarea IS the mock; the "Fill" buttons only populate it.
  document.querySelectorAll("#np-force .np-fill").forEach((b) => {
    b.onclick = () => {
      const ta = document.getElementById("np-mock-body");
      if (!ta) return;
      if (b.dataset.fill === "real") ta.value = netPreviewingBody || "";
      else if (b.dataset.fill === "empty") ta.value = "[]";
      else if (b.dataset.fill === "many") ta.value = duplicateBody(netPreviewingBody || "[]");
      ta.focus();
    };
  });
  document.getElementById("np-mock-apply").onclick = () => {
    if (!netPreviewing) return;
    const ta = document.getElementById("np-mock-body");
    const v = document.getElementById("np-status").value;
    setOverride(pathOnly(netPreviewing.url), { state: "custom", body: ta.value, status: v ? parseInt(v, 10) : 200 });
  };
  document.getElementById("np-mock-remove").onclick = () => { if (netPreviewing) setOverride(pathOnly(netPreviewing.url), { state: "normal" }); };
  document.getElementById("np-loading").onchange = (e) => { if (netPreviewing) setOverride(pathOnly(netPreviewing.url), { state: e.target.checked ? "loading" : "normal" }); };
  document.getElementById("np-mocks-clear").onclick = clearOverrides;
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); toggleNetwork(); }
  });

  // ── "Which endpoint fills this?" ──
  const _bodyCache = new Map(); // requestId -> decoded body text
  async function getBodyCached(r) {
    if (_bodyCache.has(r.requestId)) return _bodyCache.get(r.requestId);
    const res = await window.api.netGetBody({ wcId: (activeTab() || {}).wcId, requestId: r.requestId });
    let txt = res && res.body ? res.body : "";
    if (res && res.base64Encoded) { try { txt = atob(txt); } catch (e) {} }
    _bodyCache.set(r.requestId, txt);
    return txt;
  }
  // Distinctive tokens from the section's visible text (words/numbers ≥4 chars),
  // longest first — these are what we look for inside response bodies.
  function extractTokens(text) {
    const raw = (text || "").replace(/\s+/g, " ").trim();
    if (!raw) return [];
    const parts = raw.split(/[^\p{L}\p{N}._@-]+/u).filter((t) => t.length >= 4);
    const seen = new Set(); const out = [];
    parts.sort((a, b) => b.length - a.length).forEach((t) => { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } });
    return out.slice(0, 15);
  }
  function setNetProbe(on) {
    netProbeMode = !!on;
    const btn = document.getElementById("np-probe");
    if (btn) btn.classList.toggle("active", netProbeMode);
    const tb = document.getElementById("btn-probe");
    if (tb) tb.classList.toggle("active", netProbeMode);
    if (netProbeMode) {
      sectionHintEl.textContent = "Click a section to see which endpoint fills it · Esc to exit";
      sectionHintEl.classList.add("visible");
    } else {
      sectionHintEl.classList.remove("visible");
    }
    syncInspectorVisual();
  }
  // Score captured API responses against a section's text; return the best match.
  async function bestEndpointFor(text) {
    const tokens = extractTokens(text);
    if (!tokens.length) return null;
    const api = netData.filter(netIsApi);
    let best = null, bestScore = 0;
    for (const r of api) {
      const body = await getBodyCached(r);
      if (!body) continue;
      const lc = body.toLowerCase();
      let score = 0;
      tokens.forEach((t) => { if (lc.indexOf(t.toLowerCase()) !== -1) score++; });
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return bestScore > 0 ? best : null;
  }
  // Inspector: show the API endpoint that feeds the selected element, so the
  // flow is complete — element → styles/component → its data source.
  let _ipApiToken = 0;
  async function inspectorFindApi(data) {
    const el = document.getElementById("ip-api");
    if (!el) return;
    el.style.display = "none"; el.innerHTML = "";
    const text = (data && (data.fullText || data.text)) || "";
    if (!text || !netData.filter(netIsApi).length) return;
    const token = ++_ipApiToken;
    const match = await bestEndpointFor(text);
    if (token !== _ipApiToken) return; // a newer selection superseded this one
    if (!match) return;
    el.style.display = "";
    const lbl = document.createElement("span"); lbl.className = "ip-api-label"; lbl.textContent = "API";
    const ep = document.createElement("span"); ep.className = "ip-api-ep"; ep.textContent = match.method + " " + netPath(match.url);
    el.appendChild(lbl); el.appendChild(ep);
    el.onclick = () => { if (!networkVisible) toggleNetwork(); previewNet(match); };
  }
  async function probeEndpoint(text) {
    if (!extractTokens(text).length) { showToast("That section has no traceable text", "warn"); return; }
    const api = netData.filter(netIsApi);
    if (!api.length) { showToast("No API calls captured — reload the preview", "warn"); return; }
    showToast("Tracing " + api.length + " requests…", "refresh-cw");
    const best = await bestEndpointFor(text);
    if (best) {
      if (!networkVisible) toggleNetwork();
      previewNet(best);
      showToast("This section is filled by " + best.method + " " + netPath(best.url), "check");
    } else {
      showToast("Couldn't find an endpoint matching that section", "warn");
    }
  }
  document.getElementById("np-probe").onclick = () => setNetProbe(!netProbeMode);
  const _tbProbe = document.getElementById("btn-probe");
  if (_tbProbe) _tbProbe.onclick = () => setNetProbe(!netProbeMode);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && netProbeMode) setNetProbe(false); });

  let _resizeRaf = null;
  window.addEventListener("resize", () => {
    // Reflow docked panels + webview to the new window size (debounced via rAF).
    if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
    _resizeRaf = requestAnimationFrame(() => {
      _resizeRaf = null;
      adjustPanelsMargin();
      const inst = activeTermInstance();
      if (termVisible && inst) { try { inst.fitAddon.fit(); termSendResizeFor(inst); } catch (e) {} }
    });
  });
  document.getElementById("btn-terminal").onclick = toggleTerminal;

  // ── Docs overlay (static documentation) ──
  const docsOverlay = document.getElementById("docs-overlay");
  function docsShow(sec) {
    docsOverlay.querySelectorAll(".docs-navitem").forEach((b) => b.classList.toggle("active", b.dataset.sec === sec));
    docsOverlay.querySelectorAll(".docs-content section").forEach((s) => { s.hidden = s.dataset.sec !== sec; });
    const c = docsOverlay.querySelector(".docs-content"); if (c) c.scrollTop = 0;
  }
  function openDocs(sec) { docsOverlay.classList.add("visible"); docsShow(sec || (flowMode ? "moka" : "connect")); }
  function closeDocs() { docsOverlay.classList.remove("visible"); }
  document.getElementById("docs-close").onclick = closeDocs;
  const _fpDocs = document.getElementById("fp-docs"); if (_fpDocs) _fpDocs.onclick = () => openDocs("review");

  // Layout editor wiring
  document.getElementById("le-cancel").onclick = closeLayoutEditor;
  document.getElementById("le-save").onclick = saveLayoutEditor;
  document.querySelector(".le-controls").addEventListener("click", (e) => {
    const g = e.target.closest("[data-grid]"), p = e.target.closest("[data-preset]");
    if (g) { const a = g.dataset.grid; if (a === "col+") setLeGrid(_leCols + 1, _leRows); else if (a === "col-") setLeGrid(_leCols - 1, _leRows); else if (a === "row+") setLeGrid(_leCols, _leRows + 1); else if (a === "row-") setLeGrid(_leCols, _leRows - 1); }
    else if (p) { const [c, r] = p.dataset.preset.split("x").map(Number); _leRegions = _leRegions.filter((rg) => rg.c1 < c && rg.r1 < r); setLeGrid(c, r); }
    else if (e.target.id === "le-clear") { _leRegions = []; renderLayoutEditor(); }
  });
  const _leHost = document.getElementById("le-host");
  if (_leHost) {
    _leHost.addEventListener("mouseover", (e) => {
      const tgt = e.target.closest(".fl-cont");
      if (tgt && tgt.__fnode) { if (_actHideT) { clearTimeout(_actHideT); _actHideT = null; } if (tgt !== _actEl) showActBarFor(tgt); }
    });
    _leHost.addEventListener("mouseleave", () => { _actHideT = setTimeout(hideActBar, 160); });
  }
  document.getElementById("layout-editor").addEventListener("mousedown", (e) => { if (e.target.id === "layout-editor") closeLayoutEditor(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("layout-editor").classList.contains("visible")) { e.stopPropagation(); closeLayoutEditor(); }
  }, true);
  docsOverlay.addEventListener("mousedown", (e) => { if (e.target === docsOverlay) closeDocs(); });
  docsOverlay.querySelectorAll(".docs-navitem").forEach((b) => b.onclick = () => docsShow(b.dataset.sec));
  // Esc closes Docs first (capture phase → preempts the Flow/Style Esc handlers).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && docsOverlay.classList.contains("visible")) { e.stopPropagation(); closeDocs(); }
  }, true);
  document.getElementById("term-close").onclick = toggleTerminal;
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) { e.preventDefault(); toggleTerminal(); }
  });

  // ════════════════════════════════════════════════════════════════════
  //  Flow / Layout mode (beta) — build user flows & sitemaps per
  //  project. Persisted in .ohana/flow.json as living documentation; the
  //  agent can read/write it, and you export a structured prompt from it.
  // ════════════════════════════════════════════════════════════════════
  const FLOW_KINDS = {
    page:   { label: "Page",       color: "#7cb0ff", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="8" x2="20" y2="8"/></svg>' },
    modal:  { label: "Modal",      color: "#b388ff", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="7" y="9" width="10" height="6" rx="1"/></svg>' },
    dialog: { label: "Dialog",     color: "#f5a623", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 11.5a8.5 8.5 0 01-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1121 11.5z"/></svg>' },
    decision: { label: "Decision", color: "#ffd166", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2l10 10-10 10L2 12z"/></svg>' },
    start:  { label: "Start",      color: "#34d399", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16" fill="currentColor" stroke="none"/></svg>' },
    end:    { label: "End",        color: "#f87171", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>' },
    subflow: { label: "Subflow", color: "#b388ff", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v3.5a3 3 0 0 0 3 3h4.5"/></svg>' },
  };
  const TERMINAL_KINDS = { start: 1, end: 1 };           // terminator pills
  const COMPACT_KINDS = { subflow: 1 };                  // compact flow nodes
  // Branching nodes ship with their outputs already defined (label + color + side).
  const BRANCH_OUTS = {
    decision: [{ label: "Yes", color: "#34d399", side: "right" }, { label: "No", color: "#f87171", side: "bottom" }],
  };
  // Legacy Spanish edge labels (boards saved before the English migration) → canonical output label.
  const LEGACY_OUT_LABELS = { "sí": "yes", "si": "yes", "éxito": "success", "exito": "success" };
  // Match the decision node's CSS box (120×120). The diamond's 4 vertices sit at
  // the midpoints of this box, so side anchors land exactly on the rhombus tips.
  const DECISION_W = 120, DECISION_H = 120;
  // Build-status per screen — powers the handoff loop ("agent, build the ones
  // still to build"). Missing status is treated as "todo".
  const FLOW_STATUS = {
    // Semantic icon per status (Lucide-style): empty circle = to build,
    // half/clock = in progress, check = done. Colored via currentColor.
    todo: { label: "To build",      color: "#f5a623", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>' },
    wip:  { label: "In progress",   color: "#7cb0ff", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 12V7" stroke-linecap="round"/><path d="M12 12l3.5 2" stroke-linecap="round"/></svg>' },
    done: { label: "Done",          color: "#34d399", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  };
  const STATUS_ORDER = ["todo", "wip", "done"];
  function screenStatus(s) { return FLOW_STATUS[s && s.status] ? s.status : "todo"; }
  let flowFilter = "all"; // all | todo | wip | done
  const EDGE_COLORS = ["#7cb0ff", "#8a93a6", "#34d399", "#f5a623", "#f87171", "#b388ff"]; // connector colors
  const GRID = 20; let flowSnap = false;
  let _flowAutoLayoutPending = false; // auto-tidy when an AI-generated flow loads
  function snapv(v) { return flowSnap ? Math.round(v / GRID) * GRID : v; }
  const NOTE_COLORS = { yellow: "#f5d90a", blue: "#7cb0ff", green: "#34d399", pink: "#ff8fab" };
  const NOTE_KEYS = ["yellow", "blue", "green", "pink"];
  // Inline SVG icons (no emojis — match the app's icon style).
  // Icons — official Lucide (lucide.dev, ISC). Wrapped by LI() so the <svg> shell
  // (round caps/joins, 24-grid) is identical everywhere. Add new icons here; the
  // HTML declares only data-icon="key" and initIcons() injects the SVG.
  const LI = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const FI = {
    // text editing (Lucide: tag, bold, italic, list, list-ordered, quote)
    tag:   LI('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'),
    bold:  LI('<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>'),
    italic: LI('<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>'),
    listBullet: LI('<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'),
    listOrdered: LI('<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
    quote: LI('<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>'),
    listChecks: LI('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
    arrowRight: LI('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
    arrowUpRight: LI('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
    // content direction (Lucide: columns-2 = fila/horizontal, rows-2 = columna/vertical)
    dirRow: LI('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'),
    dirCol: LI('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/>'),
    // chevrons / basics
    up:    LI('<path d="m18 15-6-6-6 6"/>'),
    down:  LI('<path d="m6 9 6 6 6-6"/>'),
    x:     LI('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    plus:  LI('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    check: LI('<path d="M20 6 9 17l-5-5"/>'),
    dots:  LI('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    // actions
    trash: LI('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
    dup:   LI('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    edit:  LI('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>'),
    link:  LI('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    open:  LI('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    sparkle: LI('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>'),
    diamond: LI('<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.71 2.71a2.41 2.41 0 0 0-3.41 0z"/>'),
    db:    LI('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'),
    // left toolbar / panels
    folder:   LI('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
    comment:  LI('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    palette:  LI('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z"/>'),
    terminal: LI('<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>'),
    fileText: LI('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
    box:      LI('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    network:  LI('<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>'),
    // Moka topbar
    search:  LI('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    filter:  LI('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
    fit:     LI('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'),
    refresh: LI('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
    magnet:  LI('<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>'),
    workflow: LI('<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>'),
    upload:  LI('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
    // Moka tools / actions
    pointer: LI('<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>'),
    hand:    LI('<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
    squarePlus: LI('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>'),
    frame:   LI('<line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/>'),
    note:    LI('<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h9.5L21 14.5V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-5a1 1 0 0 1 1-1h5"/>'),
    heading: LI('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'),
    // modes / misc chrome
    eye:      LI('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
    help:     LI('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    inspector: LI('<path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"/><path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h2"/><path d="M14 3h1"/><path d="M3 9v1"/><path d="M21 9v2"/><path d="M3 14v1"/>'),
    crosshair: LI('<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>'),
    camera:   LI('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
    crop:     LI('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
    code:     LI('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    braces:   LI('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),
    settings: LI('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
    send:     LI('<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>'),
    server:   LI('<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'),
    eraser:   LI('<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>'),
    listX:    LI('<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="m19 10-4 4"/><path d="m15 10 4 4"/>'),
    // component catalog (Moka sections)
    accordion:  LI('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/>'),
    alert:      LI('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    avatar:     LI('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>'),
    badge:      LI('<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/>'),
    breadcrumb: LI('<path d="m9 18 6-6-6-6"/>'),
    button:     LI('<rect width="20" height="12" x="2" y="6" rx="2"/>'),
    buttonGroup: LI('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'),
    calendar:   LI('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
    carousel:   LI('<path d="M2 7v10"/><path d="M6 5v14"/><rect width="12" height="18" x="10" y="3" rx="2"/>'),
    chart:      LI('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
    checkbox:   LI('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>'),
    collapsible: LI('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>'),
    menu:       LI('<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>'),
    table:      LI('<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>'),
    datePicker: LI('<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>'),
    secContent: LI('<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/>'),
    secEmpty:   LI('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    cube:       LI('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    zoomIn:     LI('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>'),
    zoomOut:    LI('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><line x1="8" x2="14" y1="11" y2="11"/>'),
  };
  // Inject Lucide SVGs into any element declaring data-icon="key".
  function initIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      const ic = FI[el.getAttribute("data-icon")];
      if (ic) { el.insertAdjacentHTML("afterbegin", ic); el.removeAttribute("data-icon"); }
    });
  }
  initIcons();
  let flowDoc = { flows: [], active: null }; // a project can hold multiple flows
  let userComponents = []; // your global component library (~/.ohana/components.json) — filled on load
  async function loadUserComponents() {
    try { const c = await window.api.ohanaReadGlobal("components.json"); const arr = c ? JSON.parse(c) : []; userComponents = Array.isArray(arr) ? arr : []; } catch (e) { userComponents = []; }
  }
  function saveUserComponents() { try { window.api.ohanaWriteGlobal({ filename: "components.json", content: JSON.stringify(userComponents, null, 2) }); } catch (e) {} }
  loadUserComponents();
  let flow = { screens: [], edges: [] };     // points to the active flow object
  let flowView = { x: 60, y: 60, s: 1 };
  let flowKey = null;        // tab key whose flow is loaded
  function activeSrc() { const at = activeTab(); return at ? at.src : null; }
  // Flows owned by the active tab's src. Each flow belongs to exactly one src.
  function flowsForActive() { const src = activeSrc(); return src ? flowDoc.flows.filter((f) => f.src === src) : []; }
  // Flows with no owner (legacy / orphaned). Offered in the switcher so a tab can claim them.
  function orphanFlows() { return flowDoc.flows.filter((f) => !f.src); }
  function activeFlowObj() { const own = flowsForActive(); return own.find((f) => f.id === flowDoc.active) || own[0] || { screens: [], edges: [] }; }
  function normalizeFlowDoc(doc) {
    const tabActive = (doc && doc.tabActive && typeof doc.tabActive === "object") ? doc.tabActive : {};
    const layout = (doc && doc.layout && typeof doc.layout === "object") ? doc.layout : { dir: "LR", connector: "smooth" };
    const layouts = (doc && Array.isArray(doc.layouts)) ? doc.layouts : []; // saved layout presets (per project)
    if (doc && Array.isArray(doc.flows) && doc.flows.length) {
      doc.flows.forEach((f) => { f.id = f.id || flowGenId(); f.name = f.name || "Flow"; f.screens = Array.isArray(f.screens) ? f.screens : []; f.edges = Array.isArray(f.edges) ? f.edges : []; });
      // Migrate legacy tabActive map → explicit per-flow owner (src). First src wins;
      // a flow can only belong to one src now. Unmapped flows stay orphan (no owner → hidden).
      Object.keys(tabActive).forEach((src) => { const f = doc.flows.find((x) => x.id === tabActive[src]); if (f && !f.src) f.src = src; });
      return { flows: doc.flows, active: (doc.active && doc.flows.some((f) => f.id === doc.active)) ? doc.active : doc.flows[0].id, globals: (doc.globals && typeof doc.globals === "object") ? doc.globals : {}, tabActive: tabActive, layout: layout, layouts: layouts };
    }
    if (doc && Array.isArray(doc.screens)) { // legacy single-flow format → migrate
      const f = { id: flowGenId(), name: "Main flow", screens: doc.screens, edges: Array.isArray(doc.edges) ? doc.edges : [] };
      return { flows: [f], active: f.id, globals: (doc.globals && typeof doc.globals === "object") ? doc.globals : {}, tabActive: tabActive, layout: layout, layouts: layouts };
    }
    // Empty/missing doc → NO flows. Fabricating a default here caused a phantom
    // "Main flow" next to the one the user actually created (double-creation bug);
    // flows are only born in ensureTabFlow (entering Moka) or an explicit create.
    return { flows: [], active: null, globals: {}, tabActive: tabActive, layout: layout, layouts: layouts };
  }
  // Each tab keeps its own active flow (keyed by its src). On load, bind the tab
  // to its remembered flow; if it has none, adopt an unclaimed flow or create one.
  function ensureTabFlow(src) {
    if (!src) return false;
    flowDoc.tabActive = flowDoc.tabActive || {};
    const own = flowDoc.flows.filter((f) => f.src === src);
    if (own.length) { // this tab already owns flow(s): restore the last-active one
      const remembered = flowDoc.tabActive[src];
      flowDoc.active = (own.find((f) => f.id === remembered) || own[0]).id;
      return false;
    }
    // Legacy migration only: a project that still has a single owner-less flow gets
    // claimed by the first tab that opens it. Never adopt when several flows exist
    // (that was the cross-contamination bug).
    let f = (flowDoc.flows.length === 1 && !flowDoc.flows[0].src) ? flowDoc.flows[0] : null;
    if (!f) { const at = activeTab(); f = { id: flowGenId(), name: (at && at.name) ? at.name : "Flow 1", screens: [], edges: [] }; flowDoc.flows.push(f); }
    f.src = src;
    flowDoc.tabActive[src] = f.id;
    flowDoc.active = f.id;
    return true; // mutated → caller should persist
  }
  // Remember which of a tab's flows was last active (selection memory, keyed by src).
  function bindTabFlow(fid) { const at = activeTab(); if (at && at.src) { flowDoc.tabActive = flowDoc.tabActive || {}; flowDoc.tabActive[at.src] = fid; } }
  // Migrate legacy single `link` (string) → `links` array of {url, ctx}.
  function migrateScreens() {
    (flowDoc.flows || []).forEach((f) => (f.screens || []).forEach((s) => {
      if (s.link && !s.links) s.links = [{ url: s.link }];
      delete s.link;
      if (s.links && !Array.isArray(s.links)) s.links = [];
      if (s.api && !s.apis) s.apis = [{ endpoint: s.api }];
      delete s.api;
      if (s.apis && !Array.isArray(s.apis)) s.apis = [];
    }));
  }
  function flowGlobals() { return (flowDoc.globals = flowDoc.globals || {}); }
  function blockContent(b) { return b.globalId ? (flowGlobals()[b.globalId] || { title: "(global deleted)", desc: "", items: [] }) : b; }
  // ── Layout tree: a screen's content is a nestable row/col container tree ──
  // node = container { cid, dir:"row"|"col", grow?, children:[...] } | block leaf
  function genCid() { return "c" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
  function isCont(n) { return !!(n && Array.isArray(n.children)); }
  function ensureLayout(s) {
    if (!isCont(s.layout)) s.layout = { cid: genCid(), dir: "col", children: Array.isArray(s.blocks) ? s.blocks : [] };
    if (s.blocks) delete s.blocks; // migrate flat blocks → layout tree
    (function walk(n) { if (isCont(n)) { if (!n.cid) n.cid = genCid(); n.children = n.children || []; n.children.forEach(walk); } })(s.layout);
  }
  function eachBlock(s, fn) { if (!s.layout) return; (function walk(n, p, i) { if (isCont(n)) n.children.forEach((c, j) => walk(c, n, j)); else fn(n, p, i); })(s.layout, null, 0); }
  function globalCount(gid) { let n = 0; flow.screens.forEach((s) => eachBlock(s, (b) => { if (b.globalId === gid) n++; })); return n; }
  let flowSel = new Set();   // ids of selected screens (multi-select)
  let flowClipboard = null;  // { screens:[...], edges:[...] } — internal copy buffer
  let flowSpace = false;     // Space held → drag pans instead of marquee-selecting
  let flowTool = "pointer";  // "pointer" (select/move) | "hand" (pan the canvas)
  function setFlowTool(t) {
    flowTool = (t === "hand") ? "hand" : "pointer";
    const vp = document.getElementById("flow-viewport"); if (vp) vp.style.cursor = flowTool === "hand" ? "grab" : "default";
    const bp = document.getElementById("flow-tool-pointer"), bh = document.getElementById("flow-tool-hand");
    if (bp) bp.classList.toggle("active", flowTool === "pointer");
    if (bh) bh.classList.toggle("active", flowTool === "hand");
  }
  function refreshSelClasses() { flowNodes.querySelectorAll(".flow-screen").forEach((el) => el.classList.toggle("selected", flowSel.has(el.dataset.id))); if (typeof updateAlignBar === "function") updateAlignBar(); }
  function selectMouse(s, e) {
    if (e.shiftKey || e.metaKey || e.ctrlKey) { if (flowSel.has(s.id)) flowSel.delete(s.id); else flowSel.add(s.id); }
    else if (!flowSel.has(s.id)) flowSel = new Set([s.id]); // click an unselected card → only it; click one already in the group → keep the group (for group drag)
    refreshSelClasses();
  }
  function selectedScreens() { return flow.screens.filter((s) => flowSel.has(s.id)); }
  // Deep-clone a set of screens + the edges fully contained in it, with fresh ids
  // and an x/y offset; inserts them and makes them the new selection.
  function insertScreens(screens, edges, dx, dy) {
    const idMap = {};
    const ns = screens.map((s) => { const c = JSON.parse(JSON.stringify(s)); c.id = flowGenId(); idMap[s.id] = c.id; c.x = (c.x || 0) + dx; c.y = (c.y || 0) + dy; return c; });
    const ne = (edges || []).map((e) => {
      const c = JSON.parse(JSON.stringify(e));
      if (c.from) { c.from = idMap[c.from] || c.from; c.to = idMap[c.to] || c.to; }
      if (c.fromB) {
        const a = c.fromB.split("/"); c.fromB = (idMap[a[0]] || a[0]) + "/" + a[1];
        if (c.to) c.to = idMap[c.to] || c.to;                                            // component → page
        else if (c.toB) { const b = c.toB.split("/"); c.toB = (idMap[b[0]] || b[0]) + "/" + b[1]; } // legacy
      }
      return c;
    });
    flow.screens.push.apply(flow.screens, ns);
    flow.edges = flow.edges || []; flow.edges.push.apply(flow.edges, ne);
    flowSel = new Set(ns.map((s) => s.id));
    return ns;
  }
  function internalEdges(ids) {
    const set = ids instanceof Set ? ids : new Set(ids);
    return (flow.edges || []).filter((e) => {
      if (e.fromB) { const src = e.fromB.split("/")[0], dst = e.to || (e.toB || "").split("/")[0]; return set.has(src) && set.has(dst); }
      if (e.from && e.to) return set.has(e.from) && set.has(e.to);
      return false;
    });
  }
  function flowCopySelection() {
    if (!flowSel.size) return false;
    const ss = selectedScreens();
    flowClipboard = { screens: JSON.parse(JSON.stringify(ss)), edges: JSON.parse(JSON.stringify(internalEdges(flowSel))) };
    return true;
  }
  function flowPaste(dx, dy) {
    if (!flowClipboard || !flowClipboard.screens.length) return;
    insertScreens(flowClipboard.screens, flowClipboard.edges, dx == null ? 28 : dx, dy == null ? 28 : dy);
    saveFlow(); renderFlow();
  }
  function flowDuplicateSelection() {
    if (!flowSel.size) return;
    insertScreens(selectedScreens(), internalEdges(flowSel), 28, 28);
    saveFlow(); renderFlow();
  }
  function flowDeleteSelection() {
    if (!flowSel.size) return;
    const set = flowSel;
    flow.screens = flow.screens.filter((s) => !set.has(s.id));
    flow.edges = (flow.edges || []).filter((e) => {
      if (e.fromB) { const src = e.fromB.split("/")[0], dst = e.to || (e.toB || "").split("/")[0]; return !set.has(src) && !set.has(dst); }
      if (e.from && e.to) return !set.has(e.from) && !set.has(e.to);
      return true;
    });
    flowSel = new Set();
    saveFlow(); renderFlow();
  }
  let _flowSaveT = null;
  const _flowHeights = {};   // id -> measured card height
  let _edgeGeom = {};        // edge index -> {ax,ay,bx,by,horiz} for elbow dragging
  // Sugiyama edge routing: after an auto-layout, long edges get waypoints through
  // the reserved dummy-node lanes (edge index -> [{x,y},…] in world coords) so the
  // connector flows around cards instead of slashing across. Transient (not saved);
  // cleared when a node moves manually so we fall back to direct routing.
  let _edgeRoutes = {};
  // Coalesce edge re-renders to one per animation frame. Drag handlers fire per
  // mousemove; rebuilding the whole SVG each event causes flicker on big flows.
  let _edgeRAF = null;
  function scheduleEdgeRender() {
    if (_edgeRAF) return;
    _edgeRAF = requestAnimationFrame(() => { _edgeRAF = null; renderFlowEdges(); });
  }
  let _flowBusy = false;     // a canvas gesture (drag) is in progress → don't clobber with a reload
  let _flowPendingReload = null; // external edit held back until the user finishes editing
  // Agent build session: an agent writes flow.json many times (once per tool call).
  // Instead of flashing the loader + re-rendering on every write, keep ONE
  // persistent loader from the first write until writes go quiet, then reveal the
  // finished result once. _agentBuildT is the "quiet" timer; it resets per write.
  let _agentBuilding = false;
  let _agentBuildT = null;
  const AGENT_QUIET_MS = 2000; // no writes for this long ⇒ the agent finished

  const flowCanvas = document.getElementById("flow-canvas");
  const flowVp = document.getElementById("flow-viewport");
  const flowNodes = document.getElementById("flow-nodes");
  const flowEdgesSvg = document.getElementById("flow-edges");
  const flowEmpty = document.getElementById("flow-empty");
  const flowMenu = document.getElementById("flow-menu");
  const flowMini = document.getElementById("flow-minimap");

  function flowGenId() { return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
  let _flowWcT = null;
  function flowApplyView() {
    flowNodes.style.transform = "translate(" + flowView.x + "px," + flowView.y + "px) scale(" + flowView.s + ")";
    // Promote the layer only WHILE panning/zooming; release on idle so the
    // browser re-rasters at the final scale (a permanent will-change kept the
    // cached raster and the canvas looked low-res after zooming).
    flowNodes.style.willChange = "transform";
    if (_flowWcT) clearTimeout(_flowWcT);
    _flowWcT = setTimeout(() => { if (!flowNodes.classList.contains("glide")) flowNodes.style.willChange = "auto"; }, 220);
    const z = document.getElementById("flow-zoom"); if (z) z.textContent = Math.round(flowView.s * 100) + "%";
    scheduleCull();      // virtualize (zoom-in) or redraw the canvas overview (zoom-out)
    renderMinimap();
  }
  // Minimap: a scaled overview + the current viewport rect; click/drag to pan.
  function renderMinimap() {
    if (!flowMini || !flowMini.getContext) return;
    const ctx = flowMini.getContext("2d"); const W = flowMini.width, H = flowMini.height;
    ctx.clearRect(0, 0, W, H);
    const bb = flowBBox();
    if (!bb || flow.screens.length < 2) { flowMini.style.display = "none"; return; }
    flowMini.style.display = "block";
    const pad = 12, sc = Math.min((W - pad * 2) / Math.max(bb.w, 1), (H - pad * 2) / Math.max(bb.h, 1));
    const ox = (W - bb.w * sc) / 2, oy = (H - bb.h * sc) / 2;
    const tx = (wx) => ox + (wx - bb.minX) * sc, ty = (wy) => oy + (wy - bb.minY) * sc;
    flow.screens.forEach((s) => {
      const w = s.kind === "decision" ? DECISION_W : SCREEN_W, h = s.kind === "decision" ? DECISION_H : (_flowHeights[s.id] || 140);
      ctx.globalAlpha = flowSel.has(s.id) ? 1 : 0.7;
      ctx.fillStyle = FLOW_STATUS[screenStatus(s)].color;
      ctx.fillRect(tx(s.x || 0), ty(s.y || 0), Math.max(2, w * sc), Math.max(2, h * sc));
    });
    ctx.globalAlpha = 1;
    const r = flowVp.getBoundingClientRect();
    const vx0 = (0 - flowView.x) / flowView.s, vy0 = (0 - flowView.y) / flowView.s;
    const vx1 = (r.width - flowView.x) / flowView.s, vy1 = (r.height - flowView.y) / flowView.s;
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1;
    ctx.strokeRect(tx(vx0) + 0.5, ty(vy0) + 0.5, (vx1 - vx0) * sc, (vy1 - vy0) * sc);
    flowMini._map = { ox: ox, oy: oy, sc: sc, minX: bb.minX, minY: bb.minY };
  }
  function flowWorld(cx, cy) {
    const r = flowVp.getBoundingClientRect();
    return { x: (cx - r.left - flowView.x) / flowView.s, y: (cy - r.top - flowView.y) / flowView.s };
  }
  let _flowLastSelfWrite = 0;
  let _flowUndo = [], _flowRedo = [], _flowSnap = null; // undo/redo history (snapshots)
  function writeFlowFile() {
    _flowLastSelfWrite = Date.now(); // so the file watcher's echo doesn't reload over us
    try { window.api.ohanaWriteFile({ filename: "flow.json", content: JSON.stringify(flowDoc, null, 2) }); } catch (e) {}
  }
  function saveFlow() {
    if (_flowSaveT) clearTimeout(_flowSaveT);
    _flowSaveT = setTimeout(() => {
      _flowSaveT = null;
      // Record the previous settled state as an undo step (coalesced by the debounce).
      if (_flowSnap !== null) { _flowUndo.push(_flowSnap); if (_flowUndo.length > 60) _flowUndo.shift(); _flowRedo = []; }
      _flowSnap = JSON.stringify(flowDoc);
      writeFlowFile();
    }, 400);
  }
  // Write any pending (debounced) flow edit to disk NOW. MUST run while main
  // still points at the project that produced the edit: an orphaned timer that
  // fires after a tab switch re-points main writes this flowDoc into ANOTHER
  // project's flow.json (cross-project mixing / data loss).
  function flushFlowSave() {
    if (!_flowSaveT) return;
    clearTimeout(_flowSaveT); _flowSaveT = null;
    if (_flowSnap !== null) { _flowUndo.push(_flowSnap); if (_flowUndo.length > 60) _flowUndo.shift(); _flowRedo = []; }
    _flowSnap = JSON.stringify(flowDoc);
    writeFlowFile();
  }
  function flowResetHistory() { _flowUndo = []; _flowRedo = []; _flowSnap = JSON.stringify(flowDoc); }
  function flowUndo() {
    if (_flowSaveT) { clearTimeout(_flowSaveT); _flowSaveT = null; if (_flowSnap !== null) { _flowUndo.push(_flowSnap); _flowSnap = JSON.stringify(flowDoc); } } // flush a pending change first
    if (!_flowUndo.length) { showToast("Nothing to undo", "warn"); return; }
    _flowRedo.push(JSON.stringify(flowDoc));
    const prev = _flowUndo.pop();
    flowDoc = normalizeFlowDoc(JSON.parse(prev)); _flowSnap = JSON.stringify(flowDoc); flow = activeFlowObj();
    renderFlow(); renderFlowSwitcher(); writeFlowFile(); showToast("Undone", "refresh-cw");
  }
  function flowRedo() {
    if (!_flowRedo.length) { showToast("Nothing to redo", "warn"); return; }
    _flowUndo.push(JSON.stringify(flowDoc));
    const next = _flowRedo.pop();
    flowDoc = normalizeFlowDoc(JSON.parse(next)); _flowSnap = JSON.stringify(flowDoc); flow = activeFlowObj();
    renderFlow(); renderFlowSwitcher(); writeFlowFile(); showToast("Redone", "refresh-cw");
  }
  // opts.noEnsure: skip ensureTabFlow — for callers that operate on an existing
  // flow or create their own right after (create/open/rename/duplicate/delete),
  // so the load never fabricates an extra flow alongside theirs.
  async function loadFlowForActive(opts) {
    const at = activeTab();
    // Same-project reload (rename/switcher/refresh): persist the pending edit
    // before rereading disk, or the reload clobbers it. Never flush on a cross-
    // tab load — flowKey is still the OUTGOING tab's key there, while main
    // already points at the incoming project (activateTab flushed earlier).
    if (at && flowKey === at.key) flushFlowSave();
    const proj = document.getElementById("flow-project");
    if (!at) { flowDoc = { flows: [], active: null }; flow = { screens: [], edges: [] }; flowKey = null; if (proj) proj.textContent = ""; renderFlow(); renderFlowSwitcher(); return; }
    flowKey = at.key;
    if (proj) proj.textContent = at.name || "";
    hideFlowError();
    let d = null, corrupt = false;
    try { const c = await window.api.ohanaReadFile("flow.json"); if (c) { try { d = JSON.parse(c); } catch (pe) { corrupt = true; } } } catch (e) {}
    if (corrupt) { showFlowError("corrupt"); return; } // don't overwrite a broken file — let an agent fix it
    flowDoc = normalizeFlowDoc(d);
    migrateScreens();
    const created = (opts && opts.noEnsure) ? false : ensureTabFlow(at.src);
    flow = activeFlowObj();
    flowSel = new Set();
    if (created) writeFlowFile();
    flowResetHistory();
    renderFlow();
    renderFlowSwitcher();
    ensureMokaGuide();
  }
  // Portable guide for any agent (Claude/Codex/…) reading the project folder.
  // Versioned: bump MOKA_GUIDE_V when the template changes so stale copies regenerate.
  const MOKA_GUIDE_V = "<!-- moka-guide v4 -->"; // v4: workspace folder names resolved per project
  async function ensureMokaGuide() {
    try {
      const existing = await window.api.ohanaReadFile("MOKA.md");
      if (existing && existing.indexOf(MOKA_GUIDE_V) !== -1) return;
      // The guide names the project's real folders — make sure the scan ran for
      // THIS project before writing (projManifest can lag on a fresh open).
      let dirs = (projManifest && _navScanDir === (activeTab() || {}).dir && projManifest.dirs) || null;
      if (!dirs) { try { const m = await window.api.projectScan((activeTab() || {}).dir); dirs = m && m.dirs; } catch (e) {} }
      dirs = dirs || { prototypes: "prototypes", plans: "plans" };
      const md = [
        "# Moka — how to build sitemaps and user flows (for agents)",
        MOKA_GUIDE_V,
        "",
        "This project uses Moka (Ohana's layout canvas). The boards live in `.ohana/flow.json` and belong TO THE PROJECT (they're listed in the navigator's Flows section).",
        "Project structure: `" + dirs.prototypes + "/` (HTML), `" + dirs.plans + "/` (agent plans), `handoff/` (docs for the repo), `design/` + `design.md` (design system). Write each artifact in its folder.",
        "Do NOT set coordinates (x/y): Moka lays out on its own. Express the STRUCTURE.",
        "",
        "## Board type — order comes from the STRUCTURE, not the coordinates",
        "Moka lays out with a layered algorithm (Sugiyama). A clean drawing depends only on the graph being well-formed:",
        "- **Sitemap** (`board:\"sitemap\"`): a TREE read TOP to BOTTOM (TB). TREE RULE: every page has EXACTLY ONE parent; connect ONLY parent→child; siblings share a parent but do NOT connect to each other; NO cross-links or level jumps (those cross lines). If something hangs from two places, pick the primary parent and leave the other tie as a screen `link`, not an edge. Only `page`.",
        "- **User flow** (`board:\"userflow\"`): a SEQUENCE read LEFT to RIGHT (LR). BACKBONE: one main path, each screen with ONE 'next', always moving forward. `decision` nodes have 2 outputs: Yes (green) continues the backbone, No (red) is a short side branch that re-enters or ends. Mark real retries with `dir:\"back\"`. Avoid long jumps and fans of connections.",
        "",
        "## Node types (`kind`)",
        "- `page` / `modal` / `dialog`: real screens.",
        "- `decision`: a diamond with outputs already resolved Yes (green) / No (red).",
        "- `subflow`: links to another flow in the project (link it with `ohana_flow_update_screen({ id, flowRef })`).",
        "- `start` / `end`: mark where the experience begins and ends (always use them in user flows).",
        "",
        "## Intent tools (MCP `ohana-comments`)",
        "- Sitemap: `ohana_sitemap_add_page({ name })` for level 1; `ohana_sitemap_add_page({ parent, name })` to hang a child (connects parent→child).",
        "- User flow: start with `kind:\"start\"` and end each path with `kind:\"end\"`; `ohana_flow_add_step({ after, name, kind })` for the next step; `ohana_flow_add_branch({ from, label, name })` for the branches of a `decision`.",
        "- `ohana_flow_guide` returns these conventions; `ohana_flow_read`/`ohana_flow_layout` to read/lay out.",
        "",
        "## Anatomy of a screen (regions → sections → components)",
        "Hierarchy: Page → REGIONS → SECTIONS → COMPONENTS.",
        "- REGIONS define the card's layout (Header/Body/Footer or a preset: `ohana_flow_set_layout` accepts builtins and project layouts created in the grid painter).",
        "- SECTIONS are UI organisms inside a region (`ohana_flow_add_section({ screenId, name, region })`; without `region` it creates a root region).",
        "- COMPONENTS (Button, Data table, Chart, Accordion, etc.) go inside sections (`ohana_flow_add_component`). Each one carries its detail (title/description/elements): what it says, how it looks, how it works.",
        "In `flow.json` the layout is a tree: containers (regions/sections) with leaf blocks (components). Connections leave from pages or components and always land on the destination card, never on a component.",
        "",
        "## Referring to a screen",
        "Every screen has a stable internal handle (`handle`, e.g. `P1`). The user talks to you by NAME; resolve by name or handle. Don't show it in the UI.",
        "",
        "## From Moka to code (the important part)",
        "The flow is the brief for building the real product:",
        "- **HTML prototype**: generate the HTML for each screen respecting its sections/components, APIs, and branch logic. Editing is free.",
        "- **Repo**: implement each screen using the project's real design-system components. The mockup says which component goes in each section; don't invent components outside the system.",
        "- Respect Start/End (the journey), and the output colors: green = positive path, red = negative/error, blue = normal.",
        "",
        "Without MCP: edit `.ohana/flow.json` (format { flows:[{ board, src, screens:[{id,name,kind,layout,apis,links}], edges:[{from,to,color,out}] }], active }). Connect parent→child (sitemap) or step→step (userflow); leave x/y at 0 and ask to lay out.",
      ].join("\n");
      window.api.ohanaWriteFile({ filename: "MOKA.md", content: md });
    } catch (e) {}
  }
  function renderFlowSwitcher() {
    const nm = document.getElementById("flow-switcher-name");
    if (nm) { const n = flowsForActive().length; nm.textContent = (activeFlowObj().name || "Flow") + (n > 1 ? "  (" + n + ")" : ""); }
    if (typeof renderBoardSwitch === "function") renderBoardSwitch();
  }
  function openFlowSwitcher(rect) {
    const own = flowsForActive();
    const orphans = orphanFlows();
    flowMenu.innerHTML =
      '<div class="fm-label">This tab’s flows</div>' +
      (own.length ? '' : '<div class="fm-empty-hint">This tab has no flows yet.</div>') +
      own.map((f) => '<div class="fm-item" data-fid="' + f.id + '">' + (f.id === flowDoc.active ? FI.check : '<span style="width:14px;display:inline-block;flex-shrink:0;"></span>') + escapeHtml(f.name || "Flow") + '</div>').join("") +
      '<div class="fm-sep"></div>' +
      '<div class="fm-item" data-act="new">' + FI.plus + ' New flow</div>' +
      '<div class="fm-item" data-act="rename">' + FI.edit + ' Rename current</div>' +
      (own.length > 1 ? '<div class="fm-item danger" data-act="delflow">' + FI.trash + ' Delete current flow</div>' : '') +
      (orphans.length ? '<div class="fm-sep"></div><div class="fm-label">Unassigned flows</div>' +
        '<div class="fm-empty-hint">Assign them to this tab to use them here.</div>' +
        orphans.map((f) => '<div class="fm-item" data-claim="' + f.id + '">' + FI.plus + ' ' + escapeHtml(f.name || "Flow") + '</div>').join("") : '');
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 220) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-fid]").forEach((it) => it.onclick = () => { flowDoc.active = it.dataset.fid; bindTabFlow(it.dataset.fid); flow = activeFlowObj(); flowSel = new Set(); flowView = { x: 40, y: 40, s: 1 }; saveFlow(); renderFlow(); renderFlowSwitcher(); closeFlowMenu(); });
    flowMenu.querySelectorAll("[data-claim]").forEach((it) => it.onclick = () => { const f = flowDoc.flows.find((x) => x.id === it.dataset.claim); if (f) { f.src = activeSrc(); flowDoc.active = f.id; bindTabFlow(f.id); flow = activeFlowObj(); flowSel = new Set(); flowView = { x: 40, y: 40, s: 1 }; saveFlow(); renderFlow(); renderFlowSwitcher(); closeFlowMenu(); } });
    flowMenu.querySelectorAll("[data-act]").forEach((it) => it.onclick = () => {
      const a = it.dataset.act;
      if (a === "new") { const f = { id: flowGenId(), name: "Flow " + (flowsForActive().length + 1), src: activeSrc(), screens: [], edges: [] }; flowDoc.flows.push(f); flowDoc.active = f.id; bindTabFlow(f.id); flow = f; flowView = { x: 40, y: 40, s: 1 }; saveFlow(); renderFlow(); renderFlowSwitcher(); closeFlowMenu(); }
      else if (a === "rename") { openFlowRename(); }
      else if (a === "delflow") {
        const gone = flowDoc.active;
        flowDoc.flows = flowDoc.flows.filter((f) => f.id !== gone);
        flowDoc.tabActive = flowDoc.tabActive || {};
        Object.keys(flowDoc.tabActive).forEach((k) => { if (flowDoc.tabActive[k] === gone) delete flowDoc.tabActive[k]; }); // unbind tabs that pointed here
        const rest = flowsForActive();
        if (rest.length) { flowDoc.active = rest[0].id; bindTabFlow(flowDoc.active); }
        else { ensureTabFlow(activeSrc()); } // tab emptied → give it a fresh flow
        flow = activeFlowObj(); saveFlow(); renderFlow(); renderFlowSwitcher(); closeFlowMenu();
      }
    });
  }
  function openFlowRename() {
    const f = activeFlowObj();
    flowMenu.innerHTML = '<div class="fm-label">Rename flow</div><input class="fm-edge-input" id="fm-rename" value="' + escapeHtml(f.name || "") + '" />';
    const inp = flowMenu.querySelector("#fm-rename");
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    const commit = () => { f.name = inp.value.trim() || "Flow"; saveFlow(); renderFlowSwitcher(); closeFlowMenu(); };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") commit(); };
    inp.onblur = commit;
  }

  function ensureBids() {
    let changed = false;
    flow.screens.forEach((s) => {
      if (s.kind === "decision") return;
      ensureLayout(s);
      eachBlock(s, (b) => { if (!b.bid) { b.bid = "b" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); changed = true; } });
    });
    if (changed) writeFlowFile(); // persist ids so block connections stay stable across reloads
  }
  // Stable, human-friendly node handles (P1, P2…) so prompts can name a screen.
  // Never reuse a number (flow.pmax only grows) so references don't drift on delete.
  function ensureHandles() {
    let changed = false;
    let max = flow.pmax || 0;
    flow.screens.forEach((s) => { const m = s.handle && /^P(\d+)$/.exec(s.handle); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    flow.screens.forEach((s) => { if (!s.handle) { s.handle = "P" + (++max); changed = true; } });
    if (max !== (flow.pmax || 0)) { flow.pmax = max; changed = true; }
    if (changed) writeFlowFile();
  }
  // Signature of everything that affects a card's DOM (NOT position/selection —
  // those are applied without a rebuild). If it's unchanged, we keep the element.
  const _screenSig = {};
  function screenSig(s) {
    return s.kind + "|" + screenStatus(s) + "|" + (s.variant || "") + "|" + flowFilter + "|" + (s.w || "") + "|" +
      JSON.stringify({ n: s.name, d: s.desc, a: s.apis, l: s.links, ly: s.layout, h: s.handle });
  }
  function renderFlow() {
    ensureBids();
    ensureHandles();
    // Heavy flows drop the (GPU-costly) card blur — see the .heavy CSS note.
    flowVp.classList.toggle("heavy", (flow.screens || []).length > 10);
    const vp = document.getElementById("flow-view-proto"); if (vp) vp.style.display = (flow && flow.proto) ? "" : "none"; // show "View prototype" when linked
    if (typeof hideActBar === "function") hideActBar();
    // Notes/sections/labels are few → cheap full rebuild.
    Array.from(flowNodes.querySelectorAll(".flow-note, .flow-section, .flow-label")).forEach((el) => el.remove());
    (flow.sections || []).forEach((g) => flowNodes.appendChild(buildSectionEl(g)));   // behind (low z)
    (flow.labels || []).forEach((l) => flowNodes.appendChild(buildLabelEl(l)));        // canvas headings
    reconcileScreens();                                                                 // virtualized (zoom-in) / stub blocks (zoom-out)
    (flow.notes || []).forEach((n) => flowNodes.appendChild(buildNoteEl(n)));          // above
    renderFlowEdges();
    flowEmpty.style.display = (flow.screens.length || (flow.notes || []).length || (flow.sections || []).length || (flow.labels || []).length) ? "none" : "flex";
    updateAlignBar();
    flowApplyView();
  }

  // ── Virtualization + LOD: keep the DOM bounded no matter how many screens ──
  // The world rect currently visible (in flow coords), expanded by a margin so
  // quick pans don't pop.
  function visibleWorldRect(marginPx) {
    const r = flowVp.getBoundingClientRect(), s = flowView.s || 1, m = marginPx || 0;
    return { x0: (-flowView.x - m) / s, y0: (-flowView.y - m) / s, x1: (r.width - flowView.x + m) / s, y1: (r.height - flowView.y + m) / s };
  }
  function screenInRect(sc, vr) {
    const d = nodeDim(sc), x = sc.x || 0, y = sc.y || 0;
    return x < vr.x1 && x + d.w > vr.x0 && y < vr.y1 && y + d.h > vr.y0;
  }
  function reconcileScreens() {
    // Always the REAL DOM cards (no canvas approximation → zero visual loss at any
    // zoom). Performance: flat surfaces at scale (.heavy, no blur/shadow) +
    // viewport virtualization so only what you can see exists in the DOM.
    const vr = visibleWorldRect(320);
    const visible = flow.screens.filter((s) => screenInRect(s, vr));
    const want = new Set(visible.map((s) => s.id));
    flowNodes.querySelectorAll(".flow-screen").forEach((el) => { if (!want.has(el.dataset.id)) el.remove(); });
    visible.forEach((s) => {
      const sig = screenSig(s);
      let el = flowNodes.querySelector('.flow-screen[data-id="' + s.id + '"]');
      if (!el || _screenSig[s.id] !== sig) {
        const fresh = buildScreenEl(s);
        if (el) flowNodes.replaceChild(fresh, el); else flowNodes.appendChild(fresh);
        _screenSig[s.id] = sig; _flowHeights[s.id] = fresh.offsetHeight;
      } else { el.style.left = (s.x || 0) + "px"; el.style.top = (s.y || 0) + "px"; }
    });
    refreshSelClasses();
  }
  // Re-cull on pan/zoom (throttled to one per frame). Edges live in the same
  // transformed layer, so they move for free — only cards need adding/removing.
  let _cullRAF = null;
  function scheduleCull() {
    if (_cullRAF) return;
    _cullRAF = requestAnimationFrame(() => { _cullRAF = null; if (flowMode && flow && flow.screens) reconcileScreens(); });
  }
  // Zoom-out overview: rasterize the whole flow to ONE canvas — real content
  // (kind color + title) + connections, fluid at any card count.
  function overRound(ctx, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawOverview() {
    const cv = document.getElementById("flow-overview"); if (!cv) return;
    const r = flowVp.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); cv.style.width = r.width + "px"; cv.style.height = r.height + "px"; }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
    const s = flowView.s, ox = flowView.x, oy = flowView.y;
    const byId = {}; flow.screens.forEach((sc) => (byId[sc.id] = sc));
    // connections first (center → center, in the edge's color)
    ctx.lineWidth = Math.max(0.75, 1.4 * s);
    (flow.edges || []).forEach((e) => {
      const a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
      const da = nodeDim(a), db = nodeDim(b);
      const ax = ((a.x || 0) + da.w / 2) * s + ox, ay = ((a.y || 0) + da.h / 2) * s + oy;
      const bx = ((b.x || 0) + db.w / 2) * s + ox, by = ((b.y || 0) + db.h / 2) * s + oy;
      ctx.strokeStyle = e.color || "rgba(255,255,255,0.16)";
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    });
    // cards: solid body + kind strip + the REAL content (title, sections,
    // components) drawn as text lines — same content as the DOM card, rasterized.
    const showText = s > 0.12;
    ctx.textBaseline = "top";
    flow.screens.forEach((sc) => {
      const d = nodeDim(sc), x = (sc.x || 0) * s + ox, y = (sc.y || 0) * s + oy, w = d.w * s, h = d.h * s;
      if (x + w < 0 || y + h < 0 || x > r.width || y > r.height) return; // cull off-screen
      const k = FLOW_KINDS[sc.kind] || FLOW_KINDS.page;
      ctx.fillStyle = "#23232a"; overRound(ctx, x, y, w, h, 4 * s); ctx.fill();
      ctx.fillStyle = k.color || "#7cb0ff"; ctx.fillRect(x, y, Math.max(2, 3 * s), h); // kind bar (left)
      ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1; overRound(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4 * s); ctx.stroke();
      if (!showText) return;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      const px = x + 9 * s, avail = w - 15 * s; let cy = y + 8 * s; const lh = Math.max(8, 13 * s);
      // title
      ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = "600 " + Math.max(7, 11 * s) + "px system-ui, sans-serif";
      ctx.fillText(fitText(ctx, sc.name || "Screen", avail), px, cy); cy += lh + 3 * s;
      // content lines (sections bold, components indented) — from the layout tree
      const lines = [];
      (function walk(n, depth) {
        if (!n) return;
        if (isCont(n)) { if (n.name && depth > 0) lines.push({ t: n.name, d: depth, b: true }); (n.children || []).forEach((c) => walk(c, depth + 1)); }
        else { const bc = blockContent(n); lines.push({ t: (bc.title || bc.type || "·"), d: depth, b: false }); }
      })(sc.layout, 0);
      for (let i = 0; i < lines.length && cy < y + h - 4 * s; i++) {
        const L = lines[i];
        ctx.fillStyle = L.b ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.8)";
        ctx.font = (L.b ? "600 " : "") + Math.max(6, 9.5 * s) + "px system-ui, sans-serif";
        ctx.fillText(fitText(ctx, L.t, avail - L.d * 4 * s), px + L.d * 4 * s, cy);
        cy += lh * 0.82;
      }
      ctx.restore();
    });
  }
  // Truncate text with an ellipsis to fit a pixel width on the canvas.
  function fitText(ctx, str, maxW) {
    str = String(str || ""); if (ctx.measureText(str).width <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(str.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1; }
    return lo > 0 ? str.slice(0, lo) + "…" : "";
  }

  function buildScreenEl(s) {
    const k = FLOW_KINDS[s.kind] || FLOW_KINDS.page;
    const st = screenStatus(s);
    const dimCls = (flowFilter !== "all" && st !== flowFilter) ? " fs-dim" : "";
    const el = document.createElement("div");
    el.dataset.id = s.id;
    el.style.left = (s.x || 0) + "px"; el.style.top = (s.y || 0) + "px";
    el.style.setProperty("--fs-accent", k.color);
    const PORT_ARR = { top: "M12 19V5M6 11l6-6 6 6", right: "M5 12h14M13 6l6 6-6 6", bottom: "M12 5v14M6 13l6 6 6-6", left: "M19 12H5M11 6l-6 6 6 6" };
    const portsFor = (sides) => sides.map((sd) => '<button class="fs-port" data-side="' + sd + '" title="Normal connection · drag to connect, click for a new screen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="' + PORT_ARR[sd] + '"/></svg></button>').join("");
    const ports = portsFor(["top", "right", "bottom", "left"]);
    // Predefined outputs (decision Yes/No, system Success/Error labels) — labeled + colored.
    const outs = BRANCH_OUTS[s.kind];
    const outsHtml = outs ? '<div class="fs-outs">' + outs.map((o, i) => '<button class="fs-out side-' + o.side + '" data-out="' + i + '" style="--oc:' + o.color + '" title="' + escapeHtml(o.label) + '"><span class="fs-out-dot"></span>' + escapeHtml(o.label) + '</button>').join("") + '</div>' : "";
    // Free sides keep a plain (blue) connector so the node can still branch normally.
    const freePorts = outs ? portsFor(["top", "right", "bottom", "left"].filter((sd) => !outs.some((o) => o.side === sd))) : ports;
    // Decision node — a diamond with an editable question + Yes/No outputs.
    // Empty-state is a per-node STATE: every kind carries the class + a floating tag.
    const varCls = s.variant === "empty" ? " variant-empty" : "";
    const varTag = s.variant === "empty" ? '<span class="fl-variant-tag floating" title="Empty state — toggle it from the ⋯ menu">' + FI.secEmpty + '<span>Empty</span></span>' : '';
    if (s.kind === "decision") {
      el.className = "flow-screen decision status-" + st + (flowSel.has(s.id) ? " selected" : "") + varCls + dimCls;
      el.innerHTML = varTag +
        '<button class="fs-menu-btn fs-dmenu" title="Options">' + FI.dots + '</button>' +
        '<div class="fs-diamond"><div class="fs-dlabel" contenteditable="true" spellcheck="false" data-ph="Decision?">' + escapeHtml(s.name || "") + '</div></div>' +
        outsHtml + freePorts;
      wireScreenEl(el, s);
      return el;
    }
    if (TERMINAL_KINDS[s.kind]) { // Start / End — terminator pill marking start/end of the experience
      el.className = "flow-screen terminal term-" + s.kind + (flowSel.has(s.id) ? " selected" : "") + varCls + dimCls;
      el.style.setProperty("--fs-accent", k.color);
      el.innerHTML = varTag +
        '<button class="fs-menu-btn fs-dmenu" title="Options">' + FI.dots + '</button>' +
        '<div class="fs-term"><span class="fs-term-ic">' + k.icon + '</span><div class="fs-dlabel" contenteditable="true" spellcheck="false" data-ph="' + escapeHtml(k.label) + '">' + escapeHtml(s.name || "") + '</div></div>' +
        ports;
      wireScreenEl(el, s);
      return el;
    }
    if (s.kind === "subflow") { // links to another flow in the project (click to open it)
      const target = (flowDoc.flows || []).find((f) => f.id === s.flowRef);
      el.className = "flow-screen compact ck-subflow" + (flowSel.has(s.id) ? " selected" : "") + varCls + dimCls;
      el.style.setProperty("--fs-accent", k.color);
      el.innerHTML = varTag +
        '<button class="fs-menu-btn fs-dmenu" title="Options">' + FI.dots + '</button>' +
        '<button class="fs-cnode fs-subflow" title="' + (target ? "Open linked flow" : "Link a flow from the project") + '">' +
          '<span class="fs-cnode-ic">' + k.icon + '</span>' +
          '<span class="fs-subflow-name' + (target ? "" : " ph") + '">' + escapeHtml(target ? target.name : "Link flow…") + '</span>' +
          '<span class="fs-subflow-go">' + (target ? FI.open : FI.plus) + '</span>' +
        '</button>' + ports;
      const btn = el.querySelector(".fs-subflow");
      let _sx = null, _sy = null; // distinguish a click (open) from a drag (move the node)
      btn.addEventListener("mousedown", (e) => { _sx = e.clientX; _sy = e.clientY; }); // no stopPropagation → dragH moves the node
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (_sx != null && Math.hypot(e.clientX - _sx, e.clientY - _sy) > 5) return; // it was a drag
        if (s.flowRef && target) openBoard(s.flowRef); else openSubflowPicker(s, btn.getBoundingClientRect());
      });
      wireScreenEl(el, s);
      return el;
    }
    if (COMPACT_KINDS[s.kind]) { // (compact flow nodes)
      el.className = "flow-screen compact ck-" + s.kind + (flowSel.has(s.id) ? " selected" : "") + varCls + dimCls;
      el.style.setProperty("--fs-accent", k.color);
      el.innerHTML = varTag +
        '<button class="fs-menu-btn fs-dmenu" title="Options">' + FI.dots + '</button>' +
        '<div class="fs-cnode"><span class="fs-cnode-ic">' + k.icon + '</span><div class="fs-dlabel" contenteditable="true" spellcheck="false" data-ph="' + escapeHtml(k.label) + '">' + escapeHtml(s.name || "") + '</div></div>' +
        (outs ? outsHtml + freePorts : ports);
      wireScreenEl(el, s);
      return el;
    }
    el.className = "flow-screen status-" + st + (flowSel.has(s.id) ? " selected" : "") + varCls + dimCls;
    el.style.width = (s.w || SCREEN_W) + "px";
    el.innerHTML =
      '<div class="fs-head">' +
        '<div class="fs-htop"><span class="fs-badge">' + escapeHtml(k.label) + '</span>' +
        '<button class="fs-status fs-status-' + st + '" title="Status: ' + FLOW_STATUS[st].label + ' (click to change)"><span class="fs-status-ic">' + FLOW_STATUS[st].icon + '</span>' + FLOW_STATUS[st].label + '</button>' +
        (s.variant === "empty" ? '<span class="fl-variant-tag" title="Empty state — toggle it from the ⋯ menu">' + FI.secEmpty + '<span>Empty</span></span>' : '') +
        '<span class="fs-hspace"></span>' +
        '<button class="fs-layout-btn" title="Screen layout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="9" x2="21" y2="9"/></svg></button>' +
        '<button class="fs-link-btn' + ((s.links && s.links.length) ? " on" : "") + '" title="Links to views / redirects">' + FI.link + '</button>' +
        '<button class="fs-api-btn' + ((s.apis && s.apis.length) ? " on" : "") + '" title="Endpoints / APIs that give this screen context">' + FI.db + '</button>' +
        '<button class="fs-menu-btn" title="Options">' + FI.dots + '</button></div>' +
        '<input class="fs-name" value="' + escapeHtml(s.name || "Screen") + '" spellcheck="false" /></div>' +
      '<div class="fs-context" contenteditable="true" spellcheck="false" data-ph="Context for this screen…">' + escapeHtml(s.desc || "") + '</div>' +
      ((s.apis || []).map((a) => '<div class="fs-api-chip">' + FI.db + '<span class="fs-api-ep">' + escapeHtml(a.endpoint || "") + '</span>' + (a.ctx ? '<span class="fs-api-ctx">' + escapeHtml(a.ctx) + '</span>' : "") + '</div>').join("")) +
      ((s.links || []).map((l) => '<div class="fs-link-chip" data-url="' + (l.url || "").replace(/"/g, "&quot;") + '"><span class="fs-link-dot"></span><span class="fs-link-url">' + escapeHtml(l.url || "") + '</span>' + (l.ctx ? '<span class="fs-link-ctx">' + escapeHtml(l.ctx) + '</span>' : "") + '</div>').join("")) +
      '<div class="fs-layout-host"></div>' +
      '<div class="fs-resize" title="Resize screen"></div>' +
      ports;
    ensureLayout(s);
    const host = el.querySelector(".fs-layout-host");
    // Card always hugs content; s.h is only a MINIMUM (floor) so the card grows
    // as you add blocks instead of clipping/overflowing.
    if (s.h) host.style.minHeight = s.h + "px";
    if (!s.layout.children.length) {
      // Collapsed (state 1): just head + name + context. A "Build" tab (hover,
      // sliding out from behind the bottom edge) seeds Header / Body / Footer.
      el.classList.add("collapsed");
      const build = document.createElement("button");
      build.className = "fs-build"; build.innerHTML = FI.workflow + "<span>Build</span>";
      build.addEventListener("mousedown", (e) => e.stopPropagation());
      build.addEventListener("click", (e) => { e.stopPropagation(); seedDefaultLayout(s); });
      el.appendChild(build);
    } else {
      // Expanded (estado 2): the layout renders its regions → sections → components.
      host.appendChild(buildNode(s, s.layout, null));
    }
    wireScreenEl(el, s);
    return el;
  }

  // Recursive layout renderer: containers (row/col, resizable via dividers) and
  // block leaves. Each node carries `grow` (flex weight) once resized.
  const FL_ICON = {
    row: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/></svg>',
    col: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="3" width="16" height="7" rx="1"/><rect x="4" y="14" width="16" height="7" rx="1"/></svg>',
    split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>',
  };
  function buildNode(s, node, parent) { return isCont(node) ? buildContainerNode(s, node, parent) : buildBlockNode(s, node, parent); }
  // Hierarchy: Screen → Layout → Region(s) → Section(s) → Component(s).
  //  · Simple screen: the root layout IS the single region (holds sections).
  //  · Grid screen: the root is a grid layout; its direct children are regions.
  //  · A region holds sections; a section holds components.
  function contLevel(s, cont, parent) {
    if (s && cont === s.layout) return "layout";    // root = the layout (holds regions)
    if (s && parent === s.layout) return "region";  // direct child of the layout = a region
    return "section";                               // inside a region = a section
  }
  function mkRegion(name) { return { cid: genCid(), dir: "col", name: name || "Region", children: [] }; }
  // "Build": seed the default layout — Header / Body / Footer regions.
  function seedDefaultLayout(s) { ensureLayout(s); s.layout.children = [mkRegion("Header"), mkRegion("Body"), mkRegion("Footer")]; saveFlow(); renderFlow(); }
  function buildContainerNode(s, cont, parent) {
    const editing = _renderingEditor;
    if (cont.grid) return buildGridNode(s, cont, parent);
    const el = document.createElement("div");
    const empty = cont.children.length === 0;
    const level = contLevel(s, cont, parent);
    el.className = "fl-cont lvl-" + level + (empty ? " empty" : "") + (cont.variant === "empty" ? " variant-empty" : "");
    el.dataset.cid = cont.cid;
    el.__fnode = cont; el.__fparent = parent; el.__fscreen = s; el.__editing = editing; // for the floating toolbar
    if (cont.grow) { el.style.flexGrow = cont.grow; } // basis comes from CSS (per parent direction)
    // Header row (name + ⋯ menu) — a flex row so the meatball is vertically centered
    // with the label. ALWAYS on top; the layout root has no header (it stacks regions).
    if (level === "region" || level === "section") {
      const head = document.createElement("div"); head.className = "fl-cont-head";
      const isRegion = level === "region";
      const nm = document.createElement("input"); nm.className = "fl-name fl-name-card" + (isRegion ? " fl-name-region" : ""); nm.value = cont.name || ""; nm.placeholder = isRegion ? "Region name" : "Section name";
      nm.addEventListener("mousedown", (e) => e.stopPropagation());
      nm.addEventListener("input", () => { cont.name = nm.value; saveFlow(); });
      head.appendChild(nm);
      if (cont.variant === "empty") { // the variant is a visible state, not a hidden flag
        const tag = document.createElement("span"); tag.className = "fl-variant-tag"; tag.title = "Empty state — toggle it from the ⋯ menu"; tag.innerHTML = FI.secEmpty + "<span>Empty</span>";
        head.appendChild(tag);
      }
      const mb = document.createElement("button"); mb.className = "fl-sec-menu"; mb.title = isRegion ? "Region options" : "Section options"; mb.innerHTML = FI.dots;
      mb.addEventListener("mousedown", (e) => e.stopPropagation());
      mb.addEventListener("click", (e) => { e.stopPropagation(); (isRegion ? openRegionMenu : openSectionMenu)(s, cont, parent, mb.getBoundingClientRect()); });
      head.appendChild(mb);
      el.appendChild(head);
      // Section description — context for the organism (auto-shown when it has
      // content; toggled from the ⋯ menu, same tri-state as component fields).
      const descVis = cont.showDesc !== undefined ? !!cont.showDesc : !!cont.desc;
      if (!isRegion && descVis) {
        const ds = document.createElement("div"); ds.className = "fl-sec-desc"; ds.contentEditable = "true"; ds.spellcheck = false; ds.dataset.ph = "Description…"; ds.textContent = cont.desc || "";
        ds.addEventListener("mousedown", (e) => e.stopPropagation());
        ds.addEventListener("input", () => { cont.desc = ds.textContent; saveFlow(); });
        el.appendChild(ds);
      }
    }
    // Body — the children flow here in the container's direction (row/col).
    const body = document.createElement("div"); body.className = "fl-body dir-" + (cont.dir === "row" ? "row" : "col");
    cont.children.forEach((child) => { body.appendChild(buildNode(s, child, cont)); });
    el.appendChild(body);
    // Add button by level:
    //  · Layout → "+ Region" bar (add another region).
    //  · Region → "+ Section" bar (add a section).
    //  · Section → the beloved circular "+" (anchored at its bottom) for COMPONENTS.
    if (!editing && s && level === "section") {
      const add = document.createElement("button"); add.className = "fl-add"; add.title = "Add component"; add.innerHTML = FI.plus;
      add.addEventListener("mousedown", (e) => e.stopPropagation());
      add.addEventListener("click", (e) => { e.stopPropagation(); openBlockPalette(s, add.getBoundingClientRect(), cont, "component"); });
      el.appendChild(add);
    } else if (!editing && s && level === "region") {
      const add = document.createElement("button"); add.className = "fl-add-section"; add.innerHTML = FI.plus + "<span>Section</span>";
      add.addEventListener("mousedown", (e) => e.stopPropagation());
      add.addEventListener("click", (e) => { e.stopPropagation(); quickAddSection(s, cont); });
      el.appendChild(add);
    }
    // (Regions are only added/changed from the layout — there's no "+ Region" here.)
    return el;
  }
  // Grid layout: {grid:{cols,rows}, children:[region containers with .area=[c0,r0,c1,r1]]}.
  // Renders as CSS grid; each region spans its painted cells and behaves as a section.
  function buildGridNode(s, cont, parent) {
    const el = document.createElement("div");
    el.className = "fl-cont fl-grid";
    el.dataset.cid = cont.cid;
    el.__fnode = cont; el.__fparent = parent; el.__fscreen = s; el.__editing = _renderingEditor;
    el.style.gridTemplateColumns = "repeat(" + cont.grid.cols + ",1fr)";
    // Rows hug their content (a min floor keeps empty regions tidy, not stretched tall).
    el.style.gridTemplateRows = "repeat(" + cont.grid.rows + ",minmax(46px,auto))";
    cont.children.forEach((region) => {
      const rEl = buildNode(s, region, cont);
      const a = region.area || [0, 0, 0, 0];
      rEl.style.gridColumn = (a[0] + 1) + " / " + (a[2] + 2);
      rEl.style.gridRow = (a[1] + 1) + " / " + (a[3] + 2);
      el.appendChild(rEl);
    });
    return el;
  }
  // ── Layout presets: pick a classic SaaS layout instead of building per card ──
  const BUILTIN_LAYOUTS = [
    { id: "vert", name: "Simple vertical", tree: { dir: "col", children: [] } },
    { id: "sidebar", name: "Sidebar + content", tree: { dir: "row", children: [{ dir: "col", name: "Navigation", grow: 28, children: [] }, { dir: "col", name: "Content", grow: 72, children: [] }] } },
    { id: "topbar", name: "Topbar + content", tree: { dir: "col", children: [{ dir: "row", name: "Top bar", grow: 14, children: [] }, { dir: "col", name: "Content", grow: 86, children: [] }] } },
    { id: "topsidebar", name: "Topbar + sidebar + content", tree: { dir: "col", children: [{ dir: "row", name: "Top bar", grow: 14, children: [] }, { dir: "row", grow: 86, children: [{ dir: "col", name: "Navigation", grow: 26, children: [] }, { dir: "col", name: "Content", grow: 74, children: [] }] }] } },
    { id: "subpanel", name: "Sidebar + subpanel + content", tree: { dir: "row", children: [{ dir: "col", name: "Navigation", grow: 20, children: [] }, { dir: "col", name: "Subpanel", grow: 26, children: [] }, { dir: "col", name: "Content", grow: 54, children: [] }] } },
    { id: "masterdetail", name: "Master–detail", tree: { dir: "row", children: [{ dir: "col", name: "List", grow: 36, children: [] }, { dir: "col", name: "Detail", grow: 64, children: [] }] } },
    { id: "twocol", name: "Two columns", tree: { dir: "row", children: [{ dir: "col", name: "Column 1", grow: 50, children: [] }, { dir: "col", name: "Column 2", grow: 50, children: [] }] } },
  ];
  function userLayouts() { return (flowDoc.layouts = flowDoc.layouts || []); }
  function allLayouts() { return BUILTIN_LAYOUTS.concat(userLayouts()); }
  function cloneTreeFresh(node) {
    const c = { cid: genCid(), dir: node.dir === "row" ? "row" : "col", children: (node.children || []).map(cloneTreeFresh) };
    if (node.name) c.name = node.name;
    if (node.grow) c.grow = node.grow;
    return c;
  }
  function collectBlocks(node, out) { if (isCont(node)) (node.children || []).forEach((c) => collectBlocks(c, out)); else out.push(node); return out; }
  function firstEmptyLeaf(node) { if (isCont(node)) { if (!node.children.length) return node; for (let i = 0; i < node.children.length; i++) { const r = firstEmptyLeaf(node.children[i]); if (r) return r; } } return null; }
  function skeletonOf(node) { // a preset = region structure only (blocks stripped → empty named regions)
    const o = { dir: node.dir === "row" ? "row" : "col", children: (node.children || []).filter(isCont).map(skeletonOf) };
    if (node.name) o.name = node.name; if (node.grow) o.grow = node.grow;
    return o;
  }
  // Build the screen's layout from a preset. Grid presets → a grid container node
  // {grid:{cols,rows}, children:[{area:[c0,r0,c1,r1], name, children:[]}]}.
  // Tree presets (built-ins) → the nested row/col path (unchanged).
  function gridLayoutFromPreset(p) {
    return { cid: genCid(), grid: { cols: p.grid.cols, rows: p.grid.rows }, children: (p.regions || []).map((g) => ({ cid: genCid(), name: g.name || "", dir: g.dir === "row" ? "row" : "col", area: [g.c0, g.r0, g.c1, g.r1], children: [] })) };
  }
  function applyLayout(s, preset) {
    const keep = []; if (s.layout) collectBlocks(s.layout, keep); // don't lose existing blocks
    s.layout = preset && preset.grid ? gridLayoutFromPreset(preset) : cloneTreeFresh(preset.tree ? preset.tree : preset);
    if (keep.length) { const slot = firstEmptyLeaf(s.layout) || s.layout; slot.children.push.apply(slot.children, keep); }
    saveFlow(); renderFlow();
  }
  function layoutThumb(preset) {
    if (preset && preset.grid) {
      const g = preset.grid;
      let cells = '<div class="lt-grid" style="grid-template-columns:repeat(' + g.cols + ',1fr);grid-template-rows:repeat(' + g.rows + ',1fr)">';
      (preset.regions || []).forEach((rg) => { cells += '<div class="lt-region" style="grid-column:' + (rg.c0 + 1) + '/' + (rg.c1 + 2) + ';grid-row:' + (rg.r0 + 1) + '/' + (rg.r1 + 2) + ';background:' + (rg.color || "#7cb0ff") + '"></div>'; });
      return cells + '</div>';
    }
    const tree = preset.tree ? preset.tree : preset;
    const box = (n) => (isCont(n) && n.children.length)
      ? '<div class="lt-box dir-' + (n.dir === "row" ? "row" : "col") + '" style="flex-grow:' + (n.grow || 1) + '">' + n.children.map(box).join("") + '</div>'
      : '<div class="lt-cell" style="flex-grow:' + (n.grow || 1) + '"></div>';
    return '<div class="lt-thumb dir-' + (tree.dir === "row" ? "row" : "col") + '">' + (tree.children && tree.children.length ? tree.children.map(box).join("") : '<div class="lt-cell"></div>') + '</div>';
  }
  function openLayoutPicker(s, rect) {
    let html = '<div class="fm-label">Screen layout</div><div class="lp-grid">';
    html += allLayouts().map((L) => {
      const isUser = BUILTIN_LAYOUTS.indexOf(L) === -1;
      return '<button class="lp-item' + (isUser ? " user" : "") + '" data-lid="' + L.id + '">' + layoutThumb(L) + '<span>' + escapeHtml(L.name) + '</span>' +
        (isUser ? '<span class="lp-edit" data-edit="' + L.id + '" title="Edit layout">' + FI.edit + '</span><span class="lp-del" data-del="' + L.id + '" title="Delete layout">' + FI.x + '</span>' : "") + '</button>';
    }).join("");
    html += '</div><div class="fm-sep"></div><div class="fm-item" data-act="new">' + FI.plus + ' Create new layout…</div>';
    flowMenu.innerHTML = html;
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 340) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible", "wide");
    flowMenu.querySelectorAll(".lp-item").forEach((b) => b.onclick = (e) => {
      const delEl = e.target.closest(".lp-del"), editEl = e.target.closest(".lp-edit");
      if (delEl) { e.stopPropagation(); flowDoc.layouts = userLayouts().filter((x) => x.id !== delEl.dataset.del); saveFlow(); openLayoutPicker(s, rect); return; }
      if (editEl) { e.stopPropagation(); const u = userLayouts().find((x) => x.id === editEl.dataset.edit); if (u) { closeFlowMenu(); openLayoutEditor(u, s); } return; }
      const L = allLayouts().find((x) => x.id === b.dataset.lid); if (L) { applyLayout(s, L); closeFlowMenu(); }
    });
    flowMenu.querySelector('[data-act="new"]').onclick = () => { closeFlowMenu(); openLayoutEditor(null, s); };
  }
  // ── Layout editor (modal): build/edit a layout template with structure tools ──
  // ── Layout editor: a GRID PAINTER. Set the grid resolution, then drag across
  //    cells to paint each region (like CSS grid-template-areas). Structure only. ──
  let _leCols = 4, _leRows = 3, _leRegions = [], _leName = "", _leId = null, _editScreen = null;
  const LE_COLORS = ["#7cb0ff", "#f5d90a", "#46c890", "#f87171", "#a78bfa", "#fb923c", "#22d3ee"];
  function cellOccupied(c, r, exceptId) {
    return _leRegions.some((g) => g.id !== exceptId && c >= g.c0 && c <= g.c1 && r >= g.r0 && r <= g.r1);
  }
  function rectFree(c0, r0, c1, r1, exceptId) {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (cellOccupied(c, r, exceptId)) return false;
    return true;
  }
  function renderLayoutEditor() {
    const host = document.getElementById("le-host"); if (!host) return;
    document.getElementById("le-cols").textContent = _leCols;
    document.getElementById("le-rows").textContent = _leRows;
    host.style.gridTemplateColumns = "repeat(" + _leCols + ",1fr)";
    host.style.gridTemplateRows = "repeat(" + _leRows + ",1fr)";
    host.innerHTML = "";
    for (let r = 0; r < _leRows; r++) for (let c = 0; c < _leCols; c++) {
      const cell = document.createElement("div");
      cell.className = "le-cell" + (cellOccupied(c, r) ? " taken" : "");
      cell.dataset.c = c; cell.dataset.r = r;
      host.appendChild(cell);
    }
    // Regions overlaid by percentage (independent of the cell grid flow).
    _leRegions.forEach((g) => {
      const el = document.createElement("div"); el.className = "le-region"; el.dataset.id = g.id;
      el.style.left = (g.c0 / _leCols * 100) + "%"; el.style.width = ((g.c1 - g.c0 + 1) / _leCols * 100) + "%";
      el.style.top = (g.r0 / _leRows * 100) + "%"; el.style.height = ((g.r1 - g.r0 + 1) / _leRows * 100) + "%";
      el.style.setProperty("--rc", g.color);
      const isRow = g.dir === "row";
      el.innerHTML = '<div class="le-region-head"><input class="le-region-name" value="' + escapeHtml(g.name) + '" spellcheck="false"><button class="le-region-del" title="Delete region">' + FI.x + '</button></div>' +
        '<button class="le-region-dir" title="Content direction: ' + (isRow ? "horizontal" : "vertical") + '">' + (isRow ? FI.dirRow : FI.dirCol) + '</button>';
      el.querySelector(".le-region-name").addEventListener("input", (e) => { g.name = e.target.value; });
      el.querySelector(".le-region-name").addEventListener("mousedown", (e) => e.stopPropagation());
      el.querySelector(".le-region-del").addEventListener("mousedown", (e) => { e.stopPropagation(); _leRegions = _leRegions.filter((x) => x.id !== g.id); renderLayoutEditor(); });
      el.querySelector(".le-region-dir").addEventListener("mousedown", (e) => { e.stopPropagation(); g.dir = isRow ? "col" : "row"; renderLayoutEditor(); });
      // Resize handles: drag any edge/corner to change how many cells the region spans.
      ["n", "s", "e", "w", "ne", "nw", "se", "sw"].forEach((pos) => {
        const h = document.createElement("div"); h.className = "le-rz le-rz-" + pos;
        h.addEventListener("mousedown", (ev) => startRegionResize(ev, g, pos));
        el.appendChild(h);
      });
      host.appendChild(el);
    });
    // Paint preview overlay (shown during drag).
    const pv = document.createElement("div"); pv.className = "le-paint"; pv.id = "le-paint"; pv.style.display = "none";
    host.appendChild(pv);
  }
  // Drag-to-paint on the grid host.
  function initLayoutPainter() {
    const host = document.getElementById("le-host"); if (!host || host._painterInit) return; host._painterInit = true;
    let start = null;
    const cellAt = (ev) => { const el = document.elementFromPoint(ev.clientX, ev.clientY); const cell = el && el.closest && el.closest(".le-cell"); return cell ? { c: +cell.dataset.c, r: +cell.dataset.r } : null; };
    host.addEventListener("mousedown", (ev) => {
      if (ev.target.closest(".le-region")) return;         // clicking a region → its own controls
      const cell = cellAt(ev); if (!cell || cellOccupied(cell.c, cell.r)) return;
      start = cell; ev.preventDefault();
      const move = (mv) => {
        const cur = cellAt(mv) || cell;
        const c0 = Math.min(start.c, cur.c), c1 = Math.max(start.c, cur.c), r0 = Math.min(start.r, cur.r), r1 = Math.max(start.r, cur.r);
        const pv = document.getElementById("le-paint"); if (!pv) return;
        const ok = rectFree(c0, r0, c1, r1);
        pv.style.display = "block"; pv.classList.toggle("bad", !ok);
        pv.style.left = (c0 / _leCols * 100) + "%"; pv.style.width = ((c1 - c0 + 1) / _leCols * 100) + "%";
        pv.style.top = (r0 / _leRows * 100) + "%"; pv.style.height = ((r1 - r0 + 1) / _leRows * 100) + "%";
      };
      const up = (uv) => {
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
        const cur = cellAt(uv) || start;
        const c0 = Math.min(start.c, cur.c), c1 = Math.max(start.c, cur.c), r0 = Math.min(start.r, cur.r), r1 = Math.max(start.r, cur.r);
        start = null;
        if (rectFree(c0, r0, c1, r1)) _leRegions.push({ id: flowGenId(), name: "Region " + (_leRegions.length + 1), c0: c0, r0: r0, c1: c1, r1: r1, dir: "col", color: LE_COLORS[_leRegions.length % LE_COLORS.length] });
        renderLayoutEditor();
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
      move(ev);
    });
  }
  // Drag a region's edge/corner to resize its cell span (snaps to the grid, no overlaps).
  function startRegionResize(ev, g, pos) {
    ev.preventDefault(); ev.stopPropagation();
    const host = document.getElementById("le-host"); if (!host) return;
    const rect = host.getBoundingClientRect();
    const cellW = rect.width / _leCols, cellH = rect.height / _leRows;
    const orig = { c0: g.c0, r0: g.r0, c1: g.c1, r1: g.r1 };
    const move = (mv) => {
      const col = Math.max(0, Math.min(_leCols - 1, Math.floor((mv.clientX - rect.left) / cellW)));
      const row = Math.max(0, Math.min(_leRows - 1, Math.floor((mv.clientY - rect.top) / cellH)));
      let c0 = orig.c0, r0 = orig.r0, c1 = orig.c1, r1 = orig.r1;
      if (pos.indexOf("e") !== -1) c1 = Math.max(orig.c0, col);
      if (pos.indexOf("w") !== -1) c0 = Math.min(orig.c1, col);
      if (pos.indexOf("s") !== -1) r1 = Math.max(orig.r0, row);
      if (pos.indexOf("n") !== -1) r0 = Math.min(orig.r1, row);
      if ((c0 !== g.c0 || r0 !== g.r0 || c1 !== g.c1 || r1 !== g.r1) && rectFree(c0, r0, c1, r1, g.id)) {
        g.c0 = c0; g.r0 = r0; g.c1 = c1; g.r1 = r1; renderLayoutEditor();
      }
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  function setLeGrid(cols, rows) {
    _leCols = Math.max(1, Math.min(12, cols)); _leRows = Math.max(1, Math.min(12, rows));
    // Drop regions that fall outside the new grid.
    _leRegions = _leRegions.filter((g) => g.c1 < _leCols && g.r1 < _leRows);
    renderLayoutEditor();
  }
  function openLayoutEditor(preset, screen) {
    _editScreen = screen || null;
    if (preset && preset.grid) { _leCols = preset.grid.cols; _leRows = preset.grid.rows; _leRegions = (preset.regions || []).map((g, i) => ({ id: flowGenId(), name: g.name || "Region", c0: g.c0, r0: g.r0, c1: g.c1, r1: g.r1, dir: g.dir === "row" ? "row" : "col", color: g.color || LE_COLORS[i % LE_COLORS.length] })); _leName = preset.name || ""; _leId = (preset.userId || preset.id) || null; }
    else { _leCols = 4; _leRows = 3; _leRegions = []; _leName = ""; _leId = null; }
    const nameInp = document.getElementById("le-name"); if (nameInp) nameInp.value = _leName;
    document.getElementById("layout-editor").classList.add("visible");
    renderLayoutEditor(); initLayoutPainter();
  }
  function closeLayoutEditor() { document.getElementById("layout-editor").classList.remove("visible"); }
  function saveLayoutEditor() {
    const name = (document.getElementById("le-name").value || "").trim() || "Layout";
    if (!_leRegions.length) { showToast("Paint at least one region", "warn"); return; }
    const grid = { cols: _leCols, rows: _leRows };
    const regions = _leRegions.map((g) => ({ name: g.name, c0: g.c0, r0: g.r0, c1: g.c1, r1: g.r1, dir: g.dir === "row" ? "row" : "col", color: g.color }));
    if (_leId) { const u = userLayouts().find((x) => x.id === _leId); if (u) { u.name = name; u.grid = grid; u.regions = regions; delete u.tree; } else userLayouts().push({ id: _leId, name: name, grid: grid, regions: regions }); }
    else { _leId = flowGenId(); userLayouts().push({ id: _leId, name: name, grid: grid, regions: regions }); }
    saveFlow();
    if (_editScreen) applyLayout(_editScreen, { grid: grid, regions: regions });
    closeLayoutEditor();
    showToast('Layout "' + name + '" saved', "check");
  }
  // Divide a region into two (wrapping any existing content into the first).
  function divideRegion(cont, mainDir) {
    const sub = mainDir === "row" ? "col" : "row";
    if (!cont.children.length) {
      cont.dir = mainDir;
      cont.children = [{ cid: genCid(), dir: sub, children: [] }, { cid: genCid(), dir: sub, children: [] }];
    } else {
      const inner = { cid: genCid(), dir: cont.dir, children: cont.children };
      cont.dir = mainDir;
      cont.children = [inner, { cid: genCid(), dir: sub, children: [] }];
    }
  }
  // ── FigJam-style floating toolbar: ONE bar, appears above whatever you hover,
  //    with that element's actions. Same pattern for regions and blocks. ──
  const flowActBar = document.createElement("div");
  flowActBar.className = "fl-actbar";
  let _actHideT = null, _actEl = null;
  let _renderingEditor = false; // true while rendering the layout editor (structure tools on)
  function hideActBar() { flowActBar.classList.remove("visible"); _actEl = null; if (_actHideT) { clearTimeout(_actHideT); _actHideT = null; } }
  function actBtn(a, icon, label) { return '<button class="fl-ab-btn" data-a="' + a + '" title="' + label + '">' + icon + (label ? '<span>' + label + '</span>' : "") + '</button>'; }
  function showActBarFor(el) {
    const node = el.__fnode, parent = el.__fparent, s = el.__fscreen, editing = !!el.__editing;
    if (!node) return;
    if (!editing && !s) return;
    const host = editing ? document.getElementById("le-stage") : flowVp;
    if (!host) return;
    if (flowActBar.parentElement !== host) host.appendChild(flowActBar);
    _actEl = el;
    if (isCont(node)) {
      // editor → structure tools; card → add a block; sections also reorder
      // (move before/after within their region) right from the bar.
      const isSection = !editing && s && contLevel(s, node, parent) === "section";
      flowActBar.innerHTML = editing
        ? actBtn("cols", FL_ICON.row, "Columns") + actBtn("rows", FL_ICON.col, "Rows") + actBtn("region", FL_ICON.split, "Region") + (parent ? '<span class="fl-ab-sep"></span>' + actBtn("del", FI.trash, "") : "")
        : (isSection ? actBtn("up", FI.up, "") + actBtn("down", FI.down, "") + '<span class="fl-ab-sep"></span>' : "") + actBtn("block", FI.plus, "Block");
    } else {
      flowActBar.innerHTML = actBtn("up", FI.up, "") + actBtn("down", FI.down, "") + actBtn("global", FI.diamond, node.globalId ? "Detach" : "Global") + actBtn("opts", FI.dots, "") + '<span class="fl-ab-sep"></span>' + actBtn("del", FI.trash, "");
    }
    const vr = host.getBoundingClientRect(), r = el.getBoundingClientRect();
    flowActBar.style.left = (r.left - vr.left + r.width / 2) + "px";
    flowActBar.style.top = Math.max(4, r.top - vr.top - 34) + "px";
    flowActBar.classList.add("visible");
    flowActBar.querySelectorAll("[data-a]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); actDo(s, node, parent, b.dataset.a, editing); });
  }
  function actDo(s, node, parent, a, editing) {
    if (isCont(node)) {
      if (a === "block") { openBlockPalette(s, flowActBar.getBoundingClientRect(), node); return; }
      if (a === "up" || a === "down") { // reorder a section within its region
        const arr = parent && parent.children;
        if (arr) { const i = arr.indexOf(node), j = a === "up" ? i - 1 : i + 1; if (i !== -1 && j >= 0 && j < arr.length) { arr[i] = arr[j]; arr[j] = node; } }
      }
      else if (a === "cols") divideRegion(node, "row");
      else if (a === "rows") divideRegion(node, "col");
      else if (a === "region") node.children.push({ cid: genCid(), dir: node.dir === "row" ? "col" : "row", children: [] });
      else if (a === "del" && parent) { const i = parent.children.indexOf(node); if (i !== -1) parent.children.splice(i, 1); }
    } else {
      if (a === "opts") { openBlockOptsMenu(s, node, flowActBar.getBoundingClientRect()); return; }
      const arr = parent.children, bi = arr.indexOf(node);
      if (a === "del") arr.splice(bi, 1);
      else if (a === "up" && bi > 0) { arr[bi] = arr[bi - 1]; arr[bi - 1] = node; }
      else if (a === "down" && bi < arr.length - 1) { arr[bi] = arr[bi + 1]; arr[bi + 1] = node; }
      else if (a === "global") {
        if (node.globalId) {
          const gid = node.globalId, g = flowGlobals()[gid];
          arr[bi] = g ? { bid: node.bid, type: g.type, title: g.title, desc: g.desc, items: (g.items || []).slice() } : { bid: node.bid, title: "Block" };
          // Globals are DOC-wide (shared across flows): drop the entry only when
          // no block in ANY flow still references it.
          const used = (flowDoc.flows || []).some((f) => (f.screens || []).some((sc) => { let hit = false; eachBlock(sc, (b) => { if (b.globalId === gid) hit = true; }); return hit; }));
          if (!used) delete flowGlobals()[gid];
        }
        else { const gid = flowGenId(); flowGlobals()[gid] = { type: node.type, title: node.title || "Bloque", desc: node.desc || "", items: (node.items || []).slice() }; arr[bi] = { bid: node.bid, globalId: gid }; }
      }
    }
    hideActBar();
    if (editing) renderLayoutEditor(); else { saveFlow(); renderFlow(); }
  }
  flowActBar.addEventListener("mouseenter", () => { if (_actHideT) { clearTimeout(_actHideT); _actHideT = null; } });
  flowActBar.addEventListener("mouseleave", () => { _actHideT = setTimeout(hideActBar, 160); });
  function buildDivider(s, cont, i) {
    const d = document.createElement("div");
    d.className = "fl-div dir-" + (cont.dir === "row" ? "row" : "col");
    d.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const host = d.parentElement;
      const kids = Array.from(host.children).filter((c) => c.classList.contains("fl-cont") || c.classList.contains("fs-block"));
      const aEl = kids[i], bEl = kids[i + 1]; if (!aEl || !bEl) return;
      const row = cont.dir === "row";
      const a0 = row ? aEl.offsetWidth : aEl.offsetHeight, b0 = row ? bEl.offsetWidth : bEl.offsetHeight;
      const start = row ? e.clientX : e.clientY;
      const ca = cont.children[i], cb = cont.children[i + 1];
      const move = (ev) => {
        const delta = (row ? ev.clientX : ev.clientY) - start; // editor host isn't scaled
        const na = Math.max(28, a0 + delta), nb = Math.max(28, b0 - delta);
        ca.grow = Math.round(na); cb.grow = Math.round(nb);
        aEl.style.flexGrow = ca.grow; bEl.style.flexGrow = cb.grow;
        aEl.style.flexBasis = "0"; bEl.style.flexBasis = "0";
      };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
    return d;
  }
  // Effective visibility of a block's optional fields (title / description /
  // elements). undefined = auto: show only when there's real content.
  function blockFieldVis(bc) {
    return {
      title: bc.showTitle !== undefined ? !!bc.showTitle : (!bc.type || !!(bc.title && bc.title !== bc.type)),
      desc: bc.showDesc !== undefined ? !!bc.showDesc : !!bc.desc,
      items: bc.showItems !== undefined ? !!bc.showItems : !!((bc.items || []).length),
    };
  }
  // The block's meatball: switches for what this component card shows.
  function openBlockOptsMenu(s, blk, rect) {
    const bc = blockContent(blk);
    const paint = () => {
      const fx = blockFieldVis(bc);
      const sw = (a, icon, label, on) => '<div class="fm-item" data-a="' + a + '">' + icon + '<span>' + label + '</span>' + (on ? '<span class="fm-check">✓</span>' : '') + '</div>';
      flowMenu.classList.remove("palette");
      flowMenu.innerHTML =
        '<div class="fm-label">This component shows</div>' +
        sw("title", FI.edit, "Custom title", fx.title) +
        sw("desc", FI.fileText, "Description", fx.desc) +
        sw("items", FI.menu, "Elements", fx.items);
      flowMenu.style.left = Math.min(rect.left, window.innerWidth - 210) + "px";
      flowMenu.style.top = (rect.bottom + 6) + "px";
      flowMenu.classList.add("visible");
      flowMenu.querySelectorAll("[data-a]").forEach((it) => it.onclick = (e) => {
        e.stopPropagation();
        const a = it.dataset.a, cur = blockFieldVis(bc);
        if (a === "title") { bc.showTitle = !cur.title; if (bc.showTitle && !bc.title) bc.title = bc.type || ""; }
        else if (a === "desc") bc.showDesc = !cur.desc;
        else if (a === "items") { bc.showItems = !cur.items; if (bc.showItems) bc.items = bc.items || []; }
        saveFlow(); renderFlow();
        paint(); // keep the menu open — flipping several switches in a row is the normal case
      });
    };
    paint();
  }
  function buildBlockNode(s, blk, parent) {
    const bc = blockContent(blk), isG = !!blk.globalId;
    const el = document.createElement("div");
    el.className = "fs-block" + (isG ? " global" : "");
    el.dataset.bid = blk.bid || "";
    el.__fnode = blk; el.__fparent = parent; el.__fscreen = s; el.__editing = false; // for the floating toolbar
    if (blk.grow) { el.style.flexGrow = blk.grow; }
    // Compact by default: a fresh component is just its blue type label. Title,
    // description, and elements appear when they have content (legacy blocks)
    // or when their switch is flipped in the block's ⋯ menu (tri-state:
    // undefined = auto-by-content, true/false = the user's explicit choice).
    const fx = blockFieldVis(bc);
    el.innerHTML =
      '<button class="fb-port" title="Connect block"></button>' +
      (isG ? '<div class="fb-global">Global · ' + globalCount(blk.globalId) + ' use' + (globalCount(blk.globalId) === 1 ? "" : "s") + '</div>' : '') +
      (bc.type ? '<div class="fb-type">' + (FI[bc.icon] || FI[iconForType(bc.type)] || FI.diamond) + '<span>' + escapeHtml(bc.type) + '</span></div>' : '') +
      (fx.title ? '<div class="fb-title" contenteditable="true" spellcheck="false">' + escapeHtml(bc.title || "Block") + '</div>' : '') +
      (fx.desc ? '<div class="fb-desc" contenteditable="true" spellcheck="false" data-ph="Description…">' + escapeHtml(bc.desc || "") + '</div>' : '') +
      (fx.items ? '<div class="fb-items">' +
        (bc.items || []).map((it, j) => '<div class="fb-item" data-ii="' + j + '"><span class="fb-item-dot"></span><span class="fb-item-txt" contenteditable="true" spellcheck="false">' + escapeHtml(it) + '</span><button class="fb-item-x" data-ii="' + j + '" title="Remove">' + FI.x + '</button></div>').join("") +
      '</div>' +
      '<button class="fb-add-item">' + FI.plus + ' Element</button>' : '');
    const t = el.querySelector(".fb-title"), dd = el.querySelector(".fb-desc");
    const sync = () => { if (t) bc.title = t.textContent; if (dd) bc.desc = dd.textContent; saveFlow(); };
    [t, dd].forEach((n) => { if (!n) return; n.addEventListener("input", sync); n.addEventListener("mousedown", (e) => e.stopPropagation()); });
    el.querySelectorAll(".fb-item").forEach((iEl) => {
      const ii = parseInt(iEl.dataset.ii, 10), txt = iEl.querySelector(".fb-item-txt");
      txt.addEventListener("mousedown", (e) => e.stopPropagation());
      txt.addEventListener("input", () => { if (bc.items) { bc.items[ii] = txt.textContent; saveFlow(); } });
      const x = iEl.querySelector(".fb-item-x");
      x.addEventListener("mousedown", (e) => e.stopPropagation());
      x.addEventListener("click", (e) => { e.stopPropagation(); bc.items.splice(ii, 1); saveFlow(); renderFlow(); });
    });
    const ai = el.querySelector(".fb-add-item");
    if (ai) {
      ai.addEventListener("mousedown", (e) => e.stopPropagation());
      ai.addEventListener("click", (e) => { e.stopPropagation(); bc.items = bc.items || []; bc.items.push("Element"); saveFlow(); renderFlow(); });
    }
    const bp = el.querySelector(".fb-port");
    if (bp) bp.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); startBlockConnect(s.id, blk.bid); });
    return el;
  }

  function wireScreenEl(el, s) {
    // Node handle (P1…) stays internal — used by the MCP + export so the IA can resolve
    // which screen the user means (by name, resolved behind the scenes). Not shown in the UI.
    const dragH = el.querySelector(".fs-head") || el.querySelector(".fs-diamond") || el.querySelector(".fs-term") || el.querySelector(".fs-cnode") || el.querySelector(".fs-subflow");
    const nameEl = el.querySelector(".fs-name") || el.querySelector(".fs-dlabel"); // input or contenteditable
    // select (body clicks; head clicks are handled by the drag handler below)
    el.addEventListener("mousedown", (e) => { if (e.target.closest(".fs-head, .fs-diamond")) return; selectMouse(s, e); });
    // rename (works for both the <input> name and the diamond's contenteditable label)
    if (nameEl) {
      nameEl.addEventListener("input", () => { s.name = (nameEl.value !== undefined ? nameEl.value : nameEl.textContent); saveFlow(); });
      nameEl.addEventListener("mousedown", (e) => e.stopPropagation());
    }
    const ctxEl = el.querySelector(".fs-context");
    if (ctxEl) {
      ctxEl.addEventListener("input", () => { s.desc = ctxEl.textContent; saveFlow(); });
      ctxEl.addEventListener("mousedown", (e) => e.stopPropagation());
    }
    // api button → endpoint editor
    const apiBtn = el.querySelector(".fs-api-btn");
    if (apiBtn) { apiBtn.addEventListener("mousedown", (e) => e.stopPropagation()); apiBtn.addEventListener("click", (e) => { e.stopPropagation(); openApiEditor(s, apiBtn.getBoundingClientRect()); }); }
    // link button → links editor (same pattern as the api/db button)
    const linkBtn = el.querySelector(".fs-link-btn");
    if (linkBtn) { linkBtn.addEventListener("mousedown", (e) => e.stopPropagation()); linkBtn.addEventListener("click", (e) => { e.stopPropagation(); openLinksEditor(s, linkBtn.getBoundingClientRect()); }); }
    const layoutBtn = el.querySelector(".fs-layout-btn");
    if (layoutBtn) { layoutBtn.addEventListener("mousedown", (e) => e.stopPropagation()); layoutBtn.addEventListener("click", (e) => { e.stopPropagation(); openLayoutPicker(s, layoutBtn.getBoundingClientRect()); }); }
    // status pill → cycle to build → in progress → done
    const stBtn = el.querySelector(".fs-status");
    if (stBtn) { stBtn.addEventListener("mousedown", (e) => e.stopPropagation()); stBtn.addEventListener("click", (e) => { e.stopPropagation(); const ni = (STATUS_ORDER.indexOf(screenStatus(s)) + 1) % STATUS_ORDER.length; s.status = STATUS_ORDER[ni]; saveFlow(); renderFlow(); }); }
    // link chips → open that view in Preview
    el.querySelectorAll(".fs-link-chip").forEach((chip) => {
      chip.addEventListener("mousedown", (e) => e.stopPropagation());
      chip.addEventListener("click", (e) => { e.stopPropagation(); const u = chip.dataset.url; if (u) openLinkedView(u); });
    });
    // drag by head/diamond — moves the whole selection; Alt or Ctrl+Shift duplicates
    if (dragH) dragH.addEventListener("mousedown", (e) => {
      if (e.target.closest(".fs-name, .fs-dlabel, .fs-menu-btn, .fs-api-btn, .fs-link-btn, .fs-status, .fs-layout-btn")) return;
      e.preventDefault();
      selectMouse(s, e);                                   // set/extend selection first
      if (!flowSel.has(s.id)) return;                      // a shift-click that deselected → no drag
      const dup = e.altKey || (e.ctrlKey && e.shiftKey);   // duplicate-by-dragging
      dragH.classList.add("dragging");
      // group: capture the origin of every selected screen + their DOM nodes
      const group = selectedScreens().map((g) => ({ s: g, ox: g.x || 0, oy: g.y || 0, el: flowNodes.querySelector('.flow-screen[data-id="' + g.id + '"]') }));
      const startW = flowWorld(e.clientX, e.clientY); let dx = 0, dy = 0;
      const move = (ev) => {
        const w = flowWorld(ev.clientX, ev.clientY); dx = Math.round(w.x - startW.x); dy = Math.round(w.y - startW.y);
        if (flowSnap) { dx = snapv(group[0].ox + dx) - group[0].ox; dy = snapv(group[0].oy + dy) - group[0].oy; } // snap by the anchor card, keep relative offsets
        if (dx || dy) _edgeRoutes = {}; // moving a card invalidates the auto-routed lanes → direct until next "ordenar"
        group.forEach((g) => { g.s.x = g.ox + dx; g.s.y = g.oy + dy; if (g.el) { g.el.style.left = g.s.x + "px"; g.el.style.top = g.s.y + "px"; } });
        scheduleEdgeRender();
      };
      const up = () => {
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); dragH.classList.remove("dragging");
        if (dup && (dx || dy)) { // leave originals in place, drop a duplicate at the moved offset
          const snap = group.map((g) => g.s);
          group.forEach((g) => { g.s.x = g.ox; g.s.y = g.oy; });
          const ids = new Set(snap.map((g) => g.id));
          insertScreens(snap, internalEdges(ids), dx, dy);
        }
        saveFlow(); renderFlow();
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
    // (block leaves + containers wire themselves in buildBlockNode/buildContainerNode)
    // resize handle → set the screen card's width/height (wireframe sizing)
    const rz = el.querySelector(".fs-resize");
    if (rz) rz.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const host = el.querySelector(".fs-layout-host");
      const w0 = s.w || el.offsetWidth, h0 = s.h || (host ? host.offsetHeight : 160);
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        s.w = Math.max(200, Math.round(w0 + (ev.clientX - sx) / flowView.s));
        s.h = Math.max(100, Math.round(h0 + (ev.clientY - sy) / flowView.s));
        el.style.width = s.w + "px"; if (host) host.style.minHeight = s.h + "px"; // min, not fixed → still hugs content
        scheduleEdgeRender();
      };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); saveFlow(); renderMinimap(); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
    // FigJam-style floating toolbar: hover any region/block → bar above it
    const lh = el.querySelector(".fs-layout-host");
    if (lh) {
      lh.addEventListener("mouseover", (e) => {
        // Blocks and sections float a bar (sections: reorder + add); regions keep their inline "+ Section".
        const tgt = e.target.closest(".fs-block, .fl-cont.lvl-section");
        if (tgt && tgt.__fnode) { if (_actHideT) { clearTimeout(_actHideT); _actHideT = null; } if (tgt !== _actEl) showActBarFor(tgt); }
        else if (!e.target.closest(".fl-actbar")) { _actHideT = _actHideT || setTimeout(hideActBar, 160); }
      });
      lh.addEventListener("mouseleave", () => { _actHideT = setTimeout(hideActBar, 160); });
    }
    // menu
    const mb = el.querySelector(".fs-menu-btn");
    mb.addEventListener("mousedown", (e) => e.stopPropagation());
    mb.addEventListener("click", (e) => { e.stopPropagation(); openFlowMenu(s, mb.getBoundingClientRect()); });
    // connect from any of the 4 side ports
    el.querySelectorAll(".fs-port").forEach((port) => {
      port.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); startFlowConnect(s, port.dataset.side, e); });
    });
    // predefined output handles (Yes/No, Success/Error labels) — carry their label + color
    const outDefs = BRANCH_OUTS[s.kind];
    if (outDefs) el.querySelectorAll(".fs-out").forEach((ob) => {
      const out = outDefs[parseInt(ob.dataset.out, 10)]; if (!out) return;
      ob.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); startFlowConnect(s, out.side, e, { label: out.label, color: out.color }); });
    });
  }

  const SCREEN_W = 320;
  // Node footprint (width/height) — decision=diamond, start/end=pill, else card.
  function nodeDim(s) {
    if (s.kind === "decision") return { w: DECISION_W, h: DECISION_H };
    if (TERMINAL_KINDS[s.kind]) return { w: 150, h: (_flowHeights[s.id] || 46) };
    if (COMPACT_KINDS[s.kind]) return { w: 190, h: (_flowHeights[s.id] || 54) };
    return { w: (s.w || SCREEN_W), h: (_flowHeights[s.id] || 140) };
  }
  // Anchor point + outward tangent for a given side of a screen.
  function anchorPoint(s, side) {
    const d = nodeDim(s), W = d.w, h = d.h, x = s.x || 0, y = s.y || 0;
    if (side === "left") return { x: x, y: y + h / 2, dx: -1, dy: 0 };
    if (side === "top") return { x: x + W / 2, y: y, dx: 0, dy: -1 };
    if (side === "bottom") return { x: x + W / 2, y: y + h, dx: 0, dy: 1 };
    return { x: x + W, y: y + h / 2, dx: 1, dy: 0 }; // right (default)
  }
  // Which side of a screen a world point is closest to (for picking the drop side).
  function sideFromPoint(t, wx, wy) {
    const d = nodeDim(t), w = d.w, h = d.h;
    const dx = wx - ((t.x || 0) + w / 2), dy = wy - ((t.y || 0) + h / 2);
    if (Math.abs(dx) / (w / 2) >= Math.abs(dy) / (h / 2)) return dx >= 0 ? "right" : "left";
    return dy >= 0 ? "bottom" : "top";
  }
  // Pick the target side that best faces the source anchor.
  function autoSide(fromS, fromSide, toS) {
    const fa = anchorPoint(fromS, fromSide || "right");
    const tIsD = toS.kind === "decision";
    const tcx = (toS.x || 0) + (tIsD ? DECISION_W : (toS.w || SCREEN_W)) / 2, tcy = (toS.y || 0) + (tIsD ? DECISION_H : (_flowHeights[toS.id] || 130)) / 2;
    const dx = tcx - fa.x, dy = tcy - fa.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "left" : "right";
    return dy >= 0 ? "top" : "bottom";
  }
  function bezierPath(a, b) {
    const curve = (flowLayoutCfg().curve != null) ? flowLayoutCfg().curve : 0.4; // 0 = casi recto, ~0.9 = muy curvo
    const k = Math.max(curve > 0.02 ? 14 : 0, Math.hypot(b.x - a.x, b.y - a.y) * curve);
    return "M" + a.x + "," + a.y + " C" + (a.x + a.dx * k) + "," + (a.y + a.dy * k) + " " + (b.x + b.dx * k) + "," + (b.y + b.dy * k) + " " + b.x + "," + b.y;
  }
  // Smooth Catmull-Rom spline through a list of points (endpoints + lane waypoints)
  // → cubic béziers. Used to route long edges along their reserved Sugiyama lanes.
  function splinePath(pts) {
    if (!pts || pts.length < 2) return "";
    if (pts.length === 2) return bezierPath(pts[0], pts[1]);
    let d = "M" + pts[0].x + "," + pts[0].y;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += " C" + c1x + "," + c1y + " " + c2x + "," + c2y + " " + p2.x + "," + p2.y;
    }
    return d;
  }
  // World-space anchor of an internal block (measured from its DOM rect).
  function blockAnchorWorld(screenId, bid, side) {
    const card = flowNodes.querySelector('.flow-screen[data-id="' + screenId + '"]');
    if (!card) return null;
    const bEl = card.querySelector('.fs-block[data-bid="' + bid + '"]');
    if (!bEl) return null;
    const r = bEl.getBoundingClientRect();
    const w = flowWorld(side === "left" ? r.left : r.right, r.top + r.height / 2);
    return { x: w.x, y: w.y, dx: side === "left" ? -1 : 1, dy: 0 };
  }
  function edgeLabelSvg(i, a, b, label) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return '<text class="flow-edge-label" data-ei="' + i + '" x="' + mx + '" y="' + (my - 4) + '" text-anchor="middle" style="paint-order:stroke;stroke:var(--lg-panel-bg);stroke-width:4px;stroke-linejoin:round;">' + escapeHtml(label) + '</text>';
  }
  function renderFlowEdges() {
    const byId = {}; flow.screens.forEach((s) => (byId[s.id] = s));
    let h = ""; _edgeGeom = {};
    (flow.edges || []).forEach((e, i) => {
      let a, b, dashed = false, eColor = e.color, onHandle = false;
      if (e.fromB) { // component → page (dotted). Source = block anchor; target = page.
        const fp = e.fromB.split("/");
        a = blockAnchorWorld(fp[0], fp[1], "right");
        if (e.to) { const t = byId[e.to]; if (!a || !t) return; b = anchorPoint(t, e.toSide || sideFromPoint(t, a.x, a.y)); }
        else if (e.toB) { const tp = e.toB.split("/"); b = blockAnchorWorld(tp[0], tp[1], "left"); } // legacy block→block
        dashed = true;
      } else {
        const f = byId[e.from], t = byId[e.to]; if (!f || !t) return;
        // If the edge leaves a branching node (decision/system/loading) and its label
        // matches a predefined output (Yes/No/Success/Error), route it from that output's
        // handle + color automatically — so the line actually exits the Yes/No pill.
        let eFromSide = e.fromSide;
        const outs = BRANCH_OUTS[f.kind];
        if (outs && !eFromSide) {
          let key = String(e.out || e.label || "").toLowerCase();
          key = LEGACY_OUT_LABELS[key] || key; // accept boards saved with Spanish labels
          const m = outs.find((o) => o.label.toLowerCase() === key);
          if (m) { eFromSide = m.side; if (!eColor) eColor = m.color; onHandle = true; }
        }
        // Sides: explicit if manual; otherwise the side that FACES the other node so
        // multiple outgoing edges fan out from different vertices instead of overlapping.
        const fd = nodeDim(f), td = nodeDim(t);
        const fcx = (f.x || 0) + fd.w / 2, fcy = (f.y || 0) + fd.h / 2, tcx = (t.x || 0) + td.w / 2, tcy = (t.y || 0) + td.h / 2;
        a = anchorPoint(f, eFromSide || sideFromPoint(f, tcx, tcy));
        b = anchorPoint(t, e.toSide || sideFromPoint(t, fcx, fcy));
      }
      if (!a || !b) return;
      const conn = (flowDoc.layout && flowDoc.layout.connector) || "smooth";
      const route = (!e.fromB && e.mid == null) ? _edgeRoutes[i] : null; // lane route from the last auto-layout (unless the user set a manual elbow)
      const isOrtho = (conn === "ortho" && !e.fromB && !route);
      const d = route ? splinePath([a].concat(route, [b])) : (isOrtho ? orthoPath(a, b, e.mid) : bezierPath(a, b));
      const me = e.dir === "back" ? "" : ' marker-end="url(#flow-arrow)"';
      const ms = (e.dir === "back" || e.dir === "both") ? ' marker-start="url(#flow-arrow)"' : "";
      const col = eColor ? ' style="stroke:' + eColor + ';color:' + eColor + '"' : ''; // color too → glow matches the stroke
      // Each connector is a group so hovering the line reveals its elbow handle.
      let g = '<path class="flow-edge-hit" data-ei="' + i + '" d="' + d + '"></path><path class="flow-edge' + (dashed || e.dash ? " dashed" : "") + '" d="' + d + '"' + col + me + ms + '></path>';
      if (e.label && !onHandle) g += edgeLabelSvg(i, a, b, e.label); // the handle already shows the Yes/No label
      if (isOrtho) { // draggable elbow handle (move the bend) — shown on hover, last so it's on top
        const el = orthoElbow(a, b, e.mid);
        if (el) {
          _edgeGeom[i] = { ax: a.x, ay: a.y, bx: b.x, by: b.y, axis: el.axis };
          g += '<circle class="flow-elbow" data-ei="' + i + '" cx="' + el.x + '" cy="' + el.y + '" r="6"></circle>';
        }
      }
      h += '<g class="flow-edge-group" data-ei="' + i + '">' + g + '</g>';
    });
    flowEdgesSvg.innerHTML =
      '<defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>' + h;
    // Grab the line and drag to re-route its nearest end; a plain click opens the editor.
    flowEdgesSvg.querySelectorAll(".flow-edge-hit").forEach((p) => {
      p.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); startEdgeGrab(parseInt(p.dataset.ei, 10), ev); });
    });
    flowEdgesSvg.querySelectorAll(".flow-edge-label").forEach((p) => {
      p.addEventListener("click", (ev) => { ev.stopPropagation(); openEdgeEditor(parseInt(p.dataset.ei, 10), ev.clientX, ev.clientY); });
    });
    flowEdgesSvg.querySelectorAll(".flow-elbow").forEach((c) => {
      c.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); startElbowDrag(parseInt(c.dataset.ei, 10), ev); });
    });
    // Hovering a connection lights up the two cards it joins (in the edge's color),
    // so it reads at a glance where the link goes from and to.
    flowEdgesSvg.querySelectorAll(".flow-edge-group").forEach((grp) => {
      const e = (flow.edges || [])[parseInt(grp.dataset.ei, 10)]; if (!e) return;
      const ends = e.fromB ? [e.fromB.split("/")[0], e.to || (e.toB || "").split("/")[0]] : [e.from, e.to];
      grp.addEventListener("mouseenter", () => ends.forEach((id) => litScreen(id, true, e.color)));
      grp.addEventListener("mouseleave", () => ends.forEach((id) => litScreen(id, false)));
    });
  }
  function litScreen(id, on, color) {
    const el = flowNodes.querySelector('.flow-screen[data-id="' + id + '"]'); if (!el) return;
    if (on) { if (color) el.style.setProperty("--lit-col", color); el.classList.add("edge-lit"); }
    else { el.classList.remove("edge-lit"); el.style.removeProperty("--lit-col"); }
  }
  // Drag the elbow of an ortho connector to move where the bend sits (stores e.mid).
  function startElbowDrag(ei, ev) {
    const e = flow.edges[ei], g = _edgeGeom[ei]; if (!e || !g) return;
    const move = (mv) => {
      const w = flowWorld(mv.clientX, mv.clientY);
      const t = g.axis === "x" ? (w.x - g.ax) / ((g.bx - g.ax) || 1) : (w.y - g.ay) / ((g.by - g.ay) || 1);
      e.mid = Math.max(0.05, Math.min(0.95, t));
      scheduleEdgeRender();
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); saveFlow(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  // Grab a connection line: drag → re-route the end nearest the grab point;
  // click (no drag) → open the edge editor. Screen edges only.
  function startEdgeGrab(ei, ev) {
    const e = flow.edges[ei]; if (!e) return;
    if (e.fromB) { // component → page: drag the target end to another page
      const fp = e.fromB.split("/");
      const aW = blockAnchorWorld(fp[0], fp[1], "right");
      const byId0 = {}; flow.screens.forEach((s) => (byId0[s.id] = s));
      const t0 = e.to ? byId0[e.to] : null;
      const bW = t0 ? anchorPoint(t0, e.toSide || "left") : (e.toB ? (function () { const tp = e.toB.split("/"); return blockAnchorWorld(tp[0], tp[1], "left"); })() : null);
      if (!aW || !bW) { openEdgeEditor(ei, ev.clientX, ev.clientY); return; }
      const sx0 = ev.clientX, sy0 = ev.clientY;
      dragConnect(aW, true, (up) => {
        if (Math.hypot(up.clientX - sx0, up.clientY - sy0) <= 6) { openEdgeEditor(ei, up.clientX, up.clientY); return; }
        const card = up.target.closest && up.target.closest(".flow-screen");
        if (card && card.dataset.id && card.dataset.id !== fp[0]) { e.to = card.dataset.id; delete e.toB; saveFlow(); renderFlow(); }
      });
      return;
    }
    const byId = {}; flow.screens.forEach((s) => (byId[s.id] = s));
    const f = byId[e.from], t = byId[e.to]; if (!f || !t) return;
    const aW = anchorPoint(f, e.fromSide || "right"), bW = anchorPoint(t, e.toSide || autoSide(f, e.fromSide, t));
    const g = flowWorld(ev.clientX, ev.clientY);
    const end = (Math.hypot(g.x - bW.x, g.y - bW.y) <= Math.hypot(g.x - aW.x, g.y - aW.y)) ? "to" : "from";
    const fixed = end === "to" ? aW : bW;
    const sx0 = ev.clientX, sy0 = ev.clientY;
    dragConnect(fixed, false, (up) => {
      const moved = Math.hypot(up.clientX - sx0, up.clientY - sy0) > 6;
      if (!moved) { openEdgeEditor(ei, up.clientX, up.clientY); return; }
      const tgtEl = up.target.closest && up.target.closest(".flow-screen");
      if (tgtEl && tgtEl.dataset.id) {
        const nid = tgtEl.dataset.id, nt = byId[nid] || flow.screens.find((x) => x.id === nid);
        const portEl = up.target.closest(".fs-port");
        const w = flowWorld(up.clientX, up.clientY);
        const dropSide = (portEl && tgtEl.contains(portEl)) ? portEl.dataset.side : (nt ? sideFromPoint(nt, w.x, w.y) : null);
        if (end === "to" && nid !== e.from) { e.to = nid; e.toSide = dropSide; }
        else if (end === "from" && nid !== e.to) { e.from = nid; e.fromSide = dropSide || e.fromSide; }
        saveFlow(); renderFlow();
      }
    });
  }
  function openEdgeEditor(ei, cx, cy) {
    const e = flow.edges[ei]; if (!e) return;
    const dir = e.dir || "fwd";
    const dirIcon = {
      fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><line x1="4" y1="12" x2="18" y2="12"/><polyline points="13 7 18 12 13 17"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><line x1="6" y1="12" x2="20" y2="12"/><polyline points="11 7 6 12 11 17"/></svg>',
      both: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="9 8 5 12 9 16"/><polyline points="15 8 19 12 15 16"/></svg>',
    };
    flowMenu.innerHTML =
      '<div class="fm-label">Direction</div>' +
      '<div class="fm-kinds">' +
        ["fwd", "back", "both"].map((dd) => '<button class="fm-kind' + (dir === dd ? " on" : "") + '" data-dir="' + dd + '">' + dirIcon[dd] + '</button>').join("") +
      '</div>' +
      '<div class="fm-label">Color</div>' +
      '<div class="fm-colors">' +
        EDGE_COLORS.map((c) => '<button class="fm-color' + ((e.color || EDGE_COLORS[0]) === c ? " on" : "") + '" data-color="' + c + '" style="background:' + c + '"></button>').join("") +
      '</div>' +
      '<div class="fm-label">Line</div>' +
      '<div class="fm-kinds fm-kinds-icons">' +
        '<button class="fm-kind fm-kind-ic' + (!e.dash ? " on" : "") + '" data-dash="0" title="Solid"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"/></svg></button>' +
        '<button class="fm-kind fm-kind-ic' + (e.dash ? " on" : "") + '" data-dash="1" title="Dashed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="3.5 4"><line x1="3" y1="12" x2="21" y2="12"/></svg></button>' +
      '</div>' +
      '<div class="fm-label">Interaction / validation</div>' +
      '<input class="fm-edge-input" value="' + escapeHtml(e.label || "") + '" placeholder="e.g. on pressing Save · if role = operator" />' +
      '<div class="fm-sep"></div><div class="fm-item danger" data-act="del">' + FI.trash + ' Delete connection</div>';
    flowMenu.style.left = Math.min(cx, window.innerWidth - 240) + "px";
    flowMenu.style.top = Math.min(cy, window.innerHeight - 220) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-dir]").forEach((b) => b.onclick = () => { e.dir = b.dataset.dir; saveFlow(); renderFlowEdges(); openEdgeEditor(ei, cx, cy); });
    flowMenu.querySelectorAll("[data-color]").forEach((b) => b.onclick = () => { e.color = b.dataset.color; saveFlow(); renderFlowEdges(); openEdgeEditor(ei, cx, cy); });
    flowMenu.querySelectorAll("[data-dash]").forEach((b) => b.onclick = () => { e.dash = b.dataset.dash === "1"; saveFlow(); renderFlowEdges(); openEdgeEditor(ei, cx, cy); });
    const inp = flowMenu.querySelector(".fm-edge-input");
    setTimeout(() => { inp.focus(); }, 0);
    inp.oninput = () => { e.label = inp.value; saveFlow(); renderFlowEdges(); };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") closeFlowMenu(); };
    flowMenu.querySelector('[data-act="del"]').onclick = () => { flow.edges.splice(ei, 1); saveFlow(); renderFlow(); closeFlowMenu(); };
  }
  // APIs editor — same multi-row pattern as links: several endpoints, each with
  // its own context. Endpoint chips render on the card with the db icon.
  function openApiEditor(s, rect) {
    s.apis = s.apis || [];
    // Live card refresh while typing — the popover lives OUTSIDE the card, so
    // re-rendering the card never steals focus. Without this the chips kept
    // showing stale values until something else re-rendered the flow.
    let _refT = null;
    const refreshCard = () => { if (_refT) clearTimeout(_refT); _refT = setTimeout(renderFlow, 250); };
    const draw = () => {
      const rows = s.apis.map((a, i) =>
        '<div class="fm-link-row" data-i="' + i + '">' +
          '<span class="fm-api-ico">' + FI.db + '</span>' +
          '<div class="fm-link-fields">' +
            '<input class="fm-link-url" value="' + escapeHtml(a.endpoint || "") + '" placeholder="e.g. GET /api/v1/dashboards" />' +
            '<input class="fm-link-ctx" value="' + escapeHtml(a.ctx || "") + '" placeholder="Context for this endpoint…" />' +
          '</div>' +
          '<button class="fm-link-del" title="Remove API">' + FI.x + '</button>' +
        '</div>').join("");
      flowMenu.innerHTML =
        '<div class="fm-label">Endpoints / APIs for this screen</div>' +
        (rows || '<div class="fm-empty-hint">No endpoints yet.</div>') +
        '<div class="fm-sep"></div>' +
        '<div class="fm-item" data-act="add">' + FI.plus + ' Add endpoint…</div>';
      flowMenu.querySelectorAll(".fm-link-row").forEach((row) => {
        const i = parseInt(row.dataset.i, 10); const a = s.apis[i];
        const u = row.querySelector(".fm-link-url"), c = row.querySelector(".fm-link-ctx");
        [u, c].forEach((n) => n.addEventListener("mousedown", (e) => e.stopPropagation()));
        u.oninput = () => { a.endpoint = u.value.trim(); saveFlow(); refreshCard(); };
        c.oninput = () => { a.ctx = c.value.trim(); saveFlow(); refreshCard(); };
        row.querySelector(".fm-link-del").onclick = (e) => { e.stopPropagation(); s.apis.splice(i, 1); saveFlow(); renderFlow(); draw(); };
      });
      const add = flowMenu.querySelector('[data-act="add"]');
      add.onclick = (e) => {
        e.stopPropagation(); s.apis.push({ endpoint: "", ctx: "" }); saveFlow(); renderFlow(); draw();
        // (:last-of-type never matched — the Add item is the last div — so the
        // fresh row's input was never focused; grab the real last row instead.)
        const rows2 = flowMenu.querySelectorAll(".fm-link-row");
        const last = rows2.length ? rows2[rows2.length - 1].querySelector(".fm-link-url") : null;
        if (last) { last.focus(); }
      };
    };
    draw();
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 320) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible", "wide");
  }
  // Links editor — same pattern as the API/db button, but supports several links,
  // each with its own context. Each link shows a blue "connected" dot on the card.
  function openLinksEditor(s, rect) {
    s.links = s.links || [];
    // Same live card refresh as the API editor (chips went stale while typing).
    let _refT = null;
    const refreshCard = () => { if (_refT) clearTimeout(_refT); _refT = setTimeout(renderFlow, 250); };
    const draw = () => {
      const rows = s.links.map((l, i) =>
        '<div class="fm-link-row" data-i="' + i + '">' +
          '<span class="fs-link-dot"></span>' +
          '<div class="fm-link-fields">' +
            '<input class="fm-link-url" value="' + escapeHtml(l.url || "") + '" placeholder="URL or view (e.g. /dashboards)" />' +
            '<input class="fm-link-ctx" value="' + escapeHtml(l.ctx || "") + '" placeholder="Context for this link…" />' +
          '</div>' +
          (l.url ? '<button class="fm-link-open" title="Open in Preview">' + FI.open + '</button>' : '') +
          '<button class="fm-link-del" title="Remove link">' + FI.x + '</button>' +
        '</div>').join("");
      flowMenu.innerHTML =
        '<div class="fm-label">Links / connected views</div>' +
        (rows || '<div class="fm-empty-hint">No links yet.</div>') +
        '<div class="fm-sep"></div>' +
        '<div class="fm-item" data-act="addcur">' + FI.link + ' Link current view</div>' +
        '<div class="fm-item" data-act="addnew">' + FI.plus + ' Add link…</div>';
      flowMenu.querySelectorAll(".fm-link-row").forEach((row) => {
        const i = parseInt(row.dataset.i, 10); const l = s.links[i];
        const u = row.querySelector(".fm-link-url"), c = row.querySelector(".fm-link-ctx");
        [u, c].forEach((n) => n.addEventListener("mousedown", (e) => e.stopPropagation()));
        u.oninput = () => { l.url = u.value.trim(); saveFlow(); refreshCard(); };
        c.oninput = () => { l.ctx = c.value.trim(); saveFlow(); refreshCard(); };
        const op = row.querySelector(".fm-link-open");
        if (op) op.onclick = (e) => { e.stopPropagation(); if (l.url) { openLinkedView(l.url); closeFlowMenu(); } };
        row.querySelector(".fm-link-del").onclick = (e) => { e.stopPropagation(); s.links.splice(i, 1); saveFlow(); renderFlow(); draw(); };
      });
      flowMenu.querySelectorAll(".fm-item").forEach((it) => it.onclick = (e) => {
        e.stopPropagation(); const act = it.dataset.act;
        if (act === "addcur") { const at = activeTab(); s.links.push({ url: at ? at.src : "", ctx: "" }); }
        else if (act === "addnew") { s.links.push({ url: "", ctx: "" }); }
        saveFlow(); renderFlow(); draw();
        const rows2 = flowMenu.querySelectorAll(".fm-link-row");
        const last = rows2.length ? rows2[rows2.length - 1].querySelector(".fm-link-url") : null;
        if (last) { last.focus(); last.select(); }
      });
    };
    draw();
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 320) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible", "wide");
  }

  // Drag-to-connect — generic temp path that follows the cursor, then resolves
  // the drop target. Works for screen↔screen (any side) and block↔block (dotted).
  let _flowTempPath = null;
  function dragConnect(startAnchor, dashed, onDrop) {
    const move = (ev) => {
      const w = flowWorld(ev.clientX, ev.clientY);
      const b = { x: w.x, y: w.y, dx: -startAnchor.dx, dy: -startAnchor.dy };
      const d = bezierPath(startAnchor, b);
      if (!_flowTempPath) { _flowTempPath = document.createElementNS("http://www.w3.org/2000/svg", "path"); _flowTempPath.setAttribute("class", "flow-edge" + (dashed ? " dashed" : "")); _flowTempPath.style.strokeDasharray = "5 4"; flowEdgesSvg.appendChild(_flowTempPath); }
      _flowTempPath.setAttribute("d", d);
    };
    const up = (ev) => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      if (_flowTempPath) { _flowTempPath.remove(); _flowTempPath = null; }
      onDrop(ev);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  function startFlowConnect(s, side, startEv, opts) {
    opts = opts || {};
    const sx0 = startEv ? startEv.clientX : 0, sy0 = startEv ? startEv.clientY : 0;
    dragConnect(anchorPoint(s, side), false, (ev) => {
      const moved = Math.hypot(ev.clientX - sx0, ev.clientY - sy0) > 6;
      if (!moved) { createConnectedScreen(s, side, null, opts); return; } // click → new connected screen
      // drag → connect only to another existing card
      const tgt = ev.target.closest && ev.target.closest(".flow-screen");
      if (tgt && tgt.dataset.id && tgt.dataset.id !== s.id) {
        const t = flow.screens.find((x) => x.id === tgt.dataset.id);
        const portEl = ev.target.closest(".fs-port");
        const toSide = (portEl && tgt.contains(portEl)) ? portEl.dataset.side : (t ? sideFromPoint(t, flowWorld(ev.clientX, ev.clientY).x, flowWorld(ev.clientX, ev.clientY).y) : null);
        if (!flow.edges.some((x) => x.from === s.id && x.to === tgt.dataset.id && x.fromSide === side)) {
          const e = { from: s.id, to: tgt.dataset.id, fromSide: side, toSide: toSide, label: "" };
          if (opts.color) e.color = opts.color;
          if (opts.label) e.out = opts.label; // semantic tag for agents; the line stays empty
          flow.edges.push(e);
          saveFlow(); renderFlow();
        }
      }
    });
  }
  function screenRect(o) {
    const w = o.kind === "decision" ? DECISION_W : (o.w || SCREEN_W);
    const h = o.kind === "decision" ? DECISION_H : (_flowHeights[o.id] || 140);
    return { x: o.x || 0, y: o.y || 0, w: w, h: h };
  }
  function overlapsAny(x, y, w, h, M) {
    return flow.screens.some((o) => { const r = screenRect(o); return x < r.x + r.w + M && x + w > r.x - M && y < r.y + r.h + M && y + h > r.y - M; });
  }
  function createConnectedScreen(s, side, dropWorld, opts) {
    opts = opts || {};
    const w = s.kind === "decision" ? DECISION_W : (s.w || SCREEN_W);
    const h = s.kind === "decision" ? DECISION_H : (_flowHeights[s.id] || 140);
    const NW = SCREEN_W, NH = 140, GAP = 90, M = 24;
    let nx, ny;
    if (dropWorld) { nx = Math.round(dropWorld.x - NW / 2); ny = Math.round(dropWorld.y - 30); }
    else if (side === "left") { nx = (s.x || 0) - NW - GAP; ny = (s.y || 0); }
    else if (side === "bottom") { nx = (s.x || 0); ny = (s.y || 0) + h + GAP; }
    else if (side === "top") { nx = (s.x || 0); ny = (s.y || 0) - NH - GAP; }
    else { nx = (s.x || 0) + w + GAP; ny = (s.y || 0); } // right (default)
    // If the ideal slot is taken, stack along the perpendicular axis until it's free.
    const vertical = (side === "left" || side === "right");
    const stepX = vertical ? 0 : (NW + 40), stepY = vertical ? (NH + 40) : 0;
    let guard = 0;
    while (overlapsAny(nx, ny, NW, NH, M) && guard++ < 300) { nx += stepX; ny += stepY; }
    const ns = { id: flowGenId(), name: "New screen", kind: "page", status: "todo", x: nx, y: ny, apis: [], links: [], blocks: [] };
    const OPP = { top: "bottom", bottom: "top", left: "right", right: "left" };
    flow.screens.push(ns);
    const e = { from: s.id, to: ns.id, fromSide: side, toSide: OPP[side] || "left", label: "" };
    if (opts.color) e.color = opts.color;
    if (opts.label) e.out = opts.label; // semantic tag for agents; the line stays empty
    flow.edges.push(e);
    flowSel = new Set([ns.id]);
    saveFlow(); renderFlow();
  }
  // A connection from a COMPONENT can only land on a PAGE (never another component).
  function startBlockConnect(sid, bid) {
    const a = blockAnchorWorld(sid, bid, "right"); if (!a) return;
    dragConnect(a, true, (ev) => {
      const card = ev.target.closest && ev.target.closest(".flow-screen");
      if (card && card.dataset.id && card.dataset.id !== sid) { // target must be a different page
        const fromB = sid + "/" + bid, to = card.dataset.id;
        if (!(flow.edges || []).some((x) => x.fromB === fromB && x.to === to)) {
          flow.edges.push({ fromB: fromB, to: to, label: "" });
          saveFlow(); renderFlow();
        }
      }
    });
  }

  // Subflow node: pick which project flow it links to (click the node later → opens it).
  function openSubflowPicker(s, rect) {
    flowMenu.classList.remove("palette");
    const list = flowsForActive().filter((f) => f.id !== (flow && flow.id));
    let h = '<div class="fm-label">Link to a project flow</div>';
    if (!list.length) h += '<div class="fm-item" style="opacity:.55;pointer-events:none">No other flows in the project</div>';
    else h += list.map((f) => '<div class="fm-item" data-fid="' + f.id + '">' + FI.workflow + '<span>' + escapeHtml(f.name || "Flow") + '</span></div>').join("");
    if (s.flowRef) h += '<div class="fm-sep"></div><div class="fm-item danger" data-unlink="1">' + FI.x + '<span>Remove link</span></div>';
    flowMenu.innerHTML = h;
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 240) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-fid]").forEach((it) => it.onclick = () => { const f = flowsForActive().find((x) => x.id === it.dataset.fid); if (f) { s.flowRef = f.id; s.name = f.name; saveFlow(); renderFlow(); } closeFlowMenu(); });
    const un = flowMenu.querySelector("[data-unlink]"); if (un) un.onclick = () => { delete s.flowRef; saveFlow(); renderFlow(); closeFlowMenu(); };
  }
  // Screen context menu
  function openFlowMenu(s, rect) {
    const k = s.kind || "page";
    flowMenu.innerHTML =
      '<div class="fm-label">Type</div><div class="fm-kinds fm-kinds-icons fm-grid4">' +
        Object.keys(FLOW_KINDS).map((key) => '<button class="fm-kind fm-kind-ic' + (key === k ? " on" : "") + '" data-kind="' + key + '" title="' + escapeHtml(FLOW_KINDS[key].label) + '" style="--fs-accent:' + FLOW_KINDS[key].color + '">' + FLOW_KINDS[key].icon + '</button>').join("") +
      '</div><div class="fm-sep"></div>' +
      (k === "subflow" ? '<div class="fm-item" data-act="link">' + FI.workflow + ' Link flow…</div>' : '<div class="fm-item" data-act="gen">' + FI.sparkle + ' Generate content with AI</div>') +
      '<div class="fm-item" data-act="variant">' + FI.secEmpty + ' <span>' + (s.variant === "empty" ? "Mark as content" : "Mark as empty state") + '</span>' + (s.variant === "empty" ? '<span class="fm-check">✓</span>' : '') + '</div>' +
      '<div class="fm-item" data-act="dup">' + FI.dup + ' Duplicate</div>' +
      '<div class="fm-sep"></div>' +
      '<div class="fm-item" data-act="docs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> How Moka works</div>' +
      '<div class="fm-sep"></div><div class="fm-item danger" data-act="del">' + FI.trash + ' Delete screen</div>';
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 190) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll(".fm-kind[data-kind]").forEach((b) => b.onclick = () => { s.kind = b.dataset.kind; saveFlow(); renderFlow(); closeFlowMenu(); });
    flowMenu.querySelectorAll(".fm-status[data-status]").forEach((b) => b.onclick = () => { s.status = b.dataset.status; saveFlow(); renderFlow(); closeFlowMenu(); });
    flowMenu.querySelectorAll(".fm-item").forEach((it) => it.onclick = () => {
      const act = it.dataset.act;
      if (act === "gen") { openScreenGen(s); return; }
      if (act === "link") { closeFlowMenu(); openSubflowPicker(s, rect); return; }
      if (act === "docs") { closeFlowMenu(); openDocs("moka"); return; }
      if (act === "variant") { s.variant = s.variant === "empty" ? "content" : "empty"; }
      else if (act === "del") { flow.screens = flow.screens.filter((x) => x.id !== s.id); flow.edges = flow.edges.filter((e) => e.from !== s.id && e.to !== s.id); }
      else if (act === "dup") { const c = JSON.parse(JSON.stringify(s)); c.id = flowGenId(); c.x = (s.x || 0) + 40; c.y = (s.y || 0) + 40; c.name = (s.name || "") + " copy"; flow.screens.push(c); }
      saveFlow(); renderFlow(); closeFlowMenu();
    });
  }
  // Per-screen AI: Claude fills/regenerates this screen's blocks in flow.json.
  function openScreenGen(s) {
    flowMenu.innerHTML =
      '<div class="fm-label">Generate content — ' + escapeHtml(s.name || "Screen") + '</div>' +
      '<input class="fm-edge-input" id="fm-gen-input" placeholder="Goal / what this screen should contain…" />' +
      '<div class="fm-sep"></div><div class="fm-item" data-act="run">' + FI.sparkle + ' Generate content with AI</div>';
    const inp = flowMenu.querySelector("#fm-gen-input");
    setTimeout(() => inp.focus(), 0);
    const run = () => {
      const at = activeTab(); if (!at) { showToast("Open a project", "warn"); return; }
      const goal = inp.value.trim();
      const k = FLOW_KINDS[s.kind] || FLOW_KINDS.page;
      const instr =
        "Use Moka's MCP tools (the `ohana-comments` server) to define the content of the screen with id \"" + s.id + "\" (\"" + (s.name || "") + "\", type " + k.label + ") in the active flow \"" + flowDoc.active + "\". " +
        "Optional: apply a layout with `ohana_flow_set_layout` and add blocks with `ohana_flow_add_block(screenId, containerId, type, title, items)` (use `ohana_flow_read` for the regions' `cid`s). Each block anchored by its `type`. " +
        "Don't touch other screens." +
        (goal ? " Goal: " + goal + "." : "") +
        " If the project uses a design system, reference real components. If you don't have the MCP tools, edit `.ohana/flow.json` only for that screen. It appears live.";
      if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
      setTimeout(() => window.api.termInput({ tabKey: at.key, data: instr }), 280);
      closeFlowMenu();
      showToast("Generating “" + (s.name || "screen") + "” — it will reload on its own when done", "check");
    };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") run(); };
    flowMenu.querySelector('[data-act="run"]').onclick = run;
  }
  function closeFlowMenu() { flowMenu.classList.remove("visible"); flowMenu.classList.remove("palette"); flowMenu.classList.remove("wide"); }
  document.addEventListener("mousedown", (e) => { if (!flowMenu.contains(e.target)) closeFlowMenu(); });

  // Base component catalog — the common UI pieces a section can hold (name + Lucide icon).
  const BASE_COMPONENTS = [
    { name: "Accordion", icon: "accordion" }, { name: "Alert", icon: "alert" },
    { name: "Avatar", icon: "avatar" }, { name: "Badge", icon: "badge" },
    { name: "Breadcrumbs", icon: "breadcrumb" }, { name: "Button", icon: "button" },
    { name: "Button group", icon: "buttonGroup" }, { name: "Calendar", icon: "calendar" },
    { name: "Carousel", icon: "carousel" }, { name: "Chart", icon: "chart" },
    { name: "Checkbox", icon: "checkbox" }, { name: "Collapsible", icon: "collapsible" },
    { name: "Search", icon: "search" }, { name: "Menu", icon: "menu" },
    { name: "Data table", icon: "table" }, { name: "Date picker", icon: "datePicker" },
  ];
  // Legacy Spanish catalog names (blocks saved before the English migration) → catalog icon.
  const LEGACY_COMPONENT_ICONS = { "acordeón": "accordion", "acordeon": "accordion", "alerta": "alert", "carrusel": "carousel", "colapsable": "collapsible", "buscador": "search", "menú": "menu", "menu": "menu" };
  // Map a block's free-text `type` (e.g. "Button", written by an agent) to a catalog icon.
  function iconForType(type) {
    if (!type) return null;
    const lo = String(type).toLowerCase();
    const c = BASE_COMPONENTS.find((x) => x.name.toLowerCase() === lo);
    return c ? c.icon : (LEGACY_COMPONENT_ICONS[lo] || null);
  }
  // Section variants live on the section itself (variant: "content" | "empty"),
  // toggled from its ⋯ menu — there's no upfront type picker anymore.
  // Icon choices offered when creating your own component.
  const ICON_CHOICES = ["cube", "accordion", "alert", "avatar", "badge", "breadcrumb", "button", "buttonGroup", "calendar", "carousel", "chart", "checkbox", "collapsible", "search", "menu", "table", "datePicker", "box", "fileText", "comment", "eye", "link", "db", "sparkle", "note", "heading"];
  // Create a personal (global) component: name + icon. Calls onCreate(comp) when done.
  // Create OR edit a personal (library) component. Pass `existing` to edit:
  // prefilled name/icon, Save updates the library entry, and Delete removes it.
  // Placed blocks are copies — editing the library never rewrites your boards.
  function openComponentCreator(rect, onCreate, existing) {
    let chosen = (existing && existing.icon) || "cube";
    flowMenu.classList.remove("palette");
    flowMenu.innerHTML =
      '<div class="fm-label">' + (existing ? "Edit component" : "New component (saved to your library)") + '</div>' +
      '<input class="fm-search cc-name" placeholder="Name — e.g. Accordion" spellcheck="false" value="' + escapeHtml(existing ? existing.name || "" : "") + '" />' +
      '<div class="fm-label">Icon</div>' +
      '<div class="cc-icons">' + ICON_CHOICES.map((k) => '<button class="cc-icon' + (k === chosen ? " on" : "") + '" data-k="' + k + '" title="' + k + '">' + FI[k] + '</button>').join("") + '</div>' +
      '<button class="cc-create">' + (existing ? "Save changes" : "Create component") + '</button>' +
      (existing ? '<button class="cc-delete">' + FI.trash + ' Delete from library</button>' : '');
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 260) + "px";
    flowMenu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 300) + "px";
    flowMenu.classList.add("visible");
    const nameInp = flowMenu.querySelector(".cc-name");
    setTimeout(() => nameInp.focus(), 0);
    flowMenu.querySelectorAll(".cc-icon").forEach((b) => b.onclick = () => { chosen = b.dataset.k; flowMenu.querySelectorAll(".cc-icon").forEach((x) => x.classList.toggle("on", x === b)); });
    const create = () => {
      const name = nameInp.value.trim(); if (!name) { nameInp.focus(); return; }
      if (existing) {
        existing.name = name; existing.icon = chosen;
        saveUserComponents(); closeFlowMenu(); if (onCreate) onCreate(existing);
        return;
      }
      const comp = { id: "uc" + Date.now().toString(36), name: name, icon: chosen };
      userComponents.push(comp); saveUserComponents(); closeFlowMenu(); onCreate(comp);
    };
    flowMenu.querySelector(".cc-create").onclick = create;
    const del = flowMenu.querySelector(".cc-delete");
    if (del) del.onclick = () => {
      userComponents = userComponents.filter((c) => c !== existing);
      saveUserComponents(); closeFlowMenu(); showToast("Component removed from your library", "refresh-cw");
      if (onCreate) onCreate(null);
    };
    nameInp.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  }
  // Generic ⋯ menu for a canvas object — actions: [{ label, icon, danger, fn }].
  function openObjMenu(rect, actions) {
    flowMenu.classList.remove("palette");
    flowMenu.innerHTML = actions.map((a, i) => '<div class="fm-item' + (a.danger ? " danger" : "") + '" data-i="' + i + '">' + (a.icon || "") + '<span>' + escapeHtml(a.label) + '</span></div>').join("");
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-i]").forEach((it) => it.onclick = () => { const a = actions[+it.dataset.i]; closeFlowMenu(); if (a && a.fn) a.fn(); });
  }
  // Section ⋯ menu — turn the section into a component, or delete it.
  // One click = one section, ready to name. No type picker: the common case is
  // a content section, and "empty state" is a PROPERTY you flip from the
  // section's ⋯ menu (the old picker forced an upfront choice and left the
  // section named after the menu item).
  function quickAddSection(s, region) {
    ensureLayout(s);
    const target = (region && isCont(region)) ? region : s.layout;
    const sec = { cid: genCid(), dir: "col", name: "", variant: "content", children: [] };
    target.children.push(sec);
    saveFlow(); renderFlow();
    setTimeout(() => { // type the name right away — the input is focused for you
      const nm = flowNodes.querySelector('.fl-cont[data-cid="' + sec.cid + '"] .fl-name');
      if (nm) nm.focus();
    }, 0);
  }
  function openSectionMenu(s, cont, parent, rect) {
    flowMenu.classList.remove("palette");
    const isEmptyVar = cont.variant === "empty";
    const descVis = cont.showDesc !== undefined ? !!cont.showDesc : !!cont.desc;
    flowMenu.innerHTML =
      '<div class="fm-item" data-a="desc">' + FI.fileText + '<span>Description</span>' + (descVis ? '<span class="fm-check">✓</span>' : '') + '</div>' +
      '<div class="fm-item" data-a="variant">' + FI.secEmpty + '<span>' + (isEmptyVar ? "Mark as content" : "Mark as empty state") + '</span>' + (isEmptyVar ? '<span class="fm-check">✓</span>' : '') + '</div>' +
      '<div class="fm-item" data-a="tocomp">' + FI.cube + '<span>Turn into component</span></div>' +
      '<div class="fm-sep"></div>' +
      '<div class="fm-item danger" data-a="del">' + FI.trash + '<span>Delete section</span></div>';
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-a]").forEach((it) => it.onclick = () => {
      const a = it.dataset.a;
      if (a === "variant") { cont.variant = isEmptyVar ? "content" : "empty"; saveFlow(); renderFlow(); closeFlowMenu(); return; }
      if (a === "desc") {
        cont.showDesc = !descVis;
        saveFlow(); renderFlow(); closeFlowMenu();
        if (cont.showDesc) setTimeout(() => { const d = flowNodes.querySelector('.fl-cont[data-cid="' + cont.cid + '"] .fl-sec-desc'); if (d) d.focus(); }, 0);
        return;
      }
      if (parent && isCont(parent)) {
        const idx = parent.children.indexOf(cont);
        if (idx !== -1) {
          if (a === "del") parent.children.splice(idx, 1);
          else if (a === "tocomp") {
            const items = [];
            (function collect(n) { if (isCont(n)) (n.children || []).forEach(collect); else { const bc = blockContent(n); if (bc && (bc.title || bc.type)) items.push(bc.title || bc.type); } })(cont);
            parent.children.splice(idx, 1, { type: cont.name || "Component", icon: "cube", title: cont.name || "Component", desc: "", items: items });
          }
          saveFlow(); renderFlow();
        }
      }
      closeFlowMenu();
    });
  }
  // Region ⋯ menu — insert a reusable global section, turn the region into a
  // single component, or delete it.
  function openRegionMenu(s, cont, parent, rect) {
    flowMenu.classList.remove("palette");
    const hasGlobals = Object.keys(flowGlobals()).length > 0;
    const isEmptyVar = cont.variant === "empty";
    flowMenu.innerHTML =
      '<div class="fm-item" data-a="variant">' + FI.secEmpty + '<span>' + (isEmptyVar ? "Mark as content" : "Mark as empty state") + '</span>' + (isEmptyVar ? '<span class="fm-check">✓</span>' : '') + '</div>' +
      (hasGlobals ? '<div class="fm-item" data-a="global">' + FI.diamond + '<span>Insert global section…</span></div>' : '') +
      '<div class="fm-item" data-a="tocomp">' + FI.cube + '<span>Turn into component</span></div>' +
      '<div class="fm-sep"></div>' +
      '<div class="fm-item danger" data-a="del">' + FI.trash + '<span>Delete region</span></div>';
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-a]").forEach((it) => it.onclick = () => {
      const a = it.dataset.a;
      if (a === "variant") { cont.variant = isEmptyVar ? "content" : "empty"; saveFlow(); renderFlow(); closeFlowMenu(); return; }
      if (a === "global") { openBlockPalette(s, rect, cont, "section"); return; } // palette now lists globals only
      if (parent && isCont(parent)) {
        const idx = parent.children.indexOf(cont);
        if (idx !== -1) {
          if (a === "del") parent.children.splice(idx, 1);
          else if (a === "tocomp") {
            const items = [];
            (function collect(n) { if (isCont(n)) (n.children || []).forEach(collect); else { const bc = blockContent(n); if (bc && (bc.title || bc.type)) items.push(bc.title || bc.type); } })(cont);
            parent.children.splice(idx, 1, { type: cont.name || "Component", icon: "cube", title: cont.name || "Component", desc: "", items: items });
          }
          saveFlow(); renderFlow();
        }
      }
      closeFlowMenu();
    });
  }
  function openBlockPalette(s, rect, targetCont, mode) {
    mode = mode || ((targetCont === s.layout) ? "section" : "component");
    const comps = (typeof componentMeta !== "undefined" && Array.isArray(componentMeta)) ? componentMeta : [];
    flowMenu.classList.add("palette");
    // Sections are just 2 types → no search. Components are many → keep the search.
    const withSearch = mode !== "section";
    flowMenu.innerHTML = (withSearch ? '<input class="fm-search" placeholder="Search component…" spellcheck="false" />' : '') + '<div class="fm-list" id="fm-list"></div>';
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 240) + "px";
    flowMenu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 440) + "px";
    flowMenu.classList.add("visible");
    const list = flowMenu.querySelector("#fm-list");
    const cont = () => { ensureLayout(s); return (targetCont && isCont(targetCont)) ? targetCont : s.layout; };
    const addBlock = (b) => { cont().children.push(b); saveFlow(); renderFlow(); closeFlowMenu(); };
    const compToBlock = (c) => ({
      type: c.name || "Component", title: c.name || "Component", icon: "cube",
      desc: c.import || c.use || "",
      items: (c.props || []).filter((p) => (p.options || []).length).map((p) => (p.label || p.name) + ": " + p.options.join(" / ")),
    });
    const item = (attr, iconKey, label) => '<div class="fm-item" ' + attr + '>' + (FI[iconKey] || FI.cube) + '<span>' + escapeHtml(label) + '</span></div>';
    function paint(q) {
      q = (q || "").toLowerCase().trim();
      const match = (n) => !q || (n || "").toLowerCase().includes(q);
      let h = "";
      if (mode === "component") {
        // Inside a section → components: base + your global library + the repo's design system
        const base = BASE_COMPONENTS.filter((c) => match(c.name));
        if (base.length) h += '<div class="fm-label">Components</div>' + base.map((c) => item('data-comp="' + BASE_COMPONENTS.indexOf(c) + '"', c.icon, c.name)).join("");
        const uc = userComponents.filter((c) => match(c.name));
        // Your library rows carry a hover pencil → edit/delete the component.
        if (uc.length) h += '<div class="fm-label">My components</div>' + uc.map((c) => '<div class="fm-item" data-uc="' + userComponents.indexOf(c) + '">' + (FI[c.icon] || FI.cube) + '<span>' + escapeHtml(c.name) + '</span><button class="fm-edit" title="Edit component">' + FI.edit + '</button></div>').join("");
        const fc = comps.filter((c) => match(c.name));
        if (fc.length) h += '<div class="fm-label">Project components</div>' + fc.map((c) => item('data-ci="' + comps.indexOf(c) + '"', "cube", c.name || "")).join("");
        h += '<div class="fm-sep"></div>' + item('data-new="1"', "plus", "Create component…");
      } else {
        // Region level → reusable global sections ("+ Section" creates directly;
        // this palette only opens from the region ⋯ menu to insert a global).
        const globals = flowGlobals();
        const gids = Object.keys(globals).filter((id) => match(globals[id].title));
        if (gids.length) h += '<div class="fm-label">Global sections</div>' + gids.map((id) => item('data-gid="' + id + '"', "diamond", globals[id].title || "Global")).join("");
      }
      list.innerHTML = h || '<div class="fm-label">No results</div>';
      list.querySelectorAll(".fm-item").forEach((it) => it.onclick = (ev) => {
        const d = it.dataset;
        if (d.uc !== undefined && ev.target.closest(".fm-edit")) { // pencil → edit the library entry, then come back to the palette
          ev.stopPropagation();
          openComponentCreator(rect, () => openBlockPalette(s, rect, targetCont, mode), userComponents[+d.uc]);
          return;
        }
        if (d.comp !== undefined) { const c = BASE_COMPONENTS[+d.comp]; addBlock({ type: c.name, icon: c.icon, title: c.name, desc: "", items: [] }); }
        else if (d.uc !== undefined) { const c = userComponents[+d.uc]; addBlock({ type: c.name, icon: c.icon, title: c.name, desc: "", items: [] }); }
        else if (d.ci !== undefined) { const c = comps[+d.ci]; if (c) addBlock(compToBlock(c)); }
        else if (d.gid !== undefined) { addBlock({ globalId: d.gid }); }
        else if (d.new !== undefined) { openComponentCreator(rect, (comp) => addBlock({ type: comp.name, icon: comp.icon, title: comp.name, desc: "", items: [] })); }
      });
    }
    const search = flowMenu.querySelector(".fm-search");
    if (search) { search.addEventListener("input", () => paint(search.value)); setTimeout(() => search.focus(), 0); }
    paint("");
  }

  // Auto-layout: arrange screens in a left→right tree by their connections
  // (handy after AI generation, which can place cards on top of each other).
  // Layered (Sugiyama-style) layout: rank by longest path, reduce crossings by
  // the median heuristic, place in even columns/rows. Shared by the "Ordenar"
  // button, the layout options, and post-generation. dir: "LR" | "TB".
  function layeredLayout(screens, edges, dir) {
    if (!screens.length) return;
    const ids = screens.map((s) => s.id), idset = new Set(ids), byId = {}; screens.forEach((s) => (byId[s.id] = s));
    const E = (edges || []).filter((e) => e.from && e.to && idset.has(e.from) && idset.has(e.to) && e.from !== e.to);
    // back-edge detection (iterative DFS) → rank on the resulting DAG
    const adj = {}; ids.forEach((id) => (adj[id] = [])); E.forEach((e) => adj[e.from].push(e.to));
    const stt = {}, back = new Set();
    ids.forEach((root) => {
      if (stt[root]) return;
      const path = [[root, 0]]; stt[root] = 1;
      while (path.length) {
        const top = path[path.length - 1], u = top[0];
        if (top[1] < adj[u].length) { const v = adj[u][top[1]++]; if (stt[v] === 1) back.add(u + ">" + v); else if (!stt[v]) { stt[v] = 1; path.push([v, 0]); } }
        else { stt[u] = 2; path.pop(); }
      }
    });
    const F = E.filter((e) => !back.has(e.from + ">" + e.to));
    // Layer assignment (longest path) over the real DAG.
    const fadjR = {}, indeg = {}; ids.forEach((id) => { fadjR[id] = []; indeg[id] = 0; });
    F.forEach((e) => { fadjR[e.from].push(e.to); indeg[e.to]++; });
    const rank = {}; ids.forEach((id) => (rank[id] = 0));
    const ind2 = Object.assign({}, indeg); let q = ids.filter((id) => ind2[id] === 0);
    while (q.length) { const u = q.shift(); fadjR[u].forEach((v) => { if (rank[v] < rank[u] + 1) rank[v] = rank[u] + 1; if (--ind2[v] === 0) q.push(v); }); }
    screens.forEach((s) => { if (typeof s.rank === "number" && s.rank >= 0) rank[s.id] = Math.floor(s.rank); });
    const maxRank = Math.max(0, ...ids.map((id) => rank[id]));
    // Sugiyama step 3: replace every edge that spans >1 layer with a chain of
    // DUMMY nodes, one per intermediate layer. Dummies join the crossing-
    // minimization + packing so long edges get their own reserved "lane" and
    // stop slashing across the cards between their endpoints.
    const isDummy = {}, LANE = 26;
    const fadj = {}, inAdj = {}; const nodes = ids.slice();
    const ensure = (n) => { if (!fadj[n]) { fadj[n] = []; inAdj[n] = []; } };
    ids.forEach(ensure);
    const eIndex = new Map(); (edges || []).forEach((e, i) => eIndex.set(e, i)); // edge → its flow.edges index
    const routeDummies = {}; // edge index → [dummy ids] (its lane chain), for edge routing
    let dcount = 0;
    F.forEach((e) => {
      const lo = rank[e.from], hi = rank[e.to];
      if (hi - lo <= 1) { fadj[e.from].push(e.to); inAdj[e.to].push(e.from); return; }
      let prev = e.from; const chain = [];
      for (let r = lo + 1; r < hi; r++) { const dn = "__d" + (dcount++); isDummy[dn] = true; rank[dn] = r; ensure(dn); nodes.push(dn); fadj[prev].push(dn); inAdj[dn].push(prev); prev = dn; chain.push(dn); }
      fadj[prev].push(e.to); inAdj[e.to].push(prev);
      const oi = eIndex.get(e); if (oi != null) routeDummies[oi] = chain;
    });
    const layers = []; for (let r = 0; r <= maxRank; r++) layers.push([]);
    nodes.forEach((id) => layers[rank[id]].push(id));
    const pos = {}; layers.forEach((L) => L.forEach((id, i) => (pos[id] = i)));
    const median = (arr) => { if (!arr.length) return -1; const a = arr.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    const sweep = (r, nb) => { const L = layers[r]; const bc = {}; L.forEach((id) => { const ps = nb[id].map((n) => pos[n]).filter((p) => p >= 0); bc[id] = ps.length ? median(ps) : pos[id]; }); L.sort((a, b) => (bc[a] - bc[b]) || (pos[a] - pos[b])); L.forEach((id, i) => (pos[id] = i)); };
    for (let pass = 0; pass < 6; pass++) {
      if (pass % 2 === 0) { for (let r = 1; r <= maxRank; r++) sweep(r, inAdj); }
      else { for (let r = maxRank - 1; r >= 0; r--) sweep(r, fadj); }
    }
    const LR = dir !== "TB", GAP_MAIN = 110, GAP_CROSS = 34;
    const ndim = (id) => isDummy[id] ? { w: LANE, h: LANE } : sdim(byId[id]);
    const rankMain = []; for (let r = 0; r <= maxRank; r++) rankMain[r] = Math.max(LR ? SCREEN_W : 140, ...layers[r].map((id) => { const d = ndim(id); return LR ? d.w : d.h; }));
    const rankPos = []; let cur = 80; for (let r = 0; r <= maxRank; r++) { rankPos[r] = cur; cur += rankMain[r] + GAP_MAIN; }
    const cross = {}; let gMin = Infinity;
    layers.forEach((L) => { let c = 0; const place = {}; L.forEach((id) => { const d = ndim(id); const sz = LR ? d.h : d.w; place[id] = c + sz / 2; c += sz + GAP_CROSS; }); const total = c - GAP_CROSS; L.forEach((id) => (cross[id] = place[id] - total / 2)); });
    layers.forEach((L) => L.forEach((id) => { const d = ndim(id); const sz = LR ? d.h : d.w; gMin = Math.min(gMin, cross[id] - sz / 2); }));
    const shift = 80 - (gMin === Infinity ? 0 : gMin);
    layers.forEach((L, r) => L.forEach((id) => { if (isDummy[id]) return; const s = byId[id], d = sdim(s); if (LR) { s.x = rankPos[r]; s.y = Math.round(cross[id] + shift - d.h / 2); } else { s.y = rankPos[r]; s.x = Math.round(cross[id] + shift - d.w / 2); } }));
    // Edge routing (Sugiyama phase 5): each split edge flows through the centers of
    // its dummy lane so it bends around the cards in between instead of crossing them.
    Object.keys(routeDummies).forEach((oi) => {
      const pts = routeDummies[oi].map((dn) => {
        const mainC = rankPos[rank[dn]] + rankMain[rank[dn]] / 2, crossC = cross[dn] + shift;
        return LR ? { x: mainC, y: crossC } : { x: crossC, y: mainC };
      });
      if (pts.length) _edgeRoutes[oi] = pts;
    });
  }
  function flowLayoutCfg() { flowDoc.layout = flowDoc.layout || { dir: "LR", connector: "smooth" }; return flowDoc.layout; }
  function boardType() { return (flow && flow.board === "sitemap") ? "sitemap" : "userflow"; }
  // Tidy tree layout for SITEMAPS: roots on top, children below, parent centered
  // over its subtree, siblings side by side. Edges = parent→child hierarchy.
  function treeLayout(screens, edges) {
    if (!screens.length) return;
    const ids = screens.map((s) => s.id), idset = new Set(ids), byId = {}; screens.forEach((s) => (byId[s.id] = s));
    const E = (edges || []).filter((e) => e.from && e.to && idset.has(e.from) && idset.has(e.to) && e.from !== e.to);
    const children = {}, indeg = {}; ids.forEach((id) => { children[id] = []; indeg[id] = 0; });
    const parentOf = {};
    E.forEach((e) => { if (parentOf[e.to] === undefined) { parentOf[e.to] = e.from; children[e.from].push(e.to); indeg[e.to]++; } });
    let roots = ids.filter((id) => parentOf[id] === undefined);
    if (!roots.length) roots = [ids[0]]; // cycle fallback
    const dim = (id) => { const s = byId[id]; return { w: s.kind === "decision" ? DECISION_W : (s.w || SCREEN_W), h: s.kind === "decision" ? DECISION_H : (_flowHeights[id] || 140) }; };
    const GAPX = 44, GAPY = 96, pos = {}, visited = new Set();
    let cursorX = 80;
    const place = (id, depth) => {
      if (visited.has(id)) { const x = cursorX; cursorX += dim(id).w + GAPX; pos[id] = { x: x, depth: depth }; return { left: x, right: x + dim(id).w }; }
      visited.add(id);
      const kids = children[id].filter((k) => !visited.has(k)), d = dim(id);
      if (!kids.length) { const x = cursorX; cursorX += d.w + GAPX; pos[id] = { x: x, depth: depth }; return { left: x, right: x + d.w }; }
      let minL = Infinity, maxR = -Infinity;
      kids.forEach((k) => { const r = place(k, depth + 1); minL = Math.min(minL, r.left); maxR = Math.max(maxR, r.right); });
      const x = Math.round(minL + (maxR - minL - d.w) / 2);
      pos[id] = { x: x, depth: depth };
      return { left: Math.min(x, minL), right: Math.max(x + d.w, maxR) };
    };
    roots.forEach((r) => { place(r, 0); cursorX += GAPX; });
    ids.forEach((id) => { if (!pos[id]) { const x = cursorX; cursorX += dim(id).w + GAPX; pos[id] = { x: x, depth: 0 }; } }); // orphans
    const levelH = {}; ids.forEach((id) => { const dp = pos[id].depth, h = dim(id).h; levelH[dp] = Math.max(levelH[dp] || 0, h); });
    const levelY = {}; let yc = 80; const maxDepth = Math.max(0, ...ids.map((id) => pos[id].depth));
    for (let dp = 0; dp <= maxDepth; dp++) { levelY[dp] = yc; yc += (levelH[dp] || 140) + GAPY; }
    ids.forEach((id) => { byId[id].x = pos[id].x; byId[id].y = levelY[pos[id].depth]; });
  }
  function autoLayoutFlow() {
    if (!flow.screens.length) { showToast("The flow is empty", "warn"); return; }
    _edgeRoutes = {}; // recomputed by the layout below (only layeredLayout fills lanes)
    if (boardType() === "sitemap") treeLayout(flow.screens, flow.edges);
    else layeredLayout(flow.screens, flow.edges, "LR");
    saveFlow(); renderFlow(); fitFlowView();
    showToast(boardType() === "sitemap" ? "Sitemap laid out" : "Flow laid out", "check");
  }
  function renderBoardSwitch() {
    const cur = boardType();
    document.querySelectorAll("#flow-board .fb-board").forEach((b) => b.classList.toggle("on", b.dataset.board === cur));
  }
  function setBoard(b) {
    if (!flow) return;
    flow.board = (b === "sitemap") ? "sitemap" : "userflow";
    flowLayoutCfg().connector = (flow.board === "sitemap") ? "ortho" : "smooth"; // tree reads better with elbows
    renderBoardSwitch();
    autoLayoutFlow(); // re-arrange in the new shape (saves + renders)
  }
  function openLayoutOpts(rect) {
    const conn = flowLayoutCfg().connector || "smooth";
    const connIcon = {
      smooth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 18C10 18 11 6 21 6"/></svg>',
      ortho: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 18H12V6H21"/></svg>',
    };
    const curveVal = (flowLayoutCfg().curve != null) ? flowLayoutCfg().curve : 0.4;
    flowMenu.innerHTML =
      '<div class="fm-note" style="max-width:240px">Direction is set by the board type (Sitemap = vertical · User flow = horizontal).</div>' +
      '<div class="fm-label">Connectors</div><div class="fm-kinds fm-kinds-icons">' +
        '<button class="fm-kind fm-kind-ic' + (conn === "smooth" ? " on" : "") + '" data-conn="smooth" title="Smooth">' + connIcon.smooth + '</button>' +
        '<button class="fm-kind fm-kind-ic' + (conn === "ortho" ? " on" : "") + '" data-conn="ortho" title="Elbow">' + connIcon.ortho + '</button>' +
      '</div>' +
      (conn === "smooth" ? '<div class="fm-label">Curvature</div><input type="range" class="fm-range" id="fm-curve" min="0" max="0.9" step="0.05" value="' + curveVal + '" />' : '') +
      '<div class="fm-sep"></div>' +
      '<div class="fm-item" data-act="run">' + FI.check + ' Lay out now</div>';
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 240) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-conn]").forEach((b) => b.onclick = () => { flowLayoutCfg().connector = b.dataset.conn; saveFlow(); renderFlowEdges(); openLayoutOpts(rect); });
    const cr = flowMenu.querySelector("#fm-curve");
    if (cr) { cr.addEventListener("mousedown", (e) => e.stopPropagation()); cr.oninput = () => { flowLayoutCfg().curve = parseFloat(cr.value); saveFlow(); renderFlowEdges(); }; }
    flowMenu.querySelector('[data-act="run"]').onclick = () => { autoLayoutFlow(); closeFlowMenu(); };
  }
  // Ortho router respects BOTH ends: it leaves `a` perpendicular to its side and
  // enters `b` perpendicular to ITS side, so the arrowhead lands square on the node.
  // Only the "same orientation" cases have a movable middle segment (draggable elbow).
  function orthoElbow(a, b, mid) {
    const aH = Math.abs(a.dx) >= Math.abs(a.dy), bH = Math.abs(b.dx) >= Math.abs(b.dy);
    const t = (mid != null) ? Math.max(0.05, Math.min(0.95, mid)) : 0.5;
    if (aH && bH) { const mx = a.x + (b.x - a.x) * t; return { axis: "x", x: mx, y: (a.y + b.y) / 2 }; }
    if (!aH && !bH) { const my = a.y + (b.y - a.y) * t; return { axis: "y", x: (a.x + b.x) / 2, y: my }; }
    return null; // single-bend (H→V or V→H): no draggable middle
  }
  function orthoPath(a, b, mid) {
    const aH = Math.abs(a.dx) >= Math.abs(a.dy), bH = Math.abs(b.dx) >= Math.abs(b.dy);
    if (aH && bH) { const e = orthoElbow(a, b, mid); return "M" + a.x + "," + a.y + " L" + e.x + "," + a.y + " L" + e.x + "," + b.y + " L" + b.x + "," + b.y; }
    if (!aH && !bH) { const e = orthoElbow(a, b, mid); return "M" + a.x + "," + a.y + " L" + a.x + "," + e.y + " L" + b.x + "," + e.y + " L" + b.x + "," + b.y; }
    if (aH && !bH) return "M" + a.x + "," + a.y + " L" + b.x + "," + a.y + " L" + b.x + "," + b.y; // out horizontal, in vertical
    return "M" + a.x + "," + a.y + " L" + a.x + "," + b.y + " L" + b.x + "," + b.y; // out vertical, in horizontal
  }

  function addScreen(kind) {
    const r = flowVp.getBoundingClientRect();
    const w = flowWorld(r.left + r.width / 2, r.top + r.height / 2);
    const s = { id: flowGenId(), name: "New screen", kind: kind || "page", status: "todo", x: Math.round(w.x - 120), y: Math.round(w.y - 40), apis: [], links: [], blocks: [] };
    flow.screens.push(s); flowSel = new Set([s.id]); saveFlow(); renderFlow();
  }

  // ── Status: filter ──
  function setFlowFilter(f) {
    flowFilter = f;
    const lbl = document.getElementById("flow-filter-label"); if (lbl) lbl.textContent = (f === "all") ? "All" : FLOW_STATUS[f].label;
    const btn = document.getElementById("flow-filter"); if (btn) btn.classList.toggle("on", f !== "all");
    renderFlow();
  }
  function openFlowFilter(rect) {
    const chk = (on) => on ? FI.check : '<span style="width:14px;display:inline-block;flex-shrink:0;"></span>';
    flowMenu.innerHTML = '<div class="fm-label">Filter by status</div>' +
      '<div class="fm-item" data-f="all">' + chk(flowFilter === "all") + ' All</div>' +
      STATUS_ORDER.map((k) => '<div class="fm-item fm-status-' + k + '" data-f="' + k + '">' + chk(flowFilter === k) + '<span class="fs-status-dot"></span> ' + FLOW_STATUS[k].label + '</div>').join("");
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 220) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible");
    flowMenu.querySelectorAll("[data-f]").forEach((it) => it.onclick = () => { setFlowFilter(it.dataset.f); closeFlowMenu(); });
  }

  // ── Navigation: see all (zoom-to-fit) + search + center ──
  function flowBBox() {
    const items = [];
    flow.screens.forEach((s) => {
      const w = s.kind === "decision" ? DECISION_W : SCREEN_W;
      const h = s.kind === "decision" ? DECISION_H : (_flowHeights[s.id] || 140);
      items.push([s.x || 0, s.y || 0, (s.x || 0) + w, (s.y || 0) + h]);
    });
    (flow.notes || []).forEach((n) => items.push([n.x || 0, n.y || 0, (n.x || 0) + 160, (n.y || 0) + 90]));
    (flow.sections || []).forEach((g) => items.push([g.x || 0, g.y || 0, (g.x || 0) + (g.w || 300), (g.y || 0) + (g.h || 200)]));
    (flow.labels || []).forEach((l) => items.push([l.x || 0, l.y || 0, (l.x || 0) + (l.w || 360), (l.y || 0) + 60]));
    if (!items.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach((b) => { minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]); maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]); });
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }
  // Programmatic view jumps (fit / center) GLIDE; manual pan/zoom stays 1:1.
  let _glideT = null;
  function glideView(apply) {
    flowNodes.classList.add("glide"); flowEdgesSvg.classList.add("glide");
    apply();
    if (_glideT) clearTimeout(_glideT);
    _glideT = setTimeout(() => { flowNodes.classList.remove("glide"); flowEdgesSvg.classList.remove("glide"); flowNodes.style.willChange = "auto"; }, 320);
  }
  function fitFlowView() {
    glideView(() => {
      const bb = flowBBox();
      const r = flowVp.getBoundingClientRect();
      if (!bb) { flowView = { x: 60, y: 60, s: 1 }; flowApplyView(); return; }
      const pad = 70;
      const s = Math.min(1.5, Math.max(0.15, Math.min((r.width - pad * 2) / Math.max(bb.w, 1), (r.height - pad * 2) / Math.max(bb.h, 1))));
      flowView.s = s;
      flowView.x = (r.width - bb.w * s) / 2 - bb.minX * s;
      flowView.y = (r.height - bb.h * s) / 2 - bb.minY * s;
      flowApplyView();
    });
  }
  function centerOnScreen(s, select) {
    const r = flowVp.getBoundingClientRect();
    const w = s.kind === "decision" ? DECISION_W : SCREEN_W;
    const h = s.kind === "decision" ? DECISION_H : (_flowHeights[s.id] || 140);
    const cx = (s.x || 0) + w / 2, cy = (s.y || 0) + h / 2;
    glideView(() => {
      flowView.x = r.width / 2 - cx * flowView.s;
      flowView.y = r.height / 2 - cy * flowView.s;
      flowApplyView();
    });
    if (select) { flowSel = new Set([s.id]); refreshSelClasses(); }
  }
  function openFlowSearch(rect) {
    flowMenu.innerHTML = '<div class="fm-label">Search screen</div>' +
      '<input class="fm-edge-input" id="fm-search" placeholder="Name or context…" spellcheck="false" />' +
      '<div id="fm-results"></div>';
    flowMenu.style.left = Math.min(rect.left, window.innerWidth - 320) + "px";
    flowMenu.style.top = (rect.bottom + 4) + "px";
    flowMenu.classList.add("visible", "wide");
    const inp = flowMenu.querySelector("#fm-search"), res = flowMenu.querySelector("#fm-results");
    const renderRes = () => {
      const ql = inp.value.trim().toLowerCase();
      const matches = flow.screens.filter((s) => !ql || (s.name || "").toLowerCase().indexOf(ql) !== -1 || (s.desc || "").toLowerCase().indexOf(ql) !== -1).slice(0, 40);
      res.innerHTML = matches.length
        ? matches.map((s) => '<div class="fm-item" data-sid="' + s.id + '"><span class="fs-status-dot" style="background:' + FLOW_STATUS[screenStatus(s)].color + '"></span> ' + escapeHtml(s.name || "Screen") + '</div>').join("")
        : '<div class="fm-empty-hint">No results.</div>';
      res.querySelectorAll("[data-sid]").forEach((it) => it.onclick = () => { const s = flow.screens.find((x) => x.id === it.dataset.sid); if (s) { centerOnScreen(s, true); closeFlowMenu(); } });
    };
    inp.addEventListener("mousedown", (e) => e.stopPropagation());
    inp.oninput = renderRes;
    inp.onkeydown = (ev) => { if (ev.key === "Enter") { const f = res.querySelector("[data-sid]"); if (f) f.click(); } };
    renderRes();
    setTimeout(() => inp.focus(), 0);
  }

  // ── Notas (stickies) ──
  function buildNoteEl(n) {
    const el = document.createElement("div");
    el.className = "flow-note note-" + (NOTE_COLORS[n.color] ? n.color : "yellow");
    el.dataset.id = n.id;
    el.style.left = (n.x || 0) + "px"; el.style.top = (n.y || 0) + "px";
    el.innerHTML =
      '<div class="fn-bar"><button class="fn-color" title="Color"></button><span class="fn-grip"></span><button class="fn-del" title="Options">' + FI.dots + '</button></div>' +
      '<div class="fn-text" contenteditable="true" spellcheck="false" data-ph="Note…">' + escapeHtml(n.text || "") + '</div>';
    const text = el.querySelector(".fn-text");
    text.addEventListener("mousedown", (e) => e.stopPropagation());
    text.addEventListener("input", () => { n.text = text.textContent; saveFlow(); });
    const bar = el.querySelector(".fn-bar");
    bar.addEventListener("mousedown", (e) => { if (e.target.closest(".fn-color, .fn-del")) return; e.preventDefault(); e.stopPropagation(); startObjDrag(n, el, e); });
    el.querySelector(".fn-color").addEventListener("mousedown", (e) => e.stopPropagation());
    el.querySelector(".fn-color").onclick = (e) => { e.stopPropagation(); n.color = NOTE_KEYS[(NOTE_KEYS.indexOf(n.color || "yellow") + 1) % NOTE_KEYS.length]; saveFlow(); renderFlow(); };
    el.querySelector(".fn-del").addEventListener("mousedown", (e) => e.stopPropagation());
    el.querySelector(".fn-del").onclick = (e) => {
      e.stopPropagation();
      openObjMenu(e.currentTarget.getBoundingClientRect(), [
        { label: "Change color", icon: FI.palette, fn: () => { n.color = NOTE_KEYS[(NOTE_KEYS.indexOf(n.color || "yellow") + 1) % NOTE_KEYS.length]; saveFlow(); renderFlow(); } },
        { label: "Delete note", icon: FI.trash, danger: true, fn: () => { flow.notes = (flow.notes || []).filter((x) => x.id !== n.id); saveFlow(); renderFlow(); } },
      ]);
    };
    return el;
  }
  // Generic drag for notes/sections (objects with x/y), honoring snap.
  function startObjDrag(obj, el, e) {
    const startW = flowWorld(e.clientX, e.clientY); const ox = obj.x || 0, oy = obj.y || 0;
    const move = (ev) => { const w = flowWorld(ev.clientX, ev.clientY); obj.x = snapv(Math.round(ox + (w.x - startW.x))); obj.y = snapv(Math.round(oy + (w.y - startW.y))); el.style.left = obj.x + "px"; el.style.top = obj.y + "px"; scheduleEdgeRender(); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); saveFlow(); renderMinimap(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  function addNote() {
    const r = flowVp.getBoundingClientRect(); const w = flowWorld(r.left + r.width / 2, r.top + r.height / 2);
    flow.notes = flow.notes || [];
    const n = { id: flowGenId(), text: "", x: Math.round(w.x - 80), y: Math.round(w.y - 45), color: "yellow" };
    flow.notes.push(n); saveFlow(); renderFlow();
    setTimeout(() => { const t = flowNodes.querySelector('.flow-note[data-id="' + n.id + '"] .fn-text'); if (t) t.focus(); }, 0);
  }
  function setFlowSnap(on) { flowSnap = on; const b = document.getElementById("flow-snap"); if (b) b.classList.toggle("on", on); }

  // ── Canvas labels: a heading (title + context) that titles a part of the board ──
  function buildLabelEl(l) {
    const el = document.createElement("div");
    el.className = "flow-label";
    el.dataset.id = l.id;
    el.style.left = (l.x || 0) + "px"; el.style.top = (l.y || 0) + "px"; el.style.width = (l.w || 360) + "px";
    el.innerHTML =
      '<div class="fl-lbl-bar"><span class="fl-lbl-grip"></span><button class="fl-lbl-del" title="Options">' + FI.dots + '</button></div>' +
      '<div class="fl-lbl-title" contenteditable="true" spellcheck="false" data-ph="Section title">' + escapeHtml(l.title || "") + '</div>' +
      '<div class="fl-lbl-ctx" contenteditable="true" spellcheck="false" data-ph="Context…">' + escapeHtml(l.ctx || "") + '</div>' +
      '<div class="fl-lbl-resize" title="Width"></div>';
    const t = el.querySelector(".fl-lbl-title"), c = el.querySelector(".fl-lbl-ctx");
    t.addEventListener("mousedown", (e) => e.stopPropagation()); t.addEventListener("input", () => { l.title = t.textContent; saveFlow(); });
    c.addEventListener("mousedown", (e) => e.stopPropagation()); c.addEventListener("input", () => { l.ctx = c.textContent; saveFlow(); });
    const bar = el.querySelector(".fl-lbl-bar");
    bar.addEventListener("mousedown", (e) => { if (e.target.closest(".fl-lbl-del")) return; e.preventDefault(); e.stopPropagation(); startObjDrag(l, el, e); });
    el.querySelector(".fl-lbl-del").addEventListener("mousedown", (e) => e.stopPropagation());
    el.querySelector(".fl-lbl-del").onclick = (e) => {
      e.stopPropagation();
      openObjMenu(e.currentTarget.getBoundingClientRect(), [
        { label: "Delete title", icon: FI.trash, danger: true, fn: () => { flow.labels = (flow.labels || []).filter((x) => x.id !== l.id); saveFlow(); renderFlow(); } },
      ]);
    };
    const rz = el.querySelector(".fl-lbl-resize");
    rz.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const w0 = l.w || 360, sx = e.clientX;
      const move = (ev) => { l.w = Math.max(140, Math.round(w0 + (ev.clientX - sx) / flowView.s)); el.style.width = l.w + "px"; };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); saveFlow(); renderMinimap(); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
    return el;
  }
  function addLabel() {
    const r = flowVp.getBoundingClientRect(); const w = flowWorld(r.left + r.width / 2, r.top + r.height / 2);
    flow.labels = flow.labels || [];
    const l = { id: flowGenId(), title: "", ctx: "", x: Math.round(w.x - 180), y: Math.round(w.y - 30), w: 360 };
    flow.labels.push(l); saveFlow(); renderFlow();
    setTimeout(() => { const t = flowNodes.querySelector('.flow-label[data-id="' + l.id + '"] .fl-lbl-title'); if (t) t.focus(); }, 0);
  }

  // ── Align / distribute the selection ──
  function sdim(s) { return nodeDim(s); }
  function alignSelection(op) {
    const ss = selectedScreens(); if (ss.length < 2) return;
    const L = Math.min.apply(null, ss.map((s) => s.x || 0));
    const R = Math.max.apply(null, ss.map((s) => (s.x || 0) + sdim(s).w));
    const T = Math.min.apply(null, ss.map((s) => s.y || 0));
    const B = Math.max.apply(null, ss.map((s) => (s.y || 0) + sdim(s).h));
    const cx = (L + R) / 2, cy = (T + B) / 2;
    if (op === "left") ss.forEach((s) => s.x = L);
    else if (op === "right") ss.forEach((s) => s.x = Math.round(R - sdim(s).w));
    else if (op === "centerh") ss.forEach((s) => s.x = Math.round(cx - sdim(s).w / 2));
    else if (op === "top") ss.forEach((s) => s.y = T);
    else if (op === "bottom") ss.forEach((s) => s.y = Math.round(B - sdim(s).h));
    else if (op === "middlev") ss.forEach((s) => s.y = Math.round(cy - sdim(s).h / 2));
    else if (op === "disth") { const so = ss.slice().sort((a, b) => (a.x || 0) - (b.x || 0)); const tot = so.reduce((a, s) => a + sdim(s).w, 0); const gap = (R - L - tot) / (so.length - 1); let x = L; so.forEach((s) => { s.x = Math.round(x); x += sdim(s).w + gap; }); }
    else if (op === "distv") { const so = ss.slice().sort((a, b) => (a.y || 0) - (b.y || 0)); const tot = so.reduce((a, s) => a + sdim(s).h, 0); const gap = (B - T - tot) / (so.length - 1); let y = T; so.forEach((s) => { s.y = Math.round(y); y += sdim(s).h + gap; }); }
    saveFlow(); renderFlow();
  }
  function updateAlignBar() {
    const bar = document.getElementById("flow-align"); if (!bar) return;
    bar.classList.toggle("visible", flowMode && flowSel.size >= 2);
  }

  // ── Sections / frames ──
  const SECTION_COLORS = { slate: "#8a93a6", blue: "#7cb0ff", green: "#34d399", amber: "#f5a623", purple: "#b388ff" };
  const SECTION_KEYS = ["slate", "blue", "green", "amber", "purple"];
  function buildSectionEl(g) {
    const el = document.createElement("div");
    el.className = "flow-section";
    el.dataset.id = g.id;
    el.style.left = (g.x || 0) + "px"; el.style.top = (g.y || 0) + "px";
    el.style.width = (g.w || 360) + "px"; el.style.height = (g.h || 260) + "px";
    el.style.setProperty("--sec-color", SECTION_COLORS[g.color] || SECTION_COLORS.slate);
    el.innerHTML =
      '<div class="fsec-bar"><span class="fsec-dot"></span><span class="fsec-name" contenteditable="true" spellcheck="false" data-ph="Section">' + escapeHtml(g.name || "") + '</span><span class="fsec-sp"></span>' +
      '<button class="fsec-color" title="Color"></button><button class="fsec-del" title="Delete section">' + FI.x + '</button></div>' +
      '<div class="fsec-resize" title="Resize"></div>';
    const nm = el.querySelector(".fsec-name");
    nm.addEventListener("mousedown", (e) => e.stopPropagation());
    nm.addEventListener("input", () => { g.name = nm.textContent; saveFlow(); });
    const bar = el.querySelector(".fsec-bar");
    bar.addEventListener("mousedown", (e) => { if (e.target.closest(".fsec-name, .fsec-color, .fsec-del")) return; e.preventDefault(); e.stopPropagation(); startSectionDrag(g, el, e); });
    el.querySelector(".fsec-color").addEventListener("mousedown", (e) => e.stopPropagation());
    el.querySelector(".fsec-color").onclick = (e) => { e.stopPropagation(); g.color = SECTION_KEYS[(SECTION_KEYS.indexOf(g.color || "slate") + 1) % SECTION_KEYS.length]; saveFlow(); renderFlow(); };
    el.querySelector(".fsec-del").addEventListener("mousedown", (e) => e.stopPropagation());
    el.querySelector(".fsec-del").onclick = (e) => { e.stopPropagation(); flow.sections = (flow.sections || []).filter((x) => x.id !== g.id); saveFlow(); renderFlow(); };
    const rz = el.querySelector(".fsec-resize");
    rz.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const sw = g.w || 360, sh = g.h || 260, startW = flowWorld(e.clientX, e.clientY);
      const move = (ev) => { const w = flowWorld(ev.clientX, ev.clientY); g.w = Math.max(160, Math.round(sw + (w.x - startW.x))); g.h = Math.max(110, Math.round(sh + (w.y - startW.y))); el.style.width = g.w + "px"; el.style.height = g.h + "px"; };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); saveFlow(); renderMinimap(); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
    return el;
  }
  // Dragging a section moves it + the screens/notes that sit inside it.
  function startSectionDrag(g, el, e) {
    const startW = flowWorld(e.clientX, e.clientY); const ox = g.x || 0, oy = g.y || 0;
    const x2 = ox + (g.w || 360), y2 = oy + (g.h || 260);
    const inside = (o) => { const x = o.x || 0, y = o.y || 0; return x >= ox && y >= oy && x <= x2 && y <= y2; };
    const moving = flow.screens.filter(inside).concat((flow.notes || []).filter(inside)).map((o) => ({ o: o, ox: o.x || 0, oy: o.y || 0 }));
    const move = (ev) => {
      const w = flowWorld(ev.clientX, ev.clientY); let dx = Math.round(w.x - startW.x), dy = Math.round(w.y - startW.y);
      if (flowSnap) { dx = snapv(ox + dx) - ox; dy = snapv(oy + dy) - oy; }
      if (dx || dy) _edgeRoutes = {}; // moving a section's cards invalidates the auto-routed lanes
      g.x = ox + dx; g.y = oy + dy; el.style.left = g.x + "px"; el.style.top = g.y + "px";
      moving.forEach((m) => { m.o.x = m.ox + dx; m.o.y = m.oy + dy; const ce = flowNodes.querySelector('[data-id="' + m.o.id + '"]'); if (ce) { ce.style.left = m.o.x + "px"; ce.style.top = m.o.y + "px"; } });
      scheduleEdgeRender();
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); saveFlow(); renderMinimap(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  function addFrame() {
    const r = flowVp.getBoundingClientRect(); const w = flowWorld(r.left + r.width / 2, r.top + r.height / 2);
    flow.sections = flow.sections || [];
    const g = { id: flowGenId(), name: "Section", x: Math.round(w.x - 180), y: Math.round(w.y - 130), w: 360, h: 260, color: "slate" };
    flow.sections.push(g); saveFlow(); renderFlow();
    setTimeout(() => { const nm = flowNodes.querySelector('.flow-section[data-id="' + g.id + '"] .fsec-name'); if (nm) nm.focus(); }, 0);
  }

  // Hand tool — pan from anywhere (even over cards). Capture phase so it wins
  // over the card drag/select handlers; stopPropagation keeps them from firing.
  flowVp.addEventListener("mousedown", (e) => {
    if (flowTool !== "hand" || e.button !== 0 || flowSpace) return;
    if (e.target.closest("#flow-menu")) return;
    if (e.target.closest(".flow-screen, .flow-note, .fsec-bar, .fsec-resize, .fl-lbl-bar, .fl-lbl-resize, .fl-lbl-title, .fl-lbl-ctx")) return; // grabbing a card/note/section/label handle → let it move, don't pan
    e.preventDefault(); e.stopPropagation(); flowVp.classList.add("panning");
    const ox = flowView.x, oy = flowView.y, sx = e.clientX, sy = e.clientY;
    const move = (ev) => { flowView.x = ox + (ev.clientX - sx); flowView.y = oy + (ev.clientY - sy); flowApplyView(); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); flowVp.classList.remove("panning"); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }, true);
  // Pan (Space-drag or middle button) + marquee select (plain left-drag on empty)
  flowVp.addEventListener("mousedown", (e) => {
    if (e.target.closest(".flow-screen") || e.target.closest("#flow-menu")) return;
    const cl = e.target.classList; if (cl && (cl.contains("flow-edge-hit") || cl.contains("flow-edge-label"))) return;
    if (flowSpace || e.button === 1 || e.button === 2) { // PAN
      e.preventDefault(); flowVp.classList.add("panning");
      const ox = flowView.x, oy = flowView.y, sx = e.clientX, sy = e.clientY;
      const move = (ev) => { flowView.x = ox + (ev.clientX - sx); flowView.y = oy + (ev.clientY - sy); flowApplyView(); };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); flowVp.classList.remove("panning"); };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
      return;
    }
    if (e.button !== 0) return;
    // MARQUEE — rubber-band select. Shift keeps the existing selection.
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(flowSel) : new Set();
    if (!additive) { flowSel = new Set(); refreshSelClasses(); }
    const vr = flowVp.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY; let moved = false;
    const box = document.createElement("div"); box.id = "flow-marquee";
    const move = (ev) => {
      const dxAbs = Math.abs(ev.clientX - sx), dyAbs = Math.abs(ev.clientY - sy);
      if (!moved && dxAbs < 3 && dyAbs < 3) return; // tolerance so a plain click doesn't marquee
      if (!moved) { moved = true; flowVp.appendChild(box); }
      const l = Math.min(sx, ev.clientX), t = Math.min(sy, ev.clientY), w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      box.style.left = (l - vr.left) + "px"; box.style.top = (t - vr.top) + "px"; box.style.width = w + "px"; box.style.height = h + "px";
      const mr = { left: l, top: t, right: l + w, bottom: t + h };
      const next = new Set(base);
      flowNodes.querySelectorAll(".flow-screen").forEach((card) => {
        const cr = card.getBoundingClientRect();
        const hit = cr.left < mr.right && cr.right > mr.left && cr.top < mr.bottom && cr.bottom > mr.top;
        if (hit) next.add(card.dataset.id);
      });
      flowSel = next; refreshSelClasses();
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); if (box.parentNode) box.parentNode.removeChild(box); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  });
  flowVp.addEventListener("contextmenu", (e) => { if (!e.target.closest(".flow-screen") && !e.target.closest("#flow-menu")) e.preventDefault(); });
  flowVp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = flowVp.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
    const old = flowView.s;
    // Smooth, proportional zoom — exponential of the wheel delta (mid sensitivity).
    const factor = Math.exp(-e.deltaY * 0.0025);
    const ns = Math.max(0.15, Math.min(2, old * factor));
    flowView.x = mx - (mx - flowView.x) * (ns / old); flowView.y = my - (my - flowView.y) * (ns / old);
    flowView.s = ns; flowApplyView();
    // Suspend card blur during the zoom gesture (reuses the .panning fast path).
    flowVp.classList.add("panning");
    clearTimeout(_flowZoomBlurT); _flowZoomBlurT = setTimeout(() => flowVp.classList.remove("panning"), 180);
  }, { passive: false });
  let _flowZoomBlurT = null;

  // Export → structured prompt to the active tab's terminal
  // Shared: serialize the active flow's structure (screens → sections →
  // components, edges, groups, notes) to markdown for an agent prompt.
  function flowPromptBody() {
    const byId = {}; flow.screens.forEach((s) => (byId[s.id] = s));
    const renderLayoutMd = (node, depth) => {
      const pad = "  ".repeat(depth);
      if (isCont(node)) {
        let out = "";
        if (depth > 0) out += pad + "- " + (node.dir === "row" ? "Row (side by side)" : "Column (stacked)") + ":\n";
        node.children.forEach((c) => (out += renderLayoutMd(c, depth + 1)));
        return out;
      }
      const bc = blockContent(node);
      let line = pad + "- **" + (bc.title || "") + "**" + (bc.type ? " [" + bc.type + "]" : "") + (node.globalId ? " _(global)_" : "") + (bc.desc ? ": " + bc.desc : "") + "\n";
      (bc.items || []).forEach((it) => (line += pad + "    · " + it + "\n"));
      return line;
    };
    let md = "";
    const starts = flow.screens.filter((s) => s.kind === "start").map((s) => s.name || "Start");
    const ends = flow.screens.filter((s) => s.kind === "end").map((s) => s.name || "End");
    if (starts.length || ends.length) md += "**The experience starts at:** " + (starts.join(", ") || "(unmarked)") + "  ·  **ends at:** " + (ends.join(", ") || "(unmarked)") + "\n";
    md += "\n";
    flow.screens.forEach((s, i) => {
      const k = FLOW_KINDS[s.kind] || FLOW_KINDS.page;
      md += "## " + (s.handle ? s.handle + " · " : "") + (s.name || "Screen") + "  ·  " + k.label + "  ·  [" + FLOW_STATUS[screenStatus(s)].label + "]\n";
      if (s.desc) md += s.desc + "\n";
      (s.apis || []).forEach((a) => { if (a.endpoint) md += "API/endpoint: `" + a.endpoint + "`" + (a.ctx ? " — " + a.ctx : "") + "\n"; });
      (s.links || []).forEach((l) => { if (l.url) md += "Linked view: `" + l.url + "`" + (l.ctx ? " — " + l.ctx : "") + "\n"; });
      if (s.kind !== "decision") {
        ensureLayout(s);
        md += "Structure: " + (s.layout.dir === "row" ? "horizontal (regions side by side)" : "vertical (stacked)") + "\n";
        md += renderLayoutMd(s.layout, 0);
      }
      const outs = flow.edges.filter((e) => e.from === s.id);
      outs.forEach((e) => { const t = byId[e.to]; if (t) md += "  → leads to **" + (t.handle ? t.handle + " " : "") + (t.name || "") + "**" + (e.out ? " (" + e.out + ")" : "") + (e.label ? " when: " + e.label : "") + "\n"; });
      md += "\n";
    });
    if ((flow.sections || []).length) {
      md += "## Sections / grouping\n";
      flow.sections.forEach((g) => {
        const x2 = (g.x || 0) + (g.w || 360), y2 = (g.y || 0) + (g.h || 260);
        const inside = flow.screens.filter((s) => { const x = s.x || 0, y = s.y || 0; return x >= (g.x || 0) && y >= (g.y || 0) && x <= x2 && y <= y2; }).map((s) => s.name || "Screen");
        md += "- **" + (g.name || "Section") + "**" + (inside.length ? ": " + inside.join(", ") : "") + "\n";
      });
      md += "\n";
    }
    if ((flow.notes || []).length) {
      const ns = flow.notes.filter((n) => (n.text || "").trim());
      if (ns.length) { md += "## Notes\n"; ns.forEach((n) => { md += "- " + n.text.trim().replace(/\n/g, " ") + "\n"; }); md += "\n"; }
    }
    return md;
  }
  function sendToTerminal(at, text, toastMsg) {
    if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
    setTimeout(() => window.api.termInput({ tabKey: at.key, data: text }), 280);
    if (toastMsg) showToast(toastMsg, "check");
  }
  function exportFlowPrompt() {
    const at = activeTab(); if (!at) { showToast("Open a project", "warn"); return; }
    if (!flow.screens.length) { showToast("The flow is empty", "warn"); return; }
    let md = "Take this user flow (from Ohana, source: .ohana/flow.json) and build/adjust it consistently:\n\n";
    md += "# User Flow — " + (at.name || "project") + "\n";
    md += (at.kind === "file")
      ? "Work on this tab's file: `$OHANA_FILE` (" + (at.src || "") + ").\n"
      : "Work in this tab's project" + (at.dir ? " (`" + at.dir + "`)" : "") + ".\n";
    md += flowPromptBody();
    sendToTerminal(at, md, "Flow sent to the terminal — review it and hit Enter");
  }
  function slugify(s) { return (s || "prototype").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "prototype"; }
  // «Take to prototype»: link the board to an HTML file and ask the agent to
  // build/refine it from the flow's structure. You then iterate board ↔ preview.
  function takeToPrototype() {
    const at = requireAnchor(); if (!at) return;
    if (!flow.screens.length) { showToast("The flow is empty", "warn"); return; }
    let rel = flow.proto;
    if (!rel) { rel = projDirNames().prototypes + "/" + slugify(flow.name) + ".html"; flow.proto = rel; saveFlow(); renderProjectNav(true); }
    const abs = (at.dir ? at.dir.replace(/\/$/, "") + "/" : "") + rel;
    let md = "Build (or refine if it already exists) a real HTML PROTOTYPE of this user flow, in the file `" + rel + "` of this project.\n";
    md += "Requirements: ONE self-contained HTML file; Tailwind CSS, Alpine.js, and Lucide via CDN (no installing dependencies). If there's a project `design.md` or tokens, RESPECT THEM (voice, tone, colors, components). Each screen in the flow is a view; respect its sections and components. Leave `data-ai-id` on the key elements so they can be commented on in Ohana.\n\n";
    md += "# " + (flow.name || "Prototype") + " — flow structure\n";
    md += flowPromptBody();
    sendToTerminal(at, md, "Prototype linked (" + rel + ") — the agent builds it; open it in Prototypes");
  }

  // Mode switch (Preview · Moka)
  // Moka needs a real folder on disk: that's where .ohana/flow.json lives and where
  // ~/.ohana/active.json points, the only bridge to the agent's MCP tools. A URL tab
  // (dir=null) is NOT anchored → the MCP has nowhere to write. Rule: "no folder = no Moka".
  function anchoredTab() { const at = activeTab(); return at && at.dir ? at : null; }
  function requireAnchor() {
    const at = activeTab();
    if (!at) { showToast("Open a project first", "warn"); return null; }
    if (!at.dir) {
      showToast("Moka needs a folder. Open an .html, a folder, or 'New prototype'.", "warn");
      openOpenDialog();
      return null;
    }
    return at;
  }
  function setMode(m) {
    if (m !== "preview" && !requireAnchor()) return;
    flowMode = (m === "flow");
    syncView();               // one place applies the view state + invariants
    if (flowMode) loadFlowForActive(); else closeFlowMenu();
    adjustPanelsMargin(); // inset the active overlay/webview for any open panels
  }
  function setFlowMode(on) { setMode(on ? "flow" : "preview"); } // back-compat for callers

  // Open the real view a screen is linked to (closes the loop flow ↔ prototype).
  function openLinkedView(link) {
    setFlowMode(false);
    if (!link) { showToast("This screen isn't linked to a view", "warn"); return; }
    if (/^https?:/i.test(link)) openFromURL(link);
    else window.api.loadDropped(link);
  }

  // AI generation (Relume-style): Claude writes .ohana/flow.json from a prompt.
  const flowGenPanel = document.getElementById("flow-gen-panel");
  function runFlowGenerate() {
    const at = requireAnchor(); if (!at) return;
    const prompt = document.getElementById("flow-gen-prompt").value.trim();
    if (!prompt) { showToast("Describe the feature first", "warn"); return; }
    const schema = '{ "flows": [ { "id": "<id>", "name": "...", "screens": [ { "id": "<unique-id>", "name": "<title; if kind=decision, the question>", "desc": "<context>", "kind": "page|modal|dialog|decision|start|end|subflow", "status": "todo|wip|done", "apis": [ { "endpoint": "GET /api/…", "ctx": "optional" } ], "links": [ { "url": "path", "ctx": "optional" } ], "layout": { "dir": "col", "children": [ { "dir": "col", "name": "<SECTION, e.g. Hero / Form / Filters>", "children": [ { "type": "<COMPONENT from the catalog: Button, Input, Data table, Chart, Checkbox, Avatar, Menu, Calendar, Date picker, Carousel, Breadcrumbs, Badge, Alert, Accordion, Search>", "title": "<what it is>", "desc": "<detail>", "items": ["<optional sub-element>"] } ] } ] } } ], "edges": [ { "from": "<id>", "to": "<id>", "label": "<Yes/No on decisions>", "dir": "fwd|back|both" } ] } ], "active": "<active-flow-id>" }';
    // A screen = SECTIONS (containers with a name) → each holds COMPONENTS (leaves with a catalog type).
    // Never flatten components into a text list; a button is {type:"Button"}, not an item "Send button".
    const isSitemap = boardType() === "sitemap";
    const common =
      "FIRST call `ohana_status` to confirm Ohana has a project open. If it responds that there's no active project (or `projectDir` is null), STOP and tell me to open or create a folder in Ohana (Open → «New prototype»); do NOT write any file blindly.\n" +
      "Use Moka's MCP TOOLS (the `ohana-comments` server); do NOT write flow.json by hand if you have them. " +
      "Work on the active project's flow: do NOT pass `flowId` — the tools resolve the flow of the open tab in Ohana on their own (that's why it appears live where you see it). Create screens with `ohana_flow_add_screen` (don't worry about x/y). " +
      "Connect them with `ohana_flow_connect`. When done, call `ohana_flow_layout`. It appears LIVE on the canvas.\n" +
      "DECISIONS: when connecting each output of a `decision`, pass it the label and color: `ohana_flow_connect({ from, to, label: \"Yes\", color: \"positive\" })` for the affirmative path and `{ label: \"No\", color: \"negative\" }` for the negative one. (If you write flow.json by hand: each edge carries its `label` \"Yes\"/\"No\" — the output leaves the correct node on its own.)\n" +
      "CONTENT of each screen (IMPORTANT): it's made of SECTIONS and, inside them, COMPONENTS. " +
      "Create the section with `ohana_flow_add_section({ screenId, name })` (e.g. name \"Hero\", \"Form\", \"Filters\") — it returns a containerId — and add each COMPONENT with `ohana_flow_add_component({ screenId, section, name })` using the CATALOG: Button, Input, Data table, Chart, Checkbox, Avatar, Menu, Calendar, Date picker, Carousel, Breadcrumbs, Badge, Alert, Accordion, Search. " +
      "Do NOT put components as loose text: a button is a component `{ name: \"Button\" }`, NOT an item \"Send button\". A form is a section \"Form\" with Input, Input, Button components.\n";
    // Spatial contract: the agent does NOT place coordinates (x/y). Ohana lays out on
    // its own with a layered algorithm (Sugiyama-style). The only thing that decides how
    // clean the drawing is is the graph STRUCTURE. These rules make the order come out
    // clear without the agent having to "see" the canvas.
    const spatial =
      "SPATIAL ORDER (key): do NOT set coordinates or worry about positions — Ohana lays out the graph automatically. All that matters is that the connection STRUCTURE is clean. Reading order comes from the direction of the connections.\n" +
      "QUANTITY: YOU decide how many screens are needed for the feature — as many as it takes for the experience to make sense, without padding or trimming too much.\n";
    const instr = isSitemap
      ? "Build a SITEMAP (navigation architecture) for this. " + common + spatial +
        "A sitemap is a TREE read TOP to BOTTOM (TB):\n" +
        "- Level 0 (top): 1 root node (the Home) = the entry to the main navigation.\n" +
        "- Below it, the level-1 sections (the menu ones); below each, its level-2/3 child pages.\n" +
        "- TREE RULE (avoids the tangle): every page has EXACTLY ONE parent. Connect ONLY PARENT → CHILD. Siblings share a parent but do NOT connect to each other. Do NOT make cross-links or connections that skip levels — that crosses lines and ruins the order.\n" +
        "- If a page hangs from two places, pick the primary parent (the menu one) and leave the other tie as a `link` on the screen, NOT as an edge.\n" +
        "- Everything `kind: \"page\"`. NO start/end/decision — that's for user flows, not sitemaps.\n" +
        "- When done: `ohana_flow_layout` with direction **TB**.\n\n" +
        "Site: " + prompt
      : "Build a USER FLOW (sequence of tasks) for this. " + common + spatial +
        "A user flow is a SEQUENCE read LEFT to RIGHT (LR):\n" +
        "- START with `kind:\"start\"` (Start) and END each path with `kind:\"end\"` (End).\n" +
        "- BACKBONE: there's a main path step 1 → step 2 → step 3… Each screen has ONE main 'next'. Connect in chronological ORDER, always moving forward.\n" +
        "- DECISIONS (`decision`, diamond): they have exactly 2 outputs. The **Yes** branch (positive, green) CONTINUES the backbone to the right; the **No** branch (negative, red) is a side branch that either RE-ENTERS a later step or ENDS in an `end`.\n" +
        "- AVOID the tangle: don't make long jumps or backward connections except a real retry (mark those as `dir: \"back\"`). Don't connect one screen to many others; keep branches short.\n" +
        "- `modal`/`dialog` for overlays; if a modal leads elsewhere, connect it to its destination.\n" +
        "- When done: `ohana_flow_layout` with direction **LR**.\n\n" +
        "Feature: " + prompt;
    const full = instr + "\n\nIf you do NOT have the MCP tools, as a fallback: first ask Ohana for its path — the file is at `<projectDir>/.ohana/flow.json`, where `<projectDir>` is the folder Ohana has open (ask me for the path if you don't know it; do NOT use a path relative to your cwd, it would be an orphan flow the app doesn't read). Keep the other flows and leave `active` pointing to the flow you fill in:\n" + schema;
    _flowAutoLayoutPending = true; // tidy if it falls back to writing the file
    if (!termVisible) toggleTerminal(); else switchTerminalTo(at);
    setTimeout(() => window.api.termInput({ tabKey: at.key, data: full }), 280);
    flowGenPanel.classList.remove("visible");
    showToast("Instruction sent — the agent builds the " + (isSitemap ? "sitemap" : "flow") + " with Moka's tools (live)", "check");
  }

  document.getElementById("flow-add").onclick = () => addScreen("page");
  document.getElementById("flow-layout").onclick = autoLayoutFlow;
  document.getElementById("flow-layout-opts").onclick = (e) => { e.stopPropagation(); openLayoutOpts(document.getElementById("flow-layout-opts").getBoundingClientRect()); };
  document.getElementById("flow-switcher").onclick = (e) => { e.stopPropagation(); openFlowSwitcher(document.getElementById("flow-switcher").getBoundingClientRect()); };
  document.getElementById("flow-tool-pointer").onclick = () => setFlowTool("pointer");
  document.getElementById("flow-tool-hand").onclick = () => setFlowTool("hand");
  document.getElementById("flow-filter").onclick = (e) => { e.stopPropagation(); openFlowFilter(document.getElementById("flow-filter").getBoundingClientRect()); };
  document.getElementById("flow-fit").onclick = () => fitFlowView();
  document.querySelectorAll("#flow-board .fb-board").forEach((b) => b.onclick = () => setBoard(b.dataset.board));
  document.getElementById("flow-search").onclick = (e) => { e.stopPropagation(); openFlowSearch(document.getElementById("flow-search").getBoundingClientRect()); };
  document.getElementById("flow-note").onclick = addNote;
  document.getElementById("flow-label").onclick = addLabel;
  document.getElementById("flow-snap").onclick = () => setFlowSnap(!flowSnap);
  document.getElementById("flow-frame").onclick = addFrame;
  document.querySelectorAll("#flow-align .fa-btn").forEach((b) => b.onclick = () => alignSelection(b.dataset.al));
  if (flowMini) {
    const miniTo = (ev) => {
      const m = flowMini._map; if (!m) return;
      const rect = flowMini.getBoundingClientRect();
      const wx = m.minX + (ev.clientX - rect.left - m.ox) / m.sc, wy = m.minY + (ev.clientY - rect.top - m.oy) / m.sc;
      const r = flowVp.getBoundingClientRect();
      flowView.x = r.width / 2 - wx * flowView.s; flowView.y = r.height / 2 - wy * flowView.s; flowApplyView();
    };
    flowMini.addEventListener("mousedown", (e) => {
      e.stopPropagation(); e.preventDefault(); miniTo(e);
      const mv = (ev) => miniTo(ev);
      const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    });
  }
  document.getElementById("flow-empty-add").onclick = () => addScreen("page");
  document.getElementById("flow-export").onclick = exportFlowPrompt;
  document.getElementById("flow-to-proto").onclick = takeToPrototype;
  document.getElementById("flow-view-proto").onclick = () => {
    const at = activeTab(); if (!at || !flow.proto) return;
    const abs = (at.dir ? at.dir.replace(/\/$/, "") + "/" : "") + flow.proto;
    openPrototypeArtifact(at, abs);
  };
  document.getElementById("flow-refresh").onclick = () => { loadFlowForActive(); showToast("Flow reloaded from disk", "refresh-cw"); };
  document.getElementById("flow-generate").onclick = () => flowGenPanel.classList.toggle("visible");
  document.getElementById("flow-gen-close").onclick = () => flowGenPanel.classList.remove("visible");
  document.getElementById("flow-gen-run").onclick = runFlowGenerate;

  // ── Bento loader (shown briefly while (re)loading the flow) ──
  // Bento loader: a soft glow orbits the 2×2 continuously (rAF, eased per segment)
  // and each tile lights up by PROXIMITY to the glow — so the highlight flows like
  // an agent scanning, never jumps. Icons crossfade through the page-component set
  // on a slower cadence. Honors prefers-reduced-motion (CSS breathe fallback).
  const LOADER_ICONS = ["button", "input", "table", "chart", "calendar", "checkbox", "avatar", "badge", "carousel", "menu", "accordion", "datePicker"];
  // Generic bento loader engine — any .bento host (Moka reload, preview load…).
  // The pulse/glow is pure CSS (bento-glow keyframes, same treatment as the
  // edge-hover glow); JS only seeds and crossfades the component icons.
  function startBento(el) {
    if (!el) return;
    const tiles = Array.prototype.slice.call(el.querySelectorAll(".bl"));
    tiles.forEach((t, i) => { const ic = t.querySelector(".ic"); if (ic && !ic.firstChild) ic.innerHTML = FI[LOADER_ICONS[i % LOADER_ICONS.length]] || FI.workflow || ""; });
    el.classList.add("visible");
    if (!el._bentoIcoT) {
      el._bentoIco = 0;
      el._bentoIcoT = setInterval(() => {
        const t = tiles[el._bentoIco % tiles.length]; el._bentoIco++;
        const ic = t && t.querySelector(".ic"); if (!ic) return;
        ic.classList.add("swap");                                      // fade out, swap, fade in
        setTimeout(() => { ic.innerHTML = FI[LOADER_ICONS[(el._bentoIco * 3) % LOADER_ICONS.length]] || FI.workflow || ""; ic.classList.remove("swap"); }, 280);
      }, 1500);
    }
  }
  function stopBento(el) {
    if (!el) return;
    el.classList.remove("visible");
    if (el._bentoIcoT) { clearInterval(el._bentoIcoT); el._bentoIcoT = null; }
  }
  function showFlowLoader() { startBento(document.getElementById("flow-loader")); }
  function hideFlowLoader() { stopBento(document.getElementById("flow-loader")); }
  function showReloadBanner() { const b = document.getElementById("flow-reload-banner"); if (b) b.classList.add("visible"); }
  function hideReloadBanner() { const b = document.getElementById("flow-reload-banner"); if (b) b.classList.remove("visible"); }
  // Error empty-states with a paste-to-terminal prompt so an agent can fix it.
  const FLOW_ERRORS = {
    corrupt: {
      title: "The flow is corrupted",
      msg: "Couldn't read .ohana/flow.json (malformed JSON). We won't overwrite the file so you don't lose your work; ask your agent to repair it.",
      prompt: "This project's .ohana/flow.json file is malformed (invalid JSON) and Ohana can't load the Moka flow. Open it, find the syntax error, and repair it while preserving the structure { \"flows\": [ { \"id\", \"name\", \"screens\", \"edges\" } ], \"active\" }. Don't delete existing flows or screens.",
    },
  };
  function showFlowError(kind) {
    const e = FLOW_ERRORS[kind]; if (!e) return;
    document.getElementById("flow-error-title").textContent = e.title;
    document.getElementById("flow-error-msg").textContent = e.msg;
    document.getElementById("flow-error-prompt").textContent = e.prompt;
    hideFlowLoader();
    document.getElementById("flow-error").classList.add("visible");
  }
  function hideFlowError() { const el = document.getElementById("flow-error"); if (el) el.classList.remove("visible"); }
  // Apply an external flow.json edit (from the agent) into the canvas, with the loader.
  function applyFlowReload(content, opts) {
    opts = opts || {};
    let d = null;
    try { d = content ? JSON.parse(content) : null; } catch (e) { showFlowError("corrupt"); return; }
    if (!(d && (Array.isArray(d.screens) || Array.isArray(d.flows)))) { hideFlowLoader(); return; }
    hideFlowError(); showFlowLoader();
    if (_flowSnap !== null) { _flowUndo.push(_flowSnap); _flowRedo = []; } // make the agent's change undoable
    flowDoc = normalizeFlowDoc(d); migrateScreens();
    const at = activeTab(); if (at) ensureTabFlow(at.src); // keep this tab on its own flow
    flow = activeFlowObj(); _flowSnap = JSON.stringify(flowDoc);
    renderFlow(); renderFlowSwitcher();
    if (_flowAutoLayoutPending) { _flowAutoLayoutPending = false; autoLayoutFlow(); }
    else if (opts.fit) fitFlowView(); // frame the finished result on the final reveal
    if (typeof renderProjectNav === "function") renderProjectNav(true); // new boards appear in the rail
    setTimeout(hideFlowLoader, 550);
  }
  // Reveal the finished flow once the agent stops writing (quiet period elapsed).
  function finishAgentBuild() {
    _agentBuilding = false; _agentBuildT = null; document.body.classList.remove("flow-loading");
    const c = _flowPendingReload; _flowPendingReload = null;
    if (c == null) { hideFlowLoader(); return; }
    // The agent's writer (MCP) is headless — it can't measure how tall each card
    // renders with its sections/components, so its coordinates overlap. Re-run
    // the layout HERE with the REAL measured heights (renderFlow fills
    // _flowHeights first) and persist the tidy result.
    _flowAutoLayoutPending = true;
    applyFlowReload(c);
  }
  // Auto-reload when flow.json changes on disk (the agent or an external edit).
  // Conflict rule: never clobber an edit in progress — hold it and offer "Recargar".
  // Agent builds stream many writes: we DON'T re-render per write. We show one
  // persistent loader and only apply the latest content once writes go quiet.
  window.api.on("flow:updated", (content) => {
    // Keep the navigator's Flows list live even outside Moka (agent-created
    // boards must appear without entering flow mode). renderProjectNav folds
    // queued rescans, so bursty agent writes stay cheap.
    if (typeof renderProjectNav === "function") renderProjectNav(true);
    if (!flowMode) return;
    if (Date.now() - _flowLastSelfWrite < 1500) return; // ignore our own write's echo
    _flowPendingReload = content;                        // always keep the freshest
    const editing = _flowBusy || flowNodes.contains(document.activeElement) || _flowSaveT; // drag / focused input / unsaved change
    if (editing) { showReloadBanner(); return; }         // don't fight the user; reveal when they finish
    if (!_agentBuilding) { _agentBuilding = true; document.body.classList.add("flow-loading"); hideFlowError(); showFlowLoader(); } // first write → one persistent loader (blur off while building)
    if (_agentBuildT) clearTimeout(_agentBuildT);
    _agentBuildT = setTimeout(finishAgentBuild, AGENT_QUIET_MS); // reset the quiet timer on every write
  });
  // Track an in-progress canvas gesture so a reload can't land mid-drag.
  // A press in the canvas suspends the cards' real blur until release (perf:
  // avoids a global always-on mousemove listener; suspending on a plain click
  // for a few ms is harmless).
  flowVp.addEventListener("mousedown", () => { _flowBusy = true; flowVp.classList.add("panning"); }, true);
  window.addEventListener("mouseup", () => { _flowBusy = false; flowVp.classList.remove("panning"); });
  document.getElementById("flow-reload-btn").onclick = () => {
    hideReloadBanner();
    if (_flowPendingReload) { const c = _flowPendingReload; _flowPendingReload = null; applyFlowReload(c); }
  };
  document.getElementById("flow-error-send").onclick = () => {
    const at = activeTab(); const txt = document.getElementById("flow-error-prompt").textContent;
    if (at && txt) { if (!termVisible) toggleTerminal(); else switchTerminalTo(at); setTimeout(() => window.api.termInput({ tabKey: at.key, data: txt }), 280); }
  };
  document.getElementById("flow-error-copy").onclick = () => {
    const txt = document.getElementById("flow-error-prompt").textContent;
    try { navigator.clipboard.writeText(txt); showToast("Prompt copied", "check"); } catch (e) {}
  };
  document.getElementById("preview-error-send").onclick = () => {
    const at = activeTab(); const txt = document.getElementById("preview-error-prompt").textContent;
    if (at && txt) { if (!termVisible) toggleTerminal(); else switchTerminalTo(at); setTimeout(() => window.api.termInput({ tabKey: at.key, data: txt }), 280); }
  };
  document.getElementById("preview-error-retry").onclick = () => { hidePreviewError(); if (webview && webview.reload) webview.reload(); };
  // MCP heartbeat: the server writes ~/.ohana/mcp-alive.json; a recent stamp means connected.
  let _mcpAlive = false;
  async function checkMcpAlive() {
    try { const c = await window.api.ohanaReadGlobal("mcp-alive.json"); const d = c ? JSON.parse(c) : null; _mcpAlive = !!(d && d.at && (Date.now() - d.at < 5 * 60 * 1000)); }
    catch (e) { _mcpAlive = false; }
    const el = document.getElementById("mcp-status");
    if (el) { el.classList.toggle("on", _mcpAlive); el.title = _mcpAlive ? "MCP connected — click to open the documentation" : "MCP not detected — click to see how to connect it to your agent"; }
  }
  // Single entry point to the docs: the MCP chip in the header. When the MCP is
  // missing it lands on the connect section; otherwise on the contextual one.
  document.getElementById("mcp-status").onclick = () => openDocs(_mcpAlive ? undefined : "connect");
  checkMcpAlive();
  setInterval(checkMcpAlive, 30000);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (flowMode) {
        if (flowGenPanel.classList.contains("visible")) flowGenPanel.classList.remove("visible");
        else if (flowMenu.classList.contains("visible")) closeFlowMenu();
        else if (flowSel.size) { flowSel = new Set(); refreshSelClasses(); }
        // (no mode switch anymore — you leave Moka by opening another artifact)
      }
      return;
    }
    // Flow-mode shortcuts — not while editing text in a card.
    if (!flowMode) return;
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    if (e.key === " " || e.code === "Space") { flowSpace = true; flowVp.style.cursor = "grab"; e.preventDefault(); return; }
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.shiftKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); flowDuplicateSelection(); }
    else if (cmd && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) flowRedo(); else flowUndo(); }
    else if (cmd && (e.key === "y" || e.key === "Y")) { e.preventDefault(); flowRedo(); }
    else if (cmd && (e.key === "c" || e.key === "C")) { e.preventDefault(); if (flowCopySelection()) showToast(flowSel.size + " card(s) copied", "check"); }
    else if (cmd && (e.key === "v" || e.key === "V" || e.key === "b" || e.key === "B")) { e.preventDefault(); flowPaste(); }
    else if (cmd && (e.key === "d" || e.key === "D")) { e.preventDefault(); flowDuplicateSelection(); }
    else if (cmd && (e.key === "a" || e.key === "A")) { e.preventDefault(); flowSel = new Set(flow.screens.map((s) => s.id)); refreshSelClasses(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); flowDeleteSelection(); }
    else if (!cmd && (e.key === "v" || e.key === "V")) { setFlowTool("pointer"); }
    else if (!cmd && (e.key === "h" || e.key === "H")) { setFlowTool("hand"); }
    else if (!cmd && (e.key === "f" || e.key === "F")) { fitFlowView(); }
    else if (!cmd && e.key === "/") { e.preventDefault(); openFlowSearch(document.getElementById("flow-search").getBoundingClientRect()); }
  });
  document.addEventListener("keyup", (e) => { if (e.key === " " || e.code === "Space") { flowSpace = false; flowVp.style.cursor = ""; } });
  window.addEventListener("blur", () => { flowSpace = false; flowVp.style.cursor = ""; });
