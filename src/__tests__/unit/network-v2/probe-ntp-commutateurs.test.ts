/**
 * Un commutateur de niveau 3 se synchronise, et sert l'heure.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `Switch` n'instanciait AUCUN `NtpAgent`. Tout le chantier NTP — onze
 * lots — ne concernait donc que les routeurs et les machines, alors
 * qu'un Catalyst ou un S5700 se synchronisent parfaitement.
 *
 * Et la CLI, elle, existait des deux cotes : `ntp server` etait accepte
 * sur le Catalyst (il vient de `CiscoShellBase`, que son shell etend) et
 * `ntp-service unicast-server` sur le Huawei. Le defaut n'etait donc pas
 * une commande absente mais **une commande acceptee dont rien ne
 * temoignait** : `show ntp status` repondait
 * `Clock is unsynchronized, stratum 16, no reference clock` — une
 * constante, puisque le rendu ne trouvait aucun agent a lire — et
 * `display ntp-service status` faisait de meme. Un affichage qui atteste
 * un etat que rien ne mesure, ce que ce depot referme partout.
 *
 * ── La decision qui compte ──────────────────────────────────────────
 *
 * C'est le MEME moteur que le routeur, pas un second : un simulateur
 * avec deux moteurs NTP finirait par donner deux reponses a la meme
 * question, facture que ce depot a deja payee ailleurs.
 *
 * Ce qu'il fallait ajouter est l'HOTE : `NtpAgent` ne cherche pas ses
 * ports par nom, il PARCOURT `getPorts()` a la recherche d'une interface
 * qui porte une adresse pour decider par ou sortir — or les ports
 * physiques d'un commutateur n'en portent aucune, c'est le Vlanif qui la
 * porte. `makeSwitchNtpHost` expose donc les SVI comme des ports, et il
 * est DISTINCT de l'hote FHRP : celui-la a besoin des ports physiques
 * (il y suit les liens), fondre les deux casserait l'un des deux.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Un routeur `ntp master` et un Catalyst client, sur un vrai cable. */
async function labCisco(confSw: string[] = ['ntp server 10.0.0.1']) {
  const r = new CiscoRouter(`R${++serie}`);
  const s = new CiscoSwitch('switch-cisco', `S${serie}`, 24, 0, 0);
  new Cable(`n${serie}`).connect(
    r.getPort('GigabitEthernet0/0')!, s.getPort('FastEthernet0/1')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', 'end']) await r.executeCommand(c);
  for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit',
    'interface FastEthernet0/1', 'switchport mode access',
    'switchport access vlan 10', 'exit',
    'interface Vlan10', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    ...confSw, 'end']) await s.executeCommand(c);
  return { r, s };
}

/** Le meme, cote VRP. */
async function labHuawei(confSw: string[] = ['ntp-service unicast-server 10.0.0.1']) {
  const r = new HuaweiRouter(`HR${++serie}`);
  const s = new HuaweiSwitch('switch-huawei', `HS${serie}`, 8, 0, 0);
  new Cable(`m${serie}`).connect(
    r.getPort('GE0/0/0')!, s.getPort('GigabitEthernet0/0/1')!);
  for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
    'ip address 10.0.0.1 255.255.255.0', 'undo shutdown', 'quit',
    'ntp-service refclock-master 2', 'return']) await r.executeCommand(c);
  for (const c of ['system-view', 'vlan batch 10',
    'interface GigabitEthernet0/0/1', 'port link-type access',
    'port default vlan 10', 'quit',
    'interface Vlanif10', 'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
    ...confSw, 'return']) await s.executeCommand(c);
  return { r, s };
}

describe('le commutateur a un agent NTP, et c\'est le MEME moteur', () => {
  it('Cisco : `getNtpAgent()` existe et rend un `NtpAgent`', () => {
    const s = new CiscoSwitch('switch-cisco', `A${++serie}`, 24, 0, 0);
    expect(s.getNtpAgent().constructor.name).toBe('NtpAgent');
  });

  it('Huawei : idem', () => {
    const s = new HuaweiSwitch('switch-huawei', `B${++serie}`, 8, 0, 0);
    expect(s.getNtpAgent().constructor.name).toBe('NtpAgent');
  });

  it('l\'agent voit les SVI comme des interfaces adressees', async () => {
    // C'est la condition pour qu'il trouve par ou sortir : les ports
    // physiques d'un commutateur ne portent pas d'adresse.
    const { s } = await labCisco([]);
    const a = s.getNtpAgent();
    a.addServer('10.0.0.1');
    expect(a.getConfig().associations.has('10.0.0.1')).toBe(true);
  });
});

describe('Cisco : un Catalyst se synchronise pour de vrai', () => {
  it('`show ntp status` annonce la strate ET la reference', async () => {
    // Il rendait une CONSTANTE — « unsynchronized, stratum 16 » — faute
    // d'agent a lire, quelle que soit la configuration.
    const { s } = await labCisco();
    const out = await s.executeCommand('show ntp status');
    expect(out).toMatch(/^Clock is synchronized, stratum 3, reference is 10\.0\.0\.1/);
  });

  it('`show ntp associations` liste le serveur, pointe et joignable', async () => {
    const { s } = await labCisco();
    const out = await s.executeCommand('show ntp associations');
    const ligne = out.split('\n').find((l) => l.includes('10.0.0.1'));
    expect(ligne).toBeDefined();
    // `*` : c'est la source retenue ; `2` : la strate du serveur.
    expect(ligne!.trimStart().startsWith('*')).toBe(true);
    expect(ligne).toMatch(/\s2\s/);
  });

  it('sans serveur configure, il reste non synchronise — le temoin', async () => {
    // Sans ce cas, un « synchronise » obtenu par accident serait
    // indiscernable d'un moteur qui repond toujours la meme chose.
    const { s } = await labCisco([]);
    expect(await s.executeCommand('show ntp status'))
      .toContain('Clock is unsynchronized');
  });

  it('un Catalyst peut lui-meme SERVIR l\'heure (`ntp master`)', async () => {
    const s = new CiscoSwitch('switch-cisco', `M${++serie}`, 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.0.9 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 4', 'end']) await s.executeCommand(c);
    expect(await s.executeCommand('show ntp status')).toMatch(/stratum 4/);
  });
});

describe('Huawei : un commutateur VRP se synchronise aussi', () => {
  it('`display ntp-service status` annonce l\'horloge synchronisee', async () => {
    const { s } = await labHuawei();
    const out = await s.executeCommand('display ntp-service status');
    // La capitalisation est celle du VRAI rendu VRP (lot N2) ; mes
    // premieres assertions recopiaient la CONSTANTE d'avant, en
    // minuscules — c'etait le format invente qui deteignait sur le test.
    expect(out).toContain('Clock status: synchronized');
    expect(out).toMatch(/Clock stratum: 3/);
  });

  it('`display ntp-service sessions` montre la source', async () => {
    const { s } = await labHuawei();
    expect(await s.executeCommand('display ntp-service sessions'))
      .toContain('10.0.0.1');
  });

  it('sans serveur, l\'horloge reste non synchronisee — le temoin', async () => {
    const { s } = await labHuawei([]);
    expect(await s.executeCommand('display ntp-service status'))
      .toContain('Clock status: unsynchronized');
  });
});

describe('les deux plateformes lisent le MEME agent', () => {
  it('la strate rendue par la vue est celle que porte l\'agent', async () => {
    // La propriete qui compte : la vue n'a pas sa propre verite. Sans
    // elle, un affichage juste pourrait etre une coincidence.
    const { s } = await labCisco();
    expect(s.getNtpAgent().getStratum()).toBe(3);
    expect(await s.executeCommand('show ntp status')).toContain('stratum 3');
  });

  it('les compteurs de paquets du commutateur mesurent', async () => {
    const { s } = await labCisco();
    const c = s.getNtpAgent().getCounters();
    expect(c.sent).toBeGreaterThan(0);
    expect(c.received).toBeGreaterThan(0);
    expect(c.received).toBe(c.processed + c.dropped);
  });
});
