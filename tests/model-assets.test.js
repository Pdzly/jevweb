import assert from "node:assert/strict";
import test from "node:test";

import {
  loadNimbleModelSource,
  NIMBLE_ASSET_ERROR,
  resolveNimbleManifest,
  validateDecisionModelContext,
} from "../src/model-assets.js";

function manifest(overrides = {}) {
  return {
    version: 1,
    modelId: "nimble-9b-q4km",
    revision: "a72bdbadb355ca3014f7f9d2585380917cc59971",
    quantization: "Q4_K_M",
    totalBytes: 768,
    shards: [
      {
        file: "Bespoke-Nimble-9B-v3-Q4_K_M-00001-of-00002.gguf",
        bytes: 512,
        sha256: "a".repeat(64),
      },
      {
        file: "Bespoke-Nimble-9B-v3-Q4_K_M-00002-of-00002.gguf",
        bytes: 256,
        sha256: "b".repeat(64),
      },
    ],
    license: "CC-BY-NC-4.0",
    source: "https://huggingface.co/ggml-org/Bespoke-Nimble-9B-v3-GGUF",
    ...overrides,
  };
}

test("resolves a validated Nimble manifest to Wllama's first-shard URL", () => {
  const source = resolveNimbleManifest(
    manifest(),
    "https://example.test/app/models/nimble/manifest.json",
  );

  assert.equal(
    source,
    "https://example.test/app/models/nimble/Bespoke-Nimble-9B-v3-Q4_K_M-00001-of-00002.gguf",
  );
});

test("rejects manifests whose shard list Wllama cannot reconstruct", () => {
  assert.throws(
    () => resolveNimbleManifest(
      manifest({
        shards: [
          manifest().shards[0],
          { ...manifest().shards[1], file: "unexpected-00002-of-00002.gguf" },
        ],
      }),
      "https://example.test/models/nimble/manifest.json",
    ),
    (error) => error?.name === NIMBLE_ASSET_ERROR && /Run npm run prepare:nimble/.test(error.message),
  );
});

test("rejects a manifest with a mismatched asset byte total", () => {
  assert.throws(
    () => resolveNimbleManifest(
      manifest({ totalBytes: 767 }),
      "https://example.test/models/nimble/manifest.json",
    ),
    (error) => error?.name === NIMBLE_ASSET_ERROR && /totalBytes/.test(error.message),
  );
});

test("rejects shard names that could resolve outside the manifest directory", () => {
  for (const file of [
    "https:evil.test-00001-of-00002.gguf",
    "Bespoke-Nimble-9B-v3-Q4_K_M-00001-of-00002.gguf?other-origin",
  ]) {
    assert.throws(
      () => resolveNimbleManifest(
        manifest({
          shards: [
            { ...manifest().shards[0], file },
            manifest().shards[1],
          ],
        }),
        "https://example.test/models/nimble/manifest.json",
      ),
      (error) => error?.name === NIMBLE_ASSET_ERROR,
    );
  }
});

test("rejects a shard at Wllama's 2 GiB file limit", () => {
  const twoGiB = 2 * 1024 * 1024 * 1024;
  assert.throws(
    () => resolveNimbleManifest(
      manifest({
        totalBytes: twoGiB + 256,
        shards: [
          { ...manifest().shards[0], bytes: twoGiB },
          manifest().shards[1],
        ],
      }),
      "https://example.test/models/nimble/manifest.json",
    ),
    (error) => error?.name === NIMBLE_ASSET_ERROR,
  );
});

test("preserves cancellation while reading the Nimble manifest body", async () => {
  const cancellation = Object.assign(new Error("cancelled"), { name: "AbortError" });
  await assert.rejects(
    () => loadNimbleModelSource({
      fetchImpl: async () => ({
        ok: true,
        url: "https://example.test/models/nimble/manifest.json",
        json: async () => { throw cancellation; },
      }),
    }),
    (error) => error === cancellation,
  );
});

test("requires a fully initialized native decision context before it is reported ready", () => {
  const model = { name: "Bespoke Nimble 9B", decisionType: "nimble" };
  const context = {
    n_vocab: 151936,
    n_layer: 36,
    metadata: {
      "general.architecture": "qwen35",
      "qwen35.decision.type": "nimble",
    },
  };

  assert.doesNotThrow(() => validateDecisionModelContext(context, model));
  assert.throws(
    () => validateDecisionModelContext({ ...context, n_layer: 0 }, model),
    /did not finish initializing/,
  );
  assert.throws(
    () => validateDecisionModelContext({
      ...context,
      metadata: { ...context.metadata, "qwen35.decision.type": "laya" },
    }, model),
    /does not expose the expected decision metadata/,
  );
});
