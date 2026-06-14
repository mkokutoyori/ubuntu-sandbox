/**
 * `ping6` / `ping -6` — the terminal command must drive the REAL
 * ICMPv6 path (`EndHost.executePing6Sequence`: NDP + route
 * resolution), which existed but was orphaned: `ping6` sat in the
 * known-command list with no handler ("command not found") and no
 * caller ever reached the engine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

describe('ping6 command (real ICMPv6 path)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  function v6Pair() {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 0, 0);
    new Cable('c1').connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
    pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
    pc2.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
    return { pc1, pc2 };
  }

  it('ping6 reaches an on-link IPv6 neighbour through real NDP', async () => {
    const { pc1 } = v6Pair();
    const out = await pc1.executeCommand('ping6 -c 2 2001:db8::2');
    expect(out).toContain('PING 2001:db8::2(2001:db8::2) 56 data bytes');
    expect(out).toContain('icmp_seq=1');
    expect(out).toContain('2 packets transmitted, 2 received, 0% packet loss');
  });

  it('ping -6 and a literal IPv6 target use the same v6 path', async () => {
    const { pc1 } = v6Pair();
    const viaFlag = await pc1.executeCommand('ping -6 -c 1 2001:db8::2');
    const viaLiteral = await pc1.executeCommand('ping -c 1 2001:db8::2');
    for (const out of [viaFlag, viaLiteral]) {
      expect(out).toContain('56 data bytes');
      expect(out).toContain('1 packets transmitted, 1 received');
    }
  });

  it('reports unreachable honestly when no route exists', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
    const out = await pc1.executeCommand('ping6 -c 1 2001:db8:ffff::9');
    expect(out).toContain('connect: Network is unreachable');
  });

  it('rejects an unresolvable name like iputils', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const out = await pc1.executeCommand('ping6 -c 1 not-a-host');
    expect(out).toBe('ping6: not-a-host: Name or service not known');
  });

  it('pings its own address without touching the wire', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
    const out = await pc1.executeCommand('ping6 -c 1 2001:db8::1');
    expect(out).toContain('1 packets transmitted, 1 received');
  });
});
