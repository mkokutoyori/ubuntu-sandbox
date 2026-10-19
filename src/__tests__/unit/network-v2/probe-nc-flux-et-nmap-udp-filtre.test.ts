/*
 * Probe — what `nc -l` receives reaches its stdout, what it is given on stdin
 * reaches the client, and `nmap -sU` reads the ICMP unreachable codes that
 * filter a port.
 *
 * Lab: PC (10.0.1.1) — SRV (10.0.1.2). SRV runs `nc -l` in the background with
 * its stdout redirected to a file, as a file transfer does.
 *
 * Before the change (git stash of src): nc -l accepted a connection and threw
 * its bytes away, `nc -l < file` never greeted the client, UDP datagrams were
 * dropped by `nc -u -l`, and nmap read every ICMP unreachable other than
 * port-unreachable as "open|filtered".
 * 6 of 10 cases fall: the four data-flow cases (TCP into a file, -k, the
 * stdin greeting, UDP into a file) and the two filtered UDP readings
 * (admin-prohibited with its reason, host-unreachable).
 *
 * The four that pass either way, and why:
 *  - the file exists and is empty before any client connects — WITNESS: the
 *    shell creates the redirection target at launch, before and after;
 *  - a UDP DROP stays open|filtered and a plain REJECT stays closed — WITNESS
 *    that the lab replies where it should, so the filtered reading measures
 *    the code and not a dead route;
 *  - hping3 --udp already names ICMP "Packet filtered" (previous lot) —
 *    NON-REGRESSION of the reader nmap now shares;
 *  - nmap -sS reads a TCP REJECT as filtered — WITNESS and documented
 *    behaviour (ICMP unreachable codes 0-3, 9, 10, 13 filter a SYN scan), so
 *    that reading is not a defect and stays as it is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab() {
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  new Cable('b').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  return { srv, pc, scan: (args: string) => pc.executeCommand(`sudo nmap ${args} 10.0.1.2`) };
}

function states(out: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of out.matchAll(/^(\d+)\/(tcp|udp)\s+(\S+)/gm)) found.set(`${m[2]}/${m[1]}`, m[3]);
  return found;
}

describe('probe — nc -l carries data, nmap -sU reads filtering ICMP', () => {
  it('WITNESS: the redirection target exists and is empty before any client connects', async () => {
    const { srv } = lab();
    await srv.executeCommand('nc -l -p 9300 > /tmp/in.txt &');
    expect(await srv.executeCommand('ls /tmp/in.txt')).toContain('/tmp/in.txt');
    expect(await srv.executeCommand('cat /tmp/in.txt')).toBe('');
  });

  it('nc -l > file receives what the client sends', async () => {
    const { srv, pc } = lab();
    await srv.executeCommand('nc -l -p 9300 > /tmp/in.txt &');
    await pc.executeCommand('echo hello | nc 10.0.1.2 9300');
    expect((await srv.executeCommand('cat /tmp/in.txt')).trim()).toBe('hello');
  });

  it('nc -l -k > file appends every connection', async () => {
    const { srv, pc } = lab();
    await srv.executeCommand('nc -l -k -p 9300 > /tmp/in.txt &');
    await pc.executeCommand('echo one | nc 10.0.1.2 9300');
    await pc.executeCommand('echo two | nc 10.0.1.2 9300');
    expect((await srv.executeCommand('cat /tmp/in.txt')).split('\n').filter(Boolean)).toEqual(['one', 'two']);
  });

  it('nc -l < file greets the client with the file', async () => {
    const { srv, pc } = lab();
    await srv.executeCommand('echo welcome > /tmp/banner');
    await srv.executeCommand('nc -l -p 9301 < /tmp/banner &');
    expect(await pc.executeCommand('nc 10.0.1.2 9301')).toContain('welcome');
  });

  it('nc -u -l > file receives a datagram', async () => {
    const { srv, pc } = lab();
    await srv.executeCommand('nc -u -l -p 9302 > /tmp/dgram.txt &');
    await pc.executeCommand('echo ping | nc -u -w1 10.0.1.2 9302');
    expect((await srv.executeCommand('cat /tmp/dgram.txt')).trim()).toBe('ping');
  });

  it('nmap -sU reads ICMP admin-prohibited as filtered, with its reason', async () => {
    const { srv, scan } = lab();
    await srv.executeCommand('iptables -A INPUT -p udp --dport 9400 -j REJECT --reject-with icmp-admin-prohibited');
    const out = await scan('-sU -p 9400 --reason');
    expect(states(out).get('udp/9400')).toBe('filtered');
    expect(out).toMatch(/admin-prohibited/);
  });

  it('nmap -sU reads ICMP host-unreachable as filtered', async () => {
    const { srv, scan } = lab();
    await srv.executeCommand('iptables -A INPUT -p udp --dport 9400 -j REJECT --reject-with icmp-host-unreachable');
    expect(states(await scan('-sU -p 9400')).get('udp/9400')).toBe('filtered');
  });

  it('WITNESS: a UDP DROP stays open|filtered and a plain REJECT stays closed', async () => {
    const { srv, scan } = lab();
    await srv.executeCommand('iptables -A INPUT -p udp --dport 9401 -j DROP');
    await srv.executeCommand('iptables -A INPUT -p udp --dport 9402 -j REJECT');
    const found = states(await scan('-sU -p 9401,9402'));
    expect(found.get('udp/9401')).toBe('open|filtered');
    expect(found.get('udp/9402')).toBe('closed');
  });

  it('hping3 --udp names the same filtering ICMP nmap -sU reads', async () => {
    const { srv, pc } = lab();
    await srv.executeCommand('iptables -A INPUT -p udp --dport 9400 -j REJECT --reject-with icmp-admin-prohibited');
    expect(await pc.executeCommand('sudo hping3 --udp -p 9400 -c 1 10.0.1.2')).toMatch(/ICMP Packet filtered from ip=10\.0\.1\.2/);
  });

  it('WITNESS: nmap -sS keeps reading a TCP REJECT as filtered (nmap docs: ICMP unreachable codes 0-3, 9, 10, 13)', async () => {
    const { srv, scan } = lab();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 9000 -j REJECT');
    expect(states(await scan('-sS -p 9000')).get('tcp/9000')).toBe('filtered');
  });
});
