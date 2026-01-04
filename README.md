# Antigravity Claude Proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A proxy server that exposes both **Anthropic-compatible** and **OpenAI-compatible** APIs backed by **Antigravity's Cloud Code**, letting you use Claude and Gemini models with **Claude Code CLI**, **OpenAI SDK**, and other compatible clients.

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│                     │     │                            │
│   (Anthropic)    │     │  This Proxy Server  │────▶│  Antigravity Cloud Code    │
├──────────────────┤     │  (Anthropic/OpenAI  │     │  (daily-cloudcode-pa.      │
│   OpenAI SDK     │────▶│   → Google GenAI)   │     │   sandbox.googleapis.com)  │
│   (OpenAI)       │     │                     │     │                            │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API** or **OpenAI Chat Completions API** format
2. Uses OAuth tokens from added Google accounts (or Antigravity's local database)
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API
5. Converts responses back to **Anthropic** or **OpenAI format** with full thinking/streaming support

## Prerequisites

- **Node.js** 18 or later (for local runs and OAuth account setup)
- **Antigravity** installed (optional, for single-account mode) OR Google account(s) for multi-account mode
- **Docker** (optional, to run the proxy as a container)
- **Cloudflare account + Wrangler** (optional, to run as a Cloudflare Worker)

---

## Run Options

### Docker (Local) — recommended

One command (builds image, runs OAuth setup if needed, starts the proxy):

```bash
bash bin/docker-local.sh
```

Proxy runs at `http://localhost:48123`.

Accounts are stored in a named Docker volume (`antigravity_proxy_data`) at `/data/accounts.json` inside the container.

### Cloudflare Worker (Edge)

See `CLOUDFLARE_WORKER_SETUP.md` for a from-scratch setup guide.

### Local (Node) (dev)

```bash
npm install
npm run accounts:add   # optional
npm start
```

Proxy runs at `http://localhost:48123` by default.

---

## Quick Start

### 1. Add Account(s)

You have two options:

**Option A: Use Antigravity (Single Account)**

If you have Antigravity installed and logged in, the proxy will automatically extract your token. No additional setup needed.

**Option B: Add Google Accounts via OAuth (Recommended for Multi-Account)**

Add one or more Google accounts for load balancing:

```bash
# Docker (stores accounts in the Docker volume)
bash bin/docker-local.sh auth

# Local (dev)
npm run accounts:add
```

This opens your browser for Google OAuth. Sign in and authorize access. Repeat for multiple accounts.

Manage accounts:

```bash
# Docker
docker compose run --rm antigravity-claude-proxy node bin/cli.js accounts list
docker compose run --rm antigravity-claude-proxy node bin/cli.js accounts verify

# Local (dev)
npm run accounts:list
npm run accounts:verify
npm run accounts
```

### 2. Start the Proxy Server

```bash
# Docker
bash bin/docker-local.sh up

# Local (dev)
npm start
```

The server runs on `http://localhost:48123` by default.

### 3. Verify It's Working

```bash
# Health check
curl http://localhost:48123/health

# Check account status and quota limits
curl "http://localhost:48123/account-limits?format=table"
```

---

## Using with Claude Code CLI

### Configure Claude Code

Create or edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:48123",
    "ANTHROPIC_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5-thinking"
  }
}
```

Or to use Gemini models:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:48123",
    "ANTHROPIC_MODEL": "gemini-3-pro-high",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3-pro-high",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-2.5-flash-lite",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3-flash"
  }
}
```

### Load Environment Variables

Add the proxy settings to your shell profile:

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:48123"' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="test"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:48123'"
Add-Content $PROFILE "`$env:ANTHROPIC_API_KEY = 'test'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:48123"
setx ANTHROPIC_API_KEY "test"
```

Restart your terminal for changes to take effect.

### Run Claude Code

```bash
# Make sure the proxy is running first (choose one)
bash bin/docker-local.sh up    # Docker
npm start                      # Local Node

# In another terminal, run Claude Code
claude
```

> **Note:** If Claude Code asks you to select a login method, add `"hasCompletedOnboarding": true` to `~/.claude.json` (macOS/Linux) or `%USERPROFILE%\.claude.json` (Windows), then restart your terminal and try again.

---

## Using with OpenAI SDK

The proxy also exposes an OpenAI-compatible Chat Completions API at `/v1/chat/completions`.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:48123/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'http://localhost:48123/v1',
    apiKey: 'not-needed'
});

const response = await client.chat.completions.create({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hello!' }]
});
console.log(response.choices[0].message.content);
```

### curl

```bash
curl http://localhost:48123/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```python
stream = client.chat.completions.create(
    model="gemini-3-flash",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

---

## Available Models

### Claude Models

| Model ID | Description |
|----------|-------------|
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with extended thinking |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 without thinking |

### Gemini Models

| Model ID | Description |
|----------|-------------|
| `gemini-3-flash` | Gemini 3 Flash with thinking |
| `gemini-3-pro-low` | Gemini 3 Pro Low with thinking |
| `gemini-3-pro-high` | Gemini 3 Pro High with thinking |

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

---

## Multi-Account Load Balancing

When you add multiple accounts, the proxy automatically:

- **Sticky account selection**: Stays on the same account to maximize prompt cache hits
- **Smart rate limit handling**: Waits for short rate limits (≤2 min), switches accounts for longer ones
- **Automatic cooldown**: Rate-limited accounts become available after reset time expires
- **Invalid account detection**: Accounts needing re-authentication are marked and skipped
- **Prompt caching support**: Stable session IDs enable cache hits across conversation turns

Check account status anytime:

```bash
curl "http://localhost:48123/account-limits?format=table"
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/account-limits` | GET | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API |
| `/v1/models` | GET | List available models |
| `/refresh-token` | POST | Force token refresh |

---

## Testing

Run the test suite (requires server running):

```bash
# Start server in one terminal
npm start

# Run tests in another terminal
npm test
```

Individual tests:

```bash
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
```

---

## Troubleshooting

### "Could not extract token from Antigravity"

If using single-account mode with Antigravity:
1. Make sure Antigravity app is installed and running
2. Ensure you're logged in to Antigravity

Or add accounts via OAuth instead:
- Docker: `bash bin/docker-local.sh auth`
- Local (dev): `npm run accounts:add`

### 401 Authentication Errors

The token might have expired. Try:
```bash
curl -X POST http://localhost:48123/refresh-token
```

Or re-authenticate the account:
```bash
# Docker
docker compose run --rm -p 51121:51121 antigravity-claude-proxy node bin/cli.js accounts

# Local (dev)
npm run accounts
```

### Rate Limiting (429)

With multiple accounts, the proxy automatically switches to the next available account. With a single account, you'll need to wait for the rate limit to reset.

### Account Shows as "Invalid"

Re-authenticate the account:
```bash
# Docker
docker compose run --rm -p 51121:51121 antigravity-claude-proxy node bin/cli.js accounts

# Local (dev)
npm run accounts
# Choose "Re-authenticate" for the invalid account
```

---

## Safety, Usage, and Risk Notices

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Not Suitable For

- Production application traffic
- High-volume automated extraction
- Any use that violates Acceptable Use Policies

### Warning (Assumption of Risk)

By using this software, you acknowledge and accept the following:

- **Terms of Service risk**: This approach may violate the Terms of Service of AI model providers (Anthropic, Google, etc.). You are solely responsible for ensuring compliance with all applicable terms and policies.

- **Account risk**: Providers may detect this usage pattern and take punitive action, including suspension, permanent ban, or loss of access to paid subscriptions.

- **No guarantees**: Providers may change APIs, authentication, or policies at any time, which can break this method without notice.

- **Assumption of risk**: You assume all legal, financial, and technical risks. The authors and contributors of this project bear no responsibility for any consequences arising from your use.

**Use at your own risk. Proceed only if you understand and accept these risks.**

---

## Legal

- **Not affiliated with Google or Anthropic.** This is an independent open-source project and is not endorsed by, sponsored by, or affiliated with Google LLC or Anthropic PBC.

- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.

- "Claude" and "Anthropic" are trademarks of Anthropic PBC.

- Software is provided "as is", without warranty. You are responsible for complying with all applicable Terms of Service and Acceptable Use Policies.

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT
