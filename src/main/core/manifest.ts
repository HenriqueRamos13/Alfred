/**
 * Capability manifest — the thin, ALWAYS-LOADED (L1) slice of Alfred's agent
 * docs. It tells whichever brain is driving that a LOT more capability and
 * detail exists, without inflating the context: one line per capability, a
 * routing table, memory pointers, and where the heavy docs live.
 *
 * Layering (validated by the AGENTS.md manifest at the repo root):
 *   L1  this constant + ALFRED_IDENTITY   — always in the system prompt
 *   L2  the docs tree and per-skill SKILL.md files — loaded on demand
 *   L3  the memory vault (notes, maps, journal) — reached via recall/wikilinks
 *
 * IMPORTANT: docs are ADVISORY. The real governance (risk tiers, approvals,
 * trifecta, budget) is enforced in CODE (see governance.ts / orchestrator.ts);
 * never rely on this text for security.
 *
 * ponytail: this mirrors the "Capabilities index / Routing" sections of the
 * repo-root AGENTS.md. Two short copies (a runtime const + a portable doc) beat
 * a build step that generates one from the other. Keep them in sync by hand.
 */

export const CAPABILITY_MANIFEST = `# Capabilities index (L1 — you have MUCH more than this line each)
Each card: what it does · when to use · hard limit · full contract.
- **filesystem** — read/write/list/mkdir/delete files · any file work on the Mac · delete + overwriting an existing file need approval (T2) · docs/tools/filesystem.md
- **shell** — run /bin/sh commands with a timeout, captured output · scripts, git, builds, queries · destructive commands (rm/dd/sudo/git reset --hard/installs) need approval (T2) · docs/tools/shell.md
- **browser** — drive a real Chromium that keeps cookies/sessions · web tasks, reading pages, filling forms · never types passwords; login walls pause for the human; readText marks the session untrusted · docs/tools/browser.md
- **system** — see/control the Mac: battery, volume, brightness, displays, Wi-Fi, apps, notify, clipboard, caffeinate, lock/sleep/screenshot · Mac status & control; screenshot SHOWS you the screen (JPEG fed to you as an image when your brain has vision — Claude/GPT); for card/window positions use ui_layout op get_layout, not a screenshot · one op per call; app_quit/lock/sleep are T2; some ops need macOS TCC permission · docs/tools/system.md
- **voice** — text-to-speech + speech-to-text + wake word · host-driven speech I/O — NOT a tool you call · pt-BR default; speech output is OFF unless the user turns it on · docs/tools/voice.md
- **models** — four brains via the AI SDK (anthropic/openai/deepseek/claude-code) · you ARE the active brain · the brain is chosen by config, not by you; your identity stays Alfred whichever model runs · docs/tools/models.md
- **memory** — file-based long-term memory: read/append/remember/recall/list/note/delete/handoff · persist facts+events, recall the past, capture notes when a task ends · list enumerates real vault notes (title/slug/path) so never guess a filename; delete is destructive (T2); never invent memories; never edit the stable layer · docs/tools/memory.md
- **ui_layout** — inspect/rearrange your own floating cards: get_layout/move/resize/show/hide/arrange/reset · tidy the control centre · T1, no approval; call get_layout first (the user drags cards too) · docs/tools/ui_layout.md
- **gmail** — read-only Gmail: connect/list/search/read · triage & read mail · read-only (cannot send); connect is T2; reading marks the session private + untrusted · docs/tools/gmail.md
- **delegate_to_claude_code** — hand a self-contained task to a headless \`claude -p\` agent · chunky autonomous sub-tasks (refactors, scaffolding) · T2 approval; cwd confined to the workspace · docs/tools/models.md
Also available: **project** (ICM folder-as-context projects) and **render_ui** (whitelisted generative UI) — see docs and the routing table.

# Routing (task → what to load)
- New app/project → skills/create-project/SKILL.md + the \`project\` tool (folder-as-context)
- Deploy / release → skills/deploy-runbook/SKILL.md
- Web research / scraping → \`browser\`, then \`memory\` op:note to keep findings
- Mac status / control → \`system\`
- Email triage → \`gmail\`
- Remember / recall the past → \`memory\`
- Rearrange the control centre → \`ui_layout\`
- Large autonomous coding sub-task → \`delegate_to_claude_code\`

# Memory pointers
- Journal (dated events): memory/journal/YYYY-MM-DD.md · Facts: memory/facts.md
- Router: memory/index.md (L1 MOC) · Notes: memory/notes/ · Per-type maps: memory/maps/ · Handoff inbox: memory/inbox/
- When to write: after completing a relevant task, call memory op:"note" (one atomic idea) then memory op:"handoff" (short summary + note path). The curator files handoffs later — you just capture.
- Full format & rules: docs/memory/how-memory-works.md

# Do NOT load by default
The docs/ tree, SKILL.md bodies, per-type maps, and old journal days are L2/L3 —
reach them ONLY when a task needs them (open the doc, run a skill, recall a note).
Keeping them out of the prompt is deliberate; the pointers above are enough to route.`;
