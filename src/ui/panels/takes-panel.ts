// Left column: the takes library with search; "+" / drag to add a take to the open song.

import type { Session } from '../../app/session';
import { openProject, type AppStore } from '../../app/state';
import { projectsUsingTake } from '../../project/model';
import { $ } from '../dom';
import { RecordingsList } from '../recordings-list';

export function mountTakesPanel(store: AppStore, session: Session): void {
  const search = $<HTMLInputElement>('takes-search');
  const count = $('takes-count');

  const closeDrawer = () => store.set({ takesDrawerOpen: false });
  const list = new RecordingsList($('recordings'), {
    onSelect: (id) => {
      session.openRecording(id, false);
      closeDrawer();
    },
    onPlay: (id) => {
      session.openRecording(id, true);
      closeDrawer();
    },
    onAdd: (id) => session.addTakeToProject(id),
    onRename: (id, name) => session.renameRecording(id, name),
    onExport: (id) => session.exportRecording(id),
    onDelete: (id) => {
      const { recordings, projects } = store.get();
      const meta = recordings.find((r) => r.id === id);
      if (!meta) return;
      const used = projectsUsingTake(projects, id);
      const warning = used.length
        ? `\n\nIt’s used in ${used.length === 1 ? `“${used[0].name}”` : `${used.length} songs`}; those tracks will be removed too.`
        : '';
      if (confirm(`Delete “${meta.name}”? This can’t be undone.${warning}`)) session.deleteRecording(id);
    },
  });

  const render = () => {
    const state = store.get();
    const q = search.value.trim().toLowerCase();
    const shown = q ? state.recordings.filter((r) => r.name.toLowerCase().includes(q)) : state.recordings;
    const song = openProject(state);
    list.render(shown, state.openId, {
      emptyText: q ? `No takes match “${search.value.trim()}”.` : undefined,
      canAdd: !!song,
      inSong: new Set(song?.tracks.map((t) => t.takeId).filter((id): id is string => !!id)),
    });
    count.textContent = state.recordings.length ? String(state.recordings.length) : '';
  };

  search.addEventListener('input', render);
  // Only re-render when something shown changes (not on every fader move inside the open song).
  const songTakes = (s: ReturnType<AppStore['get']>) => {
    const song = openProject(s);
    return song ? `${song.id}:${song.tracks.map((t) => t.takeId).join(',')}` : '';
  };
  store.watch((s) => [s.recordings, s.openId, songTakes(s)] as const, render, { shallow: true });
}
