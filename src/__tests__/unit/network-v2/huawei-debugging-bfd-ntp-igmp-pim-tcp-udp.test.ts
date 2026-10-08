/*
 * `debugging bfd all`, `debugging ntp-service all`, `debugging igmp all`,
 * `debugging pim all`, `debugging tcp packet`, `debugging udp packet`,
 * `debugging bgp update` :
 * six modules VRP que le catalogue ne connaissait pas (`Error: Unrecognized
 * command`).
 *
 * Chaque categorie n'entre au catalogue que parce qu'un EMETTEUR existe :
 * BFD, NTP, IGMP et PIM publient deja leurs paquets et leurs changements
 * d'etat sur le bus de la machine, que le service de debug traduit en
 * lignes ; TCP et UDP lisent le meme fil que `debugging ip packet`. Le
 * texte des lignes est derive des charges utiles des evenements : il n'est
 * PAS atteste par une capture VRP, et l'ecriture `bfd all` /
 * `ntp-service all` / `igmp all` / `pim all` n'est pas verifiee non plus
 * contre la documentation Huawei (inaccessible d'ici).
 *
 * Avant le correctif : 6 des 9 cas tombent (git stash de src/network).
 * Passent des deux cotes le TEMOIN « un evenement BFD sans drapeau ne
 * trace rien », qui prouve que le laboratoire publie bien sur le bus et
 * que le silence vient du drapeau ; « un evenement d un autre equipement
 * est ignore » et « undo debugging bfd all eteint le drapeau », vides des
 * deux cotes (la commande etait refusee avant) : ils ne valent que contre
 * les cas positifs du meme laboratoire. Les lignes TCP/UDP lues sur le fil
 * ne sont pas pinnees ici : seule l'acceptation et le listage le sont.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

describe('debugging bfd/ntp/igmp/pim/tcp/udp', () => {
  let bus: EventBus;
  let router: HuaweiRouter;
  let session: HuaweiTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    router = new HuaweiRouter('R1');
    router.setEventBus(bus);
    session = manager.getSession(manager.openTerminal(router)!) as HuaweiTerminalSession;
    for (let i = 0; i < 30 && session.isBooting; i++) await new Promise((r) => setTimeout(r, 50));
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  const publish = (topic: string, payload: object): void => {
    bus.publish({ topic, payload: { deviceId: router.id, hostname: 'R1', ...payload } } as unknown as DomainEvent);
  };

  const shown = (needle: string): boolean => session.lines.some((l) => l.text.includes(needle));

  const bfdChange = (): void => publish('bfd.session.changed', {
    iface: 'GigabitEthernet0/0/0', neighborIp: '10.0.0.2', oldState: 'Init', newState: 'Up',
    diagnostic: 'none', reason: 'peer',
  });

  it('WITNESS : un evenement BFD sans drapeau ne trace rien', async () => {
    await type('terminal debugging');
    bfdChange();
    await flush();
    expect(shown('BFD:')).toBe(false);
  });

  it('debugging bfd all trace un changement de session', async () => {
    await type('debugging bfd all');
    await type('terminal debugging');
    bfdChange();
    await flush();
    expect(shown('BFD: Session with 10.0.0.2')).toBe(true);
    expect(shown('Init -> Up')).toBe(true);
  });

  it('debugging ntp-service all trace une synchronisation', async () => {
    await type('debugging ntp-service all');
    await type('terminal debugging');
    publish('ntp.synced', { serverIp: '10.0.0.9', offsetMs: 3, delayMs: 1, newStratum: 3 });
    await flush();
    expect(shown('NTP: Clock synchronized to 10.0.0.9')).toBe(true);
  });

  it('debugging igmp all trace une adhesion de groupe', async () => {
    await type('debugging igmp all');
    await type('terminal debugging');
    publish('igmp.group.joined', { iface: 'GigabitEthernet0/0/0', groupAddress: '239.1.1.1', reporterIp: '10.0.0.5' });
    await flush();
    expect(shown('IGMP: Group 239.1.1.1 joined')).toBe(true);
  });

  it('debugging pim all trace un voisin ajoute', async () => {
    await type('debugging pim all');
    await type('terminal debugging');
    publish('pim.neighbor.added', { iface: 'GigabitEthernet0/0/0', neighborIp: '10.0.0.3', drPriority: 1, generationId: 7 });
    await flush();
    expect(shown('PIM: Neighbor 10.0.0.3 added')).toBe(true);
  });

  it('debugging bgp update trace une annonce et un retrait', async () => {
    await type('debugging bgp update');
    await type('terminal debugging');
    const update = { neighborIp: '10.0.0.2', origin: 'igp', asPath: [65002], nextHop: '10.0.0.2', med: null, localPref: null };
    publish('bgp.update.received', { ...update, announced: ['192.0.2.1/32'], withdrawn: [] });
    publish('bgp.update.sent', { ...update, announced: [], withdrawn: ['198.51.100.0/24'] });
    await flush();
    expect(shown('BGP: Receive UPDATE 192.0.2.1/32 from peer 10.0.0.2')).toBe(true);
    expect(shown('BGP: Send withdrawal 198.51.100.0/24 to peer 10.0.0.2')).toBe(true);
  });

  it('un evenement d un autre equipement est ignore', async () => {
    await type('debugging bfd all');
    await type('terminal debugging');
    bus.publish({
      topic: 'bfd.session.changed',
      payload: { deviceId: 'other', hostname: 'X', iface: 'GigabitEthernet0/0/0', neighborIp: '10.9.9.9',
        oldState: 'Down', newState: 'Up', diagnostic: 'none', reason: 'peer' },
    } as unknown as DomainEvent);
    await flush();
    expect(shown('10.9.9.9')).toBe(false);
  });

  it('debugging tcp packet et udp packet sont acceptes et listes', async () => {
    await type('debugging tcp packet');
    await type('debugging udp packet');
    await type('display debugging');
    expect(shown('TCP packet debugging is on')).toBe(true);
    expect(shown('UDP packet debugging is on')).toBe(true);
  });

  it('undo debugging bfd all eteint le drapeau', async () => {
    await type('debugging bfd all');
    await type('undo debugging bfd all');
    await type('terminal debugging');
    bfdChange();
    await flush();
    expect(shown('BFD:')).toBe(false);
  });
});
