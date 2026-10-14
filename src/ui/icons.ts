// Inline SVG icons (24x24 paths) and an icon-button factory shared by the lists.

export const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  download: '<path d="M11 4h2v8.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3zM5 18h14v2H5z"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7zm4 2v8h1.5v-8zm2.5 0v8H14v-8z"/>',
  add: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  copy: '<path d="M8 3h11v13h-2V5H8zM5 7h10v14H5zm2 2v10h6V9z"/>',
  close: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function iconButton(kind: IconName, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn icon-${kind}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
  return btn;
}

/** Inline-editable name: Enter commits, Escape reverts, empty input reverts. */
export function nameInput(value: string, label: string, onCommit: (name: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.className = 'rec-name';
  input.value = value;
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = value;
      input.blur();
    }
  });
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v && v !== value) onCommit(v);
    else input.value = value;
  });
  return input;
}

/** MIME type used when dragging a take onto the tracks list. */
export const TAKE_DRAG_TYPE = 'application/x-recorder-take';
