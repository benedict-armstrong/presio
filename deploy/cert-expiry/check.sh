#!/bin/sh
# Report whether the certificates the proxy actually serves are still valid,
# and for how much longer.
#
# This asks the origin over the network rather than reading certificate files,
# so it checks the property that matters — what a TLS handshake for each
# hostname receives — and needs no access to keys or to the proxy's filesystem.
# A monitor pointed at the public URL cannot do this: behind a CDN it sees the
# edge certificate, which is renewed by someone else and says nothing about the
# origin.
#
# The verdict uses `openssl x509 -checkend`, which compares against the
# certificate's own notAfter without any date parsing — busybox `date` cannot
# read openssl's output format, and a checker that silently fails to parse is
# worse than no checker.
#
# Output is one line per hostname plus a verdict line. Uptime Kuma watches it
# with an HTTP(s) - Keyword monitor on `cert-expiry: OK`, so the check fails
# both when a certificate is near expiry and when this responder is unreachable.
set -eu

ORIGIN="${CERT_EXPIRY_ORIGIN:-traefik:443}"
HOSTS="${CERT_EXPIRY_HOSTS:-}"
MIN_DAYS="${CERT_EXPIRY_MIN_DAYS:-30}"
window=$(( MIN_DAYS * 86400 ))

verdict=OK
body=""
checked=0

for h in $(echo "$HOSTS" | tr ',' ' '); do
  [ -n "$h" ] || continue
  checked=$(( checked + 1 ))

  cert=$(echo | openssl s_client -connect "$ORIGIN" -servername "$h" 2>/dev/null || true)
  end=$(printf '%s' "$cert" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)

  if [ -z "$end" ]; then
    body="${body}${h}: NO CERTIFICATE SERVED
"
    verdict=FAIL
    continue
  fi

  if printf '%s' "$cert" | openssl x509 -noout -checkend "$window" >/dev/null 2>&1; then
    body="${body}${h}: ok until ${end}
"
  else
    # Distinguish "already expired" from "expiring soon" — the first is an
    # outage in progress behind a strict edge, the second is a reminder.
    if printf '%s' "$cert" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
      body="${body}${h}: EXPIRES WITHIN ${MIN_DAYS}d — ${end}
"
    else
      body="${body}${h}: EXPIRED — ${end}
"
    fi
    verdict=FAIL
  fi
done

if [ "$checked" -eq 0 ]; then
  body="no hostnames configured (set CERT_EXPIRY_HOSTS)
"
  verdict=FAIL
fi

printf '%s' "$body"
printf 'cert-expiry: %s\n' "$verdict"
