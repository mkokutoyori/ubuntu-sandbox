/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS de `privilege`,
 * la commande qui DEPLACE une commande d'un niveau d'EXEC a un autre.
 *
 * Ce que la reference dit :
 *   `privilege <mode> [all] { level <0-15> | reset } <commande>`
 *   - `<mode>` est un mode de configuration (`exec`, `configure`,
 *     `interface`, `line`, `router`, `route-map`…), pas un mot libre.
 *   - `all` porte le niveau aux SOUS-commandes du chemin donne.
 *   - `reset` rend a la commande son niveau d'origine.
 *   - `no privilege <mode> level <n> <commande>` retire le reglage.
 *
 * Pourquoi une acceptation trop large se paie ici : le niveau decide de
 * QUI peut taper la commande. Un mode invente ou un niveau jete laisse
 * l'operateur croire qu'il a restreint une commande qui ne l'est pas —
 * et la configuration rendue est REJOUEE a l'import d'une topologie,
 * donc une ligne qui ne s'y ecrit pas fait revenir la machine ouverte.
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
  await jouer(r, ['enable', 'configure terminal']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command|out of range/;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`privilege\` sur un ${nom}`, () => {
    it('un niveau se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege exec level 15 show running-config'))
        .not.toMatch(REFUS);
      expect(await conf(d))
        .toMatch(/^privilege exec level 15 show running-config\s*$/m);
    });

    it('`no privilege` retire le reglage', async () => {
      const d = await fabrique();
      await d.executeCommand('privilege exec level 15 show running-config');
      await d.executeCommand('no privilege exec level 15 show running-config');
      expect(await conf(d)).not.toMatch(/^privilege exec level 15 show running-config/m);
    });

    it('un niveau HORS de 0-15 est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege exec level 16 show version'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/level 16/);
    });

    it('un niveau qui n est pas un nombre est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege exec level zorglub show version'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('un MODE inconnu est refuse, pas range', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege zorglub level 5 show version'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('le mode `configure` est accepte', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege configure level 8 snmp-server'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^privilege configure level 8 snmp-server\s*$/m);
    });

    it('le mode `interface` est accepte', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege interface level 8 shutdown'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^privilege interface level 8 shutdown\s*$/m);
    });

    it('`all` est accepte et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege exec all level 5 show ip'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^privilege exec all level 5 show ip\s*$/m);
    });

    it('`reset` est accepte', async () => {
      const d = await fabrique();
      await d.executeCommand('privilege exec level 5 show version');
      expect(await d.executeCommand('privilege exec reset show version'))
        .not.toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/privilege exec level 5 show version/);
    });

    it('la commande sans mode est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege')).toMatch(/Incomplete command/);
    });

    it('la commande sans niveau est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege exec level')).toMatch(/Incomplete command/);
    });

    it('la commande sans COMMANDE est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('privilege exec level 5')).toMatch(/Incomplete command/);
    });

    it('l aide de la place du MODE annonce des modes et non un mot libre', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('privilege ');
      expect(aide).toMatch(/^\s+exec\b/m);
      expect(aide).toMatch(/^\s+configure\b/m);
      expect(aide).toMatch(/^\s+interface\b/m);
    });

    it('l aide de la place du NIVEAU annonce <0-15>', async () => {
      const d = await fabrique();
      expect(d.cliHelp('privilege exec level ')).toContain('<0-15>');
    });

    it('l aide apres le mode annonce `level`, `all` et `reset`', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('privilege exec ');
      expect(aide).toMatch(/^\s+level\b/m);
      expect(aide).toMatch(/^\s+all\b/m);
      expect(aide).toMatch(/^\s+reset\b/m);
    });

    /*
     * Le reglage n'est pas decoratif : il DEPLACE la commande. Une
     * commande descendue au niveau 1 devient tapable sans `enable`.
     * Sans ce cas, un magasin bien rempli mais jamais lu passerait pour
     * un succes.
     */
    it('un niveau POSE change ce que la machine accepte', async () => {
      const d = await fabrique();
      await jouer(d, ['end', 'disable']);
      const avant = await d.executeCommand('show running-config');
      expect(avant).toMatch(REFUS);

      await jouer(d, ['enable', 'configure terminal']);
      await d.executeCommand('privilege exec level 1 show running-config');
      await jouer(d, ['end', 'disable']);
      expect(await d.executeCommand('show running-config')).not.toMatch(REFUS);
    });

    /*
     * `privilege level <n>` sous `line` est une AUTRE commande — elle
     * regle le niveau d'entree de la ligne, pas celui d'une commande —
     * et elle est declaree dans le sous-mode, qui HERITE de `config`.
     * Elle doit primer celle qu'il herite, sans quoi `level` serait lu
     * comme un nom de mode et la commande la plus tapee du sous-mode
     * serait refusee au caret.
     */
    it('`privilege level` du sous-mode `line` prime celle de `config`', async () => {
      const d = await fabrique();
      await d.executeCommand('line console 0');
      expect(await d.executeCommand('privilege level 15')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^ privilege level 15\s*$/m);
    });

    it('une saisie REFUSEE ne deplace rien', async () => {
      const d = await fabrique();
      await d.executeCommand('privilege exec level 99 show running-config');
      await jouer(d, ['end', 'disable']);
      expect(await d.executeCommand('show running-config')).toMatch(REFUS);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'privilege exec level 16 show version',
    'privilege exec level zorglub show version',
    'privilege zorglub level 5 show version',
    'privilege',
    'privilege exec level',
    'privilege exec level 5',
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

  it('la ligne de configuration est ECRITE PAREIL', async () => {
    const r = await routeur(); const s = await commutateur();
    const pose = 'privilege exec level 15 show running-config';
    await r.executeCommand(pose); await s.executeCommand(pose);
    const ligne = (t: string) =>
      (t.split('\n').find((l) => l.startsWith('privilege ')) ?? '');
    expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
  });

  it('la DESCRIPTION de `privilege` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+privilege\s/.test(l)) ?? '')
        .trim().replace(/^privilege\s+/, '');
    const cote = decrit(r.cliHelp(''));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp(''))).toBe(cote);
  });
});
