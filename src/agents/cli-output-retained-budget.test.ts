// The stream-json parser bounds the state it keeps, not the volume that streams
// through it. A long Claude turn under --include-partial-messages emits one line
// per token; those lines are consumed and dropped, so they must not end the turn.
import { describe, expect, it } from "vitest";
import type { CliToolUseStartDelta } from "./cli-output-contracts.js";
import {
  CLI_STREAM_JSON_OUTPUT_LIMITS,
  CLI_STREAM_JSON_RETAINED_ENTRY_CHARS,
} from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const SESSION_ID = "6f1c2a4e-0b7d-4c55-9a1e-2f3b4c5d6e7f";

// Same envelope Claude Code writes for each partial frame (~200 characters).
function frame(event: Record<string, unknown>, n: number) {
  return JSON.stringify({
    type: "stream_event",
    event,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  });
}

function createClaudeParser(tools: CliToolUseStartDelta[] = []) {
  const deltas: string[] = [];
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: ({ delta }) => deltas.push(delta),
    onToolUseStart: (tool) => tools.push(tool),
  });
  return { parser, deltas };
}

/** One API message: a tool call streamed as `partialJsonFrames` input deltas. */
function toolMessage(id: number, partialJsonFrames: number, chunk: string) {
  const lines: string[] = [];
  let n = id * 1_000_000;
  lines.push(
    frame({ type: "message_start", message: { id: `msg_${id}`, role: "assistant" } }, n++),
  );
  lines.push(
    frame(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: `toolu_${id}`, name: "Write", input: {} },
      },
      n++,
    ),
  );
  lines.push(
    frame(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"content":"' },
      },
      n++,
    ),
  );
  for (let i = 0; i < partialJsonFrames; i += 1) {
    lines.push(
      frame(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: chunk },
        },
        n++,
      ),
    );
  }
  lines.push(
    frame(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"}' },
      },
      n++,
    ),
  );
  lines.push(frame({ type: "content_block_stop", index: 0 }, n++));
  lines.push(frame({ type: "message_stop" }, n));
  return lines;
}

/** A final API message whose reply streams as `textFrames` text deltas. */
function replyMessage(textFrames: number, chunk: string) {
  const lines: string[] = [];
  let n = 9_000_000_000;
  lines.push(
    frame({ type: "message_start", message: { id: "msg_reply", role: "assistant" } }, n++),
  );
  lines.push(
    frame(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      n++,
    ),
  );
  for (let i = 0; i < textFrames; i += 1) {
    lines.push(
      frame(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } },
        n++,
      ),
    );
  }
  lines.push(frame({ type: "content_block_stop", index: 0 }, n++));
  lines.push(frame({ type: "message_stop" }, n));
  return lines;
}

function result(text: string) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: text,
    session_id: SESSION_ID,
  });
}

describe("createCliJsonlStreamingParser retained budget", () => {
  it("finishes a long tool-heavy Claude turn of partial frames past the old line and character odometers", () => {
    const tools: CliToolUseStartDelta[] = [];
    const { parser, deltas } = createClaudeParser(tools);
    const chunk = "0123456789";
    const lines: string[] = [];
    // 40 tool calls of 1,000 input frames each, then a 2,000-frame reply:
    // ~42,000 lines and ~9 MB on the wire, about one hour of a real turn.
    for (let id = 1; id <= 40; id += 1) {
      lines.push(...toolMessage(id, 1_000, chunk));
    }
    lines.push(...replyMessage(2_000, "ok "));
    lines.push(result(""));
    const wire = `${lines.join("\n")}\n`;
    expect(lines.length).toBeGreaterThan(20_000);
    expect(wire.length).toBeGreaterThan(8 * 1024 * 1024);

    // Stdout arrives in pipe-sized chunks, not lines.
    for (let offset = 0; offset < wire.length; offset += 65_536) {
      parser.push(wire.slice(offset, offset + 65_536));
    }
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.hasTerminalResult()).toBe(true);
    expect(parser.getOutput()?.text).toBe("ok ".repeat(2_000).trim());
    expect(deltas).toHaveLength(2_000);
    expect(tools).toHaveLength(40);
    expect(tools[39]).toMatchObject({
      toolCallId: "toolu_40",
      name: "Write",
      args: { content: chunk.repeat(1_000) },
    });
  });

  it("releases each tool call's assembled input when its block stops", () => {
    const tools: CliToolUseStartDelta[] = [];
    const { parser } = createClaudeParser(tools);
    // 12 tool calls of 1 MiB input each: 12 MiB assembled in total, never more
    // than 1 MiB held at once.
    const chunk = "a".repeat(1024);
    for (let id = 1; id <= 12; id += 1) {
      parser.push(`${toolMessage(id, 1024, chunk).join("\n")}\n`);
    }
    parser.push(`${result("done")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("done");
    expect(tools).toHaveLength(12);
  });

  it("refuses a turn whose streamed reply text outgrows the retained budget", () => {
    const { parser } = createClaudeParser();
    const limit = CLI_STREAM_JSON_OUTPUT_LIMITS.maxRetainedChars;
    const chunk = "b".repeat(64 * 1024);
    const frames = Math.ceil(limit / chunk.length) + 1;
    parser.push(`${replyMessage(frames, chunk).join("\n")}\n${result("late")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBe(
      `CLI JSONL output retained more than ${limit} characters of reply, thinking and tool state in one turn; refusing to parse output.`,
    );
    expect(parser.getOutput()).toMatchObject({ text: "" });
  });

  it("refuses a single tool input that outgrows the retained budget", () => {
    const tools: CliToolUseStartDelta[] = [];
    const { parser } = createClaudeParser(tools);
    const limit = CLI_STREAM_JSON_OUTPUT_LIMITS.maxRetainedChars;
    const chunk = "c".repeat(64 * 1024);
    const frames = Math.ceil(limit / chunk.length) + 1;
    parser.push(`${toolMessage(1, frames, chunk).join("\n")}\n${result("late")}\n`);

    expect(parser.getErrorText()).toContain("retained more than");
    expect(tools).toHaveLength(0);
  });

  it("charges complete start-block tool inputs while their blocks are open", () => {
    const input = { content: "d".repeat(5 * 1024 * 1024) };
    const start = (index: number, n: number) =>
      frame(
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: `toolu_block_${index}`, name: "Write", input },
        },
        n,
      );
    const stop = (index: number, n: number) => frame({ type: "content_block_stop", index }, n);

    const sequential = createClaudeParser();
    sequential.parser.push(`${[start(0, 1), stop(0, 2), start(1, 3), stop(1, 4)].join("\n")}\n`);
    sequential.parser.push(`${result("done")}\n`);
    sequential.parser.finish();
    expect(sequential.parser.getErrorText()).toBeNull();
    expect(sequential.parser.getOutput()?.text).toBe("done");

    const concurrent = createClaudeParser();
    concurrent.parser.push(`${[start(0, 1), start(1, 2)].join("\n")}\n`);
    expect(concurrent.parser.getErrorText()).toContain("retained more than");
  });

  it("refuses a flood of unique tool calls instead of growing their IDs without bound", () => {
    const tools: CliToolUseStartDelta[] = [];
    const { parser } = createClaudeParser(tools);
    const pushTool = (n: number) => {
      const id = `toolu_${String(n).padStart(4096, "0")}`;
      parser.push(
        `${JSON.stringify({
          type: "assistant",
          message: {
            id: `msg_${n}`,
            role: "assistant",
            content: [{ type: "tool_use", id, name: "Bash", input: {} }],
          },
          session_id: SESSION_ID,
        })}\n${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "" }],
          },
          session_id: SESSION_ID,
        })}\n`,
      );
    };
    for (let n = 0; n < 100; n += 1) {
      pushTool(n);
    }
    expect(parser.getErrorText()).toBeNull();
    for (let n = 100; n < 1_000 && !parser.getErrorText(); n += 1) {
      pushTool(n);
    }

    expect(parser.getErrorText()).toContain("retained more than");
    expect(tools.length).toBeLessThan(1_000);
  });

  it.each([
    { name: "a snapshot and its result", withPartials: false },
    { name: "partial frames, a snapshot and its result", withPartials: true },
  ])(
    "still accepts the largest reply the old wire budget allowed via $name",
    ({ withPartials }) => {
      const oldWireBudget = 8 * 1024 * 1024;
      const chunk = "e".repeat(64 * 1024);
      // Without partial frames the reply crosses the wire twice; with them, three times.
      const copies = withPartials ? 3 : 2;
      const frames = Math.floor((oldWireBudget - 64 * 1024) / copies / chunk.length);
      const reply = chunk.repeat(frames);
      const lines = withPartials ? replyMessage(frames, chunk).slice(0, -1) : [];
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_reply",
            role: "assistant",
            content: [{ type: "text", text: reply }],
            stop_reason: null,
          },
          session_id: SESSION_ID,
        }),
        result(reply),
      );
      const wire = `${lines.join("\n")}\n`;
      expect(wire.length).toBeLessThan(oldWireBudget);

      const { parser } = createClaudeParser();
      parser.push(wire);
      parser.finish();

      expect(parser.getErrorText()).toBeNull();
      expect(parser.getOutput()?.text).toBe(reply);
    },
  );

  it("charges the IDs and names of tool blocks that are still open", () => {
    const { parser } = createClaudeParser();
    for (let index = 0; index < 3; index += 1) {
      parser.push(
        `${frame(
          {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: `toolu_${index}_${"i".repeat(3 * 1024 * 1024)}`,
              name: "Write",
              input: {},
            },
          },
          index,
        )}\n`,
      );
    }

    expect(parser.getErrorText()).toContain("retained more than");
  });

  it.each([
    {
      name: "empty input_json_delta fragments in an open tool block",
      prefix: `${frame(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_empty", name: "Write", input: {} },
        },
        0,
      )}\n`,
      line: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "" },
        },
      }),
    },
    { name: "empty item texts", prefix: "", line: JSON.stringify({ item: { text: "" } }) },
  ])("refuses a flood of $name instead of growing a collection for free", ({ prefix, line }) => {
    const { parser } = createClaudeParser();
    const entries = Math.ceil(
      CLI_STREAM_JSON_OUTPUT_LIMITS.maxRetainedChars / CLI_STREAM_JSON_RETAINED_ENTRY_CHARS,
    );
    parser.push(prefix);
    const batch = `${line}\n`.repeat(4_096);
    for (let pushed = 0; pushed <= entries && !parser.getErrorText(); pushed += 4_096) {
      parser.push(batch);
    }

    expect(parser.getErrorText()).toContain("retained more than");
  });
});
