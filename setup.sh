#!/usr/bin/env bash
# setup.sh — one-command setup for Open Teams (office management system).
#
#   Local dev (own Postgres):   ./setup.sh
#   Full stack via Docker:      ./setup.sh --docker
#   Servers / CI (no prompts):  ./setup.sh --non-interactive [--docker]
#
# Useful flags: --skip-install --skip-build --skip-migrate --recreate-secrets --help
#
# Local mode writes backend/.env, installs deps, applies db/01..13 + seed,
# verifies seed counts, and builds both frontend bundles.
# Docker mode writes the root .env, then boots Postgres + both APIs +
# both portals with docker compose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

MODE="local"            # local | docker
INTERACTIVE=1
DO_INSTALL=1
DO_MIGRATE=1
DO_BUILD=1
RECREATE_SECRETS=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker) MODE="docker"; shift ;;
    --local) MODE="local"; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --skip-migrate) DO_MIGRATE=0; shift ;;
    --skip-build) DO_BUILD=0; shift ;;
    --recreate-secrets) RECREATE_SECRETS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 (install it and retry)"; }

prompt() { # prompt <VAR> <message> <default>
  local var="$1" msg="$2" def="$3" val=""
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    printf -v "$var" '%s' "${!var:-$def}"
    return
  fi
  read -r -p "$msg [$def]: " val || true
  printf -v "$var" '%s' "${val:-$def}"
}

rand_hex() { # rand_hex <bytes> -> hex on stdout
  local n="$1"
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$n";
  elif command -v node >/dev/null 2>&1; then node -e "console.log(require('crypto').randomBytes($n).toString('hex'))";
  else od -An -tx1 -N "$n" /dev/urandom | tr -d ' \n'; echo; fi
}

check_node() {
  need node; need npm
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 20 ]] || die "node >= 20 required (found $(node --version))"
  echo "node $(node --version), npm $(npm --version)"
}

# ---------------------------------------------------------------- local mode
setup_local() {
  say "Checking prerequisites"
  check_node
  need psql
  [[ -f "$BACKEND/package.json" && -f "$FRONTEND/package.json" ]] || die "run from the repo root"

  say "Configuration (backend/.env)"
  local env_file="$BACKEND/.env"
  local DATABASE_URL="${DATABASE_URL:-}" AUTH_SECRET="${AUTH_SECRET:-}" SETUP_TOKEN="${SETUP_TOKEN:-}"
  if [[ -f "$env_file" && "$RECREATE_SECRETS" -eq 0 ]]; then
    echo "keeping existing $env_file (use --recreate-secrets to regenerate)"
    # shellcheck disable=SC1090
    set -a; source "$env_file"; set +a
  fi
  prompt DATABASE_URL "Postgres connection string" \
    "${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/office_mgmt_final}"
  [[ -z "${AUTH_SECRET:-}" || "$RECREATE_SECRETS" -eq 1 ]] && AUTH_SECRET="$(rand_hex 32)" && echo "generated AUTH_SECRET"
  [[ -z "${SETUP_TOKEN:-}" || "$RECREATE_SECRETS" -eq 1 ]] && SETUP_TOKEN="$(rand_hex 24)" && echo "generated SETUP_TOKEN"
  export DATABASE_URL AUTH_SECRET SETUP_TOKEN
  [[ "$INTERACTIVE" -eq 0 && -z "${DATABASE_URL:-}" ]] && die "DATABASE_URL is required in --non-interactive mode"

  say "Writing $env_file (other existing keys preserved)"
  touch "$env_file"; chmod 600 "$env_file"
  local tmp_env
  tmp_env="$(mktemp)"
  grep -v -e '^DATABASE_URL=' -e '^AUTH_SECRET=' -e '^SETUP_TOKEN=' "$env_file" > "$tmp_env" || true
  {
    echo "DATABASE_URL=$DATABASE_URL"
    echo "AUTH_SECRET=$AUTH_SECRET"
    echo "SETUP_TOKEN=$SETUP_TOKEN"
  } >> "$tmp_env"
  cat "$tmp_env" > "$env_file"; rm -f "$tmp_env"

  if [[ "$DO_INSTALL" -eq 1 ]]; then
    say "Installing dependencies (npm ci)"
    npm ci --prefix "$BACKEND"
    npm ci --prefix "$FRONTEND"
  fi

  if [[ "$DO_MIGRATE" -eq 1 ]]; then
    say "Applying schema db/01..13 + seed"
    (cd "$BACKEND" && npm run migrate)
    say "Verifying seed"
    local emps
    emps="$(psql "$DATABASE_URL" -t -c 'SELECT count(*) FROM employees;')"
    echo "employees: $emps (expect 7)"
    [[ "${emps// /}" == "7" ]] || die "unexpected seed count — inspect migration output above"
  fi

  if [[ "$DO_BUILD" -eq 1 ]]; then
    say "Building frontend (public + admin)"
    npm run build --prefix "$FRONTEND"
    npm run build:admin --prefix "$FRONTEND"
    say "Checking bundle split (admin code must not leak into public bundle)"
    ! grep -rq "AdminPanel" "$FRONTEND"/dist/assets/*.js
    ! grep -rq "ProjectChat" "$FRONTEND"/dist-admin/assets/*.js
    echo "split clean"
  fi

  cat <<EOF

Done. Next steps:
  1. Start the API:      npm run dev --prefix backend        # :4000 (ADMIN_MODE=all)
  2. Start the portal:    npm run dev --prefix frontend       # :5173
     Back-office dev:     VITE_BACKEND_TARGET=http://localhost:4001 npm run dev:admin --prefix frontend  # :5174
  3. Create the first admin (then REMOVE the token from backend/.env):
       curl -X POST http://localhost:4000/api/admin/bootstrap \\
         -H 'content-type: application/json' \\
         -d '{"email":"admin@example.com","password":"ChangeMe123","setupToken":"'"$SETUP_TOKEN"'"}'
  4. Seeded people (no passwords yet — provision them from the back-office):
     ceo@, cto@, manager@, l3@, l2@, l1@, hr@example.com
     (Admin panel → Access → Reset password, or Employees → Add employee)

Config saved in backend/.env (gitignored — never commit it).
EOF
}

# --------------------------------------------------------------- docker mode
setup_docker() {
  say "Checking prerequisites"
  check_node
  need docker
  docker compose version >/dev/null 2>&1 || die "docker compose plugin required"
  local env_file="$ROOT/.env"
  local POSTGRES_USER="${POSTGRES_USER:-office_mgmt}" POSTGRES_DB="${POSTGRES_DB:-office_mgmt_final}"
  local POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" AUTH_SECRET="${AUTH_SECRET:-}" SETUP_TOKEN="${SETUP_TOKEN:-}"

  if [[ -f "$env_file" && "$RECREATE_SECRETS" -eq 0 ]]; then
    echo "keeping existing $env_file (use --recreate-secrets to regenerate)"
    # shellcheck disable=SC1090
    set -a; source "$env_file"; set +a
    POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
  fi
  [[ -z "${POSTGRES_PASSWORD:-}" || "$RECREATE_SECRETS" -eq 1 ]] && POSTGRES_PASSWORD="$(rand_hex 24)" && echo "generated POSTGRES_PASSWORD"
  [[ -z "${AUTH_SECRET:-}" || "$RECREATE_SECRETS" -eq 1 ]] && AUTH_SECRET="$(rand_hex 32)" && echo "generated AUTH_SECRET"
  : "${SETUP_TOKEN:=}"
  export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB AUTH_SECRET SETUP_TOKEN
  COOKIE_SECURE="${COOKIE_SECURE:-false}"
  export COOKIE_SECURE

  say "Writing $env_file"
  cat > "$env_file" <<EOF
# Generated by ./setup.sh --docker on $(date -u +%FT%TZ). Never commit.
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB
AUTH_SECRET=$AUTH_SECRET
SETUP_TOKEN=$SETUP_TOKEN
COOKIE_SECURE=$COOKIE_SECURE
PUBLIC_API_PORT=4000
ADMIN_API_PORT=4001
PORTAL_PORT=8080
ADMIN_PORTAL_PORT=8081
EOF
  chmod 600 "$env_file"

  say "Starting Postgres"
  docker compose -f "$ROOT/docker-compose.yml" up -d db

  if [[ "$DO_MIGRATE" -eq 1 ]]; then
    say "Applying schema + seed (one-shot migrate service)"
    docker compose -f "$ROOT/docker-compose.yml" run --rm migrate
  fi

  say "Building + starting all services"
  docker compose -f "$ROOT/docker-compose.yml" up -d --build
  docker compose -f "$ROOT/docker-compose.yml" ps

  cat <<EOF

Done. Open:
  Employee portal:  http://localhost:8080   (API :4000)
  Back-office:      http://localhost:8081   (API :4001, keep this URL private)

Bootstrap the first admin (run once, then clear SETUP_TOKEN in .env):
  curl -X POST http://localhost:4001/api/admin/bootstrap \\
    -H 'content-type: application/json' \\
    -d '{"email":"admin@example.com","password":"ChangeMe123","setupToken":"'"$SETUP_TOKEN"'"}'
Then: docker compose restart backend-admin   # with SETUP_TOKEN emptied

Handy: docker compose logs -f backend-public | backend-admin | frontend-public
Stop:  docker compose down        (add -v to also drop the pgdata volume)
EOF
}

case "$MODE" in
  local) setup_local ;;
  docker) setup_docker ;;
esac
