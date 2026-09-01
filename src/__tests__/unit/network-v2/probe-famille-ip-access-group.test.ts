/*
 * Sonde ECRITE A L'AVEUGLE, avant toute lecture du code, depuis la
 * documentation IOS de `ip access-group`.
 *
 * Ce que la reference dit :
 *   - `ip access-group { <numero> | <nom> } { in | out }` en mode
 *     interface, et sa negation.
 *   - une seule liste par SENS et par interface : en appliquer une
 *     seconde REMPLACE la premiere, elle ne s'ajoute pas.
 *   - les deux sens sont independants.
 *   - `show ip interface` en rend compte par deux lignes, `Outgoing
 *     access list is ...` et `Inbound  access list is ...` (deux blancs
 *     apres `Inbound`, la colonne etant alignee sur `Outgoing`).
 *   - la configuration rendue est REJOUEE a l'import d'une topologie.
 *   - un Catalyst porte la meme commande sur sa SVI et sur un port
 *     route : l'IOS est le meme.
 *
 * Discrimine par `git stash` : 13 des 32 cas tombent avant correctif.
 * Les 19 qui passent des DEUX cotes sont d'une des trois sortes, nommees
 * ici plutot que laissees a decouvrir :
 *   - le ROUTEUR savait deja tout ce que ces cas observent, sauf le
 *     message d'un sens invente ; c'est la moitie qui sert de
 *     non-regression a l'unification.
 *   - sur le COMMUTATEUR, les cas de refus (`le SENS est obligatoire`,
 *     `sans liste ... not set`, l'aide) passaient parce que la commande
 *     entiere etait refusee ou la liaison absente — ils gardent la
 *     grammaire, ils ne prouvent pas la fonction.
 *   - dans le laboratoire de plan de donnees, le TEMOIN sans liste, le
 *     cas de la liste RETIREE et celui de la liste qui PERMET : leur
 *     objet est justement que le trafic passe, ce qu'il faisait deja.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

async function jouer(d: Cli, lignes: string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

const LISTES = [
  'access-list 101 permit ip any any',
  'access-list 102 permit ip any any',
  'ip access-list extended NOMMEE', 'permit ip any any', 'exit',
];

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, ['enable', 'configure terminal', ...LISTES,
    'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'ip routing', ...LISTES,
    'interface Vlan1',
    'ip address 10.0.0.2 255.255.255.0', 'no shutdown']);
  return s;
}

const IF_ROUTEUR = 'GigabitEthernet0/0';
const IF_COMMUTATEUR = 'Vlan1';

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

async function vueIp(d: Cli, nom: string): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand(`show ip interface ${nom}`);
}

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>, string]> = [
  ['routeur', routeur, IF_ROUTEUR],
  ['commutateur', commutateur, IF_COMMUTATEUR],
];

for (const [nom, fabrique, iface] of PLATEFORMES) {
  describe(`\`ip access-group\` sur un ${nom}`, () => {
    const enInterface = async (d: Cli, cmds: string[]) =>
      jouer(d, ['configure terminal', `interface ${iface}`, ...cmds]);

    it('une liste NUMEROTEE se pose dans les deux sens', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-group 101 in'))
        .not.toMatch(/Invalid input|Incomplete|Ambiguous/);
      expect(await d.executeCommand('ip access-group 102 out'))
        .not.toMatch(/Invalid input|Incomplete|Ambiguous/);
      const texte = await conf(d);
      expect(texte).toMatch(/^\s*ip access-group 101 in\s*$/m);
      expect(texte).toMatch(/^\s*ip access-group 102 out\s*$/m);
    });

    it('une liste NOMMEE se pose aussi', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-group NOMMEE in');
      expect(await conf(d)).toMatch(/^\s*ip access-group NOMMEE in\s*$/m);
    });

    it('`show ip interface` rend les deux sens', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-group 101 in');
      await d.executeCommand('ip access-group 102 out');
      const vue = await vueIp(d, iface);
      expect(vue).toMatch(/Outgoing access list is 102/);
      expect(vue).toMatch(/Inbound {2}access list is 101/);
    });

    it('sans liste, `show ip interface` dit `not set` pour les deux', async () => {
      const d = await fabrique();
      const vue = await vueIp(d, iface);
      expect(vue).toMatch(/Outgoing access list is not set/);
      expect(vue).toMatch(/Inbound {2}access list is not set/);
    });

    it('une seconde liste dans le MEME sens REMPLACE la premiere', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-group 101 in');
      await enInterface(d, ['ip access-group 102 in']);
      const texte = await conf(d);
      expect(texte).toMatch(/^\s*ip access-group 102 in\s*$/m);
      expect(texte).not.toMatch(/^\s*ip access-group 101 in\s*$/m);
    });

    it('les deux sens sont INDEPENDANTS', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-group 101 in');
      await d.executeCommand('ip access-group 102 out');
      await enInterface(d, ['no ip access-group 101 in']);
      const vue = await vueIp(d, iface);
      expect(vue).toMatch(/Inbound {2}access list is not set/);
      expect(vue).toMatch(/Outgoing access list is 102/);
    });

    it('la negation retire la liaison de la configuration', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-group 101 in');
      await enInterface(d, ['no ip access-group 101 in']);
      expect(await conf(d)).not.toMatch(/ip access-group 101 in/);
    });

    it('le SENS est obligatoire', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-group 101'))
        .toMatch(/Incomplete command|Invalid input/);
    });

    it('un sens INVENTE est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-group 101 sideways'))
        .toMatch(/Invalid input/);
      expect(await conf(d)).not.toMatch(/ip access-group/);
    });

    it('l aide annonce les deux sens', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('ip access-group 101 ');
      expect(aide).toMatch(/^\s+in\b/m);
      expect(aide).toMatch(/^\s+out\b/m);
    });

    it('l aide de la place annonce les formes de numero et le nom', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('ip access-group ');
      expect(aide).toMatch(/<1-199>/);
      expect(aide).toMatch(/<1300-2699>/);
      expect(aide).toMatch(/WORD/);
    });

    it('la liaison est PROPRE A L INTERFACE', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-group 101 in');
      const second = nom === 'routeur' ? 'GigabitEthernet0/1' : 'Vlan20';
      await jouer(d, ['exit',
        ...(nom === 'routeur' ? [] : ['vlan 20', 'exit']),
        `interface ${second}`, 'ip address 10.0.9.1 255.255.255.0', 'no shutdown']);
      expect(await vueIp(d, second)).toMatch(/Inbound {2}access list is not set/);
      expect(await vueIp(d, iface)).toMatch(/Inbound {2}access list is 101/);
    });
  });
}

/*
 * Une liaison rangee et affichee sans EFFET serait le defaut que ce
 * depot referme sans cesse. Le laboratoire fait ROUTER un vrai paquet
 * d'un VLAN a l'autre a travers le Catalyst, ce que la commande existe
 * pour filtrer. Le TEMOIN sans liste est indispensable : sans lui, un
 * laboratoire mal bati et un filtrage reussi seraient indiscernables.
 */
describe('sur un Catalyst, la RACL d une SVI filtre vraiment entre VLAN', () => {
  async function laboratoire() {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    const a = new LinuxPC('linux-pc', 'A', -150, 0);
    const b = new LinuxPC('linux-pc', 'B', 150, 0);
    sw.powerOn(); a.powerOn(); b.powerOn();
    new Cable('ca').connect(a.getPort('eth0')!, sw.getPorts()[0]!);
    new Cable('cb').connect(b.getPort('eth0')!, sw.getPorts()[1]!);
    await jouer(sw as unknown as Cli, [
      'enable', 'configure terminal', 'ip routing',
      'vlan 10', 'exit', 'vlan 20', 'exit',
      `interface ${sw.getPorts()[0]!.getName()}`,
      'switchport mode access', 'switchport access vlan 10', 'exit',
      `interface ${sw.getPorts()[1]!.getName()}`,
      'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface Vlan20', 'ip address 10.0.20.1 255.255.255.0', 'no shutdown', 'end',
    ]);
    for (const [pc, ip, gw] of [
      [a, '10.0.10.2', '10.0.10.1'], [b, '10.0.20.2', '10.0.20.1'],
    ] as const) {
      await jouer(pc as unknown as Cli, ['ip link set eth0 up']);
      pc.getPort('eth0')!.configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
      await jouer(pc as unknown as Cli, [`ip route add default via ${gw}`]);
    }
    return { sw, a, b };
  }

  const passe = (sortie: string) => /, 0% packet loss/.test(sortie);

  it('TEMOIN : sans liste, un VLAN joint l autre', async () => {
    const { a } = await laboratoire();
    expect(passe(await a.executeCommand('ping -c 1 -W 1 10.0.20.2'))).toBe(true);
  });

  it('une liste ENTRANTE sur la SVI d entree bloque le trafic', async () => {
    const { sw, a } = await laboratoire();
    await jouer(sw as unknown as Cli, ['configure terminal',
      'ip access-list extended MUET', 'deny icmp any any', 'permit ip any any', 'exit',
      'interface Vlan10', 'ip access-group MUET in', 'end']);
    expect(passe(await a.executeCommand('ping -c 1 -W 1 10.0.20.2'))).toBe(false);
  });

  it('une liste SORTANTE sur la SVI de sortie bloque aussi', async () => {
    const { sw, a } = await laboratoire();
    await jouer(sw as unknown as Cli, ['configure terminal',
      'ip access-list extended MUET', 'deny icmp any any', 'permit ip any any', 'exit',
      'interface Vlan20', 'ip access-group MUET out', 'end']);
    expect(passe(await a.executeCommand('ping -c 1 -W 1 10.0.20.2'))).toBe(false);
  });

  it('la retirer remet le trafic', async () => {
    const { sw, a } = await laboratoire();
    await jouer(sw as unknown as Cli, ['configure terminal',
      'ip access-list extended MUET', 'deny icmp any any', 'permit ip any any', 'exit',
      'interface Vlan10', 'ip access-group MUET in',
      'no ip access-group MUET in', 'end']);
    expect(passe(await a.executeCommand('ping -c 1 -W 1 10.0.20.2'))).toBe(true);
  });

  it('une liste qui PERMET laisse passer — ce n est pas le fait de lier qui bloque', async () => {
    const { sw, a } = await laboratoire();
    await jouer(sw as unknown as Cli, ['configure terminal',
      'ip access-list extended OUVERT', 'permit ip any any', 'exit',
      'interface Vlan10', 'ip access-group OUVERT in', 'end']);
    expect(passe(await a.executeCommand('ping -c 1 -W 1 10.0.20.2'))).toBe(true);
  });
});

describe('les deux plateformes repondent la MEME chose', () => {
  it('la DESCRIPTION de `access-group` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+access-group\s/.test(l)) ?? '')
        .trim().replace(/^access-group\s+/, '');
    const cote = decrit(r.cliHelp('ip '));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp('ip '))).toBe(cote);
  });

  it('les deux lignes de `show ip interface` sont ECRITES PAREIL', async () => {
    const r = await routeur(); const s = await commutateur();
    await r.executeCommand('ip access-group 101 in');
    await s.executeCommand('ip access-group 101 in');
    const extrait = (texte: string): string[] => texte.split('\n')
      .filter((l) => /access list is/.test(l)).map((l) => l.trim());
    expect(extrait(await vueIp(s, IF_COMMUTATEUR)))
      .toEqual(extrait(await vueIp(r, IF_ROUTEUR)));
  });

  it('la ligne de configuration est ECRITE PAREIL des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    await r.executeCommand('ip access-group NOMMEE out');
    await s.executeCommand('ip access-group NOMMEE out');
    const ligne = (texte: string): string =>
      (texte.split('\n').find((l) => l.includes('ip access-group')) ?? '');
    expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
  });
});
