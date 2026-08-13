/**
 * `Press RETURN to get started.` — that RETURN opens the session. It does
 * not submit a line.
 *
 * Measured on a freshly dropped router: the banner was followed by TWO
 * prompts, one under the other,
 *
 *     Press RETURN to get started.
 *
 *     Router1>
 *     Router1>
 *
 * because the same keystroke did two jobs. It revealed the prompt, then
 * fell through to the ordinary Enter handling, which echoed the line the
 * operator had not typed — `addEchoLine` keeps the prompt in `promptText`
 * and the command in `text`, so an empty command with a prompt renders as
 * a bare `Router1>`. Add the live prompt underneath and the console shows
 * the machine asking twice.
 *
 * The gate is deliberately narrow — bare Enter, banner still up, nothing
 * typed. An earlier and wider version of it ate real commands, because
 * the scripted SSH paths fill the buffer with `setInputBuf` before
 * sending Enter; the empty-buffer condition is what keeps them safe, and
 * the last case here pins it.
 *
 * Discrimination — restore `CLITerminalSession.ts`: the first two cases
 * fail (the echoed `Router1>` comes back). The last two pass either way
 * and guard the fix rather than measure the defect.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

async function settle(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  void session;
}

async function bootedConsole(): Promise<CiscoTerminalSession> {
  const router = new CiscoRouter('Router1', 0, 0);
  router.powerOn();
  const session = new CiscoTerminalSession('t1', router as never);
  await session.init();
  for (let i = 0; i < 400 && session.isBooting; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return session;
}

/** What the renderer composes: the prompt it carries, then the text. */
function rendered(session: CiscoTerminalSession): string[] {
  return session.lines.map((l) => {
    const withPrompt = l as unknown as { promptText?: string; text: string };
    return `${withPrompt.promptText ?? ''}${withPrompt.text}`;
  });
}

describe('the RETURN that opens the console does not submit a line', () => {
  it('the banner is followed by ONE prompt, not two', async () => {
    const session = await bootedConsole();
    expect(session.getPrompt(), 'the prompt is hidden until the operator answers').toBe('');

    session.handleKey(key('Enter'));
    await settle(session);

    expect(session.getPrompt()).toBe('Router1>');
    expect(rendered(session).filter((l) => l === 'Router1>')).toEqual([]);
  });

  it('nothing at all is appended by that RETURN', async () => {
    const session = await bootedConsole();
    const before = session.lines.length;

    session.handleKey(key('Enter'));
    await settle(session);

    expect(session.lines.length).toBe(before);
  });

  it('once open, Enter behaves normally again and a command still runs', async () => {
    const session = await bootedConsole();
    session.handleKey(key('Enter'));
    await settle(session);

    session.setInput('show clock');
    session.handleKey(key('Enter'));
    await settle(session);

    expect(rendered(session)).toContain('Router1>show clock');
    expect(session.lines.map((l) => l.text).join('\n')).toMatch(/UTC/);
  });

  /**
   * The scripted paths never type: they fill the buffer and send Enter.
   * A gate keyed on the keystroke alone would swallow that command whole,
   * which is exactly how the first version of this fix broke SSH.
   */
  it('a command already in the buffer is never swallowed by the gate', async () => {
    const session = await bootedConsole();

    session.setInput('show version');
    session.handleKey(key('Enter'));
    await settle(session);

    expect(rendered(session)).toContain('Router1>show version');
    expect(session.lines.map((l) => l.text).join('\n')).toContain('Cisco IOS Software');
  });
});
