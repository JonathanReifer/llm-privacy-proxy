# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4] - 2026-07-01

### Fixed

- **Regression: trailing 2-3 chars (up to 15 for a split vault token) clipped from streamed replies.** `aaaa8e3`/`41cfb69`/`d5e972b` (tool_use input detokenization, 2026-06-16) removed `content_block_stop` from `isTerminalLine()` so a pending `ToolUseBuffer` could flush before a block closes. That silently broke tail injection for plain-text replies: the text block's `content_block_stop` was no longer buffered as terminal, so it reached the client immediately, closing the block — while the detokenizer's held-back tail was only injected later, right before `message_delta`/`message_stop`, by which point the SDK had already finalized that content block and dropped the late delta. Symptom matched exactly: intermittent (only when `drain()` had something held back at stream end), last 2-3 characters missing.
  - Fix: tail injection is no longer tied to the generic terminal-event buffer. `processSSELine()` now injects the synthetic `content_block_delta` for the held-back tail at the specific `content_block_stop` whose index matches the block that received `text_delta`s (tracked via a new exported `StreamState`/`newStreamState()`), regardless of how many further blocks (e.g. `tool_use`) follow. `isTerminalLine()` is unchanged — still only `message_delta`/`message_stop` — so `tool_use` blocks interleaved after the text block still stream and detokenize correctly. An end-of-stream fallback (gated on `!tailInjected`) is kept for streams that never emit a matching `content_block_stop`.
  - Exported `processSSELine` and `newStreamState` from `src/proxy/server.ts` so `tests/streaming.test.ts` now drives the real production functions instead of a hand-rolled duplicate of the streaming loop — the duplicate is why the regression shipped without a failing test.

## [0.3.3] - 2026-06-25

### Added

- **`LLM_PRIVACY_BLOCK_ENABLED` env var**: set to `false` (or leave unset) to run in monitor-only mode — patterns are still detected and logged, tokenization still occurs, but the proxy never returns HTTP 400. Set to `true` to re-enable hard blocking. Default is now **disabled** (was previously always enabled with no override). Addresses cases where detection false-positives were causing API errors in active sessions.

### Fixed

- **`proxy.sh is_running` blind spot**: if the proxy was started outside `proxy.sh` (or `/tmp` was cleared), `is_running()` returned false even though the port was bound — causing `start` to attempt a second instance and `status`/`stop` to report the proxy as stopped. Fixed with an `lsof -ti tcp:PORT -sTCP:LISTEN` fallback that adopts the listening process into the PID file. `-sTCP:LISTEN` is required to avoid matching TCP client connections on the same port (e.g. Claude Code's own requests to the proxy).

### Added

- **Streaming integration test suite** (`tests/streaming.test.ts`): 20 tests directly exercising the SSE tail-injection state machine — `isTerminalLine()` unit tests, ordering verification (synthetic delta before `content_block_stop`), full-text reconstruction, fallback path, and edge cases. Export `isTerminalLine` for testability. (105 tests total)

### Notes

- The "last 3 chars" characterisation is accurate for plain text. When a privacy token (`tok_XXXX...`) is split at the very end of a stream, `drain()` can hold back up to 15 chars (the incomplete token suffix). `finalize()` returns all held-back content in both cases; the fix handles them identically.

## [0.3.2] - 2026-05-27

### Fixed

- **Stream tail truncation**: the last ~3 characters of every streamed response were silently discarded. `StreamDetokenizer.drain()` holds back 3 chars per chunk to guard against `tok_` tokens split across SSE chunks. At stream end, `finalize()` returned those chars — but they were written as raw bytes *after* the SSE `message_stop` event, which the Anthropic SDK had already treated as end-of-stream. Fixed by buffering terminal SSE events (`content_block_stop`, `message_delta`, `message_stop`) and injecting the tail as a proper `content_block_delta` SSE event before them. Added `isTerminalLine()` helper and 2 new tests (85 total).

## [0.3.1] - 2026-05-01

### Added

- **Pre-commit secrets scanner** (`bun run check-secrets`): scans staged diff using the proxy's own detection patterns; blocks on `severity: block` matches (API keys, private keys, DB credentials), warns-only on PII; works without `LLM_PRIVACY_HMAC_KEY`
- **`CLAUDE.md`**: project contribution standards — pre-commit checklist (secrets scan, tests, version, changelog, docs, sync, restart, health verify), versioning rules, installed-copy workflow, Bun constraints, and pattern/vault conventions

### Fixed

- **`idleTimeout` Bun 1.x hard limit**: `Bun.serve` rejects `idleTimeout > 255` with `ERR_INVALID_ARG_TYPE`; default revised to `255` (max allowed, ~4.25 min), env override clamped via `Math.min(..., 255)` to prevent crash
- **`setup.sh` JSONC parse crash**: Python's `json.load` rejects `~/.claude/settings.json` trailing commas (JSONC format); fixed with `re.sub(r',(\s*[}\]])', r'\1', raw)` before `json.loads()`
- **Stream error logging**: Bun throws `undefined` (not an `Error`) when the client cancels a mid-stream response; previously logged as `stream error: undefined` noise. Now logs `stream cancelled by client (chunks=N streamDone=F)` for client disconnects and `stream error (chunks=N streamDone=F): <message>` for real errors

## [0.3.0] - 2026-05-01

### Added

- **5 new detection patterns**: `ssh_private_key` (RSA/EC/DSA/OPENSSH/PKCS#8 PEM blocks), `tls_private_key` (encrypted PKCS#8 + PGP private key blocks), `api_key_jwt` (JWT tokens — `eyJ` header prefix), `api_key_npm` (`npm_` access tokens), `db_connection_string` (database URIs with embedded `user:password@host` credentials)
- **26 new tests** covering all new patterns, all fixed patterns, and 13 previously untested existing patterns (total: 83 tests, up from 57)

### Fixed

- **`api_key_openai`**: regex now matches `sk-proj-` and `sk-svcacct-` formats (new OpenAI project and service account key prefixes) in addition to the classic `sk-` format
- **`api_key_github`**: regex now matches all GitHub token types — `ghp_` (classic PAT), `gho_` (OAuth), `ghs_` (server-to-server), `ghu_` (user-to-server), and `github_pat_` (fine-grained PAT) — previously only `ghp_` was covered

### Changed

- Test count updated in CLAUDE.md to reflect 83 tests

## [0.2.0] - 2026-05-01

### Added

- **9 new detection patterns**: `api_key_google`, `api_key_slack`, `api_key_stripe`, `api_key_twilio`, `api_key_sendgrid`, `api_key_aws_secret`, `pii_ipv4`, `pii_passport_us`, `pii_dob`
- **Vault reference tracking**: each vault entry now records `refCount` (number of times detokenized) and `lastAccessedAt` timestamp
- **`/vault/hot` endpoint**: returns top N entries ordered by access frequency (`refCount` DESC)
- **Prompt logging**: `LLM_PRIVACY_LOG_PROMPTS=none|tokenized|full` logs request content to a JSONL file for auditing; `LLM_PRIVACY_LOG_PATH` overrides the default path
- **Stats persistence**: proxy request counters (`requests`, `tokenized`, `detokenized`) persist across restarts via a `proxy_stats` table in the vault SQLite database
- **SIGTERM handler**: on graceful shutdown, stats are flushed to disk and a WAL checkpoint is run before exit
- **`proxy.sh`**: daemon control script with `start`, `stop`, `restart`, and `status` subcommands; status output includes version, vault mode, and traffic counters
- **`bun run review` CLI**: offline vault inspection with `list`, `search`, `stats`, and `export` (JSON + CSV) subcommands
- **Version field in `/health`**: response now includes `"version"` sourced from `package.json`
- **`SqliteVault`**: replaced file-based vault with WAL-mode SQLite for concurrent multi-session safety; each entry encrypted individually with AES-256-GCM
- **AES key caching**: vault encryption key imported once and reused across encrypt/decrypt calls

### Fixed

- **Vault migration crash** (`SQLiteError: no such column: ref_count`): `ALTER TABLE` statements to add `ref_count` and `last_accessed_at` columns now run before the index creation that depends on them, fixing startup failure on pre-existing databases

### Changed

- `startProxy()` is now `async` — awaits `vault.ready` before serving requests
- `tokenizeMessages()` returns `{ messages, matchCount }` instead of `Message[]`
- Vault `put()` uses `ON CONFLICT(token) DO UPDATE SET ref_count = ref_count + 1` — never overwrites `original_enc` on collision
- Stats save uses a single SQLite transaction for atomicity
- `structuredClone()` used for full-mode prompt logging deep copy (replaces JSON parse/stringify)

## [0.1.0] - 2026-04-29

### Added

- Initial implementation: transparent HTTP proxy for `api.anthropic.com` using Bun
- Bidirectional tokenization: HMAC-SHA256 deterministic tokens (`tok_` prefix, 12 base64url chars) replace secrets/PII in outbound requests; tokens in responses are replaced back with originals
- 10 built-in detection patterns: `api_key_openai`, `api_key_anthropic`, `api_key_xai`, `api_key_aws_access`, `api_key_github`, `api_key_generic`, `pii_email`, `pii_phone_us`, `pii_ssn_us`, `pii_credit_card`
- `LLM_PRIVACY_DISABLE_PATTERNS` env var to skip specific pattern types at runtime
- Streaming response support: `StreamDetokenizer` with sliding-buffer correctly handles tokens split across SSE `text_delta` chunks
- `/health` endpoint returning status, vault mode/path, and traffic counters
- `/vault` endpoint: list recent tokenized entries (with `?limit=N`)
- `/vault/stats` endpoint: token counts grouped by pattern type
- `/vault/search` endpoint: search by token prefix or original value fragment
- Encrypted vault (`~/.llm-privacy/vault.db`) — in-memory fallback when `LLM_PRIVACY_VAULT_KEY` is absent
- `setup.sh`: generates HMAC + vault keys, appends to `~/.bashrc`, configures `~/.claude/settings.json`
- Upstream error recovery: 502 response on fetch failure, passthrough on non-200 upstream responses
- BSD 2-Clause license

[Unreleased]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JonathanReifer/llm-privacy-proxy/releases/tag/v0.1.0
