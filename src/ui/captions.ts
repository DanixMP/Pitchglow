// Short explainer captions over the piano roll, revealed word by word like the narration in Goal.mp4
// ("This is my voice.", "Each of these lanes is one key on a piano.", …).

const BASE_MS = 1400;
const PER_WORD_MS = 260;
const WORD_STAGGER_S = 0.09;

export class Captions {
  private timer = 0;
  private queue: string[] = [];

  constructor(private readonly el: HTMLElement) {}

  /** Shows one caption, or several in sequence. Replaces whatever is showing. */
  show(text: string | string[]): void {
    this.queue = Array.isArray(text) ? [...text] : [text];
    window.clearTimeout(this.timer);
    this.next();
  }

  clear(): void {
    window.clearTimeout(this.timer);
    this.queue = [];
    this.el.classList.remove('is-visible');
  }

  private next(): void {
    const text = this.queue.shift();
    if (text === undefined) {
      this.el.classList.remove('is-visible');
      return;
    }
    const words = text.split(/\s+/);
    // Real spaces between the word spans, so screen readers and copy/paste get normal text.
    this.el.replaceChildren(
      ...words.flatMap((w, i) => {
        const span = document.createElement('span');
        span.className = 'caption-word';
        span.textContent = w;
        span.style.animationDelay = `${i * WORD_STAGGER_S}s`;
        return i === 0 ? [span] : [document.createTextNode(' '), span];
      }),
    );
    // Restart the fade-in even if a caption is already visible.
    this.el.classList.remove('is-visible');
    void this.el.offsetWidth;
    this.el.classList.add('is-visible');
    this.timer = window.setTimeout(() => this.next(), BASE_MS + words.length * PER_WORD_MS);
  }
}
