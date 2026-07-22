---
name: create-project
description: >-
  Scaffold a new ICM folder-as-context project under the Alfred workspace. Use
  when the user asks to start/build/create a new app, project, script, or
  codebase ("build me a todo app", "começa um projeto X"), before writing any
  code. Sets up the canonical .alfred/PROJECT.md manifest and indexes it.
---

# Create a project

Alfred organises substantial work as **projects** (ICM = folder-as-context): a
folder under the workspace whose `.alfred/PROJECT.md` manifest is the single
source of truth, indexed in SQLite. Do this FIRST, before generating code, so
context and status are persistent and re-loadable.

## Steps
1. **Confirm scope quickly** — infer name, stack, and a one-line summary from the
   request; don't interrogate the user. Pick a clear human name.
2. **Create it** — call the `project` tool:
   ```json
   { "op": "create", "name": "Todo App", "stack": "Next.js", "summary": "Personal task tracker" }
   ```
   This scaffolds the folder + `.alfred/PROJECT.md` and indexes it. It is **T1**
   (reversible workspace write) — no approval.
3. **Build inside the project folder** — use `filesystem`/`shell` with paths
   relative to the workspace (they resolve there). Keep the manifest's key files
   and decisions current as you go.
4. **Show status** — render a live view with `render_ui` (e.g. a `Panel` with a
   `ProjectList` or `DataTable`) so the user sees progress on the surface.
5. **Delegate chunky work if useful** — a large multi-file scaffold can go to
   `delegate_to_claude_code` (T2, needs approval; cwd stays in the workspace).
6. **Capture on completion** — `memory` op:`note` (a `project`-type note with the
   decisions) then op:`handoff`.

## Re-entry
To resume later: `project` op:`get` with the slug loads the manifest + file tree.
The orchestrator also auto-injects a project's context when the user's message
names it.

## Notes
- The manifest is canonical; the SQLite row is just an index.
- Never scaffold outside the workspace.
