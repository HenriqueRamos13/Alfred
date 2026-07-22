---
name: deploy-runbook
description: >-
  Safe, ordered procedure for building, verifying, and releasing an Alfred
  project. Use when the user asks to deploy, release, ship, publish, or cut a
  build. Emphasises verify-before-release and the human approval gates on
  destructive/publishing steps.
---

# Deploy runbook

A multi-step release should be **verified before it ships** and must route its
destructive/publishing steps through the approval gates. Publishing, force-push,
and installs are **T2** — expect the host to prompt; never ask in text, just call
the tool.

## Preconditions
1. Clean tree — `shell`: `git status --porcelain` (empty = clean).
2. Right remote — `shell`: `git remote -v`. If a repo has several remotes,
   confirm which one is intended before any push.
3. On a branch, not a detached HEAD or an unintended default branch.

## Verify (do not skip — green tsc is NOT green tests)
4. Type-check — `shell`: the project's check (e.g. `npx tsc --noEmit`). Exit 0.
5. Tests — `shell`: the project's test command. Must pass.
6. Build — `shell`: the project's build (e.g. `npm run build` /
   `electron-builder`). Use a generous `timeoutMs`.

## Release (approval gates live here)
7. Tag/version bump via the **project's established script** — never hand-edit
   release metadata.
8. Push — `shell`: `git push <remote> <branch> --tags`. A normal push is T1; a
   **force** push is T2 (approval).
9. Publish — the project's publish step (e.g. `npm publish`, an upload) is **T2**
   (approval). Wait for the human.

## After
10. Verify the released artifact (version, checksum, a smoke check).
11. `memory` op:`note` (type `decision`: what shipped, version, gotchas) then
    op:`handoff`.

## Rules
- Never invent a deploy step the project doesn't have — read its scripts
  (`package.json`, `deploy.sh`, `start.sh`) first and follow them.
- If a verify step fails, **stop and report**; do not push a red build.
- Migrations run via the project's established migration script, never manual SQL.
