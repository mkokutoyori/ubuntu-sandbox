import { nextLineId } from '@/terminal/sessions/TerminalSession';
import { parseAnsiToSegments } from '@/terminal/core/OutputFormatter';
import type { RichOutputLine, LineType } from '@/terminal/core/types';

const PS_ERROR_MARKER =
  /is not recognized as the name of a cmdlet|^\s*\+ CategoryInfo|^\s*\+ FullyQualifiedErrorId|^At line:\d+ char:\d+/;

const WARNING_PREFIX = /^\s*(WARNING|VERBOSE|DEBUG):/;

const HEADER = /^\S.* : /;

export const WINDOWS_ERROR_COLOR = '#f14c4c';
export const WINDOWS_WARNING_COLOR = '#cca700';

export interface ClassifiedLine {
  text: string;
  type: LineType;
}

export function classifyWindowsLines(text: string): ClassifiedLine[] {
  const lines = text.split('\n');
  let firstMarker = -1;
  let lastMarker = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PS_ERROR_MARKER.test(lines[i])) {
      if (firstMarker === -1) firstMarker = i;
      lastMarker = i;
    }
  }
  let errStart = -1;
  let errEnd = -1;
  if (firstMarker !== -1) {
    errStart = firstMarker;
    for (let i = firstMarker; i >= 0; i--) {
      if (lines[i].trim() === '') break;
      if (HEADER.test(lines[i])) { errStart = i; break; }
    }
    errEnd = lastMarker;
    while (errEnd + 1 < lines.length && lines[errEnd + 1].trim() !== '') errEnd++;
  }
  return lines.map((line, i) => {
    if (WARNING_PREFIX.test(line)) return { text: line, type: 'warning' as LineType };
    if (errStart !== -1 && i >= errStart && i <= errEnd) return { text: line, type: 'error' as LineType };
    return { text: line, type: 'output' as LineType };
  });
}

export function styleWindowsOutput(output: readonly string[]): RichOutputLine[] {
  return classifyWindowsLines(output.join('\n')).map(({ text, type }) => {
    if (type === 'error') {
      return { id: nextLineId(), segments: [{ text, style: { color: WINDOWS_ERROR_COLOR } }], lineType: 'error' as LineType };
    }
    if (type === 'warning') {
      return { id: nextLineId(), segments: [{ text, style: { color: WINDOWS_WARNING_COLOR } }], lineType: 'warning' as LineType };
    }
    return { id: nextLineId(), segments: parseAnsiToSegments(text), lineType: 'output' as LineType };
  });
}
