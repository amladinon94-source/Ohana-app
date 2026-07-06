# Ohana 🌺

Previsualizador de HTML (y repos de frontend) con superpoderes para diseñadores que
trabajan con un agente de IA en la terminal. Local, sin cuentas, sin nube.

- **Live reload** — guarda y Ohana se actualiza solo.
- **Moka** — modo de maquetación: arma el user-flow / sitemap del proyecto y expórtalo como brief para que el agente lo construya en HTML o en tu repo.
- **Comentarios tipo Figma** — deja pins anclados a elementos; tu agente los lee y responde.
- **design.md** — fuente de verdad del diseño (tokens, principios, voz), editable en la app.
- **Inspector, breakpoints, zoom y screenshots** para iterar rápido.

> Open source · MIT · macOS

## Descargar e instalar

**Requisitos:** macOS 13+ y [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/amladinon94-source/Ohana-app.git
cd Ohana-app
npm install
npm start
```

Con eso ya tienes Ohana corriendo. Si prefieres una app instalada en `/Applications`
(icono en el dock, doble clic y listo), compílala tú mismo — ver
[Compilar como .app nativa](#compilar-como-app-nativa). Como la app no está firmada
con un certificado de Apple, la primera vez ábrela con clic derecho → **Abrir**.

Abrir directamente un archivo:

```bash
npm start -- /ruta/a/tu/archivo.html
```

O arrastra cualquier archivo `.html` a la ventana.

## Flujo de trabajo con tu agente

```
Terminal:                           Ohana:
┌─────────────────────────┐        ┌──────────────────────┐
│ $ agente                │        │                      │
│ > crea un landing en    │  ───▶  │  [se actualiza solo] │
│   ./landing.html        │        │                      │
│ > deja un comentario    │  ───▶  │  [aparece el pin]    │
│   en el CTA             │        │                      │
└─────────────────────────┘        └──────────────────────┘
```

## Comentarios (tipo Figma)

Activa el modo comentar (botón 💬 o `⇧⌘M`), haz clic sobre cualquier elemento y
escribe. Queda un pin numerado anclado al elemento (vía `data-ai-id` o un selector CSS).
El panel **Comments** (`⇧⌘F`) lista los hilos; cada uno admite respuestas y resolver.

Los comentarios viven en `.ohana/findings.json`, junto al prototipo. Ohana vigila ese
archivo, así que cualquier cambio —tuyo o del agente— aparece en vivo.

## design.md

`design.md` es la **fuente de verdad del diseño**: tokens, principios, voz y tono,
patrones y bitácora de decisiones. Vive en la sección **Design** del navegador del
proyecto: preview de markdown + edición WYSIWYG (editas sobre el render), con swatches
de color en las tablas de tokens. Tu agente lo lee antes de tocar la UI y lo mantiene al día.

## Proyectos — el espacio de trabajo

Una **carpeta = un proyecto**. Al abrirla, Ohana crea su esqueleto y el **navegador
izquierdo** lista sus artefactos: **Flujos** (boards de Moka) · **Prototipos** (.html) ·
**Planes** · **Handoff** · **Design**. Cada artefacto se abre en el centro (el modo lo
decide el artefacto: un flujo abre Moka, un HTML abre el preview, un .md abre el lector).
Los tabs de arriba son contextos con color: 🟢 proyecto · 🔵 repo (localhost) · 🟡 URL,
y cada tab es un espacio independiente que recuerda dónde estaba.

El ciclo completo: **Flujos → Prototipos (iteras) → Handoff → Repositorio** — con
«Generar handoff» (✦) el agente destila el proyecto en `handoff/` (Linear-ready), y con
«Llevar a repositorio» (↗) lo implementa en el repo que elijas.

## Moka — de user-flow a código

Moka es el lienzo de maquetación: se abre al entrar a un **flujo** desde el navegador.
Tipo FigJam pero opinado, guardado en `.ohana/flow.json` como documentación viva que tu
agente lee y escribe.

- **Sitemap ⇄ User flow** — el tipo se elige **al crear** el flujo (botón «+»): *Sitemap*
  (jerarquía vertical, árbol) o *User flow* (secuencia horizontal con ramas). Moka acomoda
  las tarjetas solo (layout Sugiyama con carriles para las conexiones largas).
- **Nodos opinados** — Página, Modal, Diálogo, **Decisión** (salidas Sí/No),
  **Inicio/Fin** (marcan el recorrido) y **Subflujo** (enlaza a otro flujo del proyecto).
- **Página → Regiones → Secciones → Componentes** — las regiones definen el layout de la
  tarjeta (Header/Body/Footer, un preset clásico, o uno propio pintado en el **editor de
  layouts** tipo grid); dentro van secciones (organismos con nombre) y, dentro, componentes
  de un catálogo (Button, Data table, Chart, Acordeón…), de tu biblioteca personal, o de tu
  design system (en repos). A cada uno le anotas su detalle. Un componente puede
  **conectar a otra página** (edge punteado) y volverse **global** (se reutiliza entre pantallas).
- **Los flujos son del proyecto** — todos los boards de la carpeta viven juntos en el navegador.
- **«A prototipo»** — enlaza el flujo a un HTML en `prototipos/` y el agente lo construye;
  «Ver prototipo» lo abre en el mismo proyecto para iterar.

**Llevarlo a producto real:** con **Exportar** mandas el flujo como prompt estructurado a la
terminal del tab; tu agente construye el **prototipo HTML** (edición libre) o implementa las
vistas en tu **repositorio** con los componentes reales del design system. Te refieres a las
pantallas por su nombre; Ohana las identifica por dentro para que el agente no se confunda.

Cada proyecto recibe un `.ohana/MOKA.md` con las convenciones que el agente debe seguir.

## Integración con tu agente (MCP + skills)

Ohana incluye un servidor MCP sin dependencias para que tu agente administre comentarios y
`design.md` del prototipo que tengas abierto (igual que las herramientas de Linear).

1. Regístralo como servidor MCP en la config de tu agente (el formato `mcpServers` es
   estándar y lo usan varios agentes compatibles con MCP):

   ```json
   {
     "mcpServers": {
       "ohana-comments": {
         "type": "stdio",
         "command": "node",
         "args": ["/ruta/a/ohana/mcp/ohana-comments-server.js"]
       }
     }
   }
   ```

   (algunos agentes también lo registran por CLI; revisa cómo agrega servidores MCP el tuyo.)

2. Reinicia la sesión de tu agente. Tendrás:

   | Herramienta              | Acción                                            |
   |--------------------------|---------------------------------------------------|
   | `ohana_status`           | Qué prototipo está abierto + conteos              |
   | `ohana_list_comments`    | Listar comentarios (filtro open/resolved)         |
   | `ohana_create_comment`   | Crear comentario anclado a un elemento            |
   | `ohana_reply`            | Responder un hilo (con `resolve` opcional)        |
   | `ohana_resolve`          | Resolver / reabrir                                |
   | `ohana_delete`           | Borrar                                            |
   | `ohana_read_design`      | Leer `design.md`                                  |
   | `ohana_update_design`    | Escribir `design.md`                              |
   | `ohana_init_design`      | Crear `design.md` desde plantilla                 |
   | `ohana_flow_read` / `_list` | Leer el flujo activo / listar flujos           |
   | `ohana_sitemap_add_page` | Sitemap: página bajo un padre (conecta + ordena)  |
   | `ohana_flow_add_step` / `_add_branch` | User flow: siguiente paso / rama     |
   | `ohana_flow_layout`      | Ordenar el flujo (layout automático)              |
   | `ohana_flow_guide`       | Convenciones para armar sitemaps/flows            |

   (más `ohana_flow_add_screen/update_screen/delete_screen/add_section/add_component/connect/set_layout/…` — ver la **Referencia MCP** dentro de la app, botón `?`.)

El targeting es automático: Ohana publica el prototipo activo en `~/.ohana/active.json`.

## Configuración global (`~/.ohana/config.json`)

Opcional. Hoy soporta una clave:

```json
{ "trustedHosts": ["*.acme.dev", "stage.acme.com"] }
```

`trustedHosts` — dominios de desarrollo cuyos certificados self-signed/internos aceptas
al previsualizar (además de `localhost`, que siempre está). `*.acme.dev` cubre también
`acme.dev`. Útil si tus dev servers corren detrás de un dominio interno con HTTPS propio.

Skills incluidas para agentes que las soporten: `ohana-comments` y `ohana-design` (cópialas a la carpeta de skills de tu agente).

## Compilar como .app nativa

```bash
brew install imagemagick      # solo una vez, para regenerar el icono
bash assets/generate-icon.sh  # regenera assets/icon.icns desde assets/logo.png
npm run build
```

Abre el `dist/Ohana-<versión>.dmg` y arrastra la app a `/Applications`.

## Shortcuts

| Acción                  | Atajo            |
|-------------------------|------------------|
| Abrir archivo           | ⌘O               |
| Recargar                | ⌘R               |
| Hard reload (sin cache) | ⇧⌘R              |
| Toggle toolbar          | ⌘\               |
| Comentar                | ⇧⌘M              |
| Panel de comentarios    | ⇧⌘F              |
| Panel de design.md      | ⇧⌘D              |
| Inspector de elementos  | ⇧⌘I              |
| Screenshot completo     | ⇧⌘S              |
| Screenshot de sección   | ⇧⌘C              |
| Copiar URL              | ⇧⌘U              |
| Copiar HTML completo    | ⇧⌘H              |
| Copiar HTML de sección  | ⇧⌘E              |
| Zoom in / out / reset   | ⌘+ / ⌘- / ⌘0     |

## Estructura

```
ohana/
├── package.json
├── .gitignore
├── assets/                 # icono
├── examples/
│   └── onboarding.html     # prototipo de ejemplo (superficie de prueba)
├── mcp/
│   └── ohana-comments-server.js   # servidor MCP (comentarios + design.md)
├── skills/                 # skills del agente (ohana-comments, ohana-design)
└── src/
    ├── main.js             # proceso principal de Electron
    ├── preload.js          # bridge IPC
    ├── renderer.html       # markup de la UI (chrome)
    ├── renderer.css        # estilos de la UI
    └── renderer.js         # lógica de la UI
```

Datos por prototipo (no se commitean): `.ohana/findings.json` (comentarios) y
`design.md` viven junto a cada prototipo, no en este repo.

## Contribuir

Ohana es open source (MIT). Issues y PRs bienvenidos — es una herramienta hecha por y
para diseñadores que trabajan con agentes; si la usas con otro agente, otro design system
u otro flujo, contar cómo te fue ya es una contribución.
