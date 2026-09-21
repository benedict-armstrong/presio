# Shared Traefik proxy

Runs once per host at `/home/administrator/proxy`, owns :80 and :443, and
routes any container attached to the external `web` network that carries
`traefik.*` labels. Every app on the host shares it — there is never a second
proxy and never a port conflict.

```bash
docker network create web   # once
docker compose up -d
```

## What is and isn't in version control

Everything here is vendored so it can be reviewed and reproduced. The
**private keys are not**, and must not be:

```text
certs/presio.xyz.key    Origin CA key, generated on the host
certs/presio.ch.key     Origin CA key, generated on the host
certs/*.csr             signing requests
```

Both keys were generated on the host with `openssl req -new -newkey`, and only
the CSR ever travelled. The signed certificates (`*.pem`) are public and could
be committed, but are left on the host too so the pair stays in one place.

## TLS: Cloudflare Origin CA, and why there is no ACME

The origin is reachable only through Cloudflare. Both entrypoints apply
`cfonly@file` as a default middleware (`certs/dynamic/cfonly.yml`), and the
host firewall is configured to the same effect.

That makes ACME structurally impossible, not intermittently flaky:

- **TLS-ALPN-01** — Let's Encrypt's validator terminates TLS against
  Cloudflare's edge, which does not speak `acme-tls/1`. The failure is
  `403 unauthorized :: Cannot negotiate ALPN protocol "acme-tls/1"`.
- **HTTP-01** — the `/.well-known/acme-challenge/` request never reaches this
  origin either, for the same reason.

So TLS is served from certificates on disk, picked per-handshake by SNI:

| SNI | File | Source | Expires |
| --- | --- | --- | --- |
| `presio.xyz`, `*.presio.xyz` | `certs/presio.xyz.pem` | Cloudflare Origin CA | 2041-09-17 |
| `presio.ch`, `*.presio.ch` | `certs/presio.ch.pem` | Cloudflare Origin CA | 2041-09-17 |

The `.xyz` pair is also the store's **default** certificate, so a hostname with
no certificate of its own still gets something valid as long as it sits one
level deep under `presio.xyz`.

Cloudflare Origin CA certificates are only trusted by Cloudflare, which is the
point — they are valid for the edge-to-origin hop and meaningless anywhere
else. Set each zone's SSL mode to **Full (strict)** (API value `strict`, not
`full_strict`) so the edge actually verifies them.

### Adding a hostname under a different domain

Generate the key on the host and send only the CSR out:

```bash
openssl req -new -newkey rsa:2048 -nodes \
  -keyout example.com.key -out example.com.csr \
  -subj "/CN=example.com" \
  -addext "subjectAltName=DNS:example.com,DNS:*.example.com"
```

Sign it as a Cloudflare Origin CA certificate (dashboard, or
`POST /certificates` with `request_type=origin-rsa`), install the result next
to the key, and add a file to `certs/dynamic/` alongside `presio-ch.yml`. Add
a *certificate*, never replace the default — Traefik picks by SNI, so existing
domains are unaffected. The file provider reloads live; no restart.

### If ACME is ever wanted back

It must be **DNS-01 with the Cloudflare provider**. TLS-ALPN-01 and HTTP-01
cannot work while the origin refuses non-Cloudflare traffic, which is by
design.

## History

Until 2026-09-21 this stack carried a `le` (Let's Encrypt, TLS-ALPN-01)
resolver that had not issued a certificate since the origin was locked down,
and failed once a day for every hostname. Its orphaned `acme.json` entries were
still winning SNI matches over the default certificate, so the origin was
serving *expired* Let's Encrypt certificates — invisible only because the
`presio.xyz` zone was on SSL mode `full` rather than `strict`, which does not
verify the origin at all. See presio#64.
