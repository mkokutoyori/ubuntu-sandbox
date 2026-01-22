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

## Suite du Document

La suite du PRD sera développée dans les prochaines sections :

- **Section 2** : Analyse détaillée de l'existant et définition précise des objectifs
- **Section 3** : Architecture technique, design patterns à utiliser, et structure des modules
- **Section 4** : Spécifications fonctionnelles détaillées pour chaque composant
- **Section 5** : Plan d'implémentation, roadmap et organisation du travail TDD

---

**Statut actuel** : Section 1 complétée (≈2000 mots)
**Progression** : 20% du PRD total
