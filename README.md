# llm-privacy-proxy

**Inline transparent bidirectional tokenization proxy for the Anthropic API.** Sits between Claude Code (or any LLM client) and `api.anthropic.com` — automatically tokenizing secrets and PII in outbound requests and detokenizing tokens in responses — so the user sees real data and the LLM provider never does.

The core power is **bidirectional transparency**: your client sends real data, the LLM sees tokens, and the LLM's response is automatically de-tokenized before it reaches you — all without any changes to client code, prompts, or workflow. You can also use it for simple outbound blocking (strip secrets before they leave), but the full value is the round-trip: the LLM can reference and reason about tokenized values, and you still see the originals in every response.

Works with both **API key** and **OAuth / Claude MAX subscription** auth. No client changes needed — just point `ANTHROPIC_BASE_URL` at the proxy.

## Why Bidirectional Tokenization?

Most privacy approaches either **block** (refuse to send sensitive data) or **redact** (strip it out). Both break LLM usefulness — the model can't help you if it can't see context.

Bidirectional tokenization gives you the best of both worlds:

- **LLM never sees real PII or secrets** — only opaque tokens like `tok_xAbCdEfGhIjK`
- **LLM can still reason about them** — it can reference, compare, and respond using tokens
- **You see real data in every response** — the proxy detokenizes on the way back, automatically
- **Zero workflow changes** — no prompts to modify, no client code to update, no blocking that breaks tasks
- **Works for any LLM client** — not just Claude Code; any HTTP client pointing at the proxy

This makes it ideal for agentic workflows where the LLM needs to handle API keys, credentials, emails, or other sensitive context without exfiltrating it to the provider.

## How It Works

```mermaid
sequenceDiagram
    participant U as User / Claude Code
    participant P as llm-privacy-proxy<br/>(localhost:4444)
    participant V as Encrypted Vault<br/>(~/.llm-privacy/vault.db)
    participant A as api.anthropic.com

    U->>P: POST /v1/messages<br/>{"content": "my key is sk-ant-..."}
    P->>P: scan for secrets/PII
    P->>V: store tok_xAbCdEfGhIjK → sk-ant-...
    P->>A: POST /v1/messages<br/>{"content": "my key is tok_xAbCdEfGhIjK"}
    A-->>P: "I see tok_xAbCdEfGhIjK in your message..."
    P->>V: lookup tok_xAbCdEfGhIjK → sk-ant-...
    P-->>U: "I see sk-ant-... in your message..."
```

Streaming responses are handled with a sliding-buffer detokenizer that correctly reassembles tokens split across SSE `text_delta` chunks.

## Architecture

```mermaid
flowchart TD
    CC["Claude Code\nANTHROPIC_BASE_URL=localhost:4444\n(API key or OAuth/MAX)"]
    SS["SessionStart hook\nauto-starts proxy via proxy.sh"]

    SS -.->|ensures running| SRV

    CC -->|POST /v1/messages| SRV

    subgraph proxy ["llm-privacy-proxy  (localhost:4444)"]
        SRV["server.ts\nBun.serve :4444"]
        SRV -->|tokenize outbound| TK["transform.ts\ntokenizeMessages"]
        SRV -->|passthrough| PT["all other paths"]
        SRV -->|GET /health| HL["stats: requests\ntokenized / detokenized"]
        TK --> SC["core.ts\nHMAC-SHA256 makeToken\nregex scan"]
        SC -->|matches| VW["vault.ts\nSqliteVault.put"]
        SRV -->|non-stream response| DTK["transform.ts\ndetokenizeBody"]
        SRV -->|stream response| SDT["transform.ts\nStreamDetokenizer\n(sliding buffer)"]
        DTK --> VR["vault.ts\nSqliteVault.get"]
        SDT --> VR
    end

    SRV -->|tokenized request| ANT["api.anthropic.com"]
    ANT -->|raw response| SRV
    VW --> ENC[("vault.db\nSQLite WAL\n+ AES-256-GCM")]
    VR --> ENC
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/JonathanReifer/llm-privacy-proxy.git
cd llm-privacy-proxy
```

### 2. Run the one-time setup script

Generates HMAC + vault encryption keys and appends them to `~/.bashrc`. Safe to run multiple times — skips keys that are already present.

```bash
bash setup.sh
source ~/.bashrc
```

> **Important:** `LLM_PRIVACY_HMAC_KEY` must never be regenerated after first use. It's the key used for deterministic tokenization — regenerating it makes all existing vault tokens unresolvable.

### 3. Start the proxy

```bash
./proxy.sh start
#   ✓ Proxy started (PID 12345) → http://localhost:4444
```

Verify it's running:

```bash
./proxy.sh status
#   Status:   running (PID 12345)
#   Version:  0.2.0
#   URL:      http://localhost:4444
#   Target:   https://api.anthropic.com
#   Vault:    sqlite  (~/.llm-privacy/vault.db)
#   Traffic:  0 requests  0 tokenized  0 detokenized
#   Since:    2026-05-01T12:00:00.000Z
```

### 4. Point Claude Code at the proxy

Add **both** entries to `~/.claude/settings.json` — the env var routes traffic through the proxy, and the SessionStart hook ensures it's always running before any session uses it:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4444"
  },
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bash -c 'source ~/.bashrc 2>/dev/null; /path/to/llm-privacy-proxy/proxy.sh start'"
      }]
    }]
  }
}
```

> **Never** add `ANTHROPIC_BASE_URL` without the SessionStart hook in place. If the proxy isn't running when a session starts, all Claude Code sessions will fail to connect.

Restart Claude Code. All API calls now flow through the proxy transparently — including OAuth/Claude MAX sessions.

## Managing the Proxy

All lifecycle operations go through `proxy.sh`:

| Command | Description |
|---|---|
| `./proxy.sh start` | Start the proxy daemon (no-op if already running) |
| `./proxy.sh stop` | Gracefully stop via SIGTERM, SIGKILL after 10s timeout |
| `./proxy.sh restart` | Stop then start |
| `./proxy.sh status` | Show running status, version, vault mode, traffic counters |

The proxy writes logs to `/tmp/llm-proxy.log` and stores its PID in `/tmp/llm-proxy.pid`.

Stats (request counts, tokenized/detokenized) persist to the SQLite vault on SIGTERM and every 60 seconds, so counters survive restarts.

## What Gets Tokenized

All patterns apply silently — no prompts, no blocks. The user types freely; the LLM sees only tokens.

| Pattern | Severity | Example match |
|---|---|---|
| `api_key_anthropic` | block | `sk-ant-api03-...` |
| `api_key_openai` | block | `sk-proj-...` |
| `api_key_xai` | block | `xai-...` |
| `api_key_aws_access` | block | `AKIAIOSFODNN7EXAMPLE` |
| `api_key_aws_secret` | block | `aws_secret_key = ...` (key=value) |
| `api_key_github` | block | `ghp_...` |
| `api_key_google` | block | `AIza...` |
| `api_key_slack` | block | `xoxb-...` / `xoxp-...` |
| `api_key_stripe` | block | `sk_live_...` / `sk_test_...` |
| `api_key_twilio` | block | `SK` + 32 hex chars |
| `api_key_sendgrid` | block | `SG.xxx.xxx` |
| `api_key_generic` | block | `api_key = ...` / `password = ...` (key=value) |
| `pii_email` | warn | `user@example.com` |
| `pii_phone_us` | warn | `(555) 123-4567` |
| `pii_ssn_us` | block | `123-45-6789` |
| `pii_credit_card` | block | `4111 1111 1111 1111` |
| `pii_ipv4` | warn | `192.168.1.1` |
| `pii_passport_us` | block | `A1234567` |
| `pii_dob` | warn | `01/15/1990` |

**Severity:** `block` = secrets that must never reach the provider. `warn` = PII worth tokenizing but less critical. Both are tokenized identically — severity is metadata for future filtering.

Disable specific patterns: `LLM_PRIVACY_DISABLE_PATTERNS=pii_email,pii_phone_us`

## Vault Persistence

The vault is a SQLite database (`~/.llm-privacy/vault.db`) with each original value encrypted individually using AES-256-GCM. Every token mapping survives proxy restarts — the LLM can reference a token from a previous session and the proxy will still detokenize it correctly.

SQLite WAL mode is enabled, which allows unlimited concurrent readers and serializes writers without blocking — safe for any number of simultaneous Claude Code sessions.

**The proxy will refuse to start without `LLM_PRIVACY_VAULT_KEY`.** This is intentional: without the key, the vault falls back to in-memory-only storage and all token mappings are lost on restart, breaking detokenization across sessions.

Verify that persistence is active on a running proxy:

```bash
curl -s http://localhost:4444/health | jq '{vaultMode, vaultPath}'
# {
#   "vaultMode": "sqlite",
#   "vaultPath": "/home/you/.llm-privacy/vault.db"
# }
```

If you see `"vaultMode": "memory"`, the proxy started without the key — stop it, run `source ~/.bashrc`, and restart.

## Session-Scoped Tokenization

Pass `x-session-id` in your request headers to scope token storage to a specific session. The session ID is stored alongside each vault entry and surfaced in the review CLI — useful for tracing which session first introduced a given token.

```bash
curl http://localhost:4444/v1/messages \
  -H "x-session-id: my-session-abc123" \
  -H "content-type: application/json" \
  ...
```

Claude Code automatically supplies a session ID via its normal headers; most clients don't need to set this manually.

## Prompt Logging

The proxy can log all prompt content to a JSONL file for auditing.

**Modes** (set via `LLM_PRIVACY_LOG_PROMPTS`):
- `none` (default) — no logging
- `tokenized` — log the tokenized version of each request (secrets replaced with tokens)
- `full` — log both original and tokenized versions (**stores raw secrets on disk** — use with care)

Log format (one JSON object per line):

```json
{
  "ts": "2026-05-01T00:00:00.000Z",
  "sessionId": "abc123",
  "matchCount": 2,
  "tokenized": ["\"my key is tok_xAbCdEfGhIjK\""],
  "original": ["\"my key is sk-ant-...\""]
}
```

(`original` field only present when `LLM_PRIVACY_LOG_PROMPTS=full`)

Log file path: `~/.llm-privacy/prompts.jsonl` (override with `LLM_PRIVACY_LOG_PATH`).

## Inspecting the Vault

The proxy exposes live vault inspection endpoints — all data is decrypted in-memory and returned as JSON. These are only available on localhost.

### Recent tokenized values

```bash
curl -s http://localhost:4444/vault | jq
```

Returns the 50 most recent entries (newest first). Use `?limit=N` (`0` = unlimited):

```json
[
  {
    "token": "tok_xAbCdEfGhIjK",
    "original": "sk-ant-api03-...",
    "type": "api_key_anthropic",
    "createdAt": "2026-04-30T01:22:11.000Z",
    "sessionId": "abc123",
    "refCount": 3,
    "lastAccessedAt": "2026-05-01T09:00:00.000Z"
  }
]
```

### Most-accessed entries (hot tokens)

```bash
curl -s "http://localhost:4444/vault/hot?limit=20" | jq
```

Returns entries ordered by access frequency (`refCount` DESC). Default limit is 20.

### Counts by pattern type

```bash
curl -s http://localhost:4444/vault/stats | jq
# {"api_key_anthropic": 3, "pii_email": 7, "api_key_github": 1}
```

### Search by token or original value

```bash
# Find all entries containing a fragment of the original value
curl -s "http://localhost:4444/vault/search?q=sk-ant" | jq

# Or look up a specific token
curl -s "http://localhost:4444/vault/search?q=tok_xAbCdEfGhIjK" | jq
```

## CLI Review Tool

The `bun run review` CLI provides offline vault inspection without a running proxy.

```bash
# List recent entries (default 50)
bun run review list
bun run review list --limit 100

# Search by token prefix or original value fragment
bun run review search alice@example.com
bun run review search tok_xAb

# Vault statistics (entry counts by type, file size)
bun run review stats

# Export all entries
bun run review export          # JSON array
bun run review export --csv    # CSV with header row
```

Output columns: `Token`, `Type`, `Created`, `Refs` (access count), `Original`.

The CLI reads `LLM_PRIVACY_VAULT_PATH` (defaults to `~/.llm-privacy/vault.db`) and requires `LLM_PRIVACY_VAULT_KEY` to decrypt originals.

## Running Tests

```bash
bun test
```

End-to-end smoke test (requires `source ~/.bashrc` first to load keys):

```bash
# Start proxy
./proxy.sh start

# Verify health
curl http://localhost:4444/health

# Send a request through (replace TOKEN with your key or OAuth token)
curl http://localhost:4444/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $TOKEN" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"Reply: PROXY_OK"}]}'
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PRIVACY_HMAC_KEY` | Yes | — | 32-byte base64url HMAC key — **never regenerate** |
| `LLM_PRIVACY_VAULT_KEY` | Yes | — | 32-byte base64url AES-256-GCM vault encryption key |
| `LLM_PROXY_PORT` | No | `4444` | Port the proxy listens on |
| `LLM_PROXY_TARGET` | No | `https://api.anthropic.com` | Upstream API base URL |
| `LLM_PRIVACY_VAULT_PATH` | No | `~/.llm-privacy/vault.db` | Custom SQLite database path |
| `LLM_PRIVACY_DISABLE_PATTERNS` | No | — | Comma-separated pattern types to skip |
| `LLM_PRIVACY_LOG_PROMPTS` | No | `none` | Prompt logging mode: `none`, `tokenized`, or `full` |
| `LLM_PRIVACY_LOG_PATH` | No | `~/.llm-privacy/prompts.jsonl` | Path for prompt log JSONL file |
| `LLM_PROXY_IDLE_TIMEOUT` | No | `600` | Socket idle timeout in seconds; 0 disables — 600s covers all Anthropic SSE thinking gaps |

## Relationship to llm-privacy-middleware

These two repos are complementary — run both for full coverage:

| | llm-privacy-middleware | llm-privacy-proxy |
|---|---|---|
| **Mechanism** | Claude Code hooks | HTTP proxy |
| **Prompt tokenization** | ✗ hooks can't rewrite prompts | ✓ transparent |
| **Response detokenization** | ✗ | ✓ transparent |
| **Tool call guard** (Bash/Write/Edit) | ✓ | ✗ |
| **Auth support** | N/A | API key + OAuth/MAX |
| **Best used for** | Blocking secrets in file writes and shell commands | Transparent LLM API round-trip |
