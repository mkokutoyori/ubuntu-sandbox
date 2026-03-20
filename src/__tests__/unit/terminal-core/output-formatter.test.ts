/**
 * Tests for OutputFormatter implementations.
 *
 * Covers:
 *   - AnsiOutputFormatter: ANSI code parsing, prompt detection, error coloring
 *   - PlainOutputFormatter: plain text with theme-based coloring
 *   - WindowsOutputFormatter: Windows-specific line type coloring
 *   - parseAnsiToSegments: edge cases (nested codes, reset, empty, unicode)
 */

import { describe, it, expect } from 'vitest';
import {
  AnsiOutputFormatter,
  PlainOutputFormatter,
  WindowsOutputFormatter,
  parseAnsiToSegments,
} from '@/terminal/core/OutputFormatter';

// ─── parseAnsiToSegments ─────────────────────────────────────────────

describe('parseAnsiToSegments', () => {
  it('returns plain text as a single segment when no ANSI codes', () => {
    const segments = parseAnsiToSegments('Hello, world!');
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Hello, world!');
    expect(segments[0].style).toBeUndefined();
  });

  it('parses red foreground color (\\e[31m)', () => {
    const segments = parseAnsiToSegments('\x1b[31mError\x1b[0m');
    // Reset at end with no trailing text produces 1 segment
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].text).toBe('Error');
    expect(segments[0].style?.color).toBe('#cc0000');
  });

  it('parses bold + green (\\e[1;32m)', () => {
    const segments = parseAnsiToSegments('\x1b[1;32mSuccess\x1b[0m');
    expect(segments.length).toBeGreaterThanOrEqual(1);
    const successSegment = segments.find(s => s.text === 'Success');
    expect(successSegment).toBeDefined();
    expect(successSegment!.style?.bold).toBe(true);
    expect(successSegment!.style?.color).toBeDefined();
  });

  it('handles multiple color switches in one string', () => {
    const segments = parseAnsiToSegments('\x1b[31mred\x1b[32mgreen\x1b[0mnormal');
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const redSeg = segments.find(s => s.text === 'red');
    const greenSeg = segments.find(s => s.text === 'green');
    const normalSeg = segments.find(s => s.text === 'normal');
    expect(redSeg!.style?.color).toBe('#cc0000');
    expect(greenSeg!.style?.color).toBe('#4e9a06');
    expect(normalSeg!.style).toBeUndefined();
  });

  it('handles background colors (\\e[41m)', () => {
    const segments = parseAnsiToSegments('\x1b[41mhighlighted\x1b[0m');
    const seg = segments.find(s => s.text === 'highlighted');
    expect(seg!.style?.backgroundColor).toBe('#cc0000');
  });

  it('handles empty string', () => {
    const segments = parseAnsiToSegments('');
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('');
  });

  it('handles string with only ANSI codes (no visible text)', () => {
    const segments = parseAnsiToSegments('\x1b[31m\x1b[0m');
    // Fallback: parseAnsiToSegments always returns at least one segment
    // With only ANSI codes and no text, the remaining text after last code is empty
    expect(segments.length).toBeGreaterThanOrEqual(1);
    // All segments should have empty or no meaningful text
    const totalText = segments.map(s => s.text).join('');
    expect(totalText.trim()).toBe('');
  });

  it('handles unicode characters alongside ANSI codes', () => {
    const segments = parseAnsiToSegments('\x1b[33mCafé résumé 日本語\x1b[0m');
    const seg = segments.find(s => s.text.includes('Café'));
    expect(seg).toBeDefined();
    expect(seg!.text).toBe('Café résumé 日本語');
  });

  it('preserves text when ANSI code has no parameters (\\e[m = reset)', () => {
    const segments = parseAnsiToSegments('before\x1b[mafter');
    expect(segments.some(s => s.text.includes('before'))).toBe(true);
    expect(segments.some(s => s.text.includes('after'))).toBe(true);
  });
});

// ─── AnsiOutputFormatter ─────────────────────────────────────────────

describe('AnsiOutputFormatter', () => {
  const formatter = new AnsiOutputFormatter();

  it('formats plain output into RichOutputLines with IDs', () => {
    const lines = formatter.formatOutput('line 1\nline 2\nline 3');
    expect(lines).toHaveLength(3);
    expect(lines[0].segments[0].text).toBe('line 1');
    expect(lines[1].segments[0].text).toBe('line 2');
    expect(lines[2].segments[0].text).toBe('line 3');
    // Each line has a unique ID
    const ids = lines.map(l => l.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('sets lineType from parameter', () => {
    const lines = formatter.formatOutput('oops', 'error');
    expect(lines[0].lineType).toBe('error');
    expect(lines[0].segments[0].style?.color).toBe('#ef2929');
  });

  it('detects Linux prompt pattern and colorizes it', () => {
    const lines = formatter.formatOutput('user@hostname:~$ ls -la');
    expect(lines).toHaveLength(1);
    const segments = lines[0].segments;
    // Should have multiple segments: user@hostname (green), : (white), ~ (blue), $ ls (white)
    expect(segments.length).toBeGreaterThan(1);
    const userSeg = segments.find(s => s.text.includes('user@hostname'));
    expect(userSeg).toBeDefined();
    expect(userSeg!.style?.color).toBe('#8ae234');
    expect(userSeg!.style?.bold).toBe(true);
  });

  it('detects root prompt and colors it red', () => {
    const lines = formatter.formatOutput('root@server:/etc# cat passwd');
    const segments = lines[0].segments;
    const rootSeg = segments.find(s => s.text.includes('root@server'));
    expect(rootSeg).toBeDefined();
    expect(rootSeg!.style?.color).toBe('#ef2929');
  });

  it('formats ANSI colored output correctly', () => {
    const lines = formatter.formatOutput('\x1b[31mError: not found\x1b[0m');
    expect(lines).toHaveLength(1);
    const segments = lines[0].segments;
    const errorSeg = segments.find(s => s.text.includes('Error'));
    expect(errorSeg!.style?.color).toBe('#cc0000');
  });

  it('formats prompt string into segments', () => {
    const segments = formatter.formatPrompt('\x1b[32muser@host\x1b[0m:\x1b[34m~\x1b[0m$ ');
    expect(segments.length).toBeGreaterThan(1);
  });

  it('handles single-line input', () => {
    const lines = formatter.formatOutput('hello');
    expect(lines).toHaveLength(1);
  });

  it('handles empty string input', () => {
    const lines = formatter.formatOutput('');
    expect(lines).toHaveLength(1);
    expect(lines[0].segments[0].text).toBe('');
  });
});

// ─── PlainOutputFormatter ────────────────────────────────────────────

describe('PlainOutputFormatter', () => {
  const formatter = new PlainOutputFormatter({
    textColor: '#4ade80',
    errorColor: '#f87171',
    bootColor: '#22c55e',
    pagerColor: '#facc15',
    promptColor: '#4ade80',
  });

  it('formats output with theme text color', () => {
    const lines = formatter.formatOutput('Router>show version');
    expect(lines).toHaveLength(1);
    expect(lines[0].segments[0].style?.color).toBe('#4ade80');
  });

  it('formats error lines with error color', () => {
    const lines = formatter.formatOutput('% Invalid input', 'error');
    expect(lines[0].segments[0].style?.color).toBe('#f87171');
  });

  it('formats boot lines with boot color', () => {
    const lines = formatter.formatOutput('Loading...', 'boot');
    expect(lines[0].segments[0].style?.color).toBe('#22c55e');
  });

  it('formats prompt with prompt color', () => {
    const segments = formatter.formatPrompt('Router#');
    expect(segments[0].style?.color).toBe('#4ade80');
  });

  it('handles multi-line output', () => {
    const lines = formatter.formatOutput('line1\nline2\nline3');
    expect(lines).toHaveLength(3);
  });
});

// ─── WindowsOutputFormatter ──────────────────────────────────────────

describe('WindowsOutputFormatter', () => {
  const formatter = new WindowsOutputFormatter({
    textColor: '#cccccc',
    errorColor: '#f14c4c',
    warningColor: '#cca700',
    psHeaderColor: '#eeedf0',
  });

  it('formats normal output with text color', () => {
    const lines = formatter.formatOutput('C:\\Users\\User>dir');
    expect(lines[0].segments[0].style?.color).toBe('#cccccc');
  });

  it('formats error output with error color', () => {
    const lines = formatter.formatOutput("'foo' is not recognized", 'error');
    expect(lines[0].segments[0].style?.color).toBe('#f14c4c');
  });

  it('formats warning output with warning color', () => {
    const lines = formatter.formatOutput('Warning: ...', 'warning');
    expect(lines[0].segments[0].style?.color).toBe('#cca700');
  });

  it('formats PS header with header color', () => {
    const lines = formatter.formatOutput('Windows PowerShell', 'info');
    expect(lines[0].segments[0].style?.color).toBe('#eeedf0');
  });
});
