# Gap Analysis — PowerShell vs CMD (source unique de vérité)

**Périmètre :** cohérence entre le shell `cmd` et le shell PowerShell d'un même
hôte Windows simulé (`WindowsPC` / `windows-server`). Objectif : garantir que
les deux shells n'ont **qu'une seule source de vérité — l'état de la machine**
(`Equipment`/`WindowsPC` : ports, table ARP, table de routage, socket table,
cache DNS, service/process managers).

**Date :** 2026-07-09 · **Branche :** `mandeng`

---

## 0. Mise à jour (vérification sur le code live) — 2026-07-10

> Ce rapport a d'abord été rédigé en analysant le **moteur PowerShell legacy**
> `PowerShellExecutor.ts` (`src/network/devices/windows/`). Après vérification
> par exécution (dump `coherence-network.debug.test.ts`), il existe **deux
> moteurs PowerShell** :
>
> 1. **Moteur live (primaire)** — `PSInterpreter` (`src/powershell/`) via
>    `createWindowsPSProviders(device)`. Les cmdlets réseau
>    (`src/powershell/cmdlets/core/NetworkCmdlets.ts`) passent par une
>    abstraction **`INetworkProvider`** dont l'implémentation
>    (`WindowsPSProviders.ts`) est **adossée au device réel** :
>    `resolveDns → pc.resolveDnsSync`, `clearDnsClientCache → pc.dnsCache.flush()`,
>    `getNeighbors`/`getTcpConnections` → vraies tables. C'est le chemin qu'un
>    utilisateur atteint réellement.
> 2. **Moteur legacy (fallback)** — `PowerShellExecutor.ts`, utilisé seulement
>    en repli pour les cmdlets non couverts par le provider.
>
> **Conséquence :** la plupart des divergences 🔴/🟠 décrites plus bas (états
> parallèles `extraIPs`/`extraRoutes`, `Get-NetTCPConnection` fabriqué,
> `Get-NetNeighbor` absent, `Clear-DnsClientCache` no-op) concernent le **chemin
> legacy** et **sont déjà résolues dans le chemin live**. Le dump de cohérence le
> confirme :
>
> - `New-NetIPAddress` (PS) → `ipconfig`/`netsh` (CMD) voient l'IP ✅
> - `netsh add address` (CMD) → `Get-NetIPAddress` (PS) voit l'IP ✅
> - `route print` (CMD) ≡ `Get-NetRoute` (PS) ✅
> - `netstat -a` (CMD) ≡ `Get-NetTCPConnection` (PS) — mêmes ports 22/3389/445/139 ✅
> - `Get-NetNeighbor` existe et lit la vraie table ARP ✅
> - `Clear-DnsClientCache` appelle bien `dnsCache.flush()` ✅
>
> ### Divergence réelle restante — corrigée
>
> **`Resolve-DnsName` fabriquait une réponse.** Le cmdlet
> (`NetworkCmdlets.ts › ResolveDnsNameCmdlet`) contenait une table codée en dur
> `['example.com','93.184.216.34']` qui **court-circuitait** `net.resolveDns()`.
> Résultat observé : `nslookup example.com` (CMD) → `REFUSED`, mais
> `Resolve-DnsName example.com` (PS) → `93.184.216.34` (inventé).
>
> **Correctif appliqué :** suppression du short-circuit `builtinIPs`.
> `Resolve-DnsName` résout désormais **exclusivement** via `net.resolveDns()`
> (= `pc.resolveDnsSync` : hosts file → cache → serveurs DNS), la même chaîne que
> `nslookup`. Vérifié après correctif : `Resolve-DnsName example.com` renvoie
> maintenant « does not exist » comme `nslookup`, et `localhost` résout toujours
> `127.0.0.1` (via le hosts file). Test `resolve-dnsname-format.test.ts` mis à
> jour pour semer `example.com` dans le hosts file (source réelle) au lieu de
> dépendre du hardcode ; suite PowerShell complète : **1908 tests OK**.
>
> Les sections 3→8 ci-dessous restent valables comme **audit du chemin legacy**
> et comme grille de non-régression (cf. §8, le dump `coherence-network` est le
> témoin vivant).

---

## 1. Résumé exécutif

Le shell **CMD est l'implémentation de référence** : chaque commande réseau lit
et écrit l'état réel du device via `buildNetContext()`
(`WindowsPC.ts:2167`) — `arpTable`, `ports`, `getRoutingTable()`,
`socketTable`, `dnsCache`, `serviceManager`, `processManager`.

Le shell **PowerShell est cohérent pour la grande majorité des commandes**,
grâce à deux mécanismes :

1. **Délégation explicite** d'un jeu de commandes natives vers CMD
   (`PowerShellExecutor.ts:2646`).
2. **`executeFallback()`** (`PowerShellExecutor.ts:2850` → `6230`) qui renvoie
   *toute commande inconnue* vers `executeCmdCommand()`. C'est ce qui fait que
   `getmac`, `nslookup`, `netstat`, `nbtstat`, `wmic`, `pathping`, etc.
   fonctionnent identiquement dans les deux shells.

**Le problème** : un sous-ensemble précis de cmdlets réseau PS possède des
**handlers explicites** qui court-circuitent CMD **avant** d'atteindre le
fallback, et qui maintiennent un **état parallèle** (maps propres à PS) ou
carrément **fabriqué** (valeurs codées en dur). Pour ces cmdlets, PS et CMD
divergent : une modification faite dans un shell est invisible dans l'autre, ou
bien PS affiche des données qui ne correspondent à aucun état réel.

### Verdict par catégorie

| Sévérité | Cmdlets concernés | Nature |
|---|---|---|
| 🔴 Critique | `Resolve-DnsName`, `Get-NetTCPConnection` | État **entièrement fabriqué** (ignore la machine) |
| 🔴 Critique | `New/Set/Remove-NetIPAddress`, `New/Set/Remove-NetRoute` | **État parallèle** en écriture ; jamais reporté vers le device |
| 🟠 Majeure | `Disable/Enable/Rename/Restart-NetAdapter` | Override PS-local, ≠ état lien réel du port |
| 🟠 Majeure | `Get-NetIPAddress`, `Get-NetRoute` | Lecture partiellement fabriquée / ignore la vraie table de routage |
| 🟡 Moyenne | `Clear-DnsClientCache` | No-op — ne vide pas le vrai cache DNS |
| 🟡 Moyenne | `netsh winhttp`, `netsh wlan` (via PS) | État executor-local + stub CMD sans état |
| 🟡 Moyenne | `Get-NetNeighbor` | Cmdlet **absent** (pas de producteur) → oblige `arp -a` |
| 🟢 OK (modèle) | `*-NetFirewallRule`, `*-Service`, `Get-Process`, `*-DnsClientServerAddress`, `Test-NetConnection` | État **partagé** au niveau device |

---

## 2. Le principe : « l'état de la machine comme source unique »

Côté CMD, `buildNetContext()` **injecte les structures vivantes du device** dans
chaque handler `Win*` :

```ts
// WindowsPC.ts:2167
private buildNetContext(): WinCommandContext {
  return {
    ports: this.ports,
    arpTable: this.arpTable,                              // ← table ARP réelle
    getRoutingTable: () => this.getRoutingTable(),        // ← routage réel
    configureInterface: (...) => this.configureInterface(...),
    executeTraceroute: (...) => this.executeTraceroute(...),
    // ...
  };
}
// netstat lit la vraie socket table :
case 'netstat': return cmdNetstat(fileCtx, args, this.socketTable);  // :1744
```

**Le bon patron (à généraliser) — le pare-feu.** Les règles dynamiques vivent
sur le device et les *deux* shells écrivent/lisent la même map :

```ts
// PowerShellExecutor.ts:182  — getter qui pointe vers le device
get dynamicFirewallRules() {
  return (this.device as ...).dynamicFirewallRules;
}
// New-NetFirewallRule (PS) écrit dans cette map partagée
// netsh advfirewall (CMD, WinNetsh.ts:2779) écrit dans la MÊME map
```

Résultat : une règle ajoutée par `netsh advfirewall firewall add rule …` (CMD)
apparaît dans `Get-NetFirewallRule` (PS) et inversement. **C'est exactement le
comportement attendu, et le modèle que toutes les autres cmdlets réseau
devraient suivre.**

Les managers partagés qui fonctionnent déjà correctement :

| État machine | Écrit/lu par CMD | Écrit/lu par PS | Statut |
|---|---|---|---|
| `WindowsServiceManager` | `sc`, `net start/stop` | `Get/Start/Stop/Set-Service` | ✅ partagé |
| `WindowsProcessManager` | `tasklist`, `taskkill` | `Get-Process`, `Stop-Process` | ✅ partagé |
| `dynamicFirewallRules` | `netsh advfirewall` | `*-NetFirewallRule` | ✅ partagé |
| DNS servers (`get/setDnsServers`) | `netsh`, `ipconfig` | `Get/Set-DnsClientServerAddress` | ✅ partagé |
| Sondes réseau réelles | `ping`, `tracert` | `Test-NetConnection`, `Test-Connection` | ✅ partagé |

---

## 3. Points de divergence (catalogue détaillé)

### 🔴 D1 — `Resolve-DnsName` : résolution DNS entièrement fabriquée

**Fichier :** `PowerShellExecutor.ts:6059` (`renderResolveDnsName`)

Le cmdlet **n'appelle jamais** le résolveur du device (`resolveHostnameSync` /
`dnsCache`). Il renvoie des valeurs codées en dur :

```ts
// A record : n'importe quel nom → 192.168.1.1 (localhost → 127.0.0.1)
const ip = target.toLowerCase() === 'localhost' ? '127.0.0.1' : '192.168.1.1';
// PTR : 1.2.3.4 → host-1-2-3-4
const hostName = `host-${target.replace(/\./g, '-')}`;
```

**Divergence :** `nslookup srv.lab` (CMD → `cmdNslookup`, résolution réelle via
serveurs DNS configurés + `dnsCache`) renvoie l'IP réelle ; `Resolve-DnsName
srv.lab` (PS) renvoie toujours `192.168.1.1`.

**Repro :**
```
CMD>  nslookup server1        → 10.0.0.5   (réel)
PS >  Resolve-DnsName server1 → 192.168.1.1 (fabriqué)
```

**Correctif :** router `Resolve-DnsName` vers `this.device.resolveHostnameSync()`
et le `dnsCache`, comme le fait déjà `Test-NetConnection`.

---

### 🔴 D2 — `Get-NetTCPConnection` : connexions TCP fabriquées

**Fichier :** `PowerShellExecutor.ts:5307` (`formatGetNetTCPConnection`)

Ignore la `socketTable` du device. Ports d'écoute codés en dur (135, 445,
49152) et une connexion « établie » inventée vers `8.8.8.8:53` avec un port
source **aléatoire** :

```ts
lines.push(`… ${String(49153 + Math.floor(Math.random()*100))} … 8.8.8.8 … 53 … Established`);
```

**Divergence :** `netstat -ano` (CMD → `cmdNetstat(..., this.socketTable)`,
`WindowsPC.ts:1744`) reflète les vraies sockets/écouteurs ; `Get-NetTCPConnection`
(PS) montre des connexions qui n'existent pas et rate les vraies. Deux appels
successifs donnent même des ports différents (non déterministe).

**Correctif :** lire `this.device.socketTable` (comme `netstat`) et projeter les
services en écoute via `WindowsServicePortProjection` / `PortProxySocketProjection`.

---

### 🔴 D3 — `New/Set/Remove-NetIPAddress` : IP en état parallèle, jamais appliquées à l'interface

**Fichiers :** `PowerShellExecutor.ts:4430` (`handleNewNetIPAddress`),
`:4492` (`handleSetNetIPAddress`), `:4467` (`handleRemoveNetIPAddress`)

Ces cmdlets écrivent dans la map `extraIPs` (getter device-level `:166`) mais
**n'appellent jamais `configureInterface()`**. Le chemin CMD ne lit pas
`extraIPs` (vérifié : `grep -c extraIPs WinIpconfig.ts WinNetsh.ts` = 0).

```ts
// New-NetIPAddress :4458 — écrit extraIPs, ne touche pas le port réel
this.extraIPs.set(ip.toLowerCase(), { ifAlias, prefixLength, … });
```

**Divergences :**
- `New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 10.0.0.9 -PrefixLength 24`
  (PS) → visible dans `Get-NetIPAddress`, **invisible dans `ipconfig`** (CMD).
- Symétrie inverse : `netsh interface ip set address` / `ipconfig` (CMD)
  configure le vrai port → *bien* relu par `Get-NetIPConfiguration` (qui lit
  `getPortsMap()`), donc l'asymétrie est unidirectionnelle mais réelle.

**Bonus fabriqué :** `buildAllIPEntries()` (`:4345`) **synthétise une fausse IP
`192.168.1.100+offset/24`** pour chaque adaptateur non configuré :

```ts
} else if (!this.extraIPs.has(displayName.toLowerCase())) {
  const simIp = `192.168.1.${100 + ethIdx}`;   // ← IP inventée
```

Donc `Get-NetIPAddress` (PS) affiche une IP sur une interface que `ipconfig`
(CMD) déclare « Media disconnected / non configurée ».

**Correctif :** faire écrire `New/Set/Remove-NetIPAddress` via
`configureInterface()`/`clearIP()` sur le port réel, et supprimer la
synthèse d'IP fictive dans `buildAllIPEntries()`.

---

### 🔴 D4 — `New/Set/Remove-NetRoute` + `Get-NetRoute` : table de routage parallèle

**Fichiers :** `PowerShellExecutor.ts:4603` (`handleNewNetRoute`),
`:4572` (`handleGetNetRoute`), `:4532` (`buildDefaultRoutes`)

`Get-NetRoute` **ne lit pas** `getRoutingTable()` du device. Il reconstruit une
table à partir des ports connectés + une route par défaut synthétique +
`extraRoutes` (map PS-locale). `New-NetRoute` écrit dans `extraRoutes`, que le
chemin CMD (`route`, `netsh`) ne lit pas.

**Divergences :**
- `route add 172.16.0.0 mask 255.255.0.0 10.0.0.1` (CMD → `addStaticRoute`,
  vraie table) → **absent de `Get-NetRoute`** (PS).
- `New-NetRoute -DestinationPrefix 172.16.0.0/16 -NextHop 10.0.0.1` (PS →
  `extraRoutes`) → **absent de `route print`** (CMD).

**Correctif :** `Get-NetRoute` doit projeter `this.device.getRoutingTable()` ;
`New/Set/Remove-NetRoute` doivent appeler `addStaticRoute()`/`removeRoute()`.

---

### 🟠 D5 — `Disable/Enable/Rename/Restart-NetAdapter` : override PS-local ≠ état lien réel

**Fichiers :** `PowerShellExecutor.ts:4940` (`handleDisableEnableNetAdapter`),
`:4955` (`handleRenameNetAdapter`), `:2500` (`Restart-NetAdapter`)

Ces cmdlets écrivent dans `adapterOverrides` (getter device-level `:180`), une
map qui ne modifie **pas** l'état lien réel du port (`port.setIsUp()`).
`Get-NetAdapter` lit `port.getIsUp()` comme base **puis** surcharge avec
`adapterOverrides.status` (`:4890-4892`).

**Divergences :**
- `Disable-NetAdapter Ethernet0` (PS) → `adapterOverrides` seulement. Le port
  reste **up** : `ipconfig` (CMD) montre toujours l'adaptateur connecté, le
  trafic continue de passer, `netsh interface show interface` le voit activé.
- Inversement `netsh interface set interface "Ethernet0" admin=disabled` (CMD)
  agit sur le port réel → `Get-NetAdapter` le reflète via `port.getIsUp()`,
  mais un `Enable-NetAdapter` (PS) ultérieur ne poserait qu'un override sans
  remonter le lien réel. Comportement asymétrique et incohérent.
- `Rename-NetAdapter` (PS) ne change qu'un alias d'affichage PS ; `ipconfig`
  (CMD) garde l'ancien nom.

**Correctif :** router disable/enable vers l'état lien réel du port (down/up
administratif) au lieu d'un simple override d'affichage.

---

### 🟡 D6 — `Clear-DnsClientCache` : no-op, ne vide pas le vrai cache DNS

**Fichier :** `PowerShellExecutor.ts:2552`

```ts
if (cmdLower === 'clear-dnsclientcache') {
  return '';   // ← ne touche pas this.device.dnsCache
}
```

Le device possède un vrai cache DNS (`WindowsPC.ts:208 readonly dnsCache`),
vidé par `ipconfig /flushdns` (CMD) et affiché par `ipconfig /displaydns`.

**Divergence :** après `Resolve-DnsName`/`ping` qui peuplent le cache,
`Clear-DnsClientCache` (PS) ne le vide pas, alors que `ipconfig /flushdns`
(CMD) le vide. `ipconfig /displaydns` continue de montrer les entrées.

**Correctif :** `Clear-DnsClientCache` → `this.device.dnsCache.clear()`.
(Corollaire : implémenter `Get-DnsClientCache` en lisant `dnsCache` — actuellement
absent, tombe en « not recognized ».)

---

### 🟡 D7 — `netsh winhttp` / `netsh wlan` via PS : état executor-local + stub CMD

**Fichiers :** interception PS `PowerShellExecutor.ts:2636` (`winhttp`),
`:2641` (`wlan`) ; stub CMD `WinNetsh.ts:284-293`.

PS **intercepte** `netsh winhttp`/`netsh wlan` *avant* de déléguer, et stocke
dans des champs **executor-locaux** (`winhttpProxy:184`, `wlanConnectedSSID:186`,
`wlanProfiles:188` — `private`, pas de getter device). Côté CMD, `netsh winhttp`
est un **stub sans état** : `show` renvoie toujours « Direct access (no
proxy) », `set` renvoie « Ok. » sans rien mémoriser.

**Divergences :**
- `netsh winhttp set proxy …` dans PS → `netsh winhttp show proxy` (PS) le
  montre ; le même `show` en CMD affiche toujours « Direct access ».
- État PS perdu à la fermeture du shell (executor-local, non persistant sur le
  device) — contrairement à tout le reste qui vit sur le device.

**Correctif :** relocaliser l'état winhttp/wlan sur le device (comme
`dynamicFirewallRules`) et faire lire/écrire les deux shells dessus.

---

### 🟡 D8 — `Get-NetNeighbor` : cmdlet absent (équivalent PS de `arp`)

**Constat :** aucun handler `Get-NetNeighbor` / `New-NetNeighbor` /
`Remove-NetNeighbor`. Seul subsiste un **formateur de colonnes orphelin**
(`PSPipeline.ts:795`) sans producteur d'objets.

**Divergence :** l'utilisateur PS qui veut voir le voisinage L2 doit retomber
sur `arp -a` (qui, lui, fonctionne car délégué à CMD et lit la vraie
`arpTable`). L'API « moderne » attendue en PowerShell est manquante, et
`Remove-NetNeighbor` (équivalent de `arp -d`) n'existe pas.

> C'est vraisemblablement l'incohérence « arp » observée : `arp -a` marche
> (délégué → `arpTable` réelle) mais son pendant PowerShell natif n'existe pas,
> et la table ARP peut être peuplée différemment selon qu'on `ping` (CMD,
> `executePingSequence` → frames réelles → `arpTable`) ou qu'on
> `Test-Connection`/`Test-NetConnection` (PS, sonde synchrone).

**Correctif :** implémenter `Get-NetNeighbor` (et `Remove-NetNeighbor`) en
lisant/écrivant `this.device.arpTable` ; brancher le formateur `PSPipeline:795`.

---

## 4. Cartographie « tracert » (exemple cité)

- `tracert` **fonctionne à l'identique** dans les deux shells : PS le délègue à
  CMD (`PowerShellExecutor.ts:2646` → `executeTraceroute` réel).
- **Mais** `Test-NetConnection -TraceRoute` (l'équivalent PowerShell moderne)
  **ignore le paramètre** : `handleTestNetConnection` (`:5065`) ne fait qu'un
  ping + résolution + egress ; il ne rend jamais la liste de sauts. Un
  utilisateur PS qui fait `Test-NetConnection host -TraceRoute` n'obtient pas la
  route, alors que `tracert host` (même shell) la donne. → divergence
  **intra-PS** et vs CMD.

**Correctif :** implémenter `-TraceRoute` dans `handleTestNetConnection` via
`this.device.executeTraceroute()`.

---

## 5. Matrice de couverture (commandes réseau)

| Opération | CMD (référence) | PowerShell natif | Source de vérité commune ? |
|---|---|---|---|
| Config IP (affichage) | `ipconfig` ✅ ports | `Get-NetIPConfiguration` ✅ ports | ✅ (lecture) |
| Config IP (liste) | — | `Get-NetIPAddress` ⚠️ ports **+ IP fictives** | 🔴 fabrication (D3) |
| Config IP (écriture) | `netsh`/`ipconfig` ✅ port réel | `New/Set-NetIPAddress` 🔴 `extraIPs` | 🔴 parallèle (D3) |
| Routage (affichage) | `route print` ✅ `getRoutingTable` | `Get-NetRoute` 🔴 reconstruit | 🔴 (D4) |
| Routage (écriture) | `route add` ✅ table réelle | `New-NetRoute` 🔴 `extraRoutes` | 🔴 parallèle (D4) |
| ARP (affichage) | `arp -a` ✅ `arpTable` | `Get-NetNeighbor` ❌ absent | 🟡 gap (D8) |
| Adaptateurs (état) | `netsh interface` ✅ port | `*-NetAdapter` 🟠 override | 🟠 (D5) |
| TCP/sockets | `netstat` ✅ `socketTable` | `Get-NetTCPConnection` 🔴 inventé | 🔴 (D2) |
| Résolution DNS | `nslookup` ✅ résolveur | `Resolve-DnsName` 🔴 codé en dur | 🔴 (D1) |
| Cache DNS (flush) | `ipconfig /flushdns` ✅ | `Clear-DnsClientCache` 🟡 no-op | 🟡 (D6) |
| Serveurs DNS | `netsh`/`ipconfig` ✅ | `Get/Set-DnsClientServerAddress` ✅ | ✅ partagé |
| Ping / test | `ping` ✅ | `Test-Connection`/`Test-NetConnection` ✅ | ✅ partagé |
| Traceroute | `tracert` ✅ | `Test-NetConnection -TraceRoute` 🟠 ignoré | 🟠 (§4) |
| Pare-feu | `netsh advfirewall` ✅ | `*-NetFirewallRule` ✅ | ✅ partagé (modèle) |
| Proxy WinHTTP | `netsh winhttp` 🟡 stub | `netsh winhttp` (PS) 🟡 local | 🟡 (D7) |
| Services | `sc`/`net start` ✅ | `*-Service` ✅ | ✅ partagé |
| Processus | `tasklist`/`taskkill` ✅ | `Get-Process`/`Stop-Process` ✅ | ✅ partagé |

Légende : ✅ correct · 🟡 mineur · 🟠 majeur · 🔴 critique · ❌ absent

---

## 6. Cause racine commune

Toutes les divergences 🔴/🟠 partagent **le même défaut de conception** : un
handler PS explicite a été écrit pour « rendre joliment » la sortie d'un cmdlet
`Get-Net*` sans le brancher sur l'état du device, puis les cmdlets d'écriture
correspondants ont dû inventer un magasin parallèle (`extraIPs`, `extraRoutes`,
`adapterOverrides`) pour rester cohérents *entre eux*. Ce magasin parallèle est
la source de vérité **de PowerShell seul**, jamais synchronisée avec CMD.

Le pare-feu (`dynamicFirewallRules`) prouve que le patron correct existe déjà
dans le code : **map unique sur le device, lue et écrite par les deux shells**.

---

## 7. Plan de remédiation recommandé

Par priorité (impact × facilité) :

1. **D1 `Resolve-DnsName`** → router vers `device.resolveHostnameSync` + `dnsCache`.
   *(isolé, gros gain de réalisme)*
2. **D2 `Get-NetTCPConnection`** → lire `device.socketTable` (réutiliser
   `cmdNetstat`).
3. **D6 `Clear-DnsClientCache`** → `device.dnsCache.clear()` ; ajouter
   `Get-DnsClientCache`. *(quelques lignes)*
4. **D4 routage** → `Get-NetRoute` lit `getRoutingTable()` ; `New/Set/Remove-NetRoute`
   → `addStaticRoute`/`removeRoute`. Retirer `extraRoutes`.
5. **D3 IP** → `New/Set/Remove-NetIPAddress` via `configureInterface`/`clearIP` ;
   supprimer les IP synthétiques de `buildAllIPEntries`. Retirer `extraIPs`.
6. **D5 adaptateurs** → disable/enable sur l'état lien réel du port.
7. **D8 `Get-NetNeighbor`** + **§4 `-TraceRoute`** → lire `arpTable` /
   `executeTraceroute`.
8. **D7 winhttp/wlan** → relocaliser l'état sur le device (patron pare-feu) et
   implémenter le vrai stockage côté `WinNetsh`.

**Règle de conception à graver** : *un cmdlet PS ne doit jamais posséder son
propre état réseau. Il lit et écrit exclusivement l'état du device
(`this.device.*`), exactement comme le handler CMD équivalent.* Tout magasin
`extra*`/`*Overrides` propre à PowerShell est un anti-patron à éliminer.

---

## 8. Tests suggérés (non-régression cross-shell)

Pour chaque opération, un test « écris dans un shell, lis dans l'autre » :

```
New-NetIPAddress (PS)   → ipconfig (CMD) doit montrer l'IP
route add (CMD)         → Get-NetRoute (PS) doit montrer la route
Disable-NetAdapter (PS) → ipconfig (CMD) : "Media disconnected"
Resolve-DnsName (PS)    == nslookup (CMD) : même IP
Get-NetTCPConnection    ⊆ netstat -ano : mêmes sockets
Clear-DnsClientCache(PS)→ ipconfig /displaydns (CMD) : cache vide
netsh advfirewall (CMD) → Get-NetFirewallRule (PS)  ← déjà OK, garder comme témoin
```

Ces assertions traduisent directement l'invariant « source unique de vérité ».
