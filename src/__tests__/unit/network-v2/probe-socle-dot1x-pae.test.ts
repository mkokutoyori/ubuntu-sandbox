/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation Catalyst, sur la
 * DERNIERE commande de configuration d'interface que le commutateur
 * servait par son trie en dehors de celles dont la grammaire n'est pas
 * attestee.
 *
 * Ce que la reference dit : `dot1x pae { supplicant | authenticator |
 * both }` fixe le role 802.1X du port. Ce simulateur n'implemente que
 * l'authentificateur, et le dit avec ses propres mots — ce qui est une
 * information pour l'apprenant, donc le role doit etre ANNONCE par
 * l'aide et REFUSE par le gestionnaire, et non refuse par l'analyseur
 * avec un caret qui n'expliquerait rien.
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

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

describe('`dot1x pae`', () => {
  it('`authenticator` est accepte et se relit', async () => {
    const s = await surPort();
    expect(await s.executeCommand('dot1x pae authenticator')).not.toMatch(REFUS);
    expect(await conf(s)).toMatch(/^\s*dot1x pae authenticator\s*$/m);
  });

  it('`supplicant` est REFUSE en disant pourquoi', async () => {
    const s = await surPort();
    const out = await s.executeCommand('dot1x pae supplicant');
    expect(out).toContain('authenticator');
    expect(out).not.toMatch(/Invalid input/);
  });

  it('un role INVENTE est refuse et rien n est range', async () => {
    const s = await surPort();
    expect(await s.executeCommand('dot1x pae zorglub')).toMatch(REFUS);
    expect(await conf(s)).not.toMatch(/zorglub/);
  });

  it('la commande sans role est INCOMPLETE', async () => {
    const s = await surPort();
    expect(await s.executeCommand('dot1x pae')).toMatch(/Incomplete command/);
  });

  it('l aide annonce les trois roles de la norme', async () => {
    const s = await surPort();
    const aide = s.cliHelp('dot1x pae ');
    for (const mot of ['authenticator', 'both', 'supplicant']) {
      expect(aide, mot).toMatch(new RegExp(`^\\s+${mot}\\b`, 'm'));
    }
  });

  it('`no dot1x pae authenticator` retire le role', async () => {
    const s = await surPort();
    await s.executeCommand('dot1x pae authenticator');
    await jouer(s, ['configure terminal', 'interface FastEthernet0/1',
      'no dot1x pae authenticator']);
    expect(await conf(s)).not.toMatch(/dot1x pae/);
  });
});
