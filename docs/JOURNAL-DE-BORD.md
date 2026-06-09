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
| 2 | TCP : état TIME_WAIT déclaré mais jamais utilisé (pas de 2MSL) | RFC 793 §3.5 | Haute | À faire |
| 3 | HSRPv2 : MAC virtuelle malformée (`0000.0c9f.fXXX` sur 3 digits) | RFC visant HSRPv2 (draft) / réalité Cisco | Moyenne | À faire |
| 4 | FHRP : ~450 lignes dupliquées entre HsrpAgent / VrrpAgent / GlbpAgent (timers, machine à états, construction de paquets) | DRY / Template Method | Haute | À faire |
| 5 | Helpers IP réimplémentés localement dans OSPF / EIGRP / BGP (`ipToNumber`, `toNum`) au lieu de `core/types.ts` | DRY | Moyenne | À faire |
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
