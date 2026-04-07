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

## 2. Architecture Générale

### 2.1 Organisation des Fichiers

```
src/network/devices/windows/
├── PowerShellExecutor.ts          # Moteur principal — routing cmdlets, variables, aliases
├── PSPipeline.ts                  # Pipeline objet (Where-Object, Select-Object, Sort-Object, etc.)
├── PSProcessCmdlets.ts            # Get-Process, Stop-Process — formatage PS5.1 exact
├── PSServiceCmdlets.ts            # Get/Start/Stop/Restart/Set/Suspend/Resume/New/Remove-Service
├── WindowsProcessManager.ts       # Registre des processus système (PID, owner, session, mémoire)
├── WindowsServiceManager.ts       # Registre des services Windows (état, type, dépendances, binaire)
├── WindowsUserManager.ts          # Utilisateurs, groupes, ACLs, privilèges, politiques de sécurité
├── WindowsFileSystem.ts           # VFS Windows (drives, NTFS ACLs, attributs, case-insensitive)
├── WinCommandExecutor.ts          # Routeur CMD pour commandes natives (ipconfig, ping, etc.)
├── WinDir.ts                      # Commande DIR (formatage exact Windows)
├── WinFileCommands.ts             # copy, move, del, mkdir, rmdir, type, echo, attrib, tree
├── WinIpconfig.ts                 # ipconfig /all, /release, /renew, /flushdns
├── WinPing.ts                     # ping -n, -t, -l, -w, -4, -6
├── WinTracert.ts                  # tracert avec hops simulés
├── WinNetsh.ts                    # netsh interface ip, firewall, wlan, advfirewall
├── WinRoute.ts                    # route print, add, delete
├── WinArp.ts                      # arp -a, -d, -s
├── WinSc.ts                       # sc query/queryex/qc/start/stop/pause/continue/config/create/delete/description/qfailure/sdshow
├── WinTasklist.ts                 # tasklist /SVC, /V, /FI, /FO CSV|LIST|TABLE, /NH
├── WinTaskkill.ts                 # taskkill /PID, /IM, /F, /T, /FI
├── WinNetStart.ts                 # net start, net stop — messages d'erreur réalistes
├── WinNetUser.ts                  # net user, net localgroup — gestion utilisateurs CMD
├── WinWhoami.ts                   # whoami /all, /priv, /groups, /user
├── WinIcacls.ts                   # icacls — permissions NTFS
├── WinWevtutil.ts                 # wevtutil — event log (stub)
├── WinHelp.ts                     # help / /?
└── (futur)
    ├── PSRegistryProvider.ts      # Registre Windows (HKLM:, HKCU:, etc.)
    ├── PSScriptEngine.ts          # Moteur de scripting (if/else, for, while, functions, classes)
    ├── PSModuleManager.ts         # Import-Module, Get-Module
    ├── PSJobManager.ts            # Start-Job, Get-Job, Receive-Job
    ├── PSRemoting.ts              # Enter-PSSession, Invoke-Command (stubs)
    ├── PSEventLog.ts              # Get-EventLog, Write-EventLog, Get-WinEvent
    ├── PSScheduledTask.ts         # Get/New/Set/Remove-ScheduledTask
    └── PSErrorEngine.ts           # ErrorRecord complet, $Error, Try/Catch/Finally
```

### 2.2 Hiérarchie des Composants

```
WindowsPC (src/network/devices/WindowsPC.ts)
  │
  ├── WindowsFileSystem           # VFS — C:\, D:\ — NTFS sémantique
  ├── WindowsUserManager          # Utilisateurs, groupes, ACLs
  ├── WindowsServiceManager       # Services Windows (~20 built-in)
  ├── WindowsProcessManager       # Processus (~20 built-in)
  │
  ├── WinCommandExecutor          # CMD.exe — route les commandes natives
  │   ├── WinDir, WinFileCommands
  │   ├── WinIpconfig, WinPing, WinTracert, WinNetsh
  │   ├── WinSc, WinTasklist, WinTaskkill, WinNetStart
  │   ├── WinNetUser, WinWhoami, WinIcacls
  │   └── WinRoute, WinArp
  │
  └── PowerShellExecutor          # PS5.1 — cmdlets + pipeline + variables
      ├── PSPipeline              # Where-Object, Sort-Object, Select-Object, etc.
      ├── PSProcessCmdlets        # Get-Process, Stop-Process
      ├── PSServiceCmdlets        # *-Service (9 cmdlets)
      └── (futur) PSRegistryProvider, PSScriptEngine, PSModuleManager...
```

### 2.3 Flux d'Exécution

```
Utilisateur tape "Get-Service -Name Dhcp | Select-Object Status, Name"
  │
  ▼
PowerShellExecutor.execute(cmdline)
  │
  ├─ Détecte le pipe → executePipeline()
  │    │
  │    ├─ executeForPipeline("Get-Service -Name Dhcp")
  │    │    └─ Retourne PSObject[] (données structurées, pas du texte)
  │    │
  │    └─ runPipeline(objects, ["Select-Object Status, Name"])
  │         └─ Filtre les propriétés → formatTable() → string
  │
  └─ Retour: texte formaté affiché dans le terminal
```

### 2.4 Modèle Objet PowerShell (PSObject)

PowerShell est un shell **orienté objet**. Chaque cmdlet retourne des objets .NET, pas des chaînes.
Le simulateur reproduit ce comportement avec un type `PSObject` (property bag) :

```typescript
// Type léger représentant un objet PowerShell
export type PSValue = string | number | boolean | null;
export interface PSObject { [key: string]: PSValue; }

// Les cmdlets retournent PSObject[] quand passés dans un pipeline :
// Get-Process → [{ ProcessName: "svchost", Id: 1234, ... }, ...]
// Get-Service → [{ Status: "Running", Name: "Dhcp", DisplayName: "DHCP Client" }, ...]

// Quand affiché directement (sans pipe), le cmdlet formate en texte PS5.1
```

### 2.5 Modèle d'Erreur PowerShell

Les erreurs PowerShell sont des `ErrorRecord` contenant :
- **Message** : description lisible
- **CategoryInfo** : `<catégorie>: (<objet>:<type>) [<cmdlet>], <exception>`
- **FullyQualifiedErrorId** : identifiant unique `<id>,<namespace>.<cmdlet>Command`

```
Get-Service : Cannot find any service with service name 'xxx'.
    + CategoryInfo          : ObjectNotFound: (xxx:String) [Get-Service], ServiceCommandException
    + FullyQualifiedErrorId : NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand
```

---
