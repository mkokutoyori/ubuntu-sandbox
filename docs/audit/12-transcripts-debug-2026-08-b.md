# Analyse des transcripts de debug — régénération du 3 août 2026 (2ᵉ passe)

## 0. Ce qui a été fait

Les 125 transcripts de `debug-output/` ont été régénérés en entier
(`npx vitest run src/__tests__/debug/`, 93 fichiers de suite).
**93/93 suites passent.** Les 125 fichiers diffèrent, mais l'essentiel du
diff est de la gigue (horodatages, RTT, compteurs d'octets, tables `ps`).

Cette passe fait suite à l'audit 11, dont les huit priorités ont toutes
été traitées. La question posée ici est donc double : **est-ce que ça a
tenu, et que reste-t-il ?**

## 1. Ça a tenu, et c'est mesuré

| | avant | après |
|---|---|---|
| lignes de refus | 1077 | 967 |
| formes de commande distinctes refusées | 171 | 121 |
| candidats après filtrage des tests négatifs | 135 | 84 |
| **candidats NOUVEAUX** | — | **0** |

**51 formes de commande ont cessé d'être refusées**, et elles
correspondent une à une aux lots livrés : `cal`, `getconf`, `lsmod`,
`modinfo`, `sensors`, `lsb_release`, `logname`, `lid`, `members`,
`newgrp`, `pmap`, `mtr`, `tracepath`, `fuser`, `apt-cache search`,
`swapon` (lot 6) ; `boot system`, `config-register`, `delete flash:`,
`more flash:`, `more nvram:`, `show bootvar`, `pwd` (lot 3) ;
`metric maximum-hops`, `show ip eigrp traffic`, `show ip eigrp
accounting`, `clear ip eigrp neighbors`, `show eigrp protocols`,
`show eigrp address-family ipv4 neighbors`, `neighbor IBGP remote-as`,
`neighbor IBGP update-source`, `log-adjacency-changes detail`,
`show storm-control` (lot 8).

**Aucune forme nouvellement refusée.** Les huit lots n'ont rien cassé
d'observable dans les transcripts.

Un résultat qui mérite d'être dit séparément : **Oracle, RMAN,
PowerShell et Windows ne laissent plus AUCUN candidat.** Les 84 restants
sont tous Cisco, VRP ou Linux.

## 2. La méthode a dû être corrigée deux fois de plus

L'audit 11 recensait trois pièges (sections de test négatif, suites de
cohérence qui doublent chaque commande, cascades). L'extracteur écrit
pour cette passe les traite d'emblée. Il en a révélé **deux autres**, et
tous deux ont été trouvés non pas en relisant le code mais en
**vérifiant les candidats sur de vrais équipements** :

**Quatrième piège — les fautes de frappe délibérées.** Les suites
testent qu'une commande inconnue est bien refusée, avec des mots comme
`iptabless`, `netstatt`, `usradd`, `chmodd`, `grepp`, `unamee`, `ipp
link`. Aucun titre de section ne l'annonce. Un mot à une lettre près
d'une commande connue est donc écarté automatiquement (76 formes
écartées ainsi). Deux passent encore au travers et sont visibles dans la
liste ci-dessous : `reniec` (transposition, pas substitution) et `jobss`
(`jobs` manquait dans ma table de référence). **Ce ne sont pas des
manques** : `renice 5 -p 1` et `jobs` fonctionnent, vérifié.

**Cinquième piège — le préfixe de l'invite.** Les dumps numérotent leurs
étapes (`[122/366] sw1 SW1# show interfaces …`). Sans retirer ce
préfixe, le « premier mot » de la commande est le compteur, et tout
filtre qui regarde ce mot est aveugle.

Et surtout, la règle qui décide : **on ne conclut rien d'un compte.** Les
deux candidats les mieux classés de cette passe étaient des artefacts,
et seule la vérification sur équipement l'a montré :

- `display port-security` — 11 fichiers. Vérifié : **fonctionne
  parfaitement sur un switch Huawei**, vide comme configuré. Les 11
  occurrences sont sur des **routeurs**, où le refus est défendable
  (le port-security est une fonction de commutation).
- `show interfaces FastEthernet0/<n>` — 7 fichiers, 21 occurrences.
  Vérifié : **fonctionne**. Les refus portent sur `FastEthernet0/25` et
  au-delà, sur un châssis de 26 ports qui a Fa0/1–24 puis Gi0/1–2. Le
  port n'existe pas ; **le refus est la bonne réponse**, et les suites
  bouclent simplement au-delà de la gamme.

De même, `show tech-support` et `show running-config all` sont donnés
comme refusés par l'extracteur et **fonctionnent tous deux** — leur
sortie composite (elle enchaîne `show version`, `show running-config`,
`show ip route`…) désoriente l'attribution ligne à ligne.

## 3. Les manques réels, vérifiés sur équipement

### 3.1 `conntrack` — un moteur sans porte, encore

`conntrack -L` et `conntrack -S` sont absents sur **quatre machines
Linux distinctes** (`ldc`, `lbr`, `lhq`, `srvdc`), soit les 8 seules
occurrences Linux restantes après filtrage.

C'est le motif récurrent de toute cette campagne : **le moteur existe.**
`LinuxIptablesManager` tient une vraie table de suivi de connexions
(`private conntrack: Map<string, number>`, alimentée à chaque paquet,
avec expiration par `CONNTRACK_TIMEOUT`), et c'est elle qui fait marcher
les correspondances `state`/`conntrack` de `iptables` — `ESTABLISHED`,
`RELATED`, `NEW` sont réels, pas décoratifs. Ce que `CLAUDE.md` décrit
déjà comme « genuine conntrack NEW/ESTABLISHED/RELATED ».

Il manque uniquement la commande qui la nomme. Un lab qui écrit une
règle `-m state --state ESTABLISHED` ne peut pas montrer la table qui la
justifie.

**Réserve d'honnêteté** : la table actuelle associe une clé de flux à un
horodatage. `conntrack -L` du vrai binaire affiche aussi le protocole,
les compteurs de paquets/octets par direction et l'état TCP. Une partie
est dérivable de la clé, le reste demanderait d'enrichir la structure.
Cet écart doit être écrit dans la commande, pas découvert après.

### 3.2 Cisco — trois manques confirmés

- **`clock set 10:30:00 3 June 2026`** → `% Invalid input detected`.
  Vérifié sur routeur neuf. `show clock` fonctionne et rend l'heure de
  la machine ; seule la mise à l'heure manque. C'est la commande de
  toute séance qui touche aux horodatages de journaux, aux certificats
  ou à NTP.
- **`ip address negotiated`** → `% Incomplete command.` Vérifié. La
  forme est reconnue mais inachevée : c'est l'adresse apprise par DHCP
  sur une interface WAN, le cas normal d'un lien opérateur.
- **`crypto isakmp key … hostname <nom>`**, **`ipv6 ospf
  hello-interval` / `dead-interval`** — reportés de l'audit 11 §4.5,
  toujours absents, une occurrence chacun.

### 3.3 Huawei — le pendant par-interface

**`display port-security interface GigabitEthernet0/0/1`** est refusé
alors que `display port-security` seul fonctionne (vérifié sur switch,
avec et sans configuration). Trouvé en vérifiant un candidat, pas dans
la liste — la forme par-interface n'apparaît pas dans les suites.

Restent, **et le refus est délibéré et documenté** (lot 7) : `display
ospfv3`, `ipv6 enable`, `ipv6 address`, `dhcpv6 server` sur un switch.
`HuaweiSwitchShell` ne contient aucune occurrence d'IPv6 et `Switch` n'a
pas de pile v6 ; les accepter demanderait de la construire.

### 3.4 EIGRP mode nommé — refus délibéré, confirmé

`hello-interval`, `hold-time`, `authentication mode md5`,
`summary-address` sous `af-interface` restent refusés. C'est la décision
prise au lot 8 et elle tient : le moteur EIGRP est explicitement sans
minuteries, donc les accepter stockerait une valeur que rien ne lirait.
Leur présence dans cette liste est attendue, pas une régression.

## 4. Un candidat à trancher, pas encore tranché

`show interfaces Loopback0` / `show ip interface Loopback0` /
`show ipv6 interface Loopback0` apparaissent refusés dans
`router/cisco-router-interfaces`. **Mais vérifié sur un routeur neuf où
la Loopback0 a été créée, les deux premières fonctionnent** et rendent
le bloc attendu (`Loopback0 is up … Internet address is 1.1.1.1/32`).

L'écart vient donc du contexte de la suite, pas de la commande. Deux
lectures restent possibles — la Loopback n'existait pas à cet instant du
scénario (auquel cas le refus est correct et c'est la suite qui est mal
écrite), ou une différence de mode. **Je n'ai pas tranché**, et il serait
malhonnête de l'inscrire comme un manque sans l'avoir fait. C'est le
premier point à instruire.

## 5. Ordre de traitement suggéré

1. **`conntrack -L` / `-S`.** Le moteur existe et n'a pas de porte,
   c'est le seul manque Linux restant, il touche quatre suites, et il
   rend visible ce qui fait déjà marcher les règles `iptables -m state`.
2. **Trancher le cas Loopback (§4)** avant d'écrire quoi que ce soit :
   soit c'est un manque, soit la suite boucle hors gamme comme pour
   `FastEthernet0/25`. Une heure de vérification évite une
   fonctionnalité écrite pour rien.
3. **`clock set`.** Bornée, et elle débloque tout ce qui se date.
4. **`ip address negotiated`** et **`display port-security interface`**.
   Deux formes courtes par-dessus des moteurs qui existent.
5. `crypto isakmp key … hostname`, `ipv6 ospf hello-interval` /
   `dead-interval`. Les moins bloquantes.

Ne pas traiter : les refus délibérés de §3.4 et de la fin de §3.3, qui
sont la bonne réponse tant que le moteur derrière n'existe pas.

## 6. Réserve d'honnêteté

**Vérifié sur équipement** (probe jetable, un `CiscoRouter`,
`CiscoSwitch`, `HuaweiRouter`, `HuaweiSwitch` et `LinuxServer` neufs) :
`display port-security` sur switch et sur routeur, `show interfaces
FastEthernet0/24` et `0/25`, `show interfaces Loopback0` et `show ip
interface Loopback0` avec Loopback créée, `show tech-support`,
`show running-config all`, `clock set`, `ip address negotiated`,
`conntrack -L`, `renice`, `jobs`, `display port-security interface`.

**Lu dans les transcripts, non revérifié individuellement** : les
occurrences uniques de `crypto isakmp key … hostname`, `ipv6 ospf
hello-interval` / `dead-interval`, `summary-address`, `network
2001:db8::/64`, `show interfaces … rate-limit`, `show interfaces
Loopback0 accounting` / `switchport` / `stats`. Elles viennent toutes de
sections dont le sujet est ailleurs et n'ont qu'une occurrence : le coût
de vérification dépassait l'information gagnée à ce stade.

**Ce que cette analyse ne mesure pas** : elle ne voit que les commandes
REFUSÉES. Une commande acceptée qui rend une réponse fausse, ou
acceptée et silencieusement ignorée, lui est invisible — et c'est
précisément la classe de défauts que les lots 7 et 8 ont trouvée en
mesurant (la branche `vlan` inatteignable du DHCP snooping, le groupe de
pairs listé comme voisin). Le compte de refus est un indicateur
d'incomplétude, jamais un indicateur de justesse.
