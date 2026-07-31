# PRD — Winlogon : fidélité du processus d'ouverture/verrouillage de session Windows

**Version** : 1.0
**Date** : 2026-07-31
**Projet** : Ubuntu Sandbox — Module Windows (sécurité, session, audit)
**Auteur** : Claude Code
**Références normatives** : comportement observable de `winlogon.exe`/
`LogonUI.exe` sur Windows 10/11 et Windows Server (SAS, verrouillage de
poste, RDP/Terminal Services), schéma des événements Security 4624/4625/
4634/4647/4648/4672/4673/4688/4778/4779/4800-4803, déjà en partie
documenté dans ce dépôt par `PRD-Auditpol.md` (catalogue des sous-
catégories) et par le code de `WindowsSecurityAudit.ts`. Ce PRD est un
PRD de **fiabilisation et de complétion**, pas greenfield : une part
substantielle de la mécanique (audit 4624/4625/4634, `checkPassword`,
`tryDomainAuth`, catalogue `auditpol`) existe déjà et est réutilisée sans
duplication (§ 0.2) ; ce qui manque réellement est identifié en § 1.2.

---

## 0. Contexte et portée du document

`winlogon.exe` est le processus Windows qui gouverne tout le cycle de
vie d'une session interactive : la séquence d'attention sécurisée (SAS,
Ctrl+Alt+Suppr), l'invite d'identifiants (`LogonUI.exe`), le verrouillage
et le déverrouillage du poste, l'écran de veille protégé par mot de
passe, et — pour une session distante — l'équivalent Terminal
Services/RDP de ces mêmes transitions (connexion, déconnexion sans
fermeture, reconnexion). C'est aussi le point d'origine réel d'une bonne
partie des événements Security déjà modélisés dans ce dépôt (4624/4625/
4634/4672) et de plusieurs qui ne le sont pas encore (4648 dynamique,
4778/4779, 4800-4803).

Une recherche exhaustive préalable (§ 1) a établi qu'aujourd'hui,
l'ouverture d'un terminal Windows dans ce simulateur ne passe par
**aucune** vérification d'identité — `WindowsTerminalSession` appelle
directement `device.openShellSession()`, qui prend l'utilisateur depuis
`%USERNAME%` sans jamais consulter `checkPassword`. C'est un précédent
délibéré et symétrique de celui déjà en place côté Linux
(`LinuxTerminalSession` fait exactement la même chose avec
`LinuxMachine.openShellSession()`) : l'accès physique/console local est
traité comme déjà authentifié, à l'image de la convention qu'un
formateur qui s'assoit devant un poste de labo y a déjà un accès
légitime. Ce PRD **ne remet pas en cause cette convention** (§ 2.2) —
imposer un SAS obligatoire à l'ouverture de chaque terminal casserait
des centaines de tests existants pour un gain de fidélité qu'aucun
scénario ne demande.

Ce que ce PRD cible à la place, c'est le territoire de Winlogon
réellement inoccupé et testable indépendamment : le verrouillage/
déverrouillage de poste après ouverture de session (qui, lui,
n'existe nulle part aujourd'hui), la fidélité de l'audit RDP (mal
étiqueté et non corrélé), un modèle d'élévation UAC réel au lieu d'une
heuristique de nom de compte, et deux défauts de fidélité déjà présents
dans le mécanisme d'audit qui doivent être corrigés en fondation avant
d'y accrocher de nouveaux événements.

### 0.1 Chaîne de dépendances

```
WindowsUserManager (livré : checkPassword, politique de verrouillage LSA,
  bus windows.account.logon/logoff) / WindowsPC.tryDomainAuth (livré :
  LDAP simple bind réel) / WindowsSecurityAudit + Projection (livré :
  4624/4625/4634/4672/4673/4688 réels, TargetLogonId, LogonType,
  SubStatus, PrivilegeList, TokenElevationType/MandatoryLabel) /
  WindowsAuditCategoryCatalog (livré : catalogue auditpol qui connaît
  déjà 4648/4778/4779/4800-4803/4964 sans qu'aucun ne soit jamais émis)
        │
        ▼
PRD-Winlogon.md                                            ◄── VOUS ÊTES ICI
   P1 fondations d'audit (double 4624 SSH, Subject figé) ·
   P2 verrouillage/déverrouillage de poste (4800/4801) ·
   P3 écran de veille (4802/4803) ·
   P4 fidélité RDP (LogonType 10, corrélation logoff, 4778/4779) ·
   P5 UAC réel (4648 dynamique, jeton limité %%1938)
        ▼
(aucun consommateur PRD identifié — winlogon est, comme wecutil/netdom/
 repadmin déjà livrés dans ce dépôt, une brique terminale de fidélité
 d'audit, pas une dépendance d'un futur PRD)
```

Aucune dépendance bloquante : tout le code réutilisé (§ 0.2) est déjà en
production et déjà exercé par les scénarios `scenario-windows-*-audit*`
existants.

### 0.2 Ce que ce PRD réutilise sans le dupliquer

| Besoin Winlogon | Brique déjà livrée réutilisée | Fichier |
|---|---|---|
| Vérification de mot de passe local, politique de verrouillage LSA | `WindowsUserManager.checkPassword` | `src/network/devices/windows/WindowsUserManager.ts:475-505` |
| Authentification de domaine (bind LDAP réel) | `WindowsPC.tryDomainAuth` | `src/network/devices/WindowsPC.ts:1224` |
| Émission d'événements Security réels à partir d'événements de bus | `WindowsSecurityAudit`/`WindowsSecurityAuditProjection` (précédent exact : "un générateur d'événement existe déjà, il manque le point d'accroche") | `src/network/devices/windows/WindowsSecurityAudit.ts`, `WindowsSecurityAuditProjection.ts` |
| Corrélation logon→logoff par `TargetLogonId` | `WindowsSecurityAuditProjection.openSessions` (déjà utilisé pour SSH) | `WindowsSecurityAuditProjection.ts:108-136` |
| Catalogue `auditpol` qui gouverne déjà si un sous-événement doit être audité | `WindowsAuditCategoryCatalog`/`WindowsAuditPolicy` (4648/4778/4779/4800-4803/4964 déjà catalogués, `Logon`/`Special Logon` déjà actifs par défaut) | `src/network/devices/windows/WindowsAuditCategoryCatalog.ts:38-48`, `WindowsAuditPolicy.ts:54,57` |
| Requête/filtrage XPath pour `Get-WinEvent`/`wevtutil` | `WinEventXPath.ts` — générique sur `System`/`EventData`, aucun changement requis pour interroger de nouveaux EventID | `src/network/devices/windows/WinEventXPath.ts` |
| Précédent "politique de registre gate une émission d'événement conditionnelle" | `WinPowerShellLogging.ts` (Script Block Logging gated par une clé de stratégie) — imité, pas partagé, pour la bannière légale GPO (P2) | `src/network/devices/windows/WinPowerShellLogging.ts` |
| Session RDP réelle (TLS, CredSSP, table de sessions) | `RdpSession.ts`/`RdpServerHandler`/`RdpSessionTable` — connexion réseau réelle déjà en place, seul l'accrochage vers l'audit manque (P4) | `src/network/devices/windows/server/rdp/RdpSession.ts` |
| Bannière de connexion GPO déjà stockée | `WindowsPC.gpoLogonBanner` (déjà posé par GPO, déjà surfacé passivement dans `gpresult /r`) | `src/network/devices/WindowsPC.ts:1363,1399,1443-1445` |
| Précédent "callback de rapport d'authentification distinct du moteur d'auth lui-même" | `getSshServerContext()`'s paramètre `reportLogon`/`reportLogoff` — même patron réutilisé pour RDP (P4) | `src/network/devices/WindowsPC.ts:964-989` |

Ce PRD n'ajoute de nouvelle plomberie que là où § 1.2 identifie un vrai
trou : l'état de verrouillage de poste, l'écran de veille, l'accrochage
RDP vers l'audit, et un modèle d'élévation UAC réel.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `WindowsTerminalSession.ts:113-123` | Constructeur de session terminal | Appelle `device.openShellSession()` directement — aucune invite d'identifiants, aucun SAS ; précédent symétrique côté Linux (`LinuxTerminalSession.ts:356-377`, même comportement) |
| `WindowsPC.ts:4495-4507` (`openShellSession`) | Allocation d'un shell `cmd.exe` | Prend l'utilisateur depuis `%USERNAME%`, aucun appel à `checkPassword` |
| `WindowsUserManager.ts:475-505` (`checkPassword`) | Vérification de mot de passe local | **Publie inconditionnellement** `windows.account.logon` avec `logonType: 2` codé en dur, quel que soit l'appelant (bogue confirmé, § 1.2 point 1) |
| `WindowsPC.ts:964-989` (`getSshServerContext`) | Contexte serveur SSH | Fournit un callback `reportLogon` qui republie `windows.account.logon` avec `logonType: 10` — **en plus** de celui déjà publié par `checkPassword` lui-même (bogue confirmé) |
| `WindowsSshServerContext.ts:251-260` (`buildAuthContext().checkPassword`) | Authentification SSH | Appelle `userManager.checkPassword` (publie type 2) **et** `this.reportLogon?.(user, ok)` (publie type 10) pour la même tentative — **une connexion SSH génère deux entrées 4624/4625, une avec le mauvais LogonType** |
| `WindowsPC.ts:840-852` (listener RDP, port 3389) | Authentification RDP | `checkLocal` appelle `this.userMgr.checkPassword(u, p)` directement — aucun override de `logonType`, donc **une connexion RDP journalise toujours LogonType 2 (Interactive), jamais 10 (RemoteInteractive)** |
| `RdpSession.ts:123-157` (`RdpSessionTable`) | Table des sessions RDP | `create()` publie `rdp.session.established` (pas `windows.account.logon`) ; `logoff()` publie `rdp.session.closed` (pas `windows.account.logoff`) — **le canal d'audit Security n'est jamais informé d'une session RDP, ni à l'ouverture ni à la fermeture** |
| `RdpSession.ts:127` (type `RdpSessionState.state`) | État de session | Déclare `'Active' \| 'Disconnected'` mais **aucun code n'affecte jamais `'Disconnected'`** — seule la fermeture complète (`logoff`, suppression de l'entrée) existe ; la vraie distinction Windows entre "déconnexion sans fermeture" (4779) et "fermeture de session" (4634/4647) est absente |
| `RdpSession.ts:196-210` (`RdpServerHandler.register`) | Poignée de main RDP/CredSSP | `verifyCredSsp` décide `ok`, `sessions.create()` est appelé — point d'accroche exact pour publier `windows.account.logon`/`logonType: 10` (précédent SSH § 0.2) |
| `WindowsSecurityAudit.ts:103` (constante `SUBJECT`) | Bloc "Subject:" générique | `'Subject:\n\tSecurity ID:\t\tS-1-5-21\n\tAccount Name:\t\tAdministrator'` — **codé en dur**, ajouté sans condition par `success()`/`failure()` (lignes 391-397) à **tout** événement qui ne construit pas son propre bloc Subject dynamique |
| `WindowsSecurityAudit.ts` (`logonSuccess`/`logonFailure`/`logoff`/`accountLockedOut`/`processTerminated`/`accountCreated`/`accountDeleted`/`accountEnabled`/`accountDisabled`/`passwordReset`/`accountChanged`/`groupCreated`/`groupDeleted`/`groupMemberAdded`/`groupMemberRemoved`) | ~14 générateurs d'événements | Tous passent par `success()`/`failure()` **sans** fournir leur propre Subject dynamique → héritent du "Administrator" figé, quel que soit qui a réellement déclenché l'action |
| `WindowsSecurityAudit.ts` (`specialPrivileges`/`registryValueModified`/`scheduledTaskCreated`/`auditLogCleared`/`objectAccessed`/`shareAdded`/`shareAccessed`/`permissionChanged`/`serviceInstalled`) | ~9 autres générateurs | **Déjà corrects** — construisent leur propre ligne `Subject:\n\tAccount Name:\t${realActor}` dans le message avant l'appel à `success()`/`failure()`, donc pas concernés par le bogue |
| `WindowsSecurityAudit.ts:232-250` (`processCreated`) | 4688 — création de processus | `data.SubjectUserName`/`TokenElevationType`/`MandatoryLabel` déjà réels — mais `elevated = isElevatedAccount(details.owner)` (§ 1.1 suivant) est une **heuristique de nom**, pas un modèle d'élévation |
| `WindowsSecurityAudit.ts` (`isElevatedAccount`) | Détection d'élévation | Simple test regex sur le nom de compte (`administrator`/`system`/`*admin`) — jamais `%%1938` (jeton limité/filtré), donc le cas réel "utilisateur standard membre du groupe Administrateurs, élévation UAC via consentement" n'est jamais représenté |
| `WinRunas.ts:87-98` (`runAsUser`) | `runas` | Déclenche `host.onLogon?.(userName)` → toujours `logonType: 2` ; aucune distinction `/netonly` ; **4648 (logon à identifiants explicites) n'est jamais régénéré dynamiquement** |
| `PSEventLogProvider.ts:102` | Seed statique | Une unique entrée 4648 de démonstration posée au démarrage — jamais régénérée par un vrai `runas` |
| `WindowsAuditCategoryCatalog.ts:38-48` | Catalogue `auditpol` | `Special Logon` gouverne déjà `[4672, 4964]`, `Other Logon/Logoff Events` gouverne déjà `[4649, 4778, 4779, 4800, 4801, 4802, 4803]` — **catalogués et acceptés par `auditpol /get`/`/set` mais aucun n'est jamais émis** |
| `WindowsAuditPolicy.ts:54,57` | Baseline d'audit | `Logon`/`Special Logon` activés par défaut (`success:true, failure` selon le cas) — les nouveaux événements de ce PRD seront donc audités par défaut, sans configuration supplémentaire à documenter dans les tests |
| `AccountLockoutPolicy.ts` (Linux) vs `WindowsAccountsPolicy` (Windows, `WindowsUserManager.ts:112`) | Politiques de verrouillage | Deux implémentations indépendantes mais déjà équivalentes fonctionnellement — aucune divergence à corriger |
| `scenario-windows-logon-session-audit.test.ts`, `scenario-windows-privilege-uac-audit.test.ts` | Scénarios "gap confirmé" | **Déjà entièrement verts** (vérifié par exécution directe) — les intitulés "gap confirmé : X n'existe jamais" datent d'avant la correction du 2026-07-29 (commit `6e2d1e16`) et sont **obsolètes dans leur libellé**, pas dans leur comportement ; ce PRD ne les recible pas (§ 1.2 point 6) |

### 1.2 Constats-clés

1. **Bogue réel confirmé — double 4624/4625 côté SSH** : `checkPassword`
   (`WindowsUserManager.ts:500-503`) publie systématiquement
   `windows.account.logon` avec `logonType: 2`, et
   `WindowsSshServerContext.buildAuthContext().checkPassword` republie
   un second événement avec `logonType: 10` via `reportLogon`. Vérifié
   par lecture directe des deux sites d'appel : une connexion SSH
   réussie génère **deux** entrées Security 4624, dont une avec
   `LogonType: 2` (Interactive) au lieu du seul `LogonType: 10`
   (RemoteInteractive) qui devrait exister. Racine : `checkPassword` ne
   devrait jamais décider seul du `logonType` — c'est à l'appelant (SSH,
   RDP, console locale, `runas`) de le préciser.
2. **Bogue réel confirmé — Subject figé sur "Administrator"** :
   `WindowsSecurityAudit.ts:103` définit une constante `SUBJECT` ajoutée
   sans condition par `success()`/`failure()`. Quatorze générateurs
   d'événements (§ 1.1) en héritent sans jamais fournir le vrai
   déclencheur — un `logonSuccess('alice', ...)` produit un message
   Security dont le bloc `Subject:` affirme "Account Name: Administrator"
   même quand alice elle-même vient de se connecter. C'est une faille de
   fidélité qui touche directement "qui s'est connecté" — le cœur d'un
   PRD Winlogon — et qui doit être corrigée avant d'ajouter de nouveaux
   événements dessus (P2-P5), sous peine de leur faire hériter du même
   défaut.
3. **RDP n'est pas branché sur l'audit Security du tout** :
   confirmé par lecture complète de `RdpSession.ts` — `RdpSessionTable`
   ne publie que `rdp.session.established`/`rdp.session.closed`,
   jamais `windows.account.logon`/`windows.account.logoff`. Une
   connexion RDP réussie ou échouée ne produit **aucune** entrée 4624/
   4625/4634 aujourd'hui, malgré une pile TLS/CredSSP/TCP entièrement
   réelle en dessous.
4. **Aucun concept de verrouillage de poste, d'écran de veille, ou de
   permutation rapide d'utilisateur n'existe** — recherche exhaustive
   (`rundll32.*LockWorkStation`, `tsdiscon`, `4800`, `4801`, `4802`,
   `4803` dans tout `src/network/devices/windows/`) : zéro résultat. Le
   catalogue `auditpol` connaît déjà ces quatre EventID (constat
   précédent) mais rien ne peut jamais les déclencher.
5. **UAC est une heuristique de nom de compte, pas un modèle** —
   `isElevatedAccount()` fait un test regex sur le nom
   (`administrator`/`system`/`*admin`). Un utilisateur standard membre
   du groupe local `Administrators` qui élève via consentement UAC (cas
   le plus courant en pratique) n'est jamais distingué d'un compte admin
   en session directe — les deux produisent le même `TokenElevationType:
   %%1937`, alors que le cas réel `%%1936` (jeton par défaut, non admin)
   et `%%1938` (jeton limité — admin qui n'a PAS élevé) devraient
   coexister. Le champ `%%1938` n'apparaît nulle part dans le code.
6. **Les tests "gap confirmé" liés à Winlogon sont déjà clos** : exécution
   directe de `scenario-windows-logon-session-audit.test.ts` et
   `scenario-windows-privilege-uac-audit.test.ts` (17 tests) confirme
   qu'ils passent tous intégralement aujourd'hui — le commit `6e2d1e16`
   ("*une seule horloge, et des événements qui portent leurs champs*",
   2026-07-29) a déjà fermé `LogonType`/`TargetLogonId`/`SubStatus`/
   `PrivilegeList`/4673/`TokenElevationType`/`MandatoryLabel`, sans
   renommer les intitulés `it()` qui les décrivaient encore comme des
   trous. Ce PRD ne recible **pas** ces champs déjà livrés — seul un
   renommage cosmétique des intitulés obsolètes serait pertinent, hors
   périmètre fonctionnel de ce document.
7. **`tryDomainAuth`/`checkPassword` sont déjà génériques et prêts à être
   réutilisés pour un déverrouillage** — même précédent que
   `WindowsTerminalSession.verifyRemoteCredentials`
   (`WindowsTerminalSession.ts:1193-1238`), qui consulte déjà
   `tryDomainAuth` puis `checkPassword` dans cet ordre pour valider des
   identifiants distants ; un déverrouillage de poste (P2) suit
   exactement le même ordre de résolution, en local.
8. **`socket.onClose` existe déjà sur `TcpSocket`** (`TcpStack.ts:234`,
   déjà câblé par d'autres listeners via `opts.onClose`) — précédent
   direct pour détecter une déconnexion RDP réseau (câble coupé, client
   fermé) distincte d'un `logoff` explicite, nécessaire à la distinction
   4779 (déconnexion) / 4634+4647 (fermeture) de P4.

### 1.3 Précédents architecturaux exacts (grounding)

**Paramètre optionnel plutôt que nouvelle méthode, pour ne pas dupliquer
un générateur d'événement existant** (précédent pour P1) :
`logonSuccess(name, logonType = 2, ...)` accepte déjà un `logonType`
explicite avec valeur par défaut — le même patron s'applique à
`success()`/`failure()` : un paramètre `actor` optionnel (par défaut
`'SYSTEM'`, jamais plus "Administrator" par défaut) qui, s'il est fourni,
remplace la constante `SUBJECT` figée.

**Callback de rapport d'authentification séparé du moteur d'auth lui-même**
(précédent exact pour P1 et P4) : `getSshServerContext()`
(`WindowsPC.ts:964-989`) construit déjà `WindowsSshServerContext` avec
deux callbacks `(user, success) => ...` / `(user) => ...` distincts de la
logique `checkPassword` elle-même — P1 retire la publication interne à
`checkPassword` au profit d'un appelant qui précise toujours son
`logonType`, et P4 fournit exactement le même couple de callbacks à
`RdpServerContext`.

**Corrélation logon→logoff par LUID** (précédent exact pour P2 et P4) :
`WindowsSecurityAuditProjection.openSessions`
(`WindowsSecurityAuditProjection.ts:108-136`) associe déjà un 4624 à son
4634 via `TargetLogonId` pour SSH — le verrouillage (P2, un 4800 sans
`TargetLogonId` nouveau puisqu'il ne clôt pas la session) et RDP (P4, un
vrai nouveau 4624/4634 par connexion) suivent ce même mécanisme sans le
dupliquer.

**Résolution d'identifiants locale puis domaine, dans cet ordre**
(précédent exact pour le déverrouillage, P2) :
`WindowsTerminalSession.verifyRemoteCredentials`
(`WindowsTerminalSession.ts:1193-1238`) — `tryDomainAuth` d'abord (si la
machine est jointe à un domaine et le nom est qualifié), puis
`checkPassword` local en repli. Le déverrouillage de poste réutilise
cette même fonction de résolution (extraite en méthode partagée plutôt
que dupliquée, § 4.2).

**Politique de registre qui gate une émission d'événement conditionnelle**
(précédent pour la bannière légale de P2) : `WinPowerShellLogging.ts`
lit une clé `HKLM\SOFTWARE\Policies\Microsoft\Windows\PowerShell\...`
pour décider si le Script Block Logging doit émettre 4104 — le même
patron (lire `gpoLogonBanner`, déjà posé par GPO, § 0.2) décide si le
verrouillage/déverrouillage affiche un texte légal avant l'invite de mot
de passe.

---

## 2. Objectifs

### 2.1 Objectifs (phases TDD, chacune livrable et testable indépendamment)

- **P1 — Fondations d'audit : Subject réel, `logonType` porté par
  l'appelant** :
  - `checkPassword(name, password, logonType = 2)` accepte un
    `logonType` explicite au lieu de le figer ; **ne publie plus lui-même**
    `windows.account.logon` — la publication devient la responsabilité de
    l'appelant (console locale, `runas`, RDP), suivant le précédent SSH
    déjà en place (`reportLogon`, § 1.3). Le chemin SSH est corrigé pour
    ne plus publier deux fois (une seule publication, `logonType: 10`,
    via `reportLogon`) ; le chemin RDP et le futur verrouillage (P2)
    fournissent chacun leur propre `logonType` correct (10 pour RDP, 2
    pour un déverrouillage local).
  - `WindowsSecurityAudit.success()`/`failure()` acceptent un `actor`
    optionnel qui, fourni, remplace le bloc `SUBJECT` figé (§ 1.3) ;
    `logonSuccess`/`logonFailure`/`logoff`/`accountLockedOut`/
    `processTerminated`/les six générateurs de compte/groupe passent
    désormais le vrai acteur (le compte qui se connecte, ou l'appelant
    de l'opération administrative) au lieu d'hériter silencieusement
    d'"Administrator".
- **P2 — Verrouillage / déverrouillage de poste** :
  - État réel `locked: boolean` + `lockedBy: string | null` sur
    `WindowsPC` (pas par `WindowsShellSession` — un verrouillage Windows
    couvre toute la session interactive du poste, pas une seule fenêtre
    de terminal, § 4.1).
  - `lockWorkstation()` (déclenchée par la commande console
    `rundll32 user32.dll,LockWorkStation` déjà reconnaissable comme
    commande cmd, et par un raccourci `lock` dédié pour la fidélité de
    labo) pose `locked = true`, `lockedBy = <utilisateur courant>` et
    émet un 4800 (`Auditable Privileges`/`Special Logon` catalogue déjà
    actif, § 1.1) via le nouvel `actor` de P1.
  - Tant que `locked`, `executeCommand`/`executeCmdCommand` refusent
    toute commande avec un message fidèle
    (`This computer is locked. Only <user> or an administrator can
    unlock this computer.`), sur **tous** les terminaux ouverts sur la
    machine (précédent : un verrouillage Windows bloque toutes les
    fenêtres du bureau, pas une seule invite).
  - `unlockWorkstation(user, password)` réutilise la résolution
    identifiants locale→domaine déjà pratiquée par
    `verifyRemoteCredentials` (§ 1.3, extraite en méthode partagée) ;
    succès → `locked = false`, 4801 ; échec → le poste reste verrouillé,
    4625 (`logonType: 7`, valeur réelle Windows pour un déverrouillage)
    est généré comme pour toute tentative échouée.
  - Si `gpoLogonBanner` est posé (§ 0.2), son texte est affiché avant
    l'invite de mot de passe du déverrouillage — seule surface où la
    bannière légale devient réellement visible dans un flux interactif
    (`gpresult /r` restant, en plus, la lecture passive déjà livrée).
- **P3 — Écran de veille protégé** : réutilise l'état de P2 (un écran de
  veille protégé par mot de passe *est* un verrouillage, côté Windows) ;
  ajoute uniquement la distinction d'origine (`lockedBy: 'screensaver'`
  vs `'user'`) pour émettre 4802 (invocation de l'écran de veille) au
  lieu de 4800, et 4803 (fermeture) au lieu de 4801, sur le même
  mécanisme de verrouillage — aucune nouvelle machine à états.
- **P4 — Fidélité RDP** :
  - `RdpServerContext` gagne les mêmes callbacks `reportLogon`/
    `reportLogoff` que `WindowsSshServerContext` (§ 1.3) ; le listener
    RDP de `WindowsPC.ts` les fournit avec `logonType: 10`
    (RemoteInteractive, valeur réelle Windows pour RDP).
  - `RdpSessionTable` distingue désormais réellement `'Active'`/
    `'Disconnected'` : `socket.onClose` (§ 1.2 point 8) sans `logoff()`
    explicite préalable transitionne vers `'Disconnected'` et émet 4779
    (session déconnectée) au lieu de 4634 ; un `logoff()` explicite
    (commande `logoff`/`rwinsta`) émet 4634 (logoff de session) — la
    même corrélation par `TargetLogonId` que SSH (§ 1.3) associe chaque
    fermeture/déconnexion à son 4624 d'origine.
  - Une reconnexion sur une session `'Disconnected'` existante (même
    utilisateur, nouvelle connexion CredSSP) émet 4778 (session
    reconnectée) plutôt qu'un nouveau 4624 — fidèle au comportement réel
    de Terminal Services, où une reconnexion à une session déconnectée
    ne crée pas de nouvelle session logique.
- **P5 — Élévation UAC réelle** :
  - Remplace `isElevatedAccount()` (heuristique de nom) par un état
    d'élévation porté par le contexte d'exécution : une commande lancée
    via `runas /user:<admin>` (élévation explicite) porte
    `TokenElevationType: %%1937` (Full) ; une session ouverte
    directement comme administrateur (RDP/console/domaine) sans passer
    par `runas` porte `%%1936` (Default) ; **nouveau** — un compte membre
    du groupe local `Administrators` qui exécute une commande **sans**
    élévation porte `%%1938` (Limited, jeton filtré), le cas réel UAC le
    plus fréquent, jusqu'ici totalement absent.
  - `runas` régénère dynamiquement 4648 (logon à identifiants explicites)
    à chaque appel, avec le vrai compte cible en `TargetUserName` (au
    lieu de l'unique entrée statique de démonstration, § 1.1) — réutilise
    l'`actor` de P1 pour le Subject (le compte *appelant*, distinct du
    compte *cible*, comme le fait réellement Windows sur 4648).

### 2.2 Non-objectifs

- **SAS obligatoire à l'ouverture d'un nouveau terminal (console locale)** :
  romprait le précédent déjà établi et symétrique Linux/Windows (§ 0),
  affecterait des centaines de tests existants qui ouvrent un terminal
  et s'attendent à un shell immédiatement utilisable, sans qu'aucun
  scénario ne demande cette friction. Le verrouillage (P2) couvre le
  besoin réel de fidélité Winlogon (un poste *peut* redemander un mot de
  passe) sans casser l'ouverture initiale.
- **Permutation rapide d'utilisateur (fast user switching)** : aucune
  session interactive concurrente n'est modélisée dans ce simulateur (un
  poste = un `WindowsPC` = un bureau) ; ajouter plusieurs sessions
  utilisateur simultanées sur la même machine serait un chantier de
  modélisation disproportionné sans consommateur identifié.
- **Isolation Session 0 (services vs session utilisateur)** : les champs
  `sessionId`/`ProcessSession` du catalogue de processus restent
  décoratifs (§ 1.1 des recherches, non détaillé ici faute de constat
  précis dans ce PRD) — aucun scénario n'exerce une distinction
  service/session utilisateur observable ; hors périmètre.
- **Ouverture de session de domaine interactive via un nouveau flux de
  console** : `WindowsPC.logonDomain()` (acquisition de TGT Kerberos
  réelle) reste, comme aujourd'hui, consommée uniquement par l'API/les
  tests directs — le brancher sur un flux console interactif supposerait
  d'abord un flux console interactif, que ce PRD n'introduit
  délibérément pas (point précédent). Le déverrouillage de poste (P2)
  utilise `tryDomainAuth` (bind LDAP simple, déjà réel) et non
  `logonDomain()` (Kerberos complet) — cohérent avec le fait qu'un
  déverrouillage Windows réel ne réacquiert pas nécessairement un
  nouveau TGT si la session en détient déjà un.
- **Écran de veille déclenché par une vraie minuterie d'inactivité** :
  P3 expose le mécanisme (`invokeScreensaver()`/`dismissScreensaver()`)
  comme des actions explicites déclenchables (commande, ou appel de
  test), pas comme un minuteur d'inactivité réel qui tournerait en
  arrière-plan sur chaque session ouverte — aucun scénario ne mesure un
  vrai délai d'inactivité, et un minuteur réel par session ouverte serait
  un coût de simulation sans bénéfice observable.
- **4964 (Special Groups Assigned to a New Logon)** : catalogué par
  `auditpol` (§ 1.1) mais nécessite un concept de "groupes spéciaux"
  configurés (`SeSpecialGroups` dans le registre) qu'aucun scénario ne
  configure ni ne vérifie — laissé pour un futur PRD ciblé si un
  scénario l'exige un jour, plutôt que d'être ajouté sans consommateur.
- **`%%1938` pour RDP/SSH** (P5 le limite à l'exécution de commande
  locale/`runas`) : RDP et SSH authentifient déjà un utilisateur
  précis avec un groupe connu (§ P4/existant) ; élargir le modèle de
  jeton filtré à ces deux chemins recouperait P4/l'existant sans ajouter
  de fidélité observable supplémentaire pour ce PRD — laissé en
  extension naturelle si un scénario futur le demande.

---

## 3. Architecture cible

```
Ouverture initiale de terminal (console locale) — INCHANGÉ (§ 2.2)
  WindowsTerminalSession → device.openShellSession()   (aucune vérification,
                                                          précédent conservé)

Verrouillage / déverrouillage de poste (P2, P3)
  cmd> rundll32 user32.dll,LockWorkStation
  cmd> lock                                    (raccourci de labo)
    │
    ▼
  WindowsPC.lockWorkstation(origin: 'user' | 'screensaver')
    │  locked = true; lockedBy = currentUser
    │  WindowsSecurityAudit.workstationLocked(currentUser, origin)  (P2: 4800, P3: 4802)
    ▼
  [ Toute commande sur TOUT terminal de cette machine refusée tant que locked ]

  cmd (n'importe quel terminal)> <mot de passe saisi>
    │
    ▼
  WindowsPC.unlockWorkstation(user, password)
    │  resolveLocalOrDomainCredentials(user, password)   (P1/§1.3, partagée
    │                                                      avec verifyRemoteCredentials)
    ├─ échec → 4625 (logonType 7) ; locked reste true
    └─ succès → locked = false ; 4801 (P2) / 4803 (P3)

RDP (P4)
  RdpServerHandler.register()                            (existant, TLS/CredSSP réels)
    │  verifyCredSsp(ctx.auth, req) → ok
    ▼
  ok=true, session NOUVELLE (pas de session Disconnected pour cet user)
    ├─ sessions.create(user, ip)                          (existant)
    └─ reportLogon(user, true, logonType: 10)  (nouveau)   → 4624 réel

  ok=true, session EXISTANTE en 'Disconnected' pour cet user
    └─ reportReconnect(user)  (nouveau)                    → 4778 (pas de nouveau 4624)

  ok=false
    └─ reportLogon(user, false, logonType: 10)  (nouveau)  → 4625 réel

  socket.onClose (sans logoff() explicite préalable)
    │  sessions → 'Disconnected'                           (nouveau)
    └─ reportDisconnect(user)  (nouveau)                    → 4779

  WinRdpCommands: logoff/rwinsta → sessions.logoff()        (existant)
    └─ reportLogoff(user, logonType: 10)  (nouveau)          → 4634

UAC (P5)
  WinRunas.runAsUser(user, password, target, netonly?)     (existant, étendu)
    │  checkPassword(target, password, logonType: 2)        (P1: appelant précise le type)
    ├─ échec → 4625
    └─ succès → 4648 dynamique (Subject = appelant, TargetUserName = target)  (nouveau)
                TokenElevationType selon origine :
                  runas sans -netonly, cible admin  → %%1937 (Full)
                  session ouverte directement admin → %%1936 (Default)
                  compte admin, PAS élevé            → %%1938 (Limited, nouveau)
```

Aucune seconde implémentation de l'audit Security, du moteur
d'authentification ou de la pile RDP : ce PRD ajoute un état de
verrouillage sur `WindowsPC`, deux nouveaux callbacks de rapport sur le
contexte RDP (même patron que SSH), et un état d'élévation réel qui
remplace une heuristique.

---

## 4. Modèle de données

### 4.1 État de verrouillage (`WindowsPC`, P2/P3)

```ts
// WindowsPC
private locked = false;
private lockedBy: string | null = null;
private lockOrigin: 'user' | 'screensaver' | null = null;

lockWorkstation(origin: 'user' | 'screensaver' = 'user'): void {
  if (this.locked) return;                 // idempotent, comme le vrai SAS
  this.locked = true;
  this.lockedBy = this.getCurrentInteractiveUser();  // § 4.2
  this.lockOrigin = origin;
  this.security.workstationLocked(this.lockedBy, origin);   // 4800 (P2) / 4802 (P3)
}

unlockWorkstation(user: string, password: string): { ok: boolean; message: string } {
  if (!this.locked) return { ok: true, message: 'not locked' };
  const result = this.resolveLocalOrDomainCredentials(user, password);  // § 4.2
  if (!result.ok) {
    this.security.logonFailure(user, undefined, '0xC000006A');  // logonType 7
    return { ok: false, message: 'The user name or password is incorrect.' };
  }
  this.locked = false;
  this.security.workstationUnlocked(user, this.lockOrigin);     // 4801 (P2) / 4803 (P3)
  this.lockedBy = null;
  this.lockOrigin = null;
  return { ok: true, message: '' };
}

isLocked(): boolean { return this.locked; }
```

### 4.2 Résolution d'identifiants partagée (P1/P2)

```ts
// WindowsPC — extraite du corps de verifyRemoteCredentials
// (WindowsTerminalSession.ts:1193-1238), consommée par la session
// terminal ET par unlockWorkstation (§ 4.1), pas dupliquée.
resolveLocalOrDomainCredentials(user: string, password: string): { ok: boolean; sam: string } {
  const domainResult = this.tryDomainAuth(user, password);
  if (domainResult !== null) return { ok: domainResult.ok, sam: domainResult.sam };
  const ok = this.userMgr.checkPassword(user, password, 2);   // P1 : logonType explicite
  return { ok, sam: user };
}
```

### 4.3 `checkPassword`/`success`/`failure` étendus (P1)

```ts
// WindowsUserManager
checkPassword(name: string, password: string, logonType?: number): boolean {
  // ... logique de verrouillage/expiration inchangée ...
  // SUPPRIMÉ : la publication interne de windows.account.logon.
  // L'appelant (console, runas, RDP, unlock) publie désormais lui-même
  // avec le logonType exact qu'il connaît — précédent SSH (getSshServerContext).
  return ok;
}

// WindowsSecurityAudit
private success(eventId: number, message: string, data?: Record<string, string>, actor = 'SYSTEM'): void {
  this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'SuccessAudit',
    `${message}\n\n${subjectBlock(actor)}`, data);
}
// idem failure() ; subjectBlock(actor) remplace la constante SUBJECT figée.
```

### 4.4 Extension `RdpServerContext`/`RdpSessionTable` (P4)

```ts
export interface RdpServerContext {
  readonly tlsConfig: Omit<TlsServerConfig, 'alpnProtocols'>;
  readonly sessions: RdpSessionTable;
  readonly auth: CredSspAuthContext;
  /** Callbacks de rapport d'audit — même patron que WindowsSshServerContext
   *  (PRD-Winlogon.md §1.3). Absents pour un contexte de test synthétique
   *  qui n'a pas besoin d'audit, jamais requis pour que RDP fonctionne. */
  reportLogon?: (user: string, success: boolean) => void;      // logonType 10, § 3
  reportLogoff?: (user: string) => void;                        // 4634
  reportDisconnect?: (user: string) => void;                    // 4779
  reportReconnect?: (user: string) => void;                     // 4778
}
```

### 4.5 Élévation UAC réelle (P5)

```ts
export interface ProcessAuditDetails {
  owner?: string;
  ppid?: number;
  parentName?: string;
  commandLine?: string;
  /** Nouveau — remplace isElevatedAccount() côté appelant :
   *  'full'    → runas explicite réussi, TokenElevationType %%1937
   *  'default' → session ouverte directement en tant qu'administrateur, %%1936
   *  'limited' → compte membre d'Administrators, PAS élevé, %%1938 (nouveau cas)
   *  undefined → compte non-administrateur, %%1936 (comportement actuel préservé) */
  elevation?: 'full' | 'default' | 'limited';
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

1. **P1** en premier — aucune dépendance nouvelle, corrige deux bogues
   déjà confirmés (§ 1.2) sans ajouter de comportement observable neuf ;
   sert de fondation pour que P2-P5 ne réintroduisent pas le même défaut
   de Subject figé. Écrire d'abord un test qui capture le double 4624
   SSH actuel (rouge), corriger, vérifier qu'une seule entrée
   `LogonType: 10` est produite (vert).
2. **P2** après P1 (a besoin de l'`actor` réel pour 4800/4801, § 4.3) —
   verrouillage/déverrouillage, avec la bannière GPO en dernier sous-pas
   (dépend uniquement de `gpoLogonBanner` déjà existant, § 0.2).
3. **P3** après P2 — réutilise entièrement la machine à états de
   verrouillage, n'ajoute que la distinction d'origine et les deux
   EventID différents ; risque le plus faible du PRD.
4. **P4** après P1 (a besoin du patron `reportLogon`/callback corrigé,
   § 1.3) — indépendant de P2/P3 ; le sous-risque le plus élevé est la
   distinction `Disconnected`/reconnexion (§ 7), à tester en isolant
   d'abord `socket.onClose` seul (sans reconnexion), puis le cas de
   reconnexion.
5. **P5** en dernier, dépend de P1 (Subject réel pour 4648, § 2.1) —
   le remplacement de `isElevatedAccount()` est le changement le plus
   risqué en non-régression puisqu'il touche `processCreated`, déjà
   exercé par de nombreux tests existants (§ 7) ; migrer en préservant
   `isElevatedAccount()` comme repli implicite (`elevation` non fourni
   → comportement actuel) avant de faire passer les appelants réels
   (RDP/console/runas) au nouveau champ explicite.

### 5.1 Table récapitulative des phases

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Fondations d'audit** | `logonType` porté par l'appelant, `actor` réel remplace le Subject figé | Rien (corrige l'existant) |
| **P2 — Verrouillage/déverrouillage** | État `locked`/`lockedBy`, `lockWorkstation`/`unlockWorkstation`, 4800/4801, bannière GPO au déverrouillage | P1 |
| **P3 — Écran de veille** | Distinction d'origine sur le même mécanisme, 4802/4803 | P2 |
| **P4 — Fidélité RDP** | `reportLogon`/`reportLogoff`/`reportDisconnect`/`reportReconnect`, `logonType: 10` réel, 4634/4778/4779 | P1 |
| **P5 — UAC réel** | `elevation` explicite remplace `isElevatedAccount()`, 4648 dynamique, `%%1938` | P1 |

Chaque phase suit le cycle rouge → vert → refactor. Aucune suite
existante (`scenario-windows-logon-session-audit.test.ts`,
`scenario-windows-privilege-uac-audit.test.ts`, les scénarios `runas`/
SSH/RDP déjà verts) ne doit régresser — P1 change un comportement
observable (suppression du double 4624 SSH) qui doit être vérifié
explicitement contre la suite existante avant tout commit.

---

## 6. Stratégie de test

- **Test emblématique de P1** : une connexion SSH réussie produit
  **exactement une** entrée 4624 avec `LogonType: 10` (pas deux, pas
  `LogonType: 2`) ; `logonSuccess('alice', ...)` produit un Security dont
  le message contient `Account Name:\t\talice` dans son bloc Subject,
  pas `Administrator`.
- **Test emblématique de P2** : `rundll32 user32.dll,LockWorkStation`
  verrouille le poste, toute commande sur un second terminal ouvert sur
  la même machine échoue avec le message de verrouillage, un mot de
  passe correct sur l'un ou l'autre terminal déverrouille les deux ; un
  mot de passe incorrect laisse le poste verrouillé et génère un 4625 ;
  `Get-WinEvent` sur `Security` montre bien un 4800 puis un 4801 corrélés
  par le même utilisateur.
- **Test emblématique de P4** : une connexion RDP réussie produit un
  4624 `LogonType: 10` (pas 2) ; un `logoff`/`rwinsta` explicite produit
  un 4634 ; une déconnexion réseau brute (câble coupé pendant la
  session, `socket.onClose` sans `logoff()` préalable) produit un 4779 et
  **pas** un 4634 ; une reconnexion sur cette même session produit un
  4778 et **pas** un nouveau 4624.
- **Test emblématique de P5** : un compte membre d'`Administrators` qui
  exécute une commande sans être passé par `runas` porte
  `TokenElevationType: %%1938` sur son 4688 ; un `runas /user:Admin`
  réussi produit un 4648 dynamique dont `TargetUserName` est le compte
  cible et dont le Subject (P1) est l'appelant d'origine, distincts l'un
  de l'autre.
- **Non-régression** : `scenario-windows-logon-session-audit.test.ts`,
  `scenario-windows-privilege-uac-audit.test.ts`, tous les scénarios
  `scenario-windows-*-audit*.test.ts`, les suites `ssh-*`/RDP existantes
  passent sans modification de leurs assertions ; la suite complète
  `src/__tests__/unit/network-v2/` est vérifiée après chaque phase, avant
  tout commit (méthode déjà établie dans ce dépôt).

### 6.1 Critères unitaires détaillés, par phase

1. **P1** : deux appels consécutifs à `checkPassword` avec des
   `logonType` différents (2 puis 10, simulant deux surfaces
   d'authentification sur le même compte) produisent bien deux entrées
   avec les bons types respectifs, pas un mélange ; un événement dont
   l'appelant ne fournit **aucun** acteur (cas résiduel, ex. verrouillage
   déclenché par une politique système plutôt qu'un utilisateur) tombe
   sur `'SYSTEM'`, jamais `'Administrator'` par défaut.
2. **P2** : verrouiller un poste déjà verrouillé est un no-op silencieux
   (pas de second 4800) ; `unlockWorkstation` avec le mauvais compte
   (différent de `lockedBy`) réussit si le mot de passe est correct **et**
   que ce compte est administrateur (comportement réel Windows : un
   admin peut déverrouiller la session de quelqu'un d'autre, ce qui
   ferme la session verrouillée plutôt que de la reprendre — documenté
   comme simplification si non exercé par un test, sinon implémenté
   fidèlement) ; sinon refusé même avec un mot de passe par ailleurs
   valide pour ce compte.
3. **P3** : invoquer l'écran de veille sur un poste déjà verrouillé
   manuellement ne réémet pas de second événement (le poste est déjà
   verrouillé, § machine à états unique de P2) ; fermer l'écran de veille
   avec le bon mot de passe restaure l'accès sans jamais avoir affecté
   `lockedBy` à autre chose que l'utilisateur courant.
4. **P4** : deux sessions RDP simultanées de deux utilisateurs différents
   sur la même machine produisent des `TargetLogonId` distincts et ne se
   corrèlent jamais l'une avec l'autre (précédent SSH déjà correct pour
   ce cas, à préserver) ; un `logoff` explicite sur une session déjà
   `'Disconnected'` fonctionne toujours (ne suppose pas une session
   forcément `'Active'`).
5. **P5** : `processCreated` sans `details.elevation` (tous les appelants
   non encore migrés) préserve exactement le comportement actuel
   (`isElevatedAccount(details.owner)` en repli) — non-régression
   explicite de tous les tests `scenario-windows-process-audit-4688.
   test.ts` déjà verts ; un `runas` échoué (mauvais mot de passe) ne
   génère **pas** de 4648 (le logon à identifiants explicites suppose un
   succès, comme sur un vrai Windows — un échec reste un simple 4625).

---

## 7. Risques et points d'attention

- **P1 casse potentiellement des tests qui comptent les événements** :
  supprimer la publication interne de `checkPassword` change le nombre
  total d'événements `windows.account.logon` émis pour certains chemins
  (console locale directe via l'API, `runas`) si ces chemins ne
  publiaient QUE via `checkPassword` sans jamais fournir leur propre
  `logonType` — chaque appelant existant de `checkPassword` doit être
  audité (grep exhaustif) et, si nécessaire, doté de sa propre
  publication explicite avant de retirer celle de `checkPassword`, pour
  ne perdre aucun événement déjà correctement compté par un test
  existant (ce n'est pas seulement SSH qui doit être corrigé — RDP et
  tout futur appelant local en bénéficient, mais tout appelant
  aujourd'hui silencieux sur son propre `logonType` doit être identifié
  avant le retrait).
- **Verrouillage global machine vs par-terminal** : § 4.1 verrouille au
  niveau `WindowsPC`, pas `WindowsShellSession` — vérifier qu'aucun test
  existant n'ouvre délibérément deux terminaux sur la même machine en
  s'attendant à ce qu'ils restent indépendants l'un de l'autre (le
  précédent Linux `su`/sessions multiples reste, lui, par session — ne
  pas confondre les deux modèles en réutilisant par erreur un mécanisme
  par-session pour Windows).
- **Distinction `Disconnected`/déconnexion réseau brute vs fermeture
  volontaire (P4)** : le risque principal est un faux 4779 généré par un
  `logoff()` explicite qui ferme aussi la connexion TCP sous-jacente (et
  déclencherait alors `socket.onClose` en plus de l'appel direct) — le
  callback `reportDisconnect` ne doit être appelé par `onClose` que si
  la session existe encore dans la table à ce moment (donc pas déjà
  retirée par un `logoff()` qui aurait tourné juste avant), à garder
  explicite dans l'implémentation plutôt que de risquer un double
  événement 4634+4779 pour la même fermeture volontaire.
- **`%%1938` (P5) élargit la surface de `TokenElevationType`** :
  vérifier qu'aucun test existant n'asserte une liste fermée
  `[%%1936, %%1937]` pour ce champ (ce qui casserait dès qu'un compte
  admin non élevé apparaît) — recherche ciblée avant d'implémenter, pas
  seulement après.
- **Bannière GPO au déverrouillage (P2)** : `gpoLogonBanner` est
  aujourd'hui un champ purement passif (§ 0.2) — s'assurer que
  `gpresult /r` continue de le lire exactement comme avant (projection
  additive uniquement, jamais un déplacement de la donnée qui casserait
  la commande existante).
- **`resolveLocalOrDomainCredentials` extraite mais pas dupliquée
  (§ 4.2)** : `WindowsTerminalSession.verifyRemoteCredentials` doit être
  mis à jour pour **appeler** la nouvelle méthode partagée plutôt que de
  garder son propre corps en parallèle, sous peine de divergence future
  entre les deux chemins (login SSH/RDP distant vs déverrouillage
  local) — un seul point de vérité pour "comment résoudre des
  identifiants sur cette machine", cohérent avec le mandat du projet de
  ne jamais dupliquer une même logique.

---

## 8. Critères d'acceptation

- Une connexion SSH réussie ou échouée produit exactement une entrée
  4624/4625 avec `LogonType: 10`, jamais deux, jamais `LogonType: 2`.
- Tout événement Security généré par une action attribuable à un
  utilisateur précis (connexion, déconnexion, verrouillage,
  déverrouillage, création/suppression de compte ou de groupe) porte le
  vrai compte dans son bloc `Subject:`, jamais "Administrator" par
  défaut.
- `rundll32 user32.dll,LockWorkStation` (et la commande `lock` de
  confort) verrouille réellement le poste : toute commande sur tout
  terminal ouvert sur la machine est refusée jusqu'à un déverrouillage
  réussi ; le déverrouillage vérifie un vrai mot de passe (local ou de
  domaine) et génère 4800/4801 réels et corrects.
- L'écran de veille protégé par mot de passe réutilise le même
  mécanisme et génère 4802/4803 plutôt que 4800/4801.
- Une session RDP réussie génère un vrai 4624 `LogonType: 10` ; sa
  fermeture explicite génère 4634 ; une déconnexion réseau sans fermeture
  génère 4779 (pas 4634) ; une reconnexion à une session déconnectée
  génère 4778 (pas un nouveau 4624).
- Un compte administrateur qui exécute une commande sans élévation
  explicite porte `TokenElevationType: %%1938` ; un `runas` réussi
  régénère dynamiquement un 4648 avec le bon `TargetUserName` et le bon
  Subject (l'appelant, pas la cible).
- Les scénarios `scenario-windows-logon-session-audit.test.ts` et
  `scenario-windows-privilege-uac-audit.test.ts` existants passent
  intégralement, sans modification de leurs assertions.
- La suite complète `src/__tests__/unit/network-v2/` passe sans
  régression après chaque phase, vérifiée phase par phase, avant tout
  commit (méthode déjà établie dans ce dépôt pour les PRD précédents).
