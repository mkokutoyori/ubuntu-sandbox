/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS, sur les deux
 * dernieres commandes que le routeur servait encore par son trie en
 * mode interface : `ip vrf forwarding` et `bfd echo`.
 *
 * Ce que la reference dit de `ip vrf forwarding <nom>` :
 *   - elle rattache l'interface a une instance de routage/reexpedition
 *     declaree par `ip vrf <nom>` en configuration globale.
 *   - une VRF qui n'existe pas est REFUSEE : rattacher une interface a
 *     une instance qui n'a pas ete declaree n'aurait aucun sens, et IOS
 *     le dit (`% VRF <nom> not configured.`).
 *   - le rattachement RETIRE l'adresse IP de l'interface, et IOS le
 *     PREVIENT — c'est le piege classique de la commande, l'operateur
 *     perdant sa gestion en la tapant a distance.
 *   - `no ip vrf forwarding <nom>` detache.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie, et
 *     l'ORDRE compte : le rattachement doit preceder l'adresse, sans quoi
 *     le rejeu effacerait l'adresse qu'il vient de poser.
 *
 * Ce que la reference dit de `bfd echo` :
 *   - c'est une commande d'INTERFACE, active par defaut, et seul
 *     `no bfd echo` a donc quelque chose a dire.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

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
  await jouer(r, ['enable', 'configure terminal', 'ip vrf CLIENT-A', 'exit',
    'interface GigabitEthernet0/0']);
  return r;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

describe('`ip vrf forwarding` sur un routeur', () => {
  it('rattache l interface a une VRF declaree', async () => {
    const r = await routeur();
    expect(await r.executeCommand('ip vrf forwarding CLIENT-A')).not.toMatch(REFUS);
    expect(await conf(r)).toMatch(/^\s*ip vrf forwarding CLIENT-A\s*$/m);
  });

  it('une VRF NON declaree est refusee', async () => {
    const r = await routeur();
    const out = await r.executeCommand('ip vrf forwarding ZORGLUB');
    expect(out.length).toBeGreaterThan(0);
    expect(await conf(r)).not.toMatch(/ip vrf forwarding ZORGLUB/);
  });

  it('la commande sans nom est INCOMPLETE', async () => {
    const r = await routeur();
    expect(await r.executeCommand('ip vrf forwarding')).toMatch(/Incomplete command/);
  });

  it('`no ip vrf forwarding <nom>` detache', async () => {
    const r = await routeur();
    await r.executeCommand('ip vrf forwarding CLIENT-A');
    await r.executeCommand('no ip vrf forwarding CLIENT-A');
    expect(await conf(r)).not.toMatch(/ip vrf forwarding CLIENT-A/);
  });

  /*
   * Le defaut que cette commande est connue pour causer : le
   * rattachement efface l'adresse. Une machine qui la garderait
   * laisserait croire que l'interface repond encore dans la table
   * globale.
   */
  it('le rattachement RETIRE l adresse IP de l interface', async () => {
    const r = await routeur();
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('ip vrf forwarding CLIENT-A');
    expect(await conf(r)).not.toMatch(/ip address 10\.0\.0\.1/);
  });

  it('`no ip vrf forwarding` SANS nom detache aussi', async () => {
    const r = await routeur();
    await r.executeCommand('ip vrf forwarding CLIENT-A');
    await r.executeCommand('no ip vrf forwarding');
    expect(await conf(r)).not.toMatch(/ip vrf forwarding CLIENT-A/);
  });

  it('l aide de la place annonce un NOM', async () => {
    const r = await routeur();
    expect(r.cliHelp('ip vrf forwarding ')).toMatch(/WORD/);
  });

  it('l aide nomme `forwarding` sous `ip vrf`', async () => {
    const r = await routeur();
    expect(r.cliHelp('ip vrf ')).toMatch(/^\s+forwarding\b/m);
  });

  it('la configuration ecrit le rattachement AVANT l adresse', async () => {
    const r = await routeur();
    await r.executeCommand('ip vrf forwarding CLIENT-A');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const texte = await conf(r);
    const rang = (motif: RegExp): number =>
      texte.split('\n').findIndex((l) => motif.test(l));
    const vrf = rang(/^\s*ip vrf forwarding CLIENT-A\s*$/);
    const adresse = rang(/^\s*ip address 10\.0\.0\.1/);
    expect(vrf).toBeGreaterThanOrEqual(0);
    expect(adresse).toBeGreaterThanOrEqual(0);
    expect(vrf).toBeLessThan(adresse);
  });
});

/*
 * SUITE — la migration de la famille VRF a trouve que seule
 * l'orthographe HERITEE etait declaree. La forme MODERNE, `vrf
 * forwarding <nom>`, tombait dans le noeud glouton `vrf` de la
 * configuration GLOBALE : elle etait acceptee, rangee, rendue dans la
 * configuration — et l'interface n'etait rattachee a RIEN. C'est le pire
 * des trois etats, la configuration decrivant une isolation que le plan
 * de donnees n'applique pas ; et il ne se voyait qu'en observant le
 * RATTACHEMENT plutot que la ligne rendue, puisque la ligne, elle,
 * paraissait.
 *
 * Discrimine dans un arbre de travail pose sur l'etat d'AVANT : les
 * QUATRE cas ci-dessous tombent, ce qui est attendu — l'orthographe
 * moderne n'existait nulle part, ni a l'analyse, ni a l'aide, ni au
 * rattachement.
 */
describe('`vrf forwarding` — la meme chose, ecrite comme IOS moderne', () => {
  it('rattache pour de bon, et le prouve en retirant l adresse', async () => {
    const r = await routeur();
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const out = await r.executeCommand('vrf forwarding CLIENT-A');
    expect(out).not.toMatch(REFUS);
    expect(out).toMatch(/removed due to enabling VRF CLIENT-A/);
    expect(await conf(r)).not.toMatch(/ip address 10\.0\.0\.1/);
  });

  it('une VRF NON declaree y est refusee aussi', async () => {
    const r = await routeur();
    expect(await r.executeCommand('vrf forwarding ZORGLUB'))
      .toMatch(/not configured/);
  });

  it('`no vrf forwarding` SANS nom detache', async () => {
    const r = await routeur();
    await r.executeCommand('vrf forwarding CLIENT-A');
    await r.executeCommand('no vrf forwarding');
    expect(await conf(r)).not.toMatch(/vrf forwarding CLIENT-A/);
  });

  it('et l aide nomme `forwarding` sous `vrf`', async () => {
    const r = await routeur();
    expect(r.cliHelp('vrf ')).toMatch(/^\s+forwarding\b/m);
  });
});

describe('`bfd echo` sur un routeur', () => {
  it('`no bfd echo` est accepte et se relit', async () => {
    const r = await routeur();
    expect(await r.executeCommand('no bfd echo')).not.toMatch(REFUS);
    expect(await conf(r)).toMatch(/^\s*no bfd echo\s*$/m);
  });

  it('`bfd echo` est accepte, et le defaut ne s ecrit pas', async () => {
    const r = await routeur();
    await r.executeCommand('no bfd echo');
    expect(await r.executeCommand('bfd echo')).not.toMatch(REFUS);
    expect(await conf(r)).not.toMatch(/no bfd echo/);
  });

  it('l aide nomme `echo` sous `bfd`', async () => {
    const r = await routeur();
    expect(r.cliHelp('bfd ')).toMatch(/^\s+echo\b/m);
  });

  it('un mot inconnu apres `bfd` est refuse', async () => {
    const r = await routeur();
    expect(await r.executeCommand('bfd zorglub')).toMatch(REFUS);
  });
});
