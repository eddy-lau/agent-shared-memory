import { Plugin } from "@opencode/plugin";

import { MARKER, buildMemory, renderMemory } from "../lib/memory.mjs";
import { readSessionState, sessionKey, writeSessionState } from "../lib/session-state.mjs";

// OpenCode plugin: inject workspace shared memory into model requests.
//
// Hybrid to keep token cost low (option C):
//   - first model request of a session          -> full handoff + recent decisions
//   - later requests                            -> State + In flight only
//   - any request after handoff/decisions change -> full again
//
// Reads docs/agents by walking up from the location directory, so nested repos
// see the same files. No-op when the workspace has no shared memory.
export default Plugin.define({
  id: "shared-memory",
  async setup(ctx) {
    const directory = ctx.location?.directory;
    if (!directory) return;

    await ctx.session.hook("context", (event) => {
      const memory = buildMemory(directory);
      if (!memory) return;

      const system = event.system;
      if (!Array.isArray(system)) return;
      const existing = system.findIndex(
        (part) =>
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes(MARKER),
      );

      // Full handoff on the first request of the session, and again whenever
      // the shared memory changed underneath us.
      const key = sessionKey(event.sessionID);
      const seen = readSessionState(key);
      const full = !seen || seen.digest !== memory.digest;

      const text = renderMemory(memory, full ? "full" : "state");
      // OpenCode builds the system prompt per request; if an earlier plugin
      // instance already injected, replace that block instead of duplicating it.
      if (existing >= 0) system.splice(existing, 1, { type: "text", text });
      else system.push({ type: "text", text });

      writeSessionState(key, { digest: memory.digest, full: true, at: Date.now() });
    });
  },
});
