/**
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { LineRenderer } from '@/components/terminal/TerminalView';
import type { OutputLine, TerminalTheme } from '@/terminal/sessions/TerminalSession';

const windowsTheme: TerminalTheme = {
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

const linuxTheme: TerminalTheme = { ...windowsTheme, sessionType: 'linux' };

describe('LineRenderer — host window keeps its own look', () => {
  test('a Windows host strips foreign ANSI: no Linux colour, no raw escape', () => {
    const line: OutputLine = {
      id: 1,
      text: '\x1b[01;34mDocuments\x1b[0m',
      type: 'normal',
    };
    const { container } = render(
      <LineRenderer line={line} theme={windowsTheme} sessionType="windows" />,
    );
    expect(container.querySelectorAll('span').length).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(container.textContent ?? '')).toBe(false);
    expect(container.textContent).toBe('Documents');
  });

  test('a Linux host still parses ANSI into coloured spans', () => {
    const line: OutputLine = {
      id: 2,
      text: '\x1b[01;34mDocuments\x1b[0m',
      type: 'normal',
    };
    const { container } = render(
      <LineRenderer line={line} theme={linuxTheme} sessionType="linux" />,
    );
    const spans = container.querySelectorAll('span');
    expect(spans.length).toBeGreaterThan(0);
    expect(container.textContent).toBe('Documents');
  });
});
