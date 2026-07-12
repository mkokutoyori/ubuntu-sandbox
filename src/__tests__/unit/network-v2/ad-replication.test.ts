/**
 * PRD-Windows-Server-Advanced.md §5 P4 — real multi-DC replication over a
 * real wired topology: two independently-promoted `WindowsServer` domain
 * controllers diverge (each writes locally), then converge after
 * replication pull cycles over a real TCP/135 connection — the same USN/
 * high-watermark vector mechanism as MS-DRSR, simplified to a JSON PDU
 * (no byte-exact DRSUAPI encoding, per the module's own header comment).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildTwoDcs(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC1');
  const dc2 = new WindowsServer('DC2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.60.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.60.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc2), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

  return { dc1, dc2 };
}

describe('AD DS replication — two DCs diverge then converge over a real TCP/135 pull', () => {
  it('propagates a user created on DC1 to DC2 after DC2 pulls', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

    expect(dc2.getDirectoryStore()!.getUser('alice')).toBeNull();
    const result = dc2.replicateFrom('192.168.60.10');
    expect(result.ok).toBe(true);
    expect(result.applied).toBeGreaterThan(0);

    const replicated = dc2.getDirectoryStore()!.getUser('alice');
    expect(replicated).not.toBeNull();
    expect(replicated!.dn).toContain('CN=alice');
  });

  it('converges both ways when each DC writes a different user locally', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
    await run(ps(dc2), 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "bobpw" -AsPlainText -Force) -DisplayName "Bob"');

    dc2.replicateFrom('192.168.60.10');
    dc1.replicateFrom('192.168.60.11');

    expect(dc1.getDirectoryStore()!.getUser('alice')).not.toBeNull();
    expect(dc1.getDirectoryStore()!.getUser('bob')).not.toBeNull();
    expect(dc2.getDirectoryStore()!.getUser('alice')).not.toBeNull();
    expect(dc2.getDirectoryStore()!.getUser('bob')).not.toBeNull();
  });

  it('does not re-send objects the partner has already replicated (high-watermark vector advances)', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

    const first = dc2.replicateFrom('192.168.60.10');
    expect(first.applied).toBeGreaterThan(0);

    const second = dc2.replicateFrom('192.168.60.10');
    expect(second.applied).toBe(0);
  });

  it('propagates a subsequent attribute change (not just object creation)', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
    dc2.replicateFrom('192.168.60.10');

    await run(ps(dc1), 'Set-ADUser -Identity alice -Enabled $false');
    const result = dc2.replicateFrom('192.168.60.10');
    expect(result.applied).toBeGreaterThan(0);
    expect(dc2.getDirectoryStore()!.getUser('alice')?.enabled).toBe(false);
  });

  it('converges different attributes changed concurrently on both DCs without either clobbering the other (per-attribute replication metadata)', async () => {
    const { dc1, dc2 } = await buildTwoDcs();
    await run(ps(dc1), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
    dc2.replicateFrom('192.168.60.10');

    await run(ps(dc1), 'Set-ADUser -Identity alice -Enabled $false');
    await run(ps(dc2), 'Set-ADUser -Identity alice -DisplayName "Alice B"');

    dc2.replicateFrom('192.168.60.10');
    dc1.replicateFrom('192.168.60.11');

    const onDc1 = dc1.getDirectoryStore()!.getUser('alice')!;
    const onDc2 = dc2.getDirectoryStore()!.getUser('alice')!;
    expect(onDc1.enabled).toBe(false);
    expect(onDc1.fullName).toBe('Alice B');
    expect(onDc2.enabled).toBe(false);
    expect(onDc2.fullName).toBe('Alice B');
  });

  it('fails cleanly against a partner that is not (yet) a domain controller', async () => {
    const dc = new WindowsServer('DC3');
    const notADc = new WindowsServer('DC4');
    const sw = new GenericSwitch('switch-generic', 'SW2');
    new Cable('c-dc3').connect(dc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-dc4').connect(notADc.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc.getPorts()[0].configureIP(new IPAddress('192.168.61.10'), mask);
    notADc.getPorts()[0].configureIP(new IPAddress('192.168.61.11'), mask);

    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const result = dc.replicateFrom('192.168.61.11');
    expect(result.ok).toBe(false);
  });

  it('fails cleanly when this server is itself not (yet) a domain controller', () => {
    const notADc = new WindowsServer('DC5');
    const dc = new WindowsServer('DC6');
    const sw = new GenericSwitch('switch-generic', 'SW3');
    new Cable('c-dc5').connect(notADc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-dc6').connect(dc.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    notADc.getPorts()[0].configureIP(new IPAddress('192.168.62.10'), mask);
    dc.getPorts()[0].configureIP(new IPAddress('192.168.62.11'), mask);

    const result = notADc.replicateFrom('192.168.62.11');
    expect(result.ok).toBe(false);
  });
});
