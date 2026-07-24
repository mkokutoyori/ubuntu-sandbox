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
| `ip route` retire la route connectée d'un port sans câble | OK |
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
7. Windows `ping` sur lien coupé rend `Destination host unreachable.`
   plutôt que `Request timed out.`.
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
