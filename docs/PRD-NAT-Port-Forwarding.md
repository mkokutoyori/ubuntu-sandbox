# PRD — Port Forwarding (NAT statique orienté port / redirection de port)

**Version** : 1.0
**Date** : 2026-07-08
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- RFC 2663 (traduction d'adresse réseau — terminologie inside/outside
  local/global, notion de translation directionnelle)
- RFC 6146 (NAT64/stateful NAT — machine à états TCP appliquée aux
  traductions, déjà réutilisée par le moteur existant)
- RFC 5382 (exigences NAT pour TCP — comportement hairpin déjà implémenté)
- Comportement Cisco IOS réel (`ip nat inside source static tcp|udp`, ordre
  d'évaluation NAT/ACL documenté dans le « Cisco IOS NAT Order of
  Operations »)
- Comportement Huawei VRP réel (`nat server protocol tcp|udp global ...
  inside ...`)

---

## 0. Contexte et portée du document

Ce PRD documente **la redirection de port (static PAT / port forwarding)** :
la fonctionnalité qui permet à un hôte extérieur d'atteindre
`<IP publique du routeur>:<port public>` et d'être transparentement
redirigé vers `<IP privée d'un hôte interne>:<port interne>`, pour TCP et
UDP, sur Cisco IOS (`ip nat inside source static tcp|udp ...`) et Huawei VRP
(`nat server protocol tcp|udp ...`). Il **ne redéfinit pas** le moteur NAT
générique (PAT/overload, pool dynamique, NAT statique 1:1 sans port) qui est
déjà largement implémenté et solide (§1.2) — il se concentre sur le sous-cas
« redirection orientée port » et sur deux défauts de correction qui
l'affectent directement : l'ordre d'évaluation NAT/ACL (§1.3 item 1) et la
profondeur de la couverture de test bout-en-bout (§1.3 item 4).

Cette analyse est issue d'une lecture complète de
`src/network/devices/router/NATEngine.ts` (899 lignes), de
`src/network/devices/shells/cisco/CiscoNATCommands.ts`, de
`src/network/devices/shells/huawei/HuaweiNATCommands.ts`, du chemin de
traitement de paquet complet dans `src/network/devices/Router.ts`
(`processIPv4()`, ordre NAT/ACL entrant et sortant), et des suites de tests
existantes `nat-pat.test.ts` (1113 lignes), `nat-pat-other.test.ts`
(4279 lignes), `scenario-nat-pat-uniqueness.test.ts` et
`scenario-double-nat-traceability.test.ts`. Le gap-analysis existant du
dépôt (`GAP.md` §4.10, *« NAT — pas d'ALG (FTP/SIP), pas de NAT64 »*) est
scopé aux ALG/NAT64 et ne mentionne ni la redirection de port ni l'ordre
NAT/ACL — ce PRD n'écrase ni ne duplique cette entrée, il en ouvre une
nouvelle.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel |
|---|---|
| `src/network/devices/router/NATEngine.ts` | Moteur NAT complet : NAT statique 1:1, **NAT statique orientée port (`NatStaticEntry.protocol/localPort/globalPort`)**, NAT statique réseau, PAT/overload dynamique, hairpin (RFC 5382 §5), réécriture ICMP embarquée (RFC 5508 §3), pinhole ALG FTP. `translateInbound()` (l. 342-404) applique déjà la réécriture de destination pour un port statiquement redirigé (correspondance `proto`+`dstPort === entry.globalPort`, l. 396-398) |
| `src/network/devices/Router.ts` | `processIPv4()` appelle `natEngine.translateInbound()` (l. 1168-1169) **avant** l'ACL entrante (l. 1216-1227), et `aclEngine` sortant (l. 1570-1581) **avant** `natEngine.translateOutbound()` (l. 1584) — ordre inversé par rapport au comportement Cisco/Huawei réel (voir §1.3 item 1) |
| `src/network/devices/shells/cisco/CiscoNATCommands.ts` | `ip nat inside source static tcp\|udp <local> <lport> <global> <gport>` (l. 95-127, y compris variante `interface <if> <gport>`, l. 104-117) déjà réelle, branchée sur `NATEngine.addStaticEntry()` ; `ip nat outside source static` (l. 329-348) stockée/affichée mais **jamais appliquée** au plan de données ; `ip nat inside source route-map` (l. 386-397) purement décorative |
| `src/network/devices/shells/huawei/HuaweiNATCommands.ts` | `nat server protocol tcp\|udp global <ip> <port> inside <ip> <port>` (l. 82-104) déjà réelle, branchée sur `NATEngine.addStaticEntry()` ; `nat dns-map` (l. 156-166) et `nat static enable` (l. 199-206) purement décoratives (flag/tableau jamais consultés par le moteur) |
| `src/__tests__/unit/network-v2/nat-pat.test.ts` | Tests directs sur `NATEngine.translateInbound()` (§9.3/9.4) prouvant la réécriture — mais sans topologie ; groupe Huawei « nat server CLI » (6.1-6.4) : reconnaissance CLI uniquement, **aucun paquet envoyé** |
| `src/__tests__/unit/network-v2/nat-pat-other.test.ts` | Section 4 « Cisco Static PAT / Port Forwarding » (tests 151-200) : topologie complète + CLI, mais la majorité des assertions portent sur `show ip nat translations`/`show running-config` (vrai même sans trafic réel) ; seul le test 167 (`show ip nat statistics` → compteur de hits) prouve qu'un paquet réel a traversé la traduction |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Le moteur de traduction lui-même est authentique, pas un stub.** Le
  matching `proto === entry.protocol && dstPort === entry.globalPort` et la
  réécriture d'adresse+port (`rewriteDestIP`, l. 820-839) constituent une
  vraie implémentation de static-PAT, pas une approximation — confirmé par
  traçage complet de la chaîne d'appel jusqu'au client Telnet/TCP réel
  (`LinuxCommandExecutor.runTelnetClient()` → `EndHost.tcpProbeSync()` →
  `TcpStack.connect()` → trame Ethernet réelle → `Router.processIPv4()` →
  `natEngine.translateInbound()`).
- **La CLI de redirection de port est déjà branchée pour les deux vendors**,
  avec la syntaxe et la sémantique propres à chacun (`ip nat inside source
  static tcp|udp` côté Cisco, `nat server protocol tcp|udp` côté Huawei) —
  ce PRD ne réinvente aucune de ces deux commandes, il corrige leur
  environnement d'exécution (ordre ACL) et approfondit leur couverture de
  test.
- **Le hairpin NAT (RFC 5382 §5)** et la **réécriture ICMP embarquée**
  fonctionnent déjà et sont hors périmètre de ce document.
- **`show ip nat statistics`/`display nat session`** reflètent l'état réel du
  moteur (compteurs de hits/miss, sessions actives) — pas un gabarit
  statique.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **L'ordre d'évaluation NAT/ACL est inversé dans les deux sens par rapport au comportement Cisco/Huawei réel.** Sens entrant (redirection de port) : `Router.processIPv4()` applique `translateInbound()` (l. 1168-1169) **avant** l'ACL d'entrée (l. 1216-1227) — l'ACL voit donc l'adresse **déjà traduite** (privée), alors qu'un vrai routeur l'évalue contre l'adresse **publique** d'origine. Sens sortant : l'ACL de sortie (l. 1570-1581) est évaluée **avant** `translateOutbound()` (l. 1584) — l'ACL sortante voit l'adresse **privée** pré-NAT au lieu de l'adresse publique post-NAT réelle. Conséquence concrète : une ACL réaliste `permit tcp any host <IP publique> eq <port>` écrite pour restreindre l'accès à un port redirigé **ne correspond jamais** dans ce simulateur. | « Cisco IOS NAT Order of Operations » (doctrine IOS documentée), comportement VRP équivalent | **Majeure** (bug de correction fonctionnelle, silencieusement contre-intuitif pour tout opérateur formé sur du matériel réel) |
| 2 | **Aucun test ne prouve la livraison applicative bout-en-bout d'un port redirigé.** La couverture actuelle la plus forte (`nat-pat-other.test.ts` test 167) prouve qu'un paquet réel déclenche la traduction (compteur de hits incrémenté), pas qu'un service qui écoute réellement sur le port interne reçoit et traite la connexion/les données (aucun `nc -l`/serveur HTTP minimal + assertion sur la réponse reçue). | Rigueur de test attendue pour une fonctionnalité de sécurité réseau exposée à Internet | Moyenne |
| 3 | **Aucune topologie/test CLI Huawei pour `nat server` bout-en-bout.** Seuls les tests 6.1-6.4 de `nat-pat.test.ts` existent, et ils ne font que vérifier la reconnaissance CLI (`getStaticEntries()`), sans topologie ni paquet — asymétrie de couverture entre Cisco (Section 4 complète, quoique de rigueur variable, item 2) et Huawei (couverture nulle en topologie réelle). | Parité de couverture Cisco/Huawei déjà pratiquée ailleurs dans ce dépôt (VLAN/VTP/802.1Q) | Moyenne |
| 4 | **`ip nat outside source static` (Cisco) est stockée/affichée mais jamais appliquée au plan de données.** La commande est acceptée, apparaît dans `show running-config`, mais `translateInbound()`/`translateOutbound()` ne la consultent jamais pour une traduction réelle. | Sémantique Cisco IOS réelle de `ip nat outside source static` (traduction d'adresse source pour un hôte outside communiquant vers inside) | Mineure |
| 5 | **`clear ip nat translation` (Cisco) et `reset nat session` (Huawei) ignorent leurs propres filtres.** Les variantes `tcp`/`udp`/`vrf`/`pool`/`inside <ip>` sont parsées et validées mais purgent la table dynamique **entière** au lieu de filtrer sélectivement — un opérateur qui tente de ne vider qu'une session précise vide tout le NAT du routeur. | Sémantique Cisco/Huawei réelle de ces commandes de maintenance | Mineure |
| 6 | **`ip nat inside source route-map` (Cisco) est purement décorative** — stockée dans un tableau `_ciscoNatRouteMapRules` jamais consulté, aucune sélection de traduction fondée sur route-map n'a d'effet réel. | Sémantique Cisco IOS réelle (sélection de règle NAT par critère de routage plutôt que par ACL simple) | Mineure |
| 7 | **`nat dns-map` et `nat static enable` (Huawei) sont purement décoratives** — la première est stockée dans un tableau jamais lu, la seconde bascule un flag (`(engine as any).staticEnabled`) jamais consulté : le NAT statique fonctionne identiquement que la commande soit tapée ou non. | Sémantique VRP réelle (DNS ALG pour NAT, et gate d'activation explicite du NAT statique) | Mineure |
| 8 | **Aucune trace de session dédiée pour une connexion entrante redirigée.** Chaque paquet entrant est ré-évalué contre la table statique (`NatStaticEntry`) plutôt que de créer une `NatSession` dédiée comme le fait le PAT dynamique — fonctionnellement correct, mais `show ip nat translations`/`display nat session` ne peuvent pas distinguer deux connexions concurrentes vers le même port redirigé dans le détail par session. | Visibilité opérationnelle attendue d'un `show`/`display` réaliste | Mineure |

---

## 2. Objectifs

Chaque fonctionnalité ci-dessous est livrée **complète** et, dès lors qu'un
équipement réel des deux vendors couverts par ce simulateur (Cisco IOS et
Huawei VRP) la supporte, elle est corrigée/testée **pour les deux**, avec la
syntaxe et la sémantique propres à chaque vendor. Les items 6 à 9
délimitent explicitement ce que ce PRD **ne traite pas**, pour éviter toute
ambiguïté entre un gap non chiffré et un oubli.

1. **Corriger l'ordre d'évaluation NAT/ACL — vendor-neutre (le code de
   `Router.processIPv4()` est partagé).** Sens entrant : évaluer l'ACL
   d'interface contre le paquet **avant** traduction (adresse/port publics
   tels qu'observés par l'expéditeur), puis appliquer `translateInbound()`
   seulement si l'ACL autorise le paquet. Sens sortant : appliquer
   `translateOutbound()` **avant** l'évaluation de l'ACL de sortie, pour que
   celle-ci voie l'adresse publique post-NAT. C'est une correction de bug,
   pas une nouvelle fonctionnalité — le comportement observable des ACL déjà
   testées contre du trafic non-NATé ne doit pas changer.
2. **Couverture de test bout-en-bout — redirection de port livrant
   réellement à l'application interne, Cisco et Huawei.** Étendre les
   topologies de test existantes pour démarrer un service qui écoute
   réellement (serveur TCP minimal existant du simulateur, ou service HTTP
   déjà implémenté) sur le port interne, initier la connexion depuis
   l'extérieur vers l'IP/port public, et asserter sur la réponse
   effectivement reçue par le client extérieur — pas seulement sur un
   compteur de hits. Couvrir TCP et UDP pour les deux vendors.
3. **Combler l'asymétrie de couverture Huawei.** Construire une topologie
   Huawei complète (miroir de la Section 4 Cisco de `nat-pat-other.test.ts`)
   exerçant `nat server protocol tcp|udp` avec un vrai trafic traversant,
   pas seulement la reconnaissance CLI des tests 6.1-6.4 existants.
4. **Rendre réelles les commandes de maintenance sélectives — les deux
   vendors.** `clear ip nat translation {tcp|udp|vrf <name>|inside...}`
   (Cisco) et `reset nat session {inside <ip>|...}` (Huawei) doivent
   effectivement filtrer les sessions purgées selon les critères donnés,
   au lieu de vider la table entière.
5. **`ip nat outside source static` (Cisco) — rendre la traduction réelle.**
   Appliquer effectivement la traduction d'adresse source pour un hôte
   outside s'adressant à un hôte inside via son adresse locale, en
   complément de `translateInbound()`/`translateOutbound()` existants.
6. **Hors périmètre — fonctionnalités déjà réelles, non retouchées.** NAT
   statique 1:1 sans port, NAT réseau, PAT/overload dynamique, hairpin,
   réécriture ICMP embarquée, pinhole ALG FTP — déjà réels et solides
   (§1.2), ce PRD ne les modifie pas.
7. **Hors périmètre — déjà couvert ailleurs.** ALG SIP, NAT64 — déjà
   identifiés et documentés dans `GAP.md` §4.10 comme hors périmètre actuel ;
   ce PRD n'y revient pas.
8. **Hors périmètre — décoratif, chiffrage jugé disproportionné.**
   `ip nat inside source route-map` (§1.3 item 6) et `nat dns-map`/`nat
   static enable` (§1.3 item 7) : signalées pour mémoire mais **non
   traitées** dans les phases ci-dessous, vu leur usage réel limité en
   topologie pédagogique — à ne pas confondre avec un oubli, c'est un choix
   de portée explicite.
9. **Hors périmètre — non demandé.** Journalisation/traces d'audit
   spécifiques à la redirection de port (`ip nat log translations` ou
   équivalent).

---

## 3. Plan de remédiation détaillé

### Phase 1 — Correction de l'ordre d'évaluation NAT/ACL (item 2-1)

- **Fichiers touchés** : `src/network/devices/Router.ts` uniquement
  (`processIPv4()`, chemins entrant l. ~1160-1230 et sortant l. ~1560-1590).
  Vendor-neutre : le code de forwarding est partagé entre `CiscoRouter` et
  `HuaweiRouter`.
- **Détail** : réordonner pour que l'ACL entrante soit évaluée avant
  `translateInbound()` (sur le paquet pré-traduction) et que
  `translateOutbound()` s'exécute avant l'ACL sortante (qui doit voir le
  paquet post-traduction). Aucune commande CLI ne change ; seul l'ordre
  d'exécution interne est corrigé.
- **Tests** : nouveau fichier `nat-acl-evaluation-order.test.ts` — ACL
  d'interface entrante écrite contre l'adresse publique bloque/autorise
  correctement un trafic vers un port redirigé ; ACL de sortie écrite contre
  l'adresse publique post-PAT se comporte correctement. Régression complète
  de `nat-pat.test.ts`/`nat-pat-other.test.ts` (aucune régression attendue
  sur les tests existants, qui n'exercent pas cette interaction) et des
  suites ACL pures (`ssh-cisco-acl-*.test.ts`, `scenario-multilayer-acl-coherence.test.ts`).

### Phase 2a — Couverture bout-en-bout Cisco : livraison applicative réelle (item 2-2)

- **Fichiers touchés** : nouveau fichier de test uniquement, aucun changement
  moteur attendu (le moteur traduit déjà correctement — cette phase prouve
  la livraison, elle ne corrige pas une régression connue).
- **Tests** : nouveau fichier `port-forwarding-e2e.test.ts` — topologie
  Cisco avec un hôte interne exécutant un service TCP réellement à l'écoute
  (réutiliser l'infrastructure serveur déjà existante dans le simulateur,
  p. ex. un serveur HTTP/echo minimal) sur le port interne, redirection
  configurée via `ip nat inside source static tcp`, connexion initiée par un
  hôte extérieur vers l'IP/port public, assertion sur la réponse
  effectivement reçue par le client (pas uniquement un compteur). Variante
  UDP équivalente.

### Phase 2b — Couverture bout-en-bout Huawei : topologie manquante (item 2-3)

- **Fichiers touchés** : nouveau fichier de test uniquement, même logique
  que 2a mais topologie/CLI Huawei (`nat server protocol tcp|udp`).
- **Tests** : ajouté au même fichier `port-forwarding-e2e.test.ts`
  (convention déjà établie dans ce dépôt : un seul fichier couvrant les deux
  vendors plutôt que deux fichiers séparés) — topologie Huawei miroir de la
  Phase 2a, TCP et UDP.

### Phase 3 — Commandes de maintenance sélectives (item 2-4)

- **Fichiers touchés** : `NATEngine.ts` (méthodes de purge, ajout de
  filtrage par critère), `CiscoNATCommands.ts` (l. ~489-556),
  `HuaweiNATCommands.ts` (l. ~247-259).
- **Cisco** : `clear ip nat translation tcp|udp|vrf <name>|inside <ip>
  [<port>] outside <ip> [<port>]` ne purge que les sessions correspondant
  aux critères donnés.
- **Huawei** : `reset nat session inside <ip>` ne purge que les sessions de
  cet hôte interne.
- **Tests** : nouveau fichier `nat-selective-clear.test.ts` — plusieurs
  sessions actives simultanées, purge sélective par filtre, vérification
  que les sessions non concernées survivent — deux vendors.

### Phase 4 — `ip nat outside source static` réellement appliquée (item 2-5, Cisco uniquement)

- **Fichiers touchés** : `NATEngine.ts` (`translateInbound()`/
  `translateOutbound()` consultent désormais aussi `NatOutsideStatic`),
  `CiscoNATCommands.ts` (aucun changement de commande, seulement de
  branchement moteur).
- **Tests** : ajout à `nat-pat.test.ts` ou nouveau describe dédié — un hôte
  outside adressant l'adresse locale d'un hôte inside via une entrée `ip nat
  outside source static` voit sa traduction appliquée.

---

## 4. Exigences de non-régression

Comme pour `PRD-802.1Q.md`/`PRD-VLAN.md` : toute correction doit rester
**additive et testée**. Le comportement observable des suites déjà vertes
touchant NAT (`nat-pat.test.ts`, `nat-pat-other.test.ts`,
`scenario-nat-pat-uniqueness.test.ts`, `scenario-double-nat-traceability.test.ts`,
`ftp-alg-nat.test.ts`, `nat-icmp-pat.test.ts`) et ACL
(`ssh-cisco-acl-port22-filtering.test.ts`, `ssh-cisco-acl-time-range.test.ts`,
`scenario-multilayer-acl-coherence.test.ts`) ne doit pas régresser — la
Phase 1 en particulier touche un chemin de code partagé par tout trafic
routé, pas seulement le trafic NATé, et exige la régression complète des
suites `router-*`/`inter-vlan-routing.test.ts` avant tout commit. Les
Phases 2a/2b sont chacune requises pour clore les objectifs §2 items 2 et 3 — livrer
uniquement le volet Cisco constitue une livraison incomplète. La Phase 3
dépend de la Phase 1 uniquement dans la mesure où les deux touchent le même
fichier `Router.ts`/`NATEngine.ts` (risque de conflit de merge, pas de
dépendance fonctionnelle) ; la Phase 4 est indépendante des Phases 1-3.

---

## 5. Risques

- **Risque principal** : la Phase 1 touche l'ordre d'exécution dans
  `Router.processIPv4()`, un chemin de code emprunté par **tout** paquet
  routé (NATé ou non) — une erreur d'ordonnancement pourrait
  silencieusement casser le forwarding IP de base, pas seulement le NAT.
  Mitigation : régression complète des suites de routage de base
  (`ping-through-switch.test.ts`, `router-ssh-wire-end-to-end.test.ts`,
  toutes les suites `debug/router/*`) avant/après, en plus des suites NAT/ACL
  listées en §4.
- **Risque secondaire** : les tests bout-en-bout (Phases 2a/2b) dépendent de
  l'infrastructure de service réellement à l'écoute déjà présente dans le
  simulateur (serveur TCP/HTTP minimal) — si cette infrastructure n'expose
  pas un point d'entrée suffisamment simple pour écouter sur un port
  arbitraire choisi par le test, la conception détaillée devra vérifier
  quelle primitive existante (`nc -l`, service HTTP simulé, ou autre)
  convient avant d'écrire les tests, plutôt que d'assumer sa disponibilité.
- **Risque mineur** : la Phase 3 (purge sélective) touche des méthodes de
  `NATEngine` déjà consommées par plusieurs commandes `show`/`clear` — toute
  modification de signature doit rester rétrocompatible avec les appels
  existants non filtrés (`clear ip nat translation *` doit continuer à tout
  vider).
