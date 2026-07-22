# GRILL-ME (plan-clarity interview)

A user setting (`grill_me_enabled`, **default ON**) that makes Alfred lock the
plan **before** acting on ambiguous or high-stakes requests. Read per turn in
`buildSystem` (`src/main/core/orchestrator.ts`) like DANGEROUS mode, so toggling
it takes effect on the next turn. The default-ON semantics live in the pure
helper `grillMeEnabled` (`src/main/core/settings-pure.ts`): only an explicit
`"0"` disables it.

## Behaviour when ON
On a request that is ambiguous OR high-stakes (T2/T3, money, delete, a vague
project like "build me an app"), Alfred FIRST interviews the user **one question
at a time** (grill-me style — see [skills/grill-me/SKILL.md](../../skills/grill-me/SKILL.md)):
ask, wait, resolve each branch of the decision tree, and only implement once the
plan is clear. Simple/unambiguous requests are acted on directly. When OFF,
nothing is injected — Alfred acts directly (the prior behaviour).

## Not a substitute for governance
GRILL-ME is about **plan clarity**, not permission. DANGEROUS mode, risk tiers,
approvals and the trifecta rule all still apply exactly as before — grill-me
never bypasses or replaces them.

## Toggling
- **UI**: the `GRILL` button in the topbar (green when ON, `.topbar-btn.on`).
  Persisted via `getGrillMe()`/`setGrillMe()` IPC.
- **By voice/chat**: the user can say "ativa/desativa o grill me". Alfred then
  calls the `system` tool (T1) with op `grill_me_on`, `grill_me_off`, or
  `grill_me_toggle`, which persists `grill_me_enabled`. The topbar reflects the
  change on the next idle.
