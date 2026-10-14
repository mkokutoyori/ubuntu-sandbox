/**
 * firewall policy diffserv-forward / diffserv-reverse / diffservcode-* /
 * diffserv-copy: the DSCP of the original direction (forward) and of the reply
 * direction (reverse) is rewritten in transit, and diffserv-copy gives the
 * reply the DSCP the original packet arrived with. The egress sniffer (hex
 * dump, verbosity 6) reads the ToS byte of the packet that leaves.
 *
 * Measured on a git worktree of HEAD before the change: the grammar refuses
 * the attributes, so the 3 rewriting cases fall (3 of 5). The 2 others are
 * witnesses: the untouched SYN leaves with ToS 0, and a malformed code is
 * refused, which holds whenever the attribute exists.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out.join('\n');
}

async function lab(extra: string[]) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await run(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1']);
  await run(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1']);
  const refusal = await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    ...extra, 'next', 'end',
  ]);
  srv.getTcpStack().listen(9000, { onAccept: () => undefined });
  await pc.executeCommand('sudo hping3 -S -p 9000 -o 0x28 -c 1 192.168.20.10');
  const tosOf = async (port: string, marker: string) => {
    const dump = await fgt.executeCommand(`diagnose sniffer packet ${port} "tcp port 9000" 6 20`);
    const packet = dump.split(/^(?=\d+\.\d+ )/m).find(p => p.includes(marker) && /syn/.test(p.split('\n')[0]));
    const header = /0800 4[0-9a-f]([0-9a-f]{2})/.exec(packet ?? '');
    return header ? Number.parseInt(header[1], 16) : Number.NaN;
  };
  return { fgt, refusal, forwardTos: () => tosOf('port3', '-> 192.168.20.10.9000'), replyTos: () => tosOf('port2', '192.168.20.10.9000 ->') };
}

describe('policy DiffServ', () => {
  it('witness: without marking the SYN leaves with the ToS it arrived with', async () => {
    const l = await lab([]);
    expect(await l.forwardTos()).toBe(0x28);
  });

  it('diffserv-forward rewrites the DSCP of the original direction, keeping the ECN bits', async () => {
    const l = await lab(['set diffserv-forward enable', 'set diffservcode-forward 101110']);
    expect(await l.forwardTos()).toBe(0xb8);
  });

  it('diffserv-reverse rewrites the DSCP of the reply direction', async () => {
    const l = await lab(['set diffserv-reverse enable', 'set diffservcode-rev 001000']);
    expect(await l.replyTos()).toBe(0x20);
  });

  it('diffserv-copy gives the reply the DSCP of the original packet', async () => {
    const l = await lab(['set diffserv-copy enable']);
    expect(await l.replyTos()).toBe(0x28);
  });

  it('witness: a malformed code is refused', async () => {
    const l = await lab(['set diffservcode-forward 2222']);
    expect(l.refusal).toMatch(/fail|invalid|unknown|not/i);
  });
});
