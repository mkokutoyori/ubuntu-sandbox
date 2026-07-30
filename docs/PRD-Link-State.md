# PRD — Prise en compte du débranchement de câble (link state / carrier)

## 1. Contexte

### 1.1 Symptômes rapportés

Deux comportements incorrects observés dans l'UI :

1. **Ping Linux** — on débranche un câble pendant un `ping` en cours et on ne
   voit **rien** : ni ligne d'échec, ni message d'erreur. Le ping semble
   simplement se figer.
2. **SSH** — on est connecté en `ssh` sur une machine distante, on débranche
   le câble, et la session **continue de fonctionner** normalement.

### 1.2 Diagnostic (reproduit par tests)

Ce qui fonctionne déjà correctement et ne doit **pas** être touché :

| Comportement | État |
|---|---|
| `networkStore.removeConnection` / `removeDevice` / `clearAll` appellent `cable.disconnect()` | OK (`src/store/networkStore.ts:255,378,436`) |
| `Cable.disconnect()` notifie les deux ports (`Port.disconnectCable()`) et publie `cable.disconnected` | OK (`src/network/hardware/Cable.ts:201`) |
| `Port.sendFrame()` jette la trame si `this.cable === null` | OK (`src/network/hardware/Port.ts:686`) |
| `ping` **non-interactif** → `100% packet loss` | OK |
| ~~`ip route` retire la route connectée d'un port sans câble~~ | **Faux** — voir §6.3 |
| `tcpConnectOutcome()` → `timeout` sur lien coupé | OK |

Ce qui est cassé :

| # | Défaut | Cause racine |
|---|---|---|
| B1 | Le ping interactif (celui de l'UI) n'affiche **aucune** ligne d'échec | `formatReplyLine()` (`src/network/devices/linux/commands/net/Ping.ts:254`) ne sait rendre que `Time to live exceeded` et `Destination unreachable` ; `sendPing()` lève `Error('timeout')` (`EndHost.ts:2614`), qui retombe dans la branche `return ''` → ligne nulle, rien n'est écrit |
| B2 | `Port.getIsUp()` reste `true` sans câble | `Port.disconnectCable()` (`Port.ts:659`) remet `cable = null` et notifie link-down mais ne touche jamais l'état opérationnel ; il n'existe aucune notion de *carrier* |
| B3 | `ip link` n'affiche pas le flag `NO-CARRIER` | `LinuxIpCommand.ts:507-535` dérive `state` de `isUp && isConnected` (correct) mais n'ajoute jamais `NO-CARRIER` |
| B4 | `/sys/class/net/*/operstate` et `/carrier` sont figés | `Sysfs.ts:117-118` renvoie `'up\n'` / `'1\n'` en dur |
| B5 | SSH ignore totalement la couche physique | `CrossVendorRemoteShell.processLine()` (`src/shell/CrossVendorRemoteShell.ts:113`) appelle `this.top.processLine(line)` sur un shell lié à l'objet `Equipment` distant. La seule vérification réseau (`wireProbe`, `sshLauncher.ts:191`) a lieu **à la connexion** ; ensuite chaque frappe est un appel mémoire direct |

Vérifié par reproduction : `ssh alice@10.0.0.2 hostname` renvoie encore
`pcb` après `cable.disconnect()`.

### 1.3 Précédents architecturaux à réutiliser

- **Événements** : `Port.notifyLinkChange()` publie déjà `port.link.up` /
  `port.link.down` sur l'`EventBus` (`Port.ts:621`), en parallèle des
  callbacks `onLinkChange`. Les consommateurs existants sont
  `LinuxMachine.ts:1289` (IPv6), `Router.ts:505` (OSPF + IPSec `onPortDown`),
  `Router.ts:617`, `Switch.ts:661`. C'est le point d'accroche pour tout
  nouveau comportement réactif — ne pas inventer un second mécanisme.
- **État opérationnel dérivé** : `LinuxIpCommand.ts` calcule déjà
  `isUp && isConnected` à trois endroits (lignes 535, 574, 819). Cette
  logique dupliquée doit être remontée sur `Port` et consommée partout.
- **Sockets TCP** : `TcpStack` tient une `Map` de sockets
  (`src/network/tcp/TcpStack.ts:244`), expose `listSockets()` (ligne 324) et
  `TcpSocket.reset()` (ligne 166) qui envoie un RST sans passer par FIN —
  exactement ce qu'il faut pour couper des sessions établies.
- **Sonde réseau réelle** : `EndHost.tcpConnectOutcome()` traverse le vrai
  chemin ARP/route/trame et renvoie `open | refused | timeout`. C'est déjà
  ce que `sshLauncher.ts` utilise via `wireProbe` — la sonde de liveness
  réutilise strictement le même chemin, pas une heuristique parallèle.

## 2. Objectif

Le débranchement d'un câble doit produire, dans **tout** le projet, le même
effet que dans la réalité : perte de porteuse sur les deux ports, échec
visible de tout trafic qui empruntait ce lien, et fermeture des sessions
applicatives qui en dépendaient.

### 2.1 Phases

| Phase | Contenu | Dépend de |
|---|---|---|
| P1 | Carrier sur `Port` : `hasCarrier()`, `isOperationallyUp()`, centralisation | — |
| P2 | Affichage Linux : flag `NO-CARRIER`, `sysfs` `operstate`/`carrier` réels | P1 |
| P3 | Ping Linux : rendu réel de l'échec (interactif + non-interactif) | P1 |
| P4 | Ping Windows / Cisco / Huawei sur lien coupé | P1 |
| P5 | Sessions TCP établies coupées (RST) au link-down | P1 |
| P6 | SSH / SFTP / SCP : sonde de liveness par commande → `Broken pipe` | P1, P5 |
| P7 | Protocoles (OSPF, IPSec, STP) réagissent au link-down | P1 |

## 3. Modèle

### 3.1 États d'un port

Trois axes indépendants, comme sur un vrai équipement :

- `adminDown` — `shutdown` / `ip link set down`. Déjà présent.
- `isUp` — état de ligne interne (errdisable port-security, etc.). Déjà présent.
- **`carrier`** — présence physique d'un lien exploitable. **Nouveau.**
  `carrier = cable !== null && cable.getIsUp()`.

Dérivé :

```
isOperationallyUp() === isUp && !adminDown && hasCarrier()
```

Correspondances réelles :

| Simulateur | Linux | Cisco IOS |
|---|---|---|
| `adminDown` | `state DOWN` sans `UP` dans les flags | `administratively down` |
| `!hasCarrier()` | flag `NO-CARRIER`, `carrier=0` | `line protocol is down` |
| `isOperationallyUp()` | `state UP` + `LOWER_UP` | `up/up` |

### 3.2 Choix explicite : `getIsUp()` n'est pas modifié

`getIsUp()` conserve exactement sa sémantique actuelle (état de ligne, sans
tenir compte du câble). Le carrier est exposé séparément et les
consommateurs migrent vers `isOperationallyUp()` un par un, avec tests.
Rationnel : `getIsUp()` a des dizaines d'appelants ; en changer le sens
d'un coup casserait silencieusement des comportements sans rapport (ports
sans câble volontairement configurés dans les tests, interfaces
virtuelles/loopback créées `setUp(true)` — cf. `Router.ts:614`).

### 3.3 Sonde de liveness SSH (P6)

Une session distante (`CrossVendorRemoteShell`) reçoit une sonde optionnelle
`probeAlive(): boolean`, câblée par `sshLauncher` sur le même
`tcpConnectOutcome` que la connexion initiale. Avant chaque `processLine` /
`handleInput` :

- sonde `true` → comportement inchangé ;
- sonde `false` → la session émet
  `client_loop: send disconnect: Broken pipe`, se ferme, et le contrôle
  revient au shell local (même mécanique que `exit`).

La session est également fermée de façon proactive quand un `port.link.down`
casse le chemin, pour que `w` / `who` / utmp reflètent la déconnexion sans
attendre une frappe.

## 4. Critères d'acceptation (tests unitaires)

1. `Port.hasCarrier()` est `false` après `Cable.disconnect()`, `true` après
   `connect()`, `false` après `cable.setUp(false)`.
2. `isOperationallyUp()` est `false` si l'un des trois axes est faux ;
   les ports virtuels/loopback restent utilisables.
3. `ip link show eth0` affiche `NO-CARRIER` et `state DOWN` câble débranché,
   et ne les affiche pas câble branché (non-régression).
4. `cat /sys/class/net/eth0/carrier` → `0`, `operstate` → `down`.
5. `ping` non-interactif sur lien coupé : chaque paquet rend une ligne
   `From <src> icmp_seq=N Destination Host Unreachable` et le résumé donne
   `100% packet loss` (non-régression du résumé existant).
6. `ping` **interactif** avec débranchement en cours de flux : les paquets
   qui suivent produisent une ligne visible (c'est B1, le symptôme rapporté).
7. ~~Windows `ping` sur lien coupé rend `Destination host unreachable.`~~
   **Corrigé au §8** : c'est `PING: transmit failed. General failure.`
   qu'un vrai Windows rend là ; `Destination host unreachable.` est la
   réponse d'une cible du même sous-réseau restée muette à l'ARP.
8. Cisco / Huawei `ping` sur lien coupé rendent leur forme vendeur
   (`.....`, `success rate is 0 percent`).
9. Une session TCP établie qui traverse le lien est resetée au débranchement ;
   les listeners locaux, eux, survivent.
10. `ssh user@host cmd` échoue après débranchement (c'est B5).
11. Une session SSH interactive ouverte, puis lien coupé, puis commande :
    `client_loop: send disconnect: Broken pipe`, retour au shell local.
12. `w` / `who` ne listent plus la session SSH après coupure du lien.
13. OSPF perd l'adjacence et IPSec ferme la SA sur `port.link.down`.
14. Non-régression : toute la suite SSH existante, la suite ping, et les
    suites protocolaires passent inchangées câble branché.

## 5. Hors périmètre

- `ethtool` n'existe pas dans le simulateur (vérifié). Ajouter la commande
  entière dépasse ce PRD ; `Link detected: no` n'est donc pas couvert.
- La migration exhaustive de tous les appelants de `getIsUp()` vers
  `isOperationallyUp()` est faite au cas par cas, guidée par les tests des
  phases ci-dessus, et non en un remplacement global.

---

## 6. Deuxième passe — la porteuse vient d'en face

Les scénarios de panne (`scenario-panne-01` à `-03`) ont montré que le
modèle du §3.1 s'arrêtait au milieu du câble.

### 6.1 Ce qui manquait

`carrier = cable !== null && cable.getIsUp()` ne regarde que son propre
côté. Or la porteuse, c'est du signal **reçu** : elle exige que
l'émetteur d'en face soit allumé. Deux gestes très ordinaires
l'éteignent, et aucun des deux n'était modélisé :

- `shutdown` sur le port du switch — un vrai switch coupe l'émetteur du
  port ;
- l'équipement d'en face mis hors tension.

Le poste raccordé restait donc en `LOWER_UP`, `carrier=1`, `state UP`,
et son uplink continuait de s'afficher `connected` sur le switch de
distribution alors que le switch d'accès était éteint.

C'est ce qui privait le scénario 2 de tout son propos : il enseigne que
**depuis le poste**, un câble débranché et un port désactivé sont
indistinguables, et que seule la vue côté switch les sépare. Encore
faut-il que le poste voie tomber sa porteuse dans les deux cas.

### 6.2 Le terme qui manquait

```
isTransmitting() === isUp && !adminDown && équipement sous tension
hasCarrier()     === câble présent && câble up && pair.isTransmitting()
```

Pas de récursion possible : `isTransmitting()` ne consulte jamais la
porteuse. Le changement se **propage** en plus de se calculer — un port
dont l'émetteur change prévient son pair, qui émet alors son propre
`port.link.down`/`up`. La garde qui empêche les deux bouts de se
notifier en boucle est le fait que le pair, re-sollicité, trouve son
propre émetteur inchangé et s'arrête là. Brancher un câble ne propage
rien : cela ne change pas l'émetteur, et `Cable.connect` notifie déjà
les deux extrémités.

`Equipment.powerOn`/`powerOff` marquent chacun de leurs ports. L'état de
ligne du port de l'équipement éteint est laissé tel quel — personne ne
lit les interfaces d'une machine hors tension, et y toucher aurait
élargi la portée sans rien rendre observable.

### 6.3 La route connectée : le §1.2 se trompait

Le constat « `ip route` retire la route connectée d'un port sans
câble », rangé parmi les comportements corrects, était faux — et ni une
régression, ni une observation périmée : il confondait deux causes.

- **Perte de porteuse, interface toujours up** : Linux **garde** la
  route et la marque `linkdown`. C'est ce drapeau qui dit qu'une route
  existe mais que rien ne peut sortir par là.
- **Interface descendue administrativement** (`ip link set dev X down`) :
  là, la route connectée est bel et bien retirée.

Les deux sont implémentés, dans `EndHost.buildFullRoutingTable` — au
moment de rendre la table plutôt qu'au moment de poser l'adresse, parce
que la route connectée est stockée à la configuration de l'IP et que sa
copie stockée est donc antérieure à tout changement de lien. Les
interfaces virtuelles (`lo`, `tun`, `br`, …) en sont exemptées : elles
n'ont pas de fil à perdre.

### 6.4 Ce que la panne laisse comme traces

- **`Lost carrier` / `Gained carrier`** — un hôte systemd garde deux
  traces d'un changement de lien, écrites par deux auteurs : la ligne du
  pilote (`eth0: Link is Down`, déjà présente) et celle de networkd, qui
  est celle qu'on cherche puisqu'elle vient du gestionnaire du lien.
- **`(notconnect)` / `(disabled)`** — un Catalyst nomme entre
  parenthèses la cause de l'état bas, après `line protocol is down`. Un
  routeur, non : `showInterface` prend donc le trait en paramètre plutôt
  que de le deviner. `(err-disabled)`, troisième motif réel, n'est pas
  couvert : la cause errdisable vit dans la comptabilité du switch, pas
  sur le `Port` que ce rendu reçoit.
- **`show interfaces status`** lisait `isConnected()` — « un câble est
  branché » — au lieu de la porteuse. Un uplink vers un switch éteint
  s'affichait donc `connected`.

### 6.5 Ce que la correction a appris sur un test

`tracert-ping` n° 124 coupait `R2 Gi0/1` « pour simuler des pertes ».
C'est l'extrémité proche du lien de transit R1–R2 : R1 perd désormais sa
porteuse et répond `!N (Net unreachable)` — le contraire d'une perte
silencieuse. Toutes les pannes que ce simulateur modélise répondent
d'ailleurs quelque chose : `!N` pour une interface tombée, `!H` pour une
destination éteinte, `!A` pour une ACL. Le vrai silence est une sonde
qui disparaît sur le fil, et c'est ce que le test utilise maintenant
(`Cable.setPacketLossRate(1)`), avec un second cas qui fige le `!N`.

### 6.6 Vérification

24 probes (`probe-panne-01-porteuse-du-pair`,
`probe-panne-02-scripts-powershell`) et les 120 tests des dix scénarios
de panne. Régression : les 103 fichiers de `network-v2` touchant l'état
de lien, le routage ou l'extinction d'un équipement (2783 tests), plus
`unit/shell`, `unit/terminal`, `unit/gui`, `unit/react`, `unit/events`
(1403 tests) et `unit/powershell` (1960 tests). Les six échecs restants
— quatre dans `ssh-single-connection-per-login`, un dans
`ssh-edge-cases` §E12, un dans `NAT.reactive` — échouent à l'identique
au niveau de référence, vérifié par `git stash`. `tsc` rend exactement
les mêmes 127 erreurs qu'avant (seuls des numéros de ligne bougent) et
`eslint` les mêmes 10.

---

## 7. L'équivalent côté interface

Le §6 a rendu la perte de porteuse vraie dans le moteur. Restait la
question que l'utilisateur pose vraiment : **est-ce que ça se voit ?**

Non. Le canvas ne savait rien en dire.

### 7.1 Ce que l'interface montrait

- **La ligne de connexion** prenait sa couleur de `getConnectionColor(type)`
  — le *type de câble*. Un lien mort et un lien vivant étaient
  rigoureusement identiques à l'écran.
- **Le panneau de propriétés** affichait « Connected » dès que
  `connections.some(...)` trouvait un câble. C'est la même erreur que
  `show interfaces status` faisait côté CLI, et que le §6.4 a corrigée :
  répondre « est-ce câblé ? » à la question « est-ce que ça passe ? ».
- **Le store** ne transportait que `isUp: port.getIsUp()`, l'état de
  ligne. La porteuse n'arrivait jamais jusqu'à React, donc aucun
  composant n'aurait pu l'afficher même s'il l'avait voulu.

Le §3.2 avait prévu ce cas : les consommateurs de `getIsUp()` migrent
vers `isOperationallyUp()` « un par un, avec tests ». Celui-là ne l'avait
jamais été.

### 7.2 Ce qui a été fait

`NetworkInterfaceConfig` porte maintenant `hasCarrier` et
`isOperational` à côté de `isUp`. Le détail qui compte : les deux
nouveaux champs sont **dans la comparaison de `sameInterfaces`**. Le
store garde un instantané référentiellement stable pour éviter les
re-rendus inutiles (rapport 09, item #52) ; oublier les nouveaux champs
là aurait fait juger l'instantané inchangé quand seule la porteuse
bouge, et le canvas serait resté figé — exactement le défaut #56, mais
réintroduit par la porte de derrière.

Le pont d'événements (`port.link.up` / `port.link.down`) n'a rien
demandé de plus : le §6.2 fait justement émettre ces événements au pair
quand l'émetteur d'en face s'éteint, donc le canal existait déjà.

`ConnectionLine` rend un lien sans porteuse en rouge tireté, avec
`data-link-state` et l'état écrit dans l'`aria-label` : une ligne rouge
ne dit rien à un lecteur d'écran, ni à un opérateur daltonien. Le
panneau distingue désormais trois réponses là où il n'en avait qu'une :
`Connected`, `No carrier` (le câble est là, l'en-face n'émet pas) et
`Admin down` (l'interface locale est descendue).

### 7.3 Un défaut du harnais, trouvé en écrivant les specs

Le **premier test de chaque fichier e2e** échouait sur `page.goto`, avec
un dépassement de 15 s — y compris `cable-unplug.spec.ts`, antérieur à
ces travaux. La première navigation d'un run paie la transformation à la
demande de tout le graphe de modules par Vite ; les suivantes tapent le
cache chaud en 3 s. Le budget `navigationTimeout` était simplement sous
le coût réel : porté à 60 s, rien d'autre changé. Ce n'était pas une
lenteur de l'application, et le relever ne peut pas rendre vert un test
qui échouerait pour une vraie raison.

### 7.4 Vérification

`e2e/link-state-canvas.spec.ts` — 11 cas : les trois causes vues du
canvas, la reprise dans les deux sens, et les quatre réponses du
panneau. Régression e2e sur les specs touchant le canvas
(`canvas-accessibility`, `canvas-cable-save-flow`, `connection-select`,
`dnd-first-attempt`, `ping-unplug-transcript`, `cable-unplug`) : tout
vert, et `cable-unplug` retrouve au passage son premier test. Unitaire :
`unit/gui` + `unit/react`, 165 tests verts. `tsc` à 127, `eslint` propre
sur les fichiers touchés.

---

## 8. `ping` Windows : trois échecs, trois phrases

Signalé sur transcript réel : deux sorties que le simulateur ne
produisait pas, depuis la même machine et à une commande d'intervalle.

```
C:\>ping 192.168.1.1
PING: transmit failed. General failure.     (x4)

C:\>ping 100.100.11.1
Request timed out.                          (x4)
```

Windows ne dit pas « ça n'a pas marché » d'une seule façon, et la
différence *est* le diagnostic :

| Phrase | Ce qu'elle signifie |
|---|---|
| `PING: transmit failed. General failure.` | la pile refuse d'émettre : pas de route, ou interface incapable d'attaquer son fil |
| `Reply from <soi>: Destination host unreachable.` | destination sur le lien, restée muette à l'ARP — c'est la pile locale qui renonce |
| `Request timed out.` | la sonde est partie, rien n'est revenu |
| `Reply from <routeur>: Destination host unreachable.` | un routeur a répondu ICMP unreachable |

### 8.1 Ce qui n'allait pas

`executePingSequence` réduit trois échecs distincts au même tableau
vide : pas de route, ARP échoué, et l'envoi impossible. Le rendu
choisissait alors `General failure` pour *toutes* les séquences sans
résultat — sans jamais savoir laquelle.

Et le test qui décidait d'émettre ne regardait que l'état de ligne
(`getIsUp() && !isAdminDown()`), sur **n'importe quelle** interface de
la machine. La porteuse n'y entrait pas. Résultat mesuré : un câble
arraché rendait `Destination host unreachable`, une cible muette sur le
lien rendait `General failure` — les deux bonnes réponses, chacune à la
place de l'autre. Et `Request timed out.`, la sortie la plus courante
d'un vrai Windows, n'apparaissait jamais.

### 8.2 Ce qui a été fait

La décision revient là où le vrai Windows la prend : **avant** que quoi
que ce soit n'atteigne le fil. `resolvePingEgress(target)` répond par
quelle interface ce paquet sortirait et si la destination est sur son
propre sous-réseau. Sans route, ou si cette interface est désactivée ou
sans porteuse, c'est `transmit failed` — et aucune attente ne
transformera ce refus en délai dépassé.

Le reste découle : une séquence vide sur un chemin déclaré praticable ne
peut plus être qu'un silence. Sur le lien, c'est l'ARP resté sans
réponse, que Windows rapporte depuis l'adresse de l'expéditeur ;
ailleurs, c'est le timeout.

Le bloc « Approximate round trip times » reste absent quand rien n'est
revenu — il n'y a pas d'aller-retour à mesurer.

### 8.3 Un critère du PRD démenti par le transcript

Le §4 #7 demandait « Windows `ping` sur lien coupé rend
`Destination host unreachable.` ». L'intention était juste — un lien
coupé ne se dit pas « Request timed out » — mais la chaîne, non : une
carte sans lien perd sa route, et la pile refuse d'émettre. Le critère
et le test qui l'encodait sont corrigés, avec la raison écrite dedans ;
`Destination host unreachable.` reste la bonne réponse pour le voisin
muet, et un cas séparé la fige.

### 8.4 Vérification

`probe-winping-01-trois-issues.test.ts` — 10 cas couvrant les cinq
situations d'échec, la réussite, et la reprise après rebranchement et
remise sous tension. Régression sur les sept fichiers qui affirment une
chaîne du `ping` Windows (749 tests), plus les dix scénarios de panne et
leurs probes (199 tests). `tsc` à 127, `eslint` inchangé — les trois
erreurs de `WinCommandExecutor.ts` sont antérieures, vérifié par
`git stash`.
