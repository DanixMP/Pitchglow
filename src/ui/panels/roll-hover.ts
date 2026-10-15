// Context cursor for the piano roll (Phase 16): a neon crosshair (style.css) plus a label with the
// note under the pointer, so you can read any lane at a glance. Mouse / pen only (no hover on touch).

import { noteName } from '../../dsp/notes';
import type { PianoRoll } from '../piano-roll';

export function mountRollHover(roll: PianoRoll, canvas: HTMLCanvasElement): void {
  const stage = canvas.parentElement!;
  const label = document.createElement('span');
  label.className = 'roll-hover';
  label.hidden = true;
  label.setAttribute('aria-hidden', 'true');
  stage.append(label);
  const canHover = window.matchMedia('(hover: hover)');

  canvas.addEventListener('pointermove', (e) => {
    if (!canHover.matches || e.pointerType === 'touch' || canvas.classList.contains('is-scrubbing')) {
      label.hidden = true;
      return;
    }
    const hit = roll.noteAt(e.clientX, e.clientY);
    if (!hit) {
      label.hidden = true;
      return;
    }
    const rect = stage.getBoundingClientRect();
    label.textContent = noteName(hit.midi);
    label.style.left = `${e.clientX - rect.left}px`;
    label.style.top = `${e.clientY - rect.top}px`;
    label.hidden = false;
  });
  canvas.addEventListener('pointerleave', () => (label.hidden = true));
  canvas.addEventListener('pointerdown', () => (label.hidden = true));
}
