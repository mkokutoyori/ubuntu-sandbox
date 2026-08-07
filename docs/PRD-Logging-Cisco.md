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
| `logging queue-limit [esm\|trap] <n>`, `logging message-counter {log\|debug\|syslog}`, `logging delimiter tcp`, `logging reload [level] [message-limit <n>]` | acceptées, bornées, et **reproduites telles quelles** dans la running-config, donc rejouées à l'import |

Restent refusées, et uniquement celles-là, parce qu'il leur manque une
brique entière que rien ici ne peut remplacer : `logging esm config` et
`logging filter <url>` (moteur de filtrage ESM, écrit en TCL),
`logging cns-events` (agent CNS), et `logging policy-firewall`
(pare-feu par zones — concept absent de tout le dépôt). Le refus prend
les mots d'IOS pour une commande que la plateforme n'a pas.

**Réserve honnête sur les quatre dernières du tableau** : elles sont
analysées, bornées et rejouées, mais ne changent aucun comportement
observable — la file du processus de journalisation, le compteur par
classe, le délimiteur TCP et le niveau conservé au redémarrage n'ont
pas de contrepartie dans ce simulateur (respectivement : aucune file
asynchrone, aucun compteur par classe rendu, aucun transport TCP
syslog, aucun redémarrage qui préserve un tampon). Elles ne sont plus
muettes — elles étaient acceptées et invisibles, elles sont maintenant
acceptées, validées et visibles — mais c'est tout ce qu'on peut en dire.

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

---

## 3. Limites assumées, écrites plutôt que découvertes

* **`xml disabled, filtering disabled`** sont des constantes : ce
  simulateur n'a ni sortie XML ni modules de filtrage ESM. Les afficher
  est fidèle à un équipement qui n'en a pas ; prétendre les configurer
  ne le serait pas.
* **`transport tcp`** est stocké, rendu et relu ; le datagramme part
  malgré tout en UDP. Le syslog sur TCP est un protocole à part
  (RFC 6587, tramage par comptage d'octets sur une connexion), et
  `SyslogAgent` ne connaît que le datagramme. Le **port**, lui, est
  réellement utilisé : un collecteur sur 1470 reçoit sur 1470.
* **Les quatre commandes de configuration pure** (`queue-limit`,
  `message-counter`, `delimiter`, `reload`) sont validées et rejouées
  sans rien changer d'observable — voir la réserve du §2.5.
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
