# gworkspace-helper

![tests](https://github.com/andy-bttryzn/gworkspace-helper/actions/workflows/test.yml/badge.svg)

A single-user Google Workspace CLI helper for Gmail / Drive / Calendar / Sheets / Docs.

Built for one human running ops out of their own inbox: opinionated draft validation, prior-outbound deduping, label-sync, post-send archive, all driven from the terminal. Not a service-account or multi-tenant setup.

## Why this exists

Most off-the-shelf Gmail tooling assumes you're either (a) a developer building an app or (b) a team using a shared inbox tool. This is for the third case: one person, one inbox, lots of email, who wants:

- A CLI you can call from any script or shell
- Reply / new-draft / send / thread-label-sync as one-liners
- Guardrails that catch the dumb mistakes you actually make (em-dashes, missing closings, redundant sends, wrong-domain BCC)
- Audit trail for every state-changing action

Everything opinionated is env-var gated so the helper works for anyone, not just the original author.

## Install

```bash
npm install googleapis google-auth-library
```

Then drop `index.js` somewhere on your PATH or `node index.js <cmd>` directly.

## OAuth bootstrap

1. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (Desktop type).
2. Download the credentials JSON, save as `credentials.json` next to `index.js`.
3. Run `node index.js whoami`. A browser tab will open. Sign in, grant scopes.
4. Token is cached as `token.json` (gitignored).

Scopes requested cover Gmail (read/modify/send), Drive (file metadata + read), Calendar (read), Sheets, Docs.

## Commands

```
node index.js whoami
node index.js gmail-search "QUERY" [N]
node index.js gmail-oldest "QUERY"
node index.js gmail-get <messageId>
node index.js gmail-signature
node index.js gmail-reply-draft <threadId> <bodyFile> [flags]
node index.js gmail-new-draft <toAddr> <subject> <bodyFile> [flags]
node index.js gmail-send-draft <draftId>
node index.js gmail-thread-label-sync <threadId>
node index.js drive-list [N]
```

Each command prints JSON to stdout on success, throws with a readable error otherwise.

## Optional opinionation (env vars)

These are all off by default. Set them to turn on the guardrails the original author runs:

| Env var | Purpose | Example |
|---|---|---|
| `GW_EMDASH_CHECK` | Block drafts containing `—` | `1` |
| `GW_CLOSING_GREETING` | Required greeting before name | `Thanks,` |
| `GW_CLOSING_NAME` | Required name after greeting | `Alex` |
| `GW_FORBIDDEN_CLOSINGS` | Comma list of greetings to reject | `best,regards,sincerely,cheers` |
| `GW_LEGAL_BCC` | BCC required when legal keywords detected | `counsel@yourco.com,paralegal@yourco.com` |
| `GW_DEFAULT_BCC` | Default BCC for legal-gate suggestions | `archive@yourco.com` |
| `GW_INTERNAL_DOMAINS` | Domains treated as internal (skip prior-outbound check) | `yourco.com,sister-co.com` |
| `GW_OWNERSHIP_CHECK` | Block draft if a coworker owns the thread | `1` |
| `GW_PROCESSED_LABEL` | Gmail label for processed threads | `processed` |
| `GW_PROCESSED_LOG` | Audit log file path | `/var/log/gw_processed.jsonl` |

Every guardrail also has a `--skip-<check>` flag for per-call override.

## Tests

```bash
npm test
# or
node --test tests/
```

6 tests on the pure-function exports (`encodeHeaderRfc2047`, `SCOPES`). The HTTP-touching commands (`buildService`, `getAuthClient`, `markProcessedWithLog`, etc.) need OAuth + Gmail state and aren't covered here; wrap them in an integration test against a sandbox account if you need that coverage.

`googleapis` is lazy-loaded, so the pure tests run without `npm install`. That keeps unit-test feedback loops fast.

## What's NOT here

- No multi-account / service-account / domain-wide delegation
- No web UI; CLI only
- No background daemon (run it from cron, your shell, an editor task)
- No retries on quota errors (fail loudly, let the caller decide)

## License

MIT. See `LICENSE`.

---

Part of [andy-bttryzn's portfolio](https://github.com/andy-bttryzn). See [aiden-overview](https://github.com/andy-bttryzn/aiden-overview) for the architectural cross-section this was extracted from.
