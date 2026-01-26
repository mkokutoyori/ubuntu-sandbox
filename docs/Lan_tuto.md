# Tutoriel : Créer votre premier réseau local (LAN)

## Introduction

Ce tutoriel vous guidera pas à pas dans la création d'un réseau local simple avec notre simulateur. À la fin, vous saurez :
- Créer des équipements réseau (ordinateurs, switch)
- Les connecter entre eux
- Configurer leurs adresses IP
- Tester la connectivité avec la commande `ping`

**Aucune connaissance préalable en réseau n'est requise.**

---

## 1. Comprendre les bases

### Qu'est-ce qu'un réseau local (LAN) ?

Un **LAN** (Local Area Network) est un réseau qui connecte des ordinateurs dans une zone limitée (maison, école, bureau). Imaginez-le comme un système de routes qui permet aux ordinateurs de "se parler".

### Les équipements dont nous avons besoin

| Équipement | Rôle | Analogie |
|------------|------|----------|
| **PC (Ordinateur)** | Envoie et reçoit des données | Une maison qui envoie et reçoit du courrier |
| **Switch** | Connecte plusieurs PCs ensemble | Un bureau de poste qui trie et distribue le courrier |
| **Câble réseau** | Transporte les données | Les routes entre les maisons |

### Qu'est-ce qu'une adresse IP ?

Une **adresse IP** est comme l'adresse postale d'un ordinateur. Elle permet aux autres ordinateurs de savoir où envoyer les données.

Exemple : `192.168.1.10`

- Chaque nombre va de 0 à 255
- Les ordinateurs sur le même réseau local partagent les mêmes 3 premiers nombres (ex: `192.168.1.X`)

---

## 2. Schéma du réseau que nous allons créer

```
    ┌─────────────┐              ┌─────────────┐
    │    PC1      │              │    PC2      │
    │ Linux       │              │ Windows     │
    │192.168.1.10 │              │192.168.1.20 │
    └──────┬──────┘              └──────┬──────┘
           │ eth0                  eth0 │
           │                            │
           │         ┌────────┐         │
           └─────────┤ Switch ├─────────┘
                     │  (SW1) │
                     └────────┘
```

**Objectif** : PC1 et PC2 pourront communiquer via le Switch.

---

## 3. Étape 1 : Créer les équipements

### 3.1 Créer le premier ordinateur (PC1 - Linux)

1. Dans la barre d'outils, cliquez sur **"Linux PC"**
2. Cliquez sur le canvas pour placer l'ordinateur
3. L'ordinateur apparaît avec le nom `LinuxPC-1`

### 3.2 Créer le second ordinateur (PC2 - Windows)

1. Cliquez sur **"Windows PC"**
2. Placez-le à droite du premier

### 3.3 Créer le Switch

1. Cliquez sur **"Cisco Switch"**
2. Placez-le entre les deux ordinateurs

**Résultat** : Vous devriez avoir 3 équipements sur votre écran.

---

## 4. Étape 2 : Connecter les équipements

### Comprendre les ports et interfaces

- **PC** : possède une interface réseau appelée `eth0` (comme une prise réseau sur un ordinateur)
- **Switch** : possède plusieurs ports (`eth0`, `eth1`, `eth2`, ...) pour connecter plusieurs appareils

### 4.1 Connecter PC1 au Switch

1. Cliquez sur **"Câble"** ou l'outil de connexion
2. Cliquez sur **PC1** puis sélectionnez son port `eth0`
3. Cliquez sur le **Switch** puis sélectionnez son port `eth0`

Une ligne apparaît reliant PC1 au Switch.

### 4.2 Connecter PC2 au Switch

1. Gardez l'outil câble sélectionné
2. Cliquez sur **PC2** → port `eth0`
3. Cliquez sur le **Switch** → port `eth1`

**Résultat** : Les trois équipements sont maintenant connectés physiquement.

```
PC1 (eth0) ──── eth0 [Switch] eth1 ──── PC2 (eth0)
```

---

## 5. Étape 3 : Configurer les adresses IP

Maintenant que les câbles sont en place, il faut donner une adresse à chaque PC pour qu'ils sachent où envoyer leurs données.

### 5.1 Ouvrir le terminal de PC1

1. Double-cliquez sur **PC1**
2. Un terminal s'ouvre (comme l'invite de commandes)

### 5.2 Vérifier l'état actuel de l'interface

Tapez la commande :
```bash
ifconfig
```

Vous verrez quelque chose comme :
```
eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>
      ether 00:1A:2B:3C:4D:5E  (adresse MAC)
      inet: not configured      (pas d'IP configurée)
```

### 5.3 Configurer l'adresse IP de PC1

Tapez la commande :
```bash
ifconfig eth0 192.168.1.10 netmask 255.255.255.0
```

**Explication** :
- `ifconfig` : commande pour configurer l'interface réseau
- `eth0` : nom de l'interface à configurer
- `192.168.1.10` : l'adresse IP que nous donnons à PC1
- `netmask 255.255.255.0` : le masque de sous-réseau (définit quels ordinateurs sont sur le même réseau)

### 5.4 Vérifier la configuration

```bash
ifconfig
```

Vous devriez voir maintenant :
```
eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>
      inet 192.168.1.10  netmask 255.255.255.0
      ether 00:1A:2B:3C:4D:5E
```

### 5.5 Configurer PC2

1. Double-cliquez sur **PC2** pour ouvrir son terminal
2. Sur Windows, utilisez la commande `ipconfig` pour voir, ou `netsh` pour configurer :

```cmd
ipconfig
```

Pour configurer l'IP sur Windows :
```cmd
netsh interface ip set address "eth0" static 192.168.1.20 255.255.255.0
```

Ou si la commande `ifconfig` est disponible :
```bash
ifconfig eth0 192.168.1.20 netmask 255.255.255.0
```

---

## 6. Étape 4 : Tester la connectivité avec Ping

### Qu'est-ce que le ping ?

Le **ping** est comme envoyer un "coucou" à un autre ordinateur pour vérifier qu'il répond. C'est le test de base pour vérifier la connectivité réseau.

### 6.1 Depuis PC1, pinguer PC2

Dans le terminal de PC1, tapez :
```bash
ping 192.168.1.20
```

**Résultat attendu** :
```
PING 192.168.1.20 (192.168.1.20) 56(84) bytes of data.
64 bytes from 192.168.1.20: icmp_seq=1 ttl=64 time=0.5 ms
64 bytes from 192.168.1.20: icmp_seq=2 ttl=64 time=0.4 ms
64 bytes from 192.168.1.20: icmp_seq=3 ttl=64 time=0.3 ms
--- 192.168.1.20 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss
```

**Interprétation** :
- `64 bytes from 192.168.1.20` : PC2 a répondu
- `icmp_seq=1, 2, 3` : numéro de chaque "coucou" envoyé
- `time=0.5 ms` : temps de réponse (très rapide)
- `0% packet loss` : tous les paquets sont arrivés

### 6.2 Depuis PC2, pinguer PC1

Dans le terminal de PC2, tapez :
```cmd
ping 192.168.1.10
```

Sur Windows, l'affichage est légèrement différent :
```
Pinging 192.168.1.10 with 32 bytes of data:
Reply from 192.168.1.10: bytes=32 time<1ms TTL=64
Reply from 192.168.1.10: bytes=32 time<1ms TTL=64

Ping statistics for 192.168.1.10:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss)
```

**Félicitations !** Votre réseau local fonctionne !

---

## 7. Étape 5 : Commandes utiles sur les équipements

### Sur un PC Linux

| Commande | Description |
|----------|-------------|
| `ifconfig` | Affiche la configuration réseau |
| `ifconfig eth0 IP netmask MASK` | Configure une adresse IP |
| `ping IP` | Teste la connectivité vers une IP |
| `traceroute IP` | Affiche le chemin vers une IP |
| `hostname` | Affiche le nom de l'ordinateur |
| `clear` | Efface l'écran du terminal |

### Sur un PC Windows

| Commande | Description |
|----------|-------------|
| `ipconfig` | Affiche la configuration réseau |
| `ipconfig /all` | Affiche les détails complets |
| `ping IP` | Teste la connectivité |
| `tracert IP` | Affiche le chemin vers une IP |
| `hostname` | Affiche le nom de l'ordinateur |
| `cls` | Efface l'écran |

### Sur un Switch/Router Cisco

Pour les équipements Cisco, le terminal fonctionne comme un vrai IOS Cisco :

```
Switch>enable                    # Passe en mode privilégié
Switch#show mac address-table    # Affiche la table des adresses MAC
Switch#configure terminal        # Entre en mode configuration
Switch(config)#hostname SW1      # Change le nom du switch
SW1(config)#vlan 10              # Crée un VLAN
SW1(config-vlan)#name ETUDIANTS  # Nomme le VLAN
SW1(config-vlan)#end             # Sort du mode configuration
SW1#show vlan brief              # Affiche les VLANs
```

---

## 8. Comprendre ce qui se passe en coulisses

### Le rôle du Switch

Quand PC1 envoie un ping à PC2 :

1. **PC1** crée un paquet avec :
   - Source : `192.168.1.10`
   - Destination : `192.168.1.20`

2. **PC1** encapsule ce paquet dans une trame Ethernet avec :
   - MAC source : `00:1A:2B:3C:4D:5E` (MAC de PC1)
   - MAC destination : `00:11:22:33:44:55` (MAC de PC2)

3. **Le Switch** reçoit la trame sur le port `eth0` :
   - Il apprend que PC1 est sur le port `eth0`
   - Il regarde sa table MAC pour trouver où est PC2
   - Il envoie la trame sur le port `eth1`

4. **PC2** reçoit la trame et répond

### Table MAC du Switch

Vous pouvez voir ce que le switch a appris :
```
SW1#show mac address-table

          Mac Address Table
-------------------------------------------
Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
1       00:1A:2B:3C:4D:5E DYNAMIC     eth0
1       00:11:22:33:44:55 DYNAMIC     eth1

Total Mac Addresses: 2
```

---

## 9. Exercices pratiques

### Exercice 1 : Ajouter un troisième PC

1. Ajoutez un PC3 (Linux ou Windows)
2. Connectez-le au port `eth2` du Switch
3. Configurez l'IP : `192.168.1.30`
4. Vérifiez que PC3 peut pinguer PC1 et PC2

### Exercice 2 : Changer les adresses IP

1. Changez l'IP de PC1 en `10.0.0.1`
2. Changez l'IP de PC2 en `10.0.0.2`
3. Testez le ping

**Question** : Avec l'adresse `192.168.1.30`, PC3 peut-il encore communiquer avec PC1 et PC2 ? Pourquoi ?

### Exercice 3 : Explorer les commandes Cisco

1. Ouvrez le terminal du Switch
2. Entrez en mode privilégié avec `enable`
3. Affichez la version avec `show version`
4. Créez un VLAN 10 appelé "LABORATOIRE"
5. Affichez la liste des VLANs

---

## 10. Résolution de problèmes courants

### "Destination host unreachable"

**Cause possible** : Les PCs ne sont pas sur le même réseau.

**Solution** : Vérifiez que les 3 premiers nombres de l'IP sont identiques (ex: `192.168.1.X`)

### "Request timed out"

**Cause possible** : L'équipement cible n'est pas connecté ou éteint.

**Solution** :
1. Vérifiez que tous les équipements sont allumés
2. Vérifiez que les câbles sont bien connectés
3. Vérifiez la configuration IP du destinataire

### "Network interface not configured"

**Cause possible** : Vous n'avez pas configuré d'adresse IP.

**Solution** : Utilisez `ifconfig` ou `ipconfig` pour configurer une IP.

---

## 11. Récapitulatif des étapes

1. **Créer** les équipements (PCs + Switch)
2. **Connecter** les PCs au Switch avec des câbles
3. **Configurer** les adresses IP sur chaque PC
4. **Tester** avec la commande `ping`

---

## 12. Glossaire

| Terme | Définition |
|-------|------------|
| **LAN** | Local Area Network - réseau local |
| **IP** | Internet Protocol - protocole d'adressage |
| **MAC** | Media Access Control - adresse physique unique d'une carte réseau |
| **Switch** | Équipement qui connecte plusieurs appareils et dirige le trafic |
| **Ping** | Commande pour tester la connectivité réseau |
| **Interface** | Point de connexion réseau (ex: eth0) |
| **Masque** | Détermine la taille du réseau (ex: 255.255.255.0 = 254 adresses possibles) |
| **Trame** | Unité de données au niveau Ethernet (couche 2) |
| **Paquet** | Unité de données au niveau IP (couche 3) |
| **VLAN** | Virtual LAN - réseau virtuel isolé |

---

## Prochaines étapes

Une fois ce tutoriel maîtrisé, vous pourrez explorer :
- La configuration de VLANs pour séparer les réseaux
- L'ajout de routeurs pour connecter différents réseaux
- La configuration de spanning-tree pour la redondance
- Les listes de contrôle d'accès (ACL) pour la sécurité

**Bon apprentissage !**
