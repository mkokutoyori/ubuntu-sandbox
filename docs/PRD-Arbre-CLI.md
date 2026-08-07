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
| 2 | Alignement licence / plateforme (§2) | ⬜ à faire |
| 3 | Invariant aide ⇔ exécution (§3) | ⬜ à faire |
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

---

## Chantier 3 — Invariant aide ⇔ exécution

Le correctif structurant, et le seul testable sur l'arbre entier.

Trois assertions à faire tourner sur tous les nœuds :

1. tout mot-clé listé par `?` est exécutable ou propose un niveau
   suivant — jamais `% Invalid input` ;
2. tout nœud annonçant `<cr>` s'exécute sans `% Incomplete command.` ;
3. toute commande à effet persistant apparaît dans
   `show running-config`.

Défauts connus à couvrir : `show interfaces status|switchport|stats|rate-limit`
(annoncés, rejetés), `show aaa local` et huit autres branches sans niveau
suivant, le dispatch de `aaa authentication|authorization|accounting ?`
qui retombe sur la racine, `vrf definition` qui n'entre pas en sous-mode,
et les modificateurs `| redirect|append|tee` qui n'écrivent aucun fichier.

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
