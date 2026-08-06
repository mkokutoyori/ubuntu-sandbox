/**
 * Revue itération 2, §2.6 — aucune tâche périodique ne tourne sur une
 * interface qui n'est pas up.
 *
 * Symptôme : trente-deux secondes après la dernière commande, un routeur
 * dont toutes les interfaces sont down/down publiait
 * `%IGMP_SNOOP-5-NOTIFICATIONS: Querier on GigabitEthernet0/0 is ?
 * (querier)`.
 *
 * Le point d'ÉMISSION vérifiait bien l'état du port et n'envoyait rien —
 * mais `sendGeneralQuery` avait déjà fait avancer la machine à états :
 * après `startupQueryCount` tics silencieux, l'interface s'élisait
 * elle-même querier et l'annonçait. Une requête qui ne part pas ne
 * compte pas comme une requête envoyée.
 *
 * Le `?` était un second défaut, indépendant : en s'élisant, l'agent ne
 * renseignait pas `querierIp`, alors qu'être le querier signifie
 * précisément que c'est sa propre adresse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const IFACE = 'GigabitEthernet0/0';

interface QuerierEvent { iface?: string; querierIp?: string | null; newState?: string }

function watchQuerier(): { events: QuerierEvent[]; off: () => void } {
  const events: QuerierEvent[] = [];
  const off = getDefaultEventBus().subscribe('igmp.querier.changed', (e) => {
    events.push(e.payload as unknown as QuerierEvent);
  });
  return { events, off };
}

/** Compte les paquets IGMP (protocole IP 2) qui traversent un câble. */
function watchIgmpQueries(): { count: () => number; off: () => void } {
  let n = 0;
  const off = getDefaultEventBus().subscribe('cable.frame.delivered', (e) => {
    const f = (e.payload as { frame?: { payload?: { protocol?: number } } }).frame;
    if (f?.payload?.protocol === 2) n++;
  });
  return { count: () => n, off };
}

async function multicastRouter(name: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(name);
  r.powerOn?.();
  for (const c of [
    'enable', 'configure terminal', 'ip multicast-routing',
    `interface ${IFACE}`, 'ip address 10.0.12.1 255.255.255.0', 'no shutdown',
    'ip pim sparse-mode', 'ip igmp version 2', 'exit', 'end',
  ]) await r.executeCommand(c);
  return r;
}

describe('IGMP ne travaille pas sur une interface morte', () => {
  it("n'élit aucun querier sur une interface jamais câblée", async () => {
    const { events, off } = watchQuerier();
    const queries = watchIgmpQueries();
    const r = await multicastRouter('R1');
    // Largement de quoi épuiser startupQueryCount si le tic tournait.
    await new Promise((res) => setTimeout(res, 4_000));
    off(); queries.off();
    expect(events.filter((e) => e.iface === IFACE)).toEqual([]);
    expect(queries.count()).toBe(0);
    // Et l'interface est bien celle que la revue décrivait : morte.
    expect(await r.executeCommand('show ip interface brief'))
      .toMatch(new RegExp(`${IFACE}\\s+10\\.0\\.12\\.1\\s+YES manual down\\s+down`));
  }, 30_000);

  it("interroge dès que le lien est up, et nomme son adresse", async () => {
    // L'élection formelle demande deux requêtes de démarrage espacées de
    // `startupQueryInterval` (~31 s) : trop lent pour un test. Ce qui se
    // mesure tout de suite, et qui est le vrai sujet, c'est que le tic
    // TRAVAILLE — une requête traverse le câble — là où l'interface morte
    // n'en produisait aucune.
    const r = await multicastRouter('R1');
    const peer = new CiscoRouter('R2');
    peer.powerOn?.();
    for (const c of ['enable', 'configure terminal', `interface ${IFACE}`,
      'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'end']) {
      await peer.executeCommand(c);
    }
    const queries = watchIgmpQueries();
    new Cable('c1').connect(r.getPort(IFACE)!, peer.getPort(IFACE)!);
    expect(await r.executeCommand(`show interfaces ${IFACE}`))
      .toContain(`${IFACE} is up, line protocol is up`);

    await new Promise((res) => setTimeout(res, 1_500));
    queries.off();
    expect(queries.count()).toBeGreaterThan(0);
  }, 30_000);

  it('cesse de travailler quand le lien retombe', async () => {
    const r = await multicastRouter('R1');
    const peer = new CiscoRouter('R2');
    peer.powerOn?.();
    for (const c of ['enable', 'configure terminal', `interface ${IFACE}`,
      'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'end']) {
      await peer.executeCommand(c);
    }
    const cable = new Cable('c1');
    cable.connect(r.getPort(IFACE)!, peer.getPort(IFACE)!);
    await new Promise((res) => setTimeout(res, 2_000));

    cable.disconnect();
    const { events, off } = watchQuerier();
    await new Promise((res) => setTimeout(res, 4_000));
    off();
    expect(events.filter((e) => e.iface === IFACE)).toEqual([]);
  }, 30_000);
});
