# Limites de l'implémentation du Terminal Linux dans NetSim

Ce document recense les limitations identifiées dans l'implémentation actuelle du terminal Linux et de la classe `LinuxPC`.

---

## Améliorations implémentées (2025-12-18)

Les problèmes suivants ont été **résolus** :

| Problème | Solution | Commit |
|----------|----------|--------|
| Déconnexion Terminal/LinuxPC | Les commandes réseau (`ifconfig`, `ip`, `ping`, `arp`, `route`, `hostname`) sont maintenant routées vers `LinuxPC.executeCommand()` | `41d98b4` |
| Ping toujours réussi | Le ping vérifie maintenant la validité de l'IP, l'existence d'une route, et retourne "Network is unreachable" si pas de route | `41d98b4` |
| FileSystem non partagé | Le Terminal utilise `device.getFileSystem()` quand disponible | Déjà implémenté |
| Commandes système manquantes | Ajout de `systemctl`, `journalctl`, `mount`, `lsblk`, `dmesg`, `service` | `41d98b4` |
| Boucles shell absentes | Ajout de `for`, `while`, brace expansion `{1..5}` | `9d4576a` |
| Conditions shell absentes | Ajout de `if/else/elif/fi`, `case/esac` | `9d4576a` |
| Processus statiques | `ProcessManager` dynamique avec tracking des PIDs, spawn/kill, uptime, load average | `6df7ac2` |
| Commandes réseau limitées | Ajout de `nc`, `nmap`, `tcpdump`, `telnet` + amélioration de `curl` | `02bd503` |
| SSH/SCP manquants | Ajout de `ssh`, `scp`, `sftp`, `rsync`, `ssh-keygen`, `ssh-copy-id` | `3c6a64c` |
| Here documents absents | Support `<<EOF`, `<<'EOF'`, `<<-EOF` avec expansion de variables | `7574e9f` |
| Fonctions shell absentes | Définition et appel de fonctions, arguments positionnels ($1, $@, $#), return | `7ef1471` |
| ls non compatible pipe | `ls` affiche maintenant un fichier par ligne quand pipé | À commiter |
| Arguments guillemets | Parsing correct des arguments entre guillemets dans les fonctions | À commiter |
| Expansion arithmétique | Support de `$((expr))` pour calculs arithmétiques | À commiter |
| Variables locales | Support du mot-clé `local` dans les fonctions | À commiter |

---

## Table des matières
1. [Architecture et conception](#1-architecture-et-conception)
2. [Commandes réseau](#2-commandes-réseau)
3. [Gestion des processus](#3-gestion-des-processus)
4. [Système de fichiers](#4-système-de-fichiers)
5. [Shell et fonctionnalités bash](#5-shell-et-fonctionnalités-bash)
6. [Commandes manquantes](#6-commandes-manquantes)
7. [Simulation réseau](#7-simulation-réseau)
8. [Recommandations d'amélioration](#8-recommandations-damélioration)

---

## 1. Architecture et conception

### 1.1 Déconnexion entre LinuxPC et Terminal

**Problème majeur** : Il existe deux implémentations distinctes des commandes réseau qui ne sont pas connectées :

| Composant | Fichier | Comportement |
|-----------|---------|--------------|
| `LinuxPC.executeCommand()` | `src/devices/linux/LinuxPC.ts:83-104` | Utilise `NetworkStack` réel avec état |
| `networkCommands` | `src/terminal/commands/network.ts` | Retourne des valeurs **statiques/simulées** |

**Conséquence** : Le composant Terminal de l'interface utilisateur utilise les commandes du dossier `terminal/commands/` qui retournent toujours les mêmes valeurs hardcodées, ignorant complètement l'état réseau réel du `LinuxPC`.

**Exemple** :
```typescript
// LinuxPC retourne l'état réel configuré
linuxPC.executeCommand('ifconfig eth0 10.0.0.1')  // Configure vraiment l'IP
linuxPC.executeCommand('ifconfig')                 // Affiche 10.0.0.1

// Terminal retourne toujours la même valeur statique
executeCommand('ifconfig', state, fs, pm)          // Affiche TOUJOURS 192.168.1.100
```

### 1.2 Filesystem non partagé

Chaque instance de `LinuxPC` crée son propre `FileSystem` isolé (`LinuxPC.ts:53`), mais le composant Terminal UI utilise un `FileSystem` global séparé. Les modifications de fichiers dans un contexte ne sont pas visibles dans l'autre.

---

## 2. Commandes réseau

### 2.1 Commandes avec sorties statiques

Les commandes suivantes retournent des valeurs **hardcodées** indépendamment de la configuration réelle :

| Commande | Limitation |
|----------|------------|
| `ifconfig` | Toujours affiche `192.168.1.100`, `eth0` et `lo` |
| `ip addr` | Même sortie statique que `ifconfig` |
| `ip route` | Route par défaut via `192.168.1.1` hardcodée |
| `netstat` | Connexions simulées (SSH sur port 22, MySQL 3306) |
| `ss` | Même comportement que `netstat` |
| `arp -a` | Table ARP statique simulée |

### 2.2 Ping toujours réussi

```typescript
// src/devices/linux/LinuxPC.ts:469-481
// Le ping simule TOUJOURS une réponse réussie avec des temps aléatoires
for (let i = 0; i < Math.min(count, 10); i++) {
  const time = (Math.random() * 50 + 10).toFixed(1);
  lines.push(`64 bytes from ${target}: icmp_seq=${i + 1} ttl=64 time=${time} ms`);
}
```

**Problèmes** :
- Aucune vérification de connectivité réelle
- Pas de simulation de perte de paquets
- Pas de timeout pour les hôtes inaccessibles
- TTL toujours à 64

### 2.3 Commandes réseau améliorées

| Commande | Statut |
|----------|--------|
| `curl` | ✅ Support `-v`, `-i`, `-I`, `-s`, `-o`, `-d`, `-X`, réponses contextuelles (API, httpbin) |
| `nc`/`netcat` | ✅ Mode listen `-l`, port scan `-z`, connexions TCP avec réponses par port |
| `nmap` | ✅ Scan de ports, détection de services `-sV`, détection OS `-O` |
| `tcpdump` | ✅ Capture de paquets simulée (requiert root) |
| `telnet` | ✅ Connexion avec bannières par protocole |
| `wget` | Simule un téléchargement sans créer de fichier |
| `nslookup` | Retourne toujours `93.184.216.34` |
| `dig` | Même comportement que `nslookup` |
| `traceroute` | Chemin simulé avec hops fictifs |

---

## 3. Gestion des processus

### 3.1 ProcessManager dynamique (AMÉLIORÉ)

Le nouveau `ProcessManager` (`src/terminal/processManager.ts`) offre :

```typescript
// Fonctionnalités implémentées:
- Processus système persistants (init, kthreadd, sshd, cron, rsyslogd, journald)
- Session utilisateur dynamique (sshd session + bash shell)
- Tracking des PIDs avec spawn/kill
- Statistiques temps réel (uptime, load average, process count)
- CPU/MEM simulés dynamiquement pour les processus actifs
```

**Commandes améliorées** :

| Commande | Amélioration |
|----------|--------------|
| `ps aux` | Liste dynamique des processus avec stats CPU/MEM variables |
| `top` | Uptime réel, load average calculé, statistiques de processus |
| `uptime` | Durée depuis le boot, load average |
| `free` | Mémoire avec variations simulées |
| `vmstat` | Statistiques système simulées |
| `kill PID` | Termine réellement le processus (avec vérification permissions) |
| `killall`/`pkill` | Kill par nom de processus |
| `pgrep` | Recherche de processus par pattern |

### 3.2 Limitations restantes

| Fonctionnalité | Statut |
|----------------|--------|
| `jobs` | Background jobs non trackés automatiquement |
| `bg`/`fg` | Non fonctionnels (pas de vrais background processes) |
| `&` (background) | Génère un PID mais n'exécute pas vraiment en arrière-plan |
| `Ctrl+C` / `Ctrl+Z` | Non interceptés |
| `trap` | Non supporté |
| `nohup` | Simule le message mais n'a pas d'effet réel |

---

## 4. Système de fichiers

### 4.1 Fonctionnalités implémentées

- Structure réaliste (`/bin`, `/etc`, `/home`, `/var`, etc.)
- Permissions Unix (rwxrwxrwx)
- Utilisateurs et groupes
- Symlinks
- Opérations CRUD (create, read, update, delete)

### 4.2 Limitations

| Fonctionnalité | Limitation |
|----------------|------------|
| Taille des fichiers | Toujours `4096` pour les répertoires, `content.length` pour les fichiers |
| Timestamps | `modified` mis à jour mais pas `accessed` |
| Hardlinks | Non supportés |
| Attributs étendus | Non supportés |
| ACLs | Non supportées |
| Quotas | Non supportés |
| `/proc` | Contenu statique (cpuinfo, meminfo ne reflètent pas l'état réel) |
| `/dev` | Fichiers de périphériques ne fonctionnent pas (`/dev/null`, `/dev/random`) |

### 4.3 Montage de systèmes de fichiers

- `mount` : Non implémenté
- `umount` : Non implémenté
- `fstab` : Présent mais non fonctionnel

---

## 5. Shell et fonctionnalités bash

### 5.1 Fonctionnalités implémentées

- Pipes (`|`)
- Redirections (`>`, `>>`, `<`, `2>&1`)
- Chaînage de commandes (`&&`, `||`, `;`)
- Expansion de variables (`$VAR`, `${VAR}`)
- Expansion de `~`
- Glob patterns (`*`, `?`)
- Alias
- Historique des commandes

### 5.2 Limitations du shell

| Fonctionnalité | Statut |
|----------------|--------|
| Substitution de commandes `$(cmd)` | **Partiellement** - ne fonctionne pas dans tous les contextes |
| Boucles `for`, `while` | ✅ Implémenté |
| Conditions `if`, `case` | ✅ Implémenté |
| Fonctions shell | ✅ Implémenté |
| Arrays | **Non implémentés** |
| Arithmetic expansion `$((expr))` | ✅ Implémenté |
| Here documents `<<EOF` | ✅ Implémenté |
| Subshells `(cmd)` | **Non implémentés** |
| Process substitution `<(cmd)` | **Non implémenté** |
| Brace expansion `{a,b,c}` | ✅ Implémenté (dans boucles for) |
| Variables locales `local` | ✅ Implémenté |

### 5.3 Fonctions shell (NOUVEAU)

**Fonctionnalités implémentées** :

```bash
# Définition de fonction
greet() { echo "Hello $1"; }
function sayhi() { echo "Hi"; }

# Appel avec arguments
greet World           # Hello World

# Arguments positionnels
$1, $2, ...          # Arguments individuels
$@, $*               # Tous les arguments
$#                   # Nombre d'arguments
$0                   # Nom du script (retourne "bash")
return [N]           # Retourner avec code de sortie
```

**Limitations des fonctions** :

| Fonctionnalité | Statut |
|----------------|--------|
| `local var=value` | ✅ Implémenté |
| `declare -f` | **Non implémenté** - lister les fonctions |
| `unset -f name` | **Non implémenté** - supprimer une fonction |
| `$?` dans fonction | **Non supporté** - dernier exit code |
| Fonctions récursives | Limitées (pas de protection contre stack overflow) |
| Arguments avec guillemets | ✅ Implémenté - `func "hello world"` fonctionne correctement |
| `shift` | **Non implémenté** |
| `set --` | **Non implémenté** |

### 5.4 Limitations découvertes avec scripts réels

Les tests avec des scripts réalistes (déploiement, CI/CD, monitoring) ont révélé:

| Problème | Statut |
|----------|--------|
| `ls \| grep` | ✅ Corrigé - `ls` affiche un fichier par ligne quand pipé |
| `$((2+2))` | ✅ Corrigé - Expansion arithmétique fonctionne |
| `arr=(a b c)` | **Non supporté** - Arrays bash non implémentés |
| `<(cmd)` | **Non supporté** - Process substitution non implémentée |
| `$(date +%A)` | Substitution de commande fonctionne dans la plupart des contextes |

**Scripts qui fonctionnent** :
- Boucles for/while avec variables
- Conditions if/elif/else/fi avec `test`
- Case statements pour routing
- Fonctions avec arguments simples
- Pipes multi-étapes (cat \| grep \| wc)
- Redirections (>, >>, <)
- SSH/SCP simulés
- systemctl/journalctl

### 5.5 Variables d'environnement

- Export limité (pas de propagation aux sous-processus)
- `source` / `.` : Non fonctionnel
- `.bashrc` : Présent mais non exécuté au démarrage

---

## 6. Commandes manquantes

### 6.1 Administration système

```
ssh, scp, sftp, rsync
systemctl, service, journalctl
mount, umount, fdisk, lsblk, blkid
dmesg, modprobe, lsmod
crontab (édition)
iptables, firewalld, ufw
```

### 6.2 Réseau avancé

```
nc (netcat), nmap
tcpdump, wireshark
ip netns, ip link set
bridge, vlan
```

### 6.3 Développement

```
gcc, make, cmake
git (complet - seules quelques commandes de base)
docker, podman
```

### 6.4 Utilitaires

```
find (options avancées limitées)
locate, updatedb
rsync
screen, tmux (gestion de sessions)
watch
xargs (options limitées)
```

---

## 7. Simulation réseau

### 7.1 Implémentation actuelle (LinuxPC)

Le `NetworkStack` dans `LinuxPC` implémente :
- Configuration d'interfaces (IP, netmask)
- Table de routage statique
- Table ARP
- Traitement de paquets (Ethernet, ARP, IPv4, ICMP)

### 7.2 Limitations de la simulation

| Aspect | Limitation |
|--------|------------|
| Connectivité réelle | Paquets ne transitent pas entre appareils dans le canvas |
| DHCP | Non implémenté |
| DNS | Résolution simulée/statique |
| NAT | Non implémenté |
| VLANs | Non implémentés |
| Protocoles L4+ | TCP/UDP non fonctionnels (pas de connexions réelles) |
| Latence | Simulée avec valeurs aléatoires |
| Perte de paquets | Aucune simulation |

### 7.3 Déconnexion UI/Backend

Le composant `Terminal.tsx` utilise les commandes de `terminal/commands/` au lieu de `LinuxPC.executeCommand()`, donc :
- La configuration réseau faite via le terminal n'affecte pas le `NetworkStack`
- L'affichage réseau ne reflète pas l'état réel de la simulation

---

## 8. Recommandations d'amélioration

### 8.1 Priorité haute

1. **Unifier les implémentations réseau** : Connecter le composant Terminal au `LinuxPC.executeCommand()` pour que les commandes réseau utilisent le `NetworkStack` réel.

2. **Simuler les échecs de ping** : Vérifier la connectivité réelle via la topologie réseau avant de simuler une réponse.

3. **Partager le FileSystem** : Utiliser le `FileSystem` du `LinuxPC` dans le composant Terminal.

### 8.2 Priorité moyenne

4. ~~**Implémenter le contrôle de flux**~~ : ✅ Implémenté (`for`, `while`, `if`, `case`).

5. ~~**Ajouter les commandes système manquantes**~~ : ✅ Implémenté (`systemctl`, `journalctl`, `mount`, etc.).

6. ~~**Simuler les processus**~~ : ✅ Implémenté (`ProcessManager` avec spawn/kill dynamique).

7. ~~**Améliorer netcat/curl**~~ : ✅ Implémenté (`nc`, `nmap`, `tcpdump`, `telnet`, `curl` amélioré).

### 8.3 Priorité basse

7. **Protocoles réseau avancés** : DHCP, DNS fonctionnel, TCP connections.

8. ~~**Commandes SSH/SCP simulées**~~ : ✅ Implémenté (`ssh`, `scp`, `sftp`, `rsync`, `ssh-keygen`, `ssh-copy-id`).

9. ~~**Here documents**~~ : ✅ Implémenté (`<<EOF`, `<<'EOF'`, `<<-EOF`).

10. ~~**Fonctions shell**~~ : ✅ Implémenté (définition `function name()`, appel avec arguments, `$1`, `$@`, `$#`, `return`).

---

## Annexe : Fichiers sources clés

| Fichier | Description |
|---------|-------------|
| `src/devices/linux/LinuxPC.ts` | Classe LinuxPC avec NetworkStack |
| `src/terminal/commands/network.ts` | Commandes réseau (routées vers LinuxPC) |
| `src/terminal/commands/process.ts` | Commandes processus (utilise ProcessManager) |
| `src/terminal/commands/system.ts` | Commandes système (systemctl, journalctl, etc.) |
| `src/terminal/processManager.ts` | Gestionnaire de processus dynamique |
| `src/terminal/shell/scriptInterpreter.ts` | Interpréteur de contrôle de flux (for, while, if) |
| `src/terminal/shell/executor.ts` | Exécuteur de commandes shell |
| `src/terminal/filesystem.ts` | Système de fichiers virtuel |
| `src/core/network/packet.ts` | Structures de paquets réseau |
| `src/__tests__/LinuxPC.test.ts` | Tests unitaires LinuxPC |

---

*Dernière mise à jour : 2025-12-19*
*NetSim - Simulateur de réseau*
