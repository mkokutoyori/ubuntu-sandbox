/**
 * Ce que `?` propose derrière `interface`, et pourquoi `<cr>` n'y est
 * plus.
 *
 * Le défaut mesuré n'était pas dans le rendu de l'aide :
 * `CommandTrie.isExecutableAt` consulte déjà `requiredArity`, et cette
 * arité était juste. Elle valait ZÉRO, parce que ces commandes sont
 * enregistrées par `registerGreedy`, qui ne déclare aucun paramètre —
 * la trie les croyait exécutables telles quelles, proposait `<cr>` en
 * toute logique, et c'est le HANDLER qui refusait ensuite
 * (`Error: Incomplete command.`). L'aide et la machine se
 * contredisaient sur la même ligne.
 *
 * Décrire l'argument est donc un seul geste pour deux défauts : il
 * nomme les types dans l'aide, et il porte l'arité du nœud à un, ce
 * qui retire le `<cr>`.
 *
 * Ce fichier est distinct de `huaweiArgumentHelp.ts`, qui appartient à
 * un autre lot et décrit ce que l'aide dit APRÈS un argument déjà
 * saisi. Les deux moitiés se complètent sans se toucher.
 */

import type { CommandTrie, ParamSpec } from '../CommandTrie';
import { HUAWEI_INTERFACE_PREFIXES } from '../cli-utils';

const TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'Eth-Trunk': 'Ethernet-Trunk interface',
  GigabitEthernet: 'GigabitEthernet interface',
  LoopBack: 'LoopBack interface',
  NULL: 'NULL interface',
  Nve: 'NVE interface',
  Tunnel: 'Tunnel interface',
  Vlanif: 'Vlanif interface',
};

/**
 * Les types que `interface` accepte, déduits de la table que le
 * résolveur consulte lui-même (`HUAWEI_INTERFACE_PREFIXES`) plutôt
 * qu'écrits une seconde fois. Une liste tenue à part finirait par
 * nommer un type que la commande refuse — ce serait le défaut qu'on
 * corrige, dans l'autre sens.
 *
 * Elle ne dépend pas du châssis, et c'est exact : un routeur sans
 * `Vlanif` accepte quand même `interface Vlanif 10`, puisque le
 * résolveur crée l'interface virtuelle à la demande. La trie est
 * d'ailleurs bâtie AVANT que l'équipement soit lié — la référence
 * n'est posée que le temps d'une commande — donc une liste tirée du
 * châssis ne serait pas seulement moins juste, elle serait
 * indisponible.
 *
 * Le validateur accepte tout : l'opérateur tape le nom complet en un
 * seul jeton (`interface GigabitEthernet0/0/0`), et l'aide n'a pas à
 * devenir un refus.
 */
export function huaweiInterfaceTypeParam(): ParamSpec {
  const vus = new Map<string, string>();
  for (const candidats of Object.values(HUAWEI_INTERFACE_PREFIXES)) {
    const nom = candidats[candidats.length - 1];
    if (!vus.has(nom)) vus.set(nom, TYPE_DESCRIPTIONS[nom] ?? `${nom} interface`);
  }
  return {
    name: 'type', type: 'ENUM', description: 'Interface type',
    validator: () => true,
    values: [...vus.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([keyword, description]) => ({ keyword, description })),
  };
}

/**
 * `interface ?` nomme les types, `interface GigabitEthernet ?` nomme
 * le numéro.
 *
 * Les deux sont déclarés comme DEUX arguments du même nœud, et non par
 * un nœud indicatif sous chaque type. Ce détour a été essayé et
 * mesuré : `describeArgs` minuscule la clé du nœud qu'il crée, si bien
 * que la liste des types revenait mi-`LoopBack` mi-`loopback`, les
 * seconds portant en prime une description prise au dictionnaire
 * global (`loopback  Set the loopback mode`, celle d'un tout autre
 * usage du mot). Un seul nœud à deux arguments dit la même chose sans
 * fabriquer d'enfant.
 *
 * Le numéro est OPTIONNEL parce que l'opérateur écrit le plus souvent
 * `interface GigabitEthernet0/0/0` en un seul jeton. Le déclarer
 * requis interdirait cette forme-là ; le laisser optionnel déplaçait
 * simplement le `<cr>` menteur d'un jeton vers la droite, derrière un
 * type nu. C'est `executableWhen` qui tranche, en REGARDANT les
 * arguments au lieu de les compter.
 */
export function describeHuaweiInterfaceArg(trie: CommandTrie): void {
  trie.describeArgs('interface', [
    huaweiInterfaceTypeParam(),
    {
      name: 'number', type: 'WORD',
      description: 'Interface number', optional: true,
    },
  ]);
  // Un type nu ne désigne aucune interface : `interface GigabitEthernet`
  // est refusé par le résolveur, donc l'aide ne doit pas y proposer
  // `<cr>`. Le numéro peut être collé au type ou séparé de lui, ce que
  // l'arité seule ne sait pas exprimer — d'où le prédicat.
  trie.executableWhen('interface', (args) => args.some(a => /\d/.test(a)));
}

export function wordArg(description: string, name = 'name'): ParamSpec {
  return { name, type: 'WORD', description };
}

/**
 * Les sous-commandes de `stp`, telles que le handler les accepte — et
 * c'est la raison de les écrire plutôt que de les laisser deviner.
 * Sans elles, `autoContinuations` les extrait du texte du handler et
 * va chercher leur description dans un dictionnaire GLOBAL par mot :
 * `mode` héritait de « Set trunking mode of the interface », qui est
 * celle de `port link-type`, et `priority` de « Set appliance 802.1p
 * priority », qui est celle de QoS. Un mot-clé curaté sort de
 * l'extraction et emporte sa propre description.
 */
export const STP_SYSTEM_KEYWORDS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'bpdu-protection', description: 'Enable BPDU protection on edged ports' },
  { keyword: 'converge', description: 'Set the convergence mode' },
  { keyword: 'disable', description: 'Disable spanning tree' },
  { keyword: 'edged-port', description: 'Configure the default edged-port attribute' },
  { keyword: 'enable', description: 'Enable spanning tree' },
  { keyword: 'instance', description: 'Configure a multiple spanning tree instance' },
  { keyword: 'mode', description: 'Set the spanning tree mode' },
  { keyword: 'pathcost-standard', description: 'Set the path-cost standard' },
  { keyword: 'priority', description: 'Set the bridge priority' },
  { keyword: 'region-configuration', description: 'Enter MST region view' },
  { keyword: 'root', description: 'Set this bridge as root or secondary root' },
  { keyword: 'tc-protection', description: 'Enable topology-change protection' },
  { keyword: 'timer', description: 'Set a spanning tree timer' },
];

export const STP_INTERFACE_KEYWORDS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'bpdu-filter', description: 'Enable or disable the BPDU filter' },
  { keyword: 'bpdu-protection', description: 'Enable or disable BPDU protection' },
  { keyword: 'cost', description: 'Set the path cost of the port' },
  { keyword: 'disable', description: 'Disable spanning tree on the port' },
  { keyword: 'edged-port', description: 'Configure the port as an edged port' },
  { keyword: 'enable', description: 'Enable spanning tree on the port' },
  { keyword: 'instance', description: 'Configure the port in an instance' },
  { keyword: 'loop-protection', description: 'Enable loop protection' },
  { keyword: 'port', description: 'Set the port priority' },
  { keyword: 'root-protection', description: 'Enable root protection' },
  { keyword: 'tc-restriction', description: 'Restrict topology-change propagation' },
];
