#!/usr/bin/env bash
# Generate deploy/.env from deploy/.env.example with fresh secrets.
# Fill in the four values below, then run:  ./deploy/gen-env.sh
set -euo pipefail
cd "$(dirname "$0")"

# ---- set these ----
APP_DOMAIN="https://presio.xyz"
SUPABASE_DOMAIN="https://supabase.presio.xyz"
GITHUB_CLIENT_ID="REPLACE_ME"
GITHUB_SECRET="REPLACE_ME"

# ---- helpers ----
rand()   { openssl rand -hex "${1:-32}"; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {  # $1=role  $2=secret  -> a 10-year HS256 Supabase API key
  local iat exp hdr pl
  iat=$(date +%s); exp=$((iat + 60*60*24*3650))
  hdr=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  pl=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$iat" "$exp" | b64url)
  printf '%s.%s.%s' "$hdr" "$pl" \
    "$(printf '%s' "$hdr.$pl" | openssl dgst -sha256 -hmac "$2" -binary | b64url)"
}

# ---- generate ----
JWT_SECRET=$(rand 32)
ANON_KEY=$(jwt anon "$JWT_SECRET")
SERVICE_ROLE_KEY=$(jwt service_role "$JWT_SECRET")
POSTGRES_PASSWORD=$(rand 24)
DASHBOARD_PASSWORD=$(rand 16)
SECRET_KEY_BASE=$(rand 32)
VAULT_ENC_KEY=$(rand 16)
PG_META_CRYPTO_KEY=$(rand 16)
MINIO_ROOT_PASSWORD=$(rand 24)
S3_PROTOCOL_ACCESS_KEY_ID=$(rand 16)
S3_PROTOCOL_ACCESS_KEY_SECRET=$(rand 32)

override() {  # echo a replacement value for $1, or fail if we don't override it
  case "$1" in
    SUPABASE_PUBLIC_URL|API_EXTERNAL_URL)  echo "$SUPABASE_DOMAIN" ;;
    SITE_URL)                  echo "$APP_DOMAIN" ;;
    ADDITIONAL_REDIRECT_URLS)  echo "$APP_DOMAIN,http://localhost:5173" ;;
    JWT_SECRET)                echo "$JWT_SECRET" ;;
    ANON_KEY)                  echo "$ANON_KEY" ;;
    SERVICE_ROLE_KEY)          echo "$SERVICE_ROLE_KEY" ;;
    POSTGRES_PASSWORD)         echo "$POSTGRES_PASSWORD" ;;
    DASHBOARD_PASSWORD)        echo "$DASHBOARD_PASSWORD" ;;
    SECRET_KEY_BASE)           echo "$SECRET_KEY_BASE" ;;
    VAULT_ENC_KEY)             echo "$VAULT_ENC_KEY" ;;
    PG_META_CRYPTO_KEY)        echo "$PG_META_CRYPTO_KEY" ;;
    MINIO_ROOT_PASSWORD)       echo "$MINIO_ROOT_PASSWORD" ;;
    S3_PROTOCOL_ACCESS_KEY_ID) echo "$S3_PROTOCOL_ACCESS_KEY_ID" ;;
    S3_PROTOCOL_ACCESS_KEY_SECRET) echo "$S3_PROTOCOL_ACCESS_KEY_SECRET" ;;
    GITHUB_CLIENT_ID)          echo "$GITHUB_CLIENT_ID" ;;
    GITHUB_SECRET)             echo "$GITHUB_SECRET" ;;
    *) return 1 ;;
  esac
}

[ -e .env ] && { echo "deploy/.env already exists — refusing to overwrite." >&2; exit 1; }

while IFS= read -r line; do
  if printf '%s' "$line" | grep -qE '^[A-Z_][A-Z0-9_]*=' && key=${line%%=*} && v=$(override "$key"); then
    printf '%s=%s\n' "$key" "$v"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > .env
chmod 600 .env
echo "Wrote deploy/.env (chmod 600). Set GITHUB_* if you left them as REPLACE_ME."
