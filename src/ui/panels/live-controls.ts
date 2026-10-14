// Listen / Record buttons and the status line.

import { INTRO_CAPTIONS } from '../../app/explain';
import type { Session } from '../../app/session';
import type { AppStore } from '../../app/state';
import type { Captions } from '../captions';
import { $ } from '../dom';

const INTRO_KEY = 'recorder.introSeen';

export function mountLiveControls(store: AppStore, session: Session, captions: Captions): void {
  const listen = $<HTMLButtonElement>('listen');
  const record = $<HTMLButtonElement>('record');
  const status = $('status');

  listen.addEventListener('click', () =>
    session.run(async () => {
      if (store.get().mode === 'listening') return session.stopLive();
      await session.startLive(false);
      explainIntro();
    }),
  );
  record.addEventListener('click', () =>
    session.run(async () => {
      if (store.get().mode === 'recording') return session.stopLive();
      await session.startLive(true);
      explainIntro();
    }),
  );

  store.watch(
    (s) => s.mode,
    (mode) => {
      listen.classList.toggle('is-active', mode === 'listening');
      listen.querySelector('span')!.textContent = mode === 'listening' ? 'Stop' : 'Listen';
      listen.disabled = mode === 'recording';
      record.classList.toggle('is-active', mode === 'recording');
      record.querySelector('.label')!.textContent = mode === 'recording' ? 'Stop' : 'Record';
    },
  );
  store.watch(
    (s) => s.status,
    (text) => (status.textContent = text),
  );

  /** One-time explanation of the lanes, the first time the user starts the mic. */
  function explainIntro(): void {
    try {
      if (localStorage.getItem(INTRO_KEY)) return;
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      return;
    }
    captions.show(INTRO_CAPTIONS);
  }
}
