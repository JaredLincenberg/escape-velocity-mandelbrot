import base64, pathlib

# Run from the repo root. Needs a local `fonts/` folder (see README) and
# `three.min.js` (Three.js r128, e.g. from unpkg.com/three@0.128.0/build/three.min.js)
# alongside this script -- neither is committed, since they're large and easy
# to re-fetch.
d = pathlib.Path(__file__).parent
fonts = d / "fonts"

shell = (d / "shell.html").read_text()
three_js = (d / "three.min.js").read_text()
app_js = (d / "app.js").read_text()

fraunces_b64 = base64.b64encode((fonts / "fraunces-700.woff2").read_bytes()).decode()
plex400_b64 = base64.b64encode((fonts / "plexmono-400.woff2").read_bytes()).decode()
plex500_b64 = base64.b64encode((fonts / "plexmono-500.woff2").read_bytes()).decode()

out = (shell
    .replace("__FRAUNCES_B64__", fraunces_b64)
    .replace("__PLEXMONO400_B64__", plex400_b64)
    .replace("__PLEXMONO500_B64__", plex500_b64)
    .replace("__THREE_JS__", three_js)
    .replace("__APP_JS__", app_js)
)

out_path = d / "index.html"
out_path.write_text(out)
print(out_path, len(out) / 1024 / 1024, "MB")
