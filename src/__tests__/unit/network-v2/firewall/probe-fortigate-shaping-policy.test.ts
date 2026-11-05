/**
 * `config firewall shaping-policy` (FortiOS CLI Reference 7.4.12 : id, name, status, srcintf, dstintf, srcaddr, dstaddr, service, traffic-shaper, traffic-shaper-reverse) : une
 * politique de mise en forme classe le trafic (interfaces, adresses, services) et lui applique un traffic-shaper, SANS que la politique de pare-feu le nomme. Le
 * classement reutilise `PolicyEvaluator` sur une seconde liste de regles ; le shaper nomme par la politique de pare-feu l'emporte s'il existe (le texte de la reference
 * ne tranche pas) ; les criteres de la reference que le moteur n'evalue pas (application, services Internet, CoS, TOS, utilisateurs, per-ip-shaper...) restent des
 * attributs inconnus. L'ordre est celui de la liste, le premier qui correspond gagne.
 * Mesure de depart : « unknown configuration path » ; 3 des 6 cas tombent avant (le shaper applique, la reponse mesuree, le shaper inconnu refuse) ; le temoin (un flux non mis en forme ne perd rien), la politique desactivee et le trafic hors classe passent des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out.join('\n');
}

async function lab(shaper: string[], policy: string[], shapingPolicy: string[] = []) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await run(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1']);
  await run(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1']);
  const typed = await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'next', 'end',
    ...(shaper.length === 0 ? [] : ['config firewall shaper traffic-shaper', 'edit "limit"', ...shaper, 'next', 'end']),
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    ...policy, 'next', 'end',
    ...shapingPolicy,
  ]);
  const received = async (count = 10) => {
    const out = await pingOnSimulatedClock(pc, `ping -c ${count} -s 1400 192.168.20.10`);
    return Number.parseInt(/(\d+) received/.exec(out)?.[1] ?? '-1', 10);
  };
  return { fgt, pc, typed, received };
}


const SHAPING = (extra: string[]) => ['config firewall shaping-policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', ...extra, 'next', 'end'];

describe('firewall shaping-policy', () => {
  it('temoin : un flux non mis en forme ne perd rien', async () => {
    expect(await (await lab([], [])).received()).toBe(10);
  });

  it('la politique de mise en forme applique le shaper sans que la politique de pare-feu le nomme', async () => {
    const l = await lab(['set maximum-bandwidth 160'], [], SHAPING(['set traffic-shaper "limit"']));
    const got = await l.received();
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(10);
  });

  it('traffic-shaper-reverse mesure la reponse', async () => {
    const l = await lab(['set maximum-bandwidth 160'], [], SHAPING(['set traffic-shaper-reverse "limit"']));
    expect(await l.received()).toBeLessThan(10);
  });

  it('une politique desactivee ne classe rien', async () => {
    const l = await lab(['set maximum-bandwidth 160'], [], SHAPING(['set traffic-shaper "limit"', 'set status disable']));
    expect(await l.received()).toBe(10);
  });

  it('un trafic hors de la classe n est pas mis en forme', async () => {
    const l = await lab(['set maximum-bandwidth 160'], [], ['config firewall shaping-policy', 'edit 1', 'set srcintf "port3"', 'set dstintf "port2"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set traffic-shaper "limit"', 'next', 'end']);
    expect(await l.received()).toBe(10);
  });

  it('un shaper inconnu est refuse', async () => {
    const l = await lab([], []);
    await run(l.fgt, ['config firewall shaping-policy', 'edit 1']);
    const reply = await l.fgt.executeCommand('set traffic-shaper "ghost"');
    await run(l.fgt, ['next', 'end']);
    expect(reply).toMatch(/entry not found|not found|parse error/i);
  });
});
