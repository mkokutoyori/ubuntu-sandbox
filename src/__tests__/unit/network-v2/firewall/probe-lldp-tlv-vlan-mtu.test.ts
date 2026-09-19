/**
 * Les TLV d'organisation de LLDP ne traversaient PAS le fil.
 *
 * Mesure de depart, faite sur deux captures reelles de `ntc-templates` :
 *
 *  - `tests/fortinet/diagnose_lldprx_port_neighbor_details_port-name/`
 *    montre qu'un FortiOS rend, pour un voisin entendu, `vlan.id`,
 *    `vlan.name.count` / `.1.id` / `.1.len` / `.1.data`, `max-frame-size`,
 *    et un bloc d'adresse de gestion en CINQ champs : `address.1.type` /
 *    `.type.txt` / `.len` / `.addr` / `.addr.interface.type` /
 *    `.interface.type.txt` / `.interface.number`.
 *  - `tests/cisco_ios/show_lldp_neighbors_detail/` (9 captures, 19 blocs)
 *    montre que CHAQUE bloc porte `Vlan ID:` et `Auto Negotiation - ...`,
 *    avec les formes attestees `Vlan ID: 1`, `Vlan ID: - not advertised`,
 *    `Auto Negotiation - supported, enabled` et `- not supported`.
 *
 * Notre trame LLDP ne portait aucun de ces TLV : ni le VLAN non etiquete
 * du port emetteur (802.1 sous-type 1), ni le nom du VLAN (802.1
 * sous-type 3), ni la taille maximale de trame (802.3 sous-type 4), ni
 * le numero d'interface de l'adresse de gestion. Les deux vues
 * REPONDAIENT quand meme : le FortiOS taisait les lignes, et la vue IOS
 * poussait QUATRE CONSTANTES (`Auto Negotiation - not supported`,
 * `Physical media capabilities - not advertised`, `Media Attachment Unit
 * type - not advertised`, `Vlan ID: - not advertised`) que rien ne
 * calculait.
 *
 * Discrimine par `git stash push -- src/network` : 12 cas sur 14 tombent
 * avant correctif.
 *
 * Les DEUX qui passent des deux cotes passent pour une raison qu'il faut
 * dire, sans quoi le compte flatterait le lot :
 *  - « le voisin a bien ete entendu » est un TEMOIN, et c'est exactement
 *    ce qu'on lui demande : il prouve que le laboratoire echange de
 *    vraies trames, sans quoi une vue vide ferait passer les absences
 *    pour des reussites.
 *  - « l'adresse de gestion est rendue avec sa famille et sa longueur »
 *    est une NON-REGRESSION : avant correctif ces trois lignes sont des
 *    constantes (`1` / `ipv4` / `4`) et elles tombent juste ; apres, elles
 *    sont LUES de l'adresse, et le cas garde leur forme attestee. Aucun
 *    emetteur ne produisant d'adresse de gestion IPv6, la difference
 *    n'est pas observable depuis cette vue.
 *
 * Un cas a du etre CORRIGE apres coup, et le dire vaut mieux que le
 * taire : il attendait `Auto Negotiation - not supported` d'un port dont
 * on venait de couper la negociation. C'etait une FAUSSE PREMISSE --
 * couper la negociation ne retire pas la capacite au PHY. Les deux bits
 * du TLV disent deux choses differentes, et la vue rend desormais
 * `supported, not enabled` pour cet etat. Cette troisieme forme est
 * DEDUITE des deux que la capture atteste (`- not supported` et
 * `- supported, enabled`) : aucun des 19 blocs captures ne montre un
 * voisin capable mais negociation coupee.
 *
 * Trois limites assumees, nommees plutot que tues :
 *  - le TLV 802.3 MAC/PHY ne porte que ses DEUX BITS de negociation. Sa
 *    partie « capacites PMD annoncees » et son « type de MAU » sont des
 *    tables de mots (IANA MAU-MIB) dont une seule entree est attestee
 *    par la capture FortiOS (`001e` / `1000baseTFD`) ; inventer les
 *    quinze autres serait ecrire un vocabulaire qu'aucune machine ne
 *    rend. `Port` ne modelise d'ailleurs ni jeu de capacites annoncees
 *    ni type de MAU, donc les vues rendent la forme attestee
 *    `Physical media capabilities - not advertised` et `Media Attachment
 *    Unit type - not advertised`.
 *  - les TLV 802.1 « protocol VLAN », 802.3 « link aggregation » et
 *    802.3 « power via MDI » que la capture FortiOS montre ne sont pas
 *    emis : les VLAN par protocole et le PoE ne sont pas modelises, et
 *    le second mot du drapeau d'agregation n'est pas atteste.
 *  - l'adresse de gestion reste IPv4 : `collectAddresses` lit l'adresse
 *    v4 du port. La famille est desormais LUE de l'adresse au lieu
 *    d'etre ecrite en dur, mais aucun emetteur ne produit encore de
 *    `address.N.type: 2`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import {
  VirtualTimeScheduler, __setDefaultScheduler,
} from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

async function taper(d: { executeCommand(c: string): Promise<string> }, lignes: string[]) {
  for (const l of lignes) await d.executeCommand(l);
}

async function receptionSeule(fw: FortiGate) {
  await taper(fw, ['config system global', 'set lldp-reception enable', 'end']);
}

async function laboCommutateur(...interfaceLines: string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT');
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
  new Cable('c').connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);
  await receptionSeule(fw);
  await taper(sw, ['enable', 'configure terminal', 'lldp run',
    'interface FastEthernet0/1', ...interfaceLines, 'end']);
  horloge.advance(31_000);
  return { fw, sw };
}

async function laboRouteur() {
  const fw = new FortiGate('firewall-fortinet', 'FGT');
  const rt = new CiscoRouter('R1', 200, 0);
  new Cable('c').connect(fw.getPort('port1')!, rt.getPort('GigabitEthernet0/0')!);
  await receptionSeule(fw);
  await taper(rt, ['enable', 'configure terminal', 'lldp run',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
    'no shutdown', 'end']);
  horloge.advance(31_000);
  return { fw, rt };
}

const DETAILS = 'diagnose lldprx port neighbor details port1';

describe('LLDP : les TLV d organisation traversent le fil', () => {
  it('TEMOIN : le voisin est bien entendu par le fil', async () => {
    const { fw } = await laboCommutateur();
    expect(await fw.executeCommand(DETAILS)).toContain('1 system.name.data: SW1');
  });

  it('le VLAN non etiquete du port emetteur arrive dans vlan.id', async () => {
    const { fw } = await laboCommutateur();
    expect(await fw.executeCommand(DETAILS)).toContain('1 vlan.id: 1');
  });

  it('changer le VLAN d acces du voisin change vlan.id', async () => {
    const { fw } = await laboCommutateur('switchport mode access',
      'switchport access vlan 20');
    expect(await fw.executeCommand(DETAILS)).toContain('1 vlan.id: 20');
  });

  it('le nom du VLAN traverse le fil avec sa longueur', async () => {
    const { fw } = await laboCommutateur();
    const out = await fw.executeCommand(DETAILS);
    expect(out).toContain('1 vlan.name.count: 1');
    expect(out).toContain('1 vlan.name.1.id: 1');
    expect(out).toContain('1 vlan.name.1.len: 7');
    expect(out).toContain('1 vlan.name.1.data: default');
  });

  it('un VLAN renomme se lit dans la vue du voisin', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    new Cable('c').connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);
    await receptionSeule(fw);
    await taper(sw, ['enable', 'configure terminal', 'lldp run',
      'vlan 20', 'name COMPTA', 'exit',
      'interface FastEthernet0/1', 'switchport mode access',
      'switchport access vlan 20', 'end']);
    horloge.advance(31_000);
    const out = await fw.executeCommand(DETAILS);
    expect(out).toContain('1 vlan.name.1.id: 20');
    expect(out).toContain('1 vlan.name.1.len: 6');
    expect(out).toContain('1 vlan.name.1.data: COMPTA');
  });

  it('un voisin qui n est pas un pont n annonce AUCUN VLAN', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const rt = new CiscoRouter('R1', 200, 0);
    new Cable('c1').connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(fw.getPort('port2')!, rt.getPort('GigabitEthernet0/0')!);
    await receptionSeule(fw);
    await taper(sw, ['enable', 'configure terminal', 'lldp run', 'end']);
    await taper(rt, ['enable', 'configure terminal', 'lldp run', 'end']);
    horloge.advance(31_000);
    const pont = await fw.executeCommand(DETAILS);
    const routeur = await fw.executeCommand('diagnose lldprx port neighbor details port2');
    expect(pont).toContain('1 vlan.id: 1');
    expect(routeur).toContain('1 system.name.data: R1');
    expect(routeur).not.toContain('vlan.id');
    expect(routeur).not.toContain('vlan.name');
  });

  it('max-frame-size vaut le MTU du port emetteur plus l en-tete et le FCS', async () => {
    const { fw } = await laboCommutateur();
    expect(await fw.executeCommand(DETAILS)).toContain('1 max-frame-size: 1518');
  });

  it('changer le MTU du voisin change max-frame-size', async () => {
    const { fw } = await laboCommutateur('mtu 9000');
    expect(await fw.executeCommand(DETAILS)).toContain('1 max-frame-size: 9018');
  });

  it('l adresse de gestion est rendue avec sa famille et sa longueur', async () => {
    const { fw } = await laboRouteur();
    const out = await fw.executeCommand(DETAILS);
    expect(out).toContain('1 address.count: 1');
    expect(out).toContain('1 address.1.type: 1');
    expect(out).toContain('1 address.1.type.txt: ipv4');
    expect(out).toContain('1 address.1.len: 4');
    expect(out).toContain('1 address.1.addr: 10.0.0.2');
  });

  it('l adresse de gestion porte le numero de l interface qui la porte', async () => {
    const { fw } = await laboRouteur();
    const out = await fw.executeCommand(DETAILS);
    expect(out).toContain('1 address.1.addr.interface.type: 2');
    expect(out).toContain('1 address.1.addr.interface.type.txt: if-index');
    expect(out).toContain('1 address.1.addr.interface.number: 1');
  });

  it('un commutateur annonce l adresse de son interface de VLAN', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    new Cable('c').connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);
    await receptionSeule(fw);
    await taper(sw, ['enable', 'configure terminal', 'lldp run',
      'interface Vlan1', 'ip address 10.0.0.3 255.255.255.0', 'no shutdown', 'end']);
    horloge.advance(31_000);
    const out = await fw.executeCommand(DETAILS);
    expect(out).toContain('1 address.count: 1');
    expect(out).toContain('1 address.1.addr: 10.0.0.3');
  });
});

describe('LLDP : la vue IOS rend ce que le voisin a dit, pas des constantes', () => {
  it('un voisin pont donne un Vlan ID, un voisin routeur n en donne pas', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    const fw = new FortiGate('firewall-fortinet', 'FGT');
    new Cable('c1').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(sw1.getPort('FastEthernet0/2')!, fw.getPort('port1')!);
    await taper(fw, ['config system global', 'set lldp-transmission enable', 'end']);
    for (const sw of [sw1, sw2]) {
      await taper(sw, ['enable', 'configure terminal', 'lldp run', 'end']);
    }
    horloge.advance(31_000);
    const out = await sw1.executeCommand('show lldp neighbors detail');
    const blocs = out.split('------------------------------------------------');
    const versSw2 = blocs.find(b => b.includes('SW2'))!;
    const versFgt = blocs.find(b => b.includes('FGT'))!;
    expect(versSw2).toContain('Vlan ID: 1');
    expect(versFgt).toContain('Vlan ID: - not advertised');
  });

  it('la ligne Auto Negotiation suit l etat du port emetteur', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const fw = new FortiGate('firewall-fortinet', 'FGT');
    new Cable('c').connect(sw.getPort('FastEthernet0/1')!, fw.getPort('port1')!);
    await taper(fw, ['config system global', 'set lldp-transmission enable', 'end']);
    await taper(sw, ['enable', 'configure terminal', 'lldp run', 'end']);
    horloge.advance(31_000);
    expect(await sw.executeCommand('show lldp neighbors detail'))
      .toContain('Auto Negotiation - supported, enabled');
    fw.getPort('port1')!.setAutoNegotiation(false);
    horloge.advance(31_000);
    expect(await sw.executeCommand('show lldp neighbors detail'))
      .toContain('Auto Negotiation - supported, not enabled');
  });

  it('le bit de negociation du voisin se lit aussi dans la vue FortiOS', async () => {
    const { fw } = await laboCommutateur();
    expect(await fw.executeCommand(DETAILS)).toContain('1 mac_phy.auto: 3');
    expect(await fw.executeCommand(DETAILS)).toContain('1 mac_phy.auto.txt: supported enabled');
  });
});
