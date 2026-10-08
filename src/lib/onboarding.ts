// Presentation preference only: never stored in the collector or provider sessions.
const key = (demo: boolean) => `office:onboarding:v1:${demo ? 'demo' : 'live'}`;
export function hasSeenOnboarding(demo: boolean) {
  try {
    return localStorage.getItem(key(demo)) === 'seen';
  } catch {
    return false;
  }
}
export function rememberOnboarding(demo: boolean) {
  try {
    localStorage.setItem(key(demo), 'seen');
  } catch {
    // Closing still works for this visit if storage is unavailable.
  }
}
