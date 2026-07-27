# PRD — Refonte « bus interne + accès registre » (isolation inter-équipement)

## 0. Contexte et portée

Deux invariants d'architecture, déjà formulés et partiellement livrés avant
ce PRD (`refactor-frame-only.md`, racine du dépôt) :

1. **Trames uniquement.** Le seul moyen pour un équipement d'obtenir une
   information sur un autre équipement du réseau est l'échange de
   trames/paquets sur les câbles.
2. **Bus interne.** Le bus d'événements est interne à un équipement ; aucun
   équipement ne peut s'abonner aux événements d'un autre. Les observateurs
   hors-monde (Logger, UI, tests) observent via un tap d'observabilité, pas
   en étant des équipements.

Ce PRD **n'invente pas ces règles** — il reprend le chantier déjà ouvert
(deux commits déjà livrés : `ed7e27ba` pour l'invariant 2, `cb6a2161` pour
une première vague de conversions de l'invariant 1) et le termine, avec un
ajout explicite non couvert par le document d'origine : **un équipement ne
doit plus avoir accès au registre d'équipements** (`EquipmentRegistry`) du
tout — pas « la plupart du temps », de façon **structurellement empêchée**
(erreur de lint/compilation), pas seulement par discipline de code. L'audit
mené pour ce PRD montre que la stratégie « lister les fichiers fautifs et
les corriger un par un » du document d'origine n'a pas tenu dans la durée :
plusieurs violations nouvelles, non présentes dans sa liste, existent
aujourd'hui dans du code écrit après ce premier passage (notamment
`RouterOSPFIntegration.ts`, la plus étendue de toutes) — la preuve concrète
qu'sans garde-fou structurel, le god-mode revient.

### 0.1 Chaîne de dépendances

- **`refactor-frame-only.md`** (racine du dépôt) est le document parent
  direct de ce PRD : il définit les deux invariants, liste ce qui est
  « Fait », ce qui est « Déjà conforme », et ce qu'il reste à faire
  (« Reste »). Ce PRD reprend cette dernière liste, la complète avec les
  violations non répertoriées trouvées par cet audit, et ajoute l'exigence
  d'application structurelle (lint) qui n'y figurait pas.
- **`docs/PRD-Wecutil.md` §2.2** documente déjà, et exclut explicitement,
  le raccourci `EquipmentRegistry` utilisé par la découverte des
  collecteurs WEC (`WindowsPC.tryForwardMatchingEvent`,
  `WindowsPC.ts:3514-3528`) — hérité tel quel, non rouvert ici (cf. §2.2).
- **`refactor-frame-only.md` lui-même** signale que les scénarios Oracle RAC
  (`scenario-oracle-07/08`) et la suite de capture `scenario-07` échouaient
  déjà sur `origin` avant son propre passage, pour des raisons sans rapport
  avec ces deux invariants — non traité ici non plus (cf. §2.2).
- Ce PRD ne dépend d'aucun protocole particulier et n'en bloque aucun : il
  ne change aucune sémantique protocolaire, seulement la façon dont chaque
  moteur obtient une information sur un pair (trame réelle au lieu de
  lecture directe).

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/events/EventBus.ts` | `EventBus`, `ForwardingEventBus` (relais unidirectionnel local→bus observateur), `getDefaultEventBus()` (singleton bus **observateur**, à ne jamais consommer côté équipement) |
| `src/network/equipment/Equipment.ts:101-127` | Câblage correct de l'invariant 2 : `getBus()` renvoie un `ForwardingEventBus` propre à la machine (`machineBus`), lazy, avec relais unidirectionnel vers le bus global |
| `src/network/equipment/Equipment.ts:26-34` | **La fuite structurelle** : passthrough statique `@deprecated` (`getAllEquipment`/`getById`/`clearRegistry`) toujours présent, hérité par **toute** sous-classe d'`Equipment` — donc par tout device, sans le moindre import supplémentaire |
| `src/network/equipment/EquipmentRegistry.ts` | Registre injectable : `getById`, `getAll`, `getByType`, `getPoweredOn`, et surtout `query(predicate)` — un accès god-mode encore plus large, sur n'importe quel prédicat |
| `eslint.config.js` | Flat config ESLint — **aucune règle** ne restreint aujourd'hui l'import d'`EquipmentRegistry` depuis du code équipement/protocole |
| `refactor-frame-only.md` | Audit d'origine : ce qui est fait, déjà conforme, et sa propre liste « Reste » |

**Éléments déjà convertis (« Fait »)**, vérifiés toujours valides par cet
audit : ARP/ICMP (`sendPingProbeSync`), TCP (`tcpv2`), DNS (UDP/53),
WinRM/HTTP, RADIUS, DHCP (DISCOVER broadcast), snooping DHCP par relais de
trames plutôt que par abonnement `dhcp.pool.*` cross-machine.

**Éléments de la liste « Reste » de `refactor-frame-only.md`, confirmés
toujours ouverts par cet audit** :

| Fichier | Constat |
|---|---|
| `src/network/devices/linux/network/HostLookup.ts` | `findHostByAddress`/`findReachableHost`/`isPathReachable` scannent `EquipmentRegistry.getInstance().getAll()` (lignes 26,55,76,123,146,225,232,268,307,316) pour les clients ssh/scp/telnet |
| `src/network/devices/linux/commands/net/Traceroute.ts` | Scan MTU global et scan ACL des routeurs de transit via `EquipmentRegistry` (lignes 240-245, 411-412) |
| `src/network/devices/linux/network/CaptureRouter.ts` | `portOwner`/`findHostByIp` (lignes 29,46,85) résolvent équipement/câble directement depuis le registre pour la capture `tcpdump` |
| `src/network/ipsec/IPSecEngine.ts:3814-3830` | `findRouterByIP`/`findEquipmentByIP` — scan complet du registre pour résoudre un pair IKE |

**Violations non répertoriées par le document d'origine, trouvées par cet
audit** (donc introduites — ou manquées — après son premier passage) :

| Fichier | Constat |
|---|---|
| `src/network/devices/router/RouterOSPFIntegration.ts` | 9 sites confirmés (lignes 685, 790, 821, 1175, 1211, 1257, 1548, 1604, 1635) : `Equipment.getById(remoteId)` puis `remoteEquip.getPorts()` pour découvrir, à travers un switch/hub, quels autres routeurs partagent un segment L2 — **la violation la plus étendue trouvée** |
| `src/network/devices/EndHost.ts:1108-1113` | Relais DHCP `ip helper-address` : scan complet du registre par IP pour trouver le routeur helper, au lieu d'une trame unicast réelle via le chemin de forwarding L3 déjà existant |
| `src/network/devices/router/NATEngine.ts:194` | Violation de l'**invariant 2** (pas 1) : `getBus()` vaut `this.busOverride ?? getDefaultEventBus()` — `busOverride` n'est jamais renseigné par le routeur propriétaire (`Router.ts` propage bien son bus à `ipsecEngine`, `Router.ts:440-445`, mais jamais à `natEngine`). Ses acteurs (`NATSignalRefreshActor`, `NATCaptureActor`) tournent donc en production sur le bus global brut, et ne s'en sortent qu'en filtrant manuellement par un prédicat `isOurs` sur le `deviceId` — inoffensif tant que chaque filtre est écrit correctement, mais ce n'est plus une garantie architecturale, c'est une discipline de code. 21 fichiers du moteur réseau utilisent ce même motif de prédicat `isOurs`, ce qui en fait un point d'audit systématique, pas un cas isolé |

**Exceptions déjà documentées ailleurs, non remises en cause ici** :
`WindowsPC.tryForwardMatchingEvent` (découverte des collecteurs WEC,
`docs/PRD-Wecutil.md §2.2`) ; `src/network/devices/inspection/` (
`EquipmentStateView`/`DeviceStateView`, outillage de debug/tests
délibérément omniscient) ; la couche UI/store/terminal
(`src/react/hooks/*`, `src/store/networkStore.ts`,
`src/terminal/commands/database.ts`) qui correspond exactement au « monde
extérieur (UI, factory, tests) » que la règle de conception d'origine
autorise explicitement à consommer `EquipmentRegistry`.

### 1.2 Constats-clés

1. **La fuite structurelle rend toute correction fragile.**
   `Equipment.getAllEquipment()`/`getById()`/`clearRegistry()`
   (`Equipment.ts:26-34`) sont marquées `@deprecated` mais toujours
   présentes et héritées par chaque sous-classe — un nouveau protocole
   (comme `RouterOSPFIntegration.ts`, manifestement écrit après le premier
   passage de `refactor-frame-only.md`) peut réintroduire le god-mode sans
   même importer `EquipmentRegistry`. Aucune règle de lint ne l'empêche
   (`eslint.config.js` ne contient aucune restriction d'import). C'est la
   preuve que corriger une liste de fichiers, sans fermer le point d'accès
   lui-même, ne suffit pas dans la durée.
2. **OSPF contourne entièrement la découverte de voisinage par trame à
   travers un switch.** `RouterOSPFIntegration.ts` marche directement le
   graphe d'équipements (`Equipment.getById` + `getPorts()`) pour trouver
   quels routeurs partagent un segment L2 via un switch/hub, au lieu de
   compter sur l'inondation multicast Hello (224.0.0.5) que le switch sait
   déjà faire pour d'autres protocoles (ARP, déjà conforme selon le
   document d'origine). 9 sites confirmés — la violation la plus étendue
   trouvée par cet audit, absente de la liste de `refactor-frame-only.md`.
3. **Le relais DHCP `ip helper-address` scanne le registre par IP** au lieu
   d'envoyer une trame unicast réelle (`EndHost.ts:1108-1113`) — distinct
   du repli déjà accepté « fixture jamais câblée » situé quelques lignes
   plus bas dans le même fichier (`EndHost.ts:1129-1135`, gardé par
   `hasCabledInterface`), qui lui reste une exception légitime documentée.
4. **`NATEngine` est une régression confirmée de l'invariant « bus
   interne »**, pas seulement de l'invariant « trames uniquement » :
   `Router.setEventBus()` propage bien son bus à `ipsecEngine`
   (`Router.ts:440-445`) mais jamais à `natEngine`, qui reste connecté en
   permanence au bus global brut en production. Ses événements
   (`nat.session.created`, `nat.translation.applied`, …) circulent sur le
   bus partagé par tous les routeurs, filtrés seulement par un prédicat
   `isOurs` — une discipline de code, pas une isolation garantie par
   construction. Le même motif (`isOurs` sur un bus potentiellement
   partagé) apparaît dans 21 fichiers, ce qui en fait un point d'audit à
   traiter systématiquement plutôt qu'au cas par cas.
5. **IPSec, ssh/scp/telnet, traceroute et tcpdump restent god-mode**,
   exactement comme déjà documenté dans `refactor-frame-only.md` — aucune
   régression nouvelle sur ces quatre-là, mais aucun progrès non plus
   depuis l'écriture du document.
6. **Le registre expose une méthode `query(predicate)` arbitraire**
   (`EquipmentRegistry.ts:125-127`), un accès god-mode encore plus large
   qu'un simple `getById`/`getAll` — n'importe quel prédicat sur
   n'importe quel champ de n'importe quel équipement. Aucun appelant
   équipement ne l'utilise aujourd'hui, mais elle reste tout aussi
   accessible que `getAll()`/`getById()` tant que le point d'entrée
   `EquipmentRegistry` n'est pas structurellement fermé au code équipement.

## 2. Objectifs

Chaque phase est indépendamment testable.

### 2.1 Objectifs (priorité décroissante)

- **P1 — Fermer l'accès au registre, structurellement.** Supprimer
  `Equipment.getAllEquipment()`/`getById()`/`clearRegistry()`
  (`Equipment.ts:26-34`) — leur suppression fait échouer la compilation de
  tout appelant restant, ce qui sert de filet de sécurité pour les phases
  suivantes. Ajouter une règle `no-restricted-imports` dans
  `eslint.config.js`, scopée par `files`/`ignores`, qui interdit
  l'import de `@/network/equipment/EquipmentRegistry` partout sous
  `src/network/**` sauf `src/network/equipment/**` et
  `src/network/devices/inspection/**`. C'est la réponse directe et
  prioritaire à l'exigence : un équipement ne doit plus pouvoir accéder au
  registre, ni aujourd'hui ni demain par inadvertance.
- **P2 — Fiabiliser l'invariant « bus interne ».** Corriger le câblage
  confirmé cassé de `NATEngine` (`Router.setEventBus()` doit aussi
  appeler `natEngine.setEventBus(this.getBus())`, au même endroit que
  `ipsecEngine`), puis auditer systématiquement les ~20 autres fichiers
  utilisant le motif de prédicat `isOurs` pour vérifier qu'aucun autre
  moteur ne tourne, en production, sur le bus global brut faute d'avoir
  reçu le bus de son équipement propriétaire.
- **P3 — Découverte de voisinage OSPF par trame réelle.** Remplacer les 9
  sites de marche directe du registre dans `RouterOSPFIntegration.ts` par
  une véritable inondation multicast Hello à travers le chemin de flood
  L2 déjà existant (utilisé par ARP) — un routeur apprend ses voisins
  uniquement des trames Hello qu'il reçoit réellement, plus jamais d'un
  parcours direct du graphe d'équipements. La conversion la plus
  volumineuse et la plus risquée de ce PRD (cf. §5, §7).
- **P4 — Résolution de pair IPSec par trame réelle.** Remplacer
  `findRouterByIP`/`findEquipmentByIP` (`IPSecEngine.ts:3814-3830`) par
  une négociation IKE réelle sur UDP/500 — objectif déjà énoncé par
  `refactor-frame-only.md`, resté non converti.
- **P5 — Relais DHCP `ip helper-address` par trame réelle.** Remplacer le
  scan par IP (`EndHost.ts:1108-1113`) par un envoi unicast réel à travers
  le chemin de forwarding L3 déjà existant.
- **P6 — Résolution de cible ssh/scp/telnet par connexion réelle.**
  Remplacer les scans de `HostLookup.ts` par de vraies tentatives de
  connexion TCP sur la cible.
- **P7 — Traceroute par signal réel.** Remplacer le scan MTU global et le
  scan de l'ACL des routeurs de transit (`Traceroute.ts:240-245,411-412`)
  par du PMTUD réel (ICMP « fragmentation needed ») et par l'évaluation
  d'ACL au moment du forwarding déjà présente sur chaque routeur, plutôt
  qu'une lecture directe de la configuration d'un routeur distant.
- **P8 — Capture `tcpdump` par tap d'observation.** Remplacer les
  résolutions directes de `CaptureRouter.ts` (`portOwner`/`findHostByIp`,
  lignes 29,46,85) par un abonnement à un tap d'observabilité au niveau
  fil, cohérent avec le rôle d'« observateur hors-monde » déjà défini pour
  Logger/UI par l'invariant 2 — exactement la suggestion déjà présente
  dans `refactor-frame-only.md` (« à déplacer côté observateur si tap »).

### 2.2 Non-objectifs (explicitement exclus)

- **Découverte des collecteurs WEC par scan `EquipmentRegistry`**
  (`WindowsPC.tryForwardMatchingEvent`) — déjà décidée et documentée dans
  `docs/PRD-Wecutil.md §2.2` ; héritée, pas rouverte.
- **`src/network/devices/inspection/` (`EquipmentStateView`/
  `DeviceStateView`)** — outillage de debug/tests délibérément omniscient
  par conception (CLAUDE.md le décrit explicitement ainsi) ; la règle de
  lint de P1 doit l'autoriser, pas le casser.
- **Couche UI/store/terminal** (`src/react/hooks/*`,
  `src/store/networkStore.ts`, `src/terminal/commands/database.ts`,
  `DeviceFactory`) — c'est précisément le « monde extérieur » que la règle
  de conception d'origine autorise à consommer `EquipmentRegistry` ; non
  touché par ce PRD.
- **Échecs pré-existants Oracle RAC/Data Guard** (`scenario-oracle-07/08`)
  et capture (`scenario-07`) — déjà documentés comme cassés sur `origin`
  avant même le premier passage de `refactor-frame-only.md`, sans rapport
  avec ces deux invariants.
- **Réécriture d'`EventBus`/`ForwardingEventBus` eux-mêmes** — déjà corrects
  selon l'audit (section « Fait » de `refactor-frame-only.md`, confirmée
  par cette relecture) ; ce PRD ferme le reste de l'invariant 1 et corrige
  une régression ponctuelle de l'invariant 2, il ne touche pas au
  mécanisme du bus lui-même.
- **Redesign sémantique des ~20 acteurs au motif `isOurs`** — P2 vérifie et
  corrige le câblage du bus, il ne revisite pas la logique métier de
  chaque acteur.

## 3. Architecture cible

**P1.** Suppression pure de `Equipment.ts:26-34`. Tout appelant restant
doit alors importer explicitement `EquipmentRegistry` — ce qui le rend
visible et, pour tout fichier hors de la liste blanche, bloqué par une
nouvelle entrée dans le tableau `tseslint.config(...)` d'`eslint.config.js` :

```js
{
  files: ["src/network/**/*.ts"],
  ignores: ["src/network/equipment/**", "src/network/devices/inspection/**"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [{
        name: "@/network/equipment/EquipmentRegistry",
        message: "Un équipement ne doit pas lire l'état d'un autre équipement " +
          "directement — échange de trames uniquement (refactor-frame-only.md).",
      }],
    }],
  },
},
```

**P2.** `Router.setEventBus()` (`Router.ts:440-445`) gagne une ligne
`this.natEngine.setEventBus(this.getBus());` au même endroit que
`ipsecEngine`. L'audit des ~20 autres fichiers au motif `isOurs` suit le
même protocole de vérification : pour chaque acteur, remonter jusqu'à la
classe `Equipment` propriétaire et confirmer que son constructeur (ou un
appel `setEventBus` équivalent) reçoit bien `() => this.getBus()` — et non
un défaut jamais écrasé vers `getDefaultEventBus()`.

**P3.** Le port d'un routeur envoie sa trame Hello OSPF (multicast
224.0.0.5, sur le même modèle d'adressage multicast déjà utilisé par
d'autres protocoles du moteur) comme une trame réelle ; le switch/hub
intermédiaire la relaie par son chemin de flood L2 déjà existant (celui
qui sert déjà à ARP). `RouterOSPFIntegration` apprend l'existence d'un
voisin exclusivement en recevant une Hello sur un port, jamais en
consultant `Equipment.getById`. La table de voisinage devient purement
réactive à la réception de trame, comme le reste du moteur OSPF l'est déjà
pour les liens point-à-point directs.

**P4-P8.** Chacun réutilise un mécanisme de transport déjà réel et déjà
présent ailleurs dans le moteur plutôt que d'en inventer un nouveau : IKE
sur UDP/500 (le moteur UDP existe déjà, cf. DHCP/DNS), connexion TCP réelle
(déjà utilisée par `sendPingProbeSync`/tcpv2), ICMP « fragmentation
needed » (le moteur ICMP existe déjà), évaluation d'ACL au moment du
forwarding (chaque routeur a déjà son propre moteur ACL), et un tap
d'observabilité au niveau fil pour la capture (le même principe que celui
déjà utilisé pour le Logger/l'UI par l'invariant 2).

## 4. Modèle de données

Ce PRD est essentiellement un refactor de câblage et de graphe d'appel —
il ne introduit pas de nouveau modèle de données protocolaire. Seule
nouveauté structurelle : la règle de lint de P1 (ci-dessus, §3), qui vit
dans `eslint.config.js` et non dans le code applicatif.

## 5. Plan de mise en œuvre

1. **P1** en premier — la suppression du passthrough statique fait
   échouer la compilation partout où une violation subsiste encore, ce qui
   sert de checklist automatique pour vérifier qu'aucune n'a été oubliée
   avant de passer à la suite. Si une conversion complète en un seul lot
   n'est pas réalisable, garder les méthodes présentes mais déjà bloquées
   par le lint le temps de convertir les appelants restants, et ne les
   supprimer pour de vrai qu'une fois zéro appelant restant.
2. **P2** — correctif de câblage isolé (`natEngine`) puis audit des ~20
   fichiers ; faible risque, aucune sémantique protocolaire ne change.
3. **P5, P6, P7, P8** — conversions à un seul sous-système chacune,
   risque contenu.
4. **P4** (IPSec) — risque modéré, un seul moteur concerné.
5. **P3** (OSPF) en dernier — la conversion la plus étendue (9 sites) et
   la plus risquée en termes de régression sur la suite de tests OSPF
   existante ; à isoler avec son propre passage de non-régression complet
   avant de considérer le PRD terminé.

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète de la suite de tests concernée avant de passer à la suivante.

## 6. Stratégie de test

Technique de test spécifique à ce PRD, appliquée à chaque phase P3-P8 :
après construction de la topologie, **vider ou faire échouer
`EquipmentRegistry`** (`EquipmentRegistry.resetInstance()` puis reconstruire
un registre vide, ou monkey-patcher `getAll`/`getById` pour lever une
exception) et vérifier que le comportement précédemment dépendant du
registre (adjacence OSPF, résolution de pair IPSec, relais DHCP, connexion
ssh, traceroute, capture tcpdump) fonctionne toujours correctement — la
preuve directe que la conversion ne dépend plus du registre, pas seulement
une relecture de code.

- `equipment-registry-import-boundary.test.ts` (P1) : vérifie que la règle
  ESLint rejette effectivement un import d'`EquipmentRegistry` depuis un
  fichier de test placé sous un chemin `src/network/<protocole>/` fictif,
  et l'accepte depuis `src/network/equipment/`/`devices/inspection/`.
- `nat-engine-own-bus.test.ts` (P2) : deux routeurs avec NAT configuré,
  vérifie qu'aucun événement `nat.*` publié par le routeur A n'est jamais
  délivré à un abonné construit sur le bus du routeur B (pas seulement
  filtré par prédicat — jamais délivré du tout, par construction).
- `ospf-cross-switch-frame-only.test.ts` (P3) : deux routeurs reliés par un
  switch, adjacence OSPF vérifiée à la fois par l'état `Full` habituel et
  par la technique « registre vidé après construction » ci-dessus.
- Suites équivalentes pour P4 (IPSec), P5 (DHCP relay), P6 (ssh/scp/
  telnet), P7 (traceroute), P8 (capture).
- **Non-régression obligatoire** après chaque phase sur les suites
  existantes du sous-système touché (OSPF, IPSec, DHCP, SSH, traceroute,
  tcpdump/capture, NAT) — aucune n'est listée exhaustivement ici vu leur
  nombre, mais aucune ne doit changer de comportement observable.

## 7. Risques et points d'attention

- **P3 (OSPF) est le changement à plus haut risque** — la suite de tests
  OSPF existante est large ; utiliser la technique « registre vidé » en
  premier, avant même de toucher au code de traversée, pour avoir un
  filet de sécurité automatisé dès le début de cette phase plutôt qu'à la
  fin.
- **P1 ne peut pas rester à moitié fait** : une fois le passthrough statique
  supprimé pour de vrai, toute violation oubliée casse la compilation — ce
  qui est le but, mais impose que P3-P8 soient traités dans la même
  fenêtre de travail que la suppression définitive, pas éparpillés dans le
  temps avec un état intermédiaire cassé.
- **Ne pas confondre les exceptions déjà actées (WEC, inspection, UI/
  store/terminal, échecs Oracle RAC pré-existants) avec de nouvelles
  violations** — §2.2 les liste explicitement pour éviter qu'elles soient
  redécouvertes sans contexte et re-corrigées par erreur.
- **P2 (audit des ~20 fichiers `isOurs`)** : rester sur la vérification du
  câblage du bus, ne pas dériver vers une refonte de la logique métier de
  chaque acteur — ce serait un chantier séparé, hors périmètre ici.
- **Cohérence avec les PRD protocolaires existants** : aucun des PRD déjà
  écrits dans cette série (SMTP, Exchange, Repadmin, Auditpol, STP, …) ne
  documente de dépendance à un accès direct au registre depuis un moteur
  protocolaire — ce PRD ne devrait donc entrer en conflit avec aucun
  d'eux ; à vérifier ponctuellement si l'un d'eux venait à en introduire un
  par la suite.

## 8. Critères d'acceptation

- `Equipment.getAllEquipment()`/`getById()`/`clearRegistry()` n'existent
  plus ; importer `EquipmentRegistry` depuis n'importe quel fichier sous
  `src/network/**` autre que `src/network/equipment/**` ou
  `src/network/devices/inspection/**` échoue au lint.
- `natEngine` (et chacun des ~20 sous-systèmes audités au motif `isOurs`)
  publie/s'abonne exclusivement sur le `ForwardingEventBus` de son
  équipement propriétaire en câblage de production — jamais le bus global
  brut.
- Deux routeurs reliés par un switch forment une adjacence OSPF `Full`
  purement à partir de trames Hello échangées, y compris quand
  `EquipmentRegistry` est vidé après construction de la topologie.
- Une négociation IPSec entre deux routeurs résout son pair par un
  échange IKE réel sur UDP/500, plus par un scan du registre.
- Un relais DHCP `ip helper-address` délivre la requête par une trame
  unicast réelle à travers le forwarding L3 normal.
- Une connexion ssh/scp/telnet résout sa cible par une tentative de
  connexion TCP réelle, plus par une lecture directe du registre.
- Traceroute dérive son comportement MTU/ACL de signaux réels (ICMP
  fragmentation-needed, évaluation d'ACL au moment du forwarding), plus
  d'une lecture directe de la configuration d'un routeur distant.
- La capture `tcpdump` source ses paquets depuis un tap d'observation,
  plus depuis des parcours directs de câbles/registre.
- L'ensemble des suites de tests existantes (OSPF, IPSec, DHCP, SSH,
  traceroute, tcpdump/capture, NAT) passe sans modification de ses
  assertions à l'issue de toutes les phases.
