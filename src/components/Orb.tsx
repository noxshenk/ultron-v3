import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass }     from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass }     from "three/examples/jsm/postprocessing/OutputPass.js";

export type OrbMode = "idle" | "listening" | "thinking" | "speaking";

interface Props {
  accent: string;
  secondary: string;
  mode: OrbMode;
}

/* ------------------------------------------------------------------ */
/* GLSL: Ashima 3D simplex noise                                       */
/* ------------------------------------------------------------------ */
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;
/* Shared plate field: domain-warped simplex noise. Its zero-crossings form a
   maze of thin channels that split the shell into rounded "coral" plates. */
const FIELD_GLSL = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uGap;
float plateField(vec3 p) {
  float t = uTime * uSpeed;
  vec3 q = p * 1.55 + vec3(0.0, t * 0.12, t * 0.08);
  vec3 w = vec3(
    snoise(q + vec3(1.7, 9.2, 0.0)),
    snoise(q + vec3(8.3, 2.8, 4.1)),
    snoise(q + vec3(3.1, 5.7, 7.3)));
  float f = abs(snoise(q * 1.2 + w * 0.6));
  // scattered round pores that open straight onto the glowing core
  float pore = snoise(p * 3.4 - vec3(t * 0.05) );
  f = min(f, smoothstep(-0.78, -0.45, pore) * 1.0);
  return f;
}
float plateHeight(float f) {
  return smoothstep(uGap, uGap + 0.26, f);
}
`;

/* Outer shell: plates bulge outward from the base radius, normals rebuilt */
const SHELL_VERT = /* glsl */ `
uniform float uLift;
uniform float uExpand;
varying vec3 vObj;
varying vec3 vViewNormal;
varying vec3 vViewPos;
${NOISE_GLSL}
${FIELD_GLSL}
vec3 shellPoint(vec3 dir) {
  float h = plateHeight(plateField(dir));
  // pillow profile: rounded top, steep edges
  float pillow = sqrt(h);
  return dir * (1.5 + uExpand + pillow * uLift);
}
void main() {
  vec3 dir = normalize(position);
  vObj = dir;
  vec3 up = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tang = normalize(cross(dir, up));
  vec3 bitang = normalize(cross(dir, tang));
  float eps = 0.02;
  vec3 p0 = shellPoint(dir);
  vec3 pA = shellPoint(normalize(dir + tang * eps));
  vec3 pB = shellPoint(normalize(dir + bitang * eps));
  vec3 nrm = normalize(cross(pA - p0, pB - p0));
  if (dot(nrm, dir) < 0.0) nrm = -nrm;

  vec4 mv = modelViewMatrix * vec4(p0, 1.0);
  vViewPos = mv.xyz;
  vViewNormal = normalize(normalMatrix * nrm);
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAG = /* glsl */ `
uniform vec3 uShell;
uniform vec3 uColorAccent;
uniform vec3 uColorLight;
uniform float uGlow;
uniform float uPulse;
varying vec3 vObj;
varying vec3 vViewNormal;
varying vec3 vViewPos;
${NOISE_GLSL}
${FIELD_GLSL}
void main() {
  float f = plateField(normalize(vObj));
  if (f < uGap) discard;
  float edge = plateHeight(f);

  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(-vViewPos);

  // If back face (inside wall seen through crack openings):
  if (!gl_FrontFacing) {
    // Back of plates illuminated by the glowing core inside
    vec3 inner = uColorAccent * 0.45 * (0.8 + uPulse * 0.5);
    gl_FragColor = vec4(inner, 1.0);
    return;
  }

  // Ensure normal points toward viewer for crisp front shading
  if (dot(n, v) < 0.0) n = -n;

  /* ---- AMBIENT OCCLUSION & CAVITY SHADOWS ---- */
  float ao = smoothstep(0.0, 0.45, edge);

  /* ---- DIRECTIONAL KEY LIGHT (Upper-Left Key) ---- */
  vec3 Lkey = normalize(vec3(-0.55, 0.8, 0.65));
  float NdotL = dot(n, Lkey);
  // Realistic PBR diffuse falloff with smooth shadow terminator
  float diffKey = smoothstep(-0.15, 0.65, NdotL);
  float keyShadow = smoothstep(-0.25, 0.35, NdotL);

  /* ---- FILL LIGHT (Cool secondary bounce from bottom-right) ---- */
  vec3 Lfill = normalize(vec3(0.5, -0.6, -0.2));
  float NdotLFill = max(0.0, dot(n, Lfill));
  float diffFill = NdotLFill * 0.22;

  /* ---- DARK OBSIDIAN / GRAPHITE ARMOR BODY ---- */
  // Ambient base on dark plates
  vec3 ambient = uShell * 0.35 * ao;
  // Key diffuse illuminated body
  vec3 diffuse = uShell * (diffKey * 0.85 + diffFill) * ao;
  vec3 col = ambient + diffuse;

  /* ---- SPECULAR HIGHLIGHTS (Subtle glossy glint on dark armor) ---- */
  vec3 H = normalize(Lkey + v);
  float nh = max(dot(n, H), 0.0);
  float specSharp = pow(nh, 90.0) * 0.75;
  float specSoft  = pow(nh, 20.0) * 0.15;
  col += (vec3(specSharp) + uColorLight * specSoft) * keyShadow * ao * 0.45;

  /* ---- SUBSURFACE TRANSMISSION (Core light bleeding through thinning plate edges) ---- */
  float sssMask = pow(1.0 - edge, 2.5);
  vec3 sssColor = mix(uColorAccent, uColorLight, 0.35);
  col += sssColor * sssMask * (0.55 + uGlow * 0.35 + uPulse * 0.25);

  /* ---- INCANDESCENT CORE CRACK SEAMS (Light bursting from under the armor) ---- */
  float crack = smoothstep(0.16, 0.0, edge);
  vec3 crackGlow = mix(uColorAccent * 2.2, vec3(1.0), crack * 0.4);
  col += crackGlow * crack * (0.9 + uPulse * 0.7);

  /* ---- SUBTLE FRESNEL EDGE ---- */
  float NdotV = clamp(dot(n, v), 0.0, 1.0);
  float fresnel = pow(1.0 - NdotV, 3.5);
  col += uColorAccent * fresnel * 0.35 * ao;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* Glowing inner core */
const CORE_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vViewNormal;
varying vec3 vViewPos;
void main() {
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const CORE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform vec3 uColorDeep;
uniform vec3 uColorAccent;
uniform vec3 uColorLight;
uniform float uIntensity;
varying vec3 vObj;
varying vec3 vViewNormal;
varying vec3 vViewPos;
${NOISE_GLSL}
void main() {
  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(-vViewPos);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float t = uTime * uSpeed;

  float swirl  = snoise(vObj * 1.6 + vec3(t * 0.4, -t * 0.3, t * 0.2));
  float swirl2 = snoise(vObj * 2.8 + vec3(-t * 0.2, t * 0.3, -t * 0.1)) * 0.45;
  float detail = snoise(vObj * 6.0 + vec3(t * 0.15)) * 0.12;
  float totalSwirl = clamp(swirl + swirl2 + detail, -1.0, 1.0);

  float sparks = smoothstep(0.68, 0.96, snoise(vObj * 4.5 - vec3(t * 0.6)));

  // Rich, controlled core with subtle internal plasma filaments
  vec3 col = mix(uColorDeep * 0.3, uColorAccent * 0.95, smoothstep(-0.4, 0.5, totalSwirl));
  col = mix(col, uColorLight * 1.25, pow(facing, 3.2) * 0.45 + sparks * 0.5);

  // Deep shadow folds across turbulent plasma
  float shadowPockets = smoothstep(-0.7, 0.3, totalSwirl);
  col *= (0.3 + 0.7 * shadowPockets);

  // Limb darkening to give real spherical depth
  float limb = pow(1.0 - facing, 2.5);
  col = mix(col, uColorDeep * 0.15, limb * 0.85);

  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

/* Glass bubbles drifting around the orb */
const BUBBLE_VERT = /* glsl */ `
varying vec3 vViewNormal;
varying vec3 vViewPos;
void main() {
  vec4 world = instanceMatrix * vec4(position, 1.0);
  vec4 mv = modelViewMatrix * world;
  vViewPos = mv.xyz;
  vViewNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const BUBBLE_FRAG = /* glsl */ `
uniform vec3 uColorAccent;
uniform vec3 uColorLight;
uniform float uOpacity;
varying vec3 vViewNormal;
varying vec3 vViewPos;
void main() {
  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(-vViewPos);
  float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.2);
  float spec = pow(max(dot(reflect(normalize(vec3(-0.5, 0.8, 0.7)), n), v), 0.0), 40.0);
  vec3 col = mix(uColorAccent, uColorLight, fres) + vec3(spec);
  float a = (0.06 + fres * 0.8 + spec) * uOpacity;
  gl_FragColor = vec4(col, a);
}
`;

/* Soft radial halo rendered behind the orb */
const HALO_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HALO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFalloff;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - d, 0.0), uFalloff);
  gl_FragColor = vec4(uColor, a * uOpacity);
}
`;

/* Per-mode animation targets ------------------------------------------ */
interface OrbTuning {
  gap: number;      // channel width between plates
  lift: number;     // plate thickness
  expand: number;   // shell pushed away from the core
  speed: number;    // how fast the plate pattern morphs
  glow: number;     // edge glow strength
  core: number;     // core brightness
  breathe: number;  // scale breathing
  spin: number;     // self rotation
  halo: number;     // halo opacity
  haloScale: number;
}

const TUNING: Record<OrbMode, OrbTuning> = {
  idle:      { gap: 0.075, lift: 0.22, expand: 0.0,  speed: 0.20, glow: 0.50, core: 0.85, breathe: 0.010, spin: 0.035, halo: 0.16, haloScale: 1.30 },
  listening: { gap: 0.085, lift: 0.23, expand: 0.01, speed: 0.40, glow: 0.65, core: 0.95, breathe: 0.018, spin: 0.07,  halo: 0.20, haloScale: 1.40 },
  thinking:  { gap: 0.100, lift: 0.25, expand: 0.02, speed: 0.90, glow: 0.75, core: 1.05, breathe: 0.022, spin: 0.18,  halo: 0.25, haloScale: 1.50 },
  speaking:  { gap: 0.110, lift: 0.26, expand: 0.03, speed: 0.70, glow: 0.85, core: 1.15, breathe: 0.030, spin: 0.09,  halo: 0.32, haloScale: 1.60 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const WHITE = new THREE.Color(0xffffff);
const DARK_SHELL = new THREE.Color("#0c1018");

interface Bubble {
  angle: number;
  radius: number;
  y: number;
  z: number;
  size: number;
  speed: number;
  bob: number;
  phase: number;
}

export default function Orb({ accent, secondary, mode }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const modeRef = useRef<OrbMode>(mode);
  const colorsRef = useRef({ accent, secondary });
  modeRef.current = mode;
  colorsRef.current = { accent, secondary };

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.touchAction = "none";
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 5.8;

    /* ---------- bloom post-processing ---------- */
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(el.clientWidth || 300, el.clientHeight || 300),
      1.1,   // strength
      0.35,  // radius
      0.45,  // threshold — only incandescent cracks & core bloom, dark plates remain crisp!
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    const group = new THREE.Group();
    scene.add(group);

    const accentC = new THREE.Color(accent);
    const lightC = accentC.clone().lerp(WHITE, 0.6);
    // Dark armor plate body with subtle persona tint
    const shellC = DARK_SHELL.clone().lerp(accentC, 0.12);

    /* ---------- soft halo behind the orb ---------- */
    const haloUniforms = {
      uColor: { value: accentC.clone() },
      uOpacity: { value: TUNING.idle.halo },
      uFalloff: { value: 3.0 },
    };
    const haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: haloUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
    halo.renderOrder = -1;
    scene.add(halo); // stays camera-facing, outside the drag-rotated group

    /* ---------- glowing core ---------- */
    const coreGeo = new THREE.SphereGeometry(1.32, 64, 48);
    const coreUniforms = {
      uTime: { value: 0 },
      uSpeed: { value: TUNING.idle.speed },
      uIntensity: { value: TUNING.idle.core },
      uColorDeep: { value: new THREE.Color(secondary) },
      uColorAccent: { value: accentC.clone() },
      uColorLight: { value: lightC.clone() },
    };
    const coreMat = new THREE.ShaderMaterial({ vertexShader: CORE_VERT, fragmentShader: CORE_FRAG, uniforms: coreUniforms });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    /* ---------- porcelain coral shell ---------- */
    const shellGeo = new THREE.SphereGeometry(1, 180, 130); // indexed: far fewer vertex-shader runs than an icosphere
    const shellUniforms = {
      uTime: { value: 0 },
      uSpeed: { value: TUNING.idle.speed },
      uGap: { value: TUNING.idle.gap },
      uLift: { value: TUNING.idle.lift },
      uExpand: { value: 0 },
      uGlow: { value: TUNING.idle.glow },
      uPulse: { value: 0 },
      uShell: { value: shellC.clone() },
      uColorAccent: { value: accentC.clone() },
      uColorLight: { value: lightC.clone() },
    };
    const shellMat = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      uniforms: shellUniforms,
      side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    group.add(shell);

    /* ---------- drifting glass bubbles ---------- */
    const BUBBLES = 26;
    const bubbles: Bubble[] = Array.from({ length: BUBBLES }, (_, i) => ({
      angle: (i / BUBBLES) * Math.PI * 2 + Math.random() * 0.6,
      radius: 2.65 + Math.random() * 1.3,
      y: -1.9 + Math.random() * 3.6,
      z: Math.random() * 0.8 - 0.4,
      size: 0.035 + Math.random() * 0.075,
      speed: (0.04 + Math.random() * 0.08) * (Math.random() < 0.5 ? -1 : 1),
      bob: 0.06 + Math.random() * 0.14,
      phase: Math.random() * Math.PI * 2,
    }));
    const bubbleGeo = new THREE.SphereGeometry(1, 20, 14);
    const bubbleUniforms = {
      uColorAccent: { value: accentC.clone() },
      uColorLight: { value: lightC.clone() },
      uOpacity: { value: 0.8 },
    };
    const bubbleMat = new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      uniforms: bubbleUniforms,
      transparent: true,
      depthWrite: false,
    });
    const bubbleMesh = new THREE.InstancedMesh(bubbleGeo, bubbleMat, BUBBLES);
    bubbleMesh.frustumCulled = false;
    scene.add(bubbleMesh);
    const dummy = new THREE.Object3D();

    /* halo plane sits right behind the orb as a localized soft glow */
    const fitHalo = () => {
      halo.scale.setScalar(5.2);
    };

    /* ---------- drag to rotate ---------- */
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let velX = 0;
    let velY = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      velY = (e.clientX - lastX) * 0.008;
      velX = (e.clientY - lastY) * 0.008;
      group.rotation.y += velY;
      group.rotation.x += velX;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = () => (dragging = false);
    renderer.domElement.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);

    const resize = () => {
      const w = el.clientWidth || 300;
      const h = el.clientHeight || 300;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloomPass.resolution.set(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fitHalo();
      // keep bubbles inside narrow viewports
      const spread = Math.min(1, camera.aspect / 1.6);
      bubbleSpread = 0.65 + spread * 0.35;
    };
    let bubbleSpread = 1;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    /* ---------- animation loop ---------- */
    const cur: OrbTuning = { ...TUNING.idle };
    let pulsePhase = 0;
    let morph = 0;
    const tmpAccent = new THREE.Color();
    const tmpSecondary = new THREE.Color();
    const tmpLight = new THREE.Color();
    const tmpShell = new THREE.Color();
    const clock = new THREE.Clock();
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const m = modeRef.current;
      const target = TUNING[m];

      // smooth transitions between modes
      const k = 1 - Math.pow(0.0025, dt); // frame-rate independent smoothing
      (Object.keys(cur) as (keyof OrbTuning)[]).forEach((key) => {
        cur[key] = lerp(cur[key], target[key], k);
      });

      // persona color cross-fade
      tmpAccent.set(colorsRef.current.accent);
      tmpSecondary.set(colorsRef.current.secondary);
      tmpLight.copy(tmpAccent).lerp(WHITE, 0.6);
      tmpShell.copy(DARK_SHELL).lerp(tmpAccent, 0.12);
      shellUniforms.uColorAccent.value.lerp(tmpAccent, k);
      shellUniforms.uColorLight.value.lerp(tmpLight, k);
      shellUniforms.uShell.value.lerp(tmpShell, k);
      coreUniforms.uColorAccent.value.lerp(tmpAccent, k);
      coreUniforms.uColorDeep.value.lerp(tmpSecondary, k);
      coreUniforms.uColorLight.value.lerp(tmpLight, k);
      bubbleUniforms.uColorAccent.value.lerp(tmpAccent, k);
      bubbleUniforms.uColorLight.value.lerp(tmpLight, k);
      haloUniforms.uColor.value.lerp(tmpAccent, k);

      // speaking pulse: organic double-wave, otherwise slow breathing
      let pulse: number;
      if (m === "speaking") {
        pulsePhase += dt * 9.5;
        pulse = (Math.sin(pulsePhase) * 0.5 + Math.sin(pulsePhase * 2.7 + 1.3) * 0.5) * 0.5 + 0.5;
      } else {
        pulsePhase += dt * 1.6;
        pulse = (Math.sin(pulsePhase) * 0.5 + 0.5) * 0.35;
      }

      // accumulate morph time so speed changes never make the pattern jump
      morph += dt * cur.speed;
      shellUniforms.uTime.value = morph;
      shellUniforms.uSpeed.value = 1;
      coreUniforms.uTime.value = morph;
      coreUniforms.uSpeed.value = 1;

      shellUniforms.uGap.value = cur.gap + pulse * (m === "speaking" ? 0.035 : 0.008);
      shellUniforms.uLift.value = cur.lift;
      shellUniforms.uExpand.value = cur.expand * (0.5 + pulse);
      shellUniforms.uGlow.value = cur.glow;
      shellUniforms.uPulse.value = pulse;
      coreUniforms.uIntensity.value = cur.core * (0.9 + pulse * 0.3);

      // breathing scale, amplified while speaking
      const breathe = 1 + Math.sin(t * (m === "speaking" ? 5.2 : 1.4)) * cur.breathe;
      group.scale.setScalar(breathe);

      // halo reaction — always billboarded to the camera; wider falloff when active
      halo.quaternion.copy(camera.quaternion);
      haloUniforms.uOpacity.value = cur.halo * (0.75 + pulse * 0.35);
      haloUniforms.uFalloff.value = 3.6 - (cur.haloScale - 1.5) * 2.2;

      // bubbles orbit slowly and bob; they drift faster when the orb is active
      const drift = 0.6 + cur.glow;
      for (let i = 0; i < BUBBLES; i++) {
        const b = bubbles[i];
        b.angle += b.speed * dt * drift;
        const r = b.radius * bubbleSpread;
        dummy.position.set(
          Math.cos(b.angle) * r,
          b.y + Math.sin(t * 0.7 + b.phase) * b.bob,
          Math.sin(b.angle) * r * 0.45 + b.z,
        );
        dummy.scale.setScalar(b.size * (1 + pulse * 0.08));
        dummy.updateMatrix();
        bubbleMesh.setMatrixAt(i, dummy.matrix);
      }
      bubbleMesh.instanceMatrix.needsUpdate = true;

      // gentle self-rotation + inertia from drag
      if (!dragging) {
        group.rotation.y += (cur.spin + velY) * dt * 8;
        group.rotation.x += velX * dt * 8;
        velX *= 0.92;
        velY *= 0.92;
      }

      // pulse bloom strength
      bloomPass.strength = 0.85 + pulse * 0.3 + cur.glow * 0.2;

      composer.render();
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      shellGeo.dispose();
      shellMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      bubbleGeo.dispose();
      bubbleMat.dispose();
      bubbleMesh.dispose();
      halo.geometry.dispose();
      haloMat.dispose();
      renderer.dispose();
      composer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="absolute inset-0" />;
}
