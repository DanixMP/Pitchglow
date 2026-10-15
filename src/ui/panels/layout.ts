// Responsive shell: 3 columns on desktop, takes drawer on tablet, bottom tab bar on phones.
// Desktop columns close to a thin rail with one click ([ and ] too), remembered per browser.
// Only toggles classes/ARIA; the actual layout is in style.css.

import type { AppStore, MobileTab } from '../../app/state';
import { saveLayout } from '../../storage/settings';
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

  // Collapsible columns.
  const setLayout = (patch: Partial<ReturnType<AppStore['get']>['layout']>) => store.set((s) => ({ layout: { ...s.layout, ...patch } }));
  $('left-collapse').addEventListener('click', () => setLayout({ leftCollapsed: true }));
  $('left-open').addEventListener('click', () => setLayout({ leftCollapsed: false }));
  for (const b of $$<HTMLButtonElement>('[data-rail-open]')) {
    b.addEventListener('click', () => {
      setLayout({ leftCollapsed: false });
      if (b.dataset.railOpen === 'takes') $('takes-search').focus({ preventScroll: true });
      else $('song-new').focus({ preventScroll: true });
    });
  }
  $('right-collapse').addEventListener('click', () => setLayout({ rightCollapsed: true }));
  $('right-open').addEventListener('click', () => setLayout({ rightCollapsed: false }));
  store.watch(
    (s) => s.layout,
    (layout) => {
      studio.classList.toggle('is-left-collapsed', layout.leftCollapsed);
      studio.classList.toggle('is-right-collapsed', layout.rightCollapsed);
      for (const [id, open] of [['left-collapse', !layout.leftCollapsed], ['left-open', !layout.leftCollapsed], ['right-collapse', !layout.rightCollapsed], ['right-open', !layout.rightCollapsed]] as const) {
        $(id).setAttribute('aria-expanded', String(open));
      }
      saveLayout(layout);
    },
  );
  const initial = store.get().layout;
  studio.classList.toggle('is-left-collapsed', initial.leftCollapsed);
  studio.classList.toggle('is-right-collapsed', initial.rightCollapsed);

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
