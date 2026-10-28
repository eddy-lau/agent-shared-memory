# shared-memory

Shared workspace memory for ZCode + OpenCode.

Canonical memory lives in each workspace:

```
<workspace>/docs/agents/handoff.md     current state (authoritative)
<workspace>/docs/agents/decisions.md   append-only decision log
```

Readers walk up from the session cwd, so any repo nested under the workspace root
finds the same files. No memory files → silent no-op.

Two render modes (`lib/memory.mjs`):

| Mode | Content | Size (current workspace) |
|---|---|---|
| `full` | whole handoff + last 12 decisions | ~6.9 KB ≈ 1.7k tok |
| `state` | `# Handoff` header + `## State` + `## In flight` | ~2.4 KB ≈ 600 tok |

Sizes track the handoff length; the gap between modes is the point. `state` falls
back to the full handoff when those sections are missing.

## Install

```sh
git clone git@github.com:eddy-lau/agent-shared-memory.git ~/Projects/Personal/agent-shared-memory
ln -s ~/Projects/Personal/agent-shared-memory ~/.config/opencode/plugins/shared-memory
```

Then wire the harnesses below. The symlink keeps hook paths and the OpenCode
`plugins` entry stable; if the clone lives elsewhere, repoint the symlink (or use
the clone path directly in both configs). A dangling symlink is a silent no-op.

## ZCode

Two ways to load it; both are safe to enable together (per-session state prevents
duplicate injection of unchanged content).

- Plugin (portable): Settings → Plugins → Create → Add marketplace → select this
  folder → install `shared-memory` → enable. Hooks apply to new sessions only.
- User hooks (immediate): `~/.zcode/cli/config.json`:

```json
"hooks": {
  "enabled": true,
  "events": {
    "SessionStart": [{ "matcher": "startup|clear|compact", "hooks": [{ "type": "process", "command": "node", "args": ["<this-dir>/zcode/hooks/session-start.mjs"], "timeoutMs": 5000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "process", "command": "node", "args": ["<this-dir>/zcode/hooks/handoff-changed.mjs"], "timeoutMs": 5000 }] }]
  }
}
```

State (digests, dedupe) lives in `~/.cache/zcode/shared-memory`.

## OpenCode

Add the directory to `plugins` in `~/.config/opencode/opencode.json`:

```json
"plugins": ["./plugins/shared-memory/opencode"]
```

Injects on every model request (file reads are cached by mtime), hybrid:

- first request of a session → `full`
- later requests → `state`
- any request after `handoff.md` / `decisions.md` change → `full` again (digest check)

"Full already delivered" is stored on disk (`~/.cache/zcode/shared-memory/<sha256(session)>.opencode.json`)
because OpenCode reloads plugins and runs more than one instance; an in-memory flag
would reset and re-send the full handoff on every request. Without a session id the
plugin degrades to full injection (correct, just expensive).

## Manual test

```sh
echo '{"hook_event_name":"SessionStart","source":"startup","cwd":"/path/to/workspace"}' \
  | node zcode/hooks/session-start.mjs
```
