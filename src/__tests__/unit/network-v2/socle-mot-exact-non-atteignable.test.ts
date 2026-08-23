/**
 * Un mot ECRIT en toutes lettres n'est jamais l'abreviation d'un autre.
 *
 * Le socle et le trie herite coexistent, et l'arbre du socle porte a la
 * fois `ip` et `ipv6`. `keywordMatches` appliquait « l'exact l'emporte »
 * parmi les seuls noeuds ATTEIGNABLES dans la session : en configuration
 * globale, le sous-arbre `ip` du socle ne l'est pas, donc le mot `ip`
 * n'avait plus d'exact et retombait sur l'unique candidat par prefixe —
 * `ipv6`.
 *
 * La consequence n'etait pas cosmetique. `ip ?` annoncait
 * `unicast-routing  Enable IPv6 unicast routing`, une commande qu'IOS
 * n'a pas, et donnait a `cef` la description de la v6 ; surtout,
 * `ip u` + Tab REECRIVAIT la ligne en `ipv6 unicast-routing`, donc
 * changeait la commande que l'operateur avait tapee. Tape en entier,
 * `ip unicast-routing` etait pourtant CORRECTEMENT refuse : l'aide et la
 * tabulation annoncaient ce que la machine refuse.
 *
 * Le correctif tient en une regle : si un enfant porte EXACTEMENT le mot
 * et qu'il n'est pas atteignable ici, il n'y a pas de correspondance —
 * on ne se rabat pas sur un autre mot. C'est la meme posture de fermeture
 * que celle des moteurs de filtrage : un critere qu'on ne peut pas
 * honorer ne vaut pas accord.
 *
 * Discrimine par `git stash` de `src/cli/CommandParser.ts` : 4 des 7 cas
 * tombent. Les 3 qui passent des deux cotes sont nommes ici — le refus a
 * l'execution, qui etait deja juste et que ce lot ne doit pas casser ;
 * « `ip ?` garde ses vraies commandes », qui vient du trie herite et ne
 * dependait donc pas du socle ; et le TEMOIN `ipv6 ?`, dont l'objet est
 * que la branche v6 reste intacte.
 *
 * Deux gardes-fous du depot passent au vert avec ce lot :
 * `probe-cli-help-parity-ratchet` (deux cas) et
 * `probe-aide-tient-ses-promesses` (un cas).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

interface Cli {
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
  executeCommand(c: string): Promise<string>;
}

async function config(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0);
  r.powerOn();
  for (const c of ['enable', 'configure terminal']) await r.executeCommand(c);
  return r as unknown as Cli;
}

describe('`ip` n est pas une abreviation d `ipv6`', () => {
  it('`ip ?` ne propose plus de commande decrite comme IPv6', async () => {
    const cli = await config();
    const aide = cli.cliHelp('ip ');
    expect(aide).not.toMatch(/IPv6/);
  });

  it('`ip ?` ne propose plus `unicast-routing`', async () => {
    const cli = await config();
    const mots = cli.cliHelp('ip ').split('\n').map(l => l.trim().split(/\s+/)[0]);
    expect(mots).not.toContain('unicast-routing');
  });

  it('`ip ?` garde ses vraies commandes', async () => {
    const cli = await config();
    const mots = cli.cliHelp('ip ').split('\n').map(l => l.trim().split(/\s+/)[0]);
    expect(mots).toContain('route');
    expect(mots).toContain('access-list');
  });

  it('Tab ne REECRIT plus `ip u` en `ipv6 unicast-routing`', async () => {
    const cli = await config();
    expect(cli.cliTabCandidates('ip u')).not.toContain('ipv6 unicast-routing');
  });

  it('ce que `?` propose apres `ip`, Tab le complete', async () => {
    const cli = await config();
    const mots = cli.cliHelp('ip ').split('\n')
      .map(l => l.trim().split(/\s+/)[0])
      .filter(w => w && w !== '<cr>' && !w.startsWith('<') && !w.startsWith('%'));
    for (const mot of mots) {
      const candidats = cli.cliTabCandidates(`ip ${mot.slice(0, 2)}`);
      expect(candidats.some(c => c.startsWith('ip '))).toBe(true);
    }
  });

  it('`ip unicast-routing` reste refuse a l execution', async () => {
    const cli = await config();
    expect(await cli.executeCommand('ip unicast-routing')).toMatch(/Invalid input/);
  });

  it('TEMOIN — `ipv6 ?` propose toujours ses propres commandes', async () => {
    const cli = await config();
    const mots = cli.cliHelp('ipv6 ').split('\n').map(l => l.trim().split(/\s+/)[0]);
    expect(mots).toContain('unicast-routing');
  });
});
