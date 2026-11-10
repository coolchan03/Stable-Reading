/* FloatRead: experimental inertial text stabilization. No network or third-party dependencies. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var reader = $('readerSurface'), content = $('readerContent'), body = document.body, anchors = $('anchorDots');
  var state = {
    active: true, demo: false, live: false, listening: false, attempted: false,
    ax: 0, ay: 0, gx: 0, gy: 0, hasGravity: false, lastSensor: 0,
    lastRawTime: 0, lastFrame: 0, x: 0, y: 0, vx: 0, vy: 0, impX: 0, impY: 0, slowX: 0, slowY: 0, hx: 0, hy: 0, hvx: 0, hvy: 0,
    pulseX: 0, pulseY: 0, events: 0, eventWindow: 0, frequency: 0, uiTime: 0,
    source: 'idle', lastKnown: '', emptyEvents: 0, genericSensor: null, sensorError: ''
  };
  var settingKeys = { compensation: 100, sideBoost: 100, smoothness: 85, fontSize: 20 };
  var PX_PER_METER = 6000; // ~160 CSS px per inch, typical for phones
  var LEAD = .012;         // seconds of look-ahead to offset render latency
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
  function resetMotion() {
    state.x = state.y = state.vx = state.vy = state.impX = state.impY = state.slowX = state.slowY = state.hx = state.hy = state.hvx = state.hvy = 0;
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
  function orientAxes(x, y) {
    var angle = 0;
    if (window.screen && window.screen.orientation && typeof screen.orientation.angle === 'number') angle = screen.orientation.angle;
    else if (typeof window.orientation === 'number') angle = window.orientation;
    angle = ((angle % 360) + 360) % 360;
    if (angle === 90) return { x: y, y: -x };
    if (angle === 180) return { x: -x, y: -y };
    if (angle === 270) return { x: -y, y: x };
    return { x: x, y: y };
  }
  function numberOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function ingest(x, y, isLinear, screenAligned, source) {
    var now = performance.now();
    var dt = clamp((now - (state.lastRawTime || now)) / 1000, .008, .16);
    if (!isLinear) {
      if (!state.hasGravity) { state.gx = x; state.gy = y; state.hasGravity = true; }
      var alpha = 1 - Math.exp(-dt / .62);
      state.gx += (x - state.gx) * alpha;
      state.gy += (y - state.gy) * alpha;
      x -= state.gx; y -= state.gy;
    }
    var axes = screenAligned ? { x: x, y: y } : orientAxes(x, y);
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
  function processMotion(event) {
    var a = event.acceleration, x = a && numberOrNull(a.x), y = a && numberOrNull(a.y);
    if (x !== null && y !== null) return ingest(x, y, true, false, 'devicemotion');
    a = event.accelerationIncludingGravity;
    x = a && numberOrNull(a.x); y = a && numberOrNull(a.y);
    if (x === null || y === null) { state.emptyEvents += 1; return; }
    ingest(x, y, false, false, 'devicemotion + gravity filter');
  }
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
    $('frequencyReadout').textContent = state.frequency + ' events/sec';
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
    // Final high-pass on position and velocity removes the steady shift a sustained acceleration would leave.
    var hp = 1 - Math.exp(-dt / .1);
    state.hx += (state.x - state.hx) * hp; state.hy += (state.y - state.hy) * hp;
    state.hvx += (state.vx - state.hvx) * hp; state.hvy += (state.vy - state.hvy) * hp;
    var ox = state.x - state.hx, oy = state.y - state.hy;
    var ovx = state.vx - state.hvx, ovy = state.vy - state.hvy;
    var lead = LEAD + (state.live ? Math.min((now - state.lastSensor) / 1000, .02) : 0);
    var k = PX_PER_METER * Number($('compensation').value) / 100;
    var kx = k * Number($('sideBoost').value) / 100;
    var lim = 30;
    var px = state.active ? lim * Math.tanh(-(ox + ovx * lead) * kx / lim) : 0;
    var py = state.active ? lim * Math.tanh((oy + ovy * lead) * k / lim) : 0;
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
        $(key + 'Output').textContent = input.value + (key === 'fontSize' ? ' px' : '%');
        storageSet(key, input.value);
        if (key === 'fontSize') reader.style.setProperty('--reader-font-size', input.value + 'px');
      };
      input.addEventListener('input', render); render();
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
      if (document.hidden) { state.lastFrame = 0; state.vx = state.vy = state.impX = state.impY = state.hx = state.hy = state.hvx = state.hvy = 0; }
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
