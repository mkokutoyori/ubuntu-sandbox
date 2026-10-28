/*
 * Process options of BGP (`bgp cluster-id|maxas-limit|update-delay|asnotation|
 * confederation|default|bestpath|listen|dampening`), RIP (`output-delay`,
 * `flash-update-threshold`, `validate-update-source`) and EIGRP (`timers
 * active-time`, `traffic-share`) that kept any trailing word.
 *
 * Measured before the change: 16 of the 28 cases fall. Every `<option>
 * zorglub` was accepted and stored in the running-config. The 12 that pass
 * either way are the valid forms (witnesses). Bounds (cluster-id 1-4294967295,
 * maxas-limit 1-2000, update-delay 0-3600, output-delay 8-50,
 * flash-update-threshold 0-30, active-time 1-65535) are the IOS ones from
 * memory, not from a fetched page; the dampening numbers are checked loosely.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function inMode(enter: string): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', enter]) await r.executeCommand(l);
  return r;
}

const REFUSED = /Invalid input detected/;

const WITNESSES: [string, string][] = [
  ['router bgp 65000', 'bgp cluster-id 1.1.1.1'], ['router bgp 65000', 'bgp cluster-id 7'],
  ['router bgp 65000', 'bgp maxas-limit 50'], ['router bgp 65000', 'bgp update-delay 120'],
  ['router bgp 65000', 'bgp asnotation dot'], ['router bgp 65000', 'bgp confederation identifier 100'],
  ['router bgp 65000', 'bgp confederation peers 65001 65002'],
  ['router bgp 65000', 'bgp bestpath compare-routerid'],
  ['router bgp 65000', 'bgp dampening 15 750 2000 60'],
  ['router rip', 'output-delay 20'], ['router rip', 'flash-update-threshold 10'],
  ['router eigrp 100', 'timers active-time 3'],
];

const REFUSALS: [string, string][] = [
  ['router bgp 65000', 'bgp cluster-id zorglub'], ['router bgp 65000', 'bgp maxas-limit zorglub'],
  ['router bgp 65000', 'bgp maxas-limit 5000'], ['router bgp 65000', 'bgp update-delay zorglub'],
  ['router bgp 65000', 'bgp asnotation zorglub'], ['router bgp 65000', 'bgp confederation zorglub'],
  ['router bgp 65000', 'bgp confederation identifier zorglub'],
  ['router bgp 65000', 'bgp default zorglub'], ['router bgp 65000', 'bgp bestpath zorglub'],
  ['router bgp 65000', 'bgp listen zorglub'], ['router bgp 65000', 'bgp dampening zorglub'],
  ['router rip', 'output-delay zorglub'], ['router rip', 'flash-update-threshold zorglub'],
  ['router rip', 'validate-update-source zorglub'],
  ['router eigrp 100', 'timers active-time zorglub'], ['router eigrp 100', 'traffic-share zorglub'],
];

describe('BGP, RIP and EIGRP process option tails', () => {
  it.each(WITNESSES)('witness: in `%s`, `%s` is accepted', async (enter, line) => {
    expect(await (await inMode(enter)).executeCommand(line)).toBe('');
  });

  it.each(REFUSALS)('in `%s`, `%s` is refused', async (enter, line) => {
    expect(await (await inMode(enter)).executeCommand(line)).toMatch(REFUSED);
  });
});
