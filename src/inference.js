import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import {
  NIMBLE_ASSET_ERROR,
  NIMBLE_MODEL_ID,
  loadNimbleModelSource,
  validateDecisionModelContext,
} from "./model-assets.js";
import {
  createRuntimeInfo,
  isGpuStartupFallbackError,
  selectRuntimePolicy,
} from "./runtime-policy.js";

const MAX_SOURCE_CHARS = 6000;
const MAX_QUESTIONS = 8;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS = 8;
const CONTEXT_WINDOW_SIZE = 4096;

const HF_BASE_URL = "https://huggingface.co";
const NIMBLE_UNAVAILABLE_REASON = import.meta.env.VITE_GITHUB_PAGES === "true"
  ? "Nimble is unavailable on GitHub Pages because GitHub Pages cannot host its 6.3 GB model. Laya and Julia-1 still run locally in your browser."
  : null;


export const MODELS = [
  {
    id: "laya-q8",
    name: "Laya",
    family: "System One decision model",
    description: "Typed local decisions with probabilities for choices, scores, and yes/no questions.",
    downloadLabel: "~449 MB",
    memoryLabel: "~450 MB + runtime",
    repo: "ggml-org/Laya-GGUF",
    revision: "22265007700297ba9e128297e82540cf28c5d7d4",
    file: "Laya-Q8_0.gguf",
    decisionType: "laya",
  },
  {
    id: "julia-1-q8",
    name: "Julia-1",
    family: "System One decision model",
    description: "Smallest local typed-decision model for lower-memory browsers.",
    downloadLabel: "~168 MB",
    memoryLabel: "~170 MB + runtime",
    repo: "ggml-org/Julia-1-GGUF",
    revision: "16fee17949206fbf58da9347daea44d792a81211",
    file: "Julia-1-Q8_0.gguf",
    decisionType: "laya",
  },
  {
    id: NIMBLE_MODEL_ID,
    name: "Bespoke Nimble 9B",
    family: "System One decision model",
    description: "Large local typed-decision model.",
    downloadLabel: "6.32 GB",
    memoryLabel: ">6.3 GB + runtime",
    decisionType: "nimble",
    licenseLabel: "CC-BY-NC-4.0 · noncommercial",
    source: "https://huggingface.co/ggml-org/Bespoke-Nimble-9B-v3-GGUF",
    unavailableReason: NIMBLE_UNAVAILABLE_REASON,
  },
];

const MODELS_BY_ID = new Map(MODELS.map((model) => [model.id, model]));
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

const THREADS_WASM_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1,
  1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11,
]);
const EXCEPTIONS_WASM_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6,
  0, 6, 64, 25, 11, 11,
]);
const SIMD_WASM_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
  1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function createAbortError() {
  const error = new Error("Decision operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function getErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown error");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

function validatesWasmFeature(probe) {
  return typeof WebAssembly !== "undefined"
    && typeof WebAssembly.validate === "function"
    && WebAssembly.validate(probe);
}

function baselineRuntimeError() {
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.validate !== "function") {
    return "This browser cannot run WebAssembly, which is required for local decision models.";
  }
  if (!validatesWasmFeature(EXCEPTIONS_WASM_PROBE)) {
    return "This browser needs WebAssembly exception handling for local decision models. Update to a current browser version.";
  }
  if (!validatesWasmFeature(SIMD_WASM_PROBE)) {
    return "This browser needs WebAssembly SIMD for local decision models. Update to a current browser version.";
  }
  return null;
}

function supportsThreads() {
  if (typeof SharedArrayBuffer === "undefined" || typeof MessageChannel === "undefined") {
    return false;
  }
  try {
    const channel = new MessageChannel();
    channel.port1.postMessage(new SharedArrayBuffer(1));
    channel.port1.close();
    channel.port2.close();
    return validatesWasmFeature(THREADS_WASM_PROBE);
  } catch {
    return false;
  }
}

function supportsMemory64() {
  try {
    new WebAssembly.Memory({ address: "i64", initial: 1n });
    return true;
  } catch {
    return false;
  }
}

async function getLoadCapabilities() {
  const threadsSupported = supportsThreads();
  const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency;

  if (!WebAssembly.Suspending) {
    return {
      hardwareConcurrency,
      nativeGpuEligible: false,
      nativeGpuReason: "CPU/WASM was selected because this browser lacks WebAssembly JSPI, which native WebGPU requires.",
      threadsSupported,
    };
  }
  if (!supportsMemory64()) {
    return {
      hardwareConcurrency,
      nativeGpuEligible: false,
      nativeGpuReason: "CPU/WASM was selected because this browser lacks WebAssembly Memory64, which native WebGPU requires.",
      threadsSupported,
    };
  }

  const gpu = globalThis.navigator?.gpu;
  if (!gpu?.requestAdapter) {
    return {
      hardwareConcurrency,
      nativeGpuEligible: false,
      nativeGpuReason: "CPU/WASM was selected because no native WebGPU adapter is available.",
      threadsSupported,
    };
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      return {
        hardwareConcurrency,
        nativeGpuEligible: false,
        nativeGpuReason: "CPU/WASM was selected because a high-performance WebGPU adapter could not be acquired.",
        threadsSupported,
      };
    }
    if (adapter.isFallbackAdapter === true) {
      return {
        hardwareConcurrency,
        nativeGpuEligible: false,
        nativeGpuReason: "CPU/WASM was selected because only a software WebGPU adapter is available.",
        threadsSupported,
      };
    }
  } catch {
    return {
      hardwareConcurrency,
      nativeGpuEligible: false,
      nativeGpuReason: "CPU/WASM was selected because a high-performance WebGPU adapter could not be acquired.",
      threadsSupported,
    };
  }

  return {
    hardwareConcurrency,
    nativeGpuEligible: true,
    nativeGpuReason: "",
    threadsSupported,
  };
}

function hostedModelUrl(model) {
  return `${HF_BASE_URL}/${model.repo}/resolve/${model.revision}/${model.file}`;
}

async function getModelSource(model, signal) {
  return model.id === NIMBLE_MODEL_ID
    ? loadNimbleModelSource({ signal })
    : hostedModelUrl(model);
}

function describeLoadError(error, model) {
  if (isAbortError(error) || error?.name === "RuntimeSupportError") {
    return error;
  }

  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();
  if (error?.name === NIMBLE_ASSET_ERROR) {
    return error;
  }
  if (
    model.id === NIMBLE_MODEL_ID
    && /fetch|network|offline|download|http|cors|gguf|model\s*(?:format|parse|file)|(?:invalid|corrupt|unsupported)\s*(?:model|gguf|format)/.test(normalized)
  ) {
    return new Error(
      `Nimble model assets are missing or corrupt. Run npm run prepare:nimble, then retry. Details: ${message}`,
    );
  }
  if (/fetch|network|offline|download|http|cors|storage|cache/.test(normalized)) {
    return new Error(
      `The decision model could not download or open from browser storage. Check your connection for the first download and allow site storage, then retry. Details: ${message}`,
    );
  }
  if (/memory|oom|allocation|arraybuffer|out of bounds/.test(normalized)) {
    return new Error(
      `The browser could not allocate enough memory for this decision model. Close other tabs or choose Julia-1, then retry. Details: ${message}`,
    );
  }
  if (/webgpu|gpu|adapter/.test(normalized)) {
    return new Error(
      `The requested browser runtime could not start. Update the browser and graphics driver, then retry. Details: ${message}`,
    );
  }
  return new Error(`The local decision model could not load. Details: ${message}`);
}

function validateOptions(criteria, question, index) {
  if (question.type === "noul") {
    return undefined;
  }

  if (question.type === "choice") {
    if (Array.isArray(criteria) && criteria.some(
      (option) => typeof option !== "string" || !option.trim(),
    )) {
      throw new Error(`Choice question ${index + 1} has an invalid option.`);
    }
    const choices = Array.isArray(criteria)
      ? Object.fromEntries(criteria.map((option) => [option.trim(), option.trim()]))
      : criteria;
    if (!choices || Array.isArray(choices) || typeof choices !== "object") {
      throw new Error(`Choice question ${index + 1} needs option criteria.`);
    }
    const entries = Object.entries(choices);
    if (entries.length < 2 || entries.length > MAX_OPTIONS) {
      throw new Error(`Choice question ${index + 1} needs 2 to ${MAX_OPTIONS} options.`);
    }
    return Object.fromEntries(
      entries.map(([option, description]) => {
        if (typeof option !== "string" || !option.trim() || option.length > MAX_QUESTION_CHARS) {
          throw new Error(`Choice question ${index + 1} has an invalid option.`);
        }
        if (typeof description !== "string" || !description.trim()) {
          throw new Error(`Choice question ${index + 1} has an invalid option description.`);
        }
        return [option.trim(), description.trim()];
      }),
    );
  }

  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > MAX_OPTIONS) {
    throw new Error(`Score question ${index + 1} needs 2 to ${MAX_OPTIONS} ordered score levels.`);
  }
  return criteria.map((level) => {
    if (typeof level !== "string" || !level.trim() || level.length > MAX_QUESTION_CHARS) {
      throw new Error(`Score question ${index + 1} has an invalid score level.`);
    }
    return level.trim();
  });
}

function validateEvaluationInput({ text, questions }) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Add source text before running a decision.");
  }
  if (text.length > MAX_SOURCE_CHARS) {
    throw new Error(`Source text is limited to ${MAX_SOURCE_CHARS.toLocaleString()} characters.`);
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("Add at least one typed decision question.");
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`Use no more than ${MAX_QUESTIONS} decision questions at once.`);
  }

  const ids = new Set();
  return questions.map((question, index) => {
    if (!question || typeof question !== "object") {
      throw new Error(`Question ${index + 1} is invalid.`);
    }
    const { id, instructions, type } = question;
    if (typeof id !== "string" || !id.trim() || id.length > 80) {
      throw new Error(`Question ${index + 1} needs a short unique identifier.`);
    }
    if (ids.has(id)) {
      throw new Error(`Question identifiers must be unique (duplicate: ${id}).`);
    }
    ids.add(id);
    if (typeof instructions !== "string" || !instructions.trim()) {
      throw new Error(`Question ${index + 1} needs instructions.`);
    }
    if (instructions.length > MAX_QUESTION_CHARS) {
      throw new Error(`Question ${index + 1} is limited to ${MAX_QUESTION_CHARS} characters.`);
    }
    if (!QUESTION_TYPES.has(type)) {
      throw new Error(`Question ${index + 1} must use Yes/no, Choice, or Score.`);
    }

    const criteria = validateOptions(question.criteria, question, index);
    return {
      id: id.trim(),
      instructions: instructions.trim(),
      type,
      ...(criteria === undefined ? {} : { criteria }),
    };
  });
}

export async function getRuntimeSupport() {
  const reason = baselineRuntimeError();
  return reason
    ? { supported: false, reason }
    : {
      supported: true,
      reason: "Automatic · selected on load",
    };
}

export class DecisionEngine {
  #runtime = null;
  #runtimeInfo = null;
  #loadedModelId = null;
  #activeOperation = null;
  #exitTasks = new WeakMap();
  #pendingExit = null;


  #beginOperation() {
    if (this.#activeOperation) {
      throw new Error("A decision operation is already in progress. Wait for it to finish or cancel it first.");
    }

    let resolve;
    let reject;
    const operation = {
      controller: new AbortController(),
      promise: new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      }),
      resolve,
      reject,
    };
    this.#activeOperation = operation;
    return operation;
  }

  #trackOperation(operation, task) {
    Promise.resolve(task).then(
      (value) => {
        if (this.#activeOperation === operation) {
          this.#activeOperation = null;
          operation.resolve(value);
        }
      },
      (error) => {
        if (this.#activeOperation === operation) {
          this.#activeOperation = null;
          operation.reject(error);
        }
      },
    );
    return operation.promise;
  }

  #isCurrent(operation, runtime) {
    return this.#activeOperation === operation
      && (runtime === undefined || this.#runtime === runtime);
  }

  #assertCurrent(operation, runtime) {
    if (!this.#isCurrent(operation, runtime)) {
      throw createAbortError();
    }
  }

  async #exitRuntime(runtime = this.#runtime) {
    if (!runtime) {
      await this.#pendingExit;
      return;
    }

    const existingExit = this.#exitTasks.get(runtime);
    if (existingExit) {
      await existingExit;
      return;
    }
    if (this.#runtime === runtime) {
      this.#runtime = null;
      this.#runtimeInfo = null;
      this.#loadedModelId = null;
    }

    const exitTask = (async () => {
      try {
        await runtime.exit();
      } catch {
        // Runtime shutdown is best-effort after an aborted worker operation.
      }
    })();
    this.#exitTasks.set(runtime, exitTask);
    this.#pendingExit = exitTask;
    await exitTask;
    if (this.#pendingExit === exitTask) {
      this.#pendingExit = null;
    }
  }

  async #loadRuntimeAttempt({ Wllama, model, modelSource, onProgress, operation, policy }) {
    this.#assertCurrent(operation);
    const runtime = new Wllama(
      { default: wasmUrl },
      { suppressNativeLog: true, parallelDownloads: 2 },
    );
    if (!this.#isCurrent(operation)) {
      await this.#exitRuntime(runtime);
      throw createAbortError();
    }
    this.#runtime = runtime;

    try {
      const loadParams = {
        n_ctx: CONTEXT_WINDOW_SIZE,
        n_batch: 1024,
        n_ubatch: 1024,
        n_gpu_layers: policy.nGpuLayers,
        n_threads: policy.requestedThreads,
        signal: operation.controller.signal,
        progressCallback: ({ loaded, total }) => {
          if (!this.#isCurrent(operation, runtime)) {
            return;
          }
          const backend = policy.backend === "webgpu" ? "WebGPU request" : "CPU / WASM";
          if (total > 0 && loaded >= total) {
            onProgress({
              progress: 0.9,
              text: `Initializing ${model.name} (${backend})…`,
            });
            return;
          }
          const downloaded = total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
          onProgress({
            progress: downloaded * 0.9,
            text: total > 0
              ? `Downloading ${model.name}: ${formatBytes(loaded)} / ${formatBytes(total)} (${Math.round(downloaded * 100)}%, ${backend})`
              : `Downloading ${model.name} (${backend})…`,
          });
        },
      };
      const cachedModel = (await runtime.modelManager.getModels()).find(
        (cached) => cached.url === modelSource,
      );
      this.#assertCurrent(operation, runtime);
      if (cachedModel) {
        const backend = policy.backend === "webgpu" ? "WebGPU request" : "CPU / WASM";
        onProgress({
          progress: 0.9,
          text: `Initializing ${model.name} from local storage (${backend})…`,
        });
        await runtime.loadModel(cachedModel, loadParams);
      } else {
        await runtime.loadModelFromUrl(modelSource, loadParams);
      }
      this.#assertCurrent(operation, runtime);
      if (!runtime.isModelLoaded()) {
        throw new Error(`${model.name} did not finish initializing in the local runtime.`);
      }
      validateDecisionModelContext(runtime.getLoadedContextInfo(), model);
      const actualThreads = runtime.getNumThreads();
      if (!Number.isInteger(actualThreads) || actualThreads < 1) {
        throw new Error("The local runtime did not report a valid CPU thread count.");
      }
      return { actualThreads, runtime };
    } catch (error) {
      await this.#exitRuntime(runtime);
      throw error;
    }
  }

  async load(modelId, onProgress = () => { }) {
    const model = MODELS_BY_ID.get(modelId);
    if (!model) {
      throw new Error("The selected decision model is not available in this workspace.");
    }
    if (model.unavailableReason) {
      const error = new Error(model.unavailableReason);
      error.name = "ModelAvailabilityError";
      throw error;
    }
    if (this.#runtime && this.#loadedModelId === modelId && !this.#activeOperation) {
      onProgress({ progress: 1, text: `Model ready (${this.#runtimeInfo.label}).`, runtimeInfo: this.#runtimeInfo });
      return this.#runtimeInfo;
    }

    const operation = this.#beginOperation();
    const task = (async () => {
      await this.#exitRuntime();
      this.#assertCurrent(operation);

      const support = await getRuntimeSupport();
      if (!support.supported) {
        const error = new Error(support.reason);
        error.name = "RuntimeSupportError";
        throw error;
      }
      onProgress({ progress: 0, text: "Preparing automatic runtime…" });

      const capabilities = await getLoadCapabilities();
      this.#assertCurrent(operation);
      const policy = selectRuntimePolicy(capabilities);
      const backend = policy.backend === "webgpu" ? "WebGPU request" : "CPU / WASM";
      onProgress({ progress: 0, text: `Preparing ${backend}…` });
      onProgress({ progress: 0, text: model.id === NIMBLE_MODEL_ID ? "Checking local Nimble assets…" : `Preparing ${model.name}…` });
      const modelSource = await getModelSource(model, operation.controller.signal);
      this.#assertCurrent(operation);

      const { Wllama } = await import("@wllama/wllama");
      this.#assertCurrent(operation);

      let loaded;
      let loadedPolicy = policy;
      let fallback = false;
      try {
        loaded = await this.#loadRuntimeAttempt({
          Wllama,
          model,
          onProgress,
          operation,
          policy,
          modelSource,
        });
      } catch (error) {
        if (!this.#isCurrent(operation)) {
          throw createAbortError();
        }
        if (policy.backend !== "webgpu" || !isGpuStartupFallbackError(error)) {
          throw error;
        }

        fallback = true;
        onProgress({ progress: 0, text: "WebGPU request could not start; retrying with CPU / WASM…" });
        loadedPolicy = selectRuntimePolicy({
          ...capabilities,
          nativeGpuEligible: false,
          nativeGpuReason: "CPU/WASM was selected after the native WebGPU request could not start.",
        });
        loaded = await this.#loadRuntimeAttempt({
          Wllama,
          model,
          onProgress,
          operation,
          policy: loadedPolicy,
          modelSource,
        });
      }

      this.#assertCurrent(operation, loaded.runtime);
      const runtimeInfo = createRuntimeInfo(loadedPolicy, loaded.actualThreads, {
        fallback,
        fallbackReason: fallback
          ? "Native WebGPU startup encountered a GPU, device, or allocation compatibility failure."
          : undefined,
      });
      this.#loadedModelId = modelId;
      this.#runtimeInfo = runtimeInfo;
      onProgress({ progress: 1, text: `Model ready (${runtimeInfo.label}).`, runtimeInfo });
      return runtimeInfo;
    })().catch((error) => {
      if (!this.#isCurrent(operation)) {
        throw createAbortError();
      }
      throw describeLoadError(error, model);
    });

    return this.#trackOperation(operation, task);
  }

  async evaluate({ text, questions, onResult = () => { } }) {
    const normalizedQuestions = validateEvaluationInput({ text, questions });
    if (!this.#runtime || !this.#loadedModelId) {
      throw new Error("Load a local decision model before running a decision.");
    }

    const operation = this.#beginOperation();
    const task = (async () => {
      const runtime = this.#runtime;
      const decisionQuestions = Object.fromEntries(
        normalizedQuestions.map(({ id, ...question }) => [id, question]),
      );
      const response = await runtime.createSystemOne({
        state: text,
        questions: decisionQuestions,
      });

      if (this.#activeOperation !== operation || this.#runtime !== runtime) {
        throw createAbortError();
      }

      return normalizedQuestions.map((question, index) => {
        const answer = response.answers?.[question.id];
        if (!answer) {
          throw new Error(`The decision runtime returned no typed answer for question ${index + 1}.`);
        }
        const result = { question: question.instructions, answer };
        onResult({ index, ...result });
        return result;
      });
    })();

    return this.#trackOperation(operation, task);
  }

  cancel() {
    const operation = this.#activeOperation;
    if (!operation) {
      return;
    }

    this.#activeOperation = null;
    operation.controller.abort();
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#runtimeInfo = null;
    this.#loadedModelId = null;
    void this.#exitRuntime(runtime);
    operation.reject(createAbortError());
  }

  dispose() {
    const operation = this.#activeOperation;
    this.#activeOperation = null;
    operation?.controller.abort();
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#runtimeInfo = null;
    this.#loadedModelId = null;
    void this.#exitRuntime(runtime);
    operation?.reject(createAbortError());
  }
}
