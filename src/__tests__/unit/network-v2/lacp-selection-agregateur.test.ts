/**
 * `ad_select` et, avant lui, la regle qui le rend necessaire : deux
 * voisins font DEUX agregations (802.1AX §6.4.15), et une seule porte
 * le trafic. Mesure contre `ad_port_selection_logic` de `bond_3ad.c`
 * pour l'identite d'une agregation — meme cle d'acteur, meme systeme
 * partenaire, meme cle partenaire — et contre `ad_agg_selection_test`
 * pour le depart entre candidates.
 *
 * LE DEFAUT MESURE n'etait pas le reglage manquant. Un serveur cable
 * deux fois vers un commutateur A et deux fois vers un commutateur B
 * SANS MLAG groupait les QUATRE liens et annoncait `Aggregator ID: 1`
 * partout : le serveur pontait deux commutateurs independants sans
 * qu'aucun protocole ne le dise, et une trame hachee vers B partait
 * avec une adresse source que A avait apprise sur son Port-channel.
 *
 * DISCRIMINATION : 10 des 14 cas tombent contre l'etat d'avant. Les 4
 * autres sont nommes : le TEMOIN a un seul commutateur, dont c'est
 * l'objet de passer des deux cotes ; la ligne `ad_select` de
 * `/proc/net/bonding`, deja rendue mais ne decidant rien ; le refus
 * d'une valeur inconnue, que l'analyseur d'options refusait deja ; et
 * « le trafic ne sort QUE par l'agregation active », qui passait par
 * COINCIDENCE — sans destination joignable la resolution ARP part en
 * diffusion sur la seule interface que le repli choisissait, ce qui
 * n'est pas ce que le cas veut dire ; il garde neanmoins que rien ne
 * sort par le cote suspendu.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { LacpAgent } from '@/network/lacp/LacpAgent';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const LACP_PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

function agentDe(d: unknown): LacpAgent {
  return (d as { getLacpAgent(): LacpAgent }).getLacpAgent();
}

/**
 * `versA` liens vers le commutateur A, `versB` vers le B. Les deux
 * commutateurs sont independants : aucun MLAG ne les relie.
 */
async function labo(versA: number, versB: number, adSelect?: string) {
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const swA = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
  const swB = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 200);
  srv.powerOn(); swA.powerOn(); swB.powerOn();
  const nics: string[] = [];
  let n = 0;
  for (const [sw, combien] of [[swA, versA], [swB, versB]] as const) {
    await taper(sw as Cmd, ['enable', 'configure terminal']);
    for (let i = 1; i <= combien; i++) {
      const nic = srv.getPorts()[n].getName();
      new Cable(`c${n}`).connect(srv.getPorts()[n], sw.getPort(`FastEthernet0/${i}`)!);
      await taper(sw as Cmd, [`interface FastEthernet0/${i}`,
        'channel-group 1 mode active', 'exit']);
      nics.push(nic);
      n += 1;
    }
    await (sw as Cmd).executeCommand('end');
  }
  await taper(srv, ['ip link add bond0 type bond',
    `ip link set bond0 type bond mode 802.3ad${adSelect ? ` ad_select ${adSelect}` : ''}`]);
  for (const nic of nics) await srv.executeCommand(`ip link set ${nic} master bond0`);
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { srv, swA, swB, nics };
}

function groupes(srv: unknown, nics: readonly string[]): string[] {
  return nics.filter(nic => agentDe(srv).getPortInfo(nic)?.bundled === true);
}

describe('deux voisins font DEUX agregations', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un seul commutateur groupe tous les liens — TEMOIN', async () => {
    const { srv, nics } = await labo(3, 0);
    expect(groupes(srv, nics)).toEqual(nics);
  }, 30_000);

  it('deux commutateurs sans MLAG ne groupent QU\'UN cote', async () => {
    const { srv, nics } = await labo(2, 2);
    const actifs = groupes(srv, nics);
    expect(actifs).toHaveLength(2);
    expect(new Set(actifs)).toEqual(new Set([nics[0], nics[1]]));
  }, 30_000);

  it('le cote ecarte est SUSPENDU, pas isole ni en attente', async () => {
    const { srv, nics } = await labo(2, 2);
    for (const nic of [nics[2], nics[3]]) {
      const info = agentDe(srv).getPortInfo(nic)!;
      expect(info.state, nic).toBe('suspended');
      expect(info.partner, nic).not.toBeNull();
    }
  }, 30_000);

  it('l\'identite d\'une agregation est celle du noyau', async () => {
    const { srv, nics } = await labo(2, 2);
    const agent = agentDe(srv);
    const lag = (n: string) => agent.lagIdOf(agent.getPortInfo(n)!);
    expect(lag(nics[0])).toBe(lag(nics[1]));
    expect(lag(nics[2])).toBe(lag(nics[3]));
    expect(lag(nics[0])).not.toBe(lag(nics[2]));
  }, 30_000);

  it('`/proc/net/bonding` numerote les DEUX agregateurs', async () => {
    const { srv } = await labo(2, 2);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    const ids = out.split('\n').filter(l => l.startsWith('Aggregator ID:'));
    expect(new Set(ids)).toEqual(new Set(['Aggregator ID: 1', 'Aggregator ID: 2']));
  }, 30_000);

  it('un port sans partenaire n\'entraine personne dans son agregation', async () => {
    const { srv, nics } = await labo(2, 0);
    const agent = agentDe(srv);
    const seul = agent.getPortInfo(nics[0])!;
    expect(agent.lagIdOf({ ...seul, partner: null })).toContain('individual:');
  }, 30_000);
});

describe('la politique choisit LAQUELLE porte', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('`count` prend la plus NOMBREUSE', async () => {
    const { srv, nics } = await labo(1, 3, 'count');
    expect(groupes(srv, nics)).toEqual([nics[1], nics[2], nics[3]]);
  }, 30_000);

  it('`bandwidth` prend la plus LARGE', async () => {
    const { srv, nics } = await labo(1, 3, 'bandwidth');
    expect(groupes(srv, nics)).toEqual([nics[1], nics[2], nics[3]]);
  }, 30_000);

  it('`stable` ne remplace PAS la tenante qui porte encore', async () => {
    const { srv, nics } = await labo(1, 3, 'stable');
    expect(groupes(srv, nics)).toEqual([nics[0]]);
  }, 30_000);

  it('changer la politique en marche redistribue', async () => {
    const { srv, nics } = await labo(1, 3, 'stable');
    expect(groupes(srv, nics)).toEqual([nics[0]]);
    await srv.executeCommand('ip link set bond0 type bond ad_select count');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(groupes(srv, nics)).toEqual([nics[1], nics[2], nics[3]]);
  }, 30_000);

  it('`stable` reprend la main quand la tenante ne porte plus', async () => {
    const { srv, swA, nics } = await labo(1, 3, 'stable');
    expect(groupes(srv, nics)).toEqual([nics[0]]);
    await taper(swA, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'no channel-group', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    expect(groupes(srv, nics)).toEqual([nics[1], nics[2], nics[3]]);
  }, 30_000);

  it('la politique est rendue par `/proc/net/bonding`', async () => {
    const { srv } = await labo(2, 2, 'count');
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('Aggregator selection policy (ad_select): count');
  }, 30_000);

  it('une politique inconnue est refusee', async () => {
    const { srv } = await labo(2, 0);
    await srv.executeCommand('ip link set bond0 type bond ad_select zorglub');
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('Aggregator selection policy (ad_select): stable');
  }, 30_000);

  it('le trafic ne sort QUE par l\'agregation active', async () => {
    const { srv, nics } = await labo(2, 2);
    await srv.executeCommand('ip addr add 10.9.0.1/24 dev bond0');
    const vus: string[] = [];
    srv.attachCapture((t) => {
      if (t.direction === 'out' && nics.includes(t.iface)) vus.push(t.iface);
    });
    vi.useRealTimers();
    await srv.executeCommand('ping -c 3 10.9.0.2');
    expect(vus.length).toBeGreaterThan(0);
    expect(vus).not.toContain(nics[2]);
    expect(vus).not.toContain(nics[3]);
  }, 30_000);
});
