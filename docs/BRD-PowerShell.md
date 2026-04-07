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

## 3. Shell Engine — Cmdlets de Base

### 3.1 Entrée/Sortie et Session

| Cmdlet / Variable | Alias | Description | Priorité | Statut |
|-------------------|-------|-------------|----------|--------|
| `Write-Host "text"` | | Écrire sur la console (pas dans le pipeline) | P0 | ✅ |
| `Write-Output "text"` | `echo` | Écrire un objet dans le pipeline | P0 | ✅ |
| `Clear-Host` | `cls`, `clear` | Effacer l'écran | P0 | ✅ |
| `Get-Help <cmdlet>` | `help`, `man` | Aide sur un cmdlet | P0 | ✅ |
| `Get-Command` | `gcm` | Lister les cmdlets disponibles | P0 | ✅ |
| `Get-History` | `h`, `history` | Historique des commandes | P1 | ✅ |
| `Get-Date` | | Date/heure actuelle | P1 | ✅ |
| `Get-ExecutionPolicy` | | Politique d'exécution | P1 | ✅ |
| `Set-ExecutionPolicy` | | Changer la politique | P1 | ✅ (no-op) |
| `hostname` | | Nom de la machine | P0 | ✅ |
| `exit` | | Quitter PowerShell | P0 | ✅ |
| `Read-Host` | | Lire l'entrée utilisateur | P2 | ❌ |
| `Write-Error` | | Écrire une erreur dans $Error | P2 | ❌ |
| `Write-Warning` | | Écrire un avertissement | P2 | ❌ |
| `Write-Verbose` | | Écrire si $VerbosePreference | P2 | ❌ |
| `Write-Debug` | | Écrire si $DebugPreference | P2 | ❌ |
| `Write-Progress` | | Barre de progression | P3 | ❌ |
| `Invoke-Expression` | `iex` | Exécuter une chaîne comme commande | P2 | ❌ |
| `Invoke-Command` | `icm` | Exécuter sur machine distante (stub) | P3 | ❌ |

### 3.2 Variables Automatiques

| Variable | Description | Statut |
|----------|-------------|--------|
| `$PSVersionTable` | Table de version PowerShell 5.1 | ✅ |
| `$Host` | Informations sur l'hôte de la console | ✅ |
| `$pwd` | Répertoire courant (PathInfo) | ✅ |
| `$true` / `$false` | Booléens | ✅ |
| `$null` | Valeur nulle | ✅ |
| `$pid` | PID du processus PowerShell | ✅ |
| `$env:VARIABLE` | Variables d'environnement | ✅ |
| `$PSScriptRoot` | Répertoire du script en cours | ❌ |
| `$PSCommandPath` | Chemin du script en cours | ❌ |
| `$Error` | Collection des erreurs récentes | ❌ |
| `$ErrorActionPreference` | Comportement par défaut sur erreur | ❌ |
| `$VerbosePreference` | Contrôle Write-Verbose | ❌ |
| `$DebugPreference` | Contrôle Write-Debug | ❌ |
| `$WarningPreference` | Contrôle Write-Warning | ❌ |
| `$ConfirmPreference` | Seuil de confirmation | ❌ |
| `$WhatIfPreference` | Simulation par défaut | ❌ |
| `$LASTEXITCODE` | Code retour dernière commande native | ❌ |
| `$?` | Statut de la dernière commande | ❌ |
| `$_` / `$PSItem` | Objet courant dans le pipeline | ✅ (dans Where-Object) |
| `$args` | Arguments passés à une fonction/script | ❌ |
| `$input` | Entrée du pipeline dans une fonction | ❌ |
| `$PROFILE` | Chemin du profil PS | ❌ |
| `$HOME` | Répertoire home de l'utilisateur | ❌ |
| `$PSHOME` | Répertoire d'installation PowerShell | ❌ |

### 3.3 Variables d'Environnement ($env:)

| Variable | Valeur simulée | Statut |
|----------|---------------|--------|
| `$env:USERNAME` | Utilisateur courant | ✅ |
| `$env:COMPUTERNAME` | Hostname du PC | ✅ |
| `$env:USERPROFILE` | `C:\Users\<user>` | ✅ |
| `$env:SYSTEMROOT` | `C:\Windows` | ✅ |
| `$env:WINDIR` | `C:\Windows` | ✅ |
| `$env:TEMP` | `C:\Users\User\AppData\Local\Temp` | ✅ |
| `$env:PATH` | `C:\Windows\System32;...` | ✅ |
| `$env:HOMEDRIVE` | `C:` | ✅ |
| `$env:HOMEPATH` | `\Users\User` | ✅ |
| `$env:PROCESSOR_ARCHITECTURE` | `AMD64` | ✅ |
| `$env:OS` | `Windows_NT` | ✅ |
| `$env:COMSPEC` | `C:\Windows\System32\cmd.exe` | ✅ |
| `$env:PSModulePath` | Chemins des modules PS | ✅ |
| `$env:APPDATA` | `C:\Users\User\AppData\Roaming` | ❌ |
| `$env:LOCALAPPDATA` | `C:\Users\User\AppData\Local` | ❌ |
| `$env:ProgramFiles` | `C:\Program Files` | ❌ |
| `$env:ProgramFiles(x86)` | `C:\Program Files (x86)` | ❌ |
| `$env:ProgramData` | `C:\ProgramData` | ❌ |
| `$env:PATHEXT` | `.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1` | ❌ |
| `$env:NUMBER_OF_PROCESSORS` | `4` | ❌ |

### 3.4 Prompt et Bannière

```
# Bannière au démarrage de PowerShell
Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows

# Prompt standard
PS C:\Users\User>

# Prompt en mode élevé (Administrator)
PS C:\Windows\System32>
```

### 3.5 Aliases Intégrés

| Alias | Cmdlet | Statut |
|-------|--------|--------|
| `ls`, `dir`, `gci` | `Get-ChildItem` | ✅ |
| `cd`, `chdir`, `sl` | `Set-Location` | ✅ |
| `pwd`, `gl` | `Get-Location` | ✅ |
| `cat`, `type`, `gc` | `Get-Content` | ✅ |
| `echo` | `Write-Output` | ✅ |
| `cls`, `clear` | `Clear-Host` | ✅ |
| `cp`, `copy`, `cpi` | `Copy-Item` | ✅ |
| `mv`, `move`, `mi` | `Move-Item` | ✅ |
| `rm`, `del`, `erase`, `ri` | `Remove-Item` | ✅ |
| `ren`, `rni` | `Rename-Item` | ✅ |
| `mkdir`, `md` | `New-Item -ItemType Directory` | ✅ |
| `ni` | `New-Item` | ✅ |
| `gps` | `Get-Process` | ✅ |
| `spps`, `kill` | `Stop-Process` | ✅ |
| `gsv` | `Get-Service` | ✅ |
| `sasv` | `Start-Service` | ✅ |
| `spsv` | `Stop-Service` | ✅ |
| `gcm` | `Get-Command` | ✅ |
| `h`, `history` | `Get-History` | ✅ |
| `gi` | `Get-Item` | ✅ |
| `sc` | `Set-Content` | ✅ |
| `ac` | `Add-Content` | ✅ |
| `clc` | `Clear-Content` | ✅ |
| `rvpa` | `Resolve-Path` | ✅ |
| `help`, `man` | `Get-Help` | ✅ |
| `gwmi` | `Get-WmiObject` | ✅ |
| `iex` | `Invoke-Expression` | ❌ |
| `icm` | `Invoke-Command` | ❌ |
| `iwr` | `Invoke-WebRequest` | ❌ |
| `irm` | `Invoke-RestMethod` | ❌ |
| `fl` | `Format-List` | ✅ (pipeline) |
| `ft` | `Format-Table` | ✅ (pipeline) |
| `select` | `Select-Object` | ✅ (pipeline) |
| `where`, `?` | `Where-Object` | ✅ (pipeline) |
| `sort` | `Sort-Object` | ✅ (pipeline) |
| `measure` | `Measure-Object` | ✅ (pipeline) |
| `sls` | `Select-String` | ✅ (pipeline) |
| `%`, `foreach` | `ForEach-Object` | ❌ |
| `tee` | `Tee-Object` | ❌ |
| `ogv` | `Out-GridView` | ❌ |

---

## 4. Filesystem Cmdlets

### 4.1 Navigation et Lecture

| Cmdlet | Alias | Paramètres clés | Description | Statut |
|--------|-------|-----------------|-------------|--------|
| `Get-ChildItem` | `ls`, `dir`, `gci` | `-Path`, `-Filter`, `-Recurse`, `-Force`, `-File`, `-Directory`, `-Name` | Lister fichiers/dossiers (formatage PS : Mode, LastWriteTime, Length, Name) | ✅ |
| `Set-Location` | `cd`, `sl`, `chdir` | `-Path` | Changer de répertoire | ✅ |
| `Get-Location` | `pwd`, `gl` | | Répertoire courant (objet PathInfo) | ✅ |
| `Get-Content` | `cat`, `type`, `gc` | `-Path`, `-TotalCount`, `-Tail`, `-Encoding`, `-Raw` | Lire le contenu d'un fichier | ✅ |
| `Get-Item` | `gi` | `-Path`, `-Force` | Obtenir un objet fichier/dossier (propriétés FileInfo) | ✅ |
| `Test-Path` | | `-Path`, `-PathType (Leaf/Container/Any)` | Tester si un chemin existe | ✅ |
| `Resolve-Path` | `rvpa` | `-Path` | Résoudre un chemin relatif en absolu | ✅ |
| `Split-Path` | | `-Path`, `-Parent`, `-Leaf`, `-Qualifier`, `-NoQualifier` | Extraire parties d'un chemin | ✅ |
| `Join-Path` | | `-Path`, `-ChildPath` | Joindre des chemins | ✅ |

### 4.2 Écriture et Modification

| Cmdlet | Alias | Paramètres clés | Description | Statut |
|--------|-------|-----------------|-------------|--------|
| `Set-Content` | `sc` | `-Path`, `-Value`, `-Encoding` | Écrire (écraser) le contenu d'un fichier | ✅ |
| `Add-Content` | `ac` | `-Path`, `-Value` | Ajouter du contenu à un fichier | ✅ |
| `Clear-Content` | `clc` | `-Path` | Vider le contenu d'un fichier | ✅ |
| `Out-File` | | `-FilePath`, `-Append`, `-Encoding`, `-Width` | Écrire la sortie dans un fichier | ✅ |
| `New-Item` | `ni` | `-Path`, `-Name`, `-ItemType (File/Directory)`, `-Value`, `-Force` | Créer fichier ou dossier | ✅ |
| `Remove-Item` | `rm`, `del`, `ri` | `-Path`, `-Recurse`, `-Force` | Supprimer fichier/dossier | ✅ |
| `Copy-Item` | `cp`, `copy`, `cpi` | `-Path`, `-Destination`, `-Recurse`, `-Force` | Copier fichier/dossier | ✅ |
| `Move-Item` | `mv`, `move`, `mi` | `-Path`, `-Destination`, `-Force` | Déplacer/renommer | ✅ |
| `Rename-Item` | `ren`, `rni` | `-Path`, `-NewName` | Renommer | ✅ |

### 4.3 Formatage Get-ChildItem (Sortie Exacte PS 5.1)

```powershell
PS C:\Users\User> Get-ChildItem

    Directory: C:\Users\User

Mode                 LastWriteTime         Length Name
----                 -------------         ------ ----
d-----        04/07/2026  10:30 AM                Desktop
d-----        04/07/2026  10:30 AM                Documents
d-----        04/07/2026  10:30 AM                Downloads
d-----        04/07/2026  10:30 AM                Pictures
-a----        04/07/2026  10:30 AM           3072 NTUSER.DAT
```

Mode flags :
- `d` = Directory
- `a` = Archive
- `r` = ReadOnly
- `h` = Hidden
- `s` = System
- `l` = ReparsePoint (symlink)

### 4.4 Providers de Chemins (PSDrive)

PowerShell accède aux données via des **providers** uniformes. Chaque provider expose un "drive" :

| Provider | Drive | Description | Statut |
|----------|-------|-------------|--------|
| FileSystem | `C:`, `D:` | Système de fichiers Windows | ✅ |
| Registry | `HKLM:`, `HKCU:` | Registre Windows | ❌ |
| Environment | `Env:` | Variables d'environnement | 🟡 ($env: OK, provider non) |
| Alias | `Alias:` | Aliases PowerShell | ❌ |
| Function | `Function:` | Fonctions définies | ❌ |
| Variable | `Variable:` | Variables PowerShell | ❌ |
| Certificate | `Cert:` | Certificats X.509 | ❌ |

```powershell
# Exemples d'accès via providers
Get-ChildItem HKLM:\SOFTWARE\Microsoft          # Registre
Get-ChildItem Env:                                # Variables d'environnement
Get-ChildItem Alias:                              # Aliases
Get-PSDrive                                       # Lister tous les drives
```

---

## 5. Pipeline Engine

### 5.1 Concept

Le pipeline PowerShell passe des **objets** entre les commandes, pas du texte.
Chaque stage reçoit un `PSObject[]`, le transforme, et passe le résultat au stage suivant.

```powershell
Get-Process | Where-Object { $_.CPU -gt 10 } | Sort-Object WorkingSet -Descending | Select-Object -First 5
#            ┃ filtre objets ┃                ┃ trie par mémoire ┃                  ┃ prend les 5 premiers ┃
```

### 5.2 Stages de Pipeline Implémentés

| Stage | Alias | Paramètres | Description | Statut |
|-------|-------|------------|-------------|--------|
| `Where-Object` | `where`, `?` | `{ $_.Property -op Value }` | Filtrer les objets par condition | ✅ |
| `Select-Object` | `select` | `-Property`, `-First`, `-Last`, `-Skip`, `-Unique`, `-ExpandProperty` | Sélectionner des propriétés ou limiter | ✅ |
| `Sort-Object` | `sort` | `-Property`, `-Descending` | Trier les objets | ✅ |
| `Measure-Object` | `measure` | `-Sum`, `-Average`, `-Minimum`, `-Maximum`, `-Property` | Statistiques sur une collection | ✅ |
| `Select-String` | `sls` | `-Pattern`, `-CaseSensitive` | Chercher du texte (grep-like) | ✅ |
| `Format-Table` | `ft` | `-Property`, `-AutoSize` | Formatage en tableau | ✅ |
| `Format-List` | `fl` | `-Property` | Formatage en liste clé-valeur | ✅ |
| `ForEach-Object` | `%`, `foreach` | `{ script block }` | Exécuter un bloc pour chaque objet | ❌ |
| `Group-Object` | `group` | `-Property` | Grouper les objets par propriété | ❌ |
| `Tee-Object` | `tee` | `-FilePath`, `-Variable` | Bifurquer le pipeline | ❌ |
| `Out-String` | | `-Width` | Convertir en chaîne | ❌ |
| `Out-Null` | | | Supprimer la sortie | ❌ |
| `Out-File` | | `-FilePath`, `-Append` | Écrire dans un fichier | ✅ (standalone) |
| `ConvertTo-Json` | | `-Depth` | Convertir en JSON | ❌ |
| `ConvertFrom-Json` | | | Parser du JSON | ❌ |
| `ConvertTo-Csv` | | | Convertir en CSV | ❌ |
| `ConvertFrom-Csv` | | | Parser du CSV | ❌ |
| `Export-Csv` | | `-Path`, `-NoTypeInformation` | Exporter en CSV | ❌ |
| `Import-Csv` | | `-Path` | Importer un CSV | ❌ |
| `ConvertTo-Html` | | | Convertir en HTML | ❌ |

### 5.3 Opérateurs de Comparaison (dans Where-Object)

| Opérateur | Description | Statut |
|-----------|-------------|--------|
| `-eq` | Égal | ✅ |
| `-ne` | Différent | ✅ |
| `-gt` | Supérieur | ✅ |
| `-ge` | Supérieur ou égal | ✅ |
| `-lt` | Inférieur | ✅ |
| `-le` | Inférieur ou égal | ✅ |
| `-like` | Wildcard match | ✅ |
| `-notlike` | Wildcard non-match | ✅ |
| `-match` | Regex match | ✅ |
| `-notmatch` | Regex non-match | ✅ |
| `-contains` | Collection contient | ❌ |
| `-notcontains` | Collection ne contient pas | ❌ |
| `-in` | Valeur dans collection | ❌ |
| `-notin` | Valeur pas dans collection | ❌ |
| `-is` | Test de type | ❌ |
| `-isnot` | Test de type négatif | ❌ |
| `-band` | Bitwise AND | ❌ |
| `-bor` | Bitwise OR | ❌ |

### 5.4 Opérateurs Logiques

| Opérateur | Description | Statut |
|-----------|-------------|--------|
| `-and` | ET logique | ✅ |
| `-or` | OU logique | ✅ |
| `-not`, `!` | NON logique | ✅ |
| `-xor` | OU exclusif | ❌ |

### 5.5 Exemples de Pipeline Supportés

```powershell
# Filtrer les services en cours d'exécution
Get-Service | Where-Object { $_.Status -eq "Running" }

# Trier les processus par mémoire décroissante
Get-Process | Sort-Object WorkingSet64 -Descending

# Les 5 processus les plus gourmands
Get-Process | Sort-Object CPU -Descending | Select-Object -First 5

# Compter les services par statut
Get-Service | Where-Object { $_.Status -eq "Running" } | Measure-Object

# Afficher seulement certaines colonnes
Get-Process | Select-Object ProcessName, Id, WorkingSet64

# Rechercher du texte dans la sortie
Get-Process | Select-String "svchost"

# Formatage personnalisé
Get-Service | Format-Table Name, Status, StartType -AutoSize
Get-Service | Format-List *
```

---

## 6. Cmdlets Réseau

### 6.1 PowerShell Net* Cmdlets

| Cmdlet | Description | Sortie | Statut |
|--------|-------------|--------|--------|
| `Get-NetIPConfiguration` | Configuration IP complète (comme ipconfig mais objet) | InterfaceAlias, IPv4Address, IPv4DefaultGateway, DNSServer | ✅ |
| `Get-NetIPAddress` | Toutes les adresses IP (IPv4 + IPv6) | IPAddress, InterfaceIndex, InterfaceAlias, PrefixLength, AddressFamily | ✅ |
| `Get-NetAdapter` | Adaptateurs réseau | Name, InterfaceDescription, ifIndex, Status, MacAddress, LinkSpeed | ✅ |
| `Test-Connection` | Ping PowerShell (objet) | Source, Destination, IPV4Address, ResponseTime, StatusCode | ✅ |
| `Resolve-DnsName` | Résolution DNS | Name, Type, TTL, IPAddress | ✅ (stub) |
| `Get-NetRoute` | Table de routage | DestinationPrefix, NextHop, InterfaceIndex, RouteMetric | ❌ |
| `New-NetIPAddress` | Configurer une adresse IP | | ❌ |
| `Remove-NetIPAddress` | Supprimer une adresse IP | | ❌ |
| `Set-NetIPInterface` | Configurer une interface | | ❌ |
| `Get-NetTCPConnection` | Connexions TCP actives (comme netstat) | LocalAddress, LocalPort, RemoteAddress, RemotePort, State | ❌ |
| `Get-NetUDPEndpoint` | Points de terminaison UDP | | ❌ |
| `Get-NetFirewallRule` | Règles de pare-feu | | ❌ |
| `New-NetFirewallRule` | Créer une règle de pare-feu | | ❌ |
| `Remove-NetFirewallRule` | Supprimer une règle de pare-feu | | ❌ |
| `Get-DnsClientServerAddress` | Serveurs DNS configurés | | ❌ |
| `Set-DnsClientServerAddress` | Configurer les serveurs DNS | | ❌ |
| `Test-NetConnection` | Test de connexion avancé (port, traceroute) | | ❌ |

### 6.2 Commandes Réseau Natives (Passthrough CMD)

Ces commandes fonctionnent identiquement en PowerShell et CMD. Le PowerShellExecutor les délègue
directement au WinCommandExecutor :

| Commande | Description | Statut |
|----------|-------------|--------|
| `ipconfig` | Configuration IP (format CMD) | ✅ |
| `ipconfig /all` | Détails complets | ✅ |
| `ipconfig /release` | Libérer bail DHCP | ✅ |
| `ipconfig /renew` | Renouveler bail DHCP | ✅ |
| `ipconfig /flushdns` | Vider le cache DNS | ✅ |
| `ping <host>` | Ping ICMP | ✅ |
| `tracert <host>` | Traceroute | ✅ |
| `route print` | Table de routage | ✅ |
| `route add` | Ajouter une route | ✅ |
| `route delete` | Supprimer une route | ✅ |
| `arp -a` | Table ARP | ✅ |
| `netsh interface ip show config` | Configuration interfaces | ✅ |
| `netsh interface ip set address` | Configurer IP | ✅ |
| `netsh advfirewall` | Pare-feu avancé | ✅ |
| `nslookup` | Requête DNS | ✅ |
| `netstat` | Connexions réseau | ❌ |

### 6.3 Sortie Exacte Get-NetIPConfiguration (PS 5.1)

```powershell
PS C:\> Get-NetIPConfiguration

InterfaceAlias       : Ethernet0
InterfaceIndex       : 3
InterfaceDescription : Intel(R) 82574L Gigabit Network Connection
NetProfile.Name      : Network
IPv4Address          : 192.168.1.10
IPv4DefaultGateway   : 192.168.1.1
DNSServer            : 8.8.8.8
                       8.8.4.4
```

### 6.4 Sortie Exacte Get-NetAdapter (PS 5.1)

```powershell
PS C:\> Get-NetAdapter

Name                  InterfaceDescription               ifIndex Status       MacAddress         LinkSpeed
----                  --------------------               ------- ------       ----------         ---------
Ethernet0             Intel(R) 82574L Gigabit Network...       3 Up           00-50-56-C0-00-01  1 Gbps
```

---

## 7. Gestion des Services

### 7.1 Cmdlets PowerShell Service

| Cmdlet | Paramètres clés | Description | Statut |
|--------|-----------------|-------------|--------|
| `Get-Service` | `-Name`, `-DisplayName`, `-Status`, `-Include`, `-Exclude` | Lister/filtrer les services | ✅ |
| `Start-Service` | `-Name`, `-PassThru` | Démarrer un service | ✅ |
| `Stop-Service` | `-Name`, `-Force`, `-PassThru` | Arrêter un service (-Force stop les dépendants) | ✅ |
| `Restart-Service` | `-Name`, `-Force`, `-PassThru` | Redémarrer un service | ✅ |
| `Set-Service` | `-Name`, `-StartupType`, `-DisplayName`, `-Description`, `-Status` | Configurer un service | ✅ |
| `Suspend-Service` | `-Name`, `-PassThru` | Mettre en pause | ✅ |
| `Resume-Service` | `-Name`, `-PassThru` | Reprendre un service en pause | ✅ |
| `New-Service` | `-Name`, `-BinaryPathName`, `-DisplayName`, `-StartupType`, `-Description` | Créer un service | ✅ |
| `Remove-Service` | `-Name` | Supprimer un service | ✅ |

### 7.2 Commandes CMD Service (sc.exe, net)

| Commande | Description | Statut |
|----------|-------------|--------|
| `sc query [name]` | État d'un service (ou tous) | ✅ |
| `sc queryex [name]` | État étendu (PID, FLAGS) | ✅ |
| `sc qc <name>` | Configuration (type, start type, binary, account, dependencies) | ✅ |
| `sc start <name>` | Démarrer (affiche START_PENDING) | ✅ |
| `sc stop <name>` | Arrêter (affiche STOP_PENDING) | ✅ |
| `sc pause <name>` | Mettre en pause (affiche PAUSE_PENDING) | ✅ |
| `sc continue <name>` | Reprendre (affiche CONTINUE_PENDING) | ✅ |
| `sc config <name> start= <type>` | Changer le type de démarrage | ✅ |
| `sc config <name> displayname= <name>` | Changer le nom d'affichage | ✅ |
| `sc create <name> binPath= <path>` | Créer un service | ✅ |
| `sc delete <name>` | Supprimer un service | ✅ |
| `sc description <name>` | Description du service | ✅ |
| `sc qfailure <name>` | Actions de récupération | ✅ |
| `sc sdshow <name>` | SDDL (permissions) | ✅ |
| `sc failure <name> ...` | Configurer les actions de récupération | ❌ |
| `sc privs <name>` | Privilèges requis | ❌ |
| `net start` | Lister les services démarrés | ✅ |
| `net start <name>` | Démarrer un service | ✅ |
| `net stop <name>` | Arrêter un service | ✅ |

### 7.3 Services Windows Prédéfinis

| Nom | DisplayName | Type | StartType | Account | canPause | Statut |
|-----|-------------|------|-----------|---------|----------|--------|
| `Tcpip` | TCP/IP Protocol Driver | KERNEL_DRIVER | Boot | (kernel) | Non | ✅ |
| `Afd` | Ancillary Function Driver for Winsock | KERNEL_DRIVER | System | (kernel) | Non | ✅ |
| `NetBT` | NetBT | KERNEL_DRIVER | System | (kernel) | Non | ✅ |
| `Dhcp` | DHCP Client | WIN32_SHARE_PROCESS | Automatic | LocalService | Non | ✅ |
| `Dnscache` | DNS Client | WIN32_SHARE_PROCESS | Automatic | NetworkService | Non | ✅ |
| `RpcSs` | Remote Procedure Call (RPC) | WIN32_SHARE_PROCESS | Automatic | NetworkService | Non | ✅ |
| `RpcEptMapper` | RPC Endpoint Mapper | WIN32_SHARE_PROCESS | Automatic | NetworkService | Non | ✅ |
| `SamSs` | Security Accounts Manager | WIN32_SHARE_PROCESS | Automatic | SYSTEM | Non | ✅ |
| `LanmanServer` | Server | WIN32_SHARE_PROCESS | Automatic | SYSTEM | **Oui** | ✅ |
| `LanmanWorkstation` | Workstation | WIN32_SHARE_PROCESS | Automatic | NetworkService | Non | ✅ |
| `mpssvc` | Windows Defender Firewall | WIN32_SHARE_PROCESS | Automatic | LocalService | Non | ✅ |
| `EventLog` | Windows Event Log | WIN32_SHARE_PROCESS | Automatic | LocalService | Non | ✅ |
| `W32Time` | Windows Time | WIN32_SHARE_PROCESS | Automatic | LocalService | Non | ✅ |
| `CryptSvc` | Cryptographic Services | WIN32_SHARE_PROCESS | Automatic | NetworkService | Non | ✅ |
| `Winmgmt` | Windows Management Instrumentation | WIN32_SHARE_PROCESS | Automatic | SYSTEM | Non | ✅ |
| `WinRM` | Windows Remote Management | WIN32_SHARE_PROCESS | **Manual** | NetworkService | Non | ✅ |
| `Spooler` | Print Spooler | WIN32_OWN_PROCESS | Automatic | SYSTEM | **Oui** | ✅ |
| `Schedule` | Task Scheduler | WIN32_SHARE_PROCESS | Automatic | SYSTEM | Non | ✅ |
| `AudioSrv` | Windows Audio | WIN32_SHARE_PROCESS | Automatic | LocalService | Non | ✅ |
| `Themes` | Themes | WIN32_SHARE_PROCESS | Automatic | SYSTEM | Non | ✅ |

### 7.4 Sortie Exacte sc query (Réel)

```
SERVICE_NAME: Dhcp
        TYPE               : 20  WIN32_SHARE_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
```

### 7.5 Sortie Exacte sc qc (Réel)

```
[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: Dhcp
        TYPE               : 20  WIN32_SHARE_PROCESS
        START_TYPE         : 2   AUTO_START
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : C:\Windows\System32\svchost.exe -k dhcp
        LOAD_ORDER_GROUP   :
        TAG                : 0
        DISPLAY_NAME       : DHCP Client
        DEPENDENCIES       : Afd
                           : Tcpip
        SERVICE_START_NAME : NT Authority\LocalService
```

### 7.6 Sortie Exacte Get-Service (PS 5.1)

```
Status     Name                     DisplayName
------     ----                     -----------
Running    Dhcp                     DHCP Client
Running    Dnscache                 DNS Client
Stopped    WinRM                    Windows Remote Management (WS-...
```

### 7.7 Messages d'Erreur PowerShell — Services

```powershell
# Service introuvable
Get-Service : Cannot find any service with service name 'xxx'.
    + CategoryInfo          : ObjectNotFound: (xxx:String) [Get-Service], ServiceCommandException
    + FullyQualifiedErrorId : NoServiceFoundForGivenName,Microsoft.PowerShell.Commands.GetServiceCommand

# Pas administrateur (Start/Stop/Restart)
Stop-Service : Service 'Print Spooler (Spooler)' cannot be stopped due to the following error: Cannot open Spooler service on computer '.'.
    + CategoryInfo          : OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Stop-Service], ServiceCommandException
    + FullyQualifiedErrorId : CouldNotStopService,Microsoft.PowerShell.Commands.StopServiceCommand

# Déjà démarré
Start-Service : Service 'DHCP Client (Dhcp)' cannot be started due to the following error: An instance of the service is already running.
    + CategoryInfo          : OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Start-Service], ServiceCommandException
    + FullyQualifiedErrorId : CouldNotStartService,Microsoft.PowerShell.Commands.StartServiceCommand

# Service non-pausable
Suspend-Service : Service 'DHCP Client (Dhcp)' cannot be suspended because the service does not support being paused and continued.
    + CategoryInfo          : CloseError: (System.ServiceProcess.ServiceController:ServiceController) [Suspend-Service], ServiceCommandException
    + FullyQualifiedErrorId : CouldNotSuspendService,Microsoft.PowerShell.Commands.SuspendServiceCommand
```

### 7.8 Messages d'Erreur CMD — Services

```
# sc start — service déjà démarré
[SC] StartService FAILED 1056:
An instance of the service is already running.

# sc stop — service non démarré
[SC] ControlService FAILED 1062:
The service has not been started.

# net stop — pas admin
System error 5 has occurred.
Access is denied.

# net start — service désactivé
The <Service> service could not be started.
A service specific error occurred: 1058.
More help is available by typing NET HELPMSG 3521.
```

---

## 8. Gestion des Processus

### 8.1 Cmdlets PowerShell Process

| Cmdlet | Paramètres clés | Description | Statut |
|--------|-----------------|-------------|--------|
| `Get-Process` | `-Name`, `-Id`, `-ComputerName` | Lister les processus | ✅ |
| `Stop-Process` | `-Name`, `-Id`, `-Force`, `-PassThru` | Arrêter un processus | ✅ |
| `Start-Process` | `-FilePath`, `-ArgumentList`, `-Verb RunAs`, `-Wait`, `-NoNewWindow` | Démarrer un processus | ❌ |
| `Wait-Process` | `-Name`, `-Id`, `-Timeout` | Attendre la fin d'un processus | ❌ |
| `Debug-Process` | `-Name`, `-Id` | Attacher un débogueur | ❌ (stub) |

### 8.2 Commandes CMD Process

| Commande | Paramètres clés | Description | Statut |
|----------|-----------------|-------------|--------|
| `tasklist` | (aucun) | Liste des processus (format table) | ✅ |
| `tasklist /SVC` | | Processus avec services hébergés | ✅ |
| `tasklist /V` | | Verbose (User, Status, CPU Time, Window Title) | ✅ |
| `tasklist /FI "filter"` | `imagename`, `pid`, `status`, `username`, `memusage` | Filtrer les processus | ✅ |
| `tasklist /FO CSV` | | Sortie format CSV | ✅ |
| `tasklist /FO LIST` | | Sortie format liste | ✅ |
| `tasklist /NH` | | Sans en-têtes | ✅ |
| `taskkill /PID <pid>` | | Tuer par PID | ✅ |
| `taskkill /IM <name>` | | Tuer par nom d'image | ✅ |
| `taskkill /F` | | Forcer (SIGKILL) | ✅ |
| `taskkill /T` | | Tuer l'arbre de processus (enfants) | ✅ |
| `taskkill /FI "filter"` | | Tuer les processus filtrés | ✅ |

### 8.3 Processus Windows Prédéfinis

| Processus | PID | Session | Owner | Mémoire | Critique | Notes |
|-----------|-----|---------|-------|---------|----------|-------|
| `System` | 4 | Services / 0 | SYSTEM | ~144 KB | ✅ | Noyau |
| `smss.exe` | 392 | Services / 0 | SYSTEM | ~1,024 KB | ✅ | Session Manager |
| `csrss.exe` | 504 | Services / 0 | SYSTEM | ~5,120 KB | ✅ | Client/Server Runtime |
| `wininit.exe` | 580 | Services / 0 | SYSTEM | ~1,536 KB | ✅ | Init Windows |
| `services.exe` | 648 | Services / 0 | SYSTEM | ~7,168 KB | ✅ | Gestionnaire services |
| `lsass.exe` | 660 | Services / 0 | SYSTEM | ~10,240 KB | ✅ | Auth locale |
| `svchost.exe` (×N) | 800+ | Services / 0 | SYSTEM / LOCAL/NETWORK SERVICE | Variable | Non | Hôte services |
| `dwm.exe` | 1080 | Console / 1 | DWM-1 | ~45,000 KB | Non | Desktop Window Manager |
| `winlogon.exe` | 596 | Console / 1 | SYSTEM | ~3,072 KB | ✅ | Logon |
| `fontdrvhost.exe` | 820 | Console / 1 | UMFD-1 | ~2,048 KB | Non | Pilote polices |
| `sihost.exe` | 3408 | Console / 1 | User | ~15,360 KB | Non | Shell Infrastructure |
| `taskhostw.exe` | 3468 | Console / 1 | User | ~8,192 KB | Non | Task Host |
| `explorer.exe` | 3576 | Console / 1 | User | ~65,536 KB | Non | Explorateur |
| `RuntimeBroker.exe` | 4120 | Console / 1 | User | ~12,288 KB | Non | Runtime Broker |
| `ctfmon.exe` | 4300 | Console / 1 | User | ~6,144 KB | Non | CTF Loader |
| `cmd.exe` | 4880 | Console / 1 | User | ~3,072 KB | Non | Invite de commandes |
| `conhost.exe` | 5132 | Console / 1 | User | ~8,192 KB | Non | Console Host |
| `spoolsv.exe` | 1640 | Services / 0 | SYSTEM | ~7,680 KB | Non | Print Spooler |

### 8.4 Sortie Exacte Get-Process (PS 5.1)

```
Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName
-------  ------    -----      -----     ------     --  -- -----------
    180      12     2340       5120       0.03    504   0 csrss
    840      33    18432      65536       2.47   3576   1 explorer
    345      22     7168       7680       0.11   1640   0 spoolsv
    650      45    12288      34816       0.95    800   0 svchost
```

### 8.5 Sortie Exacte tasklist (CMD)

```
Image Name                     PID Session Name        Session#    Mem Usage
========================= ======== ================ =========== ============
System Idle Process              0 Services                   0          8 K
System                           4 Services                   0        144 K
csrss.exe                      504 Services                   0      5,120 K
services.exe                   648 Services                   0      7,168 K
lsass.exe                      660 Services                   0     10,240 K
svchost.exe                    800 Services                   0     12,288 K
explorer.exe                  3576 Console                    1     65,536 K
```

### 8.6 Privilèges de Kill

| Action | Standard User | Administrator |
|--------|--------------|---------------|
| Tuer processus utilisateur | ✅ | ✅ |
| Tuer processus SYSTEM (non-critique) | ❌ Access denied | ✅ |
| Tuer processus critique (csrss, lsass, System...) | ❌ Access denied | ❌ Critical process |

### 8.7 Messages d'Erreur PowerShell — Process

```powershell
# Processus introuvable
Get-Process : Cannot find a process with the name "FakeApp". Verify the process name and call the cmdlet again.
    + CategoryInfo          : ObjectNotFound: (FakeApp:String) [Get-Process], ProcessCommandException
    + FullyQualifiedErrorId : NoProcessFoundForGivenName,Microsoft.PowerShell.Commands.GetProcessCommand

# Accès refusé
Stop-Process : Cannot stop process "lsass (660)" because of the following error: Access is denied
    + CategoryInfo          : CloseError: (System.Diagnostics.Process (lsass):Process) [Stop-Process], ProcessCommandException
    + FullyQualifiedErrorId : CouldNotStopProcess,Microsoft.PowerShell.Commands.StopProcessCommand

# Processus critique
Stop-Process : Cannot stop process "csrss (504)" because it is a critical system process.
    + CategoryInfo          : CloseError: (System.Diagnostics.Process (csrss):Process) [Stop-Process], ProcessCommandException
    + FullyQualifiedErrorId : CouldNotStopProcess,Microsoft.PowerShell.Commands.StopProcessCommand
```

---

## 9. Gestion des Utilisateurs, Groupes et ACL

### 9.1 Cmdlets PowerShell — Utilisateurs Locaux

| Cmdlet | Paramètres clés | Description | Statut |
|--------|-----------------|-------------|--------|
| `Get-LocalUser` | `-Name`, `-SID` | Lister les utilisateurs locaux | ✅ |
| `New-LocalUser` | `-Name`, `-Password`, `-FullName`, `-Description`, `-AccountNeverExpires`, `-PasswordNeverExpires` | Créer un utilisateur | ✅ |
| `Set-LocalUser` | `-Name`, `-Password`, `-FullName`, `-Description`, `-PasswordNeverExpires` | Modifier un utilisateur | ✅ |
| `Remove-LocalUser` | `-Name` | Supprimer un utilisateur | ✅ |
| `Enable-LocalUser` | `-Name` | Activer un compte | ✅ |
| `Disable-LocalUser` | `-Name` | Désactiver un compte | ✅ |
| `Rename-LocalUser` | `-Name`, `-NewName` | Renommer | ❌ |

### 9.2 Cmdlets PowerShell — Groupes Locaux

| Cmdlet | Paramètres clés | Description | Statut |
|--------|-----------------|-------------|--------|
| `Get-LocalGroup` | `-Name`, `-SID` | Lister les groupes | ✅ |
| `New-LocalGroup` | `-Name`, `-Description` | Créer un groupe | ✅ |
| `Remove-LocalGroup` | `-Name` | Supprimer un groupe | ✅ |
| `Add-LocalGroupMember` | `-Group`, `-Member` | Ajouter un membre | ✅ |
| `Remove-LocalGroupMember` | `-Group`, `-Member` | Retirer un membre | ✅ |
| `Get-LocalGroupMember` | `-Group` | Lister les membres | ✅ |
| `Rename-LocalGroup` | `-Name`, `-NewName` | Renommer | ❌ |

### 9.3 Cmdlet PowerShell — ACL

| Cmdlet | Paramètres | Description | Statut |
|--------|------------|-------------|--------|
| `Get-Acl` | `-Path` | Lire les ACL d'un objet (fichier, registre) | ✅ |
| `Set-Acl` | `-Path`, `-AclObject` | Modifier les ACL | ❌ |
| `New-Object System.Security.AccessControl.FileSystemAccessRule` | | Créer une règle ACL | ❌ |

### 9.4 Commandes CMD — Utilisateurs/Groupes

| Commande | Description | Statut |
|----------|-------------|--------|
| `net user` | Lister les utilisateurs | ✅ |
| `net user <name>` | Détails d'un utilisateur | ✅ |
| `net user <name> <password> /add` | Créer un utilisateur | ✅ |
| `net user <name> /delete` | Supprimer un utilisateur | ✅ |
| `net user <name> /active:yes\|no` | Activer/désactiver | ✅ |
| `net localgroup` | Lister les groupes | ✅ |
| `net localgroup <group>` | Membres d'un groupe | ✅ |
| `net localgroup <group> <user> /add` | Ajouter au groupe | ✅ |
| `net localgroup <group> <user> /delete` | Retirer du groupe | ✅ |
| `whoami` | Utilisateur courant | ✅ |
| `whoami /all` | Tous les détails (SID, groupes, privilèges) | ✅ |
| `whoami /priv` | Privilèges de l'utilisateur | ✅ |
| `whoami /groups` | Groupes de l'utilisateur | ✅ |
| `whoami /user` | SID de l'utilisateur | ✅ |
| `icacls <path>` | Afficher les ACL NTFS | ✅ |
| `icacls <path> /grant <user>:<perm>` | Accorder des permissions | ✅ |
| `icacls <path> /deny <user>:<perm>` | Refuser des permissions | ✅ |
| `icacls <path> /remove <user>` | Supprimer des permissions | ✅ |
| `icacls <path> /setowner <user>` | Changer le propriétaire | ✅ |

### 9.5 Utilisateurs Prédéfinis

| Utilisateur | Groupes | SID | Enabled | Statut |
|-------------|---------|-----|---------|--------|
| `Administrator` | Administrators | S-1-5-21-...-500 | Non (par défaut) | ✅ |
| `User` | Administrators, Users | S-1-5-21-...-1001 | Oui | ✅ |
| `Guest` | Guests | S-1-5-21-...-501 | Non | ✅ |
| `DefaultAccount` | System Managed Accounts Group | S-1-5-21-...-503 | Non | ✅ |
| `WDAGUtilityAccount` | (aucun) | S-1-5-21-...-504 | Non | ✅ |

### 9.6 Groupes Prédéfinis

| Groupe | Description | Membres initiaux |
|--------|-------------|-----------------|
| `Administrators` | Full control | Administrator, User |
| `Users` | Standard users | User |
| `Guests` | Limited access | Guest |
| `Remote Desktop Users` | Remote access | (vide) |
| `Network Configuration Operators` | Manage network | (vide) |
| `Power Users` | Legacy compatibility | (vide) |
| `Backup Operators` | Backup/restore | (vide) |
| `Cryptographic Operators` | Crypto operations | (vide) |
| `Event Log Readers` | Read event logs | (vide) |
| `Hyper-V Administrators` | Manage Hyper-V | (vide) |
| `Performance Monitor Users` | Monitor performance | (vide) |
| `System Managed Accounts Group` | Managed accounts | DefaultAccount |

### 9.7 Politiques de Sécurité

| Politique | Valeur par défaut | Description |
|-----------|-------------------|-------------|
| `MinPasswordLength` | 0 | Longueur minimum mot de passe |
| `MaxPasswordAge` | 42 jours | Expiration mot de passe |
| `LockoutThreshold` | 0 (désactivé) | Tentatives avant verrouillage |
| `LockoutDuration` | 30 minutes | Durée du verrouillage |
| `PasswordHistoryCount` | 0 | Mots de passe mémorisés |

---

## 10. WMI / CIM

### 10.1 Cmdlets CIM (recommandés depuis PS 3.0)

| Cmdlet | Paramètres clés | Description | Statut |
|--------|-----------------|-------------|--------|
| `Get-CimInstance` | `-ClassName`, `-Filter`, `-Property` | Requêter une classe CIM/WMI | 🟡 (quelques classes) |
| `Get-WmiObject` | `-Class`, `-Filter` | Ancien cmdlet (alias) | 🟡 |
| `Invoke-CimMethod` | `-ClassName`, `-MethodName` | Invoquer une méthode CIM | ❌ |
| `New-CimInstance` | | Créer une instance CIM | ❌ |
| `Set-CimInstance` | | Modifier une instance CIM | ❌ |
| `Remove-CimInstance` | | Supprimer une instance CIM | ❌ |
| `Get-CimClass` | `-ClassName` | Obtenir la définition d'une classe | ❌ |
| `Register-CimIndicationEvent` | | S'abonner à un événement CIM | ❌ |

### 10.2 Classes WMI/CIM Simulées

| Classe | Propriétés | Description | Statut |
|--------|-----------|-------------|--------|
| `Win32_OperatingSystem` | Caption, Version, BuildNumber, OSArchitecture, TotalVisibleMemorySize, FreePhysicalMemory, LastBootUpTime, CSName, SystemDrive, WindowsDirectory | Informations OS | ✅ |
| `Win32_ComputerSystem` | Name, Domain, Manufacturer, Model, NumberOfProcessors, TotalPhysicalMemory, UserName | Informations machine | ✅ |
| `Win32_Processor` | Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, Architecture | CPU | ❌ |
| `Win32_PhysicalMemory` | Capacity, Speed, Manufacturer, MemoryType | RAM physique | ❌ |
| `Win32_DiskDrive` | Model, Size, MediaType, InterfaceType | Disques | ❌ |
| `Win32_LogicalDisk` | DeviceID, Size, FreeSpace, DriveType, FileSystem, VolumeName | Volumes logiques | ❌ |
| `Win32_NetworkAdapter` | Name, MACAddress, Speed, NetEnabled, InterfaceIndex | Adaptateurs réseau | ❌ |
| `Win32_NetworkAdapterConfiguration` | IPAddress, IPSubnet, DefaultIPGateway, DNSServerSearchOrder, DHCPEnabled | Config réseau | ❌ |
| `Win32_Service` | Name, DisplayName, State, StartMode, PathName, StartName | Services | ❌ |
| `Win32_Process` | Name, ProcessId, WorkingSetSize, CommandLine, CreationDate | Processus | ❌ |
| `Win32_UserAccount` | Name, FullName, SID, Disabled, PasswordRequired | Comptes utilisateurs | ❌ |
| `Win32_Group` | Name, SID, Description | Groupes locaux | ❌ |
| `Win32_Share` | Name, Path, Description, AllowMaximum | Partages réseau | ❌ |
| `Win32_Printer` | Name, DriverName, PortName, Default | Imprimantes | ❌ |
| `Win32_BIOS` | SMBIOSBIOSVersion, Manufacturer, ReleaseDate, SerialNumber | BIOS | ❌ |
| `Win32_BaseBoard` | Manufacturer, Product, SerialNumber | Carte mère | ❌ |
| `Win32_TimeZone` | Caption, Bias, StandardName | Fuseau horaire | ❌ |

### 10.3 Sortie Exacte Get-CimInstance Win32_OperatingSystem

```powershell
PS C:\> Get-CimInstance Win32_OperatingSystem | Format-List Caption, Version, BuildNumber, OSArchitecture

Caption        : Microsoft Windows 10 Pro
Version        : 10.0.22621
BuildNumber    : 22621
OSArchitecture : 64-bit
```

---

## 11. Registre Windows (Registry Provider)

### 11.1 Cmdlets Registre (via PSDrive)

| Cmdlet | Usage | Description | Statut |
|--------|-------|-------------|--------|
| `Get-Item` | `Get-Item HKLM:\SOFTWARE\Microsoft` | Lire une clé | ❌ |
| `Get-ChildItem` | `Get-ChildItem HKLM:\SOFTWARE` | Lister les sous-clés | ❌ |
| `Get-ItemProperty` | `Get-ItemProperty HKLM:\...\Windows NT\CurrentVersion` | Lire les valeurs d'une clé | ❌ |
| `Get-ItemPropertyValue` | `Get-ItemPropertyValue HKLM:\... -Name "ProductName"` | Lire une valeur spécifique | ❌ |
| `Set-ItemProperty` | `Set-ItemProperty HKLM:\... -Name "key" -Value "val"` | Écrire une valeur | ❌ |
| `New-Item` | `New-Item HKLM:\SOFTWARE\MyApp` | Créer une clé | ❌ |
| `New-ItemProperty` | `New-ItemProperty -Path ... -Name ... -Value ... -PropertyType ...` | Créer une valeur | ❌ |
| `Remove-Item` | `Remove-Item HKLM:\SOFTWARE\MyApp -Recurse` | Supprimer une clé | ❌ |
| `Remove-ItemProperty` | `Remove-ItemProperty -Path ... -Name ...` | Supprimer une valeur | ❌ |
| `Test-Path` | `Test-Path HKLM:\SOFTWARE\MyApp` | Tester l'existence d'une clé | ❌ |

### 11.2 Ruches (Hives) Simulées

| PSDrive | Ruche réelle | Description | Statut |
|---------|-------------|-------------|--------|
| `HKLM:` | `HKEY_LOCAL_MACHINE` | Configuration machine | ❌ |
| `HKCU:` | `HKEY_CURRENT_USER` | Configuration utilisateur courant | ❌ |
| `HKCR:` | `HKEY_CLASSES_ROOT` | Classes (fusion HKLM + HKCU) | ❌ |
| `HKU:` | `HKEY_USERS` | Tous les profils utilisateurs | ❌ |
| `HKCC:` | `HKEY_CURRENT_CONFIG` | Config matériel courant | ❌ |

### 11.3 Clés Registre Pré-remplies (Simulation)

```
HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion
    ProductName            : Windows 10 Pro
    CurrentBuildNumber     : 22621
    EditionID              : Professional
    InstallationType       : Client
    RegisteredOrganization :
    RegisteredOwner        : User
    SystemRoot             : C:\Windows
    CurrentVersion         : 6.3
    CurrentMajorVersionNumber : 10
    CurrentMinorVersionNumber : 0

HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion
    ProgramFilesDir        : C:\Program Files
    ProgramFilesDir (x86)  : C:\Program Files (x86)
    CommonFilesDir         : C:\Program Files\Common Files
    DevicePath             : C:\Windows\inf
    MediaPathUnexpanded    : C:\Windows\Media

HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName
    ComputerName           : WIN-PC1

HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters
    Hostname               : WIN-PC1
    Domain                 :
    SearchList             :

HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer
    ShellState             : (binary)

HKCU:\Environment
    TEMP                   : C:\Users\User\AppData\Local\Temp
    TMP                    : C:\Users\User\AppData\Local\Temp
```

### 11.4 Types de Valeurs Registre

| PropertyType | Description | Exemple |
|-------------|-------------|---------|
| `String` (REG_SZ) | Chaîne de caractères | `"Windows 10 Pro"` |
| `ExpandString` (REG_EXPAND_SZ) | Chaîne avec %variables% | `"%SystemRoot%\System32"` |
| `DWord` (REG_DWORD) | Entier 32 bits | `1` |
| `QWord` (REG_QWORD) | Entier 64 bits | `4294967296` |
| `Binary` (REG_BINARY) | Données binaires | `[byte[]](0x01, 0x02)` |
| `MultiString` (REG_MULTI_SZ) | Tableau de chaînes | `@("val1", "val2")` |

---

## 12. Scripting Avancé

### 12.1 Variables et Types

| Fonctionnalité | Syntaxe | Description | Statut |
|----------------|---------|-------------|--------|
| Variable simple | `$x = 42` | Assignation | ❌ |
| Variable string | `$name = "World"` | Chaîne | ❌ |
| Interpolation de chaîne | `"Hello $name"` | Expansion de variables | ❌ |
| Here-string | `@"...\n..."@` | Multi-ligne avec interpolation | ❌ |
| Here-string littéral | `@'...\n...'@` | Multi-ligne sans interpolation | ❌ |
| Array | `$arr = @(1, 2, 3)` | Tableau | ❌ |
| Hashtable | `$h = @{ Key = "Value" }` | Table de hachage | ❌ |
| Cast de type | `[int]$x = "42"` | Conversion de type | ❌ |
| Type accélérateurs | `[string]`, `[int]`, `[bool]`, `[datetime]`, `[array]`, `[hashtable]`, `[pscustomobject]` | Types raccourcis | ❌ |
| Splatting | `$params = @{ Name = "svc" }; Get-Service @params` | Passage de paramètres via hashtable | ❌ |
| Scope de variable | `$global:x`, `$script:x`, `$local:x`, `$private:x` | Portée des variables | ❌ |

### 12.2 Opérateurs

| Catégorie | Opérateurs | Statut |
|-----------|-----------|--------|
| Arithmétiques | `+`, `-`, `*`, `/`, `%`, `++`, `--` | ❌ |
| Assignation | `=`, `+=`, `-=`, `*=`, `/=`, `%=` | ❌ |
| Chaîne | `-f` (format), `-replace`, `-split`, `-join`, `*` (repeat) | ❌ |
| Type | `-is`, `-isnot`, `-as` | ❌ |
| Unaire | `[type]`, `-not`, `!`, `-bnot`, `++`, `--` | ❌ |
| Redirection | `>`, `>>`, `2>`, `2>>`, `2>&1`, `*>` | ❌ |
| Plage | `1..10` (range operator) | ❌ |
| Membre | `.Property`, `::StaticMethod`, `.Method()` | ❌ |
| Index | `$arr[0]`, `$hash["key"]`, `$arr[-1]` | ❌ |
| Sous-expression | `$(expression)` | ❌ |
| Appel | `& "command"`, `. .\script.ps1` (dot-sourcing) | ❌ |

### 12.3 Structures de Contrôle

```powershell
# if / elseif / else
if ($x -gt 10) {
    "Greater"
} elseif ($x -eq 10) {
    "Equal"
} else {
    "Less"
}

# switch
switch ($color) {
    "Red"   { "Stop" }
    "Green" { "Go" }
    "Yellow" { "Caution" }
    Default { "Unknown" }
}

# for
for ($i = 0; $i -lt 10; $i++) {
    Write-Host $i
}

# foreach
foreach ($item in $collection) {
    Process-Item $item
}

# while
while ($condition) {
    Do-Something
}

# do-while / do-until
do {
    $result = Get-Something
} while ($result -ne $expected)

do {
    $result = Get-Something
} until ($result -eq $expected)

# try / catch / finally
try {
    $result = Risky-Operation
} catch [System.IO.FileNotFoundException] {
    "File not found: $_"
} catch {
    "Error: $_"
} finally {
    Cleanup
}

# throw
throw "Custom error message"
throw [System.ArgumentException]::new("Invalid argument")
```

| Structure | Statut |
|-----------|--------|
| `if / elseif / else` | ❌ |
| `switch` | ❌ |
| `for` | ❌ |
| `foreach` | ❌ |
| `while` | ❌ |
| `do-while` / `do-until` | ❌ |
| `try / catch / finally` | ❌ |
| `throw` | ❌ |
| `break` / `continue` | ❌ |
| `return` | ❌ |
| `exit` | ✅ |
| `trap` | ❌ |

### 12.4 Fonctions

```powershell
# Fonction simple
function Get-Greeting {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [ValidateSet("Mr", "Mrs", "Ms")]
        [string]$Title = "Mr"
    )

    return "$Title $Name, welcome!"
}

# Fonction avancée (cmdlet-like)
function Get-SystemInfo {
    [CmdletBinding()]
    param(
        [Parameter(ValueFromPipeline)]
        [string[]]$ComputerName = $env:COMPUTERNAME
    )

    begin { $results = @() }

    process {
        foreach ($computer in $ComputerName) {
            $results += [PSCustomObject]@{
                Name = $computer
                OS   = (Get-CimInstance Win32_OperatingSystem -ComputerName $computer).Caption
            }
        }
    }

    end { return $results }
}

# Filter (raccourci pour Process block)
filter Where-Even { if ($_ % 2 -eq 0) { $_ } }
```

| Fonctionnalité | Statut |
|----------------|--------|
| `function Name { }` | ❌ |
| `param()` block | ❌ |
| `[Parameter()]` attributes | ❌ |
| `[ValidateSet()]`, `[ValidateRange()]`, `[ValidateScript()]` | ❌ |
| `begin / process / end` blocks | ❌ |
| `[CmdletBinding()]` | ❌ |
| `filter` | ❌ |
| Scope (global/script/local) | ❌ |

### 12.5 Classes PowerShell (PS 5.0+)

```powershell
class ServerInfo {
    [string]$Name
    [string]$IPAddress
    [ValidateSet("Windows", "Linux")]
    [string]$OS

    ServerInfo([string]$name, [string]$ip) {
        $this.Name = $name
        $this.IPAddress = $ip
    }

    [string] ToString() {
        return "$($this.Name) ($($this.IPAddress))"
    }

    static [ServerInfo] FromDns([string]$hostname) {
        $ip = (Resolve-DnsName $hostname).IPAddress
        return [ServerInfo]::new($hostname, $ip)
    }
}

# Enum
enum ServerRole {
    WebServer
    DatabaseServer
    FileServer
    DomainController
}
```

| Fonctionnalité | Statut |
|----------------|--------|
| `class` déclaration | ❌ |
| Propriétés typées | ❌ |
| Constructeurs | ❌ |
| Méthodes | ❌ |
| Méthodes statiques | ❌ |
| Héritage (`: BaseClass`) | ❌ |
| `enum` | ❌ |

---
