# llm-privacy-proxy

Transparent PII and secret tokenization proxy for the Anthropic API. Sits between Claude Code (or any LLM client) and `api.anthropic.com` — tokenizing secrets in outbound requests and detokenizing tokens in responses — so the user sees real data and the LLM provider never does.

## How It Works

```mermaid
sequenceDiagram
    participant U as User / Claude Code
    participant P as llm-privacy-proxy<br/>(localhost:4444)
    participant V as Encrypted Vault<br/>(~/.llm-privacy/vault.enc.json)
    participant A as api.anthropic.com

    U->>P: POST /v1/messages<br/>{"messages": [{"content": "my key is sk-ant-..."}]}
    P->>V: store tok_xAbCdEfGhIjK → sk-ant-...
    P->>A: POST /v1/messages<br/>{"messages": [{"content": "my key is tok_xAbCdEfGhIjK"}]}
    A-->>P: "I see tok_xAbCdEfGhIjK in your message..."
    P->>V: lookup tok_xAbCdEfGhIjK → sk-ant-...
    P-->>U: "I see sk-ant-... in your message..."
```

Streaming responses are handled with a sliding-buffer detokenizer that correctly reassembles tokens split across SSE `text_delta` chunks.

## Architecture

```mermaid
flowchart LR
    CC[Claude Code\nANTHROPIC_BASE_URL=\nlocalhost:4444] --> SRV

    subgraph proxy [llm-privacy-proxy]
        SRV[server.ts\nBun.serve :4444]
        SRV --> |POST /v1/messages| TK[transform.ts\ntokenizeMessages]
        SRV --> |other paths| PT[passthrough]
        TK --> SC[core.ts\nscan + makeToken]
        SC --> |matches| VW[vault.ts\nFileVault.put]
        SRV --> |response| DTK[transform.ts\ndetokenizeBody /\nStreamDetokenizer]
        DTK --> VR[vault.ts\nFileVault.get]
    end

    SRV --> |tokenized request| ANT[api.anthropic.com]
    ANT --> |raw response| SRV
    VW --> ENC[(vault.enc.json\nAES-256-GCM)]
    VR --> ENC
```

## Setup

### 1. Clone and install

```bash
git clone ssh://git@gitlab.rsolabs.com:223/ai/llm-privacy-proxy.git
cd llm-privacy-proxy
bun install
```

### 2. Environment variables

Uses the same vault and HMAC keys as `llm-privacy-middleware` — share them if both are running, or generate fresh ones.

```bash
# Add to ~/.bashrc / ~/.zshrc
export LLM_PRIVACY_HMAC_KEY="$(openssl rand -base64 32)"   # never regenerate after first use
export LLM_PRIVACY_VAULT_KEY="$(openssl rand -base64 32)"
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PRIVACY_HMAC_KEY` | Yes | — | 32-byte base64 HMAC key for deterministic tokenization |
| `LLM_PRIVACY_VAULT_KEY` | Yes | — | 32-byte base64 AES-256-GCM vault key |
| `LLM_PROXY_PORT` | No | `4444` | Port the proxy listens on |
| `LLM_PROXY_TARGET` | No | `https://api.anthropic.com` | Upstream API base URL |
| `LLM_PRIVACY_VAULT_PATH` | No | `~/.llm-privacy/vault.enc.json` | Shared with middleware if desired |
| `LLM_PRIVACY_DISABLE_PATTERNS` | No | — | Comma-separated pattern types to skip |

### 3. Start the proxy

```bash
bun start
# [llm-proxy] listening on http://localhost:4444 → https://api.anthropic.com
```

### 4. Point Claude Code at the proxy

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4444"
  }
}
```

Restart Claude Code. All API calls now flow through the proxy transparently.

### 5. (Optional) Auto-start via SessionStart hook

To start the proxy automatically when Claude Code launches, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "pgrep -f 'llm-privacy-proxy' || bun /path/to/llm-privacy-proxy/src/index.ts &"
      }]
    }]
  }
}
```

## Running Tests

```bash
bun test
```

## What Gets Tokenized

All patterns from `llm-privacy-middleware` apply — API keys are replaced silently, PII is replaced silently. No prompts, no blocks. The user types freely; the LLM sees only tokens.

| Pattern | Severity | Example |
|---|---|---|
| `api_key_anthropic` | silent | `sk-ant-api03-...` → `tok_aBcDeFgHiJkL` |
| `api_key_openai` | silent | `sk-proj-...` → `tok_xYzAbCdEfGh` |
| `api_key_aws_access` | silent | `AKIAIOSFODNN7EXAMPLE` → `tok_...` |
| `pii_email` | silent | `user@example.com` → `tok_...` |
| `pii_phone_us` | silent | `(555) 123-4567` → `tok_...` |
| `pii_ssn_us` | silent | `123-45-6789` → `tok_...` |
| `pii_credit_card` | silent | `4111 1111 1111 1111` → `tok_...` |

## Relationship to llm-privacy-middleware

These two repos are complementary:

| | llm-privacy-middleware | llm-privacy-proxy |
|---|---|---|
| **Mechanism** | Claude Code hooks | HTTP proxy |
| **Prompt tokenization** | ✗ hooks can't rewrite prompts | ✓ transparent |
| **Response detokenization** | ✗ | ✓ transparent |
| **Tool call guard** (Bash/Write/Edit) | ✓ | ✗ |
| **Best used for** | Blocking secrets in file writes and shell commands | Transparent LLM API round-trip |

Run both together for full coverage.
