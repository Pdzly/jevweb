// Wllama documents 99999 as the all-layer request; zero remains CPU-only.
export const ALL_GPU_LAYERS = 99999;
const MAX_CPU_THREADS = 8;

function threadLabel(threads) {
  return `${threads} thread${threads === 1 ? "" : "s"}`;
}

function cpuThreadLabel(threads) {
  return `${threads} CPU thread${threads === 1 ? "" : "s"}`;
}

export function selectCpuThreadCount({ hardwareConcurrency, threadsSupported }) {
  if (!threadsSupported) {
    return 1;
  }

  const cores = Number.isFinite(hardwareConcurrency)
    ? Math.floor(hardwareConcurrency)
    : 1;
  return Math.max(1, Math.min(MAX_CPU_THREADS, Math.floor(Math.max(1, cores) / 2)));
}

export function selectRuntimePolicy({
  hardwareConcurrency,
  nativeGpuEligible,
  nativeGpuReason,
  threadsSupported,
}) {
  const requestedThreads = selectCpuThreadCount({ hardwareConcurrency, threadsSupported });
  const threadLimitation = requestedThreads === 1
    ? " Threaded CPU/WASM is unavailable or limited, so one CPU thread was requested."
    : "";

  if (nativeGpuEligible) {
    return {
      backend: "webgpu",
      nGpuLayers: ALL_GPU_LAYERS,
      requestedThreads,
      reason: `Native WebGPU was requested after adapter, JSPI, and Memory64 checks.${threadLimitation}`,
    };
  }

  return {
    backend: "cpu",
    nGpuLayers: 0,
    requestedThreads,
    reason: `${nativeGpuReason || "CPU/WASM was selected because native WebGPU is unavailable."}${threadLimitation}`,
  };
}

export function createRuntimeInfo(policy, actualThreads, { fallback = false, fallbackReason } = {}) {
  const threads = Number.isInteger(actualThreads) && actualThreads > 0
    ? actualThreads
    : 1;
  const threadDescription = cpuThreadLabel(threads);
  const labelThreads = threadLabel(threads);
  const actualThreadLimitation = threads === 1 && policy.requestedThreads > 1
    ? " The runtime reported one CPU thread."
    : "";
  const reason = fallback
    ? `${fallbackReason} ${policy.reason} CPU/WASM loaded instead with ${threadDescription}.${actualThreadLimitation}`
    : `${policy.reason}${actualThreadLimitation}`;

  return {
    backend: policy.backend,
    threads,
    label: policy.backend === "webgpu"
      ? `WebGPU requested · ${threadDescription}`
      : `CPU / WASM · ${labelThreads}`,
    reason,
    fallback,
  };
}

export function isGpuStartupFallbackError(error) {
  if (error?.name === "AbortError") {
    return false;
  }

  const message = error instanceof Error && error.message
    ? error.message
    : String(error || "");
  const normalized = message.toLowerCase();
  if (!normalized || /\babort(?:ed|ing)?\b|\bcancel(?:led|ed|ling)?\b|fetch|network|offline|download|http|cors|storage|cache/.test(normalized)) {
    return false;
  }
  if (/gguf|model\s*(?:format|parse|file)|(?:invalid|corrupt|unsupported)\s*(?:model|gguf|format|architecture)|checksum|tokenizer/.test(normalized)) {
    return false;
  }

  return /webgpu|\bgpu\b|adapter|device(?:\s+(?:lost|creation|initiali[sz]ation|allocation))?|out of memory|\boom\b|allocation|arraybuffer|out of bounds/.test(normalized);
}
