// Guards for the Sugiyama layout engine (mcp/ohana-comments-server.js →
// layoutScreens, the same algorithm the app refines with real heights):
// ranks in columns, no same-column overlaps, dummy lanes for long edges.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../mcp/ohana-comments-server.js"), "utf8");
// Extract the layout engines plus their shared dimension helpers (module-level).
const cut = (name) => {
  const s = src.indexOf("function " + name);
  assert.ok(s > 0, name + " no encontrado en el MCP");
  return src.slice(s, src.indexOf("\n}\n", s) + 3);
};
const prelude = cut("estScreenHeight") + cut("screenDim");
const layoutScreens = eval("(() => { " + prelude + cut("layoutScreens") + "; return layoutScreens; })()");
const treeLayout = eval("(() => { " + prelude + cut("treeLayout") + "; return treeLayout; })()");

const mk = (ids, decision) => ids.map((id) => ({ id, kind: decision === id ? "decision" : "page" }));

test("LR: ranks avanzan a la derecha siguiendo las conexiones", () => {
  const screens = mk(["A", "B", "C", "D"]);
  const edges = [{ from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "D" }];
  layoutScreens(screens, edges, "LR");
  const x = Object.fromEntries(screens.map((s) => [s.id, s.x]));
  assert.ok(x.A < x.B && x.B < x.C && x.C < x.D, "los ranks no avanzan: " + JSON.stringify(x));
});

test("LR: sin solapamientos en la misma columna (con decisión y rama)", () => {
  const screens = mk(["A", "B", "C", "D", "E", "F"], "C");
  const edges = [
    { from: "A", to: "B" }, { from: "B", to: "C" },
    { from: "C", to: "D", label: "Sí" }, { from: "C", to: "F", label: "No" },
    { from: "D", to: "E" }, { from: "A", to: "E" }, // arista larga → carriles dummy
  ];
  layoutScreens(screens, edges, "LR");
  const cols = {};
  screens.forEach((s) => (cols[s.x] = cols[s.x] || []).push(s));
  for (const col of Object.values(cols)) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) {
      assert.ok(col[i].y - col[i - 1].y >= 100, "solapamiento en columna: " + col[i - 1].id + " / " + col[i].id);
    }
  }
});

test("TB: la dirección vertical también rankea", () => {
  const screens = mk(["A", "B", "C"]);
  const edges = [{ from: "A", to: "B" }, { from: "B", to: "C" }];
  layoutScreens(screens, edges, "TB");
  assert.ok(screens[0].y < screens[1].y && screens[1].y < screens[2].y, "TB no rankea hacia abajo");
});

test("ciclos no revientan (back-edge detection)", () => {
  const screens = mk(["A", "B", "C"]);
  const edges = [{ from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "A" }];
  layoutScreens(screens, edges, "LR"); // no throw + posiciones finitas
  screens.forEach((s) => { assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), "posición inválida en " + s.id); });
});

test("sitemap: el padre queda centrado sobre su subárbol (tidy tree)", () => {
  const screens = mk(["root", "h1", "h2"]);
  const edges = [{ from: "root", to: "h1" }, { from: "root", to: "h2" }];
  treeLayout(screens, edges);
  const [r, a, b] = screens;
  assert.ok(a.y === b.y && a.y > r.y, "las hijas no quedan en el nivel bajo el padre");
  const cx = (s) => s.x + 160; // page width 320
  assert.ok(Math.abs(cx(r) - (cx(a) + cx(b)) / 2) <= 1, "el padre no queda centrado sobre sus hijas");
});

test("alturas estimadas: una tarjeta con muchas secciones separa más", () => {
  const big = { id: "big", kind: "page", layout: { dir: "col", children: [
    { dir: "col", name: "S1", children: [{ type: "Button" }, { type: "Input" }, { type: "Input" }] },
    { dir: "col", name: "S2", children: [{ type: "Table" }, { type: "Chart" }] },
  ] } };
  const screens = [{ id: "a", kind: "page" }, big, { id: "c", kind: "page" }];
  const edges = [{ from: "a", to: "big" }, { from: "a", to: "c" }];
  layoutScreens(screens, edges, "LR");
  // big y c comparten columna; la separación debe superar la altura estimada de big
  const gap = Math.abs(big.y - screens[2].y);
  assert.ok(gap >= 120, "no respeta la altura estimada (gap=" + gap + ")");
});
