# Audit — Génie logiciel et architecture

> Périmètre : tout `src/` du dépôt `ubuntu-sandbox` (simulateur réseau navigateur, React + TypeScript).
> Méthode : mesures shell reproductibles d'abord (wc, grep, jscpd, scripts Python de mesure de longueur de méthodes), puis lecture ciblée des zones les plus chargées. Chaque constat est référencé `fichier:ligne` ou chiffré. Date : 2026-07-22, ~1 547 commits.

---

## 1. Métriques du dépôt

### 1.1 Volumétrie globale

| Indicateur | Valeur |
|---|---|
| Fichiers `.ts`/`.tsx` | 3 322 |
| Lignes totales | ~667 000 |
| Lignes de production (hors `__tests__`) | ~366 000 |
| Lignes de tests | ~301 000 (1 367 fichiers) |
| Cas de test (`it(`/`test(`) | ~20 200 dans 1 344 fichiers `.test.ts` |
| Blocs `describe(` | ~5 000 |
| Specs e2e Playwright | 71 fichiers |
| Ratio test/prod (lignes) | 0,82 : 1 |

### 1.2 Répartition par sous-système

| Répertoire | Fichiers | Lignes | Commentaire |
|---|---:|---:|---|
| `src/__tests__/` | 1 367 | 301 036 | dont `debug/` : 94 fichiers, 22 528 lignes |
| `src/network/` | 1 014 | 242 703 | 66 % du code de production |
| `src/database/` | 585 | 56 560 | moteur Oracle |
| `src/terminal/` | 120 | 20 254 | |
| `src/powershell/` | 55 | 19 800 | |
| `src/components/` | 72 | 9 290 | UI raisonnablement mince |
| `src/bash/` | 13 | 7 239 | |
| `src/shell/` | 29 | 3 798 | couche d'abstraction |
| `src/crypto/` | 28 | 2 045 | crypto simulée maison |
| `src/events/` | 7 | 1 203 | primitives réactives |
| `src/store/` | 3 | 961 | Zustand — **pas** une God class |
| `src/adapters/` | 4 | 971 | |
| `src/react/` | 14 | 877 | hooks-ponts UI↔moteur |

### 1.3 Les 15 plus gros fichiers de production

| Fichier | Lignes |
|---|---:|
| `src/network/devices/linux/LinuxCommandExecutor.ts` | 6 504 |
| `src/network/ipsec/IPSecEngine.ts` | 4 756 |
| `src/network/devices/shells/CiscoSwitchShell.ts` | 4 436 |
| `src/network/devices/windows/PowerShellExecutor.ts` | 4 340 |
| `src/database/oracle/OracleExecutor.ts` | 4 282 |
| `src/terminal/sessions/LinuxTerminalSession.ts` | 4 008 |
| `src/network/devices/EndHost.ts` | 3 885 |
| `src/network/ospf/OSPFEngine.ts` | 3 853 |
| `src/network/devices/Router.ts` | 3 289 |
| `src/network/devices/LinuxMachine.ts` | 3 202 |
| `src/network/devices/windows/WinNetsh.ts` | 3 180 |
| `src/network/devices/shells/HuaweiSwitchShell.ts` | 3 159 |
| `src/network/devices/WindowsPC.ts` | 3 139 |
| `src/powershell/runtime/PSRuntime.ts` | 2 962 |
| `src/network/devices/Switch.ts` | 2 892 |

### 1.4 Méthodes les plus longues (mesure par équilibrage d'accolades après suppression chaînes/commentaires — approximative à ±5 %)

| Méthode | Longueur |
|---|---:|
| `LinuxCommandExecutor.dispatch()` — `src/network/devices/linux/LinuxCommandExecutor.ts:3294`→`4498` (mesure exacte) | **1 205 lignes, 207 labels `case`** |
| `src/network/devices/shells/CiscoShellBase.ts:1485` | ~848 lignes |
| `src/network/devices/windows/PowerShellExecutor.ts:247` (`execute` d'une ligne PowerShell) | ~729 lignes |
| `src/network/devices/inspection/config/LoggingConfig.ts:97` | ~615 lignes |
| `src/network/devices/shells/CiscoSwitchShell.ts:2229` | ~438 lignes |
| `src/network/devices/shells/HuaweiSwitchShell.ts:923` et `:1721` | ~416 / ~409 lignes |
| `src/network/devices/shells/HuaweiVRPShell.ts:1352` | ~400 lignes |
| `src/database/oracle/functions/ScalarFunctionEvaluator.ts:54` | ~455 lignes |
| `src/network/devices/linux/editors/VimEngine.ts:1626` | ~322 lignes |

### 1.5 Duplication (jscpd, clones exacts)

| Périmètre | Clones | Lignes dupliquées | Taux |
|---|---:|---:|---:|
| `src/terminal/sessions/` (12 fichiers) | 68 | 723 | **7,87 %** |
| `src/network/devices/shells/` (Cisco+Huawei) | 161 | 1 336 | 3,68 % |
| `src/bash/` + `src/powershell/` | 76 | 639 | 2,36 % |
| `src/network/devices/` (581 fichiers) | 244 | 2 761 | 1,66 % |

Lecture : la duplication **textuelle** est modérée — bon point. Le vrai coût des paires Cisco/Huawei et Linux/Windows est une duplication **structurelle** (deux hiérarchies parallèles qui réimplémentent la même logique avec un vocabulaire différent : `CiscoOspfCommands` 2 597 l. vs `HuaweiOspfCommands` ; `LinuxTerminalSession` 4 008 l. vs `WindowsTerminalSession` 1 776 l.), invisible à jscpd mais qui double le coût de chaque évolution transversale.

---

## 2. Anti-patterns identifiés

### 2.1 Dispatch sur `instance.constructor.name` — ✅ en réalité DÉJÀ corrigé (à finaliser)

**Constat factuel** : contrairement à ce qu'affirme `CLAUDE.md`, il ne reste **plus aucun** dispatch `x.constructor.name === '…'` dans le code (1 seule occurrence de la chaîne, dans un commentaire : `src/shell/shellKind.ts:5`). Les 5 anciens sites de dispatch ont été remplacés par le hook polymorphe `Equipment.getOSType()` centralisé dans `primaryShellKindFor()` (`src/shell/shellKind.ts:14-22`). `vite.config.ts:32` conserve `keepNames: true` uniquement à titre défensif, avec un commentaire l'expliquant.

- **Gravité** : faible (résiduelle).
- **Reste à faire** : (1) valider un build minifié sans `keepNames` et retirer le flag (gain de taille de bundle) ; (2) **mettre à jour `CLAUDE.md`**, qui documente encore l'anti-pattern comme actif — un contributeur (ou un agent) pourrait le réintroduire en croyant la convention toujours en vigueur.

### 2.2 Encapsulation percée : 891 casts `as unknown as` en production — 🔴 le problème n°1

**Inventaire** : 891 occurrences hors tests (+506 dans les tests), 397 `as any` prod, 109 annotations `: any`. Points chauds :

| Fichier | Casts `as unknown as` |
|---|---:|
| `src/network/devices/shells/CiscoShellBase.ts` | 106 |
| `src/network/devices/inspection/config/LoggingConfig.ts` | 96 |
| `src/powershell/runtime/PSRuntime.ts` | 55 |
| `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts` | 47 |
| `src/powershell/providers/WindowsPSProviders.ts` | 40 |
| `src/network/devices/shells/HuaweiSwitchShell.ts` | 37 |
| `src/terminal/sessions/LinuxTerminalSession.ts` | 27 |

**Nature du problème** : ce ne sont pas des conversions de données mais du **typage structurel sauvage pour contourner l'encapsulation**. Exemples représentatifs :
- `src/network/devices/shells/cisco/CiscoConfigCommands.ts:575` : `(port as unknown as { ipRedirects?: boolean }).ipRedirects = true;` — le shell **écrit un champ privé inexistant dans le type public** de `Port`.
- `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts:1446` : cast de 5 lignes redéclarant à la main toute l'interface de l'agent LLDP.
- `src/network/devices/linux/network/LinuxSshClient.ts:1175` : `(machine as unknown as { executor: { env?: Map<string,string> } }).executor?.env` — accès à l'exécuteur interne d'une autre machine.
- `src/terminal/sessions/TerminalSession.ts:420` : redéclaration structurelle de `getPorts()` alors que le type réel existe.

**Conséquences** : (1) chaque cast est un contrat dupliqué et non vérifié — un renommage de champ compile silencieusement et casse à l'exécution ; (2) refactoring automatique impossible (les outils ne voient pas ces usages) ; (3) le vrai graphe de dépendances est masqué : les shells dépendent de l'intérieur des devices sans qu'aucun import ne le déclare.

- **Gravité** : élevée. C'est la principale dette structurelle mesurable du dépôt.
- **Refactorisation proposée (incrémentale)** :
  1. Éradiquer d'abord les casts en **écriture** (les ~30 du type `CiscoConfigCommands.ts:505,575`) : ajouter les champs manquants (`ipRedirects`, `unnumberedSource`…) au vrai type `Port`/`RouterPort` — mécanique, sans risque.
  2. Pour les lectures, définir des **interfaces de capacité** (`LldpCapable`, `HasExecutor`, `HasPorts`…) déclarées une fois près du device et implémentées explicitement, + type guards (`supportsLldp(dev): dev is LldpCapable`). Le pattern existe déjà (`HostCapableDevice` dans `src/network`, utilisé par `LinuxServer.ts:157`) — le généraliser.
  3. Verrouiller par lint : règle ESLint interdisant `as unknown as` hors `__tests__` (`no-restricted-syntax`), avec baseline dégressive (fail si le compte augmente).

### 2.3 God classes : le quatuor Linux/shell — 🔴

**Inventaire** :
- `LinuxCommandExecutor.ts` (6 504 l.) : sa méthode `dispatch()` fait **1 205 lignes et 207 `case`** (`:3294-4498`). C'est un switch géant sur le nom de commande.
- `EndHost.ts` (3 885 l.), `LinuxMachine.ts` (3 202 l.), `LinuxTerminalSession.ts` (4 008 l.) : trois couches qui se partagent confusément le cycle de vie hôte + exécution de commandes + session terminal ; `LinuxTerminalSession` re-perce l'encapsulation du device qu'elle pilote (27 casts).
- Shells vendeur : `CiscoSwitchShell.ts` 4 436 l., `HuaweiSwitchShell.ts` 3 159 l., `CiscoShellBase.ts` 2 422 l. dont une méthode ~848 l. (`:1485`).

**Point positif** : la migration est **déjà amorcée**. Il existe un registre de commandes Linux (`LinuxCommand` avec champ `privilege`, cf. le commentaire `LinuxCommandExecutor.ts:3299-3305` qui décrit la délégation au registre, et `src/network/devices/linux/commands/`), et côté routeurs un découpage par domaine (`shells/cisco/CiscoOspfCommands.ts`, etc.). Le problème est que la migration est inachevée : 207 `case` résiduels dans le switch.

- **Gravité** : élevée (coût de modification, conflits git, temps de compilation TS localisé).
- **Refactorisation proposée** : stratégie *strangler fig* déjà en place — la poursuivre en se fixant un budget : chaque PR touchant une commande du switch doit la migrer vers le registre. Objectif chiffrable : `dispatch()` < 200 lignes (routage pur). Même approche pour `CiscoSwitchShell`/`HuaweiSwitchShell` vers le pattern `CommandTrie` déjà présent (`src/network/devices/shells/CommandTrie.ts`).

### 2.4 État global et singletons — 🟠 maîtrisé mais coûteux pour les tests

**Inventaire des états globaux de production** :
- `EquipmentRegistry` (`src/network/equipment/EquipmentRegistry.ts:55-67`) : singleton `getInstance()`/`resetInstance()` — mais **conçu injectable** (`new EquipmentRegistry()` par test, bus injectable via `setEventBus`). Bonne conception ; le problème est que la façade statique `Equipment.getById/getAllEquipment/clearRegistry` (`src/network/equipment/Equipment.ts:30-34`) redirige tout le monde vers le singleton, annulant l'injectabilité en pratique.
- `getDefaultEventBus()` (`src/events/EventBus.ts`) : bus par défaut global.
- `ShellFactory.registry` statique + `reset()` (`src/shell/ShellFactory.ts:50,57`) — acceptable (registre d'enregistrement au chargement, pattern documenté).
- `DeviceFactory` : compteurs de noms au niveau module + `resetDeviceCounters()` qui fait **aussi** `Equipment.clearRegistry()` (`src/network/devices/DeviceFactory.ts:19,88-91`) — double responsabilité surprenante.
- `src/terminal/commands/database.ts:24-32` : **5 Maps module-level** (instances Oracle, syncs filesystem/systemd/syslog/listener par device) — l'état Oracle d'un device vit hors du device, dans un module de la couche terminal.
- `HostLookup` (`src/network/devices/linux/network/HostLookup.ts:26,53,121,223`) : fonctions libres qui appellent `EquipmentRegistry.getInstance()`.

**Impact mesuré sur les tests** : **834 fichiers de test** (62 %) appellent un reset global (`resetInstance`/`clearRegistry`/`resetDeviceCounters`). Chaque oubli = pollution inter-tests (symptôme confirmé : tests verts seuls, rouges en suite).

- **Gravité** : moyenne — l'architecture cible (injectable) existe, c'est l'adoption qui manque.
- **Refactorisation proposée** : (1) un helper de test unique `createIsolatedTopology()` qui instancie `new EquipmentRegistry()` + `new EventBus()` + scheduler virtuel et les injecte, à substituer progressivement aux resets manuels ; (2) court terme : reset automatique global dans un `setupFiles` vitest (une ligne de config) pour éliminer la classe entière de flakiness ; (3) déprécier la façade statique `Equipment.getById/getAllEquipment` (les 2 seuls points d'entrée réellement nécessaires passent par le store).

### 2.5 « Téléportation » par le registre global — 🟠 anti-pattern de simulation

`HostLookup.findHostByAddress()` résout un hôte par IP **en parcourant le registre global** au lieu de passer par la simulation de trames — et il est importé jusque dans `src/powershell/providers/WindowsPSProviders.ts:26`. C'est à la fois une violation de couche (le runtime PowerShell interroge la topologie mondiale) et une entorse au principe fondateur « equipment-driven, pas de médiateur central » revendiqué par `CLAUDE.md`. Idem `transitTcpAclVerdict()` (`HostLookup.ts:116`) qui simule un verdict ACL de transit hors bande.

- **Gravité** : moyenne (fonctionnellement voulu comme raccourci de perf, mais il contourne précisément ce que le produit simule ; risque de divergences ping-OK/ssh-KO).
- **Proposition** : encapsuler ces raccourcis derrière une interface `PathOracle` injectée, documentée comme optimisation, avec un mode « strict » (tests) qui force le chemin par trames.

### 2.6 Le pattern protocole documenté n'est appliqué que par 4 protocoles sur 33 — 🟡 dérive documentaire

`CLAUDE.md` prescrit `Engine + types + events + observables + actors`. Mesure sur les 33 répertoires protocolaires :

| Conformité | Protocoles |
|---|---|
| Complet (engine+types+events+observables+actors) | `ospf`, `rip`, `dhcp` (actor-based sans fichier *Engine), `ipsec` |
| Partiel | `routing` (pas d'events), `bgp`/`eigrp` (pas de types.ts ni observables), `arp` |
| Minimal `types.ts`+`events.ts` seulement (l'implémentation est un `*Agent.ts` dans le dossier ou côté device) | les **25 autres** (`stp`→`StpAgent`, `hsrp`→`HsrpAgent`, `tcp`→`TcpStack`, `bfd`, `cdp`, `dot1x`, `dtp`, `glbp`, `gre`, `igmp`, `lacp`, `lldp`, `netflow`, `ntp`, `pim`, `radius`, `snmp`, `syslog`, `tacacs`, `udld`, `vrrp`, `vtp`, `vxlan`…) |

En pratique il existe **deux patterns légitimes** : « Engine réactif » (protocoles à machine d'états lourde) et « Agent léger » (29 fichiers `*Agent.ts`). Ce n'est pas un défaut de code — c'est la doc qui décrit une règle que 75 % du code ne suit pas.

- **Proposition** : documenter les deux patterns et leurs critères de choix dans `CLAUDE.md` ; harmoniser les 3 protocoles réellement incohérents (`bgp`, `eigrp` sans `types.ts` ; `routing` sans `events.ts`).

### 2.7 SOLID, injection, interfaces — bilan contrasté, avec du très bon

**Bien fait (à souligner)** :
- `ShellFactory` (`src/shell/ShellFactory.ts:1-15`) : Factory Method + Registry auto-documenté, précisément pour garder le graphe **acyclique** — et ça marche (spawn de sous-shells sans import direct).
- `IShell`/`IShellBase`/`AbstractShell` : abstraction fine (162+39+228 lignes), `CrossVendorRemoteShell` prouve que l'abstraction tient (SSH hétérogène).
- `EquipmentRegistry` injectable avec bus optionnel ; `Logger` avec bus override.
- `src/react/hooks/` (14 hooks : `useDevices`, `useOspf`, `useSignal`…) : vrai pont réactif UI↔moteur au lieu d'accès sauvages.
- `deviceCatalog` piloté par données pour les capacités (`hasTerminal`, `fullyImplemented`).
- 0 `@ts-ignore`/`@ts-expect-error` dans tout `src/` — remarquable à cette échelle.

**Points faibles** : OCP violé par les switchs géants (§2.3) ; LSP/ISP contournés par les casts structurels (§2.2) ; DIP inégal — les devices instancient leurs sous-systèmes en dur (acceptable pour une simulation, mais `WindowsPC.ts:36-38` importe l'interpréteur PowerShell concret pendant que `powershell/providers` importe `WindowsPC` : cycle, cf. §3).

---

## 3. Frontières architecturales : carte et violations

### 3.1 Carte des dépendances réelles (imports `@/…` mesurés)

```
components (72f) ──→ store ──→ network (Equipment vivants dans le store Zustand)
     │  └──→ react/hooks ──→ events, network (pont propre)
     │  └──→ network : 20 imports directs (6 composants manipulent Equipment)
     │  └──→ terminal : 11 imports
terminal (120f) ──→ network : 106 imports        [attendu : le terminal pilote les devices]
shell (29f) ──→ network (types Equipment)         [attendu]
powershell (55f) ⇄ network : 17 imports / 5 en retour   ⚠ CYCLE
bash (13f) ⇄ network : 2 imports / 4 en retour          ⚠ CYCLE
network ──→ terminal : 3 imports                        ⚠ INVERSION
network ──→ database : 4 imports (NPS accounting)       ⚠ latéral
database : 0 import vers network/terminal               ✔ propre
events : 0 dépendance sortante                          ✔ socle propre
network ──→ components/store/react : 0                  ✔ le moteur ignore l'UI
```

### 3.2 Violations précises

1. **`network → terminal` (inversion)** : `src/network/devices/LinuxServer.ts:15-17` importe `@/terminal/commands/database`, `@/terminal/commands/OracleCommands` et `@/terminal/subshells/rman`. Un device du moteur dépend de la couche terminal, laquelle dépend du moteur → cycle inter-couches. Aggravé par le fait que l'état Oracle par device vit dans `terminal/commands/database.ts:24-32` (Maps module-level, §2.4).
   *Correction* : déplacer le cycle de vie Oracle-par-device dans `src/adapters/` (qui existe exactement pour ça : `OracleFilesystemSync`, `OracleSystemdSync`) et exposer au device une interface `OracleHost` enregistrée par la couche haute (même technique que `ShellFactory`).
2. **Cycle `powershell ⇄ network`** : `src/powershell/providers/WindowsPSProviders.ts:16-26,48` importe 12+ modules de `network/devices/windows/*` et même `network/ipsec/RemoteAccessVpnClient` ; en face `src/network/devices/WindowsPC.ts:36-38` importe l'interpréteur. Le sous-répertoire `providers/` est de facto du code *device Windows* rangé dans le paquet interpréteur.
   *Correction* : `WindowsPSProviders.ts` (2 185 l.) appartient à `network/devices/windows/` ; le paquet `powershell/` ne devrait exporter que l'interpréteur + les interfaces de providers (`PSProviders.ts` y est déjà).
3. **Cycle `bash ⇄ network`** : `src/bash/runtime/ScriptRunner.ts:13-14` importe `ShellContext` depuis `network/devices/linux/LinuxFileCommands` et `INode` depuis `VirtualFileSystem`. Deux imports *type-only* — cycle bénin, cassable en déplaçant ces types dans `src/bash/runtime/io.ts` ou un paquet de types partagé.
4. **`components → Equipment` direct** : 20 imports (`NetworkCanvas.tsx`, `TerminalModal.tsx`, `NetworkDevice.tsx`, `devtools/LiveDeviceStats.tsx`…). Le store expose `deviceInstances: Map<string, Equipment>` (`src/store/networkStore.ts:97-119`) — pont assumé et documenté, avec un mécanisme soigné de snapshots stables (`networkStore.ts:157-184`, WeakMap anti-re-render). Acceptable pour une app de cette nature ; le risque réel est un composant qui *mute* un Equipment sans passer par le store.
5. **Doc obsolète = fausses frontières** : `CLAUDE.md` décrit `terminal/filesystem.ts`, `shellUtils.ts` et `commands.ts` qui **n'existent plus** (le répertoire réel : `async/ commands/ completion/ core/ flows/ intent/ sessions/ subshells/`). Le « double système de fichiers » historique est résolu — il ne reste que `VirtualFileSystem.ts` (1 236 l.) + `WindowsFileSystem.ts`. De même la mention « `@typescript-eslint/no-unused-vars` disabled project-wide » est fausse : `eslint.config.js:23-28` le met en `warn` avec ignore-patterns `^_` — configuration saine. La doc d'architecture a pris ~3 refactorings de retard.

**Verdict global** : les frontières sont **globalement bonnes** (le moteur ignore l'UI, `database/` et `events/` sont propres, 106 imports terminal→network vont tous dans le bon sens). Les violations sont peu nombreuses, localisées et corrigeables sans big-bang.

---

## 4. Asynchronisme et déterminisme

### 4.1 Le socle est bon

`src/events/` (1 203 l.) fournit `EventBus`, `Signal`, `TimerSet`, `waitForEvent` et surtout **deux schedulers** : temps réel et `VirtualTimeScheduler` avec `advance(ms)` explicitement conçu pour remplacer `vi.useFakeTimers` (`src/events/Scheduler.ts:8-14,158`). Adoption réelle : 84 sites de production instancient/récupèrent un Scheduler ; les moteurs de protocoles passent par `this.timers.setTimeout` (TimerSet) et non par le timer global — vérifié sur `RIPEngine.ts:529,750,799` et `OSPFEngine.ts:1057,1443,1463,1494,2726`.

### 4.2 Les fuites hors du socle (chiffrées)

- **30 `setTimeout` globaux bruts** dans toute la prod, dont 16 dans `src/network` : transports DNS (`DnsUdpTransport.ts:126`, `DnsTcpTransport.ts:72`, `DnsTlsTransport.ts:162`, `SimulatedTls.ts:163`), `TftpSession.ts:81`, `SocketTable.ts:217`, `LinuxServiceSupervisor.ts:80`, `LinuxServiceManager.ts:644`, `RndcClient.ts:57`, sleeps réels dans `Ping.ts:403` et `LinuxMachine.ts:2900`, et un délai de propagation OSPF en dur `RouterOSPFIntegration.ts:245`.
- **46 `setInterval`** prod (hors les 9 légitimes de `Scheduler`/`TimerSet`) : `Switch.ts` (4), `PimAgent.ts` (3), `OSPFEngine.ts` (3), `IPSecEngine.ts` (2)… — des boucles périodiques ancrées sur l'horloge murale.

Chacun de ces sites est invisible au `VirtualTimeScheduler` : un test qui avance le temps virtuel n'avance **pas** ces timers → attentes réelles, donc lenteur et non-déterminisme sous charge CPU (la flakiness observée en suite complète est cohérente avec ce diagnostic).

### 4.3 Côté tests, la discipline est minoritaire

- 34 fichiers de test utilisent `useFakeTimers`, 25 `advanceTimers` ;
- **66 fichiers** attendent du temps réel (`await new Promise(r => setTimeout(r, …))`, ~199 occurrences d'attentes/sleeps). C'est la première cause structurelle de flakiness et une part directe des ~14 min de suite.

**Proposition (incrémentale)** : (1) règle lint `no-restricted-globals`-style interdisant `setTimeout`/`setInterval` nus sous `src/network` hors `events/` (30+46 sites à migrer vers `TimerSet`, mécanique) ; (2) fournir un util de test `await topology.settle()` basé sur `VirtualTimeScheduler.advance` + drain de micro-tâches, et convertir en priorité les 20 fichiers de test les plus lents.

---

## 5. Stratégie de test : forces et faiblesses

### Forces
- **Volume et granularité** : ~20 200 cas dans 1 344 fichiers, ciblés par sous-système (`unit/network-v2`, `unit/database`, `unit/powershell`…), plus 71 specs e2e Playwright réelles (drag-and-drop, SSH inter-devices). Ratio test/prod 0,82:1.
- Suites d'intégration transversales de grande valeur (`cross-equipment-ssh-suite.test.ts` 2 822 l. : SSH Linux→Cisco→Huawei).
- 0 `@ts-ignore` ; 834 fichiers pensent à nettoyer l'état global (même si c'est le symptôme du §2.4).

### Faiblesses
1. **`debug/` : 94 fichiers, 22 528 lignes, dont 67 sans un seul `expect(`**. Ce sont des dumps de transcripts exécutés comme des tests. Verdict nuancé : c'est un outillage d'analyse d'écarts légitime *pour un simulateur* (comparer la sortie à un vrai IOS), mais exécuté dans la suite par défaut il coûte du temps CI sans détecter aucune régression, et il gonfle le compteur « 14 500 tests » d'éléments non-assertifs. *Proposition* : les sortir de l'`include` vitest par défaut (projet vitest séparé `debug`), et convertir les plus précieux en snapshots approuvés (`toMatchSnapshot`) — ils deviendraient alors de vrais tests de non-régression de sortie CLI, quasi gratuitement.
2. **Couverture mesurée sur 3 % du code** : le seul seuil configuré couvre `src/network/protocols/ssh/**` (86 fichiers, 12 127 l.) — `vite.config.ts:52-59`. Historiquement compréhensible (chantier SSH), mais cela signifie qu'aucune régression de couverture n'est détectable sur les 354 000 autres lignes. *Proposition* : ratcheting — ajouter un seuil global bas mais réel (ex. lignes 60 %) + seuils par sous-système au fil des chantiers, plutôt qu'un objectif uniforme irréaliste.
3. **Durée (~14 min) et coût d'import (~1 270 s cumulées rapportées)** : trois causes structurelles identifiables. (a) Les **imports barrel** : `src/network/index.ts` ré-exporte 30 modules ; 26 fichiers de test importent `from '@/network'` et chaque test qui touche un device tire transitivement une grande partie des 1 014 fichiers de `network/` — dans l'environnement `node` de vitest, ce coût d'import est payé **par worker et par fichier de test** (1 344 fois). (b) Les attentes réelles (§4.3). (c) Les méga-fichiers de test (`nat-pat-other.test.ts` 4 279 l.) qui empêchent un bon équilibrage entre workers. *Propositions concrètes* : imports profonds dans les tests (codemod), `pool: 'threads'` + `isolate: false` pour les suites pures (à valider vu l'état global — après §2.4.2), sharding CI (`--shard=i/n`), et scission des 10 plus gros fichiers de test.
4. **L'isolation repose sur la discipline** (834 resets manuels) au lieu d'un `setupFiles` central — cf. §2.4.

---

## 6. Dette et risques divers

| Constat | Mesure | Appréciation |
|---|---|---|
| `TODO`/`FIXME`/`HACK`/`XXX` en prod | **0** occurrence | Exceptionnel — la dette est traquée dans des `.md` de gap analysis plutôt qu'en commentaires (traçable, mais voir ligne suivante) |
| Docs à la racine | 18 fichiers `.md` racine + ~40 sous `docs/` : PRD, BRD, 4 journaux (`JOURNAL-REFACTORING.md`, `JOURNAL-REFONTE.md`, `REFACTORING-JOURNAL.md`, `docs/JOURNAL-*`), gaps, tutoriels mélangés | Désorganisé : 3 journaux de refactoring concurrents à la racine. Proposer `docs/{prd,design,journal,gap,tuto}/` + index, et surtout **resynchroniser CLAUDE.md** (4 affirmations obsolètes relevées §2.1, §3.2.5) |
| Échappatoires de typage | 891 `as unknown as` prod, 397 `as any`, 109 `: any`, ~103 chaînes `x!.`, 0 `@ts-ignore` | Concentré (§2.2) — corrigeable par lots |
| ESLint | `no-unused-vars` en `warn` + patterns `^_` (`eslint.config.js:23-28`) — pas désactivé | Sain ; ajouter les règles anti-`as unknown as` et anti-timers nus proposées |
| `crypto/` maison (28 fichiers) | Simulation pédagogique, jamais de la vraie crypto exposée | OK pour l'usage ; à étiqueter comme telle dans le README du dossier |
| Stubs silencieux | `DeviceFactory.ts:61-73` : les 3 firewalls, `cloud` et `access-point` sont des `LinuxPC`/`Hub` déguisés | Assumé via `isFullyImplemented()` piloté par le catalogue — bonne pratique, à faire remonter dans l'UI si ce n'est pas déjà le cas |

---

## 7. Top 10 des refactorisations recommandées (impact/effort)

| # | Refactorisation | Impact | Effort | Détail |
|---|---|---|---|---|
| 1 | **Reset global automatique en `setupFiles` vitest** (registry, bus, scheduler, compteurs) | Élevé : élimine la classe « vert seul / rouge en suite » pour 834 fichiers | Très faible (1 fichier) | §2.4 |
| 2 | **Sortir `__tests__/debug` de la suite par défaut** (projet vitest dédié) + convertir les 20 meilleurs en snapshots | Élevé : minutes de CI récupérées, métrique de tests honnête | Faible (config + codemod léger) | §5.2.1 |
| 3 | **Lint anti-régression** : interdire `as unknown as` (prod) et `setTimeout`/`setInterval` nus (sous `network/`), avec baseline dégressive | Élevé : gèle les deux dettes principales | Faible | §2.2, §4 |
| 4 | **Éradiquer les casts en écriture** (~30 sites type `CiscoConfigCommands.ts:575`) en ajoutant les champs aux vrais types | Moyen-élevé : supprime les bombes silencieuses | Faible, mécanique | §2.2 |
| 5 | **Imports profonds dans les tests** au lieu du barrel `@/network` (codemod) + sharding CI | Élevé : attaque directe des ~1 270 s d'imports | Moyen | §5.3 |
| 6 | **Casser le cycle `powershell ⇄ network`** : déplacer `WindowsPSProviders.ts` vers `network/devices/windows/` | Moyen : frontière la plus violée assainie | Moyen (1 fichier de 2 185 l. + imports) | §3.2.2 |
| 7 | **Casser `network → terminal`** : sortir l'état Oracle-par-device de `terminal/commands/database.ts` vers `src/adapters/` derrière une interface enregistrée | Moyen : supprime l'inversion de couche + 5 Maps globales | Moyen | §3.2.1, §2.4 |
| 8 | **Poursuivre le strangler de `LinuxCommandExecutor.dispatch()`** : règle « toute PR touchant une commande la migre au registre », objectif < 200 lignes | Élevé à terme : défuse la pire God class (6 504 l., 207 case) | Étalé, incrémental | §2.3 |
| 9 | **Migrer les 76 timers nus vers `TimerSet`/Scheduler** puis convertir les 66 fichiers de test à attentes réelles vers le temps virtuel | Élevé : déterminisme + vitesse | Moyen, parallélisable | §4 |
| 10 | **Resynchroniser `CLAUDE.md` + ranger les docs** (2 patterns protocoles, constructor.name résolu, fichiers fantômes, 3 journaux fusionnés) et retirer `keepNames` après un build minifié validé | Moyen : la doc pilote les contributions (humaines et IA) — une doc fausse reproduit les anti-patterns | Faible | §2.1, §2.6, §3.2.5 |

---

### Synthèse

Le dépôt est **nettement au-dessus de la moyenne** pour un projet de cette ambition : frontières majoritairement respectées (moteur totalement découplé de l'UI, `events/` et `database/` propres), abstractions shell exemplaires (`ShellFactory`, `IShell`, `CrossVendorRemoteShell`), infrastructure de temps virtuel déjà construite, zéro `@ts-ignore`, zéro TODO, duplication textuelle contenue (< 4 % sur les zones à risque), et des refactorings passés menés à terme et documentés (dispatch `constructor.name` éliminé, registre injectable). Les deux vraies dettes sont **l'encapsulation percée** (891 casts structurels qui masquent le vrai graphe de dépendances) et **l'inachèvement** de deux migrations par ailleurs bien engagées (registre de commandes Linux, adoption du scheduler virtuel dans les tests). Aucune ne nécessite de big-bang : les dix actions ci-dessus sont toutes incrémentales, et les trois premières tiennent dans une semaine de travail.
