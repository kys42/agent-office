/** Browser hints are presentation only; native capabilities must still be checked in main. */
export const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
export const isWindows = /Windows/.test(navigator.userAgent);
export const modifierKey = isMac ? '⌘' : 'Ctrl';
export const platformKeys = (text: string) => text.replaceAll('⌘', modifierKey);
