# Using FloatRead in your own app

FloatRead is split so the motion engine can be dropped into any web app as a feature.

| File | What it is | Dependencies |
|---|---|---|
| `floatread-core.js` | Motion engine: reads the phone's motion sensors and computes a small counter-shift for any element. UI-free. | none |
| `floatread-face.js` | Optional camera head tracking (slow sway the accelerometer can't see). Opt-in. | MediaPipe Face Landmarker, loaded from a CDN on first use |
| `app.js`, `index.html` | The demo reading app, built only on the two modules above. | - |

## Quick start

```html
<script src="floatread-core.js"></script>
<div id="reader">…your content…</div>
<script>
  const fr = FloatRead.create({ element: document.getElementById('reader') });
  startButton.onclick = () => fr.start().catch(err => console.warn(err.code, err.message));
</script>
```

`start()` must run from a user gesture (required on iOS) and on an HTTPS page. It resolves with `{source}` on the first
reading and rejects with `err.code` of `insecure`, `unsupported`, `denied` or `nodata`.

`FloatRead.create(options)` applies a CSS `translate3d` to `options.element` every frame. You can also drive your own
transforms: pass no `element`, listen to `frame` events, and set `autoLoop: false` to call `fr.tick(now)` yourself.

## Options
- `element`, `anchorElement`: elements that receive the counter-shift / the edge-anchor drift.
- `preset`: `'smooth' | 'rough' | 'sway'`. `settings`: any of the tuning values below.
- `pxPerMeter` (default 6000, about 160 CSS px per inch), `maxShift` (soft limit in px, default 36), `autoLoop`.

## Tuning values (`fr.set({...})`, `fr.get()`, `fr.applyPreset(name)`)
`compensation` %, `sideBoost` % (left-right only), `smoothness` (bump filter), `cutoff` Hz (ignore faster vibration),
`predict` % (experimental), `deadband` px (ignore tiny jitter), `head` % (camera head-tracking strength).

## Methods
`start()`, `stop()`, `setEnabled(bool)`, `recalibrate()`, `simulate(bool?)`, `bump()`, `getOffset()`, `getMetrics()`,
`getStatus()`, `feedMotion(deviceMotionLikeEvent)` (custom sensor source), `setHeadOffset(xMeters, yMeters, confidence)`,
`destroy()`.

Record and replay real rides: `recordStart()`, `recordStop()`, `getTrace()` (JSON-serializable), `replay(trace)`, `stopReplay()`.

## Events (`fr.on(name, fn)` returns an unsubscribe function)
- `status`: `{state: 'idle'|'connecting'|'live'|'demo'|'replay'|'error', source, message, code}`
- `frame`: `{x, y, anchorX, anchorY, ax, ay}` every frame (px / m/s²)
- `replayend`

## Camera head tracking
```html
<script src="floatread-face.js"></script>
<script>
  const face = FloatReadFace.create({ stabilizer: fr });
  await face.start();   // asks for camera permission, downloads the model once
</script>
```
Video is processed on the device and never uploaded. Because a bump blurs the camera frame, the camera estimate is
protected two ways: the core freezes it during and 300 ms after any jolt the accelerometer reports, and the face module
drops blurry frames (low sharpness) and implausible one-frame jumps. During a bump the accelerometer path does the work. Self-host the MediaPipe files with
`FloatReadFace.create({ stabilizer: fr, assets: { module, wasm, model } })`.

## How it works, and its limits
- The accelerometer path integrates sensed jolts into a displacement, high-pass filters it (slow braking/turns are
  ignored), band-limits it, and applies a soft dead-band. It targets roughly 3-10 Hz, where the eyes cannot follow.
- It cannot see your head. The optional camera path measures eye position relative to the screen for slower sway
  (below ~1.5 Hz); the two are complementary.
- Sensor latency (~30-60 ms) limits correction of fast vibration. The predictor that tries to offset it is
  experimental and off by default: it helped in isolation but not in full-pipeline simulation.
- Not validated on real rides yet. Use record/replay to collect data.
- Passenger use only. Never use while driving.

## Typography
There is no scientifically proven best font for reading under vibration. The one vibration-specific study we found
(Industrial Health, 2010) rated Arial easier than Times New Roman; larger and heavier type matters more than the
typeface. The demo therefore defaults to large text (24 px), heavier weight, generous line spacing (2.0), open letter
spacing and wide side margins (also so text never clips while shifting). The default typeface is Atkinson
Hyperlegible Next (SIL OFL, bundled in `fonts/`), designed for distinguishable letterforms; a Roboto/Arial option
(the typeface from the study), Verdana, serif and monospace are available. All spacing is adjustable.
