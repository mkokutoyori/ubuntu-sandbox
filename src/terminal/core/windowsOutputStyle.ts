import { nextLineId } from '@/terminal/sessions/TerminalSession';
import { parseAnsiToSegments } from '@/terminal/core/OutputFormatter';
import type { RichOutputLine, LineType } from '@/terminal/core/types';

const PS_ERROR_LINE = /^(?:[A-Za-z]+-[A-Za-z]+|[A-Za-z]+Exception|InvalidArgument|InvalidOperation|ObjectNotFound|PermissionDenied|ResourceUnavailable|WriteError): /;
const PS_ERROR_CONTINUATION = /^Check the spelling of the name, or if a path was included/;

const WARNING_PREFIX = /^\s*(WARNING|VERBOSE|DEBUG):/;

export const WINDOWS_ERROR_COLOR = '#f14c4c';
export const WINDOWS_WARNING_COLOR = '#cca700';

export interface ClassifiedLine {
  text: string;
  type: LineType;
}

export function classifyWindowsLines(text: string): ClassifiedLine[] {
  let inError = false;
  return text.split('\n').map((line) => {
    if (WARNING_PREFIX.test(line)) { inError = false; return { text: line, type: 'warning' as LineType }; }
    const isError = PS_ERROR_LINE.test(line) || (inError && PS_ERROR_CONTINUATION.test(line));
    inError = isError;
    return { text: line, type: (isError ? 'error' : 'output') as LineType };
  });
}

export function styleWindowsOutput(output: readonly string[]): RichOutputLine[] {
  if (output.length === 0) return [];
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
