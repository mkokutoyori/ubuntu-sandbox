# Sprint 1 - Fondations

**Date:** 2025-12-12
**Statut:** Terminé

## Objectifs du Sprint

1. Restructurer les dossiers selon la nouvelle architecture
2. Créer BaseDevice et NetworkStack
3. Implémenter la simulation ARP de base
4. Connecter le terminal Linux existant aux interfaces réseau

## Travail Réalisé

### 1. Restructuration des Dossiers

Création de la nouvelle structure de dossiers selon l'architecture définie dans le ROADMAP.md :

```
src/
├── core/
│   └── network/
│       ├── index.ts          # Exports du module
│       ├── packet.ts         # Structures des paquets (Ethernet, ARP, IPv4, ICMP, TCP, UDP)
│       └── arp.ts            # Service ARP complet
│
├── devices/
│   ├── index.ts              # Exports globaux
│   ├── common/
│   │   ├── index.ts          # Exports du module
│   │   ├── types.ts          # Types communs (DeviceConfig, NetworkInterface, etc.)
│   │   ├── BaseDevice.ts     # Classe abstraite de base pour tous les équipements
│   │   └── NetworkStack.ts   # Pile réseau commune (ARP, routage, traitement paquets)
│   │
│   └── linux/
│       ├── index.ts          # Exports du module
│       └── LinuxPC.ts        # Implémentation du PC Linux
│
├── simulation/               # Préparé pour le moteur de simulation
│
└── __tests__/                # Tests unitaires
    ├── Packet.test.ts
    ├── NetworkStack.test.ts
    ├── ARP.test.ts
    └── LinuxPC.test.ts
```

### 2. Classes de Base Créées

#### BaseDevice (`src/devices/common/BaseDevice.ts`)
Classe abstraite servant de base pour tous les équipements réseau :
- Gestion du cycle de vie (power on/off)
- Accès au NetworkStack
- Interface pour l'envoi de paquets
- Méthodes abstraites : `executeCommand()`, `getPrompt()`, `getOSType()`

#### NetworkStack (`src/devices/common/NetworkStack.ts`)
Pile réseau commune avec les fonctionnalités suivantes :

**Gestion des interfaces :**
- `getInterfaces()`, `getInterface(id)`, `getInterfaceByName(name)`
- `configureInterface()` - Configuration IP, activation/désactivation
- Ajout automatique de routes connectées

**Table ARP :**
- `addARPEntry()`, `removeARPEntry()`, `lookupARP()`
- `clearDynamicARPEntries()`
- Traitement des paquets ARP (requête/réponse)

**Table de routage :**
- `addStaticRoute()`, `removeRoute()`, `lookupRoute()`
- Longest prefix match
- Routes connectées automatiques

**Utilitaires IP :**
- `isValidIP()`, `isValidNetmask()`
- `ipToNumber()`, `numberToIP()`
- `getNetworkAddress()`, `getBroadcastAddress()`
- `netmaskToPrefix()`, `prefixToNetmask()`
- `isIPInNetwork()`

### 3. Simulation ARP

#### Structures de Paquets (`src/core/network/packet.ts`)

- **EthernetFrame** : Trames Ethernet avec support VLAN
- **ARPPacket** : Paquets ARP (Request/Reply)
- **IPv4Packet** : Paquets IPv4 complets
- **ICMPPacket** : Messages ICMP (Echo Request/Reply, Destination Unreachable, Time Exceeded)
- **TCPSegment** : Segments TCP avec flags
- **UDPDatagram** : Datagrammes UDP

Fonctions helper :
- `createARPRequest()`, `createARPReply()`
- `createICMPEchoRequest()`, `createICMPEchoReply()`
- `generatePacketId()`

#### Service ARP (`src/core/network/arp.ts`)

Service ARP complet avec :
- Gestion des entrées statiques et dynamiques
- Timeout et aging des entrées
- Résolution asynchrone avec retry
- Traitement des paquets ARP entrants
- Formatage de la table ARP

### 4. LinuxPC Device

#### Implémentation (`src/devices/linux/LinuxPC.ts`)

PC Linux héritant de BaseDevice avec les commandes réseau :

**Commandes implémentées :**

| Commande | Description |
|----------|-------------|
| `ifconfig` | Configuration et affichage des interfaces |
| `ifconfig eth0 192.168.1.100 netmask 255.255.255.0` | Configuration IP |
| `ifconfig eth0 up/down` | Activation/désactivation interface |
| `ip addr` / `ip address` | Affichage des adresses |
| `ip link` | Affichage des interfaces |
| `ip route` | Affichage/gestion des routes |
| `ip route add/del` | Ajout/suppression de routes |
| `ip neigh` | Affichage de la table ARP |
| `arp -a` | Affichage de la table ARP |
| `arp -s` | Ajout d'entrée statique |
| `arp -d` | Suppression d'entrée |
| `route -n` | Table de routage |
| `hostname` | Affichage/modification hostname |
| `ping` | Simulation de ping |

### 5. Tests Unitaires

**99 tests unitaires** créés et passants :

| Fichier | Tests | Description |
|---------|-------|-------------|
| `Packet.test.ts` | 13 | Structures de paquets, constantes, création |
| `NetworkStack.test.ts` | 29 | Interfaces, IP utils, ARP table, routage |
| `ARP.test.ts` | 20 | Service ARP, entrées, lookup, traitement |
| `LinuxPC.test.ts` | 37 | Commandes Linux, configuration réseau |

**Framework de test :** Vitest

## Configuration Ajoutée

### package.json
Scripts de test ajoutés :
```json
"test": "vitest",
"test:run": "vitest run",
"test:ui": "vitest --ui"
```

### vite.config.ts
Configuration Vitest ajoutée.

## Fichiers Créés

| Fichier | Lignes | Description |
|---------|--------|-------------|
| `src/core/network/packet.ts` | ~200 | Structures de paquets |
| `src/core/network/arp.ts` | ~250 | Service ARP |
| `src/core/network/index.ts` | ~5 | Exports |
| `src/devices/common/types.ts` | ~60 | Types communs |
| `src/devices/common/BaseDevice.ts` | ~100 | Classe de base |
| `src/devices/common/NetworkStack.ts` | ~400 | Pile réseau |
| `src/devices/common/index.ts` | ~5 | Exports |
| `src/devices/linux/LinuxPC.ts` | ~450 | PC Linux |
| `src/devices/linux/index.ts` | ~5 | Exports |
| `src/devices/index.ts` | ~5 | Exports |
| `src/__tests__/*.test.ts` | ~600 | Tests unitaires |

**Total : ~2080 lignes de code**

## Prochaines Étapes (Sprint 2)

Selon le ROADMAP.md, le Sprint 2 couvrira :

1. Implémenter CiscoRouter avec modes CLI
2. Commandes show de base
3. Configuration d'interface IP
4. Routes statiques

## Notes Techniques

- TypeScript strict mode
- Architecture modulaire et extensible
- Tests unitaires avec couverture complète
- Compatible avec le terminal existant
- Prêt pour l'intégration avec le moteur de simulation
