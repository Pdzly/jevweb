const CACHE_NAME = "jev-app-shell-v1";
const MODEL_FILE_PATTERN = /\.(?:bin|gguf|safetensors|params)$/i;

function isAppUrl(url) {
  const scope = new URL(self.registration.scope);

  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith(scope.pathname) &&
    !url.pathname.endsWith("/sw.js") &&
    !MODEL_FILE_PATTERN.test(url.pathname)
  );
}

const APP_ASSET_DESTINATIONS = new Set([
  "script",
  "style",
  "worker",
  "sharedworker",
  "font",
  "image",
]);

function isCacheableRequest(request) {
  const url = new URL(request.url);

  return (
    request.method === "GET" &&
    isAppUrl(url) &&
    (request.mode === "navigate" ||
      APP_ASSET_DESTINATIONS.has(request.destination) ||
      url.pathname.endsWith(".wasm") ||
      url.pathname.endsWith("/models/nimble/manifest.json"))
  );
}

function nimbleManifestUrl() {
  return new URL("models/nimble/manifest.json", self.registration.scope);
}

function isNimbleShardUrl(url) {
  const shardDirectory = new URL("models/nimble/", self.registration.scope);

  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith(shardDirectory.pathname) &&
    url.pathname.endsWith(".gguf")
  );
}

async function nimbleShardSize(url) {
  const cache = await caches.open(CACHE_NAME);
  const manifestUrl = nimbleManifestUrl();
  const manifestResponse = await cache.match(manifestUrl);

  if (!manifestResponse?.ok) return null;

  try {
    const manifest = await manifestResponse.json();
    const shard = manifest.shards?.find(
      (entry) =>
        typeof entry?.file === "string" &&
        new URL(entry.file, manifestUrl).href === url.href,
    );

    return Number.isSafeInteger(shard?.bytes) && shard.bytes > 0 ? shard.bytes : null;
  } catch {
    return null;
  }
}

async function fetchNimbleShard(request) {
  const response = await fetch(request);

  if (response.status !== 200 || !response.body || response.headers.has("content-length")) {
    return response;
  }

  const size = await nimbleShardSize(new URL(request.url));
  if (!size) return response;

  const headers = new Headers(response.headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(size));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cacheAppShellUrls(urls) {
  const cache = await caches.open(CACHE_NAME);

  await Promise.all(
    urls
      .map((value) => new URL(value, self.location.origin))
      .filter(isAppUrl)
      .map(async (url) => {
        try {
          const request = new Request(url, { credentials: "same-origin" });
          const response = await fetch(request);

          if (response.ok && response.type === "basic") {
            await cache.put(request, response.clone());
          }
        } catch {
          // A failed warm-up fetch remains available on the next online visit.
        }
      }),
  );
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "WARM_APP_SHELL" && Array.isArray(event.data.urls)) {
    event.waitUntil(cacheAppShellUrls(event.data.urls));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === "GET" && !request.headers.has("range") && isNimbleShardUrl(url)) {
    event.respondWith(fetchNimbleShard(request));
    return;
  }

  if (!isCacheableRequest(request)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      try {
        const response = await fetch(request);

        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }

        return response;
      } catch {
        return (
          (await cache.match(request, { ignoreSearch: request.mode === "navigate" })) ||
          (request.mode === "navigate" && (await cache.match(new URL(self.registration.scope)))) ||
          Response.error()
        );
      }
    })(),
  );
});
