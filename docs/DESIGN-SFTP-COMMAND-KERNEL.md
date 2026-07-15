# DESIGN — Migration SFTP vers command-kernel

**Date** : 2026-07-14
**Statut** : VALIDÉ (orientations utilisateur) — implémentation en cours, un push par étape.
**Framework parent** : `migration_framework.md` (§2.2, §5.5, §14).

## 1. État des lieux (lu en entier, §3.1)

Chaîne actuelle d'un `sftp alice@10.0.0.3` :

```
LinuxTerminalSession.executeCommand
  └─ interception en dur `parts[0] === 'sftp'` → enterSftp(args)   [parsing minimal -b]
       └─ startFlowFromSteps([password, execute])                   [flux legacy]
            └─ connectAndEnterSftp(userAtHost, password, batchFile)
                 ├─ new SftpSession(deps)          [vfs local, tcpConnect du device,
                 │                                  SilentSshInteractionHandler(password)]
                 ├─ session.connect() → SshSession → canal SFTP RÉEL (trames TCP)
                 └─ ShellFactory.create('sftp', {sftpSession}) → sous-shell poussé
```

Dans la session interactive :

```
SftpSubShell.processLine(line)
  └─ switch(cmd) géant (25 cas)  → SftpSession.<méthode>()
       └─ channel.sendRequest({op: 'ls'|'get'|'put'|…})   [canal réel]
```

Trois couches distinctes :
- **Plan réel (à NE PAS toucher, §2.2)** : `SshSession`, `ISshSftpChannel`,
  serveurs (`SftpWireSession`, `ISftpFileSystem`, chroot, adapters Linux/Windows/Router).
- **Logique métier cliente (à MIGRER dans les commandes)** : `SftpSession`
  (~500 lignes : formats `ls -l`, messages d'erreur OpenSSH exacts, récursion
  get/put -R, expansion `~`, cwd local/distant) + le switch de `SftpSubShell`.
- **Hôtes (deviennent minces)** : `SftpSubShell` (REPL), `enterSftp` (lanceur).

## 2. Architecture cible

### 2.1 Registre kernel dédié à la session SFTP

`sftp` est un shell à part entière (prompt `sftp>`, grammaire simple) — il
reçoit son propre bootstrap, sur le modèle exact de `create<Vendeur>HostShell`
(§4 du framework) :

```
src/network/protocols/ssh/sftp/command-kernel/
  createSftpShell.ts      → Interpreter (CommandRegistry sftp + SftpMachineApi)
  SftpMachineApi.ts       → implements MachineApi
  commands/               → SftpLs, SftpCd, SftpGet, SftpPut, SftpMkdir, …
```

- `machine.fs` = le VFS **local** (lls/lcd/lpwd/lmkdir, côté local de get/put)
  via le `LinuxFileSystemApi` existant — jamais une seconde implémentation.
- Nouvelle capacité optionnelle vendor-agnostic dans `machine/types.ts` :

```ts
export interface SftpChannelApi {
  remoteCwd(): string;
  cd(path: string): SftpOpResult;         // met à jour remoteCwd via le canal
  ls(path: string): SftpOpResult<readonly SftpEntryInfo[]>;
  get(path: string): SftpOpResult<string>;
  put(path: string, content: string): SftpOpResult;
  mkdir/rm/rmdir/rename/chmod/chown/stat/df/version…
}
export interface MachineApi { …; readonly sftp?: SftpChannelApi; }
```

  Implémentation : enveloppe fine de `ISshSftpChannel.sendRequest` — chaque
  méthode = un op réel du canal, AUCUNE logique de formatage (celle-ci vit
  dans les commandes). `remoteCwd` est un état de connexion, il vit dans la
  façade, pas dans les commandes.

### 2.2 Les commandes internes

Chaque commande sftp devient une vraie commande kernel : descripteur
(usage exact du help OpenSSH actuel), `PrivilegePolicy.ANY` (les droits
réels sont appliqués côté serveur par `PermissionCheckingFSDecorator`),
`execute()` autonome portant parsing + formats + messages d'erreur
byte-identiques à `SftpSession` (parité §7 vérifiée contre
`sftp-shell-suite.test.ts`, `linux-lan-sftp-suite.test.ts`,
`scenario-08-sftp-chroot.test.ts`). La récursion `-R` de get/put marche
sur les ops plates du canal (ls + get/put), comme aujourd'hui.

`SftpSubShell.processLine` devient : `interpreter.interpretLine(line,
session, io)` + collecteur — le switch disparaît. `exit/quit/bye` restent
des commandes kernel qui lèvent `ExitRequest` (socle), traduit par le
sous-shell en `{exit: true}`.

### 2.3 Le lanceur `sftp`

`SftpLauncherCommand` (registre Linux, `streaming: true`) :
- parsing complet dans la commande (`-b`, `-P`, `[user@]host`) ;
- mot de passe via `ctx.io.interaction` (le pas `enterSftp`/flux legacy
  disparaît, comme adduser) ;
- connexion via une capacité `machine.sftpConnect?` câblée par le pont sur
  la construction réelle de `SftpSession` (tcpConnect du device, vfs local) ;
- remise du sous-shell : nouveau rappel optionnel
  `CommandKernelChannel.openSubShell?(kind: string, payload: unknown)`,
  câblé par la session sur le mécanisme `ShellFactory`/`ISubShell` existant
  (exactement le point d'intégration prévu au §5.5 du framework). Sans
  hôte interactif (script), `sftp` reste utilisable en mode batch `-b`.

### 2.4 Suppression du legacy (au fil des pushes)

1. Push A — façade `SftpChannelApi` + bootstrap + commandes de navigation
   (pwd/lpwd/cd/lcd/ls/lls/help/version) ; `SftpSubShell` route ces
   commandes via l'interpreter, le switch rétrécit.
2. Push B — transferts et mutations (get/put [-R], mkdir/rm/rmdir/rename/
   chmod/chown/stat/df/lmkdir) ; le switch disparaît ; les méthodes
   correspondantes de `SftpSession` sont supprimées (seuls restent
   connect/disconnect/état de connexion).
3. Push C — lanceur kernel + `openSubShell` sur le canal ; suppression de
   `enterSftp`/`connectAndEnterSftp`/l'interception en dur dans la session.

Après C, `SftpSession` ne porte plus que la connexion (SSH + canal) — la
logique de commande vit intégralement dans command-kernel.

## 3. Hors périmètre

- Le protocole SFTP lui-même (wire, serveurs, chroot, décorateurs de
  permission) — mature, testé, réutilisé tel quel.
- `ftp`/`scp`/`ssh` interactifs — chantiers ultérieurs sur le même modèle.
- Les 13 tests legacy préexistants (SSH exec-mode Windows, auth.log…) —
  traités après cette migration, décision utilisateur.
