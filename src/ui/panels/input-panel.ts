// Input section: Mic / Demo tone, "Hear myself" (live monitoring) with its latency/CPU readout, the
// browser's live mic noise filter, count-in, sync nudge and latency calibration.

import { micFilterText, monitorText } from '../../app/explain';
import type { Session } from '../../app/session';
import type { AppStore } from '../../app/state';
import type { InputKind } from '../../audio/audio-input';
import type { Captions } from '../captions';
import { confirmDialog } from '../confirm';
import { $, $$ } from '../dom';

export function mountInputPanel(store: AppStore, session: Session, captions: Captions): void {
  const chips = $$<HTMLButtonElement>('.source .chip');
  const micFilter = $<HTMLInputElement>('mic-filter');
  const monitor = $<HTMLInputElement>('monitor');
  const monitorStats = $('monitor-stats');

  monitor.addEventListener('change', () => {
    store.set((s) => ({ input: { ...s.input, monitor: monitor.checked } }));
    captions.show(monitorText(monitor.checked));
  });
  store.watch(
    (s) => [s.input.monitor, s.live, s.mode] as const,
    ([on, live, mode]) => {
      monitor.checked = on;
      const running = on && (mode === 'listening' || mode === 'recording') && live.latencyMs !== null;
      monitorStats.hidden = !running;
      if (!running) return;
      const parts = [`≈ ${live.latencyMs} ms mic to ears`, `CPU ${Math.round(live.load * 100)}%`];
      if (live.degraded) parts.push('fewer harmonies (CPU)');
      monitorStats.textContent = parts.join(' · ');
      monitorStats.classList.toggle('is-warn', live.degraded || live.load > 0.5);
    },
    { shallow: true },
  );
  const countIn = $<HTMLInputElement>('count-in');
  const nudge = $<HTMLInputElement>('sync-nudge');
  const nudgeValue = $('sync-nudge-value');
  const calibrate = $<HTMLButtonElement>('calibrate');
  const calibrateResult = $('calibrate-result');
  const calibrateReset = $<HTMLButtonElement>('calibrate-reset');

  countIn.addEventListener('change', () => store.set((s) => ({ input: { ...s.input, countIn: countIn.checked } })));
  nudge.addEventListener('input', () => store.set((s) => ({ input: { ...s.input, nudgeMs: Number(nudge.value) } })));
  nudge.addEventListener('dblclick', () => store.set((s) => ({ input: { ...s.input, nudgeMs: 0 } })));
  calibrate.addEventListener('click', () => {
    void confirmDialog({
      title: 'Calibrate latency',
      message:
        'This plays 6 clicks through your speakers and listens with the mic.\n\n' +
        'Use speakers (not headphones), turn the volume up and keep quiet for 3 seconds.',
      confirmLabel: 'Start',
      dontAskKey: 'calibrate',
    }).then((yes) => yes && session.calibrateLatency());
  });
  calibrateReset.addEventListener('click', () => store.set((s) => ({ input: { ...s.input, calibratedMs: null } })));

  store.watch(
    (s) => [s.input, s.calibrating] as const,
    ([input, calibrating]) => {
      countIn.checked = input.countIn;
      nudge.value = String(input.nudgeMs);
      nudgeValue.textContent = `${input.nudgeMs > 0 ? '+' : ''}${input.nudgeMs} ms`;
      calibrate.disabled = calibrating;
      calibrate.textContent = calibrating ? 'Listening…' : 'Calibrate latency';
      calibrateResult.textContent =
        input.calibratedMs !== null ? `Measured ${input.calibratedMs} ms round trip` : 'Using the browser’s latency estimate';
      calibrateReset.hidden = input.calibratedMs === null;
    },
    { shallow: true },
  );

  for (const chip of chips) {
    chip.addEventListener('click', () =>
      session.run(async () => {
        store.set({ source: chip.dataset.source as InputKind });
        if (store.get().mode === 'listening') await session.startLive(false); // switch the running input
      }),
    );
  }

  micFilter.addEventListener('change', () =>
    session.run(async () => {
      store.set((s) => ({ cleanup: { ...s.cleanup, micFilter: micFilter.checked } }));
      // Restart a running mic so the browser's filter takes effect now.
      const { mode, source } = store.get();
      if (mode === 'listening' && source === 'mic') await session.startLive(false);
      captions.show(micFilterText(micFilter.checked));
    }),
  );

  store.watch(
    (s) => [s.source, s.mode, s.cleanup.micFilter] as const,
    ([source, mode, filterOn]) => {
      for (const chip of chips) {
        const on = chip.dataset.source === source;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-checked', String(on));
        chip.disabled = mode === 'recording';
      }
      micFilter.checked = filterOn;
      micFilter.disabled = mode === 'recording'; // changing it mid-take would change the recording's sound
    },
    { shallow: true },
  );
}
