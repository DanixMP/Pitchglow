import { AudioInput, type InputKind } from './audio/audio-input';
import { PitchTracker, type PitchFrame } from './audio/pitch-tracker';
import { nearestNote, noteName } from './dsp/notes';
import { PianoRoll } from './ui/piano-roll';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const roll = new PianoRoll($<HTMLCanvasElement>('roll'));
const noteEl = $('note');
const detailEl = $('detail');
const statusEl = $('status');
const buttons: Record<InputKind, HTMLButtonElement> = { mic: $('mic'), demo: $('demo') };
const idleLabels: Record<InputKind, string> = { mic: 'Start mic', demo: 'Demo tone' };

let tracker: PitchTracker | null = null;
let latest: PitchFrame | null = null;
let active: InputKind | null = null;

const input = new AudioInput((block) => tracker?.push(block));

async function toggle(kind: InputKind): Promise<void> {
  const wasActive = active;
  await stop();
  if (wasActive === kind) return;

  statusEl.textContent = '';
  try {
    const sampleRate = await input.start(kind);
    tracker = new PitchTracker(sampleRate, (frame) => {
      latest = frame;
      roll.push(frame);
    });
    roll.start();
    active = kind;
    setButton(kind, true);
  } catch (err) {
    statusEl.textContent = describeError(err);
  }
}

async function stop(): Promise<void> {
  if (!active) return;
  setButton(active, false);
  active = null;
  tracker = null;
  latest = null;
  roll.stop();
  await input.stop();
}

function setButton(kind: InputKind, on: boolean): void {
  const btn = buttons[kind];
  btn.classList.toggle('is-active', on);
  const label = btn.querySelector('span') ?? btn;
  label.textContent = on ? 'Stop' : idleLabels[kind];
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone access was blocked. Allow it in the browser’s site settings and try again.';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'No microphone found.';
  return `Could not start audio: ${err instanceof Error ? err.message : String(err)}`;
}

function updateReadout(): void {
  if (!active) {
    noteEl.textContent = '–';
    detailEl.textContent = 'Press Start mic and say something';
  } else if (latest?.midi != null && latest.freq != null) {
    const { note, cents } = nearestNote(latest.midi);
    const c = Math.round(cents);
    noteEl.textContent = noteName(note);
    detailEl.textContent = `${latest.freq.toFixed(1)} Hz · ${c >= 0 ? '+' : '−'}${Math.abs(c)}¢`;
  } else {
    detailEl.textContent = 'Listening…';
  }
}

buttons.mic.addEventListener('click', () => void toggle('mic'));
buttons.demo.addEventListener('click', () => void toggle('demo'));

function frame(t: number): void {
  roll.render(t);
  updateReadout();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
