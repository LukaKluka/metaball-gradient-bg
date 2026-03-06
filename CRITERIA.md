## Project: WebGL Metaball Gradient Background — Criteria Reference

This file captures all requirements from the prompt so we can use it as a build checklist/reference.

### Output / Stack Constraints
- **Deliverables**: complete working code for `index.html`, `style.css`, `script.js`
- **No frameworks**: only HTML, CSS, plain JavaScript
- **Rendering**: WebGL with custom vertex + fragment shaders (fullscreen quad)
- **Goal**: optimized for use as a real website background (not a heavy demo)

### Core Goal (Visual)
- **Full-screen animated metaball gradient background** that looks:
  - soft, fluid, elegant, atmospheric, premium
  - like a gradient background formed by blending metaballs
- **Usable behind webpage content**
- **Efficient enough** for normal laptops and browsers
- **Includes a small floating control panel** for testing

### Metaball Behavior Requirements
- **Blend smoothly**
- **Different sizes**
- **Move slowly**
- **Pulse in scale/size independently**
- **Each has editable color**
- **Subtle shape variation** (not perfectly circular)
- **Subtle per-blob softness variation** (some diffused, some tighter)

### Layout / Embed Requirements
- Canvas must:
  - **fill the viewport**
  - be **fixed or absolute**
  - sit **behind page content**
  - **not block pointer events** on page content
- Structure should be **easy to embed** as a real webpage background system.
- Add example foreground content in HTML:
  - **centered heading**
  - **short paragraph**
- Keep background system reusable.

### Default State (Art Direction / Behavior)
- **3 metaballs** by default
- slow atmospheric motion
- subtle size pulsing
- refined purple palette
- **low subtle grain**
- **mild organic blob distortion**
- **mild softness variation**

### Metaball Count Control
- Default count: **3**
- Live slider to change active count:
  - **min 1**
  - **max 8**
- When count changes:
  - **regenerate visible color controls** to match active metaballs
  - **preserve already assigned colors** where possible

### Per-Metaball Data (Each metaball must have)
- position
- base radius
- color
- drift motion parameters
- scale pulse amplitude
- scale pulse frequency
- unique phase offset
- per-blob softness value
- per-blob distortion seed/offset

### Movement Requirements
- Slow, calm motion
- Stable procedural motion based on time
- Avoid chaotic jitter
- Each metaball moves differently
- Movement bounded so blobs remain on screen or near edges in a pleasing way

### Scale / Pulse Requirements
- Each metaball pulses in size independently
- Subtle and organic pulsing
- Natural size differences
- Use pre-generated per-blob random parameters so animation is stable/deterministic
- Do not re-randomize every frame

### Shader Requirements (WebGL)
- Custom **vertex shader** (fullscreen quad)
- **Fragment shader**:
  - computes a metaball field
  - smooth blending between metaballs
  - smooth color blending based on field contribution
  - subtle softness control in shader logic
- Must not look like hard circles
- Must look like soft fluid gradient field
- Premium/clean color transitions; avoid muddy blending where possible
- Suggested logic:
  - each metaball contributes influence based on distance
  - build field from influences
  - final color from weighted color contribution
  - smooth thresholding / softness shaping

### Noise / Grain Requirements
- Add subtle grain/noise layer in shader
- Add slider for grain intensity
- Default grain low/subtle
- Grain reduces banding; fine-grained and premium
- Not chunky/dirty
- Static OK; very subtle animated noise OK if performant

### Organic Blob Distortion Requirements (Separate control from grain)
- Add controls:
  - slider: **Blob Distortion**
  - slider: **Distortion Scale**
  - optional slider: **Distortion Speed**
- Use low-frequency procedural noise to distort metaball field or UV coords
- Goal: blobs less perfectly circular; organic
- Default: mild irregularity
- Avoid jagged/chaotic edges
- Premium/atmospheric; not lava lamp/glitch
- Keep **grain** and **blob distortion** as separate controls

### Global Softness + Softness Variation Requirements
- Add controls:
  - slider: **Global Softness**
  - slider: **Softness Variation**
- Each metaball has its own softness/falloff behavior
- Variation slider introduces random deviation per blob around global softness:
  - Variation = 0 → all blobs same softness
  - Higher variation → some more diffused, some tighter
- Default subtle and elegant
- Avoid extreme differences that break smooth gradient blending
- Do **not** use CSS blur
- Implement softness in shader by varying falloff/field softness per blob
- Generate stable random per-blob softness parameters in JS and pass to shader
- Do not re-randomize every frame

### UI Controls Requirements (Floating Panel)
Panel must be:
- small, floating, compact
- simple + modern
- good spacing, readable over background
- optional hide/minimize button if clean/easy
- no clutter; only minimal useful extras

Required controls:
1. Slider: **metaball count** (1–8, default 3)
2. Slider: **grain intensity** (sensible range, default subtle)
3. Slider: **Blob Distortion** (default low)
4. Slider: **Distortion Scale** (default broad/soft)
5. Optional slider: **Distortion Speed** (default very slow)
6. Slider: **Global Softness**
7. Slider: **Softness Variation** (default subtle)
8. For each active metaball:
   - label: Blob 1, Blob 2, …
   - color input
   - clickable preset swatches beside/below color input

### Default Palette / Swatches (Clickable Presets)
Include all 10 swatches as chips in the UI.

Dark Purple:
- #4D1D82
- #6C4D97
- #9179B1
- #B5A6CB
- #DAD2E5

Purple:
- #8B1D82
- #A24A9B
- #B977B4
- #D1A5CD
- #E8D2E6

Swatch requirements:
- visible clickable chips
- clicking applies color to the corresponding metaball
- initial default metaball colors selected from this palette
- choose refined default combination for 3 blobs (darker/mid tones first)

### Performance Requirements (Critical)
Implement all:
1. **Render scale**:
   - render WebGL to reduced internal resolution
   - upscale to viewport
   - configurable `renderScale` in code
   - default: desktop ~0.65, mobile ~0.5
2. **Device pixel ratio cap**:
   - cap DPR to max 1.5 or 2
   - avoid full-res on high-DPI screens
3. **Efficient animation loop**:
   - use `requestAnimationFrame`
   - avoid allocations in render loop
   - avoid rebuilding arrays/objects every frame
4. **Pause on hidden tab**:
   - Page Visibility API
   - stop rendering when hidden; resume when visible
5. **Resize handling**:
   - handle resize correctly
   - update viewport/uniforms only when needed
6. **Blob cap**:
   - hard max metaballs = 8
7. **Shader efficiency**:
   - keep math reasonably simple
   - don’t overcomplicate noise/field
8. **Pointer behavior**:
   - canvas must not interfere with page interaction
9. **View-based reduction**:
   - at minimum: hidden-tab pause
   - don’t overengineer

### Technical Implementation Notes (JavaScript)
- Clean WebGL init
- Shader compile with error handling
- Pass uniforms for:
  - resolution
  - time
  - grain intensity
  - metaball count
  - global softness
  - softness variation
  - blob distortion amount
  - distortion scale
  - distortion speed (if implemented)
  - metaball positions
  - metaball radii
  - metaball colors
  - metaball softness values
  - metaball animation params (if needed)
- Use stable pre-generated per-metaball data:
  - seed values
  - motion amplitudes
  - motion frequencies
  - phase offsets
  - size pulse amplitude/frequency
  - softness seed
  - distortion seed
- Do not re-randomize every frame
- Recommended data per metaball:
  - baseX/baseY
  - moveAmpX/moveAmpY
  - moveFreqX/moveFreqY
  - radius
  - pulseAmp/pulseFreq
  - phase
  - softnessSeed
  - distortionSeed
  - color

### CSS Requirements
- reset body margins
- background canvas fills screen
- content above the canvas
- minimal elegant floating control panel
- swatches styled as clickable chips
- clean modern look

### HTML Requirements
`index.html` must include:
- canvas container / WebGL canvas
- minimal example foreground content
- control panel markup
- script include

### Code Quality Requirements
- code clean, readable, modular
- comment important sections, especially:
  - performance-related decisions
  - shader uniform structure
  - where to tweak defaults
- avoid narrating obvious code in comments

### Default Art Direction (North Star)
- premium, calm, soft, atmospheric, brand-friendly
- suitable behind text/UI
- not flashy, not gaming/VJ, not chaotic oversaturated
- suitable for landing/product/design-system/brand backgrounds
- blobs softly blended, gently irregular, diffusion varied, rich but restrained

### After the Code (Required explanation topics)
Include a short explanation covering:
1. where to change default colors
2. where to change render scale
3. where to change max metaball count
4. where to tweak movement speed
5. where to tweak grain amount
6. where to tweak blob distortion
7. where to tweak global softness and softness variation
8. how to embed behind a real webpage

