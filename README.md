# Ohana 🌺

An HTML (and frontend repo) previewer with superpowers, for designers who
work with an AI agent in the terminal. Local, no accounts, no cloud.

- **Live reload** — save and Ohana updates itself.
- **Moka** — layout mode: build the project's user flow / sitemap and export it as a brief for your agent to build in HTML or in your repo.
- **Figma-style comments** — drop pins anchored to elements; your agent reads them and replies.
- **design.md** — the design source of truth (tokens, principles, voice), editable in the app.
- **Inspector, breakpoints, zoom, and screenshots** to iterate fast.

> Open source · MIT · macOS

## Download and install

**Requirements:** macOS 13+ and [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/amladinon94-source/Ohana-app.git
cd Ohana-app
npm install
npm start
```

That's all it takes to get Ohana running. If you'd rather have an app installed in `/Applications`
(dock icon, double-click and go), build it yourself — see
[Build as a native .app](#build-as-a-native-app). Since the app isn't signed
with an Apple certificate, the first time you open it, use right-click → **Open**.

Open a file directly:

```bash
npm start -- /path/to/your/file.html
```

Or drag any `.html` file onto the window.

## Working with your agent

```
Terminal:                           Ohana:
┌─────────────────────────┐        ┌──────────────────────┐
│ $ agent                 │        │                      │
│ > build a landing at    │  ───▶  │  [updates itself]    │
│   ./landing.html        │        │                      │
│ > leave a comment       │  ───▶  │  [the pin appears]   │
│   on the CTA            │        │                      │
└─────────────────────────┘        └──────────────────────┘
```

## Comments (Figma-style)

Turn on comment mode (💬 button or `⇧⌘M`), click on any element, and
type. A numbered pin stays anchored to the element (via `data-ai-id` or a CSS selector).
The **Comments** panel (`⇧⌘F`) lists the threads; each one supports replies and resolving.

Comments live in `.ohana/findings.json`, next to the prototype. Ohana watches that
file, so any change — yours or the agent's — shows up live.

## design.md

`design.md` is the **design source of truth**: tokens, principles, voice and tone,
patterns, and a decisions log. It lives in the **Design** section of the project
navigator: markdown preview + WYSIWYG editing (you edit right on the render), with color
swatches in the token tables. Your agent reads it before touching the UI and keeps it up to date.

## Projects — the workspace

One **folder = one project**. When you open it, Ohana creates its skeleton and the **left
navigator** lists its artifacts: **Flows** (Moka boards) · **Prototypes** (.html) ·
**Plans** · **Handoff** · **Design**. The list stays live: files or flows your agent adds,
renames, or deletes on disk show up on their own. Each artifact opens in the center (the artifact
decides the mode: a flow opens Moka, an HTML file opens the preview, a .md file opens the reader).
The tabs up top are color-coded contexts: 🟢 project · 🔵 repo (localhost) · 🟡 URL,
and each tab is an independent space that remembers where it was.

The full cycle: **Flows → Prototypes (you iterate) → Handoff → Repository** — with
"Generate handoff" (✦) the agent distills the project into `handoff/` (Linear-ready), and with
"Ship to repository" (↗) it implements it in the repo you choose.

## Moka — from user flow to code

Moka is the layout canvas: it opens when you enter a **flow** from the navigator.
FigJam-like but opinionated, saved in `.ohana/flow.json` as living documentation that your
agent reads and writes.

- **Sitemap ⇄ User flow** — the type is chosen **when you create** the flow (the "+" button): *Sitemap*
  (vertical hierarchy, tree) or *User flow* (horizontal sequence with branches). Moka arranges
  the cards for you (Sugiyama layout with lanes for the long connections).
- **Opinionated nodes** — Page, Modal, Dialog, **Decision** (Yes/No outputs),
  **Start/End** (they mark the journey), and **Subflow** (links to another flow in the project).
- **Page → Regions → Sections → Components** — regions define the card's layout
  (Header/Body/Footer, a classic preset, or your own drawn in the **layout
  editor**, grid-style); inside them go sections (named organisms) and, within those, components
  from a catalog (Button, Data table, Chart, Accordion…), from your personal library, or from your
  design system (in repos). You annotate the detail for each one. A component can
  **connect to another page** (dashed edge) and become **global** (reused across screens).
- **Flows belong to the project** — every board in the folder lives together in the navigator.
- **"To prototype"** — links the flow to an HTML file in `prototypes/` and the agent builds it;
  "View prototype" opens it in the same project so you can iterate.

**Taking it to a real product:** with **Export** you send the flow as a structured prompt to the
tab's terminal; your agent builds the **HTML prototype** (free-form editing) or implements the
views in your **repository** with the real components of your design system. You refer to the
screens by name; Ohana identifies them internally so the agent doesn't get confused.

Each project gets a `.ohana/MOKA.md` with the conventions the agent should follow.

## Agent integration (MCP + skills)

Ohana ships a dependency-free MCP server so your agent can manage comments and the
`design.md` of the prototype you have open (just like the Linear tools).

1. Register it as an MCP server in your agent's config (the `mcpServers` format is
   standard and used by several MCP-compatible agents):

   ```json
   {
     "mcpServers": {
       "ohana-comments": {
         "type": "stdio",
         "command": "node",
         "args": ["/path/to/ohana/mcp/ohana-comments-server.js"]
       }
     }
   }
   ```

   (some agents also register it via CLI; check how yours adds MCP servers.)

2. Restart your agent's session. You'll have:

   | Tool                     | Action                                            |
   |--------------------------|---------------------------------------------------|
   | `ohana_status`           | Which prototype is open + counts                  |
   | `ohana_list_comments`    | List comments (filter open/resolved)              |
   | `ohana_create_comment`   | Create a comment anchored to an element           |
   | `ohana_reply`            | Reply to a thread (with optional `resolve`)       |
   | `ohana_resolve`          | Resolve / reopen                                  |
   | `ohana_delete`           | Delete                                            |
   | `ohana_read_design`      | Read `design.md`                                  |
   | `ohana_update_design`    | Write `design.md`                                 |
   | `ohana_init_design`      | Create `design.md` from a template                |
   | `ohana_flow_read` / `_list` | Read the active flow / list flows              |
   | `ohana_sitemap_add_page` | Sitemap: page under a parent (connects + orders)  |
   | `ohana_flow_add_step` / `_add_branch` | User flow: next step / branch        |
   | `ohana_flow_layout`      | Arrange the flow (automatic layout)               |
   | `ohana_flow_guide`       | Conventions for building sitemaps/flows           |

   (plus `ohana_flow_add_screen/update_screen/delete_screen/add_section/add_component/connect/set_layout/…` — see the **MCP Reference** inside the app, `?` button.)

Targeting is automatic: Ohana publishes the active prototype to `~/.ohana/active.json`.

## Global configuration (`~/.ohana/config.json`)

Optional. Today it supports one key:

```json
{ "trustedHosts": ["*.acme.dev", "stage.acme.com"] }
```

`trustedHosts` — development domains whose self-signed/internal certificates you accept
when previewing (in addition to `localhost`, which is always included). `*.acme.dev` also covers
`acme.dev`. Handy if your dev servers run behind an internal domain with its own HTTPS.

There's also a per-project `.ohana/config.json` (separate file) with `componentsSource`
(where the Components panel reads your design system from) and `storybookUrl`; Ohana
writes it for you when you configure those from the UI.

Included skills for agents that support them: `ohana-comments` and `ohana-design` (copy them into your agent's skills folder).

## Build as a native .app

```bash
brew install imagemagick      # one-time only, to regenerate the icon
bash assets/generate-icon.sh  # regenerates assets/icon.icns from assets/logo.png
npm run build
```

Open `dist/Ohana-<version>.dmg` and drag the app into `/Applications`.

## Shortcuts

| Action                  | Shortcut         |
|-------------------------|------------------|
| Open file               | ⌘O               |
| Reload                  | ⌘R               |
| Hard reload (no cache)  | ⇧⌘R              |
| Toggle toolbar          | ⌘\               |
| Comment                 | ⇧⌘M              |
| Comments panel          | ⇧⌘F              |
| Terminal                | ⌘J               |
| Components panel        | ⇧⌘B              |
| Network panel           | ⇧⌘N              |
| Element inspector       | ⇧⌘I              |
| Full screenshot         | ⇧⌘S              |
| Section screenshot      | ⇧⌘C              |
| Copy URL                | ⇧⌘U              |
| Copy full HTML          | ⇧⌘H              |
| Copy section HTML       | ⇧⌘E              |
| Zoom in / out / reset   | ⌘+ / ⌘- / ⌘0     |

## Structure

```
ohana/
├── package.json
├── .gitignore
├── assets/                 # icon
├── examples/
│   ├── onboarding.html     # example prototype (test surface)
│   └── design.md           # example design source of truth
├── mcp/
│   └── ohana-comments-server.js   # MCP server (comments + design.md)
├── skills/                 # agent skills (ohana-comments, ohana-design)
└── src/
    ├── main.js             # Electron main process
    ├── preload.js          # IPC bridge
    ├── viewer-preload.js   # preview-side shim (mocks, pins)
    ├── renderer.html       # UI markup (chrome)
    ├── renderer.css        # UI styles
    ├── renderer.js         # UI logic
    ├── lib/                # markdown renderer
    └── vendor/             # xterm.js
```

Per-prototype data (not committed): `.ohana/findings.json` (comments) and
`design.md` live next to each prototype, not in this repo.

## About this project

Ohana is open source (MIT): use it, modify it, and redistribute it freely — even
fork it if you want to take it in another direction. That said, it's distributed **as
is**: this repo doesn't accept external contributions (PRs) or offer support.
