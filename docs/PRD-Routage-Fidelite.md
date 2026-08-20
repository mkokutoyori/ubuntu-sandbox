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
| **R5** | Chantier C : OSPF et IGMP sur la vue commune (**livré, §12**) | R4 |
| **R6** | Chantier D, le reste (**livré, §13**) | R2, R4 |
| **R7** | Commandes manquantes (§1.11), au cas par cas (**livré, §14**) | R3 |

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

---

## 10. R2 — Livré

**L'invariant d'abord.** `cisco-config-round-trip.test.ts` (11 cas)
sérialise, rejoue sur un routeur neuf **par le chemin de l'import de
topologie** (`replayVendorConfig`, exporté pour l'occasion plutôt que
réécrit dans le test — une boucle écrite pour la circonstance ne
prouverait rien de l'import), re-sérialise et compare. Il n'énumère
aucune commande. Écrit avant les correctifs, il tombait sur 10 cas
sur 11 ; il en a trouvé deux que le rapport ne mentionnait pas.

**Ce que l'invariant a trouvé et que personne n'avait relevé.**

1. **Rejouer une configuration la faisait GROSSIR.** `network`,
   `ip route`, `match`, `set` étaient tous empilés sans contrôle
   d'existence, alors que retaper une déclaration déjà posée est un
   no-op sur IOS. À l'import d'une topologie, chaque tour ajoutait un
   doublon. Corrigé aux cinq magasins (RIP, EIGRP, BGP, OSPF, routes
   statiques, clauses de route-map).
2. **`!` ne refermait pas un bloc au rejeu.** `replayVendorConfig`
   revenait à la vue de base sur une transition indenté → non indenté,
   donc un bloc sans aucune ligne indentée (`router eigrp 0` seul) ne la
   déclenchait pas : la tête du bloc SUIVANT était dispatchée dans le
   sous-mode précédent. Mesuré : le second `router rip` du §1.2 était
   refusé et ses lignes atterrissaient dans `router eigrp`. `!` est le
   séparateur de bloc, il rend la main.

**Les points du rapport.**

- **§1.1** — `RedistributeSource` (protocole, identifiant, métrique,
  `metric-type`, `subnets`, `route-map`) remplace le sac de lignes
  brutes ; `renderRedistribute()` est le seul endroit qui écrit le mot.
  `redistribute redistribute ospf 1 metric 5` n'est plus constructible.
  Une source déjà déclarée est remplacée, jamais empilée.
- **§1.2** — Chaque bloc `router …` n'a qu'un propriétaire. RIP et OSPF
  étaient rendus par `getRunningConfig` **et** par le sérialiseur ; les
  deux blocs sont maintenant produits par le sérialiseur seul.
  Conséquence mesurée et voulue : ` version 2` ne paraît plus quand
  l'opérateur ne l'a pas tapé — c'est le moteur qui tourne en v2 par
  défaut, ce que la configuration d'IOS ne dit pas non plus.
- **§1.3** — `router eigrp NAMED-AS` est refusé. Il devenait `NaN`, donc
  le processus 0, qui apparaissait en configuration sans avoir été
  demandé.
- **§1.4** — Un second processus OSPF est refusé (`% OSPF process 1 is
  already running, only one OSPF process is supported on this
  platform`), et `vrf` avec lui. Le `router-id` posé sous `ospf 10`
  n'écrase plus celui d'`ospf 1`.
- **§1.6** — `router bgp <autre AS>` était accepté et **remplaçait** le
  processus par un vide : tout ce qui était configuré sous 65001
  disparaissait sans un mot. `ensureBgp` est un get-or-create, et un AS
  différent est refusé (`% Currently a BGP peer to AS 65001`).
  `route-map` et `ip prefix-list` sont sérialisés (`policyConfigLines`),
  ce qu'aucun rendu ne faisait.
- **`show route-map`** rendait `match ip address 10` là où IOS rend
  l'argument seul sous `Match clauses:`. Même cause que §1.1 : la clause
  gardait la ligne, et les deux rendus la préfixaient.

**§1.5 est réfuté.** `network 172.16.3.0 255.255.255.0 area 0` rendu
`network 0.0.0.0 255.255.255.0 area 0` n'est pas une corruption : IOS
normalise l'adresse en effaçant les bits que le wildcard laisse libres,
et `network 10.1.1.1 0.0.0.255` devient `network 10.1.1.0 0.0.0.255`
pour la même raison. Il n'y a rien à valider non plus — IOS accepte
n'importe quel quadruplet comme wildcard. Ce qui EST vrai et n'était pas
vu : la ligne rendue, retapée, était ajoutée une seconde fois. Un cas de
la suite pin la normalisation et sa stabilité.

**Deux suites encodaient l'ancien état** et disent la même chose que le
correctif : `cisco-policy.test.ts` attendait le `match` en double,
`rip.test.ts` attendait un ` version 2` que l'opérateur n'avait pas tapé.

**Reste ouvert, et sciemment.** Les refus du chantier B (`af-interface`,
`area 0 stub`, `no shutdown` en configuration globale) — R3 ; ce sont
des sous-modes, pas des identifiants. Le `vrf` d'OSPF est refusé plutôt
qu'implémenté, comme §8 le prévoit.

---

## 11. R3 — Livré

Les deux formulations du §3.2, chacune écrite comme une règle et non
comme une liste.

**Un mode existe, ou la commande qui prétend y entrer est refusée.**

- `address-family` sous BGP entre dans un VRAI sous-mode
  (`config-router-af`, prompt `R1(config-router-af)#`), dont
  `exit-address-family` sort. C'est la seule des quatre familles à avoir
  un état derrière elle (`BgpNeighbor.activated`, `addressFamilies`) et
  une configuration courante qui l'exige (`neighbor … activate`). Le
  sous-mode partage la table de commandes de `config-router` plutôt que
  d'en dupliquer une : quelques commandes y sont donc acceptées qu'IOS
  refuserait, ce qui est une inexactitude plus petite que « le sous-mode
  n'existe pas ».
- Le **mode nommé d'EIGRP** est refusé en bloc — `address-family`,
  `af-interface`, `topology`, `exit-af-interface`, `exit-af-topology` —
  comme §8 le prévoit : le moteur est sans minuteur, les sous-commandes
  ne peuvent rien régler.
- **`no shutdown` en configuration globale** n'existe plus. Il était
  enregistré explicitement comme un no-op, et son jumeau `shutdown`
  était déjà refusé : la paire se contredisait.

**Un identifiant est valide, ou refusé avec le message d'IOS.**

- `area 0 stub` et `area 0 nssa` sont refusés (`% OSPF: Area 0 is the
  backbone area and cannot be a stub area`), les autres aires non.

**Le fourre-tout de quatorze mots-clés, et le vrai correctif.** Ces
mots-clés étaient acceptés puis **versés dans la liste `redistribute` de
RIP** — c'est l'origine exacte du `redistribute offset-list …` du
rapport, que §1.1 avait bien nommée mais que R2 n'avait pas fermée. Un
premier jet les refusait tous ; mesuré, c'était le mauvais appel :
`offset-list`, `output-delay`, `flash-update-threshold`,
`validate-update-source` et `traffic-share` sont de VRAIES commandes du
protocole concerné, et les refuser aurait fait rejeter au simulateur une
configuration RIP valide. Elles ont désormais leur propre rangement
(`extras`), se rendent telles quelles dans la configuration, et sont
refusées chez un protocole qui ne les connaît pas — ce qui vaut mieux
que l'acceptation universelle qu'elles avaient. `synchronization` est
accepté sans rien stocker, ce qui est fidèle : il est obsolète depuis
IOS 12.2SB et sans effet sur un vrai routeur non plus.

**`no neighbor` retire vraiment le voisin.** Il faisait partie du même
fourre-tout, donc ne retirait rien : on ne pouvait pas défaire un
`neighbor`.

**`ip route … track 1` garde son `track`** dans la configuration rendue.
Le correctif de `PRD-IP-SLA.md` avait traité la route par défaut ; la
forme ordinaire perdait toujours le mot-clé, donc l'objet suivi
disparaissait au rechargement d'une topologie.

**Deux erreurs de typage introduites par R2 sont corrigées ici**, et
elles enseignent quelque chose sur la mesure : `npx tsc --noEmit` seul
ne les voyait pas, `tsc -p tsconfig.app.json` si. Ce sont les deux
`push` d'une chaîne dans `RedistributeSource[]` qu'avait laissés le
fourre-tout. Le compte d'erreurs de ce projet passe de 170 à 168.

**Tests.** `cisco-config-modes-exist.test.ts` (8 cas), discriminé par
`git stash` : 7 tombent avant le correctif.

**Deux arbitrages avec la session concurrente**, qui travaillait le même
fichier et avait trouvé la même cause racine (`extras`) de son côté.
1. `% OSPF: Area 0 … stub area` **avec ou sans point final** : ni l'une
   ni l'autre ne peut le vérifier sur un vrai IOS d'ici. Leur version,
   déjà sur la branche, garde le point ; le test ne fixe donc pas ce
   caractère plutôt que de prétendre le savoir.
2. **`no synchronization`** : je l'acceptais sans le stocker (obsolète
   depuis IOS 12.2SB), elle le rendait verbatim. Leur règle gagne, et
   c'est l'invariant du §2.1 qui tranche : ce que l'opérateur a tapé
   doit se retrouver dans la configuration. Un jugement sur ce qu'IOS
   affiche par défaut ne vaut pas contre un aller-retour vérifiable.

Le fusionnement a aussi produit **deux défauts qu'aucun conflit ne
signalait** : les `extras` d'EIGRP étaient rendus deux fois (nos deux
boucles ajoutées au même bloc), et `isBackboneArea` était défini dans la
portée de la fonction OSPFv2 alors que l'appel OSPFv3 est dans une
autre. Les deux sont corrigés ici. Les refus ajoutés passent par
`CliInvalidInput` et `requireArgs`, pas par des littéraux : le cliquet
de `cisco-cli-diagnostic-single-exit.test.ts` les avait attrapés.

**`CliIncomplete` est né de ce cliquet.** Un dernier littéral, venu de la
session concurrente, ne pouvait pas passer par `requireArgs` : son
minimum dépend de laquelle de deux formes positionnelles a été tapée.
Le signal `% Incomplete command.` n'existait pas — seul `CliInvalidInput`
l'était — donc le gestionnaire n'avait pas d'autre choix que d'écrire le
message. Il existe maintenant, et c'est le cliquet qui l'a fait écrire.

---

## 12. R5 — Livré

**La règle**, §4.2 : une route connectée, une entrée de FIB, une
adjacence OSPF et une interface IGMP existent si et seulement si
`iosInterfaceStatus(port).protocol === 'up'`. R4 a posé la RIB et la
FIB ; R5 pose OSPF et IGMP.

**Ce qui était mesuré.** Un lien coupé à l'AUTRE bout — le cas le plus
fréquent en salle de TP, et celui qu'aucune des trois vues ne traitait
pareil :

| Vue | Ce qu'elle disait |
|---|---|
| `show ip interface brief` | `down / down` |
| `show ip ospf interface` | `down / down`, **mais `DR: 10.0.12.1`** |
| `show ip igmp interface` | **`up, line protocol is up`** |

**IGMP calculait son propre état** : `port.getIsUp() && port.isConnected()`.
Ce prédicat maison se trompe de trois façons distinctes, et chacune est
mesurée plutôt que supposée :

1. **Perte de porteuse à distance** — le câble est branché
   (`isConnected()` vrai) et le port local n'est pas tombé, donc IGMP
   voyait `up` là où tout le reste voyait `down`. C'est la ligne du
   tableau ci-dessus.
2. **`administratively down` aplati en `down`** — le prédicat ne rend
   qu'un booléen, donc il ne pouvait pas dire les trois états d'IOS. Or
   la distinction est **toute l'information** : `administratively down`
   dit que personne n'a débranché quoi que ce soit, c'est l'opérateur
   qui a tapé `shutdown`.
3. **Une interface virtuelle** (Loopback, Vlan, Tunnel) n'est jamais
   `isConnected()`. Une Loopback avec IGMP activé aurait donc été
   rapportée morte par cette vue et vivante par les quatre autres.

Le cas **câble débranché** était juste — par coïncidence, `isConnected()`
devenant faux — et c'est justement ce qui rendait le défaut difficile à
voir : le premier test qu'on écrit est celui-là.

**Un lien mort n'élit personne.** `ospfIfaceOperUp()` existait déjà, avec
son commentaire au-dessus de la ligne — « A dead link elects nobody: IOS
reports State DOWN there, never DR » — et n'était appliqué qu'à **une
ligne sur les trois qu'il gouverne** : l'état passait bien à `DOWN`, et
les deux lignes suivantes annonçaient `DR: 10.0.12.1`. Le routeur se
déclarait routeur désigné d'un lien mort. `DR`/`BDR` rendent `0.0.0.0`
quand la porteuse est tombée, ce que le commentaire disait déjà.

**Les deux vues OSPF ne s'accordaient pas entre elles non plus.**
`show ip ospf interface brief` lit `iface.state` brut, sans passer par le
même garde-fou : la même interface, au même instant, était `DOWN` dans la
vue détaillée et `DR` dans la vue brève. Deux vues d'un même protocole
qui se contredisent sont pires qu'une vue fausse, parce que l'opérateur
qui croise les deux conclut que l'une est en retard.

**IGMP ne se déclare plus routeur interrogateur** sur une interface qui
n'est pas opérationnelle : un interrogateur est élu par des requêtes
échangées sur un lien vivant, exactement comme un DR.

**Vérifié plutôt que supposé** : `show ip pim interface` rend déjà `none`
dans sa colonne `DR` sur un lien tombé — le runtime efface le DR avec le
voisin — donc rien à corriger là, et cette vue ne porte pas de ligne
d'état, donc elle n'ajoutait pas de quatrième vérité. Mesuré avant de
toucher, pas déduit.

**Laissé en place et signalé** :

- `Hello due in 00:00:10` s'affiche encore sur une interface en état
  `DOWN`, alors qu'aucun Hello n'y est programmé. Je ne trouve pas de
  confirmation de ce qu'IOS imprime exactement là, et §0 interdit de
  faire reposer une correction sur un point non confirmé seul.
- L'**ordre** des interfaces dans `show ip ospf interface` change quand
  l'une tombe (la morte passe en fin de liste), parce que le moteur
  reconstruit sa `Map`. C'est de la mécanique du moteur, pas de la vue,
  et hors du périmètre de R5.

**Tests.** `cisco-interface-state-one-truth.test.ts` (13 cas) compare les
vues **entre elles**, jamais à une chaîne écrite à la main, et balaie les
**trois** façons de tomber plutôt qu'une. Discrimination par `git stash` :
**10 des 13 tombent** avant. Les 3 qui passent des deux côtés sont des
gardes de non-régression, et l'une d'elles — le câble débranché — est
précisément le cas qui était juste par coïncidence.

Trois assertions passaient d'abord **à vide**, et les corriger a fait
gagner trois cas de discrimination : `/DR: 0\.0\.0\.0/` **filtre à
l'intérieur de `BDR: 0.0.0.0`**, donc elle réussissait sur un routeur qui
annonçait `DR: 10.0.12.1` juste au-dessus. Ancrées en début de ligne.
C'est la même famille de piège que le `/0% packet loss/` qui filtrait
dans `100% packet loss` (`CLAUDE.md`, ordre NAT/ACL).

**Mesures.** 69 suites connexes vertes (863 cas) : OSPF, IGMP, PIM,
multicast, vues d'interface, `show ip route`, RIB/FIB. Typecheck
`tsc -p tsconfig.app.json` à 164, inchangé. Lint identique au baseline
sur les deux fichiers touchés (58 problèmes avant, 58 après).

---

## 13. R6 — Livré

Le chantier D compte neuf lignes non-⚡. **Mesurer d'abord a changé le
lot** : quatre étaient déjà correctes, une appartient à un autre agent, et
la mesure d'une sixième a fait remonter un défaut plus lourd que toute la
liste.

### 13.1 Ce qui était déjà correct, et n'a pas été touché

Une sonde vaut mieux qu'une supposition, y compris contre ce PRD :

- **`% Network not in table`** n'est émis par **aucune** commande sans
  préfixe — 17 balayées (`show ip nat translations`, `nat statistics`,
  `mroute`, `pim neighbor`, `igmp groups`, `protocols`, `rip database`,
  `ospf neighbor`, `ospf database`, `cef`, `arp`, `route summary`,
  `policy`, `nhrp`, `sla summary`…). Chacune rend son en-tête ou son
  message propre.
- **Un identifiant OSPF inexistant** rend déjà le vide : `show ip ospf
  99`, `… 99 interface`, `… 99 neighbor`, `… 99 database` répondent tous
  la chaîne vide là où `show ip ospf 1` rend son bloc.
- **La légende de `show ip route connected|static`** est déjà celle,
  entière, de `show ip route`.
- **`show ip rip database`** lit déjà `auto-summary` : la ligne apparaît
  par défaut et disparaît après `no auto-summary`.

Les quatre sont désormais **tenues par un test** (§13.5), pour qu'une
correction future ne les défasse pas en silence.

### 13.2 Le défaut le plus lourd : l'IPv6 ne survivait pas à un enregistrement

En mesurant la ligne « `ipv6 address … link-local` : accepter la forme
sans préfixe » — qui, elle aussi, s'avère déjà acceptée, `% Invalid
link-local address` compris — la sonde a montré autre chose : **la
running-config ne rendait aucune ligne IPv6**. Ni `ipv6 address … link-local`,
ni `ipv6 address …/64`, ni `ipv6 enable`. Comme c'est ce texte que
l'import de topologie rejoue, **un routeur Cisco enregistré puis rouvert
perdait tout son IPv6, en silence.** C'est le test n°1 du §6, et il ne
portait pas sur IPv6.

En le réparant, deux causes plus profondes sont apparues, et aucune n'est
d'affichage :

**`configureIPv6` rangeait toute adresse en `origin: 'static'`**, y
compris une adresse de lien. Or `getLinkLocalIPv6()` cherche
`origin === 'link-local'` : sur une interface dont l'opérateur avait posé
`fe80::1`, cet accesseur rendait **`null`** — et il est lu par une
quarantaine d'endroits, dont tout le plan de données IPv6, la découverte
de voisins, OSPFv3 et `ipconfig` de Windows. Pire, l'entrée dérivée de la
MAC était supprimée au passage : l'interface se retrouvait sans adresse
de lien du tout, du point de vue de tout ce qui la demande par ce nom.
L'origine dit **ce qu'est** l'adresse, pas qui l'a posée.

**`ipv6 enable` écrivait le champ privé du port à travers un cast**
(`(port as unknown as { ipv6Enabled?: boolean }).ipv6Enabled = true`) au
lieu d'appeler `enableIPv6()`. Or dériver l'adresse de lien EUI-64 est
tout ce que cette commande fait : l'interface se déclarait donc active
en IPv6, sans adresse, sans événement sur le bus et sans trace. C'est
exactement le motif que `CLAUDE.md` proscrit — un cast au site d'appel
plutôt qu'une méthode. `no ipv6 enable` passait par le même chemin ;
il appelle maintenant `disableIPv6()`, et **seulement** si aucune adresse
configurée ne reste, une adresse impliquant l'activation sur IOS.

Rendu, enfin : une adresse de lien s'écrit `fe80::1`, sans zone `%iface`
— qu'IOS n'imprime jamais — et sans longueur de préfixe. Elle sortait
`fe80::1%GigabitEthernet0/1/64` dans `show ipv6 interface brief` comme
dans la configuration.

### 13.3 Une vue filtrée ne répond que sur ce qu'on lui demande

`show ip cef <préfixe>` filtrait bien ses entrées, mais poussait
`0.0.0.0/0            no route` **avant** la boucle : la ligne traversait
le filtre, donc `show ip cef 172.16.0.0` répondait sur deux préfixes dont
un que personne n'avait demandé. Cette ligne décrit l'absence de route
par défaut — un fait de la table entière, pas de l'entrée interrogée.

Trouvée en passant et supprimée : **`showIpCef()` dans
`CiscoShowCommands.ts`**, un second rendu de la même vue, branché sur
aucune commande, lisant la table brute (`getRoutingTable()`) là où la
vue réelle lit `installedRoutes()`. Deux réponses possibles à une même
question est le défaut que ce dépôt passe son temps à retirer.

### 13.4 Un en-tête surmonte la colonne qu'il nomme

`show ip pim interface` porte un en-tête sur **deux** lignes et ses
données sur une : les trois se déduisent maintenant des mêmes largeurs.
`Nbr` / `Count` était annoncé une colonne à droite du compte qu'il
surmonte. `show ip ospf interface brief` cadrait son état sur 5 caractères
sous un `State ` de 6, décalant `Nbrs F/C` d'un cran.

### 13.5 Refusé, et pourquoi

**Le `!` de fin de bloc dans `| section`** reste. Ce PRD demande de le
retirer ; le code porte la position inverse, écrite (« IOS includes the
block-terminating ! in | section output »), et une suite entière —
`scenario-cisco-pipe-filters.test.ts` — l'exige dans son titre, son
en-tête et trois assertions. Ma lecture des sorties documentées par Cisco
(`show running-config | section line`) va dans le sens du PRD, mais §0
interdit de faire reposer un chantier sur un point non confirmé seul, et
renverser une décision délibérée et testée sur un souvenir serait pire
que la garder. C'est le même arbitrage que pour `debug interface <nom>`
(`PRD-Debug-Fidelite-Cisco.md` §14). **L'autre moitié de la ligne** —
« trouver les sections absentes » — est traitée : les sections
d'interface étaient bel et bien amputées, de leurs lignes IPv6 (§13.2).

**Les messages inventés sur le canal syslog** (`fault`, `rip`, `pim`)
relèvent de `PRD-Logging-Cisco.md`, tenu par un autre agent. La mesure
lui a été transmise dans `JOURNAL-AGENTS-mandeng.md` plutôt qu'appliquée :
le défaut est **générique** et non ligne par ligne — le mnémonique y est
fabriqué à partir du NOM de la sévérité (`NOTIFICATIONS` pour 5,
`WARNINGS` pour 4, `INFORMATIONAL` pour 6), là où IOS écrit
`%PIM-5-DRCHG`, `%PIM-5-NBRCHG`, `%SEC_LOGIN-5-LOGIN_SUCCESS` — et
n'écrit rien du tout quand CDP découvre un voisin.

**Non traité et signalé** : `show ip pim interface GigabitEthernet9/9`
rend son en-tête pour une interface inexistante quand `show ip igmp
interface` sur la même rend le vide — deux commandes sœurs, deux réponses
à la même situation. Trop mince pour ce lot, assez réel pour être écrit.

### 13.6 Tests et mesures

`cisco-views-and-round-trip.test.ts` (15 cas) vérifie trois propriétés :
une configuration acceptée se relit (jusqu'à **rejouer** la
configuration sur un routeur neuf et comparer), une vue filtrée ne répond
que sur ce qu'on lui demande, et un en-tête surmonte sa colonne — vérifié
en comparant des **positions**, jamais en figeant une chaîne espace par
espace, sans quoi le test casserait au premier changement de largeur sans
rien dire de l'alignement. Les quatre lignes déjà correctes du §13.1 y
sont tenues comme gardes de non-régression.

Discrimination par `git stash` : **10 des 15 tombent** avant. Des 5 qui
passent des deux côtés, 4 sont les gardes du §13.1, et la cinquième — le
rejeu sur un routeur neuf — ne discrimine pas parce que les deux routeurs
rendaient la même chose fausse ; elle teste l'accord entre deux machines,
ce qui reste utile, et je le note plutôt que de la présenter comme une
preuve.

**Mesures.** 427 suites connexes vertes (6 631 cas) : IPv6, NDP, SLAAC,
DHCPv6, OSPF, PIM, IGMP, CEF, routage, RIP, vues d'interface,
sérialisation, Linux et Windows — ces deux derniers parce que le
changement d'`origin` dans `Port.ts` est lu par `ip addr`, `LinkState` et
`ipconfig`. Typecheck `tsc -p tsconfig.app.json` à 164, inchangé ; lint
identique au baseline (120 problèmes avant, 120 après).

---

## 14. R7 — Livré

« Au cas par cas » : ce PRD compte quatorze commandes manquantes sans les
énumérer, alors le lot commence par un balayage.

### 14.1 Le balayage, et une erreur de méthode corrigée en route

Le premier balayage enchaînait les commandes sur une seule machine. Il
était **faux** : `route-map RM permit 10` et `ip access-list standard STD`
entrent dans un sous-mode, donc tout ce qui suivait était jugé ailleurs
qu'où il se tape, et `ip domain-lookup` ou `key chain` — qui existent
pourtant, `CiscoShellBase.ts:3001` et `CiscoKeyChainCommands.ts` — sont
sortis « refusés ». Le second balayage juge **chaque commande sur une
machine neuve, dans son propre contexte**. La liste des refus est passée
de 21 à 20, mais ce ne sont plus les mêmes, et surtout plus les bonnes.

### 14.2 Le cas qui avait un moteur derrière lui

**Le horizon partagé se règle par interface, et le moteur n'en savait
rien.** `RIPConfig.splitHorizon` est un réglage de PROCESSUS, lu à deux
endroits (`sendUpdate`, la mise à jour déclenchée), alors que la commande
est per-interface chez les deux constructeurs. Résultat, **la même
fonction manquait de deux façons différentes** :

- Cisco : `ip split-horizon` / `no ip split-horizon` n'existaient pas.
- Huawei : `rip split-horizon` existait, écrivait dans
  `_huaweiRipIfExtras` — une table que **rien ne lit dans tout le dépôt**
  — et n'avait donc aucun effet non plus. `undo rip split-horizon`
  n'existait pas du tout.

`RIPConfig.splitHorizonByInterface` porte les interfaces où l'opérateur a
dit autre chose que le processus, sur le modèle de `passiveInterfaces`
déjà là ; `splitHorizonOn(iface)` est le prédicat unique que les deux
points d'émission consultent. Une seule table sert les deux
constructeurs : le moteur RIP est le même, et deux réglages pour un seul
comportement finiraient par se contredire.

**Vérifié sur le fil, pas sur l'acceptation.** Une commande acceptée qui
ne fait rien est exactement le défaut d'avant ; le test capture donc ce
que le routeur ÉMET, à la couture d'émission du moteur, en avançant une
horloge virtuelle de 31 s pour déclencher la mise à jour périodique :

| Réglage sur Gi0/0 | A annonce sur Gi0/0 |
|---|---|
| par défaut | `1.1.1.0` |
| `no ip split-horizon` | `10.0.12.0`, `1.1.1.0` |

`10.0.12.0` est la route apprise SUR Gi0/0 : c'est précisément celle que
le horizon partagé retient, donc la seule dont la présence distingue les
deux réglages. Le rendu `no ip split-horizon` dans la configuration suit,
sans quoi le réglage ne survivrait pas à un enregistrement — et seul
l'écart au défaut est rendu, comme le fait IOS.

### 14.3 Le cas où ne rien faire EST le comportement

`ip classless` et `ip subnet-zero` sont acceptées. Elles décrivent le
comportement par défaut d'IOS depuis la 12.0 : un vrai routeur les prend
et ne fait rien, et ne les rend pas dans sa configuration puisqu'elles ne
s'en écartent pas. Les refuser cassait le rejeu d'une configuration
ancienne, où elles figurent presque toujours. **La distinction avec le
défaut du §14.2 est le cœur du lot** : là, la commande fait quelque chose
sur le matériel et ne faisait rien ici ; ici, elle ne fait rien nulle
part. Accepter sans effet n'est une faute que dans le premier cas.

### 14.4 Refusé, et pourquoi — la liste

Chacune de ces commandes est réelle sur IOS et reste refusée, parce
qu'aucun moteur ne pourrait en lire le réglage. Les accepter les rangerait
dans la catégorie du §14.2, pas du §14.3.

| Commande | Brique manquante |
|---|---|
| `ip default-gateway` | n'a de sens qu'avec `no ip routing`, qui ne coupe pas le transfert ici |
| `ip forward-protocol nd` | le relais UDP n'a pas de liste de ports à filtrer |
| `ip tcp synwait-time` | la pile TCP n'a pas de temporisation de connexion réglable |
| `ip scp server enable` | SCP existe mais n'est gardé par rien ; poser la porte suppose de décider ce qu'elle ferme |
| `carrier-delay`, `keepalive` | aucun délai n'existe entre l'état du câble et celui du protocole de ligne |
| `ip route-cache`, `no ip mroute-cache` | il n'y a pas de cache de commutation à vider |
| `input-queue`, `traffic-share` | pas de file d'attente ni de répartition par métrique |
| `nsf ietf|cisco helper` | OSPF n'a pas de redémarrage gracieux |
| `ipv6 rip … enable` | RIPng n'existe pas |

### 14.5 Tests et mesures

`cisco-split-horizon-per-interface.test.ts` (10 cas) : ce que A annonce
sur le fil dans les deux réglages et au retour, le fait que le réglage
soit propre à l'interface et non au processus, sa survie à un
enregistrement et à un rejeu, l'équivalence VRP — y compris que le
réglage soit rangé **sous le nom de port que le moteur parcourt**, un
piège réel puisque les ports Huawei sont nommés `GE0/0/0` alors que la
commande se tape sur `GigabitEthernet0/0/0` — et l'acceptation sans rendu
du §14.3. Discrimination par `git stash` : **8 des 10 tombent** avant.

**Mesures.** 135 suites connexes vertes (2 055 cas) : RIP, routage,
OSPF, Huawei, sérialisation, vues d'interface. Typecheck
`tsc -p tsconfig.app.json` à 163, inchangé ; lint identique au baseline
(192 problèmes avant, 192 après).

**Le PRD est clos** : R1 à R7 livrés.

---

## 15. R8 — Livré : `maximum-paths` borne vraiment la répartition de charge

Le chantier `PRD-Routage-Fidelite.md` avait été déclaré clos en R7. Ce lot
le rouvre pour une raison précise : `PRD-CLI-Fidelite-VRP.md` §18 avait
nommé, sans le traiter, un défaut qui n'était pas de typage mais de
**fonction** — et la mesure a montré qu'il était bien plus large que la
moitié Huawei qui l'avait fait remarquer.

### 15.1 Un moteur réel, et aucun plafond

L'ECMP de ce dépôt est réel depuis l'audit 02 : `Router.lookupRoute`
collecte toutes les routes à égalité parfaite (même préfixe, même
distance administrative, même métrique) et les emploie à tour de rôle.

**Le plafond, lui, n'existait pas.** La valeur était rangée dans **sept
magasins** — un par protocole et par constructeur — et lue par personne :

| Écriture | Lecteur |
|---|---|
| `repo.rip.maximumPaths` (IOS) | aucun |
| `eigrp().maximumPaths` (IOS) | EIGRP seul, qui a le sien |
| OSPF `extra().maximumPaths` (IOS) | aucun |
| OSPF `_getOSPFExtraConfig()` (VRP) | aucun |
| BGP `b.maximumPaths` (VRP) | aucun |
| IS-IS `i.maximumPaths` (VRP) | aucun |
| RIP `ripExtras().maximumPaths` (VRP) | aucun |

Conséquence : **`maximum-paths 1` n'avait aucun effet**. C'est la façon
normale de COUPER la répartition, et le premier geste de tout diagnostic
de trafic asymétrique — une machine où ce geste ne change rien enseigne
exactement le contraire de ce qu'il faut.

Côté VRP le défaut allait plus loin : `maximum load-balancing` n'était
**rendu nulle part**, sur aucun des quatre protocoles, donc perdu au
rechargement d'une topologie — la configuration rendue étant ce qui
REFAIT le réglage à l'import.

### 15.2 Les défauts sont ceux du matériel, et la différence est le sujet

Vérifiés plutôt que supposés, et c'est la seule chose qu'il ne fallait
pas rater :

- **BGP vaut 1.** « By default, BGP installs only the best path to a
  destination in the IP routing table », et Huawei l'écrit aussi (« la
  répartition de charge entre routes BGP n'est pas activée par
  défaut »).
- **Les IGP valent 4.** La documentation Huawei ajoute la phrase qui
  donne son sens à la valeur 1 : « to disable load balancing, set the
  value of number to 1 ».

Les aligner tous sur 4 apprendrait qu'un iBGP répartit tout seul, ce qui
est faux et coûteux. Une conséquence agréable de la valeur juste :
**côté BGP la commande OUVRE au lieu de restreindre**, ce qui est le sens
inverse de son emploi sous un IGP, et la sonde le vérifie dans les deux
sens.

### 15.3 Un seul magasin, et ce qui n'est pas plafonné

`Router.maximumPathsFor(proto)` / `setMaximumPaths(proto, n)` est
l'autorité unique que le plan de données consulte ; les sept sites
d'écriture y passent tous, chacun gardant son champ pour son propre
rendu — un site d'écriture par commande, donc aucune dérive possible.

**`connected` et `static` n'ont pas de plafond, et c'est voulu** :
`maximum-paths` vit sous un processus de routage, aucune commande ne
borne les statiques, donc six routes statiques à égalité se répartissent
toujours — comme sur une vraie machine. `maximumPathsFor` rend
`Infinity` pour elles plutôt qu'une valeur inventée.

### 15.4 Le plafond s'applique aussi à l'INSTALLATION, pas seulement au choix

`RouterOSPFIntegration.installRoutes` — la seule intégration qui produise
réellement plusieurs prochains sauts pour un préfixe — n'installe plus
que `maximumPathsFor('ospf')` entrées. Sans cela, `show ip route`
listerait quatre chemins sur une machine qui n'en emprunte qu'un, et les
deux vues de la même machine se contrediraient : c'est la forme de défaut
que ce dépôt referme partout.

Le plafond appliqué dans `lookupRoute` reste, comme filet pour les
protocoles dont l'installation ne passe pas par là. Il porte sur le
GROUPE de chemins à égalité et non route par route : `maximum-paths`
borne un nombre de chemins vers une destination, pas la validité d'une
route — c'est pourquoi il ne pouvait pas vivre dans `isRouteUsable`.

### 15.5 Une valeur absurde est ignorée plutôt que rangée

`maximum-paths 0` ne stocke rien : un plafond de zéro chemin est une
configuration qu'aucune machine n'accepte, et le ranger produirait un
routeur qui ne route plus rien pour une raison introuvable.

### 15.6 Ce qui reste, et pourquoi

`ipv4-family` / `ipv6-family` côté BGP VRP restent stockés sans effet, et
c'est dit dans `HuaweiRoutingExtras.ts` plutôt que tu : ce simulateur n'a
pas de table de routage par famille d'adresses, donc entrer dans une vue
de famille ne peut rien changer — rendre la ligne promettrait une
séparation qui n'existe pas.

Le plafond n'est pas appliqué à l'installation pour RIP, IS-IS et BGP :
leurs intégrations n'installent qu'un chemin par préfixe aujourd'hui,
donc il n'y a rien à plafonner là, et le filet de `lookupRoute` couvre le
jour où ce ne sera plus vrai.

### 15.7 Mesures

`probe-maximum-paths-borne-ecmp.test.ts` (15 cas) discriminé par
`git stash` sur les huit fichiers touchés : **12 tombent**. Les 3 qui
passent des deux côtés sont les cas de rendu VRP dont la ligne était déjà
absente avant comme après le retrait — ils prouvent le rendu, pas le
plafond.

264 suites connexes vertes (3 665 cas). Typecheck : jeu d'erreurs
**identique** (217). Lint : 177 problèmes avant, 177 après.
