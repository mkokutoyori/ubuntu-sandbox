/*
 * `clear ip dhcp binding`: the command was accepted with any tail and did
 * nothing (no handler existed), so a stale automatic binding could never be
 * removed from the CLI and `show ip dhcp binding` kept listing it.
 *
 * Measured before the change: 4 of the 6 cases fall. `*` removed manual
 * bindings too (IOS deletes automatic ones only), an address that holds no
 * binding was accepted silently, `zorglub` was accepted, and `clear ip dhcp
 * conflict <address>` wiped every conflict whatever the address. The two
 * that pass either way: the witness (the seeded bindings are real entries of
 * the server `show ip dhcp binding` reads, proving the lab) and the removal
 * of one automatic binding by address (non-regression). The automatic-only
 * rule is from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };
interface Server {
  importBinding(b: Record<string, unknown>): void;
  getBindings(): Map<string, { type: string }>;
}

async function lab(): Promise<{ cli: Cli; server: Server }> {
  const router = new CiscoRouter('R1', 0, 0) as unknown as Cli & {
    powerOn(): void; _getDHCPServerInternal(): Server;
  };
  router.powerOn();
  for (const l of ['enable', 'configure terminal', 'ip dhcp pool LAN', 'end']) {
    await router.executeCommand(l);
  }
  const server = router._getDHCPServerInternal();
  const now = Date.now();
  const binding = (ip: string, type: string) => ({
    ipAddress: ip, clientId: `01aa.bbcc.dd${ip.split('.')[3].padStart(2, '0')}`, leaseStart: now,
    leaseExpiration: now + 3_600_000, poolName: 'LAN', type,
  });
  server.importBinding(binding('10.0.0.11', 'automatic'));
  server.importBinding(binding('10.0.0.12', 'automatic'));
  server.importBinding(binding('10.0.0.13', 'manual'));
  return { cli: router, server };
}

describe('clear ip dhcp binding', () => {
  it('witness: the seeded bindings are held by the server', async () => {
    const { server } = await lab();
    expect([...server.getBindings().keys()].sort()).toEqual(['10.0.0.11', '10.0.0.12', '10.0.0.13']);
  });

  it('removes one automatic binding by address', async () => {
    const { cli, server } = await lab();
    expect(await cli.executeCommand('clear ip dhcp binding 10.0.0.11')).toBe('');
    expect([...server.getBindings().keys()]).not.toContain('10.0.0.11');
    expect([...server.getBindings().keys()]).toContain('10.0.0.12');
  });

  it('removes every automatic binding with *, and keeps the manual one', async () => {
    const { cli, server } = await lab();
    expect(await cli.executeCommand('clear ip dhcp binding *')).toBe('');
    expect([...server.getBindings().keys()]).toEqual(['10.0.0.13']);
  });

  it('says so when no binding matches', async () => {
    const { cli } = await lab();
    expect(await cli.executeCommand('clear ip dhcp binding 10.9.9.9')).toMatch(/No matching binding/);
  });

  it('refuses a word that is neither an address nor *', async () => {
    const { cli, server } = await lab();
    expect(await cli.executeCommand('clear ip dhcp binding zorglub')).toMatch(/Invalid input detected/);
    expect(server.getBindings().size).toBe(3);
  });

  it('clears one conflict by address, keeps the other, and refuses bad targets', async () => {
    const { cli, server } = await lab();
    const dhcp = server as unknown as { addConflict(ip: string, how: string): void; getConflicts(): { ipAddress: string }[] };
    dhcp.addConflict('10.0.0.21', 'ping');
    dhcp.addConflict('10.0.0.22', 'ping');
    expect(await cli.executeCommand('clear ip dhcp conflict 10.0.0.21')).toBe('');
    expect(dhcp.getConflicts().map(c => c.ipAddress)).toEqual(['10.0.0.22']);
    expect(await cli.executeCommand('clear ip dhcp conflict 10.9.9.9')).toMatch(/No matching conflict/);
    expect(await cli.executeCommand('clear ip dhcp conflict zorglub')).toMatch(/Invalid input detected/);
    expect(await cli.executeCommand('clear ip dhcp conflict *')).toBe('');
    expect(dhcp.getConflicts()).toEqual([]);
  });
});
