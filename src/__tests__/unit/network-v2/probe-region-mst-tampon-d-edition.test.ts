/*
 * Le sous-mode de region MST n'avait PAS de tampon d'edition : chaque
 * mot tape s'appliquait au pont vivant a l'instant meme, donc `abort`
 * n'abandonnait rien, `show pending` et `show current` repondaient la
 * meme chose, et — sur VRP — `active region-configuration` activait une
 * region qui tournait deja.
 *
 * Les deux constructeurs decrivent le contraire, chacun dans sa langue.
 *
 * Cisco : « To leave the MST configuration submode WITHOUT COMMITTING
 * any changes, enter the abort command » ; « to leave the submode and
 * COMMIT all the changes that you made, enter the exit command » ;
 * « show pending shows the MST configuration that has been recently
 * configured, BUT NOT APPLIED ».
 *
 * Huawei : « The new parameters of the MST region DO NOT TAKE EFFECT
 * until you run the active region-configuration command » ; « before
 * running active region-configuration, it is recommended that you run
 * the check region-configuration command to check the configurations of
 * the MST region THAT HAVE NOT TAKEN EFFECT ».
 *
 * Les deux plateformes nomment donc UNE seule notion manquante — une
 * region en attente, distincte de la region en service — et c'est
 * pourquoi elle est posee sur `StpAgent`, que les deux coquilles
 * partagent deja, plutot que deux fois dans deux coquilles.
 *
 * Mesure sur la grammaire, avant correctif, dans le meme sous-mode :
 *
 *   name                 ->  ""  (le nom de region devenait VIDE)
 *   name ?               ->  WORD / <cr>
 *   revision ?           ->  WORD / <cr>
 *   instance ?           ->  WORD / <cr>
 *   instance 1 ?         ->  WORD / <cr>
 *   instance 1           ->  ""  (instance associee a AUCUN vlan)
 *   instance 1 10-20     ->  ""  (le mot-cle `vlan` etait facultatif)
 *   no                   ->  ""
 *   no zorglub           ->  ""
 *   no instance          ->  ""
 *   abort zorglub        ->  ""  (et la sortie avait lieu)
 *   abort ?              ->  WORD / <cr>
 *   ?                    ->  « show » seul, sans description
 *
 * Les cinq `<cr>` MENTENT : l'aide promet que la frappe valide la, et
 * quatre des cinq validations repondent par un refus ; le cinquieme
 * (`name`) « valide » en effacant le nom de region, ce qu'aucun
 * operateur ne demande en tapant un mot-cle nu.
 *
 * `instance 1 10-20` sans `vlan` est le piege de la copie permissive :
 * la documentation ecrit `instance instance-id vlan vlan-range`, le
 * moteur de rendu ecrit `instance 1 vlan 10-20`, et seul l'analyseur
 * acceptait la forme courte — donc une forme que la machine reelle
 * refuse et qu'aucun import ne produit.
 *
 * `stp enable` n'est PAS traite ici : Huawei ecrit que la region prend
 * effet « ou en activant MSTP », sans nommer la commande, et le meme
 * document ne permet pas de choisir entre `stp enable` et
 * `stp mode mstp`. Faute de source atteignable — support.huawei.com
 * repond sur la recherche mais pas au telechargement depuis ce reseau —
 * seule l'activation EXPLICITE est modelee.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 24 des 43 cas
 * tombent. Les 19 autres sont nommes :
 *
 *  - TEMOIN de tampon : `exit` valide, et apres `exit` les deux vues
 *    coincident. Ils passaient deja — precisement parce que tout etait
 *    applique d'emblee — et sans eux un tampon qui n'ecrirait JAMAIS
 *    rien passerait ce fichier en entier.
 *  - TEMOIN Huawei : `check region-configuration` montre ce qui vient
 *    d'etre tape (il lisait le vivant, il lit l'attente : meme reponse,
 *    autre raison), et la region ACTIVEE se lit dans `display stp
 *    region-configuration`.
 *  - NON-REGRESSION de grammaire : les six formes legitimes et les
 *    trois refus qui marchaient deja (`revision 99999`, `revision abc`,
 *    `instance 9999 vlan 10`). Un fichier qui ne ferait que refuser les
 *    passerait toutes en refusant tout.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

const descriptionDe = (aide: string, mot: string): string | undefined => {
  for (const ligne of aide.split('\n')) {
    if (MOT.exec(ligne)?.[1] === mot) return ligne.trim().split(/\s{2,}/)[1];
  }
  return undefined;
};

let serie = 0;

async function region(...edition: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'spanning-tree mst configuration',
    ...edition]) {
    await d.executeCommand(c);
  }
  return d;
}

const nomRendu = (vue: string): string => /Name\s+\[(.*)\]/.exec(vue)?.[1] ?? '(absent)';

async function vueAppliquee(d: Cli): Promise<string> {
  return String(await d.executeCommand('do show spanning-tree mst configuration'));
}

describe('la region MST est EDITEE avant d\'etre appliquee — Cisco', () => {
  describe('`abort` abandonne, `exit` valide', () => {
    it('`abort` rend la region telle qu\'elle etait en entrant', async () => {
      const d = await region('name LAB', 'revision 7', 'instance 1 vlan 10-20');
      await d.executeCommand('abort');
      const vue = await vueAppliquee(d);
      expect(nomRendu(vue), 'le nom abandonne a quand meme ete pose').toBe('');
      expect(vue, 'l\'instance abandonnee a quand meme ete posee').not.toMatch(/10-20/);
    });

    it('`exit` valide ce qui a ete edite — le TEMOIN', async () => {
      const d = await region('name LAB', 'revision 7', 'instance 1 vlan 10-20');
      await d.executeCommand('exit');
      const vue = await vueAppliquee(d);
      expect(nomRendu(vue)).toBe('LAB');
      expect(vue).toMatch(/10-20/);
    });

    it('`end` valide aussi', async () => {
      const d = await region('name LAB');
      await d.executeCommand('end');
      expect(nomRendu(String(await d.executeCommand(
        'show spanning-tree mst configuration')))).toBe('LAB');
    });

    it('une edition abandonnee ne laisse rien dans la configuration', async () => {
      const d = await region('name LAB', 'revision 7');
      await d.executeCommand('abort');
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show running-config')))
        .not.toMatch(/name LAB|revision 7/);
    });
  });

  describe('`show pending` et `show current` sont DEUX vues', () => {
    it('`show current` ignore ce qui n\'est pas encore valide', async () => {
      const d = await region('name LAB');
      expect(nomRendu(String(await d.executeCommand('show current')))).toBe('');
    });

    it('`show pending` montre ce qui vient d\'etre tape', async () => {
      const d = await region('name LAB');
      expect(nomRendu(String(await d.executeCommand('show pending')))).toBe('LAB');
    });

    it('apres `exit` les deux vues coincident — le TEMOIN', async () => {
      const d = await region('name LAB', 'revision 7');
      await d.executeCommand('exit');
      await d.executeCommand('spanning-tree mst configuration');
      expect(String(await d.executeCommand('show pending')))
        .toBe(String(await d.executeCommand('show current')));
    });
  });

  describe('un mot-cle nu est INCOMPLET, pas une valeur vide', () => {
    it.each(['name', 'revision', 'instance', 'instance 1', 'no', 'no instance'])(
      '`%s` est INCOMPLET', async (ligne) => {
        const d = await region();
        expect(await d.executeCommand(ligne), ligne).toMatch(/Incomplete command/);
      });

    it('`name` nu n\'efface pas le nom de region', async () => {
      const d = await region('name LAB');
      await d.executeCommand('name');
      expect(nomRendu(String(await d.executeCommand('show pending')))).toBe('LAB');
    });

    it('`instance 1` nu n\'associe pas une instance vide', async () => {
      const d = await region('instance 1');
      expect(String(await d.executeCommand('show pending'))).not.toMatch(/^1\s*$/m);
    });
  });

  describe('les `<cr>` annonces sont tenus', () => {
    it.each(['name', 'revision', 'instance', 'instance 1', 'no'])(
      '`%s ?` ne promet pas `<cr>`', async (frappe) => {
        const d = await region();
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ?`).toBe(false);
      });

    it('`abort ?` ne propose que `<cr>`', async () => {
      const d = await region();
      const aide = d.cliHelp('abort ');
      expect(motsDe(aide).filter((m) => m !== '<cr>')).toEqual([]);
      expect(annonceCr(aide), 'abort ? n\'annonce plus le <cr> qu\'il tient').toBe(true);
    });
  });

  describe('l\'aide annonce ce que la commande attend', () => {
    it('`instance 1 ?` annonce `vlan`, pas un WORD', async () => {
      const d = await region();
      expect(motsDe(d.cliHelp('instance 1 '))).toContain('vlan');
    });

    it('`show` porte une description', async () => {
      const d = await region();
      expect(descriptionDe(d.cliHelp(''), 'show')).toBeTruthy();
    });
  });

  describe('un mot de trop est refuse', () => {
    it.each(['abort zorglub', 'no zorglub', 'instance 1 10-20'])(
      '`%s` est refuse', async (ligne) => {
        const d = await region();
        expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
      });

    it('`abort zorglub` ne quitte pas le sous-mode', async () => {
      const d = await region();
      await d.executeCommand('abort zorglub');
      expect(await d.executeCommand('name LAB'), 'la sortie a eu lieu quand meme')
        .not.toMatch(/Invalid input/);
    });
  });

  it('le sous-mode ne garde plus aucun chemin sur le trie', async () => {
    const d = await region();
    const arbre = (d as unknown as {
      shell: { configMstTrie: { enumerateExecutablePaths(): string[] } };
    }).shell.configMstTrie;
    expect(arbre.enumerateExecutablePaths()).toEqual([]);
  });

  describe('ce qui marchait marche encore — les NON-REGRESSIONS', () => {
    it.each([
      ['name LAB', 'LAB'],
      ['name TRES-LONG-NOM', 'TRES-LONG-NOM'],
    ] as Array<[string, string]>)('`%s` se pose et se relit', async (ligne, attendu) => {
      const d = await region(ligne, 'exit');
      expect(nomRendu(await vueAppliquee(d))).toBe(attendu);
    });

    it.each(['revision 7', 'instance 1 vlan 10-20', 'instance 2 vlan 10,20'])(
      '`%s` reste accepte', async (ligne) => {
        const d = await region();
        expect(await d.executeCommand(ligne), ligne).not.toMatch(/Invalid|Incomplete/);
      });

    it.each(['revision 99999', 'revision abc', 'instance 9999 vlan 10'])(
      '`%s` reste refuse', async (ligne) => {
        const d = await region();
        expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
      });

    it('`no name` / `no revision` / `no instance` defont l\'edition', async () => {
      const d = await region('name LAB', 'revision 7', 'instance 3 vlan 30',
        'no name', 'no revision', 'no instance 3', 'exit');
      const vue = await vueAppliquee(d);
      expect(nomRendu(vue)).toBe('');
      expect(vue).toMatch(/Revision\s+0/);
      expect(vue).not.toMatch(/\b30\b/);
    });
  });
});

async function commutateurVrp(...edition: string[]): Promise<Cli> {
  const d = new HuaweiSwitch('switch-huawei', `H${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of ['system-view', 'stp region-configuration', ...edition]) {
    await d.executeCommand(c);
  }
  return d;
}

async function vueOper(d: Cli): Promise<string> {
  await d.executeCommand('quit');
  return String(await d.executeCommand('display stp region-configuration'));
}

describe('la region MST est EDITEE avant d\'etre activee — Huawei', () => {
  it('une region non activee ne se lit pas dans la vue OPER', async () => {
    const d = await commutateurVrp('region-name LAB', 'revision-level 7');
    const vue = await vueOper(d);
    expect(vue, 'la region non activee est deja en service').not.toMatch(/LAB/);
    expect(vue).not.toMatch(/Revision level\s*:7/);
  });

  it('`check region-configuration` montre ce qui attend — le TEMOIN', async () => {
    const d = await commutateurVrp('region-name LAB', 'revision-level 7');
    const vue = String(await d.executeCommand('check region-configuration'));
    expect(vue).toMatch(/LAB/);
    expect(vue).toMatch(/7/);
  });

  it('`active region-configuration` met la region en service — le TEMOIN', async () => {
    const d = await commutateurVrp('region-name LAB', 'revision-level 7',
      'instance 1 vlan 10', 'active region-configuration');
    const vue = await vueOper(d);
    expect(vue).toMatch(/LAB/);
    expect(vue).toMatch(/Revision level\s*:7/);
  });

  it('la configuration ne porte `active region-configuration` qu\'une fois active',
    async () => {
      const edite = await commutateurVrp('region-name LAB');
      await edite.executeCommand('quit');
      expect(String(await edite.executeCommand('display current-configuration')),
        'une region jamais activee se relit comme activee')
        .not.toMatch(/active region-configuration/);

      const actif = await commutateurVrp('region-name LAB', 'active region-configuration');
      await actif.executeCommand('quit');
      expect(String(await actif.executeCommand('display current-configuration')))
        .toMatch(/active region-configuration/);
    });

  it('la region editee survit a `quit` — VRP n\'abandonne pas', async () => {
    const d = await commutateurVrp('region-name LAB');
    await d.executeCommand('quit');
    await d.executeCommand('stp region-configuration');
    expect(String(await d.executeCommand('check region-configuration'))).toMatch(/LAB/);
  });

  it('`undo stp region-configuration` efface l\'edition ET le service', async () => {
    const d = await commutateurVrp('region-name LAB', 'active region-configuration');
    await d.executeCommand('quit');
    await d.executeCommand('undo stp region-configuration');
    await d.executeCommand('stp region-configuration');
    expect(String(await d.executeCommand('check region-configuration'))).not.toMatch(/LAB/);
  });
});
