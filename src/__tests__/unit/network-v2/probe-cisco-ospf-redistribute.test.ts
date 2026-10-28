/*
 * `redistribute` under `router ospf`: declared natively on the socle, its
 * options judged, its metric honoured by the engine, and the whole thing
 * rendered in the running-config.
 *
 * Measured before the change: 31 of the 42 cases fall. The handler read its
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
 * The last block (process-level settings) adds 10 failing cases: `compatible
 * zorglub`, `distance 300`, `distance ospf` with no option, `discard-route
 * zorglub`, `timers lsa arrival zorglub` and the others listed there were
 * accepted, and none of maximum-paths, compatible rfc1583, distance, timers,
 * ispf, prefix-suppression, discard-route, segment-routing or shutdown was
 * rendered. These settings are stored and rendered but the engine does not
 * evaluate them (TODO.md).
 *
 * The last block (capability, bfd, graceful-restart, max-metric,
 * distribute-list) adds 12 failing cases: each accepted a trailing word or a
 * non-number, `distribute-list prefix PL in` stored the word `prefix` as the
 * access list and `PL` as the direction (so it never filtered), and none of
 * their `no` forms existed.
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

describe('the process-level settings are typed and rendered', () => {
  it('shows every setting the operator wrote', async () => {
    const r = await ospf('maximum-paths 2', 'compatible rfc1583', 'distance 100',
      'distance ospf intra-area 90 external 150', 'timers lsa arrival 500',
      'timers pacing flood 20', 'timers pacing retransmission 40', 'ispf',
      'prefix-suppression', 'discard-route external', 'segment-routing mpls', 'shutdown');
    const config = await section(r);
    for (const line of [' maximum-paths 2', ' compatible rfc1583', ' distance 100',
      ' distance ospf intra-area 90 external 150', ' timers lsa arrival 500',
      ' timers pacing flood 20', ' timers pacing retransmission 40', ' ispf',
      ' prefix-suppression', ' discard-route external', ' segment-routing mpls', ' shutdown']) {
      expect(config, line).toContain(line);
    }
  });

  it('`no` restores each one', async () => {
    const r = await ospf('ispf', 'shutdown', 'maximum-paths 2', 'distance 100');
    for (const line of ['no ispf', 'no shutdown', 'no maximum-paths', 'no distance']) {
      await r.executeCommand(line);
    }
    const config = await section(r);
    for (const word of ['ispf', 'shutdown', 'maximum-paths', 'distance']) {
      expect(config, word).not.toContain(` ${word}`);
    }
  });

  it.each([
    'maximum-paths zorglub', 'maximum-paths 0', 'maximum-paths 99', 'compatible zorglub',
    'compatible rfc1583 zorglub', 'distance zorglub', 'distance 300', 'distance 110 zorglub',
    'distance ospf', 'distance ospf external zorglub', 'ispf zorglub', 'shutdown zorglub',
    'prefix-suppression zorglub', 'discard-route zorglub', 'timers lsa arrival zorglub',
  ])('refuses `%s` at the caret or as incomplete', async (line) => {
    const out = await (await ospf()).executeCommand(line);
    expect(out).toMatch(/Invalid input detected|Incomplete command/);
  });
});

describe('capability, bfd, graceful-restart, max-metric and distribute-list', () => {
  it.each([
    'distribute-list zorglub', 'distribute-list 10 zorglub', 'distribute-list 10 in zorglub',
    'distribute-list prefix P zorglub', 'graceful-restart zorglub',
    'graceful-restart grace-period zorglub', 'bfd zorglub', 'bfd all-interfaces zorglub',
    'max-metric router-lsa zorglub', 'max-metric router-lsa on-startup zorglub',
    'capability zorglub',
  ])('refuses `%s`', async (line) => {
    expect(await (await ospf()).executeCommand(line))
      .toMatch(/Invalid input detected|Incomplete command/);
  });

  it('keeps the prefix-list name of `distribute-list prefix` and renders it', async () => {
    const r = await ospf('distribute-list prefix PL in');
    expect(await section(r)).toContain(' distribute-list prefix PL in');
  });

  it('`no` removes each of them', async () => {
    const r = await ospf('distribute-list 10 out', 'bfd all-interfaces',
      'graceful-restart grace-period 90', 'max-metric router-lsa', 'capability opaque');
    for (const line of ['no distribute-list', 'no bfd all-interfaces', 'no graceful-restart',
      'no max-metric router-lsa', 'no capability opaque']) {
      await r.executeCommand(line);
    }
    const config = await section(r);
    for (const word of ['distribute-list', 'bfd', 'graceful-restart', 'max-metric', 'capability']) {
      expect(config, word).not.toContain(` ${word}`);
    }
  });
});
