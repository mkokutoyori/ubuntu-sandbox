# PRD — Messagerie d'entreprise : Microsoft Exchange Server (Mailbox, Transport Exchange, Autodiscover, Database Availability Groups)

**Version** : 1.0
**Date** : 2026-07-24
**Projet** : Ubuntu Sandbox — Module Windows Server / Messagerie d'entreprise
**Auteur** : Claude Code
**Références normatives** : documentation Microsoft d'Exchange Server (rôles
et services — Front End Transport, Transport, Mailbox Transport ;
Exchange Management Shell — les cmdlets `*-Mailbox`, `*-TransportRule`,
`*-ReceiveConnector`/`*-SendConnector`, `*-DistributionGroup`,
`*-DatabaseAvailabilityGroup` ; architecture des bases de boîtes aux
lettres et des Database Availability Groups pour la haute disponibilité),
MS-OXDSCLI (spécification Microsoft Open Specifications du protocole
Autodiscover — forme HTTP/XML uniquement, aucune tentative de reproduire
RPC/MAPI), et RFC 5321/5322 déjà couverts et livrés par `PRD-SMTP.md`
(réutilisés sans duplication, § 0.2). Ce PRD est une brique
**partiellement greenfield** : aucun code Exchange n'existe dans ce
dépôt (§ 1.1), mais il s'appuie entièrement sur deux fondations déjà
livrées et stables — le moteur SMTP générique (`PRD-SMTP.md`) et
l'annuaire Active Directory (`PRD-Windows-Server.md`/`-Advanced.md`).

---

## 0. Contexte et portée du document

Microsoft Exchange Server n'est pas un protocole de plus à côté de SMTP
— c'est un **produit de messagerie d'entreprise** qui orchestre SMTP
(entre autres) derrière une identité propre : des boîtes aux lettres
structurées en dossiers (pas un simple fichier texte par utilisateur),
un pipeline de transport nommé (connecteurs de réception/envoi, règles
de flux de courrier), un carnet d'adresses global dérivé de l'annuaire
d'entreprise, la protection contre la perte de service par réplication
de bases de données entre serveurs (Database Availability Group), et un
outil d'administration unique en ligne de commande (Exchange Management
Shell). C'est cette couche produit — pas le protocole SMTP lui-même,
déjà livré — que ce PRD couvre.

Ce dépôt n'a aujourd'hui **aucune trace de code spécifique à Exchange**
(§ 1.1) — contrairement à `auditpol`/`repadmin`, ce n'est pas un
document de complétion sur du code existant, mais un PRD qui construit
une nouvelle brique produit **entièrement au-dessus** de deux fondations
déjà livrées et stables :

1. **Le moteur SMTP/ESMTP générique** (`PRD-SMTP.md`, livré — 18
   fichiers sous `src/network/smtp/`, § 1.1) : canal de contrôle réel,
   `STARTTLS`, `AUTH`, enveloppe RFC 5321 distincte du message RFC 5322,
   remise locale réelle, relais sortant par résolution MX, file
   d'attente, DSN, SPF. Ce PRD **ne réimplémente rien de tout cela** —
   il l'utilise comme moteur de transport sous-jacent, exactement comme
   un vrai Exchange s'appuie sur un pipeline SMTP conforme aux RFC pour
   le fil, tout en ajoutant sa propre couche de gestion et de politique
   par-dessus.
2. **Active Directory** (`PRD-Windows-Server.md`/`-Advanced.md`,
   livrés) : un vrai Exchange est indissociable de l'annuaire — chaque
   boîte aux lettres est un attribut d'un objet utilisateur AD existant
   (`Enable-Mailbox`, pas `New-Mailbox` seul), le carnet d'adresses
   global est une vue sur l'annuaire, les groupes de distribution sont
   des groupes AD mail-activés. Ce PRD réutilise le modèle AD déjà
   livré et l'étend au minimum nécessaire (§ 1.2 point 3).

Aucune ligne de code n'est écrite dans le cadre de ce document.

### 0.1 Chaîne de dépendances

```
PRD-SMTP.md (livré) ─────────────┐
  moteur SMTP/ESMTP, STARTTLS,   │
  AUTH, SPF, DSN, queue, relay,  │  fondations déjà stables,
  remise locale                  │  aucune modification requise
                                  │  pour que ce PRD démarre
PRD-Windows-Server(-Advanced).md ┤
  AD (utilisateurs, groupes,     │
  OUs), DirectoryStore,          │
  WindowsServer                  ┘
        │
        ▼
PRD-Exchange.md                                            ◄── VOUS ÊTES ICI
   │  Mailbox store, Exchange Management Shell, pipeline de transport
   │  Exchange (connecteurs, règles de flux), carnet d'adresses global,
   │  groupes de distribution, Autodiscover, Database Availability Group
   ▼
(aucun consommateur PRD identifié — produit terminal, comme SMTP et AD
eux-mêmes le sont déjà)
```

Aucune dépendance bloquante : les deux fondations sont déjà
intégralement livrées.

### 0.2 Ce que ce PRD réutilise sans le dupliquer

| Besoin Exchange | Brique déjà livrée réutilisée | Fichier |
|---|---|---|
| Réception SMTP entrante | `SmtpServer`/`SmtpServerSession` | `src/network/smtp/SmtpServer.ts`, `SmtpServerSession.ts` |
| Envoi/relais sortant | Moteur de relais + résolution MX | `src/network/smtp/relay.ts`, `relayPolicy.ts` |
| Chiffrement du canal | `STARTTLS` déjà câblé | `src/network/smtp/starttls.ts` |
| Authentification SMTP | `AUTH` (PLAIN/CRAM-MD5) | `src/network/smtp/auth.ts` |
| Anti-usurpation | SPF déjà évalué | `src/network/smtp/spf.ts` |
| Accusés de non-remise | DSN déjà généré | `src/network/smtp/dsn.ts` |
| Mise en file d'attente | `queue.ts` déjà réel | `src/network/smtp/queue.ts` |
| Remise dans une boîte | `localDelivery.ts` (actuellement un dépôt façon `/var/mail/<user>`) | `src/network/smtp/localDelivery.ts` |
| Utilisateurs/groupes | `WindowsUserManager`/AD `DirectoryStore` | (déjà livrés, `PRD-Windows-Server.md`) |
| Comptes AD mail-activables | `New-ADUser`/`New-ADGroup` existants | `ActiveDirectoryCmdlets.ts` |

Ce PRD **étend** `localDelivery.ts` (boîte structurée en dossiers plutôt
qu'un fichier plat, § 2.1 P2) et **étend** `New-ADGroup` (catégorie
Sécurité/Distribution absente aujourd'hui, § 1.2 point 3) — les deux
seules modifications rétroactives aux fondations existantes ; tout le
reste est additif.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/smtp/` (18 fichiers) | Moteur SMTP/ESMTP générique complet | Livré et stable (§ 0.1/0.2) — **aucune notion d'identité produit Exchange** : pas de bannière EHLO annonçant Exchange, pas de rôle de transport nommé, pas de connecteur configurable au sens Exchange |
| `src/network/smtp/localDelivery.ts` | Remise dans `/var/mail/<user>` | Dépôt de message **plat**, un seul fichier par utilisateur — un vrai magasin de boîtes Exchange a des dossiers (Boîte de réception, Éléments envoyés, Brouillons, Éléments supprimés, Courrier indésirable) et des propriétés par message (lu/non lu, catégories) |
| `src/powershell/cmdlets/core/ActiveDirectoryCmdlets.ts:403-419` (`NewADGroupCmdlet`) | `New-ADGroup -GroupScope` | **Aucun paramètre `GroupCategory`** — un vrai groupe AD est à la fois `GroupScope` (DomainLocal/Global/Universal) **et** `GroupCategory` (Security/Distribution) ; ce dépôt n'a que la première dimension, ce qui bloque la notion même de « groupe de distribution » qu'Exchange mail-active |
| (recherche exhaustive) | Code spécifique Exchange | **Aucun** — ni cmdlet `*-Mailbox`/`*-TransportRule`/`*-Connector`/`*-DatabaseAvailabilityGroup`, ni notion de base de boîtes aux lettres, ni Autodiscover, ni terminologie de rôle de transport Exchange nulle part dans ce dépôt |
| `src/network/devices/linux/commands/net/mail/MailCommand.ts` | Commande `mail`/`mailx` côté client Linux | Client de consultation du dépôt plat `/var/mail/`, indépendant d'Exchange — reste valable pour un client Linux consultant sa boîte locale, mais n'a aucune notion de dossiers, de permissions déléguées, ni de protocole de récupération distant (POP3/IMAP4) |
| `src/network/core/WellKnownPorts.ts`, `IanaServiceRegistry.ts` | Noms de ports IANA | `pop3` (110)/`imap`(143)/`imaps`(993)/`pop3s`(995) déjà présents comme **noms d'affichage seulement** (même état que `smtp`/`smtps` avant `PRD-SMTP.md`) — aucun moteur POP3/IMAP4 réel, cohérent avec l'absence totale de code Exchange |
| `docs/PRD-Windows-Server.md`, `docs/PRD-Windows-Server-Advanced.md` | PRDs Windows Server déjà livrés | Aucune mention d'Exchange ni de messagerie d'entreprise (recherche exhaustive, § recherche) — ce PRD n'entre en collision avec aucune décision de périmètre déjà actée, contrairement à `PRD-Repadmin.md` qui héritait de non-objectifs KCC déjà tranchés |

### 1.2 Constats-clés

1. **Fondation solide, produit absent** : le moteur SMTP livré est
   suffisamment riche (STARTTLS, AUTH, SPF, DSN, relais, file d'attente)
   pour servir de plomberie à un vrai Exchange — il ne manque que la
   couche produit (gestion, identité, politique) que ce PRD ajoute.
2. **Le magasin de boîtes actuel est un dépôt plat, pas des boîtes aux
   lettres structurées** — premier obstacle concret à toute commande
   `Get-Mailbox`/`Get-MailboxStatistics` fidèle (nombre d'éléments par
   dossier, quota par boîte, etc.).
3. **Le modèle de groupe AD n'a pas de dimension Sécurité/Distribution**
   — bloque la notion même de « groupe de distribution » avant même de
   commencer à écrire du code Exchange ; un correctif ciblé sur
   `New-ADGroup` (§ 2.1 P3) est un préalable, pas un développement
   Exchange à proprement parler.
4. **POP3/IMAP4 sont des noms de port sans moteur**, exactement comme
   SMTP l'était avant son propre PRD — signale que si ce PRD veut
   couvrir la récupération de courrier par ces protocoles (§ 2.2, hors
   périmètre ici), ce serait un chantier de la même ampleur que SMTP
   lui-même, pas un sous-objectif mineur.
5. **Aucune décision de périmètre à respecter d'un PRD amont** (à la
   différence de `PRD-Repadmin.md` qui héritait du non-KCC) — ce PRD est
   libre de définir son propre périmètre entièrement, ce qu'il fait en
   § 2.2 en s'inspirant des exclusions déjà pratiquées ailleurs dans ce
   dépôt (GUI exclue, protocoles legacy binaires exclus).

---

## 2. Objectifs

### 2.1 Objectifs (phases TDD, chacune livrable et testable indépendamment)

- **P1 — Bootstrap du rôle Exchange** : `Install-ExchangeServer -Roles
  Mailbox -OrganizationName "Mandeng"` sur un `WindowsServer` déjà
  membre du domaine (prérequis réel : compte joint AD, cf.
  `Install-ADDSForest` déjà livré comme précédent direct). **Simplification
  documentée** : un vrai `setup.exe /mode:Install /role:Mailbox
  /IAcceptExchangeServerLicenseTerms` est un processus multi-étapes
  (extension de schéma AD, préparation de domaine, installation binaire) ;
  ce PRD le condense en un seul cmdlet, comme ce dépôt le fait déjà pour
  `Install-ADDSForest` face au vrai processus de promotion DC en
  plusieirs étapes. Après P1, `Get-ExchangeServer` liste le serveur et
  son rôle ; avant P1, toute cmdlet Exchange échoue avec `The term
  '<cmdlet>' is not recognized` (cohérent avec le comportement réel
  d'une session PowerShell sans le composant logiciel enfichable/module
  Exchange chargé).
- **P2 — Magasin de boîtes structuré** : remplace/étend
  `localDelivery.ts` par un modèle de dossiers (Inbox, Sent Items,
  Drafts, Deleted Items, Junk Email) avec un compteur d'éléments et un
  état lu/non lu par message, tout en conservant la remise SMTP
  existante comme unique point d'entrée réel (aucun second chemin de
  remise). `Enable-Mailbox -Identity <user AD existant>` (pas
  `New-Mailbox` — un vrai Exchange mail-active un compte AD existant,
  il n'en crée pas un nouveau à partir de rien, sauf `New-Mailbox` qui
  crée les deux d'un coup en un seul appel — les deux formes sont
  couvertes). `Get-Mailbox`, `Set-Mailbox` (quota, redirection), `Get-
  MailboxStatistics` (taille, nombre d'éléments par dossier),
  `Disable-Mailbox`/`Remove-Mailbox`.
- **P3 — Groupes de distribution** : ajoute `GroupCategory` (`Security`
  | `Distribution`) à `New-ADGroup` (§ 1.2 point 3, préalable) puis
  `New-DistributionGroup`/`Set-DistributionGroup`/`Add-
  DistributionGroupMember`/`Get-DistributionGroupMember` — un groupe de
  distribution mail-active un groupe AD `Distribution` existant
  (attribut `mail`), un groupe de sécurité mail-activé
  (`New-DistributionGroup -Type Security`) mail-active un groupe
  `Security` existant. L'envoi à l'adresse du groupe doit réellement
  distribuer aux boîtes de tous les membres (résolution d'enveloppe au
  moment de la remise, réutilise `localDelivery.ts` de P2 pour chaque
  membre).
- **P4 — Carnet d'adresses global (GAL)** : `Get-GlobalAddressList`,
  résolution d'adresse au moment de l'envoi (le champ `À :` d'un message
  peut être un nom d'affichage ou un SAM account name résolu contre AD,
  pas seulement une adresse SMTP littérale — comportement réel
  d'Outlook/Exchange qu'un client de ce simulateur doit pouvoir
  reproduire via le carnet d'adresses). Chaque boîte activée en P2
  reçoit une adresse SMTP primaire dérivée (`proxyAddresses`,
  `SMTP:<sam>@<domaine-accepté>`), visible dans le GAL.
- **P5 — Pipeline de transport nommé** : `Get-ReceiveConnector`/`New-
  ReceiveConnector` (habillage de la configuration d'écoute déjà
  réelle de `SmtpServer`, § 0.2 — un connecteur de réception Exchange
  **est** un binding SMTP avec des restrictions IP/authentification
  nommées), `Get-SendConnector`/`New-SendConnector` (habillage de
  `relay.ts`/`relayPolicy.ts` — un connecteur d'envoi Exchange **est**
  une politique de relais nommée, avec ses domaines d'adresse cibles et
  son coût). Aucun second moteur SMTP : ces cmdlets configurent et
  interrogent la même plomberie que P0 (§ 0.2), sous un nom Exchange.
- **P6 — Règles de flux de courrier (Transport Rules)** : `New-
  TransportRule -Name "..." -Condition {...} -Action {...}` avec un
  sous-ensemble réaliste de conditions (expéditeur/destinataire,
  contenu du sujet, présence d'une pièce jointe déclarée) et d'actions
  (rejeter avec un message, ajouter une mention de bas de page,
  rediriger, mettre en copie cachée — réutilisé directement par P10
  pour le journaling). Évaluées dans `SmtpServerSession` **avant**
  remise locale ou relais, cohérent avec la position réelle du
  Transport Rules Agent dans le pipeline Exchange (catégoriseur, avant
  remise).
- **P7 — File d'attente vue Exchange** : `Get-Queue`, `Retry-Queue`,
  `Suspend-Queue`, `Resume-Queue` — nouvelle terminologie/formatage sur
  `queue.ts` déjà réel (§ 0.2), pas une seconde file. Différence de
  fidélité à assumer : un vrai Exchange a des files par service de
  transport (Submission/Mailbox Delivery/Poison) ; ce PRD n'en modélise
  qu'une seule, cohérente avec `queue.ts` existant, et le documente
  explicitement plutôt que de prétendre à la granularité réelle.
- **P8 — Autodiscover (MS-OXDSCLI, HTTP/XML uniquement)** : un client
  interroge `https://autodiscover.<domaine>/autodiscover/
  autodiscover.xml` (ou la découverte SRV `_autodiscover._tcp`) avec
  son adresse SMTP, reçoit en retour un XML réel indiquant le serveur
  de boîte aux lettres à contacter. Consommateur réaliste dans ce
  simulateur : un futur client de messagerie scripté (hors périmètre
  ici) ou simplement un test qui vérifie que la découverte pointe vers
  le bon serveur après un déplacement de boîte — la valeur immédiate
  est de rendre la topologie de service interrogeable, pas de servir un
  vrai client Outlook (qui n'existe pas dans ce simulateur).
- **P9 — Permissions et délégation de boîte** : `Add-
  MailboxPermission -Identity <boîte> -User <compte> -AccessRights
  FullAccess`, `Add-RecipientPermission ... -AccessRights SendAs` —
  s'appuie sur le modèle d'ACL déjà livré côté AD
  (`PRD-Windows-Server.md`, délégation OU) plutôt que d'inventer un
  second mécanisme de permission ; un utilisateur avec `FullAccess` peut
  ouvrir/lire la boîte structurée de P2, un utilisateur avec `SendAs`
  peut faire remettre un message avec l'adresse de la boîte comme
  expéditeur.
- **P10 — Journalisation (Journaling)** : `New-JournalRule -
  JournalEmailAddress <boîte-journal> -Scope Global` — copie invisible
  (BCC) de chaque message vers une boîte de journalisation dédiée,
  implémentée comme un cas particulier de P6 (Transport Rule système,
  non modifiable par l'administrateur) plutôt qu'un mécanisme séparé.
- **P11 — Database Availability Group (DAG), réplication explicite** :
  `New-DatabaseAvailabilityGroup`, `Add-DatabaseAvailabilityGroupServer`,
  `Add-MailboxDatabaseCopy` entre deux serveurs Exchange du même DAG.
  **Choix de conception assumé, cohérent avec le précédent AD** (cf.
  `PRD-Repadmin.md § 0.2` — pas de KCC réel, cycle de réplication
  déclenché manuellement) : ce PRD modélise une réplication de base de
  boîtes **déclenchée explicitement** (`Update-MailboxDatabaseCopy` ou
  intervalle fixe), pas la réplication continue en temps réel réelle
  (log shipping continu) — le même choix que la réplication AD déjà
  livrée, pour la même raison de coût d'implémentation face à la valeur
  pédagogique. `Get-MailboxDatabaseCopyStatus` rapporte l'état
  (Healthy/FailedAndSuspended/Mounted) et le nombre de journaux de
  transaction en retard.
- **P12 — Diagnostics** : `Get-ExchangeServer` (liste les serveurs du
  rôle, § P1), `Test-ServiceHealth` (vérifie que les services attendus
  du rôle Mailbox tournent — réutilise le modèle de service Windows déjà
  livré, `WindowsServiceManager`), `Test-Mailflow` (envoie un message de
  test entre deux boîtes ou serveurs et confirme la remise via P2 —
  équivalent fonctionnel réel, pas un stub qui répond toujours succès).

### 2.2 Non-objectifs

- **OWA (Outlook Web App) et ECP (Exchange Control Panel)** : interfaces
  web graphiques — cohérent avec l'exclusion GUI déjà pratiquée ailleurs
  dans ce dépôt (`PRD-Windows-Server-Advanced.md` : « Interface graphique
  … surface CLI/PowerShell uniquement »). Toute administration Exchange
  dans ce PRD passe exclusivement par l'Exchange Management Shell.
- **MAPI/RPC over HTTP** : protocole binaire propriétaire lourd,
  consommé uniquement par un vrai client Outlook — ce simulateur n'a et
  n'aura pas de client Outlook scripté ; reproduire MAPI sans
  consommateur réel serait un investissement sans valeur de test.
- **Exchange Web Services (EWS, SOAP)** et **Exchange ActiveSync
  (EAS)** : même raisonnement — aucun client mobile ou script EWS
  n'existe dans ce simulateur pour les consommer ; Autodiscover (P8)
  suffit à démontrer la découverte de service sans construire les deux
  API qu'elle pointerait.
- **Dossiers publics (Public Folders)** : fonctionnalité historique en
  déclin même sur un vrai Exchange moderne, aucun consommateur identifié.
- **Calendrier, disponibilité (Free/Busy), planification de réunions** :
  fonctionnalité de niveau MAPI riche (items de calendrier, résolution
  de conflits), sans rapport avec le transport de courrier qui est le
  cœur de ce PRD — chantier séparé s'il devient nécessaire.
- **Exchange Online / scénarios hybrides** : service cloud Microsoft
  réel, hors de portée d'un simulateur de réseau local isolé sans accès
  Internet réel.
- **eDiscovery, In-Place Hold, Compliance Search** : fonctionnalités de
  conformité d'entreprise avancées, sans consommateur ni scénario
  pédagogique identifié à ce stade.
- **S/MIME** (chiffrement/signature de message de bout en bout) :
  complexité cryptographique substantielle pour une valeur de test
  limitée dans ce contexte — même raisonnement que l'exclusion de
  PKINIT/FAST dans `PRD-Windows-Server-Advanced.md`.
- **Réplication DAG continue en temps réel (log shipping)** : remplacée
  par une réplication déclenchée explicitement (§ 2.1 P11), décision
  assumée et documentée, pas un gap à corriger plus tard sans
  justification supplémentaire.
- **Fidélité exacte du processus d'installation `setup.exe`** :
  simplifié en un seul cmdlet `Install-ExchangeServer` (§ 2.1 P1),
  décision assumée pour les mêmes raisons que `Install-ADDSForest`.
- **POP3/IMAP4** (récupération de courrier) : les noms de port existent
  déjà (§ 1.1) mais construire ces deux protocoles serait un chantier de
  l'ampleur de SMTP lui-même (son propre PRD, pas un sous-objectif
  d'Exchange) — un client de ce simulateur qui veut lire une boîte
  Exchange le fait aujourd'hui via la commande `mail`/`mailx` déjà
  existante contre le magasin structuré de P2, pas via un protocole de
  récupération réseau.

---

## 3. Architecture cible

```
AD (DirectoryStore, déjà livré)
  utilisateurs, groupes (+ GroupCategory, P3), OUs
        │
        ▼
ExchangeOrganization (nouveau, P1)
  liste des serveurs du rôle Mailbox, nom d'organisation, domaines
  acceptés (« accepted domains », dérivés des zones DNS déjà gérées)
        │
        ├──▶ MailboxStore (nouveau, P2) — par utilisateur AD mail-activé
        │      dossiers (Inbox/Sent Items/Drafts/Deleted Items/Junk),
        │      quota, permissions déléguées (P9)
        │      point d'entrée UNIQUE : SmtpServerSession → TransportRule
        │      engine (P6) → MailboxStore.deliver() (remplace l'appel
        │      direct à localDelivery.ts, qui devient l'implémentation
        │      interne de MailboxStore pour le dossier Inbox)
        │
        ├──▶ DistributionGroup (nouveau, P3) — résolution d'enveloppe
        │      au moment de la remise : un message à l'adresse du
        │      groupe se transforme en N remises vers MailboxStore
        │
        ├──▶ TransportConnector (nouveau, P5) — habillage nommé de
        │      SmtpServer (Receive) et relay.ts/relayPolicy.ts (Send),
        │      aucune seconde implémentation SMTP
        │
        ├──▶ TransportRuleEngine (nouveau, P6/P10) — hook dans
        │      SmtpServerSession avant remise/relais
        │
        ├──▶ AutodiscoverService (nouveau, P8) — serveur HTTP/XML,
        │      réutilise le client/serveur HTTP déjà livré ailleurs
        │      dans ce dépôt (mêmes primitives que Invoke-WebRequest)
        │
        └──▶ DatabaseAvailabilityGroup (nouveau, P11) — réplication
               déclenchée explicitement de MailboxStore entre serveurs,
               même philosophie que la réplication AD déjà livrée
               (PRD-Repadmin.md § 0.2)
```

Un seul point d'entrée réel dans une boîte aux lettres (`MailboxStore.
deliver()`, appelé depuis le pipeline de transport) — aucune commande
Exchange n'écrit jamais directement dans une boîte en contournant le
pipeline, cohérent avec le comportement réel d'Exchange où toute remise,
même locale, traverse le même Transport Rules Agent.

---

## 4. Modèle de données

### 4.1 `Mailbox` / `MailboxStore` (P2)

```ts
type MailFolderName = 'Inbox' | 'Sent Items' | 'Drafts' | 'Deleted Items' | 'Junk Email';

interface StoredMailItem {
  id: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: number;   // epoch seconds
  read: boolean;
  sizeBytes: number;
}

interface Mailbox {
  readonly adIdentity: string;    // SamAccountName du compte AD mail-activé
  readonly primarySmtpAddress: string;
  readonly proxyAddresses: string[];
  quotaBytes: number | null;      // null = illimité
  readonly folders: Record<MailFolderName, StoredMailItem[]>;
}
```

### 4.2 `DistributionGroup` (P3, étend le modèle AD existant)

```ts
interface DistributionGroupExtension {
  readonly adGroupSam: string;      // groupe AD sous-jacent (§ 1.2 point 3)
  readonly type: 'Distribution' | 'SecurityMailEnabled';
  primarySmtpAddress: string;
}
```

### 4.3 `TransportRule` (P6)

```ts
interface TransportRuleCondition {
  field: 'From' | 'To' | 'SubjectContains' | 'HasAttachment';
  value?: string;
}
type TransportRuleAction =
  | { kind: 'Reject'; message: string }
  | { kind: 'AppendDisclaimer'; text: string }
  | { kind: 'RedirectTo'; address: string }
  | { kind: 'BlindCopyTo'; address: string };  // réutilisé par le journaling (P10)

interface TransportRule {
  name: string;
  priority: number;
  conditions: TransportRuleCondition[];
  actions: TransportRuleAction[];
  enabled: boolean;
}
```

### 4.4 `TransportConnector` (P5)

```ts
interface ReceiveConnectorDef {
  name: string;
  bindings: string[];              // ex. "0.0.0.0:25"
  remoteIpRanges: string[];
  authMechanisms: ('TLS' | 'BasicAuth' | 'ExchangeServer')[];
}
interface SendConnectorDef {
  name: string;
  addressSpaces: string[];         // ex. "*" ou "partner.mandeng.lan"
  smartHosts: string[];
  costMetric: number;
}
```

### 4.5 `DatabaseAvailabilityGroupCopy` (P11)

```ts
type CopyStatus = 'Mounted' | 'Healthy' | 'FailedAndSuspended' | 'Resynchronizing';

interface MailboxDatabaseCopy {
  database: string;
  server: string;
  status: CopyStatus;
  copyQueueLength: number;   // journaux de transaction en retard depuis la dernière synchronisation déclenchée
  lastSyncedAt: number;      // epoch seconds
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

1. **P1** (bootstrap) en premier — tout le reste dépend d'un
   `ExchangeOrganization` existant pour être testable.
2. **P3 (correctif `GroupCategory`)** avant tout le reste de P3, comme
   un correctif ciblé et isolé sur `ActiveDirectoryCmdlets.ts` — tester
   la non-régression de `New-ADGroup` sans `GroupCategory` (comportement
   par défaut à préserver) avant d'ajouter les groupes de distribution
   proprement dits.
3. **P2** ensuite — fondation de toutes les phases suivantes qui
   touchent une boîte (P3 distribution, P6 règles, P9 permissions, P10
   journalisation, P11 DAG).
4. **P4/P5** peuvent suivre en parallèle une fois P2 posé (indépendants
   l'un de l'autre).
5. **P6** après P2 — tester d'abord une règle simple (rejet par mot-clé
   dans le sujet) avant les actions plus complexes (redirection, copie
   cachée).
6. **P7** trivial une fois P6/§0.2 stabilisés (pur formatage sur
   `queue.ts`).
7. **P9** après P2 (dépend du modèle de boîte) et après le modèle ACL AD
   déjà livré (aucune nouvelle dépendance à construire).
8. **P10** après P6 (cas particulier de Transport Rule).
9. **P8** indépendant, peut se faire à tout moment après P1 (dépend
   seulement de l'existence de serveurs/domaines acceptés).
10. **P11** en dernier — dépend de P2 (boîtes à répliquer) et bénéficie
    de la même discipline de test que la réplication AD
    (`PRD-Repadmin.md § 6` — test emblématique de synchronisation
    déclenchée entre deux serveurs).
11. **P12** en tout dernier, diagnostics qui dépendent de tout le reste
    pour avoir quelque chose à diagnostiquer.

---

## 6. Stratégie de test

- **Test emblématique de P2/P6** : un message envoyé via le moteur SMTP
  déjà livré (§ 0.2) vers l'adresse d'une boîte activée, avec une
  Transport Rule qui ajoute une mention de bas de page, doit arriver
  dans le dossier `Inbox` de cette boîte **avec** la mention ajoutée —
  vérifie que le pipeline complet (SMTP → Transport Rule → Mailbox)
  fonctionne de bout en bout, pas seulement chaque brique isolément.
- **Test emblématique de P3** : un message envoyé à l'adresse d'un
  groupe de distribution de 3 membres doit produire 3 remises
  distinctes (une par boîte membre), visibles indépendamment dans
  chaque `Get-MailboxStatistics`.
- **Test emblématique de P11** : deux serveurs Exchange dans le même
  DAG, une boîte modifiée sur le serveur actif, une synchronisation
  déclenchée explicitement, puis vérification que
  `Get-MailboxDatabaseCopyStatus` sur le serveur passif reflète l'état
  à jour — même structure de test que le précédent de réplication AD
  (`PRD-Repadmin.md § 6`).
- **Test de non-régression SMTP** : la suite `smtp-*.test.ts` existante
  (§ 0.1) doit rester verte intégralement après chaque phase — aucune
  phase de ce PRD ne doit modifier le comportement SMTP générique déjà
  testé, seulement l'orchestrer différemment en amont/aval.
- **Test de non-régression AD** : idem pour les suites `scenario-ad-
  *.test.ts` existantes après le correctif `GroupCategory` de P3.

---

## 7. Risques et points d'attention

- **Tentation de dupliquer SMTP plutôt que de l'orchestrer** : le risque
  principal de ce PRD est qu'une implémentation pressée réécrive un
  second chemin de remise/relais « spécifique à Exchange » au lieu de
  réutiliser `SmtpServerSession`/`relay.ts` existants (§ 0.2) — à
  surveiller particulièrement en P5 (connecteurs) et P2 (remise), où la
  tentation de « faire plus simple en local » est la plus forte.
- **`GroupCategory` (P3) est un changement rétroactif sur un cmdlet déjà
  utilisé** par les suites AD existantes (`New-ADGroup` apparaît dans
  plusieurs scénarios AD déjà livrés) — à traiter comme un ajout de
  paramètre optionnel avec une valeur par défaut qui préserve le
  comportement actuel, jamais comme un changement de signature cassant.
- **Fidélité du magasin de boîtes (P2)** : un vrai Exchange stocke les
  boîtes dans une base ESE/JET par groupe de 100+ boîtes (« mailbox
  database »), pas un fichier par utilisateur. Ce PRD modélise
  volontairement une structure plus simple (un objet `Mailbox` en
  mémoire par utilisateur, § 4.1) sans reproduire le moteur de stockage
  ESE — à assumer et documenter explicitement dans le code (comme
  `WinRepadmin.ts` documente déjà honnêtement ses propres
  simplifications), pas à présenter comme une fidélité totale.
- **P8 (Autodiscover) sans client réel à servir** : la valeur de cette
  phase est démonstrative/testable (interroger le point de terminaison
  et vérifier la réponse XML) plutôt qu'opérationnelle (aucun client de
  ce simulateur ne consomme Autodiscover automatiquement aujourd'hui) —
  à ne pas sur-investir au-delà de ce que § 2.1 P8 décrit.
- **Cohérence de la décision DAG (P11) avec le précédent AD** : la
  réplication déclenchée explicitement (pas continue) doit être
  présentée avec la même franchise que `PRD-Repadmin.md § 0.2` le fait
  pour la réplication AD — même risque de malentendu si un futur lecteur
  s'attend à une haute disponibilité en temps réel.
- **Ordre P3 avant P2** (§ 5, point 2) : inverser l'ordre risquerait de
  construire des groupes de distribution capables de recevoir du
  courrier avant même que le modèle de boîte qui doit recevoir ce
  courrier existe — un piège de séquencement à éviter explicitement.

---

## 8. Critères d'acceptation

- `Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"`
  sur un `WindowsServer` joint au domaine fait apparaître le serveur
  dans `Get-ExchangeServer` ; toute cmdlet Exchange échouait avant avec
  `not recognized`, aucune n'échoue après.
- `Enable-Mailbox -Identity bob` sur un compte AD existant crée une
  boîte avec les 5 dossiers standard, une adresse SMTP primaire dérivée,
  et `Get-Mailbox bob` la retrouve.
- Un message SMTP réel (via le moteur déjà livré, § 0.2) adressé à la
  boîte de `bob` arrive dans son dossier `Inbox`, visible par
  `Get-MailboxStatistics bob` et par la commande `mail`/`mailx` déjà
  existante.
- `New-ADGroup -GroupCategory Distribution` puis
  `New-DistributionGroup` mail-active ce groupe ; un message envoyé à
  son adresse produit une remise dans **chacune** des boîtes membres.
- `New-TransportRule` avec une condition de rejet par mot-clé fait
  réellement échouer la remise d'un message contenant ce mot-clé
  (réponse SMTP de rejet, pas une remise silencieuse suivie d'une
  suppression).
- `Get-Queue` affiche le même contenu que `queue.ts` interrogé
  directement — pas de divergence entre la vue Exchange et la donnée
  sous-jacente.
- Une requête HTTP réelle vers l'endpoint Autodiscover (P8) avec
  l'adresse SMTP d'une boîte existante renvoie un XML pointant vers le
  bon serveur Exchange hébergeant cette boîte.
- `Add-MailboxPermission -AccessRights FullAccess` permet effectivement
  à l'utilisateur délégué de lire le contenu de la boîte déléguée
  (vérifiable via une commande d'inspection), refusé avant l'octroi de
  la permission.
- Deux serveurs dans le même DAG (P11) : une modification sur le
  serveur actif, une synchronisation déclenchée, puis
  `Get-MailboxDatabaseCopyStatus` sur le passif reflète l'état à jour —
  sans synchronisation déclenchée, l'état reste explicitement en retard
  (`copyQueueLength > 0`), jamais silencieusement à jour.
- La suite complète `src/__tests__/unit/network-v2/` (y compris
  `smtp-*.test.ts` et `scenario-ad-*.test.ts`) passe sans régression
  après chaque phase, vérifiée phase par phase.
