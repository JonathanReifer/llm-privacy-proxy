# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/JonathanReifer/llm-privacy-proxy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JonathanReifer/llm-privacy-proxy/releases/tag/v0.1.0
