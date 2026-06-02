import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { PromiseInputBroker } from '@/shell/input';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function makeSession() {
  EquipmentRegistry.resetInstance();
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  const session = new LinuxTerminalSession('term-1', pc);
  const broker = new PromiseInputBroker(session.getInputHost());
  return { pc, session, broker };
}

describe('SessionInputHost + LinuxTerminalSession', () => {
  it('switches into interactive-text mode when a text prompt is requested', async () => {
    const { session, broker } = makeSession();
    const promise = broker.ask('Name? ');
    await flush();
    expect(session.currentInputMode.type).toBe('interactive-text');
    expect(session.currentInputMode.type === 'interactive-text'
      ? session.currentInputMode.promptText : '').toBe('Name? ');

    session.setInputBuf('Alice');
    session.handleKey(key('Enter'));
    expect(await promise).toBe('Alice');
    expect(session.currentInputMode.type).toBe('normal');
  });

  it('switches into password mode when password() is used and echoes asterisks', async () => {
    const { session, broker } = makeSession();
    const promise = broker.password('Pwd: ');
    await flush();
    expect(session.currentInputMode.type).toBe('password');

    session.setPasswordBuf('hunter2');
    session.handleKey(key('Enter'));
    expect(await promise).toBe('hunter2');
    expect(session.lines.some(l => l.text === '*******')).toBe(true);
  });

  it('Ctrl+C cancels a pending prompt and resolves with null', async () => {
    const { session, broker } = makeSession();
    const promise = broker.ask('Q ');
    await flush();
    session.setInputBuf('partial');
    session.handleKey(key('c', { ctrlKey: true }));
    expect(await promise).toBeNull();
    expect(session.lines.some(l => l.text === '^C')).toBe(true);
    expect(session.currentInputMode.type).toBe('normal');
  });

  it('confirm() rejects an invalid first answer then accepts the retry', async () => {
    const { session, broker } = makeSession();
    const promise = broker.confirm('Sure?');
    await flush();
    session.setInputBuf('maybe');
    session.handleKey(key('Enter'));
    await flush();
    session.setInputBuf('y');
    session.handleKey(key('Enter'));
    const r = await promise;
    expect(r.status).toBe('ok');
    expect(r.value).toBe(true);
    expect(session.lines.some(l => l.text.includes('yes or no'))).toBe(true);
  });

  it('choice() menu accepts numeric and direct-name selection', async () => {
    const { session, broker } = makeSession();
    const p1 = broker.choice('Pick env', ['dev', 'staging', 'prod']);
    await flush();
    session.setInputBuf('staging');
    session.handleKey(key('Enter'));
    const r1 = await p1;
    expect(r1.value).toBe('staging');
    expect(r1.index).toBe(1);

    const p2 = broker.choice('Again', ['a', 'b', 'c']);
    await flush();
    session.setInputBuf('3');
    session.handleKey(key('Enter'));
    expect((await p2).value).toBe('c');
  });

  it('multiline() collects lines until the empty sentinel', async () => {
    const { session, broker } = makeSession();
    const p = broker.multiline('Notes:');
    await flush();
    for (const line of ['one', 'two', 'three', '']) {
      session.setInputBuf(line);
      session.handleKey(key('Enter'));
      await flush();
    }
    const r = await p;
    expect(r.status).toBe('ok');
    expect(r.lines).toEqual(['one', 'two', 'three']);
  });

  it('attachStream forwards chunks via addLine and cancels cleanly', () => {
    const { session, broker } = makeSession();
    const attach = broker.attachStream({
      description: 'tail -f /var/log/syslog',
      sink: { write: (chunk) => session.addLine(chunk) },
    });
    session.addLine('first stream chunk');
    expect(session.lines.some(l => l.text === 'first stream chunk')).toBe(true);
    attach.cancel();
    expect(attach.active).toBe(false);
  });

  it('returns no-host when the session is disposed', async () => {
    const { session, broker } = makeSession();
    session.dispose();
    const r = await broker.read({ kind: 'text', prompt: 'X' });
    expect(r.status).toBe('no-host');
  });
});
