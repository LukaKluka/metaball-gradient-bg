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
uniform float u_edgeBlurMin;
uniform float u_edgeBlurMax;
uniform float u_edgeBlurMix;
uniform int u_overlayMode;
uniform int u_glassShapeType;
uniform float u_glassAmount;
uniform float u_glassDistortion;
uniform float u_glassHighlight;
uniform float u_glassSoftness;
uniform int u_glassCount;
uniform int u_glassBandsCount;
uniform float u_glassRotate;
uniform float u_glassTwirl;
uniform float u_glassCirclesAmount;
uniform float u_glassCirclesScale;
uniform float u_glassCirclesRotate;
uniform float u_glassCirclesThickness;
uniform float u_glassCirclesStretch;
uniform float u_waveAmount;
uniform float u_waveScale;
uniform float u_waveSpeed;
uniform float u_waveAngle;
uniform float u_waveDetail;
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

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
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

  // --- Metaball field (base layer) ---
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

    // Edge Blur: adjusts edge softness without changing sigma.
    float seed01 = clamp(u_blobSoftSeed[i] * 0.5 + 0.5, 0.0, 1.0);
    float mix01 = clamp(u_edgeBlurMix * 0.65 + seed01 * 0.35, 0.0, 1.0);
    float blur01 = mix(u_edgeBlurMin, u_edgeBlurMax, mix01);
    w = pow(w, 1.0 / (1.0 + blur01 * 2.0));

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

  vec3 colBase = mix(base, blobCol, coverage);
  colBase *= mix(0.88, 1.05, v);

  // --- Overlay system ---
  // u_overlayMode: 0 None, 1 Fake Glass, 2 Wave Warp
  float glassMask = 0.0;
  vec2 glassOffset = vec2(0.0);
  float glassLight = 0.0;
  float glassRings = 0.0;

  if (u_overlayMode == 1) {
    // Softness needs to be clearly perceptible: it controls edge feather + internal softness cues.
    float feather = mix(0.006, 0.240, clamp(u_glassSoftness, 0.0, 1.0));
    vec2 lp = pp;
    lp = rot2(u_glassRotate) * lp;
    // Twirl = swirl-like warp so bands/ovals can "twist" architecturally.
    float tw = clamp(u_glassTwirl, 0.0, 1.0);
    if (tw > 0.001) {
      float ang = (0.65 + 1.65 * tw) * (lp.y * 0.9 + length(lp) * 0.55);
      lp = rot2(ang * tw) * lp;
    }

    if (u_glassShapeType == 1) {
      // --- Bands: procedural stripe field (supports high counts cheaply) ---
      float cnt = clamp(float(u_glassBandsCount), 6.0, 80.0);
      float ux = lp.x / max(1e-5, aspect) + 0.5;
      float x = ux * cnt;
      float cell = floor(x);
      float r1 = hash12(vec2(cell, 1.23));
      float r2 = hash12(vec2(cell, 7.77));
      // Jitter band spacing slightly.
      float fx = fract(x + (r1 - 0.5) * 0.18) - 0.5;
      float w = mix(0.10, 0.44, r2); // width in "cell fraction"
      float sdf = abs(fx) - w * 0.5;
      float m = 1.0 - smoothstep(0.0, feather, sdf);

      // Band highlight/shadow (graphic): one bright edge, one dark edge.
      float nx = clamp(fx / max(1e-4, w * 0.5), -1.0, 1.0);
      float edgeW = mix(0.18, 0.48, clamp(u_glassSoftness, 0.0, 1.0));
      float hl = smoothstep(-0.10, 0.95, nx) * (1.0 - smoothstep(edgeW, 1.15, abs(nx)));
      float sh = smoothstep(-0.95, 0.10, nx) * (1.0 - smoothstep(edgeW, 1.15, abs(nx)));
      float shade = (hl - sh) * (0.55 + 0.45 * r1);

      vec2 dir = normalize(vec2(1.0, 0.06));
      vec2 wob = vec2(fbm(lp * 1.10 + cell * 0.37 + t * 0.05), fbm(lp * 1.10 + cell * 0.19 - t * 0.04)) - 0.5;

      glassMask = clamp(m, 0.0, 1.0);
      glassLight = clamp(shade, -1.0, 1.0) * glassMask;
      glassOffset = glassMask * (dir * (0.90 + 0.80 * r2) + wob * (0.45 + 0.55 * r1));
      glassOffset *= clamp(u_glassDistortion, 0.0, 1.0) * 0.060;
    } else if (u_glassShapeType == 2) {
      // --- Ovals: limited to 10 for perf ---
      const int MAX_GLASS = 10;
      for (int j = 0; j < MAX_GLASS; j++) {
        float activeG = step(float(j), float(u_glassCount - 1));
        float jj = float(j);

        float r1 = hash12(vec2(jj * 13.17, 1.23));
        float r2 = hash12(vec2(jj * 17.71, 7.77));
        float r3 = hash12(vec2(jj * 23.91, 3.11));
        float r4 = hash12(vec2(jj * 29.77, 9.41));

        vec2 c2 = vec2(mix(-0.45 * aspect, 0.45 * aspect, r1), mix(-0.35, 0.35, r2));
        vec2 sz = vec2(mix(0.18, 0.46, r3) * aspect, mix(0.12, 0.34, r4));
        vec2 d = (lp - c2) / max(vec2(1e-4), sz);
        float distE = length(d);
        float m = 1.0 - smoothstep(1.0 - feather * 1.35, 1.0, distE);

        float ang = (r3 * 6.2831853);
        vec2 dir = normalize(vec2(cos(ang), sin(ang)));
        float shade = clamp(dot(d, dir), -1.0, 1.0) * (0.55 + 0.45 * r2);

        vec2 wob = vec2(
          fbm(lp * 1.25 + jj * 9.7 + t * 0.06),
          fbm(lp * 1.25 + jj * 6.1 - t * 0.05)
        ) - 0.5;

        float mm = m * activeG;
        glassMask += mm;
        glassLight += mm * shade;
        glassOffset += mm * (dir * (0.75 + 0.55 * r1) + wob * (0.55 + 0.85 * r2));
      }

      glassMask = clamp(glassMask, 0.0, 1.0);
      glassOffset *= (clamp(u_glassDistortion, 0.0, 1.0) * 0.090) / max(0.25, float(u_glassCount));
      glassLight = clamp(glassLight, -1.0, 1.0);
    } else {
      // --- Circles: ripple rings style (reference-like) ---
      float ca = clamp(u_glassCirclesAmount, 0.0, 1.0);
      vec2 cp = lp;
      cp = rot2(u_glassCirclesRotate) * cp;
      cp.x *= mix(1.0, 2.35, clamp(u_glassCirclesStretch, 0.0, 1.0));

      float rs = mix(3.5, 28.0, clamp(u_glassCirclesScale, 0.0, 1.0));
      float rr = length(cp) * rs;
      rr += (fbm(cp * 2.2 + t * 0.05) - 0.5) * (0.85 + 1.10 * clamp(u_glassDistortion, 0.0, 1.0));

      float th = mix(0.28, 0.05, clamp(u_glassCirclesThickness, 0.0, 1.0));
      float wave = sin(rr * 6.2831853);
      float ring = 1.0 - smoothstep(0.0, th, abs(wave));
      float alt = cos(rr * 6.2831853);

      vec2 dir = normalize(cp + vec2(1e-4));
      vec2 tang = vec2(-dir.y, dir.x);

      glassMask = 1.0;
      glassLight = (alt) * (0.65 + 0.35 * ring) * ca;
      glassOffset = (dir * (0.65 + 0.60 * ring) + tang * (0.10 + 0.25 * ring)) * (0.040 + 0.060 * ca);
      glassOffset *= clamp(u_glassDistortion, 0.0, 1.0);
      glassRings = (ring - 0.5) * ca;
    }
  }

  vec3 col = colBase;
  float glassMix = (u_overlayMode == 1) ? (clamp(u_glassAmount, 0.0, 1.0) * glassMask) : 0.0;

  if (glassMix > 0.0005) {
    // Recompute metaball field once with a refracted coordinate (no extra render pass).
    vec2 pp2 = pp + glassOffset;

    vec3 colorSum2 = vec3(0.0);
    float wSum2 = 0.0;

    for (int i = 0; i < ${MAX_BLOBS}; i++) {
      float active = step(float(i), float(u_blobCount - 1));
      vec2 c = u_blob[i].xy - 0.5;
      c.x *= aspect;
      float localN = fbm((pp2 - c) * (sc * 0.85) + u_blob[i].w * 9.7 + t * 0.10);
      float warp = 1.0 + (localN - 0.5) * (u_distAmount * 0.35);
      float r = max(0.0001, u_blob[i].z);
      float dist = length(pp2 - c) * warp;
      float soft = clamp(u_globalSoftness + u_softVar * u_blobSoftSeed[i], 0.35, 2.2);
      float sigma = r * soft;
      float w = exp(-(dist * dist) / (2.0 * sigma * sigma));
      float seed01 = clamp(u_blobSoftSeed[i] * 0.5 + 0.5, 0.0, 1.0);
      float mix01 = clamp(u_edgeBlurMix * 0.65 + seed01 * 0.35, 0.0, 1.0);
      float blur01 = mix(u_edgeBlurMin, u_edgeBlurMax, mix01);
      w = pow(w, 1.0 / (1.0 + blur01 * 2.0));
      float w2 = w * w;
      colorSum2 += u_blobColor[i] * (w2 * active);
      wSum2 += w2 * active;
    }

    vec3 blobCol2 = colorSum2 / max(1e-5, wSum2);
    float coverage2 = 1.0 - exp(-wSum2 * 1.25);
    coverage2 = clamp(coverage2, 0.0, 1.0);
    vec3 colRefract = mix(base, blobCol2, coverage2);
    colRefract *= mix(0.88, 1.05, v);

    col = mix(colBase, colRefract, glassMix);

    // Highlight / shadow shaping (graphic glass, not photoreal).
    float hl = clamp(u_glassHighlight, 0.0, 1.0) * 0.065;
    col += glassMix * hl * glassLight * vec3(1.0, 1.0, 1.0);
    col -= glassMix * hl * max(0.0, -glassLight) * vec3(0.85, 0.88, 0.95);

    // Rings texture: subtle structured micro-contrast inside glass only.
    col += glassMix * 0.050 * glassRings * vec3(1.0, 1.0, 1.0);
  }

  // Wave Warp overlay: global smooth warp + optional ridge highlight.
  if (u_overlayMode == 2) {
    float a = clamp(u_waveAmount, 0.0, 1.0);
    float scw = mix(0.8, 6.5, clamp(u_waveScale, 0.0, 1.0));
    float spd = mix(0.05, 0.65, clamp(u_waveSpeed, 0.0, 1.0));
    float ang = u_waveAngle;
    vec2 dir = normalize(vec2(cos(ang), sin(ang)));
    vec2 dir2 = vec2(-dir.y, dir.x);
    float wt = u_time * spd;

    float w1 = sin((dot(pp, dir) * scw) + wt * 1.35);
    float w2 = sin((dot(pp, dir2) * (scw * 0.83)) - wt * 0.95);
    float n = fbm(pp * (scw * 0.55) + vec2(wt * 0.22, -wt * 0.18)) - 0.5;
    float det = mix(0.0, 1.0, clamp(u_waveDetail, 0.0, 1.0));
    float w = 0.62 * w1 + 0.38 * w2 + n * (0.55 * det);

    vec2 wOff = (dir * w + dir2 * (n * 0.9)) * (0.040 * a);
    vec2 ppw = pp + wOff;

    // Recompute metaball field once at warped coordinate.
    vec3 colorSumW = vec3(0.0);
    float wSumW = 0.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
      float active = step(float(i), float(u_blobCount - 1));
      vec2 c = u_blob[i].xy - 0.5;
      c.x *= aspect;
      float localN = fbm((ppw - c) * (sc * 0.85) + u_blob[i].w * 9.7 + t * 0.10);
      float warp = 1.0 + (localN - 0.5) * (u_distAmount * 0.35);
      float r = max(0.0001, u_blob[i].z);
      float dist = length(ppw - c) * warp;
      float soft = clamp(u_globalSoftness + u_softVar * u_blobSoftSeed[i], 0.35, 2.2);
      float sigma = r * soft;
      float ww = exp(-(dist * dist) / (2.0 * sigma * sigma));
      float seed01 = clamp(u_blobSoftSeed[i] * 0.5 + 0.5, 0.0, 1.0);
      float mix01 = clamp(u_edgeBlurMix * 0.65 + seed01 * 0.35, 0.0, 1.0);
      float blur01 = mix(u_edgeBlurMin, u_edgeBlurMax, mix01);
      ww = pow(ww, 1.0 / (1.0 + blur01 * 2.0));
      float ww2 = ww * ww;
      colorSumW += u_blobColor[i] * (ww2 * active);
      wSumW += ww2 * active;
    }

    vec3 blobColW = colorSumW / max(1e-5, wSumW);
    float covW = 1.0 - exp(-wSumW * 1.25);
    covW = clamp(covW, 0.0, 1.0);
    vec3 colWarp = mix(base, blobColW, covW);
    colWarp *= mix(0.88, 1.05, v);

    col = mix(colBase, colWarp, a);

    // Subtle ridge highlight (keeps it "graphic").
    float ridge = smoothstep(0.92, 1.0, abs(w1));
    col += a * 0.020 * ridge * vec3(1.0);
  }

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
    edgeBlurMin: 0.0,
    edgeBlurMax: 0.55,
    edgeBlurSpeed: 0.35,
    overlayMode: 1,
    glassShapeType: 1,
    glassAmount: 0.18,
    glassDistortion: 0.18,
    glassHighlight: 0.20,
    glassSoftness: 0.55,
    glassCount: 8,
    glassBandsCount: 42,
    glassRotate: 0,
    glassTwirl: 0.15,
    glassCirclesAmount: 0.12,
    glassCirclesScale: 0.45,
    glassCirclesRotate: 0,
    glassCirclesThickness: 0.55,
    glassCirclesStretch: 0.25,
    waveAmount: 0.18,
    waveScale: 0.45,
    waveSpeed: 0.22,
    waveAngle: 0,
    waveDetail: 0.45,
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
        "edgeBlurMin",
        "edgeBlurMax",
        "edgeBlurSpeed",
        "overlayMode",
        "glassShapeType",
        "glassAmount",
        "glassDistortion",
        "glassHighlight",
        "glassSoftness",
        "glassCount",
        "glassBandsCount",
        "glassRotate",
        "glassTwirl",
        "glassCirclesAmount",
        "glassCirclesScale",
        "glassCirclesRotate",
        "glassCirclesThickness",
        "glassCirclesStretch",
        "waveAmount",
        "waveScale",
        "waveSpeed",
        "waveAngle",
        "waveDetail",
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
  const uEdgeBlurMin = gl.getUniformLocation(program, "u_edgeBlurMin");
  const uEdgeBlurMax = gl.getUniformLocation(program, "u_edgeBlurMax");
  const uEdgeBlurMix = gl.getUniformLocation(program, "u_edgeBlurMix");
  const uOverlayMode = gl.getUniformLocation(program, "u_overlayMode");
  const uGlassShapeType = gl.getUniformLocation(program, "u_glassShapeType");
  const uGlassAmount = gl.getUniformLocation(program, "u_glassAmount");
  const uGlassDistortion = gl.getUniformLocation(program, "u_glassDistortion");
  const uGlassHighlight = gl.getUniformLocation(program, "u_glassHighlight");
  const uGlassSoftness = gl.getUniformLocation(program, "u_glassSoftness");
  const uGlassCount = gl.getUniformLocation(program, "u_glassCount");
  const uGlassBandsCount = gl.getUniformLocation(program, "u_glassBandsCount");
  const uGlassRotate = gl.getUniformLocation(program, "u_glassRotate");
  const uGlassTwirl = gl.getUniformLocation(program, "u_glassTwirl");
  const uGlassCirclesAmount = gl.getUniformLocation(program, "u_glassCirclesAmount");
  const uGlassCirclesScale = gl.getUniformLocation(program, "u_glassCirclesScale");
  const uGlassCirclesRotate = gl.getUniformLocation(program, "u_glassCirclesRotate");
  const uGlassCirclesThickness = gl.getUniformLocation(program, "u_glassCirclesThickness");
  const uGlassCirclesStretch = gl.getUniformLocation(program, "u_glassCirclesStretch");
  const uWaveAmount = gl.getUniformLocation(program, "u_waveAmount");
  const uWaveScale = gl.getUniformLocation(program, "u_waveScale");
  const uWaveSpeed = gl.getUniformLocation(program, "u_waveSpeed");
  const uWaveAngle = gl.getUniformLocation(program, "u_waveAngle");
  const uWaveDetail = gl.getUniformLocation(program, "u_waveDetail");
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

  function bindToggle(id, valueId, key) {
    const el = $(id);
    const out = $(valueId);
    if (!el || !out) return;
    const set = (v) => {
      const on = !!v;
      state[key] = on ? 1 : 0;
      el.checked = on;
      out.value = on ? "On" : "Off";
    };
    set(state[key] >= 0.5);
    el.addEventListener("change", () => {
      set(el.checked);
      updateEmbedCode();
    });
  }

  function bindSelectInt(id, valueId, key) {
    const el = $(id);
    const out = $(valueId);
    if (!el || !out) return;
    el.value = String(state[key]);
    out.value = el.options[el.selectedIndex]?.textContent || String(state[key]);
    el.addEventListener("change", () => {
      const v = parseInt(el.value, 10);
      state[key] = Number.isFinite(v) ? v : state[key];
      out.value = el.options[el.selectedIndex]?.textContent || String(state[key]);
      updateEmbedCode();
    });
  }

  function bindSelectIntWithLabel(id, valueId, key) {
    const el = $(id);
    const out = $(valueId);
    if (!el || !out) return;
    const update = () => {
      const v = parseInt(el.value, 10);
      state[key] = Number.isFinite(v) ? v : state[key];
      out.value = el.options[el.selectedIndex]?.textContent || String(state[key]);
      updateEmbedCode();
    };
    el.value = String(state[key]);
    out.value = el.options[el.selectedIndex]?.textContent || String(state[key]);
    el.addEventListener("change", update);
  }

  function updateGlassControlVisibility() {
    const t = state.glassShapeType | 0;
    const bands = $("glassBandsControls");
    const ovals = $("glassOvalsControls");
    const circles = $("glassCirclesControls");
    if (bands) bands.hidden = t !== 1;
    if (ovals) ovals.hidden = t !== 2;
    if (circles) circles.hidden = t !== 3;
  }

  function updateOverlayControlVisibility() {
    const m = state.overlayMode | 0;
    const fake = $("fakeGlassControls");
    const wave = $("waveWarpControls");
    if (fake) fake.hidden = m !== 1;
    if (wave) wave.hidden = m !== 2;
    // Also keep glass sub-controls tidy.
    if (m === 1) updateGlassControlVisibility();
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
  bindSlider("edgeBlurMin", "edgeBlurMinValue", "edgeBlurMin", (v) => v.toFixed(2));
  bindSlider("edgeBlurMax", "edgeBlurMaxValue", "edgeBlurMax", (v) => v.toFixed(2));
  bindSlider("edgeBlurSpeed", "edgeBlurSpeedValue", "edgeBlurSpeed", (v) => v.toFixed(2));

  bindSelectIntWithLabel("overlayMode", "overlayModeValue", "overlayMode");
  bindSelectIntWithLabel("glassShapeType", "glassShapeTypeValue", "glassShapeType");
  updateOverlayControlVisibility();
  const ovSel = $("overlayMode");
  if (ovSel) ovSel.addEventListener("change", updateOverlayControlVisibility);
  const gstSel = $("glassShapeType");
  if (gstSel) gstSel.addEventListener("change", updateGlassControlVisibility);
  bindSlider("glassRotate", "glassRotateValue", "glassRotate", (v) => `${Math.round(v)}°`);
  bindSlider("glassTwirl", "glassTwirlValue", "glassTwirl", (v) => v.toFixed(2));
  bindSlider("glassAmount", "glassAmountValue", "glassAmount", (v) => v.toFixed(2));
  bindSlider("glassDistortion", "glassDistortionValue", "glassDistortion", (v) => v.toFixed(2));
  bindSlider("glassHighlight", "glassHighlightValue", "glassHighlight", (v) => v.toFixed(2));
  bindSlider("glassSoftness", "glassSoftnessValue", "glassSoftness", (v) => v.toFixed(2));
  bindIntSlider("glassCount", "glassCountValue", "glassCount");
  bindIntSlider("glassBandsCount", "glassBandsCountValue", "glassBandsCount");
  bindSlider("glassCirclesAmount", "glassCirclesAmountValue", "glassCirclesAmount", (v) => v.toFixed(2));
  bindSlider("glassCirclesScale", "glassCirclesScaleValue", "glassCirclesScale", (v) => v.toFixed(2));
  bindSlider("glassCirclesRotate", "glassCirclesRotateValue", "glassCirclesRotate", (v) => `${Math.round(v)}°`);
  bindSlider("glassCirclesThickness", "glassCirclesThicknessValue", "glassCirclesThickness", (v) => v.toFixed(2));
  bindSlider("glassCirclesStretch", "glassCirclesStretchValue", "glassCirclesStretch", (v) => v.toFixed(2));

  bindSlider("waveAmount", "waveAmountValue", "waveAmount", (v) => v.toFixed(2));
  bindSlider("waveScale", "waveScaleValue", "waveScale", (v) => v.toFixed(2));
  bindSlider("waveSpeed", "waveSpeedValue", "waveSpeed", (v) => v.toFixed(2));
  bindSlider("waveAngle", "waveAngleValue", "waveAngle", (v) => `${Math.round(v)}°`);
  bindSlider("waveDetail", "waveDetailValue", "waveDetail", (v) => v.toFixed(2));

  const blobControlsEl = $("blobControls");
  const bgColorEl = $("bgColor");
  const bgSwatchesEl = $("bgSwatches");
  const edgeBlurRandomizeBtn = $("edgeBlurRandomize");

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
  const copyVevBtn = $("copyVev");
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
        edgeBlurMin: state.edgeBlurMin,
        edgeBlurMax: state.edgeBlurMax,
        edgeBlurSpeed: state.edgeBlurSpeed,
        overlayMode: state.overlayMode,
        glassShapeType: state.glassShapeType,
        glassAmount: state.glassAmount,
        glassDistortion: state.glassDistortion,
        glassHighlight: state.glassHighlight,
        glassSoftness: state.glassSoftness,
        glassCount: state.glassCount,
        glassBandsCount: state.glassBandsCount,
        glassRotate: state.glassRotate,
        glassTwirl: state.glassTwirl,
        glassCirclesAmount: state.glassCirclesAmount,
        glassCirclesScale: state.glassCirclesScale,
        glassCirclesRotate: state.glassCirclesRotate,
        glassCirclesThickness: state.glassCirclesThickness,
        glassCirclesStretch: state.glassCirclesStretch,
        waveAmount: state.waveAmount,
        waveScale: state.waveScale,
        waveSpeed: state.waveSpeed,
        waveAngle: state.waveAngle,
        waveDetail: state.waveDetail,
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

  function buildEmbedSnippetStandard() {
    // Generic embed: sizes strictly to the container element.
    // (No iframe / ancestor-walk hacks; intended for normal websites.)
    const cfgObj = serializeConfig();
    const cfg = JSON.stringify(cfgObj, null, 2);
    const bg = (cfgObj && cfgObj.colors && cfgObj.colors.background) || "#0b0712";
    const instanceId = `metaball-gradient-${cfgObj.savedAt || Date.now()}`;
    const PREC_TOKEN = "__MBG_PRECISION__";
    const FRAG_TEMPLATE = getFragmentShaderSource(PREC_TOKEN);

    // NOTE: this is intentionally the same shader as VEV, but with simpler sizing.
    return (
      `<div id="${instanceId}"></div>\n\n` +
      `<style>\n` +
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
      `    var renderScale=0.65, dprCap=1.5;\n` +
      `    var state={blobCount:3,grain:0.18,distAmount:0.16,distScale:1.05,distSpeed:0.12,globalSoftness:1.02,softVar:0.12,edgeBlurMin:0.0,edgeBlurMax:0.55,edgeBlurSpeed:0.35,overlayMode:1,glassShapeType:1,glassAmount:0.18,glassDistortion:0.18,glassHighlight:0.20,glassSoftness:0.55,glassCount:8,glassBandsCount:42,glassRotate:0,glassTwirl:0.15,glassCirclesAmount:0.12,glassCirclesScale:0.45,glassCirclesRotate:0,glassCirclesThickness:0.55,glassCirclesStretch:0.25,waveAmount:0.18,waveScale:0.45,waveSpeed:0.22,waveAngle:0,waveDetail:0.45};\n` +
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
      `    var FRAG_TEMPLATE=${JSON.stringify(FRAG_TEMPLATE)};\n` +
      `    function fragSrc(prec){return FRAG_TEMPLATE.split(${JSON.stringify(PREC_TOKEN)}).join(prec);}\n` +
      `    var PREC_TOKEN=${JSON.stringify(PREC_TOKEN)};\n` +
      `    var FRAG_TEMPLATE=${JSON.stringify(FRAG_TEMPLATE)};\n` +
      `    fragSrc=function(prec){return FRAG_TEMPLATE.split(PREC_TOKEN).join(prec);};\n` +
      `    var hp=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);var prec=(hp&&hp.precision>0)?'precision highp float;':'precision mediump float;';\n` +
      `    var vs=compile(gl.VERTEX_SHADER,VS);var fs=compile(gl.FRAGMENT_SHADER,fragSrc(prec));var prog=link(vs,fs);gl.deleteShader(vs);gl.deleteShader(fs);gl.useProgram(prog);\n` +
      `    var posLoc=gl.getAttribLocation(prog,'a_position');var vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(posLoc);gl.vertexAttribPointer(posLoc,2,gl.FLOAT,false,0,0);\n` +
      `    var uRes=gl.getUniformLocation(prog,'u_resolution');var uBg=gl.getUniformLocation(prog,'u_bgColor');var uTime=gl.getUniformLocation(prog,'u_time');var uDSp=gl.getUniformLocation(prog,'u_distSpeed');var uCnt=gl.getUniformLocation(prog,'u_blobCount');var uGr=gl.getUniformLocation(prog,'u_grain');var uGS=gl.getUniformLocation(prog,'u_globalSoftness');var uSV=gl.getUniformLocation(prog,'u_softVar');var uEBMin=gl.getUniformLocation(prog,'u_edgeBlurMin');var uEBMax=gl.getUniformLocation(prog,'u_edgeBlurMax');var uEBMix=gl.getUniformLocation(prog,'u_edgeBlurMix');var uOM=gl.getUniformLocation(prog,'u_overlayMode');var uGST=gl.getUniformLocation(prog,'u_glassShapeType');var uGA=gl.getUniformLocation(prog,'u_glassAmount');var uGD=gl.getUniformLocation(prog,'u_glassDistortion');var uGH=gl.getUniformLocation(prog,'u_glassHighlight');var uGSof=gl.getUniformLocation(prog,'u_glassSoftness');var uGC=gl.getUniformLocation(prog,'u_glassCount');var uGBC=gl.getUniformLocation(prog,'u_glassBandsCount');var uGRot=gl.getUniformLocation(prog,'u_glassRotate');var uGTw=gl.getUniformLocation(prog,'u_glassTwirl');var uGCA=gl.getUniformLocation(prog,'u_glassCirclesAmount');var uGCS=gl.getUniformLocation(prog,'u_glassCirclesScale');var uGCR=gl.getUniformLocation(prog,'u_glassCirclesRotate');var uGCT=gl.getUniformLocation(prog,'u_glassCirclesThickness');var uGCSt=gl.getUniformLocation(prog,'u_glassCirclesStretch');var uWA=gl.getUniformLocation(prog,'u_waveAmount');var uWS=gl.getUniformLocation(prog,'u_waveScale');var uWSp=gl.getUniformLocation(prog,'u_waveSpeed');var uWAng=gl.getUniformLocation(prog,'u_waveAngle');var uWD=gl.getUniformLocation(prog,'u_waveDetail');var uDA=gl.getUniformLocation(prog,'u_distAmount');var uDS=gl.getUniformLocation(prog,'u_distScale');var uBlob=gl.getUniformLocation(prog,'u_blob[0]');var uCol=gl.getUniformLocation(prog,'u_blobColor[0]');var uSoft=gl.getUniformLocation(prog,'u_blobSoftSeed[0]');\n` +
      `    var blobVec4=new Float32Array(MAX_BLOBS*4);var blobColor=new Float32Array(MAX_BLOBS*3);var blobSoftSeed=new Float32Array(MAX_BLOBS);\n` +
      `    for(var jj=0;jj<MAX_BLOBS;jj++){var rgb=hexToRgb01(blobs[jj].color);blobColor[jj*3]=rgb[0];blobColor[jj*3+1]=rgb[1];blobColor[jj*3+2]=rgb[2];blobSoftSeed[jj]=blobs[jj].softnessSeed;}\n` +
      `    gl.uniform3fv(uCol,blobColor);gl.uniform1fv(uSoft,blobSoftSeed);\n` +
      `    var bgHex=(PRESET&&PRESET.colors&&typeof PRESET.colors.background==='string')?PRESET.colors.background:${JSON.stringify(bg)};var bg01=hexToRgb01(bgHex);gl.uniform3f(uBg,bg01[0],bg01[1],bg01[2]);\n` +
      `    gl.uniform1f(uDSp,(typeof state.distSpeed==='number'&&isFinite(state.distSpeed))?state.distSpeed:0.12);\n` +
      `    function measure(){var r=root.getBoundingClientRect();var w=r.width||root.clientWidth||0;var h=r.height||root.clientHeight||0;if(h<2&&root.parentElement){var pr=root.parentElement.getBoundingClientRect();w=Math.max(w,pr.width||0);h=Math.max(h,pr.height||0);}if(h<2)h=240;if(w<2)w=2;return{w:w,h:h};}\n` +
      `    var lastW=0,lastH=0;function resize(){var m=measure();var cssW=Math.max(1,Math.floor(m.w));var cssH=Math.max(1,Math.floor(m.h));var dpr=Math.min(dprCap,window.devicePixelRatio||1);var w=Math.max(2,Math.floor(cssW*dpr*renderScale));var h=Math.max(2,Math.floor(cssH*dpr*renderScale));if(w===lastW&&h===lastH)return;lastW=w;lastH=h;canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);gl.uniform2f(uRes,w,h);}resize();\n` +
      `    if(typeof ResizeObserver!=='undefined'){var ro=new ResizeObserver(function(){resize();});ro.observe(root);if(root.parentElement)ro.observe(root.parentElement);}else{window.addEventListener('resize',function(){resize();});}\n` +
      `    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);\n` +
      `    var running=true,raf=0,t0=performance.now();\n` +
      `    var edgeBlurMix=0.5,edgeBlurTarget=0.5,edgeBlurT0=0,edgeBlurNext=0;\n` +
      `    function pickEdgeBlur(now){edgeBlurTarget=Math.random();edgeBlurT0=now;var s=clamp(state.edgeBlurSpeed||0,0,1);var interval=2.5+(1-s)*10.0;edgeBlurNext=now+interval*1000;}\n` +
      `    function stop(){running=false;if(raf)cancelAnimationFrame(raf);raf=0;}\n` +
      `    function start(){if(running)return;running=true;raf=requestAnimationFrame(frame);} \n` +
      `    document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else start();});\n` +
      `    function frame(now){if(!running)return;raf=requestAnimationFrame(frame);resize();var t=(now-t0)*0.001;for(var i=0;i<MAX_BLOBS;i++){var b=blobs[i];var ph=b.phase;var x=b.baseX+b.moveAmpX*Math.sin(t*b.moveFreqX*Math.PI*2+ph)+0.02*Math.sin(t*0.10+b.distortionSeed*6.28);var y=b.baseY+b.moveAmpY*Math.cos(t*b.moveFreqY*Math.PI*2+ph*0.91)+0.02*Math.cos(t*0.08+b.distortionSeed*6.28);var pulse=1+b.pulseAmp*Math.sin(t*b.pulseFreq*Math.PI*2+ph*1.7);var r=b.radius*pulse;var o=i*4;blobVec4[o]=x;blobVec4[o+1]=y;blobVec4[o+2]=r;blobVec4[o+3]=b.distortionSeed;}if((state.edgeBlurSpeed||0)>0.001){if(edgeBlurNext===0)pickEdgeBlur(now);if(now>=edgeBlurNext)pickEdgeBlur(now);var s=clamp(state.edgeBlurSpeed||0,0,1);var dur=700+(1-s)*1200;var u=clamp((now-edgeBlurT0)/dur,0,1);var e=u*u*(3-2*u);edgeBlurMix=edgeBlurMix+(edgeBlurTarget-edgeBlurMix)*e;}gl.uniform1f(uTime,t);gl.uniform1i(uCnt,clamp(state.blobCount|0,1,MAX_BLOBS));gl.uniform1f(uGr,state.grain);gl.uniform1f(uGS,state.globalSoftness);gl.uniform1f(uSV,state.softVar);gl.uniform1f(uEBMin,clamp(state.edgeBlurMin||0,0,1));gl.uniform1f(uEBMax,clamp(state.edgeBlurMax||0,0,1));gl.uniform1f(uEBMix,edgeBlurMix);gl.uniform1i(uOM,clamp(state.overlayMode|0,0,2));gl.uniform1i(uGST,clamp(state.glassShapeType|0,1,3));gl.uniform1f(uGA,clamp(state.glassAmount||0,0,1));gl.uniform1f(uGD,clamp(state.glassDistortion||0,0,1));gl.uniform1f(uGH,clamp(state.glassHighlight||0,0,1));gl.uniform1f(uGSof,clamp(state.glassSoftness||0,0,1));gl.uniform1i(uGC,clamp(state.glassCount|0,0,10));gl.uniform1i(uGBC,clamp(state.glassBandsCount|0,6,80));gl.uniform1f(uGRot,(state.glassRotate||0)*Math.PI/180);gl.uniform1f(uGTw,clamp(state.glassTwirl||0,0,1));gl.uniform1f(uGCA,clamp(state.glassCirclesAmount||0,0,1));gl.uniform1f(uGCS,clamp(state.glassCirclesScale||0,0,1));gl.uniform1f(uGCR,(state.glassCirclesRotate||0)*Math.PI/180);gl.uniform1f(uGCT,clamp(state.glassCirclesThickness||0,0,1));gl.uniform1f(uGCSt,clamp(state.glassCirclesStretch||0,0,1));gl.uniform1f(uWA,clamp(state.waveAmount||0,0,1));gl.uniform1f(uWS,clamp(state.waveScale||0,0,1));gl.uniform1f(uWSp,clamp(state.waveSpeed||0,0,1));gl.uniform1f(uWAng,(state.waveAngle||0)*Math.PI/180);gl.uniform1f(uWD,clamp(state.waveDetail||0,0,1));gl.uniform1f(uDA,state.distAmount);gl.uniform1f(uDS,state.distScale);gl.uniform4fv(uBlob,blobVec4);gl.drawArrays(gl.TRIANGLES,0,6);} \n` +
      `    raf=requestAnimationFrame(frame);\n` +
      `  }\n` +
      `  var root=document.getElementById(ROOT_ID);\n` +
      `  if(root) init(root);\n` +
      `})();\n` +
      `</script>\n`
    );
  }

  function buildEmbedSnippet() {
    // VEV-ready: one container div + one <style> + one <script>, fully inline, no file paths.
    const cfgObj = serializeConfig();
    const cfg = JSON.stringify(cfgObj, null, 2);
    const bg = (cfgObj && cfgObj.colors && cfgObj.colors.background) || "#0b0712";
    const PREC_TOKEN = "__MBG_PRECISION__";
    const FRAG_TEMPLATE = getFragmentShaderSource(PREC_TOKEN);
    // Critical: make each snippet instance-scoped so multiple embeds on one page
    // can coexist with different presets without interfering with each other.
    const instanceId = `metaball-gradient-${cfgObj.savedAt || Date.now()}`;
    return (
      `<div id="${instanceId}"></div>\n\n` +
      `<style>\n` +
      `  html,body{height:100%;margin:0;}\n` +
      // VEV note: the embed block should define the height. Avoid hard min-height that can
      // produce “fixed height” behavior on responsive layouts.
      `  #${instanceId}{position:relative;display:block;width:100%;height:100%;min-height:0;overflow:hidden;background:${bg};isolation:isolate;}\n` +
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
      `    var state={blobCount:3,grain:0.18,distAmount:0.16,distScale:1.05,distSpeed:0.12,globalSoftness:1.02,softVar:0.12,edgeBlurMin:0.0,edgeBlurMax:0.55,edgeBlurSpeed:0.35,overlayMode:1,glassShapeType:1,glassAmount:0.18,glassDistortion:0.18,glassHighlight:0.20,glassSoftness:0.55,glassCount:8,glassBandsCount:42,glassRotate:0,glassTwirl:0.15,glassCirclesAmount:0.12,glassCirclesScale:0.45,glassCirclesRotate:0,glassCirclesThickness:0.55,glassCirclesStretch:0.25,waveAmount:0.18,waveScale:0.45,waveSpeed:0.22,waveAngle:0,waveDetail:0.45};\n` +
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
      `      'varying vec2 v_uv;uniform vec2 u_resolution;uniform vec3 u_bgColor;uniform float u_time;uniform float u_distSpeed;uniform int u_blobCount;uniform float u_grain;uniform float u_globalSoftness;uniform float u_softVar;uniform float u_edgeBlurMin;uniform float u_edgeBlurMax;uniform float u_edgeBlurMix;uniform float u_glassEnabled;uniform int u_glassShapeType;uniform float u_glassAmount;uniform float u_glassDistortion;uniform float u_glassHighlight;uniform float u_glassSoftness;uniform int u_glassCount;uniform float u_glassRotate;uniform float u_glassTwirl;uniform float u_glassCirclesAmount;uniform float u_glassCirclesScale;uniform float u_glassCirclesRotate;uniform float u_distAmount;uniform float u_distScale;uniform vec4 u_blob[${MAX_BLOBS}];uniform vec3 u_blobColor[${MAX_BLOBS}];uniform float u_blobSoftSeed[${MAX_BLOBS}];'+\n` +
      `      'float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}'+\n` +
      `      'float valueNoise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);float a=hash12(i);float b=hash12(i+vec2(1.0,0.0));float c=hash12(i+vec2(0.0,1.0));float d=hash12(i+vec2(1.0,1.0));vec2 u=f*f*(3.0-2.0*f);return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;}'+\n` +
      `      'float fbm(vec2 p){float v=0.0;float a=0.55;for(int i=0;i<3;i++){v+=a*valueNoise(p);p=p*2.02+11.7;a*=0.52;}return v;}'+\n` +
      `      'void main(){float aspect=u_resolution.x/max(1.0,u_resolution.y);vec2 p=v_uv-0.5;p.x*=aspect;float sc=max(0.0001,u_distScale);float t=u_time*u_distSpeed;vec2 dn=vec2(fbm(p*sc+vec2(0.0,0.0)+t*0.18),fbm(p*sc+vec2(17.3,9.1)-t*0.14));vec2 dvec=(dn-0.5)*(u_distAmount*0.22);vec2 pp=p+dvec;vec3 base=u_bgColor;vec3 colorSum=vec3(0.0);float wSum=0.0;for(int i=0;i<${MAX_BLOBS};i++){float active=step(float(i),float(u_blobCount-1));vec2 c=u_blob[i].xy-0.5;c.x*=aspect;float localN=fbm((pp-c)*(sc*0.85)+u_blob[i].w*9.7+t*0.10);float warp=1.0+(localN-0.5)*(u_distAmount*0.35);float r=max(0.0001,u_blob[i].z);float dist=length(pp-c)*warp;float soft=clamp(u_globalSoftness+u_softVar*u_blobSoftSeed[i],0.35,2.2);float sigma=r*soft;float w=exp(-(dist*dist)/(2.0*sigma*sigma));float seed01=clamp(u_blobSoftSeed[i]*0.5+0.5,0.0,1.0);float mix01=clamp(u_edgeBlurMix*0.65+seed01*0.35,0.0,1.0);float blur01=mix(u_edgeBlurMin,u_edgeBlurMax,mix01);w=pow(w,1.0/(1.0+blur01*2.0));float w2=w*w;colorSum+=u_blobColor[i]*(w2*active);wSum+=w2*active;}vec3 blobCol=colorSum/max(1e-5,wSum);float coverage=1.0-exp(-wSum*1.25);coverage=clamp(coverage,0.0,1.0);float v=smoothstep(0.95,0.20,length(p));vec3 colBase=mix(base,blobCol,coverage);colBase*=mix(0.88,1.05,v);float glassOn=step(0.5,u_glassEnabled);float gMask=0.0;vec2 gOff=vec2(0.0);float gLight=0.0;if(glassOn>0.5){float feather=mix(0.010,0.120,clamp(u_glassSoftness,0.0,1.0));for(int j=0;j<10;j++){float act=step(float(j),float(u_glassCount-1));float jj=float(j);float r1=hash12(vec2(jj*13.17,1.23));float r2=hash12(vec2(jj*17.71,7.77));float r3=hash12(vec2(jj*23.91,3.11));float r4=hash12(vec2(jj*29.77,9.41));float m=0.0;float shade=0.0;vec2 dir=vec2(1.0,0.12);if(u_glassShapeType==1){float cx=mix(-0.55*aspect,0.55*aspect,r1);float halfW=mix(0.06,0.16,r2)*aspect;float halfH=0.70;float rr=halfW*mix(0.25,0.55,r3);vec2 q=vec2(abs(pp.x-cx)-halfW,abs(pp.y)-halfH);float sdf=length(max(q,0.0))+min(max(q.x,q.y),0.0)-rr;m=1.0-smoothstep(0.0,feather,sdf);float nx=clamp((pp.x-cx)/max(1e-5,halfW),-1.0,1.0);float hl=smoothstep(-0.10,0.85,nx)*(1.0-smoothstep(0.55,1.15,abs(nx)));float sh=smoothstep(-0.85,0.10,nx)*(1.0-smoothstep(0.55,1.15,abs(nx)));shade=(hl-sh)*(0.55+0.45*r4);dir=normalize(vec2(1.0,mix(0.05,0.20,r4)));}else{vec2 c2=vec2(mix(-0.45*aspect,0.45*aspect,r1),mix(-0.35,0.35,r2));vec2 sz=vec2(mix(0.18,0.46,r3)*aspect,mix(0.12,0.34,r4));vec2 d=(pp-c2)/max(vec2(1e-4),sz);float distE=length(d);m=1.0-smoothstep(1.0-feather*1.35,1.0,distE);float ang=r3*6.2831853;dir=normalize(vec2(cos(ang),sin(ang)));shade=clamp(dot(d,dir),-1.0,1.0)*(0.55+0.45*r2);}vec2 wob=vec2(fbm(pp*1.25+jj*9.7+t*0.06),fbm(pp*1.25+jj*6.1-t*0.05))-0.5;float mm=m*act;gMask+=mm;gLight+=mm*shade;gOff+=mm*(dir*(0.55+0.45*r1)+wob*0.65);}gMask=clamp(gMask,0.0,1.0);gOff*=(clamp(u_glassDistortion,0.0,1.0)*0.045)/max(0.05,float(u_glassCount));gLight=clamp(gLight,-1.0,1.0);}vec3 col=colBase;float gMix=glassOn*clamp(u_glassAmount,0.0,1.0)*gMask;if(gMix>0.0005){vec2 pp2=pp+gOff;vec3 cSum2=vec3(0.0);float wSum2=0.0;for(int i=0;i<${MAX_BLOBS};i++){float active=step(float(i),float(u_blobCount-1));vec2 c=u_blob[i].xy-0.5;c.x*=aspect;float localN=fbm((pp2-c)*(sc*0.85)+u_blob[i].w*9.7+t*0.10);float warp=1.0+(localN-0.5)*(u_distAmount*0.35);float r=max(0.0001,u_blob[i].z);float dist=length(pp2-c)*warp;float soft=clamp(u_globalSoftness+u_softVar*u_blobSoftSeed[i],0.35,2.2);float sigma=r*soft;float w=exp(-(dist*dist)/(2.0*sigma*sigma));float seed01=clamp(u_blobSoftSeed[i]*0.5+0.5,0.0,1.0);float mix01=clamp(u_edgeBlurMix*0.65+seed01*0.35,0.0,1.0);float blur01=mix(u_edgeBlurMin,u_edgeBlurMax,mix01);w=pow(w,1.0/(1.0+blur01*2.0));float w2=w*w;cSum2+=u_blobColor[i]*(w2*active);wSum2+=w2*active;}vec3 blobCol2=cSum2/max(1e-5,wSum2);float cov2=1.0-exp(-wSum2*1.25);cov2=clamp(cov2,0.0,1.0);vec3 colR=mix(base,blobCol2,cov2);colR*=mix(0.88,1.05,v);col=mix(colBase,colR,gMix);float hl=clamp(u_glassHighlight,0.0,1.0)*0.065;col+=gMix*hl*gLight*vec3(1.0);col-=gMix*hl*max(0.0,-gLight)*vec3(0.85,0.88,0.95);}float gr=hash12(gl_FragCoord.xy+vec2(u_time*0.05,0.0))-0.5;col+=gr*(u_grain*0.075);gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);}';}\n` +
      `    var hp=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);var prec=(hp&&hp.precision>0)?'precision highp float;':'precision mediump float;';\n` +
      `    var vs=compile(gl.VERTEX_SHADER,VS);var fs=compile(gl.FRAGMENT_SHADER,fragSrc(prec));var prog=link(vs,fs);gl.deleteShader(vs);gl.deleteShader(fs);gl.useProgram(prog);\n` +
      `    var posLoc=gl.getAttribLocation(prog,'a_position');var vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(posLoc);gl.vertexAttribPointer(posLoc,2,gl.FLOAT,false,0,0);\n` +
      `    var uRes=gl.getUniformLocation(prog,'u_resolution');var uBg=gl.getUniformLocation(prog,'u_bgColor');var uTime=gl.getUniformLocation(prog,'u_time');var uDSp=gl.getUniformLocation(prog,'u_distSpeed');var uCnt=gl.getUniformLocation(prog,'u_blobCount');var uGr=gl.getUniformLocation(prog,'u_grain');var uGS=gl.getUniformLocation(prog,'u_globalSoftness');var uSV=gl.getUniformLocation(prog,'u_softVar');var uEBMin=gl.getUniformLocation(prog,'u_edgeBlurMin');var uEBMax=gl.getUniformLocation(prog,'u_edgeBlurMax');var uEBMix=gl.getUniformLocation(prog,'u_edgeBlurMix');var uOM=gl.getUniformLocation(prog,'u_overlayMode');var uGST=gl.getUniformLocation(prog,'u_glassShapeType');var uGA=gl.getUniformLocation(prog,'u_glassAmount');var uGD=gl.getUniformLocation(prog,'u_glassDistortion');var uGH=gl.getUniformLocation(prog,'u_glassHighlight');var uGSof=gl.getUniformLocation(prog,'u_glassSoftness');var uGC=gl.getUniformLocation(prog,'u_glassCount');var uGBC=gl.getUniformLocation(prog,'u_glassBandsCount');var uGRot=gl.getUniformLocation(prog,'u_glassRotate');var uGTw=gl.getUniformLocation(prog,'u_glassTwirl');var uGCA=gl.getUniformLocation(prog,'u_glassCirclesAmount');var uGCS=gl.getUniformLocation(prog,'u_glassCirclesScale');var uGCR=gl.getUniformLocation(prog,'u_glassCirclesRotate');var uGCT=gl.getUniformLocation(prog,'u_glassCirclesThickness');var uGCSt=gl.getUniformLocation(prog,'u_glassCirclesStretch');var uWA=gl.getUniformLocation(prog,'u_waveAmount');var uWS=gl.getUniformLocation(prog,'u_waveScale');var uWSp=gl.getUniformLocation(prog,'u_waveSpeed');var uWAng=gl.getUniformLocation(prog,'u_waveAngle');var uWD=gl.getUniformLocation(prog,'u_waveDetail');var uDA=gl.getUniformLocation(prog,'u_distAmount');var uDS=gl.getUniformLocation(prog,'u_distScale');var uBlob=gl.getUniformLocation(prog,'u_blob[0]');var uCol=gl.getUniformLocation(prog,'u_blobColor[0]');var uSoft=gl.getUniformLocation(prog,'u_blobSoftSeed[0]');\n` +
      `    var blobVec4=new Float32Array(MAX_BLOBS*4);var blobColor=new Float32Array(MAX_BLOBS*3);var blobSoftSeed=new Float32Array(MAX_BLOBS);\n` +
      `    for(var jj=0;jj<MAX_BLOBS;jj++){var rgb=hexToRgb01(blobs[jj].color);blobColor[jj*3]=rgb[0];blobColor[jj*3+1]=rgb[1];blobColor[jj*3+2]=rgb[2];blobSoftSeed[jj]=blobs[jj].softnessSeed;}\n` +
      `    gl.uniform3fv(uCol,blobColor);gl.uniform1fv(uSoft,blobSoftSeed);\n` +
      `    var bgHex=(PRESET&&PRESET.colors&&typeof PRESET.colors.background==='string')?PRESET.colors.background:${JSON.stringify(bg)};var bg01=hexToRgb01(bgHex);gl.uniform3f(uBg,bg01[0],bg01[1],bg01[2]);\n` +
      `    gl.uniform1f(uDSp,(typeof state.distSpeed==='number'&&isFinite(state.distSpeed))?state.distSpeed:0.12);\n` +
      `    function measureSize(){\n` +
      `      // VEV "Embed Anything" commonly runs inside an iframe. The most reliable size source\n` +
      `      // is the iframe element itself (frameElement) and its parent wrapper.\n` +
      `      var w=0,h=0;\n` +
      `      try{\n` +
      `        var fe=window.frameElement;\n` +
      `        if(fe){\n` +
      `          // Make iframe behave like a full-bleed block.\n` +
      `          fe.style.display='block';\n` +
      `          fe.style.width='100%';\n` +
      `          fe.style.border='0';\n` +
      `          // If we can see the parent wrapper, sync iframe height to it.\n` +
      `          if(fe.parentElement){\n` +
      `            var pr=fe.parentElement.getBoundingClientRect();\n` +
      `            if(pr && pr.height>2){\n` +
      `              fe.style.height=Math.floor(pr.height)+'px';\n` +
      `              w=pr.width||0; h=pr.height||0;\n` +
      `            }\n` +
      `          }\n` +
      `          // Fall back to iframe rect.\n` +
      `          if(h<2){\n` +
      `            var fr=fe.getBoundingClientRect();\n` +
      `            w=Math.max(w,fr.width||0);\n` +
      `            h=Math.max(h,fr.height||0);\n` +
      `          }\n` +
      `        }\n` +
      `      }catch(e){}\n` +
      `      // Fall back to root rect (non-iframe embeds).\n` +
      `      if(h<2){\n` +
      `        var r=root.getBoundingClientRect();\n` +
      `        w=Math.max(w,r.width||0,root.clientWidth||0);\n` +
      `        h=Math.max(h,r.height||0,root.clientHeight||0);\n` +
      `      }\n` +
      `      // Last resort: iframe viewport (still better than a fixed 200px).\n` +
      `      if(h<2){\n` +
      `        w=Math.max(w,window.innerWidth||0);\n` +
      `        h=Math.max(h,window.innerHeight||0);\n` +
      `      }\n` +
      `      if(w<2) w=2;\n` +
      `      if(h<2) h=2;\n` +
      `      // Ensure root fills the embed block.\n` +
      `      root.style.height=Math.floor(h)+'px';\n` +
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
      `    var edgeBlurMix=0.5,edgeBlurTarget=0.5,edgeBlurT0=0,edgeBlurNext=0;\n` +
      `    function pickEdgeBlur(now){edgeBlurTarget=Math.random();edgeBlurT0=now;var s=clamp(state.edgeBlurSpeed||0,0,1);var interval=2.5+(1-s)*10.0;edgeBlurNext=now+interval*1000;}\n` +
      `    function stop(){running=false;if(raf)cancelAnimationFrame(raf);raf=0;}\n` +
      `    function start(){if(running)return;running=true;raf=requestAnimationFrame(frame);} \n` +
      `    document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else start();});\n` +
      `    function frame(now){if(!running)return;raf=requestAnimationFrame(frame);resize();var t=(now-t0)*0.001;for(var i=0;i<MAX_BLOBS;i++){var b=blobs[i];var ph=b.phase;var x=b.baseX+b.moveAmpX*Math.sin(t*b.moveFreqX*Math.PI*2+ph)+0.02*Math.sin(t*0.10+b.distortionSeed*6.28);var y=b.baseY+b.moveAmpY*Math.cos(t*b.moveFreqY*Math.PI*2+ph*0.91)+0.02*Math.cos(t*0.08+b.distortionSeed*6.28);var pulse=1+b.pulseAmp*Math.sin(t*b.pulseFreq*Math.PI*2+ph*1.7);var r=b.radius*pulse;var o=i*4;blobVec4[o]=x;blobVec4[o+1]=y;blobVec4[o+2]=r;blobVec4[o+3]=b.distortionSeed;}if((state.edgeBlurSpeed||0)>0.001){if(edgeBlurNext===0)pickEdgeBlur(now);if(now>=edgeBlurNext)pickEdgeBlur(now);var s=clamp(state.edgeBlurSpeed||0,0,1);var dur=700+(1-s)*1200;var u=clamp((now-edgeBlurT0)/dur,0,1);var e=u*u*(3-2*u);edgeBlurMix=edgeBlurMix+(edgeBlurTarget-edgeBlurMix)*e;}gl.uniform1f(uTime,t);gl.uniform1i(uCnt,clamp(state.blobCount|0,1,MAX_BLOBS));gl.uniform1f(uGr,state.grain);gl.uniform1f(uGS,state.globalSoftness);gl.uniform1f(uSV,state.softVar);gl.uniform1f(uEBMin,clamp(state.edgeBlurMin||0,0,1));gl.uniform1f(uEBMax,clamp(state.edgeBlurMax||0,0,1));gl.uniform1f(uEBMix,edgeBlurMix);gl.uniform1i(uOM,clamp(state.overlayMode|0,0,2));gl.uniform1i(uGST,clamp(state.glassShapeType|0,1,3));gl.uniform1f(uGA,clamp(state.glassAmount||0,0,1));gl.uniform1f(uGD,clamp(state.glassDistortion||0,0,1));gl.uniform1f(uGH,clamp(state.glassHighlight||0,0,1));gl.uniform1f(uGSof,clamp(state.glassSoftness||0,0,1));gl.uniform1i(uGC,clamp(state.glassCount|0,0,10));gl.uniform1i(uGBC,clamp(state.glassBandsCount|0,6,80));gl.uniform1f(uGRot,(state.glassRotate||0)*Math.PI/180);gl.uniform1f(uGTw,clamp(state.glassTwirl||0,0,1));gl.uniform1f(uGCA,clamp(state.glassCirclesAmount||0,0,1));gl.uniform1f(uGCS,clamp(state.glassCirclesScale||0,0,1));gl.uniform1f(uGCR,(state.glassCirclesRotate||0)*Math.PI/180);gl.uniform1f(uGCT,clamp(state.glassCirclesThickness||0,0,1));gl.uniform1f(uGCSt,clamp(state.glassCirclesStretch||0,0,1));gl.uniform1f(uWA,clamp(state.waveAmount||0,0,1));gl.uniform1f(uWS,clamp(state.waveScale||0,0,1));gl.uniform1f(uWSp,clamp(state.waveSpeed||0,0,1));gl.uniform1f(uWAng,(state.waveAngle||0)*Math.PI/180);gl.uniform1f(uWD,clamp(state.waveDetail||0,0,1));gl.uniform1f(uDA,state.distAmount);gl.uniform1f(uDS,state.distScale);gl.uniform4fv(uBlob,blobVec4);gl.drawArrays(gl.TRIANGLES,0,6);} \n` +
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

  async function copyText(btn, text) {
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = prev), 900);
    } catch {
      if (embedCodeEl) {
        embedCodeEl.focus();
        embedCodeEl.select();
      }
      document.execCommand("copy");
    }
  }

  if (copyEmbedBtn && embedCodeEl) {
    copyEmbedBtn.addEventListener("click", async () => {
      embedCodeEl.value = buildEmbedSnippetStandard();
      await copyText(copyEmbedBtn, embedCodeEl.value);
    });
  }

  if (copyVevBtn && embedCodeEl) {
    copyVevBtn.addEventListener("click", async () => {
      embedCodeEl.value = buildEmbedSnippet();
      await copyText(copyVevBtn, embedCodeEl.value);
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
      if (typeof s.edgeBlurMin === "number") state.edgeBlurMin = s.edgeBlurMin;
      if (typeof s.edgeBlurMax === "number") state.edgeBlurMax = s.edgeBlurMax;
      if (typeof s.edgeBlurSpeed === "number") state.edgeBlurSpeed = s.edgeBlurSpeed;
      if (typeof s.overlayMode === "number") state.overlayMode = s.overlayMode;
      // Back-compat: older presets used a glassEnabled flag.
      if (typeof s.glassEnabled === "number" && !("overlayMode" in s)) state.overlayMode = s.glassEnabled >= 0.5 ? 1 : 0;
      if (typeof s.glassShapeType === "number") state.glassShapeType = s.glassShapeType;
      if (typeof s.glassAmount === "number") state.glassAmount = s.glassAmount;
      if (typeof s.glassDistortion === "number") state.glassDistortion = s.glassDistortion;
      if (typeof s.glassHighlight === "number") state.glassHighlight = s.glassHighlight;
      if (typeof s.glassSoftness === "number") state.glassSoftness = s.glassSoftness;
      if (typeof s.glassCount === "number") state.glassCount = s.glassCount;
      if (typeof s.glassBandsCount === "number") state.glassBandsCount = s.glassBandsCount;
      if (typeof s.glassRotate === "number") state.glassRotate = s.glassRotate;
      if (typeof s.glassTwirl === "number") state.glassTwirl = s.glassTwirl;
      if (typeof s.glassCirclesAmount === "number") state.glassCirclesAmount = s.glassCirclesAmount;
      if (typeof s.glassCirclesScale === "number") state.glassCirclesScale = s.glassCirclesScale;
      if (typeof s.glassCirclesRotate === "number") state.glassCirclesRotate = s.glassCirclesRotate;
      if (typeof s.glassCirclesThickness === "number") state.glassCirclesThickness = s.glassCirclesThickness;
      if (typeof s.glassCirclesStretch === "number") state.glassCirclesStretch = s.glassCirclesStretch;
      if (typeof s.waveAmount === "number") state.waveAmount = s.waveAmount;
      if (typeof s.waveScale === "number") state.waveScale = s.waveScale;
      if (typeof s.waveSpeed === "number") state.waveSpeed = s.waveSpeed;
      if (typeof s.waveAngle === "number") state.waveAngle = s.waveAngle;
      if (typeof s.waveDetail === "number") state.waveDetail = s.waveDetail;
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
    setOut("edgeBlurMin", String(state.edgeBlurMin));
    setOut("edgeBlurMinValue", state.edgeBlurMin.toFixed(2));
    setOut("edgeBlurMax", String(state.edgeBlurMax));
    setOut("edgeBlurMaxValue", state.edgeBlurMax.toFixed(2));
    setOut("edgeBlurSpeed", String(state.edgeBlurSpeed));
    setOut("edgeBlurSpeedValue", state.edgeBlurSpeed.toFixed(2));

    const overlayEl = $("overlayMode");
    if (overlayEl) overlayEl.value = String(state.overlayMode | 0);
    const overlayOut = $("overlayModeValue");
    if (overlayEl && overlayOut) overlayOut.value = overlayEl.options[overlayEl.selectedIndex]?.textContent || String(state.overlayMode);
    setOut("glassShapeType", String(state.glassShapeType));
    const gst = $("glassShapeType");
    if (gst) {
      const out = $("glassShapeTypeValue");
      if (out) out.value = gst.options[gst.selectedIndex]?.textContent || String(state.glassShapeType);
    }
    setOut("glassAmount", String(state.glassAmount));
    setOut("glassAmountValue", state.glassAmount.toFixed(2));
    setOut("glassDistortion", String(state.glassDistortion));
    setOut("glassDistortionValue", state.glassDistortion.toFixed(2));
    setOut("glassHighlight", String(state.glassHighlight));
    setOut("glassHighlightValue", state.glassHighlight.toFixed(2));
    setOut("glassSoftness", String(state.glassSoftness));
    setOut("glassSoftnessValue", state.glassSoftness.toFixed(2));
    setOut("glassCount", String(state.glassCount | 0));
    setOut("glassCountValue", String(state.glassCount | 0));
    setOut("glassBandsCount", String(state.glassBandsCount | 0));
    setOut("glassBandsCountValue", String(state.glassBandsCount | 0));
    setOut("glassRotate", String(state.glassRotate));
    setOut("glassRotateValue", `${Math.round(state.glassRotate)}°`);
    setOut("glassTwirl", String(state.glassTwirl));
    setOut("glassTwirlValue", state.glassTwirl.toFixed(2));
    setOut("glassCirclesAmount", String(state.glassCirclesAmount));
    setOut("glassCirclesAmountValue", state.glassCirclesAmount.toFixed(2));
    setOut("glassCirclesScale", String(state.glassCirclesScale));
    setOut("glassCirclesScaleValue", state.glassCirclesScale.toFixed(2));
    setOut("glassCirclesRotate", String(state.glassCirclesRotate));
    setOut("glassCirclesRotateValue", `${Math.round(state.glassCirclesRotate)}°`);
    setOut("glassCirclesThickness", String(state.glassCirclesThickness));
    setOut("glassCirclesThicknessValue", state.glassCirclesThickness.toFixed(2));
    setOut("glassCirclesStretch", String(state.glassCirclesStretch));
    setOut("glassCirclesStretchValue", state.glassCirclesStretch.toFixed(2));
    setOut("waveAmount", String(state.waveAmount));
    setOut("waveAmountValue", state.waveAmount.toFixed(2));
    setOut("waveScale", String(state.waveScale));
    setOut("waveScaleValue", state.waveScale.toFixed(2));
    setOut("waveSpeed", String(state.waveSpeed));
    setOut("waveSpeedValue", state.waveSpeed.toFixed(2));
    setOut("waveAngle", String(state.waveAngle));
    setOut("waveAngleValue", `${Math.round(state.waveAngle)}°`);
    setOut("waveDetail", String(state.waveDetail));
    setOut("waveDetailValue", state.waveDetail.toFixed(2));
    const bgInput = $("bgColor");
    if (bgInput) bgInput.value = state.bgColor;

    updateOverlayControlVisibility();

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

  // Edge blur randomization (smooth, non-jittery).
  let edgeBlurMix = 0.5; // 0..1
  let edgeBlurTarget = 0.5;
  let edgeBlurTweenT0 = 0;
  let edgeBlurNextPick = 0;

  function pickEdgeBlurTarget(now) {
    edgeBlurTarget = Math.random();
    edgeBlurTweenT0 = now;
    // Next pick interval based on speed slider (0 => never).
    const s = clamp(state.edgeBlurSpeed, 0, 1);
    const interval = 2.5 + (1 - s) * 10.0; // seconds
    edgeBlurNextPick = now + interval * 1000;
  }

  if (edgeBlurRandomizeBtn) {
    edgeBlurRandomizeBtn.addEventListener("click", () => {
      pickEdgeBlurTarget(performance.now());
      updateEmbedCode();
    });
  }

  let running = true;
  let rafId = 0;
  const t0 = performance.now();

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    resizeIfNeeded();

    const t = ((now - t0) * 0.001) * CONFIG.timeScale;

    // Update edge blur mix (smoothly approaches a random target).
    if (state.edgeBlurSpeed > 0.001) {
      if (edgeBlurNextPick === 0) pickEdgeBlurTarget(now);
      if (now >= edgeBlurNextPick) pickEdgeBlurTarget(now);
      const s = clamp(state.edgeBlurSpeed, 0, 1);
      const dur = 700 + (1 - s) * 1200; // ms
      const u = clamp((now - edgeBlurTweenT0) / dur, 0, 1);
      const ease = u * u * (3 - 2 * u);
      edgeBlurMix = edgeBlurMix + (edgeBlurTarget - edgeBlurMix) * ease;
    }

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
    gl.uniform1f(uEdgeBlurMin, state.edgeBlurMin);
    gl.uniform1f(uEdgeBlurMax, state.edgeBlurMax);
    gl.uniform1f(uEdgeBlurMix, edgeBlurMix);
    gl.uniform1i(uOverlayMode, clamp(state.overlayMode | 0, 0, 2));
    gl.uniform1i(uGlassShapeType, clamp(state.glassShapeType | 0, 1, 3));
    gl.uniform1f(uGlassAmount, state.glassAmount);
    gl.uniform1f(uGlassDistortion, state.glassDistortion);
    gl.uniform1f(uGlassHighlight, state.glassHighlight);
    gl.uniform1f(uGlassSoftness, state.glassSoftness);
    gl.uniform1i(uGlassCount, clamp(state.glassCount | 0, 0, 10));
    gl.uniform1i(uGlassBandsCount, clamp(state.glassBandsCount | 0, 6, 80));
    gl.uniform1f(uGlassRotate, (state.glassRotate * Math.PI) / 180);
    gl.uniform1f(uGlassTwirl, state.glassTwirl);
    gl.uniform1f(uGlassCirclesAmount, state.glassCirclesAmount);
    gl.uniform1f(uGlassCirclesScale, state.glassCirclesScale);
    gl.uniform1f(uGlassCirclesRotate, (state.glassCirclesRotate * Math.PI) / 180);
    gl.uniform1f(uGlassCirclesThickness, state.glassCirclesThickness);
    gl.uniform1f(uGlassCirclesStretch, state.glassCirclesStretch);
    gl.uniform1f(uWaveAmount, state.waveAmount);
    gl.uniform1f(uWaveScale, state.waveScale);
    gl.uniform1f(uWaveSpeed, state.waveSpeed);
    gl.uniform1f(uWaveAngle, (state.waveAngle * Math.PI) / 180);
    gl.uniform1f(uWaveDetail, state.waveDetail);
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

