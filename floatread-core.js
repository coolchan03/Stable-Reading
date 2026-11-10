/*!
 * FloatRead core: motion-stabilized content for moving vehicles.
 * Dependency-free, UI-free. Drop into any web app (UMD: <script>, CommonJS or AMD).
 *
 *   const fr = FloatRead.create({ element: document.querySelector('#reader') });
 *   button.onclick = () => fr.start();      // must be called from a user gesture on iOS
 *
 * See INTEGRATION.md for the full API.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define(factory);
  else root.FloatRead = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULTS = { compensation: 100, sideBoost: 100, smoothness: 85, cutoff: 8, predict: 0, deadband: 1.5, head: 100 };
  var PRESETS = {
    smooth: { compensation: 80, sideBoost: 100, smoothness: 85, cutoff: 6, predict: 0, deadband: 2, head: 100 },
    rough:  { compensation: 110, sideBoost: 130, smoothness: 70, cutoff: 9, predict: 0, deadband: 1, head: 100 },
    sway:   { compensation: 70, sideBoost: 100, smoothness: 100, cutoff: 4, predict: 0, deadband: 2.5, head: 100 }
  };
  var STEP = 1 / 60;        // fixed rate the predictor runs at
  var HORIZON = 2;          // predictor look-ahead in steps (~33 ms)
  var ORDER = 8;            // predictor taps
  var RLS_FORGET = .995;
  var TRACE_COLUMNS = ['t_ms', 'lin_x', 'lin_y', 'lin_z', 'grav_x', 'grav_y', 'grav_z', 'rot_alpha', 'rot_beta', 'rot_gamma', 'screen_angle', 'interval'];

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
  function raf(fn) { return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(function () { fn(now()); }, 16); }

  // ---- Short-horizon linear predictor (recursive least squares). Experimental, off by default. ----
  function Predictor() {
    this.w = new Float64Array(ORDER); this.P = new Float64Array(ORDER * ORDER);
    this.u = new Float64Array(ORDER); this.pu = new Float64Array(ORDER); this.buf = []; this.reset();
  }
  Predictor.prototype.reset = function () {
    this.w.fill(0); this.w[0] = 1; this.buf.length = 0; this.P.fill(0);
    for (var i = 0; i < ORDER; i++) this.P[i * ORDER + i] = 100;
  };
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
    if (!isFinite(out) || Math.abs(out) > 400) { this.reset(); return sample; }
    return out;
  };

  function orientAxes(x, y, forced) {
    var angle = 0;
    if (typeof forced === 'number') angle = forced;
    else if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') angle = screen.orientation.angle;
    else if (typeof window !== 'undefined' && typeof window.orientation === 'number') angle = window.orientation;
    angle = ((angle % 360) + 360) % 360;
    if (angle === 90) return { x: y, y: -x };
    if (angle === 180) return { x: -x, y: -y };
    if (angle === 270) return { x: -y, y: x };
    return { x: x, y: y };
  }
  function currentAngle() {
    if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window !== 'undefined' && typeof window.orientation === 'number' ? window.orientation : 0;
  }

  function create(options) {
    options = options || {};
    var s = {}, k;
    for (k in DEFAULTS) s[k] = DEFAULTS[k];
    if (options.preset && PRESETS[options.preset]) for (k in PRESETS[options.preset]) s[k] = PRESETS[options.preset][k];
    if (options.settings) for (k in options.settings) if (k in DEFAULTS) s[k] = Number(options.settings[k]);

    var pxPerMeter = options.pxPerMeter || 6000; // ~160 CSS px per inch, typical for phones
    var maxShift = options.maxShift || 36;       // soft limit of the applied shift, px
    var element = options.element || null, anchorElement = options.anchorElement || null;
    var listeners = {};
    var st = {
      enabled: true, demo: false, live: false, listening: false, attempted: false, destroyed: false,
      ax: 0, ay: 0, gx: 0, gy: 0, hasGravity: false, lastSensor: 0, lastRawTime: 0, lastFrame: 0,
      x: 0, y: 0, vx: 0, vy: 0, impX: 0, impY: 0, hx: 0, hy: 0,
      lp1x: 0, lp1y: 0, lp2x: 0, lp2y: 0, slowX: 0, slowY: 0, accT: 0, predX: null, predY: null, pxl: undefined, pyl: 0,
      pulseX: 0, pulseY: 0, events: 0, eventWindow: 0, frequency: 0, emptyEvents: 0, source: 'idle',
      genericSensor: null, sensorError: '', startPromise: null,
      recording: false, trace: [], replaying: false, replayData: null, replayIdx: 0, replayT0: 0,
      head: { x: 0, y: 0, bx: 0, by: 0, lx: 0, ly: 0, t: -1e9, w: 0, has: false },
      px: 0, py: 0, anchorX: 0, anchorY: 0, loopOn: false
    };

    function emit(name, data) {
      var l = listeners[name]; if (!l) return;
      l.slice().forEach(function (fn) { try { fn(data); } catch (e) { if (typeof console !== 'undefined') console.error(e); } });
    }
    function status(state, message, code) {
      var d = { state: state, source: st.source, message: message || '', code: code || '' };
      st.status = d; emit('status', d);
    }

    // ---------------- sensor ingestion ----------------
    function ingest(x, y, isLinear, screenAligned, source, opts) {
      opts = opts || {};
      if (st.replaying && !opts.replay) return;
      var t = opts.ts || now();
      var dt = clamp((t - (st.lastRawTime || t)) / 1000, .008, .16);
      if (!isLinear) {
        if (!st.hasGravity) { st.gx = x; st.gy = y; st.hasGravity = true; }
        var alpha = 1 - Math.exp(-dt / .62);
        st.gx += (x - st.gx) * alpha; st.gy += (y - st.gy) * alpha;
        x -= st.gx; y -= st.gy;
      }
      var axes = screenAligned ? { x: x, y: y } : orientAxes(x, y, opts.angle);
      st.ax = clamp(axes.x, -16, 16); st.ay = clamp(axes.y, -16, 16);
      // Integrate exactly, independent of how sensor events line up with animation frames.
      var gap = (t - (st.lastRawTime || t)) / 1000;
      var idt = gap > .1 ? 0 : clamp(gap || .016, .004, .05);
      st.impX += (Math.abs(st.ax) < .03 ? 0 : st.ax) * idt;
      st.impY += (Math.abs(st.ay) < .03 ? 0 : st.ay) * idt;
      st.lastRawTime = st.lastSensor = t;
      st.events += 1;
      if (!st.live) {
        st.live = true; st.source = source;
        status('live', 'Receiving live motion readings (' + source + ').');
        if (st.resolveStart) { var r = st.resolveStart; st.resolveStart = st.rejectStart = null; r({ source: source }); }
      }
    }
    /** Feed a DeviceMotionEvent (or any object shaped like one). Used for live events and custom sources. */
    function feedMotion(ev, opts) {
      if (!st.replaying || (opts && opts.replay)) record(ev);
      var a = ev.acceleration, x = a && num(a.x), y = a && num(a.y);
      var src = opts && opts.replay ? 'trace replay' : 'devicemotion';
      if (x !== null && y !== null) return ingest(x, y, true, false, src, opts);
      a = ev.accelerationIncludingGravity; x = a && num(a.x); y = a && num(a.y);
      if (x === null || y === null) { st.emptyEvents += 1; return; }
      ingest(x, y, false, false, opts && opts.replay ? src : 'devicemotion + gravity filter', opts);
    }
    function record(ev) {
      if (!st.recording || st.replaying || st.trace.length >= 72000) return;
      var l = ev.acceleration || {}, g = ev.accelerationIncludingGravity || {}, r = ev.rotationRate || {};
      st.trace.push([Math.round(now() * 10) / 10, num(l.x), num(l.y), num(l.z), num(g.x), num(g.y), num(g.z),
        num(r.alpha), num(r.beta), num(r.gamma), currentAngle(), num(ev.interval)]);
    }
    function onDeviceMotion(ev) { if (!st.replaying) feedMotion(ev); }

    function startGenericSensor() {
      if (typeof window === 'undefined') return;
      var name = 'LinearAccelerationSensor' in window ? 'LinearAccelerationSensor' : ('Accelerometer' in window ? 'Accelerometer' : null);
      if (!name || st.live || st.genericSensor) return;
      try {
        var linear = name === 'LinearAccelerationSensor';
        var sensor = new window[name]({ frequency: 60, referenceFrame: 'screen' });
        sensor.addEventListener('reading', function () {
          if (sensor.x == null || sensor.y == null) return;
          ingest(sensor.x, sensor.y, linear, true, linear ? 'Generic Sensor (linear)' : 'Generic Sensor + gravity filter');
        });
        sensor.addEventListener('error', function (e) { st.sensorError = (e.error && e.error.name) || 'error'; });
        sensor.start(); st.genericSensor = sensor;
      } catch (err) { st.sensorError = (err && err.name) || 'error'; }
    }
    function noDataMessage() {
      var why = st.sensorError === 'NotAllowedError' || st.sensorError === 'SecurityError' ? 'The browser blocked motion sensors for this site. '
        : st.emptyEvents ? 'The browser sent motion events with no values (sensors blocked or missing). ' : 'No motion events arrived. ';
      return why + 'On Android, open the page directly in Chrome (not an in-app browser), check Chrome → Settings → Site settings → Motion sensors, reload, then retry.';
    }
    function fail(code, message) {
      st.attempted = true;
      status('error', message, code);
      var e = new Error(message); e.code = code;
      if (st.rejectStart) { var rj = st.rejectStart; st.resolveStart = st.rejectStart = null; rj(e); }
      st.startPromise = null;
      return Promise.reject(e);
    }
    /** Ask for motion sensors. Resolves with {source} on the first reading, rejects with Error.code in
     *  'insecure' | 'unsupported' | 'denied' | 'nodata'. Call from a user gesture (required on iOS). */
    function start() {
      if (st.live) return Promise.resolve({ source: st.source });
      if (st.startPromise) return st.startPromise;
      if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
      if (!window.isSecureContext) return fail('insecure', 'Motion sensors require a secure HTTPS page.');
      if (!('DeviceMotionEvent' in window) && !('LinearAccelerationSensor' in window) && !('Accelerometer' in window))
        return fail('unsupported', 'This browser does not expose motion sensors.');
      st.attempted = true; st.emptyEvents = 0; st.sensorError = '';
      status('connecting', 'Waiting for motion readings…');
      st.startPromise = new Promise(function (resolve, reject) { st.resolveStart = resolve; st.rejectStart = reject; });
      var begin = function () {
        if (!st.listening) { window.addEventListener('devicemotion', onDeviceMotion, { passive: true }); st.listening = true; }
        setTimeout(function () { if (!st.live && !st.destroyed) startGenericSensor(); }, 1500);
        setTimeout(function () { if (!st.live && st.rejectStart) fail('nodata', noDataMessage()).catch(function () {}); }, 4500);
      };
      try {
        if ('DeviceMotionEvent' in window && typeof DeviceMotionEvent.requestPermission === 'function') {
          Promise.resolve(DeviceMotionEvent.requestPermission()).then(function (p) {
            if (p !== 'granted') throw new Error('denied');
            begin();
          }).catch(function () { fail('denied', 'Motion permission was denied. Check browser settings, then retry.').catch(function () {}); });
        } else begin();
      } catch (err) { fail('unsupported', 'Unable to subscribe to the sensors: ' + err.message).catch(function () {}); }
      var p = st.startPromise; p.catch(function () {});
      return p;
    }
    function stop() {
      if (typeof window !== 'undefined') window.removeEventListener('devicemotion', onDeviceMotion);
      if (st.genericSensor) { try { st.genericSensor.stop(); } catch (_) {} st.genericSensor = null; }
      st.listening = false; st.live = false; st.startPromise = null; st.resolveStart = st.rejectStart = null;
      status('idle', 'Stopped.');
    }

    // ---------------- head tracking input (see floatread-face.js) ----------------
    /** Eyes' position relative to the screen, in metres (x right, y down), measured by a camera. */
    function setHeadOffset(xm, ym, confidence) {
      var h = st.head, t = now();
      if (!h.has) { h.bx = xm; h.by = ym; h.has = true; }
      h.x = xm; h.y = ym; h.t = t; h.w = confidence == null ? 1 : clamp(confidence, 0, 1);
    }
    function clearHead() { st.head.w = 0; st.head.has = false; st.head.lx = st.head.ly = 0; }

    // ---------------- main loop ----------------
    function resetMotion() {
      st.x = st.y = st.vx = st.vy = st.impX = st.impY = st.slowX = st.slowY = st.hx = st.hy = 0;
      st.lp1x = st.lp1y = st.lp2x = st.lp2y = 0; st.pulseX = st.pulseY = 0;
      st.gx = st.gy = 0; st.hasGravity = false; st.lastRawTime = 0; st.ax = st.ay = 0; st.pxl = undefined;
      if (st.predX) { st.predX.reset(); st.predY.reset(); }
      st.head.bx = st.head.x; st.head.by = st.head.y; st.head.lx = st.head.ly = 0;
      st.px = st.py = 0; apply();
    }
    function apply() {
      if (element) element.style.transform = 'translate3d(' + st.px.toFixed(2) + 'px,' + st.py.toFixed(2) + 'px,0)';
      if (anchorElement) anchorElement.style.transform = 'translate3d(' + st.anchorX.toFixed(1) + 'px,' + st.anchorY.toFixed(1) + 'px,0)';
    }
    function replayStep(t) {
      var d = st.replayData, elapsed = t - st.replayT0;
      while (st.replayIdx < d.length && d[st.replayIdx][0] - d[0][0] <= elapsed) {
        var r = d[st.replayIdx++];
        feedMotion({ acceleration: { x: r[1], y: r[2], z: r[3] }, accelerationIncludingGravity: { x: r[4], y: r[5], z: r[6] } },
          { replay: true, ts: st.replayT0 + (r[0] - d[0][0]), angle: r[10] || 0 });
      }
      if (st.replayIdx >= d.length) stopReplay();
    }
    /** Advance the model to time `t` (ms). Called automatically unless you pass autoLoop:false. */
    function tick(t) {
      t = t || now();
      if (!st.lastFrame) st.lastFrame = t;
      var dt = clamp((t - st.lastFrame) / 1000, 0, .05);
      st.lastFrame = t;
      if (st.replaying) replayStep(t);
      var dvx = st.impX, dvy = st.impY;
      st.impX = st.impY = 0;
      if (st.demo) {
        var u = t / 1000;
        dvx += (.6 * Math.sin(u * 4.2) + 2.8 * Math.sin(u * 12.1) * Math.pow(Math.sin(u * .7), 4)) * dt;
        dvy += (1.1 * Math.sin(u * 7.8) + 4.3 * Math.sin(u * 15.2) * Math.pow(Math.sin(u * .46), 6)) * dt;
      }
      dvx += st.pulseX * dt; dvy += st.pulseY * dt;
      var decay = Math.exp(-dt * 6.2);
      st.pulseX *= decay; st.pulseY *= decay;
      var ax = dt > 0 ? dvx / dt : 0, ay = dt > 0 ? dvy / dt : 0;

      // Leaky double integration + high-pass: quick bumps become displacement, slow acceleration leaks away.
      var leak = Math.exp(-dt / (s.smoothness / 100 * .1));
      st.vx = (st.vx + dvx) * leak; st.vy = (st.vy + dvy) * leak;
      st.x = (st.x + st.vx * dt) * leak; st.y = (st.y + st.vy * dt) * leak;
      var hp = 1 - Math.exp(-dt / .1);
      st.hx += (st.x - st.hx) * hp; st.hy += (st.y - st.hy) * hp;
      var k = pxPerMeter * s.compensation / 100, kx = k * s.sideBoost / 100;
      var rawX = -(st.x - st.hx) * kx, rawY = (st.y - st.hy) * k;

      // 1) band-limit  2) optional prediction  3) soft dead-band
      var tc = .64 / (2 * Math.PI * s.cutoff), lp = dt > 0 ? 1 - Math.exp(-dt / tc) : 0;
      st.lp1x += (rawX - st.lp1x) * lp; st.lp2x += (st.lp1x - st.lp2x) * lp;
      st.lp1y += (rawY - st.lp1y) * lp; st.lp2y += (st.lp1y - st.lp2y) * lp;
      var sx = st.lp2x, sy = st.lp2y;
      if (s.predict > 0) {
        if (!st.predX) { st.predX = new Predictor(); st.predY = new Predictor(); }
        st.accT += dt;
        var guard = 0;
        while (st.accT >= STEP && guard++ < 4) { st.accT -= STEP; st.pxl = st.predX.step(sx); st.pyl = st.predY.step(sy); }
        if (st.accT > STEP) st.accT = 0;
        if (st.pxl !== undefined) {
          var blend = s.predict / 100;
          sx += blend * clamp(st.pxl - sx, -14, 14); sy += blend * clamp(st.pyl - sy, -14, 14);
        }
      }
      var d = s.deadband;
      if (d > 0) { sx *= (sx * sx) / (sx * sx + d * d); sy *= (sy * sy) / (sy * sy + d * d); }

      // Head tracking: slow (<~1.5 Hz) eye-vs-screen motion from a camera. The accelerometer path above
      // cannot see this band, so the two are complementary.
      var hd = st.head, hx = 0, hy = 0;
      if (hd.has) {
        var age = t - hd.t;
        var target = age < 400 ? hd.w : 0;
        hd.fade = (hd.fade || 0) + (target - (hd.fade || 0)) * (1 - Math.exp(-dt / .25));
        var bl = 1 - Math.exp(-dt / 3);                       // slow baseline = your normal posture
        hd.bx += (hd.x - hd.bx) * bl; hd.by += (hd.y - hd.by) * bl;
        var hl = 1 - Math.exp(-dt / (1 / (2 * Math.PI * 1.5)));
        hd.lx += ((hd.x - hd.bx) - hd.lx) * hl; hd.ly += ((hd.y - hd.by) - hd.ly) * hl;
        var hk = pxPerMeter * s.head / 100 * hd.fade;
        hx = hd.lx * hk; hy = hd.ly * hk;
      }
      var tx = sx + hx, ty = sy + hy;
      st.px = st.enabled ? maxShift * Math.tanh(tx / maxShift) : 0;
      st.py = st.enabled ? maxShift * Math.tanh(ty / maxShift) : 0;

      // Edge-anchor offsets follow the slow part of the vehicle's acceleration (cornering, braking).
      var sa = 1 - Math.exp(-dt / .45);
      st.slowX += (ax - st.slowX) * sa; st.slowY += (ay - st.slowY) * sa;
      st.anchorX = clamp(-st.slowX * 4, -14, 14); st.anchorY = clamp(st.slowY * 4, -14, 14);
      apply();

      if (!st.eventWindow) st.eventWindow = t;
      if (t - st.eventWindow >= 1000) { st.frequency = Math.round(st.events * 1000 / (t - st.eventWindow)); st.events = 0; st.eventWindow = t; }
      st.lastAx = st.demo || !st.live ? ax : st.ax; st.lastAy = st.demo || !st.live ? ay : st.ay;
      emit('frame', { x: st.px, y: st.py, anchorX: st.anchorX, anchorY: st.anchorY, ax: st.lastAx, ay: st.lastAy });
    }
    function loop(t) {
      if (st.destroyed || !st.loopOn) return;
      tick(t); raf(loop);
    }
    if (options.autoLoop !== false) { st.loopOn = true; raf(loop); }

    // ---------------- misc API ----------------
    function simulate(on) {
      st.demo = on == null ? !st.demo : !!on;
      status(st.demo ? 'demo' : (st.live ? 'live' : 'idle'), st.demo ? 'Simulating road bumps.' : '');
      return st.demo;
    }
    function bump() { st.pulseX += (Math.random() - .5) * 8; st.pulseY += (Math.random() > .5 ? 1 : -1) * 9; }
    function recordStart() { st.trace = []; st.recording = true; }
    function recordStop() { st.recording = false; return st.trace.length; }
    function getTrace() {
      return { app: 'FloatRead', version: 1, created: new Date().toISOString(), columns: TRACE_COLUMNS, samples: st.trace };
    }
    function replay(trace) {
      var smp = trace && Array.isArray(trace.samples) ? trace.samples : null;
      if (!smp || smp.length < 10 || smp.length > 200000 || !Array.isArray(smp[0])) throw new Error('Not a FloatRead trace');
      resetMotion(); st.demo = false;
      st.replayData = smp; st.replayIdx = 0; st.replayT0 = now(); st.replaying = true;
      st.source = 'trace replay';
      status('replay', 'Replaying a recorded ride (' + Math.round((smp[smp.length - 1][0] - smp[0][0]) / 1000) + ' s).');
      return (smp[smp.length - 1][0] - smp[0][0]) / 1000;
    }
    function stopReplay() {
      if (!st.replaying) return;
      st.replaying = false; st.replayData = null; st.live = false;
      status('idle', 'Replay finished.', 'replay-end'); emit('replayend', {});
    }
    function destroy() {
      st.destroyed = true; st.loopOn = false; stop(); listeners = {};
      if (element) element.style.transform = '';
      if (anchorElement) anchorElement.style.transform = '';
    }

    return {
      version: VERSION,
      start: start, stop: stop, tick: tick, destroy: destroy,
      feedMotion: feedMotion, setHeadOffset: setHeadOffset, clearHead: clearHead,
      set: function (p) { for (var key in p) if (key in DEFAULTS) s[key] = Number(p[key]); },
      get: function () { var o = {}; for (var key in s) o[key] = s[key]; return o; },
      applyPreset: function (name) { if (!PRESETS[name]) return false; for (var key in PRESETS[name]) s[key] = PRESETS[name][key]; resetMotion(); return true; },
      setEnabled: function (on) { st.enabled = !!on; }, isEnabled: function () { return st.enabled; },
      recalibrate: resetMotion, simulate: simulate, bump: bump,
      recordStart: recordStart, recordStop: recordStop, getTrace: getTrace, replay: replay, stopReplay: stopReplay,
      isRecording: function () { return st.recording; }, isReplaying: function () { return st.replaying; },
      getOffset: function () { return { x: st.px, y: st.py }; },
      getMetrics: function () {
        return { live: st.live, source: st.demo ? 'simulation' : st.source, simulating: st.demo, eventsPerSecond: st.frequency, ax: st.lastAx || 0, ay: st.lastAy || 0,
          px: st.px, py: st.py, recording: st.recording, traceLength: st.trace.length, replaying: st.replaying, headTracking: st.head.has && (st.head.fade || 0) > .05 };
      },
      getStatus: function () { return st.status || { state: 'idle', source: 'idle', message: '', code: '' }; },
      on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); }; },
      off: function (name, fn) { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); }
    };
  }

  return { version: VERSION, create: create, PRESETS: PRESETS, DEFAULTS: DEFAULTS };
});
