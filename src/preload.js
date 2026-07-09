const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // File operations
  openOnboarding: () => ipcRenderer.invoke("app:openOnboarding"),
  getHTML: () => ipcRenderer.invoke("file:getHTML"),
  loadDropped: (filePath) => ipcRenderer.invoke("file:loadDropped", filePath),
  navigated: (filePath) => ipcRenderer.invoke("file:navigated", filePath),

  // Unified open + tab context
  openFileOrFolder: () => ipcRenderer.invoke("dialog:openFileOrFolder"),
  tabSyncContext: (data) => ipcRenderer.invoke("tab:syncContext", data),

  // Context files (.md)
  contextList: (dir) => ipcRenderer.invoke("context:list", dir),
  contextRead: (filePath) => ipcRenderer.invoke("context:read", filePath),
  projectScan: (dir) => ipcRenderer.invoke("project:scan", dir),
  gitStatus: (dir) => ipcRenderer.invoke("git:status", dir),
  projectInit: (dir) => ipcRenderer.invoke("project:init", dir),
  projectWriteFile: (data) => ipcRenderer.invoke("project:writeFile", data),
  projectDeleteFile: (filePath) => ipcRenderer.invoke("project:deleteFile", filePath),
  projectRenameFile: (data) => ipcRenderer.invoke("project:renameFile", data),
  projectDuplicateFile: (filePath) => ipcRenderer.invoke("project:duplicateFile", filePath),

  // Design-system component metadata
  componentsRead: (opts) => ipcRenderer.invoke("components:read", opts),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  storybookIndex: (base) => ipcRenderer.invoke("storybook:index", base),

  // Network (devtools amables)
  netGetBody: (requestId) => ipcRenderer.invoke("net:getBody", requestId),
  netClear: () => ipcRenderer.invoke("net:clear"),
  cacheClear: () => ipcRenderer.invoke("cache:clear"),

  // Session persistence
  sessionSave: (state) => ipcRenderer.invoke("session:save", state),

  // Native notifications
  notify: (title, body) => ipcRenderer.invoke("notify:show", { title, body }),

  // Clipboard
  copyText: (text) => ipcRenderer.invoke("clipboard:copyText", text),
  copyImage: (dataURL) => ipcRenderer.invoke("clipboard:copyImage", dataURL),

  // Shell
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // Repo mode
  repoDetect: (dir) => ipcRenderer.invoke("repo:detect", dir),
  repoStart: (data) => ipcRenderer.invoke("repo:start", data),
  repoStop: () => ipcRenderer.invoke("repo:stop"),
  repoConnectExisting: (data) => ipcRenderer.invoke("repo:connectExisting", data),

  // .ohana/ directory operations
  ohanaWriteFile: (data) => ipcRenderer.invoke("ohana:writeFile", data),
  ohanaReadFile: (filename) => ipcRenderer.invoke("ohana:readFile", filename),
  ohanaReadGlobal: (filename) => ipcRenderer.invoke("ohana:readGlobal", filename),
  ohanaWriteGlobal: (data) => ipcRenderer.invoke("ohana:writeGlobal", data),
  getUsername: () => ipcRenderer.invoke("app:getUsername"),

  // design.md operations
  designRead: () => ipcRenderer.invoke("design:read"),
  designWrite: (content) => ipcRenderer.invoke("design:write", content),
  designCreate: () => ipcRenderer.invoke("design:create"),

  // Embedded terminal
  termStart: (data) => ipcRenderer.invoke("term:start", data),
  termInput: (data) => ipcRenderer.send("term:input", data),
  termResize: (data) => ipcRenderer.send("term:resize", data),
  termKill: (data) => ipcRenderer.invoke("term:kill", data),

  // Events from main process
  on: (channel, callback) => {
    const validChannels = [
      "term:data",
      "term:exit",
      "term:activity",
      "net:list",
      "console:list",
      "file:load",
      "file:reload",
      "view:openDialog",
      "session:restore",
      "view:toggleSidebar",
      "view:toggleInspector",
      "view:zoomIn",
      "view:zoomOut",
      "view:zoomReset",
      "tools:screenshotFull",
      "tools:screenshotSection",
      "tools:copyURL",
      "tools:copyHTML",
      "tools:copySectionHTML",
      "tools:toggleFindings",
      "tools:toggleComment",
      "tools:toggleDesign",
      "design:updated",
      "repo:ready",
      "repo:sourceChanged",
      "repo:reloadWebview",
      "repo:hardReload",
      "ohana:findingsUpdated",
      "ohana:commandsUpdated",
      "flow:updated",
      "project:changed",
      "url:openTab",
      "toast:show",
    ];
    if (validChannels.includes(channel)) {
      const sub = (_, ...args) => callback(...args);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  },
});
