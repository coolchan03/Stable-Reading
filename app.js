/* FloatRead demo app: a reading UI built on floatread-core.js (motion) and floatread-face.js (camera). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var reader = $('readerSurface'), content = $('readerContent'), body = document.body;
  var fr = FloatRead.create({ element: reader, anchorElement: $('anchorDots') });
  var face = null, uiTime = 0;
  var settingKeys = { compensation: 100, sideBoost: 100, smoothness: 85, cutoff: 8, predict: 0, deadband: 1.5, head: 100, fontSize: 24, lineHeight: 2, letterSpacing: 3, sideMargin: 44 };
  var suffixes = { fontSize: ' px', cutoff: ' Hz', deadband: ' px', letterSpacing: '%', sideMargin: ' px', lineHeight: '' };
  var typeVars = { fontSize: ['--reader-font-size', function (v) { return v + 'px'; }], lineHeight: ['--reader-lh', function (v) { return v; }], letterSpacing: ['--reader-ls', function (v) { return (v / 100) + 'em'; }], sideMargin: ['--reader-pad-x', function (v) { return v + 'px'; }] };
  var storagePrefix = 'floatread-v5-';
  function storageGet(key) { try { return localStorage.getItem(storagePrefix + key); } catch (_) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(storagePrefix + key, String(value)); } catch (_) {} }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function setMessage(message) { $('sensorMessage').textContent = message; }
  function setBadge(kind, text) {
    $('sensorBadge').dataset.state = kind;
    $('sensorBadgeText').textContent = text;
    $('readerState').textContent = kind === 'live' ? 'Live motion detected' : kind === 'demo' ? 'Simulated movement' : text;
  }

  // ---- motion status from the core ----
  var badgeFor = { insecure: 'HTTPS required', unsupported: 'API unavailable', denied: 'Permission denied', nodata: 'No sensor data' };
  fr.on('status', function (s) {
    if (s.state === 'live') { setBadge('live', 'Sensors active'); $('enableSensors').textContent = 'Sensors connected'; setMessage(s.message + ' Gently move the phone and watch the axes change.'); }
    else if (s.state === 'connecting') { setBadge('idle', 'Requesting…'); $('enableSensors').textContent = 'Listening for motion…'; setMessage(s.message); }
    else if (s.state === 'demo') { setBadge('demo', 'Simulation on'); setMessage('Road bumps are being simulated. Toggle stabilization off, then on, to compare.'); }
    else if (s.state === 'replay') { setBadge('live', 'Replaying ride'); setMessage(s.message + ' Adjust the sliders to see how each setting reacts.'); }
    else if (s.state === 'error') { setBadge('error', badgeFor[s.code] || 'Unavailable'); $('enableSensors').textContent = 'Retry sensors'; setMessage(s.message); }
    else if (s.state === 'idle') { setBadge('idle', s.code === 'replay-end' ? 'Replay finished' : 'Not connected'); if (s.message) setMessage(s.message); }
  });
  fr.on('replayend', function () { $('replayButton').textContent = 'Load trace to replay'; });
  fr.on('frame', function (f) {
    var t = performance.now();
    if (t - uiTime < 110) return;
    uiTime = t;
    var m = fr.getMetrics();
    $('axReadout').textContent = f.ax.toFixed(2);
    $('ayReadout').textContent = f.ay.toFixed(2);
    updateGauge('xBar', f.ax); updateGauge('yBar', f.ay);
    $('shiftReadout').textContent = Math.hypot(f.x, f.y).toFixed(1) + ' px offset';
    $('frequencyReadout').textContent = m.eventsPerSecond + ' events/sec' + (m.recording ? ' · rec ' + m.traceLength : '') + (m.headTracking ? ' · head' : '');
    $('motionType').textContent = m.simulating ? 'Simulation' : m.live ? 'Live · ' + m.source : 'No live readings';
  });
  function updateGauge(id, value) {
    var el = $(id), p = clamp(value / 12 * 50, -50, 50);
    el.style.left = (p < 0 ? 50 + p : 50) + '%';
    el.style.width = Math.abs(p) + '%';
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
  function applySliders() {
    var o = {};
    ['compensation', 'sideBoost', 'smoothness', 'cutoff', 'predict', 'deadband', 'head'].forEach(function (k) { o[k] = Number($(k).value); });
    fr.set(o);
  }
  function bindSettings() {
    Object.keys(settingKeys).forEach(function (key) {
      var input = $(key);
      var saved = storageGet(key), previous = saved === null ? NaN : Number(saved);
      if (previous >= Number(input.min) && previous <= Number(input.max)) input.value = previous;
      var render = function () {
        $(key + 'Output').textContent = input.value + (suffixes[key] || '%');
        storageSet(key, input.value);
        if (typeVars[key]) reader.style.setProperty(typeVars[key][0], typeVars[key][1](input.value));
        else applySliders();
      };
      input.addEventListener('input', function () {
        render();
        if (!typeVars[key] && FloatRead.PRESETS[$('preset').value]) { $('preset').value = 'custom'; storageSet('preset', 'custom'); }
      });
      render();
    });
    var presetSel = $('preset'), savedPreset = storageGet('preset');
    if (savedPreset && (FloatRead.PRESETS[savedPreset] || savedPreset === 'custom')) presetSel.value = savedPreset;
    presetSel.addEventListener('change', function () {
      var p = FloatRead.PRESETS[presetSel.value]; storageSet('preset', presetSel.value);
      if (!p) return;
      Object.keys(p).forEach(function (key) { var el = $(key); el.value = p[key]; $(key + 'Output').textContent = el.value + (suffixes[key] || '%'); storageSet(key, el.value); });
      applySliders(); fr.recalibrate();
      setMessage('Preset applied. Fine-tune the sliders if needed.');
    });
    var fontSel = $('fontFamily'), savedFont = storageGet('font');
    for (var i = 0; i < fontSel.options.length; i++) if (fontSel.options[i].value === savedFont) fontSel.value = savedFont;
    var applyFont = function () { reader.style.setProperty('--reader-font', fontSel.value); storageSet('font', fontSel.value); };
    fontSel.addEventListener('change', applyFont); applyFont();
    var bold = $('boldText'); bold.checked = storageGet('bold') !== 'false';
    var applyBold = function () { reader.style.setProperty('--reader-weight', bold.checked ? '560' : '400'); storageSet('bold', bold.checked); };
    bold.addEventListener('change', applyBold); applyBold();
    var anchorSwitch = $('anchorSwitch'); anchorSwitch.checked = storageGet('anchors') !== 'false';
    var applyAnchors = function () { $('anchorLayer').hidden = !anchorSwitch.checked; storageSet('anchors', anchorSwitch.checked); };
    anchorSwitch.addEventListener('change', applyAnchors); applyAnchors();
    var sw = $('stabilizationSwitch'); sw.checked = storageGet('enabled') !== 'false'; fr.setEnabled(sw.checked);
    sw.addEventListener('change', function (e) { fr.setEnabled(e.target.checked); storageSet('enabled', e.target.checked); });
  }

  // ---- camera head tracking (optional) ----
  function setHeadTracking(on) {
    var sw = $('headSwitch');
    if (!on) { if (face) face.stop(); $('headState').textContent = 'Off'; return; }
    if (!face) {
      if (typeof FloatReadFace === 'undefined') { sw.checked = false; setMessage('Head tracking module failed to load.'); return; }
      face = FloatReadFace.create({ stabilizer: fr });
      face.on('status', function (s) { $('headState').textContent = s.state === 'loading' ? 'Starting camera…' : s.state === 'tracking' ? 'Tracking' : 'Off'; });
      var lastFound = 0;
      face.on('face', function (f) { if (f.found) lastFound = performance.now(); $('headState').textContent = f.found ? 'Tracking' : 'No face in view'; });
    }
    $('headState').textContent = 'Starting camera…';
    face.start().then(function () {
      setMessage('Head tracking is on. Hold the phone so your face is visible to the front camera. Video never leaves your device.');
    }).catch(function (e) {
      sw.checked = false; storageSet('head-on', false); $('headState').textContent = 'Off';
      setMessage(e && e.code === 'denied' ? 'Camera permission was denied, so head tracking is off.' : 'Could not start head tracking: ' + (e && e.message ? e.message : 'unknown error'));
    });
  }

  function downloadTrace() {
    var tr = fr.getTrace();
    if (!tr.samples.length) { setMessage('Nothing recorded yet. Tap Record, ride a while, then download.'); return; }
    var url = URL.createObjectURL(new Blob([JSON.stringify(tr)], { type: 'application/json' }));
    var a = document.createElement('a'); a.href = url;
    a.download = 'floatread-trace-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    setMessage('Saved ' + tr.samples.length + ' samples. Nothing was uploaded.');
  }
  function bindActions() {
    $('enableSensors').addEventListener('click', function () {
      if (fr.getMetrics().live) { fr.simulate(false); setMessage('Sensors are active. Move your device gently to see the live readings.'); return; }
      fr.start().catch(function () {});
    });
    $('demoButton').addEventListener('click', function () {
      var on = fr.simulate();
      $('demoButton').setAttribute('aria-pressed', String(on));
      $('demoButton').textContent = on ? 'Stop simulation' : 'Simulate a road';
    });
    $('bumpButton').addEventListener('click', function () { fr.bump(); setMessage('A test bump was added. Adjust compensation and the bump filter to change the reaction.'); });
    $('calibrateButton').addEventListener('click', function () { fr.recalibrate(); setMessage('Motion state and gravity baseline reset. Hold the phone comfortably, then try a gentle shake.'); });
    $('focusButton').addEventListener('click', function () {
      var open = body.classList.toggle('focus-reading');
      $('focusButton').setAttribute('aria-pressed', String(open));
      $('focusButton').textContent = open ? '✕ Exit focus' : '⤢ Focus view';
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && body.classList.contains('focus-reading')) $('focusButton').click();
    });
    $('headSwitch').addEventListener('change', function (e) { storageSet('head-on', e.target.checked); setHeadTracking(e.target.checked); });
    $('recordButton').addEventListener('click', function () {
      if (fr.isRecording()) { var n = fr.recordStop(); setMessage('Recording stopped (' + n + ' samples). Download it to keep it.'); }
      else { fr.recordStart(); setMessage('Recording raw sensor data on this device. Enable sensors first if the badge is not active.'); }
      $('recordButton').textContent = fr.isRecording() ? '■ Stop recording' : '● Record ride';
      $('recordButton').setAttribute('aria-pressed', String(fr.isRecording()));
    });
    $('downloadTrace').addEventListener('click', downloadTrace);
    $('replayButton').addEventListener('click', function () {
      if (fr.isReplaying()) { fr.stopReplay(); return; }
      $('traceInput').click();
    });
    $('traceInput').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      file.text().then(function (txt) { fr.replay(JSON.parse(txt)); $('replayButton').textContent = 'Stop replay'; })
        .catch(function () { setMessage('That does not look like a FloatRead trace file.'); });
      event.target.value = '';
    });
    $('applyText').addEventListener('click', function () { setText($('customText').value); });
    $('fileInput').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 900000) { setMessage('This file is too large for the prototype (limit: 900 KB).'); return; }
      file.text().then(function (txt) { $('customText').value = txt; setText(txt); event.target.value = ''; })
        .catch(function () { setMessage('Could not read this file. Try a UTF-8 .txt file.'); });
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) fr.recalibrate(); });
  }
  function initialize() {
    bindSettings(); bindActions();
    var custom = storageGet('text');
    if (!custom) { try { custom = localStorage.getItem('floatread-v4-text'); } catch (_) {} }
    if (custom) { $('customText').value = custom; setText(custom); }
    if (!window.isSecureContext) setMessage('A secure HTTPS origin is required for motion sensors. Open the GitHub Pages URL in Chrome.');
    window.floatread = fr; // handy for experimenting from the console
    if ('serviceWorker' in navigator && window.isSecureContext)
      window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
  }
  initialize();
})();
