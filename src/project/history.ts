// Undo/redo history of snapshots (one per open song). Rapid edits of the same thing (a fader drag,
// a clip drag, typing a name) coalesce into one step when they share a key and arrive close together.

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(
    private readonly limit = 100,
    private readonly coalesceMs = 800,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Record `before` (the state prior to an edit). Same `key` within `coalesceMs` = same step. */
  push(before: T, key: string | null = null, now = Date.now()): void {
    const coalesce = key !== null && key === this.lastKey && now - this.lastAt <= this.coalesceMs;
    this.lastKey = key;
    this.lastAt = now;
    this.redoStack = [];
    if (coalesce) return; // the step already holds the state from before the first edit
    this.undoStack.push(before);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /** Returns the state to restore (and remembers `current` for redo), or null. */
  undo(current: T): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    this.lastKey = null;
    return prev;
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    this.lastKey = null;
    return next;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = null;
  }
}
