#!/usr/bin/env node
/**
 * Rebuilds the vendored Memory64 Wllama runtime used by this project.
 *
 * Why: the upstream 3.8.1 default runtime caps its growable Memory64 at 4 GiB,
 * below Nimble 9B's CPU weight buffer. This rebuild keeps upstream WebGPU and
 * CPU paths intact while raising only the default Memory64 maximum to 16 GiB;
 * the separately built 32-bit compatibility runtime remains capped at 4 GiB.
 *
 * Usage: npm run build:wllama-memory64
 * Requires Docker. It checks out immutable upstream/llama.cpp commits, uses
 * the pinned Emscripten image digest and verifies the pinned Dawn archive SHA-256.
 * It writes vendor/wllama-wllama-3.8.1-jev.1.tgz and provenance metadata.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = resolve(projectRoot, 'vendor');
const patchPath = resolve(vendorDir, 'wllama-memory64-16gb.patch');
const provenancePath = resolve(vendorDir, 'wllama-memory64-16gb.provenance.json');
const sourceDir = resolve(projectRoot, '.cache/wllama-3.8.1-memory64-build');
const artifactName = 'wllama-wllama-3.8.1-jev.2.tgz';
const artifactPath = resolve(vendorDir, artifactName);
const reuseWasm = process.argv.includes('--reuse-wasm');

const provenance = {
  package: '@wllama/wllama',
  version: '3.8.1-jev.2',
  artifact: `vendor/${artifactName}`,
  upstream: {
    repository: 'https://github.com/ngxson/wllama.git',
    commit: 'b68fd6427063266176bb0054befe9ff70b3258f1',
    llamaCppCommit: '46ca246de9bb1c35269722a6240d37d9dfd79cad',
  },
  build: {
    emscriptenImage: 'emscripten/emsdk@sha256:33e992367f721747d8008c9141c04fa017139e3557a60e0c80be93a0870fe462',
    dawnArchive: 'https://github.com/google/dawn/releases/download/v20260317.182325/emdawnwebgpu_pkg-v20260317.182325.zip',
    dawnArchiveSha256: '8dcae86c630d76b6794b271c6572becba36f4237d132bee121a56638c3d76575',
  },
  runtime: {
    default: { memoryModel: 'Memory64', maximumMemory: '16384MB' },
    compat: { memoryModel: 'wasm32', maximumMemory: '4096MB' },
  },
};

if (process.argv.includes('--help')) {
  console.log('Usage: npm run build:wllama-memory64 [-- --reuse-wasm]');
  console.log('Rebuilds the pinned Wllama 3.8.1 Memory64 16 GiB vendor tarball with Docker.');
  console.log('--reuse-wasm rebuilds the paired JS bundle from the retained matching WASM artifacts.');
  process.exit(0);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
}

function readRevision(repository) {
  return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

mkdirSync(vendorDir, { recursive: true });
if (reuseWasm) {
  if (!existsSync(resolve(sourceDir, 'src/wasm/wllama.wasm'))) {
    throw new Error('--reuse-wasm requires a previous pinned runtime build with its default WASM artifact.');
  }
} else {
  rmSync(sourceDir, { recursive: true, force: true });
  run('git', ['clone', '--filter=blob:none', '--no-checkout', provenance.upstream.repository, sourceDir]);
  run('git', ['-C', sourceDir, 'checkout', '--detach', provenance.upstream.commit]);
  run('git', ['-C', sourceDir, 'submodule', 'update', '--init', '--recursive']);

  if (readRevision(sourceDir) !== provenance.upstream.commit) {
    throw new Error('Checked-out Wllama revision does not match the pinned commit.');
  }
  if (readRevision(resolve(sourceDir, 'llama.cpp')) !== provenance.upstream.llamaCppCommit) {
    throw new Error('Checked-out llama.cpp revision does not match the pinned commit.');
  }
  const dockerSecurityOptions = execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
    encoding: 'utf8',
  });
  const dockerUser = dockerSecurityOptions.includes('name=rootless')
    ? { D_UID: '0', D_GID: '0' }
    : {};

  run('git', ['-C', sourceDir, 'apply', '--check', patchPath]);
  run('git', ['-C', sourceDir, 'apply', patchPath]);
  run('npm', ['ci', '--ignore-scripts'], { cwd: sourceDir });
  run('npm', ['run', 'build:wasm'], {
    cwd: sourceDir,
    env: {
      ...process.env,
      ...dockerUser,
      EMDAWN_SHA256: provenance.build.dawnArchiveSha256,
    },
  });
}
run('npm', ['run', 'build'], { cwd: sourceDir });

const expectedMemory64Maximum = 'maximum:262144n';
for (const file of ['src/wasm/wllama.js', 'src/workers-code/generated.ts', 'esm/index.js']) {
  if (!readFileSync(resolve(sourceDir, file), 'utf8').includes(expectedMemory64Maximum)) {
    throw new Error(`${file} does not embed the expected 16 GiB Memory64 maximum.`);
  }
}
const expectedThreadedMaximum = 'isCompat ? 4096 : 16384';
for (const file of ['src/workers-code/generated.ts', 'esm/index.js']) {
  if (!readFileSync(resolve(sourceDir, file), 'utf8').includes(expectedThreadedMaximum)) {
    throw new Error(`${file} does not embed the conditional 16 GiB threaded Memory64 maximum.`);
  }
}


if (existsSync(artifactPath)) unlinkSync(artifactPath);
const packedJson = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', vendorDir], {
  cwd: sourceDir,
  encoding: 'utf8',
}));
const packed = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
if (!packed || typeof packed !== 'object' || !('filename' in packed)) {
  throw new Error('npm pack did not report the generated runtime tarball.');
}
const generatedArtifact = resolve(vendorDir, packed.filename);
if (generatedArtifact !== artifactPath) renameSync(generatedArtifact, artifactPath);

provenance.artifactSha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
