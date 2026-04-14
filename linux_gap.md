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
