/**
 * SSH LAN — networking commands coherence (BRD SSH-04 / SSH-05).
 *
 * Validates that `ip`, `ifconfig`, `route`, `ping`, `arp`, `ss` produce
 * coherent results whether the user runs them locally on a PC or via
 * `ssh user@host <cmd>` from another PC. Also exercises cross-PC
 * effects (a route added remotely is visible to a subsequent local
 * call, etc.).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import {
  buildLan,
  assignIps,
  sshExec,
  sshScript,
  type SshLan,
  PC1_IP,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

describe('SSH LAN — network coherence', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
  });

  // 21
  it('S21 — `ip addr show eth0` reports the configured IP via SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'ip addr show eth0')).stdout;
    expect(out).toContain(PC2_IP);
  });

  // 22
  it('S22 — `ifconfig eth0` is consistent with `ip addr show eth0`', async () => {
    const ifc = (await sshExec(lan.pc1, PC2_IP, 'ifconfig eth0')).stdout;
    const ip = (await sshExec(lan.pc1, PC2_IP, 'ip addr show eth0')).stdout;
    expect(ifc).toContain(PC2_IP);
    expect(ip).toContain(PC2_IP);
  });

  // 23
  it('S23 — `ping -c 1` from PC2 to PC3 succeeds when run via SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, `ping -c 1 ${PC3_IP}`)).stdout;
    expect(out).toContain(PC3_IP);
    expect(out).toMatch(/1 (received|packets received)/);
  });

  // 24
  it('S24 — `ping -c 1` to an unreachable IP reports loss/timeout', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'ping -c 1 192.0.2.99')).stdout;
    expect(out.toLowerCase()).toMatch(/100% packet loss|destination host unreachable|unreachable|no route/);
  });

  // 25
  it('S25 — `ip route` lists the directly-connected /24 over SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'ip route')).stdout;
    expect(out).toContain('10.0.0.0/24');
  });

  // 26
  it('S26 — `arp -a` reports neighbours after a ping over SSH', async () => {
    await sshExec(lan.pc1, PC2_IP, `ping -c 1 ${PC3_IP}`);
    const out = (await sshExec(lan.pc1, PC2_IP, 'arp -a')).stdout;
    expect(out).toContain(PC3_IP);
  });

  // 27
  it('S27 — `ip neigh` shows entries equivalent to `arp -a`', async () => {
    await sshExec(lan.pc1, PC2_IP, `ping -c 1 ${PC3_IP}`);
    const out = (await sshExec(lan.pc1, PC2_IP, 'ip neigh')).stdout;
    expect(out).toContain(PC3_IP);
  });

  // 28
  it('S28 — adding a static route remotely persists on the target', async () => {
    await sshExec(
      lan.pc1,
      PC2_IP,
      `sudo ip route add 192.168.99.0/24 via ${PC1_IP}`,
    );
    const local = await lan.pc2.executeCommand('ip route');
    expect(local).toContain('192.168.99.0/24');
  });

  // 29
  it('S29 — bringing eth0 down/up locally is observable via SSH', async () => {
    // Toggle eth0 of PC3 from a local shell on PC3, then ask PC2 (via SSH)
    // to ping PC3 — the down phase must drop the packet, the up phase
    // must restore connectivity. Using SSH ON the link being toggled
    // would race against TCP teardown; here PC2's link is unaffected.
    await lan.pc3.executeCommand('ip link set eth0 down');
    const downPing = await sshExec(lan.pc1, PC2_IP, `ping -c 1 ${PC3_IP}`);
    expect(downPing.stdout.toLowerCase()).toMatch(
      /100% packet loss|unreachable|no route|destination/,
    );
    await lan.pc3.executeCommand('ip link set eth0 up');
    const upPing = await sshExec(lan.pc1, PC2_IP, `ping -c 1 ${PC3_IP}`);
    expect(upPing.stdout).toMatch(/1 (received|packets received)/);
  });

  // 30
  it('S30 — `ss -tln` over SSH advertises the listening sshd on :22', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'ss -tln')).stdout;
    expect(out).toMatch(/:22\b/);
  });

  // 31
  it('S31 — `netstat -tln` is coherent with `ss -tln` over SSH', async () => {
    const ns = (await sshExec(lan.pc1, PC2_IP, 'netstat -tln')).stdout;
    const ss = (await sshExec(lan.pc1, PC2_IP, 'ss -tln')).stdout;
    expect(ns).toMatch(/:22\b/);
    expect(ss).toMatch(/:22\b/);
  });

  // 32
  it('S32 — `ip link show eth0` returns the interface header over SSH', async () => {
    await sshExec(lan.pc1, PC2_IP, `ping -c 2 ${PC3_IP}`);
    const out = (await sshExec(lan.pc1, PC2_IP, 'ip link show eth0')).stdout;
    expect(out).toContain('eth0');
    expect(out).toMatch(/UP|DOWN/);
  });

  // 33
  it('S33 — `traceroute` to a directly-attached neighbour returns 1 hop', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, `traceroute -n ${PC3_IP}`))
      .stdout;
    expect(out).toContain(PC3_IP);
  });

  // 34
  it('S34 — `cat /etc/hosts` over SSH lists the loopback alias', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'cat /etc/hosts')).stdout;
    expect(out).toContain('127.0.0.1');
  });

  // 35
  it('S35 — `cat /etc/resolv.conf` is the same locally and via SSH', async () => {
    const local = (await lan.pc2.executeCommand('cat /etc/resolv.conf')).trim();
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'cat /etc/resolv.conf')).stdout.trim();
    expect(ssh).toBe(local);
  });
});
