// Minimal typed state container: the single source of truth that UI panels render from.

export type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  /** Shallow-merges a patch (or the result of a function of the current state) and notifies listeners. */
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void {
    const prev = this.state;
    const p = typeof patch === 'function' ? patch(prev) : patch;
    this.state = { ...prev, ...p };
    for (const l of [...this.listeners]) l(this.state, prev);
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Calls `onChange` whenever `select(state)` changes (by Object.is), and once immediately.
   * Select a tuple/object of several values with `shallow: true` to compare them element-wise.
   */
  watch<S>(select: (state: T) => S, onChange: (value: S, state: T) => void, opts: { shallow?: boolean } = {}): () => void {
    const equal = opts.shallow ? shallowEqual : Object.is;
    let current = select(this.state);
    onChange(current, this.state);
    return this.subscribe((state) => {
      const next = select(state);
      if (equal(next, current)) return;
      current = next;
      onChange(next, state);
    });
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
