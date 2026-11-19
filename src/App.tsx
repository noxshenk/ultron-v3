import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Orb, { type OrbMode } from "./components/Orb";
import {
  ContextModal,
  HeaderInstallButton,
  HistoryModal,
  Icon,
  ProfileModal,
  PwaInstallPrompt,
  SettingsModal,
  SetupModal,
  type ModelState,
} from "./components/Modals";
import {
  DEFAULT_SETTINGS,
  PERSONAS,
  loadActiveSession,
  loadProfile,
  loadSessions,
  loadSettings,
  saveActiveSession,
  saveProfile,
  saveSessions,
  saveSettings,
  uid,
  type ChatMessage,
  type Persona,
  type Profile,
  type Session,
  type Settings,
} from "./lib/store";
import {
  MODEL_SIZE_MB,
  clearModelCache,
  detectDevice,
  isModelCached,
  modelClient,
  requestPersistentStorage,
  type Device,
} from "./lib/modelClient";
import {
  chirp,
  createRecognizer,
  exportDocx,
  exportMarkdown,
  exportPdf,
  speak,
  speechRecognitionSupported,
  stopSpeaking,
  ttsSupported,
} from "./lib/services";

const ACCENTS: Record<Persona, { accent: string; secondary: string }> = {
  ultron: { accent: "#ff2238", secondary: "#c50c1f" },
  jarvis: { accent: "#00d2ff", secondary: "#3b82f6" },
  friday: { accent: "#ffcc00", secondary: "#f59e0b" },
};

const SUGGESTIONS = [
  "Introduce yourself in two sentences",
  "Explain how WebGPU works, briefly",
  "Give me 3 productivity tips",
  "Write a short poem about stars",
];

const EQ_HEIGHTS = ["h-2", "h-4", "h-7", "h-10", "h-12", "h-8", "h-11"];
function EqBars({ mirror }: { mirror?: boolean }) {
  const hs = mirror ? [...EQ_HEIGHTS].reverse() : EQ_HEIGHTS;
  return (
    <>
      {hs.map((h, i) => {
        const peak = mirror ? i === 0 : i === hs.length - 1;
        return (
          <div
            key={i}
            className={`w-1.5 rounded-full eq-bar ${h} ${peak ? "bg-white shadow-[0_0_14px_#ffffff]" : "dyn-accent-bg"}`}
            style={{ animationDelay: `${[0.05, 0.18, 0.11, 0.22, 0.15, 0.08, 0.25][i]}s`, opacity: peak ? 1 : 0.45 + (i / hs.length) * 0.5 }}
          />
        );
      })}
    </>
  );
}

const DEFAULT_PROFILE: Profile = {
  name: "Operator",
  email: "operator@local.device",
  provider: "local",
  createdAt: Date.now(),
};

export default function App() {
  const [profile, setProfile] = useState<Profile>(() => ({ ...DEFAULT_PROFILE, ...(loadProfile() || {}) }));
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...loadSettings() }));
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeId, setActiveId] = useState<string>(() => {
    const saved = loadActiveSession();
    const list = loadSessions();
    return saved && list.some((s) => s.id === saved) ? saved : uid();
  });

  const [model, setModel] = useState<ModelState>({
    phase: "checking",
    device: "webgpu",
    cached: false,
    loaded: 0,
    total: 0,
    bandwidth: 0,
    eta: null,
    status: "",
  });

  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [toast, setToast] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [storageText, setStorageText] = useState("");

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const recRef = useRef<ReturnType<typeof createRecognizer> | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const booted = useRef(false);
  const bw = useRef({ t: 0, loaded: 0, ema: 0 });

  const persona = PERSONAS[settings.persona] || PERSONAS.jarvis;
  const current = sessions.find((s) => s.id === activeId);
  const messages = current?.messages ?? [];
  const asr = speechRecognitionSupported();
  const tts = ttsSupported();

  /* ---------- helpers ---------- */
  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3800);
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);

  const updateSession = useCallback((sid: string, fn: (msgs: ChatMessage[]) => ChatMessage[], title?: string) => {
    setSessions((prev) => {
      const existing = prev.find((s) => s.id === sid);
      if (existing) {
        return prev.map((s) =>
          s.id === sid ? { ...s, messages: fn(s.messages), updatedAt: Date.now(), title: s.title || title || s.title } : s,
        );
      }
      return [{ id: sid, title: title || "", createdAt: Date.now(), updatedAt: Date.now(), messages: fn([]) }, ...prev];
    });
  }, []);

  /* ---------- theme ---------- */
  useEffect(() => {
    document.body.classList.remove("mode-ultron", "mode-jarvis", "mode-friday");
    document.body.classList.add(`mode-${settings.persona}`, "bg-grid-vantix");
    saveSettings(settings);
  }, [settings]);

  /* ---------- persistence ---------- */
  useEffect(() => {
    saveSessions(
      sessions
        .filter((s) => s.messages.length > 0)
        .map((s) => ({ ...s, messages: s.messages.filter((m) => !(m.role === "assistant" && !m.text && !m.error)) })),
    );
  }, [sessions]);
  useEffect(() => saveActiveSession(activeId), [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, generating]);

  /* ---------- voices ---------- */
  useEffect(() => {
    if (!tts) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [tts]);

  /* ---------- model loading ---------- */
  const startLoad = useCallback(async (device: Device, fromCache: boolean) => {
    bw.current = { t: performance.now(), loaded: 0, ema: 0 };
    setModel((m) => ({
      ...m,
      device,
      phase: fromCache ? "loading" : "downloading",
      loaded: 0,
      total: MODEL_SIZE_MB[device] * 1e6,
      bandwidth: 0,
      eta: null,
      error: undefined,
      status: fromCache ? "Reading weights from browser cache" : "Connecting to Hugging Face",
    }));
    requestPersistentStorage();
    try {
      const used = await modelClient.load(device, {
        onProgress: (loaded, total) => {
          const now = performance.now();
          const b = bw.current;
          if (now - b.t > 400) {
            const inst = ((loaded - b.loaded) / (now - b.t)) * 1000;
            b.ema = b.ema ? b.ema * 0.6 + inst * 0.4 : inst;
            b.t = now;
            b.loaded = loaded;
          }
          setModel((m) => {
            const done = loaded >= total * 0.995;
            return {
              ...m,
              loaded,
              total,
              bandwidth: Math.max(0, b.ema),
              eta: b.ema > 1000 ? Math.ceil((total - loaded) / b.ema) : null,
              phase: m.phase === "downloading" && done ? "loading" : m.phase,
              status: m.phase === "downloading" && done ? "Compiling graph & warming up runtime" : m.status,
            };
          });
        },
        onStatus: (text) => setModel((m) => (m.phase === "downloading" || m.phase === "loading" ? { ...m, status: text } : m)),
      });
      setModel((m) => ({ ...m, phase: "ready", device: used, cached: true, loaded: m.total, eta: 0, status: "Model loaded on WebGPU (LiteRT)" }));
      if (fromCache) setSetupOpen(false);
      chirp(840, settingsRef.current.volume, "triangle", 0.15);
    } catch (err) {
      modelClient.reset();
      setModel((m) => ({ ...m, phase: "error", error: (err as Error).message || "Unknown error while loading the model", status: "Failed" }));
      setSetupOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!profile || booted.current) return;
    booted.current = true;
    (async () => {
      const dev = await detectDevice();
      if (!dev) {
        setModel((m) => ({
          ...m,
          phase: "error",
          error: "WebGPU is not available in this browser. Gemma3-1B (LiteRT) runs GPU-only — use Chrome/Edge 121+ (desktop or Android) or Safari 26+.",
          status: "WebGPU unavailable",
        }));
        setSetupOpen(true);
        return;
      }
      const cached = await isModelCached(dev);
      setModel((m) => ({ ...m, device: dev, cached, phase: "idle", total: MODEL_SIZE_MB[dev] * 1e6, status: "" }));
      if (cached) startLoad(dev, true);
      else setSetupOpen(true);
    })();
  }, [profile, startLoad]);

  const deleteModel = useCallback(async () => {
    modelClient.reset();
    await clearModelCache();
    setModel((m) => ({ ...m, phase: "idle", cached: false, loaded: 0, eta: null, bandwidth: 0, status: "Model removed from this browser" }));
    showToast("Model deleted from browser cache.");
  }, [showToast]);

  /* ---------- chat ---------- */
  const send = useCallback(
    async (raw?: string, fromVoice = false) => {
      const text = (raw ?? input).trim();
      if (!text || generating) return;
      const s = settingsRef.current;
      chirp(520, s.volume, "sine", 0.08);

      // local persona-switch command
      const sw = text.match(/\b(switch|activate|engage|enable)\b.*\b(ultron|jarvis|friday)\b/i);
      if (sw) {
        const p = sw[2].toLowerCase() as Persona;
        const reply = `Persona switched to ${PERSONAS[p].label}. ${PERSONAS[p].tag} protocols online.`;
        updateSession(activeId, (m) => [...m, { id: uid(), role: "user", text }, { id: uid(), role: "assistant", text: reply }], text.slice(0, 44));
        patchSettings({ persona: p });
        setInput("");
        if (fromVoice || s.voiceReplies) {
          setSpeaking(true);
          speak(reply, { pitch: PERSONAS[p].pitch, rate: PERSONAS[p].rate, volume: s.volume / 100, voiceURI: s.voiceURI, onEnd: () => setSpeaking(false) });
        }
        return;
      }

      // If local model is not downloaded yet, provide an instant smart response
      if (model.phase !== "ready") {
        const sid = activeId;
        const userMsg: ChatMessage = { id: uid(), role: "user", text };
        const aiId = uid();
        setInput("");

        let reply = "";
        const lower = text.toLowerCase();
        if (lower.includes("who are you") || lower.includes("introduce") || lower.includes("hello") || lower.includes("hey") || lower.includes("hi")) {
          reply = `Greetings. I am ${persona.label}, your local AI workstation. I heard your voice command: "${text}". To enable full offline neural reasoning directly on your GPU, please click the model status chip in the top header to initialize Gemma3-1B.`;
        } else if (lower.includes("how are you")) {
          reply = `All systems fully operational. Ready for your instructions. Initialize the local GPU model in the header to run offline AI reasoning.`;
        } else if (lower.includes("what can you do") || lower.includes("help") || lower.includes("capabilities")) {
          reply = `I am equipped for real-time voice interaction, persona customization, document extraction, and local WebGPU neural execution. Click the top header to load the local model.`;
        } else {
          reply = `Voice command received: "${text}". I have processed your input. To generate comprehensive answers locally on your GPU, please download the Gemma3-1B model via the header button.`;
        }

        updateSession(sid, (m) => [...m, userMsg, { id: aiId, role: "assistant", text: reply }], userMsg.text.slice(0, 44));
        chirp(840, s.volume, "triangle", 0.15);
        if (fromVoice || s.voiceReplies) {
          setSpeaking(true);
          speak(reply, {
            pitch: persona.pitch,
            rate: persona.rate,
            volume: s.volume / 100,
            voiceURI: s.voiceURI,
            onEnd: () => setSpeaking(false),
          });
        }
        return;
      }

      stopSpeaking();
      setSpeaking(false);
      const sid = activeId;
      const userMsg: ChatMessage = { id: uid(), role: "user", text };
      const aiId = uid();
      const history = [...messages, userMsg];
      updateSession(sid, (m) => [...m, userMsg, { id: aiId, role: "assistant", text: "" }], userMsg.text.slice(0, 44));
      setInput("");
      setGenerating(true);

      // Build the prompt within the context budget (the 1B LiteRT KV cache caps at 1280 tokens)
      const usable = history.filter((m) => !m.error && (m.role === "user" || m.text));
      const budget = Math.min(s.contextTokens, 1280) - s.maxNewTokens - 160;
      const kept: ChatMessage[] = [];
      let used = 0;
      for (let i = usable.length - 1; i >= 0; i--) {
        const cost = Math.ceil(usable[i].text.length / 3.6) + 8;
        if (kept.length > 0 && used + cost > budget) break;
        kept.unshift(usable[i]);
        used += cost;
      }
      while (kept.length > 1 && kept[0].role !== "user") kept.shift();
      const promptMsgs = kept.map((m, i) => ({
        role: m.role,
        text: i === 0 ? `${PERSONAS[s.persona].prompt}\n\n${m.text}` : m.text,
      }));

      try {
        let acc = "";
        const res = await modelClient.generate({
          messages: promptMsgs,
          maxNewTokens: s.maxNewTokens,
          temperature: s.temperature,
          onToken: (t) => {
            acc += t;
            updateSession(sid, (m) => m.map((x) => (x.id === aiId ? { ...x, text: acc } : x)));
          },
        });
        const finalText = res.text || acc || "(no output)";
        updateSession(sid, (m) => m.map((x) => (x.id === aiId ? { ...x, text: finalText, tps: res.tps } : x)));
        chirp(840, s.volume, "triangle", 0.15);
        if ((fromVoice || settingsRef.current.voiceReplies) && finalText) {
          const cs = settingsRef.current;
          setSpeaking(true);
          speak(finalText, { pitch: PERSONAS[cs.persona].pitch, rate: PERSONAS[cs.persona].rate, volume: cs.volume / 100, voiceURI: cs.voiceURI, onEnd: () => setSpeaking(false) });
        }
      } catch (err) {
        updateSession(sid, (m) => m.map((x) => (x.id === aiId ? { ...x, text: `Inference failed: ${(err as Error).message}`, error: true } : x)));
      } finally {
        setGenerating(false);
      }
    },
    [input, generating, model.phase, messages, activeId, persona, updateSession, patchSettings],
  );

  const stopGeneration = () => modelClient.interrupt();

  /* ---------- voice input ---------- */
  const toggleMic = useCallback(() => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    if (!speechRecognitionSupported()) {
      showToast("Speech recognition isn't supported in this browser. Try Chrome, Edge or Safari.");
      return;
    }
    stopSpeaking();
    setSpeaking(false);
    chirp(650, settingsRef.current.volume, "sine", 0.08);

    const rec = createRecognizer({
      onInterim: (t) => {
        // Stream voice transcript directly into the text command box in real-time
        setInput(t);
      },
      onResult: (t) => {
        const query = t.trim();
        if (!query) return;
        // 1. Put recognized speech into the text command box
        setInput(query);
        // 2. Automatically submit and answer after brief visual confirmation
        window.setTimeout(() => {
          send(query, true); // true = fromVoice
        }, 350);
      },
      onEnd: () => setListening(false),
      onError: (msg) => {
        setListening(false);
        showToast(msg);
      },
    });
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [listening, send, showToast]);

  /* ---------- export ---------- */
  const doExport = async (kind: "pdf" | "docx" | "md") => {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].text && !messages[i].error) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      showToast("Nothing to export yet — ask the AI something first.");
      return;
    }
    const answer = messages[idx].text;
    const question = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user")?.text ?? "";
    const payload = { title: current?.title || "AI Response", persona: persona.brand, question, answer };
    chirp(640, settings.volume, "triangle", 0.08);
    try {
      if (kind === "pdf") exportPdf(payload);
      else if (kind === "md") exportMarkdown(payload);
      else await exportDocx(payload);
      showToast(`Exported .${kind} ✓`);
    } catch (e) {
      showToast(`Export failed: ${(e as Error).message}`);
    }
  };

  /* ---------- sessions ---------- */
  const startNewSession = () => {
    stopSpeaking();
    setSpeaking(false);
    setActiveId(uid());
    setInput("");
    setHistoryOpen(false);
  };

  /* ---------- profile ---------- */
  useEffect(() => {
    if (!profileOpen) return;
    navigator.storage?.estimate?.().then((e) => {
      const mb = ((e.usage ?? 0) / 1e6).toFixed(0);
      setStorageText(`Everything lives on this device. Browser storage in use: ~${mb} MB (model weights + chats). No account data is sent anywhere.`);
    }).catch(() => setStorageText("Everything lives on this device."));
  }, [profileOpen]);

  const signOut = () => {
    stopSpeaking();
    recRef.current?.abort?.();
    saveProfile(DEFAULT_PROFILE);
    setProfile(DEFAULT_PROFILE);
    setProfileOpen(false);
    setSpeaking(false);
    setListening(false);
    showToast("Workstation locked // Reset to local operator");
  };

  /* ---------- derived ---------- */
  const orbMode: OrbMode = listening ? "listening" : generating ? "thinking" : speaking ? "speaking" : "idle";
  const orbLabel = { idle: "STANDBY // READY", listening: "LISTENING…", thinking: "INFERRING LOCALLY…", speaking: "SPEAKING" }[orbMode];
  const eqActive = orbMode !== "idle";
  const eqSpeed = orbMode === "idle" ? "0.85s" : orbMode === "thinking" ? "0.35s" : "0.5s";
  const lastIsStreaming = generating && messages.length > 0 && messages[messages.length - 1].role === "assistant";
  const accents = ACCENTS[settings.persona] || ACCENTS.jarvis;
  const sessionCount = useMemo(() => sessions.filter((s) => s.messages.length > 0).length, [sessions]);

  const modelChip = (() => {
    if (model.phase === "ready") return { text: "GPU READY", color: "text-emerald-400", dot: "bg-emerald-400", spin: false };
    if (model.phase === "downloading") return { text: `${model.total ? Math.floor((model.loaded / model.total) * 100) : 0}%`, color: "dyn-accent-text", dot: "dyn-accent-bg", spin: true };
    if (model.phase === "loading") return { text: "LOADING", color: "dyn-accent-text", dot: "dyn-accent-bg", spin: true };
    if (model.phase === "error") return { text: "ERROR", color: "text-red-400", dot: "bg-red-400", spin: false };
    return { text: model.phase === "checking" ? "CHECKING" : "NO MODEL", color: "text-amber-400", dot: "bg-amber-400", spin: false };
  })();

  return (
    <div className="relative min-h-screen flex flex-col text-[#E2EAF8] overflow-x-hidden">
      <div className="aurora-flare-field" />
      <PwaInstallPrompt onInstalled={() => setToast("ULTRON installed as Chrome App")} />

      {/* HEADER */}
      <header className="fixed top-0 w-full z-40 pt-safe px-4 pt-3 pointer-events-none">
        <div className="vantix-panel p-3 flex items-center justify-between max-w-7xl mx-auto w-full pointer-events-auto rounded-2xl">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center border border-white/10 shadow-[0_0_12px_var(--theme-glow)]" style={{ background: "linear-gradient(135deg, var(--theme-secondary), var(--theme-accent))" }}>
              <img src="/icons/icon.svg" alt="ULTRON" className="w-5 h-5 object-contain" />
            </div>
            <span className="font-mono font-bold tracking-[0.2em] text-white text-[15px] uppercase dyn-accent-glow select-none truncate">{persona.brand}</span>
          </div>
          <div className="flex items-center gap-2">
            <HeaderInstallButton />
            <button type="button" onClick={() => setSetupOpen(true)} className="h-8 px-2.5 vantix-btn flex items-center gap-1.5 font-mono text-[9.5px] font-bold" title="Model status">
              <span className={`w-1.5 h-1.5 rounded-full ${modelChip.dot} ${modelChip.spin ? "animate-pulse" : ""}`} />
              <span className={modelChip.color}>{modelChip.text}</span>
            </button>
            <button type="button" onClick={() => setSettingsOpen(true)} className="w-8 h-8 vantix-btn flex items-center justify-center text-[#7A91B8] hover:text-[var(--theme-accent)]" title="Tactical Settings">
              <Icon name="settings" className="text-[18px]" />
            </button>
            <button type="button" onClick={() => setProfileOpen(true)} className="w-8 h-8 rounded-full p-[1.5px] shadow-[0_0_12px_var(--theme-glow)] active:scale-95" style={{ background: "linear-gradient(135deg, var(--theme-secondary), var(--theme-accent))" }} title="Profile">
              <div className="w-full h-full rounded-full bg-[#030B1E] flex items-center justify-center">
                <Icon name="person" className="dyn-light-text text-[16px]" />
              </div>
            </button>
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="flex-1 flex flex-col relative z-10 w-full max-w-7xl mx-auto px-4 pt-24 pb-28 space-y-4">
        {/* ORB */}
        <div className="vantix-panel rounded-2xl w-full flex flex-col items-center justify-center min-h-[380px] md:min-h-[440px] overflow-hidden relative">
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden">
            <div className="absolute w-[80%] h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
            <div className="absolute h-[80%] w-px bg-gradient-to-b from-transparent via-white/15 to-transparent" />
            <div className="w-[280px] h-[280px] rounded-full border border-white/5" />
            <div className="w-[360px] h-[360px] rounded-full border border-dashed border-white/5 animate-spin" style={{ animationDuration: "40s" }} />
            <div className="w-[260px] h-[260px] rounded-full blur-3xl" style={{ background: "radial-gradient(ellipse at center, var(--theme-glow) 0%, transparent 75%)" }} />
          </div>
          <div className="relative w-full h-[340px] md:h-[400px] z-10 cursor-grab active:cursor-grabbing touch-none select-none">
            <Orb accent={accents.accent} secondary={accents.secondary} mode={orbMode} />
          </div>
          <div className="absolute top-4 left-4 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/60 border border-white/10 font-mono text-[9px] text-white">
            <span className={`w-1.5 h-1.5 rounded-full dyn-accent-bg ${orbMode !== "idle" ? "animate-pulse" : ""}`} />
            {orbLabel}
          </div>
          <div className="absolute top-4 right-4 z-20 px-2.5 py-1 rounded-lg bg-black/60 border border-white/10 font-mono text-[9px] dyn-accent-text">{persona.tag}</div>
        </div>

        {/* EQUALIZER + MIC */}
        <div className="vantix-panel p-3 flex items-center justify-between gap-3 w-full rounded-2xl">
          <div className={`flex-1 h-14 p-2 flex items-end justify-around gap-1 overflow-hidden rounded-xl vantix-inset ${eqActive ? "" : "eq-idle"}`} style={{ ["--eq-speed" as string]: eqSpeed }}>
            <EqBars />
          </div>
          <div className="relative flex items-center justify-center shrink-0 p-1">
            <div className="absolute w-20 h-20 rounded-full pointer-events-none" style={{ background: "radial-gradient(circle, var(--theme-glow) 0%, transparent 70%)" }} />
            <button
              type="button"
              onClick={toggleMic}
              className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all relative group z-10 neu-mic-btn active:scale-95 ${listening ? "mic-listening" : ""}`}
              title={asr ? "Click to speak" : "Speech recognition not supported in this browser"}
            >
              <Icon name={listening ? "mic" : asr ? "mic" : "mic_off"} className="text-[26px] dyn-accent-text dyn-accent-glow group-hover:scale-110 transition-transform" />
            </button>
          </div>
          <div className={`flex-1 h-14 p-2 flex items-end justify-around gap-1 overflow-hidden rounded-xl vantix-inset ${eqActive ? "" : "eq-idle"}`} style={{ ["--eq-speed" as string]: eqSpeed }}>
            <EqBars mirror />
          </div>
        </div>

        {/* CONVERSATION */}
        <div className="vantix-panel p-4 flex flex-col gap-3 w-full rounded-2xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-[#7A91B8]">
              <Icon name="forum" className="dyn-accent-text text-[16px]" />
              <span className="truncate max-w-[200px]">{current?.title || "New session"}</span>
            </div>
            {generating && (
              <button type="button" onClick={stopGeneration} className="vantix-btn px-2.5 py-1 font-mono text-[9px] text-[#ff334b] uppercase font-bold flex items-center gap-1">
                <Icon name="stop_circle" className="text-[14px]" /> Stop
              </button>
            )}
          </div>

          <div ref={scrollRef} className="space-y-2.5 max-h-[340px] min-h-[96px] overflow-y-auto pr-1">
            {messages.length === 0 && (
              <div className="vantix-inset px-3.5 py-3 rounded-xl border-l-2" style={{ borderLeftColor: "var(--theme-accent)" }}>
                <div className="font-mono text-[8.5px] dyn-accent-text uppercase font-bold">{persona.label} CORE</div>
                <div className="font-mono text-[12px] dyn-light-text mt-1 leading-relaxed">
                  {model.phase === "ready"
                    ? `Online. Gemma3-1B (LiteRT) is running locally on your GPU via WebGPU. Type or speak to chat.`
                    : model.phase === "idle" || model.phase === "error"
                      ? "Model offline. Open the model chip in the header to download Gemma3-1B (one-time) and wake me up."
                      : "Warming up neural core…"}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} className="vantix-btn px-2.5 py-1 font-mono text-[10px] text-[#c4d5f2] hover:text-white">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              const isUser = m.role === "user";
              const streaming = lastIsStreaming && i === messages.length - 1;
              return (
                <div
                  key={m.id}
                  className={`msg-in vantix-inset px-3.5 py-2.5 rounded-xl border-l-2 ${isUser ? "ml-6" : ""}`}
                  style={{ borderLeftColor: isUser ? "rgba(255,255,255,0.35)" : m.error ? "#ff334b" : "var(--theme-accent)" }}
                >
                  <div className="flex items-center justify-between font-mono text-[8.5px] uppercase font-bold">
                    <span className={isUser ? "text-white/70" : "dyn-accent-text"}>{isUser ? (profile.name || "You") : `${persona.label} CORE`}</span>
                    {!isUser && m.tps ? <span className="text-[#7A91B8] normal-case font-medium">{m.tps.toFixed(1)} tok/s</span> : null}
                  </div>
                  {isUser && m.hadImage && <div className="mt-1 font-mono text-[10px] text-[#7A91B8]">[image attached]</div>}
                  <div className={`font-mono text-[12px] mt-1 break-words leading-relaxed whitespace-pre-wrap ${isUser ? "text-white" : m.error ? "text-red-300" : "dyn-light-text"} ${streaming ? "cursor-blink" : ""}`}>
                    {m.text || (streaming ? (
                      <span className="text-[#7A91B8]">{"Processing"}</span>
                    ) : "")}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <div
              className={`flex-1 vantix-inset flex items-center rounded-xl min-w-0 px-2 transition-all ${listening ? "border-[var(--theme-accent)] shadow-[0_0_16px_var(--theme-glow)]" : ""}`}
            >
              <input
                autoComplete="off"
                className="flex-1 bg-transparent border-0 outline-none px-2 py-2.5 font-mono text-[12px] text-white placeholder-[#5A7096] min-w-0"
                placeholder={listening ? "Listening to your voice... Speak now" : "TYPE OR SPEAK COMMAND"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => (generating ? stopGeneration() : send())}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-white shrink-0 active:scale-95 transition-all ml-1.5"
                style={{ background: "linear-gradient(135deg, var(--theme-secondary), var(--theme-accent))", boxShadow: "0 0 12px var(--theme-glow)" }}
                title={generating ? "Stop" : "Send"}
              >
                <Icon name={generating ? "stop" : "send"} className="text-[18px]" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !settings.voiceReplies;
                patchSettings({ voiceReplies: next });
                if (!next) {
                  stopSpeaking();
                  setSpeaking(false);
                }
                chirp(next ? 600 : 300, settings.volume, "sine", 0.06);
              }}
              className="w-10 h-10 rounded-xl vantix-btn flex items-center justify-center shrink-0 active:scale-95"
              title="Toggle spoken replies"
            >
              <Icon name={settings.voiceReplies ? "volume_up" : "volume_off"} className={`text-[19px] ${settings.voiceReplies ? "dyn-accent-text" : "text-[#7A91B8]"}`} />
            </button>
          </div>
        </div>

        {/* EXPORT */}
        <div className="vantix-panel p-4 flex flex-col space-y-3 w-full rounded-2xl">
          <div className="flex items-center gap-2">
            <Icon name="folder_open" className="dyn-accent-text text-[18px]" />
            <span className="font-mono text-xs uppercase tracking-wider text-white font-bold">Extract answer as</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {[
              { k: "pdf" as const, label: ".PDF", icon: "picture_as_pdf", c: "#ff334b", bg: "rgba(255, 34, 56, 0.12)", bd: "rgba(255, 34, 56, 0.35)" },
              { k: "docx" as const, label: ".DOCX", icon: "description", c: "#60a5fa", bg: "rgba(42, 116, 232, 0.14)", bd: "rgba(42, 116, 232, 0.4)" },
              { k: "md" as const, label: ".MD", icon: "terminal", c: "var(--theme-accent)", bg: "rgba(var(--theme-accent-rgb), 0.12)", bd: "rgba(var(--theme-accent-rgb), 0.35)" },
            ].map((f) => (
              <button key={f.k} type="button" onClick={() => doExport(f.k)} className="vantix-inset p-3 rounded-xl flex items-center justify-between group hover:border-[var(--theme-accent)] transition-colors text-left">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: f.bg, border: `1px solid ${f.bd}` }}>
                    <Icon name={f.icon} className="text-[20px]" style={{ color: f.c }} />
                  </div>
                  <span className="font-mono text-[11px] text-white font-bold truncate group-hover:text-[var(--theme-accent)]">EXTRACT AS -- ({f.label})</span>
                </div>
                <span className="w-7 h-7 rounded-lg vantix-btn flex items-center justify-center text-[#7A91B8] group-hover:text-[var(--theme-accent)] shrink-0">
                  <Icon name="file_download" className="text-[16px]" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </main>

      {/* BOTTOM NAV */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 p-3 pb-safe pointer-events-none flex justify-center">
        <div className="vantix-panel pointer-events-auto flex items-center justify-between gap-3 p-2.5 w-full max-w-md rounded-2xl">
          <button type="button" onClick={() => setHistoryOpen(true)} className="flex-1 px-3 rounded-xl vantix-inset flex items-center gap-2.5 group active:scale-95 transition-all text-left py-1.5">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border" style={{ background: "rgba(var(--theme-accent-rgb), 0.12)", borderColor: "rgba(var(--theme-accent-rgb), 0.35)" }}>
              <Icon name="forum" className="dyn-accent-text text-[20px] group-hover:scale-110 transition-transform" />
            </div>
            <div className="flex items-center justify-between flex-1 min-w-0">
              <span className="font-mono text-[11px] font-bold text-white uppercase tracking-wider truncate">Chat Sessions</span>
              <span className="font-mono text-[8.5px] px-1.5 rounded dyn-accent-bg text-black font-bold">{sessionCount}</span>
            </div>
          </button>
          <button type="button" onClick={() => setContextOpen(true)} className="flex-1 px-3 rounded-xl vantix-inset flex items-center gap-2.5 group active:scale-95 transition-all text-left py-1.5">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border" style={{ background: "rgba(42, 116, 232, 0.14)", borderColor: "rgba(42, 116, 232, 0.35)" }}>
              <Icon name="data_object" className="text-blue-400 text-[20px] group-hover:scale-110 transition-transform" />
            </div>
            <div className="flex items-center justify-between flex-1 min-w-0">
              <span className="font-mono text-[11px] font-bold text-white uppercase tracking-wider truncate">Context</span>
              <span className="font-mono text-[8.5px] text-blue-400 font-bold">{settings.contextTokens / 1024}K</span>
            </div>
          </button>
        </div>
      </nav>

      {/* TOAST */}
      <div className={`fixed left-1/2 -translate-x-1/2 bottom-24 z-[60] transition-all duration-300 ${toast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"}`}>
        <div className="vantix-panel px-4 py-2.5 font-mono text-[11px] text-white max-w-[88vw] text-center rounded-xl">{toast}</div>
      </div>

      {/* MODALS */}
      <SetupModal open={setupOpen} onClose={() => setSetupOpen(false)} model={model} asr={asr} tts={tts} onDownload={() => startLoad(model.device, model.cached)} onDelete={deleteModel} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        voices={voices}
        onChange={(p) => {
          patchSettings(p);
          if (p.persona) chirp(680, settings.volume, "sine", 0.12);
        }}
        onTestVoice={() => {
          setSpeaking(true);
          speak(`${persona.brand} online. Voice synthesis check complete.`, { pitch: persona.pitch, rate: persona.rate, volume: settings.volume / 100, voiceURI: settings.voiceURI, onEnd: () => setSpeaking(false) });
        }}
      />
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} profile={profile} onSignOut={signOut} storageText={storageText} />
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        sessions={sessions.filter((s) => s.messages.length > 0)}
        activeId={activeId}
        onOpen={(id) => {
          setActiveId(id);
          setHistoryOpen(false);
        }}
        onDelete={(id) => {
          setSessions((p) => p.filter((s) => s.id !== id));
          if (id === activeId) setActiveId(uid());
        }}
        onNew={startNewSession}
        onClear={() => {
          setSessions([]);
          setActiveId(uid());
        }}
      />
      <ContextModal open={contextOpen} onClose={() => setContextOpen(false)} settings={settings} onChange={patchSettings} />
    </div>
  );
}
