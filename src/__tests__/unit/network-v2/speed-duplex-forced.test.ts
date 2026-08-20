/**
 * A forced `speed` / `duplex` is what the machine reports.
 *
 * Measured first, on a switch port set to `speed 10` / `duplex half`:
 * `show running-config interface` echoed both, while `show interfaces
 * status` answered `a-full  a-100` and `show interfaces` answered
 * `Full-duplex, 100Mbps, BW 100000`. Three views denied the
 * configuration on the same machine at the same instant, and the `a-`
 * prefix is IOS's way of saying AUTO-NEGOTIATED, which is false the
 * moment an operator forces the value.
 *
 * Two causes, and the second was the interesting one.
 *
 *   1. The switch stored `speed`/`duplex` as raw interface text — a
 *      catch-all beside `mdix` and `srr-queue` — so the port never saw
 *      them. The router's own handlers already called the setters.
 *   2. `Port` carried TWO flags for one fact: `negotiationAuto`,
 *      written by the CLI and read only by the running-config renderer,
 *      and `autoNegotiation`, which is what `getNegotiatedSpeed()` and
 *      `getNegotiatedDuplex()` consult. So even the router — which set
 *      the values correctly — left negotiation on, and every view kept
 *      reporting what the link had agreed on. The router had the defect
 *      too; only the switch made it obvious.
 *
 * A third piece was needed for the values to move at all: changing
 * speed, duplex or the negotiation mode re-runs the cable's
 * negotiation, as it bounces a real link. Without it the negotiated
 * values stayed at whatever the link agreed on before.
 *
 * This is not display alone: `getEffectiveBandwidthKbps()` and the IOS
 * default delay follow the negotiated speed, and STP path cost, CDP's
 * reported duplex and the cable's own mismatch detection all read it.
 */

import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';

const cfg = async (d: CiscoSwitch | CiscoRouter, lines: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lines) out.push(await d.executeCommand(l));
  return out;
};

async function switchPair(): Promise<{ sw: CiscoSwitch; peer: CiscoSwitch }> {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const peer = new CiscoSwitch('switch-cisco', 'SW2', 8);
  sw.powerOn(); peer.powerOn();
  new Cable('c').connect(sw.getPort('FastEthernet0/1')!, peer.getPort('FastEthernet0/1')!);
  return { sw, peer };
}

const statusLine = async (sw: CiscoSwitch): Promise<string> =>
  (await sw.executeCommand('show interfaces status'))
    .split('\n').find((l) => l.includes('Fa0/1')) ?? '';

describe('a switch port follows what was forced', () => {
  it('show interfaces status drops the auto prefix and shows the forced values', async () => {
    const { sw } = await switchPair();
    expect(await statusLine(sw)).toMatch(/a-full\s+a-100/);

    const outputs = await cfg(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'speed 10', 'duplex half', 'end']);
    expect(outputs.filter((o) => o.includes('%'))).toEqual([]);
    expect(await statusLine(sw)).toMatch(/\bhalf\s+10\b/);
    expect(await statusLine(sw)).not.toContain('a-');
  });

  it('show interfaces reports the same duplex and speed', async () => {
    const { sw } = await switchPair();
    await cfg(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'speed 10', 'duplex half', 'end']);
    const detail = await sw.executeCommand('show interfaces FastEthernet0/1');
    expect(detail).toContain('Half-duplex, 10Mbps');
  });

  it('and the bandwidth follows the forced speed', async () => {
    // Not cosmetic: EIGRP reads this bandwidth, and STP the speed.
    const { sw } = await switchPair();
    await cfg(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'speed 10', 'end']);
    expect(await sw.executeCommand('show interfaces FastEthernet0/1'))
      .toContain('BW 10000 Kbit/sec');
  });

  it('speed auto gives negotiation back', async () => {
    const { sw } = await switchPair();
    await cfg(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'speed 10', 'duplex half', 'end']);
    await cfg(sw, ['configure terminal',
      'interface FastEthernet0/1', 'speed auto', 'duplex auto', 'end']);
    expect(await statusLine(sw)).toMatch(/a-full\s+a-100/);
  });

  it('an impossible speed is refused rather than stored', async () => {
    const { sw } = await switchPair();
    const outputs = await cfg(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'speed 7', 'duplex sideways', 'end']);
    expect(outputs.filter((o) => o.includes('Invalid input')).length).toBe(2);
    expect(await statusLine(sw)).toMatch(/a-full\s+a-100/);
  });
});

describe('a router port had the same defect', () => {
  it('its views followed the negotiation, not the configuration', async () => {
    const r = new CiscoRouter('R1');
    const peer = new CiscoRouter('R2');
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, peer.getPort('GigabitEthernet0/0')!);
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'speed 10', 'duplex half', 'no shutdown', 'end']);
    const detail = await r.executeCommand('show interfaces GigabitEthernet0/0');
    expect(detail).toContain('Half-duplex, 10Mbps');
    expect(detail).toContain('BW 10000 Kbit/sec');
  });
});

describe('the running configuration still reproduces it', () => {
  it('speed and duplex come back on a switch', async () => {
    const { sw } = await switchPair();
    await cfg(sw, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'speed 10', 'duplex half', 'end']);
    const rc = await sw.executeCommand('show running-config interface FastEthernet0/1');
    expect(rc).toContain('speed 10');
    expect(rc).toContain('duplex half');
  });

  it('and on a router', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'speed 10', 'duplex half', 'end']);
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('speed 10');
    expect(rc).toContain('duplex half');
  });
});
