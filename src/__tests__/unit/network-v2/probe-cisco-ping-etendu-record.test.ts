/**
 * The `Record` answer of the IOS extended ping prompt (`Loose, Strict, Record, Timestamp, Verbose[none]:`) puts a Record Route option (RFC 791, option 7, 9 slots) in every echo request.
 * Measured before the change: the answer was read, stored in ExtendedPingParams.routeOptions and ignored (only a "not verified" line was printed), so the request left without the option: a stored
 * criterion that nothing evaluated. The option is now built by the Ipv4Options module the Linux and Windows ping already use, and the header and total length carry it. What IOS prints for the
 * recorded route is not attested from here (TODO.md [ip]); the "not verified" line stays for what is still not applied (Loose, Strict, Timestamp, Verbose).
 * Discriminated with git stash on src/network and src/terminal: 2 of 3 cases fall (the option is on the wire; the header grows to 60 bytes with the option, the 80 bytes of ICMP stay the same: ihl 15, total length 140). The WITNESS passes either way:
 * with the answer `none` the request carries no option.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const key = (k: string) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as never;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) { await Promise.resolve(); await tick(); }
}

async function answer(term: CiscoTerminalSession, value: string): Promise<void> {
  const fg = term as unknown as { setInput: (v: string) => void; setInputBuf: (v: string) => void; handleKey: (e: unknown) => void; currentInputMode: { type: string } };
  if (fg.currentInputMode.type === 'interactive-text') fg.setInputBuf(value);
  else fg.setInput(value);
  fg.handleKey(key('Enter'));
  await settle();
}

async function pingWith(routeOptions: string): Promise<IPv4Packet[]> {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);
  const [a] = r1.getPortNames();
  const [b] = r2.getPortNames();
  for (const c of ['enable', 'configure terminal', `interface ${a}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) await r1.executeCommand(c);
  for (const c of ['enable', 'configure terminal', `interface ${b}`, 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'end']) await r2.executeCommand(c);
  const requests: IPv4Packet[] = [];
  r2.attachCapture(({ direction, frame }) => {
    const ip = frame.payload as IPv4Packet | undefined;
    if (direction === 'in' && ip?.type === 'ipv4' && (ip.payload as { icmpType?: string } | undefined)?.icmpType === 'echo-request') requests.push(ip);
  });
  const term = new CiscoTerminalSession('t1', r1);
  await term.init?.();
  await answer(term, 'enable');
  await answer(term, 'ping');
  for (const reply of ['', '10.0.0.2', '2', '', '', 'y', a, '', '', '', '', routeOptions, '']) await answer(term, reply);
  await settle(80);
  return requests;
}

describe('IOS extended ping, Record answer', () => {
  it('WITNESS: with `none` the requests carry no IP option', async () => {
    const requests = await pingWith('none');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((packet) => (packet.options ?? []).length === 0)).toBe(true);
  });

  it('puts a Record Route option in every request', async () => {
    const requests = await pingWith('Record');
    expect(requests.length).toBeGreaterThan(0);
    for (const packet of requests) expect((packet.options ?? []).map((option) => option.type)).toEqual([7]);
  });

  it('the header and the total length carry the option', async () => {
    const [packet] = await pingWith('Record');
    expect(packet.ihl).toBe(15);
    expect(packet.totalLength).toBe(60 + 8 + 72);
  });
});
