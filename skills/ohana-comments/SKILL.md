---
name: ohana-comments
description: Create, read, reply to and resolve Figma-style comments on the prototype currently open in the Ohana HTML previewer. Use when the user asks to leave a comment, review comments, reply to feedback, resolve threads, or otherwise manage comments/findings on what they have open in Ohana. Triggers: "comenta en Ohana", "deja un comentario", "responde el comentario", "resuelve el hilo", "qué comentarios hay", "revisa los comentarios del prototipo".
---

# Ohana Comments

Manage the human + Claude comment threads of the prototype **currently open in Ohana**.
Comments are Figma-style: each one is anchored to an element and shows as a numbered
pin over the page, plus a row in the Comments panel. Threads support replies and a
resolved/open status.

## Targeting — which prototype?

Always the one open in Ohana. Ohana writes the active prototype to
`~/.ohana/active.json`:

```json
{ "projectDir": "...", "currentFile": ".../landing.html",
  "ohanaDir": ".../.ohana", "findingsFile": ".../.ohana/findings.json", "mode": "html" }
```

The comments themselves live in that `findingsFile` (`.ohana/findings.json`, an array).
Ohana **watches** this file, so any change you make appears live in the app — no reload.

## Preferred path: MCP tools

If the `ohana-comments` MCP server is connected, use its tools — this is the clean way:

| Tool | What it does |
|------|--------------|
| `ohana_status` | Which prototype is open + open/resolved counts |
| `ohana_list_comments` | List comments (filter `status`: all/open/resolved) |
| `ohana_create_comment` | New comment. Anchor with `anchorAiId` (a `data-ai-id`) or `anchorSelector` |
| `ohana_reply` | Reply to a thread by `id` (optionally `resolve: true`) |
| `ohana_resolve` | Resolve / reopen a thread by `id` |
| `ohana_delete` | Delete a thread by `id` |

Typical flow:
1. `ohana_status` to confirm what's open.
2. To anchor well, prefer a real `data-ai-id` from the markup. Read the open
   `currentFile` and pick the closest element's `data-ai-id`; if none exists, pass a
   stable CSS `anchorSelector` instead. A comment with no anchor still works (it just
   has no pin).
3. `ohana_create_comment` / `ohana_reply` / `ohana_resolve`.

## Fallback: edit the file directly

If the MCP server is not available, read `~/.ohana/active.json` → open its
`findingsFile` → edit the JSON array directly (Read / Edit / Write). Comment shape:

```json
{
  "id": "cmt_<unique>",
  "kind": "comment",
  "author": "Claude",
  "authorType": "agent",
  "anchor": { "aiId": "hero-cta", "selector": "button.cta", "label": "hero-cta" },
  "message": "El contraste del CTA está por debajo de AA.",
  "status": "open",
  "createdAt": "<ISO>",
  "replies": [
    { "author": "Ana", "authorType": "person", "message": "Dale, súbelo", "at": "<ISO>" }
  ]
}
```

Rules when editing by hand:
- Append, don't reorder — Ohana's pins are numbered by array order.
- `authorType`: `"person"` for humans, `"agent"` for Claude/agents.
- `status`: `"open"` or `"resolved"`.
- Anchor to a `data-ai-id` when one exists; else a CSS selector; else `null`.

## Notes

- This is a **human + Claude** comment channel — there are no agent "findings" badges
  anymore. Keep messages concrete and actionable.
- If `~/.ohana/active.json` is missing, Ohana has nothing open — tell the user to open
  a file or repo in Ohana first.
