#!/usr/bin/env node
/**
 * ohana-comments — MCP server
 *
 * Exposes the active Ohana prototype as MCP tools so Claude can manage it from
 * the terminal the same way it works with Linear:
 *   • Comments  — create / list / reply / resolve / delete (Figma-style pins)
 *   • Design    — read / update / init design.md (the design source of truth)
 *   • Moka      — read / list / build user-flows & sitemaps (flow.json):
 *                 add/update/delete screens, add blocks, connect/disconnect
 *
 * Targeting: reads ~/.ohana/active.json (written by Ohana whenever a project /
 * file / repo is opened) to locate the active workspace's .ohana/ dir
 * (findings.json, flow.json, design.md). Ohana watches those files live.
 *
 * Project model (Ohana ≥0.8): a PROJECT = a folder workspace scaffolded as
 *   prototipos/  (HTML prototypes — «A prototipo» builds here)
 *   planes/     (implementation plans written by agents)
 *   handoff/    (handoff docs — what gets exported to a repo)
 *   design/     (design.md, voice&tone, rubrics)
 *   .ohana/     (flow.json = the Moka boards / "flujos")
 * Boards belong to the project; a board can link its prototype via `proto`
 * (rel path, e.g. "prototipos/mercado.html"). Write artifacts to those folders.
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (MCP). Zero dependencies.
 * IMPORTANT: stdout is reserved for protocol messages — logs go to stderr.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ACTIVE_FILE = path.join(os.homedir(), ".ohana", "active.json");
const ALIVE_FILE = path.join(os.homedir(), ".ohana", "mcp-alive.json");
const PROTOCOL_VERSION = "2024-11-05";

// Heartbeat: announce our presence so Ohana can tell the MCP is connected.
// Written on startup and on every request; Ohana reads it and shows a status.
function touchAlive() {
  try {
    const dir = path.dirname(ALIVE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ALIVE_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, v: "0.5.0" }), "utf-8");
  } catch (e) {}
}

// ─── stderr logging (never stdout) ───
function log(...args) {
  process.stderr.write("[ohana-mcp] " + args.join(" ") + "\n");
}

// ─── Data access ───────────────────────────────────────────────────
const NO_PROJECT_MSG =
  "Ohana no tiene ningún proyecto abierto anclado a una carpeta, así que no hay dónde " +
  "escribir el flujo. Pídele al usuario que en Ohana use «Abrir → Proyecto» y elija una carpeta " +
  "(un tab de solo-URL no basta: no tiene carpeta en disco). Cuando lo haga, reintenta. " +
  "NO escribas ningún archivo a ciegas mientras tanto.";

function resolveActive() {
  if (!fs.existsSync(ACTIVE_FILE)) {
    throw new Error(NO_PROJECT_MSG);
  }
  const active = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf-8"));
  if (!active.findingsFile || !active.projectDir) {
    throw new Error(NO_PROJECT_MSG);
  }
  return active;
}

function readComments(active) {
  try {
    if (!fs.existsSync(active.findingsFile)) return [];
    const raw = fs.readFileSync(active.findingsFile, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeComments(active, comments) {
  const dir = path.dirname(active.findingsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(active.findingsFile, JSON.stringify(comments, null, 2), "utf-8");
}

function designPath(active) {
  if (active.designFile) return active.designFile;
  if (active.projectDir) return path.join(active.projectDir, "design.md");
  throw new Error("No project directory for the active prototype.");
}

function designTemplate(name) {
  const today = new Date().toISOString().slice(0, 10);
  return `# Design — ${name}

> Fuente de verdad del diseño de este prototipo.

## Principios
-

## Tokens

### Color
| Token | Valor | Uso |
|-------|-------|-----|
|       |       |     |

### Tipografía
- Display:
- Body:

### Spacing & radius
-

## Voz y tono
-

## Patrones de componentes
-

## Decisiones
- ${today} —
`;
}

function newId() {
  return (
    "cmt_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 7)
  );
}

function findIndexById(comments, id) {
  // Accept either the string id or a numeric index (as string/number)
  let idx = comments.findIndex((c) => c.id === id);
  if (idx === -1 && /^\d+$/.test(String(id))) {
    const n = parseInt(id, 10);
    if (n >= 0 && n < comments.length) idx = n;
  }
  return idx;
}

function publicComment(c, idx) {
  return {
    id: c.id || String(idx),
    index: idx,
    author: c.author || c.agent || "unknown",
    message: c.message || "",
    status: c.status || "open",
    anchor: c.anchor || (c.component ? { aiId: c.component } : null),
    replies: (c.replies || []).map((r) => ({
      author: r.author,
      message: r.message,
      at: r.at,
    })),
    createdAt: c.createdAt || null,
  };
}

// ─── Moka (flow) access ────────────────────────────────────────────
// flow.json lives in the same .ohana/ dir as findings.json. Shape:
//   { flows:[{id,name,screens:[...],edges:[...]}], active, globals, tabActive }
// We operate on the *active* flow (which the app keeps pointed at the active
// tab's flow), unless a flowId is given. Ohana watches flow.json and reloads
// the canvas live when in Moka mode.
const FLOW_KINDS = ["page", "modal", "dialog", "decision", "start", "end", "subflow"];
const FLOW_STATUSES = ["todo", "wip", "done"]; // por construir | en progreso | listo

function flowPath(active) {
  if (active.findingsFile) return path.join(path.dirname(active.findingsFile), "flow.json");
  if (active.projectDir) return path.join(active.projectDir, ".ohana", "flow.json");
  throw new Error("No project directory for the active prototype.");
}
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36) +
    Math.floor(Math.random() * 36).toString(36);
}
function readFlowDoc(active) {
  const f = flowPath(active);
  let doc = null, corrupt = false;
  try {
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, "utf-8");
      if (raw && raw.trim()) { try { doc = JSON.parse(raw); } catch (pe) { corrupt = true; } }
    }
  } catch (e) {}
  if (corrupt) {
    // Never rebuild over a broken file — the next write would silently destroy
    // every flow. Mirror the app (it refuses too): back it up and surface it.
    try { fs.copyFileSync(f, f + ".bak"); } catch (e) {}
    throw new Error("flow.json está corrupto (JSON inválido). NO lo sobrescribas: hay un respaldo en flow.json.bak — corrígelo a mano o avisa al usuario para restaurarlo desde Ohana.");
  }
  if (doc && Array.isArray(doc.flows) && doc.flows.length) {
    doc.globals = (doc.globals && typeof doc.globals === "object") ? doc.globals : {};
    doc.tabActive = (doc.tabActive && typeof doc.tabActive === "object") ? doc.tabActive : {};
    doc.flows.forEach((fl) => {
      fl.id = fl.id || genId("s"); fl.name = fl.name || "Flujo";
      fl.screens = Array.isArray(fl.screens) ? fl.screens : [];
      fl.edges = Array.isArray(fl.edges) ? fl.edges : [];
    });
    // Migrate legacy tabActive map → explicit per-flow owner (src); first src wins.
    Object.keys(doc.tabActive).forEach((src) => { const fl = doc.flows.find((x) => x.id === doc.tabActive[src]); if (fl && !fl.src) fl.src = src; });
    doc.flows.forEach((fl) => ensureHandles(fl)); // stable P1… handles for prompts
    if (!doc.active || !doc.flows.some((fl) => fl.id === doc.active)) doc.active = doc.flows[0].id;
    return { doc, path: f };
  }
  // legacy single-flow or empty file → wrap into the multi-flow shape
  const fl = {
    id: genId("s"), name: "Flujo principal", src: active.src || active.currentFile || undefined,
    screens: (doc && Array.isArray(doc.screens)) ? doc.screens : [],
    edges: (doc && Array.isArray(doc.edges)) ? doc.edges : [],
  };
  const legacy = { flows: [fl], active: fl.id, globals: (doc && doc.globals) || {}, tabActive: (doc && doc.tabActive) || {} };
  if (doc && doc.layout) legacy.layout = doc.layout;       // canvas prefs (dir/connector)
  if (doc && Array.isArray(doc.layouts)) legacy.layouts = doc.layouts; // saved grid-painter presets
  return { doc: legacy, path: f };
}
function writeFlowDoc(active, doc, fp) {
  if (Array.isArray(doc.flows)) doc.flows.forEach((fl) => ensureHandles(fl)); // new screens get a P# too
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(doc, null, 2), "utf-8");
}
function targetFlow(doc, args, active) {
  if (args && args.flowId) {
    const fl = doc.flows.find((x) => x.id === args.flowId);
    if (!fl) throw new Error("Flow not found: " + args.flowId);
    return fl;
  }
  // Flows are owned per tab (src). `active.src` is the exact same owner key the
  // Ohana renderer uses for the active tab (file path, repo URL, or new-proto
  // folder). Falling back to currentFile keeps older active.json files working.
  // Operate on the active tab's flow, creating it if this tab has none yet, so
  // agent edits land in the flow the UI actually shows (not an orphan).
  const src = (active && (active.src || active.currentFile)) || null;
  if (src) {
    doc.tabActive = (doc.tabActive && typeof doc.tabActive === "object") ? doc.tabActive : {};
    const owned = doc.flows.filter((fl) => fl.src === src);
    if (owned.length) {
      const remembered = doc.tabActive[src];
      const pick = owned.find((fl) => fl.id === remembered) || owned[0];
      doc.active = pick.id;
      doc.tabActive[src] = pick.id;
      return pick;
    }
    const fl = { id: genId("s"), name: "Flujo 1", src: src, screens: [], edges: [] };
    doc.flows.push(fl);
    doc.active = fl.id;
    doc.tabActive[src] = fl.id; // so the UI switches to this flow on reload
    return fl;
  }
  return doc.flows.find((fl) => fl.id === doc.active) || doc.flows[0];
}
function findScreen(fl, id) {
  let s = fl.screens.find((x) => x.id === id);
  if (!s && /^\d+$/.test(String(id))) {
    const n = parseInt(id, 10);
    if (n >= 0 && n < fl.screens.length) s = fl.screens[n];
  }
  return s;
}
// Resolve a screen by node handle (P1…), id, exact/partial name, or numeric index.
function findScreenRef(fl, ref) {
  if (ref == null) return null;
  const lo = String(ref).toLowerCase();
  let s = fl.screens.find((x) => (x.handle || "").toLowerCase() === lo); if (s) return s;
  s = fl.screens.find((x) => x.id === ref); if (s) return s;
  s = fl.screens.find((x) => (x.name || "").toLowerCase() === lo); if (s) return s;
  s = fl.screens.find((x) => (x.name || "").toLowerCase().indexOf(lo) !== -1); if (s) return s;
  return findScreen(fl, ref);
}
// Assign stable node handles (P1…) to any screen missing one; numbers only grow.
function ensureHandles(fl) {
  let max = fl.pmax || 0;
  fl.screens.forEach((s) => { const m = s.handle && /^P(\d+)$/.exec(s.handle); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  fl.screens.forEach((s) => { if (!s.handle) s.handle = "P" + (++max); });
  fl.pmax = max;
}
function newScreen(name, kind) {
  return { id: genId("s"), name: name || "Pantalla", kind: (FLOW_KINDS.indexOf(kind) !== -1 ? kind : "page"), status: "todo", x: 0, y: 0, apis: [], links: [], blocks: [] };
}
// The conventions any agent should follow to build ordered sitemaps / user flows.
const MOKA_GUIDE = [
  "# Cómo armar Sitemaps y User Flows en Moka",
  "",
  "Moka acomoda las tarjetas automáticamente: NO pongas coordenadas (x/y). Tú expresas la ESTRUCTURA y Moka la ordena.",
  "",
  "## Sitemap (arquitectura de navegación)",
  "Es una JERARQUÍA vertical: páginas de nivel 1 y, debajo, sus hijas de nivel 2/3.",
  "- Usa `ohana_sitemap_add_page({ name })` para una página de nivel 1 (sin `parent`).",
  "- Usa `ohana_sitemap_add_page({ parent, name })` para colgar una hija de su padre (conecta padre→hija sola).",
  "- Las hermanas comparten el mismo `parent`. El layout es un árbol vertical (TB).",
  "",
  "## User Flow (secuencia de tareas)",
  "Es una SECUENCIA horizontal: paso 1 → 2 → 3, con ramas en decisiones.",
  "- EMPIEZA con una tarjeta `kind:\"start\"` (Inicio) y TERMINA cada camino con `kind:\"end\"` (Fin). Así el export entiende dónde empieza y termina la experiencia.",
  "- Usa `ohana_flow_add_step({ after, name, kind })` para el siguiente paso (conecta en orden, izq→der).",
  "- Para una bifurcación: crea un paso con `kind:\"decision\"` (rombo con salidas Sí/No ya resueltas) y luego `ohana_flow_add_branch({ from, label, name })` por cada salida (label Sí/No).",
  "- Tipos de nodo del flujo (úsalos en `add_step`/`add_branch` con `kind`): `decision` (rombo con salidas Sí/verde y No/rojo) y `subflow` (enlaza a otro flujo del proyecto). Las pantallas reales van como `page`/`modal`/`dialog`.",
  "- Las salidas de color marcan el camino: VERDE = positivo (Sí/Éxito), ROJO = negativo (No/Error), AZUL = conexión normal (el flujo sigue). Conecta desde la salida correcta y el color/etiqueta queda guardado en el edge para que se entienda la lógica.",
  "- Modales/diálogos: `kind:\"modal\"`/`\"dialog\"`; si llevan a otra parte, encadénalos con add_step/connect.",
  "- `kind:\"subflow\"` enlaza a OTRO flujo del proyecto: vincúlalo con `ohana_flow_update_screen({ id, flowRef: \"<id del flujo>\" })`.",
  "",
  "## Contenido de una pantalla (jerarquía)",
  "Página → REGIONES → SECCIONES → COMPONENTES.",
  "- Las REGIONES definen el layout de la tarjeta. Aplica un preset con `ohana_flow_set_layout` (builtin o un layout del proyecto creado en el grid painter), o créalas con `ohana_flow_add_section` SIN `region` (p. ej. Header / Body / Footer).",
  "- Las SECCIONES son organismos UI dentro de una región: `ohana_flow_add_section({ screenId, name, region })`.",
  "- Los COMPONENTES (botones, tablas, badges…) van dentro de secciones: `ohana_flow_add_component({ screenId, section, name })`.",
  "- Conexiones: salen de páginas o de componentes (`ohana_flow_connect` con `fromComponent`) y SIEMPRE llegan a la tarjeta destino, nunca a un componente.",
  "",
  "## Regla de oro",
  "Construye con estas tools de intención (traen la conexión y el orden incluidos). Evita posicionar a mano. Si usas `ohana_flow_add_screen`/`connect` directo, llama `ohana_flow_layout` al final.",
  "",
  "## Estructura del proyecto (dónde va cada artefacto)",
  "Un proyecto de Ohana es una carpeta con este esqueleto — escribe cada cosa en su casa:",
  "- `prototipos/` — prototipos HTML (un archivo autocontenido por flujo; Tailwind/Alpine/Lucide por CDN).",
  "- `planes/` — planes de implementación en .md (escribe aquí tus planes antes de ejecutar).",
  "- `handoff/` — documentación de handoff (lo que se exporta a un repositorio).",
  "- `design/` — sistema de diseño (voz y tono, rúbricas); `design.md` en la raíz también cuenta.",
  "- `.ohana/flow.json` — los flujos/boards de Moka (usa las tools, no lo edites a mano).",
  "Al construir el prototipo de un flujo, enlázalo con `ohana_flow_set_proto({ path: \"prototipos/<slug>.html\" })` para que Ohana muestre «Ver prototipo» en el board.",
].join("\n");
// Layout tree helpers (mirror the app): a screen's content is a nestable
// row/col container tree. Migrate legacy flat `blocks` on read.
function isCont(n) { return !!(n && Array.isArray(n.children)); }
function ensureLayoutNode(s) {
  if (!isCont(s.layout)) s.layout = { cid: genId("c"), dir: "col", children: Array.isArray(s.blocks) ? s.blocks : [] };
  if (s.blocks) delete s.blocks;
  (function walk(n) { if (isCont(n)) { if (!n.cid) n.cid = genId("c"); n.children = n.children || []; n.children.forEach(walk); } else if (!n.bid) n.bid = genId("b"); })(s.layout);
}
function findContainer(s, cid) {
  if (!cid) return s.layout;
  let r = null;
  (function walk(n) { if (r) return; if (isCont(n)) { if (n.cid === cid) { r = n; return; } n.children.forEach(walk); } })(s.layout);
  return r;
}
function publicNode(n, globals) {
  if (isCont(n)) {
    const o = { cid: n.cid, dir: n.dir || "col", grow: n.grow || null, children: n.children.map((c) => publicNode(c, globals)) };
    if (n.name) o.name = n.name;
    if (n.variant) o.variant = n.variant;
    if (n.grid) o.grid = { cols: n.grid.cols, rows: n.grid.rows }; // grid layout root
    if (n.area) o.area = n.area.slice();                          // region cells [c0,r0,c1,r1]
    return o;
  }
  if (n.globalId) {
    // global component: content lives in doc.globals — resolve it so agents see it
    const g = (globals || {})[n.globalId];
    const o = { bid: n.bid || null, globalId: n.globalId };
    if (g) { o.type = g.type || null; o.title = g.title || ""; o.desc = g.desc || ""; o.items = g.items || []; }
    return o;
  }
  const b = { bid: n.bid || null, type: n.type || null, title: n.title || "", desc: n.desc || "", items: n.items || [] };
  if (n.icon) b.icon = n.icon;
  return b;
}
function findBlock(s, bid) {
  let r = null;
  (function walk(n) { if (r || !n) return; if (isCont(n)) n.children.forEach(walk); else if (n.bid === bid) r = n; })(s.layout);
  return r;
}
// Built-in SaaS layout presets (mirror the app). Applying replaces the screen's
// region structure with empty named regions; existing blocks move to the first.
const BUILTIN_LAYOUTS = {
  vert: { dir: "col", children: [] },
  sidebar: { dir: "row", children: [{ dir: "col", name: "Navegación", grow: 28, children: [] }, { dir: "col", name: "Contenido", grow: 72, children: [] }] },
  topbar: { dir: "col", children: [{ dir: "row", name: "Barra superior", grow: 14, children: [] }, { dir: "col", name: "Contenido", grow: 86, children: [] }] },
  topsidebar: { dir: "col", children: [{ dir: "row", name: "Barra superior", grow: 14, children: [] }, { dir: "row", grow: 86, children: [{ dir: "col", name: "Navegación", grow: 26, children: [] }, { dir: "col", name: "Contenido", grow: 74, children: [] }] }] },
  subpanel: { dir: "row", children: [{ dir: "col", name: "Navegación", grow: 20, children: [] }, { dir: "col", name: "Subpanel", grow: 26, children: [] }, { dir: "col", name: "Contenido", grow: 54, children: [] }] },
  masterdetail: { dir: "row", children: [{ dir: "col", name: "Lista", grow: 36, children: [] }, { dir: "col", name: "Detalle", grow: 64, children: [] }] },
  twocol: { dir: "row", children: [{ dir: "col", name: "Columna 1", grow: 50, children: [] }, { dir: "col", name: "Columna 2", grow: 50, children: [] }] },
};
function cloneTreeFresh(node) {
  const c = { cid: genId("c"), dir: node.dir === "row" ? "row" : "col", children: (node.children || []).map(cloneTreeFresh) };
  if (node.name) c.name = node.name; if (node.grow) c.grow = node.grow;
  return c;
}
// User grid presets (grid painter): {grid:{cols,rows}, regions:[{name,c0,r0,c1,r1,dir,color}]}
// → grid layout node {grid, children:[{name, dir, area:[c0,r0,c1,r1], children:[]}]} (mirrors the app).
function gridLayoutFromPreset(p) {
  return { cid: genId("c"), grid: { cols: p.grid.cols, rows: p.grid.rows }, children: (p.regions || []).map((g) => ({ cid: genId("c"), name: g.name || "", dir: g.dir === "row" ? "row" : "col", area: [g.c0, g.r0, g.c1, g.r1], children: [] })) };
}
function collectBlocks(node, out) { if (isCont(node)) (node.children || []).forEach((c) => collectBlocks(c, out)); else out.push(node); return out; }
function firstEmptyLeaf(node) { if (isCont(node)) { if (!node.children.length) return node; for (let i = 0; i < node.children.length; i++) { const r = firstEmptyLeaf(node.children[i]); if (r) return r; } } return null; }
function publicScreen(s, globals) {
  if (s.kind !== "decision") ensureLayoutNode(s);
  const out = {
    id: s.id, handle: s.handle || null, name: s.name || "", kind: s.kind || "page", status: FLOW_STATUSES.indexOf(s.status) !== -1 ? s.status : "todo", desc: s.desc || "",
    apis: (s.apis || []).map((a) => ({ endpoint: a.endpoint || "", ctx: a.ctx || "" })),
    links: (s.links || []).map((l) => ({ url: l.url || "", ctx: l.ctx || "" })),
    x: s.x || 0, y: s.y || 0,
    layout: s.kind === "decision" ? null : publicNode(s.layout, globals),
  };
  if (s.flowRef) out.flowRef = s.flowRef; // subflow → the project flow it opens
  return out;
}
function publicEdge(e) {
  // component → page: {fromB:"screenId/bid", to:pageId} (toB only on legacy block↔block links)
  if (e.fromB || e.toB) { const o = { fromB: e.fromB, label: e.label || "", dir: e.dir || "fwd" }; if (e.to) o.to = e.to; if (e.toB) o.toB = e.toB; return o; }
  const out = { from: e.from, to: e.to, fromSide: e.fromSide || "right", label: e.label || "", dir: e.dir || "fwd" };
  if (e.color) out.color = e.color;   // semantic path color (green positive / red negative)
  if (e.out) out.out = e.out;         // which predefined output it leaves from (Si/No/Exito/Error)
  if (e.dash) out.dash = true;        // dashed connector
  return out;
}
// Layered (Sugiyama-style) layout — mirrors the app's engine so MCP-built flows
// look identical to ones tidied in the UI. Mutates each screen's x/y.
// Estimate rendered height from the content tree (sections + components), since
// a card grows tall with its sections. Ohana refines this with real DOM
// measurements on reveal, but a good estimate keeps persisted coords sane.
function estScreenHeight(s) {
  let sections = 0, comps = 0;
  (function walk(n) { if (!n) return; if (Array.isArray(n.children)) { if (n.name) sections++; n.children.forEach(walk); } else { comps++; } })(s.layout);
  return Math.min(1500, 120 + sections * 46 + comps * 72);
}
// Node footprints mirror the app's nodeDim(): decision=diamond, start/end=pill,
// subflow=compact, else card (default width 320).
function screenDim(s) {
  if (s.kind === "decision") return { w: 120, h: 120 };
  if (s.kind === "start" || s.kind === "end") return { w: 150, h: 46 };
  if (s.kind === "subflow") return { w: 190, h: 54 };
  return { w: s.w || 320, h: estScreenHeight(s) };
}
function layoutScreens(screens, edges, dir) {
  if (!screens.length) return;
  const sdim = screenDim;
  const ids = screens.map((s) => s.id), idset = new Set(ids), byId = {}; screens.forEach((s) => (byId[s.id] = s));
  const E = (edges || []).filter((e) => e.from && e.to && idset.has(e.from) && idset.has(e.to) && e.from !== e.to);
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
  // Sugiyama dummy nodes: split edges spanning >1 layer into a chain of virtual
  // nodes so long edges reserve their own lane and stop crossing the cards
  // between their endpoints (the missing phase that made flows look tangled).
  const isDummy = {}, LANE = 26;
  const fadj = {}, inAdj = {}; const nodes = ids.slice();
  const ensure = (n) => { if (!fadj[n]) { fadj[n] = []; inAdj[n] = []; } };
  ids.forEach(ensure);
  let dcount = 0;
  F.forEach((e) => {
    const lo = rank[e.from], hi = rank[e.to];
    if (hi - lo <= 1) { fadj[e.from].push(e.to); inAdj[e.to].push(e.from); return; }
    let prev = e.from;
    for (let r = lo + 1; r < hi; r++) { const dn = "__d" + (dcount++); isDummy[dn] = true; rank[dn] = r; ensure(dn); nodes.push(dn); fadj[prev].push(dn); inAdj[dn].push(prev); prev = dn; }
    fadj[prev].push(e.to); inAdj[e.to].push(prev);
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
  const rankMain = []; for (let r = 0; r <= maxRank; r++) rankMain[r] = Math.max(LR ? 320 : 140, ...layers[r].map((id) => { const d = ndim(id); return LR ? d.w : d.h; }));
  const rankPos = []; let cur = 80; for (let r = 0; r <= maxRank; r++) { rankPos[r] = cur; cur += rankMain[r] + GAP_MAIN; }
  const cross = {}; let gMin = Infinity;
  layers.forEach((L) => { let c = 0; const place = {}; L.forEach((id) => { const d = ndim(id); const sz = LR ? d.h : d.w; place[id] = c + sz / 2; c += sz + GAP_CROSS; }); const total = c - GAP_CROSS; L.forEach((id) => (cross[id] = place[id] - total / 2)); });
  layers.forEach((L) => L.forEach((id) => { const d = ndim(id); const sz = LR ? d.h : d.w; gMin = Math.min(gMin, cross[id] - sz / 2); }));
  const shift = 80 - (gMin === Infinity ? 0 : gMin);
  layers.forEach((L, r) => L.forEach((id) => { if (isDummy[id]) return; const s = byId[id], d = sdim(s); if (LR) { s.x = rankPos[r]; s.y = Math.round(cross[id] + shift - d.h / 2); } else { s.y = rankPos[r]; s.x = Math.round(cross[id] + shift - d.w / 2); } }));
}
// Tidy tree layout for SITEMAPS (mirrors the app's treeLayout): roots on top,
// children below, each parent centered over its subtree, siblings side by side.
// The app's "Ordenar" uses this for sitemap boards — not the layered engine.
function treeLayout(screens, edges) {
  if (!screens.length) return;
  const ids = screens.map((s) => s.id), idset = new Set(ids), byId = {}; screens.forEach((s) => (byId[s.id] = s));
  const E = (edges || []).filter((e) => e.from && e.to && idset.has(e.from) && idset.has(e.to) && e.from !== e.to);
  const children = {}, parentOf = {}; ids.forEach((id) => (children[id] = []));
  E.forEach((e) => { if (parentOf[e.to] === undefined) { parentOf[e.to] = e.from; children[e.from].push(e.to); } });
  let roots = ids.filter((id) => parentOf[id] === undefined);
  if (!roots.length) roots = [ids[0]]; // cycle fallback
  const dim = (id) => screenDim(byId[id]);
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

// ─── Tool definitions ──────────────────────────────────────────────
const TOOLS = [
  {
    name: "ohana_status",
    description:
      "Show the active Ohana project: its folder, workspace structure (boards/flujos, prototipos, planes, handoff, design) and a summary of its comments. Call this FIRST to know where to write each artifact.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const active = resolveActive();
      const comments = readComments(active);
      const open = comments.filter((c) => c.status !== "resolved").length;
      const resolved = comments.filter((c) => c.status === "resolved").length;
      // Workspace structure — tell the agent where each artifact lives.
      const dir = active.projectDir;
      const listMd = (sub, exts) => {
        try {
          const p = path.join(dir, sub);
          if (!fs.existsSync(p)) return [];
          return fs.readdirSync(p).filter((n) => exts.some((e) => n.toLowerCase().endsWith(e)));
        } catch (e) { return []; }
      };
      let boards = [];
      try { const { doc } = readFlowDoc(active); boards = (doc.flows || []).map((f) => ({ id: f.id, name: f.name, board: f.board === "sitemap" ? "sitemap" : "userflow", screens: (f.screens || []).length, proto: f.proto || null })); } catch (e) {}
      return {
        projectDir: dir,
        currentFile: active.currentFile,
        src: active.src || null,
        mode: active.mode,
        updatedAt: active.updatedAt,
        structure: {
          flujos: boards,                                     // Moka boards (.ohana/flow.json)
          prototipos: listMd("prototipos", [".html", ".htm"]), // build prototypes here
          planes: listMd("planes", [".md"]),                  // write implementation plans here
          handoff: listMd("handoff", [".md"]),                // handoff docs (what ships to a repo)
          design: listMd("design", [".md"]),                  // design system docs (design.md at root too)
        },
        comments: { total: comments.length, open, resolved },
      };
    },
  },
  {
    name: "ohana_list_comments",
    description:
      "List comments on the active prototype. Optionally filter by status. Returns each comment's id, author, message, anchor (the element it's pinned to) and replies.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "open", "resolved"],
          description: "Filter by status (default: all).",
        },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const comments = readComments(active);
      const status = (args && args.status) || "all";
      const out = [];
      comments.forEach((c, idx) => {
        const s = c.status || "open";
        if (status === "open" && s === "resolved") return;
        if (status === "resolved" && s !== "resolved") return;
        out.push(publicComment(c, idx));
      });
      return { count: out.length, comments: out };
    },
  },
  {
    name: "ohana_create_comment",
    description:
      "Create a new comment on the active prototype. Anchor it to an element with anchorAiId (a data-ai-id) when possible, or anchorSelector (a CSS selector). The comment appears live in Ohana as a numbered pin.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The comment text." },
        anchorAiId: {
          type: "string",
          description: "data-ai-id of the element to pin the comment to (preferred).",
        },
        anchorSelector: {
          type: "string",
          description: "CSS selector of the element (fallback if no data-ai-id).",
        },
        anchorLabel: {
          type: "string",
          description: "Human-readable label for the anchor (defaults to the aiId or selector).",
        },
        author: {
          type: "string",
          description: "Author name (default: 'Claude').",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const comments = readComments(active);
      let anchor = null;
      if (args.anchorAiId || args.anchorSelector) {
        anchor = {
          aiId: args.anchorAiId || null,
          selector: args.anchorSelector || null,
          label: args.anchorLabel || args.anchorAiId || args.anchorSelector,
        };
      }
      const comment = {
        id: newId(),
        kind: "comment",
        author: args.author || "Claude",
        authorType: args.author && args.author !== "Claude" ? "person" : "agent",
        anchor,
        component: args.anchorAiId || undefined,
        message: args.message,
        status: "open",
        createdAt: new Date().toISOString(),
        replies: [],
      };
      comments.push(comment);
      writeComments(active, comments);
      return { ok: true, id: comment.id, index: comments.length - 1 };
    },
  },
  {
    name: "ohana_reply",
    description:
      "Reply to an existing comment thread by its id (or index). Optionally resolve the thread in the same call.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The comment id (or numeric index)." },
        message: { type: "string", description: "The reply text." },
        author: { type: "string", description: "Author name (default: 'Claude')." },
        resolve: {
          type: "boolean",
          description: "If true, also mark the thread resolved.",
        },
      },
      required: ["id", "message"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const comments = readComments(active);
      const idx = findIndexById(comments, args.id);
      if (idx === -1) throw new Error("Comment not found: " + args.id);
      const c = comments[idx];
      if (!c.replies) c.replies = [];
      c.replies.push({
        author: args.author || "Claude",
        authorType: args.author && args.author !== "Claude" ? "person" : "agent",
        message: args.message,
        at: new Date().toISOString(),
      });
      if (args.resolve) {
        c.status = "resolved";
        c.statusAt = new Date().toISOString();
      }
      writeComments(active, comments);
      return { ok: true, id: c.id || String(idx), resolved: !!args.resolve };
    },
  },
  {
    name: "ohana_resolve",
    description:
      "Resolve or reopen a comment thread by its id (or index).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The comment id (or numeric index)." },
        resolved: {
          type: "boolean",
          description: "true to resolve (default), false to reopen.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const comments = readComments(active);
      const idx = findIndexById(comments, args.id);
      if (idx === -1) throw new Error("Comment not found: " + args.id);
      const c = comments[idx];
      const resolve = args.resolved !== false;
      c.status = resolve ? "resolved" : "open";
      c.statusAt = new Date().toISOString();
      writeComments(active, comments);
      return { ok: true, id: c.id || String(idx), status: c.status };
    },
  },
  {
    name: "ohana_delete",
    description: "Delete a comment thread by its id (or index).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The comment id (or numeric index)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const comments = readComments(active);
      const idx = findIndexById(comments, args.id);
      if (idx === -1) throw new Error("Comment not found: " + args.id);
      const removed = comments.splice(idx, 1)[0];
      writeComments(active, comments);
      return { ok: true, deleted: removed.id || String(idx) };
    },
  },
  {
    name: "ohana_read_design",
    description:
      "Read design.md — the design source of truth for the active prototype (tokens, principles, voice, patterns, decisions). Read this before changing any UI to stay consistent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const active = resolveActive();
      const f = designPath(active);
      if (!fs.existsSync(f)) {
        return { exists: false, path: f, content: "" };
      }
      return { exists: true, path: f, content: fs.readFileSync(f, "utf-8") };
    },
  },
  {
    name: "ohana_update_design",
    description:
      "Write design.md for the active prototype. Pass the full new markdown content (this replaces the file). Creates it if missing. Use to record tokens, principles, decisions as the design evolves; the change shows live in Ohana's Design panel.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown content of design.md." },
      },
      required: ["content"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const f = designPath(active);
      const dir = path.dirname(f);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, args.content, "utf-8");
      return { ok: true, path: f, bytes: Buffer.byteLength(args.content, "utf-8") };
    },
  },
  {
    name: "ohana_init_design",
    description:
      "Create design.md from a starter template (only if it doesn't exist yet). Returns the content.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const active = resolveActive();
      const f = designPath(active);
      if (!fs.existsSync(f)) {
        const name = active.projectDir ? path.basename(active.projectDir) : "Prototype";
        fs.writeFileSync(f, designTemplate(name), "utf-8");
      }
      return { ok: true, path: f, content: fs.readFileSync(f, "utf-8") };
    },
  },

  // ─── Moka (user-flow / sitemap) tools ───
  {
    name: "ohana_flow_read",
    description:
      "Read a Moka flow. Default = COMPACT map (each screen: id, handle, name, kind, status + the edges) — cheap, use it to orient. Pass detail:true (optionally screenId) to get the full content (sections/components, apis, links) of a screen when you're about to edit it. flowId targets a specific flow.",
    inputSchema: {
      type: "object",
      properties: {
        flowId: { type: "string", description: "Specific flow id (default: the active flow)." },
        detail: { type: "boolean", description: "Include full screen content (layout/apis/links). Default false = compact." },
        screenId: { type: "string", description: "With detail:true, return full content for just this screen (id/index/handle)." },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const compact = (s) => { const o = { id: s.id, handle: s.handle || null, name: s.name || "", kind: s.kind || "page", status: FLOW_STATUSES.indexOf(s.status) !== -1 ? s.status : "todo" }; if (s.flowRef) o.flowRef = s.flowRef; return o; };
      let screens;
      if (args.detail) {
        const only = args.screenId ? findScreen(fl, args.screenId) : null;
        screens = fl.screens.map((s) => (!only || s === only) ? publicScreen(s, doc.globals) : compact(s));
      } else {
        screens = fl.screens.map(compact);
      }
      const out = {
        flowId: fl.id, name: fl.name, active: doc.active,
        board: fl.board === "sitemap" ? "sitemap" : "userflow", // sitemap=jerarquía (TB), userflow=secuencia (LR)
        proto: fl.proto || null, // linked prototype (rel path, e.g. "prototipos/x.html")
        screens: screens,
        edges: (fl.edges || []).map(publicEdge),
      };
      if (args.detail) out.globals = doc.globals || {}; // globals only when asking for detail
      return out;
    },
  },
  {
    name: "ohana_flow_list",
    description: "List all Moka flows in this project (id, name, screen/edge counts) and which one is active.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const active = resolveActive();
      const { doc } = readFlowDoc(active);
      return {
        active: doc.active,
        flows: doc.flows.map((fl) => ({ id: fl.id, name: fl.name, board: fl.board === "sitemap" ? "sitemap" : "userflow", src: fl.src || null, proto: fl.proto || null, screens: (fl.screens || []).length, edges: (fl.edges || []).length })),
      };
    },
  },
  {
    name: "ohana_flow_new",
    description: "Create a new empty Moka board. Choose its type at creation: board 'userflow' (left→right sequence) or 'sitemap' (top→bottom tree). By default it becomes the active flow.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Flow name." },
        board: { type: "string", enum: ["userflow", "sitemap"], description: "Board type (default: userflow)." },
        activate: { type: "boolean", description: "Make it the active flow (default: true)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = { id: genId("s"), name: args.name || "Flujo", board: args.board === "sitemap" ? "sitemap" : "userflow", src: active.src || active.currentFile || undefined, screens: [], edges: [] };
      doc.flows.push(fl);
      if (args.activate !== false) doc.active = fl.id;
      writeFlowDoc(active, doc, fp);
      return { ok: true, flowId: fl.id, board: fl.board, active: doc.active };
    },
  },
  {
    name: "ohana_flow_set_proto",
    description:
      "Link a Moka board to its HTML prototype (rel path inside the project, e.g. 'prototipos/mercado.html'). Ohana shows a «Ver prototipo» button on the board. Call this after building the prototype for a flow.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Prototype path relative to the project root (put prototypes in prototipos/)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.proto = String(args.path).replace(/^\/+/, "");
      writeFlowDoc(active, doc, fp);
      return { ok: true, flowId: fl.id, proto: fl.proto };
    },
  },
  {
    name: "ohana_flow_add_screen",
    description:
      "Add a screen (card) to a Moka flow. kind is one of page|modal|dialog|decision|start|end|subflow (decision = a branch/diamond; subflow = links to another project flow via flowRef). Returns the new screen id. Use ohana_flow_connect to link it to others.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Screen title (for a decision, the question)." },
        kind: { type: "string", enum: FLOW_KINDS, description: "Screen type (default: page)." },
        status: { type: "string", enum: FLOW_STATUSES, description: "Build status: todo (por construir) | wip (en progreso) | done (listo). Default: todo." },
        desc: { type: "string", description: "Context of this screen." },
        flowRef: { type: "string", description: "For kind:\"subflow\": id of the project flow this card links to." },
        x: { type: "number", description: "Canvas X (optional; auto if omitted)." },
        y: { type: "number", description: "Canvas Y (optional; auto if omitted)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const kind = FLOW_KINDS.indexOf(args.kind) !== -1 ? args.kind : "page";
      const status = FLOW_STATUSES.indexOf(args.status) !== -1 ? args.status : "todo";
      const n = fl.screens.length;
      const s = {
        id: genId("s"), name: args.name || "Pantalla", kind: kind, status: status, desc: args.desc || "",
        x: typeof args.x === "number" ? args.x : 80 + (n % 4) * 300,
        y: typeof args.y === "number" ? args.y : 80 + Math.floor(n / 4) * 240,
        apis: [], links: [], blocks: [],
      };
      if (args.flowRef) {
        const target = (doc.flows || []).find((f) => f.id === args.flowRef);
        if (!target) throw new Error("Flow not found for flowRef: " + args.flowRef + " (use ohana_flow_list for ids)");
        s.flowRef = target.id;
      }
      fl.screens.push(s);
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: s.id, index: fl.screens.length - 1 };
    },
  },
  {
    name: "ohana_flow_update_screen",
    description:
      "Update fields of a screen by id (or numeric index). Only the fields you pass are changed. apis/links, if given, REPLACE the existing arrays.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Screen id (or numeric index)." },
        name: { type: "string" },
        kind: { type: "string", enum: FLOW_KINDS },
        status: { type: "string", enum: FLOW_STATUSES, description: "Build status: todo | wip | done." },
        desc: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        apis: {
          type: "array",
          description: "Replace endpoints: [{endpoint, ctx}].",
          items: { type: "object", properties: { endpoint: { type: "string" }, ctx: { type: "string" } }, required: ["endpoint"], additionalProperties: false },
        },
        links: {
          type: "array",
          description: "Replace linked views: [{url, ctx}].",
          items: { type: "object", properties: { url: { type: "string" }, ctx: { type: "string" } }, required: ["url"], additionalProperties: false },
        },
        flowRef: { type: "string", description: "For kind:\"subflow\": id of the project flow this card links to (opens on click). Pass \"\" to unlink." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const s = findScreen(fl, args.id);
      if (!s) throw new Error("Screen not found: " + args.id);
      if (args.name !== undefined) s.name = args.name;
      if (args.kind !== undefined && FLOW_KINDS.indexOf(args.kind) !== -1) s.kind = args.kind;
      if (args.status !== undefined && FLOW_STATUSES.indexOf(args.status) !== -1) s.status = args.status;
      if (args.desc !== undefined) s.desc = args.desc;
      if (typeof args.x === "number") s.x = args.x;
      if (typeof args.y === "number") s.y = args.y;
      if (Array.isArray(args.apis)) s.apis = args.apis.map((a) => ({ endpoint: a.endpoint || "", ctx: a.ctx || "" }));
      if (Array.isArray(args.links)) s.links = args.links.map((l) => ({ url: l.url || "", ctx: l.ctx || "" }));
      if (args.flowRef !== undefined) {
        if (args.flowRef === "") { delete s.flowRef; }
        else {
          const target = (doc.flows || []).find((f) => f.id === args.flowRef);
          if (!target) throw new Error("Flow not found for flowRef: " + args.flowRef + " (use ohana_flow_list for ids)");
          s.flowRef = target.id;
        }
      }
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: s.id };
    },
  },
  {
    name: "ohana_flow_delete_screen",
    description: "Delete a screen by id (or index) and any edges touching it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Screen id (or numeric index)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const s = findScreen(fl, args.id);
      if (!s) throw new Error("Screen not found: " + args.id);
      const sid = s.id;
      fl.screens = fl.screens.filter((x) => x.id !== sid);
      fl.edges = (fl.edges || []).filter((e) => {
        // component edges: {fromB:"sid/bid", to} (or legacy toB) — same endpoints rule
        const a = e.fromB ? e.fromB.split("/")[0] : e.from;
        const b = e.to || (e.toB ? e.toB.split("/")[0] : null);
        return a !== sid && b !== sid;
      });
      writeFlowDoc(active, doc, fp);
      return { ok: true, deleted: sid };
    },
  },
  {
    name: "ohana_flow_set_layout",
    description:
      "Set a screen's REGION structure from a layout preset: a builtin (vert | sidebar | topbar | topsidebar | subpanel | masterdetail | twocol) or a project layout created in the grid painter (pass its id or name). Then fill each region with ohana_flow_add_section / ohana_flow_add_component (get region cids from ohana_flow_read).",
    inputSchema: {
      type: "object",
      properties: {
        screenId: { type: "string", description: "Screen id (or numeric index)." },
        preset: { type: "string", description: "Builtin id (vert|sidebar|topbar|topsidebar|subpanel|masterdetail|twocol) or the id/name of a project layout (grid painter)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["screenId", "preset"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const s = findScreen(fl, args.screenId);
      if (!s) throw new Error("Screen not found: " + args.screenId);
      if (s.kind === "decision") throw new Error("Decision screens have no layout.");
      ensureLayoutNode(s);
      const keep = []; collectBlocks(s.layout, keep);
      const tree = BUILTIN_LAYOUTS[args.preset];
      if (tree) s.layout = cloneTreeFresh(tree);
      else {
        // project layout from the grid painter: {id, name, grid, regions} in doc.layouts
        const q = String(args.preset).toLowerCase();
        const u = (doc.layouts || []).find((l) => l.id === args.preset || (l.name || "").toLowerCase() === q);
        if (!u) throw new Error("Unknown preset: " + args.preset + ". Builtins: vert|sidebar|topbar|topsidebar|subpanel|masterdetail|twocol. Project layouts: " + ((doc.layouts || []).map((l) => l.name || l.id).join(", ") || "(none)"));
        s.layout = u.grid ? gridLayoutFromPreset(u) : cloneTreeFresh(u.tree || u);
      }
      if (keep.length) { const slot = firstEmptyLeaf(s.layout) || s.layout; slot.children.push.apply(slot.children, keep); }
      writeFlowDoc(active, doc, fp);
      return { ok: true, preset: args.preset, screenId: s.id, layout: publicNode(s.layout, doc.globals) };
    },
  },
  {
    name: "ohana_flow_set_dir",
    description: "Set a region's direction: row (children side by side) or col (stacked). Use the cid from ohana_flow_read; omit containerId for the screen's root region.",
    inputSchema: {
      type: "object",
      properties: {
        screenId: { type: "string", description: "Screen id (or numeric index)." },
        containerId: { type: "string", description: "Region (cid). Default: root region." },
        dir: { type: "string", enum: ["row", "col"], description: "row | col." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["screenId", "dir"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const s = findScreen(fl, args.screenId);
      if (!s) throw new Error("Screen not found: " + args.screenId);
      ensureLayoutNode(s);
      const cont = findContainer(s, args.containerId);
      if (!cont) throw new Error("Region not found: " + args.containerId);
      cont.dir = args.dir === "row" ? "row" : "col";
      writeFlowDoc(active, doc, fp);
      return { ok: true, cid: cont.cid, dir: cont.dir };
    },
  },
  {
    name: "ohana_flow_connect",
    description:
      "Connect two screens (from → to), or a COMPONENT to a screen via fromComponent (dotted edge; connections always LAND on the target card, never on a component). dir: fwd (default) | back | both. label = the interaction (e.g. 'Sí'/'No'); color: positive (green) | negative (red). No-op-safe. You never set coordinates — for clean structure rules (tree for sitemaps, spine for user flows) call ohana_flow_guide.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source screen id (or index)." },
        fromComponent: { type: "string", description: "Component bid on the source screen — the edge leaves that component instead of the card (get bids from ohana_flow_read detail:true)." },
        to: { type: "string", description: "Target screen id (or index)." },
        label: { type: "string", description: "Edge label (interaction/validation)." },
        dir: { type: "string", enum: ["fwd", "back", "both"], description: "Arrow direction (default: fwd)." },
        fromSide: { type: "string", enum: ["top", "right", "bottom", "left"], description: "Port side on the source (default: right)." },
        color: { type: "string", enum: ["normal", "positive", "negative"], description: "Semantic color of the path: normal (blue), positive (green — Sí/Éxito), negative (red — No/Error)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const a = findScreen(fl, args.from), b = findScreen(fl, args.to);
      if (!a) throw new Error("Source screen not found: " + args.from);
      if (!b) throw new Error("Target screen not found: " + args.to);
      fl.edges = fl.edges || [];
      if (args.fromComponent) {
        // component → screen: {fromB:"screenId/bid", to} (rendered dotted; lands on the card)
        ensureLayoutNode(a);
        const bid = String(args.fromComponent).indexOf("/") !== -1 ? String(args.fromComponent).split("/")[1] : String(args.fromComponent);
        if (!findBlock(a, bid)) throw new Error("Component not found on source screen: " + args.fromComponent);
        const fromB = a.id + "/" + bid;
        const dupB = fl.edges.find((e) => e.fromB === fromB && e.to === b.id);
        if (dupB) { if (args.label !== undefined) dupB.label = args.label; writeFlowDoc(active, doc, fp); return { ok: true, updated: true, fromB: fromB, to: b.id }; }
        fl.edges.push({ fromB: fromB, to: b.id, label: args.label || "" });
        writeFlowDoc(active, doc, fp);
        return { ok: true, fromB: fromB, to: b.id };
      }
      const dir = ["fwd", "back", "both"].indexOf(args.dir) !== -1 ? args.dir : "fwd";
      const fromSide = ["top", "right", "bottom", "left"].indexOf(args.fromSide) !== -1 ? args.fromSide : "right";
      const COLORS = { positive: "#34d399", negative: "#f87171" }; // normal → no color (default blue)
      const color = COLORS[args.color];
      const dup = fl.edges.find((e) => e.from === a.id && e.to === b.id);
      if (dup) { dup.label = args.label !== undefined ? args.label : dup.label; dup.dir = dir; if (color) dup.color = color; writeFlowDoc(active, doc, fp); return { ok: true, updated: true, from: a.id, to: b.id }; }
      const edge = { from: a.id, to: b.id, fromSide: fromSide, label: args.label || "", dir: dir };
      if (color) edge.color = color;
      fl.edges.push(edge);
      writeFlowDoc(active, doc, fp);
      return { ok: true, from: a.id, to: b.id };
    },
  },
  {
    name: "ohana_flow_disconnect",
    description: "Remove the edge(s) between two screens (from → to).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source screen id (or index)." },
        to: { type: "string", description: "Target screen id (or index)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const a = findScreen(fl, args.from), b = findScreen(fl, args.to);
      if (!a || !b) throw new Error("Screen not found.");
      const before = (fl.edges || []).length;
      fl.edges = (fl.edges || []).filter((e) => !(e.from === a.id && e.to === b.id));
      writeFlowDoc(active, doc, fp);
      return { ok: true, removed: before - fl.edges.length };
    },
  },
  {
    name: "ohana_flow_layout",
    description:
      "Auto-arrange a flow. User flows get a layered layout (ranks by connection depth, crossings minimized, even spacing); sitemap boards get a tidy TREE (each parent centered over its subtree) — same engines as the app's \"Ordenar\". Call this AFTER building or editing a flow — you do NOT need to set x/y yourself. direction (user flows only): LR (left→right, default) or TB (top→bottom).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["LR", "TB"], description: "Layout direction (default: LR / the flow's saved setting)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const dir = (args.direction === "TB" || args.direction === "LR") ? args.direction : (fl.board === "sitemap" ? "TB" : (doc.layout && doc.layout.dir) || "LR");
      // Sitemaps get the tidy tree (parent centered over subtree), like the app's "Ordenar".
      if (fl.board === "sitemap") treeLayout(fl.screens, fl.edges);
      else layoutScreens(fl.screens, fl.edges, dir);
      doc.layout = doc.layout || {}; doc.layout.dir = dir;
      writeFlowDoc(active, doc, fp);
      return { ok: true, dir: dir, screens: fl.screens.length };
    },
  },
  {
    name: "ohana_flow_guide",
    description: "How to build ORDERED sitemaps and user flows in Moka (conventions + which tools to use). Read this before building so it doesn't end up as a spider web.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({ guide: MOKA_GUIDE }),
  },
  {
    name: "ohana_sitemap_add_page",
    description:
      "SITEMAP: add a page and auto-connect it UNDER a parent (parent→child hierarchy edge), then re-tidy as a vertical tree. You only give the parent and the name — Moka handles position and the edge. Omit `parent` for a top-level (level-1) page. parent = parent page id or name. Marks the flow as a sitemap.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Page name." },
        parent: { type: "string", description: "Parent page id or name. Omit for a level-1 page." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.board = "sitemap";
      let parentId = null;
      if (args.parent) { const p = findScreenRef(fl, args.parent); if (!p) throw new Error("Parent not found: " + args.parent); parentId = p.id; }
      const child = newScreen(args.name, "page");
      fl.screens.push(child);
      if (parentId) { fl.edges = fl.edges || []; fl.edges.push({ from: parentId, to: child.id, label: "" }); } // sides auto by geometry
      treeLayout(fl.screens, fl.edges);
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: child.id, parentId: parentId };
    },
  },
  {
    name: "ohana_flow_add_step",
    description:
      "USER FLOW: add the NEXT step after a screen and auto-connect it in sequence (left→right), then re-tidy horizontally. Give the screen it follows and the name. Omit `after` for the first step. kind = page/modal/dialog/decision/start/end/subflow. Marks the flow as a user flow.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Step name." },
        after: { type: "string", description: "Screen id or name this step follows. Omit for the first step." },
        kind: { type: "string", enum: FLOW_KINDS, description: "Step type (default: page). decision = rombo con salidas Sí/No · subflow = enlaza a otro flujo del proyecto · start/end = inicio y fin del camino." },
        label: { type: "string", description: "Edge label (the trigger), optional." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.board = "userflow";
      let afterId = null;
      if (args.after) { const a = findScreenRef(fl, args.after); if (!a) throw new Error("Screen not found: " + args.after); afterId = a.id; }
      const ns = newScreen(args.name, args.kind);
      fl.screens.push(ns);
      if (afterId) { fl.edges = fl.edges || []; fl.edges.push({ from: afterId, to: ns.id, label: args.label || "" }); } // sides auto by geometry
      layoutScreens(fl.screens, fl.edges, "LR");
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: ns.id };
    },
  },
  {
    name: "ohana_flow_add_branch",
    description:
      "USER FLOW: from a screen (typically a `decision`), add a branch outcome and connect it with a label (e.g. 'Sí' / 'No'). Use one call per outcome. Re-tidies horizontally. from = the screen id or name to branch from.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Screen id or name to branch from." },
        name: { type: "string", description: "Outcome screen name." },
        label: { type: "string", description: "Branch label (e.g. Sí / No)." },
        kind: { type: "string", enum: FLOW_KINDS, description: "Outcome type (default: page)." },
        flowId: { type: "string", description: "Target flow (default: active)." },
      },
      required: ["from", "name"],
      additionalProperties: false,
    },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.board = "userflow";
      const a = findScreenRef(fl, args.from); if (!a) throw new Error("Screen not found: " + args.from);
      const ns = newScreen(args.name, args.kind);
      fl.screens.push(ns);
      fl.edges = fl.edges || []; fl.edges.push({ from: a.id, to: ns.id, label: args.label || "" }); // sides auto by geometry
      layoutScreens(fl.screens, fl.edges, "LR");
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: ns.id };
    },
  },
  {
    name: "ohana_flow_set_board",
    description: "Set a flow's board type: sitemap (vertical hierarchy / tree) or userflow (horizontal sequence). Re-lays out accordingly.",
    inputSchema: { type: "object", properties: { board: { type: "string", enum: ["sitemap", "userflow"] }, flowId: { type: "string" } }, required: ["board"], additionalProperties: false },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.board = args.board === "sitemap" ? "sitemap" : "userflow";
      if (fl.board === "sitemap") treeLayout(fl.screens, fl.edges);
      else layoutScreens(fl.screens, fl.edges, "LR");
      writeFlowDoc(active, doc, fp);
      return { ok: true, board: fl.board };
    },
  },
  {
    name: "ohana_flow_add_section",
    description: "Add a named container to a screen. Hierarchy: Página → REGIONES → SECCIONES → COMPONENTES. Without `region` it creates a root-level container (= a REGION, e.g. Header/Body/Footer); pass `region` (name or cid) to nest a SECTION inside that region. variant: content (default) or empty (empty state). Returns containerId to drop components into.",
    inputSchema: { type: "object", properties: { screenId: { type: "string" }, name: { type: "string" }, region: { type: "string", description: "Region name or cid to nest the section in. Omit to create a region at the card root." }, variant: { type: "string", enum: ["content", "empty"] }, flowId: { type: "string" } }, required: ["screenId", "name"], additionalProperties: false },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const s = findScreen(fl, args.screenId);
      if (!s) throw new Error("Screen not found: " + args.screenId);
      if (s.kind === "decision") throw new Error("Decision screens can't hold sections.");
      ensureLayoutNode(s);
      let host = s.layout;
      if (args.region) {
        let reg = findContainer(s, args.region);
        if (!reg) (function walk(n) { if (reg) return; if (isCont(n)) { if ((n.name || "").toLowerCase() === String(args.region).toLowerCase()) { reg = n; return; } n.children.forEach(walk); } })(s.layout);
        if (!reg) throw new Error("Region not found: " + args.region);
        host = reg;
      }
      const sec = { cid: genId("c"), dir: "col", name: args.name || "Sección", children: [] };
      if (args.variant) sec.variant = args.variant;
      host.children.push(sec);
      writeFlowDoc(active, doc, fp);
      return { ok: true, containerId: sec.cid, screenId: s.id };
    },
  },
  {
    name: "ohana_flow_add_component",
    description: "Add a COMPONENT into a screen's section (Button, Data table, Chart, Acordeón, etc.). Give the section by name or containerId; if omitted, uses the first section (or root). icon is a Lucide-style key. desc is the detail (what it says / how it looks / behaves); items are sub-elements.",
    inputSchema: { type: "object", properties: { screenId: { type: "string" }, section: { type: "string", description: "Section name or containerId." }, name: { type: "string" }, icon: { type: "string" }, desc: { type: "string" }, items: { type: "array", items: { type: "string" } }, flowId: { type: "string" } }, required: ["screenId", "name"], additionalProperties: false },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      const s = findScreen(fl, args.screenId);
      if (!s) throw new Error("Screen not found: " + args.screenId);
      if (s.kind === "decision") throw new Error("Decision screens can't hold components.");
      ensureLayoutNode(s);
      let cont = null;
      if (args.section) {
        cont = findContainer(s, args.section);
        if (!cont) (function walk(n) { if (cont) return; if (isCont(n)) { if ((n.name || "").toLowerCase() === String(args.section).toLowerCase()) { cont = n; return; } n.children.forEach(walk); } })(s.layout);
      }
      if (!cont) cont = s.layout.children.find(isCont) || s.layout;
      const block = { bid: genId("b"), type: args.name, icon: args.icon || null, title: args.name, desc: args.desc || "", items: Array.isArray(args.items) ? args.items.slice() : [] };
      cont.children.push(block);
      writeFlowDoc(active, doc, fp);
      return { ok: true, bid: block.bid, containerId: cont.cid, screenId: s.id };
    },
  },
  {
    name: "ohana_flow_add_note",
    description: "Add a sticky note to the active flow's canvas. color: yellow (default) | blue | green | pink.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, color: { type: "string", enum: ["yellow", "blue", "green", "pink"] }, flowId: { type: "string" } }, required: ["text"], additionalProperties: false },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.notes = fl.notes || [];
      const n = { id: genId("n"), text: args.text || "", x: 40, y: 40, color: args.color || "yellow" };
      fl.notes.push(n);
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: n.id };
    },
  },
  {
    name: "ohana_flow_add_label",
    description: "Add a section title (heading) to the active flow's canvas — labels a part of the board with a title + context.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, ctx: { type: "string" }, flowId: { type: "string" } }, required: ["title"], additionalProperties: false },
    handler: (args) => {
      const active = resolveActive();
      const { doc, path: fp } = readFlowDoc(active);
      const fl = targetFlow(doc, args, active);
      fl.labels = fl.labels || [];
      const l = { id: genId("l"), title: args.title || "", ctx: args.ctx || "", x: 40, y: 40, w: 360 };
      fl.labels.push(l);
      writeFlowDoc(active, doc, fp);
      return { ok: true, id: l.id };
    },
  },
];

const TOOL_MAP = {};
TOOLS.forEach((t) => (TOOL_MAP[t.name] = t));

// Light schema validation before the handler runs: required fields must be
// present and enum values must match. Handlers used to fall back silently
// (invalid kind → "page", missing message → empty comment), which broke the
// client's assumption that the declared inputSchema is enforced.
function validateToolArgs(tool, args) {
  const sch = tool.inputSchema || {};
  const props = sch.properties || {};
  (sch.required || []).forEach((k) => {
    if (args[k] === undefined || args[k] === null) throw new Error("Falta el argumento requerido: " + k);
  });
  Object.keys(args || {}).forEach((k) => {
    const p = props[k];
    if (p && Array.isArray(p.enum) && args[k] !== undefined && p.enum.indexOf(args[k]) === -1) {
      throw new Error("Valor inválido para " + k + ": \"" + args[k] + "\" (esperado: " + p.enum.join(" | ") + ")");
    }
  });
}

// ─── JSON-RPC plumbing ─────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleMessage(msg) {
  const { id, method, params } = msg;
  touchAlive(); // refresh the heartbeat on every message

  // Notifications (no id) → never respond
  if (id === undefined || id === null) {
    return;
  }

  try {
    switch (method) {
      case "initialize":
        sendResult(id, {
          protocolVersion:
            (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "ohana-comments", version: "0.5.0" },
        });
        return;

      case "ping":
        sendResult(id, {});
        return;

      case "tools/list":
        sendResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;

      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const tool = TOOL_MAP[name];
        if (!tool) {
          sendError(id, -32602, "Unknown tool: " + name);
          return;
        }
        try {
          validateToolArgs(tool, args);
          const result = tool.handler(args);
          sendResult(id, {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          });
        } catch (err) {
          // Tool-level error → return as isError content (model-visible)
          sendResult(id, {
            content: [{ type: "text", text: "Error: " + err.message }],
            isError: true,
          });
        }
        return;
      }

      default:
        sendError(id, -32601, "Method not found: " + method);
        return;
    }
  } catch (err) {
    sendError(id, -32603, "Internal error: " + err.message);
  }
}

// ─── Read newline-delimited JSON from stdin ────────────────────────
touchAlive(); // announce presence as soon as the server starts
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log("failed to parse line:", line);
      continue;
    }
    handleMessage(msg);
  }
});

process.stdin.on("end", () => process.exit(0));

log("ohana-comments MCP server started");
