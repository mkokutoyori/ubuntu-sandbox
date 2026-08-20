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
 * PENDING. "Nothing pending" has to be asked of both buffers, and getting
 * that wrong is not hypothetical: my first fix asked only `input`, while
 * the scripted paths call `setInputBuf`, which fills `_inputBuf` and
 * leaves `input` empty. The gate then swallowed every scripted command
 * and took out nine cases of `ssh-liveness-vendor-agnostic`.
 *
 * Discrimination — restore `CLITerminalSession.ts`: the first two cases
 * fail, the echoed `Router1>` coming back. Narrowing the gate to `input`
 * alone (the bug I shipped) instead fails the `setInputBuf` case. Both
 * halves are therefore pinned by a case that can see them, which the
 * first draft of this file could not: its swallow case asserted on
 * `Cisco IOS Software`, a string the BANNER already prints, so it passed
 * against the very defect it existed to catch. It asserts on a clock line
 * now — output no banner can produce.
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
   * The scripted paths never type: they call `setInputBuf` and send
   * Enter. That fills `_inputBuf` and leaves `input` EMPTY, so a gate
   * that only asks `input` swallows the command whole — which is exactly
   * what happened, twice: it took out nine cases of
   * `ssh-liveness-vendor-agnostic`. The first version of this very test
   * used `setInput` and so never exercised the path that breaks; it uses
   * the scripted one now, which is the only reason it discriminates.
   */
  it('a command placed with setInputBuf is never swallowed by the gate', async () => {
    const session = await bootedConsole();

    (session as unknown as { setInputBuf(v: string): void }).setInputBuf('show clock');
    session.handleKey(key('Enter'));
    await settle(session);

    // A clock line cannot come from the banner. The first version of this
    // assertion looked for `Cisco IOS Software`, which the BANNER already
    // prints — so it passed against the very bug it was meant to catch.
    expect(session.lines.map((l) => l.text).join('\n')).toMatch(/\d\d:\d\d:\d\d.*UTC/);
  });

  it('a typed command is not swallowed either', async () => {
    const session = await bootedConsole();

    session.setInput('show clock');
    session.handleKey(key('Enter'));
    await settle(session);

    expect(rendered(session)).toContain('Router1>show clock');
    // A clock line cannot come from the banner. The first version of this
    // assertion looked for `Cisco IOS Software`, which the BANNER already
    // prints — so it passed against the very bug it was meant to catch.
    expect(session.lines.map((l) => l.text).join('\n')).toMatch(/\d\d:\d\d:\d\d.*UTC/);
  });
});
