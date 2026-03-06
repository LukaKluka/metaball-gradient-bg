## Metaball Gradient Background (WebGL)

Production-ready animated metaball gradient background built with plain JavaScript + WebGL shaders.

### Run locally

```bash
python3 -m http.server 5174
```

Open `http://localhost:5174/`.

### What’s included
- Metaball gradient shader (soft premium blending)
- Grain + blob distortion + global softness controls
- Background color control (with swatches)
- Saved versions (stored in browser `localStorage`)
- Embed code generator (top-right panel)

### Embedding
Use the **Embed code** panel to copy an HTML snippet that sets `window.METABALL_BG_CONFIG` and loads `script.js`.
Adjust `YOUR_PATH/script.js` to your deployed asset URL.

