# PRD — Feuille de route : PIM Snooping pour Multicast VPN (mVPN)

## 0. Contexte et portée — pourquoi ce document n'est pas comme les autres

Chaque PRD précédent de cette série (STP, VTP, IGMP, PIM, PIM Snooping…)
documentait un **moteur déjà existant**, même partiel, et proposait des
phases bornées pour combler des lacunes précises à l'intérieur de ce
moteur. **Ce document ne peut pas suivre ce format** : le PIM Snooping pour
Multicast VPN, tel qu'il existe réellement chez Cisco/Huawei, est la
**dernière couche d'une pile à cinq niveaux**, dont **quatre niveaux
inférieurs sont totalement absents** de ce simulateur — pas partiellement,
pas en version simplifiée, absents au sens strict (recherche exhaustive
confirmée en §1). Écrire un PRD « à phases bornées » sur ce sujet
reviendrait à cacher cette réalité derrière un format qui suggère un
chantier d'une ampleur comparable aux précédents, alors qu'il s'agit en
réalité de **quatre à cinq PRD distincts**, chacun potentiellement aussi
gros ou plus gros que n'importe lequel des PRD déjà écrits dans cette
série. Ce document sert donc de **feuille de route** : il identifie,
dimensionne et séquence cette chaîne de prérequis, sans prétendre la
livrer lui-même.

### 0.1 La chaîne de dépendances complète

```
Couche 0 — DÉJÀ LIVRÉ
  • PIM sparse-mode réel (docs/PRD-PIM.md) — Hello/DR/Join-Prune (*,G),
    forwarding RPF-checké (Router.forwardMulticast)
  • PIM Snooping conçu (docs/PRD-PIM-Snooping.md) — architecture prête,
    pas encore implémentée elle-même
  • BGP unicast IPv4 réel (src/network/bgp/, 994 lignes) — AUCUNE notion
    d'AFI/SAFI (RFC 4760), un seul « paquet » de routes possible
  • Encapsulation GRE réelle mais déconnectée (GreAgent.ts) — confirmé par
    CLAUDE.md et docs/roadmap.md §14.5 : le moteur encapsule/décapsule
    pour de vrai, mais seule la commande Linux `ip tunnel` l'utilise ;
    `tunnel source`/`tunnel destination` côté Cisco/Huawei ne fait que du
    cosmétique, et Router.forwardPacket() n'a aucune conscience des
    tunnels GRE
   │
   ▼
Couche 1 — ABSENTE, jamais mentionnée nulle part dans ce dépôt (ni
  roadmap.md, ni GAP.md, ni CLAUDE.md) — le prérequis le moins reconnu de
  toute la chaîne
  • MPLS (commutation par label) — LDP, en-tête MPLS, plan de données à
    labels, `show mpls forwarding-table`
   │
   ▼
Couche 2 — ABSENTE, mais déjà référencée comme dette connue
  (`docs/roadmap.md §14.6`, « VRF (Virtual Routing and Forwarding) »,
  Priorité: Basse, zéro implémentation actuelle)
  • VRF — tables de routage multiples par équipement, étanchéité entre
    VRF, `ip vrf forwarding`
   │
   ▼
Couche 3 — ABSENTE, mais déjà référencée comme dette connue
  (`docs/roadmap.md §14.8`, « BGP4+ (MP-BGP pour IPv6) », Priorité:
  Basse — actuellement scopée pour IPv6 seulement, pas encore pour VPNv4)
  • MP-BGP (RFC 4760) généralisé à l'AFI/SAFI VPNv4/VPNv6 (RFC 4364) —
    route-distinguisher, route-target, import/export par VRF
   │
   ▼
Couche 4 — ABSENTE, jamais mentionnée nulle part dans ce dépôt
  • Profil mVPN — deux options réelles, dimensionnées différemment :
    (a) Rosen GRE (RFC 6037, plus ancien, plus simple) : arbre
        Default-MDT construit par PIM dans le VRF provider lui-même,
        données client encapsulées en GRE dans ce tunnel — RÉUTILISE
        directement le moteur GRE déjà réel (Couche 0), une fois
        seulement reconnecté au CLI Cisco/Huawei et à
        `Router.forwardPacket()` (déjà une dette connue, §14.5) ;
    (b) BGP-MVPN (RFC 6513/6514, plus moderne, plus lourd) : dépend en
        plus de MPLS P2MP/mLDP — une cinquième technologie absente et non
        listée ici comme prérequis obligatoire, cf. §2.2.
   │
   ▼
Couche 5 — LE SUJET DEMANDÉ, la plus petite marche une fois 1-4 livrées
  • PIM Snooping appliqué au segment PE-CE d'un VRF, ou au groupe
    Default-MDT du cœur provider — réutilise directement l'architecture
    déjà conçue dans docs/PRD-PIM-Snooping.md (PimSnoopingAgent), avec
    une portée scopée par VRF plutôt qu'un unique VLAN global.
```

**Conséquence directe** : ce document ne propose pas de plan
d'implémentation pour les couches 1 à 4 — chacune mérite son propre PRD,
avec sa propre analyse de l'existant, ses propres phases, sa propre
stratégie de test, au même niveau de rigueur que `docs/PRD-STP.md` ou
`docs/PRD-PIM.md`. Ce document se limite à les identifier, à les
dimensionner relativement les unes aux autres et à la Couche 5 (le sujet
initialement demandé), et à recommander un ordre.

---

## 1. Analyse de l'existant, couche par couche

| Couche | État réel confirmé | Preuve |
|---|---|---|
| 0 — PIM/PIM Snooping/BGP/GRE | Réel (PIM/BGP/GRE) ou conçu (PIM Snooping) | `docs/PRD-PIM.md`, `docs/PRD-PIM-Snooping.md`, `src/network/bgp/*.ts` (994 lignes), `GreAgent.ts` |
| 1 — MPLS | **Absent**, recherche exhaustive (`find`/`grep` sur `mpls` dans tout `src/network` et dans `roadmap.md`/`GAP.md`) : zéro résultat | — |
| 2 — VRF | **Absent**, mais déjà tracké | `docs/roadmap.md:1203-1213` (§14.6, Priorité: Basse) |
| 3 — MP-BGP VPNv4 | **Absent**, mais l'item voisin (IPv6) déjà tracké | `docs/roadmap.md:1234` (§14.8, « BGP4+ (MP-BGP pour IPv6) », Priorité: Basse) — confirmé par lecture de `src/network/bgp/types.ts` : aucune notion `afi`/`safi`/`AddressFamily` n'existe, une seule famille de routes possible aujourd'hui |
| 4 — Profil mVPN | **Absent**, jamais mentionné | — |
| 5 — PIM Snooping mVPN | **Absent en tant que tel**, mais son architecture générique existe déjà | `docs/PRD-PIM-Snooping.md §3` (`PimSnoopingAgent`) |

Ce tableau est la seule « analyse de l'existant » possible pour ce sujet :
quatre couches sur cinq n'ont rigoureusement rien à analyser au niveau
code, seulement au niveau documentation de dette déjà actée ailleurs
(`roadmap.md`) ou totalement absente de toute trace écrite (MPLS, profil
mVPN).

---

## 2. Objectifs — une séquence de PRD futurs, pas des phases de celui-ci

### 2.1 Séquence recommandée

1. **PRD futur A — MPLS (commutation par label).** Le plus gros
   inconnu de la chaîne : aucune trace, nulle part, de ce que serait son
   périmètre. Comprendrait a minima : en-tête MPLS (label/EXP/S/TTL),
   LDP (distribution de labels), plan de données à commutation de labels
   sur `Router.forwardPacket()`, `show mpls forwarding-table`/`show mpls
   ldp neighbor`. Taille attendue : comparable à un moteur de routage
   dynamique déjà livré dans ce dépôt (OSPF ou BGP, tous deux plusieurs
   centaines à ~1000 lignes rien que pour le moteur, avant CLI).
2. **PRD futur B — VRF (Virtual Routing and Forwarding).** Peut
   commencer indépendamment du PRD A dans une version « VRF-Lite »
   (tables de routage multiples par équipement, étanchéité inter-VRF, sans
   MPLS) — un vrai Cisco supporte d'ailleurs le VRF-Lite sans cœur MPLS.
   Item déjà tracké (`docs/roadmap.md §14.6`), mais jamais chiffré en
   détail — ce PRD futur devrait le faire. Prérequis strict de la Couche 3
   (rien à importer/exporter par route-target sans VRF pour porter les
   routes).
3. **PRD futur C — MP-BGP généralisé + VPNv4/VPNv6 (RFC 4364/4760).**
   Dépend de B (VRF) livré. Généralise l'item déjà tracké pour IPv6
   (`docs/roadmap.md §14.8`) à l'ajout d'une notion d'AFI/SAFI dans
   `src/network/bgp/` — actuellement totalement absente (`types.ts` ne
   déclare ni `afi` ni `safi`) — puis, seulement une fois cette
   généralisation faite, y ajouter VPNv4/VPNv6 (route-distinguisher,
   route-target, import/export par VRF). Deux sous-chantiers distincts en
   pratique : (c1) l'abstraction AFI/SAFI elle-même, réutilisable pour
   IPv6 unicast ET VPNv4 ET la future SAFI multicast de la Couche 4b, et
   (c2) VPNv4/VPNv6 spécifiquement.
4. **PRD futur D — Profil mVPN.** Recommandation forte : privilégier
   **Rosen GRE (RFC 6037)** plutôt que BGP-MVPN — la Couche 0 fournit déjà
   un moteur GRE réel (`GreAgent.ts`), simplement déconnecté du CLI
   Cisco/Huawei et de `Router.forwardPacket()` (dette déjà actée,
   `docs/roadmap.md §14.5`). Ce PRD futur consisterait essentiellement à
   (a) finir la dette GRE déjà trackée, puis (b) faire tourner PIM (déjà
   réel, `docs/PRD-PIM.md`) *à l'intérieur* du VRF provider pour
   construire l'arbre Default-MDT, et (c) encapsuler le trafic multicast
   client dans ce tunnel GRE. Un choix BGP-MVPN à la place ajouterait une
   sixième dépendance (MPLS P2MP/mLDP) pour un bénéfice pédagogique
   marginal dans un simulateur — cf. non-objectif §2.2.
5. **Ce document (Couche 5) — PIM Snooping mVPN, la marche la plus
   petite.** Une fois A-D livrés, cette dernière couche consiste
   essentiellement à scoper `PimSnoopingAgent` (déjà conçu,
   `docs/PRD-PIM-Snooping.md §3`) par VRF au lieu d'un état global unique
   par VLAN, et à reconnaître le groupe Default-MDT/Data-MDT du VRF
   courant comme le « groupe » à snooper sur le segment provider — pas un
   nouveau moteur, une extension de portée d'un moteur déjà spécifié.

### 2.2 Non-objectifs (pour toute la chaîne, à ce stade)

- **BGP-MVPN (RFC 6513/6514) et MPLS P2MP/mLDP** — préférer Rosen GRE
  (§2.1, PRD futur D) qui réutilise un moteur déjà réel plutôt que
  d'ajouter une sixième technologie absente pour un mécanisme de transport
  alternatif ; à ne reconsidérer que si Rosen GRE s'avère lui-même
  insuffisant pour un besoin pédagogique précis, ce qui n'est pas
  démontré aujourd'hui.
- **mVPN Extranet, Inter-AS Option A/B/C pour le multicast** —
  raffinements avancés d'un mécanisme qui n'existe pas encore lui-même ;
  hors de propos tant que le PRD futur D n'est pas livré.
- **IPv6 mVPN (6VPE multicast)** — dépendrait en plus d'un VPNv6 complet ;
  même logique que ci-dessus, à ne considérer qu'après IPv4 mVPN.
- **Tout chiffrage détaillé des PRD futurs A à D** — volontairement hors
  de ce document ; chacun mérite sa propre relecture de code et son propre
  PRD au même niveau de rigueur que ceux déjà écrits dans cette série,
  pas un paragraphe de sous-section ici.

---

## 3. Ce que ce document recommande concrètement

- **Ne pas traiter ceci comme un seul chantier.** Si l'objectif final
  (PIM Snooping pour mVPN) est réellement souhaité, la bonne unité de
  travail est un PRD par couche (A, B, C, D), chacun évalué et priorisé
  indépendamment — certains (VRF-Lite, la partie B) ont une valeur
  pédagogique autonome même si la chaîne s'arrête là, sans jamais
  atteindre mVPN.
- **Réutiliser ce qui existe déjà avant d'ajouter de nouvelles
  technologies** : la dette GRE déjà trackée (§14.5) et l'item MP-BGP
  IPv6 déjà tracké (§14.8) sont les deux points d'appui les plus solides
  pour aborder respectivement les Couches 4 et 3 — les traiter comme des
  extensions de dette existante plutôt que comme du travail entièrement
  neuf.
- **MPLS (Couche 1) est le véritable inconnu** de toute la chaîne — le
  seul élément sans aucune trace de dimensionnement nulle part dans ce
  dépôt. Toute décision de lancer ce chantier devrait commencer par un
  PRD dédié à MPLS seul, avant même de mentionner mVPN.

---

## 4. Risques

- **Risque de sous-estimation** : ce document lui-même ne chiffre pas
  précisément les couches 1 à 4 — le risque le plus important de toute
  cette feuille de route est qu'elle soit lue comme « quatre petites
  étapes » alors que chacune est, par nature, un PRD à part entière,
  potentiellement plus gros que `docs/PRD-STP.md` (528 lignes) une fois
  sa propre analyse de l'existant écrite.
- **Risque d'abandon en cours de chaîne** : rien n'oblige à aller jusqu'à
  la Couche 5 — VRF seul (Couche 2) ou MP-BGP IPv6 seul (déjà tracké
  indépendamment de mVPN, `roadmap.md §14.8`) ont une valeur autonome et
  pourraient être livrés sans jamais atteindre l'objectif final demandé
  ici ; ce n'est pas un échec de la feuille de route, seulement une
  réalité à anticiper dans la priorisation.
- **Risque de dérive vers BGP-MVPN** par attrait de la fidélité au
  standard le plus récent, au lieu de Rosen GRE — cf. §2.2, ce choix
  doublerait quasiment la taille de la Couche 4 pour un gain pédagogique
  non démontré dans le contexte de ce simulateur.

---

## 5. Critères d'acceptation (de la chaîne complète, pas de ce document)

Ce document n'a pas de critère d'acceptation propre — il n'implémente
rien. Le critère d'acceptation de **l'objectif final** (une fois les PRD
futurs A à D livrés et ce PRD Couche 5 lui-même écrit et livré à son
tour) serait : deux sites clients connectés à deux PE différents
partageant un cœur MPLS/VRF/MP-BGP-VPNv4, un flux multicast source sur un
site atteignant le récepteur sur l'autre via un arbre Default-MDT Rosen
GRE construit par PIM dans le VRF provider, et un switch du cœur provider
qui restreint correctement ce trafic aux seuls ports intéressés via PIM
Snooping scopé par VRF — sans jamais flooder sur des ports d'autres VRF
ni d'autres clients.
