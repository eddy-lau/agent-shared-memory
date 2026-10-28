#!/usr/bin/env node
// ZCode SessionStart hook.
// stdin: one line of JSON (session_id, cwd, source, hook_event_name, ...)
// stdout: hookSpecificOutput.additionalContext  (injected before the first model request)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

function statePath(key) {
  return join(STATE_DIR, createHash("sha256").update(key).digest("hex") + ".json");
}

function readState(key) {
  try {
    return JSON.parse(readFileSync(statePath(key), "utf8"));
  } catch {
    return null;
  }
}

function writeState(key, value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath(key), JSON.stringify(value));
  } catch {
    /* state is best-effort */
  }
}

function pruneState(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const now = Date.now();
    for (const name of readdirSync(STATE_DIR)) {
      const p = join(STATE_DIR, name);
      if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
    }
  } catch {
    /* ignore */
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
try {
  const memory = buildContext(cwd);
  if (!memory) process.exit(0);

  const source = input.source || "startup";
  const session = input.session_id || input.sessionId || cwd;
  // Two hook sources (user config + plugin) can fire in the same minute; the
  // state key collapses that duplicate without blocking a later restore.
  const key = `${session}:SessionStart:${source}:${Math.floor(Date.now() / 60000)}`;
  const prev = readState(key);
  writeState(key, { digest: memory.digest, at: Date.now() });
  pruneState();
  // Same session + source within the same minute means another hook source
  // (user config or plugin) already injected this exact content.
  if (prev && prev.digest === memory.digest) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: memory.text,
      },
    }),
  );
} catch (err) {
  process.stderr.write(`[shared-memory] session-start failed: ${err?.message || err}\n`);
}
process.exit(0);
