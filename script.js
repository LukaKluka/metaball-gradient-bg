"use strict";

/**
 * Production-oriented WebGL metaball gradient background.
 *
 * Important performance decisions:
 * - Reduced internal render resolution via `renderScale` (upscaled to CSS size)
 * - DPR capped to avoid ultra-high DPI cost
 * - Typed arrays for uniform uploads (no per-frame allocations)
 * - Page Visibility API pauses animation when tab is hidden
 *
 * Shader uniform layout (arrays are hard-capped to MAX_BLOBS = 8):
 * - u_resolution: vec2 (internal render buffer size)
 * - u_bgColor: vec3 (background/base color)
 * - u_time: float
 * - u_blobCount: int
 * - u_grain: float
 * - u_globalSoftness: float
 * - u_softVar: float
 * - u_distAmount: float
 * - u_distScale: float
 * - u_distSpeed: float
 * - u_blob: vec4[MAX_BLOBS]     -> xy = center in [0..1], z = radius (UV units), w = distortionSeed
 * - u_blobColor: vec3[MAX_BLOBS] -> rgb in [0..1]
 * - u_blobSoftSeed: float[MAX_BLOBS] -> stable seed in [-1..1] for softness variation
 */

const MAX_BLOBS = 8;

// Where to tweak defaults:
const CONFIG = {
  // Render scaling (internal resolution vs CSS size).
  // Desktop default ~0.65, mobile default ~0.5.
  renderScaleDesktop: 0.65,
  renderScaleMobile: 0.5,

  // DPR cap (keeps high-DPI screens from rendering too expensively).
  dprCap: 1.5,

  // Motion time multiplier (tweak overall movement speed here).
  timeScale: 1.0,
};

// Default swatches (required).
const SWATCHES = [
  "#4D1D82",
  "#6C4D97",
  "#9179B1",
  "#B5A6CB",
  "#DAD2E5",
  "#8B1D82",
  "#A24A9B",
  "#B977B4",
  "#D1A5CD",
  "#E8D2E6",
];

// Refined default colors for 3 blobs (darker/mid tones first).
const DEFAULT_3 = ["#4D1D82", "#6C4D97", "#A24A9B"];

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function isProbablyMobile() {
  return (
    matchMedia("(pointer: coarse)").matches ||
    matchMedia("(max-width: 720px)").matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

function hexToRgb01(hex) {
  const h = hex.replace("#", "").trim();
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

// Deterministic pseudo-random in [0..1] from (i, salt).
function rand01(i, salt) {
  const x = Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function pickDefaultColor(i) {
  if (i < DEFAULT_3.length) return DEFAULT_3[i];
  return SWATCHES[i % SWATCHES.length];
}

function createBlob(i) {
  // Base positions biased toward center; motion keeps them near/inside view.
  const baseX = 0.25 + rand01(i, 1.1) * 0.5;
  const baseY = 0.25 + rand01(i, 2.2) * 0.5;

  // Calm drift parameters (cycles per second-ish; used with sin/cos).
  const moveAmpX = 0.08 + rand01(i, 3.3) * 0.14;
  const moveAmpY = 0.08 + rand01(i, 4.4) * 0.14;
  const moveFreqX = 0.03 + rand01(i, 5.5) * 0.06;
  const moveFreqY = 0.03 + rand01(i, 6.6) * 0.06;

  // Radius in UV space (larger feels more gradient-like).
  const radius = 0.16 + rand01(i, 7.7) * 0.18;

  // Subtle pulsing.
  const pulseAmp = 0.03 + rand01(i, 8.8) * 0.06;
  const pulseFreq = 0.08 + rand01(i, 9.9) * 0.18;
  const phase = rand01(i, 10.1) * Math.PI * 2;

  // Seeds for shader-side variation (stable; not re-randomized per frame).
  const softnessSeed = rand01(i, 11.2) * 2 - 1; // [-1..1]
  const distortionSeed = rand01(i, 12.3); // [0..1]

  return {
    color: pickDefaultColor(i),
    baseX,
    baseY,
    moveAmpX,
    moveAmpY,
    moveFreqX,
    moveFreqY,
    radius,
    pulseAmp,
    pulseFreq,
    phase,
    softnessSeed,
    distortionSeed,
  };
}

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) || "Unknown shader compile error.";
    gl.deleteShader(sh);
    throw new Error(info);
  }
  return sh;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) || "Unknown program link error.";
    gl.deleteProgram(prog);
    throw new Error(info);
  }
  return prog;
}

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Notes:
// - Uses soft gaussian-like influences for premium blending
// - Distortion is low-frequency fbm (separate from grain)
// - Grain is high-frequency hash on gl_FragCoord (banding reduction)
function getFragmentShaderSource(precisionLine) {
  return `
${precisionLine}

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform vec3 u_bgColor;
uniform float u_time;
uniform int u_blobCount;
uniform float u_grain;
uniform float u_globalSoftness;
uniform float u_softVar;
uniform float u_distAmount;
uniform float u_distScale;
uniform float u_distSpeed;

uniform vec4 u_blob[${MAX_BLOBS}];
uniform vec3 u_blobColor[${MAX_BLOBS}];
uniform float u_blobSoftSeed[${MAX_BLOBS}];

float hash12(vec2 p) {
  // Fast-ish hash; fine for grain and value noise.
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  // 3 octaves: low-frequency, subtle, performant.
  for (int i = 0; i < 3; i++) {
    v += a * valueNoise(p);
    p = p * 2.02 + 11.7;
    a *= 0.52;
  }
  return v;
}

void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);

  // Aspect-corrected coordinate around center.
  vec2 p = v_uv - 0.5;
  p.x *= aspect;

  // Global low-frequency UV distortion (separate from grain).
  // Kept mild by default for elegant irregularity.
  float t = u_time * u_distSpeed;
  float sc = max(0.0001, u_distScale);
  vec2 dn = vec2(
    fbm(p * sc + vec2(0.0, 0.0) + t * 0.18),
    fbm(p * sc + vec2(17.3, 9.1) - t * 0.14)
  );
  vec2 dvec = (dn - 0.5) * (u_distAmount * 0.22);
  vec2 pp = p + dvec;

  vec3 colorSum = vec3(0.0);
  float wSum = 0.0;

  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    // Branchless enable/disable (keeps loop constant for WebGL1).
    float active = step(float(i), float(u_blobCount - 1));

    vec2 c = u_blob[i].xy - 0.5;
    c.x *= aspect;

    // Per-blob organic shape variation: subtle distance warping via low-freq noise.
    float localN = fbm((pp - c) * (sc * 0.85) + u_blob[i].w * 9.7 + t * 0.10);
    float warp = 1.0 + (localN - 0.5) * (u_distAmount * 0.35);

    float r = max(0.0001, u_blob[i].z);
    float dist = length(pp - c) * warp;

    // Softness varies per blob around global softness using stable seeds.
    float soft = clamp(u_globalSoftness + u_softVar * u_blobSoftSeed[i], 0.35, 2.2);

    // Gaussian-like influence: premium gradients, avoids hard circles.
    float sigma = r * soft;
    float w = exp(-(dist * dist) / (2.0 * sigma * sigma));

    // Slightly emphasize stronger contributions to avoid muddiness.
    float w2 = w * w;

    colorSum += u_blobColor[i] * (w2 * active);
    wSum += w2 * active;
  }

  vec3 base = u_bgColor;
  vec3 blobCol = colorSum / max(1e-5, wSum);

  // Coverage maps field strength to mix amount in a smooth, premium way.
  float coverage = 1.0 - exp(-wSum * 1.25);
  coverage = clamp(coverage, 0.0, 1.0);

  // Subtle vignette (helps text readability and premium depth).
  float v = smoothstep(0.95, 0.20, length(p));

  vec3 col = mix(base, blobCol, coverage);
  col *= mix(0.88, 1.05, v);

  // Fine grain to reduce banding (separate from distortion).
  float g = hash12(gl_FragCoord.xy + vec2(u_time * 0.05, 0.0)) - 0.5;
  col += g * (u_grain * 0.075);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
}

function main() {
  const canvas = document.getElementById("glCanvas");
  const gl = canvas.getContext("webgl", {
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });

  if (!gl) {
    document.body.classList.add("no-webgl");
    console.error("WebGL not supported.");
    return;
  }

  // Optional external config (used by "Embed code" export).
  // If present, this lets the background run without any UI markup on the page.
  const external = typeof window !== "undefined" ? window.METABALL_BG_CONFIG : null;

  // --- State (UI can override these; embed config can pre-set them) ---
  const state = {
    blobCount: 3,
    grain: 0.18,
    distAmount: 0.16,
    distScale: 1.05,
    distSpeed: 0.12,
    globalSoftness: 1.02,
    softVar: 0.12,
    bgColor: "#0B0712",
  };

  if (external && typeof external === "object") {
    const s = external.state && typeof external.state === "object" ? external.state : null;
    if (s) {
      for (const k of [
        "blobCount",
        "grain",
        "distAmount",
        "distScale",
        "distSpeed",
        "globalSoftness",
        "softVar",
      ]) {
        if (typeof s[k] === "number" && Number.isFinite(s[k])) state[k] = s[k];
      }
    }
    if (external.colors && typeof external.colors === "object") {
      if (typeof external.colors.background === "string") state.bgColor = external.colors.background;
    }
  }

  state.blobCount = clamp(state.blobCount | 0, 1, MAX_BLOBS);

  // Stable blob data (max length); we simply change active count.
  const blobs = new Array(MAX_BLOBS);
  for (let i = 0; i < MAX_BLOBS; i++) blobs[i] = createBlob(i);

  // Apply external blob colors (embed mode), if provided.
  if (external && typeof external === "object" && external.colors && typeof external.colors === "object") {
    const arr = external.colors.blobs;
    if (Array.isArray(arr)) {
      for (let i = 0; i < Math.min(MAX_BLOBS, arr.length); i++) {
        if (typeof arr[i] === "string") blobs[i].color = arr[i];
      }
    }
  }

  // Apply external full blob snapshots if provided (preserves motion/feel).
  if (external && typeof external === "object" && Array.isArray(external.blobs)) {
    const n =
      external.state && typeof external.state === "object" && typeof external.state.blobCount === "number"
        ? clamp(external.state.blobCount | 0, 1, MAX_BLOBS)
        : clamp(state.blobCount | 0, 1, MAX_BLOBS);
    for (let i = 0; i < Math.min(n, external.blobs.length); i++) {
      const b = external.blobs[i];
      if (!b || typeof b !== "object") continue;
      for (const k of [
        "baseX",
        "baseY",
        "moveAmpX",
        "moveAmpY",
        "moveFreqX",
        "moveFreqY",
        "radius",
        "pulseAmp",
        "pulseFreq",
        "phase",
        "softnessSeed",
        "distortionSeed",
      ]) {
        if (typeof b[k] === "number" && Number.isFinite(b[k])) blobs[i][k] = b[k];
      }
      if (typeof b.color === "string") blobs[i].color = b.color;
      if (typeof b.distortionSeed === "number" && Number.isFinite(b.distortionSeed)) {
        blobs[i].distortionSeed = b.distortionSeed;
      }
    }
  }

  // --- WebGL setup ---
  // Fragment precision fallback:
  // Some devices (especially older mobile GPUs) don't support highp in fragment shaders.
  const highpFmt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const highpOk = !!highpFmt && highpFmt.precision > 0;
  const fragPrecision = highpOk ? "precision highp float;" : "precision mediump float;";
  const FRAGMENT_SHADER = getFragmentShaderSource(fragPrecision);

  let program;
  try {
    program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  } catch (e) {
    console.error("Shader/program error:", e);
    return;
  }
  gl.useProgram(program);

  // Fullscreen quad (2 triangles).
  const posLoc = gl.getAttribLocation(program, "a_position");
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Uniform locations.
  const uResolution = gl.getUniformLocation(program, "u_resolution");
  const uBgColor = gl.getUniformLocation(program, "u_bgColor");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uBlobCount = gl.getUniformLocation(program, "u_blobCount");
  const uGrain = gl.getUniformLocation(program, "u_grain");
  const uGlobalSoftness = gl.getUniformLocation(program, "u_globalSoftness");
  const uSoftVar = gl.getUniformLocation(program, "u_softVar");
  const uDistAmount = gl.getUniformLocation(program, "u_distAmount");
  const uDistScale = gl.getUniformLocation(program, "u_distScale");
  const uDistSpeed = gl.getUniformLocation(program, "u_distSpeed");
  const uBlob = gl.getUniformLocation(program, "u_blob[0]");
  const uBlobColor = gl.getUniformLocation(program, "u_blobColor[0]");
  const uBlobSoftSeed = gl.getUniformLocation(program, "u_blobSoftSeed[0]");

  // Typed arrays for uniform uploads (reused each frame).
  const blobVec4 = new Float32Array(MAX_BLOBS * 4);
  const blobColor = new Float32Array(MAX_BLOBS * 3);
  const blobSoftSeed = new Float32Array(MAX_BLOBS);
  const bgColor01 = new Float32Array(3);

  for (let i = 0; i < MAX_BLOBS; i++) {
    const [r, g, b] = hexToRgb01(blobs[i].color);
    blobColor[i * 3 + 0] = r;
    blobColor[i * 3 + 1] = g;
    blobColor[i * 3 + 2] = b;
    blobSoftSeed[i] = blobs[i].softnessSeed;
  }
  gl.uniform3fv(uBlobColor, blobColor);
  gl.uniform1fv(uBlobSoftSeed, blobSoftSeed);

  // Background/base color.
  {
    const [r, g, b] = hexToRgb01(state.bgColor);
    bgColor01[0] = r;
    bgColor01[1] = g;
    bgColor01[2] = b;
    gl.uniform3fv(uBgColor, bgColor01);
  }

  // --- Resize + render scale ---
  const renderScale = isProbablyMobile() ? CONFIG.renderScaleMobile : CONFIG.renderScaleDesktop;
  let lastW = 0;
  let lastH = 0;

  function resizeIfNeeded() {
    const cssW = Math.max(1, canvas.clientWidth | 0);
    const cssH = Math.max(1, canvas.clientHeight | 0);
    const dpr = Math.min(CONFIG.dprCap, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(cssW * dpr * renderScale));
    const h = Math.max(1, Math.floor(cssH * dpr * renderScale));
    if (w === lastW && h === lastH) return;

    lastW = w;
    lastH = h;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uResolution, w, h);
  }

  function setBgColor(hex) {
    state.bgColor = hex;
    const [r, g, b] = hexToRgb01(hex);
    bgColor01[0] = r;
    bgColor01[1] = g;
    bgColor01[2] = b;
    gl.uniform3fv(uBgColor, bgColor01);
    updateEmbedCode();
  }

  // --- UI wiring ---
  const $ = (id) => document.getElementById(id);
  const panel = $("panel");
  const panelToggle = $("panelToggle");
  const panelBody = $("panelBody");

  function bindSlider(id, valueId, key, formatFn) {
    const el = $(id);
    const out = $(valueId);
    if (!el || !out) return;
    el.value = String(state[key]);
    out.value = formatFn ? formatFn(state[key]) : String(state[key]);
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      state[key] = v;
      out.value = formatFn ? formatFn(v) : String(v);
      updateEmbedCode();
    });
  }

  function bindIntSlider(id, valueId, key) {
    const el = $(id);
    const out = $(valueId);
    if (!el || !out) return;
    el.value = String(state[key]);
    out.value = String(state[key]);
    el.addEventListener("input", () => {
      const v = parseInt(el.value, 10);
      state[key] = v;
      out.value = String(v);
      rebuildBlobControls();
      updateEmbedCode();
    });
  }

  if (panel && panelToggle && panelBody) {
    panelToggle.addEventListener("click", () => {
      const isHidden = panel.classList.toggle("is-hidden");
      panelToggle.textContent = isHidden ? "Show" : "Hide";
      panelToggle.setAttribute("aria-expanded", isHidden ? "false" : "true");
      panelBody.style.display = isHidden ? "none" : "";
    });
  }

  bindIntSlider("blobCount", "blobCountValue", "blobCount");
  bindSlider("grain", "grainValue", "grain", (v) => v.toFixed(2));
  bindSlider("distAmount", "distAmountValue", "distAmount", (v) => v.toFixed(2));
  bindSlider("distScale", "distScaleValue", "distScale", (v) => v.toFixed(2));
  bindSlider("distSpeed", "distSpeedValue", "distSpeed", (v) => v.toFixed(2));
  bindSlider("globalSoftness", "globalSoftnessValue", "globalSoftness", (v) => v.toFixed(2));
  bindSlider("softVar", "softVarValue", "softVar", (v) => v.toFixed(2));

  const blobControlsEl = $("blobControls");
  const bgColorEl = $("bgColor");
  const bgSwatchesEl = $("bgSwatches");

  function buildSwatches(container, onPick) {
    if (!container) return;
    container.textContent = "";
    for (const hex of SWATCHES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch";
      btn.style.background = hex;
      btn.title = hex;
      btn.addEventListener("click", () => onPick(hex));
      container.appendChild(btn);
    }
  }

  function setBlobColor(i, hex) {
    blobs[i].color = hex;
    const [r, g, b] = hexToRgb01(hex);
    blobColor[i * 3 + 0] = r;
    blobColor[i * 3 + 1] = g;
    blobColor[i * 3 + 2] = b;
    // Upload only when changed (cheap).
    gl.uniform3fv(uBlobColor, blobColor);
    updateEmbedCode();
  }

  function buildSwatchesRow(i, colorInput) {
    const row = document.createElement("div");
    row.className = "swatches";
    buildSwatches(row, (hex) => {
      colorInput.value = hex;
      setBlobColor(i, hex);
    });
    return row;
  }

  function ensureDefaultsUpToCount(n) {
    // Preserve colors where possible; when enabling a blob first time, ensure palette-based default.
    for (let i = 0; i < n; i++) {
      if (!blobs[i].color) setBlobColor(i, pickDefaultColor(i));
    }
  }

  function rebuildBlobControls() {
    if (!blobControlsEl) return;
    const n = clamp(state.blobCount | 0, 1, MAX_BLOBS);
    state.blobCount = n;
    ensureDefaultsUpToCount(n);

    blobControlsEl.textContent = "";

    for (let i = 0; i < n; i++) {
      const wrap = document.createElement("div");
      wrap.className = "blob";

      const head = document.createElement("div");
      head.className = "blob__head";

      const label = document.createElement("div");
      label.className = "blob__label";
      label.textContent = `Blob ${i + 1}`;

      const color = document.createElement("input");
      color.type = "color";
      color.value = blobs[i].color;
      color.addEventListener("input", () => setBlobColor(i, color.value));

      head.appendChild(label);
      head.appendChild(color);
      wrap.appendChild(head);
      wrap.appendChild(buildSwatchesRow(i, color));

      blobControlsEl.appendChild(wrap);
    }
  }

  // Background color UI (optional; exists in editor page, not required for embed mode).
  if (bgColorEl) {
    bgColorEl.value = state.bgColor;
    bgColorEl.addEventListener("input", () => setBgColor(bgColorEl.value));
  }
  buildSwatches(bgSwatchesEl, (hex) => {
    if (bgColorEl) bgColorEl.value = hex;
    setBgColor(hex);
  });

  // --- Embed code export (optional) ---
  const exportEl = $("export");
  const embedToggle = $("embedToggle");
  const exportBody = $("exportBody");
  const embedCodeEl = $("embedCode");
  const copyEmbedBtn = $("copyEmbed");
  const saveVersionBtn = $("saveVersion");
  const savedListEl = $("savedList");

  function serializeConfig() {
    const n = clamp(state.blobCount | 0, 1, MAX_BLOBS);
    return {
      schema: 1,
      savedAt: Date.now(),
      state: {
        blobCount: n,
        grain: state.grain,
        distAmount: state.distAmount,
        distScale: state.distScale,
        distSpeed: state.distSpeed,
        globalSoftness: state.globalSoftness,
        softVar: state.softVar,
      },
      colors: {
        background: state.bgColor,
        blobs: blobs.slice(0, n).map((b) => b.color),
      },
      // Full metaball parameters to preserve the exact motion/feel across saves/embeds.
      blobs: blobs.slice(0, n).map((b) => ({
        baseX: b.baseX,
        baseY: b.baseY,
        moveAmpX: b.moveAmpX,
        moveAmpY: b.moveAmpY,
        moveFreqX: b.moveFreqX,
        moveFreqY: b.moveFreqY,
        radius: b.radius,
        pulseAmp: b.pulseAmp,
        pulseFreq: b.pulseFreq,
        phase: b.phase,
        softnessSeed: b.softnessSeed,
        distortionSeed: b.distortionSeed,
        color: b.color,
      })),
    };
  }

  function buildEmbedSnippet() {
    // VEV-ready: one container div + one <style> + one <script>, fully inline, no file paths.
    const cfgObj = serializeConfig();
    const cfg = JSON.stringify(cfgObj, null, 2);
    const bg = (cfgObj && cfgObj.colors && cfgObj.colors.background) || "#0b0712";
    // Critical: make each snippet instance-scoped so multiple embeds on one page
    // can coexist with different presets without interfering with each other.
    const instanceId = `metaball-gradient-${cfgObj.savedAt || Date.now()}`;
    return (
      `<div id="${instanceId}"></div>\n\n` +
      `<style>\n` +
      // VEV note: many embed wrappers only work reliably when the root has an explicit min-height.
      // We DO NOT hard-set pixel height in JS; we resize the WebGL buffer from measured container size.
      `  #${instanceId}{position:relative;display:block;width:100%;height:100%;min-height:240px;overflow:hidden;background:${bg};isolation:isolate;}\n` +
      `  #${instanceId} canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;}\n` +
      `  #${instanceId} .mbg-fallback{position:absolute;inset:12px;z-index:3;display:grid;place-items:center;text-align:center;color:rgba(255,255,255,.88);background:rgba(10,6,16,.35);border:1px solid rgba(255,255,255,.10);border-radius:14px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);padding:18px;}\n` +
      `</style>\n\n` +
      `<script>\n` +
      `(function(){\n` +
      `  "use strict";\n` +
      `  var ROOT_ID=${JSON.stringify(instanceId)};\n` +
      `  var PRESET=${cfg};\n` +
      `  function clamp(x,a,b){return Math.max(a,Math.min(b,x));}\n` +
      `  function hexToRgb01(hex){var h=String(hex||"").replace("#","").trim();if(h.length!==6)return[0,0,0];return[parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255];}\n` +
      `  function rand01(i,salt){var x=Math.sin((i+1)*127.1+salt*311.7)*43758.5453123;return x-Math.floor(x);}\n` +
      `  var MAX_BLOBS=8;\n` +
      `  var SWATCHES=${JSON.stringify(SWATCHES)};\n` +
      `  var DEFAULT_3=${JSON.stringify(DEFAULT_3)};\n` +
      `  function pickDefaultColor(i){return i<DEFAULT_3.length?DEFAULT_3[i]:SWATCHES[i%SWATCHES.length];}\n` +
      `  function createBlob(i){return{color:pickDefaultColor(i),baseX:0.25+rand01(i,1.1)*0.5,baseY:0.25+rand01(i,2.2)*0.5,moveAmpX:0.08+rand01(i,3.3)*0.14,moveAmpY:0.08+rand01(i,4.4)*0.14,moveFreqX:0.03+rand01(i,5.5)*0.06,moveFreqY:0.03+rand01(i,6.6)*0.06,radius:0.16+rand01(i,7.7)*0.18,pulseAmp:0.03+rand01(i,8.8)*0.06,pulseFreq:0.08+rand01(i,9.9)*0.18,phase:rand01(i,10.1)*Math.PI*2,softnessSeed:rand01(i,11.2)*2-1,distortionSeed:rand01(i,12.3)};}\n` +
      `  function init(root){\n` +
      `    if(!root) return;\n` +
      `    root.innerHTML="";\n` +
      `    var canvas=document.createElement("canvas");canvas.setAttribute("aria-hidden","true");root.appendChild(canvas);\n` +
      `    function $(sel){return root.querySelector(sel);}\n` +
      `    var renderScale=0.65, dprCap=1.5;\n` +
      `    var state={blobCount:3,grain:0.18,distAmount:0.16,distScale:1.05,distSpeed:0.12,globalSoftness:1.02,softVar:0.12};\n` +
      `    if(PRESET && PRESET.state){for(var k in PRESET.state){if(typeof PRESET.state[k]==="number") state[k]=PRESET.state[k];}}\n` +
      `    state.blobCount=clamp(state.blobCount|0,1,MAX_BLOBS);\n` +
      `    var blobs=new Array(MAX_BLOBS);for(var i=0;i<MAX_BLOBS;i++) blobs[i]=createBlob(i);\n` +
      `    if(PRESET && Array.isArray(PRESET.blobs)){for(var bi=0;bi<Math.min(state.blobCount,PRESET.blobs.length);bi++){var pb=PRESET.blobs[bi];if(pb){for(var kk in pb){if(typeof pb[kk]==="number") blobs[bi][kk]=pb[kk];}if(typeof pb.color==="string") blobs[bi].color=pb.color;}}}\n` +
      `    if(PRESET && PRESET.colors && Array.isArray(PRESET.colors.blobs)){for(var ci=0;ci<Math.min(state.blobCount,PRESET.colors.blobs.length);ci++){if(typeof PRESET.colors.blobs[ci]==="string") blobs[ci].color=PRESET.colors.blobs[ci];}}\n` +
      `    var gl=canvas.getContext("webgl",{antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:false,powerPreference:"low-power"});\n` +
      `    if(!gl){var fb=document.createElement("div");fb.className="mbg-fallback";fb.textContent="WebGL is not supported in this browser/environment.";root.appendChild(fb);return;}\n` +
      `    function compile(type,src){var sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){var info=gl.getShaderInfoLog(sh)||"Shader compile error.";gl.deleteShader(sh);throw new Error(info);}return sh;}\n` +
      `    function link(vs,fs){var p=gl.createProgram();gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){var info=gl.getProgramInfoLog(p)||"Program link error.";gl.deleteProgram(p);throw new Error(info);}return p;}\n` +
      `    var VS='attribute vec2 a_position;varying vec2 v_uv;void main(){v_uv=a_position*0.5+0.5;gl_Position=vec4(a_position,0.0,1.0);}';\n` +
      `    function fragSrc(prec){return prec+'\\n'+\n` +
      `      'varying vec2 v_uv;uniform vec2 u_resolution;uniform vec3 u_bgColor;uniform float u_time;uniform float u_distSpeed;uniform int u_blobCount;uniform float u_grain;uniform float u_globalSoftness;uniform float u_softVar;uniform float u_distAmount;uniform float u_distScale;uniform vec4 u_blob[${MAX_BLOBS}];uniform vec3 u_blobColor[${MAX_BLOBS}];uniform float u_blobSoftSeed[${MAX_BLOBS}];'+\n` +
      `      'float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}'+\n` +
      `      'float valueNoise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);float a=hash12(i);float b=hash12(i+vec2(1.0,0.0));float c=hash12(i+vec2(0.0,1.0));float d=hash12(i+vec2(1.0,1.0));vec2 u=f*f*(3.0-2.0*f);return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;}'+\n` +
      `      'float fbm(vec2 p){float v=0.0;float a=0.55;for(int i=0;i<3;i++){v+=a*valueNoise(p);p=p*2.02+11.7;a*=0.52;}return v;}'+\n` +
      `      'void main(){float aspect=u_resolution.x/max(1.0,u_resolution.y);vec2 p=v_uv-0.5;p.x*=aspect;float sc=max(0.0001,u_distScale);float t=u_time*u_distSpeed;vec2 dn=vec2(fbm(p*sc+vec2(0.0,0.0)+t*0.18),fbm(p*sc+vec2(17.3,9.1)-t*0.14));vec2 dvec=(dn-0.5)*(u_distAmount*0.22);vec2 pp=p+dvec;vec3 colorSum=vec3(0.0);float wSum=0.0;for(int i=0;i<${MAX_BLOBS};i++){float active=step(float(i),float(u_blobCount-1));vec2 c=u_blob[i].xy-0.5;c.x*=aspect;float localN=fbm((pp-c)*(sc*0.85)+u_blob[i].w*9.7+t*0.10);float warp=1.0+(localN-0.5)*(u_distAmount*0.35);float r=max(0.0001,u_blob[i].z);float dist=length(pp-c)*warp;float soft=clamp(u_globalSoftness+u_softVar*u_blobSoftSeed[i],0.35,2.2);float sigma=r*soft;float w=exp(-(dist*dist)/(2.0*sigma*sigma));float w2=w*w;colorSum+=u_blobColor[i]*(w2*active);wSum+=w2*active;}vec3 base=u_bgColor;vec3 blobCol=colorSum/max(1e-5,wSum);float coverage=1.0-exp(-wSum*1.25);coverage=clamp(coverage,0.0,1.0);float v=smoothstep(0.95,0.20,length(p));vec3 col=mix(base,blobCol,coverage);col*=mix(0.88,1.05,v);float g=hash12(gl_FragCoord.xy+vec2(u_time*0.05,0.0))-0.5;col+=g*(u_grain*0.075);gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);}';}\n` +
      `    var hp=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);var prec=(hp&&hp.precision>0)?'precision highp float;':'precision mediump float;';\n` +
      `    var vs=compile(gl.VERTEX_SHADER,VS);var fs=compile(gl.FRAGMENT_SHADER,fragSrc(prec));var prog=link(vs,fs);gl.deleteShader(vs);gl.deleteShader(fs);gl.useProgram(prog);\n` +
      `    var posLoc=gl.getAttribLocation(prog,'a_position');var vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(posLoc);gl.vertexAttribPointer(posLoc,2,gl.FLOAT,false,0,0);\n` +
      `    var uRes=gl.getUniformLocation(prog,'u_resolution');var uBg=gl.getUniformLocation(prog,'u_bgColor');var uTime=gl.getUniformLocation(prog,'u_time');var uDSp=gl.getUniformLocation(prog,'u_distSpeed');var uCnt=gl.getUniformLocation(prog,'u_blobCount');var uGr=gl.getUniformLocation(prog,'u_grain');var uGS=gl.getUniformLocation(prog,'u_globalSoftness');var uSV=gl.getUniformLocation(prog,'u_softVar');var uDA=gl.getUniformLocation(prog,'u_distAmount');var uDS=gl.getUniformLocation(prog,'u_distScale');var uBlob=gl.getUniformLocation(prog,'u_blob[0]');var uCol=gl.getUniformLocation(prog,'u_blobColor[0]');var uSoft=gl.getUniformLocation(prog,'u_blobSoftSeed[0]');\n` +
      `    var blobVec4=new Float32Array(MAX_BLOBS*4);var blobColor=new Float32Array(MAX_BLOBS*3);var blobSoftSeed=new Float32Array(MAX_BLOBS);\n` +
      `    for(var jj=0;jj<MAX_BLOBS;jj++){var rgb=hexToRgb01(blobs[jj].color);blobColor[jj*3]=rgb[0];blobColor[jj*3+1]=rgb[1];blobColor[jj*3+2]=rgb[2];blobSoftSeed[jj]=blobs[jj].softnessSeed;}\n` +
      `    gl.uniform3fv(uCol,blobColor);gl.uniform1fv(uSoft,blobSoftSeed);\n` +
      `    var bgHex=(PRESET&&PRESET.colors&&typeof PRESET.colors.background==='string')?PRESET.colors.background:${JSON.stringify(bg)};var bg01=hexToRgb01(bgHex);gl.uniform3f(uBg,bg01[0],bg01[1],bg01[2]);\n` +
      `    gl.uniform1f(uDSp,(typeof state.distSpeed==='number'&&isFinite(state.distSpeed))?state.distSpeed:0.12);\n` +
      `    function measureSize(){\n` +
      `      // Prefer the root size (VEV often sets the embed block height on the element itself).\n` +
      `      var r=root.getBoundingClientRect();\n` +
      `      var w=r.width||0;var h=r.height||0;\n` +
      `      // If height collapses, fall back to parent wrapper.\n` +
      `      if(h<2 && root.parentElement){\n` +
      `        var pr=root.parentElement.getBoundingClientRect();\n` +
      `        w=Math.max(w,pr.width||0);\n` +
      `        h=Math.max(h,pr.height||0);\n` +
      `      }\n` +
      `      // Last-resort minimum so it stays visible.\n` +
      `      if(h<2) h=240;\n` +
      `      if(w<2) w=2;\n` +
      `      return {w:w,h:h};\n` +
      `    }\n` +
      `    var lastW=0,lastH=0;function resize(){\n` +
      `      var m=measureSize();\n` +
      `      var cssW=Math.max(1,Math.floor(m.w));\n` +
      `      var cssH=Math.max(1,Math.floor(m.h));\n` +
      `      var dpr=Math.min(dprCap,window.devicePixelRatio||1);\n` +
      `      var w=Math.max(2,Math.floor(cssW*dpr*renderScale));\n` +
      `      var h=Math.max(2,Math.floor(cssH*dpr*renderScale));\n` +
      `      if(w===lastW&&h===lastH)return;\n` +
      `      lastW=w;lastH=h;\n` +
      `      canvas.width=w;canvas.height=h;\n` +
      `      gl.viewport(0,0,w,h);\n` +
      `      gl.uniform2f(uRes,w,h);\n` +
      `    }\n` +
      `    resize();\n` +
      `    if(typeof ResizeObserver!=='undefined'){\n` +
      `      var ro=new ResizeObserver(function(){resize();});\n` +
      `      ro.observe(root);\n` +
      `      if(root.parentElement) ro.observe(root.parentElement);\n` +
      `    }else{\n` +
      `      window.addEventListener('resize',function(){resize();});\n` +
      `    }\n` +
      `` +
      `    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);\n` +
      `    var running=true,raf=0,t0=performance.now();\n` +
      `    function stop(){running=false;if(raf)cancelAnimationFrame(raf);raf=0;}\n` +
      `    function start(){if(running)return;running=true;raf=requestAnimationFrame(frame);} \n` +
      `    document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else start();});\n` +
      `    function frame(now){if(!running)return;raf=requestAnimationFrame(frame);resize();var t=(now-t0)*0.001;for(var i=0;i<MAX_BLOBS;i++){var b=blobs[i];var ph=b.phase;var x=b.baseX+b.moveAmpX*Math.sin(t*b.moveFreqX*Math.PI*2+ph)+0.02*Math.sin(t*0.10+b.distortionSeed*6.28);var y=b.baseY+b.moveAmpY*Math.cos(t*b.moveFreqY*Math.PI*2+ph*0.91)+0.02*Math.cos(t*0.08+b.distortionSeed*6.28);var pulse=1+b.pulseAmp*Math.sin(t*b.pulseFreq*Math.PI*2+ph*1.7);var r=b.radius*pulse;var o=i*4;blobVec4[o]=x;blobVec4[o+1]=y;blobVec4[o+2]=r;blobVec4[o+3]=b.distortionSeed;}gl.uniform1f(uTime,t);gl.uniform1i(uCnt,clamp(state.blobCount|0,1,MAX_BLOBS));gl.uniform1f(uGr,state.grain);gl.uniform1f(uGS,state.globalSoftness);gl.uniform1f(uSV,state.softVar);gl.uniform1f(uDA,state.distAmount);gl.uniform1f(uDS,state.distScale);gl.uniform4fv(uBlob,blobVec4);gl.drawArrays(gl.TRIANGLES,0,6);} \n` +
      `    raf=requestAnimationFrame(frame);\n` +
      `  }\n` +
      `  var root=document.getElementById(ROOT_ID);\n` +
      `  if(root) init(root);\n` +
      `})();\n` +
      `</script>\n`
    );
  }

  function updateEmbedCode() {
    if (!embedCodeEl) return;
    embedCodeEl.value = buildEmbedSnippet();
  }

  if (exportEl && embedToggle && exportBody) {
    embedToggle.addEventListener("click", () => {
      const open = !exportEl.classList.contains("is-open");
      exportEl.classList.toggle("is-open", open);
      exportBody.hidden = !open;
      embedToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) updateEmbedCode();
    });
  }

  if (copyEmbedBtn && embedCodeEl) {
    copyEmbedBtn.addEventListener("click", async () => {
      updateEmbedCode();
      const text = embedCodeEl.value;
      try {
        await navigator.clipboard.writeText(text);
        copyEmbedBtn.textContent = "Copied";
        setTimeout(() => (copyEmbedBtn.textContent = "Copy HTML"), 900);
      } catch {
        embedCodeEl.focus();
        embedCodeEl.select();
        document.execCommand("copy");
      }
    });
  }

  // --- Saved versions (optional; uses localStorage) ---
  const STORAGE_KEY = "metaballBg.savedVersions.v1";
  const MAX_SAVES = 20;

  function readSaves() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function writeSaves(arr) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch {
      // ignore storage errors (private mode / quota)
    }
  }

  function fmtTime(ms) {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  }

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    const s = cfg.state && typeof cfg.state === "object" ? cfg.state : null;
    const n = s && typeof s.blobCount === "number" ? clamp(s.blobCount | 0, 1, MAX_BLOBS) : null;
    if (s) {
      if (typeof s.grain === "number") state.grain = s.grain;
      if (typeof s.distAmount === "number") state.distAmount = s.distAmount;
      if (typeof s.distScale === "number") state.distScale = s.distScale;
      if (typeof s.distSpeed === "number") state.distSpeed = s.distSpeed;
      if (typeof s.globalSoftness === "number") state.globalSoftness = s.globalSoftness;
      if (typeof s.softVar === "number") state.softVar = s.softVar;
      if (n != null) state.blobCount = n;
    }

    if (cfg.colors && typeof cfg.colors === "object") {
      if (typeof cfg.colors.background === "string") setBgColor(cfg.colors.background);
    }

    // Apply full blob parameter snapshots if present.
    if (Array.isArray(cfg.blobs)) {
      const count = n != null ? n : clamp(state.blobCount | 0, 1, MAX_BLOBS);
      for (let i = 0; i < Math.min(count, cfg.blobs.length); i++) {
        const b = cfg.blobs[i];
        if (!b || typeof b !== "object") continue;
        for (const k of [
          "baseX",
          "baseY",
          "moveAmpX",
          "moveAmpY",
          "moveFreqX",
          "moveFreqY",
          "radius",
          "pulseAmp",
          "pulseFreq",
          "phase",
          "softnessSeed",
          "distortionSeed",
        ]) {
          if (typeof b[k] === "number" && Number.isFinite(b[k])) blobs[i][k] = b[k];
        }
        if (typeof b.color === "string") blobs[i].color = b.color;
      }
    }

    // Refresh uniforms dependent on blob colors / softness seeds.
    const count = clamp(state.blobCount | 0, 1, MAX_BLOBS);
    for (let i = 0; i < MAX_BLOBS; i++) {
      const c = blobs[i].color;
      const [r, g, b] = hexToRgb01(c);
      blobColor[i * 3 + 0] = r;
      blobColor[i * 3 + 1] = g;
      blobColor[i * 3 + 2] = b;
      blobSoftSeed[i] = blobs[i].softnessSeed;
    }
    gl.uniform3fv(uBlobColor, blobColor);
    gl.uniform1fv(uBlobSoftSeed, blobSoftSeed);

    // Update UI inputs (if present).
    const setOut = (id, v) => {
      const el = $(id);
      if (el) el.value = v;
    };
    setOut("blobCount", String(state.blobCount));
    setOut("blobCountValue", String(state.blobCount));
    setOut("grain", String(state.grain));
    setOut("grainValue", state.grain.toFixed(2));
    setOut("distAmount", String(state.distAmount));
    setOut("distAmountValue", state.distAmount.toFixed(2));
    setOut("distScale", String(state.distScale));
    setOut("distScaleValue", state.distScale.toFixed(2));
    setOut("distSpeed", String(state.distSpeed));
    setOut("distSpeedValue", state.distSpeed.toFixed(2));
    setOut("globalSoftness", String(state.globalSoftness));
    setOut("globalSoftnessValue", state.globalSoftness.toFixed(2));
    setOut("softVar", String(state.softVar));
    setOut("softVarValue", state.softVar.toFixed(2));
    const bgInput = $("bgColor");
    if (bgInput) bgInput.value = state.bgColor;

    rebuildBlobControls();
    updateEmbedCode();
  }

  function renderSavedList() {
    if (!savedListEl) return;
    const saves = readSaves();
    savedListEl.textContent = "";

    if (saves.length === 0) {
      const empty = document.createElement("div");
      empty.className = "export__hint";
      empty.textContent = "No saved versions yet.";
      savedListEl.appendChild(empty);
      return;
    }

    for (const item of saves) {
      const wrap = document.createElement("div");
      wrap.className = "savedItem";

      const meta = document.createElement("div");
      meta.className = "savedItem__meta";

      const name = document.createElement("div");
      name.className = "savedItem__name";
      name.textContent = item?.name || "Saved version";

      const time = document.createElement("div");
      time.className = "savedItem__time";
      time.textContent = fmtTime(item?.savedAt || Date.now());

      meta.appendChild(name);
      meta.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "savedItem__actions";

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "btn btn--ghost";
      loadBtn.textContent = "Load";
      loadBtn.addEventListener("click", () => applyConfig(item?.config));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn--danger";
      delBtn.textContent = "Del";
      delBtn.addEventListener("click", () => {
        const next = readSaves().filter((s) => s && s.id !== item.id);
        writeSaves(next);
        renderSavedList();
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);

      wrap.appendChild(meta);
      wrap.appendChild(actions);
      savedListEl.appendChild(wrap);
    }
  }

  if (saveVersionBtn) {
    saveVersionBtn.addEventListener("click", () => {
      const saves = readSaves();
      const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const savedAt = Date.now();
      const name = `Version ${new Date(savedAt).toLocaleString()}`;
      const config = serializeConfig();
      const next = [{ id, name, savedAt, config }, ...saves].slice(0, MAX_SAVES);
      writeSaves(next);
      renderSavedList();
    });
  }

  rebuildBlobControls();
  updateEmbedCode();
  renderSavedList();

  // --- Animation loop ---
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  let running = true;
  let rafId = 0;
  const t0 = performance.now();

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    resizeIfNeeded();

    const t = ((now - t0) * 0.001) * CONFIG.timeScale;

    // Update u_blob array (positions + animated radius). Avoid allocations.
    const n = state.blobCount | 0;
    for (let i = 0; i < MAX_BLOBS; i++) {
      const b = blobs[i];

      const phase = b.phase;
      const x =
        b.baseX +
        b.moveAmpX * Math.sin((t * b.moveFreqX) * Math.PI * 2 + phase) +
        0.02 * Math.sin(t * 0.10 + b.distortionSeed * 6.28);
      const y =
        b.baseY +
        b.moveAmpY * Math.cos((t * b.moveFreqY) * Math.PI * 2 + phase * 0.91) +
        0.02 * Math.cos(t * 0.08 + b.distortionSeed * 6.28);

      const pulse = 1 + b.pulseAmp * Math.sin((t * b.pulseFreq) * Math.PI * 2 + phase * 1.7);
      const r = b.radius * pulse;

      const o = i * 4;
      blobVec4[o + 0] = x;
      blobVec4[o + 1] = y;
      blobVec4[o + 2] = r;
      blobVec4[o + 3] = b.distortionSeed;
    }

    gl.uniform1f(uTime, t);
    gl.uniform1i(uBlobCount, n);
    gl.uniform1f(uGrain, state.grain);
    gl.uniform1f(uGlobalSoftness, state.globalSoftness);
    gl.uniform1f(uSoftVar, state.softVar);
    gl.uniform1f(uDistAmount, state.distAmount);
    gl.uniform1f(uDistScale, state.distScale);
    gl.uniform1f(uDistSpeed, state.distSpeed);
    gl.uniform4fv(uBlob, blobVec4);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    // Required: pause on hidden tab, resume when visible.
    if (document.hidden) stop();
    else start();
  });

  window.addEventListener("resize", () => {
    // Resize work is done in-frame, but this ensures we react quickly.
    // (No expensive work here: just mark sizes to update next frame.)
    lastW = 0;
    lastH = 0;
  });

  // Initial size and start loop.
  resizeIfNeeded();
  rafId = requestAnimationFrame(frame);
}

main();

