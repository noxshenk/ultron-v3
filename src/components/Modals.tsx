import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { MODEL_NAME, MODEL_SIZE_MB, type Device } from "../lib/modelClient";
import { PERSONAS, timeAgo, fmtMB, type Persona, type Profile, type Session, type Settings } from "../lib/store";

/* ------------------------------------------------------------------ */
/* UI PRIMITIVES & BASE COMPONENTS                                     */
/* ------------------------------------------------------------------ */

export function Icon({ name, className = "", style }: { name: string; className?: string; style?: CSSProperties }) {
  return (
    <span className={`material-symbols-outlined ${className}`} style={style}>
      {name}
    </span>
  );
}

const modalCardStyle: CSSProperties = {
  background: "linear-gradient(145deg, #0e121b 0%, #07090e 100%)",
  border: "1px solid rgba(255, 255, 255, 0.06)",
  boxShadow:
    "18px 18px 40px rgba(0, 0, 0, 0.92), -10px -10px 28px rgba(255, 255, 255, 0.025), inset 1px 1px 1.5px rgba(255, 255, 255, 0.07)",
};

export function Overlay({
  open,
  onClose,
  children,
  position = "top",
  z = 50,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  position?: "top" | "bottom";
  z?: number;
}) {
  return (
    <div
      className={`modal-overlay ${open ? "active" : ""} fixed inset-0 flex justify-center bg-black/80 backdrop-blur-md ${
        position === "top" ? "items-start pt-20 sm:pt-24 px-3.5" : "items-end sm:items-center p-0 sm:p-4"
      }`}
      style={{ zIndex: z }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden={!open}
    >
      {children}
    </div>
  );
}

export function ModalHeader({
  icon,
  title,
  subtitle,
  onClose,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between pb-3 border-b border-white/5">
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "rgba(var(--theme-accent-rgb), 0.12)", border: "1px solid var(--theme-accent)" }}
        >
          <Icon name={icon} className="dyn-accent-text text-[17px]" />
        </div>
        <div className="min-w-0">
          <h2 className="font-mono text-xs uppercase tracking-widest text-white font-bold truncate">{title}</h2>
          {subtitle && <span className="font-mono text-[9px] text-[#7A91B8]">{subtitle}</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="w-7 h-7 rounded-lg vantix-btn flex items-center justify-center text-[#7A91B8] hover:text-white"
        title="Close"
      >
        <Icon name="close" className="text-[16px]" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PWA INSTALLATION                                                    */
/* ------------------------------------------------------------------ */

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

let savedDeferredPrompt: BeforeInstallPromptEvent | null = null;
const pwaListeners = new Set<() => void>();

function notifyPwaListeners() {
  pwaListeners.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    savedDeferredPrompt = e as BeforeInstallPromptEvent;
    notifyPwaListeners();
  });

  window.addEventListener("appinstalled", () => {
    savedDeferredPrompt = null;
    notifyPwaListeners();
  });
}

function usePwaInstall() {
  const [canInstall, setCanInstall] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const checkStandalone = () => {
      const isStand =
        window.matchMedia("(display-mode: standalone)").matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
        (document.referrer || "").includes("android-app://");
      setIsStandalone(Boolean(isStand));
    };

    checkStandalone();
    const mm = window.matchMedia("(display-mode: standalone)");
    mm.addEventListener?.("change", checkStandalone);

    const updateState = () => {
      setCanInstall(!isStandalone && Boolean(savedDeferredPrompt));
    };

    updateState();
    pwaListeners.add(updateState);

    return () => {
      mm.removeEventListener?.("change", checkStandalone);
      pwaListeners.delete(updateState);
    };
  }, [isStandalone]);

  const promptInstall = async () => {
    if (!savedDeferredPrompt) return false;
    try {
      await savedDeferredPrompt.prompt();
      const choice = await savedDeferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        savedDeferredPrompt = null;
        notifyPwaListeners();
        return true;
      }
    } catch (err) {
      console.warn("[PWA] Install prompt error:", err);
    }
    return false;
  };

  return { canInstall, isStandalone, promptInstall };
}

export function PwaInstallPrompt({ onInstalled }: { onInstalled?: () => void }) {
  const { isStandalone, promptInstall } = usePwaInstall();
  const [visible, setVisible] = useState(false);
  const [showManualGuide, setShowManualGuide] = useState(false);

  useEffect(() => {
    if (isStandalone) {
      setVisible(false);
      return;
    }

    const dismissed = sessionStorage.getItem("ultron_pwa_dismissed");
    if (!dismissed) {
      const timer = setTimeout(() => {
        setVisible(true);
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [isStandalone]);

  if (isStandalone || !visible) return null;

  const handleInstallClick = async () => {
    if (savedDeferredPrompt) {
      const installed = await promptInstall();
      if (installed) {
        setVisible(false);
        onInstalled?.();
      }
    } else {
      setShowManualGuide(true);
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem("ultron_pwa_dismissed", "true");
    setVisible(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div
        className="w-full max-w-lg rounded-2xl border border-white/5 p-5 sm:p-6 relative overflow-hidden vantix-panel"
      >
        <div
          className="absolute -top-20 left-1/2 -translate-x-1/2 w-72 h-32 rounded-full blur-3xl pointer-events-none opacity-40"
          style={{ background: "radial-gradient(ellipse, #ff2238 0%, #00d2ff 60%, transparent 80%)" }}
        />

        <button
          type="button"
          onClick={handleDismiss}
          className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Dismiss"
        >
          <Icon name="close" className="text-[18px]" />
        </button>

        <div className="flex items-start gap-4 mb-4">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center shrink-0 border border-white/15 shadow-[0_0_20px_rgba(255,34,56,0.35)] relative overflow-hidden" style={{ background: "linear-gradient(135deg, #1c2233 0%, #0d0f18 100%)" }}>
            <img src="/icons/icon.svg" alt="ULTRON Icon" className="w-10 h-10 object-contain drop-shadow-[0_0_8px_rgba(255,34,56,0.8)]" />
            <div className="absolute -bottom-1 -right-1 px-1.5 py-0.5 rounded bg-[#00d2ff] text-black font-mono font-bold text-[8px] uppercase tracking-wider">
              PWA
            </div>
          </div>

          <div className="min-w-0 pr-6">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[10px] font-bold tracking-widest uppercase text-[#00d2ff]">
                Desktop Experience
              </span>
              <span className="inline-block w-1 h-1 rounded-full bg-emerald-400" />
              <span className="text-[10px] text-emerald-400 font-mono">Chrome App</span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-wide flex items-center gap-2">
              Install ULTRON
            </h2>
            <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
              Run ULTRON as a standalone desktop app with full offline capabilities, faster loading, and dedicated window.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 my-4">
          <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex flex-col items-center text-center">
            <Icon name="desktop_windows" className="text-[18px] text-[#00d2ff] mb-1" />
            <span className="font-mono text-[10px] font-semibold text-white">Standalone</span>
            <span className="text-[9px] text-slate-400 mt-0.5">No tab clutter</span>
          </div>
          <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex flex-col items-center text-center">
            <Icon name="bolt" className="text-[18px] text-[#ffcc00] mb-1" />
            <span className="font-mono text-[10px] font-semibold text-white">Fast Launch</span>
            <span className="text-[9px] text-slate-400 mt-0.5">Taskbar shortcut</span>
          </div>
          <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex flex-col items-center text-center">
            <Icon name="cloud_off" className="text-[18px] text-emerald-400 mb-1" />
            <span className="font-mono text-[10px] font-semibold text-white">Local AI</span>
            <span className="text-[9px] text-slate-400 mt-0.5">Works offline</span>
          </div>
        </div>

        {showManualGuide && (
          <div className="mb-4 p-3 rounded-xl bg-cyan-950/40 border border-cyan-500/30 text-xs text-cyan-200 flex items-start gap-2.5 animate-fade-in">
            <Icon name="info" className="text-[18px] text-[#00d2ff] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-white">To install in Google Chrome:</p>
              <ol className="list-decimal list-inside space-y-0.5 text-slate-300 text-[11px]">
                <li>Look for the <span className="text-white font-mono bg-white/10 px-1 py-0.5 rounded">Install App</span> icon (computer with down arrow) in Chrome's top address bar.</li>
                <li>Or click Chrome Menu <span className="text-white font-bold">⋮</span> &rarr; <span className="text-white">Save and share</span> &rarr; <span className="text-[#00d2ff] font-semibold">Install ULTRON</span>.</li>
              </ol>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleInstallClick}
            className="flex-1 h-11 px-4 rounded-xl font-mono text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 text-white transition-all shadow-[0_0_20px_rgba(255,34,56,0.35)] active:scale-[0.98] cursor-pointer"
            style={{ background: "linear-gradient(135deg, #ff2238 0%, #c50c1f 100%)" }}
          >
            <Icon name="download_for_offline" className="text-[18px]" />
            <span>Install as Chrome App</span>
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            className="h-11 px-4 rounded-xl border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 font-mono text-xs transition-colors"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

export function HeaderInstallButton() {
  const { isStandalone, promptInstall } = usePwaInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isStandalone) return null;

  const handleClick = async () => {
    if (savedDeferredPrompt) {
      await promptInstall();
    } else {
      setShowGuide((prev) => !prev);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        className="h-8 px-2.5 vantix-btn flex items-center gap-1.5 font-mono text-[9.5px] font-bold text-[#00d2ff] hover:text-white border-[#00d2ff]/30 hover:border-[#00d2ff]/60 shadow-[0_0_10px_rgba(0,210,255,0.15)]"
        title="Download / Install ULTRON as Chrome App"
      >
        <Icon name="download" className="text-[14px]" />
        <span className="hidden sm:inline">INSTALL APP</span>
      </button>

      {showGuide && (
        <div className="absolute right-0 top-10 w-64 p-3 rounded-xl border border-white/15 bg-[#0e1018] shadow-2xl text-xs z-50 animate-fade-in">
          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/10">
            <span className="font-mono text-[10px] text-[#00d2ff] font-bold">INSTALL CHROME APP</span>
            <button type="button" onClick={() => setShowGuide(false)} className="text-slate-400 hover:text-white">
              <Icon name="close" className="text-[14px]" />
            </button>
          </div>
          <p className="text-slate-300 text-[11px] leading-relaxed">
            Click the <strong className="text-white">Install</strong> icon in Chrome's address bar (top right) or Chrome Menu <strong className="text-white">⋮ &gt; Save and share &gt; Install ULTRON</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MODEL PROVISIONING                                                  */
/* ------------------------------------------------------------------ */

export interface ModelState {
  phase: "checking" | "idle" | "downloading" | "loading" | "ready" | "error";
  device: Device;
  cached: boolean;
  loaded: number;
  total: number;
  bandwidth: number; // bytes / sec
  eta: number | null;
  status: string;
  error?: string;
}

export function SetupModal(props: {
  open: boolean;
  onClose: () => void;
  model: ModelState;
  asr: boolean;
  tts: boolean;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { model, open, onClose } = props;
  const pct = model.total ? Math.min(100, Math.floor((model.loaded / model.total) * 100)) : 0;
  const sizeMB = MODEL_SIZE_MB[model.device];
  const busy = model.phase === "downloading" || model.phase === "loading";

  const label =
    model.phase === "checking"
      ? "CHECKING DEVICE…"
      : model.phase === "idle"
        ? model.cached
          ? "LOAD MODEL FROM CACHE"
          : `DOWNLOAD MODEL (~${Math.round(sizeMB)} MB)`
        : model.phase === "downloading"
          ? `DOWNLOADING WEIGHTS (${pct}%)`
          : model.phase === "loading"
            ? "INITIALIZING RUNTIME…"
            : model.phase === "ready"
              ? "LAUNCH WORKSTATION"
              : "RETRY DOWNLOAD";

  const click = () => {
    if (model.phase === "ready") onClose();
    else if (model.phase === "idle" || model.phase === "error") props.onDownload();
  };

  return (
    <Overlay open={open} onClose={onClose} z={55}>
      <div className="modal-card vantix-panel w-full max-w-lg max-h-[85vh] overflow-y-auto p-3.5 space-y-3 rounded-2xl border" style={modalCardStyle}>
        <ModalHeader icon="memory" title="Model Provisioning" subtitle="Runs 100% locally in your browser" onClose={onClose} />

        <div className="p-3 rounded-xl space-y-2.5 vantix-inset" style={{ border: "1px solid rgba(var(--theme-accent-rgb), 0.25)" }}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(var(--theme-accent-rgb), 0.12)", border: "1px solid rgba(var(--theme-accent-rgb),0.4)" }}>
                <Icon name="auto_awesome" className="dyn-accent-text text-[18px]" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="font-mono text-[12px] text-white font-bold tracking-wide truncate">{MODEL_NAME}</span>
                <span className="font-mono text-[8.5px] text-[#7A91B8] tracking-wide">
                  LITERT INT4 • WEBGPU ACCELERATED • BROWSER CACHE
                </span>
              </div>
            </div>
            {model.phase === "downloading" && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/60 border border-white/10 shrink-0">
                <div className="flex items-end gap-[2px] h-3 w-3.5">
                  <span className="w-[2px] h-1.5 dyn-accent-bg rounded-full net-blip-bar" style={{ animationDelay: "0.1s" }} />
                  <span className="w-[2px] h-2.5 dyn-accent-bg rounded-full net-blip-bar" style={{ animationDelay: "0.3s" }} />
                  <span className="w-[2px] h-2 dyn-accent-bg rounded-full net-blip-bar" style={{ animationDelay: "0.15s" }} />
                  <span className="w-[2px] h-3 bg-white rounded-full net-blip-bar" style={{ animationDelay: "0.4s" }} />
                </div>
                <span className="font-mono text-[9px] font-bold dyn-accent-text">{(model.bandwidth / 1e6).toFixed(1)} MB/s</span>
              </div>
            )}
            {model.phase === "ready" && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-400/40 shrink-0 font-mono text-[9px] font-bold text-emerald-400">
                <Icon name="check_circle" className="text-[12px]" /> READY
              </div>
            )}
          </div>

          <div className="space-y-1 pt-0.5">
            <div className="flex items-center justify-between text-[10px] font-mono">
              <div className="flex items-center gap-1.5 min-w-0">
                {busy && <Icon name="progress_activity" className="text-[13px] dyn-accent-text animate-spin" />}
                <span className="text-[#9db2d6] text-[9px] truncate">{model.status || (model.phase === "ready" ? "Model loaded in memory" : "Waiting for your go-ahead")}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[#7A91B8] text-[9px]">
                  {fmtMB(model.loaded)} MB / {fmtMB(model.total || sizeMB * 1e6)} MB
                </span>
                <span className="font-bold dyn-accent-text text-xs">{model.phase === "ready" ? 100 : pct}%</span>
              </div>
            </div>
            <div className="w-full h-1.5 rounded-full bg-black/90 overflow-hidden relative border border-white/10">
              <div
                className="h-full rounded-full dyn-accent-bg transition-all duration-300 ease-out relative overflow-hidden"
                style={{ width: `${model.phase === "ready" ? 100 : model.phase === "loading" && !model.loaded ? 100 : pct}%`, boxShadow: "0 0 10px var(--theme-accent)" }}
              >
                {busy && <div className="laser-shimmer" />}
              </div>
            </div>
            <div className="flex items-center justify-between text-[8.5px] font-mono text-[#7A91B8] pt-0.5">
              <span>
                ETA: <strong className="dyn-light-text">{model.phase === "downloading" && model.eta != null ? `~${model.eta}s` : "—"}</strong>
              </span>
              <span>{model.cached || model.phase === "ready" ? "CACHED ON DEVICE" : "NOT CACHED YET"}</span>
            </div>
          </div>

          {model.phase === "error" && (
            <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/40 font-mono text-[10px] text-red-300 break-words">
              <Icon name="error" className="text-[13px] align-middle mr-1" />
              {model.error}
            </div>
          )}
        </div>

        <div className="p-2 rounded-xl vantix-inset flex items-center justify-between font-mono text-[9px]">
          <div className="flex items-center gap-1.5 text-[#7A91B8] uppercase font-semibold">
            <Icon name="hub" className="text-[14px] dyn-accent-text" />
            <span>RUNTIME:</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-[#7A91B8]">ASR</span>
              <span className={props.asr ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>{props.asr ? "ON" : "N/A"}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[#7A91B8]">TTS</span>
              <span className={props.tts ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>{props.tts ? "ON" : "N/A"}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[#7A91B8]">WEBGPU</span>
              <span className="text-emerald-400 font-bold">REQUIRED</span>
            </div>
          </div>
        </div>

        <p className="font-mono text-[9.5px] leading-relaxed text-[#7A91B8]">
          Gemma3-1B-IT (LiteRT int4, ~555 MB) streams from Hugging Face straight into your browser's Cache Storage — a one-time download. After that the assistant works offline and nothing you type ever leaves your device. This lite build is text-only (no image input) and needs a WebGPU-capable browser: Chrome/Edge 121+ or Safari 26+.
        </p>

        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={click}
            disabled={busy || model.phase === "checking"}
            className="flex-1 py-2.5 px-3 rounded-xl font-mono text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all border text-white active:scale-95 disabled:opacity-80"
            style={{ background: "linear-gradient(135deg, var(--theme-secondary), var(--theme-accent))", boxShadow: "0 4px 14px var(--theme-glow)", borderColor: "rgba(255,255,255,0.35)" }}
          >
            <Icon name={busy || model.phase === "checking" ? "sync" : model.phase === "ready" ? "rocket_launch" : "download"} className={`text-[15px] ${busy || model.phase === "checking" ? "animate-spin" : ""}`} />
            <span>{label}</span>
          </button>
          {(model.cached || model.phase === "ready") && !busy && (
            <button type="button" onClick={props.onDelete} className="vantix-btn px-3 py-2.5 rounded-xl font-mono text-[10px] text-[#ff334b] uppercase tracking-wider font-semibold" title="Delete the downloaded model from this browser">
              <Icon name="delete" className="text-[15px] align-middle" />
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/* ------------------------------------------------------------------ */
/* SETTINGS                                                            */
/* ------------------------------------------------------------------ */

export function SettingsModal(props: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  voices: SpeechSynthesisVoice[];
  onChange: (patch: Partial<Settings>) => void;
  onTestVoice: () => void;
}) {
  const { settings: s } = props;
  return (
    <Overlay open={props.open} onClose={props.onClose}>
      <div className="modal-card vantix-panel w-full max-w-md max-h-[82vh] overflow-y-auto p-4 space-y-4 rounded-2xl border" style={modalCardStyle}>
        <ModalHeader icon="tune" title="Tactical Controls & Config" onClose={props.onClose} />
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#7A91B8] uppercase tracking-wider font-semibold">AI Personality Architecture</span>
            <span className="font-mono text-[9px] dyn-accent-text tracking-wide font-bold">ACTIVE: {PERSONAS[s.persona].label}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(["ultron", "jarvis", "friday"] as Persona[]).map((p) => {
              const dot = p === "ultron" ? "#ff2238" : p === "jarvis" ? "#00d2ff" : "#ffcc00";
              const bg = p === "ultron" ? "linear-gradient(145deg, rgb(24, 17, 19), rgb(13, 8, 9))" : p === "jarvis" ? "linear-gradient(145deg, rgb(14, 22, 36), rgb(8, 13, 22))" : "linear-gradient(145deg, rgb(26, 23, 13), rgb(14, 12, 6))";
              const active = s.persona === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => props.onChange({ persona: p })}
                  className="flex flex-col items-start p-2.5 rounded-xl border transition-all text-left group"
                  style={{ background: bg, borderColor: active ? "var(--theme-accent)" : "rgba(255,255,255,0.08)", boxShadow: active ? "0 0 14px var(--theme-glow)" : "none" }}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="font-mono text-[11px] font-bold text-white tracking-wider">{PERSONAS[p].label}</span>
                    <span className="w-2 h-2 rounded-full" style={{ background: dot, opacity: active ? 1 : 0.4, boxShadow: active ? `0 0 6px ${dot}` : "none" }} />
                  </div>
                  <span className="text-[9px] text-[#9db2d6] mt-1 leading-tight">{PERSONAS[p].sub}</span>
                </button>
              );
            })}
          </div>
          <p className="font-mono text-[9px] text-[#7A91B8]">The persona changes theme, voice pitch and the system instruction the model follows.</p>
        </div>

        <div className="vantix-inset p-3 space-y-2 rounded-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Icon name="graphic_eq" className="text-[15px] dyn-accent-text" />
              <span className="font-mono text-[10px] text-white tracking-wider uppercase font-semibold">Synthesis Volume</span>
            </div>
            <span className="font-mono text-[10px] dyn-light-text font-bold">
              {s.volume >= 70 ? "HIGH" : s.volume >= 40 ? "NORMAL" : "WHISPER"} // {s.volume}%
            </span>
          </div>
          <input type="range" className="w-full tactical-slider cursor-pointer" min={10} max={100} value={s.volume} onChange={(e) => props.onChange({ volume: +e.target.value })} />
        </div>

        <div className="vantix-inset p-3 space-y-2 rounded-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Icon name="record_voice_over" className="text-[15px] dyn-accent-text" />
              <span className="font-mono text-[10px] text-white tracking-wider uppercase font-semibold">Voice</span>
            </div>
            <button type="button" onClick={props.onTestVoice} className="vantix-btn px-2 py-1 font-mono text-[9px] text-white uppercase tracking-wider">
              Test
            </button>
          </div>
          <select
            value={s.voiceURI}
            onChange={(e) => props.onChange({ voiceURI: e.target.value })}
            className="w-full bg-[#05070b] border border-white/10 rounded-lg px-2 py-2 font-mono text-[11px] text-white outline-none"
          >
            <option value="">System default</option>
            {props.voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>

        <button type="button" onClick={props.onClose} className="w-full py-2.5 rounded-xl font-mono text-xs uppercase tracking-widest font-bold text-white active:scale-95 grad-btn">
          Done
        </button>
      </div>
    </Overlay>
  );
}

/* ------------------------------------------------------------------ */
/* PROFILE                                                             */
/* ------------------------------------------------------------------ */

export function ProfileModal(props: { open: boolean; onClose: () => void; profile: Profile | null; onSignOut: () => void; storageText: string }) {
  const p = props.profile;
  return (
    <Overlay open={props.open} onClose={props.onClose}>
      <div className="modal-card vantix-panel w-full max-w-md p-4 space-y-4 rounded-2xl border" style={modalCardStyle}>
        <ModalHeader icon="person" title="Profile" onClose={props.onClose} />
        <div className="vantix-inset p-3.5 flex items-center gap-3.5 rounded-xl">
          <div className="w-14 h-14 rounded-xl p-[2px] shrink-0" style={{ background: "linear-gradient(135deg, var(--theme-secondary), var(--theme-accent))" }}>
            <div className="w-full h-full rounded-xl bg-[#030B1E] flex items-center justify-center">
              <Icon name="shield_person" className="dyn-accent-text text-[30px]" />
            </div>
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-mono text-sm text-white font-bold tracking-wider truncate uppercase">{p?.name}</span>
            <span className="font-mono text-[10.5px] text-[#7A91B8] truncate mt-0.5">{p?.email}</span>
            <span className="inline-flex items-center gap-1.5 mt-1.5 px-2 py-0.5 rounded bg-black/60 border border-white/5 w-fit font-mono text-[9px] dyn-accent-text uppercase">
              {p?.provider} · local profile
            </span>
          </div>
        </div>
        <p className="font-mono text-[10px] text-[#7A91B8] leading-relaxed">{props.storageText}</p>
        <button type="button" onClick={props.onSignOut} className="w-full py-2.5 px-3 rounded-xl font-mono text-[11px] font-bold uppercase tracking-wider text-[#ff334b] border border-[#ff334b]/40 flex items-center justify-center gap-2 hover:bg-[#ff334b]/10 active:scale-95 transition-all">
          <Icon name="power_settings_new" className="text-[16px]" />
          <span>Sign out / lock workstation</span>
        </button>
      </div>
    </Overlay>
  );
}

/* ------------------------------------------------------------------ */
/* CHAT HISTORY                                                        */
/* ------------------------------------------------------------------ */

export function HistoryModal(props: {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  activeId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const t = q.toLowerCase().trim();
    return [...props.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((s) => !t || s.title.toLowerCase().includes(t) || s.messages.some((m) => m.text.toLowerCase().includes(t)));
  }, [props.sessions, q]);

  return (
    <Overlay open={props.open} onClose={props.onClose} position="bottom">
      <div className="modal-card vantix-panel w-full max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl border overflow-hidden" style={modalCardStyle}>
        <div className="p-3.5">
          <ModalHeader icon="forum" title="Archived Chat Sessions" onClose={props.onClose} />
        </div>
        <div className="px-3.5 pb-3.5 space-y-3 overflow-y-auto flex-1">
          <div className="vantix-inset flex items-center gap-2 px-3 py-2 rounded-xl">
            <Icon name="search" className="text-[#7A91B8] text-[18px]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search past sessions or directives..." className="bg-transparent border-0 outline-none font-mono text-xs text-white placeholder-[#5A7096] w-full" />
          </div>
          <div className="space-y-2">
            {list.length === 0 && <div className="p-4 text-center font-mono text-[11px] text-[#7A91B8]">{props.sessions.length ? "No sessions match your search." : "No saved sessions yet."}</div>}
            {list.map((s) => {
              const active = s.id === props.activeId;
              const last = s.messages[s.messages.length - 1];
              return (
                <div
                  key={s.id}
                  onClick={() => props.onOpen(s.id)}
                  className="vantix-inset p-3 rounded-xl flex items-center justify-between gap-2 group hover:border-[var(--theme-accent)] transition-all cursor-pointer"
                  style={active ? { borderLeft: "2px solid var(--theme-accent)" } : undefined}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border border-white/10" style={{ background: "rgba(var(--theme-accent-rgb), 0.1)" }}>
                      <Icon name="chat" className="dyn-accent-text text-[18px]" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-bold text-white truncate">{s.title}</span>
                        {active && <span className="font-mono text-[8.5px] px-1.5 py-0.5 rounded dyn-accent-bg text-black font-bold uppercase shrink-0">Active</span>}
                      </div>
                      <span className="font-mono text-[9px] text-[#7A91B8] truncate mt-0.5">
                        {s.messages.length} msgs • {timeAgo(s.updatedAt)}
                        {last ? ` • ${last.text.slice(0, 50)}` : ""}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDelete(s.id);
                    }}
                    className="w-7 h-7 rounded-lg vantix-btn flex items-center justify-center text-[#7A91B8] hover:text-[#ff334b] shrink-0"
                    title="Delete session"
                  >
                    <Icon name="delete" className="text-[15px]" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="p-3.5 pt-0 flex gap-2">
          <button type="button" onClick={props.onNew} className="flex-1 py-2 rounded-xl vantix-btn font-mono text-[11px] font-bold uppercase tracking-wider text-white active:scale-95 flex items-center justify-center gap-1.5">
            <Icon name="add" className="text-[16px] dyn-accent-text" />
            <span>New Session</span>
          </button>
          <button type="button" onClick={props.onClear} className="vantix-btn px-3 py-2 rounded-xl font-mono text-[10px] text-[#ff334b] uppercase tracking-wider font-semibold active:scale-95">
            Clear All
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ------------------------------------------------------------------ */
/* CONTEXT TUNING                                                      */
/* ------------------------------------------------------------------ */

export function ContextModal(props: { open: boolean; onClose: () => void; settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const s = props.settings;
  const desc = s.temperature < 0.2 ? "GREEDY // DETERMINISTIC" : s.temperature < 0.5 ? "PRECISE" : s.temperature < 0.8 ? "BALANCED" : "CREATIVE";
  return (
    <Overlay open={props.open} onClose={props.onClose} position="bottom">
      <div className="modal-card vantix-panel w-full max-w-md max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl border overflow-hidden" style={modalCardStyle}>
        <div className="p-3.5">
          <ModalHeader icon="data_object" title="Context Window & Inference" subtitle="Applied to every next generation" onClose={props.onClose} />
        </div>
        <div className="px-4 pb-4 space-y-4 overflow-y-auto flex-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-[#7A91B8] uppercase tracking-wider font-semibold">Conversation memory budget</span>
              <span className="font-mono text-[10px] text-blue-400 font-bold">{s.contextTokens} TOKENS</span>
            </div>
            <input type="range" className="w-full tactical-slider cursor-pointer" min={1024} max={8192} step={512} value={s.contextTokens} onChange={(e) => props.onChange({ contextTokens: +e.target.value })} />
            <div className="grid grid-cols-4 gap-1.5 pt-1">
              {[1024, 2048, 4096, 8192].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => props.onChange({ contextTokens: t })}
                  className="py-1.5 rounded-lg border font-mono text-[10px] text-white active:scale-95 transition-all"
                  style={s.contextTokens === t ? { background: "rgba(var(--theme-accent-rgb), 0.2)", borderColor: "var(--theme-accent)", boxShadow: "0 0 10px var(--theme-glow)" } : { background: "rgb(10, 13, 19)", borderColor: "rgba(255,255,255,0.08)" }}
                >
                  {t / 1024}K
                </button>
              ))}
            </div>
            <p className="font-mono text-[9px] text-[#7A91B8]">Older messages beyond this budget are dropped from the prompt (the visible chat is kept).</p>
          </div>

          <div className="vantix-inset p-3 space-y-2 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-white tracking-wider uppercase font-semibold">Max response length</span>
              <span className="font-mono text-[10px] dyn-light-text font-bold">{s.maxNewTokens} TOK</span>
            </div>
            <input type="range" className="w-full tactical-slider cursor-pointer" min={64} max={1024} step={32} value={s.maxNewTokens} onChange={(e) => props.onChange({ maxNewTokens: +e.target.value })} />
          </div>

          <div className="vantix-inset p-3 space-y-2 rounded-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Icon name="thermostat" className="text-[15px] dyn-accent-text" />
                <span className="font-mono text-[10px] text-white tracking-wider uppercase font-semibold">Sampling temperature</span>
              </div>
              <span className="font-mono text-[10px] dyn-light-text font-bold">
                {s.temperature.toFixed(2)} // {desc}
              </span>
            </div>
            <input type="range" className="w-full tactical-slider cursor-pointer" min={0.1} max={1} step={0.05} value={s.temperature} onChange={(e) => props.onChange({ temperature: +e.target.value })} />
          </div>

          <button type="button" onClick={props.onClose} className="w-full py-2.5 rounded-xl font-mono text-xs uppercase tracking-widest font-bold text-white active:scale-95 grad-btn">
            Apply Tuning
          </button>
        </div>
      </div>
    </Overlay>
  );
}
