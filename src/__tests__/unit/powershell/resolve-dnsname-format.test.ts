/**
 * Resolve-DnsName output format.
 *
 * Bugs from debug-output/ps-network-server_results_debug.txt:
 *  - `Resolve-DnsName 127.0.0.1` returned a forward `A` record for
 *    "localhost" instead of a reverse PTR.
 *  - `Resolve-DnsName example.com` rendered as a half-formed list
 *    block where some keys had no space before the colon
 *    (`Section: Answer`, `IPAddress: 192.168.1.1`) while others did.
 *    Should be a consistent table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPS(): PowerShellExecutor {
  const pc = new WindowsPC('windows-pc', 'WIN-DNS');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('Resolve-DnsName — table output', () => {
  it('forward lookup localhost returns the table header', async () => {
    const ps = createPS();
    const out = await ps.execute('Resolve-DnsName localhost');
    expect(out).toContain('Name');
    expect(out).toContain('Type');
    expect(out).toContain('TTL');
    expect(out).toContain('Section');
    expect(out).toContain('IPAddress');
    expect(out).toContain('127.0.0.1');
  });

  it('forward lookup example.com renders as the same table format', async () => {
    const ps = createPS();
    const out = await ps.execute('Resolve-DnsName example.com');
    expect(out).toContain('Name');
    expect(out).toContain('IPAddress');
    expect(out).toContain('example.com');
    // No malformed list-style lines like "Section: Answer".
    expect(out).not.toMatch(/^Section: /m);
    expect(out).not.toMatch(/^IPAddress: /m);
  });

  it('reverse lookup 127.0.0.1 returns a PTR record, not a forward A', async () => {
    const ps = createPS();
    const out = await ps.execute('Resolve-DnsName 127.0.0.1');
    expect(out).toContain('PTR');
    expect(out).toContain('1.0.0.127.in-addr.arpa');
    expect(out).toContain('localhost');
  });

  it('reverse lookup arbitrary IP also returns PTR format', async () => {
    const ps = createPS();
    const out = await ps.execute('Resolve-DnsName 192.168.1.50');
    expect(out).toContain('PTR');
    expect(out).toContain('50.1.168.192.in-addr.arpa');
  });
});
