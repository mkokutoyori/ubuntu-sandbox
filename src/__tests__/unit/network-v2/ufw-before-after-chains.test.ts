// ufw-before-*/ufw-after-* real chains — PRD-Iptables-UFW.md §2.1
// objectif F.18. Previously these files existed in the VFS (readable via
// `cat`) but had no filtering effect — packets went straight from
// INPUT/OUTPUT/FORWARD to ufw-user-*.

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

function ipt(srv: LinuxServer) {
  return (srv as unknown as {
    executor: { iptables: { filterPacket: (p: unknown) => string } };
  }).executor.iptables;
}

describe('ufw-before-input allows loopback and conntrack ESTABLISHED before ufw-user-input', () => {
  it('accepts loopback traffic even with default deny incoming and no explicit rule', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('ufw default deny incoming');
    await srv.executeCommand('ufw enable');

    const verdict = ipt(srv).filterPacket({
      direction: 'in', protocol: 6, srcIP: '127.0.0.1', dstIP: '127.0.0.1',
      srcPort: 1234, dstPort: 80, iface: 'lo',
    });
    expect(verdict).toBe('accept');
  });

  // Real ufw's before.rules also allowlists several ICMP types
  // unconditionally. Not injected here: it would let ping through
  // regardless of ufw's own rules, contradicting the existing ping-block
  // suite (linux-ufw.test.ts G8-16) where ICMP is fully subject to ufw
  // allow/deny like any other traffic.
  it('ICMP is still subject to the default deny policy (not auto-allowed)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV2');
    await srv.executeCommand('ufw default deny incoming');
    await srv.executeCommand('ufw enable');

    const verdict = ipt(srv).filterPacket({
      direction: 'in', protocol: 1, srcIP: '10.0.0.1', dstIP: '10.0.0.2',
      srcPort: 0, dstPort: 0, iface: 'eth0',
    });
    expect(verdict).toBe('drop');
  });

  it('still applies the default deny policy for a non-loopback, non-ICMP, non-conntrack packet', async () => {
    const srv = new LinuxServer('linux-server', 'SRV3');
    await srv.executeCommand('ufw default deny incoming');
    await srv.executeCommand('ufw enable');

    const verdict = ipt(srv).filterPacket({
      direction: 'in', protocol: 6, srcIP: '10.0.0.1', dstIP: '10.0.0.2',
      srcPort: 1234, dstPort: 12345, iface: 'eth0',
    });
    expect(verdict).toBe('drop');
  });

  it('an explicit ufw allow rule still takes effect (ufw-user-input evaluated after ufw-before-input)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV4');
    await srv.executeCommand('ufw default deny incoming');
    await srv.executeCommand('ufw allow 22/tcp');
    await srv.executeCommand('ufw enable');

    const verdict = ipt(srv).filterPacket({
      direction: 'in', protocol: 6, srcIP: '10.0.0.1', dstIP: '10.0.0.2',
      srcPort: 1234, dstPort: 22, iface: 'eth0',
    });
    expect(verdict).toBe('accept');
  });

  it('ufw disable tears down the before-/after- chains along with ufw-user-*', async () => {
    const srv = new LinuxServer('linux-server', 'SRV5');
    await srv.executeCommand('ufw enable');
    await srv.executeCommand('ufw disable');

    const out = await srv.executeCommand('iptables -L ufw-before-input');
    expect(out).toContain('No chain');
  });
});
