#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { spawn } from "node:child_process";

const MODEL = {
  id: "nimble-9b-q4km",
  owner: "ggml-org",
  repository: "Bespoke-Nimble-9B-v3-GGUF",
  revision: "a72bdbadb355ca3014f7f9d2585380917cc59971",
  file: "Bespoke-Nimble-9B-v3-Q4_K_M.gguf",
  quantization: "Q4_K_M",
  license: "CC-BY-NC-4.0",
  source: "https://huggingface.co/ggml-org/Bespoke-Nimble-9B-v3-GGUF",
  licenseSource:
    "https://huggingface.co/ggml-org/Bespoke-Nimble-9B-v3-GGUF/blob/a72bdbadb355ca3014f7f9d2585380917cc59971/README.md",
};
// This pinned GGUF has an 845,316,224-byte indivisible tensor, so 1 GiB is the
// smallest valid standard llama-gguf-split limit (well below Wllama's 2 GiB file limit).
const MAX_SHARD_BYTES = 1024 * 1024 * 1024;
const SPLITTER = {
  release: "b11429",
  assets: {
    "linux-x64": {
      archive: "llama-b11429-bin-ubuntu-x64.tar.gz",
      size: 17693462,
      sha256: "f6d25dde8f51133143d1453da4fd5f73b145127177612a283bf7995957af3392",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-ubuntu-x64.tar.gz",
    },
  },
};

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cacheRoot = join(root, ".cache", "nimble");
const outputDirectory = join(root, "public", "models", "nimble");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", (error) => rejectRun(error));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}).`));
      }
    });
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function fetchJson(url, label) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    fail(`${label} request failed with HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

async function download(url, destination, expectedSha256, label) {
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    fail(`${label} download failed with HTTP ${response.status}: ${url}`);
  }

  const hash = createHash("sha256");
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: "wx" }));
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256) {
      fail(`${label} SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`);
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function ensureDownloaded(url, destination, expectedSize, expectedSha256, label) {
  if (await pathExists(destination)) {
    const file = await stat(destination);
    if (file.size === expectedSize && (await hashFile(destination)) === expectedSha256) {
      return;
    }
    await rm(destination, { force: true });
  }
  console.log(`Downloading ${label} (${expectedSize.toLocaleString()} bytes)…`);
  await download(url, destination, expectedSha256, label);
}

async function upstreamModel() {
  const api = `https://huggingface.co/api/models/${MODEL.owner}/${MODEL.repository}/tree/${MODEL.revision}?recursive=false&expand=true`;
  const files = await fetchJson(api, "Hugging Face metadata");
  const model = files.find((entry) => entry.path === MODEL.file);
  if (!model?.lfs?.oid || !Number.isSafeInteger(model.lfs.size)) {
    fail(`Pinned Hugging Face revision did not provide LFS SHA-256 and size for ${MODEL.file}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(model.lfs.oid)) {
    fail(`Pinned Hugging Face revision returned an invalid LFS SHA-256 for ${MODEL.file}.`);
  }
  return { size: model.lfs.size, sha256: model.lfs.oid, files };
}

function splitterAsset() {
  const key = `${platform()}-${arch()}`;
  const asset = SPLITTER.assets[key];
  if (!asset) {
    fail(
      `No verified llama-gguf-split asset is pinned for ${key}. Run this command on Linux x64 or add an official llama.cpp ${SPLITTER.release} asset and checksum.`,
    );
  }
  return asset;
}

async function ensureSplitter() {
  const asset = splitterAsset();
  const toolsDirectory = join(cacheRoot, "tools", SPLITTER.release);
  const archive = join(toolsDirectory, asset.archive);
  const extracted = join(toolsDirectory, "extracted");
  const executable = join(extracted, `llama-${SPLITTER.release}`, "llama-gguf-split");

  await mkdir(toolsDirectory, { recursive: true });
  await ensureDownloaded(
    asset.url,
    archive,
    asset.size,
    asset.sha256,
    `official llama.cpp ${SPLITTER.release} splitter archive`,
  );
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", archive, "--no-same-owner", "-C", extracted]);
  if (!(await pathExists(executable))) {
    fail(`Verified llama.cpp archive did not contain llama-${SPLITTER.release}/llama-gguf-split at ${executable}.`);
  }
  await chmod(executable, 0o755);
  return executable;
}

async function readManifest(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

async function verifyPrepared(directory, expectedTotalBytes = undefined) {
  const manifest = await readManifest(directory);
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.modelId !== MODEL.id ||
    manifest.revision !== MODEL.revision ||
    manifest.quantization !== MODEL.quantization ||
    manifest.license !== MODEL.license ||
    manifest.source !== MODEL.source ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length === 0 ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    (expectedTotalBytes !== undefined && manifest.totalBytes !== expectedTotalBytes)
  ) {
    return false;
  }

  let totalBytes = 0;
  for (const [index, shard] of manifest.shards.entries()) {
    if (
      !shard ||
      typeof shard.file !== "string" ||
      basename(shard.file) !== shard.file ||
      !Number.isSafeInteger(shard.bytes) ||
      shard.bytes <= 0 ||
      shard.bytes > MAX_SHARD_BYTES ||
      !/^[0-9a-f]{64}$/.test(shard.sha256)
    ) {
      return false;
    }
    const match = shard.file.match(/-(\d{5})-of-(\d{5})\.gguf$/);
    if (!match || Number(match[1]) !== index + 1 || Number(match[2]) !== manifest.shards.length) {
      return false;
    }
    const path = join(directory, shard.file);
    if (!(await pathExists(path))) {
      return false;
    }
    const file = await stat(path);
    if (file.size !== shard.bytes || (await hashFile(path)) !== shard.sha256) {
      return false;
    }
    if (!(await ggufMagic(path))) {
      return false;
    }
    totalBytes += shard.bytes;
  }
  return totalBytes === manifest.totalBytes;
}

async function ggufMagic(path) {
  const descriptor = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    await descriptor.read(bytes, 0, bytes.length, 0);
    return bytes.toString("ascii") === "GGUF";
  } finally {
    await descriptor.close();
  }
}

async function listShards(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const shards = entries
    .filter((entry) => entry.isFile() && /-\d{5}-of-\d{5}\.gguf$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (shards.length === 0) {
    fail("llama-gguf-split did not create any GGUF shards.");
  }
  return shards;
}

async function copyUpstreamLicense(files, destination) {
  const license = files.find((entry) => entry.type === "file" && /^licen[cs]e(?:\.[^/]+)?$/i.test(entry.path));
  if (!license) {
    return;
  }
  const url = `https://huggingface.co/${MODEL.owner}/${MODEL.repository}/raw/${MODEL.revision}/${license.path}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    fail(`Upstream license download failed with HTTP ${response.status}: ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(join(destination, basename(license.path)), { flags: "wx" }));
}

async function prepare() {
  await mkdir(cacheRoot, { recursive: true });
  const upstream = await upstreamModel();
  if (await verifyPrepared(outputDirectory)) {
    console.log(`Nimble shards are already verified at ${relative(root, outputDirectory)}.`);
    return;
  }

  const original = join(cacheRoot, MODEL.file);
  const modelUrl = `https://huggingface.co/${MODEL.owner}/${MODEL.repository}/resolve/${MODEL.revision}/${MODEL.file}?download=true`;
  await ensureDownloaded(modelUrl, original, upstream.size, upstream.sha256, `pinned ${MODEL.file}`);

  const splitter = await ensureSplitter();
  const stagingParent = join(cacheRoot, "staging");
  const staging = join(stagingParent, `nimble-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });

  try {
    const splitOutput = join(staging, MODEL.file);
    console.log("Splitting GGUF into verified shards no larger than 1 GiB…");
    await run(splitter, ["--split", "--split-max-size", "1G", original, splitOutput]);

    const names = await listShards(staging);
    const shards = [];
    let totalBytes = 0;
    for (const name of names) {
      const path = join(staging, name);
      const file = await stat(path);
      if (file.size > MAX_SHARD_BYTES) {
        fail(`${name} is ${file.size} bytes, exceeding the 1 GiB shard limit.`);
      }
      if (!(await ggufMagic(path))) {
        fail(`${name} does not start with the GGUF magic.`);
      }
      const sha256 = await hashFile(path);
      shards.push({ file: name, bytes: file.size, sha256 });
      totalBytes += file.size;
    }

    const manifest = {
      version: 1,
      modelId: MODEL.id,
      revision: MODEL.revision,
      quantization: MODEL.quantization,
      totalBytes,
      shards,
      license: MODEL.license,
      licenseSource: MODEL.licenseSource,
      source: MODEL.source,
    };
    await copyUpstreamLicense(upstream.files, staging);
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (!(await verifyPrepared(staging))) {
      fail("Staged Nimble output failed post-split verification.");
    }

    const replacement = `${outputDirectory}.previous-${process.pid}`;
    await rm(replacement, { recursive: true, force: true });
    if (await pathExists(outputDirectory)) {
      await rename(outputDirectory, replacement);
    }
    try {
      await mkdir(dirname(outputDirectory), { recursive: true });
      await rename(staging, outputDirectory);
      await rm(replacement, { recursive: true, force: true });
    } catch (error) {
      if (!(await pathExists(outputDirectory)) && (await pathExists(replacement))) {
        await rename(replacement, outputDirectory);
      }
      throw error;
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const manifest = await readManifest(outputDirectory);
  console.log(`Prepared ${manifest.shards.length} verified Nimble shards (${manifest.totalBytes.toLocaleString()} bytes) at ${relative(root, outputDirectory)}.`);
}

if (["--help", "-h"].includes(process.argv[2])) {
  console.log("Usage: npm run prepare:nimble\n\nDownloads the pinned Nimble GGUF, verifies Hugging Face LFS metadata, uses a checksum-verified official llama.cpp splitter, and atomically prepares standard GGUF shards no larger than 1 GiB in public/models/nimble/.");
} else {
  prepare().catch((error) => {
    console.error(`prepare:nimble: ${error.message}`);
    process.exitCode = 1;
  });
}
