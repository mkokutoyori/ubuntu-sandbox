/**
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { InfoBar } from '@/components/terminal/TerminalView';
import type { TerminalSession, TerminalTheme } from '@/terminal/sessions/TerminalSession';
import type { AsyncJobHandle } from '@/terminal/async';

const theme: TerminalTheme = {
  sessionType: 'cisco',
  backgroundColor: '#000',
  textColor: '#0f0',
  errorColor: '#f00',
  promptColor: '#0f0',
  fontFamily: 'monospace',
  infoBarBg: '#222',
  infoBarText: '#fff',
  infoBarBorder: '#333',
  pagerColor: '#facc15',
};

function fakeSession(jobs: AsyncJobHandle[]): TerminalSession {
  return {
    getInfoBarContent: () => ({ left: 'SW1 — C2960 Switch', right: '? = help' }),
    listAsyncJobs: () => jobs,
  } as unknown as TerminalSession;
}

function job(label: string): AsyncJobHandle {
  return {
    id: 'j1', mode: 'background', kind: 'subscription',
    command: 'debug', label, startedAt: 0, running: true, cancel: () => {},
  };
}

describe('InfoBar — background async task indicator', () => {
  test('shows the running background job label', () => {
    const { container } = render(<InfoBar theme={theme} session={fakeSession([job('IOS debug output')])} />);
    expect(container.textContent).toContain('IOS debug output');
  });

  test('collapses multiple background jobs into a count', () => {
    const { container } = render(
      <InfoBar theme={theme} session={fakeSession([job('a'), job('b')])} />,
    );
    expect(container.textContent).toContain('2 background tasks');
  });

  test('shows no indicator when there are no background jobs', () => {
    const { container } = render(<InfoBar theme={theme} session={fakeSession([])} />);
    expect(container.textContent).not.toContain('background');
    expect(container.textContent).toContain('SW1');
  });
});
