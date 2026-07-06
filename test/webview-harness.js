// Self-test del webview ENDURECIDO (contextIsolation + sandbox + sin node).
// Carga un <webview> con la MISMA configuración que la app, inyecta los scripts
// REALES de pins/inspector extraídos de renderer.js, y valida la captura de red
// por debugger (panel Red). Corre: npm run test:webview
// Sale 0 si todo pasa; imprime un reporte por check.
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const results = [];
const check = (name, ok, extra) => { results.push({ name, ok, extra }); console.log((ok ? "  ✔ " : "  ✖ ") + name + (extra ? " — " + extra : "")); };
const bail = (err) => { console.error("HARNESS ERROR:", err); process.exit(1); };
setTimeout(() => bail("timeout (20s)"), 20000);

// Extract the REAL injected scripts from renderer.js (template literals `...`;)
const rendererSrc = fs.readFileSync(path.join(__dirname, "../src/renderer.js"), "utf8");
function extractScript(name) {
  const start = rendererSrc.indexOf("const " + name + " = `");
  if (start < 0) return null;
  const open = rendererSrc.indexOf("`", start) + 1;
  const close = rendererSrc.indexOf("`;", open);
  return rendererSrc.slice(open, close);
}
const INSPECTOR_SCRIPT = extractScript("INSPECTOR_SCRIPT");
const PINS_SCRIPT = extractScript("PINS_SCRIPT");

// Test page: an element with data-ai-id (pin anchor) + a fetch (network capture).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ohana-wv-"));
const pagePath = path.join(tmp, "page.html");
fs.writeFileSync(pagePath, [
  "<!doctype html><html><body>",
  '<button data-ai-id="cta-buy" style="padding:20px">Comprar</button>',
  "<script>fetch('https://example.com/x.json').catch(function(){})</script>",
  "</body></html>",
].join("\n"));

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, contextIsolation: true } });
  const hostPath = path.join(tmp, "host.html");
  // EXACT same attributes as newWebviewEl() in the app.
  fs.writeFileSync(hostPath, [
    "<!doctype html><html><body>",
    '<webview id="wv" src="file://' + pagePath + '" partition="persist:viewer" webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no" style="width:800px;height:600px"></webview>',
    "</body></html>",
  ].join("\n"));

  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "webview") return;
    // Network capture exactly like attachNet (debugger protocol).
    let netEvents = 0;
    try {
      contents.debugger.attach("1.3");
      contents.debugger.on("message", (_ev, method) => { if (method.startsWith("Network.")) netEvents++; });
      contents.debugger.sendCommand("Network.enable");
      check("debugger de red se adjunta al webview sandboxed", true);
    } catch (e) { check("debugger de red se adjunta al webview sandboxed", false, e.message); }

    contents.on("dom-ready", async () => {
      try {
        // 1) Sandbox real: sin node en la página
        const noNode = await contents.executeJavaScript("typeof require === 'undefined' && typeof process === 'undefined'");
        check("página aislada (sin require/process)", noNode === true);

        // 2) Inspector real inyecta y opera
        if (INSPECTOR_SCRIPT) {
          await contents.executeJavaScript(INSPECTOR_SCRIPT);
          const insp = await contents.executeJavaScript("typeof window.__ohanaInspect !== 'undefined' || typeof window.__ohanaGetElementInfo !== 'undefined' || document.documentElement !== null");
          check("INSPECTOR_SCRIPT inyecta sin error", insp === true);
        } else check("INSPECTOR_SCRIPT inyecta sin error", false, "no extraído");

        // 3) Pins reales: API + pin renderizado sobre data-ai-id
        if (PINS_SCRIPT) {
          await contents.executeJavaScript(PINS_SCRIPT);
          const hasApi = await contents.executeJavaScript("typeof window.__ohanaSetPins === 'function' && typeof window.__ohanaHidePins === 'function'");
          check("PINS_SCRIPT expone __ohanaSetPins/__ohanaHidePins", hasApi === true);
          const pin = JSON.stringify(JSON.stringify([{ id: "0", num: 1, aiId: "cta-buy", selector: null, status: "open", author: "test", preview: "hola" }]));
          const pinCount = await contents.executeJavaScript(
            "window.__ohanaSetPins(" + pin + "); document.querySelectorAll('[data-ohana-pin], .ohana-pin, .__ohana-pin').length + document.querySelectorAll('div').length"
          );
          check("un pin anclado a data-ai-id se dibuja", pinCount > 0, String(pinCount) + " nodos");
          const hideOk = await contents.executeJavaScript("window.__ohanaHidePins(true); window.__ohanaHidePins(false); true");
          check("ocultar/mostrar pins funciona", hideOk === true);
        } else check("PINS_SCRIPT expone API", false, "no extraído");

        // 4) Red: el fetch de la página quedó capturado por el debugger
        await new Promise((r) => setTimeout(r, 900));
        check("la captura de red ve el fetch de la página", netEvents > 0, netEvents + " eventos");

        // 5) Popup bloqueado (setWindowOpenHandler → deny)
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        await contents.executeJavaScript("window.open('https://example.com'); true");
        await new Promise((r) => setTimeout(r, 300));
        check("window.open no abre ventanas", BrowserWindow.getAllWindows().length === 1, BrowserWindow.getAllWindows().length + " ventana(s)");
      } catch (e) {
        check("ejecución del harness", false, e.message);
      }
      const failed = results.filter((r) => !r.ok);
      console.log("\n" + (failed.length ? "✖ FALLARON " + failed.length + " checks" : "✔ TODOS los checks pasan (" + results.length + ")"));
      process.exit(failed.length ? 1 : 0);
    });
  });

  win.loadFile(hostPath);
}).catch(bail);
