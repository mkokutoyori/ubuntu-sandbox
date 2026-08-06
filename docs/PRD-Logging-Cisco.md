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

### 2.5 Les commandes mortes : implémentées ou refusées, jamais muettes

| Commande | Décision | Raison |
|---|---|---|
| `logging origin-id {hostname\|ip\|string}` | **implémentée** | l'équipement connaît son nom et ses adresses |
| `logging history [level]` / `history size` | **implémentée** | la table existe, `show logging history` la rend |
| `logging count` | **implémentée** | le tampon porte déjà facilité/mnémonique/horodatage |
| `logging exception <size>` | **stockée et rendue** | valeur de configuration, visible dans `show logging` |
| `logging persistent` | **refusée** | suppose un système de fichiers de journaux au boot, absent |
| `logging discriminator` | **refusée** | un filtre qui n'filtre rien serait pire que son absence |
| `logging queue-limit`, `message-counter`, `userinfo`, `server-arp`, `reload` | **refusées** | aucune donnée derrière ; le refus nomme la brique manquante |

### 2.6 `show logging` et `show logging history` disent la vérité

`show logging` prend le format d'IOS 15 avec les **compteurs réels par
destination** — console, monitor, tampon, trap — incrémentés au point
d'émission, plus le détail par hôte (transport, port). Les champs que ce
simulateur ne modélise pas (`xml`, `filtering`) sont rendus à leur valeur
constante `disabled`, qui est la valeur d'un équipement ordinaire, et
c'est dit ici plutôt que laissé à découvrir.

`show logging history` devient sa propre table.

### 2.7 `logging host` conserve son transport et son port

`transport {udp|tcp}` et `port <n>` sont stockés, rendus dans la
running-config et affichés dans le détail par hôte de `show logging`.

---

## 3. Limites assumées, écrites plutôt que découvertes

* **`xml disabled, filtering disabled`** sont des constantes : ce
  simulateur n'a ni sortie XML ni modules de filtrage ESM. Les afficher
  est fidèle à un équipement qui n'en a pas ; prétendre les configurer
  ne le serait pas.
* **`logging persistent`** et **`logging discriminator`** sont refusées
  plutôt que simulées, pour la raison qui a guidé tous les lots
  précédents : une commande acceptée qui ne fait rien est un mensonge
  plus coûteux qu'un refus.
* **Le compteur `overruns`** reste à zéro : il compte les débordements
  de la file d'attente du processus de logging, qui n'existe pas ici.
