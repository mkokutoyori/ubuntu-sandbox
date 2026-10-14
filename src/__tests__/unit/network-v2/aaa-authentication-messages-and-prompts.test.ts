/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands A to C):
 * `aaa authentication banner`, `fail-message`, `username-prompt`, `password-prompt`.
 *
 *   banner        replaces the default login message "User Access Verification"
 *   fail-message  replaces the failed-login message
 *   *-prompt      replace "Username:" / "Password:"; the password prompt also serves `enable`
 *   no <command>  restores the default
 *
 * Measured with src stashed to HEAD: 9 of the 10 cases fall (the commands are rejected with
 * "% Invalid input", and loginMessages does not exist). The console witness (defaults on a router
 * without the commands) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function configured(lines: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  for (const l of ['enable', 'configure terminal', ...lines, 'end']) await r.executeCommand(l);
  return r;
}

describe('aaa authentication messages and prompts', () => {
  it('witness: an unconfigured router keeps the IOS defaults', async () => {
    const r = await configured([]);
    const m = getSecurityConfig(r).loginMessages();
    expect(m).toEqual({ banner: null, failMessage: null, usernamePrompt: 'Username: ', passwordPrompt: 'Password: ' });
  });

  it('banner one-line form is stored and rendered', async () => {
    const r = await configured(['aaa authentication banner ^Authorised users only^']);
    expect(getSecurityConfig(r).loginMessages().banner).toBe('Authorised users only');
    expect(await r.executeCommand('show running-config')).toContain('aaa authentication banner ^C\nAuthorised users only\n^C');
  });

  it('fail-message is stored and rendered', async () => {
    const r = await configured(['aaa authentication fail-message #Access denied#']);
    expect(getSecurityConfig(r).loginMessages().failMessage).toBe('Access denied');
    expect(await r.executeCommand('show running-config')).toContain('aaa authentication fail-message ^C\nAccess denied\n^C');
  });

  it('the prompts take quoted text with spaces', async () => {
    const r = await configured([
      'aaa authentication username-prompt "Enter your name here:"',
      'aaa authentication password-prompt "Enter your password now:"',
    ]);
    const m = getSecurityConfig(r).loginMessages();
    expect(m.usernamePrompt).toBe('Enter your name here:');
    expect(m.passwordPrompt).toBe('Enter your password now:');
    const config = await r.executeCommand('show running-config');
    expect(config).toContain('aaa authentication username-prompt "Enter your name here:"');
  });

  it('the no form restores each default', async () => {
    const r = await configured([
      'aaa authentication banner ^x^', 'aaa authentication fail-message ^y^',
      'aaa authentication username-prompt "U:"', 'aaa authentication password-prompt "P:"',
      'no aaa authentication banner', 'no aaa authentication fail-message',
      'no aaa authentication username-prompt', 'no aaa authentication password-prompt',
    ]);
    expect(getSecurityConfig(r).loginMessages())
      .toEqual({ banner: null, failMessage: null, usernamePrompt: 'Username: ', passwordPrompt: 'Password: ' });
  });

  it('the banner is not shown when TACACS+ is the first login method', async () => {
    const r = await configured([
      'aaa new-model', 'aaa authentication login default group tacacs+ local',
      'aaa authentication banner ^x^',
    ]);
    expect(getSecurityConfig(r).loginMessages().banner).toBeNull();
  });

  it('the telnet server announces the configured header, prompts and failure message', async () => {
    const r = await configured([
      'username admin secret s3cret', 'line vty 0 4', 'login local', 'exit',
      'aaa authentication banner ^Restricted^', 'aaa authentication fail-message ^Go away^',
      'aaa authentication username-prompt "Who:"', 'aaa authentication password-prompt "Secret:"',
    ]);
    const handler = (r as unknown as { buildRouterTelnetServerHandler(): { ctx: Record<string, () => unknown> } })
      .buildRouterTelnetServerHandler();
    const ctx = handler.ctx;
    expect(ctx.authHeader()).toBe('Restricted');
    expect(ctx.credentialPrompts()).toEqual({ username: 'Who:', password: 'Secret:' });
    expect(ctx.authFailureMessage()).toBe('Go away');
  });

  it('a banner without a closing delimiter collects lines until it comes', async () => {
    const r = new CiscoRouter('R1');
    for (const l of ['enable', 'configure terminal']) await r.executeCommand(l);
    expect(await r.executeCommand('aaa authentication banner ^first line')).toContain("End with the character '^'");
    await r.executeCommand('second line^');
    await r.executeCommand('end');
    expect(getSecurityConfig(r).loginMessages().banner).toBe('first line\nsecond line');
  });
});

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 40 && session.isBooting; i++) await tick();
}

async function waitForMode(session: TerminalSession, mode: string): Promise<void> {
  for (let i = 0; i < 130 && session.currentInputMode.type !== mode; i++) await tick();
}

const visible = (session: TerminalSession): string[] => session.lines.slice(-60).map((l) => l.text);

async function consoleLab(extra: string[]): Promise<CiscoTerminalSession> {
  const r = await configured([
    'username admin privilege 15 secret Admin@2025',
    'line console 0', 'login local', 'exit',
    ...extra,
  ]);
  const session = new CiscoTerminalSession('t1', r);
  await session.init();
  await waitBoot(session);
  return session;
}

describe('on the console', () => {
  it('shows the configured message, the configured prompts and the configured failure message', async () => {
    const session = await consoleLab([
      'aaa authentication banner ^Authorised users only^',
      'aaa authentication fail-message ^Access denied^',
      'aaa authentication username-prompt "Who goes there:"',
      'aaa authentication password-prompt "Secret word:"',
    ]);
    const text = visible(session);
    expect(text.some((l) => l.includes('Authorised users only'))).toBe(true);
    expect(text.some((l) => l.includes('User Access Verification'))).toBe(false);
    expect(session.currentInputMode).toMatchObject({ promptText: 'Who goes there:' });
    session.setInputBuf('admin');
    session.handleKey(key('Enter'));
    await waitForMode(session, 'password');
    expect(session.currentInputMode).toMatchObject({ promptText: 'Secret word:' });
    session.setPasswordBuf('wrong');
    session.handleKey(key('Enter'));
    await tick();
    await tick();
    const after = visible(session);
    expect(after.some((l) => l.includes('Access denied'))).toBe(true);
    expect(after.some((l) => l.includes('% Login invalid'))).toBe(false);
  });

  it('witness: without the commands the defaults are shown', async () => {
    const session = await consoleLab([]);
    expect(visible(session).some((l) => l.includes('User Access Verification'))).toBe(true);
    expect(session.currentInputMode).toMatchObject({ promptText: 'Username: ' });
  });
});
