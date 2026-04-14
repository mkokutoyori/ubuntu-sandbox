# Analyse des écarts — `LinuxPC` vs `LinuxServer`

## 1. Introduction et périmètre

Ce document recense les écarts d'implémentation entre les deux machines
Linux simulées par le sandbox :

| Classe        | Fichier                                             | Taille |
| ------------- | --------------------------------------------------- | ------ |
| `LinuxPC`     | `src/network/devices/LinuxPC.ts`                    | 801 l. |
| `LinuxServer` | `src/network/devices/LinuxServer.ts`                | 318 l. |

Les deux classes héritent directement de `EndHost` (cf.
`src/network/devices/EndHost.ts`) qui fournit la pile L2/L3 (ARP, IPv4/IPv6,
ICMP, routage statique, DHCP client, NDP, etc.), et utilisent toutes les deux
un `LinuxCommandExecutor` interne
(`src/network/devices/linux/LinuxCommandExecutor.ts`) pour déléguer
l'exécution des commandes shell non-réseau (filesystem, utilisateurs,
iptables, services, etc.).

### 1.1 Constat initial

Conceptuellement, **un serveur Linux est une machine Linux** au sens strict :
les deux partagent exactement le même noyau, le même userspace GNU, les mêmes
sous-systèmes (iproute2, netfilter, systemd, coreutils…). La différence ne
tient pas à la nature du système, mais uniquement à son *profil*
d'utilisation :

- un PC tourne généralement avec un utilisateur non-root, possède un
  client DHCP actif, résout ses noms via `/etc/resolv.conf` ;
- un serveur tourne généralement en root, expose des services
  (DNS, HTTP, SGBD, etc.), et a des interfaces configurées statiquement.

Or, dans l'implémentation actuelle, cette distinction purement *profil* est
devenue une divergence *structurelle* : `LinuxPC` et `LinuxServer` sont deux
classes sœurs qui :

1. dupliquent entre ~150 et ~200 lignes de code identique ou quasi-identique
   (adaptateur `ip`, firewall, NAT, `ifconfig`, `arp`, helpers d'éditeur…) ;
2. divergent silencieusement sur des commandes réseau critiques :
   `ping`, `traceroute`, `dig`, `nslookup`, `host` — `LinuxPC` utilise
   la vraie pile `EndHost`, tandis que `LinuxServer` retombe sur les
   réponses stubées de `LinuxCommandExecutor` ;
3. exposent des fonctionnalités asymétriques (dhclient, dnsmasq,
   sysctl ip_forward, masquerade, xfrm, DNS resolver) uniquement sur `LinuxPC`,
   alors qu'un serveur Linux devrait pouvoir les utiliser tout autant (et
   même davantage dans le cas de dnsmasq).

### 1.2 Objectifs du document

1. **Section 2** — Photographier l'état actuel : quelle classe fait quoi,
   quelles dépendances, quel `executor`.
2. **Section 3** — Recenser le code purement dupliqué (copier-coller) entre
   les deux classes.
3. **Section 4** — Lister les fonctionnalités présentes dans `LinuxPC` mais
   absentes de `LinuxServer`.
4. **Section 5** — Lister les fonctionnalités présentes dans `LinuxServer`
   mais absentes de `LinuxPC`.
5. **Section 6** — Proposer une architecture modulaire unifiée autour
   d'une classe abstraite `LinuxMachine`.
6. **Section 7** — Définir l'interface `LinuxCommand` et un registre de
   commandes permettant d'isoler chaque commande dans son propre fichier.
7. **Section 8** — Proposer l'arborescence cible `linux/commands/…`
   commande par commande.
8. **Section 9** — Esquisser un plan de migration incrémental, sans casser
   les tests existants (`src/__tests__/unit/network-v2/` et `unit/gui/`).

### 1.3 Hors scope

- L'architecture du `VirtualFileSystem`, de `LinuxUserManager`,
  `LinuxIptablesManager`, `LinuxServiceManager`, `LinuxProcessManager` :
  ces modules sont déjà correctement isolés et seront réutilisés tels
  quels par la nouvelle architecture.
- Le pipeline `bash` (`src/bash/`) : il reste l'interpréteur de référence
  pour `LinuxCommandExecutor.execute()`.
- Les commandes Cisco/Huawei/Windows : hors périmètre.

## 2. État actuel

### 2.1 Vue d'ensemble de la hiérarchie

```
Equipment (abstract)
 └── EndHost (abstract, L2/L3 stack : ARP, IPv4/IPv6, ICMP, routage, DHCP client)
      ├── LinuxPC     ──► LinuxCommandExecutor(isServer = false)
      ├── LinuxServer ──► LinuxCommandExecutor(isServer = true)
      └── WindowsPC   ──► WinCommandExecutor / PowerShellExecutor
```

`EndHost` (~1960 lignes) fournit toute la pile réseau en dur : résolution
ARP, envoi/réception d'IPv4 et IPv6, ICMP echo, `executePingSequence`,
`executeTraceroute`, table de routage hôte, DHCP client intégré, NDP,
hooks firewall (`firewallFilter`, `evaluateNat`, `evaluatePreRouting`).
Tout ce qui est « TCP/IP » est déjà mutualisé.

### 2.2 `LinuxPC` (801 lignes)

- Crée 4 ports `eth0..eth3`.
- Instancie `LinuxCommandExecutor(false)` → profil utilisateur non-root
  (`user` / uid 1000 / sudoer via groupe `sudo`).
- `executeCommand(cmd)` implémente *sa propre* logique de dispatch :
  1. `containsNetworkCommand()` détecte si la commande est réseau ;
  2. gère le séparateur `;` par récursion et les pipes `|` (non `||`) via
     `executePipedCommand()` (qui ne connaît que `grep`, `head`, `tail`) ;
  3. tente un dispatch sur une table de commandes réseau codée en dur
     (`tryNetworkCommand`) ;
  4. tombe sur `executor.execute()` pour tout le reste.
- Surcharge `firewallFilter`, `evaluateNat`, `evaluatePreRouting` en
  déléguant à `executor.iptables`.
- Implémente en propre, *avec accès aux internes de `EndHost`* :
  `cmdIfconfig`, `cmdPing`, `cmdArp`, `cmdTraceroute`, `cmdDhclient`,
  `cmdPs` (pour voir les processus dhclient), `cmdSysctl`
  (`net.ipv4.ip_forward`), `cmdDnsmasq`, et les commandes DNS client
  `dig` / `nslookup` / `host` via `LinuxDnsService`.
- Possède une instance `DnsService` (démon dnsmasq simulé) et un champ
  `dnsResolverIP` (lu depuis `/etc/resolv.conf`).
- Possède un contexte `IpXfrmContext` pour `ip xfrm state/policy`.
- Intercepte `cat /var/lib/dhcp/dhclient.*.leases` pour renvoyer les baux
  formatés depuis le `DHCPClient` de `EndHost`, et `rm` sur ces mêmes
  fichiers (no-op silencieux).
- Hook `handleIptablesNat()` qui alimente `masqueradeOnInterfaces` de
  `EndHost` lorsqu'on ajoute une règle `iptables -t nat -A POSTROUTING -j
  MASQUERADE -o <if>`.

### 2.3 `LinuxServer` (318 lignes)

- Crée 4 ports `eth0..eth3`.
- Instancie `LinuxCommandExecutor(true)` → profil root (pas de création
  d'utilisateur `user`, shell initial `-bash` sous `root`).
- `executeCommand(cmd)` est beaucoup plus simple :
  1. `tryNetworkCommand()` ne gère que `ifconfig` et `arp` ;
  2. tout le reste (y compris `ping`, `traceroute`, `dig`, `nslookup`,
     `host`, `dhclient`, `sysctl`, `dnsmasq`, ainsi que les pipes et les
     compositions `;`/`&&`/`||`) est délégué à `executor.execute()`, qui
     passe par l'interpréteur bash complet.
- Surcharge `firewallFilter` et `evaluateNat` (comme `LinuxPC`), mais
  **ne surcharge pas** `evaluatePreRouting` — les DNAT en entrée ne sont
  donc pas évaluées sur un serveur.
- Expose `registerProcess` / `clearSystemProcesses` pour que les
  processus Oracle (background DBMS) remontent dans `ps`.
- Ne possède **aucune** des fonctionnalités listées en 2.2 comme propres
  à `LinuxPC` : pas de `dhclient`, pas de `DnsService`, pas de `xfrm`,
  pas de lecture des baux DHCP, pas de hook MASQUERADE.

### 2.4 Conséquences fonctionnelles observables

| Commande               | `LinuxPC`                         | `LinuxServer`                              |
| ---------------------- | --------------------------------- | ------------------------------------------ |
| `ping X`               | Vraie pile (ICMP, RTT réelle)     | Stub `LinuxCommandExecutor` (texte canné)  |
| `traceroute X`         | Vraie pile (TTL décroissant)      | Stub canné                                 |
| `dig X` / `nslookup X` | `LinuxDnsService` + resolver conf | Stub canné                                 |
| `dhclient eth0`        | Vrai DHCP client                  | Non géré (passe par bash, commande inconnue) |
| `sysctl -w ip_forward` | Active `ipForwardEnabled`         | No-op (commande absente du dispatcher)     |
| `iptables MASQUERADE`  | Hook NAT routing-layer            | Règle posée mais ignorée côté routing      |
| `ip xfrm ...`          | Contexte xfrm                     | Pas de contexte                            |
| `dnsmasq -C conf`      | Démarre `DnsService`              | Commande absente                           |
| `ps` (dhclient actifs) | Ajoute une ligne par lease actif  | Ne voit rien                               |
| `cat /var/lib/dhcp/*`  | Formate le bail depuis `EndHost`  | Non géré                                   |
| DNAT `PREROUTING`      | Pris en compte                    | **Non évalué** (override manquante)        |

Ces comportements divergents ne sont pas voulus : ils résultent d'une
copie partielle de `LinuxPC` vers `LinuxServer` au moment de la création
de cette dernière, puis d'ajouts ultérieurs uniquement sur `LinuxPC`.

## 3. Code dupliqué entre `LinuxPC` et `LinuxServer`

Les blocs suivants sont présents **deux fois** (copie conforme ou quasi),
pour un total d'environ 180 lignes de duplication stricte sur les
318 lignes de `LinuxServer`. Autrement dit : **≈ 57 % de `LinuxServer`
n'existe que parce que `LinuxPC` existe déjà**.

### 3.1 Création des ports (`createPorts`)

`LinuxPC.ts:38-42` et `LinuxServer.ts:30-34` — identique à la lettre :

```ts
for (let i = 0; i < 4; i++) {
  this.addPort(new Port(`eth${i}`, 'ethernet'));
}
```

### 3.2 `cmdIfconfig` / `showAllInterfaces`

`LinuxPC.ts:339-368` vs `LinuxServer.ts:71-99` : même logique (parsing des
arguments, appel à `configureInterface`, boucle d'affichage). Seule la
mise en forme de `formatInterface` diffère (cf. 3.3).

### 3.3 `formatInterface`

`LinuxPC.ts:370-393` vs `LinuxServer.ts:101-111` : même rôle, mais la
version `LinuxServer` est une version **dégradée** de celle de `LinuxPC` :

- pas de `flags=<num>` dynamique basé sur `isUp && isConnected` ;
- pas de compteurs `RX packets` / `TX packets` ;
- MTU codé en dur à `1500` au lieu de `port.getMTU()`.

C'est donc un bug latent : un `LinuxServer` affiche des données moins
riches qu'un `LinuxPC` alors qu'il s'agit du même `ifconfig` GNU.

### 3.4 `cmdArp`

`LinuxPC.ts:635-643` et `LinuxServer.ts:113-121` — strictement identiques.
Tous deux construisent le même `LinuxArpContext` et délèguent à
`linuxArp()`.

### 3.5 `buildIpNetworkContext`

`LinuxPC.ts:441-564` (124 l.) vs `LinuxServer.ts:125-247` (123 l.) :
**123 lignes identiques**, à la seule exception près du champ `xfrm`
présent uniquement chez `LinuxPC` (1 ligne). Chaque méthode de
l'interface `IpNetworkContext` (`getInterfaceNames`, `getInterfaceInfo`,
`configureInterface`, `removeInterfaceIP`, `getRoutingTable`,
`addDefaultRoute`, `addStaticRoute`, `deleteDefaultRoute`, `deleteRoute`,
`getNeighborTable`, `setInterfaceUp`, `setInterfaceDown`) est copiée à
l'identique.

C'est la duplication la plus coûteuse du projet : toute évolution de
l'adaptateur `ip` (ajout d'un champ, correction d'un bug de conversion
CIDR, support d'un nouveau type de route) doit être faite deux fois —
et à chaque fois qu'elle ne l'est pas, un nouveau gap apparaît.

### 3.6 `firewallFilter`

`LinuxPC.ts:673-691` vs `LinuxServer.ts:251-268` — identique : construction
de `PacketInfo` puis appel à `executor.iptables.filterPacket()`.

### 3.7 `evaluateNat`

`LinuxPC.ts:693-708` vs `LinuxServer.ts:270-285` — identique.

### 3.8 Helpers d'éditeur et de session

`LinuxPC.ts:734-760` vs `LinuxServer.ts:289-315` — bloc de ~25 lignes
parfaitement identique :

```ts
readFileForEditor / writeFileFromEditor / resolveAbsolutePath /
getCwd / getCompletions / getCurrentUser / getCurrentUid / handleExit /
resetSession / checkPassword / setUserPassword / userExists /
setUserGecos / canSudo
```

Ce sont tous des *pass-through* vers l'`executor`. Ils existent parce
que `Terminal.tsx` ne connaît que la classe `EndHost`-dérivée, pas
l'`executor`, mais rien n'impose que ce soit l'équipement qui les
implémente.

### 3.9 `getOSType`

Les deux classes implémentent `getOSType(): string { return 'linux'; }`
à l'identique.

### 3.10 Récapitulatif

| Zone                         | Lignes dupliquées | Risque           |
| ---------------------------- | ----------------- | ---------------- |
| `createPorts`                |                 5 | faible           |
| `cmdIfconfig`                |              ~20 | divergence facile|
| `formatInterface`            |              ~15 | **déjà divergent** |
| `cmdArp`                     |              ~10 | faible           |
| `buildIpNetworkContext`      |             ~123 | **critique**     |
| `firewallFilter`             |              ~20 | divergence facile|
| `evaluateNat`                |              ~15 | divergence facile|
| Helpers éditeur / session    |              ~25 | faible           |
| `getOSType`                  |                 1 | nulle            |
| **Total**                    |        **~234**   |                  |

À comparer avec les 318 lignes totales de `LinuxServer` : pratiquement
tout le fichier est un clone.

## 4. Fonctionnalités présentes dans `LinuxPC`, absentes de `LinuxServer`

Cette section énumère chaque capacité que `LinuxPC` a et que `LinuxServer`
n'a pas. Pour chaque entrée : localisation dans le code, ce qui se passe
actuellement côté serveur, et pourquoi c'est un bug par rapport au modèle
GNU/Linux.

### 4.1 Dispatch réseau riche + pipes + séparateurs

`LinuxPC.ts:46-137`

- `containsNetworkCommand()` détecte la présence d'une commande réseau
  dans une ligne composée (`;`, `|`, `&&`, `||`).
- `executePipedCommand()` applique `grep`, `head`, `tail` en aval d'une
  sortie réseau.
- Le séparateur `;` est géré par récursion.

Côté `LinuxServer`, `executeCommand` ne regarde que le premier mot via
`tryNetworkCommand()` et ne gère donc correctement ni `ifconfig | grep
eth0`, ni `arp -n; ip route`, quand ces commandes ont besoin des internes
`EndHost`. Le pipe `ifconfig eth0 | grep inet` exécuté sur un serveur
tombera en fait sur le `cmdIfconfig` du *LinuxCommandExecutor* (version
texte statique basée sur `IpNetworkContext`) et non sur la version riche
avec compteurs.

### 4.2 Vraie commande `ping` (ICMP)

`LinuxPC.ts:568-631` — utilise `EndHost.executePingSequence()` pour
envoyer de vrais paquets ICMP à travers la topologie simulée, mesure
la RTT via `performance.now()`, et formate la sortie façon `iputils-ping`
(ligne `PING`, lignes `icmp_seq=…`, bloc `--- statistics ---` avec
`min/avg/max/mdev`).

`LinuxServer.ts:63` retourne `null` pour `ping` → tombe sur le stub
`LinuxCommandExecutor.dispatch()` (`LinuxCommandExecutor.ts:661-665`)
qui retourne une chaîne canned :

```
64 bytes from X: icmp_seq=1 ttl=64 time=0.5 ms
```

**Conséquence** : depuis un `LinuxServer`, on ne peut pas tester la
connectivité L3 réelle, ni vérifier un firewall, ni observer un drop,
ni mesurer un `Destination Host Unreachable`. Les tests réseau
regression sont donc aveugles sur les serveurs.

### 4.3 Vraie commande `traceroute`

`LinuxPC.ts:647-669` — utilise `EndHost.executeTraceroute()` (TTL
décroissant, réception d'`ICMP Time Exceeded` des routeurs intermédiaires).

`LinuxServer` → stub canné (`gateway (10.0.0.1)` en dur). Même
conséquence que 4.2.

### 4.4 Client DHCP (`dhclient`)

`LinuxPC.ts:237-323` — gère tous les drapeaux utiles :
`-v`, `-d`, `-r` (release), `-x` (stop), `-w`, `-s <server>`,
`-t <timeout>`, plus la découverte par broadcast via
`discoverDHCPServersBroadcast()` / `autoDiscoverDHCPServers()`.
Intègre également le stockage / formatage du bail via
`dhcpClient.requestLease()` / `releaseLease()`.

`LinuxServer` : aucune gestion. La commande tombe sur le `default:
command not found` du dispatcher. Un serveur Linux réel peut pourtant
être configuré en DHCP (très fréquent en bord d'internet).

### 4.5 Lecture des fichiers de bail DHCP

`LinuxPC.ts:175-200` intercepte :

- `cat /var/lib/dhcp/dhclient.leases` → concatène les baux de tous
  les ports via `dhcpClient.formatLeaseFile(name)` ;
- `cat /var/lib/dhcp/dhclient.<iface>.leases` → bail d'une interface ;
- `rm /var/lib/dhcp/dhclient*` → no-op silencieux.

Côté serveur, ces chemins n'existent pas dans le VFS, donc `cat`
retourne `No such file or directory`.

### 4.6 `ps` augmenté avec les processus `dhclient`

`LinuxPC.ts:327-335` — ajoute une ligne par interface ayant un
`dhclient` actif, en consultant `dhcpClient.isProcessRunning(name)`.

`LinuxServer` s'appuie exclusivement sur `LinuxProcessManager`, qui
ignore les clients DHCP.

### 4.7 `sysctl net.ipv4.ip_forward`

`LinuxPC.ts:405-417` — active le flag `ipForwardEnabled` de `EndHost`,
qui est indispensable pour que la machine fasse du **forwarding**
(routage inter-interfaces).

`LinuxServer` : commande absente du dispatcher → la variable reste
à `false`, et un serveur Linux **ne peut pas** être utilisé comme
routeur logiciel, ce qui est pourtant un usage très courant.

### 4.8 Hook `iptables MASQUERADE` → routing NAT

`LinuxPC.ts:426-437` — `handleIptablesNat()` analyse les arguments
`iptables -t nat -A POSTROUTING -j MASQUERADE -o <if>` et alimente
`this.masqueradeOnInterfaces` (dans `EndHost`), ce qui connecte la
règle au moteur de NAT au moment du forwarding.

`LinuxServer` pose bien la règle dans `iptables` (via le manager), mais
le moteur de routing de `EndHost` n'en est pas informé → le NAT sortant
est silencieusement ignoré.

### 4.9 DNAT / port-forwarding (`evaluatePreRouting`)

`LinuxPC.ts:714-728` surcharge `evaluatePreRouting()` et délègue à
`executor.iptables.evaluateNat(pkt, 'PREROUTING')`.

`LinuxServer` **n'a pas cette surcharge**. Les règles
`iptables -t nat -A PREROUTING -j DNAT --to-destination …` ne sont
donc jamais consultées lorsque le paquet entre sur le serveur : le
port-forwarding / redirection de port est mort côté serveur.

### 4.10 Commandes DNS client (`dig`, `nslookup`, `host`)

`LinuxPC.ts:215-226` appelle `executeDig()`, `executeNslookup()`,
`executeHost()` du module `LinuxDnsService`, en passant le resolver
lu depuis `/etc/resolv.conf` (`getResolverIP()`).

`LinuxServer` → stub canné de `LinuxCommandExecutor` qui retourne
toujours `93.184.216.34`. La simulation DNS n'est donc fonctionnelle
que sur les `LinuxPC`.

### 4.11 `dnsmasq` (serveur DNS)

`LinuxPC.ts:776-800` lit `/etc/dnsmasq.conf`, parse éventuellement un
`addn-hosts`, puis appelle `dnsService.parseConfig()` +
`dnsService.start()`.

`LinuxServer` → n'a ni champ `dnsService`, ni commande `dnsmasq`.
**C'est le plus gros contresens du projet** : un PC utilisateur peut
démarrer un serveur DNS, mais un serveur Linux ne le peut pas.

### 4.12 `ip xfrm` (IPsec)

`LinuxPC.ts:25` définit `xfrmCtx: IpXfrmContext` et le passe dans
`IpNetworkContext`. `LinuxServer` ne l'a pas, donc toute commande
`ip xfrm state/policy` sur un serveur retombera sur un `xfrm:
undefined` côté `LinuxIpCommand`. Or, IPsec site-à-site est
typiquement configuré **sur des serveurs/passerelles**, pas sur un
PC de bureau.

### 4.13 Compteurs `ifconfig` (RX/TX packets)

Déjà couvert en 3.3 — `LinuxPC.formatInterface()` affiche :

```
RX packets 123  bytes 4567 (4.5 KB)
TX packets 456  bytes 7890 (7.7 KB)
```

`LinuxServer.formatInterface()` les omet. Bug d'affichage pur,
aggravé par le fait que les vraies données sont disponibles dans
`port.getCounters()`.

### 4.14 Synthèse

Sur 14 écarts, **13 sont des régressions silencieuses** (comportement
inférieur au PC, alors que le serveur Linux réel *supporte* ces fonctions
— et souvent *mieux* que le PC). Seul l'écart 4.1 (pipe réseau)
pourrait se défendre au motif que l'interpréteur bash complet de
`LinuxCommandExecutor` gère déjà les pipes — mais pas sur les sorties
venant des commandes réseau spécifiques à `LinuxPC`.

## 5. Fonctionnalités présentes dans `LinuxServer`, absentes de `LinuxPC`

Le déséquilibre est beaucoup plus faible dans ce sens : seuls deux
points distinguent positivement `LinuxServer`.

### 5.1 Profil `executor` en mode serveur

`LinuxServer.ts:26` : `new LinuxCommandExecutor(true)`.

L'argument `isServer = true` change plusieurs comportements dans
`LinuxCommandExecutor` :

- aucun utilisateur `user` (uid 1000) n'est créé, la session démarre
  directement en `root` (uid 0) ;
- le cwd initial est `/root` au lieu de `/home/user` ;
- le shell enregistré dans `LinuxProcessManager` est spawné en root ;
- certaines commandes réseau (`netstat`, `ss`) dans `LinuxNetCommands`
  exposent des sockets d'écoute différents selon le profil serveur.

Techniquement, cela ne justifie pas une classe séparée : c'est une
*option de construction* de l'`executor`, rien de plus.

### 5.2 Exposition des API processus pour Oracle

`LinuxServer.ts:316-317` :

```ts
registerProcess(pid: number, user: string, command: string): void
clearSystemProcesses(): void
```

Ces deux méthodes sont utilisées par `src/database/oracle/…` pour
faire apparaître les processus d'arrière-plan d'Oracle (`pmon`,
`smon`, `lgwr`, `dbwr`, `ckpt`, `arch`…) dans la sortie de `ps`
et `top`. Elles ne sont *pas* exposées par `LinuxPC`.

**Remarque importante** : l'implémentation sous-jacente existe
déjà dans `LinuxCommandExecutor` (cf.
`LinuxCommandExecutor.ts:103-118`). C'est donc de nouveau une simple
question de **surface publique de la classe** : `LinuxPC` pourrait
exposer ces méthodes sans aucun effort. Un PC Linux peut parfaitement
faire tourner une base Oracle Express ou Postgres en local pour du
développement.

### 5.3 Conclusion de cette section

Il n'y a strictement **aucune** capacité métier que seul `LinuxServer`
peut offrir au simulateur. Toutes les différences « positives » de
`LinuxServer` se réduisent à :

1. passer `isServer = true` au constructeur de l'`executor` ;
2. rendre publics deux passe-plats vers `executor.registerProcess` /
   `executor.clearSystemProcesses`.

Cela confirme le diagnostic de la Section 1 : **la distinction entre
PC et serveur n'est pas une distinction de classe, c'est une
distinction de *profil* de configuration à la construction.**
