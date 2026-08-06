# PRD — Fidélité CLI IOS, itération 3 : complétude, état unique, sortie d'erreur

> Fait suite à `docs/PRD-CLI-Fidelite-IOS.md` (itération 2), dont il reprend
> la méthode et les décisions différées. Périmètre : `CiscoRouter`
> (C2911 / IOS 15.7(3)M5) et, par ricochet, `CiscoSwitch` et les shells
> Huawei qui partagent les mêmes socles.

---

## 0. Contexte et méthode

Une troisième relecture externe a comparé une batterie complète (boot,
interfaces, DHCP, ACL/NAT, routage, sécurité/SSH, tests négatifs,
persistance) à un IOS 15.7(3)M5 réel. Elle conclut que **deux chantiers
structurels expliquent à eux seuls la majorité des anomalies**, et que le
reste est cosmétique.

Cette conclusion est exacte, et ce document va plus loin : il en identifie
**trois**, plus deux référentiels à unifier, et il donne pour chacun la
ligne de code qui produit le défaut.

### Méthode

Comme aux itérations précédentes : **aucune affirmation du rapport n'est
traitée avant d'avoir été reproduite contre le code qui tourne.** Un
rapport appliqué sans mesure produit des correctifs qui ne corrigent rien.

Concrètement, un routeur `router-cisco` a été instancié via
`DeviceFactory`, piloté par `Router.executeCommand()` et son `shell.getHelp()`,
et l'intégralité des sorties citées ci-dessous est un **relevé littéral**
de cette session, pas une lecture de code. Le protocole est reproductible
et devient, en §8, le socle du harnais de non-régression.

Résultat : **10 constats confirmés, 1 réfuté, 4 défauts supplémentaires
découverts pendant la vérification.**

### Synthèse

| § du rapport | Constat | Verdict | Cause racine |
|---|---|---|---|
| 2.1 | `<cr>` sur commandes incomplètes | ✅ Confirmé | `CommandTrie.ts:922` — `<cr>` dérivé de `node.action`, pas de la complétude |
| 2.1 bis | `<cr>` manquant sur `ip ssh time-out ?` etc. | ❌ **Réfuté** | Le comportement actuel est correct (§1.11) |
| 2.2 | `dot1q` absent de `encapsulation ?` | ✅ Confirmé | `describeArgs` crée un nœud `_hintOnly`, filtré de l'aide **et** de l'auto-extraction |
| 2.2 bis | `speed ?` malformé | ✅ Confirmé | Énumération modélisée en `ParamSpec.literal` faute de type `ENUM` |
| 2.3 | Trois vérités sur l'état d'interface | ✅ Confirmé | Deux booléens (`isUp`/`adminDown`), quatre prédicats, aucun vocabulaire partagé |
| 2.3 bis | RIB non dérivée de l'état | ✅ Confirmé | `Router.ts:904` — l'échappatoire `wasEverCabled()` n'existe que côté RIB |
| 3.1 | Caret inconstant | ✅ Confirmé | 109 sites renvoient le message en dur, sans caret |
| 3.2 | Formats de message non conformes | ✅ Confirmé | `CommandTrie.ts:466` ; `CiscoOspfCommands.ts:26` ; pas de mode EXEC dans le rendu |
| 3.3 | Comptes d'usine invisibles, sel partagé | ✅ Confirmé | `CiscoShowCommands.ts:668` ; `ciscoPasswordRender.ts:75` |
| 3.4 | Aucun `%LINK-3-UPDOWN`, pas d'horodatage | ✅ Confirmé | Câblage syslog **correct** ; `no shutdown` n'est pas une transition |
| 4 | Traîne cosmétique | ✅ Échantillon confirmé | Un site par défaut, listés en §7 |
| — | Valeurs vives injectées dans `?` | 🆕 Nouveau | `DynamicParamResolver` alimente l'aide comme la complétion |
| — | `mtu` nu → `% Invalid input` | 🆕 Nouveau | Troisième verdict de complétude |
| — | `network ?` (config-router) sans `A.B.C.D` | 🆕 Nouveau | `describeArgs` masqué par un enfant réel |
| — | Descriptions vides en série | 🆕 Nouveau | `descriptionForKeyword` rend `''` — 108 entrées pour tout le parc |

---

## 1. Vérification, constat par constat

### 1.1 §2.1 — `<cr>` sur des commandes incomplètes — **CONFIRMÉ**

Relevé :

```
R(config)#ip route ?
  10.0.0.1
  A.B.C.D   Destination prefix
  <cr>

R(config)#ip route 0.0.0.0 0.0.0.0
% Incomplete command.
```

La contradiction que le rapport annonçait comme « vérifiable » est
exactement reproduite. Elle se généralise : `router ospf ?`,
`access-list 10 ?`, `ip dhcp excluded-address ?`, `enable secret ?`,
`ip dhcp pool ?`, `interface ?`, `mtu ?`, `bandwidth ?`, `description ?`,
`lease ?`, `network ?`, `router-id ?`, `ip address ?` — tous annoncent
`<cr>`, aucun n'est exécutable en l'état.

**Cause.** `CommandTrie.nodeCompletionsUnsorted()` :

```ts
// CommandTrie.ts:920-924
// <cr> — shown when the current command is already executable
if (node.action) {
  results.push({ keyword: '<cr>', description: '' });
}
```

Le commentaire dit la bonne règle ; le code teste autre chose.
`node.action` signifie « un handler est branché ici », pas « la commande
est complète ». Or **la quasi-totalité du dépôt s'enregistre via
`registerGreedy`**, qui pose l'action sur le nœud racine de la commande et
laisse le handler valider l'arité *à l'exécution* :

```ts
// CiscoConfigCommands.ts:273
trie.registerGreedy('ip route', 'Establish static routes', (args) => cmdIpRoute(ctx.r(), args));
```

L'aide et l'exécution ne partagent donc **aucune** notion de complétude :
l'une lit la structure de l'arbre, l'autre lit `args.length` dans un
`if` au fond d'un handler. Tant que la complétude n'est pas *déclarée*,
elle ne peut pas être *cohérente*.

### 1.2 §2.2 — `dot1q` absent de `encapsulation ?` — **CONFIRMÉ, et la régression est comprise**

Relevé :

```
R(config-if)#encapsulation ?
  isl
  native
  <cr>
```

Le rapport a raison de qualifier cela de régression : `dot1q` **était**
listé à l'itération 2, et c'est le correctif de l'itération 2 qui l'a
fait disparaître. Le mécanisme est une double exclusion.

`describeArgs('encapsulation dot1q', …)` doit accrocher `<1-4094>` sous
`dot1q`. Comme `encapsulation` est greedy et absorbe `dot1q`, ce nœud
n'existe pas ; `describeArgs` le **crée** en le marquant `_hintOnly` pour
que l'exécution continue de passer par le parent (`CommandTrie.ts:799-807`).

À partir de là, `dot1q` est un enfant réel de `encapsulation`, et :

1. il est **filtré du listing** — `nodeCompletionsUnsorted()` saute les
   enfants `_hintOnly` (`CommandTrie.ts:867-868`) ;
2. il est **filtré de l'auto-extraction** — `autoContinuations()` exclut
   tout mot-clé déjà présent dans `node.children`, `_hintOnly` compris
   (`CommandTrie.ts:770`).

`isl` et `native`, eux, n'ont pas de `describeArgs`, donc l'extraction
depuis la source du handler les remonte. **Décrire un argument a rendu son
mot-clé invisible.**

C'est le symptôme que le rapport lit correctement : « un mot-clé
exécutable mais non documenté signale que le découplage aide/exécution
n'est pas résorbé ». Le même mécanisme frappe ailleurs — voir §1.13.

### 1.3 §2.2 bis — `speed ?` — **CONFIRMÉ**

```
R(config-if)#speed ?
  10    Force speed (10|100|1000|auto)
  <cr>
```

Cause directe, `ciscoArgumentHelp.ts:35-38` :

```ts
tries.configIf.describeArgs('speed', [
  { name: 'speed', type: 'WORD', description: 'Force speed (10|100|1000|auto)',
    literal: '10' },
]);
```

Une énumération de quatre mots-clés a été écrite comme **un** `ParamSpec`
avec un rendu forcé, parce que `ParamType` n'a pas de variante
énumérée. Le modèle de données manque, l'auteur a contourné, la sortie le
montre.

### 1.4 §2.3 — Trois vérités sur l'état d'interface — **CONFIRMÉ**

Relevé sur un routeur dont seul Gi0/0 a reçu `ip address` + `no shutdown`,
sans câble :

```
>>> show ip interface brief
GigabitEthernet0/0    10.0.0.1     YES manual down                  down
GigabitEthernet0/3    unassigned   YES unset  down                  down

>>> show interfaces description
GigabitEthernet0/0             up             down
GigabitEthernet0/3             up             down

>>> show controllers
GigabitEthernet0/3 -
  Hardware is present, link is down
  Administrative state: up
```

Trois commandes, trois réponses, un seul état réel. Et Gi0/3, qui n'a
jamais reçu `no shutdown`, est `down` là où IOS écrit
`administratively down`.

**Cause.** `Port` porte **deux** booléens indépendants (`isUp`,
`adminDown`, `Port.ts:75-76`) et expose **quatre** prédicats dérivés
(`getIsUp`, `isAdminDown`, `hasCarrier`, `isOperationallyUp`). Chaque
commande `show` recompose son propre verdict à la main :

| Commande | Expression | Fichier |
|---|---|---|
| `show ip interface brief` | `port.getIsUp() && carrier.getIsUp()`, puis 3 états | `CiscoShowCommands.ts:265-280` |
| `show interfaces description` | `port.getIsUp()`, puis 2 états | `CiscoShowCommands.ts:1081-1083` |
| `show interfaces status` | `port.getIsUp()`, puis 3 états | `CiscoShowCommands.ts:1094-1096` |
| `show controllers` | `isAdminDown()` | `CiscoCommonShow.ts:919` |
| RIB | `isOperationallyUp()` **ou** `getIsUp() && !isAdminDown()` | `Router.ts:904-905` |

57 appels à ces quatre prédicats sont dispersés dans 15 fichiers. Il
n'existe **aucune fonction** qui traduise l'état d'un port en vocabulaire
IOS (`up` / `down` / `administratively down`), donc chaque site réinvente
la traduction — et n'en réinvente jamais la même.

`isOperationallyUp()` est pourtant la bonne réponse, documentée
(`docs/PRD-Link-State.md §3.1`) et déjà écrite. Elle n'est simplement lue
par aucune vue.

### 1.5 §2.3 bis — La RIB n'est pas dérivée de l'état — **CONFIRMÉ**

```
>>> show ip route
      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks
C        10.0.0.0/24 is directly connected, GigabitEthernet0/0
L        10.0.0.1/32 is directly connected, GigabitEthernet0/0
S*    0.0.0.0/0 [1/0] via 10.0.0.2
```

… pour une interface que `show ip interface brief` déclare `down/down`,
deux commandes plus haut, dans la même session.

**Cause exacte**, `Router.isRouteInterfaceUsable()` (`Router.ts:898-905`) :

```ts
// A port that has never had a cable at all is a fixture built without
// a cable plant (unit tests exercising CLI/RIB behavior in isolation),
// not a real severed link — judge it on line/admin state alone.
if (!port.wasEverCabled()) return port.getIsUp() && !port.isAdminDown();
return port.isOperationallyUp();
```

L'échappatoire est **délibérée** et son intention est légitime : ne pas
casser les fixtures de test sans plan de câblage. Mais elle n'existe que
**dans la RIB**. `show ip interface brief`, lui, exige
`carrier.isConnected()` sans exception. Le même port non câblé est donc
simultanément « utilisable » pour le routage et « down » pour l'affichage.

Ce n'est pas un oubli de propagation : c'est **une échappatoire posée d'un
seul côté d'une frontière qui devait rester unique**. Elle doit être
supprimée ou hissée au niveau du modèle d'état — jamais laissée dans une
seule vue (§3.4).

### 1.6 §3.1 — Émission inconstante du caret — **CONFIRMÉ**

Relevé, quatre commandes fautives d'affilée :

```
[exec] show ip sla monitor
% Invalid input detected at '^' marker.          ← pas de ligne, pas de caret

[config-if] ip address 300.1.1.1 255.255.255.0
% Invalid input detected at '^' marker.          ← pas de ligne, pas de caret

[exec] shwo version
        ^
% Invalid input detected at '^' marker.          ← caret présent

[config] interface GigabitEthernet9/9
                          ^
% Invalid input detected at '^' marker.          ← caret présent
```

**Cause.** Le caret n'est produit qu'à **un** endroit —
`formatInvalidInput()` (`CommandTrie.ts:956-959`), appelé par le parseur
quand *lui* rejette la ligne. Un handler qui valide ses propres arguments
renvoie le message tout seul :

```ts
// CiscoShellBase.ts:1907, et 108 autres sites
if (!/^\d+$/.test(args[1])) return "% Invalid input detected at '^' marker.";
```

**109 occurrences** du littéral hors du formateur, dans 17 fichiers. Le
rapport a raison sur le remède — « le caret doit provenir du même point de
sortie que le message » — mais la mesure montre l'ampleur : ce n'est pas
un point de sortie à créer, c'est 109 points de sortie à supprimer.

Même situation, plus large encore, pour `% Incomplete command.` : **320
occurrences** dans les seuls shells.

### 1.7 §3.2 — Formats de message — **CONFIRMÉ**

```
[exec] show ip s
% Ambiguous command: "s" (matches: ssh, sla, static)

[config] router ospf 0
% Invalid OSPF process ID
```

Attendus IOS : `% Ambiguous command:  "show ip s"` — **commande complète
telle que saisie**, deux espaces après le deux-points, **sans** liste des
candidats ; et pour un identifiant hors plage, le caret générique, une
valeur hors plage étant une erreur de syntaxe et non un diagnostic métier.

Causes : `CommandTrie.ts:461-468` construit le message depuis le **token**
ambigu et y annexe les candidats ; `CiscoOspfCommands.ts:26` renvoie un
message maison.

Le troisième cas est un manque de contexte, pas de format :

```
[exec] shwo version
        ^
% Invalid input detected at '^' marker.
```

En mode EXEC, IOS traite un premier mot inconnu comme un **nom d'hôte** à
joindre en telnet :

```
Translating "shwo"...domain server (255.255.255.255)
% Unknown command or computer name, or unable to find computer address
```

Le caret générique est la réponse du mode `config`. Le rendu actuel ne
sait pas dans quel mode il se trouve — parce que le rendu n'est pas un
service, mais une chaîne littérale recopiée.

### 1.8 §3.3 — Comptes d'usine — **CONFIRMÉ, sel compris**

```
>>> show running-config
Building configuration...
Current configuration : 317 bytes
!
hostname Router1
!
…
end                    ← aucune ligne `username`
```

**Cause.** `CiscoShowCommands.ts:665-668` :

```ts
const users = listUsers.call(router).filter(u => !u.factoryDefault);
```

Le filtre est explicite. Les quatre comptes sont provisionnés dans
`Router.getCredentialStore()` (`Router.ts:3591-3595`) avec
`.asFactoryDefault()`, puis délibérément retirés de toute vue de
configuration — mais restent actifs pour l'authentification. L'utilisateur
ne peut ni les lister, ni les modifier, ni les supprimer.

**Le sel partagé est confirmé et son mécanisme est simple**
(`ciscoPasswordRender.ts:74-76`) :

```ts
function deriveCryptSalt(seed: string): string {
  return md5Hex(`cisco-secret:${seed}`).slice(0, 8);
}
```

Le sel est dérivé **du secret**, et de rien d'autre. Deux entrées portant
le même mot de passe — `enable secret cisco123` et
`username admin secret cisco123` — produisent donc mécaniquement le **même
sel**. Le rapport a raison de dire que c'est cryptographiquement
impossible sur un vrai IOS.

Le déterminisme est un choix assumé (« favours stable, reproducible
output ») et il n'est pas en cause : il suffit d'ajouter l'identité au
germe pour obtenir des sels distincts **et** reproductibles.

### 1.9 §3.3 bis — Chronologie du buffer — **CONFIRMÉ**

```
>>> show logging
    Timestamp logging: disabled
Log Buffer (4096 bytes):

%SYS-6-INFORMATIONAL: User account 'alice' created (priv 15)
%SYS-6-INFORMATIONAL: User account 'bob' created (priv 15)
…
```

`LoggingConfig.attachToBus()` pose `this.buffered = true` au branchement
du bus, c'est-à-dire **au boot** (`LoggingConfig.ts:343`), bien avant tout
`logging buffered`. Sur IOS, le buffer n'existe pas avant sa
configuration. Et `%SYS-6-INFORMATIONAL: User account … created`
(`LoggingConfig.ts:710`) n'existe pas du tout : IOS n'émet aucun log à la
création d'un compte local.

### 1.10 §3.4 — Journalisation — **CONFIRMÉ, mais la cause n'est pas où on la cherche**

Aucun `%LINK-3-UPDOWN` malgré les `no shutdown`, aucun horodatage.

**Le câblage syslog est déjà correct et complet.**
`LoggingConfig.ts:372-393` s'abonne à `port.link.up` / `port.link.down`,
émet `%LINK-3-UPDOWN`, distingue `%LINK-5-CHANGED administratively down`
pour un `shutdown` d'opérateur, et double chaque événement d'un
`%LINEPROTO-5-UPDOWN`. Rien à écrire.

S'il ne sort rien, c'est que **`no shutdown` n'est pas une transition** :

```
=== PORT STATE AT BOOT ===
GigabitEthernet0/0 isUp=true adminDown=false everCabled=false operUp=false
GigabitEthernet0/1 isUp=true adminDown=false everCabled=false operUp=false
GigabitEthernet0/2 isUp=true adminDown=false everCabled=false operUp=false
GigabitEthernet0/3 isUp=true adminDown=false everCabled=false operUp=false
```

Les interfaces démarrent **actives**. `setAdminShutdown(false)` sort donc
immédiatement sur son garde d'idempotence (`Port.ts:716`), aucun événement
n'est publié, aucun message n'est journalisé.

C'est **la même cause** que le Gi0/3 rendu `down` au lieu de
`administratively down` (§1.4). Le rapport le pressent en écrivant que le
chantier 2 « élimine simultanément §2.3, les `%LINK-3-UPDOWN` manquants
et l'incohérence Gi0/2 ». C'est exact.

L'horodatage est un défaut distinct et indépendant : `LoggingConfig.ts:56`
initialise `{ enabled: false, format: 'uptime' }`, alors que la
configuration d'usine IOS porte `service timestamps debug datetime msec`
et `service timestamps log datetime msec`.

### 1.11 §2.1 bis — `<cr>` manquant — **RÉFUTÉ**

Le rapport écrit : « Symétriquement, `<cr>` manque là où il serait
légitime : `ip ssh time-out ?`, `ntp server ?`, `snmp-server community ?`,
`encapsulation dot1Q ?`. »

Relevé :

```
R(config)#ip ssh time-out ?
  <1-120>  SSH time-out interval in seconds
```

**Le comportement actuel est correct.** `ip ssh time-out` sans valeur
n'est pas exécutable sur IOS — il rend `% Incomplete command.` Un `<cr>`
y serait précisément le défaut que le rapport dénonce trois paragraphes
plus haut. Idem pour les trois autres : `ntp server` exige une adresse,
`snmp-server community` une chaîne, `encapsulation dot1q` un VLAN ID.

Ces quatre commandes sont, ironiquement, **les seules de l'échantillon où
l'aide dit déjà la vérité** — parce que ce sont les seules dont les
arguments ont été déclarés par `describeArgs` **et** dont le nœud ne porte
pas d'action propre.

Ce point ne doit pas être « corrigé ». Le confondre avec §2.1 ferait
régresser les quatre seuls cas sains. **Il devient au contraire l'oracle
du chantier 1** : c'est la sortie que les autres doivent rejoindre.

### 1.12 §4 — Traîne cosmétique — **échantillon confirmé**

Vérifiés en session (les autres sont repris du rapport sans re-mesure et
signalés comme tels en §7) :

```
>>> show line
   Tty Line Typ     Tx/Rx     A Roty Acc0 AccI  …     ← « Acc0 », chiffre zéro
*    0    0 CTY   …
     1    1 VTY   …                                    ← pas de ligne AUX

>>> show inventory
NAME: "Router1", DESCR: "Cisco ISR 2911 …"             ← hostname, pas l'entité châssis

>>> show snmp
SNMP agent not enabled                                 ← aucune ligne Chassis

>>> dir flash0:
Directory of flash0:/                                  ← résout, alors que seul flash: est déclaré

>>> show ip protocols
No routing protocol is configured.                     ← après `router ospf 1` accepté et présent en running-config
```

Bannière de boot (`CiscoRouter.ts:562-588`), cinq défauts sur un même
bloc :

```
Cisco C2911 (revision 1.0) with 524288K/65536K bytes of memory.
4 Gigabit Ethernet interfaces
256K bytes of non-volatile configuration memory.
Base ethernet MAC address: 02:00:00:00:00:01
--- System Configuration Dialog ---
```

`Cisco C2911` au lieu de `Cisco CISCO2911/K9` ; `524288K/65536K` = 576 Mo,
une taille qui n'existe pas (512 Mo se rend `491520K/32768K`) ; 4
interfaces GE alors que le 2911 en a 3 — et la cause est en amont, dans
`Router.ts:875` (`const portCount = 4`), pas dans la bannière ; `256K` au
lieu de `255K` ; MAC hors OUI Cisco ; dialogue de configuration annoncé
sans sa question. Manquent l'uptime, `System returned to ROM by`,
`Last reload reason` et le bloc `Technology Package License Information`.

### 1.13 Défauts non signalés par le rapport

Quatre défauts découverts pendant la vérification. Ils partagent les
racines déjà identifiées ; les traiter ne coûte rien de plus.

**a) Des valeurs vives du device fuient dans l'aide `?`.**

```
R(config)#ip route ?
  10.0.0.1                    ← une IP configurée sur le routeur, description vide
  A.B.C.D   Destination prefix
  <cr>

R(config)#interface ?
  GigabitEthernet     GigabitEthernet IEEE 802.3z
  GigabitEthernet0/0                              ← les interfaces réelles, en plus des types
  GigabitEthernet0/1
  …
```

`DynamicParamResolver` (`CommandTrie.ts:901-914`) alimente **à la fois**
la complétion Tab et l'aide `?`. C'est correct pour Tab — un vrai IOS
complète bien les noms d'interfaces — et faux pour `?`, qui ne liste que
la **grammaire**. Un seul appelant à distinguer.

**b) Un troisième verdict de complétude.**

```
[config] mtu          => "                ^\n% Invalid input detected at '^' marker."
[config] description  => "                ^\n% Invalid input detected at '^' marker."
[config] ip route 0.0.0.0 0.0.0.0 => "% Incomplete command."
```

Trois commandes également incomplètes, deux messages différents — dont un
(`% Invalid input`) est faux : IOS rend `% Incomplete command.` pour un
`mtu` nu. L'aide en annonce un troisième (`<cr>`). Le chantier 1 doit
ramener les trois à une seule décision.

**c) `network ?` en `config-router` ne propose pas d'adresse.**

```
R(config-router)#network ?
  area
  <cr>
```

`describeArgs('network', [IP('network', …)])` est bien appelé
(`ciscoArgumentHelp.ts:95-97`) — **mais sur `tries.configRouter`**, alors
que `router ospf` bascule le shell en mode `config-router-ospf`, servi par
un trie distinct, `configRouterOspfTrie` (`CiscoIOSShell.ts:615-616`).
`tries.configRouterOspf` ne reçoit qu'un `router-id`.

La déclaration existe donc, sur un arbre que la commande ne consulte
jamais. Ce n'est pas un défaut de `nodeCompletions` — qui fait cohabiter
correctement paramètres et enfants — mais une déclaration posée au mauvais
endroit, qu'aucun test ne pouvait signaler puisque rien ne relie une
`describeArgs` au trie réellement actif dans un mode. L'invariant §8.1
ferme cette classe : il balaie chaque trie tel qu'il est monté.

**d) Descriptions vides en série.**

```
R(config)#ip nat ?
  inside
  log
  outside
  pool         Define NAT address pool
  service      Enable an ALG for a protocol
  translation
```

`descriptionForKeyword()` rend `''` pour tout mot-clé absent de la table
(`CliKeywordDescriptions.ts:131`), qui compte **108 entrées** pour
l'ensemble du parc de commandes des deux constructeurs. Tout mot-clé
auto-extrait d'un handler greedy sort donc sans description. Le rapport le
constate commande par commande (§4, « descriptions d'aide encore
vides ») ; c'est une seule table à compléter, et un invariant à poser.

---

## 2. Les cinq chantiers

Le rapport en propose trois. La vérification en confirme trois et en
détache deux autres, qui ont chacun leur propre référentiel à unifier et
ne se résolvent pas par les premiers.

| # | Chantier | Règle | Effet |
|---|---|---|---|
| 1 | Complétude déclarée dans l'arbre | §2.1, §2.2, §1.13 b/c/d | Aide et exécution partagent une seule notion |
| 2 | Modèle d'état d'interface unique | §2.3, §3.4 (`%LINK`), Gi0/2, Gi0/3 | Une seule vérité, RIB dérivée |
| 3 | Point de sortie unique des erreurs | §3.1, §3.2 | Caret et format par construction |
| 4 | Référentiel de comptes unique | §3.3 | Config, auth et `show` d'accord |
| 5 | Journalisation d'usine | §3.4 (horodatage, chronologie) | Buffer lisible et fidèle |

Les chantiers 1 et 3 sont indépendants de tout et peuvent démarrer en
parallèle. Le chantier 2 porte le seul arbitrage produit du document
(§3.5). Les chantiers 4 et 5 dépendent l'un de l'autre par le buffer, pas
des autres. Le lot de finition (§7) n'est écrivable qu'après 1 et 3.

---

## 3. Chantier 1 — La complétude devient une propriété de l'arbre

### 3.1 Règle

> Pour tout nœud de l'arbre et tout préfixe d'arguments,
> `?` affiche `<cr>` **si et seulement si** exécuter à ce point ne produit
> pas `% Incomplete command.`

C'est l'invariant que le rapport demande. Il n'est pas testable
aujourd'hui, parce que le second membre n'est connu que d'un `if` à
l'intérieur d'un handler. Le chantier consiste à **le remonter dans la
déclaration**, ce qui le rend à la fois consultable par l'aide et
vérifiable par un test.

### 3.2 Modifications

**a) Arité déclarée sur les enregistrements greedy.**

`registerGreedy` gagne un quatrième paramètre optionnel :

```ts
registerGreedy(
  path: string,
  description: string,
  action: CommandAction,
  options?: {
    continuations?: ReadonlyArray<string | { keyword: string; description: string }>;
    /** Nombre minimal d'arguments pour que la commande soit exécutable.
     *  0 (défaut) = exécutable nue, `<cr>` légitime. */
    minArgs?: number;
  },
): void
```

La signature actuelle (`continuations` en 4ᵉ position) reste acceptée pour
ne pas toucher les centaines d'appels existants : l'option est reconnue
sur un objet, le tableau garde son sens.

`nodeCompletionsUnsorted()` devient :

```ts
if (node.action && this.isExecutableHere(node, consumedArgs)) {
  results.push({ keyword: '<cr>', description: '' });
}
```

où `isExecutableHere` vérifie, dans l'ordre : les `ParamSpec` requis non
encore fournis, puis `minArgs`.

**b) `% Incomplete command.` remonte dans le parseur.**

`match()` connaît alors l'arité et rend `status: 'incomplete'` **avant**
d'appeler le handler. Les 320 `return '% Incomplete command.'` deviennent
progressivement du code mort et se retirent au fil des lots. C'est la même
opération que le chantier 3 mène sur `% Invalid input`, et elle se mène
avec lui.

**c) Type de paramètre énuméré.**

```ts
export type ParamType = … | 'ENUM';

export interface ParamSpec {
  …
  /** Valeurs admises d'un `ENUM`, rendues chacune comme un mot-clé. */
  values?: ReadonlyArray<{ keyword: string; description: string }>;
}
```

`renderParamKeyword` n'a plus à écraser une énumération en un littéral, et
`nodeCompletions` déplie `values` en autant d'entrées. `speed` devient :

```ts
tries.configIf.describeArgs('speed', [{
  name: 'speed', type: 'ENUM', description: 'Force speed',
  values: [
    { keyword: '10',   description: 'Force 10 Mbps operation' },
    { keyword: '100',  description: 'Force 100 Mbps operation' },
    { keyword: '1000', description: 'Force 1 Gbps operation' },
    { keyword: 'auto', description: 'Enable AUTO speed configuration' },
  ],
}]);
```

Mêmes candidats : `duplex`, `switchport mode`, `encapsulation`,
`logging`, `ip nat`, `crypto key generate rsa`, `passive-interface`.

**d) `_hintOnly` cesse de masquer un mot-clé réel.**

C'est le correctif de la régression `dot1q`. Le drapeau mélange deux
intentions : « transparent au *matching* » (voulu — l'exécution doit
passer par le parent greedy) et « invisible à l'*aide* » (non voulu — le
mot-clé existe et le handler l'accepte). On les sépare :

```ts
export interface CommandNode {
  …
  /** Le nœud n'est pas une cible d'exécution : le parent greedy absorbe
   *  le token. Il reste listé par `?` et par Tab — c'est un vrai mot-clé. */
  _passthrough?: boolean;
}
```

- `prefixMatch()` continue de sauter ces nœuds (exécution inchangée) ;
- `nodeCompletionsUnsorted()` **cesse** de les sauter ;
- `autoContinuations()` cesse de les compter comme `children` déjà couverts.

`encapsulation ?` retrouve `dot1q`, et tout `describeArgs` posé sous un
handler greedy documente désormais son mot-clé au lieu de l'effacer.

**e) Les déclarations d'arguments visent le trie réellement actif.**

Correctif de §1.13 c. `describeCiscoArguments()` reçoit les tries par nom
et rien ne vérifie qu'un mode donné consulte bien celui qu'on décore. Le
`network` d'OSPF est déclaré sur `configRouter`, jamais lu en
`config-router-ospf`. La déclaration se déplace ; l'invariant §8.1, qui
balaie chaque trie tel qu'il est monté par `trieForMode()`, empêche la
classe de revenir.

**f) `?` cesse de consulter le résolveur dynamique.**

Correctif de §1.13 a. `nodeCompletions()` et la branche préfixe de
`getCompletions()` n'appellent plus `this.dynamicResolver` ;
`tabCandidates()` continue de l'appeler. L'aide décrit la grammaire, la
complétion connaît le device.

**g) Table de descriptions.**

`CliKeywordDescriptions.ts` passe de 108 entrées à une couverture
complète des mots-clés effectivement atteignables, mesurée par
l'invariant §8.3. C'est un travail de saisie, pas de conception ; il se
parallélise et se vérifie mécaniquement.

### 3.3 Ce que ce chantier corrige à lui seul

§2.1 intégralement, §2.2 intégralement, §1.13 a/b/c/d, et la moitié de la
traîne « descriptions vides » / « aide générique » de §4. Le rapport le
qualifie de « coût faible, couverture large » : la mesure le confirme, à
la réserve près du point (g), qui est long mais trivial.

---

## 4. Chantier 2 — Un seul modèle d'état d'interface

### 4.1 Règle

> `Device → Interface → { adminUp, lineUp, carrier }`, un seul traducteur
> vers le vocabulaire IOS, et **toute** sortie `show` ainsi que la RIB
> calculées depuis lui.

### 4.2 Le traducteur manquant

Le défaut n'est pas que l'état soit mal modélisé — `isOperationallyUp()`
est correct — mais qu'**aucune fonction ne traduise l'état en mots IOS**.
On l'ajoute, à un seul endroit :

```ts
// src/network/devices/inspection/InterfaceStatusView.ts
export type IosLineStatus = 'up' | 'down' | 'administratively down';

export interface IosInterfaceStatus {
  readonly status: IosLineStatus;   // colonne Status
  readonly protocol: 'up' | 'down'; // colonne Protocol
  readonly adminUp: boolean;        // show controllers
  readonly method: 'manual' | 'unset' | 'DHCP';
}

export function iosInterfaceStatus(port: Port, name: string): IosInterfaceStatus;
```

Une seule règle, écrite une fois :

| Condition | Status | Protocol |
|---|---|---|
| `adminDown` | `administratively down` | `down` |
| virtuelle (Loopback/Tunnel/Vlan), admin up | `up` | `up` |
| physique, admin up, carrier | `up` | `up` |
| physique, admin up, sans carrier | `down` | `down` |

Les cinq sites du tableau §1.4 appellent cette fonction et ne composent
plus rien. `show controllers` lit `adminUp` du même objet.

### 4.3 La RIB devient une fonction dérivée

`isRouteInterfaceUsable()` cesse d'avoir sa propre règle : une route
connectée est installée **si et seulement si**
`iosInterfaceStatus(port).protocol === 'up'`. Les routes locales `L /32`
suivent la même condition, les statiques ajoutent la résolvabilité du
next-hop, `permanent` et `track` conservent leurs exceptions
explicites (`Router.ts:948-952`, inchangé).

**Conséquence attendue et voulue** : `S* 0.0.0.0/0 via 10.0.0.2` disparaît
tant que Gi0/0 n'est pas `up`, ce que le rapport relève comme un next-hop
injoignable. Et OSPF cesse d'annoncer `State DR` sur des interfaces
mortes, l'adjacence étant elle aussi conditionnée à `protocol === 'up'`
(`RouterOSPFIntegration.ts`, `RouterDynamicRouting.ts`).

### 4.3 bis Ce que la mise en œuvre a trouvé sous les symptômes

Deux causes réelles n'apparaissaient dans aucun rapport.

**`shutdown` ne posait pas l'état administratif.** `Port.setAdminShutdown()`
existe et documente son rôle, mais seul le routeur Cisco l'appelait. Le
switch Cisco (`CiscoSwitchShell.setIfAdminState`), les deux shells Huawei
et les rejeux de configuration appelaient `setUp()`, qui bouge l'état de
**ligne**. `adminDown` restait donc faux après un `shutdown`, et c'est
pourquoi toutes les vues lisaient `getIsUp()` : c'était le seul drapeau
qui bougeait. La distinction admin/ligne n'était pas mal rendue, elle
n'était pas alimentée.

**Brancher un câble notifiait un lien up sans regarder l'état admin.**
`Cable.connect()` appelle `_notifyLinkUp()` sur les deux extrémités
inconditionnellement. Sur une interface `shutdown`, cela journalisait un
`%LINK-3-UPDOWN … changed state to up` qu'aucun IOS n'émet. La
notification suit désormais l'état résultant : rien du tout si le port
est administrativement bas, `up` ou `down` selon la porteuse sinon — ce
qui rend aussi truthful le `no shutdown` sur une interface non câblée,
qui journalise `changed state to down` et non `up`.

### 4.4 L'échappatoire `wasEverCabled()`

Elle ne peut pas rester où elle est (§1.5). Trois issues, par fidélité
décroissante :

1. **La supprimer.** Un port physique jamais câblé n'a pas de carrier,
   donc pas de route. C'est le comportement réel. Coût : toutes les
   fixtures sans plan de câblage perdent leurs routes connectées.
2. **La hisser dans le modèle.** `Port.carrierState(): 'up' | 'down' |
   'unmodeled'`, et `unmodeled` compte comme `up` **partout** — vues
   comprises. La contradiction disparaît à coût de test nul, mais un
   routeur posé sur le canvas sans câble affichera `up/up`, ce qu'un vrai
   routeur n'affiche pas.
3. **La rendre explicite côté test.** Le comportement de production est
   celui de (1) ; les fixtures qui en ont besoin appellent un helper
   dédié (`wireVirtualCarrier(device)`), et le harnais global le fait pour
   les suites héritées.

**Recommandation : (3).** C'est la seule qui donne la fidélité en
production sans transformer l'échappatoire en dette invisible : elle la
déplace d'une heuristique implicite vers une affordance de test nommée.
Le §4.5 montre qu'elle se déploie en un point unique.

**Livré, et la mesure a été faite avant la décision.** Retirer
l'échappatoire coûtait **10 tests sur 685** dans le domaine routage, sur
3 fichiers. L'un d'eux — `probe-cli-route-detail.test.ts` — croyait
câbler son routeur : il écrivait `new Cable(portA, portB)` alors que le
constructeur prend un identifiant, et ne câblait rien depuis sa création.
L'échappatoire avait donc masqué une fixture fausse pendant tout ce
temps. Les deux autres n'ont réellement pas de plan de câblage et
appellent `__assumeCarrierOnUncabledPorts(true)`, remis à zéro entre
fichiers par `setupGlobalState`.

### 4.5 L'arbitrage différé en itération 2, et comment le lever

L'itération 2 a mesuré que le défaut `shutdown` est la bonne cible, puis a
refusé de basculer : `Port.isUp` vaut `true` à la construction, et « 225
fichiers de test sur 1229 activent une interface explicitement » — les
autres supposent des interfaces déjà actives. La mesure d'aujourd'hui est
cohérente : **233 fichiers sur 1744** contiennent un `no shutdown`.

Le raisonnement de l'itération 2 était juste, mais sa conclusion —
attendre une décision produit — n'est plus nécessaire, parce qu'un levier
existe qui n'existait pas quand elle a été écrite : **`vite.config.ts:46`
déclare un `setupFiles` global**, `src/__tests__/setupGlobalState.ts`,
introduit précisément pour rendre inconditionnel un comportement que 834
fichiers appliquaient à la main.

La migration devient donc :

1. `CiscoRouter` (et lui seul, pas `Switch` ni les hôtes) démarre ses
   interfaces **physiques** en `administratively down`. Le défaut est une
   propriété du profil de device, pas une constante de `Port`.
2. `setupGlobalState.ts` restaure le défaut historique pour les suites
   existantes, en une ligne, avec un commentaire qui date la dette :

   ```ts
   // Les suites antérieures à l'itération 3 supposent des interfaces
   // actives au boot. La fidélité IOS (physique = shutdown) est le défaut
   // de production ; on la neutralise ici pour ne pas migrer 1500 fichiers
   // d'un coup. Une suite qui veut la fidélité appelle
   // `useIosInterfaceDefaults()` dans son propre beforeEach.
   __setLegacyInterfaceDefaults(true);
   ```
3. Les suites de fidélité (§8) et toute nouvelle suite s'écrivent contre
   le défaut réel via `useIosInterfaceDefaults()`.
4. La bascule des suites héritées se fait ensuite au rythme voulu, fichier
   par fichier, sans jamais bloquer.

Ce qui était un big-bang de 1500 fichiers devient un changement d'une
ligne plus une migration incrémentale optionnelle. **L'arbitrage produit
n'a plus lieu d'être posé** : la fidélité est livrable sans en payer le
coût d'un coup.

**Livré.** `CiscoRouter.bootsInterfacesShutdown()` rend `true` ; `Router`
rend `false`, ce qui préserve le comportement VRP, où les interfaces sont
bien actives au démarrage. Le drapeau se pose à la construction du `Port`
(`options.adminDown`), donc sans notification ni entrée de journal au
boot. `setupGlobalState.ts` rend le défaut historique aux suites
antérieures en une ligne ; la suite de fidélité appelle
`__setInterfacesBootShutdown(true)`. Aucune régression sur 3 714 tests
des domaines interfaces, routage, protocoles et vues.

### 4.6 Ce que ce chantier corrige

§2.3 intégralement (les trois vues, Gi0/3, Gi0/2, `show controllers`), le
corollaire routage, les `%LINK-3-UPDOWN` / `%LINEPROTO-5-UPDOWN` manquants
de §3.4, et l'état `State DR` sur interfaces mortes.

---

## 5. Chantier 3 — Un point de sortie unique pour les erreurs

### 5.1 Règle

> Une fonction reçoit la ligne saisie, l'offset du token fautif, le mode
> courant et la nature de l'erreur ; elle seule produit la ligne, le caret
> et le message. **Aucun handler ne renvoie de littéral d'erreur.**

### 5.2 Le service

```ts
// src/network/devices/shells/cli/CliDiagnostic.ts
export type CliErrorKind = 'invalid' | 'incomplete' | 'ambiguous' | 'unknown-exec';

export interface CliDiagnosticContext {
  readonly line: string;         // la ligne telle que saisie
  readonly tokenOffset: number;  // offset du token fautif
  readonly promptWidth: number;
  readonly mode: CliMode;        // EXEC | config | config-if | …
}

export function renderCliDiagnostic(kind: CliErrorKind, ctx: CliDiagnosticContext): string;
```

Table de rendu, alignée sur IOS :

| Nature | Caret | Message |
|---|---|---|
| `invalid` | oui | `% Invalid input detected at '^' marker.` |
| `incomplete` | **non** | `% Incomplete command.` |
| `ambiguous` | **non** | `% Ambiguous command:  "<ligne complète telle que saisie>"` (deux espaces, **sans** liste) |
| `unknown-exec` | non | `Translating "<mot>"...domain server (255.255.255.255)` puis `% Unknown command or computer name, or unable to find computer address` |

`unknown-exec` ne s'applique qu'en mode EXEC sur le **premier** token ;
partout ailleurs, un mot inconnu reste `invalid`. C'est le seul endroit du
rendu qui a besoin du mode, et c'est la raison pour laquelle le mode
entre dans le contexte.

### 5.3 Migration des 429 sites

Un handler qui valide ses arguments signale l'erreur au lieu de la rendre :

```ts
// avant
if (!/^\d+$/.test(args[1])) return "% Invalid input detected at '^' marker.";

// après
if (!/^\d+$/.test(args[1])) throw new CliInvalidInput({ argIndex: 1 });
```

`CiscoIOSShell.execute()` intercepte, calcule l'offset réel du token
depuis la ligne saisie — que le handler ne connaît pas, et c'est
exactement pourquoi le caret manquait — et appelle
`renderCliDiagnostic()`.

Ordre de migration, du mécanique au manuel :

1. **`% Incomplete command.` (320 sites).** La majorité disparaît sans
   remplacement : le chantier 1 déclare l'arité, le parseur rejette avant
   d'appeler le handler. Le `if` devient mort et se retire.
2. **`% Invalid input` sur validation d'argument (~90 sites).** Codemod
   vers `throw new CliInvalidInput({ argIndex })`, l'index se lisant sur
   place.
3. **Le reste (~19 sites).** Revue manuelle : certains sont des erreurs
   métier mal déguisées (`% Invalid OSPF process ID`) et relèvent soit de
   `invalid`, soit d'un message IOS spécifique à rétablir.
4. **Verrou.** Une règle ESLint interdit les littéraux `% Invalid input`,
   `% Incomplete command.` et `% Ambiguous command` hors de
   `CliDiagnostic.ts`. Sans ce verrou, les 429 sites reviennent.

**Livré, avec une nuance sur l'ordre.** Le point de sortie existe et rend
les quatre natures ; `% Ambiguous command` a **disparu** des shells
(0 occurrence hors du rendu). Pour les deux autres, la migration est
amorcée plutôt qu'achevée, et le verrou est un **cliquet** plutôt qu'une
interdiction : un test compte les littéraux restants (86 pour `% Invalid
input`, 319 pour `% Incomplete command.`) et échoue si le nombre remonte.
La raison est que le correctif n'a pas eu besoin d'attendre la migration :
`executeOnTrie` reconnaît le message nu que rend un handler et lui
attache la ligne et le caret, à l'offset du premier argument. Les 86 sites
sont donc **déjà corrects à l'affichage** ; les migrer vers
`throw new CliInvalidInput({ argIndex })` ne gagne que la précision du
caret quand ce n'est pas le premier argument qui fâche. Le cliquet garde
la dette visible et décroissante sans bloquer.

**Deux découvertes de mise en œuvre.**

`unknown-exec` ne peut pas se déclencher sur le seul fait qu'un mot est
refusé en EXEC : une commande que le niveau de privilège courant masque
est refusée elle aussi, et IOS en connaît pourtant le verbe. Le
déclencheur est donc « le premier mot n'existe dans AUCUN arbre EXEC »,
vérifié contre le trie privilégié. Sans cette distinction, `reload` à
privilège 7 se serait mis à répondre `Translating "reload"...`.

L'arité déclarée au chantier 1 refusait `ip address negotiated`. La forme
à mot-clé est une production distincte de `ip address A.B.C.D MASK` et ne
partage pas son arité : `finish()` ne réclame plus les arguments du nœud
quand le premier mot fourni est un mot-clé que le nœud reconnaît, la
sous-forme gardant sa propre exigence.

### 5.4 Ce que ce chantier corrige

§3.1 intégralement, §3.2 intégralement, §1.13 b, et il rend le
comportement d'erreur testable comme un contrat plutôt qu'échantillon par
échantillon.

---

## 6. Chantier 4 — Un seul référentiel de comptes

### 6.1 La décision de conception à trancher

Le rapport pose la question honnêtement et laisse la porte ouverte : si
l'invisibilité des quatre comptes est **délibérée** — des comptes gérés
hors configuration, à la manière d'un compte de récupération en firmware —
le point principal tombe.

**Recommandation : les rendre visibles.** Le simulateur est un outil
pédagogique ; un apprenant doit pouvoir exécuter
`show running-config | include username`, voir ce qui existe, et faire
`no username alice`. Un compte actif à l'authentification mais absent de
la configuration est précisément le genre d'écart qui désapprend. La
survie à `write memory` + `reload` cesse en outre de dépendre d'une
logique implicite.

Les deux branches sont décrites ci-dessous ; **seule la branche A est
chiffrée dans le séquencement**, la branche B étant strictement moins
coûteuse.

**Branche A — visibles (recommandée).**

- Retirer `.filter(u => !u.factoryDefault)` (`CiscoShowCommands.ts:668`,
  `CiscoSwitchShell.ts:3118`, `HuaweiDisplayCommands.ts:664`).
- Les cinq comptes apparaissent en configuration d'usine, avec cinq sels
  distincts.
- `factoryDefault` conserve son rôle utile — distinguer un compte d'usine
  d'un compte opérateur pour `asOperatorOwned()` — mais cesse de piloter
  la visibilité.

**Branche B — invisibles, assumées.** Les comptes restent hors
configuration, et l'on documente le choix dans `CLAUDE.md` et dans l'aide
en ligne du simulateur. §6.2 et §6.3 s'appliquent quand même : le sel et
le message de log sont faux dans les deux branches.

### 6.2 Le sel — indépendant de la branche

```ts
// avant : le sel ne dépend que du secret
function deriveCryptSalt(seed: string): string {
  return md5Hex(`cisco-secret:${seed}`).slice(0, 8);
}

// après : l'identité entre dans le germe
function deriveCryptSalt(seed: string, scope: string): string {
  return md5Hex(`cisco-secret:${scope}:${seed}`).slice(0, 8);
}
```

`scope` vaut `enable:<level>` ou `username:<name>`. Les sels redeviennent
distincts, le rendu reste déterministe et reproductible. Même traitement
pour `deriveType8Salt`, `deriveType9Salt` et `deriveType7Salt`, qui
partagent le défaut.

### 6.3 Le message de log — indépendant de la branche

`%SYS-6-INFORMATIONAL: User account 'alice' created (priv 15)`
(`LoggingConfig.ts:705-716`) n'existe pas sur IOS : la création d'un
compte local n'émet aucun log. La forme est fautive, pas l'événement.

Le mécanisme réel, si l'on veut tracer la création à des fins
pédagogiques, est `archive log config` avec
`%PARSER-5-CFGLOG_LOGGEDCMD`, qui journalise **la commande saisie** —
donc uniquement pour les comptes créés par l'opérateur, jamais pour les
comptes d'usine. `CiscoEemNetflowArchiveCommands.ts` porte déjà la
famille `archive`, c'est là que cela s'accroche.

### 6.4 Cohérence transverse

Un test unique doit vérifier que les cinq comptes sont reconnus par
**tous** les consommateurs : `show running-config`, `show privilege`,
authentification SSH sous `login local`, `AaaAuthenticator`. C'est la
version « comptes » de l'invariant d'état du chantier 2 : un référentiel,
plusieurs lecteurs, aucun lecteur avec sa propre copie.

---

## 7. Chantier 5 et lot de finition

### 7.1 Chantier 5 — Journalisation d'usine

| Point | Correctif | Site |
|---|---|---|
| Horodatage absent | Défaut d'usine `service timestamps debug datetime msec` **et** `log datetime msec` | `LoggingConfig.ts:56` |
| Buffer antérieur à sa configuration | Soit `logging buffered` en configuration d'usine (fidèle), soit purge des entrées antérieures | `LoggingConfig.ts:343` |
| `%SYS-5-CONFIG_I` en rafale | Aucun correctif — effet de bord légitime du découpage de la batterie ; l'horodatage les rend lisibles | — |
| `%LINK` / `%LINEPROTO` | Aucun correctif propre — sortent du chantier 2 | — |

### 7.2 Lot de finition (§4 du rapport)

À traiter **après** les chantiers 1 et 3, qui rendent enfin ces tests
écrivables. Chaque ligne est indépendante et se parallélise.

| Commande | Correction | Site | Mesuré ? |
|---|---|---|---|
| Bannière de boot | `CISCO2911/K9`, `491520K/32768K`, `255K`, OUI Cisco, dialogue avec sa question, uptime, `System returned to ROM by`, `Last reload reason`, bloc licence | `CiscoRouter.ts:562-588` | ✅ |
| Nombre d'interfaces | 3 GE sur un 2911, pas 4 — corriger à la source | `Router.ts:875` | ✅ |
| `show line` | `AccO` (lettre), ligne AUX, numérotation CTY 0 / AUX 1 / VTY≥2 | `CiscoCommonShow.ts:629-630` | ✅ |
| `show inventory` | `NAME` = entité physique (`CISCO2911/K9 chassis`), pas le hostname | `CiscoShellBase.ts:1468-1476` | ✅ |
| `show snmp` | `Chassis: FTX1234567A` | `CiscoCommonShow.ts` | ✅ |
| `dir flash0:` | Ne doit pas résoudre — seul `flash:` est déclaré par `show file systems` | `CiscoFileSystem.ts:155` | ✅ |
| `show ip protocols` | Bloc OSPF absent ; bloc EIGRP incomplet (AS, poids métriques, distance, `Maximum path`, sources) | — | ✅ |
| `show ip dhcp pool` | Format réel (`Utilization mark`, `Subnet size`, `Current index`/`IP address range`/`Leased addresses`) ; le rendu correct existe déjà côté switch et doit être partagé ; 254 adresses annoncées malgré 10 exclusions | `CiscoDhcpCommands.ts:260` ← `CiscoSwitchShell.ts:4588` | partiel |
| `show ip ospf interface brief` | Colonnes alignées, abréviation `Gi0/0` (largeur 12) | `CiscoOspfCommands.ts:1589` | ❌ |
| `show crypto key mypubkey rsa` | `Key name: <host>.<domain>`, `Usage: General Purpose Key`, date au format IOS | — | ❌ |
| `show ntp associations` | Légende **après** le tableau ; `+` incompatible avec `reach 000` ; `+~` casse l'alignement | `CiscoCommonShow.ts:578-592` | ❌ |
| `show boot` | `Standby not ready to show bootvar` est un artefact HA, inexistant sur 2911 | `CiscoFileSystem.ts:193` | ✅ |
| `show access-lists` | `10 permit 192.168.10.0, wildcard bits 0.0.0.255` | `CiscoAclCommands.ts:526` | ❌ |
| ACL nommée | Numéros de séquence non affichés s'ils n'ont pas été saisis | `CiscoAclCommands.ts` | ❌ |
| `show running-config interface X` | En-tête `Current configuration : N bytes` | `CiscoShowCommands.ts` | ❌ |
| `reload ?` | Ajouter `at`, `cancel`, `in` | `CiscoShellBase.ts:1899` | ❌ |
| Aide générique | `permit tcp ?` / `eq ?` → `A.B.C.D`/`any`/`host`/`object-group` puis `<0-65535>`/`domain`/`ftp`/`www` ; `logging ?` → `buffered`/`console`/`host`/`monitor`/`trap`/`on` | `ciscoArgumentHelp.ts` | ✅ (`logging`) |
| Descriptions vides | `ip nat`, `ip dhcp`, `duplex`, `crypto key generate rsa`, `passive-interface`, `network`, `default-information`, `max-metric`, `timers`, `version`, `enable secret level` | `CliKeywordDescriptions.ts` | ✅ |
| Chrome applicatif | `Desktop` / `R-TEST` isolés en fin de capture — fuite de l'UI dans le flux terminal | `src/components/network/` | ❌ |

La colonne « Mesuré ? » distingue ce qui a été reproduit en session de ce
qui est **repris du rapport sans re-vérification**. Les lignes ❌ doivent
être mesurées avant d'être traitées — c'est la règle de méthode du §0, et
elle vaut aussi pour ce document.

---

## 8. Tests de non-régression : les invariants

Le rapport conclut qu'un jeu de tests couple par couple « que le chantier
1 rend enfin écrivable » est le vrai livrable. C'est exact, et il faut
aller plus loin : **les invariants attrapent les défauts que personne n'a
listés**, ce que des couples ne font jamais. Les quatre défauts de §1.13
en sont la démonstration — aucun n'est dans le rapport, tous seraient
tombés sous les invariants ci-dessous.

`src/__tests__/unit/network-v2/command-trie-hygiene.test.ts` fournit déjà
le modèle : un observateur global, un balayage de l'arbre, une liste
d'exceptions explicites.

### 8.1 Invariant de complétude (chantier 1)

Pour **chaque** nœud de chaque trie des deux constructeurs :

> `?` contient `<cr>` ⟺ exécuter le chemin ne rend pas `% Incomplete command.`

Balayage exhaustif, aucune liste de commandes à maintenir. C'est
l'invariant que le rapport demande, et il détecte au passage §1.13 b.

### 8.2 Invariant d'atteignabilité (chantier 1)

> Tout mot-clé sur lequel un handler greedy dispatche est listé par `?` à
> sa position.

Le rapport note que cet invariant « aurait détecté §2.2 automatiquement ».
C'est vrai, et il aurait aussi empêché la régression de naître :
`describeArgs` a rendu `dot1q` invisible **sans qu'aucun test ne
tombe**.

### 8.3 Invariant de description

> Aucune entrée de `?` n'a de description vide, hors `<cr>`.

Attrape §1.13 d et verrouille le point (g) du chantier 1 une fois la
table complétée.

### 8.4 Invariant d'état (chantier 2)

> Pour chaque port et chaque combinaison `(adminUp, lineUp, carrier)`,
> `show ip interface brief`, `show interfaces description`,
> `show interfaces status`, `show interfaces` et `show controllers`
> s'accordent, et la présence de la route connectée dans `show ip route`
> suit `protocol == up`.

Comparaison **croisée dans le même test**, pas assertion par commande :
c'est la seule forme qui interdit à une sixième vue de diverger demain.

### 8.5 Invariant de diagnostic (chantier 3)

> Aucun fichier hors `CliDiagnostic.ts` ne contient les littéraux
> `% Invalid input`, `% Incomplete command.` ou `% Ambiguous command`.

Doublé de la règle ESLint (§5.3 point 4).

### 8.6 Invariant de référentiel (chantier 4)

> Tout compte du `NetworkOsCredentialStore` est visible dans
> `show running-config`, accepté par `login local`, et rapporté par
> `show privilege` — ou, en branche B, invisible dans les trois.

### 8.7 Transcriptions de référence

**Par-dessus** les invariants, une suite de transcriptions figées : une
séquence de commandes, une sortie attendue, comparaison littérale.
`src/__tests__/debug/cisco/` fournit déjà le harnais (`_cisco-suite.ts`).
La différence avec l'existant est qu'elles deviennent **assertives** au
lieu d'être des dumps de diagnostic.

---

## 9. Séquencement

| Lot | Contenu | Dépend de | Livre |
|---|---|---|---|
| **L1** | Chantier 1 (a–f) + invariants 8.1/8.2 | — | §2.1, §2.2, §1.13 a/b/c |
| **L2** | Chantier 3 + ESLint + invariant 8.5 | — | §3.1, §3.2 |
| **L3** | Chantier 1 (g) + invariant 8.3 | L1 | Descriptions vides de §4 |
| **L4** | Chantier 2 §4.2–4.3 + invariant 8.4 | — | §2.3, corollaire routage |
| **L5** | Chantier 2 §4.4–4.5 (défaut `shutdown`, `setupGlobalState`) | L4 | Gi0/3, `%LINK-3-UPDOWN` |
| **L6** | Chantier 4 + invariant 8.6 | — | §3.3 |
| **L7** | Chantier 5 | L5 (pour `%LINK`), L6 (pour le buffer) | §3.4 |
| **L8** | Lot de finition | L1, L2 | §4 |

L1, L2, L4 et L6 sont mutuellement indépendants et parallélisables. L5 est
le seul lot qui touche la ligne de base du simulateur ; il est isolé
exprès, et §4.5 le rend réversible d'une ligne.

### Critères d'acceptation

1. Les six invariants de §8 passent sur `CiscoRouter` **et**
   `CiscoSwitch`.
2. `ip route ?`, `router ospf ?`, `mtu ?`, `access-list 10 ?`,
   `ip dhcp pool ?` n'annoncent plus `<cr>` ; `ip ssh time-out ?`,
   `ntp server ?`, `snmp-server community ?`, `encapsulation dot1q ?`
   n'en annoncent **toujours pas** (non-régression de §1.11).
3. `encapsulation ?` liste `dot1q` ; `speed ?` liste quatre nœuds.
4. Une interface jamais activée est `administratively down` dans les cinq
   vues, comparées entre elles dans le même test.
5. `no shutdown` produit `%LINK-3-UPDOWN` puis `%LINEPROTO-5-UPDOWN`,
   horodatés `*Aug  5 17:46:08.123:`.
6. Toute erreur de syntaxe porte sa ligne et son caret ; aucune n'en porte
   quand IOS n'en porte pas.
7. `show running-config | include username` rend cinq lignes à cinq sels
   distincts (branche A) ou zéro (branche B), et le comportement est
   documenté.
8. `npm run test:run` et `npm run lint` passent.

---

## 10. Risques

| Risque | Portée | Atténuation |
|---|---|---|
| L5 change la ligne de base du simulateur | ~1500 fichiers de test, fixtures, topologies enregistrées | Défaut historique restauré dans `setupGlobalState.ts` (§4.5) ; migration incrémentale, jamais bloquante |
| L4 supprime des routes que des tests attendent | Suites de routage sans plan de câblage | `wireVirtualCarrier()` explicite (§4.4 option 3) ; l'échappatoire devient nommée au lieu d'implicite |
| L2 touche 429 sites | 17 fichiers | Trois vagues (§5.3), de la plus mécanique à la plus manuelle ; ESLint pose le verrou avant la fin |
| L1 modifie une signature publique de `CommandTrie` | Centaines d'appels | Signature rétrocompatible (tableau *ou* objet en 4ᵉ position) |
| L1 (f) retire des candidats de `?` | Complétion Tab | Tab conserve le résolveur dynamique ; seul `?` le perd |
| Les lignes ❌ de §7.2 n'ont pas été re-mesurées | Lot de finition | Mesure obligatoire avant traitement — règle de méthode §0 |

---

## 11. Ce que ce document n'aborde pas

- Les shells **Huawei VRP** partagent `CommandTrie` et
  `CliKeywordDescriptions` : L1 les affecte mécaniquement, et leur
  vocabulaire d'erreur (caret uniforme sur les trois natures d'échec,
  cf. `CommandTrie.ts:117-124`) doit entrer dans `CliDiagnostic` en L2.
  Aucune revue VRP équivalente n'existe ; il en faudrait une.
- Le **chrome applicatif** qui fuit dans le flux terminal (§7.2, dernière
  ligne) est un défaut d'UI React, hors du périmètre CLI. Il mérite son
  propre diagnostic.
- Les **plateformes autres que le 2911** : `portCount` est une constante
  dans `Router.ts:875`. Le corriger à 3 pour le 2911 rouvre la question
  d'un catalogue de profils matériels, que ce document ne traite pas.
