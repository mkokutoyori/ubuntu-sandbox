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
