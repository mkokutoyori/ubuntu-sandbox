# Product Requirements Document (PRD)
## Simulateur d'Infrastructure IT - Refonte Complète

---

### Métadonnées du Document

| **Propriété** | **Valeur** |
|---------------|------------|
| **Titre** | Simulateur d'Infrastructure IT - Refonte Professionnelle avec TDD |
| **Version** | 1.0.0 |
| **Date de création** | 22 janvier 2026 |
| **Dernière mise à jour** | 22 janvier 2026 |
| **Statut** | En cours de rédaction |
| **Auteur** | Équipe de développement |
| **Type de projet** | Refonte complète (Rewrite) |
| **Méthodologie** | Test-Driven Development (TDD) + Design Patterns |

---

## Table des Matières

1. [Introduction et Vision](#1-introduction-et-vision)
2. Analyse de l'Existant et Objectifs *(À venir)*
3. Architecture Technique et Design Patterns *(À venir)*
4. Spécifications Fonctionnelles Détaillées *(À venir)*
5. Plan d'Implémentation et Roadmap *(À venir)*

---

## 1. Introduction et Vision

### 1.1 Vision du Projet

Le projet vise à développer un **simulateur d'infrastructure IT ultra-réaliste** permettant aux utilisateurs de concevoir, configurer et tester des réseaux informatiques complexes directement depuis leur navigateur web. Notre ambition est de créer une plateforme comparable à Cisco Packet Tracer ou GNS3, mais entièrement basée sur le web, sans nécessiter d'installation locale.

#### Valeur Ajoutée Principale

Notre simulateur se distingue par sa capacité à :

1. **Simuler fidèlement des environnements IT réels** :
   - Émulation précise des comportements réseau (couches OSI 2-7)
   - Reproduction authentique des systèmes d'exploitation (Linux, Windows, Cisco IOS)
   - Simulation de protocoles réseau standards (TCP/IP, DHCP, DNS, ARP, NAT, etc.)
   - Support de multiples types d'équipements (routeurs, switchs, serveurs, postes de travail)

2. **Offrir une expérience d'apprentissage immersive** :
   - Interface utilisateur intuitive avec drag-and-drop
   - Terminaux interactifs pour chaque équipement
   - Visualisation en temps réel du trafic réseau
   - Scénarios pédagogiques progressifs

3. **Fournir un outil professionnel pour la conception réseau** :
   - Validation de configurations avant déploiement réel
   - Test de scénarios de panne et de reprise
   - Documentation automatique des topologies
   - Export/import de configurations

### 1.2 Contexte et Problématique

#### 1.2.1 État Actuel du Projet

Le projet existe déjà sous la forme d'un prototype fonctionnel développé avec :
- **Frontend** : React 18 + TypeScript + Vite
- **UI Library** : shadcn/ui + Tailwind CSS
- **État** : Zustand pour la gestion d'état
- **Architecture** : Frontend-only (pas de backend)

**Statistiques de la base de code actuelle** :
- **~19,343 lignes de code** au total
- **~15,000 lignes** de logique métier
- **~2,000 lignes** de composants UI/UX
- **21 fichiers de tests** existants
- **140+ fichiers TypeScript** de logique métier

#### 1.2.2 Problèmes Identifiés

Malgré son impressionnante couverture fonctionnelle, le projet actuel souffre de plusieurs problèmes architecturaux et de maintenabilité :

##### A. Problèmes d'Architecture

1. **Couplage fort entre composants** :
   - La logique métier est étroitement liée aux composants UI
   - Difficultés à tester unitairement les fonctionnalités
   - Modifications dans une partie du code impactent de multiples modules

2. **Manque de séparation des préoccupations** :
   - Mélange entre logique de présentation et logique métier
   - État global difficilement traçable
   - Responsabilités peu claires entre modules

3. **Architecture basée sur l'héritage** :
   - Structure de classes profondément imbriquées
   - Difficultés à étendre sans modifier le code existant
   - Violations du principe Open/Closed

##### B. Problèmes de Maintenabilité

1. **Code difficile à faire évoluer** :
   - Ajout de nouveaux équipements nécessite modifications dans multiples fichiers
   - Nouveaux protocoles réseau impliquent refactoring important
   - Support de nouveaux langages/shells très complexe

2. **Tests insuffisants et fragiles** :
   - Couverture de tests limitée
   - Tests trop couplés à l'implémentation
   - Difficultés à tester les scénarios complexes

3. **Dette technique accumulée** :
   - ~15,000 lignes sans architecture claire
   - Duplication de code significative
   - Patterns inconsistants à travers le projet

##### C. Problèmes de Scalabilité

1. **Performances** :
   - Simulation réseau non optimisée
   - Manque de parallélisation
   - Gestion mémoire non maîtrisée pour topologies complexes

2. **Extensibilité limitée** :
   - Ajout de nouveaux devices types difficile
   - Support de nouveaux protocoles coûteux
   - Personnalisation limitée

### 1.3 Pourquoi une Refonte Complète ?

Plutôt que d'effectuer des corrections incrémentales, nous avons choisi une **refonte complète** pour les raisons suivantes :

#### 1.3.1 Fondations Solides

Une refonte permet de :
- **Établir une architecture propre dès le départ** avec les bons design patterns
- **Implémenter TDD (Test-Driven Development)** : tests écrits avant le code
- **Appliquer SOLID principles** rigoureusement
- **Créer une base de code maintenable à long terme**

#### 1.3.2 Investissement à Long Terme

Même si la refonte demande un investissement initial important, elle apporte :
- **Réduction drastique de la dette technique**
- **Accélération du développement futur** (nouvelles features plus rapides)
- **Facilitation de l'onboarding** de nouveaux développeurs
- **Qualité logicielle supérieure**

#### 1.3.3 Conservation de l'UX Existante

Point crucial : **nous conservons l'interface utilisateur actuelle** qui est déjà de qualité :
- Tous les composants React restent intacts
- Design UI/UX préservé (shadcn/ui + Tailwind)
- Expérience utilisateur maintenue
- **Seule la logique métier est reconstruite**

### 1.4 Objectifs Principaux de la Refonte

#### 1.4.1 Objectifs Techniques

| Objectif | Description | Mesure de Succès |
|----------|-------------|------------------|
| **Architecture Modulaire** | Système basé sur composition et design patterns | Ajout d'un nouveau device en <2h |
| **Couverture Tests ≥ 80%** | Tests unitaires, intégration et E2E | Coverage report automatisé |
| **Performance** | Simulation fluide de topologies complexes | >60 FPS avec 50+ devices |
| **Extensibilité** | Ajout facile de protocoles/devices/langages | API publique documentée |
| **Code Quality** | Standards professionnels | SonarQube score A |

#### 1.4.2 Objectifs Fonctionnels

1. **Réalisme de Simulation** :
   - Émulation précise des protocoles réseau (conformité RFC)
   - Comportements authentiques des OS (Linux, Windows, Cisco IOS)
   - Latence et délais de propagation réalistes
   - Gestion de la bande passante et congestion

2. **Richesse Fonctionnelle** :
   - Support de 10+ types d'équipements
   - 50+ commandes par OS
   - 15+ protocoles réseau
   - Scénarios de configuration avancés

3. **Expérience Utilisateur** :
   - Interface intuitive (learning curve <30min)
   - Feedback visuel temps réel
   - Documentation intégrée et contextuelle
   - Sauvegarde/chargement de projets

#### 1.4.3 Objectifs Méthodologiques

1. **Test-Driven Development (TDD)** :
   - 100% du code métier développé avec TDD
   - Tests écrits AVANT l'implémentation
   - Cycle Red-Green-Refactor systématique
   - Tests comme documentation vivante

2. **Design Patterns** :
   - Application rigoureuse de patterns établis
   - Documentation des choix architecturaux
   - Code reviews basés sur les patterns
   - Refactoring continu

3. **Best Practices** :
   - SOLID principles
   - Clean Code (Robert C. Martin)
   - Convention de code stricte
   - Documentation exhaustive

### 1.5 Scope du Projet

#### 1.5.1 Dans le Scope (Phase 1)

**Couche Réseau (Network Layer)** :
- ✅ Simulateur de réseau (Mediator pattern)
- ✅ Gestion de frames Ethernet (Layer 2)
- ✅ Protocoles de base : ARP, ICMP
- ✅ Switching L2 (MAC tables, flooding, forwarding)
- ✅ Routing L3 (tables de routage statique)
- ✅ DHCP client/server
- ✅ DNS resolver basique

**Devices (Layer 3)** :
- ✅ Linux PC (Ubuntu/Debian)
- ✅ Windows PC (Windows 10/11)
- ✅ Cisco Router (IOS-like)
- ✅ Cisco Switch L2
- ✅ Cisco Switch L3

**Terminal Emulation** :
- ✅ Shell Linux (bash-like) - commandes essentielles
- ✅ Windows CMD - commandes essentielles
- ✅ PowerShell - cmdlets de base
- ✅ Cisco IOS CLI - configuration basique
- ✅ File system virtuel pour chaque OS

**Infrastructure** :
- ✅ Architecture TDD complète
- ✅ Tests unitaires + intégration
- ✅ CI/CD pipeline
- ✅ Documentation générée automatiquement

#### 1.5.2 Hors Scope (Phases Futures)

**Phase 2 (Future)** :
- ❌ Python interpreter complet
- ❌ SQL databases (PostgreSQL, Oracle)
- ❌ Protocoles avancés (OSPF, BGP, STP, VTP)
- ❌ VLAN tagging et trunking
- ❌ VPN et tunneling
- ❌ Firewall avancé (ACL détaillées)
- ❌ Quality of Service (QoS)

**Phase 3+ (Long Terme)** :
- ❌ Wireless networking (WiFi, 802.11)
- ❌ IPv6 complet
- ❌ SDN (Software-Defined Networking)
- ❌ Network automation (Ansible, Terraform)
- ❌ Monitoring et alerting
- ❌ Collaboration multi-utilisateurs
- ❌ Cloud integration

### 1.6 Contraintes et Hypothèses

#### 1.6.1 Contraintes Techniques

| Contrainte | Description | Impact |
|------------|-------------|--------|
| **Frontend-only** | Pas de backend, tout en navigateur | Limites de performance, stockage local |
| **TypeScript strict** | Mode strict activé | Code plus verbeux mais plus sûr |
| **React 18** | Version cible fixe | Dépendance aux hooks et concurrent features |
| **Bundle size** | <5MB initial load | Optimisations nécessaires, code splitting |
| **Browser support** | Chrome 90+, Firefox 88+, Safari 14+ | Pas de support IE, features modernes |

#### 1.6.2 Hypothèses

1. **Utilisateurs cibles** :
   - Étudiants en réseaux informatiques
   - Professionnels IT en formation
   - Enseignants de réseaux
   - Architectes réseau (prototypage rapide)

2. **Environnement d'utilisation** :
   - Desktop/laptop (pas mobile en priorité)
   - Connexion internet pour chargement initial
   - Navigateurs modernes à jour
   - Minimum 4GB RAM recommandé

3. **Connaissances utilisateurs** :
   - Notions de base en réseaux (OSI, TCP/IP)
   - Familiarité avec ligne de commande
   - Compréhension des concepts Cisco IOS (pour utilisateurs avancés)

### 1.7 Métriques de Succès

#### 1.7.1 Métriques Qualité Code

- **Test Coverage** : ≥80% ligne, ≥90% branches critiques
- **Code Smells** : <10 par 1000 lignes (SonarQube)
- **Duplication** : <3% du code
- **Complexité Cyclomatique** : <15 par fonction
- **Documentation** : 100% des API publiques documentées

#### 1.7.2 Métriques Performance

- **Temps de chargement** : <3s (First Contentful Paint)
- **Frame rate** : ≥60 FPS avec 50 devices
- **Mémoire** : <500MB pour topologie moyenne (20 devices)
- **Temps simulation** : <100ms pour frame routing

#### 1.7.3 Métriques Expérience Utilisateur

- **Time to First Simulation** : <5 minutes (nouveau utilisateur)
- **Command Success Rate** : >95% pour commandes basiques
- **Error Recovery** : Messages d'erreur clairs et actionnables
- **Documentation Access** : Help contextuelle en <2 clics

---

## 2. Analyse de l'Existant et Objectifs Détaillés

### 2.1 Analyse Technique de l'Architecture Actuelle

#### 2.1.1 Structure de la Base de Code (Avant Refonte)

L'analyse approfondie de l'architecture existante révèle une structure organisée en trois couches principales :

##### Couche Présentation (~338KB)
```
/src/components/
├── network/               # 11 composants de visualisation réseau
│   ├── NetworkDesigner    # Orchestrateur principal
│   ├── NetworkCanvas      # Canvas drag-and-drop
│   ├── DevicePalette      # Palette d'équipements
│   └── TerminalModal      # Fenêtre terminal
├── ui/                    # 60+ composants shadcn/ui
└── Terminal*.tsx          # 3 composants terminaux (Linux, Windows, Cisco)
```

**Points forts** :
- ✅ Composants React bien structurés et réutilisables
- ✅ Utilisation de bibliothèques modernes (shadcn/ui, Tailwind CSS)
- ✅ Interface utilisateur intuitive et responsive
- ✅ Séparation claire entre composants UI

**Points faibles** :
- ❌ Couplage fort avec la logique métier (imports directs)
- ❌ State management complexe mélangé avec UI logic
- ❌ Difficultés à tester les composants isolément

##### Couche Logique Métier (~2.6MB)
```
/src/
├── core/network/          # 126KB - Simulation réseau
│   ├── NetworkSimulator.ts    # 494 lignes - Hub central
│   ├── packet.ts              # Structures de données réseau
│   ├── arp.ts, dhcp.ts, dns.ts, nat.ts, acl.ts
│
├── devices/               # 332KB - Modèles d'équipements
│   ├── common/
│   │   ├── BaseDevice.ts      # 160 lignes - Classe de base
│   │   ├── NetworkStack.ts    # 450+ lignes - Stack réseau commune
│   │   └── types.ts
│   ├── linux/LinuxPC.ts
│   ├── windows/WindowsPC.ts
│   └── cisco/CiscoDevice.ts
│
└── terminal/              # 1.7MB - Émulation terminaux
    ├── shell/             # Shell Linux (lexer, parser, executor)
    ├── python/            # Interpréteur Python (80+ fichiers)
    ├── sql/               # PostgreSQL + Oracle SQL
    ├── windows/           # CMD + PowerShell
    └── cisco/             # IOS CLI
```

**Points forts** :
- ✅ Couverture fonctionnelle impressionnante
- ✅ Support de multiples OS et protocoles
- ✅ Émulation terminal très complète

**Points faibles** :
- ❌ **Architecture monolithique** : NetworkSimulator.ts fait 494 lignes avec responsabilités multiples
- ❌ **Héritage profond** : BaseDevice → LinuxPC/WindowsPC/CiscoDevice avec couplage fort
- ❌ **Duplication de code** : Logique similaire répétée dans terminal/shell, terminal/windows, terminal/cisco
- ❌ **Tests insuffisants** : Seulement 21 fichiers de tests pour 15,000 lignes de logique

##### Couche Bridge (~31KB)
```
/src/
├── store/networkStore.ts      # 12KB - Zustand store
├── hooks/useNetworkSimulator.ts # 15KB - Hook d'intégration
└── lib/utils.ts               # 4.5KB - Utilitaires
```

#### 2.1.2 Patterns Identifiés (Actuels)

| Pattern | Localisation | Qualité | Problèmes |
|---------|--------------|---------|-----------|
| **Mediator** | NetworkSimulator.ts | 🟡 Moyen | Trop de responsabilités, devient God Object |
| **Inheritance** | BaseDevice hierarchy | 🔴 Faible | Couplage fort, difficile à étendre |
| **Singleton** | NetworkSimulator | 🟡 Moyen | État global difficilement testable |
| **Factory** | DeviceFactory.ts | 🟢 Bon | Bien implémenté mais manque d'abstraction |
| **Observer** | Event system | 🔴 Faible | Implémentation ad-hoc, pas standardisée |

#### 2.1.3 Dette Technique Mesurée

Avant la refonte, nous avons quantifié la dette technique :

```typescript
// Exemple de code problématique dans NetworkSimulator.ts
class NetworkSimulator {
  private devices: Map<string, BaseDevice> = new Map();
  private macTable: Map<string, Map<string, string>> = new Map();
  private arpCache: Map<string, ARPEntry[]> = new Map();

  // 🔴 Méthode avec trop de responsabilités (100+ lignes)
  sendFrame(frame: EthernetFrame, sourceDeviceId: string) {
    // Validation
    // MAC learning
    // Frame forwarding
    // Broadcast handling
    // Logging
    // Event emission
    // ...
  }
}
```

**Problèmes identifiés** :
1. **Violation SRP** (Single Responsibility Principle) : Une classe fait trop de choses
2. **Difficulté de test** : Impossible de tester MAC learning indépendamment du forwarding
3. **Couplage temporel** : L'ordre des opérations est implicite et fragile
4. **État partagé** : Multiples maps modifiées par différentes méthodes

### 2.2 Benchmarking avec Solutions Existantes

#### 2.2.1 Cisco Packet Tracer

**Architecture** :
- Application desktop (Windows/Linux/macOS)
- Simulation temps réel avec moteur C++
- Protocoles réseau implémentés nativement

**Forces** :
- ✅ Très réaliste (certification officielle Cisco)
- ✅ Performance excellente (simulations complexes fluides)
- ✅ Documentation exhaustive

**Faiblesses** :
- ❌ Propriétaire et fermé
- ❌ Installation requise (pas web)
- ❌ Limité à l'écosystème Cisco

**Notre différenciation** :
- 🎯 Web-based (pas d'installation)
- 🎯 Open-source (extensible)
- 🎯 Multi-vendor (pas seulement Cisco)

#### 2.2.2 GNS3 (Graphical Network Simulator 3)

**Architecture** :
- Desktop + Server backend
- Utilise des VMs réelles ou émulateurs
- Architecture microservices

**Forces** :
- ✅ Très réaliste (vrais OS réseau)
- ✅ Extensible et scriptable
- ✅ Communauté active

**Faiblesses** :
- ❌ Complexité de setup élevée
- ❌ Ressources système importantes
- ❌ Courbe d'apprentissage raide

**Notre différenciation** :
- 🎯 Setup instantané (web browser)
- 🎯 Légèreté (simulation pure, pas de VMs)
- 🎯 Pédagogique (interface guidée)

#### 2.2.3 Tableau Comparatif

| Critère | Cisco Packet Tracer | GNS3 | **Notre Simulateur** |
|---------|---------------------|------|----------------------|
| **Déploiement** | Desktop app | Desktop + Server | Web browser |
| **Installation** | Téléchargement requis | Complexe (VMs) | Aucune |
| **Réalisme** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ (cible) |
| **Performance** | Excellente | Moyenne | Bonne |
| **Extensibilité** | Fermée | Ouverte | Ouverte |
| **Courbe apprentissage** | Moyenne | Raide | Douce |
| **Coût** | Gratuit (académique) | Gratuit | Gratuit |
| **Open Source** | Non | Oui | Oui |
| **Mobile-friendly** | Non | Non | Possible |

### 2.3 Objectifs Techniques Détaillés

#### 2.3.1 Objectifs d'Architecture

##### A. Séparation des Préoccupations (Separation of Concerns)

**Objectif** : Découpler complètement la logique métier de la présentation

```
Avant :                          Après :
┌─────────────────────┐         ┌─────────────────────┐
│   React Component   │         │   React Component   │
│  ┌──────────────┐   │         │  (Pure UI)          │
│  │ UI Logic     │   │         └──────────┬──────────┘
│  │ + Business   │   │                    │
│  │   Logic      │   │         ┌──────────▼──────────┐
│  └──────────────┘   │         │   Adapter/Hook      │
└─────────────────────┘         │  (Bridge Pattern)   │
                                └──────────┬──────────┘
                                           │
                                ┌──────────▼──────────┐
                                │  Business Logic     │
                                │  (Pure TypeScript)  │
                                │  - Testable         │
                                │  - Réutilisable     │
                                └─────────────────────┘
```

**Critères de succès** :
- ✅ Aucun import de React dans les modules business logic
- ✅ Tests unitaires sans dépendances React
- ✅ Réutilisation possible en CLI/backend futur

##### B. Architecture Modulaire et Extensible

**Principe** : Chaque module est indépendant et interchangeable

```typescript
// 🎯 Objectif : Interface + Implémentations multiples
interface IDevice {
  powerOn(): void;
  powerOff(): void;
  sendFrame(frame: Frame): void;
  receiveFrame(frame: Frame): void;
}

// Facilite l'ajout de nouveaux devices
class JuniperRouter implements IDevice { ... }
class HPSwitch implements IDevice { ... }
class DockerContainer implements IDevice { ... }
```

**Critères de succès** :
- ✅ Ajout d'un nouveau type de device en <2h (vs 8h actuellement)
- ✅ Nouveau protocole réseau sans modifier code existant
- ✅ Support nouveau langage terminal (Ruby, Go) en <1 jour

##### C. Testabilité à 100%

**Objectif** : Chaque composant business est unitairement testable

```typescript
// ❌ Avant : Difficile à tester
class NetworkSimulator {
  sendFrame(frame: Frame) {
    // Logique mélangée, dépendances cachées
    this.macTable.set(...);
    this.emitEvent(...);
    this.forwardFrame(...);
  }
}

// ✅ Après : Facilement testable
class MACTableService {
  learn(mac: string, port: string): void { ... }
}

class FrameForwardingService {
  forward(frame: Frame, table: MACTable): Port { ... }
}

// Tests unitaires simples
describe('MACTableService', () => {
  it('should learn MAC address on port', () => {
    const service = new MACTableService();
    service.learn('AA:BB:CC:DD:EE:FF', 'eth0');
    expect(service.lookup('AA:BB:CC:DD:EE:FF')).toBe('eth0');
  });
});
```

**Critères de succès** :
- ✅ 80%+ code coverage (lignes)
- ✅ 90%+ branch coverage (branches critiques)
- ✅ Tests exécutables en <30s
- ✅ Pas de tests flaky (0% flakiness)

#### 2.3.2 Objectifs de Performance

| Métrique | Actuel | Objectif | Stratégie |
|----------|--------|----------|-----------|
| **Chargement initial** | ~5s | <3s | Code splitting, lazy loading |
| **Frame processing** | ~200ms | <100ms | Optimisation algorithmes, memoization |
| **Mémoire (20 devices)** | ~400MB | <300MB | Object pooling, garbage collection |
| **FPS (50 devices)** | ~30 | ≥60 | RequestAnimationFrame, Web Workers |
| **Build time** | ~12s | <8s | Vite optimizations, cache |

#### 2.3.3 Objectifs de Qualité de Code

##### A. Métriques Statiques (SonarQube)

| Métrique | Seuil | Description |
|----------|-------|-------------|
| **Code Smells** | <10 / 1000 lignes | Problèmes de maintenabilité |
| **Bugs** | 0 | Erreurs de logique détectables |
| **Vulnerabilities** | 0 | Failles de sécurité |
| **Security Hotspots** | Review 100% | Points d'attention sécurité |
| **Duplication** | <3% | Code dupliqué |
| **Complexity** | <15 par fonction | Complexité cyclomatique |
| **Maintainability Rating** | A | Note globale |

##### B. Conventions de Code (ESLint + Prettier)

```typescript
// 🎯 Standards à appliquer
{
  "rules": {
    "max-lines-per-function": ["error", 50],      // Fonctions courtes
    "max-params": ["error", 4],                   // Limiter paramètres
    "complexity": ["error", 10],                  // Complexité maîtrisée
    "no-magic-numbers": "error",                  // Pas de nombres magiques
    "@typescript-eslint/explicit-function-return-type": "error",  // Types explicites
    "jsdoc/require-jsdoc": "error"                // Documentation obligatoire
  }
}
```

#### 2.3.4 Objectifs de Documentation

| Type | Objectif | Outil |
|------|----------|-------|
| **API Documentation** | 100% des exports publics | TSDoc + TypeDoc |
| **Architecture Docs** | Diagrammes à jour | Mermaid.js |
| **User Guide** | Guide complet | Markdown + Screenshots |
| **Developer Guide** | Onboarding <4h | Wiki interne |
| **Design Decisions** | ADRs documentés | Architecture Decision Records |

### 2.4 Priorisation des Objectifs

#### 2.4.1 Matrice Impact/Effort

```
Impact
  ^
  │
H │  [TDD Setup]        [Design Patterns]
i │  [Core Network]     [Device Models]
g │
h │  [Terminal Bash]
  │
  │  [PowerShell]       [Python Interp.]
M │  [SQL Support]      [Advanced Protocols]
e │
d │
  │  [UI Polish]        [Performance Opt.]
L │  [Documentation]    [Extra Features]
o │
w │
  └─────────────────────────────────────────>
    Low    Medium      High      Effort

Légende :
[Item] = Composant à développer
```

**Priorité P0 (Critique)** :
1. ✅ TDD Setup complet (infrastructure de tests)
2. ✅ Design Patterns architecture
3. ✅ Core Network Simulator
4. ✅ Device Models (Linux, Windows, Cisco)

**Priorité P1 (Important)** :
5. ✅ Terminal Bash basique
6. ⏸️ Terminal Windows CMD
7. ⏸️ Terminal Cisco IOS

**Priorité P2 (Nice to have)** :
8. ⏸️ PowerShell support
9. ⏸️ Python interpreter
10. ⏸️ SQL support

#### 2.4.2 Définition de "Done"

Pour chaque composant développé :

**Code** :
- ✅ Tests écrits AVANT implémentation (TDD)
- ✅ Code coverage ≥80% pour ce composant
- ✅ Pas de code smells (SonarQube)
- ✅ ESLint + Prettier passent
- ✅ TypeScript strict mode

**Documentation** :
- ✅ TSDoc pour toutes les fonctions publiques
- ✅ README.md du module
- ✅ Exemples d'utilisation
- ✅ ADR si décision d'architecture

**Review** :
- ✅ Code review par un pair
- ✅ Tests review
- ✅ Architecture review

**Intégration** :
- ✅ CI/CD pipeline passe
- ✅ Build successful
- ✅ Pas de régression détectée

### 2.5 Risques et Mitigation

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| **Refonte trop longue** | Moyenne | Élevé | Développement incrémental, releases fréquentes |
| **Over-engineering** | Moyenne | Moyen | Code reviews, principe YAGNI |
| **Performance insuffisante** | Faible | Élevé | Benchmarks continus, profiling |
| **Complexité des tests** | Moyenne | Moyen | Formation TDD, pair programming |
| **Scope creep** | Élevée | Élevé | PRD strict, backlog priorisé |

---

## 3. Architecture Technique et Design Patterns

### 3.1 Vue d'Ensemble de l'Architecture

#### 3.1.1 Architecture en Couches (Layered Architecture)

Notre architecture suit le principe de séparation en couches avec des responsabilités clairement définies :

```
┌─────────────────────────────────────────────────────────────┐
│                    PRESENTATION LAYER                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  React Components (UI/UX) - shadcn/ui + Tailwind    │   │
│  │  - NetworkDesigner, Canvas, DevicePalette           │   │
│  │  - TerminalModal, PropertiesPanel, Toolbar          │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ Props & Callbacks
┌────────────────────────────▼────────────────────────────────┐
│                     ADAPTER LAYER                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  React Hooks & State Management                      │   │
│  │  - useNetworkSimulator (Bridge Pattern)             │   │
│  │  - networkStore (Zustand)                           │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ Interfaces
┌────────────────────────────▼────────────────────────────────┐
│                   APPLICATION LAYER                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Use Cases & Business Logic Orchestration            │   │
│  │  - SimulationController                              │   │
│  │  - DeviceManager                                     │   │
│  │  - TopologyManager                                   │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ Commands & Queries
┌────────────────────────────▼────────────────────────────────┐
│                     DOMAIN LAYER                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Core Business Logic (Framework-agnostic)            │   │
│  │                                                       │   │
│  │  Network Simulation Core:                            │   │
│  │  - NetworkSimulator (Mediator)                       │   │
│  │  - FrameForwardingService                            │   │
│  │  - MACTableService                                   │   │
│  │  - ARPService, DHCPService, DNSService              │   │
│  │                                                       │   │
│  │  Device Models:                                      │   │
│  │  - IDevice (Interface)                               │   │
│  │  - DeviceFactory (Factory Pattern)                   │   │
│  │  - LinuxPC, WindowsPC, CiscoRouter, etc.            │   │
│  │  - NetworkInterface, InterfaceState                  │   │
│  │                                                       │   │
│  │  Terminal Emulation:                                 │   │
│  │  - ITerminal (Interface)                             │   │
│  │  - CommandExecutor (Command Pattern)                 │   │
│  │  - BashShell, CmdShell, IOSShell                    │   │
│  │  - FileSystem (Virtual FS)                          │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ Data Structures
┌────────────────────────────▼────────────────────────────────┐
│                  INFRASTRUCTURE LAYER                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Low-level Services & Utilities                      │   │
│  │  - EventEmitter (Observer Pattern)                   │   │
│  │  - Logger                                            │   │
│  │  - StorageAdapter (LocalStorage)                     │   │
│  │  - Serialization/Deserialization                     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Règles de dépendance** :
- ✅ Les couches supérieures dépendent des couches inférieures
- ❌ Les couches inférieures ne connaissent PAS les couches supérieures
- ✅ La Domain Layer ne dépend d'aucun framework (Pure TypeScript)
- ✅ Communication via interfaces (Dependency Inversion Principle)

#### 3.1.2 Principes SOLID Appliqués

| Principe | Application | Exemple |
|----------|-------------|---------|
| **S**ingle Responsibility | Chaque classe a une seule raison de changer | `MACTableService` gère uniquement MAC tables |
| **O**pen/Closed | Ouvert à l'extension, fermé à la modification | Nouveaux devices via `IDevice` interface |
| **L**iskov Substitution | Les sous-types sont substituables | Tous les `IDevice` implémentent le contrat |
| **I**nterface Segregation | Interfaces spécifiques vs générales | `IRoutable`, `ISwitchable` vs `IDevice` |
| **D**ependency Inversion | Dépendre d'abstractions, pas de concrets | Injecter `ITerminal` pas `BashShell` |

### 3.2 Design Patterns Utilisés

#### 3.2.1 Creational Patterns (Création d'objets)

##### A. Factory Pattern - DeviceFactory

**Problème** : Créer des devices de types variés sans coupler le code client aux classes concrètes

**Solution** :
```typescript
// Interface commune
interface IDevice {
  getId(): string;
  getType(): DeviceType;
  powerOn(): void;
  powerOff(): void;
  sendFrame(frame: EthernetFrame): void;
  receiveFrame(frame: EthernetFrame): void;
  getInterfaces(): NetworkInterface[];
}

// Factory
class DeviceFactory {
  private static registry = new Map<DeviceType, DeviceConstructor>();

  // Permet l'enregistrement de nouveaux types
  static register(type: DeviceType, constructor: DeviceConstructor): void {
    this.registry.set(type, constructor);
  }

  static create(type: DeviceType, config: DeviceConfig): IDevice {
    const Constructor = this.registry.get(type);
    if (!Constructor) {
      throw new DeviceTypeNotFoundError(type);
    }
    return new Constructor(config);
  }
}

// Enregistrement des types
DeviceFactory.register('linux-pc', LinuxPC);
DeviceFactory.register('cisco-router', CiscoRouter);

// Usage
const device = DeviceFactory.create('linux-pc', { x: 100, y: 200 });
```

**Avantages** :
- ✅ Ajout de nouveaux types sans modifier le factory
- ✅ Code client découplé des implémentations concrètes
- ✅ Testabilité : injection de mocks facile

##### B. Builder Pattern - ConfigurationBuilder

**Problème** : Créer des configurations complexes step-by-step

**Solution** :
```typescript
class DeviceConfigBuilder {
  private config: Partial<DeviceConfig> = {};

  withType(type: DeviceType): this {
    this.config.type = type;
    return this;
  }

  withHostname(hostname: string): this {
    this.config.hostname = hostname;
    return this;
  }

  withInterface(iface: NetworkInterfaceConfig): this {
    this.config.interfaces = [...(this.config.interfaces || []), iface];
    return this;
  }

  build(): DeviceConfig {
    this.validate();
    return this.config as DeviceConfig;
  }
}

// Usage
const config = new DeviceConfigBuilder()
  .withType('cisco-router')
  .withHostname('R1')
  .withInterface({ name: 'Fa0/0', ipAddress: '192.168.1.1' })
  .withInterface({ name: 'Fa0/1', ipAddress: '10.0.0.1' })
  .build();
```

#### 3.2.2 Structural Patterns (Organisation du code)

##### A. Adapter Pattern - React Bridge

**Problème** : Adapter la logique métier pour React sans la polluer

**Solution** :
```typescript
// Domain Layer (Pure TypeScript)
class NetworkSimulator {
  private eventBus: EventEmitter;

  sendFrame(frame: EthernetFrame): void {
    // Business logic...
    this.eventBus.emit('frame:sent', { frame, timestamp: Date.now() });
  }
}

// Adapter Layer (React Hook)
function useNetworkSimulator() {
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const simulatorRef = useRef<NetworkSimulator>();

  useEffect(() => {
    const simulator = NetworkSimulator.getInstance();
    simulatorRef.current = simulator;

    // Adapter: convertit events domain → state React
    const handleFrameSent = (event: FrameSentEvent) => {
      setEvents(prev => [...prev, {
        type: 'frame_sent',
        data: event,
        id: generateId()
      }]);
    };

    simulator.on('frame:sent', handleFrameSent);
    return () => simulator.off('frame:sent', handleFrameSent);
  }, []);

  return {
    sendFrame: (frame: EthernetFrame) => simulatorRef.current?.sendFrame(frame),
    events
  };
}
```

##### B. Composite Pattern - Device Hierarchy

**Problème** : Traiter uniformément devices simples et groupes de devices

**Solution** :
```typescript
interface INetworkNode {
  getId(): string;
  accept(visitor: NetworkVisitor): void;
  getChildren(): INetworkNode[];
}

class Device implements INetworkNode {
  getChildren(): INetworkNode[] {
    return []; // Leaf node
  }
}

class DeviceGroup implements INetworkNode {
  private children: INetworkNode[] = [];

  add(node: INetworkNode): void {
    this.children.push(node);
  }

  getChildren(): INetworkNode[] {
    return this.children;
  }
}
```

#### 3.2.3 Behavioral Patterns (Comportement)

##### A. Strategy Pattern - Protocol Handlers

**Problème** : Différents algorithmes pour traiter différents protocoles

**Solution** :
```typescript
interface IProtocolHandler {
  canHandle(frame: EthernetFrame): boolean;
  handle(frame: EthernetFrame, device: IDevice): void;
}

class ARPHandler implements IProtocolHandler {
  canHandle(frame: EthernetFrame): boolean {
    return frame.etherType === ETHER_TYPE.ARP;
  }

  handle(frame: EthernetFrame, device: IDevice): void {
    const arpPacket = frame.payload as ARPPacket;
    // ARP logic...
  }
}

class IPv4Handler implements IProtocolHandler {
  canHandle(frame: EthernetFrame): boolean {
    return frame.etherType === ETHER_TYPE.IPv4;
  }

  handle(frame: EthernetFrame, device: IDevice): void {
    const ipPacket = frame.payload as IPv4Packet;
    // IPv4 logic...
  }
}

// Usage dans Device
class BaseDevice implements IDevice {
  private handlers: IProtocolHandler[] = [
    new ARPHandler(),
    new IPv4Handler(),
    new ICMPHandler()
  ];

  receiveFrame(frame: EthernetFrame): void {
    const handler = this.handlers.find(h => h.canHandle(frame));
    if (handler) {
      handler.handle(frame, this);
    }
  }
}
```

##### B. Command Pattern - Terminal Commands

**Problème** : Encapsuler les commandes terminal de manière extensible

**Solution** :
```typescript
interface ICommand {
  execute(context: CommandContext): CommandResult;
  undo?(): void;
  getHelp(): string;
}

class LSCommand implements ICommand {
  execute(context: CommandContext): CommandResult {
    const { filesystem, currentPath, args } = context;
    const entries = filesystem.readDir(currentPath);

    return {
      output: entries.map(e => e.name).join('\n'),
      exitCode: 0
    };
  }

  getHelp(): string {
    return 'ls - list directory contents';
  }
}

// Registry pattern pour les commandes
class CommandRegistry {
  private commands = new Map<string, ICommand>();

  register(name: string, command: ICommand): void {
    this.commands.set(name, command);
  }

  execute(name: string, context: CommandContext): CommandResult {
    const command = this.commands.get(name);
    if (!command) {
      return { output: `Command not found: ${name}`, exitCode: 127 };
    }
    return command.execute(context);
  }
}
```

##### C. Observer Pattern - Event System

**Problème** : Notifier multiples composants des changements réseau

**Solution** :
```typescript
interface IEventEmitter {
  on(event: string, listener: EventListener): void;
  off(event: string, listener: EventListener): void;
  emit(event: string, data: any): void;
}

class EventBus implements IEventEmitter {
  private listeners = new Map<string, Set<EventListener>>();

  on(event: string, listener: EventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  emit(event: string, data: any): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => {
        try {
          listener(data);
        } catch (error) {
          console.error('Listener error:', error);
        }
      });
    }
  }
}

// Usage
class NetworkSimulator {
  private eventBus = new EventBus();

  sendFrame(frame: EthernetFrame): void {
    // ... logic
    this.eventBus.emit('frame:sent', { frame, timestamp: Date.now() });
  }

  subscribe(callback: (event: NetworkEvent) => void): () => void {
    this.eventBus.on('frame:sent', callback);
    return () => this.eventBus.off('frame:sent', callback);
  }
}
```

##### D. Mediator Pattern - NetworkSimulator

**Problème** : Coordonner la communication entre devices sans les coupler directement

**Solution** :
```typescript
class NetworkSimulator {
  private devices = new Map<string, IDevice>();
  private topology = new Map<string, Set<string>>(); // device -> connected devices

  registerDevice(device: IDevice): void {
    this.devices.set(device.getId(), device);
  }

  connect(device1Id: string, device2Id: string): void {
    if (!this.topology.has(device1Id)) {
      this.topology.set(device1Id, new Set());
    }
    this.topology.get(device1Id)!.add(device2Id);
  }

  sendFrame(frame: EthernetFrame, sourceId: string): void {
    const connectedDevices = this.topology.get(sourceId) || new Set();

    connectedDevices.forEach(targetId => {
      const targetDevice = this.devices.get(targetId);
      if (targetDevice) {
        // Mediator orchestre la communication
        targetDevice.receiveFrame(frame);
        this.eventBus.emit('frame:forwarded', { sourceId, targetId, frame });
      }
    });
  }
}
```

### 3.3 Structure des Modules

#### 3.3.1 Organisation du Code

```
src/
├── domain/                           # Domain Layer (Pure TypeScript)
│   ├── network/                      # Network simulation core
│   │   ├── interfaces/
│   │   │   ├── INetworkSimulator.ts
│   │   │   ├── IDevice.ts
│   │   │   └── IProtocolHandler.ts
│   │   ├── services/
│   │   │   ├── NetworkSimulator.ts   # Mediator
│   │   │   ├── MACTableService.ts
│   │   │   ├── FrameForwardingService.ts
│   │   │   ├── ARPService.ts
│   │   │   ├── DHCPService.ts
│   │   │   └── DNSService.ts
│   │   ├── entities/
│   │   │   ├── Frame.ts
│   │   │   ├── Packet.ts
│   │   │   └── NetworkInterface.ts
│   │   └── value-objects/
│   │       ├── MACAddress.ts
│   │       ├── IPAddress.ts
│   │       └── SubnetMask.ts
│   │
│   ├── devices/                      # Device models
│   │   ├── interfaces/
│   │   │   ├── IDevice.ts
│   │   │   ├── IRoutable.ts
│   │   │   └── ISwitchable.ts
│   │   ├── factories/
│   │   │   └── DeviceFactory.ts
│   │   ├── base/
│   │   │   └── BaseDevice.ts
│   │   ├── linux/
│   │   │   └── LinuxPC.ts
│   │   ├── windows/
│   │   │   └── WindowsPC.ts
│   │   └── cisco/
│   │       ├── CiscoRouter.ts
│   │       ├── CiscoSwitch.ts
│   │       └── CiscoL3Switch.ts
│   │
│   └── terminal/                     # Terminal emulation
│       ├── interfaces/
│       │   ├── ITerminal.ts
│       │   ├── ICommand.ts
│       │   └── IFileSystem.ts
│       ├── commands/
│       │   ├── CommandRegistry.ts
│       │   ├── LSCommand.ts
│       │   ├── CDCommand.ts
│       │   └── ...
│       ├── shells/
│       │   ├── BashShell.ts
│       │   ├── CmdShell.ts
│       │   └── IOSShell.ts
│       └── filesystem/
│           ├── VirtualFileSystem.ts
│           └── FileSystemNode.ts
│
├── application/                      # Application Layer (Use Cases)
│   ├── use-cases/
│   │   ├── CreateTopologyUseCase.ts
│   │   ├── AddDeviceUseCase.ts
│   │   ├── ConnectDevicesUseCase.ts
│   │   └── SendFrameUseCase.ts
│   └── services/
│       ├── TopologyService.ts
│       └── SimulationService.ts
│
├── infrastructure/                   # Infrastructure Layer
│   ├── events/
│   │   └── EventBus.ts
│   ├── storage/
│   │   └── LocalStorageAdapter.ts
│   └── logging/
│       └── Logger.ts
│
├── adapters/                         # Adapter Layer (React Bridge)
│   ├── hooks/
│   │   ├── useNetworkSimulator.ts
│   │   ├── useDeviceManager.ts
│   │   └── useTerminal.ts
│   └── store/
│       └── networkStore.ts
│
├── presentation/                     # Presentation Layer (React UI)
│   └── components/
│       ├── network/
│       ├── terminal/
│       └── ui/
│
└── __tests__/                        # Tests (mirror structure)
    ├── unit/
    ├── integration/
    └── e2e/
```

### 3.4 Interfaces et Contrats Principaux

#### 3.4.1 IDevice Interface

```typescript
/**
 * Core interface for all network devices
 */
interface IDevice {
  // Identity
  getId(): string;
  getType(): DeviceType;
  getName(): string;
  setName(name: string): void;

  // Power management
  isPoweredOn(): boolean;
  powerOn(): void;
  powerOff(): void;

  // Network interfaces
  getInterfaces(): NetworkInterface[];
  getInterface(id: string): NetworkInterface | undefined;
  addInterface(config: InterfaceConfig): NetworkInterface;

  // Frame handling
  sendFrame(frame: EthernetFrame, interfaceId: string): void;
  receiveFrame(frame: EthernetFrame, interfaceId: string): void;

  // Configuration
  getConfig(): DeviceConfig;
  setConfig(config: Partial<DeviceConfig>): void;

  // Terminal access
  hasTerminal(): boolean;
  getTerminal(): ITerminal | undefined;

  // Serialization
  serialize(): SerializedDevice;
  deserialize(data: SerializedDevice): void;
}
```

#### 3.4.2 INetworkSimulator Interface

```typescript
interface INetworkSimulator {
  // Device management
  registerDevice(device: IDevice): void;
  unregisterDevice(deviceId: string): void;
  getDevice(deviceId: string): IDevice | undefined;
  getAllDevices(): IDevice[];

  // Topology management
  connect(device1Id: string, interface1Id: string,
          device2Id: string, interface2Id: string): Connection;
  disconnect(connectionId: string): void;
  getConnections(): Connection[];

  // Frame routing
  sendFrame(frame: EthernetFrame, sourceDeviceId: string): void;

  // Event system
  on(event: SimulatorEvent, listener: EventListener): void;
  off(event: SimulatorEvent, listener: EventListener): void;

  // Simulation control
  start(): void;
  stop(): void;
  reset(): void;
  getStatus(): SimulatorStatus;
}
```

#### 3.4.3 ITerminal Interface

```typescript
interface ITerminal {
  // Command execution
  executeCommand(command: string): Promise<CommandResult>;

  // State management
  getState(): TerminalState;
  getCurrentPath(): string;
  getHistory(): string[];

  // File system
  getFileSystem(): IFileSystem;

  // I/O
  write(output: string): void;
  read(): Promise<string>;

  // Configuration
  getPrompt(): string;
  setPrompt(prompt: string): void;
}
```

---

## 4. Spécifications Fonctionnelles Détaillées

### 4.1 Couche Réseau (Network Layer)

#### 4.1.1 NetworkSimulator - Spécifications

**Responsabilité** : Coordonner la communication entre devices et gérer la topologie réseau

**Fonctionnalités** :

| Fonctionnalité | Description | Critères d'acceptation |
|----------------|-------------|------------------------|
| **registerDevice()** | Enregistrer un device dans le simulateur | - Device ajouté à la map<br>- Event 'device:registered' émis<br>- Retourne true si succès |
| **connect()** | Créer une connexion entre 2 interfaces | - Vérifier que devices existent<br>- Vérifier que interfaces existent<br>- Créer connexion bidirectionnelle<br>- Event 'connection:created' |
| **sendFrame()** | Router une frame depuis un device source | - Frame validée (MAC, CRC)<br>- Routage vers destinations<br>- Event 'frame:sent' avec timestamp |

**Règles Métier** :

```typescript
// Validation de frame
class FrameValidator {
  validate(frame: EthernetFrame): ValidationResult {
    // 1. Vérifier format MAC address
    if (!this.isValidMAC(frame.sourceMAC)) {
      return { valid: false, error: 'Invalid source MAC address' };
    }

    // 2. Vérifier taille frame (64-1518 bytes)
    const size = this.calculateSize(frame);
    if (size < 64 || size > 1518) {
      return { valid: false, error: 'Frame size out of bounds' };
    }

    // 3. Vérifier CRC (optionnel)
    if (frame.fcs && !this.verifyCRC(frame)) {
      return { valid: false, error: 'CRC mismatch' };
    }

    return { valid: true };
  }
}
```

**Cas Limites** :

1. **Device inexistant** : Throw `DeviceNotFoundException`
2. **Interface déjà connectée** : Throw `InterfaceAlreadyConnectedException`
3. **Frame invalide** : Log warning, drop frame, emit 'frame:dropped' event
4. **Boucle de routage** : Détecter via TTL, drop après 255 hops

#### 4.1.2 Protocoles Réseau - Spécifications

##### A. ARP (Address Resolution Protocol)

**RFC Compliance** : RFC 826

**Fonctionnalités** :

```typescript
interface ARPService {
  // Résoudre IP → MAC
  resolve(ipAddress: string): Promise<string | null>;

  // Envoyer ARP request
  sendRequest(targetIP: string, sourceInterface: NetworkInterface): void;

  // Traiter ARP reply
  handleReply(packet: ARPPacket): void;

  // Gérer cache ARP
  getCache(): Map<string, ARPEntry>;
  clearCache(): void;
  setTTL(ttl: number): void; // Default: 20 minutes
}

interface ARPEntry {
  ipAddress: string;
  macAddress: string;
  timestamp: number;
  ttl: number; // Time to live in ms
  isStatic: boolean;
}
```

**Comportement** :

1. **ARP Request** :
   - Broadcast à FF:FF:FF:FF:FF:FF
   - Inclure sender MAC et IP
   - Attendre reply pendant 1 seconde (timeout)
   - Retry jusqu'à 3 fois si pas de réponse

2. **ARP Reply** :
   - Unicast vers requester
   - Inclure target MAC et IP
   - Mise à jour automatique du cache

3. **Cache Management** :
   - TTL par défaut : 20 minutes
   - Entries statiques : jamais expirées
   - Nettoyage automatique toutes les 5 minutes

**Cas d'Usage** :

```typescript
// Test : ARP resolution réussie
describe('ARPService', () => {
  it('should resolve IP to MAC address', async () => {
    const arpService = new ARPService();
    const device = createMockDevice({ ip: '192.168.1.2', mac: 'AA:BB:CC:DD:EE:FF' });

    const mac = await arpService.resolve('192.168.1.2');

    expect(mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('should timeout after 3 retries', async () => {
    const arpService = new ARPService();

    const mac = await arpService.resolve('192.168.1.99'); // Non-existent

    expect(mac).toBeNull();
    expect(arpService.getRequestCount()).toBe(3);
  });
});
```

##### B. DHCP (Dynamic Host Configuration Protocol)

**RFC Compliance** : RFC 2131, RFC 2132

**Fonctionnalités** :

```typescript
interface DHCPService {
  // Server side
  startServer(config: DHCPServerConfig): void;
  stopServer(): void;
  assignLease(clientMAC: string): DHCPLease;
  renewLease(clientMAC: string): DHCPLease;
  releaseLease(clientMAC: string): void;

  // Client side
  discover(): void;
  request(offerIP: string): void;
  renew(): void;
  release(): void;
}

interface DHCPServerConfig {
  ipPool: {
    start: string;      // e.g., '192.168.1.100'
    end: string;        // e.g., '192.168.1.200'
  };
  subnetMask: string;   // e.g., '255.255.255.0'
  gateway: string;      // e.g., '192.168.1.1'
  dnsServers: string[]; // e.g., ['8.8.8.8', '8.8.4.4']
  leaseTime: number;    // en secondes, default: 86400 (24h)
}

interface DHCPLease {
  clientMAC: string;
  assignedIP: string;
  subnetMask: string;
  gateway: string;
  dnsServers: string[];
  leaseStart: number;
  leaseExpiry: number;
}
```

**DHCP Message Types** :

1. **DISCOVER** (Client → Broadcast) :
   - Client cherche un serveur DHCP
   - Broadcast à 255.255.255.255

2. **OFFER** (Server → Unicast) :
   - Serveur propose une IP
   - Inclut configuration réseau

3. **REQUEST** (Client → Broadcast) :
   - Client accepte l'offre
   - Peut être envoyé à plusieurs serveurs

4. **ACK** (Server → Unicast) :
   - Serveur confirme l'assignation
   - Lease activé

5. **NAK** (Server → Unicast) :
   - Serveur refuse (IP déjà prise)

6. **RELEASE** (Client → Unicast) :
   - Client libère l'IP avant expiry

**État du Client** :

```
INIT → SELECTING → REQUESTING → BOUND → RENEWING → REBINDING → INIT
```

##### C. DNS (Domain Name System)

**RFC Compliance** : RFC 1035

**Fonctionnalités** :

```typescript
interface DNSService {
  // Query
  resolve(hostname: string, recordType: DNSRecordType): Promise<DNSRecord[]>;

  // Server management
  addZone(zone: DNSZone): void;
  removeZone(zoneName: string): void;
  addRecord(zoneName: string, record: DNSRecord): void;

  // Cache management
  getCache(): Map<string, DNSCacheEntry>;
  clearCache(): void;
}

enum DNSRecordType {
  A = 1,      // IPv4 address
  AAAA = 28,  // IPv6 address
  CNAME = 5,  // Canonical name
  MX = 15,    // Mail exchange
  NS = 2,     // Name server
  PTR = 12,   // Pointer
  SOA = 6,    // Start of authority
  TXT = 16    // Text
}

interface DNSRecord {
  name: string;         // e.g., 'www.example.com'
  type: DNSRecordType;
  class: number;        // 1 = IN (Internet)
  ttl: number;          // Time to live (seconds)
  data: string;         // Record data
}

interface DNSZone {
  name: string;         // e.g., 'example.com'
  records: DNSRecord[];
  ttl: number;
}
```

**Comportement** :

1. **Query Process** :
   - Vérifier cache local
   - Si miss, envoyer query à serveur DNS
   - Parser response
   - Mettre en cache avec TTL

2. **Cache** :
   - TTL respecté pour chaque record
   - Negative caching (NXDOMAIN) : 5 minutes
   - Cache size limit : 1000 entrées (LRU eviction)

### 4.2 Modèles de Devices

#### 4.2.1 Linux PC - Spécifications

**Type** : `linux-pc`

**Configuration par Défaut** :

```typescript
const DEFAULT_LINUX_CONFIG = {
  os: 'Ubuntu 22.04 LTS',
  hostname: 'ubuntu-pc',
  username: 'user',
  interfaces: [
    {
      name: 'eth0',
      type: 'ethernet',
      dhcp: true
    }
  ],
  filesystem: {
    '/': 'Standard Linux FS',
    '/home/user': 'User home directory',
    '/etc': 'System configuration',
    '/var': 'Variable data'
  }
};
```

**Commandes Terminal Supportées** (Phase 1) :

| Catégorie | Commandes | Priorité |
|-----------|-----------|----------|
| **Navigation** | ls, cd, pwd, dirs | P0 |
| **Fichiers** | cat, touch, mkdir, rm, cp, mv | P0 |
| **Réseau** | ping, ifconfig, ip, route, netstat | P0 |
| **Système** | ps, top, kill, uname, hostname | P1 |
| **Utilisateurs** | whoami, groups, id | P1 |
| **Éditeurs** | nano (basique), vi (limité) | P2 |

**Comportement Réseau** :

- Supporte ARP, DHCP client, DNS client
- Ping (ICMP echo request/reply)
- Traceroute (ICMP TTL exceeded)
- Routing table consulté pour forwarding

#### 4.2.2 Windows PC - Spécifications

**Type** : `windows-pc`

**Configuration par Défaut** :

```typescript
const DEFAULT_WINDOWS_CONFIG = {
  os: 'Windows 10 Pro',
  hostname: 'WIN-PC',
  username: 'Administrator',
  interfaces: [
    {
      name: 'Ethernet0',
      type: 'ethernet',
      dhcp: true
    }
  ],
  filesystem: {
    'C:\\': 'System drive',
    'C:\\Users\\Administrator': 'User profile',
    'C:\\Windows': 'System files'
  }
};
```

**Commandes Terminal Supportées** (Phase 1) :

| Catégorie | Commandes CMD | Priorité |
|-----------|---------------|----------|
| **Navigation** | dir, cd, tree | P0 |
| **Fichiers** | type, copy, move, del, mkdir | P0 |
| **Réseau** | ping, ipconfig, route, netstat | P0 |
| **Système** | tasklist, taskkill, systeminfo, hostname | P1 |

**PowerShell** (Phase 2) :

- Get-ChildItem, Set-Location
- Get-Content, Copy-Item
- Test-NetConnection
- Get-Process

#### 4.2.3 Cisco Router - Spécifications

**Type** : `cisco-router`

**Configuration par Défaut** :

```typescript
const DEFAULT_ROUTER_CONFIG = {
  model: 'Cisco 2900 Series',
  ios: '15.2(4)M',
  hostname: 'Router',
  interfaces: [
    { name: 'FastEthernet0/0', type: 'ethernet', status: 'administratively down' },
    { name: 'FastEthernet0/1', type: 'ethernet', status: 'administratively down' },
    { name: 'Serial0/0/0', type: 'serial', status: 'administratively down' }
  ],
  routingTable: [],
  runningConfig: {},
  startupConfig: {}
};
```

**Modes IOS** :

```
User EXEC (>) → Privileged EXEC (#) → Global Config (config)# → Interface Config (config-if)#
```

**Commandes IOS Supportées** (Phase 1) :

```typescript
// User EXEC Mode
const USER_EXEC_COMMANDS = [
  'enable',           // Passer en privileged mode
  'show version',     // Version IOS
  'show ip interface brief',
  'ping <ip>',
  'traceroute <ip>'
];

// Privileged EXEC Mode
const PRIVILEGED_EXEC_COMMANDS = [
  'configure terminal',  // Passer en config mode
  'show running-config',
  'show startup-config',
  'show ip route',
  'show arp',
  'copy running-config startup-config',
  'reload'
];

// Global Configuration Mode
const GLOBAL_CONFIG_COMMANDS = [
  'hostname <name>',
  'interface <type> <number>',
  'ip route <network> <mask> <next-hop>',
  'no ip route <network> <mask> <next-hop>'
];

// Interface Configuration Mode
const INTERFACE_CONFIG_COMMANDS = [
  'ip address <ip> <mask>',
  'no shutdown',
  'shutdown',
  'description <text>'
];
```

**Routage** :

- Static routing : `ip route 192.168.2.0 255.255.255.0 192.168.1.2`
- Connected routes : automatiquement ajoutées quand interface up
- Default route : `ip route 0.0.0.0 0.0.0.0 <gateway>`

#### 4.2.4 Cisco Switch - Spécifications

**Type** : `cisco-switch`

**Configuration par Défaut** :

```typescript
const DEFAULT_SWITCH_CONFIG = {
  model: 'Cisco Catalyst 2960',
  ios: '15.2(2)E',
  hostname: 'Switch',
  interfaces: [
    { name: 'GigabitEthernet0/1', type: 'ethernet', vlan: 1 },
    { name: 'GigabitEthernet0/2', type: 'ethernet', vlan: 1 },
    // ... 24 ports total
  ],
  macAddressTable: new Map(),
  vlanDatabase: [
    { id: 1, name: 'default', status: 'active' }
  ]
};
```

**MAC Address Learning** :

```typescript
interface MACTableEntry {
  macAddress: string;
  vlan: number;
  interface: string;
  type: 'dynamic' | 'static';
  age: number; // en secondes, max 300 (5 min)
}

class MACTableService {
  learn(mac: string, port: string, vlan: number): void {
    // Ajouter/rafraîchir entrée
    this.table.set(mac, {
      macAddress: mac,
      vlan,
      interface: port,
      type: 'dynamic',
      age: 0
    });
  }

  lookup(mac: string, vlan: number): string | null {
    const entry = this.table.get(mac);
    if (entry && entry.vlan === vlan && entry.age < 300) {
      return entry.interface;
    }
    return null; // Unknown unicast → flood
  }
}
```

**Frame Forwarding Logic** :

```typescript
class FrameForwardingService {
  forward(frame: EthernetFrame, ingressPort: string, switch: CiscoSwitch): void {
    const vlan = switch.getPortVLAN(ingressPort);

    // 1. MAC Learning
    switch.macTable.learn(frame.sourceMAC, ingressPort, vlan);

    // 2. Lookup destination
    const egressPort = switch.macTable.lookup(frame.destinationMAC, vlan);

    if (egressPort) {
      // Known unicast → forward to specific port
      if (egressPort !== ingressPort) {
        switch.sendFrame(frame, egressPort);
      }
    } else {
      // Unknown unicast ou broadcast → flood to all ports in VLAN
      switch.floodFrame(frame, ingressPort, vlan);
    }
  }
}
```

### 4.3 Terminal Emulation

#### 4.3.1 Bash Shell - Spécifications

**Commandes Prioritaires** (Phase 1) :

```typescript
interface CommandSpecification {
  name: string;
  syntax: string;
  description: string;
  examples: string[];
  testCases: TestCase[];
}

const LS_COMMAND: CommandSpecification = {
  name: 'ls',
  syntax: 'ls [OPTIONS] [PATH]',
  description: 'List directory contents',
  examples: [
    'ls',           // Liste répertoire courant
    'ls -l',        // Format long
    'ls -a',        // Inclure fichiers cachés
    'ls -lh',       // Format long + tailles lisibles
    'ls /etc'       // Liste répertoire spécifique
  ],
  testCases: [
    {
      input: 'ls',
      expectedOutput: ['file1.txt', 'file2.txt', 'dir1'],
      exitCode: 0
    },
    {
      input: 'ls /nonexistent',
      expectedOutput: ['ls: cannot access \'/nonexistent\': No such file or directory'],
      exitCode: 2
    }
  ]
};
```

**File System Virtuel** :

```typescript
interface FileSystemNode {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  permissions: string; // e.g., 'rwxr-xr-x'
  owner: string;
  group: string;
  size: number;
  modified: Date;
  content?: string;     // Pour files
  children?: Map<string, FileSystemNode>; // Pour directories
  target?: string;      // Pour symlinks
}

class VirtualFileSystem {
  private root: FileSystemNode;

  // Opérations
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
  createDirectory(path: string): boolean;
  deleteNode(path: string): boolean;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  listDirectory(path: string): FileSystemNode[];

  // Permissions
  checkPermission(path: string, operation: 'read' | 'write' | 'execute'): boolean;
}
```

### 4.4 Gestion des Erreurs

#### 4.4.1 Types d'Erreurs

```typescript
// Domain Errors
class DomainError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'DomainError';
  }
}

class DeviceNotFoundError extends DomainError {
  constructor(deviceId: string) {
    super(`Device not found: ${deviceId}`, 'DEVICE_NOT_FOUND');
  }
}

class InvalidConfigurationError extends DomainError {
  constructor(reason: string) {
    super(`Invalid configuration: ${reason}`, 'INVALID_CONFIG');
  }
}

class NetworkError extends DomainError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
  }
}
```

#### 4.4.2 Stratégies de Récupération

| Erreur | Stratégie | Action UI |
|--------|-----------|-----------|
| Device non trouvé | Log + return null | Toast error message |
| Frame invalide | Drop + log warning | Afficher dans event log |
| Interface down | Reject + error | Highlight interface en rouge |
| Configuration invalide | Validation + error | Form validation feedback |
| Timeout réseau | Retry 3x puis fail | Spinner → Error message |

---

## Suite du Document

La prochaine section à développer :

- **Section 5** : Plan d'implémentation TDD et roadmap détaillée

---

**Statut actuel** : Sections 1-4 complétées (≈8000 mots)
**Progression** : 80% du PRD total
