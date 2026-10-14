// Rotary knob (Goal.mp4, 0:50 "Retune speed"). Drag up/down, scroll, or use the arrow keys.
// Double-click resets to the default value.

export interface KnobOptions {
  min: number;
  max: number;
  value: number;
  defaultValue?: number;
  step?: number;
  /** Bigger step for Shift+arrow / PageUp / PageDown. */
  bigStep?: number;
  label: string;
  format?: (v: number) => string;
  onInput?: (v: number) => void;
}

const SWEEP = 270; // degrees from min to max
const DRAG_PIXELS = 220; // vertical drag distance for the full range

export class Knob {
  readonly element: HTMLDivElement;
  private readonly indicator: SVGGElement;
  private readonly arc: SVGPathElement;
  private _value: number;

  constructor(private readonly opts: KnobOptions) {
    this._value = opts.value;
    const el = document.createElement('div');
    el.className = 'knob';
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', opts.label);
    el.setAttribute('aria-valuemin', String(opts.min));
    el.setAttribute('aria-valuemax', String(opts.max));
    el.innerHTML = `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path class="knob-track" d="${arcPath(0, 1)}" />
        <path class="knob-arc" />
        <circle class="knob-body" cx="32" cy="32" r="19" />
        <g class="knob-indicator"><line x1="32" y1="17" x2="32" y2="24" /></g>
      </svg>`;
    this.element = el;
    this.indicator = el.querySelector('.knob-indicator')!;
    this.arc = el.querySelector('.knob-arc')!;
    this.attach();
    this.update();
  }

  get value(): number {
    return this._value;
  }

  set value(v: number) {
    this._value = this.clamp(v);
    this.update();
  }

  private clamp(v: number): number {
    const step = this.opts.step ?? 1;
    const snapped = Math.round(v / step) * step;
    return Math.min(this.opts.max, Math.max(this.opts.min, snapped));
  }

  private set(v: number): void {
    const next = this.clamp(v);
    if (next === this._value) return;
    this._value = next;
    this.update();
    this.opts.onInput?.(next);
  }

  private update(): void {
    const { min, max, format } = this.opts;
    const t = (this._value - min) / (max - min);
    this.indicator.setAttribute('transform', `rotate(${-SWEEP / 2 + t * SWEEP} 32 32)`);
    this.arc.setAttribute('d', t > 0.001 ? arcPath(0, t) : '');
    this.element.setAttribute('aria-valuenow', String(this._value));
    this.element.setAttribute('aria-valuetext', format ? format(this._value) : String(this._value));
  }

  private attach(): void {
    const el = this.element;
    const range = this.opts.max - this.opts.min;
    let drag: { id: number; y: number; start: number } | null = null;

    el.addEventListener('pointerdown', (e) => {
      drag = { id: e.pointerId, y: e.clientY, start: this._value };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-dragging');
      e.preventDefault();
      el.focus();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const fine = e.shiftKey ? 0.25 : 1;
      this.set(drag.start + ((drag.y - e.clientY) / DRAG_PIXELS) * range * fine);
    });
    const end = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      el.classList.remove('is-dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.set(this._value - Math.sign(e.deltaY) * (this.opts.step ?? 1) * (e.shiftKey ? 1 : 5));
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => this.set(this.opts.defaultValue ?? this.opts.min));
    el.addEventListener('keydown', (e) => {
      const step = this.opts.step ?? 1;
      const big = this.opts.bigStep ?? step * 10;
      const moves: Record<string, number> = {
        ArrowUp: step,
        ArrowRight: step,
        ArrowDown: -step,
        ArrowLeft: -step,
        PageUp: big,
        PageDown: -big,
      };
      if (e.key in moves) this.set(this._value + moves[e.key] * (e.shiftKey && !e.key.startsWith('Page') ? 10 : 1));
      else if (e.key === 'Home') this.set(this.opts.min);
      else if (e.key === 'End') this.set(this.opts.max);
      else return;
      e.preventDefault();
    });
  }
}

/** SVG arc around the knob from fraction a to b of the sweep. */
function arcPath(a: number, b: number): string {
  const r = 27;
  const toXY = (t: number) => {
    const deg = -SWEEP / 2 + t * SWEEP - 90;
    const rad = (deg * Math.PI) / 180;
    return [32 + r * Math.cos(rad), 32 + r * Math.sin(rad)];
  };
  const [x1, y1] = toXY(a);
  const [x2, y2] = toXY(b);
  const large = (b - a) * SWEEP > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
