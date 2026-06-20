# Self-hosting Presio on Coolify

This directory deploys the **entire** Presio stack from one config-driven
`docker-compose.yml`:

| Service group    | What it is                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presio`         | The app — Express + Socket.IO server that also serves the built React client (built by `deploy/Dockerfile`).                                                      |
| `supabase-*`     | A pinned, self-hosted [Supabase](https://supabase.com/docs/guides/self-hosting/docker) stack — Postgres, GoTrue (auth), Storage, PostgREST, Kong gateway, Studio. |
| `presio-minio`   | [MinIO](https://min.io) object store; Supabase Storage uses it as its S3 backend, so synced PDFs live here.                                                       |
| `presio-db-init` | One-shot job that applies the repo's `dbschema.sql` (the `sessions` table + `presentations` bucket) once auth and storage are ready.                              |

Almost no app code is Supabase-specific — it's reached only via env-configured
URLs/keys — so self-hosting is mostly configuration.

## Files

```text
deploy/
  docker-compose.yml      # the whole stack (vendored Supabase + MinIO + presio)
  Dockerfile              # builds the presio app image (NOT the dead root Dockerfile)
  .env.example            # every setting; copy to .env and fill in
  volumes/                # vendored Supabase config (kong, db init, etc.), pinned
    UPSTREAM_PINNED_SHA.txt  # the supabase/supabase commit these files come from
```

`dbschema.sql` lives at the repo root and is mounted into `presio-db-init`.

## 1. Generate secrets

The Supabase secrets (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`) must be a
matching set. Generate them with Supabase's helper:
<https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys>
(or `sh utils/generate-keys.sh` from a checkout of `supabase/supabase`). Then:

```bash
cd deploy
cp .env.example .env
# edit .env — fill in domains, the generated secrets, MinIO + dashboard
# passwords, and the GitHub OAuth client id/secret.
```

Set the domains to **real, externally-resolvable** URLs:

- `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` → e.g. `https://supabase.example.com`
- `SITE_URL` → your app, e.g. `https://presio.example.com`

> **Why the public URL matters:** the Presio server uses `SUPABASE_PUBLIC_URL`
> both to call Supabase and to build the public PDF URLs it hands to viewers, so
> it has to be reachable from outside the stack. `http://localhost:8000` only
> works for throwaway single-host testing.

## 2. GitHub OAuth

Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps):

- **Authorization callback URL:** `https://supabase.example.com/auth/v1/callback`
  (i.e. `${API_EXTERNAL_URL}/auth/v1/callback`).

Put its client id/secret into `GITHUB_CLIENT_ID` / `GITHUB_SECRET` in `.env`.
Email/password is enabled too (`ENABLE_EMAIL_SIGNUP=true`, auto-confirm on by
default — set `ENABLE_EMAIL_AUTOCONFIRM=false` and fill `SMTP_*` for real
verification emails).

## 3. Deploy on Coolify

1. **New Resource → Git Based** (Public Repository, or Private Repository with
   the GitHub App), pointed at this repo. On the build screen set **Build Pack =
   Docker Compose** and **Docker Compose Location = `/deploy/docker-compose.yml`**.

   > **Leave Base Directory at `/` (the repo root).** Coolify builds with
   > `--project-directory <repo-root>`, so every path in the compose is written
   > relative to the repo root (`context: .`, `./deploy/volumes/...`,
   > `./dbschema.sql`) — not relative to `deploy/`. Don't set Base Directory to
   > `/deploy`, or those paths resolve one level too deep.
2. Paste the values from your `.env` into the resource's **Environment
   Variables** (this is the only step that isn't in version control, since these
   are secrets).
3. Map domains in Coolify's proxy:
   - app domain (`presio.example.com`) → the `presio` service, port `3001`
   - Supabase domain (`supabase.example.com`) → the `kong` service, port `8000`

   TLS is handled by Coolify's Traefik.
4. Deploy. First boot runs Supabase migrations, creates the MinIO bucket, then
   `presio-db-init` applies `dbschema.sql`, then `presio` starts.

## 4. Run it locally (optional smoke test)

Run from the **repo root** (not from `deploy/`) so the compose's repo-root-relative
paths resolve — mirror how Coolify builds it:

```bash
cp deploy/.env.example deploy/.env   # fill it in first
docker compose --project-directory . -f deploy/docker-compose.yml up -d --build
docker compose --project-directory . -f deploy/docker-compose.yml ps  # healthy / completed
```

Studio is on `http://localhost:8000` (login `DASHBOARD_USERNAME` /
`DASHBOARD_PASSWORD`). Note the public-URL caveat above: full synced-PDF flows
need real domains, so prefer verifying those on Coolify.

## Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` runs build checks on every push to `main`, then
triggers a Coolify redeploy via the Coolify API. Coolify itself clones the repo
and rebuilds `deploy/docker-compose.yml`, so CI needs no registry or app
secrets — only how to reach Coolify. Add these **repository secrets** (Settings
→ Secrets and variables → Actions):

| Secret                  | Value                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `COOLIFY_URL`           | Your Coolify base URL, e.g. `https://coolify.example.com` (no trailing slash).             |
| `COOLIFY_TOKEN`         | A Coolify API token with the **deploy** permission (Coolify → Keys & Tokens → API tokens). |
| `COOLIFY_RESOURCE_UUID` | The UUID of the Docker Compose resource (visible in its Coolify URL).                      |

The deploy step calls `GET /api/v1/deploy?uuid=<uuid>` with
`Authorization: Bearer <token>`. You can also run it on demand from the Actions
tab (it has a `workflow_dispatch` trigger). If your server's TypeScript config
isn't strict-clean, drop the "Typecheck server" step.

> Alternative: skip Actions entirely and connect the repo to Coolify directly so
> it auto-deploys on push (Coolify → resource → Webhooks / Git integration). Use
> the Actions workflow when you want build checks to gate the deploy.

## Updating the pinned Supabase version

The vendored files come from the `supabase/supabase` commit recorded in
`volumes/UPSTREAM_PINNED_SHA.txt`. To bump: re-fetch `docker/docker-compose.yml`,
`docker/docker-compose.s3.yml`, and `docker/volumes/**` at the new commit, then
re-apply the three Presio adaptations (S3 backend on `storage`, the `minio` /
`minio-createbucket` / `presio-db-init` / `presio` services, and the uncommented
GitHub provider lines in `auth`).

## Trimming unused services

Presio itself only needs `db`, `kong`, `auth`, `rest`, `storage`, `imgproxy`,
plus `minio`. `realtime`, `functions` (edge), and `supavisor` (pooler) are not
used (Presio runs its own Socket.IO and talks to Kong, not Postgres directly).
They're kept so the upstream stack boots exactly as shipped; you can disable
them in Coolify later to save resources, but leave `studio`/`meta` (Kong's
health gate depends on `studio`).
