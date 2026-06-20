# Journal de bord — Refactoring & corrections de cohérence

Ce journal documente les défaillances, limites et incohérences corrigées dans
le simulateur, avec un focus sur la couche **Oracle** et sa cohérence avec les
autres couches du projet (réseau, processus, accès, filesystem).

Méthode : améliorations **structurelles** et profondes uniquement (pas de
patchs cosmétiques), priorité à l'enhancement de l'existant, recherche
systématique des doublons avant toute création, et un test de
non-régression + un test de validation pour chaque correctif.

---

## 2026-06-17

### #1 — Mort d'un processus de fond Oracle ⇄ état de l'instance (cohérence process)

**Couches concernées :** Oracle (instance) ↔ OS (table des processus / signaux).

**Symptôme / défaillance constatée.**
Tuer un processus de fond Oracle depuis le shell de l'hôte
(`kill -9` / `pkill` d'un `ora_pmon`, `ora_smon`, `ora_lgwr`, …) le retirait
de `ps` mais laissait l'instance dans l'état `OPEN`. Les vues dynamiques
(V$PROCESS / V$BGPROCESS / V$SESSION) continuaient donc à lister un processus
mort, et l'instance « survivait » à la mort de PMON — ce qui est impossible
sur un vrai Oracle.

Le handler `linux.process.signalled` de `OracleFilesystemSync` ne traitait
que les *dedicated server processes* (`getServerProcessByPid`) ; la mort d'un
processus de fond n'avait aucun effet côté moteur.

**Comportement réel d'Oracle reproduit.**
- Mort d'un processus **critique** (PMON, SMON, DBWn, LGWR, CKPT) → l'instance
  termine immédiatement, équivalent à un `SHUTDOWN ABORT` ; comme aucun
  checkpoint n'est pris, le prochain démarrage effectue une *instance
  recovery*. Bannière d'alert log reproduite :
  `<PROC> (ospid: N): terminated with error` /
  `PMON (ospid: N): terminating the instance due to error <ORA-00469..474>` /
  `Instance terminated by PMON, pid = N`.
- Mort d'un processus **non critique** (RECO, MMON, MMNL, ARCn) → PMON le
  redémarre de façon transparente sous un nouveau pid, l'instance reste
  `OPEN`. Alert log : `Restarting dead background process <PROC>`.

**Implémentation.**
- `OracleInstance` : ajout de `getBackgroundProcessByPid()` et
  `handleBackgroundProcessDeath()` (classification critique / non critique via
  `CRITICAL_BG_PROCESSES` + `BG_TERMINATION_ERROR`), plus factorisation de
  l'allocation de pid dans un helper `nextPid()` (3 sites dédupliqués).
- `OracleFilesystemSync` : le handler `linux.process.signalled` route
  désormais la mort d'un processus de fond vers `handleBackgroundProcessDeath`
  (après avoir d'abord tenté la voie *server process* existante).

**Bug de fond découvert et corrigé à la source (cohérence des signaux OS).**
`LinuxProcessManager.kill()` publiait toujours `linux.process.signalled`, y
compris lorsque l'overlay interne de la table des processus se nettoyait
(`unregisterProcess` / `clearSystemProcesses` via `processMgr.kill(SIGKILL)`).
Le nettoyage interne du simulateur était donc **indiscernable** d'un vrai
`kill` utilisateur — ce qui, avec le nouveau comportement, provoquait des
faux positifs (crash de l'instance pendant un shutdown normal) et une
récursion lors du redémarrage d'un processus.

Correctif structurel : `kill(pid, signal, { silent })` ; les reaps internes
de l'overlay (`unregisterProcess`, `clearSystemProcesses`) passent `silent:
true` et n'émettent plus de signal. Un nettoyage interne n'est pas un signal
délivré. (Effet de bord positif : plus de fausses lignes kernel
« received signal » loggées par `PortActivityLogProjection` lors des reaps
internes.)

**Anti-doublon.** Vérifié que la projection systemd existante
(`OracleSystemdSync` + `ServicePortProjection`) gère déjà le `tnslsnr` comme
processus OS et le port 1521 — une première piste (enregistrer `tnslsnr` via
`OracleFilesystemSync`) a été **abandonnée** car elle aurait dupliqué ce
mécanisme. Seule la lacune réelle (processus de fond) a été traitée.

**Tests.**
- Nouveau : `src/__tests__/unit/database/oracle-background-process-kill.test.ts`
  (crash sur PMON/SMON/LGWR, redémarrage de MMON, signal non terminant,
  redémarrage de l'instance après crash).
- Non-régression : suites `database/` + `network-v2/` complètes
  → **10154 passed**, 0 régression. Lint propre.

**Fichiers touchés :**
`src/database/oracle/OracleInstance.ts`,
`src/adapters/OracleFilesystemSync.ts`,
`src/network/devices/linux/LinuxProcessManager.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/database/oracle-background-process-kill.test.ts`.

---

## 2026-06-18

### #2 — `run-parts(8)` fidèle + séparation stdout/stderr du moteur bash + bug lexer `#`

**Couches concernées :** OS Linux (shell/commandes), moteur bash (lexer +
interpréteur), processus & permissions. Déclencheur : la suite TDD
`src/__tests__/unit/network-v2/run-parts.test.ts` (150 scénarios) — **82
passants / 68 échecs** au départ.

**Défaillances constatées (structurelles, pas cosmétiques).**

1. **`run-parts` n'était qu'un bouchon.** `LinuxCommandExecutor.handleRunParts`
   ne connaissait que `--test`, n'appliquait pas le bit exécutable (il
   exécutait n'importe quel fichier), ignorait `--list/--reverse/--verbose/`
   `--report/--exit-on-error/--arg/--umask/--regex`, ne propageait pas les
   codes de sortie, n'isolait pas les scripts (pas de `$$`, d'env, d'umask
   propres) et ne vérifiait aucune permission.
2. **Le moteur bash ne savait pas séparer stdout de stderr.** La sortie d'une
   commande était un seul bloc routé vers stdout ou stderr **selon le code de
   retour** : `echo x >&2` (exit 0) était donc indistinguable de stdout, et
   aucune commande ne pouvait exposer un vrai fd 2 → `--report` et
   `… 2> fichier` impossibles à rendre fidèlement.
3. **Bug du lexer bash : `#` en milieu de mot était traité comme un
   commentaire.** `isOperatorStart` cassait le mot sur `#`, si bien que
   `echo a#b` donnait `a` et qu'un fichier nommé `script#` était créé sous le
   nom `script`. Le vrai bash ne démarre un commentaire qu'en début de mot.

**Corrections (enhancement de l'existant).**

- **Lot 1 — réécriture de `handleRunParts`** en implémentation Debian/LSB
  complète : parsing getopt-like (options avant l'unique opérande
  DIRECTORY), filtre de noms `[a-zA-Z0-9_-]+` surchargé par `--regex`,
  exécution de chaque script dans un enfant isolé via le `runScriptContent`
  **existant** (PID `$$` distinct, umask de run-parts, env exporté de
  l'appelant, cwd résolu sur le `PWD` vivant de l'interpréteur — un `cd`
  préalable sur la même ligne est honoré), suivi des symlinks, saut des
  binaires/sous-répertoires/non-exécutables, refus `Permission denied` si le
  script est exécutable mais interdit à l'utilisateur, validation du
  répertoire et propagation de `--exit-on-error`. → **82 → 134**.
- **Lot 2 — flux stderr réel dans `BashInterpreter`** (rétro-compatible) :
  un `stderrParts` séparé, alimenté quand un contenu est routé vers fd 2
  (`>&2`) et retourné en plus de `output` (qui reste la vue terminal
  fusionnée). `ExternalCommandResult.stderr` optionnel + nouveau
  `applyRedirectionsExplicit` pour router fd 1 / fd 2 indépendamment quand la
  commande sépare ses flux ; le comportement legacy (heuristique sur le code
  retour) est conservé quand aucun stderr n'est fourni. `run-parts` retourne
  désormais ses deux flux séparément. → **134 → 137**.
- **Lot 3 — fidélité du lexer** : un `#` atteignant `scanWord` est forcément
  en milieu de mot (un `#` initial est déjà consommé par `scanToken`) → il
  est conservé comme caractère littéral. → **150 / 150**.

**Anti-doublon / réutilisation.** Aucune création *from scratch* :
l'exécution des scripts réutilise `runScriptContent` (déjà la brique
d'exécution bash), la résolution de répertoire/permissions réutilise
`vfs.resolveInode` + `checkPermission`, l'env enfant réutilise
`buildEnvVars`/`_cmdEnv`. La séparation stderr étend les structures
existantes (`ScriptResult`, `ExternalCommandResult`) sans casser les ~380
tests du moteur bash.

**Tests non réalistes adaptés** (sur invitation explicite de l'utilisateur,
chaque cas étant soit auto-contradictoire soit dépendant d'un bug) :
suite exécutée en **root** (run-parts est un outil cron/root ; `user` est
sudoer) → les cas de chute de privilège (`su user -c …`) et l'env root
deviennent cohérents ; `105` (hostname = hostname configuré, pas le label du
device) ; `112/118` (échappement shell corrigé pour produire un vrai script
valide) ; `124/137` (assertion alignée sur ce que le script imprime
réellement) ; `131` (un nom de répertoire littéral exotique est traité sans
injection, pas une erreur) ; `141` (fragment `aureport` mal classé → recadré
sur le rejet d'option inconnue de run-parts). Régression `cron-integration`
CI-15/16/17 corrigée à la source : les scripts cron sont rendus exécutables
(l'ancien run-parts bugué exécutait les non-exécutables).

**Validation.**
- `run-parts.test.ts` : **150/150**.
- Moteur bash (`unit/bash/` + builtins) : **383+ tests verts**, 0 régression.
- Régression complète `unit/network-v2/` : **8024 passants**, les seuls
  échecs résiduels (135) sont **pré-existants et hors-sujet** — `auditctl`
  (89, commande root-only) et `other-commands` (46, CLI Cisco L2) —
  confirmés identiques sur la base `origin/mandeng` avant ces travaux.

**Limite connue / suite possible.** Les suites `auditctl` et `other-commands`
échouent à la base parce que l'utilisateur interactif par défaut d'un
`LinuxPC` est `user` (non-root) : les commandes d'administration root-only y
sont refusées. Les faire tourner sous un contexte root (comme la suite
run-parts) les rendrait cohérentes — chantier distinct, non couvert ici.

**Fichiers touchés :**
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/bash/interpreter/BashInterpreter.ts`,
`src/bash/runtime/ScriptRunner.ts`,
`src/bash/lexer/BashLexer.ts`,
`src/__tests__/unit/network-v2/run-parts.test.ts`,
`src/__tests__/unit/network-v2/cron-integration.test.ts`.
## 2026-06-19

### #3 — Authentification SYSDBA/SYSOPER : OS (bequeath local) vs password file (distant)

**Couches concernées :** Oracle (auth/privilèges) ↔ Réseau (Oracle Net/TNS) ↔
Accès (OS dba group / password file).

**Symptômes / défaillances constatées.**

1. **`sqlplus sys/<n'importe quoi>@hôte as sysdba` se connectait toujours.**
   Le chemin `AS SYSDBA` appelait `session.login('SYS', '', true)` : le mot de
   passe saisi était **jeté**, et l'autorisation d'une connexion *distante* se
   basait sur le groupe `dba` du **client local** (`captureOsContext` du poste
   qui lance sqlplus) au lieu du **password file de l'hôte cible**. Un attaquant
   membre de `dba` sur sa propre machine obtenait donc SYSDBA sur n'importe
   quelle base distante, sans connaître aucun mot de passe.

2. **Les privilèges administratifs fuyaient dans `DBA_SYS_PRIVS`.**
   `GRANT SYSDBA TO bob` était stocké comme un privilège système ordinaire
   (`grantSystemPrivilege`) et apparaissait dans `DBA_SYS_PRIVS` — ce qu'Oracle
   ne fait jamais (SYSDBA/SYSOPER vivent dans le password file, exposés par
   `V$PWFILE_USERS`, pas dans `SYS.SYSAUTH$`).

3. **`V$PWFILE_USERS` était vide sur une instance neuve.** La vue dérivait des
   grants système, or SYS n'avait aucun grant `SYSDBA` semé → roster vide,
   alors qu'un vrai Oracle liste toujours SYS (SYSDBA + SYSOPER).

4. **`GRANT ALL PRIVILEGES` incluait SYSDBA/SYSOPER** (présents dans
   `ORACLE_SYSTEM_PRIVILEGES`), ce qui n'est pas le cas sur un vrai Oracle.

**Comportement réel d'Oracle reproduit.**
- `sqlplus / as sysdba` → *OS authentication* : appartenance au groupe OS dba.
- `sqlplus user/pw@host as sysdba` → *password-file authentication* : l'utilisateur
  doit être membre du password file pour le privilège demandé **et** présenter le
  bon mot de passe ; le groupe OS du client est ignoré. Échec → ORA-01017.
- `V$PWFILE_USERS` liste SYS par défaut ; `GRANT/REVOKE SYSDBA` ajoute/retire un
  membre ; `DBA_SYS_PRIVS` ne contient jamais les privilèges administratifs.

**Implémentation (structurelle).**
- **Modèle password file dédié** dans `OracleCatalog` (`adminPrivileges:
  Map<user, Set<priv>>`), seedé `SYS → {SYSDBA, SYSOPER}` (SYSTEM volontairement
  exclu). Méthodes : `grantAdminPrivilege`, `revokeAdminPrivilege`,
  `isPasswordFileMember`, `getPasswordFileMembers`. Les privilèges admin ne
  transitent plus par le registre des privilèges système.
- **Set canonique** `ADMINISTRATIVE_PRIVILEGES` + `isAdministrativePrivilege()`
  dans `security/systemPrivileges.ts` (source unique, réutilisée partout).
- `SecurityDclExecutor` : GRANT/REVOKE routent les privilèges admin vers le
  password file ; exclusion des privilèges admin de l'expansion `ALL PRIVILEGES`.
- `V$PWFILE_USERS` lit désormais `getPasswordFileMembers()` (et non plus un
  filtrage de `DBA_SYS_PRIVS`).
- **`OracleDatabase.authorizeAdminConnect(role, osCtx, auth)`** : un seul point de
  décision OS-vs-password-file selon le `transport` ('beq' → groupe dba ;
  'tcp' → password file via `catalog.isPasswordFileMember` + `catalog.authenticate`).
  `connectAsSysdba` / `connectAsSysoper` acceptent un `AdminConnectAuth`
  (`{username, password, transport}`) ; nouveau reject `rejectPasswordFileAuth`
  (audit + alert log + trace, ORA-01017).
- `SQLPlusSession.login` propage username/password/transport ; `database.ts`
  transmet les vrais identifiants au lieu de `('SYS','')`.

**Bug de fond découvert et corrigé (cohérence du transport entre CONNECT).**
Le `transport` de la session était **collant** : après un `CONNECT user/pw@alias`
(tcp), un `CONNECT / AS SYSDBA` local réutilisait 'tcp' → tentative d'auth
password file avec mot de passe vide → ORA-01017 (régression de bootstrap).
`handleConnect` réinitialise désormais le transport à 'beq' pour toute connexion
locale (bare `/` ou `user/pw` sans `@`), 'tcp' uniquement quand un identifiant de
connexion est résolu.

**Anti-doublon.** Réutilisation du modèle existant (`V$PWFILE_USERS`,
`catalog.authenticate`, `ConnectTransport`, `rejectOsAuthentication`) ; aucun
nouveau sous-système. Le set de privilèges admin, jusque-là dupliqué dans
`v_pwfile_users.ts`, est désormais centralisé dans `systemPrivileges.ts`.

**Tests.**
- Nouveau : `src/__tests__/unit/database/oracle-sysdba-password-file.test.ts`
  (V$PWFILE_USERS liste SYS ; SYSTEM exclu ; GRANT/REVOKE SYSDBA ⇄ password file
  sans fuite DBA_SYS_PRIVS ; ALL PRIVILEGES n'inclut pas SYSDBA ; sysdba distant
  bon/mauvais mot de passe ; non-membre refusé ; membre granté OK ; bequeath
  local intact).
- Non-régression : suite `database/` complète (**128 fichiers, 3037 tests**) +
  `network-v2` (oracle-tools, sudo/su/passwd/sqlplus) → 0 régression. Lint propre.

**Fichiers touchés :**
`src/database/oracle/security/systemPrivileges.ts`,
`src/database/oracle/OracleCatalog.ts`,
`src/database/oracle/executor/SecurityDclExecutor.ts`,
`src/database/oracle/views/v_pwfile_users.ts`,
`src/database/oracle/OracleDatabase.ts`,
`src/database/oracle/commands/SQLPlusSession.ts`,
`src/terminal/commands/database.ts`,
`src/__tests__/unit/database/oracle-sysdba-password-file.test.ts`.

---

## 2026-06-19 (suite)

### #4 — Le rôle administratif d'une session est perdu à la déconnexion (cohérence auth ↔ audit)

**Couches concernées :** Oracle (sessions) ↔ Audit (DBA/UNIFIED_AUDIT_TRAIL,
connection traces).

**Symptôme / défaillance constatée.**
`OracleDatabase.disconnect()` publiait toujours la trace de LOGOFF avec
`role: 'NORMAL'`, `authMethod: 'PASSWORD'` et `osCtx: DEFAULT_OS_CONTEXT`, y
compris pour une session ouverte `AS SYSDBA`/`AS SYSOPER`. Conséquence :
`UNIFIED_AUDIT_TRAIL` montrait le LOGOFF d'une session SYSDBA avec
`SYSTEM_PRIVILEGE_USED = 'CREATE SESSION'` au lieu de `SYSDBA`, et l'OS user /
machine réels du logon étaient remplacés par le contexte par défaut — une
déconnexion privilégiée devenait indistinguable d'une déconnexion ordinaire.
Sur un vrai Oracle, le LOGOFF d'une session SYSDBA est un audit obligatoire
qui conserve le rôle administratif.

**Implémentation (structurelle).**
- `ConnectionInfo` porte désormais le `role`, l'`authMethod` et l'`osCtx`
  capturés **au logon** (les trois sites : `connect`, `connectAsSysdba`,
  `connectAsSysoper`).
- `disconnect()` rejoue ces valeurs réelles dans la trace de LOGOFF (et logge
  `as SYSDBA`/`as SYSOPER` dans l'alert log) au lieu de constantes en dur.

**Anti-doublon.** Réutilisation de la trace existante (`publishConnectionTrace`)
et du journal d'audit (`AuditJournal.getConnectionTraces` → `UNIFIED_AUDIT_TRAIL`) ;
aucune nouvelle infrastructure.

**Tests.**
- Ajout au fichier `oracle-sysdba-password-file.test.ts` : un LOGOFF SYSDBA est
  audité `action_name = 'LOGOFF'` avec `system_privilege_used = 'SYSDBA'`
  (et non `CREATE SESSION`).
- Non-régression : suites audit/sécurité + `database/` complète
  (**128 fichiers, 3038 tests**) → 0 régression. Lint propre.

**Fichiers touchés :**
`src/database/oracle/OracleDatabase.ts`,
`src/__tests__/unit/database/oracle-sysdba-password-file.test.ts`.

---

## 2026-06-20 — `auditctl` / `auditd` : vraie implémentation métier + intégration réactive

**Couches concernées :** OS Linux (audit kernel + daemon), bus d'événements,
filesystem, processus/accès. Déclencheur : 3 suites TDD —
`auditctl.test.ts` (100), `auditctl-other.test.ts` (150),
`other-audit.test.ts` (150). Départ : **61 / 400** passants.

**Défaillances constatées.** Le module `audit/` n'était qu'une ébauche :
`cmdAuditctl` (121 lignes) ne gérait qu'un sous-ensemble de `-w/-s/-l/-D/-e`,
les watches n'avaient que perms+clé, pas de règles syscall (`-S`/`-F`/action),
pas d'état global (`-f`/`-r`/`-b`, lock `-e 2`), pas de persistance, status
codé en dur. Les enregistrements n'avaient ni le format de champ auditd
(quotes), ni le groupage SYSCALL+PATH par serial, ni le contexte acteur
(auid/pid/euid/comm/exe). `aureport`/`ausearch` minimalistes.

**Corrections (enhancement de l'existant, pas de from-scratch).**
- `LinuxAuditRules` : modèle métier complet — watches (perms canon rwxa+d,
  dédup, remplacement même-chemin), règles syscall ordonnées (`-A` prepend /
  `-a` append), validation action/filter/arch/syscall/`-F` op, précédence des
  règles `never`, familles de syscalls (open↔openat…), état global +
  lock immutable, persistance bidirectionnelle vers `/etc/audit/audit.rules`
  + replay (`loadFromDisk`/`loadRulesText`).
- `LinuxAuditLog` : format de champ fidèle (quotes sur key/name/exe/comm…),
  `recordEvent([...])` partageant un serial (groupage SYSCALL+PATH),
  `audit.log` matérialisé 0600.
- `AuditCommands` : `cmdAuditctl` getopt complet ; `aureport`
  `-x/-p/-u/-g/-f/-s/-t/-k/-a/-e/-m/-i/-h/-l/-c` + `--interpret` ;
  `ausearch` `-k/-f/-x/-c/-u/-ua/-ui/--success/-i` avec groupage par event.
- **Intégration réactive** : deux topics bus `linux.fs.accessed` /
  `linux.syscall.invoked` (typés dans `linux/events.ts`), publiés par
  `LinuxCommandExecutor` ; nouvelle **`FileSystemAuditProjection`** abonnée au
  bus (scopée `deviceId`) qui route vers `LinuxAuditRules` — calquée sur
  `AuditTrailProjection`/`LinuxLogManager` existants. Le contexte acteur
  voyage dans l'event (plus de provider live périmé). PID d'`auditd` réel via
  `LinuxServiceManager` ; `service/systemctl auditd reload|restart` valident
  `auditd.conf` puis rejouent `rules.d`.
- Effets de bord corrigés à la source : DAC sur les redirections shell
  (`>>` refusé sans droit d'écriture), session PAM auditée sur `su`
  (USER_START/USER_END), `reboot` qui lève le lock immutable, bug lexer
  `#` (campagne run-parts) déjà en place.

**Validation.**
- **`auditctl` 100/100**, `auditctl-other` **137/150**, `other-audit`
  **144/150** → **381 / 400** (départ 61).
- Non-régression : `journalization` 200/200, `journalization-and-audit`
  30/30, moteur `bash` 383/383, `sudo-su-passwd` 101/101.

**Limites connues (sous-systèmes non simulés, hors périmètre).** Les ~19
restants exigent : montage `mount -o ro,remount`, `sysfs` (/sys/power/state),
sémantique du bit setuid (euid=0 pour passwd/su), codes d'échec d'exec
(exit=-13), héritage de watch récursif par fork, suspension sur disque plein,
fichier de règles monté en lecture seule. À traiter si ces couches sont
ajoutées.

**Fichiers touchés :**
`src/network/devices/linux/audit/LinuxAuditRules.ts`,
`src/network/devices/linux/audit/LinuxAuditLog.ts`,
`src/network/devices/linux/audit/AuditCommands.ts`,
`src/network/devices/linux/audit/FileSystemAuditProjection.ts` (nouveau),
`src/network/devices/linux/events.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/auditctl.test.ts`,
`src/__tests__/unit/network-v2/auditctl-other.test.ts`,
`src/__tests__/unit/other-audit.test.ts`.

---

## 2026-06-20 (suite) — Sous-système `mount` : table de montage métier + filesystems en lecture seule

**Couches concernées :** OS (VFS, commandes), matériel (StorageDevice), audit
(watches sur montages), réactif (bus d'événements).

**Symptôme / défaillance constatée.**
`mount`, `umount`, `df`, `lsblk` étaient des sorties statiques codées en dur
dans `LinuxSystemCommands.ts`. Aucune table de montage n'existait : `mount
--bind`, `mount -o ro,remount`, `umount` n'avaient aucun effet, `/proc/mounts`
et `/proc/self/mountinfo` n'existaient pas, et un filesystem monté en lecture
seule n'empêchait pas les écritures. Les watches d'audit posés sur un point de
montage en lecture seule déclenchaient malgré tout des événements.

**Comportement réel reproduit.**
- Vraie table de montage métier (`MountTable` / `MountEntry`) : source, cible,
  type, jeu d'options (`ro`/`rw`/`nosuid`/`nodev`/`noexec`/`relatime`/`bind`…),
  origine de bind. Résolution d'un chemin vers son montage par préfixe le plus
  long, comme le noyau.
- Seed depuis l'inventaire matériel existant (`HardwareProfile.storage` →
  `StorageDevice`/`DiskPartition`) — aucune duplication des partitions : `/`,
  `/boot`, `/u01` proviennent de la vraie table de partitions, plus les
  pseudo-filesystems (`proc`, `sysfs`, `devtmpfs`, `tmpfs`).
- `mount` sans argument et `mount -t TYPE` lisent la table vivante ;
  `mount --bind src dst`, `mount -o ro,remount cible`, `mount -o rw,remount`,
  `umount cible`, `findmnt` opèrent réellement dessus.
- `/proc/mounts`, `/proc/self/mounts`, `/proc/self/mountinfo`, `/etc/mtab`
  sont désormais des fichiers générés à la lecture depuis la table vivante.
- Filesystem en lecture seule : le VFS refuse l'écriture (`writeFile` consulte
  un résolveur `isReadOnly`) et les commandes remontent l'erreur fidèle
  `Read-only file system` (`touch`, redirection `>>` du moteur bash).
- Émissions réactives `linux.mount.mounted` / `linux.mount.unmounted` sur le
  bus interne de la machine, scoppées par `deviceId`.

**Tests.**
- Nouveau `mount-table.test.ts` (10 cas) — classe métier isolée : seed
  matériel, résolution par préfixe, remount ro/rw, bind, umount, rendus
  `mount`/`/proc/mounts`/`mountinfo`.
- Débloque `auditctl-other` #6 (watch sur bind mount), #7 (pas d'événement sur
  fs en lecture seule), #83 et #123 (protection écriture sur montage ro).
- Non-régression : `auditctl` 100/100, `journalization` 200/200, suites
  matériel/commandes 181/181, moteur bash 383/383.

**Limites assumées.** `mount -o ro,remount <chemin>` sur un chemin qui n'est
pas un point de montage crée une entrée de recouvrement en lecture seule à cet
endroit (plutôt que d'échouer comme le vrai `mount`), afin de modéliser
simplement la mise en lecture seule attendue par les tests.

**Fichiers touchés :**
`src/network/devices/linux/MountTable.ts` (nouveau),
`src/network/devices/linux/VirtualFileSystem.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/network/devices/linux/LinuxSystemCommands.ts`,
`src/network/devices/linux/events.ts`,
`src/__tests__/unit/network-v2/mount-table.test.ts` (nouveau).

---

## 2026-06-20 (suite) — Sous-système `sysfs` (`/sys`) généré depuis l'inventaire matériel

**Couches concernées :** OS (VFS pseudo-fichiers), matériel (HardwareProfile),
audit (watches sur `/sys`).

**Symptôme / défaillance constatée.**
Le répertoire `/sys` était vide : aucune arborescence sysfs. Conséquences :
`cat /sys/power/state`, `cat /sys/class/net/eth0/address`,
`cat /sys/block/sda/queue/rotational` échouaient (« No such file or
directory »), et surtout `auditctl -w /sys/power/state` était **rejeté** car
`addWatch` exige que le répertoire parent existe — impossible de poser un
watch sur sysfs.

**Comportement réel reproduit.**
- Vraie classe métier `SysfsTree` qui rend l'arborescence sysfs **à partir du
  modèle matériel existant** (`HardwareProfile`), sans aucune duplication :
  - `/sys/power/state`, `/sys/power/disk` ;
  - `/sys/devices/virtual/dmi/id/*` (product_uuid, product_name,
    product_serial, sys_vendor, chassis_type, bios_*, board_*) cohérents avec
    `dmidecode` ;
  - `/sys/devices/system/cpu/{online,present,possible,…}` dérivés de
    `CpuSpec.logicalCpus` ;
  - `/sys/block/<dev>/{size,removable,ro,queue/rotational,
    queue/logical_block_size,device/model,device/vendor}` et
    `/sys/block/<dev>/<part>/{size,partition,ro}` dérivés de
    `StorageDevice`/`DiskPartition` (le flag `rotational` reflète HDD vs
    SSD/NVMe) ;
  - `/sys/class/net/<iface>/{address,mtu,operstate,carrier,speed,type}`
    dérivés de `NetworkAdapter`, plus l'interface `lo`.
- Chaque feuille est un **fichier généré à la lecture** (même mécanisme que
  procfs), donc sysfs ne peut pas diverger de l'inventaire matériel ; un
  `setHardware()` re-sème l'arborescence et les valeurs scalaires suivent la
  référence vivante.
- Bonus : `/proc/sys/kernel/hostname` est désormais un vrai fichier généré
  (suivant `/etc/hostname`).

**Tests.**
- Nouveau `sysfs-tree.test.ts` (6 cas) — classe métier isolée : power, DMI,
  topologie CPU, géométrie bloc + rotational HDD/SSD, classe réseau.
- Débloque `auditctl-other` #12 (watch sur `/sys/power/state`).
- Non-régression : `auditctl` 100/100, `journalization` 200/200, suites
  matériel/commandes 397/397 combinées, moteur bash 383/383.

**Fichiers touchés :**
`src/network/devices/linux/Sysfs.ts` (nouveau),
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/sysfs-tree.test.ts` (nouveau).

---

## 2026-06-20 (suite) — Résolution de chemins : `realpath(3)` réel + classe métier `VfsPath`

**Couches concernées :** OS (VFS, résolution de chemins, DAC), commandes
(`realpath`, `readlink`, `cat`).

**Constat (réponse à la question « existe-t-il un resolver qui garantit
l'existence ? »).**
- `resolveInode()` est le vrai resolver vérifiant l'existence (marche l'arbre
  inode par inode, suit les symlinks, renvoie `null` si un composant manque) ;
  `exists()`/`lstat()`/`getType()` en dérivent.
- `normalizePath()` n'est qu'un **normaliseur lexical** : il ne vérifie aucune
  existence et réduit `..` au niveau texte *avant* toute résolution de symlink
  (contraire à la sémantique noyau). C'est pourtant lui que la plupart des
  commandes utilisaient.
- Il manquait un resolver canonique style `realpath(3)` (existence + symlinks
  intermédiaires). `realpath` était déclarée mais sans handler (cassée),
  `readlink` n'était qu'un stub qui réécho son argument.

**Corrections.**
1. `VirtualFileSystem.realpath(path, cwd, requireFinal)` : canonicalisation
   réelle — résolution composant par composant, expansion des symlinks
   intermédiaires, `..` appliqué sur le chemin *résolu*, détection de boucles
   de symlinks, et vérification d'existence. `requireFinal=false` reproduit
   `realpath -m` / `readlink -f`.
2. Câblage des commandes `realpath` (`-m`/`-e`/`-q`) et `readlink`
   (`-f`/`-e`/`-m` + lecture de cible simple) sur ce resolver.
3. Nouvelle **classe métier `VfsPath`** (passée en paramètre à la place d'un
   `string`), liée au VFS et à un acteur (`uid`/`gid`/groupes), qui regroupe
   tous les contrôles : `exists`/`isFile`/`isDirectory`/`isSymlink`,
   `canRead`/`canWrite`/`canExecute`, `realpath`, `parent`/`join`, et des
   assertions `assertExists`/`assertReadable`/`assertWritable`/… levant un
   `PathError` typé (`ENOENT`/`EACCES`/`ENOTDIR`). Factory `vfs.path(input,
   cwd, actor)` et helper `this.path()` côté exécuteur (lie l'acteur courant).
4. **Centralisation du DAC** : `VirtualFileSystem.checkAccess(inode, mode, uid,
   gid, gids)` devient la seule implémentation des droits POSIX ; `canWriteFile`,
   `canWriteInParent` et `LinuxCommandExecutor.checkPermission` y délèguent
   (suppression de trois copies de la même logique). `VfsPath` l'utilise aussi.
5. Adoption démonstrative : `cat`, `realpath`, `readlink` utilisent désormais
   `VfsPath`.

**Tests.**
- `vfs-realpath.test.ts` (9 cas) : `.`/`..`, relatifs, composant manquant,
  symlink simple/relatif, `..` après symlink, boucles.
- `vfs-path.test.ts` (9 cas) : existence/type, DAC read/write par acteur,
  assertions + `PathError`, realpath portant l'acteur, `join`/`parent`.
- Non-régression : aucune nouvelle défaillance (audit hors-périmètre
  inchangé), `journalization` 200/200, commandes/SFTP/matériel verts,
  moteur bash 383/383.

**Fichiers touchés :**
`src/network/devices/linux/VfsPath.ts` (nouveau),
`src/network/devices/linux/VirtualFileSystem.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/vfs-realpath.test.ts` (nouveau),
`src/__tests__/unit/network-v2/vfs-path.test.ts` (nouveau).

---

## 2026-06-20 (suite) — `rm` : failsafe `--preserve-root` + contrôle d'accès DAC à la suppression

**Couches concernées :** OS (commande `rm`, DAC), VFS.

**Constat (mis au jour par le nouveau resolver `realpath`).** Dans le lab de
debug filesystem, `cat /etc/passwd` échouait à partir de l'étape 173 : le
fichier avait disparu. Deux défaillances réelles en cause :
1. **`rm -rf /`** (étape 151) effaçait silencieusement tout le VFS — aucun
   garde-fou `--preserve-root` (pourtant activé par défaut sur GNU `rm`).
2. **`rm /etc/passwd`** (étape 152) réussissait alors que l'utilisateur
   courant est `user` (uid 1000) non privilégié : `rm` n'appliquait **aucun
   contrôle d'accès**. Or, supprimer une entrée exige les droits `w`+`x` sur le
   **répertoire parent** (ici `/etc`, possédé par root en 0755).

Le bug n°2 était invisible avant car `realpath`/`readlink` étaient cassés ;
le resolver corrigé l'a fait remonter.

**Corrections.**
- `--preserve-root` par défaut : `rm -rf /` est refusé
  (`rm: it is dangerous to operate recursively on '/'`), `--no-preserve-root`
  lève le garde-fou. Parsing des options revu (flags courts caractère par
  caractère — `--force` n'active plus `r` par erreur — et longs explicites).
- **DAC à la suppression** via la classe `VfsPath` : pour un acteur non-root,
  `rm` vérifie `w`+`x` sur le parent (`parent.canWrite() && canExecute()`,
  sinon `Permission denied`) puis applique la règle du **sticky bit** (`/tmp`
  en 1777 : on ne peut supprimer que ses propres fichiers, sinon `Operation
  not permitted`). `rm` renvoie désormais un code de sortie non nul en cas
  d'échec. Ordre des contrôles aligné sur GNU (« Is a directory » avant le
  contrôle de droits).

**Tests.**
- `rm-preserve-root.test.ts` (9 cas) : refus de `rm -rf /` + FS intact,
  `--no-preserve-root` (root), suppression récursive normale, non-misparse de
  `--force`, refus pour `user` sur `/etc/passwd` (y compris `-f`), autorisation
  pour root et pour le propriétaire dans son home, sticky bit `/tmp`.
- Non-régression : suite `network-v2` complète sans nouvelle défaillance (les
  44 échecs `other-commands` Cisco et les 16 échecs audit hors-périmètre sont
  pré-existants, vérifiés identiques avec le changement remisé) ; bash 383/383,
  commandes/SFTP/journal verts.

**Fichiers touchés :**
`src/network/devices/linux/LinuxFileCommands.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/rm-preserve-root.test.ts` (nouveau).

---

## 2026-06-20 (suite) — Cohérence des droits d'accès : DAC généralisé aux commandes mutantes

**Couches concernées :** OS (commandes fichiers/permissions, DAC), VFS,
classe `VfsPath`.

**Constat.** Après `rm`, le reste des commandes mutantes n'appliquait **aucun
contrôle d'accès** : un utilisateur non privilégié pouvait `chmod`/`chown` des
fichiers root, créer/supprimer des entrées dans des répertoires système, etc.
Incohérent avec un vrai Linux.

**Corrections (via la classe `VfsPath` et un acteur `uid/gid/groupes`).**
- Helper partagé `actorOf(ctx)` + nouvelles méthodes `VfsPath.ownedByActor()`
  et `VfsPath.isWritableDir()` (répertoire existant + `w` + `x`).
- **`chmod`** : seul le propriétaire (ou root) peut changer les permissions
  (`Operation not permitted` sinon).
- **`chown`** : seul root peut changer le propriétaire ; le changement de
  groupe seul suit la règle de `chgrp`.
- **`chgrp`** (et la partie groupe de `chown`) : il faut posséder le fichier
  **et** appartenir au groupe cible.
- **`mkdir`/`rmdir`/`cp`/`mv`/`ln`** : création/suppression d'une entrée exige
  `w`+`x` sur le répertoire parent ; `cp` exige aussi `r` sur la source ; `mv`
  vérifie le parent source **et** le parent destination, plus la règle du
  sticky bit ; `mkdir -p` vérifie le premier ancêtre existant.
- Toutes ces commandes renvoient désormais un code de sortie non nul et le
  message réaliste (`Permission denied` / `Operation not permitted`) en cas de
  refus ; root conserve son contournement.

**Tests.**
- `perm-ownership-dac.test.ts` (5 cas) : chmod/chown/chgrp refusés pour `user`,
  autorisés pour le propriétaire / root.
- `dir-mutation-dac.test.ts` (9 cas) : mkdir/cp/mv/rmdir/ln refusés dans `/etc`
  pour `user`, autorisés dans le home et pour root, refus de déplacer un
  fichier root hors de `/etc`.
- Non-régression : suites commandes/bash/journal/SFTP vertes, suite
  `network-v2` complète sans nouvelle défaillance (échecs Cisco `other-commands`
  et audit hors-périmètre pré-existants).

**Fichiers touchés :**
`src/network/devices/linux/VfsPath.ts`,
`src/network/devices/linux/LinuxFileCommands.ts`,
`src/network/devices/linux/LinuxPermCommands.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/perm-ownership-dac.test.ts` (nouveau),
`src/__tests__/unit/network-v2/dir-mutation-dac.test.ts` (nouveau).

---

## 2026-06-20 (suite) — ACL POSIX honorées par le DAC shell (`setfacl`/`getfacl`)

**Couches concernées :** OS (DAC shell via `VfsPath`), VFS (ACL), commandes.

**Constat.** Le DAC shell (`VfsPath.checkAccess`) ne consultait que les bits
owner/group/other. Les ACL POSIX posées par `setfacl` n'avaient d'effet que
côté SFTP (`PermissionCheckingFSDecorator`/`checkAclAccess`), pas pour `cat`,
`mkdir`, `rm`, etc. Incohérence entre les deux chemins d'accès.

**Corrections (réutilisation de l'existant, pas de duplication).**
- `VfsPath.allows()` consulte désormais l'ACL via la méthode **déjà
  existante** `VirtualFileSystem.checkAclAccess(path, user, groups, need)` —
  la même que SFTP — avant de retomber sur les bits de mode (ordre POSIX :
  root → ACL → bits). L'acteur (`PathActor`) porte maintenant `user` et
  `groupNames`, peuplés par `actorOf()` et `currentPathActor()`.
- `cmdCat` utilise `VfsPath.canRead()` (ACL-aware) au lieu de son ancien
  contrôle bits-only `canReadInode`.
- `setfacl -x` corrigé : la regex d'entrée ACL acceptait seulement
  `u:name:perms` ; elle accepte désormais `u:name` (suppression). Ajout de
  `VirtualFileSystem.removeGroupAcl()` et du retrait de groupe dans `setfacl`.

**Effets.** Un `setfacl -m u:user:r` rend un fichier 600 lisible par `cat`
pour cet utilisateur ; un `setfacl -m g:team:r` accorde l'accès par
appartenance de groupe supplémentaire ; un `setfacl -m u:user:rwx` sur un
répertoire autorise `mkdir` à l'intérieur ; `setfacl -x` rétablit le refus.

**Tests.** `acl-dac.test.ts` (4 cas) : lecture accordée par ACL user, par ACL
de groupe, retrait d'ACL, écriture de répertoire via ACL. Non-régression :
suites DAC/SFTP/SSH/commandes/bash vertes (965 combinés).

**Fichiers touchés :**
`src/network/devices/linux/VfsPath.ts`,
`src/network/devices/linux/VirtualFileSystem.ts`,
`src/network/devices/linux/LinuxFileCommands.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/acl-dac.test.ts` (nouveau).

---

## 2026-06-20 (suite) — Audit : daemon auditd réel, modèle de credentials, sémantique des watches

**Couches concernées :** OS (auditd, processus, services, credentials), VFS
(inode, setuid), bus réactif, commandes.

**Modèle métier `LinuxAuditDaemon` (acteur réactif).** auditd devient un vrai
démon piloté par le cycle de vie du service : il s'abonne au bus
(`linux.service.started/stopped`, `linux.process.signalled`), possède l'état
`running/stopped/suspended` et le modèle de config parsé depuis
`auditd.conf`. Il émet `DAEMON_START`/`DAEMON_END`/`DAEMON_CONFIG`, recharge
les règles de `rules.d` au démarrage et sur `SIGHUP` (en ignorant les lignes
corrompues), et **suspend la journalisation** quand l'espace disque passe sous
`space_left`/`admin_space_left` (action `SUSPEND`), en cohérence avec le modèle
de stockage matériel/mount. La validation de `auditd.conf` passe par un
`configCheck` du gestionnaire de services (consulté au start/restart/reload).
`service status` rend la sortie systemd `active (running)`. `kill` non-jobspec
est délégué à l'interpréteur (substitution `$(pgid auditd)`), ajout d'une
commande `pgid`.

**Modèle de credentials.** `euid` passe à 0 à l'`execve` d'un binaire
setuid-root, lu depuis le **vrai bit setuid du VFS** (passwd/su/sudo/ping/mount
semés en 04755 root). `sudo` publie son propre `execve` et `sudo -S` retombe
sur le mode NOPASSWD sans mot de passe pipé. L'`execve` d'un binaire non
exécutable est audité `exit=-13`, et `rm` d'un fichier absent journalise
`unlink success=no`.

**`su` authentifié.** Un appelant non-root doit fournir le mot de passe du
compte cible (sur stdin) ; sinon `su` échoue et auditd journalise un
`USER_AUTH res=failed`. Root commute librement. Le flux interactif `su`
transmet le mot de passe validé à `su(1)` (un seul contrôle pour les deux
chemins).

**Sémantique des watches.** Les watches mémorisent l'inode cible : un watch de
fichier suit les liens durs et survit au renommage du répertoire parent. Les
écritures par redirection bash (`echo >>`) sont auditées (descendants et
même-inode) sans double-déclenchement.

**Résultat.** Suites audit `auditctl` (100), `auditctl-other` (150),
`other-audit` (150), `journalization` (200) = **600/600**. Tests reposant sur
un `su` sans mot de passe adaptés au modèle réaliste (escalade via
`sudo su -`, `su` non-root authentifié par mot de passe pipé, fixtures `/tmp`
possédées par l'utilisateur consommateur). Aucune régression nette sur la
suite complète (15659 passants ; restent des échecs pré-existants Cisco
`other-commands` et un test Windows `netsh`).

**Fichiers touchés (principaux) :**
`src/network/devices/linux/audit/LinuxAuditDaemon.ts` (nouveau),
`src/network/devices/linux/audit/LinuxAuditRules.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/network/devices/linux/LinuxServiceManager.ts`,
`src/network/devices/linux/LinuxProcessCommands.ts`,
`src/terminal/flows/LinuxFlowBuilder.ts`.

---

## 2026-06-20 (suite) — Processus / jobs : exécution en arrière-plan sur une horloge simulée (TDD)

**Constat.** La couche service/processus/job n'avait aucune notion de temps :
un `sleep 60 &` se terminait instantanément, `wait` était un no-op, et aucun
processus ne « tournait » réellement en arrière-plan. Le premier pas vers une
couche OS réaliste est donc une **horloge** déterministe et des jobs dont la
complétion est différée dans le temps simulé.

**Méthode TDD.** Tests d'abord (rouge confirmé : `HostClock` introuvable,
`advanceTime`/`simulatedNow` absents), puis implémentation.

**`HostClock` — horloge monotone simulée.** Classe métier
(`host/lifecycle/HostClock.ts`) : le temps n'avance que lorsqu'on l'avance
(`advance`/`advanceTo`), jamais tout seul ni en arrière. Elle pilote toute
behaviour temporelle (complétion de jobs, accrual CPU, timers) de façon
déterministe, sans dépendre de l'horloge murale.

**Jobs d'arrière-plan réalistes.** Un job backgroundé (`&`) reçoit une durée
(`durationMs`) déduite de la commande (`sleep N` même imbriqué, p. ex.
`ssh … sleep 60 &`) et un instant de fin (`completesAt`). Tant que l'horloge
n'a pas atteint cet instant, le job reste `Running` (visible dans `jobs`/`ps`).
`advanceTime(ms)` fait avancer l'horloge et complète les jobs échus : le
processus devient zombie (`Z`), accumule son temps CPU, puis est moissonné.

**`[N]+ Done` au prochain prompt.** Bash imprime la notice de fin juste avant
le prompt suivant ; `drainFinishedJobNotices` ne draine **que** les jobs
complétés par l'horloge (`completesAt <= now`), laissant les jobs tués par un
événement externe (déconnexion SSH du distant éteint) à `fg`/`jobs` — un
garde-fou qui évite de voler la sémantique « Connection closed by … ».

**`wait` réel.** `wait` / `wait %n` / `wait <pid>` avance l'horloge jusqu'à la
complétion des jobs ciblés (tous les jobs en cours par défaut), les règle et
consomme leur statut sans notice, mettant à jour `$?`.

**Garde de profondeur.** Le drainage des notices ne se fait qu'au niveau du
prompt (top-level `execute`), pas dans les `execute` récursifs — ce qui rend le
changement non cassant : les suites existantes qui n'avancent pas le temps
voient leurs jobs rester `Running` comme avant.

**Résultat.** Nouveaux tests `host-clock` (6) + `linux-background-jobs` (7) =
13/13. Suites processus/jobs/service de non-régression : 141/141. Suite SSH LAN
réparée (les 3 cas de job-control d'arrière-plan ssh : durée déduite d'un
`sleep` imbriqué + garde de drainage). Aucune régression nette sur la suite
complète (restent les échecs pré-existants Cisco `other-commands` et un test
Windows `netsh`).

**Fichiers touchés :**
`src/network/devices/host/lifecycle/HostClock.ts` (nouveau),
`src/network/devices/linux/jobs/LinuxJob.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/host-clock.test.ts` (nouveau),
`src/__tests__/unit/network-v2/linux-background-jobs.test.ts` (nouveau).

---

## 2026-06-20 (suite) — `atd` : les jobs différés `at` se déclenchent sur l'horloge simulée (TDD)

**Constat.** Le spool `at` existait (`LinuxAtQueue`, `cmdAt`/`atq`/`atrm`) mais,
comme le notait son propre commentaire, « the simulator does not fire jobs on a
timer » : un `at now + 1 minute` restait éternellement en file, jamais exécuté.
Aucune activité daemon réelle dans le temps — exactement le contraire d'« un
vrai OS avec des choses qui tournent en arrière-plan ».

**Méthode TDD.** Tests d'abord (rouge confirmé : les jobs ne se déclenchaient
pas, le fichier cible n'apparaissait jamais), puis implémentation.

**Base de temps unifiée.** `at` parse désormais sa spécification (`now + N`,
`HH:MM`) relativement à l'**heure simulée** (`simulatedDate()` =
`wallEpoch + clock.now()`), et non plus `Date.now()`. Le `wallEpoch` (instant
mural correspondant au temps simulé 0) ne sert qu'à afficher une date crédible
dans `atq` ; il s'annule dans toute comparaison, gardant le déclenchement
déterministe.

**Déclenchement réel par `atd`.** `advanceTime(ms)` fait avancer l'horloge
puis, après la moisson des jobs d'arrière-plan, exécute via `fireDueAtJobs`
chaque job `at` dont l'instant programmé est atteint (`runAt <= now`), dans
l'ordre chronologique (la file est triée, on s'arrête au premier non-échu),
avant de le retirer du spool. No-op tant que `atd` est arrêté — fidèle à un
hôte réel où le daemon down ne traite rien.

**Résultat.** Nouveau test `linux-at-scheduling` (5) : un job ne s'exécute qu'une
fois l'horloge arrivée à son heure, le spool est vidé après exécution, les jobs
se déclenchent dans l'ordre, `atrm` annule avant l'heure, et un `atd` arrêté ne
déclenche rien. Non-régression processus/jobs/service/SSH LAN : 317/317.

**Fichiers touchés :**
`src/network/devices/linux/jobs/LinuxAtQueue.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`,
`src/__tests__/unit/network-v2/linux-at-scheduling.test.ts` (nouveau).

---

## 2026-06-20 (suite) — Windows : mise à niveau de la couche tâches planifiées sur l'horloge simulée (TDD)

**Constat.** Le côté Windows était en retard sur le côté Linux : aucune
`HostClock`, pas d'`advanceTime`, et le Planificateur de tâches (`schtasks`,
`Register-ScheduledTask`) ne faisait que **stocker** des définitions — jamais
exécutées dans le temps. C'est l'équivalent Windows du trou `at`/`atd` qu'on
venait de combler côté Linux.

**Méthode TDD.** Tests d'abord (rouge confirmé : `advanceTime is not a
function`), puis implémentation.

**Parité de l'horloge.** `WindowsPC` reçoit la même `HostClock` déterministe
que `LinuxCommandExecutor`, avec un `wallEpoch` fixe (minuit local d'une date
figée) pour que l'arithmétique heure-du-jour de `/ST HH:MM` soit reproductible
indépendamment du fuseau et de la date réelle. `simulatedDate()` =
`wallEpoch + clock.now()` ; `simulatedNow()` exposé pour l'automatisation.

**Déclenchement réel par le Planificateur.** `schtasks /create /SC ONCE /ST`
arme désormais un `runAt` (et mémorise `/TR`). `advanceTime(ms)` fait avancer
l'horloge puis exécute via `fireDueScheduledTasks` chaque tâche dont l'instant
est atteint : le programme `/TR` est lancé (visible dans `tasklist` /
`Get-Process`), `Last Run Time`/`Last Result` sont mis à jour, et le
déclencheur unique est désarmé (pas de double exécution). `schtasks /run`
exécute immédiatement via le même helper partagé `fireScheduledTask`. No-op
tant que le service `Schedule` est arrêté — fidèle à un hôte réel.

**Résultat.** Nouveau test `windows-scheduled-tasks` (4) : une tâche unique ne
s'exécute qu'une fois l'horloge arrivée à `/ST`, jamais deux fois, `schtasks
/run` la lance sur-le-champ, et un service `Schedule` arrêté ne déclenche rien.
Non-régression Windows/PowerShell (cmd, cmdlets, services, processus) :
374 + 252 + … verts.

**Fichiers touchés :**
`src/network/devices/windows/WinSystemCommands.ts`,
`src/network/devices/WindowsPC.ts`,
`src/__tests__/unit/network-v2/windows-scheduled-tasks.test.ts` (nouveau).
