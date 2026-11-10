/* FloatRead: experimental inertial text stabilization. No network or third-party dependencies. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var reader = $('readerSurface'), content = $('readerContent'), body = document.body, anchors = $('anchorDots');
  var state = {
    active: true, demo: false, live: false, listening: false, attempted: false,
    ax: 0, ay: 0, gx: 0, gy: 0, hasGravity: false, lastSensor: 0,
    lastRawTime: 0, lastFrame: 0, x: 0, y: 0, vx: 0, vy: 0, impX: 0, impY: 0, slowX: 0, slowY: 0, hx: 0, hy: 0, lp1x: 0, lp1y: 0, lp2x: 0, lp2y: 0, accT: 0, predX: null, predY: null,
    recording: false, trace: [], replaying: false, replayData: null, replayIdx: 0, replayT0: 0, replayAngle: null,
    pulseX: 0, pulseY: 0, events: 0, eventWindow: 0, frequency: 0, uiTime: 0,
    source: 'idle', lastKnown: '', emptyEvents: 0, genericSensor: null, sensorError: ''
  };
  var settingKeys = { compensation: 100, sideBoost: 100, smoothness: 85, cutoff: 8, predict: 0, deadband: 1.5, fontSize: 20 };
  var suffixes = { fontSize: ' px', cutoff: ' Hz', deadband: ' px' };
  var PRESETS = {
    smooth: { compensation: 80, sideBoost: 100, smoothness: 85, cutoff: 6, predict: 0, deadband: 2 },
    rough:  { compensation: 110, sideBoost: 130, smoothness: 70, cutoff: 9, predict: 0, deadband: 1 },
    sway:   { compensation: 70, sideBoost: 100, smoothness: 100, cutoff: 4, predict: 0, deadband: 2.5 }
  };

  var STEP = 1 / 60;       // fixed rate the predictor runs at
  var HORIZON = 2;         // steps (~33 ms) the predictor looks ahead: sensor + render latency
  var RLS_FORGET = .995;
  var ORDER = 8;           // predictor taps
  var PX_PER_METER = 6000; // ~160 CSS px per inch, typical for phones
  var storagePrefix = 'floatread-v3-';
  function storageGet(key) {
    try { return localStorage.getItem(storagePrefix + key); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(storagePrefix + key, String(value)); } catch (_) {}
  }
  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
  function setMessage(message) { $('sensorMessage').textContent = message; }
  function setBadge(kind, text) {
    $('sensorBadge').dataset.state = kind;
    $('sensorBadgeText').textContent = text;
    $('readerState').textContent = kind === 'live' ? 'Live motion detected' : kind === 'demo' ? 'Simulated movement' : text;
  }
  function updateSourceDisplay() {
    if (state.demo) setBadge('demo', 'Simulation on');
    else if (state.live) setBadge('live', 'Sensors active');
    else if (state.attempted) setBadge('error', 'No sensor data');
    else setBadge('idle', 'Not connected');
  }
  function Predictor() {
    this.w = new Float64Array(ORDER); this.P = new Float64Array(ORDER * ORDER);
    this.u = new Float64Array(ORDER); this.pu = new Float64Array(ORDER); this.buf = []; this.reset();
  }
  Predictor.prototype.reset = function () {
    this.w.fill(0); this.w[0] = 1; this.buf.length = 0; this.P.fill(0);
    for (var i = 0; i < ORDER; i++) this.P[i * ORDER + i] = 100;
  };
  // Recursive-least-squares linear predictor: learns online how recent history predicts HORIZON steps
  // ahead. Vibration is quasi-periodic, so this recovers some of the sensor + render delay.
  Predictor.prototype.step = function (sample) {
    var b = this.buf, w = this.w, P = this.P, u = this.u, pu = this.pu, n = ORDER, i, j;
    b.unshift(sample); if (b.length > n + HORIZON) b.pop();
    if (b.length < n + HORIZON) return sample;
    var est = 0;
    for (i = 0; i < n; i++) { u[i] = b[HORIZON + i]; est += w[i] * u[i]; }
    var e = b[0] - est, den = RLS_FORGET;
    for (i = 0; i < n; i++) { var acc = 0; for (j = 0; j < n; j++) acc += P[i * n + j] * u[j]; pu[i] = acc; den += u[i] * acc; }
    for (i = 0; i < n; i++) w[i] += pu[i] / den * e;
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) P[i * n + j] = (P[i * n + j] - pu[i] * pu[j] / den) / RLS_FORGET;
    var out = 0;
    for (i = 0; i < n; i++) out += w[i] * b[i];
    if (!Number.isFinite(out) || Math.abs(out) > 400) { this.reset(); return sample; }
    return out;
  };
  function resetMotion() {
    state.x = state.y = state.vx = state.vy = state.impX = state.impY = state.slowX = state.slowY = state.hx = state.hy = state.lp1x = state.lp1y = state.lp2x = state.lp2y = 0;
    if (state.predX) { state.predX.reset(); state.predY.reset(); }
    state.pulseX = state.pulseY = 0;
    state.gx = state.gy = 0;
    state.hasGravity = false;
    state.lastRawTime = 0;
    state.ax = state.ay = 0;
    reader.style.transform = 'translate3d(0,0,0)';
  }
  function setDemo(enabled) {
    state.demo = enabled;
    $('demoButton').setAttribute('aria-pressed', String(enabled));
    $('demoButton').textContent = enabled ? 'Stop simulation' : 'Simulate a road';
    if (enabled) setMessage('Road bumps are being simulated. Toggle stabilization off, then on, to compare the effect.');
    else if (!state.live) setMessage('Simulation stopped. Tap Enable phone sensors to read real movement.');
    updateSourceDisplay();
  }
  function orientAxes(x, y, forced) {
    var angle = 0;
    if (typeof forced === 'number') angle = forced;
    else if (window.screen && window.screen.orientation && typeof screen.orientation.angle === 'number') angle = screen.orientation.angle;
    else if (typeof window.orientation === 'number') angle = window.orientation;
    angle = ((angle % 360) + 360) % 360;
    if (angle === 90) return { x: y, y: -x };
    if (angle === 180) return { x: -x, y: -y };
    if (angle === 270) return { x: -y, y: x };
    return { x: x, y: y };
  }
  function numberOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function ingest(x, y, isLinear, screenAligned, source, opts) {
    opts = opts || {};
    if (state.replaying && !opts.replay) return;
    var now = opts.ts || performance.now();
    var dt = clamp((now - (state.lastRawTime || now)) / 1000, .008, .16);
    if (!isLinear) {
      if (!state.hasGravity) { state.gx = x; state.gy = y; state.hasGravity = true; }
      var alpha = 1 - Math.exp(-dt / .62);
      state.gx += (x - state.gx) * alpha;
      state.gy += (y - state.gy) * alpha;
      x -= state.gx; y -= state.gy;
    }
    var axes = screenAligned ? { x: x, y: y } : orientAxes(x, y, opts.angle);
    state.ax = clamp(axes.x, -16, 16);
    state.ay = clamp(axes.y, -16, 16);
    // Exact integration regardless of how events line up with animation frames.
    var gap = (now - (state.lastRawTime || now)) / 1000;
    var idt = gap > .1 ? 0 : clamp(gap || .016, .004, .05);
    state.impX += (Math.abs(state.ax) < .03 ? 0 : state.ax) * idt;
    state.impY += (Math.abs(state.ay) < .03 ? 0 : state.ay) * idt;
    state.lastRawTime = state.lastSensor = now;
    state.events += 1;
    if (!state.live) {
      state.live = true;
      state.source = source;
      $('enableSensors').textContent = 'Sensors connected';
      setMessage('Receiving live motion readings (' + source + '). Gently move the phone and watch the axes change.');
      updateSourceDisplay();
    }
  }
  function currentAngle() {
    if (window.screen && window.screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }
  function record(event) {
    if (!state.recording || state.replaying || state.trace.length >= 72000) return;
    var l = event.acceleration || {}, g = event.accelerationIncludingGravity || {}, r = event.rotationRate || {};
    state.trace.push([Math.round(performance.now() * 10) / 10, numberOrNull(l.x), numberOrNull(l.y), numberOrNull(l.z),
      numberOrNull(g.x), numberOrNull(g.y), numberOrNull(g.z), numberOrNull(r.alpha), numberOrNull(r.beta), numberOrNull(r.gamma),
      currentAngle(), numberOrNull(event.interval)]);
  }
  // Shared by live events and trace replay. `opts` carries the recorded timestamp/angle during replay.
  function handleMotion(event, opts) {
    var a = event.acceleration, x = a && numberOrNull(a.x), y = a && numberOrNull(a.y);
    if (x !== null && y !== null) return ingest(x, y, true, false, opts && opts.replay ? 'trace replay' : 'devicemotion', opts);
    a = event.accelerationIncludingGravity;
    x = a && numberOrNull(a.x); y = a && numberOrNull(a.y);
    if (x === null || y === null) { state.emptyEvents += 1; return; }
    ingest(x, y, false, false, opts && opts.replay ? 'trace replay' : 'devicemotion + gravity filter', opts);
  }
  function processMotion(event) { record(event); handleMotion(event); }
  // Fallback for Chrome/Android builds where devicemotion arrives empty: the Generic Sensor API.
  function startGenericSensor() {
    var name = 'LinearAccelerationSensor' in window ? 'LinearAccelerationSensor' : ('Accelerometer' in window ? 'Accelerometer' : null);
    if (!name || state.live || state.genericSensor) return;
    try {
      var linear = name === 'LinearAccelerationSensor';
      var sensor = new window[name]({ frequency: 60, referenceFrame: 'screen' });
      sensor.addEventListener('reading', function () {
        if (sensor.x == null || sensor.y == null) return;
        ingest(sensor.x, sensor.y, linear, true, linear ? 'Generic Sensor (linear)' : 'Generic Sensor + gravity filter');
      });
      sensor.addEventListener('error', function (e) {
        state.sensorError = (e.error && e.error.name) || 'error';
      });
      sensor.start();
      state.genericSensor = sensor;
    } catch (err) {
      state.sensorError = err && err.name || 'error';
    }
  }
  function noDataMessage() {
    var reason = state.sensorError === 'NotAllowedError' || state.sensorError === 'SecurityError'
      ? 'The browser blocked motion sensors for this site. '
      : state.emptyEvents ? 'The browser sent motion events with no values (sensors blocked or missing). '
      : 'No motion events arrived. ';
    return reason + 'On Android, open the page directly in Chrome (not an in-app browser), check Chrome → Settings → Site settings → Motion sensors, make sure Android\'s "Motion sensors" / battery saver is not blocking it, reload, then tap Retry. On a computer without sensors this is expected - use the simulation.';
  }
  function trySensors() {
    if (state.live) {
      setDemo(false);
      setMessage('Sensors are active. Move your device gently to see the live readings.');
      return;
    }
    if (!window.isSecureContext) {
      state.attempted = true;
      setBadge('error', 'HTTPS required');
      setMessage('Motion sensors require a secure HTTPS page. Open the GitHub Pages address directly in Chrome.');
      return;
    }
    if (!('DeviceMotionEvent' in window)) {
      state.attempted = true;
      setBadge('error', 'API unavailable');
      setMessage('This browser does not expose DeviceMotionEvent. Open the HTTPS site in Chrome on your Android phone.');
      return;
    }
    state.attempted = true;
    $('enableSensors').textContent = 'Listening for motion…';
    setBadge('idle', 'Requesting…');
    setMessage('Waiting for the browser to send motion events. Move your device gently.');
    var begin = function () {
      if (!state.listening) {
        window.addEventListener('devicemotion', processMotion, { passive: true });
        state.listening = true;
      }
      window.setTimeout(function () { if (!state.live) startGenericSensor(); }, 1500);
      window.setTimeout(function () {
        if (!state.live) {
          $('enableSensors').textContent = 'Retry sensors';
          if (!state.demo) updateSourceDisplay();
          setMessage(noDataMessage());
        }
      }, 4500);
    };
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        Promise.resolve(DeviceMotionEvent.requestPermission()).then(function (permission) {
          if (permission !== 'granted') throw new Error('The motion permission was denied.');
          begin();
        }).catch(function (error) {
          $('enableSensors').textContent = 'Retry sensors';
          setBadge('error', 'Permission denied');
          setMessage(error.message + ' Check browser settings, then retry.');
        });
      } else begin();
    } catch (error) {
      $('enableSensors').textContent = 'Retry sensors';
      setBadge('error', 'Unavailable');
      setMessage('Unable to subscribe to the sensors: ' + error.message);
    }
  }
  function updateGauge(id, value) {
    var el = $(id), p = clamp(value / 12 * 50, -50, 50);
    el.style.left = (p < 0 ? 50 + p : 50) + '%';
    el.style.width = Math.abs(p) + '%';
  }
  function updateMetrics(now, ax, ay, px, py) {
    if (now - state.uiTime < 110) return;
    state.uiTime = now;
    $('axReadout').textContent = ax.toFixed(2);
    $('ayReadout').textContent = ay.toFixed(2);
    updateGauge('xBar', ax); updateGauge('yBar', ay);
    $('shiftReadout').textContent = Math.hypot(px, py).toFixed(1) + ' px offset';
    $('frequencyReadout').textContent = state.frequency + ' events/sec' + (state.recording ? ' · rec ' + state.trace.length : '');
    $('motionType').textContent = state.demo ? 'Simulation' : state.live ? 'Live · ' + state.source : 'No live readings';
  }
  function animate(now) {
    if (!state.lastFrame) state.lastFrame = now;
    var dt = clamp((now - state.lastFrame) / 1000, 0, .05);
    state.lastFrame = now;
    // Acceleration impulses collected from sensor events since the last frame (m/s).
    var dvx = state.impX, dvy = state.impY;
    state.impX = state.impY = 0;
    if (state.demo) {
      var t = now / 1000;
      dvx += (.6 * Math.sin(t * 4.2) + 2.8 * Math.sin(t * 12.1) * Math.pow(Math.sin(t * .7), 4)) * dt;
      dvy += (1.1 * Math.sin(t * 7.8) + 4.3 * Math.sin(t * 15.2) * Math.pow(Math.sin(t * .46), 6)) * dt;
    }
    dvx += state.pulseX * dt; dvy += state.pulseY * dt;
    var decay = Math.exp(-dt * 6.2);
    state.pulseX *= decay; state.pulseY *= decay;
    var ax = dt > 0 ? dvx / dt : 0, ay = dt > 0 ? dvy / dt : 0;
    // Leaky double integration = 2nd-order high-pass: quick bumps become a real displacement,
    // slow sustained accelerations (braking, cornering) leak away and never push the page off-screen.
    var tau = Number($('smoothness').value) / 100 * .1;
    var leak = Math.exp(-dt / tau);
    state.vx = (state.vx + dvx) * leak;
    state.vy = (state.vy + dvy) * leak;
    state.x = (state.x + state.vx * dt) * leak;
    state.y = (state.y + state.vy * dt) * leak;
    // High-pass on position removes the steady shift a sustained acceleration would leave.
    var hp = 1 - Math.exp(-dt / .1);
    state.hx += (state.x - state.hx) * hp; state.hy += (state.y - state.hy) * hp;
    var k = PX_PER_METER * Number($('compensation').value) / 100;
    var kx = k * Number($('sideBoost').value) / 100;
    // Displacement of the page in px (text must move opposite to the device: x flips, y does not).
    var rawX = -(state.x - state.hx) * kx, rawY = (state.y - state.hy) * k;
    // 1) Band-limit. Above ~5-8 Hz sensor latency is a large part of a cycle, so correcting there adds jitter.
    var tc = .64 / (2 * Math.PI * Number($('cutoff').value));
    var lp = dt > 0 ? 1 - Math.exp(-dt / tc) : 0;
    state.lp1x += (rawX - state.lp1x) * lp; state.lp2x += (state.lp1x - state.lp2x) * lp;
    state.lp1y += (rawY - state.lp1y) * lp; state.lp2y += (state.lp1y - state.lp2y) * lp;
    var sx = state.lp2x, sy = state.lp2y;
    // 2) Predict a few tens of ms ahead to cancel the remaining sensor + render latency.
    if (!state.predX) { state.predX = new Predictor(); state.predY = new Predictor(); }
    state.accT += dt;
    var guard = 0;
    while (state.accT >= STEP && guard++ < 4) {
      state.accT -= STEP;
      state.pxl = state.predX.step(sx); state.pyl = state.predY.step(sy);
    }
    if (state.accT > STEP) state.accT = 0;
    var blend = Number($('predict').value) / 100;
    var cap = 14;
    if (state.pxl !== undefined) {
      sx += blend * clamp(state.pxl - sx, -cap, cap);
      sy += blend * clamp(state.pyl - sy, -cap, cap);
    }
    // 3) Soft dead-band: tiny jitter is left alone, real bumps get the full correction.
    var d = Number($('deadband').value) || 0;
    if (d > 0) {
      sx *= (sx * sx) / (sx * sx + d * d);
      sy *= (sy * sy) / (sy * sy + d * d);
    }
    var lim = 30;
    var px = state.active ? lim * Math.tanh(sx / lim) : 0;
    var py = state.active ? lim * Math.tanh(sy / lim) : 0;
    reader.style.transform = 'translate3d(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px,0)';
    // Edge anchors move with the slow part of the vehicle's acceleration (cornering, braking).
    var sa = 1 - Math.exp(-dt / .45);
    state.slowX += (ax - state.slowX) * sa;
    state.slowY += (ay - state.slowY) * sa;
    if (anchors) {
      var adx = clamp(-state.slowX * 4, -14, 14), ady = clamp(state.slowY * 4, -14, 14);
      anchors.style.transform = 'translate3d(' + adx.toFixed(1) + 'px,' + ady.toFixed(1) + 'px,0)';
    }
    if (!state.eventWindow) state.eventWindow = now;
    if (now - state.eventWindow >= 1000) {
      state.frequency = Math.round(state.events * 1000 / (now - state.eventWindow));
      state.events = 0; state.eventWindow = now;
    }
    updateMetrics(now, state.live ? state.ax : ax, state.live ? state.ay : ay, px, py);
    requestAnimationFrame(animate);
  }
  function setText(text) {
    var clean = text.replace(/\r/g, '').trim();
    if (!clean) { setMessage('Paste some text first, or import a .txt/.md file.'); return false; }
    if (clean.length > 250000) { setMessage('For now, text is limited to 250,000 characters.'); return false; }
    var paragraphs = clean.split(/\n\s*\n/);
    var fragment = document.createDocumentFragment();
    paragraphs.forEach(function (paragraph) {
      var p = document.createElement('p');
      p.textContent = paragraph.replace(/\n/g, ' ');
      fragment.appendChild(p);
    });
    content.replaceChildren(fragment);
    $('storyTitle').textContent = 'Your reading space';
    $('chapterLabel').textContent = 'YOUR OWN WORDS';
    $('readerWindow').scrollTop = 0;
    storageSet('text', clean);
    setMessage('Your text is ready. You can use live sensors or simulation to test it.');
    return true;
  }
  function bindSettings() {
    Object.keys(settingKeys).forEach(function (key) {
      var input = $(key);
      var saved = storageGet(key), previous = saved === null ? NaN : Number(saved);
      if (previous >= Number(input.min) && previous <= Number(input.max)) input.value = previous;
      var render = function () {
        $(key + 'Output').textContent = input.value + (suffixes[key] || '%');
        storageSet(key, input.value);
        if (key === 'fontSize') reader.style.setProperty('--reader-font-size', input.value + 'px');
      };
      input.addEventListener('input', function () { render(); if (PRESETS[$('preset').value] && key !== 'fontSize') { $('preset').value = 'custom'; storageSet('preset', 'custom'); } });
      render();
    });
    var presetSel = $('preset');
    var savedPreset = storageGet('preset');
    if (savedPreset && (PRESETS[savedPreset] || savedPreset === 'custom')) presetSel.value = savedPreset;
    presetSel.addEventListener('change', function () {
      var p = PRESETS[presetSel.value]; storageSet('preset', presetSel.value);
      if (!p) return;
      Object.keys(p).forEach(function (key) { var el = $(key); el.value = p[key]; $(key + 'Output').textContent = el.value + (suffixes[key] || '%'); storageSet(key, el.value); });
      resetMotion();
      setMessage('Preset applied. Fine-tune the sliders if needed.');
    });
    var fontSel = $('fontFamily'), fonts = fontSel.options;
    var savedFont = storageGet('font');
    for (var i = 0; i < fonts.length; i++) if (fonts[i].value === savedFont) fontSel.value = savedFont;
    var applyFont = function () { reader.style.setProperty('--reader-font', fontSel.value); storageSet('font', fontSel.value); };
    fontSel.addEventListener('change', applyFont); applyFont();
    var bold = $('boldText'); bold.checked = storageGet('bold') !== 'false';
    var applyBold = function () { reader.style.setProperty('--reader-weight', bold.checked ? '500' : '400'); storageSet('bold', bold.checked); };
    bold.addEventListener('change', applyBold); applyBold();
    var anchorSwitch = $('anchorSwitch'); anchorSwitch.checked = storageGet('anchors') !== 'false';
    var applyAnchors = function () { $('anchorLayer').hidden = !anchorSwitch.checked; storageSet('anchors', anchorSwitch.checked); };
    anchorSwitch.addEventListener('change', applyAnchors); applyAnchors();
    state.active = storageGet('enabled') !== 'false';
    $('stabilizationSwitch').checked = state.active;
    $('stabilizationSwitch').addEventListener('change', function (event) {
      state.active = event.target.checked;
      storageSet('enabled', state.active);
    });
  }
  function downloadTrace() {
    if (!state.trace.length) { setMessage('Nothing recorded yet. Tap Record, ride a while, then download.'); return; }
    var data = { app: 'FloatRead', version: 1, created: new Date().toISOString(), columns: ['t_ms', 'lin_x', 'lin_y', 'lin_z', 'grav_x', 'grav_y', 'grav_z', 'rot_alpha', 'rot_beta', 'rot_gamma', 'screen_angle', 'interval'], samples: state.trace };
    var url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    var a = document.createElement('a'); a.href = url;
    a.download = 'floatread-trace-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    setMessage('Saved ' + state.trace.length + ' samples. Nothing was uploaded.');
  }
  function stopReplay(message) {
    state.replaying = false; state.replayData = null; state.live = false;
    $('replayButton').textContent = 'Load trace to replay';
    setBadge('idle', 'Replay finished');
    if (message) setMessage(message);
  }
  function replayStep(now) {
    if (!state.replaying) return;
    var d = state.replayData, elapsed = now - state.replayT0;
    while (state.replayIdx < d.length && d[state.replayIdx][0] - d[0][0] <= elapsed) {
      var r = d[state.replayIdx++];
      var ev = { acceleration: { x: r[1], y: r[2], z: r[3] }, accelerationIncludingGravity: { x: r[4], y: r[5], z: r[6] } };
      handleMotion(ev, { replay: true, ts: state.replayT0 + (r[0] - d[0][0]), angle: r[10] || 0 });
    }
    if (state.replayIdx >= d.length) stopReplay('Replay finished.'); else requestAnimationFrame(replayStep);
  }
  function startReplay(trace) {
    var samples = trace && Array.isArray(trace.samples) ? trace.samples : null;
    if (!samples || samples.length < 10 || samples.length > 200000 || !Array.isArray(samples[0])) { setMessage('That does not look like a FloatRead trace file.'); return; }
    resetMotion();
    state.replayData = samples; state.replayIdx = 0; state.replayT0 = performance.now(); state.replaying = true;
    setDemo(false);
    $('replayButton').textContent = 'Stop replay';
    setMessage('Replaying a recorded ride (' + Math.round((samples[samples.length - 1][0] - samples[0][0]) / 1000) + ' s). Adjust the sliders to see how each setting reacts.');
    requestAnimationFrame(replayStep);
  }
  function bindActions() {
    $('enableSensors').addEventListener('click', trySensors);
    $('demoButton').addEventListener('click', function () { setDemo(!state.demo); });
    $('bumpButton').addEventListener('click', function () {
      state.pulseX += (Math.random() - .5) * 8;
      state.pulseY += (Math.random() > .5 ? 1 : -1) * 9;
      setMessage('A test bump was added. Adjust compensation and damping to change the reaction.');
    });
    $('calibrateButton').addEventListener('click', function () {
      resetMotion();
      setMessage('Spring motion and gravity baseline reset. Hold the phone comfortably, then try a gentle shake.');
    });
    $('focusButton').addEventListener('click', function () {
      var open = body.classList.toggle('focus-reading');
      $('focusButton').setAttribute('aria-pressed', String(open));
      $('focusButton').textContent = open ? '✕ Exit focus' : '⤢ Focus view';
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && body.classList.contains('focus-reading')) $('focusButton').click();
    });
    $('recordButton').addEventListener('click', function () {
      state.recording = !state.recording;
      if (state.recording) state.trace = [];
      $('recordButton').textContent = state.recording ? '■ Stop recording' : '● Record ride';
      $('recordButton').setAttribute('aria-pressed', String(state.recording));
      setMessage(state.recording ? 'Recording raw sensor data on this device. Enable sensors first if the badge is not active.' : 'Recording stopped (' + state.trace.length + ' samples). Download it to keep it.');
    });
    $('downloadTrace').addEventListener('click', downloadTrace);
    $('replayButton').addEventListener('click', function () {
      if (state.replaying) { stopReplay('Replay stopped.'); return; }
      $('traceInput').click();
    });
    $('traceInput').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      file.text().then(function (txt) { startReplay(JSON.parse(txt)); }).catch(function () { setMessage('Could not read that trace file.'); });
      event.target.value = '';
    });
    $('applyText').addEventListener('click', function () { setText($('customText').value); });
    $('fileInput').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 900000) { setMessage('This file is too large for the prototype (limit: 900 KB).'); return; }
      file.text().then(function (txt) {
        $('customText').value = txt;
        setText(txt);
        event.target.value = '';
      }).catch(function () { setMessage('Could not read this file. Try a UTF-8 .txt file.'); });
    });
    window.addEventListener('pagehide', function () { state.lastFrame = 0; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { state.lastFrame = 0; state.vx = state.vy = state.impX = state.impY = state.hx = state.hy = state.lp1x = state.lp1y = state.lp2x = state.lp2y = 0;
    if (state.predX) { state.predX.reset(); state.predY.reset(); } }
    });
  }
  function initialize() {
    bindSettings(); bindActions();
    var custom = storageGet('text');
    if (custom) { $('customText').value = custom; setText(custom); }
    if (!window.isSecureContext) setMessage('A secure HTTPS origin is required for motion sensors. Open the GitHub Pages URL in Chrome.');
    updateSourceDisplay();
    requestAnimationFrame(animate);
    if ('serviceWorker' in navigator && window.isSecureContext)
      window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
  }
  initialize();
})();
