import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_GPU_LAYERS,
  createRuntimeInfo,
  isGpuStartupFallbackError,
  selectCpuThreadCount,
  selectRuntimePolicy,
} from "../src/runtime-policy.js";

test("native GPU policy requests documented all-layer offload and bounded threads", () => {
  const policy = selectRuntimePolicy({
    hardwareConcurrency: 32,
    nativeGpuEligible: true,
    nativeGpuReason: "",
    threadsSupported: true,
  });

  assert.deepEqual(policy, {
    backend: "webgpu",
    nGpuLayers: ALL_GPU_LAYERS,
    requestedThreads: 8,
    reason: "Native WebGPU was requested after adapter, JSPI, and Memory64 checks.",
  });
});

test("missing native GPU capability selects deterministic CPU/WASM", () => {
  const policy = selectRuntimePolicy({
    hardwareConcurrency: 6,
    nativeGpuEligible: false,
    nativeGpuReason: "CPU/WASM was selected because this browser lacks WebAssembly JSPI, which native WebGPU requires.",
    threadsSupported: true,
  });

  assert.equal(policy.backend, "cpu");
  assert.equal(policy.nGpuLayers, 0);
  assert.equal(policy.requestedThreads, 3);
  assert.match(policy.reason, /lacks WebAssembly JSPI/);
});

test("CPU thread selection remains positive and disables pools without thread support", () => {
  assert.equal(selectCpuThreadCount({ hardwareConcurrency: 128, threadsSupported: false }), 1);
  assert.equal(selectCpuThreadCount({ hardwareConcurrency: 1, threadsSupported: true }), 1);
  assert.equal(selectCpuThreadCount({ hardwareConcurrency: 7, threadsSupported: true }), 3);
});

test("runtime info reports actual CPU threads and marks the one scoped fallback", () => {
  const policy = selectRuntimePolicy({
    hardwareConcurrency: 8,
    nativeGpuEligible: false,
    nativeGpuReason: "CPU/WASM was selected after the native WebGPU request could not start.",
    threadsSupported: true,
  });
  const runtimeInfo = createRuntimeInfo(policy, 1, {
    fallback: true,
    fallbackReason: "Native WebGPU startup encountered a GPU, device, or allocation compatibility failure.",
  });

  assert.deepEqual(runtimeInfo, {
    backend: "cpu",
    threads: 1,
    label: "CPU / WASM · 1 thread",
    reason: "Native WebGPU startup encountered a GPU, device, or allocation compatibility failure. CPU/WASM was selected after the native WebGPU request could not start. CPU/WASM loaded instead with 1 CPU thread. The runtime reported one CPU thread.",
    fallback: true,
  });
});

test("only identified GPU startup failures are eligible for the one CPU retry", () => {
  assert.equal(isGpuStartupFallbackError(new Error("WebGPU device lost during initialization")), true);
  assert.equal(isGpuStartupFallbackError(new Error("GPU allocation failed: out of memory")), true);
  assert.equal(isGpuStartupFallbackError(new Error("network fetch failed")), false);
  assert.equal(isGpuStartupFallbackError(Object.assign(new Error("operation cancelled"), { name: "AbortError" })), false);
  assert.equal(isGpuStartupFallbackError(new Error("operation cancelled")), false);
  assert.equal(isGpuStartupFallbackError(new Error("invalid GGUF model format")), false);
});
