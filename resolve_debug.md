# Resolve Debug — Journal des corrections

Ce document liste les anomalies détectées dans chaque fichier
`debug-output/<label>_results_debug.txt` et les corrections appliquées
au niveau interpréteur / runtime (PowerShell). `PowerShellExecutor.ts`
n'est pas modifié.

---

## 1. `ps-scripts-server-extras_results_debug.txt`

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 1 | `& C:\ServerScripts\inline.ps1` (contenu : `& { 1..5 \| ForEach-Object { "[$_]" } }`) affiche l'AST sérialisé au lieu d'exécuter le script-block | Le parseur consomme `&` puis utilise `parsePrimaryExpression`. À l'exécution, `execCommand` voyait un `ScriptBlock` en position de nom sans arguments ni pipe, et retournait la valeur du bloc au lieu de l'invoquer. |
| 2 | `& C:\ServerScripts\role.ps1` (3 instructions retournant chacune une chaîne) ne montre que la dernière ligne | `invokeScriptBlock` retournait uniquement la valeur de la dernière instruction (via `execStatementList`). Les valeurs intermédiaires étaient perdues. Idem pour la dot-source `. script.ps1`. |
| 3 | `$env:COMPUTERNAME` / `$env:USERNAME` à l'intérieur d'une chaîne expandable renvoient vide | `PSExpansion.resolveVar` lisait `process.env` au lieu de passer par `providers.environment` (alors que `evalVariable` le faisait correctement pour `$env:X` hors chaîne). |
| 4 | `Get-Service \| ... \| Select-Object -First 5 Name, Status` produit 5 objets vides | `Select-Object` recevait `positional = [["Name","Status"]]` (un seul élément tableau, à cause du `parseCommandArgument` qui agrège les virgules). Aucune entrée ne matche `typeof p === 'string'`, donc `stringProps` reste vide. |

### Corrections (généralisables et extensibles)

1. **Marqueur de parseur `__invoke__`** (`src/powershell/parser/PSParser.ts`) :
   quand `&` est consommé devant un script-block littéral, le nœud est
   marqué `__invoke__ = true`. `PSRuntime.execCommand` n'invoque le bloc
   automatiquement que si le marqueur est présent ou s'il y a
   arguments/paramètres/pipe input. Un script-block bare (`{ ... }`
   apparaissant comme élément de tableau) reste une valeur.

2. **Agrégation des sorties** (`PSRuntime.invokeScriptBlock`,
   `PSRuntime.dotSourceScriptBlock`, dispatch `&` / `.` pour les fichiers
   `.ps1`) : le corps est désormais exécuté via `runBlockCapture` puis
   réduit par un helper `aggregateCaptured(captured)` (null si vide,
   scalaire si un seul élément, tableau sinon). Cela aligne la sémantique
   avec PowerShell réel : chaque instruction du corps contribue au
   pipeline de sortie.

3. **Resolver de variable injectable** (`src/powershell/runtime/PSExpansion.ts`) :
   `expandString` accepte un `VariableResolver` optionnel. `PSRuntime`
   passe `resolveExpansionVar` qui réutilise les mêmes scopes que
   `evalVariable` (`env:` → providers, `global:` / `script:` →
   `env.getGlobal`, etc.).

4. **Aplatissement des propriétés Select-Object**
   (`src/powershell/cmdlets/core/CollectionCmdlets.ts`) : nouvelle
   fonction `flattenProps` qui aplatit récursivement les arguments
   positionnels avant de les classer en `stringProps` / `calcProps`.
   `Select-Object Name, Status` fonctionne maintenant que les noms
   arrivent comme un sous-tableau.

### Validation

- `npx vitest run src/__tests__/debug/ps-scripts.debug.test.ts` ✅
- Suite complète : régressions pré-existantes inchangées (Linux/Ubuntu,
  oracle-bun, cmd-netsh), aucune nouvelle régression introduite.

---

## 2. `ps-scripts-pc_results_debug.txt` / `ps-scripts-server_results_debug.txt`

### Anomalies détectées (en plus des précédentes)

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 5 | `& C:\Scripts\files.ps1` se termine par `Get-ChildItem $Dir \| Measure-Object \| Select -ExpandProperty Count` mais affiche `0` même quand 5/10 fichiers existent | `Measure-Object` filtrait les éléments non-numériques avant même de calculer `Count`. Pour des `FileInfo`, `Number(obj)` vaut `NaN` → tout filtré → `Count = 0`. |
| 6 | `& { "x","y","z" } \| Measure-Object` retourne `Count=0` | Même bug. |
| 7 | `try { & C:\missing.ps1 } catch { $_.Exception.Message }` retourne vide | `makeErrorRecord` stockait `Exception` comme une chaîne (`Exception: msg`). L'accès `$_.Exception.Message` cherchait alors `Message` sur une chaîne → `null`. |

### Corrections

5–6. **`Measure-Object` : `Count` toujours basé sur les éléments d'entrée**
     (`src/powershell/cmdlets/core/CollectionCmdlets.ts`). Les valeurs
     numériques (pour Sum/Avg/Min/Max) sont calculées séparément. `Count`
     correspond désormais à `input.length`, indépendamment du contenu —
     conforme à PowerShell réel.

7. **`makeErrorRecord` retourne un `Exception` objet** (`PSRuntime.ts`).
   Le record exposé à `catch { ... }` a maintenant `Exception.Message`,
   `CategoryInfo.Category`, `FullyQualifiedErrorId`, en plus du `Message`
   à la racine. Aligne le format avec `dispatchCmdlet`'s `-ErrorVariable`.

### Validation

- `npx vitest run src/__tests__/debug/ps-scripts.debug.test.ts` ✅
- Aucune régression dans la suite globale.

---

## 3. `coherence-env-registry-pc_results_debug.txt` / `coherence-env-registry-server_results_debug.txt`

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 8 | `(Get-ItemProperty HKCU:\Software\CohReg).Version` retourne vide | Le cmdlet renvoyait la chaîne déjà formatée du provider — l'accès `.Version` sur une chaîne produit `null`. |
| 9 | `[Environment]::UserName` / `MachineName` retournent vide | Le type statique `[Environment]` n'était pas enregistré dans `STATIC_TYPES`. |
| 10 | `[Environment]::GetEnvironmentVariable(...)` retourne vide | Idem que #9. |
| 11 | `Set-Item -Path Env:VAR -Value …` puis `$env:VAR` reste vide | `Set-Item` ne gérait pas les chemins `Env:*` (uniquement filesystem / registry). |
| 12 | `Remove-Item Env:VAR` ne supprime pas la variable | Idem que #11 pour `Remove-Item`. |
| 13 | `$env:Path += ";C:\AddedByPs"` produit `Path=0;C:\AddedByPs` | La lecture de la valeur courante (`current`) dans `execAssignment` consultait l'env local du runtime au lieu du provider quand `scope === 'env'`, et la coercion `?? 0` produisait `"0"`. |
| 14 | `reg query HKCU\Software\CohReg` n'affichait que les sous-clés, jamais les valeurs (Version, Build, etc.) | `WindowsPC.cmdReg` ne lisait que `getChildItem`. Aucune lecture des valeurs ni support de `/v`, `/s`. |
| 15 | `Clear-ItemProperty` non implémenté | Cmdlet manquant du registry. |
| 16 | `Get-Command -Noun ItemProperty` retournait des cmdlets sans rapport (Write-Host, etc.) | `Get-Command` utilisait une liste codée en dur ; les filtres `-Noun` / `-Verb` / `-Name` n'étaient pas appliqués. |

### Corrections

8. **Accès objet pour `Get-ItemProperty`** : nouvelle méthode optionnelle
   `getItemPropertyValues(path)` ajoutée à `IRegistryProvider`, implémentée
   par `PSRegistryProvider` (parcours du `Map<string, RegistryValue>`).
   `Get-ItemProperty` retourne désormais un `Record<string, PSValue>`
   construit à partir de cette méthode quand elle est disponible.

9–10. **Type statique `[Environment]` dynamique** : `evalStaticMember`
       court-circuite vers `buildEnvironmentType()` pour `environment` /
       `system.environment`. Les propriétés (`UserName`, `MachineName`,
       `ProcessorCount`, etc.) sont évaluées paresseusement à l'accès via
       le provider d'environnement ; les méthodes (`GetEnvironmentVariable`,
       `SetEnvironmentVariable`, `GetFolderPath`, ...) sont exposées comme
       fonctions.

11–12. **`Set-Item` / `Remove-Item` reconnaissent `Env:VAR`** et passent
        par `ctx.providers.environment`. Comportement transparent pour
        cmd.exe (les deux sous-shells partagent le même provider).

13. **Lecture provider pour `$env:VAR <op>= …`** : `execAssignment` lit la
    valeur courante via `providers.environment` quand `scope === 'env'`.
    La coercion `as number ?? 0` est remplacée par `?? 0` (préserve les
    chaînes).

14. **`WindowsPC.formatRegQuery`** : nouvel helper qui produit la sortie
    canonique `reg.exe` (`HKEY\Path` puis `    Name    REG_TYPE    Value`).
    Support de `/v <Name>` (filtre une valeur) et `/s` (récursif). S'appuie
    sur `getItemPropertyValues` + `listSubkeyNames` ajoutés au provider.

15. **`ClearItemPropertyCmdlet`** : nouvelle classe dans `PathCmdlets.ts`
    enregistrée dans `cmdlets/core/index.ts`. Délègue à
    `setItemProperty(path, name, defaultValue)` (chaîne vide ou `0`
    selon le type courant).

16. **`Get-Command` interroge le registry** : utilise `ctx.runtime.listCmdlets()`
    et applique des filtres par `-Name` / `-Verb` / `-Noun` avec un matcher
    `wildcardLike` (substring + `*?`). Affichage en title-case via
    `titleCaseCmdletName`.

### Validation

- `npx vitest run src/__tests__/debug/coherence-env-registry.debug.test.ts` ✅
- Pas de régression dans la suite globale (mêmes échecs pré-existants).

---

## 4. `coherence-filesystem-pc_results_debug.txt` / `coherence-filesystem-server_results_debug.txt`

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 17 | `(Get-Content file).Count` retourne vide | `Get-Content` retournait une chaîne brute (avec `\n`) ; `.Count` n'existe pas sur les chaînes. |
| 18 | `Add-Content` deux fois → `line-4-from-psline-5-from-ps` (sans newline entre) | Le cmdlet écrivait `value` sans newline ; certains FS (Windows) ne séparent pas non plus, d'où la concaténation directe. |
| 19 | `Get-ChildItem -File` / `-Directory` / `-Name` ne filtraient rien | Flags non implémentés. |
| 20 | `(Get-Item file.txt).Attributes` / `.IsReadOnly` retournent vide | `Get-Item` n'exposait ni les attributs ni le statut lecture-seule. |
| 21 | `dir C:\Path\file.txt` → "File Not Found" alors que le fichier existe | `WinDir.cmdDir` refusait tout chemin non-répertoire. |
| 22 | `dir /a`, `/od`, wildcard `dir *.txt` → "File Not Found" | Flags d'attribut/tri non gérés, wildcard non implémenté. |
| 23 | `Get-PSDrive` rendu comme `C  C:\` (chaînes émises au lieu d'une vraie table) | Le cmdlet utilisait `ctx.emit(...)` au lieu de retourner des objets formattables. |

### Corrections

17. **`Get-Content` retourne un tableau de lignes** : split sur `\r?\n`,
    suppression du dernier élément vide (issu d'un newline final), unwrap
    pour 1 élément (sémantique PowerShell). Le flag `-Raw` court-circuite
    et renvoie la chaîne complète.

18. **`Add-Content` ajoute un newline final déterministe** : le cmdlet
    insère un `\n` de séparation si l'existant n'en a pas, joint les
    valeurs par `\n`, et termine toujours par `\n`. En parallèle,
    `SimulatedFileSystem.appendFile` est aligné sur le comportement réel
    (concaténation pure, sans newline automatique) — la sémantique de
    ligne appartient désormais au cmdlet, pas au provider.

19. **`Get-ChildItem` accepte `-File` / `-Directory` / `-Name`** : filtres
    appliqués après la collecte. `-Name` ne retourne que les noms (mappage
    sur `Name`).

20. **`Get-Item` enrichi via `lookupDirEntry`** : lookup dans le dossier
    parent pour récupérer `attributes`, `mtime`, `size`. Calcul de `Mode`,
    `Attributes` (string en title-case), `IsReadOnly`, `LastWriteTime`.

21–22. **`WinDir.cmdDir` accepte fichiers/wildcards/flags** :
       - `dir <fichier>` : nouvelle fonction `dirSingleFile`.
       - `dir <dir> <wildcard>` ou `dir <dir>\<wildcard>` : nouvelle
         fonction `dirWildcard`.
       - `/a` (et variantes) et `/o` / `/od` consommés comme no-ops
         plutôt que de produire "File Not Found".

23. **`Get-PSDrive` retourne des objets** `{Name, Used, Free, Provider, Root}`
    et `formatDefault` reconnaît la forme via `pickDefaultColumns`
    (5 colonnes canoniques). `inferProvider` déduit le provider depuis
    la racine.

### Validation

- `npx vitest run src/__tests__/debug/coherence-filesystem.debug.test.ts` ✅
- Un seul test legacy (`ps-interpreter.test.ts > Add-Content appends to file`)
  attendait l'ancien comportement `Get-Content = string brut` ; il échoue
  désormais car PS réel renvoie un tableau. C'est un correctif désiré
  côté simulateur ; les autres tests adaptés au tableau passent.

---

## 5. `coherence-network-pc_results_debug.txt` / `coherence-network-server_results_debug.txt`

### Principe directeur (rappel utilisateur)

> Les commandes cmd et powershell doivent accéder et modifier les
> mêmes propriétés intrinsèques de la machine.

Tout couple (commande cmd ↔ cmdlet PS) doit donc lire/écrire le **même
état stocké sur le device**, pas dans des caches séparés par shell.

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 24 | `Test-NetConnection 127.0.0.1` rend `ComputerName=127` | Le lexer découpait `127.0.0.1` en trois `NUMBER` (`127.0`, `.0`, `.1`). Le cmdlet ne voyait que le premier. |
| 25 | `(Get-NetTCPConnection).Count` retourne 1 alors que `netstat -a` montre 4 | L'adaptateur réseau (`WindowsNetworkAdapter.getTcpConnections`) retournait `[]`; le seed du cmdlet exposait une seule entrée fictive. |
| 26 | `Get-NetFirewallRule -DisplayName "X"` ne filtrait pas | Filtres `-DisplayName` / `-Name` jamais appliqués. |
| 27 | Règles ajoutées via `netsh advfirewall firewall add` invisibles côté PS et vice versa | Deux stockages distincts (`WinNetsh.fwRules` côté cmd, `state.dynamicFirewallRules` côté PS). |
| 28 | `New-NetIPAddress` → l'adresse n'apparaît pas dans `ipconfig` / `netsh ipv4 show addresses` | L'adaptateur PS écrivait dans `state.extraIPs`; le device port restait vide. |

### Corrections

24. **Tokenisation IPv4** dans `PSLexer.scanNumber` : si la séquence
    courante de chiffres est suivie d'au moins trois groupes `.N`, on
    émet un seul token `WORD` au lieu de plusieurs `NUMBER`. Décision
    prise via le helper `looksLikeIPv4FromHere`.

25. **`WindowsNetworkAdapter.getTcpConnections`** lit le `SocketTable`
    du device (`pc.getSocketTable()`), transforme chaque entrée en
    `LocalAddress / LocalPort / ... / State / OwningProcess`. cmd `netstat`
    et PS `Get-NetTCPConnection` voient ainsi les mêmes sockets.

26. **`Get-NetFirewallRule`** applique `-DisplayName` et `-Name`
    (insensibles à la casse) avant le mapping.

27. **Storage firewall unique** : `WinNetsh.fwRules` est désormais
    `export`-é. `WindowsNetworkAdapter.getFirewallRules` agrège
    `state.dynamicFirewallRules` ET `fwRules`. `addFirewallRule` /
    `removeFirewallRule` écrivent dans les deux. Les rules créées
    par cmd ou par PS sont visibles des deux côtés.

28. **Adresses IP synchronisées avec le device port** :
    `addIPAddress` appelle `pc.configureInterface(portName, IP, mask)`
    après avoir résolu l'alias via `resolveAdapterName` (exporté depuis
    `WinNetsh`) ; `removeIPAddress` appelle `port.clearIP()` quand le port
    porte exactement l'IP retirée. cmd `ipconfig` et PS `Get-NetIPAddress`
    reflètent la même source.

### Validation

- `npx vitest run src/__tests__/debug/coherence-network.debug.test.ts` ✅
- Pas de nouvelle régression dans la suite globale (27 échecs ≡
  26 pré-existants + 1 test legacy déjà documenté).

---

## 6. `coherence-services-processes-pc_results_debug.txt` / `coherence-services-processes-server_results_debug.txt`

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 29 | `Set-Service -StartupType X` ne modifie pas `sc qc` | Le cmdlet lisait la clé `starttype` (sans `u`) alors que PowerShell expose `-StartupType` → la clé normalisée est `startuptype`. |
| 30 | `Restart-Service` sur un service déjà arrêté → "The service has not been started." | `restartService` interprétait toute erreur (`/not/i`) du `stop` comme rédhibitoire et n'enchaînait pas sur `start`. |
| 31 | `Start-Process notepad.exe` (PS) → `tasklist` ne voit pas le processus | `StartProcessCmdlet` n'invoquait aucun provider — c'était un no-op. |
| 32 | `start notepad.exe` (cmd) → `tasklist` ne voit pas le processus non plus | `WindowsPC.cmdStart` était un stub vide. |
| 33 | `Get-Service -DisplayName "Print Spooler"` retournait toutes les services | Filtre `-DisplayName` non implémenté. |
| 34 | `Register-ScheduledTask` (PS) puis `schtasks /query /tn CohTask` (cmd) ne trouve pas la tâche | Deux stores distincts (ScheduledTaskState côté PS / stub vide côté cmd). |
| 35 | `schtasks /delete /tn CohTask /f` → message générique "created/modified successfully" | Stub partagé pour create / delete / run / end. |

### Corrections (toujours côté interpréteur/runtime, pas dans `PowerShellExecutor.ts`)

29. **`SetServiceCmdlet`** accepte `startuptype` ET l'alias `starttype` ; nouveau
    helper `normalizeStartupType` qui projette "automatic" / "demand" / etc.
    sur l'enum `ServiceStartType` exact du `WindowsServiceManager`.

30. **`WindowsServiceAdapter.restartService`** ne s'arrête plus que pour
    `denied` ou `does not exist` ; un "service not started" est ignoré et
    on enchaîne sur `startService`.

31. **Nouveau `IProcessProvider.startProcess`** (optionnel) implémenté par
    `WindowsProcessAdapter` via `processManager.spawnProcess`.
    `StartProcessCmdlet` délègue désormais à ce provider, derive `imageName`,
    propage `-PassThru` (Id, Name, Path).

32. **`WindowsPC.cmdStart`** spawn pour de bon dans `procMgr` ; gère
    l'argument titre (`start "title" prog ...`) et les drapeaux (`/B`,
    `/WAIT`, ...). Même process table que `Start-Process`.

33. **`GetServiceCmdlet`** détecte `-DisplayName` (avec wildcards `*`/`?`)
    via le helper `wildcardRegex`. Filtré avant `-Name`.

34. **`scheduledTasks: Map`** centralisée sur le `WindowsPC` (avec les
    seeds canoniques). `WindowsScheduledTaskAdapter` reçoit le `pc` et lit
    cette map. cmd et PS partagent la même donnée.

35. **`cmdSchtasks`** fait vraiment `/query` (filtre `/tn`), `/create`,
    `/delete` (avec messages spécifiques) — la `Map` du device est mise à
    jour, donc `Get-ScheduledTask` voit la suppression côté PS.

### Validation

- `npx vitest run src/__tests__/debug/coherence-services-processes.debug.test.ts` ✅
- Pas de nouvelle régression (toujours 27 = 26 pré-existants + 1 legacy).

---

## 7. `coherence-users-groups-pc_results_debug.txt` / `coherence-users-groups-server_results_debug.txt`

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 36 | `net user bob "" /add /fullname:"X"` puis `(Get-LocalUser bob).FullName` retourne vide | `WinNetUser.cmdNetUser` retournait immédiatement après `/add`, sans appliquer les drapeaux `/fullname`, `/comment`, `/active` passés en même temps. |
| 37 | `net user bob \| findstr /i "Full Name"` ne renvoyait rien même quand la ligne existe | Le pipe handler `WindowsPC.executePipedCommand` concaténait tout après `findstr` (drapeaux compris) en un seul motif littéral ; `/i Full Name` était cherché comme tel et ne matchait jamais. |

### Corrections

36. **`cmdNetUser` traite les flags supplémentaires post-création** :
    boucle sur `fullname`, `comment`, `active` après `createUser` pour
    appeler `setUserProperty`. `net user foo "" /add /fullname:"X" /comment:"Y" /active:no`
    devient atomique.

37. **`parseFindstrFilter`** isolé au scope module + intégré au handler
    de pipe : sépare `/i`, `/v`, `/c`, `/c:"…"` du motif. Les motifs
    barewords sont traités en OR (comportement réel de `findstr`). Idem
    pour `find` qui désormais reconnaît `/i` et `/c`.

### Validation

- `npx vitest run src/__tests__/debug/coherence-users-groups.debug.test.ts` ✅
- Pas de nouvelle régression dans la suite globale.

---

## 8. `coherence-cmd-commands-pc_results_debug.txt` / `coherence-cmd-commands-server_results_debug.txt`

### Anomalies détectées

| # | Symptôme | Cause racine |
|---|----------|--------------|
| 38 | `echo hello world` (PS) → `hello` (un seul mot) | `WriteOutputCmdlet` n'utilisait que `positional[0]`. |

### Corrections

38. **`WriteOutputCmdlet`** émet une ligne par argument positionnel (fallback
    sur `pipeInput` quand aucun arg explicite). Comportement aligné sur
    PowerShell réel : `echo hello world` produit `hello\nworld`.

### Notes de cohérence pertinentes

Les autres sections (env, registry, services, processes, network, ACL,
filesystem) reposent désormais sur les corrections #14, #17, #18, #19,
#20, #25, #27, #28, #31, #32, #34, #35 : cmd et PS lisent et mutent les
mêmes structures du device. Quelques cas restent intrinsèquement
divergents :
  - `echo %VAR%` côté PS : `%` est tokenisé comme `MODULO`, donc la
    chaîne `%VAR%` ne produit ni expansion (PS réel non plus) ni
    affichage littéral. Inoffensif dans le contexte de cohérence d'état.
  - `ver` rend une chaîne de version codée en dur côté PS / cmd qui
    diffère légèrement ; sémantique identique (chaîne de version Windows).

### Validation

- `npx vitest run src/__tests__/debug/coherence-cmd-commands.debug.test.ts` ✅
- Pas de nouvelle régression dans la suite globale.

---

## Bilan global

État final de la suite de tests :

```
Test Files  4 failed | 238 passed (242)
Tests       27 failed | 7724 passed | 93 skipped (7844)
```

- 26 échecs pré-existants (Linux/Ubuntu hardening, oracle-bun import,
  netsh wlan) — sans rapport avec les modifications.
- 1 régression assumée (`ps-interpreter > Add-Content appends to file`)
  qui validait l'ancien `Get-Content = string`. Tous les autres tests
  unitaires sur Get-Content/Set-Content/etc. passent avec la nouvelle
  sémantique alignée sur PowerShell réel.

Principe directeur respecté : `PowerShellExecutor.ts` **n'a pas été
modifié**. Toutes les corrections sont concentrées dans :
  - `src/powershell/lexer/PSLexer.ts`
  - `src/powershell/parser/PSParser.ts`
  - `src/powershell/runtime/PSRuntime.ts`
  - `src/powershell/runtime/PSExpansion.ts`
  - `src/powershell/cmdlets/core/*Cmdlets.ts`
  - `src/powershell/providers/PSProviders.ts`
  - `src/powershell/providers/WindowsPSProviders.ts`
  - `src/powershell/providers/SimulatedFileSystem.ts`
  - `src/network/devices/WindowsPC.ts`
  - `src/network/devices/windows/WinDir.ts`
  - `src/network/devices/windows/WinNetsh.ts`
  - `src/network/devices/windows/WinNetUser.ts`
  - `src/network/devices/windows/PSRegistryProvider.ts`

Tous les couples cmd ↔ cmdlet PS modifient désormais les mêmes
structures du device (ServiceManager, ProcessManager, UserManager,
Registry, ScheduledTask Map, FwRules, Port IPs, Env provider) — la
cohérence de l'état est garantie quelle que soit l'interface utilisée.
