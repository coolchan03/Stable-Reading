/* FloatRead: experimental inertial text stabilization. No network or third-party dependencies. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var reader = $('readerSurface'), content = $('readerContent'), body = document.body;
  var state = {
    active: true, demo: false, live: false, listening: false, attempted: false,
    ax: 0, ay: 0, gx: 0, gy: 0, hasGravity: false, lastSensor: 0,
    lastRawTime: 0, lastFrame: 0, x: 0, y: 0, vx: 0, vy: 0,
    pulseX: 0, pulseY: 0, events: 0, eventWindow: 0, frequency: 0, uiTime: 0,
    source: 'idle', lastKnown: ''
  };
  var settingKeys = { compensation: 70, smoothness: 85, fontSize: 18 };
  var storagePrefix = 'floatread-v2-';
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
    state.x = state.y = state.vx = state.vy = 0;
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
  function processMotion(event) {
    var now = performance.now();
    var a = event.acceleration, x = a && numberOrNull(a.x), y = a && numberOrNull(a.y);
    var hasLinear = x !== null && y !== null;
    var dt = clamp((now - (state.lastRawTime || now)) / 1000, .008, .16);
    if (!hasLinear) {
      a = event.accelerationIncludingGravity;
      x = a && numberOrNull(a.x); y = a && numberOrNull(a.y);
      if (x === null || y === null) return;
      if (!state.hasGravity) { state.gx = x; state.gy = y; state.hasGravity = true; }
      var alpha = 1 - Math.exp(-dt / .62);
      state.gx += (x - state.gx) * alpha;
      state.gy += (y - state.gy) * alpha;
      x -= state.gx; y -= state.gy;
    }
    var axes = orientAxes(x, y);
    state.ax = clamp(axes.x, -16, 16);
    state.ay = clamp(axes.y, -16, 16);
    state.lastRawTime = state.lastSensor = now;
    state.events += 1;
    if (!state.live) {
      state.live = true;
      $('enableSensors').textContent = 'Sensors connected';
      setMessage('Receiving live motion readings. Gently move the phone and watch the axes change.');
      updateSourceDisplay();
    }
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
      window.setTimeout(function () {
        if (!state.live) {
          $('enableSensors').textContent = 'Retry sensors';
          if (!state.demo) updateSourceDisplay();
          setMessage('No motion data arrived. Open this URL directly in Chrome (not inside ChatGPT). In Chrome, check Settings → Site settings → Motion sensors, then retry. Some devices or browsers restrict this API.');
        }
      }, 4000);
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
    $('motionType').textContent = state.demo ? 'Simulation' : state.live ? 'Live · sensor motion' : 'No live readings';
  }
  function animate(now) {
    if (!state.lastFrame) state.lastFrame = now;
    var dt = clamp((now - state.lastFrame) / 1000, 0, .033);
    state.lastFrame = now;
    var ax = 0, ay = 0;
    if (state.demo) {
      var t = now / 1000;
      ax = .6 * Math.sin(t * 4.2) + 2.8 * Math.sin(t * 12.1) * Math.pow(Math.sin(t * .7), 4);
      ay = 1.1 * Math.sin(t * 7.8) + 4.3 * Math.sin(t * 15.2) * Math.pow(Math.sin(t * .46), 6);
    } else if (state.live && now - state.lastSensor < 350) {
      ax = state.ax; ay = state.ay;
    }
    ax += state.pulseX; ay += state.pulseY;
    var decay = Math.exp(-dt * 6.2);
    state.pulseX *= decay; state.pulseY *= decay;
    if (Math.abs(ax) < .045) ax = 0;
    if (Math.abs(ay) < .045) ay = 0;
    // A damped, bounded mass on a spring. Never double-integrate unbounded position.
    var gain = 880 * Number($('compensation').value) / 100;
    var omega = 10.8;
    var zeta = Number($('smoothness').value) / 100;
    state.vx += (-gain * ax - 2 * zeta * omega * state.vx - omega * omega * state.x) * dt;
    state.vy += (gain * ay - 2 * zeta * omega * state.vy - omega * omega * state.y) * dt;
    state.x += state.vx * dt; state.y += state.vy * dt;
    var max = 29;
    if (state.x > max || state.x < -max) { state.x = clamp(state.x, -max, max); state.vx = 0; }
    if (state.y > max || state.y < -max) { state.y = clamp(state.y, -max, max); state.vy = 0; }
    var px = state.active ? state.x : 0;
    var py = state.active ? state.y : 0;
    reader.style.transform = 'translate3d(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px,0)';
    if (!state.eventWindow) state.eventWindow = now;
    if (now - state.eventWindow >= 1000) {
      state.frequency = Math.round(state.events * 1000 / (now - state.eventWindow));
      state.events = 0; state.eventWindow = now;
    }
    updateMetrics(now, ax, ay, px, py);
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
      var previous = Number(storageGet(key));
      if (previous >= Number(input.min) && previous <= Number(input.max)) input.value = previous;
      var render = function () {
        $(key + 'Output').textContent = input.value + (key === 'fontSize' ? ' px' : '%');
        storageSet(key, input.value);
        if (key === 'fontSize') reader.style.setProperty('--reader-font-size', input.value + 'px');
      };
      input.addEventListener('input', render); render();
    });
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
      if (document.hidden) { state.lastFrame = 0; state.vx = state.vy = 0; }
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
