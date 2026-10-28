# shared-memory

Workspace memory that ZCode and OpenCode read automatically: `docs/agents/handoff.md`
(authoritative current state) plus `docs/agents/decisions.md` (append-only log), injected
into the model context by both harnesses. Full handoff once, compact state after that.

## Pain point

Agent sessions start cold. Project state built up over days — call chain, deploy commands,
traps — gets re-derived every session, or half-remembered wrong.

Each harness sees a different slice. ZCode (3.16.3, at time of writing) only auto-reads the
workspace-root `AGENTS.md`; OpenCode reads `docs/agents` only when the model decides to look.
Two partial views, and the state drifts.

The blunt fix — paste the whole handoff into every request — costs ~1.7k tokens per model
call. A tool-heavy session makes 150+ calls: roughly 250k tokens of repeated text.

## How it works

Canonical memory lives in each workspace, and readers walk up from the session cwd (max 8
levels), so any repo nested under the workspace root finds the same files.

| Harness | Trigger | What is injected |
|---|---|---|
| ZCode | `SessionStart` (`startup\|clear\|compact`) | full |
| ZCode | `UserPromptSubmit`, digest changed | full |
| ZCode | `UserPromptSubmit`, unchanged | nothing |
| OpenCode | first model request of a session | full |
| OpenCode | later requests | state |
| OpenCode | memory files changed | full |

Two render modes (`lib/memory.mjs`), measured on an example workspace:

| Mode | Content | Size |
|---|---|---|
| `full` | whole handoff + last 12 decisions | ~6.9 KB ≈ 1.7k tok |
| `state` | `# Handoff` header + `## State` + `## In flight` | ~2.4 KB ≈ 600 tok |

`state` falls back to the full handoff when those sections are missing.

```
docs/agents/handoff.md ─┐
docs/agents/decisions.md┴─> lib/memory.mjs ─┬─> ZCode hooks    (session start + digest delta)
                                            └─> OpenCode plugin (full once, then state)
```

Under the hood:

- Read-only. No network, no writes to the workspace.
- File reads cached by mtime + size; handoff capped at 64 KB, decisions at 12 rows / 8 KB.
- Digest = sha256(handoff + decisions). Same digest means no re-injection (ZCode) or
  state-only injection (OpenCode).
- OpenCode keeps the "full already delivered" flag on disk, per session, in
  `~/.cache/zcode/shared-memory`. OpenCode reloads plugins between requests and runs more
  than one instance, so an in-memory flag would re-send the full handoff every call. With no
  session id it degrades to full injection — correct, just expensive.
- State files older than 7 days are pruned by the ZCode hook.
- Overrides: `SHARED_MEMORY_ROOT` (force the workspace root), `ZCODE_SHARED_MEMORY_STATE`
  (state directory; `SHARED_MEMORY_STATE` is honored by the OpenCode plugin as well).

## How to use

### 1. Install

Requires Node 18+ (hooks use top-level `await`).

```sh
git clone https://github.com/eddy-lau/agent-shared-memory.git ~/Projects/Personal/agent-shared-memory
ln -s ~/Projects/Personal/agent-shared-memory ~/.config/opencode/plugins/shared-memory
```

The symlink keeps hook paths and the OpenCode `plugins` entry stable. If the clone lives
elsewhere, repoint the symlink or use the clone path in both configs. A dangling symlink is
a silent no-op.

### 2. Create the memory files

`<workspace>/docs/agents/handoff.md`:

```markdown
# Handoff
> Last updated: 2026-10-28   By: opencode

## State
What is true now: repos, call chain, deploy commands, URLs.

## In flight
Work started but not finished. (none)

## Notes
Gotchas, traps, operational rules.
```

`<workspace>/docs/agents/decisions.md`:

```markdown
# Decision log (append-only)

| Date | Tool | Decision | Why |
|---|---|---|---|
| 2026-10-28 | opencode | Chose X over Y | Reason it matters later |
```

Parser constraints — break these and you lose the cheap mode or the decisions:

- `## State` and `## In flight` must keep those names (case-insensitive). Renamed sections
  fall back to full handoff.
- `> Last updated:` must have the date as the first token.
- The decisions table needs a header row starting with `| Date`.
- No memory files → silent no-op. Nothing is created for you.

### 3. Wire ZCode

Two ways; both are safe together (per-session state prevents duplicate injection).

- Plugin: Settings → Plugins → Create → Add marketplace → select this folder → install
  `shared-memory` → enable.
- User hooks in `~/.zcode/cli/config.json`:

```json
"hooks": {
  "enabled": true,
  "events": {
    "SessionStart": [{ "matcher": "startup|clear|compact", "hooks": [{ "type": "process", "command": "node", "args": ["<this-dir>/zcode/hooks/session-start.mjs"], "timeoutMs": 5000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "process", "command": "node", "args": ["<this-dir>/zcode/hooks/handoff-changed.mjs"], "timeoutMs": 5000 }] }]
  }
}
```

Hooks are snapshotted when a session starts — open a new ZCode session after wiring.

### 4. Wire OpenCode

Add the directory to `plugins` in `~/.config/opencode/opencode.json`:

```json
"plugins": ["./plugins/shared-memory/opencode"]
```

### 5. Verify

ZCode hook, outside the app:

```sh
echo '{"hook_event_name":"SessionStart","source":"startup","cwd":"/path/to/workspace"}' \
  | node ~/.config/opencode/plugins/shared-memory/zcode/hooks/session-start.mjs
```

Expect JSON with `hookSpecificOutput.additionalContext`. Empty output means no memory files
found from that cwd.

OpenCode, live:

```sh
cd /path/to/workspace && opencode run "From the shared memory in your system prompt: what is the current state?"
```

First request should carry `## Notes`; the next request should not.

Deterministic check — the model cannot be trusted to introspect its own system prompt, so use the debug toggle:

```sh
touch ~/.cache/zcode/shared-memory/debug
opencode --standalone run "Use the bash tool once: echo hi. Then answer: done"
cat ~/.cache/zcode/shared-memory/opencode-debug.log   # expect mode=full, then mode=state
rm ~/.cache/zcode/shared-memory/debug
```

`--standalone` loads the plugin from disk in a fresh process. The background service
caches plugin code, so a code change may need a service restart before it takes effect.

### 6. Session loop

At the end of a session: rewrite `## State`, update `## In flight`, append durable traps to
`## Notes`, and add a decisions row. Never rewrite old decision rows.

The file is sent to each harness's model provider — keep secrets and credentials out of it.

### Troubleshooting

- **Nothing injected** — no `docs/agents/handoff.md` at or above the cwd (max 8 levels).
- **ZCode ignores the hook** — new session required; check `~/.zcode/cli/log/zcode-<date>.jsonl`.
- **OpenCode ignores the plugin** — check `~/.local/share/opencode/log/opencode.log` for
  `failed to load plugin`; verify the symlink resolves.
- **Always full, never state** — delete `~/.cache/zcode/shared-memory/*.opencode.json` to
  reset, then confirm the first request is full and the second is state.
- **Debug the plugin** — `touch ~/.cache/zcode/shared-memory/debug` before a run; each
  injection appends a line (`mode=full|state`, bytes) to
  `~/.cache/zcode/shared-memory/opencode-debug.log`.
- **Drive with the clone unmounted** — symlink dangles, injection silently stops.

## Companion skill

`skills/agent-sync/SKILL.md` automates what the plugin assumes but never creates: project
`AGENTS.md` with a memory pointer, `docs/agents` templates, the global rules symlink
(`~/.zcode/AGENTS.md`), skill symlinks, shadow checks, and MCP parity between ZCode and OpenCode.

```sh
ln -s <repo>/skills/agent-sync ~/.config/opencode/skills/agent-sync
```

Loads on demand; costs nothing when idle. The plugin injects memory, the skill sets up and
audits the files it injects.

## License

MIT
