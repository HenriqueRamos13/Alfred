# Security model — what the rails are, and what they are NOT

This is the honest framing. Read it before trusting Alfred with anything that
matters (a card, a password, a production credential).

## The load-bearing claim

**Alfred's risk-tier approvals are in-process HEURISTICS, not a security boundary
against an adversarial model.**

`classifyAction`, the trifecta-lite escalation, the job grants, the sensitive-
action classifier — all of it runs *inside the same process as the agent loop*,
on inputs the model can influence. They exist to catch **cooperative mistakes**:
a well-intentioned model about to do something destructive or exfiltrating pauses
for a human. That is genuinely valuable and it is what these rails are for.

They are **not** a sandbox. A model that is actively trying to get around them —
prompt-injected, jailbroken, or misaligned — is not reliably stopped by code that
classifies *its own* tool names and arguments. Heuristics can be worded around,
tool names are attacker-chosen when tools come from MCP, and anything in-process
can in principle be reached by anything else in-process.

**Real trust rests on OS isolation, not on these heuristics.** If you would be
harmed by the worst thing the model could do with a capability, the mitigation is
to not grant that capability to the process, or to run the process where the OS
denies it — a separate user/VM/container, macOS TCC prompts, Keychain ACLs,
least-privilege credentials. The tiers are the seatbelt; the OS is the crumple
zone. Do not confuse the two.

## What Stage 3 (Phase 6) added, and where the boundary really is

### Secret vault — pull at use-time, never store plaintext

- **`SecretSource`** (`core/secret-source.ts` + `-pure.ts`) resolves a named
  service credential when it is needed, from the backend chosen by
  `ALFRED_SECRET_SOURCE`:
  - `keychain` (default) — the macOS Keychain via `security`; unchanged from before.
  - `command` — a user-configured wrapper argv (`ALFRED_SECRET_COMMAND`) that
    prints the secret to stdout (wrap any vault). The secret **name** is passed as
    a discrete argv element, never concatenated into a shell string — no
    shell-injection surface.
  - `op` — 1Password CLI (`op read <name>`).
  - `bw` — Bitwarden CLI (`bw get password <name>`).
- `ctx.getSecret(name)` is the read port; `ctx.secrets` remains Alfred's own
  *store* (the Gmail OAuth token it creates). Keychain stays the default so
  existing secret-backed features are untouched.
- **Governance:** reading a credential classifies **T3**. The value is **never
  logged** and **never returned to the model in clear** — on a backend failure the
  error carries only the backend + name + exit code, not the CLI's stdout (which
  could hold the secret). `maskSecrets` redacts secret-looking argument keys from
  the audit trail and UI stream.
- **Where the real boundary is:** the OS keychain/vault ACL. The heuristic marks
  the read T3 and masks the value from logs; it does not stop a determined
  in-process reader. Scope the vault entries and Keychain ACL accordingly.

### Full SSRF guard — connect-time, DNS-rebinding aware

- **`classifyUrl` / `ipIsBlocked`** (`core/url-safety-pure.ts`) — http(s) only;
  block loopback, RFC1918 private, link-local, unspecified, CGNAT, and every IPv6
  equivalent (`::1`, `::`, `fe80::/10`, `fc00::/7`, `::ffff:` mapped), and
  **always** the cloud-metadata endpoints (`169.254.169.254`, `fd00:ec2::254`,
  `metadata.google.internal`) — even if private ranges were ever allowed.
- **`safeFetch` / `assertUrlSafe`** (`core/url-safety.ts`) — enforcement at
  **connect time**: a custom DNS `lookup` resolves the host and rejects the
  request if *any* resolved IP is blocked, closing the DNS-rebinding hole a static
  URL check leaves open. The original hostname stays in the `Host` header and TLS
  SNI. Redirects are followed manually and **every hop is re-classified and
  re-connect-checked**.
- **Applied to:** the fetch-job runner (`core/jobs.ts`, extending the Phase-4
  static floor which now delegates to the same classifier), and the Playwright
  browser's `goto` (`tools/browser.ts`, pre-flight `assertUrlSafe`). The MCP
  bridge binds to `127.0.0.1` and makes no outbound HTTP, so it has no SSRF
  surface to guard.
- **Residual gap (browser):** `assertUrlSafe` resolves and IP-checks before
  `page.goto`, but Playwright opens its own socket afterwards — it cannot pin the
  validated IP the way `safeFetch`'s custom `lookup` does, so a sub-second DNS
  rebind between the pre-flight check and Chromium's own resolution is not fully
  closed for the browser path. `safeFetch` (the fetch-job runner) has no such window.
- **Where the real boundary is:** this is a strong, real mitigation for
  server-side request forgery from within the process — but a raw socket the model
  could open by other means (a shell tool running `curl`) is governed separately
  (shell approval + env-scoping), not by this guard.

### Credential env-scoping — for every spawn

- **`scrubbedEnv`** (`core/env-scoping-pure.ts`) strips credential-shaped keys
  (`ANTHROPIC_*`, `OPENAI_*`, `DEEPSEEK_*`, `ELEVENLABS_*`, `GOOGLE_OAUTH_*`,
  `AWS_*`, any `*_API_KEY` / `*_TOKEN` / `*SECRET*`) from the environment handed to
  a subprocess, with an explicit allowlist for keys a command legitimately needs.
- **Applied to:** the shell tool (`tools/shell.ts`; allowlist via
  `ALFRED_SHELL_ENV_ALLOWLIST`) and the `claude -p` child (`core/claudeSpawn.ts`),
  which now runs through the same `scrubbedEnv` — every credential is stripped and
  only `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` are allowlisted (dropping the
  ANTHROPIC_* API-key vars still forces subscription auth, so connectors stay on).
  The MCP bridge token travels via `--mcp-config`, not env, so scrubbing is safe.
  There are no stdio MCP subprocesses (the bridge is in-process HTTP).
- **Where the real boundary is:** this stops the obvious `echo $ANTHROPIC_API_KEY`
  exfil from a model-run shell command. It is not a substitute for running the
  subprocess without access to those secrets in the first place.

## Bottom line

Use the tiers and these guards as they are meant: a strong safety net for a
cooperative agent. For the credit-card / passwords goal, put the real trust in OS
isolation and least-privilege credentials — and treat every in-process heuristic
as defence in depth, never as the wall.
