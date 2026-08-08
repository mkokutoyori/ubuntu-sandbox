/**
 * Sonde — sur VRP, ce que `?` propose, la machine l'accepte.
 *
 * Mesure de départ, routeur et switch neufs, vue système :
 *
 *   interface ?   →  WORD  Enter interface view
 *                    <cr>
 *   interface     →  Error: Incomplete command.
 *
 * L'aide annonçait qu'on pouvait valider là, et la machine refusait sur
 * la ligne suivante. Même contradiction pour `ip pool`, `ip host`,
 * `stp`, `vlan`, `port`. La cause n'était PAS dans le rendu de l'aide :
 * `CommandTrie.isExecutableAt` consulte déjà `requiredArity`, laquelle
 * valait zéro parce que ces commandes sont enregistrées par
 * `registerGreedy`, qui ne déclare aucun paramètre. La trie les croyait
 * complètes ; le handler, lui, savait que non.
 *
 * Trois défauts voisins sont vérifiés ici avec le premier, parce
 * qu'ils relèvent de la même question — l'aide dit-elle vrai :
 * la liste des types d'interface remplaçait `WORD` ; des mots-clés
 * étaient proposés sans description ; d'autres portaient la
 * description d'une AUTRE commande, récupérée dans un dictionnaire
 * global par mot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';

async function routeur(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('AR1');
  await r.executeCommand('system-view');
  return r;
}

async function commutateur(): Promise<HuaweiSwitch> {
  const s = new HuaweiSwitch('LSW1');
  await s.executeCommand('system-view');
  return s;
}

/** Les mots-clés proposés par `?`, sans le `<cr>` final. */
function motsCles(aide: string): string[] {
  return aide.split('\n')
    .map(l => l.match(/^ {2}(\S+)/)?.[1])
    .filter((k): k is string => !!k && k !== '<cr>');
}

/** Les mots-clés proposés SANS description — une promesse sans contenu. */
function sansDescription(aide: string): string[] {
  return aide.split('\n')
    .map(l => l.match(/^ {2}(\S+)\s*$/)?.[1])
    .filter((k): k is string => !!k && k !== '<cr>');
}

const AVEC_CR = /^ {2}<cr>/m;

describe('Sonde VRP — `?` ne promet plus ce que la machine refuse', () => {
  let r: HuaweiRouter;
  let s: HuaweiSwitch;
  beforeEach(async () => { r = await routeur(); s = await commutateur(); });

  it('`interface ?` ne propose plus `<cr>`, et `interface` reste refusé', async () => {
    const aide = await r.executeCommand('interface ?');
    expect(aide).not.toMatch(AVEC_CR);
    expect(await r.executeCommand('interface')).toContain('Incomplete command');
  });

  it('`interface ?` nomme les TYPES au lieu de `WORD`', async () => {
    const mots = motsCles(await r.executeCommand('interface ?'));
    expect(mots).toContain('GigabitEthernet');
    expect(mots).toContain('LoopBack');
    expect(mots).toContain('Vlanif');
    expect(mots).toContain('Eth-Trunk');
    expect(mots).not.toContain('WORD');
  });

  it('chaque type proposé est réellement accepté — l\'aide ne nomme pas un refus', async () => {
    // Un type PHYSIQUE ne s'ouvre qu'au numéro que porte le châssis ;
    // un type virtuel s'ouvre à n'importe lequel, puisqu'il est créé à
    // la demande. Les numéros se lisent donc sur la machine plutôt que
    // de se supposer — et le châssis les nomme `GE0/0/0` là où l'aide
    // dit `GigabitEthernet`, les deux écritures se résolvant vers le
    // même port ; comparer les préfixes ne marcherait pas.
    const numeros = [...new Set(
      [...r.getPortNames()].map(p => p.replace(/^[A-Za-z-]+/, '')))];
    for (const type of motsCles(await r.executeCommand('interface ?'))) {
      const essais = [...numeros, '0'].map(n => `interface ${type}${n}`);
      let ouvert: string | null = null;
      for (const cmd of essais) {
        if (!(await r.executeCommand(cmd)).includes('Error:')) {
          ouvert = cmd;
          await r.executeCommand('quit');
          break;
        }
      }
      expect(ouvert, `aucune des formes ${essais.join(' | ')} n'est acceptée`).not.toBeNull();
    }
  });

  it('un type NU est refusé, et l\'aide ne propose donc pas `<cr>` derrière lui', async () => {
    // Le numéro s'écrit collé au type ou séparé de lui : compter les
    // jetons ne peut pas trancher, les regarder le peut.
    expect(await r.executeCommand('interface GigabitEthernet ?')).not.toMatch(AVEC_CR);
    expect(await r.executeCommand('interface GigabitEthernet')).toContain('Error:');
    expect(await r.executeCommand('interface GigabitEthernet0/0/0')).not.toContain('Error:');
  });

  it('les deux écritures du numéro restent acceptées', async () => {
    expect(await r.executeCommand('interface GigabitEthernet 0/0/0')).not.toContain('Error:');
    await r.executeCommand('quit');
    expect(await r.executeCommand('interface GigabitEthernet0/0/0')).not.toContain('Error:');
  });

  it('`ip pool` et `ip host` ne promettent plus `<cr>` non plus', async () => {
    expect(await r.executeCommand('ip pool ?')).not.toMatch(AVEC_CR);
    expect(await r.executeCommand('ip pool')).toContain('Incomplete command');
  });

  it('le refus nomme la position, comme VRP', async () => {
    const sortie = await r.executeCommand('interface');
    expect(sortie).toContain("Incomplete command found at '^' position.");
    expect(sortie).toContain('^');
  });

  it('`ospf`, qui s\'exécute nu, garde son `<cr>` — la règle n\'est pas « retirer partout »', async () => {
    expect(await r.executeCommand('ospf ?')).toMatch(AVEC_CR);
    expect(await r.executeCommand('ospf')).not.toContain('Error:');
  });

  it('switch : `vlan ?` annonce la plage, et `vlan` seul est refusé', async () => {
    const aide = await s.executeCommand('vlan ?');
    expect(aide).toContain('<1-4094>');
    expect(aide).not.toMatch(AVEC_CR);
    expect(await s.executeCommand('vlan')).toContain('Incomplete command');
    expect(await s.executeCommand('vlan 10')).not.toContain('Error:');
  });

  it('switch : `interface ?` nomme les types au lieu du seul `range`', async () => {
    const mots = motsCles(await s.executeCommand('interface ?'));
    expect(mots).toContain('GigabitEthernet');
    expect(mots).toContain('Vlanif');
    expect(await s.executeCommand('interface ?')).not.toMatch(AVEC_CR);
  });

  it('switch : `stp ?` propose ce que le handler accepte, et rien d\'autre', async () => {
    const mots = motsCles(await s.executeCommand('stp ?'));
    expect(mots).toEqual(expect.arrayContaining(
      ['enable', 'disable', 'mode', 'priority', 'root', 'instance', 'region-configuration']));
    // `primary` et `secondary` appartiennent à `stp root`, pas à `stp` :
    // ils étaient extraits du texte du handler et proposés un niveau
    // trop haut.
    expect(mots).not.toContain('primary');
    expect(mots).not.toContain('secondary');
    expect(await s.executeCommand('stp')).toContain('Incomplete command');
  });

  it('switch : `stp ?` ne recopie plus la description d\'une autre commande', async () => {
    const aide = await s.executeCommand('stp ?');
    expect(aide).not.toContain('Set trunking mode of the interface');
    expect(aide).not.toContain('Set appliance 802.1p priority');
    expect(aide).toContain('Set the spanning tree mode');
    expect(aide).toContain('Set the bridge priority');
  });

  it('en vue interface, `stp ?` propose les mots-clés de l\'INTERFACE', async () => {
    await s.executeCommand('interface GigabitEthernet0/0/1');
    const mots = motsCles(await s.executeCommand('stp ?'));
    expect(mots).toContain('edged-port');
    expect(mots).toContain('root-protection');
    expect(mots).not.toContain('region-configuration');
  });

  it('aucun mot-clé n\'est proposé sans description', async () => {
    const racines = ['display', 'ip', 'user-interface', 'acl', 'stp', 'interface',
      'vlan', 'ospf', 'rip', 'nqa', 'info-center', 'port', 'nat', 'qos'];
    const nus: string[] = [];
    for (const [nom, dev] of [['routeur', r], ['switch', s]] as const) {
      for (const racine of racines) {
        for (const k of sansDescription(await dev.executeCommand(`${racine} ?`))) {
          nus.push(`${nom} : ${racine} ? → ${k}`);
        }
      }
    }
    expect(nus, `mots-clés proposés sans rien dire :\n  ${nus.join('\n  ')}`).toEqual([]);
  });

  it('`user-interface ?` décrit ses types, `maximum-vty` compris', async () => {
    const aide = await r.executeCommand('user-interface ?');
    expect(aide).toMatch(/maximum-vty\s+\S/);
    expect(aide).toMatch(/console\s+\S/);
    expect(aide).toMatch(/vty\s+\S/);
  });

  it('`acl ?` décrit `basic` et `advanced` au lieu de les lister nus', async () => {
    const aide = await r.executeCommand('acl ?');
    expect(aide).toMatch(/basic\s+\S/);
    expect(aide).toMatch(/advanced\s+\S/);
  });

  it('aucune description ne se contente de répéter son mot-clé', async () => {
    // `display ip ?` répondait « source  Source ». Un nœud créé en
    // chemin reçoit sa propre clé pour description ; c'est vrai, et ça
    // n'apprend rien.
    const racines = ['display', 'display ip', 'display interface', 'ip',
      'user-interface', 'acl', 'interface'];
    const tautologies: string[] = [];
    for (const [nom, dev] of [['routeur', r], ['switch', s]] as const) {
      for (const racine of racines) {
        for (const l of (await dev.executeCommand(`${racine} ?`)).split('\n')) {
          const m = l.match(/^ {2}(\S+)\s+(\S.*?)\s*$/);
          if (m && m[1].toLowerCase() === m[2].toLowerCase()) {
            tautologies.push(`${nom} : ${racine} ? → ${m[1]}  ${m[2]}`);
          }
        }
      }
    }
    expect(tautologies,
      `descriptions qui répètent leur mot-clé :\n  ${tautologies.join('\n  ')}`).toEqual([]);
  });
});
