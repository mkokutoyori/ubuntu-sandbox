/*
 * Sonde ECRITE A L'AVEUGLE, avant toute lecture du code, depuis la
 * documentation IOS de `ip helper-address`.
 *
 * Ce que la reference dit :
 *   - `ip helper-address <adresse>` en mode interface designe la cible
 *     vers laquelle le relais DHCP reexpedie une diffusion recue sur
 *     CETTE interface, et sa negation en retire une.
 *   - plusieurs cibles coexistent sur une meme interface ; la commande
 *     AJOUTE, elle ne remplace pas.
 *   - un argument qui n'est pas une adresse est REFUSE : IOS n'a rien
 *     d'autre a en faire, et une cible que rien ne peut joindre est un
 *     relais qui ne relaie pas.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie :
 *     une cible qui n'y paraît pas est perdue.
 *   - un Catalyst porte la meme commande sur sa SVI, l'IOS etant le
 *     meme.
 *
 * Discrimine par `git stash` : 6 des 23 cas tombent avant correctif, et
 * les six sont du cote du ROUTEUR — c'est lui qui acceptait un argument
 * qui n'est pas une adresse et qui recitait `Helper address is not set`
 * quelle que soit sa configuration. Les 17 autres passent des deux cotes
 * et le doivent : le COMMUTATEUR faisait deja tout ce qu'ils observent,
 * ce qui est exactement pourquoi la migration prend SA moitie comme
 * reference plutot que celle du routeur.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

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

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'ip routing', 'interface Vlan1',
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
  describe(`\`ip helper-address\` sur un ${nom}`, () => {
    it('une cible se pose et se RELIT dans la configuration', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip helper-address 10.9.9.9'))
        .not.toMatch(/Invalid input|Incomplete|rejected/);
      expect(await conf(d)).toMatch(/^\s*ip helper-address 10\.9\.9\.9\s*$/m);
    });

    it('deux cibles COEXISTENT — la commande ajoute, elle ne remplace pas', async () => {
      const d = await fabrique();
      await d.executeCommand('ip helper-address 10.9.9.9');
      await d.executeCommand('ip helper-address 10.9.9.10');
      const texte = await conf(d);
      expect(texte).toMatch(/^\s*ip helper-address 10\.9\.9\.9\s*$/m);
      expect(texte).toMatch(/^\s*ip helper-address 10\.9\.9\.10\s*$/m);
    });

    it('la negation retire la cible NOMMEE et laisse les autres', async () => {
      const d = await fabrique();
      await d.executeCommand('ip helper-address 10.9.9.9');
      await d.executeCommand('ip helper-address 10.9.9.10');
      await d.executeCommand('no ip helper-address 10.9.9.9');
      const texte = await conf(d);
      expect(texte).not.toMatch(/ip helper-address 10\.9\.9\.9\s*$/m);
      expect(texte).toMatch(/^\s*ip helper-address 10\.9\.9\.10\s*$/m);
    });

    it('un argument qui n est PAS une adresse est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip helper-address zorglub'))
        .toMatch(/Invalid input/);
      expect(await conf(d)).not.toMatch(/helper-address/);
    });

    it('une adresse MALFORMEE est refusee aussi', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip helper-address 999.1.1.1'))
        .toMatch(/Invalid input/);
      expect(await conf(d)).not.toMatch(/helper-address/);
    });

    it('la commande sans argument est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip helper-address'))
        .toMatch(/Incomplete command/);
    });

    it('`show ip interface` nomme la cible', async () => {
      const d = await fabrique();
      await d.executeCommand('ip helper-address 10.9.9.9');
      expect(await vueIp(d, iface)).toMatch(/Helper address is 10\.9\.9\.9/);
    });

    it('sans cible, `show ip interface` dit `not set`', async () => {
      const d = await fabrique();
      expect(await vueIp(d, iface)).toMatch(/Helper address is not set/);
    });

    it('l aide de la place annonce une ADRESSE', async () => {
      const d = await fabrique();
      expect(d.cliHelp('ip helper-address ')).toMatch(/A\.B\.C\.D/);
    });

    it('la cible est PROPRE A L INTERFACE', async () => {
      const d = await fabrique();
      await d.executeCommand('ip helper-address 10.9.9.9');
      const second = nom === 'routeur' ? 'GigabitEthernet0/1' : 'Vlan20';
      await jouer(d, ['exit',
        ...(nom === 'routeur' ? [] : ['vlan 20', 'exit']),
        `interface ${second}`, 'ip address 10.0.9.1 255.255.255.0', 'no shutdown']);
      expect(await vueIp(d, second)).toMatch(/Helper address is not set/);
      expect(await vueIp(d, iface)).toMatch(/Helper address is 10\.9\.9\.9/);
    });
  });
}

describe('un port L2 d un Catalyst ne porte pas de relais', () => {
  it('la commande y est REFUSEE, pas silencieusement ignoree', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW2', 8, 0, 0) as unknown as Cli;
    s.powerOn();
    await jouer(s, ['enable', 'configure terminal', 'interface FastEthernet0/2']);
    expect(await s.executeCommand('ip helper-address 10.9.9.9'))
      .toContain('% Command rejected: not applicable on this interface.');
  });

  it('et rien n est range : la configuration n en porte pas trace', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW3', 8, 0, 0) as unknown as Cli;
    s.powerOn();
    await jouer(s, ['enable', 'configure terminal', 'interface FastEthernet0/2',
      'ip helper-address 10.9.9.9']);
    expect(await conf(s)).not.toMatch(/helper-address/);
  });
});

describe('les deux plateformes repondent la MEME chose', () => {
  it('la DESCRIPTION de `helper-address` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+helper-address\s/.test(l)) ?? '')
        .trim().replace(/^helper-address\s+/, '');
    const cote = decrit(r.cliHelp('ip '));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp('ip '))).toBe(cote);
  });

  it('un argument invalide est refuse avec les MEMES mots', async () => {
    const r = await routeur(); const s = await commutateur();
    const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
    expect(nettoie(await s.executeCommand('ip helper-address zorglub')))
      .toBe(nettoie(await r.executeCommand('ip helper-address zorglub')));
  });

  it('la ligne de configuration est ECRITE PAREIL des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    await r.executeCommand('ip helper-address 10.9.9.9');
    await s.executeCommand('ip helper-address 10.9.9.9');
    const ligne = (texte: string): string =>
      (texte.split('\n').find((l) => l.includes('helper-address')) ?? '');
    expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
  });
});
