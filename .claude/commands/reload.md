---
description: Reload the unpacked Canvascope Chrome extension so on-disk changes take effect
---

Reload the Canvascope extension. Try these in order and stop at the first that works:

1. **CDP (only if Chrome was launched with `--remote-debugging-port=9222`)** — check with
   `curl -s --max-time 2 http://localhost:9222/json/version`. If reachable, find the
   Canvascope service-worker target via `http://localhost:9222/json` and reload the extension
   (navigate the service worker, or use the `Runtime.evaluate` CDP method to call
   `chrome.runtime.reload()`).

2. **In-extension reload trigger** — the background worker (`background.js`) listens for:
   - a runtime message `{ type: 'csReloadExtension' }`, and
   - a new value written to `chrome.storage.local` key `__canvascopeDevReload`.
   Either triggers `chrome.runtime.reload()`. Reach this from any extension page (side panel,
   popup) via the Chrome MCP, e.g. open `chrome-extension://<id>/popup.html` and run
   `chrome.storage.local.set({ __canvascopeDevReload: Date.now() })`.
   **Note:** this only works once the background worker carrying these handlers is already
   loaded (i.e. after the first reload that installs them).

3. **Manual fallback** — if neither path is available, tell the user the exact steps:
   `chrome://extensions` → Reload the Canvascope card → refresh any open LMS tab → reopen the
   side panel. (Required at least once to install the reload handlers above.)

After reloading, remind the user that content-script changes also need the LMS tab refreshed.
