// Apply the stored theme as soon as a page module loads.
export function applyStoredTheme(theme = 'auto', root = document.documentElement) {
  if (theme === 'dark') {
    root.classList.remove('theme-light');
    root.classList.add('theme-dark');
  } else if (theme === 'light') {
    root.classList.remove('theme-dark');
    root.classList.add('theme-light');
  } else {
    root.classList.remove('theme-light');
    const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const syncAutoTheme = () => {
      root.classList.toggle('theme-dark', colorSchemeMedia.matches);
    };
    syncAutoTheme();
    colorSchemeMedia.addEventListener('change', syncAutoTheme);
  }
}

chrome.storage.local.get(['theme'], (result) => {
  applyStoredTheme(result.theme || 'auto');
});
