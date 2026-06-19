# Presio

Upload a PDF presentation, get a short link, and control the slideshow from one browser window while viewers watch in another.

## Prerequisites

- Node.js 20+
- A Supabase backend — either a hosted [Supabase](https://supabase.com) project
  or the self-hosted stack in [`deploy/`](deploy/README.md) (Postgres + Auth +
  Storage). Presio talks to it only through env-configured URLs/keys, so either
  works.

## Backend setup

Whichever backend you use, it must have:

1. The `sessions` table and `presentations` storage bucket from `dbschema.sql`.
   - Hosted: run `dbschema.sql` in the Supabase SQL editor.
   - Self-hosted: applied automatically on first boot — see
     [`deploy/README.md`](deploy/README.md).
2. **Auth** configured (for logging in / sharing presentations online):
   - Email/password enabled (optionally auto-confirm for dev).
   - GitHub: a GitHub OAuth App with callback
     `https://<your-supabase-host>/auth/v1/callback`, its client id/secret set
     on the auth provider.
   - App origins (e.g. `http://localhost:5173` and your production origin) added
     to the auth **Redirect URLs** so the OAuth round-trip can return to the
     share screen.

## Deployment (self-hosting on Coolify)

The [`deploy/`](deploy/README.md) directory contains a single, config-driven
`docker-compose.yml` that runs the whole thing — the Presio app, a pinned
self-hosted Supabase stack, and MinIO (S3 storage backend) — with all settings
in `deploy/.env`. See **[`deploy/README.md`](deploy/README.md)** for the full
Coolify walkthrough.

## Environment Variables

**Server** (`server/.env`):

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3001
```

**Client** (`client/.env`):

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-publishable-key
```

## Running Locally

```bash
# Terminal 1 - Server
cd server
cp .env.example .env   # fill in your Supabase credentials
npm run dev

# Terminal 2 - Client
cd client
npm run dev
```

The client dev server proxies `/api` and `/socket.io` requests to the server on port 3001.

## Usage

1. Open `http://localhost:5173`
2. Drop a PDF file onto the upload zone
3. Copy the **Controller** link and open it in one window
4. Copy the **Viewer** link and open it in another window (or send to another device)
5. Use the Previous/Next buttons (or arrow keys) in the controller to navigate slides

Presentations automatically expire after 24 hours.

## Modes

- **Local (default):** the PDF never leaves your browser. It's stored in
  IndexedDB and shared across tabs/windows on the same device via
  `BroadcastChannel` — no upload. A session code is reserved on the server (marked
  `local`) but no PDF is stored. Opening a presentation auto-opens a viewer window.
  Local presentations can't be joined from another device. They auto-expire after 7
  days (or on "End Presentation").
- **Synced:** log in (GitHub or email/password), then on the share screen choose
  **Sync online to share**. This uploads the PDF to Supabase and attaches it to your
  account, keeping the same code — viewers can now join from any device by code/QR.
  Logging in by itself never uploads anything; syncing is always an explicit opt-in.
- **External (bring your own storage):** paste a PDF URL you host yourself (e.g. a
  GitHub raw or Pages link) — on the home screen, or via **Host it yourself** on the
  share screen to convert a local presentation in place. Presio stores only the URL,
  never the bytes, so this needs **no login** and unlocks the same join-from-any-device
  features as Synced. The PDF is fetched directly by each viewer's browser, so the URL
  must be publicly reachable and serve permissive CORS headers (GitHub raw/Pages do).

  You can also start straight from a link without visiting the home screen:

  ```txt
  https://presio.xyz/present?from=<url-to-pdf>
  ```

  This creates an External session from the PDF and drops you into the controller.
  GitHub `blob` links work too — they're normalized to `raw.githubusercontent.com`
  automatically. For example:

> **Note on synced PDF privacy:** uploaded PDFs are stored in a public Supabase
> bucket so viewers can fetch them by URL. This means a synced presentation is
> readable by anyone who knows or guesses its session code. Don't sync
> confidential material — keep it in Local mode instead.

## TODO

- [ ] Users should be able to generate a perma link and qr code that they can put on the presentation.
- [ ] Add a button to toggle all viewers to show the join code and QR code.
- [ ] In addition to blanking the screen it should also be possible to show the join code (hotkey).
- [x] Add support for bringing your own PDF host?
