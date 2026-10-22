import { useSyncExternalStore } from 'react';

/** The non-standard event Chromium fires when the app can be installed. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Capture the install prompt and register the service worker (production builds only). */
export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* no service worker available – the app still works */
      });
    });
  }
}

/** Whether the browser offers installing the app, and a function to show its prompt. */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<void> } {
  const available = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => deferred !== null,
  );
  return {
    canInstall: available,
    install: async () => {
      const e = deferred;
      if (!e) return;
      await e.prompt();
      try {
        await e.userChoice;
      } finally {
        // The prompt can only be used once.
        deferred = null;
        emit();
      }
    },
  };
}
