# PRD — Fidélité de la CLI IOS : aide contextuelle, état unique, sérialisation

## 0. Contexte

Une seconde relecture externe a comparé une session complète du simulateur
à un IOS 15.7(3)M. Elle relève trois défauts **structurels** et une longue
traîne de divergences de rendu. Ce document part de la même méthode que
les précédents : **chaque affirmation est vérifiée contre le code avant
d'être traitée**, parce qu'un rapport appliqué sans mesure produit des
correctifs qui ne corrigent rien — la relecture précédente contenait déjà
deux affirmations fausses, et celle-ci en contient au moins une.

Le rapport conclut lui-même que les trois défauts majeurs ont « une racine
unique ». C'est vrai pour deux d'entre eux, et c'est faux pour le
troisième — la distinction commande la façon de les corriger, et elle est
établie en §1.

---

## 1. Vérification des trois défauts majeurs

### 1.1 L'aide contextuelle s'effondre dès qu'un argument est consommé — **CONFIRMÉ**

Mesuré :

```
Router(config-if)#ip address 192.168.10.1 ?
% Unrecognized command
Router(config-if)#ip address 192.168.10.1 255.255.255.0
Router(config-if)#
```

La cause exacte est dans `CommandTrie.getCompletions()` (lignes 524-592) :
la marche parcourt les tokens en cherchant, à chaque pas, un **enfant
mot-clé**. Le token `192.168.10.1` n'en est pas un, `prefixMatch` ne rend
rien, et la fonction fait `return []` — que `CiscoShellBase.getHelp()`
traduit en `% Unrecognized command`.

L'exécution, elle, passe par `registerGreedy` : le nœud `ip address`
absorbe tout ce qui suit comme arguments. **Aide et exécution ne
divergent donc pas par accident, mais par construction** : le nœud sait
qu'il consomme des arguments, la marche d'aide l'ignore.

Le rapport a raison sur le diagnostic (« deux chemins de code distincts »)
et sur le pronostic : corriger cas par cas ne finirait jamais. Le
correctif est un changement de **la marche**, pas des enregistrements —
un token qui ne correspond à aucun enfant, sur un nœud qui accepte des
arguments, doit être **consommé comme argument** et la marche continuer.
Ce seul changement supprime la classe entière, y compris pour les
commandes que personne n'a testées.

Reste, **par-dessus**, la question de ce que l'aide doit alors *dire*.
`ip address 192.168.10.1 ?` doit répondre `A.B.C.D  IP subnet mask`, pas
une liste vide. Cela suppose que le nœud **déclare** ses arguments.
`ParamSpec` existe déjà (`name`/`type`/`description`/`validator`) mais
`registerGreedy` ne l'accepte pas et presque aucun enregistrement ne
l'utilise. Deux couches, donc, et elles n'ont pas le même coût :

| Couche | Nature | Portée |
|---|---|---|
| **A — la marche consomme les arguments** | un correctif, dans un fichier | supprime `% Unrecognized command` partout |
| **B — déclarer les arguments** | une déclaration par commande | améliore le texte, commande par commande |

La couche A est due sans discussion. La couche B est un travail
**transverse à tout le simulateur** (plusieurs milliers
d'enregistrements) ; ce PRD la livre pour les commandes que le rapport
cite nommément et fournit le mécanisme pour les suivantes, sans prétendre
la clore.

### 1.2 `% Unrecognized command` n'existe pas sur IOS — **CONFIRMÉ**

`cli-utils.ts:15` définit `UNRECOGNIZED_HELP: '% Unrecognized command'`,
et c'est la seule sortie possible d'un `?` sans correspondance. IOS
n'émet jamais cette chaîne. Une fois la couche A posée, le cas « aucune
correspondance » devient rare ; il doit alors rendre
`% Invalid input detected at '^' marker.` comme le reste.

### 1.3 La table de routage n'est pas dérivée de l'état des interfaces — **CONFIRMÉ, avec une nuance**

Mesuré :

```
GigabitEthernet0/0    192.168.10.1    YES manual down    down
...
C    192.168.10.0/24 is directly connected, GigabitEthernet0/0
```

La nuance importe pour le correctif. `Router.isRouteUsable()` **existe et
fonctionne** — `docs/PRD-IP-SLA.md` et le lot « route statique et
shutdown » l'ont posé, et il filtre bien les routes statiques dont
l'interface est tombée. Ce qui n'y passe pas, ce sont les routes
**connectées** : elles sont poussées dans la table par
`configureInterface()` et le rendu ne les repasse pas par le prédicat.

Ce n'est donc pas « il n'y a pas de modèle d'état central », comme le
conclut le rapport : le prédicat central existe, il n'est pas consulté sur
un chemin. Le correctif est de l'y faire passer — pas de refondre le
modèle d'appareil.

**Manquent aussi, et ce sont des faits de 15.x :**

- les routes **locales** `L … /32`, générées depuis 15.0(1)M pour chaque
  adresse d'interface ;
- le **regroupement par réseau classful** avec l'en-tête
  `is variably subnetted, N subnets, M masks` ;
- le **tri par préfixe** plutôt que par ordre de configuration ;
- la **légende complète** (6 lignes : `i`, `ia`, `L1/L2`, `o`, `U`, `P`,
  `+`, `* - candidate default`) ;
- `show ip route <adresse>` doit rendre un bloc
  `Routing entry for …` / `Routing Descriptor Blocks:`.

### 1.4 Trois commandes, trois vérités sur l'état d'une interface — **CONFIRMÉ**

`show ip interface brief`, `show interfaces description`, `show interfaces`
et `show controllers` ne s'accordent pas. Deux causes distinctes :

1. **`administratively down` n'est pas distingué de `down`.** Une
   interface qui n'a jamais reçu `no shutdown` est admin-down sur IOS ;
   ici elle est rendue `down`. `Port.isAdminDown()` existe — la
   distinction est disponible et non projetée.
2. **`Method` vaut `manual` pour une interface sans adresse.** IOS écrit
   `unset` tant qu'aucune adresse n'a été posée.

Et, sur `show controllers` : une **loopback** et une **sous-interface**
n'ont pas de contrôleur matériel, elles ne doivent pas y figurer ; l'ordre
doit être canonique (par type puis index, la sous-interface juste après
son parent).

### 1.5 Le routeur commente ses propres sorties — **CONFIRMÉ**

Deux fuites, l'une déjà connue et assumée à tort :

```
show ip eigrp neighbors → (no neighbours — no real EIGRP peer cabled)
show ip nat statistics  → Application Layer Gateways: none (FTP/SIP ALG
                          and NAT64 not supported in this simulator)
```

`CLAUDE.md` documente que la seconde avait été « délibérément laissée »
lors d'une passe documentaire. C'était une erreur de jugement : un
équipement ne s'explique jamais, et la note appartient au PRD, pas à la
sortie. `neighbours` est en outre de l'anglais britannique — IOS écrit
américain.

### 1.6 Les messages syslog sont inventés — **CONFIRMÉ**

`%IFMGR-6-INFORMATIONAL: … IPv4 address 192.168.10.1/255.255.255.0
assigned` n'existe pas, et sa notation mélange le slash CIDR et le masque
pointé. Manquent les deux messages que tout opérateur reconnaît :

```
%LINK-3-UPDOWN: Interface GigabitEthernet0/0, changed state to up
%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to up
```

— et c'est précisément `no shutdown`, le seul événement journalisant de
la capture, qui ne produit rien.

### 1.7 Le sérialiseur de configuration — **CONFIRMÉ**

- `crypto key generate rsa modulus 2048` figure dans la configuration :
  c'est une commande EXEC, jamais persistée.
- `router eigrp 100` disparaît alors que `show ip protocols` le rapporte
  encore : perte de données.
- `service dhcp` est le défaut, donc jamais sérialisé.
- L'ordre n'est pas canonique.
- Les blocs interface omettent `shutdown` et `no ip address`, si bien que
  la configuration **ne permet pas de reconstruire l'état** — ce qui est
  grave au-delà de l'affichage, puisque c'est ce texte que l'import de
  topologie rejoue.
- Deux secrets distincts portent le **même sel** : impossible.
- En-tête : `show startup-config` doit rendre
  `Using N out of 262136 bytes`, pas l'en-tête de `show running-config`.

### 1.8 Ce que je récuse ou nuance

- **« Il n'y a pas de modèle d'état central »** — inexact. `Port` porte
  `adminDown`/`isUp`/`isConnected`/`isOperationallyUp()` et
  `Router.isRouteUsable()` est le prédicat unique déjà consulté par le
  plan de données et par les vues des deux constructeurs. Le défaut n'est
  pas l'absence du modèle, c'est que **certaines vues ne le consultent
  pas**. La correction est de les y brancher, pas de tout refondre : une
  refonte jetterait un prédicat correct et éprouvé.
- **« Un arbre de commandes déclaratif comme source unique »** —
  `CommandTrie` **est** cet arbre, avec `ParamType`/`ParamSpec` et un
  générateur d'aide. Ce qui manque n'est pas le moteur mais son usage
  (couche B, §1.1). Le dire autrement ferait croire à une réécriture
  quand il s'agit de déclarations à ajouter.
- **`router ospf 0` → « % Invalid OSPF process ID »** : le rapport
  demande lui-même confirmation. IOS 15.x rend bien un message dédié pour
  un identifiant de processus hors plage ; ce point est laissé tel quel
  faute de référence contradictoire.
- **La bannière de démarrage** : déjà signalée par la relecture
  précédente (`docs/PRD-IP-SLA.md` §8ter) comme relevant du profil de
  châssis. Elle reste hors de ce PRD et mérite le sien.

---

## 2. Spécification

### 2.1 Aide contextuelle (couche A)

`CommandTrie.getCompletions()` gagne la règle suivante, appliquée quand
aucun enfant ne correspond au token courant :

1. si le nœud déclare des `params`, le token est consommé comme la
   valeur du paramètre courant et le curseur avance ;
2. sinon, si le nœud est `greedy`, le token est consommé sans curseur ;
3. sinon seulement, la marche échoue.

À la fin, `nodeCompletions` rend, dans l'ordre : le **paramètre attendu à
la position courante** (s'il en reste), puis les mots-clés enfants, puis
les continuations. Un `?` derrière un argument consommé rend donc soit le
paramètre suivant, soit les mots-clés qui peuvent le suivre — jamais une
liste vide.

Quand la marche échoue malgré tout, la réponse devient
`% Invalid input detected at '^' marker.`

### 2.2 Déclaration d'arguments (couche B)

`CommandTrie.describeArgs(path, specs)` attache des `ParamSpec` à un nœud
**déjà enregistré**, sans toucher aux signatures existantes — donc sans
réécrire les milliers d'appels `registerGreedy` du dépôt.

`ParamType` gagne les rendus qu'IOS affiche : un paramètre nommé se rend
`A.B.C.D`, `<1-4094>`, `WORD`, `LINE` selon son type et ses bornes, et
non `<nom>`.

Commandes déclarées par ce lot (celles que le rapport cite) :
`ip address`, `encapsulation dot1Q`, `access-list`, `permit`/`deny`,
`eq`, `ip ssh time-out`, `transport input`, `ntp server`,
`snmp-server community`, `ip dhcp excluded-address`, `network`, `lease`,
`ip route`, `router ospf`, `router-id`, `speed`, `bandwidth`, `mtu`,
`reload`.

### 2.3 Cohérence de l'état d'interface

- `administratively down` est rendu par toute vue qui affiche un statut,
  dès lors que `Port.isAdminDown()`.
- `Method` vaut `unset` tant qu'aucune adresse n'a été configurée.
- `show controllers` exclut loopbacks et sous-interfaces, et trie
  canoniquement.
- Une seule fonction fournit le couple (statut, protocole) à toutes les
  vues, pour que la contradiction soit impossible par construction.

### 2.4 Table de routage

- Les routes connectées passent par `isRouteUsable()` comme les autres.
- Une route **locale** `L <ip>/32` est rendue pour chaque adresse
  d'interface utilisable.
- Regroupement classful avec en-tête `is subnetted` /
  `is variably subnetted, N subnets, M masks`.
- Tri par préfixe.
- Légende complète.
- `show ip route <adresse>` rend `Routing entry for …` +
  `Routing Descriptor Blocks:`.

### 2.5 Sorties sans commentaire

Aucune sortie d'équipement ne mentionne le simulateur. Une règle de test
interdit la réapparition du motif (`simulator`, `not supported`,
`no real`, `neighbours`) dans les rendus `show`/`display`.

### 2.6 Syslog

`%LINK-3-UPDOWN` et `%LINEPROTO-5-UPDOWN` sont émis sur transition d'état
de port. Les messages inventés (`%IFMGR-6-…` sur affectation d'adresse,
`%SYS-6-INFORMATIONAL: User account created`, `%SYS-5-NOTIFICATIONS: TCP
listener bound`) sont retirés.

### 2.7 Sérialiseur

Ordre canonique explicite : `version` → `service` → `hostname` →
`enable secret` → `username` → `ip dhcp` → `interface` → `router` →
`ip route` → `ip nat` → ACL → `snmp-server` → `line` → `ntp` → `end`.
Les valeurs par défaut ne sont pas sérialisées ; les états qui ne se
déduisent pas (`shutdown`, `no ip address`) le sont ; les commandes EXEC
n'y figurent pas ; chaque secret porte son propre sel.

**Conséquence mesurée sur NAT.** Cet ordre — celui d'IOS — écrit
`ip nat inside source list <n> …` **avant** `access-list <n>`. Le
simulateur refusait jusqu'ici une règle NAT dont l'ACL n'existait pas
encore (`% access-list N not defined.`), si bien qu'une configuration
correctement ordonnée ne se rejouait plus : la règle NAT était perdue au
retour de topologie. Les deux comportements sont contradictoires, et
c'est le refus qui a tort — IOS résout la liste au moment de traduire,
jamais au moment de configurer, ce qui est précisément l'origine du grand
classique « NAT configuré, aucune traduction », et ce sans quoi aucun
routeur ne pourrait relire sa propre startup-config. Le refus est retiré ;
la règle est acceptée, rendue par la configuration, et ne traduit rien.
Trouvé au passage et retiré aussi : le refus voisin
`% MAC ACLs cannot be used for NAT.` était inatteignable — sur un routeur
Cisco, `AccessList.type` ne vaut que `'standard'` ou `'extended'`, ce
simulateur n'ayant aucune notion d'ACL MAC de ce côté. Le cas de test qui
prétendait le couvrir ne créait aucune ACL MAC et ne passait que par le
refus des ACL inexistantes.

### 2.8 Un seul système de fichiers, une seule vérité

La traîne 🟡 s'est révélée moins vide que prévu : `show inventory`,
`show line`, `show snmp`, `show ntp associations`, `show ip dhcp pool`,
`show ip protocols`, `show access-lists` et `show ip ospf interface brief`
existaient déjà — la mesure a donc porté sur ce qu'ils **répondent**, et
non sur leur présence.

`show file systems` était le seul faux du lot : il annonçait `-` en
taille comme en place libre, alors que le même équipement, au même
instant, répondait des octets à `show flash:` et `dir nvram:`. La place
libre existe — `CiscoFileSystem` la calcule depuis les fichiers
réellement stockés — et c'est cette vue-là qui refusait de la lire. Un
tiret n'est pas une simplification : c'est une troisième vérité sur un
seul système de fichiers. La commande lit maintenant le système de
fichiers de l'équipement, marque `flash:` du `*` d'IOS, et voit sa place
libre baisser quand un `archive config` écrit vraiment.

Deux divergences voisines corrigées dans la même passe, pour la même
raison :

* **La NVRAM avait deux tailles.** `dir nvram:` annonçait `524288 bytes
  total` en dur pour tout le monde, quand le profil du châssis dit 256K
  au routeur, 64K au switch 2960 et 128K au 3560 — et quand
  `show version`, sur la même machine, annonçait ces derniers. La taille
  vient désormais du châssis, et `dir nvram:`, `show file systems` et
  l'en-tête `Using N out of M bytes` de `show startup-config` lisent le
  même nombre. Les 8 octets d'écart entre `256K` et le `262136` qu'IOS
  affiche sont la réserve de tête d'IOS : les deux annonces sont vraies,
  et l'écart est nommé plutôt que subi.
* **`showFlash()` était un second rendu de `flash:`**, calculé depuis le
  profil du châssis et donc insensible à toute écriture ou suppression.
  Il n'avait plus d'appelant depuis que `show flash:` lit le vrai système
  de fichiers ; il est supprimé, car une seconde réponse possible à la
  même question est exactement ce que ce lot corrige.

`probe-cli-systemes-de-fichiers.test.ts` (9 cas) est discriminé au
`git stash` : les 9 échouent authentiquement avant le correctif.

### 2.9 L'aide n'invente pas de commandes (couche B, suite)

La couche B s'étend aux commandes qu'une salle de TP tape le plus
(`ip helper-address`, `ip ospf cost|priority|hello-interval|dead-interval`,
`standby`, `vrrp`, `description`, `ip domain-name`, `ip name-server`,
`logging host`, `banner motd`, `exec-timeout`, `password`). Écrire les
déclarations ne suffisait pas : **il fallait regarder ce que l'aide rend**,
et deux défauts ne se voyaient que là.

* **Un nœud purement indicatif était proposé comme commande.**
  `describeArgs` crée les nœuds intermédiaires manquants pour y accrocher
  les arguments d'un parent greedy ; `prefixMatch` les ignorait déjà,
  mais le rendu de l'aide, lui, parcourait `node.children` sans les
  filtrer. Déclarer `switchport access vlan` sur un routeur y faisait donc
  apparaître un `switchport` — une commande que l'équipement n'a pas, et
  sans description puisque le nœud n'en porte aucune. Les nœuds
  `_hintOnly` sont désormais exclus du rendu de l'aide comme ils l'étaient
  déjà de l'exécution. Les déclarations propres au switch ont par ailleurs
  été retirées du jeu du routeur, où elles n'ont rien à faire : le shell
  du switch est distinct et ne reçoit pas encore la couche B — c'est un
  reste connu, dit plutôt que sous-entendu.

* **Des mots-clés sans description étaient proposés.** `autoContinuations`
  extrait des mots-clés du CORPS du gestionnaire greedy ; ceux qu'il ne
  sait pas décrire ressortaient nus. `password ?` en mode `line` en
  listait dix (`authentication`, `banner`, `exec`, `level`, `logging`,
  `login`, `privilege`, `size`, `synchronous`, `password`), aucun n'étant
  un argument de `password`. IOS n'affiche jamais un mot-clé sans texte
  d'aide, et celui qu'on ne sait pas décrire est justement celui dont on
  est le moins sûr qu'il existe : le rendu de l'aide les écarte. La
  complétion par tabulation, elle, continue de les accepter — un mot-clé
  qu'on ne sait pas décrire reste complétable.

  Le premier jet de ce filtre était trop large et a été corrigé plutôt que
  gardé : il retirait aussi `permit`/`deny` derrière `access-list 10 ?`,
  qui sont réels. Une SECONDE version, plus large encore, l'a été aussi :
  filtrer sur « le mot-clé a-t-il une description » cassait
  `handler-keyword-extraction.test.ts`, dont le contrat explicite est
  qu'un `registerGreedy` expose ses mots-clés de dispatch à `?` SANS
  aucune annotation — la campagne complète l'a rapporté, et c'était un
  vrai défaut de ma règle, pas un test à corriger. Le critère juste n'est
  pas « sait-on le décrire » mais « la commande attend-elle encore un
  argument DÉCLARÉ » : tant qu'un paramètre déclaré n'est pas servi, un
  mot-clé glané dans le corps du gestionnaire n'est pas un candidat, la
  déclaration faisant autorité sur l'heuristique. Les trois cas se
  départagent alors sans exception : `password ?` (un paramètre déclaré,
  non servi) n'offre plus rien d'autre, `access-list 10 ?` (paramètre
  servi) garde `permit`/`deny`, `show widget ?` (aucun paramètre déclaré)
  garde ses mots-clés glanés.

Enfin, `description` et `password` annonçaient `WORD` là où IOS annonce
`LINE` : `ParamType` n'a pas de `'LINE'`, le type qui rend `LINE` est
`'STRING'`, et la faute de frappe retombait sur le `default` du rendu.

Sur les trois cas ajoutés à `probe-cli-contextual-help.test.ts`, un seul
échoue avant le correctif — les deux autres gardent des régressions
introduites et corrigées à l'intérieur de ce même lot, ce qui est dit
plutôt que présenté comme une discrimination.

### 2.10 `show ip route <adresse>` rend le bloc de détail d'IOS

La commande existait et ne produisait pas `Routing Descriptor Blocks:`,
qui est pourtant le cœur de sa réponse : c'est cette section qui dit par
où le paquet part réellement, et elle seule qui montre plusieurs chemins
quand il y en a plusieurs. À la place, elle rendait une ligne de table de
routage (`S 10.0.0.0/8 via …`, `Connected via Gi0/0`) qu'IOS n'affiche
jamais ici.

Trois autres écarts, mesurés en écrivant la sonde :

* **La distance était écrite en dur par type.** Une statique flottante
  configurée en distance 200 se rapportait en distance 1 — elle cessait
  d'être une route de secours aux yeux de l'opérateur qui l'inspecte,
  alors que la table, elle, la classait correctement. Elle est lue sur
  la route (`RouteEntry.ad`), comme le fait déjà le rendu de la table.
* **RIP, EIGRP et BGP étaient rapportées ABSENTES.** Seuls quatre types
  étaient traités et le reste tombait dans le `return` final : une route
  RIP bien présente dans la table répondait `% Network not in table`.
* **`type <code>` rendait la lettre du code** (`O E2`) là où IOS écrit le
  type en toutes lettres (`extern 2`).

L'ECMP est rendu : un bloc descripteur par chemin à égalité, l'astérisque
sur celui du tour courant, comme IOS.

`probe-cli-route-detail.test.ts` (6 cas) est discriminé au `git stash` :
5 échouent avant le correctif ; le sixième — la destination inconnue —
passait déjà et garde ce comportement.

---

## 3. Phases

| Phase | Contenu | Pourquoi dans cet ordre |
|---|---|---|
| **P1** | Aide contextuelle couche A + message d'erreur | Supprime une classe entière de bugs d'un seul correctif |
| **P2** | Cohérence d'état d'interface (une source, toutes les vues) | Débloque P3, qui en dépend |
| **P3** | Table de routage : `isRouteUsable` sur les connectées, routes `L`, regroupement, tri, légende, `show ip route <ip>` | Le défaut le plus visible après l'aide |
| **P4** | Sorties sans commentaire + syslog réel | Peu coûteux, très visible |
| **P5** | Sérialiseur : ordre canonique, défauts omis, états manquants, sels | Dépend de P2 pour `shutdown`/`no ip address` |
| **P6** | Couche B : déclaration des arguments cités | Améliore le texte de l'aide, commande par commande |
| **P7** | Traîne 🟡 (`show file systems`, `show inventory`, `show line`, `show snmp`, `show ip dhcp pool`, …) | Indépendants les uns des autres |

**Hors périmètre, et dit plutôt que sous-entendu** : la bannière de
démarrage (profil de châssis, son propre lot), et la déclaration
exhaustive des arguments de toutes les commandes du simulateur — P6 en
livre l'outil et les cas cités, pas les milliers restants.

---

## 4. Plan de test

1. `ip address 192.168.10.1 ?` rend le masque attendu, et **aucune**
   commande du dépôt ne rend plus `% Unrecognized command`.
2. Une batterie de `<commande> <argument> ?` sur les cas cités.
3. Interface jamais activée : `administratively down` et `Method unset`
   dans **toutes** les vues, comparées entre elles dans le même test.
4. Interface down : la route connectée disparaît de `show ip route`, et
   réapparaît au `no shutdown`.
5. Routes `L /32` présentes, regroupement classful, tri par préfixe.
6. `no shutdown` produit `%LINK-3-UPDOWN` puis `%LINEPROTO-5-UPDOWN`.
7. Aucune sortie `show` ne contient les motifs interdits (test balayant
   un large échantillon de commandes).
8. `show startup-config` : ordre canonique, pas de `service dhcp`, pas de
   `crypto key generate`, `shutdown` présent, EIGRP conservé, sels
   distincts, en-tête `Using N out of 262136 bytes`.


---

## 5. État livré et décisions (2026-08-05)

### Livré

- **P1 — aide contextuelle.** La marche consomme les arguments ;
  `% Unrecognized command` disparaît de la CLI Cisco ;
  `describeArgs(path, specs)` attache des spécifications à un nœud déjà
  enregistré (et crée un nœud purement indicatif quand le mot-clé est
  absorbé par un handler greedy) ; `ParamType` se rend `A.B.C.D`,
  `<1-4094>`, `WORD`, `LINE`. Deux règles suivent : un paramètre déjà
  fourni n'est plus proposé, et tant qu'un argument reste attendu les
  mots-clés enfants ne sont pas des candidats — ils en étaient des
  alternatives. 25 cas de test.
- **P3 — table de routage.** Un seul rendu (`renderIpRouteTable`) là où
  deux fonctions coexistaient. Routes locales `L …/32`, regroupement
  classful, tri par préfixe, légende complète, métrique des statiques.
- **P2 partiel — `Method unset`**, et `show controllers` n'affiche plus
  ni loopback ni sous-interface, dans l'ordre du châssis.
- **P4 — sorties sans commentaire** et retrait des syslog inventés.

### La décision qui n'est pas la mienne : le défaut `shutdown`

Le rapport a raison sur le fond — une interface physique de routeur
démarre `shutdown` sur IOS, et c'est de là que viennent DEUX de ses
constats : les « trois vérités » sur Gi0/3 (rendu `down` au lieu
d'`administratively down`) et l'absence de `%LINK-3-UPDOWN` sur
`no shutdown`. Ce second point mérite d'être précisé : **le câblage
syslog existe déjà et il est correct** (`%LINK-3-UPDOWN`,
`%LINK-5-CHANGED` pour un `shutdown` d'opérateur, `%LINEPROTO-5-UPDOWN`).
S'il ne sort rien, c'est que `no shutdown` n'est pas une transition
quand le port est déjà up.

`Port.isUp` vaut `true` à la construction. L'inverser est une ligne, et
c'est pourquoi il faut résister à la faire : **225 fichiers de test sur
1229 activent une interface explicitement**. Les ~1000 autres
supposent des interfaces déjà actives, tout comme les fixtures de labo
et les topologies enregistrées. Basculer le défaut ne « corrige » pas un
défaut isolé, cela change la ligne de base du simulateur et demande une
migration de l'ensemble.

C'est un arbitrage de produit — fidélité contre coût de migration — et
il appartient à qui possède le projet, pas à ce lot. Le chiffre est
donné pour qu'il se décide sur une mesure.

### Reste à faire

P5 (sérialiseur : ordre canonique, défauts omis, `shutdown`/`no ip
address` rendus, sels distincts, en-tête `Using N out of 262136 bytes`,
`crypto key generate` retiré, EIGRP conservé), P6 au-delà des commandes
citées, et toute la traîne 🟡 (`show file systems`, `show inventory`,
`show line`, `show snmp`, `show ip dhcp pool`, `show ip protocols`,
`show access-lists`, `show ntp associations`, `show ip ospf interface
brief`). Chacun est indépendant ; aucun ne partage de racine avec les
précédents.
