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
