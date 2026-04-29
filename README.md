# llm-privacy-proxy

Transparent PII and secret tokenization proxy for the Anthropic API. Sits between Claude Code (or any LLM client) and `api.anthropic.com` — tokenizing secrets and PII in outbound requests and detokenizing tokens in responses — so the user sees real data and the LLM provider never does.

Works with both **API key** and **OAuth / Claude MAX subscription** auth.

## How It Works

```mermaid
sequenceDiagram
    participant U as User / Claude Code
    participant P as llm-privacy-proxy<br/>(localhost:4444)
    participant V as Encrypted Vault<br/>(~/.llm-privacy/vault.enc.json)
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
    SS["SessionStart hook\nauto-starts proxy if not running"]

    SS -.->|ensures running| SRV

    CC -->|POST /v1/messages| SRV

    subgraph proxy ["llm-privacy-proxy  (localhost:4444)"]
        SRV["server.ts\nBun.serve :4444"]
        SRV -->|tokenize outbound| TK["transform.ts\ntokenizeMessages"]
        SRV -->|passthrough| PT["all other paths"]
        SRV -->|GET /health| HL["stats: requests\ntokenized / detokenized"]
        TK --> SC["core.ts\nHMAC-SHA256 makeToken\nregex scan"]
        SC -->|matches| VW["vault.ts\nFileVault.put"]
        SRV -->|non-stream response| DTK["transform.ts\ndetokenizeBody"]
        SRV -->|stream response| SDT["transform.ts\nStreamDetokenizer\n(sliding buffer)"]
        DTK --> VR["vault.ts\nFileVault.get"]
        SDT --> VR
    end

    SRV -->|tokenized request| ANT["api.anthropic.com"]
    ANT -->|raw response| SRV
    VW --> ENC[("vault.enc.json\nAES-256-GCM")]
    VR --> ENC
```

## Setup

### 1. Clone and install

```bash
git clone ssh://git@gitlab.rsolabs.com:223/ai/llm-privacy-proxy.git
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
bun start
# [llm-proxy] listening on http://localhost:4444 → https://api.anthropic.com
```

Verify it's running:

```bash
curl http://localhost:4444/health
# {"status":"ok","target":"https://api.anthropic.com","requests":0,"tokenized":0,"detokenized":0,...}
```

### 4. Point Claude Code at the proxy

Add **both** entries to `~/.claude/settings.json` — the env var and the auto-start hook together, so the proxy is always running before any session uses it:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4444"
  },
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bash -c 'source ~/.bashrc 2>/dev/null; pgrep -f llm-privacy-proxy > /dev/null || (cd /path/to/llm-privacy-proxy && nohup bun src/index.ts >> /tmp/llm-proxy.log 2>&1 &)'"
      }]
    }]
  }
}
```

> **Never** add `ANTHROPIC_BASE_URL` without the auto-start hook in place. If the proxy isn't running when a session starts, all Claude Code sessions will fail to connect.

Restart Claude Code. All API calls now flow through the proxy transparently — including OAuth/Claude MAX sessions.

## Running Tests

```bash
bun test
```

End-to-end test (requires `source ~/.bashrc` first to load keys):

```bash
# Start proxy
bun start &

# Verify health
curl http://localhost:4444/health

# Send a request through (replace TOKEN with your key or OAuth token)
curl http://localhost:4444/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $TOKEN" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"Reply: PROXY_OK"}]}'
```

## What Gets Tokenized

All patterns apply silently — no prompts, no blocks. The user types freely; the LLM sees only tokens.

| Pattern | Example |
|---|---|
| `api_key_anthropic` | `sk-ant-api03-...` → `tok_aBcDeFgHiJkL` |
| `api_key_openai` | `sk-proj-...` → `tok_xYzAbCdEfGh` |
| `api_key_aws_access` | `AKIAIOSFODNN7EXAMPLE` → `tok_...` |
| `api_key_github` | `ghp_...` → `tok_...` |
| `api_key_xai` | `xai-...` → `tok_...` |
| `pii_email` | `user@example.com` → `tok_...` |
| `pii_phone_us` | `(555) 123-4567` → `tok_...` |
| `pii_ssn_us` | `123-45-6789` → `tok_...` |
| `pii_credit_card` | `4111 1111 1111 1111` → `tok_...` |

Disable specific patterns: `LLM_PRIVACY_DISABLE_PATTERNS=pii_email,pii_phone_us`

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PRIVACY_HMAC_KEY` | Yes | — | 32-byte base64 HMAC key — **never regenerate** |
| `LLM_PRIVACY_VAULT_KEY` | Yes | — | 32-byte base64 AES-256-GCM vault encryption key |
| `LLM_PROXY_PORT` | No | `4444` | Port the proxy listens on |
| `LLM_PROXY_TARGET` | No | `https://api.anthropic.com` | Upstream API base URL |
| `LLM_PRIVACY_VAULT_PATH` | No | `~/.llm-privacy/vault.enc.json` | Shared with middleware if desired |
| `LLM_PRIVACY_DISABLE_PATTERNS` | No | — | Comma-separated pattern types to skip |

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
