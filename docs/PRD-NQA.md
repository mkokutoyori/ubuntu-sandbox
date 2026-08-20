# PRD — NQA (Huawei VRP), le jumeau VRP d'IP SLA

## 0. Contexte et portée

NQA (*Network Quality Analysis*) est ce que VRP appelle ce que IOS appelle
IP SLA : le routeur génère lui-même du trafic de mesure, en observe le
résultat, et en fait dépendre une décision — typiquement une route
statique `ip route-static … track nqa`.

`docs/PRD-IP-SLA.md` §6 annonçait NQA comme « un sous-système jumeau, pas
une variante d'affichage », méritant son propre document et pouvant
« réutiliser le moteur livré ici en n'écrivant que sa surface CLI ». Ce
PRD tient les deux moitiés de cette phrase : il réutilise le moteur, et
il documente en quoi NQA **n'est pas** IP SLA — parce que traiter les
deux comme un même produit sous deux orthographes produirait un VRP qui
se comporte comme un IOS, ce qui est exactement le genre de faux dont ce
simulateur cherche à se débarrasser.

### 0.1 Ce qui existe, mesuré

`src/network/devices/router/diag/NqaEngine.ts` (146 lignes) existe, est
instancié par `Router`, exposé par `getNqaEngine()`, et rempli par une
CLI réelle (`HuaweiPolicyCommands.ts` : `nqa test-instance`, la vue
`nqa-test` avec `test-type`/`destination-address`/`frequency`/…,
`display nqa results`). Le fichier a même les bonnes structures :
`NqaProbeResult`, `summary()` avec min/max/avg et taux de perte,
`isTrackUp()` qui compare aux seuils.

**Aucune de ces structures n'est jamais alimentée.** Vérifié par
recherche sur tout le dépôt :

| Méthode | Appelée par |
|---|---|
| `recordProbeBatch()` | **personne** |
| `isTrackUp()` | **personne** |
| `renderHuawei()` | **personne** |
| `NqaTestInstance.start()` | la CLI — elle pose `status = 'active'` et rien d'autre |

Les conséquences, chacune observable :

1. **Aucune sonde n'est jamais émise.** `lastResults` reste vide à vie,
   donc `summary()` renvoie `{sent: 0, received: 0, lossPct: 0, rttMin:
   0, rttMax: 0, rttAvg: 0}` et `display nqa results` affiche
   invariablement `Min/Max/Avg RTT: 0/0/0 ms` et `Packet loss: 0.0%`
   quelle que soit la topologie — y compris pour une cible qui n'existe
   pas. Ce n'est pas « une mesure imprécise », c'est l'absence de mesure
   rendue comme une mesure nulle, ce qui est pire : la sortie a la forme
   d'un résultat.
2. **`isTrackUp()` est du code mort, ET il serait faux s'il vivait** :
   il exige `s.received > 0`, or `received` est structurellement 0 —
   un `track nqa` correctement câblé sur cette fonction serait donc
   **toujours Down**.
3. **`track nqa <admin> <test>` n'est câblé nulle part.**
   `HuaweiConfigCommands.ts:131-136` parse bien le mot-clé et range la
   chaîne dans `RouteEntry.track`, mais **`HuaweiVRPShell` n'appelle
   jamais `setRouteTrackResolver()`** (contrairement à `CiscoIOSShell`).
   `Router.isRouteTrackUp()` répond donc `true` sans condition : la
   route conditionnée est **inconditionnelle**. C'est le défaut le plus
   grave du lot, parce qu'il est silencieux et qu'il porte sur la seule
   fonctionnalité pour laquelle on configure NQA.
4. **La route par défaut perd `track` et `permanent`.**
   `HuaweiConfigCommands.ts:144` appelle
   `setDefaultRoute(nextHop, 0, { preference, tag, description, iface })`
   — les deux autres options sont extraites par l'analyseur juste
   au-dessus et jetées. C'est le pendant VRP exact du défaut corrigé
   côté IOS par `docs/PRD-IP-SLA.md` §8bis, et il survit parce que le
   correctif portait sur la signature de `setDefaultRoute`, pas sur ce
   site d'appel.
5. **NQA n'est pas dans la configuration.** `renderHuawei()` produit les
   lignes correctes et personne ne l'appelle : `display
   current-configuration` ne montre aucun `nqa test-instance`. Une
   topologie sauvegardée perd toute la configuration NQA, pendant que
   les routes `track nqa` qui en dépendent, elles, sont conservées.
6. **`nqa-server` n'existe pas** — ni la commande, ni le concept. Les
   tests `udp`/`jitter` visent donc un port que rien n'ouvre.
7. **Les types de test sont acceptés sans filtre** :
   `t.testType = args[0] as any` accepte n'importe quel mot, y compris
   inexistant, et le range comme s'il était valide.
8. **`start at`/`start delay`/`stop`** : `start` ne reconnaît que `now`,
   les autres formes sont acceptées et ignorées ; `stop` remet
   `status = 'inactive'` sans rien arrêter puisque rien ne tournait.

### 0.2 Ce sur quoi ce lot s'appuie

Le moteur livré par `docs/PRD-IP-SLA.md` — `src/network/ipsla/` — est
délibérément vendor-neutre : `IpSlaHost` est un port étroit rempli par
`Router`, pas par `CiscoRouter`, et rien sous `src/network/ipsla/` ne
connaît IOS. `IpSlaEngine`, `IpSlaResponder`, les sondes, les
statistiques et l'E-model sont donc réutilisables tels quels. Ce que NQA
apporte par-dessus est **son modèle d'objet et sa sémantique**, pas une
seconde implémentation des sondes — un simulateur avec deux moteurs de
sonde finirait par avoir deux réponses à la même question, ce que ce
dépôt a déjà payé ailleurs (deux registres Windows, deux piles SSH).

---

## 1. Ce qui distingue NQA d'IP SLA

C'est la partie qui décide si ce lot est un vrai portage ou un
habillage. Sept différences sont réelles et observables ; les ignorer
donnerait un VRP qui se comporte comme un IOS.

### 1.1 `frequency 0` est le défaut, et il veut dire « une seule fois »

**La différence la plus visible de toutes.** Sur IOS, une opération
planifiée tourne périodiquement (`frequency` 60 s par défaut) pendant sa
`life` (3600 s par défaut). Sur VRP, `frequency` vaut **0** par défaut,
et 0 signifie que le test exécute **une passe et s'arrête** :
`display nqa results` affiche alors `The test is finished`.

Un lab VRP qui tape `start now` sans `frequency` obtient donc un
résultat, une fois, définitivement. Reproduire le comportement d'IOS ici
ferait tourner une sonde que l'opérateur croit terminée.

### 1.2 L'unité de résultat est un LOT, pas une sonde

Sur IOS, `icmp-echo` émet un echo par cycle ; `num-packets` n'existe que
pour les opérations de gigue. Sur VRP, **tout** test émet `probe-count`
sondes (défaut 3) espacées d'`interval`, et le résultat rendu est
l'agrégat de ce lot : `Send operation times: 3 / Receive response
times: 3`, avec `Min/Max/Average completion time`.

C'est pourquoi `NqaProbeResult[]` existait dans le fichier d'origine :
la structure était juste, seule l'alimentation manquait.

### 1.3 `fail-percent` décide si un lot a échoué

VRP ne déclare pas un test en échec au premier paquet perdu : il compare
le taux de perte du lot à `fail-percent` (défaut 100 %, c'est-à-dire
« échec seulement si tout est perdu »). Un `probe-count 3` dont une
sonde se perd est donc un **succès** par défaut — comportement qu'un
portage naïf d'IP SLA rendrait en échec.

### 1.4 `threshold rtd`, et il ne fait pas échouer le test

`threshold rtd <ms>` compte les dépassements (`RTD OverThresholds
number`) sans changer la complétion. IOS, lui, a un code de retour
`Over threshold` distinct de `OK`. La conséquence pratique porte sur
`track` : voir §1.7.

### 1.5 Un test est nommé par un couple, pas par un nombre

`(admin-name, test-name)`. Deux tests peuvent porter le même nom sous
deux administrateurs différents. La CLI n'a aucun identifiant numérique
à exposer.

### 1.6 `start` et `stop` vivent DANS la vue du test

`ip sla schedule 1 …` est une commande globale sur IOS. `start now` /
`start at hh:mm:ss` / `start delay <n> seconds` / `stop` sont des
sous-commandes de la vue `nqa-test` sur VRP. Un test peut donc être
défini et jamais démarré, ce qui est son état par défaut (`testflag is
inactive`).

### 1.7 `track nqa` n'a qu'une forme

IOS distingue `track … ip sla <n> reachability` et `… state`. VRP n'a
que `track nqa <admin> <test>` : la route est utilisable si le test est
**réussi**. Il n'y a pas de mot pour « il répond mais au-dessus du
seuil » — donc les dépassements de `threshold rtd` sont comptés et
n'abaissent pas la route, ce qui est une décision de VRP et non une
simplification de ce simulateur.

---

## 2. Spécification

### 2.1 Modèle

Un `NqaTestInstance` porte la configuration VRP et **délègue la mesure**
à une opération du moteur partagé, à laquelle il est associé par un
identifiant interne jamais montré à l'opérateur. Le moteur gagne pour
cela une seule notion nouvelle, utile aux deux vendeurs :

> **`aggregateProbes`** — nombre de sondes exécutées et agrégées en un
> seul résultat. Vaut 1 par défaut (IOS : une sonde par cycle,
> comportement inchangé) et `probe-count` pour NQA.

Le résultat d'un lot (`SlaProbeOutcome.batch`) porte le nombre émis, le
nombre reçu et les RTT individuels — de quoi rendre
`Send/Receive operation times`, `Min/Max/Average` et `Sum/Square-Sum`
que VRP affiche.

### 2.2 Correspondance des types de test

| `test-type` VRP | Sonde du moteur | Retenu |
|---|---|---|
| `icmp` | `icmp-echo` | oui |
| `jitter` | `udp-jitter` | oui |
| `udp` | `udp-echo` | oui |
| `tcp` | `tcp-connect` | oui |
| `dns` | `dns` | oui |
| `http` | `http` | oui |
| `trace` | `path-echo` | oui |
| `icmpjitter` | `icmp-jitter` | oui |
| `ftp`, `snmp`, `dhcp` | — | refusé : aucun client FTP/SNMP-requête/DHCP côté routeur |
| `lspping`, `lsptrace` | — | refusé : aucun plan MPLS |
| `pathmtu`, `pathjitter` | — | refusé : cf. `PRD-IP-SLA.md` §6 |
| `macping`, `y1731` | — | refusé : aucun OAM 802.1ag/Y.1731 |

Un type refusé l'est **à la saisie**, avec le message que VRP emploie
pour une valeur hors de son énumération, plutôt que stocké comme
aujourd'hui (`args[0] as any`).

### 2.3 États et cycle de vie

```
              (défini)                start now
  inexistant ──────────▶ inactive ──────────────▶ active
                             ▲                       │
                             │  stop                 │ frequency = 0
                             └───────────────────────┤ ⇒ une passe
                                                     ▼
                                                  finished
```

`display nqa results` nomme ces états `testflag is inactive|active` et,
pour la passe, `The test is finished` / `The test is in progress`.

### 2.4 `nqa-server`

`nqa-server udpecho <ip> <port>` et `nqa-server tcpconnect <ip> <port>`
ouvrent un port **permanent**, sans négociation — c'est exactement ce
que `IpSlaResponder.openPermanentPort()` fait déjà, et c'est le pendant
VRP du `ip sla responder udp-echo ipaddress … port …` d'IOS. Il n'y a
pas d'équivalent VRP du control protocol UDP/1967 : côté NQA, un test
`udp` vise donc toujours un port ouvert d'avance, ce que le moteur
exprime par `controlEnabled = false`.

### 2.5 Affichages

- `display nqa results [test-instance <admin> <name>]` — format VRP
  complet (compteurs, `Min/Max/Average completion time`,
  `Sum/Square-Sum completion time`, `Last complete time`).
- `display nqa-server` — état et ports ouverts.
- `display nqa history test-instance <admin> <name>` — l'historique par
  sonde que `records history` borne.
- `display current-configuration` — le bloc `nqa test-instance` et les
  lignes `nqa-server`.

### 2.6 Ce que ce lot corrige au passage, hors NQA

1. **`HuaweiVRPShell` câble enfin `setRouteTrackResolver`**, sans quoi
   tout le reste serait décoratif.
2. **La route par défaut VRP transporte `track` et `permanent`**
   (§0.1 item 4).

---

## 3. Hors périmètre

| Exclu | Raison |
|---|---|
| `test-type ftp`/`snmp`/`dhcp` | Aucun client correspondant côté routeur (cf. `PRD-IP-SLA.md` §6) |
| `lspping`/`lsptrace` | Aucun plan MPLS |
| `pathmtu`, `pathjitter`, `macping` | Idem IP SLA : la brique manque, pas la volonté |
| ~~NQA sur IPv6~~ **LEVÉE** | Elle est tombée pour les deux, comme annoncé : l'émetteur ICMPv6 existe, donc `destination-address ipv6` est accepté et `test-type icmp` mesure vraiment. Un autre type refuse une destination IPv6 en nommant la brique absente plutôt qu'en acceptant une adresse qu'il ne peut pas atteindre |
| `vpn-instance` | Aucun plan de routage par VRF ; refusé plutôt qu'accepté sans effet |
| Réactions/traps NQA (`nqa-jitter`/trap SNMP VRP) | La MIB Huawei NQA est distincte de CISCO-RTTMON ; elle mérite son propre lot, et rien ne la consomme aujourd'hui |
| Commutateurs Huawei | NQA vit sur `Router` ; `HuaweiSwitch` n'a pas de plan L3 propre au sens où ce moteur l'exige |

---

## 4. Plan de test

Discriminé par `git stash`, comme les lots précédents.

1. **Le cas central** : un test `icmp` vers une cible vivante rend un RTT
   et `Send/Receive operation times: 3/3` ; la cible tombe et le même
   test rend 3/0 avec `Packet loss: 100%`.
2. `frequency 0` (défaut) : **une seule passe**, `The test is finished`,
   et rien ne repart ensuite.
3. `frequency 10` : les passes se répètent au rythme demandé.
4. `probe-count 5` émet bien cinq sondes dans un lot.
5. `fail-percent` : une perte sur trois est un succès par défaut, un
   échec avec `fail-percent 1`.
6. `threshold rtd` compte les dépassements **sans** faire échouer.
7. `track nqa` : la route statique quitte la table quand le test échoue,
   et y revient quand il réussit — le cas pour lequel NQA existe.
8. `ip route-static 0.0.0.0 0 <nh> track nqa a b` : la route par défaut
   est bien conditionnée (défaut §0.1 item 4).
9. `nqa-server udpecho` : un test `udp` aboutit avec, échoue sans.
10. Un `test-type` inexistant est refusé, pas stocké.
11. `display current-configuration` reproduit le bloc `nqa
    test-instance` tel qu'il a été tapé.
12. Non-régression : les sondes IOS gardent `aggregateProbes = 1` et
    leurs suites passent inchangées.


---

## 5. État livré (2026-08-05)

Livré et discriminé par `git stash` (16 cas, tous en échec avant le
correctif) :

- **`src/network/nqa/NqaService.ts`** — modèle VRP (couple
  administrateur/test, lots, `fail-percent`, `frequency 0`, historique)
  au-dessus du moteur partagé. Aucun second moteur de sonde.
- **`src/network/ipsla/`** gagne **une seule** notion, utile aux deux
  vendeurs : `aggregateProbes` (défaut 1, donc IOS inchangé) et
  `failPercent`, plus `SlaProbeOutcome.batch`.
- **`HuaweiNqaCommands.ts`** — vue `nqa-test` complète, `nqa-server`,
  `display nqa results|history|-server`, rendu de configuration.
- **`resolveVrpTrack`** câblé sur `setRouteTrackResolver` depuis
  `HuaweiVRPShell.execute`.
- **La route par défaut VRP transporte enfin `track` et `permanent`.**
- `NqaEngine.ts` est supprimé : il n'avait plus d'appelant, et le garder
  aurait laissé deux réponses possibles à « ce test réussit-il ? ».

### Écarts assumés

- **Le RTT vaut 0 ms en temps virtuel** (même cause que côté IOS : la
  livraison de trame est synchrone). `threshold rtd` compte donc
  toujours 0 dépassement dans une topologie de test ; la logique est
  exercée, la traversée du seuil ne peut pas venir du chemin.
- **`start at hh:mm:ss`** est calculé sur l'horloge de l'équipement ;
  `start delay … milliseconds` est arrondi à la seconde supérieure,
  faute d'une granularité inférieure dans la planification du moteur.
- **`records result <n>`** est mémorisé et ne borne rien aujourd'hui :
  ce simulateur ne conserve qu'un résultat par test (`display nqa
  results` en affiche un), donc la limite n'a pas d'objet tant que
  plusieurs passes ne sont pas conservées côte à côte.
