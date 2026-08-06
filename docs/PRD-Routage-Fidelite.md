# PRD — Module routage : sérialiseur, arbre de commandes, modèle d'état

> Fait suite à `docs/PRD-CLI-Fidelite-IOS-Iteration3.md`, livré, dont il
> reprend la méthode. Périmètre : les processus de routage d'un
> `CiscoRouter` (RIP, OSPF, EIGRP, BGP), leur sérialisation, la RIB, la
> FIB et les vues qui les rendent.

---

## 0. Contexte et méthode

Une revue du module routage relève une classe de défauts que les
itérations précédentes n'avaient pas atteinte : **le parseur accepte des
commandes qu'il n'implémente pas, et le sérialiseur corrompt la
configuration en l'écrivant**. Le rapport hiérarchise lui-même en trois
chantiers ; cette hiérarchie est reprise, complétée d'un quatrième pour
les vues.

### Méthode

Comme aux itérations précédentes : **aucune affirmation n'est traitée
avant d'avoir été reproduite contre le code qui tourne.** La séquence du
rapport a été rejouée sur un `CiscoRouter` réel et l'intégralité des
sorties citées ci-dessous est un relevé littéral.

### Ce que la mesure change au rapport

Elle le confirme sur toute la ligne — et **trois des défauts relevés
m'appartiennent**, introduits par les lots précédents. Ils sont signalés
comme tels, parce qu'un correctif qui ne sait pas d'où vient le défaut le
réintroduit ailleurs.

| § | Constat | Verdict |
|---|---|---|
| 1.1 | `redistribute redistribute …` | ✅ Confirmé — `CiscoRoutingProtoCommands.ts:176` stocke la ligne ENTIÈRE, `ciscoConfigSerializer.ts:93` la re-préfixe |
| 1.2 | `router rip` sérialisé deux fois | ✅ Confirmé |
| 1.3 | `router eigrp 0` fantôme | ✅ Confirmé |
| 1.4 | router-id OSPF écrasé globalement | ✅ Confirmé |
| 1.5 | Wildcard stocké comme masque | ✅ Confirmé — `network 0.0.0.0 255.255.255.0 area 0` |
| 1.6 | Pertes sèches (BGP, route-map, prefix-list, …) | ✅ Confirmé |
| 1.6 bis | `logging buffered` apparaît sans être configuré | ✅ Confirmé — **défaut à moi** (§1.7) |
| 2 | Acceptation silencieuse | ✅ Confirmé, 7 cas sur 7 |
| 3 | RIB/CEF déconnectées | ✅ Confirmé — et l'inversion a une cause précise (§1.8) |
| 4 | Commandes manquantes | ✅ Confirmé, 14 sur 14 |
| 5 | `[object Object]`, filtres, messages inventés | ✅ Confirmé |
| 5 bis | `\| begin router bgp` ne s'arrête jamais | ⚠️ **Nuancé** — conséquence de §1.6, pas un défaut du filtre |
| — | `show ip protocols` rend OSPF deux fois | 🆕 **Défaut à moi** (§1.9) |

---

## 1. Vérification

### 1.1 `redistribute` dupliqué — CONFIRMÉ, cause exacte

Relevé :

```
router rip
 version 2
 network 172.16.0.0
 network 10.0.0.0
 passive-interface GigabitEthernet0/2
 redistribute redistribute ospf 1 metric 5
```

Deux lignes se contredisent sur ce que contient la chaîne stockée.
`CiscoRoutingProtoCommands.ts:176` y met la **commande entière** :

```ts
const line = raw ?? `redistribute ${a.join(' ')}`;
…
repo.rip.redistribute.push(line);
```

`ciscoConfigSerializer.ts:93` (et 112, et 136) la traite comme un
**argument** :

```ts
for (const source of process.redistribute) lines.push(` redistribute ${source}`);
```

Le nom du champ (`redistribute`) et le nom de la variable (`source`)
disent déjà le désaccord. Le repli `\`redistribute ${a.join(' ')}\`` est
la trace d'une hésitation : il produit lui aussi la commande complète, si
bien que les deux branches sont fausses de la même façon.

Le cas `redistribute offset-list …` a la même origine : le magasin est un
**sac de lignes brutes** et non une liste de sources, donc tout ce qui y
tombe ressort préfixé.

### 1.2 `router rip` sérialisé deux fois — CONFIRMÉ

Relevé, dans une seule configuration :

```
router rip
 version 2
 network 172.16.0.0
 network 10.0.0.0
router ospf 1
…
router eigrp 0
router rip
 version 2
 network 172.16.0.0
 network 10.0.0.0
 passive-interface GigabitEthernet0/2
 redistribute redistribute ospf 1 metric 5
```

Deux blocs `router rip`, la première tronquée. Ce n'est pas la
ré-entrée qui crée un second processus — le contenu du second bloc
contient tout le premier —, c'est le **sérialiseur qui émet le bloc
deux fois**, une fois depuis chaque source qui croit en être
propriétaire. La configuration produite n'est pas rejouable : le second
bloc redéclare des réseaux déjà déclarés.

### 1.3 `router eigrp 0` — CONFIRMÉ

`router eigrp NAMED-AS` est accepté ; `parseInt('NAMED-AS', 10)` rend
`NaN`, et le processus naît sous le numéro 0. Il apparaît en
configuration et dans `show ip protocols` (`EIGRP-IPv4 Protocol for
AS(0)`).

Le mode nommé d'EIGRP existe sur IOS 15.x — `router eigrp <nom>` suivi de
`address-family` — mais ce simulateur ne l'implémente pas : son moteur est
explicitement sans minuteur (voir `CLAUDE.md`, section EIGRP), et les
sous-commandes du mode nommé sont refusées à dessein. La commande doit
donc être **refusée**, pas convertie en un processus numéroté qui n'a
jamais été demandé.

### 1.4 router-id OSPF écrasé — CONFIRMÉ

`router ospf 10 vrf CLIENT-A` puis `router-id 10.10.10.10` :

```
router ospf 1
 router-id 10.10.10.10
 network 192.168.100.0 0.0.0.255 area 0
```

Le processus 10 n'existe pas : ses commandes ont été appliquées au seul
processus OSPF que le routeur sait tenir. `Router` porte **un** moteur
OSPF (`ospfIntegration`), et `router ospf <n>` ne fait que le configurer.
Un second numéro de processus n'a nulle part où aller.

### 1.5 Wildcard stocké comme masque — CONFIRMÉ

`network 172.16.3.0 255.255.255.0 area 0` — un masque là où OSPF attend
un wildcard — est accepté, et ressort :

```
 network 0.0.0.0 255.255.255.0 area 0
```

Deux défauts superposés, comme le dit le rapport : aucune validation du
second argument, et corruption du premier. Le réseau saisi a disparu.

### 1.6 Pertes sèches — CONFIRMÉ

Configurés sans erreur, absents de la configuration : `router bgp 65001`
et tout son contenu (seul le fantôme `router bgp 65002` subsiste — voir
§2), les `route-map`, les `ip prefix-list`. `show route-map` les affiche
pourtant, ce qui donne la signature habituelle : **un magasin lu par une
vue et par personne d'autre.**

Conséquence à ne pas confondre avec un défaut distinct : le rapport note
que `| begin router bgp` « ne s'arrête jamais et déverse toute la
config ». Mesuré, `| begin` fonctionne — il déverse tout parce que
l'ancre n'existe pas dans la configuration. C'est §1.6, pas un défaut du
filtre.

### 1.7 `logging buffered` — CONFIRMÉ, et le défaut est à moi

```
logging buffered 4096 debugging
```

apparaît sans avoir été configuré. C'est une conséquence directe du
chantier 5 de l'itération précédente : `show logging` annonçait un buffer
que la configuration ne déclarait pas, et j'ai fait déclarer le buffer.

La moitié était juste — sur IOS 15.x d'ISR, la journalisation en mémoire
**est** active par défaut, à `debugging` et 4096 octets. L'erreur est
ailleurs : **IOS n'écrit pas ses défauts dans la running-config.** La
ligne ne doit apparaître que si l'opérateur a changé la taille, la
sévérité, ou a tapé la commande. Le correctif est de rendre
`asRunningConfigLines()` sensible au défaut, pas de reculer sur
l'accord entre les deux vues.

### 1.8 RIB et CEF — CONFIRMÉ, et l'inversion a une cause

Relevé, pour cinq routes statiques configurées :

```
=== show ip route ===
Gateway of last resort is not set
      192.168.53.0/24 is subnetted, 1 subnets
S        192.168.53.0/24 [1/0] via 0.0.0.0
      192.168.60.0/24 is subnetted, 1 subnets
S        192.168.60.0/24 [1/0] via 10.0.99.99

=== show ip cef ===
0.0.0.0/0            no route
10.0.12.0/24         attached             GigabitEthernet0/0
172.16.1.0/24        attached             GigabitEthernet0/1
192.168.50.0/24      10.0.12.2            GigabitEthernet0/0
192.168.53.0/24      0.0.0.0              Null0
192.168.60.0/24      10.0.99.99
0.0.0.0/0            10.0.12.2            GigabitEthernet0/0
0.0.0.0/0            172.16.1.2           GigabitEthernet0/1
```

Le rapport a raison mot pour mot : la RIB garde exactement les deux
routes qu'elle devrait écarter et écarte les trois qu'elle devrait
garder.

**La cause de l'inversion est précise, et elle vient du chantier 2.**
`isRouteInterfaceUsable(iface)` commence par chercher le port ; quand la
route n'a **pas** d'interface — parce que son prochain saut est
irrésolvable et qu'`addStaticRoute` n'a donc rien pu résoudre — le port
est absent et la fonction rend `true`. La route la plus douteuse est donc
la seule à échapper au contrôle, tandis que les routes correctement
résolues subissent le contrôle de porteuse et disparaissent sur une
interface non câblée.

Trois corollaires mesurés :

- `Gateway of last resort is not set` alors que deux routes par défaut
  existent — la passerelle est cherchée dans la table *filtrée*.
- `S 192.168.53.0/24 [1/0] via 0.0.0.0` au lieu de `is directly
  connected, Null0` : `Null0` est traité comme un prochain saut.
- `show ip route summary` compte 7 routes quand la table en affiche 2 :
  le résumé lit la table brute, la vue lit la table filtrée. Même classe
  que le rapport (14 contre 7), autre topologie.

La CEF, elle, n'élit rien : elle programme la route irrésolvable avec une
interface vide et les deux défauts, dont celle à distance 250.

### 1.9 `show ip protocols` rend OSPF deux fois — DÉFAUT À MOI

Non signalé par le rapport sous cette forme (il l'attribue à §1.2), mais
mesuré :

```
Routing Protocol is "ospf 1"
  …
  Number of areas in this router is 1
  Reference bandwidth unit is 100 mbps
  …
Routing Protocol is "rip"
  …
Routing Protocol is "ospf 1"
  …
  Number of areas in this router is 1. 1 normal 0 stub 0 nssa
  Maximum path: 4
```

Deux blocs OSPF, de **deux rendus différents**.
`CiscoShowCommands.ts:876` en portait déjà un ; le lot de finition §4 en
a ajouté un second dans la registration, sans voir que le helper appelé
juste au-dessus — sous condition `isRIPEnabled()` — en produisait déjà
un. Sans RIP il n'y en avait qu'un, ce qui explique que la suite de
fidélité écrite alors ne l'ait pas vu : elle n'activait pas RIP.

C'est exactement le défaut que ce corpus de PRD combat — deux rendus
d'une même question — et je l'ai introduit en corrigeant une absence.
La leçon pour l'invariant : un test qui vérifie qu'une chose *apparaît*
ne dit rien sur le nombre de fois où elle apparaît.

### 1.10 Acceptation silencieuse — CONFIRMÉ, 7 sur 7

| Commande | Mesuré |
|---|---|
| `router ospf 10 vrf CLIENT-A` | acceptée, fusionnée dans `ospf 1` |
| `router eigrp NAMED-AS` | acceptée, devient `eigrp 0` |
| `address-family ipv4 unicast autonomous-system 200` | acceptée |
| `af-interface GigabitEthernet0/1` | acceptée, prompt inchangé, `hello-interval` ensuite refusé |
| `area 0 stub` | acceptée — IOS refuse (`% OSPF: Area 0 is the backbone area and cannot be a stub area`) |
| `router bgp 65002` | acceptée — IOS refuse (`% Currently a BGP peer to AS 65001`) |
| `no shutdown` en config globale | acceptée hors contexte |
| `ip route … track 1` | acceptée, sérialisée sans le `track` |

### 1.11 Commandes manquantes — CONFIRMÉ

Les quatorze sont refusées. `ipv6 address FE80::1 link-local` est refusé
avec `% Invalid IPv6 address format (expected addr/prefix)`
(`CiscoConfigCommands.ts:927`) : le message est maison, et la règle est
fausse — `link-local` exclut précisément le préfixe.

### 1.12 Affichage — CONFIRMÉ

```
GigabitEthernet0/0         [down/down]
    [object Object]
    [object Object]
```

Une adresse IPv6 stockée comme objet, rendue sans `.toString()`.

```
show running-config | section ip route
ip route 192.168.50.0 255.255.255.0 10.0.12.2
!
ip route 192.168.51.0 255.255.255.0 10.0.12.2
!
```

Le `!` est inséré après chaque ligne.

```
show ip route connected
"Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP\n\n"
```

Légende tronquée à sa première ligne.

Messages inventés : aucun n'est un littéral du dépôt — ils sont
**composés** par `LoggingConfig.formatEntry` à partir d'une étiquette et
d'une sévérité, si bien qu'un `append('errors', 'fault', '… lost carrier
(NO-CARRIER)')` (`FaultProjection.ts:131`) devient
`%FAULT-3-ERRORS: …`. Le correctif n'est donc pas de réécrire des
chaînes mais de **cesser d'émettre ces événements sur le canal syslog**,
la perte de porteuse étant déjà couverte par `%LINK-3-UPDOWN`.

---

## 2. Chantier A — Le sérialiseur, et le magasin qu'il lit

C'est le plus urgent : une configuration corrompue est un défaut
fonctionnel. Elle est rejouée à l'import d'une topologie, donc elle
**refait** l'équipement.

### 2.1 La règle

> Ce que la configuration rend doit pouvoir être retapé tel quel et
> produire le même équipement. Un test le vérifie en bouclant : sérialiser,
> rejouer sur un routeur neuf, re-sérialiser, comparer.

Cet aller-retour est l'invariant du chantier. Il attrape §1.1, §1.2,
§1.5 et §1.6 d'un coup, sans énumérer les commandes.

### 2.2 Le magasin stocke des données, pas des lignes

`redistribute` garde aujourd'hui la ligne brute. Il doit garder ce que la
ligne signifie :

```ts
interface RedistributeSource {
  readonly protocol: 'ospf' | 'static' | 'connected' | 'rip' | 'eigrp' | 'bgp';
  readonly processId?: number;
  readonly metric?: readonly number[];
  readonly routeMap?: string;
}
```

Le sérialiseur rend alors une ligne à partir de la donnée, et le mot
`redistribute` n'apparaît qu'à un seul endroit. Même traitement pour tout
champ dont le sérialiseur préfixe le contenu.

### 2.3 Un processus est identifié par (protocole, identifiant, vrf)

`get-or-create` sur cette clé, jamais `create`. Cela règle §1.2 (une
seule entité `rip`), §1.3 (un identifiant non numérique n'est pas une
clé, donc la commande est refusée) et §1.4 (`ospf 10 vrf CLIENT-A` est
une clé distincte d'`ospf 1`).

Pour OSPF, la conséquence est plus profonde qu'un index : `Router` porte
un moteur unique. Deux issues, et le choix n'est pas cosmétique :

1. **Refuser** un second processus OSPF (`% OSPF: Process 10 is not
   supported on this platform`, ou la formulation exacte à vérifier) —
   honnête, immédiat, et cohérent avec ce que le moteur sait faire.
2. **Porter plusieurs moteurs**, indexés par processus — fidèle, et un
   chantier en soi (SPF par processus, redistribution entre processus,
   `show ip ospf <n>` réellement sélectif).

**Recommandation : (1) maintenant, (2) plus tard si un besoin l'exige.**
Refuser dit la vérité ; fusionner la cache.

### 2.4 Ce qui n'est pas sérialisable est refusé au parsing

Le corollaire du §2.1 : si une commande n'a pas de rendu, elle ne doit
pas être acceptée. C'est la porte d'entrée du chantier B.

---

## 3. Chantier B — Purger l'arbre de ce qui n'a pas de suite

### 3.1 La règle

> Un nœud sans effet observable n'existe pas. Accepter puis ignorer est
> pire que refuser : l'opérateur croit sa configuration appliquée.

### 3.2 L'invariant, et sa limite

Le rapport propose : pour chaque feuille, exécuter la commande puis
vérifier qu'elle apparaît en configuration ou modifie un `show`. C'est la
bonne idée, avec une réserve à écrire dans le test lui-même : **toutes
les commandes de configuration ne se rendent pas en configuration** —
`clear`, `debug`, `reload`, un `no` qui ramène un défaut — et toutes ne
modifient pas un `show` observable. Le test aura donc une liste
d'exceptions nommées, comme `command-trie-hygiene.test.ts` en a une, et
c'est cette liste qui devra rester courte.

Deux formulations utilisables tout de suite, sans cette liste :

- **Un mode de configuration existe ou n'existe pas.** Une commande qui
  prétend entrer dans un sous-mode doit changer le prompt.
  `af-interface` échoue à ce test.
- **Un identifiant est valide ou refusé.** `router eigrp NAMED-AS`,
  `router ospf 10 vrf …`, `router bgp <autre-AS>`, `area 0 stub` sont
  quatre refus à écrire, chacun avec le message d'IOS.

### 3.3 Le cas `no shutdown` en config globale

Accepté hors contexte. `CiscoConfigCommands.ts:302` l'enregistre
explicitement comme un no-op (`'Enable (no-op in global config)'`). Le
commentaire dit qu'on savait ; la règle du §3.1 dit que c'est un nœud à
retirer.

---

## 4. Chantier C — Le modèle d'état, quatrième rappel

### 4.1 Ce que l'itération précédente a fait, et ce qu'elle n'a pas fait

`iosInterfaceStatus()` existe et les cinq vues d'interface le lisent. Ce
qui reste dehors : la **RIB** (qui a sa propre règle, §1.8), la **FIB**,
l'état **OSPF** et l'état **IGMP** — d'où les trois vérités que le
rapport relève encore sur la même interface.

### 4.2 La règle

> Une route connectée, une entrée de FIB, une adjacence OSPF et une
> interface IGMP existent si et seulement si
> `iosInterfaceStatus(port).protocol === 'up'`.

### 4.3 Les correctifs, dans l'ordre de dépendance

1. **`isRouteInterfaceUsable` cesse de rendre `true` sur une interface
   absente.** Une route statique dont le prochain saut n'est résolvable
   par aucune interface n'est pas installée — c'est la règle d'IOS, et
   c'est la source de l'inversion.
2. **`Null0` est une interface, pas un prochain saut.** Elle est toujours
   utilisable, et se rend `is directly connected, Null0`.
3. **La FIB dérive de la RIB**, et non de la configuration. Elle
   n'installe que ce que la RIB a élu — donc une seule route par défaut,
   celle de meilleure distance.
4. **`Gateway of last resort` et `show ip route summary` lisent la table
   filtrée**, celle que la vue affiche.
5. **OSPF et IGMP lisent la même vue** que `show ip interface brief`.

---

## 5. Chantier D — Les vues et les messages

Traité en lot une fois A à C posés, sauf les trois qui sont à moi ou
triviaux et partent tout de suite (marqués ⚡).

| Point | Correctif |
|---|---|
| ⚡ `show ip protocols` en double | Un seul rendu (§1.9) |
| ⚡ `logging buffered` par défaut | Ne rendre que ce qui diffère du défaut (§1.7) |
| ⚡ `[object Object]` | `.toString()` sur l'adresse IPv6 |
| `\| section` | Ne pas insérer de `!` ; trouver les sections absentes une fois §1.6 réglé |
| Messages inventés | Cesser d'émettre `fault`, `rip`, `pim` sur le canal syslog |
| `% Network not in table` | Réservé aux commandes qui prennent un préfixe ; les autres rendent leur en-tête ou rien |
| `show ip ospf 99`, `show ip bgp <x>` | Un identifiant inexistant rend une sortie vide, pas la sortie complète |
| `show ip cef <préfixe>` | Honorer l'argument |
| `show ip route connected\|static` | Légende complète |
| `ipv6 address … link-local` | Accepter la forme sans préfixe ; message IOS |
| Alignements | `show ip policy`, `show standby brief`, `show ip pim interface`, `show ip ospf interface brief` |
| `show ip rip database` | Lire `auto-summary` de la configuration |

---

## 6. Tests

1. **Aller-retour de configuration** (§2.1) — le seul test du chantier A
   qui n'énumère rien.
2. **Un mode existe ou n'existe pas** — le prompt change, ou la commande
   est refusée.
3. **Un identifiant invalide est refusé**, avec le message d'IOS.
4. **Une chose apparaît UNE fois** — la leçon de §1.9 : compter, pas
   seulement constater la présence.
5. **RIB, FIB, OSPF, IGMP et `show ip interface brief` s'accordent**,
   comparés entre eux dans un même test, comme les cinq vues d'interface
   le sont déjà.
6. **Aucune sortie ne contient `[object Object]`** — balayage large.

---

## 7. Séquencement

| Lot | Contenu | Dépend de |
|---|---|---|
| **R1** | Les trois ⚡ du chantier D — dont deux régressions à moi | — |
| **R2** | Chantier A : magasin typé, clé de processus, aller-retour | — |
| **R3** | Chantier B : refus des identifiants et des sous-modes absents | R2 |
| **R4** | Chantier C : RIB, FIB, Null0, passerelle, résumé | — |
| **R5** | Chantier C : OSPF et IGMP sur la vue commune | R4 |
| **R6** | Chantier D, le reste | R2, R4 |
| **R7** | Commandes manquantes (§1.11), au cas par cas | R3 |

R1, R2 et R4 sont indépendants. R1 part en premier parce qu'il répare ce
que j'ai cassé.

---

## 8. Hors périmètre

- Le **mode nommé d'EIGRP** (`address-family`, `af-interface`) : le
  moteur est sans minuteur par construction, donc les sous-commandes ne
  peuvent rien régler. Le chantier B les refuse ; les implémenter est un
  autre sujet, et `CLAUDE.md` dit déjà pourquoi.
- Le **multi-processus OSPF** réel (§2.3 option 2).
- Les **VRF** comme plan de transfert : `ip vrf forwarding` est perdu en
  configuration, ce que le chantier A corrige, mais aucun transfert par
  VRF n'existe et ce PRD n'en crée pas.

---

## 9. R4 — Livré

`Router.installedRoutes()` est la seule élection : utilisable
(`isRouteUsable`), puis meilleure distance administrative par préfixe,
les ex aequo conservés pour l'ECMP. `show ip cef` et `show ip route
summary` la lisent ; la RIB lisait déjà `isRouteUsable`. Les trois vues
ne peuvent donc plus décrire trois tables.

Les quatre correctifs de §4.3 :

1. `isRouteInterfaceUsable('')` rend `false`. Une route statique dont
   aucune interface ne résout le prochain saut est configurée et non
   installée — c'était l'inversion : elle était la seule à échapper au
   contrôle, faute d'interface à vérifier, donc la seule à survivre
   quand les routes résolues tombaient.
2. `Null0` se rend `is directly connected, Null0` dans la RIB et
   `attached … Null0` dans la FIB : c'est une interface de rejet, pas un
   prochain saut vers `0.0.0.0`.
3. La FIB dérive de la RIB. Une seule route par défaut est programmée,
   celle de meilleure distance ; la flottante ne l'est pas. La ligne
   `0.0.0.0/0  no route` n'est écrite que lorsque la table n'a
   effectivement aucune route par défaut, et c'est ce que la commande
   dit alors — pas un préfixe de plus.
4. `show ip route summary` compte les préfixes élus, `Gateway of last
   resort` nomme le prochain saut de la route par défaut installée.

`show ip cef <préfixe>` honore son argument (point emprunté au chantier
D, il était dans la même fonction).

**Tests.** `cisco-rib-fib-agreement.test.ts` (10 cas) compare les vues
entre elles et jamais à une chaîne écrite à la main : l'ensemble des
préfixes de la FIB est celui de la RIB, le total du résumé est le compte
de la FIB, câbler une interface éteinte fait apparaître ses routes dans
les trois vues d'un coup, `shutdown` les en retire ensemble.
Discrimination par `git stash` : 7 des 10 tombent avant le correctif.

**Deux suites encodaient l'ancien état, et disaient la même chose.**
`cisco-router-operational-show.test.ts` vérifiait que la FIB « projette
la vraie table de routage » sur un routeur non câblé, dont la vraie
table est vide : la topologie est maintenant réelle, l'intention du test
est intacte. `basic-commandes.test.ts` (4 cas) posait des routes
statiques vers un prochain saut qu'aucune interface ne pouvait résoudre,
puis attendait de les voir ; `setupCiscoTopology()` adresse et active
désormais le lien, ce qu'un vrai IOS exige pour installer la route.
