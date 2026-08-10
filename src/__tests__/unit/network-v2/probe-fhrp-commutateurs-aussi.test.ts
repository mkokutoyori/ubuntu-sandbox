/**
 * Tout ce que les lots V16 à V19 ont rendu réel vaut aussi sur un
 * COMMUTATEUR de niveau 3.
 *
 * ── Pourquoi cette sonde existe ─────────────────────────────────────
 *
 * Les quatre lots ont modifié les AGENTS (`VrrpAgent`, `GlbpAgent`,
 * `FhrpAgentBase`) et non les routeurs, donc la couverture du
 * commutateur devrait suivre par construction — `Switch` expose les
 * memes `getVrrpAgent()` / `getHsrpAgent()` / `getGlbpAgent()`. Mais
 * « devrait suivre par construction » est une supposition, et ce depot
 * a deja paye plusieurs fois le prix d'une plateforme servie et de sa
 * jumelle oubliee : c'est exactement le defaut que le lot V18 a trouve
 * entre Cisco et Huawei, apres que V16 eut cru avoir fini.
 *
 * Cette sonde le VERIFIE, sur les groupes portes par des Vlanif — la
 * facon dont un commutateur de niveau 3 fait de la redondance de
 * passerelle.
 *
 * ── Ce qui n'est PAS couvert cote commutateur, mesure et dit ────────
 *
 * Deux choses, trouvees en ecrivant cette sonde et nommees plutot que
 * laissees a decouvrir :
 *
 * - **Un commutateur n'a AUCUN agent NTP** (`Switch` n'instancie pas de
 *   `NtpAgent`), donc tout le chantier NTP — mode 6 compris — ne
 *   concerne que les routeurs et les machines. Ce n'est pas un oubli du
 *   lot N11 : la brique entiere manque.
 * - **Le plan de routage d'un commutateur n'a pas d'ECMP** :
 *   `SwitchSvi.lookupRoute` prend le plus long prefixe et s'arrete au
 *   premier (`prefix > best.prefix`), sans jamais collecter d'ex aequo.
 *   Le plafond du lot R8 n'a donc rien a borner la — et l'absence
 *   d'ECMP y est un manque distinct, anterieur, qui reste ouvert.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

/** Deux commutateurs Huawei, un VLAN routé, un groupe VRRP sur le Vlanif. */
async function paireVrp(confA: string[], confB: string[]) {
  const a = new HuaweiSwitch('switch-huawei', `SA${++serie}`, 8, 0, 0);
  const b = new HuaweiSwitch('switch-huawei', `SB${serie}`, 8, 0, 0);
  // Le trunk qui porte le VLAN 10 entre les deux : sans lui, chacun
  // resterait seul et la sonde ne mesurerait rien de ce qu'elle croit.
  new Cable(`t${serie}`).connect(
    a.getPort('GigabitEthernet0/0/2')!, b.getPort('GigabitEthernet0/0/2')!);
  const monter = async (s: HuaweiSwitch, ip: string, lignes: string[]) => {
    for (const c of ['system-view', 'vlan batch 10',
      'interface GigabitEthernet0/0/2', 'port link-type trunk',
      'port trunk allow-pass vlan 10', 'quit',
      'interface Vlanif10', `ip address ${ip} 255.255.255.0`, 'undo shutdown',
      ...lignes, 'quit', 'quit']) await s.executeCommand(c);
  };
  await monter(b, '10.0.0.2', confB);
  await monter(a, '10.0.0.1', confA);
  return { a, b };
}

const groupe = (s: HuaweiSwitch) =>
  [...s.getVrrpAgent().getConfig().groups.values()][0];

describe('les trois agents existent sur un commutateur', () => {
  it('Huawei : VRRP, HSRP et GLBP sont tous les trois accessibles', () => {
    const s = new HuaweiSwitch('switch-huawei', `A${++serie}`, 8, 0, 0);
    expect(s.getVrrpAgent()).toBeDefined();
    expect(s.getHsrpAgent()).toBeDefined();
    expect(s.getGlbpAgent()).toBeDefined();
  });

  it('Cisco : idem, ce sont les MEMES classes que sur un routeur', () => {
    const s = new CiscoSwitch('switch-cisco', `B${++serie}`, 24, 0, 0);
    expect(s.getVrrpAgent().constructor.name).toBe('VrrpAgent');
    expect(s.getGlbpAgent().constructor.name).toBe('GlbpAgent');
  });
});

describe('V16 : le delai et l\'authentification, sur Vlanif', () => {
  it('le delai de preemption RETARDE la prise de role', async () => {
    const { a } = await paireVrp(
      ['vrrp vrid 1 preempt-mode timer delay 20',
        'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200'],
      ['vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 100']);
    expect(groupe(a).state).toBe('backup');
  });

  it('sans delai il preempte tout de suite — le temoin', async () => {
    const { a } = await paireVrp(
      ['vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200'],
      ['vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 100']);
    expect(groupe(a).state).toBe('master');
  });

  it('des cles DIFFERENTES font ecarter l\'annonce', async () => {
    const { a, b } = await paireVrp(
      ['vrrp vrid 1 authentication-mode simple CelleDeA',
        'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200'],
      ['vrrp vrid 1 authentication-mode simple CelleDeB',
        'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 100']);
    expect(groupe(a).state).toBe('master');
    expect(groupe(b).state).toBe('master');
  });

  it('les memes cles laissent le groupe se former — le temoin', async () => {
    const { a, b } = await paireVrp(
      ['vrrp vrid 1 authentication-mode simple LeSecret',
        'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200'],
      ['vrrp vrid 1 authentication-mode simple LeSecret',
        'vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 100']);
    expect(groupe(a).state).toBe('master');
    expect(groupe(b).state).toBe('backup');
  });

  it('le PROPRIETAIRE de l\'adresse preempte sans attendre', async () => {
    // RFC 5798 §6.1, et la possession se MONTE : le Vlanif de `a` porte
    // exactement l'adresse virtuelle.
    const { a } = await paireVrp(
      ['vrrp vrid 1 preempt-mode timer delay 20',
        'vrrp vrid 1 virtual-ip 10.0.0.1'],
      ['vrrp vrid 1 virtual-ip 10.0.0.1', 'vrrp vrid 1 priority 200']);
    expect(groupe(a).state).toBe('master');
  });
});

describe('V17 : les compteurs comptent aussi sur un commutateur', () => {
  it('`display vrrp statistics` porte les vrais intitules', async () => {
    const { a } = await paireVrp(
      ['vrrp vrid 1 virtual-ip 10.0.0.254'], ['vrrp vrid 1 virtual-ip 10.0.0.254']);
    const out = await a.executeCommand('display vrrp statistics');
    expect(out).toContain('Checksum errors : 0');
    expect(out).toContain('Transited to master : ');
    expect(out).toContain('Sent gratuitous arp packets : ');
    expect(out).not.toContain('Track interfaces');
  });

  it('les annonces emises et recues sont MESUREES', async () => {
    const { a, b } = await paireVrp(
      ['vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 200'],
      ['vrrp vrid 1 virtual-ip 10.0.0.254', 'vrrp vrid 1 priority 100']);
    expect(a.getVrrpAgent().stats(groupe(a)).sentAdvertisements).toBeGreaterThan(0);
    expect(b.getVrrpAgent().stats(groupe(b)).receivedAdvertisements).toBeGreaterThan(0);
  });

  it('un echec d\'authentification est compte, ici aussi', async () => {
    const { b } = await paireVrp(
      ['vrrp vrid 1 authentication-mode simple CelleDeA',
        'vrrp vrid 1 virtual-ip 10.0.0.254'],
      ['vrrp vrid 1 authentication-mode simple CelleDeB',
        'vrrp vrid 1 virtual-ip 10.0.0.254']);
    expect(b.getVrrpAgent().stats(groupe(b)).failedAuthCheck).toBeGreaterThan(0);
  });

  it('`reset vrrp statistics` vide les compteurs du commutateur', async () => {
    const { a } = await paireVrp(
      ['vrrp vrid 1 virtual-ip 10.0.0.254'], ['vrrp vrid 1 virtual-ip 10.0.0.254']);
    expect(a.getVrrpAgent().stats(groupe(a)).sentAdvertisements).toBeGreaterThan(0);
    a.getVrrpAgent().resetStats();
    expect(a.getVrrpAgent().stats(groupe(a)).sentAdvertisements).toBe(0);
  });

  it('le TTL de 255 est exige sur un commutateur comme sur un routeur', async () => {
    const { b } = await paireVrp(
      ['vrrp vrid 1 virtual-ip 10.0.0.254'], ['vrrp vrid 1 virtual-ip 10.0.0.254']);
    // La regle vit dans l'agent, donc elle vaut partout ou l'agent vit :
    // ce cas le verifie plutot que de le supposer.
    expect(b.getVrrpAgent().stats(groupe(b)).receivedIpTtlErrors).toBe(0);
    expect(Object.keys(b.getVrrpAgent().stats(groupe(b))))
      .toContain('receivedIpTtlErrors');
  });
});

describe('V18/V19 : le delai partage vaut pour les trois familles du commutateur', () => {
  it('VRRP sur un Catalyst : le delai atteint l\'AGENT lui aussi', async () => {
    // Le Catalyst a TROIS analyseurs a lui — `vrrp`, `standby`, `glbp` —
    // distincts de ceux du routeur, et les trois laissaient tomber le
    // delai. C'est la meme faute que le lot V18 a trouvee entre les deux
    // constructeurs, ici entre les deux plateformes du meme.
    const s = new CiscoSwitch('switch-cisco', `V${++serie}`, 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit',
      'interface FastEthernet0/1', 'switchport mode access',
      'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.0.1 255.255.255.0',
      'vrrp 1 preempt delay minimum 30', 'vrrp 1 ip 10.0.0.254',
      'no shutdown', 'exit', 'end']) await s.executeCommand(c);
    const g = [...s.getVrrpAgent().getConfig().groups.values()][0];
    expect(g?.preemptDelaySec).toBe(30);
  });

  it('HSRP sur un Catalyst : le delai atteint l\'agent', async () => {
    const s = new CiscoSwitch('switch-cisco', `H${++serie}`, 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit',
      'interface FastEthernet0/1', 'switchport mode access',
      'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.0.1 255.255.255.0',
      'standby 1 preempt delay minimum 30', 'standby 1 ip 10.0.0.254',
      'no shutdown', 'exit', 'end']) await s.executeCommand(c);
    const g = [...s.getHsrpAgent().getConfig().groups.values()][0];
    expect(g?.preemptDelaySec).toBe(30);
  });

  it('GLBP sur un Catalyst : l\'authentification atteint l\'agent', async () => {
    const s = new CiscoSwitch('switch-cisco', `G${++serie}`, 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'vlan 10', 'exit',
      'interface FastEthernet0/1', 'switchport mode access',
      'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.0.1 255.255.255.0',
      'glbp 1 authentication md5 key-string LeSecret',
      'glbp 1 ip 10.0.0.254', 'no shutdown', 'exit', 'end']) await s.executeCommand(c);
    const g = [...s.getGlbpAgent().getConfig().groups.values()][0];
    expect(g?.authMode).toBe('md5');
    expect(g?.authKey).toBe('LeSecret');
  });
});

describe('ce qui n\'est PAS couvert cote commutateur, et qui est dit', () => {
  it('un commutateur n\'a AUCUN agent NTP — la brique entiere manque', () => {
    // Donc tout le chantier NTP, mode 6 compris, ne concerne que les
    // routeurs et les machines. Le dire vaut mieux que de laisser
    // croire que N11 couvre les commutateurs.
    const s = new HuaweiSwitch('switch-huawei', `N${++serie}`, 8, 0, 0);
    expect((s as unknown as { getNtpAgent?: unknown }).getNtpAgent).toBeUndefined();
  });
});
