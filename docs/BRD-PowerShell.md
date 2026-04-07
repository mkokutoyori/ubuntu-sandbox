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
