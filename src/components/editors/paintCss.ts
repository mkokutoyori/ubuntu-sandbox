import type { CSSProperties } from 'react';
import type { Paint } from '@/network/devices/linux/editors/screen/EditorScreen';

const TERMINAL_FOREGROUND = '#d3d7cf';
const TERMINAL_BACKGROUND = '#300a24';

const ANSI_COLORS = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function paletteColor(index: number): string {
  if (index < 16) return ANSI_COLORS[index];
  if (index < 232) {
    const cube = index - 16;
    return `#${hex(CUBE_LEVELS[Math.floor(cube / 36)])}${hex(CUBE_LEVELS[Math.floor(cube / 6) % 6])}${hex(CUBE_LEVELS[cube % 6])}`;
  }
  const grey = 8 + 10 * (index - 232);
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}

export function paintStyle(paint: Paint): CSSProperties {
  const foreground = paint.fg === null ? TERMINAL_FOREGROUND : paletteColor(paint.fg);
  const background = paint.bg === null ? TERMINAL_BACKGROUND : paletteColor(paint.bg);
  const shown = paint.reverse
    ? { color: background, backgroundColor: foreground }
    : { color: foreground, ...(paint.bg === null ? {} : { backgroundColor: background }) };
  return {
    ...shown,
    ...(paint.bold ? { fontWeight: 'bold' } : {}),
    ...(paint.italic ? { fontStyle: 'italic' } : {}),
    ...(paint.underline ? { textDecoration: 'underline' } : {}),
  };
}
