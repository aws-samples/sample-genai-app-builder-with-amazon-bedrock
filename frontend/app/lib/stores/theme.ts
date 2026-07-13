import { atom } from 'nanostores';

export type Theme = 'light';

export const kTheme = 'bolt_theme';

export function themeIsDark() {
  return false;
}

export const DEFAULT_THEME = 'light' as const;

export const themeStore = atom<Theme>('light');
