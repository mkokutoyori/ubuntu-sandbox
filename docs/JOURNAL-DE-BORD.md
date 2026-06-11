# Journal de bord — Refactoring & conformité protocolaire

Ce journal documente chaque défaillance ou limite identifiée dans le simulateur,
la cause racine, et la correction apportée. Une entrée = un commit.

Méthodologie : audit complet du code (`src/network/`) contre les normes de
référence (RFC / IEEE) + analyse de duplication et de design patterns. Les
corrections sont structurelles, jamais cosmétiques.

---

## Backlog issu de l'audit initial (2026-06-09)

| # | Sujet | Norme / Pattern | Sévérité | Statut |
|---|-------|-----------------|----------|--------|
| 1 | STP : états Listening/Learning absents + tie-break d'élection du root port incomplet | IEEE 802.1D | Haute | ✅ Corrigé |
| 2 | TCP : état TIME_WAIT déclaré mais jamais utilisé (pas de 2MSL) | RFC 793 §3.5 | Haute | ✅ Corrigé |
| 3 | HSRP : plages de groupes non bornées (MAC malformée hors plage), fonction MAC dupliquée, rétrogradation v2→v1 silencieuse | RFC 2281 / réalité IOS | Moyenne | ✅ Corrigé |
| 4 | FHRP : ~450 lignes dupliquées entre HsrpAgent / VrrpAgent / GlbpAgent (timers, machine à états, construction de paquets) | DRY / Factory | Haute | ✅ Corrigé |
| 5 | Helpers IP réimplémentés 6× (OSPF ×2, EIGRP, BGP, PIM, CLI OSPF) | DRY | Moyenne | ✅ Corrigé |
| 6 | Cycle de vie des agents protocolaires copié-collé dans CiscoRouter / HuaweiRouter / CiscoSwitch / HuaweiSwitch (init + restart `setEventBus`) | Registry pattern | Haute | ✅ Corrigé |
| 7 | `lldpToNeighborDTO` / `cdpToNeighborDTO` dupliqués à l'identique dans 4 fichiers devices | DRY | Moyenne | ✅ Corrigé |
| 8 | Dispatch par `constructor.name` dans 5 sites shell/terminal (oblige `keepNames: true` au build) | Polymorphisme | Moyenne | ✅ Corrigé |
| 9 | BGP : pas de propagation transitive, pas d'AS_PATH, pas de détection de boucle, table `show ip bgp` fabriquée | RFC 4271 | Haute | ✅ Corrigé |
| 10 | Equipment.ts : 11 méthodes « terminal » stub polluent routeurs/switches | ISP (SOLID) | Moyenne | À faire |

---

## Entrée 1 — STP : machine à états 802.1D complète (Listening/Learning)

**Date** : 2026-06-09

### Défaillance constatée

1. `StpAgent` (`src/network/stp/StpAgent.ts`) ne connaissait que 3 états de
   forwarding (`blocking | forwarding | disabled`). Les états transitoires
   **Listening** et **Learning** exigés par IEEE 802.1D-1998 §8.4 n'existaient
   pas : un port débloqué passait instantanément de `blocking` à `forwarding`,
   ce qui sur un vrai équipement prendrait 2 × forward-delay (30 s par défaut).
   Ironie : la classe de base `Switch` supportait déjà ces états côté data
   plane (`STPPortState`, drop des trames en listening, apprentissage MAC seul
   en learning) — le plan de contrôle ne les pilotait simplement jamais.
2. **Bug d'élection découvert pendant l'écriture des tests** : le tie-break du
   root port ne comparait que le coût. À coût égal, c'était l'ordre
   d'insertion dans la `Map` qui décidait — comportement non déterministe et
   non conforme. IEEE 802.1D §8.6.8 impose : coût, puis bridge ID émetteur,
   puis port ID émetteur, puis port ID local.

### Correction

- `StpForwardState` étendu à 5 états ; `StpAgent` pilote désormais
  `listening → (forward-delay) → learning → (forward-delay) → forwarding` via
  le `Scheduler` injectable (testable en temps virtuel).
- Fast paths documentés : PortFast (edge port 802.1D-2004) et première prise
  en charge d'un port (transition rapide type RSTP, cohérente avec le fast
  path link-up existant de la classe `Switch`) passent directement en
  forwarding — préserve l'utilisabilité du simulateur et les topologies
  existantes.
- Annulation propre des timers de transition sur re-blocage, link-down,
  `stop()`, désactivation STP.
- Nouvel événement bus `stp.port-state.changed` (old/new state) pour
  l'observabilité UI/tests.
- Tie-break d'élection complet (`rootPathPreference`).
- `CiscoSwitch`/`HuaweiSwitch` transmettent désormais l'état verbatim au data
  plane au lieu d'écraser listening/learning en `disabled`.

### Tests

- 6 nouveaux tests dans `stp-protocol.test.ts` (suite « 802.1D
  listening/learning transitions ») en temps virtuel : transitions complètes,
  forward-time non défaut, événements publiés, bypass PortFast, annulation de
  transition sur re-blocage.
- Non-régression : 6570 tests `network-v2` passent (les 2 unhandled rejections
  de `linux-iptables.test.ts` sont préexistantes et sans rapport).

---

## Entrée 2 — TCP : état TIME_WAIT et temporisation 2MSL

**Date** : 2026-06-09

### Défaillance constatée

`TcpStack` (`src/network/tcp/TcpStack.ts`) déclarait `time-wait` dans l'union
`TcpState` mais aucun chemin n'y entrait : `fin-wait-1`+FIN/ACK,
`fin-wait-2`+FIN et `closing`+ACK appelaient tous `_teardown()` qui détruisait
immédiatement le socket. RFC 793 §3.5 impose au fermeur actif de rester en
TIME_WAIT pendant 2 × MSL pour :
- absorber les segments retardés de l'ancienne incarnation de la connexion
  (sinon corruption possible d'une nouvelle connexion sur le même 4-tuple) ;
- ré-ACKer une retransmission du FIN distant si le dernier ACK s'est perdu.

### Correction

- Constante `TCP_MSL_MS = 30 s` (2MSL = 60 s, aligné Linux
  `TCP_TIMEWAIT_LEN`) dans `tcp/types.ts`.
- Transitions conformes : `fin-wait-1 --FIN+ACK--> time-wait`,
  `fin-wait-2 --FIN--> time-wait`, `closing --ACK--> time-wait` ; le fermeur
  passif (`last-ack --ACK--> closed`) reste immédiat, conforme.
- **Fidélité au modèle OS réel** : l'application est notifiée immédiatement
  (handlers `onClose` + événement `tcp.connection.closed`) — comme un
  `close()` POSIX — mais le 4-tuple reste réservé dans la table des sockets
  (visible dans `listSockets()`/netstat, comme une vraie ligne TIME_WAIT)
  jusqu'à expiration du timer 2MSL, piloté par le `Scheduler` injectable.
- En TIME_WAIT, un FIN retransmis est ré-ACKé et le timer 2MSL est réarmé.
- `stop()` libère les sockets TIME_WAIT sans émettre de double événement de
  fermeture.

### Tests

- 5 nouveaux tests (suite « TIME_WAIT (RFC 793 §3.5) ») en temps virtuel :
  réservation 2MSL exacte (libération à t=2MSL, pas avant), notification
  applicative immédiate, ré-ACK d'un FIN retransmis + réarmement du timer,
  fermeture passive sans TIME_WAIT, `stop()` propre.
- 2 tests existants mis à jour : ils assertaient le comportement non conforme
  (fermeur actif `closed` immédiatement).
- Non-régression : network-v2 + shell + terminal = 7470 tests verts. Le seul
  échec (`duplicate-display-fixes.test.ts`, prompt sudo) est préexistant —
  vérifié par bisection avec `git stash` sur l'arbre vierge.

---

## Entrée 3 — HSRP : bornage des groupes, MAC virtuelle, bug de version

**Date** : 2026-06-09

### Défaillances constatées

L'audit initial suspectait une MAC HSRPv2 malformée ; la vérification a montré
que la formule `0000.0c9f.f` + 3 digits hex est en réalité correcte pour les
groupes 0-4095. Les vrais problèmes découverts en creusant :

1. **Aucune borne de plage** : `hsrpVirtualMac(300, 1)` produisait
   `0000.0c07.ac12c` (13 caractères, MAC invalide). La CLI acceptait
   `standby 300 ip …` en version 1 alors que l'IOS réel borne v1 à 0-255 et
   v2 à 0-4095.
2. **Fonction dupliquée** : `hsrpVirtualMac` existait en double —
   `hsrp/types.ts` ET `devices/inspection/config/FhrpRepository.ts` (c'est le
   doublon que la CLI importait). Toute correction de l'un laissait l'autre
   faux.
3. **Bug latent de rétrogradation** : `HsrpAgent.ensureGroup(iface, group)`
   avait `version = 1` par défaut et écrasait la version existante — chaque
   `setVip`/`setPriority`/`setTimers` interne **rétrogradait silencieusement
   un groupe v2 en v1**.
4. L'IOS réel refuse `standby version 1` tant que des groupes > 255 existent
   sur l'interface ; le simulateur acceptait et corrompait l'état.

### Correction

- `hsrp/types.ts` : constantes `HSRP_V1_MAX_GROUP`/`HSRP_V2_MAX_GROUP`,
  `hsrpMaxGroup()`, garde fail-fast (`RangeError`) dans `hsrpVirtualMac`.
- `FhrpRepository` ré-exporte la fonction canonique (doublon supprimé) et
  expose `interfaceVersion(iface)`.
- CLI (`CiscoHsrpCommands.applyStandby`) : validation de plage selon la
  version de l'interface + refus de rétrogradation v1 avec groupes > 255,
  messages type IOS.
- `HsrpAgent.ensureGroup(iface, group, version?)` : la version n'est
  modifiée que si explicitement fournie ; validation contre la version
  effective du groupe.

### Tests

8 nouveaux cas : couverture des bornes (0, 255, 256, 4095), rejets
(`RangeError` : 256/v1, 4096/v2, négatif, non-entier), CLI v1 rejette > 255,
CLI v2 accepte 300 / rejette 4096, refus de retour en v1. Suites HSRP/GLBP
vertes + `tsc --noEmit` propre.

---

## Entrée 4 — FHRP : consolidation HSRP / VRRP / GLBP

**Date** : 2026-06-10

### Défaillance constatée

1. **Construction de paquets dupliquée** : les blocs « UDP → IPv4 (+checksum)
   → Ethernet » étaient copiés-collés dans `HsrpAgent.advertise()`,
   `VrrpAgent.advertise()` et `GlbpAgent.advertise()` (~25 lignes chacun) —
   et le même motif existe dans une dizaine d'autres agents (syslog, NTP,
   BFD, IGMP, PIM, SNMP, RADIUS, NetFlow, VXLAN). Un helper canonique
   `createIPv4Packet()` existait pourtant déjà dans `core/types.ts` (utilisé
   par RIP/IPSec) mais ne supportait ni `tos` ni `flags`, d'où les copies.
2. **Plomberie de timers dupliquée** : chaque agent gérait à la main
   `helloTimer`/`expiryTimer`/`scheduler` avec le même code start/stop,
   alors que `src/events/TimerSet.ts` existe précisément pour ça (et
   garantit que `clear()` atteint le scheduler d'origine).
3. La machine à états `recompute()` reste **volontairement** par protocole :
   les règles de préemption HSRP/VRRP/GLBP diffèrent réellement (HSRP a un
   standby explicite, VRRP a la règle priorité 255 = owner, GLBP gère
   AVG + AVF). Mutualiser serait une abstraction forcée — décision
   documentée ici.

### Correction

- `createIPv4Packet()` étendu avec `IPv4HeaderOptions` (`tos`, `flags`) —
  rétrocompatible.
- Nouveau `src/network/core/packetBuilders.ts` (pattern Factory) :
  `buildIpv4Frame()`, `buildUdpIpv4Frame()`, `wrapIpv4InEthernet()`,
  exportés via `core/index.ts`. Les trois agents FHRP l'utilisent ; les
  autres agents pourront migrer au fil de l'eau (chemin balisé).
- Les trois agents FHRP migrés sur `TimerSet` (suppression des champs
  `scheduler` et de la gestion manuelle des handles).
- Correction lint préexistante au passage (`no-useless-escape` dans la
  regex MAC de `core/types.ts`).

### Tests

8 tests dédiés `packet-builders.test.ts` (checksum valide, tos/flags,
longueurs UDP, payload vide, non-mutation) ; suites HSRP/VRRP/GLBP vertes ;
suite complète network-v2 : 252 fichiers / 6586 tests verts ; `tsc` propre.

---

## Entrée 5 — Arithmétique IPv4 canonique (`core/ip.ts`)

**Date** : 2026-06-10

### Défaillance constatée

Six implémentations indépendantes de la conversion IP↔uint32 et des calculs
de sous-réseau, avec des sémantiques de validation divergentes :

| Lieu | Forme | Validation |
|------|-------|------------|
| `OSPFEngine.ipToNumber` + `numberToIP` | méthode privée | aucune |
| `OSPFEngine` (élection DR, l.1582) | arrow inline `reduce` | aucune |
| `EIGRPEngine.toNum` | fonction module | retourne -1 |
| `BGPEngine.sameNet` | arrow inline | retourne -1 |
| `pim/types.ipToUint32` | export public | aucune |
| `CiscoOspfCommands.ipToNumber` | fonction module | aucune |

Risque concret : corriger un bug d'arrondi/signe dans une copie sans toucher
les cinq autres (les opérateurs `<<` signés exigent le `>>> 0` final — facile
à oublier dans une nouvelle copie).

### Correction

Nouveau module `src/network/core/ip.ts`, exporté via `core/index.ts` :
`ipToUint32` (fast path), `tryIpToUint32` (validant, null si malformé),
`uint32ToIp`, `prefixLengthToMaskUint32` (bornes clampées),
`networkAddress`, `inSameSubnet`, `wildcardMatches` (sémantique wildcard
Cisco documentée). Les six sites migrent dessus ; `pim/types.ts` ré-exporte
la fonction canonique pour ses appelants existants ; les méthodes privées
d'OSPF deviennent de simples délégations (diff minimal, zéro logique
dupliquée).

### Tests

`core-ip-helpers.test.ts` : 11 tests de bornes (0.0.0.0, 255.255.255.255,
octets > 127 / non-signé, /0, /32, préfixes hors plage clampés, quads
malformés rejetés, wildcard 0.0.0.0 = host exact, 255.255.255.255 = tout).
Non-régression : network-v2 + events = 279 fichiers / 6836 tests verts.

---

## Entrée 6 — Devices : `AgentRegistry` (cycle de vie des agents)

**Date** : 2026-06-10

### Défaillance constatée

CiscoRouter (18 agents), HuaweiRouter (15), CiscoSwitch (10), HuaweiSwitch
(4) répétaient : une ligne `.start()` par agent dans le constructeur, et dans
`setEventBus()` une litanie `if (this.xAgent) { this.xAgent.stop();
this.xAgent.start(); }` (~70 lignes au total, ordres de redémarrage
incohérents entre fichiers). Ajouter un agent = 3 modifications par device
(Shotgun Surgery).

### Correction

Nouveau `src/network/devices/AgentRegistry.ts` (pattern Registry) :
`register()`/`registerAll()` (enregistrent sans démarrer, préservant la
sémantique « tout construire puis tout démarrer »), `startAll()`,
`stopAll()`, `restartAll()`. Les 4 devices listent leurs agents une seule
fois ; `setEventBus()` se réduit à `super.setEventBus(bus);
this.agents?.restartAll();` (optional chaining car le constructeur de base
peut déclencher `setEventBus` avant l'initialisation des champs — c'est la
raison d'être des anciens `if (this.xAgent)`). Les getters publics
(`getStpAgent()`, …) sont inchangés — aucune rupture d'API. ~60 lignes de
boilerplate supprimées.

### Tests

5 tests `agent-registry.test.ts` (ordre de démarrage, registre vide,
restart stop→start par agent, retour inline de `register`). Suite complète
network-v2 verte : 254 fichiers / 6602 tests.

---

## Entrée 7 — Devices : convertisseurs NeighborDTO centralisés

**Date** : 2026-06-10

### Défaillance constatée

`lldpToNeighborDTO()` copié-collé à l'identique dans 4 fichiers
(CiscoRouter, HuaweiRouter, CiscoSwitch, HuaweiSwitch) et
`cdpToNeighborDTO()` dans 2 (devices Cisco) — six fonctions module-scope
identiques. Tout changement du schéma `NeighborDTO` (ou de la règle de
mapping capacités LLDP → Router/Switch/Host) imposait 6 éditions.

### Correction

Module unique `src/network/devices/inspection/neighborConverters.ts` ;
les 4 devices importent les fonctions partagées, les copies locales et les
imports de types devenus inutiles sont supprimés (~60 lignes).

### Tests

5 tests directs des convertisseurs (troncature de plateforme à la première
virgule, description sans virgule conservée, mapping Router/Bridge/autre →
Router/Switch/Host, capacités vides, table vide, projection CDP champ à
champ) + non-régression CDP/LLDP/STP.

---

## Entrée 8 — BGP : AS_PATH, propagation transitive, prévention de boucle

**Date** : 2026-06-10

### Défaillance constatée

1. **Pas de propagation transitive** : `computeRoutes` n'installait que les
   préfixes *directement originés* par les voisins directs. Dans une chaîne
   A—B—C, A n'apprenait jamais les réseaux de C — irréaliste pour BGP dont
   c'est la fonction première (path vector inter-AS).
2. **Pas d'AS_PATH** : aucune trace du chemin d'AS, donc ni détection de
   boucle (RFC 4271 §6.3) ni sélection du chemin le plus court (§9.1.2.2).
3. **`show ip bgp` fabriqué** : la table affichait les statements `network`
   même sans route connectée derrière (l'IOS réel n'installe un statement
   que s'il est couvert par une route de la RIB), et tous les chemins
   étaient affichés `i` sans path.

### Correction

- `BGPEngine.collectRib()` : RIB locale avec AS_PATH, alimentée
  récursivement par `advertisedTo(receiverAsn)` des pairs Established.
  Sémantiques RFC 4271 implémentées :
  - §6.3 : rejet à la réception de tout chemin contenant son propre ASN ;
  - §5.1.2 : prepend du propre ASN à l'annonce eBGP, AS_PATH inchangé en
    iBGP ;
  - §9.1.2.2 (sous-ensemble) : à préfixe égal, AS_PATH le plus court gagne ;
  - §9.2.1.1 : split-horizon iBGP (une route apprise d'un pair iBGP n'est
    pas relayée à un autre pair iBGP — hypothèse full-mesh).
- Garde de récursion par *chemin* (copie du `visited` par branche) : la
  marche dans le graphe d'engines ne boucle pas, sans élaguer les chemins
  alternatifs légitimes via des voisins frères.
- `getBgpTable()` expose la table réelle (préfixe, next-hop, AS_PATH, poids
  32768 pour l'originé local) ; `show ip bgp` l'affiche désormais (vrais
  paths, plus de fabrication).
- `AbstractRoutingProtocolEngine` : accesseur protégé `locatePeers()` pour
  les calculs récursifs des sous-classes.

### Décision documentée

La FSM 6 états complète (Connect/OpenConfirm) n'est **pas** simulée : le
moteur dérive l'état de la topologie de façon synchrone (philosophie « état
vrai, jamais fabriqué » du moteur). Simuler des phases TCP/OPEN qui
n'existent pas serait de la fabrication ; cela nécessiterait un moteur
asynchrone à acteurs (comme OSPF) — noté en dette restante.

### Tests

7 nouveaux tests : propagation 2 sauts (A apprend C via B, next-hop = B),
AS_PATH ordonné [65002, 65003], originé local (path vide, weight 32768),
boucle triangle rejetée (A ne réapprend jamais son préfixe), chemin le plus
court préféré, split-horizon iBGP en chaîne (A ne voit pas C), AS traversé
deux fois rejeté (A—B—A'). 1 test CLI mis à jour (il assertait l'affichage
fabriqué : statement `network` non couvert visible) — remplacé par le
comportement IOS réel avec assertions complémentaires. Suite complète :
255 fichiers / 6614 tests verts.

---

## Entrée 9 — Shell/terminal : dispatch polymorphique au lieu de `constructor.name`

**Date** : 2026-06-10

### Défaillance constatée

Cinq sites comparaient `dev.constructor.name` à des littéraux
(`'WindowsPC'`, `'CiscoRouter'`, …) pour choisir le shell, le cwd SSH ou la
stratégie de prompt distant : `sshLauncher.pickPrimaryShellKind`,
`ShellFactory.defaultCwdFor`, `WindowsTerminalSession.pickRemoteStrategy` +
`pickPrimaryShellKind`, `LinuxTerminalSession.pickVendorPromptStrategy`.
Conséquences : danger de minification (d'où le `keepNames: true` forcé dans
`vite.config.ts`), et ajout d'un vendor = 5 dispatchers à modifier. Or le
hook polymorphique existait déjà : `Equipment.getOSType()` est surchargé
par toutes les classes devices ('cisco-ios', 'huawei-vrp', 'windows',
'linux', 'generic') — le sniffing de nom de classe était redondant.

### Correction

- Nouveau `src/shell/shellKind.ts` : `primaryShellKindFor(dev)` — unique
  mapping `getOSType()` → `'bash' | 'cmd' | 'cisco-ios' | 'huawei-vrp'`.
- `strategyForShellKind()` dans `RemoteDeviceSubShell.ts` (à côté des
  stratégies) : unique mapping kind → stratégie de prompt.
- Les 5 sites délèguent ; comportements identiques (vérifié cas par cas :
  GenericSwitch → bash, WindowsServer → cmd, mac-pc → bash).
- Commentaire `keepNames` de `vite.config.ts` mis à jour : ce n'est plus
  qu'une garde défensive (suppression possible après une vérification du
  build minifié — non faite ici, notée en dette).

### Tests

Non-régression : shell + terminal + terminal-core + suites SSH LAN =
2029 tests verts (l'unique échec `duplicate-display-fixes` est le
préexistant déjà documenté en entrée 2).

---

## Entrée 10 — Consolidation des branches : best-path RFC 4271 §9.1.1 × propagation transitive

**Date** : 2026-06-11

### Contexte

Reprise du travail : consigne de merger toutes les branches disponibles dans
`mandeng` avant de continuer. État des lieux des branches distantes :

- `origin/main` : contenu identique à `mandeng` (seul le commit de merge de
  la PR #307 manquait) — fast-forward.
- `origin/claude/awesome-shannon-zyqb1r` (4 commits, 2026-06-10) : série
  « propagation transitive BGP + dispatch shell polymorphique » (entrées 8–9
  de ce journal) — **mergée**, conflits résolus (voir ci-dessous).
- `origin/claude/general-session-6Nwqo` et
  `origin/claude/fix-powershell-tests-M4mpL` : **aucun ancêtre commun** avec
  `mandeng` (historique du dépôt réécrit depuis), dernier commit 2026-05-13/16,
  donc antérieures à toute la série de refactoring. Les merger (en
  `--allow-unrelated-histories`) écraserait un mois de travail plus récent —
  **écartées volontairement**, décision documentée ici.
- Les 14 autres branches `claude/*` : déjà entièrement contenues dans
  `mandeng` (0 commit d'avance).

### Conflit de fond résolu (pas un simple conflit textuel)

`mandeng` et la branche entrante avaient chacune réécrit
`BGPEngine.computeRoutes` dans deux directions complémentaires :

- `mandeng` : sélection de meilleur chemin **complète** RFC 4271 §9.1.1
  (`bestPath.ts` : weight Cisco, LOCAL_PREF, originé local, longueur
  d'AS_PATH, origin, MED, eBGP>iBGP, router-id, IP du pair) — mais
  uniquement sur les préfixes originés par les voisins **directs** (modèle
  1 saut, pas de propagation).
- branche entrante : propagation **transitive** avec AS_PATH réel,
  prévention de boucle §6.3 et split-horizon iBGP — mais sélection réduite
  au plus court AS_PATH.

Choisir un camp aurait perdu la moitié du travail. La résolution **unifie**
les deux : `collectRib()` propage transitivement (AS_PATH, §6.3,
split-horizon) et arbitre chaque préfixe via `compareBgpPaths()` (§9.1.1
complet). Au passage :

- `BgpAdvertisedRoute` transporte désormais LOCAL_PREF/origin/MED, ce qui
  implémente correctement la portée du LOCAL_PREF (§5.1.5 : préservé en
  iBGP, réinitialisé au défaut local en eBGP) — aucune des deux branches ne
  le faisait sur le chemin transitif ;
- les entrées originées portent weight 32768 / LOCAL_PREF local / origin
  IGP, et participent à la sélection comme sur un vrai IOS ;
- `getBgpTable()` expose weight et LOCAL_PREF réels par route (plus de
  32768 codé en dur au moment de l'affichage).

### Tests

Les **deux** suites de tests en conflit sont conservées intégralement
(best-path §9.1.1 : 6 tests ; propagation AS_PATH : 7 tests) — les 21 tests
BGP passent sur le moteur unifié sans modification d'aucune assertion, ce
qui valide que la fusion ne sacrifie aucun comportement.

Suite complète : 13 648 verts, 9 échecs préexistants (vérifié en rejouant
les fichiers concernés sur le HEAD pré-merge via worktree).

---

## Backlog de la série « PC » (audit du 2026-06-11)

Audit en trois axes (pile Linux PC, pile Windows PC, UI/store), constats
vérifiés sur pièces avant inscription (2 faux positifs d'audit écartés :
l'espacement `(Preferred)` d'ipconfig est fidèle au vrai Windows ; les
abonnements TerminalManager/TerminalSession sont correctement nettoyés).

| # | Sujet | Référence | Sévérité | Statut |
|---|-------|-----------|----------|--------|
| P1 | EndHost : signaux NDP/routes/stats morts (self-casts `ndpCache` inexistant, schéma routes divergent) + `arp.opcode` inexistant | Typage / observabilité | Haute | ✅ Entrée 11 |
| P2 | `ping6` listé mais sans handler ; moteur ICMPv6 (`executePing6Sequence`) orphelin ; NS depuis link-local uniquement ; réponse écho silencieusement abandonnée sans entrée NDP | RFC 4861 §7.2.2 | Haute | ✅ Entrée 11 |
| P3 | `ifconfig` fabrique compteurs RX/TX (`Math.random()`), IPv6 inventée (`fe80::N`), broadcast par regex (faux hors /24), flags incohérents | Réalisme / RFC 2863 | Haute | À faire |
| P4 | IPv6 invisible : `ip addr` sans inet6, pas de `ip -6 route` malgré la table v6 réelle | Réalisme | Moyenne | À faire |
| P5 | WinIpconfig : `isDHCP ? 'Yes' : 'Yes'` (adaptateur déconnecté) | Bug | Moyenne | À faire |
| P6 | `netsh dhcpclient release/renew` cosmétique (ne touche pas le client DHCP réel, contrairement à `ipconfig /release`) | Réalisme | Moyenne | À faire |
| P7 | `parseCommandLine` (WindowsPC) ≡ `splitArgs` (CmdSubShell) dupliqués | DRY | Moyenne | À faire |
| P8 | Type de device en triple exemplaire (union `DeviceType`, `DEVICE_TYPE_TO_OS_TYPE`, `DEVICE_CATEGORIES`) | SSOT/Registry | Moyenne | À faire |
| P9 | Mapping Port→config UI dupliqué (networkStore / topologySerializer) | DRY | Basse | À faire |
| P10 | `Connection.isActive` toujours `true` mais badge Actif/Inactif rendu | Dead code | Basse | À faire |
| P11 | Equipment : 11 stubs terminal sur tous les devices (ISP, backlog #10 série 1) | SOLID | Moyenne | À faire |
| P12 | NUD : 5 états déclarés (RFC 4861 §7.3), 2 utilisés, pas de machine à états | RFC 4861 | Moyenne | À faire |

---

## Entrée 11 — EndHost : signaux d'observabilité morts + ping6 orphelin (NDP RFC 4861)

**Date** : 2026-06-11

### Défaillances constatées

1. **Trois signaux UI morts par dérive de schéma masquée**. Les méthodes
   `_refreshNdpSignal`/`_refreshRoutesSignal`/`_refreshHostStatsSignal`
   d'`EndHost` accédaient à leurs **propres champs** via
   `(this as unknown as { ndpCache?: … })` :
   - le champ s'appelle `neighborCache`, pas `ndpCache` → le signal NDP et
     `ndpCacheSize` n'ont jamais quitté leur état initial vide ;
   - `projectHostRoutes` attendait `destination`/`gateway` alors que
     `HostRouteEntry` porte `network`/`nextHop` → le signal routes projetait
     littéralement `"undefined"`.
   Le self-cast court-circuitait précisément la vérification que le
   compilateur aurait faite. Correction : accès direct aux champs (ils sont
   déclarés dans la même classe), `HostRouteLike` aligné sur le vrai schéma
   producteur — toute dérive future est désormais une erreur `tsc`.
2. **`arp.opcode` inexistant** (`ARPPacket.operation` est une union de
   chaînes) : l'événement `host.arp.entry-learned` étiquetait toutes les
   entrées `source: 'reply'`.
3. **`ping6` annoncé mais mort** : présent dans la liste des commandes
   connues de `LinuxCommandExecutor` mais sans handler → « command not
   found ». Le moteur ICMPv6 complet d'`EndHost`
   (`executePing6Sequence` : résolution NDP + LPM v6 + RTT) n'était
   **appelé nulle part**.
4. En le câblant, deux bugs protocolaires sont apparus :
   - `resolveNDP` émettait la Neighbor Solicitation **toujours depuis la
     link-local**, contrairement à RFC 4861 §7.2.2 (la source de la NS doit
     être l'adresse du trafic en attente). Conséquence : le pair n'apprenait
     que `fe80::…%eth0` et ne savait pas répondre à l'adresse globale.
   - La réponse écho était **silencieusement abandonnée** si le next-hop
     n'était pas dans le cache de voisinage (`if (dstMAC)` sans else), au
     lieu de déclencher une résolution (RFC 4861 : file d'attente pendant
     la résolution).

### Corrections

- Refresh des signaux par accès direct typé ; `HostRouteLike` documenté
  comme miroir de `HostRouteEntry`.
- `ping6` + `ping -6` + auto-détection de famille sur cible littérale v6
  (comportement iputils, où ping6 est un alias de ping) : nouvelle commande
  `ping6Command` partageant `runPing` avec `pingCommand` (zéro duplication),
  `ping6Sequence` ajouté au contrat `LinuxNetKernel`, formateur
  `formatPing6Output` fidèle à iputils (`PING x(x) 56 data bytes`) avec
  corps commun `renderPingBody` extrait (DRY avec le formateur v4).
- `resolveNDP` : sélection de source RFC 4861 §7.2.2 (globale pour cible
  globale, link-local pour cible link-local).
- Réponse écho ICMPv6 : résolution NDP asynchrone sur cache miss au lieu
  du drop silencieux.

### Tests

- `host-observables-signals.test.ts` (4) : ARP/routes/stats/NDP projettent
  l'état réel (plus de `"undefined"`, cache NDP non vide après ping6).
- `ping6-command.test.ts` (5) : ping6 on-link via vraie NDP, équivalence
  `ping -6`/littéral v6, unreachable honnête, nom insoluble, self-ping.
- Non-régression : suite network-v2 complète + `tsc --noEmit` propre.

---

## Validation finale de la série

- `npm run build` : ✅ build de production OK.
- Suite unitaire complète (`src/__tests__/unit/`) : **13 216 tests verts**,
  13 échecs **tous préexistants** (vérifié en rejouant les 4 fichiers
  concernés sur le commit de base `ac13a7e` via un worktree : mêmes 13
  échecs — Oracle access-management ×3, PowerShell DateTime/pushd ×9,
  terminal sudo-prompt ×1). Zéro régression introduite.
- ESLint : les fichiers touchés par la série sont propres ; les ~780
  erreurs restantes sont le baseline préexistant du repo (hors périmètre).

---

## Limites connues / dette restante

- **Backlog #8 et #10** (dispatch `constructor.name`, ISP sur `Equipment`) :
  identifiés, documentés, non traités dans cette série.
- **BGP** : ~~best-path limité au plus court AS_PATH~~ (soldé en entrée 10 :
  échelle §9.1.1 complète sur les chemins transitifs) ; pas de
  route-reflectors ; FSM dérivée synchrone (pas de phases Connect/OpenConfirm
  — exigerait un moteur asynchrone à acteurs comme OSPF).
- **STP** : RSTP (802.1w) et PVST+ ne sont pas implémentés ; le fast path
  « premier bring-up » simule un comportement type RSTP pour préserver
  l'utilisabilité (décision documentée dans le code).
- **GRE** : checksum non standard (hash JSON) — toléré car purement interne
  à la simulation, signalé ici pour transparence.
- Les firewalls (`firewall-*`), `access-point` et `cloud` restent des stubs
  (`LinuxPC`/`Hub`) — hors périmètre de cette série, à traiter comme des
  fonctionnalités à part entière.
