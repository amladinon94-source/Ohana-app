// Ohana — markdown engine (pure, shared).
// Render (md → HTML) + WYSIWYG serialize (rendered DOM → md), plus the inline
// helpers and the fenced-code highlighter. No DOM globals: htmlToMd walks the
// node you pass in. Loaded in the renderer as window.OhanaMD and require()-able
// from node for tests (test/markdown.test.mjs guards the round-trip).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OhanaMD = api;
})(typeof self !== "undefined" ? self : this, function () {
  function escapeHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escMd(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inlineMd(s) {
    s = escMd(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => {
      const safe = /^(https?:|mailto:|#|\/)/i.test(u) ? u : "#";
      return '<a data-href="' + safe + '" href="' + safe + '">' + t + "</a>";
    });
    return s;
  }
  function cellWithSwatch(text) {
    const html = inlineMd(text);
    const hex = text.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hex) return '<span class="swatch" style="background:' + hex[0] + '"></span>' + html;
    return html;
  }

  // ── Lightweight syntax highlighting for fenced code blocks ──
  // Operates on HTML-escaped code (so it's injection-safe) and wraps tokens in
  // <span class="tok-*">. Covers the languages our docs use (json/js/ts/html/
  // css/bash); anything else falls back to the generic tokenizer.
  function hlJson(s) {
    return s.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, str, colon, kw, num) => {
        if (str !== undefined) return colon ? '<span class="tok-prop">' + str + '</span>' + colon : '<span class="tok-str">' + str + '</span>';
        if (kw !== undefined) return '<span class="tok-bool">' + kw + '</span>';
        if (num !== undefined) return '<span class="tok-num">' + num + '</span>';
        return m;
      });
  }
  function hlGeneric(s) {
    const re = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(true|false|null|undefined)\b|\b(const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|async|await|yield|try|catch|finally|throw|typeof|instanceof|then|fi|done|echo|local|public|private|static|interface|type|enum)\b|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
    return s.replace(re, (m, block, line, str, bool, kw, num) => {
      if (block !== undefined) return '<span class="tok-com">' + block + '</span>';
      if (line !== undefined) return '<span class="tok-com">' + line + '</span>';
      if (str !== undefined) return '<span class="tok-str">' + str + '</span>';
      if (bool !== undefined) return '<span class="tok-bool">' + bool + '</span>';
      if (kw !== undefined) return '<span class="tok-key">' + kw + '</span>';
      if (num !== undefined) return '<span class="tok-num">' + num + '</span>';
      return m;
    });
  }
  function hlHtml(s) {
    // Tags arrive escaped as &lt;tag …&gt; — color tag name, attrs and strings.
    return s.replace(/(&lt;\/?)([\w:-]+)((?:[^&]|&(?!gt;))*?)(\/?&gt;)/g, (m, open, name, attrs, close) => {
      const a = attrs.replace(/([\w:-]+)(=)("[^"]*"|'[^']*')/g,
        '<span class="tok-prop">$1</span>$2<span class="tok-str">$3</span>');
      return open + '<span class="tok-tag">' + name + '</span>' + a + close;
    });
  }
  function highlightCode(raw, lang) {
    const esc = escMd(raw);
    lang = (lang || "").toLowerCase();
    try {
      if (lang === "json") return hlJson(esc);
      if (lang === "html" || lang === "xml" || lang === "svg" || lang === "vue") return hlHtml(esc);
      return hlGeneric(esc); // js/ts/jsx/css/bash/sh/… and unknown
    } catch (e) { return esc; }
  }

  function renderMarkdown(md) {
    const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
    let out = "";
    let i = 0;
    let listType = null; // "ul" | "ol"
    const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };

    while (i < lines.length) {
      let line = lines[i];

      // Fenced code block (with language-aware syntax highlighting)
      if (/^```/.test(line)) {
        closeList();
        const lang = (line.match(/^```\s*([\w+-]+)/) || [])[1] || "";
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        const cls = lang ? ' class="language-' + lang.replace(/[^\w+-]/g, "") + '"' : "";
        out += "<pre><code" + cls + ">" + highlightCode(buf.join("\n"), lang) + "</code></pre>";
        continue;
      }

      // Table: header row + separator
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        closeList();
        const parseRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const headers = parseRow(line);
        i += 2;
        let t = "<table><thead><tr>" + headers.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>";
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const cells = parseRow(lines[i]);
          t += "<tr>" + cells.map((c) => "<td>" + cellWithSwatch(c) + "</td>").join("") + "</tr>";
          i++;
        }
        t += "</tbody></table>";
        out += t;
        continue;
      }

      // Headings
      let h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); const lvl = h[1].length; out += "<h" + lvl + ">" + inlineMd(h[2]) + "</h" + lvl + ">"; i++; continue; }

      // Horizontal rule
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out += "<hr>"; i++; continue; }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        closeList();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(inlineMd(lines[i].replace(/^\s*>\s?/, ""))); i++; }
        out += "<blockquote>" + buf.join("<br>") + "</blockquote>";
        continue;
      }

      // Unordered list
      if (/^\s*[-*]\s+/.test(line)) {
        if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
        out += "<li>" + inlineMd(line.replace(/^\s*[-*]\s+/, "")) + "</li>";
        i++; continue;
      }
      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listType !== "ol") { closeList(); out += "<ol>"; listType = "ol"; }
        out += "<li>" + inlineMd(line.replace(/^\s*\d+\.\s+/, "")) + "</li>";
        i++; continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }

      // Paragraph (gather consecutive non-blank, non-structural lines)
      closeList();
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) {
        para.push(inlineMd(lines[i])); i++;
      }
      if (para.length) out += "<p>" + para.join("<br>") + "</p>";
      else { i++; }
    }
    closeList();
    return out;
  }

  function htmlToMd(root) {
    const inline = (node) => {
      let s = "";
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { s += n.textContent; return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        if (tag === "br") { s += "\n"; return; }
        if (tag === "strong" || tag === "b") { const t = inline(n); s += t.trim() ? "**" + t + "**" : t; return; }
        if (tag === "em" || tag === "i") { const t = inline(n); s += t.trim() ? "*" + t + "*" : t; return; }
        if (tag === "code") { s += "`" + n.textContent + "`"; return; }
        if (tag === "a") { s += "[" + inline(n) + "](" + (n.getAttribute("href") || "") + ")"; return; }
        s += inline(n); // span & friends → contents only
      });
      return s;
    };
    const blocks = [];
    root.childNodes.forEach((n) => {
      if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) blocks.push(t); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      const hm = /^h([1-6])$/.exec(tag);
      if (hm) { blocks.push("#".repeat(parseInt(hm[1], 10)) + " " + inline(n).trim()); return; }
      if (tag === "p" || tag === "div") { const t = inline(n).trim(); if (t) blocks.push(t); return; }
      if (tag === "ul" || tag === "ol") {
        const items = []; let k = 1;
        n.querySelectorAll(":scope > li").forEach((li) => items.push((tag === "ul" ? "- " : (k++) + ". ") + inline(li).trim()));
        if (items.length) blocks.push(items.join("\n")); return;
      }
      if (tag === "blockquote") { blocks.push(inline(n).split("\n").map((l) => "> " + l).join("\n")); return; }
      if (tag === "pre") {
        const code = n.querySelector("code");
        const lang = code && (code.className.match(/language-([\w+-]+)/) || [])[1] || "";
        blocks.push("```" + lang + "\n" + (code ? code.textContent : n.textContent).replace(/\n$/, "") + "\n```"); return;
      }
      if (tag === "hr") { blocks.push("---"); return; }
      if (tag === "table") {
        const esc = (t) => t.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
        const heads = Array.prototype.map.call(n.querySelectorAll("thead th"), (th) => esc(inline(th)));
        const rows = Array.prototype.map.call(n.querySelectorAll("tbody tr"), (tr) =>
          "| " + Array.prototype.map.call(tr.querySelectorAll("td"), (td) => esc(inline(td))).join(" | ") + " |");
        if (heads.length) blocks.push("| " + heads.join(" | ") + " |\n|" + heads.map(() => " --- ").join("|") + "|\n" + rows.join("\n"));
        return;
      }
      const t = inline(n).trim(); if (t) blocks.push(t); // unknown block → paragraph
    });
    return blocks.join("\n\n") + "\n";
  }

  return { escapeHtml, escMd, inlineMd, cellWithSwatch, highlightCode, renderMarkdown, htmlToMd };
});
