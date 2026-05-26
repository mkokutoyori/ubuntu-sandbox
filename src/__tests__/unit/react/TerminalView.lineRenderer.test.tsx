/**
 * @vitest-environment jsdom
 *
 * TerminalView.LineRenderer — UI render contract for OutputLine.
 *
 * These tests pin down the rendering decision that fixes the
 * "raw [1;36m over SSH" class of bugs: when an OutputLine carries
 * pre-styled `segments`, the renderer MUST honour them verbatim and
 * MUST NOT fall back to the host session's vendor renderer.
 */

import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { LineRenderer } from '@/components/terminal/TerminalView';
import type { OutputLine, TerminalTheme } from '@/terminal/sessions/TerminalSession';

const theme: TerminalTheme = {
  sessionType: 'windows',
  backgroundColor: '#000',
  textColor: '#fff',
  errorColor: '#f00',
  promptColor: '#fff',
  fontFamily: 'monospace',
  infoBarBg: '#222',
  infoBarText: '#fff',
  infoBarBorder: '#333',
};

describe('LineRenderer — segments take precedence over host vendor', () => {
  test('renders pre-styled segments verbatim on a Windows host', () => {
    const line: OutputLine = {
      id: 1,
      text: 'bin etc home',
      type: 'normal',
      segments: [
        { text: 'bin', style: { color: '#06989a', bold: true } },
        { text: '    ' },
        { text: 'etc', style: { color: '#06989a', bold: true } },
        { text: '    ' },
        { text: 'home', style: { color: '#3465a4', bold: true } },
      ],
    };
    const { container } = render(
      <LineRenderer line={line} theme={theme} sessionType="windows" />,
    );
    // Spans for each segment.
    const spans = container.querySelectorAll('span');
    expect(spans.length).toBe(5);
    // First span colored as the segment requested, not the Windows white default.
    expect((spans[0] as HTMLSpanElement).style.color).toBe('rgb(6, 152, 154)');
    // Bold is honoured.
    expect((spans[0] as HTMLSpanElement).style.fontWeight).toBe('bold');
    // Total text is reconstructible from the spans.
    const all = Array.from(spans).map((s) => s.textContent).join('');
    expect(all).toBe('bin    etc    home');
  });

  test('no raw ANSI escape leaks when segments are present', () => {
    const line: OutputLine = {
      id: 1,
      text: 'hello',
      type: 'normal',
      segments: [{ text: 'hello', style: { color: '#8ae234' } }],
    };
    const { container } = render(
      <LineRenderer line={line} theme={theme} sessionType="windows" />,
    );
    // No [1;36m anywhere in the DOM text.
    // eslint-disable-next-line no-control-regex
    const hasAnsi = /\x1b\[|\[1;3\dm/.test(container.textContent ?? '');
    expect(hasAnsi).toBe(false);
  });

  test('falls back to vendor renderer when no segments are provided', () => {
    const line: OutputLine = { id: 1, text: 'plain text', type: 'normal' };
    const { container } = render(
      <LineRenderer line={line} theme={theme} sessionType="windows" />,
    );
    // Windows fallback: a single <pre> with no per-segment spans.
    expect(container.querySelector('pre')).toBeTruthy();
    expect(container.querySelectorAll('span').length).toBe(0);
    expect(container.textContent).toBe('plain text');
  });
});
