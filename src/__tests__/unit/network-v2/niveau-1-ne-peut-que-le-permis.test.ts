import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

type Platform = CiscoRouter | CiscoSwitch;

const PLATFORMS: ReadonlyArray<readonly [string, () => Platform]> = [
  ['router', () => new CiscoRouter('R1', 0, 0)],
  ['switch', () => new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0)],
];

const PROVISIONED_LEVEL_1 = 'alice';

/**
 * Commands real IOS keeps in privileged EXEC. Each one either changes the
 * box, dumps its configuration, or discloses a secret — `show snmp
 * community` prints the community strings in clear, which are the
 * credentials of a read-write management channel.
 */
const PRIVILEGED_EXEC = [
  'show running-config', 'show startup-config', 'configure terminal',
  'show logging', 'show snmp community', 'show snmp host', 'show snmp user',
  'show parser view', 'show ip ssh', 'show ssh',
  'show platform', 'show diag',
  'show license', 'show ip http server status',
  'debug ip packet', 'reload', 'copy running-config startup-config',
  'write memory', 'erase startup-config', 'clear line vty 0',
  'clear ntp statistics', 'setup',
];

/**
 * Commands real IOS leaves in user EXEC. `show processes`, `show memory`
 * and `show controllers` belong here and not above: they are diagnostic
 * counters, disclosing neither configuration nor credential, and the IOS
 * Configuration Fundamentals reference gives all three the command mode
 * `User EXEC, Privileged EXEC`. Confining them was over-reach on my part,
 * measured by the three suites it broke.
 */
const USER_EXEC = [
  'show version', 'show clock', 'show users', 'show sessions',
  'show terminal', 'show history', 'show privilege', 'show line',
  'show inventory', 'show hosts', 'terminal length 0', 'where',
  'show processes cpu', 'show memory statistics', 'show controllers',
];

/**
 * The router ships the provisioned cast (alice/bob/carl/dave, all level 1);
 * a switch ships none, so the same account is declared there by hand — the
 * rule under test is the confinement, and it must read identically on both.
 */
async function provisioned(make: () => Platform): Promise<Platform> {
  const device = make();
  device.powerOn();
  const store = (device as unknown as {
    getCredentialStore(): { authenticate(u: string, p: string): boolean };
  }).getCredentialStore();
  const shipped = store.authenticate(PROVISIONED_LEVEL_1, PROVISIONED_LEVEL_1);

  const setup = ['enable', 'configure terminal',
    'snmp-server community S3cr3tRO ro',
    'enable secret Cisco123'];
  if (!shipped) {
    setup.push(`username ${PROVISIONED_LEVEL_1} privilege 1 secret ${PROVISIONED_LEVEL_1}`);
  }
  setup.push('line console 0', 'login local', 'exit', 'end', 'disable');
  for (const c of setup) await device.executeCommand(c);
  return device;
}

async function loggedInAsAlice(device: Platform): Promise<CiscoTerminalSession> {
  const session = new CiscoTerminalSession('t1', device as never);
  await session.init();
  for (let i = 0; i < 400 && session.isBooting; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await type(session, PROVISIONED_LEVEL_1);
  await type(session, PROVISIONED_LEVEL_1);
  await type(session, 'terminal length 0');
  return session;
}

async function type(session: CiscoTerminalSession, line: string): Promise<void> {
  if (session.currentInputMode.type === 'normal') session.setInput(line);
  else session.insertText(line);
  session.handleKey(key('Enter'));
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
}

function answerTo(session: CiscoTerminalSession, mark: number): string {
  return session.lines.slice(mark + 1).map((l) => l.text).join('\n');
}

for (const [name, make] of PLATFORMS) {
  describe(`${name} — a provisioned level-1 user reaches only user EXEC`, () => {
    it('signs in at level 1, with the `>` prompt', async () => {
      const device = await provisioned(make);
      const session = await loggedInAsAlice(device);

      expect(session.currentInputMode.type, 'the login gate never opened').toBe('normal');
      const mark = session.lines.length;
      await type(session, 'show privilege');
      expect(answerTo(session, mark)).toContain('Current privilege level is 1');
      expect(session.getPrompt().endsWith('>')).toBe(true);
    });

    it('is refused every privileged EXEC command', async () => {
      const device = await provisioned(make);
      const session = await loggedInAsAlice(device);

      for (const attack of PRIVILEGED_EXEC) {
        const mark = session.lines.length;
        await type(session, attack);
        expect(answerTo(session, mark), attack).toContain('% Invalid input');
      }
    });

    it('keeps the user EXEC commands it is entitled to', async () => {
      const device = await provisioned(make);
      const session = await loggedInAsAlice(device);

      for (const allowed of USER_EXEC) {
        const mark = session.lines.length;
        await type(session, allowed);
        expect(answerTo(session, mark), allowed).not.toContain('% Invalid input');
      }
    });

    it('never sees the SNMP community string', async () => {
      const device = await provisioned(make);
      const session = await loggedInAsAlice(device);
      for (const attempt of ['show snmp community', 'show snmp', 'show running-config']) {
        await type(session, attempt);
      }
      expect(session.lines.map((l) => l.text).join('\n')).not.toContain('S3cr3tRO');
    });

    it('cannot reach privileged mode without the enable secret', async () => {
      const device = await provisioned(make);
      const session = await loggedInAsAlice(device);

      await type(session, 'enable');
      expect(session.currentInputMode.type).toBe('password');
      // IOS gives three tries per `enable`; the prompt stays until they
      // are spent, so anything typed meanwhile is a password attempt.
      for (const guess of [PROVISIONED_LEVEL_1, 'alice2', 'alice3']) await type(session, guess);
      expect(session.lines.map((l) => l.text).join('\n')).toContain('% Access denied');
      expect(session.currentInputMode.type).toBe('normal');

      const mark = session.lines.length;
      await type(session, 'show privilege');
      expect(answerTo(session, mark)).toContain('Current privilege level is 1');
    });

    it('control: the same commands answer once the operator does enable', async () => {
      const device = await provisioned(make);
      const session = await loggedInAsAlice(device);
      await type(session, 'enable');
      await type(session, 'Cisco123');
      await type(session, 'terminal length 0');

      for (const allowed of ['show running-config', 'show logging', 'show snmp community']) {
        const mark = session.lines.length;
        await type(session, allowed);
        expect(answerTo(session, mark), allowed).not.toContain('% Invalid input');
      }
    });
  });
}

describe('the provisioned accounts are level 1, and say so', () => {
  it('alice, bob, carl and dave are all privilege 1 out of the box', async () => {
    const router = new CiscoRouter('R1', 0, 0);
    router.powerOn();
    const store = (router as unknown as {
      getCredentialStore(): {
        lookup(name: string): { privilege: number } | undefined;
        authenticate(user: string, password: string): boolean;
      };
    }).getCredentialStore();

    for (const name of ['alice', 'bob', 'carl', 'dave']) {
      expect(store.authenticate(name, name), `${name} cannot sign in`).toBe(true);
      expect(store.lookup(name)?.privilege, `${name} is not level 1`).toBe(1);
    }
  });
});
