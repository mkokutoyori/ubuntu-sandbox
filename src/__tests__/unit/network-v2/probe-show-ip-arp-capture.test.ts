/**
 * `show ip arp` compare a sa capture reelle.
 *
 * AUTORITE : `ntc-templates/tests/cisco_ios/show_ip_arp/`, du texte
 * capture sur une vraie machine :
 *
 *   Protocol  Address              Age(min)       Hardware Addr     Type      Interface
 *   Internet  172.16.233.229       -              0000.0c59.f892    ARPA      Ethernet0/0
 *   Internet  172.16.168.254       9              0000.0c36.6965    ARPA      Ethernet0/0
 *
 * GEOMETRIE MESUREE par arithmetique de colonnes : `Protocol` a 0 sur
 * 10, `Address` a 10 sur 21, `Age(min)` a 31 sur 15, `Hardware Addr` a
 * 46 sur 18, `Type` a 64 sur 10, `Interface` a 74. TOUTES a gauche, y
 * compris l'age -- le `-` et le `9` commencent l'un comme l'autre a la
 * colonne 31, ce qu'un alignement a droite ne rendrait pas.
 *
 * DEUX MOTS QUE LA CAPTURE TRANCHE : l'age d'une entree LOCALE (une
 * adresse portee par la machine elle-meme) est un TIRET et non un zero,
 * et l'interface est ecrite EN ENTIER (`Ethernet0/0`), pas abregee.
 *
 * UNE NUANCE, dite plutot que tue : le gabarit
 * `cisco_ios_show_ip_arp.textfsm` accepte `Age\s*\(min\)`, donc
 * `ntc-templates` a vu les DEUX orthographes. La seule sortie REELLE
 * dont on dispose ecrit `Age(min)` sans blanc, et c'est elle qui decide
 * ici -- une transcription capturee passe avant un gabarit permissif.
 * Ce qui n'est en revanche pas une question d'orthographe, c'est que
 * dans notre rendu AUCUNE colonne ne tombait ou la capture la pose.
 *
 * Sonde ecrite AVANT lecture du rendu, contre cette capture seule.
 * L'echange est REEL : le voisin est appris par un `ping` qui met de
 * vraies trames ARP sur le fil, pas par une insertion dans la table.
 *
 * Discrimine par `git stash push -- src/network` : les SIX cas tombent,
 * temoin compris -- et c'est la mesure, pas une exageration : le temoin
 * cherche la ligne du voisin par la position de sa colonne d'adresse, et
 * cette position etait fausse. La vue rendait
 *
 *   Protocol  Address          Age (min)   Hardware Addr   Type   Interface
 *   Internet  10.0.0.2         0           0200.0000.0005    ARPA   Gi...
 *
 * soit un en-tete dont AUCUNE colonne ne tombe ou la capture la pose,
 * `Age (min)` avec un blanc qu'IOS n'ecrit pas, et surtout PAS DE LIGNE
 * pour l'adresse de la machine elle-meme -- un vrai IOS la porte
 * toujours, avec un tiret pour age. C'est cette derniere absence qui
 * compte : `show ip arp` sert d'abord a verifier qu'une interface a bien
 * l'adresse qu'on croit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const ENTETE =
  'Protocol  Address              Age(min)       Hardware Addr     Type      Interface';

type Dev = { executeCommand(c: string): Promise<string> };

async function taper(d: Dev, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

const LOCALE = '10.0.0.1';
const VOISINE = '10.0.0.2';

async function laboratoire(): Promise<CiscoRouter> {
  const a = new CiscoRouter('R1', 0, 0);
  const b = new CiscoRouter('R2', 200, 0);
  new Cable('c').connect(
    a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
  await taper(a, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    `ip address ${LOCALE} 255.255.255.0`, 'no shutdown', 'end']);
  await taper(b, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    `ip address ${VOISINE} 255.255.255.0`, 'no shutdown', 'end']);
  await a.executeCommand(`ping ${VOISINE}`);
  return a;
}

const vue = (r: CiscoRouter): Promise<string> =>
  r.executeCommand('show ip arp').then(String);

function ligne(sortie: string, adresse: string): string {
  return sortie.split('\n').find(l => l.slice(10, 31).trim() === adresse) ?? '';
}

function colonnes(l: string): Record<string, string> {
  return {
    protocol: l.slice(0, 10).trim(),
    address: l.slice(10, 31).trim(),
    age: l.slice(31, 46).trim(),
    mac: l.slice(46, 64).trim(),
    type: l.slice(64, 74).trim(),
    iface: l.slice(74).trim(),
  };
}

describe('show ip arp — la capture decide', () => {
  it('TEMOIN : le voisin est appris par un vrai echange', async () => {
    const r = await laboratoire();
    expect(ligne(await vue(r), VOISINE)).not.toBe('');
  });

  it('l en-tete est CELUI de la capture, caractere pour caractere', async () => {
    const r = await laboratoire();
    expect((await vue(r)).split('\n')[0]).toBe(ENTETE);
  });

  it('l entree LOCALE porte un tiret et non un age', async () => {
    const r = await laboratoire();
    const c = colonnes(ligne(await vue(r), LOCALE));
    expect(c.protocol).toBe('Internet');
    expect(c.age).toBe('-');
    expect(c.type).toBe('ARPA');
  });

  it('l entree APPRISE porte un age en minutes', async () => {
    const r = await laboratoire();
    const c = colonnes(ligne(await vue(r), VOISINE));
    expect(c.age).toMatch(/^\d+$/);
    expect(c.type).toBe('ARPA');
    expect(c.mac).toMatch(/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/);
  });

  it('l interface est ecrite en ENTIER, pas abregee', async () => {
    const r = await laboratoire();
    expect(colonnes(ligne(await vue(r), VOISINE)).iface)
      .toBe('GigabitEthernet0/0');
  });

  it('les colonnes tombent sur les bords de la capture', async () => {
    const r = await laboratoire();
    const l = ligne(await vue(r), VOISINE);
    expect(l.indexOf('Internet')).toBe(0);
    expect(l.indexOf(VOISINE)).toBe(10);
    expect(l.indexOf('ARPA')).toBe(64);
    expect(l.indexOf('GigabitEthernet0/0')).toBe(74);
  });
});
