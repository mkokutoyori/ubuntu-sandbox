# PRD — PIM Snooping (restriction L2 du trafic multicast signalé par PIM)

## 0. Contexte et portée

Le PIM Snooping est le pendant, côté switch, de l'IGMP Snooping
(`docs/PRD-IGMP.md`) : au lieu de restreindre le flood multicast aux ports
où un **hôte** a signalé un intérêt par IGMP, il le restreint aux ports où
un **routeur voisin PIM** a signalé un intérêt par un message Hello ou
Join/Prune traversant le switch — le cas typique étant un segment L2 entre
plusieurs routeurs PIM (ou entre un routeur et un récepteur qui est
lui-même un routeur, comme dans un cœur de réseau mVPN), où l'IGMP
Snooping seul ne voit jamais l'intérêt exprimé (un routeur ne parle pas
IGMP à un autre routeur).

**Ce PRD est un chantier entièrement neuf** — confirmé par recherche
exhaustive : aucun fichier `pim-snooping`, aucune commande CLI, aucun test
n'existe nulle part dans ce dépôt. Mais l'examen du code existant pour
préparer ce document a mis au jour **un bug concret et sévère dans le
moteur IGMP Snooping déjà livré** (`src/network/igmp-snooping/`),
directement pertinent ici puisqu'il touche exactement le type de trafic
(Hello/Join-Prune multicast lien-local) que le PIM Snooping doit lui aussi
traiter correctement — cf. §1.3 item 1, à corriger en premier (P1) avant
d'écrire le nouveau moteur.

### 0.1 Chaîne de dépendances

- **`docs/PRD-IGMP.md`** fournit l'architecture de référence à reproduire
  (`IgmpSnoopingAgent`, déjà mature — 246 lignes, testé sur 330 lignes) et
  révèle, par effet de bord de cette relecture, le bug de §1.3 item 1 qui
  affecte le même point d'entrée partagé (`Switch.
  resolveSnoopedMulticastEgressPorts`) que ce PRD devra étendre.
- **`docs/PRD-PIM.md`** fournit les types de paquets à observer (`PimPacket`,
  `PimJoinPruneBody`, `PimHelloOption`, `src/network/pim/types.ts`) et
  documente déjà, à l'échelle du moteur routeur, l'absence de BSR/Assert/
  SPT-switchover — ce PRD hérite les mêmes limites côté snooping (§2.2),
  sans les rouvrir.
- **`docs/PRD-VLAN.md`/`docs/PRD-802.1Q.md`** fournissent
  `resolveIngressVlan`/`isTrunkPort`, déjà consommés par `IgmpSnoopingAgent`
  et réutilisables tels quels.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/network/igmp-snooping/IgmpSnoopingAgent.ts` (246 lignes) | Moteur de référence à reproduire pour la structure (détection de port routeur, suivi de membres par port/VLAN, expiration, `immediate-leave`) — **aucun équivalent PIM n'existe** |
| `src/network/devices/Switch.ts:1891-1908` | `resolveSnoopedMulticastEgressPorts()` — point d'entrée **partagé** entre IGMP et (futur) PIM snooping pour restreindre le flood d'une trame multicast ; contient le bug de §1.3 item 1 |
| `src/network/devices/Router.ts` | Contre-exemple correct : le commentaire d'architecture (`CLAUDE.md`) confirme que le chemin de réception L3 du routeur restreint bien le « toujours local, jamais transmis » au seul 224.0.0.0/24 (RFC 1112/4541) — **exactement la distinction qui manque côté switch** (§1.3 item 1) |
| `src/network/pim/types.ts` | `PimPacket`/`PimJoinPruneBody`/`PimHelloOption` — formats déjà réels côté routeur (`docs/PRD-PIM.md`), à parser côté switch sans les redéfinir |
| — | Aucun fichier `pim-snooping`, aucune commande `ip pim snooping`/`pim-snooping enable`, aucun test — confirmé par recherche exhaustive |

### 1.2 Ce qui existe déjà et peut être réutilisé tel quel

- La structure entière d'`IgmpSnoopingAgent` (détection de port routeur par
  observation passive, suivi de membres avec expiration par timer,
  `immediate-leave`, gestion du link-down) est directement transposable :
  PIM Hello joue le rôle de la Query IGMP (détection de port routeur), et
  PIM Join/Prune joue le rôle du Membership Report/Leave IGMP (suivi
  d'intérêt par groupe).
- Le point d'entrée `Switch.resolveSnoopedMulticastEgressPorts()` /
  `getIgmpSnoopingAgentOrNull()` (à généraliser en un hook vendor-neutre
  équivalent pour PIM) est déjà le bon endroit architectural pour brancher
  un second moteur de snooping sans dupliquer le chemin de décision de
  flood.
- Les types PIM (`PimPacket` et sous-types) sont déjà réels côté routeur —
  aucune redéfinition de format de trame n'est nécessaire, seulement leur
  lecture passive côté switch.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Le multicast lien-local réservé (224.0.0.0/24) n'est pas exempté du filtrage IGMP-snooping, alors que le code lui-même cite la règle qui l'exige.** `Switch.resolveSnoopedMulticastEgressPorts()` (`Switch.ts:1891-1903`) ne teste que `firstOctet < 224 \|\| firstOctet > 239` avant d'interroger `computeEgressPorts()` — **aucune exception pour 224.0.0.0/24**, alors que le commentaire de la méthode juste au-dessus (`Switch.ts:1885`) cite explicitement « RFC 4541 §2.1.2 ». Cette RFC impose pourtant que tout paquet à destination de 224.0.0.0/24 (Hello OSPF 224.0.0.5, RIPv2 224.0.0.9, EIGRP 224.0.0.10, PIM Hello 224.0.0.13, VRRP 224.0.0.18/224.0.0.112, HSRPv2 224.0.0.102, IGMP lui-même 224.0.0.1/224.0.0.2…) soit **toujours** transmis sur tous les ports, jamais restreint. Aujourd'hui, `computeEgressPorts()` reçoit ces adresses comme n'importe quel groupe ordinaire ; comme `IgmpSnoopingAgent.onReport()` ignore volontairement ces adresses réservées (`isReservedMulticast`), aucune entrée de groupe n'existe jamais pour elles — la trame n'est donc floodée normalement **que par accident**, tant qu'aucun port routeur IGMP n'a encore été appris ailleurs sur le même VLAN pour un tout autre groupe. Dès qu'un port routeur IGMP existe (une activité IGMP totalement indépendante, sur un groupe sans rapport), l'ensemble de sortie calculé se restreint à ces seuls ports routeur IGMP — un Hello PIM/OSPF/VRRP à destination d'un voisin sur un port qui n'a jamais parlé IGMP peut alors être silencieusement filtré, sans erreur, sans message distinct, et sans qu'aucun test existant ne couvre cette combinaison (recherche dans `igmp-snooping.test.ts` : aucun scénario ne mélange une activité IGMP sur un groupe avec un Hello d'un autre protocole sur le même VLAN). Le routeur, lui, applique déjà correctement cette distinction 224.0.0.0/24 dans son propre chemin de réception L3 — l'oubli est localisé au switch. | RFC 4541 §2.1.2 (déjà cité dans le code lui-même) | Élevée (peut casser silencieusement une adjacence PIM/OSPF/VRRP/HSRP à travers un switch dès qu'IGMP Snooping devient actif ailleurs sur le même VLAN) |
| 2 | **Aucun moteur de PIM Snooping n'existe.** Un switch entre deux routeurs PIM (ou entre un routeur et un récepteur qui est lui-même un routeur PIM plutôt qu'un hôte IGMP) ne peut aujourd'hui que flooder tout le trafic multicast au-delà de 224.0.0.0/24 sur tout le VLAN — aucun mécanisme n'apprend « ce port a un voisin PIM qui a Join le groupe G » de la même façon qu'`IgmpSnoopingAgent` apprend « ce port a un hôte qui a rapporté le groupe G ». | Fonctionnalité Cisco/Huawei réelle (`ip pim snooping`/`pim-snooping enable`) | Élevée (fonctionnalité entièrement absente) |
| 3 | **Aucune commande CLI** — trivialement vrai puisqu'aucun moteur n'existe ; mentionné pour mémoire, résolu de facto par la livraison de l'objectif P4. | — | (conséquence du gap précédent) |

---

## 2. Objectifs

### 2.1 Objectifs (priorité décroissante)

- **P1 — Corriger l'exemption 224.0.0.0/24 dans le filtrage multicast du
  switch (item 1, prioritaire — corrige un bug existant avant d'écrire du
  code neuf dessus).** `resolveSnoopedMulticastEgressPorts()` doit
  retourner `null` (flood normal, aucune restriction) **immédiatement**
  pour toute adresse dans 224.0.0.0/24, avant même de consulter
  `IgmpSnoopingAgent` — exactement la même distinction que
  `Router.ts` applique déjà correctement côté L3. Cette correction est un
  prérequis logique à P2 : le nouveau moteur PIM Snooping ne doit jamais
  hériter du même biais pour les Hello PIM (224.0.0.13) qu'il gère
  lui-même en interne.
- **P2 — Moteur `PimSnoopingAgent` (item 2).** Nouveau répertoire
  `src/network/pim-snooping/` (types.ts/PimSnoopingAgent.ts/events.ts,
  même structure que `igmp-snooping/`) : apprentissage de port routeur par
  observation passive d'un Hello PIM (rôle de la Query IGMP), suivi
  d'intérêt par groupe via observation d'un Join/Prune PIM traversant le
  switch (rôle du Membership Report/Leave IGMP), expiration par timer sur
  le même modèle que l'existant IGMP (`groupMembershipSec`/
  `routerPortAgeSec`).
- **P3 — Union avec l'IGMP Snooping au point de décision de flood.**
  `Switch.resolveSnoopedMulticastEgressPorts()` consulte les deux moteurs
  quand les deux sont actifs sur le VLAN et flood vers l'union de leurs
  ports appris pour le groupe — un port avec un récepteur IGMP et un port
  avec un voisin PIM intéressé au même groupe reçoivent tous deux le flux,
  ni l'un ni l'autre n'étant exclu par la présence du second mécanisme.
- **P4 — CLI Cisco et Huawei dès la livraison (item 3).** `ip pim snooping`
  (global) / `ip pim snooping vlan <n>` côté Cisco, `pim-snooping enable`
  (vue VLAN) côté Huawei, plus `show ip pim snooping`/`display
  pim-snooping` — les deux vendeurs construits ensemble dès le départ,
  contrairement à l'asymétrie déjà rencontrée pour IGMP et PIM eux-mêmes
  (`docs/PRD-IGMP.md §1.3 item 6`, `docs/PRD-PIM.md §1.3 item 3`) — ici il
  n'y a pas de dette historique à rattraper, juste à ne pas en créer une
  nouvelle.

### 2.2 Non-objectifs (explicitement exclus)

- **Snooping des messages BSR/Candidate-RP-Advertisement** — hérité de
  `docs/PRD-PIM.md §2.2` (BSR lui-même n'existe pas encore côté routeur,
  proposé comme son propre objectif futur) ; P2 doit seulement s'assurer
  de ne pas mal interpréter un futur paquet BSR comme un Hello/Join-Prune,
  sans chercher à le snooper activement dès maintenant.
- **Snooping spécifique mVPN (Default-MDT/Data-MDT)** — extension réelle
  mais de niche du PIM Snooping utilisée dans les cœurs de réseau
  multicast-VPN de fournisseur ; ce simulateur ne modélise aucun MPLS
  L3VPN multicast, donc cette extension n'a pas de terrain où exister.
- **Assert-aware snooping / snooping du mode dense** — hérité de
  `docs/PRD-PIM.md §2.2` (Assert et le flood-and-prune du mode dense sont
  eux-mêmes hors périmètre côté routeur) ; pas de raison de les modéliser
  côté snooping avant qu'ils existent côté routeur.

---

## 3. Architecture cible

**P1.** Dans `resolveSnoopedMulticastEgressPorts()` (`Switch.ts:1891`),
ajouter en tout premier test : `if (firstOctet === 224 &&
ipPkt.destinationIP.getOctets()[1] === 0 && … [2] === 0) return null;` (ou
plus proprement, réutiliser une fonction `isReservedMulticast` déjà
existante côté `igmp/types.ts` plutôt que de redupliquer l'arithmétique
d'adresse) — avant toute consultation de `getIgmpSnoopingAgentOrNull()`.

**P2.** `PimSnoopingAgent` reprend la forme d'`IgmpSnoopingAgent` avec deux
différences de fond : (a) le rôle de « Query » est joué par un `PimPacket`
de type `hello` reçu sur un port — enregistré comme port routeur PIM ; (b)
le rôle de « Report/Leave » est joué par un `join-prune` observé — chaque
`PimJoinPruneGroup` avec `joinStarG: true` ajoute le port courant à
l'ensemble des ports intéressés pour ce groupe, `pruneStarG: true` le
retire. Interface `PimSnoopingHost` calquée sur `IgmpSnoopingHost`
(`resolveIngressVlan`/`isTrunkPort`).

**P3.** `Switch.resolveSnoopedMulticastEgressPorts()` calcule l'union des
ports retournés par `IgmpSnoopingAgent.computeEgressPorts()` et
`PimSnoopingAgent.computeEgressPorts()` (nouvelle méthode, même signature)
quand les deux existent sur la plateforme — pas de duplication de la
logique d'union déjà utilisée en interne par chacun des deux moteurs pour
membres+ports routeurs.

**P4.** Câblage CLI symétrique sur `CiscoSwitchShell.ts` et
`HuaweiSwitchShell.ts`, sur le modèle exact des blocs `ip igmp snooping`/
`igmp-snooping` déjà existants dans les deux fichiers.

---

## 4. Modèle de données

```ts
// pim-snooping/types.ts — calqué sur igmp-snooping/types.ts
export interface PimSnoopingMember {
  port: string;
  neighborIp: string;
  lastJoinMs: number;
}

export interface PimSnoopingGroup {
  vlan: number;
  groupAddress: string; // toujours (*,G) — cf. non-objectifs PRD-PIM.md
  members: Map<string, PimSnoopingMember>;
}

export interface PimSnoopingVlanState {
  vlan: number;
  enabled: boolean;
  routerPorts: Set<string>; // appris par Hello PIM, pas par Query IGMP
  groups: Map<string, PimSnoopingGroup>;
}

export interface PimSnoopingConfig {
  enabled: boolean;
  perVlanDefault: boolean;
  vlans: Map<number, PimSnoopingVlanState>;
  routerPortAgeSec: number;
  groupMembershipSec: number;
}
```

---

## 5. Plan de mise en œuvre

1. **P1** en premier — correctif isolé d'une ligne de garde, aucune
   nouvelle structure de données, bénéfice immédiat indépendant du reste
   du PRD.
2. **P2** — nouveau moteur, dimensionné sur le modèle d'`IgmpSnoopingAgent`
   (~250 lignes attendues par analogie).
3. **P3** — câblage de l'union dans `Switch.ts`, une fois P2 livré.
4. **P4** — CLI Cisco et Huawei en parallèle, une fois P2/P3 stables.

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète d'`igmp-snooping.test.ts` (330 lignes) en plus des nouveaux tests
de la phase.

---

## 6. Stratégie de test

- **Non-régression obligatoire** : `igmp-snooping.test.ts` (330 lignes) —
  P1 en particulier doit être vérifié contre cette suite avant tout autre
  changement, puisqu'il touche le chemin de décision de flood partagé.
- **Nouveaux fichiers** :
  - `switch-reserved-multicast-not-pruned.test.ts` (P1) : un switch avec
    IGMP Snooping actif et un port routeur appris pour un groupe ordinaire
    (239.1.1.1) reçoit ensuite un Hello PIM (224.0.0.13) sur un port qui
    n'a jamais parlé IGMP — vérifie qu'il est tout de même floodé sur tous
    les ports du VLAN, pas seulement vers le port routeur IGMP appris.
    Même test décliné pour OSPF (224.0.0.5) et VRRP (224.0.0.18) pour
    confirmer que le correctif n'est pas spécifique à PIM.
  - `pim-snooping-basic.test.ts` (P2) : un routeur PIM Join un groupe à
    travers un switch, vérifie que le port du routeur est appris et que le
    flood du groupe se restreint à ce port (plus le port routeur, s'il y
    en a un autre).
  - `pim-igmp-snooping-union.test.ts` (P3) : un récepteur IGMP et un
    voisin PIM intéressés au même groupe sur des ports différents du même
    switch, vérifie que les deux reçoivent le flux.
  - `pim-snooping-cli-parity.test.ts` (P4) : `ip pim snooping`/`display
    pim-snooping` équivalents sur Cisco et Huawei.

---

## 7. Risques et points d'attention

- **P1 touche un chemin de décision partagé par tout trafic multicast du
  switch** — vérifier explicitement la suite `igmp-snooping.test.ts`
  complète avant de considérer cette phase terminée, pas seulement le
  nouveau test dédié.
- **Ne pas dupliquer la logique d'union déjà présente dans
  `computeEgressPorts()`** — P3 doit composer les deux moteurs, pas
  réimplémenter leur logique interne de fusion membres+routeurs.
- **Ne pas dériver vers BSR/mVPN/Assert** (§2.2) au prétexte que P2 touche
  déjà le parsing des paquets PIM — rester strictement sur Hello/Join-Prune
  pour (*,G), cohérent avec le périmètre déjà tranché côté routeur.

---

## 8. Critères d'acceptation

- Un Hello PIM (ou OSPF/VRRP) à destination de 224.0.0.0/24 est toujours
  floodé sur tout le VLAN, même quand IGMP Snooping a déjà appris un port
  routeur pour un groupe sans rapport.
- Un routeur PIM qui Join un groupe à travers un switch fait apprendre son
  port comme intéressé pour ce groupe ; un Prune le retire.
- Un récepteur IGMP et un voisin PIM intéressés au même groupe sur des
  ports différents reçoivent tous deux le flux.
- Les commandes de configuration/affichage PIM Snooping fonctionnent de
  façon équivalente sur Cisco et Huawei dès leur livraison.
- `igmp-snooping.test.ts` (330 lignes) passe toujours sans modification de
  ses assertions à l'issue de toutes les phases.
