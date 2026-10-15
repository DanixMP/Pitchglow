// Neon slider (Phase 16): enhances every <input type="range"> in place.
//
// The native input stays: it holds the value, keeps focus, keyboard control (arrows, Page Up/Down,
// Home/End) and ARIA, and panels keep listening to its 'input' / 'change' / 'dblclick' events. On top
// of it this draws a glowing track, fill (from the centre for ranges around 0), detent ticks, a thumb
// and a value bubble, and takes over pointer handling:
// - drag relative to where you grab (the thumb never jumps under the pointer); click the track to
//   jump there; Shift = fine (a tenth of the speed);
// - detents: the value snaps to "home" values (0 dB, centre pan, 0 st, data-detents) when close;
//   hold Alt to place it freely; data-ticks picks which of them get a tick mark (default: all);
// - data-fill="start" fills from the left even for ranges around 0 (volume faders);
// - mouse wheel while focused steps the value; double-click resets (forwarded to the input, plus
//   data-default if set);
// - vertical scrolling still works over a slider on touch screens (touch-action: pan-y).
// Values set from code (input.value = …) update the picture too.

import { clamp, fillOrigin, parseDetents, ratioOf, snapToDetent, toStep, dragValue, type SliderRange } from './slider-math';

const ENHANCED = 'nsEnhanced';
const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;

class NeonSlider {
  readonly root: HTMLSpanElement;
  private readonly fill: HTMLSpanElement;
  private readonly bubble: HTMLSpanElement;
  private readonly ticks: HTMLSpanElement;
  private drag: { pointerId: number; lastX: number; raw: number; moved: boolean } | null = null;
  private bubbleTimer = 0;

  constructor(private readonly input: HTMLInputElement) {
    const root = document.createElement('span');
    // The wrapper takes the input's place (and its layout classes), the input sits inside it.
    root.className = `ns ${input.className}`.trim();
    input.className = 'ns-input';
    root.innerHTML =
      '<span class="ns-track" aria-hidden="true"><span class="ns-fill"></span><span class="ns-ticks"></span></span>' +
      '<span class="ns-thumb" aria-hidden="true"></span><span class="ns-bubble" aria-hidden="true"></span>';
    input.replaceWith(root);
    root.prepend(input);
    this.root = root;
    this.fill = root.querySelector('.ns-fill')!;
    this.bubble = root.querySelector('.ns-bubble')!;
    this.ticks = root.querySelector('.ns-ticks')!;

    // Programmatic `input.value = …` should move the thumb too.
    const self = this;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return valueDescriptor.get!.call(this);
      },
      set(v: string) {
        valueDescriptor.set!.call(this, v);
        self.render();
      },
    });
    input.addEventListener('input', () => this.render());
    input.addEventListener('focus', () => root.classList.add('is-focused'));
    input.addEventListener('blur', () => {
      root.classList.remove('is-focused');
      this.hideBubble();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key.startsWith('Arrow') || e.key.startsWith('Page') || e.key === 'Home' || e.key === 'End') this.showBubble(900);
    });
    new MutationObserver(() => this.layout()).observe(input, { attributes: true, attributeFilter: ['min', 'max', 'step', 'disabled', 'data-detents', 'data-ticks'] });
    this.attachPointer();
    this.layout();
  }

  private get range(): SliderRange {
    return { min: Number(this.input.min || 0), max: Number(this.input.max || 100), step: Number(this.input.step || 1) };
  }

  /** Where the fill starts: the centre of a range around 0, or the left with data-fill="start" (faders). */
  private origin(r: SliderRange): number {
    return this.input.dataset.fill === 'start' ? 0 : fillOrigin(r);
  }

  private get detents(): number[] {
    return parseDetents(this.input.dataset.detents, this.range);
  }

  /** Static parts: detent ticks, fill origin, disabled state. */
  private layout(): void {
    const r = this.range;
    // `data-ticks` shows fewer marks than there are detents (e.g. a detent on every semitone).
    const marks = this.input.dataset.ticks !== undefined ? parseDetents(this.input.dataset.ticks, r) : this.detents;
    this.ticks.replaceChildren(
      ...marks.map((d) => {
        const t = document.createElement('i');
        t.style.left = `${ratioOf(d, r) * 100}%`;
        return t;
      }),
    );
    this.root.style.setProperty('--ns-origin', String(this.origin(r)));
    this.root.classList.toggle('is-disabled', this.input.disabled);
    this.render();
  }

  render(): void {
    const r = this.range;
    const t = ratioOf(Number(valueDescriptor.get!.call(this.input)), r);
    const o = this.origin(r);
    this.root.style.setProperty('--ns-t', t.toFixed(4));
    this.fill.style.left = `${Math.min(o, t) * 100}%`;
    this.fill.style.width = `${Math.abs(t - o) * 100}%`;
    this.root.classList.toggle('is-home', this.detents.some((d) => Math.abs(d - Number(this.input.value)) < 1e-9));
    if (this.root.classList.contains('show-bubble')) this.updateBubble();
  }

  // --- value bubble ---------------------------------------------------------------------------

  private updateBubble(): void {
    // After the app has reacted to the change (it formats the value next to the slider).
    requestAnimationFrame(() => {
      const label = this.root.nextElementSibling?.classList.contains('slider-value') ? this.root.nextElementSibling.textContent : null;
      this.bubble.textContent = this.input.getAttribute('aria-valuetext') || label || this.input.value;
    });
  }

  private showBubble(hideAfterMs = 0): void {
    window.clearTimeout(this.bubbleTimer);
    this.root.classList.add('show-bubble');
    this.updateBubble();
    if (hideAfterMs) this.bubbleTimer = window.setTimeout(() => this.hideBubble(), hideAfterMs);
  }

  private hideBubble(): void {
    window.clearTimeout(this.bubbleTimer);
    this.root.classList.remove('show-bubble');
  }

  // --- pointer ------------------------------------------------------------------------------

  /** Sets a value as the user would: stepped, clamped, and announced with an 'input' event. */
  private commit(v: number): void {
    const next = toStep(v, this.range);
    if (next === Number(this.input.value)) return;
    valueDescriptor.set!.call(this.input, String(next));
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private attachPointer(): void {
    const root = this.root;
    root.addEventListener('pointerdown', (e) => {
      if (this.input.disabled || e.button !== 0) return;
      e.preventDefault();
      this.input.focus({ preventScroll: true });
      const r = this.range;
      let raw = Number(this.input.value);
      // A press on the track (not the thumb) jumps there first.
      if (!(e.target as HTMLElement).closest('.ns-thumb')) {
        const rect = root.getBoundingClientRect();
        raw = r.min + ((e.clientX - rect.left) / rect.width) * (r.max - r.min);
        this.commit(snapToDetent(raw, this.detents, r, e.altKey));
      }
      this.drag = { pointerId: e.pointerId, lastX: e.clientX, raw, moved: false };
      root.setPointerCapture(e.pointerId);
      root.classList.add('is-dragging');
      this.showBubble();
    });
    root.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      const r = this.range;
      d.raw = clamp(dragValue(d.raw, e.clientX - d.lastX, root.getBoundingClientRect().width, r, e.shiftKey), r);
      d.lastX = e.clientX;
      d.moved = true;
      this.commit(snapToDetent(d.raw, this.detents, r, e.altKey));
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      root.classList.remove('is-dragging');
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
      this.showBubble(700);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('dblclick', (e) => {
      if (this.input.disabled) return;
      // Panels reset on the input's dblclick; data-default covers inputs without a handler.
      this.input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, altKey: e.altKey }));
      const def = this.input.dataset.default;
      if (def !== undefined) this.commit(Number(def));
    });
    root.addEventListener(
      'wheel',
      (e) => {
        if (document.activeElement !== this.input || this.input.disabled) return;
        e.preventDefault();
        const r = this.range;
        const dir = e.deltaY < 0 || e.deltaX > 0 ? 1 : -1;
        this.commit(Number(this.input.value) + dir * (r.step || (r.max - r.min) / 100) * (e.shiftKey ? 1 : 2));
        this.showBubble(900);
      },
      { passive: false },
    );
  }
}

/** Enhances one range input (once). */
export function enhanceSlider(input: HTMLInputElement): void {
  if (input.dataset[ENHANCED]) return;
  input.dataset[ENHANCED] = '1';
  new NeonSlider(input);
}

/** Enhances every range input in `root` now and whenever new ones are added (mixer rows etc.). */
export function watchSliders(root: ParentNode & Node = document.body): void {
  const scan = (node: ParentNode) => {
    for (const el of node.querySelectorAll<HTMLInputElement>('input[type="range"]')) enhanceSlider(el);
  };
  scan(root);
  new MutationObserver((records) => {
    for (const rec of records) {
      for (const n of rec.addedNodes) {
        if (n instanceof HTMLInputElement && n.type === 'range') enhanceSlider(n);
        else if (n instanceof Element) scan(n);
      }
    }
  }).observe(root, { childList: true, subtree: true });
}
