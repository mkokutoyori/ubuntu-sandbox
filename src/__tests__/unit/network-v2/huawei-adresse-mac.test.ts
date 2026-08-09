/**
 * PRD-CLI-Fidelite-VRP.md §23 / lot V14 — une adresse MAC s'ecrit comme
 * VRP l'ecrit, et sa colonne la contient.
 *
 * Le defaut se voyait a l'oeil nu : la MAC etait rendue au format IEEE
 * (`02:00:00:00:00:11`, dix-sept caracteres) dans des colonnes taillees
 * pour QUATORZE, si bien qu'elle debordait et AVALAIT la colonne
 * suivante.
 *
 *     10.0.10.2       02:00:00:00:00:1120        dynamicGigabitEthernet0/0/1
 *     02:00:00:00:00:1110         GigabitEthernet0/0/1dynamic
 *
 * La propriete la plus forte de ce fichier n'est pas le format lui-meme
 * mais le ROUND-TRIP : la machine ACCEPTAIT deja `aaaa-bbbb-cccc` en
 * entree (`arp static`) et ne l'imprimait jamais. Ce qu'elle lit et ce
 * qu'elle rend doivent etre la meme ecriture, ce qui se verifie sans
 * connaitre VRP.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { huaweiMacAddress } from '@/network/devices/shells/huawei/huaweiTableLayouts';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
const MAC_VRP = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const MAC_IEEE = /\b[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}\b/;

/** Un routeur dont la table ARP porte une entree apprise et une statique. */
async function routeurAvecArp() {
  const r = new HuaweiRouter(`AM${++serie}`);
  const pc = new LinuxPC(`PM${++serie}`);
  new Cable(`cm${serie}`).connect(r.getPort('GE0/0/0')!, pc.getPort('eth0')!);
  for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
    'ip address 10.0.12.1 255.255.255.0', 'undo shutdown', 'quit',
    'arp static 192.168.1.50 aaaa-bbbb-cccc', 'quit']) await r.executeCommand(c);
  await pc.executeCommand('ip addr add 10.0.12.2/24 dev eth0');
  await pc.executeCommand('ping -c 1 10.0.12.1');
  return r;
}

/** Un commutateur dont les tables ARP et MAC portent une entree apprise. */
async function switchAvecMac() {
  const s = new HuaweiSwitch('switch-huawei', `SM${++serie}`, 8);
  const pc = new LinuxPC(`QM${++serie}`);
  new Cable(`cs${serie}`).connect(s.getPort('GigabitEthernet0/0/1')!, pc.getPort('eth0')!);
  for (const c of ['system-view', 'vlan 10', 'quit',
    'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit',
    'interface Vlanif 10', 'ip address 10.0.10.1 255.255.255.0', 'quit', 'quit']) {
    await s.executeCommand(c);
  }
  await pc.executeCommand('ip addr add 10.0.10.2/24 dev eth0');
  await pc.executeCommand('ping -c 1 10.0.10.1');
  return s;
}

const donnees = (sortie: string) =>
  sortie.split('\n').filter((l) => /^\d|^[0-9a-f]{4}-/.test(l));

describe('ce que la machine lit est ce qu\'elle rend', () => {
  it('`arp static aaaa-bbbb-cccc` revient tel quel dans la vue', async () => {
    const r = await routeurAvecArp();
    const vue = await r.executeCommand('display arp');
    expect(vue).toContain('aaaa-bbbb-cccc');
    expect(vue).not.toMatch(MAC_IEEE);
  });

  it('et tel quel dans la configuration rendue', async () => {
    const r = await routeurAvecArp();
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('arp static 192.168.1.50 aaaa-bbbb-cccc');
  });

  it('une MAC APPRISE porte la meme ecriture qu\'une MAC saisie', async () => {
    const r = await routeurAvecArp();
    for (const ligne of donnees(await r.executeCommand('display arp'))) {
      const mac = ligne.split(/\s+/)[1];
      expect(mac, ligne).toMatch(MAC_VRP);
    }
  });
});

describe('aucune vue VRP n\'ecrit une MAC au format IEEE', () => {
  it('routeur : les vues ARP', async () => {
    const r = await routeurAvecArp();
    for (const vue of ['display arp', 'display arp all', 'display arp static',
      'display arp dynamic']) {
      expect(await r.executeCommand(vue), vue).not.toMatch(MAC_IEEE);
    }
  });

  it('switch : ARP et table MAC', async () => {
    const s = await switchAvecMac();
    for (const vue of ['display arp', 'display mac-address']) {
      expect(await s.executeCommand(vue), vue).not.toMatch(MAC_IEEE);
    }
  });

  it('la conversion tient sur les deux ecritures et laisse le reste', () => {
    expect(huaweiMacAddress('02:00:00:00:00:11')).toBe('0200-0000-0011');
    expect(huaweiMacAddress('0200-0000-0011')).toBe('0200-0000-0011');
    expect(huaweiMacAddress('AA:BB:CC:DD:EE:FF')).toBe('aabb-ccdd-eeff');
    // Ce qui n'est pas une MAC n'est pas maquille en MAC.
    expect(huaweiMacAddress('pas-une-mac')).toBe('pas-une-mac');
  });
});

describe('chaque champ reste dans sa colonne', () => {
  /** Les debuts de mot d'une ligne. */
  const debuts = (l: string) => [...l.matchAll(/\S+/g)].map((m) => m.index ?? -1);

  it('routeur : `display arp` est cale sur son en-tete', async () => {
    const r = await routeurAvecArp();
    const lignes = (await r.executeCommand('display arp')).split('\n');
    const bords = debuts(lignes[0]);
    for (const l of donnees(lignes.join('\n'))) {
      for (const d of debuts(l)) expect(bords, l).toContain(d);
    }
  });

  it('switch : `display arp` et `display mac-address` aussi', async () => {
    const s = await switchAvecMac();
    for (const [vue, iEntete] of [['display arp', 0], ['display mac-address', 2]] as const) {
      const lignes = (await s.executeCommand(vue)).split('\n');
      const bords = debuts(lignes[iEntete]);
      const corps = lignes.filter((l) => /^\d|^[0-9a-f]{4}-/.test(l));
      expect(corps.length, vue).toBeGreaterThan(0);
      for (const l of corps) {
        for (const d of debuts(l)) expect(bords, `${vue} : ${l}`).toContain(d);
      }
    }
  });

  it('deux champs voisins ne se touchent jamais', async () => {
    // C'est la forme la plus directe du defaut : `dynamicGigabitEthernet`
    // et `GigabitEthernet0/0/1dynamic` etaient deux mots colles.
    for (const [nom, fabrique, vues] of [
      ['routeur', routeurAvecArp, ['display arp']],
      ['switch', switchAvecMac, ['display arp', 'display mac-address']],
    ] as const) {
      const d = await fabrique();
      for (const vue of vues) {
        for (const l of donnees(await d.executeCommand(vue))) {
          expect(l, `${nom} ${vue} : ${l}`).not.toMatch(/[a-z]Gigabit|\d[a-z]{3,}/);
        }
      }
    }
  });
});

describe('le nom d\'interface y suit la regle des lots V3 et V11', () => {
  it('`display arp` ne rend jamais le nom court interne', async () => {
    const r = await routeurAvecArp();
    const vue = await r.executeCommand('display arp');
    expect(vue).toContain('GigabitEthernet0/0/0');
    expect(vue).not.toMatch(/\bGE0\/0\/0\b/);
  });
});
