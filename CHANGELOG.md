# Changelog

Journal des évolutions du socle `command-kernel` et de sa migration
progressive par équipement. Un push = une entrée = une fonctionnalité
complète et testée (voir `CLAUDE.md` / le framework de migration pour les
principes directeurs).

## Windows — Phase 10 : correction — élimination du passthrough opaque `execute(argv)` (sc/net/schtasks/print/auditpol/winrm)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Ce que les Phases 6/7/9 ont fait de travers, sur retour explicite de
l'utilisateur** : `MachineApi.services`/`netExe`/`scheduling`/`printing`/
`auditPolicy`/`winRm` exposaient chacun une méthode UNIQUE et opaque
`execute(argv)` qui, côté pont (`WindowsMachineApi.ts`), se contentait de
transmettre l'argv déjà tokenisé à la fonction `cmdX` legacy correspondante
(`cmdSc`, `cmdNetUser`/`cmdNetLocalgroup`/`cmdNetStart`/`cmdNetStop`/
`cmdNetShare`/`cmdNetUse`, `cmdSchtasks`, `cmdPrint`, `cmdAuditpol`,
`cmdWinrm`). La commande appelait bien `ctx.machine.X.execute(...)` — donc
« passait par MachineApi » au sens littéral — mais tout le VRAI travail
(analyse des arguments, dispatch de sous-commande, mise en forme du texte
de sortie) restait entièrement dans la fonction legacy, invoquée depuis le
pont plutôt que depuis la commande. C'est exactement le problème de la
Phase 5 (l'échappatoire `.native`) sous une forme différente : au lieu de
contourner `MachineApi` en récupérant l'objet legacy brut, on le
contournait en laissant `MachineApi` elle-même déléguer aveuglément à une
fonction externe. Un push = une fonctionnalité migrée, pas juste
redirigée.

**Correction, sous-système par sous-système** — chaque `execute(argv)`
remplacé par des primitives typées, une par opération SCM/SAM/etc réelle ;
tout l'analyse d'arguments, le dispatch de sous-commande et le texte
d'erreur/succès déplacés dans la commande elle-même :

- **`ServiceManagementApi`** (`sc`, ex-`cmdSc`, 14 sous-commandes) :
  `exists`/`displayNameFor`/`resolveName`/`isRunning`/`runningServiceNames`/
  `allServiceNames`/`pidFor` + `formatQuery`/`formatQueryEx`/`formatQc`/
  `formatDescription`/`formatQfailure` (texte déjà canonique, produit par
  les méthodes `formatScXxx` de `WindowsServiceManager` lui-même — l'objet
  vendeur réel, pas une fonction externe) + `start`/`stop`/`pause`/`resume`/
  `setStartType`/`setDependencies`/`setAccount`/`setDescription`/
  `setFailureConfig`/`create`/`delete`. `ScCommand.ts` porte maintenant
  l'intégralité du dispatch de `WinSc.ts` (`scQuery`/`scStart`/... et le
  gabarit d'erreur `[SC] ... FAILED nnnn`).
- **`UserManagementApi`/`GroupManagementApi`** étendues pour `net user`/
  `net localgroup` : `listAccountNames`/`getAccountDetail`/`createAccount`/
  `deleteAccount`/`setAccountProperty`/`callerIsAdmin`/`domainAccountNames`/
  `getDomainAccountDetail` et `listGroupNames`/`getGroupDetail`/
  `createGroup`/`deleteGroup`/`addGroupMember`/`removeGroupMember`.
- **`SmbShareApi`/`SmbSessionApi`/`NetUseApi`/`AccountsPolicyApi`**
  (nouvelles, remplacent le bloc `share`/`session`/`use`/`accounts` de
  l'ex-`NetExeApi`) : primitives d'état brutes sur les tables SMB/`net use`/
  politique de compte déjà instanciées sur `WindowsPC`.
- **`SchedulingApi`** (`schtasks`) : `isServiceRunning`/`list`/`create`/
  `delete`/`run` — `SchtasksCommand.ts` porte le dispatch `/query`/
  `/create`/`/delete`/`/run`/`/change`/`/end` et le format du tableau,
  auparavant dans `cmdSchtasks`.
- **`PrintApi`** (`print`) : `isSpoolerRunning`/`submit` — la file
  d'impression legacy (singleton module-level `QUEUES` par hostname dans
  `WinPrint.ts`, un design déjà fragile) devient un champ d'instance sur
  `WindowsPrintApi`, propre par équipement.
- **`AuditPolicyApi`** (`auditpol`) : `get`/`set` — `AuditpolCommand.ts`
  porte le parsing `/flag:"value"` et le dispatch `/get`/`/set`.
- **`WinRmApi`** (`winrm`) : `isEnabled`/`listeners`/`enable` —
  `WinrmCommand.ts` porte le dispatch `quickconfig`/`enumerate` et le
  texte figé.
- **`NetCommand`/`ScCommand`** n'importent plus AUCUNE fonction de
  `WinSc.ts`/`WinNetUser.ts`/`WinNetStart.ts`/`WinNetShare.ts`/
  `WinNetUse.ts`. Ces fichiers restent intacts et inchangés dans leur
  logique — ils servent maintenant EXCLUSIVEMENT le shim PowerShell
  synchrone (`WindowsPC.runSyncNativeCommand`), un consommateur séparé et
  légitime déjà établi (§ Phase 3), jamais retouché.

**Piège rencontré : `strictNullChecks: false` casse le narrowing sur union
discriminée.** `AccountMutationResult` a d'abord été modélisé en union
discriminée (`{ok:true} | {ok:false, error:string}`), comme on l'aurait
fait en TypeScript strict. Avec `strictNullChecks: false` (réglage du
projet, non modifié), `if (!result.ok) return result.error` échoue à la
compilation (« Property 'error' does not exist » — reproductible en
isolation, cf. `LinuxSshClient.ts`/`SshServerHandler.ts`, qui ont le même
bug préexistant sur `AccountLifecycleVerdict`, hors périmètre). Fix :
`AccountMutationResult` en interface plate `{ok: boolean; error?: string}`,
même forme que `ServiceOpResult`/`ServiceControlResult` qui n'avaient pas
le problème.

**Validation** : lot localisé de 30 fichiers (tout ce qui touche sc/net/
schtasks/print/auditpol/winrm/domain-join/winrm/kerberos/audit) comparé
au commit précédent (Phase 9, passthrough opaque) — **résultat rigoureusement
identique** (99 échecs / 906 réussites des deux côtés) : ce lot est une
correction architecturale pure, aucun changement de comportement observable.
Typecheck ciblé et ESLint propres. Smoke manuel non versionné confirmant
`sc query/qc`, `net user/localgroup/accounts/share`, `schtasks /create`+
`/query`, `auditpol /get`, `winrm quickconfig` avec des données réelles de
bout en bout.

## Windows — Phase 9 : `auditpol`, `winrm`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Contrairement aux phases précédentes, ces deux commandes étaient déjà
accessibles côté PowerShell (`runSyncNativeCommand`) mais jamais côté
`cmd.exe` — `winrm` a une couverture de test cmd conséquente
(`windows-server-winrm.test.ts`, `windows-server-domain-join.test.ts`,
`windows-domain-kerberos-migration.test.ts`, toutes déjà via
`executeCmdCommand('winrm quickconfig'/'enumerate'...)`), confirmant que
c'est bien la Phase 4 qui avait cassé le chemin cmd sans que personne ne
le remarque.

**`MachineApi.auditPolicy?: AuditPolicyApi`** et **`MachineApi.winRm?:
WinRmApi`** — même schéma `execute(argv)` que `SchedulingApi`/`PrintApi` :
`cmdAuditpol`/`cmdWinrm` ne prenaient déjà qu'un seul objet d'état
(`WindowsAuditPolicy`/`WindowsWinRmConfig`, déjà instanciés séparément sur
`WindowsPC`), donc aucun narrowing de contexte nécessaire cette fois — le
plus simple des ponts de cette série.

**Validation** : `windows-server-winrm.test.ts` (11/11), `windows-domain-
kerberos-migration.test.ts`, `journalization-and-audit.test.ts` — tous
verts. `windows-server-domain-join.test.ts` toujours à 10 échecs
`nltest`/`dcdiag`/`klist` (pré-existants, hors périmètre, inchangés).
Typecheck ciblé propre.

## Linux — Phase 1 : `chgrp`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `chgrp [-R] <groupe> <fichier...>` — dernière
commande du groupe permissions restée en legacy après la Phase 0
(`chown`/`chmod` étaient déjà migrés). Suit exactement le gabarit de
`ChownCommand` : résolution du groupe via `ctx.machine.groups.findByName`,
`-R` par descente récursive via `ctx.machine.fs.list`, audit
(`fsAccess('a','chgrp')`/`syscall('chgrp', path)`) après l'opération
réussie, jamais avant (§7.4 du framework).

**Simplification documentée, héritée de `chown`, pas introduite ici** :
le `chgrp` legacy (`cmdChgrp`/`LinuxPermCommands.ts`) autorise un
utilisateur non-root à changer le groupe d'un fichier qu'il possède vers
un groupe dont il est membre — une règle métier fine que
`FileSystemApi.chown()` (le seul point d'entrée disponible pour muter le
groupe, `LinuxMachineApi.ts`) ne reproduit pas : il exige `root`
inconditionnellement. Cette limite existe déjà dans `ChownCommand`
(migré avant cette session) pour le changement de groupe seul ; `chgrp`
migré hérite donc de la même restriction plutôt que d'ajouter une
nouvelle méthode `FileSystemApi` pour la lever. Choix délibéré : la
session Windows en cours modifie en parallèle `command-kernel/machine/
types.ts`/`WindowsMachineApi.ts` sur la même branche — étendre
l'interface vendor-agnostic partagée maintenant aurait cassé son build
tant qu'elle n'implémente pas la nouvelle méthode. Aucun test existant
n'exerce le cas positif (non-root, groupe dont il est membre) — seul le
cas de refus (`perm-ownership-dac.test.ts`, non-root vers un groupe dont
il n'est pas membre) est couvert, et reste correct sous cette
restriction plus stricte. À lever dans un lot dédié, hors de toute
collision avec le travail Windows en cours.

**Legacy supprimé** : `case 'chgrp':` et son import (`cmdChgrp`) retirés
de `LinuxCommandExecutor.dispatch()`. `cmdChgrp` lui-même reste dans
`LinuxPermCommands.ts` — toujours appelé par `commands/fs/Chgrp.ts`
(l'autre framework `LinuxCommand`, déjà noté comme chevauchement
pré-existant avec `chown`, §8 du framework — non déplacé ici, hors
périmètre de cette migration).

**Validation** : lot localisé — `perm-ownership-dac.test.ts`,
`linux-filesystem-and-IAM.test.ts` (81 tests, tous passants) plus le lot
audit/privilège du §7.2 (`auditctl.test.ts`, `auditctl-other.test.ts`,
`journalization.test.ts`, `journalization-and-audit.test.ts`,
`command-privilege-policy.test.ts` — 1155 tests, 1 échec pré-existant et
sans rapport confirmé par `git stash` : `journalization.test.ts` #161,
`logrotate`/`prerotate` échoue déjà identiquement hors de cette
migration). Typecheck et lint ciblés propres.

## Windows — Phase 8 : `reg`, `setx`, `start`, `nbtstat`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatre commandes de plus, toutes mortes des deux côtés (wrapper privé
`WindowsPC.cmdX` jamais appelé) depuis la Phase 4.

**`MachineApi.registry?: RegistryApi`** — contrairement à `NetExeApi`/
`ServiceManagementApi`/`SchedulingApi`/`PrintApi`, PAS une passerelle
opaque : `WinRegistryProvider` (déjà utilisé par le provider PowerShell
`Registry::`, donc déjà partagé entre `reg.exe` et `Get-ItemProperty`)
était déjà une interface étroite et déjà généraliste (7 primitives :
`testPath`/`newItem`/`setItemProperty`/`removeItemProperty`/`removeItem`/
`getItemPropertyValues`/`listSubkeyNames`) — copiée telle quelle dans
`machine/types.ts` sous le nom `RegistryApi`. `RegCommand.execute()` reste
un simple appel à `cmdReg(ctx.machine.registry, args)` : `cmdReg` ne
touche plus aucun objet legacy brut, seulement cette interface déjà
abstraite — legitimate, contrairement au `.native` de la Phase 5.

`setx`/`nbtstat` réimplémentées entièrement inline (`ctx.session.env`,
`ctx.machine.hostname`) — aucune extension nécessaire, même pattern que
`Findstr`/`Copy`/`Dir`.

`start` réimplémentée sur `ctx.machine.proc.spawn()` (primitive déjà
générique) — **simplification assumée** : le legacy `cmdStart` attachait
le processus à la session Console (parent `explorer.exe`, `sessionId: 1`,
propriétaire l'utilisateur courant) ; `ProcessApi.spawn()` ne porte pas ces
paramètres (généraliste, partagé avec Linux) et aucun test ne couvre `start`
côté cmd (`grep` vérifié) — étendre l'interface partagée pour un besoin
non testé n'aurait fait qu'ajouter de la surface non validée. Documenté ici
plutôt que laissé silencieux.

**Nettoyage** : `cmdStart`/`cmdSetx`/`cmdNbtstat`/`cmdWmic` (un second
doublon mort, différent du `WmicCommand` migré en Phase 3) supprimés de
`WinSystemCommands.ts` — confirmés sans autre appelant.

**Validation** : `windows-server-identity.test.ts` (`reg query`, jusque-là
non inclus dans le lot localisé) + smoke manuel non versionné pour
`setx`/`start`/`nbtstat` (aucun test existant ne les couvre). Lot complet
comparé au commit précédent — 101 échecs / 808 réussites → 100 échecs / 813
réussites, zéro régression. Typecheck ciblé propre.

## Linux — Phase 0 : câblage universel du `CommandRegistry` + conversion async

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Le problème que cette phase résout** : `tryCommandKernel()` ne routait
vers `command-kernel` que les lignes top-level qui se réduisent
entièrement à une commande simple/pipeline. Une commande déjà migrée
(`ls`, `grep`, `chown`…) invoquée à l'intérieur d'une boucle, d'une
fonction, d'une condition ou après une substitution de commande
retombait sur le `switch` legacy de `LinuxCommandExecutor.dispatch()` —
qui restait donc nécessaire, contredisant la règle « supprime toujours
le legacy dès qu'une commande est migrée ». Supprimer ces `case` sans
combler ce trou aurait cassé toute commande migrée utilisée hors du cas
top-level.

**Câblage universel** : `LinuxCommandExecutor._commandKernelHook` (miroir
de `_registryCommandHook`/`_registryPrivilegeHook`) est maintenant
consulté dans `dispatchMaybeNetwork()` — le point d'injection unique déjà
partagé par `tryCommandKernel()`, l'interpréteur bash (`ExternalCommandFn`)
et l'exécution de scripts — **avant** le repli réseau et avant
`dispatch()`. `LinuxMachine` le câble vers son propre `Interpreter`
(`runCommandKernelResolved`) ; pour les ~40 tests qui instancient
`LinuxCommandExecutor` seul (sans `LinuxMachine` autour), un
`getDefaultCommandKernelShell()`/`runDefaultCommandKernelResolved()`
autonome (construit sur le `vfs`/`userMgr`/`processMgr` propres de
l'exécuteur) sert de repli — les commandes migrées n'ont plus d'autre
implémentation vers laquelle se replier, ce filet doit donc toujours
pouvoir les atteindre.

**Conséquence directe** : les `case` legacy des 21 commandes déjà
migrées (`touch, ls, cat, cp, mv, rm, mkdir, rmdir, ln, grep, head, tail,
wc, sort, cut, uniq, tr, chmod, chown, stat, id, whoami, groups`) sont
supprimés de `dispatch()`, ainsi que les fonctions `cmdXxx` mortes dans
`LinuxFileCommands.ts`/`LinuxTextCommands.ts`/`LinuxUserCommands.ts`/
`LinuxPermCommands.ts`. `chgrp`, `egrep`/`fgrep`/`rgrep`, `awk`, `sed`,
`pwd`, `echo`, `cd` restent en legacy (non migrés/builtins bash) — leur
présence continue de marquer, par construction, ce qui reste à faire.

**Conversion async en cascade** : le hook `command-kernel` étant
lui-même `Promise`-based de bout en bout, `LinuxCommandExecutor.execute`/
`dispatch`/`dispatchFromInterpreter`/`dispatchMaybeNetwork` (et toute
leur descendance — jobs d'arrière-plan, `CronEngine`, `run-parts`, `sh -c`,
`su`, `time`/`watch`) sont passés async ; `LinuxMachine.executeShellCommandSync`/
`runSshCommandSync`/`runCommandFrameInSession`/`cronTick` suivent (noms
`Sync` conservés pour compat historique — le sens réel est désormais
« async de bout en bout », documenté en commentaire). Le pont SSH
exec-mode (`SshExecTarget.runSshCommandSync`, 5 classes de device :
`LinuxMachine`, `WindowsPC`, `Router`, `CiscoRouter`, `HuaweiRouter`) et
le client SSH (`LinuxSshClient`) suivent la même conversion.

**Deux frontières synchrones préservées, documentées et volontairement
non cascadées** : le moteur PL/SQL d'Oracle (`IPackageRoutine.invoke():
string | null`, `OracleExecutor` — 4282 lignes) et `SqlPlusSubShell.create`
(invoqué depuis le **constructeur** de `SqlPlusShell` — un constructeur
JS ne peut pas être `async`, point final) ; et l'architecture
`CommandAction`/`CommandTrie` de Cisco/Huawei. Plutôt que de cascader la
conversion async dans ces deux sous-systèmes entiers (hors périmètre de
cette migration), deux ponts étroits et explicitement documentés :
`LinuxCommandExecutor.runOracleHostCommandSync()` (whoami/hostname/pwd/
id/ls/cat/find/mkdir/rm/echo/groupadd/useradd/usermod, purement
synchrone contre le `vfs`) pour Oracle, et le pattern `_pendingAsync`
déjà existant (`CiscoShellBase`/`HuaweiVRPShell`, déjà utilisé par
`ping`/`traceroute`) réutilisé pour `runOutboundSshClient` côté
Cisco/Huawei.

**Trois gaps réels mis au jour par ce câblage** (masqués jusqu'ici parce
que ces commandes n'étaient, avant cette phase, jamais réellement
atteintes par les tests à exécuteur autonome — elles retombaient sur le
`switch` legacy encore présent) :
- `command-kernel/commands/Tail.ts` : `-c`/octets, `-v`/`-q`, en-têtes
  multi-fichiers `==> fichier <==` manquants — réécrit en réutilisant
  `sliceTail`/`tailHeader` du legacy `coreutils/TailCommand.ts` (toujours
  utilisé par le suivi `-f` de l'UI, non supprimé).
- `command-kernel/commands/Grep.ts` : migration très partielle (`-i -v
  -n -c -E` seulement) — réécrit à parité avec le legacy `cmdGrep`
  (`-w -x -F -o -q -s -r -l -L -h -H -m -e -f --include --exclude`
  + contexte `-A/-B/-C` + `-P`), avec parsing manuel de `rawArgv` (les
  motifs `-e` répétés et le mélange motif/fichiers positionnels ne
  passent pas par le parseur déclaratif d'options).
- `command-kernel/commands/Chown.ts` : `-R`/`--recursive` absent —
  ajouté (descente récursive via `machine.fs.list`).

**Régression corrigée** : `sudo <commande migrée>` ne retrouvait plus la
commande une fois son `case` legacy supprimé — `dispatchFromInterpreter`
dépile `sudo` et élève l'utilisateur courant, puis appelait `dispatch()`
directement sans revérifier le hook `command-kernel` pour la commande
démasquée. Le hook est maintenant reconsulté après élévation, sous le
contexte utilisateur déjà élevé.

**Bug additionnel corrigé (indépendant de cette phase)** : `command-kernel`'s
`runOracleHostFind`'s récursion de répertoire suivait les entrées `.`/`..`
renvoyées par `listDirectory`, provoquant un débordement de pile —
corrigé en les ignorant.

**Process substitution `>(...)`/`<(...)` dans `src/bash/`** : les deux
matérialisaient leur commande via `BashInterpreter.executeSubcommand()`,
qui force un driver **synchrone** (`driveSync`) — celui-ci refuse
désormais tout retour `Promise` (« cannot run an asynchronous command in
a synchronous shell »), puisque toute commande externe est maintenant
async. `materializeProcSubs`/`materializeWord`/`flushOutSubs` sont
devenues des méthodes génératrices (`materializeProcSubsG`/
`materializeWordG`/`flushOutSubsG`) qui `yield*` dans la même chaîne
d'effets que le reste de l'interpréteur, participant correctement au
driver (sync ou async) réellement actif au lieu d'en forcer un.

**Validation** : lot localisé élargi (84 fichiers, ~1525 tests dont les
suites Oracle complètes — 135 fichiers, 3088 tests) — 4 échecs
résiduels, tous confirmés pré-existants et sans rapport via comparaison
`git stash` (méthode §7.2) : les 3 gaps déjà documentés de
`run-parts.test.ts` (fonctions/`if-else`/`sh` alternatif, hors périmètre
command-kernel) et un gap déjà présent avant cette phase dans
`cross-equipment-ssh-suite.test.ts` §9 (alias de fonction shell).

## Windows — Phase 7 : `schtasks`, `print`, correction de `MachineApi.now()`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Même classe de régression Phase 4 que `net` : `schtasks` n'était dispatché
nulle part côté `cmd.exe` (le wrapper privé `WindowsPC.cmdSchtasks` existait
mais n'était appelé par rien, ni côté cmd ni côté shim PowerShell — mort des
deux côtés) ; `print` n'avait jamais eu le moindre point d'entrée.

**`MachineApi.scheduling?: SchedulingApi`** et **`MachineApi.printing?:
PrintApi`** (chacune une méthode `execute(argv)`) — même raisonnement
documenté que `NetExeApi`/`ServiceManagementApi`. `cmdSchtasks`/`cmdPrint`
narrowés de `WinSystemContext`/`WinCommandContext` (les gros contextes
système/réseau) à `Pick<>` portant seulement ce qu'ils lisent réellement
(`isServiceRunning`+`processManager`+`scheduledTasks`+`now` pour l'un,
`hostname`+`isServiceRunning` pour l'autre) — même technique que
`NetShareContext`/`NetUseContext` en Phase 6, pour ne jamais tirer toute la
pile réseau dans `MachineApi` pour un besoin aussi étroit.

**Bug trouvé en implémentant `scheduling`** : `WindowsMachineApi.now()`
retournait `new Date()` (horloge murale réelle) au lieu de l'horloge
simulée de l'équipement — un `WindowsPC.advanceTime()` n'avait donc aucun
effet sur ce que `ctx.machine.now()` répondait. Latent depuis la Phase 3
(`date`/`time`, déjà migrées, lisaient déjà silencieusement la mauvaise
horloge — juste jamais testé après un `advanceTime()`). Fix : nouveau
`WindowsMachineApiDeps.now(): Date`, câblé sur `this.simulatedDate()` côté
`WindowsPC`, consommé par `WindowsMachineApi.now()` — corrige `date`/`time`
en plus de rendre `schtasks /create` + `advanceTime()` cohérents.

**Validation** : lot localisé (les 22 fichiers de la Phase 6, `date`/`time`
et `windows-scheduled-tasks` inclus pour couvrir le fix `now()`) comparé au
commit précédent — 111 échecs / 798 réussites → 101 échecs / 808 réussites,
**10 tests corrigés (les 6 `windows-scheduled-tasks` + les 4 `schtasks`/
`print` de `windows-phase-g`), zéro régression**. Typecheck ciblé propre.

**Hors périmètre, repéré en passant** : `runas` — même gap Phase-4, commande
distincte, laissée pour un prochain lot.

## Windows — Phase 6 : `net` (user/localgroup/start/stop/share/session/use/accounts)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`net` n'était migré nulle part côté `cmd.exe` — le pont `runSyncNativeCommand`
(shim synchrone dédié à PowerShell, jamais touché) gère bien `net user`/
`net localgroup`/`net start`/`net stop`/`net share`/`net session`, mais
`executeCmdCommand('net ...')` tombait systématiquement sur « not
recognized » depuis la Phase 4 (cutover complet, régression jamais détectée
faute d'être dans le lot de tests localisé de l'époque). `net use` et
`net accounts` étaient morts des DEUX côtés : `cmdNetUse` n'était appelé
nulle part (import de type seulement), et `net accounts` n'avait jamais eu
de fonction `cmdNetAccounts` — seul l'état (`WindowsAccountsPolicy`) existait.

**`MachineApi.netExe?: NetExeApi`** (méthode unique `execute(argv, caller)`)
— même raisonnement documenté que `ServiceManagementApi`/`sc` (§3.4 règle 2) :
`net.exe` a ~8 sous-commandes au format figé, chacune couplée à un
sous-système vendeur distinct (SAM, SCM, table de partages SMB, table
`net use`, politique de compte LSA) ; décomposer en primitives génériques
réimplémenterait son dispatcher sans bénéfice pour un autre vendeur.
`NetCommand.execute()` ne fait que transmettre l'argv déjà tokenisé ;
`WindowsNetExeApi` (dans `WindowsMachineApi.ts`) reste seule responsable de
l'interprétation — elle réutilise `cmdNetUser`/`cmdNetLocalgroup`/
`cmdNetStart`/`cmdNetStop`/`cmdNetShare`/`cmdNetUse` en interne (légitime :
exécuté depuis le pont, jamais depuis une commande), et implémente `net
session`/`net accounts` directement (respectivement portés depuis l'ancienne
méthode privée `WindowsPC.cmdNetSession`, et écrits pour la première fois
contre `WindowsAccountsPolicy.render()`/`.apply()`, déjà correcte et déjà
consultée par `WindowsUserManager` pour la politique de mot de passe réelle).

**`cmdNetShare`/`cmdNetUse` découplés du `WinCommandContext` géant** —
signatures réduites à `Pick<WinCommandContext, ...>` (`NetShareContext`,
`NetUseContext`) portant seulement les 2 et 4 champs réellement utilisés
(`isServiceRunning`+`smbShares`, `isServiceRunning`+`netUseTable`+
`resolveHostname`+`dialSmbShare`) — évite de tirer toute la pile réseau
(netsh/ipconfig/dhcp/dns, explicitement hors périmètre) dans `MachineApi`
juste pour ces deux sous-commandes. `requireWindowsService`/
`requireWindowsServices` (`WinFeatureGate.ts`) narrowés de la même façon
(`ServiceGateContext = Pick<WinCommandContext, 'isServiceRunning'>`), pour
rester réutilisables par ces deux contextes réduits sans dupliquer à la
main le texte exact des refus de service (piège trouvé en écrivant cette
phase : une première tentative de recopier `The Workstation service has
not been started...` à la main s'est trompée de message — `LanmanWorkstation`
a un texte dédié dans `WinFeatureGate.ts` que je n'avais pas vérifié).

**Validation** : lot localisé de 22 fichiers (les 16 de la Phase 5 +
`windows-phase-g`, `windows-password-policy`, `windows-server-smb`,
`windows-smb-cmdlets`, `cross-equipment-ssh-suite`,
`password-policy-ssh-scp-sftp-coherence`) comparé au commit précédent —
baseline 189 échecs / 720 réussites → après ce lot, 111 échecs / 798
réussites — **78 tests corrigés, zéro régression** (échecs restants tous
préexistants et hors périmètre : `nltest`/`dcdiag`/`klist`, `schtasks`,
`print`). Typecheck ciblé propre.

**Hors périmètre, repéré en passant** : `schtasks`, `print` — mêmes gaps
Phase-4 que `net`, mais familles de commandes distinctes ; laissées pour un
prochain lot plutôt que d'élargir celui-ci au-delà de `net`.

## Windows — Phase 5 : whoami/icacls/attrib/find/sort/more/fc/xcopy/where/doskey, suppression de l'échappatoire `.native`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Correction architecturale majeure, sur retour explicite de l'utilisateur** :
les commandes migrées de cette phase (et plusieurs déjà livrées en Phase 3 —
`tasklist`, `taskkill`, `sc`, `netstat`) appelaient depuis `execute()` des
fonctions autonomes du projet (`cmdWhoami`, `cmdFind`, `cmdSort`, `cmdTasklist`,
etc., dans `WinWhoami.ts`/`WinFileCommands.ts`/`WinTasklist.ts`/...) en leur
passant l'objet legacy réel récupéré via un champ `native: unknown` posé sur
`MachineApi` (`fs.native`, `proc.native`, `users.native`, `servicesNative`,
`domainSessionNative`, `doskeyNative`). C'est une violation du principe
directeur §0.1 du framework (« une commande ne touche jamais l'implémentation
réelle d'un équipement, elle ne connaît que `ctx.machine: MachineApi` ») :
le `.native` déguisait un contournement complet de la façade sous une
signature typée. Fix : suppression de TOUS les champs `.native`/`*Native` du
contrat `MachineApi`, remplacés par des capacités décomposées et documentées
(§3.4) :

- `FileSystemApi.getAcl?`/`grantAcl?`/`removeAcl?` (ACL NTFS, `icacls`) et
  `getAttributes?`/`setAttributes?` (attributs NTFS, `attrib`) — nouveaux
  types `AclEntry`/`FileAttributes`.
- `ProcessInfo` enrichi (`ownerName`, `sessionName`/`sessionNumber`,
  `memoryKib`, `cpuSeconds`, `status`, `windowTitle`, `hostedServices`,
  `critical`, `systemOwned`) + `ProcessApi.descendants?()` — `tasklist`/
  `taskkill` reconstruisent tout leur formatage (TABLE/CSV/LIST, filtres
  `/FI`, arbre `/T`, vérification `critical`/`systemOwned`) en local, à
  partir de cette seule donnée typée.
- `NetworkApi.connections?()` (nouveau type `SocketInfo`) pour `netstat`.
- `UserManagementApi.securityIdentity?()` (nouveaux types `SecurityIdentity`/
  `SecurityGroupMembership`/`SecurityPrivilege`) pour `whoami` — résout SID,
  groupes et privilèges, session de domaine active incluse, entièrement côté
  pont `WindowsMachineApi`.
- `MachineApi.services?: ServiceManagementApi` (méthode unique
  `execute(argv, {isAdmin, userName})`) pour `sc` — exception documentée
  (§3.4 règle 2) : `sc.exe` a ~14 sous-commandes au format figé et
  intimement lié au modèle SCM réel (SDDL, actions de reprise sur panne) ;
  décomposer en primitives génériques aurait dupliqué ce formatage sans
  bénéfice. `ScCommand.execute()` ne fait plus que transmettre l'argv déjà
  tokenisé ; l'implémentation vendeur (`WindowsServiceManagementApi`, dans
  `WindowsMachineApi.ts`) reste seule responsable d'interpréter et
  formatter — elle réutilise `cmdSc()`/`WinSc.ts` en interne (légitime : ce
  code s'exécute maintenant DANS le pont, jamais depuis une commande).
- `MachineApi.macros?: MacroApi` pour `doskey`.

`find`/`sort`/`more`/`fc`/`xcopy`/`where` n'avaient besoin d'aucune extension
— entièrement réimplémentées avec les primitives déjà existantes de
`FileSystemApi` (`readFile`/`list`/`stat`/`exists`/`copy`/`mkdir`/`resolve`),
suivant exactement le pattern déjà correct de `Findstr.ts`/`Copy.ts`/
`Dir.ts` (jamais retouchées, elles n'avaient jamais eu ce problème).

**Nettoyage legacy consécutif** — `migration puis suppression` (§ directive
utilisateur) : `WinFileCommands.ts`, `WinDir.ts`, `WinIcacls.ts`,
`WinWhoami.ts`, `WinTasklist.ts`, `WinTaskkill.ts` supprimés en entier
(vérifié explicitement sans autre appelant que les commandes migrées
elles-mêmes, y compris le pont PowerShell `runSyncNativeCommand` qui ne les
utilisait pas) — net −18 fichiers/fonctions de maçonnerie legacy, dont un
`cmdTasklist` mort dans `WinFileCommands.ts` qui renvoyait une liste de
processus **entièrement codée en dur** (contraire à la règle « pas de valeur
figée », jamais appelé nulle part).

**Bug trouvé en écrivant `MacroApi`** : `WindowsMachineApiDeps.domainSession`
était une VALEUR figée au premier appel de `getCommandKernelShell()`
(construction paresseuse, une seule fois par `WindowsPC`) — une connexion de
domaine établie APRÈS le premier appel `cmd` restait invisible à `whoami`.
Fix : remplacé par `getDomainSession(): DomainSession | null`, un accesseur
live, cohérent avec `isDHCPConfigured`/`bootedAt` déjà câblés en closures.

**Nouvelles commandes** (toutes suivent le patron `BaseCommand` établi,
n'appellent que `ctx.machine.*`) : `whoami` (`/user`, `/groups`, `/priv`,
`/all`), `icacls` (affichage + `/grant`, `/deny`, `/remove`, gate
`ctx.session.user.isRoot()`), `attrib` (`+r/-r/+a/-a/+h/-h/+s/-s`), `find`,
`sort`, `more` (fidélité : lit `stdin` en pipeline quand aucun fichier n'est
donné, comme `findstr` — legacy renvoyait `''`), `fc`, `xcopy` (`/s`, `/e`,
récursif via `fs.list`/`fs.mkdir`/`fs.copy`), `where`, `doskey`.

**Validation** : lot localisé de 16 fichiers (`windows-access-cmd`,
`windows-access-powershell`, `windows-file-management`, `windows-filesystem`,
`windows-filesystem-tree`, `windows-drive-switching`, `windows-ps-cmd-coherence`,
`windows-consistency`, `basic-commandes`, `env-vars`, `windows-services-cmd`,
`windows-services-powershell`, `windows-services-processes-comprehensive`,
`windows-netstat-stream-ui`, `windows-scheduled-tasks`,
`windows-server-domain-join`) comparé au commit précédent (`git stash`) :
baseline 170 échecs / 449 réussites → après ce lot, 127 échecs / 492
réussites — **43 tests corrigés, zéro régression** (les échecs restants sont
tous préexistants et hors périmètre : `net start`/`net stop`, `nltest`/
`dcdiag`/`klist`/`schtasks`, `ipconfig`/`Test-Connection` PS-vs-CMD — aucune
commande touchée par cette phase). Typecheck ciblé
(`command-kernel|WindowsPC|windows/`) propre.

**Hors périmètre, repéré en passant** : `netstat -a`/`dir -a` (et plus
généralement tout switch à un seul tiret sur une commande Windows migrée)
lève `option inconnue` — `ArgumentParser` n'a pas de mode
`lenientOptions: true` activé pour ces commandes (seul `EchoCommand` l'a).
Préexistant à cette phase (reproduit identique sur `dir -a` avant tout
changement) — pas corrigé ici pour rester dans le périmètre de la demande.

## Windows — Phase 4 : porte d'entrée unique, `CmdInterpreter` dédié, suppression du parsing legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Sur retour explicite de l'utilisateur : trop de « maçonnerie » autour du
pont — `executeCmdCommand` gardait son propre découpage de chaînage
(`splitCmdChain`), de pipes (`executePipedCommand`), de redirections
(`handleRedirect`) et d'expansion `%VAR%`/tokenisation
(`expandEnvVars`/`parseCommandLine`) EN PARALLÈLE du nouveau
`Lexer`→`Parser`→`Executor`, qui sait pourtant déjà tout faire ça. Cette
phase supprime cette duplication : `executeCmdCommand` ne fait plus que
deux étapes qui ne sont PAS exprimables par la grammaire (dépouillement
`2>&1`, expansion des macros doskey — un remplacement de texte brut,
avant tout tokenizing, comme le vrai cmd.exe), puis un unique appel à
`runCommandKernel()`, qui parse une fois et exécute tout l'AST — chaîne,
pipeline ou redirection compris — en un seul passage par `Executor`.

**`CmdInterpreter` (nouveau, dédié Windows)** — remplace la
paramétrisation générique de l'`Interpreter` bash de la Phase 2 (retour
en arrière sur ce point précis, sur demande explicite : « crée un lexer,
tokenizer, parser, interpreter spécialement pour Windows, c'est plus
simple »). `src/command-kernel/interpreter.ts` redevient la classe simple
d'origine, sans option d'injection — le moteur partagé ne change plus du
tout pour un nouvel équipement, conformément au §0/§4 du framework.
`Executor` garde son `expander`/`globExpand` injectables (nécessaires :
Windows construit son propre `Executor` directement, sans passer par
`Interpreter`), c'est la seule extension qui reste sur le socle partagé.
`CmdInterpreter` vit entièrement dans `windows/command-kernel/` et
assemble `CmdLexer` + `Parser` (partagé, inchangé) + `CmdExpander` + un
`globExpand` no-op.

**Bug trouvé en unifiant — code de sortie fictif** : les commandes
migrées de la Phase 1/3 renvoyaient toujours `EXIT_OK` même sur un échec
« doux » (chemin introuvable, fichier déjà existant...), parce que
l'ancien `splitCmdChain` décidait `&&`/`||` en scannant le TEXTE de
sortie (`cmdOutputIsError`), pas un vrai code de sortie. En unifiant sur
le AND/OR natif d'`Executor` (qui regarde le VRAI code de sortie), ce
raccourci serait devenu un bug silencieux (`cd C:\Inexistant && echo
ne-devrait-pas-s'afficher` aurait affiché le echo). Fix : chaque retour
d'erreur « douce » dans les 10 commandes concernées (`cd`, `mkdir`,
`rmdir`, `type`, `copy`, `move`, `ren`, `del`, `set`, `dir`, plus le
helper partagé `reportLegacyFsError`) renvoie maintenant `1`, comme le
vrai `%ERRORLEVEL%` de cmd.exe.

**Bug trouvé en unifiant — noms de commande sensibles à la casse** :
`CommandRegistry`/`Parser` sont délibérément insensibles à rien (corrects
pour bash, où `LS` ≠ `ls`) — mais cmd.exe EST insensible à la casse pour
les noms de commande (`DIR`, `Dir`, `dir` identiques), pas pour les
arguments (`echo Hello` doit garder sa casse). Nouveau
`lowercaseCommandNames()` (`windows/command-kernel/ast/
lowercaseCommandNames.ts`) parcourt l'AST une fois après le parsing et ne
touche qu'aux positions de nom de commande, jamais aux `argv`.

**`findstr` migré** — nécessaire pour supprimer `executePipedCommand`
sans régression : `dir | findstr Alpha` passait par un filtre ad hoc
séparé (jamais par une vraie commande enregistrée). Nouvelle
`FindstrCommand`, lit les fichiers passés en argument OU l'entrée
standard si aucun n'est donné (contrairement à l'ancien `cmdFindstr`
legacy qui exigeait toujours un fichier — un vrai gap face au findstr.exe
réel, corrigé au passage), flags `/i` `/v` `/n` `/c` `/c:"…"`, motifs
multi-mots en OR. Les filtres `find`/`grep`/`more` de l'ancien pipe ad hoc
sont abandonnés sans remplacement : aucun test ne les exerçait côté cmd
(`grep` n'existe même pas sur un vrai cmd.exe).

**Supprimé** : `splitCmdChain`, `cmdOutputIsError`, `executePipedCommand`,
`handleRedirect`, `parseCommandLine`, `expandEnvVars`,
`parseFindstrFilter` — ~230 lignes nettes en moins sur `WindowsPC.ts`
malgré les ajouts (`CmdInterpreter`, `lowercaseCommandNames`,
`FindstrCommand`). `tryUncFileCommand` (SMB réel, pas une commande) et le
changement de lecteur nu (`D:`) restent des cas spéciaux avant le
dispatch — ce ne sont pas des commandes au sens de la grammaire, rien
dans l'AST ne les représenterait proprement.

**Validation** : lot localisé (8 fichiers) — 143/144, identique à la
Phase 3 (même échec restant : `netsh`, hors périmètre). `cmd-bat-execution.
test.ts` (exécution `.bat`, chemin non touché par cette phase) — 12/12.
`cmd-missing-builtins.test.ts` — mêmes 9 échecs préexistants (`net`,
`start`, `setx`, `schtasks`, `nbtstat`, `reg` — hors périmètre documenté),
aucune régression. Typecheck ciblé propre.

## Windows — Phase 3 : `dir` + commandes système (13 commandes), zéro donnée figée

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suite de la Phase 2, sur demande explicite de continuer la migration
jusqu'à couverture complète. Périmètre : `dir`, `ver`, `hostname`, `vol`,
`chcp`, `date`, `time`, `systeminfo`, `tasklist`, `taskkill`, `netstat`,
`sc`/`sc.exe`, `wmic`.

**Principe appliqué partout dans cette phase, sur retour explicite de
l'utilisateur : aucune valeur figée, uniquement des données réelles de
CET équipement** :

- `ver` — la Phase 1 avait copié `'10.0.22631.6649'` en dur dans le
  nouveau fichier, une DEUXIÈME copie du `WindowsPC.VER_STRING` déjà
  utilisé par `runSyncNativeCommand` (le shim PowerShell). Corrigé :
  extraction en constante partagée unique
  (`windows/WindowsVersion.ts::WIN_VER_STRING`), important pour la
  cohérence cmd/PowerShell (`cmd-ps-coherence.test.ts`) — les DEUX chemins
  lisent maintenant la même source, pas deux copies qui peuvent diverger.
- `dir`, `vol`, `wmic logicaldisk` — numéro de série et espace libre réels
  via `WindowsFileSystem.getVolumeSerialNumber()`/`getFreeDiskSpace()`
  (nouvelle capacité optionnelle `FileSystemApi.volumeInfo()`), jamais une
  valeur constante.
- `ver`(profil futur)/`systeminfo`/`wmic os get caption`/`wmic cpu get
  name` — nouvelle capacité optionnelle `MachineApi.os`/`hardware` sourcée
  de `EndHost.getIdentity()`/`this.hardware` (`HardwareProfile.
  defaultFor()`), déjà différenciés par type d'équipement (station de
  travail vs serveur) — jamais une chaîne unique pour tous les WindowsPC.
- `tasklist`/`taskkill`/`sc`/`netstat` — plutôt que de réimplémenter ces
  rendus complexes (filtres, formats CSV/LIST/TABLE, ACL de service...),
  les commandes migrées appellent DIRECTEMENT les fonctions pures legacy
  déjà existantes (`WinTasklist.cmdTasklist`, `WinTaskkill.cmdTaskkill`,
  `WinSc.cmdSc`, `WinFileCommands.cmdNetstat`) via une nouvelle
  échappatoire vendeur `ProcessApi.native`/`NetworkApi.native`/
  `MachineApi.servicesNative` (type `unknown`, cast par la commande) qui
  expose l'objet réel (`WindowsProcessManager`, `SocketTable`,
  `WindowsServiceManager`) — mêmes données, même fonction de rendu, donc
  zéro divergence possible avec `runSyncNativeCommand` (le shim
  PowerShell natif, qui appelle ces mêmes fonctions).

**Bug trouvé en migrant `dir`/`del *.tmp`** : `Executor.runSimple`
appliquait automatiquement le glob POSIX partagé (`expandGlob`, séparateur
`/`, sémantique bash) à chaque mot avant même que la commande migrée ne
le voie — `del *.tmp` recevait donc déjà des noms de fichiers résolus
(mal, avec des chemins complets à cause du mélange `/`/`\`) au lieu du
motif littéral que chaque commande cmd doit gérer elle-même (`del` ne
matche que dans `cwd`, non récursif ; `dir /s` récursif ; sémantiques
différentes par commande). Fix : `Executor`/`Interpreter` acceptent
maintenant un `GlobExpander` injectable (même principe que `Lexer`/
`Expander`), `createWindowsHostShell` passe un no-op (`async (w) => [w]`)
— chaque commande Windows fait son propre matching via
`ctx.machine.fs.list()`, comme legacy.

**`dir` — portée** : formats basique/large (`/w`)/récursif (`/s`)/bare
(`/b`)/wildcard/fichier unique, en-tête volume + espace libre réels.
Les flags `/a`/`/o` sont acceptés en no-op (comme legacy — le simulateur
ne modélise pas les dates par attribut).

**Hors périmètre, conservé pour une phase dédiée "réseau"** : `netsh`
(3180 lignes, dizaines de sous-domaines — interface ip, firewall,
advfirewall, portproxy, wlan, dhcpclient — nécessite une extension
substantielle de `MachineApi.net` avant migration, pas une commande
isolée), `ipconfig`, `ping`, `route`, `arp`, `getmac`, `tracert`,
`nslookup`, `ssh`/`sftp`/`scp`/`telnet`, `net` (sous-commandes). `netstat
-r` (table de routage) dégrade gracieusement (chaîne vide) faute du
contexte réseau complet — sera couvert par la même phase réseau.

**Validation** : lot localisé (8 fichiers) — 143/144, seul restant :
`netsh` (hors périmètre ci-dessus, échoue explicitement). Typecheck ciblé
propre.

## Windows — Phase 2 : vrai `Lexer`/`Parser` cmd.exe, pont réécrit sur `Interpreter`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suite directe de la Phase 1, sur retour explicite de l'utilisateur : la
Phase 1 construisait un `SimpleCommandNode` à la main à partir d'un
`(cmd, args)` déjà découpé par `WindowsPC` — ça marchait, mais ce n'était
pas aligné avec le framework (pas de vraie porte d'entrée `Interpreter`)
et ne posait aucune fondation pour exécuter un jour de vrais scripts
`.bat`. Cette phase corrige les deux.

**Extension du socle partagé (`src/command-kernel/`), rétrocompatible** :
`Executor` et `Interpreter` acceptaient un `Lexer`/`Parser`/`Expander`
bash codés en dur ; ils prennent maintenant des paramètres optionnels
(`IExpander`, `ITokenizer`) avec les classes bash comme valeur par
défaut — zéro changement de comportement pour Linux (vérifié : aucune
régression sur le lot déjà validé). C'est la seule modification apportée
au moteur partagé ; `CommandRegistry`/`PermissionGuard`/`ArgumentParser`
restent strictement inchangés.

**`CmdLexer` (nouveau, Windows)** : tokenizer dédié à la grammaire
cmd.exe — guillemets doubles qui basculent et se suppriment sans
échappement (règles reprises telles quelles de `splitCmdArgs`/
`WindowsPC.parseCommandLine`, seule référence déjà validée par la suite
de tests, jamais réinventées), pas de guillemets simples spéciaux
(`echo 'x'` doit garder les apostrophes littérales), `&` seul émis comme
`TokenType.SEMI` (séquence inconditionnelle — même sémantique que le `;`
bash), `#` jamais traité comme un commentaire. Le `Parser` partagé
(`ast/parser.ts`) est réutilisé **sans aucune modification** : il ne
dépend que du flux de tokens, jamais de la syntaxe bash en dur — seule
divergence connue et acceptée : son détecteur d'assignation `VAR=valeur`
(bash) s'appliquerait aussi à une ligne cmd qui ressemblerait par hasard
à `X=1` en position de commande (cas non testé, cmd.exe n'a pas cette
notion — la traiterait comme une commande introuvable).

**`CmdExpander` (nouveau, Windows)** : reproduit exactement
`WindowsPC.expandEnvVars` (`%VAR%`, recherche insensible à la casse en
majuscules, `%CD%` résolu vers le cwd vivant, variable non définie
laissée intacte plutôt qu'effacée). Pas de `$`, pas de `~`, pas de glob
générique — cmd n'a aucun des trois.

**Pont réécrit** : `WindowsPC.tryCommandKernelCmd()` remplace
`runCommandKernelCmd()` et suit maintenant EXACTEMENT la structure de
`LinuxMachine.tryCommandKernel()` (§6 du framework) — parse en pré-vol
avec `CmdLexer`+`Parser`, refus de router (retour `null`, pas un échec)
si erreur de parsing / AST pas réductible à `command`/`pipeline` / une
commande du pipeline non enregistrée ; une fois routé, aucun repli, une
`ShellError` remonte telle quelle. `createWindowsHostShell` expose
maintenant un vrai `Interpreter` (au lieu du couple `{registry, executor}`
brut de la Phase 1).

**Portée actuelle de ce pont, honnêtement documentée** : `WindowsPC.
executeCmdCommand` continue de découper lui-même le chaînage (`&&`/`||`/
`&`) et les pipes (`|`) AVANT d'atteindre le pont — chaque segment simple
est donc ce qui arrive au `Interpreter`, jamais une ligne composite. Le
`Parser`/`Executor` savent déjà traiter `pipeline`/`and`/`or`/`sequence`
en un seul appel (utile dès qu'on voudra exécuter une ligne composite ou
un script multi-lignes sans repasser par le découpage `WindowsPC`), mais
ce chemin n'est pas encore exercé par l'intégration actuelle — fondation
posée, pas encore branchée. `CmdSubShell.executeBat()` (exécution des
`.bat`) n'est PAS touché dans cette phase : les scripts batch réels
utilisent `if`/`goto`/`for`/labels, une grammaire entièrement différente
de la ligne interactive cmd que `CmdLexer` couvre aujourd'hui — brancher
`executeBat` sur `Interpreter` prématurément aurait fait échouer tout
script utilisant un mot-clé batch non supporté, une vraie régression sur
`cmd-bat-execution.test.ts`. Chantier séparé, à faire une fois ces
mots-clés supportés par un parser batch dédié.

**Réponse à « toutes les commandes supprimées doivent être migrées » :
audit** — aucune implémentation legacy n'a été supprimée du dépôt en
Phase 1 ; seul le ROUTAGE (le `switch` dans `executeCmdCommand`) a été
retiré. Vérifié fichier par fichier (`WinDir.ts`, `WinPing.ts`,
`WinIpconfig.ts`, `WinNetsh.ts`, `WinTasklist.ts`, `WinSc.ts`, etc.) :
chaque fonction `cmdXxx` existe toujours, intacte, prête à être migrée
commande par commande — c'est du matériel de référence en attente, pas
du code perdu. `WindowsPC.executeCommand()` (méthode publique la plus
utilisée par la suite de tests) délègue directement à
`executeCmdCommand()` — c'est donc déjà, et reste, le point d'entrée
observable pour mesurer la progression de la migration à chaque
exécution de la suite de tests, sans changement nécessaire de ce côté.

**Validation** : même lot localisé qu'en Phase 1 (8 fichiers) — 118/144,
identique à la Phase 1 (aucune régression introduite par la réécriture).
Lot élargi (`windows-consistency`, `basic-commandes`, `env-vars`) :
86/149, cohérent avec l'écart déjà documenté (commandes réseau/système
hors périmètre). Typecheck ciblé propre sur `command-kernel` (socle +
Windows) et `WindowsPC.ts`.

## Windows — Phase 1 : pont `command-kernel` + commandes fichiers/session de `cmd`, cutover complet du dispatcher legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Premier équipement non-Linux sur `command-kernel` (§4 du framework). Aucun
pont Windows n'existait auparavant — tout est nouveau : `WindowsMachineApi`
(`src/network/devices/windows/command-kernel/WindowsMachineApi.ts`),
`WindowsUser`/`resolveWindowsUser`, `createWindowsHostShell`.

**Décision d'architecture — pas de `Lexer`/`Parser` partagé pour cmd.exe** :
la syntaxe cmd (`%VAR%`, `&` inconditionnel, lettres de lecteur, macros
doskey, `.bat`) diverge trop du grammaire bash de `command-kernel` pour
réutiliser son `Lexer`. `WindowsPC.executeCmdCommand` fait déjà tout ce
travail de découpage (chaînage `&&`/`||`/`&`, pipes, redirections,
changement de lecteur, expansion `%VAR%`, macros doskey) — le pont
(`runCommandKernelCmd`) construit directement un `SimpleCommandNode` à
partir du `(cmd, args)` déjà résolu et appelle `Executor.run()` sans
passer par `Interpreter`/`Lexer`/`Parser`, qui restent donc inchangés et
partagés uniquement au niveau moteur (`Executor`/`CommandRegistry`/
`PermissionGuard`/`ArgumentParser`), pas au niveau syntaxe.

**`MachineApi.fs` pour un filesystem sans owner/mode POSIX** : NTFS n'a ni
bits de permission Unix ni uid/gid — `FileStat.mode/ownerUid/ownerGid`
portent une valeur fixe (`0o666`/`0`/`0`), jamais lue par aucune commande
migrée (l'ACL réelle passe par `icacls`, non migré). `User.uid/gid` sont
dérivés d'un hash stable du SID Windows (pas d'identifiant numérique natif
dans ce modèle) — voir `numericIdFromSid` dans `WindowsUser.ts`.

**Périmètre migré (fichiers/session)** : `cd`/`chdir`, `mkdir`/`md`,
`rmdir`/`rd`, `type`, `copy`, `move`, `ren`/`rename`, `del`/`erase`,
`tree`, `set`, `cls`, `echo` (variante Windows dédiée — `echo -n foo`
affiche `-n foo` littéralement, contrairement à l'`EchoCommand` bash de
`registerCoreCommands` qui interprète `-n`/`-e`).

**Cutover complet du dispatcher, sur demande explicite de l'utilisateur**
(pas de fallback, même temporaire, vers le legacy) : tout
`executeCmdCommand` routait auparavant vers un switch de ~50 commandes
fichiers/système, un routeur `net <sous-commande>`, et un second switch
réseau (~14 commandes : `ipconfig`, `ping`, `netsh`, `ssh`, `route`,
`arp`, `nslookup`...). Les trois sont supprimés d'un bloc : le
dispatcher ne route plus que ce qui est enregistré dans
`createWindowsHostShell` ; toute commande non enregistrée renvoie
désormais le message exact `'<cmd>' is not recognized as an internal or
external command, operable program or batch file.` — un échec est donc,
par construction, le signal qu'une commande n'est pas encore migrée, plus
jamais un aiguillage silencieux vers une implémentation parallèle.
Les implémentations legacy encore utiles (`WinDir.ts`, `WinSystemCommands.ts`,
les commandes process/service/réseau de `WinFileCommands.ts`, etc.) sont
laissées en place, inutilisées, comme matériel de référence pour leurs
migrations futures (§3.1 étape 1 du framework — les supprimer maintenant
détruirait la seule référence de fidélité exacte disponible) ; elles sont
supprimées au fur et à mesure de leur migration réelle, jamais avant.
`runSyncNativeCommand` (pont synchrone séparé utilisé par les cmdlets
PowerShell natifs) n'est pas concerné par ce cutover — c'est un
consommateur distinct, hors périmètre de cette phase.

**Bugs trouvés en migrant (cause racine, pas juste le symptôme)** :

- `rmdir` utilisait initialement `WindowsFileSystem.deleteDirectory()`
  (suppression inconditionnelle) au lieu de `rmdir()`/`rmdirRecursive()`
  — perdait donc la vérification « répertoire non vide » que legacy
  `cmdRmdir` faisait réellement. Fix : `WindowsFileSystemApi.remove()`
  appelle `rmdir()`/`rmdirRecursive()`, jamais `deleteDirectory()`,
  exactement comme legacy (piège identique au §7.5 du framework, version
  Windows : deux méthodes VFS d'apparence équivalente, comportement
  différent).
- `ren`/`rename` : `renameEntry()` (legacy) rejette une collision de nom
  AVANT toute mutation (« A duplicate file name exists... ») et préserve
  l'entrée d'origine (mtime, attributs, ACL) ; le slot générique
  `FileSystemApi.rename()` (nécessairement `moveFile()`-backed pour
  rester utilisable par `move`, qui doit pouvoir traverser les
  répertoires) écraserait silencieusement une cible existante et recrée
  une entrée neuve. `RenCommand` reproduit donc la vérification de
  collision explicitement (avec exception pour un changement de casse
  pur, `ren a.txt A.txt`) avant d'appeler `rename()` — limitation connue
  et documentée : la préservation exacte de mtime/attributs/ACL au
  travers d'un `ren` n'est pas garantie (non couverte par la suite de
  tests localisée, donc non bloquante pour cette phase).

**Hors périmètre, échoue désormais explicitement avec « not recognized »
jusqu'à sa propre migration** : `dir`, `ver`, `hostname`, `systeminfo`,
`tasklist`, `netstat`, `vol`, `wmic`, `sc`, `netsh`, `ipconfig`, `ping`,
`ssh`/`sftp`/`scp`/`telnet`, `route`, `arp`, `nslookup`, `net`
(user/localgroup/start/stop/use/share/session/accounts/help), `auditpol`,
`winrm`, `whoami`, `icacls`, `runas`, `chcp`, `date`, `time`, `start`,
`setx`, `schtasks`, `print`, `lpr`, `slmgr`, `nbtstat`, `reg`, `nltest`,
`dcdiag`, `klist`, `netdom`, `dnscmd`, `certreq`, `certutil`, `query`,
`qwinsta`, `logoff`, `rwinsta`, `gpupdate`, `gpresult`, `iisreset`,
`doskey`, `powershell`/`pwsh` (sous-shell depuis cmd), `find`, `findstr`,
`where`, `more`, `fc`, `xcopy`, `sort`, `attrib`, `taskkill`.

**Validation** : lot localisé (8 fichiers ciblés fichiers/session/cwd —
`windows-filesystem`, `windows-drive-switching`, `windows-per-drive-cwd`,
`cmd-ps-coherence`, `subshell-isolation`, `windows-session-isolation`,
`windows-session-migration`, `prompt-cwd`) : 118/144 passent. Les 26
échecs restants pointent tous, sans exception, vers une commande
explicitement hors périmètre ci-dessus (`dir`, `ver`, `hostname`,
`systeminfo`, `tasklist`, `netstat`, `vol`, `wmic`, `sc`, `netsh`) —
aucune régression sur le périmètre migré. Typecheck ciblé propre
(`tsc --noEmit`, zéro erreur dans `command-kernel`/`WindowsPC`/
`WinFileCommands` ; les erreurs préexistantes ailleurs dans le dépôt —
`LinuxSshClient.ts`, `CiscoSwitchShell.ts`, `SshServerHandler.ts`,
`vlan-filter-ordering.test.ts` — ne touchent aucun fichier de cette
session). Lint ciblé non exécutable dans cet environnement (dépendance
`@eslint/js` absente du sandbox, pré-existant, sans rapport avec ce
changement).

**Suite (prochaines phases)** : `dir` en priorité (nécessite son propre
travail — numéro de série de volume, espace libre, correspondance
wildcard, formats large/récursif — pas réductible au `FileSystemApi`
générique sans l'étendre), puis `ver`/`hostname`/`systeminfo`/`tasklist`/
`netstat`/`vol` (commandes système simples), puis le périmètre réseau
(`ipconfig`, `ping`, `netsh`...) qui délèguera à `MachineApi.net` en
s'appuyant sur `EndHost`/`Port`/`Cable` existants (§2 du framework),
jamais une resimulation parallèle.

## Linux — Phase 5 : `rmdir`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Extension du socle** : `FileSystemApi.rmdir(path, actor)` — distinct de
`remove(path, actor, recursive)` : échoue avec `ENOTEMPTY` si le
répertoire n'est pas vide, ne supprime jamais récursivement, même avec
un futur flag. Implémenté via `VirtualFileSystem.rmdir()` (déjà utilisé
par le legacy `cmdRmdir`). Le contrôle du bit sticky et de la permission
du parent, identique à celui de `rm`, a été factorisé dans
`LinuxFileSystemApi.assertStickyRemovable()` (partagé par `remove()` et
`rmdir()`) plutôt que dupliqué — les deux commandes legacy (`cmdRm`/
`cmdRmdir`) ont exactement la même logique de vérification.

**Commande migrée** : `rmdir <répertoire...>` — message d'erreur au
format `rmdir: failed to remove '<cible>': <raison>`, audit
(`syscall=rmdir`) après succès uniquement.

**Validation** : même lot localisé qu'à la phase précédente, `run-parts.
test.ts` inclus — 39 fichiers, 1604 tests, mêmes 3 échecs pré-existants
et sans rapport déjà documentés (bash script `if/then`/fonctions, hors
périmètre command-kernel).

## Linux — Phase 4 : `ln` (liens physiques et symboliques)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Extension du socle** : `FileSystemApi` gagne `link(targetPath, path,
actor)` — lien physique, distinct de `symlink()` déjà existant.
Implémenté dans `LinuxFileSystemApi` via `VirtualFileSystem.createHardLink`
(déjà utilisé par le legacy `cmdLn`, partage réellement le même inode et
incrémente `linkCount` — vérifié par `ls -i` sur les deux noms). Ajouté
aussi dans `testing/in-memory-machine.ts` (le `MachineApi` factice du
socle) en partageant la même référence d'objet entre les deux chemins.

**Commande migrée** : `ln [-s] <cible> <lien>` — lien physique par
défaut, symbolique avec `-s`, message d'erreur au format legacy exact
(`ln: failed to create <kind> '<lien>': <raison>`), audit
(`syscall=symlink`/`syscall=link`) après succès uniquement (§7.4 du
framework).

**Validation** : lot localisé étendu à `run-parts.test.ts` (contient des
créations de liens symboliques cassés/valides) en plus du lot déjà établi
— 39 fichiers, 1604 tests, 3 échecs **confirmés pré-existants et sans
rapport** (méthode §7.2 : mêmes 3 échecs avec `git stash` des changements
de cette phase). Ces 3 échecs concernent l'interpréteur bash de scripts
(`src/bash/`, hors périmètre de `command-kernel`) sur des scripts
utilisant `if/then/else` et des déclarations de fonction — un vrai trou,
mais dans un sous-système entièrement différent, à traiter séparément.

## Linux — Phase 3 : lecteurs d'identité (`id`, `whoami`, `groups`) + durcissement `rm`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suit `migration_framework.md` : vérifié au préalable que `id`/`whoami`/
`groups` n'existent nulle part dans l'autre framework de migration
(`src/network/devices/linux/commands/iam/`) et qu'aucune entrée de
`defaultCommandPrivileges.ts` ne les restreint — `PrivilegeLevel.ANY`
est donc bien équivalent au comportement legacy.

**Périmètre migré** :

- `id` — format par défaut (`uid=…(…) gid=…(…) groups=…`), `-u`/`-g`/`-G`
  (avec `-n` pour les noms), rejet des combinaisons invalides
  (`-n` seul, plusieurs sélecteurs) avec les mêmes messages et le même
  code de sortie que legacy (`0`, sauf utilisateur inexistant → `1`).
- `whoami`, `groups [utilisateur]` (format `nom : groupes` uniquement si
  l'utilisateur est passé explicitement, comme legacy).
- Aucun de ces trois n'a d'effet de bord filesystem — seul le prélude
  générique `publishCommandExecve` (déjà en place, voir la phase
  précédente) s'applique, pas de nouvel appel d'audit par commande.

**Bug trouvé en élargissant les tests localisés (`rm-preserve-root.test.ts`,
jamais inclus dans un lot précédent)** — pas une régression de cette
session, un trou déjà présent depuis la Phase 1 sur `rm`, découvert en
suivant la règle du framework « élargir le filet dès qu'on touche à
IAM/privilège » :

- `rm` n'implémentait ni `--preserve-root`/`--no-preserve-root` (refus de
  `rm -rf /`), ni le bit sticky de `/tmp` (`rm` d'un fichier d'autrui dans
  un répertoire sticky doit échouer avec « Operation not permitted »), ni
  le format de message exact `rm: cannot remove '<cible>': <raison>`
  (le pont renvoyait `rm: <chemin résolu>: <raison>`, sans le préfixe
  `cannot remove`). Fix : `LinuxFileSystemApi.remove()` réplique l'ordre
  exact des vérifications legacy (répertoire non récursif → bit sticky →
  suppression), `RmCommand` porte la logique `--preserve-root` (propre à
  `rm`, pas une notion de filesystem générique) et reformate les erreurs
  au format exact.

**Nettoyage** : déplacement de la validation `cut` (« une option -f, -c ou
-b est requise ») dans `validate()`, sur le modèle déjà établi par
`ChmodCommand` — c'est une incohérence purement syntaxique entre
arguments déjà parsés, indépendante de `ctx.machine`, donc elle n'a pas
sa place dans `execute()`. Les autres validations argument-dépendantes
(`chown` résout un utilisateur/groupe réel, `cut` calcule des plages qui
dépendent de la longueur de chaque ligne) restent dans `execute()` car
elles ont besoin de `ctx.machine` ou d'un état runtime que `validate()`
n'a pas.

**Validation** : lot localisé élargi (38 fichiers, 1457 tests, 0 échec) —
IAM/filesystem, ACL, privilège, audit/journalisation, su/sudo, et
l'ensemble déjà établi des phases précédentes.

## Linux — Fix critique : parité d'audit/trace pour les commandes déjà migrées

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Découvert en élargissant les tests localisés à `auditctl.test.ts`,
`auditctl-other.test.ts`, `journalization.test.ts` et
`journalization-and-audit.test.ts` (480 tests, jamais exécutés contre le
bridge command-kernel avant ce tour) : **25 régressions réelles**,
confirmées par comparaison directe avec le commit précédant l'existence de
command-kernel (480/480 passaient avant migration).

**Cause racine.** `LinuxCommandExecutor.dispatch()` — le point d'entrée
legacy — exécute un prélude AVANT le `switch` de chaque commande : bascule
`currentCommandHead`, puis `publishFsAccess`/`publishSyscall('execve', …)`
pour la commande elle-même, et pour les commandes filesystem, un second
jeu d'appels par argument (`open`/`mkdir`/`unlink`/`rename`/`chmod`/
`chown`…) qui alimente `auditd`/`ausearch`/`aureport` simulés. Le pont
`tryCommandKernel` contourne entièrement `dispatch()` — il n'exécutait
donc ni le prélude, ni les appels par commande, rendant tout audit
silencieusement absent pour les commandes déjà migrées (Phases 1 et 2).

**Fix (pas de repli sur l'ancien chemin — le comportement est reproduit,
pas contourné)** :

- `MachineApi` gagne une capacité optionnelle `audit?: AuditApi`
  (`fsAccess(path, perm, syscall?)`, `syscall(name, path?)`) — absente
  pour les profils qui n'en ont pas besoin, les commandes l'appellent via
  `ctx.machine.audit?.`.
- `LinuxMachineApiDeps` gagne `publishFsAccess`/`publishSyscall`, câblés
  dans `LinuxMachine.getCommandKernelShell()` sur les wrappers publics
  déjà existants `LinuxCommandExecutor.publishAuditFsAccess`/
  `publishAuditSyscall`.
- Nouveau `LinuxCommandExecutor.publishCommandExecve(cmd)` — réplique
  exactement le prélude de `dispatch()` (bookkeeping + accès `/usr/bin/
  <cmd>`+`/bin/<cmd>` + `execve`) ; appelé par `tryCommandKernel` pour
  chaque étage d'un pipeline avant exécution.
- `LinuxFileSystemApi.writeFile()` publie désormais `('w','open')` avant
  d'écrire — couvre à la fois `touch` (avant sa réécriture, voir
  ci-dessous) et toute redirection `>`/`>>` (`FileOutputStream` passe par
  `writeFile`, donc `echo … >> fichier` publie correctement).
- Chaque commande fichier migrée (`ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`,
  `chmod`, `chown`) publie l'événement correspondant, à l'identique de son
  `case` legacy — **après** l'opération réussie (pas avant), pour ne
  jamais logger un accès qui a en fait échoué.
- Nouvelle méthode `FileSystemApi.touch(path, actor)` (implémentée via
  `VirtualFileSystem.touch()`, pas `writeFile()`) : `touch` sur un fichier
  déjà existant ne fait que rafraîchir sa date de modification, sans
  passer par le chemin d'écriture générique — corrige une régression
  fonctionnelle distincte où `touch` déclenchait à tort les observateurs
  `vfs.onWrite()` d'une règle `-w` (donc ignorait les règles
  d'exclusion `-a never,exit -F dir=…`, que `vfs.touch()` ne traverse
  jamais).

**Deux bugs fonctionnels distincts trouvés au passage (mêmes tests)** :

- **`chown user:group_name`** : `ChownCommand` n'acceptait qu'un gid
  numérique après `:` (limitation documentée en Phase 1), alors que
  legacy résout aussi un nom de groupe. Fix : `resolveGid()` (miroir de
  `resolveUid()`) via `ctx.machine.groups.findByName`.
- **`echo "-w ...token qui ressemble à une option inconnue"`** :
  `ArgumentParser` levait `UsageError` sur tout token `-x` non reconnu,
  alors que le vrai `echo` n'échoue jamais sur une option inconnue (il
  l'affiche littéralement). Nouveau `CommandDescriptor.lenientOptions`
  (opt-in, seul `EchoCommand` l'utilise) : un token dash non reconnu
  devient un positional au lieu de lever une erreur.

**Validation** : les 4 fichiers d'audit (480 tests) + l'ensemble déjà
établi (IAM, ACL, text-processing, bash) repassés intégralement —
36 fichiers, 1359 tests, 0 échec.

## Linux — Phase 2 : traitement de texte (coreutils)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Câblée sur le même point d'entrée que la Phase 1, validée contre les
suites de tests dédiées (`linux-cut-flags`, `linux-sort-flags`,
`linux-wc-flags`, `linux-tr-uniq-flags`) et l'ensemble de la Phase 1 +
`linux-bash-details` (pipes, substitutions, échappements) sans
régression.

**Périmètre migré** (`src/network/devices/linux/command-kernel/commands/`) :

- `grep` — `-i`, `-v`, `-n`, `-c`, `-E`, multi-fichiers (préfixe `label:`).
- `head` / `tail` — `-n N` (raccourci numérique `-N`), `head -c N` (octets).
- `wc` — `-l`/`-w`/`-c`/`-m`/`-b`/`-L`, ligne `total` multi-fichiers,
  erreur `wc: <fichier>: No such file or directory` par fichier manquant
  sans interrompre le traitement des fichiers valides.
- `sort` — `-n`, `-r`, `-u`, `-h` (suffixes K/M/G), `-V` (version-sort),
  `-M` (mois), `-f` (insensible à la casse), `-t DELIM` + `-k KEY[,KEY][n]`
  (tri par colonne avec override de type par clé).
- `cut` — `-d`/`-f` (listes et plages `1-3`/`2-`/`-2`), `-c`/`-b`
  (caractères/octets), `-s`/`--only-delimited`, `--output-delimiter`,
  `--complement`.
- `uniq` — `-c`, `-d`, `-u`, `-i`, `-f N`.
- `tr` — `-d`, `-s`, `-c`, classes POSIX (`[:upper:]`...), échappements,
  plages `a-z`.
- `textInput.ts` — helper partagé (`splitLines`/`joinLines`,
  `readTextInput`/`readPerFileInputs`) pour une gestion fidèle du saut de
  ligne final, réutilisé par toutes les commandes ci-dessus.

**Extensions du socle** :

- `ArgumentParser` : valeur courte collée (`-d,` / `-n5`) via
  `matchGluedShortValue`.
- `Executor` : expansion générique de globs (`*`, `?`, `[...]`) au niveau
  du moteur (`exec/glob-expand.ts`), respecte `Word.noExpand`.
- Marqueur interne `ESCAPED_DOLLAR` (`ast/tokens.ts`) : un `\$` (guillemets
  doubles ou nu) survit au lexing sans être expansé comme variable, puis
  restitué en `$` littéral par l'`Expander` — et symétriquement par
  l'`Executor` pour les mots `noExpand` (guillemets simples).

**Bugs trouvés puis corrigés en testant contre la suite existante** :

- **`grep` avalait une ligne vide fantôme.** `content.split('\n')`
  produisait une dernière entrée vide pour tout contenu se terminant par
  `\n` ; avec `-v`, cette ligne vide (ne contenant jamais le motif) était
  incluse à tort, ajoutant un saut de ligne fantôme en sortie — détecté
  via un pipeline `echo | grep -v ... | wc -l` qui comptait une ligne de
  trop. Fix : `grep` utilise désormais `splitLines` (même utilitaire que
  `cat`/`head`/`tail`) au lieu d'un `split('\n')` brut.
- **`\$` échappé était expansé comme variable.** Le lexer réduisait
  `\$dollar` à `$dollar` avant l'expansion, donc l'Expander tentait de
  substituer une variable `dollar` inexistante et l'effaçait. Fix :
  marqueur `ESCAPED_DOLLAR` posé au lexing, restitué en `$` littéral
  après expansion (ou directement pour les mots `noExpand`).
- **`cat` refusait de lire l'entrée standard.** L'argument `files` était
  `required: true`, donc `cat` en fin de pipe (`... | cat`) échouait avec
  « argument requis manquant » au lieu de lire `stdin`. Fix : `files`
  devient optionnel, avec repli sur `ctx.io.stdin.readAll()` — même motif
  que `sort`/`cut`/`head`/`tail`.
- **`sort -k F,Fn` dupliquait le champ.** La reconstruction de clé
  ajoutait un `endTail` même quand `startField === endField`, produisant
  une clé du type `"11 1"` au lieu de `"11"`. Fix : la troncature ne
  s'applique que si un caractère de fin est explicitement spécifié sur le
  même champ ; la valeur du champ seul est utilisée sinon.

**Hors périmètre de cette phase** : réseau, IAM avancé, matériel, audit,
systemd (inchangé depuis la Phase 1).

## Linux — Phase 1 : filesystem & session (coreutils)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Cette phase est câblée sur le vrai point d'entrée
(`LinuxMachine.executeCommand`) et validée contre plus de 20 fichiers de
tests déjà existants dans le projet (filesystem/IAM, ACL POSIX,
substitution de commande, variables d'environnement, hardware, cron,
logging...), en plus des tests dédiés du socle.

**Câblage réel** (`LinuxMachine.tryCommandKernel`, appelé depuis
`executeCommand`) :

- Une ligne passe par `command-kernel` uniquement si elle se réduit, une
  fois parsée, à une commande simple ou un pipeline (jamais `;`, `&&`,
  `||`, boucles, conditions, sous-shells — ceux-ci restent intégralement
  sur `src/bash/` + `LinuxCommandExecutor`) ET si chaque commande qu'elle
  nomme est déjà enregistrée sur le profil Linux. Sinon, repli intégral
  et silencieux sur l'ancien chemin (aucune exécution partielle).
- Le `cwd` et l'`umask` sont lus/réécrits sur `this.executor` à chaque
  appel (pas d'état dupliqué) ; l'identité vient de
  `LinuxUserManager.currentUser`.

**Périmètre migré vers `command-kernel`** (`src/network/devices/linux/command-kernel/`) :

- `LinuxMachineApi` — implémentation réelle de `MachineApi`, pont direct
  vers `VirtualFileSystem` (via `VfsPath` pour les contrôles d'accès
  POSIX), `LinuxUserManager`, `LinuxProcessManager` et les ports
  matériels. Aucun état parallèle : `LinuxCommand`/`LinuxCommandExecutor`
  continuent d'opérer sur les mêmes `VirtualFileSystem`/`LinuxUserManager`
  sous-jacents.
- `LinuxUser` — adapte un `LinuxUserAccount` réel au contrat `User` de
  command-kernel (uid/gid/groupes/gids supplémentaires).
- Commandes : `pwd`, `cd`, `ls` (`-l`, `-a`, `-d`, `-S`, `-R`, `-i`,
  cibles multiples, résolution owner/group par nom), `cat` (`-n`),
  `mkdir` (`-p`), `touch`, `rm` (`-r`, `-f`), `cp`, `mv`, `stat`
  (format par défaut + `-c FORMAT`), `chmod` (octal et symbolique
  `u+w,g-w,o=r`/`a-x`/`u+s`/`g+s`/`o+t`), `chown` (utilisateur par nom,
  groupe par gid numérique).
- `createLinuxHostShell()` — bootstrap par profil d'équipement (§3.2 du
  framework), compose `registerCoreCommands` (universel : `exit`, `echo`)
  + les coreutils ci-dessus.

**Extensions du socle `command-kernel`** (nécessaires, pas de façade
parallèle créée) :

- `FileSystemApi` prend désormais un `FileSystemActor` (uid/gid/gids)
  explicite à chaque appel — le contrôle d'accès dépend de qui appelle,
  pas de quelle machine répond ; une seule `MachineApi` reste partagée
  entre toutes les sessions/terminaux d'un équipement.
- `FileStat` enrichi (`type`, `ownerGid`, `linkCount`, `inode`,
  `symlinkTarget`) ; `FileSystemApi` gagne `lstat`, `exists`, `copy`,
  `rename`, `symlink`, `readlink`.
- Nouvelle erreur `FileSystemError` (ENOENT/EACCES/ENOTDIR/EISDIR/EEXIST/
  ENOTEMPTY), alignée sur `VfsPath.PathError`.
- `User` gagne `supplementaryGids` (gids numériques, distincts des noms
  de groupe utilisés pour `PrivilegePolicy`).
- `UserManagementApi.findByUid` + nouvelle `GroupManagementApi`
  (`findByGid`/`findByName`) sur `MachineApi.groups` — nécessaires pour
  que `ls -l`/`stat` affichent des noms, pas des identifiants numériques.
- `ArgumentParser` : options courtes combinables (`-la` = `-l -a`) ;
  correction d'un bug où un positional variadique optionnel resté vide
  faisait répondre `ParsedArgs.has()` par « présent ».
- L'AST distingue désormais les mots issus de guillemets simples
  (`Word.noExpand`) : un argument comme `'texte $VAR'` n'est plus expansé
  par erreur — bug trouvé en migrant des scripts réels.
- Commandes universelles (`registerCoreCommands`) : `EchoCommand` sait
  interpréter `-e`/`-n`/`-E` (échappements bash `\n`, `\t`...).

**Bugs trouvés puis corrigés en testant contre la suite existante** :

- **ACL POSIX contournées.** `FileSystemActor` ne portait que des
  identifiants numériques (uid/gid/gids) ; `VfsPath.allows()` ne consulte
  les ACL (`setfacl`) que si `PathActor.user`/`groupNames` (des noms) sont
  renseignés. Fix : `FileSystemActor` et `toFileSystemActor()` portent
  désormais `name`/`groupNames`, propagés jusqu'à `VfsPath` par
  `LinuxMachineApi`.
- **Substitution de commande non supportée.** L'Expander de
  command-kernel ne gère pas `$(...)`/`` `...` ``. `tryCommandKernel`
  refuse maintenant le routage dès que la ligne brute contient l'un des
  deux (repli intégral sur l'ancien chemin, qui les supporte).
- **Variables d'environnement non alimentées.** La session construite par
  le pont avait un `env` toujours vide. `LinuxCommandExecutor.getEnvSnapshot()`
  expose maintenant le même environnement complet (statique + calculé :
  `HOSTNAME`, `HOME`, `USER`...) que celui que `LinuxCommandExecutor`
  construit pour son propre interpréteur bash (`buildEnvVars()`), utilisé
  pour peupler la session à chaque appel.

**Hors périmètre de cette phase (volontairement, à traiter en phases
suivantes)** :

- Réseau (`ip`, `ping`, `iptables`…), IAM avancé (`useradd`, `passwd`,
  `chage`…), matériel (`lspci`…), audit, services systemd — restent sur
  `LinuxCommand`. `LinuxMachineApi.net`/`.proc`/`.users` existent déjà
  (réels, pas des stubs) mais aucune commande de ce périmètre n'est
  encore migrée.
- `chown` : groupe par gid numérique uniquement, pas par nom (pas de
  résolution de groupe par nom câblée dans la commande elle-même, bien
  que `MachineApi.groups` existe désormais).
- `umask` fixé à la valeur courante de `LinuxCommandExecutor` au moment
  de l'appel (lu dynamiquement, mais aucune commande `umask` n'est
  migrée pour le modifier depuis command-kernel).
- Pas de vérification du bit d'exécution sur les répertoires ancêtres
  lors de la traversée de chemin (le `VirtualFileSystem` sous-jacent ne
  l'implémente pas non plus — pas une régression introduite ici).

## command-kernel — socle initial

Architecture d'interpréteur de commandes indépendante du vendeur
(`src/command-kernel/`) : sessions & `PrivilegePolicy` portée par la
commande, `CommandIO`/pipes, façade `MachineApi`, parsing d'arguments
typé, `ICommand`/`CommandRegistry`, Lexer/Parser/AST/Executor complets
(pipes, `&&`/`||`, `if`/`for`/`while`, sous-shells isolés, redirections
`>`/`>>`/`<`), `Interpreter`, `Terminal`/`VirtualTerminal`, `Shell` (REPL,
historique, prompt).
