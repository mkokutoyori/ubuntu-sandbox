/**
 * `lacp rate` est une commande d'INTERFACE sur IOS, et le bit Timeout
 * qu'elle pose vaut pour CE port. 802.1AX §6.4.13 : le minuteur
 * `current_while` d'un port se derive du bit Timeout de SON acteur,
 * et `ad_rx_machine` de `bond_3ad.c` l'ecrit tel quel —
 * `__ad_timer_to_ticks(AD_CURRENT_WHILE_TIMER, port->actor_oper_port_state
 * & LACP_STATE_LACP_TIMEOUT)`.
 *
 * LE DEFAUT MESURE tenait en deux moities, et le commentaire du
 * gestionnaire avouait la premiere : le moteur ne gardait qu'UNE
 * cadence pour toute la machine, donc `lacp rate fast` tape sous
 * `interface FastEthernet0/1` s'appliquait aussi a Fa0/2, dans un
 * autre groupe. La seconde moitie n'etait pas avouee et coute plus
 * cher : la ligne ressortait de `show running-config` au niveau
 * GLOBAL, apres toutes les interfaces — et cette forme-la, la machine
 * la REFUSE (`% Invalid input detected`). La configuration rendue
 * n'etait donc pas rejouable, et un import de topologie perdait le
 * reglage en silence.
 *
 * DISCRIMINATION : 6 des 10 cas tombent contre l'etat d'avant. Les 4
 * autres sont nommes : le TEMOIN d'un seul port en `fast`, ou une
 * cadence globale donne la meme reponse qu'une cadence de port ; le
 * refus de la forme GLOBALE, deja en place — et c'est ce refus qui
 * rendait la configuration injouable ; le refus d'une valeur
 * inconnue ; et le defaut, ou rien n'est rendu ni d'un cote ni de
 * l'autre.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

async function labo(extra: readonly string[] = []) {
  const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
  const b = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 200);
  a.powerOn(); b.powerOn();
  for (let i = 1; i <= 2; i++) {
    new Cable(`x${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
  }
  await taper(a, ['enable', 'configure terminal',
    'interface FastEthernet0/1', 'channel-group 1 mode active', 'exit',
    'interface FastEthernet0/2', 'channel-group 2 mode active', 'exit',
    ...extra, 'end']);
  await taper(b, ['enable', 'configure terminal',
    'interface FastEthernet0/1', 'channel-group 1 mode active', 'exit',
    'interface FastEthernet0/2', 'channel-group 2 mode active', 'end']);
  await vi.advanceTimersByTimeAsync(PERIODIC_MS * 2);
  return { a, b };
}

function timeoutVuParLePair(b: unknown, port: string): number {
  const partenaire = agentDe(b).getPortInfo(port)?.partner;
  return (partenaire?.state ?? 0) & LACP_FLAG_TIMEOUT;
}

describe('`lacp rate` est une commande d\'interface', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('la ligne est rendue SOUS l\'interface', async () => {
    const { a } = await labo(['interface FastEthernet0/1', 'lacp rate fast']);
    const cfg = await a.executeCommand('show running-config');
    const bloc = cfg.slice(cfg.indexOf('interface FastEthernet0/1'));
    expect(bloc.slice(0, bloc.indexOf('interface FastEthernet0/2')))
      .toContain(' lacp rate fast');
  }, 30_000);

  it('elle n\'est PAS rendue au niveau global', async () => {
    const { a } = await labo(['interface FastEthernet0/1', 'lacp rate fast']);
    const cfg = await a.executeCommand('show running-config');
    expect(cfg).not.toMatch(/^lacp rate fast$/m);
  }, 30_000);

  it('la forme globale est refusee, comme sur IOS', async () => {
    const { a } = await labo();
    expect(await taper(a, ['configure terminal', 'lacp rate fast']))
      .toContain('Invalid input');
  }, 30_000);

  it('TEMOIN : un port en `fast` annonce le bit Timeout', async () => {
    const { b } = await labo(['interface FastEthernet0/1', 'lacp rate fast']);
    expect(timeoutVuParLePair(b, 'FastEthernet0/1')).not.toBe(0);
  }, 30_000);

  it('le port voisin, lui, reste en cadence lente', async () => {
    const { b } = await labo(['interface FastEthernet0/1', 'lacp rate fast']);
    expect(timeoutVuParLePair(b, 'FastEthernet0/2')).toBe(0);
  }, 30_000);

  it('`lacp rate normal` sur un port ne touche pas l\'autre', async () => {
    const { b } = await labo([
      'interface FastEthernet0/1', 'lacp rate fast', 'exit',
      'interface FastEthernet0/2', 'lacp rate normal',
    ]);
    expect(timeoutVuParLePair(b, 'FastEthernet0/1')).not.toBe(0);
    expect(timeoutVuParLePair(b, 'FastEthernet0/2')).toBe(0);
  }, 30_000);

  it('le minuteur de reception suit le port', async () => {
    const { a, b } = await labo(['interface FastEthernet0/1', 'lacp rate fast']);
    agentDe(b).stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agentDe(a).getPortInfo('FastEthernet0/1')?.state).toBe('expired');
    expect(agentDe(a).getPortInfo('FastEthernet0/2')?.state).toBe('bundled');
  }, 30_000);

  it('la cadence posee AVANT le groupe est retenue', async () => {
    const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
    a.powerOn();
    await taper(a, ['enable', 'configure terminal', 'interface FastEthernet0/3',
      'lacp rate fast', 'channel-group 3 mode active', 'end']);
    expect(agentDe(a).getPortInfo('FastEthernet0/3')?.fastRate).toBe(true);
  }, 30_000);

  it('une valeur inconnue est refusee', async () => {
    const { a } = await labo();
    expect(await taper(a, ['configure terminal', 'interface FastEthernet0/1',
      'lacp rate zorglub'])).toContain('Invalid input');
  }, 30_000);

  it('par defaut, rien n\'est rendu', async () => {
    const { a } = await labo();
    expect(await a.executeCommand('show running-config')).not.toContain('lacp rate');
  }, 30_000);
});
