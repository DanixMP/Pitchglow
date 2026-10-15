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
  - **CPU** (OfflineAudioContext, 8 tracks, measured in the app's browser pane, which is ~5–7× slower than Chrome; see Phase 15 for real-Chrome figures): the mix chain alone is 31% of a core. Engine lanes add ~0.6% per track for the lead and ~0.4% per harmony voice, so 8 tracks × lead + 3 harmonies ≈ 46% in total.
  - **Dev hook:** `window.recorder = { store, session }` in `npm run dev` only, for console checks.
- **Hear yourself live (Phase 14):**
  - **`LiveVoice`** (`src/dsp/live-voice.ts`, pure, tested) is the causal PSOLA for the mic:
    - The PitchTracker runs inside it; each frame goes through the PitchCorrector and gives the period and pitch ratio for the lead and each harmony (short interpolated history).
    - Analysis marks are placed as soon as a whole cycle has arrived. Synthesis runs **`LIVE_DELAY_SECONDS` = 25 ms** behind the input; grains are capped at half that delay (voices down to ~80 Hz at full quality).
    - Unvoiced audio passes through the lead; harmonies are voiced-only. With no tuning and no transpose, the input passes straight through, with no delay.
    - Measured in tests: transposes within 8¢, delay exactly 25 ms, an off-key 150 Hz lands on D3 within 10¢, a harmony third audible.
  - **One worklet for the mic** (`engine/live-worklet.ts`, `live-protocol.ts`; this replaces `capture-worklet.ts`). It:
    - forwards raw 512-sample blocks stamped with context frames (takes stay dry);
    - posts every pitch frame with its context frame. The **pitch line and takes now use this one detector**; the main-thread tracker is gone, and frame times are converted to "since Listen" (roll) or "since the take's first sample" (take);
    - outputs the processed voice when monitoring.
  - **CPU estimate:** it sums the Date.now() millisecond ticks that fall inside `process()`, which is unbiased over many blocks. Above 50% load it drops a harmony voice; after a calm stretch below 20% it brings one back (`live.degraded`).
  - **Routing:** `AudioInput.setProcessing({ monitor, tune, semitones })`. `MixPlayer.setMonitor(node, fx)` sends the live voice through its own track chain (the selected track's EQ/compressor/sends → the song's reverb/echo) into the master.
    - The demo tone's direct speaker feed mutes while monitoring.
    - `Session.syncMonitor()` runs on Listen/Record, on settings/selection/key-shift/FX changes, and on the toggle.
  - **Key-shifted songs** (a fix found while building this): you sing along to the shifted beat, so monitoring auto-tunes to the shifted scale with no transpose. A take recorded into the song gets its tuning root shifted to match, **pitch = −keyShift** (so it plays back as sung; before, it was shifted twice), and the selected track's FX (what was heard).
  - **UI:** an Input section switch "Hear myself", with a hint "wired headphones only" and captions. While running it shows "≈ N ms mic to ears · CPU n%" (input latency + processing delay + one render quantum + output latency), and "fewer harmonies (CPU)" when degraded. The pref is `input.monitor`.
  - **Verified in the app (demo tone, C major 0 ms):** every monitored note in C major, median 0¢ (p90 2¢); CPU ~12% (mostly the pitch tracker, now on the audio thread); 3 harmonies audible; monitor off → processed path silent. Total 78 ms here = 50 ms reported by the browser's output + 27.7 ms processing.
- **PSOLA grain-length fix (Phase 14):**
  - Grains used to be `max(analysis period, synthesis period)` long and were normalised by the summed window weight. **Exactly an octave down, that rebuilt the input unchanged**, so the "Oct ↓" harmony and track pitch −12 had silently done nothing since they were added.
  - Grains are now two analysis periods long (classic TD-PSOLA), and the normalisation stops at a weight of 0.5 (`normalizeGrain`), so the envelope that carries the lower pitch survives.
  - The lead blends towards the source only below a weight of 0.1. There is a regression test for −12/−7 (new fundamental, level 0.5–1.3), and all the older accuracy/level tests still pass.
- **Everything live + voice character (Phase 15):**
  - **Voice character** (`src/dsp/grain-shape.ts`, `src/project/voice.ts`):
    - `GrainShaper` builds a grain's content before it is windowed. **Formant shift** reads the grain faster or slower around its centre: the pitch (grain spacing) stays and the vowel colour moves. **Whisper** keeps the grain's LPC envelope (order 24, Levinson) and excites it with seeded noise at the same windowed energy.
    - Only voiced grains are shaped. It is shared by the offline renderer, the playback engine (a `GrainCache` per voice, keyed by grain index, so blocks stay bit-exact) and `LiveVoice` (ring-buffer mode; a formant shift up may use a mark a cycle further back).
    - **Robot** = `monotoneCorrections`: each phrase is held on its first note (snapped to the scale when auto-tune is on). It uses past frames only, so live and playback match.
    - Presets (`VOICE_PRESETS`) set the character *and* the track pitch: Natural, Deeper (−3 st, formant −2.5), Younger (+3, +3), Chipmunk (+7, +6), Monster (−8, −5), Robot, Whisper.
    - It's in the inspector's **Voice** section (chips + Formant/Whisper sliders); undoable. Monitoring uses the selected track's voice (plus its preset's pitch), and new recordings copy it.
    - Measured: formant +5 st moves the spectral centroid ×1.36 (theory ×1.33), −5 st ×0.78; whisper keeps the centroid (×1.07) with 0% pitched frames; in-app Chipmunk 192 → 290 Hz (288 expected), Monster 122 Hz (121).
  - **Live clean-up** (`src/dsp/cleanup.ts`):
    - `CleanupStream` runs noise reduction → gate → de-esser as a restartable stream:
      - **noise reduction:** STFT Wiener on a fixed frame grid; frame *pairs* share one complex FFT (one in the real part, one in the imaginary);
      - **gate:** from a precomputed per-frame open map;
      - **de-esser:** a complementary split, low = 2nd-order low-pass at 5.5 kHz and high = input − low, so it adds no delay and sums back exactly.
    - Only the settings-free parts are precomputed (`analyzeCleanup`: noise profile, gate map). The offline `denoise`/`gate`/`deess` run the same stream, so their old quality tests (+9 dB SNR, gate depth, de-ess) cover it.
    - The worker's `prepareVoice` now runs **once per take** (resample, PSOLA marks on the raw take, clean-up analysis). Clean-up settings go straight to the engine (`MixPlayer.setCleanup`, `cleanup` message), so **no re-render is left for vocals**.
    - `VoiceRenderer` keeps a cleaned copy valid from a margin behind the playhead to a margin ahead. It restarts (warm-up 2 frames) on seeks; loop passes reuse it; an amount change invalidates what's behind the playhead, so a loop picks up the new amount. Playing from 0 equals `processRecording` bit for bit (tested), and the processed-take export matched it exactly in the app.
    - Takes are prepared quietly when a song opens, even with nothing switched on, so the first change is instant.
    - Fix: switching everything off no longer cancels a preparation in flight (that used to leave the take stuck unprepared).
  - **Live beat key shift** (`src/dsp/shift-stream.ts`, `src/audio/engine/beat-worklet.ts`):
    - `ShiftStream` is the phase vocoder as a generator: time-stretch, then a Catmull-Rom read-out r× faster. Stereo is packed into one complex FFT.
    - Identity phase locking is done as **one rotation per peak**: atan2 of X·conj(X_prev), cos/sin only per peak; the other bins take one complex multiply. Finished hops are normalised once.
    - A beat lane switches to the beat-engine worklet on its first non-zero shift and stays there, so later shifts are a `shift` message with no restart. Exports use the same worklet; offline `pitchShift` wraps the stream.
    - The old worker key-shift render and its cache are gone (no fallback needed). In the app: +2 st put the bass at 123.25 Hz (123.47 expected), +4 st at 138 Hz (138.6); loop passes are identical.
  - **Fixed (present since Phase 8):** `MixPlayer.setTracks` stopped the sources but left `_playing` true, so its `play()` returned early. A mix rebuild during playback went **silent** and the clock jumped (e.g. when a track's render arrived mid-play, or on the first key shift).
  - **FFT:** twiddles hoisted out of the butterfly loop and the first two stages special-cased, 1.5× faster; direct-DFT + round-trip tests. Whisper: each grain is windowed once (it was a cosine per sample per LPC lag).
  - **CPU, measured in real Chrome** (headless, `OfflineAudioContext`, 8 tracks): nothing on 9%; auto-tune 9%; + 3 harmonies 11%; formant 10%; whisper 16%; full clean-up 17%. A stereo beat with key shift adds ~3.8%; live monitoring ~3.5%.
    - **The desktop app's built-in browser pane runs this JS ~5–7× slower than Chrome** (FFT pair 0.71 ms vs 0.11 ms), so CPU figures measured there (Phases 13–14 below) overstate real use.
    - Benchmark scripts were run with puppeteer-core against `npm run dev` (see `scripts/screenshots.mjs` for the setup).
- **Neon studio UX (Phase 16):**
  - **Design tokens** sit at the end of `style.css`:
    - glow `--glow-accent`/`--glow-fg`/`--glow-record`, `--led-green`;
    - radius `--radius-sm/md/pill`, motion `--dur-fast`/`--dur`/`--ease`;
    - context cursors `--cursor-crosshair`, `--cursor-ew`, `--cursor-ew-active` (neon SVG data URIs with a keyword fallback; `auto` on `hover: none`).
    - `prefers-reduced-motion` turns transitions and animations off.
  - **Neon slider** (`src/ui/slider.ts`, maths in `slider-math.ts`, tested). `watchSliders(document.body)` in `main.ts` enhances every `<input type="range">` in place, including the ones created later (MutationObserver).
    - The native input stays as the source of truth (focus, keyboard, ARIA; panels keep their `input`/`change`/`dblclick` listeners). It moves inside a wrapper `.ns` that takes over its classes (so the layout CSS still applies) and draws track, fill, detent ticks, thumb and value bubble.
    - `input.value = …` from code is caught by a per-instance setter, so the picture follows.
    - Pointer: drag relative to the grab point (no jump); clicking the track jumps there; **Shift = fine** (×0.1); **detents** snap within 2.5% of the range (default: the 0 of a range that crosses it; `data-detents="…"`, empty = none); **Alt = free**.
    - Wheel steps only while the slider is focused (so columns still scroll). Double-click resets (forwarded to the input, plus `data-default`). `touch-action: pan-y`, so panels still scroll on phones.
    - Fill from the centre for bipolar ranges; `data-fill="start"` for volume faders. The bubble shows `aria-valuetext`, the field's `.slider-value` text, or the value.
  - **Controls:** a glowing knob arc, switch, segmented control, chips, active M/S/LIM and the playing Play button; a red glow on Record.
  - **LED meters:** the fill is a fixed green→amber→red gradient revealed by `clip-path` from `--level` (set by `tracks-panel`), segmented with a mask.
  - **Context cursors:** a crosshair on the roll plus a **note label under the pointer** (`ui/panels/roll-hover.ts`, `PianoRoll.noteAt`, mouse/pen only); ↔ on clips, loop edges and sliders; a crosshair on the ruler to draw a loop; active ↔ while dragging.
  - **Touch (`pointer: coarse`):** taller sliders with bigger thumbs, 40 px icon/track buttons and chips; the mixer's grid columns grow to match.
  - **Verified:**
    - Real-pointer drag in the browser: Formant 0 → +3.5 st (model updated, preset → custom, bubble "+3.5 st"); dragged back near 0, it snapped to exactly 0 with the detent lit.
    - Arrow keys stepped 0 → 1; the wheel while focused stepped it; double-click reset it.
    - The roll label read E3 / C3 at two heights.
    - Real-Chrome screenshots at 1440, 900 and 390 px (`npm run screenshots`, which now also makes `tablet.png` and shows a value bubble).
- **Metronome & grid (Phase 17):**
  - **Grid model** (`src/project/grid.ts`, pure, tested): `Grid { bpm, beatsPerBar, downbeat }` from the song's `bpm`, `beatsPerBar` (default 4) and `downbeat` (song time where a bar starts, normalised into the first bar). There is no grid without a BPM; the click then uses 100 BPM in 4 (`clickGridOf`).
    - Helpers: `snapToGrid` (anchored at the downbeat), `gridLines` (beats, or only every 2ⁿ-th bar when crowded), `countInLead`, `tapTempo` (taps since the last 2 s pause, last 8, clamped 40–240), `takeOnset` (first frame ≥ 10% of the 95th-percentile RMS, or the first voiced one), `alignToBeat`.
    - `snapOffset`, `normalizeLoop` and `defaultLoop` take a `Grid` (or a bare BPM, as before), so clips and loops snap to the downbeat-anchored grid.
  - **Detection:** `estimateTempo` also returns `downbeat` (`estimateDownbeat`):
    - the beat phase with the strongest *mean* comb of onsets, then the strongest of the 4 bar phases;
    - a flux frame peaks when an onset is ¾ of the window in, which is corrected for.
    - Importing a beat sets bpm + downbeat. Tests: within 15 ms at 96–140 BPM; in the app 0.36 s for a beat whose bars start at 0.37 s.
  - **Click** (`src/dsp/click.ts` `ClickTrack`, `engine/click-worklet.ts` processor `click-engine`):
    - It renders clicks for whatever song samples the transport (`blockRuns`) plays, so seeks and loop wraps are sample-accurate. Precomputed 45 ms ticks: 1760 Hz accented bar 1, 1175 Hz other beats.
    - A click continues across blocks and runs; blocks equal one-go rendering (tested).
    - `MixPlayer` owns one click node → DelayNode → gain → **destination** (never in exports, master meters or the limiter). `setMetronome({ on, gain, accent, grid })` is live: grid/accent are messages; switching on mid-play re-sends the current transport.
    - Count-in positions can be negative, so the click's transport carries a `bias`, and `before` (song samples) keeps count-in-only clicks silent from the song position on when the metronome is off.
  - **Count-in** (replaces `countInTimes` + `scheduleClicks`): clicks on the grid's beats in the bar before the position (`countInLead`, accent on bar starts), by the click worklet: `player.play(at, { countIn, recording: true })`.
    - `recording` keeps the transport (and the click) running past the song's end and allows a song with no tracks. It lasts until `pause()`, so a mix rebuild mid-take keeps it.
    - Recording into a song now plays along when the song is audible **or** the click or count-in is on (an empty song gets a count-in and a grid-aligned take).
  - **Mix-chain latency (found while measuring the click):** the track compressor's look-ahead (6 ms) and the master limiter + 2× oversampled clipper (~8.7 ms) delay everything in the mix by **14.7 ms** (6 ms with the limiter off) in Chrome.
    - `measureChainLatency` (`chain.ts`) renders an impulse through a track chain + master offline once per rate.
    - The click is delayed by it. `MixPlayer.mixLatency` is added to `currentTime`'s latency (visuals) and to the take alignment (`playAlong`: round trip + mix latency; you sing to the song as you hear it). Before, takes recorded over a song sat ~15 ms late.
  - **Session:** `setTempo({ bpm?, beatsPerBar?, downbeat? })` is undoable (coalesced per field), re-normalises the downbeat and updates echo sync, the click, the loop and the roll. Also `tapTempo()`, `setDownbeatHere()` (sets 100 BPM if none), `alignTrackToBeat(id)` (undoable clip move) and `syncMetronome()` (on open/close/rebuild/prefs).
  - **Prefs:** `state.metronome = { on, levelDb (−30…0, default −6), accent }`, in `localStorage['recorder.metronome']`; the click only sounds with a song open.
  - **UI:**
    - Inspector **Tempo & click** section (`ui/panels/tempo-panel.ts`): BPM field + Tap, beats per bar, "Bar 1 here", click switch/level/accent, "Align take to beat".
    - The transport has a click button. Shortcuts: **M** = click on/off (song open), **Q** = align the selected take (playback).
    - The roll draws beat/bar lines with bar numbers (`PianoRoll.setGrid(grid, toSong)`; while recording over a song `toSong` maps live time to song time). The timeline draws beat + bar lines and bar labels ≥ 26 px apart.
  - **Verified in the app** (beat at 96 BPM, bars from 0.37 s; click and master captured in the same ScriptProcessor):
    - every click 10 ms before its kick (= the detection error) with the limiter on and off, and through loop wraps (no double clicks);
    - switched on mid-play it starts on the next beat, and off it stops;
    - the count-in clicked at −2.51/−1.885/−1.26/−0.635 s from the first kick exactly as predicted, accent first, silent after;
    - the take was added as a track, and "Align" put its first note exactly on a beat (undo/redo fine).
- **Note editing (Phase 18):**
  - **Notes** (`src/dsp/note-edit.ts`, pure, tested): `segmentNotes(frames)` cuts each voiced run where the 5-frame median pitch stays > 0.7 st from the note's pitch (median of its first 8 frames) for 4+ frames. Pieces < 60 ms merge into a neighbour, and neighbours on the same pitch join (so a blip doesn't split a note). A `SungNote` has frames [from, to), start/end (s) and its median pitch.
  - **Edits** live on the track: `track.noteEdits: NoteEdit[]` = `{ from, to, shift, amount, start?, end? }`, keyed by the note's frame range, so the take itself never changes. A neutral edit is removed.
  - **Pitch:** `applyNoteEdits` runs on the sung-key curve (after auto-tune/robot, before the transpose). `amount` (null = the track's auto-tune) pulls the sung pitch that far onto the note (its auto-tune target, or its rounded median), then `shift` moves it. Targets move by the rounded shift, so harmonies follow in key.
  - **Timing:** `buildWarp` makes a piecewise-linear time warp. The moved notes' edges are pinned where they were put; every other note's edges stay as sung where that keeps time running forward (otherwise that edge gives way, squeezing or stretching the neighbour); the gaps stretch. The take's length never changes.
    - `planGrains(…, warp)` walks *output* time: each grain comes from the analysis mark nearest `warpToSource(t)` and is spaced by the corrected period there, so moved/stretched notes keep their pitch. Without a warp the plan is bit-identical to before (the old tests still pass).
    - `renderGrains`' low-weight blend reads the source at the warped position; `VoiceRenderer.clean` covers the warped source range.
  - **Flow:** `trackProcessSettings` adds `notes`. `VoiceRequest.notes` → worker → `planVoices(…, edits)` (which also counts edits as "something to do"). So edits are live in the engine (heard on the next block) and in every export (same plans). `.recsong` files carry them in the track JSON.
  - **Session:**
    - `notesOf(take)` (cached per take); `toggleNoteMode`, `selectNote`, `stepNote`, `noteEditOf`, `editNote` (undoable, coalesced), `resetNote`, `resetAllNotes`.
    - `dragNote` (from the roll): up/down = pitch in whole semitones (Alt: free, 0.01 st); sideways = move (snapped to 1/16 of the song grid; Alt: free); ends = stretch. It's kept between the neighbours' far edges (≥ 50 ms each). **One undo step per drag, however slow:** each drag has its own history key with no time window (`History.push(…, windowMs)`); the 800 ms window had split a slow drag into several steps.
    - `refreshSongView` draws everything as heard: frames moved by the track's warp (in ms) + offset + transpose; ghosts get their pitch edits too. While editing, the view doesn't re-centre.
  - **Roll** (`PianoRoll`): `setNoteEdits` (the line shows the edited curve over the faded sung one, even with auto-tune off) and `setNotes(blobs, selected)`.
    - Note mode draws rounded blobs on the notes' lanes (selected = white outline + glow; edited = brighter), shows the whole window (ahead of the playhead too) with no history fade, and hit-tests blobs: middle = move (axis locks after 5 px), 7 px ends = stretch.
    - Callbacks `onNoteSelect` / `onNoteDrag` (cumulative semitones/seconds). Cursors: grab / ↔ on ends / grabbing.
  - **UI:**
    - An "Edit notes" button on the roll (**N**). The inspector's **Note** section (`ui/panels/note-panel.ts`, top of the inspector, only in note mode) has: name (heard vs sung), a pitch slider (±12 st, a detent on every semitone, Alt = free, `data-ticks="0"`), "Own correction" + amount, a timing readout, and reset note / reset all.
    - Keys in note mode: ↑/↓ ±1 st (Shift ±0.1), ←/→ previous/next note (the playhead jumps there), Delete/Backspace reset, Esc done.
    - `NeonSlider` learned `data-ticks` (marks shown ≠ detents).
  - **Verified in the app** (demo take, 14 notes; real pointer drags; playback captured and pitch-tracked):
    - Dragging note 4 up 2 lanes gave shift +2. Heard 50.09 vs 48.04 after one undo (sung 48.01); redo is back.
    - Dragging it sideways 7 px moved the edit by +0.098 s, and the D3 was heard 0.097 s later at both ends.
    - Keys worked: N, →→, ↑, Shift+↑ (= +1.1), Delete, Esc.
- **Play-the-keys harmony (Phase 19):**
  - **Maths** (`src/dsp/keys.ts`, pure, tested): one harmony voice per held key (lowest key = first voice, at most `MAX_KEY_VOICES` = 4).
    - Voicing **near** moves each key to the octave closest to the sung line (duplicates dropped); **played** keeps it.
    - Each voice sings its key plus the line's expression (corrected − its nearest semitone), so vibrato and scoops ride along. With auto-tune at 0 ms the voices are exact.
    - `KeyEvent { t, notes }` = the held set from t (s into the take). `addKeyEvent` drops repeats and replaces same-time changes; `keysAt`; `keyHarmonyCorrections` per slot.
  - **Live** (`LiveVoice.setKeys(keys | null, voicing, mix)`): keys replace the interval voices from the next pitch frame without resetting the corrector. Keys mode always processes (no 25 ms jump on the first key). A separate `keys` message reaches the live worklet (`LiveKeysMessage`), re-applied when monitoring switches on; `AudioInput.setKeys`. The CPU fallback counts key voices.
  - **Playback/export:** `planVoices(…, keys)` gives one voiced-only plan per key slot. **`planGrains` now skips grains where a non-passthrough voice's curve has no pitch inside a sung stretch**, so a slot is silent where fewer keys are held; interval harmonies are unchanged (their curves only lack pitch where unvoiced). Gain = mix / √voices.
  - **Recording:** `Session.syncKeys` records every held-set change into the take (context time − the take's first sample). Keys already held at Record start at 0. A take recorded into a song keeps them as `track.keys = { events, voicing }` (the mix = the track's harmony mix). `trackProcessSettings` → `ProcessSettings.keys` → worker. "Remove the track's keys" (undoable); voicing changes re-plan the selected track's keys.
  - **Inputs:**
    - The roll's keyboard is playable in keys mode (`PianoRoll.setKeysPlayable`, `onKeyPress`, multi-touch via pointer ids). **Latch** (default): a click toggles a key, for chords with a mouse.
    - Web MIDI (`src/audio/midi-input.ts`): every input, note on/off, sustain pedal CC 64 (keys released under the pedal stay until it lifts). Access is asked when keys mode turns on (or at start if it was on).
    - Held keys are drawn on the roll (accent bar + dot on the key, a faint lane stripe).
  - **Roll:** `setKeyHarmony({ voicing, held } | { voicing, at(frameIndex) })` draws the key voices as harmony lines and lit lanes: the held keys live; the track's recorded keys in playback (looked up by the take frame's own time, so note-timing warps don't matter).
  - **UI:** Harmony section **Intervals | Keys** (`ui/panels/keys-panel.ts`; the tuning panel hides the interval chips and enables Mix in keys mode, even with auto-tune off). Also: voicing (Near my voice / As played), latch, the held notes + MIDI status, "Let go of all", "Remove the track's keys (n changes)". Prefs in `localStorage['recorder.keys']`.
  - **Fix found on the way:** the transport's A/B buttons were picked with `.segmented .seg`, which would have grabbed any other segmented control; it's now `.seg[data-ab]`.
  - **Verified in the app** (demo voice; output captured and measured):
    - Two latched keys clicked on the roll's keyboard (F3 + C4) while listening with "Hear myself": 23× (F3) and 3.9× (C4, which the demo also sings) more energy at those notes than with the keys released.
    - A take recorded with A3 held, then E4 from 2 s, kept the events (0 s [A3], 2 s [E4], 4.01 s []). Its playback had A3 77× stronger only in the first part and E4 19× only in the second, against the same take with its keys removed; undo brings them back.
    - The pane refuses Web MIDI ("MIDI access was refused" shown); real MIDI keyboards are for the user to try in Chrome/Edge.
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
    grain-shape.ts        voice character per grain: formant shift (read rate) + whisper (LPC envelope, noise); grain cache
    voice-engine.ts       voice plans (lead + harmonies) + VoiceRenderer: block rendering for the real-time engine
    live-voice.ts         causal PSOLA for monitoring: tracker + corrector + live marks + 25 ms-delayed synthesis
    harmony.ts            diatonic harmony voices + mixed render (renderWithHarmony)
    note-edit.ts          sung notes (segmentation), note edits on the pitch curve, timing warp
    keys.ts               play-the-keys harmony: voicing held keys against the line, key events, per-slot curves
    limiter.ts            look-ahead peak limiter
    fft.ts                radix-2 complex FFT
    cleanup.ts            clean-up as a restartable stream: STFT Wiener (paired frames) -> gate -> de-esser; analysis
    denoise.ts            offline noise reduction (runs the clean-up stream); frameSizeFor
    process.ts            prepareVoice (once per take: rate, PSOLA marks, clean-up analysis) + processRecording (offline reference)
    analyze.ts            key (chroma + Krumhansl), tempo (onset autocorrelation) and bar start of instrumentals
    click.ts              metronome clicks for any song-sample range (accented bar 1), block-exact
    shift-stream.ts       streaming phase vocoder (stereo-packed FFT, per-peak rotation): the beat's key shift, live
    vocoder.ts            pitchShift (offline wrapper of shift-stream) + Catmull-Rom resample
    reverb.ts             generated impulse responses (Room, Plate, Hall, Cathedral)
    dynamics.ts           offline gate / de-esser (run the clean-up stream)
    resample.ts           low-pass + decimate to the analysis rate
  audio/
    context.ts            the shared AudioContext (mic + playback on one clock) + output latency
    audio-input.ts        mic / demo-tone sources -> live worklet -> blocks, pitch frames, stats; monitor output
    pitch-tracker.ts      ring buffer + hop scheduling -> PitchFrame stream
    sample-buffer.ts      collects PCM blocks during a take
    mix-player.ts         multi-track playback: buffer lanes (beats) + voice-engine lanes (takes), live plans/gain/pan/fx, loop, clock
    mixdown.ts            OfflineAudioContext mixdown/stems/processed take through the same graph and engine
    sync.ts               take alignment math, click-loopback latency detection, count-in times
    metronome.ts          scheduled click sounds (latency calibration)
    midi-input.ts         Web MIDI keyboards: note on/off + sustain pedal
    render-worker.ts      Web Worker: voice requests (prepare once per take + plans per change), key/tempo
    engine/
      engine-worklet.ts   AudioWorklet 'voice-engine': renders a take from source + plans, follows the transport
      protocol.ts         engine messages + construction options (shared with the main thread)
      transport.ts        pure: context frame -> song position, loop runs, loop fades
      live-worklet.ts     AudioWorklet 'live-processor': raw blocks + pitch frames + monitored voice (LiveVoice) + CPU load
      live-protocol.ts    live worklet messages
      beat-worklet.ts     AudioWorklet 'beat-engine': a key-shifted beat (ShiftStream), follows the transport
      click-worklet.ts    AudioWorklet 'click-engine': the metronome + count-in, follows the transport
    tuned-renderer.ts     main-thread client for the worker (voice: per-channel latest-wins; analyze; shift)
    wav.ts                16-bit PCM WAV encoder (mono or interleaved multi-channel); float WAV encode + WAV decode (song files)
    encode.ts             export encoding: WAV, or MP3 via mp3-worker.ts (LAME, LGPL, own chunk)
    mp3-worker.ts         Web Worker: lamejs MP3 encoder
    zip.ts                stored ZIP writer + reader (stems, song files)
  project/
    model.ts              Project/Track types + pure helpers (create, duplicate, update, effective gain, scheduling, transpose)
    fx.ts                 TrackFx / SongFx, presets, echo timing
    grid.ts               tempo grid: snapping, beat/bar lines, count-in, tap tempo, take onset + align to beat
    voice.ts              TrackVoice + voice presets (Natural, Deeper, Younger, Chipmunk, Monster, Robot, Whisper)
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
    popout.ts             pop-out inspector sections: floating, draggable, resizable windows; dock back; remembered
    confirm.ts            custom confirmation pop-up (modal dialog) with "Don't ask again"
    slider.ts             Neon slider: enhances every range input in place (detents, fine drag, bubble, wheel)
    slider-math.ts        pure slider maths: positions, steps, detents, fill origin, relative drag
    captions.ts           word-by-word explainer captions over the roll
    colors.ts             lane/key color palette
    format.ts             time formatting
    panels/               each mounts onto existing markup, renders from the store, calls Session actions
      layout.ts           phone tabs, tablet takes drawer (inert when closed, focus return), collapsible columns + rails
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
      fx-panel.ts         Voice (presets, formant, whisper), Effects (track) and Song FX (key shift, reverb, echo) sections
      onboarding.ts       one-time studio tips (captions) when features first come up
      roll-hover.ts       note label under the pointer on the roll (with the crosshair cursor)
      tempo-panel.ts      Tempo & click section: BPM + tap, beats per bar, bar 1, click, align take
      note-panel.ts       Edit notes button + Note section (pitch, own correction, timing, reset); roll note callbacks
      keys-panel.ts       Harmony Intervals | Keys switch, voicing, latch, MIDI status; the roll's playable keyboard
      modebar.ts          top bar: workspace modes (Studio, Record, Remix, Edit, Fun) showing/hiding panels
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
- **Collapsible columns** (≥1100 px for Songs/Takes, ≥760 px for the inspector): « / » buttons in the column heads, or **[** / **]**, close a column to a 44 px **rail**.
  - The left rail has an open button plus Songs/Takes buttons; the right rail has an open button and a vertical "Inspector" label.
  - State: `state.layout = { leftCollapsed, rightCollapsed }`, in `localStorage['recorder.layout']`. Classes `.is-left-collapsed` / `.is-right-collapsed` on `#studio` switch the grid, with a short transition. Phones keep the tab bar.
- **App frame:** the studio has a margin on every side and between its columns (`--frame-gap`: 10 px, 6 px on phones; safe areas included), on a darker `--frame` background. Every column, rail and the phone tab bar is a rounded card (`--frame-radius`). The tablet drawer floats inside the frame too.
- **Custom cursors everywhere** (CSS variables, neon SVGs with keyword fallbacks, `auto` on touch):
  - `--cursor-default` (arrow, on `html`) and `--cursor-pointer` (amber arrow: buttons, summaries, selects, switches, chips, tabs);
  - `--cursor-grab` / `--cursor-grabbing` (4-way move: floating windows, note blobs, drags) and `--cursor-text` (I-beam: text/search/number fields);
  - plus Phase 16's crosshair / ↔.
  - No raw `cursor: pointer|default|grab` is left in the CSS. Verified in Chrome: every element kind gets its custom `url(...)` cursor.
- **Top bar with workspace modes** (`ui/panels/modebar.ts`, `#modebar`, spans the grid's first row inside the frame): brand, mode switch, open song's name.
  - **Studio** (everything), **Record** (Input, Auto-tune, Harmony, Voice, Tempo & click; no mixer), **Remix** (Clean up, Voice, Effects, Tempo & click, Song FX; mixer), **Edit** (Note, Auto-tune, Harmony; mixer; switches note editing on, and leaving it switches it off), **Fun** (Input, Auto-tune, Harmony, Voice with big chips; no mixer).
  - Modes only show/hide UI (`data-mode-hidden`, separate from the panels' own `hidden`); songs, settings and audio are untouched. Popped-out windows and their placeholders (`data-for`) follow the mode.
  - Keys **1–5**; a caption names the mode; `state.workspace` in `localStorage['recorder.workspace']`; `body[data-workspace]` for mode-specific CSS. Phones show icons with the active mode's label.
  - Verified in Chrome: each mode shows exactly its sections and mixer state; Edit toggles note mode both ways.
- **Confirmations** (`src/ui/confirm.ts`, `confirmDialog(opts) → Promise<boolean>`): a custom modal pop-up (native `<dialog>`: focus kept inside, Esc or a click outside cancels) replaces every `window.confirm`.
  - It's used for: delete take, delete song, replace the beat, calibrate latency.
  - Destructive questions use a red button and start focused on Cancel.
  - **"Don't ask again"** switch: the question's key is stored in `localStorage['recorder.dontAsk']` and answered yes from then on. "Ask before deleting again" under the takes list (shown only when something is skipped) turns them all back on.
  - Verified in Chrome:
    - the dialog shows with focus on Cancel; Esc keeps the take;
    - a tick + Delete removes it and skips the next question, which deletes straight away;
    - the reset link makes it ask again; a backdrop click cancels;
    - no native dialog at any point.
- **Scrollbars:** thin rounded thumbs (`::-webkit-scrollbar`, amber on hover/drag); Firefox gets `scrollbar-width: thin` + colours.
- **Pop-out sections** (`src/ui/popout.ts`): every inspector section (`details.section[id]`) gets a ⧉ button in its title.
  - It moves the *same* element into a floating `.float-panel` (fixed, draggable by the title, resizable from the corner, click to bring to front), so every panel's bindings keep working.
  - A dashed placeholder with a **Dock** button holds its place in the inspector. The dock icon in the window's title, or the placeholder, puts it back.
  - A drag doesn't fold the section (its click is swallowed); a plain click still does. Windows stay on screen (clamped on drag and resize).
  - A hidden section (e.g. Note outside note mode) hides its window too.
  - Positions/widths are kept in `localStorage['recorder.popouts']`. They are measured with `offset*`, because the open animation scales the window; the height follows the content.
  - Below 760 px everything docks (the remembered windows come back when wide again).
  - Verified (synthetic + real pointer, real Chrome):
    - a slider in a floating Effects window edits the track;
    - a drag moves the window exactly and is remembered;
    - after a reload it's back at the same place;
    - on the phone viewport it docks, and on the wide one it floats again.

Data flow: mic → live AudioWorklet (`PitchTracker` inside `LiveVoice`: downsample, YIN, median filter) → `PitchFrame { time, freq, midi, clarity, rms }` posted with its context frame → `Session.onFrame` → `PianoRoll.push()` → canvas drawn on each `requestAnimationFrame`. With "Hear myself" on, the same worklet's output (the processed voice) → monitor track chain → master.
While recording, the same blocks and frames are also collected into a take. On Stop the take is saved to IndexedDB and opened in playback mode.

Shortcuts: **R** = record/stop, **T** = auto-tune on/off, **Space** = play/pause and **A** = original/tuned (playback mode), **L** = loop on/off (song open), **M** = click on/off (song open), **Q** = align the selected take to the beat (playback), **1–5** = workspace modes (Studio, Record, Remix, Edit, Fun), **[** / **]** = close/open Songs+Takes / the inspector, **N** = edit notes (then ↑/↓ pitch, Shift = 0.1 st, ←/→ next note, Delete reset, Esc done), **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** = undo/redo (song open).

## Commands

```bash
npm install
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # type-check + production build
npm test           # vitest unit tests
npm run dev:lan    # HTTPS dev server on the LAN (phone mic testing; accept the cert warning)
npm run preview:lan # build + HTTPS preview on the LAN
npm run icons      # regenerate public/icons/*.png
npm run screenshots # regenerate README screenshots (headless Chrome via puppeteer-core; needs `npm run dev`; GIF needs ffmpeg)
```

- **README** (`README.md`): features with screenshots from `docs/screenshots/`, made by `scripts/screenshots.mjs` (fresh browser profile, demo voice + generated beat, driven through `window.recorder`). Re-run it after visible UI changes.

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
- [x] Speed-up: stereo packed into one complex FFT — done in Phase 15, where the key shift became live (streaming phase vocoder)
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

### Phase 14 — Live monitoring (hear yourself) — branch `realtime-engine`
- [x] Mic → live worklet (tracker + causal PSOLA, `LiveVoice`) → selected track's FX chain → master; "Hear myself" switch with headphones hint/captions
- [x] Live auto-tune, harmony and transpose while listening/recording; pitch line and take frames come from the same worklet detector (capture worklet replaced); browser-verified with the demo tone (all notes in key, median 0¢)
- [x] Latency: 25 ms processing + one quantum (27.7 ms extra, target ≤ 30); total shown in the Input section; takes stay dry (verified: 3 s take, 99 frames/s, first frame at 21 ms)
- [x] CPU indicator (Date.now tick estimator) and automatic harmony fallback (> 50% load), restored when calm
- [x] Found and fixed: PSOLA octave-down was a no-op (grain length); recording into a key-shifted song shifted the take twice
- [ ] Real check (user): wired headphones + real mic: latency feel, feedback-free, harmonies/FX while singing

### Phase 15 — Everything live + voice character — branch `realtime-engine`
- [x] Streaming noise reduction (profile from offline analysis), gate and de-esser in the engine; no re-render left for vocals (engine == offline reference bit for bit; first change instant, 3 ms to the engine)
- [x] Streaming phase vocoder for instrumental key shift (stereo-packed FFT, per-peak rotation); measured cheap enough (~3.8% of a core in Chrome) that the cached-render fallback was dropped
- [x] Voice character: formant shift + presets (Deeper, Younger, Chipmunk, Monster, Robot, Whisper); live in playback, export and monitoring
- [x] Found and fixed: silent mix rebuilds during playback (since Phase 8); clean-up preparation stuck when everything was switched off; whisper LPC cost
- [ ] Listening test (user): voice presets on real vocals, clean-up amounts while playing, key-shifted beats (artefacts beyond ±4 st)

### Phase 16 — UX overhaul ("Neon studio") — branch `realtime-engine`
- [x] Design tokens (colour, glow, radius, motion) + reduced-motion support
- [x] `Slider` component: detents/snap, Alt free, Shift fine, value bubble, wheel, keys, double-click reset, ARIA; replaces every range input (24 in a song, all enhanced; tests for the maths)
- [x] Neon knobs, toggles, segmented controls, LED meters; consistent hover/active/focus states
- [x] Context cursors: roll crosshair + note label, clip grab/grabbing, loop/slider resize; none on touch
- [x] Inspector/mixer/transport polish (faders fill from the left, brighter rails), touch targets ≥ 40 px on phones; checked at 1440/900/390 px in real Chrome
- [ ] Feel check (user): slider snapping strength, bubble placement, cursors on your mouse/trackpad

### Phase 17 — Metronome & grid — branch `realtime-engine`
- [x] Click track (playback and recording, accent, volume), tap tempo / set BPM, beats per bar, bar 1 here; downbeat detected on import; count-in on the grid's beats
- [x] Bar/beat grid on the roll and timeline; snap clips and loop to the grid (anchored at bar 1)
- [x] Quantize a take's start to the nearest beat ("Align take to beat", Q; first sung onset)
- [x] Found and fixed: the mix chain's ~15 ms delay (compressor look-ahead + limiter) wasn't compensated, so takes recorded over a song sat late; it's measured now, and the click and take alignment use it
- [ ] Real-world check (user): click against real beats (detected bar 1), tap tempo feel, count-in + align on a real take

### Phase 18 — Note editing — branch `realtime-engine`
- [x] Segment the pitch track into notes (stable pitch regions); draw note blobs on the roll
- [x] Drag a note's pitch (semitone snap, Alt = cents) and timing/length (PSOLA time-stretch); per-note correction amount
- [x] Edits stored per track (non-destructive), undoable, live in the engine and in export (tests: pitch within 10¢, a move/stretch keeps pitch, blocks == whole with a warp; verified by ear-measurement in the app)
- [x] Found and fixed: a slow drag became several undo steps (time-window coalescing); drags are one step now
- [ ] Real-world check (user): note splits on real singing (too many/few?), drag feel, stretched consonants

### Phase 19 — Play-the-keys harmony — branch `realtime-engine`
- [x] Clickable on-screen piano (the roll's keyboard; latch for mouse chords, multi-touch) + Web MIDI keyboard input (sustain pedal)
- [x] Harmony voices follow held keys live (LiveVoice), voiced near the sung note (or as played), keeping its expression
- [x] Record key events into the track so playback/export reproduce them (plans per key slot, silent where fewer keys are held); key voices drawn on the roll
- [ ] Real-world check (user): a real MIDI keyboard in Chrome/Edge, chords while singing with headphones, near vs as-played voicing
- [ ] Later: overdub keys onto an existing track during playback (today keys are recorded with the take)

---

## UX round (after v3, 2026-10-15)

The user asked for more UX work: first a collapsible Songs column, then pop-able inspector menus. They chose pop-out floating windows for the inspector sections, and a thin rail for a closed column.

- [x] Songs & Takes column closes to a rail with one click (« / [ ); remembered
- [x] Inspector closes to a rail too (» / ] ); each section pops out into a floating, draggable, resizable window and docks back with one click; remembered; docked on phones
- [x] A margin around the whole app; columns as rounded cards (desktop, tablet, phone)
- [x] Custom cursors everywhere (arrow, pointer, move, text + the context cursors); neon scrollbars (every range slider was already the Neon slider)
- [x] Top bar with workspace modes: Studio, Record, Remix, Edit, Fun (1–5), remembered; phone-friendly
- [x] Custom confirmation pop-up for deleting songs/takes (and the other confirmations) with "Don't ask again" (+ a way to turn questions back on)
- [ ] Feel check (user): rail width, window placement, dragging on a trackpad, frame size, cursor size
