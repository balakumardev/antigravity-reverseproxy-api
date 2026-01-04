#!/usr/bin/env bash
set -euo pipefail

SERVICE="antigravity-claude-proxy"
API_URL="http://localhost:48123"

# Optional: set SKIP_SSL_VERIFY=1 to bypass SSL verification (for corporate proxies)
SKIP_SSL_VERIFY="${SKIP_SSL_VERIFY:-0}"

function get_ssl_env() {
  if [[ "$SKIP_SSL_VERIFY" == "1" ]]; then
    echo "-e NODE_TLS_REJECT_UNAUTHORIZED=0"
  else
    echo ""
  fi
}

function ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required" >&2
    exit 1
  fi
}

function accounts_exist() {
  docker compose run --rm "${SERVICE}" node --input-type=module -e "import fs from 'node:fs'; process.exit(fs.existsSync('/data/accounts.json') ? 0 : 1)"
}

function add_accounts() {
  echo "Starting Google OAuth account setup..."
  echo "If the browser doesn't open, copy/paste the URL from the output."
  echo "OAuth callback listens on http://localhost:51121"
  docker compose run --rm -p 51121:51121 -e NODE_TLS_REJECT_UNAUTHORIZED=0 "${SERVICE}" node bin/cli.js accounts add

  if ! accounts_exist; then
    echo "" >&2
    echo "ERROR: No accounts were saved to /data/accounts.json." >&2
    echo "Re-run: bash bin/docker-local.sh auth" >&2
    exit 1
  fi
}

function start_proxy() {
  docker compose up -d --build
  echo "Proxy is starting: ${API_URL}"
  echo "Health check: ${API_URL}/health"
}

function stop_proxy() {
  docker compose down
}

function show_usage() {
  cat <<EOF
Usage:
  bash bin/docker-local.sh              # build, (auth if needed), start
  bash bin/docker-local.sh auth         # run Google OAuth account setup
  bash bin/docker-local.sh up           # start proxy (detached)
  bash bin/docker-local.sh down         # stop proxy
  bash bin/docker-local.sh logs         # follow logs
EOF
}

ensure_docker

cmd="${1:-setup}"

case "${cmd}" in
  setup)
    docker compose build
    if ! accounts_exist; then
      echo "No accounts found in Docker volume. Running first-time auth..."
      docker compose stop "${SERVICE}" >/dev/null 2>&1 || true
      add_accounts
    fi
    start_proxy
    ;;
  auth)
    docker compose stop "${SERVICE}" >/dev/null 2>&1 || true
    add_accounts
    ;;
  up)
    start_proxy
    ;;
  down)
    stop_proxy
    ;;
  logs)
    docker compose logs -f
    ;;
  *)
    show_usage
    exit 1
    ;;
esac
