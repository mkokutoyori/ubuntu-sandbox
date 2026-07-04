/**
 * PRD-Windows-Server.md §5 P10 — GPO minimal core: `DirectoryStore`'s
 * GPO CRUD/link/RSoP methods, and `GpoPullClient`'s real LDAP wire
 * dialogue (`gpupdate /force`'s network round trip against the DC).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { pullGroupPolicy } from '@/network/devices/windows/domain/GpoPullClient';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildDc() {
  const dc = new WindowsServer('DC1');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  dc.installADDSForest('lab.local', 'LAB', 'P@ssw0rd');
  return dc;
}

describe('DirectoryStore — GPO CRUD/link (New-GPO/Get-GPO/New-GPLink engine)', () => {
  it('Install-ADDSForest auto-provisions Default Domain Policy linked to the domain root', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    const gpo = store.getGpo('Default Domain Policy');
    expect(gpo).not.toBeNull();
    expect(gpo!.links).toContain(store.getDomainDn());
    expect(gpo!.settings.accountPolicy?.minPasswordLength).toBe(7);
  });

  it('creates an additional GPO and links it to the domain root', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    const res = store.newGpo('Extra Policy');
    expect(res.ok).toBe(true);
    store.setGpoSettings('Extra Policy', { logonBanner: { title: 'Notice', text: 'Authorized use only' } });
    const link = store.newGPLink('Extra Policy', store.getDomainDn());
    expect(link.ok).toBe(true);
    const gpo = store.getGpo('Extra Policy')!;
    expect(gpo.links).toContain(store.getDomainDn());
    expect(gpo.settings.logonBanner?.text).toBe('Authorized use only');
  });

  it('refuses a duplicate GPO name', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    const res = store.newGpo('Default Domain Policy');
    expect(res.ok).toBe(false);
  });

  it('resultantSetOfPolicy merges domain-linked GPOs, later links overriding earlier keys', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newGpo('Extra Policy');
    store.setGpoSettings('Extra Policy', { accountPolicy: { minPasswordLength: 10 } });
    store.newGPLink('Extra Policy', store.getDomainDn());

    const rsop = store.resultantSetOfPolicy();
    expect(rsop.appliedGpoNames).toContain('Default Domain Policy');
    expect(rsop.appliedGpoNames).toContain('Extra Policy');
    expect(rsop.settings.accountPolicy?.minPasswordLength).toBe(10);
    expect(rsop.settings.accountPolicy?.lockoutThreshold).toBe(5);
  });
});

describe('GpoPullClient — real LDAP wire dialogue against the DC', () => {
  function topology() {
    return async () => {
      const dc = await buildDc();
      const client = new WindowsPC('windows-pc', 'CLIENT1');
      const sw = new GenericSwitch('switch-generic', 'SW1');
      new Cable('c1').connect(dc.getPorts()[0], sw.getPorts()[0]);
      new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
      const mask = new SubnetMask('255.255.255.0');
      dc.getPorts()[0].configureIP(new IPAddress('192.168.90.10'), mask);
      client.getPorts()[0].configureIP(new IPAddress('192.168.90.20'), mask);
      client.setCurrentUser('Administrator');
      return { dc, client };
    };
  }

  it('a domain-joined client pulls the Default Domain Policy over the wire', async () => {
    const { dc, client } = await topology()();
    await run(ps(client), 'Install-WindowsFeature AD-Domain-Services'); // no-op on a client, tolerated
    client.joinDomainNow('lab.local', '192.168.90.10', 'Administrator', 'P@ssw0rd');
    const membership = client.getDomainMembership()!;
    expect(membership).not.toBeNull();

    const result = pullGroupPolicy(client.getTcpStack(), membership, client.getHostname());
    expect(result.ok).toBe(true);
    expect(result.appliedGpoNames).toContain('Default Domain Policy');
    expect(result.settings.accountPolicy?.minPasswordLength).toBe(7);
  });

  it('fails cleanly when the DC is unreachable', async () => {
    const { client } = await topology()();
    client.joinDomainNow('lab.local', '192.168.90.10', 'Administrator', 'P@ssw0rd');
    const membership = client.getDomainMembership()!;

    const badMembership = { ...membership, dcAddress: '192.168.90.99' };
    const result = pullGroupPolicy(client.getTcpStack(), badMembership, client.getHostname());
    expect(result.ok).toBe(false);
  });
});
