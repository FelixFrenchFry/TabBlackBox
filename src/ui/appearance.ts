export type Appearance = 'system' | 'light' | 'dark';
const key = 'tabblackbox.appearance';

export function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}

export function setAppearance(value: Appearance): void {
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event('appearancechange'));
}

export function initializeAppearance(): void {
  const match = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const appearance = readAppearance();
    const mode = appearance === 'system' ? (match.matches ? 'dark' : 'light') : appearance;
    document.documentElement.dataset.colorMode = mode;
    document.documentElement.dataset.lightTheme = 'light';
    document.documentElement.dataset.darkTheme = 'dark';
    document.documentElement.style.colorScheme = mode;
  };
  apply();
  match.addEventListener('change', apply);
  window.addEventListener('appearancechange', apply);
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(); });
}
