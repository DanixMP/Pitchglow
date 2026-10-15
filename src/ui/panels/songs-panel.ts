// Left column: songs (projects) — new, open, rename, save as a file, duplicate, delete.

import type { Session } from '../../app/session';
import type { AppStore } from '../../app/state';
import type { Project } from '../../project/model';
import { confirmDialog } from '../confirm';
import { $ } from '../dom';
import { iconButton, nameInput } from '../icons';

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function mountSongsPanel(store: AppStore, session: Session): void {
  const list = $('songs');
  const count = $('songs-count');

  $('song-new').addEventListener('click', () => {
    session.newProject();
    store.set({ takesDrawerOpen: false });
  });

  const renderItem = (p: Project, open: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'rec song' + (open ? ' is-selected' : '');
    li.dataset.id = p.id;

    const dot = document.createElement('span');
    dot.className = 'song-dots';
    dot.setAttribute('aria-hidden', 'true');
    for (const t of p.tracks.slice(0, 5)) {
      const d = document.createElement('i');
      d.style.background = t.hue < 0 ? '#8a8a90' : `hsl(${t.hue} 70% 62%)`;
      dot.append(d);
    }
    if (p.tracks.length === 0) dot.append(document.createElement('i'));

    const info = document.createElement('div');
    info.className = 'rec-info';
    const name = nameInput(p.name, 'Song name', (v) => session.renameProject(p.id, v));
    const meta = document.createElement('span');
    meta.className = 'rec-meta';
    const n = p.tracks.length;
    meta.textContent = `${n} ${n === 1 ? 'track' : 'tracks'} · ${dateFormat.format(p.updatedAt)}`;
    info.append(name, meta);

    const save = iconButton('download', `Save ${p.name} as a file (.recsong: takes and beat included)`);
    save.addEventListener('click', () => session.exportProjectFile(p.id));
    const dup = iconButton('copy', `Duplicate ${p.name}`);
    dup.addEventListener('click', () => session.duplicateProject(p.id));
    const del = iconButton('trash', `Delete ${p.name}`);
    del.addEventListener('click', () => {
      void confirmDialog({
        title: `Delete the song “${p.name}”?`,
        message: 'Its tracks, mix and effects are removed. The takes stay in your library, and a saved .recsong file can bring the song back.',
        confirmLabel: 'Delete song',
        danger: true,
        dontAskKey: 'delete-song',
      }).then((yes) => yes && session.deleteProject(p.id));
    });

    li.append(dot, info, save, dup, del);
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, input')) return;
      session.openProject(p.id);
      store.set({ takesDrawerOpen: false });
    });
    return li;
  };

  // Signature of what the list shows, so fader moves inside a song don't rebuild the list.
  const signature = (projects: readonly Project[]) =>
    projects.map((p) => `${p.id}|${p.name}|${p.tracks.map((t) => t.hue).join(',')}|${new Date(p.updatedAt).toDateString()}`).join(';');

  store.watch(
    (s) => [signature(s.projects), s.projectId] as const,
    ([, projectId]) => {
      const { projects } = store.get();
      list.replaceChildren();
      if (projects.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'rec-empty';
        empty.textContent = 'No songs yet. A song layers takes into tracks.';
        list.append(empty);
      }
      for (const p of projects) list.append(renderItem(p, p.id === projectId));
      count.textContent = projects.length ? String(projects.length) : '';
    },
    { shallow: true },
  );
}
