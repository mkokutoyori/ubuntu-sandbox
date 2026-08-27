/**
 * Un pare-feu ROUTE n'accepte que ce qui lui est adresse — phase 2 du
 * BRD du modele TCP/IP, increment 3.
 *
 * MESURE DE DEPART, prise avant d'ecrire une ligne : `Firewall.handleFrame`
 * n'a AUCUN filtre de couche lien. Une trame IPv4 portant une adresse de
 * destination etrangere (`02:99:99:99:99:99`), injectee sur `port2` d'un
 * pare-feu en mode `nat`, est traitee entierement — `recentTraces()` passe
 * de 1 a 2 exactement comme en mode `transparent`. Les deux modes
 * repondaient donc la meme chose a une question dont ils sont la
 * difference.
 *
 * POURQUOI CE N'ETAIT PAS UNE DEDUPLICATION DE LA PHASE 1 : il n'y avait
 * rien a dedupliquer, le pare-feu n'ecrivant pas la regle du tout. Donner
 * la regle CHANGE un comportement, ce que le contrat de la phase 1
 * interdit (§4.1), et la decision depend du MODE de l'interface —
 * c'est-a-dire de la question « livrer ici ou faire suivre » que la phase
 * 2 deplace dans la couche. Le BRD l'avait rattachee ici pour cette
 * raison.
 *
 * CE QUI EST REUTILISE PLUTOT QUE REECRIT : `classifyDestination` de
 * `layers/link/LinkLayer.ts`, qui porte deja la regle (diffusion, groupe,
 * soi, autrui) et son echappatoire promiscuous. Un second filtre MAC
 * ecrit ici aurait ete la duplication que ce chantier existe pour fermer.
 *
 * L'ATTESTATION : en mode transparent un VDOM est un pont de niveau 2 qui
 * achemine sur l'adresse MAC de destination — il DOIT donc accepter ce
 * qui ne lui est pas adresse, sinon il n'a rien a ponter. En mode
 * nat/route, chaque interface est de niveau 3 et sa table ARP ne sert
 * qu'a ses propres communications. La regle n'est pas propre a Fortinet :
 * c'est le filtre d'une carte reseau non promiscuous.
 *
 * DISCRIMINATION (`git stash` sur `Firewall.ts` seul) : 5 cas des 13
 * tombent. Les 8 autres sont nommes plutot que comptes, parce que le
 * defaut de depart etait une ABSENCE — rien n'etait filtre, aucune
 * adresse ne changeait — donc seuls les cas qui observent un REJET ou un
 * CHANGEMENT peuvent tomber :
 *  - les deux TEMOINS du mode transparent prouvent que le pont reste un
 *    pont ; sans eux, tout jeter passerait la sonde.
 *  - diffusion, groupe et adresse propre en mode nat gardent que le
 *    filtre ne jette ni l'ARP, ni le DHCP, ni le battement de coeur HA
 *    (diffuse), ni la decouverte de voisins IPv6 (groupe), ni le trafic
 *    normal.
 *  - le port promiscuous garde l'echappatoire du renifleur.
 *  - « les interfaces de battement gardent leur adresse permanente » et
 *    « quitter la grappe rend son adresse permanente » passaient
 *    d'avance, aucune adresse ne bougeant jamais ; ils gardent les deux
 *    exceptions de la formule, sans lesquelles la coller partout
 *    passerait la sonde.
 * Sans ces huit, le correctif le plus simple qui passe la sonde est
 * `return` en tete de `handleFrame`.
 *
 * CE QUE LE FILTRE A REVELE, et qui est un SECOND defaut independant :
 * `tuto-fortigate-tp21` est passe au rouge sur « le trafic REPREND par
 * l'esclave devenu primaire ». La cause n'est pas le filtre. Une grappe
 * FGCP donne a ses interfaces une adresse MAC VIRTUELLE partagee — c'est
 * ce qui rend un basculement invisible au voisinage, dont le cache ARP
 * reste valide — et ce simulateur n'en avait aucune : chaque unite
 * gardait la sienne, si bien que le basculement ne « marchait » que
 * parce que RIEN ne verifiait l'adresse de destination. Encore la meme
 * forme : une valeur affichee que rien ne controle reste fausse tant que
 * quelque chose ne la controle pas.
 *
 * La formule est celle de Fortinet et non une invention :
 * `00:09:0f:09:<group-id % 256>:<vcluster + index>`, vcluster 1 valant
 * 0x00 et l'index partant de 0 sur la premiere interface. Le prefixe
 * `00:09:0f:09` couvre les identifiants 0-255, et le schema de ce depot
 * borne `set group-id` a 0-255 : ecrire les trois autres prefixes
 * documentes rangerait des constantes qu'aucune configuration ne peut
 * atteindre. **Les interfaces de battement de coeur gardent leur adresse
 * permanente**, ce que Fortinet ecrit explicitement — comme les
 * interfaces de gestion reservees, que ce depot ne modelise pas.
 *
 * ET UN TROISIEME, revele par le second : une fois l'adresse virtuelle
 * PARTAGEE, le secondaire emettait des sollicitations de voisin IPv6 sur
 * ses interfaces de donnees, source de cette meme adresse — donc le
 * commutateur voisin reapprenait l'adresse virtuelle sur le port du
 * SECONDAIRE et la moitie du trafic y mourait. Sur une vraie grappe a-p,
 * un subordonne n'emet pas sur ses interfaces de donnees ; seul le
 * battement de coeur parle. C'est le pendant exact de `forwardsTransit()`,
 * que ce depot avait deja ecrit pour la moitie TRANSIT du meme fait, et
 * la regle vit au seul point d'emission (`sendFrame`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  createIPv4Packet, IP_PROTO_ICMP,
} from '@/network/core/types';
import type { EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(opmode: 'nat' | 'transparent' = 'nat') {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await taper(pc, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
  ]);
  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'next', 'end',
  ]);
  if (opmode === 'transparent') {
    await taper(fgt, ['config system settings', 'set opmode transparent', 'end']);
  }
  return { fgt, pc };
}

function trame(destination: MACAddress): EthernetFrame {
  return {
    srcMAC: new MACAddress('02:aa:bb:cc:dd:ee'),
    dstMAC: destination,
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress('192.168.10.10'), new IPAddress('192.168.20.10'),
      IP_PROTO_ICMP, 64, {}, 28),
  };
}

async function traitees(
  opmode: 'nat' | 'transparent', destination: (fgt: FortiGate) => MACAddress,
): Promise<number> {
  const { fgt } = await laboratoire(opmode);
  const avant = fgt.recentTraces(50).length;
  fgt.getPort('port2')!.receiveFrame(trame(destination(fgt)));
  return fgt.recentTraces(50).length - avant;
}

const ETRANGERE = () => new MACAddress('02:99:99:99:99:99');
const SIENNE = (fgt: FortiGate) => fgt.getPort('port2')!.getMAC();

describe('en mode nat, une interface routee filtre sur l\'adresse MAC', () => {
  it('une trame adressee a quelqu\'un d\'autre n\'est pas traitee', async () => {
    expect(await traitees('nat', ETRANGERE)).toBe(0);
  });

  it('une trame adressee au port EST traitee', async () => {
    expect(await traitees('nat', SIENNE)).toBe(1);
  });

  it('une trame de diffusion est acceptee', async () => {
    expect(await traitees('nat', () => MACAddress.broadcast())).toBe(1);
  });

  it('une trame de groupe est acceptee', async () => {
    expect(await traitees('nat', () => new MACAddress('01:00:5e:00:00:05'))).toBe(1);
  });

  it('un port promiscuous accepte tout, comme un renifleur', async () => {
    const { fgt } = await laboratoire('nat');
    fgt.getPort('port2')!.setPromiscuous(true);
    const avant = fgt.recentTraces(50).length;
    fgt.getPort('port2')!.receiveFrame(trame(ETRANGERE()));
    expect(fgt.recentTraces(50).length - avant).toBe(1);
  });
});

describe('mais un pare-feu TRANSPARENT est un pont, et un pont accepte tout', () => {
  it('la meme trame etrangere est traitee', async () => {
    expect(await traitees('transparent', ETRANGERE)).toBe(1);
  });

  it('et celle qui lui est adressee aussi', async () => {
    expect(await traitees('transparent', SIENNE)).toBe(1);
  });
});

describe('une grappe FGCP partage une adresse MAC virtuelle', () => {
  async function grappe(fgt: FortiGate, priorite: number): Promise<void> {
    await taper(fgt, [
      'config system ha', 'set group-name "CLUSTER"', 'set mode a-p',
      'set password "HALab2026!"', 'set hbdev "port5" 50 "port6" 100',
      `set priority ${priorite}`, 'set monitor "port1" "port2"', 'end',
    ]);
  }

  it('la formule est celle de Fortinet, index par index', async () => {
    const { fgt } = await laboratoire('nat');
    const permanente = fgt.getPort('port1')!.getMAC().toString();
    await grappe(fgt, 200);
    expect(fgt.getPort('port1')!.getMAC().toString()).toBe('00:09:0f:09:00:00');
    expect(fgt.getPort('port2')!.getMAC().toString()).toBe('00:09:0f:09:00:01');
    expect(fgt.getPort('port3')!.getMAC().toString()).toBe('00:09:0f:09:00:02');
    expect(permanente).not.toBe('00:09:0f:09:00:00');
  });

  it('deux membres d\'une meme grappe portent la MEME adresse', async () => {
    const a = (await laboratoire('nat')).fgt;
    const b = (await laboratoire('nat')).fgt;
    await grappe(a, 200); await grappe(b, 100);
    expect(b.getPort('port1')!.getMAC().toString())
      .toBe(a.getPort('port1')!.getMAC().toString());
  });

  it('les interfaces de battement gardent leur adresse permanente', async () => {
    const { fgt } = await laboratoire('nat');
    const permanente = fgt.getPort('port5')!.getMAC().toString();
    await grappe(fgt, 200);
    expect(fgt.getPort('port5')!.getMAC().toString()).toBe(permanente);
    expect(fgt.getPort('port6')!.getMAC().toString())
      .not.toMatch(/^00:09:0f:09/);
  });

  it('quitter la grappe rend son adresse permanente a chaque port', async () => {
    const { fgt } = await laboratoire('nat');
    const permanente = fgt.getPort('port1')!.getMAC().toString();
    await grappe(fgt, 200);
    await taper(fgt, ['config system ha', 'set mode standalone', 'end']);
    expect(fgt.getPort('port1')!.getMAC().toString()).toBe(permanente);
  });

  it('le group-id change l\'avant-dernier octet', async () => {
    const { fgt } = await laboratoire('nat');
    await taper(fgt, [
      'config system ha', 'set mode a-p', 'set group-id 17',
      'set hbdev "port5" 50', 'end',
    ]);
    expect(fgt.getPort('port1')!.getMAC().toString()).toBe('00:09:0f:09:11:00');
  });
});

describe('et un subordonne ne parle pas sur ses interfaces de donnees', () => {
  it('rien ne sort d\'un port de donnees, tout sort du battement', async () => {
    const { fgt } = await laboratoire('nat');
    const pair = new FortiGate('firewall-fortinet', 'FGT-02', 0, 200);
    new Cable('hb').connect(fgt.getPort('port5')!, pair.getPort('port5')!);
    await taper(fgt, [
      'config system ha', 'set mode a-p', 'set hbdev "port5" 50',
      'set priority 100', 'end',
    ]);
    expect(fgt.getHa().role()).toBe('slave');

    const donnees = fgt.getPort('port2')!;
    const battement = fgt.getPort('port5')!;
    const avantDonnees = donnees.getCounters().framesOut;
    const avantBattement = battement.getCounters().framesOut;

    expect(fgt.sendFrame('port2', trame(donnees.getMAC()))).toBe(false);
    fgt.sendFrame('port5', trame(battement.getMAC()));

    expect(donnees.getCounters().framesOut).toBe(avantDonnees);
    expect(battement.getCounters().framesOut).toBeGreaterThan(avantBattement);
  });
});
