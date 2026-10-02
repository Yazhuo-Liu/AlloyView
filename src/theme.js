const STORAGE_KEY = 'alloyview-theme';
// The supplied filenames describe the lettering: dark letters on light UI,
// light letters on dark UI.
const LOGOS = {
  light: new URL('./asserts/logo/AlloyView_logo_dark.svg', import.meta.url).href,
  dark: new URL('./asserts/logo/AlloyView_logo_light.svg', import.meta.url).href,
};

export function initializeTheme(onChange = () => {}) {
  const preference = matchMedia('(prefers-color-scheme: light)');
  let selected = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') selected = saved;
  } catch {
    // File loading and the theme switch also work when storage is disabled.
  }

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    const logo = document.getElementById('brand-logo');
    logo.src = LOGOS[theme];
    for (const value of ['light', 'dark']) {
      document.getElementById(`theme-${value}`).setAttribute('aria-pressed', String(theme === value));
    }
    onChange(theme);
  }

  for (const theme of ['light', 'dark']) {
    document.getElementById(`theme-${theme}`).addEventListener('click', () => {
      selected = theme;
      try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Storage is optional. */ }
      apply(theme);
    });
  }
  preference.addEventListener('change', () => {
    if (!selected) apply(preference.matches ? 'light' : 'dark');
  });
  apply(selected ?? (preference.matches ? 'light' : 'dark'));
}
