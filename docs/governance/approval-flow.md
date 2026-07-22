# Approval flow (HITL)

How a T2/T3 (or escalated) action gets a human decision. **Enforced in code**
(`createGovernance` in `src/main/core/governance.ts`, driven by the orchestrator);
advisory here.

## The flow
1. A tool call needs approval (its tier is T2/T3, or a tool/trifecta escalation
   raised one).
2. Precedence for resolving it:
   - **DANGEROUS mode on** → auto-approve, provenance note `auto (dangerous mode)`.
     See [dangerous-mode.md](dangerous-mode.md).
   - a persisted **auto-approve rule** matches → auto-approve, note `auto (rule)`.
   - otherwise → emit `approval.request`; the UI shows the prompt.
3. The agent **waits**. The human approves or denies (optionally "don't ask
   again", which persists a rule).
4. **Fail-safe timeout: 5 minutes** unanswered → treated as **deny**.
5. Approve → the tool runs and is audited. Deny/timeout → the call returns
   `{ error }` (the agent reacts; it does not crash the turn).

## Rules for the agent
- **Never ask for permission in text.** No "posso abrir o navegador?", "may I
  proceed?". Just call the tool — the host renders the prompt itself if needed.
- Opening/navigating the browser is **T0**: no approval, so do it without asking.

## Auto-approve rule scope
A remembered rule keys on `tool:op` when the args carry an `op`
(e.g. `filesystem:delete`), else the bare tool name — so "don't ask again"
scopes to exactly the op the human approved, not the whole tool. Clear all rules
with the UI's reset ("ask again next time").

## Trifecta-lite (egress escalation)
Tracked per session (reset each turn):
- Reading web/email marks `readUntrusted`; reading email/gmail also marks
  `hasPrivate`.
- When an **egress** tool (send/post/upload/publish/deploy/push/type/fill/shell/
  exec) is about to run **and** both `readUntrusted` and `hasPrivate` are set, the
  call is escalated to a **mandatory approval** — "untrusted read + private data +
  egress in one session".
