# Changelog

Journal des évolutions du socle `command-kernel` et de sa migration
progressive par équipement. Un push = une entrée = une fonctionnalité
complète et testée (voir `CLAUDE.md` / le framework de migration pour les
principes directeurs).

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
