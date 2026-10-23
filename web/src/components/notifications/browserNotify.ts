const KEY = 'sm.browserNotifications';

export const browserNotificationsSupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;

/** The user's opt-in (stored per browser). */
export function getBrowserNotifyOptIn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setBrowserNotifyOptIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked – the toggle just won't persist */
  }
}

/** Opted in and the browser permission is granted. */
export function browserNotifyActive(): boolean {
  return browserNotificationsSupported() && getBrowserNotifyOptIn() && Notification.permission === 'granted';
}

/** Show a system notification; clicking it focuses the app and calls onClick. */
export function showBrowserNotification(title: string, body: string, tag: string, onClick?: () => void): void {
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some browsers (e.g. Android Chrome) only allow notifications from a service worker */
  }
}
