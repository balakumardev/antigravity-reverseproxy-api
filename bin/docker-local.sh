#!/usr/bin/env bash
set -euo pipefail

SERVICE="antigravity-claude-proxy"
API_URL="http://localhost:48123"
VOLUME_NAME="antigravity-claude-proxy_antigravity-data"

# Optional: set SKIP_SSL_VERIFY=1 to bypass SSL verification (for corporate proxies)
SKIP_SSL_VERIFY="${SKIP_SSL_VERIFY:-0}"

function ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required" >&2
    exit 1
  fi
}

function ensure_volume() {
  # Create the named volume if it doesn't exist
  if ! docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1; then
    echo "Creating persistent volume for accounts..."
    docker volume create "${VOLUME_NAME}"
  fi
}

function accounts_exist() {
  # Check if accounts.json exists in the volume
  docker run --rm -v "${VOLUME_NAME}:/data" alpine test -f /data/accounts.json 2>/dev/null
}

function add_accounts() {
  echo ""
  echo "=========================================="
  echo "  Google OAuth Account Setup"
  echo "=========================================="
  echo ""
  echo "A browser window will open for Google login."
  echo "If it doesn't open, copy/paste the URL from the output."
  echo ""
  echo "OAuth callback: http://localhost:51121"
  echo ""

  # Build first to ensure we have the latest code
  docker compose build --quiet

  # Run accounts add with volume mounted and OAuth port exposed
  docker compose run --rm \
    -p 51121:51121 \
    -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
    -e ACCOUNT_CONFIG_PATH=/data/accounts.json \
    "${SERVICE}" node bin/cli.js accounts add

  if ! accounts_exist; then
    echo "" >&2
    echo "ERROR: No accounts were saved." >&2
    echo "Re-run: bash bin/docker-local.sh auth" >&2
    exit 1
  fi

  echo ""
  echo "Account setup complete! Refresh tokens are stored persistently."
  echo "You won't need to re-authenticate unless you revoke access."
  echo ""
}

function start_proxy() {
  docker compose up -d --build
  echo ""
  echo "=========================================="
  echo "  Antigravity Claude Proxy Started"
  echo "=========================================="
  echo ""
  echo "  API endpoint: ${API_URL}"
  echo "  Health check: ${API_URL}/health"
  echo ""
  echo "  Configure Claude Code:"
  echo "    export ANTHROPIC_BASE_URL=${API_URL}"
  echo "    export ANTHROPIC_API_KEY=dummy"
  echo ""
  echo "  View logs: bash bin/docker-local.sh logs"
  echo ""
}

function stop_proxy() {
  docker compose down
  echo "Proxy stopped."
}

function show_status() {
  echo "Checking proxy status..."
  if curl -s "${API_URL}/health" >/dev/null 2>&1; then
    echo ""
    curl -s "${API_URL}/health" | python3 -m json.tool 2>/dev/null || curl -s "${API_URL}/health"
    echo ""
  else
    echo "Proxy is not running or not responding."
  fi
}

function show_usage() {
  cat <<EOF

Antigravity Claude Proxy - Docker Management

Usage:
  bash bin/docker-local.sh              # First-time setup (build, auth, start)
  bash bin/docker-local.sh auth         # Add/re-authenticate Google account
  bash bin/docker-local.sh up           # Start proxy
  bash bin/docker-local.sh down         # Stop proxy
  bash bin/docker-local.sh logs         # Follow logs
  bash bin/docker-local.sh status       # Check proxy health

After initial setup, the proxy will:
  - Automatically refresh OAuth tokens (no manual intervention needed)
  - Persist refresh tokens across container restarts
  - Handle token rotation automatically

EOF
}

ensure_docker

cmd="${1:-setup}"

case "${cmd}" in
  setup)
    ensure_volume
    docker compose build
    if ! accounts_exist; then
      echo "No accounts found. Running first-time setup..."
      docker compose stop "${SERVICE}" >/dev/null 2>&1 || true
      add_accounts
    fi
    start_proxy
    ;;
  auth)
    ensure_volume
    docker compose stop "${SERVICE}" >/dev/null 2>&1 || true
    add_accounts
    start_proxy
    ;;
  up)
    ensure_volume
    start_proxy
    ;;
  down)
    stop_proxy
    ;;
  logs)
    docker compose logs -f
    ;;
  status)
    show_status
    ;;
  help|--help|-h)
    show_usage
    ;;
  *)
    show_usage
    exit 1
    ;;
esac
