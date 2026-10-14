// Responsive shell: 3 columns on desktop, takes drawer on tablet, bottom tab bar on phones.
// Only toggles classes/ARIA; the actual layout is in style.css.

import type { AppStore, MobileTab } from '../../app/state';
import { $, $$ } from '../dom';

export function mountLayout(store: AppStore): void {
  const studio = $('studio');
  const tabs = $$<HTMLButtonElement>('.tabbar .tab');
  const toggle = $<HTMLButtonElement>('takes-toggle');
  const close = $<HTMLButtonElement>('takes-close');
  const backdrop = $('drawer-backdrop');

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const t = tab.dataset.tab as Exclude<MobileTab, null>;
      // Tapping the open tab collapses the panel so the roll gets the whole screen.
      store.set((s) => ({ mobileTab: s.mobileTab === t ? null : t }));
    });
  }
  toggle.addEventListener('click', () => store.set((s) => ({ takesDrawerOpen: !s.takesDrawerOpen })));
  close.addEventListener('click', () => store.set({ takesDrawerOpen: false, mobileTab: null }));
  backdrop.addEventListener('click', () => store.set({ takesDrawerOpen: false }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && store.get().takesDrawerOpen) store.set({ takesDrawerOpen: false });
  });

  store.watch(
    (s) => s.mobileTab,
    (tab) => {
      studio.dataset.tab = tab ?? '';
      for (const t of tabs) {
        const on = t.dataset.tab === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-expanded', String(on));
      }
    },
  );
  // Tablet: the closed drawer is off-screen, so make it unreachable by Tab/screen readers too.
  const takesCol = $('takes-col');
  const tablet = window.matchMedia('(min-width: 760px) and (max-width: 1099px)');
  const applyInert = () => {
    takesCol.inert = tablet.matches && !store.get().takesDrawerOpen;
  };
  tablet.addEventListener('change', applyInert);

  store.watch(
    (s) => s.takesDrawerOpen,
    (open) => {
      studio.classList.toggle('is-drawer-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      backdrop.hidden = !open;
      applyInert();
      if (open) $('takes-search').focus({ preventScroll: true });
      else if (takesCol.contains(document.activeElement) && tablet.matches) toggle.focus({ preventScroll: true });
    },
  );
}
