# Rapport d'audit — Cohérence cmd/PowerShell, flows pilotés par l'UX, aide « ? » des équipements

**Branche auditée :** `mandeng` (commit `d61ff4b0`) — **Date :** 2026-07-18

> **Statut des remédiations (2026-07-19)** :
> - **P0 livré** — cmdlets legacy rebranchées sur l'état réel, tracert/ping honnêtes,
>   résolution DNS unifiée, `erase startup-config` réel, aide `?` complétée
>   (commit *Fix cmd/PowerShell state coherence…*).
> - **P1 livré** — inversion de contrôle des flows : protocole
>   `CommandInteractionPlan`, planners Cisco/Huawei/Linux, sessions génériques,
>   FlowBuilders supprimés (commit *Invert control of interactive flows…*) ;
>   puis reboot VRP réel et **chemin SSH branché sur les mêmes plans**
>   (`InteractionPlanRunner` + adaptateurs cisco-ios/huawei-vrp).
> - Restent ouverts : les P2 cosmétiques non traités (§7) et les 13 échecs de
>   tests préexistants hors périmètre (scénarios Oracle RAC, capture SSH).

Périmètre demandé :
1. Cohérence entre `cmd` et PowerShell sur les machines Windows (état interne affiché différemment).
2. Commandes réseau (`ping`, `tracert`, …) qui fonctionnent différemment selon le shell.
3. Flows interactifs définis par la couche UX au lieu de la commande elle-même.
4. Commandes implémentées sur les équipements réseau mais invisibles dans l'aide `?`.

Chaque constat cite `fichier:ligne` sur la branche `mandeng`. Les constats notés **[Vérifié à l'exécution]** ont été reproduits en faisant tourner le simulateur dans vitest.

---

## Synthèse

La cause racine des divergences cmd/PowerShell n'est pas une accumulation de petits bugs : **PowerShell maintient un état réseau parallèle et partiellement fictif** (`extraIPs`, `extraRoutes`, `adapterOverrides`, sorties codées en dur) au lieu de lire/écrire le même état device que cmd. Côté UX, la couche terminal **intercepte des commandes par comparaison de chaînes et re-implémente (ou simule) leur comportement**, si bien que la même commande fait des choses différentes selon qu'elle est tapée dans le terminal UI ou via SSH/vty. Enfin, l'aide `?` des équipements est **déduite du code source des handlers par regex** (`Function.toString()`), ce qui rend invisible toute sous-commande implémentée dans une fonction séparée.

Points sains à préserver (contre-exemples du bon pattern) : le pare-feu (`netsh advfirewall` et les cmdlets `*-NetFirewallRule` partagent `dynamicFirewallRules`, honoré par le data-path `firewallFilter`), les utilisateurs (`net user` / `Get-LocalUser` → `WindowsUserManager`), les services (`sc`, `net start` / `Get-Service` → `WindowsServiceManager`), les processus (`tasklist` / `Get-Process` → `WindowsProcessManager`) et `netstat` qui lit la vraie `SocketTable`.

---

## 1. État parallèle PowerShell vs cmd — CRITIQUE

### 1.1 `New-NetIPAddress` / `Set-NetIPAddress` n'attribuent pas réellement d'IP
- Les cmdlets écrivent dans `extraIPs`, une map **privée au monde PowerShell** (`src/network/devices/WindowsPC.ts:307`, écriture `src/network/devices/windows/PSNetCmdlets.ts:189`, `:236`).
- Aucun appel à `Port.setIPAddress` : la machine **ne possède pas** l'IP (pas de réponse ARP, pas de socket, pas de routage).
- `ipconfig` et tout le monde cmd ne lisent jamais `extraIPs` (aucune occurrence dans `WinCommandExecutor.ts` ni `WinIpconfig.ts`) → l'IP « créée » en PS est invisible en cmd.
- À l'inverse, `netsh interface ip set address` (cmd, `src/network/devices/windows/WinNetsh.ts:6`) configure le vrai port → visible partout **sauf** dans `Get-NetIPAddress` si celui-ci filtre sur ses entrées synthétiques.

### 1.2 `New-NetRoute` / `Get-NetRoute` ignorent la vraie table de routage
- `route add` (cmd) écrit dans la vraie table via `ctx.addStaticRoute` / `ctx.setDefaultGateway` (`src/network/devices/windows/WinRoute.ts:96`, `:132`) ; `route print` la lit (`WinRoute.ts:199-234`).
- `New-NetRoute` écrit dans `extraRoutes` (PS-only, `PSNetCmdlets.ts:343`) ; `Get-NetRoute` **reconstruit une table synthétique** (`buildDefaultRoutes`, `PSNetCmdlets.ts:263-293`) à partir des ports + gateway, sans jamais lire la `RoutingTable` du device.
- Conséquences : une route ajoutée en cmd n'apparaît pas dans `Get-NetRoute` ; une route ajoutée en PS n'apparaît pas dans `route print` **et n'a aucun effet sur le forwarding réel**.

### 1.3 `Get-NetIPAddress` invente des adresses
- Pour tout adaptateur sans IP, la cmdlet fabrique une IP `192.168.1.100+n/24` marquée `Preferred` (`PSNetCmdlets.ts:76-80`). PowerShell affiche donc une adresse que la machine n'a pas, pendant qu'`ipconfig` n'affiche rien — c'est littéralement « les deux affichent des informations différentes sur l'état interne ».

### 1.4 `Get-NetAdapter` fabrique un adaptateur Wi-Fi
- Un adaptateur « Wi-Fi / Intel(R) Wireless-AC 9560 » est ajouté inconditionnellement (`PSNetCmdlets.ts:428-432`) ; il n'existe ni dans les ports du device ni dans `ipconfig`.

### 1.5 `Rename-NetAdapter` ne renomme que la vue PS
- Le renommage n'écrit que dans `adapterOverrides` (`PSNetCmdlets.ts:494-507`), lu uniquement par `Get-NetAdapter`. `ipconfig`, `netsh`, `getmac` continuent d'afficher l'ancien nom. Bug secondaire : l'entrée est dupliquée sous l'ancienne ET la nouvelle clé sans nettoyage.

### 1.6 `Get-NetTCPConnection` vs `netstat` : deux réalités
- `netstat` (cmd) lit la vraie `SocketTable` (`src/network/devices/windows/WinFileCommands.ts:261-293`, câblé dans `WindowsPC.ts:1744`).
- `Get-NetTCPConnection` **invente** : ports d'écoute codés en dur (135/445/49152), port éphémère `Math.random()`, connexion « Established » fictive vers `8.8.8.8:53` (`PSNetCmdlets.ts:537-580`). Un serveur qui écoute réellement (visible dans netstat) est absent de la vue PS, et inversement la vue PS montre des connexions qui n'existent pas.

### 1.7 `Resolve-DnsName` n'interroge pas le DNS
- Sortie entièrement fabriquée : PTR `host-<ip>`, et pour tout hostname non-localhost la réponse est `192.168.1.1` en dur (`PSNetCmdlets.ts:591-617`). `nslookup` et `ping` font, eux, de la vraie résolution via le réseau simulé.

### 1.8 Tâches planifiées : la promesse de partage est rompue
- `schtasks` (cmd) lit/écrit la map partagée `scheduledTasks`, avec un commentaire affirmant que « PowerShell's Get-ScheduledTask … see the same data » (`src/network/devices/windows/WinSystemCommands.ts:227-231`).
- Or `Get-ScheduledTask` (PS) retourne une liste codée en dur (GoogleUpdate, OneDrive, SimTestTask…) et ne lit jamais `scheduledTasks` (`src/network/devices/windows/PowerShellExecutor.ts:2555-2569` ; aucune occurrence de `scheduledTasks` dans le fichier). `Register-ScheduledTask` ne crée rien (`:2572-2576`). Une tâche créée via `schtasks /create` est invisible en PS, et vice-versa.

### 1.9 Divers état non partagé
- `Clear-DnsClientCache` est un no-op (`PowerShellExecutor.ts:2537-2539`) alors qu'`ipconfig /flushdns` vide réellement le cache (`WinIpconfig.ts:110`).
- L'état `netsh winhttp` / `netsh wlan` est intercepté au niveau PS et stocké côté PS (`PowerShellExecutor.ts:2615-2622`) → le même `netsh` en cmd ne voit pas cet état.

---

## 2. `ping` / `tracert` : trois moteurs pour la même chose — MAJEUR

### 2.1 Trois chemins d'exécution divergents
| Commande | Moteur | Résolution de nom |
|---|---|---|
| `ping` (cmd) | `ctx.executePingSequence` — vrais paquets ICMP asynchrones (`WinPing.ts:336`) | `resolveHostname` : hosts → **vraie requête DNS UDP/53** (`WindowsPC.ts:1516`) |
| `Test-Connection` (PS) | exécute la chaîne `ping -n …` **puis screen-scrape la sortie texte** avec des regex (`PowerShellExecutor.ts:3453`, `:3468`, `:3493-3498`) | celle de ping |
| `Test-NetConnection` (PS) | `sendPingProbeSync` — moteur ICMP **synchrone** distinct (`EndHost.ts:2802`) | `resolveHostnameSync` : hosts uniquement, **aucune étape DNS** (`WindowsPC.ts:1496-1508`) |

Conséquences concrètes :
- Un hôte connu du DNS mais pas du fichier hosts répond à `ping` mais `Test-NetConnection` répond `PingSucceeded : False`.
- `Test-Connection` casse dès que le format texte de `WinPing` change (couplage par regex sur `Reply from …` / `time=…`) et synthétise des lignes localhost (`PowerShellExecutor.ts:3484-3490`).
- Le moteur synchrone ne peut réussir que si la propagation des trames est same-tick : il s'abonne, émet, et se désabonne immédiatement (`EndHost.ts:2826-2860`) — tout chemin réseau avec délai asynchrone rend `Test-NetConnection` faussement négatif là où `ping` réussit.

### 2.2 `tracert` : plafonds silencieux et hops fabriqués
- `maxHops` plafonné à **8** (`WinTracert.ts:230`) alors que l'entête affiché annonce « over a maximum of 30 hops » (`:262`) — au-delà de 8 sauts la trace s'arrête sans l'indiquer.
- Timeout par sonde écrasé à 200 ms max quel que soit `-w` (`WinTracert.ts:229`).
- Si le traceroute réel ne renvoie **aucun** hop, la commande **fabrique** un chemin plausible : gateway en hop 1 + timeouts (`WinTracert.ts:235-252`). L'utilisateur voit une topologie qui n'existe pas.
- `tracert -d` change complètement le format : plus d'entête, plus de « Trace complete. » (`WinTracert.ts:256-260`) — sur un vrai Windows, `-d` désactive uniquement la résolution de noms.
- Windows n'utilise pas le mode streaming hop-par-hop (`tracerouteStreamInSession`, `EndHost.ts:2913`) pourtant disponible et utilisé côté Linux → UX figée en bloc côté Windows, progressive côté Linux.

### 2.3 `ping` : simulations non signalées
- `ping -t` (continu) est silencieusement converti en ≤ 10 paquets (`WinPing.ts:92`).
- `-r` (record route) et `-s` (timestamps) fabriquent leur sortie en répétant l'IP cible / `Date.now()` (`WinPing.ts:357-371`).
- Le test « interface down » ne regarde que `eth0` en dur (`WinPing.ts:311`) — faux verdict sur une machine multi-interfaces.
- La validation « `-n` après `-t` » est incohérente et morte en partie (`WinPing.ts:282-289`).

---

## 3. Flows interactifs définis par l'UX au lieu de la commande — MAJEUR

### 3.1 Mécanique du problème
`CLITerminalSession.executeCommand` intercepte la ligne tapée **avant** le device : si `buildInteractiveFlow(command)` renvoie des étapes, la commande **n'est jamais transmise au shell de l'équipement** (`src/terminal/sessions/CLITerminalSession.ts:266-270`). Le flow (prompts, validations, messages, et parfois l'action elle-même) appartient donc à la couche terminal. Résultat : le comportement dépend du **point d'entrée** (terminal UI vs SSH/vty vs tests), exactement ce que tu veux éliminer.

### 3.2 Cisco — cas les plus graves
- **`erase startup-config` ne fait rien depuis le terminal UI.** Le flow affiche la confirmation puis `[OK] / Erase of nvram: complete` **sans exécuter quoi que ce soit** (`src/terminal/flows/CiscoFlowBuilder.ts:82-95` : aucune étape `execute`). La vraie implémentation existe dans le shell device (`CiscoShellBase.ts:1019` → `Router._eraseStartupConfig`, `Router.ts:2449`) et n'est atteinte que via vty/SSH. Depuis l'UI, l'utilisateur croit avoir effacé la NVRAM ; un `show startup-config` la montre toujours.
- **`copy running-config startup-config`** : matché sur exactement deux orthographes (`CiscoTerminalSession.ts:166`) ; `copy run star`, `copy running startup`, etc. ne déclenchent pas le dialogue. Le flow exécute `write memory` à la place de la commande tapée et **ignore le filename saisi** au prompt (`CiscoFlowBuilder.ts:40-60`).
- **`ping` animé** : re-implémenté dans la session terminal avec son propre parseur (`tryStartCiscoPing`, `CiscoTerminalSession.ts:195+`), pour `Router` uniquement (pas `Switch`) et pour l'UI uniquement — encore un comportement défini par l'UX.

### 3.3 Linux — l'UX re-implémente l'authentification et les mutations
`LinuxFlowBuilder` (`src/terminal/flows/LinuxFlowBuilder.ts`) détecte `sudo`/`su`/`passwd`/`adduser` par `command.trim().split(/\s+/)` puis :
- vérifie lui-même les mots de passe (`device.checkPassword`, `:83`, `:101`, `:119`) et les droits sudo (`device.canSudo()`, `:313`) ;
- applique lui-même la mutation en appelant `device.setUserPassword` directement (`:158-169`, `:291-298`, `:434-443`), **en contournant la commande `passwd`/`adduser` réelle** du sous-système Linux (règles, logs, /etc/shadow) ;
- porte en dur les messages (`Sorry, try again.`, `passwd: password updated successfully`, GECOS…).

Fragilité de la détection par chaîne : `sudo apt update && sudo reboot`, `VAR=x sudo …`, quoting, pipes (`echo pw | sudo -S …`) ne matchent pas le flow et partent dans un chemin d'exécution différent.

### 3.4 Huawei — même pattern
`save`, `reset saved-configuration`, `reboot` matchés à l'identique exact (`HuaweiTerminalSession.ts:156-166`) ; les abréviations VRP légitimes ne déclenchent pas les confirmations.

### 3.5 Recommandation (inversion de contrôle)
La commande doit être la seule source de vérité de son flow. L'infrastructure existe déjà en partie : `PromiseInputBroker` / `runFlowOnBroker` (`TerminalSession.ts:1196-1198`) et le `su` Linux sait déjà lire un mot de passe sur stdin (cf. `suExecuteStep` qui le lui pipe). Cible :
1. Le shell device exécute **toujours** la commande tapée telle quelle.
2. Quand la commande a besoin d'une entrée (mot de passe, confirmation, filename), **elle** émet une demande d'input (protocole type `InputBroker`) ; le terminal ne fait que rendre le prompt et renvoyer la réponse.
3. Supprimer `buildInteractiveFlow`/`*FlowBuilder` au profit de ce protocole ; le même code sert alors l'UI, SSH, et les tests.

---

## 4. Aide « ? » des équipements réseau : sous-commandes implémentées mais invisibles — MAJEUR

### 4.1 Mécanique du problème
Pour les commandes enregistrées en « greedy », les sous-commandes proposées par `?` sont **déduites du code source du handler** : `CommandTrie.autoContinuations` appelle `node.action.toString()` et le passe à `extractHandlerKeywords`, qui cherche par regex des littéraux comparés au paramètre (`src/network/devices/shells/CommandTrie.ts:666-686`, `src/network/devices/shells/HandlerKeywordExtractor.ts:59-110`).

Or la majorité des enregistrements sont des **wrappers** d'une ligne qui délèguent à une fonction d'un autre module — ex. `trie.registerGreedy('show cdp', …, (a) => showCdp(this.cs(), a))` (`CiscoShellBase.ts:848`) alors que le dispatch `neighbors`/`entry`/`interface`/`traffic` vit dans `showCdp` (`cisco/CiscoCommonShow.ts:246+`). Le `toString()` du wrapper ne contient aucun littéral → **aucune sous-commande listée**.

### 4.2 [Vérifié à l'exécution] sur un routeur Cisco (mode privilégié)
```
show cdp ?    →   WORD  Display CDP information          (neighbors/entry/interface/traffic implémentés mais absents)
show lldp ?   →   WORD  Display LLDP information         (neighbors/interface implémentés mais absents)
terminal ?    →   WORD  Set terminal parameters          (length/monitor/width implémentés mais absents)
show tcp ?    →   WORD  Display TCP connections          (brief implémenté mais absent)
show ntp ?    →   status                                 (associations manquant, pourtant décrit dans l'enregistrement)
```

### 4.3 [Vérifié à l'exécution] Descriptions vides / auto-extraction dégradée
Quand l'extraction par regex trouve des mots-clés, ils sortent **sans description** et l'aide affiche le mot-clé doublé, contrairement à IOS :
```
show ip ?   →  eigrp  eigrp | igmp igmp | dhcp dhcp | nat nat | static static | cache cache | flow flow …
conf: ip ?  →  http http | bootp bootp | as-path as-path …
if:   ?    →  cdp cdp | no no | lldp lldp | ip ip | arp arp …
crypto ?    →  isakmp isakmp | ipsec ipsec | ikev2 ikev2 | gdoi gdoi | pki pki …
```

### 4.4 Risque prod ≠ dev
L'extraction opère sur `Function.toString()` : en production esbuild minifie le corps des fonctions (seuls les **noms** sont préservés par `keepNames`) et renomme les variables locales, ce qui peut casser `argAliases`/`firstParamName` (`HandlerKeywordExtractor.ts:8-27`) → l'aide `?` peut différer entre `npm run dev` et le build de prod.

### 4.5 Étendue
Le pattern est identique sur toute la gamme : 174 `registerGreedy` dans `CiscoShellBase`, 234 dans `CiscoSwitchShell`, 167 dans `HuaweiVRPShell`, 104 dans `HuaweiSwitchShell`. Toutes ces commandes ont une aide `?` potentiellement mensongère.

### 4.6 Recommandation
- Faire des mots-clés d'aide une **donnée déclarative obligatoire de l'enregistrement** (sous-arbre réel du trie, ou `hintSuggestions` requis pour tout `registerGreedy` dont le handler délègue), et reléguer `extractHandlerKeywords` à un rôle de test/lint plutôt que de runtime.
- Ajouter un test systématique : pour chaque nœud greedy, exécuter le handler avec chaque mot-clé qu'il accepte (extraction sur la **fonction déléguée**, pas le wrapper) et vérifier que `?` le liste — le test échoue sur tout écart, avec description vide interdite.

---

## 5. Constats secondaires

- **`PowerShellExecutor.ts` : 4 313 lignes**, dispatch if/else géant mêlant parsing, état et formatage. C'est le terreau des stubs incohérents (§1.8, §1.9). Le commit reverté `b489189f` (« command-kernel: vendor-agnostic command interpreter architecture ») visait précisément ce problème — la direction était la bonne.
- `Get-Date` retourne `new Date().toString()` (format JS, pas le format culture Windows de PS) (`PowerShellExecutor.ts:2599-2601`).
- `New-Object` est un stub silencieux qui retourne `''` (`:2594-2596`).
- `Restart-NetAdapter` ne « redémarre » rien : il force juste `status='Up'` dans les overrides PS (`:2485-2494`), même pour un port réellement déconnecté.
- `formatWinPingStats` ajoute la ligne `Request timed out. Destination host unreachable.` dans le bloc statistiques (`WinPing.ts:266-268`), ce qui n'existe pas dans le vrai ping.

## 6. Ce qui est bien fait (à généraliser)

| Domaine | Pattern | Preuve |
|---|---|---|
| Pare-feu | Store unique `dynamicFirewallRules` partagé netsh/PS **et honoré par le data-path** | `WinNetsh.ts:2793-2801`, `WindowsPC.ts:3101-3116` |
| Utilisateurs | `WindowsUserManager` partagé `net user`/`Get-LocalUser` | `WinNetUser.ts:21-26`, `PowerShellExecutor.ts:101` |
| Services | `WindowsServiceManager` partagé `sc`,`net start`/`Get-Service` | `PowerShellExecutor.ts:103` |
| Processus | `WindowsProcessManager` partagé `tasklist`/`Get-Process` | `WinTasklist.ts:15-18`, `PSProcessCmdlets.ts:11-14` |
| Sockets (cmd) | `netstat` lit la vraie `SocketTable` | `WindowsPC.ts:1744` |

Le refactor cible est simple à énoncer : **tout ce que §1 et §2 décrivent doit passer au pattern de ce tableau** — un seul état device, deux façades d'affichage.

---

## 7. Priorités proposées

**P0 — mensonges d'état (l'utilisateur voit un état faux)**
1. `Get-NetIPAddress`/`New-NetIPAddress`/`Get-NetRoute`/`New-NetRoute` → brancher sur `Port`/`RoutingTable` réels ; supprimer `extraIPs`/`extraRoutes` et les IP fictives §1.3.
2. `Get-NetTCPConnection` → lire `SocketTable` (comme netstat).
3. `Resolve-DnsName` → utiliser le résolveur réel.
4. `Get-ScheduledTask`/`Register-ScheduledTask` → lire/écrire `scheduledTasks` (la map existe déjà).
5. `erase startup-config` (flow UI) → exécuter réellement la commande device.
6. Unifier la résolution de nom `Test-NetConnection` (ajouter l'étape DNS) et faire de `Test-Connection` un appel au moteur ICMP (objets structurés), pas un scraping de texte.

**P1 — architecture**
7. Inversion de contrôle des flows interactifs (§3.5) : commande → demande d'input ; suppression des `*FlowBuilder` et du matching de chaînes dans les sessions.
8. Aide `?` déclarative (§4.6) + test de complétude automatique.

**P2 — fidélité**
9. `tracert` : lever le plafond de 8 hops (ou l'afficher), supprimer les hops fabriqués, corriger `-d`, streaming hop-par-hop comme Linux.
10. `ping -t` réellement continu (le runtime async des sessions le permet), `-r`/`-s` honnêtes (ou non supportés explicitement).
11. Descriptions `?` vides, `Get-Date` format PS, stubs silencieux (`New-Object`, `Clear-DnsClientCache`, `Restart-NetAdapter`).
