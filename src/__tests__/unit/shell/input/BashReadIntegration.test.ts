import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const wait = (predicate: () => boolean, ms = 1500) => new Promise<void>((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    if (predicate()) return resolve();
    if (Date.now() - start > ms) return reject(new Error('timeout'));
    setTimeout(tick, 5);
  };
  tick();
});

function makeSession() {
  EquipmentRegistry.resetInstance();
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  const session = new LinuxTerminalSession('term-1', pc);
  return { pc, session };
}

describe('bash read via the unified input broker', () => {
  it('read -p "Q? " ans pauses the shell and captures the user response', async () => {
    const { session } = makeSession();
    session.setInput(`read -p "Continue (y/n)? " ans`);
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'interactive-text');
    expect(session.currentInputMode.type === 'interactive-text'
      ? session.currentInputMode.promptText : '').toContain('Continue');
    session.setInputBuf('yes');
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'normal');
    session.setInput(`echo "answer=$ans"`);
    session.handleKey(key('Enter'));
    await wait(() => session.lines.some(l => l.text === 'answer=yes'));
  });

  it('read -s -p prompts in password mode and hides the typed secret', async () => {
    const { session } = makeSession();
    session.setInput(`read -s -p "Pwd: " pw`);
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'password');
    session.setPasswordBuf('s3cret');
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'normal');
    expect(session.lines.some(l => l.text.includes('*'))).toBe(false);
    expect(session.lines.some(l => l.text.includes('s3cret'))).toBe(false);
    session.setInput(`echo "len=${'$'}{#pw}"`);
    session.handleKey(key('Enter'));
    await wait(() => session.lines.some(l => l.text === 'len=6'));
  });

  it('Ctrl+C during read clears the prompt and surfaces a 130 exit code', async () => {
    const { session } = makeSession();
    session.setInput(`read -p "X: " v`);
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'interactive-text');
    session.handleKey(key('c', { ctrlKey: true }));
    await wait(() => session.currentInputMode.type === 'normal');
    session.setInput(`echo ec=$?`);
    session.handleKey(key('Enter'));
    await wait(() => session.lines.some(l => /^ec=/.test(l.text)), 800);
    const ecLine = session.lines.find(l => /^ec=/.test(l.text));
    expect(ecLine?.text).toBe('ec=130');
  });

  it('read with multiple targets splits the response on IFS whitespace', async () => {
    const { session } = makeSession();
    session.setInput(`read -p "Names: " a b c`);
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'interactive-text');
    session.setInputBuf('alice bob carol');
    session.handleKey(key('Enter'));
    await wait(() => session.currentInputMode.type === 'normal');
    session.setInput(`echo "$a|$b|$c"`);
    session.handleKey(key('Enter'));
    await wait(() => session.lines.some(l => l.text === 'alice|bob|carol'));
  });
});
