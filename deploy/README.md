# Self-hosting Presio

The whole Presio stack runs from **one `docker-compose.yml` at the repo root**,
fronted by a small shared **Traefik** reverse proxy (in [`proxy/`](../proxy)) that
terminates TLS and routes your domains. The proxy is a separate, host-level
project so you can run other apps behind the same proxy later — see
[Adding more apps](#adding-more-apps-to-the-same-host).

```
                       host :80 / :443
                             │
                       ┌─────▼─────┐        external docker network "web"
                       │  traefik  │◄──────────────┬────────────────┐
                       │ (proxy/)  │               │                │
                       └───────────┘         presio-app:3001   (future app)
                                              supabase-kong:8000
```

| Service group    | What it is                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presio`         | The app — Express + Socket.IO server that also serves the built React client (built by `deploy/Dockerfile`).                                                      |
| `kong` + `*`     | A pinned, self-hosted [Supabase](https://supabase.com/docs/guides/self-hosting/docker) stack — Postgres, GoTrue (auth), Storage, PostgREST, Kong gateway, Studio. |
| `minio`          | [MinIO](https://min.io) object store; Supabase Storage uses it as its S3 backend, so synced PDFs live here.                                                       |
| `presio-db-init` | One-shot job that applies the repo's `dbschema.sql` (the `sessions` table + `presentations` bucket) once auth and storage are ready.                              |

Only `presio` and `kong` are exposed (via Traefik labels + the `web` network);
everything else stays on the internal network. Almost no app code is
Supabase-specific — it's reached only via env-configured URLs/keys — so
self-hosting is mostly configuration.

## Files

```text
docker-compose.yml        # the whole stack — run `docker compose up` from the repo root
deploy/
  Dockerfile              # builds the presio app image
  .env.example            # every stack setting; copy to ./.env (repo root) and fill in
  volumes/                # vendored Supabase config (kong, db init, etc.), pinned
    UPSTREAM_PINNED_SHA.txt  # the supabase/supabase commit these files come from
proxy/
  docker-compose.yml      # the shared Traefik proxy (run once per host)
  .env.example            # ACME_EMAIL for Let's Encrypt
dbschema.sql              # mounted into presio-db-init
```

## Prerequisites

- A Linux host with Docker + Docker Compose, ports **80 and 443** open.
- Two DNS `A`/`AAAA` records pointing at the host, e.g. `presio.xyz` (app) and
  `supabase.presio.xyz` (Supabase API). They must resolve publicly for Let's
  Encrypt to issue certificates.

## 1. Generate secrets

The Supabase secrets (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`) must be a
matching set. Generate them with Supabase's helper:
<https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys>
(or `sh utils/generate-keys.sh` from a checkout of `supabase/supabase`).

## 2. Configure the stack `.env`

Copy the example to a `.env` **at the repo root** (this is where
`docker compose` reads it from when you run it from the root):

```bash
cp deploy/.env.example .env
# edit .env — domains, the generated secrets, MinIO + dashboard passwords,
# and the GitHub OAuth client id/secret.
```

Set the domains to your **real, externally-resolvable** values:

- `APP_HOST` / `SUPABASE_HOST` → bare hostnames, e.g. `presio.xyz` /
  `supabase.presio.xyz` (these drive Traefik's `Host()` routing rules).
- `SITE_URL` → `https://presio.xyz`
- `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` → `https://supabase.presio.xyz`

> **Why the public URL matters:** the Presio server uses `SUPABASE_PUBLIC_URL`
> both to call Supabase and to build the public PDF URLs it hands to viewers, so
> it has to be reachable from outside the stack.

## 3. GitHub OAuth

Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps):

- **Authorization callback URL:** `https://supabase.presio.xyz/auth/v1/callback`
  (i.e. `${API_EXTERNAL_URL}/auth/v1/callback`).

Put its client id/secret into `GITHUB_CLIENT_ID` / `GITHUB_SECRET` in `.env`.
Email/password is enabled too (`ENABLE_EMAIL_SIGNUP=true`, auto-confirm on by
default — set `ENABLE_EMAIL_AUTOCONFIRM=false` and fill `SMTP_*` for real
verification emails).

## 4. Start the shared proxy (once per host)

```bash
docker network create web        # the shared ingress network
cd proxy
cp .env.example .env             # set ACME_EMAIL
docker compose up -d
```

Traefik now owns ports 80/443 and watches Docker for labelled containers. You
only do this once — every app (including Presio) attaches to the `web` network.

## 5. Start Presio

From the **repo root**:

```bash
docker compose up -d --build
docker compose ps                # everything healthy / completed
```

First boot runs the Supabase migrations, creates the MinIO bucket, then
`presio-db-init` applies `dbschema.sql`, then `presio` starts. As soon as DNS
resolves, Traefik fetches certificates and serves:

- `https://presio.xyz` → the app
- `https://supabase.presio.xyz` → Supabase API + Studio (login
  `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`)

Watch certificate issuance / routing with `docker compose -p proxy logs -f traefik`.

## Adding more apps to the same host

You do **not** add a second proxy. Give the new app's container a route on the
same proxy:

1. Attach its service to the external `web` network.
2. Add Traefik labels (swap the names/host/port):

   ```yaml
   networks: [default, web]
   labels:
     - "traefik.enable=true"
     - "traefik.docker.network=web"
     - "traefik.http.routers.myapp.rule=Host(`app2.example.com`)"
     - "traefik.http.routers.myapp.entrypoints=websecure"
     - "traefik.http.routers.myapp.tls.certresolver=le"
     - "traefik.http.services.myapp.loadbalancer.server.port=8080"
   ```

3. Point `app2.example.com` at the host and `docker compose up -d`. Traefik
   picks it up and issues a certificate automatically.

## Continuous deployment (optional)

`.github/workflows/ci.yml` runs build/typecheck/compose-validate checks on every
push. There's no push-button deploy anymore (we dropped the Coolify API hook); to
auto-deploy on the host, add a step that SSHes in and runs
`git pull && docker compose up -d --build`, or use a tool like
[watchtower](https://containrrr.dev/watchtower/) / a webhook on the host.

## Updating the pinned Supabase version

The vendored files come from the `supabase/supabase` commit recorded in
`deploy/volumes/UPSTREAM_PINNED_SHA.txt`. To bump: re-fetch
`docker/docker-compose.yml`, `docker/docker-compose.s3.yml`, and
`docker/volumes/**` at the new commit, then re-apply the local adaptations (S3
backend on `storage`; the `minio` / `minio-createbucket` / `presio-db-init` /
`presio` services; the Traefik labels + `web` network on `presio`/`kong`; and the
uncommented GitHub provider lines in `auth`).

## Trimming unused services

Presio itself only needs `db`, `kong`, `auth`, `rest`, `storage`, `imgproxy`,
plus `minio`. `realtime`, `functions` (edge), and `supavisor` (pooler) are not
used (Presio runs its own Socket.IO and talks to Kong, not Postgres directly).
They're kept so the upstream stack boots exactly as shipped; you can disable them
to save resources, but leave `studio`/`meta` (Kong's health gate depends on
`studio`).

## Running fully local / offline

If you just want to present PDFs on your own machine or LAN — no public
domain, no accounts, no analytics — none of the above is needed at all. A
**single prebuilt container** (`linux/amd64` and `linux/arm64`), no Supabase,
no `.env`, no checkout:

```bash
docker run -d --name presio -p 3001:3001 \
  -e PRESIO_MODE=local -e LOCAL_DATA_DIR=/data -e TRUST_PROXY=false \
  -v presio-data:/data \
  ghcr.io/benedict-armstrong/presio-local:latest
open http://localhost:3001
```

Or with Compose, which sets all of that for you:

```bash
curl -fsSLO https://raw.githubusercontent.com/benedict-armstrong/presio/main/local.docker-compose.yml
docker compose -f local.docker-compose.yml up -d
```

The image is published by `.github/workflows/publish-local-image.yml` on every
push to `main` (`:latest`) and every `v*` tag. From a checkout, `docker compose
-f local.docker-compose.yml build` builds the same image from source instead.

Set `PRESIO_MODE=local` and the server swaps Supabase for a bundled SQLite
database and filesystem storage under `/data` (see `server/local/`) instead of
Postgres/GoTrue/Storage/Kong. Login and cross-device sync-by-account aren't
available in this mode (there's no auth provider to back them), but everything
else works: local presentations, handoff links, and controller/viewer sync
over Socket.IO. To present to viewers on other devices on the same network,
have them open `http://<this-machine's-LAN-IP>:3001` instead of `localhost` —
PDF links are relative, so they resolve correctly either way, and CORS accepts
any origin in this mode since there's no fixed domain to allow ahead of time.
