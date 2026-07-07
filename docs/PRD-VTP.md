# PRD — VTP (VLAN Trunking Protocol, propriétaire Cisco)

**Version** : 1.0
**Date** : 2026-07-07
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- Cisco VTP versions 1/2/3 (protocole propriétaire, pas de RFC — comportement
  de référence documenté par Cisco : *VLAN Trunking Protocol*, *Understanding
  VTP Pruning*, *VTP Version 3*)
- IEEE 802.1Q (VLAN — base synchronisée par VTP, cf. `docs/PRD-VLAN.md`)
- IEEE 802.1Q (encapsulation trunk — condition d'émission de VTP, cf.
  `docs/PRD-802.1Q.md`)

---

## 0. Contexte et portée du document

Ce PRD documente **le protocole de synchronisation de la base VLAN entre
commutateurs Cisco** : les modes server/client/transparent, le numéro de
révision de configuration, l'authentification par mot de passe de domaine,
l'annonce périodique et sur événement, le relais transparent, et le VTP
pruning. Il **consomme** deux fondations déjà couvertes ailleurs dans ce
trio de PRD : la base VLAN elle-même (`docs/PRD-VLAN.md` — VTP ne fait que
synchroniser ce qui y est décrit : `createVLAN`/`deleteVLAN`/`renameVLAN`) et
l'encapsulation 802.1Q (`docs/PRD-802.1Q.md` — VTP ne circule que sur des
ports trunk, donc taggés). Il ne redéfinit ni l'un ni l'autre.

Cette analyse est issue d'une lecture complète de `src/network/vtp/types.ts`,
`src/network/vtp/VtpAgent.ts` (244 lignes), de son intégration dans
`src/network/devices/CiscoSwitch.ts` (câblage `VtpHost`) et des méthodes
d'intégration définies dans `src/network/devices/Switch.ts`
(`_vtpListVlans`/`_vtpApplyVlans`/`_vtpIsTrunkPort`, l. 1838-1871), ainsi que
de `GAP.md` §2.5 (qui qualifie déjà le moteur VTP/DTP de « complet et
fidèle », un jugement que ce PRD affine avec un examen plus fin de la
fidélité au protocole réel, cf. §1.3).

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-802.1Q.md (IEEE 802.1Q/802.1ad)
   │  fondation d'encodage : format du tag, TPID/TCI, Native VLAN, QinQ
   │
   ▼  trame taguée transportée sur les trunks, VID porté par le tag
PRD-VLAN.md (segmentation L2 : base VLAN, access/trunk, PVST+, SVI)
   │  dépend de PRD-802.1Q.md pour l'encodage du VID sur le fil
   │
   ▼  base VLAN locale à synchroniser entre commutateurs d'un même domaine
PRD-VTP.md (synchronisation de la base VLAN entre commutateurs Cisco)  ◄── VOUS ÊTES ICI
      dépend de PRD-VLAN.md pour la base VLAN à synchroniser
      (`_vtpListVlans`/`_vtpApplyVlans`), et de PRD-802.1Q.md pour la
      condition d'émission (`_vtpIsTrunkPort` — VTP ne circule que sur
      des ports trunk taggés 802.1Q)
```

Ce PRD a **deux dépendances entrantes non bloquantes** : la base VLAN de
`PRD-VLAN.md` (déjà complète, cf. son §1.2 — aucune phase de ce PRD n'attend
une phase de `PRD-VLAN.md`) et l'encodage 802.1Q de `PRD-802.1Q.md` (déjà
fonctionnel pour la détection de trunk). Aucune dépendance vers TLS/QUIC —
VTP est un protocole de contrôle L2 propriétaire, sans rapport avec le
transport chiffré ou applicatif. Le moteur DTP (négociation dynamique de
trunk), bien qu'adjacent et déjà solide selon `GAP.md` §2.5, n'a pas de PRD
dédié dans ce trio et n'est mentionné ici que comme dépendance amont
(`_vtpIsTrunkPort` lit l'état opérationnel du port, qu'il ait été fixé
statiquement ou négocié par DTP — indifférent du point de vue de VTP).

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel |
|---|---|
| `src/network/vtp/types.ts` | Types : `VtpMode` (server/client/transparent/off), `VtpVersion` (1/2/3), `VtpMessageType` (summary/subset/request/join), `VtpFrame`, `VtpConfig`, `hashPassword()` (hash maison, pas MD5 réel) |
| `src/network/vtp/VtpAgent.ts` | Moteur réactif : gestion des modes, révision, annonce périodique (300 s) et sur événement (changement de config/VLAN local, link-up, relais transparent), authentification domaine+mot de passe, application du diff VLAN entrant |
| `src/network/devices/CiscoSwitch.ts` (l. 86-91) | Câblage `VtpHost` : seule classe qui instancie `VtpAgent` |
| `src/network/devices/Switch.ts` (l. 1838-1871) | `_vtpListVlans`/`_vtpApplyVlans`/`_vtpIsTrunkPort` — l'intégration réelle avec la base VLAN et l'état trunk, définie dans la classe de base (donc techniquement héritable par tout vendor, mais seul Cisco l'active) |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Modes server/client/transparent/off** avec la sémantique correcte :
  transparent relaie sans traiter ni faire progresser sa propre révision
  (`revision` remise à 0 en passant en transparent) ; off ignore tout.
- **Numéro de révision comme source de vérité** : une trame entrante n'est
  appliquée à la base locale que si `payload.revision > this.config.revision`
  — évite qu'une annonce périmée écrase un état plus récent, comportement
  Cisco réel.
- **Authentification par domaine + mot de passe** : rejet explicite
  (`domain-mismatch`/`password-mismatch`) avant toute application, publié sur
  le bus (`vtp.frame.received` avec `accepted`/`rejectReason`) — observable et
  testable.
- **Apprentissage passif du domaine** : un switch sans domaine configuré
  adopte le premier domaine annoncé reçu sur un trunk, comme un vrai switch
  VTP client/server « vierge ».
- **Relais transparent réel** : `forwardOnTrunks()` réémet la trame VTP telle
  quelle sur tous les autres trunks sans la traiter, y compris protection
  anti-boucle simple (`advertising` Set évitant la réémission immédiate sur
  le port d'où la trame émane pendant l'envoi en cours).
- **Annonce déclenchée par les bons événements** : changement de mode vers
  server, changement de domaine, bump de révision sur modification VLAN
  locale, link-up d'un port trunk (`onPortLinkUp`) — couvre les cas réels où
  un vrai switch Cisco émettrait une annonce.
- **Diff VLAN appliqué proprement** : `_vtpApplyVlans` calcule
  ajouts/suppressions/renommages en une passe, retourne `{added, removed}`
  publié sur le bus (`vtp.db.synced`) — traçabilité complète.
- **VTP volontairement absent côté Huawei** (pas de `VtpHost` sur
  `HuaweiSwitch`) — conforme à la réalité (VTP est propriétaire Cisco), pas
  un défaut.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`VtpMessageType` déclare 4 valeurs (`summary`/`subset`/`request`/`join`) mais une seule est jamais réellement produite ou distinguée.** `sendSummaryAndSubset()` fixe systématiquement `messageType: 'summary'` quel que soit le motif (`'periodic'`, `'config-change'`, `'local-vlan-change'`, `'relay'`, `'link-up'` — tous encodés dans un `reason` texte séparé, jamais dans `messageType`), et `handleFrame()` **ne discrimine jamais sur `payload.messageType`** : toute trame VTP acceptée est traitée de façon identique (comparaison de révision + application des VLAN), qu'elle soit labellisée summary, subset, request ou join. Sur un vrai réseau VTP, une *Summary Advertisement* ne porte **aucune donnée VLAN** (seulement domaine/révision/nombre de *Subset Advertisements* à suivre) — elle sert à détecter qu'une mise à jour existe, pas à la transporter ; les VLAN eux-mêmes voyagent dans une ou plusieurs *Subset Advertisement* distinctes qui suivent immédiatement. Ici, une seule trame « summary » porte toujours la liste complète des VLAN — le format sur le fil ne serait pas reconnaissable par un vrai analyseur VTP (Wireshark décoderait un Summary Advertisement Cisco réel sans champ VLAN). | Format VTPv1/v2 réel (Summary Advertisement ≠ porteur de VLAN ; Subset Advertisement porteur de VLAN) | Élevée (fidélité au format réel) |
| 2 | **Aucune *Advertisement Request* n'est jamais émise.** Un client VTP réel qui vient de rejoindre un domaine (ou dont la révision est en retard) envoie une *Advertisement Request* pour obtenir une resynchronisation immédiate ; ici, `onPortLinkUp` ne déclenche une émission que côté **server** (`sendSummaryAndSubset` sur link-up), jamais côté client — un client fraîchement connecté attend jusqu'à 300 s (le prochain cycle périodique du serveur) avant de voir la base VLAN se synchroniser, au lieu d'un rafraîchissement quasi immédiat. | Comportement VTP réel (Advertisement Request au link-up/reset) | Moyenne |
| 3 | **VTP pruning est un champ de configuration 100% no-op.** `VtpConfig.pruning` (défaut `false`) est settable/affichable (`vtp pruning`, `show vtp status`) mais **n'est lu nulle part** dans `Switch.floodFrame()`/`forwardToPort()` — le flood broadcast/unknown-unicast traverse tous les trunks où le VLAN figure dans `trunkAllowedVlans`, indépendamment de la présence réelle de ports actifs de ce VLAN en aval. C'est le gap le plus visible fonctionnellement : activer le pruning ne change strictement rien au comportement observable. | VTP Pruning réel (réduction du flood sur les trunks où le VLAN n'a pas de port actif en aval) | Élevée (impact fonctionnel direct) |
| 4 | **Aucune différenciation de comportement entre versions 1/2/3.** `VtpVersion` accepte `1 | 2 | 3` et le champ est stocké/affiché, mais rien dans `VtpAgent` ne varie selon la version : pas de spécificités v2 (support Token Ring, hors périmètre légitime de ce simulateur), pas de spécificités v3 (plage VLAN étendue 1006-4094, concept de *Primary Server* avec élection/prise de contrôle explicite, support des VLAN privés dans la synchronisation, format de base de données opaque). Le champ `version` est aujourd'hui **purement déclaratif**. | Cisco VTP v1/v2/v3 (comportements distincts par version) | Moyenne |
| 5 | **`hashPassword()` est un hash maison (FNV-like), pas le MD5 réel utilisé par VTP sur le fil.** Documenté comme simplification assumée (comme le sont d'autres simplifications similaires dans d'autres PRD de ce dépôt, ex. ISN TCP) plutôt qu'un bug : le comportement *logique* (authentification accepte/rejette selon domaine+mot de passe) est correct, seul le format binaire du condensé diffère d'un vrai VTP MD5. Pertinent seulement si une fidélité byte-exacte de capture `tcpdump` est visée pour VTP (aujourd'hui non testée à ce niveau, contrairement à 802.1Q — cf. `PRD-802.1Q.md` §1.2). | MD5 réel (VTP utilise un condensé MD5 du mot de passe + contenu de la trame) | Faible |
| 6 | **VTP n'a pas d'équivalent côté Huawei** — confirmé **conforme à la réalité**, pas un gap (VTP est propriétaire Cisco). Mentionné ici uniquement pour clore explicitement la question dans ce PRD, sans action proposée. | — | (positif, aucune action) |

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

1. **Distinguer réellement Summary et Subset Advertisement (item 1).**
   `sendSummaryAndSubset()` doit émettre **deux trames distinctes** : une
   *Summary* (`messageType: 'summary'`, `vlans: []` — pas de payload VLAN,
   uniquement domaine/révision) suivie immédiatement d'une ou plusieurs
   *Subset* (`messageType: 'subset'`, portant la liste des VLAN). Côté
   réception, `handleFrame()` doit discriminer sur `messageType` :
   - `summary` seule met à jour la connaissance du domaine/de la révision
     annoncée par le pair mais ne touche pas la base VLAN locale ;
   - `subset` applique effectivement le diff VLAN, mais seulement si une
     `summary` récente a déjà annoncé une révision supérieure (évite
     d'accepter un `subset` orphelin/rejoué).
   Cette phase est la plus structurante : elle aligne le format sur le fil
   avec le protocole réel, ce qui est un préalable naturel avant d'ajouter
   les *Request*/*Join* (item 2) qui s'insèrent dans cet échange
   summary→subset.
2. **Advertisement Request au link-up côté client (item 2).** Un switch en
   mode client (ou server) dont la révision est possiblement en retard émet
   une trame `messageType: 'request'` au link-up d'un port trunk ; le pair
   qui la reçoit répond immédiatement par sa séquence summary+subset complète
   (sans attendre le prochain cycle périodique), réutilisant le
   `messageType: 'join'` existant dans le type comme signal de « je viens de
   rejoindre, resynchronise-moi » si sa sémantique s'avère plus appropriée en
   conception détaillée que `'request'` — à trancher lors de l'implémentation
   en confirmant l'usage réel Cisco des deux valeurs.
3. **VTP pruning réel (item 3, priorité la plus visible fonctionnellement).**
   Ajouter le suivi, par VLAN et par trunk, de la présence d'au moins un port
   actif de ce VLAN quelque part en aval du trunk (propagé via les mêmes
   annonces VTP — un champ additionnel dans le *Subset Advertisement* listant
   les VLAN pour lesquels le switch annonceur a un intérêt actif). Dans
   `Switch.floodFrame()`, un trunk marqué « pruné » pour un VLAN donné
   (aucun intérêt en aval ET pruning activé localement ET VLAN dans la plage
   éligible par défaut 2-1001) n'est simplement pas inclus dans le scope de
   flood pour ce VLAN. VLAN 1 et VLAN de gestion restent toujours non
   pruning-éligibles par défaut, comme sur un vrai switch Cisco.
4. **VTP version 3 complet (item 4).** Portée pleine des aspects v3
   pertinents pour ce simulateur (Token Ring/v2 exclu — technologie obsolète
   sans pertinence pédagogique, seule exclusion légitime) :
   - **Plage VLAN étendue** (1006-4094 en plus de la plage classique) —
     propagée par VTP v3 au même titre que la plage standard.
   - **Concept de *Primary Server*** avec commande `vtp primary [force]`
     déclenchant une élection explicite (le serveur avec la révision la plus
     haute et/ou priorité annoncée gagne, résolution de conflit en cas
     d'égalité), remplaçant la simple comparaison de révision symétrique
     utilisée aujourd'hui par tous les modes.
   - **Propagation des associations Private VLAN** dans la base VTP v3 : une
     fois `docs/PRD-VLAN.md` §2.1.2 (Phase 2a, Private VLAN Cisco) livrée, le
     couple (VLAN primaire, VLAN(s) secondaire(s), rôle) doit voyager dans le
     même mécanisme de synchronisation que la base VLAN standard — c'est une
     fonctionnalité v3 réelle (VTP v3 a été introduit en partie pour ce
     besoin), pas une extension inventée pour ce PRD. Dépendance réelle et
     assumée vers `docs/PRD-VLAN.md`, à séquencer après elle.
   - **Hors périmètre, par frontière de protocole et non par minimalisme** :
     la propagation d'une base MST (« MST database », type de base opaque
     v3 dédié aux instances MSTP) reste exclue, car MSTP lui-même est hors
     périmètre de ce trio de PRD (`docs/PRD-VLAN.md` §1.3 item 6) — il serait
     incohérent de synchroniser une base pour un moteur qui n'existe pas
     encore. Cette exclusion tombe automatiquement si un futur PRD dédié au
     moteur STP/MSTP est écrit et livré.
5. **Hash MD5 réel sur le fil (item 5).** Remplacer `hashPassword()` par un
   vrai MD5 (condensé du mot de passe de domaine, format binaire conforme à
   ce qu'un vrai VTP transmettrait) — livré comme fonctionnalité complète de
   ce PRD, pas une amélioration facultative reportée : la fidélité byte-exacte
   du format sur le fil est le même standard déjà appliqué à 802.1Q
   (`docs/PRD-802.1Q.md` §1.2, sérialisation TCI testée par capture) et doit
   être également atteint pour VTP. Cette phase inclut la création d'une
   suite de capture dédiée (`tcpdump`/décodage de trame VTP), qui n'existe
   pas encore, plutôt que d'attendre qu'un besoin futur la justifie.

### 2.2 Hors périmètre (explicitement exclu)

- Support Token Ring (VTP v2) — technologie obsolète, aucune pertinence
  pédagogique pour ce simulateur.
- Propagation d'une base MST via VTP v3 — frontière de protocole avec le
  moteur STP/MSTP, lui-même hors périmètre de ce trio (cf. item 4
  ci-dessus), pas une réduction de la portée VTP elle-même.
- DTP (négociation dynamique de trunk) — déjà solide selon `GAP.md` §2.5,
  aucune action proposée dans ce PRD, mentionné uniquement comme dépendance
  amont non bloquante (§0.1).
- Toute extension Huawei de VTP — confirmé sans équivalent réel (item 6 du
  gap analysis) ; ce PRD ne propose délibérément aucun développement
  Huawei ici, contrairement aux deux autres PRD de ce trio.

---

## 3. Plan de remédiation détaillé

### Phase 1 — Summary/Subset distincts (item 2.1.1)

- **Fichiers touchés** : `VtpAgent.ts` (`sendSummaryAndSubset` scindée en
  deux émissions), `types.ts` (inchangé — les types existent déjà).
- **Non-régression** : le comportement observable côté application de VLAN
  (le diff finit par être appliqué) doit rester identique une fois les deux
  trames reçues — seul le format sur le fil et le séquencement changent.
- **Tests** : extension de `vtp-protocol.test.ts` — vérifier qu'une
  `summary` seule ne modifie jamais la base VLAN locale, qu'un `subset`
  orphelin (sans `summary` précédente à révision supérieure) est ignoré.

### Phase 2 — Advertisement Request au link-up (item 2.1.2)

- **Fichiers touchés** : `VtpAgent.ts` (`onPortLinkUp`, nouveau handler pour
  `messageType: 'request'`/`'join'` reçu).
- **Tests** : nouveau cas dans `vtp-protocol.test.ts` — un client qui vient
  de connecter un trunk reçoit sa mise à jour VLAN sans attendre 300 s.

### Phase 3 — VTP pruning réel (item 2.1.3)

- **Fichiers touchés** : `VtpAgent.ts` (annonce d'intérêt VLAN dans le
  *Subset*), `Switch.ts` (`floodFrame()` — filtrage des trunks prunés par
  VLAN), `VtpConfig` (probablement une nouvelle structure de suivi d'intérêt
  par trunk, à concevoir en détail).
- **Tests** : nouveau fichier `vtp-pruning.test.ts` — topologie à 3 switches
  en chaîne, VLAN sans port actif sur le switch du bout, vérifier que le
  flood ne traverse pas le trunk du milieu vers le switch du bout une fois le
  pruning actif des deux côtés ; régression complète sur `vtp-protocol.test.ts`
  et `vlan-advanced.test.ts` (le flood normal, non pruné, ne doit pas changer).

### Phase 4 — VTP v3 complet (item 2.1.4)

Scindée en trois volets, le troisième dépendant explicitement d'un autre PRD :

- **Phase 4a — plage VLAN étendue** : `types.ts` (validation 1006-4094
  conditionnelle à `version === 3`), `VtpAgent`/`_vtpApplyVlans` (accepter le
  diff sur la plage étendue).
- **Phase 4b — élection de serveur primaire** : `VtpAgent.ts` (état
  `primaryServer`, commande `vtp primary [force]`, résolution de conflit par
  révision puis par priorité annoncée).
- **Phase 4c — propagation des associations Private VLAN** (dépendance
  explicite et bloquante vers `docs/PRD-VLAN.md` §2.1.2 Phase 2a) : extension
  de `VtpFrame`/`VtpVlanEntry` pour porter le couple (VLAN primaire, VLAN
  secondaire, rôle), consommé par `_vtpApplyVlans` pour recréer la
  configuration Private VLAN sur les switches clients.
- **Tests** : nouveau fichier `vtp-v3-primary-server.test.ts` (4a+4b) +
  `vtp-v3-private-vlan-propagation.test.ts` (4c, ne peut être écrit qu'une
  fois `docs/PRD-VLAN.md` Phase 2a livrée).

### Phase 5 — MD5 réel sur le fil (item 2.1.5)

- **Fichiers touchés** : `types.ts` (`hashPassword` remplacé par un vrai
  MD5), `VtpFrame` (format du condensé conforme).
- **Tests** : cette phase inclut la création de la suite de capture qui
  n'existe pas encore — nouveau fichier
  `tcpdump-vtp-frame-capture.test.ts` (pendant VTP de
  `tcpdump-byte-slice-vlan-filters.test.ts` côté 802.1Q), vérifiant que le
  condensé MD5 apparaît correctement dans la trame capturée.

---

## 4. Exigences de non-régression

Toute correction reste **additive et testée**. Suite déjà verte à ne pas
régresser : `vtp-protocol.test.ts` (306 lignes) et, par ricochet, toute suite
qui exerce indirectement un switch en mode VTP server/client
(`debug/cisco-l2/cisco-l2-03-trunk-dtp-vtp.debug.test.ts`). La Phase 1 est un
préalable naturel à la Phase 2 (le message `request`/`join` s'insère dans
l'échange summary→subset qu'elle établit). La Phase 4c dépend explicitement
de `docs/PRD-VLAN.md` Phase 2a (Private VLAN Cisco) — c'est une dépendance
inter-PRD réelle à respecter dans l'ordonnancement global des deux PRD, pas
une simple suggestion d'ordre. Les Phases 3, 4a, 4b et 5 sont par ailleurs
indépendantes entre elles et de la Phase 2.

---

## 5. Risques

- **Risque principal** : la Phase 1 change le nombre de trames échangées par
  cycle d'annonce (une summary + N subsets au lieu d'une trame unique) — tout
  test existant qui compte le nombre exact de trames VTP émises devra être
  révisé consciemment, pas silencieusement laissé à casser. Auditer
  `vtp-protocol.test.ts` avant d'écrire le code de cette phase pour recenser
  ces assertions.
- **Risque secondaire** : la Phase 3 (pruning) modifie `floodFrame()`, une
  fonction déjà partagée avec la Phase 2 de `PRD-VLAN.md` (Private VLAN) et
  la Phase 3 de `PRD-VLAN.md` (VACL) — si ces PRD sont implémentés en
  parallèle, l'ordre d'application des filtres (PVLAN, VACL, pruning VTP)
  dans `floodFrame()` doit être explicitement fixé et testé (voir l'ordre
  proposé dans `docs/PRD-VLAN.md` §5) pour éviter qu'un filtre masque
  silencieusement le comportement d'un autre.
- **Risque de séquencement inter-PRD** : la Phase 4c (propagation Private
  VLAN par VTP v3) ne peut pas être développée avant `docs/PRD-VLAN.md`
  Phase 2a — si l'équipe qui planifie l'implémentation traite les trois PRD
  de ce trio comme des chantiers strictement parallèles et indépendants,
  cette dépendance précise doit être signalée explicitement en amont pour
  éviter un blocage découvert tardivement.
- **Risque de charge de travail sous-estimée** : le passage d'un VTP v3
  « minimal » (plage étendue seule) à un VTP v3 complet (élection de serveur
  primaire + propagation Private VLAN) et d'un hash simplifié à un vrai MD5
  avec suite de capture dédiée représente un volume de travail sensiblement
  plus grand que la version initiale de ce PRD — assumé explicitement ici,
  cf. le même risque documenté dans `docs/PRD-802.1Q.md` §5 et
  `docs/PRD-VLAN.md` §5 pour les deux autres PRD de ce trio.
