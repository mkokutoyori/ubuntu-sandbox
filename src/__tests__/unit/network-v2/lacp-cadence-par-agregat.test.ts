/**
 * La cadence LACP appartient a l'AGREGAT qui la configure, pas a la
 * machine. Le lot precedent l'a etabli pour `lacp rate` sur IOS ; les
 * deux autres constructeurs portaient le meme defaut et sont restes
 * ouverts — c'est la regle du depot, un fait ecrit deux fois finit par
 * diverger, et ici il l'etait trois fois.
 *
 * VRP : la documentation Huawei du `lacp timeout` est explicite sur
 * les deux points qui comptent — « The command is run in the Eth-Trunk
 * interface view » et « The timeout period configured on an Eth-Trunk
 * interface takes effect on all its member interfaces » — avec fast =
 * 3 s de reception pour 1 s d'emission du pair, slow = 90 s pour 30 s,
 * et slow par defaut. Mesure : `lacp timeout fast` sous
 * `interface Eth-Trunk 1` faisait annoncer la cadence rapide au membre
 * de l'Eth-Trunk 2, qui n'a rien demande.
 *
 * FortiOS : `set lacp-speed` vit sous `edit bond<n>`, donc par
 * agregat. Le defaut mesure y etait PIRE que la fuite : chaque commit
 * d'agregat reposait la cadence de TOUTE la machine, si bien que le
 * DERNIER agregat commite decidait pour les autres — avec `bond1` en
 * `fast` et `bond2` par defaut, PLUS PERSONNE n'annoncait la cadence
 * rapide, pas meme bond1.
 *
 * DISCRIMINATION : 3 des 6 cas tombent contre l'etat d'avant — j'en
 * annoncais 4. Les 3 qui passent des deux cotes sont nommes : les deux
 * TEMOINS d'un seul agregat par machine, ou une cadence d'equipement
 * et une cadence d'agregat repondent la meme chose ; et le rendu de la
 * ligne sous son Eth-Trunk, qui etait DEJA juste — la configuration
 * disait la verite, seule l'APPLICATION fuyait, et c'est precisement
 * ce qui rendait le defaut invisible a la relecture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LACP_FLAG_TIMEOUT } from '@/network/lacp/types';
import type { LacpAgent } from '@/network/lacp/LacpAgent';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

function agentDe(d: unknown): LacpAgent {
  return (d as { getLacpAgent(): LacpAgent }).getLacpAgent();
}

function cadenceVue(voisin: unknown, port: string): boolean {
  const partenaire = agentDe(voisin).getPortInfo(port)?.partner;
  return ((partenaire?.state ?? 0) & LACP_FLAG_TIMEOUT) !== 0;
}

async function laboVrp(trunks: number, rapideSur?: number) {
  const a = new HuaweiSwitch('switch-huawei', 'SWA', 24, 300, 0);
  const b = new HuaweiSwitch('switch-huawei', 'SWB', 24, 300, 200);
  a.powerOn(); b.powerOn();
  const pa = a.getPorts().map(p => p.getName());
  const pb = b.getPorts().map(p => p.getName());
  for (let i = 0; i < trunks; i++) new Cable(`x${i}`).connect(a.getPort(pa[i])!, b.getPort(pb[i])!);
  for (const [sw, ports] of [[a, pa], [b, pb]] as const) {
    const cmds = ['system-view'];
    for (let i = 1; i <= trunks; i++) {
      cmds.push(`interface Eth-Trunk ${i}`, 'mode lacp-static', 'quit');
    }
    for (let i = 0; i < trunks; i++) {
      cmds.push(`interface ${ports[i]}`, `eth-trunk ${i + 1}`, 'quit');
    }
    await taper(sw as Cmd, cmds);
  }
  if (rapideSur) {
    await taper(a, [`interface Eth-Trunk ${rapideSur}`, 'lacp timeout fast', 'quit']);
  }
  await vi.advanceTimersByTimeAsync(PERIODIC_MS * 2);
  return { a, b, pa, pb };
}

async function laboFortiGate(agregats: number, rapideSur?: number) {
  const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 400);
  fw.powerOn(); sw.powerOn();
  const ports = fw.getPorts().map(p => p.getName());
  for (let i = 0; i < agregats; i++) {
    new Cable(`f${i}`).connect(fw.getPort(ports[2 + i])!, sw.getPort(`FastEthernet0/${i + 1}`)!);
  }
  const cmdsSw = ['enable', 'configure terminal'];
  for (let i = 1; i <= agregats; i++) {
    cmdsSw.push(`interface FastEthernet0/${i}`, `channel-group ${i} mode active`, 'exit');
  }
  await taper(sw, [...cmdsSw, 'end']);
  const cmdsFw = ['config system interface'];
  for (let i = 1; i <= agregats; i++) {
    cmdsFw.push(`edit bond${i}`, 'set type aggregate', `set member ${ports[1 + i]}`,
      'set lacp-mode active');
    if (rapideSur === i) cmdsFw.push('set lacp-speed fast');
    cmdsFw.push('next');
  }
  await taper(fw, [...cmdsFw, 'end']);
  await vi.advanceTimersByTimeAsync(PERIODIC_MS * 2);
  return { fw, sw };
}

describe('la cadence LACP appartient a l\'agregat', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('VRP : `lacp timeout fast` ne touche que son Eth-Trunk', async () => {
    const { b, pb } = await laboVrp(2, 1);
    expect(cadenceVue(b, pb[0])).toBe(true);
    expect(cadenceVue(b, pb[1])).toBe(false);
  }, 30_000);

  it('VRP TEMOIN : un seul trunk, la cadence porte', async () => {
    const { b, pb } = await laboVrp(1, 1);
    expect(cadenceVue(b, pb[0])).toBe(true);
  }, 30_000);

  it('VRP : la ligne reste sous son Eth-Trunk dans la configuration', async () => {
    const { a } = await laboVrp(2, 2);
    const cfg = await a.executeCommand('display current-configuration');
    const bloc = cfg.slice(cfg.indexOf('interface Eth-Trunk2'));
    expect(bloc).toContain('lacp timeout fast');
    expect(cfg.slice(cfg.indexOf('interface Eth-Trunk1'), cfg.indexOf('interface Eth-Trunk2')))
      .not.toContain('lacp timeout');
  }, 30_000);

  it('FortiOS : `set lacp-speed fast` ne touche que son agregat', async () => {
    const { sw } = await laboFortiGate(2, 1);
    expect(cadenceVue(sw, 'FastEthernet0/1')).toBe(true);
    expect(cadenceVue(sw, 'FastEthernet0/2')).toBe(false);
  }, 30_000);

  it('FortiOS TEMOIN : un seul agregat, la cadence porte', async () => {
    const { sw } = await laboFortiGate(1, 1);
    expect(cadenceVue(sw, 'FastEthernet0/1')).toBe(true);
  }, 30_000);

  it('FortiOS : l\'agregat suivant n\'efface pas la cadence du precedent', async () => {
    const { fw, sw } = await laboFortiGate(2, 1);
    await taper(fw, ['config system interface', 'edit bond2', 'set mtu-override enable',
      'set mtu 1400', 'next', 'end']);
    await vi.advanceTimersByTimeAsync(PERIODIC_MS * 2);
    expect(cadenceVue(sw, 'FastEthernet0/1')).toBe(true);
  }, 30_000);
});
