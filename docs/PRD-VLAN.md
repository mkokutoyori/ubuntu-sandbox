# PRD — VLANs (segmentation L2 : base de données, ports access/trunk, PVST+, SVI)

**Version** : 1.0
**Date** : 2026-07-07
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- IEEE 802.1Q-2018 (VLAN — segmentation, appartenance de port, filtrage)
- IEEE 802.1D-2004 (Spanning Tree) et le profil PVST+ propriétaire Cisco
  (une instance STP indépendante par VLAN) — moteur déjà existant, consommé
  et non redéfini par ce PRD (cf. §0.1)
- RFC 4541 (considérations IGMP snooping sur pont L2, pour les interactions
  VLAN/multicast, déjà couvertes par `IgmpSnoopingAgent`, hors périmètre)
- Documentation Cisco IOS *Private VLANs*, *VLAN ACL (VACL)*, *Voice VLAN*
  (comportements de référence pour le gap analysis §1.3)

---

## 0. Contexte et portée du document

Ce PRD documente **la segmentation L2 elle-même** : la base de données VLAN
par commutateur, l'appartenance de port (access/trunk, VLAN natif, liste des
VLAN autorisés sur un trunk), le filtrage de trame par VLAN dans le plan de
données (`Switch.handleFrame`/`floodFrame`/`forwardToPort`), l'instanciation
d'une spanning tree indépendante par VLAN (PVST+), et le routage inter-VLAN
(SVI et router-on-a-stick). Il **consomme** l'encapsulation 802.1Q décrite par
`docs/PRD-802.1Q.md` (le VID est porté par le tag défini là-bas) et **est
consommé par** `docs/PRD-VTP.md` (VTP synchronise la base VLAN décrite ici
entre commutateurs). Il ne redéfinit ni le format du tag, ni le protocole de
synchronisation de base VLAN entre switches, ni le moteur STP/PVST+
sous-jacent (déjà solide, cf. §0.1) — seule l'articulation VLAN↔STP (une
instance par VLAN) est documentée ici du point de vue de la segmentation.

Cette analyse est issue d'une lecture complète de `src/network/devices/Switch.ts`
(1297 lignes — base de données VLAN, `SwitchportConfig`, pipeline de trame),
`src/network/devices/SwitchSvi.ts` (543 lignes — routage inter-VLAN sur
switch L3), `src/network/devices/Router.ts` (router-on-a-stick),
`src/network/devices/GenericSwitch.ts`/`CiscoSwitch.ts`/`HuaweiSwitch.ts`
(spécialisations vendor), `src/network/stp/StpAgent.ts` et
`src/network/stp/StpVlanInstance.ts` (instanciation PVST+ par VLAN), les
shells `CiscoSwitchShell.ts`/`HuaweiSwitchShell.ts` (commandes `show
vlan`/`display vlan`, `switchport`/`port link-type`), et de `GAP.md` §2 (qui
documente une partie de ces mêmes constats, avec au moins un point
explicitement corrigé depuis — voir §1.3, item PVST+).

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-802.1Q.md (IEEE 802.1Q/802.1ad)
   │  fondation d'encodage : format du tag, TPID/TCI, Native VLAN, QinQ
   │
   ▼  trame taguée transportée sur les trunks, VID porté par le tag
PRD-VLAN.md (segmentation L2 : base VLAN, access/trunk, PVST+, SVI)  ◄── VOUS ÊTES ICI
   │  dépend de PRD-802.1Q.md pour l'encodage du VID sur le fil
   │  interagit avec le moteur STP existant (PVST+, déjà solide — GAP.md §2.1,
   │    non remis en cause par ce trio de PRD ; aucune dépendance bloquante,
   │    l'instanciation par VLAN existe déjà côté StpAgent)
   │
   ▼  base VLAN locale à synchroniser entre commutateurs d'un même domaine
PRD-VTP.md (synchronisation de la base VLAN entre commutateurs Cisco)
      dépend de PRD-VLAN.md pour la base VLAN à synchroniser (createVLAN/
      deleteVLAN/renameVLAN), et de PRD-802.1Q.md pour la condition
      d'émission (VTP ne circule que sur des ports trunk taggés)
```

Ce PRD a **une seule dépendance entrante non bloquante** : le format de tag
de `PRD-802.1Q.md` (déjà largement implémenté, cf. son §1.2 — aucune des
phases de ce PRD n'attend une phase spécifique de `PRD-802.1Q.md` pour
démarrer, sauf la Phase 4 ci-dessous qui bénéficie de la QinQ optionnelle de
`PRD-802.1Q.md` Phase 3 sans en dépendre strictement). Il n'y a pas de
dépendance vers TLS/QUIC — la segmentation VLAN est une fonction de commutation
L2, indépendante de tout protocole de transport ou de sécurité applicative.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel |
|---|---|
| `src/network/devices/Switch.ts` | Classe abstraite commune : base VLAN (`Map<number, VLANEntry>`), `SwitchportConfig` par port (mode, VLAN access, native/allowed trunk, voice VLAN), pipeline `handleFrame`/`floodFrame`/`forwardToPort`, intégration STP par VLAN (`getStpVlanState`/`setStpVlanState`), API SVI déléguée à `SwitchSvi` |
| `src/network/devices/SwitchSvi.ts` | Interfaces virtuelles `interface Vlan N` : IP, ARP pour l'IP de la SVI, relais DHCP (`ip helper-address`), routage IP inter-VLAN réel (décrément TTL, recalcul checksum, résolution ARP du next-hop), table de routage combinant connectées + statiques, driver `ping` interne |
| `src/network/devices/Router.ts` | Sous-interfaces `encapsulation dot1Q <vlan> [native]` — routage inter-VLAN « router-on-a-stick » |
| `src/network/devices/CiscoSwitch.ts` | Spécialisation : ports d'accès **suspendus** (pas migrés) quand leur VLAN est supprimé ; câble `VtpAgent` et `DtpAgent` |
| `src/network/devices/HuaweiSwitch.ts` | Spécialisation : ports migrés vers VLAN 1 quand leur VLAN est supprimé ; pas de VTP (cohérent — propriétaire Cisco) ; pas de DTP (cohérent — VRP n'a pas d'équivalent) |
| `src/network/devices/GenericSwitch.ts` | Spécialisation minimale (nommage de port, état STP initial) ; hérite de toute la logique VLAN/trunk de `Switch.ts` mais sans VTP/DTP |
| `src/network/stp/StpAgent.ts` + `StpVlanInstance.ts` | Une instance de spanning tree indépendante par VLAN (élection racine, rôles de port, **timers de transition réels** Listening/Learning) |
| `src/network/devices/shells/CiscoSwitchShell.ts` | `show vlan brief/id/name/summary`, `show interfaces trunk`, `switchport mode/access vlan/trunk native/trunk allowed vlan` (5 variantes), `switchport voice vlan`, `switchport mode dynamic auto/desirable` |
| `src/network/devices/shells/HuaweiSwitchShell.ts` | `display vlan [summary\|<id>]`, `display port vlan [active]`, `port link-type access/trunk/hybrid` (hybrid **stub sans plan de données**), `qinq` (stub, cf. `PRD-802.1Q.md`) |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Base VLAN complète** : `createVLAN`/`deleteVLAN`/`renameVLAN`, VLAN 1
  protégée contre la suppression, comportement de suppression différencié et
  réaliste par vendor (Cisco suspend le port ; Huawei/Generic migrent vers
  VLAN 1).
- **Switchport access/trunk complet** : mode, VLAN d'accès, native VLAN de
  trunk, et les **5 variantes** de `switchport trunk allowed vlan`
  (`add`/`remove`/`all`/`none`/`except`) — une implémentation exhaustive de la
  syntaxe IOS réelle, pas un sous-ensemble.
- **Pipeline de trame VLAN-aware réel** : détermination du VLAN d'ingress
  selon le mode de port (y compris filtrage `trunkAllowedVlans` sur trafic
  déjà tagué), apprentissage MAC par clé `"vlan:mac"` (donc les mêmes MAC dans
  des VLAN différents ne se confondent pas), flood strictement intra-VLAN,
  pose/dépose du tag au forward vers un port trunk/access.
- **PVST+ réellement instancié par VLAN** (contrairement à un constat
  aujourd'hui périmé de `GAP.md` §2.1) : `StpAgent.instanceFor(vlan)` crée à
  la volée une `StpVlanInstance` par VLAN rencontré, chacune avec sa propre
  élection de racine, ses propres rôles de port, et des **timers de
  transition Listening→Learning→Forwarding réellement temporisés** via le
  `Scheduler` (pas un raccourci instantané). Le blocage de port dans le plan
  de données (`floodFrame`/`forwardToPort`) est bien gaté par
  `stpVlanStates`, pas par un état STP global VLAN-unaware.
- **Bridge ID PVST+ conforme** : la priorité annoncée encode bien les 12 bits
  bas comme le VLAN ID (system-id-extension Cisco réel), pas un bug d'unité —
  déjà re-qualifié et couvert par un test de non-régression
  (`stp-show-live.test.ts`).
- **SVI et routage inter-VLAN L3 réel** : `SwitchSvi` n'est pas un simple flag
  d'affichage — ARP répondant pour l'IP de SVI, relais DHCP, forward IP
  complet entre VLAN avec recalcul de TTL/checksum et résolution ARP du
  next-hop, table de routage combinant connectées et statiques, `ping` piloté
  depuis le switch lui-même.
- **Router-on-a-stick fonctionnel** de bout en bout, y compris l'ARP gratuit
  correctement tagué envoyé via le port physique parent.
- **`show`/`display` déjà branchés sur l'état vivant** : `show vlan
  brief`/`show interfaces trunk` (Cisco), `display vlan`/`display port vlan`
  (Huawei) reflètent la vraie base VLAN, pas un gabarit statique.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Voice VLAN purement déclaratif, sur les deux vendors.** Le champ `voiceVlan?` existe sur `SwitchportConfig`, configurable/affichable en CLI Cisco, mais **jamais lu** dans `handleFrame`/`floodFrame`/`forwardToPort`. Un port en voice VLAN ne distingue donc jamais le trafic voix (censé être tagué sur le voice VLAN par un téléphone IP en aval) du trafic data (censé rester untagué sur le VLAN d'accès, à travers le même port physique) — les deux canaux logiques d'un port voice VLAN réel n'existent pas. Côté Huawei, `voice-vlan` est déjà reconnu comme mot-clé décoratif générique (`HuaweiSwitchShell.ts:1752`) mais tout aussi inerte. | Comportement Cisco IOS réel (`switchport voice vlan` + auto-config du téléphone via CDP) et Huawei VRP réel (`voice-vlan <id> enable` + détection par OUI MAC) | Moyenne |
| 2 | **Private VLANs (PVLAN) totalement absents côté Cisco ; l'équivalent fonctionnel Huawei (isolation de port / Super-VLAN) également inerte.** Recherche exhaustive : aucun type, aucune commande CLI Cisco pour VLAN primaire/isolé/communautaire, ni pour les rôles de port promiscuous/isolated/community. Côté Huawei, **il n'existe pas de PVLAN identique** — le mécanisme réel VRP le plus proche est `port-isolate enable` (isolation L2 simple entre ports d'un même VLAN, déjà reconnu comme mot-clé décoratif générique, `HuaweiSwitchShell.ts:1752`), complété par la notion distincte de **Super-VLAN/Sub-VLAN** (agrégation de plusieurs VLAN sous une même interface L3, pour la conservation d'adresses IP — un objectif proche du PVLAN mais un mécanisme différent). Aucun des deux n'a de trace dans le code au-delà du mot-clé décoratif `port-isolate`. | IEEE 802.1Q (PVLAN, RFC 5517) côté Cisco ; Huawei VRP réel `port-isolate`/`super-vlan`/`subvlan` côté Huawei — **deux mécanismes distincts, pas une même fonctionnalité portée telle quelle d'un vendor à l'autre** | Majeure |
| 3 | **VACL absents des deux vendors, avec des mécanismes réels différents à implémenter.** Cisco : `vlan access-map`/`vlan filter` totalement absent. Huawei : le filtrage de trafic scopé VLAN passe par le modèle MQC (Modular QoS CLI) — `traffic-classifier`/`traffic-behavior`/`traffic-policy` appliqué au niveau VLAN — dont `traffic-policy`/`traffic-filter` sont déjà reconnus comme mots-clés décoratifs génériques (`HuaweiSwitchShell.ts:1752`), mais aucune structure de classification/action derrière. | Cisco IOS réel (`vlan access-map`) ; Huawei VRP réel (MQC `traffic-classifier`/`traffic-behavior`/`traffic-policy`) — **deux modèles de configuration différents pour un besoin fonctionnel équivalent** | Moyenne |
| 4 | **`port link-type hybrid` (Huawei) est un stub sans plan de données**, explicitement documenté comme tel dans le code (« the Switch model has no hybrid datapath ») — la commande est acceptée et réaffichée, mais un port hybrid ne peut pas aujourd'hui émettre plusieurs VLAN en untagué simultanément comme le permettrait un vrai mode hybrid VRP. | Comportement Huawei VRP réel | Moyenne |
| 5 | **VLAN réservées 1002-1005 non modélisées** (dépend de la définition normative posée par `PRD-802.1Q.md` §2.1.4 — `createVLAN` accepte aujourd'hui n'importe quel VID 1-4094 sans réserve). | IEEE 802.1Q / convention Cisco | Mineure |
| 6 | **MSTP (802.1s) absent au niveau moteur** — seul un état `stpMode`/`mstRegion` local au shell Cisco existe, jamais consommé par `StpAgent`. Ce gap concerne le moteur STP lui-même (hors périmètre de ce trio de PRD, déjà noté dans `GAP.md` §2.1), mais impacte directement la segmentation VLAN dès qu'un nombre de VLAN dépasse ce qu'une instance PVST+ par VLAN peut raisonnablement gérer en pratique (une instance MSTP mappe plusieurs VLAN sur une même instance de spanning tree). Documenté ici comme **dépendance externe non bloquante** — ce PRD ne propose pas de la lever. | IEEE 802.1s | Majeure (hors périmètre direct) |
| 7 | **VTP pruning n'a aucun effet sur le flood** (le champ `pruning` de `VtpConfig` n'est jamais lu par `floodFrame`/`forwardToPort`). Ce gap est documenté et traité dans `docs/PRD-VTP.md` §1.3, mais il est mentionné ici car son point d'ancrage technique (la fonction de flood) appartient à ce PRD-ci — toute implémentation de pruning réel modifiera `Switch.floodFrame()`. | Comportement Cisco IOS réel (VTP pruning) | Voir `PRD-VTP.md` |

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

Comme pour `docs/PRD-802.1Q.md` : chaque fonctionnalité ci-dessous est livrée
**complète**, et lorsqu'un équipement réel Cisco IOS et Huawei VRP la
supporte tous les deux (même via des mécanismes différents), elle est
implémentée pour les deux, chacun avec son mécanisme et sa CLI réels — sans
forcer une sémantique Cisco sur Huawei ou inversement quand les produits
réels divergent (cf. item 2 ci-dessous, où Cisco et Huawei résolvent le même
besoin par deux fonctionnalités distinctes).

1. **Voice VLAN à double canal réel, avec l'auto-configuration du téléphone
   propre à chaque vendor.** Le cœur commun aux deux vendors : un port
   configuré avec un voice VLAN traite le trafic tagué sur ce VLAN (issu du
   téléphone IP) indépendamment du trafic data untagué du VLAN d'accès du
   même port physique, sans second port. Dans `handleFrame`, un port avec
   `voiceVlan` configuré et une trame entrante taguée avec ce VID est traité
   comme un port d'accès virtuel sur ce VLAN (apprentissage MAC, flood
   scope) plutôt que par le chemin « access VLAN » par défaut. Additif : un
   port sans `voiceVlan` garde un comportement strictement identique à
   aujourd'hui. Au-delà de ce cœur commun, l'**auto-configuration du
   téléphone** diffère réellement par vendor et doit être livrée pour
   chacun :
   - **Cisco** : le switch annonce le voice VLAN au téléphone IP via un TLV
     CDP dédié (extension du `CdpAgent` déjà solide, cf. §1.2, pour porter ce
     TLV) — un vrai téléphone Cisco se configure automatiquement à réception.
   - **Huawei** : détection du téléphone par **OUI de son adresse MAC**
     (table d'OUI connus, `voice-vlan mac-address <oui> mask <mask>`, déjà
     anticipé comme mot-clé décoratif `voice-vlan`) plutôt que par un
     protocole d'annonce — un port en mode voice VLAN auto (`voice-vlan <id>
     enable` + `mode auto`) bascule automatiquement en canal voix dès qu'une
     trame source d'une MAC dont l'OUI correspond à la table est vue.
2. **Isolation privée par port — deux fonctionnalités vendor réelles
   distinctes, pas une portée d'un vendor vers l'autre.**
   - **Cisco : Private VLANs (PVLAN) complets.** Type `PrivateVlanRole =
     'primary' | 'isolated' | 'community'` associé à une paire (VLAN
     primaire, VLAN(s) secondaire(s)), rôles de port `promiscuous`/
     `isolated`/`community` (`switchport mode private-vlan
     host/promiscuous`, `switchport private-vlan host-association`/
     `mapping`), **y compris les ports trunk promiscuous/isolated** qui
     étendent un PVLAN à travers plusieurs commutateurs (`switchport mode
     private-vlan trunk promiscuous/host`), et le **mapping SVI** (`private-vlan
     mapping` sur l'interface VLAN primaire) pour permettre le routage L3
     depuis/vers les VLAN secondaires. Sémantique de filtrage complète dans
     `floodFrame`/`forwardToPort` : un port isolated n'atteint jamais un
     autre port isolated (seulement les promiscuous) ; un port community
     atteint les autres community du même VLAN secondaire et les
     promiscuous ; un port promiscuous atteint tout le VLAN primaire. Cette
     fonctionnalité interagit avec le VACL (item 3) — l'ordre d'évaluation
     PVLAN puis VACL doit être fixé et testé explicitement (cf. §5 Risques).
   - **Huawei : `port-isolate` + Super-VLAN/Sub-VLAN, le mécanisme réel VRP
     équivalent — pas un portage du modèle Cisco.** `port-isolate enable`
     (déjà anticipé comme mot-clé décoratif) réalise l'isolation L2 simple
     entre ports d'un même VLAN (équivalent fonctionnel le plus proche de
     l'isolation PVLAN, mais sans notion de VLAN secondaire dédié).
     Complémentairement, la paire **Super-VLAN/Sub-VLAN** (`super-vlan`,
     `subvlan-list`) résout le même objectif de fond que le PVLAN Cisco
     (conserver un espace d'adressage IP unique sur plusieurs VLAN L2) par un
     mécanisme distinct : plusieurs Sub-VLAN partagent l'interface L3 (la
     SVI) du Super-VLAN. Les deux commandes VRP réelles sont implémentées
     intégralement, sans tenter de faire correspondre terme à terme leurs
     rôles de port à la terminologie primary/isolated/community de Cisco.
3. **VACL complets — deux modèles de configuration réels distincts.**
   - **Cisco : `vlan access-map`/`vlan filter` complets.** Réutilisation du
     moteur ACL existant (`src/network/acl/`) pour évaluer une liste d'accès
     **scopée par VLAN** plutôt que par interface, appliquée dans
     `floodFrame` avant la diffusion intra-VLAN. Commandes CLI complètes :
     `vlan access-map <name> <seq>`, tous les critères de correspondance
     pertinents (`match ip address <acl>`, `match ipv6 address <acl>`,
     `match mac address <acl>`), `action forward/drop`, `vlan filter <name>
     vlan-list <list>`.
   - **Huawei : modèle MQC complet (`traffic-classifier`/`traffic-behavior`/
     `traffic-policy` appliqué au niveau VLAN), pas une syntaxe `vlan
     access-map` recopiée.** `traffic classifier <name>` (critères
     `if-match`), `traffic behavior <name>` (action `permit`/`deny`),
     `traffic policy <name>` (association classifier↔behavior), puis
     application scopée VLAN (`traffic-policy <name> inbound` sous la vue
     VLAN) — réutilisant `traffic-policy`/`traffic-filter`, déjà anticipés
     comme mots-clés décoratifs, en leur donnant la structure de
     classification/action complète du modèle MQC réel plutôt qu'un simple
     enregistrement de ligne.
4. **Port hybrid complet (Huawei).** Plan de données complet pour le mode
   `port link-type hybrid` : liste de VLAN untagged (`port hybrid untag vlan
   <list>`) et taggés (`port hybrid tagged vlan <list>`) par port, PVID
   configurable indépendamment (`port hybrid pvid vlan <id>`), interaction
   correcte avec l'apprentissage MAC par VLAN et le blocage STP par VLAN déjà
   existants, et `display port vlan` listant fidèlement les ensembles
   untagged/tagged par port hybrid — pas seulement les couples access/trunk
   déjà couverts. Fonctionnalité **Huawei uniquement** : Cisco IOS ne permet
   pas plusieurs VLAN untagged simultanés sur un même port physique (un
   trunk Cisco n'a qu'un seul native VLAN) — il n'y a donc pas d'équivalent
   réel à porter côté Cisco, et ce PRD ne force pas une parité artificielle.
5. **VLAN réservées et validation de VID.** Voir `PRD-802.1Q.md` §2.1.4 — ce
   PRD applique la contrainte côté `Switch.createVLAN`/CLI, la définition
   normative de la plage réservée (et son asymétrie Cisco/Huawei) étant posée
   dans le PRD d'encodage.

### 2.2 Hors périmètre (explicitement exclu)

- MSTP (802.1s) — dépendance externe documentée en §1.3 item 6, relève d'un
  futur PRD dédié au moteur STP, pas de ce trio. Cette exclusion est une
  frontière entre protocoles (STP est un moteur distinct de la segmentation
  VLAN elle-même), pas une réduction de la portée VLAN traitée ici.
- VTP pruning — traité dans `docs/PRD-VTP.md`, seul le point d'ancrage
  technique (`floodFrame`) est partagé.
- QinQ — traité dans `docs/PRD-802.1Q.md` ; ce PRD suppose l'encapsulation
  disponible mais ne la réimplémente pas.
- Toute notion de QoS/priorisation du trafic voix au-delà du simple
  aiguillage VLAN (pas de garantie de bande passante, pas de file d'attente
  prioritaire) — cette dimension relève du modèle de confiance/marquage
  802.1p complet traité dans `docs/PRD-802.1Q.md` §2.1.2, pas de ce PRD.

---

## 3. Plan de remédiation détaillé

### Phase 1 — Voice VLAN à double canal (item 2.1.1)

Scindée en un socle commun puis deux volets vendor (les deux requis) :

- **Phase 1a — socle commun** : `Switch.ts` (`handleFrame`, branchement sur
  `voiceVlan` avant la résolution normale du VLAN d'ingress).
- **Phase 1b — Cisco (auto-config par CDP)** : extension du TLV `CdpAgent`
  pour porter le voice VLAN annoncé (`src/network/cdp/`), consommé côté
  téléphone simulé si applicable.
- **Phase 1c — Huawei (détection par OUI)** : table d'OUI
  (`voice-vlan mac-address <oui> mask <mask>`), mode auto
  (`voice-vlan <id> enable` + `mode auto`) dans `HuaweiSwitch.ts`.
- **Tests** : nouveau fichier `voice-vlan-datapath.test.ts` (socle commun,
  les deux vendors) + `voice-vlan-cdp-autoconfig.test.ts` (Cisco) +
  `voice-vlan-oui-detection.test.ts` (Huawei) ; régression sur
  `vlan-advanced.test.ts` et `cisco-switchport.test.ts`.

### Phase 2 — Isolation privée par port (item 2.1.2)

Deux volets vendor indépendants et non interchangeables :

- **Phase 2a — Cisco Private VLAN complet** : `Switch.ts` (nouveau type
  `PrivateVlanConfig`, filtrage dans `floodFrame`/`forwardToPort`, y compris
  les ports trunk promiscuous/isolated et le mapping SVI), CLI Cisco
  complète (`private-vlan primary/isolated/community`, `switchport mode
  private-vlan host/promiscuous`, `switchport mode private-vlan trunk
  promiscuous/host`, `switchport private-vlan host-association`/`mapping`,
  `private-vlan mapping` sur la SVI primaire).
- **Phase 2b — Huawei `port-isolate` + Super-VLAN/Sub-VLAN** : `Switch.ts`/
  `HuaweiSwitch.ts` (isolation L2 simple par groupe de ports isolés, et
  structure Super-VLAN agrégeant plusieurs Sub-VLAN sous une SVI commune),
  CLI VRP complète (`port-isolate enable`, `super-vlan`, `subvlan-list`).
- **Tests** : nouveau fichier `private-vlan.test.ts` (Cisco — isolation
  isolated↔isolated, communication community↔community et
  community/isolated→promiscuous, ports trunk promiscuous/isolated,
  routage via SVI mappée) + `huawei-port-isolate-super-vlan.test.ts` (Huawei
  — isolation entre ports du même groupe, agrégation Sub-VLAN sous une même
  SVI Super-VLAN).

### Phase 3 — VACL (item 2.1.3)

Deux volets vendor avec des modèles de configuration distincts :

- **Phase 3a — Cisco `vlan access-map`/`vlan filter` complet** :
  `Switch.ts` (point d'évaluation dans `floodFrame`), réutilisation de
  `src/network/acl/` sans dupliquer sa logique d'évaluation, tous les
  critères de correspondance (`match ip/ipv6/mac address`).
- **Phase 3b — Huawei MQC complet** : nouvelles structures
  `traffic-classifier`/`traffic-behavior`/`traffic-policy` (potentiellement
  un nouveau sous-module `src/network/devices/huawei/mqc/` suivant l'esprit
  modulaire du projet), application scopée VLAN, réutilisation de
  `src/network/acl/` pour l'évaluation des critères `if-match` autant que
  possible plutôt qu'un second moteur de correspondance dupliqué.
- **Tests** : nouveau fichier `vlan-access-map.test.ts` (Cisco) +
  `huawei-vlan-traffic-policy.test.ts` (Huawei).

### Phase 4 — Port hybrid Huawei (item 2.1.4)

- **Fichiers touchés** : `Switch.ts`/`HuaweiSwitch.ts` (extension du modèle
  de port pour accepter plusieurs VLAN untagged simultanés, PVID
  indépendant), CLI `HuaweiSwitchShell.ts` (`port hybrid untag/tagged vlan`,
  `port hybrid pvid vlan`).
- **Tests** : nouveau fichier `huawei-hybrid-port.test.ts` ; régression sur
  `huawei-vlan-extras.test.ts`, `debug/huawei/huawei-vlan.debug.test.ts`.
- **Vendor unique assumé** : aucun volet Cisco — absence réelle d'équivalent
  matériel, documentée en §2.1.4, pas un oubli.

### Phase 5 — VLAN réservées (item 2.1.5)

- Voir `PRD-802.1Q.md` Phase 6 — implémentation côté `Switch.createVLAN`
  une fois la définition normative de plage (et son asymétrie vendor) posée
  là-bas.

---

## 4. Exigences de non-régression

Toute correction reste **additive et testée**. Suites déjà vertes à ne pas
régresser en priorité : `vlan-advanced.test.ts` (701 lignes),
`inter-vlan-routing.test.ts`, `switch-svi.test.ts`, `cisco-l3-switch.test.ts`,
`huawei-l3-switch.test.ts`, `stp-pvst.test.ts` et les autres suites STP citées
en §1.2, `huawei-vlan-extras.test.ts`, les suites `debug/cisco-l2/*` et
`debug/protocols/vlan.debug.test.ts`/`debug/huawei/huawei-vlan.debug.test.ts`.
Chaque phase de ce PRD est indépendante des autres (aucun ordre imposé entre
Phases 1-4 ; seule la Phase 5 dépend d'une décision prise dans
`PRD-802.1Q.md`). Au sein de chaque phase multi-vendor (1, 2, 3), les deux
volets sont requis pour clore la phase : livrer uniquement le volet Cisco
(ou uniquement le volet Huawei) d'une fonctionnalité commune aux deux
vendors constitue une livraison incomplète, pas un incrément acceptable —
même règle que celle posée dans `PRD-802.1Q.md` §4.

---

## 5. Risques

- **Risque principal** : la Phase 2 (isolation privée par port, les deux
  volets) touche la fonction de flood la plus centrale du switch
  (`floodFrame`) — une régression y aurait un impact large sur toute
  topologie multi-VLAN existante. Mitigation : filtrage implémenté comme une
  passe additionnelle *après* le calcul normal du scope de flood, jamais en
  remplacement, avec un test de non-régression exécutant la suite
  `vlan-advanced.test.ts` complète avant chaque commit de cette phase.
- **Risque d'ordonnancement des filtres combinés** : à terme, `floodFrame`
  pourra appliquer successivement le filtrage PVLAN (Phase 2a), le VACL
  (Phase 3a/3b) et — une fois `docs/PRD-VTP.md` Phase 3 livrée — le pruning
  VTP. L'ordre d'évaluation de ces trois filtres doit être fixé
  explicitement (proposition : PVLAN d'abord, car il définit l'atteignabilité
  structurelle du port ; VACL ensuite, car il exprime une politique de
  sécurité explicite qui doit pouvoir bloquer même un chemin PVLAN autorisé ;
  pruning VTP en dernier, car il ne fait que retirer des trunks sans intérêt
  aval, un cas orthogonal aux deux premiers) et couvert par un test dédié dès
  que deux de ces trois filtres coexistent dans une même topologie de test.
- **Risque de parité artificielle** : la consigne de livrer les
  fonctionnalités communes aux deux vendors ne doit pas conduire à inventer
  un mécanisme Huawei qui n'existe pas réellement (ou inversement) — chaque
  volet vendor de ce PRD s'appuie sur une commande VRP/IOS réelle et
  documentée (cf. §1.3/§2.1), jamais sur une extrapolation de la fonctionnalité
  de l'autre vendor.
- **Risque secondaire** : la Phase 1 (voice VLAN) introduit un second chemin
  d'ingress sur un port par ailleurs access — risque de double comptage/
  double apprentissage MAC si mal isolé du chemin existant. Mitigation :
  tests explicites sur l'apprentissage MAC séparé par `"vlan:mac"` (déjà la
  clé existante, donc le mécanisme sous-jacent est déjà prêt à porter deux
  VLAN sur un même port physique).
