# PRD — iptables / ip6tables / ufw (pare-feu Linux, filtrage et NAT)

**Version** : 1.0
**Date** : 2026-07-07
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- `iptables(8)`, `ip6tables(8)`, `iptables-extensions(8)` (modules `-m state`/
  `-m conntrack`/`-m multiport`/`-m limit`/`-m iprange`/`-m mac`)
- `ufw(8)`, documentation Ubuntu *UncomplicatedFirewall* (architecture
  frontend-sur-iptables, chaînes `ufw-before-*`/`ufw-user-*`/`ufw-after-*`,
  fichiers `/etc/ufw/*.rules`, `/etc/ufw/ufw.conf`, `/etc/ufw/applications.d/*`)
- `iptables-persistent`/`netfilter-persistent(8)` (persistance des règles
  brutes hors ufw, via `/etc/iptables/rules.v4`/`rules.v6`)
- `systemd.service(5)`, `systemctl(1)` — modèle de service déjà couvert par
  `docs/PRD-Systemd.md`, consommé ici sans être redéfini (cf. §0.1)
- RFC 9293 (TCP), déjà couvert par `docs/PRD-TCP.md` — le pare-feu s'intercale
  en amont de cette pile, ne la redéfinit pas

---

## 0. Contexte et portée du document

Ce PRD documente **le pare-feu Linux simulé dans son ensemble** : le moteur
`iptables`/`ip6tables` (tables filter/nat/mangle/raw, chaînes, correspondance,
cibles), `ufw` en tant que frontend sur ce même moteur, et — c'est la
demande explicite motivant ce document — **la cohérence de cet ensemble
avec trois autres sous-systèmes déjà simulés** : le modèle de **processus**
(la pile TCP/UDP et `SocketTable`, déjà largement solides et documentées
dans `docs/PRD-TCP.md`), le modèle de **service** (systemd, déjà couvert par
`docs/PRD-Systemd.md`), et le **système de fichiers virtuel** (VFS, où
résident `/etc/ufw/*`, `/etc/iptables/*`). Un pare-feu qui filtre
correctement les paquets mais dont l'état est déconnecté de ces trois
sous-systèmes produirait un simulateur incohérent : un `systemctl stop ufw`
qui ne coupe rien, un fichier de config édité à la main qui n'a aucun effet,
un redémarrage qui ne recharge rien depuis le disque.

Cette analyse est issue d'une lecture complète de
`src/network/devices/linux/LinuxIptablesManager.ts` (1207 lignes — moteur
`iptables`/`ip6tables`), `src/network/devices/linux/LinuxFirewallManager.ts`
(1361 lignes — `ufw`), `src/network/devices/linux/commands/net/IptablesNatHook.ts`,
la surface CLI dans `src/network/devices/LinuxMachine.ts` et
`src/network/devices/linux/LinuxCommandExecutor.ts`, les hooks
`firewallFilter`/`firewallFilter6`/`evaluateNat`/`evaluatePreRouting` de
`src/network/devices/EndHost.ts`, le modèle de service
`src/network/devices/linux/LinuxServiceManager.ts` et son unité `ufw`
(oneshot), les fichiers statiques du VFS
(`src/network/devices/linux/VirtualFileSystem.ts`), l'intégration fail2ban
(`src/network/protocols/ssh/security/Fail2banAgent.ts`), et de `GAP.md` §1.9
(qui documente une partie de l'asymétrie IPv4/IPv6, désormais partiellement
obsolète — voir §1.3 item 7).

### 0.1 Relation avec les autres PRD de ce dépôt

Contrairement au trio VLAN/802.1Q/VTP, ce PRD ne s'insère pas dans une
chaîne de dépendances *bloquantes* entre documents à écrire — les trois
sous-systèmes avec lesquels la cohérence est visée (`docs/PRD-TCP.md`,
`docs/PRD-Systemd.md`, et le VFS, sans PRD dédié) sont **déjà largement
implémentés et fonctionnels**. La relation est donc d'**intégration**, pas
de séquencement :

```
docs/PRD-TCP.md (RFC 9293, déjà implémenté)         docs/PRD-Systemd.md (déjà implémenté)
   │  la pile TCP/UDP existe et fonctionne ;            │  moteur de jobs/unités, systemctl,
   │  le pare-feu s'intercale EN AMONT d'elle           │  cycle de reboot déjà réels
   │  (déjà correct pour l'essentiel, cf. §1.2)         │
   ▼                                                     ▼
   └──────────────────┬──────────────────────────────────┘
                       ▼
     PRD-Iptables-UFW.md (iptables/ip6tables/ufw)   ◄── VOUS ÊTES ICI
                       │  doit rester cohérent avec les deux ci-dessus
                       │  ET avec le VFS (fichiers /etc/ufw/*, /etc/iptables/*)
                       ▼
     Aucun PRD consommateur direct dans ce dépôt à ce jour — mais toute
     évolution future d'un rôle serveur exposé (SMB, LDAP, IIS, RADIUS…)
     hérite de la cohérence (ou de l'incohérence) établie ici.
```

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/devices/linux/LinuxIptablesManager.ts` | Moteur `iptables`/`ip6tables` : tables filter/nat/mangle/raw, chaînes, correspondance, cibles, `-save`/`-restore` | 1207 |
| `src/network/devices/linux/LinuxFirewallManager.ts` | `ufw` — frontend déclaré sur `LinuxIptablesManager` (aucun moteur de filtrage propre) | 1361 |
| `src/network/devices/linux/commands/net/IptablesNatHook.ts` | Détection `-t nat -A POSTROUTING -j MASQUERADE` → `LinuxNetKernel.addMasqueradeInterface` | 39 |
| `src/network/devices/EndHost.ts` | Hooks `firewallFilter`/`firewallFilter6`/`evaluateNat`/`evaluatePreRouting`, points d'appel dans `handleIPv4`/`handleIPv6` | 3573 |
| `src/network/devices/LinuxMachine.ts` | Implémentation réelle des hooks `EndHost` → délégation vers `LinuxIptablesManager` ; dispatch CLI « chemin A » (`tryNetworkCommand`) | 2644 |
| `src/network/devices/linux/LinuxCommandExecutor.ts` | Dispatch CLI « chemin B » (switch composite) : `ufw`, `iptables[-save/-restore]` ; **pas de case `ip6tables*`** | — |
| `src/network/devices/linux/LinuxServiceManager.ts` | Unité systemd `ufw` (oneshot, `enabledByDefault: true`) — affichage seul, aucun couplage avec `LinuxFirewallManager` | 1070+ |
| `src/network/devices/linux/VirtualFileSystem.ts` | Fichiers statiques `/etc/ufw/*`, `/etc/iptables/*` initiaux | — |
| `src/network/core/types.ts` | `IPAddress` (IPv4 strict) l. ~93-194 ; `IPv6Address` (l. 262) — **`ip6tables` n'utilise que le premier** | — |
| `src/network/protocols/ssh/security/Fail2banAgent.ts` | Intégration positive : pilote le même moteur iptables réel via `Fail2banIptablesSink` | — |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **`ufw` est un vrai frontend, pas un moteur parallèle, côté IPv4.**
  `ufw enable`/`allow`/`deny`/`delete`/`insert` construisent réellement des
  chaînes `ufw-user-input/output/forward/limit/limit-accept` et des règles
  `IptablesRule` dans le moteur `LinuxIptablesManager` fourni au
  constructeur — le filtrage de paquets n'existe qu'à un seul endroit
  (`filterPacket`/`evaluateNat`), exactement le principe de conception que
  le vrai `ufw` applique.
- **Interception avant la couche transport, conforme au noyau réel.**
  `firewallFilter` est évalué avant tout appel à `TcpStack.handleIp`/
  `deliverUDP` dans `EndHost.handleIPv4` — un SYN bloqué n'atteint jamais le
  socket LISTEN, exactement comme netfilter réel. Testé explicitement
  (`ipv6-tcp-probe-no-shortcircuit.test.ts`, `tcp-connect-outcome.test.ts`) :
  DROP → timeout, REJECT → refused, le socket local reste inchangé (`ss`/
  `netstat` continueraient de le montrer en LISTEN).
- **`conntrack`/`-m state` réel** avec `ESTABLISHED`/`NEW` distingués, et
  simplification documentée `RELATED ≈ ESTABLISHED` (déjà notée dans
  `GAP.md`, assumée, pas un bug caché).
- **`-m limit` réellement branché** dans le chemin de filtrage (pas
  seulement une option d'affichage).
- **`iptables-save`/`iptables-restore`** fonctionnels et testés.
- **`ip6tables` est déjà une instance séparée** de `LinuxIptablesManager`
  (`family: 6`), pas un simple alias — la séparation architecturale
  nécessaire pour une vraie parité IPv6 existe déjà, même si elle n'est pas
  encore exploitée (cf. §1.3).
- **Intégration fail2ban déjà cohérente** : `Fail2banAgent` pilote le même
  moteur iptables réel (pas un mécanisme de ban parallèle) — un exemple
  positif de la cohérence inter-sous-système que ce PRD généralise ailleurs.
- **`firewallFilter6` branché pour TCP/UDP-v6 entrant** (`EndHost.ts:3005`)
  — le constat historique de `GAP.md` §1.9 (« aucun équivalent ip6tables »)
  est désormais partiellement obsolète : seule la branche ICMPv6 reste hors
  chemin (cf. §1.3 item 7).

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| **A. Cohérence service (systemd) — le gap le plus structurant** |||
| 1 | **L'unité systemd `ufw` est un pur affichage, totalement déconnectée de `LinuxFirewallManager`.** `systemctl stop/disable ufw` n'appelle jamais `cmdDisable()` (le pare-feu réel reste actif). `ufw disable` (CLI) n'appelle jamais `serviceMgr.stop('ufw')` (l'unité continue d'afficher son état par défaut). Aucun des `onLifecycle(...)` déjà enregistrés dans `LinuxMachine.ts` ne filtre `name === 'ufw'`. | Comportement Ubuntu réel (le service `ufw` charge/décharge effectivement les règles à `start`/`stop`) | **Critique** |
| 2 | **Le cycle de reboot simulé relance systématiquement l'unité `ufw`** (`enabledByDefault: true`) **indépendamment de l'état réel mémorisé** (`ENABLED=` dans `/etc/ufw/ufw.conf`, ou état en mémoire de `LinuxFirewallManager`). `reboot`/`shutdown` n'appelle jamais `this.firewall`/`this.iptables`/`this.ip6tables`. | Comportement Ubuntu réel (le service au boot lit `/etc/ufw/ufw.conf` avant de décider d'activer le pare-feu) | Majeure |
| **B. Cohérence filesystem (VFS)** |||
| 3 | **Seul `/etc/ufw/ufw.conf` (`ENABLED=`/`LOGLEVEL=`) est jamais relu**, et uniquement via `ufw reload` (jamais au boot, cf. item 2). `/etc/ufw/before.rules`, `/etc/ufw/after.rules`, `/etc/ufw/user.rules`, `/etc/ufw/user6.rules` sont soit purement décoratifs, soit shadow-écrits sans jamais être relus — éditer l'un de ces fichiers à la main dans le VFS n'a **aucun effet observable**, à rebours de leur rôle réel de source de vérité sur Ubuntu. | Comportement Ubuntu réel (`ufw-before-input`/`ufw-after-input` sont des chaînes iptables réellement programmées depuis ces fichiers) | Majeure |
| 4 | **Profils d'application `ufw` : deux sources de vérité disjointes.** `ufw app list`/`info` lisent un objet TS statique (`APP_PROFILES`), jamais les fichiers `/etc/ufw/applications.d/*` réellement présents dans le VFS — créer/modifier un profil applicatif par fichier n'a aucun effet sur `ufw app list`. | Comportement Ubuntu réel (`ufw app list` scanne littéralement `/etc/ufw/applications.d/`) | Moyenne |
| 5 | **`/etc/iptables/rules.v6` n'est jamais écrit**, alors que `/etc/iptables/rules.v4` l'est (comme effet de bord de tout appel à `ufw`, via `executeSave()` sur le moteur v4 uniquement) — asymétrie de persistance directement liée à l'absence de référence `ip6tables` dans `LinuxFirewallManager` (cf. item 8). | Comportement `iptables-persistent` réel (persiste v4 et v6 symétriquement) | Moyenne |
| 6 | **`netfilter-persistent`/`iptables-persistent` totalement absents** : aucune unité systemd, aucune commande `netfilter-persistent save/reload`, aucun mécanisme de persistance pour des règles `iptables` brutes configurées **hors** de `ufw`. Sur Ubuntu réel, c'est le seul moyen de persister des règles `iptables -A ...` posées manuellement (`ufw` a son propre mécanisme, distinct). | Paquet Debian/Ubuntu réel `iptables-persistent` | Moyenne |
| **C. Cohérence processus (TCP/UDP)** |||
| 7 | **ICMPv6 entrant ne passe jamais par `firewallFilter6`** (`EndHost.handleICMPv6`, atteint depuis `handleIPv6` mais hors du branchement `firewallFilter6` qui ne couvre que TCP/UDP-v6) — un `ping6`/une erreur ICMPv6 traverse toujours le pare-feu simulé, contrairement au trafic TCP/UDP-v6 qui, lui, est déjà filtré. | Comportement `ip6tables` réel (chaîne INPUT filtre aussi ICMPv6, avec les exceptions RFC 4890 habituelles) | Majeure |
| 8 | **`--reject-with` est stocké et affiché mais jamais utilisé pour choisir le type d'erreur réellement envoyé côté IPv4** — `sendICMPReject()` envoie toujours *destination-unreachable/admin-prohibited*, quelle que soit la valeur configurée (`icmp-port-unreachable`, `tcp-reset`, etc.). Asymétrie non documentée avec IPv6, où un REJECT sur TCP entrant déclenche bien un vrai RST. | Comportement `iptables` réel (`--reject-with` sélectionne le type d'erreur ICMP ou un RST TCP) | Moyenne |
| 9 | **DROP et REJECT ne sont pas différenciés pour l'UDP sortant** (`OUTPUT`) — les deux retournent simplement un échec, sans que REJECT ne génère l'ICMP *unreachable* localement renvoyé à l'expéditeur comme le ferait un vrai noyau. | Comportement noyau Linux réel | Mineure |
| **D. Parité IPv6 du moteur `ip6tables`** |||
| 10 | **`ip6tables` ne peut matcher aucune adresse/CIDR IPv6.** Le champ `family` n'est jamais lu par `ipMatchesSpec`/`validateIPSpec`, qui reposent uniquement sur `IPAddress` (IPv4 strict, lève une exception sur toute adresse IPv6). `ip6tables -A INPUT -s 2001:db8::1/64 -j DROP` échoue systématiquement à la validation — alors que `IPv6Address` (`core/types.ts:262`) existe déjà et est utilisé ailleurs (NDP/SLAAC). Seuls protocole/port/interface sont aujourd'hui exploitables avec `ip6tables`. | `ip6tables` réel (correspondance CIDR IPv6 complète) | **Critique** |
| 11 | **Aucun NAT66/`evaluateNat6`** — `evaluateNat`/`evaluatePreRouting` dans `LinuxMachine.ts` sont strictement IPv4 ; `ip6tables -t nat` n'a aucun hook de data plane. | `ip6tables -t nat` réel (NAT66/masquerading IPv6, moins fréquent que v4 mais réel) | Moyenne |
| 12 | **`ip6tables-restore` est un point d'entrée mort dans les deux chemins de dispatch CLI** (chemin A délègue sans le traiter, chemin B n'a aucun `case`) — `ip6tables-restore < fichier` échoue systématiquement (« command not found »), alors que `ip6tables-save`/`ip6tables` fonctionnent. | Cohérence interne de la CLI déjà supportée pour IPv4 | Moyenne |
| **E. Cohérence `ufw` ↔ IPv6 — le second gap le plus important** |||
| 13 | **Les règles `ufw` marquées « (v6) » ne sont jamais injectées dans aucun moteur réel.** `setupIptablesChains()`/`rebuildIptablesRules()` filtrent explicitement `if (!rule.v6)`. Elles ne servent qu'à (a) afficher le tag `(v6)` dans `ufw status`, et (b) être sérialisées dans `/etc/ufw/user6.rules`, texte jamais exécuté. `LinuxFirewallManager` n'a même pas de référence à `ip6tables`. Confirmé par lecture du test dédié « G8-19 : Filtrage IPv6 » (`linux-ufw.test.ts`), dont les 5 cas construisent en réalité des paquets IPv4 littéraux — aucun test ne contredit ce constat. | Comportement `ufw` réel (une règle IPv6 est réellement programmée dans `ip6tables` sous-jacent) | **Critique** |
| **F. Complétude du moteur `iptables`/`ufw` lui-même** |||
| 14 | **`-j LOG` est un no-op comportemental.** `--log-prefix`/`--log-level` sont stockés et ré-affichés en `-L`/`-S` mais n'écrivent jamais de ligne dans un log — seul un mécanisme indépendant (`logIptablesDrop`, déclenché automatiquement pour *tout* verdict DROP/REJECT, sans lien avec la présence d'une règle `-j LOG`) produit des lignes observables. | `iptables` réel (`-j LOG` écrit dans le buffer noyau/`dmesg`, indépendamment du verdict final) | Moyenne |
| 15 | **`mangle`/`raw` existent comme tables/chaînes manipulables en CLI mais aucun hook de data plane ne les consulte** — pas de `-j MARK`, pas de `-j NOTRACK`, pas de PREROUTING mangle. `docs/PRD-ip.md` note déjà que le moteur iptables est « non relié à `ip rule`/au routage par stratégie », cohérent avec l'absence de `MARK`. | `iptables` réel (marquage de paquets consommé par le routage par stratégie, `NOTRACK` désactivant le suivi de connexion) | Mineure (dépend d'un futur PRD `ip rule`/policy-routing pour prendre tout son sens) |
| 16 | **Deux chemins de dispatch CLI redondants** (`LinuxMachine.tryNetworkCommand` vs le switch de `LinuxCommandExecutor`) pour les mêmes commandes `iptables`/`ufw` — risque de divergence de comportement selon que la ligne de commande contient une redirection/pipe ou non (déjà la cause directe de l'item 12). | Discipline d'architecture (un seul point d'entrée par commande) | Moyenne |
| 17 | **`ufw logging <level>` ne gate pas réellement l'écriture des logs** — `logBlockedPacket` vérifie `this.enabled` mais jamais `this.loggingLevel` ; `ufw logging off` ne coupe donc pas l'écriture dans `/var/log/ufw.log`. | Comportement `ufw` réel (`logging off` supprime toute écriture) | Mineure |
| 18 | **Chaînes `ufw-before-*`/`ufw-after-*` non modélisées comme chaînes programmables** — seulement des fichiers texte statiques (`before.rules`/`after.rules`), pas de vraies chaînes iptables consultées par le data plane. Un utilisateur ne peut donc pas observer l'effet des règles « avant ufw » (anti-spoof, limitation ICMP) que le vrai `ufw` applique par défaut. | Comportement `ufw` réel | Mineure |
| 19 | **`nft`/`firewall-cmd` reconnus par la complétion (`which`/`command -v`) mais non implémentés** — invoqués, ils échouent en « command not found » plutôt que de signaler explicitement l'absence de nftables/firewalld comme choix de périmètre. | Cohérence de l'expérience CLI | Mineure |

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

Conformément à la demande, les objectifs sont organisés **par axe de
cohérence** (service, fichiers, processus) avant les objectifs de
complétude du moteur lui-même — ce sont les axes explicitement demandés,
pas un ajout secondaire, et chacun est livré **complet** (pas une version
partielle prévue pour être étendue plus tard).

#### A. Cohérence avec le modèle de service (systemd) — items 1-2

1. **Couplage bidirectionnel réel entre l'unité `ufw` et
   `LinuxFirewallManager`.** `systemctl start/stop ufw` doit appeler
   respectivement `cmdEnable()`/`cmdDisable()` (via un nouveau listener
   `onLifecycle` filtré `name === 'ufw'`, suivant exactement le pattern déjà
   utilisé pour `named`/bind9 dans `LinuxMachine.ts:290-297`) ; `ufw
   enable`/`disable` (commande CLI) doit à son tour appeler
   `serviceMgr.start('ufw')`/`stop('ufw')` pour que `systemctl status ufw`
   reflète l'état réel du pare-feu, dans les deux sens.
2. **Rechargement au boot cohérent avec l'état persisté.** Le cycle de
   reboot (`rebootCycle()`) ne doit plus relancer l'unité `ufw` de façon
   inconditionnelle : au boot, l'unité doit d'abord **lire**
   `/etc/ufw/ufw.conf` (`ENABLED=`) et n'activer réellement le pare-feu que
   si cette valeur le demande — exactement le comportement de
   `execStart: '/lib/ufw/ufw-init start quiet'` sur un Ubuntu réel, qui
   consulte la config avant d'agir plutôt que de démarrer inconditionnellement
   parce que l'unité est `enabledByDefault`.

#### B. Cohérence avec le système de fichiers (VFS) — items 3-6

3. **`/etc/ufw/before.rules`/`after.rules`/`user.rules`/`user6.rules`
   redevenus des sources de vérité réellement relues**, pas seulement
   écrites. Au minimum : `ufw reload` et le rechargement au boot (item 2)
   doivent reparser `user.rules`/`user6.rules` en plus de `ufw.conf`, de
   sorte qu'un fichier édité à la main dans le VFS ait un effet observable
   — condition nécessaire avant même d'envisager d'exécuter réellement
   `before.rules`/`after.rules` comme de vraies chaînes programmables (item
   18, séquencé après celui-ci).
4. **Profils d'application `ufw` unifiés sur une seule source de vérité** :
   `ufw app list`/`info` doivent lire les fichiers `/etc/ufw/applications.d/*`
   du VFS plutôt que l'objet TS statique `APP_PROFILES` — additivement,
   pour ne pas régresser les profils déjà couverts par les tests existants,
   l'objet statique peut continuer à *fournir le contenu par défaut* des
   fichiers `applications.d` au premier boot, mais la lecture doit ensuite
   passer par le VFS pour que la création d'un nouveau profil par fichier ait
   un effet réel.
5. **Persistance symétrique v4/v6.** `/etc/iptables/rules.v6` doit être
   écrit au même titre que `rules.v4` (dès que `LinuxFirewallManager`
   dispose d'une référence à `ip6tables`, cf. objectif D ci-dessous — la
   dépendance est réelle et doit être respectée dans l'ordonnancement).
6. **`netfilter-persistent`/`iptables-persistent` complets.** Nouvelle unité
   systemd `netfilter-persistent` (oneshot, chargeant `rules.v4`/`rules.v6`
   au boot dans les moteurs `iptables`/`ip6tables` vivants), et nouvelle
   commande `netfilter-persistent save|reload|flush`, pour que des règles
   `iptables`/`ip6tables` posées manuellement (hors `ufw`) survivent
   réellement à un reboot simulé — pas seulement parce que l'objet JS n'a
   jamais été détruit (cf. objectif ci-dessous), mais parce qu'elles sont
   effectivement relues depuis le VFS au (re)boot.

#### C. Cohérence avec le modèle de processus (TCP/UDP) — items 7-9

7. **ICMPv6 entrant soumis à `firewallFilter6`.** Brancher
   `handleICMPv6` sur le même hook que TCP/UDP-v6, avec les exceptions RFC
   4890 pertinentes documentées comme choix explicite (ex. Neighbor
   Discovery ne doit jamais être filtré, au risque de casser la résolution
   d'adresse elle-même) plutôt qu'un filtrage aveugle de tout ICMPv6.
8. **`--reject-with` réellement respecté côté IPv4**, symétriquement à ce qui
   existe déjà côté IPv6 (`sendResetForSegment`) : `icmp-port-unreachable`,
   `icmp-net-unreachable`, `icmp-host-prohibited`, `tcp-reset` doivent
   chacun produire le type d'erreur réellement configuré plutôt qu'un
   *admin-prohibited* générique systématique.
9. **REJECT différencié de DROP pour l'UDP sortant** — un REJECT en sortie
   doit synthétiser localement l'ICMP *port unreachable* renvoyé à
   l'expéditeur, comme le ferait un vrai noyau, plutôt qu'un simple échec
   silencieux identique à DROP.

#### D. Parité IPv6 complète du moteur `ip6tables` — items 10-12

10. **Correspondance d'adresse/CIDR IPv6 réelle.** `ipMatchesSpec`/
    `validateIPSpec` doivent brancher sur `family` : `family === 6` utilise
    `IPv6Address.parse`/une logique de correspondance de préfixe IPv6 (déjà
    disponible, `core/types.ts:262`) au lieu de `IPAddress`. C'est le
    préalable technique à tout le reste de cet objectif D et de l'objectif E
    (`ufw` ne peut injecter des règles v6 réelles tant que le moteur
    sous-jacent ne sait pas les évaluer).
11. **NAT66 complet** : `evaluateNat6`/`evaluatePreRouting6` côté
    `LinuxMachine`, branchés sur `this.executor.ip6tables.evaluateNat(...)`,
    symétriquement au chemin IPv4 déjà existant.
12. **`ip6tables-restore` fonctionnel dans les deux chemins de dispatch** —
    ajout du `case` manquant dans le switch de `LinuxCommandExecutor`, et
    correction du comportement de délégation inconditionnelle du chemin A.

#### E. `ufw` réellement cohérent avec `ip6tables` — item 13

13. **Injection réelle des règles `ufw` marquées v6 dans `ip6tables`.**
    `LinuxFirewallManager` doit recevoir une référence à `ip6tables` (au
    même titre que `iptables`), et `setupIptablesChains()`/
    `rebuildIptablesRules()` doivent injecter les règles v6 dans ce second
    moteur plutôt que de les filtrer silencieusement. **Dépendance directe
    et bloquante vers l'objectif D.10** (le moteur `ip6tables` doit d'abord
    savoir évaluer une adresse IPv6 avant que `ufw` puisse lui confier des
    règles qui en contiennent) — l'ordonnancement doit respecter cette
    dépendance.

#### F. Complétude du moteur `iptables`/`ufw` lui-même — items 14-19

14. **`-j LOG` produit réellement une ligne de log**, avec le
    `--log-prefix`/`--log-level` configuré, indépendamment du verdict final
    de la chaîne (une règle `-j LOG` suivie d'une règle `-j ACCEPT` doit
    journaliser *et* accepter — pas seulement les paquets finalement
    rejetés comme c'est le cas aujourd'hui via le mécanisme automatique
    `logIptablesDrop`, qui doit rester en plus, pas à la place).
15. **`-j MARK`/`-j NOTRACK` complets**, avec le marquage effectivement
    lisible ensuite (même s'il n'est consommé par aucun autre sous-système
    tant qu'un futur PRD `ip rule`/policy-routing n'existe pas — livrer le
    marquage lui-même est complet, sa consommation par le routage est
    hors périmètre ici et clairement délimitée comme telle).
16. **Unification des deux chemins de dispatch CLI** en un seul point
    d'entrée pour `iptables`/`ip6tables`/`ufw`, quelle que soit la présence
    d'une redirection/pipe dans la ligne de commande — élimine
    structurellement le risque de divergence qui a produit l'item 12.
17. **`ufw logging <level>` gate réellement l'écriture des logs** —
    `off` supprime toute écriture, les niveaux `low/medium/high/full`
    modulent la verbosité (a minima : `low` ne journalise que les
    paquets bloqués sans règle correspondante, comme le fait le vrai `ufw`).
18. **Chaînes `ufw-before-*`/`ufw-after-*` réellement programmables**,
    consultées par le data plane avant/après les chaînes `ufw-user-*` —
    séquencé après l'objectif B.3 (le rechargement réel de
    `before.rules`/`after.rules` doit déjà fonctionner comme lecture de
    fichier avant de leur donner un effet de filtrage).
19. **`nft`/`firewall-cmd` : message d'absence explicite** plutôt qu'un
    « command not found » générique — `nft: command not found (nftables
    n'est pas simulé dans cet environnement, utiliser iptables/ufw)` ou
    équivalent, pour clarifier le choix de périmètre plutôt que de laisser
    croire à un oubli.

### 2.2 Hors périmètre (explicitement exclu)

- **nftables/firewalld** eux-mêmes (item 19 se limite à un message d'absence
  explicite, pas à une implémentation).
- **`ip rule`/policy-based routing** consommant les marques posées par
  `-j MARK` (objectif F.15) — hors périmètre de ce PRD, qui livre le
  marquage lui-même ; sa consommation relève d'un futur PRD dédié au
  routage par stratégie.
- **QoS/traffic shaping** (`tc`) — bien que souvent mentionné à côté
  d'`iptables`/`mangle` sur un vrai Ubuntu, c'est un sous-système distinct
  sans rapport avec le filtrage/NAT traité ici.
- **IPVS/`ipvsadm`** (load-balancing niveau noyau) — hors périmètre.

---

## 3. Plan de remédiation détaillé

L'ordonnancement ci-dessous respecte les dépendances réelles identifiées en
§2.1 (notamment E→D.10, et B.5→D pour la persistance v6) — ce n'est pas un
ordre arbitraire.

### Phase 1 — Correspondance d'adresse IPv6 réelle (item D.10) — ✅ LIVRÉE

- **Fichiers touchés** : `LinuxIptablesManager.ts` (`ipMatchesSpec`,
  `validateIPSpec`, `ipInRange`, branchement sur `this.family`, nouvel
  helper `ip6MatchesSpec`/`compareV6` réutilisant `IPv6Address.isInSameSubnet`).
- **Préalable de toutes les phases IPv6 suivantes** (D.11, D.12, E.13).
- **Tests** : `ip6tables-address-matching.test.ts` — correspondance exacte,
  correspondance CIDR, rejet des adresses/préfixes malformés, `-m iprange`
  en IPv6.
- **Régression** : `linux-iptables.test.ts`, `linux-ufw.test.ts`,
  `scenario-9-dual-stack.test.ts`, `ipv6-tcp-probe-no-shortcircuit.test.ts` —
  288 tests verts, `tsc`/`eslint` propres.

### Phase 2 — NAT66 et `ip6tables-restore` (items D.11, D.12) — ✅ LIVRÉE (périmètre affiné)

- **Fichiers touchés** : `LinuxCommandExecutor.ts` (cases `ip6tables`/
  `ip6tables-save`/`ip6tables-restore` manquants dans le switch composite —
  c'était la cause exacte du point d'entrée mort ; entrées
  `KNOWN_LINUX_COMMANDS` ajoutées), `EndHost.ts` (nouveau hook
  `evaluatePreRouting6`, branché dans `handleIPv6` avant le test
  `isForUs`), `LinuxMachine.ts` (override `evaluatePreRouting6` →
  `this.executor.ip6tables.evaluateNat(pkt, 'PREROUTING')`).
- **Périmètre réellement livré, affiné pendant l'implémentation** :
  uniquement PREROUTING/DNAT. Aucun `evaluateNat6`/POSTROUTING n'a été
  ajouté — `EndHost` ne forwarde jamais l'IPv6 (pas de `forwardIPv6`), donc
  un hook SNAT/MASQUERADE n'aurait aucun point d'appel réel ; l'ajouter
  aurait été du code mort. C'est documenté explicitement dans le code
  (commentaire sur `evaluatePreRouting6`) plutôt que silencieusement omis.
- **Limite découverte pendant les tests, partagée avec IPv4** : un DNAT vers
  une seconde adresse possédée par le même hôte ne produit pas une
  connexion TCP cohérente de bout en bout, faute de un-NAT/conntrack sur le
  chemin de retour (la réponse SYN-ACK/RST est source-ée depuis l'adresse
  réécrite, que le client ne reconnaît pas) — vérifié : aucun test IPv4
  existant n'exerçait ce cas de bout en bout non plus (seul le cas
  NAT-gateway/forward avec `ip_forward=1` a une couverture fonctionnelle
  réelle). Non corrigé ici (hors périmètre de ce PRD, nécessiterait un
  moteur de conntrack de retour pour les deux familles). Documenté dans le
  commit et dans le fichier de test correspondant plutôt que masqué.
- **Tests** : `ip6tables-nat66-prerouting.test.ts` (correspondance CIDR de
  la table nat testée directement au niveau moteur, rendu CLI, ordre des
  hooks PREROUTING-avant-INPUT vérifié via le journal noyau côté serveur)
  et `ip6tables-restore.test.ts` (dispatch CLI dans les deux chemins,
  `which`/`command -v`, erreur réelle sans stdin).
- **Régression** : 424 tests verts sur l'ensemble iptables/ufw/NAT/dual-stack
  concernés, `tsc`/`eslint` propres (5 erreurs `no-explicit-any`/
  `no-this-alias` confirmées préexistantes via `git stash`, non introduites).

### Phase 3 — ICMPv6 filtré + `--reject-with`/REJECT UDP (items C.7, C.8, C.9) — ✅ LIVRÉE (item C.9 re-qualifié)

- **Item C.7 (ICMPv6 filtré)** : `EndHost.handleIPv6` branché sur
  `firewallFilter6` pour tout ICMPv6 entrant, avec garde explicite excluant
  Neighbor/Router Solicitation/Advertisement (RFC 4861) du filtrage —
  bloquer ND casserait la résolution d'adresse elle-même. Préalable
  découvert en cours de route : `-p icmpv6`/`ipv6-icmp` n'étaient pas des
  mots-clés de protocole reconnus par `LinuxIptablesManager` (protocole 58
  jamais mappé) — `ip6tables -p icmpv6 ...` échouait systématiquement à la
  validation ; ajouté à `VALID_PROTOCOLS` et à `ruleMatchesPacket`. REJECT
  sur ICMPv6 utilise un nouveau `sendICMPv6Unreachable` généralisé (ancien
  `sendICMPv6PortUnreachable`, renommé et paramétré par code) avec
  `ICMPV6_UNREACH_ADMIN_PROHIBITED` (code 1).
- **Item C.8 (`--reject-with` IPv4)** : `LinuxIptablesManager` retient le
  `--reject-with` de la règle qui a produit un verdict REJECT
  (`getLastRejectWith()`), lu par `LinuxMachine.runFilterTable` et stocké
  sur `EndHost.lastRejectWith`, consommé par `sendICMPReject`
  (`resolveRejectCode`) — tous les codes ICMP standards
  (`icmp-net/host/port/proto-unreachable`, `icmp-net/host-prohibited`,
  `icmp-admin-prohibited`) plus `tcp-reset` (RST réel via
  `tcpv2.sendResetForSegment`, symétrique au chemin IPv6 déjà existant). Le
  défaut sans `--reject-with` reste admin-prohibited (code 13), inchangé,
  pour ne pas régresser les tests déjà verts qui en dépendent.
- **Item C.9 (REJECT vs DROP en sortie UDP) — re-qualifié, pas de code
  changé.** L'analyse initiale du gap (fondée sur la seule lecture de
  `sendUdpDatagram`, qui renvoie `false` dans les deux cas) était incomplète
  : `firewallFilter`/`runFilterTable` différencient déjà, pour **toute**
  direction y compris `OUTPUT` UDP, la ligne de journal noyau
  (`[netfilter DROP]` vs `[netfilter REJECT]`) et l'événement de bus
  `linux.firewall.drop` (`verdict: 'drop'|'reject'`). La seule chose qui
  manque réellement — un ICMP synthétique remonté dans le propre chemin
  d'erreur du processus émetteur, comme le ferait un vrai noyau — n'a
  aujourd'hui **aucun consommateur** dans ce simulateur (`nc -u` n'est même
  pas supporté, aucun appelant de `sendUdpDatagram` ne réagit à un ICMP
  reçu pour de l'UDP) ; l'ajouter serait du code sans effet observable.
  Non implémenté, documenté explicitement plutôt que forcé.
- **Bug pré-existant corrigé en cours de route (nécessaire pour observer
  C.7/C.8 via la commande `ping6` elle-même)** : `EndHost.
  executePing6Sequence`'s catch block avalait silencieusement l'erreur de
  `sendPing6` (contrairement à l'équivalent IPv4, qui la propage dans
  `PingResult.error`) — `ping6` ne pouvait donc jamais afficher
  « Destination Host Unreachable », seulement un timeout générique, même
  quand un vrai ICMPv6 d'erreur était bien reçu. Corrigé pour threader
  `err.message` exactement comme `executePingSequence` (IPv4) le fait déjà.
- **Tests** : `icmpv6-firewall-filtering.test.ts` (6 tests),
  `iptables-reject-with.test.ts` (5 tests),
  `udp-reject-vs-drop-observability.test.ts` (3 tests, pin de
  non-régression pour C.9).
- **Régression** : 391 tests verts sur les suites ping6/ICMPv6/iptables/ufw/
  dual-stack concernées, `tsc`/`eslint` propres (mêmes 5 erreurs
  préexistantes confirmées par `git stash`, non introduites).

### Phase 4 — Injection réelle des règles `ufw` v6 (item E.13, dépend de Phase 1)

- **Fichiers touchés** : `LinuxFirewallManager.ts` (référence `ip6tables`
  ajoutée au constructeur, `setupIptablesChains`/`rebuildIptablesRules`
  injectent désormais les règles `v6`).
- **Tests** : réécriture du bloc « G8-19 : Filtrage IPv6 » de
  `linux-ufw.test.ts` pour construire de vrais paquets IPv6 et vérifier un
  blocage effectif (pas seulement l'affichage du tag `(v6)`).

### Phase 5 — Couplage service ufw ↔ systemd (items A.1, A.2)

- **Fichiers touchés** : `LinuxMachine.ts` (nouveau listener `onLifecycle`
  filtré `ufw`), `LinuxFirewallManager.ts` (`cmdEnable`/`cmdDisable`
  appellent `serviceMgr`), `LinuxServiceManager.rebootCycle()` (lecture de
  `ufw.conf` avant démarrage inconditionnel de l'unité).
- **Tests** : nouveau fichier `ufw-systemd-coherence.test.ts` — `systemctl
  stop ufw` désactive réellement le filtrage ; `ufw disable` reflète
  `systemctl status ufw` ; un reboot avec `ENABLED=no` persisté ne
  réactive pas le pare-feu.

### Phase 6 — Rechargement VFS réel + profils d'application (items B.3, B.4)

- **Fichiers touchés** : `LinuxFirewallManager.loadFromVfs()` (étendu à
  `user.rules`/`user6.rules`), `cmdApp` (lecture depuis
  `/etc/ufw/applications.d/*`).
- **Tests** : `ufw-vfs-reload.test.ts`, `ufw-app-profiles-vfs.test.ts`.

### Phase 7 — Persistance symétrique v6 + `netfilter-persistent` (items B.5, B.6)

- **Fichiers touchés** : `LinuxFirewallManager.syncToVfs()` (écrit
  `rules.v6`), nouvelle unité systemd `netfilter-persistent` dans
  `LinuxServiceManager.ts`, nouvelle commande `netfilter-persistent
  save|reload|flush`.
- **Tests** : `netfilter-persistent.test.ts`.

### Phase 8 — Complétude moteur (items F.14-F.19)

- **Fichiers touchés** : `LinuxIptablesManager.ts` (`-j LOG` réel, `-j
  MARK`/`NOTRACK`), unification des chemins de dispatch CLI,
  `LinuxFirewallManager.ts` (`logging` réel, chaînes `ufw-before-*`/
  `ufw-after-*` programmables), message d'absence `nft`/`firewall-cmd`.
- **Tests** : `iptables-log-target.test.ts`, `iptables-mark-notrack.test.ts`,
  `ufw-before-after-chains.test.ts`, `ufw-logging-levels.test.ts`.

---

## 4. Exigences de non-régression

Toute correction reste **additive et testée**. Suites déjà vertes à ne pas
régresser en priorité : `linux-iptables.test.ts` (1259 lignes),
`linux-ufw.test.ts` (1642 lignes), `ssh-host-firewall-vs-network-acl.test.ts`,
`cron-firewall.test.ts`, `scenario-listen-vs-filtered.test.ts`,
`tcp-connect-outcome.test.ts`, `ipv6-tcp-probe-no-shortcircuit.test.ts`,
`scenario-9-dual-stack.test.ts` (dont le titre nomme explicitement
l'asymétrie v4/v6 comme un « symmetric gap » déjà connu et testé comme tel —
la Phase 4 doit faire évoluer ce test consciemment, pas le casser
silencieusement), les suites fail2ban, et
`src/__tests__/debug/protocols/acl-security.debug.test.ts`. Les Phases 1-4
(parité IPv6) sont strictement séquentielles entre elles (chacune dépend de
la précédente) ; les Phases 5-6 (service/VFS côté `ufw`) sont indépendantes
des Phases 1-4 et peuvent être menées en parallèle ; la Phase 7 dépend à la
fois de la Phase 4 (référence `ip6tables` dans `LinuxFirewallManager`) et de
la Phase 6 (mécanisme de rechargement VFS déjà en place) ; la Phase 8 est
indépendante de toutes les autres.

---

## 5. Risques

- **Risque principal** : la Phase 5 (couplage service) touche le cycle de
  reboot déjà partagé avec de nombreux autres sous-systèmes (`auditRules`,
  d'autres unités `enabledByDefault`) — un mauvais séquencement du
  rechargement `ufw` par rapport aux autres unités au boot pourrait
  introduire une race si une autre unité dépend implicitement de l'état du
  pare-feu au démarrage. Mitigation : régression complète des suites de
  service/boot existantes (`docs/PRD-Systemd.md` §1.2) avant tout commit de
  cette phase.
- **Risque de couplage circulaire** : donner à `LinuxFirewallManager` une
  référence à `ip6tables` (Phase 4) tout en le faisant piloter par
  `serviceMgr` (Phase 5) augmente le nombre de dépendances croisées entre
  `LinuxMachine`/`LinuxFirewallManager`/`LinuxServiceManager` — à surveiller
  pour ne pas reproduire l'anti-pattern à deux sources de vérité déjà
  identifié pour `display eth-trunk` côté Huawei dans `GAP.md` §2.2.
- **Risque de volume de travail sous-estimé** : ce PRD couvre trois axes de
  cohérence explicitement demandés en plus de la complétude du moteur
  lui-même — le volume total (8 phases, ~15 nouveaux fichiers de test) est
  significativement plus grand qu'un PRD de complétude fonctionnelle seule.
  Assumé explicitement, comme pour les PRD du trio VLAN/802.1Q/VTP.
- **Risque de régression sur l'asymétrie déjà testée comme un fait assumé**
  (`scenario-9-dual-stack.test.ts`, « symmetric gap ») — la Phase 4 doit
  explicitement réviser ce test pour refléter le nouveau comportement plutôt
  que de le laisser affirmer un gap désormais comblé, ce qui le rendrait
  trompeur sans le faire échouer.
