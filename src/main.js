const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  clipboard,
  nativeImage,
  shell,
  protocol,
  session,
  Notification,
  webContents,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const chokidar = require("chokidar");
const { spawn, execFileSync } = require("child_process");

// GUI apps on macOS inherit a minimal PATH (/usr/bin:/bin:…) that lacks
// Homebrew/nvm/asdf, so commands we spawn (`npm run dev`, the tab shells) die
// with exit 127 (command not found) in the packaged app. Resolve the user's
// real PATH from their login shell once at startup; markers isolate it from
// any rc-file noise (prompts, greeters). Never runs anything user-visible.
function fixSpawnPath() {
  if (process.platform !== "darwin") return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-ilc", 'printf "__OHANA_PATH__%s__END__" "$PATH"'], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /__OHANA_PATH__(.*?)__END__/s.exec(out || "");
    if (m && m[1].includes("/")) process.env.PATH = m[1];
  } catch (e) { /* fall through to the static additions */ }
  // Belt and braces: common install locations, deduped.
  const parts = (process.env.PATH || "").split(":").filter(Boolean);
  for (const p of ["/usr/local/bin", "/opt/homebrew/bin"]) {
    if (!parts.includes(p)) parts.push(p);
  }
  process.env.PATH = parts.join(":");
}
fixSpawnPath();

// Safety net: a rejected debugger/CDP promise must never take the whole app
// down. Log it and keep running (Node would otherwise crash the main process).
process.on("unhandledRejection", (reason) => {
  console.error("[ohana] unhandledRejection:", (reason && reason.message) || reason);
});

let mainWindow;
let currentFilePath = null;
let fileWatcher = null;
let devServerProcess = null;
let repoDir = null;
// "New prototype": a folder the user picked that doesn't have HTML yet and
// isn't a repo. It must anchor active.json (and therefore the MCP) just like a
// file/repo, or Moka would have nowhere to write flow.json.
let newProtoDir = null;
// "Owner" identifier of the active tab — EXACTLY the same string the renderer
// uses as `tab.src` (the .html path, the repo URL, or the new prototype's
// folder). The MCP uses it so the flow the agent creates ends up with the same
// owner the UI filters by — otherwise the flow is orphaned/invisible.
let activeTabSrc = null;
let sourceWatcher = null;
let currentMode = "html"; // "html" | "react"

// ─── Window ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    transparent: false,
    backgroundColor: "#00000000",
    roundedCorners: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  // Allow webview to load local files
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });

  // Attach the data-state shim to every preview webview, in its MAIN world.
  // Setting these programmatically is the only reliable way — the <webview>
  // preload/contextIsolation ATTRIBUTES are ignored by Electron here.
  mainWindow.webContents.on("will-attach-webview", (_e, webPreferences) => {
    webPreferences.preload = path.join(__dirname, "viewer-preload.js");
    webPreferences.contextIsolation = false;
  });

  // Surface renderer (app UI) errors in the main process log — a load-time
  // exception here used to fail silently (empty UI, no session restore) because
  // renderer console output doesn't reach stdout by default.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 3) console.error("[renderer] " + message + (sourceId ? "  (" + sourceId.split("/").pop() + ":" + line + ")" : ""));
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer] process gone:", details && details.reason);
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));

  // Open file from CLI argument
  const fileArg = process.argv.find(
    (a) => a.endsWith(".html") || a.endsWith(".htm")
  );
  if (fileArg) {
    const resolved = path.resolve(fileArg);
    if (fs.existsSync(resolved)) {
      mainWindow.webContents.once("did-finish-load", () => {
        loadHTMLFile(resolved);
      });
    }
  } else {
    const flag = path.join(app.getPath("userData"), ".seen-onboarding");
    if (!fs.existsSync(flag)) {
      // First run ever: open the interactive tutorial once.
      mainWindow.webContents.once("did-finish-load", () => {
        try {
          openOnboarding();
          fs.writeFileSync(flag, new Date().toISOString());
        } catch (e) {}
      });
    } else {
      // Returning user: reopen exactly where they left off.
      mainWindow.webContents.once("did-finish-load", () => restoreSession());
    }
  }
}

// ─── File Loading & Watching ─────────────────────────────────────────
function loadHTMLFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  // Switching to a file tab: drop any repo context so getProjectDir() /
  // active.json point at this file's folder (the repo's dev server stays up
  // for its own tab; we only stop watching its sources here).
  repoDir = null;
  newProtoDir = null;
  activeTabSrc = filePath;
  currentMode = "html";
  if (sourceWatcher) { sourceWatcher.close(); sourceWatcher = null; }

  currentFilePath = filePath;
  const dir = path.dirname(filePath);
  mainWindow.setTitle(`${path.basename(filePath)} — Ohana`);
  mainWindow.webContents.send("file:load", {
    path: filePath,
    dir: dir,
  });

  // Start watching findings for this prototype directory
  watchFindings();
  writeActiveProject();

  // Watch the entire directory so multi-file prototypes trigger reload
  if (fileWatcher) fileWatcher.close();
  fileWatcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: true,
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  fileWatcher.on("change", (changedPath) => {
    const ext = path.extname(changedPath).toLowerCase();
    if ([".html", ".htm", ".css", ".js", ".json", ".svg"].includes(ext)) {
      mainWindow.webContents.send("file:reload", {
        path: currentFilePath,
        dir: dir,
        changedFile: changedPath,
      });
    }
  });
}

// ─── Onboarding tutorial ─────────────────────────────────────────────
// The bundled onboarding ships read-only inside the app, but the tutorial
// asks Claude to edit it live. So we copy it to a writable folder on first
// use and open that copy (logo rewritten to a sibling so paths resolve).
function getOnboardingSource() {
  return path.join(__dirname, "..", "examples", "onboarding.html");
}

function ensureTutorialCopy() {
  const dir = path.join(app.getPath("userData"), "Tutorial");
  fs.mkdirSync(dir, { recursive: true });
  // Keep a local logo next to the copy so ./logo.png resolves on disk
  try {
    fs.copyFileSync(
      path.join(__dirname, "..", "assets", "logo.png"),
      path.join(dir, "logo.png")
    );
  } catch (e) {}
  const dest = path.join(dir, "onboarding.html");
  // Seed on first use, and RESEED when the bundled tutorial is newer (version
  // marker changed). Practice edits are disposable; a stale tutorial that hides
  // new features is worse than losing them.
  const VER = "<!-- ohana-onboarding v3 -->"; // v3: English tutorial — reseed stale Spanish copies
  let seed = !fs.existsSync(dest);
  if (!seed) {
    try { seed = fs.readFileSync(dest, "utf-8").indexOf(VER) === -1; } catch (e) {}
  }
  if (seed) {
    let html = fs.readFileSync(getOnboardingSource(), "utf-8");
    html = html.split("../assets/logo.png").join("logo.png");
    fs.writeFileSync(dest, html, "utf-8");
  }
  return dest;
}

function openOnboarding() {
  loadHTMLFile(ensureTutorialCopy());
}

ipcMain.handle("app:openOnboarding", () => {
  openOnboarding();
  return true;
});

// Unified picker: lets the user choose an .html file OR a folder (repo) in the
// same native dialog. Returns { kind: "file" | "folder" | "invalid", path }.
// For a file it loads it directly (reusing the HTML watcher path); for a folder
// it just returns the path so the renderer can run repo detection.
async function openFileOrFolderDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Open HTML file or folder",
    buttonLabel: "Open",
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    properties: ["openFile", "openDirectory"],
  });
  if (canceled || filePaths.length === 0) return null;
  const p = filePaths[0];
  try {
    if (fs.statSync(p).isDirectory()) return { kind: "folder", path: p };
  } catch (e) {
    return { kind: "invalid", path: p };
  }
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    loadHTMLFile(p);
    return { kind: "file", path: p };
  }
  return { kind: "invalid", path: p };
}

// ─── IPC Handlers ────────────────────────────────────────────────────
ipcMain.handle("dialog:openFileOrFolder", openFileOrFolderDialog);

// Re-point main-process context (active.json, watchers) to the tab the renderer
// just activated, so the comments/design MCP and the terminal cwd follow the
// active tab. File tabs go through file:loadDropped instead (it owns the HTML
// watcher), so this handles url/repo/none.
ipcMain.handle("tab:syncContext", (_, { kind, dir, url, src } = {}) => {
  activeTabSrc = (src !== undefined && src !== null) ? src : (url || dir || null);
  if (kind === "repo") {
    repoDir = dir || null;
    currentFilePath = null;
    newProtoDir = null;
    currentMode = "react";
    if (dir) { watchSourceFiles(dir); watchFindings(); }
  } else if (kind === "url") {
    repoDir = null;
    currentFilePath = null;
    newProtoDir = null;
    currentMode = "html";
    if (sourceWatcher) { sourceWatcher.close(); sourceWatcher = null; }
    watchFindings(); // context is now null → this tears down the previous project's watchers
  } else {
    // kind:"none" → "New prototype": anchor the chosen folder so Moka and the
    // MCP have somewhere to live, even though no .html exists yet.
    repoDir = null;
    currentFilePath = null;
    newProtoDir = dir || null;
    currentMode = "html";
    if (newProtoDir) watchFindings();
  }
  if (url) mainWindow.setTitle(`${url} — Ohana`);
  writeActiveProject();
  return true;
});

// ─── Context files (.md) for the active tab ──────────────────────────
// Lists every markdown file under the tab's directory (recursive, skipping
// heavy/irrelevant folders) so the Context panel can surface what the agent
// in that tab's terminal can read. HTML-only tabs pass their own folder, so
// they only show .md siblings.
const CONTEXT_IGNORE = new Set([
  "node_modules", ".git", ".ohana", "dist", "build", "out",
  ".next", ".nuxt", "coverage", ".cache", ".turbo", "vendor",
]);
ipcMain.handle("context:list", (_, dir) => {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  function walk(d, rel, depth) {
    if (depth > 4 || out.length > 500) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(d, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (!CONTEXT_IGNORE.has(e.name)) walk(abs, r, depth + 1);
      } else if (e.name.toLowerCase().endsWith(".md")) {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch (err) {}
        out.push({ path: abs, rel: r, name: e.name, size });
      }
    }
  }
  walk(dir, "", 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
});
ipcMain.handle("context:read", (_, filePath) => {
  try { return fs.readFileSync(filePath, "utf-8"); } catch (e) { return null; }
});

// ─── Project scan ────────────────────────────────────────────────────
// A project = a folder. This returns everything the left navigator shows,
// grouped: Moka boards (from .ohana/flow.json), prototypes (.html), handoff
// docs, design (design.md), and other markdown. Repos/URLs are NOT projects
// (they're their own special tabs), so this only runs for folder workspaces.
ipcMain.handle("project:scan", (_, dir) => {
  const res = { dir: dir || null, boards: [], prototypes: [], plans: [], handoff: [], design: [], markdown: [] };
  if (!dir || !fs.existsSync(dir)) return res;
  try {
    const fp = path.join(dir, ".ohana", "flow.json");
    if (fs.existsSync(fp)) {
      const doc = JSON.parse(fs.readFileSync(fp, "utf-8"));
      (doc.flows || []).forEach((fl) => res.boards.push({
        id: fl.id, name: fl.name || "Flow",
        board: fl.board === "sitemap" ? "sitemap" : "userflow",
        screens: Array.isArray(fl.screens) ? fl.screens.length : 0,
        src: fl.src || null,
      }));
    }
  } catch (e) {}
  function walk(d, rel, depth) {
    if (depth > 3 || (res.prototypes.length + res.markdown.length) > 800) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith(".") && !CONTEXT_IGNORE.has(e.name)) walk(abs, r, depth + 1); continue; }
      const low = e.name.toLowerCase(), item = { path: abs, rel: r, name: e.name };
      if (low.endsWith(".html") || low.endsWith(".htm")) res.prototypes.push(item);
      else if (low.endsWith(".md")) {
        if (/(^|\/)plan(e?s)?\//i.test(r)) res.plans.push(item);
        else if (/(^|\/)handoff\//i.test(r)) res.handoff.push(item);
        else if (low === "design.md" || /(^|\/)design\//i.test(r)) res.design.push(item);
        else res.markdown.push(item);
      }
    }
  }
  walk(dir, "", 0);
  // .ohana/ is skipped by walk (dotdir); pull handoff docs stored there explicitly.
  const ohHandoff = path.join(dir, ".ohana", "handoff");
  try { if (fs.existsSync(ohHandoff)) fs.readdirSync(ohHandoff).forEach((n) => { if (n.toLowerCase().endsWith(".md")) res.handoff.push({ path: path.join(ohHandoff, n), rel: ".ohana/handoff/" + n, name: n }); }); } catch (e) {}
  const ohPlans = path.join(dir, ".ohana", "plans");
  try { if (fs.existsSync(ohPlans)) fs.readdirSync(ohPlans).forEach((n) => { if (n.toLowerCase().endsWith(".md")) res.plans.push({ path: path.join(ohPlans, n), rel: ".ohana/plans/" + n, name: n }); }); } catch (e) {}
  [res.prototypes, res.plans, res.handoff, res.design, res.markdown].forEach((a) => a.sort((x, y) => x.rel.localeCompare(y.rel)));
  return res;
});
// Scaffold a folder into a project workspace (idempotent, never destructive):
//   prototipos/  planes/  handoff/  design/  +  .ohana/ (flows → .ohana/flow.json)
ipcMain.handle("project:init", (_, dir) => {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    ["prototipos", "planes", "handoff", "design", ".ohana"].forEach((n) => {
      const p = path.join(dir, n);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });
    return true;
  } catch (e) { return false; }
});
ipcMain.handle("project:writeFile", (_, { path: filePath, content } = {}) => {
  try {
    if (!filePath) return false;
    const d = path.dirname(filePath);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(filePath, content != null ? content : "", "utf-8");
    return true;
  } catch (e) { return false; }
});
ipcMain.handle("project:deleteFile", (_, filePath) => {
  try { if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) { fs.unlinkSync(filePath); return true; } } catch (e) {}
  return false;
});
ipcMain.handle("project:renameFile", (_, { path: filePath, newName } = {}) => {
  try {
    if (!filePath || !newName || !fs.existsSync(filePath)) return false;
    const dir = path.dirname(filePath), oldExt = path.extname(filePath);
    let clean = String(newName).replace(/[\/\\]/g, "-").trim();
    if (!clean) return false;
    if (!path.extname(clean)) clean += oldExt; // keep the extension if the user omits it
    const dest = path.join(dir, clean);
    if (fs.existsSync(dest)) return false; // never overwrite silently
    fs.renameSync(filePath, dest);
    return dest;
  } catch (e) { return false; }
});
ipcMain.handle("project:duplicateFile", (_, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const dir = path.dirname(filePath), ext = path.extname(filePath), base = path.basename(filePath, ext);
    let dest = path.join(dir, base + " copia" + ext), i = 2;
    while (fs.existsSync(dest)) { dest = path.join(dir, base + " copia " + i + ext); i++; }
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch (e) { return false; }
});

// ─── Network capture (friendly devtools) ─────────────────────────────
// Attach CDP to EVERY preview webview and keep a separate buffer per
// webContents: each tab owns its own network/console log (tabs keep their
// webviews alive across switches, so a single global debuggee would mix
// tabs' traffic and go blind on switch-back).
const netByWc = new Map(); // wcId -> { requests: Map, console: [], _netT, _conT }
const NET_MAX_REQUESTS = 500;
function netBuffers(wcId) {
  let b = netByWc.get(wcId);
  if (!b) { b = { requests: new Map(), console: [], _netT: null, _conT: null }; netByWc.set(wcId, b); }
  return b;
}
function sendNet(wcId) {
  const b = netBuffers(wcId);
  if (b._netT) return;
  b._netT = setTimeout(() => {
    b._netT = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("net:list", { wcId, list: Array.from(b.requests.values()) });
    }
  }, 180);
}
function sendConsole(wcId) {
  const b = netBuffers(wcId);
  if (b._conT) return;
  b._conT = setTimeout(() => {
    b._conT = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("console:list", { wcId, list: b.console.slice(-200) });
    }
  }, 180);
}
function pushConsole(wcId, level, text) {
  const b = netBuffers(wcId);
  b.console.push({ level, text: String(text || "").slice(0, 2000) });
  if (b.console.length > 300) b.console.splice(0, b.console.length - 300);
  sendConsole(wcId);
}
function consoleArgsText(args) {
  return (args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.unserializableValue || a.type || ""))).join(" ");
}
function attachNet(contents) {
  try {
    const wcId = contents.id;
    netBuffers(wcId);
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    contents.debugger.sendCommand("Network.enable").catch(() => {});
    contents.debugger.sendCommand("Runtime.enable").catch(() => {});
    contents.debugger.sendCommand("Log.enable").catch(() => {});
    contents.debugger.on("message", (_e, method, params) => {
      const b = netBuffers(wcId);
      if (method === "Runtime.consoleAPICalled") {
        if (params.type === "error" || params.type === "assert") pushConsole(wcId, "error", consoleArgsText(params.args));
        else if (params.type === "warning") pushConsole(wcId, "warning", consoleArgsText(params.args));
        return;
      }
      if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails || {};
        pushConsole(wcId, "error", (d.exception && (d.exception.description || d.exception.value)) || d.text || "Uncaught exception");
        return;
      }
      if (method === "Log.entryAdded") {
        const en = params.entry || {};
        if (en.level === "error" || en.level === "warning") pushConsole(wcId, en.level, en.text || "");
        return;
      }
      if (method === "Network.requestWillBeSent") {
        if (b.requests.size >= NET_MAX_REQUESTS) { // cap long-running tabs (polling apps)
          const oldest = b.requests.keys().next().value;
          if (oldest !== undefined) b.requests.delete(oldest);
        }
        b.requests.set(params.requestId, {
          requestId: params.requestId, url: params.request.url, method: params.request.method,
          type: params.type || "", status: null, mimeType: "", size: 0, failed: null,
        });
      } else if (method === "Network.responseReceived") {
        const r = b.requests.get(params.requestId);
        if (r) { r.status = params.response.status; r.mimeType = params.response.mimeType; if (params.type) r.type = params.type; }
        sendNet(wcId);
      } else if (method === "Network.loadingFinished") {
        const r = b.requests.get(params.requestId);
        if (r && params.encodedDataLength) r.size = params.encodedDataLength;
        sendNet(wcId);
      } else if (method === "Network.loadingFailed") {
        const r = b.requests.get(params.requestId);
        if (r) { r.status = -1; r.failed = params.errorText || "failed"; }
        sendNet(wcId);
      }
    });
    contents.on("destroyed", () => { netByWc.delete(wcId); });
  } catch (e) {}
}
app.on("web-contents-created", (_e, contents) => {
  try { if (contents.getType() === "webview") attachNet(contents); } catch (e) {}
  // Security posture for embedded content: popups never open windows — an
  // http(s) target becomes a URL tab in Ohana; anything else is denied.
  try {
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("url:openTab", url);
        return { action: "deny" };
      });
    }
  } catch (e) {}
});
// Block silent downloads from previewed content (prototypes/localhost/URLs
// have no business writing files to disk through Ohana).
app.whenReady().then(() => {
  try {
    session.fromPartition("persist:viewer").on("will-download", (e, item) => {
      e.preventDefault();
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("toast:show", "Download blocked: " + (item.getFilename() || "file")); } catch (err) {}
    });
  } catch (e) {}
});
ipcMain.handle("net:getBody", async (_e, data) => {
  const { wcId, requestId } = data || {};
  const wc = wcId ? webContents.fromId(wcId) : null;
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) return null;
  try { return await wc.debugger.sendCommand("Network.getResponseBody", { requestId }); }
  catch (e) { return null; }
});
ipcMain.handle("net:clear", (_e, wcId) => {
  const b = netBuffers(wcId);
  b.requests.clear(); b.console.length = 0;
  sendNet(wcId); sendConsole(wcId);
  return true;
});
ipcMain.handle("cache:clear", async () => {
  try {
    const vs = session.fromPartition("persist:viewer");
    await vs.clearCache();
    await vs.clearStorageData({ storages: ["cookies", "localstorage", "caches", "indexdb", "serviceworkers"] });
    return true;
  } catch (e) { return false; }
});

// ─── Design-system component metadata ────────────────────────────────
// ─── Component catalog — pluggable, design-system agnostic ───────────
// Ohana doesn't know about any specific design system. components:read resolves
// the catalog through a CHAIN of adapters and normalizes everything to ONE shape
// the UI consumes:
//   { name, use?, import?, props:[{name,label?,options:[...]}], antiPatterns:[...], match? }
// Order: explicit config override → project components.json → mcp-context
// (any package that ships it) → Storybook static index → folder scan. No
// design system is special-cased — drop a .ohana/config.json or a
// components.json and any repo works.
let _compCache = { dir: null, result: null };

function readJSONSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch (e) { return null; } }

// mcp-context: an index + components/*.json with examples whose args
// encode the variant dimensions (variant/size/shape/…).
function adaptMcpContext(indexPath) {
  const index = readJSONSafe(indexPath);
  if (!index || !Array.isArray(index.components)) return null;
  const baseDir = path.dirname(indexPath);
  // Props that are free text, not variant dimensions — never treat as options.
  const DENY = new Set([
    "children", "className", "class", "style", "ref", "id", "key", "asChild",
    "placeholder", "name", "label", "title", "value", "defaultValue", "text",
    "alt", "href", "src", "description", "content", "htmlFor", "aria-label",
  ]);
  // A variant option is an enum-like token: no spaces/punctuation, short.
  const isToken = (v) => /^[a-z0-9][a-z0-9_-]{0,18}$/i.test(v);
  const out = [];
  for (const entry of index.components) {
    const c = readJSONSafe(path.join(baseDir, entry.file || ("components/" + entry.name + ".json"))) || {};
    const propMap = {};
    (c.examples || []).forEach((ex) => {
      const args = ex.args || {};
      Object.keys(args).forEach((k) => {
        if (DENY.has(k) || /^on[A-Z]/.test(k)) return;
        let v = args[k];
        if (typeof v !== "string") return;
        v = v.replace(/^"|"$/g, "");
        if (!v || v === "true" || v === "false" || !isToken(v)) return;
        (propMap[k] = propMap[k] || new Set()).add(v);
      });
    });
    const props = Object.keys(propMap)
      .map((k) => ({ name: k, options: Array.from(propMap[k]) }))
      .filter((p) => p.options.length > 1 || p.name === "variant");
    // Also surface prop NAMES declared on the component (variant/size/shape…)
    // even when their option values aren't published in the examples — useful
    // to know a prop exists and to hand it to the agent.
    const known = new Set(props.map((p) => p.name));
    (c.components || []).forEach((comp) => {
      (comp.props || []).forEach((pn) => {
        if (typeof pn !== "string") return;
        if (known.has(pn) || DENY.has(pn) || pn.startsWith("...") || /^on[A-Z]/.test(pn)) return;
        known.add(pn); props.push({ name: pn, options: [] });
      });
    });
    out.push({
      name: entry.displayName || c.displayName || entry.name,
      use: (entry.description || c.description || "").split("\n")[0].slice(0, 240),
      import: (entry.imports && entry.imports.individual) || (c.imports && c.imports.individual) || null,
      props,
      antiPatterns: Array.isArray(c.antiPatterns) ? c.antiPatterns : [],
    });
  }
  return out.length ? out : null;
}

// Storybook static index (index.json / stories.json) — generic across DSs.
function adaptStorybook(indexPath) {
  const idx = readJSONSafe(indexPath);
  if (!idx) return null;
  const entries = idx.entries || idx.stories;
  if (!entries || typeof entries !== "object") return null;
  const byTitle = {};
  Object.keys(entries).forEach((id) => {
    const e = entries[id];
    if (e.type && e.type !== "story") return;
    const title = e.title; if (!title) return;
    (byTitle[title] = byTitle[title] || []).push(e.name || id);
  });
  const out = Object.keys(byTitle).map((title) => ({
    name: title.split("/").pop(),
    use: title,
    props: byTitle[title].length > 1 ? [{ name: "story", label: "Variantes", options: byTitle[title] }] : [],
    antiPatterns: [],
  }));
  return out.length ? out : null;
}

// Last resort: list component files in a conventional folder (names only).
function adaptFolderScan(dir) {
  const CANDS = ["src/components", "components", "src/ui", "app/components", "packages/ui/src", "lib/components", "ui"];
  for (const rel of CANDS) {
    const base = path.join(dir, rel);
    if (!fs.existsSync(base)) continue;
    const names = new Set();
    const walk = (d, depth) => {
      if (depth > 3) return;
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.name.startsWith(".") || en.name === "node_modules") continue;
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full, depth + 1);
        else if (/\.(tsx|jsx|vue|svelte)$/.test(en.name)) {
          const n = en.name.replace(/\.(tsx|jsx|vue|svelte)$/, "");
          if (/^[A-Z]/.test(n) && !/\.(stories|test|spec|d)$/.test(n)) names.add(n);
        }
      }
    };
    walk(base, 0);
    if (names.size) return Array.from(names).sort().map((n) => ({ name: n, props: [], antiPatterns: [] }));
  }
  return null;
}

// Find an mcp-context index in node_modules (any package that ships it — not
// hardcoded to a vendor) via a bounded scan.
function findMcpContext(dir) {
  // The dir might BE a design-system package (you pointed straight at it).
  for (const rel of [["dist", "mcp-context"], ["mcp-context"]]) {
    const p = path.join(dir, ...rel, "mcp-components-index.json");
    if (fs.existsSync(p)) return p;
  }
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) return null;
  let budget = 400;
  let tops = []; try { tops = fs.readdirSync(nm, { withFileTypes: true }); } catch (e) { return null; }
  for (const ent of tops) {
    if (budget-- <= 0) break;
    if (!ent.isDirectory()) continue;
    const pkgs = [];
    if (ent.name.startsWith("@")) {
      try { for (const s of fs.readdirSync(path.join(nm, ent.name))) pkgs.push(path.join(nm, ent.name, s)); } catch (e) {}
    } else { pkgs.push(path.join(nm, ent.name)); }
    for (const p of pkgs) {
      if (budget-- <= 0) break;
      const idx = path.join(p, "dist", "mcp-context", "mcp-components-index.json");
      if (fs.existsSync(idx)) return idx;
    }
  }
  return null;
}

// Generic DS opt-in: a package declares its catalog in package.json:
//   "ohana": { "components": "./dist/ohana-catalog.json", "css": "./dist/styles.css" }
// The catalog file is the normalized array, or { css?, components:[...] }. This
// lets ANY design system (KolasoSD, etc.) be richly detected by adding one field.
function loadOhanaCatalogFromPkg(pkgDir) {
  const pj = readJSONSafe(path.join(pkgDir, "package.json"));
  if (!pj || !pj.ohana || !pj.ohana.components) return null;
  const data = readJSONSafe(path.join(pkgDir, pj.ohana.components));
  if (!data) return null;
  const components = Array.isArray(data) ? data : (Array.isArray(data.components) ? data.components : null);
  if (!components || !components.length || !components[0] || !components[0].name) return null;
  const resolveAsset = (v) => v ? (/^(https?:|file:)/.test(v) ? v : "file://" + path.join(pkgDir, v)) : null;
  const css = resolveAsset((!Array.isArray(data) && data.css) || pj.ohana.css);
  return { components, css };
}

function findOhanaCatalog(dir) {
  const self = loadOhanaCatalogFromPkg(dir); // dir IS the DS package
  if (self) return self;
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) return null;
  let budget = 400, tops = [];
  try { tops = fs.readdirSync(nm, { withFileTypes: true }); } catch (e) { return null; }
  for (const ent of tops) {
    if (budget-- <= 0) break;
    if (!ent.isDirectory()) continue;
    const pkgs = [];
    if (ent.name.startsWith("@")) {
      try { for (const s of fs.readdirSync(path.join(nm, ent.name))) pkgs.push(path.join(nm, ent.name, s)); } catch (e) {}
    } else { pkgs.push(path.join(nm, ent.name)); }
    for (const p of pkgs) { if (budget-- <= 0) break; const r = loadOhanaCatalogFromPkg(p); if (r) return r; }
  }
  return null;
}

// Resolve an explicit source path (file or dir) by auto-detecting its format.
function adaptAnyPath(src) {
  try {
    if (!fs.existsSync(src)) return null;
    const st = fs.statSync(src);
    if (st.isFile()) {
      const data = readJSONSafe(src);
      if (!data) return null;
      if (Array.isArray(data) && data[0] && data[0].name) return data;            // normalized
      if (Array.isArray(data.components) && data.components[0] && data.components[0].file) return adaptMcpContext(src); // mcp index
      if (data.entries || data.stories) return adaptStorybook(src);               // storybook
      if (Array.isArray(data.components)) return data.components;                 // normalized wrapper
      return null;
    }
    if (st.isDirectory()) {
      const mcp = path.join(src, "mcp-components-index.json");
      if (fs.existsSync(mcp)) return adaptMcpContext(mcp);
      const sb = path.join(src, "index.json");
      if (fs.existsSync(sb)) return adaptStorybook(sb);
      return adaptFolderScan(src);
    }
  } catch (e) {}
  return null;
}

function resolveComponentCatalog(dir) {
  if (!dir) return { source: "none", components: [] };

  // 1. Explicit override: .ohana/config.json { "componentsSource": "<path>" }
  const cfg = readJSONSafe(path.join(dir, ".ohana", "config.json"));
  if (cfg && cfg.componentsSource) {
    const src = path.isAbsolute(cfg.componentsSource) ? cfg.componentsSource : path.join(dir, cfg.componentsSource);
    const r = adaptAnyPath(src);
    if (r && r.length) return { source: "config", components: r };
  }

  // 2. Project components.json (already normalized — universal escape hatch)
  const projJson = path.join(dir, "components.json");
  if (fs.existsSync(projJson)) {
    const data = readJSONSafe(projJson);
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.components) ? data.components : null);
    if (arr && arr.length && arr[0] && arr[0].name && !arr[0].file) return { source: "components.json", components: arr };
  }

  // 3. Generic DS opt-in via package.json "ohana.components" (self or node_modules)
  const ds = findOhanaCatalog(dir);
  if (ds) return { source: "ohana-field", components: ds.components, css: ds.css || null };

  // 4. mcp-context in node_modules (any package that ships it)
  const mcp = findMcpContext(dir);
  if (mcp) { const r = adaptMcpContext(mcp); if (r) return { source: "mcp-context", components: r }; }

  // 5. Storybook static index
  for (const rel of ["storybook-static/index.json", "storybook-static/stories.json", "public/index.json"]) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { const r = adaptStorybook(p); if (r) return { source: "storybook", components: r }; }
  }

  // 6. Folder scan fallback
  const scan = adaptFolderScan(dir);
  if (scan) return { source: "folder", components: scan };

  return { source: "none", components: [] };
}

// Drives the components panel AND the inspector's component-aware mode.
// opts.dir lets a tab point at an explicit project folder (e.g. a localhost
// URL tab whose repo dir Ohana can't infer); falls back to the active project.
ipcMain.handle("components:read", (_, opts) => {
  let dir = (opts && opts.dir) || getProjectDir();
  if (dir && !fs.existsSync(dir)) dir = getProjectDir();
  if (!dir) return { source: "none", components: [] };
  if (!(opts && opts.force) && _compCache.dir === dir && _compCache.result) return _compCache.result;
  let result;
  try { result = resolveComponentCatalog(dir); } catch (e) { result = { source: "none", components: [] }; }
  // A project can pin its Storybook for previews via .ohana/config.json.
  try { const cfg = readJSONSafe(path.join(dir, ".ohana", "config.json")); if (cfg && cfg.storybookUrl) result.storybookUrl = cfg.storybookUrl; } catch (e) {}
  _compCache = { dir, result };
  return result;
});

// Fetch a Storybook static index and return a component→stories map, so the
// panel can embed real story previews. Generic: works with any Storybook URL
// (a local `npm run storybook` on :6006, a hosted one, etc.).
ipcMain.handle("storybook:index", async (_, base) => {
  if (!base) return { ok: false };
  base = String(base).trim();
  if (!/^https?:\/\//i.test(base)) base = "http://" + base;
  base = base.replace(/\/+$/, "");
  for (const f of ["/index.json", "/stories.json"]) {
    try {
      const r = await fetch(base + f);
      if (!r.ok) continue;
      const data = await r.json();
      const entries = data.entries || data.stories;
      if (!entries || typeof entries !== "object") continue;
      const map = {};
      Object.keys(entries).forEach((id) => {
        const e = entries[id];
        if (e.type && e.type !== "story") return;
        const title = e.title || ""; if (!title) return;
        const key = title.split("/").pop().toLowerCase().replace(/[\s_-]+/g, "");
        (map[key] = map[key] || []).push({ id: e.id || id, name: e.name || "" });
      });
      if (Object.keys(map).length) return { ok: true, base, map };
    } catch (e) {}
  }
  return { ok: false };
});

// Folder-only picker (for pointing the components panel at a repo on disk).
ipcMain.handle("dialog:pickFolder", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Choose the project / design system folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle("file:loadDropped", (_, filePath) => {
  // Validate it's an HTML file
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    loadHTMLFile(filePath);
    return true;
  }
  return false;
});

ipcMain.handle("clipboard:copyText", (_, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("clipboard:copyImage", (_, dataURL) => {
  const img = nativeImage.createFromDataURL(dataURL);
  clipboard.writeImage(img);
  return true;
});

ipcMain.handle("file:getHTML", () => {
  if (!currentFilePath) return null;
  try {
    return fs.readFileSync(currentFilePath, "utf-8");
  } catch (e) {
    return null;
  }
});

// ─── .ohana/ Directory Operations ────────────────────────────────────
function getOhanaDir() {
  // Repo mode: .ohana/ in repo root
  if (repoDir) {
    const ohanaDir = path.join(repoDir, ".ohana");
    if (!fs.existsSync(ohanaDir)) fs.mkdirSync(ohanaDir, { recursive: true });
    return ohanaDir;
  }
  // File mode: .ohana/ in same directory as the HTML file
  const base = currentFilePath ? path.dirname(currentFilePath) : newProtoDir;
  if (!base) return null;
  const ohanaDir = path.join(base, ".ohana");
  if (!fs.existsSync(ohanaDir)) fs.mkdirSync(ohanaDir, { recursive: true });
  return ohanaDir;
}

// ─── Active project pointer ──────────────────────────────────────────
// Writes the currently-open prototype to ~/.ohana/active.json so external
// tools (the ohana-comments MCP server, skills) know which .ohana/ to target.
function getProjectDir() {
  return repoDir || (currentFilePath ? path.dirname(currentFilePath) : null) || newProtoDir;
}

function getDesignFile() {
  const dir = getProjectDir();
  return dir ? path.join(dir, "design.md") : null;
}

function writeActiveProject() {
  try {
    const globalDir = path.join(os.homedir(), ".ohana");
    if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
    const ohanaDir = getOhanaDir();
    const data = {
      projectDir: getProjectDir(),
      currentFile: currentFilePath,
      src: activeTabSrc,
      ohanaDir: ohanaDir,
      findingsFile: ohanaDir ? path.join(ohanaDir, "findings.json") : null,
      designFile: getDesignFile(),
      mode: currentMode,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(globalDir, "active.json"), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    // non-fatal
  }
}

// ─── Session persistence ─────────────────────────────────────────────
// Reopen exactly where the user left off: tabs, the active one, and toolbar
// position. Saved by the renderer on every change; validated here on launch so
// we never restore a file/repo that no longer exists.
function getSessionFile() {
  return path.join(os.homedir(), ".ohana", "session.json");
}

ipcMain.handle("session:save", (_, state) => {
  try {
    const dir = path.join(os.homedir(), ".ohana");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getSessionFile(), JSON.stringify(state || {}, null, 2), "utf-8");
  } catch (e) {}
  return true;
});

// Native OS notification (used when Claude replies/resolves while Ohana is in
// the background). Clicking it brings Ohana forward.
ipcMain.handle("notify:show", (_, { title, body } = {}) => {
  try {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: title || "Ohana", body: body || "", silent: false });
    n.on("click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  } catch (e) {}
  return true;
});

function restoreSession() {
  try {
    const f = getSessionFile();
    if (!fs.existsSync(f)) return;
    const s = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (!s || !Array.isArray(s.tabs)) return;
    const tabs = s.tabs.filter((t) => {
      if (!t || !t.kind || !t.src) return false;
      if (t.kind === "file") return fs.existsSync(t.src);
      if (t.kind === "repo") return t.dir && fs.existsSync(t.dir);
      return true; // url tabs always survive
    });
    if (!tabs.length) return;
    mainWindow.webContents.send("session:restore", {
      tabs,
      activeKey: s.activeKey,
      toolbarPos: s.toolbarPos,
    });
  } catch (e) {}
}

// ─── Repo Mode ──────────────────────────────────────────────────────
function detectRepoInfo(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const scripts = pkg.scripts || {};
    // Find the dev script (priority: dev > start > serve)
    let devScript = null;
    if (scripts.dev) devScript = "dev";
    else if (scripts.start) devScript = "start";
    else if (scripts.serve) devScript = "serve";

    // Detect framework
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    let framework = "unknown";
    if (deps["@rsbuild/core"]) framework = "rsbuild";
    else if (deps["next"]) framework = "next";
    else if (deps["vite"] || deps["@vitejs/plugin-react"]) framework = "vite";
    else if (deps["react-scripts"]) framework = "cra";
    else if (deps["nuxt"]) framework = "nuxt";
    else if (deps["@angular/core"]) framework = "angular";
    else if (deps["vue"]) framework = "vue";

    // Detect if React project
    const isReact = !!(deps["react"] || deps["react-dom"]);

    // Detect configured port from config files
    const port = detectDevPort(dir, framework);

    // Package manager from lockfile
    const pkgManager = fs.existsSync(path.join(dir, "pnpm-lock.yaml"))
      ? "pnpm"
      : fs.existsSync(path.join(dir, "yarn.lock"))
      ? "yarn"
      : "npm";

    return {
      name: pkg.name || path.basename(dir),
      devScript,
      framework,
      isReact,
      port,
      scripts: Object.keys(scripts),
      pkgManager,
      hasNodeModules: fs.existsSync(path.join(dir, "node_modules")),
    };
  } catch (e) {
    return null;
  }
}

function detectDevPort(dir, framework) {
  // Try rsbuild.config.ts / rsbuild.config.js
  for (const ext of [".ts", ".js", ".mjs"]) {
    const configPath = path.join(dir, "rsbuild.config" + ext);
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const portMatch = content.match(/port\s*:\s*(\d+)/);
        if (portMatch) return parseInt(portMatch[1]);
      } catch (e) {}
    }
  }
  // Try vite.config.ts / vite.config.js
  for (const ext of [".ts", ".js", ".mjs"]) {
    const configPath = path.join(dir, "vite.config" + ext);
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const portMatch = content.match(/port\s*:\s*(\d+)/);
        if (portMatch) return parseInt(portMatch[1]);
      } catch (e) {}
    }
  }
  // Framework defaults
  if (framework === "rsbuild") return 3000;
  if (framework === "vite") return 5173;
  if (framework === "next") return 3000;
  if (framework === "cra") return 3000;
  return 3000;
}

// ─── Source File Watcher (React/Repo mode) ────────────────────────
function watchSourceFiles(dir) {
  if (sourceWatcher) sourceWatcher.close();
  const srcDir = path.join(dir, "src");
  if (!fs.existsSync(srcDir)) return;

  sourceWatcher = chokidar.watch(srcDir, {
    persistent: true,
    ignoreInitial: true,
    ignored: /(^|[\/\\])\.|node_modules|\.test\.|\.spec\.|__tests__/,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
  });
  sourceWatcher.on("change", (changedPath) => {
    const ext = path.extname(changedPath).toLowerCase();
    if ([".tsx", ".ts", ".jsx", ".js", ".css", ".scss", ".less", ".module.css", ".module.scss"].includes(ext)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("repo:sourceChanged", {
          changedFile: changedPath,
          filename: path.basename(changedPath),
          ext: ext,
        });
      }
    }
  });
}

function startDevServer(dir, command, preferredUrl) {
  return new Promise((resolve, reject) => {
    if (devServerProcess) {
      devServerProcess.kill();
      devServerProcess = null;
    }

    // `command` is a full shell command line (e.g. "npm run storybook").
    const proc = spawn(command, {
      cwd: dir,
      shell: true,
      env: { ...process.env, BROWSER: "none", FORCE_COLOR: "1" },
    });

    devServerProcess = proc;
    let urlFound = false;
    let output = "";

    const onData = (data) => {
      const text = data.toString();
      output += text;
      if (urlFound) return;
      // Detect full URL with port (https or http)
      const urlMatch = text.match(/https?:\/\/localhost:\d{3,5}/);
      if (urlMatch) {
        urlFound = true;
        resolve(urlMatch[0]);
        return;
      }
      // Detect "Local: https://..." pattern (Vite/Rsbuild)
      const localMatch = text.match(/Local:\s*(https?:\/\/[^\s]+)/);
      if (localMatch) {
        urlFound = true;
        resolve(localMatch[1]);
        return;
      }
      // Detect port-only patterns
      const portMatch = text.match(/port\s+(\d{4,5})/i);
      if (portMatch) {
        urlFound = true;
        resolve("http://localhost:" + portMatch[1]);
        return;
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      if (!urlFound) reject(err);
    });

    proc.on("exit", (code) => {
      if (!urlFound) reject(new Error(code === 127
        ? "Couldn't find the command to start the dev server (exit 127) — is the repo's package manager installed (npm/yarn/pnpm)?"
        : "Dev server exited with code " + code));
      devServerProcess = null;
    });

    // Fallback: if we never parsed a URL from output, use the one the user
    // specified (or a default). Shorter wait when we already have a guess.
    setTimeout(() => {
      if (!urlFound) {
        urlFound = true;
        resolve(preferredUrl || "http://localhost:3000");
      }
    }, preferredUrl ? 12000 : 30000);
  });
}

// Git state for the navigator's footer card (VS Code-style): branch, ahead/
// behind the upstream, and count of local pending changes. No network — counts
// are against the last-fetched upstream, like VS Code's status bar.
ipcMain.handle("git:status", async (_, dir) => {
  const run = (args) => new Promise((res) => {
    let out = "";
    const p = spawn("git", args, { cwd: dir });
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", () => res(null));
    p.on("close", (code) => res(code === 0 ? out.trim() : null));
  });
  try {
    if (!dir || !fs.existsSync(dir)) return { git: false };
    if ((await run(["rev-parse", "--is-inside-work-tree"])) !== "true") return { git: false };
    const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
    const porcelain = await run(["status", "--porcelain"]);
    const lines = porcelain ? porcelain.split("\n").filter(Boolean) : [];
    // XY path — untracked (??) surfaces as U; renames keep the new path.
    const files = lines.slice(0, 50).map((l) => {
      const st = l.slice(0, 2).trim();
      let p = l.slice(3);
      if (st[0] === "R" && p.includes(" -> ")) p = p.split(" -> ")[1];
      return { st: st === "??" ? "U" : (st[0] || st[1] || "M"), path: p };
    });
    // left-right against @{upstream}: left = commits to pull, right = to push.
    const counts = await run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    let behind = 0, ahead = 0, upstream = false, upstreamName = null;
    if (counts != null) {
      upstream = true;
      upstreamName = await run(["rev-parse", "--abbrev-ref", "@{upstream}"]);
      const m = counts.split(/\s+/);
      behind = parseInt(m[0], 10) || 0;
      ahead = parseInt(m[1], 10) || 0;
    }
    return { git: true, branch, changes: lines.length, ahead, behind, upstream, upstreamName, files };
  } catch (e) { return { git: false }; }
});

ipcMain.handle("repo:detect", (_, dir) => detectRepoInfo(dir));

ipcMain.handle("repo:start", async (_, { dir, command, url, script }) => {
  try {
    repoDir = dir;
    currentMode = "react";
    // Prefer an explicit command; else build one from the package manager + script.
    let cmd = command;
    if (!cmd) {
      const info = detectRepoInfo(dir);
      const pm = info ? info.pkgManager : "npm";
      cmd = pm === "npm" ? "npm run " + script : pm + " " + script;
    }
    const resolvedUrl = await startDevServer(dir, cmd, url);
    if (!mainWindow || mainWindow.isDestroyed()) return { error: "window closed" };
    newProtoDir = null;
    activeTabSrc = resolvedUrl; // renderer owns repo flows by their URL (tab.src)
    mainWindow.setTitle(`${path.basename(dir)} (repo) — Ohana`);
    mainWindow.webContents.send("repo:ready", { url: resolvedUrl, dir });
    watchSourceFiles(dir);
    watchFindings();
    writeActiveProject();
    return { url: resolvedUrl, command: cmd };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("repo:stop", () => {
  if (devServerProcess) {
    devServerProcess.kill();
    devServerProcess = null;
  }
  if (sourceWatcher) {
    sourceWatcher.close();
    sourceWatcher = null;
  }
  repoDir = null;
  currentMode = "html";
  return true;
});

// Connect to an already-running dev server (no process spawn)
ipcMain.handle("repo:connectExisting", async (_, { dir, url }) => {
  repoDir = dir;
  newProtoDir = null;
  activeTabSrc = url; // renderer owns repo flows by their URL (tab.src)
  currentMode = "react";
  if (!mainWindow || mainWindow.isDestroyed()) return { error: "window closed" };
  mainWindow.setTitle(`${path.basename(dir)} (repo) — Ohana`);
  watchSourceFiles(dir);
  watchFindings();
  writeActiveProject();
  return true;
});

ipcMain.handle("ohana:writeFile", (_, { filename, content }) => {
  const ohanaDir = getOhanaDir();
  if (!ohanaDir) return false;
  const filePath = path.join(ohanaDir, filename);
  // Create subdirectories if needed (e.g. snapshots/, screenshots/)
  const subDir = path.dirname(filePath);
  if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
  // Handle base64 image data
  if (content.startsWith("__base64__")) {
    fs.writeFileSync(filePath, content.slice(10), "base64");
  } else {
    fs.writeFileSync(filePath, content, "utf-8");
  }
  return filePath;
});

ipcMain.handle("ohana:readFile", (_, filename) => {
  const ohanaDir = getOhanaDir();
  if (!ohanaDir) return null;
  const filePath = path.join(ohanaDir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return null;
  }
});

// Global ~/.ohana/<filename> — user-level data shared across all projects
// (e.g. components.json: the personal component library).
ipcMain.handle("ohana:readGlobal", (_, filename) => {
  try {
    const fp = path.join(os.homedir(), ".ohana", filename);
    return fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : null;
  } catch (e) { return null; }
});
ipcMain.handle("ohana:writeGlobal", (_, { filename, content }) => {
  try {
    const dir = path.join(os.homedir(), ".ohana");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    return true;
  } catch (e) { return false; }
});

// System username — used as the default comment author
ipcMain.handle("app:getUsername", () => {
  try {
    return os.userInfo().username || null;
  } catch (e) {
    return null;
  }
});

// ─── design.md operations ────────────────────────────────────────────
// design.md is the design source of truth, kept NEXT TO the prototype
// (project root), edited from Ohana and maintained by Claude.
function designTemplate(name) {
  const today = new Date().toISOString().slice(0, 10);
  return `# Design — ${name}

> Source of truth for this prototype's design. Ohana and Claude read it to keep
> things consistent. Keep it short and actionable.

## Principles
-

## Tokens

### Color
| Token | Value | Usage |
|-------|-------|-------|
|       |       |       |

### Typography
- Display:
- Body:

### Spacing & radius
-

## Voice & tone
-

## Component patterns
-

## Decisions
- ${today} —
`;
}

ipcMain.handle("design:read", () => {
  const f = getDesignFile();
  if (!f) return { exists: false, path: null, content: "" };
  if (!fs.existsSync(f)) return { exists: false, path: f, content: "" };
  try {
    return { exists: true, path: f, content: fs.readFileSync(f, "utf-8") };
  } catch (e) {
    return { exists: false, path: f, content: "" };
  }
});

ipcMain.handle("design:write", (_, content) => {
  const f = getDesignFile();
  if (!f) return false;
  try {
    fs.writeFileSync(f, content, "utf-8");
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle("design:create", () => {
  const f = getDesignFile();
  if (!f) return null;
  try {
    if (!fs.existsSync(f)) {
      const name = path.basename(getProjectDir() || "Prototype");
      fs.writeFileSync(f, designTemplate(name), "utf-8");
    }
    return fs.readFileSync(f, "utf-8");
  } catch (e) {
    return null;
  }
});

// Watch .ohana/findings.json and commands.json for external changes
let findingsWatcher = null;
let commandsWatcher = null;
let designWatcher = null;
let flowWatcher = null;
let projectWatcher = null;
let _projChangedT = null;
function watchFindings() {
  if (findingsWatcher) { findingsWatcher.close(); findingsWatcher = null; }
  if (commandsWatcher) { commandsWatcher.close(); commandsWatcher = null; }
  // Close these BEFORE the null-context return too: a url tab has no .ohana,
  // and stale watchers from the previous project would keep firing its events.
  if (flowWatcher) { flowWatcher.close(); flowWatcher = null; }
  if (designWatcher) { designWatcher.close(); designWatcher = null; }
  if (projectWatcher) { projectWatcher.close(); projectWatcher = null; }
  const ohanaDir = getOhanaDir();
  if (!ohanaDir) return;

  // Watch findings.json
  const findingsPath = path.join(ohanaDir, "findings.json");
  if (!fs.existsSync(findingsPath)) {
    fs.writeFileSync(findingsPath, "[]", "utf-8");
  }
  findingsWatcher = chokidar.watch(findingsPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  findingsWatcher.on("change", () => {
    try {
      const content = fs.readFileSync(findingsPath, "utf-8");
      mainWindow.webContents.send("ohana:findingsUpdated", content);
    } catch (e) {}
  });

  // Watch commands.json — Claude writes commands, Ohana executes
  const commandsPath = path.join(ohanaDir, "commands.json");
  if (!fs.existsSync(commandsPath)) {
    fs.writeFileSync(commandsPath, "[]", "utf-8");
  }
  commandsWatcher = chokidar.watch(commandsPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  commandsWatcher.on("change", () => {
    mainWindow.webContents.send("ohana:commandsUpdated");
  });

  // Watch flow.json — Flow mode (layout); Claude or the user edits it,
  // Ohana auto-reloads the canvas.
  if (flowWatcher) flowWatcher.close();
  const flowPath = path.join(ohanaDir, "flow.json");
  flowWatcher = chokidar.watch(flowPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 60 },
  });
  flowWatcher.on("all", () => {
    try {
      const content = fs.existsSync(flowPath) ? fs.readFileSync(flowPath, "utf-8") : "";
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("flow:updated", content);
    } catch (e) {}
  });

  // Watch the project tree so the navigator stays live: added/removed prototypes
  // (.html) and docs (.md) anywhere in the project, plus the agent-written docs
  // in .ohana/handoff and .ohana/plans (the scan lists those explicitly). Only
  // add/unlink matter — content changes don't alter the navigator's lists.
  const projDir = path.dirname(ohanaDir);
  const projPing = () => {
    if (_projChangedT) return;
    _projChangedT = setTimeout(() => {
      _projChangedT = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("project:changed");
    }, 250);
  };
  projectWatcher = chokidar.watch(projDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 3, // mirror project:scan's walk depth
    ignored: (p) => {
      const rel = path.relative(projDir, p);
      if (!rel || rel.startsWith("..")) return false;
      const parts = rel.split(path.sep);
      // Descend into .ohana only for handoff/ and plans/ (flow.json has its own watcher).
      if (parts[0] === ".ohana") return !(parts.length === 1 || parts[1] === "handoff" || parts[1] === "plans");
      return parts.some((s) => s.startsWith(".") || s === "node_modules");
    },
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 60 },
  });
  const projRelevant = (p) => /\.(html?|md)$/i.test(p);
  projectWatcher.on("add", (p) => { if (projRelevant(p)) projPing(); });
  projectWatcher.on("unlink", (p) => { if (projRelevant(p)) projPing(); });
  projectWatcher.on("unlinkDir", projPing);

  // Watch design.md (next to the prototype) for external edits (e.g. Claude)
  if (designWatcher) designWatcher.close();
  const designPath = getDesignFile();
  if (designPath) {
    designWatcher = chokidar.watch(designPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    designWatcher.on("all", () => {
      try {
        const content = fs.existsSync(designPath)
          ? fs.readFileSync(designPath, "utf-8")
          : "";
        mainWindow.webContents.send("design:updated", content);
      } catch (e) {}
    });
  }
}

ipcMain.handle("shell:openExternal", (_, url) => {
  shell.openExternal(url);
});

// ─── Embedded terminals (node-pty) — one PTY per tab ─────────────────
// Each open tab gets its own shell, spawned in that tab's directory, so the
// agent in tab A is independent from tab B. Keyed by the renderer's tabKey.
const ptyProcs = new Map(); // tabKey -> ptyProc

function killPty(key) {
  const proc = ptyProcs.get(key);
  if (proc) { clearTimeout(proc._busyTimer); try { proc.kill(); } catch (e) {} ptyProcs.delete(key); }
}

ipcMain.handle("term:start", (_, { cols, rows, tabKey, cwd, file } = {}) => {
  try {
    const ptyLib = require("node-pty");
    const key = tabKey || "__default__";
    killPty(key); // restart cleanly if one already exists for this tab
    const shell = process.env.SHELL || "/bin/zsh";
    // Use the tab's own dir verbatim. Do NOT fall back to getProjectDir() — that
    // is a global tied to the last-activated tab, which would make every tab
    // without its own dir (e.g. URL tabs) share the same cwd.
    const startCwd = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
    // For a prototype file tab, expose which file this shell is about so the
    // agent can target it even when siblings share the folder.
    const env = Object.assign({}, process.env);
    if (file && fs.existsSync(file)) { env.OHANA_FILE = file; env.OHANA_FILE_NAME = path.basename(file); }
    else { delete env.OHANA_FILE; delete env.OHANA_FILE_NAME; }
    // Always advertise full color support. xterm.js renders truecolor, but the
    // launch context decides what the shell inherits: from Finder COLORTERM is
    // unset and programs fall back to a dim 16-color palette.
    env.COLORTERM = "truecolor";
    const proc = ptyLib.spawn(shell, [], {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: startCwd,
      env: env,
    });
    proc.onData((data) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("term:data", { tabKey: key, data });
      // Activity heartbeat → the tab pulses while its agent/shell is producing
      // output, and goes quiet ~1.2s after the last byte.
      if (!proc._busy) { proc._busy = true; mainWindow.webContents.send("term:activity", { tabKey: key, active: true }); }
      clearTimeout(proc._busyTimer);
      proc._busyTimer = setTimeout(() => {
        proc._busy = false;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("term:activity", { tabKey: key, active: false });
      }, 1200);
    });
    proc.onExit(() => {
      clearTimeout(proc._busyTimer);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("term:exit", { tabKey: key });
      ptyProcs.delete(key);
    });
    ptyProcs.set(key, proc);
    return { ok: true, cwd: startCwd, file: (file && fs.existsSync(file)) ? file : null };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.on("term:input", (_, { tabKey, data } = {}) => {
  const proc = ptyProcs.get(tabKey || "__default__");
  if (proc) proc.write(data);
});
ipcMain.on("term:resize", (_, { tabKey, cols, rows } = {}) => {
  const proc = ptyProcs.get(tabKey || "__default__");
  if (proc) { try { proc.resize(cols, rows); } catch (e) {} }
});
ipcMain.handle("term:kill", (_, { tabKey } = {}) => {
  killPty(tabKey || "__default__");
  return true;
});

// Handle navigation within prototype — update current file and watcher
ipcMain.handle("file:navigated", (_, newFilePath) => {
  if (!newFilePath || !fs.existsSync(newFilePath)) return;
  currentFilePath = newFilePath;
  mainWindow.setTitle(`${path.basename(newFilePath)} — Ohana`);
  writeActiveProject();
});

// ─── Native Menu ─────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => { if (mainWindow) mainWindow.webContents.send("view:openDialog"); },
        },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          // Reload ONLY the active tab's webview (works for file/url/repo). The
          // renderer reloads the active <webview>; other tabs keep their state.
          click: () => { mainWindow.webContents.send("repo:reloadWebview"); },
        },
        {
          label: "Hard Reload (Clear Cache)",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => {
            mainWindow.webContents.send("repo:hardReload");
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Toolbar",
          accelerator: "CmdOrCtrl+\\",
          click: () => mainWindow.webContents.send("view:toggleSidebar"),
        },
        {
          label: "Toggle Element Inspector",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => mainWindow.webContents.send("view:toggleInspector"),
        },
        { type: "separator" },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: () => mainWindow.webContents.send("view:zoomIn"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => mainWindow.webContents.send("view:zoomOut"),
        },
        {
          label: "Reset Zoom",
          accelerator: "CmdOrCtrl+0",
          click: () => mainWindow.webContents.send("view:zoomReset"),
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Tools",
      submenu: [
        {
          label: "Screenshot to Clipboard",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow.webContents.send("tools:screenshotFull"),
        },
        {
          label: "Section Screenshot to Clipboard",
          accelerator: "CmdOrCtrl+Shift+C",
          click: () => mainWindow.webContents.send("tools:screenshotSection"),
        },
        { type: "separator" },
        {
          label: "Copy Page URL",
          accelerator: "CmdOrCtrl+Shift+U",
          click: () => mainWindow.webContents.send("tools:copyURL"),
        },
        {
          label: "Copy Full HTML",
          accelerator: "CmdOrCtrl+Shift+H",
          click: () => mainWindow.webContents.send("tools:copyHTML"),
        },
        {
          label: "Copy Section Code",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => mainWindow.webContents.send("tools:copySectionHTML"),
        },
        { type: "separator" },
        {
          label: "Comment Mode",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => mainWindow.webContents.send("tools:toggleComment"),
        },
        {
          label: "Toggle Findings Panel",
          accelerator: "CmdOrCtrl+Shift+F",
          click: () => mainWindow.webContents.send("tools:toggleFindings"),
        },
        // "Design Notes" menu removed — design.md lives in the project navigator now.
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── App Lifecycle ───────────────────────────────────────────────────

// SECURITY NOTE — deliberate trade-offs for a LOCAL design previewer.
// Ohana only ever loads (a) local .html files and (b) localhost dev servers
// the user explicitly opens. It does not browse the open web. To preview those
// freely we relax a few protections, scoped to the "persist:viewer" partition:
//   - disable CORS so local prototypes can fetch sibling files / assets
//   - accept self-signed certs and skip CSP, but ONLY for localhost (see below)
// If Ohana ever loads untrusted remote content, these must be revisited.
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");
// NOTE: we deliberately do NOT set the global "ignore-certificate-errors" switch.
// It would accept ANY bad cert in EVERY session, defeating the host-scoped
// verification below. Self-signed certs are accepted only for trusted dev hosts
// (localhost + hosts you opt into) via setCertificateVerifyProc on the viewer session.

// Hosts whose self-signed / internal certs we trust for prototype previews.
// localhost is always trusted; add your own dev domains in
// ~/.ohana/config.json → { "trustedHosts": ["*.acme.dev", "stage.acme.com"] }
// ("*.acme.dev" also matches "acme.dev" itself).
let _trustedHosts = null;
function extraTrustedHosts() {
  if (_trustedHosts) return _trustedHosts;
  const cfg = readJSONSafe(path.join(os.homedir(), ".ohana", "config.json"));
  _trustedHosts = (cfg && Array.isArray(cfg.trustedHosts))
    ? cfg.trustedHosts.filter((h) => typeof h === "string" && h)
    : [];
  return _trustedHosts;
}
function isTrustedDevHost(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  return extraTrustedHosts().some((h) => h.startsWith("*.")
    ? (hostname === h.slice(2) || hostname.endsWith(h.slice(1)))
    : hostname === h);
}

app.whenReady().then(() => {
  // Dock icon (so the logo shows in dev too, not only when packaged). When
  // running from source (not packaged) we use a variant with a red band so the
  // dev instance is instantly distinguishable from the installed app.
  if (app.dock) {
    const iconFile = app.isPackaged ? "icon-dock.png" : "icon-dock-dev.png";
    try { app.dock.setIcon(path.join(__dirname, "..", "assets", iconFile)); } catch (e) {}
  }

  // Grant the webview partition permission to load local files
  const viewerSession = session.fromPartition("persist:viewer");
  viewerSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });

  // Accept self-signed certificates ONLY for trusted dev hosts; everything else
  // falls back to Chromium's normal chain verification (callback -3).
  viewerSession.setCertificateVerifyProc((request, callback) => {
    callback(isTrustedDevHost(request.hostname) ? 0 : -3);
  });

  // Strip CSP in the viewer partition so prototypes using CDN scripts
  // (Tailwind, Alpine, Lucide…) render without being blocked. Scoped to the
  // viewer session only — the app's own window keeps its default policy.
  viewerSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [""],
      },
    });
  });

  // Allow file:// protocol in webview
  viewerSession.protocol.registerFileProtocol("local-file", (request, callback) => {
    const url = request.url.replace("local-file://", "");
    callback({ path: decodeURIComponent(url) });
  });

  buildMenu();
  createWindow();
});

function cleanupChildren() {
  try { if (fileWatcher) fileWatcher.close(); } catch (e) {}
  try { if (sourceWatcher) sourceWatcher.close(); } catch (e) {}
  try { if (findingsWatcher) findingsWatcher.close(); } catch (e) {}
  try { if (commandsWatcher) commandsWatcher.close(); } catch (e) {}
  try { if (designWatcher) designWatcher.close(); } catch (e) {}
  try { if (flowWatcher) flowWatcher.close(); } catch (e) {}
  try { if (devServerProcess) devServerProcess.kill(); } catch (e) {}
  for (const key of Array.from(ptyProcs.keys())) { try { killPty(key); } catch (e) {} }
}
app.on("window-all-closed", () => {
  cleanupChildren();
  if (process.platform !== "darwin") app.quit();
});
// Clean shutdown on ANY quit path (⌘Q, SIGTERM from dev tooling…): kill ptys and
// the dev server BEFORE Electron tears down, so macOS never records a crash and
// the "Electron quit unexpectedly" dialog stops appearing on the next launch.
app.on("before-quit", cleanupChildren);
process.on("SIGTERM", () => { try { app.quit(); } catch (e) { process.exit(0); } });
process.on("SIGINT", () => { try { app.quit(); } catch (e) { process.exit(0); } });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Handle file open via macOS Finder (double-click .html when app is associated)
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    loadHTMLFile(filePath);
  } else {
    app.whenReady().then(() => {
      loadHTMLFile(filePath);
    });
  }
});
