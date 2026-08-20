# PRD — Politique d'audit avancée Windows : `auditpol.exe` (catalogue de catégories/sous-catégories et portée causale sur la génération d'événements de sécurité)

**Version** : 1.1
**Date** : 2026-07-24
**Projet** : Ubuntu Sandbox — Module Windows Server / Audit de sécurité
**Auteur** : Claude Code
**Références normatives** : documentation Microsoft de la « Advanced Audit
Policy Configuration » (`auditpol.exe`, 9 catégories × ~60 sous-catégories
introduites avec Windows Vista/Server 2008 en remplacement des 9 réglages
de « Basic Audit Policy » historiques de `secpol.msc`), et les EventIDs du
fournisseur `Microsoft-Windows-Security-Auditing` que chaque sous-catégorie
conditionne (catalogue Microsoft « Advanced security audit policy
settings »), ainsi que les réglages globaux LSA exposés par
`auditpol /get|/set /option:` (`CrashOnAuditFail`, `FullPrivilegeAuditing`,
`AuditBaseObjects`, `AuditBaseDirectories`), la politique d'audit par
utilisateur (`/set /user:`), et l'audit global de ressource — « Global
Object Access Auditing » (`/resourceSACL`). Ce PRD est un document de
complétion : il porte sur un sous-système **déjà présent et partiellement
câblé** dans ce dépôt (`WindowsAuditPolicy.ts`), pas sur une brique
greenfield.

> **v1.1** : élargit le périmètre initial (catalogue + portée causale,
> v1.0) à quatre fonctionnalités supplémentaires de `auditpol.exe` non
> couvertes en v1.0 : options globales LSA (P10), politique d'audit par
> utilisateur (P11), audit global de ressource / `/resourceSACL` (P12,
> **sorti des non-objectifs de v1.0**, § 2.2), et descripteur de sécurité
> de la politique elle-même via `/sd` (P13), plus `/get /r` et les
> variantes de `/list` (P14).

---

## 0. Contexte et portée du document

`auditpol.exe` est, sur un vrai Windows, le point de vérité unique de la
politique d'audit de sécurité : c'est lui qui décide, sous-catégorie par
sous-catégorie, si tel type d'opération (connexion, création de compte,
création de processus, modification de registre, accès à un partage…)
produit ou non une entrée dans le journal `Security`. Sans une
sous-catégorie activée, l'EventID correspondant **n'est jamais généré,
même si l'opération a réellement lieu** — c'est la porte d'entrée de tout
pipeline d'audit et de détection construit sur ce journal.

Ce dépôt a déjà une implémentation de `auditpol` (`WindowsAuditPolicy.ts`,
112 lignes, câblée dans `WindowsPC.ts`) et l'a exercée en profondeur dans
neuf suites de tests de scénarios d'audit d'événements Windows
(`scenario-windows-eventlog-structure-filtering.test.ts`,
`scenario-windows-logon-session-audit.test.ts`,
`scenario-windows-process-audit-4688.test.ts`,
`scenario-windows-object-share-audit.test.ts`,
`scenario-windows-privilege-uac-audit.test.ts`,
`scenario-windows-config-change-audit.test.ts`,
`scenario-windows-powershell-logging.test.ts`,
`scenario-windows-log-export-remoting.test.ts`,
`scenario-windows-incident-reconstruction.test.ts`). Ces suites ont mis en
évidence, empiriquement et de façon reproductible, que l'implémentation
actuelle est un **CLI décoratif plutôt qu'une politique causale** : les
commandes `/set`/`/get` fonctionnent et persistent un état interne, mais
cet état **ne conditionne quasiment jamais** la génération réelle des
événements qu'il est censé gouverner (§ 1.2).

Ce PRD couvre exclusivement `auditpol.exe` — le catalogue de
catégories/sous-catégories, ses sous-commandes, et son rôle de **porte
causale** en amont des projections qui écrivent dans le journal
`Security`. Il ne couvre **pas** la modélisation des SACL par objet
(`FileSystemAuditRule`/`RegistryAuditRule`, `Get-Acl -Audit`/`Set-Acl`)
— un chantier plus large, distinct, et déjà documenté comme gap dans
`scenario-windows-object-share-audit.test.ts` (§ 2.2 explique pourquoi ces
deux chantiers sont liés mais séparés). Aucune ligne de code n'est écrite
dans le cadre de ce document.

### 0.1 Chaîne de dépendances

```
WindowsAuditPolicy.ts (existant, partiel)  ─┐
WindowsSecurityAudit(+Projection).ts        │  déjà livrés, déjà
WindowsEventLogProjection.ts                │  exercés par 9 suites de
PSEventLogProvider.ts                       │  tests scenario-windows-*
GroupPolicyCmdlets.ts (Set-GPRegistryValue) ─┘  (gaps documentés en RED)
   │
   ▼
PRD-Auditpol.md                                          ◄── VOUS ÊTES ICI
   │  Catalogue réel 9 catégories × sous-catégories, validation /set,
   │  portage causal dans les projections existantes, /backup /restore
   │  /clear, gate d'élévation, ligne de base par défaut Serveur/Client,
   │  intégration GPO (Advanced Audit Policy Configuration)
   ▼
(consommateurs internes : les 9 suites scenario-windows-*-audit.test.ts
listées en § 0 passent de rouge à vert phase par phase, § 6 ; un futur
PRD-SACL-Object-Access.md pourrait consommer la porte causale posée ici
pour brancher 4663/4670/5140/5145 — hors-scope ici, cf. § 2.2)
```

Aucune dépendance bloquante externe : tout le code consommé
(`WindowsAuditPolicy`, les projections, `GroupPolicyCmdlets`) est déjà en
production dans ce dépôt.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/devices/windows/WindowsAuditPolicy.ts:20-25` | `DEFAULT_SUBCATEGORIES` | **4 sous-catégories seulement** (`registry`, `file system`, `logon`, `logoff`) contre ~60 sur un vrai Windows, et **aucune notion de catégorie parente** (les 9 catégories réelles — System, Logon/Logoff, Object Access, Privilege Use, Detailed Tracking, Policy Change, Account Management, DS Access, Account Logon — n'existent pas comme concept) |
| `WindowsAuditPolicy.ts:41-48` (`set()`) | `auditpol /set /subcategory:"X"` | Accepte **n'importe quelle chaîne** comme nom de sous-catégorie et la crée à la volée (`this.subcategories.get(key) ?? { success: false, failure: false, displayName: subcategory }`) — un vrai `auditpol /set /subcategory:"Blah"` renvoie `The category was not found.`, celui-ci renvoie toujours `The command was successfully executed.` (`cmdAuditpol`, l. 100) |
| `WindowsAuditPolicy.ts:59-73` (`formatGet`/`formatGetAll`) | `auditpol /get` | Sortie **plate**, une ligne par sous-catégorie, sans en-tête de catégorie ni regroupement — un vrai `auditpol /get /category:*` imprime les 9 catégories comme titres de section avec leurs sous-catégories indentées dessous |
| `WindowsAuditPolicy.ts:86-111` (`cmdAuditpol`) | Routeur de sous-commandes | Seuls `/set` et `/get` sont reconnus ; `/backup`, `/restore`, `/clear`, `/list`, `/remove`, `/resourceSACL` renvoient tous `AuditPol.exe command not recognized. Use AuditPol /? for usage.` — et `/?` lui-même n'affiche aucune aide (tombe dans le même message d'erreur générique, faute de branche dédiée) |
| `src/network/devices/WindowsPC.ts:1759-1760, 2418-2419` | Deux points de dispatch CLI (`cmd.exe` classique + second chemin) | `cmdAuditpol(this.auditPolicy, args)` — **aucun contrôle de privilège** : contrairement à `cmdSc` (l. 1757-1758, 2412-2416) qui reçoit `isAdmin: this.userMgr.isCurrentUserAdmin()`, `auditpol` est appelable par n'importe quel utilisateur, alors qu'un vrai `auditpol /set` exige un jeton élevé (`SeSecurityPrivilege`) et échoue par `Error 0x00000522: A required privilege is not held by the client.` sinon |
| `src/network/devices/windows/WindowsSecurityAuditProjection.ts:79-101, 113-123` (`onAccountChanged`, `onLogon`, `onLogoff`, `onGroupCreated`, `onGroupDeleted`, `onMembership`, `onProcess`) | Émission des événements 4720/4722/…/4740, 4624/4625, 4634, 4728/…/4757, 4688/4689 | **Aucun de ces handlers ne consulte `auditPolicy.isEnabled(...)`** — ils écrivent inconditionnellement, que la sous-catégorie correspondante (« User Account Management », « Logon », « Logoff », « Security Group Management », « Process Creation ») soit activée ou non |
| `WindowsSecurityAuditProjection.ts:56-58, 65-68` (`onServiceAccountChanged`, `onAclChanged`) | Émission de 4657 (registre) et 4670 (permissions) | **Seuls handlers réellement gatés** : `if (!this.auditPolicy?.isEnabled('registry', 'success')) return;` / `if (!this.auditPolicy?.isEnabled('file system', 'success')) return;` — confirmé par test (`scenario-windows-config-change-audit.test.ts`, section « audit du registre ») : sans `auditpol /set /subcategory:"Registry" /success:enable` préalable, 4657 ne paraît jamais même après un changement de compte de service réel |
| `src/network/devices/windows/WindowsEventLogProjection.ts` (fichier entier) | Émission de 7036/7034/7031/7045 (Système), 5152/5156/5158/5159/5160 (WFP/Tcpip) | **Aucune référence à `WindowsAuditPolicy` dans tout le fichier** — ces événements sont soit hors du périmètre de l'audit avancé sur un vrai Windows (7036/7045 sont des événements SCM du journal Système, non gatés par `auditpol`, ce qui est correct), soit devraient l'être et ne le sont pas (5152/5156/5158 sont des événements `Security` du fournisseur WFP, gatés en réalité par la sous-catégorie « Filtering Platform Connection »/« Filtering Platform Packet Drop », absente du catalogue actuel) |
| `docs/PRD-Windows-Server.md:46` | Inventaire du module Utilisateurs/sécurité | Cite déjà `WindowsAuditPolicy.ts` dans la liste des fichiers « Local uniquement (SAM) » — confirme que ce fichier est un composant reconnu de l'architecture existante, pas un ajout hors plan |
| `src/powershell/cmdlets/core/GroupPolicyCmdlets.ts` | `Set-GPRegistryValue`, GPO génériques | **Aucune mention** d'« Advanced Audit Policy » — sur un vrai Windows, la politique d'audit avancée se déploie typiquement par GPO domaine (`Computer Configuration\Policies\Windows Settings\Security Settings\Advanced Audit Policy Configuration`) plutôt que par `auditpol` local machine par machine ; ce chemin de déploiement n'existe pas ici |
| `WindowsAuditPolicy.ts` (fichier entier) | Surface `/option`, `/user`, `/resourceSACL`, `/sd`, `/r` | **Absence totale** : aucune structure de données ni sous-commande pour les réglages globaux LSA, la politique par utilisateur, l'audit global de ressource, ou le descripteur de sécurité de la politique — ces quatre familles de fonctionnalités réelles de `auditpol.exe` n'ont aucune trace dans le code, contrairement au catalogue de sous-catégories qui existe au moins partiellement |
| `src/network/devices/windows/PSEventLogProvider.ts:139-142` | `maxSizeKB`/`overflow` du journal `Security` | Le journal `Security` est déjà modélisé avec une taille max (`131072` KB) et une politique de rétention (`'OverwriteOlder'`) — **socle réutilisable** pour implémenter le comportement réel de `CrashOnAuditFail` (§ 2.1 P10), qui dépend précisément de ces deux notions (journal plein + rétention « ne pas écraser ») |
| `src/network/devices/windows/WindowsUserManager.ts` | Comptes locaux (`users` map, mots de passe, verrouillage) | Pas de notion de SID stable exposée en dehors du nom de compte — la politique d'audit par utilisateur réelle (`/set /user:<SID ou nom>`) s'adresse par SID en priorité ; ce dépôt devra soit accepter le nom de compte comme alias (comportement réel accepté par `auditpol` quand il peut résoudre le nom), soit introduire une notion de SID stable (§ 4.5) |

### 1.2 Constats-clés

1. **Catalogue tronqué et non structuré** : 4 sous-catégories plates au
   lieu de ~60 réparties sur 9 catégories ; aucun nom de catégorie
   affiché, aucune relation sous-catégorie → catégorie.
2. **Aucune validation** : `/set` accepte silencieusement tout nom de
   sous-catégorie, y compris fantaisiste — impossible de distinguer une
   faute de frappe d'un réglage réel (`"Loggon"` « réussit » exactement
   comme `"Logon"`).
3. **Absence de portée causale généralisée** : sur les ~9 catégories
   d'événements de sécurité qu'un opérateur peut vouloir activer/couper,
   seules 2 sous-catégories (`registry`, `file system`) ont un effet réel
   sur la génération d'événements — et seulement pour 2 EventIDs (4657,
   4670) parmi les dizaines potentiellement concernées. Toutes les autres
   sous-catégories acceptées (« Process Creation », « Special Logon »,
   « Sensitive Privilege Use », etc., cf. les scénarios 2/3/5 de la suite
   Windows) sont **des chaînes de caractères stockées sans effet**.
4. **Aucun contrôle de privilège** — n'importe quel utilisateur peut
   désactiver l'audit, contrairement au vrai Windows.
5. **Aucune commande de sauvegarde/restauration/remise à zéro**
   (`/backup /file:`, `/restore /file:`, `/clear /y`) — impossible de
   scripter un export/import de politique comme le ferait un vrai
   playbook de durcissement.
6. **Aucune ligne de base réaliste** : un vrai Windows Server (et plus
   encore un contrôleur de domaine promu par `Install-ADDSForest`) démarre
   avec un ensemble de sous-catégories déjà activées par défaut (Logon,
   Logoff, Account Lockout, Special Logon, plusieurs sous-catégories
   « Account Management », « DS Access » sur un DC) — bien plus riche que
   les 4 entrées actuelles.
7. **Aucune intégration GPO** — la politique d'audit avancée est
   déployée par domaine dans la réalité, pas configurée poste par poste
   via une CLI locale à chaque fois.
8. **Aucun réglage global LSA** (`/option:CrashOnAuditFail`,
   `FullPrivilegeAuditing`, `AuditBaseObjects`, `AuditBaseDirectories`) —
   ces quatre options, distinctes des sous-catégories, n'ont ni structure
   de données ni sous-commande `/option` du tout.
9. **Aucune politique d'audit par utilisateur** (`/set /user:<compte>
   /category:… /include|/exclude`) — impossible d'auditer plus finement
   un compte spécifique (ou de l'exclure) indépendamment du réglage
   machine global, alors que c'est une fonctionnalité réelle et
   fréquemment utilisée en investigation ciblée.
10. **Aucun audit global de ressource** (« Global Object Access
    Auditing », `/resourceSACL`) — le mécanisme permettant d'auditer
    rétroactivement tous les objets d'un type donné (fichiers, clés de
    registre…) sans poser de SACL sur chacun individuellement n'existe
    pas non plus.
11. **Aucun descripteur de sécurité sur la politique elle-même**
    (`/sd`/`/get /sd`) — qui a le droit de lire/modifier la politique
    d'audit est actuellement une question binaire (§ P3, futur
    `isAdmin`), jamais une véritable ACL SDDL comme sur un vrai Windows.

---

## 2. Objectifs

### 2.1 Objectifs (phases TDD, chacune livrable et testable indépendamment)

- **P1 — Catalogue réel** : remplacer `DEFAULT_SUBCATEGORIES` par une
  structure `AUDIT_CATEGORIES` fidèle (9 catégories, sous-catégories
  réelles avec leurs noms exacts Microsoft — au minimum toutes celles
  déjà nommées dans les 9 scénarios de test Windows déjà écrits : Logon,
  Logoff, Other Logon/Logoff Events, Account Lockout, Special Logon,
  User/Computer/Security Group Account Management, Process Creation,
  Sensitive/Non Sensitive Privilege Use, Registry, File System, File
  Share, Detailed File Share, Directory Service Changes, Credential
  Validation, Kerberos Authentication Service — § 4 en donne la table
  complète). `auditpol /get /category:*` regroupe désormais par
  catégorie avec en-têtes, comme un vrai Windows.
- **P2 — Validation stricte** : `/set /subcategory:"X"` avec `X` absent du
  catalogue renvoie `The category was not found.` (message exact d'un
  vrai `auditpol`) au lieu de créer silencieusement l'entrée ; `/get`
  idem.
- **P3 — Gate de privilège** : `cmdAuditpol` reçoit `isAdmin` (même
  pattern que `cmdSc`, `WindowsPC.ts:1757-1758`) ; `/set` sans élévation
  renvoie le message réel `Error 0x00000522: A required privilege is not
  held by the client.` et ne modifie pas l'état.
- **P4 — Portage causal, Logon/Logoff/Account Management/Process
  Creation** : ajouter les vérifications `auditPolicy.isEnabled(...)`
  manquantes dans `WindowsSecurityAuditProjection.onLogon`/`onLogoff`/
  `onAccountChanged`/`onProcess`/`onMembership`/`onGroupCreated`/
  `onGroupDeleted`, avec les sous-catégories réelles correspondantes
  (Logon → 4624/4625, Logoff → 4634, Process Creation → 4688/4689, etc.).
  **Décision de conception nécessaire** (§ 7) : ces sous-catégories
  doivent être **activées dans la ligne de base par défaut** (P6) pour ne
  pas casser silencieusement les tests déjà verts qui ne configurent
  jamais `auditpol` avant de déclencher une connexion/un processus
  (`windows-ssh-audit.test.ts`, `journalization-and-audit.test.ts`,
  `windows-eventlog-cli.test.ts`).
- **P5 — Portage causal, Privilège/Objets** : brancher « Sensitive
  Privilege Use » sur la génération réelle de 4672/4673 une fois ces
  EventIDs eux-mêmes rendus dynamiques (dépendance vers un futur
  PRD-Privilege-Audit.md, hors-scope ici — seule la porte causale est
  livrée par ce PRD, prête à être consommée).
- **P6 — Ligne de base par défaut réaliste** : au boot d'un `WindowsPC`,
  pré-activer les sous-catégories qu'un Windows fraîchement installé
  active réellement par défaut (Logon Success/Failure, Logoff Success,
  Account Lockout Success, Special Logon Success, Process Creation —
  **Success uniquement**, correspondant au comportement observé par
  défaut sur Windows 10/11 et Server récents) ; un `WindowsServer` promu
  DC (`Install-ADDSForest`) reçoit en plus la ligne de base DC (Directory
  Service Access/Changes, Kerberos Authentication Service, Credential
  Validation — cohérent avec `scenario-ad-security-audit-events.test.ts`
  qui active déjà ces 7 sous-catégories manuellement).
- **P7 — Sous-commandes manquantes** : `/backup /file:<path>` (export
  CSV — format réel `Machine Name,Policy Target,Subcategory,Subcategory
  GUID,Inclusion Setting,Exclusion Setting,Setting Value`),
  `/restore /file:<path>` (import), `/clear /y` (remise à la ligne de
  base P6), `/list /subcategory:*` (énumération du catalogue P1 sans
  toucher l'état).
- **P8 — Intégration GPO** : une politique d'audit avancée poussée par
  GPO (via le pattern déjà établi de `Set-GPRegistryValue`/`gpupdate`,
  `GroupPolicyCmdlets.ts`) doit se répercuter sur l'état lu par
  `auditpol /get` sur les postes du domaine — pattern « GPO gagne sur
  local » à documenter précisément (§ 7) plutôt que reproduire à
  l'identique.
- **P9 — `Filtering Platform Connection`/`Packet Drop`** : ajouter ces
  deux sous-catégories au catalogue et les brancher sur
  `WindowsEventLogProjection`'s émissions de 5152/5156/5158 (actuellement
  inconditionnelles, § 1.1) — seul point de la couche WFP qui appartient
  réellement à l'audit avancé.
- **P10 — Options globales LSA (`/option`)** : `auditpol /get
  /option:CrashOnAuditFail|FullPrivilegeAuditing|AuditBaseObjects|
  AuditBaseDirectories` et `/set /option:<nom> /value:enable|disable`,
  avec leur sémantique réelle branchée sur le code existant :
  - `CrashOnAuditFail` : quand activé, si le journal `Security` est plein
    (`entries.length` atteint la limite dérivée de `maxSizeKB`, §1.1) et
    que sa rétention est `'DoNotOverwrite'`, toute opération qui devrait
    générer un événement d'audit **échoue et bloque la session courante**
    avec le message réel `STOP: C0000244 {Audit Failed}` — jusqu'à ce
    qu'un administrateur vide le journal (`Clear-EventLog`/`wevtutil cl`)
    ou désactive l'option. Reproduit fidèlement le comportement réel sans
    simuler un vrai arrêt machine : la session Terminal reste utilisable
    en tant qu'administrateur pour la remédiation (équivalent du mode sans
    échec réel), mais toute commande non-administrative est rejetée tant
    que la condition persiste.
  - `FullPrivilegeAuditing` : quand activé, étend « Sensitive Privilege
    Use » à l'usage de `SeBackupPrivilege`/`SeRestorePrivilege` (exclus
    par défaut pour éviter le bruit pendant les sauvegardes) — pure
    donnée de configuration consommée par un futur portage causal de
    4673/4674 (dépendance déjà notée en P5).
  - `AuditBaseObjects`/`AuditBaseDirectories` : options héritées
    (application automatique d'une SACL par défaut aux objets noyau de
    base) — stockées et restituées fidèlement par `/get`/`/set`, sans
    branchement causal supplémentaire (aucun consommateur identifié dans
    ce dépôt, cohérent avec l'absence de modélisation des objets noyau
    nommés).
- **P11 — Politique d'audit par utilisateur (`/set /user:`)** :
  `auditpol /set /user:<compte> /category:"<Catégorie>" /include|/exclude
  [/success:enable|disable] [/failure:enable|disable]`, `/remove
  /user:<compte>` (ou `/allusers`), et `/list /user` (énumération des
  comptes ayant une entrée par-utilisateur). Résolution du `<compte>` par
  nom via `WindowsUserManager` (§ 1.1) plutôt que par SID à ce stade — un
  vrai `auditpol` accepte les deux formes, la simulation peut se limiter
  au nom tant qu'aucun consommateur n'exige un SID stable. Sémantique de
  fusion à respecter dans `isEnabled()` : `/include` = audité si la
  politique machine **ou** la règle par-utilisateur le demande (union),
  `/exclude` = jamais audité pour ce compte quelle que soit la politique
  machine (soustraction prioritaire).
- **P12 — Audit global de ressource, `/resourceSACL`** (fait sortir cette
  fonctionnalité des non-objectifs de la v1.0, § 2.2) : `/resourceSACL
  /set /type:<Type> [/success] [/failure] [/user:<compte>]`, `/remove
  /type:<Type> [/user:<compte>]`, `/clear /type:<Type>`, `/view
  [/type:<Type>] [/user:<compte>]`. Contrairement à une SACL posée sur un
  objet précis (`Get-Acl`/`Set-Acl`, hors-scope, § 2.2), `/resourceSACL`
  pose une SACL **par défaut, globale, par type de ressource**
  (`File`, `Key`, `Service`, `Kernel` au minimum) appliquée
  rétroactivement à tous les objets de ce type sans les modifier
  individuellement — un mécanisme d'investigation légitimement distinct,
  et entièrement du ressort d'`auditpol` plutôt que du fournisseur ACL
  PowerShell.
- **P13 — Descripteur de sécurité de la politique (`/sd`)** : `/get /sd`
  et `/set /sd:<SDDL>` pour définir qui peut lire/modifier la politique
  d'audit elle-même, via une chaîne SDDL réelle plutôt qu'un booléen
  `isAdmin` unique. Vient en complément de P3 (pas en remplacement) :
  `isAdmin` reste le contrôle par défaut tant qu'aucun `/sd` personnalisé
  n'a été posé, exactement comme sur un vrai Windows où le SD par défaut
  de la politique d'audit équivaut à « Administrateurs uniquement ».
- **P14 — `/get /r` et compléments `/list`** : `/get /r` produit le même
  format CSV que `/backup /file:` (§ 4.3) mais directement sur la sortie
  standard, sans fichier — utile pour un script qui veut consommer l'état
  courant sans étape d'écriture disque intermédiaire. `/list
  /subcategory:<nom-de-catégorie>` liste les sous-catégories d'**une**
  catégorie précise (par opposition à `/list /subcategory:*`, déjà prévu
  en P7, qui les liste toutes) ; `/list /category:*` liste les 9 noms de
  catégories seuls.

### 2.2 Non-objectifs

- **Modélisation des SACL par objet** (`Get-Acl -Audit`,
  `New-Object System.Security.AccessControl.FileSystemAuditRule`,
  `Set-Acl -AclObject`, équivalent registre `RegistryAuditRule`) : sur un
  vrai Windows, la génération de 4663/4670/5140/5145 exige **deux
  conditions cumulatives** — la sous-catégorie activée (ce que ce PRD
  livre) **ET** une SACL positionnée sur l'objet précis consulté. Ce
  second mécanisme est un chantier de taille comparable (nouveau concept
  de données sur chaque objet fichier/registre/partage) et fait l'objet
  d'un PRD séparé le moment venu ; `scenario-windows-object-share-audit.test.ts`
  documente déjà ce gap en détail et n'attend pas ce PRD-ci pour rester
  pertinent.
- **« Basic Audit Policy »** (les 9 réglages historiques pré-Vista de
  `secpol.msc`, `Local Policies\Audit Policy`) et la résolution de
  conflit Basic/Advanced (une GPO Advanced Audit Policy non vide
  désactive silencieusement Basic sur un vrai Windows) : ce dépôt ne
  modélise et n'a jamais modélisé que l'audit avancé ; introduire Basic
  ajouterait une source de confusion sans consommateur identifié.
- **Sous-catégories DS Access complètes** (audit de chaque type d'objet
  AD individuellement, `msDS-*`, filtrage par classe d'objet) : seules
  « Directory Service Changes » et « Directory Service Access » au niveau
  global sont dans le périmètre P1 ; le filtrage fin par classe d'objet
  n'a pas de consommateur dans ce dépôt aujourd'hui.
- **SACL par objet individuel via `/resourceSACL`** : ne pas confondre
  avec P12 (§ 2.1), qui couvre le réglage **global par type de
  ressource**. `/resourceSACL` ne donne jamais de prise sur un objet
  précis (un fichier nommé, une clé de registre nommée) — cela reste du
  ressort du non-objectif SACL par objet ci-dessus, quel que soit l'état
  de P12.
- **Options `/option` sans consommateur identifié au-delà de P10** :
  au-delà des quatre options réelles couvertes par P10, `auditpol` n'a
  pas d'autres réglages globaux documentés par Microsoft à ce jour — rien
  n'est volontairement laissé de côté ici.

---

## 3. Architecture cible

```
WindowsAuditCategoryCatalog.ts (nouveau)
  9 catégories × sous-catégories réelles, chacune avec son nom exact,
  son GUID Microsoft (pour la fidélité du format CSV de /backup),
  et la liste des EventIDs qu'elle gouverne (table § 4) — donnée pure,
  aucune logique.
        │
        ▼
WindowsAuditPolicy.ts (existant, étendu)
  - set()/get() valident contre le catalogue (P2)
  - formatGetAll() regroupe par catégorie (P1)
  - backup()/restore()/clear() (P7), getReport() pour /get /r (P14)
  - seedDefaults(profile: 'client' | 'server' | 'domain-controller') (P6)
  - options: Record<GlobalOptionName, boolean> + get/setOption() (P10)
  - perUser: Map<account, PerUserAuditEntry[]> + include/exclude (P11)
  - resourceSacl: Map<ResourceType, ResourceSaclEntry> (P12)
  - securityDescriptor: string (SDDL) + get/setSecurityDescriptor() (P13)
        │
        ▼
cmdAuditpol(policy, args, isAdmin, callerAccount) (signature étendue,
  P3/P11/P13 — callerAccount nécessaire pour évaluer /sd et pour que
  /set /user:<compte-courant> ait un sens en investigation locale)
        │
        ├──▶ WindowsSecurityAuditProjection (existant, étendu)
        │      chaque handler consulte désormais isEnabled(subcat,
        │      kind, account?) — la politique par utilisateur (P11)
        │      élargit la signature d'isEnabled() avec un paramètre de
        │      compte optionnel, rétrocompatible avec les deux appels
        │      existants qui ne le passent pas
        │
        ├──▶ WindowsEventLogProjection (existant, étendu uniquement
        │      pour les 2 sous-catégories WFP concernées, P9 — le reste
        │      du fichier, purement journal Système, reste non gaté,
        │      fidèle au vrai Windows)
        │
        └──▶ PSEventLogProvider (existant, étendu) — writeEventLog()
               consulte options.CrashOnAuditFail + l'état plein/rétention
               du journal Security avant d'écrire (P10) ; en cas de
               blocage, renvoie un signal que cmdAuditpol/le shell
               traduisent en rejet des commandes non-administratives
```

Aucun nouveau canal de bus événementiel pour P4/P5/P9 (mêmes gardes de
lecture que la v1.0). P10 (CrashOnAuditFail) et P11 (politique par
utilisateur) sont les deux seuls points de cette extension qui touchent
une signature de méthode existante (`writeEventLog`, `isEnabled`) plutôt
que de se contenter d'ajouter des données à côté — à traiter avec le plus
de soin lors de l'implémentation (§ 7).

---

## 4. Modèle de données

### 4.1 `AuditSubcategoryDef`

```ts
interface AuditSubcategoryDef {
  name: string;              // nom exact affiché par un vrai auditpol
  guid: string;               // GUID Microsoft réel (fidélité /backup)
  category: AuditCategoryName;
  governs: number[];          // EventIDs Security que cette sous-catégorie gate
}
```

### 4.2 Catalogue cible (sous-ensemble couvert par P1 — priorité aux
sous-catégories déjà nommées dans les 9 scénarios de test Windows)

| Catégorie | Sous-catégorie | EventIDs gouvernés |
|---|---|---|
| Logon/Logoff | Logon | 4624, 4625 |
| Logon/Logoff | Logoff | 4634, 4647 |
| Logon/Logoff | Other Logon/Logoff Events | 4649, 4778, 4779, 4800-4803 |
| Logon/Logoff | Account Lockout | 4740, 4767 |
| Logon/Logoff | Special Logon | 4672, 4964 |
| Account Management | User Account Management | 4720, 4722, 4724, 4725, 4726, 4738, 4740 |
| Account Management | Computer Account Management | 4741, 4742, 4743 |
| Account Management | Security Group Management | 4727-4735, 4737, 4754-4757, 4764 |
| Detailed Tracking | Process Creation | 4688 |
| Detailed Tracking | Process Termination | 4689 |
| Privilege Use | Sensitive Privilege Use | 4672, 4673, 4674 |
| Privilege Use | Non Sensitive Privilege Use | 4673, 4674 |
| Object Access | File System | 4656, 4663, 4664, 4670 |
| Object Access | File Share | 5140, 5142-5144, 5168 |
| Object Access | Detailed File Share | 5145 |
| Object Access | Registry | 4657, 4663 |
| Object Access | Filtering Platform Connection | 5156, 5158, 5159 |
| Object Access | Filtering Platform Packet Drop | 5152, 5157 |
| DS Access | Directory Service Access | 4661, 4662 |
| DS Access | Directory Service Changes | 5136-5139, 5141 |
| Account Logon | Credential Validation | 4774-4777 |
| Account Logon | Kerberos Authentication Service | 4768, 4771, 4772 |
| Account Logon | Kerberos Service Ticket Operations | 4769, 4770, 4773 |

Les 4 sous-catégories existantes (`registry`, `file system`, `logon`,
`logoff`) sont conservées telles quelles (clés internes, valeurs par
défaut) et rattachées à leur `AuditSubcategoryDef` correspondant dans le
nouveau catalogue — aucune rupture de compatibilité avec le code déjà
livré qui les consulte (`onServiceAccountChanged`, `onAclChanged`).

### 4.3 Format `/backup` (CSV réel)

```
Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting,Setting Value
DC01,System,Logon,{0CCE9215-69AE-11D9-BED3-505054503030},Success and Failure,,3
```

(`Setting Value` : 0 = No Auditing, 1 = Success, 2 = Failure, 3 = Success
and Failure — encodage réel `auditpol`.)

### 4.4 Options globales LSA (`AuditGlobalOptions`, P10)

```ts
interface AuditGlobalOptions {
  CrashOnAuditFail: boolean;       // défaut réel : false
  FullPrivilegeAuditing: boolean;  // défaut réel : false
  AuditBaseObjects: boolean;       // défaut réel : false
  AuditBaseDirectories: boolean;   // défaut réel : false
}
```

Sortie `auditpol /get /option:CrashOnAuditFail` réelle à reproduire :

```
System audit policy
Option                                   Value
CrashOnAuditFail                         Disabled
```

### 4.5 Politique d'audit par utilisateur (`PerUserAuditEntry`, P11)

```ts
interface PerUserAuditEntry {
  account: string;      // nom de compte (§ 1.1 — pas de SID stable requis en P11)
  category: string;     // nom de catégorie ou sous-catégorie
  mode: 'include' | 'exclude';
  success?: boolean;
  failure?: boolean;
}
```

Sémantique de fusion consommée par `isEnabled(subcat, kind, account?)` :

```
exclude(account, subcat, kind) présent  → false (priorité absolue)
sinon include(account, subcat, kind) présent → true
sinon → réglage machine global (comportement v1.0 inchangé)
```

### 4.6 Audit global de ressource (`ResourceSaclEntry`, P12)

```ts
type ResourceType = 'File' | 'Key' | 'Service' | 'Kernel';

interface ResourceSaclEntry {
  type: ResourceType;
  success: boolean;
  failure: boolean;
  perUser?: Map<string, { success: boolean; failure: boolean }>;
}
```

`/resourceSACL /view /type:File` réel à reproduire :

```
Resource SACLs for File:
No entries found.
```

(ou la liste des entrées `perUser`/globale une fois posées par `/set`).

### 4.7 Descripteur de sécurité de la politique (`securityDescriptor`, P13)

Stocké comme chaîne SDDL brute (`string`), au même titre que les SDDL déjà
manipulées ailleurs dans ce dépôt pour les ACL AD (§ 1.1,
`ActiveDirectoryCmdlets.ts`) — aucun nouveau parseur SDDL à écrire si un
parseur existant peut être réutilisé ; sinon, une évaluation minimale
(propriétaire + une liste d'ACE `(A;;RCWDWO;;;<SID>)`) suffit pour statuer
oui/non sur « ce compte a-t-il le droit de lire/modifier la politique ? »
sans reproduire l'intégralité de la sémantique SDDL.

---

## 5. Plan de mise en œuvre (TDD, par phases)

1. **P1** : écrire les tests du catalogue (`/list`, `/get /category:*`
   avec en-têtes) avant d'écrire `WindowsAuditCategoryCatalog.ts`.
2. **P2** : test « `/set` sur un nom inconnu échoue » avant d'ajouter la
   validation — vérifier aussi la non-régression sur les 4 clés
   existantes.
3. **P3** : test « `/set` sans élévation échoue » avant de câbler
   `isAdmin` dans `cmdAuditpol` et ses deux sites d'appel
   (`WindowsPC.ts:1759-1760, 2418-2419`).
4. **P6 avant P4** (ordre important) : poser la ligne de base par défaut
   en premier, puis re-exécuter toute la suite existante
   (`windows-ssh-audit.test.ts`, `journalization-and-audit.test.ts`,
   `windows-eventlog-cli.test.ts`, les 9 scénarios Windows) pour confirmer
   qu'aucune ne régresse avant d'ajouter les gardes causales de P4.
5. **P4** : ajouter les gardes une sous-catégorie à la fois (Logon
   d'abord, la plus exercée), en re-testant la suite complète après
   chaque ajout — pas un seul gros commit qui bascule tout d'un coup.
6. **P5/P9** : dépendent d'EventIDs actuellement statiques (4672/4673,
   5152/5156/5158) — se coordonnent avec leurs PRDs respectifs si/quand
   ces EventIDs deviennent dynamiques ; la garde causale elle-même peut
   être posée dès maintenant en attente du bus événementiel amont.
7. **P7** : `/backup`/`/restore` d'abord (symétriques, se testent l'un
   par l'autre par aller-retour), puis `/clear`.
8. **P8** : dernier, dépend de P1-P6 stabilisés.
9. **P10 (options)** : implémenter les quatre options comme pur stockage
   `/get`/`/set` d'abord (aucun risque de régression, indépendant du
   reste) ; le branchement causal de `CrashOnAuditFail` sur
   `PSEventLogProvider.writeEventLog()` vient dans un second temps,
   derrière un test dédié qui remplit délibérément le journal `Security`
   pour vérifier le blocage puis la remédiation — à isoler du reste de la
   suite pour ne pas risquer de laisser un journal artificiellement plein
   contaminer d'autres tests (réinitialisation systématique en
   `afterEach`).
10. **P11 (par utilisateur)** avant P4 si possible, car P4 modifie déjà
    la signature de `isEnabled()` (ajout du paramètre `kind`) — autant
    y ajouter le paramètre `account?` de P11 dans le même changement de
    signature plutôt que deux migrations successives de tous les appelants.
11. **P12 (`/resourceSACL`)** et **P13 (`/sd`)** : indépendants l'un de
    l'autre et du reste, peuvent se faire en parallèle après P3 (P13
    réutilise le concept de gate de privilège posé par P3).
12. **P14** : dernier, pur confort (`/get /r` réutilise `backup()` de P7
    en changeant seulement la destination ; les variantes de `/list`
    réutilisent le catalogue de P1).

---

## 6. Stratégie de test

- Les 9 suites `scenario-windows-*-audit.test.ts` déjà écrites servent de
  **baseline rouge documentée** : chaque assertion actuellement en échec
  qui porte sur `auditpol`/la portée causale (ex. « gap confirmé » dans
  `scenario-windows-config-change-audit.test.ts` sur le gate `registry`
  généralisé aux autres sous-catégories) devient une cible de bascule au
  vert, phase par phase, sans qu'aucune de ces suites n'ait besoin d'être
  réécrite — seul leur statut PASS/FAIL doit évoluer.
- Nouveaux tests dédiés à `WindowsAuditPolicy.ts` : catalogue complet
  (P1), rejet de nom invalide (P2), gate de privilège (P3),
  `/backup`→`/restore` aller-retour bit-à-bit (P7), ligne de base
  Client/Server/DC (P6).
- Test de non-régression explicite : lancer la suite complète
  `src/__tests__/unit/network-v2/` après P4/P6 pour détecter toute suite
  tierce (hors les 9 scénarios Windows et les 3 fichiers cités en § 5.4)
  qui dépendrait implicitement du comportement inconditionnel actuel.
- **P10 (CrashOnAuditFail)** : test dédié en 3 temps — (1) remplir le
  journal `Security` jusqu'à la limite avec rétention `DoNotOverwrite` et
  l'option activée, vérifier qu'une commande non-administrative
  ultérieure est rejetée avec le message `STOP: C0000244` ; (2) vérifier
  qu'une commande administrative de remédiation (`Clear-EventLog`)
  débloque immédiatement l'état ; (3) vérifier qu'avec l'option
  désactivée, le même remplissage n'a aucun effet bloquant (seule la
  rotation normale du journal s'applique).
- **P11 (par utilisateur)** : test de fusion — sous-catégorie machine
  désactivée + `/include` sur un compte → événement généré pour ce
  compte, absent pour les autres ; sous-catégorie machine activée +
  `/exclude` sur un compte → événement absent pour ce compte, présent
  pour les autres.
- **P12/`/resourceSACL`** : test de portée — poser `/resourceSACL /set
  /type:File /success` doit couvrir un fichier créé **après coup**
  également (pas seulement ceux déjà existants au moment du `/set`),
  fidèle à la sémantique « SACL par défaut appliquée au type », pas
  « SACL posée sur les objets existants ».
- **P13 (`/sd`)** : test de gate — un utilisateur non listé dans le SDDL
  posé ne peut ni lire ni modifier la politique même s'il est par
  ailleurs administrateur local, tant que le SDDL ne l'inclut pas
  explicitement (ou implicitement via le groupe Administrateurs) —
  vérifie que P13 prend effectivement le pas sur le simple `isAdmin` de
  P3 une fois posé.

---

## 7. Risques et points d'attention

- **Risque de régression silencieuse en cascade** : P4 (portage causal)
  est le changement le plus dangereux du plan — toute suite existante qui
  déclenche une connexion/un processus/une création de compte **sans**
  appeler `auditpol /set` au préalable cessera de voir l'événement
  correspondant si sa sous-catégorie n'est pas dans la ligne de base P6.
  D'où l'ordre P6-avant-P4 imposé en § 5, et la re-exécution complète de
  la suite après chaque sous-catégorie gatée plutôt qu'en bloc.
- **Choix de la ligne de base par défaut** : Windows Client et Windows
  Server n'ont pas exactement la même politique d'audit par défaut, et un
  contrôleur de domaine promu en a une troisième, plus riche. Le choix
  fait ici (§ 2.1 P6) vise la cohérence avec le comportement déjà observé
  et testé (`scenario-ad-security-audit-events.test.ts` active
  manuellement 7 sous-catégories sur un DC — signe que la ligne de base
  DC actuelle du dépôt est volontairement vide) ; il faudra confirmer que
  ce choix ne casse pas ce test-là non plus (il active tout lui-même,
  donc a priori robuste, mais à vérifier explicitement).
- **Interaction GPO/local (P8)** : un vrai Windows applique la politique
  effective en fusionnant GPO domaine et politique locale
  (`auditpol /get /r` distingue « Machine Name » et différentes sources)
  avec la GPO qui gagne en cas de conflit. Reproduire cette sémantique de
  fusion sans le moteur GPO complet (LSDOU, `gpupdate /force`) est plus
  complexe que le reste du plan ; à traiter en dernier et à cadrer
  précisément avant de commencer (peut nécessiter son propre sous-PRD si
  le besoin de fidélité s'avère élevé).
- **Basic Audit Policy et SACL par objet individuel** : exclus
  explicitement (§ 2.2) — à rappeler si une future demande cite
  spécifiquement l'un de ces deux mécanismes, pour éviter une extension
  de périmètre non planifiée.
- **Format `/backup` CSV** : les GUID réels des sous-catégories Microsoft
  doivent être reproduits fidèlement (§ 4.3) pour qu'un CSV exporté par
  ce simulateur reste comparable à un vrai `auditpol /backup`, un
  critère de fidélité facile à négliger en cours d'implémentation.
- **`CrashOnAuditFail` — ce qu'« halt » signifie dans un simulateur
  navigateur** (P10) : un vrai Windows s'arrête complètement (écran
  bleu, plus aucune interaction possible avant redémarrage en admin). Ce
  dépôt n'a ni redémarrage ni écran bleu à simuler ; le choix retenu
  (§ 2.1 P10 — rejeter les commandes non-administratives jusqu'à
  remédiation) est une adaptation délibérée, pas une fidélité totale, et
  doit être présenté comme tel dans toute documentation utilisateur
  future pour éviter une attente de comportement plus dramatique.
- **Changement de signature `isEnabled()`** (P4 + P11, § 5) : les deux
  seuls appelants existants (`onServiceAccountChanged`,
  `onAclChanged`, § 1.1) doivent rester fonctionnels sans passer le
  nouveau paramètre `account?` — à traiter en paramètre optionnel dès le
  premier changement, pas en deux passes séparées qui casseraient la
  compatibilité une première fois puis la répareraient.
- **Portée de `/resourceSACL`** (P12) : le risque principal est
  d'implémenter par erreur une portée « objets existants au moment du
  `/set` » au lieu de la portée réelle « type de ressource, y compris les
  objets créés après coup » — la différence est significative pour la
  valeur d'investigation de la fonctionnalité et facile à rater sans le
  test dédié de § 6.
- **Fidélité du SDDL (P13)** : implémenter un évaluateur SDDL minimal
  (§ 4.7) plutôt qu'un parseur complet est un choix de portée assumé ;
  si une extension future exige des ACE plus complexes (masques
  d'héritage, ACE conditionnelles), ce sera un chantier séparé plutôt
  qu'une extension ad hoc de ce mini-évaluateur.

---

## 8. Critères d'acceptation

- `auditpol /get /category:*` affiche les 9 catégories réelles comme
  titres de section, sous-catégories indentées dessous, dans le même
  format texte qu'un vrai Windows.
- `auditpol /set /subcategory:"NomInexistant"` renvoie
  `The category was not found.` et ne modifie aucun état.
- `auditpol /set /subcategory:"Logon" /success:enable` échoue avec le
  message d'élévation réel quand l'utilisateur courant n'est pas
  administrateur, et réussit sinon.
- Désactiver « Logon » (`/success:disable /failure:disable`) puis générer
  une connexion réelle (`checkPassword`) ne produit **aucun** 4624/4625 ;
  le réactiver et regénérer la même connexion en produit un.
- `auditpol /backup /file:X` suivi de `auditpol /clear /y` puis
  `auditpol /restore /file:X` restaure exactement l'état précédent
  (comparaison champ à champ).
- Un `WindowsServer` fraîchement promu DC affiche par défaut au moins les
  7 sous-catégories déjà activées manuellement dans
  `scenario-ad-security-audit-events.test.ts`, sans que ce test n'ait
  besoin d'être modifié.
- La suite complète `src/__tests__/unit/network-v2/` passe sans
  régression après chaque phase P1-P6 (vérifié phase par phase, pas
  seulement en fin de plan).
- `auditpol /get /option:CrashOnAuditFail` puis `/set
  /option:CrashOnAuditFail /value:enable` persistent et se relisent
  correctement ; remplir le journal `Security` (rétention
  `DoNotOverwrite`) déclenche ensuite le blocage documenté en § 2.1 P10,
  levé par une remédiation administrative.
- `auditpol /set /user:bob /category:"Logon" /exclude
  /success:enable /failure:enable` supprime les 4624/4625 du compte
  `bob` spécifiquement, sans affecter les connexions des autres comptes.
- `auditpol /resourceSACL /set /type:File /success` fait apparaître un
  4663 pour un fichier créé **après** la commande, sans qu'aucune SACL
  n'ait été posée sur ce fichier précis.
- `auditpol /get /sd` puis `/set /sd:<SDDL>` avec un SDDL excluant
  l'administrateur courant fait échouer son prochain `auditpol /set`
  avec un message d'accès refusé, alors qu'il passait avant ce réglage.
- `auditpol /get /r` produit une sortie identique (hors métadonnées de
  fichier) à `auditpol /backup /file:X` suivi d'une lecture de `X`.
