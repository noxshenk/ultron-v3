import workerSource from "../worker/model.worker.js?raw";

/** Spawns the inference worker from a Blob (transformers.js is imported from the CDN inside it). */
function createWorker(): Worker {
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  return new Worker(url, { type: "module" });
}

export type Device = "webgpu" | "wasm";

/** litert-community/Gemma3-1B-IT (LiteRT int4, MediaPipe LLM Inference, WebGPU). */
export const MODEL_NAME = "Gemma3-1B-IT";
export const MODEL_SIZE_MB: Record<Device, number> = { webgpu: 554.7, wasm: 554.7 };

const CACHE_FILES = ["gemma3-1b-it-int4-web.task", "gemma3-1b-it-int4.task"];

/** Returns "webgpu" when WebGPU is usable, otherwise null (the LiteRT runtime has no WASM fallback). */
export async function detectDevice(): Promise<Device | null> {
  try {
    const gpu = (navigator as any).gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function isModelCached(_device: Device): Promise<boolean> {
  try {
    if (!("caches" in window)) return false;
    const cache = await caches.open("transformers-cache");
    const keys = (await cache.keys()).map((r) => r.url);
    return CACHE_FILES.some((f) => keys.some((u) => u.includes(f)));
  } catch {
    return false;
  }
}

export async function clearModelCache() {
  try {
    await caches.delete("transformers-cache");
  } catch {
    /* ignore */
  }
}

export async function requestPersistentStorage() {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
}

export interface LoadHandlers {
  onProgress: (loaded: number, total: number, file: string) => void;
  onStatus: (text: string) => void;
}

export interface GenerateArgs {
  messages: { role: "user" | "assistant"; text: string }[];
  maxNewTokens: number;
  temperature: number;
  onToken: (text: string) => void;
}

export interface GenerateResult {
  text: string;
  tps: number;
  interrupted: boolean;
}

class ModelClient {
  private worker: Worker | null = null;
  private nextId = 1;
  ready = false;
  loading = false;

  private ensureWorker() {
    if (!this.worker) this.worker = createWorker();
    return this.worker;
  }

  /** Terminates the worker and frees GPU/CPU memory. */
  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.loading = false;
  }

  load(device: Device, h: LoadHandlers): Promise<Device> {
    const worker = this.ensureWorker();
    this.loading = true;
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        worker.removeEventListener("message", onMsg);
        worker.onerror = null;
        worker.onmessageerror = null;
        this.loading = false;
        reject(new Error(message));
      };
      const onMsg = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === "progress") h.onProgress(m.loaded, m.total, m.file);
        else if (m.type === "status") h.onStatus(m.text);
        else if (m.type === "ready") {
          worker.removeEventListener("message", onMsg);
          worker.onerror = null;
          worker.onmessageerror = null;
          this.ready = true;
          this.loading = false;
          resolve(m.device as Device);
        } else if (m.type === "error") {
          fail(m.message);
        }
      };
      // A crashed worker never posts messages — without these the UI would hang forever.
      worker.onerror = (e) => {
        e.preventDefault();
        fail((e as ErrorEvent).message || "The inference worker crashed unexpectedly.");
      };
      worker.onmessageerror = () => fail("The inference worker returned a malformed message.");
      worker.addEventListener("message", onMsg);
      worker.postMessage({ type: "load", device });
    });
  }

  generate(args: GenerateArgs): Promise<GenerateResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === "token") args.onToken(m.text);
        else if (m.type === "done") {
          worker.removeEventListener("message", onMsg);
          resolve({ text: m.text, tps: m.tps, interrupted: m.interrupted });
        } else if (m.type === "gen-error") {
          worker.removeEventListener("message", onMsg);
          reject(new Error(m.message));
        }
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({
        type: "generate",
        id,
        messages: args.messages,
        maxNewTokens: args.maxNewTokens,
        temperature: args.temperature,
      });
    });
  }

  interrupt() {
    this.worker?.postMessage({ type: "interrupt" });
  }
}

export const modelClient = new ModelClient();
