# Alfred

A personal, open-source **Agent OS** for your Mac. Alfred is an Electron app
that runs natively on **Intel Macs** (Mac Pro 2019, MacBook Pro 2018–2020 — not
Apple Silicon) and gives Claude a control-centre UI plus the tools to actually
drive the machine: filesystem, shell, a real browser, and read-only Gmail.

> Not "Jarvis". Alfred.

## What it does (MVP)

- **Manual tool-use orchestrator** on top of the Anthropic TS SDK, streaming to
  a neon control UI. Default model `claude-sonnet-5` (`ALFRED_MODEL`).
- **Generative UI** — Claude renders panels, tables, stat tiles, logs, etc. into
  a live "surface" through a whitelisted component registry (never arbitrary JSX).
- **Governance** — every action is risk-tiered (T0–T3). Destructive / sending /
  installing actions pause for **human approval** in the UI. A trifecta rule
  blocks data egress when untrusted + private + outbound all meet in a session.
- **Budget & kill-switch** — per-day/per-session token caps, per-task step cap,
  and loop detection. Exceed → hard stop.
- **Projects (ICM)** — "build me a todo app" creates a folder under the
  workspace with a canonical `.alfred/PROJECT.md` manifest, indexed in SQLite.
- **Memory (ICM)** — stable, human-curated `preferences.md` / `house-rules.md`
  plus per-session working notes.
- **Secrets** — stored in the macOS Keychain via the `security` CLI, never on disk.

## Architecture

Electron, three processes:

| Process   | Responsibility |
|-----------|----------------|
| **main** (Node) | orchestrator, tools, governance, SQLite, IPC |
| **preload**     | `contextBridge` safe API (`contextIsolation` on, `nodeIntegration` off) |
| **renderer** (React) | control window + generative UI surface |

Everything the AI can render maps through a whitelist:
`Panel, StatTile, Card, DataTable, Markdown, LogFeed, AgentStatus, ProjectList`.
App-driven UI (`CommandBar, ChatLog, ApprovalPrompt`) is not AI-renderable.

Data lives in `data/` (SQLite `alfred.db`, browser profile) — git-ignored.

## Setup (from a factory Intel Mac)

```bash
git clone <your-fork-url> alfred && cd alfred
./setup.sh          # installs Xcode CLT, Homebrew, Node 22, deps, native rebuild
cp .env.example .env  # then fill in your keys (setup.sh does this for you)
npm run dev
```

Then grant the app the macOS permissions it needs to control the Mac:
**System Settings → Privacy & Security → Accessibility** and **Screen Recording**
→ enable your terminal (and later the packaged Alfred app).

Requirements: macOS on Intel (x86_64), Node 22 LTS.

## Connecting Gmail (read-only)

Alfred reads mail with the `gmail.readonly` scope only. You supply your own
OAuth client:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create
   (or pick) a project.
2. **APIs & Services → Enable APIs** → enable the **Gmail API**.
3. **OAuth consent screen** → External → add yourself as a test user.
4. **Credentials → Create credentials → OAuth client ID** → *Desktop app*.
5. Copy the client ID and secret into `.env`
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`).
6. In Alfred, ask it to *connect Gmail*; it runs the OAuth flow and stores the
   token in your Keychain. The token never touches disk.

## Development

```bash
npm run dev        # electron-vite dev
npm run build      # electron-vite build
npm run rebuild    # rebuild native modules for Electron
npm test           # pure-logic tests (node --test, no native deps)
npm run typecheck  # tsc --noEmit
```

## License

MIT © 2026 Henrique Ramos
