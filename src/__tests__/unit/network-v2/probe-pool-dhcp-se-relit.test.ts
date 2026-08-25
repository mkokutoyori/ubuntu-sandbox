/**
 * Un pool DHCP se RELIT : la configuration rendue reproduit ce qui a
 * ete tape, et le commutateur la rend aussi.
 *
 * MESURE DE DEPART, sur un Catalyst : `ip dhcp pool`, `network`,
 * `default-router`, `dns-server`, `domain-name`, `lease` et les
 * exclusions sont tous ACCEPTES et honores par `show ip dhcp pool` —
 * et `show running-config` n'en rend AUCUN. `buildRunningConfig` du
 * commutateur, un parcours ecrit a part de celui du routeur,
 * n'enumerait jamais `getAllPools()`. Un Catalyst serveur DHCP revenait
 * donc vierge a l'import d'une topologie, en silence.
 *
 * MESURE SUR LE ROUTEUR, faite pour verifier que le rendu qu'on allait
 * partager etait juste : il ne l'etait pas. `next-server`, `bootfile`,
 * `netbios-name-server`, `netbios-node-type`, `option` et la RESERVATION
 * MANUELLE ENTIERE (`host` / `hardware-address` / `client-name`) etaient
 * perdus eux aussi ; et `lease 0 12 0` ressortait en ` lease 0`, que le
 * rejeu relit comme un jour.
 *
 * TROISIEME DEFAUT, trouve en lisant la commande : le troisieme champ de
 * `lease` est en MINUTES sur IOS (`lease {days [hours [minutes]]}`,
 * maximum 365 jours 23 heures 59 minutes) et l'analyse l'ajoutait en
 * SECONDES. `lease 0 0 30` posait 30 secondes la ou une vraie machine
 * pose 30 minutes.
 *
 * DISCRIMINATION : 12 des 14 cas tombent avant correctif. Les 2 autres
 * sont nommes ici plutot que laisses a decouvrir :
 *  - « le reseau et la passerelle se relisent » sur le ROUTEUR : ces
 *    deux lignes-la etaient deja rendues ; le cas est le TEMOIN qui
 *    prouve que le laboratoire est bien monte, sans quoi une sonde
 *    faite seulement d'absences passerait avec un rendu entierement
 *    vide.
 *  - « un bail d'un jour ne s'ecrit pas » : l'ancien rendu l'obtenait
 *    par hasard, `Math.floor(86400 / 86400)` valant 1 et sa condition
 *    etant `days !== 1`.
 *
 * DEUX SUPPOSITIONS CORRIGEES PAR LA MESURE, ecrites ici parce qu'elles
 * disent ou etait vraiment le defaut : `lease infinite` n'etait PAS
 * rendu (l'ancien calcul divisait la duree quoi qu'il arrive), et
 * `lease 0 24` n'etait PAS refuse par le socle — la commande acceptait
 * n'importe quel nombre a n'importe quelle place.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Boitier = { executeCommand(c: string): Promise<string> | string };

async function cfg(dev: Boitier, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(String(await dev.executeCommand(l)));
  return out;
}

const POOL_COMPLET = [
  'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
  'ip dhcp pool LAN',
  'network 192.168.1.0 255.255.255.0',
  'default-router 192.168.1.1',
  'dns-server 8.8.8.8 8.8.4.4',
  'domain-name lab.local',
  'netbios-name-server 192.168.1.6',
  'netbios-node-type h-node',
  'next-server 192.168.1.5',
  'bootfile ios.bin',
  'option 150 ip 192.168.1.7',
  'lease 0 12 30',
];

async function routeur(lines: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await cfg(r, ['enable', 'configure terminal', ...lines, 'end']);
  return r;
}

async function commutateur(lines: string[]): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1');
  sw.powerOn();
  await cfg(sw, ['enable', 'configure terminal', ...lines, 'end']);
  return sw;
}

describe('le commutateur rend son pool', () => {
  it('le pool, son reseau et ses exclusions figurent dans la configuration', async () => {
    const sw = await commutateur(POOL_COMPLET);
    const rc = String(await sw.executeCommand('show running-config'));
    expect(rc).toContain('ip dhcp excluded-address 192.168.1.1 192.168.1.10');
    expect(rc).toContain('ip dhcp pool LAN');
    expect(rc).toContain(' network 192.168.1.0 255.255.255.0');
    expect(rc).toContain(' default-router 192.168.1.1');
  });

  it('le routeur et le commutateur rendent le MEME bloc', async () => {
    const bloc = (rc: string): string[] => {
      const lignes = rc.split('\n');
      const debut = lignes.findIndex(l => l.startsWith('ip dhcp pool LAN'));
      const suite = lignes.slice(debut + 1).findIndex(l => !l.startsWith(' '));
      return lignes.slice(debut, debut + 1 + suite);
    };
    const r = await routeur(POOL_COMPLET);
    const sw = await commutateur(POOL_COMPLET);
    expect(bloc(String(await sw.executeCommand('show running-config'))))
      .toEqual(bloc(String(await r.executeCommand('show running-config'))));
  });
});

describe('la configuration rendue reproduit ce qui a ete tape', () => {
  it('le reseau et la passerelle se relisent', async () => {
    const r = await routeur(POOL_COMPLET);
    const rc = String(await r.executeCommand('show running-config'));
    expect(rc).toContain(' network 192.168.1.0 255.255.255.0');
    expect(rc).toContain(' default-router 192.168.1.1');
  });

  it('le serveur d\'amorcage et son fichier se relisent', async () => {
    const rc = String(await (await routeur(POOL_COMPLET)).executeCommand('show running-config'));
    expect(rc).toContain(' next-server 192.168.1.5');
    expect(rc).toContain(' bootfile ios.bin');
  });

  it('NetBIOS et les options brutes se relisent', async () => {
    const rc = String(await (await routeur(POOL_COMPLET)).executeCommand('show running-config'));
    expect(rc).toContain(' netbios-name-server 192.168.1.6');
    expect(rc).toContain(' netbios-node-type h-node');
    expect(rc).toContain(' option 150 ip 192.168.1.7');
  });

  it('la reservation manuelle se relit tout entiere', async () => {
    const r = await routeur([
      'ip dhcp pool STATIC', 'host 192.168.1.50 255.255.255.0',
      'hardware-address 0011.2233.4455', 'client-name imprimante']);
    const rc = String(await r.executeCommand('show running-config'));
    expect(rc).toContain(' host 192.168.1.50 255.255.255.0');
    expect(rc).toContain(' hardware-address 0011.2233.4455');
    expect(rc).toContain(' client-name imprimante');
  });

  it('un rejeu de la configuration rendue redonne le meme pool', async () => {
    const r = await routeur(POOL_COMPLET);
    const rc = String(await r.executeCommand('show running-config'));
    const lignes = rc.split('\n')
      .filter(l => l.startsWith('ip dhcp ') || (l.startsWith(' ') && l.trim().length > 0));
    const debut = lignes.findIndex(l => l.startsWith('ip dhcp'));

    const r2 = await routeur(lignes.slice(debut).map(l => l.trim()));
    expect(String(await r2.executeCommand('show running-config')).split('\n')
      .filter(l => l.includes('dhcp') || / (network|next-server|bootfile|option|lease) /.test(l)))
      .toEqual(rc.split('\n')
        .filter(l => l.includes('dhcp') || / (network|next-server|bootfile|option|lease) /.test(l)));
  });
});

describe('le troisieme champ de `lease` est en minutes', () => {
  it('`lease 0 12 30` vaut douze heures et demie', async () => {
    const r = await routeur(POOL_COMPLET);
    const pool = r._getDHCPServerInternal().getPool('LAN');
    expect(pool?.leaseDuration).toBe(12 * 3600 + 30 * 60);
  });

  it('et se rend tel qu\'il a ete tape', async () => {
    const rc = String(await (await routeur(POOL_COMPLET)).executeCommand('show running-config'));
    expect(rc).toContain(' lease 0 12 30');
    expect(rc).not.toContain(' lease 0\n');
  });

  it('un bail d\'un jour ne s\'ecrit pas, c\'est le defaut', async () => {
    const rc = String(await (await routeur([
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'lease 1',
    ])).executeCommand('show running-config'));
    expect(rc).toContain('ip dhcp pool LAN');
    expect(rc).not.toMatch(/^ lease /m);
  });

  it('`lease infinite` se relit', async () => {
    const rc = String(await (await routeur([
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'lease infinite',
    ])).executeCommand('show running-config'));
    expect(rc).toContain(' lease infinite');
  });

  it('une duree hors bornes est refusee', async () => {
    const sorties = await cfg(await routeur([]), [
      'configure terminal', 'ip dhcp pool LAN',
      'lease 0 24', 'lease 0 0 60', 'lease 366', 'end']);
    expect(sorties.filter(o => o.includes('Invalid input'))).toHaveLength(3);
  });

  it('un bail nul est refuse', async () => {
    const sorties = await cfg(await routeur([]), [
      'configure terminal', 'ip dhcp pool LAN', 'lease 0', 'end']);
    expect(sorties.join('\n')).toContain('Invalid input');
  });
});

describe('`service dhcp` suit la convention d\'IOS', () => {
  it('un service actif ne s\'ecrit pas, un service coupe s\'ecrit', async () => {
    const actif = String(await (await routeur([
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0',
    ])).executeCommand('show running-config'));
    expect(actif).not.toContain('service dhcp');

    const coupe = String(await (await routeur([
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'exit', 'no service dhcp',
    ])).executeCommand('show running-config'));
    expect(coupe).toContain('no service dhcp');
  });
});
