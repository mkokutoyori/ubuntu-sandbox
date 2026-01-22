# Roadmap du Projet - Simulateur d'Infrastructure IT

## Vue d'Ensemble

Ce document trace la progression du développement du simulateur d'infrastructure IT, refactoré selon une approche professionnelle utilisant TDD, Design Patterns, et SOLID principles.

**Date de démarrage**: 2026-01-22
**Méthodologie**: Test-Driven Development (TDD) + Domain-Driven Design (DDD)
**Approche**: Sprints de 1 semaine (5 jours)

---

## ✅ Phase 0 : Préparation et Documentation

### Livrable 1 : Refonte du Projet
**Date**: 2026-01-22
**Commit**: `53361b7`, `8b365e2`, `e04bb14`, `a99ba33`, `65d6bb7`, `58fa5a6`

**Actions réalisées** :
- Suppression de l'ancienne logique métier (~2.6 MB de code)
- Préservation de l'UX (composants React, shadcn/ui, Tailwind CSS)
- Création de stubs minimaux pour maintenir la compilation

**Fichiers créés** :
- Stubs dans `src/core/`, `src/devices/`, `src/terminal/`

### Livrable 2 : Documentation Produit (PRD)
**Date**: 2026-01-22
**Commit**: `53361b7` - `58fa5a6`

**Contenu** :
- **PRD.md** (~9500 mots) : Product Requirements Document complet en français
  - Partie 1 : Introduction et Vision
  - Partie 2 : Analyse et Objectifs Détaillés
  - Partie 3 : Architecture Technique et Design Patterns
  - Partie 4 : Spécifications Fonctionnelles Détaillées
  - Partie 5 : Plan d'Implémentation TDD et Roadmap

**Localisation** : `/PRD.md`

### Livrable 3 : Guide des Bonnes Pratiques
**Date**: 2026-01-22
**Commit**: `53361b7`

**Contenu** :
- **BEST_PRACTICES.md** (~3500 mots) : Guide de développement complet
  - Conventions de nommage
  - Standards TypeScript
  - Pratiques TDD (Red-Green-Refactor)
  - Workflow Git (Conventional Commits)
  - Checklist de code review
  - Guidelines de performance et sécurité

**Localisation** : `/BEST_PRACTICES.md`

---

## ✅ Phase 1 : Network Core (Sprint 1)

### Sprint 1 - Semaine 1
**Date**: 2026-01-22
**Commit**: `d2c33ae`
**Tests**: ✅ **95 tests passing** (6 test suites)

#### Livrable 1 : Value Objects (55 tests)

**1. MACAddress** (18 tests)
- **Fichier**: `src/domain/network/value-objects/MACAddress.ts`
- **Test**: `src/__tests__/unit/network/MACAddress.test.ts`
- **Fonctionnalités**:
  - Validation de format (AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF)
  - Détection broadcast/multicast/unicast
  - Conversion bytes ↔ string
  - Constantes BROADCAST et ZERO
- **Immutabilité**: ✅ Conforme DDD

**2. IPAddress** (29 tests)
- **Fichier**: `src/domain/network/value-objects/IPAddress.ts`
- **Test**: `src/__tests__/unit/network/IPAddress.test.ts`
- **Fonctionnalités**:
  - Validation dotted decimal (192.168.1.1)
  - Détection private/loopback/broadcast/multicast
  - Vérification d'appartenance à un subnet
  - Conversion bytes/number ↔ string
  - Factory methods: `fromBytes()`, `fromNumber()`
- **Immutabilité**: ✅ Conforme DDD

**3. SubnetMask** (8 tests)
- **Fichier**: `src/domain/network/value-objects/SubnetMask.ts`
- **Test**: `src/__tests__/unit/network/SubnetMask.test.ts`
- **Fonctionnalités**:
  - Support CIDR notation (/24) et dotted decimal (255.255.255.0)
  - Calcul du nombre d'hôtes
  - Validation contiguïté des bits
  - Factory method: `fromCIDR()`
- **Immutabilité**: ✅ Conforme DDD

#### Livrable 2 : Entities (25 tests)

**4. EthernetFrame** (11 tests)
- **Fichier**: `src/domain/network/entities/EthernetFrame.ts`
- **Test**: `src/__tests__/unit/network/EthernetFrame.test.ts`
- **Fonctionnalités**:
  - Représentation Ethernet II (IEEE 802.3)
  - Validation payload (46-1500 bytes)
  - Frame minimum size: 64 bytes (avec padding)
  - Header: 14 bytes (6 dest + 6 src + 2 EtherType)
  - Serialization/Deserialization (toBytes/fromBytes)
  - Détection broadcast/multicast/unicast
  - Support EtherType: IPv4 (0x0800), ARP (0x0806), IPv6 (0x86DD), VLAN (0x8100)
- **Pattern**: Entity (DDD)

**5. IPv4Packet** (14 tests)
- **Fichier**: `src/domain/network/entities/IPv4Packet.ts`
- **Test**: `src/__tests__/unit/network/IPv4Packet.test.ts`
- **Fonctionnalités**:
  - Représentation IPv4 (RFC 791)
  - Header: 20 bytes minimum
  - TTL management (decrement avec immutabilité)
  - Header checksum calculation
  - Support protocols: ICMP (1), TCP (6), UDP (17)
  - Fragmentation support (flags, offset)
  - DSCP field support
  - Serialization/Deserialization
- **Pattern**: Entity (DDD)

#### Livrable 3 : NetworkSimulator - Mediator Pattern (15 tests)

**6. NetworkSimulator** (15 tests)
- **Fichier**: `src/domain/network/NetworkSimulator.ts`
- **Test**: `src/__tests__/unit/network/NetworkSimulator.test.ts`
- **Fonctionnalités**:
  - **Device Management**:
    - Registration/Unregistration
    - MAC address uniqueness validation
    - Device existence checks
  - **Port Connections**:
    - Port-based device connections
    - Connection/Disconnection
    - Connection validation
  - **Frame Forwarding**:
    - Unicast frame delivery
    - Broadcast to all connected devices
    - Frame dropping (destination not found)
  - **Event System** (Observer Pattern):
    - `deviceRegistered`, `deviceUnregistered`
    - `devicesConnected`, `devicesDisconnected`
    - `frameSent`, `frameReceived`, `frameDropped`
  - **Statistics Tracking**:
    - Total frames, broadcast/unicast counts
    - Dropped frames, total bytes
    - Statistics reset
- **Patterns**: Mediator + Observer
- **SOLID**: ✅ Single Responsibility (coordination uniquement)

### Résumé Sprint 1

| Catégorie | Fichiers | Tests | Status |
|-----------|----------|-------|--------|
| Value Objects | 3 | 55 | ✅ |
| Entities | 2 | 25 | ✅ |
| Core Services | 1 | 15 | ✅ |
| **TOTAL** | **6** | **95** | ✅ |

**Lignes de code ajoutées**: ~2625 lignes
**Approche TDD**: 100% (tests écrits avant implémentation)
**Code Coverage**: Tests unitaires complets

---

## ✅ Phase 1 : Network Core (Sprint 2) - COMPLETED

### Sprint 2 - Semaine 2
**Date**: 2026-01-22
**Commit**: `TBD`
**Tests**: ✅ **180 tests passing** (167 unitaires + 13 intégration)

#### Livrable 1 : Protocol Services (72 tests unitaires)

**1. ARPService** (24 tests)
- **Fichier**: `src/domain/network/services/ARPService.ts`
- **Test**: `src/__tests__/unit/network/ARPService.test.ts`
- **Fonctionnalités**:
  - ARP Request/Reply packet creation
  - ARP cache management with TTL (default 300s)
  - Automatic expiration of old entries
  - Gratuitous ARP support (address announcement)
  - ARP cache lookup and validation
  - Packet serialization/deserialization (RFC 826 format)
  - Statistics tracking (requests, replies, cache size)
- **Pattern**: Service (DDD)
- **Tests passed**: ✅ 24/24

**2. MACTableService** (27 tests)
- **Fichier**: `src/domain/network/services/MACTableService.ts`
- **Test**: `src/__tests__/unit/network/MACTableService.test.ts`
- **Fonctionnalités**:
  - MAC address learning (source MAC -> port mapping)
  - Aging mechanism with configurable TTL (default 300s)
  - Automatic expiration of stale entries
  - MAC table lookup by address
  - Port-based queries (all MACs on port)
  - Capacity management (max table size, LRU eviction)
  - Rejects broadcast/multicast learning
  - MAC mobility tracking (port changes)
  - Statistics (learning count, moves, hits/misses)
  - Export/Import for persistence
- **Pattern**: Service (DDD)
- **Tests passed**: ✅ 27/27

**3. FrameForwardingService** (21 tests)
- **Fichier**: `src/domain/network/services/FrameForwardingService.ts`
- **Test**: `src/__tests__/unit/network/FrameForwardingService.test.ts`
- **Fonctionnalités**:
  - Unicast forwarding based on MAC table
  - Broadcast/Multicast flooding
  - Unknown destination handling (flooding)
  - Source MAC learning on ingress
  - Port filtering (no hairpin)
  - Port management (add/remove/list)
  - Automatic MAC table cleanup on port removal
  - Forwarding decision reasoning
  - Statistics (unicast/broadcast/multicast/flooded/filtered)
- **Pattern**: Service (DDD) + Strategy
- **Integration**: Uses MACTableService
- **Tests passed**: ✅ 21/21

#### Livrable 2 : Tests d'Intégration (13 tests)

**Fichier**: `src/__tests__/integration/network.integration.test.ts`

**Scénario 1**: Two devices exchanging frames (3 tests)
- Unicast frame delivery between connected devices
- Broadcast ARP request propagation
- Statistics tracking for frame forwarding
- **Tests passed**: ✅ 3/3

**Scénario 2**: ARP resolution flow (3 tests)
- Complete ARP request/reply cycle
- Cache population and lookup
- Serialization/deserialization of ARP packets
- Gratuitous ARP handling
- **Tests passed**: ✅ 3/3

**Scénario 3**: MAC learning on switch (7 tests)
- Dynamic MAC address learning
- Forward based on learned MACs
- MAC address mobility (port changes)
- Frame filtering (same-port destinations)
- Broadcast/multicast flooding behavior
- Comprehensive statistics tracking
- Complete switch operation scenario
- **Tests passed**: ✅ 7/7

### Résumé Sprint 2

| Catégorie | Fichiers | Tests | Status |
|-----------|----------|-------|--------|
| Protocol Services | 3 | 72 | ✅ |
| Integration Tests | 1 | 13 | ✅ |
| **TOTAL Sprint 2** | **4** | **85** | ✅ |
| **TOTAL Cumul** | **10** | **180** | ✅ |

**Lignes de code ajoutées Sprint 2**: ~1800 lignes
**Build status**: ✅ Successfully builds
**Approche TDD**: 100% (tests écrits avant implémentation)
**Integration**: Tous les services fonctionnent ensemble

---

## 📋 Phase 2 : Device Models (Sprint 3-4) - PLANIFIÉ

### Sprint 3 - Semaine 3 (Planifié)
**Objectif**: Implémenter les device models de base

**Devices à implémenter**:
1. **PC (Computer)**
   - NetworkInterface (NIC)
   - IP stack
   - ARP client
   - ICMP (ping)

2. **Switch (Layer 2)**
   - Multiple ports
   - MAC learning
   - Frame forwarding
   - Broadcast domain

### Sprint 4 - Semaine 4 (Planifié)
**Objectif**: Devices avancés

**Devices à implémenter**:
3. **Router (Layer 3)**
   - Routing table
   - IP forwarding
   - Multiple interfaces
   - Default gateway

4. **Hub (Layer 1)**
   - Simple repeater
   - Collision domain

---

## 📋 Phase 3 : Protocol Stack (Sprint 5-6) - PLANIFIÉ

### Sprint 5 - Semaine 5 (Planifié)
**Objectif**: Implémenter protocols de base

**Protocols**:
1. DHCP (Dynamic Host Configuration Protocol)
2. DNS (Domain Name System)
3. ICMP (Internet Control Message Protocol)

### Sprint 6 - Semaine 6 (Planifié)
**Objectif**: Transport layer

**Protocols**:
1. TCP (Connection establishment, transmission, congestion control)
2. UDP (Connectionless transmission)

---

## 📋 Phase 4 : Application Layer (Sprint 7) - PLANIFIÉ

### Sprint 7 - Semaine 7 (Planifié)
**Objectif**: Application protocols

**Protocols**:
1. HTTP/HTTPS
2. FTP
3. Telnet/SSH simulation

---

## 📋 Phase 5 : Integration & Polish (Sprint 8) - PLANIFIÉ

### Sprint 8 - Semaine 8 (Planifié)
**Objectif**: Intégration complète et tests

**Activités**:
1. Tests d'intégration complets
2. Performance optimization
3. UI/UX integration
4. Documentation finale
5. Bug fixes

---

## 🎯 Métriques de Qualité

### Couverture de Tests
- **Sprint 1**: 95 tests unitaires ✅
- **Sprint 2**: 72 tests unitaires + 13 tests intégration ✅
- **Total**: 180 tests (167 unitaires + 13 intégration)
- **Objectif global**: > 90% code coverage

### Conformité Patterns
- ✅ **Value Objects**: Immutable, validation, equality
- ✅ **Entities**: Identity, mutable state, business logic
- ✅ **Services**: Stateless operations, coordination
- ✅ **Mediator**: Decoupling, centralized coordination
- ✅ **Observer**: Event-driven, loosely coupled

### Conformité SOLID
- ✅ **Single Responsibility**: Chaque classe une seule raison de changer
- ✅ **Open/Closed**: Extension sans modification
- ✅ **Liskov Substitution**: Subtypes substituables
- ✅ **Interface Segregation**: Interfaces spécifiques
- ✅ **Dependency Inversion**: Dépend d'abstractions

---

## 📝 Conventions Git

### Format des Commits
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types utilisés**:
- `feat`: Nouvelle fonctionnalité
- `fix`: Correction de bug
- `docs`: Documentation uniquement
- `test`: Ajout/modification de tests
- `refactor`: Refactoring sans changement fonctionnel
- `chore`: Tâches de maintenance

### Branches
- **Main branch**: (non utilisée pour dev)
- **Feature branch**: `claude/refactor-professional-approach-L33qP`

---

## 🔄 Changelog

### [2026-01-22] - Sprint 2 Completed
**Ajouté**:
- Services: ARPService, MACTableService, FrameForwardingService
- 72 tests unitaires (100% passing)
- 13 tests d'intégration (100% passing)
- Integration complete entre NetworkSimulator, ARP, MAC learning, et forwarding
- Roadmap documentation

**Commits**:
- `TBD`: feat: Implement Sprint 2 - Protocol Services with TDD (85 tests)

**Total cumulé**: 180 tests passing

### [2026-01-22] - Sprint 1 Completed
**Ajouté**:
- Value Objects: MACAddress, IPAddress, SubnetMask
- Entities: EthernetFrame, IPv4Packet
- NetworkSimulator (Mediator + Observer patterns)
- 95 tests unitaires (100% passing)
- Documentation complète (PRD, BEST_PRACTICES)

**Commits**:
- `d2c33ae`: feat: Implement Sprint 1 - Network Core with TDD (95 tests)
- `58fa5a6`: docs: Delete old docs, move PRD and BEST_PRACTICES to root
- `53361b7`: docs: Add comprehensive Development Best Practices Guide

---

## 🎓 Ressources et Références

### Standards Réseau
- **IEEE 802.3**: Ethernet
- **RFC 791**: Internet Protocol (IPv4)
- **RFC 826**: Address Resolution Protocol (ARP)
- **RFC 2131**: Dynamic Host Configuration Protocol (DHCP)

### Design Patterns Utilisés
- **Mediator**: NetworkSimulator
- **Observer**: Event system
- **Value Object**: MACAddress, IPAddress, SubnetMask
- **Entity**: EthernetFrame, IPv4Packet
- **Service**: ARPService, MACTableService (à venir)
- **Strategy**: FrameForwardingService (à venir)
- **Factory**: Device creation (à venir)

### Outils de Développement
- **Framework de test**: Vitest
- **Langage**: TypeScript (strict mode)
- **Build tool**: Vite
- **UI**: React + shadcn/ui + Tailwind CSS

---

**Dernière mise à jour**: 2026-01-22
**Version**: 0.2.0 (Sprint 2 completed)
**Statut global**: 🟢 On track
**Tests**: 180/180 passing (100%)
