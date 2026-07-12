/**
 * Account lockout policy — `effectivePasswordPolicyFor` (PSO, or the
 * domain default from Default Domain Policy) existed but was never
 * actually enforced anywhere. `DirectoryStore.checkPassword` — the sole
 * gate for a real LDAP simple bind — now tracks `badPwdCount`/
 * `lockoutTime` and locks the account out after `lockoutThreshold`
 * consecutive failures, for `lockoutDurationMinutes`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildDc(): Promise<{ dc: WindowsServer; client: WindowsServer }> {
  const dc = new WindowsServer('DC1');
  const client = new WindowsServer('CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.83.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.83.20'), mask);
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  dc.installADDSForest('lab.local', 'LAB', 'P@ssw0rd');
  return { dc, client };
}

function bindAttempts(client: WindowsServer, sam: string, password: string, count: number): boolean[] {
  const results: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const conn = dialLdap(client.getTcpStack(), '192.168.83.10');
    const ldap = conn.client!;
    results.push(ldap.bind(sam, password).ok);
    ldap.unbind();
  }
  return results;
}

describe('DirectoryStore — account lockout, domain default policy (threshold 5)', () => {
  it('locks the account out after the domain default lockoutThreshold consecutive failures', async () => {
    const { dc, client } = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newUser('alice', { password: 'alicepw' });

    const failures = bindAttempts(client, 'alice', 'wrongpassword', 5);
    expect(failures.every(ok => ok === false)).toBe(true);
    expect(store.isAccountLockedOut('alice')).toBe(true);
    expect(store.getUser('alice')!.lockedOut).toBe(true);

    const conn = dialLdap(client.getTcpStack(), '192.168.83.10');
    const stillLocked = conn.client!.bind('alice', 'alicepw');
    expect(stillLocked.ok).toBe(false);
  });

  it('resets the bad-password count on a successful bind before the threshold is reached', async () => {
    const { dc, client } = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newUser('bob', { password: 'bobpw' });

    bindAttempts(client, 'bob', 'wrong', 4);
    const conn = dialLdap(client.getTcpStack(), '192.168.83.10');
    expect(conn.client!.bind('bob', 'bobpw').ok).toBe(true);
    expect(store.isAccountLockedOut('bob')).toBe(false);

    bindAttempts(client, 'bob', 'wrong', 4);
    expect(store.isAccountLockedOut('bob')).toBe(false);
  });

  it('Unlock-ADAccount-equivalent clears the lockout immediately', async () => {
    const { dc, client } = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newUser('carol', { password: 'carolpw' });
    bindAttempts(client, 'carol', 'wrong', 5);
    expect(store.isAccountLockedOut('carol')).toBe(true);

    expect(store.unlockAccount('carol').ok).toBe(true);
    expect(store.isAccountLockedOut('carol')).toBe(false);
    const conn = dialLdap(client.getTcpStack(), '192.168.83.10');
    expect(conn.client!.bind('carol', 'carolpw').ok).toBe(true);
  });
});

describe('DirectoryStore — account lockout, PSO override', () => {
  it('a PSO with a lower lockoutThreshold takes precedence over the domain default', async () => {
    const { dc, client } = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newUser('dave', { password: 'davepw' });
    store.newPso('StrictLockout', 1, { lockoutThreshold: 2, lockoutDurationMinutes: 30 });
    store.setPsoAppliesTo('StrictLockout', ['dave']);

    const failures = bindAttempts(client, 'dave', 'wrong', 2);
    expect(failures.every(ok => ok === false)).toBe(true);
    expect(store.isAccountLockedOut('dave')).toBe(true);
  });
});
