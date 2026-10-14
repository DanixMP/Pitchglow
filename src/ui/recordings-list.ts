// The takes list: select, play, rename, export WAV, delete — and, while a song is open, add a take to
// it (+ button, or drag the row onto the tracks list).

import type { RecordingMeta } from '../storage/recording-store';
import { formatTime } from './format';
import { iconButton, nameInput, TAKE_DRAG_TYPE } from './icons';

export interface RecordingsListHandlers {
  onSelect(id: string): void;
  onPlay(id: string): void;
  onRename(id: string, name: string): void;
  onExport(id: string): void;
  onDelete(id: string): void;
  onAdd(id: string): void;
}

export interface RecordingsListOptions {
  emptyText?: string;
  /** A song is open: show the add button and allow dragging. */
  canAdd?: boolean;
  /** Takes already used by the open song (marked in the list). */
  inSong?: ReadonlySet<string>;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export class RecordingsList {
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: RecordingsListHandlers,
  ) {}

  render(items: readonly RecordingMeta[], selectedId: string | null, opts: RecordingsListOptions = {}): void {
    this.root.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'rec-empty';
      empty.textContent = opts.emptyText ?? 'No takes yet. Press Record to make your first one.';
      this.root.append(empty);
      return;
    }
    for (const item of items) this.root.append(this.renderItem(item, item.id === selectedId, opts));
  }

  private renderItem(item: RecordingMeta, selected: boolean, opts: RecordingsListOptions): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'rec' + (selected ? ' is-selected' : '');
    li.dataset.id = item.id;

    const play = iconButton('play', `Play ${item.name}`);
    play.addEventListener('click', () => this.handlers.onPlay(item.id));

    const info = document.createElement('div');
    info.className = 'rec-info';
    const name = nameInput(item.name, 'Take name', (v) => this.handlers.onRename(item.id, v));
    const meta = document.createElement('span');
    meta.className = 'rec-meta';
    meta.textContent = `${formatTime(item.duration)} · ${dateFormat.format(item.createdAt)}`;
    if (opts.inSong?.has(item.id)) {
      const badge = document.createElement('span');
      badge.className = 'rec-badge';
      badge.textContent = 'in song';
      meta.append(' ', badge);
    }
    info.append(name, meta);

    const actions: HTMLElement[] = [];
    if (opts.canAdd) {
      const add = iconButton('add', `Add ${item.name} to the song`);
      add.classList.add('icon-btn-accent');
      add.addEventListener('click', () => this.handlers.onAdd(item.id));
      actions.push(add);
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(TAKE_DRAG_TYPE, item.id);
        e.dataTransfer?.setData('text/plain', item.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
        li.classList.add('is-dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('is-dragging'));
    }
    const exportBtn = iconButton('download', `Download ${item.name} as WAV`);
    exportBtn.addEventListener('click', () => this.handlers.onExport(item.id));
    const del = iconButton('trash', `Delete ${item.name}`);
    del.addEventListener('click', () => this.handlers.onDelete(item.id));
    actions.push(exportBtn, del);

    li.append(play, info, ...actions);
    // Clicking the row (but not its controls) selects it.
    li.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button, input')) this.handlers.onSelect(item.id);
    });
    return li;
  }
}
