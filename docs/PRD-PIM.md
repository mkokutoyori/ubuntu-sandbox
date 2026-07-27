# PRD — PIM (Protocol Independent Multicast, sparse-mode)

## 0. Contexte et portée

PIM est le protocole de routage multicast qui construit l'arbre de
distribution entre les routeurs qui portent un intérêt IGMP en aval
(`docs/PRD-IGMP.md`) et la source d'un flux. Ce PRD couvre
`src/network/pim/` (le moteur) et son exposition CLI
(`src/network/devices/shells/cisco/CiscoPimCommands.ts`), ainsi que le
point de contact avec le forwarding L3 (`Router.forwardMulticast()`).

**Le périmètre de ce que ce moteur modélise a déjà été explicitement et
précisément arbitré** — pas par ce PRD, mais par le commentaire
d'architecture déjà présent dans `CLAUDE.md` (section « Protocol
engines ») : *« Deliberately not attempted (out of scope for this pass):
RP-tree/SPT-switchover, register-tunnels, the Assert mechanism, and SSM —
only (*,G) sparse-mode-shaped join state (already all `PimAgent` modeled)
is used ; a group with no RP configured and no PIM neighbor still gets
pure last-hop-router OIL replication, which is a reasonable minimal slice
but not full PIM-SM. »* Cette relecture confirme que ce constat est
toujours exact aujourd'hui, code en main (§1.3). Ce PRD **hérite ces
exclusions sans les rouvrir** (cf. §2.2) et documente ce qui reste comme
gap réel *à l'intérieur* de ce périmètre déjà tranché, plus une opportunité
bornée qui n'est couverte par aucune des exclusions ci-dessus (BSR, §2.1
P1).

### 0.1 Chaîne de dépendances

- **`docs/PRD-IGMP.md`** est la dépendance amont directe : le point de
  contact `igmp.group.joined`/`igmp.group.left` → `pimAgent.joinGroup`/
  `leaveGroup` (`CiscoRouter.ts:167-173`, `HuaweiRouter.ts:106-111`) est
  déjà réel et fonctionnel — ce PRD ne le remet pas en cause. En
  revanche, `docs/PRD-IGMP.md §1.3 item 1` documente qu'aucun hôte final
  ne peut aujourd'hui rejoindre un groupe autrement que par un
  raccourci de test (`injectReport`) — tant que cette phase (P1 de
  `docs/PRD-IGMP.md`) n'est pas livrée, aucun scénario PIM de bout en bout
  (hôte réel → IGMP → PIM → réplication) n'est démontrable, seulement les
  briques PIM elle-mêmes (Hello/DR/Join-Prune/RPF), déjà bien couvertes par
  les tests existants (§1.1). Dépendance réelle, non bloquante pour ce PRD.
- **SSM (Source-Specific Multicast)** dépendrait d'IGMPv3, lui-même déjà
  exclu et auto-documenté dans le code (`docs/PRD-IGMP.md §0.1`,
  `CiscoIgmpCommands.ts:32`). Cette double dépendance renforce que SSM
  reste hors périmètre ici (cf. §2.2), cohérent des deux côtés.
- Aucune dépendance vers STP/VTP/VLAN au-delà de ce qui est déjà consommé
  (interfaces/ports, déjà livrés ailleurs).

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/network/pim/types.ts` (152 lignes) | Types : `PimMode` (`sparse`/`dense`/`sparse-dense` — accepté mais non différencié en comportement, §1.3 item 1), `PimMroutEntry` avec `entryType: PimMroutEntryType = 'star-g'` — **la seule valeur possible du type est `'star-g'`**, aucune notion de `(S,G)` n'existe dans le système de types, `PimRpEntry.isStatic` (toujours vrai en pratique, §1.3 item 3), `compareDrCandidate` (élection DR par priorité puis IP la plus haute) |
| `src/network/pim/PimAgent.ts` (616 lignes) | Moteur réactif complet : Hello périodique avec options (holdtime/dr-priority/generation-id/lan-prune-delay), élection DR réelle, RP statique avec résolution par plus long préfixe (`resolveRpForGroup`), sélection du voisin amont vers le RP (`findUpstreamForRp`, plus long préfixe puis tout voisin PIM actif en repli), Join/Prune (*,G) réel avec rafraîchissement périodique et expiration, gestion link-up/link-down |
| `src/network/devices/Router.ts:1874-1910` | `forwardMulticast()` — réplication de données réelle : vérif RPF (`mroute.incomingInterface`, repli sur la table de routage unicast pour la source), décrément TTL, un objet paquet distinct par OIF |
| `src/network/devices/shells/cisco/CiscoPimCommands.ts` (170 lignes) | `ip pim {sparse,dense,sparse-dense}-mode`, `dr-priority`, `query-interval`, `rp-address`, `spt-threshold` (no-op, §1.3 item 2), `join-prune-interval`, `show ip pim neighbor/interface/rp mapping`, `show ip mroute` — **Cisco uniquement**, aucun équivalent VRP (§1.3 item 3) |
| `src/network/devices/CiscoRouter.ts:165-173`, `HuaweiRouter.ts:104-111` | Câblage `PimAgent`, pont IGMP→PIM identique sur les deux vendeurs |
| 3 fichiers de tests (633 lignes) | `pim-protocol.test.ts` (231 l.), `pim-join-prune.test.ts` (219 l.), `pim-multicast-forwarding.test.ts` (183 l.) |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Hello et élection DR conformes** : options Hello réelles (holdtime,
  dr-priority, generation-id), détection de redémarrage voisin par
  changement de generation-id, élection DR par priorité puis IP la plus
  haute (`compareDrCandidate`), recalcul sur ajout/perte de voisin et sur
  link-down.
- **RP statique avec résolution par plage** : `resolveRpForGroup` choisit
  le RP dont la plage de groupe a le masque le plus spécifique — comportement
  correct pour plusieurs `ip pim rp-address` avec des plages différentes.
- **Join/Prune (*,G) réel de bout en bout** : sélection du voisin amont vers
  le RP par plus long préfixe sur l'adresse du RP, émission de Join
  périodique avec rafraîchissement avant expiration, Prune explicite quand
  la dernière interface sortante disparaît, traitement symétrique côté
  récepteur du Join/Prune (`onJoinPrune`).
- **Réplication de données avec vérification RPF réelle** dans
  `Router.forwardMulticast()` — pas un flood aveugle : un paquet arrivant
  sur une interface différente de l'interface RPF attendue est rejeté et
  journalisé (`router:mcast-rpf-fail`), TTL décrémenté, un objet paquet
  propre par interface sortante (évite le partage d'objet déjà documenté
  comme piège ailleurs dans ce moteur, cf. `CLAUDE.md` note sur `Cable`/
  `Router.forwardMulticast`).
- **Pont IGMP→PIM vendor-neutre déjà réel** (§0.1), identique sur Cisco et
  Huawei.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`PimMode` est cosmétique — le mode dense ne fait jamais de flood-and-prune.** `ip pim dense-mode`/`sparse-dense-mode` sont acceptées et stockées (`PimInterfaceRuntime.mode`), affichées telles quelles par `show ip pim interface`/`show ip mroute` (`.../Sparse-Dense` dans le flag OIF), mais **aucune branche de `PimAgent` ne teste jamais `rt.mode`** (recherche exhaustive du fichier) — chaque interface se comporte en Join explicite façon sparse quel que soit le mode configuré. Cohérent avec la note `CLAUDE.md` (« only (*,G) sparse-mode-shaped join state is used »), mais la CLI ne le dit nulle part — `dense-mode` n'émet aucun avertissement contrairement à la convention de disclosure déjà appliquée ailleurs dans ce dépôt (ex. badge « Limited simulation » des pare-feux, message explicite d'`ip igmp version 3`). | PIM-DM réel (flood initial puis prune) vs. l'affichage qui suggère une différence de comportement | Moyenne |
| 2 | **Aucun mécanisme de découverte dynamique du RP (BSR).** `PimRpEntry.isStatic` n'est jamais autre chose que `true` en pratique — seul `addStaticRp()` crée des entrées. `show ip pim rp mapping` anticipe pourtant déjà une seconde source (`Info source: ${rp.isStatic ? 'static' : 'bootstrap'}`, `CiscoPimCommands.ts`) dont la branche `'bootstrap'` est aujourd'hui **du code mort** — rien ne peut jamais produire une entrée non statique. Sur un réseau PIM-SM réel, configurer le RP à la main sur chaque routeur (comme c'est le seul chemin possible ici) est minoritaire ; le Bootstrap Router (RFC 5059/2362) est le mécanisme standard de distribution dynamique de l'ensemble RP-vers-groupes. Distinct des exclusions déjà actées en §0 (BSR ne touche ni SPT-switchover, ni Register, ni Assert, ni SSM — c'est uniquement *comment les routeurs apprennent l'adresse du RP*, orthogonal aux quatre exclusions déjà tranchées). | RFC 5059 (Bootstrap Router) | Élevée (seul mécanisme de distribution RP manquant, le reste du chemin (*,G) est déjà réel) |
| 3 | **La CLI PIM est Cisco-only.** `HuaweiRouter.ts` câble `PimAgent` de façon strictement identique à `CiscoRouter.ts` (même pont IGMP→PIM, même `forwardMulticast` hérité de `Router.ts`), mais **aucun fichier `HuaweiVRPShell.ts`/`Huawei*Commands.ts` n'enregistre la moindre commande `pim`** (recherche exhaustive, zéro résultat) — le moteur fonctionne, mais est invisible/inconfigurable depuis un terminal VRP. Même schéma que l'asymétrie déjà documentée pour IGMP (`docs/PRD-IGMP.md §1.3 item 6`). | Parité Cisco/Huawei déjà appliquée à d'autres protocoles de ce dépôt | Moyenne |
| 4 | **`ip pim spt-threshold` est un no-op silencieux** (`CiscoPimCommands.ts` : `trie.registerGreedy('ip pim spt-threshold', …, () => '')`) — cohérent avec l'exclusion déjà actée du SPT-switchover (§0), un vrai IOS ne produit d'ailleurs aucune sortie non plus pour cette commande ; mentionné ici seulement comme preuve corroborante que l'exclusion est appliquée jusqu'au niveau CLI, pas comme un gap distinct. | — (confirme une exclusion déjà actée, pas un nouveau gap) | (positif, aucune action) |

---

## 2. Objectifs

### 2.1 Objectifs (priorité décroissante)

- **P1 — Bootstrap Router (BSR), découverte dynamique du RP (item 2).**
  Élection de BSR par priorité puis IP la plus haute (même schéma que
  l'élection DR déjà réelle, `compareDrCandidate`, réutilisable), diffusion
  de messages Bootstrap portant l'ensemble RP-vers-groupes appris depuis
  des Candidate-RP-Advertisement, et résolution effective de
  `resolveRpForGroup` à partir de cette table dynamique en plus de (ou à la
  place de) la table statique existante — les deux sources doivent pouvoir
  coexister (RP statique prioritaire sur une plage plus spécifique, comme
  un vrai Cisco). `show ip pim rp mapping` peut alors réellement afficher
  `Info source: bootstrap` pour une entrée apprise dynamiquement — la
  branche aujourd'hui morte devient atteignable.
- **P2 — Disclosure honnête du mode dense (item 1).** Que le mode dense
  reste non modélisé ou soit implémenté un jour, la CLI doit d'abord dire
  la vérité : `ip pim dense-mode`/`sparse-dense-mode` avertit (dans
  `show ip pim interface` ou au moment de la commande) que le comportement
  effectif reste celui du mode sparse (join explicite), sur le même modèle
  que la note déjà affichée par `show ip igmp interface` pour IGMPv3
  (`docs/PRD-IGMP.md`). Un flood-and-prune réel resterait un chantier
  nettement plus vaste (comparable en ampleur aux exclusions déjà actées en
  §0) — non proposé comme objectif de ce PRD, seulement la disclosure.
- **P3 — Parité CLI Huawei (item 3).** Nouveau fichier
  `HuaweiPimCommands.ts` sur le modèle de `CiscoPimCommands.ts` : `pim sm`/
  `pim dm`/`pim sparse-dense` (vue interface), `dr-priority`,
  `timer hello`, `static-rp` (vue système), `display pim neighbor`,
  `display pim interface`, `display pim rp-info`, `display multicast
  routing-table` (VRP) — mêmes accesseurs `getPimAgent()`, déjà présents
  sur `Router`.

### 2.2 Non-objectifs (hérités, non rouverts)

- **RP-tree/SPT-switchover, register-tunnels, mécanisme Assert, SSM** —
  déjà explicitement exclus par `CLAUDE.md` (cité en §0) ; confirmés
  toujours exacts par cette relecture (§1.3). Ce PRD ne les rouvre pas.
- **Auto-RP** (mécanisme propriétaire Cisco alternatif au BSR, antérieur à
  lui) — P1 cible spécifiquement BSR (mécanisme standard IETF, RFC 5059),
  pas Auto-RP ; même logique de choix que d'autres PRD de ce dépôt qui
  retiennent le mécanisme normalisé plutôt que l'alternative propriétaire
  quand les deux existent côté monde réel.
- **Flood-and-prune réel pour le mode dense** — P2 ne propose que la
  disclosure, pas l'implémentation ; cf. raisonnement en §2.1 P2.
- **IGMPv3/SSM côté récepteur** — hors périmètre, déjà tranché par
  `docs/PRD-IGMP.md §2.2`.
- **Client IGMP hôte réel** — dépendance amont documentée en §0.1, propriété
  de `docs/PRD-IGMP.md` (son P1), pas de celui-ci.

---

## 3. Architecture cible

**P1 (BSR).** Réutilise le schéma déjà en place pour l'élection DR :
`PimConfig` gagne `bsrCandidate: { priority: number; address: string } |
null` et `learnedRps: PimRpEntry[]` (distinct de `rps` statique, fusionnés
en lecture par `resolveRpForGroup` avec priorité au plus spécifique puis au
statique en cas d'égalité de masque — cohérent avec un vrai Cisco/VRP).
Deux nouveaux types de message dans `PimMessageType`
(`'bootstrap'`/`'candidate-rp-advertisement'`), transmis en multicast sur
`PIM_ALL_ROUTERS` comme Hello/Join-Prune aujourd'hui — pas de nouveau
mécanisme de transport à inventer.

**P2 (disclosure dense).** Une ligne supplémentaire dans `show ip pim
interface` quand `rt.mode !== 'sparse'`, sur le modèle exact de la note
déjà affichée par `registerIgmpShowCommands` (`docs/PRD-IGMP.md §1.1`).

**P3 (parité Huawei).** Fichier miroir, aucun changement au moteur
`PimAgent` lui-même — uniquement du câblage CLI, comme P6 de
`docs/PRD-IGMP.md`.

---

## 4. Modèle de données

```ts
// pim/types.ts — BSR (P1)
export type PimMessageType = 'hello' | 'join-prune' | 'bootstrap' | 'candidate-rp-advertisement';

export interface PimBsrCandidate {
  address: string;
  priority: number;
}

export interface PimConfig {
  // … champs existants inchangés …
  bsrCandidate: PimBsrCandidate | null;
  currentBsr: PimBsrCandidate | null;
  learnedRps: PimRpEntry[]; // isStatic: false pour toutes ces entrées
}
```

---

## 5. Plan de mise en œuvre

1. **P2** (disclosure dense) — le plus isolé, une ligne d'affichage, aucun
   changement de moteur.
2. **P3** (parité CLI Huawei) — nouveau fichier, câblage seul, aucun
   changement au moteur partagé.
3. **P1** (BSR) — le plus structurant, touche `PimConfig`/`resolveRpForGroup`
   et ajoute deux types de message ; à faire en dernier pour bénéficier
   d'une base CLI (Cisco+Huawei) déjà stable pour écrire les tests
   d'acceptation sur les deux vendeurs dès le départ.

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète des 3 fichiers de tests PIM existants (633 lignes) avant de passer
à la suivante.

---

## 6. Stratégie de test

- **Non-régression obligatoire** : `pim-protocol.test.ts`,
  `pim-join-prune.test.ts`, `pim-multicast-forwarding.test.ts` (633 lignes),
  plus toute suite IGMP qui exerce indirectement le pont vers PIM.
- **Nouveaux fichiers** :
  - `pim-bsr-election.test.ts` (P1) : deux candidats BSR, priorité puis IP
    départagent, le perdant relaie le Bootstrap du gagnant.
  - `pim-bsr-rp-learning.test.ts` (P1) : un Candidate-RP-Advertisement
    propagé par le BSR aboutit à une entrée `learnedRps` consultée par
    `resolveRpForGroup`, visible dans `show ip pim rp mapping` avec
    `Info source: bootstrap`.
  - `pim-dense-mode-disclosure.test.ts` (P2) : `ip pim dense-mode` suivi de
    `show ip pim interface` affiche l'avertissement ; le comportement de
    join reste identique au mode sparse (non-régression explicite).
  - `huawei-pim-cli-parity.test.ts` (P3) : `pim sm`/`display pim neighbor`/
    `display multicast routing-table` côté VRP, mêmes assertions
    fonctionnelles que leurs équivalents Cisco déjà testés.

---

## 7. Risques et points d'attention

- **Ne pas confondre P1 (BSR) avec les exclusions de §2.2** : BSR ne
  touche ni Register, ni Assert, ni SPT-switchover, ni SSM — seulement la
  distribution de l'adresse du RP. Vérifier en conception détaillée que
  l'implémentation ne dérive pas vers ces mécanismes adjacents par
  contamination de périmètre.
- **P1 doit préserver la priorité du RP statique sur une plage plus
  spécifique** — un vrai Cisco privilégie toujours la plage la plus
  spécifique indépendamment de la source (statique ou BSR) ; à égalité de
  masque, le statique gagne. Tester explicitement ce cas de non-régression.
- **P2 ne doit pas être confondu avec une implémentation réelle du mode
  dense** — c'est de la disclosure seule ; un futur PRD distinct serait
  nécessaire pour un vrai flood-and-prune, à ne pas entamer par
  glissement de périmètre pendant P2.
- **Cohérence avec `docs/PRD-IGMP.md`** : ce PRD partage sa dépendance
  amont (§0.1) — tout changement dans `docs/PRD-IGMP.md` P1 (client IGMP
  hôte réel) mérite une relecture de ce document pour vérifier que le
  scénario de bout en bout décrit reste cohérent.

---

## 8. Critères d'acceptation

- Deux candidats BSR élisent correctement le gagnant par priorité puis IP,
  et le RP appris dynamiquement est consultable via `show ip pim rp
  mapping` avec la bonne source (`static` vs `bootstrap`).
- Une plage RP statique plus spécifique l'emporte toujours sur une entrée
  apprise par BSR pour le même groupe.
- `ip pim dense-mode` déclenche une note explicite indiquant que le
  comportement reste celui du mode sparse.
- Les commandes PIM (interface, RP, neighbor/interface/rp-info/mroute)
  fonctionnent de façon équivalente sur Cisco et sur Huawei.
- Les 3 suites de tests existantes (633 lignes) passent toujours sans
  modification de leurs assertions à l'issue de toutes les phases.
