/*
 * `redistribute` under `router ospf`: declared natively on the socle, its
 * options judged, its metric honoured by the engine, and the whole thing
 * rendered in the running-config.
 *
 * Measured before the change: 9 of the 12 cases fall. The handler read its
 * options with a positional parseInt scan: `metric zorglub` and
 * `metric-type 5` were accepted (the 5 stored as the external type), a
 * trailing word was accepted, `metric` on `static` and `connected` was
 * ignored (the engine advertised 20 whatever the operator wrote), `redistribute
 * bgp|eigrp|ospf N` was accepted and silently did nothing, and NONE of it was
 * rendered by `show running-config`, so a saved topology lost its
 * redistribution. The three that pass either way: the bare forms, `redistribute
 * zorglub` (the protocol keyword was already judged) and the default metric of
 * 20 when none is written.
 *
 * The last case (the other six accepted settings rendered) was added by the
 * follow-up: max-lsa, max-metric, summary-address, distribute-list, bfd
 * all-interfaces and graceful-restart were stored and never shown.
 *
 * Not declared, because the engine cannot evaluate them (TODO.md):
 * `route-map` and `tag`.
 */
import { describe, it, expect, vi } from 'vitest';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function ospf(...lines: string[]): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'router ospf 1', ...lines]) {
    await r.executeCommand(l);
  }
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;
const section = async (r: Cli): Promise<string> =>
  r.executeCommand('do show running-config | section router ospf');

describe('redistribute under router ospf', () => {
  it('witness: the bare forms are accepted', async () => {
    const r = await ospf();
    for (const line of ['redistribute static subnets', 'redistribute connected subnets',
      'redistribute rip subnets']) {
      expect(await r.executeCommand(line), line).toBe('');
    }
  });

  it.each([
    'redistribute static metric zorglub',
    'redistribute static metric-type 5',
    'redistribute static subnets zorglub',
    'redistribute static metric 99999999',
    'redistribute bgp zorglub',
    'redistribute zorglub',
  ])('refuses `%s` at the caret', async (line) => {
    expect(await (await ospf()).executeCommand(line)).toMatch(CARET);
  });

  it('renders every redistribution with its options', async () => {
    const r = await ospf('redistribute static metric 10 metric-type 1 subnets',
      'redistribute connected subnets', 'redistribute rip metric 5',
      'redistribute bgp 65001 subnets', 'redistribute eigrp 10');
    const config = await section(r);
    for (const line of [' redistribute static metric 10 metric-type 1 subnets',
      ' redistribute connected subnets', ' redistribute rip metric 5',
      ' redistribute bgp 65001 subnets', ' redistribute eigrp 10']) {
      expect(config, line).toContain(line);
    }
  });

  it('`no redistribute <protocol>` removes only that line, bare `no redistribute` all', async () => {
    const r = await ospf('redistribute static subnets', 'redistribute connected subnets',
      'redistribute bgp 65001');
    await r.executeCommand('no redistribute static');
    let config = await section(r);
    expect(config).not.toContain('redistribute static');
    expect(config).toContain('redistribute connected');
    await r.executeCommand('no redistribute');
    config = await section(r);
    expect(config).not.toContain('redistribute');
  });
});

describe('the engine honours the metric the operator wrote', () => {
  const advertised = async (metricClause: string) => {
    const spy = vi.spyOn(OSPFEngine.prototype, 'replaceRedistributedRoutes');
    const r = await ospf('interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit', 'ip route 192.168.50.0 255.255.255.0 10.0.0.2', 'router ospf 1',
      'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.255 area 0');
    spy.mockClear();
    await r.executeCommand(`redistribute static ${metricClause} subnets`);
    const last = spy.mock.calls.at(-1)?.[0] ?? [];
    spy.mockRestore();
    return last.find((route) => route.network === '192.168.50.0');
  };

  it('witness: with no metric the default of 20 is advertised', async () => {
    expect((await advertised(''))?.metric).toBe(20);
  });

  it('advertises the static metric and external type that were configured', async () => {
    const route = await advertised('metric 77 metric-type 1');
    expect(route?.metric).toBe(77);
    expect(route?.metricType).toBe(1);
  });
});

describe('the other accepted OSPF settings are rendered too', () => {
  it('shows max-lsa, max-metric, summary-address, distribute-list, bfd and graceful-restart', async () => {
    const r = await ospf('max-lsa 5000', 'max-metric router-lsa on-startup 60',
      'summary-address 172.16.0.0 255.255.0.0', 'distribute-list 10 out',
      'bfd all-interfaces', 'graceful-restart grace-period 90');
    const config = await section(r);
    for (const line of [' max-lsa 5000', ' max-metric router-lsa on-startup 60',
      ' summary-address 172.16.0.0 255.255.0.0', ' distribute-list 10 out',
      ' bfd all-interfaces', ' graceful-restart grace-period 90']) {
      expect(config, line).toContain(line);
    }
  });
});
