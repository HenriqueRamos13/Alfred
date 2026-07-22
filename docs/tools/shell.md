# shell

Run a shell command on the Mac via `/bin/sh -c`, with a timeout and captured
output. Source: `src/main/tools/shell.ts`.

## Input
| field | type | required | notes |
|-------|------|----------|-------|
| `command` | string | yes | command line for `/bin/sh -c` |
| `cwd` | string | no | working dir; absolute as-is, relative resolves against the workspace. Default: workspace |
| `timeoutMs` | number | no | kill after N ms. Default **60000**; non-positive → default |

## Output
`{ stdout, stderr, code }`. `ok` is `true` only when the exit `code` is 0;
otherwise `error` is `Exit code N`. On timeout: `{ ok:false, error:"Timed out
after <ms>ms", result }` and the process is `SIGKILL`ed.

Hard limits: `maxBuffer` is **8 MiB** per stream (stdout/stderr) — output beyond
that truncates/errors. Kill signal on timeout is `SIGKILL`.

## Risk & approval
- Ordinary commands → **T1** (free).
- **Destructive** commands → **T2**, pauses for approval inside the tool.

The destructive heuristic (regex, errs toward asking) matches, among others:
`rm`, `mkfs`, `dd`, `shutdown`, `reboot`, `killall`, `kill -9`, redirection to
`/dev/`, `sudo`, `chmod -R`, `chown -R`, `git reset --hard`, `git clean -f`,
`git push --force`, fork bombs, `npm publish`, `mv … /`. It is a heuristic, not
a parser: expect occasional false positives (harmless — you just get an approval
prompt) and do not assume it catches every dangerous form.

## Failure modes
- Non-zero exit → `ok:false` but `result` still carries stdout/stderr/code so you
  can react.
- Denied/timed-out approval on a destructive command → `{ ok:false, error }`,
  command never runs.

## Examples
```json
{ "command": "git status --porcelain" }
{ "command": "npm test", "cwd": "myproj", "timeoutMs": 300000 }
```
