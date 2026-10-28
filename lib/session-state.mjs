// Cross-process session state for the OpenCode plugin.
//
// OpenCode reloads plugins when its config watcher fires (and runs more than one
// plugin instance), so an in-memory flag cannot be trusted to survive to the next
// model request. The "full handoff already delivered" flag lives on disk, keyed by
// session id, in the same state dir the ZCode hooks use.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR =
  process.env.SHARED_MEMORY_STATE ||
  process.env.ZCODE_SHARED_MEMORY_STATE ||
  join(homedir(), ".cache", "zcode", "shared-memory");

/** State-file name for a session. Null when the hook did not expose a session id. */
export function sessionKey(sessionID) {
  if (!sessionID) return null;
  return (
    createHash("sha256").update(`opencode:${sessionID}`).digest("hex") + ".opencode.json"
  );
}

export function readSessionState(key) {
  if (!key) return null;
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, key), "utf8"));
  } catch {
    return null;
  }
}

export function writeSessionState(key, value) {
  if (!key) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, key), JSON.stringify(value));
  } catch {
    /* best-effort: a failed write only costs one extra full injection */
  }
}
