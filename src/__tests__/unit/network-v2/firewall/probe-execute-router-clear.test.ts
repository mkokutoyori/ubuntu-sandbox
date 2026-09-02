/**
 * `execute router clear` coupe de VRAIES sessions de routage.
 *
 * Mesure de depart : toute la famille `execute router` etait absente
 * (`unknown action "router"`), alors que le pare-feu fait tourner de
 * VRAIS moteurs -- un `BGPEngine` qui ouvre des sessions TCP/179 sur le
 * cable, et un `OSPFEngine`. Le BGP savait deja fermer ses pairs en bloc
 * (`disable()`) et lors d'une collision de connexion, mais rien
 * n'exposait la remise a zero DURE que l'operateur commande.
 *
 * `official_docs/forti-cli-ref-60.txt` atteste toute la famille :
 * `clear bgp all`, `clear bgp as`, `clear bgp ip`, `clear bgp ipv6`,
 * `clear bgp external`, `clear bgp dampening`, `clear bgp
 * flap-statistics`, `clear ospf process`, `clear ospf6 process`,
 * `clear bfd session <src> <dst> <iface>`, et `restart`.
 *
 * Ce lot ouvre celles qui portent sur un moteur present : `clear bgp
 * {all | ip | as | external}`, `clear ospf process` et `restart`. Les
 * autres visent des mecanismes que ce simulateur n'a pas -- il n'y a ni
 * amortissement des routes (RFC 2439), ni statistiques de battement, ni
 * BFD sur le pare-feu, ni OSPFv3 : ce ne sont pas des magasins a poser
 * mais des fonctionnalites entieres, et un `clear` sur une chose
 * inexistante ne pourrait rien effacer. Elles sont refusees, et un cas
 * garde que le lot n'a pas ouvert plus de portes qu'il n'a de moteurs.
 *
 * `BGPEngine.resetPeers(predicat)` est ECRIT une fois et sert les quatre
 * portees, plutot qu'une methode par mot-cle : ce que RFC 4271 §8.1.2
 * appelle un « hard clear » est le meme geste dans les quatre cas --
 * fermer la session pour que le pairage retombe en Idle et que le
 * minuteur de reconnexion recompose -- seul le CHOIX des pairs change.
 * Le predicat lit la configuration du voisin, donc `as` et `external`
 * n'ont pas besoin d'un second magasin.
 *
 * UN PIEGE trouve par la mesure, et invisible a la lecture : fermer la
 * session TCP ne suffisait pas. `getNeighbors()` ne lit pas `peers` mais
 * un registre d'adjacences distinct, que `converge()` REDERIVE de
 * `peers`. Sans cet appel la commande rendait un succes et la vue
 * montrait toujours le pairage etabli -- la machine se serait
 * contredite. `resetPeers` converge donc des qu'elle a coupe quelque
 * chose.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 7 cas
 * tombent. Les 2 qui passent des deux cotes sont le TEMOIN, dont c'est
 * l'objet, et « les mecanismes que ce simulateur n'a pas restent
 * REFUSES », qui passe avant correctif POUR UNE RAISON QUI NE PROUVE
 * RIEN -- toute la famille `execute router` etait refusee. Il garde que
 * le lot n'a pas ouvert plus de portes qu'il n'a de moteurs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lignes: string[]): string {
  let dernier = '';
  for (const ligne of lignes) dernier = sh.execute(ligne);
  return dernier;
}

beforeEach(() => { Logger.reset(); });

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const voisin = new CiscoRouter('R1', 200, 0);
  new Cable('transit').connect(
    fw.getPort('port2')!, voisin.getPort('GigabitEthernet0/0')!);

  run(sh, 'config system interface', 'edit "port2"', 'set mode static',
    'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');
  await runOn(voisin, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
    'no shutdown', 'exit', 'end']);
  await runOn(voisin, ['enable', 'configure terminal', 'router bgp 65002',
    'bgp router-id 2.2.2.2', 'neighbor 10.0.0.1 remote-as 65001', 'end']);

  run(sh, 'config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config neighbor', 'edit "10.0.0.2"', 'set remote-as 65002', 'next', 'end', 'end');
  horloge.advance(120_000);
  return { fw, sh, voisin, horloge };
}

const pairsVivants = (fw: FortiGate) =>
  fw.getRouting().getBgp().neighbours().filter(n => n.isUp).length;

describe('FortiGate : execute router clear', () => {
  it('TEMOIN : le pairage BGP s etablit sur le cable', async () => {
    const { fw } = await laboratoire();
    expect(pairsVivants(fw)).toBe(1);
  });

  it('`clear bgp all` coupe le pairage', async () => {
    const { fw, sh } = await laboratoire();
    expect(sh.execute('execute router clear bgp all')).toBe('');
    expect(pairsVivants(fw)).toBe(0);
  });

  it('`clear bgp ip <voisin>` coupe CE pairage', async () => {
    const { fw, sh } = await laboratoire();
    expect(sh.execute('execute router clear bgp ip 10.0.0.2')).toBe('');
    expect(pairsVivants(fw)).toBe(0);
  });

  it('`clear bgp ip` sur une adresse etrangere ne coupe rien et le DIT', async () => {
    const { fw, sh } = await laboratoire();
    expect(sh.execute('execute router clear bgp ip 203.0.113.9'))
      .toContain('no established BGP peering matches ip 203.0.113.9');
    expect(pairsVivants(fw)).toBe(1);
  });

  it('`clear bgp as` choisit par numero d AS', async () => {
    const { fw, sh } = await laboratoire();
    expect(sh.execute('execute router clear bgp as 65002')).toBe('');
    expect(pairsVivants(fw)).toBe(0);
  });

  it('`clear bgp external` coupe les pairages eBGP', async () => {
    const { fw, sh } = await laboratoire();
    expect(sh.execute('execute router clear bgp external')).toBe('');
    expect(pairsVivants(fw)).toBe(0);
  });

  it('BGP arrete refuse la commande au lieu de se taire', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const sh = new FortiShell(new FortiGate('firewall-fortinet', 'SEUL', 0, 0));
    expect(sh.execute('execute router clear bgp all')).toContain('BGP is not running');
    expect(sh.execute('execute router clear ospf process')).toContain('OSPF is not running');
  });

  it('les mecanismes que ce simulateur n a pas restent REFUSES', async () => {
    const { sh } = await laboratoire();
    expect(sh.execute('execute router clear bgp dampening')).toContain('unknown action');
    expect(sh.execute('execute router clear bfd session 1.1.1.1 2.2.2.2 port2'))
      .toContain('unknown action');
    expect(sh.execute('execute router clear ospf6 process')).toContain('unknown action');
  });

  it('l aide nomme les deux operations ouvertes', async () => {
    const { sh } = await laboratoire();
    const mots = sh.help('execute router ')
      .map(l => l.trim().split(/\s{2,}/)[0]).filter(w => !w.startsWith('<') && w !== 'LINE');
    expect(mots).toEqual(['clear', 'restart']);
  });
});
