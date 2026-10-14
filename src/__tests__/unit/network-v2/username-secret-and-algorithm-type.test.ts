/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands S to Z):
 * `username name secret {0 | 4 | 5 | 8 | 9} ...` and `username name algorithm-type {md5 | scrypt | sha256}`.
 *
 *   secret 0 clear     stored as a type 5 hash (MD5), the clear text never reappears
 *   secret 5 | 8 | 9   an already hashed secret, stored under its own type
 *   secret 4           deprecated: the command is kept AS GIVEN and answers the book's warning
 *   algorithm-type     md5 = type 5, sha256 = type 8 (PBKDF2), scrypt = type 9
 *
 * The last block logs in over a real telnet session, so that "a secret is stored" is proved by the login
 * that uses it, not by the rendering alone.
 *
 * Measured with src stashed to HEAD: 4 of the 14 cases fall -- a type 4 secret was turned into a type
 * 8 hash of the HASH TEXT (so the book's warning was never printed, the line was rewritten, and the
 * hash text itself logged in), and a hash that is no hash was silently taken for a password. The 10
 * others pass either way: they are the type 0, 5, 8, 9 and algorithm-type behaviours that already
 * held, here proved through a real telnet login as well.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { connectTelnet, settle } from './_helpers/telnetWireClient';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function configured(lines: string[]): Promise<{ router: CiscoRouter; outputs: string[] }> {
  const router = new CiscoRouter('R1');
  const outputs: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines]) outputs.push(await router.executeCommand(line));
  await router.executeCommand('end');
  return { router, outputs };
}

const runningUser = async (router: CiscoRouter, name: string): Promise<string> =>
  (await router.executeCommand('show running-config')).split('\n').find((l) => l.startsWith(`username ${name} `)) ?? '';

describe('username secret', () => {
  it('type 0 is stored as a type 5 hash, never in clear', async () => {
    const { router } = await configured(['username abc secret 0 xyz']);
    const line = await runningUser(router, 'abc');
    expect(line).toMatch(/^username abc secret 5 \$1\$/);
    expect(line).not.toContain('xyz');
  });

  it('the book example, a type 5 hash, is kept as typed', async () => {
    const { router } = await configured(['username cde secret 5 $1$feb0$a104Qd9UZ./Ak00KTggPD0']);
    expect(await runningUser(router, 'cde')).toBe('username cde secret 5 $1$feb0$a104Qd9UZ./Ak00KTggPD0');
  });

  it('the book example, a type 8 hash, is kept as typed', async () => {
    const hash = '$8$dsYGNam3K1SIJO$7nv/35M/qr6t.dVc7UY9zrJDWRVqncHub1PE9UlMQFs';
    const { router } = await configured([`username n8 secret 8 ${hash}`]);
    expect(await runningUser(router, 'n8')).toBe(`username n8 secret 8 ${hash}`);
  });

  it('a type 9 hash is kept as typed', async () => {
    const hash = '$9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM';
    const { router } = await configured([`username n9 secret 9 ${hash}`]);
    expect(await runningUser(router, 'n9')).toBe(`username n9 secret 9 ${hash}`);
  });

  it('type 4 is kept as given and answers the book warning', async () => {
    const hash = 'tnhtc92DXBhelxjYk8LWJrPV36S2i4ntXrpb4RFmfqY';
    const { router, outputs } = await configured([`username demo secret 4 ${hash}`]);
    expect(outputs.at(-1)).toContain('WARNING: Command has been added to the configuration but Type 4 passwords have been deprecated.');
    expect(outputs.at(-1)).toContain('Migrate to a supported password type');
    expect(await runningUser(router, 'demo')).toBe(`username demo secret 4 ${hash}`);
  });

  it('a type 4 secret never authenticates: neither the hash text nor any password opens it', async () => {
    const hash = 'tnhtc92DXBhelxjYk8LWJrPV36S2i4ntXrpb4RFmfqY';
    const { router } = await configured([`username demo secret 4 ${hash}`]);
    const store = router.getCredentialStore();
    expect(store.authenticate('demo', hash)).toBe(false);
    expect(store.authenticate('demo', 'cisco')).toBe(false);
  });

  it('a hash that is no hash is refused and nothing is stored', async () => {
    const { router, outputs } = await configured(['username bad secret 5 notahash']);
    expect(outputs.at(-1)).toContain('The secret you entered is not a valid encrypted secret.');
    expect(outputs.at(-1)).toContain('do not specify type 5 encryption');
    expect(await runningUser(router, 'bad')).toBe('');
  });
});

describe('username algorithm-type', () => {
  it.each([
    ['md5', /^username t secret 5 \$1\$/],
    ['sha256', /^username t secret 8 \$8\$/],
    ['scrypt', /^username t secret 9 \$9\$/],
  ])('%s hashes the clear secret under its type', async (algorithm, expected) => {
    const { router } = await configured([`username t algorithm-type ${algorithm} secret cisco`]);
    expect(await runningUser(router, 't')).toMatch(expected);
    expect(router.getCredentialStore().authenticate('t', 'cisco')).toBe(true);
    expect(router.getCredentialStore().authenticate('t', 'wrong')).toBe(false);
  });

  it('an unknown algorithm is refused', async () => {
    const { outputs } = await configured(['username t algorithm-type zorglub secret cisco']);
    expect(outputs.at(-1)).toContain('% Invalid input detected');
  });
});

describe('the stored secret opens a real telnet session', () => {
  async function wireLab(lines: string[]) {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const router = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(router.getPorts()[0], sw.getPorts()[1]);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    for (const c of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.6 255.255.255.0', 'no shutdown', 'exit',
      'line vty 0 4', 'login local', 'exit', ...lines, 'end',
    ]) await router.executeCommand(c);
    await pc.executeCommand('ping -c 1 10.0.0.6');
    return { pc };
  }

  async function attempt(pc: LinuxPC, user: string, password: string): Promise<string> {
    const telnet = await connectTelnet(pc, '10.0.0.6');
    telnet.send(user);
    await settle();
    telnet.send(password);
    await settle();
    return telnet.received;
  }

  it('a user created with a clear secret and one with algorithm-type scrypt both log in with their password', async () => {
    const { pc } = await wireLab(['username abc privilege 15 secret 0 xyz', 'username t algorithm-type scrypt secret cisco']);
    expect(await attempt(pc, 'abc', 'xyz')).toMatch(/R1|cisco1|>/);
    expect(await attempt(pc, 't', 'cisco')).toMatch(/cisco1|>/);
  });

  it('witness: a wrong password does not log in', async () => {
    const { pc } = await wireLab(['username abc privilege 15 secret 0 xyz']);
    expect(await attempt(pc, 'abc', 'nope')).toContain('% Login invalid');
  });

  it('a type 4 secret opens nothing, not even with the hash text', async () => {
    const hash = 'tnhtc92DXBhelxjYk8LWJrPV36S2i4ntXrpb4RFmfqY';
    const { pc } = await wireLab([`username demo secret 4 ${hash}`]);
    expect(await attempt(pc, 'demo', hash)).toContain('% Login invalid');
  });
});
