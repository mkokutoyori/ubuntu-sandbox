# SSH de Zéro à Héros : se connecter à n'importe quel équipement depuis n'importe quel équipement

> **À qui s'adresse ce tutoriel ?**
> À toute personne qui doit administrer, auditer ou sécuriser un parc réseau : ingénieur système, ingénieur réseau, RSSI en devenir, auditeur informatique. On part de zéro — je ne suppose pas que tu sais ce qu'est une clé d'hôte, un `known_hosts` ou un `access-class`. La seule chose que je te demande, c'est de ne pas avoir peur d'un terminal.

> **Ce qui rend ce tutoriel différent**
> Il est **fait pour être exécuté, pas lu**. Dès la partie II tu montes un laboratoire de **dix équipements de six familles différentes** — Linux, Windows, Cisco IOS, Huawei VRP, Cisco ASA, FortiGate — et, à la fin, **n'importe lequel d'entre eux ouvre une session SSH vers n'importe quel autre** : 90 couples « client → serveur », tous vérifiés par un test automatique. Chaque concept est immédiatement suivi d'un **TP** que tu tapes, et **chaque TP est rejoué par un test** (`src/__tests__/unit/network-v2/tuto-ssh-zero-a-heros.test.ts`). Si une commande de ce document ne produit pas ce qui est écrit, c'est un défaut du simulateur ou du document, et le test le dira.
>
> Chaque TP suit la même structure :
> **🎯 Objectif** → **🔧 Manipulation** → **✅ Résultat attendu** → **🧠 Ce que tu viens d'apprendre**, et, parce que ce tutoriel s'adresse aussi aux auditeurs, une case **🔍 Point d'audit** quand le sujet touche à la preuve ou à la conformité.

---

## Comment utiliser ce document

**1. Ne saute pas les TP.** SSH s'apprend dans les doigts. Tu ne comprendras vraiment la clé d'hôte que le jour où ton client refusera de se connecter parce qu'elle a changé.

**2. Casse des choses exprès.** Plusieurs TP te demandent de provoquer un refus, puis de le lire. Un administrateur qui n'a jamais lu `Permission denied (publickey,password)` ne sait pas dire *pourquoi* la porte est fermée.

**3. Un seul mot de passe de laboratoire.** Pour que les commandes tiennent sur une ligne, tous les comptes d'administration du laboratoire s'appellent `netadmin` et ont le mot de passe `Secret123` (sauf le poste Windows, voir plus bas). C'est une facilité de **laboratoire**. 🔍 *Un mot de passe identique partout, c'est précisément la première observation qu'un auditeur ferait sur un vrai parc.*

---

## Conventions typographiques

| Marqueur | Signification |
|---|---|
| 💡 **Astuce** | Un raccourci ou une bonne pratique |
| ⚠️ **Attention** | Un piège classique |
| 🚨 **Danger** | Une commande qui peut te couper l'accès à l'équipement |
| 🧪 **TP** | Un exercice à faire, pas à lire |
| 🧠 **Comprendre** | Le « pourquoi » derrière le « comment » |
| 🔍 **Point d'audit** | Ce qu'un auditeur ou un RSSI vérifierait, et comment en garder la preuve |

Les invites indiquent toujours *où* tu tapes :

```
user@lpc:~$          ← poste Linux du laboratoire
netadmin@lsrv:~$     ← serveur Linux, session ouverte en tant que netadmin
C:\Users\User>       ← poste Windows
ior#                 ← routeur Cisco IOS en mode privilégié
<vrr>                ← routeur Huawei VRP en vue utilisateur
asa#                 ← pare-feu Cisco ASA en mode privilégié
fgt #                ← pare-feu FortiGate
```

---

## Table des matières

### Partie I — Comprendre SSH
1. [À quoi sert SSH, et ce qu'il remplace](#1-à-quoi-sert-ssh-et-ce-quil-remplace)
2. [Une connexion SSH en six étapes](#2-une-connexion-ssh-en-six-étapes)
3. [Deux preuves d'identité : celle du serveur, celle du client](#3-deux-preuves-didentité--celle-du-serveur-celle-du-client)

### Partie II — Le laboratoire
4. [Les dix équipements et le plan d'adressage](#4-les-dix-équipements-et-le-plan-dadressage)
5. [🧪 TP 1 — Le laboratoire respire](#5--tp-1--le-laboratoire-respire)

### Partie III — Allumer le serveur SSH sur chaque famille d'équipements
6. [Linux](#6-linux)
7. [Windows](#7-windows)
8. [Cisco IOS (routeur et commutateur)](#8-cisco-ios-routeur-et-commutateur)
9. [Huawei VRP (routeur et commutateur)](#9-huawei-vrp-routeur-et-commutateur)
10. [Cisco ASA](#10-cisco-asa)
11. [FortiGate](#11-fortigate)
12. [🧪 TP 2 — Qui écoute sur le port 22 ?](#12--tp-2--qui-écoute-sur-le-port-22-)
13. [🧪 TP 3 — Lire la bannière d'identification](#13--tp-3--lire-la-bannière-didentification)

### Partie IV — Se connecter de n'importe où à n'importe où
14. [La syntaxe du client SSH sur chaque famille](#14-la-syntaxe-du-client-ssh-sur-chaque-famille)
15. [⭐ 🧪 TP 4 — La matrice : 90 connexions](#15---tp-4--la-matrice--90-connexions)

### Partie V — La confiance
16. [🧪 TP 5 — Vérifier l'empreinte avant de répondre « yes »](#16--tp-5--vérifier-lempreinte-avant-de-répondre--yes-)
17. [🧪 TP 6 — Une clé d'hôte qui change](#17--tp-6--une-clé-dhôte-qui-change)
18. [🧪 TP 7 — L'authentification par clé, de bout en bout](#18--tp-7--lauthentification-par-clé-de-bout-en-bout)

### Partie VI — Durcir
19. [🧪 TP 8 — Qui a le droit de se connecter ?](#19--tp-8--qui-a-le-droit-de-se-connecter-)
20. [🧪 TP 9 — Fermer les sessions oubliées](#20--tp-9--fermer-les-sessions-oubliées)
21. [🧪 TP 10 — Freiner les tentatives](#21--tp-10--freiner-les-tentatives)
22. [🧪 TP 11 — La bannière légale](#22--tp-11--la-bannière-légale)

### Partie VII — Transférer et rebondir
23. [🧪 TP 12 — scp et sftp](#23--tp-12--scp-et-sftp)
24. [🧪 TP 13 — Rebondir à travers un bastion](#24--tp-13--rebondir-à-travers-un-bastion)

### Partie VIII — Tracer et auditer
25. [🧪 TP 14 — Où est la trace ?](#25--tp-14--où-est-la-trace-)
26. [🧪 TP 15 — Auditer le parc depuis un seul poste](#26--tp-15--auditer-le-parc-depuis-un-seul-poste)
27. [La liste de contrôle de l'auditeur](#27-la-liste-de-contrôle-de-lauditeur)

### Partie IX — Quand ça ne marche pas
28. [Les messages d'erreur et ce qu'ils veulent dire](#28-les-messages-derreur-et-ce-quils-veulent-dire)
29. [Aide-mémoire](#29-aide-mémoire)

---

# Partie I — Comprendre SSH

---

## 1. À quoi sert SSH, et ce qu'il remplace

**SSH** (Secure Shell) ouvre une session d'administration à distance **chiffrée** et **authentifiée** vers un équipement. Il a remplacé :

| Ancien outil | Défaut | Ce que SSH change |
|---|---|---|
| `telnet` (port 23) | Tout circule **en clair**, mot de passe compris | Tout est chiffré |
| `rlogin`, `rsh` | Confiance fondée sur l'adresse IP, trivialement falsifiable | L'identité est prouvée par cryptographie |
| `ftp` (pour les fichiers) | Mot de passe en clair | `scp` et `sftp` passent dans le même tunnel chiffré |

SSH fait **trois** choses distinctes, et il faut les séparer dans sa tête parce qu'on les configure séparément :

1. **Il prouve au client qu'il parle au bon serveur** (la *clé d'hôte*).
2. **Il prouve au serveur qui est le client** (mot de passe, clé publique…).
3. **Il chiffre et protège contre la modification** tout ce qui passe ensuite (chiffrement et MAC).

> 🔍 **Point d'audit** — La première question d'un auditeur sur l'administration à distance est : *« Existe-t-il un seul équipement où `telnet` reste ouvert ? »* Dans le laboratoire, tu apprendras à le vérifier sur les dix familles (TP 15).

---

## 2. Une connexion SSH en six étapes

Quand tu tapes `ssh netadmin@10.0.0.12`, voici ce qui se passe, dans l'ordre. Chaque étape est un endroit où une panne ou une attaque est possible, et chacune produit un message d'erreur différent — on les reverra tous dans la partie IX.

| # | Étape | Qui décide | Message d'échec typique |
|---|---|---|---|
| 1 | **Connexion TCP** vers le port 22 | Le réseau, un pare-feu, le service | `Connection refused` · `Connection timed out` · `No route to host` |
| 2 | **Échange des versions** : chacun annonce `SSH-2.0-…` | Les deux | `Protocol major versions differ` |
| 3 | **Négociation des algorithmes** (échange de clés, chiffrement, MAC, type de clé d'hôte) | Les deux | `no matching key exchange method found` |
| 4 | **Vérification de la clé d'hôte** | Le client, avec son `known_hosts` | `Host key verification failed` · `REMOTE HOST IDENTIFICATION HAS CHANGED` |
| 5 | **Authentification de l'utilisateur** | Le serveur | `Permission denied (publickey,password)` |
| 6 | **Ouverture d'un canal** : shell, commande, transfert, tunnel | Le serveur (droits du compte) | prompt, ou refus de la commande |

Le protocole est décrit par les RFC 4251 (architecture), 4252 (authentification), 4253 (transport) et 4254 (connexion). Le simulateur les **implémente sur le fil** : les paquets de la connexion traversent réellement les câbles, les commutateurs et les pare-feux du laboratoire, ce qui est ce qui te permet, plus loin, de bloquer SSH avec un filtre et de voir l'effet.

---

## 3. Deux preuves d'identité : celle du serveur, celle du client

### 3.1 La clé d'hôte : « suis-je bien chez le bon serveur ? »

Chaque serveur SSH possède une **paire de clés d'hôte**. À la première connexion, le client reçoit la clé publique et son **empreinte** (un condensé SHA-256), et te demande si tu y fais confiance. Si tu réponds *yes*, il la range dans `~/.ssh/known_hosts`. Aux connexions suivantes, il compare : une clé différente déclenche l'alerte `REMOTE HOST IDENTIFICATION HAS CHANGED`.

> 🧠 **Comprendre** — Répondre *yes* sans vérifier l'empreinte, c'est faire confiance à ce qui répond **à ce moment-là**. Si quelqu'un s'est glissé entre toi et le serveur (attaque de l'homme du milieu), tu viens de lui donner ta confiance pour toute la suite. La vérification se fait **hors bande** : on lit l'empreinte sur la console du serveur et on la compare. C'est le TP 5.

### 3.2 L'authentification de l'utilisateur : « qui es-tu ? »

| Méthode | Principe | Quand |
|---|---|---|
| **Mot de passe** | Tu tapes un secret, le serveur le compare | Simple, mais devinable, rejouable, partagé |
| **Clé publique** | Tu prouves que tu détiens la clé **privée** correspondant à une clé **publique** que le serveur connaît ; le secret ne quitte jamais ton poste | Recommandé en production |
| **Mot de passe + clé** | Les deux sont exigés | Comptes sensibles |

> 🔍 **Point d'audit** — Dans une banque, « l'accès d'administration par mot de passe seul sur un équipement exposé » est une observation classique. L'objectif du TP 7 est de montrer, équipement par équipement, comment passer à la clé et **fermer** la porte du mot de passe.

---

# Partie II — Le laboratoire

---

## 4. Les dix équipements et le plan d'adressage

Tout le laboratoire tient sur **un seul segment** `10.0.0.0/24`, relié par un commutateur central (qui ne fait que transmettre les trames). Chaque équipement est configuré **avec ses propres commandes natives** — on n'utilise aucun raccourci.

| Nom | Famille | Adresse | Compte | Mot de passe |
|---|---|---|---|---|
| `lpc` | Poste Linux (Ubuntu 22.04) | `10.0.0.11` | `netadmin` | `Secret123` |
| `lsrv` | Serveur Linux (Ubuntu 22.04) | `10.0.0.12` | `netadmin` | `Secret123` |
| `wpc` | Poste Windows | `10.0.0.13` | `User` | `user` |
| `wsrv` | Serveur Windows | `10.0.0.14` | `netadmin` | `Secret123` |
| `ior` | Routeur Cisco IOS | `10.0.0.15` | `netadmin` (niveau 15) | `Secret123` |
| `ios` | Commutateur Cisco IOS (adresse sur `Vlan1`) | `10.0.0.16` | `netadmin` (niveau 15) | `Secret123` |
| `vrr` | Routeur Huawei VRP | `10.0.0.17` | `netadmin` (niveau 15) | `Secret123` |
| `vrs` | Commutateur Huawei VRP (adresse sur `Vlanif1`) | `10.0.0.18` | `netadmin` (niveau 15) | `Secret123` |
| `asa` | Pare-feu Cisco ASA | `10.0.0.19` | `netadmin` (niveau 15) | `Secret123` |
| `fgt` | Pare-feu FortiGate | `10.0.0.20` | `netadmin` (profil `super_admin`) | `Secret123` |

> 💡 **Astuce** — Dans l'interface, tu peux poser ces dix équipements à la main (palette → glisser-déposer, puis câbler chacun au commutateur). Les tests, eux, les construisent par le code avec exactement les mêmes commandes que celles du tutoriel (`src/__tests__/unit/network-v2/_helpers/sshMatrixLab.ts`).

---

## 5. 🧪 TP 1 — Le laboratoire respire

**🎯 Objectif** — S'assurer que le réseau fonctionne **avant** de soupçonner SSH. La moitié des « pannes SSH » sont des pannes de câblage ou d'adressage.

**🔧 Manipulation** — Sur `lpc` :

```
user@lpc:~$ ping -c 1 10.0.0.12
user@lpc:~$ ping -c 1 10.0.0.15
```

(et ainsi de suite pour les neuf autres adresses.)

**✅ Résultat attendu** — `1 packets transmitted, 1 received` pour chacune des neuf adresses.

**🧠 Ce que tu viens d'apprendre** — Le diagnostic se fait de bas en haut : câble → adresse → ping → port → service → authentification. Quand SSH échoue, remonte cette échelle dans cet ordre.

---

# Partie III — Allumer le serveur SSH sur chaque famille d'équipements

Chaque famille a sa manière d'activer SSH. Ce qu'elles ont en commun : il faut **(1)** un compte, **(2)** une clé d'hôte, **(3)** autoriser SSH sur l'interface ou la ligne d'administration.

---

## 6. Linux

Sur un Ubuntu, le serveur `sshd` est installé et démarré. Il reste à créer le compte :

```
user@lpc:~$ sudo hostnamectl set-hostname lpc
user@lpc:~$ sudo ip addr add 10.0.0.11/24 dev eth0
user@lpc:~$ sudo ip link set eth0 up
user@lpc:~$ sudo useradd -m -s /bin/bash netadmin
user@lpc:~$ echo 'netadmin:Secret123' | sudo chpasswd
```

La configuration du serveur est dans `/etc/ssh/sshd_config`, ses journaux dans `/var/log/auth.log`, et le service se pilote avec `systemctl` (`systemctl status ssh`, `sudo systemctl restart ssh`).

> 🧠 **Comprendre** — Le service s'appelle `ssh` sur Ubuntu (et `sshd` sur d'autres distributions) ; le simulateur accepte les deux noms.

---

## 7. Windows

Windows 10/11 et Windows Server embarquent **OpenSSH** (service `sshd`). Sur le poste, le compte standard est `User` (mot de passe `user`) ; sur le serveur, on crée le compte :

```
C:\Users\Administrator> netsh interface ip set address "Ethernet 0" static 10.0.0.14 255.255.255.0
C:\Users\Administrator> net user netadmin Secret123 /add
```

La configuration est le fichier `C:\ProgramData\ssh\sshd_config` — **la même syntaxe qu'OpenSSH sur Linux**.

> ⚠️ **Attention** — Sur Windows, la création d'un compte exige une session **administrateur** : `net user … /add` depuis le compte standard `User` répond `System error 5 has occurred. Access is denied.` C'est pour cela que le poste Windows du laboratoire garde son compte `User`.

---

## 8. Cisco IOS (routeur et commutateur)

Un équipement IOS n'a de serveur SSH que s'il a **un nom d'hôte, un nom de domaine et une clé RSA** — la clé d'hôte est fabriquée à partir de ces trois éléments. Puis il faut dire à la ligne d'administration (`vty`) d'accepter SSH et de vérifier les comptes locaux :

```
Router> enable
Router# configure terminal
Router(config)# hostname ior
ior(config)# ip domain-name lab.local
ior(config)# username netadmin privilege 15 secret Secret123
ior(config)# crypto key generate rsa modulus 2048
ior(config)# ip ssh version 2
ior(config)# interface GigabitEthernet0/0
ior(config-if)# ip address 10.0.0.15 255.255.255.0
ior(config-if)# no shutdown
ior(config-if)# exit
ior(config)# line vty 0 4
ior(config-line)# login local
ior(config-line)# transport input ssh
ior(config-line)# end
```

Sur le **commutateur**, l'adresse de gestion n'est pas portée par un port physique mais par une **interface virtuelle** : `interface Vlan1` / `ip address 10.0.0.16 255.255.255.0` / `no shutdown`. Le reste est identique.

> 🧠 **Comprendre** — `transport input ssh` ferme `telnet` sur la ligne : c'est l'une des commandes de durcissement les plus rentables. `login local` dit « vérifie le nom et le mot de passe dans la base locale » ; sans elle, la ligne demande un simple mot de passe de ligne.

> 🔍 **Point d'audit** — `show ip ssh` affiche la version, le délai d'authentification, le nombre d'essais, la taille de la clé et **la liste des algorithmes proposés**. C'est la pièce à joindre au dossier d'audit.

---

## 9. Huawei VRP (routeur et commutateur)

Sur VRP, SSH s'appelle **STelnet**. Il faut un compte AAA avec le type de service `ssh`, une paire de clés RSA, l'activation du serveur, puis l'autorisation de SSH sur les lignes `user-interface vty` :

```
<HUAWEI> system-view
[HUAWEI] sysname vrr
[vrr] interface GigabitEthernet0/0/0
[vrr-GigabitEthernet0/0/0] ip address 10.0.0.17 255.255.255.0
[vrr-GigabitEthernet0/0/0] undo shutdown
[vrr-GigabitEthernet0/0/0] quit
[vrr] aaa
[vrr-aaa] local-user netadmin password cipher Secret123
[vrr-aaa] local-user netadmin service-type ssh
[vrr-aaa] local-user netadmin privilege level 15
[vrr-aaa] quit
[vrr] rsa local-key-pair create
[vrr] stelnet server enable
[vrr] user-interface vty 0 4
[vrr-ui-vty0-4] authentication-mode aaa
[vrr-ui-vty0-4] protocol inbound ssh
[vrr-ui-vty0-4] quit
[vrr] ssh user netadmin authentication-type password
[vrr] ssh user netadmin service-type stelnet
```

Sur le commutateur, l'adresse est portée par `interface Vlanif1`.

> 💡 **Astuce** — La différence de style est volontaire : IOS dit `no shutdown`, VRP dit `undo shutdown`. VRP applique `undo` devant n'importe quelle commande pour la défaire.

---

## 10. Cisco ASA

Un pare-feu ASA se configure **par interface nommée** (`nameif`) avec un **niveau de sécurité** ; l'accès SSH est ensuite autorisé **par réseau source et par interface** :

```
ciscoasa> enable
ciscoasa# configure terminal
ciscoasa(config)# hostname asa
asa(config)# interface GigabitEthernet0/0
asa(config-if)# nameif inside
asa(config-if)# security-level 100
asa(config-if)# ip address 10.0.0.19 255.255.255.0
asa(config-if)# no shutdown
asa(config-if)# exit
asa(config)# username netadmin password Secret123 privilege 15
asa(config)# ssh 10.0.0.0 255.255.255.0 inside
asa(config)# crypto key generate rsa modulus 2048
```

> 🧠 **Comprendre** — `ssh 10.0.0.0 255.255.255.0 inside` se lit : « SSH est ouvert sur l'interface `inside`, **uniquement pour les clients du réseau `10.0.0.0/24`** ». Les deux premiers arguments **décident** : un client hors du réseau est écarté sans réponse (tu verras `Connection timed out`, pas `refused` — l'ASA ne dit pas qu'elle existe). Retire la dernière entrée d'une interface et SSH se ferme sur elle.

---

## 11. FortiGate

Sur FortiOS, le service est autorisé **par interface** dans `allowaccess`, et les administrateurs sont une table `system admin` :

```
config system global
    set hostname fgt
end
config system interface
    edit "port1"
        set mode static
        set ip 10.0.0.20 255.255.255.0
        set allowaccess ping ssh
    next
end
config system admin
    edit "netadmin"
        set password "Secret123"
        set accprofile "super_admin"
    next
end
```

> 🧠 **Comprendre** — `allowaccess ping ssh` autorise **ces deux services seulement** sur `port1`. Retire `ssh` et le port 22 devient muet : le pare-feu **jette** les paquets (timeout) au lieu de refuser, par conception.

---

## 12. 🧪 TP 2 — Qui écoute sur le port 22 ?

**🎯 Objectif** — Savoir, sur chaque famille, **prouver** qu'un serveur SSH est prêt, sans s'y connecter.

**🔧 Manipulation**

| Équipement | Commande | Ce qu'on doit lire |
|---|---|---|
| `lsrv` | `ss -tlnp \| grep :22` · `systemctl is-active ssh` | `sshd` en écoute · `active` |
| `wsrv` | `sc query sshd` · `netstat -an \| findstr :22` | `RUNNING` · `LISTENING` |
| `ior` | `show ip ssh` | `SSH Enabled - version 2.0` |
| `vrr` | `display ssh server status` | `SSH version : 2.0` · `Stelnet server : Enable` |
| `asa` | `show running-config \| include ssh` | `ssh 10.0.0.0 255.255.255.0 inside` |
| `fgt` | `show system interface port1` | `set allowaccess ping ssh` |

Puis, **depuis le poste Linux**, scanne les neuf autres :

```
user@lpc:~$ nmap -Pn -p 22 10.0.0.15
PORT   STATE SERVICE
22/tcp open  ssh
```

> 💡 **Astuce** — `-Pn` demande à `nmap` de ne pas tester d'abord si l'hôte « répond ». Sans lui, et en tant qu'utilisateur non privilégié, `nmap` sonde des ports web pour décider que l'hôte est vivant — et un pare-feu qui jette ces paquets lui fait conclure à tort que l'hôte est éteint (`Host seems down`). `nmap` te le dit lui-même dans son message.

**✅ Résultat attendu** — `22/tcp open` sur les neuf équipements.

**🧠 Ce que tu viens d'apprendre** — « Le port est ouvert » et « le service est configuré » sont deux faits différents. L'auditeur vérifie les deux : le premier **de l'extérieur** (`nmap`), le second **de l'intérieur** (la commande de l'équipement).

---

## 13. 🧪 TP 3 — Lire la bannière d'identification

**🎯 Objectif** — À l'étape 2 du protocole, chaque serveur s'annonce. C'est une empreinte digitale de la famille d'équipements — utile pour **inventorier** un parc.

**🔧 Manipulation**

```
user@lpc:~$ ssh-keyscan 10.0.0.12
# 10.0.0.12:22 SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6
```

**✅ Résultat attendu**

| Équipement | Bannière |
|---|---|
| Serveur Linux | `SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6` |
| Serveur Windows | `SSH-2.0-OpenSSH_for_Windows_8.6` |
| Routeur Cisco IOS | `SSH-2.0-Cisco-1.25` |
| Routeur Huawei | `SSH-2.0-HUAWEI-1.5` |
| ASA | `SSH-1.99-Cisco-1.25` (tant que `ssh version 2` n'est pas configuré) |

> 🔍 **Point d'audit** — La bannière révèle le logiciel **et sa version**. Un OpenSSH ancien est un risque de vulnérabilité connue ; l'ASA qui annonce `1.99` accepte encore le protocole SSH-1, déprécié depuis des années. `ssh version 2` règle les deux : la bannière devient `SSH-2.0-Cisco-1.25`, et `ssh version 1` ferait refuser tous les clients modernes.

---

# Partie IV — Se connecter de n'importe où à n'importe où

---

## 14. La syntaxe du client SSH sur chaque famille

Chaque famille a **son propre client SSH**, avec sa propre syntaxe. Voici celles du laboratoire :

| Depuis… | Commande | Particularité |
|---|---|---|
| Linux, Windows | `ssh netadmin@10.0.0.12` | OpenSSH ; options `-p`, `-i`, `-J`, `-L`, `-o`… |
| Cisco IOS | `ssh -l netadmin 10.0.0.12` | Le nom d'utilisateur passe par `-l` |
| Huawei VRP | `stelnet 10.0.0.12` | Le client te **demande** le nom : `Please input the username:` |
| Cisco ASA | `ssh netadmin@10.0.0.12` | Depuis le mode privilégié |
| FortiGate | `execute ssh netadmin@10.0.0.12` | Une action `execute`, pas une commande de configuration |

À chaque première connexion à une nouvelle cible, le client demande de **valider la clé d'hôte** (`yes`), puis le **mot de passe**.

### 14.1 Quand le client est plus moderne que le serveur

Un client OpenSSH récent **refuse** les algorithmes anciens que proposent encore certains équipements. Tu le verras en tentant de joindre le routeur Cisco depuis le poste Linux sans précaution :

```
Unable to negotiate with 10.0.0.15 port 22: no matching key exchange method found.
Their offer: diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1
```

C'est **la sécurité qui fait son travail** : l'équipement ne propose que des algorithmes bâtis sur SHA-1. Deux voies :

1. **Mettre l'équipement à jour** (la bonne).
2. **Autoriser explicitement l'algorithme ancien, pour cet équipement seulement**, dans `~/.ssh/config` :

```
Host 10.0.0.15
    KexAlgorithms +diffie-hellman-group14-sha1
    HostKeyAlgorithms +ssh-rsa
    Ciphers +aes128-cbc
```

Le laboratoire place cette dérogation sur les postes Linux et Windows (c'est la configuration `iosLegacySsh`), parce que la seule autre option serait d'exclure les routeurs Cisco du laboratoire.

> 🔍 **Point d'audit** — Chaque ligne `KexAlgorithms +…` dans un `~/.ssh/config` est une **dérogation de sécurité**. Un auditeur la liste, la justifie, et la fait expirer avec le remplacement de l'équipement.

---

## 15. ⭐ 🧪 TP 4 — La matrice : 90 connexions

**🎯 Objectif** — La preuve que le titre de ce tutoriel n'est pas une promesse : **chaque équipement ouvre une session vers chacun des neuf autres**.

**🔧 Manipulation** — Choisis un client et une cible quelconques parmi les dix, tape la commande de la table du § 14, réponds `yes` à la clé d'hôte, puis au mot de passe. Tu arrives sur l'invite de la cible. Vérifie son nom, déconnecte-toi, et tu retrouves ton invite :

```
user@lpc:~$ ssh netadmin@10.0.0.19              ← de Linux vers l'ASA
asa# show running-config | include hostname
hostname asa
asa# logout
user@lpc:~$

ior# ssh -l netadmin 10.0.0.17                  ← de IOS vers Huawei
<vrr> display current-configuration | include sysname
 sysname vrr
<vrr> quit
ior#
```

**✅ Résultat attendu** — Les 90 couples fonctionnent. Le test `tuto-ssh-matrice-equipements.test.ts` les parcourt tous : il ouvre un terminal sur le client, tape la commande de la famille, répond aux invites de clé d'hôte, de nom et de mot de passe, **vérifie que l'invite affichée est celle de la cible**, lui fait dire son propre nom, se déconnecte et vérifie que l'invite d'origine est revenue.

| Quand tu quittes… | Tape |
|---|---|
| Linux, Windows, IOS, FortiGate | `exit` |
| Huawei VRP | `quit` |
| ASA | `logout` (`exit` y revient seulement au mode non privilégié) |

> 🧠 **Ce que tu viens d'apprendre** — Le jour où tu ne peux plus joindre un équipement depuis un autre, tu as maintenant un point de comparaison : cette matrice est le comportement attendu. Si la tienne diffère, la différence est ton diagnostic.

---

# Partie V — La confiance

---

## 16. 🧪 TP 5 — Vérifier l'empreinte avant de répondre « yes »

**🎯 Objectif** — La première connexion à un serveur affiche une **empreinte** de sa clé d'hôte. Répondre `yes` sans la comparer, c'est accepter l'identité de n'importe qui qui répond à cette adresse. On apprend à la comparer à celle que le serveur calcule **lui-même**.

**🔧 Manipulation**

```
user@lpc:~$ ssh netadmin@10.0.0.12
The authenticity of host '10.0.0.12' can't be established.
ED25519 key fingerprint is SHA256:zID0Tz9r6J4IWlgH12hbGpr4eR7yDWGJuUaiZ0K8ems.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? no
Host key verification failed.
```

Tu réponds `no`, puis tu vas **sur le serveur** (console, hors SSH) lire l'empreinte de sa propre clé :

```
netadmin@lsrv:~$ ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
256 SHA256:zID0Tz9r6J4IWlgH12hbGpr4eR7yDWGJuUaiZ0K8ems root@lsrv (ED25519)
```

**✅ Résultat attendu** — Les deux empreintes sont **identiques**. Le test compare le deuxième champ de la sortie de `ssh-keygen -lf` à l'empreinte annoncée par le client. Seulement alors, tu te reconnectes et tu réponds `yes`.

> 🧠 **Ce que tu viens d'apprendre** — Le canal pour comparer l'empreinte doit être **différent** de la connexion qu'on est en train d'établir (console, ticket de livraison, inventaire signé). Une empreinte lue par la connexion suspecte elle-même ne prouve rien.

> 🔍 **Point d'audit** — `StrictHostKeyChecking=no` ou `accept-new` dans un script supprime cette vérification : acceptable en laboratoire, **à relever** en production. La bonne pratique est de distribuer un `known_hosts` central contrôlé.

---

## 17. 🧪 TP 6 — Une clé d'hôte qui change

**🎯 Objectif** — Reconnaître l'alerte la plus importante de SSH et savoir quoi en faire.

**🔧 Manipulation** — Connecte-toi une première fois au serveur Linux (la clé est mémorisée dans `~/.ssh/known_hosts`). Puis, **sur le serveur**, remplace ses clés d'hôte, comme après une réinstallation :

```
netadmin@lsrv:~$ sudo rm /etc/ssh/ssh_host_*
netadmin@lsrv:~$ sudo ssh-keygen -A
netadmin@lsrv:~$ sudo systemctl restart ssh
```

Reconnecte-toi depuis le poste :

```
user@lpc:~$ ssh netadmin@10.0.0.12
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
...
Offending ED25519 key in /home/user/.ssh/known_hosts:1
  remove with:
  ssh-keygen -f "/home/user/.ssh/known_hosts" -R "10.0.0.12"
Host key verification failed.
```

**✅ Résultat attendu** — Le client **refuse**, sans même demander le mot de passe. Le message cite la ligne fautive de `known_hosts` et la commande exacte pour l'effacer. Après vérification **hors bande** que le changement est légitime :

```
user@lpc:~$ ssh-keygen -f /home/user/.ssh/known_hosts -R 10.0.0.12
user@lpc:~$ ssh -o StrictHostKeyChecking=accept-new netadmin@10.0.0.12 hostname
lsrv
```

> ⚠️ **Attention** — Ne tape jamais `ssh-keygen -R` par réflexe. La question n'est pas « comment faire taire l'alerte ? » mais « **pourquoi** la clé a-t-elle changé ? » Réinstallation planifiée, ou homme du milieu ? La réponse se trouve dans le ticket de changement, pas dans le terminal.

> 🔍 **Point d'audit** — Demande les tickets de changement correspondant aux dates de régénération des clés d'hôte (`ls -l /etc/ssh/ssh_host_*`).

---

## 18. 🧪 TP 7 — L'authentification par clé, de bout en bout

**🎯 Objectif** — Remplacer le mot de passe par une paire de clés, sur **trois familles** : Linux, Huawei VRP, FortiGate, puis **interdire** les mots de passe sur Linux.

**🔧 Manipulation**

**a) Générer la paire sur le poste, puis installer la clé publique sur le serveur Linux**

```
user@lpc:~$ ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
user@lpc:~$ ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa
user@lpc:~$ ssh-copy-id -i ~/.ssh/id_ed25519.pub netadmin@10.0.0.12
...
Number of key(s) added: 1
user@lpc:~$ ssh -o PasswordAuthentication=no netadmin@10.0.0.12 hostname
lsrv
```

Sur le serveur, le journal confirme : `Accepted publickey for netadmin from 10.0.0.11`.

**b) Fermer la porte aux mots de passe**

```
netadmin@lsrv:~$ echo "PasswordAuthentication no" | sudo tee -a /etc/ssh/sshd_config
netadmin@lsrv:~$ sudo systemctl restart ssh
```

Maintenant, `ssh -o PubkeyAuthentication=no netadmin@10.0.0.12` répond `Permission denied`, et la même connexion par clé continue de marcher.

**c) Huawei VRP — la clé du poste devient une « clé de pair » rattachée au compte**

```
<vrr> system-view
[vrr] rsa peer-public-key lpc encoding-type openssh
[vrr-rsa-public-key] public-key-code begin
[vrr-rsa-key-code] ssh-rsa AAAAB3Nza... user@lpc        ← colle ici le contenu de ~/.ssh/id_rsa.pub
[vrr-rsa-key-code] public-key-code end
[vrr-rsa-public-key] peer-public-key end
[vrr] ssh user netadmin authentication-type rsa
[vrr] ssh user netadmin assign rsa-key lpc
```

```
user@lpc:~$ ssh -i ~/.ssh/id_rsa -o PreferredAuthentications=publickey netadmin@10.0.0.17 "display clock"
```

**c bis) Cisco IOS — `ip ssh pubkey-chain` : le routeur ne garde que le hachage**

```
ior(config)# ip ssh pubkey-chain
ior(conf-ssh-pubkey)# username netadmin
ior(conf-ssh-pubkey-user)# key-string
ior(conf-ssh-pubkey-data)# AAAAB3NzaC1yc2EAAAADAQABAAABAQC...      ← le corps de id_rsa.pub, coupé en lignes de 64 caractères
ior(conf-ssh-pubkey-data)# ...
ior(conf-ssh-pubkey-data)# exit
ior(conf-ssh-pubkey-user)# end
ior# show running-config | begin pubkey
ip ssh pubkey-chain
  username netadmin
   key-hash ssh-rsa 8FB4F858DD7E5AFB372780EC653DB371
  quit
```

IOS n'accepte que des clés **RSA**, collées **sans** le préfixe `ssh-rsa`, et il ne conserve que l'empreinte MD5 de la clé (`key-hash`), jamais la clé elle-même. Tu peux aussi saisir directement `key-hash ssh-rsa <32 caractères hexadécimaux>`. Le compte `netadmin` doit exister localement, et la connexion par clé ne remplace pas le mot de passe : les deux restent acceptés tant que tu ne retires pas l'un d'eux.

**d) FortiGate — la clé est un attribut de l'administrateur**

```
fgt # config system admin
fgt (admin) # edit netadmin
fgt (netadmin) # set ssh-public-key1 "ssh-ed25519 AAAAC3... user@lpc"
fgt (netadmin) # next
fgt (admin) # end
```

La valeur est **validée** : une clé mal formée est refusée à la saisie, pas à la première connexion.

**✅ Résultat attendu** — Dans les trois cas la connexion par clé aboutit (le test le vérifie avec `-o PasswordAuthentication=no` ou `-o PreferredAuthentications=publickey`), et sur Linux les mots de passe sont refusés une fois `PasswordAuthentication no` appliqué.

> 🧠 **Ce que tu viens d'apprendre** — Une clé **privée** ne quitte jamais le poste ; seule la clé **publique** est distribuée. Chaque famille a son propre endroit pour déclarer « cette clé publique appartient à ce compte » : `~/.ssh/authorized_keys` (Linux), `peer-public-key` + `ssh user … assign` (VRP), `ssh-public-key1` (FortiGate).

> 🔍 **Point d'audit** — Inventorie les `authorized_keys` : une clé sans propriétaire identifiable (commentaire, ticket) est une porte dérobée potentielle. Et vérifie que les clés privées sont protégées par une **phrase de passe** — le `-N ""` de ce TP est une facilité de laboratoire.

> ⚠️ **Sources** — Le format `pubkey-chain` / `key-hash` vient de transcriptions publiées de configurations IOS (la documentation officielle Cisco n'est pas joignable depuis l'environnement de développement) ; l'indentation exacte de `quit` dans la running-config et le texte d'erreur d'une clé illisible n'y sont attestés que par un seul exemple, et le simulateur les reprend tels quels.

---

# Partie VI — Durcir

---

## 19. 🧪 TP 8 — Qui a le droit de se connecter ?

**🎯 Objectif** — Restreindre **les adresses sources** (et sur Linux, les comptes) qui peuvent ouvrir une session. C'est la mesure de durcissement la plus rentable : un port 22 qui ne répond qu'au poste d'administration est invisible du reste du réseau.

**🔧 Manipulation et ✅ résultat attendu, par famille** — dans chaque cas on teste depuis le poste autorisé (`lpc`, 10.0.0.11) **et** depuis un poste qui ne l'est pas (`lsrv`, 10.0.0.12).

**Cisco IOS — `access-class` sur les lignes vty**

```
ior(config)# ip access-list standard VTY-IN
ior(config-std-nacl)# permit 10.0.0.11
ior(config-std-nacl)# exit
ior(config)# line vty 0 4
ior(config-line)# access-class VTY-IN in
```

Depuis `lsrv` : `Connection refused`. Pour lever la restriction : `no access-class VTY-IN in`.

**Huawei VRP — `acl` sous `user-interface vty`**

```
[vrr] acl 2000
[vrr-acl-basic-2000] rule 5 permit source 10.0.0.11 0
[vrr-acl-basic-2000] rule 10 deny
[vrr-acl-basic-2000] quit
[vrr] user-interface vty 0 4
[vrr-ui-vty0-4] acl 2000 inbound
```

Depuis `lsrv` : `Connection refused`. Retrait : `undo acl inbound`.

**Cisco ASA — la règle `ssh <réseau> <masque> <interface>`**

```
asa(config)# no ssh 10.0.0.0 255.255.255.0 inside
asa(config)# ssh 10.0.0.11 255.255.255.255 inside
```

Depuis `lsrv` : **`Connection timed out`**, pas `refused`. L'ASA ne répond tout simplement pas à qui n'est pas dans la liste : la porte n'existe pas pour lui. C'est plus discret pour la sécurité, et plus déroutant pour qui diagnostique — retiens la différence.

**FortiGate — deux niveaux : le compte et l'interface**

```
fgt # config system admin
fgt (admin) # edit netadmin
fgt (netadmin) # set trusthost1 10.0.0.11 255.255.255.255
fgt (netadmin) # next
fgt (admin) # end
```

Depuis `lsrv`, le mot de passe correct est refusé : `Permission denied`. Le deuxième niveau, `allowaccess` de l'interface, agit plus bas :

```
fgt # config system interface
fgt (interface) # edit "port1"
fgt (port1) # set allowaccess ping           ← ssh retiré de la liste
fgt (port1) # next
fgt (interface) # end
```

Même depuis le poste autorisé : `Connection timed out`. Rétablis `set allowaccess ping ssh`.

**Linux — `AllowUsers`**

```
netadmin@lsrv:~$ echo "AllowUsers alice" | sudo tee -a /etc/ssh/sshd_config
netadmin@lsrv:~$ sudo systemctl restart ssh
```

`netadmin` reçoit `Permission denied`, et `auth.log` dit pourquoi : `User netadmin from 10.0.0.11 not allowed because not listed in AllowUsers`.

> 🧠 **Ce que tu viens d'apprendre** — Selon le mécanisme, le refus se lit différemment : `Connection refused` (une réponse de rejet, l'équipement existe), `Connection timed out` (silence, l'équipement se cache), `Permission denied` (la connexion a abouti, c'est le compte qui est refusé). Savoir distinguer les trois divise par deux le temps de diagnostic.

> 🔍 **Point d'audit** — Pour chaque équipement, demande : *quelles adresses peuvent ouvrir une session d'administration ?* Une liste « tout le réseau interne » est un constat ; une liste « les deux bastions » est une conformité.

---

## 20. 🧪 TP 9 — Fermer les sessions oubliées

**🎯 Objectif** — Une session d'administration ouverte et abandonnée est une session qu'un passant peut utiliser. On configure un délai d'inactivité sur chaque famille et on vérifie qu'il ferme réellement la session.

**🔧 Manipulation** — Une minute d'inactivité, pour le TP :

| Famille | Configuration |
|---|---|
| Cisco IOS | `line vty 0 4` puis `exec-timeout 1 0` |
| Huawei VRP | `user-interface vty 0 4` puis `idle-timeout 1 0` |
| Cisco ASA | `ssh timeout 1` (en minutes) |
| FortiGate | `config system global` puis `set admintimeout 1` |

Ouvre une session depuis `lpc`, **ne touche à rien pendant 90 secondes**, puis tape une commande.

**✅ Résultat attendu** — La session a été fermée : tu te retrouves sur l'invite de `lpc`. Le test avance l'horloge de simulation de 90 secondes. En témoin, avec `exec-timeout 10 0`, la même session **survit** à 90 secondes de silence — c'est ce qui prouve que le délai configuré est bien celui qui joue.

> ⚠️ **Attention** — Sur IOS, `exec-timeout 0 0` **supprime** le délai (session éternelle). C'est la configuration par défaut de nombreux laboratoires, et un constat d'audit classique.

> 🔍 **Point d'audit** — Relève la valeur de chaque délai (`show running-config | section line vty`, `display current-configuration configuration user-interface`, `show running-config | include ssh timeout`, `get system global | grep admintimeout`). Un délai de quinze minutes ou moins est la référence courante. Valeurs par défaut du simulateur : 5 minutes sur l'ASA (`ssh timeout 5`) et sur le FortiGate (`admintimeout : 5`).

---

## 21. 🧪 TP 10 — Freiner les tentatives

**🎯 Objectif** — Rendre le devinage de mot de passe coûteux, et **laisser une trace** de chaque tentative.

**🔧 Manipulation**

**Cisco IOS — mode silencieux**

```
ior(config)# login block-for 60 attempts 2 within 30
```

Après deux échecs en 30 secondes, le routeur **refuse tout nouveau login pendant 60 secondes, même avec le bon mot de passe**. `show login` annonce `Router presently in Quiet-Mode.`

**FortiGate — verrouillage de l'administrateur.** Par défaut : trois échecs, puis verrouillage de 60 secondes (`admin-lockout-threshold` et `admin-lockout-duration` dans `config system global`).

**Linux — pas de verrouillage natif par `sshd`, mais une trace par échec.** Chaque tentative ratée laisse une ligne `Failed password for netadmin from 10.0.0.11` dans `/var/log/auth.log`. C'est à un outil séparé (fail2ban, `pam_faillock`) d'en faire un verrou.

**✅ Résultat attendu** — Le test enchaîne deux échecs puis un essai au **bon** mot de passe : IOS répond `Quiet-Mode`. Sur le FortiGate, trois échecs, un essai correct refusé, puis, l'horloge avancée, une connexion qui aboutit de nouveau. Sur Linux, trois échecs ajoutent trois lignes `Failed password`.

> ⚠️ **Attention** — Un verrouillage est aussi une arme pour un attaquant : il peut **bloquer le vrai administrateur** en multipliant les échecs. C'est pourquoi la liste des adresses autorisées (TP 8) vient **avant** le verrouillage.

---

## 22. 🧪 TP 11 — La bannière légale

**🎯 Objectif** — Afficher, **avant** l'authentification, l'avertissement qui rend l'accès non autorisé juridiquement opposable : « accès réservé, activité journalisée ».

**🔧 Manipulation**

**Linux**

```
netadmin@lsrv:~$ echo 'Acces reserve au personnel autorise' | sudo tee /etc/issue.net
netadmin@lsrv:~$ echo 'Banner /etc/issue.net' | sudo tee -a /etc/ssh/sshd_config
netadmin@lsrv:~$ sudo systemctl restart ssh
```

**Cisco IOS**

```
ior(config)# banner motd ^CEquipement sous surveillance^C
```

**Huawei VRP**

```
[vrr] header login information "Acces journalise"
```

**✅ Résultat attendu** — Dans une session interactive, le texte s'affiche **avant** `netadmin@10.0.0.12's password:` sur Linux et sur VRP. Sur IOS, la bannière `motd` s'affiche à l'ouverture. En témoin, le serveur Windows, sans bannière configurée, n'affiche aucun de ces textes.

> 🧠 **Ce que tu viens d'apprendre** — Chaque famille a plusieurs bannières (`login`, `motd`, `exec` sur IOS ; `login information` et `shell` sur VRP) qui s'affichent à des moments différents. Pour un avertissement légal, c'est celle d'**avant l'authentification** qui compte : un intrus qui n'a jamais lu l'avertissement ne peut pas se le voir opposer.

> ⚠️ **Limite du simulateur** — Sur IOS, le simulateur affiche `banner motd` à l'ouverture de la session SSH mais ne présente pas `banner login` avant le mot de passe. Pour l'avertissement légal sur IOS, utilise `banner motd`. L'ordre exact des bannières IOS sur SSH n'a pas pu être attesté.

---

# Partie VII — Transférer et rebondir

---

## 23. 🧪 TP 12 — scp et sftp

**🎯 Objectif** — Copier des fichiers par le canal SSH : `scp` (copie directe) et `sftp` (session interactive de transfert).

**🔧 Manipulation**

**Linux → Linux**

```
user@lpc:~$ echo "contenu-du-tp12" > /tmp/tp12.txt
user@lpc:~$ scp /tmp/tp12.txt netadmin@10.0.0.12:/tmp/tp12.txt
tp12.txt                                100%   16    16B/s   00:00
user@lpc:~$ scp netadmin@10.0.0.12:/tmp/tp12.txt /tmp/retour.txt
```

**Linux → Windows** (compte `User`, mot de passe `user`)

```
user@lpc:~$ scp /tmp/tp12w.txt User@10.0.0.13:C:/Users/User/tp12w.txt
C:\Users\User> type tp12w.txt
vers-windows
```

**Cisco IOS — `flash:` en lecture et en écriture une fois `ip scp server enable` tapé**

```
ior(config)# ip scp server enable
user@lpc:~$ scp -O /tmp/Lab12.txt netadmin@10.0.0.15:flash:Lab12.txt
Lab12.txt                               100%   16    16B/s   00:00
ior# dir flash:
...
    3  -rwx           16  Oct 08 2026 15:06:24  Lab12.txt
user@lpc:~$ scp -O netadmin@10.0.0.15:flash:Lab12.txt /tmp/retour12.txt
```

L'option `-O` force l'ancien protocole SCP, que les routeurs Cisco attendent ; `running-config` et `startup-config` se tirent de la même façon. Le `flash:` est **le même** que celui de `dir`, `more` et `copy` : un fichier envoyé par `scp` se lit depuis la console, et réciproquement.

**Huawei VRP — le serveur SFTP est éteint par défaut, et il faut aussi l'autoriser au compte**

```
user@lpc:~$ sftp netadmin@10.0.0.17
subsystem request failed on channel 0
Connection closed

[vrr] sftp server enable
[vrr] ssh user netadmin service-type all          ← stelnet seul ne suffit pas
```

Une fois ces deux lignes passées, la session `sftp` s'ouvre.

**✅ Résultat attendu** — Les fichiers arrivent, les octets sont ceux que tu as envoyés (le test relit le contenu à l'arrivée). Sur VRP, le refus est **explicite** (`subsystem request failed`), pas une connexion qui semble marcher et ne transfère rien.

> 🧠 **Ce que tu viens d'apprendre** — SFTP n'est pas « SSH avec une option » : c'est un **sous-système** que le serveur peut refuser séparément, même quand le login interactif marche. C'est aussi un levier de durcissement : ne l'allume que là où il sert.

> ⚠️ **Limite du simulateur** — `scp` vers un ASA ou un FortiGate (`ssh scopy enable`, etc.) n'est pas fonctionnel : la directive se stocke et s'affiche, mais le transfert n'a pas lieu. Pour sauvegarder une configuration, utilise les commandes propres à la famille. Le routeur Huawei ne dispose pas encore d'un système de fichiers `flash:` : sa session SFTP s'ouvre, mais aucune commande `dir` n'y répond (la taille et la capacité de la flash de chaque modèle n'ont pas pu être attestées).

---

## 24. 🧪 TP 13 — Rebondir à travers un bastion

**🎯 Objectif** — Atteindre un équipement qu'on ne peut pas joindre directement en passant par un **bastion** (ProxyJump), ce qui permet de n'ouvrir l'accès d'administration qu'à **un seul** poste.

**🔧 Manipulation**

```
user@lpc:~$ ssh -J netadmin@10.0.0.12 netadmin@10.0.0.15 "show clock"
user@lpc:~$ ssh -J netadmin@10.0.0.12 netadmin@10.0.0.20 "get system status"
```

`lsrv` joue le bastion : `lpc` ouvre une session vers lui, puis, **à travers elle**, une seconde session vers la cible. Le mot de passe de chaque saut est demandé tour à tour.

**✅ Résultat attendu** — L'horloge du routeur Cisco et l'état du FortiGate s'affichent. Les trames qui atteignent la cible partent de `lsrv`, pas de `lpc` : c'est ce que verrait le journal d'accès de la cible, et ce qui permet de ne l'ouvrir qu'au bastion (TP 8).

Les deux cas d'échec s'expliquent par leur message :

| Situation | Message |
|---|---|
| Rien n'écoute sur le port de la cible | `Connection refused` |
| Aucune machine à cette adresse | `No route to host` |

> 🧠 **Ce que tu viens d'apprendre** — Avec un bastion, la sécurité se concentre : un seul poste à durcir, à journaliser et à surveiller. Le journal de la cible ne verra que l'adresse du bastion ; **c'est donc le journal du bastion** qui dit qui est passé.

> 🔍 **Point d'audit** — Demande où sont les journaux du bastion, qui y a accès, et combien de temps ils sont conservés.

---

# Partie VIII — Tracer et auditer

---

## 25. 🧪 TP 14 — Où est la trace ?

**🎯 Objectif** — Pour chaque famille, savoir retrouver **qui s'est connecté, d'où, quand, avec quel résultat**. Sans cela, un contrôle d'accès n'est pas auditable.

**🔧 Manipulation et ✅ résultat attendu**

| Famille | Où regarder | Ce qu'on y lit |
|---|---|---|
| Linux | `sudo grep sshd /var/log/auth.log` | `Accepted password for netadmin from 10.0.0.11 …`, `Failed password for …` |
| Cisco IOS | `show logging` | `%SSH-5-SSH2_SESSION`, et — **seulement si on les arme** — `%SEC_LOGIN-5-LOGIN_SUCCESS` / `%SEC_LOGIN-4-LOGIN_FAILED` |
| FortiGate | `execute log filter category 1` puis `execute log display` | `logdesc="Admin login successful"`, `ui="ssh(10.0.0.11)"`, `logdesc="Admin login failed"` |
| Windows | `wevtutil qe Security /c:50 /rd:true /f:text` | Événements `4624` (ouverture réussie) et `4625` (échec) |

Sur IOS, la trace de connexion **ne s'écrit pas par défaut** :

```
ior(config)# login on-success log
ior(config)# login on-failure log
ior(config)# logging buffered 8192
```

Après un login réussi puis un login raté, `show logging` contient :

```
%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success [user: netadmin] [Source: 10.0.0.11] [localport: 22]
%SSH-5-SSH2_SESSION: SSH2 Session request from 10.0.0.11 (tty = 0) using crypto cipher 'aes128-ctr', ...
%SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: netadmin] [Source: 10.0.0.11] [localport: 22] [Reason: bad password]
```

> 🔍 **Point d'audit** — Voici la grille que le test applique, et que tu appliqueras à un vrai parc : **la trace existe-t-elle ? nomme-t-elle l'utilisateur ? l'origine ? le résultat ? est-elle conservée hors de l'équipement (syslog, SIEM) ?** Un journal qui ne vit que dans la mémoire du routeur disparaît au redémarrage — et c'est exactement le moment que choisit un intrus pour redémarrer.

> ⚠️ **Limites du simulateur, à connaître avant de t'en servir comme référence** —
> • **Cisco ASA** : il n'y a pas de journal d'accès d'administration (`%ASA-6-605005`, `show ssh sessions`) ; la présentation exacte de ces lignes n'a pas pu être attestée.
> • **Huawei VRP** : `display logbuffer` ne montre pas les connexions SSH ; la nomenclature des journaux de session VRP n'a pas pu être attestée et n'est pas inventée.

---

## 26. 🧪 TP 15 — Auditer le parc depuis un seul poste

**🎯 Objectif** — Passer de « je me connecte à un équipement » à « je relève la configuration SSH de **tout** le parc en une commande ». C'est le geste de l'auditeur.

**🔧 Manipulation** — Sur `lpc`, écris un script qui interroge chaque famille avec **sa** commande (voir le tableau du § 14 pour la syntaxe du client, et la liste des commandes de relevé ci-dessous) :

```
user@lpc:~$ cat > /tmp/audit-ssh.sh <<'EOF'
#!/bin/bash
audit() { echo "== $1"; sshpass -p "$SSHPASS_VALUE" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 "netadmin@$2" "$3"; }
SSHPASS_VALUE=Secret123
audit lsrv 10.0.0.12 "ss -tln | grep :22"
audit ior  10.0.0.15 "show ip ssh"
audit vrr  10.0.0.17 "display ssh server status"
audit fgt  10.0.0.20 "show system interface port1"
EOF
user@lpc:~$ chmod +x /tmp/audit-ssh.sh
user@lpc:~$ /tmp/audit-ssh.sh
```

**✅ Résultat attendu** — Un rapport unique, quatre sections :

```
== lsrv
LISTEN 0      128          0.0.0.0:22        0.0.0.0:*
== ior
SSH Enabled - version 2.0
Authentication timeout: 120 secs; Authentication retries: 3
...
== vrr
SSH version                     : 2.0
...
Stelnet server                  : Enable
== fgt
config system interface
    edit "port1"
        set allowaccess ping ssh
```

Le test exécute ce script et vérifie qu'on lit bien, dans chaque section, le port 22 en écoute, la version 2.0, le serveur stelnet actif et `allowaccess ping ssh`.

> 🧠 **Ce que tu viens d'apprendre** — Le script n'est possible que parce que **chaque équipement accepte une commande passée en argument** de `ssh`. C'est aussi pourquoi le TP 4 (la matrice) est le prérequis de celui-ci : tant que tu n'es pas sûr de pouvoir te connecter partout, tu ne peux pas auditer partout.

> ⚠️ **Attention** — Un mot de passe en clair dans un script (`sshpass -p`) est une facilité de TP. En production, utilise des **clés** (TP 7) et un agent, jamais un secret dans un fichier.

---

## 27. La liste de contrôle de l'auditeur

Pour chaque équipement, de la plus à la moins critique :

| # | Contrôle | Comment le relever | Attendu |
|---|---|---|---|
| 1 | Version du protocole | `ssh-keyscan`, `show ip ssh`, `display ssh server status` | SSH **2** uniquement ; ASA : `ssh version 2` |
| 2 | Algorithmes | `show ip ssh`, `sudo sshd -T` | Pas de SHA-1, pas de CBC ni de 3DES ; chaque dérogation `+algo` du client est justifiée |
| 3 | Authentification | `sudo sshd -T`, `display current-configuration \| include ssh user` | Clés plutôt que mots de passe ; pas de mot de passe vide ; `PermitRootLogin no` |
| 4 | Sources autorisées | `access-class`, `acl … inbound`, `ssh <réseau> <iface>`, `trusthost`, `AllowUsers` | Liste des postes d'administration, pas « tout le LAN » |
| 5 | Délai d'inactivité | TP 9 | ≤ 15 minutes, jamais « 0 = infini » |
| 6 | Freinage des tentatives | TP 10 | Verrouillage ou limitation actif **et** journalisé |
| 7 | Bannière légale | TP 11 | Affichée avant l'authentification |
| 8 | Clé d'hôte | TP 5, 6 | Empreintes consignées dans l'inventaire ; changements rapprochés des tickets |
| 9 | Comptes | `/etc/passwd`, `show running-config \| include username`, `display local-user` | Comptes nominatifs ; pas de compte partagé ni de compte par défaut |
| 10 | Transferts | `sftp server enable`, `ssh scopy`, `Subsystem sftp` | Activés uniquement là où ils servent |
| 11 | Traçabilité | TP 14 | Succès **et** échecs journalisés, avec l'origine, et **exportés hors de l'équipement** |
| 12 | Accès par bastion | TP 13 | Les équipements ne sont joignables que depuis le bastion |

---

# Partie IX — Quand ça ne marche pas

---

## 28. Les messages d'erreur et ce qu'ils veulent dire

| Message | Ce qui se passe | Où regarder |
|---|---|---|
| `Connection refused` | Le port répond par un rejet : rien n'écoute, **ou** un filtre (`access-class`, ACL vty) rejette activement | Le service est-il démarré (TP 2) ? Une liste de sources est-elle en place (TP 8) ? |
| `Connection timed out` | Silence total : filtrage qui jette sans répondre (ASA, `allowaccess` FortiGate, pare-feu) ou équipement éteint | Règle `ssh <réseau>` de l'ASA, `allowaccess`, route de retour |
| `No route to host` | L'adresse n'a pas de machine derrière (ARP sans réponse) ou aucune route | `ping`, `arp -a`, plan d'adressage |
| `Permission denied (publickey,password)` | La connexion a abouti, l'authentification est refusée | Mot de passe, compte, `AllowUsers`, `trusthost`, clé non installée |
| `Permission denied (publickey).` | Seule la clé est acceptée, et la tienne ne l'est pas | `PasswordAuthentication no` côté serveur ; `authorized_keys` |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` | La clé d'hôte ne correspond plus à `known_hosts` | TP 6 — **enquête avant effacement** |
| `Host key verification failed.` | Tu as répondu `no`, ou la clé a changé | TP 5, TP 6 |
| `no matching key exchange method found` | Le client moderne refuse les algorithmes anciens du serveur | § 14.1 |
| `Unable to negotiate … no matching cipher / host key type found` | Même famille de cause que la ligne précédente, sur le chiffrement ou la clé d'hôte | § 14.1 |
| `subsystem request failed on channel 0` | Le serveur refuse `sftp` (ou `scp` via SFTP) | `sftp server enable` + `ssh user … service-type all` (VRP), `Subsystem sftp` (Linux) |
| `Quiet-Mode` / `Account locked` | Le freinage du TP 10 a joué | `show login` (IOS) ; attendre la durée de verrouillage (FortiGate, 60 s par défaut) |
| Le client revient sur son invite après un délai | La session a été fermée pour inactivité | TP 9 |

> 💡 **Astuce** — Ajoute `-v` à `ssh` pour voir les étapes du protocole (échange de bannières, négociation, tentatives d'authentification). Sur un message d'erreur inconnu, c'est la première chose à faire.

---

## 29. Aide-mémoire

**Clients**

| Depuis | Commande |
|---|---|
| Linux, Windows | `ssh user@host` · `ssh -J user@bastion user@cible` · `ssh -i clé` · `ssh -p 2222` |
| Cisco IOS | `ssh -l user host` |
| Huawei VRP | `stelnet host` (le nom est demandé) |
| Cisco ASA | `ssh user@host` |
| FortiGate | `execute ssh user@host` |

**Sortir** — `exit` (Linux, Windows, IOS, FortiGate) · `quit` (VRP) · `logout` (ASA)

**Serveur**

| Famille | Allumer | Vérifier |
|---|---|---|
| Linux | `sudo systemctl enable --now ssh` | `ss -tlnp \| grep :22` |
| Windows | service `sshd` | `sc query sshd`, `netstat -an \| findstr :22` |
| Cisco IOS | `ip domain-name …`, `crypto key generate rsa`, `ip ssh version 2`, `line vty` + `transport input ssh` + `login local` | `show ip ssh` |
| Huawei VRP | `rsa local-key-pair create`, `stelnet server enable`, `user-interface vty` + `protocol inbound ssh` + `authentication-mode aaa`, `ssh user …` | `display ssh server status` |
| Cisco ASA | `crypto key generate rsa`, `ssh <réseau> <masque> <iface>` | `show running-config \| include ssh` |
| FortiGate | `set allowaccess ping ssh` sur l'interface | `show system interface <port>` |

**Durcir** — sources : `access-class` / `acl … inbound` / `ssh <réseau>` / `trusthost` / `AllowUsers` · délai : `exec-timeout` / `idle-timeout` / `ssh timeout` / `admintimeout` · freinage : `login block-for` / `admin-lockout-*` · bannière : `Banner` / `banner motd` / `header login information` · version : `ssh version 2`

**Tracer** — `auth.log` · `show logging` · `execute log display` · journal Sécurité `4624/4625`

---

## Ce que ce tutoriel ne prétend pas couvrir

Honnêteté d'auditeur : voici ce que le simulateur ne fait pas, mesuré et non supposé. Chaque ligne dit aussi **pourquoi** elle reste ouverte : les documentations Cisco, Huawei et Fortinet ne sont pas joignables depuis l'environnement de développement, et le projet préfère ne rien implémenter qu'inventer un texte que l'équipement réel n'écrit pas.

- **ASA** : `show ssh sessions` et le journal d'accès d'administration ne sont pas modélisés ; `ssh scopy enable` est stocké et affiché, mais n'active aucun transfert.
- **IOS** : l'ordre exact des bannières `login` et `motd` sur SSH reste incertain (les sources publiques se contredisent) ; la copie sortante `copy scp:` / `copy ftp:` depuis la console du routeur n'est pas modélisée (`copy tftp:` l'est).
- **Huawei VRP** : les journaux de connexion SSH existent sous `SSH/4/SSH_FAIL` (échec) et `SSH/5/SSH_USER_LOGIN` (succès, selon les références de journaux de la gamme CloudEngine), mais le texte exact du message et le numéro de gabarit pour les routeurs AR n'ont pas pu être relevés ; `display logbuffer` ne les affiche donc pas. Pas de `flash:` ni de `dir`.
- **FortiGate** : la bannière d'identification SSH est de type OpenSSH ; la seule valeur retrouvée (`SSH-2.0-FortiSSH_2.5`) vient d'un message de forum vieux de vingt ans.
- **Linux** : `sshd -T` n'affiche qu'une quinzaine de directives au lieu de la centaine d'un vrai sshd.
- **Transport** : le `ProxyJump` fonctionne sur le fil ; l'authentification par clé *via* un saut qui impose lui-même un mot de passe n'est pas traitée dans ce tutoriel.

Ce qui était sur cette liste et a été **fermé** : l'authentification par clé publique sur IOS, le transfert `scp` vers et depuis le `flash:` d'IOS (routeur et commutateur), `sshd -T` refusé sans privilège, `ssh-copy-id` qui prend la clé la plus récente.

Tout ce qui est écrit dans les TP 1 à 15 est, en revanche, exécuté par `tuto-ssh-zero-a-heros.test.ts` et `tuto-ssh-matrice-equipements.test.ts` (90 couples).
