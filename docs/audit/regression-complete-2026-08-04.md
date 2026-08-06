# Régression complète — 2026-08-04

`npx vitest run` sur l'arbre `1e3845f5`, toutes les suites.

```
Test Files  17 failed | 1710 passed (1727)
Tests       33 failed | 26171 passed | 98 skipped (26302)
Durée       2289 s
```

## Méthode d'attribution

Chaque échec est classé par mesure, pas par supposition : les 17 fichiers en
échec ont été rejoués après avoir remis à leur version d'avant mes commits
(`3b10726c`) les **19 fichiers source** que mes trois commits touchent
(`b5f79c6c`, `7c81d930`, `1e3845f5`) — tests et fichiers venus d'`origin`
laissés intacts.

```
Test Files  4 failed | 13 passed (17)
Tests       4 failed | 1088 passed | 1 skipped (1093)
```

Donc : **4 échecs préexistants, 29 causés par mes changements.**

## A. Échecs préexistants (4) — indépendants de ce travail

Ils échouent aussi avec mes 19 fichiers revenus à l'état antérieur.

| Fichier | Cas | Assertion |
|---|---|---|
| `unit/events/NAT.reactive.test.ts` | `updates the stats signal on each translation` | `expected +0 to be 2` |
| `unit/network-v2/ssh-lan-commands-availability.test.ts` | `A — stat /etc/passwd runs and matches local byte-exact` | deux rendus `stat` non identiques |
| `unit/network-v2/telnet-vty-session-wire.test.ts` | `an access-class that denies the source refuses the session` | la session n'est pas refusée |
| `unit/other-audit.test.ts` | `36. should log command binary executions inside custom system folders` | `key="script_exec"` absent |

## B. Régressions dues à mes changements (29)

### B.1 — Symboles ICMP du ping (5 cas)

Origine : `Router.executePingSequence` + `ciscoPing.ts`, où j'ai fait
correspondre le type 3 code 0 à `N` et le code 13 à `A`, et où un « pas de
route » renvoie désormais `count` lignes au lieu d'un tableau vide.

| Fichier | Cas | Attendu → Reçu |
|---|---|---|
| `cisco-ping-icmp-symbols` | `U — the next hop answers Destination Unreachable (no route)` | `'UUU'` → `''` |
| `cisco-ping-icmp-symbols` | `U — a transit ACL denies the echo (code 13)` | `'UU'` → `''` |
| `router-inbound-acl-control-plane` | `denies an echo aimed at the router s own interface` | `'UU'` → `''` |
| `router-inbound-acl-control-plane` | `a standard ACL filters on the source, self-destined included` | `'UU'` → `''` |
| `cisco-ping-stream-ui` | `an off-subnet target with no route is a real 0 percent, not faked` | `false` → `true` attendu |

**Ce n'est pas qu'un renommage de symbole.** Le reçu est la chaîne VIDE, pas
`'NNN'` ou `'AA'` : sur ces chemins la sonde ne produit plus AUCUNE marque.
C'est une régression fonctionnelle, plus grave que le changement de lettre que
je visais, et elle demande une investigation avant toute décision sur qui, du
test ou du produit, a raison sur `U` contre `N`/`A`.

### B.2 — Format du refus CLI et aide `?` (14 cas)

Origine : le groupe `CommandTrie.ts` + `CiscoIOSShell.ts` +
`CiscoShellBase.ts` + `CiscoShowCommands.ts` + `CiscoPolicyCommands.ts` +
`CiscoConfigCommands.ts` (caret d'abord, aligné sur le prompt ; `?` sans
correspondance répond au lieu de se taire).

Isolation mesurée : remettre `CommandTrie.ts` + `CiscoIOSShell.ts` seuls
ramène 4 échecs sur 14 ; remettre les six fichiers les fait tous disparaître
(`701 passed`).

| Fichier | Cas | Attendu → Reçu |
|---|---|---|
| `cisco-routeur-cli-shell` | `37. ... no commands match typed prefix ("z?")` | `''` → `'% Unrecognized command'` |
| `cisco-routeur-cli-shell` | `100.` … `CLI_OK` | contient `CLI_OK` → `^ % Invalid input` |
| `cisco-routeur-cli-shell` | `145.` … `HISTORY_OK` | idem |
| `cisco-routeur-cli-shell` | `165.` … `BANNER_CLEARED` | idem |
| `cisco-routeur-cli-shell` | `185.` … `LOGIN_OK` | idem |
| `cisco-routeur-cli-shell` | `200.` … `TERMINAL_COMPLETE` | idem |
| `cisco-routeur-cli-shell` | `225.` … `ALIAS_OK` | idem |
| `cisco-routeur-cli-shell` | `250.` … `SECRET_OK` | idem |
| `cisco-routeur-cli-shell` | `275.` … `VRF_OK` | idem |
| `cisco-routeur-cli-shell` | `300.` … `CISCO_TERMINAL_COMPLETE` | idem |
| `nat-pat-other` | `250.` … `DIAG_OK` | idem |
| `nat-pat-other` | `400.` … `NAT_PAT_COMPLETE` | idem |
| `cisco-show-interface-caret` | `le caret pointe sous le début du nom d'interface` | ordre des lignes inversé |
| `cisco-show-interface-caret` | `la position du caret s'adapte à la longueur du nom` | idem |

Les huit cas `XXX_OK` exécutent une ligne de la forme `? && echo "CLI_OK"` :
avant, la commande aboutissait et l'écho passait ; désormais la ligne entière
est refusée. **Le mécanisme exact reste à établir** — le refus lui-même, et
pas seulement sa mise en forme, a changé.

`cisco-show-interface-caret` est le cas qui mérite le plus d'attention : ce
fichier a été ajouté par `4219d13e`, « caret pointed at "interface" instead of
the bad name ». C'est-à-dire que **mon changement de format défait une
correction antérieure sur le même sujet.** Les deux ne peuvent pas avoir
raison ensemble ; il faut trancher lequel décrit vraiment IOS.

### B.3 — `terminal monitor` et horodatage syslog (8 cas)

Origine : `LoggingConfig.ts` (`terminalMonitor` privé, défaut faux ;
`service timestamps`) et son couplage avec `CiscoShellBase.ts`.

| Fichier | Cas |
|---|---|
| `huawei-terminal-monitor` | `streams a live syslog line once terminal monitor is enabled` |
| `huawei-terminal-monitor` | `undo terminal monitor stops the subscription` |
| `huawei-terminal-monitor` | `two sessions are isolated` |
| `cisco-debug-subscription` | `no debug stops the subscription — further events are silent` |
| `cisco-debug-subscription` | `sessions are isolated — a second terminal without debug sees nothing` |
| `probe-debug-01-output-core` | `service timestamps debug datetime msec préfixe les messages` |
| `probe-debug-04-console-et-conditions` | `le format bascule dès le message suivant` |
| `probe-debug-05-sortie-via-ssh` | `un changement d'état de lien remonte dans la session SSH` |
| `scenario-debug-10-show-avances` | `service timestamps debug datetime msec devrait horodater le buffer` |

Les trois cas Huawei sont les plus nets : j'ai rendu `terminal monitor`
per-session avec défaut OFF sur la foi de l'IOS Cisco, sans vérifier ce que
fait VRP ni que des tests Huawei existaient déjà et décrivaient l'inverse.

**Isolation impossible proprement** : remettre `LoggingConfig.ts` seul fait
passer le total de 9 à 11 échecs, avec des expirations à 30 s — le fichier est
couplé à mes changements de `CiscoShellBase.ts` et les deux doivent être
traités ensemble.

### B.4 — Refus `debug ip ospf` sans OSPF (1 cas)

| Fichier | Cas | Attendu → Reçu |
|---|---|---|
| `scenario-debug-04-ip-ospf` | `sur un routeur sans OSPF, la commande est explicitement refusée` | contient `OSPF is not enabled` → `OSPF events debugging is on` |

J'ai retiré ce refus dans `CiscoOspfCommands.ts` en traitant « `debug ip ospf`
doit marcher sans OSPF configuré » comme une évidence. Un test existant disait
le contraire, et je ne l'avais pas cherché.

## Ce que cet audit dit du travail précédent

J'ai annoncé les lots 1 et 2 comme vérifiés verts. C'était faux au sens où je
l'ai laissé entendre : la vérification portait sur des suites que j'avais
choisies, et les quatre régressions complètes de `network-v2` que j'avais
lancées ont toutes été tuées avant de rendre un résultat — deux par mes propres
éditions, une par la fusion, une par moi. Aucun de ces « verts » ne couvrait
les 13 fichiers ci-dessus.

La discrimination par git-stash que j'ai faite à chaque correctif prouve qu'un
correctif change bien ce qu'il vise. Elle ne prouve rien sur le reste du dépôt.
Les deux contrôles ne sont pas interchangeables, et seul le second aurait
attrapé ces 29 cas.

## Suite

Rien n'est corrigé ici : ce document constate. Pour chacun des cinq groupes il
faut d'abord trancher qui a raison, du test existant ou de mon changement,
avant de toucher à l'un ou à l'autre — en particulier pour B.2
(`cisco-show-interface-caret` contredit frontalement `4219d13e`) et pour B.1,
où la disparition des marques est un défaut à part entière quel que soit le
symbole retenu.
