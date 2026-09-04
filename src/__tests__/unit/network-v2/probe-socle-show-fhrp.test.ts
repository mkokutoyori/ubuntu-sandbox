/**
 * Les trois vues FHRP passent au socle, et n'y sont declarees QU'UNE fois.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires :
 *
 *   show standby [ <interface> ] [ <groupe 0-4095> ] [ brief | all ]
 *   show vrrp    [ interface <interface> ] [ <groupe 1-255> ] [ brief | all ]
 *   show glbp    [ <interface> ] [ <groupe 0-1023> ] [ brief ]
 *
 * POURQUOI CETTE FAMILLE. `show` est desormais la plus grosse tete que le
 * trie porte encore, et elle y est enregistree DEUX fois par plateforme
 * — une par vue EXEC, utilisateur puis privilegiee. Une commande du
 * socle declare ses deux modes en UNE declaration, donc migrer `show`
 * retire deux chemins du trie a chaque commande deplacee. Les trois vues
 * FHRP sont le sous-ensemble a prendre en premier : leur grammaire est
 * DEJA extraite dans `fhrpShowFilter.ts`, ecrite une fois et lue par les
 * cinq vues, donc la migration n'a pas a la redire.
 *
 * CE QUE CETTE SONDE DEMANDE : que chaque vue applique la plage de
 * groupe de SON protocole, qu'un mot de trop soit refuse, que `vrrp`
 * garde son mot-cle `interface` que les deux autres n'ont pas, que
 * `glbp` refuse `all` qu'IOS ne lui donne pas, et que la vue soit servie
 * identiquement en mode utilisateur et en mode privilegie — c'est ce que
 * la double declaration met en peril.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : le CONTENU des tableaux. Il
 * est deja epingle par `probe-vues-fhrp-filtrent-vraiment.test.ts`, qui
 * a ete ecrit pour cela ; le redire ici ferait deux sondes a tenir
 * d'accord sur un meme fait.
 *
 * CE QUE LA MESURE A TROUVE — UN seul ecart, et il est dans l'AIDE :
 *
 *   show vrrp ?  -> `brief` seul, `interface` tu
 *
 * C'est peu, et c'est normal : un lot precedent a extrait la grammaire
 * de ces trois vues dans `fhrpShowFilter.ts` et l'a eprouvee. Ce qui
 * restait est ce que ce module ne pouvait pas porter — l'ANNONCE, qui
 * venait d'une table de continuations declarant `brief` pour les trois
 * et rien d'autre, donc taisant le seul mot-cle qui distingue `vrrp` de
 * ses soeurs. Le constructeur de commande le DERIVE desormais de la
 * grammaire : `interfaceKeyword` gouverne a la fois ce que l'analyse
 * accepte et ce que `?` annonce.
 *
 * Discrimine par `git stash` sur `src/network/devices/shells/` : 1 des
 * 43 cas tombe. Les 42 autres passent des deux cotes et c'est le
 * RESULTAT ATTENDU — ce qu'ils gardent est qu'aucune des trois vues
 * n'ait change de reponse en passant de six enregistrements de trie a
 * deux declarations de socle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const nu = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function privilegie(n: string): Promise<Dev> {
  const d = nu(n);
  await d.executeCommand('enable');
  return d;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('chaque vue applique la plage de SON protocole', () => {
  const HORS_PLAGE: ReadonlyArray<readonly [string, string]> = [
    ['show standby', '4096'],
    ['show vrrp', '0'],
    ['show vrrp', '256'],
    ['show glbp', '1024'],
  ];

  it.each(HORS_PLAGE)('`%s %s` est refuse', async (vue, groupe) => {
    const d = await privilegie(`A${cle(vue + groupe)}`);
    expect(String(await d.executeCommand(`${vue} ${groupe}`))).toContain('% Invalid');
  });

  const DANS_PLAGE: ReadonlyArray<readonly [string, string]> = [
    ['show standby', '0'],
    ['show standby', '4095'],
    ['show vrrp', '1'],
    ['show vrrp', '255'],
    ['show glbp', '0'],
    ['show glbp', '1023'],
  ];

  it.each(DANS_PLAGE)('`%s %s` est accepte', async (vue, groupe) => {
    const d = await privilegie(`B${cle(vue + groupe)}`);
    expect(String(await d.executeCommand(`${vue} ${groupe}`))).not.toContain('% Invalid');
  });
});

describe('ce que ces vues ne lisent pas est refuse', () => {
  it.each(['show standby zorglub', 'show vrrp zorglub', 'show glbp zorglub',
    'show standby brief zorglub', 'show glbp all',
    'show vrrp interface zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = await privilegie(`C${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it.each(['show standby', 'show standby brief', 'show standby all',
    'show vrrp', 'show vrrp brief', 'show vrrp all',
    'show glbp', 'show glbp brief'])(
    '`%s` reste accepte', async (ligne) => {
      const d = await privilegie(`D${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });
});

describe('`vrrp` nomme son interface, les deux autres non', () => {
  it('`show vrrp interface GigabitEthernet0/0` est accepte', async () => {
    const d = await privilegie('E1');
    expect(String(await d.executeCommand('show vrrp interface GigabitEthernet0/0')))
      .not.toContain('% Invalid');
  });

  it('`show standby GigabitEthernet0/0` est accepte SANS le mot-cle', async () => {
    const d = await privilegie('E2');
    expect(String(await d.executeCommand('show standby GigabitEthernet0/0')))
      .not.toContain('% Invalid');
  });

  it('`show standby interface GigabitEthernet0/0` est refuse', async () => {
    const d = await privilegie('E3');
    expect(String(await d.executeCommand('show standby interface GigabitEthernet0/0')))
      .toContain('% Invalid');
  });
});

describe('la vue repond IDENTIQUEMENT en utilisateur et en privilegie', () => {
  it.each(['show standby', 'show standby brief', 'show vrrp', 'show glbp',
    'show standby zorglub', 'show glbp 1024'])(
    '`%s`', async (ligne) => {
      const utilisateur = nu(`F${cle(ligne)}`);
      const admin = await privilegie(`G${cle(ligne)}`);
      const enUser = String(await utilisateur.executeCommand(ligne)).trim();
      const enAdmin = String(await admin.executeCommand(ligne)).trim();
      expect(enUser, `privilegie=${JSON.stringify(enAdmin)}`).toBe(enAdmin);
    });
});

describe('`?` annonce ce que chaque vue prend', () => {
  it.each(['show standby ', 'show vrrp ', 'show glbp '])(
    '`%s?` offre `brief`', async (ligne) => {
      const d = await privilegie(`H${cle(ligne)}`);
      const offerts = d.cliHelp(ligne).split('\n')
        .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
      expect(offerts).toContain('brief');
    });

  it('`show glbp ?` n offre PAS `all`', async () => {
    const d = await privilegie('H2');
    const offerts = d.cliHelp('show glbp ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).not.toContain('all');
  });

  it('`show vrrp ?` offre `interface`', async () => {
    const d = await privilegie('H3');
    const offerts = d.cliHelp('show vrrp ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).toContain('interface');
  });
});

describe('non-regression — les vues voisines', () => {
  it.each(['show track', 'show bfd neighbors', 'show adjacency', 'show ip route'])(
    '`%s` reste accepte', async (ligne) => {
      const d = await privilegie(`I${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`show ?` annonce toujours la famille', async () => {
    const d = await privilegie('I1');
    const offerts = d.cliHelp('show ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    for (const attendu of ['standby', 'vrrp', 'glbp', 'track']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });
});
