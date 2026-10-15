// Custom confirmation pop-up (replaces window.confirm): a neon card in a modal <dialog> (focus kept
// inside, Esc or a click outside cancels), with an optional "Don't ask again" switch. Skipped
// questions are remembered per browser (localStorage) and can be asked again via resetDontAsk().

const DONT_ASK_KEY = 'recorder.dontAsk';

export interface ConfirmOptions {
  title: string;
  /** Plain text; blank lines start new paragraphs. */
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button (deleting things). */
  danger?: boolean;
  /** Offers "Don't ask again" for this question; once ticked, it's answered yes without asking. */
  dontAskKey?: string;
}

function skipped(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DONT_ASK_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function setSkipped(keys: string[]): void {
  try {
    localStorage.setItem(DONT_ASK_KEY, JSON.stringify([...new Set(keys)]));
  } catch {
    // Storage unavailable: it will just ask again next time.
  }
  for (const fn of listeners) fn();
}

const listeners = new Set<() => void>();

/** Questions currently answered without asking. */
export function skippedQuestions(): string[] {
  return skipped();
}

/** Asks every skipped question again. */
export function resetDontAsk(): void {
  setSkipped([]);
}

/** Called whenever the skipped questions change. */
export function onDontAskChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let open: Promise<boolean> | null = null;

/** Asks; resolves true when confirmed (at once if the question was set to "don't ask again"). */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (opts.dontAskKey && skipped().includes(opts.dontAskKey)) return Promise.resolve(true);
  if (open) return open.then(() => confirmDialog(opts)); // one at a time
  open = new Promise<boolean>((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    const titleId = `confirm-title-${Date.now()}`;
    dialog.setAttribute('aria-labelledby', titleId);

    const title = document.createElement('h2');
    title.id = titleId;
    title.className = 'confirm-title';
    title.textContent = opts.title;
    const body = document.createElement('div');
    body.className = 'confirm-body';
    for (const para of opts.message.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      p.textContent = para.trim();
      body.append(p);
    }
    dialog.append(title, body);

    let dontAsk: HTMLInputElement | null = null;
    if (opts.dontAskKey) {
      const label = document.createElement('label');
      label.className = 'switch switch-quiet confirm-dontask';
      label.innerHTML =
        '<input type="checkbox" role="switch" /><span class="switch-track" aria-hidden="true"></span>' +
        '<span class="switch-label">Don’t ask again <span class="switch-hint">you can turn questions back on under Takes</span></span>';
      dontAsk = label.querySelector('input');
      dialog.append(label);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = opts.cancelLabel ?? 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`;
    ok.textContent = opts.confirmLabel;
    actions.append(cancel, ok);
    dialog.append(actions);

    const finish = (answer: boolean) => {
      if (answer && dontAsk?.checked && opts.dontAskKey) setSkipped([...skipped(), opts.dontAskKey]);
      dialog.close();
      dialog.remove();
      open = null;
      resolve(answer);
    };
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault(); // Esc
      finish(false);
    });
    // A click on the backdrop (outside the card) cancels.
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    // Destructive questions start on Cancel (Enter shouldn't delete by accident).
    (opts.danger ? cancel : ok).focus();
  });
  return open;
}
