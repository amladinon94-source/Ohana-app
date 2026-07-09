---
name: ohana-design
description: Read and maintain design.md — the design source of truth (tokens, principles, voice & tone, component patterns, decisions) for the prototype currently open in the Ohana HTML previewer. Use when the user asks to update the design system, record a design decision, check the tokens/principles, keep the UI consistent, or set up design.md. Triggers: "update design.md", "what does the design system say", "record this design decision", "what are the tokens", "keep the prototype visually consistent".
---

# Ohana Design Notes (design.md)

`design.md` is the **design source of truth** for the prototype open in Ohana:
tokens (color / type / spacing), principles, voice & tone, component patterns, and a
log of decisions. The designer edits it in Ohana's Design panel; Claude reads it to
stay consistent and updates it as the design evolves. Ohana **watches** the file, so
changes appear live in the panel.

## Targeting — which prototype?

Always the one open in Ohana. Read `~/.ohana/active.json`:

```json
{ "projectDir": ".../landing", "currentFile": ".../landing.html",
  "designFile": ".../landing/design.md", ... }
```

`design.md` lives **next to the prototype** (project root), at `designFile`.

## Workflow

**Before changing any UI**, read `design.md` first so your changes match the existing
tokens, voice, and patterns. After a meaningful design change, update it.

### Preferred: MCP tools (`ohana-comments` server)

| Tool | What it does |
|------|--------------|
| `ohana_read_design` | Read the current design.md (returns `exists`, `path`, `content`) |
| `ohana_update_design` | Write the full markdown content (creates if missing) |
| `ohana_init_design` | Scaffold design.md from a starter template (if absent) |

`ohana_update_design` replaces the whole file — read first, edit the markdown, write it
back whole. Keep it tight and structured; this is a reference, not an essay.

### Fallback: edit the file directly

If the MCP server isn't connected, read `~/.ohana/active.json` → open its `designFile`
→ edit with Read / Edit / Write.

## Structure to keep

```markdown
# Design — <project>

## Principles          ← 3–6 rules that guide the design
## Tokens
### Color              ← table: token | value (#hex) | usage
### Typography         ← display / body / scale
### Spacing & radius
## Voice & tone        ← how the product's copy speaks
## Component patterns  ← buttons, inputs, cards, states
## Decisions          ← dated log: "- 2026-06-22 — X because Y"
```

Tips:
- In the Color table, put real hex values — Ohana renders a swatch next to each.
- Append to **Decisions** (don't rewrite history) when a choice is made; date it.
- Be specific and actionable. If a comment thread resolves into a rule, fold it in here.
- If `design.md` doesn't exist, offer to create it with `ohana_init_design`.
