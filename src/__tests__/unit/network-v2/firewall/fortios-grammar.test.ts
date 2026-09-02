/**
 * La grammaire FortiOS, portee par un SCHEMA et non par du code par table.
 *
 * Ce que cette suite eprouve, et pourquoi c'est le sujet de la phase 1 :
 *
 * La declinaison livree en phase 5 reconnaissait DEUX chemins de
 * configuration sur une centaine, avec deux listes blanches d'attributs
 * ecrites en dur et deux fonctions de validation. A ce rythme, cent tables
 * font cent listes et cent fonctions, et le premier attribut oublie devient
 * un `Command fail` inexplicable. La grammaire de FortiOS est REGULIERE —
 * c'est sa grande qualite — donc elle se declare.
 *
 * Trois consequences se mesurent ici, et aucune n'etait possible avant :
 *
 *   1. **`show` et `get` different.** Le premier ne rend que ce qui a ete
 *      MODIFIE, le second rend tout. La distinction est la premiere chose
 *      qu'un operateur FortiGate emploie, tous les jours — et elle exige
 *      que le schema porte les valeurs par DEFAUT, faute de quoi les deux
 *      commandes ne peuvent pas differer.
 *   2. **`unset` retablit le defaut**, ce qui n'est pas « supprimer ». Sans
 *      defaut ecrit, les deux sont indiscernables.
 *   3. **`set` remplace, `append` ajoute, `select` reduit, `unselect`
 *      retire.** Quatre verbes, quatre comportements. Sur une machine de
 *      production, `set member` sur un groupe existant est la faute
 *      classique qui coupe le service ; un simulateur qui ne reproduit pas
 *      la difference n'enseigne pas le reflexe.
 *
 * `abort` est teste separement parce qu'il est le seul verbe qui ANNULE :
 * il exige que le navigateur retienne l'etat d'avant, et un objet cree
 * puis abandonne ne doit pas subsister.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function politique(sh: FortiShell, id = '1'): void {
  run(sh, 'config firewall policy', `edit ${id}`,
    'set srcintf port1', 'set dstintf port2',
    'set srcaddr all', 'set dstaddr all',
    'set action accept', 'set service ALL', 'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('la pile de navigation', () => {
  it('l\'invite suit le sommet de la pile', () => {
    const { sh } = shell();

    expect(sh.getPrompt()).toBe('FGT1 # ');
    run(sh, 'config firewall address');
    expect(sh.getPrompt()).toBe('FGT1 (address) # ');
    run(sh, 'edit "SRV"');
    expect(sh.getPrompt()).toBe('FGT1 (SRV) # ');
    run(sh, 'next');
    expect(sh.getPrompt()).toBe('FGT1 (address) # ');
    run(sh, 'end');
    expect(sh.getPrompt()).toBe('FGT1 # ');
  });

  it('`end` depuis un objet vaut `next` puis `end`', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "SRV"');

    run(sh, 'end');

    expect(sh.getPrompt()).toBe('FGT1 # ');
  });

  it('`edit` sur un chemin inconnu est refuse en nommant le chemin', () => {
    const { sh } = shell();

    const dit = run(sh, 'config firewall zorglub');

    expect(dit).toContain('Command fail');
    expect(dit).toContain('zorglub');
  });

  it('`set` hors d\'un objet dit qu\'il faut `edit` d\'abord', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy');

    const dit = run(sh, 'set srcintf port1');

    expect(dit).toContain('Command fail');
    expect(dit).toContain('edit');
  });

  it('un attribut inconnu nomme la table et renvoie a `set ?`', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set zorglub 1');

    expect(dit).toContain('command parse error');
    expect(dit).toContain('zorglub');
    expect(dit).toContain('firewall policy');
  });
});

describe('`show` rend le MODIFIE, `get` rend TOUT', () => {
  it('`show` ne rend que les attributs poses', () => {
    const { sh } = shell();
    politique(sh);

    const vu = run(sh, 'show firewall policy');

    expect(vu).toContain('set srcintf "port1"');
    expect(vu).toContain('set action accept');
    expect(vu).not.toContain('set status');
    expect(vu).not.toContain('set logtraffic');
  });

  it('`show full-configuration` rend aussi les defauts', () => {
    const { sh } = shell();
    politique(sh);

    const vu = run(sh, 'show full-configuration firewall policy');

    expect(vu).toContain('set srcintf "port1"');
    expect(vu).toContain('set status enable');
    expect(vu).toContain('set logtraffic utm');
    expect(vu).toContain('set inspection-mode flow');
  });

  it('les deux vues different sur le meme objet — le point de la phase', () => {
    const { sh } = shell();
    politique(sh);

    const court = run(sh, 'show firewall policy');
    const complet = run(sh, 'show full-configuration firewall policy');

    expect(complet.length).toBeGreaterThan(court.length);
  });

  it('`get` rend `champ : valeur` pour tous les attributs', () => {
    const { sh } = shell();
    politique(sh);

    const vu = run(sh, 'get firewall policy 1');

    expect(vu).toMatch(/^srcintf\s+: "port1"$/m);
    expect(vu).toMatch(/^status\s+: enable$/m);
    expect(vu).toMatch(/^logtraffic\s+: utm$/m);
  });

  it('`get` sur une table sans cle liste les cles', () => {
    const { sh } = shell();
    politique(sh, '1');
    politique(sh, '2');

    const vu = run(sh, 'get firewall policy');

    expect(vu).toContain('== [ 1 ]');
    expect(vu).toContain('== [ 2 ]');
  });

  it('le quotage vient du TYPE : une reference est citee, une enumeration non', () => {
    const { sh } = shell();
    politique(sh);

    const vu = run(sh, 'show firewall policy');

    expect(vu).toContain('set srcaddr "all"');
    expect(vu).toContain('set action accept');
    expect(vu).not.toContain('set action "accept"');
  });

  it('la sortie de `show` est rejouable telle quelle', () => {
    const { sh } = shell();
    politique(sh);
    const texte = run(sh, 'show firewall policy');

    const rejoue = shell();
    for (const ligne of texte.split('\n')) rejoue.sh.execute(ligne);

    expect(run(rejoue.sh, 'show firewall policy')).toBe(texte);
  });
});

describe('`unset` retablit le DEFAUT, il ne supprime pas', () => {
  it('apres `unset`, `show` se tait et `get` rend le defaut', () => {
    const { sh } = shell();
    politique(sh);
    run(sh, 'config firewall policy', 'edit 1', 'set logtraffic all', 'next', 'end');
    expect(run(sh, 'show firewall policy')).toContain('set logtraffic all');

    run(sh, 'config firewall policy', 'edit 1', 'unset logtraffic', 'next', 'end');

    expect(run(sh, 'show firewall policy')).not.toContain('set logtraffic');
    expect(run(sh, 'get firewall policy 1')).toMatch(/^logtraffic\s+: utm$/m);
  });

  it('`unset` d\'un attribut inconnu est refuse', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'unset zorglub')).toContain('Command fail');
  });
});

describe('les quatre verbes de liste', () => {
  it('`set` REMPLACE la liste entiere', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1', 'set srcintf port1 port2');

    run(sh, 'set srcintf port3');

    expect(run(sh, 'get')).toMatch(/^srcintf\s+: "port3"$/m);
  });

  it('`append` AJOUTE sans remplacer', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1', 'set srcintf port1');

    run(sh, 'append srcintf port2');

    expect(run(sh, 'get')).toMatch(/^srcintf\s+: "port1" "port2"$/m);
  });

  it('`select` REDUIT la liste', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1', 'set srcintf port1 port2 port3');

    run(sh, 'select srcintf port2');

    expect(run(sh, 'get')).toMatch(/^srcintf\s+: "port2"$/m);
  });

  it('`unselect` RETIRE une valeur', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1', 'set srcintf port1 port2 port3');

    run(sh, 'unselect srcintf port2');

    expect(run(sh, 'get')).toMatch(/^srcintf\s+: "port1" "port3"$/m);
  });

  it('les trois verbes de liste sont refuses sur un attribut mono-value', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'append action accept')).toContain('Command fail');
    expect(run(sh, 'select action accept')).toContain('Command fail');
    expect(run(sh, 'unselect action accept')).toContain('Command fail');
  });
});

describe('`abort` annule', () => {
  it('un objet CREE puis abandonne ne subsiste pas', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "TEMPORAIRE"', 'set subnet 10.0.0.1 255.255.255.255');

    run(sh, 'abort');

    expect(run(sh, 'show firewall address')).not.toContain('TEMPORAIRE');
    expect(sh.getPrompt()).toBe('FGT1 # ');
  });

  it('un objet EXISTANT retrouve son etat d\'avant', () => {
    const { sh } = shell();
    politique(sh);

    run(sh, 'config firewall policy', 'edit 1', 'set action deny', 'abort');

    expect(run(sh, 'show firewall policy')).toContain('set action accept');
  });

  it('`abort` remonte a la racine d\'un seul coup', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    run(sh, 'abort');

    expect(sh.getPrompt()).toBe('FGT1 # ');
  });
});

describe('les verbes de table', () => {
  it('`delete` retire l\'objet de la table ET du magasin', () => {
    const { fw, sh } = shell();
    politique(sh);
    expect(fw.getPolicyStore().ordered()).toHaveLength(1);

    run(sh, 'config firewall policy', 'delete 1', 'end');

    expect(fw.getPolicyStore().ordered()).toHaveLength(0);
    expect(run(sh, 'show firewall policy')).not.toContain('edit 1');
  });

  it('`purge` vide la table entiere', () => {
    const { fw, sh } = shell();
    politique(sh, '1');
    politique(sh, '2');

    run(sh, 'config firewall policy', 'purge', 'end');

    expect(fw.getPolicyStore().ordered()).toHaveLength(0);
  });

  it('`clone` duplique, et la copie vit dans le magasin', () => {
    const { fw, sh } = shell();
    politique(sh);

    run(sh, 'config firewall policy', 'clone 1 to 5', 'end');

    expect(fw.getPolicyStore().ordered().map(r => r.id)).toEqual(['1', '5']);
    expect(run(sh, 'show firewall policy')).toContain('edit 5');
  });

  it('`rename` renomme et met a jour le magasin', () => {
    const { fw, sh } = shell();
    run(sh, 'config firewall address', 'edit "AVANT"',
      'set subnet 10.0.0.0 255.255.255.0', 'next', 'end');

    run(sh, 'config firewall address', 'rename "AVANT" to "APRES"', 'end');

    expect(fw.getObjectStore().getAddress('APRES')).toBeDefined();
    expect(fw.getObjectStore().getAddress('AVANT')).toBeUndefined();
  });

  it('`move` reordonne une table ORDONNEE', () => {
    const { fw, sh } = shell();
    politique(sh, '1');
    politique(sh, '2');
    politique(sh, '3');

    run(sh, 'config firewall policy', 'move 3 before 1', 'end');

    expect(fw.getPolicyStore().ordered().map(r => r.id)).toEqual(['3', '1', '2']);
  });

  it('`move` est refuse sur une table NON ordonnee, et le dit', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"', 'set subnet 10.0.0.0 255.0.0.0',
      'next', 'edit "B"', 'set subnet 11.0.0.0 255.0.0.0', 'next');

    const dit = run(sh, 'move "B" before "A"');

    expect(dit).toContain('Command fail');
    expect(dit).toContain('is not ordered');
  });

  it('`clone` vers une cle existante est refuse', () => {
    const { sh } = shell();
    politique(sh, '1');
    politique(sh, '2');

    expect(run(sh, 'config firewall policy', 'clone 1 to 2')).toContain('duplicate name');
  });
});

describe('la validation vient du schema', () => {
  it('une valeur hors enumeration est refusee en listant les valeurs admises', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set action zorglub');

    expect(dit).toContain('value parse error');
    expect(dit).toContain('accept');
    expect(dit).toContain('deny');
  });

  it('un entier hors bornes est refuse en nommant la borne', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    expect(run(sh, 'set color 99')).toContain('maximum 32');
  });

  it('une adresse mal formee est refusee', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    expect(run(sh, 'set subnet 999.1.1.1 255.255.255.0')).toContain('value parse error');
  });

  it('un masque manquant est refuse — l\'arite vient du type', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    expect(run(sh, 'set subnet 10.0.0.0')).toContain('Command fail');
  });

  it('une reference inexistante est refusee en nommant la table visee', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set srcaddr "FANTOME"');

    expect(dit).toContain('entry not found in datasource');
    expect(dit).toContain('firewall address');
  });

  it('une reference qui EXISTE est acceptee — le temoin', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "REEL"',
      'set subnet 10.0.0.0 255.255.255.0', 'next', 'end');

    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set srcaddr "REEL"')).toBe('');
  });

  it('un attribut en lecture seule est refuse', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set policyid 7')).toContain('read-only');
  });
});

describe('les attributs conditionnels', () => {
  it('`start-ip` n\'existe pas tant que le type n\'est pas `iprange`', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    expect(run(sh, 'set start-ip 10.0.0.1')).toContain('Command fail');
  });

  it('il apparait des que le type le rend applicable', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"', 'set type iprange');

    expect(run(sh, 'set start-ip 10.0.0.1')).toBe('');
  });

  it('`get` ne rend pas un attribut inapplicable', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"', 'set subnet 10.0.0.0 255.0.0.0',
      'next', 'end');

    const vu = run(sh, 'get firewall address A');

    expect(vu).toContain('subnet');
    expect(vu).not.toContain('start-ip');
  });

  it('`poolname` n\'apparait que si `ippool` est actif', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');
    expect(run(sh, 'get')).not.toContain('poolname');

    run(sh, 'set ippool enable');

    expect(run(sh, 'get')).toContain('poolname');
  });
});

describe('les trois familles de refus', () => {
  it('un attribut connu de FortiOS mais non simule nomme la brique manquante', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set auto-asic-offload enable');

    expect(dit).toContain('Command fail');
    expect(dit).toContain('hardware acceleration');
  });

  it('`set application` est refuse plutot que d\'installer une regle inerte', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set application 15832');

    expect(dit).toContain('FortiGuard signature');
  });

  it('un attribut inexistant recoit le refus de FortiOS, pas celui-la', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set zorglub 1');

    expect(dit).toContain('command parse error');
    expect(dit).not.toContain('FortiGate');
  });

  it('un attribut non simule n\'est rendu par aucune vue', () => {
    const { sh } = shell();
    politique(sh);

    const vu = run(sh, 'show full-configuration firewall policy');

    expect(vu).not.toContain('auto-asic-offload');
  });

  it('`write memory` nomme le comportement reel de FortiOS', () => {
    const { sh } = shell();

    const dit = run(sh, 'write memory');

    expect(dit).toContain('automatically');
  });

  it('les notes de simulateur sont supprimables', () => {
    const { sh } = shell();
    sh.setHints(false);
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set zorglub 1');

    expect(dit).not.toContain('NOTE:');
    expect(dit).toContain('Command fail');
    sh.setHints(true);
  });
});

describe('l\'aide et la completion viennent du schema', () => {
  it('`?` a la racine liste les verbes de premier niveau', () => {
    const { sh } = shell();

    const aide = run(sh, '?');

    expect(aide).toContain('config');
    expect(aide).toContain('Configure object.');
  });

  it('`config ?` liste les branches declarees', () => {
    const { sh } = shell();

    const aide = run(sh, 'config ?');

    expect(aide).toContain('firewall');
  });

  it('`config firewall ?` liste les tables de la branche avec leur aide', () => {
    const { sh } = shell();

    const aide = run(sh, 'config firewall ?');

    expect(aide).toContain('policy');
    expect(aide).toContain('address');
    expect(aide).toContain('Configure IPv4/IPv6 policies.');
  });

  it('`set ?` sur un objet liste SES attributs', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const aide = run(sh, 'set ?');

    expect(aide).toContain('srcintf');
    expect(aide).toContain('Incoming (ingress) interface.');
  });

  it('`set action ?` liste les valeurs de l\'enumeration', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const aide = run(sh, 'set action ?');

    expect(aide).toContain('accept');
    expect(aide).toContain('Allow session that match this policy.');
    expect(aide).toContain('deny');
  });

  it('`set ?` ne propose pas un attribut inapplicable', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    const aide = run(sh, 'set ?');

    expect(aide).toContain('subnet');
    expect(aide).not.toContain('start-ip');
  });

  it('`set ?` ne propose pas un attribut en lecture seule', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set ?')).not.toContain('policyid');
  });

  it('la completion propose les branches depuis le schema', () => {
    const { sh } = shell();

    expect(sh.completions('config firewall ')).toContain('config firewall policy');
  });

  it('la completion propose les attributs de l\'objet ouvert', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(sh.completions('set src')).toContain('set srcintf');
  });

  it('aucun attribut du schema n\'est depourvu d\'aide', async () => {
    const { FORTIOS_SCHEMA } = await import(
      '@/network/devices/firewall/vendors/fortios/schema');

    for (const spec of FORTIOS_SCHEMA) {
      expect(spec.help.length, `table ${spec.path.join(' ')}`).toBeGreaterThan(0);
      for (const attribute of spec.attributes) {
        expect(attribute.help.length,
          `${spec.path.join(' ')} / ${attribute.name}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('le commit vers le socle', () => {
  it('rejouer `edit` sur un objet existant ne duplique pas la regle', () => {
    const { fw, sh } = shell();
    politique(sh);

    run(sh, 'config firewall policy', 'edit 1', 'set comments "relu"', 'next', 'end');

    expect(fw.getPolicyStore().ordered()).toHaveLength(1);
  });

  it('`edit` sur une table ordonnee conserve la position', () => {
    const { fw, sh } = shell();
    politique(sh, '1');
    politique(sh, '2');
    politique(sh, '3');

    run(sh, 'config firewall policy', 'edit 1', 'set comments "relu"', 'next', 'end');

    expect(fw.getPolicyStore().ordered().map(r => r.id)).toEqual(['1', '2', '3']);
  });

  it('`abort` n\'ecrit rien dans le magasin', () => {
    const { fw, sh } = shell();

    run(sh, 'config firewall policy', 'edit 9',
      'set srcintf port1', 'set action accept', 'abort');

    expect(fw.getPolicyStore().ordered()).toHaveLength(0);
  });

  it('les valeurs par defaut atteignent le magasin', () => {
    const { fw, sh } = shell();
    politique(sh);

    const rule = fw.getPolicyStore().ordered()[0];

    expect(rule.enabled).toBe(true);
    expect(rule.schedule).toBeUndefined();
  });
});

/**
 * Ce que le moteur de commandes PARTAGE apporte, et que la phase 1
 * n'avait pas.
 *
 * La grammaire etait servie par une aide et une completion ecrites dans
 * `FortiShell` : une liste de verbes par contexte, un filtre par prefixe,
 * un rendu en deux colonnes. Cela fonctionnait — et c'etait un SECOND
 * moteur, alors que `src/cli/` en porte un, ecrit pour Cisco et l'ASA,
 * qui fait davantage.
 *
 * Les cinq acquis mesures ici n'etaient possibles ni l'un ni l'autre
 * avant la migration :
 *
 *   1. **Les abreviations** non ambigues, parce qu'une CLI qui les refuse
 *      n'est pas une CLI qu'on peut utiliser.
 *   2. **L'ambiguite nommee** plutot que le premier de la liste : un
 *      prefixe qui designe plusieurs commandes n'en designe aucune.
 *   3. **Les bornes reelles** dans l'aide — `<0-32>` et non le nom de
 *      l'attribut. Une plage annoncee fausse envoie chercher la vraie
 *      dans la documentation.
 *   4. **`<cr>`** quand la commande est complete, ce qui distingue « il
 *      manque quelque chose » de « on peut valider ».
 *   5. **Les references se completent pour de bon** : `set srcaddr ?`
 *      liste les objets qui EXISTENT. C'est le gain qui n'etait pas
 *      prevu, et il vient de ce que la table est batie par contexte.
 */
describe('le moteur de commandes partage', () => {
  it('une abreviation non ambigue est acceptee', () => {
    const { fw, sh } = shell();

    run(sh, 'conf firewall address', 'edit "ABREGE"',
      'set sub 10.0.0.0 255.255.255.0', 'next', 'end');

    expect(fw.getObjectStore().getAddress('ABREGE')).toBeDefined();
  });

  it('une abreviation ambigue est refusee en nommant les candidats', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'se srcaddr "all"');

    expect(dit).toContain('ambigu');
    expect(dit).toContain('select');
  });

  // Le mot SUIVANT ne departage pas : la resolution du verbe precede
  // l'analyse de ses arguments, ici comme sur la vraie machine. Fortinet
  // l'ecrit dans ses references CLI (FortiOS, FortiADC, FortiWeb) :
  // « Valid command lines must be unambiguous if abbreviated », et
  // « you can abbreviate words in the command line to their smallest
  // number of non-ambiguous characters ». `se` n'est pas ce plus petit
  // nombre pour `set` tant que `select` existe -- et `select` est bien
  // offert dans un contexte `edit`.
  it('une abreviation ambigue le RESTE, quel que soit ce qui suit', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'se action accept')).toContain('ambigu');
    expect(run(sh, 'se srcaddr "all"')).toContain('ambigu');
  });

  it('un prefixe plus long departage, et le verbe est alors resolu', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    // `sel` ne prefixe que `select` : ce qui manque est la VALEUR, pas
    // le verbe -- sans ce cas, un moteur qui refuserait TOUTE
    // abreviation passerait celui d'au-dessus.
    const dit = run(sh, 'sel srcaddr');
    expect(dit).not.toContain('ambigu');
    expect(dit).toContain('missing');
  });

  // Ce qui departage n'est pas l'attribut mais le CONTEXTE : `select`
  // n'est offert que la ou il y a une liste dont selectionner une
  // valeur. Un objet `firewall address` n'a aucun attribut multivalue,
  // donc `select` n'y existe pas et `se` designe `set` sans ambiguite --
  // tandis qu'une politique, qui a `srcaddr`, `dstaddr` et `service`,
  // l'offre. Les deux contextes ci-dessous ne se contredisent donc pas.
  it('sans attribut multivalue, `select` n existe pas et `se` suffit', () => {
    const { fw, sh } = shell();
    run(sh, 'config firewall address', 'edit "SANS-LISTE"');

    expect(run(sh, 'se subnet 10.8.0.0 255.255.255.0')).not.toContain('ambigu');
    expect(run(sh, 'sel subnet 10.8.0.0')).toContain('unknown command');
    run(sh, 'next', 'end');

    expect(fw.getObjectStore().getAddress('SANS-LISTE')?.value).toBe('10.8.0.0');
  });

  it('`?` annonce la plage REELLE d\'un entier', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    expect(run(sh, 'set color ?')).toContain('<0-32>');
  });

  it('`?` annonce le type d\'une adresse', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "A"');

    expect(run(sh, 'set subnet ?')).toContain('A.B.C.D');
  });

  it('`?` rend `<cr>` quand la commande est complete', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set action accept ?')).toContain('<cr>');
  });

  it('les references se completent sur ce qui EXISTE', () => {
    const { sh } = shell();
    run(sh, 'config firewall address', 'edit "SRV_WEB"',
      'set subnet 10.0.0.5 255.255.255.255', 'next',
      'edit "SRV_MAIL"', 'set subnet 10.0.0.6 255.255.255.255', 'next', 'end');

    run(sh, 'config firewall policy', 'edit 1');
    const aide = run(sh, 'set srcaddr ?');

    expect(aide).toContain('SRV_WEB');
    expect(aide).toContain('SRV_MAIL');
  });

  it('un objet cree APRES la premiere aide y apparait — le cache suit', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');
    expect(run(sh, 'set srcaddr ?')).not.toContain('TARDIF');

    run(sh, 'abort', 'config firewall address', 'edit "TARDIF"',
      'set subnet 10.9.9.0 255.255.255.0', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set srcaddr ?')).toContain('TARDIF');
  });

  it('`edit ?` propose les cles qui existent', () => {
    const { sh } = shell();
    politique(sh, '1');
    politique(sh, '7');

    run(sh, 'config firewall policy');

    const aide = run(sh, 'edit ?');
    expect(aide).toContain('1');
    expect(aide).toContain('7');
  });

  it('`move` n\'est propose que sur une table ordonnee', () => {
    const { sh } = shell();

    run(sh, 'config firewall policy');
    expect(run(sh, '?')).toContain('move');

    run(sh, 'end', 'config firewall address');
    expect(run(sh, '?')).not.toContain('move');
  });

  it('l\'aide d\'un objet ne propose que les verbes qui s\'y appliquent', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const aide = run(sh, '?');

    expect(aide).toContain('set');
    expect(aide).toContain('next');
    expect(aide).toContain('abort');
    expect(aide).not.toContain('edit');
    expect(aide).not.toContain('purge');
  });

  it('`append` n\'est propose que pour un attribut de LISTE', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'append ?')).toContain('srcaddr');
    expect(run(sh, 'append ?')).not.toContain('action');
  });

  it('`set ?` decrit chaque attribut, pas son nom', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    const aide = run(sh, 'set ?');

    expect(aide).toContain('Incoming (ingress) interface.');
    expect(aide).toContain('Enable/disable source NAT.');
  });

  it('`config ?` decrit la BRANCHE et non sa premiere table', () => {
    const { sh } = shell();

    expect(run(sh, '?')).toContain('Configure object.');
  });

  it('la completion `TAB` rend le mot unique', () => {
    const { sh } = shell();
    run(sh, 'config firewall policy', 'edit 1');

    expect(sh.completions('set srcin')).toContain('set srcintf');
  });
});
