// Input section: Mic / Demo tone and the browser's live mic noise filter.

import { micFilterText } from '../../app/explain';
import type { Session } from '../../app/session';
import type { AppStore } from '../../app/state';
import type { InputKind } from '../../audio/audio-input';
import type { Captions } from '../captions';
import { $, $$ } from '../dom';

export function mountInputPanel(store: AppStore, session: Session, captions: Captions): void {
  const chips = $$<HTMLButtonElement>('.source .chip');
  const micFilter = $<HTMLInputElement>('mic-filter');

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
