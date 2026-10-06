import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { answer, batch, config, registered } from "../../decisions/runtime.test-support.js";
import type { DecisionProviderV1 } from "../../decisions/types.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshotState,
} from "../../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDecisionTool } from "./decision-tool.js";
import { ONE_PIXEL_PNG_B64 } from "./image-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  clearCurrentPluginMetadataSnapshot();
});

it("resolves one local screenshot through the core tool and dispatches bytes to an image-capable plugin", async () => {
  const root = tempDirs.make("decision-tool-image-");
  const screenshot = path.join(root, "screen.png");
  const expected = Buffer.from(ONE_PIXEL_PNG_B64, "base64");
  fs.writeFileSync(screenshot, expected);
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  registered(evaluate);
  setRuntimeConfigSnapshot(config);
  setCurrentPluginMetadataSnapshotState(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "owner",
          contracts: { decisionProviders: ["fixture"] },
          decisionModels: [
            {
              provider: "fixture",
              id: "fixture-v1",
              name: "Image fixture",
              capabilities: {
                questionTypes: ["boolean", "choice", "score"],
                inputModalities: ["text", "image"],
              },
            },
          ],
        },
      ],
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    "gateway",
  );
  const tool = createDecisionTool("main", {
    config,
    workspaceDir: root,
    fsPolicy: { workspaceOnly: true, root },
  });
  expect(tool).not.toBeNull();
  const result = await tool!.execute("call", { ...batch, images: [screenshot] });
  expect(result.details).toMatchObject({ status: "ok" });
  expect(evaluate).toHaveBeenCalledOnce();
  expect(evaluate.mock.calls[0]?.[0].images).toEqual([
    {
      mimeType: "image/png",
      data: Uint8Array.from(expected),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(screenshot);
  evaluate.mockClear();
  await expect(
    tool!.execute("remote", { ...batch, images: ["https://example.test/a.png"] }),
  ).rejects.toThrow("local image paths");
  expect(evaluate).not.toHaveBeenCalled();
});
