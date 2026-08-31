/**
 * Quand il y a plus de liens eligibles que l'agregation n'en admet, ce
 * n'est pas chaque cote qui choisit les siens : le systeme de plus
 * FAIBLE priorite decide pour les deux, et l'autre suit. La
 * documentation de Cisco le dit sans detour — « the system with the
 * numerically lower system priority is placed in charge of the
 * decision, and that system decides which ports are active and which
 * are hot standby based on its values for port priority and port
 * number ; the port-priority and port-number values for the other
 * system are not used ».
 *
 * LE DEFAUT MESURE n'etait pas cosmetique. Trois liens entre SWA
 * (`lacp system-priority 100`, priorites de port 1/2/3) et SWB
 * (`system-priority 200`, priorites 30/20/10), `lacp max-bundle 2` des
 * deux cotes : SWA groupait Fa0/1 et Fa0/2, SWB groupait Fa0/2 et
 * Fa0/3. UN SEUL lien etait groupe des deux cotes. SWA hachait donc du
 * trafic vers Fa0/1, dont le bout distant est en attente et ne
 * COLLECTE pas — les trames y disparaissent en silence, ce qui est
 * exactement l'incoherence que la regle de priorite de systeme existe
 * pour empecher.
 *
 * DISCRIMINATION : 4 des 9 cas tombent contre l'etat d'avant — j'en
 * annoncais 5, et la mesure a corrige l'annonce. Les 5 qui passent des
 * deux cotes sont nommes plutot que laisses a decouvrir : « le
 * decideur garde ses propres priorites », qui ne pouvait pas
 * discriminer, le chemin du decideur etant justement celui qui etait
 * DEJA juste ; le TEMOIN a un seul cote borne, ou le decideur est
 * aussi le seul a trancher ; le cas a priorites de port identiques,
 * qui tombait juste par accident, les deux ordres se confondant ; le
 * refus de la commande hors plage ; et la lecture de
 * `lacp system-priority` dans la configuration, deja rendue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

async function laboDeuxCotes(opts: {
  sysA: number; sysB: number;
  prioA: number[]; prioB: number[];
  maxA?: number; maxB?: number;
}) {
  const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
  const b = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 200);
  a.powerOn(); b.powerOn();
  for (let i = 1; i <= 3; i++) {
    new Cable(`x${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
  }
  for (const [sw, sys, prios, max] of [
    [a, opts.sysA, opts.prioA, opts.maxA] as const,
    [b, opts.sysB, opts.prioB, opts.maxB] as const,
  ]) {
    const cmds = ['enable', 'configure terminal', `lacp system-priority ${sys}`,
      'interface range FastEthernet0/1 - 3', 'channel-group 1 mode active', 'exit'];
    prios.forEach((prio, i) => {
      cmds.push(`interface FastEthernet0/${i + 1}`, `lacp port-priority ${prio}`, 'exit');
    });
    if (max) cmds.push('interface port-channel 1', `lacp max-bundle ${max}`);
    cmds.push('end');
    await taper(sw, cmds);
  }
  await vi.advanceTimersByTimeAsync(PERIODIC_MS * 4);
  return { a, b };
}

function groupes(sortie: string): string[] {
  return [...sortie.matchAll(/(Fa0\/\d+)\(P\)/g)].map(m => m[1]);
}

describe('le systeme de plus faible priorite decide pour les deux', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('les deux cotes groupent les MEMES liens', async () => {
    const { a, b } = await laboDeuxCotes({
      sysA: 100, sysB: 200, prioA: [1, 2, 3], prioB: [30, 20, 10], maxA: 2, maxB: 2,
    });
    const cotesA = groupes(await a.executeCommand('show etherchannel summary'));
    const cotesB = groupes(await b.executeCommand('show etherchannel summary'));
    expect(cotesA).toEqual(['Fa0/1', 'Fa0/2']);
    expect(cotesB).toEqual(cotesA);
  }, 30_000);

  it('le suiveur met en attente le lien que le decideur ecarte', async () => {
    const { b } = await laboDeuxCotes({
      sysA: 100, sysB: 200, prioA: [1, 2, 3], prioB: [30, 20, 10], maxA: 2, maxB: 2,
    });
    expect(await b.executeCommand('show etherchannel summary')).toContain('Fa0/3(H)');
  }, 30_000);

  it('inverser la priorite de systeme inverse le decideur', async () => {
    const { a, b } = await laboDeuxCotes({
      sysA: 200, sysB: 100, prioA: [1, 2, 3], prioB: [30, 20, 10], maxA: 2, maxB: 2,
    });
    const cotesA = groupes(await a.executeCommand('show etherchannel summary'));
    const cotesB = groupes(await b.executeCommand('show etherchannel summary'));
    expect(cotesB).toEqual(['Fa0/2', 'Fa0/3']);
    expect(cotesA).toEqual(cotesB);
  }, 30_000);

  it('a priorite de systeme egale, l\'adresse departage', async () => {
    const { a, b } = await laboDeuxCotes({
      sysA: 32768, sysB: 32768, prioA: [1, 2, 3], prioB: [30, 20, 10], maxA: 2, maxB: 2,
    });
    const cotesA = groupes(await a.executeCommand('show etherchannel summary'));
    const cotesB = groupes(await b.executeCommand('show etherchannel summary'));
    expect(cotesA).toEqual(cotesB);
    expect(cotesA).toHaveLength(2);
  }, 30_000);

  it('le decideur garde ses propres priorites', async () => {
    const { a } = await laboDeuxCotes({
      sysA: 100, sysB: 200, prioA: [3, 1, 2], prioB: [10, 20, 30], maxA: 2, maxB: 2,
    });
    expect(groupes(await a.executeCommand('show etherchannel summary')))
      .toEqual(['Fa0/2', 'Fa0/3']);
  }, 30_000);

  it('TEMOIN : un seul cote borne, le decideur tranche seul', async () => {
    const { a, b } = await laboDeuxCotes({
      sysA: 100, sysB: 200, prioA: [1, 2, 3], prioB: [30, 20, 10], maxA: 2,
    });
    expect(groupes(await a.executeCommand('show etherchannel summary')))
      .toEqual(['Fa0/1', 'Fa0/2']);
    expect(groupes(await b.executeCommand('show etherchannel summary')))
      .toHaveLength(3);
  }, 30_000);

  it('a priorites de port identiques les deux cotes concordent', async () => {
    const { a, b } = await laboDeuxCotes({
      sysA: 100, sysB: 200, prioA: [1, 2, 3], prioB: [1, 2, 3], maxA: 2, maxB: 2,
    });
    expect(groupes(await a.executeCommand('show etherchannel summary')))
      .toEqual(groupes(await b.executeCommand('show etherchannel summary')));
  }, 30_000);

  it('`lacp system-priority` figure dans la configuration', async () => {
    const { a } = await laboDeuxCotes({
      sysA: 100, sysB: 200, prioA: [1, 2, 3], prioB: [30, 20, 10], maxA: 2, maxB: 2,
    });
    expect(await a.executeCommand('show running-config')).toContain('lacp system-priority 100');
  }, 30_000);

  it('une priorite de systeme hors plage est refusee', async () => {
    const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
    a.powerOn();
    expect(await taper(a, ['enable', 'configure terminal', 'lacp system-priority 65536']))
      .toMatch(/^% Invalid/);
    expect(await taper(a, ['lacp system-priority 65535'])).toBe('');
  }, 30_000);
});
