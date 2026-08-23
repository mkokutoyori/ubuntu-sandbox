import { FortiTerminalSession } from '@/terminal/sessions';
import type { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

export const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

export const key = (k: string, ctrl = false): KeyEvent =>
  ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

async function settle(session: FortiTerminalSession, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

export async function bootFortiConsole(fgt: FortiGate): Promise<FortiTerminalSession> {
  const session = new FortiTerminalSession('t1', fgt as never);
  await session.init();
  for (let i = 0; i < 40 && session.isBooting; i++) await tick();
  await settle(session, 10);
  return session;
}

export async function answerPrompt(
  session: FortiTerminalSession, value: string,
): Promise<void> {
  session.setInputBuf(value);
  session.handleKey(key('Enter'));
  await settle(session, 25);
}

export async function answerSecret(
  session: FortiTerminalSession, value: string,
): Promise<void> {
  session.setPasswordBuf(value);
  session.handleKey(key('Enter'));
  await settle(session, 25);
}

export async function runCommand(
  session: FortiTerminalSession, line: string,
): Promise<void> {
  session.setInput(line);
  session.handleKey(key('Enter'));
  await settle(session, 30);
}

export async function openFortiConsole(
  fgt: FortiGate, password = '', user = 'admin',
): Promise<FortiTerminalSession> {
  const session = await bootFortiConsole(fgt);
  const mustChoose = fgt.adminMustChoosePassword(user);
  await answerPrompt(session, user);
  await answerSecret(session, password);
  if (mustChoose) {
    const chosen = password.length > 0 ? password : 'Fortinet123';
    await answerSecret(session, chosen);
    await answerSecret(session, chosen);
  }
  return session;
}
