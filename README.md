# HTML to Figma

Import any webpage into Figma as editable layers — like [html.to.design](https://www.figma.com/community/plugin/1159123024924461424) — using two local pieces:

1. **`chrome-extension/`** — captures the current page (layout, computed styles, text, images, inline SVG) and saves it as a **`.h2f`** file (gzipped JSON, open format).
2. **`figma-plugin/`** — imports a `.h2f` file and rebuilds the page as real Figma frames, text nodes, image fills, gradients, shadows and vectors.

```
webpage ──(Chrome extension)──▶ page.h2f ──(Figma plugin)──▶ Figma layers
```

## Install

### Chrome extension
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `chrome-extension/` folder

### Figma plugin (Figma **desktop** app required for dev plugins)
1. In Figma, open any design file
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `figma-plugin/manifest.json`

## Use

1. Open the page you want to capture.
2. Click the extension icon and pick a **Width** — 1920, 1440, 1280, 1024, 768, 390, or *Current window size*.
   The page is re-rendered at exactly that CSS width before it is measured, so a responsive site gives you
   the layout it actually serves at that width. This is the single biggest factor in whether the import
   looks right: capturing a desktop site inside a 1200px-wide browser window gets you the 1200px layout,
   and any desktop-only section is `display:none` at that width and simply will not be there.
3. Click **Capture full page** (or *Capture viewport only*).
   - Chrome shows a **"…is debugging this browser"** bar while the width override is active. That is expected;
     it disappears when the capture finishes. (The official html.to.design extension does the same thing.)
   - The page scrolls itself top-to-bottom first so lazy-loaded images load, then returns to the top — you no longer need to do this by hand.
   - **Include off-screen carousel slides** (on by default) also brings in the slides parked outside a carousel's window, so you get every slide as a layer. Turn it off for a leaner capture of strictly what's on screen.
4. A `something_1920w_123456.h2f` file lands in your Downloads folder (the width is in the name).
5. In Figma: **Plugins → Development → HTML to Figma Importer**, then drop the `.h2f` file into the plugin window.
6. The page appears as a frame at your viewport center, fully layered.

## What gets captured

| Feature | Support |
|---|---|
| Layout (exact positions/sizes) | ✅ absolute layout |
| Capture width (1920 / 1440 / 1280 / 1024 / 768 / 390) | ✅ the page is re-rendered at that exact CSS width first, so responsive layouts and media queries resolve correctly |
| Text (font family/size/weight/style, color, spacing, decoration, transform) | ✅ mapped to closest installed Figma font, falls back to Inter |
| Multi-line text | ✅ captured one node per visual line, so a substituted font can't re-wrap it into the layer below |
| Masked icons (`mask-image` + a flat colour — the common icon-sprite pattern) | ✅ the mask shape is imported as a vector and tinted; without this every such icon becomes a solid square |
| Background colors, linear gradients | ✅ (radial/conic approximated) |
| Carousels / sliders (Swiper, Splide, Flickity, slick…) | ✅ slides are kept even though the track is transformed far off-screen, and clipped to the carousel window in Figma |
| Scrollable containers, off-canvas panels, dropdowns | ✅ culled against the real clip rectangle, so hidden overflow doesn't leak in |
| Images (`<img>`, CSS backgrounds, canvas, video posters) | ✅ fetched with page cookies, webp/avif re-encoded to PNG, downscaled to 2× their on-screen size (capped at 4000px) |
| Inline SVG and `.svg` images | ✅ imported as real vectors |
| Borders (incl. per-side), corner radii, box shadows, opacity, overflow clipping | ✅ |
| Form controls (values/placeholders) | ✅ as text on styled boxes |
| Open shadow DOM / web components / slots | ✅ composed-tree traversal |
| Auto Layout generation | ❌ (positions are absolute) |
| `::before` / `::after` pseudo-elements | ❌ |
| CSS transforms, filters, blend modes | ❌ |
| `<input type="range">` sliders | ❌ box only — the track and thumb are browser-drawn and aren't captured |
| iframes, closed shadow roots | ❌ skipped |

## Notes & limits

- Captures cap at **12 000 layers**, **12 MB per image**, ~**120 MB** of images total; anything above is skipped with a warning.
- The capture returns to scroll-zero before measuring, so fixed/sticky headers land at their unstuck position.
- Because each text node is one visual line, a wrapped paragraph arrives as several text layers. That is the trade-off for not having text re-flow and overlap when the original font isn't installed.
- Cookie/consent banners are part of the page, so they are captured too. Dismiss them before capturing.
- Fonts are matched by family name against fonts available in Figma. Install the page's fonts locally (or in Figma) before importing for best fidelity, otherwise Inter is substituted.
- The `.h2f` file is just gzipped JSON — you can inspect it: `python -c "import gzip,sys;sys.stdout.buffer.write(gzip.open(sys.argv[1]).read())" page.h2f > page.json`
- Not compatible with html.to.design's proprietary `.h2d` files.

## Repo layout

```
chrome-extension/
  manifest.json    MV3 manifest
  popup.html/js    capture UI
  content.js       DOM → h2f serializer (styles, text, geometry, clip-aware culling)
  background.js    viewport-width driver (CDP) + image fetcher/encoder (CORS bypass, PNG re-encode, downscale)
figma-plugin/
  manifest.json    Figma plugin manifest (no network access)
  ui.html          file drop + gunzip + base64→bytes
  code.js          h2f → Figma nodes (fonts, fills, strokes, effects, text)
```
