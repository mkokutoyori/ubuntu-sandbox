/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation Catalyst, sur trois
 * commandes de port PHYSIQUE que le commutateur sert encore par son
 * trie, toutes trois enregistrees par une meme boucle generique qui
 * n'analyse RIEN et se contente de retenir le texte tape.
 *
 * Ce que la reference dit :
 *   - `channel-protocol { lacp | pagp }` restreint l'agregation a l'un
 *     des deux protocoles, et n'admet que ces deux mots.
 *   - `mdix auto` active la detection automatique du croisement.
 *     L'auto-MDIX est ACTIF par defaut sur un Catalyst moderne, donc
 *     c'est `no mdix auto` qui porte une information — la meme regle que
 *     `bfd echo`, ou ecrire le defaut ferait dire a la configuration ce
 *     qu'aucune machine n'y met.
 *   - `power inline { auto | never | static }`, avec un `max <mW>`
 *     facultatif, gouverne l'alimentation par le cable.
 *   - les trois sont propres a un port physique : une SVI les refuse.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie,
 *     donc un mot-cle invente qu'on accepte y revient tel quel.
 */
import { describe, it, expect } from 'vitest';
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

async function surPort(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'interface FastEthernet0/1']);
  return s;
}

async function surSvi(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW2', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'interface Vlan1']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

describe('`channel-protocol`', () => {
  for (const mot of ['lacp', 'pagp']) {
    it(`\`${mot}\` est accepte et se relit`, async () => {
      const s = await surPort();
      expect(await s.executeCommand(`channel-protocol ${mot}`)).not.toMatch(REFUS);
      expect(await conf(s)).toMatch(new RegExp(`^\\s*channel-protocol ${mot}\\s*$`, 'm'));
    });
  }

  it('un protocole INVENTE est refuse, pas range', async () => {
    const s = await surPort();
    expect(await s.executeCommand('channel-protocol zorglub')).toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/channel-protocol zorglub/);
  });

  it('la commande sans argument est INCOMPLETE', async () => {
    const s = await surPort();
    expect(await s.executeCommand('channel-protocol')).toMatch(/Incomplete command/);
  });

  it('l aide annonce les deux protocoles et rien d autre', async () => {
    const s = await surPort();
    const aide = s.cliHelp('channel-protocol ');
    expect(aide).toMatch(/^\s+lacp\b/m);
    expect(aide).toMatch(/^\s+pagp\b/m);
  });

  it('une SVI la refuse', async () => {
    const s = await surSvi();
    expect(await s.executeCommand('channel-protocol lacp')).toMatch(REFUS);
  });
});

describe('`mdix auto`', () => {
  /*
   * L'auto-MDIX etant ACTIF par defaut, seul l'ecart s'ecrit. Une
   * premiere version de ce cas exigeait ` mdix auto` dans la
   * configuration, donc elle exigeait qu'un DEFAUT soit rendu.
   */
  it('le defaut ne s ecrit pas, et `no mdix auto` s ecrit', async () => {
    const s = await surPort();
    expect(await s.executeCommand('mdix auto')).not.toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/^\s*mdix auto\s*$/m);
    await jouer(s, ['configure terminal', 'interface FastEthernet0/1', 'no mdix auto']);
    expect(await conf(s)).toMatch(/^\s*no mdix auto\s*$/m);
  });

  it('un mot-cle INVENTE est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('mdix zorglub')).toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/zorglub/);
  });

  it('l aide annonce `auto`', async () => {
    const s = await surPort();
    expect(s.cliHelp('mdix ')).toMatch(/^\s+auto\b/m);
  });

  it('une SVI la refuse', async () => {
    const s = await surSvi();
    expect(await s.executeCommand('mdix auto')).toMatch(REFUS);
  });
});

describe('`power inline`', () => {
  for (const mode of ['auto', 'never', 'static']) {
    it(`\`${mode}\` est accepte et se relit`, async () => {
      const s = await surPort();
      expect(await s.executeCommand(`power inline ${mode}`)).not.toMatch(REFUS);
      expect(await conf(s)).toMatch(new RegExp(`^\\s*power inline ${mode}\\s*$`, 'm'));
    });
  }

  it('`auto max <mW>` est accepte et se relit', async () => {
    const s = await surPort();
    expect(await s.executeCommand('power inline auto max 7000')).not.toMatch(REFUS);
    expect(await conf(s)).toMatch(/^\s*power inline auto max 7000\s*$/m);
  });

  it('un mode INVENTE est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('power inline zorglub')).toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/zorglub/);
  });

  it('un `max` qui n est pas un nombre est refuse', async () => {
    const s = await surPort();
    expect(await s.executeCommand('power inline auto max zorglub')).toMatch(REFUS);
  });

  it('l aide annonce les trois modes', async () => {
    const s = await surPort();
    const aide = s.cliHelp('power inline ');
    expect(aide).toMatch(/^\s+auto\b/m);
    expect(aide).toMatch(/^\s+never\b/m);
    expect(aide).toMatch(/^\s+static\b/m);
  });

  it('une SVI la refuse', async () => {
    const s = await surSvi();
    expect(await s.executeCommand('power inline auto')).toMatch(REFUS);
  });
});
