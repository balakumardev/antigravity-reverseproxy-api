# Cloudflare Worker Setup (from scratch)

This project can run as a Cloudflare Worker exposing both Anthropic-compatible and OpenAI-compatible endpoints:

- **Anthropic API**: `/v1/messages`, `/v1/models`
- **OpenAI API**: `/v1/chat/completions`, `/v1/models`

Important limitation: Workers **cannot** extract tokens from a local Antigravity installation/database. You must provide credentials via **OAuth refresh tokens** (recommended) or a **manual API key**.

## Prerequisites

- Node.js 18+
- A Cloudflare account

## 1) Install dependencies

```bash
npm install
```

## 2) Create an account config (OAuth)

You need an `accounts.json` (multi-account supported). Pick one of these flows:

### Option A (recommended): generate `accounts.json` via Docker

This stores accounts in the Docker volume used by the proxy.

```bash
# Runs Google OAuth flow (callback is http://localhost:51121)
bash bin/docker-local.sh auth
```

Then upload that config as the Worker secret:

```bash
docker compose run --rm antigravity-claude-proxy cat /data/accounts.json | npm run worker:secret:accounts
```

### Option B: generate `accounts.json` on your machine

This writes to `~/.config/antigravity-proxy/accounts.json`.

```bash
npm run accounts:add
cat ~/.config/antigravity-proxy/accounts.json | npm run worker:secret:accounts
```

## 3) Login to Cloudflare (one-time)

```bash
npm run worker:login
```

## 4) Run locally (dev)

`wrangler dev` can run in:

- **Local mode**: uses a local `.dev.vars` file (does *not* use deployed secrets)
- **Remote mode**: runs on Cloudflare and can use your deployed secrets

To run using your deployed secret (`ACCOUNTS_JSON`):

```bash
npm run worker:dev -- --remote
```

## 5) Deploy

```bash
npm run worker:deploy
```

After deploy, your Worker will be available on your Cloudflare route (for example, `https://antigravity-claude-proxy.<your-subdomain>.workers.dev`).

## Configure Claude Code to use the Worker

Set `ANTHROPIC_BASE_URL` to your Worker URL, for example:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "https://antigravity-claude-proxy.<your-subdomain>.workers.dev"
  }
}
```

## Configure OpenAI-compatible clients

For OpenAI SDK or other OpenAI-compatible clients:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://antigravity-claude-proxy.<your-subdomain>.workers.dev/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

Or via curl:

```bash
curl https://antigravity-claude-proxy.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Optional Worker variables

- `DEBUG=true` enables debug logs
- `FALLBACK=true` enables model fallback on quota exhaustion

