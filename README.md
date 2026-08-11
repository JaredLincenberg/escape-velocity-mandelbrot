# Escape Velocity — a Mandelbrot Hair Field

A 3D, wind-swept "hair field" visualization of the Mandelbrot set's escape-time
data, built with Three.js/WebGL. Each strand grows from a point in the complex
plane:

- **Height** — escape speed. Taller strands take longer to leave the disk,
  i.e. sit closer to the set's boundary.
- **Color** — the same escape value, banded through the active palette.
- **Lean** — direction of steepest change in escape time (an external-ray-like
  pointer toward the boundary), plus wind animated on top.
- **Width** — base thickness also tracks escape speed; each blade tapers to a
  point along its length.

It also includes a flat ground-plane render of the same field, a click-to-trace
tool that draws a picked point's actual orbit (z₀=0, z₁=c, z₂=z₁²+c, ...) as an
animated, steppable path, real resolution-preserving zoom (cropping the
rendered region rather than just moving the camera), several color schemes
(including black-and-white and a rainbow HSV sweep), and PNG capture.

## Run it

Open `index.html` in a browser. It's fully self-contained — Three.js and the
fonts are inlined, no build step or network access required.

## Inspiration

Visual direction pulled from this Blender wind/grass dataviz reference:
https://www.youtube.com/watch?v=zFpamnNEyBw — reimplemented from scratch in
Three.js rather than Blender.

## Source layout

- `app.js` — all application logic: escape-time field computation, GLSL
  shaders, camera/orbit controls, orbit tracer, UI wiring.
- `shell.html` — the HTML/CSS template, with `__THREE_JS__` / `__APP_JS__` /
  font placeholders.
- `build.py` — assembles `shell.html` + `three.min.js` + `app.js` + three
  base64-embedded Google Fonts (Fraunces 700, IBM Plex Mono 400/500) into the
  single self-contained `index.html`.

`three.min.js` and the font files aren't committed (large, easy to re-fetch).
To rebuild `index.html` yourself:

```
mkdir -p fonts
curl -L -o three.min.js https://unpkg.com/three@0.128.0/build/three.min.js
# fetch fraunces-700.woff2, plexmono-400.woff2, plexmono-500.woff2 into fonts/
# from Google Fonts (css2 API -> gstatic .woff2 URLs)
python3 build.py
```

## Note

This project was vibe-coded collaboratively: the repo owner drove direction,
feedback, and each round of iteration; [Claude Code](https://claude.com/claude-code)
filled in the implementation details and wrote the code.

## License

[CC BY 4.0](LICENSE) — free to share and adapt, with attribution.
