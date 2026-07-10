# Changelog

Journal des évolutions du socle `command-kernel` et de sa migration
progressive par équipement. Un push = une entrée = une fonctionnalité
complète et testée (voir `CLAUDE.md` / le framework de migration pour les
principes directeurs).

## Linux — Phase 1 : filesystem & session (coreutils)

**État : branche de travail, pas encore mergée sur `mandeng`.** Cette
phase est câblée sur le vrai point d'entrée (`LinuxMachine.executeCommand`)
mais porte des régressions connues et non corrigées listées plus bas —
voir « Bugs connus, non corrigés ».

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

**Bugs connus, non corrigés (trouvés en testant contre la suite
existante, à traiter avant toute fusion sur `mandeng`)** :

- **ACL POSIX contournées.** `FileSystemActor` ne porte que des
  identifiants numériques (uid/gid/gids) ; `VfsPath.allows()` n'consulte
  les ACL (`setfacl`) que si `PathActor.user`/`groupNames` (des noms) sont
  renseignés. Résultat : une commande migrée (`cat`, `mkdir`...) ignore
  les ACL POSIX et retombe sur les seuls bits rwx classiques. Fix
  identifié mais pas encore appliqué : porter `user`/`groupNames` dans
  `FileSystemActor`.
- **Substitution de commande et variables d'environnement non gérées.**
  L'Expander de command-kernel ne connaît que `$VAR`/`${VAR}`/`$?`/`~` —
  ni `$(...)`/`` `...` `` (substitution), ni les variables
  d'environnement réelles (`$HOSTNAME`, `$USER`..., la session
  `command-kernel` construite par le pont a un `env` vide). Une commande
  migrée utilisant l'un ou l'autre dans ses arguments produit un résultat
  silencieusement faux au lieu d'un repli ou d'une erreur. Aucun garde-fou
  n'est encore en place dans `tryCommandKernel` pour détecter ces cas et
  refuser le routage.

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
