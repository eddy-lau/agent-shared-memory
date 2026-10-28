#!/usr/bin/env node
// ZCode UserPromptSubmit hook.
// Injects the full shared memory only when handoff.md / decisions.md changed since
// the last injection in this session. Keeps mid-session edits made by OpenCode
// (or by hand) visible without re-sending unchanged content on every prompt.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildContext } from "../../lib/memory.mjs";

const STATE_DIR =
  process.env.ZCODE_SHARED_MEMORY_STATE || join(homedir(), ".cache", "zcode", "shared-memory");

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
  });
}

function statePath(session) {
  return join(STATE_DIR, createHash("sha256").update(session).digest("hex") + ".json");
}

function readState(session) {
  try {
    return JSON.parse(readFileSync(statePath(session), "utf8"));
  } catch {
    return null;
  }
}

function writeState(session, value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath(session), JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

const raw = await readStdin();
let input = {};
try {
  input = JSON.parse(raw || "{}");
} catch {
  /* fall back to cwd */
}

const cwd = input.cwd || process.cwd();
const session = input.session_id || input.sessionId || cwd;

try {
  const memory = buildContext(cwd);
  if (!memory) process.exit(0);

  const prev = readState(session);
  writeState(session, { digest: memory.digest, at: Date.now() });
  if (prev && prev.digest === memory.digest) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: memory.text,
      },
    }),
  );
} catch (err) {
  process.stderr.write(`[shared-memory] prompt hook failed: ${err?.message || err}\n`);
}
process.exit(0);
