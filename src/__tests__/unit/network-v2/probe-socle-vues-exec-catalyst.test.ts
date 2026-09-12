/*
 * Cinq vues d'EXEC d'un Catalyst passent au socle, et ce lot est un
 * DEPLACEMENT — il faut le dire, parce qu'une sonde qui ne mesurerait
 * que des reponses inchangees ne prouverait rien.
 *
 * Ces cinq-la n'avaient aucun defaut d'arite : elles sont enregistrees
 * sans argument, donc `?` n'y promettait rien qu'elles ne tiennent. Ce
 * qu'on leur reproche est d'etre encore dans l'ANCIEN moteur, et le but
 * de la campagne est « a la fin on ne doit plus avoir un trie ». Le cas
 * qui DISCRIMINE est donc l'inventaire lui-meme : l'arbre ne porte plus
 * ces chemins, et les vues repondent quand meme.
 *
 * Les autres cas sont des TEMOINS, et ils sont ce qui rend le
 * deplacement sur : chaque vue rend sa table, aux DEUX portees d'EXEC —
 * ces commandes n'ont jamais demande `enable`, et une declaration qui
 * les reserverait au privilegie serait une regression que le seul
 * comptage de chemins ne verrait pas.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau ; rien de ce qui est exige ici n'en depend.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
  getShell: () => { getActiveTrie(): { enumerateExecutablePaths(): string[] } };
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const VUES: ReadonlyArray<readonly [string, RegExp]> = [
  ['show ip traffic', /IP statistics/],
  ['show ip dhcp statistics', /Memory usage/],
  ['show ip dhcp lease', /leases/],
  ['show ip dhcp database', /Database agents/],
  ['show ip dhcp snooping statistics', /DHCP Snooping/],
];

for (const [portee, prelude] of
  [['utilisateur', []], ['privilegie', ['enable']]] as Array<[string, string[]]>) {
  describe(`chaque vue rend sa table en EXEC ${portee} — les TEMOINS`, () => {
    it.each(VUES.map(([f]) => f))('`%s`', async (frappe) => {
      const attendu = VUES.find(([f]) => f === frappe)![1];
      const d = await commutateur(...prelude);
      const out = String(await d.executeCommand(frappe));
      expect(out, frappe).not.toMatch(/Invalid|Incomplete/);
      expect(out, `${frappe} ne rend pas sa table`).toMatch(attendu);
    });

    it('l arbre ne porte plus ces chemins', async () => {
      const d = await commutateur(...prelude);
      const chemins = d.getShell().getActiveTrie().enumerateExecutablePaths();
      for (const [frappe] of VUES) {
        expect(chemins, `${frappe} est encore dans l arbre`).not.toContain(frappe);
      }
    });
  });
}

describe('`show ip dhcp ?` garde ses dix vues, decrites', () => {
  it.each([[[]], [['enable']]] as Array<[string[]]>)('portee %s', async (prelude) => {
    const d = await commutateur(...prelude);
    expect(nomsAnnonces(d.cliHelp('show ip dhcp '))).toEqual(expect.arrayContaining([
      'binding', 'conflict', 'database', 'excluded-address', 'lease',
      'pool', 'relay', 'server', 'snooping', 'statistics',
    ]));
  });
});
