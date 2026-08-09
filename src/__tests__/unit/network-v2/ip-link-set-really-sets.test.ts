/**
 * `ip link set` really sets.
 *
 * The parser knew exactly three things: `dev`, `up`/`down` and `mtu`.
 * Everything else fell through its loop and the command returned
 * SUCCESS — so `ip link set eth0 address 02:11:22:33:44:55` was
 * accepted, silent, and did nothing at all. That is a command that
 * changes the machine's L2 identity: MAC learning on the peer switch,
 * port security, ARP and DHCP all read that address, so a spoofing or
 * port-security lab could not be performed and nothing said why.
 *
 * `txqueuelen` and `promisc` were accepted the same way, while
 * `ip link show` kept answering `qlen 1000` and never listed PROMISC on
 * the machine that had just asked for both.
 *
 * An unrecognised keyword now gets iproute2's own refusal instead of
 * silent success — that silence was the root of all three.
 */

import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

function lab(): { pc: LinuxPC; sw: CiscoSwitch } {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  pc.powerOn(); sw.powerOn();
  new Cable('c').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  return { pc, sw };
}

const linkLine = async (pc: LinuxPC): Promise<string> =>
  (await pc.executeCommand('ip link show eth0')).split('\n')[0];

describe('the hardware address', () => {
  it('changes the port, not just the command output', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('ip link set eth0 address 02:11:22:33:44:55')).toBe('');
    expect(pc.getPort('eth0')!.getMAC().toString()).toBe('02:11:22:33:44:55');
  });

  it('and ip link show reports the new one', async () => {
    const { pc } = lab();
    await pc.executeCommand('ip link set eth0 address 02:11:22:33:44:55');
    expect(await pc.executeCommand('ip link show eth0')).toContain('link/ether 02:11:22:33:44:55');
  });

  it('the switch learns the new address from a real frame', async () => {
    // The point of the command: what the peer sees changes. Without a
    // frame this proves nothing, so one is sent.
    const { pc, sw } = lab();
    await pc.executeCommand('ip link set eth0 address 02:11:22:33:44:55');
    await pc.executeCommand('ip addr add 10.0.0.10/24 dev eth0');
    await pc.executeCommand('ping -c 1 10.0.0.99');
    const table = await sw.executeCommand('show mac address-table');
    expect(table.toLowerCase()).toContain('02:11:22:33:44:55');
  });

  it('a malformed address is refused, and the port keeps the old one', async () => {
    const { pc } = lab();
    const before = pc.getPort('eth0')!.getMAC().toString();
    expect(await pc.executeCommand('ip link set eth0 address zz:zz'))
      .toContain('is invalid lladdr');
    expect(pc.getPort('eth0')!.getMAC().toString()).toBe(before);
  });
});

describe('txqueuelen and promisc', () => {
  it('the queue length reaches ip link show', async () => {
    const { pc } = lab();
    expect(await linkLine(pc)).toContain('qlen 1000');
    expect(await pc.executeCommand('ip link set eth0 txqueuelen 5000')).toBe('');
    expect(await linkLine(pc)).toContain('qlen 5000');
  });

  it('promisc adds the flag, and off removes it', async () => {
    const { pc } = lab();
    expect(await linkLine(pc)).not.toContain('PROMISC');
    await pc.executeCommand('ip link set eth0 promisc on');
    expect(await linkLine(pc)).toContain('PROMISC');
    await pc.executeCommand('ip link set eth0 promisc off');
    expect(await linkLine(pc)).not.toContain('PROMISC');
  });

  it('a bad queue length is refused', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('ip link set eth0 txqueuelen abc'))
      .toContain('invalid numeric value');
  });
});

describe('an unknown keyword is not a success', () => {
  it('it gets iproute2 own refusal', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('ip link set eth0 nosuchkeyword'))
      .toContain('is a garbage');
  });

  it('what the parser already knew still works', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('ip link set eth0 mtu 9000')).toBe('');
    expect(pc.getPort('eth0')!.getMTU()).toBe(9000);
    expect(await pc.executeCommand('ip link set eth0 down')).toBe('');
    expect(await linkLine(pc)).not.toContain(',UP');
    expect(await pc.executeCommand('ip link set dev eth0 up')).toBe('');
    expect(await linkLine(pc)).toContain('UP');
  });
});
