// Runs litert-community/Gemma3-1B-IT (LiteRT int4) fully inside the user's browser
// through the MediaPipe LLM Inference API (WebGPU). The .task weights are streamed
// from Hugging Face, stored in the Cache API, and handed to the runtime either as a
// Blob URL or as a raw buffer. This file is imported as a raw string and started as a
// module Web Worker from a Blob URL, so @mediapipe/tasks-genai is loaded straight
// from the CDN (never bundled).
//
// IMPORTANT: nothing here may throw at the top level. A crashed worker is silent —
// the UI would hang forever with no download and no error — so the runtime import
// happens lazily inside the load handler and every failure is posted back to the
// main thread.

const GENAI_PKG = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.30";
const GENAI_WASM = GENAI_PKG + "/wasm";

const post = (msg) => self.postMessage(msg);

/* --- module-worker polyfill ------------------------------------------- */
// MediaPipe's wasm glue loads its loader script with importScripts(). In module
// workers (this worker is started as `type: "module"` from a Blob URL) Chrome
// defines importScripts but calling it throws TypeError, so the glue falls back
// to a dynamic import() that evaluates the loader as an ESM module -> its
// `var ModuleFactory` stays module-scoped -> "ModuleFactory not set." (upstream
// issue google-ai-edge/mediapipe#5257). This file only ever runs as a module
// worker, so unconditionally replace importScripts with a faithful shim:
// synchronous XHR + indirect eval, exactly like a classic worker's importScripts.
try {
  globalThis.importScripts = (...urls) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false); // synchronous — same contract as real importScripts
      xhr.overrideMimeType("text/javascript");
      xhr.send();
      if (xhr.status !== 200 && xhr.status !== 0) {
        throw new Error("importScripts polyfill failed for " + url + " (HTTP " + xhr.status + ")");
      }
      (0, eval)(xhr.responseText); // indirect eval -> executes in the worker's global scope
    }
  };
} catch {
  /* never let the polyfill kill the worker */
}

// Uncaught errors inside a worker are invisible to the UI unless we report them.
self.addEventListener("error", (e) => {
  post({ type: "error", message: "Worker crashed: " + ((e && e.message) || "unknown error") });
});
self.addEventListener("unhandledrejection", (e) => {
  post({ type: "error", message: "Worker task failed: " + (((e && e.reason) && e.reason.message) || e.reason || "unknown reason") });
});

/* --- lazy runtime import ---------------------------------------------- */
// The CDN import used to sit at the top level; if it failed (flaky mobile network,
// DNS hiccup, blocked CDN) the worker died silently and no download ever started.
let genai = null;
async function ensureGenai() {
  if (!genai) {
    try {
      genai = await import(GENAI_PKG);
    } catch (err) {
      throw new Error(
        "Could not load the inference runtime from the CDN (" +
          ((err && err.message) || err) +
          "). Check your internet connection and reload.",
      );
    }
  }
  return genai;
}

// The official litert-community repo is license-gated on Hugging Face (anonymous
// fetches always get 401), so the ungated mirror of the very same int4 weights is
// tried FIRST; the official URLs stay as fallbacks in case the mirror disappears.
const SOURCES = [
  "https://huggingface.co/aquhm/gemma3-1b-it-int4-litert/resolve/main/gemma3-1b-it-int4.task",
  "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4-web.task",
  "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.task",
];

const CACHE_NAME = "transformers-cache";
const APPROX_SIZE = 554_661_243; // bytes of the mirror's int4 .task (progress fallback before Content-Length is known)
const MAX_TOKENS = 1280; // KV-cache budget of the 1B model; prompts are trimmed to fit
const STALL_MS = 60_000; // abort a source when no bytes arrive for this long

let llm = null;
let runtimeTemp = null;
let weightsUrl = null; // Blob URL of the downloaded .task (disk-backed, reusable for re-init)
let interrupted = false;

/* ------------------------------------------------------------------ */
/* Weight provisioning (streaming download + Cache API)                */
/* ------------------------------------------------------------------ */

async function openCache() {
  try {
    if ("caches" in self) return await caches.open(CACHE_NAME);
  } catch {
    /* ignore */
  }
  return null;
}

/** fetch() with a connect timeout; returns the response or throws. */
async function connect(url, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("connection timed out")), timeoutMs);
  // Chrome 116+ (the app already requires Chrome 121+ for WebGPU).
  const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  try {
    return await fetch(url, { mode: "cors", signal: combined });
  } finally {
    clearTimeout(timer);
  }
}

/** Streams the .task file to disk-backed storage and returns a Blob URL. */
async function fetchWeights() {
  const cache = await openCache();
  let lastErr = null;

  for (const url of SOURCES) {
    const ctrl = new AbortController();
    let watchdog = null;
    try {
      post({ type: "status", text: "Connecting to " + new URL(url).hostname + " …" });
      const res = await connect(url, 30_000, ctrl.signal);
      if (!res.ok || !res.body) {
        throw new Error("HTTP " + res.status + (res.status === 401 || res.status === 403 ? " (license-gated — trying next source)" : ""));
      }

      const total = +res.headers.get("content-length") || APPROX_SIZE;
      const name = url.split("/").pop() || "model.task";

      // Persist a clean (non-redirected) copy in the Cache API while streaming.
      let body = res.body;
      if (cache) {
        const [toCache, toMemory] = res.body.tee();
        body = toMemory;
        cache
          .put(url, new Response(toCache, { status: 200, headers: { "content-type": "application/octet-stream" } }))
          .catch(() => {});
      }

      const reader = body.getReader();
      const chunks = [];
      let loaded = 0;
      post({ type: "status", text: "Streaming " + name });
      // Stall watchdog: abort this source when no bytes arrive for STALL_MS.
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(
          () => ctrl.abort(new Error("download stalled (no data for " + STALL_MS / 1000 + "s)")),
          STALL_MS,
        );
      };

      while (true) {
        armWatchdog();
        let done, value;
        try {
          ({ done, value } = await reader.read());
        } finally {
          clearTimeout(watchdog);
        }
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        post({ type: "progress", loaded, total, file: name });
      }

      if (weightsUrl) URL.revokeObjectURL(weightsUrl);
      weightsUrl = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
      chunks.length = 0;
      return weightsUrl;
    } catch (err) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
      lastErr = err;
      post({ type: "status", text: "Source failed — " + ((err && err.message) || err) });
    }
  }
  throw new Error("Could not download the model weights: " + ((lastErr && lastErr.message) || "all sources failed"));
}

/** Loads the weights, preferring the browser cache (works offline). */
async function getWeights() {
  const cache = await openCache();
  if (cache) {
    for (const url of SOURCES) {
      const hit = await cache.match(url).catch(() => null);
      if (hit) {
        post({ type: "status", text: "Reading weights from browser cache" });
        const blob = await hit.blob();
        if (weightsUrl) URL.revokeObjectURL(weightsUrl);
        weightsUrl = URL.createObjectURL(blob);
        post({ type: "progress", loaded: blob.size, total: blob.size, file: url.split("/").pop() || "model.task" });
        return weightsUrl;
      }
    }
  }
  return fetchWeights();
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

async function initRuntime(temperature) {
  post({ type: "status", text: "Initializing MediaPipe WebGPU runtime" });
  const { FilesetResolver, LlmInference } = await ensureGenai();

  // The importScripts polyfill above makes this work inside a module worker.
  const fileset = await FilesetResolver.forGenAiTasks(GENAI_WASM);

  // Belt & braces: if the glue hasn't loaded the wasm loader yet (any path that
  // skips importScripts), eval it manually so globalThis.ModuleFactory is set,
  // then remove wasmLoaderPath so createFromOptions doesn't try to reload it.
  if (!globalThis.ModuleFactory && fileset.wasmLoaderPath) {
    post({ type: "status", text: "Loading runtime glue manually" });
    const res = await fetch(fileset.wasmLoaderPath);
    (0, eval)(await res.text());
    delete fileset.wasmLoaderPath;
  }

  // Preferred path: hand the runtime a Blob URL (disk-backed, memory friendly).
  // Fallback: assemble a Uint8Array buffer if the Blob path is rejected.
  try {
    llm = await LlmInference.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: weightsUrl },
      maxTokens: MAX_TOKENS,
      temperature,
      topK: 40,
    });
  } catch (err) {
    post({ type: "status", text: "Blob path failed — loading weights into memory instead" });
    const blob = await (await fetch(weightsUrl)).blob();
    const buffer = new Uint8Array(await blob.arrayBuffer());
    llm = await LlmInference.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: buffer },
      maxTokens: MAX_TOKENS,
      temperature,
      topK: 40,
    });
  }
  runtimeTemp = temperature;
}

async function handleLoad() {
  // The LiteRT web runtime is WebGPU-only; there is no WASM fallback.
  try {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser. Gemma3-1B (LiteRT) needs Chrome/Edge 121+ (desktop or Android) or Safari 26+.");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter found — hardware acceleration may be disabled in the browser settings.");

    post({ type: "status", text: "Preparing to download Gemma3-1B (~555 MB)" });
    await ensureGenai(); // fail fast (with a visible error) if the CDN is unreachable
    await getWeights();
    await initRuntime(0.4);
    post({ type: "ready", device: "webgpu" });
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
}

/* ------------------------------------------------------------------ */
/* Prompt building (Gemma 3 chat template)                             */
/* ------------------------------------------------------------------ */

function buildPrompt(messages, maxNewTokens) {
  const cost = (t) => Math.ceil((t || "").length / 3.6) + 8;
  const budget = MAX_TOKENS - Math.min(maxNewTokens || 256, 1024) - 64;

  // Always keep the first message (it carries the persona/system instruction),
  // then fill the remaining budget from the newest turns backwards.
  const kept = [messages[0]];
  let used = cost(messages[0].text) + 12;
  for (let i = messages.length - 1; i >= 1; i--) {
    const c = cost(messages[i].text);
    if (used + c > budget) continue;
    kept.splice(1, 0, messages[i]);
    used += c;
  }

  // Build the Gemma 3 template, merging adjacent same-role turns (trimming can
  // break strict user/model alternation).
  let prompt = "";
  let lastRole = "";
  for (const m of kept) {
    const role = m.role === "assistant" ? "model" : "user";
    if (role !== lastRole) {
      if (lastRole) prompt += "<end_of_turn>\n";
      prompt += `<start_of_turn>${role}\n`;
      lastRole = role;
    }
    prompt += m.text + "\n";
  }
  prompt += "<end_of_turn>\n<start_of_turn>model\n";
  return prompt;
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

const STOP_RE = /<end_of_turn>|<start_of_turn>/;
const STOP_MARKERS = ["<end_of_turn>", "<start_of_turn>"];

/** Length of the longest suffix of `raw` that could be the beginning of a stop marker. */
function holdback(raw) {
  let hold = 0;
  for (const m of STOP_MARKERS) {
    for (let k = Math.min(m.length, raw.length); k > hold; k--) {
      if (raw.endsWith(m.slice(0, k))) {
        hold = k;
        break;
      }
    }
  }
  return hold;
}

async function handleGenerate(data) {
  const { id, messages, maxNewTokens, temperature } = data;
  try {
    if (!llm) throw new Error("Model is not loaded yet.");

    // MediaPipe fixes sampling at creation; re-create the runtime (weights come
    // from the browser cache, so this is quick) only when the setting changed.
    if (Math.abs((temperature ?? 0.4) - runtimeTemp) > 0.001) {
      post({ type: "status", text: "Applying new sampling settings" });
      await getWeights();
      await initRuntime(temperature ?? 0.4);
    }

    const prompt = buildPrompt(messages, maxNewTokens);
    interrupted = false;

    let raw = "";
    let sent = "";
    let stopped = false;
    const started = performance.now();

    const postDelta = () => {
      const clean = raw.split(STOP_RE)[0];
      // Hold back a trailing partial stop-marker (e.g. "<end_") until it resolves.
      const allowed = stopped ? clean.length : clean.length - holdback(raw);
      if (allowed > sent.length) {
        const delta = clean.slice(sent.length, allowed);
        sent = clean.slice(0, allowed);
        post({ type: "token", id, text: delta });
      }
    };

    await new Promise((resolve) => {
      llm.generateResponse(prompt, (partial, complete) => {
        raw += partial || "";
        postDelta();
        if (!stopped && STOP_RE.test(raw)) {
          stopped = true;
          if (typeof llm.cancelGenerateResponse === "function") llm.cancelGenerateResponse();
        }
        if (complete) resolve();
      });
    });

    const secs = (performance.now() - started) / 1000;
    post({
      type: "done",
      id,
      text: sent.trim(),
      // MediaPipe exposes no token counts — estimate from characters (≈3.6 chars/token).
      tps: secs > 0 ? Math.max(1, Math.round(sent.length / 3.6)) / secs : 0,
      interrupted: interrupted,
    });
  } catch (err) {
    post({ type: "gen-error", id, message: String((err && err.message) || err) });
  }
}

self.addEventListener("message", (e) => {
  const data = e.data;
  try {
    if (data.type === "load") handleLoad(data.device);
    else if (data.type === "generate") handleGenerate(data);
    else if (data.type === "interrupt") {
      interrupted = true;
      if (llm && typeof llm.cancelGenerateResponse === "function") {
        try {
          llm.cancelGenerateResponse();
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
});
