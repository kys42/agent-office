import type { BrowserWindowConstructorOptions } from 'electron';

export const WINDOWS_TITLEBAR_HEIGHT = 36;
/** Native caption controls keep Windows snap, keyboard and accessibility behavior. */
export function windowStyle(
  platform: NodeJS.Platform,
  dark: boolean,
): BrowserWindowConstructorOptions {
  const backgroundColor = dark ? '#1c1c1e' : '#f5f5f7';
  if (platform === 'darwin')
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 20 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
    };
  if (platform === 'win32')
    return {
      backgroundColor,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        height: WINDOWS_TITLEBAR_HEIGHT,
        color: dark ? '#232325' : '#ffffff',
        symbolColor: dark ? '#f5f5f7' : '#1c1c1e',
      },
    };
  return { backgroundColor };
}

/**
 * Windows and Linux: a window without its own menu falls back to the app menu (Edit), whose
 * accelerators (Ctrl+C, Ctrl+A, …) fire before the page sees the key, so a terminal in that
 * window never gets them. Chromium still handles copy/paste in text fields without a menu, as
 * in the main window. macOS keeps its menu bar (⌘ shortcuts do not collide with Ctrl keys).
 */
export function dropAppMenu(
  window: { removeMenu(): void; setMenuBarVisibility(visible: boolean): void },
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === 'darwin') return false;
  window.removeMenu();
  window.setMenuBarVisibility(false);
  return true;
}

/** macOS: the glass a card sits on (desktop/card-windows.ts `material`). */
export type CardMaterial = 'under-window' | 'popover';
/**
 * macOS: where a card in its own window draws its traffic lights, over the card's header (whose
 * left padding leaves them room: `body.card-window.is-mac` in native.css).
 */
export const CARD_TRAFFIC_LIGHTS = { x: 16, y: 22 };

/**
 * A card window's frame (desktop/card-windows.ts). A card panel is a frameless, transparent card
 * kept out of the taskbar; on macOS a `panel`, which floats beside other apps without being one of
 * this app's windows. A card in its own window (`own`, `CardPin` `window`) is an ordinary app
 * window: titled, in the taskbar, Mission Control and ⌘` window cycling, on the one desktop
 * (Space) it was opened on. On macOS it keeps the card's glass and draws only the traffic lights
 * over the card's header (the header moves it); Windows and Linux give it their own frame.
 */
export function cardWindowStyle(
  platform: NodeJS.Platform,
  own: boolean,
  material: CardMaterial,
  dark: boolean,
): BrowserWindowConstructorOptions {
  if (own)
    return platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: CARD_TRAFFIC_LIGHTS,
          vibrancy: material,
          visualEffectState: 'active',
          backgroundColor: '#00000000',
        }
      : { backgroundColor: dark ? '#1c1c1e' : '#f5f5f7' };
  return {
    maximizable: false,
    frame: false,
    transparent: true,
    fullscreenable: false,
    skipTaskbar: true,
    ...(platform === 'darwin'
      ? {
          vibrancy: material,
          visualEffectState: 'active' as const,
          roundedCorners: true,
          type: 'panel' as const,
        }
      : {}),
  };
}
