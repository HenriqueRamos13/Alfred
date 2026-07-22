# filesystem

Read, write, list, create and delete files/directories on the Mac.
Source: `src/main/tools/filesystem.ts`.

## Path resolution
Absolute paths are used as-is. **Relative paths resolve against the Alfred
workspace** (`<ALFRED_WORKSPACE>`, default `~/AlfredWorkspace`). There is no
sandbox — an absolute path can point anywhere the OS user can reach.

## Input
| field | type | required | notes |
|-------|------|----------|-------|
| `op` | `read`\|`write`\|`list`\|`mkdir`\|`delete` | yes | |
| `path` | string | yes | file or directory |
| `content` | string | write | file body (default `""`) |
| `recursive` | boolean | mkdir/delete | mkdir: create parents (default true). delete: remove a directory tree |

## Output (on `ok`)
- `read` → `{ path, content }`
- `list` → `{ path, entries: [{ name, type: 'dir'|'file', size }] }`
- `mkdir` → `{ path }`
- `write` → `{ path, bytes }`
- `delete` → `{ path, deleted: true }`

## Risk & approval
- `read`, `list` → **T0** (free).
- `mkdir`, `write` (new file) → **T1** (free).
- `write` **over an existing file** → pauses for **T2** approval inside the tool.
- `delete` → always pauses for **T2** approval inside the tool.

A denied or timed-out approval returns `{ ok:false, error }` — the file is left
untouched.

## Failure modes
- Missing file/dir on read/list → `{ ok:false, error }` (the raw OS error, e.g.
  `ENOENT`). Never throws.
- `delete` uses `force:false`: deleting a **non-empty directory without
  `recursive:true`** fails with an error rather than removing it.
- `write` auto-creates parent directories (`mkdir -p` on the dirname).

## Examples
```json
{ "op": "read", "path": "notes/todo.md" }
{ "op": "list", "path": "/Users/me/Desktop" }
{ "op": "write", "path": "out/report.txt", "content": "hello" }
{ "op": "delete", "path": "old/", "recursive": true }
```
