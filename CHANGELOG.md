# Changelog

Journal des évolutions du socle `command-kernel` et de sa migration
progressive par équipement. Un push = une entrée = une fonctionnalité
complète et testée (voir `CLAUDE.md` / le framework de migration pour les
principes directeurs).

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
