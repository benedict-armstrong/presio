# Writing a Presio plugin

A Presio plugin adds a feature to a live presentation — a button in the
presenter's bottom bar, a keyboard shortcut, a card on their dashboard, a layer
on every viewer's screen or on the slide itself, its own settings. It is an
HTML page plus a manifest, served from any https URL (or from
`http://localhost` while you build it).

Like a VS Code extension, a plugin never edits Presio's interface: it
*declares* what it adds, and Presio draws it.

## Files

```
presio-plugin.json
index.html
```

`presio-plugin.json` ([schema](BASE/schema/plugin-manifest.schema.json)):

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "author": "you",
  "description": "One line shown in Settings → Plugins.",
  "main": "index.html",
  "surfaces": ["background", "viewer"],
  "activation": ["always"],
  "permissions": [],
  "contributes": {
    "buttons": [
      { "id": "toggle", "label": "Hello", "icon": "sparkles", "location": "controller.toolbar" }
    ],
    "keybindings": [
      { "command": "toggle", "label": "Say hello", "keys": [{ "key": "h" }] }
    ],
    "settings": {
      "greeting": { "type": "string", "default": "Hello!", "description": "What viewers see." }
    }
  }
}
```

- `surfaces` — where the plugin runs (the same HTML in each):
  - `background`: hidden, on the presenter's device, for as long as the deck
    is open. Keep state here and handle your buttons.
  - `tile`: a card of its own on the presenter's dashboard, titled with the
    plugin's name. Switching the plugin on adds it; the presenter can move,
    resize and hide it like any other card.
  - `viewer`: a full-screen layer on every viewer screen (projector and
    audience phones), hidden until the plugin calls `presio.ui.setVisible(true)`.
  - `slide`: a layer over the slide itself, sized to the page, on the
    presenter's current slide and on every viewer — for things that live on
    the page (media, drawings). It sits above the slide's links, follows the
    presenter's pinch-zoom (`presio.ui.view` says what of the page is on
    screen) and lets input through to the slide unless it asks for it with
    `presio.ui.setInteractive(true)` or a list of page areas. Two fingers stay
    Presio's even then: once a second touch lands, both pinch and pan the
    slide (the plugin still sees them, and should drop what the first began).
    Pair it with `presio.layers` so the same content shows, still, in
    thumbnails and the next-slide preview.
- `activation` — `"always"`, or `"attachment:<glob>"` to run only for decks
  whose PDF embeds a matching attachment (e.g. `"attachment:poll-*.json"`).
- `permissions` — `"deck"` to read the PDF (its bytes and embedded
  attachments); `"editDeck"` to save an edited PDF over it from the presenter's
  device.
- `contributes.buttons` — up to 4 buttons Presio draws natively. `location`:
  `controller.toolbar` (the controller's bottom bar),
  `controller.currentSlide` (the current slide card's header, as an icon with
  the label as its tooltip) or `settings` (under **Actions** on the plugin's
  page in Settings — for what's used now and then, like exporting its data).
  `icon` is one of `qr-code bar-chart message users timer bell star sparkles
  hand check eye megaphone pen download upload`. With `accept` (an `<input
  accept>` value, e.g. `".json,application/json"`) Presio asks the presenter
  for a file first and the press arrives with it. Presses go to the
  `background` surface, or the `tile` when there is none — so a plugin with
  buttons needs one of the two.
- `contributes.keybindings` — up to 16 keyboard shortcuts for the presenter's
  controller, each a `command` id, a `label` and default `keys` (up to 3, each
  `{ "key": KeyboardEvent.key, "meta"?: true }`). They're listed under the
  plugin's name in **Settings → Keyboard shortcuts**, where the presenter can
  rebind them (stored in the `keybindings` setting as `<id>.<command>`).
  Presses reach `presio.onCommand(command, …)` where buttons go (background,
  else tile). They never fire while the presenter types in a field, and
  Presio's own shortcuts win where keys overlap (arrows, Space, PgUp/PgDn,
  `b`, `c`, `j` then digits) — Settings marks such a key as taken. The
  built-ins use `k` and `r` (media) and `p`, `h`, `l`, Esc and ⌘Z (drawing).
- `contributes.settings` — settings Presio shows under the plugin in
  **Settings → Plugins** and stores in the presenter's settings file as
  `<id>.<name>` (e.g. `hello.greeting`). Types: `boolean`, `number`
  (`minimum`, `maximum`; a `null` default makes it optional), `string`
  (`maxLength`), `enum` (`values`, optional `labels`). Every setting needs a
  `default` that fits it. Viewers run with the presenter's values.

## Trust and the frame

Plugins are trusted code, as VS Code extensions are: a presenter should only
install plugins they trust. Each surface runs in its own frame on Presio's
origin, with the network available — fetch, scripts, images, and players such
as YouTube or Vimeo all work. The frame is there for a stable API and to keep
a misbehaving plugin from breaking the page, not as a sandbox.

Audiences are protected differently: on a deployment with a viewer origin
(e.g. `viewer.presio.ch`), viewer surfaces run there, where nothing of an
audience member's own Presio account is stored.

## Files and loading

The manifest's `main` page is written into the frame with its document base
set to the plugin's own folder (`presio.baseUrl`), so its scripts, styles,
images and any chunks it imports load from your server with ordinary relative
URLs. Split what only some surfaces need into separate chunks (a dynamic
`import()`), so viewers download only the code their surface runs — e.g. a
PDF library used only for a download.

Nothing goes through Presio's server: every device loads the plugin from its
URL directly, like a web page, so your server must send CORS headers (and
should cache hashed files). The presenter publishes the plugin's URL and the
SHA-256 of its `main` page; a viewer only runs the plugin if the page it
loads matches, so everyone runs the same version. Built-in plugins are served
by Presio itself, on the app and viewer origins alike.

The same file runs on every surface; branch on `presio.surface`. Keys pressed
while a frame has focus (after a click on one of its buttons) are handed on to
Presio unless the plugin calls `preventDefault()` or they were typed into a
field, so the presenter's shortcuts keep working; a key Presio acts on (Space
for the next slide) no longer also presses the focused button.

## The `presio` API

```js
presio.surface          // "background" | "tile" | "viewer" | "slide"
presio.role             // "presenter" | "audience"
presio.theme            // "light" | "dark" (the app's theme)
presio.session          // { id, local, joinUrl } — joinUrl is null for a local deck
presio.slide.current    // 1-based slide on this device
presio.slide.total
presio.slide.onChange(slide => {})         // → unsubscribe()
presio.onContextChange(presio => {})       // session/role/theme changed

presio.send(type, payload, { retain, volatile })  // message the plugin's other instances
presio.onMessage(({ type, payload, from, sender }) => {})

presio.settings.get(name)                  // this plugin's setting (presenter's value)
presio.settings.all
presio.settings.set(name, value)           // presenter: → Promise, as if changed in Settings
presio.settings.onChange(settings => {})

presio.storage.get(key)                    // presenter: this plugin's state for this session
presio.storage.set(key, value)             // JSON, 16 KB per plugin; set(key) removes
presio.storage.all
presio.storage.onChange(storage => {})     // another surface of this plugin changed it

presio.onButton(id, (id, file) => {})      // a contributed button was pressed; with "accept",
                                           // file is { name, type, bytes: Uint8Array }
presio.ui.setButton(id, { active, label, disabled })  // presenter: update it
presio.onCommand(command, () => {})        // a contributed keybinding was pressed

presio.deck.attachments()   // → Promise<[{ filename, bytes: Uint8Array }]> ("deck" permission)
presio.deck.bytes()         // → Promise<Uint8Array>, the PDF itself ("deck")
presio.deck.pages()         // → Promise<[{ width, height }]>, each page's size in PDF points ("deck")
presio.deck.save(bytes)     // presenter: → Promise; same pages, saved where the deck lives ("editDeck")
presio.deck.onChange(kind => {})  // the deck was swapped: "edit" (same pages, e.g. notes saved) or "replace"
presio.deck.onExport(async (bytes, { mode }) => bytes)  // transform the PDF this device downloads
presio.ui.setVisible(bool)  // viewer surface: show/hide the layer
presio.ui.setInteractive(true | false | [{ x, y, w, h }])  // slide surface: take input (page fractions)
presio.ui.view              // slide surface: { x, y, w, h, scale } — the part of the page on screen, and its zoom
presio.ui.onViewChange(view => {})
presio.ui.hovered           // slide surface, presenter: a mouse is over the slide (never for touch)
presio.ui.onHover(hovered => {})

presio.layers.set(slide, [{ x, y, w, h, image, fit }])  // still images on a slide, shown in every view
presio.layers.clear()
presio.clock.now()          // the server's clock (ms), the same on every device
```

Storage: `presio.storage` is the presenter's per-session state on their own
device. It survives a reload and is shared by the plugin's surfaces there
(e.g. a background and a tile), but never leaves the device — use messages
for anything viewers need. On audience devices it is empty and `set` does
nothing.

Downloads: when someone downloads the deck with everything in it (or
everything but its attachments — `mode` is `"everything"` or
`"no-attachments"`), each running plugin's `onExport` handler on that device
gets the PDF in turn, in the presenter's plugin order, and resolves to the PDF
to pass on — the place to bake in what the plugin shows live (the media plugin
draws each video's poster onto its page, the drawing plugin each stroke).
Handlers see the deck with its attachments still in. Register one handler per
plugin per device — on the presenter's, the `background` surface (or the tile)
is used first; a viewer's download uses whichever surface registered one. A
handler that throws or takes over a minute is skipped. "Original file" never
passes through plugins.

Messaging:

- From the **presenter**, a message reaches every instance of the plugin on
  every device. With `{ retain: true }` the latest message of that `type` is
  kept and replayed to devices that join later, and to the presenter's own
  page after a reload (it's saved on their device) — use it for state ("the
  code is showing"), not one-off events. A retained `null` payload forgets
  the type. `{ retain: "deck" }` is the same but belongs to the deck on
  screen: replacing the deck forgets it everywhere. Split big state over many
  types (the drawing plugin keeps each slide's strokes in a few): a plugin may
  keep up to 1024 retained types and 2 MB of them; past that, messages still
  go out live but aren't kept.
- `{ volatile: true }` lets a message be dropped instead of queued when a
  connection is backed up — for a stream where only the latest value counts
  (a laser position).
- From the **audience**, a message reaches the presenter's instances only
  (rate-limited), with `from: "audience"` and a per-connection `sender` id.
  The presenter aggregates and broadcasts results back.
- Payloads are JSON, at most 16 KB; `type` is up to 64 of `A-Za-z0-9_.:-`.

## Develop

1. Serve the folder, e.g. `npx vite --port 5174 --cors` or any static server
   that sends CORS headers.
2. In Presio, open a deck as the controller → **Settings → Plugins**, paste
   `http://localhost:5174/` and **Add**. Reload the presentation to pick up
   edits.
3. For a shared deck, open the viewer link on another device: viewers load the
   plugin from the URL the presenter added — they install nothing. So a plugin
   served on `localhost` only reaches viewers on the same machine (the viewer
   window); for phones, serve it where they can reach it. With Presio itself
   running locally over http, that can be your LAN address (`npx vite --host`,
   then add `http://<your-ip>:5174/`); a hosted Presio is https, so there it
   takes an https URL — a tunnel (e.g. `cloudflared tunnel --url
   http://localhost:5174`) or a real host.
   Reload the viewers after editing, or they'll refuse the changed plugin.

## Example

The built-in Join Code plugin is a complete example:
[manifest](BASE/plugins/join-code/presio-plugin.json),
[index.html](BASE/plugins/join-code/index.html). The built-in Timer
([manifest](BASE/plugins/timer/presio-plugin.json)) shows a tile and a
background sharing `presio.storage`, and Speaker Notes
([manifest](BASE/plugins/notes/presio-plugin.json)) reads notes out of the PDF
and saves edits back with `presio.deck.save` — both React. Media and Drawing
load each surface's code as its own chunk, and pdf-lib only for a download.
Media ([manifest](BASE/plugins/media/presio-plugin.json)) plays the GIFs,
videos and YouTube/Vimeo embeds a deck carries: a `slide` surface with the
players (controls drawn on each item for the presenter, claimed with
`setInteractive` areas), retained messages for play state and audio plus time
samples stamped with `presio.clock.now()` that viewers follow, posters as
`presio.layers`, keybindings, and an `onExport` handler. Drawing
([manifest](BASE/plugins/drawing/presio-plugin.json)) is the pen, highlighter
and laser: a `slide` surface that takes input while a tool is active and only
its palette otherwise, strokes streamed as they're drawn and kept as
per-slide `retain: "deck"` chunks, a volatile laser, previews as
`presio.layers`, a header button and keybindings, and an `onExport` handler
that bakes the strokes into the PDF as vectors.
