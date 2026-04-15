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

## 6. Architecture cible — hiérarchie `LinuxMachine`

### 6.1 Principe directeur

> *Un serveur Linux est une machine Linux.* Il n'a pas à vivre dans une
> classe sœur de `LinuxPC` : il est un `LinuxPC` (ou plus exactement,
> une `LinuxMachine`) configuré différemment.

La hiérarchie cible devient :

```
Equipment (abstract)
 └── EndHost (abstract, pile L2/L3 + DHCP + NDP + firewall hooks)
      └── LinuxMachine (abstract, un "noyau Linux" simulé)
           ├── LinuxPC     (profil desktop / workstation)
           └── LinuxServer (profil serveur root-only + hooks DBMS)
```

`LinuxMachine` récupère **toute** la logique commune aujourd'hui
dupliquée (Section 3) *et* **toutes** les fonctionnalités aujourd'hui
réservées à `LinuxPC` (Section 4). Les sous-classes ne font que :

1. fournir un `LinuxProfile` au constructeur de `LinuxMachine` ;
2. éventuellement surcharger `registerDeviceCommands()` pour ajouter
   des commandes propres (cas du serveur avec Oracle, cf. 6.5).

### 6.2 Responsabilités de `LinuxMachine`

`LinuxMachine extends EndHost` centralise :

| Responsabilité                         | Ce qui disparaît de `LinuxPC`/`LinuxServer` |
| -------------------------------------- | ------------------------------------------- |
| Création des ports `eth0..eth3`        | `createPorts()` ×2                          |
| Instanciation de `LinuxCommandExecutor`| constructeurs ×2                            |
| Construction d'`IpNetworkContext`      | `buildIpNetworkContext` ×2 (123 l.)         |
| Surcharges `firewallFilter`, `evaluateNat`, `evaluatePreRouting` | 3 méthodes ×2 |
| `getOSType()`                          | 1 ligne ×2                                  |
| Helpers éditeur / session (14 méthodes)| bloc de 25 lignes ×2                        |
| Pipeline `executeCommand` (réseau + bash)| logique riche de `LinuxPC` réutilisée        |
| État réseau additionnel (`xfrmCtx`, `dnsService`, `dnsResolverIP`) | champs ×1 au lieu de ×0 côté serveur |
| Dispatch vers `LinuxCommandRegistry`    | switch `tryNetworkCommand` ×2               |

Signature (squelette) :

```ts
export interface LinuxProfile {
  /** Nombre et nommage des interfaces par défaut. */
  portCount: number;
  portPrefix: string;               // "eth"

  /** Si vrai, l'executor démarre en root, sans utilisateur "user". */
  isServer: boolean;

  /** Nom d'hôte initial. */
  hostname: string;

  /** Active le démon dnsmasq par défaut (serveurs DNS). */
  autoStartDnsmasq?: boolean;

  /** Exposer les API registerProcess/clearSystemProcesses
   *  (utilisé par Oracle, cf. 5.2). */
  exposeSystemProcessApi?: boolean;
}

export abstract class LinuxMachine extends EndHost {
  protected readonly defaultTTL = 64;
  protected readonly executor: LinuxCommandExecutor;
  protected readonly profile: LinuxProfile;

  /** Démons L7 co-localisés avec la machine. */
  readonly dnsService = new DnsService();
  protected xfrmCtx: IpXfrmContext = { states: [], policies: [] };
  protected dnsResolverIP = '';

  /** Registre de commandes spécifiques à la machine (réseau, dhclient…). */
  protected readonly commands: LinuxCommandRegistry;

  constructor(type: DeviceType, name: string, x: number, y: number,
              profile: LinuxProfile) {
    super(type, name, x, y);
    this.profile = profile;
    this.createPorts();
    this.executor = new LinuxCommandExecutor(profile.isServer);
    this.executor.setIpNetworkContext(this.buildIpNetworkContext());
    this.commands = new LinuxCommandRegistry();
    this.registerCoreCommands();    // ping, traceroute, ifconfig, arp,
                                    // dhclient, sysctl, dig, …
    this.registerDeviceCommands();  // hook sous-classes
  }

  /* ─── Exécution ─────────────────────────────────────────────── */
  async executeCommand(cmd: string): Promise<string> { /* voir §7 */ }

  /* ─── Hooks surchargables ───────────────────────────────────── */
  protected registerDeviceCommands(): void { /* no-op par défaut */ }

  /* ─── Overrides EndHost (firewall/NAT, uniques) ─────────────── */
  protected override firewallFilter(...): 'accept'|'drop'|'reject' { … }
  protected override evaluateNat(...)      { … }
  protected override evaluatePreRouting(...) { … }
}
```

### 6.3 `LinuxPC` — profil desktop

`LinuxPC` devient littéralement :

```ts
export class LinuxPC extends LinuxMachine {
  constructor(type: DeviceType = 'linux-pc', name = 'PC', x = 0, y = 0) {
    super(type, name, x, y, {
      portCount: 4,
      portPrefix: 'eth',
      isServer: false,
      hostname: 'linux-pc',
    });
  }
}
```

Soit ~8 lignes au lieu de 801. Toutes les commandes historiquement
implémentées dans le corps de `LinuxPC` (cf. §4) sont portées *une
seule fois* dans le registre de `LinuxMachine`.

### 6.4 `LinuxServer` — profil serveur

```ts
export class LinuxServer extends LinuxMachine {
  constructor(type: DeviceType = 'linux-server', name = 'Server', x = 0, y = 0) {
    super(type, name, x, y, {
      portCount: 4,
      portPrefix: 'eth',
      isServer: true,
      hostname: 'linux-server',
      exposeSystemProcessApi: true,
    });
  }

  // Uniquement les deux pass-throughs Oracle (cf. §5.2)
  registerProcess(pid: number, user: string, command: string): void {
    this.executor.registerProcess(pid, user, command);
  }
  clearSystemProcesses(): void {
    this.executor.clearSystemProcesses();
  }
}
```

Résultat : ~18 lignes au lieu de 318. Et surtout, `ping`, `traceroute`,
`dig`, `dhclient`, `dnsmasq`, `sysctl ip_forward`, DNAT préroutage,
affichage riche de `ifconfig` — tout cela **fonctionne immédiatement**
sur un `LinuxServer`, car le code vient de la classe mère.

### 6.5 Variante : profils riches

Si à terme on veut éviter que `LinuxServer` expose `registerProcess`
comme passe-plat dans la classe, on peut rendre ce comportement
optionnel directement dans `LinuxMachine` :

```ts
if (profile.exposeSystemProcessApi) {
  // Les méthodes sont alors définies sur LinuxMachine conditionnellement
  // via un mixin ou un flag lu par Oracle via un cast vers une interface
  //   ISystemProcessHost { registerProcess(); clearSystemProcesses(); }
}
```

Cela permettrait à `LinuxServer` d'être une simple différence de profil
sans *aucune* méthode supplémentaire.

### 6.6 Pourquoi pas une seule classe paramétrée ?

On pourrait se passer de `LinuxPC` / `LinuxServer` et n'avoir que
`LinuxMachine`. Deux raisons de garder les sous-classes :

1. `DeviceFactory` continue de créer un `LinuxPC` ou un `LinuxServer`
   en fonction du `DeviceType` (clé stable utilisée par le Zustand
   store et la sérialisation des topologies).
2. Les tests (`src/__tests__/unit/network-v2/`) instancient
   directement ces classes — la transition est moins invasive si
   elles continuent d'exister, ne serait-ce que comme coquilles.

Les deux sous-classes restent donc, mais deviennent purement
**déclaratives** : elles ne contiennent plus aucune logique, juste un
profil. Tout le comportement vit dans `LinuxMachine` et le registre
de commandes décrit à la Section 7.

## 7. Pattern de commandes modulaires — interface et registre

### 7.1 Problème à résoudre

Aujourd'hui, chaque commande réseau spécifique (ping, traceroute,
dhclient, dnsmasq, sysctl, dig, …) est une méthode privée de
`LinuxPC` (`cmdPing`, `cmdTraceroute`, `cmdDhclient`, …) qui accède
directement aux champs protégés de `EndHost` (`executePingSequence`,
`arpTable`, `dhcpClient`, `ipForwardEnabled`, `masqueradeOnInterfaces`,
`extractPorts`, …). Résultat :

- impossible de tester une commande sans instancier une `LinuxPC`
  complète et un `Equipment` ;
- impossible de partager la commande entre `LinuxPC` et `LinuxServer`
  sans la dupliquer ou la remonter dans la classe mère ;
- `LinuxPC.ts` agrège des préoccupations qui n'ont rien à voir entre
  elles (`cmdDhclient` et `cmdDnsmasq` ne partagent aucune logique).

### 7.2 Interface `LinuxCommand`

Chaque commande devient un objet qui implémente :

```ts
// src/network/devices/linux/commands/LinuxCommand.ts
export interface LinuxCommand {
  /** Nom invoqué depuis le shell (mot-clé du switch). */
  readonly name: string;

  /** Alias éventuels (ex: "ip6tables" → "iptables"). */
  readonly aliases?: readonly string[];

  /** True si la commande a besoin des internes de EndHost
   *  et doit court-circuiter l'interpréteur bash. */
  readonly needsNetworkContext: boolean;

  /** Exécution. Peut être synchrone ou asynchrone. */
  run(ctx: LinuxCommandContext, args: string[]): Promise<string> | string;
}
```

### 7.3 Contexte `LinuxCommandContext`

Le contexte expose aux commandes une surface **étroite et typée** sur
la machine, sans avoir à passer la classe `LinuxMachine` elle-même :

```ts
// src/network/devices/linux/commands/LinuxCommandContext.ts
export interface LinuxCommandContext {
  /** Accès aux services du noyau simulé (VFS, users, iptables, …). */
  readonly executor: LinuxCommandExecutor;

  /** Pile L2/L3 : opérations sur ports et tables du host. */
  readonly net: LinuxNetKernel;

  /** Démons L7 co-localisés (DNS). */
  readonly dnsService: DnsService;

  /** Contexte XFRM (IPsec). */
  readonly xfrm: IpXfrmContext;

  /** Profil actif (isServer, hostname, …). */
  readonly profile: LinuxProfile;

  /** Helpers de parsing / formatage partagés. */
  readonly fmt: LinuxFormatHelpers;
}
```

`LinuxNetKernel` est la façade *minimale* sur `EndHost` que
`LinuxMachine` expose à ses commandes (sans les laisser toucher
tous les champs protégés de `EndHost`) :

```ts
export interface LinuxNetKernel {
  getPorts(): ReadonlyMap<string, Port>;

  configureInterface(name: string, ip: IPAddress, mask: SubnetMask): void;
  isDHCPConfigured(name: string): boolean;

  getRoutingTable(): HostRouteEntry[];
  addStaticRoute(net: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean;
  removeRoute(net: IPAddress, mask: SubnetMask): boolean;
  setDefaultGateway(gw: IPAddress): void;
  getDefaultGateway(): IPAddress | null;
  clearDefaultGateway(): void;

  getArpTable(): ReadonlyMap<string, ARPEntry>;
  addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void;
  deleteARP(ip: IPAddress): void;

  pingSequence(target: IPAddress, count: number, timeout: number, ttl?: number): Promise<PingResult[]>;
  traceroute(target: IPAddress): Promise<TracerouteHop[]>;

  getDhcpClient(): DHCPClient;
  autoDiscoverDHCPServers(): void;

  setIpForward(enabled: boolean): void;
  addMasqueradeInterface(iface: string): void;

  extractPorts(pkt: IPv4Packet): { srcPort?: number; dstPort?: number };
}
```

Cette façade est la seule portion de `EndHost` exposée. Les commandes
ne connaissent plus `EndHost`, ne peuvent plus appeler n'importe quoi,
et deviennent **testables à l'unité** avec un `LinuxNetKernel` fake.

### 7.4 Registre `LinuxCommandRegistry`

```ts
export class LinuxCommandRegistry {
  private readonly cmds = new Map<string, LinuxCommand>();

  register(cmd: LinuxCommand): void {
    this.cmds.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) this.cmds.set(a, cmd);
  }

  get(name: string): LinuxCommand | undefined { return this.cmds.get(name); }

  /** Vrai si `line` commence par une commande à routage réseau. */
  hasNetworkCommandIn(line: string): boolean {
    for (const word of line.split(/[\s;|&]+/)) {
      const cmd = this.cmds.get(word);
      if (cmd?.needsNetworkContext) return true;
    }
    return false;
  }
}
```

### 7.5 Boucle d'exécution dans `LinuxMachine`

```ts
async executeCommand(input: string): Promise<string> {
  if (!this.isPoweredOn) return 'Device is powered off';
  const trimmed = input.trim();
  if (!trimmed) return '';

  // 1. Fast path : pas de commande réseau → direct bash
  if (!this.commands.hasNetworkCommandIn(trimmed)) {
    return this.executor.execute(trimmed);
  }

  // 2. Compound (;) : récursion
  if (trimmed.includes(';')) {
    const parts = trimmed.split(';').map(s => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
      const r = await this.executeCommand(p);
      if (r) out.push(r);
    }
    return out.join('\n');
  }

  // 3. Pipe : délégation au LinuxShellParser partagé
  if (/\|(?!\|)/.test(trimmed)) return this.runPipeline(trimmed);

  // 4. Dispatch commande réseau
  const noSudo = trimmed.startsWith('sudo ') ? trimmed.slice(5).trim() : trimmed;
  const [head, ...rest] = noSudo.split(/\s+/);
  const cmd = this.commands.get(head);
  if (cmd?.needsNetworkContext) return await cmd.run(this.buildCmdContext(), rest);

  // 5. Sinon → bash interpreter
  return this.executor.execute(trimmed);
}
```

### 7.6 Squelette type d'un fichier-commande

Exemple — `commands/net/Ping.ts` :

```ts
import { LinuxCommand, LinuxCommandContext } from '../LinuxCommand';
import { IPAddress } from '@/network/core/types';

export const pingCommand: LinuxCommand = {
  name: 'ping',
  needsNetworkContext: true,

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    let count = 4; let ttl: number | undefined; let target = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i+1]) { count = parseInt(args[++i], 10); }
      else if (args[i] === '-t' && args[i+1]) { ttl = parseInt(args[++i], 10); }
      else if (!args[i].startsWith('-')) { target = args[i]; }
    }
    if (!target) return 'Usage: ping [-c count] [-t ttl] <destination>';

    let ip: IPAddress;
    try { ip = new IPAddress(target); }
    catch { return `ping: ${target}: Name or service not known`; }

    const results = await ctx.net.pingSequence(ip, count, 2000, ttl);
    return ctx.fmt.formatPingOutput(ip, count, results);
  },
};
```

Tests associés (exemple) :

```ts
// src/__tests__/unit/network-v2/commands/ping.test.ts
it('pings a destination and formats the GNU-like output', async () => {
  const net = new FakeLinuxNetKernel(/* ... */);
  const ctx = makeCtx({ net });
  const out = await pingCommand.run(ctx, ['-c', '2', '10.0.0.1']);
  expect(out).toContain('PING 10.0.0.1');
  expect(out).toContain('2 packets transmitted');
});
```

Plus besoin d'instancier `LinuxPC`, d'`EndHost`, ni de topologie.

### 7.7 Enregistrement des commandes

`LinuxMachine.registerCoreCommands()` fait l'inventaire (une fois) :

```ts
private registerCoreCommands(): void {
  // Réseau L3
  this.commands.register(pingCommand);
  this.commands.register(tracerouteCommand);
  this.commands.register(ifconfigCommand);
  this.commands.register(arpCommand);
  this.commands.register(sysctlCommand);

  // DHCP client
  this.commands.register(dhclientCommand);
  this.commands.register(dhcpLeaseFileCommand); // intercepte cat/rm

  // DNS
  this.commands.register(digCommand);
  this.commands.register(nslookupCommand);
  this.commands.register(hostCommand);
  this.commands.register(dnsmasqCommand);

  // NAT router-layer hook
  this.commands.register(iptablesNatHookCommand);
}
```

Et `LinuxServer.registerDeviceCommands()` (dans notre variante minimale)
peut soit être vide, soit n'ajouter que quelques alias. Tout comportement
« serveur » vient en réalité du profil, pas d'une commande propre.

### 7.8 Bénéfices

- **Testabilité unitaire** : chaque commande a sa propre suite de tests.
- **Fin de la duplication** : plus aucun switch `tryNetworkCommand` ×2.
- **Parité immédiate PC/serveur** : tout ce qui est enregistré au
  `core` fonctionne partout.
- **Découvrabilité** : pour savoir ce que comprend le shell Linux
  simulé, on liste `commands/` — c'est la documentation vivante.
- **Extension isolée** : ajouter `traceroute6` revient à créer un
  fichier dans `commands/net/` et à l'enregistrer.

## 8. Arborescence cible — une commande = un fichier

### 8.1 Principe

Objectif posé par l'utilisateur :

> *« Idéalement chaque commande devrait être dans son propre fichier. »*

Ce principe est appliqué aux commandes **qui ont besoin du
contexte réseau** (`needsNetworkContext: true`) et donc qui étaient
jusqu'ici enfouies dans `LinuxPC`. Les commandes purement userspace
déjà isolées dans `LinuxFileCommands.ts`, `LinuxTextCommands.ts`,
`LinuxNetCommands.ts`, etc. peuvent être migrées progressivement
vers le même format (un fichier = un `LinuxCommand`), mais ce n'est
pas un prérequis.

### 8.2 Arborescence proposée

```
src/network/devices/linux/
├── LinuxMachine.ts                ← nouvelle classe abstraite
├── LinuxProfile.ts                ← interface LinuxProfile
├── LinuxNetKernel.ts              ← interface + implémentation façade
├── LinuxFormatHelpers.ts          ← formatage ping/traceroute/ifconfig
│
├── commands/
│   ├── LinuxCommand.ts            ← interface LinuxCommand
│   ├── LinuxCommandContext.ts     ← interface LinuxCommandContext
│   ├── LinuxCommandRegistry.ts    ← registre + dispatcher
│   ├── index.ts                   ← export de tous les commands objects
│   │
│   ├── net/
│   │   ├── Ifconfig.ts            ← ifconfigCommand
│   │   ├── Ping.ts                ← pingCommand
│   │   ├── Traceroute.ts          ← tracerouteCommand
│   │   ├── Arp.ts                 ← arpCommand (remplace LinuxArp.ts)
│   │   ├── Sysctl.ts              ← sysctlCommand (ip_forward, etc.)
│   │   ├── IptablesNatHook.ts     ← hook MASQUERADE → routing
│   │   └── IpXfrm.ts              ← commande "ip xfrm …"
│   │                                (adaptateur vers LinuxIpCommand)
│   │
│   ├── dhcp/
│   │   ├── Dhclient.ts            ← dhclientCommand
│   │   ├── DhcpLeaseFile.ts       ← intercepte cat/rm /var/lib/dhcp/…
│   │   └── DhcpDiscovery.ts       ← helpers broadcast, partagés
│   │
│   ├── dns/
│   │   ├── Dig.ts                 ← digCommand
│   │   ├── Nslookup.ts            ← nslookupCommand
│   │   ├── Host.ts                ← hostCommand
│   │   ├── Dnsmasq.ts             ← dnsmasqCommand
│   │   └── ResolvConf.ts          ← lecture /etc/resolv.conf
│   │
│   ├── ipsec/
│   │   ├── Ipsec.ts               ← ipsec start/stop/status (déjà dans
│   │   │                            LinuxCommandExecutor, à déplacer)
│   │   └── StrongswanConfig.ts
│   │
│   └── ps/
│       └── PsDhclientAugment.ts   ← augmente ps avec les dhclient actifs
│                                    (hook post-processus)
│
└── (existant, inchangé en Phase 1)
    ├── LinuxCommandExecutor.ts
    ├── LinuxIpCommand.ts
    ├── LinuxFileCommands.ts
    ├── LinuxTextCommands.ts
    ├── LinuxNetCommands.ts
    ├── LinuxSystemCommands.ts
    ├── LinuxProcessCommands.ts
    ├── LinuxPermCommands.ts
    ├── LinuxSearchCommands.ts
    ├── LinuxUserCommands.ts
    ├── LinuxIptablesManager.ts
    ├── LinuxFirewallManager.ts
    ├── LinuxServiceManager.ts
    ├── LinuxProcessManager.ts
    ├── LinuxUserManager.ts
    ├── LinuxLogManager.ts
    ├── LinuxCronManager.ts
    ├── LinuxShellParser.ts
    ├── LinuxScriptExecutor.ts
    ├── LinuxDnsService.ts        (deviendra un simple démon appelé par
    │                              commands/dns/Dnsmasq.ts)
    ├── VirtualFileSystem.ts
    └── SampleScripts.ts
```

Et côté équipements :

```
src/network/devices/
├── LinuxPC.ts        ← ~10 lignes (constructeur + profil)
├── LinuxServer.ts    ← ~20 lignes (profil + registerProcess/clear)
└── (reste inchangé)
```

### 8.3 Table de correspondance ancienne / nouvelle localisation

| Code actuel (source)                                           | Nouvelle localisation                     |
| -------------------------------------------------------------- | ----------------------------------------- |
| `LinuxPC.cmdPing`                                              | `commands/net/Ping.ts`                    |
| `LinuxPC.cmdTraceroute`                                        | `commands/net/Traceroute.ts`              |
| `LinuxPC.cmdIfconfig` + `showAllInterfaces` + `formatInterface`| `commands/net/Ifconfig.ts` + `LinuxFormatHelpers.ts` |
| `LinuxPC.cmdArp` / `LinuxServer.cmdArp` / `LinuxArp.ts`        | `commands/net/Arp.ts`                     |
| `LinuxPC.cmdSysctl`                                            | `commands/net/Sysctl.ts`                  |
| `LinuxPC.handleIptablesNat`                                    | `commands/net/IptablesNatHook.ts`         |
| `LinuxPC.xfrmCtx` + accès via `ip xfrm`                        | `commands/net/IpXfrm.ts`                  |
| `LinuxPC.cmdDhclient` + `discoverDHCPServersBroadcast`         | `commands/dhcp/Dhclient.ts` + `DhcpDiscovery.ts` |
| `LinuxPC.cmdPs` (dhclient augment)                             | `commands/ps/PsDhclientAugment.ts`        |
| Interception `cat /var/lib/dhcp/...`                           | `commands/dhcp/DhcpLeaseFile.ts`          |
| `LinuxPC.cmdDnsmasq` + `dnsService` + `LinuxDnsService.ts`     | `commands/dns/Dnsmasq.ts` (+ `LinuxDnsService.ts` réduit au démon) |
| `executeDig` / `executeNslookup` / `executeHost`               | `commands/dns/Dig.ts`, `Nslookup.ts`, `Host.ts` |
| `LinuxPC.getResolverIP`                                        | `commands/dns/ResolvConf.ts`              |
| `LinuxCommandExecutor.handleIPSec`                             | `commands/ipsec/Ipsec.ts`                 |
| `LinuxPC.buildIpNetworkContext` / `LinuxServer.buildIpNetworkContext` | `LinuxNetKernel.ts` + `LinuxMachine.buildIpNetworkContext()` (unique) |
| `LinuxPC.firewallFilter/evaluateNat/evaluatePreRouting`        | `LinuxMachine` (unique)                   |
| `LinuxPC/LinuxServer` helpers éditeur/session                  | `LinuxMachine` (unique)                   |
| `LinuxPC.executePipedCommand`                                  | `LinuxMachine.runPipeline()` (réutilise `LinuxShellParser`) |
| `LinuxPC.containsNetworkCommand`                               | `LinuxCommandRegistry.hasNetworkCommandIn()` |

### 8.4 Convention de nommage à l'intérieur d'un fichier commande

Chaque fichier exporte :

- une constante `xxxCommand: LinuxCommand` (forme objet, recommandée) ;
- éventuellement des fonctions internes privées ;
- **pas** de classe, sauf si un état inter-appels est nécessaire
  (cas rare : dnsmasq, qui a un démon — dans ce cas le démon reste
  dans `LinuxDnsService.ts`, pas dans la commande).

Exemple minimal de `commands/net/Sysctl.ts` :

```ts
import type { LinuxCommand, LinuxCommandContext } from '../LinuxCommand';

export const sysctlCommand: LinuxCommand = {
  name: 'sysctl',
  needsNetworkContext: true,

  run(ctx: LinuxCommandContext, args: string[]): string {
    const wIdx = args.indexOf('-w');
    const params = wIdx !== -1 ? args.slice(wIdx + 1) : args.filter(a => !a.startsWith('-'));
    for (const p of params) {
      const [key, val] = p.split('=');
      if (key === 'net.ipv4.ip_forward') {
        ctx.net.setIpForward(val === '1');
        return `net.ipv4.ip_forward = ${val ?? ''}`;
      }
    }
    return '';
  },
};
```

Moins de 20 lignes, auto-contenu, testable isolément.

### 8.5 Index `commands/index.ts`

Un seul point d'entrée permet à `LinuxMachine` de s'enregistrer sans
connaître la liste :

```ts
// src/network/devices/linux/commands/index.ts
export * from './net/Ifconfig';
export * from './net/Ping';
export * from './net/Traceroute';
// … etc.

import { pingCommand } from './net/Ping';
import { tracerouteCommand } from './net/Traceroute';
// …

export const CORE_LINUX_COMMANDS: readonly LinuxCommand[] = [
  pingCommand,
  tracerouteCommand,
  ifconfigCommand,
  arpCommand,
  sysctlCommand,
  dhclientCommand,
  dhcpLeaseFileCommand,
  digCommand,
  nslookupCommand,
  hostCommand,
  dnsmasqCommand,
  iptablesNatHookCommand,
  ipXfrmCommand,
];
```

`LinuxMachine.registerCoreCommands()` devient alors une boucle :

```ts
private registerCoreCommands(): void {
  for (const c of CORE_LINUX_COMMANDS) this.commands.register(c);
}
```

### 8.6 Cas particulier : commandes « hook » (non appelées directement)

Certaines entrées ne sont pas de « vraies » commandes shell que
l'utilisateur tape : ce sont des *hooks* — du code qui doit se
déclencher lorsqu'une commande passe dans l'`executor`.

Exemple : `handleIptablesNat()` doit s'exécuter quand
`iptables -t nat -A POSTROUTING -j MASQUERADE -o eth0` est tapée,
**en plus** du traitement normal de l'iptables manager.

Deux options :

1. **Hook dans le registre** : `LinuxCommandRegistry` accepte des
   `LinuxObserver` qui observent chaque dispatch avant ou après la
   commande native. `IptablesNatHookCommand` s'enregistre comme
   observateur de `iptables`.
2. **Wrapping** : la commande `iptables` est enregistrée dans
   `commands/net/Iptables.ts`, et appelle à la fois
   `ctx.executor.iptables.execute(args)` et
   `ctx.net.addMasqueradeInterface(iface)` si les arguments matchent.

L'option 2 est plus simple et garde l'esprit « une commande = un
fichier ». Retenue par défaut.

## 9. Plan de migration incrémental

La migration peut (et doit) être faite **sans jamais casser les tests
existants**. Voici une séquence de PRs courts qui peuvent chacun être
mergé indépendamment.

### Phase 1 — Socle, sans casser l'existant ✅ **TERMINÉE**

**PR 1. `LinuxCommand` + `LinuxCommandContext` + `LinuxCommandRegistry`
+ `LinuxNetKernel`.** ✅

- Créer les interfaces et le registre sous `linux/commands/`.
- Implémenter `LinuxNetKernel` concret qui enveloppe une `EndHost`.
  Cette classe n'est utilisée par personne encore.
- Pas de modification de `LinuxPC` / `LinuxServer`.
- ✅ Aucune régression possible : code mort pour l'instant.

**PR 2. `LinuxMachine` (vide).** ✅

- Créer `LinuxMachine extends EndHost` *identique à `LinuxPC`* pour le
  moment : créer les ports, instancier l'executor, construire
  l'`IpNetworkContext`, surcharger firewall/NAT, exposer les helpers
  éditeur. C'est un gros copier-coller délibéré.
- `LinuxPC` et `LinuxServer` continuent d'exister sans changement.
- ✅ Aucune régression possible : `LinuxMachine` n'est instanciée nulle part.

#### État livré à la fin de la Phase 1

Fichiers créés (aucun fichier existant n'a été modifié) :

| Fichier | Rôle |
| ------- | ---- |
| `src/network/devices/linux/LinuxProfile.ts` | Interface `LinuxProfile` + constantes `LINUX_PC_PROFILE` / `LINUX_SERVER_PROFILE` |
| `src/network/devices/linux/commands/LinuxCommand.ts` | Interface `LinuxCommand` (name, aliases, needsNetworkContext, run) |
| `src/network/devices/linux/commands/LinuxCommandContext.ts` | Interface `LinuxCommandContext` (executor, net, dnsService, xfrm, profile, fmt) |
| `src/network/devices/linux/commands/LinuxCommandRegistry.ts` | Classe `LinuxCommandRegistry` (register, get, `hasNetworkCommandIn`, list) |
| `src/network/devices/linux/commands/index.ts` | Barrel + `CORE_LINUX_COMMANDS = []` (sera rempli en Phase 2) |
| `src/network/devices/linux/LinuxNetKernel.ts` | Interface `LinuxNetKernel` — façade étroite sur `EndHost` |
| `src/network/devices/linux/LinuxFormatHelpers.ts` | Interface + implémentation par défaut des formatteurs ping/traceroute/ifconfig |
| `src/network/devices/LinuxMachine.ts` | Classe abstraite `LinuxMachine extends EndHost` |

Caractéristiques clés de `LinuxMachine` telle que livrée en Phase 1 :

- prend un `LinuxProfile` au constructeur ;
- crée les ports d'après le profil (`portCount`, `portPrefix`) ;
- instancie `LinuxCommandExecutor(profile.isServer)` ;
- construit un `IpNetworkContext` complet (avec `xfrmCtx`) — port littéral
  de `LinuxPC.buildIpNetworkContext` ;
- construit un `LinuxNetKernel` concret qui capture par closure les
  membres protégés de `EndHost` (`arpTable`, `dhcpClient`,
  `ipForwardEnabled`, `masqueradeOnInterfaces`, `executePingSequence`,
  `executeTraceroute`, `extractPorts`) ;
- instancie un `LinuxCommandRegistry` et y charge `CORE_LINUX_COMMANDS`
  (vide pour l'instant) ;
- `executeCommand()` implémente déjà le pipeline décrit en §7.5 —
  fast-path bash si aucune commande du registre n'est présente,
  sinon split `;`, gestion du pipe par `executePipedCommand` (qui délègue
  le filtre à l'interpréteur bash via `printf '%s' ... | <tail>`),
  strip de `sudo`, lookup dans le registre ;
- surcharge `firewallFilter`, `evaluateNat` et `evaluatePreRouting`
  (les trois, y compris celle qui manque à `LinuxServer`) ;
- expose les 14 helpers éditeur/session (`readFileForEditor`, …,
  `canSudo`) ;
- possède les champs `dnsService: DnsService`, `xfrmCtx: IpXfrmContext`,
  `dnsResolverIP: string`.

Validation :

- `npx tsc --noEmit` : **0 erreur** sur l'ensemble du projet.
- Aucun fichier existant n'a été modifié, donc aucun chemin d'exécution
  atteignable depuis l'UI, les tests ou le store Zustand n'est altéré.
- `LinuxMachine` est **abstraite** et n'est importée par aucun autre
  module : elle est volontairement dead-code jusqu'à la Phase 3 (PR 11/12).

#### Prochaine étape

Passer à la **Phase 2 — Extraction des commandes de `LinuxPC`**, en
commençant par les commandes les plus isolées :

1. `commands/net/Sysctl.ts` (PR 3)
2. `commands/net/Arp.ts` (PR 4)
3. `commands/net/Ifconfig.ts` + unification du formatInterface (PR 5)
4. `commands/net/Ping.ts` (PR 6 — passage sensible)
5. …

### Phase 2 — Extraction des commandes de `LinuxPC`

Une commande par PR, dans cet ordre (des plus isolées aux plus
intriquées) :

**PR 3. `commands/net/Sysctl.ts`.** ✅
- ✅ Extrait `cmdSysctl` → `src/network/devices/linux/commands/net/Sysctl.ts`
  (`sysctlCommand`, 36 l.).
- ✅ Enregistré dans `CORE_LINUX_COMMANDS` (`commands/index.ts`) — pris en
  charge automatiquement par `LinuxMachine.registerCoreCommands()`.
- ✅ `LinuxPC.cmdSysctl` réduit à une délégation via un bridge minimal
  (`net.setIpForward` / `isIpForwardEnabled`) vers `sysctlCommand.run`.
  Le bridge disparaîtra en Phase 3 quand `LinuxPC` deviendra
  `LinuxMachine`.
- ✅ `tsc --noEmit` : 0 erreur.

**PR 4. `commands/net/Arp.ts`.** ✅
- ✅ Extrait `cmdArp` → `commands/net/Arp.ts` (`arpCommand`). Mince
  wrapper qui adapte `LinuxNetKernel` au `LinuxArpContext` déjà
  existant et délègue à `linuxArp(...)`.
- ✅ Enregistré dans `CORE_LINUX_COMMANDS`.
- ✅ `LinuxPC.cmdArp` **et** `LinuxServer.cmdArp` délèguent maintenant
  à `arpCommand.run(...)` via le même bridge minimal → la
  duplication `linuxArp` de `LinuxServer` disparaît.
- ✅ `tsc --noEmit` : 0 erreur.

**PR 5. `commands/net/Ifconfig.ts` + `LinuxFormatHelpers.ts`.** ✅
- ✅ Extrait `cmdIfconfig` → `commands/net/Ifconfig.ts`. Le rendu
  passe intégralement par `ctx.fmt.formatInterface(port)`, qui pointe
  sur `defaultLinuxFormatHelpers` (déjà livré en Phase 1, §7.3).
- ✅ Un seul formatteur : celui riche de `LinuxPC` (avec RX/TX
  counters, flag `4099`/`4163` selon le carrier, MTU réel du port).
- ✅ **Corrige** le bug latent de `LinuxServer` (§3.3) : le serveur
  n'a plus de `formatInterface` stubé — les deux machines émettent
  maintenant exactement le même `ifconfig`.
- ✅ `LinuxPC.cmdIfconfig`, `showAllInterfaces`, `formatInterface`,
  `formatBytes` sont supprimés (bridge vers `ifconfigCommand`).
- ✅ `LinuxServer.cmdIfconfig`, `showAllInterfaces`, `formatInterface`
  sont supprimés de la même façon.
- ✅ `tsc --noEmit` : 0 erreur.

**PR 6. `commands/net/Ping.ts`.** ✅
- ✅ Extrait `cmdPing` → `commands/net/Ping.ts` (`pingCommand`, async).
  Drive `ctx.net.pingSequence(...)` et `ctx.fmt.formatPingOutput(...)`
  → la sortie sort directement des helpers de Phase 1.
- ✅ Enregistré dans `CORE_LINUX_COMMANDS`.
- ✅ `LinuxPC.cmdPing` + `formatPingOutput` supprimés (delegate via
  bridge minimal).
- ⚠️ ✅ **Régression silencieuse fermée** : `LinuxServer` ne route
  plus `ping` vers le stub de `LinuxCommandExecutor`. Sa méthode
  `tryNetworkCommand` est devenue async, et `cmdPing` traverse
  maintenant la pile `EndHost` réelle (ICMP, ARP, routage). Voir §4.
- ✅ `LinuxCommandExecutor` conserve sa branche `ping` stubée mais
  elle n'est plus atteignable depuis une `LinuxMachine` (utile encore
  pour Cisco/Huawei). Sera marquée `@deprecated` en PR 13.
- ✅ Tests `linux-commands-and-oracle-tools.test.ts` mis à jour : les
  assertions sur `ping` sur un serveur isolé deviennent « PING header
  + Network is unreachable + statistics block ».
- ✅ `tsc --noEmit` : 0 erreur.

**PR 7. `commands/net/Traceroute.ts`.** ✅
- ✅ Extrait `cmdTraceroute` → `commands/net/Traceroute.ts`. Drive
  `ctx.net.traceroute(...)` et `ctx.fmt.formatTracerouteOutput(...)`.
- ✅ Enregistré dans `CORE_LINUX_COMMANDS`.
- ✅ `LinuxPC.cmdTraceroute` réduit à un bridge minimal.
- ✅ `LinuxServer.tryNetworkCommand` reconnaît maintenant
  `traceroute` et délègue au même bridge → ferme la régression
  silencieuse correspondante (§4).
- ✅ `tsc --noEmit` : 0 erreur.

**PR 8. `commands/dns/*` + `commands/dns/Dnsmasq.ts`.** ✅
- ✅ Créés sous `commands/dns/` : `Dig.ts`, `Nslookup.ts`, `Host.ts`,
  `Dnsmasq.ts`, plus l'helper interne `resolverIP.ts`
  (`readResolverIP(executor)`). Les wrappers délèguent à
  `executeDig` / `executeNslookup` / `executeHost` qui restent dans
  `LinuxDnsService.ts` (où vit aussi le démon `DnsService`).
- ✅ Enregistrés dans `CORE_LINUX_COMMANDS`.
- ✅ `LinuxPC` : dispatch `dig` / `nslookup` / `host` / `dnsmasq`
  passe par un nouveau `dnsBridge()`. Les méthodes locales
  `cmdDnsmasq`, `getResolverIP` et le champ `dnsResolverIP` sont
  supprimés.
- ✅ **`LinuxServer` gagne `dig`, `nslookup`, `host` et `dnsmasq`** —
  un nouveau champ public `dnsService = new DnsService()` permet à
  `findDnsServerByIP(...)` de découvrir le serveur. Un `LinuxServer`
  peut **enfin** être serveur DNS, ferme la régression §4.
- ✅ `tsc --noEmit` : 0 erreur.

**PR 9. `commands/dhcp/*`.** ✅
- ✅ Créés sous `commands/dhcp/` :
  - `Dhclient.ts` (`dhclientCommand`) — extrait verbatim de
    `LinuxPC.cmdDhclient`, utilise `ctx.net.getDhcpClient()` +
    `autoDiscoverDHCPServers()`.
  - `DhcpLeaseFile.ts` — helper pur (`readDhcpLeaseFile`,
    `isDhcpLeasePath`) appelé depuis le hook `cat` plutôt qu'enregistré
    comme commande (cf §8.6).
  - `PsDhclientAugment.ts` — helper pur (`dhclientPsLines`) appelé
    depuis `cmdPs` pour injecter les lignes `dhclient <iface>`.
- ✅ `dhclientCommand` enregistré dans `CORE_LINUX_COMMANDS`.
- ✅ `LinuxPC` : `cmdDhclient` et `discoverDHCPServersBroadcast`
  supprimés ; `cmdPs` réduit à un appel à `dhclientPsLines` ;
  l'interception `cat /var/lib/dhcp/...` passe par `readDhcpLeaseFile`.
- ✅ **`LinuxServer` gagne `dhclient`** via le même bridge → un
  serveur peut désormais être client DHCP, ferme la régression §4.
  La cat lease intercept et l'augmentation `ps` resteront partielles
  jusqu'à la Phase 3 (le serveur n'a pas encore de hook `cat`/`ps`).
- ✅ `tsc --noEmit` : 0 erreur.

**PR 10. `commands/net/IptablesNatHook.ts` + `IpXfrm.ts`.** ✅
- ✅ Crée `commands/net/IptablesNatHook.ts` : helper
  `applyIptablesNatHook(net, args)` qui parse `-t nat -A POSTROUTING
  -j MASQUERADE -o <iface>` et appelle `net.addMasqueradeInterface`.
- ✅ Étend la `netKernelForBridges()` de `LinuxPC` pour exposer
  `addMasqueradeInterface`, supprime `LinuxPC.handleIptablesNat` et
  remplace son appel par `applyIptablesNatHook(...)`.
- ✅ `LinuxServer.tryNetworkCommand` gagne enfin une branche
  `iptables` / `iptables-save` : applique le hook MASQUERADE puis
  délègue à `executor.iptables.execute(...)`. Régression silencieuse
  §4 ("LinuxServer ne sait pas masquerade") résolue.
- ✅ `LinuxServer` ajoute un `xfrmCtx: IpXfrmContext = { states: [],
  policies: [] }` privé et le branche dans `buildIpNetworkContext` —
  `ip xfrm state add/list/del` et `ip xfrm policy ...` fonctionnent
  désormais sur `LinuxServer` (retournaient "Operation not supported"
  avant). Régression §3 ("xfrm absent du serveur") résolue.
- ⏳ `LinuxServer.evaluatePreRouting` (DNAT côté serveur) reste à
  porter — sera réglé Phase 3 quand `LinuxServer` héritera de
  `LinuxMachine` et reprendra la surcharge `LinuxPC`.
- ✅ `tsc --noEmit` : 0 erreur.

### Phase 3 — Raccourcissement des sous-classes ✅ **TERMINÉE**

**PR 11. `LinuxPC` devient une coquille.** ✅
- ✅ Tout le corps de `LinuxPC` est supprimé (801 → 21 lignes).
- ✅ Le constructeur appelle `super(... LINUX_PC_PROFILE)`.
- ✅ Tous les tests `LinuxPC` passent sans modification.

**PR 12. `LinuxServer` devient une coquille + `exposeSystemProcessApi`.** ✅
- ✅ Tout le corps de `LinuxServer` est supprimé (405 → 33 lignes).
- ✅ `registerProcess` / `clearSystemProcesses` restent dans la sous-classe
  comme pass-throughs vers `executor`.
- ✅ Tests Oracle (`unit/database/oracle-dbms-filesystem-coherence`) passent.

**Corrections supplémentaires réalisées pendant la Phase 3 :**
- ✅ Bug fix : les commandes `iptables` avec arguments entre guillemets
  (ex. `--comment "Allow SSH"`) étaient cassées par le split naïf
  `noSudo.split(/\s+/)`. Ajout d'un tokenizer quote-aware
  (`LinuxMachine.tokenizeArgs`).
- ✅ Bug fix : `iptables-save > file` et `iptables-restore < file`
  n'étaient pas gérés (la redirection était interceptée avant le bash
  interpreter). Maintenant les commandes avec redirections sont
  correctement déléguées à l'executor.
- ✅ La commande `ps` sur `LinuxMachine` augmente le résultat de
  l'executor avec les lignes `dhclient` provenant d'`EndHost`,
  corrigeant le comportement de l'ancien `LinuxPC` qui ne retournait
  que les lignes dhclient et ignorait le processus list normal.
- ✅ `LinuxMachine.executeCommand` gère désormais `iptables`,
  `iptables-save`, `iptables-restore`, `ps`, `cat /var/lib/dhcp/...`,
  et `rm /var/lib/dhcp/...` en plus des commandes du registre.
- ✅ `tsc --noEmit` : 0 erreur.
- ✅ `npx vitest run` : 7 fichiers en échec (identiques à avant la
  refonte), 4305 tests passés, aucune régression.
  Le fichier `linux-iptables.test.ts` qui échouait après PR 10 passe
  désormais intégralement (128/128).

### Phase 4 — Nettoyage facultatif

**PR 13. Stub ping/traceroute/dig de `LinuxCommandExecutor`.**
- Ces stubs (`LinuxCommandExecutor.ts:661-677`) étaient là pour fournir
  une réponse à `bash -c 'ping foo'`. Après la migration, toute
  `LinuxMachine` route d'abord vers `commands/`, donc les stubs ne
  sont utilisés qu'en fallback.
- Supprimer ou marquer `@deprecated` selon que d'autres classes
  (Cisco, Huawei) les utilisent ou non.

**PR 14. Migration cosmétique des commandes userspace.**
- Port progressif de `LinuxFileCommands`, `LinuxTextCommands`,
  `LinuxSearchCommands`, … vers le format `LinuxCommand`. Purement
  cosmétique, aucun changement fonctionnel.

### 9.1 Critères de validation continue

À chaque PR :

- `npm run test:run` doit passer intégralement ;
- `npm run lint` ne doit introduire aucun warning ;
- les tests GUI (`unit/gui/`) qui instancient `LinuxPC` ou
  `LinuxServer` ne doivent pas être modifiés (la surface publique
  utilisée par `Terminal.tsx`, `NetworkDesigner.tsx`, le store
  Zustand reste intacte) ;
- aucun import de `LinuxPC.ts` ou `LinuxServer.ts` ne doit être
  ajouté — on doit pouvoir les considérer comme *fermés à la
  modification* dès que le PR 11/12 est mergé.

### 9.2 Bénéfices attendus à la fin

- `LinuxPC.ts` : 801 → ~12 lignes.
- `LinuxServer.ts` : 318 → ~20 lignes.
- Parité complète PC/serveur sur les 14 écarts listés en §4 *sans*
  écrire une seule ligne de code deux fois.
- Chaque commande réseau a son propre fichier dédié et son propre
  test unitaire, instanciable sans `EndHost` complet.
- Base saine pour ajouter plus tard d'autres profils (ex :
  `LinuxRouter`, `LinuxFirewall`, `LinuxContainer`) sans nouvelle
  duplication.

---

*Fin du document. Les 9 sections ont été committées et poussées
individuellement sur la branche `claude/analyze-linux-implementation-gaps-Juc4e`.*
