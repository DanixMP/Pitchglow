// Installable-app plumbing: service worker registration (production only) and the Install button.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupPwa(installButton: HTMLButtonElement): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker not registered:', err));
    });
  }

  // Chrome/Edge/Android fire this when the app is installable; show our own button for it.
  let deferred: BeforeInstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    if (!deferred) return;
    installButton.hidden = true;
    await deferred.prompt();
    deferred = null;
  });
  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
  });
}
