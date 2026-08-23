/**
 * RFC 2328 §12.4.2 — un LSA de reseau doit etre VIDANGE des que le
 * routeur qui l'annonce cesse d'etre DR, ou des que le reseau n'a plus
 * qu'un seul routeur attache.
 *
 * Le laboratoire est monte sous une horloge VIRTUELLE : les
 * temporisateurs OSPF sont reels, donc l'expiration de l'intervalle mort
 * — le seul evenement qui fait disparaitre le dernier voisin sans
 * toucher a l'interface du DR — n'est atteignable qu'en avancant le
 * temps.
 *
 * Discrimine par `git stash` d'`OSPFEngine.ts` : 3 des 6 cas tombent.
 * Les 3 qui passent des deux cotes sont nommes ici plutot que laisses a
 * decouvrir — le TEMOIN, dont c'est l'objet ; « le LSA de ROUTEUR reste »,
 * qui mesure ce que le moteur faisait DEJA correctement et qui est la
 * pour qu'une vidange trop large se voie ; et « perdre UN voisin sur
 * deux », qui passe avant correctif parce que le chemin de
 * reannonce, lui, n'a jamais eu de defaut.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { getDefaultEventBus } from '@/events/EventBus';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); Logger.reset();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});
afterEach(() => { __setDefaultScheduler(null); });

const PRIORITES: Record<string, number> = { R1: 255, R2: 1, R3: 1 };

async function routeur(nom: string, ip: string, rid: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    `ip address ${ip} 255.255.255.0`, 'no shutdown',
    `ip ospf priority ${PRIORITES[nom]}`, 'exit', 'router ospf 1',
    `router-id ${rid}`, 'network 192.168.1.0 0.0.0.255 area 0', 'end']) {
    await r.executeCommand(c);
  }
  return r;
}

interface Labo { r1: CiscoRouter; cables: Cable[]; }

async function labo(nombre: number): Promise<Labo> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24);
  const noms = ['R1', 'R2', 'R3'].slice(0, nombre);
  const cables: Cable[] = [];
  const routeurs: CiscoRouter[] = [];
  for (let i = 0; i < noms.length; i++) {
    const r = await routeur(noms[i], `192.168.1.${i + 1}`, `${i + 1}.${i + 1}.${i + 1}.${i + 1}`);
    routeurs.push(r);
    const cable = new Cable(`c${i}`);
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    cables.push(cable);
  }
  return { r1: routeurs[0], cables };
}

const moteur = (r: CiscoRouter) => r.getOspfIntegration().getOSPFEngine();

const tousLesLsa = (r: CiscoRouter) =>
  [...moteur(r).getLSDB().areas.entries()].flatMap(([, m]) => [...m.values()]);

const lsaReseau = (r: CiscoRouter) => tousLesLsa(r).filter(l => l.lsType === 2);

describe('un LSA de reseau ne survit pas au reseau qu il decrit', () => {
  it('TEMOIN — tant que l adjacence tient, le DR annonce le reseau et y liste son voisin', async () => {
    const { r1 } = await labo(2);
    expect(await r1.executeCommand('show ip ospf neighbor')).toContain('2.2.2.2');
    const reseau = lsaReseau(r1);
    expect(reseau).toHaveLength(1);
    expect((reseau[0] as { attachedRouters: string[] }).attachedRouters).toContain('2.2.2.2');
  });

  it('le dernier voisin disparu, le LSA de reseau quitte la base du DR', async () => {
    const { r1, cables } = await labo(2);
    expect(lsaReseau(r1)).toHaveLength(1);

    cables[1].disconnect();
    horloge.advance(45_000);

    expect(await r1.executeCommand('show ip ospf neighbor')).not.toContain('2.2.2.2');
    expect(lsaReseau(r1)).toHaveLength(0);
  });

  it('la vue de la base ne montre plus de reseau de transit', async () => {
    const { r1, cables } = await labo(2);
    cables[1].disconnect();
    horloge.advance(45_000);
    const base = await r1.executeCommand('show ip ospf database');
    expect(base).not.toContain('192.168.1.1     1.1.1.1');
  });

  it('la vidange est ANNONCEE, donc inondee, et non simplement oubliee', async () => {
    const { r1, cables } = await labo(2);
    const vus: { lsType: number }[] = [];
    const stop = getDefaultEventBus().subscribe('ospf.lsa.flushed', (e) => {
      vus.push((e.payload as { lsa: { lsType: number } }).lsa);
    });
    cables[1].disconnect();
    horloge.advance(45_000);
    stop();
    expect(vus.filter(l => l.lsType === 2)).toHaveLength(1);
  });

  it('le LSA de ROUTEUR du DR, lui, est REANNONCE et reste', async () => {
    const { r1, cables } = await labo(2);
    cables[1].disconnect();
    horloge.advance(45_000);
    const propres = tousLesLsa(r1)
      .filter(l => l.lsType === 1 && l.advertisingRouter === '1.1.1.1');
    expect(propres).toHaveLength(1);
  });

  it('perdre UN voisin sur deux reannonce le reseau sans le vidanger', async () => {
    const { r1, cables } = await labo(3);
    expect(lsaReseau(r1)).toHaveLength(1);

    cables[2].disconnect();
    horloge.advance(45_000);

    const reseau = lsaReseau(r1);
    expect(reseau).toHaveLength(1);
    const attaches = (reseau[0] as { attachedRouters: string[] }).attachedRouters;
    expect(attaches).toContain('2.2.2.2');
    expect(attaches).not.toContain('3.3.3.3');
  });
});
