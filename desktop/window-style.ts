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
