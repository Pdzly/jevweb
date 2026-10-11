const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);

function isAppAsset(url) {
  return (
    url.origin === window.location.origin &&
    url.pathname.startsWith(baseUrl.pathname) &&
    !url.pathname.endsWith("/sw.js")
  );
}

function warmAppShell(registration) {
  const resources = performance
    .getEntriesByType("resource")
    .filter((entry) =>
      ["script", "link", "css", "img", "font", "other"].includes(entry.initiatorType),
    )
    .map((entry) => new URL(entry.name))
    .filter(isAppAsset)
    .map((url) => url.href);

  const manifestUrl = new URL("models/nimble/manifest.json", baseUrl).href;
  const urls = [...new Set([baseUrl.href, window.location.href, manifestUrl, ...resources])];
  registration.active?.postMessage({ type: "WARM_APP_SHELL", urls });
}

if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  const serviceWorkerReady = navigator.serviceWorker
    .register(`${baseUrl.pathname}sw.js`, { scope: baseUrl.pathname })
    .then(() => navigator.serviceWorker.ready);

  window.__jevServiceWorkerReady = serviceWorkerReady;
  serviceWorkerReady
    .then(warmAppShell)
    .catch(() => {
      // Offline support is optional; the application remains usable online.
    });
  window.addEventListener("load", () => {
    serviceWorkerReady.then(warmAppShell).catch(() => {
      // Offline support is optional; the application remains usable online.
    });
  });
}
