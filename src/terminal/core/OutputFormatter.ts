/**
 * OutputFormatter — Strategy pattern for converting raw shell output
 * into pre-parsed RichOutputLine[].
 *
 * This removes ALL parsing logic from the view. The view only renders
 * TextSegment[] — it never sees ANSI codes or raw strings.
 *
 * Implementations:
 *   - AnsiOutputFormatter  — Linux terminals (ANSI escape codes)
 *   - PlainOutputFormatter — Cisco, Huawei (plain text with theme colors)
 *   - WindowsOutputFormatter — Windows CMD/PS (plain + ps-header coloring)
 */

import type { TextSegment, TextStyle, RichOutputLine, LineType } from './types';
import { nextLineId } from '@/terminal/sessions/TerminalSession';

// ─── Interface ──────────────────────────────────────────────────────

export interface IOutputFormatter {
  /** Convert a raw output string (possibly multi-line) into RichOutputLine[] */
  formatOutput(raw: string, lineType?: LineType): RichOutputLine[];

  /** Format a prompt string into styled segments */
  formatPrompt(prompt: string): TextSegment[];
}

// ─── ANSI Color Tables ──────────────────────────────────────────────

const ANSI_FG: Record<number, string> = {
  30: '#2e3436', 31: '#cc0000', 32: '#4e9a06', 33: '#c4a000',
  34: '#3465a4', 35: '#75507b', 36: '#06989a', 37: '#d3d7cf',
  90: '#555753', 91: '#ef2929', 92: '#8ae234', 93: '#fce94f',
  94: '#729fcf', 95: '#ad7fa8', 96: '#34e2e2', 97: '#eeeeec',
};

const ANSI_BG: Record<number, string> = {
  40: '#2e3436', 41: '#cc0000', 42: '#4e9a06', 43: '#c4a000',
  44: '#3465a4', 45: '#75507b', 46: '#06989a', 47: '#d3d7cf',
  100: '#555753', 101: '#ef2929', 102: '#8ae234', 103: '#fce94f',
  104: '#729fcf', 105: '#ad7fa8', 106: '#34e2e2', 107: '#eeeeec',
};

// ─── ANSI Parsing ───────────────────────────────────────────────────

/** Parse a string containing ANSI escape codes into styled TextSegments */
export function parseAnsiToSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // eslint-disable-next-line no-control-regex
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let bold = false;
  let fg: string | undefined;
  let bg: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const chunk = text.slice(lastIndex, match.index);
      if (chunk) {
        segments.push(buildSegment(chunk, fg, bg, bold));
      }
    }
    lastIndex = regex.lastIndex;
    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0) { bold = false; fg = undefined; bg = undefined; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (ANSI_FG[code]) fg = ANSI_FG[bold ? code + 60 : code] ?? ANSI_FG[code];
      else if (ANSI_BG[code]) bg = ANSI_BG[code];
    }
  }

  if (lastIndex < text.length) {
    segments.push(buildSegment(text.slice(lastIndex), fg, bg, bold));
  }

  return segments.length > 0 ? segments : [{ text: '' }];
}

function buildSegment(text: string, fg?: string, bg?: string, bold?: boolean): TextSegment {
  const style: TextStyle = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (bold) style.bold = true;
  return Object.keys(style).length > 0 ? { text, style } : { text };
}

// ─── Linux Prompt Detection ─────────────────────────────────────────

const PROMPT_REGEX = /^(\S+)@(\S+):(.+?)([$#]) (.*)$/;

/** Try to parse a Linux prompt line into colored segments */
function tryParsePromptLine(text: string): TextSegment[] | null {
  const m = text.match(PROMPT_REGEX);
  if (!m) return null;
  const [, user, hostname, path, char, cmd] = m;
  return [
    { text: `${user}@${hostname}`, style: { color: user === 'root' ? '#ef2929' : '#8ae234', bold: true } },
    { text: ':' },
    { text: path, style: { color: '#729fcf', bold: true } },
    { text: `${char} ${cmd}` },
  ];
}

// ─── AnsiOutputFormatter (Linux) ────────────────────────────────────

export class AnsiOutputFormatter implements IOutputFormatter {
  formatOutput(raw: string, lineType: LineType = 'output'): RichOutputLine[] {
    return raw.split('\n').map(line => {
      // eslint-disable-next-line no-control-regex
      const hasAnsi = /\x1b\[/.test(line);

      let segments: TextSegment[];
      if (hasAnsi) {
        segments = parseAnsiToSegments(line);
      } else {
        // Try prompt detection for colored history lines
        const promptSegments = tryParsePromptLine(line);
        if (promptSegments) {
          segments = promptSegments;
        } else {
          const color = lineType === 'error' ? '#ef2929' : '#d3d7cf';
          segments = [{ text: line, style: { color } }];
        }
      }

      return { id: nextLineId(), segments, lineType };
    });
  }

  formatPrompt(prompt: string): TextSegment[] {
    return parseAnsiToSegments(prompt);
  }
}

// ─── PlainOutputFormatter (Cisco / Huawei) ──────────────────────────

export interface PlainFormatterConfig {
  textColor: string;
  errorColor: string;
  bootColor: string;
  pagerColor: string;
  promptColor: string;
}

const DEFAULT_PLAIN_CONFIG: PlainFormatterConfig = {
  textColor: '#ffffff',
  errorColor: '#f87171',
  bootColor: '#22c55e',
  pagerColor: '#facc15',
  promptColor: '#ffffff',
};

export class PlainOutputFormatter implements IOutputFormatter {
  private config: PlainFormatterConfig;

  constructor(config?: Partial<PlainFormatterConfig>) {
    this.config = { ...DEFAULT_PLAIN_CONFIG, ...config };
  }

  formatOutput(raw: string, lineType: LineType = 'output'): RichOutputLine[] {
    const color = this.colorForType(lineType);
    return raw.split('\n').map(line => ({
      id: nextLineId(),
      segments: [{ text: line, style: { color } }],
      lineType,
    }));
  }

  formatPrompt(prompt: string): TextSegment[] {
    return [{ text: prompt, style: { color: this.config.promptColor } }];
  }

  private colorForType(type: LineType): string {
    switch (type) {
      case 'error': return this.config.errorColor;
      case 'boot': return this.config.bootColor;
      case 'system': return this.config.pagerColor;
      default: return this.config.textColor;
    }
  }
}

// ─── WindowsOutputFormatter ─────────────────────────────────────────

interface WindowsFormatterConfig {
  textColor: string;
  errorColor: string;
  warningColor: string;
  psHeaderColor: string;
}

export class WindowsOutputFormatter implements IOutputFormatter {
  constructor(private config: WindowsFormatterConfig) {}

  formatOutput(raw: string, lineType: LineType = 'output'): RichOutputLine[] {
    const color = this.colorForType(lineType);
    return raw.split('\n').map(line => ({
      id: nextLineId(),
      segments: [{ text: line, style: { color } }],
      lineType,
    }));
  }

  formatPrompt(prompt: string): TextSegment[] {
    return [{ text: prompt, style: { color: this.config.textColor } }];
  }

  private colorForType(type: LineType): string {
    switch (type) {
      case 'error': return this.config.errorColor;
      case 'warning': return this.config.warningColor;
      case 'info': return this.config.psHeaderColor;
      default: return this.config.textColor;
    }
  }
}
