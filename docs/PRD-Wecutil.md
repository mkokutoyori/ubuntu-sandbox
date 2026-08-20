# PRD — Windows Event Collector en ligne de commande : `wecutil.exe` et la collecte centralisée d'événements (WEF/WEC)

**Version** : 1.0
**Date** : 2026-07-25
**Projet** : Ubuntu Sandbox — Module Windows Server / Active Directory / Journalisation
**Auteur** : Claude Code
**Références normatives** : documentation Microsoft de `wecutil.exe` et du
service Windows Event Collector (Wecsvc), schéma XML des abonnements
(`http://schemas.microsoft.com/2006/03/windows/events/subscription`),
[MS-WSMV]/[MS-EVEN6] pour le transport WS-Management sous-jacent —
simplifié dans ce dépôt comme le reste du remoting WinRM l'est déjà
(§ 0.2). Ce PRD est **greenfield** : aucune des primitives `wecutil`/
`Wecsvc`/`ForwardedEvents`-en-tant-que-cible-de-collecte n'existe
aujourd'hui dans ce dépôt (recherche exhaustive, § 1.1) — contrairement
à `PRD-Netdom.md`, qui complétait un outil partiellement livré.

---

## 0. Contexte et portée du document

Le Windows Event Forwarding (WEF), porté par le service Windows Event
Collector (Wecsvc) et son outil `wecutil.exe`, est le mécanisme standard
de collecte centralisée des journaux d'événements dans un domaine Active
Directory — la brique qui alimente en pratique tout SIEM/SOC sur un
parc Windows sans agent tiers. Un scénario de formation AD qui couvre
l'audit de sécurité (déjà largement livré dans ce dépôt : EventID 4624/
4625/4720/4688/4769, `Get-WinEvent`, `Get-EventLog`, GPO d'audit) mais
pas la collecte centralisée laisse un angle mort réaliste : dans une
vraie infrastructure, un analyste ne consulte quasiment jamais les
journaux poste par poste, il consulte `ForwardedEvents` sur le
collecteur.

Ce dépôt a déjà toute la plomberie dont WEF a besoin pour ne pas être
réinventée : un modèle de journaux d'événements réel et déjà riche
(`PSEventLogProvider`, avec un journal `ForwardedEvents` déjà **seedé
vide** — § 1.1), un service `WinRM` déjà réel et déjà câblé sur le port
TCP 5985 avec négociation + authentification réelles
(`WinRmServerHandler`), un catalogue de services Windows déjà réel
(`WindowsServiceManager`), et un groupe AD "Event Log Readers" déjà
connu comme SID bien connu côté groupes locaux (mais **pas** encore côté
annuaire AD, § 1.2). Ce PRD branche `wecutil`/Wecsvc sur ces briques —
il n'invente que ce qui manque réellement : le parsing d'abonnement, le
registre d'abonnements d'un collecteur, et le mécanisme de push réseau
réel source→collecteur.

### 0.1 Chaîne de dépendances

```
PSEventLogProvider (livré : journaux, ForwardedEvents déjà seedé vide,
  writeEventLog(), Get-WinEvent déjà réel) / WindowsServiceManager
  (livré : catalogue de services, addService()) / WinRmServerHandler
  (livré : connexion TCP/5985 réelle, negotiate + auth réels) /
  DirectoryStore (livré : addGroupMember() générique, comptes ordinateur
  réels avec sam "<Nom>$") / EquipmentRegistry (livré : découverte des
  équipements du process, précédent déjà utilisé par WinRM/DNS/ARP)
        │
WindowsSecurityAudit (livré : génère déjà les EventID 4624/4625/4720/
  4688 réels via writeEventLog() — précédent exact pour "un événement
  générateur existe déjà, il manque juste le relais")
        ▼
PRD-Wecutil.md                                             ◄── VOUS ÊTES ICI
   P1 Wecsvc + wecutil qc · P2 groupe AD Event Log Readers ·
   P3 abonnements (wecutil cs/gs/ds/es/rs/ss) · P4 push réel + MachineName
        ▼
(aucun consommateur PRD identifié — wecutil est un outil terminal,
comme repadmin/auditpol/netdom le sont déjà dans ce dépôt)
```

Aucune dépendance bloquante : tout le code consommé est déjà en
production.

### 0.2 Ce que ce PRD réutilise sans le dupliquer

| Besoin `wecutil`/WEF | Brique déjà livrée réutilisée | Fichier |
|---|---|---|
| Journal `ForwardedEvents` (stockage, format, `Get-WinEvent`) | `PSEventLogProvider` (le journal existe déjà, vide, prêt à recevoir des entrées) | `src/network/devices/windows/PSEventLogProvider.ts:150-153` |
| Génération des événements source (4624/4625/4720/4688…) | `WindowsSecurityAudit`/`writeEventLog()` — déjà réel, déclenché par `runas`, logon, etc. | `src/network/devices/windows/WindowsSecurityAudit.ts`, `WindowsPC.ts` |
| Catalogue de services Windows (`Set-Service`/`Get-Service`/`Start-Service` génériques) | `WindowsServiceManager` — précédent exact : `WinRM`/`sshd` déjà enregistrés comme services nommés Manual/Stopped par défaut | `src/network/devices/windows/WindowsServiceManager.ts:270-299` |
| Connexion réseau réelle vers le collecteur (port 5985, négociation + authentification) | `WinRmServerHandler`/`getWinRmServerHandler()` — déjà un vrai `TcpConnection`, déjà négocie et authentifie | `src/network/devices/windows/server/winrm/WinRmServer.ts`, `WindowsPC.ts:519-528,819-821` |
| Résolution "quel compte ordinateur/quelle IP pour quelle machine" | `EquipmentRegistry`/`HostLookup` (précédent déjà utilisé par ARP/DNS/WinRM/netdom) | `src/network/equipment/EquipmentRegistry.ts` |
| Ajout d'un membre à un groupe AD par `sAMAccountName` (y compris compte ordinateur `NOM$`) | `DirectoryStore.addGroupMember()` — déjà générique, déjà utilisé pour `Domain Computers` à la jonction | `src/network/devices/windows/server/ad/DirectoryStore.ts:1126-1145` |
| Parsing XML minimal à schéma fixe | Même approche regex-récursive que le cast PowerShell `[xml]` déjà livré — précédent stylistique, pas de code partagé (portée différente, § 1.3) | `src/powershell/runtime/PSRuntime.ts:2469-2499` |
| GPO de forwarding (`New-GPO`/`Set-GPRegistryValue`/`New-GPLink`) | Cmdlets GPO déjà génériques — aucune extension nécessaire, § 1.1 | `GroupPolicyCmdlets.ts` (existant) |

Ce PRD n'ajoute de nouvelle plomberie que là où § 1.2 identifie un vrai
trou : le groupe AD "Event Log Readers", le registre d'abonnements d'un
collecteur, le parsing du XML d'abonnement, et le relais réseau réel
d'un événement source vers `ForwardedEvents`.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `PSEventLogProvider.ts:150-153` | Journal `ForwardedEvents` | Déjà seedé (vide) dans le constructeur — **jamais populé**, aucun code n'y écrit |
| `PSEventLogProvider.ts:230-239` (`GetWinEventCmdlet`) | `Get-WinEvent` | Réel, déjà supporte `-LogName`/`-FilterHashtable`/`-MaxEvents` — mais l'objet retourné n'a **aucune propriété `MachineName`** (absente de la projection ligne 230-239), alors que .NET expose toujours cette propriété sur un `EventLogRecord` |
| `WindowsServiceManager.ts` (constructeur privé, ~ligne 200-311) | Catalogue de services | Aucune entrée `Wecsvc` — recherche exhaustive (`Wecsvc`, `wecutil`) : zéro résultat dans tout `src/network` et `src/powershell` |
| `WindowsPC.ts` (switch `executeCmdCommand`) | Dispatch des commandes `cmd` | Aucun `case 'wecutil'` — `wecutil` n'est reconnu nulle part, tombe sur le message générique "not recognized" |
| `WinRmServer.ts:27-57` (`WinRmServerHandler`) | Serveur WinRM (port 5985) | Réel pour `negotiate`/`auth` — aucun op de type "push d'événement" ; conçu pour être étendu (même style que `SshServerHandler`/`SmbServerHandler`, cf. commentaire d'en-tête) |
| `DirectoryStore.ts:291-297` (`seedDefaults`) | Groupes AD seedés au provisioning | `Domain Admins`/`Domain Users`/`Domain Computers` seedés — **"Event Log Readers" absent** ; `WindowsUserManager.ts:61,225-227` le seed bien mais comme **groupe local** (SID S-1-5-32-573), pas comme groupe AD — les deux registres sont indépendants, `Add-ADGroupMember` ne consulte que `DirectoryStore` |
| `DirectoryStore.ts:1126-1145` (`addGroupMember`/`findGroupMemberEntry`) | Résolution de membre par sam | Générique, résout déjà les comptes ordinateur (`NOM$`, précédent `Domain Computers` à la jonction) — fonctionnerait immédiatement pour `SRV-SIEM$` une fois le groupe "Event Log Readers" seedé |
| `GroupPolicyCmdlets.ts` (existant, non lu en détail dans ce PRD) | `New-GPO`/`Set-GPRegistryValue`/`New-GPLink` | Déjà génériques (acceptent n'importe quelle clé de registre/valeur) — **confirmé suffisant sans modification** pour les 3 tests de `scenario-ad-event-forwarding-wef.test.ts` qui ne vérifient que l'absence de "not recognized", pas d'effet observable sur un client (§ 2.2) |
| `scenario-ad-event-forwarding-wef.test.ts` | Scénario cible | 5 tests actifs, tous en échec aujourd'hui (confirmé par régression complète, run du 2026-07-25) : `wecutil qc`, `Set-Service Wecsvc`, `Add-ADGroupMember "Event Log Readers"`, `wecutil cs`/`gs`, `Get-WinEvent ForwardedEvents` avec `MachineName` |
| `src/powershell/runtime/PSRuntime.ts:2472-2499` | Parseur XML du cast `[xml]` PowerShell | Précédent stylistique réutilisable (regex récursif à balises, pas de DOM complet) — portée différente (objet PS générique vs schéma d'abonnement fixe), donc pas partagé tel quel, juste imité |

### 1.2 Constats-clés

1. **`wecutil` est intégralement absent** — aucun point d'entrée `cmd`,
   aucun service `Wecsvc`, aucun registre d'abonnement. Contrairement à
   `netdom`, ce n'est pas une extension d'un routeur existant : le
   `case 'wecutil'` lui-même est à créer dans le switch de
   `WindowsPC.executeCmdCommand`.
2. **La moitié du besoin est déjà réelle et n'a besoin que d'un nouveau
   point d'entrée** : le journal `ForwardedEvents` existe déjà (vide),
   `Get-WinEvent` sait déjà le lire, `Set-Service`/`Get-Service`/
   `Start-Service` fonctionnent déjà génériquement dès qu'un service est
   catalogué, `DirectoryStore.addGroupMember` résoutrait déjà
   `SRV-SIEM$` s'il existait un groupe "Event Log Readers" côté AD.
3. **Un vrai trou de fond, à ne pas contourner en facade** : rien
   aujourd'hui ne fait transiter un événement d'une machine source vers
   le journal `ForwardedEvents` d'un collecteur — c'est le cœur
   fonctionnel de WEF, et le mandat du projet est explicite (aucune
   fausse façade) : ce PRD doit faire réellement transiter l'événement
   sur une connexion TCP réelle (réutilisant `WinRmServerHandler`,
   § 0.2), pas simplement copier l'entrée en mémoire d'un provider à
   l'autre.
4. **`Get-WinEvent` ne projette pas `MachineName`** — même pour les
   journaux locaux (`System`/`Application`/`Security`), un vrai
   `Get-WinEvent` expose toujours cette propriété (la machine locale
   pour un journal local, la machine source pour `ForwardedEvents`) ;
   c'est un oubli isolé et généralisable, pas spécifique à WEF (§ 2.1
   P4 le corrige pour tous les journaux, pas seulement `ForwardedEvents`).
5. **Le test de bout en bout ne passe jamais par une application GPO
   explicite côté client** (relu intégralement, § 1.1 dernière ligne) —
   le bloc de tests GPO et le bloc de tests d'abonnement/forwarding
   utilisent chacun leur propre `buildLan()` frais, sans état partagé ;
   aucun `gpupdate`/redémarrage de `WinRM` côté client n'est exercé
   avant la génération de l'événement. Le déclenchement du relais (P4)
   ne doit donc **pas** dépendre d'une application de stratégie de
   groupe simulée de bout en bout — ce serait un chantier disproportionné
   (GPO push → registre client → lecture par un agent de forwarding
   local) sans test qui l'exige réellement. § 2.2 documente ce choix
   comme une simplification assumée, pas un raccourci silencieux.
6. **Convention de nommage des comptes ordinateur déjà établie** :
   `sAMAccountName` = `"<NomMachine>$"` (précédent `Domain Computers`,
   § 0.2) — le PRD suit strictement la même convention pour résoudre
   "SRV-SIEM" (machine) ↔ "SRV-SIEM$" (compte AD) partout où c'est
   pertinent (P2, P4).

### 1.3 Précédents architecturaux exacts (grounding)

**Enregistrement d'un service nommé** (précédent exact pour P1) :
`WindowsServiceManager`'s `svc('WinRM', ...)`/`svc('sshd', ...)`
(`WindowsServiceManager.ts:270-299`) — services seedés statiquement dans
le catalogue, `startType: 'Manual', state: 'Stopped'` par défaut,
consommés génériquement par `Set-Service`/`Get-Service`/`Start-Service`
sans code spécifique à chaque service. `Wecsvc` suit exactement ce
patron ; `wecutil qc` est l'équivalent CLI de
`Set-Service -StartupType Automatic; Start-Service` déjà exercé
génériquement par le test P1 lui-même (bloc "Set-Service Wecsvc").

**Connexion réseau réelle authentifiée, échange applicatif ensuite géré
en mémoire** (précédent exact pour P4, même limite assumée que le
remoting WinRM lui-même, documentée dans l'en-tête de
`WinRmServer.ts:7-15`) : `WinRmServerHandler.register()` établit une
vraie session TCP (port 5985), négocie et authentifie réellement, puis
l'échange applicatif qui suit (aujourd'hui : exécution de script,
demain : push d'un événement) est traité en mémoire côté process — ce
dépôt tourne tous les équipements dans le même process JS, donc il n'y a
pas de représentation fil de l'AST PowerShell ni, ici, du corps XML
`RenderedText` complet ; seule l'étape d'établissement de connexion est
nouvelle et réelle. `Send-MailMessage` (livré récemment, cf. session
précédente) est le second précédent direct : un dial réseau réel **par
événement à transmettre**, pas un canal permanent simulé — P4 suit ce
même patron (un dial + negotiate + auth + push par événement forwardé,
pas un flux continu).

**Découverte "quelle machine a quel service actif" sans registre
applicatif dédié** (précédent pour P4) : `EquipmentRegistry.getAll()`/
`getById()` (`Equipment.ts:32-34`) déjà utilisé comme mécanisme de
repérage en process (ARP, DNS, `HostLookup`, `netdom query dc`) —
retrouver "quels `WindowsServer` ont `Wecsvc` actif avec un abonnement
`SourceInitiated` correspondant" par balayage de `EquipmentRegistry` est
cohérent avec ce précédent, pas une nouvelle catégorie de raccourci.

**Résolution de membre de groupe par sam, y compris compte ordinateur**
(précédent exact pour P2) : `DirectoryStore.addGroupMemberByDn('Domain
Computers', this.computerDn(name))` appelé automatiquement à la jonction
(`DirectoryStore.ts:1192`) — la même méthode générique
`addGroupMember(groupSam, memberSam)` (ligne 1130) fonctionnera pour
"Event Log Readers" sans aucune modification, une fois le groupe seedé
(P2 n'ajoute qu'une entrée de seed, pas de nouvelle logique de
résolution).

---

## 2. Objectifs

### 2.1 Objectifs (phases TDD, chacune livrable et testable indépendamment)

- **P1 — Service `Wecsvc` + `wecutil qc [/quiet]`** : ajoute `Wecsvc`
  (`Windows Event Collector`) au catalogue `WindowsServiceManager`
  (Manual/Stopped par défaut, dépendance `WinRM`, précédent § 1.3),
  ajoute le point d'entrée `case 'wecutil'` dans `WindowsPC.
  executeCmdCommand` avec un premier sous-dispatch (`qc`). `wecutil qc`
  bascule `Wecsvc` en `Automatic` + le démarre (même effet observable
  qu'un `Set-Service -StartupType Automatic; Start-Service` manuel,
  § 1.3) et imprime le message réel `The service startup mode was
  successfully set to 'Automatic'...The service is now configured
  correctly.` (message tronqué/simplifié tant qu'il matche `service is
  now configured correctly` insensible à la casse, cf. test cible).
  Ferme aussi, sans code additionnel, le test "Set-Service Wecsvc"
  (générique dès que le service existe au catalogue, § 1.3).
- **P2 — Groupe AD "Event Log Readers"** : ajoute le seed manquant dans
  `DirectoryStore.seedDefaults()` (une ligne, symétrique de `Domain
  Admins`/`Domain Users`/`Domain Computers`, § 1.3) — ferme le test
  `Add-ADGroupMember -Identity "Event Log Readers" -Members "SRV-SIEM$"`
  sans toucher `addGroupMember`/`findGroupMemberEntry` (déjà génériques).
- **P3 — Abonnements : `wecutil cs`/`gs`/`ds`/`es`/`rs`/`ss`** :
  - Un petit parseur XML dédié au schéma d'abonnement (regex récursif,
    précédent stylistique § 0.2/1.3 — pas un DOM générique), extrayant
    `SubscriptionId`, `SubscriptionType`, `Enabled`, `ConfigurationMode`,
    `Query` (dé-CDATA-isé, puis les `EventID` extraits du XPath `Select`
    interne via une regex ciblée `EventID=(\d+)` — § 2.2 pour la limite
    assumée sur les XPath complexes), `ReadExistingEvents`,
    `TransportName`, `ContentFormat`, `LogFile`.
  - Un registre d'abonnements en mémoire par collecteur
    (`WindowsServer.wecSubscriptions: Map<string, WecSubscription>`,
    § 4.1), peuplé par `wecutil cs <fichier.xml>` (lit le fichier via le
    système de fichiers déjà réel de la machine, § 0.2), consulté par
    `gs`/`es`, muté par `ds`/`rs`/`ss`.
  - `wecutil gs <SubscriptionId>` imprime `Status: Active` et
    `RunTimeStatus: Active` pour un abonnement `Enabled` dont
    `Wecsvc` est démarré (P1) — sinon un statut honnête
    (`Disabled`/service arrêté).
- **P4 — Relais réseau réel + `MachineName`** :
  - Après chaque `writeEventLog()` réussi sur une machine jointe au
    domaine, un nouveau point d'accroche (`tryForwardMatchingEvent`,
    § 4.2) balaie `EquipmentRegistry` (précédent § 1.3) à la recherche
    de collecteurs (`WindowsServer` avec `Wecsvc` démarré et au moins un
    abonnement `SourceInitiated`/`Enabled` dont la `Query` matche le
    couple `(LogName, EventID)` de l'entrée) atteignables par un vrai
    dial TCP (`TcpStack`) vers le port 5985.
  - Pour chaque collecteur candidat atteignable : dial réel + `negotiate`
    + `auth` (réutilise `WinRmServerHandler`, étendu d'un nouvel op
    `wecPush` — § 4.3) transportant l'événement (id, horodatage,
    message, log source) ; le collecteur, sur réception, ajoute
    l'entrée à son propre `PSEventLogProvider` (journal
    `ForwardedEvents`) via une nouvelle méthode `receiveForwardedEvent`
    qui pose `data.MachineName = <nom de la machine source>`.
  - `GetWinEventCmdlet` (`EventLogCmdlets.ts:230-239`) projette
    désormais `MachineName` sur **tout** événement retourné (§ 1.2 point
    4) : `e.data?.MachineName ?? ctx.hostname` (le nom de la machine
    locale pour un journal non forwardé, le nom de la source pour une
    entrée de `ForwardedEvents`).

### 2.2 Non-objectifs

- **Application de la stratégie de groupe côté client de bout en bout**
  (lecture par le client de la valeur de registre
  `SubscriptionManager` pour découvrir dynamiquement son collecteur/
  abonnement, démarrage automatique de `WinRM` déclenché par la GPO) :
  aucun test ne l'exige (§ 1.2 point 5) ; le déclenchement du relais
  (P4) se fonde sur la découverte en process déjà pratiquée ailleurs
  (§ 1.3) plutôt que sur une simulation complète du pipeline GPO →
  registre → agent local. Documenté explicitement en commentaire de
  code à l'endroit du déclenchement (même traitement que la limite DNS
  de `netdom renamecomputer`, `PRD-Netdom.md` § 7).
- **Abonnements Collector-Initiated** (`SubscriptionType=CollectorInitiated`,
  où le collecteur pousse activement une requête WS-Enumeration vers
  chaque source listée) : le scénario cible n'exerce que
  `SourceInitiated` ; ajouter le sens inverse doublerait le travail de
  P4 sans consommateur identifié — `wecutil cs` accepte le champ mais le
  traite comme `SourceInitiated` par défaut si absent, et documente
  l'absence de support `CollectorInitiated` plutôt que de l'ignorer
  silencieusement.
- **XPath complet dans `<Select>`** (opérateurs `and`/`or`/`not`,
  prédicats sur `EventData`, plusieurs `<Query>` dans une même
  `<QueryList>`) : ce PRD extrait uniquement l'ensemble des `EventID`
  cités par des égalités/`or` simples (couvre le cas du scénario cible :
  `EventID=4624 or EventID=4625 or EventID=4720`) — un XPath plus
  complexe est accepté sans erreur mais peut sur-matcher (documenté en
  commentaire, pas silencieusement conforme).
- **`wecutil ss` (set-subscription) exhaustif** : seule la bascule
  `Enabled`/`Disabled` et un changement de `LogFile` sont supportés
  (couvrent les besoins réalistes de `gs`/`es` de refléter un état
  changé) ; les dizaines d'autres attributs modifiables de la ligne de
  commande réelle (`/cm:`, `/dm:`, `/hi:`, `/ree:`…) sont hors périmètre,
  cohérent avec le non-objectif XPath complet.
- **`wecutil rs` (retry-subscription) avec sémantique de purge de
  file d'attente réelle** : ce simulateur n'a pas de file d'attente de
  push en attente (chaque push est un dial synchrone immédiat, § 2.1
  P4) — `rs` est accepté et retourne succès sans action supplémentaire,
  documenté comme un no-op honnête (même patron que `repadmin /queue`,
  `PRD-Repadmin.md` § 2.1 P9, toujours vide par conception).
- **Format binaire `.evtx` réel pour `ForwardedEvents`** : suit le même
  choix déjà fait pour tous les autres journaux (`renderEvtx`,
  `PSEventLogProvider.ts:391-406` — projection texte fidèle, pas le
  format binaire réel) ; aucune raison de traiter `ForwardedEvents`
  différemment des journaux déjà livrés.

---

## 3. Architecture cible

```
Machine SOURCE (WindowsPC/WindowsServer, jointe au domaine)
  │
  writeEventLog(logName, ...) [existant, WindowsSecurityAudit/etc.]
  │
  └─▶ tryForwardMatchingEvent(logName, entry)         (nouveau, P4)
        │  balaie EquipmentRegistry.getAll() (précédent § 1.3)
        │  pour trouver des WindowsServer avec Wecsvc actif +
        │  abonnement SourceInitiated/Enabled dont Query matche
        ▼
      dial TCP réel (TcpStack) → collecteur:5985
        │
        ▼
Machine COLLECTEUR (WindowsServer, Wecsvc actif)
  WinRmServerHandler.register()                        (existant, étendu)
    ├─▶ negotiate                                       (existant)
    ├─▶ auth                                             (existant)
    └─▶ wecPush { subscriptionId, sourceMachine, event }  (nouveau, P4)
          │
          ▼
        receiveForwardedEvent(sourceMachine, event)     (nouveau, P4)
          │  PSEventLogProvider.writeEventLog('ForwardedEvents', ...,
          │  data: { MachineName: sourceMachine, ... })
          ▼
        journal ForwardedEvents (déjà seedé, § 0.2)
          │
          ▼
        Get-WinEvent -LogName ForwardedEvents            (existant, étendu
          projette désormais MachineName (§ 2.1 P4)       P4 pour MachineName)

wecutil.exe (cmd, nouveau point d'entrée)
  ├─▶ qc [/quiet]                (P1) → WindowsServiceManager (Wecsvc Automatic+Start)
  ├─▶ cs <fichier.xml>           (P3) → parseSubscriptionXml() + wecSubscriptions.set()
  ├─▶ gs <SubscriptionId>        (P3) → wecSubscriptions.get() + état Wecsvc
  ├─▶ ds <SubscriptionId>        (P3) → wecSubscriptions.delete()
  ├─▶ es                         (P3) → liste des IDs
  ├─▶ rs <SubscriptionId>        (P3) → no-op honnête documenté (§ 2.2)
  └─▶ ss <SubscriptionId> ...    (P3) → Enabled/LogFile uniquement (§ 2.2)

DirectoryStore.seedDefaults()                            (existant, étendu P2)
  └─▶ createGroupEntry('Event Log Readers', ...)          (une ligne, symétrique
                                                            de Domain Admins/Users/Computers)
```

Aucune seconde implémentation du journal d'événements, du transport
réseau ou de l'annuaire : ce PRD ajoute un point d'entrée CLI (`wecutil`),
un registre d'abonnements minimal, un op WinRM supplémentaire, et un
seed AD manquant.

---

## 4. Modèle de données

### 4.1 Registre d'abonnements (`WindowsServer`, P3)

```ts
export interface WecSubscriptionQuery {
  logName: string;        // ex. "Security"
  eventIds: number[];     // extraits du Select XPath, § 2.2
}

export interface WecSubscription {
  subscriptionId: string;
  subscriptionType: 'SourceInitiated' | 'CollectorInitiated';
  description: string;
  enabled: boolean;
  configurationMode: string;         // 'Custom' | 'Normal' | ... — reflété tel quel
  query: WecSubscriptionQuery;
  readExistingEvents: boolean;
  transportName: string;             // 'HTTP' | 'HTTPS'
  contentFormat: string;             // 'RenderedText' | 'Events'
  logFile: string;                   // 'ForwardedEvents' par défaut
}

// WindowsServer
private wecSubscriptions: Map<string, WecSubscription> = new Map();
```

### 4.2 Point d'accroche de forward (P4)

```ts
// WindowsPC/WindowsServer (méthode partagée sur la classe de base hôte)
private tryForwardMatchingEvent(logName: string, entry: EventLogEntry): void {
  if (!this.domainMembership) return;                    // WEF suppose une machine jointe
  for (const eq of EquipmentRegistry.getInstance().getAll()) {
    if (!(eq instanceof WindowsServer)) continue;
    const sub = eq.findMatchingActiveSubscription(logName, entry.eventId);
    if (!sub) continue;
    // dial TCP réel vers eq:5985, negotiate+auth, op 'wecPush' — § 3
  }
}
```

### 4.3 Extension `WinRmServerContext`/`WinRmServerHandler` (P4)

```ts
export interface WinRmServerContext {
  userMgr: WindowsUserManager;
  domainAuth?: (username: string, password: string) => { ok: boolean; sam: string; groups: string[] } | null;
  /** Windows Event Collector (PRD-Wecutil.md § 2.1 P4) — absent sur une
   *  machine qui n'est pas un collecteur, l'op `wecPush` répond alors
   *  une erreur honnête plutôt qu'un faux succès. */
  wec?: {
    receiveForwardedEvent(subscriptionId: string, sourceMachine: string, event: {
      eventId: number; timeGenerated: Date; message: string; sourceLogName: string;
    }): { ok: boolean; message: string };
  };
}
```

### 4.4 Extension `EventLogEntry`/`GetWinEventCmdlet` (P4)

Aucun nouveau champ sur `EventLogEntry` : `MachineName` est porté par le
`data` déjà existant (`data?.MachineName`, précédent établi § 1.3 pour
les champs `EventData` structurés) — `GetWinEventCmdlet` (§ 2.1 P4)
ajoute `MachineName: e.data?.MachineName ?? ctx.hostname` à l'objet
projeté, pour tout journal, pas seulement `ForwardedEvents`.

---

## 5. Plan de mise en œuvre (TDD, par phases)

1. **P1** en premier — aucune dépendance nouvelle, ferme à la fois
   `wecutil qc` et (gratuitement, § 2.1) le test `Set-Service Wecsvc` ;
   sert aussi de gabarit pour le style de message `wecutil` (`The
   service is now configured correctly.`) que `qc`/`cs`/`gs` réutilisent.
2. **P2** ensuite, indépendant de P1 — une ligne de seed, ferme
   `Add-ADGroupMember "Event Log Readers"` sans toucher au moteur de
   résolution de membres déjà générique (§ 1.3).
3. **P3** après P1 (a besoin de `Wecsvc` existant pour que `gs` reflète
   un état de service cohérent) — tester d'abord le parsing XML isolé
   (fixture du scénario cible), puis `cs` → `gs` → `es` → `ds` comme
   cycle de vie complet.
4. **P4** en dernier, dépend de P1 (Wecsvc actif) et P3 (abonnement
   existant à matcher) — le risque le plus élevé du PRD (nouveau
   protocole réseau, § 7) ; tester d'abord le matching pur (`Query` →
   `(LogName, EventID)`) sans réseau, puis le dial réel bout en bout, en
   réutilisant le scénario `scenario-ad-event-forwarding-wef.test.ts`
   existant comme test d'acceptation final.

### 5.1 Table récapitulative des phases

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Wecsvc + `wecutil qc`** | Service catalogué + premier point d'entrée `wecutil` | `WindowsServiceManager` déjà livré |
| **P2 — groupe AD Event Log Readers** | Seed `DirectoryStore.seedDefaults()` | `addGroupMember` déjà livré |
| **P3 — abonnements** | Parseur XML, registre `wecSubscriptions`, `cs`/`gs`/`ds`/`es`/`rs`/`ss` | P1 (état `Wecsvc` reflété par `gs`) |
| **P4 — relais réseau + `MachineName`** | `tryForwardMatchingEvent`, op `wecPush`, `receiveForwardedEvent`, projection `MachineName` | P1, P3 |

Chaque phase suit le cycle rouge → vert → refactor. Aucune suite
existante (`windows-eventlog-cli.test.ts`, `ps-phase13-eventlog.test.ts`,
les scénarios `scenario-windows-*-audit*.test.ts`) ne doit changer de
comportement observable — seule la projection `Get-WinEvent` gagne un
champ (§ 2.1 P4), ce qui est strictement additif.

---

## 6. Stratégie de test

- **Test emblématique de P1** : sur une machine fraîchement provisionnée,
  `wecutil qc /quiet` réussit et `Get-Service -Name Wecsvc` montre
  ensuite `Running`/`Automatic` ; indépendamment, `Set-Service -Name
  Wecsvc -StartupType Automatic; Start-Service -Name Wecsvc` produit le
  même état observable sans être passé par `wecutil` (cohérence des
  deux surfaces, précédent § 1.3 déjà pratiqué pour `Remove-Computer`/
  `netdom remove`).
- **Test emblématique de P3** : `wecutil cs` sur le fichier XML du
  scénario cible crée un abonnement dont `wecutil gs` rapporte
  `Status: Active`/`RunTimeStatus: Active` ; `wecutil ds` le supprime et
  un `gs` suivant échoue proprement ("no such subscription") ; `wecutil
  es` liste bien l'ID après `cs`, plus après `ds`.
- **Test emblématique de P4** : reprend le scénario cible tel quel
  (abonnement créé sur `SRV-SIEM`, événement 4624 généré sur
  `PC-WIN-01` via `runas`, `Get-WinEvent -LogName ForwardedEvents` sur
  `SRV-SIEM` contient une entrée avec `MachineName = PC-WIN-01`) — plus
  un test négatif : un événement qui ne matche AUCUN abonnement actif
  (EventID hors liste, ou abonnement `Disabled`) n'apparaît jamais dans
  `ForwardedEvents`, et une capture `tcpdump` sur le switch de transit
  montre bien du trafic TCP/5985 entre la source et le collecteur au
  moment du push (critère de fidélité réseau déjà pratiqué pour SMTP/
  LDAP dans les PRD précédents).
- **Non-régression** : `windows-eventlog-cli.test.ts`,
  `ps-phase13-eventlog.test.ts`, les scénarios `scenario-windows-*-
  audit*.test.ts`/`scenario-ad-*` déjà verts passent sans modification ;
  la suite complète `src/__tests__/unit/network-v2/` est vérifiée après
  chaque phase, avant tout commit (méthode déjà établie dans ce dépôt).

### 6.1 Critères unitaires détaillés, par phase

1. **P1** : `Wecsvc` apparaît dans `Get-Service` avant même `wecutil qc`
   (Manual/Stopped, précédent WinRM) ; `wecutil qc` sans `/quiet`
   produit le même effet observable (le flag ne change que la verbosité,
   pas le résultat) ; appeler `wecutil qc` deux fois de suite est
   idempotent (pas d'erreur "already configured").
2. **P2** : `Get-ADGroupMember "Event Log Readers"` sur un domaine
   fraîchement provisionné (avant tout `Add-ADGroupMember`) retourne une
   liste vide plutôt qu'une erreur "cannot find" ; après
   `Add-ADGroupMember -Members "SRV-SIEM$"`, le compte apparaît avec son
   `objectClass` de compte ordinateur (pas confondu avec un utilisateur).
3. **P3** : le parseur XML rejette proprement (message d'erreur, pas
   d'exception non gérée) un fichier qui n'a pas la racine
   `<Subscription>` attendue ; `Query` avec plusieurs `or` dans le
   `Select` produit bien `eventIds = [4624, 4625, 4720]` (pas seulement
   le premier) ; `ReadExistingEvents`/`Enabled` sont bien parsés comme
   booléens (`"true"`/`"false"`, pas des chaînes tronquées) ; `gs` sur un
   `SubscriptionId` inexistant échoue avec un message honnête, jamais un
   faux `Status: Active`.
4. **P4** : un événement 4625 (échec de logon) sur une machine source
   matche un abonnement dont la `Query` liste `4624 or 4625 or 4720`
   (pas seulement 4624, vérifie que le matching couvre bien tout
   l'ensemble parsé) ; un événement dont le `LogName` ne correspond pas
   à la `Query` (ex. `System` alors que la `Query` cible `Security`)
   n'est jamais forwardé même si l'`EventID` coïncide par hasard ; si le
   collecteur est injoignable (câble débranché/port 5985 fermé), le
   `writeEventLog()` côté source réussit toujours localement (le relais
   échoue silencieusement du point de vue de l'appelant local — un vrai
   Windows ne bloque jamais l'écriture locale d'un événement en attendant
   un collecteur, comportement à préserver) ; deux collecteurs avec des
   abonnements actifs correspondant au même événement reçoivent chacun
   leur propre copie (pas de course qui n'en livre qu'un).

---

## 7. Risques et points d'attention

- **Sur-généralisation du déclenchement de forward** : § 2.2 documente
  explicitement que ce PRD ne simule pas l'application GPO du
  `SubscriptionManager` — le risque est qu'un événement soit forwardé
  vers un collecteur avec lequel la machine source n'a, dans un vrai
  Windows, jamais été configurée pour communiquer. Le garde-fou retenu :
  ne considérer comme collecteur candidat qu'un `WindowsServer`
  **atteignable réseau** (routage/ACL/pare-feu réels déjà appliqués par
  le dial TCP) **et** appartenant au **même domaine AD** que la source
  (vérification `domainMembership.dnsName` égal des deux côtés) — pas
  "n'importe quel Wecsvc actif sur le réseau", pour rester honnête sur
  la portée de la simplification sans devenir absurdement permissif.
- **Coût du balayage `EquipmentRegistry` à chaque écriture de journal** :
  `writeEventLog()` est appelé fréquemment (tout événement d'audit) —
  le balayage (§ 4.2) doit sortir tôt (retour immédiat si
  `!this.domainMembership`, avant toute itération) pour ne pas dégrader
  les nombreux tests qui écrivent des événements sur des machines non
  jointes à un domaine (majorité des tests `LinuxMachine`/postes hors
  domaine ne sont de toute façon jamais concernés, seul `WindowsPC`/
  `WindowsServer` joints appellent ce point d'accroche).
- **Confusion entre `wecutil rs` (no-op documenté, § 2.2) et un vrai
  échec silencieux** : le message retourné par `rs` doit explicitement
  indiquer l'absence de file d'attente à purger (pas juste "OK" nu),
  pour rester distinguable en lecture de code d'un futur bug qui
  ignorerait par erreur une vraie file.
- **`MachineName` par défaut (`ctx.hostname`) sur les journaux non
  forwardés** : vérifier qu'aucun test existant (`ps-phase13-eventlog.
  test.ts`, etc.) n'asserte l'absence de cette propriété ou une forme de
  sortie texte qui casserait avec un champ supplémentaire — projection
  additive uniquement, jamais un renommage de champ existant.
- **Double surface `wecutil`/PowerShell** : contrairement à `netdom`
  (qui a des cmdlets PowerShell modernes équivalentes,
  `Remove-Computer`/`Rename-Computer`), WEF n'a **aucun cmdlet natif
  côté client** pour la gestion d'abonnements sur un vrai Windows —
  `wecutil` est la seule surface légitime ; ne pas inventer de cmdlet
  `New-WecSubscription` qui n'existe pas dans le vrai produit (le
  scénario cible n'en demande d'ailleurs aucun).

---

## 8. Critères d'acceptation

- `wecutil qc [/quiet]` configure et démarre réellement `Wecsvc`
  (`Get-Service` le confirme) ; `Set-Service`/`Start-Service` génériques
  produisent le même effet sans passer par `wecutil`.
- `Add-ADGroupMember -Identity "Event Log Readers" -Members "SRV-SIEM$"`
  réussit et `Get-ADGroupMember "Event Log Readers"` liste le compte
  ordinateur.
- `wecutil cs`/`gs`/`ds`/`es` gèrent un cycle de vie complet
  d'abonnement à partir d'un fichier XML conforme au schéma Microsoft
  réel (§ 2.1 P3), avec un statut honnête (`Active`/erreur explicite,
  jamais de faux succès).
- Un événement de sécurité généré sur une machine source jointe au
  domaine, matchant la `Query` d'un abonnement `SourceInitiated` actif
  sur un collecteur réseau-atteignable, apparaît réellement dans
  `ForwardedEvents` du collecteur avec `MachineName` égal au nom de la
  source — via une vraie connexion TCP/5985 observable dans une capture
  de transit, pas une copie en mémoire.
- `Get-WinEvent` projette `MachineName` sur tout journal, pas seulement
  `ForwardedEvents`.
- Le scénario `scenario-ad-event-forwarding-wef.test.ts` existant passe
  intégralement (5 tests), sans modification de ses assertions.
- La suite complète `src/__tests__/unit/network-v2/` passe sans
  régression après chaque phase, vérifiée phase par phase, avant tout
  commit (méthode déjà établie dans ce dépôt pour les PRD précédents).
