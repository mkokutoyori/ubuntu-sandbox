/**
 * Les interrupteurs IP globaux repondent la MEME chose sur les deux
 * plateformes Cisco.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires :
 *
 *   [no] ip routing              acheminement IP        defaut : routeur OUI,
 *                                                       commutateur NON
 *   [no] ip classless            defaut ACTIF depuis 12.0
 *   [no] ip subnet-zero          defaut ACTIF
 *   [no] ip multicast-routing    defaut INACTIF
 *   ip default-gateway A.B.C.D   commutateur, quand `ip routing` est coupe
 *   ip default-network A.B.C.D   routeur
 *
 * POURQUOI CETTE FAMILLE. Elle est portee par les DEUX plateformes et
 * enregistree DEUX fois — une par coquille — donc c'est le lieu ou une
 * divergence ne se voit pas : la meme frappe peut deja repondre deux
 * choses selon la machine, et personne ne le remarquerait. Le but du
 * chantier est justement que l'experience soit la meme sur tout
 * equipement Cisco ; une famille commune est ce qu'il faut migrer en
 * premier, parce que le socle est partage par les deux coquilles
 * (`CiscoShellBase.socleSpecs`) la ou le trie ne l'est pas.
 *
 * CE QUE CETTE SONDE DEMANDE, et qui ne depend d'aucune lecture du code :
 * qu'un mot de trop soit refuse, qu'un defaut reste TU dans la
 * configuration et qu'une coupure y paraisse (c'est la seule des deux
 * qui soit une information, et la configuration est REJOUEE a l'import
 * d'une topologie), qu'une adresse malformee soit refusee au lieu d'etre
 * rangee, et que les deux plateformes repondent identiquement la ou
 * elles portent la meme commande.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : que `no ip routing` prive un
 * routeur de sa table. L'effet de ces interrupteurs sur le plan de
 * donnees est un autre sujet, et l'un d'eux — `ip classless` — n'a plus
 * d'effet observable sur un IOS moderne non plus.
 *
 * CE QUE LA MESURE A TROUVE :
 *
 *   ip classless          -> ACCEPTE sur un routeur, REFUSE sur un
 *                            Catalyst (le guide de configuration du
 *                            3560 documente pourtant les deux)
 *   no ip classless       -> ACCEPTE, range NULLE PART, rendu nulle part
 *   no ip subnet-zero     -> idem
 *   no ip routing zorglub -> ACCEPTE des deux cotes
 *   ip default-network 10.0.0.0 zorglub  -> ACCEPTE
 *   no ip default-network zorglub        -> ACCEPTE
 *   ip local policy route-map A B        -> ACCEPTE, garde `A`
 *   ip default-gateway 10.0.0.1 zorglub  -> ACCEPTE
 *
 * La forme POSITIVE de `ip classless` / `ip subnet-zero` a raison de ne
 * rien ranger : c'est le defaut d'IOS depuis la 12.0, et une machine ne
 * rend pas ce dont elle ne s'ecarte pas — le commentaire du
 * gestionnaire le dit et il est juste. C'est la NEGATIVE qui etait
 * perdue, et elle est la seule des deux a etre une information.
 *
 * Discrimine par `git stash` sur les six fichiers cables : 14 des 55
 * cas tombent avant migration. Les 41 autres sont la non-regression et
 * les cas que le trie servait deja correctement — `ip routing` des deux
 * cotes, les adresses malformees, `?` sur les places d'adresse — sans
 * lesquels une migration qui casserait la famille satisferait la sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

async function enConfig(d: Dev): Promise<Dev> {
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

const routeur = (n: string) => enConfig(new CiscoRouter(n) as unknown as Dev);
const commutateur = (n: string) =>
  enConfig(new CiscoSwitch('switch-cisco', n) as unknown as Dev);

const PLATEFORMES: ReadonlyArray<readonly [string, (n: string) => Promise<Dev>]> = [
  ['routeur', routeur], ['commutateur', commutateur],
];

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

const cle = (s: string) => s.replace(/\W/g, '');

/** Les interrupteurs que les DEUX plateformes portent. */
const COMMUNS: readonly string[] = ['ip routing', 'ip classless', 'ip subnet-zero'];

describe('un mot de trop est refuse, et il l est des deux cotes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it.each(COMMUNS)(`\`%s zorglub\` est refuse sur un ${nom}`, async (ligne) => {
      const d = await faire(`A${nom[0]}${cle(ligne)}`);
      expect(String(await d.executeCommand(`${ligne} zorglub`))).toContain('% Invalid');
    });

    it.each(COMMUNS)(`\`no %s zorglub\` est refuse sur un ${nom}`, async (ligne) => {
      const d = await faire(`B${nom[0]}${cle(ligne)}`);
      expect(String(await d.executeCommand(`no ${ligne} zorglub`))).toContain('% Invalid');
    });
  }
});

describe('la meme frappe recoit la meme reponse sur les deux plateformes', () => {
  it.each([...COMMUNS, ...COMMUNS.map((c) => `no ${c}`),
    ...COMMUNS.map((c) => `${c} zorglub`)])(
    '`%s`', async (ligne) => {
      const r = await routeur(`C${cle(ligne)}`);
      const s = await commutateur(`D${cle(ligne)}`);
      const surR = String(await r.executeCommand(ligne)).trim();
      const surS = String(await s.executeCommand(ligne)).trim();
      expect(surS, `routeur=${JSON.stringify(surR)}`).toBe(surR);
    });
});

describe('un defaut reste TU, une coupure paraît', () => {
  it('un routeur neuf ne rend ni `ip classless` ni `ip subnet-zero`', async () => {
    const d = await routeur('E1');
    const cfg = await config(d);
    expect(cfg).not.toContain('ip classless');
    expect(cfg).not.toContain('ip subnet-zero');
  });

  it.each(['no ip classless', 'no ip subnet-zero'])(
    '`%s` PARAIT dans la configuration', async (ligne) => {
      const d = await routeur(`E${cle(ligne)}`);
      await d.executeCommand(ligne);
      expect(await config(d)).toContain(ligne);
    });

  it('et reposer le defaut fait disparaitre la ligne', async () => {
    const d = await routeur('E2');
    await d.executeCommand('no ip classless');
    expect(await config(d)).toContain('no ip classless');
    await d.executeCommand('ip classless');
    expect(await config(d)).not.toContain('no ip classless');
  });

  it('`ip multicast-routing` PARAIT, son defaut etant inactif', async () => {
    const d = await routeur('E3');
    await d.executeCommand('ip multicast-routing');
    expect(await config(d)).toContain('ip multicast-routing');
  });
});

describe('une adresse malformee est refusee, pas rangee', () => {
  it.each(['ip default-network zorglub', 'ip default-network 999.1.1.1'])(
    '`%s` est refuse sur un routeur', async (ligne) => {
      const d = await routeur(`F${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
      expect(await config(d)).not.toContain('default-network');
    });

  it.each(['ip default-gateway zorglub', 'ip default-gateway 999.1.1.1'])(
    '`%s` est refuse sur un commutateur', async (ligne) => {
      const d = await commutateur(`G${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
      expect(await config(d)).not.toContain('default-gateway');
    });

  it.each(['ip default-network', 'ip default-gateway'])(
    '`%s` sans adresse dit INCOMPLET', async (ligne) => {
      const d = ligne.endsWith('gateway')
        ? await commutateur(`H${cle(ligne)}`) : await routeur(`H${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Incomplete command.');
    });
});

describe('un reglage a UNE valeur ne prend pas le mot de trop', () => {
  it.each(['ip default-network 10.0.0.0 zorglub',
    'no ip default-network zorglub',
    'ip local policy route-map CARTE zorglub'])(
    '`%s` est refuse sur un routeur', async (ligne) => {
      const d = await routeur(`L${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it.each(['ip default-gateway 10.0.0.1 zorglub', 'no ip default-gateway zorglub'])(
    '`%s` est refuse sur un commutateur', async (ligne) => {
      const d = await commutateur(`M${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it('et le mot de trop ne laisse rien dans la configuration', async () => {
    const d = await routeur('L2');
    await d.executeCommand('ip default-network 10.0.0.0 zorglub');
    await d.executeCommand('ip local policy route-map CARTE zorglub');
    const cfg = await config(d);
    expect(cfg).not.toContain('default-network');
    expect(cfg).not.toContain('local policy');
  });

  it.each(['no ip default-network', 'ip local policy route-map CARTE'])(
    '`%s` reste accepte sur un routeur', async (ligne) => {
      const d = await routeur(`N${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`no ip default-gateway` sans adresse reste accepte', async () => {
    const d = await commutateur('N2');
    await d.executeCommand('ip default-gateway 10.0.0.1');
    expect(String(await d.executeCommand('no ip default-gateway'))).not.toContain('%');
    expect(await config(d)).not.toContain('default-gateway');
  });
});

describe('`?` annonce une adresse la ou la commande en prend une', () => {
  it('`ip default-network ?` annonce A.B.C.D', async () => {
    const d = await routeur('I1');
    expect(d.cliHelp('ip default-network ')).toContain('A.B.C.D');
  });

  it('`ip default-gateway ?` annonce A.B.C.D', async () => {
    const d = await commutateur('I2');
    expect(d.cliHelp('ip default-gateway ')).toContain('A.B.C.D');
  });

  it.each(COMMUNS)('`%s ?` n annonce que `<cr>`', async (ligne) => {
    const d = await routeur(`I${cle(ligne)}`);
    const offerts = d.cliHelp(`${ligne} `).split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).toEqual(['<cr>']);
  });
});

describe('ce que ces commandes POSENT se relit', () => {
  it('`ip default-network 10.0.0.0` est rendu tel quel', async () => {
    const d = await routeur('J1');
    expect(String(await d.executeCommand('ip default-network 10.0.0.0')))
      .not.toContain('%');
    expect(await config(d)).toContain('ip default-network 10.0.0.0');
  });

  it('`ip default-gateway 10.0.0.1` est rendu tel quel', async () => {
    const d = await commutateur('J2');
    expect(String(await d.executeCommand('ip default-gateway 10.0.0.1')))
      .not.toContain('%');
    expect(await config(d)).toContain('ip default-gateway 10.0.0.1');
  });

  it('`no ip routing` PARAIT sur un routeur, dont c est la coupure', async () => {
    const d = await routeur('J3');
    await d.executeCommand('no ip routing');
    expect(await config(d)).toContain('no ip routing');
  });

  it('`ip routing` PARAIT sur un commutateur, dont c est l activation', async () => {
    const d = await commutateur('J4');
    await d.executeCommand('ip routing');
    expect(await config(d)).toContain('ip routing');
  });
});

describe('non-regression — les voisines de la famille `ip`', () => {
  it.each(['ip prefix-list LISTE permit 10.0.0.0/8',
    'ip community-list 1 permit 100:1',
    'ip as-path access-list 1 permit ^$',
    'ip local policy route-map CARTE'])(
    '`%s` reste accepte sur un routeur', async (ligne) => {
      const d = await routeur(`K${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`ip access-list standard NOM` reste accepte sur un commutateur', async () => {
    const d = await commutateur('K2');
    expect(String(await d.executeCommand('ip access-list standard NOM')))
      .not.toContain('% Invalid');
  });
});
