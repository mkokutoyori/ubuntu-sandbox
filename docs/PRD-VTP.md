# PRD — VTP (VLAN Trunking Protocol, propriétaire Cisco)

**Version** : 2.0 (v1.0 : 2026-07-07)
**Date** : 2026-07-27
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

**Ce qui a changé depuis la v1.0 de ce PRD (2026-07-07) : les cinq objectifs
qu'elle proposait ont tous été livrés entre-temps**, confirmé par relecture
complète du code actuel et de l'historique git :

| Objectif v1.0 | Commit | État |
|---|---|---|
| Summary/Subset distincts + Advertisement Request | `3839a50e` | Livré |
| VTP pruning réel (filtrage de flood) | `227e8332` | Livré |
| VTP v3 (plage étendue + Primary Server) | `02f74eb7` | Livré (hors propagation Private VLAN, cf. §1.3 item 4) |
| MD5 réel sur le fil | `1ac63d39` | Livré (algorithme réel ; construction byte-exacte du condensé encore non vérifiée, cf. §1.3 item 2) |
| — | `7b6e43dd`, `29e2e716` | Correctifs de synchronisation additionnels (config-change immédiat, VLAN précédant l'affectation de domaine) |

Cette v2.0 **remplace l'analyse de gaps et les objectifs de la v1.0** (devenus
obsolètes puisque livrés) par une relecture à nouveau complète du moteur
actuel (`VtpAgent.ts`, passé de 244 à 481 lignes) et identifie ce qui reste
réellement à faire : trois résidus de fidélité protocolaire, plus une
opportunité nouvellement débloquée (propagation d'une base MST — cf. §1.3
item 3 et §0.1). Le périmètre général du document ne change pas : il
continue de documenter **le protocole de synchronisation de la base VLAN
entre commutateurs Cisco**, en consommant sans les redéfinir la base VLAN
(`docs/PRD-VLAN.md`) et l'encapsulation 802.1Q (`docs/PRD-802.1Q.md`).

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
      (`vtpListVlans`/`vtpApplyVlans`), et de PRD-802.1Q.md pour la
      condition d'émission (`vtpIsTrunkPort` — VTP ne circule que sur
      des ports trunk taggés 802.1Q)
```

**Dépendance levée depuis la v1.0** : la v1.0 excluait explicitement la
propagation d'une base MST par VTP v3 « car MSTP lui-même est hors périmètre
… Cette exclusion tombe automatiquement si un futur PRD dédié au moteur
STP/MSTP est écrit et livré » (`docs/PRD-VLAN.md §1.3 item 6`, cité alors).
**Les deux conditions sont désormais réunies** : le moteur MSTP est
réellement implémenté (`StpAgent` consomme pour de vrai le mode `'mstp'` et
une `MstRegion`, cf. `docs/PRD-STP.md §0.1`), et ce PRD dédié existe
(`docs/PRD-STP.md`). L'exclusion tombe donc, cf. §1.3 item 3 et §2.1 — cette
v2.0 en fait un objectif à part entière plutôt qu'un non-objectif.

**Dépendance toujours non levée** : la propagation des associations Private
VLAN (Phase 4c de la v1.0) reste bloquée sur `docs/PRD-VLAN.md` §2.1.2 —
confirmé par cet audit : aucune notion de Private VLAN n'existe encore nulle
part dans le moteur VLAN (`grep` exhaustif sans résultat). Reste documentée
en §1.3 item 4 comme dépendance externe non résolue, pas comme un objectif
de cette v2.0.

Aucune dépendance vers TLS/QUIC — VTP est un protocole de contrôle L2
propriétaire, sans rapport avec le transport chiffré ou applicatif. Le
moteur DTP (négociation dynamique de trunk) reste hors périmètre de ce PRD
(§2.2), mentionné uniquement comme dépendance amont non bloquante.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel |
|---|---|
| `src/network/vtp/types.ts` (59 lignes) | Types : `VtpMode`, `VtpVersion`, `VtpMessageType` (`summary`/`subset`/`request`/`join` — les 4 valeurs sont maintenant réellement distinguées, cf. §1.2), `VtpFrame` (avec `interestVlans`, `primaryClaim`), `VtpConfig` (avec `pruning`, `primaryServer`), `hashPassword()` — **MD5 réel** via `md5Hex()` de `src/crypto/hash/md5.ts` |
| `src/network/vtp/VtpAgent.ts` (481 lignes, contre 244 en v1.0) | Moteur réactif complet : Summary/Subset distincts, Advertisement Request au link-up/changement de config, pruning réel (suivi d'intérêt par port via `messageType: 'join'`), élection de Primary Server v3, plage VLAN étendue conditionnelle à la version |
| `src/network/vtp/events.ts` (47 lignes) | Topics bus : `vtp.mode.changed`, `vtp.domain.changed`, `vtp.frame.received/sent`, `vtp.db.synced` |
| `src/network/devices/CiscoSwitch.ts` | Câblage `VtpHost` — seule classe qui instancie `VtpAgent` (Huawei toujours sans équivalent, cf. §1.2) |
| `src/network/devices/Switch.ts:1996` | `floodFrame()` interroge réellement `getVtpAgentOrNull()?.isVlanPruned(portName, vlan)` avant d'inclure un trunk dans le scope de flood — le pruning n'est plus un champ décoratif |
| 5 fichiers de tests (975 lignes) | `vtp-protocol.test.ts` (442 l.), `vtp-pruning.test.ts` (138 l.), `vtp-v3-primary-server.test.ts` (201 l.), `vtp-md5-password.test.ts` (67 l.), `vtp-config-change-sync.test.ts` (127 l.), plus `debug/cisco-l2/cisco-l2-03-trunk-dtp-vtp.debug.test.ts` |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

Repris de la v1.0 (toujours vrai) :

- Modes server/client/transparent/off avec la sémantique correcte
  (transparent relaie sans traiter, révision remise à 0 ; off ignore tout).
- Numéro de révision comme source de vérité pour l'application d'une trame
  entrante.
- Authentification par domaine + mot de passe, rejet explicite publié sur le
  bus (`vtp.frame.received` avec `accepted`/`rejectReason`).
- Apprentissage passif du domaine par un switch vierge.
- Relais transparent réel avec protection anti-boucle simple.
- VTP volontairement absent côté Huawei (conforme à la réalité, pas un
  défaut).

**Nouveau depuis la v1.0, vérifié par cet audit** :

- **Summary et Subset Advertisement réellement distincts.**
  `sendSummaryAndSubset()` (`VtpAgent.ts:396-407`) émet une trame `summary`
  (`vlans: []`, uniquement domaine/révision/`primaryClaim` éventuel) suivie
  immédiatement d'une trame `subset` (`vlans` complète). En réception
  (`handleFrame`, l. 188-229), un `summary` seul ne met à jour que
  `lastSummaryDomain`/`lastSummaryRevision`, jamais la base VLAN locale ; un
  `subset` est ignoré comme orphelin (log `vtp:orphan-subset`) s'il ne
  correspond pas à un `summary` déjà vu de même domaine/révision — exactement
  la remédiation proposée par la v1.0 item 1.
- **Advertisement Request réellement émise et traitée.** Un client (ou
  server) envoie `messageType: 'request'` au link-up d'un trunk
  (`onPortLinkUp`) et sur changement de mode/domaine
  (`requestSyncOnTrunks`) ; un server qui la reçoit répond immédiatement par
  sa séquence summary+subset complète (`handleRequest` →
  `sendSummaryAndSubset(portName, 'request-reply')`), sans attendre le
  cycle périodique de 300 s. L'ambiguïté que la v1.0 laissait ouverte entre
  `'request'` et `'join'` a été tranchée par l'implémentation : `'request'`
  sert exclusivement à la resynchronisation, `'join'` sert exclusivement à
  la propagation d'intérêt VLAN pour le pruning (point distinct, voir
  ci-dessous) — un choix de conception cohérent, pas une confusion.
- **VTP pruning fonctionnellement réel.** Chaque port trunk annonce son
  intérêt VLAN agrégé (`aggregatedInterest`/`sendJoin`, propagé par
  `messageType: 'join'`) ; `isVlanPruned(portName, vlan)`
  (`VtpAgent.ts:108-114`) renvoie vrai si le pruning est actif, le VLAN est
  dans la plage éligible par défaut (2-1001), et le pair sur ce port n'a
  manifesté aucun intérêt pour ce VLAN. `Switch.floodFrame()`
  (`Switch.ts:1996`) consulte réellement cette méthode avant d'inclure un
  trunk dans le scope de flood — le gap le plus visible fonctionnellement
  de la v1.0 est fermé.
- **VTP v3 : plage étendue et élection de Primary Server, tous deux réels.**
  `allowsExtendedRangeVlans()`/`filterVlansForVersion()` conditionnent
  l'acceptation des VLAN 1006-4094 à `version === 3` (ou mode
  transparent/off, qui échappe par nature à la synchronisation) ;
  `becomePrimary(force)` implémente une élection explicite avec résolution
  de conflit par révision puis par le drapeau `force`
  (`considerPrimaryClaim`, `VtpAgent.ts:260-269`), propagée par gossip via
  le champ `primaryClaim` porté par chaque `summary` ultérieure une fois
  qu'un primaire est connu.
- **MD5 réel remplaçant le hash maison.** `hashPassword()` (`types.ts:56-59`)
  appelle `md5Hex()` (`src/crypto/hash/md5.ts`), confirmé par
  `vtp-md5-password.test.ts` (digest 32 hex, effet avalanche, authentification
  serveur/client de bout en bout).

### 1.3 Gap analysis — limites vérifiées (v2.0)

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Les champs du Summary Advertisement ne sont pas tous fidèles au format réel.** Le champ `updater` (`VtpFrame.updater`) porte l'**adresse MAC** du switch (`config.updaterMac`, alimentée par l'adresse système) alors qu'un vrai VTP Summary Advertisement porte dans son champ *Updater Identity* une **adresse IP** (typiquement celle de l'interface de gestion ou du plus petit VLAN actif). Il n'existe par ailleurs aucun champ *Update Timestamp* (horodatage de la dernière mise à jour, présent sur le fil réel) ni de compteur *Followers* annonçant combien de Subset Advertisements vont suivre — ici, `sendSummaryAndSubset` envoie toujours exactement un seul `subset` portant la totalité de la base VLAN, sans jamais fragmenter sur plusieurs trames même pour une base volumineuse. | Format Summary Advertisement réel (Updater Identity = IP, Update Timestamp, Followers count + fragmentation en plusieurs Subset Advertisements) | Moyenne (fidélité de champ, sans impact fonctionnel observable dans ce simulateur tant qu'aucune base ne dépasse la taille d'un seul Subset) |
| 2 | **La construction byte-exacte du condensé MD5 n'est pas vérifiée face au fil réel.** L'algorithme est désormais un vrai MD5 (résout l'item 5 de la v1.0), mais `hashPassword()` le calcule sur `${domain}|${password}` — une construction choisie pour ce simulateur, pas confirmée identique à l'agencement exact que Cisco transmet (domaine/révision/mot de passe combinés dans un ordre et un padding précis). Aucune suite de capture (`tcpdump`) dédiée à VTP n'existe encore pour vérifier cette fidélité au niveau trame, contrairement à ce qui existe déjà pour 802.1Q (`docs/PRD-802.1Q.md §1.2`). | Construction MD5 réelle sur le fil VTP | Faible (pertinent seulement si une fidélité de capture byte-exacte est visée) |
| 3 | **Propagation d'une base MST via VTP v3 — exclusion de la v1.0 désormais levée, jamais implémentée.** `VtpFrame`/`VtpVlanEntry` ne portent aucune notion d'instance MSTI ni de mapping VLAN↔instance ; rien dans `VtpAgent` ne distingue une base VLAN standard d'une base MST opaque. La v1.0 excluait ce point explicitement en attendant qu'un PRD dédié au moteur STP/MSTP existe et que MSTP soit réellement implémenté — les deux conditions sont maintenant réunies (`docs/PRD-STP.md`, MSTP réel dans `StpAgent`) — cf. §0.1. | VTP v3 « MST database » (type de base opaque dédié à la config MST) | Moyenne (nouvellement éligible, pas encore un gap « urgent » puisque l'exclusion vient tout juste de tomber) |
| 4 | **Propagation des associations Private VLAN — toujours bloquée, sans changement depuis la v1.0.** Confirmé par cet audit : aucune notion de Private VLAN n'existe nulle part dans le moteur VLAN actuel. Reste une dépendance externe réelle et non résolue vers `docs/PRD-VLAN.md` §2.1.2 (Phase 2a), pas un gap à corriger dans ce PRD tant que cette phase n'est pas livrée. | VTP v3 Private VLAN propagation | (dépendance externe non résolue, sans action possible ici) |
| 5 | **VTP n'a pas d'équivalent côté Huawei** — confirmé conforme à la réalité (VTP est propriétaire Cisco), pas un gap. Inchangé depuis la v1.0. | — | (positif, aucune action) |

---

## 2. Objectifs

### 2.1 Objectifs de cette v2.0 (remédiation proposée, non encore engagée)

1. **Fidélité des champs du Summary Advertisement (item 1).** Remplacer
   `updater: string` porteur d'une MAC par une véritable adresse IP
   (résolue depuis l'interface de gestion ou, à défaut, la plus petite VLAN
   SVI active du switch — cohérent avec le comportement Cisco réel) ; ajouter
   un champ *Update Timestamp* horodatant la dernière incrémentation de
   révision ; ajouter un compteur *Followers* dans le `summary` et fragmenter
   l'émission du `subset` en plusieurs trames numérotées dès que la base VLAN
   dépasse un seuil réaliste (à définir en conception détaillée, par exemple
   par lots de ~40 VLAN comme l'ordre de grandeur réel d'un Subset
   Advertisement) — testable même si la plupart des labs de ce simulateur
   ne dépasseront jamais un seul lot.
2. **Propagation d'une base MST via VTP v3 (item 3, objectif nouvellement
   débloqué).** Étendre `VtpFrame` d'un type de base alternatif (« MST
   database », distinct de la base VLAN standard, conformément à la
   sémantique v3 réelle où les deux bases voyagent indépendamment) portant
   la configuration de région MST (nom, révision, table
   instance→VLAN — la même structure que `MstRegion` déjà définie côté
   moteur STP, `docs/PRD-STP.md §4`) ; `VtpAgent` la synchronise entre
   switches du même domaine VTP exactement comme la base VLAN standard
   (comparaison de révision, application côté client), et `StpAgent`
   consomme le résultat pour mettre à jour sa propre `MstRegion` locale.
   Dépendance interne à ce PRD vers `docs/PRD-STP.md` (le champ nom/révision/
   table d'instances de `MstRegion` doit exister côté moteur STP, ce qui est
   déjà le cas — `docs/PRD-STP.md §4` documente le type actuel).
3. **Construction MD5 byte-exacte + suite de capture dédiée (item 2, reporté
   depuis la v1.0, toujours pertinent).** Vérifier/aligner la construction
   du condensé sur l'agencement réel des champs VTP (domaine, révision, mot
   de passe) et créer la suite de capture qui n'existe toujours pas
   (`tcpdump-vtp-frame-capture.test.ts`, sur le modèle de
   `tcpdump-byte-slice-vlan-filters.test.ts` côté 802.1Q).

### 2.2 Hors périmètre (explicitement exclu)

- Support Token Ring (VTP v2) — technologie obsolète, aucune pertinence
  pédagogique pour ce simulateur. Inchangé depuis la v1.0.
- **Propagation des associations Private VLAN** — dépendance externe réelle
  et non résolue vers `docs/PRD-VLAN.md` §2.1.2 (Phase 2a), cf. §1.3 item 4 ;
  tombera automatiquement dès que cette phase sera livrée, comme pour l'item
  MST de la v1.0.
- DTP (négociation dynamique de trunk) — déjà solide selon `GAP.md` §2.5,
  aucune action proposée dans ce PRD, mentionné uniquement comme dépendance
  amont non bloquante (§0.1).
- Toute extension Huawei de VTP — confirmé sans équivalent réel (§1.3 item
  5) ; ce PRD ne propose délibérément aucun développement Huawei ici.

---

## 3. Plan de remédiation détaillé

### Phase 1 — Fidélité des champs Summary Advertisement (item 2.1.1)

- **Fichiers touchés** : `types.ts` (`VtpFrame` : `updater` devient une
  adresse IP, nouveaux champs `updateTimestamp`, `followers`),
  `VtpAgent.ts` (`sendSummaryAndSubset` calcule et fragmente si nécessaire).
- **Non-régression** : le comportement observable côté application VLAN
  (le diff finit par être appliqué) ne doit pas changer pour toute base
  tenant dans un seul lot — cas de tous les tests existants aujourd'hui.
- **Tests** : extension de `vtp-protocol.test.ts` (champ `updater` au format
  IP, présence d'un timestamp), nouveau cas de fragmentation dans un fichier
  dédié si le volume de VLAN testé dépasse le seuil choisi.

### Phase 2 — Propagation de base MST via VTP v3 (item 2.1.2)

- **Fichiers touchés** : `types.ts` (nouveau type de base MST dans
  `VtpFrame` ou variante de message dédiée), `VtpAgent.ts` (synchronisation
  de la base MST en parallèle de la base VLAN standard), interface
  `VtpHost`/câblage `CiscoSwitch.ts` (accès à la `MstRegion` du `StpAgent`
  local pour lecture/écriture par VTP).
- **Tests** : nouveau fichier `vtp-v3-mst-database.test.ts` — deux switches
  en mode server/client, région MST configurée sur le server, vérifier que
  le client adopte la même région (nom/révision/table d'instances) après
  synchronisation VTP, sans reconfiguration manuelle.

### Phase 3 — MD5 byte-exact + capture dédiée (item 2.1.3)

- **Fichiers touchés** : `types.ts` (`hashPassword` aligné sur l'agencement
  réel des champs si un écart est confirmé en conception détaillée).
- **Tests** : nouveau fichier `tcpdump-vtp-frame-capture.test.ts`, pendant
  VTP de `tcpdump-byte-slice-vlan-filters.test.ts` côté 802.1Q.

---

## 4. Exigences de non-régression

Suite déjà verte à ne pas régresser (975 lignes, 5 fichiers) :
`vtp-protocol.test.ts`, `vtp-pruning.test.ts`, `vtp-v3-primary-server.test.ts`,
`vtp-md5-password.test.ts`, `vtp-config-change-sync.test.ts`, et par
ricochet `debug/cisco-l2/cisco-l2-03-trunk-dtp-vtp.debug.test.ts`. La Phase 1
(fidélité des champs) est indépendante des Phases 2 et 3. La Phase 2
(base MST) dépend du modèle `MstRegion` déjà défini par `docs/PRD-STP.md`
mais ne dépend d'aucune phase de ce dernier PRD n'étant pas encore livrée —
elle peut démarrer dès aujourd'hui. La Phase 3 reste indépendante des deux
autres.

---

## 5. Risques

- **Risque principal (Phase 1)** : changer le type du champ `updater` d'une
  MAC vers une IP peut casser tout test existant qui l'inspecte directement
  (`vtp-config-change-sync.test.ts` en particulier, qui exerce la
  synchronisation de près) — auditer ces assertions avant d'écrire le code
  de cette phase.
- **Risque secondaire (Phase 2)** : la synchronisation d'une base MST par
  VTP touche à la fois `VtpAgent` et `StpAgent` — deux moteurs déjà chacun
  bien testés séparément (975 lignes côté VTP, 17 fichiers côté STP selon
  `docs/PRD-STP.md §0`) ; toute suite de non-régression pour cette phase doit
  couvrir les deux côtés du câblage, pas seulement l'émission/réception VTP.
- **Risque de récurrence** : cette v2.0 elle-même deviendra périmée si de
  nouveaux commits ferment les items 1-3 sans mise à jour du document — le
  même phénomène qui a rendu la v1.0 obsolète en trois semaines. Revérifier
  l'état du code avant toute nouvelle itération de ce PRD plutôt que de
  supposer sa validité continue.
