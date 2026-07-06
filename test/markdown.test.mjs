// Round-trip guard for the WYSIWYG markdown engine (src/lib/markdown.js):
//   md → renderMarkdown → (mini-DOM) → htmlToMd → md′
// must be CANONICALLY equal: renderMarkdown(md′) === renderMarkdown(md).
// If this breaks, editing a doc in the reader corrupts user files.
import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const MD = require("../src/lib/markdown.js");

// ── Mini-DOM: parses ONLY the HTML subset renderMarkdown generates ──
const VOID = new Set(["br", "hr"]);
function decode(t) { return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
class N {
  constructor(type, tag) {
    this.nodeType = type; this.tagName = tag ? tag.toUpperCase() : undefined;
    this.childNodes = []; this.attrs = {}; this.textContent = "";
  }
  get className() { return this.attrs.class || ""; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  _text() { return this.nodeType === 3 ? this.textContent : this.childNodes.map((c) => c._text()).join(""); }
  _desc(tag, out) { for (const c of this.childNodes) { if (c.nodeType === 1) { if (c.tagName === tag.toUpperCase()) out.push(c); c._desc(tag, out); } } return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    if (sel === ":scope > li") return this.childNodes.filter((c) => c.nodeType === 1 && c.tagName === "LI");
    let cur = [this];
    for (const part of sel.trim().split(/\s+/)) {
      const next = [];
      for (const c of cur) c._desc(part, next);
      cur = next;
    }
    return cur;
  }
}
Object.defineProperty(N.prototype, "textContent", {
  get() { return this.nodeType === 3 ? this._t : this._text(); },
  set(v) { this._t = v; },
});
function parseHTML(html) {
  const root = new N(1, "div");
  const stack = [root];
  const re = /<(\/)?([a-z0-9]+)((?:\s+[\w-]+="[^"]*")*)\s*\/?>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) { const t = new N(3); t.textContent = decode(text); top.childNodes.push(t); continue; }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const el = new N(1, tag);
    if (attrs) { const ar = /([\w-]+)="([^"]*)"/g; let a; while ((a = ar.exec(attrs))) el.attrs[a[1]] = decode(a[2]); }
    top.childNodes.push(el);
    if (!VOID.has(tag.toLowerCase())) stack.push(el);
  }
  return root;
}

function roundTrip(md) {
  const html1 = MD.renderMarkdown(md);
  const md2 = MD.htmlToMd(parseHTML(html1));
  const html2 = MD.renderMarkdown(md2);
  return { md2, html1, html2 };
}
function assertCanonical(md, label) {
  const { md2, html1, html2 } = roundTrip(md);
  assert.strictEqual(html2, html1, label + " — round-trip drifted.\n--- md′ ---\n" + md2);
}

test("round-trip: headings, énfasis, code y links", () => {
  assertCanonical([
    "# Título uno",
    "",
    "## Sub con **fuerte** y `codigo`",
    "",
    "Párrafo con **negrita**, *cursiva*, `inline` y [un link](https://ohana.app).",
  ].join("\n"), "básicos");
});

test("round-trip: listas, cita y hr", () => {
  assertCanonical([
    "- item uno",
    "- item **dos**",
    "",
    "1. primero",
    "2. segundo",
    "",
    "> una cita",
    "> de dos líneas",
    "",
    "---",
  ].join("\n"), "listas");
});

test("round-trip: fenced code conserva el contenido EXACTO", () => {
  const code = 'const x = { a: 1, b: "dos" };\nif (x.a) console.log("<hola & adiós>");';
  const md = "```js\n" + code + "\n```";
  const { md2 } = roundTrip(md);
  assert.ok(md2.includes(code), "el código cambió:\n" + md2);
  assertCanonical(md, "fenced");
});

test("round-trip: tabla con swatches de color", () => {
  assertCanonical([
    "| Token | Valor | Uso |",
    "| --- | --- | --- |",
    "| --primary | #3D3BF5 | Acción primaria |",
    "| texto | normal | con **negrita** |",
  ].join("\n"), "tabla");
});

test("no pierde contenido de texto (documento mixto)", () => {
  const md = [
    "# Handoff — Monitor",
    "",
    "Contexto del proyecto con [referencia](https://linear.app) y `flow.json`.",
    "",
    "## Historias",
    "- Como operador quiero **configurar** el umbral",
    "- Dado el estado *activo*, cuando guardo, entonces persiste",
    "",
    "> Pregunta abierta: ¿el timing es por canal?",
  ].join("\n");
  const { md2 } = roundTrip(md);
  for (const frag of ["Handoff — Monitor", "configurar", "flow.json", "Pregunta abierta", "linear.app", "operador quiero"]) {
    assert.ok(md2.includes(frag), "se perdió: " + frag + "\n" + md2);
  }
});
