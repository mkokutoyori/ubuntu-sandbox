# PRD — Fidélité du `debug` sur les équipements Cisco

## 0. Méthode, et ce qu'elle permet d'affirmer

Tout ce qui suit a été **reproduit contre le code qui tourne**, jamais
déduit de la lecture. Quatre sondes ont servi :

1. les 57 formes de `debug` du routeur, chacune activée, désactivée par
   `no debug …` puis par `undebug …`, avec le message rendu à chaque fois ;
2. le déclenchement réel — un `ping`, une adjacence OSPF, un
   `shutdown`/`no shutdown`, une route ajoutée puis retirée — avec les
   lignes captées à la source (`RouterDebugService.subscribe`) ;
3. `show debugging`, `show debug condition`, `undebug all`, en mode
   privilégié et en mode utilisateur ;
4. la même ligne suivie **jusqu'à ses deux destinations**, la console et
   le tampon de `show logging`.

Une distinction est tenue tout du long, parce qu'elle décide du
correctif : ce que je peux **prouver ici** (le simulateur se contredit,
une catégorie n'a pas d'émetteur, deux plateformes divergent) et ce qui
relève de ma **connaissance d'IOS sans matériel sous la main** pour le
vérifier. Les seconds sont marqués « à confirmer », et le PRD ne fait
jamais reposer un chantier sur un point non confirmé seul.

---

## 1. Constats

### 1.1 L'horodatage n'existe pas sur la console — et il existe dans le tampon

**Prouvé, et c'est le défaut le plus visible du sous-système.** La même
ligne, au même instant, sur la même machine :

```
-- console (canal debug) --
  "ICMP: echo received, src 10.0.12.1, dst 10.0.12.2"
-- tampon (show logging) --
  "*Aug  6 19:14:16.550: ICMP: echo received, src 10.0.12.1, dst 10.0.12.2"
```

`RouterDebugService.emit()` envoie la ligne à deux endroits :
`broadcast.fan()` (les terminaux abonnés) et `tamponSyslog()`
(`LoggingConfig.appendDebugLine`, qui **fabrique le rendu horodaté**).
Seul le second stampe. `CiscoTerminalSession.startDebugSubscription`
verse la ligne brute dans le puits du terminal, sans passer par quoi que
ce soit.

Or `service timestamps debug uptime` est le **défaut d'IOS**, et tout ce
que ce dépôt a écrit sur `service timestamps` (par-canal `TimestampSpec`,
formats `uptime`/`datetime`, `msec`, `localtime`, `show-timezone`) ne
sert qu'au canal syslog. Le canal qui donne son nom à l'option
— `debug` — ne le lit pas.

Conséquence pratique : aucune trace produite par ce simulateur ne
ressemble à une trace de routeur, et l'exercice le plus courant du
debug — *lire l'ordre et l'écart entre deux événements* — est
impossible.

### 1.2 `debug all` est refusé sur le routeur et sans garde-fou sur le switch

**Prouvé.**

| Plateforme | `debug all` | `undebug all` |
|---|---|---|
| Routeur | `% Invalid input detected at '^' marker.` | `All possible debugging has been turned off` |
| Switch | `All possible debugging is on` | `All possible debugging has been turned off (disabled)` |

Sur le routeur on peut donc **éteindre ce qu'on ne peut pas allumer**.
Sur le switch la commande passe sans un mot, alors qu'IOS pose une
question avant (`This may severely impact network performance.
Continue? (yes/[no]):` — *forme à confirmer*), précisément parce que
c'est la commande qui met un routeur à genoux.

### 1.3 `debug ip ospf …` exige qu'OSPF tourne — IOS non

**Prouvé.** Sur un routeur sans `router ospf`, les six formes répondent :

```
debug ip ospf adj             => % OSPF is not enabled.
debug ip ospf events          => % OSPF is not enabled.
debug ip ospf hello           => % OSPF is not enabled.
debug ip ospf packet          => % OSPF is not enabled.
debug ip ospf spf             => % OSPF is not enabled.
debug ip ospf lsa-generation  => % OSPF is not enabled.
```

C'est une inversion de cycle de vie. Un drapeau de debug est
**indépendant de la configuration** : on l'arme AVANT de configurer,
justement pour voir l'adjacence se former. La sonde le montre : debug
activé avant `router ospf 1`, l'adjacence se forme, **0 ligne** ; debug
activé après, 74 lignes. Le laboratoire le plus classique d'OSPF ne peut
pas être fait dans le bon ordre.

Le même message répond aussi à `debug ip ospf zzz`, donc un mot-clé
inexistant est diagnostiqué comme une absence de processus.

### 1.4 Le fourre-tout `debug ip <inconnu>` active autre chose

**Prouvé.** La dernière ligne du gestionnaire est
`return svc.enable('ip.packet', sub)` — tout ce qui n'est pas reconnu
devient un debug de **paquets IP** filtré par une ACL dont le nom est le
texte tapé :

```
debug ip rip events   => IP packet debugging is on for rip events
debug ip bgp updates  => IP packet debugging is on for bgp updates
```

Deux mensonges par ligne : on arme une capture de paquets que personne
n'a demandée (celle qui coûte le plus cher), et on nomme une liste
d'accès qui n'existe pas. Une commande inconnue doit être refusée.

### 1.5 Huit commandes promettent une sortie qu'aucun code n'émet

**Prouvé** — mesuré en confrontant les catégories déclarées aux
appels `emit`/`emitLine` du dépôt entier, puis vérifié en marche : RIP
réellement actif entre deux routeurs, `debug ip rip` armé, **0 ligne** ;
HSRP réellement configuré, `debug standby` armé, **0 ligne**.

| Commande | Réponse | Lignes possibles |
|---|---|---|
| `debug ip rip` | `RIP debugging is on` | aucune |
| `debug ip eigrp` / `debug eigrp` | `EIGRP debugging is on` | aucune |
| `debug ip bgp` | `BGP debugging is on` | aucune |
| `debug ip ssh` | `SSH debugging is on` | aucune |
| `debug ip nhrp` | `NHRP debugging is on` | aucune |
| `debug standby` | `HSRP debugging is on` | aucune |
| `debug port-security` | `Port security debugging is on` | aucune |
| `debug crypto pki transactions` | `PKI Transactions debugging is on` | aucune |

C'est le motif que ce dépôt a déjà démonté ailleurs (« un magasin lu par
personne »), retourné : **une porte sans pièce derrière**. Et c'est plus
grave qu'une commande absente, parce qu'un opérateur qui arme un debug
et ne voit rien conclut que *l'événement n'a pas eu lieu*.

### 1.6 Vingt catégories déclarées sur quarante-cinq n'émettent jamais

**Prouvé.** `DebugCategory` déclare 45 valeurs ; 25 ont au moins un
émetteur. Les 20 autres :

```
crypto.ikev2, crypto.pki, crypto.pki.transactions, crypto.pki.messages,
ip.rip, ip.eigrp, ip.bgp, ip.ssh, ip.nhrp, standby, vrrp, glbp,
aaa.authentication, aaa.authorization, aaa.accounting, radius, tacacs,
ntp.events, ntp.packets, port-security
```

Douze d'entre elles n'ont même **aucune commande** pour les armer
(`vrrp`, `glbp`, les trois `aaa.*`, `radius`, `tacacs`, les deux
`ntp.*`, `crypto.ikev2`…) : du type mort, avec son étiquette dans
`label()` et son entrée dans `groupe()`.

### 1.7 Activation et désactivation ne parlent pas de la même chose

**Prouvé**, quatre cas :

| Commande | Active | `no …` désactive |
|---|---|---|
| `debug ip tcp transactions` | `ip.tcp` | **`ip.packet`** |
| `debug crypto pki transactions` | `crypto.pki.transactions` (« PKI Transactions ») | **`crypto.pki`** (« Crypto PKI ») |
| `debug ip dhcp server events` | `ip.dhcp.server` | rend **la chaîne vide** |
| `debug ip dhcp server packet` | `ip.dhcp.server` | rend **la chaîne vide** |

Un `no` qui éteint autre chose que ce que la commande a allumé est le
défaut le plus traître d'un sous-système de debug : l'opérateur croit
avoir coupé le flot et il coule toujours.

### 1.8 `show debugging` n'a pas la forme d'IOS

**Prouvé** pour le simulateur ; la forme d'IOS est **à confirmer** dans
le détail, mais le principe ne l'est pas. Avec huit debugs armés :

```
Crypto:
  Crypto ISAKMP debugging is on
Interface:
  Interface GigabitEthernet0/0 debugging is on
ICMP:
  ICMP packet debugging is on
IP packet:
  IP packet debugging is on for 100 (detailed)
HSRP:
  HSRP debugging is on
```

Trois écarts. Un **en-tête par catégorie**, alors qu'IOS regroupe sous
quelques rubriques (`Generic IP:`, `OSPF:`, …) et n'écrit une rubrique
que s'il y a quelque chose dessous. L'**ordre alphabétique** de la clé
interne, là où IOS a un ordre de sous-systèmes fixe. Et surtout deux
libellés pour un même fait : l'activation dit `for access list 100`,
`show debugging` dit `for 100`.

Manquent aussi les six catégories armées mais invisibles : `OSPF adjacency`
et `OSPF Hello` étaient armées dans la sonde et ne figurent pas dans le
rendu ci-dessus — elles y sont, mais noyées dans un groupe `OSPF` que la
sonde a tronqué : **à revérifier au moment du correctif**.

### 1.9 Les lignes émises ne sont pas au format d'IOS

**Prouvé** pour ce qui est émis ; la forme exacte d'IOS est ma
connaissance, **à confirmer**.

| Émis | Attendu (IOS) |
|---|---|
| `IP: s=10.0.12.1 (GigabitEthernet0/0), d=10.0.12.2, len 100, sent (proto 1)` | `IP: s=10.0.12.1 (local), d=10.0.12.2 (GigabitEthernet0/0), len 100, sending` |
| `IP: … rcvd (proto 1)` | `IP: … rcvd 3` |
| `OSPF: Send hello packet on Gi0/0` | `OSPF: Send hello to 224.0.0.5 area 0 on Gi0/0 from 10.0.12.1` |
| `OSPF: rcv packet from 10.0.12.2 on Gi0/0` | ligne par type de paquet (Hello, DBD, LS Req…) |
| `RT: add 192.168.9.0 via 10.0.12.2` | `RT: add 192.168.9.0/24 via 10.0.12.2, static metric [1/0]` |
| `GigabitEthernet0/0 went down` | *(voir §1.11)* |

Trois faits structurels derrière ce tableau : l'interface de **sortie**
n'est jamais nommée (seule celle d'entrée l'est) ; le protocole est
poussé dans la ligne de base `(proto 1)` alors qu'il appartient à la
ligne `detail` ; et **la longueur du préfixe et le protocole source
manquent** dans `debug ip routing`, qui est précisément ce qu'on regarde.

`debug ip ospf packet` est le cas extrême : 74 lignes pour une adjacence,
dont 60 identiques à `snd/rcv packet`, sans dire de quel paquet il
s'agit. Une trace qui ne distingue pas un Hello d'un DBD n'apprend rien.

### 1.10 `%OSPF-5-ADJCHG` circule sur le canal debug, amputé de son `%`

**Prouvé**, et **déjà consigné** dans `CLAUDE.md` comme ouvert. Le canal
`ip.ospf.adj` émet :

```
OSPF-5-ADJCHG: Process 1, Nbr 10.0.12.2 on Gi0/0 from Full to Down, KillNbr
```

C'est un message **syslog** de sévérité 5, que la console reçoit déjà
sans rien demander, republié ici sur un canal de debug et privé de son
`%` initial. `debug ip ospf adj` doit imprimer ses propres lignes de
protocole, pas répéter syslog.

### 1.11 Messages et commandes probablement inventés

**Prouvé** qu'ils sont là ; **à confirmer** qu'IOS ne les a pas.

- `MUST NOT be used on production networks; High CPU utilization may
  occur.` préfixe `debug ip packet`. Je ne reconnais cette phrase dans
  aucune sortie IOS. L'avertissement réel d'IOS existe, mais il est
  **interactif et attaché à `debug all`**.
- `%SYS-3-LOGGINGRATE: N debug messages dropped by rate limiting` —
  `DebugBroadcast.emitThrottleNotice`. Le mnémonique n'existe pas à ma
  connaissance ; IOS limite silencieusement.
- `debug interface <nom>` et sa sortie `GigabitEthernet0/0 went down` /
  `keepalive timer expired`. Sur un vrai routeur, une transition
  d'interface est rapportée par `%LINK-3-UPDOWN` et
  `%LINEPROTO-5-UPDOWN`, pas par un debug de ce nom ; ce qui existe
  s'appelle `debug condition interface`.
- Sur le switch, le suffixe `(disabled)` de
  `… debugging is off (disabled)` et de `All possible debugging has been
  turned off (disabled)`.

Chacun de ces quatre est traité par le PRD comme « à vérifier d'abord,
retirer ensuite », jamais l'inverse.

### 1.12 Le switch est un second moteur, et le pire des deux

**Prouvé.** `SwitchDebugService` (238 lignes, 10 catégories) n'a rien de
commun avec `RouterDebugService` (613 lignes, 45 catégories) hormis
`DebugBroadcast`. Résultat, pour les mêmes commandes :

```
[debug ip packet]  => "ip.packet debugging is on"
[show debugging]   => "All debugging is on"
[undebug all]      => "All possible debugging has been turned off (disabled)"
```

La première ligne est la plus parlante : **l'identifiant interne de la
catégorie a fui dans le message à l'opérateur**. Et `show debugging` ne
liste rien — il rend une phrase, jamais l'inventaire qu'IOS rend, si bien
qu'après `debug spanning-tree events` la réponse reste `All debugging is
on` parce qu'un `debug all` traînait.

C'est la dette que ce dépôt a déjà payée deux fois (deux registres
Windows, deux piles SSH) : deux implémentations d'une même question
finissent par donner deux réponses.

### 1.13 Ce qui est conforme, et qu'il ne faut pas casser

L'audit doit aussi dire ce qui va, sinon le correctif détruit du travail
juste :

- **`undebug` accepte toutes les abréviations** (`u`, `un`, `und`, …
  `undebug`) et se comporte comme `no debug` — `undebugAsNoDebug`.
- **`debug condition`** existe, est **globale** comme sur IOS (elle
  s'applique aux debugs déjà armés et à venir), et une ligne qui ne porte
  aucune preuve est **écartée** plutôt que laissée passer.
- **`no logging on` coupe tout** en gardant les drapeaux armés, ce qui
  est exactement la sémantique d'IOS.
- **La limitation de débit** existe et compte ce qu'elle jette.
- **`terminal monitor` est per-session** et le canal debug le respecte.
- **`debug` est refusé en mode utilisateur.**
- Le filtrage par **ACL** (`debug ip packet 100`) et l'axe **`detail`**
  sont deux champs distincts, ce qui est correct.

---

## 2. Chantier A — Le canal : une ligne, un rendu

### 2.1 La règle

> Une ligne de debug est **fabriquée une fois**, horodatée selon
> `service timestamps debug`, et la console et le tampon reçoivent la
> même. Deux rendus d'un même événement sont un défaut, pas un détail
> d'affichage.

### 2.2 Le correctif

`RouterDebugService.emit()` construit la ligne rendue — en demandant son
préfixe à `LoggingConfig` (le `TimestampSpec` du canal `debug` existe
déjà, personne ne le lit) — puis la passe **telle quelle** à
`broadcast.fan()` et au tampon. `appendDebugLine` cesse de re-fabriquer
le rendu et range celui qu'on lui donne.

Le port doit être étroit : `RouterDebugService` ne dépend pas de
`LoggingConfig` mais d'une interface `DebugTimestampSource
{ prefix(nowMs): string }`, posée par `CiscoShellBase.attachLoggingToDevice`
là où l'horloge est déjà attachée.

**Conséquence voulue** : `service timestamps debug uptime` change la
console, `no service timestamps debug` la dénude, et les deux vues
restent d'accord. C'est le même arbitrage que le dépôt a déjà tranché
pour syslog — *la ligne est stockée telle qu'elle a été écrite* — et
c'est ce qui empêche un changement de format de réécrire l'histoire.

---

## 3. Chantier B — Le cycle de vie

### 3.1 La règle

> Un drapeau de debug est **indépendant de la configuration**. Il
> s'arme, il se désarme, et rien d'autre que `debug`/`no debug` ne
> décide de son état.

### 3.2 Les correctifs

1. **`debug ip ospf …` cesse de consulter le moteur.** Le drapeau
   s'arme sur un routeur nu ; les lignes viendront quand OSPF tournera.
   Idem partout ailleurs si un autre gestionnaire fait la même chose
   (le balayage fait partie du lot).
2. **Un mot-clé inconnu est refusé.** `debug ip ospf zzz` répond le
   message d'entrée invalide, pas un diagnostic de processus ; le
   fourre-tout `debug ip <inconnu>` (§1.4) est supprimé.
3. **`no debug X` désarme exactement `debug X`.** Les quatre asymétries
   du §1.7 tombent ; un test les compare deux à deux plutôt que de les
   énumérer.
4. **`debug all` existe sur le routeur**, avec la question d'IOS avant
   d'armer (forme à confirmer), et le switch pose la même.
5. **`show debugging` est privilégié** sur les deux plateformes.

---

## 4. Chantier C — Ne rien promettre qu'on ne tienne

### 4.1 La règle

> Une commande de debug qui ne peut émettre aucune ligne n'existe pas.

C'est la règle du chantier B de `PRD-Routage-Fidelite.md`, appliquée
ici : accepter puis ne rien dire est pire que refuser, parce que le
silence se lit comme une information.

### 4.2 Les correctifs, par ordre de coût croissant

**(a) Câbler ce qui est à portée.** Cinq des huit commandes du §1.5 ont
un moteur réel et un bus qui publie déjà l'événement — il ne manque que
l'abonnement :

| Catégorie | Événement disponible |
|---|---|
| `standby` | HSRP publie ses changements d'état actif/standby |
| `ip.rip` | le moteur RIP émet et reçoit de vrais paquets |
| `ip.bgp` | `BGPEngine` a des transitions de session |
| `port-security` | la violation est déjà un événement |
| `ip.ssh` | `SshSessionRegistry` ouvre et ferme de vraies sessions |

**(b) Retirer les catégories mortes.** Les douze qui n'ont ni commande
ni émetteur (§1.6) quittent `DebugCategory`, `label()` et `groupe()`.

**(c) Refuser ce qui reste.** `debug ip eigrp`, `debug ip nhrp`,
`debug crypto pki transactions` — leurs moteurs n'ont rien à publier
(EIGRP est sans minuteur par construction, ce que `CLAUDE.md` explique
déjà) — sont refusées **en nommant la brique manquante**, comme le PRD
NQA l'a fait pour ses types de test.

---

## 5. Chantier D — Le vocabulaire et les lignes

Traité en lot une fois A à C posés.

| Point | Correctif |
|---|---|
| `show debugging` | Rubriques d'IOS, ordre de sous-systèmes, une rubrique seulement si elle a du contenu |
| `for 100` vs `for access list 100` | Un seul libellé, produit par une seule fonction |
| `ip.packet debugging is on` (switch) | Aucun identifiant interne dans un message |
| `(disabled)` (switch) | Retiré |
| `IP: s=… d=…` | Interface de sortie nommée, `sending`/`rcvd N`, `(proto N)` déplacé vers `detail` |
| `RT: add …` | Préfixe avec sa longueur, protocole source, métrique |
| `OSPF: snd/rcv packet` | Une ligne par type de paquet |
| `OSPF: Send hello packet on X` | Forme complète (groupe, aire, source) |
| `OSPF-5-ADJCHG` sur `ip.ospf.adj` | Remplacé par les vraies lignes d'adjacence (§1.10) |
| Avertissement « MUST NOT be used… » | Vérifié, puis retiré ou déplacé vers `debug all` |
| `%SYS-3-LOGGINGRATE` | Vérifié, puis retiré ou corrigé |
| `debug interface X` | Vérifié ; si absent d'IOS, refusé — les transitions restent à `%LINK`/`%LINEPROTO` |

---

## 6. Chantier E — Un seul moteur

### 6.1 La règle

> Une machine Cisco a **un** sous-système de debug. Le routeur et le
> switch en partagent le moteur, et ne diffèrent que par les catégories
> que leur plateforme connaît.

### 6.2 Le correctif

`SwitchDebugService` disparaît au profit de `RouterDebugService`, renommé
`CiscoDebugService` et paramétré par un **jeu de catégories par
plateforme** (le switch n'a pas `ip.ospf.*`, le routeur n'a pas
`stp.bpdu`). Les dix catégories du switch y entrent ; `mapScope()` — qui
traduit ce que l'opérateur tape vers la catégorie — devient la table
d'analyse commune, ce qu'elle est déjà à moitié.

Ce chantier est le plus gros et le moins urgent. Il est **placé après**
les autres à dessein : corriger d'abord les deux moteurs séparément
ferait le travail deux fois.

---

## 7. Tests

Aucun de ces tests n'énumère de commandes ; chacun est une règle.

1. **Une ligne, un rendu** (§2.1) — la ligne captée sur la console et
   celle rendue par `show logging` sont identiques, y compris l'estampe,
   pour tout réglage de `service timestamps debug`.
2. **Un drapeau s'arme sans son protocole** — pour chaque famille, armer
   le debug sur un équipement nu ne rend jamais un message d'erreur.
3. **`no debug X` désarme `debug X`** — balayage : pour chaque commande
   d'activation, l'état après `no` est vide, et le libellé rendu par les
   deux est le même mot.
4. **Aucune commande ne promet le vide** — pour chaque `debug` accepté,
   il existe un chemin de code qui émet sur cette catégorie ; le test lit
   les catégories déclarées et les émissions, comme le fait déjà le
   cliquet des littéraux d'erreur.
5. **Aucun identifiant interne dans une sortie** — balayage large sur
   `debug` et `show debugging` des deux plateformes : aucune sortie ne
   contient de point-séparateur de catégorie (`ip.packet`, `stp.bpdu`).
6. **Les deux plateformes répondent pareil** — même commande, même
   forme de message sur le routeur et sur le switch.
7. **Ce que le §1.13 énumère continue de marcher** — abréviations
   d'`undebug`, conditions, `no logging on`, limitation de débit,
   `terminal monitor`, refus en mode utilisateur.

---

## 8. Séquencement

| Lot | Contenu | Dépend de | Pourquoi là |
|---|---|---|---|
| **D1** | Chantier A : l'horodatage | — | Un seul point d'émission ; répare toutes les traces d'un coup |
| **D2** | Chantier B : le cycle de vie | — | Indépendant, et débloque les laboratoires OSPF |
| **D3** | Chantier C (a) : câbler les cinq | D2 | Les drapeaux doivent d'abord s'armer librement |
| **D4** | Chantier C (b, c) : retirer et refuser | D3 | Ce qui reste après (a) est ce qui n'a pas de moteur |
| **D5** | Chantier D : vocabulaire et lignes | D1, D4 | Les lignes ne valent d'être reformatées qu'une fois émises |
| **D6** | Chantier E : un seul moteur | D1–D5 | Fusionner avant de corriger ferait le travail deux fois |

D1 et D2 sont indépendants. D1 part en premier parce qu'il ne touche
qu'un point d'émission et change **toutes** les sorties.

---

## 9. Hors périmètre

- **Huawei.** `HuaweiDebugService` a la même famille de questions et
  mérite son propre passage ; les mélanger déciderait des deux à partir
  des mesures d'un seul.
- **La granularité fine des sous-commandes d'IOS** (`debug ip ospf
  packet detail`, `debug ip bgp updates in`, `debug standby terse`…) :
  un sous-mot-clé ne sera ajouté que s'il change ce qui est imprimé, la
  règle du §4.1 s'appliquant aussi à lui.
- **Le rendu `detail` byte-à-byte** d'un paquet : aucune sérialisation
  d'octets n'existe dans ce simulateur, et en inventer une pour
  l'affichage serait un second mensonge par-dessus le premier.
- **La conformité au matériel réel des quatre messages du §1.11** ne peut
  pas être tranchée ici ; le PRD demande la vérification, pas un pari.
