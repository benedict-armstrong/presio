# Writing a Presio plugin

A Presio plugin adds a feature to a live presentation — a button in the
presenter's bottom bar, a card on their dashboard, a layer on every viewer's
screen, its own settings. It is one self-contained HTML file plus a manifest,
served from any https URL (or from `http://localhost` while you build it).

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
- `activation` — `"always"`, or `"attachment:<glob>"` to run only for decks
  whose PDF embeds a matching attachment (e.g. `"attachment:poll-*.json"`).
- `permissions` — `"deck"` to read the PDF's embedded attachments.
- `contributes.buttons` — up to 4 buttons Presio draws natively. `location`:
  `controller.toolbar` (the controller's bottom bar). `icon` is one of
  `qr-code bar-chart message users timer bell star sparkles hand check eye
  megaphone`. Presses go to the `background` surface, or the `tile` when there
  is none — so a plugin with buttons needs one of the two.
- `contributes.settings` — settings Presio shows under the plugin in
  **Settings → Plugins** and stores in the presenter's settings file as
  `<id>.<name>` (e.g. `hello.greeting`). Types: `boolean`, `number`
  (`minimum`, `maximum`; a `null` default makes it optional), `string`
  (`maxLength`), `enum` (`values`, optional `labels`). Every setting needs a
  `default` that fits it. Viewers run with the presenter's values.

## Rules of the sandbox

The HTML runs in a sandboxed iframe with an opaque origin and **no network**:
no `fetch`, no external scripts, styles, images or fonts, no storage, no access
to the page around it. Inline everything (a single-file build, e.g.
`vite-plugin-singlefile`, works). `data:` and `blob:` URLs are fine.

The same file runs on every surface; branch on `presio.surface`.

## The `presio` API

```js
presio.surface          // "background" | "tile" | "viewer"
presio.role             // "presenter" | "audience"
presio.theme            // "light" | "dark" (the app's theme)
presio.session          // { id, local, joinUrl } — joinUrl is null for a local deck
presio.slide.current    // 1-based slide on this device
presio.slide.total
presio.slide.onChange(slide => {})         // → unsubscribe()
presio.onContextChange(presio => {})       // session/role/theme changed

presio.send(type, payload, { retain })     // message the plugin's other instances
presio.onMessage(({ type, payload, from, sender }) => {})

presio.settings.get(name)                  // this plugin's setting (presenter's value)
presio.settings.all
presio.settings.onChange(settings => {})

presio.storage.get(key)                    // presenter: this plugin's state for this session
presio.storage.set(key, value)             // JSON, 16 KB per plugin; set(key) removes
presio.storage.all
presio.storage.onChange(storage => {})     // another surface of this plugin changed it

presio.onButton(id, () => {})              // a contributed button was pressed
presio.ui.setButton(id, { active, label, disabled })  // presenter: update it

presio.deck.attachments()   // → Promise<[{ filename, bytes: Uint8Array }]> ("deck" permission)
presio.ui.setVisible(bool)  // viewer surface: show/hide the layer
```

Storage: `presio.storage` is the presenter's per-session state on their own
device. It survives a reload and is shared by the plugin's surfaces there
(e.g. a background and a tile), but never leaves the device — use messages
for anything viewers need. On audience devices it is empty and `set` does
nothing.

Messaging:

- From the **presenter**, a message reaches every instance of the plugin on
  every device. With `{ retain: true }` the latest message of that `type` is
  kept and replayed to devices that join later — use it for state ("the code
  is showing"), not one-off events.
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
3. For a shared deck, open the viewer link on another device: viewers receive
   the plugin from the presenter's session — they install nothing.

## Example

The built-in Join Code plugin is a complete example:
[manifest](BASE/plugins/join-code/presio-plugin.json),
[index.html](BASE/plugins/join-code/index.html). The built-in Timer
([manifest](BASE/plugins/timer/presio-plugin.json),
[index.html](BASE/plugins/timer/index.html)) shows a tile and a background
sharing `presio.storage`.
