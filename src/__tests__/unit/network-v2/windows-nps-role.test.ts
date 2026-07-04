/**
 * PRD-Windows-Server.md §5 P9 — NPS (RADIUS) role core: `WindowsNpsRole`
 * hosts the real RADIUS engine (src/network/radius/RadiusServerAgent.ts)
 * over genuine UDP 1812/1813 — NAS clients, network policies, and real
 * Access-Request/Accept/Reject exchanges, reusing the same engine the
 * Linux freeradius host already hosts (no RADIUS logic reimplemented).
 * User base is always the local SAM or AD — never a dedicated list.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsNpsRole } from '@/network/devices/windows/server/nps/WindowsNpsRole';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function topology() {
  const nas = new CiscoRouter('NAS');
  const nps = new WindowsServer('NPS1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  new Cable('b').connect(nps.getPorts()[0], sw.getPorts()[1]);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  nps.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nps.setCurrentUser('Administrator');
  return { nas, nps };
}

describe('WindowsNpsRole — NAS client + network policy admin surface', () => {
  it('adds a NAS client and lists it back', () => {
    const { nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    const res = role.addNasClient('SW1', '10.0.0.1', 'shared-secret');
    expect(res.ok).toBe(true);
    expect(role.getNasClient('SW1')).toEqual({ name: 'SW1', ipAddress: '10.0.0.1' });
  });

  it('refuses a duplicate NAS client name', () => {
    const { nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.addNasClient('SW1', '10.0.0.1', 'shared-secret');
    const res = role.addNasClient('SW1', '10.0.0.99', 'other-secret');
    expect(res.ok).toBe(false);
  });

  it('adds a network policy and lists it back', () => {
    const { nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    const res = role.addNetworkPolicy('VLAN200-Policy', 'Sales', { vlanId: 200, sessionTimeoutSec: 3600 });
    expect(res.ok).toBe(true);
    expect(role.listNetworkPolicies()).toEqual([
      { name: 'VLAN200-Policy', group: 'Sales', vlanId: 200, sessionTimeoutSec: 3600 },
    ]);
  });
});

describe('WindowsNpsRole — real UDP 1812 authentication against the local SAM', () => {
  it('accepts a SAM user whose group matches a network policy, returning dynamic VLAN attrs', async () => {
    const { nas, nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.start();
    role.addNasClient('NAS', '10.0.0.1', 'shared-secret');
    nps.getUserManager().createUser('raduser1', 'S3cur3P@ss1');
    nps.getUserManager().createGroup('Sales');
    nps.getUserManager().addGroupMember('Sales', 'raduser1');
    role.addNetworkPolicy('SalesPolicy', 'Sales', { vlanId: 200 });

    nas.getRadiusClient().addServer('10.0.0.2', 'shared-secret', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('raduser1', 'S3cur3P@ss1');
    expect(accepted).toBe(true);
  });

  it('rejects a user whose group matches no network policy (default deny)', async () => {
    const { nas, nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.start();
    role.addNasClient('NAS', '10.0.0.1', 'shared-secret');
    nps.getUserManager().createUser('raduser2', 'AnotherP@ss2');
    role.addNetworkPolicy('SalesPolicy', 'Sales', { vlanId: 200 });

    nas.getRadiusClient().addServer('10.0.0.2', 'shared-secret', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('raduser2', 'AnotherP@ss2');
    expect(accepted).toBe(false);
  });

  it('rejects a correct group match with the wrong password', async () => {
    const { nas, nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.start();
    role.addNasClient('NAS', '10.0.0.1', 'shared-secret');
    nps.getUserManager().createUser('raduser1', 'S3cur3P@ss1');
    nps.getUserManager().createGroup('Sales');
    nps.getUserManager().addGroupMember('Sales', 'raduser1');
    role.addNetworkPolicy('SalesPolicy', 'Sales', { vlanId: 200 });

    nas.getRadiusClient().addServer('10.0.0.2', 'shared-secret', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('raduser1', 'wrong-password');
    expect(accepted).toBe(false);
  });

  it('writes Security-log accept/reject entries (6272/6273)', async () => {
    const { nas, nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.start();
    role.addNasClient('NAS', '10.0.0.1', 'shared-secret');
    nps.getUserManager().createUser('raduser1', 'S3cur3P@ss1');
    nps.getUserManager().createGroup('Sales');
    nps.getUserManager().addGroupMember('Sales', 'raduser1');
    role.addNetworkPolicy('SalesPolicy', 'Sales', { vlanId: 200 });

    nas.getRadiusClient().addServer('10.0.0.2', 'shared-secret', { timeoutMs: 200, retransmit: 0 });
    await nas.getRadiusClient().authenticate('raduser1', 'S3cur3P@ss1');
    await nas.getRadiusClient().authenticate('raduser2', 'nope');

    const security = nps.eventLog.getEntriesStructured('Security');
    expect(security?.some(e => e.eventId === 6272)).toBe(true);
    expect(security?.some(e => e.eventId === 6273)).toBe(true);
  });

  it('falls back to AD when the user has no local SAM account (NPS co-located with the DC)', async () => {
    const { nas, nps } = topology();
    nps.getRoleManager().install('AD-Domain-Services');
    nps.installADDSForest('lab.local', 'LAB', 'P@ssw0rd');
    const store = nps.getDirectoryStore()!;
    store.newGroup('Sales');
    store.newUser('carol', { password: 'AdP@ss3', fullName: 'Carol' });
    store.addGroupMember('Sales', 'carol');

    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.start();
    role.addNasClient('NAS', '10.0.0.1', 'shared-secret');
    role.addNetworkPolicy('SalesPolicy', 'Sales', { vlanId: 300 });

    nas.getRadiusClient().addServer('10.0.0.2', 'shared-secret', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('carol', 'AdP@ss3');
    expect(accepted).toBe(true);
  });

  it('stops authenticating once stop() is called', async () => {
    const { nas, nps } = topology();
    const role = new WindowsNpsRole(nps, nps, nps.eventLog);
    role.start();
    role.addNasClient('NAS', '10.0.0.1', 'shared-secret');
    nps.getUserManager().createUser('raduser1', 'S3cur3P@ss1');
    nps.getUserManager().createGroup('Sales');
    nps.getUserManager().addGroupMember('Sales', 'raduser1');
    role.addNetworkPolicy('SalesPolicy', 'Sales', { vlanId: 200 });
    role.stop();

    nas.getRadiusClient().addServer('10.0.0.2', 'shared-secret', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('raduser1', 'S3cur3P@ss1');
    expect(accepted).toBe(false);
  });
});
