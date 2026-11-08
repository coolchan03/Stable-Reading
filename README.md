# FloatRead

**Try it:** https://coolchan03.github.io/Stable-Reading/

An experimental, mobile-friendly web reader that moves the text in response to accelerometer motion, using a bounded spring-and-damper model. It is meant to soften small vehicle bumps, not perfectly stabilize the view relative to your eyes.

## Try it on Android

1. Open the **HTTPS GitHub Pages link in Chrome**, not inside ChatGPT's embedded browser.
2. Tap **Enable phone sensors**. The badge should change to **Sensors active** and show readings per second.
3. Hold your phone and move it gently. The live X/Y readings should respond.
4. Compare **Stabilization** on and off, then adjust **Compensation** and **Damping**.
5. For a controlled comparison, use **Simulate a road** or **Add a bump**.
6. Use **Focus view** to read with fewer distractions, or import/paste your own plain text.

If Chrome sends no sensor events, go to **Chrome Settings → Site settings → Motion sensors**, enable access, reload the site, and try again. Mobile browser implementations vary; sensor permission cannot be overridden by the webpage. Some browsers do not expose motion events at all.

## Features

- Live accelerometer motion via the browser's devicemotion API.
- Gravity removal fallback when only gravity-inclusive readings are available.
- Orientation-aware axes, bounded spring response, adjustable strength and damping.
- Motion-source status, event frequency and live acceleration readouts.
- Simulated road bumps, manual bumps and a reset/recalibration button.
- Focus reading mode, text size control and local .txt/.md import.
- Local-only settings/text storage, no third-party scripts or analytics.
- Service worker for offline reuse after the first successful HTTPS load.

## What it cannot do

An accelerometer cannot directly observe the position of the user's eyes, and acceleration integration drifts. The algorithm uses a heavily damped spring with a displacement limit instead of trying to recover absolute device position. Readability benefits are not guaranteed; badly tuned settings may increase perceived jitter.

**Passenger-only experiment. Do not use it while driving.**

## Deploy

Static site. GitHub Pages settings: **Deploy from a branch → main → /(root)**. The root index.html is the entrypoint; no build or package manager required. All app files should live together.

## Local development

Any static web server can serve the files, but the devicemotion API typically requires HTTPS (localhost can be treated as a secure context). Test sensor functionality on a real mobile phone at the published HTTPS URL.
