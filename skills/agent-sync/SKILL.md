---
name: agent-sync
description: Set up or update shared agent knowledge files between ZCode and OpenCode — project or multi-repo workspace AGENTS.md, docs/agents handoff + decision log, global AGENTS.md symlinks, skills symlinks, shadow checks, and MCP server parity. Triggers on "agent sync", "AGENTS.md", "handoff", "set up shared memory", "sync zcode opencode", "shared brain", "multi-repo workspace".
---

# Agent Sync

Keep knowledge flowing between two agent harnesses (ZCode and OpenCode) that work on the same project. Both read the same formats: SKILL.md skills, project-root AGENTS.md, and MCP servers.

Runtime injection of `docs/agents` is automated by the companion plugin in this repo (`lib/`, `zcode/`, `opencode/`). This skill covers what the plugin does not: one-time setup, harness wiring, and drift/parity audits.

## Key facts

- ZCode reads ONLY `AGENTS.md` at project root plus `~/.zcode/AGENTS.md`. It does not merge nested AGENTS.md files and does not expand `@import`/`@include`. Keep important content in the one root file.
- Skill dirs can shadow each other: a project `.agents/skills/` or `.claude/skills/` entry with the same `name` as a global skill wins over the global one.
- Both harnesses parse SKILL.md skills (YAML frontmatter: `name`, `description`).
- MCP: ZCode at `~/.zcode/cli/config.json` under `mcp.servers` (stdio: `command` string + `args`, `environment`, optional `timeoutMs`); OpenCode at `~/.config/opencode/opencode.json` under `mcp` (`command` as one array, `args`, `environment`, `timeout`). Same servers, different shapes — compare normalized (`command`+`args` joined), not raw fields. ZCode desktop UI import is the safe write path; it can drop non-UI fields like `timeoutMs`, so warn when that matters (long-running vendor servers).

## Step 1 — Inspect state (read-only, always first)

0. If the project already has a `# Repositories` section in its AGENTS.md, show it before acting — it is the persistent record from previous syncs.
1. Identify the repo: cwd, `git remote get-url origin` (if git repo), repo basename. This identity feeds Action G. If cwd is NOT a git repo but contains child git repos, this is a multi-repo workspace — also run Action H in setup.

Collect each item and output a status table before changing anything.

| Item | Where | Missing/present/status |
|---|---|---|
| Project AGENTS.md | `<project>/AGENTS.md` | |
| Memory-pointer block | at end of AGENTS.md | must point at the file that actually holds project memory; if a real handoff lives elsewhere (e.g. project root), re-aim the block there instead of creating `docs/agents/handoff.md` |
| Handoff file | `<project>/docs/agents/handoff.md` (template) — may stay empty if real handoff is elsewhere | |
| Decision log | `<project>/docs/agents/decisions.md` | |
| Global rules link (zcode) | `~/.zcode/AGENTS.md` symlink → `~/.config/opencode/AGENTS.md` | report: missing / valid symlink / broken / conflicting regular files |
| ZCode skills dir | `~/.zcode/skills/` | |
| Shared skills dir | `~/.agents/skills/` (also read by OpenCode) | may be managed by an external installer with `.skill-lock.json` — never delete or replace installed skills; add only new symlinks whose name is free |
| Project shadow dirs | `<project>/.agents/skills/`, `<project>/.claude/skills/` | list any names that shadow a global skill |
| Skill links | symlinks in `~/.zcode/skills/` pointing at `~/.config/opencode/skills/*` | |
| MCP parity | server lists from both configs; normalize command vs `command`+`args` before calling a diff | report only names + format-only differences (e.g. timing fields lost in a UI import) |

Then report gaps and ask which actions to run.

## Step 2 — Offer actions

Run actions ONLY after user chooses. Idempotent everywhere: rerunning must never duplicate content or links.

### Action A — Project files setup (per current project)

1. Create `docs/agents/` with templates (templates inline in this skill):

   `handoff.md`:
   ```
   # Handoff
   > Last updated: —   By: —

   ## State
   (none yet)

   ## In flight
   (none)
   ```

   `decisions.md`:
   ```
   # Decision log (append-only)

   | Date | Tool | Decision | Why |
   |---|---|---|---|
   ```

2. Root `AGENTS.md`:
   - If missing: create with these sections, marked `(fill in with user)`:
     ```
     # Conventions
     # Build / test / validation
     # Project conventions
     ```
   - If present: preserve all existing prose; append nothing unless doing Action B.
3. Always duplicate a readable copy of AGENTS.md summaries and the memory-pointer block into `.zcode/rules/` if `.zcode/rules/` already exists in the project (ZCode project rules location). Never invent a `.zcode/` directory unprompted.

### Action B — Memory-pointer block in AGENTS.md

Idempotent check: grep for `docs/agents/handoff.md`. Only if absent, append:

```markdown
# Project memory
- docs/agents/handoff.md — current state; read at session start
- docs/agents/decisions.md — decision log; append significant choices
End sessions by updating handoff.md.
```

### Action C — Global rules symlinks

If both `~/.zcode/AGENTS.md` and `~/.config/opencode/AGENTS.md` exist as regular files with differing content, STOP and ask which survives; offer to back up the loser. Symlink direction (canonical = `~/.config/opencode/AGENTS.md`):
- `~/.zcode/AGENTS.md` -> `~/.config/opencode/AGENTS.md`

### Action D — Skills links

Symlink `~/.zcode/skills/<name>` -> `~/.config/opencode/skills/<name>` for every opencode skill not already present. Same for `~/.agents/skills/<name>`, EXCEPT: if a real (non-symlink) skill of same name already exists there (installer-managed), leave it and report the conflict instead of overriding. Warn if ZCode config has skills disabled.

### Action E — MCP parity report (report only)

ZCode `mcp.servers` at `~/.zcode/cli/config.json`, OpenCode `mcp` at `~/.config/opencode/opencode.json`. Normalize the two shapes before diffing (`command` array vs `command`+`args` string). If ZCode has no `mcp.servers` key, servers were never installed — recommend the user import via the ZCode UI rather than hand-editing its config; after UI import, verify env/command survived and warn if timing fields (`timeoutMs`) were dropped. Prefer user-scope config over a project `.mcp.json`; never copy secret-bearing MCP entries into a project file. Report differences. Do not edit configs automatically — configs change often and break; propose edits as text.

### Action F — Shadow check (report only)

1. Project `.agents/skills/` or `.claude/skills/` entries with same `name` as a global skill → warn about shadowing (project wins).
2. Nested `AGENTS.md` files → report only; ZCode ignores them, so shared facts must also live in the root file.

### Action G — Sync state into project files (always run, incl. after setup or update actions)

No global registry file is kept — everything stateful lives in the project itself so both harnesses read the same truth:

1. Sibling-repo discovery: scan the cwd's parent directory (one level) for dirs whose basename shares the cwd basename's distinctive token (e.g. cwd `workspaces/ghk-claim-assist` → sibling `ghk-claim-assist-webapp` matches on token `ghk-claim-assist`). For each match collect: path, `git remote get-url origin`, one-line purpose (README first heading), build/test commands (`package.json` scripts etc.), and whether it has its own AGENTS.md.
2. Ensure the `# Repositories` section in the project-root AGENTS.md (Action H format) covers the cwd itself (if git repo) plus discovered related repos — merge, don't clobber; idempotency keyed on the heading; unambiguous repos get rows with relative paths like `../../name`. Ambiguous matches (token too generic, e.g. single common word) go in `docs/agents/handoff.md` notes instead. Append-only lines in handoff "In flight"/Notes, never blank prior content.
3. Bump the handoff: append a dated one-liner under "## State" (e.g. `agent-sync 2026-10-28: AGENTS.md ok, handoff/decisions ok, 2 related repos mapped`). Keep under ~200 lines per the overflow rule.

### Action H — Multi-repo workspace index

A "workspace" may be a parent folder containing several git repos (e.g. 3 repos under one workspace root). ZCode reads ONLY the workspace-root AGENTS.md — it will not discover child repos by itself. So AGENTS.md must carry the repo map.

1. Detect repos: scan one level (or two if none found) of subdirs for `.git`. Also check whether the root itself is a repo (single-repo mode: use the earlier actions instead).
2. For each repo collect: path (relative to root), `git remote get-url origin`, one-line purpose (from README first heading or the user's naming), build/test commands (`package.json` scripts / Makefile / language-specific defaults), and whether the repo already has its own AGENTS.md.
3. Write a `# Repositories` section into the workspace-root AGENTS.md (merge, don't clobber — idempotency keyed on the section heading):

   ```markdown
   # Repositories
   | Repo (path) | Remote | Purpose | Build/test | Own AGENTS.md |
   |---|---|---|---|---|
   | ./api | github.com/... | backend service | pnpm test | yes |
   ```

   Rules for this repo map: paths relative to workspace root; keep the table sorted by path; the map is the source of truth for cross-repo context.
4. Per-repo local file: if a repo has no AGENTS.md of its own, ask if one is wanted for fine-grained conventions. Do not auto-create nested AGENTS.md — ZCode ignores them; only OpenCode consumes nested files.
5. Cross-repo handoff notes go into `docs/agents/handoff.md` at the workspace root (shared across repos). If the user prefers per-repo handoffs, allow subdirs `docs/agents/repos/<name>/` and record the chosen layout in the repo map row.
6. After writing, run Action G to fold the repo map and layout choice into the handoff.

## Step 3 — Update mode (when user asks to "update handoff" or "add decision")

- Handoff: append a `## <date` section under "State" — what done, in flight, gotchas, next up. Keep file under ~200 lines; on overflow, fold old dated sections into `decisions.md` and ask user before deleting.
- Decision: append one table row `| <date> | <tool> | <decision> | <why> |`. Append-only — never edit prior rows.

## Guard rails

- Never overwrite user prose in AGENTS.md. Merge by showing the proposed diff and waiting for approval.
- Never delete files that could be product of the other harness without user approval.
- Never modify or delete `~/.agents/skills/` entries that look installer-managed (`.skill-lock.json` present) — add new symlinks only where the name is free.
- Symlink creation is safe; symlink repair requires user confirmation.
- Never copy secret-bearing config content (API keys) into project-scope files; if debt already exists (e.g. a superseded `.mcp.json`), flag it for cleanup/`.gitignore` on the next pass.
- Asking > assuming when two versions conflict.
