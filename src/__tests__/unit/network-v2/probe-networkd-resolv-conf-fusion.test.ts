/**
 * systemd-networkd adds the DNS= and Domains= of a .network file to /etc/resolv.conf and takes back what it added at the previous application; it does not own the rest of the file.
 * Measured before the change: every application rewrote the whole file, so a static `nameserver` line (or a server learned from a Router Advertisement or a lease) vanished at the first
 * `systemctl restart systemd-networkd`. The file keeps announcing who wrote it (`managed by systemd-networkd`). A restart must not pile the entries up, and editing the .network file replaces them.
 * Discriminated with git stash on src/network: 2 of 4 cases fall (the static line survives; a changed DNS= replaces the old one without touching the static line). The 2 that pass either way are the
 * WITNESS (the declared entries and the header land on an empty file) and the idempotence case (a restart repeated twice leaves one entry: true before because the whole file was rewritten).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const network = (dns: string) => ['[Match]', 'Name=eth0', '', '[Network]', 'Address=192.168.50.10/24', `DNS=${dns}`, 'Domains=lab.local', ''].join('\n');

async function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  pc.powerOn();
  sw.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  const vfs = (pc as unknown as { executor: { vfs: { createFileAt(p: string, c: string, m: number, u: number, g: number): unknown } } }).executor.vfs;
  return {
    pc,
    write: (path: string, content: string) => { vfs.createFileAt(path, content, 0o644, 0, 0); },
    restart: async () => { await pc.executeCommand('sudo systemctl restart systemd-networkd'); await pause(200); },
  };
}

describe('systemd-networkd and /etc/resolv.conf', () => {
  it('WITNESS: the declared entries and the header land on an empty file', async () => {
    const { pc, write, restart } = await lab();
    write('/etc/systemd/network/10-eth0.network', network('9.9.9.9'));
    await restart();
    const file = await pc.executeCommand('cat /etc/resolv.conf');
    expect(file).toContain('managed by systemd-networkd');
    expect(file).toContain('nameserver 9.9.9.9');
    expect(file).toContain('search lab.local');
  });

  it('keeps a static nameserver line', async () => {
    const { pc, write, restart } = await lab();
    await pc.executeCommand("sudo sh -c 'echo nameserver 8.8.4.4 > /etc/resolv.conf'");
    write('/etc/systemd/network/10-eth0.network', network('9.9.9.9'));
    await restart();
    const file = await pc.executeCommand('cat /etc/resolv.conf');
    expect(file).toContain('nameserver 8.8.4.4');
    expect(file).toContain('nameserver 9.9.9.9');
  });

  it('a changed DNS= replaces the old entry and leaves the static line alone', async () => {
    const { pc, write, restart } = await lab();
    await pc.executeCommand("sudo sh -c 'echo nameserver 8.8.4.4 > /etc/resolv.conf'");
    write('/etc/systemd/network/10-eth0.network', network('9.9.9.9'));
    await restart();
    write('/etc/systemd/network/10-eth0.network', network('1.1.1.1'));
    await restart();
    const file = await pc.executeCommand('cat /etc/resolv.conf');
    expect(file).not.toContain('9.9.9.9');
    expect(file).toContain('nameserver 1.1.1.1');
    expect(file).toContain('nameserver 8.8.4.4');
  });

  it('a restart repeated leaves one entry', async () => {
    const { pc, write, restart } = await lab();
    write('/etc/systemd/network/10-eth0.network', network('9.9.9.9'));
    await restart();
    await restart();
    const file = await pc.executeCommand('cat /etc/resolv.conf');
    expect(file.split('\n').filter((line) => line === 'nameserver 9.9.9.9')).toHaveLength(1);
    expect(file.split('\n').filter((line) => line.startsWith('# This file is managed'))).toHaveLength(1);
  });
});
