/**
 * Un membre ne COLLECTE et ne DISTRIBUE que si son partenaire a pose
 * le bit Sync. C'est la transition `AD_MUX_ATTACHED` →
 * `AD_MUX_COLLECTING_DISTRIBUTING` de la machine Mux (802.1AX §6.4.15),
 * dont `ad_mux_machine` de `bond_3ad.c` donne la condition telle
 * quelle : `(port->sm_vars & AD_PORT_SELECTED) &&
 * (port->partner_oper.port_state & LACP_STATE_SYNCHRONIZATION)`.
 *
 * LE DEFAUT MESURE est un TROU NOIR silencieux. Trois liens entre deux
 * commutateurs, `lacp max-bundle 2` sur SWA seulement : SWA mettait
 * Fa0/3 en attente — donc n'y collecte rien — pendant que SWB le
 * groupait et y distribuait. Toute trame que SWB hachait vers Fa0/3
 * disparaissait sans un mot, et rien dans aucune vue ne le disait.
 * Ce que fait une vraie machine est documente par Cisco : « If LACP is
 * unable to aggregate all compatible ports into an EtherChannel (for
 * example, if the neighboring switch has hardware limitations), then
 * all ports that cannot be actively included in the channel are put in
 * hot-standby state ».
 *
 * Le correctif a demande sa moitie manquante, le NTT (`Need To
 * Transmit`, §6.4.10) : la garde de re-entrance de l'emission
 * supprimait l'annonce que declenche un CHANGEMENT d'etat de
 * l'acteur, si bien que la sequence normale — j'annonce Sync, tu
 * annonces Sync, nous groupons — s'arretait a la moitie et ne se
 * terminait qu'au tour periodique suivant. Un etat qui change annonce
 * desormais, borne en profondeur puisque l'etat progresse.
 *
 * DISCRIMINATION : 3 des 9 cas tombent contre l'etat d'avant — j'en
 * annoncais 6, et la mesure a corrige l'annonce en disant quelque
 * chose d'utile : la moitie ANNONCE etait deja juste, seule la moitie
 * REACTION manquait. Les 6 qui passent des deux cotes sont donc
 * nommes un a un : le TEMOIN a deux liens sans borne ; le cote QUI
 * PORTE la borne, qui mettait deja son lien en attente ; « le cote
 * borne annonce Sync a ZERO » et « un lien groupe annonce Sync,
 * Collecting et Distributing », les deux cas qui montrent que le fil
 * portait DEJA la bonne information et que personne ne la lisait ; la
 * borne satisfaite, ou rien n'est en attente ; et le retour dans la
 * borne, qui regroupait de toute facon.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LACP_FLAG_SYNC, LACP_FLAG_COLLECTING, LACP_FLAG_DISTRIBUTING } from '@/network/lacp/types';
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

async function labo(liens: number, maxA?: number) {
  const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
  const b = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 200);
  a.powerOn(); b.powerOn();
  for (let i = 1; i <= liens; i++) {
    new Cable(`x${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
  }
  const cmds = ['enable', 'configure terminal',
    `interface range FastEthernet0/1 - ${liens}`, 'channel-group 1 mode active', 'exit'];
  if (maxA) cmds.push('interface port-channel 1', `lacp max-bundle ${maxA}`);
  cmds.push('end');
  await taper(a, cmds);
  await taper(b, ['enable', 'configure terminal',
    `interface range FastEthernet0/1 - ${liens}`, 'channel-group 1 mode active', 'end']);
  await vi.advanceTimersByTimeAsync(PERIODIC_MS * 4);
  return { a, b };
}

describe('un membre ne distribue que si le partenaire a pose Sync', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('TEMOIN : sans borne, les deux cotes groupent tout', async () => {
    const { a, b } = await labo(2);
    for (const sw of [a, b]) {
      expect(await sw.executeCommand('show etherchannel summary'))
        .toContain('Fa0/1(P) Fa0/2(P)');
    }
  }, 30_000);

  it('le cote qui porte la borne met le lien en trop en attente', async () => {
    const { a } = await labo(3, 2);
    expect(await a.executeCommand('show etherchannel summary')).toContain('Fa0/3(H)');
  }, 30_000);

  it('le cote SANS borne met le MEME lien en attente', async () => {
    const { b } = await labo(3, 2);
    expect(await b.executeCommand('show etherchannel summary')).toContain('Fa0/3(H)');
  }, 30_000);

  it('le lien en attente ne distribue pas, des deux cotes', async () => {
    const { a, b } = await labo(3, 2);
    for (const sw of [a, b]) {
      expect(agentDe(sw).getPortInfo('FastEthernet0/3')?.bundled).toBe(false);
    }
  }, 30_000);

  it('le cote borne annonce Sync a ZERO sur le lien ecarte', async () => {
    const { b } = await labo(3, 2);
    const partenaire = agentDe(b).getPortInfo('FastEthernet0/3')?.partner;
    expect(partenaire).toBeTruthy();
    expect(partenaire!.state & LACP_FLAG_SYNC).toBe(0);
  }, 30_000);

  it('un lien groupe annonce Sync, Collecting et Distributing', async () => {
    const { b } = await labo(3, 2);
    const partenaire = agentDe(b).getPortInfo('FastEthernet0/1')?.partner;
    expect(partenaire!.state & LACP_FLAG_SYNC).not.toBe(0);
    expect(partenaire!.state & LACP_FLAG_COLLECTING).not.toBe(0);
    expect(partenaire!.state & LACP_FLAG_DISTRIBUTING).not.toBe(0);
  }, 30_000);

  it('la borne satisfaite ne met rien en attente', async () => {
    const { a, b } = await labo(2, 2);
    for (const sw of [a, b]) {
      expect(await sw.executeCommand('show etherchannel summary')).not.toContain('(H)');
    }
  }, 30_000);

  it('le trafic ne traverse que les liens groupes des deux cotes', async () => {
    const { a, b } = await labo(3, 2);
    const groupesA = ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']
      .filter(n => agentDe(a).getPortInfo(n)?.bundled === true);
    const groupesB = ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']
      .filter(n => agentDe(b).getPortInfo(n)?.bundled === true);
    expect(groupesB).toEqual(groupesA);
  }, 30_000);

  it('un lien qui revient dans la borne se regroupe des deux cotes', async () => {
    const { a, b } = await labo(3, 2);
    await taper(a, ['configure terminal', 'interface port-channel 1',
      'lacp max-bundle 3', 'end']);
    await vi.advanceTimersByTimeAsync(PERIODIC_MS * 4);
    for (const sw of [a, b]) {
      expect(agentDe(sw).getPortInfo('FastEthernet0/3')?.bundled).toBe(true);
    }
  }, 30_000);
});
