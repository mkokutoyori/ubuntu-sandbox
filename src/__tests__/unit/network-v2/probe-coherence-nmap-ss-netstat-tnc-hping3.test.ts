/*
 * Probe — one listening socket, five readers: `ss`, `netstat`, `nmap`,
 * `hping3` and `Test-NetConnection` must give the same verdict on the same
 * port of the same machine at the same instant (rule 3).
 *
 * Lab: WIN (10.0.0.1) — SRV (10.0.0.2 / 10.0.1.2) — PC (10.0.1.1). SRV
 * listens on tcp 22 (sshd), tcp 9000 and udp 9001 (nc), keeps tcp 53 on
 * 127.0.0.53 only, and PC / WIN scan it over the cables.
 *
 * Measured before the change (git stash of src/network and src/powershell):
 * 5 of the 16 cases fall.
 *  - hping3 --udp at an unbound port prints nothing while `nmap -sU` reads
 *    the same ICMP port-unreachable as "closed" (1 case).
 *  - Test-NetConnection -Port on a refused or unreachable target prints
 *    neither the WARNING lines nor PingSucceeded, which the NetTCPIP module
 *    emits when the TCP test fails (2 cases).
 *  - `nc -l` without -k keeps listening after its first connection, so ss
 *    and nmap still show a port the real process closed on exit (2 cases).
 *
 * The 12 that pass either way, and why:
 *  - ss/netstat set equality, nmap vs ss, the open / closed / DROP / REJECT
 *    verdicts across nmap, hping3 and Test-NetConnection, and the UDP
 *    open|filtered / closed split — WITNESSES: the lab replies where it
 *    should, so the failing cases measure a reader and not a dead route.
 *  - `nc -l -k` stays up — NON-REGRESSION for the one-shot change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function lab() {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  new Cable('a').connect(win.getPorts()[0], srv.getPorts()[0]);
  new Cable('b').connect(pc.getPorts()[0], srv.getPorts()[1]);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[1].configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  pc.getPorts()[0].configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  win.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(win).subShell;
  await srv.executeCommand('nc -l -p 9000 -k &');
  await srv.executeCommand('nc -l -u -p 9001 &');
  return {
    win, srv, pc,
    ps: async (line: string) => (await sub.processLine(line)).output.join('\n'),
    sudo: (cmd: string) => pc.executeCommand(`sudo ${cmd}`),
  };
}

function nmapStates(out: string): Map<string, string> {
  const states = new Map<string, string>();
  for (const m of out.matchAll(/^(\d+)\/(tcp|udp)\s+(\S+)/gm)) states.set(`${m[2]}/${m[1]}`, m[3]);
  return states;
}

function listening(out: string, withProto: boolean): Set<string> {
  const keys = new Set<string>();
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const proto = cols[0].replace(/6$/, '');
    if (proto !== 'tcp' && proto !== 'udp') {
      if (cols[0] !== 'LISTEN' && cols[0] !== 'UNCONN') continue;
    }
    const local = cols.find((c) => /:\d+$/.test(c));
    if (!local) continue;
    const port = local.split(':').pop()!;
    const address = local.slice(0, local.length - port.length - 1).replace(/%.*$/, '').replace(/^:+$|^\[::\]$/, '::');
    keys.add(withProto ? `${proto}/${address}:${port}` : `${address}:${port}`);
  }
  return keys;
}

describe('probe — ss, netstat, nmap, hping3 and Test-NetConnection agree', () => {
  it('WITNESS: ss -ltnu and netstat -tuln list the same sockets', async () => {
    const { srv } = await lab();
    const fromSs = [...listening(await srv.executeCommand('ss -ltnu'), false)].sort();
    const fromNetstat = [...listening(await srv.executeCommand('netstat -tuln'), false)].sort();
    expect(fromSs.length).toBeGreaterThan(5);
    expect(fromNetstat).toEqual(fromSs);
  });

  it('WITNESS: nmap -sT opens exactly the ports ss lists on a reachable address', async () => {
    const { srv, sudo } = await lab();
    const ss = await srv.executeCommand('ss -ltn');
    const bound = new Set<string>();
    for (const key of listening(ss, false)) {
      const [address, port] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
      if (address === '0.0.0.0' || address === '[::]' || address === '*') bound.add(port);
    }
    const out = await sudo('nmap -sT -p 22,53,1521,1812,9000,9999 10.0.1.2');
    const states = nmapStates(out);
    for (const port of ['22', '1521', '1812', '9000']) {
      expect(bound.has(port), `ss ${port}`).toBe(true);
      expect(states.get(`tcp/${port}`), `nmap ${port}`).toBe('open');
    }
    expect(bound.has('53')).toBe(false);
    expect(states.get('tcp/53')).toBe('closed');
    expect(states.get('tcp/9999')).toBe('closed');
  });

  it('WITNESS: an open port is open for nmap, hping3 and Test-NetConnection alike', async () => {
    const { sudo, ps } = await lab();
    expect(nmapStates(await sudo('nmap -sS -p 9000 10.0.1.2')).get('tcp/9000')).toBe('open');
    expect(await sudo('hping3 -S -p 9000 -c 1 10.0.1.2')).toMatch(/flags=SA/);
    expect(await ps('Test-NetConnection 10.0.0.2 -Port 9000 -InformationLevel Quiet')).toBe('True');
  });

  it('WITNESS: a closed port is closed for nmap, hping3 and Test-NetConnection alike', async () => {
    const { sudo, ps } = await lab();
    expect(nmapStates(await sudo('nmap -sS -p 9999 10.0.1.2')).get('tcp/9999')).toBe('closed');
    expect(await sudo('hping3 -S -p 9999 -c 1 10.0.1.2')).toMatch(/flags=RA/);
    expect(await ps('Test-NetConnection 10.0.0.2 -Port 9999 -InformationLevel Quiet')).toBe('False');
  });

  it('WITNESS: a DROP rule reads filtered / 100% loss / False', async () => {
    const { srv, sudo, ps } = await lab();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 9000 -j DROP');
    expect(nmapStates(await sudo('nmap -sS -p 9000 10.0.1.2')).get('tcp/9000')).toBe('filtered');
    expect(await sudo('hping3 -S -p 9000 -c 1 10.0.1.2')).toMatch(/100% packet loss/);
    expect(await ps('Test-NetConnection 10.0.0.2 -Port 9000 -InformationLevel Quiet')).toBe('False');
  });

  it('WITNESS: a REJECT rule is "closed" to a connect scan, "filtered" to a SYN scan, and an ICMP line to hping3', async () => {
    const { srv, sudo } = await lab();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 9000 -j REJECT');
    expect(nmapStates(await sudo('nmap -sT -p 9000 10.0.1.2')).get('tcp/9000')).toBe('closed');
    expect(nmapStates(await sudo('nmap -sS -p 9000 10.0.1.2')).get('tcp/9000')).toBe('filtered');
    expect(await sudo('hping3 -S -p 9000 -c 1 10.0.1.2')).toMatch(/ICMP Port Unreachable from ip=10\.0\.1\.2/);
  });

  it('WITNESS: nmap -sU splits a bound port (open|filtered) from an unbound one (closed)', async () => {
    const { sudo } = await lab();
    const states = nmapStates(await sudo('nmap -sU -p 9001,9998 10.0.1.2'));
    expect(states.get('udp/9001')).toBe('open|filtered');
    expect(states.get('udp/9998')).toBe('closed');
  });

  it('hping3 --udp at an unbound port reports the ICMP port-unreachable nmap -sU reads as closed', async () => {
    const { sudo } = await lab();
    expect(nmapStates(await sudo('nmap -sU -p 9998 10.0.1.2')).get('udp/9998')).toBe('closed');
    const out = await sudo('hping3 --udp -p 9998 -c 1 10.0.1.2');
    expect(out).toMatch(/ICMP Port Unreachable from ip=10\.0\.1\.2/);
  });

  it('WITNESS: hping3 --udp at a bound port prints no ICMP line', async () => {
    const { sudo } = await lab();
    const out = await sudo('hping3 --udp -p 9001 -c 1 10.0.1.2');
    expect(out).toMatch(/1 packets transmitted/);
    expect(out).not.toMatch(/ICMP/);
  });

  it('Test-NetConnection -Port on a refused port warns and carries PingSucceeded before TcpTestSucceeded', async () => {
    const { ps } = await lab();
    const out = await ps('Test-NetConnection 10.0.0.2 -Port 9999');
    expect(out).toMatch(/WARNING: TCP connect to \(10\.0\.0\.2 : 9999\) failed/);
    const lines = out.split('\n').map((l) => l.trim());
    const ping = lines.findIndex((l) => l.startsWith('PingSucceeded'));
    const tcp = lines.findIndex((l) => l.startsWith('TcpTestSucceeded'));
    expect(ping).toBeGreaterThan(-1);
    expect(lines[ping]).toMatch(/: True$/);
    expect(tcp).toBeGreaterThan(ping);
    expect(lines[tcp]).toMatch(/: False$/);
  });

  it('Test-NetConnection -Port on an unreachable host warns twice and reports PingSucceeded False', async () => {
    const { ps } = await lab();
    const out = await ps('Test-NetConnection 10.0.0.77 -Port 22');
    expect(out).toMatch(/WARNING: Ping to 10\.0\.0\.77 failed with status: /);
    expect(out).toMatch(/WARNING: TCP connect to \(10\.0\.0\.77 : 22\) failed/);
    expect(out).toMatch(/PingSucceeded\s+: False/);
  });

  it('WITNESS: Test-NetConnection -Port on an open port stays warning-free and ping-free', async () => {
    const { ps } = await lab();
    const out = await ps('Test-NetConnection 10.0.0.2 -Port 22');
    expect(out).not.toMatch(/WARNING/);
    expect(out).not.toMatch(/PingSucceeded/);
    expect(out).toMatch(/TcpTestSucceeded\s+: True/);
  });

  it('WITNESS: nmap from SRV opens exactly the TCP ports netstat -an lists as LISTENING on WIN', async () => {
    const { srv, win } = await lab();
    const out = await srv.executeCommand('sudo nmap -sT -p 22,135,139,445,3389,5985 10.0.0.1');
    const open = [...nmapStates(out)].filter(([, s]) => s === 'open').map(([k]) => k.split('/')[1]).sort();
    const netstat = await win.executeCommand('netstat -an');
    const listeningV4 = [...netstat.matchAll(/^\s*TCP\s+0\.0\.0\.0:(\d+)\s.*LISTENING/gm)].map((m) => m[1]);
    const expected = ['22', '135', '139', '445', '3389', '5985'].filter((p) => listeningV4.includes(p)).sort();
    expect(expected.length).toBeGreaterThan(2);
    expect(open).toEqual(expected);
  });

  it('nc -l without -k closes its port after the first connection, as the real process exits', async () => {
    const { srv, pc, sudo } = await lab();
    await srv.executeCommand('nc -l -p 9200 &');
    expect(nmapStates(await sudo('nmap -sT -p 9200 10.0.1.2')).get('tcp/9200')).toBe('open');
    await pc.executeCommand('nc -zv 10.0.1.2 9200');
    expect(nmapStates(await sudo('nmap -sT -p 9200 10.0.1.2')).get('tcp/9200')).toBe('closed');
  });

  it('nc -l without -k leaves ss and the process table once it has served its connection', async () => {
    const { srv, pc } = await lab();
    await srv.executeCommand('nc -l -p 9200 &');
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:9200\s/);
    await pc.executeCommand('nc -zv 10.0.1.2 9200');
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:9200\s/);
  });

  it('WITNESS: nc -l -k keeps serving after a connection', async () => {
    const { pc, sudo } = await lab();
    await pc.executeCommand('nc -zv 10.0.1.2 9000');
    expect(nmapStates(await sudo('nmap -sT -p 9000 10.0.1.2')).get('tcp/9000')).toBe('open');
  });
});
