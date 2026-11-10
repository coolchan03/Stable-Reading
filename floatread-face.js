/*!
 * FloatRead face tracking (optional). Measures where your eyes are relative to the screen using the
 * front camera, and feeds that to a FloatRead stabilizer via setHeadOffset(). It covers the slow
 * (< ~1.5 Hz) motion the accelerometer cannot see. Opt-in: nothing starts until start() is called.
 *
 * Frames are processed on the device by MediaPipe Face Landmarker; no video leaves the phone.
 * The MediaPipe library and model are downloaded from public CDNs on first use (override via
 * options.assets to self-host).
 *
 *   const face = FloatReadFace.create({ stabilizer: fr });
 *   await face.start();   // asks for camera permission
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define(factory);
  else root.FloatReadFace = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ASSETS = {
    module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
  };
  var EYE_CORNER_M = 0.092; // typical distance between the outer eye corners, metres (only sets the scale)

  function create(options) {
    options = options || {};
    var stab = options.stabilizer;
    if (!stab || typeof stab.setHeadOffset !== 'function') throw new Error('FloatReadFace: pass { stabilizer }');
    var assets = Object.assign({}, ASSETS, options.assets || {});
    var listeners = {}, video = null, stream = null, landmarker = null, running = false, lastTime = -1, startPromise = null;
    var lastFaceAt = 0;

    function emit(name, data) { (listeners[name] || []).slice().forEach(function (fn) { try { fn(data); } catch (_) {} }); }

    function process(result) {
      var lm = result && result.faceLandmarks && result.faceLandmarks[0];
      if (!lm || lm.length < 400) { emit('face', { found: false }); return; }
      var w = video.videoWidth, h = video.videoHeight;
      var a = lm[33], b = lm[263];                       // outer eye corners
      var eyePx = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
      if (!(eyePx > 8)) return;
      var u = (a.x + b.x) / 2, v = (a.y + b.y) / 2;      // midpoint between the eyes, normalized
      var mPerPx = EYE_CORNER_M / eyePx;
      // Front-camera frames are not mirrored: the user's right is the image's left.
      var xm = -(u - .5) * w * mPerPx, ym = (v - .5) * h * mPerPx;
      stab.setHeadOffset(xm, ym, 1);
      lastFaceAt = performance.now();
      emit('face', { found: true, x: xm, y: ym, eyePixels: eyePx });
    }
    function frame() {
      if (!running) return;
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        try { process(landmarker.detectForVideo(video, performance.now())); } catch (e) { emit('error', e); }
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
      else requestAnimationFrame(frame);
    }
    function start() {
      if (running) return Promise.resolve();
      if (startPromise) return startPromise;
      startPromise = (async function () {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('Camera not available'), { code: 'unsupported' });
        emit('status', { state: 'loading' });
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 30 } }, audio: false });
        } catch (e) { throw Object.assign(new Error('Camera permission was denied'), { code: 'denied' }); }
        video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
        video.srcObject = stream;
        await video.play();
        var vision = await import(assets.module);
        var fileset = await vision.FilesetResolver.forVisionTasks(assets.wasm);
        var make = function (delegate) {
          return vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: assets.model, delegate: delegate },
            runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
          });
        };
        try { landmarker = await make('GPU'); } catch (_) { landmarker = await make('CPU'); }
        running = true; lastTime = -1;
        emit('status', { state: 'tracking' });
        frame();
      })().catch(function (e) { stop(); throw e; });
      return startPromise;
    }
    function stop() {
      running = false; startPromise = null;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      if (video) { video.srcObject = null; video = null; }
      if (landmarker) { try { landmarker.close(); } catch (_) {} landmarker = null; }
      if (stab.clearHead) stab.clearHead();
      emit('status', { state: 'off' });
    }
    return {
      start: start, stop: stop, isRunning: function () { return running; },
      lastFaceAgo: function () { return performance.now() - lastFaceAt; },
      on: function (n, fn) { (listeners[n] = listeners[n] || []).push(fn); }
    };
  }
  return { create: create, ASSETS: ASSETS };
});
