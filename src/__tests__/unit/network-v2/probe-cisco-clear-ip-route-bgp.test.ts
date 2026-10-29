/*
 * `clear ip route <target>` and `clear ip bgp <target>`.
 *
 * Measured before the change: 5 of the 9 cases fall. `clear ip route
 * 10.9.0.0` wiped EVERY dynamic route (the target was never read) and an
 * explicit static target was accepted silently, an absent network was
 * accepted, `clear ip route zorglub` was accepted, and `clear ip bgp zorglub`
 * or with no target was accepted. The four that pass either way: the lab
 * witness (the routes are really in the table), `clear ip route *`, `clear ip
 * bgp *`, and the documented target kinds being accepted. `clear ip bgp`
 * now resets matching peers through BGPEngine.resetPeers (hard clear); the
 * soft/in/out forms are accepted without effect because route refresh is not
 * modelled. Target grammar is from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { IPAddress, SubnetMask } from '@/network/core/types';

type Cli = { executeCommand(line: string): Promise<string> };
interface Table { push(r: unknown): void; filter(f: (r: { network: IPAddress }) => boolean): { network: IPAddress }[] }

async function lab(): Promise<{ cli: Cli; networks: () => string[] }> {
  const router = new CiscoRouter('R1', 0, 0) as unknown as Cli & {
    powerOn(): void; routingTable: Table;
  };
  router.powerOn();
  await router.executeCommand('enable');
  const route = (net: string, type: string) => ({
    network: new IPAddress(net), mask: new SubnetMask('255.255.0.0'), nextHop: new IPAddress('10.0.0.2'),
    iface: 'GigabitEthernet0/0', type, metric: 10,
  });
  router.routingTable.push(route('10.9.0.0', 'ospf'));
  router.routingTable.push(route('10.8.0.0', 'ospf'));
  router.routingTable.push(route('10.7.0.0', 'static'));
  return {
    cli: router,
    networks: () => router.routingTable.filter(() => true).map(r => r.network.toString()).sort(),
  };
}

describe('clear ip route', () => {
  it('witness: the three routes are in the table', async () => {
    expect((await lab()).networks()).toEqual(expect.arrayContaining(['10.7.0.0', '10.8.0.0', '10.9.0.0']));
  });

  it('removes only the named dynamic route', async () => {
    const { cli, networks } = await lab();
    expect(await cli.executeCommand('clear ip route 10.9.0.0')).toBe('');
    expect(networks()).not.toContain('10.9.0.0');
    expect(networks()).toContain('10.8.0.0');
  });

  it('removes every dynamic route with *, and keeps the static one', async () => {
    const { cli, networks } = await lab();
    expect(await cli.executeCommand('clear ip route *')).toBe('');
    expect(networks()).not.toContain('10.8.0.0');
    expect(networks()).not.toContain('10.9.0.0');
    expect(networks()).toContain('10.7.0.0');
  });

  it('does not touch a static route named explicitly', async () => {
    const { cli, networks } = await lab();
    expect(await cli.executeCommand('clear ip route 10.7.0.0')).toMatch(/Network not in table/);
    expect(networks()).toContain('10.7.0.0');
  });

  it('says so for a network that is not in the table', async () => {
    expect(await (await lab()).cli.executeCommand('clear ip route 10.99.0.0')).toMatch(/Network not in table/);
  });

  it('refuses a word that is neither an address nor *', async () => {
    const { cli, networks } = await lab();
    expect(await cli.executeCommand('clear ip route zorglub')).toMatch(/Invalid input detected/);
    expect(networks()).toContain('10.9.0.0');
  });
});

describe('clear ip bgp', () => {
  it('witness: * is accepted', async () => {
    expect(await (await lab()).cli.executeCommand('clear ip bgp *')).not.toMatch(/Invalid input|Incomplete/);
  });

  it('refuses an unknown target and a missing one', async () => {
    const { cli } = await lab();
    expect(await cli.executeCommand('clear ip bgp zorglub')).toMatch(/Invalid input detected/);
    expect(await cli.executeCommand('clear ip bgp')).toMatch(/Incomplete command/);
    expect(await cli.executeCommand('clear ip bgp * zorglub')).toMatch(/Invalid input detected/);
  });

  it('accepts the documented target kinds', async () => {
    const { cli } = await lab();
    for (const line of ['clear ip bgp 65001', 'clear ip bgp external', 'clear ip bgp internal', 'clear ip bgp * soft in']) {
      expect(await cli.executeCommand(line), line).not.toMatch(/Invalid input|Incomplete/);
    }
  });
});
