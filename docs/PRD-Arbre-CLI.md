# PRD — Arbre de commandes et aide contextuelle (audit 2026-08)

Feuille de route des cinq chantiers ouverts par le rapport d'audit
« Arbre de commandes et aide contextuelle » (~400 nœuds parcourus).

Plateforme de référence : **Cisco ISR 2911, IOS 15.7(3)M**. Tout arbitrage
de fidélité se tranche contre cette machine-là, pas contre « un Cisco ».

---

## État d'avancement

| Chantier | Sujet | État |
|---|---|---|
| 1 | Purge des fuites de substrat (§1) | ✅ fait |
| 2 | Alignement licence / plateforme (§2) | ✅ fait |
| 3 | Invariant aide ⇔ exécution (§3) | ✅ fait |
| 4 | Typage des arguments d'aide (§4) | ⬜ à faire |
| 5 | Complétude des menus (§5) | ⬜ à faire |
| 6 | Finition des données (§6) | ⬜ à faire |

---

## Chantier 1 — Purge des fuites

**Défaut.** Onze sorties révélaient le substrat d'implémentation :
`software-only sim`, `Node crypto fallback`, `not simulated`,
`not instrumented`, `in this model`, `this is a router`, `(real)`,
`(unhandled)`, `(already in)`. Un apprenant qui lit « Node crypto » cesse
de croire la machine.

**Principe retenu.** Une sortie ne parle jamais de sa propre nature. Deux
issues seulement pour un nœud fautif :

1. la commande existe sur un 2911 ⇒ elle rend ce qu'IOS rend, en
   lisant l'état réel de la machine ;
2. elle n'existe pas sur un 2911 ⇒ elle disparaît de l'arbre, et le
   parseur répond au caret comme pour n'importe quelle saisie inconnue.

Le second cas est le plus honnête pour `show interfaces trunk`,
`show idprom` et `show redundancy` : maquiller leur sortie aurait
remplacé une fuite par une invention.

**Ce qui a été rendu, nœud par nœud.**

| Nœud | Avant | Après |
|---|---|---|
| `show crypto eli` | `software-only sim`, `Node crypto fallback` | en-tête IOS lisant le vrai compte de SA IKE/IPSec |
| `show hosts` | `recursive resolver not simulated` | les trois états réels d'IOS (`disabled` / `domain service` / `static mappings`) + légende `Codes:` |
| `show buffers` | `No public buffer pools instrumented in this model.` | les six pools publics d'IOS ; tailles et `permanent` sont des constantes de plateforme, les compteurs sont des zéros vrais |
| `show environment` | `not instrumented on this platform` | les trois compteurs d'alarmes, à zéro parce qu'aucune source d'alarme n'existe |
| `show diag` | `Built-in PID (real)` | le bloc `Slot 0:` d'IOS, PID et numéro de série lus du profil châssis |
| `show license udi` | ligne `(hostname: X)` surnuméraire | les seules colonnes `Device# PID SN` |
| `show interfaces switchport` | `Switchport: Disabled (router interface)` | `Switchport: Disabled` |
| `show interfaces trunk` | `(none — this is a router, no L2 trunks)` | retiré de l'arbre → caret |
| `show idprom backplane` | phrase renvoyant à `show inventory` | retiré de l'arbre → caret |
| `enable` (aide privilégiée) | `Enter privileged EXEC mode (already in)` | `Turn on privileged commands` |
| `clock` (aide de config) | `Clock configuration (unhandled)` | `Configure time-of-day clock` |
| `crypto` (aide de config) | `Crypto configuration (unhandled keywords)` | `Encryption module` |
| ping étendu | `accepted but not simulated` | `% Reply data and IP header options were not verified on this run.` |

Un cas voisin est **conservé volontairement** : `flash-simulated
non-volatile configuration memory` dans `show version` est le texte
d'IOS lui-même sur les plateformes dont la NVRAM est émulée en flash.
De même, les refus explicites du type « not supported in this
simulator » (IGMPv3, IP SLA VRF, PIM dense) sont une convention assumée
du dépôt — refuser en nommant la brique manquante vaut mieux que
stocker une configuration que rien ne lit.

**Garde-fou.** `probe-cli-aucune-fuite-de-substrat.test.ts` relit les
sources de rendu et échoue sur toute réapparition du vocabulaire
d'implémentation. Le test porte sur le CODE, pas sur une sortie
particulière : il attrape donc les nœuds que personne n'a pensé à
exécuter.

---

## Chantier 2 — Alignement licence / plateforme

**Décision produit à prendre.** La bannière annonce
`security None None None` alors que l'arbre expose zones, class-map
inspect, crypto ipsec/isakmp/ikev2/pki, `show crypto session`.

Arbitrage retenu : **la bannière déclare `securityk9 Permanent`**. Le
dépôt implémente un moteur IPSec réel (IKE/IKEv2, SA, ESP), une PKI
réelle et une cryptographie réelle (RSA, AES-GCM, X25519, ECDSA) ;
élaguer ces branches détruirait un travail qui fonctionne, alors que
corriger la bannière coûte une ligne et rend l'équipement cohérent.

**Indépendant de la licence** — à retirer quelle qu'elle soit, car
absent de tout ISR G2 :

- `show mac address-table`, `show interfaces switchport|trunk`
- mode `config-vlan` et `vlan <n>`, `interface Vlan` (sans module EtherSwitch)
- `debug port-security`
- VXLAN/NVE : `member vni`, `peer-ip`, `source-interface`, `debug vxlan`
- `TenGigabitEthernet` dans `interface ?`
- `show idprom`, `show redundancy`

**Ce qui a été fait.**

La licence est désormais rendue **d'un seul endroit** (`licenseTable()`,
`CiscoCommonShow.ts`). C'était le défaut derrière le défaut : la
bannière de démarrage portait un tableau de licences et `show version`
n'en portait aucun, alors que les deux décrivent la même machine. Un
opérateur qui lit `securityk9` au boot et rien du tout dans
`show version` ne sait plus laquelle croire ; deux copies auraient de
toute façon fini par diverger. `show license` lit la même décision et
liste les deux paquets sur un routeur.

Le partage plateforme passe par deux prédicats, un seul endroit chacun,
plutôt que par des `if` disséminés :

- `hasSwitchingHardware()` — faux pour `router-isr2911`. Retire
  `show mac address-table`, `show redundancy`, `debug port-security`, le
  modificateur `switchport` de `show interfaces`, le mode `config-vlan`
  et la commande globale `vlan <n>`, le type `Vlan` de `interface` (dans
  la liste d'aide comme dans le résolveur de noms) et
  `TenGigabitEthernet` de `interface ?`.
- `hasVxlanHardware()` — faux partout aujourd'hui. Aucun ISR G2 ni
  Catalyst 3560 n'est un VTEP, quelle que soit la licence.

Le cas VXLAN méritait d'être tranché plutôt que subi : `VxlanAgent`
(286 lignes, suite de tests propre) est un moteur réel, mais sa suite
pilote l'agent directement et jamais le CLI, donc rien ne se casse en
fermant la porte. Elle est fermée par un prédicat et non par une
suppression : le premier profil de châssis qui porterait vraiment le
VXLAN la rouvre en changeant un booléen. Fermer la porte était le bon
choix parce que la maintenir ouverte revenait à enseigner qu'un 2911
encapsule du VXLAN — ce qu'aucune licence ne rend vrai.

Quatre tests encodaient la prémisse inverse (`vlan 10` faisait entrer un
ROUTEUR en `config-vlan`) et ont été retournés plutôt que contournés.
Trois échecs préexistants, apparus au passage, ont été corrigés dans la
foulée : `show vrf interfaces` sans description, `ip community-list
expanded` sans description, et le doublon `show adjacency` du switch —
ce dernier étant une surcharge base/appareil délibérée, il rejoint la
liste blanche prévue pour ce motif.

---

## Chantier 3 — Invariant aide ⇔ exécution

Le correctif structurant, et le seul testable sur l'arbre entier.

Trois assertions à faire tourner sur tous les nœuds :

1. tout mot-clé listé par `?` est exécutable ou propose un niveau
   suivant — jamais `% Invalid input` ;
2. tout nœud annonçant `<cr>` s'exécute sans `% Incomplete command.` ;
3. toute commande à effet persistant apparaît dans
   `show running-config`.

**Mesure d'abord.** `probe-cli-aide-egale-execution.test.ts` parcourt
l'arbre sur trois niveaux dans six modes et exécute chaque mot-clé que
`?` propose. Premier passage : **83 mots-clés annoncés puis refusés**,
et zéro faute sur `<cr>`. Le chiffre a décidé de l'ordre du travail.

**La cause dominante était une seule.** Un gestionnaire `registerGreedy`
voit ses mots-clés extraits de son propre code source pour alimenter
l'aide ; tant qu'aucun ARGUMENT n'est déclaré sur le nœud, ces mots-clés
remontent d'un niveau et sont proposés à la place de l'argument. D'où
`neighbor ?` offrant `remote-as` et `weight` avant l'adresse du voisin,
`transport ?` offrant `ssh`/`telnet` avant la direction, `logging host ?`
offrant `transport` avant le serveur. Déclarer l'argument
(`describeArgs`) supprime la classe entière — et donne au passage à
l'aide le TYPE qu'IOS affiche, ce qui est l'objet du chantier 4.

Deux mécanismes ont dû être ajoutés au `CommandTrie` :

- **`setCompletionFilter`** — `config-router` est un seul arbre pour
  RIP, EIGRP et BGP. Les gestionnaires refusaient déjà ce qui n'est pas
  du protocole courant, mais l'aide ne le savait pas, si bien que
  `router rip` proposait des commandes BGP. `ROUTER_MODE_OWNERS`
  (`CiscoRoutingProtoCommands.ts`) est désormais la source unique : les
  gestionnaires la lisent pour refuser, l'aide pour ne pas proposer.
- **la continuation déclarée vient après l'argument obligatoire** — un
  `continuations:` ne s'affiche plus tant qu'un paramètre non optionnel
  est en attente.

Défauts nommément corrigés : `show interfaces status|switchport|trunk`
(annoncés, rejetés — retirés), `show interfaces stats|accounting|rate-limit`
(annoncés, rejetés — la forme nue rend désormais la vue de TOUTES les
interfaces, comme IOS), `show aaa local` (rendait la ligne des sessions
comme si le mot-clé n'existait pas), `aaa authentication|authorization|
accounting ?` (retombait sur les mots-clés de la racine `aaa`, et
`aaa authentication` seul était ACCEPTÉ EN SILENCE — rien enregistré,
rien dans la running-config, l'opérateur croyant avoir configuré),
`vrf definition` (n'entrait pas dans le sous-mode alors que `ip vrf`,
la même commande sous son autre orthographe, y entrait), `privilege`
et `privilege exec level` (caret au lieu de commande incomplète),
`rate-limit` en interface, `encapsulation isl|native`, `ipv6 address
eui-64|link-local`, `redistribute rip` en mode RIP.

Reste ouvert et renvoyé au chantier 5 : `| ?` n'est pas un nœud de
l'arbre, donc `show running-config | ?` répond au caret, et
`| redirect|append|tee` n'écrit aucun fichier.

---

## Chantier 4 — Typage des arguments

Trente-trois nœuds annoncent `WORD` avec la description du parent
recopiée. Priorité pédagogique d'abord : `match`/`set` en route-map,
`time-range`, `track`, `privilege` ; les nœuds de diagnostic ensuite.

---

## Chantier 5 — Complétude des menus

`|`, `exit`, `end`, `help`, `do`, `default` dans chaque mode, en un point
unique (notion de commandes universelles). Séparation console/VTY :
`speed`/`stopbits`/`databits`/`parity`/`flowcontrol` d'un côté,
`access-class`/`rotary`/`transport input` de l'autre. `no ?` doit offrir
ce que le mode offre, sans filtrage arbitraire.

---

## Chantier 6 — Finition

Horloges divergentes d'une heure, ping sur 127.0.0.1 en échec,
`show ip route summary` annonçant 32 chemins au lieu de 4,
`show version | exclude` laissant une ligne vide, ordre de la légende
`show ntp`, `aaa new-model` sans effet, format d'uptime.
