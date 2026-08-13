# PRD — Le logging IOS : ce qu'il dit, ce qu'il refuse, ce qu'il suggère

## 0. Méthode et posture

Ce document est écrit du point de vue de quelqu'un qui configure du syslog
Cisco depuis vingt ans, et qui sait que **le logging est la première chose
qu'un opérateur touche sur un équipement neuf et la dernière qu'il regarde
quand tout va mal**. Un `show logging` qui ment coûte des heures de
diagnostic ; une commande acceptée qui ne fait rien coûte davantage,
parce que l'opérateur croit avoir agi.

Comme les PRD précédents, **chaque affirmation ci-dessous a été mesurée
contre le code avant d'être écrite**. Les commandes ont été tapées dans
la vraie CLI du simulateur, les sorties relevées telles quelles.

---

## 1. État mesuré

### 1.1 Tout est accepté — **CONFIRMÉ, et c'est la racine**

`CiscoShellBase` enregistre `logging` en `registerGreedy` ; `LoggingConfig.apply()`
est un `switch` sur le premier mot dont le `default` **ne fait rien et ne
dit rien**. Mesuré :

```
[ACCEPTE] logging nimportequoi
[ACCEPTE] logging console zzz
[ACCEPTE] logging console 9          ← la sévérité maximale est 7
[ACCEPTE] logging trap 99
[ACCEPTE] logging facility nawak
[ACCEPTE] logging history 12
[ACCEPTE] logging buffered 99999999999
```

Sur un vrai IOS, chacune de ces lignes rend
`% Invalid input detected at '^' marker.` avec le curseur sous le mot
fautif. Ici l'opérateur croit avoir configuré quelque chose.

**C'est aussi la racine du défaut d'ergonomie** : un nœud greedy sans
sous-arbre n'a rien à proposer, donc l'aide ne peut rien descendre.

### 1.2 L'aide ne descend pas — **CONFIRMÉ**

```
Router(config)#logging console ?
  buffered  Set buffered logging parameters
  console   Set console logging parameters
  host      A single host address
  monitor   Set terminal line (monitor) logging parameters
  on        Enable logging to all supported destinations
  trap      Set syslog server logging level
  <cr>
```

`logging console ?` répond la liste des mots-clés de `logging` — c'est-à-dire
qu'après avoir choisi `console`, l'aide propose de rechoisir `console`.
Un vrai IOS répond **les huit sévérités, leur numéro, et `<cr>`** :

```
  <0-7>          Logging severity level
  alerts         Immediate action needed          (severity=1)
  critical       Critical conditions              (severity=2)
  debugging      Debugging messages               (severity=7)
  emergencies    System is unusable               (severity=0)
  errors         Error conditions                 (severity=3)
  guaranteed     Guarantee console messages
  informational  Informational messages           (severity=6)
  notifications  Normal but significant conditions (severity=5)
  warnings       Warning conditions               (severity=4)
  <cr>
```

Ces annotations `(severity=N)` sont la raison pour laquelle un opérateur
n'a pas besoin de retenir la table : **IOS la lui donne dans l'aide**.
C'est le point d'ergonomie le plus rentable de tout ce lot.

De plus, seuls **6 mots-clés sur ~25** sont proposés au premier niveau.

### 1.3 `logging buffered <n>` confond taille et niveau — **CONFIRMÉ**

```
Router(config)#logging buffered 6
Router#show logging
    Buffer logging: level debugging, 6 bytes      ← un tampon de 6 octets
```

Sur IOS, l'argument numérique de `logging buffered` est **ambigu par
conception et résolu par sa valeur** : `0-7` est une SÉVÉRITÉ,
`4096-2147483647` une TAILLE. `logging buffered 6` règle donc le niveau
sur `informational`, jamais une taille de six octets — qui ne pourrait
contenir aucun message.

### 1.4 `service sequence-numbers` est de la configuration morte — **CONFIRMÉ**

La commande est acceptée, et `show logging` continue d'annoncer
`Sequence numbers: disabled` ; aucun message ne porte de numéro. Sur
IOS, chaque ligne est alors préfixée d'un compteur à six chiffres :

```
000047: *Aug  6 19:18:43.157: %LINK-3-UPDOWN: Interface GigabitEthernet0/0, changed state to up
```

### 1.5 Une quinzaine de commandes sont acceptées et ne font rien

`origin-id`, `count`, `history`, `persistent`, `queue-limit`,
`exception`, `userinfo`, `discriminator`, `message-counter`,
`snmp-trap`, `reload`, `server-arp`, et les formes
`rate-limit console|all … except …`. Aucune n'apparaît dans la
running-config, aucune ne change une vue. Deux traitements sont
possibles et le PRD tranche par cas en §2.5 : **implémenter** quand la
donnée existe, **refuser** quand elle n'existe pas. Ce qui n'est pas
acceptable, c'est le silence.

### 1.6 `show logging` n'est pas au format d'IOS 15 — **CONFIRMÉ**

Mesuré :

```
Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns)
    Console logging: level debugging
    ...
```

IOS 15 rend, pour chaque destination, **le nombre de messages
effectivement journalisés** — c'est ce chiffre qu'on lit en premier pour
savoir si une destination reçoit quoi que ce soit :

```
Syslog logging: enabled (0 messages dropped, 0 messages rate-limited,
        0 flushes, 0 overruns, xml disabled, filtering disabled)

No Active Message Discriminator.

    Console logging: level debugging, 12 messages logged, xml disabled,
                     filtering disabled
    Monitor logging: level debugging, 0 messages logged, xml disabled,
                     filtering disabled
    Buffer logging:  level debugging, 12 messages logged, xml disabled,
                     filtering disabled
    Exception Logging: size (4096 bytes)
    Count and timestamp logging messages: disabled
    Persistent logging: disabled

    Trap logging: level informational, 15 message lines logged
        Logging to 10.0.0.1  (udp port 514, audit disabled, link up),
              15 message lines logged, 0 message lines rate-limited,
              0 message lines dropped-by-MD, xml disabled, sequence number disabled
```

Manquent donc : les compteurs par destination, `messages rate-limited`,
`xml`/`filtering`, les sections discriminateurs, `Exception Logging`,
`Count and timestamp`, `Persistent logging`, et le détail par hôte
(transport, port, état du lien).

### 1.7 `show logging history` rend `show logging` — **CONFIRMÉ**

Deux commandes distinctes rendent le même texte. `show logging history`
est une **table à part**, celle qu'alimente `logging history` et que le
SNMP relève :

```
Syslog History Table:1 maximum table entries,
  saving level warnings or higher
  0 messages ignored, 0 dropped, 0 recursive dropped
  0 table entries flushed
  SNMP notifications not enabled
```

### 1.8 `logging host <ip> transport tcp port <n>` perd son transport — **CONFIRMÉ**

La commande est acceptée ; la running-config rend `logging host 10.0.0.1`
tout court. Or le transport et le port sont **la** raison de taper cette
forme : un collecteur en TCP/1470 n'est pas un collecteur en UDP/514, et
une configuration relue à l'import perd le réglage.

### 1.9 Ce qui est déjà juste, et qu'il ne faut pas casser

La mesure a aussi montré ce qui fonctionne, et qui doit être préservé :

* la sévérité par **numéro** (`logging console 4` → `warnings`) ;
* la forme héritée `logging 10.0.0.2`, rendue `logging host 10.0.0.2`
  dans la configuration, exactement comme IOS la normalise ;
* `clear logging` vide réellement le tampon ;
* les défauts d'usine (console `debugging`, trap `informational`,
  facility `local7`, `service timestamps … datetime msec`) ;
* `service timestamps` dans toutes ses formes (lot précédent) ;
* le format `%FACILITY-SEVERITY-MNEMONIC:` et l'horodatage.

---

## 2. Ce qui est livré

### 2.1 Un arbre de commandes, pas un mot-clé glouton

`logging` cesse d'être un unique nœud greedy. Chaque sous-commande est
enregistrée pour elle-même, avec la description d'IOS, et **chaque
position qui attend une sévérité déclare les huit niveaux nommés,
annotés de leur numéro**, plus `<0-7>`.

Conséquence directe sur l'ergonomie, et c'est l'objectif :

* `logging ?` propose les ~25 sous-commandes réelles, décrites ;
* `logging console ?` propose les sévérités, pas la liste du dessus ;
* la complétion par tabulation fonctionne sur chacune ;
* un mot inconnu est refusé **avec le curseur sous le mot fautif**.

### 2.2 Refuser ce qu'IOS refuse

Un mot-clé inconnu, une sévérité hors `0-7`, une facilité qui n'existe
pas, une taille de tampon hors bornes : refusés, avec le message et le
curseur d'IOS. Une valeur refusée ne modifie rien — l'ancienne
configuration reste en place, comme sur un vrai équipement.

### 2.3 `logging buffered` résout son argument par sa valeur

`0-7` règle la sévérité, `4096-2147483647` la taille, dans les deux
ordres (`logging buffered 8192 warnings`). Un nombre entre 8 et 4095 est
refusé : il n'est ni l'un ni l'autre.

### 2.4 `service sequence-numbers` numérote pour de vrai

Chaque message journalisé porte son numéro de séquence sur six chiffres,
et `show logging` annonce `Sequence numbers: enabled`. Le compteur est
celui du tampon, il ne repart pas à zéro sur un `clear logging` — comme
sur IOS, où il compte les messages produits depuis le démarrage.

### 2.5 Les commandes absentes sont AJOUTÉES, pas refusées

C'est l'objet même de ce lot. Une première rédaction proposait de
refuser la moitié d'entre elles faute de brique ; c'était une reculade,
et les briques existent presque toutes. Ce qui est livré :

| Commande | Ce qu'elle FAIT ici |
|---|---|
| `logging discriminator <nom> [severity\|facility\|mnemonics\|msg-body {drops\|includes} …] [rate-limit <n>]` | un vrai filtre : les clauses posées sont toutes exigées ensemble, et un message recalé n'atteint pas la destination |
| `logging {console\|monitor\|buffered} discriminator <nom>` | attache le filtre ; attacher un filtre inexistant est refusé |
| `logging host <ip> discriminator <nom>` | filtre par collecteur, et ce qu'il perd est compté (`dropped-by-MD`) |
| `logging persistent [url <url>] [size <n>] [filesize <n>] [immediate\|batch <n>] [threshold <n>]` | **écrit un vrai fichier** sur le `flash:` de l'équipement — celui que `dir flash:` énumère ; `size` borne le journal, `filesize` chaque fichier, et le plus ancien part quand le total déborde |
| `show logging persistent` / `clear logging persistent` | relit et efface ces fichiers-là, pas le tampon mémoire |
| `logging snmp-trap [level]` | rend vraie la dernière ligne de `show logging history` |
| `logging userinfo` | écrit un `%SYS-5-PRIV_AUTH_PASS` au passage en mode privilégié |
| `logging server-arp` | envoie une vraie requête ARP vers le collecteur **au moment où on le configure**, au lieu d'attendre le premier message |
| `logging origin-id {hostname\|ip\|ipv6\|string <texte>}` | l'équipement connaît son nom et ses adresses |
| `logging history [level]` / `logging history size <n>` | alimente la table que `show logging history` rend |
| `logging count` | le tampon porte déjà facilité, mnémonique et horodatage |
| `logging exception <size>` | rendu dans `show logging` |
| `logging delimiter tcp` | sépare réellement les messages sur la connexion TCP — voir §2.9 |
| `logging queue-limit [trap] <n>` | borne réellement la file de sortie du relais syslog — voir §2.9 |
| `logging message-counter {log\|debug\|syslog}` | choisit les classes que `show logging count` compte — voir §2.10 |
| `logging reload [level] [message-limit <n>]` | borne ce qui est journalisé pendant un redémarrage — voir §2.10 |

Restent refusées, et uniquement celles-là, parce qu'il leur manque une
brique entière que rien ici ne peut remplacer : `logging esm config` et
`logging filter <url>` (moteur de filtrage ESM, écrit en TCL),
`logging cns-events` (agent CNS), et `logging policy-firewall`
(pare-feu par zones — concept absent de tout le dépôt). Le refus prend
les mots d'IOS pour une commande que la plateforme n'a pas.

**Plus de réserve sur ce tableau** : la première rédaction en laissait
quatre « acceptées, validées et visibles, mais sans effet observable ».
Les §2.9 et §2.10 les ont toutes fermées, et c'est bien ce qu'on
demandait à ce lot — une commande dont on ne peut rien dire d'autre que
« elle est stockée » reste une commande qui ne fait rien.

### 2.5 bis Un abrégé non ambigu vaut le mot entier

Mesuré au passage, et corrigé : `logging buffered 1000000 debug` — que
tout le monde tape — était refusé, parce que la sévérité était comparée
au mot entier. C'est la règle de TOUTE la CLI d'IOS qui manquait ici.
`debug`, `warn`, `notif`, `crit` valent désormais leur mot ; `e` reste
refusé, puisqu'il désigne aussi bien `emergencies` que `errors`. Les
facilités s'abrègent de même, et l'exact l'emporte sur le plus long
(`auth` reste `auth`, il ne devient pas `authpriv`).

### 2.6 `show logging` et `show logging history` disent la vérité

`show logging` prend le format d'IOS 15 avec les **compteurs réels par
destination** — console, monitor, tampon, trap — incrémentés au point
d'émission, plus le détail par hôte (transport, port, `dropped-by-MD`).
Les sections de discriminateurs distinguent les filtres **actifs** (une
destination les utilise) des **inactifs** (définis, attachés à rien) —
c'est la première chose à vérifier quand un filtre « ne marche pas ».
Les champs que ce simulateur ne modélise pas (`xml`, `filtering`) sont
rendus à leur valeur constante `disabled`, qui est la valeur d'un
équipement ordinaire, et c'est dit ici plutôt que laissé à découvrir.

La taille du tampon quitte la ligne `Buffer logging:`, où elle n'est pas
sur un vrai IOS 15, pour `Log Buffer (N bytes):`, son seul emplacement —
et cette ligne est rendue même quand le tampon est vide, sans quoi on ne
pourrait jamais vérifier ce que `logging buffered` a réglé.

`show logging history` devient sa propre table.

### 2.7 `logging host` conserve son transport et son port

`transport {udp|tcp}` et `port <n>` sont stockés, rendus dans la
running-config et affichés dans le détail par hôte de `show logging`.

---

### 2.8 Le limiteur borne ce qu'IOS borne

`logging rate-limit` était stocké et lu par personne. Il police
désormais pour de vrai, et **sa portée par défaut est la console
seule** : c'est le débit vers un écran qu'IOS protège, pas la trace. Le
mot-clé `all` étend la borne au tampon et au relais syslog, ce qui n'est
pas la même décision — l'une préserve la lisibilité, l'autre sacrifie la
trace. `except <severity>` exempte la sévérité nommée et au-dessus. Ce
qui a été supprimé est annoncé (`%LOGGING-4-RATELIMIT: N messages
rate-limited`) plutôt que perdu en silence, et compté dans l'en-tête de
`show logging`.

### 2.9 `transport tcp` ouvre une vraie connexion (RFC 6587)

Cette section n'était pas au programme : elle lève une limite que la
première version de ce PRD s'était contentée d'écrire au §3. Le
transport était stocké, rendu dans la configuration, relu à l'import —
et le datagramme partait en UDP quand même. Ce qui manquait n'était pas
le format mais la **connexion**.

`SyslogAgent` ouvre désormais une vraie connexion TCP par collecteur, la
garde ouverte (RFC 6587 « non-transparent framing », qui est ce que fait
IOS), et met en attente les messages produits avant qu'elle soit
établie — sinon le premier message de chaque session, celui qui dit
précisément ce qui vient d'arriver, serait le seul à manquer. Changer le
transport d'un collecteur ferme la connexion en cours, qui allait vers
l'autre protocole. `SyslogHost.tcpConnect` est un port optionnel : un
équipement sans pile TCP ne retombe pas en UDP en silence, il signale
`no-tcp`, qui est une cause distincte de `no-route` — le chemin peut
être parfait, c'est la machine qui ne sait pas ouvrir la connexion.

**`logging delimiter tcp` tient son sens de là**, et de nulle part
ailleurs : sur une connexion unique les messages se suivent, et sans
délimiteur le collecteur ne sait pas où l'un finit et l'autre commence.
Le mot-clé ne pouvait donc rien vouloir dire tant que rien ne partait en
TCP.

**Le piège de ce transport, écrit ici parce qu'il a été payé** : en TCP,
**émettre un message produit de l'activité réseau, et cette activité
produit des messages**. Un collecteur injoignable donnait donc :
ouvrir la connexion échoue → l'échec produit un `Segment dropped …` →
ce message tente d'ouvrir la connexion → … Le bus étant asynchrone, ce
n'était pas une récursion qu'un verrou de réentrance pouvait arrêter :
c'était un aller-retour sans fin, qui bloquait la machine entière (une
suite de tests entière ne rendait plus la main). Ce que fait un vrai
IOS est la réponse : il ne retente pas à chaque message, il retente sur
minuterie. Ici un lien en panne est marqué comme tel et n'est retenté
que lorsque l'opérateur touche à la configuration du collecteur — le
moment où il attend justement qu'on réessaie. Deux épreuves gardent
cette porte fermée, et elles échouent authentiquement avant correctif
en… ne se terminant jamais. **Limite assumée qui en découle** : il n'y
a pas de reconnexion sur minuterie, faute d'ordonnanceur dans cet
agent ; un collecteur revenu à la vie se rejoint en retapant sa ligne.

La file d'attente d'une connexion en cours d'ouverture est bornée par
**`logging queue-limit`**, qui trouve là son sens : c'est exactement la
file que cette commande règle sur un vrai équipement. Elle sort donc,
elle aussi, de la liste des commandes sans effet observable.

**Défaut trouvé en écrivant l'épreuve, et corrigé ici** : le même agent
construisait le tag de DEUX façons selon le bus interne qui avait porté
le message. Le chemin `log` fabriquait un `%SYS-6-RESTART` complet ;
le chemin `device.syslog.entry` — celui que `LoggingConfig` emprunte,
c'est-à-dire la quasi-totalité des messages d'un routeur — passait le
tag NU (`SYS`). Deux messages de la même machine arrivaient donc au
collecteur sous deux formes, et aucune des deux ne ressemblait à ce que
`show logging` affichait sur cette même machine. Le mnémonique voyage
maintenant avec l'événement (`DeviceSyslogEntryPayload.mnemonic`) plutôt
que d'être deviné à l'arrivée, ce qui préserve la distinction que
`CHANGED` (arrêt administratif) et `UPDOWN` (perte de porteuse) portent
pour une même facilité.

### 2.10 Les trois dernières limites, fermées

Ce lot ne livre rien de neuf : il ferme ce que les §2.9 et §3 avaient
écrit au lieu de corriger. Une limite écrite est honnête ; elle reste
une limite.

**Un collecteur TCP tombé se rejoint tout seul.** `SyslogAgent` reçoit
l'ordonnanceur de l'équipement et arme une reconnexion à 60 s — celle
d'IOS, longue exprès. Une seule tentative armée à la fois, annulée dès
qu'elle aboutit ; le drapeau `enPanne` du §2.9 reste ce qui empêche de
retenter à chaque message. Rien n'est réémis à la reconnexion : ces
messages-là sont dans le tampon, et les rejouer les daterait de
maintenant.

**`logging reload` borne ce qui est journalisé pendant un redémarrage,
et le tampon ne survit plus à celui-ci.** Mesuré avant : le tampon
GRANDISSAIT à travers un `reload` — trois lignes avant, cinq après, les
trois premières datées d'avant le démarrage. Or il est en mémoire vive.
Une machine ne peut pas se souvenir de ce qui a précédé sa mise sous
tension, et diagnostiquer sur cet historique-là est pire que de n'en
avoir aucun. Le tampon part donc avec le redémarrage, `%SYS-5-RESTART:
System restarted --` est la première ligne d'après — comme sur un vrai
équipement, et il manquait — et `logging reload <sévérité>
[message-limit <n>]` filtre et compte ce qui s'écrit entre les deux.
**La fenêtre se referme à la commande suivante, pas à la fin de
`powerOn()`** : les remontées d'interface arrivent par le bus, donc
après, et la fermer trop tôt laissait la commande ne rien borner du
tout. Le `%SYS-5-RESTART` traverse la fenêtre sans la consommer : c'est
la bannière du démarrage, et un `message-limit 1` qui l'effacerait ne
laisserait aucune trace du redémarrage lui-même.

**`show logging count` obéit aux deux commandes qui le règlent.** Il
comptait tout, quelle que soit la configuration : ni `logging count`,
qui active la capacité, ni `logging message-counter`, qui choisit les
classes comptées, n'étaient lus. Une table qui ignore les deux commandes
censées la régler n'est pas une mesure. IOS distingue trois classes — les
messages ordinaires (`log`), ceux que `debug` produit (`debug`), et ceux
qui partent vers un serveur syslog (`syslog`) ; un message est compté dès
qu'UNE de ses classes est active, et par défaut seule `log` l'est, ce qui
tient les lignes de debug hors de la table.

---

## 3. Limites assumées, écrites plutôt que découvertes

* **`xml disabled, filtering disabled`** sont des constantes : ce
  simulateur n'a ni sortie XML ni modules de filtrage ESM. Les afficher
  est fidèle à un équipement qui n'en a pas ; prétendre les configurer
  ne le serait pas.
* **Le libellé exact d'IOS pour `show logging count` sans comptage
  activé** n'a pas pu être vérifié contre un vrai équipement depuis cet
  environnement ; la forme retenue suit sa convention (préfixe `%`, une
  phrase). Ce qui est sûr, et c'est le point, est qu'une table pleine
  alors que la capacité est éteinte serait un mensonge.
* **Le compteur `overruns`** reste à zéro : il compte les débordements
  de la file d'attente du processus de logging, qui n'existe pas ici.
* **`logging host <ip> ?` propose `transport` un jeton trop tôt.** La
  trie ne distingue pas un mot-clé ALTERNATIF à un argument (`ip address
  ?` doit proposer `dhcp`) d'un mot-clé qui le SUIT. Corriger le modèle
  changerait l'aide de toutes les commandes du dépôt ; l'excès d'offre
  est uniforme avec le reste de la CLI, et vaut mieux que ne jamais
  laisser découvrir `transport`.
* **`<0-7>` est listé après les noms** et non avant comme sur IOS : le
  tri de l'aide est une convention du dépôt entière, pas de cette
  famille.

## 4. Le mnémonique cesse d'être fabriqué

### 4.1 Ce qui a été mesuré

`formatEntry` rendait la ligne ainsi :

```ts
const mnem = (mnemonic ?? severity).toUpperCase();
return `${prefix}%${tag.toUpperCase()}-${sevNum}-${mnem}: ${text}`;
```

Le `?? severity` est le défaut : **92 des 105 appels à `append()` ne
passaient aucun mnémonique**, si bien que la SÉVÉRITÉ était réécrite à
la place du mnémonique et que l'équipement imprimait

```
%RIP-5-NOTIFICATIONS: ...
%TCP-4-WARNINGS: Segment dropped (no-listener) from 10.0.0.9:1234 ...
%CDP-6-INFORMATIONAL: CDP enabled
```

Aucune de ces trois lignes n'existe sur un IOS. La deuxième composante
d'un message de syslog est déjà le NUMÉRO de la sévérité — écrire son
NOM en troisième position répète la même information et supprime la
seule qui compte : lequel des messages de cette famille vient d'être
émis. C'est aussi celle que l'opérateur cherche, puisque c'est elle
qu'il tape dans un moteur de recherche, elle que `logging discriminator
… mnemonics includes …` filtre, et elle que la table de `show logging
count` regroupe. Un journal dont toutes les lignes d'un même niveau
portent le même « mnémonique » rend ces trois usages inutilisables.

### 4.2 Ce qui n'est pas journalisé du tout

Fabriquer un mnémonique n'était pas le seul défaut : la moitié de ces
appels journalisaient des événements sur lesquels **un vrai équipement
n'écrit rien**. Cinquante abonnements ont été retirés, pas réécrits :
`tcp.segment.dropped` (un port fermé répond un RST, en silence),
`tcp.connection.closed`, `cdp.neighbor.discovered`/`expired`,
`lldp.neighbor.*`, `cdp.config.changed`/`lldp.config.changed`,
`igmp.*`, `rip.route.*`, `stp.role.changed`, `vtp.*`,
`dhcp.pool.lease-*`, `gre.*`, `vxlan.*`, `tacacs.*`,
`radius.auth.completed`, `host.icmp.echo-failed`. Ce sont des
événements internes du simulateur, utiles au bus, mais dont la
présence dans le tampon donnait au journal un volume et un contenu
qu'aucun équipement ne produit — et cachait les lignes qui, elles,
comptent.

### 4.3 Ce qui est livré

Le mnémonique devient **obligatoire** dans la signature :

```ts
append(severity, tag, text, republish: boolean, mnemonic: string): void
```

C'est le cœur du correctif, et il est structurel plutôt que
déclaratif : il n'existe plus de chemin par lequel un appelant puisse
omettre le mnémonique et laisser le rendu en inventer un. Les familles
qu'IOS journalise reçoivent le leur — `UPDOWN`/`CHANGED` (lien),
`ADJCHG` (OSPF), `ADJCHANGE` (BGP), `NBRCHANGE` (EIGRP),
`STATECHANGE` (HSRP, VRRP, GLBP), `BUNDLE`/`UNBUNDLE` (EtherChannel),
`PSECURE_VIOLATION`, `ERR_DISABLE`/`ERR_RECOVER`,
`ROOTCHANGE`/`TOPOTRAP`/`BLOCK_BPDUGUARD`/`ROOTGUARD_BLOCK`
(spanning-tree), `LOGIN_SUCCESS`/`LOGIN_FAILED`/`USER_LOCKED`,
`SSH2_SESSION`/`SSH2_CLOSE`, `NBRCHG`/`DRCHG` (PIM),
`UDLD_PORT_DISABLED`, `DUPLEX_MISMATCH`, `NATIVE_VLAN_MISMATCH`,
`PEERSYNC`/`PEERUNSYNC` (NTP), `IKMP_SA_AUTH`/`IKE_DPD_TIMEOUT`
(crypto), `AUTHFAIL` (SNMP), `DECLINE_CONFLICT` (DHCP),
`SUCCESS`/`FAIL` (802.1X), `IPACCESSLOGP` (déni d'ACL).

Deux conséquences valent d'être nommées parce qu'elles ne sont pas
cosmétiques.

**La sortie de `debug` n'est pas du syslog**, et le dire est
maintenant un choix explicite : `DEBUG_VERBATIM` (la chaîne vide) est
la valeur qu'on passe pour obtenir une ligne sans
`%FACILITÉ-N-MNÉMONIQUE`. Avant, ce comportement était obtenu par
l'ABSENCE d'argument, c'est-à-dire par le même oubli qui produisait
les faux mnémoniques ailleurs — les deux cas étaient indiscernables
dans le code.

**Le pont générique `log`** portait un nom d'événement interne
(`stp:root-guard`, `ipsec:anti-replay`) et non un mnémonique.
`mnemonicFromEvent()` est la table qui traduit, et son second rôle est
de rendre `null` : un compteur de somme de contrôle invalide, une
erreur d'émission interne, un sous-ensemble VTP orphelin ne produisent
plus de ligne, pour la même raison que les cinquante abonnements
retirés au §4.2. Un événement absent de la table n'écrit rien non plus
— un inconnu ne s'invente pas.

### 4.4 Trois tests qui encodaient le défaut

`logging-enhancements.test.ts` exigeait `%PORT_SECURITY-2-CRITICAL`,
`%PM-2-CRITICAL`, `%SSH-5-NOTIFICATIONS` et `%SEC-4-WARNINGS` : quatre
sévérités prises pour des mnémoniques, figées par des assertions. Elles
ont été corrigées vers les mnémoniques réels. Le cinquième cas exigeait
`%TCP-4-WARNINGS: Segment dropped (no-listener)` — un message
entièrement inventé sur un événement qu'IOS ne journalise pas ; il
affirme désormais l'inverse, que rien n'est écrit, ce qui est le
comportement du vrai équipement.

### 4.5 Limites assumées

Une poignée de mnémoniques sont **plausibles plutôt qu'attestés**,
faute d'un équipement de référence joignable depuis cet environnement :
`BFD_SESS_STATE`, `LEASE_EXPIRED`, `POOL_EXHAUSTED`,
`PORTFAST_BPDU_RX`, `ROUTELIMITWARNING`, `CONN_STATE`. Ils sont écrits
ici pour être corrigés plutôt que découverts. La différence avec l'état
précédent n'est pas de degré : un mnémonique approximatif reste un
mnémonique, propre à une famille de messages et utilisable par un
filtre ou un regroupement ; `NOTIFICATIONS` ne l'était pas.

---

## 5. Le collecteur reçoit ce que la machine a journalisé

### 5.1 Ce que la mesure a trouvé

Le §4 s'arrêtait au message : sa sévérité, son mnémonique, sa forme. Il
ne posait jamais la question suivante, qui est celle qu'un opérateur
pose vraiment : **le collecteur reçoit-il ce que `show logging`
affiche ?** La réponse était non, dans les deux sens.

La mesure a été faite sur un routeur câblé à un vrai serveur Linux
écoutant sur UDP/514, en faisant battre une interface. Cinq lignes au
tampon, **douze datagrammes** au collecteur :

```
show logging   %LINK-5-CHANGED | %LINEPROTO-5-UPDOWN | %LINK-3-UPDOWN | %LINEPROTO-5-UPDOWN | %SYS-5-CONFIG_I
collecteur     %PORT-6-ADMIN | %LINK-5-CHANGED | %LINK-5-CHANGED | %LINEPROTO-5-UPDOWN | %LINEPROTO-5-UPDOWN
               | %PORT-6-ADMIN | %LINK-3-UPDOWN | %LINK-3-UPDOWN | %LINEPROTO-5-UPDOWN | %LINEPROTO-5-UPDOWN
               | %SYS-5-CONFIG_I | %SYS-5-CONFIG_I
```

**Le laboratoire a d'abord été mal bâti, et c'est écrit ici plutôt que
tu** : sa première version coupait l'interface qui portait justement le
syslog, si bien que les messages ne pouvaient pas partir. Elle donnait
« 0 datagramme avec `logging trap errors` », d'où j'avais conclu à un
défaut du seuil de relais. C'était faux : le seuil était juste, le
laboratoire ne mesurait rien. Le collecteur est désormais sur une
interface que le test ne fait pas battre.

### 5.2 Chaque ligne partait en double

`ForwardingEventBus` reverse **le même objet** d'événement vers le bus
observateur. `SyslogAgent` s'abonnait à `device.syslog.entry` sur son
bus local ET sur le bus par défaut : il traitait donc chaque entrée deux
fois, et une ligne du journal devenait deux datagrammes chez le
collecteur — un compteur d'événements y comptait double. Le même agent
avait déjà rencontré le piège sur le sujet `log` et l'avait contourné
par un ensemble de clés `niveau|événement|message|Date.now()` ; ce
contournement n'avait jamais été étendu au second sujet, et il était
lui-même faux : deux messages RÉELLEMENT identiques dans la même
milliseconde — ce qu'un routeur écrit dès que deux interfaces changent
d'état ensemble — étaient réduits à un.

`LoggingConfig.attachToBus` portait le même double abonnement sur `log`,
sans aucun garde-fou : ces messages-là entraient deux fois **au tampon**.

`DuplicateEventFilter` (`src/events/`) répond par l'identité, qui est la
seule réponse exacte : deux messages distincts sont deux objets, un
message reversé est un seul. Le `WeakSet` ne retient rien, donc l'oubli
suit le bus.

### 5.3 Le collecteur recevait des messages qu'aucun IOS n'écrit

`%PORT-6-ADMIN` n'existe pas. Il était **fabriqué** par `tagFor()` à
partir du nom de l'événement interne (`port:admin`), toujours en
sévérité 6 quelle que soit la sévérité réelle, et envoyé au collecteur
par un chemin qui ne passait pas par le sous-système de journalisation.
Conséquences au-delà de l'affichage : ce chemin contournait
`mnemonicFromEvent()` — la table du §4.3, dont le second rôle est
justement de rendre `null` pour un événement sans équivalent IOS — donc
aussi le tampon, les discriminateurs, `logging count` et la
numérotation de séquence. La machine niait avoir journalisé ce qu'elle
venait d'envoyer.

`onLog()` et `tagFor()` sont supprimés. `LoggingConfig` écoute déjà
`log`, traduit par la table, et republie ce qui a un équivalent : il
reste **une seule route** vers le collecteur, et c'est celle que
`show logging` enregistre. Les trois appels du pont générique passent
donc de `republish: false` à `true` — le commentaire qui justifiait le
`false` décrivait exactement le double chemin qu'on vient de fermer.

### 5.4 Ce qui était déjà juste, et qu'il ne fallait pas « corriger »

`logging trap errors` filtrait correctement : après correction, la
rafale de cinq messages n'en livre qu'un, `%LINK-3-UPDOWN`, la seule de
sévérité 3. Le tampon les garde tous les cinq — `logging trap` gouverne
le relais et lui seul. La diffusion vers deux collecteurs distincts
était juste elle aussi. Un « correctif » du seuil aurait cassé les
deux.

### 5.5 Vérification

`journalisation-collecteur-syslog.test.ts` (6 cas). Discriminé en
restaurant les trois fichiers de production : **5 cas tombent**, dont
celui de la diffusion vers deux collecteurs, que j'avais annoncé comme
neutre et qui ne l'est pas. Le sixième — « rien ne part si aucun
collecteur n'est déclaré » — passe des deux côtés et garde le correctif
au lieu de mesurer le défaut.
