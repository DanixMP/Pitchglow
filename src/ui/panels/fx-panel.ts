// Effects (selected vocal track: preset, pitch, sends, high-pass, compressor, EQ, gate, de-esser) and
// Song FX (key shift, reverb bus, echo bus) sections of the inspector.

import type { Session } from '../../app/session';
import { openProject, selectedTrack, type AppStore } from '../../app/state';
import { REVERB_PRESETS, type ReverbPreset } from '../../dsp/reverb';
import { scaleName } from '../../dsp/scales';
import { DEFAULT_SONG_FX, DEFAULT_TRACK_FX, FX_PRESETS, songFxOf, trackFxOf, type EchoDivision, type FxPresetId, type SongFx, type TrackFx } from '../../project/fx';
import { transposeScale } from '../../project/model';
import { $ } from '../dom';

interface SliderSpec<T> {
  label: string;
  min: number;
  max: number;
  step: number;
  /** Read the shown value from the settings. */
  get(v: T): number;
  /** Text next to the slider. */
  format(n: number): string;
}

const pct = (n: number) => `${Math.round(n)}%`;
const dbText = (n: number) => `${n > 0 ? '+' : ''}${n} dB`;

const TRACK_SLIDERS: Record<string, SliderSpec<TrackFx> & { patch(n: number, fx: TrackFx): Partial<TrackFx> }> = {
  reverbSend: { label: 'Reverb', min: 0, max: 100, step: 1, get: (f) => f.reverbSend * 100, format: pct, patch: (n) => ({ reverbSend: n / 100 }) },
  echoSend: { label: 'Echo', min: 0, max: 100, step: 1, get: (f) => f.echoSend * 100, format: pct, patch: (n) => ({ echoSend: n / 100 }) },
  highpassHz: { label: 'High-pass', min: 0, max: 400, step: 10, get: (f) => f.highpassHz, format: (n) => (n ? `${n} Hz` : 'Off'), patch: (n) => ({ highpassHz: n }) },
  compressor: { label: 'Compress', min: 0, max: 100, step: 1, get: (f) => f.compressor * 100, format: pct, patch: (n) => ({ compressor: n / 100 }) },
  eqLow: { label: 'Low', min: -12, max: 12, step: 0.5, get: (f) => f.eq.low, format: dbText, patch: (n, f) => ({ eq: { ...f.eq, low: n } }) },
  eqMid: { label: 'Mid', min: -12, max: 12, step: 0.5, get: (f) => f.eq.mid, format: dbText, patch: (n, f) => ({ eq: { ...f.eq, mid: n } }) },
  eqHigh: { label: 'High', min: -12, max: 12, step: 0.5, get: (f) => f.eq.high, format: dbText, patch: (n, f) => ({ eq: { ...f.eq, high: n } }) },
  gate: { label: 'Gate', min: 0, max: 100, step: 1, get: (f) => f.gate * 100, format: pct, patch: (n) => ({ gate: n / 100 }) },
  deess: { label: 'De-ess', min: 0, max: 100, step: 1, get: (f) => f.deess * 100, format: pct, patch: (n) => ({ deess: n / 100 }) },
};

const SONG_SLIDERS: Record<string, SliderSpec<SongFx> & { patch(n: number): Parameters<Session['updateSongFx']>[0] }> = {
  reverbLevel: { label: 'Rev level', min: 0, max: 100, step: 1, get: (f) => f.reverb.level * 100, format: pct, patch: (n) => ({ reverb: { level: n / 100 } }) },
  reverbTone: { label: 'Rev tone', min: 0, max: 100, step: 1, get: (f) => f.reverb.tone * 100, format: (n) => (n < 35 ? 'Dark' : n > 65 ? 'Bright' : 'Warm'), patch: (n) => ({ reverb: { tone: n / 100 } }) },
  echoFeedback: { label: 'Repeats', min: 0, max: 85, step: 1, get: (f) => f.echo.feedback * 100, format: pct, patch: (n) => ({ echo: { feedback: n / 100 } }) },
  echoLevel: { label: 'Echo level', min: 0, max: 100, step: 1, get: (f) => f.echo.level * 100, format: pct, patch: (n) => ({ echo: { level: n / 100 } }) },
};

interface SliderEl {
  input: HTMLInputElement;
  value: HTMLSpanElement;
}

function buildSlider(root: HTMLElement, id: string, spec: SliderSpec<never>, onInput: (n: number) => void, onReset: () => void): SliderEl {
  const label = document.createElement('label');
  label.className = 'slider-field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = spec.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.id = `fx-${id}`;
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.setAttribute('aria-label', spec.label);
  input.addEventListener('input', () => onInput(Number(input.value)));
  input.addEventListener('dblclick', onReset);
  const value = document.createElement('span');
  value.className = 'slider-value';
  label.append(name, input, value);
  root.append(label);
  return { input, value };
}

function setSlider(el: SliderEl, n: number, text: string): void {
  if (Number(el.input.value) !== n) el.input.value = String(n);
  el.value.textContent = text;
  el.input.setAttribute('aria-valuetext', text);
}

function fillSelect(select: HTMLSelectElement, options: [string, string][]): void {
  for (const [value, label] of options) select.add(new Option(label, value));
}

const semitoneOptions = (): [string, string][] =>
  Array.from({ length: 25 }, (_, i) => {
    const st = 12 - i;
    const label = st === 12 ? '+12 (octave up)' : st === -12 ? '−12 (octave down)' : st === 0 ? '0' : `${st > 0 ? '+' : '−'}${Math.abs(st)}`;
    return [String(st), label];
  });

export function mountFxPanel(store: AppStore, session: Session): void {
  // --- track effects ---
  const hint = $('fx-hint');
  const controls = $('fx-controls');
  const preset = $<HTMLSelectElement>('fx-preset');
  const pitch = $<HTMLSelectElement>('fx-pitch');
  fillSelect(preset, [['', 'Custom'], ...Object.entries(FX_PRESETS).map(([id, p]) => [id, p.label] as [string, string])]);
  fillSelect(pitch, semitoneOptions());

  const trackId = () => selectedTrack(store.get())?.id;
  preset.addEventListener('change', () => {
    const id = trackId();
    if (id && preset.value) session.applyFxPreset(id, preset.value as FxPresetId);
  });
  pitch.addEventListener('change', () => {
    const id = trackId();
    if (id) session.setTrackPitch(id, Number(pitch.value));
  });

  const trackSliders = Object.fromEntries(
    Object.entries(TRACK_SLIDERS).map(([key, spec]) => [
      key,
      buildSlider(
        $('fx-sliders'),
        key,
        spec as SliderSpec<never>,
        (n) => {
          const t = selectedTrack(store.get());
          if (t) session.updateTrackFx(t.id, spec.patch(n, trackFxOf(t)));
        },
        () => {
          const t = selectedTrack(store.get());
          if (t) session.updateTrackFx(t.id, spec.patch(spec.get(DEFAULT_TRACK_FX), trackFxOf(t)));
        },
      ),
    ]),
  );

  // --- song effects ---
  const songHint = $('songfx-hint');
  const songControls = $('songfx-controls');
  const keyShift = $<HTMLSelectElement>('key-shift');
  const reverbPreset = $<HTMLSelectElement>('reverb-preset');
  const echoDivision = $<HTMLSelectElement>('echo-division');
  const keyNote = $('key-shift-note');
  fillSelect(keyShift, semitoneOptions().filter(([v]) => Math.abs(Number(v)) <= 6));
  fillSelect(reverbPreset, Object.entries(REVERB_PRESETS).map(([id, p]) => [id, p.label]));
  fillSelect(echoDivision, [
    ['1/4', '1/4 note'],
    ['1/8', '1/8 note'],
    ['1/8d', 'Dotted 1/8'],
    ['1/16', '1/16 note'],
  ]);
  keyShift.addEventListener('change', () => session.setKeyShift(Number(keyShift.value)));
  reverbPreset.addEventListener('change', () => session.updateSongFx({ reverb: { preset: reverbPreset.value as ReverbPreset } }));
  echoDivision.addEventListener('change', () => session.updateSongFx({ echo: { division: echoDivision.value as EchoDivision } }));
  const songSliders = Object.fromEntries(
    Object.entries(SONG_SLIDERS).map(([key, spec]) => [
      key,
      buildSlider($('songfx-sliders'), key, spec as SliderSpec<never>, (n) => session.updateSongFx(spec.patch(n)), () => session.updateSongFx(spec.patch(spec.get(DEFAULT_SONG_FX)))),
    ]),
  );

  store.subscribe(render);
  render();

  function render(): void {
    const state = store.get();
    const song = openProject(state);
    const track = selectedTrack(state);

    const vocal = !!track && track.kind === 'vocal';
    hint.hidden = vocal;
    controls.hidden = !vocal;
    if (vocal) {
      const fx = trackFxOf(track);
      preset.value = fx.preset ?? '';
      pitch.value = String(track.pitch);
      for (const [key, spec] of Object.entries(TRACK_SLIDERS)) {
        const n = spec.get(fx);
        setSlider(trackSliders[key], n, spec.format(n));
      }
    }

    songHint.hidden = !!song;
    songControls.hidden = !song;
    if (song) {
      const fx = songFxOf(song);
      keyShift.value = String(song.keyShift);
      reverbPreset.value = fx.reverb.preset;
      echoDivision.value = fx.echo.division;
      keyNote.textContent = song.key && song.keyShift ? `Sounds in ${scaleName(transposeScale(song.key, song.keyShift))}` : '';
      for (const [key, spec] of Object.entries(SONG_SLIDERS)) {
        const n = spec.get(fx);
        setSlider(songSliders[key], n, spec.format(n));
      }
    }
  }
}
