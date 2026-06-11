/**
 * Canvascope v10 — Shared AI route.
 * One place that owns the local-first (Chrome Prompt API / Gemini Nano) →
 * cloud-fallback (Supabase gemini-proxy) decision the v8 sidepanel pioneered,
 * so Chat, Course Brain, Smart Planner, and Quiz all ride the same path.
 *
 * No provider change: local is LocalAIController.promptStream(), cloud is
 * LocalAIController.streamSupabaseProxy(). This module only centralizes the
 * routing, session lifecycle, and chunk normalization.
 *
 * Routes ('mode'): 'local' | 'cloud' | 'local-download' | null (blocked).
 */
(() => {
  const listeners = new Set();

  const state = {
    mode: null,            // 'local' | 'cloud' | 'local-download' | null
    ready: false,          // a stream call can succeed right now
    cloudAvailable: false, // signed in, so claude-proxy/gemini-proxy reachable
    availability: null,    // raw capability result for diagnostics
    systemInstruction: ''
  };

  let controller = null;

  function emit() {
    listeners.forEach((fn) => {
      try { fn({ ...state }); } catch (_) { /* listener errors are not ours */ }
    });
  }

  function setState(patch) {
    Object.assign(state, patch);
    emit();
  }

  async function checkAuthSignedIn() {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'checkAuthStatus' }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { signedIn: false });
      });
    });
    return !!res.signedIn;
  }

  /**
   * Capability-check and pick the route. Mirrors the v8 sidepanel bootstrap:
   * local available → start session; downloadable/downloading → defer download
   * to first submit; unavailable → cloud fallback if signed in.
   */
  async function init(systemInstruction = '') {
    controller = controller || new LocalAIController();
    setState({ systemInstruction, mode: null, ready: false });

    const [availability, cloudAvailable] = await Promise.all([
      controller.checkCapabilities(),
      checkAuthSignedIn()
    ]);
    setState({ availability, cloudAvailable });

    if (availability === 'available') {
      const ok = await controller.initSession(systemInstruction);
      if (ok) {
        setState({ mode: 'local', ready: true });
        return { ...state };
      }
      // Session container failed — try the cloud before giving up.
    } else if (availability === 'downloadable' || availability === 'downloading') {
      setState({ mode: 'local-download', ready: false });
      return { ...state };
    }

    if (state.cloudAvailable) {
      setState({ mode: 'cloud', ready: true });
    } else {
      setState({ mode: null, ready: false });
    }
    return { ...state };
  }

  /**
   * Make sure a stream call can succeed. In 'local-download' mode this kicks
   * off the on-device model download (surfaced via onDownloadProgress) and
   * falls back to cloud (auth permitting) when setup fails.
   */
  async function ensureReady({ onDownloadProgress = null } = {}) {
    if (state.ready) return { ok: true, ...state };
    if (state.mode !== 'local-download') return { ok: false, ...state };

    const ok = await controller.initSession(state.systemInstruction, onDownloadProgress);
    if (ok) {
      setState({ mode: 'local', ready: true });
      return { ok: true, ...state };
    }

    if (await checkAuthSignedIn()) {
      setState({ mode: 'cloud', ready: true, cloudAvailable: true });
      return { ok: true, ...state };
    }

    setState({ mode: null, ready: false, cloudAvailable: false });
    return { ok: false, ...state };
  }

  /**
   * Stream an answer as **delta** chunks (accumulated-chunk replays from the
   * Prompt API are normalized here so consumers can just append).
   * `system` only applies on the cloud route; the local session's system
   * prompt is fixed at init, so callers bake task framing into `prompt`.
   * Passing `corpus` forces the Claude Fable 5 cloud route (1M context +
   * prompt caching) even when the on-device route is active — it's the only
   * route that can hold a whole course at once.
   */
  async function* stream(prompt, { system, corpus, maxTokens } = {}) {
    const wantClaude = !!corpus && state.cloudAvailable;
    if (!state.ready && !wantClaude) {
      throw new Error('AI route not ready. Call AIRouter.ensureReady() first.');
    }

    const source = wantClaude
      ? controller.streamClaudeProxy(prompt, system || state.systemInstruction, corpus, maxTokens)
      : state.mode === 'cloud'
        ? controller.streamSupabaseProxy(prompt, system || state.systemInstruction)
        : controller.promptStream(prompt);

    let full = '';
    for await (const chunk of source) {
      let delta;
      if (full && chunk.startsWith(full)) {
        delta = chunk.slice(full.length); // accumulated replay
        full = chunk;
      } else {
        delta = chunk;                    // true delta
        full += chunk;
      }
      if (delta) yield delta;
    }
  }

  /** Collect the full streamed answer as one string. */
  async function complete(prompt, { system, onToken } = {}) {
    let full = '';
    for await (const delta of stream(prompt, { system })) {
      full += delta;
      if (onToken) onToken(delta, full);
    }
    return full;
  }

  window.AIRouter = {
    init,
    ensureReady,
    stream,
    complete,
    getState: () => ({ ...state }),
    onStateChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
