// Desktop smokes run beside someone's work: by default the app opens its windows without taking
// focus (AGENT_OFFICE_QUIET), and steps that need the real OS focus are skipped. CI, or
// AGENT_OFFICE_FOCUS_TESTS=1 on a machine nobody is using, runs those steps too.
export const focusTests = process.env.AGENT_OFFICE_FOCUS_TESTS === '1' || !!process.env.CI;

/** Extra environment for `electron.launch`. */
export const quietEnv = focusTests ? {} : { AGENT_OFFICE_QUIET: '1' };

/** Brings `page` to the front and waits for it to hold the keyboard; a no-op in quiet runs. */
export async function takeFocus(page) {
  if (!focusTests) return false;
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  return true;
}

if (!focusTests)
  console.log('Quiet run: windows open behind your work; OS focus checks are skipped.');
