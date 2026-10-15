// Pop-out inspector sections: every <details class="section"> in the inspector gets a ⧉ button that
// lifts it out into a floating window over the studio (drag it by its title, resize it from the
// corner) and docks it back in place with one click. The section element itself moves, so every
// panel's bindings keep working. Floating sections and their positions are remembered per browser.
// Phones (< 760 px) have no room for windows: everything docks there and floats again when wide.

const STORE_KEY = 'recorder.popouts';
const POP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z"/></svg>';
const DOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h6v2H7v10h10v-4h2v6H5zm15.4-.6L14.4 10.4H18v2h-7v-7h2V9l6-6z"/></svg>';

interface Saved {
  x: number;
  y: number;
  w?: number;
}

interface Floating {
  panel: HTMLDivElement;
  placeholder: HTMLElement;
  observer: MutationObserver;
}

function load(): Record<string, Saved> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Saved>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function save(state: Record<string, Saved>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: windows just won't be remembered.
  }
}

export function mountPopouts(column: HTMLElement): void {
  const sections = [...column.querySelectorAll<HTMLDetailsElement>(':scope > details.section[id]')];
  const floating = new Map<string, Floating>();
  let saved = load();
  let topZ = 40;
  const wide = window.matchMedia('(min-width: 760px)');

  const titleOf = (section: HTMLDetailsElement) => section.querySelector('summary')?.firstChild?.textContent?.trim() || 'Section';

  // Layout boxes (offset*), not getBoundingClientRect: the open animation scales the window.
  // Only the width is kept (the height follows the section's content).
  const remember = (id: string, panel: HTMLDivElement | null) => {
    if (panel) {
      if (panel.offsetWidth === 0) return; // hidden (its section doesn't apply right now): keep the old place
      saved[id] = { x: panel.offsetLeft, y: panel.offsetTop, w: panel.offsetWidth };
    } else delete saved[id];
    save(saved);
  };

  const front = (panel: HTMLDivElement) => {
    for (const f of floating.values()) f.panel.classList.toggle('is-front', f.panel === panel);
    panel.style.zIndex = String(++topZ);
  };

  /** Keeps a window on screen (its title bar at least). */
  const clamp = (panel: HTMLDivElement) => {
    const x = Math.min(Math.max(8, panel.offsetLeft), window.innerWidth - Math.min(panel.offsetWidth, 120));
    const y = Math.min(Math.max(8, panel.offsetTop), window.innerHeight - 44);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  };

  const setButton = (section: HTMLDetailsElement, popped: boolean) => {
    const btn = section.querySelector<HTMLButtonElement>(':scope > summary .popout-btn')!;
    btn.innerHTML = popped ? DOCK_ICON : POP_ICON;
    const label = `${popped ? 'Dock' : 'Pop out'} ${titleOf(section)}`;
    btn.setAttribute('aria-label', label);
    btn.title = popped ? 'Back into the inspector' : 'Pop out into a floating window';
  };

  function popOut(section: HTMLDetailsElement, at?: Saved): void {
    if (floating.has(section.id)) return;
    const placeholder = document.createElement('div');
    placeholder.className = 'popout-placeholder';
    placeholder.innerHTML = `<span>${titleOf(section)} · floating</span>`;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-small btn-ghost';
    back.textContent = 'Dock';
    back.addEventListener('click', () => dock(section));
    placeholder.append(back);
    placeholder.hidden = section.hidden;
    section.replaceWith(placeholder);

    const panel = document.createElement('div');
    panel.className = 'float-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', `${titleOf(section)} (floating)`);
    panel.append(section);
    document.body.append(panel);
    section.open = true;
    // Next to the inspector, staggered, unless it has a remembered place.
    const colRect = column.getBoundingClientRect();
    const n = floating.size;
    const x = at?.x ?? Math.max(8, (colRect.width > 0 ? colRect.left : window.innerWidth) - 340 - n * 24);
    const y = at?.y ?? 70 + n * 28;
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    if (at?.w && at.w >= 260) panel.style.width = `${at.w}px`;
    clamp(panel);
    // Panels hide sections that don't apply (e.g. Note outside note mode): so does the window.
    const observer = new MutationObserver(() => {
      panel.hidden = section.hidden;
      placeholder.hidden = section.hidden;
    });
    observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
    panel.hidden = section.hidden;
    floating.set(section.id, { panel, placeholder, observer });
    setButton(section, true);
    front(panel);
    attachDrag(section, panel);
    panel.addEventListener('pointerdown', () => front(panel));
    // Remember size changes from the resize corner.
    new ResizeObserver(() => floating.has(section.id) && remember(section.id, panel)).observe(panel);
    remember(section.id, panel);
  }

  function dock(section: HTMLDetailsElement, forget = true): void {
    const f = floating.get(section.id);
    if (!f) return;
    f.observer.disconnect();
    floating.delete(section.id);
    f.placeholder.replaceWith(section);
    f.panel.remove();
    setButton(section, false);
    if (forget) remember(section.id, null);
  }

  /** Drag a window by its title; a drag doesn't open/close the section, a click still does. */
  function attachDrag(section: HTMLDetailsElement, panel: HTMLDivElement): void {
    const head = section.querySelector('summary')!;
    let drag: { id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean } | null = null;
    head.addEventListener('pointerdown', (e) => {
      if (!floating.has(section.id) || (e.target as Element).closest('.popout-btn') || e.button !== 0) return;
      drag = { id: e.pointerId, dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop, x0: e.clientX, y0: e.clientY, moved: false };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      panel.classList.add('is-dragging');
      panel.style.left = `${e.clientX - drag.dx}px`;
      panel.style.top = `${e.clientY - drag.dy}px`;
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      panel.classList.remove('is-dragging');
      if (!moved) return;
      clamp(panel);
      remember(section.id, panel);
      // Swallow the click that follows a drag (it would fold the section).
      head.addEventListener('click', (c) => c.preventDefault(), { once: true, capture: true });
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  for (const section of sections) {
    const head = section.querySelector(':scope > summary');
    if (!head) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popout-btn';
    head.append(btn);
    setButton(section, false);
    btn.addEventListener('click', (e) => {
      e.preventDefault(); // not a fold/unfold of the section
      e.stopPropagation();
      if (floating.has(section.id)) dock(section);
      else popOut(section);
    });
  }

  // Phones: dock everything (keeping the remembered windows); wide again: float them again.
  const applyWidth = () => {
    if (!wide.matches) {
      for (const section of sections) dock(section, false);
      return;
    }
    saved = load();
    for (const section of sections) if (saved[section.id]) popOut(section, saved[section.id]);
  };
  wide.addEventListener('change', applyWidth);
  window.addEventListener('resize', () => {
    for (const f of floating.values()) clamp(f.panel);
  });
  applyWidth();
}
