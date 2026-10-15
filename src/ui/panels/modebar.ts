// Workspace modes (top bar): Studio (everything), Record, Remix, Edit and Fun. A mode shows the
// inspector sections and centre parts its job needs and hides the rest (songs, settings and audio
// are untouched); Edit also switches note editing on. Keys 1–5 switch, the last mode is remembered.
// Popped-out sections follow too (their windows and placeholders hide with them).

import type { Session } from '../../app/session';
import { openProject, type AppStore, type Workspace } from '../../app/state';
import { saveWorkspace } from '../../storage/settings';
import type { Captions } from '../captions';
import { $, $$ } from '../dom';

/** What each mode shows: inspector sections (by id) and whether the mixer/timeline is visible. */
const MODES: Record<Workspace, { sections: string[] | 'all'; tracks: boolean; caption: string }> = {
  studio: { sections: 'all', tracks: true, caption: 'Studio: everything at hand' },
  record: { sections: ['input-panel', 'tuning-panel', 'harmony-panel', 'voice-panel', 'tempo-panel'], tracks: false, caption: 'Record: sing, hear yourself, count in' },
  remix: { sections: ['cleanup-panel', 'voice-panel', 'fx-panel', 'tempo-panel', 'songfx-panel'], tracks: true, caption: 'Remix: mix, effects, key and tempo' },
  edit: { sections: ['note-panel', 'tuning-panel', 'harmony-panel'], tracks: true, caption: 'Edit: drag your notes into place' },
  fun: { sections: ['input-panel', 'tuning-panel', 'harmony-panel', 'voice-panel'], tracks: false, caption: 'Fun: robots, chipmunks and chords' },
};

export const WORKSPACES = Object.keys(MODES) as Workspace[];

export function mountModebar(store: AppStore, session: Session, captions: Captions): void {
  const buttons = $$<HTMLButtonElement>('.mode-btn[data-workspace]');
  const songChip = $('modebar-song');
  const tracks = $('tracks');

  for (const b of buttons) b.addEventListener('click', () => setWorkspace(b.dataset.workspace as Workspace));

  function setWorkspace(next: Workspace): void {
    const prev = store.get().workspace;
    if (next === prev) return;
    store.set({ workspace: next });
    captions.show(MODES[next].caption);
    // Edit = note editing (when there is a vocal track to edit); leaving it ends note editing.
    if (next === 'edit' && store.get().mode === 'playback' && store.get().projectId) session.toggleNoteMode(true);
    else if (prev === 'edit' && store.get().noteMode) session.toggleNoteMode(false);
  }

  // 1–5 switch modes (not while typing).
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox') return;
    if (t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < WORKSPACES.length) setWorkspace(WORKSPACES[i]);
  });

  /** Shows/hides an element for the mode (independent of the panels' own `hidden`). */
  const show = (el: Element | null, on: boolean) => {
    if (!el) return;
    if (on) el.removeAttribute('data-mode-hidden');
    else el.setAttribute('data-mode-hidden', '');
  };

  store.watch(
    (s) => s.workspace,
    (workspace) => {
      saveWorkspace(workspace);
      document.body.dataset.workspace = workspace;
      for (const b of buttons) {
        const on = b.dataset.workspace === workspace;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      const mode = MODES[workspace];
      // Docked or floating, a section is found by id; a floating one's placeholder follows it.
      for (const section of $$<HTMLElement>('details.section[id]')) {
        const on = mode.sections === 'all' || mode.sections.includes(section.id);
        show(section, on);
        show(section.closest('.float-panel'), on);
        show(document.querySelector(`.popout-placeholder[data-for="${section.id}"]`), on);
      }
      show(tracks, mode.tracks);
    },
  );
  document.body.dataset.workspace = store.get().workspace;

  store.watch(
    (s) => openProject(s)?.name ?? null,
    (name) => {
      songChip.hidden = !name;
      songChip.textContent = name ?? '';
      songChip.title = name ? `Open song: ${name}` : '';
    },
  );

  // Sections popped out or docked later still follow the mode (windows go to <body>, placeholders
  // into the inspector).
  const follow = new MutationObserver(() => {
    const mode = MODES[store.get().workspace];
    for (const panel of $$<HTMLElement>('.float-panel')) {
      const section = panel.querySelector<HTMLElement>('details.section[id]');
      if (section) show(panel, mode.sections === 'all' || mode.sections.includes(section.id));
    }
    for (const ph of $$<HTMLElement>('.popout-placeholder[data-for]')) {
      show(ph, mode.sections === 'all' || mode.sections.includes(ph.dataset.for!));
    }
  });
  follow.observe(document.body, { childList: true });
  follow.observe($('controls-col'), { childList: true });
}
