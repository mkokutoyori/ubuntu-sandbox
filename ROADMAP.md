# NetSim - Network Simulator Roadmap

## Vision du Projet

NetSim est un simulateur de réseau moderne inspiré de Packet Tracer, entièrement frontend (sans backend). Il permet de concevoir des topologies réseau, configurer des équipements et simuler le trafic réseau.

---

## Architecture Actuelle

### Ce qui existe déjà

```
src/
├── network/                    # Designer réseau
│   ├── types.ts               # Types: DeviceType, Connection, Interface
│   ├── store.ts               # État global (Zustand)
│   ├── NetworkDesigner.tsx    # Composant principal
│   └── components/
│       ├── NetworkCanvas.tsx  # Canvas drag-drop
│       ├── DevicePalette.tsx  # Palette d'équipements
│       ├── NetworkDevice.tsx  # Composant équipement
│       ├── ConnectionLine.tsx # Lignes de connexion
│       ├── PropertiesPanel.tsx # Panneau propriétés
│       ├── DeviceIcon.tsx     # Icônes équipements
│       └── TerminalModal.tsx  # Modal terminal
│
├── terminal/                   # Terminal Linux (fonctionnel)
│   ├── filesystem.ts          # Système de fichiers
│   ├── commands/              # Commandes bash
│   └── python/                # Interpréteur Python
│
└── components/
    └── Terminal.tsx           # Composant terminal
```

---

## Phase 1: Restructuration et Organisation

### 1.1 Nouvelle Structure des Dossiers

```
src/
├── core/                       # Noyau de simulation
│   ├── network/               # Simulation réseau
│   │   ├── packet.ts         # Structure des paquets
│   │   ├── arp.ts            # Table ARP
│   │   ├── routing.ts        # Table de routage
│   │   ├── dhcp.ts           # Service DHCP
│   │   └── dns.ts            # Service DNS
│   │
│   ├── layer2/               # Couche 2
│   │   ├── ethernet.ts       # Frames Ethernet
│   │   ├── vlan.ts           # VLANs
│   │   ├── stp.ts            # Spanning Tree
│   │   └── mac-table.ts      # Table MAC
│   │
│   └── services/             # Services réseau
│       ├── http.ts           # Serveur HTTP
│       ├── ftp.ts            # Serveur FTP
│       ├── ssh.ts            # Service SSH
│       └── telnet.ts         # Service Telnet
│
├── devices/                    # Équipements par type
│   ├── common/               # Code commun
│   │   ├── BaseDevice.ts    # Classe de base
│   │   ├── BaseOS.ts        # OS de base
│   │   └── NetworkStack.ts  # Pile réseau commune
│   │
│   ├── linux/                # Systèmes Linux
│   │   ├── LinuxPC.ts       # PC Linux
│   │   ├── LinuxServer.ts   # Serveur Linux
│   │   ├── os/              # OS Linux
│   │   │   ├── kernel.ts
│   │   │   ├── networking.ts
│   │   │   └── services.ts
│   │   └── commands/        # Commandes spécifiques
│   │
│   ├── windows/              # Systèmes Windows
│   │   ├── WindowsPC.ts
│   │   ├── WindowsServer.ts
│   │   ├── os/
│   │   │   ├── cmd.ts       # Command Prompt
│   │   │   ├── powershell.ts
│   │   │   └── networking.ts
│   │   └── commands/
│   │
│   ├── cisco/                # Équipements Cisco
│   │   ├── CiscoRouter.ts
│   │   ├── CiscoSwitch.ts
│   │   ├── CiscoASA.ts
│   │   ├── ios/             # Cisco IOS
│   │   │   ├── parser.ts    # Parser de commandes
│   │   │   ├── modes.ts     # User/Enable/Config
│   │   │   └── commands/    # Commandes IOS
│   │   │       ├── show.ts
│   │   │       ├── interface.ts
│   │   │       ├── routing.ts
│   │   │       └── vlan.ts
│   │   └── templates/       # Configs par défaut
│   │
│   ├── huawei/               # Équipements Huawei
│   │   ├── HuaweiRouter.ts
│   │   ├── HuaweiSwitch.ts
│   │   ├── vrp/             # Huawei VRP
│   │   │   ├── parser.ts
│   │   │   ├── modes.ts
│   │   │   └── commands/
│   │   └── templates/
│   │
│   ├── firewalls/            # Firewalls
│   │   ├── FortiGate.ts
│   │   ├── PaloAlto.ts
│   │   ├── fortios/         # FortiOS
│   │   └── panos/           # PAN-OS
│   │
│   ├── databases/            # Serveurs de BD
│   │   ├── MySQL.ts
│   │   ├── PostgreSQL.ts
│   │   ├── Oracle.ts
│   │   ├── SQLServer.ts
│   │   └── shells/          # CLI des BDs
│   │       ├── mysql-cli.ts
│   │       ├── psql.ts
│   │       └── sqlplus.ts
│   │
│   ├── wireless/             # Équipements sans fil
│   │   ├── AccessPoint.ts
│   │   └── WirelessController.ts
│   │
│   └── cloud/                # Cloud/Internet
│       └── CloudGateway.ts
│
├── network-designer/           # UI du designer (existant, à renommer)
│   ├── NetworkDesigner.tsx
│   ├── store.ts
│   └── components/
│
├── simulation/                 # Moteur de simulation
│   ├── SimulationEngine.ts   # Moteur principal
│   ├── PacketTracer.ts       # Traçage de paquets
│   ├── EventQueue.ts         # File d'événements
│   └── Timeline.ts           # Ligne temporelle
│
└── components/                 # Composants UI partagés
```

---

## Phase 2: Implémentation des Types d'Équipements

### 2.1 Interface de Base pour Tous les Équipements

```typescript
// src/devices/common/BaseDevice.ts

interface DeviceConfig {
  id: string;
  name: string;
  hostname: string;
  type: DeviceType;
  interfaces: NetworkInterface[];
  isPoweredOn: boolean;
}

interface NetworkInterface {
  id: string;
  name: string;
  type: 'ethernet' | 'wifi' | 'fiber' | 'serial' | 'loopback';
  macAddress: string;
  ipAddress?: string;
  subnetMask?: string;
  gateway?: string;
  vlan?: number;
  isUp: boolean;
  speed: string;
  duplex: 'full' | 'half' | 'auto';
  // Pour les switches
  portMode?: 'access' | 'trunk';
  nativeVlan?: number;
  allowedVlans?: number[];
}

abstract class BaseDevice {
  abstract executeCommand(command: string): CommandResult;
  abstract getPrompt(): string;
  abstract processPacket(packet: Packet): void;
}
```

### 2.2 Équipements Linux

#### 2.2.1 Linux PC (Workstation)
- [x] Terminal bash fonctionnel
- [x] Système de fichiers
- [x] Commandes de base (ls, cd, cat, etc.)
- [x] Commandes réseau (ping, ifconfig, ip)
- [x] Python interpréteur
- [ ] Configuration IP dynamique (lié à la simulation)
- [ ] Commandes réseau connectées à la simulation
- [ ] SSH client pour se connecter aux autres machines

#### 2.2.2 Linux Server
- [ ] Tous les éléments du Linux PC
- [ ] Services:
  - [ ] Apache/Nginx (serveur web)
  - [ ] OpenSSH Server
  - [ ] MySQL/PostgreSQL client
  - [ ] FTP Server
  - [ ] DNS Server (bind9)
  - [ ] DHCP Server
- [ ] iptables / firewalld

### 2.3 Équipements Windows

#### 2.3.1 Windows PC
- [ ] Command Prompt (cmd.exe)
  - [ ] ipconfig, ping, tracert, nslookup
  - [ ] dir, cd, copy, del, type
  - [ ] netstat, arp, route
- [ ] PowerShell (basique)
  - [ ] Get-NetAdapter, Get-NetIPAddress
  - [ ] Test-Connection
- [ ] Interface graphique simplifiée (optionnel)

#### 2.3.2 Windows Server
- [ ] Tous les éléments du Windows PC
- [ ] Services:
  - [ ] IIS (serveur web)
  - [ ] Active Directory (simulation basique)
  - [ ] DNS Server
  - [ ] DHCP Server
  - [ ] SQL Server

### 2.4 Équipements Cisco

#### 2.4.1 Cisco Router (IOS)
- [ ] Modes CLI:
  - [ ] User Mode (Router>)
  - [ ] Privileged Mode (Router#)
  - [ ] Global Config Mode (Router(config)#)
  - [ ] Interface Config Mode (Router(config-if)#)
  - [ ] Routing Config Mode (Router(config-router)#)
- [ ] Commandes essentielles:
  - [ ] show running-config
  - [ ] show ip interface brief
  - [ ] show ip route
  - [ ] show arp
  - [ ] interface configuration
  - [ ] ip address / no shutdown
  - [ ] ip route (routes statiques)
  - [ ] router ospf / eigrp / rip
- [ ] NAT/PAT
- [ ] ACLs (standard et extended)

#### 2.4.2 Cisco Switch (IOS)
- [ ] Mêmes modes que le routeur
- [ ] Commandes spécifiques:
  - [ ] show vlan brief
  - [ ] show mac address-table
  - [ ] show spanning-tree
  - [ ] vlan database
  - [ ] switchport mode access/trunk
  - [ ] switchport access vlan X
  - [ ] spanning-tree priority

#### 2.4.3 Cisco ASA (Firewall)
- [ ] Modes similaires à IOS
- [ ] Security levels
- [ ] NAT rules
- [ ] Access lists
- [ ] Object groups

### 2.5 Équipements Huawei

#### 2.5.1 Huawei Router (VRP)
- [ ] Modes CLI:
  - [ ] User View (<Huawei>)
  - [ ] System View ([Huawei])
  - [ ] Interface View ([Huawei-GigabitEthernet0/0/0])
- [ ] Commandes:
  - [ ] display current-configuration
  - [ ] display ip interface brief
  - [ ] display ip routing-table
  - [ ] interface configuration
  - [ ] ip address
  - [ ] ip route-static
  - [ ] ospf / rip

#### 2.5.2 Huawei Switch (VRP)
- [ ] Commandes VLAN:
  - [ ] display vlan
  - [ ] vlan batch
  - [ ] port link-type
  - [ ] port default vlan
  - [ ] display mac-address

### 2.6 Firewalls

#### 2.6.1 FortiGate (FortiOS)
- [ ] CLI FortiOS
- [ ] Interfaces et zones
- [ ] Policies
- [ ] NAT
- [ ] Routes

#### 2.6.2 Palo Alto (PAN-OS)
- [ ] CLI PAN-OS
- [ ] Security zones
- [ ] Security policies
- [ ] NAT policies

### 2.7 Serveurs de Bases de Données

#### 2.7.1 MySQL Server
- [ ] mysql CLI
- [ ] Commandes SQL de base
- [ ] SHOW DATABASES, USE, SHOW TABLES
- [ ] Simulation de connexion depuis d'autres machines

#### 2.7.2 PostgreSQL Server
- [ ] psql CLI
- [ ] \l, \c, \dt commandes
- [ ] Requêtes SQL

#### 2.7.3 Oracle Database
- [ ] SQL*Plus basique
- [ ] Commandes essentielles

#### 2.7.4 SQL Server
- [ ] sqlcmd
- [ ] T-SQL basique

### 2.8 Équipements Sans Fil

#### 2.8.1 Access Point
- [ ] Configuration SSID
- [ ] Sécurité (WPA2, WPA3)
- [ ] Canaux
- [ ] Mode pont/routeur

---

## Phase 3: Simulation Réseau

### 3.1 Couche 2 (Data Link)

#### 3.1.1 Frames Ethernet
```typescript
interface EthernetFrame {
  destinationMAC: string;
  sourceMAC: string;
  etherType: number; // 0x0800 = IPv4, 0x0806 = ARP
  vlanTag?: {
    tpid: number;     // 0x8100
    pcp: number;      // Priority
    dei: number;      // Drop eligible
    vid: number;      // VLAN ID
  };
  payload: Buffer;
  fcs: number;        // Frame Check Sequence
}
```

#### 3.1.2 Table MAC (Switches)
- [ ] Apprentissage automatique des adresses MAC
- [ ] Aging timer (300s par défaut)
- [ ] Entrées statiques
- [ ] Flooding pour adresses inconnues

#### 3.1.3 VLANs
- [ ] VLAN 1 par défaut
- [ ] Création/suppression de VLANs
- [ ] Ports Access et Trunk
- [ ] Native VLAN
- [ ] Inter-VLAN routing (Router-on-a-stick)

#### 3.1.4 Spanning Tree Protocol (STP)
- [ ] Élection du Root Bridge
- [ ] États des ports (Blocking, Listening, Learning, Forwarding)
- [ ] Port costs et priorities
- [ ] Convergence

### 3.2 Couche 3 (Network)

#### 3.2.1 Paquets IP
```typescript
interface IPv4Packet {
  version: 4;
  headerLength: number;
  dscp: number;
  totalLength: number;
  identification: number;
  flags: number;
  fragmentOffset: number;
  ttl: number;
  protocol: number;    // 1=ICMP, 6=TCP, 17=UDP
  headerChecksum: number;
  sourceIP: string;
  destinationIP: string;
  options?: Buffer;
  payload: Buffer;
}
```

#### 3.2.2 ARP (Address Resolution Protocol)
- [ ] Table ARP par équipement
- [ ] ARP Request (broadcast)
- [ ] ARP Reply (unicast)
- [ ] ARP cache timeout
- [ ] Proxy ARP (routeurs)

#### 3.2.3 ICMP
- [ ] Echo Request/Reply (ping)
- [ ] Destination Unreachable
- [ ] Time Exceeded (TTL)
- [ ] Redirect

#### 3.2.4 Routage
- [ ] Routes directement connectées
- [ ] Routes statiques
- [ ] Table de routage avec métrique
- [ ] Default gateway
- [ ] Longest prefix match

#### 3.2.5 Protocoles de Routage Dynamique
- [ ] RIP v2 (basique)
- [ ] OSPF (single area)
- [ ] EIGRP (basique)

#### 3.2.6 NAT/PAT
- [ ] NAT statique (1:1)
- [ ] NAT dynamique (pool)
- [ ] PAT (overload)
- [ ] Inside/Outside interfaces

### 3.3 Couche 4 (Transport)

#### 3.3.1 TCP
```typescript
interface TCPSegment {
  sourcePort: number;
  destinationPort: number;
  sequenceNumber: number;
  acknowledgmentNumber: number;
  dataOffset: number;
  flags: {
    urg: boolean;
    ack: boolean;
    psh: boolean;
    rst: boolean;
    syn: boolean;
    fin: boolean;
  };
  windowSize: number;
  checksum: number;
  urgentPointer: number;
  payload: Buffer;
}
```

- [ ] Three-way handshake (SYN, SYN-ACK, ACK)
- [ ] Connection termination (FIN)
- [ ] États de connexion
- [ ] Ports well-known (22, 80, 443, etc.)

#### 3.3.2 UDP
- [ ] Datagrammes simples
- [ ] Ports (53 DNS, 67/68 DHCP, etc.)

### 3.4 Services Réseau

#### 3.4.1 DHCP
- [ ] DHCP Discover → Offer → Request → Acknowledge
- [ ] Pool d'adresses
- [ ] Lease time
- [ ] Options (gateway, DNS, etc.)
- [ ] DHCP Relay

#### 3.4.2 DNS
- [ ] Requêtes A, AAAA, CNAME, MX
- [ ] Zones et enregistrements
- [ ] Forwarding
- [ ] Cache DNS

#### 3.4.3 HTTP/HTTPS
- [ ] Requêtes GET/POST basiques
- [ ] Pages web simples
- [ ] Codes de réponse (200, 404, 500)

#### 3.4.4 SSH/Telnet
- [ ] Connexion entre machines
- [ ] Authentification (simulation)
- [ ] Session interactive

#### 3.4.5 FTP
- [ ] Connexion
- [ ] Liste de fichiers
- [ ] Upload/Download (simulation)

---

## Phase 4: Moteur de Simulation

### 4.1 Architecture du Moteur

```typescript
class SimulationEngine {
  private devices: Map<string, BaseDevice>;
  private connections: Connection[];
  private eventQueue: EventQueue;
  private clock: SimulationClock;
  private packetTracer: PacketTracer;

  // Mode temps réel ou pas-à-pas
  private mode: 'realtime' | 'step';
  private speed: number; // 1x, 2x, 0.5x

  // Méthodes
  start(): void;
  pause(): void;
  step(): void;

  sendPacket(from: string, to: string, packet: Packet): void;
  processEvents(): void;

  // Visualisation
  getPacketsInTransit(): PacketVisualization[];
}
```

### 4.2 File d'Événements

```typescript
interface SimulationEvent {
  timestamp: number;
  type: 'packet_sent' | 'packet_received' | 'packet_dropped' | 'arp_request' | 'arp_reply' | 'dhcp_discover' | 'interface_up' | 'interface_down';
  source: string;
  destination: string;
  data: any;
}

class EventQueue {
  private events: PriorityQueue<SimulationEvent>;

  enqueue(event: SimulationEvent): void;
  dequeue(): SimulationEvent | null;
  peek(): SimulationEvent | null;
}
```

### 4.3 Traçage de Paquets

- [ ] Visualisation du chemin des paquets
- [ ] Animation des paquets sur les liens
- [ ] Code couleur par type de paquet
- [ ] Détail de chaque paquet (headers, payload)
- [ ] Mode capture (comme Wireshark simplifié)

---

## Phase 5: Types de Câbles et Connecteurs

### 5.1 Types de Câbles

```typescript
type CableType =
  | 'ethernet-straight'     // PC to Switch
  | 'ethernet-crossover'    // PC to PC, Switch to Switch
  | 'fiber-single-mode'     // Longue distance
  | 'fiber-multi-mode'      // Courte distance
  | 'serial-dce'           // Routeur DCE
  | 'serial-dte'           // Routeur DTE
  | 'console'              // Configuration
  | 'coaxial';             // Ancien / DOCSIS

interface Cable {
  id: string;
  type: CableType;
  bandwidth: string;       // 100Mbps, 1Gbps, 10Gbps
  latency: number;         // ms
  length?: number;         // mètres
  color?: string;          // Visualisation
}
```

### 5.2 Auto-Détection du Type de Câble

```typescript
function suggestCableType(device1: DeviceType, device2: DeviceType): CableType {
  // PC/Server to Switch → Straight
  // Switch to Switch → Crossover (ou straight avec Auto-MDIX)
  // Router to Router → Crossover ou Serial
  // etc.
}
```

### 5.3 Contraintes de Connexion

- [ ] Vérification des types de ports compatibles
- [ ] Limite de connexions par port
- [ ] Avertissement si câble incorrect
- [ ] Support Auto-MDIX pour les équipements modernes

---

## Phase 6: Interface Utilisateur Avancée

### 6.1 Améliorations du Canvas

- [ ] Mini-map pour grandes topologies
- [ ] Groupes de devices (conteneurs)
- [ ] Labels et annotations
- [ ] Alignement automatique (grille)
- [ ] Multi-sélection
- [ ] Copy/Paste de devices

### 6.2 Panneau de Configuration

- [ ] Configuration IP complète par interface
- [ ] Éditeur de routes
- [ ] Configuration VLAN graphique
- [ ] Gestionnaire de services

### 6.3 Mode Simulation

- [ ] Boutons Play/Pause/Step
- [ ] Timeline des événements
- [ ] Visualisation des paquets en transit
- [ ] Filtres par type de paquet
- [ ] Export des captures

### 6.4 Console/Logs

- [ ] Console centrale pour les événements
- [ ] Filtrage par device
- [ ] Niveaux de log (debug, info, warning, error)
- [ ] Export des logs

---

## Phase 7: Sauvegarde et Partage

### 7.1 Format de Fichier

```typescript
interface TopologyFile {
  version: string;
  metadata: {
    name: string;
    author?: string;
    created: Date;
    modified: Date;
    description?: string;
  };
  devices: SerializedDevice[];
  connections: SerializedConnection[];
  cables: SerializedCable[];
  simulation?: {
    arpTables: Record<string, ARPEntry[]>;
    routingTables: Record<string, Route[]>;
    macTables: Record<string, MACEntry[]>;
  };
}
```

### 7.2 Fonctionnalités

- [ ] Sauvegarde locale (localStorage)
- [ ] Export JSON
- [ ] Import de topologies
- [ ] Templates prédéfinis
- [ ] Export PNG/SVG du schéma

---

## Phase 8: Scénarios et Labs

### 8.1 Labs Prédéfinis

- [ ] Lab 1: Configuration IP basique
- [ ] Lab 2: VLAN et trunking
- [ ] Lab 3: Routage statique
- [ ] Lab 4: OSPF basique
- [ ] Lab 5: NAT et PAT
- [ ] Lab 6: ACLs
- [ ] Lab 7: DHCP et DNS
- [ ] Lab 8: Topologie complète entreprise

### 8.2 Système de Vérification

- [ ] Objectifs de lab
- [ ] Vérification automatique des configurations
- [ ] Score et progression
- [ ] Hints et solutions

---

## Priorités d'Implémentation

### Sprint 1 (Fondations)
1. Restructurer les dossiers selon la nouvelle architecture
2. Créer BaseDevice et NetworkStack
3. Implémenter la simulation ARP de base
4. Connecter le terminal Linux existant aux interfaces réseau

### Sprint 2 (Cisco IOS)
1. Implémenter CiscoRouter avec modes CLI
2. Commandes show de base
3. Configuration d'interface IP
4. Routes statiques

### Sprint 3 (Switching)
1. Implémenter CiscoSwitch
2. Table MAC
3. VLANs basiques
4. Ports trunk/access

### Sprint 4 (Services)
1. DHCP Server/Client
2. DNS basique
3. Ping fonctionnel entre devices

### Sprint 5 (Windows)
1. Windows PC avec cmd.exe
2. Commandes réseau Windows
3. Windows Server basique

### Sprint 6 (Avancé)
1. Protocoles de routage (OSPF)
2. NAT/PAT
3. ACLs
4. Firewalls

---

## Notes Techniques

### Performance
- Utiliser Web Workers pour la simulation lourde
- Virtualiser les grandes listes de logs
- Lazy loading des composants device

### Tests
- Tests unitaires pour chaque parser de commandes
- Tests d'intégration pour les scénarios réseau
- Tests de performance pour grandes topologies

### Compatibilité
- Cibler navigateurs modernes (Chrome, Firefox, Edge, Safari)
- Responsive design pour tablettes
- PWA possible pour usage offline

---

## Glossaire

| Terme | Description |
|-------|-------------|
| ARP | Address Resolution Protocol - Résolution IP → MAC |
| VLAN | Virtual LAN - Segmentation logique du réseau |
| STP | Spanning Tree Protocol - Évite les boucles L2 |
| OSPF | Open Shortest Path First - Protocole de routage |
| NAT | Network Address Translation |
| ACL | Access Control List - Filtrage de paquets |
| TTL | Time To Live - Durée de vie d'un paquet |
