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
  Logger.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string, ctrl = false): KeyEvent =>
  ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

async function hardenedRouter(config: string[]): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1', 0, 0);
  router.powerOn();
  expect(await router.executeCommand('enable')).toBe('');
  await router.executeCommand('configure terminal');
  for (const line of config) {
    const out = await router.executeCommand(line);
    expect(out, `lab setup was refused: ${line}`)
      .not.toMatch(/% (Invalid|Incomplete|Ambiguous|Unrecognized|Unknown)/);
  }
  await router.executeCommand('end');
  return router;
}

async function consoleSession(router: CiscoRouter): Promise<CiscoTerminalSession> {
  const session = new CiscoTerminalSession('t1', router as never);
  await session.init();
  for (let i = 0; i < 40 && session.isBooting; i++) await tick();
  return session;
}

async function type(session: CiscoTerminalSession, line: string): Promise<void> {
  if (session.currentInputMode.type === 'normal') session.setInput(line);
  else session.insertText(line);
  session.handleKey(key('Enter'));
  for (let i = 0; i < 40; i++) await tick();
}

const screen = (s: CiscoTerminalSession): string => s.lines.map((l) => l.text).join('\n');

const since = (s: CiscoTerminalSession, mark: number): string =>
  s.lines.slice(mark + 1).map((l) => l.text).join('\n');

async function privilegeLevel(router: CiscoRouter): Promise<number> {
  const out = await router.executeCommand('show privilege');
  return parseInt(/level is (\d+)/.exec(out)?.[1] ?? '-1', 10);
}

describe('privilege escalation without the password', () => {
  it('bare `enable` outside the dialogue does not elevate when a gate exists', async () => {
    const router = await hardenedRouter(['enable secret Cisco123']);
    await router.executeCommand('disable');
    expect(await privilegeLevel(router)).toBe(1);

    expect(await router.executeCommand('enable')).toBe('% Access denied');
    expect(await privilegeLevel(router)).toBe(1);
  });

  it('`enable 15` does not either', async () => {
    const router = await hardenedRouter(['enable secret Cisco123']);
    await router.executeCommand('disable');
    expect(await router.executeCommand('enable 15')).toBe('% Access denied');
    expect(await privilegeLevel(router)).toBe(1);
  });

  it('an intermediate level is closed by the level-15 gate', async () => {
    const router = await hardenedRouter(['enable secret Cisco123']);
    await router.executeCommand('disable');
    expect(await router.executeCommand('enable 7')).toBe('% Access denied');
    expect(await privilegeLevel(router)).toBe(1);
  });

  it('the refusal leaves the box closed', async () => {
    const router = await hardenedRouter(['enable secret Cisco123']);
    await router.executeCommand('disable');
    await router.executeCommand('enable');
    for (const attack of ['show running-config', 'show startup-config', 'configure terminal',
      'copy running-config startup-config', 'write erase']) {
      expect(await router.executeCommand(attack), attack).toContain('% Invalid input');
    }
  });

  it('control: with no gate at all the console elevates, as IOS does', async () => {
    const router = new CiscoRouter('R1', 0, 0);
    router.powerOn();
    expect(await router.executeCommand('enable')).toBe('');
    expect(await privilegeLevel(router)).toBe(15);
  });

  it('control: the dialogue with the RIGHT secret elevates', async () => {
    const router = await hardenedRouter(['enable secret Cisco123']);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable');
    expect(session.currentInputMode.type).toBe('password');
    await type(session, 'Cisco123');
    await type(session, 'show privilege');
    expect(screen(session)).toContain('Current privilege level is 15');
  });
});

describe('an account password does not open privileged mode', () => {
  it('the user secret is refused at the `enable` prompt', async () => {
    const router = await hardenedRouter([
      'username bob privilege 7 secret BobPass',
      'enable secret Cisco123',
    ]);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable');
    await type(session, 'BobPass');
    expect(screen(session)).toContain('% Access denied');
    await type(session, 'show privilege');
    expect(screen(session)).not.toContain('Current privilege level is 15');
  });

  it('`enable password` is ignored while an `enable secret` exists', async () => {
    const router = await hardenedRouter(['enable password Weak', 'enable secret Strong']);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable');
    await type(session, 'Weak');
    expect(screen(session)).toContain('% Access denied');
    await type(session, 'show privilege');
    expect(screen(session)).not.toContain('Current privilege level is 15');
  });

  it('three tries at the `enable` prompt, then back to user EXEC', async () => {
    const router = await hardenedRouter(['enable secret Strong']);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable');
    for (const wrong of ['a', 'b', 'c']) await type(session, wrong);
    expect(screen(session)).toContain('% Bad secrets');
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'show privilege');
    expect(screen(session)).toContain('Current privilege level is 1');
  });
});

describe('the login gate does not open by insisting', () => {
  const LOGIN_LOCAL = [
    'username bob privilege 1 secret BobPass',
    'line console 0', 'login local', 'exit',
  ];

  it('three failed logins reopen the prompt instead of handing over a shell', async () => {
    const router = await hardenedRouter(LOGIN_LOCAL);
    const session = await consoleSession(router);
    expect(session.currentInputMode.type).not.toBe('normal');

    for (let i = 0; i < 3; i++) { await type(session, 'bob'); await type(session, 'wrong'); }

    expect(screen(session)).toContain('% Bad passwords');
    expect(session.currentInputMode.type, 'a shell was handed to whoever insists').not.toBe('normal');
    expect(screen(session).match(/User Access Verification/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
    expect((session as unknown as { authenticatedUsername: string | null })
      .authenticatedUsername).toBeNull();
  });

  it('Ctrl+C at the prompt does not hand over a shell', async () => {
    const router = await hardenedRouter(LOGIN_LOCAL);
    const session = await consoleSession(router);
    session.handleKey(key('c', true));
    for (let i = 0; i < 40; i++) await tick();
    expect(session.currentInputMode.type).not.toBe('normal');
  });

  it('control: the right credentials open it, once', async () => {
    const router = await hardenedRouter(LOGIN_LOCAL);
    const session = await consoleSession(router);
    await type(session, 'bob');
    await type(session, 'BobPass');
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'show privilege');
    expect(screen(session)).toContain('Current privilege level is 1');
  });
});

describe('a restricted view stays restricted', () => {
  async function readOnlyView(): Promise<CiscoTerminalSession> {
    const router = await hardenedRouter([
      'enable secret Fifteen', 'aaa new-model',
      'parser view READONLY', 'secret ViewSecret',
      'commands exec include show version', 'exit',
    ]);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable');
    await type(session, 'Fifteen');
    await type(session, 'enable view READONLY');
    await type(session, 'ViewSecret');
    return session;
  }

  it('commands carrying a CONFIRMATION do not bypass the view', async () => {
    const session = await readOnlyView();
    for (const attack of ['reload', 'write erase', 'erase startup-config']) {
      const mark = session.lines.length;
      await type(session, attack);
      expect(since(session, mark), attack).toContain('% Invalid input');
      expect(session.currentInputMode.type, `${attack} opened a dialogue`).toBe('normal');
    }
  });

  it('ordinary commands outside the view are absent', async () => {
    const session = await readOnlyView();
    for (const attack of ['show running-config', 'configure terminal', 'show ip route']) {
      const mark = session.lines.length;
      await type(session, attack);
      expect(since(session, mark), attack).toContain('% Invalid input');
    }
  });

  it('control: the command INCLUDED in the view answers', async () => {
    const session = await readOnlyView();
    const mark = session.lines.length;
    await type(session, 'show version');
    expect(since(session, mark)).toContain('Cisco IOS Software');
  });
});

describe('delegation grants only what it names', () => {
  const DELEGATED = [
    'enable secret Fifteen', 'enable secret level 5 Five',
    'privilege exec level 5 show ip route',
  ];

  async function atLevelFive(): Promise<CiscoTerminalSession> {
    const router = await hardenedRouter(DELEGATED);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable 5');
    await type(session, 'Five');
    return session;
  }

  it('a delegated level does not reach the neighbouring commands', async () => {
    const session = await atLevelFive();
    await type(session, 'show privilege');
    expect(screen(session)).toContain('Current privilege level is 5');

    for (const attack of ['show running-config', 'configure terminal', 'debug ip packet', 'reload']) {
      const mark = session.lines.length;
      await type(session, attack);
      expect(since(session, mark), attack).toContain('% Invalid input');
    }
  });

  it('control: the delegated command answers at that level', async () => {
    const session = await atLevelFive();
    const mark = session.lines.length;
    await type(session, 'show ip route');
    expect(since(session, mark)).toContain('Codes:');
  });
});

describe('secrets cannot be read back', () => {
  it('no secret is rendered in clear in the configuration', async () => {
    const router = await hardenedRouter([
      'enable secret Cisco123',
      'username bob privilege 7 secret BobPass',
    ]);
    const config = await router.executeCommand('show running-config');
    expect(config).not.toContain('Cisco123');
    expect(config).not.toContain('BobPass');
    expect(config).toMatch(/enable secret 5 \$1\$/);
  });

  it('`service password-encryption` covers the line password', async () => {
    const router = await hardenedRouter([
      'service password-encryption',
      'line vty 0 4', 'password ClearOnTheLine', 'exit',
    ]);
    const config = await router.executeCommand('show running-config');
    expect(config).not.toContain('ClearOnTheLine');
    expect(config).toMatch(/password 7 [0-9A-F]+/);
  });

  it('a hash pasted by hand is not a password', async () => {
    const router = await hardenedRouter(['enable secret 5 $1$simulated$abc']);
    await router.executeCommand('disable');
    const session = await consoleSession(router);
    await type(session, 'enable');
    await type(session, '$1$simulated$abc');
    expect(screen(session)).toContain('% Access denied');
  });

  it('a deleted account no longer authenticates', async () => {
    const router = await hardenedRouter(['username bob privilege 15 secret BobPass']);
    const credentials = (router as unknown as {
      getCredentialStore(): { authenticate(u: string, p: string): boolean };
    }).getCredentialStore();
    expect(credentials.authenticate('bob', 'BobPass')).toBe(true);
    await router.executeCommand('configure terminal');
    await router.executeCommand('no username bob');
    await router.executeCommand('end');
    expect(credentials.authenticate('bob', 'BobPass')).toBe(false);
  });
});

describe('network doors open only when asked', () => {
  const listeningPorts = (router: CiscoRouter): number[] =>
    (router as unknown as { tcpv2: { listListeners(): { localPort: number }[] } })
      .tcpv2.listListeners().map((l) => l.localPort);

  it('`transport input none` closes telnet AND ssh', async () => {
    const router = await hardenedRouter(['line vty 0 4', 'transport input none', 'exit']);
    expect(listeningPorts(router)).not.toContain(23);
    expect(listeningPorts(router)).not.toContain(22);
  });

  it('`transport input ssh` does not open telnet', async () => {
    const router = await hardenedRouter([
      'ip domain-name lab.local', 'crypto key generate rsa',
      'line vty 0 4', 'transport input ssh', 'exit',
    ]);
    expect(listeningPorts(router)).toContain(22);
    expect(listeningPorts(router)).not.toContain(23);
  });

  it('ssh without a host key does not listen, even when asked', async () => {
    const router = await hardenedRouter(['line vty 0 4', 'transport input ssh', 'exit']);
    expect(listeningPorts(router)).not.toContain(22);
  });
});
