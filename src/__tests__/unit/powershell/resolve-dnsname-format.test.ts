/**
 * Resolve-DnsName output format. Migrated to PowerShellSubShell.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN-DNS');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('Resolve-DnsName — table output', () => {
  it('forward lookup localhost returns the table header', async () => {
    const out = await run(createShell(), 'Resolve-DnsName localhost');
    expect(out).toContain('Name');
    expect(out).toContain('Type');
    expect(out).toContain('TTL');
    expect(out).toContain('Section');
    expect(out).toContain('IPAddress');
    expect(out).toContain('127.0.0.1');
  });

  it('forward lookup example.com renders as the same table format', async () => {
    const out = await run(createShell(), 'Resolve-DnsName example.com');
    expect(out).toContain('Name');
    expect(out).toContain('IPAddress');
    expect(out).toContain('example.com');
    expect(out).not.toMatch(/^Section: /m);
    expect(out).not.toMatch(/^IPAddress: /m);
  });

  it('reverse lookup 127.0.0.1 returns a PTR record, not a forward A', async () => {
    const out = await run(createShell(), 'Resolve-DnsName "127.0.0.1"');
    expect(out).toContain('PTR');
    expect(out).toContain('1.0.0.127.in-addr.arpa');
    expect(out).toContain('localhost');
  });

  it('reverse lookup arbitrary IP also returns PTR format', async () => {
    const out = await run(createShell(), 'Resolve-DnsName "192.168.1.50"');
    expect(out).toContain('PTR');
    expect(out).toContain('50.1.168.192.in-addr.arpa');
  });
});
