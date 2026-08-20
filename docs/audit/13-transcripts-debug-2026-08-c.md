# Analyse des transcripts de debug — régénération du 4 août 2026 (3ᵉ passe)

## 0. Ce qui a été fait

Les 125 transcripts de `debug-output/` ont été régénérés en entier
(`npx vitest run src/__tests__/debug/`, 93 fichiers de suite).
**93/93 suites passent.**

Cette passe suit l'audit 12, dont les quatre priorités ont été livrées
(`conntrack`, `clock set`, `ip address negotiated`, `display
port-security interface`), et le lot « route statique et shutdown »
livré juste après.

L'extracteur est **le même fichier** que celui de l'audit 12, rejoué à
l'identique sur l'ancien jeu avant de l'être sur le nouveau : il rend
967 lignes de refus et 84 candidats sur l'ancien, exactement les
chiffres publiés. La comparaison porte donc sur la même méthode, pas sur
une mesure qui aurait bougé entre les deux passes.

## 1. Le résultat, et il est net

| | audit 12 | audit 13 |
|---|---|---|
| lignes de refus | 967 | 955 |
| formes de commande distinctes refusées | 114 | 104 |
| candidats après filtrage | 84 | 74 |
| **formes NOUVELLEMENT refusées** | 0 | **0** |

**Aucune régression observable.** Les 10 formes qui ont cessé d'être
refusées correspondent une à une au lot de l'audit 12, sans exception ni
surplus :

- `clock set <h>:<m>:<s> <jour> June <année>` (2 fichiers)
- `ip address negotiated`
- `conntrack -L` et `conntrack -S` sur les 4 machines Linux (`ldc`,
  `lbr`, `lhq`, `srvdc`)

## 2. Le résultat le plus important de cette passe n'est pas dans les chiffres

**Cet extracteur ne voit que des REFUS. Il est structurellement aveugle
à la classe de défauts « accepté, et sans effet ».**

Ce n'est pas une remarque théorique, c'est ce que cette session vient de
démontrer deux fois. Le lot « route statique » a corrigé deux défauts
majeurs :

- `ip route … permanent` — le mot-clé était **accepté** puis jeté
  silencieusement, et la route disparaissait au `shutdown`, soit
  l'inverse exact de ce que le mot-clé sert à obtenir ;
- la forme `clock set` en mode configuration — **acceptée**, rendant la
  main sans rien changer à l'heure.

Aucun des deux n'a jamais produit une ligne de refus. **Aucun des deux
n'aurait pu apparaître dans cette analyse**, ni dans celle de l'audit
12, ni dans les onze précédentes. Une commande refusée se voit ; une
commande qui ment ne se voit pas.

Deux des trois manques réels ci-dessous ont d'ailleurs été trouvés de
cette manière — en vérifiant un candidat sur équipement et en regardant
ce qui se passait *à côté*, pas en lisant la liste.

**Conséquence pour la suite** : la régénération des transcripts mesure
la couverture de la CLI, pas sa fidélité. Pour la fidélité, il faut des
sondes qui vérifient l'effet, comme
`probe-route-statique-et-shutdown.test.ts` le fait pour `permanent`.

## 3. La méthode a révélé un sixième piège

Les cinq pièges connus (sections de test négatif, suites de cohérence
qui doublent chaque commande, cascades, fautes de frappe délibérées,
préfixe de l'invite) sont traités par l'extracteur.

**Sixième piège — la normalisation numérique efface le « hors gamme ».**
L'extracteur remplace tout nombre par `<n>` pour regrouper les formes.
`vlan 99999` devient donc `vlan <n>`, indiscernable d'un `vlan 10`
légitime. Vérifié dans le transcript : la ligne refusée est
`[375/401] swdc SW-DC> vlan 99999` — un test négatif délibéré sur un
identifiant hors gamme. Le même effet aurait pu masquer un vrai manque
dans l'autre sens.

C'est la sixième fois que la méthode doit être corrigée, et la règle qui
en découle n'a pas changé : **on ne conclut rien d'un compte, on vérifie
sur équipement.**

## 4. Les manques réels, vérifiés sur équipement

### 4.1 `rate-limit` (CAR) — accepté, non mémorisé, non affichable

Mesuré sur un routeur neuf, interface existante et configurée :

```
(config-if)# rate-limit output 8000000 1500000 3000000 conform-action transmit exceed-action drop
             -> ""                              (accepté)
show running-config | include rate-limit
             -> aucune ligne                    (non mémorisé)
show interfaces GigabitEthernet0/0 rate-limit
             -> % Invalid input detected        (aucune vue)
```

Les trois moitiés sont cohérentes entre elles et fausses ensemble : la
commande est acceptée, rien ne la retient, et il n'existe aucune vue
pour la contredire. Un lab qui applique une politique CAR croit l'avoir
appliquée.

À noter, parce que c'est ce qui distingue ce cas des autres : les autres
sous-formes de `show interfaces` fonctionnent toutes sur une interface
existante — `accounting`, `stats`, `switchport` rendent leur tableau.
Seule `rate-limit` manque, et c'est cohérent avec le fait qu'il n'y a
rien derrière à afficher.

### 4.2 La famille `archive` est absente du switch Cisco, présente sur le routeur

Mesuré côte à côte :

| commande | routeur | switch |
|---|---|---|
| `archive` (config) | acceptée | `% Invalid input` |
| `path flash:archive/cfg` | acceptée | `% Invalid input` |
| `maximum 5` | acceptée | `% Invalid input` |
| `write-memory` | acceptée | `% Invalid input` |
| `show archive` | rend un état | `% Invalid input` |

Huit formes, toutes dans le même fichier
(`cisco-l2-09-system-operations`), toutes sur un switch. `archive` et
`show archive` existent sur un vrai Catalyst ; le bloc est enregistré
par `CiscoEemNetflowArchiveCommands.ts` pour le routeur et n'a pas
d'équivalent dans `CiscoSwitchShell`.

### 4.3 Sur le routeur, `show archive` ne reflète pas ce qui vient d'être configuré

Trouvé en vérifiant 4.2, **pas dans la liste des candidats** — puisque
rien n'est refusé. Après `archive` + `path flash:archive/cfg` +
`maximum 5`, tous acceptés, `show archive` rend toujours
`No archives configured / no revisions captured.`

Réserve d'honnêteté : je n'ai pas déterminé si la cause est le stockage
ou le passage en mode `config-archive`, et les deux demandent de lire
l'implémentation, pas de mesurer. Ce qui est établi, c'est l'écart
observable entre ce qui est accepté et ce qui est rendu — même classe
que 4.1.

### 4.4 Les quatre derniers — TRAITÉS : un implémenté, trois refusés à raison

**`crypto isakmp key … hostname <nom>` : implémenté, et il cachait deux
défauts.** Tout ce qu'il fallait existait déjà — un pair configuré
`crypto isakmp identity hostname` annonce son nom dans l'offre IKE, et le
répondeur cherche la clé par cette identité AVANT l'adresse source. Mais
écrire la commande ne suffisait pas : (1) la table `ip host` range les
noms en minuscules, à raison (RFC 4343), si bien qu'une clé posée sous
`rB` ne se retrouvait pas ; (2) la clé est cherchée à TROIS endroits —
émission, réception, et vérification de la réponse par l'initiateur — et
ce dernier ne connaissait que l'adresse, donc l'initiateur rejetait sa
propre session pour « PSK mismatch » après avoir pourtant trouvé la clé à
l'émission. Défaut voisin corrigé au passage : `no crypto isakmp key …
hostname NOM` retirait l'entrée joker `0.0.0.0` au lieu de la bonne.

Un tunnel monte maintenant réellement avec des clés posées par nom, et
des clés discordantes échouent — vérifié par ping traversant, avec une
**référence par adresse montée dans le même banc**, sans laquelle un lab
mal monté et une fonctionnalité cassée seraient indiscernables.

**Les trois autres sont refusés, et le refus est le bon comportement.**

- **`ipv6 ospf hello-interval` / `dead-interval`.** OSPFv3 forme son
  adjacence hors-bande (`RouterOSPFIntegration.v3FormAdjacency`, appelée
  directement, sans aucun échange de Hello) et ne porte aucun champ de
  minuterie. Les accepter stockerait une valeur que rien ne lirait —
  exactement la décision prise pour le mode nommé d'EIGRP au lot 8.
- **`show module`.** Les trois profils châssis du simulateur (`c2900`,
  `c2960`, `c3560`) sont tous à configuration FIXE. `show module` est une
  commande de châssis modulaire ; sur un ISR 2911 ou un Catalyst 2960
  réel, elle est refusée. L'implémenter demanderait d'inventer un
  inventaire de cartes qu'aucun état d'équipement ne porte.
- **`fsck flash:`.** `CiscoFileSystem` est une table de fichiers sans
  modèle de corruption : un `fsck` répondrait « OK » quoi qu'il arrive.
  Une commande de vérification qui ne peut rien trouver est un décor.

## 5. Ce qui n'est PAS un manque, et pourquoi — vérifié un par un

C'est la plus grosse part des 74 candidats, et chaque ligne a été
vérifiée sur équipement ou dans le transcript.

**Une fonction de commutation demandée à un routeur** — le motif le plus
fréquent, et celui que l'audit 12 avait déjà identifié pour
`display port-security` :

| commande | routeur VRP | switch VRP |
|---|---|---|
| `display port-security` | `Unrecognized` | rend son tableau |
| `display port` | `Unrecognized` | rend son tableau |
| `display dhcp snooping` | `Incomplete` | rend son état |

Idem côté Cisco : `spanning-tree ?` est refusé sur un routeur et rend
son aide sur un switch. Un routeur ne commute pas ; le refus est la
bonne réponse.

**Une interface que la suite n'a jamais créée.** Les neuf formes
`Loopback0` (Cisco) et `LoopBack0` (VRP) sont refusées parce que
l'interface n'existe pas : `grep "interface LoopBack0"` ne rend rien
dans `huawei-router-interfaces.debug.test.ts`, exactement comme l'audit
12 l'avait établi pour la suite Cisco. Vérifié dans l'autre sens : une
fois la LoopBack0 créée sur un switch VRP, `display interface LoopBack0`
et `display ip interface LoopBack0` rendent leur bloc ; une fois la
Loopback0 créée sur un routeur Cisco, `show interfaces Loopback0`,
`accounting`, `stats`, `switchport`, `show ip interface` et
`show ipv6 interface` fonctionnent toutes.

**`traceroute` sur VRP — et ce cas mérite d'être écrit.** Le refus est
correct : la commande de VRP est **`tracert`**, pas `traceroute`, et
`tracert 10.5.5.2` fonctionne (vérifié, elle rend ses sauts). La suite
tape un mot de Cisco à une invite Huawei. Accepter `traceroute` serait
ajouter une commande qui n'existe pas sur la plateforme.

**Des tests négatifs délibérés**, reconnaissables à leur argument :
`vlan 99999` (hors gamme), `display arp xyz`, `stp mode bidon`,
`switchport mode bogus`, `area abc`, `frobnicate`, `shww version`,
`show versionnn`, `reniec`, `jobss` ; et les commandes tronquées
`show`, `configure`, `interface`, `ip access-list extended`,
`ip dhcp pool`, dont `% Incomplete command.` est la bonne réponse.

**`network 2001:db8:: 32`** est tapé à l'invite `[R1]`, c'est-à-dire en
vue système et non sous un processus de routage. `network` n'existe
qu'à l'intérieur d'un `[R1-bgp]` ou d'un `[R1-ospf-1-area]` ; le refus
est correct.

**Des artefacts d'attribution** : `show running-config`,
`show startup-config`, `show tech-support`, `show running-config all`,
`enable`, `configure terminal`. Leur sortie est composite ou longue, ce
qui désoriente l'attribution ligne à ligne — l'audit 12 l'avait déjà
mesuré pour les deux premières, elles fonctionnent.

**Des refus délibérés et documentés** : `display ospfv3`, `ipv6 enable`,
`ipv6 address`, `dhcpv6 server` sur un switch VRP (lot 7 — aucune pile
v6 sur `Switch`) ; `hello-interval`, `hold-time`,
`authentication mode md5`, `summary-address` sous `af-interface` (lot 8
— le moteur EIGRP est explicitement sans minuteries, les accepter
stockerait une valeur que rien ne lirait).

**`show interfaces FastEthernet0/<n>`** (7 fichiers, 21 occurrences) :
ports au-delà de la gamme d'un châssis de 26 ports, vérifié à l'audit 12.

## 6. Ordre de traitement suggéré

1. **La famille `archive` sur le switch Cisco** (§4.2). Huit formes, un
   bloc cohérent, un équivalent déjà écrit pour le routeur dont
   s'inspirer. C'est le manque le mieux délimité.
2. **`rate-limit`** (§4.1). Deux choix honnêtes, et il faut trancher
   plutôt que panacher : soit refuser la commande de configuration
   puisque rien ne l'implémente, soit la mémoriser et lui donner sa vue.
   La situation actuelle — acceptée et sans trace — est la pire des
   trois.
3. **`show archive` sur le routeur** (§4.3), qui demande d'abord de
   lire l'implémentation pour savoir laquelle des deux causes joue.
4. Le reste de §4.4, une occurrence chacun.

Et une recommandation qui ne porte pas sur une commande : **§2 devrait
changer la manière dont ces passes sont conduites.** Régénérer les
transcripts mesure ce que la CLI refuse ; ça ne dit rien de ce qu'elle
accepte à tort. Les deux plus gros défauts corrigés cette semaine
étaient de la seconde espèce.
