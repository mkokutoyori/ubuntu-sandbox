# BRD — Implémentation SSH & Refonte SFTP (Simulateur)

**Version** : 1.0
**Date** : 2026-05-05
**Projet** : Ubuntu Sandbox — Module SSH/SFTP
**Auteur** : Claude Code

---

## Table des matières

1. [Introduction et Contexte](#1-introduction-et-contexte)
2. [Analyse de l'État Actuel — Défaillances SFTP](#2-analyse-de-létat-actuel--défaillances-sftp)
3. [Périmètre et Objectifs](#3-périmètre-et-objectifs)
4. [Requirements SSH](#4-requirements-ssh)
5. [Requirements SFTP — Refonte](#5-requirements-sftp--refonte)
6. [Plan d'Implémentation](#6-plan-dimplémentation)
7. [Contraintes Techniques et NFR](#7-contraintes-techniques-et-nfr)

---

## 1. Introduction et Contexte

### 1.1 Contexte du projet

Ubuntu Sandbox est un simulateur réseau en navigateur (React + TypeScript) dans lequel les utilisateurs connectent des équipements virtuels (routeurs, switchs, PCs Linux/Windows, serveurs) et interagissent via des émulateurs de terminaux reproduisant Cisco IOS, Huawei VRP, Linux bash et Windows cmd/PowerShell.

L'objectif du simulateur est le **réalisme comportemental** : un utilisateur formé sur le simulateur doit pouvoir opérer sur un vrai équipement sans surprise. Cela inclut les messages d'erreur, les séquences de commandes, les comportements aux limites, et les protocoles réseau simulés.

### 1.2 État actuel du module SFTP

Un module SFTP a été implémenté et couvre les opérations de base (connect, ls, cd, get, put, mkdir, rm, rmdir, rename). Il est fonctionnel pour les scénarios simples mais repose sur une **architecture fondamentalement incorrecte** : JSON brut sur TCP port 22, sans couche SSH, sans chiffrement, sans négociation de protocole.

Cette approche suffisait pour une première itération, mais elle crée des divergences comportementales visibles par l'utilisateur et bloque l'extension vers SSH interactif (remote shell, SCP, port forwarding).

### 1.3 Motivation de ce BRD

Ce document formalise :
- Les **défauts et limitations de l'implémentation SFTP actuelle** à corriger
- Les **requirements pour un protocole SSH simulé** réaliste
- La **refonte du protocole SFTP** pour qu'il tourne sur la couche SSH simulée
- Le **plan d'implémentation** en phases livrables

### 1.4 Références

| Référence | Description |
|---|---|
| RFC 4251 | SSH Protocol Architecture |
| RFC 4252 | SSH Authentication Protocol |
| RFC 4253 | SSH Transport Layer Protocol |
| RFC 4254 | SSH Connection Protocol |
| draft-ietf-secsh-filexfer-02 | SFTP version 3 (implémentation de référence OpenSSH) |
| draft-ietf-secsh-filexfer-13 | SFTP version 6 (extensions modernes) |
| `man sftp(1)` OpenSSH 9.x | Comportement de référence de la CLI sftp |
| `man sshd_config(5)` | Comportement de référence du serveur SSH |

---

## 2. Analyse de l'État Actuel — Défaillances SFTP

Cette section documente exhaustivement les bugs, non-conformités et limitations de l'implémentation SFTP existante. Chaque item est classé par sévérité : **[BLOQUANT]** (comportement visible et erroné), **[MAJEUR]** (déviation significative du standard), **[MINEUR]** (cosmétique ou edge case).

### 2.1 Architecture protocolaire

#### DEF-01 [BLOQUANT] — Pas de couche SSH

L'implémentation actuelle envoie du JSON brut sur TCP port 22. La vraie séquence d'établissement SSH est :

```
TCP SYN/SYN-ACK/ACK
→ SSH-2.0-OpenSSH_9.6 (version banner)
→ SSH_MSG_KEXINIT (négociation algos)
→ SSH_MSG_KEX_ECDH_INIT / REPLY (échange Diffie-Hellman)
→ SSH_MSG_NEWKEYS (chiffrement activé)
→ SSH_MSG_SERVICE_REQUEST "ssh-userauth"
→ SSH_MSG_USERAUTH_REQUEST (password / publickey)
→ SSH_MSG_USERAUTH_SUCCESS
→ SSH_MSG_CHANNEL_OPEN
→ SSH_MSG_CHANNEL_REQUEST "subsystem" "sftp"
→ SSH_FXP_INIT / SSH_FXP_VERSION (négociation SFTP)
→ opérations SFTP
```

Rien de cette séquence n'existe. Conséquence : aucune expérience utilisateur liée à SSH (fingerprint, known_hosts, banner) n'est reproduite.

#### DEF-02 [BLOQUANT] — Opération `auth` non-standard

Le paquet `{ op: 'auth', user, password }` est une invention de l'implémentation. Ce type de paquet n'existe pas dans le protocole SFTP. L'authentification est faite au niveau SSH avant même l'ouverture du sous-système SFTP.

#### DEF-03 [MAJEUR] — Pas de vérification du host key

Sur un premier connect réel :
```
The authenticity of host '10.0.0.2 (10.0.0.2)' can't be established.
ED25519 key fingerprint is SHA256:abc123...
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```
Cette interaction est totalement absente. L'utilisateur ne voit jamais de fingerprint et n'est jamais invité à valider.

#### DEF-04 [MAJEUR] — Modèle de transfert atomique

Le vrai SFTP utilise des handles de fichiers avec transfert en chunks (max 32 768 octets) :
```
SSH_FXP_OPEN → SSH_FXP_HANDLE
SSH_FXP_READ (offset=0, len=32768) → SSH_FXP_DATA
SSH_FXP_READ (offset=32768, len=32768) → SSH_FXP_DATA
... ×N chunks ...
SSH_FXP_CLOSE
```
L'implémentation transfère tout le contenu en un seul message JSON, ce qui ne permet pas de simuler la progression ni les reprises.

#### DEF-05 [MAJEUR] — Données binaires non supportées

Le transport JSON ne peut pas représenter fidèlement des octets arbitraires (0x00, bytes non-UTF-8). `JSON.stringify` encode les null bytes en `\u0000` mais des séquences binaires réelles (images, exécutables, archives) seraient corrompues ou rejetées.

---

### 2.2 Bugs côté serveur (`SftpServerHandler.ts`)

#### DEF-06 [BLOQUANT] — `put` ignore les erreurs d'écriture

```typescript
server.vfs.writeFile(abs, content);
return { ok: true };   // jamais d'erreur retournée
```

Le code ne vérifie pas la valeur de retour de `writeFile`. Un disque plein, un chemin invalide ou un `permission denied` sont silencieusement ignorés. Le client reçoit toujours `{ ok: true }`.

#### DEF-07 [MAJEUR] — `mkdir` crée les parents (mkdirp au lieu de mkdir)

```typescript
server.vfs.mkdirp(abs);
```

Le vrai `SSH_FXP_MKDIR` échoue avec `SSH_FX_NO_SUCH_FILE` si le répertoire parent n'existe pas. L'appel à `mkdirp` crée silencieusement toute la chaîne de répertoires, ce qui est un comportement non-standard.

#### DEF-08 [MAJEUR] — `rename` écrase la destination sans erreur

En SFTP v3, `SSH_FXP_RENAME` doit retourner `SSH_FX_FILE_ALREADY_EXISTS` si la destination existe déjà. Ce comportement n'a été assoupli qu'en SFTP v5+ avec un champ flags explicite. L'implémentation actuelle écrase silencieusement.

#### DEF-09 [MAJEUR] — `ls` retourne uniquement les noms

Le vrai `SSH_FXP_READDIR` retourne pour chaque entrée : nom, `longname` (équivalent `ls -l`), et une structure ATTRS (permissions, uid, gid, size, atime, mtime). La commande `ls -l` en sftp interactif affiche :
```
-rw-r--r--    1 alice    alice        1024 May 05 10:23 file.txt
drwxr-xr-x    2 alice    alice        4096 May 05 10:20 docs/
```
L'implémentation retourne uniquement les noms, sans aucun attribut.

#### DEF-10 [MINEUR] — Messages d'erreur non-conformes

| Situation | Message actuel | Message OpenSSH réel |
|---|---|---|
| `rm` sur un répertoire | `Couldn't delete file` | `Couldn't remove file: remove "/path": Failure` |
| `get` fichier inexistant | `File "..." not found. Ensure that... No such file or directory` | `Fetching /path to /local\n/path: No such file or directory` |
| `rmdir` non-vide | `Couldn't remove directory: ...` | `Couldn't remove directory: rmdir /path: Failure` |
| `rename` inexistant | `No such file or directory` (dans le mauvais format) | `Couldn't rename file: rename /old /new: No such file or directory` |

---

### 2.3 Bugs côté client (`SftpSession.ts`)

#### DEF-11 [BLOQUANT] — Connexion TCP orpheline après échec d'auth

```typescript
if (!authResp.ok) {
    this.conn = null;   // perd la référence
    // manque : conn.close()
    return `Permission denied`;
}
```

La connexion TCP reste ouverte côté serveur. Après plusieurs tentatives avec mauvais mot de passe, des connexions zombies s'accumulent.

#### DEF-12 [MAJEUR] — Port hardcodé à 22

```typescript
const conn = await this.tcpConnector(host, 22);
```

L'option `sftp -P 2222 user@host` (port custom) est ignorée. Le port n'est jamais transmis depuis la ligne de commande vers `SftpSession`.

#### DEF-13 [MAJEUR] — Pas d'expansion de `~`

`get ~/documents/file.txt` échoue car `~` n'est pas résolu en répertoire home. Le vrai sftp et bash résolvent `~` en `$HOME`.

#### DEF-14 [MINEUR] — Format de progression incorrect

```typescript
return `${name}                                    100% ${bytes}   ${kb}KB/s   00:00`;
```

Problèmes :
- Affiche des **bytes bruts** ; le vrai sftp affiche en KB ou MB selon la taille
- Le **padding est fixe** (40 espaces), le vrai sftp aligne dynamiquement sur la largeur du terminal
- La **vitesse est toujours 0.0KB/s** pour les petits fichiers (pas de simulation de bande passante)
- L'ETA (`00:00`) est systématique, jamais calculé

Vrai OpenSSH pour un fichier de 1.4 KB :
```
report.txt                           100% 1399     1.4KB/s   00:00
```

---

### 2.4 Bugs dans `SftpSubShell.ts`

#### DEF-15 [BLOQUANT] — `lmkdir` annoncé dans le help mais non implémenté

```
lmkdir path                              Create local directory
```
Le `switch` n'a pas de `case 'lmkdir'` → tombe sur `"Invalid command."`. Le help est mensonger.

#### DEF-16 [BLOQUANT] — Ctrl+D ne quitte pas la session

```typescript
if (e.key === 'd' && e.ctrlKey) return true;  // consomme sans agir
```

Sur un vrai sftp, Ctrl+D envoie EOF et ferme la session proprement. Ici la touche est consommée mais rien ne se passe — l'utilisateur est bloqué.

#### DEF-17 [MAJEUR] — Flags non parsés pour `get`, `put`, `ls`

Le help affiche `get [-afpR] remote [local]` et `ls [-1afhlnrSt] [path]` mais le code ne parse aucun flag :

```typescript
case 'get': {
    const [remote, local] = rest;  // si l'user tape "get -r dir/", remote = "-r"
```

`sftp> get -r remotedir/` résultera en une tentative de télécharger un fichier nommé `-r`.

#### DEF-18 [MAJEUR] — Commandes manquantes dans le sous-shell interactif

Commandes présentes dans le vrai `sftp(1)` et absentes de l'implémentation :

| Commande | Description |
|---|---|
| `chmod <mode> <path>` | Changer les permissions d'un fichier distant |
| `chown <uid> <path>` | Changer le propriétaire d'un fichier distant |
| `ln [-s] <old> <new>` | Créer un lien (symbolique ou physique) |
| `!<cmd>` | Exécuter une commande dans le shell local |
| `lumask <mask>` | Définir le umask local |
| `df [-hi] [path]` | Afficher l'espace disque disponible |
| `reget <remote> [local]` | Reprendre un téléchargement interrompu |
| `reput <local> [remote]` | Reprendre un envoi interrompu |

---

### 2.5 Adaptateur Windows (`WindowsSftpAdapter.ts`)

#### DEF-19 [MAJEUR] — Chemins relatifs assumés sur `C:` sans documentation

```typescript
// /foo/bar → C:\foo\bar (assume C: drive)
if (sftpPath.startsWith('/')) return 'C:' + sftpPath.replace(/\//g, '\\');
```

Un chemin SFTP sans lettre de lecteur (e.g., `/home/user/file`) est silencieusement mappé sur `C:\home\user\file`. Ce comportement implicite peut créer des fichiers dans des emplacements inattendus.

#### DEF-20 [MINEUR] — Racine de lecteur manque le slash final

```typescript
// C:\ → /C:  (devrait être /C:/)
const root = winPath.match(/^([A-Za-z]):\\?$/);
if (root) return '/' + root[1].toUpperCase() + ':';
```

Incohérence avec la convention `/C:/...` utilisée partout ailleurs.

#### DEF-21 [MAJEUR] — `rename` Windows ne gère pas les répertoires

```typescript
const content = this.wfs.readFile(srcWin);  // échoue pour un répertoire
if (!content.ok) return false;
```

`sftp> rename dir1 dir2` est une opération valide sur un vrai serveur SSH Windows (OpenSSH for Windows). L'adaptateur lit le contenu du fichier source — opération impossible sur un répertoire — et retourne `false`.

---

### 2.6 Sécurité et permissions

#### DEF-22 [MAJEUR] — Aucun contrôle de permissions Unix côté serveur

Le serveur SFTP ne vérifie jamais les permissions Unix (mode, uid, gid) lors des opérations de lecture, écriture ou exécution. Tout utilisateur authentifié peut lire `/etc/shadow` (mode `0640`, root:shadow) ou écrire dans `/bin` (mode `0755`, root:root).

#### DEF-23 [MAJEUR] — Pas d'authentification par clé publique

Seule l'authentification par mot de passe est supportée. Les mécanismes réels :
- `publickey` (clés RSA/ED25519 dans `~/.ssh/authorized_keys`)
- `keyboard-interactive` (challenge/réponse)
sont absents.

---

### 2.7 `LinuxCommandExecutor` — stub sftp cassé

#### DEF-24 [BLOQUANT] — Stub retourne toujours "Connection refused"

```typescript
case 'sftp': {
    return { output: `ssh: connect to host ${host} port 22: Connection refused`, exitCode: 255 };
}
```

Ce code retourne "Connection refused" même si le serveur existe et écoute. Il est actuellement contourné par `LinuxTerminalSession.enterSftp()` qui intercepte la commande avant qu'elle atteigne l'executor — mais ce contournement est fragile et le stub reste trompeur pour tout chemin de code non couvert.

---

## 3. Périmètre et Objectifs

### 3.1 Objectif principal

Implémenter un **protocole SSH simulé** réaliste sur lequel SFTP et SSH interactif tournent comme sur un vrai équipement, tout en corrigeant les 24 défauts identifiés en section 2.

Le critère de réussite est comportemental : un utilisateur qui a appris SSH/SFTP sur ce simulateur doit pouvoir opérer sans surprise sur OpenSSH réel (Ubuntu 22.04 LTS, OpenSSH 9.x).

### 3.2 Ce qui est dans le périmètre

#### Périmètre SSH (nouveau)

| ID | Fonctionnalité | Priorité |
|---|---|---|
| SSH-01 | Version banner + négociation de protocole (simulée) | P1 |
| SSH-02 | Authentification par mot de passe | P1 |
| SSH-03 | Vérification du host key + gestion `known_hosts` | P1 |
| SSH-04 | Session SSH interactive (`ssh user@host`) | P1 |
| SSH-05 | Exécution de commande distante (`ssh user@host <cmd>`) | P2 |
| SSH-06 | Authentification par clé publique (ED25519/RSA) | P2 |
| SSH-07 | `ssh-keygen` — génération de paires de clés | P2 |
| SSH-08 | `ssh-copy-id` — déploiement de clé publique | P2 |
| SSH-09 | Gestion de `~/.ssh/config` (Host aliases, Port, User) | P3 |
| SSH-10 | `scp` — copie sécurisée de fichiers | P3 |

#### Périmètre SFTP (refonte + corrections)

| ID | Fonctionnalité | Type |
|---|---|---|
| SFTP-01 | Transport sur couche SSH simulée | Refonte |
| SFTP-02 | Négociation de version SFTP (SSH_FXP_INIT/VERSION) | Refonte |
| SFTP-03 | Correction DEF-06 : `put` propagation d'erreur | Correction |
| SFTP-04 | Correction DEF-07 : `mkdir` non-récursif | Correction |
| SFTP-05 | Correction DEF-08 : `rename` protège la destination | Correction |
| SFTP-06 | Correction DEF-09 : `ls -l` avec attributs | Correction |
| SFTP-07 | Correction DEF-10 : messages d'erreur conformes OpenSSH | Correction |
| SFTP-08 | Correction DEF-11 : fermeture TCP propre après auth failure | Correction |
| SFTP-09 | Correction DEF-14 : format de progression réaliste | Correction |
| SFTP-10 | Correction DEF-15 : implémenter `lmkdir` | Correction |
| SFTP-11 | Correction DEF-16 : Ctrl+D quitte la session | Correction |
| SFTP-12 | Correction DEF-17 : parsing des flags `-r/-l/-f` | Correction |
| SFTP-13 | Correction DEF-19/20/21 : adaptateur Windows path | Correction |
| SFTP-14 | Ajout `chmod` en session interactive | Extension |
| SFTP-15 | Ajout `chown` en session interactive | Extension |
| SFTP-16 | Ajout `stat` / attributs fichier | Extension |
| SFTP-17 | Ajout `df` — espace disque | Extension |
| SFTP-18 | Expansion `~` dans les chemins | Extension |
| SFTP-19 | Support port custom (`-P`) depuis CLI | Extension |
| SFTP-20 | Contrôle de permissions Unix côté serveur | Extension |

### 3.3 Ce qui est hors périmètre

Les éléments suivants sont **explicitement exclus** de cette implémentation :

| Exclusion | Justification |
|---|---|
| Chiffrement réel (AES, ChaCha20) | Le simulateur est en mémoire locale, le chiffrement n'apporte pas de valeur pédagogique et alourdirait inutilement le code |
| Vrai échange Diffie-Hellman | Même justification — la simulation du comportement visible suffit |
| SSH port forwarding (-L/-R/-D) | Hors scope v1, à réévaluer |
| SFTP transfert chunké avec vraie progression (bande passante simulée) | Complexité élevée pour faible valeur pédagogique dans un premier temps |
| SCP v2 (protocol wire-level) | Peut être simulé au niveau comportement sans implémenter le protocole wire |
| Protocole SSH Agent (ssh-agent, ssh-add) | Hors scope v1 |
| X11 forwarding | Hors scope |
| Authentification par certificat SSH (CA) | Hors scope v1 |

### 3.4 Dépendances

| Dépendance | Description | État |
|---|---|---|
| `VirtualFileSystem` | Filesystem Linux inode-based | Existant ✅ |
| `WindowsFileSystem` | Filesystem Windows case-insensitive | Existant ✅ |
| `LinuxUserManager` | Gestion utilisateurs Linux + shadow | Existant ✅ |
| `WindowsUserManager` | Gestion utilisateurs Windows + SIDs | Existant ✅ |
| `EndHost.tcpConnect` | Stack TCP client | Existant ✅ |
| `EndHost.listenTcp` | Stack TCP serveur | Existant ✅ |
| `TcpConnection` | Transport in-memory / réseau simulé | Existant ✅ |
| Stockage clés SSH (`~/.ssh/`) | Fichiers dans VirtualFileSystem | À créer |

---

## 4. Requirements SSH

### 4.1 Vue d'ensemble du protocole SSH simulé

Le simulateur n'implémente pas un vrai chiffrement SSH (inutile dans un environnement en mémoire locale). En revanche, il simule fidèlement **tous les comportements visibles** : messages, séquences, états, erreurs et fichiers de configuration. L'utilisateur vit la même expérience qu'avec OpenSSH réel.

Le protocole SSH simulé suit la RFC 4253 (transport), RFC 4252 (auth) et RFC 4254 (connection) du point de vue des messages visibles en terminal.

---

### 4.2 SSH-01 — Établissement de connexion et version banner

#### Comportement attendu

Lors de la connexion sortante (`ssh user@host`), le client affiche le banner de version du serveur si celui-ci a une `Banner` configurée, puis procède à la vérification du host key (voir SSH-03).

Le simulateur doit produire la séquence visible suivante :

```
$ ssh alice@192.168.1.10
The authenticity of host '192.168.1.10 (192.168.1.10)' can't be established.
ED25519 key fingerprint is SHA256:xLp3K1mNqRtU2vWzY0hBjCfD8gEsA9oP4iQe7nMkXcV.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
Warning: Permanently added '192.168.1.10' (ED25519) to the list of known hosts.
alice@192.168.1.10's password:
```

Si le host est déjà connu (`~/.ssh/known_hosts` présent et correspondant) :
```
$ ssh alice@192.168.1.10
alice@192.168.1.10's password:
```

Si le host key a changé (MITM / serveur réinstallé) :
```
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
...
Host key for 192.168.1.10 has changed and you have requested strict checking.
Host key verification failed.
```

#### Requirements

| ID | Requirement |
|---|---|
| SSH-01-R1 | Chaque device Linux/Windows possède un host key ED25519 généré à la création (fingerprint déterministe basé sur l'IP ou le hostname) |
| SSH-01-R2 | Le client SSH vérifie `~/.ssh/known_hosts` avant de se connecter |
| SSH-01-R3 | Si le host est inconnu, afficher le fingerprint et demander confirmation `yes/no/[fingerprint]` |
| SSH-01-R4 | Répondre `yes` : ajouter le host key à `~/.ssh/known_hosts` et continuer |
| SSH-01-R5 | Répondre `no` : abandonner la connexion avec `Host key verification failed.` |
| SSH-01-R6 | Répondre le fingerprint exact : accepter sans ajouter à known_hosts (vérification directe) |
| SSH-01-R7 | Si le host key a changé : afficher le bloc d'avertissement `@@@` et refuser la connexion |
| SSH-01-R8 | `StrictHostKeyChecking=no` (via `-o` ou `~/.ssh/config`) : skip la vérification, toujours accepter |
| SSH-01-R9 | `StrictHostKeyChecking=accept-new` : accepter les nouveaux hosts silencieusement, rejeter les changements |

---

### 4.3 SSH-02 — Authentification par mot de passe

#### Comportement attendu

```
alice@192.168.1.10's password: ••••••••
Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)
Last login: Mon May  4 10:23:15 2026 from 192.168.1.5
alice@server:~$
```

Échec d'authentification :
```
alice@192.168.1.10's password:
Permission denied, please try again.
alice@192.168.1.10's password:
Permission denied, please try again.
alice@192.168.1.10's password:
alice@192.168.1.10: Permission denied (publickey,password).
```

#### Requirements

| ID | Requirement |
|---|---|
| SSH-02-R1 | Prompt de mot de passe : `user@host's password: ` (masqué) |
| SSH-02-R2 | Authentification réussie : afficher le MOTD du serveur distant si `/etc/motd` existe |
| SSH-02-R3 | Afficher `Last login: <date> from <ip>` si applicable |
| SSH-02-R4 | Échec : `Permission denied, please try again.` puis nouveau prompt |
| SSH-02-R5 | Maximum 3 tentatives puis `Permission denied (publickey,password).` et déconnexion |
| SSH-02-R6 | Le message `Permission denied` liste les méthodes disponibles : `(publickey,password)` ou `(password)` selon config |
| SSH-02-R7 | Le compte `root` est refusé par défaut (`PermitRootLogin no` dans sshd_config simulé) sauf configuration explicite |

---

### 4.4 SSH-03 — Authentification par clé publique

#### Comportement attendu

```
$ ssh -i ~/.ssh/id_ed25519 alice@192.168.1.10
Welcome to Ubuntu 22.04.3 LTS
alice@server:~$
```

Si la clé n'est pas autorisée :
```
alice@192.168.1.10: Permission denied (publickey).
```

#### Requirements

| ID | Requirement |
|---|---|
| SSH-03-R1 | `ssh-keygen -t ed25519 [-C comment] [-f filename]` : génère une paire de clés dans `~/.ssh/` |
| SSH-03-R2 | La clé privée est stockée dans `~/.ssh/id_ed25519` (permissions 600 simulées) |
| SSH-03-R3 | La clé publique est stockée dans `~/.ssh/id_ed25519.pub` |
| SSH-03-R4 | `ssh-keygen` interactif demande passphrase (peut être vide) |
| SSH-03-R5 | `ssh-copy-id [-i keyfile] user@host` : copie la clé publique dans `~/.ssh/authorized_keys` du serveur distant |
| SSH-03-R6 | Le serveur vérifie `~/.ssh/authorized_keys` de l'utilisateur cible |
| SSH-03-R7 | Format de `authorized_keys` : une clé publique par ligne (`ssh-ed25519 AAAA...key comment`) |
| SSH-03-R8 | `ssh -i keyfile user@host` : utiliser la clé spécifiée explicitement |
| SSH-03-R9 | Le client essaie les clés dans `~/.ssh/` automatiquement (`id_ed25519`, `id_rsa`) |
| SSH-03-R10 | Fingerprint affiché lors de `ssh-keygen` : `SHA256:<base64>` format |

---

### 4.5 SSH-04 — Session SSH interactive

#### Comportement attendu

Après authentification réussie, l'utilisateur dispose d'un shell distant complet :

```
alice@192.168.1.10's password:
Welcome to Ubuntu 22.04.3 LTS
alice@server:~$ ls
documents  downloads  scripts
alice@server:~$ cat documents/readme.txt
Hello from the remote server
alice@server:~$ exit
logout
Connection to 192.168.1.10 closed.
```

Le shell distant est le shell Linux du device cible (bash complet avec toutes les commandes du `LinuxCommandExecutor`).

#### Requirements

| ID | Requirement |
|---|---|
| SSH-04-R1 | Après auth, ouvrir un `LinuxTerminalSession` sur le device distant comme sous-shell |
| SSH-04-R2 | Le prompt reflète le user et hostname distants : `alice@server:~$` |
| SSH-04-R3 | Toutes les commandes disponibles dans le shell Linux sont disponibles dans la session SSH |
| SSH-04-R4 | `exit` ou `logout` ferme la session et retourne au shell local avec `Connection to <host> closed.` |
| SSH-04-R5 | Ctrl+D dans la session SSH envoie EOF → ferme la session (même comportement que `exit`) |
| SSH-04-R6 | Les commandes s'exécutent dans le contexte du filesystem du device distant |
| SSH-04-R7 | L'utilisateur distant est celui authentifié (non root par défaut, sauf si auth en tant que root) |
| SSH-04-R8 | Si le shell distant fait une erreur (`command not found`), retourner l'erreur normalement sans fermer la session |

---

### 4.6 SSH-05 — Exécution de commande distante non-interactive

#### Comportement attendu

```
$ ssh alice@192.168.1.10 ls /home/alice
documents  downloads  scripts
$ ssh alice@192.168.1.10 "cat /etc/hostname"
server
$
```

La commande s'exécute et retourne la sortie, puis la connexion se ferme automatiquement.

#### Requirements

| ID | Requirement |
|---|---|
| SSH-05-R1 | `ssh user@host <command>` exécute la commande sur le device distant et affiche le résultat |
| SSH-05-R2 | La connexion se ferme automatiquement après l'exécution (pas de shell interactif) |
| SSH-05-R3 | Le code de retour de la commande distante est propagé comme code de sortie |
| SSH-05-R4 | Les guillemets permettent des commandes avec espaces : `ssh user@host "echo hello world"` |
| SSH-05-R5 | `stderr` distant est affiché normalement (pas de séparation stdout/stderr dans le simulateur) |

---

### 4.7 SSH-06 — Configuration `~/.ssh/config`

#### Comportement attendu

```
# ~/.ssh/config
Host prod
    HostName 192.168.1.10
    User alice
    Port 2222
    IdentityFile ~/.ssh/id_prod

$ ssh prod          # equivalent à : ssh -p 2222 -i ~/.ssh/id_prod alice@192.168.1.10
```

#### Requirements

| ID | Requirement |
|---|---|
| SSH-06-R1 | Parser `~/.ssh/config` lors de chaque connexion SSH |
| SSH-06-R2 | Directives supportées : `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `StrictHostKeyChecking` |
| SSH-06-R3 | Les options CLI (`-p`, `-i`, `-o`) ont priorité sur `~/.ssh/config` |
| SSH-06-R4 | `Host *` comme wildcard pour les défauts globaux |
| SSH-06-R5 | Commentaires `#` ignorés |

---

### 4.8 SSH-07 — Serveur SSH (`sshd`) côté device

#### Comportement attendu

Chaque device Linux (et Windows avec OpenSSH Server) écoute sur TCP port 22 et accepte les connexions SSH.

```
$ systemctl status sshd
● ssh.service - OpenSSH server daemon
     Loaded: loaded (/lib/systemd/system/ssh.service; enabled)
     Active: active (running)
```

#### Requirements

| ID | Requirement |
|---|---|
| SSH-07-R1 | Chaque `LinuxMachine` (LinuxPC, LinuxServer) écoute sur TCP 22 et répond aux connexions SSH |
| SSH-07-R2 | Chaque `WindowsPC` avec OpenSSH Server (activé par défaut dans le simulateur) écoute sur TCP 22 |
| SSH-07-R3 | Le serveur gère le host key ED25519 stocké dans `/etc/ssh/ssh_host_ed25519_key` (Linux) ou simulé (Windows) |
| SSH-07-R4 | `sshd_config` simulé dans `/etc/ssh/sshd_config` avec valeurs par défaut réalistes |
| SSH-07-R5 | Directives `sshd_config` simulées : `PermitRootLogin`, `PasswordAuthentication`, `PubkeyAuthentication`, `Port`, `AllowUsers` |
| SSH-07-R6 | `systemctl restart sshd` / `service ssh restart` relit la config (applique les changements) |
| SSH-07-R7 | MOTD configurable via `/etc/motd` |
| SSH-07-R8 | Bannière de connexion configurable via `sshd_config Banner /etc/issue.net` |

---

### 4.9 SSH-08 — `scp` (Secure Copy)

#### Comportement attendu

```
$ scp /local/file.txt alice@192.168.1.10:/home/alice/
file.txt                                     100% 1399     1.4KB/s   00:00

$ scp alice@192.168.1.10:/home/alice/report.txt ./
report.txt                                   100% 4096     4.0KB/s   00:00

$ scp -r alice@192.168.1.10:/home/alice/docs/ ./backups/
docs/file1.txt                               100%  512     0.5KB/s   00:00
docs/file2.txt                               100%  256     0.3KB/s   00:00
```

#### Requirements

| ID | Requirement |
|---|---|
| SSH-08-R1 | `scp local user@host:remote` — copie locale vers distante |
| SSH-08-R2 | `scp user@host:remote local` — copie distante vers locale |
| SSH-08-R3 | `scp -r` — copie récursive de répertoire |
| SSH-08-R4 | Format de progression identique à sftp : `filename  100%  size  speed  time` |
| SSH-08-R5 | Authentification identique à SSH (mot de passe ou clé publique) |
| SSH-08-R6 | Pas de `scp` interactif — transfert direct, pas de sous-shell |

---



## 5. Requirements SFTP — Refonte

### 5.1 Vue d'ensemble

Le protocole SFTP est refondu pour tourner sur la couche SSH simulée (section 4). Les opérations SFTP restent simulées en JSON côté interne, mais du point de vue de l'utilisateur la séquence complète SSH est respectée avant que le sous-système SFTP ne démarre.

Cette section couvre : les corrections des 24 défauts identifiés en section 2, les extensions de commandes, et les nouvelles fonctionnalités.

---

### 5.2 SFTP-01 — Transport sur couche SSH simulée

#### Requirement

Le sous-système SFTP doit démarrer APRES l'authentification SSH réussie. Du point de vue de l'utilisateur, lancer `sftp user@host` doit produire exactement la même séquence que `ssh user@host`, puis entrer dans le sous-shell sftp.

```
$ sftp alice@192.168.1.10
The authenticity of host '192.168.1.10 (192.168.1.10)' can't be established.
ED25519 key fingerprint is SHA256:xLp3K1...
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
Warning: Permanently added '192.168.1.10' (ED25519) to the list of known hosts.
alice@192.168.1.10's password:
Connected to 192.168.1.10.
sftp>
```

| ID | Requirement |
|---|---|
| SFTP-01-R1 | `sftp user@host` passe par la couche SSH simulée (host key check + auth) avant d'entrer dans le sous-shell |
| SFTP-01-R2 | `sftp -P <port> user@host` : support du port custom |
| SFTP-01-R3 | `sftp -i <keyfile> user@host` : auth par clé publique |
| SFTP-01-R4 | `sftp -o StrictHostKeyChecking=no user@host` : skip host key |
| SFTP-01-R5 | Apres auth, afficher `Connected to <host>.` puis entrer dans le sous-shell |

---

### 5.3 SFTP-02 — Négociation de version SFTP

#### Comportement attendu

```
$ sftp -v alice@192.168.1.10
...
debug1: Sending subsystem: sftp
debug1: client_input_channel_req: channel 0 rtype exit-status reply 0
Connected to alice@192.168.1.10
sftp> version
SFTP protocol version 3
```

| ID | Requirement |
|---|---|
| SFTP-02-R1 | Le serveur SFTP annonce la version 3 (compatibilité OpenSSH maximale) |
| SFTP-02-R2 | La commande `version` dans le sous-shell affiche `SFTP protocol version 3` |
| SFTP-02-R3 | Le client envoie SSH_FXP_INIT avec version=3, le serveur repond SSH_FXP_VERSION |

---

### 5.4 SFTP-03 — Correction DEF-06 : propagation des erreurs de `put`

#### Comportement attendu

```
sftp> put /local/file.txt /readonly/dir/file.txt
Uploading /local/file.txt to /readonly/dir/file.txt
remote open("/readonly/dir/file.txt"): Permission denied
```

| ID | Requirement |
|---|---|
| SFTP-03-R1 | `SftpServerHandler` vérifie la valeur de retour de `vfs.writeFile` |
| SFTP-03-R2 | Si l'écriture échoue, retourner `{ ok: false, error: 'Permission denied' }` ou `{ ok: false, error: 'No such file or directory' }` selon le cas |
| SFTP-03-R3 | `ISftpFileSystem.writeFile` retourne un booléen ou un objet `{ ok, error }` |

---

### 5.5 SFTP-04 — Correction DEF-07 : `mkdir` non-récursif

#### Comportement attendu

```
sftp> mkdir /home/alice/a/b/c
Couldn't create directory: No such file or directory
sftp> mkdir /home/alice/a
sftp> mkdir /home/alice/a/b
sftp> mkdir /home/alice/a/b/c
```

| ID | Requirement |
|---|---|
| SFTP-04-R1 | `SftpServerHandler` utilise `vfs.mkdir` (non-récursif) au lieu de `vfs.mkdirp` |
| SFTP-04-R2 | Si le répertoire parent n'existe pas, retourner `{ ok: false, error: 'No such file or directory' }` |
| SFTP-04-R3 | `ISftpFileSystem` expose `mkdir(path)` (non-récursif) distinct de `mkdirp(path)` |

---

### 5.6 SFTP-05 — Correction DEF-08 : `rename` protège la destination

#### Comportement attendu

```
sftp> rename old.txt existing.txt
Couldn't rename file: rename /home/alice/old.txt /home/alice/existing.txt: File exists
```

| ID | Requirement |
|---|---|
| SFTP-05-R1 | Avant de renommer, vérifier si la destination existe |
| SFTP-05-R2 | Si la destination existe, retourner `{ ok: false, error: 'File exists' }` |
| SFTP-05-R3 | Message client : `Couldn't rename file: rename <src> <dst>: File exists` |

---

### 5.7 SFTP-06 — Correction DEF-09 : `ls -l` avec attributs

#### Comportement attendu

```
sftp> ls
docs  file.txt  readme.md

sftp> ls -l
drwxr-xr-x    2 alice    alice        4096 May 05 10:20 docs
-rw-r--r--    1 alice    alice        1024 May 05 10:23 file.txt
-rw-r--r--    1 alice    alice         256 May 04 15:11 readme.md

sftp> ls -la
drwxr-xr-x    3 alice    alice        4096 May 05 10:20 .
drwxr-xr-x    4 root     root         4096 May 01 09:00 ..
-rw-------    1 alice    alice         128 May 03 11:45 .bash_history
drwxr-xr-x    2 alice    alice        4096 May 05 10:20 docs
-rw-r--r--    1 alice    alice        1024 May 05 10:23 file.txt
-rw-r--r--    1 alice    alice         256 May 04 15:11 readme.md
```

| ID | Requirement |
|---|---|
| SFTP-06-R1 | Parser le flag `-l` dans `SftpSubShell.ls` (séparé des arguments de chemin) |
| SFTP-06-R2 | Parser le flag `-a` pour inclure les fichiers cachés (`.dotfiles`) |
| SFTP-06-R3 | `ISftpFileSystem.listDirectory` retourne les attributs : type, permissions, uid, gid, size, mtime |
| SFTP-06-R4 | Avec `-l`, afficher le format `ls -l` : `<mode> <nlink> <owner> <group> <size> <date> <name>` |
| SFTP-06-R5 | Sans `-l`, afficher les noms séparés par des espaces (comportement actuel) |
| SFTP-06-R6 | Les répertoires affichés avec `/` suffixé dans le listing `-l` |
| SFTP-06-R7 | Les attributs pour Windows passent par `WindowsSftpFSAdapter` avec conversion appropriée |

---

### 5.8 SFTP-07 — Correction DEF-10 : messages d'erreur conformes OpenSSH

| Situation | Message à produire |
|---|---|
| `rm` sur un répertoire | `Couldn't remove file: remove "<path>": Failure` |
| `get` fichier inexistant | `Fetching <remote> to <local>\n<remote>: No such file or directory` |
| `rmdir` non-vide | `Couldn't remove directory: rmdir "<path>": Failure` |
| `rename` src inexistant | `Couldn't rename file: rename <old> <new>: No such file or directory` |
| `mkdir` parent inexistant | `Couldn't create directory: No such file or directory` |
| `put` écriture refusée | `Uploading <local> to <remote>\nremote open("<remote>"): Permission denied` |

| ID | Requirement |
|---|---|
| SFTP-07-R1 | `SftpSession.get` affiche `Fetching <remote> to <local>` avant le transfert |
| SFTP-07-R2 | `SftpSession.put` affiche `Uploading <local> to <remote>` avant le transfert |
| SFTP-07-R3 | Tous les messages d'erreur suivent le format OpenSSH listé ci-dessus |

---

### 5.9 SFTP-08 — Correction DEF-11 : fermeture propre de la connexion TCP

| ID | Requirement |
|---|---|
| SFTP-08-R1 | En cas d'échec d'authentification, `SftpSession.connect` appelle `conn.close()` avant de mettre `this.conn = null` |
| SFTP-08-R2 | `SftpSession.disconnect` appelle `conn.close()` (déjà implémenté, vérifier) |
| SFTP-08-R3 | Aucune connexion TCP orpheline ne doit subsister après un échec d'auth ou un disconnect |

---

### 5.10 SFTP-09 — Correction DEF-14 : format de progression réaliste

#### Comportement attendu

```
sftp> get large_file.dat
Fetching /home/alice/large_file.dat to large_file.dat
large_file.dat                               100% 1399KB   1.4MB/s   00:01
```

Format : `<nom_fichier_padded> 100% <taille_auto> <vitesse_auto>   <temps>`

Règles de formatage (identiques à OpenSSH sftp) :
- Taille : `< 1024` → `N B`, `< 1024*1024` → `N.NKB`, sinon → `N.NMB`
- Vitesse : meme règle, suffixe `/s`
- Temps : `MM:SS` (toujours `00:00` dans le simulateur, car transfert instantané)
- Padding du nom : 40 caractères minimum, tronqué avec `...` si trop long

| ID | Requirement |
|---|---|
| SFTP-09-R1 | La fonction `formatTransferLine` implémente les règles de taille automatique |
| SFTP-09-R2 | Le padding du nom de fichier s'adapte (min 40, tronqué si > 40) |
| SFTP-09-R3 | La vitesse simulée est coherente avec la taille (petits fichiers = KB/s, gros = MB/s) |

---

### 5.11 SFTP-10/11 — Corrections DEF-15/16 : `lmkdir` et Ctrl+D

| ID | Requirement |
|---|---|
| SFTP-10-R1 | Implémenter `case 'lmkdir'` dans `SftpSubShell.processLine` |
| SFTP-10-R2 | `lmkdir <path>` crée le répertoire local via `localVfs.mkdir` ou `mkdirp` |
| SFTP-11-R1 | Ctrl+D dans `SftpSubShell.handleKey` doit déclencher la sortie (appeler `session.disconnect()`, retourner `{ exit: true }`) |

---

### 5.12 SFTP-12 — Correction DEF-17 : parsing des flags CLI

#### Comportement attendu

```
sftp> ls -la /home/alice
sftp> get -r remotedir/
sftp> put -p localfile.txt
```

| ID | Requirement |
|---|---|
| SFTP-12-R1 | `SftpSubShell.processLine` sépare les flags (tokens commençant par `-`) des arguments positionnels pour `ls`, `get`, `put` |
| SFTP-12-R2 | `ls` : supporter `-l` (format long), `-a` (fichiers cachés), `-1` (un par ligne) |
| SFTP-12-R3 | `get` : flag `-r` déclenche un téléchargement récursif de répertoire |
| SFTP-12-R4 | `put` : flag `-r` déclenche un envoi récursif de répertoire |
| SFTP-12-R5 | Les flags non supportés sont ignorés silencieusement (pas d'erreur) |

---

### 5.13 SFTP-13 — Corrections adaptateur Windows (DEF-19/20/21)

| ID | Requirement |
|---|---|
| SFTP-13-R1 | `sftpToWin` : les chemins SFTP sans lettre de lecteur (`/foo/bar`) doivent être rejetés ou documentés explicitement comme mappés sur `C:\` |
| SFTP-13-R2 | `winToSftp` : la racine d'un lecteur `C:\` doit retourner `/C:/` (avec slash final) |
| SFTP-13-R3 | `WindowsSftpFSAdapter.rename` gère les répertoires : si src est un répertoire, utiliser `wfs.renameEntry` ou équivalent |

---

### 5.14 SFTP-14/15 — `chmod` et `chown` en session interactive

#### Comportement attendu

```
sftp> chmod 644 report.txt
Changing mode on /home/alice/report.txt

sftp> chown 1001 report.txt
Changing owner on /home/alice/report.txt
```

| ID | Requirement |
|---|---|
| SFTP-14-R1 | Ajouter `chmod <mode_octal> <path>` dans `SftpSubShell` |
| SFTP-14-R2 | Ajouter l'opération `setstat` dans `SftpServerHandler` pour modifier les permissions |
| SFTP-14-R3 | `ISftpFileSystem.setPermissions(path, mode)` : méthode ajoutée |
| SFTP-15-R1 | Ajouter `chown <uid> <path>` dans `SftpSubShell` |
| SFTP-15-R2 | `ISftpFileSystem.setOwner(path, uid, gid)` : méthode ajoutée |

---

### 5.15 SFTP-16 — `stat` — attributs de fichier

#### Comportement attendu

```
sftp> stat report.txt
  File: /home/alice/report.txt
  Size: 1024
  Mode: 0644   UID: 1000   GID: 1000
  Access: Mon May  5 10:23:15 2026
  Modify: Mon May  5 10:23:15 2026
```

| ID | Requirement |
|---|---|
| SFTP-16-R1 | Ajouter `stat <path>` dans `SftpSubShell` |
| SFTP-16-R2 | Ajouter l'opération `stat` dans `SftpServerHandler` |
| SFTP-16-R3 | `ISftpFileSystem.stat(path)` retourne les attributs complets |

---

### 5.16 SFTP-17 — `df` — espace disque

#### Comportement attendu

```
sftp> df -h /home/alice
        Size         Used        Avail       (root)    %Capacity
       19.6GB        4.2GB       14.3GB       14.3GB         21%
```

| ID | Requirement |
|---|---|
| SFTP-17-R1 | Ajouter `df [-h] [path]` dans `SftpSubShell` |
| SFTP-17-R2 | Retourner des valeurs simulées cohérentes (capacité totale, utilisée, disponible) |
| SFTP-17-R3 | Flag `-h` : format humain (GB/MB), sans flag : blocs de 1K |

---

### 5.17 SFTP-18/19 — Expansion `~` et port custom

| ID | Requirement |
|---|---|
| SFTP-18-R1 | `SftpSession.get/put/cd` résout `~` en répertoire home local ou distant selon le contexte |
| SFTP-18-R2 | `SftpSubShell` résout `~` dans tous les arguments de chemin avant de les passer à `SftpSession` |
| SFTP-19-R1 | `sftp -P <port> user@host` passe le port à `tcpConnector(host, port)` |
| SFTP-19-R2 | `SftpSession.connect` accepte un paramètre `port` optionnel (défaut : 22) |

---

### 5.18 SFTP-20 — Contrôle de permissions Unix côté serveur

#### Comportement attendu

```
sftp> get /etc/shadow
Fetching /etc/shadow to shadow
remote open("/etc/shadow"): Permission denied
```

| ID | Requirement |
|---|---|
| SFTP-20-R1 | `SftpServerHandler` connait l'uid/gid de l'utilisateur authentifié |
| SFTP-20-R2 | Pour `get`, vérifier les permissions de lecture (read bit) selon uid/gid de l'utilisateur |
| SFTP-20-R3 | Pour `put`, vérifier les permissions d'écriture sur le répertoire parent |
| SFTP-20-R4 | Pour `rm/rmdir`, vérifier les permissions d'écriture sur le répertoire parent |
| SFTP-20-R5 | `root` (uid=0) contourne toutes les vérifications de permissions |
| SFTP-20-R6 | `ISftpFileSystem.checkReadPermission(path, uid, gid)` et `checkWritePermission(path, uid, gid)` |

---

## 6. Plan d'Implémentation

### 6.1 Stratégie

L'implémentation se déroule en **4 phases séquentielles**, chacune livrable et testable indépendamment. Chaque phase se termine par une suite de tests unitaires complète.

La règle de priorisation : d'abord corriger les **bugs visibles** (DEF-BLOQUANT), ensuite construire la **couche SSH** de bas en haut, puis enrichir SFTP, enfin ajouter les **fonctionnalités avancées**.

---

### 6.2 Phase 1 — Corrections SFTP immédiates (sans SSH)

**Objectif** : Corriger tous les bugs BLOQUANT et MAJEUR de l'implémentation existante sans refactoring architectural. Ces corrections sont indépendantes de la couche SSH et apportent de la valeur immédiatement.

**Durée estimée** : 1-2 sessions

| Tâche | DEF / Req | Fichier(s) cible |
|---|---|---|
| 1.1 Fermer la connexion TCP après auth failure | DEF-11, SFTP-08 | `SftpSession.ts` |
| 1.2 `put` vérifie le retour de `writeFile` | DEF-06, SFTP-03 | `SftpServerHandler.ts`, `ISftpFileSystem.ts` |
| 1.3 `mkdir` utilise `mkdir` non-récursif | DEF-07, SFTP-04 | `SftpServerHandler.ts`, `ISftpFileSystem.ts`, adapters |
| 1.4 `rename` protège la destination existante | DEF-08, SFTP-05 | `SftpServerHandler.ts` |
| 1.5 Implémenter `lmkdir` dans `SftpSubShell` | DEF-15, SFTP-10 | `SftpSubShell.ts` |
| 1.6 Ctrl+D quitte le sous-shell sftp | DEF-16, SFTP-11 | `SftpSubShell.ts` |
| 1.7 Parser les flags dans `ls`, `get`, `put` | DEF-17, SFTP-12 | `SftpSubShell.ts`, `SftpSession.ts` |
| 1.8 Corriger les messages d'erreur | DEF-10, SFTP-07 | `SftpSession.ts` |
| 1.9 Format de progression réaliste | DEF-14, SFTP-09 | `SftpSession.ts` |
| 1.10 Corriger adaptateur Windows (paths, rename) | DEF-19/20/21, SFTP-13 | `WindowsSftpAdapter.ts` |
| 1.11 Expansion `~` dans les chemins | DEF-13, SFTP-18 | `SftpSubShell.ts`, `SftpSession.ts` |

**Critere de done** : Les 24 défauts de la section 2 sont corrigés. Les tests existants (`sftp.test.ts`, `sftp-wan.test.ts`, `sftp-edge-cases.test.ts`) passent tous. De nouveaux tests couvrent les corrections.

---

### 6.3 Phase 2 — Couche SSH simulée (transport + auth)

**Objectif** : Implémenter la couche SSH visible : version banner, host key, verification `known_hosts`, authentification mot de passe et clé publique. C'est le coeur du projet.

**Durée estimée** : 3-4 sessions

#### 6.3.1 Sous-phase 2a — Infrastructure SSH

| Tâche | Req | Nouveaux fichiers |
|---|---|---|
| 2a.1 `SshHostKey` — génération et stockage du host key par device | SSH-01-R1 | `src/network/protocols/ssh/SshHostKey.ts` |
| 2a.2 `SshKnownHosts` — lecture/écriture de `~/.ssh/known_hosts` | SSH-01-R2/4 | `src/network/protocols/ssh/SshKnownHosts.ts` |
| 2a.3 `SshConfig` — parser de `~/.ssh/config` | SSH-06-R1/5 | `src/network/protocols/ssh/SshConfig.ts` |
| 2a.4 `SshKeyPair` — génération et stockage ED25519 (simulé) | SSH-03-R1/3 | `src/network/protocols/ssh/SshKeyPair.ts` |
| 2a.5 `SshAuthorizedKeys` — lecture/écriture `~/.ssh/authorized_keys` | SSH-03-R6/7 | `src/network/protocols/ssh/SshAuthorizedKeys.ts` |

#### 6.3.2 Sous-phase 2b — Client SSH (`SshSession`)

| Tâche | Req | Fichier |
|---|---|---|
| 2b.1 `SshSession.connect(userAtHost, opts)` — orchestration complète | SSH-01, SSH-02 | `src/network/protocols/ssh/SshSession.ts` |
| 2b.2 Vérification host key + prompt yes/no | SSH-01-R2/5 | `SshSession.ts` |
| 2b.3 Authentification par mot de passe (3 tentatives) | SSH-02-R1/5 | `SshSession.ts` |
| 2b.4 Authentification par clé publique | SSH-03-R6/9 | `SshSession.ts` |
| 2b.5 Gestion avertissement host key change (`@@@`) | SSH-01-R7 | `SshSession.ts` |

#### 6.3.3 Sous-phase 2c — Serveur SSH (`SshServerHandler`)

| Tâche | Req | Fichier |
|---|---|---|
| 2c.1 `SshServerHandler` — écoute TCP 22 sur chaque device | SSH-07-R1/2 | `src/network/protocols/ssh/SshServerHandler.ts` |
| 2c.2 Auth mot de passe côté serveur | SSH-02-R1/7 | `SshServerHandler.ts` |
| 2c.3 Auth clé publique (`authorized_keys`) côté serveur | SSH-03-R6 | `SshServerHandler.ts` |
| 2c.4 MOTD + `Last login` | SSH-02-R2/3 | `SshServerHandler.ts` |
| 2c.5 `PermitRootLogin`, `PasswordAuthentication` dans `sshd_config` | SSH-07-R5 | `SshServerHandler.ts` |

#### 6.3.4 Sous-phase 2d — Commandes SSH

| Tâche | Req | Fichier |
|---|---|---|
| 2d.1 `ssh user@host` — session interactive (shell distant) | SSH-04 | `LinuxTerminalSession.ts` |
| 2d.2 `ssh user@host <cmd>` — commande non-interactive | SSH-05 | `LinuxTerminalSession.ts` |
| 2d.3 `ssh-keygen` — génération de paire de clés | SSH-03-R1/4 | `LinuxCommandExecutor.ts` |
| 2d.4 `ssh-copy-id` — déploiement de clé publique | SSH-03-R5 | `LinuxCommandExecutor.ts` |

**Critere de done** : `ssh user@host` produit la séquence complète (fingerprint, password prompt, shell distant, exit). Les tests couvrent : host key inconnu, connu, changé ; auth mot de passe ok/ko ; auth clé publique ; limite de tentatives ; session interactive.

---

### 6.4 Phase 3 — SFTP sur SSH

**Objectif** : Migrer `sftp` pour utiliser `SshSession` comme transport. Du point de vue de l'utilisateur, lancer `sftp` produit la même séquence SSH avant d'entrer dans le sous-shell.

**Durée estimée** : 1-2 sessions

| Tâche | Req | Fichier(s) cible |
|---|---|---|
| 3.1 `SftpSession` utilise `SshSession` pour l'établissement | SFTP-01 | `SftpSession.ts` |
| 3.2 `sftp -P`, `sftp -i`, `sftp -o` transmis à `SshSession` | SFTP-01-R2/4 | `LinuxTerminalSession.ts`, `SftpSession.ts` |
| 3.3 Ajouter `ls -l` avec attributs complets | SFTP-06 | `SftpSession.ts`, `SftpServerHandler.ts`, adapters |
| 3.4 Ajouter `chmod`, `chown` | SFTP-14/15 | `SftpSubShell.ts`, `SftpServerHandler.ts`, adapters |
| 3.5 Ajouter `stat` | SFTP-16 | `SftpSubShell.ts`, `SftpServerHandler.ts`, adapters |
| 3.6 Ajouter `df` | SFTP-17 | `SftpSubShell.ts`, `SftpServerHandler.ts` |
| 3.7 Contrôle de permissions Unix | SFTP-20 | `SftpServerHandler.ts`, `ISftpFileSystem.ts`, adapters |
| 3.8 Port custom `-P` | SFTP-19 | `SftpSession.ts`, `LinuxTerminalSession.ts` |

**Critere de done** : `sftp user@host` affiche le fingerprint SSH, demande le mot de passe, puis entre dans le sous-shell. `ls -l` affiche les attributs. `chmod 644 file.txt` modifie les permissions. Les fichiers root-only retournent `Permission denied`.

---

### 6.5 Phase 4 — `scp` et fonctionnalités avancées

**Objectif** : Implémenter `scp`, affiner les comportements edge-case, et ajouter les fonctionnalités `~/.ssh/config`.

**Durée estimée** : 1-2 sessions

| Tâche | Req | Fichier(s) cible |
|---|---|---|
| 4.1 `scp local user@host:remote` | SSH-08-R1 | `LinuxCommandExecutor.ts` / `LinuxTerminalSession.ts` |
| 4.2 `scp user@host:remote local` | SSH-08-R2 | idem |
| 4.3 `scp -r` récursif | SSH-08-R3 | idem |
| 4.4 `~/.ssh/config` — Host aliases et directives | SSH-06 | `SshConfig.ts`, `SshSession.ts` |
| 4.5 Gestion `AllowUsers` dans `sshd_config` | SSH-07-R5 | `SshServerHandler.ts` |
| 4.6 `systemctl restart sshd` relit la config | SSH-07-R6 | `LinuxCommandExecutor.ts` |
| 4.7 `/etc/motd`, `/etc/issue.net` | SSH-07-R7/8 | `SshServerHandler.ts` |
| 4.8 Transfert récursif `sftp get/put -r` | SFTP-12-R3/4 | `SftpSession.ts`, `SftpSubShell.ts` |

**Critere de done** : `scp file.txt user@host:/tmp/` copie le fichier avec barre de progression. `~/.ssh/config` avec `Host prod` permet de taper `ssh prod`. `systemctl restart sshd` applique un changement de `PasswordAuthentication no`.

---

### 6.6 Matrice de couverture des défauts

| DEF | Description courte | Phase | Statut |
|---|---|---|---|
| DEF-01 | Pas de couche SSH | 2 | A faire |
| DEF-02 | Op `auth` non-standard | 2 | A faire |
| DEF-03 | Pas de host key verification | 2 | A faire |
| DEF-04 | Transfert atomique | 3 | Partiel (simulé) |
| DEF-05 | Binaire non supporté | 3 | Partiel (base64 encoding) |
| DEF-06 | `put` ignore erreurs | 1 | A faire |
| DEF-07 | `mkdir` mkdirp | 1 | A faire |
| DEF-08 | `rename` ecrase | 1 | A faire |
| DEF-09 | `ls` sans attributs | 3 | A faire |
| DEF-10 | Messages erreur incorrects | 1 | A faire |
| DEF-11 | TCP orphelin apres auth failure | 1 | A faire |
| DEF-12 | Port hardcode a 22 | 3 | A faire |
| DEF-13 | Pas d'expansion `~` | 1 | A faire |
| DEF-14 | Format progression incorrect | 1 | A faire |
| DEF-15 | `lmkdir` absent | 1 | A faire |
| DEF-16 | Ctrl+D ne quitte pas | 1 | A faire |
| DEF-17 | Flags non parses | 1 | A faire |
| DEF-18 | Commandes manquantes | 3 | A faire |
| DEF-19 | Windows paths relatifs C: | 1 | A faire |
| DEF-20 | Windows root slash manquant | 1 | A faire |
| DEF-21 | Windows rename dirs | 1 | A faire |
| DEF-22 | Pas de check permissions | 3 | A faire |
| DEF-23 | Pas de cle publique | 2 | A faire |
| DEF-24 | Stub sftp executor cassé | 2 | A faire |

---

## 7. Contraintes Techniques et NFR

### 7.1 Contraintes architecturales

#### C-01 — Synchronicité du simulateur

Le simulateur utilise une livraison de frames **synchrone** : quand `cable.sendFrame()` est appelé, la frame traverse tout le réseau (switches, routeurs, host distant) avant que l'appel retourne. Cela permet des tests sans async/await complexe.

La couche SSH simulée **doit** respecter cette contrainte :
- Pas de véritables workers ou setTimeout dans le chemin critique
- `SshSession.connect()` est `async` uniquement pour la résolution ARP (1 microtask) — comme l'est déjà `SftpSession.connect()`
- Les "négociations" SSH (key exchange, etc.) sont simulées comme des échanges synchrones sur la connexion TCP in-memory

#### C-02 — Pas de vraie cryptographie

Le simulateur ne doit PAS importer de librairies cryptographiques (WebCrypto, libsodium, node:crypto) pour SSH. Les clés ED25519 sont des strings opaques déterministes (ex: hash de l'IP). Le fingerprint est calculé avec un hash simple (SHA-256 simulé ou déterministe). L'objectif est le comportement visible, pas la sécurité réelle.

#### C-03 — Stockage dans VirtualFileSystem

Tous les fichiers SSH (`~/.ssh/known_hosts`, `~/.ssh/id_ed25519`, `~/.ssh/config`, `/etc/ssh/sshd_config`, `/etc/motd`) doivent être stockés dans le `VirtualFileSystem` du device concerné. Ils sont donc editables via `vim`, `nano`, `cat`, `echo >` comme sur un vrai système.

#### C-04 — Independance des devices

Chaque device (`LinuxMachine`, `WindowsPC`) gere son propre état SSH de manière autonome. Pas de registre central SSH. Le host key d'un device est stocké dans son `VirtualFileSystem` sous `/etc/ssh/`.

#### C-05 — Compatibilite avec les tests existants

Les 127 tests existants (`sftp.test.ts`, `sftp-wan.test.ts`, `sftp-edge-cases.test.ts`) doivent continuer à passer sans modification significative. La refonte SSH introduit un wrapper au-dessus du transport TCP existant, sans casser l'interface `TcpConnection`.

---

### 7.2 Non-Functional Requirements

#### NFR-01 — Performance

| Metrique | Exigence |
|---|---|
| Etablissement de connexion SSH | < 5ms (synchrone, pas de vraie crypto) |
| Transfert d'un fichier 1MB | < 10ms (in-memory) |
| Cold start suite de tests | < 3s (identique à l'existant) |

#### NFR-02 — Couverture de tests

| Module | Couverture minimale |
|---|---|
| `SshHostKey.ts` | 90% |
| `SshKnownHosts.ts` | 90% |
| `SshSession.ts` | 85% |
| `SshServerHandler.ts` | 85% |
| `SftpSession.ts` (après corrections) | 90% |
| `SftpServerHandler.ts` (après corrections) | 90% |
| `SftpSubShell.ts` (après corrections) | 85% |
| Adaptateurs Linux/Windows | 85% |

#### NFR-03 — Réalisme comportemental

Chaque interaction visible doit être validée contre le comportement OpenSSH réel (Ubuntu 22.04, OpenSSH 9.6). Les tests BDD décrivent les séquences exactes de commandes et les sorties attendues, copiées ou vérifiées sur un vrai système.

#### NFR-04 — Maintenabilité

- Chaque module SSH/SFTP est isolé dans `src/network/protocols/ssh/` ou `src/network/protocols/sftp/`
- Les interfaces (`ISshServer`, `ISshClient`, `ISftpFileSystem`) permettent de swapper les implémentations Linux/Windows sans changer le code de session
- Pas de couplage direct entre `SshSession` et les classes concrètes de devices

#### NFR-05 — Retrocompatibilite

- L'interface `TcpConnection` est inchangée
- Les devices existants (`LinuxPC`, `LinuxServer`, `WindowsPC`) acquièrent le support SSH/SFTP par composition, sans modification de leur interface publique

---

### 7.3 Fichiers et répertoires créés par l'implémentation

#### Structure du code source

```
src/network/protocols/
  ssh/
    SshHostKey.ts          -- Génération et stockage du host key par device
    SshKnownHosts.ts       -- Lecture/écriture ~/.ssh/known_hosts
    SshConfig.ts           -- Parser ~/.ssh/config
    SshKeyPair.ts          -- Génération paire de clés ED25519 simulée
    SshAuthorizedKeys.ts   -- Lecture/écriture ~/.ssh/authorized_keys
    SshSession.ts          -- Client SSH (connect, auth, exec, sftp-subsystem)
    SshServerHandler.ts    -- Serveur SSH (enregistré sur TCP 22)
    ISshServer.ts          -- Interface serveur SSH
  sftp/
    (fichiers existants, modifiés)
    ISftpFileSystem.ts     -- Interface enrichie (mkdir non-récursif, setPermissions, stat...)
    SftpSession.ts         -- Refactored (utilise SshSession)
    SftpServerHandler.ts   -- Refactored (corrections DEF-06 à DEF-09)
    SftpSubShell.ts        -- Refactored (lmkdir, Ctrl+D, flags, chmod, chown, stat, df)
```

#### Fichiers système créés dans VirtualFileSystem à l'initialisation du device

```
/etc/ssh/
  sshd_config              -- Configuration du serveur SSH
  ssh_host_ed25519_key     -- Clé privée du serveur (simulée)
  ssh_host_ed25519_key.pub -- Clé publique du serveur

/etc/motd                  -- Message of the Day (optionnel, vide par défaut)
/etc/issue.net             -- Bannière pre-auth (optionnel)

~/.ssh/                    -- Dans le home de chaque utilisateur
  known_hosts              -- Créé lors du premier connect
  authorized_keys          -- Créé par ssh-copy-id
  config                   -- Créé manuellement par l'utilisateur
  id_ed25519               -- Créé par ssh-keygen
  id_ed25519.pub           -- Créé par ssh-keygen
```

---

### 7.4 Risques et mitigations

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| La synchronicité du simulateur casse avec les interactions SSH multi-step | Moyenne | Elevé | Utiliser le mécanisme `InteractiveStep` déjà en place dans `LinuxTerminalSession` pour les prompts (fingerprint, password) |
| Les tests existants cassent après refactoring SFTP | Faible | Elevé | Phase 1 isolée : corriger sans toucher à l'architecture ; ajouter les tests de régression avant tout refactoring |
| Complexité du parser `~/.ssh/config` | Faible | Faible | Parser minimaliste couvrant les 5 directives prioritaires seulement |
| Incohérence comportementale Windows vs Linux SSH | Moyenne | Moyen | Définir un `ISshServer` commun ; tester les deux adapters séparément |
| Performance dégradée avec beaucoup de clés dans known_hosts | Très faible | Faible | Recherche linéaire acceptable pour un simulateur (< 100 entrées) |

---

## Annexe A — Exemples de séquences complètes à implémenter

### A.1 Premier connect SSH sur host inconnu

```
user@local:~$ ssh alice@192.168.1.10
The authenticity of host '192.168.1.10 (192.168.1.10)' can't be established.
ED25519 key fingerprint is SHA256:xLp3K1mNqRtU2vWzY0hBjCfD8gEsA9oP4iQe7nMkXcV.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
Warning: Permanently added '192.168.1.10' (ED25519) to the list of known hosts.
alice@192.168.1.10's password: xxxxxxxx
Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)
Last login: Mon May  4 10:23:15 2026 from 192.168.1.5
alice@server:~$ exit
logout
Connection to 192.168.1.10 closed.
user@local:~$
```

### A.2 Authentification par clé publique

```
user@local:~$ ssh-keygen -t ed25519 -C "alice@local"
Generating public/private ed25519 key pair.
Enter file in which to save the key (/root/.ssh/id_ed25519): 
Enter passphrase (empty for no passphrase): 
Enter same passphrase again: 
Your identification has been saved in /root/.ssh/id_ed25519
Your public key has been saved in /root/.ssh/id_ed25519.pub
The key fingerprint is:
SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef alice@local
The key's randomart image is:
+--[ED25519 256]--+
|        .o+o.    |
|       ..=+o     |
+----[SHA256]-----+

user@local:~$ ssh-copy-id alice@192.168.1.10
/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s)
alice@192.168.1.10's password: xxxxxxxx
Number of key(s) added: 1

Now try logging into the machine, with:   "ssh 'alice@192.168.1.10'"

user@local:~$ ssh alice@192.168.1.10
alice@server:~$
```

### A.3 Session SFTP avec attributs et permissions

```
user@local:~$ sftp alice@192.168.1.10
alice@192.168.1.10's password: xxxxxxxx
Connected to 192.168.1.10.
sftp> ls -l
drwxr-xr-x    2 alice    alice        4096 May 05 10:20 documents
-rw-r--r--    1 alice    alice        1399 May 05 10:23 report.txt
sftp> chmod 600 report.txt
Changing mode on /home/alice/report.txt
sftp> get /etc/shadow
Fetching /etc/shadow to shadow
remote open("/etc/shadow"): Permission denied
sftp> bye
```

### A.4 `scp` avec progression

```
user@local:~$ scp report.pdf alice@192.168.1.10:/home/alice/
alice@192.168.1.10's password: xxxxxxxx
report.pdf                                   100% 2048KB   2.0MB/s   00:01
user@local:~$
```

---
