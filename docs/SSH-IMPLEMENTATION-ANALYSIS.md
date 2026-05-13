# Analyse de l'implémentation SSH — points faibles, manques, irréalismes

**Date** : 2026-05-08
**Branche** : `claude/implement-ssh-classes-4jotz`
**Périmètre** : module `src/network/protocols/ssh/` + intégration `LinuxTerminalSession` / `LinuxMachine` / `WindowsPC` + suites `ssh-lan-*.test.ts`.

Le but de ce document est d'inventorier les défauts connus, les gaps fonctionnels et les choix de simulation qui s'éloignent du comportement réel d'OpenSSH. Il n'inclut pas les exigences déjà cochées `[DONE]` dans le BRD.

---

## 1. Défauts identifiés et corrections appliquées

### 1.1 [FIX] Ordre `exit` su / SSH (revue de code)

**Symptôme** : depuis `root@remote` (après `su`/`sudo su` sur la machine distante), un `exit` poppait directement le frame SSH au lieu de revenir à `user@remote`. Le `suStack` du `LinuxCommandExecutor` distant n'avait jamais l'opportunité d'être unwound.

**Cause** : `LinuxTerminalSession.executeCommand` testait `sshStack.length > 0` AVANT `device.handleExit()`, donc le retour SSH avait priorité sur le retour `su`.

**Correctif** (commit `<<TBD>>`) :
```ts
const exitResult = this.device.handleExit();
if (exitResult.inSu) {
  // 1. Pop one su level on the remote.
  if (exitResult.output) this.addLine(exitResult.output);
  this.syncDeviceState();
  return;
}
if (this.sshStack.length > 0) {
  // 2. Once root su level reached, pop the SSH frame.
  this.popRemoteDevice();
  return;
}
this._onRequestClose?.(); // 3. Otherwise close the terminal.
```

**Test** : `RS13 — exit from root@remote returns to user@remote, not to local` (`ssh-lan-remote-shell.test.ts`).

### 1.2 [FIX UX] Indicateur SSH manquant pour l'UI

**Symptôme reporté** : « le terminal devient complètement celui de l'autre machine », sans indication visuelle qu'on est en SSH.

**État** : `pushRemoteDevice` swap correctement le device, et le prompt change (`user@host:~$`). Mais il manquait une API observable pour que les composants React puissent peindre une bannière du type « SSH connected to `<host>` ».

**Correctif** :
1. Nouveau getter `LinuxTerminalSession.getSshContextInfo()` :
   ```ts
   { active: boolean, chain: { host, user }[], current: string | null }
   ```
2. **`TerminalView.tsx`** consomme désormais ce getter et rend un bandeau bleu sky entre la barre d'info et le scrollback : « 🔒 SSH session — user@host › alice@host2 (type `exit` or `logout` to disconnect) ». Visible uniquement quand `active === true`.

**Tests** : `RS14` (state) + `F1` (chaîne imbriquée).

### 1.3 [FIX] Auth clé publique Windows désormais opérationnelle

**Symptôme** : `WindowsSshServerContext.checkPublicKey` retournait `false` en dur. Conséquence : `ssh-copy-id` vers une cible Windows ne servait à rien, l'utilisateur devait toujours taper le mot de passe.

**Correctif** : `checkPublicKey` lit `C:\Users\<user>\.ssh\authorized_keys` via `WindowsFileSystem.readFile`, parse chaque ligne `<algorithm> <material> [comment]`, et compare la `material`. `getAvailableMethods()` inclut désormais `'publickey'` quand `pubkeyAuthentication` est `true`.

**Tests** : `F2` (clé matchée), `F3` (authorized_keys absent), `F4` (`PubkeyAuthentication=no` domine même avec clé matchée).

### 1.4 [FIX] /var/log/auth.log reflète l'activité SSH

**Symptôme** : `last`, `tail /var/log/auth.log`, `journalctl -u ssh` ne montraient pas les connexions SSH simulées (cf. §3.7 historique).

**Correctif** : `LinuxSshServerContext.recordLogin` (déjà appelée à chaque auth réussie par `SshServerHandler`) écrit désormais une ligne syslog-style :
```
<Mon DD HH:MM:SS> <hostname> sshd[1]: Accepted password for <user> from <ip> port 0 ssh2
```
Nouvelle méthode `recordAuthFailure` écrit `Failed password for <user>...` symétriquement. Le fichier est créé/append avec mode `0640` comme sur OpenSSH.

**Tests** : `F5` (Accepted line présente), `F6` (`tail` distant via SSH retrouve la ligne), `F7` (cumul sur 3 connexions consécutives).

### 1.5 [FIX] `wtmp` / `btmp` désormais peuplés

**Symptôme** : `last` retournait une seule ligne synthétique (« still logged in ») et `lastb` n'existait pas.

**Correctif** :
1. `LinuxSshServerContext.recordLogin` append désormais un entry JSON à `/var/log/wtmp.json` (`{user, ip, at, type:'login', tty:'pts/0'}`).
2. `recordAuthFailure` écrit symétriquement dans `/var/log/btmp.json` (mode `0o600` comme sur OpenSSH).
3. `LinuxUserManager.last(args)` / nouvelle `lastb(args)` lisent ces fichiers, supportent le filtre par utilisateur et le `-N` numérique de OpenSSH, et formatent chaque ligne `user pts/0 ip date time still logged in` / `… - time (00:00)`. `last` conserve une ligne `still logged in` synthétique (parité avec le comportement précédent) + une `reboot system boot`.
4. `cmdLast` / nouvelle `cmdLastb` câblées dans `LinuxCommandExecutor` et les allowlists VFS/binaries.
5. **Post-merge avec `main`** : `/var/log/auth.log` est désormais produit par `SshSyslogger` (réactif, abonné au bus d'événements), donc `recordLogin` / `recordAuthFailure` ne se chargent plus que de `lastlog.json` + `wtmp.json` / `btmp.json` afin d'éviter les doublons de lignes syslog.

**Tests** : `G1` (wtmp.json apparait après login), `G2` (`last user` liste les entrées via SSH), `G3` (btmp.json + `lastb` après échec d'auth).

### 1.6 [FEAT] `HashKnownHosts` supporté

**Symptôme** : `~/.ssh/known_hosts` ne stockait que des lignes en clair. La directive OpenSSH `HashKnownHosts yes` était ignorée.

**Correctif** :
1. Nouveaux helpers purs `hashKnownHostsToken(host[, salt])`, `isHashedKnownHostsToken`, `matchHashedHost` dans `SshPureUtils` produisant le format OpenSSH `|1|<salt>|<hash>`. Pas de crypto réelle (BRD C-02) : fonction de hash déterministe non-cryptographique, le format reste visuellement fidèle.
2. `KnownHostsStore.with(host, key, {hashed})` choisit le token à persister ; `get`/`has`/`without` parcourent les tokens hashés et matchent via `matchHashedHost`.
3. `SshKnownHosts.addHost(host, key, {hashed})` propage l'option ; `SshConnectOptions` expose `hashKnownHosts` ; `SshSession` lit l'option à `accept_and_save` / réponse `yes`.
4. `SshConfig` parse `HashKnownHosts yes|no` ; `LinuxTerminalSession.mergeWithSshConfig` honore l'entrée et la directive CLI `-o HashKnownHosts=yes`.

**Tests** : `G4` (token roundtrip), `G5` (store roundtrip), `G6` (config parse).

### 1.7 [FEAT] `sftp -b <batchfile>` non-interactif

**Symptôme** : aucun mode non-interactif pour scripter des transferts SFTP. Les tutoriels CI-style devaient passer par `scp` ou un sub-shell scripté à la main.

**Correctif** :
1. `LinuxTerminalSession.enterSftp` parse `-b <file>` et propage `batchFile` à `connectAndEnterSftp`.
2. Nouvelle méthode privée `runSftpBatch(session, vfs, path)` : lit le fichier, ignore commentaires (`#`) et lignes vides, écho chaque commande précédée du prompt, exécute via une `SftpSubShell` jetable, et stoppe à la première erreur sauf si la ligne commence par `-` (parité OpenSSH). Disconnect en sortie.
3. Helper `hasSftpError` détecte les messages OpenSSH classiques (« Couldn't … », « No such file », « Failure », « Permission denied »).

**Tests** : `G7` (parser), `G8` (script multi-lignes), `G9` (comment ignoré + stop sur erreur).

### 1.8 [TOOLING] Couverture vitest configurée

`vite.config.ts` ajoute la configuration `coverage` (provider v8, rapport HTML/text/lcov, seuils 85/85/85/75 lignes/fonctions/statements/branches) ciblée sur `src/network/protocols/ssh/**`. `package.json` expose `npm run test:coverage`. `@vitest/coverage-v8` installé en devDep.

### 1.9 [FIX UX] L'InfoBar du terminal reste sur la machine locale en SSH

**Symptôme reporté** : « quand on entre en ssh, le header de terminal devient celui de la machine hote ». L'utilisateur perd le repère visuel qu'il est sur **son** terminal local.

**Correctif** :
1. Nouveau getter `LinuxTerminalSession.getLocalDevice()` qui retourne le device au fond de la pile SSH (= la machine locale d'origine). Les deux nouveaux accesseurs privés `localUser` / `localPath` exposent les valeurs sauvegardées à la première poussée.
2. `getInfoBarContent()` lit désormais ces accesseurs au lieu de `this.device` / `this.currentUser` / `this.currentPath`. Le bandeau (au-dessus du scrollback) reste donc figé sur l'identité locale.
3. Le prompt bash inline rendu pour chaque commande continue d'utiliser `getPromptParts()` (qui reflète le device courant) — c'est le bon endroit pour signaler la machine cible. La bannière sky-blue (`SshContextBanner`) reste l'indication principale qu'on est en SSH.

**Tests** : `H1..H7` dans `ssh-lan-subshell-header.test.ts` (header local sous SSH, sous chaînes nested, après pop, `getLocalDevice` est stable, prompt reflète bien le remote).

### 1.10 [FEAT] ProxyJump (`ssh -J`)

**Symptôme** : `ssh -J jumpHost target` n'était pas reconnu — pourtant un classique des tutoriels (bastion → cible interne).

**Correctif** :
1. Nouveau module pur `src/terminal/sessions/sshArgs.ts` exposant `parseSshArgs`, `parseProxyJumpSpec`, `parseLocalForwardSpec` + types `ParsedSshArgs` / `ProxyHop` / `LocalForward`. Le parseur in-line de `LinuxTerminalSession` est supprimé au profit de ce module testable.
2. `parseSshArgs` reconnaît `-J host1[,host2,...]` et `-o ProxyJump=...`. `parseProxyJumpSpec` éclate la liste en `{ user, host }[]`.
3. Nouvelle méthode publique `LinuxTerminalSession.pushSshChain(hops)` : pour chaque hop, résout via `findLinuxMachineByIp` et `pushRemoteDevice`. Rollback automatique en cas d'échec de résolution. Chaque hop hérite du user du précédent quand l'utilisateur n'est pas spécifié.
4. `enterSsh` appelle `pushSshChain` avant d'ouvrir la connexion finale, ce qui empile une frame SSH par hop. `exit` / `logout` unwind donc un saut à la fois (parité OpenSSH).

**Tests** : `J1..J7` dans `ssh-lan-proxyjump.test.ts` — parser (hop unique, comma-list, `-o`, vide), `parseProxyJumpSpec` round-trip, push de chaîne, `exit` qui unwind hop-by-hop.

### 1.11 [FEAT] Port forwarding `-L`

**Symptôme** : pas de tunnel TCP via SSH (`ssh -L localPort:remoteHost:remotePort`).

**Correctif** :
1. `parseLocalForwardSpec` accepte les deux formes OpenSSH (`8080:host:80` et `bind:8080:host:80`), rejette les ports ≤ 0.
2. `parseSshArgs` collecte une liste de `LocalForward` à partir de `-L` répétés et `-o LocalForward=...`.
3. Nouveau `SshLocalForwarder` (`src/network/protocols/ssh/SshLocalForwarder.ts`) : pose un listener TCP sur le `localPort` du device local, et bridge chaque connexion entrante via un canal `exec` SSH lançant `nc remoteHost remotePort` côté serveur. `dispose()` retire le listener.
4. `LinuxTerminalSession.installLocalForwards` instantie un forwarder par entrée `-L` après que `connectAndEnterSsh` ait authentifié la session. Chaque listener est disposé quand la session SSH se ferme.

**Tests** : `L1..L7` dans `ssh-lan-localforward.test.ts` (parser 3-part / 4-part / invalide, collecte multi-`-L`, `-o LocalForward=`, listener observable, `dispose` libère).

---

## 2. Faiblesses structurelles connues

### 2.1 Pas de cryptographie réelle

**Constat** : `SshHostKey.generate(hostname)` retourne une string opaque déterministe basée sur un hash interne (`SshFingerprint.fromPublicKey` → `simpleHash` non cryptographique). Idem pour `SshKeyPair.generate()`.

**Impact** :
- Le fingerprint est stable entre runs (utile pour les tests) mais ne reflète pas un vrai SHA-256 sur une clé publique ED25519.
- Les empreintes affichées ne correspondent pas à ce que `ssh-keygen -lf` produirait sur OpenSSH.
- Aucune vraie protection MITM si on devait porter le code en environnement réel.

**Acceptable** : conforme à `BRD-SSH-SFTP.md` C-02 « Pas de vraie cryptographie ». À documenter dans le README du module.

### 2.2 Authentification clé publique incomplète

- Le format de clé publique stocké dans `id_ed25519.pub` est un blob déterministe, pas un PEM/OpenSSH valide.
- La clé privée écrite par `ssh-keygen` est un placeholder `-----BEGIN OPENSSH PRIVATE KEY-----\n<material>\n-----END OPENSSH PRIVATE KEY-----` sans armor base64.
- Aucun vrai checksum / kdf — donc pas de vérification de passphrase.
- Côté serveur (`LinuxSshServerContext.checkPublicKey`), la comparaison se fait par égalité stricte de la `material` extraite. C'est suffisant pour le simulateur mais ne tolère pas les variantes de format (commentaires, options `from=...`).

**Conséquence** : la séquence `ssh-keygen` → `ssh-copy-id` → `ssh -i ~/.ssh/id_ed25519` fonctionne dans le simulateur mais l'écriture binaire ne ressemble pas à OpenSSH.

### 2.3 Canal exec : un canal par ligne dans `RemoteShellSubShell`

**Avant le push-device** : chaque ligne ouvre un nouveau `SshExecChannel`, ce qui implique un round-trip JSON `op:'open_channel'` + `op:'exec'` + `op:'close_channel'`.

**Conséquence** :
- Surcoût symbolique (acceptable car simulateur synchrone).
- Pas de TTY, donc programmes interactifs (top, htop, less) ne fonctionnent pas via ce canal.

**État actuel** : depuis l'introduction du push-device (`pushRemoteDevice`), ce chemin est utilisé en fallback uniquement quand l'IP ne résout pas vers un device du registre. Donc le surcoût est rare en pratique.

### 2.4 Pas de vraie négociation SSH binaire

- Le banner `SSH-2.0-…` est échangé en JSON (`op:'hello'` / `serverVersion`), pas en clear text comme RFC 4253.
- Aucune négociation kex (key exchange), MAC, ciphers — le simulateur ignore tout cela.
- Pas de support des extensions (`server-sig-algs`, `delay-compression`, etc.).

**Acceptable** : le simulateur vise le comportement visible côté CLI, pas la conformité protocolaire.

### 2.5 `op:'shell'` non implémenté

- `SshShellChannel` envoie / reçoit du texte brut sur la connexion, mais le serveur n'a pas de routing pour le texte non-JSON.
- `RemoteShellSubShell` route donc via `op:'exec'` à la place.
- Conséquence : pas de shell PTY persistant côté serveur. Chaque commande utilise pourtant le même `LinuxCommandExecutor`, ce qui maintient cwd / env (cf. tests RS5..RS8).

**À corriger si on veut TTY-style interaction** : implémenter une boucle `op:'shell_input'` côté serveur, avec écho et ligne par ligne.

### 2.6 SFTP : chunks non supportés

- `SftpGetCommand` / `SftpPutCommand` transportent le contenu complet du fichier en JSON sur un seul aller-retour.
- Pas de chunking ni de fenêtre de flow-control comme `SSH_FXP_READ` / `SSH_FXP_WRITE` réels (qui découpent en blocs de 32 KB).
- Pour des fichiers de taille « simulée », pas de souci ; pour des transferts volumineux ce serait inadéquat (mais le simulateur est in-memory).

### 2.7 Connexions TCP simulées sans vrai cycle de vie

- `SshSession.disconnect()` ferme la `TcpConnection` mais pas de `SSH_MSG_DISCONNECT` envoyé.
- Pas de gestion des EOF / SIGHUP / réseaux qui tombent — un câble débranché côté UI termine la session brutalement sans notification au client.

### 2.8 ~~Windows : pas d'auth par clé publique~~ → corrigé §1.3

### 2.9 ACLs Windows non honorées

`WindowsSftpFSAdapter.setPermissions` et `setOwner` sont des no-op (ACLs NTFS ≠ POSIX bits). C'est documenté mais cela signifie qu'un `chmod` SFTP sur une cible Windows réussit en apparence sans effet réel.

### 2.10 Reload sshd_config : nouveau contexte mais ancienne handler reste

- `LinuxMachine.getSshServerContext()` cache une instance du contexte et la remplace via `reloadConfig()` quand `systemctl restart ssh` est invoqué.
- Mais `listenTcp(22, …)` enregistre une closure qui appelle `this.getSshServerHandler().register(conn, '0.0.0.0')` à chaque connexion entrante.
- À la prochaine connexion, `getSshServerHandler()` lit le nouveau contexte. ✅
- En revanche, les sessions TCP **déjà ouvertes** au moment du restart ne sont pas notifiées et continuent avec l'ancienne config (acceptable et conforme à OpenSSH qui ne déconnecte pas les sessions en cours).

### 2.11 `MaxAuthTries` partiellement honoré

- `PasswordAuthMethod.attempt` boucle jusqu'à 3 fois maximum côté client, mais le serveur ne ferme pas la connexion à `MaxAuthTries`.
- Conséquence : en théorie un client pourrait re-tenter en boucle. En pratique, `AuthChain.tryAll` s'arrête au premier `Result.err` cumulé.

---

## 3. Comportements manquants

### 3.1 Forwarding (port forwarding / X11 / agent)

- Aucun support de `-L` (local port forwarding), `-R` (remote), `-D` (dynamic SOCKS), `-X` (X11), `-A` (agent forwarding).
- `SshSession` n'expose pas d'API `openTcpForward(localPort, remoteHost, remotePort)`.

### 3.2 Multiplexage `ControlMaster`

Pas de réutilisation de connexions (`ControlMaster auto` + `ControlPath`). Chaque `ssh user@host` ouvre une nouvelle session.

### 3.3 ~~`~/.ssh/known_hosts` per-host hashing~~ → corrigé §1.6

OpenSSH par défaut hache les hostnames (`HashKnownHosts yes`). Le simulateur stocke désormais le token `|1|<salt>|<hash>` quand l'option est positionnée (CLI `-o HashKnownHosts=yes` ou `HashKnownHosts yes` dans `~/.ssh/config`). Hash déterministe non-cryptographique (BRD C-02).

### 3.4 `sshd_config` directives non honorées

Sur le subset documenté dans `SshSshdConfig` (`Port`, `PermitRootLogin`, `PasswordAuthentication`, `PubkeyAuthentication`, `AllowUsers`, `MaxAuthTries`, `Banner`), tout est honoré. Mais le BRD pourrait demander :
- `DenyUsers` / `AllowGroups` / `DenyGroups`
- `ClientAliveInterval` / `ClientAliveCountMax`
- `LoginGraceTime`
- `Subsystem sftp /usr/lib/openssh/sftp-server` (en dur dans le simulateur)
- `Match` blocks
- `AuthorizedKeysFile`

### 3.5 Commandes CLI absentes

| Commande | Statut |
|---|---|
| `ssh-add` / `ssh-agent` | absent |
| `ssh -L/-R/-D` | absent |
| `ssh -t` (force TTY) | absent (pas de TTY simulé) |
| `ssh-keyscan` | absent |
| `sftp -b <batchfile>` | absent (mode interactif uniquement) |
| `scp -3` (relay) | absent |
| `scp -p` (préserve mtime/perms) | flag parsé mais pas honoré |

### 3.6 Pas de gestion de signaux

`SshExecChannel` ne propage pas SIGINT (Ctrl+C local → SIGINT remote). Une commande lourde côté remote ne peut pas être interrompue depuis le client.

### 3.7 ~~`/var/log/auth.log`~~ → corrigé §1.4 ; ~~`wtmp`/`btmp`~~ → corrigé §1.5

`lastlog.json` + `auth.log` + `wtmp.json` + `btmp.json` sont écrits côté serveur ; `last` et `lastb` lisent ces fichiers et émettent les lignes au format OpenSSH (filtre utilisateur, `-N` numérique). `btmp` reste mode `0o600` (parité OpenSSH), donc accessible uniquement via root ou directement par la VFS interne.

### 3.8 Test NFR-02 : couverture réelle non mesurée

Le BRD demande 85-90% de couverture sur les modules clés. Aucun rapport de couverture n'est généré aujourd'hui (`vitest --coverage` jamais lancé). À ajouter en CI.

---

## 4. Irréalismes acceptables (par design)

| Comportement | Pourquoi acceptable |
|---|---|
| Pas de chiffrement réel | C-02 du BRD |
| Banner négocié en JSON | simplicité du simulateur |
| `sftp put` envoie le contenu complet en un shot | C-01 livraison synchrone in-memory |
| Fingerprint déterministe | utile pour les tests reproductibles |
| `SshSession.connect()` en `Promise<…>` mais résolvée en 1-2 microtasks | C-01 |

---

## 5. Plan de remédiation recommandé

Ordre de priorité, du plus impactant au plus accessoire :

1. ~~Bandeau UI SSH~~ → corrigé §1.2
2. ~~Auth clé publique Windows~~ → corrigé §1.3
3. ~~`/var/log/auth.log`~~ → corrigé §1.4
4. **`ssh -t` + canal shell PTY** — pour permettre `top`, `htop`, `less` en interactif. Implique d'ajouter un `op:'shell_input'` côté serveur. **Reste à faire**.
5. ~~`sftp -b` mode batch~~ → corrigé §1.7
6. ~~Port forwarding `-L`~~ → corrigé §1.11 (scaffold listener + bridge via `nc`). Le forwarding réel `direct-tcpip` reste à wirer si besoin.
7. ~~Coverage report~~ → corrigé §1.8
8. ~~Hash `known_hosts`~~ → corrigé §1.6
9. ~~`wtmp`/`btmp`~~ → corrigé §1.5

---

## 6. Tests existants à étendre

| Domaine | Couverture actuelle | Manque |
|---|---|---|
| `SshSession` reload après `systemctl restart` | RS13 + S38 | tests de connexions in-flight pendant un restart |
| Serveur Windows | 0 test sur la connexion réelle (handler stub) | tests round-trip avec `WindowsSftpFSAdapter` |
| `op:'cd'` / `op:'pwd'` (récents) | tests indirects via SftpSession | test direct de la commande dispatchée |
| Récursivité scp `-r` | S81 + RS5 | scénarios avec liens symboliques, fichiers spéciaux |
| Concurrent | S70 (2 sessions) | 50 sessions concurrentes, mesurer la dégradation |

---

## 7. Inventaire final — état du module

- **31 fichiers source** sous `src/network/protocols/ssh/` (ajout de `SshLocalForwarder.ts`) + `src/terminal/sessions/sshArgs.ts` pour le parseur partagé.
- **21 fichiers de tests** sous `src/__tests__/unit/network-v2/ssh-*` ; **443 / 443** scénarios verts (dont `F1..F7`, `G1..G9`, `H1..H7` header subshell, `J1..J7` ProxyJump, `L1..L7` LocalForward).
- **3 fichiers d'intégration côté terminal** : `LinuxTerminalSession`, `RemoteShellSubShell`, `SftpSubShell`
- **2 fichiers d'intégration côté device** : `LinuxMachine`, `WindowsPC`
- **Reste du plan §5** : `ssh -t` shell PTY (P4) — port forwarding `-R` / `-D` peuvent reprendre le pattern de §1.11.
- **Couverture** : `npm run test:coverage` (provider v8, cible 85/85/85/75 sur `src/network/protocols/ssh/**`).
- **BRD** : section 0 récap + statuts inline pour chaque exigence
