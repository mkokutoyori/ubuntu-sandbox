# Guide des Best Practices de Développement
## Simulateur d'Infrastructure IT

---

### Métadonnées du Document

| **Propriété** | **Valeur** |
|---------------|------------|
| **Titre** | Guide des Bonnes Pratiques de Développement |
| **Version** | 1.0.0 |
| **Date de création** | 22 janvier 2026 |
| **Statut** | Officiel - Obligatoire |
| **Audience** | Tous les développeurs du projet |

---

## Table des Matières

1. [Introduction](#1-introduction)
2. [Conventions de Code](#2-conventions-de-code)
3. [Standards TypeScript](#3-standards-typescript)
4. [Pratiques TDD](#4-pratiques-tdd)
5. [Git Workflow](#5-git-workflow)
6. [Code Review](#6-code-review)
7. [Documentation](#7-documentation)
8. [Performance](#8-performance)
9. [Sécurité](#9-sécurité)
10. [Checklist Finale](#10-checklist-finale)

---

## 1. Introduction

### 1.1 Objectif de ce Guide

Ce guide définit les **standards de qualité obligatoires** pour tout code ajouté au projet. Son respect garantit :
- ✅ Code maintenable et lisible
- ✅ Qualité constante à travers le projet
- ✅ Facilitation du travail en équipe
- ✅ Réduction de la dette technique

### 1.2 Principes Fondamentaux

Nous suivons ces principes directeurs :

1. **Code is Read More Than Written** : Optimiser pour la lecture, pas l'écriture
2. **Explicit is Better Than Implicit** : Clarté sur concision
3. **Simple is Better Than Complex** : Éviter la sur-ingénierie
4. **Test First, Always** : TDD strict, pas de code sans test
5. **Fail Fast** : Valider tôt, échouer rapidement

---

## 2. Conventions de Code

### 2.1 Naming Conventions

#### 2.1.1 Variables et Fonctions

```typescript
// ✅ BON : camelCase, noms descriptifs
const maxRetryCount = 3;
const userAuthenticated = true;
function calculateTotalPrice(items: Item[]): number { ... }

// ❌ MAUVAIS : noms courts, non descriptifs
const max = 3;
const auth = true;
function calc(items: Item[]): number { ... }
```

**Règles** :
- **camelCase** pour variables et fonctions
- Noms **complets et descriptifs** (3-20 caractères)
- Booléens préfixés par `is`, `has`, `should`, `can`
- Fonctions commencent par un **verbe** (get, set, create, update, delete, calculate, validate)

#### 2.1.2 Classes et Interfaces

```typescript
// ✅ BON : PascalCase
class NetworkSimulator { ... }
class MACTableService { ... }
interface IDevice { ... }
interface DeviceConfig { ... }

// ❌ MAUVAIS
class networkSimulator { ... }
class mac_table_service { ... }
interface device { ... }
```

**Règles** :
- **PascalCase** pour classes, interfaces, types, enums
- Interfaces préfixées par `I` si abstraites (ex: `IDevice`)
- Suffixes descriptifs : `Service`, `Factory`, `Manager`, `Handler`, `Config`

#### 2.1.3 Constantes

```typescript
// ✅ BON : SCREAMING_SNAKE_CASE pour constantes globales
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const ETHER_TYPE = {
  IPv4: 0x0800,
  ARP: 0x0806,
  IPv6: 0x86DD
} as const;

// ✅ BON : camelCase pour constantes locales/privées
const defaultConfig = { ... };
```

#### 2.1.4 Fichiers et Répertoires

```typescript
// ✅ BON : PascalCase pour classes, camelCase pour utilities
NetworkSimulator.ts
MACTableService.ts
deviceUtils.ts
validators.ts

// ❌ MAUVAIS
network-simulator.ts
mac_table_service.ts
DeviceUtils.ts
```

### 2.2 Structure des Fichiers

#### 2.2.1 Organisation Standard

```typescript
/**
 * Description du fichier
 * @module domain/network/services
 */

// 1. Imports externes (Node.js, libraries)
import { EventEmitter } from 'events';

// 2. Imports internes (relatifs)
import { IDevice } from '../interfaces/IDevice';
import { Frame } from '../entities/Frame';

// 3. Types et interfaces locales
interface ServiceConfig {
  timeout: number;
  retries: number;
}

// 4. Constantes
const DEFAULT_TIMEOUT = 5000;

// 5. Classe/fonction principale
export class NetworkSimulator {
  // ...
}

// 6. Fonctions utilitaires (si nécessaire)
function validateFrame(frame: Frame): boolean {
  // ...
}
```

#### 2.2.2 Longueur des Fichiers

| Type | Limite | Recommandation |
|------|--------|----------------|
| **Classe** | 300 lignes max | 100-200 lignes idéal |
| **Fichier** | 500 lignes max | 200-300 lignes idéal |
| **Fonction** | 50 lignes max | 10-30 lignes idéal |

**Action si dépassement** : Refactorer en plusieurs classes/modules

### 2.3 Formatage et Style

#### 2.3.1 Indentation et Espaces

```typescript
// ✅ BON : 2 espaces, pas de tabs
function calculateTotal(items: Item[]): number {
  let total = 0;

  for (const item of items) {
    total += item.price * item.quantity;
  }

  return total;
}

// Espaces autour des opérateurs
const result = a + b * c;

// Pas d'espaces avant la parenthèse de fonction
function foo() { ... }
```

#### 2.3.2 Accolades et Blocs

```typescript
// ✅ BON : Accolades sur la même ligne (K&R style)
if (condition) {
  doSomething();
} else {
  doSomethingElse();
}

// ✅ BON : Toujours utiliser des accolades, même pour 1 ligne
if (condition) {
  return true;
}

// ❌ MAUVAIS : Pas d'accolades
if (condition) return true;
```

#### 2.3.3 Prettier Configuration

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "avoid",
  "endOfLine": "lf"
}
```

**Usage** : Prettier s'exécute automatiquement avant chaque commit (pre-commit hook)

---

## 3. Standards TypeScript

### 3.1 Strict Mode

**Configuration obligatoire** dans `tsconfig.json` :

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### 3.2 Types Explicites

#### 3.2.1 Fonctions

```typescript
// ✅ BON : Type de retour explicite
function getDeviceById(id: string): IDevice | null {
  return this.devices.get(id) || null;
}

function calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

// ❌ MAUVAIS : Type de retour implicite
function getDeviceById(id: string) {
  return this.devices.get(id) || null;
}
```

#### 3.2.2 Variables

```typescript
// ✅ BON : Type explicite quand non évident
const deviceId: string = generateId();
const devices: Map<string, IDevice> = new Map();
const config: DeviceConfig = loadConfig();

// ✅ BON : Type inféré quand évident
const count = 5; // number inféré
const message = 'Hello'; // string inféré
const isActive = true; // boolean inféré
```

### 3.3 Interfaces vs Types

#### 3.3.1 Quand Utiliser Interface

```typescript
// ✅ BON : Interface pour objets avec méthodes
interface IDevice {
  getId(): string;
  getName(): string;
  powerOn(): void;
  powerOff(): void;
}

// ✅ BON : Interface extensible
interface BaseConfig {
  timeout: number;
}

interface ExtendedConfig extends BaseConfig {
  retries: number;
}
```

#### 3.3.2 Quand Utiliser Type

```typescript
// ✅ BON : Type pour unions
type DeviceType = 'linux-pc' | 'windows-pc' | 'cisco-router';
type Status = 'idle' | 'running' | 'stopped' | 'error';

// ✅ BON : Type pour tuples
type Coordinate = [number, number];

// ✅ BON : Type pour intersections
type WithTimestamp = { timestamp: number };
type TimestampedDevice = IDevice & WithTimestamp;
```

### 3.4 Éviter `any`

```typescript
// ❌ MAUVAIS : any désactive le type checking
function processData(data: any): any {
  return data.value;
}

// ✅ BON : Type générique
function processData<T extends { value: unknown }>(data: T): T['value'] {
  return data.value;
}

// ✅ BON : unknown pour données non typées
function parseJSON(json: string): unknown {
  return JSON.parse(json);
}

// ✅ ACCEPTABLE : any pour code legacy (à documenter)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legacyAPI(data: any): void {
  // TODO: Type this properly when refactoring
}
```

### 3.5 Null Safety

```typescript
// ✅ BON : Optional chaining et nullish coalescing
const deviceName = device?.getName() ?? 'Unknown';
const timeout = config?.timeout ?? DEFAULT_TIMEOUT;

// ✅ BON : Type guards
function isDevice(obj: unknown): obj is IDevice {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'getId' in obj &&
    typeof obj.getId === 'function'
  );
}

if (isDevice(data)) {
  console.log(data.getId()); // TypeScript sait que data est IDevice
}

// ❌ MAUVAIS : Non-null assertion sans justification
const device = getDevice(id)!; // Peut crasher si null
```

---

## 4. Pratiques TDD

### 4.1 Cycle Red-Green-Refactor

**Règle d'Or** : **Jamais de code sans test d'abord**

#### 4.1.1 Étape 1 - RED (Test qui échoue)

```typescript
describe('MACTableService', () => {
  describe('learn()', () => {
    it('should add MAC address entry', () => {
      // Arrange
      const service = new MACTableService();
      const mac = 'AA:BB:CC:DD:EE:FF';
      const port = 'Gi0/1';
      const vlan = 10;

      // Act
      service.learn(mac, port, vlan);

      // Assert
      const entry = service.lookup(mac, vlan);
      expect(entry).not.toBeNull();
      expect(entry?.interface).toBe(port);
    });
  });
});
```

**Vérifications** :
1. ✅ Le test échoue (service n'existe pas encore)
2. ✅ Le test échoue pour la **bonne raison**
3. ✅ Le message d'erreur est clair

#### 4.1.2 Étape 2 - GREEN (Code minimal)

```typescript
class MACTableService {
  private table = new Map<string, MACTableEntry>();

  learn(mac: string, port: string, vlan: number): void {
    this.table.set(mac, { macAddress: mac, interface: port, vlan, age: 0, type: 'dynamic' });
  }

  lookup(mac: string, vlan: number): MACTableEntry | null {
    return this.table.get(mac) || null;
  }
}
```

**Principe** : Code le plus **simple** qui fait passer le test

#### 4.1.3 Étape 3 - REFACTOR (Amélioration)

```typescript
class MACTableService {
  private table = new Map<string, MACTableEntry>();
  private readonly MAX_AGE_SECONDS = 300;

  learn(mac: string, port: string, vlan: number): void {
    const key = this.generateKey(mac, vlan);
    const entry: MACTableEntry = {
      macAddress: mac,
      interface: port,
      vlan,
      age: 0,
      type: 'dynamic'
    };
    this.table.set(key, entry);
    this.scheduleAging(key);
  }

  private generateKey(mac: string, vlan: number): string {
    return `${mac}:${vlan}`;
  }

  private scheduleAging(key: string): void {
    // Aging logic...
  }
}
```

**Vérifications après refactor** :
1. ✅ Tous les tests passent toujours
2. ✅ Code plus lisible
3. ✅ Pas de duplication

### 4.2 Structure des Tests

#### 4.2.1 Pattern AAA (Arrange-Act-Assert)

```typescript
it('should calculate total price correctly', () => {
  // Arrange - Préparer les données
  const items = [
    { name: 'Item 1', price: 10, quantity: 2 },
    { name: 'Item 2', price: 5, quantity: 3 }
  ];
  const calculator = new PriceCalculator();

  // Act - Exécuter l'action
  const total = calculator.calculateTotal(items);

  // Assert - Vérifier le résultat
  expect(total).toBe(35);
});
```

#### 4.2.2 Naming des Tests

```typescript
// ✅ BON : Description claire du comportement
describe('NetworkSimulator', () => {
  describe('registerDevice()', () => {
    it('should add device to internal registry', () => { ... });
    it('should emit device:registered event', () => { ... });
    it('should throw error if device already exists', () => { ... });
  });
});

// ❌ MAUVAIS : Nom vague
describe('NetworkSimulator', () => {
  it('test 1', () => { ... });
  it('should work', () => { ... });
});
```

**Pattern** : `should [expected behavior] when [condition]`

#### 4.2.3 Un Test = Un Concept

```typescript
// ❌ MAUVAIS : Test multiple concepts
it('should handle device lifecycle', () => {
  simulator.registerDevice(device);
  device.powerOn();
  device.powerOff();
  simulator.unregisterDevice(device.getId());
  // Trop de choses testées !
});

// ✅ BON : Tests séparés
it('should register device successfully', () => {
  simulator.registerDevice(device);
  expect(simulator.getDevice(device.getId())).toBe(device);
});

it('should power on device when requested', () => {
  device.powerOn();
  expect(device.isPoweredOn()).toBe(true);
});

it('should unregister device and remove from registry', () => {
  simulator.registerDevice(device);
  simulator.unregisterDevice(device.getId());
  expect(simulator.getDevice(device.getId())).toBeNull();
});
```

### 4.3 Mocking et Isolation

#### 4.3.1 Utiliser des Mocks

```typescript
// ✅ BON : Mock des dépendances externes
describe('DeviceManager', () => {
  it('should notify subscribers when device added', () => {
    const mockEventBus = {
      emit: vi.fn()
    };
    const manager = new DeviceManager(mockEventBus);

    manager.addDevice(device);

    expect(mockEventBus.emit).toHaveBeenCalledWith('device:added', {
      deviceId: device.getId()
    });
  });
});
```

#### 4.3.2 Test Doubles

```typescript
// Spy : Observer sans modifier
const spy = vi.spyOn(service, 'method');

// Stub : Retourner valeur prédéfinie
const stub = vi.fn().mockReturnValue(42);

// Mock : Simuler comportement complet
const mock = vi.fn()
  .mockReturnValueOnce('first')
  .mockReturnValueOnce('second');
```

### 4.4 Coverage Requirements

**Minimums obligatoires** :

| Type de Code | Coverage Min | Cible |
|--------------|--------------|-------|
| Domain Layer | 90% | 95% |
| Application Layer | 80% | 90% |
| Services | 85% | 95% |
| Utilities | 70% | 80% |

**Commande** :

```bash
npm test -- --coverage
```

**Action si < minimum** : PR bloquée, code refusé

---

## 5. Git Workflow

### 5.1 Branches

#### 5.1.1 Stratégie de Branching

```
main (production)
  └── develop (intégration)
       ├── feature/add-dhcp-service
       ├── feature/implement-cisco-router
       ├── bugfix/fix-arp-timeout
       └── refactor/optimize-mac-learning
```

**Types de branches** :

| Type | Préfixe | Exemple | Usage |
|------|---------|---------|-------|
| **Feature** | `feature/` | `feature/add-dns-service` | Nouvelle fonctionnalité |
| **Bugfix** | `bugfix/` | `bugfix/fix-memory-leak` | Correction de bug |
| **Refactor** | `refactor/` | `refactor/simplify-routing` | Refactoring sans changement fonctionnel |
| **Hotfix** | `hotfix/` | `hotfix/critical-security-fix` | Fix urgent en production |
| **Release** | `release/` | `release/1.0.0` | Préparation de release |

#### 5.1.2 Règles de Nommage

```bash
# ✅ BON
feature/add-dhcp-server
bugfix/fix-arp-cache-expiry
refactor/extract-mac-table-service

# ❌ MAUVAIS
feature/john-work
bugfix/fix
my-branch
```

**Format** : `type/short-descriptive-name` (kebab-case)

### 5.2 Commits

#### 5.2.1 Convention Conventional Commits

```bash
<type>(<scope>): <subject>

<body>

<footer>
```

**Types** :

| Type | Description | Exemple |
|------|-------------|---------|
| `feat` | Nouvelle fonctionnalité | `feat(network): add DHCP server` |
| `fix` | Correction de bug | `fix(arp): resolve cache timeout issue` |
| `refactor` | Refactoring | `refactor(devices): extract base class` |
| `test` | Ajout/modification de tests | `test(mac-table): add aging tests` |
| `docs` | Documentation | `docs(readme): update installation steps` |
| `style` | Formatage | `style: fix indentation in NetworkSimulator` |
| `perf` | Performance | `perf(routing): optimize lookup algorithm` |
| `chore` | Tâches diverses | `chore: update dependencies` |

#### 5.2.2 Exemples de Bons Commits

```bash
# ✅ BON : Court, descriptif, impératif
feat(dhcp): implement DORA process

Add DHCP server with full DORA (Discover, Offer, Request, Ack) flow.
Includes lease management and renewal logic.

Closes #123

# ✅ BON : Scope clair
fix(arp): resolve race condition in cache update

The ARP cache update was not thread-safe, causing occasional
inconsistencies when multiple requests were processed simultaneously.

Added mutex lock around cache modifications.

# ✅ BON : Breaking change
feat(api)!: change device interface signature

BREAKING CHANGE: IDevice.getInterfaces() now returns NetworkInterface[]
instead of string[]. Update all device implementations accordingly.

Migration guide: Replace device.getInterfaces()[0] with
device.getInterfaces()[0].name
```

#### 5.2.3 Commits à Éviter

```bash
# ❌ MAUVAIS : Trop vague
fix: bug fixes
update code
work in progress

# ❌ MAUVAIS : Trop long (sujet > 72 caractères)
feat(network): add complete implementation of DHCP server with DORA process and lease management

# ❌ MAUVAIS : Plusieurs changements non reliés
feat: add DHCP + fix ARP bug + update README
```

### 5.3 Pull Requests

#### 5.3.1 Template de PR

```markdown
## Description

Brief description of changes

## Type of Change

- [ ] Feature (nouvelle fonctionnalité)
- [ ] Bugfix (correction de bug)
- [ ] Refactor (refactoring sans changement fonctionnel)
- [ ] Documentation
- [ ] Tests

## Checklist

- [ ] Tests écrits et passent
- [ ] Code coverage ≥ 80%
- [ ] Documentation mise à jour
- [ ] ESLint/Prettier passent
- [ ] Pas de code smells (SonarQube)
- [ ] Self-review effectué

## Tests Effectués

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing

## Screenshots (si UI)

[Add screenshots here]

## Related Issues

Closes #123
Relates to #456
```

#### 5.3.2 Taille des PRs

| Taille | Lignes | Statut | Action |
|--------|--------|--------|--------|
| **XS** | 0-50 | ✅ Idéal | Review rapide |
| **S** | 51-200 | ✅ Bon | Review normale |
| **M** | 201-500 | ⚠️ OK | Review attentive |
| **L** | 501-1000 | ⚠️ Gros | Considérer split |
| **XL** | 1000+ | ❌ Trop gros | **Obligatoire** : split en plusieurs PRs |

**Règle** : Viser des PRs de **100-300 lignes** maximum

---

## 6. Code Review

### 6.1 Processus de Review

#### 6.1.1 Rôles

- **Auteur** : Ouvre la PR, répond aux commentaires, fait les corrections
- **Reviewer** : Examine le code, laisse des commentaires, approuve/demande changements
- **Maintainer** : Merge la PR après approbation

#### 6.1.2 Timeline

1. **Auteur** : Ouvre PR avec description complète
2. **Reviewer** : Review dans les **24h** (délai max)
3. **Auteur** : Corrections dans les **48h**
4. **Reviewer** : Re-review dans les **12h**
5. **Maintainer** : Merge dès approbation

### 6.2 Checklist de Review

#### 6.2.1 Architecture et Design

- [ ] Respect des principes SOLID
- [ ] Design patterns appropriés utilisés
- [ ] Pas de couplage fort
- [ ] Responsabilités bien séparées
- [ ] Pas de duplication de code

#### 6.2.2 Tests

- [ ] Tests TDD (écrits avant le code)
- [ ] Coverage ≥ 80%
- [ ] Tests unitaires isolés
- [ ] Pas de tests flaky
- [ ] Tests passent tous

#### 6.2.3 Code Quality

- [ ] Noms clairs et descriptifs
- [ ] Fonctions courtes (< 50 lignes)
- [ ] Complexité cyclomatique < 10
- [ ] Pas de magic numbers
- [ ] Types TypeScript explicites
- [ ] Pas d'`any` (sauf justifié)

#### 6.2.4 Documentation

- [ ] JSDoc pour fonctions publiques
- [ ] README mis à jour si nécessaire
- [ ] Commentaires expliquent le "pourquoi", pas le "quoi"
- [ ] TODOs avec numéro de ticket

#### 6.2.5 Sécurité

- [ ] Pas de secrets en dur (API keys, passwords)
- [ ] Validation des inputs
- [ ] Sanitization des données utilisateur
- [ ] Pas de vulnérabilités connues

### 6.3 Donner du Feedback

#### 6.3.1 Ton et Style

```markdown
# ✅ BON : Constructif, spécifique
**Suggestion:** Consider extracting this logic into a separate method for better reusability.

**Question:** Could we use the Strategy pattern here instead of if/else chains?

**Nitpick:** Minor: This could be simplified using optional chaining.

# ❌ MAUVAIS : Vague, négatif
This code is bad.
Why did you do this?
```

**Règles** :
- Être **spécifique** et **constructif**
- Poser des **questions** plutôt qu'affirmer
- Proposer des **solutions**
- Utiliser des **tags** : `Suggestion`, `Question`, `Blocking`, `Nitpick`

#### 6.3.2 Catégories de Commentaires

| Tag | Signification | Action Auteur |
|-----|---------------|---------------|
| **Blocking** | Problème critique | **Obligatoire** : Corriger avant merge |
| **Suggestion** | Amélioration recommandée | Optionnel, mais encouragé |
| **Question** | Clarification nécessaire | Répondre ou corriger |
| **Nitpick** | Détail mineur | Optionnel |
| **Praise** | Bon travail | Aucune action |

---

## 7. Documentation

### 7.1 TSDoc (JSDoc for TypeScript)

#### 7.1.1 Fonctions Publiques

```typescript
/**
 * Registers a device in the network simulator
 *
 * @param device - The device to register
 * @throws {DeviceAlreadyExistsError} If device with same ID already exists
 * @returns True if registration successful
 *
 * @example
 * ```typescript
 * const device = new LinuxPC({ type: 'linux-pc', x: 100, y: 200 });
 * simulator.registerDevice(device);
 * ```
 */
public registerDevice(device: IDevice): boolean {
  // Implementation...
}
```

#### 7.1.2 Classes

```typescript
/**
 * Service for managing MAC address table in switches
 *
 * Implements IEEE 802.1D MAC address learning and aging.
 * Entries expire after 300 seconds by default.
 *
 * @example
 * ```typescript
 * const macTable = new MACTableService();
 * macTable.learn('AA:BB:CC:DD:EE:FF', 'Gi0/1', 1);
 * const port = macTable.lookup('AA:BB:CC:DD:EE:FF', 1);
 * ```
 */
export class MACTableService {
  // ...
}
```

#### 7.1.3 Types et Interfaces

```typescript
/**
 * Configuration for a network device
 *
 * @property type - Type of device (linux-pc, cisco-router, etc.)
 * @property hostname - Device hostname (must be unique)
 * @property interfaces - List of network interfaces
 */
export interface DeviceConfig {
  type: DeviceType;
  hostname: string;
  interfaces: NetworkInterfaceConfig[];
}
```

### 7.2 Commentaires

#### 7.2.1 Quand Commenter

```typescript
// ✅ BON : Explication du "pourquoi"
// Using setTimeout instead of setInterval to avoid overlapping executions
// if the previous cleanup takes longer than the interval
setTimeout(() => this.cleanupExpiredEntries(), CLEANUP_INTERVAL);

// ✅ BON : Algorithme complexe
// Binary search is used here because the routing table is kept sorted
// by network prefix length for faster longest-prefix-match lookups
const route = this.binarySearchRoute(destinationIP);

// ❌ MAUVAIS : Explication du "quoi" (déjà évident)
// Increment counter by 1
counter++;

// Add device to map
this.devices.set(device.getId(), device);
```

#### 7.2.2 TODOs

```typescript
// ✅ BON : TODO avec ticket et contexte
// TODO(#123): Implement exponential backoff for retries
// Current implementation uses fixed delay which can cause thundering herd

// ❌ MAUVAIS : TODO vague
// TODO: fix this
// TODO: optimize
```

### 7.3 README et Documentation Projet

#### 7.3.1 Structure README

```markdown
# Project Name

Brief description (1-2 sentences)

## Features

- Feature 1
- Feature 2

## Getting Started

### Prerequisites
### Installation
### Running Tests
### Build

## Architecture

Link to architecture docs

## Contributing

Link to CONTRIBUTING.md

## License
```

#### 7.3.2 Architecture Decision Records (ADRs)

Pour chaque décision d'architecture importante, créer un ADR :

```markdown
# ADR-001: Use Mediator Pattern for NetworkSimulator

## Status

Accepted

## Context

Devices need to communicate with each other without direct coupling.
Multiple approaches were considered: direct references, event bus, mediator.

## Decision

Implement NetworkSimulator as a Mediator pattern.

## Consequences

**Positive:**
- Devices are decoupled from each other
- Easy to add new device types
- Centralized control over frame routing

**Negative:**
- NetworkSimulator can become complex
- Single point of failure

## Alternatives Considered

1. Direct device-to-device references (rejected: tight coupling)
2. Global event bus (rejected: hard to test)
```

---

## 8. Performance

### 8.1 Principes Généraux

1. **Premature Optimization is the Root of All Evil** : Optimiser seulement après mesure
2. **Profile First** : Toujours profiler avant d'optimiser
3. **Measure, Don't Guess** : Benchmarks objectifs

### 8.2 Best Practices Performance

#### 8.2.1 Éviter les Allocations Inutiles

```typescript
// ❌ MAUVAIS : Allocation à chaque appel
function processFrames(frames: Frame[]): void {
  for (const frame of frames) {
    const result = { processed: true, frame }; // Nouvelle allocation
    this.results.push(result);
  }
}

// ✅ BON : Réutiliser les objets
function processFrames(frames: Frame[]): void {
  const result = { processed: false, frame: null as Frame | null };
  for (const frame of frames) {
    result.processed = true;
    result.frame = frame;
    this.results.push({ ...result });
  }
}
```

#### 8.2.2 Memoization

```typescript
class DeviceManager {
  private deviceCache = new Map<string, IDevice>();

  // ✅ BON : Cache pour opérations coûteuses
  getDevicesByType(type: DeviceType): IDevice[] {
    const cacheKey = `type:${type}`;

    if (this.deviceCache.has(cacheKey)) {
      return this.deviceCache.get(cacheKey)!;
    }

    const devices = this.devices.filter(d => d.getType() === type);
    this.deviceCache.set(cacheKey, devices);
    return devices;
  }

  // Invalider cache quand nécessaire
  addDevice(device: IDevice): void {
    this.devices.push(device);
    this.deviceCache.clear(); // Invalider cache
  }
}
```

#### 8.2.3 Éviter les Boucles Imbriquées

```typescript
// ❌ MAUVAIS : O(n²)
function findDuplicates(items: Item[]): Item[] {
  const duplicates: Item[] = [];
  for (const item of items) {
    for (const other of items) {
      if (item !== other && item.id === other.id) {
        duplicates.push(item);
      }
    }
  }
  return duplicates;
}

// ✅ BON : O(n) avec Map
function findDuplicates(items: Item[]): Item[] {
  const seen = new Map<string, Item>();
  const duplicates: Item[] = [];

  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates.push(item);
    } else {
      seen.set(item.id, item);
    }
  }

  return duplicates;
}
```

### 8.3 Benchmarking

```typescript
import { performance } from 'perf_hooks';

describe('Performance Tests', () => {
  it('should process 1000 frames in less than 100ms', () => {
    const frames = generateTestFrames(1000);
    const start = performance.now();

    simulator.processFrames(frames);

    const duration = performance.now() - start;
    expect(duration).toBeLessThan(100);
  });
});
```

---

## 9. Sécurité

### 9.1 Validation des Inputs

```typescript
// ✅ BON : Validation stricte
function setDeviceHostname(hostname: string): void {
  // Validation
  if (!hostname || hostname.length < 1 || hostname.length > 255) {
    throw new ValidationError('Hostname must be 1-255 characters');
  }

  if (!/^[a-zA-Z0-9-]+$/.test(hostname)) {
    throw new ValidationError('Hostname must contain only alphanumeric and hyphens');
  }

  this.hostname = hostname;
}

// ❌ MAUVAIS : Pas de validation
function setDeviceHostname(hostname: string): void {
  this.hostname = hostname;
}
```

### 9.2 Sanitization

```typescript
// ✅ BON : Sanitize user input
function executeCommand(command: string): CommandResult {
  // Remove dangerous characters
  const sanitized = command.replace(/[;&|`$()]/g, '');

  // Whitelist allowed commands
  const allowedCommands = ['ls', 'cd', 'pwd', 'cat'];
  const [cmd, ...args] = sanitized.split(' ');

  if (!allowedCommands.includes(cmd)) {
    throw new SecurityError(`Command not allowed: ${cmd}`);
  }

  return this.execute(cmd, args);
}
```

### 9.3 Secrets Management

```typescript
// ❌ MAUVAIS : Secret en dur
const API_KEY = 'sk-1234567890abcdef';

// ✅ BON : Variable d'environnement
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error('API_KEY environment variable is required');
}

// ✅ BON : .env dans .gitignore
// .gitignore
.env
.env.local
```

---

## 10. Checklist Finale

### 10.1 Avant d'Ouvrir une PR

- [ ] **Tests** : Tous les tests passent (`npm test`)
- [ ] **Coverage** : Coverage ≥ 80% (`npm test -- --coverage`)
- [ ] **Build** : Build réussit (`npm run build`)
- [ ] **Linting** : ESLint passe (`npm run lint`)
- [ ] **Formatting** : Prettier appliqué (`npm run format`)
- [ ] **Types** : TypeScript compile sans erreurs (`npm run type-check`)
- [ ] **Documentation** : TSDoc ajouté pour nouvelles fonctions publiques
- [ ] **Self-Review** : Relu mon propre code attentivement

### 10.2 Checklist Reviewer

- [ ] **Tests TDD** : Tests écrits avant le code
- [ ] **Coverage** : Coverage ≥ 80%
- [ ] **Architecture** : SOLID principles respectés
- [ ] **Design Patterns** : Patterns appropriés utilisés
- [ ] **Naming** : Noms clairs et descriptifs
- [ ] **Complexity** : Pas de fonctions > 50 lignes
- [ ] **Types** : Pas d'`any` sans justification
- [ ] **Documentation** : TSDoc complet
- [ ] **Security** : Pas de vulnérabilités
- [ ] **Performance** : Pas de goulots d'étranglement évidents

---

## Conclusion

Ce guide définit les **standards de qualité obligatoires** pour notre projet. Son respect garantit un code de haute qualité, maintenable et professionnel.

### En Cas de Doute

1. **Consulter ce guide**
2. **Demander en code review**
3. **Proposer un ADR** si décision d'architecture

### Amélioration Continue

Ce guide est un **document vivant** :
- Propositions d'amélioration bienvenues
- Mise à jour régulière basée sur retours d'expérience
- Discussion en équipe pour changements majeurs

---

**"Quality is not an act, it is a habit."** - Aristotle

**Document Status** : ✅ Officiel
**Version** : 1.0.0
**Dernière mise à jour** : 22 janvier 2026
