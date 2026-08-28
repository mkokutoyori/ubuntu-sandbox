import type { CommandTrie, ParamSpec } from '../CommandTrie';

const IP = (name: string, description: string): ParamSpec =>
  ({ name, type: 'IP_ADDR', description });
const MASK = (description: string): ParamSpec =>
  ({ name: 'mask', type: 'SUBNET_MASK', description });
const INT = (
  name: string, range: readonly [number, number], description: string,
): ParamSpec => ({ name, type: 'INT', description, range });
const WORD = (name: string, description: string): ParamSpec =>
  ({ name, type: 'WORD', description });
const LINE = (name: string, description: string): ParamSpec =>
  ({ name, type: 'STRING', description });

export interface HuaweiArgumentHelpTries {
  system: CommandTrie;
  iface: CommandTrie;
  ospf: CommandTrie;
  vty: CommandTrie;
  /** La vue utilisateur, ou vit toute la famille `display`. */
  user: CommandTrie;
}

/**
 * Ce que l'aide de VRP DIT derrière un argument déjà saisi.
 *
 * La couche B existait pour le routeur puis le switch Cisco et
 * s'arrêtait là : `HuaweiVRPShell` ne déclarait aucun argument, si bien
 * qu'un `?` derrière une valeur ne pouvait rien annoncer. Chaque plage
 * écrite ici a été éprouvée aux quatre bords contre le gestionnaire qui
 * l'applique — une plage annoncée que la commande n'applique pas est le
 * défaut que ce mécanisme est censé corriger, pas un progrès.
 */
export function describeHuaweiArguments(tries: HuaweiArgumentHelpTries): void {
  tries.iface.describeArgs('ip address', [
    IP('address', 'IP address'),
    { ...MASK('Mask or mask-length'), optional: true },
  ]);
  tries.iface.describeArgs('description', [
    LINE('text', 'Interface description'),
  ]);

  tries.system.describeArgs('sysname', [
    WORD('name', 'Host name of the device'),
  ]);
  tries.system.describeArgs('ip route-static', [
    IP('prefix', 'Destination IP address'),
    { ...MASK('Mask or mask-length'), optional: true },
  ]);
  // `ospf` seul entre dans le processus 1 sur VRP : l'identifiant est
  // donc OPTIONNEL, et le déclarer obligatoire refusait la forme nue.
  tries.system.describeArgs('ospf', [
    { ...INT('process-id', [1, 65535], 'Process ID'), optional: true },
  ]);

  tries.ospf.describeArgs('router-id', [
    IP('router-id', 'Router ID in IP address format'),
  ]);

  tries.vty.describeArgs('idle-timeout', [
    INT('minutes', [0, 35791], 'Idle timeout in minutes'),
    { name: 'seconds', type: 'INT', description: 'Idle timeout in seconds',
      optional: true, range: [0, 59] },
  ]);

  declarerAritesVrp(tries);
}

/**
 * L'ARITE MINIMALE de ce qui en avait une et ne la declarait pas.
 *
 * `<cr>` s'affiche des qu'un noeud porte une action et que son arite
 * minimale vaut zero. Ces noeuds-la ne declaraient aucun parametre,
 * donc elle valait zero, donc la machine annoncait qu'on peut valider
 * `acl`, `dns domain`, `local-user` ou `undo` — quarante-cinq commandes
 * auxquelles il manque un mot, et qui repondent « Incomplete command »
 * a la validation.
 *
 * La liste vient d'un BALAYAGE de l'arbre d'aide
 * (`probe-aide-vrp-tient-ses-promesses.test.ts`), pas d'une inspection
 * a l'oeil : c'est lui qui les a nommees, et lui qui nommera la
 * suivante.
 */
function declarerAritesVrp(tries: HuaweiArgumentHelpTries): void {
  for (const chemin of [
    'acl', 'acl name', 'acl number', 'arp static', 'cpu-defend policy',
    'dns domain', 'dns server', 'ike peer', 'ike proposal',
    'ikev2 keychain', 'ikev2 keyring', 'ikev2 policy', 'ikev2 profile',
    'ikev2 proposal', 'info-center', 'info-center console',
    'info-center monitor', 'info-center snmpagent', 'info-center timestamp',
    'ip host', 'ip ip-prefix', 'ip ipv6-prefix', 'ipsec profile',
    'ipsec proposal', 'ipsec security-policy', 'ipv6 route-static',
    'local-user', 'nat address-group', 'nqa test-instance', 'ntp-service',
    'route-policy', 'screen-length', 'screen-width', 'traffic behavior',
    'traffic classifier', 'traffic policy',
    'undo', 'undo acl', 'undo info-center', 'undo nqa-server',
    'undo route-policy', 'clock timezone', 'time-range', 'port-group', 'undo port-group',
  ]) tries.system.requireArgs(chemin, 1);
  // `arp static` prend une adresse ET une MAC : un seul argument la
  // laisse incomplete.
  tries.system.requireArgs('arp static', 2);
  tries.system.requireArgs('ip host', 2);
  // `debugging` et son `undo` vivent dans les deux vues.
  for (const trie of [tries.system, tries.vty]) {
    trie.requireArgs('debugging', 1);
    trie.requireArgs('undo debugging', 1);
  }
  // La famille `display` est enregistree dans CHAQUE vue par
  // `registerDisplayThis` : declarer l'arite sur la seule vue systeme
  // laisserait la vue utilisateur annoncer le `<cr>` qu'on vient d'y
  // retirer, et les deux vues se contrediraient sur la meme commande.
  for (const trie of [tries.user, tries.system]) {
    trie.requireArgs('display acl', 1);
    trie.requireArgs('display current-configuration interface', 1);
    trie.requireArgs('display dhcp', 1);
  }
  // `acl` ne se distingue pas par le NOMBRE d'arguments mais par leur
  // contenu : `acl 2000` se valide, `acl name` attend encore le nom —
  // un seul argument dans les deux cas. C'est ce que `executableWhen`
  // existe pour dire, et l'arite seule ne pouvait pas l'exprimer.
  tries.system.executableWhen('acl',
    (args) => !(args.length === 1 && /^(name|number|basic|advanced)$/i.test(args[0])));
  // `clock` est glouton : `clock timezone` compte pour un argument, donc
  // l'arite est satisfaite alors qu'il manque le nom du fuseau.
  tries.system.executableWhen('clock',
    (args) => !(args.length === 1 && args[0].toLowerCase() === 'timezone'));
  // `port-group NOM` entre dans le groupe nomme, `port-group
  // group-member` attend encore ses ports : un seul argument dans les
  // deux cas, donc l'arite ne peut pas les separer.
  tries.system.executableWhen('port-group',
    (args) => !(args.length === 1 && args[0].toLowerCase() === 'group-member'));
  // Deux `<cr>` que le balayage ne pouvait pas voir tant que la commande
  // repondait « mot inconnu » : corriger le refus les a decouverts.
  tries.system.requireArgs('multicast', 1);
  // Meme forme que `acl` : `display logbuffer` se valide nu, et
  // `display logbuffer level` attend encore la severite — un seul
  // argument dans les deux cas, donc l'arite ne peut pas les separer.
  for (const trie of [tries.user, tries.system]) {
    trie.executableWhen('display logbuffer',
      (args) => !(args.length === 1 && args[0].toLowerCase() === 'level'));
  }
  // Deux noeuds INTERMEDIAIRES nes de l'enregistrement de chemins plus
  // profonds (`reset acl counter`, `reset ntp-service statistics
  // packet`), donc sans description propre : `?` les offrait nus. La
  // description d'un enfant vient du noeud, jamais de la table des
  // mots-cles, et `describeNode` sort en silence sur un noeud absent —
  // l'appel doit donc SUIVRE l'enregistrement qui le cree, ce que cette
  // fonction fait par construction.
  for (const trie of [tries.user, tries.system]) {
    trie.describeNode('reset acl', 'Access Control List');
    trie.describeNode('reset ntp-service', 'Network Time Protocol');
  }
}
