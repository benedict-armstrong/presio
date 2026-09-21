// Apply the saved/system theme before first paint so reloads don't flash
// light-then-dark. Keep this logic in sync with src/lib/theme.tsx.
//
// A separate file rather than an inline <script> so it loads under a
// script-src of 'self'. Inline execution needs 'unsafe-inline' or a per-build
// hash; the first guts the CSP and the second silently stops matching the
// moment this code changes, which would bring the flash back with nothing to
// show for it. Loaded synchronously in <head>, so it still runs before paint.
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch { /* localStorage unavailable, e.g. private mode */ }
})();
