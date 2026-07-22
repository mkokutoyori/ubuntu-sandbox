# Audit — Simulation Windows/PowerShell

**Périmètre** : `src/powershell/`, `src/network/devices/windows/`, `src/network/devices/WindowsPC.ts`, `src/terminal/subshells/{PowerShellSubShell,CmdSubShell}.ts`, `docs/BRD-PowerShell.md`.
**Méthode** : lecture de code (interpréteur PSRuntime ~2960 lignes, parser ~1780 lignes, ~9100 lignes de cmdlets, ~32000 lignes côté `devices/windows`), exécution de la suite de tests PowerShell (`npx vitest run src/__tests__/unit/powershell/ ...`), comparaison avec le BRD.
**Résultat des tests exécutés** : 63 fichiers, **2387 tests passés**, 69 skip, 0 échec.

---

## Synthèse (tableau)

| Sous-système | État | Sévérité max |
|---|---|---|
| Lexer/Parser PowerShell (`src/powershell/lexer`, `parser`) | ✅ Solide | — |
| Interpréteur/Runtime (`PSRuntime.ts`) | ✅ Bon, très complet | MAJEUR (double moteur, cf. plus bas) |
| Pipeline objet (Where/Select/Sort/Group/Measure/ForEach) | ✅ Vrais objets, pas de texte | MINEUR |
| Messages d'erreur (ErrorRecord) | ❌ Format simplifié `ERROR: msg`, pas de CategoryInfo/FullyQualifiedErrorId dans le nouveau moteur | **MAJEUR** |
| Registre (HKLM/HKCU) | ✅ Structure réaliste + cohérence avec les services | MINEUR |
| Event Log | 🟡 Fonctionnel mais partiel (pas de vrais IDs XML/EventData) | MINEUR |
| Services/Processus (Get-Service/Get-Process) | ✅ Formatage PS5.1 fidèle, colonnes correctes | MINEUR |
| Cmdlets réseau (Test-NetConnection, Get-NetIPAddress…) | ✅ Branchées sur le vrai data plane (ARP/routage/TCP) | MINEUR |
| Ping/Tracert Windows vs Linux | ✅ Parité réelle (code partagé `EndHost`) | — |
| DHCP client Windows | ✅ Partagé avec Linux (`EndHost.dhcpClient`) | — |
| Enter-PSSession / WinRM | 🟡 Connexion réseau réelle, exécution du script en-process (pas de sérialisation AST réelle) | MINEUR (assumé et documenté) |
| cmd.exe (`WinCommandExecutor`, `CmdSubShell`) | ✅ Large couverture (dir, netstat, sc, tasklist…) | MINEUR |
| Duplication moteur legacy `PowerShellExecutor.ts` (4343 lignes) | ⚠️ Toujours présent en fallback silencieux | **MAJEUR** (dette technique) |
| Scripting avancé (try/catch/trap, scriptblocks, splatting) | ✅ Bien plus complet que ne le documente le BRD | MINEUR |
| WMI/CIM | 🟡 Shim minimal (3 classes) | MAJEUR (fonctionnalité) |
| Tâches planifiées | ✅ Implémentées (contrairement au BRD qui les dit absentes) | — |
| ACL NTFS (icacls, Get/Set-Acl) | ✅ Présent des deux côtés (CMD et PS) | MINEUR |
| Documentation (BRD-PowerShell.md) | ❌ Très obsolète (daté 2026-04-07), sous-estime largement l'implémentation réelle | **MAJEUR** (fiabilité doc) |
| Tests (`src/__tests__/unit/powershell/`) | ✅ 2387 tests, bonne couverture fonctionnelle | MINEUR (aucun test ne vérifie le format CategoryInfo) |

---

## Le pipeline objet : verdict détaillé

**Verdict : le pipeline est bien orienté objet, pas du texte déguisé.**

- Le type `PSValue` (`src/powershell/runtime/PSEnvironment.ts`) couvre `string | number | boolean | null | Date | PSValue[] | Record<string, PSValue> | ScriptBlock | ...` — les cmdlets manipulent des objets `Record<string, PSValue>` avec de vraies propriétés typées, pas des chaînes formatées à l'avance.
- `Get-Process` (`src/powershell/cmdlets/core/ProcessCmdlets.ts`) retourne des objets avec des clés `ProcessName`, `Id`, `Handles`, `WS(K)`, etc. — `Get-Process | Where-Object {$_.Id -gt 1000} | Select-Object Name,Id` fonctionne réellement sur les propriétés, vérifié dans `src/__tests__/unit/powershell/process-cmdlets-migrated.test.ts` et `powershell-pipeline.test.ts`.
- Les opérateurs de comparaison sont appliqués aux valeurs réelles (`PSRuntime.ts:1244-1291`) : `-eq/-ne/-gt/-lt/-like/-match/-contains/-in/-band/-bor/-shl/-shr`, avec variantes case-sensitive (`-ceq`, `-clike`, `-cmatch`) — fidélité correcte au comportement .NET (`-eq` insensible à la casse par défaut, `-ceq` sensible).
- Le formatage à l'affichage est un traitement **postérieur** — la fonction `formatDefault` (`src/network/devices/windows/PSPipeline.ts:736-749`) transforme le tableau d'objets en table/liste seulement à l'écriture finale, exactement comme le fait `Out-Default`/`Format-Table` implicite dans le vrai PowerShell.
- `ForEach-Object`, `Group-Object`, `Measure-Object`, `Sort-Object`, `Tee-Object`, `Select-Object -ExpandProperty`, `Compare-Object`, `Get-Unique` sont tous implémentés dans `src/powershell/cmdlets/core/CollectionCmdlets.ts` — bien au-delà des « 7 stages » annoncés par le BRD.
- `$_` / `$PSItem` sont liés à chaque itération de `Where-Object`/`ForEach-Object` via un scope enfant dédié (`PSRuntime.ts:935-961` `invokeBlockInScope`), avec sauvegarde/restauration de la valeur précédente — comportement correct pour les blocs imbriqués.

**Limite réelle constatée** : la « typisation » des objets est **structurelle par nom de propriété**, pas par un vrai système de types .NET. `pickDefaultColumns()` (`PSPipeline.ts:781-796`) détecte un `Service` en testant la présence des clés `status`/`name`/`displayname` — il n'y a pas de `PSTypeNames` ni de `[Service]`/`[Process]` porté par l'objet. Conséquence pratique : deux objets métier différents qui partagent accidentellement les mêmes noms de propriétés seraient formatés avec la mauvaise vue par défaut. `Get-Member` (`CollectionCmdlets.ts:819-869`) reconstruit les membres par inspection JS (`typeof`), sans `TypeName:` affiché — écart mineur par rapport à `Get-Member` réel qui affiche l'en-tête `TypeName: System.Diagnostics.Process`.

---

## Constats détaillés

### Interpréteur / langage

- ✅ **[BIEN FAIT]** Architecture lexer → parser (AST) → interpreter (tree-walker) → runtime proprement séparée, cohérente avec la convention du dépôt (`src/powershell/lexer/PSLexer.ts`, `parser/PSParser.ts` 1782 lignes, `runtime/PSRuntime.ts` 2962 lignes).
- ✅ Scopes lexicaux corrects avec chaîne parent/enfant et modificateurs explicites `$global:`/`$script:`/`$local:` (`src/powershell/runtime/PSEnvironment.ts:25-116`).
- ✅ `try/catch/finally` et `trap` implémentés (`PSRuntime.ts:566-726`, `execTry`), scriptblocks avec fermetures (`GetNewClosure`), splatting `@var` en position d'argument (`PSParser.ts:1692-1695`, `PSRuntime.ts:1910-1921`).
- ✅ `$?`, `$LASTEXITCODE`, `$Error`, `-ErrorAction`/`-ErrorVariable`, `$ErrorActionPreference` (Continue/Stop/SilentlyContinue/Ignore) gérés de façon centralisée dans `dispatchCmdlet()` (`PSRuntime.ts:2280-2334`) — c'est un point fort, la sémantique d'erreur non-terminante vs terminante est correctement respectée.
- ⚠️ **[MINEUR]** Pas de système d'attributs de paramètres façon .NET (`[Parameter(ValueFromPipeline=$true)]`) : chaque cmdlet lit `ctx.named`/`ctx.positional`/`ctx.pipeInput` à la main. Fonctionnellement correct pour l'usage du simulateur, mais un script utilisateur qui ferait de l'introspection de paramètres (`(Get-Command X).Parameters`) ne verrait pas les vraies métadonnées de binding.
- 💡 Pas de classes PowerShell (`class Foo {}`, PS5.1 le permet) ni de DSC — cohérent avec le BRD (Phase 12 non commencée) et un choix de périmètre raisonnable.

### Messages d'erreur — écart de fidélité CRITIQUE dans le nouveau moteur

- ❌ **[MAJEUR]** `emitError()` (`src/powershell/cmdlets/CmdletContext.ts:100`, implémenté dans `PSRuntime.ts:2405-2416`) produit uniquement `ERROR: <message>` sur stdout :
  ```ts
  emitError: (msg: string) => {
    ...
    if (!silentlyContinue) self.outputLines.push(`ERROR: ${msg}`);
  }
  ```
  Un vrai PowerShell 5.1 affiche :
  ```
  Get-Process : Cannot find a process with the name "notepad". Verify the process name and call the cmdlet again.
      + CategoryInfo          : ObjectNotFound: (notepad:String) [Get-Process], ProcessCommandException
      + FullyQualifiedErrorId : NoProcessFoundForGivenName,Microsoft.PowerShell.Commands.GetProcessCommand
  ```
  Le simulateur produit simplement `ERROR: Cannot find a process with the name "notepad".` — pas de préfixe cmdlet, pas de `CategoryInfo`, pas de `FullyQualifiedErrorId`. Vérifié sur `ProcessCmdlets.ts:87,108` et `ServiceCmdlets.ts:148,154` (Get-Process / Get-Service), qui appellent `ctx.emitError()` avec un message nu.
  Le commentaire du test `src/__tests__/unit/powershell/error-action-silently-continue.test.ts:6-15` confirme explicitement que ce format `ERROR: ...` est le comportement voulu/actuel, capturé depuis un run de debug — ce n'est donc pas un bug isolé mais un choix de simplification assumé, jamais corrigé depuis.
  **Contraste** : le moteur legacy `PowerShellExecutor.ts` (toujours présent, voir plus bas) produit lui de vrais blocs `CategoryInfo`/`FullyQualifiedErrorId` fidèles (ex. lignes 3190, 3375, 3506, 4336) — la fidélité a donc **régressé** pendant la migration vers le nouvel interpréteur pour tout ce qui passe par les cmdlets ICmdlet.
  **Impact** : tout script qui parse `$Error[0].CategoryInfo.Category` ou attend le préfixe `<Cmdlet> : ` échouera silencieusement ; aucun test dans `src/__tests__/unit/powershell/` ne vérifie `CategoryInfo` (`grep -rl CategoryInfo` → 0 résultat dans ce dossier).
- ✅ `$Error[0]` contient bien un objet structuré (`Exception.Message`, `CategoryInfo.Category`, `TargetObject`) — la donnée existe, seul le **rendu texte** à l'écran n'est pas fidèle.
- 💡 `-ErrorVariable`/`2>&1` fonctionnent correctement (`PSRuntime.ts:2336-2349`, `399`) — bonne nouvelle, seul le format d'affichage pêche.

### Pipeline / cmdlets

- ✅ `Format-Table`/`Format-List` implicites avec vue par défaut par « forme » d'objet (Service/Process/NetAdapter/NetIPAddress/DirectoryEntry) — corrige un vrai bug historique documenté en commentaire de test (`default-format-views.test.ts:6-18`, préservation de la vue 3-colonnes après `Sort-Object`), ce qui montre un travail itératif honnête sur la fidélité de rendu.
- ✅ Comparateurs complets `-eq/-ne/-gt/-ge/-lt/-le/-like/-notlike/-match/-notmatch/-contains/-notcontains/-in/-notin/-is/-isnot/-band/-bor/-bxor/-shl/-shr/-replace/-split` (`PSRuntime.ts:1234-1330`) — bien au-delà de ce que documente le BRD (§5.3-5.4, qui liste `-contains`/`-in`/`-is` comme ❌ alors qu'ils sont implémentés).
- ✅ `Group-Object`, `Tee-Object`, `ConvertTo-Json`/`ConvertFrom-Json`, `Export-Csv`/`Import-Csv` implémentés (`CollectionCmdlets.ts`, `ConversionCmdlets.ts`) — contredit le BRD qui les marque ❌.
- ⚠️ **[MINEUR]** `Get-Member` (`CollectionCmdlets.ts:819-869`) ne produit pas d'en-tête `TypeName:` et infère `NoteProperty` vs `Property` via un flag interne `__pscustomobject__` plutôt qu'un vrai type marqué — suffisant pour l'usage courant mais visible en cas d'inspection poussée.

### Registre Windows

- ✅ **[BIEN FAIT]** Structure hiérarchique réaliste `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion`, `SYSTEM\CurrentControlSet\Services`, `SAM`, `HARDWARE\DESCRIPTION\System` (`src/network/devices/windows/PSRegistryProvider.ts:60-120`), avec des valeurs `ProductName`/`CurrentBuildNumber`/`InstallationType` qui diffèrent correctement entre édition Client (`Windows 10 Pro`) et Server (`Windows Server 2022 Standard`) — bon niveau de détail.
- ✅ **[BIEN FAIT]** Cohérence registre ↔ services : `upsertServiceKey()` (`PSRegistryProvider.ts:411-416`) synchronise `HKLM:\SYSTEM\CurrentControlSet\Services\<name>` (`ObjectName`, `Start`, `ImagePath`) avec `WindowsServiceManager` — un audit via `Get-ItemProperty HKLM:\SYSTEM\...\Services\Dhcp` verra les mêmes données que `sc qc Dhcp`/`Get-Service`. C'est le genre de détail qui distingue un simulateur sérieux d'un simulateur de façade.
- 💡 `Set-Location HKLM:` (provider Registry pour `cd`) — présent (`PSPathCmdlets.ts`/providers), cohérent avec l'objectif « providers uniformes » du BRD §4.4.

### Event Log

- 🟡 `Get-EventLog`, `Get-WinEvent`, `Write-EventLog`, `Clear-EventLog`, `New-EventLog`, `Limit-EventLog` tous présents (`src/powershell/cmdlets/core/EventLogCmdlets.ts`, 190 lignes) + provider dédié `PSEventLogProvider.ts` (384 lignes) + projection `WindowsEventLogProjection.ts` (211 lignes) — largement au-delà de ce que le BRD documente (Phase 13 « 1/8 »).
- ⚠️ **[MINEUR]** Pas de vérification approfondie du détail XML `EventData`/`RenderingInfo` façon `Get-WinEvent -FilterXPath`; la couverture semble orientée « messages » plutôt que reproduction exacte du schéma d'événement Windows. Non bloquant pour l'usage pédagogique du simulateur.

### Réseau — parité Windows/Linux (voir aussi section dédiée ci-dessous)

- ✅ **[BIEN FAIT]** `ping`/`tracert` Windows utilisent le **même** moteur que Linux : `WinPing.ts:333-354` appelle `ctx.executePingSequence()`, qui délègue à `EndHost.executePingSequence()` (`src/network/devices/EndHost.ts:2737-2788`) — résolution de route réelle (`resolveRoute`), résolution ARP réelle (`resolveARP`), envoi de paquets ICMP réels via `sendPing()`. `LinuxMachine.ts:2172` appelle exactement la même méthode héritée. Aucun raccourci « faux ping » constaté.
- ✅ `Test-NetConnection`/`Test-Connection` (`NetworkCmdlets.ts:591-650`) s'appuient sur `net.testPingProbe()`/`net.testTcpProbe()`/`net.egressInfoFor()` injectés depuis le device — pas de valeurs statiques.
- ✅ Client DHCP Windows = `EndHost.dhcpClient` (`EndHost.ts:312,621`), la même classe `DHCPClient` que pour Linux — `ipconfig /renew` déclenche un vrai cycle DHCP simulé (`WinIpconfig.ts:337`).
- 🟡 **[MINEUR, assumé]** `Enter-PSSession`/WinRM (`src/network/devices/windows/server/winrm/WinRmServer.ts`) établit une vraie connexion TCP/5985, une vraie authentification locale/domaine, respecte pare-feu/câblage — mais une fois la session ouverte, l'exécution du script distant se fait **en process** via `PSInterpreter.invokeRemote()` plutôt que par sérialisation réelle du script block sur le fil. Le commentaire du fichier (lignes 6-14) assume explicitement ce compromis (« this simulator runs every device in one JS process, so there is no real wire representation of a PSScriptBlock AST to ship »). C'est un choix raisonnable et documenté, mais cela signifie qu'un scénario de latence/coupure réseau pendant `Invoke-Command` ne peut pas être modélisé de bout en bout comme un vrai flux WinRM.
- ✅ `netstat` (`WindowsPC.ts:1744`, `cmdNetstat`) utilise le vrai `SocketTable` du device — contredit le BRD qui le marque ❌.

### cmd.exe / commandes DOS classiques

- ✅ Large couverture : `dir` (`WinDir.ts`, formatage exact avec bannière `Directory:`), `ipconfig` (toutes options), `ping`, `tracert`, `netsh`, `route`, `arp`, `sc` (query/queryex/qc/create/delete/description/qfailure/sdshow), `tasklist`/`taskkill` (avec filtres `/FI`), `net user`/`net localgroup`/`net start`/`net stop`, `whoami /all|/priv|/groups|/user`, `icacls`.
- ✅ `WinCommandExecutor.ts` fait plus de 4000 lignes de routage — commandes bien réparties dans des modules dédiés (`WinTasklist.ts`, `WinNetUser.ts`, etc.), cohérent avec le principe de responsabilité unique.
- 💡 `CmdSubShell.ts` (210 lignes) est minimaliste et délègue à `device.executeCmdCommand()` — bonne séparation, pas de logique dupliquée avec PowerShell pour les commandes natives partagées (`ipconfig`/`netsh`/`arp`/`route`/`net`), qui sont de vrais `ICmdlet` dans le nouveau moteur (commentaire `PowerShellSubShell.ts:34-41`).

### Génie logiciel

- ✅ **[BIEN FAIT]** `ICmdlet` (Command Pattern strict, Open/Closed — `src/powershell/cmdlets/ICmdlet.ts`) : ajouter un cmdlet ne modifie jamais le registre central, juste un `registry.register(new XCmdlet())`. `CmdletRegistry.resolve()` gère noms canoniques + alias, insensible à la casse.
- ✅ Séparation lexer/parser/interpreter/runtime propre et suivie, cohérente avec la convention `src/bash/` du même dépôt — pas de duplication de code brute constatée entre les deux interpréteurs (grammaires différentes, mais patterns d'architecture partagés délibérément, ce qui est une bonne pratique et non une duplication nuisible).
- ⚠️ **[MAJEUR — dette technique]** **Deux moteurs PowerShell coexistent** :
  - Le nouveau : `src/powershell/` (~19 800 lignes) — utilisé par défaut.
  - L'ancien : `src/network/devices/windows/PowerShellExecutor.ts` (**4343 lignes**) + `PSPipeline.ts` (1164 lignes) — toujours instancié à chaque `PowerShellSubShell` (`PowerShellSubShell.ts:50,67`), utilisé (a) explicitement pour `ping`/`tracert` (limitation technique : le tree-walker est synchrone, l'ancien exécuteur est async) et (b) comme **filet de sécurité silencieux** dès que l'interpréteur lève une erreur contenant `not recognized` (`PowerShellSubShell.ts:270-306`, `isFallbackError`).
  - Un compteur `PowerShellSubShell.fallbackHits` existe pour mesurer l'usage de ce filet (`PowerShellSubShell.ts:288`) mais **n'est vérifié par aucun test** (`grep -r fallbackHits src/__tests__` → 0 résultat) : personne ne surveille plus la fréquence réelle du fallback vers le vieux moteur en production/CI. Risque : la migration peut sembler « terminée » alors qu'une part significative du trafic réel passe encore par le code legacy non maintenu en parallèle du nouveau (deux implémentations à faire évoluer si un comportement doit changer).
  - Le nouveau moteur importe même une fonction du legacy (`formatDefault` depuis `PSPipeline.ts`, `PSRuntime.ts:28`) — couplage circulaire entre `src/powershell/` (censé être le moteur « propre ») et `src/network/devices/windows/` (censé être la couche device). Cela brouille la frontière architecturale attendue par `CLAUDE.md`.
  - **Recommandation** : soit achever la migration (convertir ping/tracert en ICmdlet async — le tree-walker synchrone est la seule barrière technique citée), soit documenter clairement `PowerShellExecutor.ts` comme définitivement legacy-only-for-native-commands et supprimer le filet de sécurité générique (qui masque silencieusement des régressions du nouveau moteur).
- ❌ **[MAJEUR — fiabilité documentaire]** `docs/BRD-PowerShell.md` (daté 2026-04-07, non mis à jour depuis) est **significativement en retard sur le code** : il annonce Phase 9 (Registre) « ❌ NON COMMENCÉ », Phase 14 (Scheduled Tasks) « ❌ NON COMMENCÉ », Phase 11 (WMI/CIM) « 🟡 PARTIELLE 2/8 », `Group-Object`/`ConvertTo-Json`/`Test-NetConnection`/`netstat`/`-contains`/`-in` marqués ❌ — alors que tous ces éléments sont implémentés et testés. Le BRD sous-estime aussi fortement le volume de tests (« 538 tests » vs 2387 mesurés ici). Un audit ou un contributeur qui se fierait au BRD pour prioriser le travail restant partirait sur une base fausse. Recommandation : régénérer le tableau de phases à partir du registre de cmdlets réel (`CmdletRegistry.cmdlets()` liste déjà tout dynamiquement, `CmdletContext.ts:61-67`) plutôt que de le maintenir à la main.
- ✅ Suite de tests conséquente et qui passe intégralement au moment de l'audit : 63 fichiers, 2387 tests, 0 échec, 69 skip (à examiner : que couvrent les skips ?).
- 💡 Bonne pratique observée à plusieurs reprises : des commentaires de test citent le fichier de debug-output (`debug-output/ps-services-processes-*_results_debug.txt`) qui a révélé le bug corrigé — traçabilité utile entre le run diagnostique et le correctif.

---

## Parité Windows vs Linux dans le simulateur

Le constat principal, positif et à souligner : **Windows n'est pas un citoyen de seconde classe sur le plan réseau**.

| Aspect | Linux | Windows | Verdict |
|---|---|---|---|
| Ping/Traceroute | `EndHost.executePingSequence`/`executeTraceroute` | **Même méthode héritée** (`LinuxMachine.ts:2172`, `WinPing.ts` via `ctx.executePingSequence`) | ✅ Parité totale |
| Résolution ARP | Réelle (`resolveARP`) | Réelle, même code (`EndHost.ts`) | ✅ Parité totale |
| Client DHCP | `DHCPClient` (EndHost) | **Même classe** `DHCPClient` (EndHost) | ✅ Parité totale |
| Table de sockets / netstat | `SocketTable` | Même `SocketTable` (`WindowsPC.ts:1744`) | ✅ Parité |
| Test de connexion | ping/nc | `Test-NetConnection` branché sur les mêmes probes réseau | ✅ Parité fonctionnelle |
| SSH | Client/serveur SSH réel | `WindowsSshClient.ts` présent (`network/`) | 🟡 non audité en détail ici |
| Remoting distant (SSH inter-devices vs Enter-PSSession) | n/a (bash n'a pas d'équivalent objet) | Connexion réseau réelle, exécution en-process | 🟡 compromis assumé, documenté |

Là où l'écart se creuse, ce n'est **pas** le data plane mais la **couche shell/scripting** : le bash interpreter (`src/bash/`) n'a pas d'équivalent du problème « deux moteurs coexistants » constaté côté PowerShell — signe que la dette technique du double-moteur est spécifique à l'historique de développement de PowerShell (migration en cours), pas à un sous-investissement structurel sur Windows.

---

## Top 10 des actions recommandées

1. **[CRITIQUE fidélité]** Restaurer le format d'erreur PowerShell standard (`<Cmdlet> : <message>` + blocs `CategoryInfo`/`FullyQualifiedErrorId`) dans `emitError()` (`PSRuntime.ts:2405-2416`) — actuellement `ERROR: <message>` seulement. Ajouter des tests qui vérifient `CategoryInfo`/`FullyQualifiedErrorId` sur au moins Get-Process/Get-Service/Get-Item (aucun test actuel ne le fait).
2. **[MAJEUR dette]** Trancher le sort de `PowerShellExecutor.ts` (4343 lignes) et `PSPipeline.ts` (1164 lignes) : soit terminer la migration (rendre `ping`/`tracert` asynchrones-compatibles avec le tree-walker), soit figer explicitement leur rôle et retirer le filet de sécurité générique `isFallbackError()` qui peut masquer des régressions du nouveau moteur en silence.
3. **[MAJEUR observabilité]** Réactiver le suivi de `PowerShellSubShell.fallbackHits` dans un test ou un rapport CI pour mesurer objectivement la part de trafic encore servie par le moteur legacy.
4. **[MAJEUR doc]** Régénérer `docs/BRD-PowerShell.md` depuis l'état réel du code (le registre de cmdlets s'énumère dynamiquement via `CmdletRegistry.cmdlets()`) — le document actuel sous-estime fortement la couverture réelle (Registre, Scheduled Tasks, WMI, Group-Object, ConvertTo-Json, netstat, opérateurs `-in`/`-contains` tous marqués absents alors qu'implémentés) et risque de faire perdre du temps à quiconque s'y fie pour prioriser.
5. **[MOYEN]** Ajouter un vrai marquage de type sur les objets pipeline (`__typeName__` ou équivalent) plutôt que la détection heuristique par noms de propriétés dans `pickDefaultColumns()` (`PSPipeline.ts:781-830`) — fragile si deux types métier partagent des noms de colonnes.
6. **[MOYEN]** Étoffer `Get-Member` avec l'en-tête `TypeName:` réel et distinguer proprement `ScriptMethod`/`AliasProperty`/`NoteProperty` selon l'origine de l'objet.
7. **[MOYEN]** Étendre le shim `Get-CimInstance`/`Get-WmiObject` (`SystemMgmtCmdlets.ts`) au-delà des ~3 classes WMI actuellement supportées (`Win32_Process`, `Win32_Service`, `Win32_PerfFormattedData_PerfProc_Process`) si des scénarios pédagogiques CIM plus larges sont prévus.
8. **[MINEUR]** Documenter explicitement (commentaire de code + doc) la limite du remoting WinRM (script exécuté en-process après authentification réseau réelle) pour éviter toute confusion future sur le niveau de fidélité de `Invoke-Command`/`Enter-PSSession`.
9. **[MINEUR]** Vérifier les 69 tests `skip` de la suite PowerShell (`npx vitest run src/__tests__/unit/powershell/ --reporter=verbose` puis grep `skip`) pour s'assurer qu'ils ne cachent pas des régressions connues non résolues.
10. **[MINEUR]** Étendre la couverture `Get-WinEvent -FilterXPath`/structure `EventData` si des scénarios de type SOC/forensic sont un objectif pédagogique du simulateur — actuellement orienté "liste de messages" plutôt que schéma XML complet.

---

## Ce qui est bien fait (à ne pas perdre de vue)

- Le pipeline est un **vrai** pipeline objet, avec des opérateurs de comparaison fidèles (y compris les variantes case-sensitive `-c*`), pas une resucée du bash avec des tuyaux de texte.
- La parité réseau Windows/Linux est réelle et non feinte : ping, DHCP, ARP, tables de sockets, tests de connexion partagent le même moteur `EndHost`/`DHCPClient`/`SocketTable` que Linux — c'est le point le plus solide de tout l'audit.
- La cohérence registre ↔ services (`upsertServiceKey`) est un détail de fidélité que peu de simulateurs pédagogiques implémentent — bon niveau d'exigence.
- Le volume et la stabilité de la suite de tests (2387 tests, 0 échec au moment de l'audit) donnent confiance dans la non-régression au jour le jour.
- L'architecture `ICmdlet`/`CmdletRegistry` respecte proprement Open/Closed et facilite l'ajout continu de nouveaux cmdlets sans toucher au cœur du runtime.
