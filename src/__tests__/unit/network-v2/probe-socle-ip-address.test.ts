/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS de
 * `ip address`, la commande d'interface la plus tapee de toutes.
 *
 * Ce que la reference dit :
 *   - `ip address <A.B.C.D> <masque>` pose l'adresse PRIMAIRE, et le
 *     suffixe `secondary` en ajoute une seconde sans remplacer la
 *     premiere.
 *   - `ip address dhcp` fait negocier l'adresse au lieu de la fixer.
 *   - `no ip address` retire l'adresse.
 *   - une adresse ou un masque malformes sont REFUSES : ce ne sont pas
 *     des mots libres, et une interface qui garderait `zorglub` pour
 *     adresse ne serait joignable par personne.
 *   - un masque n'est pas n'importe quel quadruplet : il est fait de
 *     bits contigus, donc `255.0.255.0` n'en est pas un.
 *   - la commande sans argument est INCOMPLETE.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie.
 *   - un Catalyst porte la meme commande sur sa SVI, l'IOS etant le
 *     meme, et la refuse sur un port purement L2 tant qu'on ne l'a pas
 *     passe en routage.
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
  await jouer(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'ip routing', 'interface Vlan1']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command|Bad mask|invalid/i;

/*
 * Une adresse SECONDAIRE existe sur un vrai Catalyst, et ce simulateur
 * ne sait pas la porter : `SwitchSvi` range UNE adresse et un masque
 * par SVI, sans quoi il faudrait toucher au plan de donnees (`isOwnArp`,
 * la resolution, le routage). Elle est donc REFUSEE plutot qu'acceptee
 * et jetee — ce que faisait le commutateur avant ce lot, ou plutot pire,
 * puisqu'il ECRASAIT la primaire avec la valeur donnee pour secondaire.
 * L'invariant qui vaut des DEUX cotes, et que ce cas verifie, est que la
 * primaire survit.
 */
const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>, boolean]> = [
  ['routeur', routeur, true],
  ['commutateur', commutateur, false],
];

for (const [nom, fabrique, porteSecondaire] of PLATEFORMES) {
  describe(`\`ip address\` sur un ${nom}`, () => {
    it('une adresse et son masque se posent et se relisent', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address 10.0.0.1 255.255.255.0'))
        .not.toMatch(REFUS);
      expect(await conf(d))
        .toMatch(/^\s*ip address 10\.0\.0\.1 255\.255\.255\.0\s*$/m);
    });

    it('une adresse MALFORMEE est refusee et rien n est range', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address zorglub 255.255.255.0'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/ip address zorglub/);
    });

    it('un octet hors bornes est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address 999.1.1.1 255.255.255.0'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/ip address 999/);
    });

    it('un MASQUE malforme est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address 10.0.0.1 zorglub')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/ip address 10\.0\.0\.1 zorglub/);
    });

    it('un masque NON CONTIGU est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address 10.0.0.1 255.0.255.0')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/255\.0\.255\.0/);
    });

    it('la commande sans argument est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address')).toMatch(/Incomplete command/);
    });

    it('l adresse sans masque est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address 10.0.0.1')).toMatch(/Incomplete command/);
    });

    it('`secondary` n ECRASE jamais la primaire', async () => {
      const d = await fabrique();
      await d.executeCommand('ip address 10.0.0.1 255.255.255.0');
      const reponse = await d.executeCommand('ip address 10.0.9.1 255.255.255.0 secondary');
      const texte = await conf(d);
      expect(texte).toMatch(/^\s*ip address 10\.0\.0\.1 255\.255\.255\.0\s*$/m);
      if (porteSecondaire) {
        expect(reponse).not.toMatch(REFUS);
        expect(texte).toMatch(/^\s*ip address 10\.0\.9\.1 255\.255\.255\.0 secondary\s*$/m);
      } else {
        expect(reponse).toContain('Secondary addresses are not supported');
        expect(texte).not.toMatch(/10\.0\.9\.1/);
      }
    });

    it('`no ip address` retire l adresse', async () => {
      const d = await fabrique();
      await d.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await d.executeCommand('no ip address');
      expect(await conf(d)).not.toMatch(/ip address 10\.0\.0\.1/);
    });

    it('`ip address dhcp` est accepte', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address dhcp')).not.toMatch(REFUS);
    });

    it('l aide annonce A.B.C.D puis dhcp', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('ip address ');
      expect(aide).toMatch(/A\.B\.C\.D/);
      expect(aide).toMatch(/^\s+dhcp\b/m);
    });

    it('l aide de la place du MASQUE annonce A.B.C.D', async () => {
      const d = await fabrique();
      expect(d.cliHelp('ip address 10.0.0.1 ')).toMatch(/A\.B\.C\.D/);
    });

    it('un mot de TROP apres le masque est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip address 10.0.0.1 255.255.255.0 zorglub'))
        .toMatch(REFUS);
    });

    it('l abreviation `ip addr` s execute', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip addr 10.0.0.1 255.255.255.0'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/ip address 10\.0\.0\.1 255\.255\.255\.0/);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'ip address zorglub 255.255.255.0',
    'ip address 10.0.0.1 zorglub',
    'ip address 10.0.0.1 255.0.255.0',
    'ip address',
    'ip address 10.0.0.1',
  ];
  for (const saisie of SAISIES) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
      const cote = nettoie(await r.executeCommand(saisie));
      expect(cote.length).toBeGreaterThan(0);
      expect(nettoie(await s.executeCommand(saisie))).toBe(cote);
    });
  }

  it('la DESCRIPTION de `address` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+address\s/.test(l)) ?? '')
        .trim().replace(/^address\s+/, '');
    const cote = decrit(r.cliHelp('ip '));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp('ip '))).toBe(cote);
  });

  it('la ligne de configuration est ECRITE PAREIL', async () => {
    const r = await routeur(); const s = await commutateur();
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await s.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const ligne = (t: string) =>
      (t.split('\n').find((l) => l.includes('ip address 10.0.0.1')) ?? '');
    expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
  });
});

describe('un port L2 d un Catalyst ne porte pas d adresse', () => {
  it('la commande y est REFUSEE, pas silencieusement ignoree', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW2', 8, 0, 0) as unknown as Cli;
    s.powerOn();
    await jouer(s, ['enable', 'configure terminal', 'interface FastEthernet0/2']);
    const out = await s.executeCommand('ip address 10.0.0.1 255.255.255.0');
    expect(out.length).toBeGreaterThan(0);
    expect(await conf(s)).not.toMatch(/ip address 10\.0\.0\.1/);
  });
});
