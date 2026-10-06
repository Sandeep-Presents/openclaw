// Stream-json output limits and raw-line framing for the CLI streaming parser.
// Kept beside `cli-output-stream.ts` so the parser stays within the file-size
// budget; the limits are process constants, not per-backend configuration.
import type { CliStreamJsonOutputLimits } from "./cli-output-contracts.js";

// Both limits bound memory, not throughput. A turn may stream any number of
// lines (one per token under --include-partial-messages) for as long as the run
// timeout allows; only one raw line in flight and the state the parser keeps
// (reply text, thinking, tool input being assembled) are capped.
const CLI_STREAM_JSON_MAX_PENDING_LINE_CHARS = 8 * 1024 * 1024;
const CLI_STREAM_JSON_MAX_RETAINED_CHARS = 8 * 1024 * 1024;
export const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({
  maxPendingLineChars: CLI_STREAM_JSON_MAX_PENDING_LINE_CHARS,
  maxRetainedChars: CLI_STREAM_JSON_MAX_RETAINED_CHARS,
} satisfies CliStreamJsonOutputLimits);

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  maxLineChars: number,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > maxLineChars) {
      state.pending = "";
      return false;
    }
    state.pending += chunk.slice(offset, lineEnd);
    if (newlineIndex === -1) {
      return true;
    }
    const line = state.pending;
    // Control-response writes can synchronously reenter stdout framing.
    state.pending = "";
    offset = newlineIndex + 1;
    if (onLine(line) === false) {
      return true;
    }
  }
  return true;
}

export function streamJsonOutputLimitErrorText(kind: "line" | "retained", limit: number): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; refusing to parse output.`;
  }
  return `CLI JSONL output retained more than ${limit} characters of reply, thinking and tool input in one turn; refusing to parse output.`;
}
