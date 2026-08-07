# PRD — `info-center` : le journal de VRP, et ce qu'il rendait de faux

## 0. Méthode et posture

Ce document est le jumeau de `PRD-Logging-Cisco.md`, écrit du même point
de vue : quelqu'un qui exploite du Huawei depuis longtemps et sait que
**la première chose qu'on configure sur un AR neuf est son journal, et
la dernière qu'on regarde quand plus rien ne marche**.

Comme le précédent, **chaque affirmation ci-dessous a été mesurée avant
d'être écrite** : les commandes ont été tapées dans la vraie CLI du
simulateur sur un `HuaweiRouter`, les sorties relevées telles quelles.

Ce n'est pas un habillage du lot Cisco. VRP ne journalise pas comme IOS,
et le §2.1 dit précisément où les deux divergent — la notion de **canal**
n'existe pas du tout chez Cisco, et c'est l'ossature de tout
`info-center`.

---

## 1. État mesuré

### 1.1 Tout est accepté — **CONFIRMÉ, et c'est la même racine qu'IOS**

`HuaweiCommonSecurity` enregistre `info-center` en `registerGreedy` et le
dirige vers `RouterManagementService.configureInfoCenter()`, un `if/else`
sur le premier mot dont la branche finale **enregistre la ligne brute et
ne dit rien**. Mesuré :

```
[accepte] info-center nimportequoi
[accepte] info-center loghost 999.1.1.1
[accepte] info-center logbuffer size 99999
[accepte] info-center channel 0 name maconsole      ← stocké nulle part
[accepte] info-center filter-id bymodule-alias OSPF hello
[accepte] info-center max-logfile-number 10
```

Sur un vrai VRP, chacune rend `Error: Wrong parameter found at '^'
position.` ou `Error: Unrecognized command found at '^' position.`

### 1.2 L'aide ne descend nulle part — **CONFIRMÉ, et c'est pire qu'IOS**

```
<AR1> system-view
[AR1] info-center ?
  enable  Toggle: info-center enable
  <cr>

[AR1] info-center loghost ?
  enable  Toggle: info-center enable
  <cr>
```

Un seul mot-clé existe, `enable`, et il ne vient même pas du sous-système
— il vient d'une **boucle générique de bascules** dans `HuaweiVRPShell`
qui traite `info-center enable` comme `telnet server enable`. D'où la
réponse absurde : après avoir tapé `loghost`, l'aide propose `enable`,
et sa description est `Toggle: info-center enable`, un libellé interne
qu'aucun équipement n'imprime.

### 1.3 La configuration rendue est **corrompue** — CONFIRMÉ, et c'est le plus grave

Une `display current-configuration` est **rejouée telle quelle à
l'import** : ce qu'elle rend de faux refabrique un autre routeur. Tapé,
puis relu :

| Tapé | Rendu |
|---|---|
| `info-center loghost source LoopBack0` | `info-center loghost source channel 2 facility local7` |
| `info-center loghost 10.0.0.1` puis `… 10.0.0.1 channel 2` | deux lignes identiques |
| `info-center loghost 999.1.1.1` | `info-center loghost 999.1.1.1 channel 2 facility local7` |
| `info-center timestamp log date precision-time tenth-second` | `info-center timestamp log` |
| `info-center source default channel 0 log level warning` | `… channel 0 level warning` |

La première ligne est la pire : **`source` a été pris pour un nom
d'hôte**. `info-center loghost source <interface>` désigne l'interface
source des paquets syslog ; le simulateur en a fait un collecteur
fantôme appelé « source ». Un routeur relu croit avoir un serveur de
plus.

La deuxième est la deuxième pire : les collecteurs sont **empilés sans
dédoublonnage** (`this.infoCenter.loghosts.push(...)`), alors que
reconfigurer une adresse déjà déclarée la MODIFIE sur un vrai VRP.

### 1.4 Les vues répondent à côté

* `display channel` rend la phrase en dur `Info: No info-center channels
  configured.` — sur une machine qui vient d'en configurer, et alors que
  VRP a **dix canaux d'usine** qu'un équipement neuf possède déjà.
* `display info-center` annonce `Configured loghosts: 4` là où trois
  commandes `loghost` ont été tapées (dont une qui n'en était pas une).
* `info-center logbuffer size 512` est accepté et `display logbuffer`
  continue d'annoncer `Allowed max buffer size : 4096` — la taille est
  lue ailleurs, et la commande ne l'atteint pas.
* `display logbuffer` annonce `Channel number : 4 , Channel name :
  logbuffer` en dur : juste par coïncidence, puisque c'est bien le canal
  d'usine du tampon — mais un `info-center logbuffer channel 6` ne le
  changerait pas.

### 1.5 Ce qui est déjà juste, et qu'il ne faut pas casser

* `display logbuffer` lit le VRAI tampon partagé (`LoggingConfig.renderHuawei`),
  celui que les messages de la machine alimentent — l'ossature est là,
  c'est sa configuration qui ne l'atteint pas ;
* `display trapbuffer` existe et a la bonne forme ;
* `info-center enable` bascule bien un état, même par le mauvais chemin ;
* la structure `infoCenter` (`sources`, `loghosts`, `timestamp`) existe
  et est déjà rendue dans la configuration — il lui manque la validité,
  pas l'existence.

---

## 2. Ce qui est livré

### 2.1 Le canal, qui n'a pas d'équivalent chez Cisco

C'est l'ossature de `info-center` et la raison pour laquelle ce lot n'est
pas un habillage du précédent. VRP route chaque message vers un **canal**
numéroté de 0 à 9, chacun portant un nom d'usine :

| N° | Nom d'usine | Destination |
|---|---|---|
| 0 | `console` | la console |
| 1 | `monitor` | les sessions de terminal |
| 2 | `loghost` | les serveurs syslog |
| 3 | `trapbuffer` | le tampon d'alarmes |
| 4 | `logbuffer` | le tampon de journal |
| 5 | `snmpagent` | l'agent SNMP |
| 6-9 | `channel6`…`channel9` | libres |

Un équipement neuf les possède **tous les dix** : `display channel` en
rend la table, au lieu de prétendre qu'il n'y en a aucun.
`info-center channel <0-9> name <nom>` renomme, `info-center console
channel <n|nom>` réaffecte une destination à un autre canal, et
`info-center source <module> channel <n> {log|trap|debug} level <sev>`
règle ce que ce canal laisse passer.

### 2.2 Refuser ce que VRP refuse

Adresse invalide, canal hors `0-9`, taille de tampon hors bornes,
sévérité inconnue, module inconnu, mot-clé inconnu : refusés **dans les
mots de VRP** (`Error: Wrong parameter found at '^' position.` pour une
valeur, `Error: Unrecognized command found at '^' position.` pour un
mot-clé), et une valeur refusée ne modifie rien.

### 2.3 Un collecteur est identifié par son adresse, pas empilé

Redéclarer une adresse la **modifie** au lieu d'en ajouter une deuxième,
comme sur un vrai VRP. `undo info-center loghost <ip>` la retire.
`info-center loghost source <interface>` est reconnu pour ce qu'il est —
l'interface source — et ne fabrique plus de collecteur fantôme.

### 2.4 La configuration reproduit ce qui a été tapé

Le transport, le port, la facilité, le canal, le format d'horodatage et
sa précision, le mot `log`/`trap`/`debug` d'une source : tout ce qui a
été tapé revient, parce que cette configuration est rejouée à l'import et
qu'une ligne fausse y refabrique un autre routeur.

### 2.5 Les tampons ont la taille qu'on leur donne

`info-center logbuffer size <n>` et `info-center trapbuffer size <n>`
atteignent le tampon partagé, et `display logbuffer` / `display
trapbuffer` annoncent la taille réelle, le canal réellement affecté et
le nombre réel de messages.

### 2.6 Une aide qui descend

`info-center ?` propose les sous-commandes réelles, décrites ;
`info-center loghost ?` propose `A.B.C.D` et `source` ; les sévérités
sont proposées **avec leur numéro**, comme le lot Cisco l'a fait — c'est
le même service rendu à l'opérateur, et VRP les annote de la même façon.

---

## 3. Limites assumées, écrites plutôt que découvertes

* **`info-center filter-id`**, **`max-logfile-number`** et la famille des
  fichiers de journal (`info-center logfile`) supposent un système de
  fichiers de journaux et un moteur de filtrage par alias de module,
  dont ni l'un ni l'autre n'existe côté VRP ici. Refusés en nommant la
  brique manquante plutôt qu'acceptés en silence.
* **Le nom de module** n'est validé que contre les modules que ce
  simulateur produit réellement (`OSPF`, `BGP`, `IFNET`, …) plus
  `default` : accepter n'importe quel mot ferait croire à un filtre qui
  ne filtrera jamais rien.
* **Sur le COMMUTATEUR, la configuration `info-center` n'est pas rendue
  dans `display current-configuration`.** `HuaweiSwitch` n'a pas de
  service de gestion : la coquille lui donne son propre état, donc les
  commandes sont validées et `display channel` dit vrai, mais rien ne
  porte cet état à travers une sauvegarde. Le rendre demanderait de
  donner au commutateur le service de gestion qu'il n'a pas, ce qui
  dépasse ce lot. Avant, la famille entière y était acceptée et sans
  aucun effet ; elle est maintenant validée, ce qui est un progrès mais
  pas la fidélité complète, et c'est dit ici plutôt que laissé à
  découvrir.
* **`display logbuffer` reste chronologique** et ne prend pas les
  filtres `level`/`module` de VRP : le tampon partagé garde le rendu de
  chaque ligne, pas ses champs, donc filtrer dessus reviendrait à
  analyser du texte déjà mis en forme.
