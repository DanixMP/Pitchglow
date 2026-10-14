// Clean-up section of the inspector: offline noise reduction.

import { denoiseAmountText, denoiseSwitchText } from '../../app/explain';
import type { AppStore } from '../../app/state';
import type { Captions } from '../captions';
import { $ } from '../dom';

export function mountCleanupPanel(store: AppStore, captions: Captions): void {
  const denoiseOn = $<HTMLInputElement>('denoise-on');
  const amount = $<HTMLInputElement>('denoise-amount');
  const amountField = $('denoise-amount-field');
  const amountValue = $('denoise-amount-value');
  let captionTimer = 0;

  denoiseOn.addEventListener('change', () => {
    store.set((s) => ({ cleanup: { ...s.cleanup, denoise: denoiseOn.checked } }));
    captions.show(denoiseSwitchText(denoiseOn.checked));
  });
  amount.addEventListener('input', () => {
    store.set((s) => ({ cleanup: { ...s.cleanup, denoiseDb: Number(amount.value) } }));
    window.clearTimeout(captionTimer);
    captionTimer = window.setTimeout(() => captions.show(denoiseAmountText(store.get().cleanup.denoiseDb)), 350);
  });

  store.watch(
    (s) => s.cleanup,
    (c) => {
      denoiseOn.checked = c.denoise;
      amount.value = String(c.denoiseDb);
      amount.disabled = !c.denoise;
      amountField.classList.toggle('is-off', !c.denoise);
      amountValue.textContent = `${c.denoiseDb} dB`;
    },
  );
}
