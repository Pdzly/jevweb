export const NIMBLE_MODEL_ID = "nimble-9b-q4km";
export const NIMBLE_ASSET_ERROR = "NimbleAssetError";

const NIMBLE_REVISION = "a72bdbadb355ca3014f7f9d2585380917cc59971";
const NIMBLE_SOURCE = "https://huggingface.co/ggml-org/Bespoke-Nimble-9B-v3-GGUF";
const NIMBLE_LICENSE = "CC-BY-NC-4.0";
const NIMBLE_QUANTIZATION = "Q4_K_M";
const SPLIT_FIRST_SHARD = /^(.+)-(00001)-of-(\d{5})\.gguf$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_SHARD_FILE = /^[A-Za-z0-9._-]+$/;
const MAX_SHARD_BYTES = 2 * 1024 * 1024 * 1024;

function assetError(detail, cause) {
  const error = new Error(`Nimble model assets are missing or corrupt. Run npm run prepare:nimble, then retry. ${detail}`);
  error.name = NIMBLE_ASSET_ERROR;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function basePath(baseUrl) {
  const base = baseUrl || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

export function nimbleManifestUrl(baseUrl = import.meta.env?.BASE_URL ?? "/") {
  return `${basePath(baseUrl)}models/nimble/manifest.json`;
}

export function resolveNimbleManifest(manifest, manifestUrl) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw assetError("The manifest is not a JSON object.");
  }
  if (
    manifest.version !== 1
    || manifest.modelId !== NIMBLE_MODEL_ID
    || manifest.revision !== NIMBLE_REVISION
    || manifest.quantization !== NIMBLE_QUANTIZATION
    || manifest.license !== NIMBLE_LICENSE
    || manifest.source !== NIMBLE_SOURCE
  ) {
    throw assetError("The manifest identifies a different Nimble model artifact.");
  }
  if (!isPositiveSafeInteger(manifest.totalBytes) || !Array.isArray(manifest.shards) || !manifest.shards.length) {
    throw assetError("The manifest has no valid shard total.");
  }

  let totalBytes = 0;
  let splitPrefix;
  let shardCount;
  for (const [index, shard] of manifest.shards.entries()) {
    if (
      !shard
      || typeof shard !== "object"
      || typeof shard.file !== "string"
      || !SAFE_SHARD_FILE.test(shard.file)
      || !isPositiveSafeInteger(shard.bytes)
      || shard.bytes >= MAX_SHARD_BYTES
      || typeof shard.sha256 !== "string"
      || !SHA256.test(shard.sha256)
    ) {
      throw assetError(`Shard ${index + 1} has invalid metadata.`);
    }

    const match = shard.file.match(index === 0 ? SPLIT_FIRST_SHARD : /^(.+)-(\d{5})-of-(\d{5})\.gguf$/);
    if (!match) {
      throw assetError(`Shard ${index + 1} is not named by llama-gguf-split.`);
    }
    const prefix = match[1];
    const shardNumber = Number(match[2]);
    const total = Number(match[3] ?? match[2]);
    if (index === 0) {
      splitPrefix = prefix;
      shardCount = total;
    }
    const expectedFile = `${splitPrefix}-${String(index + 1).padStart(5, "0")}-of-${String(shardCount).padStart(5, "0")}.gguf`;
    if (shardNumber !== index + 1 || total !== shardCount || shard.file !== expectedFile) {
      throw assetError("The shard order cannot be reconstructed by Wllama.");
    }
    totalBytes += shard.bytes;
  }

  if (shardCount !== manifest.shards.length || totalBytes !== manifest.totalBytes) {
    throw assetError("The manifest totalBytes does not match its shard list.");
  }

  try {
    const manifestLocation = new URL(manifestUrl);
    const firstShardUrl = new URL(manifest.shards[0].file, manifestLocation);
    if (firstShardUrl.origin !== manifestLocation.origin) {
      throw assetError("A shard URL is not same-origin with the manifest.");
    }
    return firstShardUrl.href;
  } catch (error) {
    if (error?.name === NIMBLE_ASSET_ERROR) throw error;
    throw assetError("The manifest URL cannot resolve its first shard.", error);
  }
}

export function validateDecisionModelContext(context, model) {
  if (
    !context
    || !Number.isInteger(context.n_vocab)
    || context.n_vocab < 1
    || !Number.isInteger(context.n_layer)
    || context.n_layer < 1
  ) {
    throw new Error(`${model.name} did not finish initializing in the local runtime.`);
  }

  const architecture = context.metadata?.["general.architecture"];
  if (
    typeof architecture !== "string"
    || context.metadata?.[`${architecture}.decision.type`] !== model.decisionType
  ) {
    throw new Error(`${model.name} does not expose the expected decision metadata in the local runtime.`);
  }
}

async function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");

  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function waitForServiceWorkerControl(fetchImpl, signal) {
  if (
    fetchImpl !== globalThis.fetch ||
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }

  try {
    if (window.__jevServiceWorkerReady) {
      await awaitWithAbort(window.__jevServiceWorkerReady, signal);
      return;
    }

    const registration = await awaitWithAbort(navigator.serviceWorker.getRegistration(), signal);
    if (registration && !navigator.serviceWorker.controller) {
      await awaitWithAbort(navigator.serviceWorker.ready, signal);
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // The manifest request still gives the caller the useful network error.
  }
}

export async function loadNimbleModelSource({ signal, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const manifestPath = nimbleManifestUrl(baseUrl);
  if (typeof fetchImpl !== "function") {
    throw assetError("This browser cannot fetch the local manifest.");
  }
  await waitForServiceWorkerControl(fetchImpl, signal);

  let response;
  try {
    response = await fetchImpl(manifestPath, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw assetError("The local manifest could not be requested.", error);
  }
  if (!response.ok) {
    throw assetError(`The local manifest returned HTTP ${response.status}.`);
  }

  let manifest;
  try {
    manifest = await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw assetError("The local manifest is not valid JSON.", error);
  }
  return resolveNimbleManifest(manifest, response.url || manifestPath);
}
