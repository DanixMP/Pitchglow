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
- **Modes** (`src/main.ts`): `idle`, `listening` (live line, nothing saved), `recording` (live line + saving), `playback` (a saved recording is open and the roll follows `Player.currentTime`).

## Architecture

```
src/
  main.ts                 controller: modes, buttons, recording/saving, playback, render loop
  style.css
  dsp/
    yin.ts                YIN pitch detector (pure, unit-tested)
    notes.ts              freq <-> MIDI, note names, scales
    resample.ts           low-pass + decimate to the analysis rate
  audio/
    capture-worklet.ts    AudioWorkletProcessor: forwards input blocks
    audio-input.ts        mic / demo-tone sources -> worklet -> callback
    pitch-tracker.ts      ring buffer + hop scheduling -> PitchFrame stream
    sample-buffer.ts      collects PCM blocks during a take
    player.ts             AudioBuffer playback: play/pause/seek + latency-compensated clock
    wav.ts                16-bit PCM WAV encoder
  storage/
    recording-store.ts    IndexedDB: list/save/load/rename/delete recordings
    pitch-track.ts        pack/unpack PitchFrame[] <-> typed-array columns
  ui/
    piano-roll.ts         canvas renderer: keyboard, lanes, glowing line; live + playback modes, drag to scrub
    recordings-list.ts    recordings list (play, rename inline, WAV export, delete)
    colors.ts             lane/key color palette
    format.ts             time formatting
tests/                    vitest unit tests (dsp, tracker, wav, packing, storage via fake-indexeddb)
```

Data flow: mic → AudioWorklet → main thread `PitchTracker` (downsample, YIN, median filter) → `PitchFrame { time, freq, midi, clarity, rms }` → `PianoRoll.push()` → canvas drawn on each `requestAnimationFrame`.
While recording, the same blocks and frames are also collected into a take. On Stop the take is saved to IndexedDB and opened in playback mode.

Shortcuts: **R** = record/stop, **Space** = play/pause (playback mode).

## Commands

```bash
npm install
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # type-check + production build
npm test           # vitest unit tests
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
- [ ] Quantize to the nearest note → staircase line in the lane color
- [ ] Light up the target key and lane
- [ ] Scale picker (Chromatic, Major/Minor in any key, …); grey out non-scale keys and drop their lanes; show note letters
- [ ] Retune-speed knob (0–400 ms) controlling the glide toward the target
- [ ] Show original (faded) and corrected lines together

### Phase 4 — Auto-tune audio
- [ ] Pitch-mark detection (cycle boundaries) from the pitch track
- [ ] TD-PSOLA pitch shifting to the corrected curve
- [ ] Render the tuned version, A/B play original vs tuned
- [ ] Export the tuned version as WAV
- [ ] Quality pass: formants, transitions, unvoiced passthrough

### Phase 5 — Polish & stretch
- [ ] PWA (manifest, service worker, install on phone), HTTPS dev for LAN testing
- [ ] Harmonizer: several pitch-shifted voices / chord from the keys
- [ ] Explainer captions and headings in the video's style
