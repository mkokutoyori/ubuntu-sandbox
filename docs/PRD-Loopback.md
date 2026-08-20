# PRD — Les interfaces de bouclage, sur les quatre plateformes

Rejouer le tutoriel « Les Interfaces Loopback : From Zero to Hero »
comme laboratoire, sur routeur Cisco, routeur Huawei, hôte Linux et
poste Windows. Mesure d'abord — une sonde qui rejoue chaque commande du
sujet et vide sa sortie dans un fichier — puis classement, puis
correction de ce qui manque réellement.

## 1. Ce que la mesure a trouvé

| plateforme | défaut mesuré | nature |
|---|---|---|
| Cisco | `show interfaces Loopback0` écrit trois lignes au lieu d'une vingtaine | affichage |
| Cisco | `show ip interface <nom>` rend le texte de `show interfaces` | **deux commandes confondues** |
| Cisco | `show ip ospf interface Loopback0` annonce `BROADCAST` et `State DR` | **comportement** |
| Cisco | `passive-interface` accepté, honoré, rendu **nulle part** | **perte à la relecture** |
| Huawei | `(s): spoofing` en légende, jamais sur une ligne | affichage |
| Huawei | `source LoopBack 0` perd son numéro | **perte à la relecture** |
| Huawei | `undo interface LoopBack 0` accepté, ne supprime rien | **comportement** |
| Linux | `ip addr add … dev lo` → `Cannot find device "lo"` | **la boucle n'existe pas** |
| Linux | `state UP`/pas de `qlen`/`brd` en trop/`valid_lft` absent | affichage |
| Linux | `dummy` en `<NO-CARRIER…> state DOWN` | affichage |
| Linux | une adresse secondaire n'est joignable par personne | **comportement** |
| Linux | `modprobe` n'existe pas | commande absente |
| Windows | `route print` : table `Active Routes:` vide | **comportement** |
| Windows | trois déclarations des routes de bouclage, trois métriques | **trois vérités** |

## 2. Ce qui a été corrigé, et pourquoi c'est réel

### 2.1 Cisco — le type de réseau LOOPBACK existe

`OSPFNetworkType` n'avait pas de valeur `loopback`. Une interface de
bouclage était donc déclarée `broadcast`, entrait en attente, puis
élisait un DR — c'est-à-dire se déclarait DR d'elle-même, seule au
monde.

Ses conséquences ne sont pas d'affichage, et c'est le §8 du sujet :
RFC 2328 §12.4.1.1 fait annoncer une interface de bouclage comme un
**hôte isolé** (lien de type 3, LinkID = son adresse, LinkData =
255.255.255.255, métrique 0), donc en /32 **quel que soit son masque**.
`ip ospf network point-to-point` est ce qui fait annoncer le préfixe
configuré. Les deux moitiés sont vérifiées sur la **table de routage du
voisin**, pas sur un affichage local : c'est la seule vérification qui
distingue une correction d'un texte retouché.

`setInterfaceNetworkType` relance la machine à états. L'écriture
directe sur l'objet — ce que faisait l'appelant — laissait l'état et les
minuteurs d'avant : une loopback basculée en `point-to-point` gardait
`State Loopback` et n'émettait toujours pas de Hello.

### 2.2 Cisco — MTU, bande passante et délai sont sur le PORT

`MTU 1514 bytes, BW 8000000 Kbit/sec, DLY 5000 usec` sont les valeurs
qu'IOS donne à une loopback. Elles sont posées à la création du port et
non dans le rendu, ce qui laisse `bandwidth`/`delay`/`mtu` les
surcharger par la voie normale — et fait qu'EIGRP lit la même bande
passante que la vue affiche. Une constante d'affichage aurait ignoré la
commande.

Le MTU vaut 1514 et non 1500 : IOS compte ici l'en-tête de trame, qu'une
boucle n'a pas à retrancher. Bloc relevé sur du texte capturé (jeu
`cisco_ios/show_interfaces` de `ntc-templates`).

### 2.3 Cisco — `show ip interface` répond à une autre question

Les deux commandes existent parce qu'elles décrivent des choses
différentes : le **traitement IP** (adresse, broadcast, MTU IP, helper,
proxy ARP, commutation) contre le **lien** (matériel, encapsulation,
compteurs de trames). Les confondre privait la plateforme de la moitié
de la réponse.

Corrigé au passage : cette vue écrivait `MTU is 1500 bytes` et
`Proxy ARP is enabled` en dur, donc contredisait un `ip mtu` ou un
`no ip proxy-arp` que la même machine affichait par ailleurs.

### 2.4 Cisco — `passive-interface` est enfin rendu

Trouvé en rejouant le sujet : la commande était acceptée, honorée par le
moteur, et rapportée par **personne** — ni la configuration (EIGRP et
RIP la rendent tous deux, dix lignes plus haut dans le même
sérialiseur), ni `show ip protocols`. Une configuration relue REFAIT le
processus à l'import d'une topologie : l'interface passive s'y perdait
et se remettait à émettre.

### 2.5 Huawei — `(spoofing)` dit quelque chose

`up(s)` dans le tableau bref, `UP (spoofing)` dans le détail : VRP dit
ainsi que l'état du protocole de liaison est **décrété** et non observé.
Ce n'est pas un ornement — c'est la propriété qui rend une loopback
utilisable comme Router ID. `display ip interface brief` imprimait sa
légende `(s): spoofing` sans qu'aucune ligne ne porte jamais la marque
qu'elle explique.

La règle est déclarée **une fois** (`protocoleSpoofe`, dans le module de
mise en page partagé avec le commutateur) et lue par les trois vues :
une machine ne peut pas marquer une interface dans un tableau et pas
dans l'autre.

Portée assumée : `LoopBack` et `NULL`, les deux pour lesquelles la
documentation de VRP montre la marque. `Tunnel` n'y est pas, faute de
référence — les sorties de Huawei pour `display interface Tunnel`
montrent un `UP` sec, et l'ajouter au jugé remplacerait une information
absente par une information fausse.

### 2.6 Huawei — deux commandes qui ne faisaient pas ce qu'elles disent

`source LoopBack 0` ne gardait que le premier mot : la configuration
rendue portait `source LoopBack`, une interface qui n'existe pas, et une
topologie relue rejouait cela.

`undo interface LoopBack 0` était **accepté** et ne supprimait rien — il
tombait dans la queue générique qui rend une chaîne vide, si bien que
l'interface restait dans `display ip interface brief` juste après qu'on
eut demandé sa suppression. Il supprime, refuse un port physique, et
prévient avant (`Warning: … will delete the interface. Continue?
[Y/N]:`, défaut **non**) par le mécanisme de plans qui portait déjà
`save`, `reboot` et `reset saved-configuration`.

### 2.7 Linux — `lo` était une fiction de rendu

`getInterfaceInfo('lo')` fabriquait un objet quand on le lui demandait,
sans qu'aucun port n'existe derrière. `ip link show lo` décrivait donc
la boucle pendant que `ip addr add 10.0.0.1/32 dev lo` — le laboratoire
entier de la partie Linux — répondait `Cannot find device "lo"` sur la
même machine au même instant. Une adresse ajoutée sur la boucle n'avait
nulle part où être rangée.

C'est un vrai port désormais, créé au démarrage comme le noyau le fait,
avec les propriétés que Linux lui donne : MTU 65536, MAC nulle,
127.0.0.1/8 et ::1/128, toujours UP, et impossible à supprimer.

Deux notions ont dû être nommées sur `Port`, chacune pour ce qu'elle
décide :

- **`loopback`** décide du plafond de MTU. 9216 est la taille d'une
  trame Ethernet jumbo : elle n'a aucun sens pour une interface qui
  n'émet pas de trame, et poser 65536 échouait sur un plafond emprunté à
  un autre médium.
- **`carrierless`** décide de l'état rapporté. Linux le rend visible :
  l'état opérationnel d'une interface dont la porteuse n'est pas une
  question est `UNKNOWN`, jamais `UP` ni `DOWN`, et ses fanions portent
  `NOARP` au lieu de `MULTICAST`. C'est vrai de `lo` comme d'une
  interface `dummy` — d'où deux propriétés et non une.

**`lo` est créée APRÈS les cartes physiques**, et c'est délibéré :
beaucoup de code désigne « la première carte » par le premier port
(câblage, laboratoires), et la boucle n'est la première carte de rien.
Mesuré plutôt que supposé — la créer en premier faisait câbler `lo` au
commutateur dans la suite SSH et faisait tomber 170 cas. L'ordre
d'affichage ne s'en trouve pas changé : `ip` place `lo` en tête
explicitement, comme le vrai, et son index reste 1 sans occuper un rang
dans la numérotation des autres.

### 2.8 Linux — le rendu, mesuré contre un vrai `iproute2`

`iproute2` installé dans l'environnement a servi de référence, pas la
mémoire :

```
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
```

Quatre écarts : `state UP` au lieu de `UNKNOWN`, pas de `qlen 1000`, un
`brd 127.255.255.255` que `ip` n'imprime pas, et `valid_lft` absent de
**toutes** les adresses IPv4 — un défaut général, pas propre à la
boucle, que seule la comparaison avec `eth0` réel a révélé.

Le **`scope` est une propriété de l'adresse**, pas de l'interface :
127.0.0.0/8 ne sort jamais de la machine, une 10.0.0.1 posée sur `lo`
si — c'est tout l'intérêt de l'y poser. En le déduisant de l'interface,
une adresse ajoutée sur la boucle était annoncée `scope host`, donc
décrite comme injoignable alors qu'elle est précisément là pour être
annoncée par un démon de routage.

`ip addr` et `ip link` calculaient état, file et longueur de file
chacun de leur côté : une machine annonçait `state UNKNOWN` à l'une et
`state UP` à l'autre pour la même interface. Une seule règle
(`formeLien`), trois lecteurs — `ip addr`, `ip link` et `ip -br`.

### 2.9 Linux — une adresse secondaire n'existait pour personne

Deux causes, toutes deux générales et non propres à la boucle :

1. `buildFullRoutingTable` ne posait de route que pour l'adresse
   **primaire** d'un port, alors que le noyau en pose une par adresse.
2. `getPortOwningIP` ne consultait que la primaire, si bien qu'une
   machine ne se reconnaissait pas dans ses propres adresses ajoutées :
   un ping vers l'une d'elles partait résoudre une MAC sur le lien au
   lieu de boucler dans le noyau. `Port` portait déjà le prédicat exact
   (`ownsIPv4`), consulté par le plan de données ; c'est ici qu'il
   manquait.

Conséquence : `ip addr add 10.0.0.1/32 dev lo` était accepté, l'adresse
s'affichait, et un ping vers elle répondait « Network is unreachable ».

### 2.10 Linux — `modprobe`

La commande n'existait pas sur une machine où `ip link add … type dummy`
fonctionne, c'est-à-dire où le module **est** disponible. Elle lit et
écrit la même `KernelModuleTable` que `lsmod` et `modinfo`.

`CHARGEABLES` décrit ce que cette image porte vraiment : `dummy` y
figure parce qu'un vrai comportement existe derrière, et il y figure
seul pour cette raison. Un `modprobe` d'autre chose échoue en nommant le
répertoire, exactement comme sur une machine dont `/lib/modules` ne
contient pas le fichier — ce qui est littéralement le cas ici.

`ip link add … type dummy` charge le module tout seul, comme le noyau le
fait à la demande, en passant par la même table : les deux vues
s'accordent.

### 2.11 Windows — une table, trois déclarations

`route print` sortait une table `Active Routes:` **vide** sur un poste
fraîchement démarré, pendant que `Get-NetRoute` en déclarait une, écrite
en dur — et un troisième exemplaire, avec une **autre métrique**, vivait
dans le fournisseur PowerShell. Trois vues de la même table, trois
réponses.

`WindowsLoopbackRoutes.ts` les déclare une fois — les trois que Windows
montre toujours (127.0.0.0/8, 127.0.0.1/32, 127.255.255.255/32) — et les
trois vues les lisent.

## 3. Limites assumées

**`Get-NetAdapter -IncludeHidden` ne montre pas la pseudo-interface.**
Le cmdlet moderne lit `INetworkProvider.getAdapters()`, qui ne connaît
que les cartes réelles ; la branche `-IncludeHidden` existe dans
l'ancien formateur et n'est plus atteinte. La combler proprement demande
que `Loopback Pseudo-Interface 1` devienne un vrai port de `WindowsPC` —
comme `lo` vient de le devenir sous Linux — et non une quatrième copie
écrite en dur, qui est exactement le défaut que ce travail vient de
refermer pour les routes.

**`netsh interface ip add address "Loopback Pseudo-Interface 1"` et
`New-NetIPAddress` sur cette interface restent refusés**, pour la même
raison : ils résolvent l'interface contre la table des ports réels. La
partie 6 du sujet est donc couverte pour `ping`, `route print`,
`Get-NetIPAddress` et `Get-NetRoute`, pas pour l'ajout d'adresse. C'est
le seul laboratoire du tutoriel qui ne se rejoue pas.

**La durée de vie d'un bail DHCP n'est pas acheminée jusqu'à
`ip addr`** : `valid_lft` y rend `forever` pour toute adresse IPv4. Le
moteur connaît l'expiration d'un bail, cette vue non ; le fanion
`dynamic` dit déjà l'origine de l'adresse.

**Charger un module ne rend aucune fonction disponible.** La table dit
ce que l'image porte, elle ne l'étend pas.

## 4. Vérification

`tuto-loopback-cisco-huawei.test.ts` (22 cas) — discriminé par remise en
état des onze fichiers produit : **13 échouent** authentiquement.

`tuto-loopback-linux-windows.test.ts` (21 cas) — discriminé de même :
**16 échouent** authentiquement.

Les cas qui passent des deux côtés sont ceux qui portent sur ce qui
était déjà correct (`ping 127.0.0.1`, création d'une loopback Cisco,
`Get-NetAdapter` qui masque la pseudo-interface) — et c'est ce qu'on
attend d'eux.
