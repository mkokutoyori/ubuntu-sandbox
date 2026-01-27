# IT Infrastructure Simulator - Guide d'utilisation

## Introduction

Bienvenue dans le **IT Infrastructure Simulator**, un simulateur réseau professionnel conçu pour les étudiants et les professionnels de l'informatique. Ce simulateur vous permet de créer, configurer et tester des topologies réseau réalistes avec des équipements authentiques (PC, serveurs, switches, routers, etc.).

## Table des matières

1. [Démarrage rapide](#démarrage-rapide)
2. [Concepts de base](#concepts-de-base)
3. [Création d'une topologie simple](#création-dune-topologie-simple)
4. [Configuration des équipements](#configuration-des-équipements)
5. [Commandes réseau](#commandes-réseau)
6. [Tests et diagnostics](#tests-et-diagnostics)
7. [Scénarios pratiques](#scénarios-pratiques)
8. [Dépannage](#dépannage)

---

## Démarrage rapide

### Installation et lancement

```bash
# Cloner le projet
git clone <repository-url>
cd ubuntu-sandbox

# Installer les dépendances
npm install

# Lancer le simulateur
npm run dev
```

Le simulateur sera accessible sur `http://localhost:5173`

### Premier test

1. Ouvrez le simulateur dans votre navigateur
2. Créez deux PC depuis le panneau latéral
3. Connectez-les ensemble
4. Configurez leurs adresses IP
5. Testez la connectivité avec `ping`

---

## Concepts de base

### Architecture du simulateur

Le simulateur implémente une pile réseau complète :

- **Couche 1 (Physique)** : Hubs, câbles
- **Couche 2 (Liaison)** : Switches, trames Ethernet, ARP
- **Couche 3 (Réseau)** : Routers, paquets IP, routage
- **Couche ICMP** : Ping, traceroute, diagnostics

### Types d'équipements disponibles

#### Ordinateurs et serveurs
- **Linux PC** : Système Ubuntu avec terminal bash
- **Windows PC** : Système Windows avec CMD
- **Linux Server** : Serveur Linux
- **Windows Server** : Serveur Windows

#### Équipements réseau
- **Hub** : Répétiteur de niveau 1 (broadcast)
- **Switch** : Commutateur de niveau 2 (apprentissage MAC)
- **Router** : Routeur de niveau 3 (routage IP)
- **Cisco Router** : Routeur Cisco avec IOS
- **Cisco Switch** : Switch Cisco avec IOS
- **Cisco L3 Switch** : Switch niveau 3 avec routing

#### Serveurs spécialisés
- **MySQL Server** : Serveur base de données MySQL
- **PostgreSQL Server** : Serveur base de données PostgreSQL
- **Oracle Database** : Serveur base de données Oracle
- **SQL Server** : Serveur Microsoft SQL Server

---

## Création d'une topologie simple

### Scénario 1 : Deux PC connectés directement

**Objectif** : Créer une connexion directe entre deux PC

#### Étape 1 : Création des équipements

1. Cliquez sur **"Linux PC"** dans le panneau latéral (2 fois)
2. Deux PC apparaissent sur le canvas

#### Étape 2 : Connexion

1. Cliquez sur le premier PC
2. Cliquez sur **"Connect"** en bas
3. Cliquez sur le deuxième PC
4. Une ligne verte apparaît entre les deux

#### Étape 3 : Configuration réseau

**PC 1 :**
```bash
# Ouvrir le terminal (clic droit > Terminal)
# Configurer l'interface
ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up
```

**PC 2 :**
```bash
# Ouvrir le terminal
# Configurer l'interface
ifconfig eth0 192.168.1.20 netmask 255.255.255.0 up
```

#### Étape 4 : Test de connectivité

Sur PC 1 :
```bash
ping 192.168.1.20
```

Résultat attendu :
```
PING 192.168.1.20 (192.168.1.20) 56(84) bytes of data.
64 bytes from 192.168.1.20: icmp_seq=1 (sent)
64 bytes from 192.168.1.20: icmp_seq=2 (sent)
...
```

### Scénario 2 : LAN avec switch

**Objectif** : Créer un réseau local avec 4 PC et 1 switch

#### Topologie

```
PC1 (192.168.1.10)    PC2 (192.168.1.20)
        \                  /
         \                /
          \              /
           \            /
            \          /
             \        /
              Switch
             /        \
            /          \
           /            \
          /              \
         /                \
PC3 (192.168.1.30)    PC4 (192.168.1.40)
```

#### Création

1. Créez 4 Linux PC
2. Créez 1 Switch
3. Connectez chaque PC au switch
4. Configurez les adresses IP :
   - PC1 : `192.168.1.10/24`
   - PC2 : `192.168.1.20/24`
   - PC3 : `192.168.1.30/24`
   - PC4 : `192.168.1.40/24`

#### Test

Depuis PC1, testez tous les autres PC :
```bash
ping 192.168.1.20
ping 192.168.1.30
ping 192.168.1.40
```

Vérifiez la table MAC du switch :
```bash
# Sur le switch (si Cisco)
show mac address-table
```

---

## Configuration des équipements

### Configuration d'un PC Linux

#### Interface réseau

```bash
# Afficher les interfaces
ifconfig

# Configurer une interface
ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up

# Ou avec notation CIDR
ip addr add 192.168.1.10/24 dev eth0
```

#### Gateway (passerelle)

```bash
# Ajouter une route par défaut
route add default gw 192.168.1.1

# Vérifier la table de routage
route -n
```

#### ARP

```bash
# Afficher la table ARP
arp -a

# Ajouter une entrée ARP manuelle
arp -s 192.168.1.1 00:11:22:33:44:55
```

### Configuration d'un PC Windows

#### Interface réseau

```cmd
# Afficher les interfaces
ipconfig

# Afficher détails complets
ipconfig /all

# Configurer IP (via l'interface graphique ou terminal)
# Note : La configuration se fait via le panneau de configuration
```

#### Gateway

```cmd
# Afficher la table de routage
route print

# Ajouter une route
route add 0.0.0.0 mask 0.0.0.0 192.168.1.1
```

#### ARP

```cmd
# Afficher la table ARP
arp -a

# Ajouter une entrée ARP
arp -s 192.168.1.1 00-11-22-33-44-55
```

### Configuration d'un Cisco Router

#### Mode privilégié

```cisco
Router> enable
Router#
```

#### Configuration globale

```cisco
Router# configure terminal
Router(config)#

# Changer le hostname
Router(config)# hostname R1
R1(config)#
```

#### Configuration d'une interface

```cisco
R1(config)# interface GigabitEthernet0/0
R1(config-if)# ip address 192.168.1.1 255.255.255.0
R1(config-if)# no shutdown
R1(config-if)# exit
```

#### Routage statique

```cisco
R1(config)# ip route 192.168.2.0 255.255.255.0 10.0.0.2
```

#### Vérifications

```cisco
# Version et informations système
R1# show version

# Configuration courante
R1# show running-config

# Interfaces
R1# show ip interface brief

# Table de routage
R1# show ip route

# Protocoles
R1# show protocols
```

### Configuration d'un Cisco Switch

#### Mode privilégié

```cisco
Switch> enable
Switch#
```

#### VLANs

```cisco
Switch# configure terminal
Switch(config)# vlan 10
Switch(config-vlan)# name Engineering
Switch(config-vlan)# exit

Switch(config)# vlan 20
Switch(config-vlan)# name Sales
Switch(config-vlan)# exit
```

#### Port en mode access

```cisco
Switch(config)# interface FastEthernet0/1
Switch(config-if)# switchport mode access
Switch(config-if)# switchport access vlan 10
Switch(config-if)# exit
```

#### Vérifications

```cisco
# Table MAC
Switch# show mac address-table

# VLANs
Switch# show vlan

# Status des ports
Switch# show interfaces status
```

---

## Commandes réseau

### Commandes Linux

#### Diagnostic réseau

```bash
# Ping - test de connectivité
ping 192.168.1.1
ping -c 4 192.168.1.1  # 4 paquets seulement

# Traceroute - tracer la route
traceroute 8.8.8.8

# Configuration réseau
ifconfig
ip addr show
ip link show

# Routage
route -n
ip route show

# ARP
arp -a
ip neigh show

# Informations système
uname -a
hostname
```

#### Résolution de problèmes

```bash
# Vérifier la connectivité de base
ping 127.0.0.1          # Loopback
ping 192.168.1.10       # IP locale
ping 192.168.1.1        # Gateway
ping 8.8.8.8            # Internet (si configuré)

# Vérifier le routage
route -n
traceroute 192.168.2.10

# Vérifier ARP
arp -a
```

### Commandes Windows

#### Diagnostic réseau

```cmd
# Ping
ping 192.168.1.1
ping -n 4 192.168.1.1   # 4 paquets

# Traceroute (tracert)
tracert 8.8.8.8

# Configuration réseau
ipconfig
ipconfig /all

# Routage
route print

# ARP
arp -a

# Informations système
systeminfo
hostname
```

### Commandes Cisco IOS

#### Show commands (Router)

```cisco
# Version et uptime
show version

# Configuration
show running-config
show startup-config

# Interfaces
show interfaces
show ip interface brief
show ip interface GigabitEthernet0/0

# Routage
show ip route
show ip protocols

# ARP
show arp
show ip arp
```

#### Show commands (Switch)

```cisco
# MAC address table
show mac address-table
show mac address-table dynamic

# VLANs
show vlan
show vlan brief

# Spanning Tree
show spanning-tree
show spanning-tree summary

# Interfaces
show interfaces
show interfaces status
```

---

## Tests et diagnostics

### Test de connectivité de base

#### 1. Vérifier la configuration locale

```bash
# Linux
ifconfig eth0

# Windows
ipconfig

# Vérifications :
# - Adresse IP configurée ?
# - Interface UP ?
# - Netmask correct ?
```

#### 2. Tester la connectivité locale

```bash
# Ping vers soi-même (loopback)
ping 127.0.0.1

# Ping vers sa propre IP
ping 192.168.1.10
```

#### 3. Tester la connectivité sur le même réseau

```bash
# Ping vers un autre hôte du même réseau
ping 192.168.1.20

# Vérifier ARP
arp -a  # Doit montrer l'entrée pour .20
```

#### 4. Tester la connectivité inter-réseaux

```bash
# Ping vers gateway
ping 192.168.1.1

# Ping vers réseau distant
ping 192.168.2.10

# Traceroute pour voir le chemin
traceroute 192.168.2.10
```

### Diagnostics avancés

#### Problème : "Destination Host Unreachable"

**Causes possibles :**
1. Pas d'entrée ARP
2. Interface down
3. Pas de route

**Solutions :**
```bash
# Vérifier ARP
arp -a

# Vérifier interface
ifconfig eth0

# Vérifier routage
route -n

# Ajouter route si nécessaire
route add -net 192.168.2.0/24 gw 192.168.1.1
```

#### Problème : "Network Unreachable"

**Causes possibles :**
1. Pas de gateway configuré
2. Pas de route vers le réseau

**Solutions :**
```bash
# Configurer gateway
route add default gw 192.168.1.1

# Vérifier table de routage
route -n
```

#### Problème : TTL Expired

**Cause :** Boucle de routage

**Solution :**
```bash
# Tracer la route
traceroute 192.168.2.10

# Vérifier les tables de routage des routers
```

### Utilisation de traceroute

Le traceroute permet de voir le chemin complet :

```bash
# Linux
traceroute 192.168.3.10

# Windows
tracert 192.168.3.10
```

**Exemple de sortie :**
```
traceroute to 192.168.3.10, 30 hops max
 1  192.168.1.1 (192.168.1.1)  1ms
 2  10.0.0.2 (10.0.0.2)  2ms
 3  192.168.3.1 (192.168.3.1)  3ms
 4  192.168.3.10 (192.168.3.10)  4ms
```

Cela montre que le paquet traverse 4 hops (sauts).

---

## Scénarios pratiques

### Scénario 3 : Réseau inter-bureaux avec routeur

**Objectif** : Connecter deux réseaux locaux via un routeur

#### Topologie

```
Réseau Bureau A (192.168.1.0/24)    Réseau Bureau B (192.168.2.0/24)

PC1 (.10)                           PC3 (.10)
PC2 (.20)                           PC4 (.20)
   \  /                                \  /
  Switch1                             Switch2
     |                                   |
     |                                   |
   (.1)                                (.1)
     \                                 /
      \                               /
       \                             /
        \          Router           /
         \       (.1)   (.1)       /
          \--(eth0)  (eth1)---/
              192.168.1.1  192.168.2.1
```

#### Configuration

**Router :**
```bash
# Interface vers Bureau A
ifconfig eth0 192.168.1.1 netmask 255.255.255.0 up

# Interface vers Bureau B
ifconfig eth1 192.168.2.1 netmask 255.255.255.0 up

# Activer le forwarding IP
echo 1 > /proc/sys/net/ipv4/ip_forward
```

**PC Bureau A (PC1) :**
```bash
ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up
route add default gw 192.168.1.1
```

**PC Bureau B (PC3) :**
```bash
ifconfig eth0 192.168.2.10 netmask 255.255.255.0 up
route add default gw 192.168.2.1
```

#### Test

Depuis PC1 (Bureau A), ping vers PC3 (Bureau B) :
```bash
ping 192.168.2.10
traceroute 192.168.2.10
```

### Scénario 4 : Réseau d'entreprise complet

**Topologie complexe avec plusieurs routers et VLANs**

```
                    Internet (simulé)
                         |
                    Router Core
                    /          \
                   /            \
            Router Dept1    Router Dept2
               /    \           /    \
              /      \         /      \
        Switch1   Switch2  Switch3  Switch4
         (VLAN10) (VLAN20) (VLAN30) (VLAN40)
           |         |        |        |
         PC IT   PC Sales  PC HR   PC Finance
```

#### Configuration des VLANs

**Switch (Cisco) :**
```cisco
enable
configure terminal

# Créer VLANs
vlan 10
 name IT
vlan 20
 name Sales
vlan 30
 name HR
vlan 40
 name Finance

# Configurer ports
interface range FastEthernet0/1-5
 switchport mode access
 switchport access vlan 10

interface range FastEthernet0/6-10
 switchport mode access
 switchport access vlan 20
```

#### Configuration du routage inter-VLAN

**Router (sub-interfaces) :**
```cisco
enable
configure terminal

# Interface physique
interface GigabitEthernet0/0
 no shutdown

# Sub-interface VLAN 10
interface GigabitEthernet0/0.10
 encapsulation dot1Q 10
 ip address 192.168.10.1 255.255.255.0

# Sub-interface VLAN 20
interface GigabitEthernet0/0.20
 encapsulation dot1Q 20
 ip address 192.168.20.1 255.255.255.0
```

### Scénario 5 : LAN mixte Linux/Windows avec serveur

**Objectif** : Créer un LAN réaliste avec des clients Linux, Windows et un serveur

#### Topologie

```
       Linux PC 1                Windows PC 1
    (192.168.1.10)              (192.168.1.30)
           \                         /
            \                       /
             \                     /
              \                   /
               \                 /
                \               /
                    Switch
                /               \
               /                 \
              /                   \
             /                     \
            /                       \
       Linux PC 2                Linux Server
    (192.168.1.20)              (192.168.1.100)
```

#### Configuration des équipements

**Linux PC 1 :**
```bash
# Configuration IP moderne avec commande ip
ip addr add 192.168.1.10/24 dev eth0
ip link set eth0 up

# Vérification
ip addr show eth0
```

**Linux PC 2 :**
```bash
ip addr add 192.168.1.20/24 dev eth0
ip link set eth0 up
```

**Windows PC 1 :**
```cmd
# Configuration via netsh (méthode moderne Windows)
netsh interface ip set address "Ethernet0" static 192.168.1.30 255.255.255.0

# Vérification
ipconfig /all
```

**Linux Server :**
```bash
# Le serveur a 4 interfaces réseau (eth0-eth3)
ip addr add 192.168.1.100/24 dev eth0
ip link set eth0 up

# Vérifier les services disponibles
systemctl list-units --type=service

# Démarrer un service (ex: nginx)
systemctl start nginx
systemctl status nginx
```

#### Test de connectivité

**Depuis Linux PC 1 :**
```bash
# Ping vers Windows
ping -c 4 192.168.1.30

# Ping vers serveur
ping -c 4 192.168.1.100

# Traceroute
traceroute 192.168.1.100
```

**Depuis Windows PC 1 :**
```cmd
# Ping vers Linux
ping -n 4 192.168.1.10

# Ping vers serveur
ping -n 4 192.168.1.100

# ARP table
arp -a
```

**Depuis Linux Server :**
```bash
# Ping vers tous les clients
ping -c 1 192.168.1.10
ping -c 1 192.168.1.20
ping -c 1 192.168.1.30

# Afficher les logs du système
journalctl -n 20

# Voir les connexions réseau
ss -tln
```

#### Fonctionnalités avancées du serveur

```bash
# Gestion complète des services
systemctl status ssh
systemctl start nginx
systemctl enable apache2
systemctl restart mysql

# Gestion du firewall
ufw status
ufw allow 80/tcp
ufw enable

# Configuration réseau avancée
# Le serveur supporte iptables complet
iptables -L
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
```

### Scénario 6 : Serveur Web accessible depuis le LAN

**Objectif** : Configurer un serveur Web Linux accessible depuis le réseau

#### Topologie

```
PC Client (192.168.1.10)
         |
      Switch
         |
Linux Server (192.168.1.100)
[Apache/Nginx installé]
```

#### Configuration

**Serveur Linux :**
```bash
# Configuration réseau
ifconfig eth0 192.168.1.100 netmask 255.255.255.0 up

# Installer et démarrer le serveur web (simulé)
# Dans un vrai scénario:
# apt-get update
# apt-get install nginx
# systemctl start nginx
```

**PC Client :**
```bash
# Configuration réseau
ifconfig eth0 192.168.1.10 netmask 255.255.255.0 up

# Tester la connectivité
ping 192.168.1.100

# Tester le serveur web (si curl disponible)
curl http://192.168.1.100
```

---

## Dépannage

### Checklist de dépannage réseau

#### 1. Couche Physique (L1)

- [ ] Les équipements sont-ils allumés (powered on) ?
- [ ] Les câbles sont-ils connectés ?
- [ ] Les interfaces sont-elles UP ?

```bash
# Vérifier status interface
ifconfig eth0
# Chercher "UP" dans les flags
```

#### 2. Couche Liaison (L2)

- [ ] Les adresses MAC sont-elles visibles ?
- [ ] Le switch apprend-il les MAC ?
- [ ] ARP fonctionne-t-il ?

```bash
# Vérifier ARP
arp -a

# Sur switch Cisco
show mac address-table
```

#### 3. Couche Réseau (L3)

- [ ] Les IP sont-elles configurées ?
- [ ] Les masques sont-ils corrects ?
- [ ] Les gateways sont-elles configurées ?
- [ ] Le routage est-il configuré ?

```bash
# Vérifier IP
ifconfig

# Vérifier routage
route -n

# Tester gateway
ping 192.168.1.1
```

#### 4. Couche Transport et supérieure

- [ ] ICMP fonctionne-t-il ?
- [ ] Les services sont-ils démarrés ?

```bash
# Test ICMP
ping <destination>

# Test traceroute
traceroute <destination>
```

### Résolution ARP automatique

Le simulateur implémente une résolution ARP automatique réaliste :

1. **Quand vous pingez une IP pour la première fois**, le PC envoie une requête ARP broadcast
2. **Le destinataire répond** avec son adresse MAC
3. **L'entrée ARP est mise en cache** pour les communications futures

```bash
# Vérifier le cache ARP après un ping
ping -c 1 192.168.1.20
arp -a
# Vous devriez voir l'entrée pour 192.168.1.20

# Sur Linux moderne
ip neigh show
```

**Note** : Si le ping échoue avec "Destination host unreachable (ARP timeout)", cela signifie que la cible n'a pas répondu à la requête ARP - vérifiez la configuration réseau de la cible.

### Problèmes courants et solutions

#### Problème : Ping ne fonctionne pas entre deux PC

**Diagnostic :**
```bash
# Sur PC source
ping 192.168.1.20
# Résultat: "Destination Host Unreachable" ou timeout

# Étape 1 : Vérifier IP locale
ifconfig eth0
# IP correcte ? Interface UP ?

# Étape 2 : Vérifier ARP
arp -a
# Entrée pour .20 existe ?

# Étape 3 : Vérifier sur PC destination
ifconfig eth0
# IP configurée ? Interface UP ?
```

**Solutions possibles :**
1. Configurer les IP si manquantes
2. Vérifier que les interfaces sont UP
3. Vérifier la connexion physique
4. Redémarrer les équipements

#### Problème : Routage ne fonctionne pas

**Diagnostic :**
```bash
# Test vers gateway
ping 192.168.1.1
# OK ? Sinon problème local

# Test vers réseau distant
ping 192.168.2.10
# Échec ? Problème de routage

# Vérifier table de routage
route -n
# Gateway configuré ?

# Traceroute pour voir où ça bloque
traceroute 192.168.2.10
```

**Solutions possibles :**
1. Configurer gateway : `route add default gw 192.168.1.1`
2. Vérifier routage sur le router
3. Vérifier que le router a le forwarding activé
4. Vérifier les routes statiques

#### Problème : Switch ne forward pas

**Diagnostic :**
```bash
# Sur switch Cisco
show mac address-table
# Les MAC sont-elles apprises ?

show interfaces status
# Les ports sont-ils UP ?

show vlan
# Les VLANs sont-ils corrects ?
```

**Solutions :**
1. Vérifier que le switch est allumé
2. Vérifier les VLANs
3. Vérifier la configuration des ports

### Messages d'erreur et leur signification

| Message | Signification | Solution |
|---------|--------------|----------|
| Destination Host Unreachable | L'hôte ne répond pas (pas d'ARP) | Vérifier IP, interface, connexion |
| Network Unreachable | Pas de route vers le réseau | Configurer gateway/route |
| TTL Expired | Boucle de routage | Vérifier tables de routage |
| Request Timeout | Pas de réponse dans le délai | Vérifier firewall, connectivité |
| Connection Refused | Port fermé | Vérifier service, firewall |

---

## Astuces et bonnes pratiques

### Planification de réseau

1. **Documenter** : Dessinez votre topologie avant de la créer
2. **Plan d'adressage** : Définissez vos plages IP à l'avance
3. **Nommage** : Utilisez des noms explicites (PC-Bureau1, SW-Core, etc.)
4. **Segmentation** : Utilisez des sous-réseaux logiques

### Tests progressifs

1. Tester niveau par niveau (L1 → L2 → L3)
2. Tester la connectivité locale avant l'inter-réseau
3. Utiliser ping et traceroute systématiquement
4. Documenter ce qui fonctionne

### Organisation

1. Grouper les équipements similaires visuellement
2. Utiliser des couleurs pour les différents réseaux
3. Nommer clairement les connexions
4. Sauvegarder régulièrement la topologie

### Commandes utiles à retenir

**Linux :**
```bash
# Quick network check
ifconfig && route -n && arp -a

# Quick connectivity test
ping -c 4 <IP> && traceroute <IP>
```

**Cisco :**
```cisco
# Quick router check
show ip interface brief
show ip route
show ip protocols

# Quick switch check
show vlan brief
show mac address-table
show interfaces status
```

---

## Ressources supplémentaires

### Documentation technique

- **RFC 791** : Internet Protocol (IP)
- **RFC 792** : Internet Control Message Protocol (ICMP)
- **RFC 826** : Address Resolution Protocol (ARP)
- **IEEE 802.3** : Ethernet

### Exercices pratiques recommandés

1. **Débutant** : Créer un LAN simple (2-4 PC + switch)
2. **Intermédiaire** : Connecter deux LANs avec un router
3. **Avancé** : Créer un réseau d'entreprise avec VLANs
4. **Expert** : Implémenter des routeurs multiples avec routage dynamique

### Support et communauté

- **Issues GitHub** : Rapporter des bugs ou suggestions
- **Documentation** : README.md du projet
- **Tests** : Dossier `src/__tests__` pour exemples de code

---

## Annexes

### Tableau des plages IP privées

| Classe | Plage | Masque par défaut | CIDR |
|--------|-------|-------------------|------|
| A | 10.0.0.0 - 10.255.255.255 | 255.0.0.0 | /8 |
| B | 172.16.0.0 - 172.31.255.255 | 255.240.0.0 | /12 |
| C | 192.168.0.0 - 192.168.255.255 | 255.255.0.0 | /16 |

### Ports TCP/UDP courants

| Port | Protocole | Service |
|------|-----------|---------|
| 20/21 | TCP | FTP |
| 22 | TCP | SSH |
| 23 | TCP | Telnet |
| 25 | TCP | SMTP |
| 53 | TCP/UDP | DNS |
| 80 | TCP | HTTP |
| 443 | TCP | HTTPS |
| 3306 | TCP | MySQL |
| 5432 | TCP | PostgreSQL |

### Notations CIDR courantes

| CIDR | Masque | Hôtes utilisables |
|------|--------|-------------------|
| /8 | 255.0.0.0 | 16,777,214 |
| /16 | 255.255.0.0 | 65,534 |
| /24 | 255.255.255.0 | 254 |
| /25 | 255.255.255.128 | 126 |
| /26 | 255.255.255.192 | 62 |
| /27 | 255.255.255.224 | 30 |
| /28 | 255.255.255.240 | 14 |
| /29 | 255.255.255.248 | 6 |
| /30 | 255.255.255.252 | 2 |

---

## Conclusion

Ce simulateur est un outil puissant pour apprendre et pratiquer les concepts réseau. Commencez par des topologies simples et progressez vers des scénarios plus complexes.

**Bon apprentissage !** 🚀

---

*Dernière mise à jour : Sprint 6 - Héritage complet serveurs, ARP automatique, LANs mixtes*
*Version du simulateur : 1.6.0*

### Nouveautés version 1.6.0

- **Héritage serveurs complet** : LinuxServer et WindowsServer héritent correctement de toutes les commandes de leurs parents (LinuxPC, WindowsPC)
- **Interfaces multiples** : Les serveurs ont 4 interfaces réseau (eth0-eth3) avec gestion complète
- **Résolution ARP automatique** : Le ping envoie automatiquement des requêtes ARP si le MAC n'est pas en cache
- **Support ping avancé** : `ping -c N <ip>` pour spécifier le nombre de paquets
- **Statistiques ping** : Affichage des RTT min/avg/max/mdev
- **Gestion services complète** : systemctl, service, journalctl, update-rc.d, chkconfig
- **Commandes réseau Linux** : ip, nmcli, ss, iptables, ufw, ethtool, dig, nslookup, resolvectl
- **Commandes Windows avancées** : netsh interface, netsh advfirewall, ipconfig /all avec DNS
