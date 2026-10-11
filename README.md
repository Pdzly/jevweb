# JEV

A browser-local decision workspace powered by Wllama. Evaluate source text against typed questions and get values with probabilities—without a backend inference service.

## Run locally

Requires Node.js 20.19+ (20.x) or 22.12+ and npm.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. Paste source text, load a model, configure your questions, and select **Evaluate**. Results can be copied or exported.

Inference runs on-device; the first model download needs internet. Workspace inputs stay in memory.

## Build

```sh
npm run build
npm run preview
```

The production build is written to `dist/`. When hosting, serve over HTTPS and configure cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`); Vite supplies these locally.
