# Recorder — Voice Recorder + Auto-Tune with Piano-Roll Visualization

## Goal

A web app that records your voice and shows it as a glowing **pitch line moving across piano-key lanes**. It then **auto-tunes** the recording so it snaps to the notes of a scale you pick.

The visual and UX reference is **`Goal.mp4`** (vertical video, 1:45) in the project root. When unsure how something should look or behave, match the video.

### What Goal.mp4 shows (the spec)

| Time | Scene | Feature |
|---|---|---|
| 0:00–0:20 | "MY VOICE": a piano on the left (labelled C2, C3…) and one colored horizontal lane per semitone. A white glowing line scrolls left, with its head (a dot) on a fixed vertical "now" line at about 73% of the width. Unvoiced parts leave gaps. | Live pitch visualizer |
| 0:03–0:06 | "ON AUTO-TUNE": the line becomes a staircase, each step on one lane, and the step and its key light up in the lane's color. | Snap to nearest note |
| 0:07–0:09 | "Each of these lanes is one key on a piano": the keys light up in their lane colors. | Key/lane color mapping |
| 0:28–0:42 | Waveform; "slides a copy" (autocorrelation); 11.4 ms period = lower pitch, 7.8 ms = higher. | Pitch detection (YIN) |
| 0:46 | "NEAREST NOTE": C3 lane and key highlighted. | Quantization |
| 0:50–0:58 | "RETUNE SPEED" knob from 0 to 400 ms. At 66 ms the line glides; at 0 ms it jumps instantly (the Cher/"Believe" robot sound). | Retune speed control |
| 1:08–1:24 | "PICK THE NOTES": a SCALE chip (Chromatic, C MAJOR). Notes outside the scale are greyed out, their lanes are removed, and the keyboard shows note letters. | Scale/key picker |
| 1:28–1:44 | "A HARMONIZER": one voice, many notes, with several lanes lit at once. | Harmonizer (stretch) |

Look: a near-black background (#0f0f10-ish), muted dark lane fills whose hue cycles from one semitone to the next, a bright white line with a soft glow, and lit keys and lanes in saturated colors. Bold sans-serif headings; small letter-spaced labels above them ("THE LINE", "SHORTER WAVE").

## Decisions (2026-10-14)

- **Platform:** web app, later installable as a PWA. **Vite + TypeScript**, no UI framework (plain TS modules + Canvas 2D).
- **Timing:** the pitch line is drawn **live** while recording. The tuned audio is rendered **after** recording stops, offline, with PSOLA. Fully live auto-tune is out of scope for now.
- **Pitch detection:** our own **YIN** implementation (`src/dsp/yin.ts`), run on the main thread on audio downsampled to about 24 kHz.
- **Note math:** MIDI numbers, A4 = 440 Hz, **middle C = C4 = MIDI 60** (so the video's speaking voice sits around C3).
- **Audio capture:** an AudioWorklet (`src/audio/capture-worklet.ts`) posts sample blocks to the main thread. It is connected to the destination through a zero-gain node, so there is no feedback.
- **Storage:** IndexedDB database `recorder` (`src/storage/recording-store.ts`) with two object stores. `meta` holds `RecordingMeta` (id, name, createdAt, duration, sampleRate), so the list loads without reading any audio. `data` holds the raw Float32 PCM at the input rate plus the pitch track packed as typed-array columns (`src/storage/pitch-track.ts`, NaN = unvoiced).
- **Sync:** a take's audio blocks and pitch frames both start at the moment Record is pressed (a new `PitchTracker` is created then), so frame times line up directly with sample positions.
- **Auto-tune curve** (`src/dsp/autotune.ts`): for each frame, choose the target note (nearest in-scale note, with 0.15-semitone hysteresis so a voice hovering at the midpoint doesn't flicker). The correction is a **shift** added to the sung pitch and smoothed with time constant `retuneMs / 3`. At 0 ms the result is the exact staircase. At slow speeds the average lands on the note while vibrato passes through, like classic auto-tune. The voice re-glides from its natural pitch after each silence.
- **Tuning display:** the piano roll keeps raw frames plus `{target, corrected}`. It re-corrects everything it holds whenever settings change, so turning the knob updates a paused recording instantly. Lines are drawn to an offscreen layer, so the left-edge fade works for colored lines.
- **Tuning prefs** (enabled, key, scale, retune) are saved in localStorage (`src/storage/settings.ts`). They are global for now; Phase 4 may store them per recording.
- **Tuned audio** (`src/dsp/psola.ts`) uses TD-PSOLA:
  - In voiced stretches there is one analysis mark per cycle, on the peak of a zero-phase 900 Hz low-passed copy.
  - Synthesis marks step through time at `period / ratio`. Each one copies the Hann grain (half-length = max(analysis period, synthesis period)) from the nearest analysis mark.
  - Unvoiced audio uses identity grains, so it passes through exactly.
  - Overlap-add is normalized by the summed window weight, blending toward the original where the weight is below 0.25.
  - Formants are preserved because grains are moved, never resampled. A minute of audio renders in well under a second.
- **Render pipeline:** `TunedRenderer` sends the original samples, the packed pitch track and the settings to `render-worker.ts`, which runs `correctTrack` then `renderTuned`. The latest request wins; stale renders resolve to null. Re-renders are debounced by 120 ms while the knob turns.
- **A/B:** the open recording keeps `samples` (original) and `tuned`. `Player.swap()` changes the buffer while keeping position and play state. Play on a just-opened recording waits for the tuned render, so it doesn't switch mid-play.
- **Harmonizer** (`src/dsp/harmony.ts`): each voice follows the lead's *corrected* pitch, offset by a number of **scale steps**, so harmonies stay in key (3rd/5th up or down, octave up or down). In Chromatic the steps are fixed semitones: +4/+7 up, −3/−7 down. Every voice is its own PSOLA render, mixed at `mix / √voices` and passed through a look-ahead peak limiter (`src/dsp/limiter.ts`, ceiling 0.98), so only the loud moments get turned down. Harmony is part of `TuneSettings`, so it flows through the worker, the roll and the render cache key.
- **PWA:**
  - `public/manifest.webmanifest` and icons, regenerated with `npm run icons` (a procedural rasterizer in `scripts/make-icons.mjs`).
  - `vite.config.ts` emits `sw.js` at build time. It precaches every built file, and its cache version is a content hash. Page navigations are network-first, everything else cache-first with `ignoreVary`.
  - The service worker is registered only in production (`src/pwa.ts`), and an Install button appears when the browser offers installation.
  - `base: './'` lets the build run from any sub-path.
- **HTTPS for phones:** `npm run dev:lan` / `npm run preview:lan` use `--mode lan`, which turns on `@vitejs/plugin-basic-ssl` (a self-signed cert: accept the warning on the phone). This is enough for microphone testing. A *real* install with offline support on a phone needs a trusted HTTPS host (e.g. GitHub Pages), because service workers don't register on certificate errors.
- **Headings and captions:** the heading follows the tuning state, like the video's title cards: "Live pitch / My voice", "Nearest note / On auto-tune", "Only / C major", "One voice, many notes / A harmonizer". `src/ui/captions.ts` shows short word-by-word captions when a setting changes, plus a one-time intro (`localStorage['recorder.introSeen']`).
- **Modes** (`src/main.ts`): `idle`, `listening` (live line, nothing saved), `recording` (live line + saving), `playback` (a saved recording is open and the roll follows `Player.currentTime`).

## Architecture

```
src/
  main.ts                 controller: modes, buttons, recording/saving, playback, render loop
  style.css
  dsp/
    yin.ts                YIN pitch detector (pure, unit-tested)
    notes.ts              freq <-> MIDI, note names
    scales.ts             scale types, masks, nearest in-scale note
    autotune.ts           PitchCorrector: target note + retune-speed glide
    psola.ts              TD-PSOLA renderer for the tuned audio
    harmony.ts            diatonic harmony voices + mixed render (renderWithHarmony)
    limiter.ts            look-ahead peak limiter
    resample.ts           low-pass + decimate to the analysis rate
  audio/
    capture-worklet.ts    AudioWorkletProcessor: forwards input blocks
    audio-input.ts        mic / demo-tone sources -> worklet -> callback
    pitch-tracker.ts      ring buffer + hop scheduling -> PitchFrame stream
    sample-buffer.ts      collects PCM blocks during a take
    player.ts             AudioBuffer playback: play/pause/seek/swap + latency-compensated clock
    render-worker.ts      Web Worker: correctTrack + renderTuned off the main thread
    tuned-renderer.ts     main-thread client for the worker (latest request wins)
    wav.ts                16-bit PCM WAV encoder
  storage/
    recording-store.ts    IndexedDB: list/save/load/rename/delete recordings
    pitch-track.ts        pack/unpack PitchFrame[] <-> typed-array columns
    settings.ts           auto-tune prefs in localStorage
  ui/
    piano-roll.ts         canvas renderer: keyboard, lanes, glowing line; live + playback modes, drag to scrub
    recordings-list.ts    recordings list (play, rename inline, WAV export, delete)
    knob.ts               rotary knob (drag, wheel, arrows, double-click to reset)
    captions.ts           word-by-word explainer captions over the roll
  pwa.ts                  service-worker registration + Install button
public/                   manifest, icon.svg, icons/*.png (generated)
scripts/make-icons.mjs    procedural icon renderer (no deps)
vite.config.ts            base './', LAN HTTPS mode, build-time service worker
    colors.ts             lane/key color palette
    format.ts             time formatting
tests/                    vitest unit tests (dsp, tracker, wav, packing, storage via fake-indexeddb)
```

Data flow: mic → AudioWorklet → main thread `PitchTracker` (downsample, YIN, median filter) → `PitchFrame { time, freq, midi, clarity, rms }` → `PianoRoll.push()` → canvas drawn on each `requestAnimationFrame`.
While recording, the same blocks and frames are also collected into a take. On Stop the take is saved to IndexedDB and opened in playback mode.

Shortcuts: **R** = record/stop, **T** = auto-tune on/off, **Space** = play/pause and **A** = original/tuned (playback mode).

## Commands

```bash
npm install
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # type-check + production build
npm test           # vitest unit tests
npm run dev:lan    # HTTPS dev server on the LAN (phone mic testing; accept the cert warning)
npm run preview:lan # build + HTTPS preview on the LAN
npm run icons      # regenerate public/icons/*.png
```

- The **Demo tone** button feeds a synthetic gliding voice-like tone through the same pipeline, for testing without a microphone.
- Microphone access needs a secure context: localhost is fine; a phone on the LAN needs HTTPS (handled in a later phase).
- `.claude/launch.json` defines `recorder-dev` for Claude's browser pane. The pane **blocks the microphone**, so use the Demo tone there. Real mic testing happens in the user's own browser.

## Conventions

- Keep the DSP in `src/dsp/` pure (no DOM or Web Audio) so it can be unit-tested.
- Prefer small, focused modules. No framework until the UI needs one.
- Colors and theme values live in `src/ui/colors.ts` and in CSS variables in `style.css`.
- Every new DSP function gets a vitest test using synthesized signals (sines, sawtooths, glides).
- Update the checklist below when a task is finished.

## Checklist

### Phase 0 — Setup
- [x] Analyze Goal.mp4 and write the feature spec
- [x] Choose platform and timing model
- [x] CLAUDE.md with spec, decisions and checklist
- [x] Vite + TypeScript + Vitest scaffold

### Phase 1 — Live visualizer ("This is my voice")
- [x] YIN pitch detector + unit tests
- [x] Note math (freq↔MIDI, names) + unit tests
- [x] Downsampler + unit tests
- [x] AudioWorklet capture + mic input
- [x] Demo-tone source for testing without a mic
- [x] PitchTracker: ring buffer, hop scheduling, RMS gate, median smoothing
- [x] Piano-roll canvas: keyboard with C labels, colored semitone lanes, playhead
- [x] Glowing scrolling pitch line with gaps for unvoiced parts and a head dot
- [x] Highlight the current note's key and lane
- [x] Vertical auto-follow so the voice stays in view
- [x] Readout of the current note name, Hz and cents
- [ ] Verify with a real microphone (user)

### Phase 2 — Recorder
- [x] Record button: capture raw PCM alongside the pitch frames
- [x] Stop → save the recording (audio + pitch track) to IndexedDB
- [x] Recordings list: name, date, duration, delete
- [x] Playback with the pitch line replayed in sync (scrubbing)
- [x] Export the original as WAV
- [x] Rename recordings inline; recordings survive reloads
- [ ] Verify recording with a real microphone (user)

### Phase 3 — Auto-tune visuals
- [x] Quantize to the nearest note → staircase line in the lane color
- [x] Light up the target key and lane
- [x] Scale picker (Chromatic, Major/Minor in any key, …); grey out non-scale keys and drop their lanes; show note letters
- [x] Retune-speed knob (0–400 ms) controlling the glide toward the target
- [x] Show original (faded) and corrected lines together
- [x] Readout shows the target note and how far off the singing was; chip on the roll shows scale + retune
- [x] Tuning prefs saved; applies live and to open recordings

### Phase 4 — Auto-tune audio
- [x] Pitch-mark detection (cycle boundaries) from the pitch track
- [x] TD-PSOLA pitch shifting to the corrected curve (tests: ±1–3 semitones within 5¢, steady level, vibrato flattened)
- [x] Render the tuned version in a Web Worker, A/B play original vs tuned
- [x] Export the tuned version as WAV
- [x] Unvoiced passthrough (exact), formant-preserving grains, normalized transitions
- [ ] Listening test with real vocals (user); tune grain/mark parameters if artifacts appear

### Phase 5 — Polish & stretch
- [x] PWA: manifest, icons, build-time service worker (checked offline with the server stopped), Install button
- [x] HTTPS dev/preview for LAN testing (`dev:lan`, `preview:lan`)
- [x] Harmonizer: diatonic 3rd/5th/octave voices, mix slider, lines + lit keys per voice, peak limiter
- [x] Explainer captions and headings in the video's style
- [ ] Deploy to an HTTPS host (e.g. GitHub Pages) so the PWA can be installed on a phone (ask the user first: this publishes the app)
- [ ] Harmony from played keys (Jacob Collier style), once live processing exists

### Phase 6 — Clean-up & effects (next; user asked for noise cancelling "and etc.")
- [ ] Mic option: browser noise suppression / echo cancellation toggle (quick win, live)
- [ ] Spectral noise reduction: learn a noise profile from the recording's quiet parts, then STFT Wiener-style gain with smoothing (offline, in the worker, before PSOLA)
- [ ] Noise gate / expander using the pitch tracker's silence detection
- [ ] High-pass (rumble) + de-esser + gentle compressor
- [ ] Reverb / echo presets (offline convolution)
- [ ] Original / Cleaned / Tuned comparison and export
- [ ] Later: real-time auto-tune monitoring (needs low-latency streaming PSOLA)
