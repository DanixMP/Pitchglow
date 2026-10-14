// Auto-tune + Harmony sections of the inspector.

import { harmonyText, retuneText, scaleText, tuningSwitchText } from '../../app/explain';
import type { AppStore } from '../../app/state';
import { HARMONY_VOICES, type HarmonyVoice } from '../../dsp/harmony';
import { pitchClassName } from '../../dsp/notes';
import { SCALE_TYPES, type ScaleType } from '../../dsp/scales';
import { DEFAULT_TUNING, type TuningPrefs } from '../../storage/settings';
import type { Captions } from '../captions';
import { $ } from '../dom';
import { Knob } from '../knob';

const VOICE_ORDER = Object.keys(HARMONY_VOICES) as HarmonyVoice[];

export function mountTuningPanel(store: AppStore, captions: Captions): void {
  const tuningSection = $('tuning-panel');
  const harmonySection = $('harmony-panel');
  const tuneOn = $<HTMLInputElement>('tune-on');
  const tuneKey = $<HTMLSelectElement>('tune-key');
  const tuneScale = $<HTMLSelectElement>('tune-scale');
  const retuneValue = $('retune-value');
  const harmonyVoices = $('harmony-voices');
  const harmonyMix = $<HTMLInputElement>('harmony-mix');
  const harmonyMixValue = $('harmony-mix-value');

  const update = (patch: Partial<TuningPrefs>) => store.set((s) => ({ tuning: { ...s.tuning, ...patch } }));
  let retuneCaptionTimer = 0;

  for (let pc = 0; pc < 12; pc++) tuneKey.add(new Option(pitchClassName(pc), String(pc)));
  for (const [type, { label }] of Object.entries(SCALE_TYPES)) tuneScale.add(new Option(label, type));

  const knob = new Knob({
    min: 0,
    max: 400,
    step: 1,
    bigStep: 50,
    value: store.get().tuning.retuneMs,
    defaultValue: DEFAULT_TUNING.retuneMs,
    label: 'Retune speed',
    format: (v) => `${v} ms`,
    onInput: (v) => {
      update({ retuneMs: v });
      window.clearTimeout(retuneCaptionTimer);
      retuneCaptionTimer = window.setTimeout(() => captions.show(retuneText(store.get().tuning.retuneMs)), 350);
    },
  });
  $('retune-knob').replaceWith(knob.element);

  const harmonyChips = VOICE_ORDER.map((voice) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.voice = voice;
    chip.textContent = HARMONY_VOICES[voice].label;
    chip.addEventListener('click', () => {
      const { harmony } = store.get().tuning;
      const on = harmony.includes(voice);
      // Keep voices in a stable (menu) order so the render cache key doesn't depend on click order.
      update({ harmony: VOICE_ORDER.filter((v) => (v === voice ? !on : harmony.includes(v))) });
      captions.show(harmonyText(store.get().tuning));
    });
    harmonyVoices.append(chip);
    return chip;
  });

  tuneOn.addEventListener('change', () => {
    update({ enabled: tuneOn.checked });
    captions.show(tuningSwitchText(store.get().tuning));
  });
  tuneKey.addEventListener('change', () => {
    update({ root: Number(tuneKey.value) });
    captions.show(scaleText(store.get().tuning));
  });
  tuneScale.addEventListener('change', () => {
    update({ type: tuneScale.value as ScaleType });
    captions.show(scaleText(store.get().tuning));
  });
  harmonyMix.addEventListener('input', () => update({ harmonyMix: Number(harmonyMix.value) / 100 }));

  store.watch(
    (s) => s.tuning,
    (t) => {
      tuneOn.checked = t.enabled;
      tuningSection.classList.toggle('is-off', !t.enabled);
      harmonySection.classList.toggle('is-off', !t.enabled);
      tuneKey.value = String(t.root);
      tuneKey.disabled = !t.enabled || t.type === 'chromatic';
      tuneScale.value = t.type;
      tuneScale.disabled = !t.enabled;
      knob.value = t.retuneMs;
      retuneValue.textContent = `${t.retuneMs} ms`;
      retuneValue.classList.toggle('is-zero', t.retuneMs === 0);
      for (const chip of harmonyChips) {
        chip.setAttribute('aria-pressed', String(t.harmony.includes(chip.dataset.voice as HarmonyVoice)));
        chip.disabled = !t.enabled;
      }
      harmonyMix.value = String(Math.round(t.harmonyMix * 100));
      harmonyMix.disabled = !t.enabled || t.harmony.length === 0;
      harmonyMixValue.textContent = `${Math.round(t.harmonyMix * 100)}%`;
    },
  );
}
