# BRD — Implémentation PowerShell 5.1 (Simulateur)

**Version** : 1.0
**Date** : 2026-04-07
**Projet** : Ubuntu Sandbox — Module PowerShell pour Windows PC
**Auteur** : Claude Code

---

## Résumé d'Avancement

| Phase | Description | Statut | Couverture |
|-------|-------------|--------|------------|
| Phase 1 | Fondations (Shell Engine + Cmdlets de base) | ✅ COMPLÈTE | 12/12 |
| Phase 2 | Filesystem Cmdlets | ✅ COMPLÈTE | 14/14 |
| Phase 3 | Pipeline Engine | ✅ COMPLÈTE | 7/7 |
| Phase 4 | Réseau (Cmdlets Net*) | ✅ COMPLÈTE | 5/5 |
| Phase 5 | Gestion des Utilisateurs/Groupes/ACL | ✅ COMPLÈTE | 13/13 |
| Phase 6 | Gestion des Services | ✅ COMPLÈTE | 9/9 |
| Phase 7 | Gestion des Processus | ✅ COMPLÈTE | 3/3 |
| Phase 8 | Variables, Providers & Scripting avancé | 🟡 PARTIELLE | 6/18 |
| Phase 9 | Registre Windows (Registry) | ❌ NON COMMENCÉ | 0/10 |
| Phase 10 | Modules, Remote & Sécurité avancée | ❌ NON COMMENCÉ | 0/12 |
| Phase 11 | WMI/CIM avancé | 🟡 PARTIELLE | 2/8 |
| Phase 12 | Scripting avancé (Fonctions, Classes, DSC) | ❌ NON COMMENCÉ | 0/15 |
| Phase 13 | Event Log & Diagnostics | 🟡 PARTIELLE | 1/8 |
| Phase 14 | Scheduled Tasks & Jobs | ❌ NON COMMENCÉ | 0/10 |
| Phase 15 | Formatage & Output avancé | 🟡 PARTIELLE | 3/8 |

**Cmdlets implémentés** : ~75 cmdlets (incluant alias)
**Variables automatiques** : 8 ($PSVersionTable, $Host, $pwd, $env:*, $true, $false, $null, $pid)
**Pipeline stages** : 7 (Where-Object, Select-Object, Sort-Object, Measure-Object, Select-String, Format-Table, Format-List)
**Tests** : 538 tests Windows passent (12 fichiers)

**Légende** : ✅ = implémenté, 🟡 = partiellement implémenté, ❌ = non implémenté

---

## 1. Objectif

Implémenter un simulateur PowerShell 5.1 (Desktop Edition) réaliste au sein de l'Ubuntu Sandbox,
intégré aux Windows PC simulés. L'utilisateur interagit via un terminal PowerShell qui reproduit
fidèlement le comportement, les sorties, les messages d'erreur et les conventions de Windows
PowerShell 5.1 (la version livrée avec Windows 10/11).

Le simulateur doit :
1. **Reproduire les sorties exactes** — Colonnes, espacement, formatage identiques à un vrai PS 5.1
2. **Supporter le pipeline objet** — Les cmdlets passent des objets typés, pas des chaînes
3. **Gérer les erreurs comme un vrai PS** — CategoryInfo, FullyQualifiedErrorId, position d'erreur
4. **Interagir avec les sous-systèmes Windows** — Services, processus, registre, filesystem, réseau, utilisateurs
5. **Supporter le scripting de base** — Variables, conditions, boucles, fonctions

L'architecture est conçue en **composants découplés** pour faciliter l'extension (ajout de cmdlets,
providers, modules).

---
