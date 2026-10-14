# Recorder — Voice Recorder + Auto-Tune with Piano-Roll Visualization

## Goal

A web app that records your voice and shows it as a glowing **pitch line moving across piano-key lanes**. It then **auto-tunes** the recording so it snaps to the notes of a scale you pick.

The visual and UX reference is **`Goal.mp4`** (vertical video, 1:45) in the project root. When unsure how something should look or behave, match the video. The video is third-party content: it lives only in the local project folder (gitignored, removed from the git history before the first push), so this description is the spec of record.

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
- **Noise reduction** (`src/dsp/denoise.ts`) runs offline before tuning:
  - STFT with ~43 ms Hann frames (2048 at 48 kHz), 75% overlap, Hann synthesis, normalized by 1.5. Long frames are what let it remove noise *between* a voice's harmonics; 21 ms frames only managed about +3 dB in voiced parts.
  - The noise profile is the average power of the quietest 15% of frames that overlap the signal (so digital silence counts, and a clean take passes through).
  - Per bin: a decision-directed Wiener gain (α 0.96, 1.5× over-subtraction), smoothed across 3 bins, floored at −amountDb.
  - If there are fewer than 18 frames, it doesn't run and reports "Too short to learn the noise".
  - Measured on a demo take at 12 dB: noise floor −12 dB, voice −0.5 dB. In tests: about +9 dB SNR, and the voice keeps 97% of its level.
- **Processing chain** (`src/dsp/process.ts`): denoise, then `renderWithHarmony`, all in the worker. The worker caches the last denoise output (keyed by recording id and amount), so re-tuning doesn't re-denoise. `ProcessSettings = { denoise, tune }`. The A/B switch and export are labelled Tuned, Cleaned or Clean + tuned.
- **Mic noise filter:** `AudioInput.start(kind, { noiseSuppression })` uses the browser's live WebRTC filter. It's baked into new recordings, so it's locked during a take. Toggling it while listening restarts the mic.
- **Demo source** adds faint room hiss (~−35 dBFS, to the recording only), so noise reduction can be tried without a mic.
- **Songs (projects) & tracks** (`src/project/model.ts`, pure + tested):
  - A `Project` has `tracks: Track[]`. A vocal track points at a library take (`takeId`) and carries its own `gainDb`, `pan`, `mute`, `solo`, `offset`, `pitch`, `tuning`, `cleanup` and `hue`.
  - Songs are small JSON documents in the IndexedDB store `projects`, saved 400 ms after the last change.
  - Deleting a take removes its tracks from every song (the confirm dialog says which).
- **Inspector binding:**
  - With no song open, the inspector edits the global defaults (localStorage).
  - With a song open, `Session` stashes the global defaults and loads the **selected track's** settings into `store.tuning`/`cleanup`. `settingsChanged()` writes edits back to that track; it compares with JSON first, so selecting a track doesn't count as an edit.
  - With a song open but no track selected, the inspector edits the stashed defaults used for new tracks.
  - Closing the song restores the globals. The mic noise filter stays global.
- **Song playback:**
  - `MixPlayer` (which replaced `Player`) runs one `AudioBufferSource → Gain` lane per track into a master gain, started on the same audio frame (20 ms lead), with each track at its `offset`. `scheduleTrack()` in the model does the alignment math.
  - Gain, mute and solo changes are live (`setGain`). A track's processed render arriving calls `setTracks` again, which keeps position and play state.
  - Each track renders on its own worker **channel** (latest-wins per track). The worker keeps an LRU of 8 cleaned takes.
  - Recording while a song is open adds the take as a new vocal track. The mix exports through `OfflineAudioContext` (`src/audio/mixdown.ts`) as a stereo WAV with a safety limiter; Phase 10 replaces this with the full master strip.
- **Instrumentals (Phase 9):**
  - "Import beat" (Songs header = new song; Tracks header = into this song) or drop an audio file anywhere. Limits: 80 MB, 15 min.
  - The original bytes are stored in the `assets` store (`Asset { id, name, type, data: ArrayBuffer }`), and the file is decoded with `decodeAudioData` on the shared context when the song opens. The decoded stereo `AudioBuffer` goes straight into the mix (`MixTrackSpec.buffer`).
  - An instrumental track (`kind: 'instrumental'`, `hue −1`) sits first, starts at −3 dB, has no auto-tune or clean-up, and can't take over the inspector. Replacing or removing it deletes the asset once no song uses it.
- **Key/tempo detection** (`src/dsp/analyze.ts`, run in the worker):
  - **Key:** a chroma of 55 Hz–2 kHz (4096-point FFT at ~11 kHz, per-frame normalized) correlated with the 24 Krumhansl–Kessler profiles. It's offered when r > 0.5.
  - **Tempo:** a spectral-flux onset envelope (11.6 ms hops), autocorrelation over 60–200 BPM with a log-normal prior at 110 BPM, and parabolic refinement. It's kept when the peak/mean ratio is > 1.3.
  - The BPM is stored on the song (used by the count-in). The key is offered in a banner, and `applyKey` switches every vocal track's auto-tune on in that key (the stashed defaults too). The roll's `setScaleHint` shows the key's lanes even with auto-tune off.
- **Recording over the beat:**
  - **One shared `AudioContext`** (`src/audio/context.ts`) is used for the mic and playback. The capture worklet stamps each 512-sample block with its context frame (`currentFrame`).
  - Record in a song with audible tracks: an optional one-bar count-in (`scheduleClicks`), then `MixPlayer.play(at)`, which returns the exact start time.
  - `alignTake` (`src/audio/sync.ts`): offset = songPos + (firstSampleTime − playStart) − latency + nudge. Latency = the calibrated round trip if set, else `outputLatency + baseLatency` + the mic's `getSettings().latency` (default 10 ms).
  - Offsets can be negative (the count-in sits before the song); the player and mixdown skip the head.
  - Verified in the app: a demo take recorded with a 96 BPM count-in landed at −2.699 s, against −2.69 s predicted.
- **Latency calibration:** plays 6 clicks through the speakers and finds each onset in the mic signal (`detectClickLatency`, median). The result is stored as `input.calibratedMs`. Input prefs (`recorder.input` in localStorage): `countIn`, `nudgeMs` (±200), `calibratedMs`.
- **Roll in a song:** the selected track is drawn normally (frames shifted by its offset), and the other vocal tracks are drawn as **ghost lines** in their track colour (`PianoRoll.setGhosts`).
- **IndexedDB (`recorder`):**
  - Stores: `meta` + `data` (takes), `projects`, `assets` (Phase 9).
  - `RecordingStore.open()` first opens at the current version. If it's below `DB_VERSION` or any required store is missing (an interrupted upgrade), it re-opens at version + 1, which runs the additive, idempotent upgrade.
  - Connections close on `versionchange`, so another tab can't block an upgrade.
  - (This healed a real dev DB that was stuck at "v2 without projects" after a hot reload landed between two edits.)
- **Effects (Phase 11):**
  - **Offline (worker, part of the track's processed render):** gate → auto-tune/harmony + **transpose** → de-esser (`src/dsp/dynamics.ts`, `process.ts`).
    - The transpose is track `pitch` + song `keyShift`, added to the *corrected* curve, so harmonies move with it and auto-tune still snaps in the sung key before shifting.
    - The gate opens on voiced frames or anything 10 dB over the noise floor, with 5 ms attack, 50 ms release and 80 ms hold.
    - The de-esser splits at 5.5 kHz (zero-phase) and turns the high band down where it dominates.
  - **Instrumental key shift:** phase vocoder (`src/dsp/vocoder.ts`: 2048/512 STFT, identity phase locking, then Catmull-Rom resample), run in the worker. It's cached per `assetId|semitones`; the original plays until the shifted version is ready. It's accurate to ~5 cents, at about 0.5× realtime per channel. A future 2× speed-up would pack L/R into one complex FFT.
  - **Live (`src/audio/chain.ts`, same graph for playback and export):**
    - Per track: high-pass → low-shelf 200 Hz / peak 2.5 kHz / high-shelf 8 kHz → compressor (amount 0..1 sets threshold −6…−30 dB and ratio 1…8) → fader → pan, with post-pan sends.
    - Song buses (`FxBuses`): a reverb `ConvolverNode` using generated IRs (`src/dsp/reverb.ts`: Room/Plate/Hall/Cathedral, seeded noise with damping, cached), and an echo `DelayNode` with a low-pass feedback loop, tempo-synced (`echoSeconds`).
    - Exports add a tail (`fxTail`) when any track sends.
  - **Model:** `src/project/fx.ts` holds `TrackFx` (`track.fx`), `SongFx` (`project.fx`), the presets (Clean pop, Radio, Dreamy, Robot; Robot also sets 0 ms auto-tune) and `trackProcessSettings()` (`app/processing.ts`). A manual edit turns the preset into "Custom". All FX edits are undoable and coalesced per control.
  - **The roll draws the song as heard:** tracks are transposed by pitch + key shift, and the scale/hint moves with them.
  - **Verified in the app:**
    - Dreamy adds a tail of RMS 0.013 after the soloed vocal, where the dry export is 0.
    - Key shift +2 moved the beat's bass from 110.0 to 123.3 Hz (123.5 expected); undo brings back 110.0.
    - Robot sets 0 ms. Gate and pitch re-render the track; EQ is live.
- **Polish (Phase 12):**
  - **Loop region** (`project.loop = { start, end, on }`, saved with the song, not an undo step):
    - Draw it by dragging along the timeline ruler (snaps to beats with a BPM, else 0.1 s; Alt = free). Drag its edges to resize it, its middle to move it; a plain click on the ruler still seeks.
    - The Loop button in the transport, or **L**, toggles it. The first time, it makes 2 bars (or 4 s) around the playhead (`defaultLoop`).
    - `MixPlayer.setLoop`: the first pass runs from the playhead to the loop end, then whole passes are scheduled back to back on the audio clock, 1.5 s ahead (`fillLoop`), so it keeps looping in a throttled background tab. Clips cut by a boundary get 4 ms fades. `currentTime` wraps with `loopPosition()`.
    - Looping is off while a take is recorded over the song (the take is linear) and comes back afterwards (`Session.syncLoop`). Exports always render the whole song.
  - **Song files** (`src/project/package.ts`): **`.recsong`** = a stored ZIP containing:
    - `song.json` (format, version, project, take metas, asset info);
    - `takes/<id>.wav` (32-bit float, lossless) and `takes/<id>.pitch` (`serializePitch`);
    - `assets/<id>.<ext>` (the original beat file).
    - Save: the download icon on a song. Open: the Songs "Import" button or a drop anywhere (a `.recsong` always opens as a new song).
    - Import gives the song a new id and a free name ("X (2)"). Takes and beats already on this device (same UUID) are reused, not duplicated. `readZip` reads stored entries only and checks CRCs.
  - **MP3 export:**
    - A WAV/MP3 format select sits next to the export button (`state.exportFormat`, saved in `localStorage['recorder.exportFormat']`). It applies to take exports, processed takes and the mix; stems stay WAV.
    - `src/audio/encode.ts` → a short-lived `mp3-worker.ts` running **LAME via `@breezystack/lamejs` (LGPL-3.0)**, unmodified, in its own build chunk, loaded only when exporting MP3. See `THIRD_PARTY_NOTICES.md`.
    - Bitrates: 192 kbps stereo, 128 kbps mono. Rates MP3 can't carry are resampled to 48 kHz.
    - Verified: a 15.1 s mix → a valid 354 KB MPEG-1 L3 file.
  - **Onboarding** (`ui/panels/onboarding.ts`, texts in `STUDIO_TIPS`): one-time captions when a song first opens, a beat is in, the song has 2+ tracks, the loop goes on, or the key is shifted. They are shown only in playback mode and queued with `Captions.enqueue`, so they never cut each other off. Seen tips are kept in `localStorage['recorder.tipsSeen']` (delete it to see them again).
- **Real-time voice engine (Phase 13)** (`src/dsp/voice-engine.ts`, `src/audio/engine/`):
  - **A generator, not a causal stream.** During playback the whole take is known, so the engine renders whatever song position the transport asks for. No look-ahead or latency compensation is needed, seeks and loops are instant, and the output is **bit-identical** to the offline render.
  - **PSOLA is split into three steps** (`psola.ts`):
    - `analyzePsola`: voiced regions + analysis marks. Depends only on the audio and its pitch track, so it's computed once per take in the worker.
    - `planGrains`: the grain list (source centre → output centre, half-length) for one correction curve.
    - `renderGrains`: overlap-adds any output range; Hann weights come from a lookup table, not a `Math.cos` per sample. Block-by-block rendering equals whole-take rendering (tested).
    - The old `renderTuned` is now plan + full-range render; it was checked bit for bit against the previous implementation.
  - `planVoices` gives the lead and harmony plans: auto-tune in the sung key, then the transpose (track pitch + key shift).
    - Harmony plans are **voiced-only**: silent in breaths and "s" sounds, fading out at note edges. They used to copy the unvoiced audio once per voice, stacking sibilants. They are mixed at `mix/√voices`; the per-track limiter is gone live, since the master limiter catches peaks. Take exports still limit.
  - **Worker (`render-worker.ts`, `voice` requests per track channel):**
    - It runs `prepareVoice` only when the clean-up input changes (key = take + denoise/gate/de-ess + rate): denoise → gate → **de-ess** (moved before tuning; sibilants are unvoiced, so PSOLA passes them through anyway) → resample to the context rate. Then it runs `analyzePsola` and, on every request, `planVoices`.
    - Requests that pile up are merged, so a knob drag plans only the latest value. The response carries the source only if the main thread's version is stale. Plans are transferred.
    - Measured: plan round trip 7–44 ms; re-planning a 3-min take with 3 harmonies takes 60–140 ms (which is why it runs in the worker).
  - **Worklet (`engine-worklet.ts`, processor `voice-engine`):**
    - One node per vocal lane; it holds the source + plans (`VoiceRenderer`, no allocations while rendering).
    - Messages (`protocol.ts`): `source`, `plans`, `offset`, `play {startFrame, from, loop}`, `stop`.
    - `transport.ts` (pure, tested) maps each context frame to a song position, splits blocks at loop wraps and applies 4 ms fades where a loop cuts a clip, mirroring MixPlayer's buffer lanes.
  - **MixPlayer:**
    - Buffer lanes (instrumentals) as before; engine lanes for every take (song tracks and the single-take preview).
    - `setPlans` swaps plans without a gap. `setTracks` posts source/plans/offset changes. `play` posts the transport, `stop` silences.
    - `loadEngine()` runs in `Session.init`. Takes at another rate are resampled once (`atRate`) and played without plans until the prepared source arrives.
  - **Session:**
    - `Voice { source, version, sentKey, plans }` per preview/track, updated by `updateVoice`. Clean-up changes are debounced 120 ms and show "Processing…"; plan-only changes go out immediately with no busy flag.
    - `mixSpecs` gives the cleaned source + plans when listening to the processed version, else the raw take with no plans (A/B).
    - The preview autoplays once its first plans arrive (~170 ms).
  - **Export = same engine:** `renderMix`/`renderStems` load the worklet into the `OfflineAudioContext` and create engine nodes with the transport at 0; `renderVoice` exports a processed take. Export rate = the context rate (the plans' rate).
    - Verified in the app: the engine export of a take (0 ms auto-tune + a harmony + limiter) is **identical** (max difference 0) to the offline reference `processRecording`.
  - **CPU** (OfflineAudioContext, 8 tracks): the mix chain alone is 31% of a core. Engine lanes add ~0.6% per track for the lead and ~0.4% per harmony voice, so 8 tracks × lead + 3 harmonies ≈ 46% in total.
  - **Dev hook:** `window.recorder = { store, session }` in `npm run dev` only, for console checks.
- **Modes** (`AppState.mode`, driven by `Session`): `idle`, `listening` (live line, nothing saved), `recording` (live line + saving), `playback` (a saved recording is open and the roll follows `Player.currentTime`).

## Architecture

```
src/
  main.ts                 entry: creates store + session + panels; shortcuts; frame loop (wiring only)
  style.css               studio shell (3 cols / drawer / tabs) + components
  pwa.ts                  service-worker registration + Install button
  app/
    store.ts              tiny typed store: get / set(patch) / subscribe / watch(selector, cb, {shallow})
    state.ts              AppState (mode, source, tuning, cleanup, takes, openId, A/B, render, layout) + createAppStore
    session.ts            engine: live input + tracker, takes, songs/tracks (open, select, mix, record into),
                          MixPlayer, per-track worker renders, mix export; owns buffers/nodes, publishes state
    processing.ts         pure: prefs -> TuneSettings/ProcessSettings, processed label, title cards
    explain.ts            pure: caption texts
  dsp/
    yin.ts                YIN pitch detector (pure, unit-tested)
    notes.ts              freq <-> MIDI, note names
    scales.ts             scale types, masks, nearest in-scale note
    autotune.ts           PitchCorrector: target note + retune-speed glide
    psola.ts              TD-PSOLA: analysis (marks) -> grain plan -> range render (shared by offline and the engine)
    voice-engine.ts       voice plans (lead + harmonies) + VoiceRenderer: block rendering for the real-time engine
    harmony.ts            diatonic harmony voices + mixed render (renderWithHarmony)
    limiter.ts            look-ahead peak limiter
    fft.ts                radix-2 complex FFT
    denoise.ts            STFT Wiener noise reduction (noise profile from quiet frames)
    process.ts            prepareVoice (denoise -> gate -> de-ess -> rate) + processRecording (offline reference)
    analyze.ts            key (chroma + Krumhansl) and tempo (onset autocorrelation) of instrumentals
    vocoder.ts            phase-vocoder pitch shift (identity phase locking) for instrumentals
    reverb.ts             generated impulse responses (Room, Plate, Hall, Cathedral)
    dynamics.ts           offline noise gate (pitch-tracker driven) and split-band de-esser
    resample.ts           low-pass + decimate to the analysis rate
  audio/
    context.ts            the shared AudioContext (mic + playback on one clock) + output latency
    capture-worklet.ts    AudioWorkletProcessor: forwards input blocks stamped with their context frame
    audio-input.ts        mic / demo-tone sources -> worklet -> callback
    pitch-tracker.ts      ring buffer + hop scheduling -> PitchFrame stream
    sample-buffer.ts      collects PCM blocks during a take
    mix-player.ts         multi-track playback: buffer lanes (beats) + voice-engine lanes (takes), live plans/gain/pan/fx, loop, clock
    mixdown.ts            OfflineAudioContext mixdown/stems/processed take through the same graph and engine
    sync.ts               take alignment math, click-loopback latency detection, count-in times
    metronome.ts          scheduled click sounds
    render-worker.ts      Web Worker: voice requests (clean-up + analysis + plans per track), key/tempo, key shift
    engine/
      engine-worklet.ts   AudioWorklet 'voice-engine': renders a take from source + plans, follows the transport
      protocol.ts         engine messages + construction options (shared with the main thread)
      transport.ts        pure: context frame -> song position, loop runs, loop fades
    tuned-renderer.ts     main-thread client for the worker (voice: per-channel latest-wins; analyze; shift)
    wav.ts                16-bit PCM WAV encoder (mono or interleaved multi-channel); float WAV encode + WAV decode (song files)
    encode.ts             export encoding: WAV, or MP3 via mp3-worker.ts (LAME, LGPL, own chunk)
    mp3-worker.ts         Web Worker: lamejs MP3 encoder
    zip.ts                stored ZIP writer + reader (stems, song files)
  project/
    model.ts              Project/Track types + pure helpers (create, duplicate, update, effective gain, scheduling, transpose)
    fx.ts                 TrackFx / SongFx, presets, echo timing
    history.ts            undo/redo snapshots with drag coalescing
    package.ts            .recsong song files: pack/unpack (project + takes + beat), import id/name handling
  storage/
    recording-store.ts    IndexedDB: takes + projects; self-healing open/upgrade
    pitch-track.ts        pack/unpack PitchFrame[] <-> typed-array columns; columns <-> bytes
    settings.ts           tuning + clean-up prefs in localStorage
  ui/
    dom.ts                $ / $$ helpers
    piano-roll.ts         canvas renderer: keyboard, lanes, glowing line; live + playback modes, drag to scrub
    timeline.ts           clip lanes with waveforms, drag/nudge clips, seek; loop region on the ruler
    recordings-list.ts    takes list items (play, rename, export, delete; + / drag into the open song)
    icons.ts              shared SVG icons, icon buttons, inline name inputs, take drag MIME type
    knob.ts               rotary knob (drag, wheel, arrows, double-click to reset)
    captions.ts           word-by-word explainer captions over the roll
    colors.ts             lane/key color palette
    format.ts             time formatting
    panels/               each mounts onto existing markup, renders from the store, calls Session actions
      layout.ts           phone tabs, tablet takes drawer (inert when closed, focus return)
      header.ts           title cards / take name / recording timer
      live-controls.ts    Listen / Record, status line, first-run intro caption
      input-panel.ts      Mic / Demo tone, mic noise filter
      transport.ts        play/seek/time, Original vs processed A/B, processed export
      readout.ts          note under the playhead
      songs-panel.ts      songs list: new, open, rename, duplicate, delete
      takes-panel.ts      takes library + search, add-to-song
      tracks-panel.ts     track rows (keyed, updated in place): select, rename, M/S, fader, remove; drop zone
      import-panel.ts     Import beat buttons, file drop overlay, key/BPM detection banner
      tuning-panel.ts     Auto-tune + Harmony sections
      cleanup-panel.ts    Noise reduction section
      fx-panel.ts         Effects (track) and Song FX (key shift, reverb, echo) sections
      onboarding.ts       one-time studio tips (captions) when features first come up
public/                   manifest, icon.svg, icons/*.png (generated)
scripts/make-icons.mjs    procedural icon renderer (no deps)
vite.config.ts            base './', LAN HTTPS mode, build-time service worker
tests/                    vitest unit tests (dsp, tracker, wav, packing, storage via fake-indexeddb, store/processing)
```

**UI rule:** panels never talk to each other. They read state from the store and call `Session` (engine) actions or `store.set`. Prefs persistence and re-rendering on tuning/clean-up changes are wired once in `main.ts`.

**Layout:**
- ≥1100 px: three grid columns (Takes 240–300 | center | Inspector 300–360).
- 760–1099 px: center + inspector, with Takes as a slide-in drawer (☰ button, Esc/backdrop to close).
- <760 px: the center fills the screen, and a bottom tab bar (Takes · Controls) opens a panel under the roll (max 44dvh); tapping the open tab collapses it.
- The page itself never scrolls; columns scroll independently.

Data flow: mic → AudioWorklet → main thread `PitchTracker` (downsample, YIN, median filter) → `PitchFrame { time, freq, midi, clarity, rms }` → `PianoRoll.push()` → canvas drawn on each `requestAnimationFrame`.
While recording, the same blocks and frames are also collected into a take. On Stop the take is saved to IndexedDB and opened in playback mode.

Shortcuts: **R** = record/stop, **T** = auto-tune on/off, **Space** = play/pause and **A** = original/tuned (playback mode), **L** = loop on/off (song open), **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** = undo/redo (song open).

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

### Phase 6 — Clean-up & effects (user asked for noise cancelling "and etc.")
- [x] Mic option: browser noise suppression toggle (live; locked while recording)
- [x] Spectral noise reduction: noise profile from quiet frames, STFT Wiener gain, Amount slider, cached in the worker, chained before auto-tune
- [x] A/B + export generalized: Original vs Cleaned / Tuned / Clean + tuned
- [ ] Listening test of noise reduction on real mic recordings (user); tune the frame size/α/over-subtraction if voices sound watery
- [ ] Noise gate, high-pass, de-esser, compressor, reverb/echo → moved to **Phase 11 (Effects)** so they live in the studio's per-track FX chain
- [ ] Later: real-time auto-tune monitoring (needs low-latency streaming PSOLA)

---

## Roadmap v2 — "Studio" (planned 2026-10-14)

The user asked for pitch and reverb effects, a remix-studio style mixer, importing instrumentals to sing over, and a better UX: a three-column layout with the piano roll in the middle.

### Decisions (from the user)
- **Song model:** a *project* holds **1 instrumental + any number of vocal tracks** (lead, doubles, harmonies, ad-libs). Each track has its own volume, pan, mute/solo, auto-tune, clean-up and FX. Today's recordings become **takes** that get placed on tracks.
- **Pitch:** both a **master key shift** (±12 semitones; moves the instrumental and the vocals, and the auto-tune scale follows it) and a **per-track pitch offset** (e.g. an octave-up double).
- **Layout:** at ≥1100 px, **three columns**: Takes/Projects | piano roll + transport + mixer | Controls/Inspector. On a phone, the piano roll and transport stay on top and a **bottom tab bar** (Takes · Mixer · FX) switches the panel below. A tablet gets two columns, with Takes as a slide-in drawer.
- **Order:** layout first, so every new feature lands in its final place.

### Technical decisions
- **Offline per-track processing, live mixing.**
  - Heavy, per-take work runs in the worker and produces one processed buffer per track: denoise → auto-tune/harmony → pitch offset.
  - Mixing is a live Web Audio graph, so faders, pan, mute/solo and FX sends react instantly: source → Gain → StereoPanner → (sends) → master Gain → limiter → destination.
  - **Export** renders the same graph in an `OfflineAudioContext` and writes a stereo WAV.
- **Instrumental storage:** keep the **original compressed file** (mp3/m4a/wav Blob) in IndexedDB and decode with `decodeAudioData` when a project opens. Storing decoded stereo Float32 would be about 90 MB for 4 minutes.
- **Pitch-shifting instrumentals:** PSOLA is only for a single voice. Polyphonic material needs a **phase vocoder with identity phase locking** (time-stretch, then resample), written by us. Avoid GPL libraries (Rubber Band); SoundTouch is LGPL. Expect good quality up to about ±4 semitones.
- **Key and tempo detection on import:** chroma features plus Krumhansl–Schmuckler key profiles → "Detected A minor, use it for auto-tune?". BPM from autocorrelation of the onset envelope, used for tempo-synced echo and a grid.
- **Recording over the beat:**
  - Play the project, minus the track being recorded, while recording.
  - Align the take using the measured round-trip latency (`outputLatency` + `baseLatency` + the track's `getSettings().latency`), plus a manual **nudge** (±200 ms) and an optional click-loopback calibration.
  - Recommend wired headphones; Bluetooth adds 150–300 ms of variable latency.
- **Reverb:** a shared **reverb bus**, i.e. a `ConvolverNode` fed by per-track sends. Impulse responses are generated algorithmically (decaying filtered noise, pre-delay, damping): Room, Plate, Hall, Cathedral. Echo is a `DelayNode` with feedback and a filter, tempo-synced (1/4, 1/8, dotted 1/8).
- **Code structure:** `main.ts` (~900 lines) gets split before the studio grows. A small typed **store** (state + subscribe) holds project, track, selection and transport, and panels become modules that render from it: `ui/layout`, `ui/takes-panel`, `ui/inspector`, `ui/mixer`, `ui/transport`.
- **IndexedDB v2 migration:** new stores `projects` (with embedded track list) and `assets` (imported files). The existing `meta`/`data` stores stay as the takes library, so no data is lost.

### Phase 7 — Studio layout (3 columns + mobile tabs)
- [x] Split `main.ts` into a store + panel modules, with no behavior change; all tests still pass (80; regression-checked record → save → A/B → rename → re-tune → delete)
- [x] CSS grid shell: Takes | Center (header, roll, transport) | Inspector, at the ≥1100 / 760–1100 / <760 px breakpoints
- [x] Left: takes library (search, rename, delete, export) in a scrolling column
- [x] Right: inspector with collapsible sections (Input, Auto-tune, Harmony, Clean up); controls sized for a column
- [x] Center: compact header (take name + title card), roll fills the available height, transport bar under it
- [x] Phone: roll on top, bottom tab bar (Takes · Controls; Mixer joins in Phase 10), readout hidden while a panel is open, safe-area aware
- [x] Keyboard and a11y: landmarks (main/aside/nav), drawer `inert` when closed + focus return, Esc closes, shortcuts unchanged; geometry checked at 1440/1100/900/390 px
- [ ] Look at it on a real desktop, tablet and phone (user); the Claude browser pane is too small for full-size screenshots

### Phase 8 — Projects & tracks
- [x] IndexedDB v2+: `projects`, `assets`; migration keeps all existing takes (tested: v1 → v2, partial "v2" healed, fresh DB)
- [x] Songs list (new/rename/duplicate/delete) in the left column; opening a song shows its tracks in the center
- [x] Track model: kind (vocal/instrumental), source (take/asset), name, gain dB, pan, mute, solo, offset s, pitch offset, tuning, clean-up, hue
- [x] Add a take to a song as a vocal track (+ button, or drag from the takes list onto the tracks); recording while a song is open adds a track
- [x] The inspector edits the **selected track** (tuning, harmony, clean-up per track); globals stashed and restored on close
- [x] Piano roll shows the selected vocal track; other vocal tracks are faded ghost lines in their colours
- [x] Multi-track playback in sync (MixPlayer) with live mute/solo/volume; basic stereo mix export (Mix WAV)
- [ ] Try it on real recordings (user): several takes in one song, solo/mute, per-track auto-tune

### Phase 9 — Instrumental import & singing over the beat
- [x] Import an instrumental: file picker + drop anywhere (mp3/wav/m4a/ogg/flac/webm), 80 MB / 15 min limits, original bytes stored
- [x] Decode on the shared context; stereo `AudioBuffer` played and mixed directly
- [x] Key + BPM detection in the worker; banner offers the key for auto-tune (switches every vocal track to it); BPM kept for the count-in
- [x] Record a new vocal track while the song plays (one-bar count-in option, headphones hint, ghosts lined up with what you hear)
- [x] Latency compensation: one shared clock + timestamped blocks + browser latency estimate, manual Sync nudge, loopback calibration; alignment and detection unit-tested
- [x] Piano roll shows the song key's lanes while recording (scale hint, even with auto-tune off)
- [ ] Real-world check (user): record over a real beat with headphones; calibrate with speakers; tune the nudge if takes sit early/late

### Phase 10 — Mixer (remix studio)
- [x] Shared mix chain (`src/audio/chain.ts`: gain → StereoPanner → master gain → limiter) used by MixPlayer *and* mixdown
- [x] Channel strips: fader, **pan**, mute, solo, peak **meter** (hold-and-fall, −48…0 dBFS), name, colour
- [x] Master strip: volume, limiter toggle (default on), L/R meter
- [x] Timeline (`src/ui/timeline.ts`): waveform clips per track, drag to move (snap 1/16 with BPM, 10 ms without, Alt = free), click to seek, ←/→ nudge
- [x] Export mixdown through the master; **stems** = each audible track post-fader/pan, same length, zipped (`src/audio/zip.ts`)
- [x] Undo/redo (`src/project/history.ts`, coalesces drags): buttons + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; replaced instrumentals are kept until next start (asset GC in `Session.init`) so undo can restore them
- [x] Browser-verified: meters move while playing; pan hard L → master R = 0; clip drag snapped to 13 × 1/16 at 96 BPM, one undo restores, redo re-applies; stems zip = 2 numbered 12 s stereo WAVs; strips fit at 1440 px (one row) and 398 px (two rows), no overlaps
- [x] **Limiter fix** (found by the check): `DynamicsCompressorNode` alone let +6 dB mixes clip (no look-ahead, make-up gain). Now export = master gain → **look-ahead `limitLinked`** (linked L/R, ceiling 0.98): +6 dB export peak 0.980 with 0 clipped samples (vs 5,719 off). Live = compressor (−3 dB, 1 ms) → soft-clip `WaveShaper` whose curve ends at 0.98, so live output can't exceed the ceiling either

### Phase 11 — Effects (pitch, reverb & more)
- [x] Phase vocoder (identity phase locking) for instrumental pitch shift; tests: ±1–4 st within ~5¢, level within 1.5 dB, chords
- [x] Master key shift (±6): instrumental via phase vocoder (worker, cached), vocals via PSOLA; auto-tune scale and roll follow it; undoable
- [x] Per-track pitch offset (±12, vocals via PSOLA, formant-preserving)
- [x] Reverb bus: generated IRs (Room, Plate, Hall, Cathedral), per-track send, level/tone
- [x] Echo/delay: tempo-synced (1/4, 1/8, dotted 1/8, 1/16), feedback, filtered repeats, per-track send
- [x] Vocal chain per track: high-pass, noise gate, de-esser, compressor, 3-band EQ; presets Clean pop / Radio / Dreamy / Robot
- [x] Effects work live in the mix and are rendered identically in export (shared chain + tails); browser-verified
- [ ] Speed-up: pack stereo into one complex FFT in the phase vocoder (~2×); key shift of a 4-min beat currently takes ~1 min
- [ ] Listening test on real material (user): preset voicings, reverb levels, gate/de-ess amounts

### Phase 12 — Polish
- [x] Clip/timeline view: waveforms per track, playhead (Phase 10), **loop region** (draw/resize/move on the ruler, L / Loop button, sample-accurate passes); browser-verified: 1.25–6.25 s loop at 96 BPM wraps 4.62 → 1.63 s with audio on every pass, L off plays through to the end
- [x] Song export/import as one `.recsong` file (takes lossless + pitch + original beat); round trip verified in the app (same-device import reuses the take; a "foreign" file adds 1 take + beat and renders the same mix)
- [x] MP3 export (LAME via `@breezystack/lamejs`, **LGPL-3.0**: used unmodified in its own worker chunk, notice in `THIRD_PARTY_NOTICES.md`) alongside WAV; format remembered
- [x] Onboarding captions for the studio features (song, beat, mixer, loop, key shift), once each, queued
- [ ] Real-world check (user): loop while practising, save a song on one device and open it on another, MP3 in other players

---

## Roadmap v3 — "Real-time & Neon studio" (planned 2026-10-14)

The user asked for every setting to work in real time: hearing your voice processed live while singing, and every change taking effect immediately while listening. They also asked for a UX overhaul (custom sliders with snapping, custom cursors, …) and more features.

### Decisions (from the user)
- **Real-time:** **live everywhere**. One real-time engine processes the mic while singing (monitoring) *and* the tracks during playback, so every control is instant. **Export runs the same engine** (offline), so the file sounds exactly like what was heard.
- **Look:** **Neon studio**. Keep Goal.mp4's near-black background and glowing lane colours. Custom glowing sliders and knobs, LED-style meters, smooth motion.
- **Cursor:** **context cursors**. Custom cursors only where they help: a crosshair plus note name on the roll, grab/move on clips, resize on loop edges and sliders. The system arrow elsewhere; none on touch devices.
- **Extra features:** note editing, voice character, play-the-keys harmony, metronome & grid. All four.
- **Order (proposed):** engine first, because it changes how every control behaves, so the new controls are designed around it. Then the UX overhaul, then the features.

### Technical decisions
- **Voice engine = an AudioWorklet** (`src/audio/engine/`), one instance per vocal track plus one for the mic.
  - **Playback path:** the take's analysis (pitch track + PSOLA analysis marks + noise profile) is computed once, offline in the worker, and cached. The worklet gets it via its port, and then per 128-sample block it runs: correction curve (PitchCorrector) → transpose/harmony → streaming TD-PSOLA → gate/de-ess.
    - Knob changes are port messages, applied on the next block.
    - The engine has a small fixed **look-ahead** (≈ one grain + one max period, ~30–50 ms). The player starts each processed lane earlier by that amount, so tracks stay aligned.
  - **Live path (monitoring):** streaming YIN on decimated audio in the worklet (window ≈ 2 × the longest period, ~25 ms), the same corrector + streaming PSOLA in a low-latency mode, then the same FX chain. Target: ≤ 30 ms of extra latency.
    - Monitoring is a toggle ("Hear myself — headphones"). Speakers would feed back, and Bluetooth is too slow; the UI says so.
    - Takes are still stored **dry**; all processing stays non-destructive.
  - **Export:** the same graph, worklet included, rendered in an `OfflineAudioContext`, so it is identical to playback. The current offline `processRecording` stays as the reference implementation for tests: the streaming output must match it within tolerance (pitch within ~5¢, level within 1 dB).
  - **Noise reduction:** the noise profile is learned offline per take, as today. The Wiener gain runs streaming (43 ms frames, compensated by the look-ahead). Live monitoring uses the browser's noise filter or a shorter-frame variant.
  - **Instrumental key shift:** the phase vocoder made streaming and ~2× faster (L/R packed into one complex FFT). If the CPU can't keep up, it falls back to the cached offline render.
  - **CPU:** analysis is precomputed so the worklet only synthesises; there are no allocations in `process()`. A CPU/underrun indicator is shown; harmony voices or quality are reduced automatically under load.
- **Voice character:** formant shift by resampling PSOLA grains (independent of pitch). Presets: Deeper, Younger, Chipmunk, Monster, Robot, Whisper (noise-excited).
- **Controls:** one custom `Slider` component used everywhere:
  - pointer + touch + wheel + keyboard;
  - **detents** with a magnetic snap zone (0 dB, centre pan, 0 ms, preset values), Alt = no snap, Shift = fine;
  - a value bubble while dragging, double-click to reset, full ARIA slider semantics.
  - Knobs, toggles, segmented controls and meters get the same neon treatment. Design tokens live in CSS variables; `prefers-reduced-motion` is respected.

### Phase 13 — Real-time engine (playback) — branch `realtime-engine`
- [x] Engine worklet + main-thread client; per-take analysis (PSOLA marks on the cleaned source) computed once in the worker and cached per track channel
- [x] Block rendering of PSOLA + corrector + transpose + harmony (generator design: no look-ahead needed); tests: blocks == whole take bit for bit, engine == offline `renderWithHarmony`, transport/loop maths
- [x] MixPlayer engine lanes (songs and the take preview); tuning/harmony/pitch/key-shift changes are instant: browser-verified: +12 st mid-playback heard within ~140 ms (incl. 85 ms analysis window), plan round trip 7–44 ms, playhead never restarts; loop passes play identical pitch at identical positions
- [x] Export through `OfflineAudioContext` with the same worklet (mix, stems, processed take); verified identical to the offline reference (max diff 0)
- [x] CPU measured (8 tracks × lead + 3 harmonies ≈ 46% of a core incl. the 31% mix chain); no allocations in `process()`
- [ ] Listening check (user): knob drags while playing, harmonies now voiced-only (no doubled "s" sounds)

### Phase 14 — Live monitoring (hear yourself)
- [ ] Mic → engine (streaming YIN, low-latency PSOLA) → track FX chain → headphones; "Hear myself" toggle with a headphones warning
- [ ] Live auto-tune, harmony, pitch and voice FX while listening/recording; the pitch line comes from the engine (one detector)
- [ ] Latency measured and shown (target ≤ 30 ms extra); recorded takes stay dry
- [ ] Underrun/CPU indicator and automatic quality fallback

### Phase 15 — Everything live + voice character
- [ ] Streaming noise reduction (profile from offline analysis), gate and de-esser in the engine; no re-render left for vocals
- [ ] Streaming phase vocoder for instrumental key shift (stereo-packed FFT, ~2×), with fallback to the cached render
- [ ] Voice character: formant shift + presets (Deeper, Younger, Chipmunk, Monster, Robot, Whisper)

### Phase 16 — UX overhaul ("Neon studio")
- [ ] Design tokens (colour, glow, radius, motion) + reduced-motion support
- [ ] `Slider` component: detents/snap, Alt free, Shift fine, value bubble, wheel, keys, double-click reset, ARIA; replaces every range input
- [ ] Neon knobs, toggles, segmented controls, LED meters; consistent hover/active/focus states
- [ ] Context cursors: roll crosshair + note label, clip grab/grabbing, loop/slider resize; none on touch
- [ ] Inspector/mixer/transport polish, touch targets ≥ 40 px on phones; checked at 1440/900/390 px

### Phase 17 — Metronome & grid
- [ ] Click track (playback and recording, accent, volume), tap tempo / set BPM
- [ ] Bar/beat grid on the roll and timeline; snap clips and loop to the grid
- [ ] Quantize a take's start to the nearest beat

### Phase 18 — Note editing
- [ ] Segment the pitch track into notes (stable pitch regions); draw note blobs on the roll
- [ ] Drag a note's pitch (semitone snap, Alt = cents) and timing/length (PSOLA time-stretch); per-note correction amount
- [ ] Edits stored per track (non-destructive), undoable, live in the engine and in export

### Phase 19 — Play-the-keys harmony
- [ ] Clickable on-screen piano + Web MIDI keyboard input
- [ ] Harmony voices follow held keys live (engine), voiced from the sung note
- [ ] Record key events into the track so playback/export reproduce them
