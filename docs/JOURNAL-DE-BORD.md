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
| 6 | Cycle de vie des agents protocolaires copié-collé dans CiscoRouter / HuaweiRouter / CiscoSwitch / HuaweiSwitch (init + restart `setEventBus`) | Registry pattern | Haute | À faire |
| 7 | `lldpToNeighborDTO` / `cdpToNeighborDTO` dupliqués à l'identique dans 4 fichiers devices | DRY | Moyenne | À faire |
| 8 | Dispatch par `constructor.name` dans ShellFactory / sshLauncher / WindowsTerminalSession (oblige `keepNames: true` au build) | Polymorphisme | Moyenne | À faire |
| 9 | BGP : FSM incomplète (états Connect/OpenConfirm absents), pas de détection de boucle AS-path | RFC 4271 | Haute | À faire |
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

## Limites connues / dette restante

- **Backlog #8 et #10** (dispatch `constructor.name`, ISP sur `Equipment`) :
  identifiés, documentés, non traités dans cette série.
- **BGP** : pas encore de best-path multi-critères complet (local-pref, MED,
  origin) ni de route-reflectors — le moteur reste volontairement simplifié.
- **STP** : RSTP (802.1w) et PVST+ ne sont pas implémentés ; le fast path
  « premier bring-up » simule un comportement type RSTP pour préserver
  l'utilisabilité (décision documentée dans le code).
- **GRE** : checksum non standard (hash JSON) — toléré car purement interne
  à la simulation, signalé ici pour transparence.
- Les firewalls (`firewall-*`), `access-point` et `cloud` restent des stubs
  (`LinuxPC`/`Hub`) — hors périmètre de cette série, à traiter comme des
  fonctionnalités à part entière.
