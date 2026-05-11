# SSH dans Ubuntu Sandbox — Petit Tutoriel

> **À qui s'adresse ce tutoriel ?**
> À toute personne qui veut se connecter d'une machine à une autre dans le simulateur, transférer des fichiers, gérer des clés SSH, ou simplement comprendre comment fonctionne le « petit OpenSSH » embarqué.
> Pas besoin d'expertise — on part de zéro et on monte progressivement. 🔑

---

## Table des matières

1. [Vue d'ensemble en 60 secondes](#1-vue-densemble-en-60-secondes)
2. [Premier login : PC1 → PC2](#2-premier-login--pc1--pc2)
3. [Authentification par clé publique](#3-authentification-par-clé-publique)
4. [Transférer des fichiers (sftp et scp)](#4-transférer-des-fichiers-sftp-et-scp)
5. [Configuration côté client `~/.ssh/config`](#5-configuration-côté-client-sshconfig)
6. [Configuration côté serveur `/etc/ssh/sshd_config`](#6-configuration-côté-serveur-etcsshsshd_config)
7. [Sécurité et journalisation](#7-sécurité-et-journalisation)
8. [Dépannage rapide](#8-dépannage-rapide)
9. [Cheat sheet](#9-cheat-sheet)

---

## 1. Vue d'ensemble en 60 secondes

Chaque machine Linux du simulateur (`LinuxPC`, `LinuxServer`) démarre **sshd** automatiquement sur le port 22 à la mise sous tension. Tu n'as rien à activer.

Un utilisateur par défaut est créé : **`user`** / mot de passe **`admin`**.

L'implémentation est fidèle à OpenSSH pour les comportements qui comptent au quotidien :

- Authentification **par mot de passe** ou **par clé publique** (ed25519)
- Fichiers réels dans le VFS : `/etc/ssh/sshd_config`, `~/.ssh/config`, `~/.ssh/known_hosts`, `~/.ssh/authorized_keys`, `/var/log/auth.log`
- Commandes complètes : `ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-copy-id`
- Sous-systèmes : protection anti-brute-force, événements observables, conformité avec les directives `sshd_config`

Ce qui n'est pas modélisé : la cryptographie réelle (les clés sont déterministes pour la reproductibilité), le port forwarding (`-L`, `-R`, `-D`), l'agent SSH, X11 forwarding.

---

## 2. Premier login : PC1 → PC2

### 2.1 Construire le LAN

Place deux `LinuxPC` (PC1 et PC2) et un `GenericSwitch` sur le canvas, relie-les avec des câbles. Configure les IPs depuis le terminal de chaque PC :

```bash
# Sur PC1
sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0

# Sur PC2
sudo ifconfig eth0 10.0.0.2 netmask 255.255.255.0
```

Vérifie la connectivité :

```bash
# Sur PC1
ping -c 1 10.0.0.2
```

### 2.2 Se connecter

Toujours depuis PC1 :

```bash
ssh user@10.0.0.2
```

Tu vas voir :

```
user@10.0.0.2's password:
```

Tape `admin` puis Enter. Bienvenue sur PC2 :

```
Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)
user@PC2:~$
```

Le prompt change : tu es bien sur la machine distante. Toutes les commandes (`ls`, `cd`, `cat`, `ip addr`, `systemctl status nginx`…) s'exécutent là-bas. Pour quitter :

```bash
exit
# ou Ctrl+D
```

> 💡 **Astuce** : à la première connexion, OpenSSH te demanderait normalement *« The authenticity of host 'x.x.x.x' can't be established… »*. Par défaut on est en mode `accept-new` (silencieux). Pour voir le prompt, ajoute `-o StrictHostKeyChecking=yes`.

### 2.3 Lancer une commande sans ouvrir de session

```bash
ssh user@10.0.0.2 hostname
# linux-pc

ssh user@10.0.0.2 'ls -la /var/log | head -5'
```

C'est l'équivalent du *one-shot exec* : la commande s'exécute à distance, la sortie revient, la session se ferme.

---

## 3. Authentification par clé publique

Le mot de passe c'est bien, mais une clé c'est plus sûr et plus pratique. La procédure est exactement la même que sur un vrai Linux.

### 3.1 Générer une paire de clés

Sur PC1 :

```bash
ssh-keygen -t ed25519
```

Tu peux laisser le chemin par défaut (`~/.ssh/id_ed25519`) et la passphrase vide (Enter, Enter). Résultat :

```
Your identification has been saved in /home/user/.ssh/id_ed25519
Your public key has been saved in /home/user/.ssh/id_ed25519.pub
The key fingerprint is:
SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx user@PC1
```

> 🔍 **Vérifie** : `cat ~/.ssh/id_ed25519.pub` affiche ta clé publique. Permissions : la privée est `0600`, la publique `0644`, `~/.ssh` est `0700` — comme sur un vrai OpenSSH.

### 3.2 Installer la clé sur PC2

```bash
ssh-copy-id user@10.0.0.2
```

Tu rentres le mot de passe **une seule fois**. La commande crée `/home/user/.ssh/authorized_keys` sur PC2 et y ajoute ta clé publique. Si la clé y est déjà, l'opération est idempotente.

### 3.3 Tester

```bash
ssh user@10.0.0.2
```

Tu es connecté **sans saisir de mot de passe**. La résolution se fait via `AuthChain` qui essaie d'abord les clés publiques disponibles ; si une marche, le mot de passe n'est jamais demandé.

---

## 4. Transférer des fichiers (sftp et scp)

### 4.1 SCP — copie ponctuelle

Du local vers le distant :

```bash
scp /home/user/rapport.txt user@10.0.0.2:/tmp/
```

Et l'inverse :

```bash
scp user@10.0.0.2:/etc/hostname /tmp/
```

Le `-r` copie récursivement un répertoire :

```bash
scp -r /home/user/projet user@10.0.0.2:/home/user/
```

### 4.2 SFTP — session interactive

```bash
sftp user@10.0.0.2
```

Tu obtiens un prompt `sftp>`. Les commandes utiles :

| Commande           | Effet                                                 |
|--------------------|-------------------------------------------------------|
| `ls` / `lls`       | Liste le répertoire distant / local                   |
| `pwd` / `lpwd`     | Affiche le CWD distant / local                        |
| `cd` / `lcd`       | Change le CWD distant / local                         |
| `get fichier`      | Télécharge `fichier` vers le local                    |
| `put fichier`      | Envoie le `fichier` local vers le distant             |
| `mkdir nom`        | Crée un répertoire distant                            |
| `rm` / `rmdir`     | Supprime fichier / répertoire distant                 |
| `rename a b`       | Renomme `a` en `b` côté distant                       |
| `chmod 600 nom`    | Change les permissions                                |
| `stat nom`         | Affiche les attributs (mode, owner, taille…)          |
| `df`               | Espace disque distant                                 |
| `clear`            | Vide l'écran                                          |
| `exit` / `quit`    | Quitte la session                                     |

Exemple complet :

```
sftp> put /home/user/photo.png
Uploading /home/user/photo.png to /home/user/photo.png
sftp> ls
photo.png   rapport.txt
sftp> chmod 600 photo.png
sftp> quit
```

> ⚠️ **Permissions** : SFTP applique les permissions POSIX (`PermissionCheckingFSDecorator`). Si tu essaies d'écrire dans `/etc/` en tant qu'utilisateur normal, tu auras `Permission denied` — comme en vrai.

---

## 5. Configuration côté client `~/.ssh/config`

Tu peux définir des alias et des options par défaut par hôte. Crée le fichier `~/.ssh/config` :

```
Host pc2
    HostName 10.0.0.2
    User user
    Port 22
    IdentityFile ~/.ssh/id_ed25519

Host *.lab
    User admin
    StrictHostKeyChecking accept-new
```

Ensuite :

```bash
ssh pc2
# équivalent à : ssh -i ~/.ssh/id_ed25519 user@10.0.0.2 -p 22
```

Les options CLI (`-p`, `-i`, `-o`) écrasent celles du fichier — ordre OpenSSH classique.

---

## 6. Configuration côté serveur `/etc/ssh/sshd_config`

Le fichier est créé à la première mise sous tension. Voici les directives reconnues :

### 6.1 Authentification

| Directive                       | Défaut | Effet                                                      |
|---------------------------------|--------|------------------------------------------------------------|
| `PermitRootLogin yes\|no`       | `no`   | Autorise `ssh root@host`                                   |
| `PasswordAuthentication yes\|no`| `yes`  | Active l'auth par mot de passe                             |
| `PubkeyAuthentication yes\|no`  | `yes`  | Active l'auth par clé publique                             |
| `PermitEmptyPasswords yes\|no`  | `no`   | Accepte les mots de passe vides (à éviter !)               |
| `MaxAuthTries N`                | `6`    | Nombre de tentatives par connexion                         |

### 6.2 Contrôle d'accès

| Directive              | Effet                                                                          |
|------------------------|--------------------------------------------------------------------------------|
| `AllowUsers a b c`     | Seuls ces utilisateurs peuvent se connecter (joker `*` accepté)                |
| `DenyUsers x y`        | Liste de refus prioritaire sur `AllowUsers`                                    |
| `AllowGroups admins`   | L'utilisateur doit appartenir à au moins un groupe listé                       |
| `DenyGroups locked`    | Refuse si membre de l'un de ces groupes                                        |

L'ordre d'évaluation : `DenyUsers` → `AllowUsers` → `DenyGroups` → `AllowGroups` → `PermitRootLogin`.

### 6.3 Réseau et keep-alive

| Directive                | Défaut | Effet                                                |
|--------------------------|--------|------------------------------------------------------|
| `Port N`                 | `22`   | Port d'écoute                                        |
| `LoginGraceTime 120`     | `120`  | Délai d'auth en secondes (`30`, `2m`, `1h` ok)       |
| `ClientAliveInterval N`  | `0`    | Période des sondes keepalive                         |
| `ClientAliveCountMax 3`  | `3`    | Sondes ratées avant déconnexion                      |
| `MaxSessions 10`         | `10`   | Sessions simultanées par connexion                   |

### 6.4 Logs et bannière

| Directive               | Effet                                                            |
|-------------------------|------------------------------------------------------------------|
| `LogLevel INFO`         | Niveau de verbosité (`QUIET`…`DEBUG3`)                           |
| `SyslogFacility AUTH`   | Catégorie syslog                                                 |
| `Banner /etc/issue.net` | Texte affiché **avant** le prompt d'auth                         |

### 6.5 Recharger la configuration

Éditer ne suffit pas — il faut le notifier à sshd :

```bash
sudo systemctl restart sshd
# ou
sudo systemctl reload sshd
```

> 🔄 Sous le capot, `LinuxSshServerContext.reloadConfig()` relit `/etc/ssh/sshd_config` et reconstruit le contexte avec les nouvelles règles ; les connexions en cours ne sont **pas** affectées, seules les nouvelles.

---

## 7. Sécurité et journalisation

### 7.1 `/var/log/auth.log`

Chaque événement d'authentification est tracé au format OpenSSH :

```
May 11 13:45:23 linux-pc sshd[12345]: Connection from 10.0.0.1 port 22 on linux-pc port 22
May 11 13:45:23 linux-pc sshd[12345]: Accepted password for user from 10.0.0.1 port 22 ssh2
May 11 13:45:23 linux-pc sshd[12345]: pam_unix(sshd:session): session opened for user user
May 11 13:45:30 linux-pc sshd[12345]: pam_unix(sshd:session): session closed for user user
```

Pour suivre en direct :

```bash
ssh user@10.0.0.2 'tail -f /var/log/auth.log'
```

Les types de lignes produites :

- `Accepted <method> for <user>` — connexion réussie
- `Failed <method> for <user>` — mauvais mot de passe / clé
- `Invalid user <user>` — utilisateur inexistant
- `Refusing connection from <ip>` — throttler actif
- `pam_unix(sshd:session): session opened/closed` — par canal exec/shell

### 7.2 Throttler anti-brute-force

Par défaut, **5 échecs d'auth depuis la même IP dans une fenêtre de 60s** déclenchent un blocage de 5 minutes. La nouvelle tentative est refusée d'emblée, **même avec le bon mot de passe**, et une ligne `Refusing connection from <ip>: 5 authentication failures` apparaît dans `auth.log`.

Le composant est observable via le bus d'événements (`auth_throttled`) — pratique si tu veux ajouter un dashboard ou un script de réaction.

### 7.3 Bus d'événements (pour les développeurs)

Tout passe par `SshServerEventBus`. Les événements émis :

```
client_connected, auth_invalid_user, auth_failure, auth_success,
auth_throttled, channel_opened, channel_closed, client_disconnected
```

Tu peux brancher un subscriber maison :

```typescript
const ctx = (linuxPc as any).getSshServerContext();
const off = ctx.events.on('auth_failure', (e) => {
  console.log(`Échec auth: ${e.user} depuis ${e.ip} (${e.reason})`);
});
// off() pour se désabonner
```

---

## 8. Dépannage rapide

### « Connection refused »
- L'IP n'est pas atteignable. Teste `ping`.
- Le port 22 du serveur est-il libre ? `ss -tln` sur le serveur.

### « Permission denied (publickey,password) »
- Mauvais mot de passe **ou** clé non installée dans `authorized_keys`.
- `PasswordAuthentication no` côté serveur ? Vérifie `cat /etc/ssh/sshd_config | grep PasswordAuth`.
- Compte refusé par `DenyUsers` / `AllowGroups` ? Regarde `/var/log/auth.log`.

### « Host key verification failed »
- La clé publique de l'hôte a changé (typique après reset du serveur).
- Solution : `ssh-keygen -R 10.0.0.2` côté client, ou édite `~/.ssh/known_hosts` à la main.

### Le throttler m'a bloqué
- Attends 5 minutes, ou redémarre le serveur (le state du throttler est en mémoire) :
  ```bash
  sudo systemctl restart sshd
  ```

### `ssh user@host` répond immédiatement « Connection refused » alors que sshd tourne
- L'ARP n'est probablement pas amorcé. Fais d'abord `ping -c 1 user@host`.

### Ctrl+L ne marche pas dans la session SSH
- Ça doit marcher (signal `clearScreen`). Si non, vérifie que tu es dans la sub-shell : la commande `clear` aussi fonctionne désormais.

---

## 9. Cheat sheet

```bash
# Connexion basique
ssh user@10.0.0.2

# Exec one-shot
ssh user@10.0.0.2 'hostname && uptime'

# Avec port et clé spécifiques
ssh -p 2222 -i ~/.ssh/id_ed25519 user@10.0.0.2

# Forcer un prompt pour hôte inconnu
ssh -o StrictHostKeyChecking=yes user@10.0.0.2

# Générer une clé
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""

# Déployer la clé
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@10.0.0.2

# Copier un fichier
scp file.txt user@10.0.0.2:/tmp/
scp -r dossier/ user@10.0.0.2:/tmp/

# Session SFTP
sftp user@10.0.0.2

# Recharger sshd
sudo systemctl reload sshd

# Suivre les tentatives d'auth
tail -f /var/log/auth.log
```

---

C'est tout pour ce tour d'horizon. Si tu veux pousser plus loin :

- `docs/BRD-SSH-SFTP.md` — exigences fonctionnelles complètes
- `docs/DESIGN-SSH-SFTP.md` — architecture interne (canaux, AuthChain, SFTP)
- `src/__tests__/unit/network-v2/ssh-ui-flow.test.ts` — exemples de scénarios end-to-end

Bon labo ! 🚀
