# Release hardening plan

Presio is now deployed self-hosted by third parties. This plan makes upgrades
safe, gives self-hosters a stable version to pin, and replaces the manual
staging deploy with a gated pipeline.

Remaining manual steps are collected in [`release-runbook.md`](release-runbook.md).

Status legend: `[ ]` todo · `[x]` done · `[~]` in progress · `[-]` skipped

## Phase 1 — Make upgrades safe

The blocking work. Until local-mode data survives an upgrade, there is no
honest way to tell anyone to pin a version and upgrade with confidence.

- [x] **1. Versioned SQLite migrations.** `server/local/db.ts` runs a single
  `create table if not exists` block. Adding a column later is a silent no-op
  on an existing `/data` volume and breaks the app on upgrade. Replace with
  `PRAGMA user_version` plus an ordered list of migration steps, each applied
  in a transaction. Step 0 is today's schema, so existing volumes converge.
- [x] **2. Pre-migration backup.** When `user_version` is behind, copy
  `presio.db` to `presio.db.bak-v<n>` in the data dir before migrating, so a
  bad migration is recoverable without a restore procedure.
- [x] **3. Upgrade smoke test** in `publish-local-image.yml`: boot the previous
  release image on a volume, create a session, stop it, boot the new image on
  the same volume, assert the session still reads. The existing smoke test only
  ever exercises a fresh database.
- [x] **4. Container healthcheck.** Add `HEALTHCHECK` to `deploy/Dockerfile`
  against `/healthz` so restart policies and orchestrators behave.

## Phase 2 — Versioning and release tags

- [ ] **5. Cut `v1.0.0` from `main`** *before* changing any tagging logic —
  flipping `latest` off `main` first would leave `:latest` pointing at nothing.
- [x] **6. Redefine the image tags** in `publish-local-image.yml`:
  - `:latest` → latest **release**, not tip of main
  - `:main` → the unstable channel (what `:latest` means today)
  - `:sha-<short>` → immutable per-commit
  - `:1`, `:1.2`, `:1.2.3` → pinned-but-patched channels
- [x] **7. Gate publishing on CI.** Publish currently races CI off the same
  push, so a commit with failing tests can publish. Trigger via `workflow_run`
  on CI success, or make CI a reusable workflow the publish job `needs:`.
- [x] **8. Surface the version at runtime.** Pass `APP_VERSION` as a build arg,
  expose it on `/healthz` (or `/api/version`) and in the client UI. Self-hosted
  bug reports are unusable without it. Sync `client`/`server` `package.json`
  versions to the tag (currently `0.0.0` and `1.0.0`).
- [x] **9. CHANGELOG + release notes.** `release-please` bumps both manifests,
  writes the CHANGELOG and cuts the `v*` tag from a PR — releasing becomes one
  merge. Fallback: manual tags with `gh release create --generate-notes`.
- [x] **10. Provenance + SBOM** on the push step (`provenance: true`,
  `sbom: true`), optionally cosign keyless signing, so pullers can verify the
  image came from this repo.
- [x] **11. Pin `:latest` out of the docs.** `local.docker-compose.yml`,
  `README.md` and `deploy/README.md` should show a pinned tag, with `:latest`
  described as "newest release" and `:main` as "unstable".

## Phase 3 — Branches and protection

The repo is public, so rulesets are free.

- [ ] **12. `main` ruleset:** require a PR, require the `client` / `server` /
  `e2e` checks, block force-push and deletion, require linear history. Keep
  admin bypass — with a solo maintainer, no-bypass mostly means locking
  yourself out mid-incident.
- [ ] **13. Tag ruleset on `v*`:** block deletion and updates. A moved release
  tag is the one thing that genuinely breaks downstream users.
- [ ] **14. `staging` branch** as a fast-forward pointer at a known-good `main`
  commit, not a development branch. PR → `main` (CI green) → workflow
  fast-forwards `staging` → push to `staging` deploys `staging.presio.xyz`.
  Rollback is `git push -f origin <older-sha>:staging`. Protect against
  deletion but *allow* force-push, since that is the rollback lever.
- [x] **15. `deploy-staging.yml`.** The SSH/tailnet plumbing already exists in
  `preview.yml`; factor it into a composite action shared by both, and deploy a
  fixed checkout of `staging` with `docker-compose.staging.yml`.
- [ ] **16. Production deploy on `v*` tags** (optional). Prod and staging both
  build from a working tree on the host today, so "what is in production" is
  not answerable from git.

## Phase 4 — What companies will ask for

- [x] **17. `SECURITY.md`** with a disclosure contact and which versions get
  fixes. Often a procurement checkbox.
- [x] **18. Support and upgrade policy** in `deploy/README.md`: supported tags,
  forward-only data migration, and documented backup/restore of the `/data`
  volume (and of Supabase/MinIO for the full stack).
- [x] **19. Dependabot** for GitHub Actions and npm; pin `node:20-alpine` to a
  digest so builds are reproducible.
- [x] **20. `permissions: contents: read`** at the top of `ci.yml` and
  `preview.yml` (`publish-local-image.yml` already scopes correctly).
- [x] **21. Self-hosting issue template** asking for the image tag and
  `/healthz` version output — depends on step 8.

## Ordering constraints

- 1 and 2 before 3 (the upgrade test needs something to test).
- 1 → 5 → 6: data must survive upgrades before telling people to pin, and a
  real release must exist before `:latest` is redefined to mean "release".
- 8 before 21 (the issue template asks for the version endpoint's output).
- 14 before 15 (the workflow triggers on pushes to the branch).

## Operational prerequisites

Set outside the repository, once:

- [ ] **`RELEASE_PLEASE_TOKEN`** repository secret — a fine-grained PAT with
  `contents: write` and `pull-requests: write`. The default `GITHUB_TOKEN`
  cannot be used: tags it pushes do not trigger other workflows, so a release
  tag would land and no image would ever be built for it.
- [ ] **`STAGING_ENV_FILE`** repository variable — path on the deploy host to
  the stack `.env` that `docker-compose.staging.yml` reads. Defaults to
  `/home/administrator/presio/.env`.
- [ ] Conventional commit messages on `main` from here on; release-please
  derives the version bump and changelog from them.
