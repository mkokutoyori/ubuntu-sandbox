/**
 * Probe — networkd reports what it does not recognise in its configuration files, as systemd 255.4 does
 * (shared/conf-parser.c next_assignment / parse_line, with the key tables of network/networkd-network-gperf.gperf and
 * network/netdev/netdev-gperf.gperf): "Unknown key name 'K' in section 'S', ignoring.", "Unknown section 'S'. Ignoring.",
 * "Missing '=', ignoring line." and "Assignment outside of section. Ignoring.", each prefixed by file:line, in the journal of
 * systemd-networkd when the daemon starts or `networkctl reload` runs. A .netdev is parsed twice (the first pass ignores
 * the kind sections, the second keeps those of its Kind=), so a bad key in [NetDev] is reported twice and a [Bridge] section
 * in a vlan netdev once.
 *
 * Measured against the preceding commit (git stash push -- src/network): 8 of the 11 cases fall (nothing was reported).
 * The 3 that pass either way are WITNESSES: a file made only of known keys reports nothing (the key tables do not refuse
 * valid configuration), X- extensions are silent, and a .link is the business of udev, not of networkd.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

function newPc(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  pc.configureInterface('eth0', new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
  return pc;
}

function write(pc: LinuxPC, path: string, text: string): void {
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.mkdirp(path.slice(0, path.lastIndexOf('/')), 0o755, 0, 0);
  vfs.writeFile(path, text, 0, 0, 0o644);
}

async function journal(pc: LinuxPC): Promise<string[]> {
  const out = await pc.executeCommand('journalctl --no-pager -t systemd-networkd');
  return out.split('\n').filter((line) => line.includes('systemd-networkd['));
}

async function restart(pc: LinuxPC): Promise<void> {
  await pc.executeCommand('systemctl restart systemd-networkd');
}

describe('networkd configuration diagnostics', () => {
  it('witness: a .network made of known keys reports nothing', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-ok.network', '[Match]\nName=eth9\n\n[Network]\nAddress=10.1.0.2/24\nGateway=10.1.0.1\nDHCP=no\n\n[Route]\nGateway=10.1.0.1\nDestination=10.9.0.0/16\n');
    await restart(pc);
    expect((await journal(pc)).filter((line) => /Unknown|Missing|outside/.test(line))).toEqual([]);
  });

  it('reports an unknown key with its file and line', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-bad.network', '[Match]\nName=eth9\n\n[Network]\nAddress=10.1.0.2/24\nZorglub=1\n');
    await restart(pc);
    expect(await journal(pc)).toEqual([expect.stringContaining("/etc/systemd/network/10-bad.network:6: Unknown key name 'Zorglub' in section 'Network', ignoring.")]);
  });

  it('reports a key that exists in another section as unknown in this one', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-bad.network', '[Match]\nName=eth9\nAddress=10.1.0.2/24\n');
    await restart(pc);
    expect(await journal(pc)).toEqual([expect.stringContaining("/etc/systemd/network/10-bad.network:3: Unknown key name 'Address' in section 'Match', ignoring.")]);
  });

  it('reports an unknown section and skips its keys silently', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-bad.network', '[Match]\nName=eth9\n\n[Netwrok]\nAddress=10.1.0.2/24\n');
    await restart(pc);
    expect(await journal(pc)).toEqual([expect.stringContaining("/etc/systemd/network/10-bad.network:4: Unknown section 'Netwrok'. Ignoring.")]);
  });

  it('reports a line without equals sign and an assignment outside any section', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-bad.network', 'Name=eth9\n[Match]\nName=eth9\nnonsense\n');
    await restart(pc);
    const lines = await journal(pc);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('/etc/systemd/network/10-bad.network:1: Assignment outside of section. Ignoring.');
    expect(lines[1]).toContain("/etc/systemd/network/10-bad.network:4: Missing '=', ignoring line.");
  });

  it('witness: X- extensions are silent', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-x.network', '[Match]\nName=eth9\nX-Note=yes\n\n[X-Vendor]\nAnything=1\n');
    await restart(pc);
    expect(await journal(pc)).toEqual([]);
  });

  it('names the drop-in file that carries the error', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-d.network', '[Match]\nName=eth9\n');
    write(pc, '/etc/systemd/network/10-d.network.d/override.conf', '[Network]\nBogus=1\n');
    await restart(pc);
    expect(await journal(pc)).toEqual([expect.stringContaining("/etc/systemd/network/10-d.network.d/override.conf:2: Unknown key name 'Bogus' in section 'Network', ignoring.")]);
  });

  it('parses a .netdev twice: a bad key in [NetDev] is reported by both passes', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/20-br.netdev', '[NetDev]\nName=br9\nKind=bridge\nBogus=1\n\n[Bridge]\nSTP=yes\n');
    await restart(pc);
    const lines = (await journal(pc)).filter((line) => line.includes("Unknown key name 'Bogus'"));
    expect(lines).toHaveLength(2);
    expect((await journal(pc)).filter((line) => line.includes("Unknown section 'Bridge'"))).toEqual([]);
  });

  it('refuses a section of another kind in a .netdev, once', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/20-v.netdev', '[NetDev]\nName=vlan9\nKind=vlan\n\n[VLAN]\nId=9\n\n[Bridge]\nSTP=yes\n');
    await restart(pc);
    expect((await journal(pc)).filter((line) => line.includes("Unknown section 'Bridge'"))).toEqual([expect.stringContaining('/etc/systemd/network/20-v.netdev:8: Unknown section')]);
  });

  it('witness: a .link is read by udev, not by networkd', async () => {
    const pc = newPc();
    write(pc, '/etc/systemd/network/10-x.link', '[Match]\nOriginalName=eth9\n\n[Link]\nBogus=1\n');
    await restart(pc);
    expect(await journal(pc)).toEqual([]);
  });

  it('networkctl reload reports them again', async () => {
    const pc = newPc();
    await restart(pc);
    write(pc, '/etc/systemd/network/10-late.network', '[Match]\nName=eth9\n\n[Network]\nZorglub=1\n');
    await pc.executeCommand('sudo networkctl reload');
    expect((await journal(pc)).some((line) => line.includes("10-late.network:5: Unknown key name 'Zorglub'"))).toBe(true);
  });
});
