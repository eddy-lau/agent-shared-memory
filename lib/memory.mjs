// Shared workspace memory reader — used by both the ZCode hook and the OpenCode plugin.
//
// Memory lives in the workspace, not in a harness-private store:
//   <workspace>/docs/agents/handoff.md    (authoritative current state)
//   <workspace>/docs/agents/decisions.md  (append-only log)
//
// Two render modes keep injection cheap:
//   full   — whole handoff + last decisions (session start / content change)
//   state  — handoff header + State + In flight sections only (later requests)
//
// Read-only. No network. Cached by mtime+size.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const HANDOFF_REL = "docs/agents/handoff.md";
const DECISIONS_REL = "docs/agents/decisions.md";
const MAX_DEPTH = 8;
const MAX_HANDOFF_BYTES = 64 * 1024;
const MAX_DECISIONS_BYTES = 8 * 1024;
const DECISION_ROWS = 12;
const STATE_SECTIONS = ["state", "in flight"];
export const MARKER = "<shared_memory";

const PREAMBLE_FULL = [
  "Workspace shared memory (maintained by every agent harness). Treat as current project state.",
  "At session end, update docs/agents/handoff.md and append decisions.md.",
];

const PREAMBLE_STATE = [
  "Workspace shared memory — current state only. The full handoff and recent decisions were injected earlier in this session.",
  "At session end, update docs/agents/handoff.md and append decisions.md.",
];

const cache = new Map(); // path -> { mtimeMs, size, text }

function readCapped(path, cap) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (text.length > cap) text = text.slice(0, cap) + `\n…[truncated at ${cap} bytes]`;
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

/** Walk up from startDir to the first directory containing docs/agents/handoff.md. */
export function resolveMemoryRoot(startDir = process.cwd()) {
  const override = process.env.SHARED_MEMORY_ROOT;
  if (override) {
    const root = resolve(override);
    return existsSync(join(root, HANDOFF_REL)) ? root : null;
  }
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (existsSync(join(dir, HANDOFF_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function decisionRows(text) {
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim().startsWith("| Date"));
  if (headerIdx === -1) return text.trim();
  const head = lines.slice(headerIdx, headerIdx + 2); // header + separator
  const rows = lines
    .slice(headerIdx + 2)
    .filter((l) => l.trim().startsWith("|"))
    .slice(-DECISION_ROWS);
  return [...head, ...rows].join("\n");
}

/** Split a handoff into [header, ...## sections]. Header keeps its heading + blockquote. */
function splitSections(handoff) {
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of handoff.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1].toLowerCase(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/** Handoff header + State/In flight only. Falls back to the full handoff if those sections are absent. */
function stateOnly(handoff) {
  const sections = splitSections(handoff);
  const kept = sections.filter(
    (s) => s.heading === null || STATE_SECTIONS.includes(s.heading),
  );
  if (kept.length < 2) return handoff.trimEnd();
  const lines = [];
  for (const section of kept) {
    if (lines.length) lines.push("");
    lines.push(...trimBlank(section.lines));
  }
  return lines.join("\n");
}

/** Read and parse shared memory. Returns null when the workspace has none. */
export function buildMemory(startDir = process.cwd()) {
  const root = resolveMemoryRoot(startDir);
  if (!root) return null;

  const handoff = readCapped(join(root, HANDOFF_REL), MAX_HANDOFF_BYTES);
  if (!handoff) return null;

  const decisionsRaw = readCapped(join(root, DECISIONS_REL), MAX_DECISIONS_BYTES);
  const decisions = decisionsRaw ? decisionRows(decisionsRaw) : null;

  const updated = (handoff.match(/^>\s*Last updated:\s*(\S+)/m) || [])[1] || "unknown";
  const hash = createHash("sha256");
  hash.update(handoff);
  if (decisionsRaw) hash.update(decisionsRaw);

  return {
    root,
    updated,
    handoff,
    decisions,
    digest: hash.digest("hex"),
  };
}

/** Render shared memory for injection. mode: "full" | "state". */
export function renderMemory(memory, mode = "full") {
  if (!memory) return null;
  const full = mode !== "state";
  const body = full ? memory.handoff.trimEnd() : stateOnly(memory.handoff);

  const parts = [
    ...(full ? PREAMBLE_FULL : PREAMBLE_STATE),
    "",
    `<shared_memory source="${HANDOFF_REL}" mode="${full ? "full" : "state"}" updated="${memory.updated}">`,
    body,
    "</shared_memory>",
  ];

  if (full && memory.decisions) {
    parts.push(
      "",
      `<shared_memory source="${DECISIONS_REL}" rows="${DECISION_ROWS}">`,
      memory.decisions,
      "</shared_memory>",
    );
  }

  return parts.join("\n");
}

/** Build the injected context. Returns null when the workspace has no shared memory. */
export function buildContext(startDir = process.cwd(), mode = "full") {
  const memory = buildMemory(startDir);
  if (!memory) return null;
  return { ...memory, mode, text: renderMemory(memory, mode) };
}

/** Stable digest of the shared memory files, for change detection. */
export function memoryDigest(startDir = process.cwd()) {
  const memory = buildMemory(startDir);
  return memory ? memory.digest : null;
}
