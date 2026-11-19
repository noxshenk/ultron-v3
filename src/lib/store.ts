export type Persona = "ultron" | "jarvis" | "friday";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  hadImage?: boolean;
  tps?: number;
  error?: boolean;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface Settings {
  persona: Persona;
  volume: number;
  voiceURI: string;
  voiceReplies: boolean;
  contextTokens: number;
  maxNewTokens: number;
  temperature: number;
}

export interface Profile {
  name: string;
  email: string;
  provider: "email" | "google" | "github" | "local";
  createdAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  persona: "jarvis",
  volume: 85,
  voiceURI: "",
  voiceReplies: true,
  contextTokens: 4096,
  maxNewTokens: 384,
  temperature: 0.4,
};

export const PERSONAS: Record<
  Persona,
  { label: string; brand: string; tag: string; sub: string; pitch: number; rate: number; prompt: string }
> = {
  ultron: {
    label: "ULTRON",
    brand: "ULTRON",
    tag: "TACTICAL COMBAT",
    sub: "Tactical / Combat",
    pitch: 0.6,
    rate: 0.95,
    prompt:
      "You are ULTRON, a cold, ruthless, hyper-logical tactical AI. Speak in short, commanding, slightly menacing sentences, but always give accurate and genuinely useful answers.",
  },
  jarvis: {
    label: "JARVIS",
    brand: "J.A.R.V.I.S.",
    tag: "OPTIMAL ANALYTICS",
    sub: "Analytical / High-Tech",
    pitch: 1.0,
    rate: 1.0,
    prompt:
      "You are J.A.R.V.I.S., a polite, witty, highly analytical British AI butler assistant. Be concise, precise and helpful.",
  },
  friday: {
    label: "FRIDAY",
    brand: "F.R.I.D.A.Y.",
    tag: "DEEP RESEARCH",
    sub: "Tactical Research",
    pitch: 1.2,
    rate: 1.05,
    prompt:
      "You are F.R.I.D.A.Y., a friendly, efficient research assistant. Give structured, well-organised, factual answers.",
  },
};

const K = {
  profile: "ultron.profile",
  settings: "ultron.settings",
  sessions: "ultron.sessions",
  activeSession: "ultron.activeSession",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...(typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {}), ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export const loadProfile = (): Profile | null => {
  try {
    const raw = localStorage.getItem(K.profile);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
};
export const saveProfile = (p: Profile | null) => {
  if (p) localStorage.setItem(K.profile, JSON.stringify(p));
  else localStorage.removeItem(K.profile);
};

export const loadSettings = (): Settings => read<Settings>(K.settings, DEFAULT_SETTINGS);
export const saveSettings = (s: Settings) => localStorage.setItem(K.settings, JSON.stringify(s));

export const loadSessions = (): Session[] => {
  try {
    const raw = localStorage.getItem(K.sessions);
    return raw ? (JSON.parse(raw) as Session[]) : [];
  } catch {
    return [];
  }
};
export const saveSessions = (s: Session[]) => {
  try {
    localStorage.setItem(K.sessions, JSON.stringify(s.slice(0, 60)));
  } catch {
    /* quota */
  }
};
export const loadActiveSession = () => localStorage.getItem(K.activeSession);
export const saveActiveSession = (id: string) => localStorage.setItem(K.activeSession, id);

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtMB(bytes: number) {
  return (bytes / 1_000_000).toFixed(1);
}
