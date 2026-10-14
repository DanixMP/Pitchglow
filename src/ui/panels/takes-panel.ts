// Left column: the takes library with search.

import type { Session } from '../../app/session';
import type { AppStore } from '../../app/state';
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
    onRename: (id, name) => session.renameRecording(id, name),
    onExport: (id) => session.exportRecording(id),
    onDelete: (id) => {
      const meta = store.get().recordings.find((r) => r.id === id);
      if (meta && confirm(`Delete “${meta.name}”? This can’t be undone.`)) session.deleteRecording(id);
    },
  });

  const render = () => {
    const { recordings, openId } = store.get();
    const q = search.value.trim().toLowerCase();
    const shown = q ? recordings.filter((r) => r.name.toLowerCase().includes(q)) : recordings;
    list.render(shown, openId, q ? `No takes match “${search.value.trim()}”.` : undefined);
    count.textContent = recordings.length ? String(recordings.length) : '';
  };

  search.addEventListener('input', render);
  store.watch((s) => [s.recordings, s.openId] as const, render, { shallow: true });
}
