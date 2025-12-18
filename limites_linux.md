# Limites de l'implémentation du Terminal Linux dans NetSim

Ce document recense les limitations identifiées dans l'implémentation actuelle du terminal Linux et de la classe `LinuxPC`.

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

### 2.3 Commandes réseau non fonctionnelles

| Commande | Statut |
|----------|--------|
| `curl` | Simule une réponse HTML générique |
| `wget` | Simule un téléchargement sans créer de fichier |
| `nslookup` | Retourne toujours `93.184.216.34` |
| `dig` | Même comportement que `nslookup` |
| `traceroute` | Chemin simulé avec hops fictifs |

---

## 3. Gestion des processus

### 3.1 Processus simulés

```typescript
// src/terminal/commands/process.ts
// ps, top retournent une liste STATIQUE de processus fictifs
```

**Limitations** :
- `ps aux` : Liste de processus hardcodée (init, sshd, bash, cron...)
- `top` : Snapshot statique, pas de rafraîchissement
- PIDs fixes et ne changent jamais
- Aucun processus réel n'est créé ou géré

### 3.2 Contrôle des jobs inexistant

| Commande | Comportement |
|----------|--------------|
| `jobs` | Toujours vide |
| `bg` | Erreur "no current job" |
| `fg` | Erreur "no current job" |
| `kill PID` | Erreur "No such process" (aucun processus réel) |
| `&` (background) | Génère un PID aléatoire mais n'exécute rien en arrière-plan |

### 3.3 Signaux non implémentés

- `Ctrl+C` : Non intercepté
- `Ctrl+Z` : Non intercepté
- `trap` : Non supporté
- `nohup` : Non implémenté

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
| Boucles `for`, `while` | **Non implémentées** |
| Conditions `if`, `case` | **Non implémentées** |
| Fonctions shell | **Non implémentées** |
| Arrays | **Non implémentés** |
| Arithmetic expansion `$((expr))` | **Non implémenté** |
| Here documents `<<EOF` | **Non implémentés** |
| Subshells `(cmd)` | **Non implémentés** |
| Process substitution `<(cmd)` | **Non implémenté** |
| Brace expansion `{a,b,c}` | **Non implémenté** |

### 5.3 Variables d'environnement

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

4. **Implémenter le contrôle de flux** : Boucles `for`/`while`, conditions `if`/`case`.

5. **Ajouter les commandes système manquantes** : `systemctl`, `journalctl`, `mount`.

6. **Simuler les processus** : Créer de vrais processus (au moins un PID tracking) pour `ps`, `kill`, `jobs`.

### 8.3 Priorité basse

7. **Protocoles réseau avancés** : DHCP, DNS fonctionnel, TCP connections.

8. **Commandes SSH/SCP simulées** : Pour la connexion entre appareils du réseau.

9. **Here documents et fonctions shell** : Pour des scripts plus complexes.

---

## Annexe : Fichiers sources clés

| Fichier | Description |
|---------|-------------|
| `src/devices/linux/LinuxPC.ts` | Classe LinuxPC avec NetworkStack |
| `src/terminal/commands/network.ts` | Commandes réseau (statiques) |
| `src/terminal/commands/index.ts` | Registry des commandes |
| `src/terminal/shell/executor.ts` | Exécuteur de commandes shell |
| `src/terminal/filesystem.ts` | Système de fichiers virtuel |
| `src/core/network/packet.ts` | Structures de paquets réseau |
| `src/__tests__/LinuxPC.test.ts` | Tests unitaires LinuxPC |

---

*Document généré le 2025-12-18*
*NetSim - Simulateur de réseau*
