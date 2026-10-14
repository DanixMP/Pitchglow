// The saved-recordings list: select, play, rename, export WAV, delete.

import type { RecordingMeta } from '../storage/recording-store';
import { formatTime } from './format';

export interface RecordingsListHandlers {
  onSelect(id: string): void;
  onPlay(id: string): void;
  onRename(id: string, name: string): void;
  onExport(id: string): void;
  onDelete(id: string): void;
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  download: '<path d="M11 4h2v8.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3zM5 18h14v2H5z"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7zm4 2v8h1.5v-8zm2.5 0v8H14v-8z"/>',
};

function iconButton(kind: keyof typeof ICONS, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn icon-${kind}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
  return btn;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export class RecordingsList {
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: RecordingsListHandlers,
  ) {}

  render(items: readonly RecordingMeta[], selectedId: string | null, emptyText?: string): void {
    this.root.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'rec-empty';
      empty.textContent = emptyText ?? 'No takes yet. Press Record to make your first one.';
      this.root.append(empty);
      return;
    }
    for (const item of items) this.root.append(this.renderItem(item, item.id === selectedId));
  }

  private renderItem(item: RecordingMeta, selected: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'rec' + (selected ? ' is-selected' : '');
    li.dataset.id = item.id;

    const play = iconButton('play', `Play ${item.name}`);
    play.addEventListener('click', () => this.handlers.onPlay(item.id));

    const info = document.createElement('div');
    info.className = 'rec-info';
    const name = document.createElement('input');
    name.className = 'rec-name';
    name.value = item.name;
    name.setAttribute('aria-label', 'Recording name');
    name.spellcheck = false;
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = item.name;
        name.blur();
      }
    });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v && v !== item.name) this.handlers.onRename(item.id, v);
      else name.value = item.name;
    });
    const meta = document.createElement('span');
    meta.className = 'rec-meta';
    meta.textContent = `${formatTime(item.duration)} · ${dateFormat.format(item.createdAt)}`;
    info.append(name, meta);

    const exportBtn = iconButton('download', `Download ${item.name} as WAV`);
    exportBtn.addEventListener('click', () => this.handlers.onExport(item.id));
    const del = iconButton('trash', `Delete ${item.name}`);
    del.addEventListener('click', () => this.handlers.onDelete(item.id));

    li.append(play, info, exportBtn, del);
    // Clicking the row (but not its controls) selects it.
    li.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button, input')) this.handlers.onSelect(item.id);
    });
    return li;
  }
}
