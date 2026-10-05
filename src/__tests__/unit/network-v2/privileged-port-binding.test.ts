/*
 * Privileged ports: below net.ipv4.ip_unprivileged_port_start (1024 on
 * Ubuntu 22.04) a bind needs uid 0 or CAP_NET_BIND_SERVICE, on every
 * machine whose kernel is Linux. A LinuxPC runs as `user`, a LinuxServer
 * as root; Windows has no such rule.
 *
 * Measured before the change: `user` could `nc -l 80`, `nc -p 80`,
 * `ssh -L 80:…`, `ssh -R 80:…` as a non-root remote user, and
 * `traceroute --sport=80`; PortBindingPolicy existed and nothing read it,
 * and the sysctl key did not exist.
 *
 * Sources: Linux v5.15 include/net/ip.h (inet_port_requires_bind_service:
 * port < sysctl_ip_prot_sock), net/ipv4/af_inet.c (EACCES before the port
 * is looked up), net/ipv4/sysctl_net_ipv4.c (ipv4_privileged_ports and
 * ipv4_local_port_range refuse overlapping ranges with EINVAL);
 * netcat-openbsd netcat.c (`err(1, NULL)` after local_listen, `err(1,
 * "bind failed")` for -p); OpenSSH 8.9p1 channels.c
 * (channel_setup_fwd_listener_tcpip), ssh.c ("Could not request local
 * forwarding.", "Warning: remote port forwarding failed for listen port"),
 * serverloop.c (bind_permitted defers to the kernel under privsep, so the
 * remote user's uid decides); traceroute 2.1.0 (error("bind") after the
 * header for the per-probe UDP socket).
 *
 * DISCRIMINATION (git stash of src/network, src/terminal): 8 of the 10
 * cases fall before the change. The two that pass on both trees are
 * witnesses that nothing legitimate was taken away: `user` binding from
 * 1024 up and root binding port 80 (one case), and Windows binding port 80
 * without administrator rights.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await srv.executeCommand('systemctl start ssh');
  await srv.executeCommand('useradd -m alice');
  await srv.executeCommand("bash -c 'echo alice:secret | chpasswd'");
  return { pc, srv };
}

const ssh = (pc: LinuxPC, forward: string) =>
  pc.executeCommand(`ssh -o StrictHostKeyChecking=no -N ${forward} alice@10.0.0.2`, 'secret\n');

describe('nc — a listener or a source port below 1024 needs privilege', () => {
  it('user gets netcat\'s own errors, for TCP, UDP and a client source port', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -l 80')).toBe('nc: Permission denied');
    expect(await pc.executeCommand('nc -u -l 53')).toBe('nc: Permission denied');
    expect(await pc.executeCommand('nc -v -p 80 10.0.0.2 22')).toBe('nc: bind failed: Permission denied');
    expect(await pc.executeCommand('ss -tln')).not.toMatch(/:80\s/);
  });

  it('sudo lifts it, and the client source port reaches the wire', async () => {
    const { pc, srv } = await lab();
    expect(await pc.executeCommand('sudo nc -l 81')).toBe('');
    expect(await pc.executeCommand('ss -tln')).toMatch(/0\.0\.0\.0:81\s/);
    const pending = srv.executeCommand('tcpdump -c 1 -nn -i eth0 tcp dst port 22');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc.executeCommand('nc -z -p 5555 10.0.0.2 22');
    expect(await pending).toMatch(/IP 10\.0\.0\.1\.5555 > 10\.0\.0\.2\.22: Flags \[S\]/);
  });

  it('witness: from 1024 up user binds freely, and root binds port 80', async () => {
    const { pc, srv } = await lab();
    expect(await pc.executeCommand('nc -l 1024')).toBe('');
    expect(await pc.executeCommand('nc -l 8080')).toBe('');
    expect(await srv.executeCommand('nc -l 80')).toBe('');
  });
});

describe('sysctl — the boundary is net.ipv4.ip_unprivileged_port_start', () => {
  it('reads 1024, moves under sudo, and decides the next bind', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('sysctl net.ipv4.ip_unprivileged_port_start'))
      .toBe('net.ipv4.ip_unprivileged_port_start = 1024');
    expect(await pc.executeCommand('sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80'))
      .toBe('net.ipv4.ip_unprivileged_port_start = 80');
    expect(await pc.executeCommand('cat /proc/sys/net/ipv4/ip_unprivileged_port_start')).toBe('80');
    expect(await pc.executeCommand('nc -l 80')).toBe('');
    expect(await pc.executeCommand('nc -l 79')).toBe('nc: Permission denied');
  });

  it('refuses a boundary that would overlap the ephemeral range, in both directions', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('sudo sysctl -w net.ipv4.ip_unprivileged_port_start=40000'))
      .toBe('sysctl: setting key "net.ipv4.ip_unprivileged_port_start": Invalid argument');
    expect(await pc.executeCommand('sudo sysctl -w net.ipv4.ip_local_port_range="500 60999"'))
      .toBe('sysctl: setting key "net.ipv4.ip_local_port_range": Invalid argument');
    expect(await pc.executeCommand('sysctl net.ipv4.ip_local_port_range'))
      .toBe('net.ipv4.ip_local_port_range = 32768\t60999');
  });
});

describe('ssh — forwards bind on whichever machine owns them, as its user', () => {
  it('-L 80 as user fails with OpenSSH\'s three lines; -L 8022 opens', async () => {
    const { pc } = await lab();
    expect(await ssh(pc, '-L 80:10.0.0.2:22')).toBe(
      'bind [127.0.0.1]:80: Permission denied\n'
      + 'channel_setup_fwd_listener_tcpip: cannot listen to port: 80\n'
      + 'Could not request local forwarding.\n');
    expect(await ssh(pc, '-L 8022:10.0.0.2:22')).toBe('');
    expect(await pc.executeCommand('ss -tln')).toMatch(/127\.0\.0\.1:8022\s/);
  });

  it('-R 80 fails because alice is not root on the server; -R 8081 opens there', async () => {
    const { pc, srv } = await lab();
    expect(await ssh(pc, '-R 80:10.0.0.1:22')).toBe('Warning: remote port forwarding failed for listen port 80\n');
    expect(await srv.executeCommand('ss -tln')).not.toMatch(/127\.0\.0\.1:80\s/);
    expect(await ssh(pc, '-R 8081:10.0.0.1:22')).toBe('');
    expect(await srv.executeCommand('ss -tln')).toMatch(/127\.0\.0\.1:8081\s/);
  });
});

describe('the terminal ssh — same kernel, same OpenSSH lines', () => {
  it('-L 80 and -R 80 fail as user and alice, and nothing is made up on success', async () => {
    const { pc } = await lab();
    pc.powerOn();
    const session = new LinuxTerminalSession('t', pc);
    const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    session.setInput('ssh -o StrictHostKeyChecking=accept-new -L 80:10.0.0.2:22 -R 80:10.0.0.1:22 -L 8022:10.0.0.2:22 alice@10.0.0.2');
    session.handleKey(key('Enter'));
    await settle();
    session.setPasswordBuf('secret');
    session.handleKey(key('Enter'));
    await settle();
    const text = session.lines.map((l) => l.text).join('\n');
    expect(text).toContain('bind [127.0.0.1]:80: Permission denied\n'
      + 'channel_setup_fwd_listener_tcpip: cannot listen to port: 80\n'
      + 'Warning: remote port forwarding failed for listen port 80');
    expect(text).not.toContain('Could not request local forwarding.');
    expect(text).not.toContain('Forwarding TCP');
    expect(await pc.executeCommand('ss -tln')).toMatch(/:8022\s/);
  });
});

describe('traceroute — --sport binds the per-probe UDP socket', () => {
  it('below 1024 user fails after the header; sudo traces', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('traceroute -n -q 1 --sport=80 10.0.0.2'))
      .toBe('traceroute to 10.0.0.2 (10.0.0.2), 30 hops max, 60 byte packets\nbind: Permission denied');
    expect((await pc.executeCommand('sudo traceroute -n -q 1 --sport=80 10.0.0.2')).split('\n')[1])
      .toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/);
  });
});

describe('Windows has no privileged ports', () => {
  it('witness: a listener on 80 owned by a non-administrator uid is accepted', () => {
    const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
    expect(() => win.getTcpStack().listen(80, { onAccept: () => undefined, ownerUid: 1000 })).not.toThrow();
  });
});
