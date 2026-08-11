(function () {
  'use strict';

  // ---------- Mandelbrot escape-time field ----------
  var ASPECT = 2.5 / 3.5; // fixed imaginary:real ratio of the original framing
  var MAX_ITER = 200;

  var WORLD_W = 3.4;
  var WORLD_D = WORLD_W * ASPECT;
  var MAX_HEIGHT = 0.62;
  var BASE_HEIGHT = 0.018;

  var params = {
    density: 170,     // grid columns (NX); rows derive from ASPECT
    centerRe: -0.75,
    centerIm: 0,
    span: 3.5,        // real-axis width of the rendered region
    bands: 8,
    scheme: 'ember'
  };

  // Each scheme is deep -> mid -> hot, as 0-1 floats (shader-ready).
  var SCHEMES = {
    ember: { deep: [0.1098, 0.2471, 0.4314], mid: [0.3098, 0.6588, 0.7882], hot: [1.0, 0.7059, 0.3294] },
    violet: { deep: [0.1216, 0.0784, 0.2196], mid: [0.4667, 0.3216, 0.7686], hot: [1.0, 0.4118, 0.6824] },
    verdant: { deep: [0.0706, 0.2039, 0.1255], mid: [0.2471, 0.6824, 0.4157], hot: [0.8510, 1.0, 0.3608] },
    ice: { deep: [0.0392, 0.0392, 0.0392], mid: [0.5490, 0.5490, 0.5490], hot: [1.0, 1.0, 1.0] },
    rainbow: { deep: [0, 0, 0], mid: [0, 0, 0], hot: [1.0, 1.0, 1.0], rainbow: true }
  };

  function lerp3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  // Standard HSV->RGB, mirrored in GLSL (see hsv2rgb in the vertex shader) so
  // the rainbow scheme looks identical on the strands and the flat ground.
  function hsv2rgb(h, s, v) {
    h = ((h % 1) + 1) % 1;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  }
  // Mirrors the GLSL palette() in the strand shader -- keeps the flat render's
  // colors identical to the 3D field's colors for the same mu/bands/scheme.
  function paletteRGB(mu, bands, scheme) {
    var t = mu;
    if (bands > 1.5) t = Math.floor(Math.min(mu, 0.999) * bands) / (bands - 1);
    t = Math.min(1, Math.max(0, t));
    if (scheme.rainbow) {
      var rc = hsv2rgb(t * 0.85, 0.85, 1.0);
      return [rc[0] * 255, rc[1] * 255, rc[2] * 255];
    }
    var c = t < 0.6 ? lerp3(scheme.deep, scheme.mid, t / 0.6) : lerp3(scheme.mid, scheme.hot, (t - 0.6) / 0.4);
    return [c[0] * 255, c[1] * 255, c[2] * 255];
  }

  function computeField(nx, ny, xMin, xMax, yMin, yMax) {
    // Pass 1: dense mu grid, including culled cells (as mu=0), so the
    // gradient computed in pass 2 has a sensible value at every neighbor.
    var muGrid = new Float32Array(nx * ny);
    for (var j = 0; j < ny; j++) {
      var cy = yMin + ((j + 0.5) / ny) * (yMax - yMin);
      for (var i = 0; i < nx; i++) {
        var cx = xMin + ((i + 0.5) / nx) * (xMax - xMin);
        var idx = j * nx + i;
        if (cx * cx + cy * cy > 4) continue; // |c| > 2 always escapes immediately -- mu stays 0

        var zx = 0, zy = 0, n = 0;
        var zx2 = 0, zy2 = 0;
        while (n < MAX_ITER && zx2 + zy2 <= 4) {
          zy = 2 * zx * zy + cy;
          zx = zx2 - zy2 + cx;
          zx2 = zx * zx; zy2 = zy * zy;
          n++;
        }
        if (n >= MAX_ITER) continue; // interior: never escapes -- mu stays 0

        var logZn = Math.log(zx2 + zy2) / 2;
        var nu = Math.log(logZn / Math.LN2) / Math.LN2;
        muGrid[idx] = Math.min(1, Math.max(0, (n + 1 - nu) / MAX_ITER));
      }
    }

    // Pass 2: renderable points get a lean direction from the *gradient* of
    // the escape-time field (an external-ray-like direction -- points away
    // from fast-escaping regions toward the boundary), not from any single
    // orbit. Cheap: it's just finite differences over the grid we already have.
    var dx = (xMax - xMin) / nx, dy = (yMax - yMin) / ny;
    var pts = [];
    for (var jj = 0; jj < ny; jj++) {
      for (var ii = 0; ii < nx; ii++) {
        var mu = muGrid[jj * nx + ii];
        if (mu <= 0) continue; // interior or outside the |c|<=2 disk -- not rendered

        var iL = ii > 0 ? ii - 1 : ii, iR = ii < nx - 1 ? ii + 1 : ii;
        var jD = jj > 0 ? jj - 1 : jj, jU = jj < ny - 1 ? jj + 1 : jj;
        var gx = (muGrid[jj * nx + iR] - muGrid[jj * nx + iL]) / ((iR - iL || 1) * dx);
        var gy = (muGrid[jU * nx + ii] - muGrid[jD * nx + ii]) / ((jU - jD || 1) * dy);
        var glen = Math.sqrt(gx * gx + gy * gy) || 1;
        pts.push({ i: ii, j: jj, mu: mu, dirx: gx / glen, diry: gy / glen });
      }
    }
    return pts;
  }

  // ---------- Scene ----------
  var BG = 0x05070c;

  var canvas = document.getElementById('gl');
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, alpha: false,
    preserveDrawingBuffer: true // needed so the canvas can be captured to a PNG on demand
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BG, 1);

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG, 0.14);

  var camera = new THREE.PerspectiveCamera(48, 1, 0.05, 30);
  var target = new THREE.Vector3(0, 0.28, -WORLD_D * 0.18);
  var orbit = { theta: 0.05, phi: 1.30, radius: 3.05 };
  var ORBIT_MIN_PHI = 0.35, ORBIT_MAX_PHI = 1.5, ORBIT_MIN_R = 0.15, ORBIT_MAX_R = 6.0;
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Real (resolution-preserving) zoom ----------
  // Moving the camera closer alone just magnifies the same low-res grid.
  // Real zoom also shrinks the rendered complex-plane region (span) so the
  // same strand/pixel density covers a smaller area -- more detail per
  // inch, not just a bigger picture of the same data.
  var BASE_RADIUS = orbit.radius, BASE_SPAN = params.span;
  var SPAN_MIN = 0.05, SPAN_MAX = 3.5;
  function spanForRadius(r) {
    return Math.min(SPAN_MAX, Math.max(SPAN_MIN, BASE_SPAN * (r / BASE_RADIUS)));
  }
  var fieldRebuildTimer = null;
  function scheduleFieldRebuild() {
    if (fieldRebuildTimer) clearTimeout(fieldRebuildTimer);
    fieldRebuildTimer = setTimeout(function () {
      fieldRebuildTimer = null;
      buildField();
      buildFlatField();
    }, 140);
  }

  function updateCameraFromOrbit() {
    camera.position.x = target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
    camera.position.y = target.y + orbit.radius * Math.cos(orbit.phi);
    camera.position.z = target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
    camera.lookAt(target);
  }
  updateCameraFromOrbit();

  // ---------- Drag-to-orbit camera ----------
  var dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, lastInteraction = -1e9;
  var tween = null;
  var spin = { enabled: true, speed: 0.05 };
  var traceMode = false; // set true once the trace-picker below wires up
  var dom = renderer.domElement;
  dom.style.touchAction = 'none';
  dom.style.cursor = 'grab';

  function onPointerDown(e) {
    dragging = true;
    tween = null;
    lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY;
    dom.style.cursor = traceMode ? 'crosshair' : 'grabbing';
    if (dom.setPointerCapture) dom.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    orbit.theta -= dx * 0.005;
    orbit.phi = Math.min(ORBIT_MAX_PHI, Math.max(ORBIT_MIN_PHI, orbit.phi - dy * 0.005));
    lastInteraction = performance.now();
    updateCameraFromOrbit();
  }
  function onPointerUp(e) {
    dragging = false;
    dom.style.cursor = traceMode ? 'crosshair' : 'grab';
    if (traceMode && e && typeof pickTraceAt === 'function') {
      var dist = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (dist < 5) pickTraceAt(e.clientX, e.clientY);
    }
  }
  function onWheel(e) {
    e.preventDefault();
    tween = null;
    orbit.radius = Math.min(ORBIT_MAX_R, Math.max(ORBIT_MIN_R, orbit.radius * (1 + e.deltaY * 0.001)));
    params.span = spanForRadius(orbit.radius);
    lastInteraction = performance.now();
    updateCameraFromOrbit();
    syncZoomUI();
    syncSpanUI();
    scheduleFieldRebuild();
  }
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('wheel', onWheel, { passive: false });

  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0a0f18, 0.65));
  var key = new THREE.DirectionalLight(0xffe2b8, 0.55);
  key.position.set(-1.5, 2.2, 1.2);
  scene.add(key);

  // The ground is textured with the same field, rendered flat (see buildFlatField
  // / paintFlatCanvas below) -- the strands grow out of their own escape-time map.
  var groundTexture = new THREE.CanvasTexture(document.getElementById('flat'));
  var ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_W, WORLD_D),
    new THREE.MeshBasicMaterial({ map: groundTexture })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  scene.add(ground);

  // Invisible plane, always raycastable regardless of the ground layer
  // toggle -- lets "pick a point" work even with the ground hidden.
  var pickPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_W, WORLD_D),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
  );
  pickPlane.rotation.x = -Math.PI / 2;
  scene.add(pickPlane);
  var raycaster = new THREE.Raycaster();

  // ---------- Strand shader + material (shared across rebuilds) ----------
  var vertexShader = [
    'attribute float aMu;',
    'attribute float aPhase;',
    'attribute vec2 aDir;',
    'uniform float uTime;',
    'uniform float uSwayAmp;',
    'uniform float uSwaySpeed;',
    'uniform float uLeanAmount;',
    'uniform float uBands;',
    'uniform float uRainbow;',
    'uniform vec3 uDeep;',
    'uniform vec3 uMid;',
    'uniform vec3 uHot;',
    'varying vec3 vColor;',
    'varying float vY;',
    'vec3 hsv2rgb(vec3 c) {',
    '  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);',
    '  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);',
    '  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);',
    '}',
    'vec3 palette(float mu) {',
    '  float b = max(uBands, 1.0);',
    '  float t = (uBands > 1.5) ? floor(clamp(mu, 0.0, 0.999) * b) / (b - 1.0) : mu;',
    '  t = clamp(t, 0.0, 1.0);',
    '  if (uRainbow > 0.5) { return hsv2rgb(vec3(t * 0.85, 0.85, 1.0)); }',
    '  return t < 0.6 ? mix(uDeep, uMid, t / 0.6) : mix(uMid, uHot, (t - 0.6) / 0.4);',
    '}',
    'void main() {',
    '  vColor = palette(aMu);',
    '  vY = position.y;',
    '  float bend = vY * vY;',
    // taper each blade toward a point instead of a blunt rectangle -- the
    // rectangle was reading as fat/blobby ("pinata") at a distance
    '  float taper = mix(1.0, 0.16, pow(vY, 1.15));',
    // taper both X and Z -- one crossed blade's width runs along X, the
    // other along Z (baked in by the 90-degree merge), each axis is 0 on
    // the blade it doesn't belong to so this is a no-op there.
    '  vec3 localPos = vec3(position.x * taper, position.y, position.z * taper);',
    '  vec4 wp = instanceMatrix * vec4(localPos, 1.0);',
    '  float wind = sin(uTime * uSwaySpeed + aPhase + wp.x * 1.6 + wp.z * 0.9);',
    '  float wind2 = sin(uTime * uSwaySpeed * 0.6 + aPhase * 1.3 - wp.z * 1.1);',
    // aDir is the gradient of the escape-time field (external-ray-like),
    // used here to set each strand's resting lean; wind animates on top.
    '  wp.x += bend * (aDir.x * uLeanAmount + uSwayAmp * wind);',
    '  wp.z += bend * (aDir.y * uLeanAmount + uSwayAmp * 0.4 * wind2);',
    '  gl_Position = projectionMatrix * modelViewMatrix * wp;',
    '}'
  ].join('\n');

  var fragmentShader = [
    'uniform vec3 uHot;',
    'varying vec3 vColor;',
    'varying float vY;',
    'void main() {',
    '  float shade = mix(0.4, 1.2, smoothstep(0.0, 1.0, vY));',
    '  vec3 col = vColor * shade;',
    '  col += uHot * pow(vY, 6.0) * 0.35;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var activeScheme = SCHEMES[params.scheme];

  var material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSwayAmp: { value: 0.035 },
      uSwaySpeed: { value: 0.9 },
      uLeanAmount: { value: 0.15 },
      uBands: { value: params.bands },
      uRainbow: { value: activeScheme.rainbow ? 1 : 0 },
      uDeep: { value: new THREE.Vector3().fromArray(activeScheme.deep) },
      uMid: { value: new THREE.Vector3().fromArray(activeScheme.mid) },
      uHot: { value: new THREE.Vector3().fromArray(activeScheme.hot) }
    },
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    side: THREE.DoubleSide,
    fog: false
  });

  var waveAmp = 0.035; // saved amplitude so "stop waving" can restore it exactly

  // ---------- Strand instancing (rebuilt on density/region change) ----------
  var mesh = null;
  var dummy = new THREE.Object3D();
  var layers = { strands: true, ground: true };

  // Two crossed quads instead of one flat card -- a single card can vanish
  // edge-on from some angles; crossing two at 90 degrees always shows volume.
  function makeBladeGeometry() {
    var a = new THREE.PlaneGeometry(1, 1, 1, 7);
    a.translate(0, 0.5, 0);
    var b = a.clone();
    b.rotateY(Math.PI / 2);

    var posA = a.attributes.position.array, posB = b.attributes.position.array;
    var idxA = a.index.array, idxB = b.index.array;
    var vertsA = posA.length / 3;

    var positions = new Float32Array(posA.length + posB.length);
    positions.set(posA, 0);
    positions.set(posB, posA.length);

    var IndexArray = positions.length / 3 > 65535 ? Uint32Array : Uint16Array;
    var indices = new IndexArray(idxA.length + idxB.length);
    indices.set(idxA, 0);
    for (var i = 0; i < idxB.length; i++) indices[idxA.length + i] = idxB[i] + vertsA;

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
  }

  function disposeField() {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
  }

  function buildField() {
    disposeField();

    var xMin = params.centerRe - params.span / 2;
    var xMax = params.centerRe + params.span / 2;
    var yHalf = (params.span * ASPECT) / 2;
    var yMin = params.centerIm - yHalf;
    var yMax = params.centerIm + yHalf;
    var nx = params.density;
    var ny = Math.max(2, Math.round(nx * ASPECT));

    var field = computeField(nx, ny, xMin, xMax, yMin, yMax);
    var count = field.length;

    var bladeGeo = makeBladeGeometry();

    var mus = new Float32Array(count);
    var phases = new Float32Array(count);
    var dirs = new Float32Array(count * 2);

    mesh = new THREE.InstancedMesh(bladeGeo, material, count);

    for (var k = 0; k < count; k++) {
      var p = field[k];
      var x = (p.i / nx - 0.5) * WORLD_W;
      var z = (p.j / ny - 0.5) * WORLD_D;
      var jitterX = (Math.random() - 0.5) * (WORLD_W / nx) * 0.9;
      var jitterZ = (Math.random() - 0.5) * (WORLD_D / ny) * 0.9;

      var h = BASE_HEIGHT + MAX_HEIGHT * Math.pow(p.mu, 0.55) * (0.85 + Math.random() * 0.3);
      var w = 0.009 + 0.006 * p.mu;

      dummy.position.set(x + jitterX, 0, z + jitterZ);
      dummy.rotation.set(0, Math.random() * Math.PI, 0);
      dummy.scale.set(w, h, w); // w on both X and Z -- thins whichever crossed blade uses each axis
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);

      mus[k] = p.mu;
      phases[k] = Math.random() * Math.PI * 2;
      dirs[k * 2] = p.dirx; dirs[k * 2 + 1] = p.diry;
    }
    mesh.instanceMatrix.needsUpdate = true;
    bladeGeo.setAttribute('aMu', new THREE.InstancedBufferAttribute(mus, 1));
    bladeGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    bladeGeo.setAttribute('aDir', new THREE.InstancedBufferAttribute(dirs, 2));
    mesh.visible = layers.strands;
    scene.add(mesh);

    lastStrandCount = count;
    updateHUD();
    var boundsEl = document.getElementById('stat-bounds');
    if (boundsEl) {
      boundsEl.textContent = 'ℜ ∈ [' + xMin.toFixed(2) + ', ' + xMax.toFixed(2) + ']' +
        '  ℑ ∈ [' + yMin.toFixed(2) + ', ' + yMax.toFixed(2) + ']i';
    }
  }

  // ---------- Ground texture: the same field, rendered as a flat image ----------
  // Independent of the strand density slider -- fixed resolution so the
  // ground stays crisp regardless of how many strands are set.
  var FLAT_NX = 640, FLAT_NY = Math.round(FLAT_NX * ASPECT);
  var flatMu = null; // Float32Array, -1 = background (interior or outside |c|<=2)
  var lastStrandCount = 0;

  function updateHUD() {
    var countEl = document.getElementById('stat-count');
    if (countEl) countEl.textContent = lastStrandCount.toLocaleString();
  }

  function buildFlatField() {
    var xMin = params.centerRe - params.span / 2;
    var xMax = params.centerRe + params.span / 2;
    var yHalf = (params.span * ASPECT) / 2;
    var yMin = params.centerIm - yHalf;
    var yMax = params.centerIm + yHalf;

    flatMu = new Float32Array(FLAT_NX * FLAT_NY);
    for (var j = 0; j < FLAT_NY; j++) {
      var cy = yMin + ((j + 0.5) / FLAT_NY) * (yMax - yMin);
      for (var i = 0; i < FLAT_NX; i++) {
        var cx = xMin + ((i + 0.5) / FLAT_NX) * (xMax - xMin);
        var idx = j * FLAT_NX + i;
        flatMu[idx] = -1;
        if (cx * cx + cy * cy > 4) continue;
        var zx = 0, zy = 0, n = 0, zx2 = 0, zy2 = 0;
        while (n < MAX_ITER && zx2 + zy2 <= 4) {
          zy = 2 * zx * zy + cy;
          zx = zx2 - zy2 + cx;
          zx2 = zx * zx; zy2 = zy * zy;
          n++;
        }
        if (n >= MAX_ITER) continue;
        var logZn = Math.log(zx2 + zy2) / 2;
        var nu = Math.log(logZn / Math.LN2) / Math.LN2;
        flatMu[idx] = Math.min(1, Math.max(0, (n + 1 - nu) / MAX_ITER));
      }
    }
    paintFlatCanvas();
  }

  function paintFlatCanvas() {
    if (!flatMu) return;
    var canvas = document.getElementById('flat');
    if (!canvas) return;
    canvas.width = FLAT_NX;
    canvas.height = FLAT_NY;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(FLAT_NX, FLAT_NY);
    var bands = material.uniforms.uBands.value;
    var scheme = SCHEMES[params.scheme];
    for (var k = 0; k < FLAT_NX * FLAT_NY; k++) {
      var mu = flatMu[k];
      var r = 5, g = 7, b = 12; // background, matches --bg
      if (mu >= 0) {
        var c = paletteRGB(mu, bands, scheme);
        r = c[0]; g = c[1]; b = c[2];
      }
      var o = k * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    groundTexture.needsUpdate = true;
  }

  function setScheme(name) {
    var s = SCHEMES[name];
    if (!s) return;
    params.scheme = name;
    material.uniforms.uDeep.value.fromArray(s.deep);
    material.uniforms.uMid.value.fromArray(s.mid);
    material.uniforms.uHot.value.fromArray(s.hot);
    material.uniforms.uRainbow.value = s.rainbow ? 1 : 0;
    paintFlatCanvas();
  }

  buildField();
  buildFlatField();

  // ---------- Escape-path tracer ----------
  // Traces a single point's actual orbit z0=0, z1=c, z2=z1^2+c, ... anchored
  // at the picked world position: X/Z offset from the anchor track the
  // orbit's position in the complex plane, Y (height) tracks iteration
  // count -- the same "taller = takes longer to escape" language as the
  // field itself, just for one literal trajectory instead of a gradient.
  var TRACE_XY_SCALE = 0.28;
  var TRACE_MAX_HEIGHT = 0.95;
  var TRACE_PLAY_RATE = 2.2; // iterations per second while auto-playing
  var traceGroup = new THREE.Group();
  scene.add(traceGroup);
  var traceMesh = null, traceHead = null, traceRoot = null;
  var traceState = null;

  function computeOrbit(cx, cy) {
    var orbit = [{ x: 0, y: 0 }];
    var zx = 0, zy = 0, escapeIter = -1;
    for (var n = 1; n <= MAX_ITER; n++) {
      var zx2 = zx * zx, zy2 = zy * zy;
      var nzx = zx2 - zy2 + cx;
      var nzy = 2 * zx * zy + cy;
      zx = nzx; zy = nzy;
      orbit.push({ x: zx, y: zy });
      if (zx * zx + zy * zy > 4) { escapeIter = n; break; }
    }
    return { orbit: orbit, escapeIter: escapeIter };
  }

  function orbitToWorld(anchor, pt, k, limit) {
    return new THREE.Vector3(
      anchor.x + pt.x * TRACE_XY_SCALE,
      BASE_HEIGHT + (limit > 0 ? k / limit : 0) * TRACE_MAX_HEIGHT,
      anchor.z + pt.y * TRACE_XY_SCALE
    );
  }

  function rainbowColor(t) {
    var c = hsv2rgb(t * 0.85, 0.85, 1.0);
    return new THREE.Color(c[0], c[1], c[2]);
  }

  function disposeTraceMesh() {
    if (traceMesh) { traceGroup.remove(traceMesh); traceMesh.geometry.dispose(); traceMesh.material.dispose(); traceMesh = null; }
    if (traceHead) { traceGroup.remove(traceHead); traceHead.geometry.dispose(); traceHead.material.dispose(); traceHead = null; }
  }

  function buildRootMarker(anchor) {
    if (traceRoot) { traceGroup.remove(traceRoot); traceRoot.geometry.dispose(); traceRoot.material.dispose(); traceRoot = null; }
    var geo = new THREE.RingGeometry(0.02, 0.032, 24);
    var mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85, fog: false, depthWrite: false });
    traceRoot = new THREE.Mesh(geo, mat);
    traceRoot.rotation.x = -Math.PI / 2;
    traceRoot.position.set(anchor.x, 0.003, anchor.z);
    traceGroup.add(traceRoot);
  }

  // Rebuilds the visible path up through the (possibly fractional) reveal
  // point -- the fractional tail is a straight lerp between the two orbit
  // points it falls between, which is what makes stepping, dragging the
  // slider, and auto-play all animate smoothly instead of popping.
  function rebuildTraceVisual() {
    if (!traceState) { disposeTraceMesh(); return; }
    var orbit = traceState.orbit;
    var limit = traceState.escapeIter >= 0 ? traceState.escapeIter : (orbit.length - 1);
    var d = Math.max(0, Math.min(limit, traceState.displayIter));
    var wholePart = Math.floor(d);
    var frac = d - wholePart;

    var positions = [], colors = [];
    for (var k = 0; k <= wholePart && k < orbit.length; k++) {
      var p = orbitToWorld(traceState.anchor, orbit[k], k, limit);
      positions.push(p.x, p.y, p.z);
      var col = rainbowColor(limit > 0 ? k / limit : 0);
      colors.push(col.r, col.g, col.b);
    }
    var tip;
    if (frac > 0.001 && wholePart + 1 < orbit.length) {
      var a = orbit[wholePart], b = orbit[wholePart + 1];
      var lerpPt = { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac };
      tip = orbitToWorld(traceState.anchor, lerpPt, wholePart + frac, limit);
      positions.push(tip.x, tip.y, tip.z);
      var tipCol = rainbowColor(limit > 0 ? (wholePart + frac) / limit : 0);
      colors.push(tipCol.r, tipCol.g, tipCol.b);
    } else {
      tip = orbitToWorld(traceState.anchor, orbit[wholePart], wholePart, limit);
    }

    disposeTraceMesh();

    if (positions.length >= 6) {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      var mat = new THREE.LineBasicMaterial({ vertexColors: true, fog: false });
      traceMesh = new THREE.Line(geo, mat);
      traceGroup.add(traceMesh);
    }

    var headColor = rainbowColor(limit > 0 ? d / limit : 0);
    var headGeo = new THREE.SphereGeometry(0.022, 12, 10);
    var headMat = new THREE.MeshBasicMaterial({ color: headColor, fog: false });
    traceHead = new THREE.Mesh(headGeo, headMat);
    traceHead.position.copy(tip);
    traceGroup.add(traceHead);
  }

  function updateTraceInfo() {
    var el = document.getElementById('trace-info');
    if (!el || !traceState) return;
    var sign = traceState.cy >= 0 ? '+' : '−';
    var status = traceState.escapeIter >= 0
      ? ('escapes at iteration ' + traceState.escapeIter)
      : ('stays bounded through ' + (traceState.orbit.length - 1) + ' iterations (interior)');
    el.textContent = 'c = ' + traceState.cx.toFixed(4) + ' ' + sign + ' ' + Math.abs(traceState.cy).toFixed(4) + 'i · ' + status;
  }

  function updateTraceIterUI() {
    var slider = document.getElementById('ctl-trace-iter');
    var label = document.getElementById('trace-iter-label');
    var maxLabel = document.getElementById('trace-iter-max');
    if (!traceState || !slider) return;
    var limit = traceState.escapeIter >= 0 ? traceState.escapeIter : (traceState.orbit.length - 1);
    slider.max = String(limit);
    slider.value = String(Math.round(traceState.currentIter));
    if (label) label.textContent = String(Math.round(traceState.currentIter));
    if (maxLabel) maxLabel.textContent = String(limit);
  }

  function setTraceControlsEnabled(enabled) {
    ['ctl-trace-iter', 'trace-minus', 'trace-plus', 'trace-play', 'trace-clear'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !enabled;
    });
  }

  function clearTrace() {
    traceState = null;
    disposeTraceMesh();
    if (traceRoot) { traceGroup.remove(traceRoot); traceRoot.geometry.dispose(); traceRoot.material.dispose(); traceRoot = null; }
    setTraceControlsEnabled(false);
    var info = document.getElementById('trace-info');
    if (info) info.textContent = 'Click “pick point,” then click anywhere on the field.';
    var slider = document.getElementById('ctl-trace-iter');
    if (slider) { slider.max = '0'; slider.value = '0'; }
    var label = document.getElementById('trace-iter-label'), maxLabel = document.getElementById('trace-iter-max');
    if (label) label.textContent = '0';
    if (maxLabel) maxLabel.textContent = '0';
    var playBtn = document.getElementById('trace-play');
    if (playBtn) { playBtn.textContent = 'PLAY'; playBtn.classList.remove('is-active'); }
  }

  function startTrace(cx, cy, anchor) {
    var result = computeOrbit(cx, cy);
    var limit = result.escapeIter >= 0 ? result.escapeIter : (result.orbit.length - 1);
    traceState = {
      cx: cx, cy: cy, anchor: anchor,
      orbit: result.orbit, escapeIter: result.escapeIter,
      currentIter: limit, displayIter: limit,
      playing: false, lastBuilt: -1
    };
    setTraceControlsEnabled(true);
    updateTraceIterUI();
    updateTraceInfo();
    buildRootMarker(anchor);
    rebuildTraceVisual();
    var playBtn = document.getElementById('trace-play');
    if (playBtn) { playBtn.textContent = 'PLAY'; playBtn.classList.remove('is-active'); }
  }

  function pickTraceAt(clientX, clientY) {
    var rect = dom.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObject(pickPlane);
    if (!hits.length) return;
    var pt = hits[0].point;
    var xMin = params.centerRe - params.span / 2, xMax = params.centerRe + params.span / 2;
    var yHalf = (params.span * ASPECT) / 2;
    var yMin = params.centerIm - yHalf, yMax = params.centerIm + yHalf;
    var cx = xMin + (pt.x / WORLD_W + 0.5) * (xMax - xMin);
    var cy = yMin + (pt.z / WORLD_D + 0.5) * (yMax - yMin);
    startTrace(cx, cy, { x: pt.x, z: pt.z });
  }

  // ---------- Resize ----------
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- Camera presets ----------
  var PRESETS = {
    full: { theta: 0.05, phi: 1.30, radius: 3.05, target: [0, 0.28, -WORLD_D * 0.18] },
    edge: { theta: 0.26, phi: 1.44, radius: 1.5, target: [0.35, 0.42, -WORLD_D * 0.10] },
    tip: { theta: -0.12, phi: 0.95, radius: 0.6, target: [0.55, 0.5, -WORLD_D * 0.04] }
  };

  function wrapAngleDelta(delta) {
    return delta - Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
  }
  function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  function goToPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    if (prefersReduced) {
      orbit.theta = p.theta; orbit.phi = p.phi; orbit.radius = p.radius;
      target.set(p.target[0], p.target[1], p.target[2]);
      updateCameraFromOrbit();
      syncZoomUI();
      return;
    }
    tween = {
      fromTheta: orbit.theta, fromPhi: orbit.phi, fromRadius: orbit.radius,
      fromTarget: target.clone(),
      toTheta: orbit.theta + wrapAngleDelta(p.theta - orbit.theta),
      toPhi: p.phi, toRadius: p.radius,
      toTarget: new THREE.Vector3(p.target[0], p.target[1], p.target[2]),
      start: performance.now(),
      duration: 900
    };
    lastInteraction = performance.now();
  }

  // ---------- UI panel wiring ----------
  // Pairs a <input type=range id="ctl-X"> with a <input type=number id="ctl-X-val">
  // so the value can be dragged, clicked-and-typed, or nudged with arrow keys.
  // `apply(value)` runs on every drag tick when live=true, always on release/typed-commit.
  function pairControl(id, apply, live) {
    var range = document.getElementById('ctl-' + id);
    var num = document.getElementById('ctl-' + id + '-val');
    if (!range || !num) return;

    range.addEventListener('input', function () {
      num.value = range.value;
      if (live) apply(parseFloat(range.value));
    });
    range.addEventListener('change', function () {
      num.value = range.value;
      apply(parseFloat(range.value));
    });

    function commitFromNumber() {
      var v = parseFloat(num.value);
      if (isNaN(v)) { num.value = range.value; return; }
      v = Math.min(parseFloat(range.max), Math.max(parseFloat(range.min), v));
      num.value = v;
      range.value = v;
      apply(v);
    }
    num.addEventListener('change', commitFromNumber);
    num.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commitFromNumber(); num.blur(); }
    });
  }

  function syncZoomUI() {
    var el = document.getElementById('ctl-zoom');
    var out = document.getElementById('ctl-zoom-val');
    if (el) el.value = orbit.radius.toFixed(2);
    if (out) out.value = orbit.radius.toFixed(2);
  }

  function syncSpanUI() {
    var el = document.getElementById('ctl-span');
    var out = document.getElementById('ctl-span-val');
    if (el) el.value = params.span.toFixed(2);
    if (out) out.value = params.span.toFixed(2);
  }

  function wireUI() {
    pairControl('density', function (v) { params.density = Math.round(v); buildField(); }, false);
    pairControl('cre', function (v) { params.centerRe = v; buildField(); buildFlatField(); }, false);
    pairControl('cim', function (v) { params.centerIm = v; buildField(); buildFlatField(); }, false);
    pairControl('span', function (v) { params.span = v; buildField(); buildFlatField(); }, false);
    pairControl('zoom', function (v) {
      tween = null;
      orbit.radius = v;
      params.span = spanForRadius(v);
      lastInteraction = performance.now();
      updateCameraFromOrbit();
      syncSpanUI();
      scheduleFieldRebuild();
    }, true);
    pairControl('bands', function (v) { material.uniforms.uBands.value = v; paintFlatCanvas(); }, true);
    pairControl('spin-speed', function (v) { spin.speed = v; }, true);

    var layerStrandsBtn = document.getElementById('layer-strands');
    var layerGroundBtn = document.getElementById('layer-ground');
    if (layerStrandsBtn) {
      layerStrandsBtn.addEventListener('click', function () {
        layers.strands = !layers.strands;
        if (mesh) mesh.visible = layers.strands;
        layerStrandsBtn.classList.toggle('is-active', layers.strands);
      });
    }
    if (layerGroundBtn) {
      layerGroundBtn.addEventListener('click', function () {
        layers.ground = !layers.ground;
        ground.visible = layers.ground;
        layerGroundBtn.classList.toggle('is-active', layers.ground);
      });
    }

    var spinToggle = document.getElementById('spin-toggle');
    if (spinToggle) {
      spinToggle.addEventListener('click', function () {
        spin.enabled = !spin.enabled;
        spinToggle.textContent = spin.enabled ? 'SPINNING' : 'STOPPED';
        spinToggle.classList.toggle('is-active', spin.enabled);
        if (spin.enabled) lastInteraction = -1e9; // resume idle-spin immediately
      });
    }

    var waveToggle = document.getElementById('wave-toggle');
    if (waveToggle) {
      waveToggle.addEventListener('click', function () {
        var waving = material.uniforms.uSwayAmp.value > 0;
        material.uniforms.uSwayAmp.value = waving ? 0 : waveAmp;
        waveToggle.textContent = waving ? 'STILL' : 'WAVING';
        waveToggle.classList.toggle('is-active', !waving);
      });
    }

    var captureBtn = document.getElementById('capture-btn');
    if (captureBtn) captureBtn.addEventListener('click', capturePNG);

    var tracePickBtn = document.getElementById('trace-pick');
    var traceIterSlider = document.getElementById('ctl-trace-iter');
    var tracePlayBtn = document.getElementById('trace-play');
    var traceMinusBtn = document.getElementById('trace-minus');
    var tracePlusBtn = document.getElementById('trace-plus');
    var traceClearBtn = document.getElementById('trace-clear');

    function stopTracePlaying() {
      if (traceState) traceState.playing = false;
      if (tracePlayBtn) { tracePlayBtn.textContent = 'PLAY'; tracePlayBtn.classList.remove('is-active'); }
    }

    if (tracePickBtn) {
      tracePickBtn.addEventListener('click', function () {
        traceMode = !traceMode;
        tracePickBtn.textContent = traceMode ? 'CLICK THE FIELD…' : 'PICK POINT';
        tracePickBtn.classList.toggle('is-active', traceMode);
        dom.style.cursor = traceMode ? 'crosshair' : 'grab';
      });
    }
    if (traceIterSlider) {
      traceIterSlider.addEventListener('input', function () {
        if (!traceState) return;
        stopTracePlaying();
        traceState.currentIter = parseInt(traceIterSlider.value, 10);
        var label = document.getElementById('trace-iter-label');
        if (label) label.textContent = traceIterSlider.value;
      });
    }
    function stepTrace(delta) {
      if (!traceState) return;
      stopTracePlaying();
      var limit = traceState.escapeIter >= 0 ? traceState.escapeIter : (traceState.orbit.length - 1);
      traceState.currentIter = Math.max(0, Math.min(limit, Math.round(traceState.currentIter) + delta));
      updateTraceIterUI();
    }
    if (traceMinusBtn) traceMinusBtn.addEventListener('click', function () { stepTrace(-1); });
    if (tracePlusBtn) tracePlusBtn.addEventListener('click', function () { stepTrace(1); });
    if (traceClearBtn) traceClearBtn.addEventListener('click', clearTrace);
    if (tracePlayBtn) {
      tracePlayBtn.addEventListener('click', function () {
        if (!traceState) return;
        var limit = traceState.escapeIter >= 0 ? traceState.escapeIter : (traceState.orbit.length - 1);
        if (traceState.currentIter >= limit) { traceState.currentIter = 0; traceState.displayIter = 0; }
        traceState.playing = !traceState.playing;
        tracePlayBtn.textContent = traceState.playing ? 'PAUSE' : 'PLAY';
        tracePlayBtn.classList.toggle('is-active', traceState.playing);
      });
    }

    var schemeButtons = document.querySelectorAll('[data-scheme]');
    schemeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setScheme(btn.getAttribute('data-scheme'));
        schemeButtons.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
      });
    });

    var presetButtons = {
      full: document.getElementById('preset-full'),
      edge: document.getElementById('preset-edge'),
      tip: document.getElementById('preset-tip')
    };
    function setActivePreset(name) {
      Object.keys(presetButtons).forEach(function (k) {
        if (presetButtons[k]) presetButtons[k].classList.toggle('is-active', k === name);
      });
    }
    Object.keys(presetButtons).forEach(function (name) {
      var btn = presetButtons[name];
      if (btn) btn.addEventListener('click', function () { goToPreset(name); setActivePreset(name); });
    });

    function wirePanelToggle(toggleId, panelId) {
      var toggle = document.getElementById(toggleId);
      var panelEl = document.getElementById(panelId);
      if (!toggle || !panelEl) return;
      toggle.addEventListener('click', function () {
        var collapsed = panelEl.classList.toggle('is-collapsed');
        toggle.textContent = collapsed ? 'SHOW' : 'HIDE';
        toggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }
    wirePanelToggle('panel-toggle', 'panel');
    wirePanelToggle('panel-toggle-left', 'panel-left');
  }
  wireUI();
  syncZoomUI();

  // ---------- Capture ----------
  function capturePNG() {
    renderer.render(scene, camera); // make sure the buffer holds the latest frame
    var link = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = 'escape-velocity-' + stamp + '.png';
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();
  }

  // ---------- Animate ----------
  var clock = new THREE.Clock();
  var fpsEl = document.getElementById('fps-readout');
  var fpsFrames = 0, fpsAccum = 0;

  function tick() {
    requestAnimationFrame(tick);
    var dt = clock.getDelta();
    var t = clock.elapsedTime;
    material.uniforms.uTime.value = t;

    fpsFrames++;
    fpsAccum += Math.min(dt, 0.1); // clamp so one slow/startup frame can't skew the reading
    if (fpsAccum >= 0.5) {
      if (fpsEl) fpsEl.textContent = Math.round(fpsFrames / fpsAccum) + ' fps';
      fpsFrames = 0;
      fpsAccum = 0;
    }

    if (tween) {
      var e = Math.min(1, (performance.now() - tween.start) / tween.duration);
      var k = easeInOutCubic(e);
      orbit.theta = tween.fromTheta + (tween.toTheta - tween.fromTheta) * k;
      orbit.phi = tween.fromPhi + (tween.toPhi - tween.fromPhi) * k;
      orbit.radius = tween.fromRadius + (tween.toRadius - tween.fromRadius) * k;
      target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      updateCameraFromOrbit();
      syncZoomUI();
      if (e >= 1) tween = null;
    } else if (!prefersReduced && spin.enabled) {
      var idle = !dragging && (performance.now() - lastInteraction) > 1200;
      if (idle) {
        orbit.theta += spin.speed * dt;
        updateCameraFromOrbit();
      }
    }

    if (traceState) {
      if (traceState.playing) {
        var traceLimit = traceState.escapeIter >= 0 ? traceState.escapeIter : (traceState.orbit.length - 1);
        traceState.currentIter = Math.min(traceLimit, traceState.currentIter + dt * TRACE_PLAY_RATE);
        if (traceState.currentIter >= traceLimit) {
          traceState.currentIter = traceLimit;
          traceState.playing = false;
          var playBtn = document.getElementById('trace-play');
          if (playBtn) { playBtn.textContent = 'PLAY'; playBtn.classList.remove('is-active'); }
        }
      }
      traceState.displayIter += (traceState.currentIter - traceState.displayIter) * Math.min(1, dt * 8);
      if (Math.abs(traceState.displayIter - traceState.lastBuilt) > 0.01) {
        rebuildTraceVisual();
        traceState.lastBuilt = traceState.displayIter;
      }
      var iterSlider = document.getElementById('ctl-trace-iter');
      var iterLabel = document.getElementById('trace-iter-label');
      if (iterSlider) iterSlider.value = String(Math.round(traceState.currentIter));
      if (iterLabel) iterLabel.textContent = String(Math.round(traceState.displayIter));
    }

    renderer.render(scene, camera);
  }
  tick();
})();
