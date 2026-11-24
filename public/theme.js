(() => {
  const preferenceKey = 'rowa-theme';
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function applyTheme(dark, button) {
    root.dataset.theme = dark ? 'dark' : 'light';
    themeColor.content = dark ? '#19131c' : '#fff8f5';
    button?.setAttribute('aria-pressed', String(dark));
  }

  let dark = false;
  try {
    dark = localStorage.getItem(preferenceKey) === 'dark';
  } catch {
    // The toggle still works for this page when storage is denied.
  }
  applyTheme(dark);
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    applyTheme(dark, button);
    button.addEventListener('click', () => {
      dark = !dark;
      applyTheme(dark, button);
      try {
        localStorage.setItem(preferenceKey, root.dataset.theme);
      } catch {
        // Keep the active theme without persisting it.
      }
    });
  });
})();
