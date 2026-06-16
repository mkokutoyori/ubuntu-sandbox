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
| 10 | Equipment.ts : 11 méthodes « terminal » stub polluent routeurs/switches | ISP (SOLID) | Moyenne | ✅ Corrigé (Série 3, entrée 12) |

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

### Note de réconciliation (merge du 2026-06-11, suite)

Deux sessions parallèles ont produit **chacune** cette unification BGP
(celle-ci sur `mandeng`, l'autre sur `claude/friendly-babbage-plxyqc`).
Au merge des deux branches, la variante `mandeng` du moteur a été retenue
car elle transporte LOCAL_PREF/origin/MED dans `BgpAdvertisedRoute`
(portée du LOCAL_PREF §5.1.5 réellement implémentée sur le chemin
transitif), là où la variante parallèle les recodait en dur à la
réception. Le reste de la branche parallèle (backlog « PC » ci-dessous,
entrée 11) est intégré tel quel.

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
| P3 | `ifconfig` fabrique compteurs RX/TX (`Math.random()`), IPv6 inventée (`fe80::N`), broadcast par regex (faux hors /24), flags incohérents | Réalisme / RFC 2863 | Haute | ✅ Entrée 18 |
| P4 | IPv6 invisible : `ip addr` sans inet6, pas de `ip -6 route` malgré la table v6 réelle | Réalisme | Moyenne | ✅ Entrée 18 |
| P5 | WinIpconfig : `isDHCP ? 'Yes' : 'Yes'` (adaptateur déconnecté) | Bug | Moyenne | ✅ Entrée 19 |
| P6 | `netsh dhcpclient release/renew` cosmétique (ne touche pas le client DHCP réel, contrairement à `ipconfig /release`) | Réalisme | Moyenne | ✅ Entrée 19 |
| P7 | `parseCommandLine` (WindowsPC) ≡ `splitArgs` (CmdSubShell) dupliqués | DRY | Moyenne | ✅ Entrée 14 (session parallèle) |
| P8 | Type de device en triple exemplaire (union `DeviceType`, `DEVICE_TYPE_TO_OS_TYPE`, `DEVICE_CATEGORIES`) | SSOT/Registry | Moyenne | ✅ Entrée 25 |
| P9 | Mapping Port→config UI dupliqué (networkStore / topologySerializer) | DRY | Basse | ✅ Entrée 21 |
| P10 | `Connection.isActive` toujours `true` mais badge Actif/Inactif rendu | Dead code | Basse | ✅ Entrée 21 |
| P11 | Equipment : 11 stubs terminal sur tous les devices (ISP, backlog #10 série 1) | SOLID | Moyenne | ✅ Entrée 12 (session parallèle) |
| P12 | NUD : 5 états déclarés (RFC 4861 §7.3), 2 utilisés, pas de machine à états | RFC 4861 | Moyenne | ✅ Entrée 20 |

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

## Entrée 18 — ifconfig honnête + IPv6 visible (P3, P4) et adaptateur ip unifié

**Date** : 2026-06-12

### Préambule — consolidation des branches (consigne de session)

Avant cette entrée, fusion de **toutes** les branches distantes dans
`mandeng` (désormais la base de travail) :

- `origin/main` (merges PR #308/#309) — trivial.
- `claude/friendly-babbage-plxyqc` (entrée 11, backlog P1-P12) — conflit
  BGPEngine résolu en faveur de la variante `mandeng` (§5.1.5 : les
  attributs LOCAL_PREF/origin/MED voyagent dans `BgpAdvertisedRoute`
  au lieu d'être recodés en dur à la réception). 26 tests verts.
- `claude/keen-babbage-krj5ab` (série Oracle O1-O8) — même résolution
  BGP ; 2698 tests database verts.
- `claude/keen-babbage-yzw42r` (série Oracle 3 : démantèlement de la god
  class `OracleExecutor`, DBID/SCN réels, SPOOL/@scripts, SGA dynamique ;
  contient aussi le merge conservateur des deux branches de mai sans
  ancêtre commun) — conflit d'import résolu (`OracleConfig` déplacé dans
  la couche database + import DataPumpEngine conservé). 2715 tests verts.

Après fusion : `git rev-list --count mandeng..<branche>` = 0 pour les
19 branches distantes — plus aucun travail orphelin.

### Défaillances corrigées (P3 + P4)

1. **`LinuxCommandExecutor` → `cmdIfconfig` fabriquait sa sortie** :
   compteurs RX/TX tirés à `Math.random()` à chaque invocation (deux
   `ifconfig` consécutifs montraient un trafic différent sans qu'aucune
   trame ne circule), adresse IPv6 inventée `fe80::N` (N = index du port),
   broadcast calculé par regex `\.\d+$` → `.255` (faux pour tout préfixe
   hors /24), `flags=4163<UP,...>` même interface DOWN. Le comble : le
   `netstat -i` du même fichier lisait déjà les **vrais compteurs**
   (`info.counters`, incrémentés par les trames qui traversent réellement
   les `Cable`/`Port`).
2. **Deux rendus ifconfig divergents** : `LinuxFormatHelpers.formatInterface`
   (chemin registre, LinuxPC/LinuxServer) affichait un format tronqué
   (pas de broadcast, pas d'inet6, pas de lignes erreurs, `flags=4099`
   codé en dur pour DOWN au lieu de 4098, `inet (not configured)` qui
   n'existe pas dans net-tools).
3. **IPv6 réel invisible (P4)** : la pile NDP/RFC 4861 d'`EndHost` est
   réelle (cache de voisinage, table de routage v6, EUI-64) mais ni
   `ip addr`, ni `ip -6 route`, ni `ifconfig` ne la montraient.
4. **Adaptateur Port→contexte dupliqué** : `LinuxMachine.buildIpNetworkContext`
   (170 lignes) ≡ `buildIpCtx` de `commands/net/Ip.ts` — deux copies du
   même mapping, dérive garantie.

### Corrections

- `core/ip.ts` : `broadcastAddress(ip, prefixLength)` canonique (null
  pour /31-/32, conforme RFC 3021) ; remplace la regex et le calcul local
  de `LinuxIpCommand.computeBroadcast`.
- `IpInterfaceInfo.ipv6` + `IpNetworkContext.getIPv6RoutingTable()` :
  le contrat expose les adresses v6 réelles des ports
  (`port.getIPv6Addresses()`) et la vraie table v6 (`HostIPv6RouteEntry`).
- `formatIfconfigInterface()` : rendu net-tools unique calculé depuis les
  bits réels net/if.h (IFF_UP/BROADCAST/LOOPBACK/RUNNING/MULTICAST) —
  UP sans porteuse = 4099 sans RUNNING, admin-down = 4098 sans UP, lo =
  73<UP,LOOPBACK,RUNNING>. Compteurs = `port.getCounters()` (trafic réel
  uniquement). inet6 seulement si une adresse existe. Les deux chemins
  (registre via `LinuxFormatHelpers`, executor via `cmdIfconfig`)
  délèguent au même renderer : octets identiques partout.
- `ifconfig` sans argument liste les interfaces admin-UP, `-a` inclut
  les down (comportement net-tools).
- `ip` : options de famille `-4`/`-6`/`-f inet|inet6` parsées ;
  `ip addr` affiche les lignes `inet6 .../64 scope link` réelles ;
  `ip -6 route` rend la table v6 réelle au format iproute2
  (`proto kernel|ra|static`, `pref medium`).
- `LinuxNetKernel.getIPv6RoutingTable()` ajouté au contrat ; suppression
  des 170 lignes dupliquées de `LinuxMachine.buildIpNetworkContext` au
  profit de l'unique `buildIpCtx(net, xfrm)` exporté.

### Tests

- `linux-lan-ssh-suite` : l'assertion `flags=4099` pour une interface
  admin-down corrigée en `flags=4098` (la valeur réelle de net-tools ;
  l'ancienne valeur correspondait à UP|BROADCAST|MULTICAST, incohérente
  avec un down).
- Non-régression : linux-ip-command (76), linux-lan-ssh-suite (216),
  arp-command + ping6 (72), network-v2 complète, `tsc --noEmit` propre.

---

## Entrée 19 — Windows : ipconfig /all véridique + netsh dhcpclient agissant (P5, P6)

**Date** : 2026-06-12

### Défaillances corrigées

1. **P5** : `ipconfig /all` sur un adaptateur en « Media disconnected »
   affichait `DHCP Enabled : Yes` inconditionnellement
   (`isDHCP ? 'Yes' : 'Yes'`) — un adaptateur configuré en statique
   apparaissait DHCP dès qu'il était débranché.
2. **P6** : `netsh dhcpclient release`/`renew` ne faisait que cocher un
   drapeau d'affichage local (`releasedIfaces`) : le bail DHCP réel
   n'était ni libéré ni renouvelé, contrairement à `ipconfig /release`
   qui passe par le vrai client (`releaseLease`/`requestLease`,
   DORA sur le câble, journal d'événements DHCP).

### Corrections

- `WinIpconfig` : `isDHCP ? 'Yes' : 'No'` sur le chemin déconnecté.
- `WinNetsh` : `release` libère le vrai bail (`ctx.releaseLease`,
  événement RELEASE, état client → INIT) ; `renew` relance la vraie
  découverte (`autoDiscoverDHCPServers` + `requestLease`, événement
  RENEW) — sur l'interface nommée ou toutes. Les messages de sortie et
  le rendu `show parameters` (Lease obtained/expired) sont inchangés.

### Tests

cmd-netsh + windows-netsh-dhcp-dns + windows-consistency : 251 verts.

---

## Entrée 20 — NDP : machine à états NUD complète (RFC 4861 §7.3) et cache unifié hôte/routeur (P12)

**Date** : 2026-06-12

### Défaillances constatées

1. **Machine à états fantôme** : `NeighborState` déclarait les 5 états du
   RFC 4861 (`incomplete | reachable | stale | delay | probe`) mais seuls
   `reachable` et `stale` étaient écrits, et aucune transition n'existait :
   - pas d'expiration `reachable → stale` (REACHABLE_TIME 30 s) — une
     entrée restait « reachable » pour toujours ;
   - pas de `stale → delay → probe` à l'utilisation : `resolveNDP`
     ignorait une entrée STALE (MAC pourtant utilisable) et relançait une
     NS multicast à chaque fois, l'inverse du comportement RFC §7.3.3 ;
   - pas de sondes unicast ni de suppression d'entrée injoignable ;
   - pas de confirmation de joignabilité par la couche supérieure
     (§7.3.1) : une réponse écho ne rafraîchissait rien.
2. **NS unique sans retransmission** : résolution = 1 seule NS multicast
   puis timeout sec, au lieu de MAX_MULTICAST_SOLICIT (3) espacées de
   RETRANS_TIMER (1 s).
3. **Cache NDP dupliqué** : `EndHost` et `IPv6DataPlane` (routeur)
   portaient chacun une `Map` + les mêmes blocs `set({state: 'stale'…})`
   copiés-collés (NS source, NA, RS/RA), avec une divergence déjà
   installée : l'hôte marquait la source d'un RA `reachable` (le RFC
   §6.3.4 impose STALE), le routeur n'apprenait pas `isRouter`.
4. `NeighborState`/`NeighborCacheEntry` définis en double (EndHost.ts et
   IPv6DataPlane.ts).

### Corrections

- Nouvelle classe `host/NeighborCache.ts` : machine à états complète,
  pilotée par le `IScheduler` injectable (testable en temps virtuel),
  hooks `sendUnicastSolicit`/`onLearned`/`onUnreachable` :
  - `learnFromSource` (NS/RS/RA source-LL) → STALE, en préservant
    l'état si la MAC est inchangée (§7.2.3) ;
  - `learnFromAdvertisement` → REACHABLE si sollicitée, STALE sinon,
    avec sémantique du flag Override (§7.2.5 : O=0 + MAC différente →
    MAC conservée, REACHABLE rétrogradé STALE) ;
  - expiration paresseuse REACHABLE→STALE à 30 s ;
  - `markUsed` : STALE → DELAY (5 s) → PROBE (3 NS unicast à 1 s) →
    suppression + `onUnreachable` ; la MAC en cache reste utilisée
    pendant la sonde (§7.3.3) ;
  - `confirmReachability` (§7.3.1) branchée sur la réception d'une
    réponse écho ICMPv6.
- `resolveNDP` : entrée STALE/DELAY/PROBE → MAC immédiate (plus de
  re-résolution superflue) ; cache miss → NS multicast retransmise
  jusqu'à 3 fois dans le budget de timeout.
- RA : source apprise STALE + `isRouter` (conforme §6.3.4).
- `EndHost` et `IPv6DataPlane` partagent la même classe ; types et
  constantes (REACHABLE_TIME, DELAY_FIRST_PROBE, RETRANS_TIMER,
  MAX_*_SOLICIT) définis une seule fois et ré-exportés aux anciens
  emplacements.
- Timers NUD libérés au `powerOff()`.

### Tests

- `ndp-nud-state-machine.test.ts` (15, temps virtuel) : transitions
  complètes, expiration, sondes, annulation par confirmation, Override,
  MAC changée, stop.
- Non-régression : ping6 + host-observables + suite network-v2 complète.

---

## Entrée 21 — UI/store : statut de lien dérivé du réel + fabrique de connexion unique (P9, P10)

**Date** : 2026-06-12

### Défaillances constatées

1. **P10** : `Connection.isActive` était écrit `true` à la création et
   plus jamais mis à jour — mais le panneau de propriétés affichait un
   badge « Active/Inactive » et `ConnectionLine` grisait les liens
   « inactifs » : de l'UI branchée sur une constante. Un `ifconfig eth0
   down`, un câble débranché ou un device éteint laissaient le badge
   au vert.
2. **P9** : le bloc « retrouver les ports → `new Cable` → `connect` →
   construire l'objet `Connection` » était copié-collé entre
   `networkStore.addConnection` et l'import de `topologySerializer`.

### Corrections

- Champ `isActive` supprimé du modèle : remplacé par
  `isConnectionActive(connection)` qui dérive l'état **du vrai
  matériel** au rendu : câble connecté + les deux ports admin-up + les
  deux équipements alimentés.
- `buildConnection(...)` : fabrique unique partagée par le store et le
  sérialiseur (import de topologie).
- `getConnectionDetails` et `ConnectionLine` consomment l'état dérivé.

### Tests

- Tests gui mis à jour : le cas « inactive » construit désormais un
  vrai câble non connecté (plus un booléen posé à la main) ; le cas
  « active » câble deux vrais `Port`.
- gui + react : 99 verts ; `tsc --noEmit` propre.

---

## Entrée 25 — Catalogue de devices : source unique de vérité (P8)

**Date** : 2026-06-12

### Défaillance constatée

Les caractéristiques d'un type d'équipement étaient éclatées en **cinq**
tables parallèles à maintenir à la main :

1. l'union `DeviceType` (core/types.ts) ;
2. `DEVICE_TYPE_TO_OS_TYPE` (Equipment.ts) — OS par type ;
3. `DEVICE_CATEGORIES` (core/types.ts) — palette UI (libellé,
   description, catégorie) ;
4. `hasTerminalSupport` (DeviceFactory) — switch de 14 cas ;
5. `isFullyImplemented` (DeviceFactory) — switch de 10 cas, plus les
   préfixes de nommage en dur dans `createDevice`.

Ajouter un type imposait de modifier 5 fichiers (shotgun surgery), et
rien ne garantissait leur cohérence.

### Correction

- Nouveau `core/deviceCatalog.ts` : `DEVICE_CATALOG: Record<DeviceType,
  DeviceDefinition>` — libellé, description, osType, préfixe de nom,
  capacité terminal, fidélité d'implémentation, catégorie de palette.
  `Record<DeviceType, …>` rend l'oubli d'un nouveau type **erreur de
  compilation**.
- Dérivés : `DEVICE_CATEGORIES` (palette) est construit depuis le
  catalogue ; `Equipment.getOSType`, `hasTerminalSupport`,
  `isFullyImplemented` et les préfixes de `createDevice` lisent le
  catalogue. Le switch de `createDevice` ne garde que le choix du
  constructeur (signatures hétérogènes), sans données dupliquées.
- `DeviceCategory` déplacé avec sa donnée ; ré-exports conservés via
  `core/index.ts` et `network/index.ts` (UI inchangée).

### Tests

gui + react + terminal : 479 verts ; network-v2 complète ;
`tsc --noEmit` propre.

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

## Série 2 (2026-06-11) — Focus Oracle

Note de base de travail : conformément à la consigne « merger toutes les
branches », la branche `claude/awesome-shannon-zyqb1r` (4 commits, série
du 2026-06-10) a été fusionnée sur `main` à jour. Le conflit sur
`BGPEngine.ts` a été résolu en **unifiant** les deux apports : propagation
transitive AS_PATH (branche) + sélection best-path RFC 4271 complète
weight/LOCAL_PREF/MED (main) ; LOCAL_PREF ne voyage que sur les sessions
iBGP (§5.1.5). Les branches `fix-powershell-tests-M4mpL` et
`general-session-6Nwqo` (mai 2026) n'ont **aucun ancêtre commun** avec le
`main` actuel (historique réécrit) : fusion impossible proprement, et leur
contenu a déjà été réintégré depuis via PRs — écartées, documenté ici.

### Backlog issu de l'audit Oracle (2026-06-11)

Audit complet du sous-système Oracle (`src/database/`, périphérie
SQL*Plus/RMAN/lsnrctl) contre le comportement réel d'Oracle Database et
les principes de design :

| # | Sujet | Référence | Sévérité | Statut |
|---|-------|-----------|----------|--------|
| O1 | Auto-commit DDL appliqué à 3 statements sur ~45 (CREATE/DROP TABLE, TRUNCATE seulement) | Oracle SQL Ref « Types of SQL Statements » | Haute | ✅ Corrigé |
| O2 | DROP INDEX/SEQUENCE/VIEW/TRIGGER/SYNONYM silencieux sur objet inexistant ; CREATE INDEX sans aucune validation | ORA-01418/02289/00942/04080/01434/00904/00955/01452 | Haute | ✅ Corrigé |
| O3 | ROWNUM affecté après filtrage WHERE (allégation d'audit) | Modèle row-source Oracle | — | ❎ Réfuté (voir O3) |
| O3b | Résultat vide : en-tête affiché au lieu de `no rows selected` ; erreurs au format `ERROR:` au lieu de `ERROR at line N:` | SQL*Plus réel | Moyenne | ✅ Corrigé |
| O4 | CURRVAL lisait le compteur global au lieu de la valeur de session | Séquences Oracle | Moyenne | ✅ Corrigé |
| O5 | ALTER DATABASE MOUNT/OPEN no-ops ; RESTRICT jamais appliqué ; V$INSTANCE.STATUS non conforme | Cycle de vie instance | Moyenne | ✅ Corrigé |
| O6 | Listener sans état + bug `status.running` sur string (lsnrctl/tnsping cassés) + transcripts copiés 3× | lsnrctl réel | Haute | ✅ Corrigé |
| O7 | OracleExecutor god class (4 400 lignes, dispatch switch 60+ cas) | SRP / Strategy | Haute (long terme) | À faire |
| O8 | Logique booléenne 2 valeurs au lieu de la logique ternaire SQL (LIKE/IN/BETWEEN/NOT) ; LIKE insensible à la casse ; CHECK non appliqués | Sémantique NULL Oracle | Haute | ✅ Corrigé |

### Entrée O1+O2 — DDL : auto-commit centralisé + enforcement des DROP/CREATE INDEX

**Date** : 2026-06-11

#### Défaillances constatées

1. **Auto-commit DDL incomplet** : Oracle committe implicitement la
   transaction courante avant **et** après chaque statement DDL (et le
   pré-commit survit même si le DDL échoue). Le simulateur ne le faisait
   que pour CREATE TABLE, DROP TABLE et TRUNCATE — trois copies du même
   `if (this.txn.isActive) this.executeCommit()` dans les handlers. Un
   `ROLLBACK` après `CREATE INDEX`, `GRANT`, `CREATE SEQUENCE`… annulait
   à tort les DML précédents.
2. **DROP silencieux** : `DROP INDEX/SEQUENCE/VIEW/SYNONYM` sur un objet
   inexistant répondaient « dropped. » — un test validait même ce
   comportement comme attendu. `DROP TRIGGER` levait une `Error` JS brute
   (pas un code ORA).
3. **CREATE INDEX sans validation** : table inexistante, colonne
   inexistante, nom d'index déjà pris, doublons sous index UNIQUE —
   tout passait avec « Index created. ».

#### Correction

- `DDL_STATEMENT_TYPES` (ensemble explicite, documenté d'après la
  classification du SQL Language Reference) + wrapping commit-avant /
  commit-après **centralisé dans `executeStatement()`** — suppression des
  trois copies dans les handlers. ALTER SYSTEM / ALTER SESSION /
  STARTUP / SHUTDOWN / LOCK TABLE / TCL explicitement exclus (ce ne sont
  pas des DDL : ils ne committent jamais dans le vrai Oracle).
- Enforcement réel : ORA-00942 (table absente), ORA-00904 (colonne
  absente), ORA-00955 (nom déjà utilisé), ORA-01452 (doublons sous
  UNIQUE, clés entièrement NULL exclues comme dans le vrai moteur),
  ORA-01418 (DROP INDEX), ORA-02289 (DROP SEQUENCE), ORA-00942
  (DROP VIEW), ORA-04080 (DROP TRIGGER), ORA-01432/01434 (DROP SYNONYM
  public/privé).
- Deux tests qui figeaient le comportement défaillant (« drop silencieux »)
  mis en conformité avec le vrai comportement Oracle.

**Fichiers** : `src/database/oracle/OracleExecutor.ts`,
`src/__tests__/unit/database/oracle-ddl-autocommit.test.ts` (nouveau, 13
tests), `oracle-object-management.test.ts`.

**Validation** : suite database complète **2609 tests verts** (baseline
2593 avant la série, zéro échec), terminal 380 verts, ESLint propre sur
les fichiers touchés.

### Entrée O3 — ROWNUM : allégation réfutée + fidélité de sortie SQL*Plus

**Date** : 2026-06-11

#### Vérification ROWNUM (réfutation)

L'audit initial suspectait que ROWNUM était affecté *après* le filtrage
WHERE. **Vérification empirique : faux.** Le simulateur implémente déjà le
modèle row-source réel (`OracleExecutor.executeSelectFromTable`, étape
WHERE) : le compteur ne s'incrémente que lorsqu'une ligne est acceptée.
`WHERE ROWNUM > 1` → 0 ligne, `ROWNUM = 2` → 0 ligne, `ROWNUM <= N` →
N premières lignes, affectation avant ORDER BY. Ce comportement n'était
couvert par **aucun test** — il est désormais verrouillé par 5 tests de
régression.

#### Défaillances réellement constatées (et corrigées)

1. **Résultat vide** : le simulateur affichait l'en-tête de colonnes et
   rien d'autre. Le vrai SQL*Plus n'affiche *pas* d'en-tête et imprime
   `no rows selected` (supprimé par `SET FEEDBACK OFF`).
2. **Format d'erreur** : les erreurs de statement sortaient comme
   `ERROR:\nORA-…`. Le vrai SQL*Plus écho la ligne source fautive, place
   un astérisque sous la colonne en faute, puis `ERROR at line N:` et le
   message ORA-/PLS-. Implémenté dans `renderSqlError()` : position
   exploitée pour `ParserError` (ligne/colonne) et `DatabaseError.position`
   (offset caractère) ; repli ligne 1 / colonne 1 sinon — comme le client réel.
3. 18 cas du test access-management validaient l'ancien comportement
   (en-tête sur vue vide comme preuve d'existence) ; mis à jour pour
   accepter `no rows selected` — qui prouve toujours l'existence de la vue
   et des colonnes (sinon ORA-00942/00904).

**Fichiers** : `src/database/oracle/commands/SQLPlusSession.ts`,
`src/__tests__/unit/database/oracle-rownum-and-error-format.test.ts`
(nouveau, 9 tests), `oracle-access-management-comprehensive.test.ts`.

**Validation** : database + terminal = **2998 tests verts**, zéro échec.

### Entrée O4 — Séquences : CURRVAL par session, ORA-02289 réels

**Date** : 2026-06-11

#### Défaillances constatées

1. **CURRVAL non conforme** : `storage.currVal()` retournait le compteur
   **global** de la séquence. Si la session B faisait `NEXTVAL` après la
   session A, le `CURRVAL` de A renvoyait la valeur de B. Dans Oracle,
   CURRVAL est strictement « la dernière valeur obtenue par MA session ».
   (Le garde-fou ORA-08002 était, lui, correctement par session.)
2. **Logique dupliquée** : l'évaluation NEXTVAL/CURRVAL était copiée dans
   deux branches de `evaluateExpression` (`Identifier` à trois parties et
   `SequenceExpr`), avec le même montage de clé et les mêmes erreurs.
3. **Séquence absente** : NEXTVAL/CURRVAL sur séquence inexistante levait
   une `Error` JS générique (affichée ORA-00900) au lieu d'ORA-02289 ;
   `CURRVAL` après `DROP SEQUENCE` renvoyait la valeur périmée.

#### Correction

Helpers uniques `sequenceNextVal()` / `sequenceCurrVal()` :
`_sessionCurrval: Map<string, number>` mémorise la dernière valeur tirée
par session (l'exécuteur est par session) ; le compteur global reste dans
le stockage partagé ; ORA-02289 sur séquence absente ou supprimée,
ORA-08002 avant le premier NEXTVAL de la session. Les deux branches
d'évaluation délèguent aux helpers (duplication supprimée).

**Fichiers** : `src/database/oracle/OracleExecutor.ts`,
`src/__tests__/unit/database/oracle-sequence-session-state.test.ts`
(nouveau, 4 tests dont un scénario réellement multi-sessions).

**Validation** : suite database **2622 tests verts**, zéro échec.

### Entrée O5 — Cycle de vie de l'instance : machine à états réelle + RESTRICTED SESSION effectif

**Date** : 2026-06-11

#### Défaillances constatées

1. `ALTER DATABASE OPEN` répondait « Database altered. » **sans changer
   d'état** ; `ALTER DATABASE MOUNT` n'était même pas traité (no-op du
   fallback). Le passage manuel NOMOUNT → MOUNT → OPEN — le geste DBA le
   plus fondamental — était impossible.
2. `ALTER SYSTEM ENABLE/DISABLE RESTRICTED SESSION` était un no-op : le
   setter `setRestrictedSession()` existait, la vue V$INSTANCE le lisait…
   mais personne ne l'appelait jamais. `STARTUP RESTRICT` affichait
   « restricted mode » sans activer le mode. Aucun enforcement au logon.
3. `V$INSTANCE.STATUS` exposait les états internes `NOMOUNT`/`MOUNT` au
   lieu des valeurs réelles `STARTED`/`MOUNTED` ; `DATABASE_STATUS`
   affichait `SUSPENDED` hors OPEN (SUSPENDED = ALTER SYSTEM SUSPEND,
   pas « pas encore ouvert »).

#### Correction

- `OracleInstance.mountDatabase()` / `openDatabase()` : transitions
  validées — ORA-01100 (déjà monté), ORA-01507 (non monté), ORA-01531
  (déjà ouvert). Le bloc OPEN de `startup()` factorisé dans `markOpen()`
  (réutilisé par `ALTER DATABASE OPEN`, événements de service compris).
- RESTRICT effectif : `STARTUP RESTRICT` active le drapeau, `SHUTDOWN` le
  réinitialise, `ALTER SYSTEM ENABLE/DISABLE RESTRICTED SESSION` le
  bascule, et `OracleDatabase.connect()` refuse avec **ORA-01035** tout
  utilisateur sans le privilège RESTRICTED SESSION (SYSDBA passe par
  `connectAsSysdba`, non concerné — comme en vrai).
- V$INSTANCE : mapping STATUS conforme, DATABASE_STATUS=ACTIVE.

**Fichiers** : `src/database/oracle/OracleInstance.ts`,
`OracleExecutor.ts`, `OracleDatabase.ts`, `views/v_instance.ts`,
`src/__tests__/unit/database/oracle-instance-state-machine.test.ts`
(nouveau, 8 tests).

**Validation** : suite database **2630 tests verts**, zéro échec.

### Entrée O6 — Listener TNS avec état réel (`ListenerControl`)

**Date** : 2026-06-11

#### Défaillances constatées

1. **Bug fonctionnel pur** : `handleLsnrctl` et `tnsping` testaient
   `status.running` sur la **string** retournée par
   `getListenerStatus()` → toujours `undefined` → `lsnrctl status` et
   `tnsping` répondaient **toujours** TNS-12541, même listener démarré.
2. **Aucun état réel** : un booléen running/stopped ; `status READY`
   affiché même instance arrêtée (le vrai listener n'a aucun service
   enregistré dans ce cas) ; uptime figé « 0 hr. 5 min. » ; Start Date
   du listener = startup time de l'**instance** ; compteurs
   `established:0 refused:0` câblés en dur.
3. **Transcripts copiés 3×** (startListener, getListenerStatus,
   handleLsnrctl) avec divergences entre les copies.
4. `CONNECT user/pass@alias` : l'alias était **silencieusement jeté**
   (« Strip @tns_alias from password ») — aucune différence entre
   connexion bequeath locale et connexion via listener.

#### Correction

- Nouvelle classe `ListenerControl` (`src/database/oracle/listener/`) —
  source unique de vérité : cycle de vie (vraie date de démarrage, uptime
  calculé), **enregistrement dynamique de service dérivé de l'état vivant
  de l'instance** (down → « The listener supports no services » ;
  NOMOUNT/MOUNT → BLOCKED ; OPEN → READY), compteurs established/refused
  réels, et tous les corps de transcripts lsnrctl.
- `OracleInstance` délègue (API publique conservée, events bus conservés) ;
  `handleLsnrctl`/`tnsping` consomment `ListenerControl` (bug
  `status.running` éliminé avec la duplication).
- `CONNECT user/pass@alias` passe par `listener.attemptConnect()` avec la
  vraie échelle d'erreurs : ORA-12541 (pas de listener), ORA-12514
  (service inconnu), ORA-12528 (instance BLOCKED) ; les connexions
  locales sans @ restent bequeath (pas de listener — comme en vrai).
- Provisioning : le listener est auto-démarré avec l'instance (équivalent
  dbstart/systemd) pour préserver l'utilisabilité des labs ;
  `lsnrctl stop` le coupe réellement. 2 tests qui figeaient l'ancien
  comportement mis à jour (« strips TNS alias », « listener stopped par
  défaut »).

**Fichiers** : `src/database/oracle/listener/ListenerControl.ts` (nouveau),
`OracleInstance.ts`, `OracleCommands.ts`, `SQLPlusSession.ts`,
`database.ts`, `oracle-listener-state.test.ts` (nouveau, 7 tests),
`oracle-sqlplus-commands.test.ts`, `oracle-systemd-integration.test.ts`.

**Validation** : database + terminal = **3018 tests verts**, zéro échec ;
suites SSH LAN utilisant lsnrctl vertes.

### Entrée O8 — Logique ternaire SQL (3VL) + contraintes CHECK réellement appliquées

**Date** : 2026-06-11

#### Défaillances constatées

1. **Logique à 2 valeurs** : l'évaluateur de conditions collapsait
   UNKNOWN→false localement, ce qui casse la composition : `NOT (x = 1)`
   avec x NULL retournait la ligne (Oracle : UNKNOWN, ligne exclue) ;
   `x NOT IN (2, NULL)` retournait des lignes (Oracle : jamais) ;
   `NULL LIKE '%'` était vrai (coercion NULL→'') ; `NOT BETWEEN` sur NULL
   retournait la ligne.
2. **LIKE insensible à la casse** (flag regex `'i'`) — Oracle LIKE est
   strictement sensible à la casse.
3. **CHECK fantômes** : le parseur produisait bien l'AST du CHECK
   (`checkExpr`), mais `executeCreateTable` le jetait — contrainte
   table-level enregistrée **sans** expression (jamais validée),
   contrainte inline de colonne **pas enregistrée du tout**. Tout INSERT
   violant un CHECK passait.
4. Noms de contraintes non uppercasés (`c2_chk` stocké tel quel dans le
   dictionnaire — Oracle uppercase les identifiants non quotés).

#### Correction

- `evaluateCondition3VL()` : logique de Kleene complète — AND/OR/NOT sur
  {TRUE, FALSE, UNKNOWN}, propagation de NULL dans comparaisons, LIKE,
  BETWEEN (composition 3VL des deux comparaisons), IN (un NULL de chaque
  côté rend la comparaison UNKNOWN → `NOT IN` avec NULL ne passe jamais).
  `evaluateCondition()` reste la frontière WHERE/ON : seul TRUE passe.
- CHECK : accepte TRUE **et** UNKNOWN (norme SQL — NULL ne viole pas un
  CHECK), branché via le câblage du `ConstraintValidator`.
- `serializeExpr` étendu (ParenExpr, NOT, IS NULL, IN, BETWEEN, LIKE)
  pour sérialiser fidèlement les prédicats CHECK ; `executeCreateTable`
  enregistre désormais `checkExpression` aux deux niveaux (table et
  colonne) ; noms de contraintes uppercasés.
- LIKE sensible à la casse (suppression du flag `'i'`).

**Fichiers** : `src/database/oracle/OracleExecutor.ts`,
`src/__tests__/unit/database/oracle-null-three-valued-logic.test.ts`
(nouveau, 9 tests).

**Validation** : database **2647 tests verts** + terminal/shell 896,
zéro échec.

### Entrée O9 — SET AUTOCOMMIT effectif + SEARCH_CONDITION au dictionnaire

**Date** : 2026-06-11

#### Défaillances constatées

1. `SET AUTOCOMMIT ON` : le réglage existait dans SQLPlusSession et était
   propagé au contexte d'exécution… que l'exécuteur ne lisait jamais.
   Un ROLLBACK annulait donc des DML censés être déjà committés.
2. `DBA_/USER_CONSTRAINTS` n'exposait ni `SEARCH_CONDITION` ni
   `DELETE_RULE` ; les contraintes NOT NULL étaient typées 'O' au lieu de
   'C' (Oracle les présente comme des CHECK `"COL" IS NOT NULL`).

#### Correction

- Commit immédiat après chaque DML réussi quand `autoCommit` est actif
  (frontière `executeStatement`, même endroit que l'auto-commit DDL).
- DBA_CONSTRAINTS : colonnes SEARCH_CONDITION (prédicat CHECK réel issu
  de la correction O8, condition générée pour NOT NULL) et DELETE_RULE
  (CASCADE / SET NULL / NO ACTION) ; NOT NULL typé 'C'.

**Fichiers** : `OracleExecutor.ts`, `views/dba_constraints.ts`, tests
ajoutés à `oracle-null-three-valued-logic.test.ts` (12 au total).

**Validation** : database **2650 tests verts**, zéro échec.

---

## Série 3 (2026-06-11) — Consolidation finale des branches + démantèlement de la god class OracleExecutor (O7)

### Entrée S3.0 — Base de travail : fusion des 4 branches restantes

**Date** : 2026-06-11

Conformément à la consigne, inventaire des 19 branches distantes après
`fetch --unshallow` (le clone shallow faisait croire à des historiques
sans ancêtre commun — diagnostic corrigé par rapport à l'entrée 10 :
après un unshallow, `fix-powershell-tests-M4mpL` est **entièrement
contenue** dans main, et `general-session-6Nwqo` n'avait qu'**un seul**
commit d'avance réel) :

- 15 branches déjà contenues dans la base — rien à faire.
- `general-session-6Nwqo` (1 commit « Match real PowerShell terminal
  output formatting ») — **mergée**. Conflits Format-Table/Format-List
  résolus en **combinant** : projection des propriétés calculées
  (`resolveColumns`, côté HEAD) + rendu délégué au moteur canonique
  `formatTable`/`formatList` de PSPipeline (côté branche — vraie largeur
  de colonnes au contenu, vrais alignements `Clé : Valeur`). La largeur
  en dur de 15 caractères et le rendu liste à espace unique (les deux
  copies de logique de rendu) disparaissent. `Get-Process` garde les
  alias octets WS/PM/NPM/VM **et** gagne l'arrondi 2 décimales du CPU.
  1 test mis à jour (il assertait l'absence d'alignement des deux-points).
- `friendly-babbage-plxyqc` (3 commits : signaux EndHost morts + ping6
  RFC 4861) — **mergée** ; conflit BGPEngine résolu en gardant la version
  unifiée de l'entrée 10 (plus complète : attributs origin/MED/LOCAL_PREF
  propagés, §5.1.5) ; journal fusionné par union.
- `keen-babbage-krj5ab` (8 commits : série Oracle O1–O9) — **mergée** ;
  même résolution BGPEngine.

Validation : database 2650 verts, BGP 17 verts, ping6/host-signals 26
verts, PowerShell 1880 verts (10 échecs préexistants documentés).

### Entrée S3.1 — O7 (étape 1/n) : extraction de `UserAdminExecutor`

**Date** : 2026-06-11

#### Défaillance visée

`OracleExecutor` : god class de 4 592 lignes, 50+ cas de dispatch, 11
groupes sémantiques de handlers entremêlés (backlog O7). Démantèlement
par étapes, chaque étape compilant et passant la suite complète.

#### Correction (étape 1)

- Nouveau module `src/database/oracle/executor/UserAdminExecutor.ts` :
  CREATE/ALTER/DROP USER, CREATE/DROP ROLE, CREATE/ALTER/DROP PROFILE et
  l'émission des événements `oracle.user.activity` (utilisée uniquement
  par ce cycle de vie — elle déménage avec).
- Dépendances **injectées** (storage, catalog, instance, context,
  PrivilegeEnforcer, accesseur de session id) — pas de rétro-pointeur
  vers la god class ; le module est typé `OracleCatalog` directement, ce
  qui élimine les 8 casts `this.catalog as OracleCatalog` du groupe.
- `PROTECTED_SCHEMAS` (ORA-28009) extrait en constante de module.
- OracleExecutor : −240 lignes (4 592 → 4 362), le dispatch délègue.

#### Validation

Suite database complète : **2650 tests verts**, zéro régression ;
`tsc` : zéro erreur ajoutée (baseline identique avant/après).

### Entrée S3.2 — O7 (étape 2/n) : extraction de `SecurityDclExecutor`

**Date** : 2026-06-11

#### Correction (étape 2)

- Nouveau module `src/database/oracle/executor/SecurityDclExecutor.ts` :
  GRANT/REVOKE (privilèges système, rôles, grants objet et colonne),
  AUDIT/NOAUDIT traditionnels, politiques d'audit unifié, ADMINISTER KEY
  MANAGEMENT (TDE) et COMMENT ON — avec leurs trois helpers privés
  (`granteesOf`, `expandSystemPrivileges`, `assertGrantableObjectExists`)
  qui n'étaient utilisés que par ce groupe.
- Les imports inline `import('../engine/parser/ASTNode').X` répétés dans
  les signatures sont remplacés par des imports de types normaux.
- 9 casts `as OracleCatalog` supprimés (typage direct).
- OracleExecutor : 4 362 → 4 040 lignes ; imports morts purgés.

#### Validation

Suite database : **2650 tests verts** ; baseline `tsc` inchangée (25
erreurs préexistantes dans OracleExecutor.ts, toutes antérieures et
documentées comme bruit de la config `tsconfig.app.json` + TS récent).

### Entrée S3.3 — Deux inversions de couches corrigées + O7 (étape 3/n) : `InstanceAdminExecutor`

**Date** : 2026-06-11

#### Défaillances constatées

1. **Couche inversée n°1** : `ORACLE_CONFIG` (chemins ORACLE_HOME,
   ORA-/TNS-errors, bannières) vivait dans `src/terminal/commands/`
   alors que 9 de ses 12 consommateurs de production sont le moteur
   database lui-même. Le moteur DB importait depuis la couche terminal.
2. **Couche inversée n°2** : `OracleExecutor` importait
   `network/equipment/Equipment` — le moteur SQL connaissait la
   topologie réseau — uniquement pour lire un fichier pfile sur le VFS
   du device (`CREATE SPFILE FROM PFILE='…'`).

#### Corrections

- `OracleConfig.ts` déplacé dans `src/database/oracle/` ; les 19 sites
  d'import réécrits (terminal et adapters importent désormais depuis la
  couche database — sens de dépendance correct).
- Injection de dépendance `OracleInstance.setDeviceFileReader()` (même
  patron que `setEventBus`/`setLiveSessionProvider`) : l'implémentation
  à base d'`EquipmentRegistry` est fournie par le câblage terminal
  (`getOracleDatabase`), là où vit déjà `resolveDevice` des adapters.
  Plus aucun import réseau dans `src/database/`.
- O7 étape 3 : `executor/InstanceAdminExecutor.ts` — STARTUP/SHUTDOWN,
  ALTER SYSTEM, ALTER DATABASE (mode archivelog, MOUNT/OPEN, rename/
  resize/autoextend des datafiles), CREATE/DROP/ALTER TABLESPACE,
  CREATE PFILE/SPFILE (+ `parseInitParameters` exporté), diskgroups ASM.
  OracleExecutor : 4 040 → 3 677 lignes.

#### Validation

Database 2650 + terminal 380 verts ; zéro nouvelle erreur tsc.

### Entrée S3.4 — Identité de base réelle : DBID unique + flux SCN unifié + checkpoints effectifs

**Date** : 2026-06-11

#### Défaillances constatées (audit réalisme)

1. **DBID `1234567890` codé en dur dans 6 vues** (V$DATABASE,
   V$CONTAINERS, DBA_HIST_WR_CONTROL, DBA_HIST_BASELINE,
   DBA_HIST_DATABASE_INSTANCE, fallback DBA_HIST_SYSSTAT) — toutes les
   bases du réseau partageaient la même identité, ce qui casse tout
   scénario multi-instances (Data Guard, clonage RMAN, audits croisés).
2. **CHECKPOINT_CHANGE# incohérent** : V$DATAFILE répondait
   `1000 + FILE#`, V$DATAFILE_HEADER répondait `100` fixe — un
   `SELECT … FROM v$datafile JOIN v$datafile_header USING (FILE#)` ne
   tombait jamais d'accord, alors que ces deux vues lisent le même SCN
   de checkpoint dans le vrai Oracle.
3. **`ALTER SYSTEM CHECKPOINT` no-op** : « System altered. » sans aucun
   effet observable.
4. **Trois compteurs SCN divergents** : l'AuditJournal tirait ses SCN
   d'un compteur privé sans rapport avec l'état de la base ; aucune
   notion de CURRENT_SCN.
5. **TS# fabriqué** : `V$DATAFILE.TS# = FILE# − 1` — faux dès qu'un
   tablespace a deux datafiles (le TS# identifie le tablespace, pas le
   fichier).
6. RMAN affichait toujours `DBID=1234567890` quel que soit le device.

#### Corrections

- `OracleInstance` devient **propriétaire de l'identité et du SCN** :
  `getDbId()` (hash FNV-1a de deviceId:SID, plage 1–4 milliards comme
  les vrais DBID — unique par device, reproductible), `getCurrentScn()`,
  `advanceScn()`, `getCheckpointScn()/getCheckpointTime()`,
  `performCheckpoint()`.
- Chaque **COMMIT avance le SCN** (callback `onCommit` du
  TransactionManager) ; l'**AuditJournal partage le flux SCN** de
  l'instance (source injectée, le compteur privé ne sert plus qu'aux
  journaux orphelins de tests).
- **Checkpoints réels** aux mêmes déclencheurs que le vrai Oracle :
  `ALTER SYSTEM CHECKPOINT`, log switch, OPEN, shutdown propre (ABORT
  s'en passe, fidèle au comportement crash). Trace alert log
  `Completed checkpoint up to RBA, SCN: n`.
- V$DATAFILE et V$DATAFILE_HEADER lisent le **même** SCN/heure de
  checkpoint ; V$DATABASE expose CURRENT_SCN et CHECKPOINT_CHANGE# et
  son CONTROLFILE_CHANGE# suit le checkpoint ; TS# corrigé (numéro de
  tablespace partagé par ses datafiles).
- RMAN : `LinuxRmanContext` lit le DBID vivant de l'instance
  (`connected to target database: SID (DBID=…)` réel) ; `DbId.DEFAULT`
  ne sert plus qu'aux devices sans Oracle.

#### Validation

Database 2650 + RMAN 284 verts ; pas de nouvelle erreur tsc.

### Entrée S3.5 — SQL*Plus : SPOOL réel, @/START réels, ECHO, substitution &var + VERIFY

**Date** : 2026-06-11

#### Défaillances constatées (audit terminal)

1. **SPOOL factice** : `spoolFile` stocké puis **jamais écrit** — aucun
   fichier créé, `SPOOL OFF` ne faisait que vider la variable. Le
   workflow DBA le plus banal (spool → requêtes → spool off → cat)
   était silencieusement cassé.
2. **`@script` / `START` toujours en échec** : SP2-0310 inconditionnel,
   alors que la lecture du VFS device existe (S3.3).
3. **`SET ECHO/VERIFY/TRIMSPOOL` ignorés** : réglages stockés sans
   aucun effet.
4. **DEFINE mort** : les variables `DEFINE` étaient stockées mais la
   substitution `&var` n'était **jamais appliquée** aux statements.

#### Corrections

- Nouvelle surface injectée `SqlPlusFileIO { resolve, read, write }` —
  câblée par `SqlPlusSubShell` sur le VFS du device
  (`readFileForEditor`/`writeFileFromEditor`, mêmes surfaces que RMAN) ;
  les chemins relatifs se résolvent contre le cwd du shell lanceur
  (`pwd`), comme un vrai process sqlplus.
- **SPOOL réel** : capture prompt + commande + sortie (fidèle au client
  réel en interactif), écriture au fil de l'eau, extension `.lst`
  implicite, modes CREATE/REPLACE/APPEND (SP2-0771 sur CREATE existant),
  `SPOOL` nu = état courant, `SPOOL OFF` enregistre sa propre ligne en
  dernière position, TRIMSPOOL effectif, SP2-0606 sans filesystem.
- **@/START réels** : lecture du script sur le VFS (extension `.sql`
  implicite, `@@` accepté), exécution ligne à ligne via le processeur
  normal (imbrication possible), **SET ECHO ON** affiche chaque commande
  de script derrière son prompt — et uniquement pour les scripts, comme
  le vrai client.
- **Substitution `&var`/`&&var`** au moment de l'exécution SQL avec
  affichage `old N:`/`new N:` sous SET VERIFY ON, `SET DEFINE OFF`/char
  personnalisé honorés, terminaison `.` gérée. Limite documentée : pas
  d'invite interactive pour les symboles non définis (laissés verbatim).
- 3 tests qui figeaient les comportements factices mis en conformité ;
  +9 tests neufs (spool capture/extension/états, @ + ECHO, VERIFY ON/OFF,
  DEFINE OFF).

#### Validation

Database + terminal + suite sqlplus-LAN : **3139 tests verts**.

### Entrée S3.6 — SGA dynamique pilotée par `sga_target`

**Date** : 2026-06-11

#### Défaillance constatée

`getSGAInfo()` retournait des constantes (`'256M'`, `'128M'`, …) quel
que soit `sga_target` ; la bannière STARTUP affichait
`Total System Global Area 512M bytes` (une string « 512M » à la place
du compte d'octets) et des tailles composantes câblées en dur.
`ALTER SYSTEM SET sga_target=…` n'avait aucun effet observable —
V$SGA/V$SGAINFO et SHOW SGA mentaient.

#### Correction

- `getSGAInfo()` dérive les composantes du **paramètre vivant**
  `sga_target` : répartition type ASMM 19c (50 % buffer cache, 25 %
  shared pool, 3 % large/java pools), arrondie au granule réel (4M sous
  1G de SGA, 16M au-delà), redo buffer 8M/16M selon la taille.
- Bannière STARTUP : compte d'octets exacts dérivés du même calcul
  (`Total System Global Area  536870912 bytes`…), plus de chiffres
  fantaisistes.
- 4 tests neufs (`oracle-sga-dynamic.test.ts`) : défauts à 512M, reshape
  par ALTER SYSTEM (1G/2G), bannière en octets, V$SGAINFO suiveur.

#### Validation

Database **2662 tests verts** (2658 + 4).

---

## Limites connues / dette restante

- **Backlog #10** (ISP sur `Equipment`) : ✅ traité en Série 3, entrée 12.
- **BGP** : pas de route-reflectors ; FSM dérivée synchrone (pas de phases
  Connect/OpenConfirm — exigerait un moteur asynchrone à acteurs comme OSPF).
- **STP** : RSTP (802.1w) et PVST+ ne sont pas implémentés ; le fast path
  « premier bring-up » simule un comportement type RSTP pour préserver
  l'utilisabilité (décision documentée dans le code).
- **GRE** : checksum non standard (hash JSON) — toléré car purement interne
  à la simulation, signalé ici pour transparence.
- Les firewalls (`firewall-*`), `access-point` et `cloud` restent des stubs
  (`LinuxPC`/`Hub`) — hors périmètre de cette série, à traiter comme des
  fonctionnalités à part entière.

---

## Série 3 (2026-06-12) — Refonte structurelle : ISP & conformité couche physique

### Backlog issu de l'audit du 2026-06-12

Audit en deux volets : (a) violations de la règle « toute communication
inter-équipements passe par les câbles » (Port → Cable → Port →
`handleFrame`), (b) duplication / anti-patterns résiduels.

| # | Sujet | Norme / Pattern | Sévérité | Statut |
|---|-------|-----------------|----------|--------|
| 12 | Equipment : 11 stubs « hôte » (passwords, cwd, éditeur) hérités par routeurs/switches (backlog #10) | ISP (SOLID) | Moyenne | ✅ Corrigé |
| 13 | OSPF : paquets « téléportés » au moteur du pair via `RouterOSPFIntegration.getByEquipmentId()` au lieu de trames sur le câble | RFC 2328 / archi équipement | Critique | ✅ Transport corrigé (entrée 13) — orchestration encore synchrone |
| 14 | IPSec DPD : R-U-THERE simulé en lisant la base SA du pair en mémoire (`findRouterByIP` + `_getIPSecEngineInternal`) | RFC 3706 | Critique | ✅ Corrigé (entrée 17) |
| 15 | Résolution DNS/host : scan du registre global d'équipements (`DnsNssSource`, `HostLookup`) au lieu de requêtes DNS réelles | RFC 1034/1035 | Haute | ✅ NSS corrigé (entrée 23) — reste ssh/scp par nom (chantier SSH-sur-TCP) |
| 16 | Découverte de pairs EIGRP/BGP : accès direct au moteur du pair (`RouterDynamicRouting.peerEngineFor`) | Archi équipement | Haute | ✅ EIGRP corrigé (entrée 27) — reste BGP (chantier TCP/179) |
| 17 | EndHost/DHCP : découverte de serveurs par parcours du graphe (`Equipment.getById`) | RFC 2131 | Haute | ✅ Corrigé (entrée 15) — scan registre conservé en repli des topologies non câblées |
| 18 | Parsing de ligne de commande quotée dupliqué (`WindowsPC.parseCommandLine` / `CmdSubShell.splitArgs`) | DRY | Moyenne | ✅ Corrigé (entrée 14) |
| 19 | Validation IPv4/IPv6 réimplémentée 3× (PowerShellExecutor, WinNetsh, LinuxIptablesManager) | DRY | Moyenne | ✅ Corrigé (entrée 14 — iptables écarté : déléguait déjà à IPAddress.tryParse) |

---

## Entrée 12 — Equipment : ségrégation des capacités hôte (ISP)

**Date** : 2026-06-12

### Défaillance constatée

`Equipment` (classe de base de TOUT équipement) portait 11 méthodes stub
spécifiques aux hôtes : `checkPassword` (retournait `false`),
`setUserPassword` (no-op silencieux), `userExists`, `getCurrentUser`
(`'user'`), `getCurrentUid` (**0, c.-à-d. root !**), `canSudo`
(**`true` !**), `handleExit`, `getCwd` (`'/'`),
`resolveAbsolutePath`, `readFileForEditor`, `writeFileFromEditor`.

Conséquences structurelles :
- un `CiscoSwitch` « répond » à `canSudo()` par `true` et à
  `getCurrentUid()` par 0 — des mensonges silencieux qui masquent les
  erreurs d'aiguillage au lieu de les révéler ;
- la couche terminal appelait ces stubs sans distinguer « le device n'a
  pas cette capacité » de « la capacité a répondu » ;
- violation frontale de l'Interface Segregation Principle : les
  sous-classes réseau dépendaient d'une interface qu'elles n'utilisent
  pas.

### Correction

- Nouveau module `src/network/equipment/HostCapabilities.ts` suivant le
  pattern « interface Host + type guard » déjà conventionnel dans le
  projet (cf. `StpHost`, `TcpHost`, `FhrpHost`…) :
  - `CredentialAuthenticator` (`checkPassword`) — implémenté par
    `LinuxMachine`, `WindowsPC` **et `Router`** (point d'entrée SSH
    unique multi-vendeur, comportement préservé) ;
  - `UserAccountHost` (`setUserPassword`, `userExists`) ;
  - `ShellIdentityHost` (`getCurrentUser/Uid`, `canSudo`, `handleExit`) ;
  - `FileEditorHost` (`getCwd`, `resolveAbsolutePath`,
    `readFileForEditor`, `writeFileFromEditor`) ;
  - type `HostCapableDevice = Equipment & Partial<…>` + 4 type guards.
- `Equipment` ne garde que la surface CLI universelle (`executeCommand`,
  `getCompletions`) ; les 11 stubs sont supprimés.
- Les implémenteurs déclarent leurs capacités (`implements`) — toute
  dérive de signature est désormais une erreur `tsc` (les `override`
  orphelins de `WindowsPC`/`Router` sont devenus des déclarations
  d'interface).
- Sites d'appel (sessions terminal, flows sudo/su/passwd/adduser,
  commandes Oracle, sshLauncher) : passage à `HostCapableDevice` — la
  absence de capacité est explicite au site d'appel
  (`device.canSudo?.() ?? false`) au lieu d'être masquée par un stub.

### Validation

- `tsc --noEmit` : diff strictement nul vs baseline (1379 erreurs
  préexistantes avant = 1379 après, uniquement décalages de lignes).
- Tests : terminal + terminal-core + shell (967), cross-vendor SSH (75),
  flows/SSH LAN (529), database + react + gui (2792) — tous verts.

---

## Entrée 13 — OSPF : le transport passe par les câbles, plus par le registre

**Date** : 2026-06-12

### Défaillance constatée

1. **Téléportation des paquets OSPF.** `RouterOSPFIntegration.deliverPacket`
   localisait le moteur du routeur voisin via un registre statique
   (`getByEquipmentId`) et appelait **directement**
   `remoteEngine.processPacket(...)`. Les Hello/DD/LSR/LSU/LSAck ne
   traversaient ni le port, ni le câble, ni le data plane du switch :
   un câble coupé, un port down ou un équipement éteint n'interrompait
   pas l'échange protocolaire en cours. Ironie : le chemin propre
   existait déjà (`sendPacket` encapsule en IPv4 proto 89, TTL=1,
   multicast 224.0.0.5 → MAC 01:00:5e:00:00:05 conformément à
   RFC 2328 §4.3 et RFC 1112 §6.4) mais `setupSendCallbacks` l'écrasait
   par la téléportation à chaque convergence.
2. **Réception inexistante.** Aucun routeur ne traitait le protocole IP
   89 en entrée : `handleLocalDelivery` dispatchait ESP/AH/TCP/ICMP/UDP
   (RIP y passe déjà par de vraies trames !) mais ignorait OSPF — raison
   d'être historique de la téléportation.
3. **Pas d'authentification à la réception.** `processHello` validait
   masque et timers (RFC 2328 §10.5) mais pas l'authentification — le
   pré-check hors-bande de l'orchestrateur masquait ce manque, en
   violation de RFC 2328 §8.2 (la vérification AuType/clé est un
   prérequis de TOUT traitement de paquet reçu).

### Correction

- `IP_PROTO_OSPF = 89` ajouté aux constantes protocolaires canoniques.
- **Réception** : `Router.handleLocalDelivery` dispatch proto 89 →
  `RouterOSPFIntegration.receivePacket` → `OSPFEngine.processPacket`.
  Le filtre L2 du routeur acceptait déjà les MAC 01:00:5e:… et
  `processIPv4` consomme déjà 224.0.0.0/24 localement sans forwarding
  (RFC 1112) : la chaîne Port → Câble → `handleFrame` → `processIPv4` →
  contrôle plane est maintenant complète.
- **Émission** : `setupSendCallbacks` câble désormais `sendPacket`
  (vraies trames) pour tous les moteurs du domaine ; `deliverPacket`
  (le téléporteur) est **supprimé**. La livraison par câble étant
  synchrone, l'échange DD/LSR/LSU/LSAck piloté par la machine à états
  aboutit toujours dans le même appel de convergence — mais il transite
  réellement par le plan physique (y compris le flooding multicast des
  switches pour les segments partagés).
- **Authentification sur le fil** (RFC 2328 §8.2 / annexe D) :
  l'en-tête `OSPFPacketHeader` transporte `authType`/`authKey`,
  estampillés à l'égress unique (`dispatchOutgoing`) depuis la config
  d'interface, validés à l'ingress (`processPacket`) avant tout
  traitement FSM — drop + log en cas de désaccord.

### Limites restantes (documentées, backlog #13 partiellement soldé)

- L'**orchestration** de convergence (`autoConverge` : activation des
  interfaces distantes, `formAdjacency` bilatéral, `driveStateMachine`,
  `synchronizeLSDBs` en filet de sécurité) reste synchrone et
  topology-walk. Le transport est conforme ; la découverte de voisins
  par vrais Hello périodiques (les timers existent déjà côté moteur)
  est l'étape suivante.
- OSPFv3 (IPv6) garde son ancien modèle — à migrer séparément.

### Validation

- 16 fichiers de tests OSPF : 399 tests verts.
- Suite `network-v2` complète : verte (voir commit).
- `tsc --noEmit` : diff nul vs baseline.

---

## Entrée 14 — DRY : tokenisation cmd.exe et validation IP canoniques

**Date** : 2026-06-12

### Défaillances constatées

1. **Parsing de ligne cmd.exe dupliqué à l'identique** dans
   `WindowsPC.parseCommandLine` et `CmdSubShell.splitArgs` (~30 lignes
   chacun) : un fix de quoting dans l'un manquait silencieusement
   l'autre.
2. **Validation IP réimplémentée par module** avec des sémantiques
   divergentes :
   - `PowerShellExecutor.isValidIP` : IPv6 « validé » par
     `/^[0-9a-f:]+$/` — `:::::` ou `12345::` passaient ;
   - `WinNetsh.isValidIPv4` : variante regex locale ;
   - (`LinuxIptablesManager` délègue déjà à `IPAddress.tryParse` —
     écarté du périmètre après vérification, contrairement au
     pré-audit.)

### Corrections

- `src/network/devices/windows/cmdline.ts` : `splitCmdArgs` unique
  (sémantique cmd.exe documentée : quotes toggle, pas d'échappement),
  les deux copies privées délèguent.
- `src/network/core/ip.ts` (déjà le module canonique de l'arithmétique
  IPv4) : `isValidIPv4` (via `tryIpToUint32`) et `isValidIPv6`
  structurel RFC 4291 §2.2 (max un `::` qui compresse au moins un
  groupe, hextets 1-4 hex, queue IPv4 embarquée, suffixe `%zone`).
  `PowerShellExecutor` et `WinNetsh` consomment ces validateurs — le
  durcissement IPv6 rejette désormais le garbage accepté avant.

### Validation

- 12 tests neufs (`core-ip-and-cmdline.test.ts`) : bornes IPv4, formes
  compressées/zone/IPv4-embarquée IPv6, rejets du garbage historique,
  quoting cmd.exe.
- Suites windows/netsh/powershell : 2 420 verts ; les 9 échecs restants
  (DateTime/pushd/dir-Length) reproduits à l'identique sur la baseline
  **avant** modification (vérifié par `git stash`) — préexistants.

---

## Entrée 15 — DHCP : le client converse en trames UDP 68→67, plus en appels d'objets

**Date** : 2026-06-12

### Défaillance constatée

1. **DORA par références directes.** `EndHost.autoDiscoverDHCPServers`
   parcourait le graphe (câbles, puis **fallback : scan du registre
   global** de tous les équipements !) pour récupérer des références
   d'objets `DHCPServer`, puis `DHCPClient.requestLease` appelait
   `server.processDiscover()/processRequestWithNak()` **directement en
   mémoire** — découverte, bail, renouvellement T1/T2, RELEASE, DECLINE :
   aucun de ces échanges ne traversait le plan physique.
2. **Duplication révélatrice** : un second client minimal,
   `EndHost.requestLeaseOnWire`, faisait déjà la séquence DORA en
   *vraies* trames broadcast (le serveur du routeur répond entièrement
   sur le fil : OFFER/ACK/NAK, relay option 82, giaddr) — preuve que le
   chemin filaire existait, inutilisé par le client principal.

### Correction (pattern Strategy sur le canal de conversation)

- Nouveau `dhcp/DhcpServerChannel.ts` :
  - interface `DhcpServerChannel` calquée sur les échanges RFC 2131
    (DISCOVER→OFFER, REQUEST→ACK/NAK, DECLINE, RELEASE) ;
  - `WireDhcpChannel` : construit de vrais `DHCPPacket`, les émet en
    UDP 68→67 broadcast par le port, et lit les réponses livrées —
    synchronement, le câble étant synchrone — par l'écouteur UDP/68 de
    l'hôte. La vue « pool » du bail est **synthétisée depuis les options
    du paquet** (1, 3, 6, 15, 51, 58, 59) : le client ne sait que ce que
    le serveur lui a dit, comme dans la réalité.
  - `DirectServerChannel` (dans DHCPClient.ts) : enrobe l'ancienne
    référence d'objet — conservé pour les tests unitaires sans câblage,
    et comme repli des topologies non câblées.
- `DHCPClient` : toutes les boucles (DORA, INIT-REBOOT, renouvellement
  T1, rebinding T2, RELEASE, DECLINE) consomment `channelsFor(iface)`
  — **fil d'abord**, refs directes en repli. Le repli APIPA (RFC 3927)
  est préservé quand rien ne répond et qu'aucun serveur n'est enregistré.
- `EndHost` : fabrique de canaux par interface + écouteur UDP/68 unifié
  (alimente à la fois les sessions `requestLeaseOnWire` historiques et
  les canaux du client).
- `Router.serveDhcpOnWire` : traite désormais aussi **DHCPDECLINE et
  DHCPRELEASE** reçus sur le fil (sans réponse, conformément à
  RFC 2131 §3.4/§3.1.5) et estampille T1/T2 (options 58/59) dans l'ACK.

### Limites restantes

- `autoDiscoverDHCPServers` (scan registre) subsiste comme repli pour
  les topologies de test sans câbles — documenté, à éteindre quand ces
  tests seront migrés.
- `requestLeaseOnWire` reste une surface parallèle (sortie de log
  différente) ; candidate à fusion sur `requestLease` maintenant que les
  deux empruntent le même chemin physique.

### Validation

- 9 fichiers de tests DHCP : 103 tests verts.
- Suite `network-v2` complète : verte (voir commit).
- `tsc --noEmit` : diff nul vs baseline (1379 = 1379).

---

## Entrée 16 — Tests de régression verrouillant les entrées 13 et 15

**Date** : 2026-06-12

Les migrations « transport réel » des entrées 13 (OSPF) et 15 (DHCP)
passaient les suites existantes, mais aucune n'affirmait explicitement
les comportements différenciants. Deux fichiers neufs les verrouillent :

- `dhcp-client-wire-channel.test.ts` (4 tests) :
  - bail obtenu par pur échange de trames, **sans aucun** serveur
    enregistré (l'ancien chemin n'aurait rien pu faire) ;
  - **câble coupé ⇒ pas de bail du pool** (APIPA RFC 3927) — la
    coupure physique interrompt réellement le protocole ;
  - DHCPRELEASE traverse le fil et libère le binding **côté serveur** ;
  - renouvellement (REQUEST sans server-id) ACKé sur le fil.
- `ospf-wire-auth.test.ts` (5 tests) : RFC 2328 §8.2 à l'ingress
  (mauvaise clé, AuType discordant dans les deux sens, acceptation à
  clé exacte) + estampillage des champs auth à l'égress unique.

Validation : 9 tests neufs verts.

---

## Entrée 17 — IPSec DPD : sondes R-U-THERE réelles en UDP/500

**Date** : 2026-06-12

### Défaillance constatée

`runDPDCheck` « simulait » R-U-THERE en localisant le routeur pair via un
scan du registre (`findRouterByIP` → `Equipment.getAllEquipment()`) puis
en lisant sa base SA en mémoire (`peerEngine.ikeSADB.has(...)`). Un câble
coupé ne faisait donc jamais échouer la sonde — c'est précisément la
panne que DPD (RFC 3706) existe pour détecter.

### Correction

- `IsakmpDpdMessage` (notify R-U-THERE / R-U-THERE-ACK + numéro de
  séquence monotone, RFC 3706 §5.4) transporté en vrai datagramme
  UDP 500→500 via la FIB (`Router._sendIkeUdp`).
- Réception : `handleLocalDelivery` UDP/500 → `IPSecEngine.handleIkeUdp`
  — un R-U-THERE n'est ACKé que si une IKE SA existe avec l'émetteur
  (§5.5) ; l'ACK doit faire écho à la séquence de la sonde.
- `runDPDCheck` : émet la sonde sur le fil ; la livraison câble étant
  synchrone, l'ACK d'un pair vivant est traité au retour de l'envoi ;
  `retries` timeouts consécutifs → SAs purgées. Le peek registre est
  supprimé.

### Note de style

À la demande de l'auteur du projet : passe de réduction des commentaires
sur l'ensemble des fichiers ajoutés par la série (en-têtes d'un
paragraphe → une ligne ; suppression des commentaires narratifs).

### Validation

- 3 tests neufs (`ipsec-dpd-wire.test.ts`) : ACK synchrone d'un pair
  vivant, câble coupé ⇒ 3 timeouts ⇒ SAs purgées, écho de séquence.
- Suites IPSec complètes (112 tests) vertes ; baseline `tsc` inchangée.

---

## Entrée 22 — OSPF phase 2 : la convergence est pilotée par de vrais Hellos

**Date** : 2026-06-12

### Défaillance constatée

Après l'entrée 13, le transport était conforme mais l'orchestration de
convergence restait hors-bande : `formAdjacency` créait les voisins
**bilatéralement** par accès direct aux moteurs des deux côtés (avec
pré-checks auth/timers dupliquant ce que le moteur sait faire), et
`driveStateMachine` injectait manuellement HelloReceived/TwoWayReceived.
Les vrais Hellos émis par les timers du moteur étaient ignorés du
processus de convergence.

### Correction

- `autoConverge`/`exchangeAndCompute` : suppression du seeding bilatéral
  et des pré-checks hors-bande (la validation est faite à l'ingress par
  `processHello` §10.5 et l'auth §8.2). La découverte de voisins, le
  2-Way, l'élection DR et l'échange DD/LSR/LSU découlent de **rondes de
  vrais Hellos** (`pumpHellos` ×2, élection, ×1) traversant câbles et
  switches. Les étapes bornées par des timers (élection différée par
  WaitTimer, retransmission DD §10.6) sont déclenchées synchronement —
  uniquement pour les interfaces encore en attente.
- Interfaces virtuelles (tunnels GRE, virtual links — pas de transport
  de trames) : seeding synthétique conservé, restreint par le critère
  « port sans câble ».
- Deux bugs RFC du moteur, masqués jusqu'ici par l'orchestration :
  1. **NbrChange incomplet (§9.2)** : la transition d'un voisin
     vers/depuis 2-Way ne re-déclenchait pas l'élection DR → split-brain
     durable (deux DR auto-déclarés sur le même segment, SPF asymétrique,
     zéro route d'un côté). L'ancien code ne le voyait pas car les
     déclarations DR des voisins restaient à 0.0.0.0 (jamais de hello
     traité).
  2. **passive-interface poreux** : un hello reçu sur une interface
     passive créait un voisin INIT ; IOS n'en traite aucun. Drop à
     l'ingress.
- `collectCandidateRouters` (parcours de topologie) supprimé — plus
  d'appelants.

### Validation

- 16 fichiers OSPF + redistribute (404 tests) verts ; suite network-v2
  complète verte (voir commit).
- Diff `tsc` : aucune erreur dans les fichiers touchés.

---

## Entrée 23 — NSS : la source `dns` résout en vrais datagrammes UDP/53

**Date** : 2026-06-12

### Défaillance constatée (backlog #15)

Les outils ponctuels (`dig`, `nslookup`, `ping <nom>`) avaient déjà été
migrés sur le fil (`DnsWire`, dnsmasq répondant sur UDP/53), mais la
source NSS `dns` — consultée par `getent hosts/ahosts` et toute
résolution passant par le Name Service Switch — scannait toujours le
registre global d'équipements : un nom résolvait même câble débranché,
et la zone du serveur DNS n'avait aucune autorité.

### Correction

- `EndHost.queryDnsServerSync` : variante synchrone du stub resolver
  (le NSS a un contrat sync ; la livraison câble étant synchrone, la
  réponse d'un serveur vivant est capturée au retour de l'envoi).
- `DnsNssSource` : wire-first via un `DnsWireStubResolver` injecté par
  `LinuxMachine` (nameservers lus en live dans `/etc/resolv.conf`,
  stubs loopback 127.x exclus — ils modélisent systemd-resolved, servi
  par le repli). Sémantique fidèle à la glibc : NXDOMAIN autoritaire →
  NOTFOUND ; tous serveurs muets → TRYAGAIN (EAI_AGAIN) ; PTR sur le
  fil pour `gethostbyaddr`.
- Sans nameserver configuré : repli sur le scan topologique historique
  (boîtes non configurées), documenté.
- `LinuxCommandExecutor` : instance `dnsNss` unique partagée entre les
  deux constructions du NameServiceSwitch (le resolver injecté survit
  au re-build sur attachEventBus).

### Limites restantes

- `ssh/scp/sftp <nom>` (`HostLookup.findHostByAddress`) résout encore
  les noms par scan du registre — à traiter avec le chantier
  SSH-sur-TCP (la partie IP→équipement est de la plomberie simulateur,
  pas une violation protocolaire).
- Windows : chaîne de résolution séparée, non migrée.

### Validation

- 5 tests neufs (`nss-dns-wire.test.ts`) : résolution de zone sur le
  fil, **NXDOMAIN autoritaire malgré un équipement homonyme dans le
  registre**, câble coupé ⇒ échec, PTR, repli sans nameserver.
- Suites dns/hosts/nslookup/resolv-conf + getent/nss : 153 vertes.

---

## Entrée 24 — UI : fin du re-render storm du canvas (GAP §11.2)

**Date** : 2026-06-12

### Défaillance constatée

1. `getDevices()` reconstruisait un tableau complet de `NetworkDeviceUI`
   (relecture de tous les ports/IP/MAC de **chaque** appareil) à chaque
   rendu de `NetworkCanvas`/`NetworkDesigner`/`PropertiesPanel`, avec des
   identités d'objets neuves à chaque fois — aucun bail-out React possible.
2. `moveDevice` recréait la `Map` complète des instances **à chaque pixel**
   de drag (O(n) par mousemove), et tous les composants consommaient le
   store sans sélecteur : déplacer un nœud re-rendait tous les nœuds,
   toutes les connexions et tous les panneaux.

### Correction

- **Stabilisation référentielle, pas cache aveugle** (`networkStore.ts`) :
  chaque appel dérive toujours un snapshot frais depuis l'`Equipment`
  vivant, mais retourne l'objet PRÉCÉDENT si rien de visible n'a changé
  (comparaison structurelle, interfaces comprises). Une IP configurée au
  terminal (mutation hors store) surface donc toujours au rendu suivant —
  c'est testé. Idem pour le tableau (`getDevices()` rend la même référence
  tant que membres et snapshots sont identiques).
- `moveDevice` ne copie plus la Map : signal par compteur `revision`
  (la position vit sur l'instance).
- `NetworkDevice` : consommation du store par **sélecteurs** zustand
  (bail-out automatique quand la tranche sélectionnée n'a pas changé) et
  export enveloppé de `React.memo` — pendant un drag, seul le nœud
  déplacé se re-rend.

### Validation

Nouvelle suite `devices-snapshot-stability.test.ts` (6 tests : identité
stable sans changement, drag = renouvellement du seul nœud déplacé, pas de
copie de Map + tick de révision, non-staleness sur mutation hors store,
rename, membership). Suites `unit/gui/` + `unit/react/` : 105/105 ;
`npx tsc --noEmit` et ESLint propres.

---

## Entrée 25 — PowerShell : scaffold « pass 5 » réalisé (DateTime, locations, switch scriptblocks)

**Date** : 2026-06-12

### Défaillance constatée

La suite `ps-fifth-pass.test.ts` (commit cc2d85dd, scaffold TDD) comptait
8 tests rouges depuis sa création — fonctionnalités jamais implémentées :
`[DateTime]::new(...)` absent de la table des types statiques,
`ToString(format)` ignorait son argument (.NET tokens), la soustraction
de deux dates ne produisait pas de TimeSpan, `Push-Location`/`Pop-Location`
n'existaient pas, et les patterns scriptblock de `switch`
(`{ $_ -lt 5 } { ... }`) n'étaient jamais évalués (le sujet tombait
toujours sur `default`).

### Correction

- `STATIC_TYPES.datetime.new` (constructeur y/m/d/h/mi/s) ;
- `formatDotNetDate` (nouveau module runtime, tokens yyyy/MM/dd/HH/mm/ss/
  MMM/ddd/tt/fff…) branché sur `Date.ToString(fmt)` — sans argument, le
  comportement ISO existant est préservé ;
- opérateur binaire `-` : Date−Date → `makeTimeSpan` (réutilisé de
  New-TimeSpan), Date−nombre → Date ;
- cmdlets `Push-Location`/`Pop-Location` (alias pushd/popd), pile dans la
  variable runtime, même résolution de chemin que Set-Location ;
- `switchMatch` : un pattern scriptblock est invoqué par sujet via le
  helper d'invocation existant (`invokeBlockInScope`, $_ lié) — et les
  branches multiples cumulent sans break, comme en vrai.
- Deux tests du scaffold corrigés car inexécutables/irréalistes :
  regex FF1 avec `\1` sans groupe de capture ; attente Length=5 alors que
  le vrai Set-Content ajoute un newline (=6).

### Validation

`unit/powershell/` : 57 fichiers, 1890 verts (0 échec, scaffold compris).

---

## Entrée 26 — UI : table MAC du PropertiesPanel réactive (GAP §11.3)

**Date** : 2026-06-12

### Défaillance constatée

1. La table MAC affichée n'était **pas un flux réactif** : un `useEffect`
   sur la sélection + bouton « Refresh » manuel — instantané figé tant
   que l'utilisateur n'agissait pas, à rebours de l'architecture
   read-models (`src/react/hooks`) que `NetworkLogsPanel` applique déjà.
2. Bug d'affichage latent : le panneau typait `getMACTable()` en
   `Map<string,string>` alors que les switches renvoient
   `MACTableEntry[]` — `Array.from(table.entries())` produisait des
   paires [index, objet] : la colonne MAC affichait un index de tableau,
   le VLAN était codé en dur à 1.
3. Côté moteur, seul `switch.mac.flushed` existait sur le bus — aucun
   événement d'apprentissage/vieillissement/clear à observer.

### Correction

- `Switch` publie désormais des événements typés `switch.mac.learned`,
  `switch.mac.moved` (avec fromPort), `switch.mac.aged`,
  `switch.mac.cleared` (le `flushed` existant rejoint l'union typée
  `DomainEvent`).
- Nouveau hook `useMacTable(instance)` (`src/react/hooks`) : abonnement
  aux cinq topics filtrés par deviceId, relecture du vrai
  `getMACTable()` à chaque événement — aucune copie d'état, aucun
  polling.
- `PropertiesPanel` consomme le hook : vraies adresses MAC, vrais VLANs,
  type dynamic/static réel ; bouton « Refresh » supprimé (plus rien à
  rafraîchir à la main), « Clear » déclenche l'événement qui vide la vue.

### Validation

Nouvelle suite `mac-table-reactivity.test.tsx` (4 tests : learned publié
par du trafic réel sur un LAN câblé, cleared publié, hook qui se remplit
après un ping et se vide après clear sans refresh manuel, instance null).
`unit/gui/` complet vert.

---

## Entrée 27 — EIGRP : la conversation passe par les câbles (backlog #16, volet EIGRP)

**Date** : 2026-06-12

### Défaillance constatée

1. **Adjacence et routes par lecture d'objets.** `EIGRPEngine.computeNeighbors`
   et `computeRoutes` appelaient `p.peerEngineFor('eigrp')` (fourni par
   `RouterDynamicRouting.peers()` via le registre d'équipements) et lisaient
   **directement** la config et `originatedPrefixes()` du moteur voisin.
   Aucune trame EIGRP n'existait : ni Hello, ni Update, ni IP proto 88.
2. **Pas d'adjacence à travers un switch.** `peers()` ne suivait qu'un câble
   direct routeur↔routeur : deux routeurs EIGRP reliés par un switch L2 ne se
   voyaient jamais — contraire au multicast 224.0.0.10 réel qui est inondé.
3. **Pas de propagation multi-sauts.** Seuls les préfixes *originés* du voisin
   direct étaient appris : dans une chaîne R1—R2—R3, R1 n'apprenait jamais le
   LAN de R3. Le vrai EIGRP est un vecteur de distance qui ré-annonce de
   proche en proche avec métrique vectorielle accumulée.
4. **Pas de règle d'activation d'interface.** L'adjacence se formait sur
   n'importe quelle interface câblée ; le vrai IOS n'émet/n'écoute des Hellos
   que sur les interfaces couvertes par une instruction `network` (et jamais
   sur les passives).
5. **Trafic de contrôle sur le chemin de données.** `Router.lookupRoute`
   convergeait EIGRP/BGP à chaque décision de forwarding — supportable en
   god-mode (lectures mémoire), incompatible avec de vraies trames.

### Correction

- **Paquets filaires** (`src/network/eigrp/packets.ts`) : `EigrpHelloPacket`
  (ASN, K-values, hold time, router-id — §5.3.4) et `EigrpUpdatePacket`
  (TLVs route avec métrique vectorielle : min-bande-passante du chemin,
  délai cumulé — §6.6), constantes 224.0.0.10 / proto 88 (RFC 7868 §4.2),
  seam `EigrpWire` injecté dans le moteur (DIP).
- **Émission** : `RouterDynamicRouting.sendEigrpFrame` encapsule en IPv4
  proto 88, TTL 1, MAC multicast RFC 1112 (01:00:5e:00:00:0a) — la trame
  part par le port réel (Port → Câble → `handleFrame`), donc traverse les
  switches par inondation multicast. `ipv4MulticastToMac`/`isMulticastIpv4`
  déménagent de `igmp/types` vers `core/ip.ts` (foyer canonique, ré-export
  conservé) et remplacent la copie inline de `RouterOSPFIntegration` (DRY).
- **Réception** : `Router.handleLocalDelivery` dispatch proto 88 →
  `RouterDynamicRouting.receiveEigrpPacket` → `EIGRPEngine.processPacket`
  (garde structurelle `isEigrpPacket`). Validation à l'ingress : ASN du
  process, interface activée par `network` et non passive, K-values —
  un désaccord K publie `eigrp.neighbor.k-value-mismatch` et logue le
  `%DUAL-5-NBRCHANGE … K-value mismatch` d'IOS, des deux côtés (chaque
  routeur diagnostique à la réception du Hello du pair, comme en vrai).
- **Modèle de convergence** (analogue de l'entrée 22 OSPF) : une ronde =
  l'intervalle Hello. `converge()` multicaste un Hello par interface
  active ; la livraison câble étant synchrone, le pair traite à l'ingress,
  rafraîchit sa propre vue (converge récursif, gardé contre la
  réentrance), puis répond Hello unicast + Update table-complète. Un
  voisin qui n'a pas répondu dans la ronde est déclaré down (analogue du
  hold time) : câble coupé, port down, équipement éteint ou déconfiguré
  interrompent réellement la conversation.
- **Vecteur de distance réel** : les Updates ré-annoncent les préfixes
  appris avec accumulation (bw = min, delay = somme) et **split horizon**
  (jamais ré-annoncé sur l'interface du successeur). DUAL inchangé en
  aval (RD/FD depuis les TLVs reçus, variance, maximum-paths) ; la
  propagation multi-sauts devient correcte (métrique 3328 à deux sauts
  GigE, conforme IOS).
- **Chemin de données silencieux** : `lookupRoute` appelle désormais
  `RouterDynamicRouting.refresh()` → `refreshFromCache()` (recalcul
  depuis les Updates déjà reçus, zéro trame émise) ; les vraies rondes
  partent aux convergences déclenchées par la config et les `show`
  (triggered updates). Un routeur réel n'émet pas de Hello à chaque
  paquet routé.
- `peerEngineFor` n'est plus consommé par EIGRP ; il ne survit que pour
  BGP (chantier TCP/179 documenté ci-dessous).

### Comportements réels gagnés

- Adjacence à travers un switch L2 (impossible avant) ; visible dans
  `PacketAnimation` et le Logger (`cable:transmit` des Hellos/Updates).
- `show ip route` : routes D multi-sauts avec next-hop et métrique
  accumulée exacts ; ping de bout en bout sur routes apprises uniquement.
- Coupure de câble → perte du voisin et retrait des routes à la ronde
  suivante ; `network` manquant ou `passive-interface` → aucun Hello.
- `show ip eigrp neighbors` affiche l'IP réelle du voisin (identité
  filaire), plus un id d'équipement interne.

### Limites restantes (documentées)

- BGP reste en god-mode (lecture du moteur pair via le locator) — sa
  migration exige des sessions TCP/179 réelles sur la TcpStack routeur.
- Pas de RTP (ACK/retransmission §5.4) ni de Query/Reply DUAL actifs :
  le modèle synchronie-par-ronde les rend inobservables ; à revisiter si
  un scheduler global temporise un jour la livraison des trames.
- La cohérence inter-routeurs est « eventually consistent » entre rondes
  (un pair éloigné voit l'état complet à sa propre ronde suivante) —
  cohérent avec l'architecture pull paresseuse existante.

### Validation

- `eigrp-engine.test.ts` réécrit sur un faux câble livrant de vrais
  paquets (20 cas, dont : règle d'activation `network`, passive, coupure
  de câble, multi-sauts avec métrique 3328, split horizon sans écho d'un
  préfixe mort, refresh sans trame).
- Nouveau `eigrp-wire.test.ts` (3 cas équipements réels) : adjacence à
  travers un GenericSwitch avec trames proto 88 observées sur le bus
  câble, coupure de câble, propagation multi-sauts + ping.
- Non-régression : suite `network-v2` complète **301 fichiers /
  7001 tests verts** ; gui/react/events 40 fichiers / 354 tests verts ;
  `tsc --noEmit` propre ; lint : seules 2 erreurs `any` préexistantes
  sur main (vérifié par stash).

---

## Entrée 28 — Archives Linux réelles : tar / gzip / gunzip / zcat / zip / unzip / file (GAP §8.4)

**Date** : 2026-06-12

### Défaillance constatée

1. **`tar -x` ne restaurait rien** : la création écrivait un pseudo-manifest
   (`TAR_ARCHIVE\nfichier: N bytes`), l'extraction vérifiait seulement que
   l'archive existait puis ne faisait **rien**. Un script de
   sauvegarde/restauration de lab était silencieusement cassé.
2. **`gunzip` détruisait les données** : `gzip` écrivait `GZIP:<longueur>`
   (perte du contenu), `gunzip` restituait le littéral
   `(decompressed from f.gz)`. Round-trip = corruption garantie.
3. **`zip`/`unzip` factices** : pas de membre stocké, `unzip` imprimait
   `inflating: (simulated)` sans toucher au VFS.
4. **`file` toujours figé** : `<cible>: ASCII text` même pour un répertoire
   ou un fichier inexistant.
5. Bugs annexes : pas de style ancien `tar czf …` (la forme la plus tapée),
   pas de `-C`, pas de `zcat` ; les archives étaient créées avec un mode
   aberrant 022 (le 0o644 passé en paramètre `umask` de `writeFile`).

### Correction

- Nouveau module `src/network/devices/linux/coreutils/ArchiveCommands.ts`
  (pattern d'extraction coreutils existant ; fonctions pures sur un seam
  `ArchiveFs` étroit — DIP, testable sans executor). L'executor délègue en
  une ligne par commande (god-class réduite de ~140 lignes au passage).
- **Format d'archive structuré** (enveloppe magique + JSON de membres
  {chemin, type, mode, uid, gid, mtime, contenu}) : les round-trips sont
  **sans perte** — contenus exacts, permissions restaurées, propriétaires
  restaurés seulement si l'extracteur est root (sémantique tar réelle).
- **tar** : grammaire complète c/x/t + f/v/z/j/C, style ancien groupé
  (`tar czf a.tgz src`), récursion répertoires, strip du `/` de tête avec
  l'avertissement GNU, erreurs et codes retour canoniques (`Cannot stat` +
  `Exiting with failure status` exit 2 en archivant le reste, `This does
  not look like a tar archive`, `Cowardly refusing…`, options en conflit),
  auto-détection de la compression à la lecture comme GNU tar.
- **gzip/gunzip/zcat** : remplacement du fichier par `.gz` (mode/owner
  préservés), `-k`, `-d`, suffixes (`already has .gz suffix -- unchanged`,
  `unknown suffix -- ignored`, `not in gzip format`), multi-opérandes avec
  code retour agrégé ; `zcat` ajouté au catalogue de commandes.
- **zip/unzip** : listing `adding:/updating:` par membre, mise à jour d'une
  archive existante, `-r`, `zip warning: name not matched` + exit 12,
  `unzip -l` (tableau Length/Date/Name + totaux), `-d dir`, suffixe `.zip`
  implicite, `End-of-central-directory signature not found` exit 9.
- **file** : classification depuis l'inode et le contenu réels —
  répertoire, lien symbolique (avec cible), fichier manquant (`cannot
  open … (No such file or directory)`), vide, scripts shebang, données
  binaires, et reconnaissance des trois formats d'archive (`gzip
  compressed data, was "…"`, `POSIX tar archive`, `Zip archive data`).
- **cwd de script honnête** : `cd /x && tar xf …` extrait là où bash le
  dit — le contexte archive lit le `PWD` de l'interpréteur (validé comme
  répertoire) au lieu du cwd d'executor synchronisé seulement en fin de
  script. (Limitation préexistante toujours ouverte pour les autres
  familles de commandes — documentée ici.)

### Limites restantes (documentées)

- `bzip2`/`bunzip2`/`xz`/`unxz` restent des stubs (suffixes et magies
  différents — à traiter sur le même seam si besoin).
- `apt`/`dpkg` restent des transcriptions figées (limite assumée, GAP 8.4).
- Le « binaire » d'archive est une enveloppe JSON lisible par `cat` —
  choix assumé du simulateur (lossless + introspectable), signalé par
  la magie `!<simtar>/!<simgz>/!<simzip>`.

### Validation

- Nouvelle suite `archive-commands.test.ts` (16 cas) : round-trips tar/
  gzip/zip avec vérification de contenu et de permissions, style ancien,
  `-C`, strip du `/`, erreurs et codes retour exacts, `file` sur 8 types,
  scénario de lab bout-en-bout (backup → perte → restore → `md5sum -c`
  OK). Au passage la suite a confirmé un réalisme existant : un
  utilisateur non-root ne peut pas écrire sous `/root` (le harnais a dû
  passer sur LinuxServer).
- Non-régression : bash 11 fichiers / 383 tests ; network-v2 + shell +
  terminal **381 fichiers / 7984 tests verts** ; `tsc --noEmit` propre ;
  lint : seules 3 erreurs `no-duplicate-case` préexistantes (vérifié par
  stash).

---

## Entrée 29 — `ss -s` : résumé calculé depuis la vraie table de sockets (GAP §8.5 résiduel)

**Date** : 2026-06-12

### Défaillance constatée

`ss -s` renvoyait des compteurs globaux figés (« Total: 120 »,
« TCP: 8 (estab 2, …) », tableau Transport inventé) sans aucun rapport
avec la `SocketTable` réelle de la machine — un démon qui ouvre ou ferme
un port ne changeait rien au résumé.

### Correction

`cmdSs` (`LinuxNetCommands.ts`) calcule désormais le résumé depuis
`socketTable.getAll()` : Total, comptes TCP/UDP, ventilation
`estab/closed/timewait` par état RFC 793, lignes Transport dérivées
(IPv6 = 0, la table ne modèle que l'IPv4 — honnête). Le bloc figé ne
survit que comme repli sans table (chemin dégradé documenté, jamais
atteint depuis un device réel).

### Validation

Nouveaux tests SP-14 dans `socket-table.test.ts` : cohérence des
compteurs avec la table vivante (et disparition du « Total: 120 »),
incrément du compte TCP après bind d'un nouveau listener. Suites
socket-table / linux-lan-ssh / linux-commands (365 tests) et
oracle-listener-network-coherence (5 tests) vertes ; `tsc` propre ;
lint propre.

---

## Entrée 30 — DHCP : fusion des deux clients « câble » concurrents d'EndHost

**Date** : 2026-06-12

### Défaillance constatée

1. **Deux machines DORA dans la même classe.** Héritage des deux sessions
   parallèles : `EndHost` portait à la fois le chemin officiel
   `DHCPClient` + `WireDhcpChannel` (entrée 15, Strategy sur le canal de
   conversation) **et** une seconde implémentation complète du DORA câble
   — `requestLeaseOnWire()` / `handleWireDhcpReply()` / map privée
   `wireDhcp` (~90 lignes, entrée 25 du REFACTORING-JOURNAL). Deux états
   de bail divergents (`wireDhcp` vs `ifaceStates` du client), deux
   validations xid/chaddr, deux chemins de configuration d'interface, et
   une sortie de log propriétaire (`bound to X via Y`) qui ne ressemblait
   ni à ISC dhclient ni à rien d'existant.
2. **L'écouteur UDP/68 servait les deux maîtres** : chaque datagramme
   était soumis d'abord à la machine parallèle puis aux canaux du client
   — un ACK pouvait configurer l'interface par le chemin parallèle sans
   que le bail du `DHCPClient` (T1/T2, lease file, signaux réactifs) n'en
   sache rien.

### Correction (fusion sur l'existant, zéro nouvelle surface)

- Suppression pure de `requestLeaseOnWire`, `getWireDhcpState`,
  `handleWireDhcpReply` et de la map `wireDhcp` : les validations
  RFC 2131 §3.1 (xid, chaddr, type attendu) vivent déjà dans
  `WireDhcpChannel.exchange()`, et les effets d'un ACK (route connectée,
  passerelle, `dhcpInterfaces`, hook `onDhcpLeaseConfigured`) vivent déjà
  dans le callback `configureIP` du `DHCPClient`. L'écouteur UDP/68 ne
  nourrit plus que les canaux par interface.
- Les tests `dhcp-relay-wire.test.ts` (DORA direct, relais RFC 3046,
  Option 82 dans les deux sens) pilotent désormais le **vrai chemin
  utilisateur** : `dhclient -v eth0` à travers le terminal, assertions
  sur l'état RFC du client (`BOUND`, bail) au lieu de l'état privé de la
  machine supprimée ; l'observation « l'Option 82 est strippée avant le
  client » se fait à la frontière réelle (`WireDhcpChannel.deliver`).
  Le scénario relais + Option 82 couvre donc maintenant le client
  officiel, ce que l'ancienne machine parallèle était seule à exercer.

### Validation

- `dhcp-relay-wire` migré : 5 tests verts sur le chemin unifié.
- Non-régression : 11 suites DHCP/hôte (dhcp_complete, dhcp_fixes,
  dhcp-cli-gaps, dhcp-client-wire-channel, dhcp-resolv-conf,
  dhcp-server-identifier, dhcp-stp-cli-gaps, cisco-dhcp-pool-options,
  windows-netsh-dhcp-dns, host-model-loopback, ping-through-switch) :
  136 tests verts. `tsc --noEmit` : 0 erreur.

### Limite restante

- `autoDiscoverDHCPServers` (repli hors-bande pour topologies non
  câblées) demeure — toujours tracé au backlog #17.

---

## Entrée 31 — STP : rôle Backup réel (802.1D-2004 §17.7) + coût de port piloté par la vitesse

**Date** : 2026-06-13

### Défaillances constatées

1. **Rôle Backup inexistant.** `StpPortRole` ne connaissait que
   `root | designated | alternate | disabled` : tout port bloqué était
   étiqueté `alternate`, y compris le cas canonique du **port Backup**
   (802.1D-2004 §17.7) — un port bloqué parce que *notre propre* pont
   émet une BPDU supérieure sur le **même segment partagé** (deux ports
   du pont sur un hub). Un vrai commutateur distingue :
   - **Alternate** : meilleure information reçue d'un **autre** pont
     (chemin alternatif vers la racine, secours du root port) ;
   - **Backup** : meilleure information reçue de **soi-même** sur le
     segment (secours d'un port désigné local).
   Cisco (`Altn`/`Back`) comme Huawei (`ALTE`/`BACK`) les affichent
   séparément, même en mode legacy ; le simulateur les fusionnait.
2. **Coût de port faux — bug d'unité kbps/Mbps.** Les trois sites
   appelant `defaultPathCost(port.getSpeed())` passaient des **Mbps**
   (`getSpeed()` renvoie 10/100/1000/10000) à une fonction dont le
   contrat (paramètre `speedKbps`, test unitaire à l'appui) attend des
   **kbps**. Conséquence : *tout* coût STP calculé était erroné — un lien
   Gigabit valait **200** au lieu de 4, FastEthernet 200 au lieu de 19,
   10 GbE 100 au lieu de 2. Les élections entre liens de même vitesse
   restaient correctes (coûts égaux), mais toute topologie à vitesses
   mixtes mal-élisait, et les valeurs affichées étaient fausses.
3. **`show spanning-tree` mentait sur le coût.** Le coût par interface
   était **codé en dur à `19`** dans `showSpanningTree`, masquant le bug
   d'unité du moteur (le moteur disait 200, l'écran disait 19, le vrai
   coût d'un port Gigabit est 4).

### Correction (structurelle)

- **`StpPortRole`** étendu à `backup` (types.ts, documenté). `runElection`
  discrimine désormais à la sortie d'élection : une BPDU supérieure
  **sourcée par notre propre BridgeId** (`bridgeEquals(info.designatedBridge,
  own)`) → `backup`, sinon → `alternate`. Les deux restent en
  `blocking` (`applyRole`). Le chemin root-guard (`alternate` forcé) et
  toutes les topologies point-à-point entre ponts distincts sont
  inchangés — le Backup ne peut naître que d'une BPDU auto-sourcée,
  c.-à-d. d'un segment partagé.
- **Bug d'unité corrigé au bon endroit** : la fonction partagée
  `defaultPathCost` (contrat kbps, couverte par un test) est conservée ;
  les appelants convergent vers un **point de conversion unique**, le
  nouveau helper privé `costForPort(port)` = `defaultPathCost(speedMbps ×
  1000)`. Les trois sites (réception BPDU, `applyRole`, `getPortCost`)
  l'utilisent — fin de la triplication et des replis incohérents
  (`19` vs `defaultPathCost(0)`).
- **Accesseur public `getPortCost(portName)`** : coût mémorisé du port,
  sinon coût live dérivé de la vitesse.
- **CLI** : `show spanning-tree` (Cisco) rend `Back` et le **vrai coût**
  via `agent.getPortCost()` (plus de `19` en dur) ; `display stp brief`
  (Huawei) rend `BACK`.

### Comportements réels gagnés

- Deux ports d'un même commutateur sur un hub : l'un Désigné/forwarding,
  l'autre **Backup**/blocking — observable via `getPortRole` et
  `show spanning-tree` (`Back`).
- Coût de port conforme à la Table 17-3 IEEE : Gigabit 4, FastEthernet
  19, 10 GbE 2 — moteur **et** affichage cohérents.

### Fichiers

- `src/network/stp/types.ts`, `src/network/stp/StpAgent.ts`
- `src/network/devices/shells/CiscoSwitchShell.ts`
- `src/network/devices/shells/HuaweiSwitchShell.ts`
- `src/__tests__/unit/network-v2/stp-rstp.test.ts` (+4 tests)

### Validation

- `stp-rstp` : 10 tests verts (Backup sur segment partagé, Alternate
  préservé en point-à-point, coût dérivé de la vitesse, rendu
  `show spanning-tree` réel).
- Non-régression : 9 suites L2 (stp-rstp, stp-protocol, cisco-stp,
  huawei-stp, stp-guards, stp-tcn, stp-show-subcommands, vlan-advanced,
  huawei-vrp) — **156 tests verts**. `tsc --noEmit` propre ; lint propre
  sur les fichiers touchés.

### Limites restantes (documentées)

- RSTP « sync » (proposal/agreement avec mise en discarding en cascade
  des ports désignés non-edge avant l'agreement, §17.10) reste partiel :
  le modèle de livraison synchrone du simulateur rend la course de
  convergence inobservable ; la transition rapide root-port et le
  handshake proposal/agreement existants suffisent au réalisme actuel.
- MSTP (802.1s, régions/MSTI/CIST) toujours absent (tracé GAP §2.1).

---

## Entrée 32 — STP : type de lien RSTP (P2p/Shr) réel et fonctionnel (802.1D-2004 §6.4.3)

**Date** : 2026-06-13

### Défaillances constatées

1. **Type de lien décoratif et faux.** `show spanning-tree` affichait
   `P2p` **en dur** pour toute interface, quel que soit le duplex. Or le
   `operPointToPoint` de RSTP (802.1D-2004 §6.4.3) se déduit du duplex :
   full-duplex ⇒ point-à-point (éligible à la transition rapide
   proposal/agreement), half-duplex ⇒ segment partagé (hub) qui doit
   retomber sur la marche temporisée listening/learning.
2. **Transitions rapides RSTP non conditionnées au lien.** La transition
   instantanée du root port et l'émission de proposal sur les ports
   désignés se faisaient sur **n'importe quel** lien, y compris un segment
   partagé — où RSTP interdit la transition rapide (risque de boucle).

### Correction (structurelle)

- **Accesseur `getPortLinkType(portName): 'p2p' | 'shared'`** dérivé du
  duplex réel du port (`getDuplex() === 'half'` ⇒ shared).
- **Type de lien rendu fonctionnel** (pas seulement affiché) :
  - `requestForwarding` ne fait la transition rapide du root port que si
    le lien est p2p ; sur un lien partagé, le port marche les timers ;
  - le drapeau `proposal` d'une BPDU désignée n'est posé que sur p2p
    (gardé identiquement dans `requestForwarding` et `sendBpdu`).
- **CLI** : `show spanning-tree` (Cisco) rend `Shr` pour un lien partagé,
  `P2p` sinon, suivi de ` Edge` pour un port PortFast opérationnel —
  conforme à la colonne *Type* d'un vrai IOS (`P2p`, `Shr`, `P2p Edge`).

### Comportements réels gagnés

- Un port half-duplex apparaît `Shr` ; un port PortFast `P2p Edge`.
- Sur un segment partagé, un port désigné qui (re)transitionne après le
  bring-up marche listening→learning au lieu de forwarder instantanément
  — la transition rapide reste réservée aux liens point-à-point.

### Note (limite assumée, déjà documentée)

- Le bring-up initial forwarde instantanément dans **tous** les modes
  (raccourci d'utilisabilité global, déjà present : le test legacy STP
  force une re-transition post-bring-up pour observer listening). Le
  gating de type de lien s'applique donc aux re-transitions, pas au
  premier câblage — cohérent avec l'existant, testé comme tel.

### Fichiers

- `src/network/stp/StpAgent.ts`
- `src/network/devices/shells/CiscoSwitchShell.ts`
- `src/__tests__/unit/network-v2/stp-rstp.test.ts` (+3 tests)

### Validation

- `stp-rstp` : 13 tests verts (type de lien p2p/shared, rendu `Shr`/
  `P2p Edge`, marche temporisée sur lien partagé post-bring-up).
- Non-régression : 8 suites L2 + ping-through-switch — **87 tests verts**.
  `tsc --noEmit` propre ; lint propre.

---

## Entrée 33 — BGP : la conversation passe par de vraies sessions TCP/179 (backlog #16, volet BGP)

**Date** : 2026-06-13

### Défaillance constatée (dernier protocole de routage en god-mode)

1. **Lecture directe du moteur du pair.** `BGPEngine` résolvait ses
   voisins via `peer.peerEngineFor('bgp')` (fourni par le registre
   d'équipements) et lisait **directement** la config et les routes
   annoncées de l'objet moteur voisin (`collectRib`/`advertisedTo`
   récursifs). Aucun paquet BGP n'existait : ni session TCP, ni OPEN, ni
   UPDATE, ni KEEPALIVE. OSPF (entrée 13/22), EIGRP (entrée 27), RIP et
   DHCP (entrée 15) conversaient déjà sur le câble ; BGP était le dernier
   à téléporter son information de contrôle hors-bande.
2. **Pas de FSM RFC 4271, pas de message réel** (GAP §3.7) : l'état de
   session était déduit d'une comparaison de config réciproque, pas d'une
   poignée de main réelle.

### Correction (migration structurelle, en 3 incréments poussés)

- **`bgp/messages.ts`** (entrée précédente) : vocabulaire BGP-4 (OPEN /
  UPDATE / KEEPALIVE / NOTIFICATION), attributs de chemin, NLRI, codes
  d'erreur §6, constantes (port 179, version 4, hold/keepalive), garde
  `isBgpMessage`. `BgpOrigin` réutilisé de `bestPath.ts` (zéro doublon).
- **`bgp/BgpSession.ts`** (entrée précédente) : la FSM par voisin
  (RFC 4271 §8) sur un seam `BgpTransport` — TCP up → OPEN → KEEPALIVE →
  Established, puis UPDATE/KEEPALIVE, NOTIFICATION/hold-timer/close en
  sortie. **Discipline transition-avant-envoi** + **bufferisation des
  UPDATE reçus en OpenConfirm** : la livraison câble étant synchrone (un
  message ré-entre chez le pair avant le retour de `send()`), ces deux
  mécanismes évitent qu'un KEEPALIVE/UPDATE synchrone soit perdu — les
  deux pairs atteignent réellement Established.
- **`BGPEngine` réécrit sur les sessions** : `Map<ip, PeerSession>` avec
  **Adj-RIB-In** (routes apprises des UPDATE), **Adj-RIB-Out** (delta
  envoyé, borne la cascade synchrone), Loc-RIB par best-path RFC 4271
  §9.1.1 (inchangé), réannonce avec prepend d'AS_PATH eBGP, split-horizon
  iBGP, anti-boucle §6.3, et **détection de collision §6.8** (on garde la
  session déjà Established, on remplace une session en cours). Seam
  `BgpWire` injecté (DIP) ; `acceptInbound` pour les connexions entrantes.
  `getContributedRoutes`/`getBgpTable` calculés **en direct** depuis
  l'Adj-RIB-In (cohérents quel que soit l'ordre de convergence). États
  voisins Idle/Active/Established dérivés de la FSM réelle.
- **`RouterDynamicRouting`** : `BgpWire` au-dessus de la vraie
  `TcpStack` du routeur — `connect()` ouvre un TCP/179 sortant (null si
  pas de listener ⇒ Idle, pas de session morte), listener 179 posé
  paresseusement → `acceptInbound`, adaptateur `TcpSocket → BgpTransport`.
  Hook `onRibChange` → `reflectRib()` : un UPDATE qui arrive pendant la
  convergence du **pair** atteint quand même notre RIB. Réannonce
  déclenchée à chaque convergence (un `network` ajouté après l'établissement
  de la session est bien propagé).
- **`Router`** : expose `getTcpStack()` au seam de routage dynamique.

### Comportements réels gagnés

- Adjacence BGP sur une vraie session TCP/179 (3-way handshake sur le
  câble, comme SSH) ; OPEN/UPDATE/KEEPALIVE observables sur le bus TCP.
- `show ip route` : routes `B` apprises par UPDATE réel (eBGP AD 20 /
  iBGP AD 200, next-hop = pair) ; `show ip bgp` / `summary` /
  `neighbors` dérivés des sessions vivantes.
- Coupure de session, AS non réciproque, mismatch d'AS → pas
  d'établissement, pas de route fabriquée.

### Fichiers

- `src/network/bgp/messages.ts` (entrée A), `src/network/bgp/BgpSession.ts`
  (entrée B + buffering), `src/network/bgp/BGPEngine.ts` (réécrit)
- `src/network/devices/router/RouterDynamicRouting.ts`, `src/network/devices/Router.ts`
- `src/__tests__/unit/network-v2/bgp-messages.test.ts` (5),
  `bgp-session.test.ts` (4), `bgp-engine.test.ts` (réécrit sur fabric de
  sessions synchrones, 17)

### Validation

- BGP : 43 tests (messages, FSM, moteur sur fabric, best-path, CLI
  intégration RIB réelle sur deux routeurs câblés).
- Non-régression : **network-v2 complet — 304 fichiers / 7035 tests
  verts** (45 skipped préexistants). `tsc --noEmit` propre ; lint propre
  (les 2 `any` de `Router.ts` sont préexistants, hors de mes lignes).

### Limites restantes (documentées)

- MP-BGP / AFI-SAFI IPv6 (GAP §3.17) non couvert ; le plan de données
  reste IPv4.
- Route-refresh (RFC 2918), communautés, route-maps : hors périmètre.
- Cohérence « eventually consistent » entre convergences (modèle pull
  paresseux commun au simulateur, cf. EIGRP entrée 27) — atténuée par le
  hook `onRibChange` qui pousse les routes apprises hors convergence locale.

---

## Entrée 34 — dot1x : période de silence (held) réellement temporisée (IEEE 802.1X §8.2)

**Date** : 2026-06-13

### Défaillance constatée (GAP §2.4)

1. **État `held` jamais relâché par un timer.** Après `maxReauthReq`
   échecs d'authentification, le port passait en `held` avec
   `holdUntilMs = now + holdMs`, mais **aucun timer** ne le ramenait à
   `unauthorized`. Le seul contrôle (`if (rt.holdUntilMs > Date.now())
   return`) était fait à la réception d'un nouvel EAPOL-Start : un
   supplicant qui n'en renvoyait pas restait **bloqué indéfiniment**,
   contrairement à un vrai commutateur qui rouvre le port à la fin de la
   quiet-period. La raison de transition `'hold-expired'` était déjà
   déclarée dans le type mais **jamais émise** — un point d'extension
   anticipé puis oublié.

### Correction (réactive, pattern Scheduler/TimerSet du projet)

- `Dot1xAgent` reçoit un `getScheduler` (défaut `getDefaultScheduler`,
  comme `StpAgent`) et un `TimerSet`. À l'entrée en `held`, un timer
  `holdMs` est armé (`armOrClearHeldTimer`) ; à son échéance le port
  revient à `unauthorized` (raison `'hold-expired'`, `reauthCount`
  remis à 0 → ré-authentifiable). Tout changement d'état hors `held`
  annule le timer ; `stop()` purge tous les timers.

### Comportement réel gagné

- Un port `held` se rouvre automatiquement après la quiet-period (60 s
  par défaut) et redevient ré-authentifiable, observable via
  `dot1x.port.state.changed` (raison `hold-expired`). Une
  authentification réussie pendant la quiet-period annule proprement le
  timer.

### Fichiers

- `src/network/dot1x/Dot1xAgent.ts`
- `src/__tests__/unit/network-v2/dot1x-protocol.test.ts` (+2 tests, temps virtuel)

### Validation

- `dot1x-protocol` : 13 tests verts (held → unauthorized après holdMs,
  annulation sur auth réussie). `tsc --noEmit` propre ; lint propre.

### Backlog (gros item de câble documenté, non traité cette session)

- **IPSec IKE** (`IPSecEngine`, ~4200 lignes) négocie encore ses SA en
  « engine-to-engine » via `findRouterByIP` + accès direct à `ikeSADB`
  du pair (GAP §4.14) — dernière conversation de contrôle hors-bande.
  Sa migration vers de vrais paquets ISAKMP UDP/500 est un chantier à
  part entière (analogue à BGP, mais plus volumineux), à planifier
  isolément. (DPD est déjà réel depuis l'entrée 17.)

---

## Entrée 35 — dot1x : la dé-autorisation purge la table MAC du port (hook mort réanimé)

**Date** : 2026-06-13

### Défaillance constatée (GAP §2.4)

1. **Hook `applyDot1xAuth` mort.** `CiscoSwitch` câblait
   `onDot1xPortAuthorized → applyDot1xAuth`, mais la méthode était un stub
   vide (`void _portName; void _authorized;`). L'enforcement réel se fait
   via `isPortAuthorized` à l'ingress ; le hook dédié ne faisait rien.

### Correction (réanimation utile, réutilisation de l'existant)

- `flushDynamicMacsOnPort` passe `private → protected` (déjà utilisé pour
  link-down / err-disable).
- `applyDot1xAuth(port, authorized)` : à la **dé-autorisation**, purge les
  entrées MAC dynamiques apprises sur le port — un équipement qui perd son
  autorisation 802.1X ne doit plus être joignable via des entrées
  apprises périmées (comportement réel d'un commutateur). Aucune nouvelle
  surface : on réutilise le mécanisme de flush existant et l'événement
  `switch.mac.flushed`.

### Fichiers

- `src/network/devices/Switch.ts` (visibilité), `src/network/devices/CiscoSwitch.ts`
- `src/__tests__/unit/network-v2/dot1x-protocol.test.ts` (+1 test)

### Validation

- `dot1x-protocol` : 14 tests verts (EAPOL-Logoff → port non autorisé →
  MAC apprise purgée, événement `switch.mac.flushed` émis). `tsc` propre ;
  lint : 4 `any` préexistants dans `Switch.ts` (hors de mes lignes,
  vérifié par `git stash`), aucun introduit.

---

## Entrée 36 — dot1x : suppression des champs de config morts `guestVlan` / `reauthIntervalSec`

**Date** : 2026-06-13

`Dot1xConfig` déclarait `guestVlan` et `reauthIntervalSec` (GAP §2.4) :
ni commande CLI pour les poser, ni lecteur nulle part — de la config
**décorative** annonçant des capacités inexistantes. Conformément à la
recommandation du GAP (« implémenter ou retirer »), les deux champs sont
supprimés du type et du constructeur par défaut. La config dot1x ne
décrit plus que ce qui est réellement supporté (modes de port, users
locaux, `maxReauthReq`, `holdMs` désormais temporisé — entrée 34).
`tsc` propre ; `dot1x-protocol` 14 tests verts.

---

## Entrée 37 — IPSec : la négociation IKEv1 passe par de vrais paquets UDP/500 (backlog IPSec, volet IKEv1)

**Date** : 2026-06-13

### Défaillance constatée (GAP §4.14)

1. **Négociation god-mode.** `negotiateTunnel` → `negotiateIKEv1` →
   `negotiateIPSecSA` atteignaient directement le moteur du pair via
   `findRouterByIP` + `_getIPSecEngineInternal()` : lecture de ses
   politiques ISAKMP, de sa PSK, de ses transform-sets, puis **écriture
   synchrone dans son `ikeSADB`/`ipsecSADB`**. Aucun paquet ISAKMP ne
   traversait le réseau pour l'établissement (seul le DPD était sur le
   fil depuis l'entrée 17). Dernier plan de contrôle hors-bande.

### Correction (migration sur le câble, calquée sur BGP/DPD)

- **Vocabulaire de messages** (entrée précédente) : `IkeMessage`
  (offer/accept/reject) transportant les décisions d'un vrai échange.
- **Initiateur** (`initiateIKEv1Wire`) : construit l'offre depuis SA
  PROPRE config (politiques Phase 1, transform-sets Phase 2, preuve
  dérivée de la PSK, SPI entrant, sélecteurs de trafic, PFS, lifetimes),
  l'émet via `router._sendIkeUdp(peerIP, offer)` (UDP/500 réel à travers
  la FIB), puis lit le résultat — la livraison câble étant synchrone,
  l'accept du répondeur a déjà installé la SA quand l'envoi retourne.
- **Répondeur** (`handleIkeOffer`, branché dans `handleIkeUdp`) : décide
  depuis SA PROPRE config — sélection de politique, vérification de la
  preuve PSK, sélection du transform-set préféré commun (ordre de l'offre),
  contrôle PFS, négociation de lifetime min — installe SES SA (IKE +
  IPSec, QM_IDLE) et répond `accept` (ou `reject`). KEYMAT dérivé d'une
  graine symétrique (PSK + SPIs triés + transforms) ⇒ clés identiques des
  deux côtés sans échange de clé.
- **NAT-T réel sans `findRouterBehindNAT`** : l'offre porte la
  destination adressée ; le répondeur détecte qu'il est derrière un NAT
  quand la destination reçue (DNAT) diffère de la destination adressée
  (ou la source de la source NAT-D), et l'annonce dans l'accept.
- **god-mode supprimé pour IKEv1** : `negotiateIKEv1` (méthode morte)
  retirée ; `negotiateTunnel` route IKEv1 → wire, IKEv2 conserve son
  chemin god-mode (volet suivant). `findRouterByIP`/`peerEngine` n'est
  plus utilisé que par IKEv2 et le rekey/multicast (volets C/D).

### Comportements réels gagnés

- Établissement IKEv1 PSK (main/aggressive) + Quick Mode sur de vrais
  datagrammes UDP/500 ; SA QM_IDLE des deux côtés, plan de données ESP
  fonctionnel (compteurs encaps/decaps exacts), traversée d'un vrai NAT
  pour NAT-T. Échec honnête (pas de politique/transform/PSK communs →
  reject sur le fil → pas de SA fabriquée).

### Fichiers

- `src/network/ipsec/IPSecTypes.ts`, `src/network/ipsec/IPSecEngine.ts`
- `src/__tests__/unit/network-v2/ipsec-ike-messages.test.ts` (3)

### Validation

- IPSec/VPN/GRE/parité : 263 tests verts (ikev1-psk, ikev2-psk,
  modes-pfs, algorithms, failures, esp-confidentiality, esp-icv, advanced,
  dpd-wire, nat-dpd, wan-vpn, huawei-ospf-ipsec-parity, gre).
- Non-régression : **network-v2 complet — 305 fichiers / 7041 tests
  verts**. `tsc` propre ; lint : aucun `any` introduit (58 → 56, la
  méthode morte retirée).

### Reste (volets suivants documentés)

- **IKEv2** (`negotiateIKEv2`) encore god-mode — volet C.
- **Rekey IKE/IPSec** et **install SA multicast** sur le pair encore
  god-mode (`peerEngine.ikeSADB/ipsecSADB`, multicastSADB) — volet D.

---

## Entrée 38 — IPSec : IKEv2 sur le câble — god-mode éliminé de toute la négociation

**Date** : 2026-06-13

### Défaillance constatée (GAP §4.14, volet C)

1. **IKEv2 encore god-mode.** Après l'entrée 37 (IKEv1 sur le fil),
   `negotiateIKEv2` lisait toujours `peerEngine.ikev2Proposals` /
   `findIKEv2PSK` du pair et écrivait son `ikev2SADB` directement, puis
   appelait `negotiateIPSecSA` (lui aussi god-mode) pour la CHILD_SA.

### Correction

- **Échange unifié offer/accept** étendu à IKEv2 : `initiateIkeWire(…,
  version)` porte des propositions IKEv2 (enc/int/dh) et une preuve PSK du
  keyring ; le répondeur (`handleIkeOffer`) sélectionne la proposition
  commune depuis SA PROPRE config, installe son `IKEv2_SA` (READY,
  Responder) + la CHILD_SA IPSec, et répond `accept` (chosenIkev2 + SPIs).
  L'initiateur installe son `IKEv2_SA` (Initiator) à la réception.
- **KEYMAT cohérent par version** : la graine de clé de la CHILD_SA
  utilise la même PSK des deux côtés (keyring pour v2, preSharedKeys pour
  v1) ⇒ clés ESP identiques, ICV vérifiables.
- **`negotiateTunnel` n'a plus aucun god-mode** : il route v1/v2 vers le
  wire. `negotiateIKEv2` et `negotiateIPSecSA` (méthodes mortes, avec
  leurs écritures `peerEngine.*`) supprimées. `findRouterByIP` ne survit
  plus que pour le rekey et l'install SA multicast (volet D).

### Comportements réels gagnés

- Établissement IKEv2 PSK (IKE_SA_INIT/IKE_AUTH/CHILD_SA) sur de vrais
  datagrammes UDP/500 ; `IKEv2_SA` READY des deux côtés (rôles
  Initiator/Responder corrects, SPIs locaux/distants croisés), plan ESP
  fonctionnel, NAT-T détecté sur le fil. Échec honnête sans proposition,
  PSK ou transform commun.

### Fichiers

- `src/network/ipsec/IPSecTypes.ts`, `src/network/ipsec/IPSecEngine.ts`

### Validation

- IPSec/VPN/parité : 250 tests verts (ikev1-psk, ikev2-psk, modes-pfs,
  algorithms, failures, esp-confidentiality, esp-icv, advanced, dpd-wire,
  nat-dpd, wan-vpn, huawei-ospf-ipsec-parity).
- Non-régression : **network-v2 complet — 7041 tests verts**. `tsc`
  propre ; aucun `any` introduit.

### Reste (volet D)

- Rekey IKE/IPSec (`rekeyIKESA` écrit le `ikeSADB` du pair) et install/
  retrait des SA multicast (`peerEngine.installMulticastReceiverSA`…)
  encore god-mode — dernier volet.

---

## Entrée 39 — IPSec : rekey et distribution de SA multicast sur le câble (god-mode SA éliminé)

**Date** : 2026-06-13

### Défaillance constatée (GAP §4.14, volet D — dernier god-mode SA)

1. **Rekey god-mode** : `rekeyIKESA` rafraîchissait le SPI/timestamp de la
   SA IKE locale puis **écrivait directement** la SA du pair
   (`peerEngine.ikeSADB.set`).
2. **Distribution de SA multicast god-mode** : `addMulticastReceiver` /
   `removeMulticastReceiver` / `clearMulticastSAs` installaient/retiraient
   la Group SA sur le moteur de chaque récepteur via `findRouterByIP` +
   `receiverEngine.installMulticastReceiverSA` (modèle GETVPN/GDOI).

### Correction (sur le câble, réalisme préservé)

- **Rekey** : la SA locale est rafraîchie puis un message `ike`
  step `rekey` est émis (`_sendIkeUdp`) ; le pair rafraîchit SA PROPRE
  SA à la réception (`refreshIkeSAFromWire`). Plus d'écriture croisée.
- **Multicast (GDOI sur UDP/500)** : nouveau message `gdoi`
  (install/remove) portant la `MulticastIPSecSA` ; le serveur de groupe
  pousse la SA à chaque récepteur via `_sendIkeUdp(receiverIP, …)`, et le
  récepteur l'installe dans SON propre `multicastSADB`
  (`handleGdoiMessage`). `installMulticastReceiverSA`/
  `removeMulticastReceiverSA` ne sont plus appelés en reaching-in mais par
  le handler filaire du récepteur.

### État final du chantier IPSec

- **Aucune écriture/lecture out-of-bande de SA du pair** : toute la
  machine d'état IPSec (négociation IKEv1/IKEv2, rekey, distribution
  multicast) communique par de vrais datagrammes UDP/500 sur le câble,
  exactement comme DPD (entrée 17). Les seuls `findRouterByIP` restants
  sont des **introspections topologiques en lecture seule** (sélection de
  pair joignable, détection NAT pour l'apparent-source) — pas de
  communication protocolaire hors-bande.

### Fichiers

- `src/network/ipsec/IPSecTypes.ts`, `src/network/ipsec/IPSecEngine.ts`

### Validation

- IPSec/VPN/parité : 250 tests verts.
- Non-régression : **network-v2 complet — 7041 tests verts**. `tsc`
  propre ; aucun `any` introduit ; aucune écriture de SA pair god-mode
  restante (vérifié par grep).

---

## Entrée 40 — Huawei : port-security réel (parité L2), fin du gabarit figé (GAP §2.7)

**Date** : 2026-06-13

### Défaillance constatée (GAP §2.7)

1. **`port-security` Huawei trompeur** : le mot-clé apparaissait en
   auto-complétion d'interface mais **aucun gestionnaire** ne le traitait
   à l'exécution — la commande ne faisait rien.
2. **`display port-security` = gabarit figé** : un stub partagé
   (`HuaweiCommonSecurity.displayPortSecurity`) renvoyait toujours
   « Port-security is enabled on the following interfaces: » sans lire
   l'état réel.

### Correction (réutilisation du service vendor-neutre, zéro duplication)

- Commandes d'interface Huawei câblées sur le **`PortSecurity`
  vendor-neutre par port** (le même que Cisco, `port.getPortSecurity()`) :
  `port-security enable` / `undo …` → `enable/disable` ; `max-mac-num <n>`
  → `setMaxMACAddresses` ; `protect-action {protect|restrict|shutdown}` →
  `setViolationMode` ; `mac-address sticky [<mac> vlan <id>]` →
  `enableSticky`/`addStickyMAC` ; `undo … sticky` → `disableSticky`.
  Parseur MAC Huawei (`xxxx-xxxx-xxxx`).
- `display port-security` rend désormais l'**état vivant** par port
  (enabled/max/action/sticky/secure-count/violations), et les lignes sont
  enregistrées pour `display this`.
- **Stub figé supprimé** : `displayPortSecurity` + son enregistrement
  retirés de `HuaweiCommonSecurity` (fonctionnalité commutateur ; le
  routeur ne fait pas de port-security).

### Fichiers

- `src/network/devices/shells/HuaweiSwitchShell.ts`
- `src/network/devices/shells/huawei/HuaweiCommonSecurity.ts` (stub retiré)
- `src/__tests__/unit/network-v2/huawei-port-security.test.ts` (+5)

### Validation

- `huawei-port-security` : 5 tests verts (enable/max/action pilotent le
  vrai PortSecurity, sticky + MAC apprise, undo, display vivant, running-
  config). Suites Huawei (stp/vrp/switch-shell/acl/eth-trunk) : 141 verts ;
  debug acl-security + huawei-security-mgmt : verts.
- Non-régression : **network-v2 complet — 7046 tests verts**. `tsc` et
  lint propres ; aucun commentaire ajouté dans le code.

---

## Entrée 41 — Huawei : 802.1X (dot1x) réel sur HuaweiSwitch (parité L2)

**Date** : 2026-06-13

### Constat (GAP §2.7, sous l'angle réalisme)

`HuaweiSwitch` ne câblait que LLDP/STP/LACP/IGMP-snooping ; 802.1X
(protocole standard, EAPOL) était absent côté Huawei. (La recommandation
GAP citait aussi « UDLD » — **écarté volontairement** : Huawei n'utilise
pas UDLD mais **DLDP**, un protocole distinct ; ajouter l'UDLD Cisco à un
switch Huawei serait irréaliste.)

### Correction (réutilisation de l'agent vendor-neutre)

- `HuaweiSwitch` instancie et enregistre le `Dot1xAgent` vendor-neutre
  (le même que Cisco) : dispatch des trames `ETHERTYPE_EAPOL`,
  enforcement à l'ingress (`isPortAuthorized`), purge des MAC dynamiques à
  la dé-autorisation (`applyDot1xAuth` → `flushDynamicMacsOnPort`),
  accesseur `getDot1xAgent()`.
- **CLI Huawei réaliste** : système `dot1x enable` / `undo dot1x enable`
  → `setSystemAuthControl` ; interface `dot1x enable` (mode auto) /
  `undo dot1x enable` (disabled) / `dot1x port-control
  {auto|authorized-force|unauthorized-force}` → `setPortMode`
  (mappé sur auto/force-authorized/force-unauthorized). Enregistré pour
  `display this`.

### Comportement réel gagné

- Un commutateur Huawei traite réellement EAPOL : un supplicant
  s'authentifie (handshake EAPOL-Start → Identity → Success), le port
  passe authorized ; `authorized-force`/`unauthorized-force` forcent
  l'état ; la dé-autorisation purge la table MAC du port. Interopère avec
  un supplicant d'un autre vendeur (test Huawei↔Cisco).

### Fichiers

- `src/network/devices/HuaweiSwitch.ts`
- `src/network/devices/shells/HuaweiSwitchShell.ts`
- `src/__tests__/unit/network-v2/huawei-dot1x.test.ts` (+4)

### Validation

- `huawei-dot1x` : 4 tests verts (CLI → agent, force-auth, handshake EAPOL
  réel Huawei↔Cisco, undo). Suites Huawei + dot1x-protocol +
  ping-through-switch : 161 verts.
- Non-régression : **network-v2 complet — 7050 tests verts**. `tsc` et
  lint propres ; aucun commentaire ajouté.

---

## Entrée 42 — STP/MSTP : la région MST appartient au moteur du pont (SSOT), plus à la session CLI

**Date** : 2026-06-13

### Défaillance constatée (GAP §2.1)

La configuration de la région MST (nom, révision, mapping VLAN→instance)
n'existait **que dans la mémoire locale du `CiscoSwitchShell`**
(`this.mstRegion`), jamais transmise au `StpAgent`. La région
appartenait à la session CLI et non au pont — non réaliste (elle devrait
survivre indépendamment de la session et être la source de vérité du
moteur).

### Correction (fondation MSTP, SSOT)

- `StpAgent` possède désormais la région MST (`MstRegion` :
  nom/révision/instances) avec `setMstName`/`setMstRevision`/
  `mapMstInstance`/`unmapMstInstance`/`getMstRegion`.
- `CiscoSwitchShell` délègue toute la sous-config `config-mst` au moteur ;
  `show spanning-tree mst configuration` lit la région du moteur. Champ
  `mstRegion` local au shell supprimé.

### Fichiers

- `src/network/stp/types.ts`, `src/network/stp/StpAgent.ts`
- `src/network/devices/shells/CiscoSwitchShell.ts`
- `src/__tests__/unit/network-v2/cisco-stp.test.ts` (+2)

### Validation

- `cisco-stp` : 6 tests verts (région backed par le moteur, no name/no
  instance reviennent). Suites STP + debug stp/cisco-stp-security : 42
  verts. Non-régression : **network-v2 complet — 7052 tests verts**.
  `tsc`/lint propres ; aucun commentaire ajouté.

### Limite / suite (volet MSTP majeur)

- Ceci est la **fondation** : la région est maintenant dans le moteur,
  mais le calcul de **N arbres par instance (CIST + MSTI)** avec états de
  port par-VLAN n'est pas encore réalisé — c'est une refonte multi-
  instance du `StpAgent` (et du plan de données par-VLAN), à mener comme
  un chantier dédié. L'instance 0 (CIST) reste l'arbre STP/RSTP unique
  existant.

---

## Entrée 43 — HSRP : état Learn réel (RFC 2281 §5) — VIP appris depuis les hellos

**Date** : 2026-06-14

### Constat (GAP §5.1)

L'état `learn` de `HsrpState` était déclaré mais **jamais atteint** : un
groupe sans VIP configuré tombait en `init` au lieu d'apprendre l'adresse
virtuelle. (À noter : `speak`/`listen`, aussi cités au GAP, étaient déjà
atteints — constat partiellement périmé.)

### Correction (réaliste, RFC 2281 §5)

- `standby <grp> ip` **sans adresse** active désormais le mode
  apprentissage : `HsrpAgent.setVipLearn` pose `vipLearn=true`, le groupe
  passe en **`learn`** (lien up, VIP inconnu) au lieu de `init`.
- À la réception d'un hello porteur d'un VIP (depuis le routeur actif), le
  groupe en apprentissage **adopte le VIP** (`g.vip = payload.vip`, event
  `hsrp.vip.learned`) puis recompute → quitte `learn` (listen/standby/
  active selon l'élection). `setVip` (adresse explicite) annule le mode
  learn.

### Fichiers

- `src/network/hsrp/types.ts`, `src/network/hsrp/HsrpAgent.ts`
- `src/network/devices/shells/cisco/CiscoHsrpCommands.ts`
- `src/__tests__/unit/network-v2/hsrp-protocol.test.ts` (+2)

### Validation

- `hsrp-protocol` : 24 tests verts (groupe en `learn` sans adresse ;
  apprentissage du VIP depuis l'actif puis sortie de `learn`).
  cisco-hsrp + fhrp-dataplane : 11 verts.
- Non-régression : **network-v2 complet — 7054 tests verts**. `tsc`/lint
  propres ; aucun commentaire ajouté.

---

## Entrée 44 — GLBP : tracking objects (pondération suivie) — parité FHRP

**Date** : 2026-06-14

### Constat (GAP §5.3)

GLBP n'avait pas de tracking objects (contrairement à HSRP/VRRP désormais
corrigés) : `weighting` était fixe, aucun objet suivi ne la modulait — pas
de bascule d'AVF sur perte d'une interface suivie.

### Correction (réaliste, parallèle à HSRP)

- `GlbpTrackEntry` + `tracks[]` sur le groupe ; helper `effectiveWeighting(g)`
  = `weighting − Σ décréments des interfaces suivies down` (borné à 0).
- `GlbpAgent.addTrack/removeTrack` ; `onLinkUp/onLinkDown` (surchargés en
  conservant le comportement de base iface-down→init) basculent
  `track.down` et resynchronisent la pondération du forwarder local.
- L'AVF **annonce et utilise la pondération effective** : quand elle tombe
  à 0, le forwarder sort de la répartition de charge (filtre `weighting>0`).
- CLI `glbp <grp> weighting track <iface> [decrement <n>]` (défaut 10).

### Fichiers

- `src/network/glbp/types.ts`, `src/network/glbp/GlbpAgent.ts`
- `src/network/devices/shells/cisco/CiscoVrrpGlbpCommands.ts`
- `src/__tests__/unit/network-v2/glbp-protocol.test.ts` (+1)

### Validation

- `glbp-protocol` + `cisco-vrrp-glbp` : 17 tests verts (pondération
  effective baissée quand le lien suivi est down, restaurée à up ; le
  comportement iface-down→init préservé). Non-régression : **network-v2
  complet — 7055 tests verts**. `tsc`/lint propres ; aucun commentaire.

---

## Entrée 45 — Audit des commandes Cisco (mode par mode) : validation d'arguments + DRY

**Date** : 2026-06-15

Audit systématique des commandes Cisco demandé (argument, message
d'erreur, effet réel sur l'état), en mutualisant le commun switch/routeur.

### Mode interface (config-if)

- `ip address` acceptait silencieusement un masque invalide
  (`999.0.0.0`, non contigu `255.0.255.0`) et configurait l'interface.
  Désormais validé (`isValidIPv4` + nouveau `isValidSubnetMask` partagé
  dans `core/ip.ts` — vérifié inexistant avant ajout) → `% Invalid input
  detected at '^' marker.`, état inchangé.
- `speed` **avalait** l'erreur de `Port.setSpeed` (`catch {}`) ;
  `duplex`/`mtu`/`bandwidth` ignoraient silencieusement les valeurs
  invalides. Désormais ils renvoient l'erreur IOS et réutilisent la
  validation existante de `Port` (setSpeed/setMTU lèvent déjà).

### Mode global config

- `ip route` : même trou de masque (routes boguées installées) ; message
  d'erreur non-IOS pour un next-hop invalide ; **distance administrative
  ignorée** (statiques flottantes impossibles). Validé (réutilise les
  helpers), AD 1-255 honorée → `addStaticRoute` mappe la distance sur
  `ad` (la distance d'une statique EST son AD).
- `enable secret`/`enable password` acceptaient une valeur vide.
  → `% Incomplete command.`

### DRY (une seule implémentation)

- `hostname` était enregistré **4 fois** ; sur le routeur la copie
  sécurité gagnait et n'utilisait que `setHostname` (laissait `this.name`
  périmé — bug réel affectant logs/affichages), alors que le switch
  mettait à jour les deux. Doublons retirés → handler unique du base
  (`_setHostnameInternal`, met à jour hostname **et** name) partagé.
- `enable secret`/`password` dédupliqués (base unique ; la copie sécurité
  écrivait `sec().enableSecret`, jamais lu — `show running-config` lit
  `getEnableSecret`).

### Validation

- +4 fichiers de tests (cisco-interface-validation, cisco-ip-route-validation,
  cisco-hostname-dry, cisco-enable-password). Non-régression : **network-v2
  complet — 7067 tests verts** à chaque incrément. `tsc` propre ; aucun
  commentaire ajouté.

### Mode config-router (OSPF / EIGRP / BGP / RIP)

- `router-id` acceptait une IP invalide (`router-id 999.1.1.1` → "")
  pour OSPF, EIGRP et BGP. Désormais validé via `isValidIPv4` (helper
  existant réutilisé) → `% Invalid input detected at '^' marker.` ; un
  argument manquant → `% Incomplete command.` (EIGRP/BGP n'imposaient pas
  l'argument).
- `redistribute <proto-inconnu>` était accepté silencieusement
  (`redistribute bogus` → "") pour OSPF, EIGRP et BGP, et le message RIP
  était non-IOS (`% Invalid input detected.`). Validation unifiée contre
  l'ensemble connu (connected/static/rip/ospf/eigrp/bgp/isis) → message
  IOS standard ; argument manquant → `% Incomplete command.`
- `neighbor` (BGP) sans argument, ou avec une IP invalide, **plantait la
  convergence** (`tryIpToUint32(undefined).split` → crash) car un voisin
  au pair indéfini était poussé dans le moteur BGP. Désormais : argument
  manquant → `% Incomplete command.` ; `neighbor <ip>` sans sous-commande
  → `% Incomplete command.` ; IP invalide → message IOS ; `remote-as` sans
  AS → incomplet ; AS non numérique / hors plage (1-4294967295) → message
  IOS. Les définitions de peer-group par nom (`neighbor IBGP peer-group`)
  restent acceptées.
- `network` (EIGRP/BGP) acceptait n'importe quoi en silence (y compris une
  IP invalide ou aucun argument). Validé via `isValidIPv4` + incomplet.
- +1 fichier de tests (cisco-router-protocol-validation). Non-régression :
  **network-v2 complet — 7083 tests verts**. `tsc` propre ; aucun
  commentaire ajouté.

### Mode global config — services partagés (logging / NTP / DNS) + DRY

- `logging` : le switch avait **sa propre implémentation** (`_setSyslogServer`,
  une seule chaîne, sans la richesse du moteur). DRY appliqué : handler
  unique du base (LoggingConfig + vrai SyslogAgent, déjà compatible switch
  via `getSyslogAgent`). Le doublon switch est retiré ; `show logging` et
  `show running-config` du switch lisent désormais la config unifiée
  (`this.logging.hosts` / `asRunningConfigLines`). Champs morts
  `syslogServer`/`_getSyslogServer`/`_setSyslogServer` supprimés de
  `Switch.ts`. Validation ajoutée (routeur ET switch) : `logging host`
  sans IP → incomplet ; IP invalide → message IOS.
- `ntp server`/`ntp peer` sans cible renvoyaient "" → `% Incomplete command.`
- `ip name-server` : sans arg → incomplet ; IP invalide acceptée en
  silence → message IOS (réutilise `isValidIPv4`).
- `ip domain-name` : **split-brain réel** — un doublon dans
  CiscoSecurityCommands gagnait et écrivait `sec().domainName` (lu seulement
  par la section running-config sécurité), si bien que `show hosts` lisait
  `mgmt.domainName` resté vide → « Default domain is not set » alors que la
  running-config affichait le domaine. Doublons retirés → handler base
  unique (écrit `mgmt.domainName`) ; running-config et `show hosts`
  cohérents ; sans arg → incomplet. Champs morts `hostname`/`domainName`
  + émetteur retirés de `CiscoSecurityConfig`.
- +1 fichier de tests (cisco-logging-validation, contexte LAN routeur+switch
  câblés, vérifie l'effet réel via show logging / running-config / show
  hosts). Non-régression : **network-v2 complet — 7088 tests verts**.
  `tsc` propre ; aucun commentaire ajouté.

### Mode config-if — adresses IPv4 secondaires (fonctionnalité réelle)

- Détecté en **contexte LAN** (deux routeurs câblés) : `ip address X Y
  secondary` **écrasait l'adresse primaire** au lieu d'ajouter une
  secondaire — la connectivité tombait silencieusement (ping 0%). Le
  mot-clé `secondary` était purement ignoré.
- Implémentation complète (pas un stub), vérifiée par ping bout-en-bout
  sur les deux sous-réseaux :
  - `Port` : stockage `secondaryIPs[]` + `addSecondaryIP`/`removeSecondaryIP`/
    `getSecondaryIPs`/`ownsIPv4` ; `clearIP` purge aussi les secondaires.
  - `Router.configureInterface(..., secondary)` : ajoute l'adresse + une
    route connectée sans toucher la primaire ; `removeSecondaryAddress`
    pour le retrait ciblé.
  - Plan de données : réponse ARP sur primaire **et** secondaires
    (`ownsIPv4`, senderIP = IP demandée), livraison locale ICMP, sélection
    d'interface (`findInterfaceForIP`/`peerOnSameSubnet`) sur les
    sous-réseaux secondaires.
  - running-config (global et par interface) émet `ip address X Y secondary`.
  - CLI : mot-clé `secondary` câblé ; un mot-clé invalide en 3e position →
    message IOS ; `no ip address X Y secondary` retire une secondaire en
    gardant la primaire.
- +1 fichier de tests (cisco-secondary-address, contexte LAN : running-config,
  table de routage, ping primaire+secondaire, retrait). Non-régression :
  **network-v2 complet — 7093 tests verts**. `tsc` propre ; aucun
  commentaire ajouté.
- Cohérence : `show running-config interface` n'émettait pas la
  `description` (la running-config globale, si). Ajoutée (réutilise
  `getInterfaceDescription`). Test ajouté dans cisco-interface-validation.

### Mode privileged EXEC — `reload` du switch (bug signalé en prod) + DRY

- **Bug réel (version déployée)** : sur un switch, `reload in 5` éteignait
  l'appareil **immédiatement** au lieu de planifier. Cause : le switch avait
  son propre handler `reload` (exact, `powerOff()`+`powerOn()`) qui ignorait
  les arguments `in`/`at`/`cancel` et gagnait sur le handler de base (lequel
  ne savait planifier que pour le routeur via `_scheduleReload`).
- DRY appliqué : handler `reload` unique dans CiscoShellBase (parsing +
  validation `in`/`at`/`cancel`), avec deux points d'extension protégés —
  `performImmediateReload()` (par défaut « Reload requested » ; le switch
  redémarre réellement → « System restarting... ») et
  `performScheduledReload()` (déclenché par un vrai minuteur à l'échéance ;
  le switch power-cycle). Le doublon switch est retiré.
- `reload in N` planifie via un minuteur (`unref` pour ne pas retenir la
  boucle d'événements) ; ne touche plus à l'alimentation immédiatement.
  `reload cancel` annule le minuteur. `reload in abc`/`reload in`/`reload at`
  → messages IOS sans redémarrage accidentel.
- `show reload` était un **stub** (`showReload()` renvoyait toujours « No
  reload is scheduled. »). Désormais il reflète l'échéance réelle (suivie
  dans le shell de base, cohérent routeur ET switch) ; doublon de handler
  `show reload` retiré.
- +1 fichier de tests (cisco-switch-reload). Non-régression :
  **network-v2 complet — 7098 tests verts**. `tsc` propre ; aucun
  commentaire ajouté.

### `reload` réellement partagé routeur+switch + descriptions d'aide ?

- Suite : le routeur ne redémarrait pas vraiment (`reload` cosmétique →
  « Reload requested », pas de power-cycle), seul le switch surchargeait le
  comportement. Unifié : les hooks de base `performImmediateReload` /
  `performScheduledReload` font désormais le vrai power-cycle
  (`powerOff()`+`powerOn()`, retour en mode user) pour **routeur ET switch** ;
  la surcharge switch est supprimée. `reload` redémarre maintenant
  réellement le routeur (vérifié : `getIsPoweredOn()` revient à true,
  « System restarting... »). Champs morts `_scheduleReload` /
  `_getScheduledReloadMs` / `_scheduledReloadAtMs` retirés de `Router.ts`
  (l'échéance est suivie par le shell de base, source unique).
- Descriptions d'aide « paresseuses » : les mots-clés qui ne sont qu'un
  préfixe (`show ...`, `configure terminal`, `no ...`, etc.) gardaient une
  description = le mot-clé lui-même (« configure  configure »). Ajout de
  `CommandTrie.setCanonicalDescription` consulté à l'affichage du `?`
  (uniquement quand la description est le placeholder), + une table
  canonique partagée (`applyCanonicalDescriptions`) appliquée aux tries
  user/privileged/config de **tous** les équipements Cisco. Corrige
  configure/show/no/clear/erase/sntp/copy/debug/undebug/write/event en EXEC
  et configure/no/show/sntp/cdp/lldp/ip/ipv6/mac/errdisable/vtp/enable/
  router/key/security/event/flow/parameter-map/zone/zone-pair en config.
- Non-régression : **network-v2 complet — 7099 tests verts**. `tsc` propre.

### Commandes manquantes au `?` + EXEC privilégié = sur-ensemble de l'EXEC utilisateur (DRY)

- Constat : sur le switch, `ping` n'était dispo qu'en mode utilisateur, pas
  en mode privilégié (en IOS réel, le privilégié inclut tout l'EXEC
  utilisateur). Le routeur, lui, **dupliquait** l'enregistrement de
  `ping`/`traceroute` dans les deux tries — exactement le « deux fois » à
  éviter.
- Correctif DRY structurel : `CommandTrie.importMissingFrom` ; le shell de
  base importe les commandes de l'EXEC utilisateur absentes de l'EXEC
  privilégié (sans réenregistrer, les surcharges privilégiées priment). Le
  routeur n'enregistre plus `ping`/`traceroute` qu'une seule fois (mode
  utilisateur) ; ils restent disponibles et fonctionnels en privilégié
  (vérifié : ping 100% en mode privilégié). S'applique à tous les
  équipements Cisco.
- `clear mac address-table [dynamic] [vlan N | interface IF]` : commande L2
  **propre au switch** (le routeur n'a pas de table MAC) — implémentée une
  seule fois sur le switch via `clearDynamicMACEntries` (n'efface que les
  entrées dynamiques, garde les statiques ; filtre vlan/interface ; rejette
  une interface inconnue).
- Limite connue (non corrigée — vrai L2) : le `ping` du switch reste
  « % Ping not yet implemented on switch. » (un switch L2 pingue depuis une
  SVI de management, non modélisée ici) ; message honnête, pas un faux
  succès.
- +1 fichier de tests (cisco-switch-exec-commands). Non-régression :
  **network-v2 complet — 7103 tests verts** + suites shell/terminal (967)
  vertes. `tsc` propre ; aucun commentaire ajouté.

### Scénarios de référence Switch (Catalyst 2960) — fichier de tests unique + DRY enable secret

- Nouveau fichier unique `cisco-switch-reference-scenarios.test.ts` :
  topologie de référence (Switch1 + Linux-SRV sur Fa0/1 + Win-Client sur
  Fa0/2) couvrant les 16 commandes de l'analyse. 14 scénarios **verts**
  (`?`, enable >→#, enable secret persistée, show mac address-table appris
  sur Fa0/1, terminal length 0, debug/undebug/no debug all, configure
  terminal + isolation VLAN qui coupe le L2, disable, write [OK], erase
  startup-config [confirm]/[OK], reload, clear mac address-table dynamic +
  réapprentissage, statiques préservées).
- DRY : `enable secret`/`enable password` n'étaient stockés que par le
  routeur (sur le switch la commande était silencieusement ignorée).
  Déplacés dans la base partagée `Equipment` (`getEnableSecret`/
  `_setEnableSecret`/`getEnablePassword`/`_setEnablePassword`) ; retirés du
  routeur (hérités) ; la running-config du switch les émet (réutilise
  `renderSecretField`/`renderPasswordField`). Implémenté une seule fois.
- Lacune clé identifiée et documentée (4 tests `it.skip`, prêts à activer) :
  **la SVI de management L2 (`interface Vlan1` + IP)** n'est pas modélisée
  (le switch est strictement L2). Elle conditionne : ping depuis le switch,
  client ssh/telnet sortant, `copy ... tftp:` réel, synchro `sntp`. À
  implémenter ensuite (chantier conséquent, à valider).
- Non-régression : **network-v2 complet — 7117 tests verts** (49 skipped).
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 46 — Analyse des dumps L2 : fichier 1 (CLI basics) + écarts comblés

### Harnais de debug
- `dumpL2` : les marqueurs `{ section }` sans `cmd` appelaient
  `executeCommand(undefined)` → exceptions JS parasites. Corrigé (on saute
  l'exécution quand `cmd` est vide).

### Écarts réels comblés (fichier cisco-l2-01-cli-basics)
- **Commandes `show` absentes en EXEC utilisateur** : en IOS réel la plupart
  des `show` sont privilège 1. Le switch ne les enregistrait qu'en mode
  privilégié. Ajout de `CommandTrie.copySubtreeChildrenInto('show', …)` :
  CiscoShellBase recopie la sous-arborescence `show` du trie privilégié vers
  le trie utilisateur (sauf la liste privilège-15 : running-config,
  startup-config, tech-support, archive). Mécanisme **partagé routeur+switch**
  (et donc tout vendor Cisco) ; `show interfaces status`, `show vlan brief`,
  etc. fonctionnent désormais en EXEC utilisateur. Lit l'état réel (handlers
  existants), aucun hardcode.
- **`show flash:`** (forme canonique IOS avec deux-points) rejetée car
  `flash:` est un token distinct de `flash`. Alias ajouté (même handler réel
  `showFlash`).
- `where` / `show sessions` : **NON implémentés** volontairement — ils
  reflètent des sessions sortantes suspendues (Ctrl-Shift-6 x) non modélisées
  dans le simulateur. Plutôt qu'un faux « % No connections open » hardcodé
  (rejeté), on les laisse non gérés (honnête) en attendant une vraie gestion
  des sessions sortantes. À noter pour un éventuel chantier.
- Non-régression : **network-v2 — 7126 verts** ; 9 dumps L2 régénérés.
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 47 — `show sessions` / `where` / telnet : vraie fonctionnalité (zéro hardcode)

- Refus du stub `() => '% No connections open'`. Implémentation réelle :
  `OutgoingSessionRegistry` (état réel des connexions sortantes : conn#,
  hôte, adresse, protocole, user, idle, octets) — classe réutilisable,
  partagée routeur+switch via `CiscoShellBase`, réutilisable par d'autres
  vendors.
- `ssh` (client réel `runSshClient`) enregistre une session sur connexion
  interactive réussie (exit 0, sans commande inline) ; un échec d'auth ne
  crée **aucune** session (comportement réel vérifié).
- `telnet` n'est plus un stub « % Connection refused » figé : il résout la
  cible (`ip host`), choisit une interface source, vérifie l'accessibilité
  réelle (`findHostByAddress` + `isPathReachable`) et n'ouvre une session
  que si un service Telnet (équipement réseau CLI avec transport telnet/all,
  port 23) répond. Sinon : message réel selon la cause (timeout si éteint/
  injoignable, refused si pas de service Telnet).
- `show sessions` / `where` rendent le **registre réel** ; vide → « % No
  connections open » calculé (pas codé en dur). `disconnect [n]` ferme une
  session réelle ; `resume [n]` la réactive.
- Vérifié bout-en-bout : telnet R1→R2 (joignable) → « Open » + session
  listée dans `show sessions` ; `disconnect 1` → fermée → registre vide.
- Non-régression : **network-v2 — 7126 verts** ; `tsc` propre ; aucun
  commentaire dans le code.

## Entrée 48 — Analyse dumps L2 : show interfaces / show cdp interface filtrés (vrais détails)

- **`show interfaces <nom>`** renvoyait la table `status` globale au lieu du
  détail de l'interface (bug : tout retombait sur `showInterfacesStatus`).
  Cause : doublons d'enregistrement exact `show interfaces`/`show interfaces
  status` qui écrasaient l'action du handler greedy. Doublons retirés ;
  dispatcher réécrit : `show interfaces` (sans arg) → détail de TOUTES les
  interfaces ; `show interfaces <nom>` → détail de cette interface ;
  `<nom> switchport` → switchport filtré ; `<nom> counters` → compteurs de
  ce port ; `counters`/`description` → tables ; `status`/`trunk` conservés.
- **`showInterface` élargi (DRY multi-vendor)** : signature structurelle
  (`{ _getPortsInternal() }`) pour servir routeur ET switch ; enrichi avec
  les compteurs réels (packets/bytes input/output, input/output errors,
  drops via `port.getCounters()`) — manquaient à l'analyse.
- **`show cdp interface <nom>`** ne filtrait pas (boucle sur tous les ports).
  Ajout d'un matcher d'interface tolérant aux abréviations (fa0/1 ↔
  FastEthernet0/1) dans `showCdp` (partagé) → filtre réel sur le port donné.
- Lecture d'état réel uniquement (ports, compteurs) ; aucun hardcode.
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés ;
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 49 — Analyse dumps L2 : show terminal & show version réels

- **`show terminal`** était entièrement codé en dur (Length 24/Width 80/
  history 20) — ignorait l'état réel. Désormais il lit `terminalLength`,
  `terminalWidth` et le nouveau `terminalHistorySize` (stocké et validé
  0-256 par `terminal history size N`). Vérifié : après `terminal length 0`/
  `width 132`/`history size 50`, `show terminal` reflète bien 0/132/50.
- **`show version` (switch)** était minimal/figé. Nouvelle fonction partagée
  `showSwitchVersion(dev)` lisant l'état **réel** : uptime réel
  (`getUptimeMs`), comptes de ports réels (24 Fa + 2 Gi), identité matérielle
  du profil C2960 (serial, DRAM/NVRAM, image flash), MAC de base réelle
  (`02:00:00:00:00:01`). Les deux enregistrements (user + privileged) la
  réutilisent (DRY). Pas de valeurs inventées : seules l'identité matérielle
  modélisée et les compteurs réels.
- Faux positifs de l'analyse écartés (vérifiés) : `show controllers` état
  admin correct (les ports Fa0/4-8 n'étaient pas encore `shutdown` à l'étape
  58 ; le shutdown est à l'étape 90) ; le préfixe « sw1 » devant le prompt
  est l'étiquette de l'équipement dans le harnais de dump, pas le prompt réel.
- `show processes cpu/memory` laissés en sortie honnête (le modèle n'a pas
  d'ordonnanceur/pool mémoire ; fabriquer des process/octets serait
  précisément le stub interdit).
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés ;
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 50 — Analyse dumps L2 : topologie réellement trunkée + formats corrigés

- **Topologie « trunked » rendue vraie** : `buildLan` configure désormais
  réellement les liaisons inter-switch en `switchport mode trunk` (SW1/SW2
  Gi0/1, CORE Gi0/0+Gi0/1, encapsulation dot1q). La note de topologie n'est
  plus trompeuse ; la connectivité VLAN 1 reste OK (VLAN natif sur le trunk).
- **`show interfaces trunk`** : formatage corrigé (nom de port abrégé
  `Gi0/1`, colonnes alignées) — auparavant « GigabitEthernet0/1on » (nom
  trop long écrasant la colonne). Les trunks réels sont bien listés.
- **`show interfaces status`** : colonne Speed/Type fusionnée
  (`a-10001000BASE-T`) corrigée → `a-1000 1000BASE-T` ; la colonne Vlan
  affiche « trunk » pour un port trunk.
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés
  (montrent maintenant les trunks) ; `tsc` propre ; aucun commentaire.

## Entrée 51 — Analyse dumps L2 fichier 4 : show spanning-tree cohérent

- Bugs signalés (#5) corrigés dans le rendu STP du switch :
  - **Rôle « Disa » avec état « FWD »** (incohérent) : les ports non
    opérationnels (notconnect / shutdown) étaient listés en Forwarding.
    Désormais `show spanning-tree` ne liste que les ports réellement up +
    connectés (comportement IOS réel) — les rôles/états deviennent cohérents.
  - **Numéros de port invalides** (`128.00`, `128.010`) : remplacés par un
    index de port stable et unique (`128.2`, `128.3`, … `128.26`).
  - **Type « P2p » partout** y compris notconnect : seuls les ports
    opérationnels (donc réellement P2p/Shr) apparaissent.
  - **`show spanning-tree summary`** comptait les 26 ports en Forwarding ;
    désormais seuls les ports opérationnels sont comptés (4 Forwarding / 4
    Active dans le lab).
- Lecture d'état réel (connectivité des ports via `_getPortsInternal`,
  rôles via `StpAgent`) ; aucun hardcode.
- Tests existants encodant l'ancien comportement bogué mis à jour pour être
  réalistes (switch-cli : port câblé ; stp-rstp : port edge câblé à un voisin).
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés ;
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 52 — UI : la bannière de boot se réaffiche à la réouverture d'un terminal

- Symptôme : fermer un terminal puis en ouvrir un nouveau (même équipement)
  n'affichait plus la bannière de boot — le 2e terminal tombait directement
  sur le prompt.
- Cause : `_bootShown` est porté par l'équipement et n'était remis à zéro
  qu'au power-cycle ; jamais à la fermeture des terminaux.
- Correctif : `Equipment.clearBootShown()` ; `TerminalManager.closeTerminal`
  réinitialise le flag quand **le dernier** terminal d'un équipement se ferme.
  Ainsi une réouverture après déconnexion complète rejoue la bannière, tandis
  que des terminaux concurrents ne re-bootent pas (le 1er boote, les autres
  tombent sur le prompt tant qu'une session reste ouverte).
- Vérifié : open→boot, 2e concurrent ne reboote pas, fermeture du dernier →
  flag remis à zéro, réouverture → boot rejoué. Suites react/gui/terminal
  (560) vertes ; `tsc` propre ; aucun commentaire ajouté.

## Entrée 53 — #9 : prérequis crypto / login local / transport input ssh

- Vérité IOS : `login local` (sans username) et `transport input ssh` (sans
  clés) **n'échouent pas à la configuration** ; l'échec est au login/runtime.
  Le simulateur les acceptait silencieusement → comportement **déjà correct**
  (ajouter un avertissement serait fabriquer une sortie que l'IOS réel n'émet
  pas).
- Le seul vrai prérequis vérifié à la saisie par l'IOS est
  `crypto key generate rsa`, qui exige un domaine défini. Ajouté (routeur) :
  sans `ip domain-name`, retourne « % Please define a domain-name first. »
  et ne génère aucune clé ; avec domaine → génération normale. Lit l'état
  réel (`getManagementService().domainName`).
- Note : sur le switch, `crypto`/SSH de management dépendent de la SVI L2
  (chantier déjà identifié) ; non traité ici.
- Non-régression : **network-v2 — 7117 verts** ; `tsc` propre ; aucun
  commentaire ajouté.

## Entrée 54 — Analyse dumps L2 fichier 2 (VLAN/access)

- Sous-système VLAN globalement **correct** (vérifié) : cycle de vie des
  VLAN, plages/listes, attribution des ports d'accès reflétée dans
  `show vlan brief`, isolation VLAN réelle (même VLAN inter-switch = OK ;
  VLAN différents = 100% perte), voice VLAN.
- Seul vrai manque : **`show vlan summary`** non implémenté → ajouté, lit les
  compteurs réels (`getVLANs()` ; VLAN normaux vs étendus ≥ 1006).
- Faux positifs (artefacts de séquence de test, pas des bugs sim) :
  - `interface range GigabitEthernet0/0 - 1` « échouait » car le test était
    retombé en mode privilégié — `vlan 10,20` (liste) **reste en config**
    (comportement IOS réel), donc le `exit` qui suivait sortait du config.
    Séquence du fichier de debug corrigée ; la commande fonctionne en config.
  - `vlan abc/0/4096/5000` → « % Invalid VLAN ID » : négatifs intentionnels,
    corrects.
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés ;
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 55 — Vérification du rapport fichier 2 : 6 défaillances traitées

1. **Fuite MAC inter-VLAN (critique)** — CORRIGÉ. Une MAC apprise en VLAN 1
   (ARP gratuit pendant la config IP de l'hôte, port encore en VLAN 1)
   restait après le changement de VLAN d'accès → doublon VLAN1+VLANx.
   `setSwitchportAccessVlan` purge désormais les MAC dynamiques du port
   (`flushDynamicMacsOnPort`), comme un vrai switch. Vérifié : la MAC
   n'apparaît plus que dans le VLAN configuré.
2. **Ligne `switchport trunk encapsulation dot1q` dupliquée** — CORRIGÉ.
   `recordIf` dédoublonne par verbe (3 premiers tokens) → une seule ligne.
3. **Trunk « implicite »** — désormais légitime : `buildLan` configure
   réellement les trunks ; l'artefact CORE (commandes en mode privilégié)
   venait de la séquence de test, corrigée.
4. **Voice VLAN non affiché** — CORRIGÉ. `switchport voice vlan N` stocke
   `cfg.voiceVlan` (handler dédié) ; affiché dans `show interfaces … switchport`
   (« Voice VLAN: 50 ») et dans la running-config.
5. **BW/débit FastEthernet à 1 Gbps** — CORRIGÉ. Les ports FastEthernet
   prennent 100 Mbps à la création (`port.setSpeed(100)`) → `BW 100000
   Kbit/sec`, `100Mbps` ; le coût STP redevient 19 (et 4 en gigabit).
6. **`show vlan summary`** — CORRIGÉ (entrée 54).
- Tests STP encodant l'ancien coût gigabit des ports Fa mis à jour (19).
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés ;
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 56 — Compteurs d'octets cohérents + purge MAC (link-flap)

1. **Compteur d'octets bloqué à 0** alors que les paquets augmentaient
   (anomalie physique) — CORRIGÉ. `Port.sendFrame`/`receiveFrame`
   incrémentent désormais `bytesOut`/`bytesIn` via `ethernetFrameBytes()`
   (nouvelle aide dans core/types : en-tête 14 + payload réel — totalLength
   IPv4, 28 ARP, 40+payloadLength IPv6 — + FCS, minimum trame 64 octets).
   Vérifié : « 12 packets input, 1186 bytes » (au lieu de 0 bytes).
2. **Purge de la table MAC** — déjà couverte : changement de VLAN d'accès
   (`setSwitchportAccessVlan` → flush, entrée 55) ET link-flap (flush sur
   link-down déjà câblé dans `initPorts.onLinkChange`). Vérifié : une MAC
   n'apparaît que dans le VLAN configuré et est oubliée au down du port.
- Tests `ifconfig` byte-exact (local vs SSH) : la normalisation des
  compteurs ne masquait pas le suffixe lisible « (0.5 KiB) » ; ajout du
  strip `(*)` — les octets étant désormais non nuls et propres à chaque
  équipement.
- Non-régression : **network-v2 — 7117 verts** ; 9 dumps L2 régénérés ;
  `tsc` propre ; aucun commentaire ajouté.

## Entrée 57 — Fichier 3 (item A+E) : DTP reflété dans show … switchport

- `show interfaces … switchport` lisait `cfg.mode` (access/trunk) + une
  négociation codée en dur → `dynamic auto/desirable` apparaissaient comme
  « trunk » et `nonegotiate` affichait quand même « Negotiation: On ».
- Corrigé en lisant l'état réel de l'agent DTP (`getAdminMode` /
  `getOperationalMode`) : Administrative Mode = static access / trunk /
  dynamic auto / dynamic desirable ; Negotiation = Off seulement pour access
  et nonegotiate ; sections trunk affichées selon le mode opérationnel réel.
- Label native VLAN corrigé (item E) : « (default) » uniquement pour le
  VLAN 1 (ex. « Trunking Native Mode VLAN: 99 », sans « (default) »).
- Non-régression : network-v2 — 7117 verts ; tsc propre ; aucun commentaire.

## Entrée 58 — Fichier 3 (item B) : show interfaces trunk complet

- `show interfaces trunk` ne montrait que la 1ʳᵉ section (Mode/Encap/Status/
  Native) ; les opérations `switchport trunk allowed vlan {…|add|remove|
  except|none}` étaient invisibles.
- Ajout des 3 sections IOS manquantes, calculées depuis l'état réel :
  « Vlans allowed on trunk » (cfg.trunkAllowedVlans), « Vlans allowed and
  active in management domain » et « Vlans … forwarding state » (allowed ∩
  VLAN existants). Ports trunk déterminés par le mode opérationnel DTP réel.
- Non-régression : network-v2 — 7117 verts ; tsc propre ; aucun commentaire.

## Entrée 59 — Fichier 3 (items C+F) : show vtp password + capacité VTP

- `show vtp password` ajouté (user + privileged) : lit l'état réel
  (`getVtpAgent().getConfig().password`) → « VTP Password: secret123 » ou
  « The VTP password is not configured. ».
- Item F : « VTP Version capable » ne dépend plus de la version configurée
  (était « 1 to {version} ») → « 1 to 2 » (capacité matérielle réelle du
  C2960, indépendante du running version).
- Non-régression : network-v2 — 7117 verts ; tsc propre ; aucun commentaire.

## Entrée 60 — Fichier 3 (item D) : show interfaces <if> trunk

- `show interfaces <if> trunk` ajouté : la logique de rendu trunk extraite
  dans `showTrunkTable(portNames)` (DRY), appelée par `show interfaces trunk`
  (tous les ports) et par la vue par interface (filtre sur un port). Une
  interface non-trunk renvoie l'en-tête seul ; une interface inconnue → IOS
  invalid input.
- Non-régression : network-v2 — 7117 verts ; tsc propre ; aucun commentaire.
