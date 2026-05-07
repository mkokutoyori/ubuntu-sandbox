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

**État** : `pushRemoteDevice` swap correctement le device, et le prompt change (`user@host:~$`). Mais il manquait une API observable pour que les composants React puissent peindre une bannière du type « SSH connected to <host> ».

**Correctif** : nouveau getter `LinuxTerminalSession.getSshContextInfo()` :
```ts
{ active: boolean, chain: { host, user }[], current: string | null }
```

**Test** : `RS14 — getSshContextInfo() reflects the current chain`.

**Ce qui reste à faire côté UI** : un composant React qui consomme `getSshContextInfo()` et rend un bandeau coloré au-dessus de la zone de scroll. Ce composant n'est pas inclus dans cette PR (le scope est l'API).

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

### 2.8 Windows : pas d'auth par clé publique

`WindowsSshServerContext.checkPublicKey` retourne toujours `false` (commentaire dans le code). Conséquence : `ssh-copy-id` vers une cible Windows ne servira à rien, l'utilisateur doit toujours taper le mot de passe.

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

### 3.3 `~/.ssh/known_hosts` per-host hashing

OpenSSH par défaut hache les hostnames (`HashKnownHosts yes`). Le simulateur stocke les noms en clair. Pas critique pour la valeur pédagogique.

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

### 3.7 Pas de logs côté `auth.log` / `wtmp`

Le simulateur garde une `lastlog.json` minimaliste mais ne renseigne pas `/var/log/auth.log`, `wtmp`, `btmp`. `last`, `lastb`, `who`, `w` ne reflètent pas les connexions SSH.

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

1. **Bandeau UI SSH** — composant React qui consomme `getSshContextInfo()` (déjà câblé côté terminal session, manque la vue).
2. **Auth clé publique Windows** — implémenter `WindowsAuthorizedKeys` symétrique de Linux.
3. **`ssh -t` + canal shell PTY** — pour permettre `top`, `htop`, `less` en interactif. Implique d'ajouter un `op:'shell_input'` côté serveur.
4. **`sftp -b` mode batch** — utile pour les tutoriels CI-style.
5. **Port forwarding `-L`** — pour les scénarios pédagogiques (tunnel HTTP).
6. **Coverage report** — `vitest run --coverage` + seuil 85% pour les modules SSH cœur.
7. **Hash `known_hosts`** — réalisme cosmétique, faible impact.
8. **`/var/log/auth.log`** — meilleur réalisme du `last` / `who`.

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

- **30 fichiers source** sous `src/network/protocols/ssh/`
- **10 fichiers de tests** sous `src/__tests__/unit/network-v2/ssh-*` ; **305 / 305** scénarios verts
- **3 fichiers d'intégration côté terminal** : `LinuxTerminalSession`, `RemoteShellSubShell`, `SftpSubShell`
- **2 fichiers d'intégration côté device** : `LinuxMachine`, `WindowsPC`
- **BRD** : section 0 récap + statuts inline pour chaque exigence
