import type { ITheme } from '@xterm/xterm';

const style = getComputedStyle(document.documentElement);
const cssVar = (token: string) => style.getPropertyValue(token) || undefined;

export function getTerminalTheme(overrides?: ITheme): ITheme {
  return {
    cursor: cssVar('--vibe-elements-terminal-cursorColor'),
    cursorAccent: cssVar('--vibe-elements-terminal-cursorColorAccent'),
    foreground: cssVar('--vibe-elements-terminal-textColor'),
    background: cssVar('--vibe-elements-terminal-backgroundColor'),
    selectionBackground: cssVar('--vibe-elements-terminal-selection-backgroundColor'),
    selectionForeground: cssVar('--vibe-elements-terminal-selection-textColor'),
    selectionInactiveBackground: cssVar('--vibe-elements-terminal-selection-backgroundColorInactive'),

    // ansi escape code colors
    black: cssVar('--vibe-elements-terminal-color-black'),
    red: cssVar('--vibe-elements-terminal-color-red'),
    green: cssVar('--vibe-elements-terminal-color-green'),
    yellow: cssVar('--vibe-elements-terminal-color-yellow'),
    blue: cssVar('--vibe-elements-terminal-color-blue'),
    magenta: cssVar('--vibe-elements-terminal-color-magenta'),
    cyan: cssVar('--vibe-elements-terminal-color-cyan'),
    white: cssVar('--vibe-elements-terminal-color-white'),
    brightBlack: cssVar('--vibe-elements-terminal-color-brightBlack'),
    brightRed: cssVar('--vibe-elements-terminal-color-brightRed'),
    brightGreen: cssVar('--vibe-elements-terminal-color-brightGreen'),
    brightYellow: cssVar('--vibe-elements-terminal-color-brightYellow'),
    brightBlue: cssVar('--vibe-elements-terminal-color-brightBlue'),
    brightMagenta: cssVar('--vibe-elements-terminal-color-brightMagenta'),
    brightCyan: cssVar('--vibe-elements-terminal-color-brightCyan'),
    brightWhite: cssVar('--vibe-elements-terminal-color-brightWhite'),

    ...overrides,
  };
}
