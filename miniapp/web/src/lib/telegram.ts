// Minimal hand-rolled surface of the Telegram WebApp JS API we actually
// use -- keeps runtime deps at 3 (react/react-dom/zustand) instead of
// pulling in a full @telegram-apps/sdk dependency for a handful of fields.
export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string; username?: string } };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  MainButton: {
    setText: (text: string) => void;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  HapticFeedback: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
  onEvent: (event: 'themeChanged' | 'viewportChanged', cb: () => void) => void;
  offEvent: (event: 'themeChanged' | 'viewportChanged', cb: () => void) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

/** Boot: stamp html[data-scheme] from Telegram's colorScheme, keep it in
 * sync on theme changes, and let the CSS light remap defer to Telegram's
 * own --tg-theme-* vars (injected natively into the webview). */
export function bootTelegramTheme(): void {
  const app = getWebApp();
  if (!app) {
    // Not running inside Telegram (e.g. plain browser dev) -- stay dark,
    // the app's designed-first theme.
    document.documentElement.dataset.scheme = 'dark';
    return;
  }
  app.ready();
  app.expand();
  const apply = () => {
    document.documentElement.dataset.scheme = app.colorScheme;
  };
  apply();
  app.onEvent('themeChanged', apply);
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  getWebApp()?.HapticFeedback.impactOccurred(style);
}
