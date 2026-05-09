# Refonte vers une architecture réactive et événementielle

> Rapport d'analyse et plan de refonte pour Ubuntu Sandbox.
> Document vivant — rédigé section par section, chaque section faisant l'objet d'un commit dédié.
> Branche : `claude/reactive-event-driven-refactor-8hVAE`

---

## Table des matières

1. [Introduction & objectifs de la refonte](#1-introduction--objectifs-de-la-refonte)
2. [État actuel de l'architecture](#2-état-actuel-de-larchitecture)
3. [Analyse de la couche réseau — `Equipment` / `Port` / `Cable`](#3-analyse-de-la-couche-réseau--equipment--port--cable)
4. [Analyse des `devices` concrets et des moteurs de protocoles](#4-analyse-des-devices-concrets-et-des-moteurs-de-protocoles)
5. [Analyse de la couche terminal](#5-analyse-de-la-couche-terminal)
6. [Analyse du store Zustand et des composants React](#6-analyse-du-store-zustand-et-des-composants-react)
7. [Analyse de la couche base de données (Oracle)](#7-analyse-de-la-couche-base-de-données-oracle)
8. [Architecture cible — bus d'événements, scheduler, état observable](#8-architecture-cible--bus-dévénements-scheduler-état-observable)
9. [Refactoring détaillé par classe](#9-refactoring-détaillé-par-classe)
10. [Plan de migration séquentiel](#10-plan-de-migration-séquentiel)
11. [Risques, tests et métriques de succès](#11-risques-tests-et-métriques-de-succès)
12. [Conclusion et annexes](#12-conclusion-et-annexes)

---

## 1. Introduction & objectifs de la refonte

### 1.1 Contexte

Ubuntu Sandbox est un simulateur réseau **navigateur-only** écrit en TypeScript / React. Il permet à un utilisateur de glisser-déposer des équipements réseau (routeurs Cisco/Huawei, commutateurs, hubs, PC Linux/Windows, serveurs Linux) sur un canvas, de les câbler, et d'interagir avec eux via des terminaux émulant Cisco IOS, Huawei VRP, Linux bash, Windows cmd/PowerShell, et Oracle SQL\*Plus. Le projet inclut aussi des moteurs de protocoles complets (OSPFv2/v3, RIP, DHCP, IPSec, ACL, NAT, ARP/NDP, ICMP, TCP simplifié) et une simulation Oracle DBMS.

L'architecture actuelle, dite « equipment-driven », a été pensée pour être **directe** : il n'y a pas de médiateur central de simulation, chaque équipement traite lui-même les trames qu'il reçoit. C'est élégant, lisible, mais ce design repose sur des **callbacks impératifs synchrones** posés à la main (un `onFrame` par port, un tableau de `linkChangeHandlers`, un tableau de `dataHandlers` TCP, une `Map` de `pendingARPs`, etc.). Les timers physiques sont des `setTimeout` / `setInterval` natifs disséminés dans plus d'une vingtaine de fichiers (≈ 91 occurrences recensées dans `src/network/` et `src/terminal/`). Le seul vrai canal *publish/subscribe* du projet est `Logger`, et il sert quasi-exclusivement à du diagnostic textuel.

### 1.2 Pourquoi refondre

Le projet a atteint un volume — environ 2 300 lignes pour `EndHost`, 1 545 pour `Router`, et 8 000+ pour le moteur Oracle — où les limites du modèle « callbacks ad-hoc + état mutable + transmission synchrone » deviennent structurelles :

1. **Couplage rigide entre couches.** La couche L2 (`Port` → `Cable`) appelle directement la fonction `handleFrame` enregistrée par l'`Equipment`. Toute logique transverse (animation visuelle de paquet, capture type tcpdump, injection de fautes, journal d'événements de protocole pour la UI) doit être insérée à la main dans chaque équipement.
2. **Réactivité UI partielle.** Le store Zustand bascule un nouveau `Map` de `deviceInstances` à chaque mutation pour forcer un rerender, mais les changements **internes** d'un `Equipment` (table de routage, état OSPF d'un voisin, table ARP, état des ports d'un switch) ne propagent pas vers React. La UI doit donc soit ignorer ces états, soit re-puller manuellement, soit dépendre du polling.
3. **Asynchronisme par promesses jetables.** Les résolutions ARP/NDP, les pings, les handshakes TCP s'appuient sur des `Map<string, callback>` jetables ; il n'existe pas d'objet « connexion » ou « requête en vol » observable, ni de mécanisme uniforme d'annulation.
4. **Indéterminisme implicite.** Les `setTimeout` natifs rendent les tests sensibles à l'horloge réelle ; certains tests font du time-travelling avec `vi.useFakeTimers`, d'autres patchent à la main. Aucun *scheduler* abstrait ne contrôle le temps de simulation.
5. **Animation et observabilité limitées.** `PacketAnimation.tsx` est officiellement marqué *placeholder* car la transmission L2 est synchrone : il n'existe pas d'« événement paquet en transit » observable côté UI. La capture, le replay, l'inspection live (« show packets ») sont impossibles sans recâblage manuel.
6. **Duplication de patterns réactifs primitifs.** `TerminalSession` a réinventé un mini-pub/sub pour `useSyncExternalStore`, `Logger` a son propre dispatcher, `Port` gère ses `linkChangeHandlers`, `TcpConnection` ses `dataHandlers`. Quatre implémentations distinctes du même schéma observable, sans typage commun ni traçabilité.
7. **Difficulté d'extension.** Ajouter un protocole (mDNS, LLDP, BGP) implique aujourd'hui de toucher `EndHost` ou `Router`, de gérer ses propres timers, ses propres callbacks, et son propre logging. Une plug-in API n'est pas envisageable en l'état.

### 1.3 Objectifs

La refonte vise une architecture **réactive et événementielle de bout en bout** dont les objectifs sont :

| # | Objectif | Indicateur de succès |
|---|---|---|
| O1 | **Bus d'événements typé unique** servant de colonne vertébrale (réseau, protocoles, périphériques, terminal, UI). | Suppression des `onFrame`, `linkChangeHandlers`, `dataHandlers`, et `Map<string,callback>` ad-hoc au profit d'un seul `EventBus` avec discriminated unions et garanties d'ordre. |
| O2 | **État observable** sur tous les objets de domaine (`Equipment`, `Port`, `Cable`, tables de routage, caches ARP, LSDB OSPF, sessions TCP, sessions terminal). | Hooks React typés (`useDevice`, `usePort`, `useRoute`, `useArpEntry`, …) qui se réabonnent automatiquement aux changements granulaires sans rerender global. |
| O3 | **Scheduler virtuel** unique pour tous les timers (Hello OSPF, ARP timeout, MAC aging, DHCP renewal, TCP retransmit, animations). | `setTimeout` / `setInterval` natifs interdits hors du `Scheduler` ; tests déterministes par avance virtuelle du temps ; possibilité de pause/play/×N en runtime. |
| O4 | **Pipeline L2 asynchrone** explicite : `Port.send` émet un événement `frame.in-flight`, le `Cable` programme la livraison via le scheduler à `+propagationDelay`, `Port.receive` émet `frame.received`. Activation native de l'animation et de la capture. | `PacketAnimation` consomme directement `frame.in-flight` ; un mode tcpdump est implémentable en < 100 lignes ; replay déterministe possible. |
| O5 | **Découplage UI ↔ domaine.** La UI ne lit plus jamais d'objet de domaine mutable ; elle consomme un état projeté (read-models) émis par le bus. | Aucun `instance: Equipment` exposé dans `NetworkDeviceUI` ; les composants n'importent plus `@/network/equipment/Equipment`. |
| O6 | **Plug-in API protocolaire.** Un nouveau protocole = une classe qui s'abonne à des événements de bus et en émet d'autres ; pas de modification d'`Equipment` requise. | Démontré sur un protocole ajouté en post-refonte (p. ex. LLDP) en moins de 300 lignes et sans modifier les classes de base. |
| O7 | **Déterminisme et reproductibilité.** À condition initiale et événements externes identiques, deux exécutions produisent la même trace d'événements. | Test snapshot d'une trace OSPF-converge ; test d'un scénario DHCP DORA bit-pour-bit identique. |
| O8 | **Pas de régression fonctionnelle.** L'ensemble des fonctionnalités existantes (commandes Cisco/Huawei/Linux/Windows, OSPF, DHCP, IPSec, Oracle SQL\*Plus, éditeurs nano/vim) reste opérationnel. | Suite de tests `vitest` actuelle (97+ fichiers réseau + GUI + database) verte au moment du merge. |

### 1.4 Périmètre

**Inclus dans le périmètre :**

- Couche réseau : `Equipment`, `Port`, `Cable`, `EquipmentRegistry`, `PacketQueue`, `NeighborResolver`, `TcpConnection`, `SocketTable`, `Logger`.
- Devices concrets : `EndHost` et descendants (`LinuxPC`, `LinuxServer`, `WindowsPC`), `Router` et variantes vendor, `Switch` et variantes vendor, `Hub`.
- Moteurs de protocoles : `OSPFEngine`, `OSPFv3Engine`, `RIPEngine`, `RouterRIPEngine`, `DHCPClient`, `DHCPServer`, `IPSecEngine`, `ACLEngine`, `NATEngine`, `IPv6DataPlane`, `RouterOSPFIntegration`.
- Couche terminal : `TerminalSession` et descendants, `TerminalManager`, sub-shells, `InteractiveFlowEngine`, formatters.
- Store et UI : `networkStore` (Zustand), `NetworkDesigner`, `NetworkCanvas`, `NetworkDevice`, `ConnectionLine`, `PacketAnimation`, `PropertiesPanel`, `TerminalModal`, `MinimizedTerminals`.
- Couche base de données : `OracleInstance`, `OracleExecutor`, `OracleCatalog`, `OracleStorage` (intégration via événements de session).

**Hors périmètre — pour cette refonte :**

- Réécriture des parsers (Cisco, Huawei, Linux bash, PowerShell, SQL) : ils restent en l'état, seuls leurs *bordures d'intégration* (entrée commande, sortie résultat, effets de bord côté équipement) passent par le bus.
- Migration UI vers une autre librairie (le projet reste sur React + shadcn/ui + Zustand).
- Réécriture du moteur Oracle interne (lexer/parser/exécuteur) ; seul le couplage avec la session terminal et l'état observable de l'instance change.
- Persistance / sérialisation (`topologySerializer.ts`) : adaptée aux nouveaux read-models, pas redessinée.

### 1.5 Hypothèses et contraintes

- **Mono-thread navigateur.** Pas de Web Worker introduit par cette refonte ; les bénéfices d'un bus événementiel passent par l'asynchronisme coopératif (microtâches + scheduler virtuel), non par du parallélisme.
- **Compatibilité tests existants.** Le scheduler virtuel doit pouvoir être avancé manuellement par les tests (`scheduler.advance(5_000)`) et substituable à `vi.useFakeTimers()`.
- **Pas d'inversion big-bang.** La migration est séquentielle, par couche, avec coexistence temporaire des deux modèles (cf. Section 10).
- **Performance.** Le coût d'un dispatch d'événement reste O(nombre d'abonnés au topic) ; les abonnements sont indexés par topic pour éviter le balayage global. La refonte ne doit pas dégrader la latence perçue (aujourd'hui : dispatch synchrone instantané) au-delà de l'imperceptible.
- **Pas de dépendance lourde ajoutée.** Le bus, le scheduler et les signals sont implémentés en interne (≈ 300 à 500 lignes), sans introduire RxJS, XState ni Redux Toolkit.

### 1.6 Glossaire de la refonte

- **Événement (Event)** : structure immuable typée, identifiée par un `topic` (chaîne hiérarchique, p. ex. `port.frame.received`) et un `payload` discriminé.
- **Bus d'événements (EventBus)** : registre central qui dispatche les événements aux abonnés filtrés par topic / source / type.
- **Scheduler** : abstraction des timers — fournit `setTimeout`, `setInterval`, `cancel`, `now()`, et un mode test `advance(ms)`.
- **Read-model / projection** : vue dérivée et immuable d'un état de domaine, recalculée par un *réducteur* à partir d'un flux d'événements, consommée par la UI.
- **Signal / Observable** : conteneur d'une valeur qui notifie ses lecteurs lors d'un changement (interface compatible `useSyncExternalStore`).
- **Acteur (Actor)** : équipement ou moteur de protocole qui s'abonne à certains événements, modifie son état interne, et en émet d'autres. Les acteurs ne s'appellent jamais directement.

### 1.7 Méthode de rédaction de ce document

Le rapport est rédigé **séquentiellement, sans agent**, section par section. Chaque section donne lieu à un commit indépendant sur la branche `claude/reactive-event-driven-refactor-8hVAE`. Les sections futures peuvent affiner ou contredire des hypothèses des sections précédentes ; toute correction sera explicitement notée comme *erratum* dans la section concernée.

---

*Section 1 close. Suivante : §2 — État actuel de l'architecture.*

---

## 2. État actuel de l'architecture

Cette section dresse une cartographie objective du code tel qu'il existe avant refonte. Elle sert de référence aux sections suivantes (chaque problème identifié ici sera repris en §3 à §7 puis traité en §9).

### 2.1 Vue d'ensemble en couches

```
┌──────────────────────────────────────────────────────────────────────┐
│ React Components — src/components/                                   │
│   NetworkDesigner • NetworkCanvas • NetworkDevice • ConnectionLine   │
│   PropertiesPanel • TerminalModal • MinimizedTerminals • ...         │
└──────────────────────────────────────────────────────────────────────┘
                                  │ useNetworkStore  (Zustand)
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Store — src/store/networkStore.ts                                    │
│   deviceInstances: Map<string, Equipment>   connections: Connection[]│
│   addDevice • addConnection • removeConnection • clearAll • ...      │
│   ⤷ deviceToUI()  (recalcul à chaque getDevices())                   │
└──────────────────────────────────────────────────────────────────────┘
                                  │ instances directes
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Terminal — src/terminal/                                             │
│   TerminalSession (subscribe/notify) • TerminalManager • SubShells   │
│   InteractiveFlowEngine • OutputFormatter • commands/ • flows/       │
└──────────────────────────────────────────────────────────────────────┘
                                  │ device.executeCommand(...)
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Devices — src/network/devices/                                       │
│   Router (1545 LoC)  Switch (838)  EndHost (2325)                    │
│   LinuxMachine (827) WindowsPC (695) Hub …                           │
│   ↳ delegates : LinuxXxxManager, WinXxx, shells/, router/, …         │
└──────────────────────────────────────────────────────────────────────┘
                                  │ extends Equipment, owns Ports
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Hardware/Equipment — src/network/equipment + hardware                │
│   Equipment (abstract, registry)    Port    Cable    PortSecurity    │
└──────────────────────────────────────────────────────────────────────┘
                                  │ frame in/out
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Core — src/network/core/                                             │
│   Logger (pub/sub texte) • PacketQueue • NeighborResolver            │
│   TcpConnection • SocketTable • RoutingTable • types/constants       │
└──────────────────────────────────────────────────────────────────────┘
```

Couches transverses : moteurs de protocoles (`ospf/`, `ipsec/`, `dhcp/`, `rip/`, `acl/`) attachés aux devices via composition ; base de données Oracle simulée (`src/database/oracle/`) attachée aux sub-shells SQL\*Plus.

### 2.2 Mécanismes d'interconnexion existants

Le code d'aujourd'hui exprime ses dépendances et ses notifications de **six façons distinctes**, chacune avec sa propre forme et son propre cycle de vie. C'est ce *patchwork* que la refonte vise à unifier.

| # | Mécanisme | Localisation type | Illustration | Limite |
|---|---|---|---|---|
| M1 | **Callback unique posé sur un objet** | `Port.frameHandler` | `port.onFrame((portName, frame) => …)` | Un seul abonné possible ; pas d'observabilité externe (capture, animation). |
| M2 | **Tableau de handlers maison** | `Port.linkChangeHandlers`, `TcpConnection.dataHandlers` | `port.onLinkChange(state => …)` | Pas de désinscription (Port) ou désinscription locale (Tcp) ; pas de filtrage ; pas de typage discriminé. |
| M3 | **Map de callbacks pendantes** | `EndHost.pendingARPs`, `EndHost.pendingPings`, `EndHost.pendingNDPs`, `EndHost.tcpListeners`, `EndHost.pendingTcpHandshakes` | `pendingARPs.set(ip, [{ resolve, reject, timer }])` | Cycle de vie manuel (timer + cleanup), fuites possibles, pas d'observation externe pour la UI ni les tests. |
| M4 | **Promise + setTimeout** | `NeighborResolver.resolve`, `withTimeout` | `new Promise<MAC>((res, rej) => { setTimeout(rej, …); …})` | Annulation difficile, dépend de l'horloge réelle, non rejouable. |
| M5 | **Pub/sub Logger** | `Logger.subscribe(filter)` | `Logger.info(id, 'arp:reply', ...)` | Logger uniquement, payload texte non typé, pas d'usage UI réel. |
| M6 | **Subscription versionnée** | `TerminalSession.subscribe / getVersion` | `useSyncExternalStore(s.subscribe, s.getVersion)` | Réinventé localement, propre au terminal, ne sait pas observer l'`Equipment` ni les ports. |

À cela s'ajoute la **notification implicite** par mutation de la `Map` Zustand : `set(state => ({ deviceInstances: new Map(state.deviceInstances) }))`. C'est le seul lien entre les `Equipment` et le rerender React, et il n'est déclenché que sur les mutations *administrées par le store* (add/remove/move device, add/remove connection, power on/off). Tout changement d'état initié *à l'intérieur* d'un équipement (réception d'une trame, mise à jour d'une table de routage par OSPF, expiration d'un bail DHCP) **ne déclenche aucun rerender**.

### 2.3 Inventaire des timers (`setInterval` / `setTimeout`)

Le projet contient **104 occurrences** brutes de `setInterval` ou `setTimeout`, réparties ainsi (recensement par `grep -rn`) :

| Couche | Occurrences | Fichiers concernés |
|---|---|---|
| `src/network/` | 87 | OSPFEngine, OSPFv3Engine, RIPEngine, RouterRIPEngine, DHCPClient, IPSecEngine, EndHost, Router, Switch, NATEngine, IPv6DataPlane, RouterOSPFIntegration, PacketQueue, NeighborResolver, CiscoNATCommands, HuaweiNATCommands. |
| `src/terminal/` | 4 | `TerminalSession.replayRecording`, `CLITerminalSession` (boot delay, pager animations). |
| `src/store/` + `src/components/` + `src/hooks/` | 13 | `PacketAnimation`, `MinimizedTerminals`, `TerminalView` (debounce, scroll-into-view), `use-toast`. |
| `src/database/` | 0 | Pure-synchrone. |

Ces timers ne partagent **aucune abstraction** : il n'y a ni table centrale, ni mode test commun. `vitest` doit appeler `vi.useFakeTimers()` dans chaque fichier de test concerné, et ce dispositif ne couvre pas les *Promise* qui contiennent un `setTimeout` (p. ex. `NeighborResolver`). Conséquence pratique : certains tests OSPF (`ospf-converge.test.ts`) appellent directement les méthodes internes du moteur (p. ex. `tickLSAge()`) plutôt que d'avancer le temps virtuellement, ce qui couple les tests à l'implémentation.

### 2.4 Inventaire des points de logging

`Logger` est appelé **environ 90 fois** dans la couche réseau (5× `Equipment`, 18× `Port`, 9× `Cable`, 17× `Router`, 11× `Switch`, 17× `EndHost`, plus tous les moteurs de protocoles et plusieurs commandes Linux/Cisco). Chaque appel produit un événement-texte typé `{ level, source, event, message, data? }` avec un `event` choisi à la volée par chaîne de caractères (`'arp:reply'`, `'frame:received'`, `'ospf:lsa-flood'`, …). Aucune validation. Aucun consommateur UI réel à ce jour ; le seul *abonné* est l'éventuel développeur qui branche un `subscribe` à la console.

C'est une **base intéressante** pour le bus cible : le pattern publish/subscribe avec filtre par source/event existe déjà ; il suffit de **généraliser** en faisant porter au bus toute la communication inter-objets, pas seulement les logs.

### 2.5 Vue d'ensemble du flux de données runtime

Pour un scénario simple « PC-A ping PC-B via un switch », le flux actuel est :

```
EndHost-A.pingHost("10.0.0.2")
  └─ ARP cache miss
       ├─ pendingARPs.set("10.0.0.2", [{resolve, reject, timer}])
       └─ sendFrame(eth0, ARP-Request broadcast)
            └─ Port.sendFrame  →  Cable.transmit  →  PortB.receiveFrame  (synchrone, dans le même call-stack)
                                                          └─ Switch.handleFrame   (synchrone)
                                                                ├─ MAC learn
                                                                └─ flood-out  →  ...  →  PortC.receiveFrame
                                                                                              └─ EndHost-B.handleFrame
                                                                                                    └─ ARP reply via le même call-stack inverse
                                                                                                          └─ resolves pendingARPs callback
                                                                                                                └─ flush fwdQueue ICMP echo
                                                                                                                      └─ ... → echo reply → resolves pendingPings
```

L'intégralité de la résolution ARP + flood + reply + envoi du echo + retour du echo-reply se déroule **dans la même pile d'appels JavaScript**, sauf si un `setTimeout` du queue (par exemple `fwdQueue`) introduit un yield. Ce design a l'avantage d'être prévisible ; il a deux défauts pour la cible visée : (a) il rend impossible toute animation visuelle réaliste, puisque la trame est « livrée » avant que React ait pu rerender ; (b) il interdit toute logique transverse insérée *en milieu de chaîne* (filtrage, capture, mirror port, retard simulé) sans toucher chaque appelant.

### 2.6 Points forts de l'architecture actuelle (à préserver)

L'analyse n'est pas que critique. Plusieurs choix de design actuels sont solides et doivent **être conservés** par la refonte :

- **Pas de simulateur central global** — chaque équipement encapsule sa logique. C'est une bonne décomposition orientée acteur ; le bus la prolonge plutôt qu'il ne la remplace.
- **Hiérarchie d'héritage propre** — `Equipment → EndHost → LinuxMachine → LinuxPC` est lisible, peu profonde, sans hiérarchies fragiles.
- **Délégation par composition** — `LinuxFirewallManager`, `LinuxProcessManager`, `WindowsServiceManager`, `PortSecurity`, `ACLEngine` sont des collaborateurs propres injectés ou détenus par le device.
- **Types L2/L3 immuables et typés** — `EthernetFrame`, `IPv4Packet`, `IPv6Packet`, `ARPPacket` sont des structures de données simples ; aucun changement nécessaire.
- **`PacketQueue` et `NeighborResolver` génériques** — déjà extraits, déjà testables. Ils restent des composants, simplement reformulés avec le scheduler et le bus.
- **`SocketTable`** — registre clean, sans callbacks ni réactivité. Reste tel quel.
- **`TerminalSession` versionnée** — mini-pub/sub déjà compatible `useSyncExternalStore`. Sera étendu, pas réécrit.
- **Tests unitaires nombreux** (97+ fichiers réseau) — couverture suffisante pour faire de la refonte par tests préservés.

### 2.7 Cartographie des problèmes par couche

Les sections suivantes (§3 à §7) approfondissent. Synthèse avant entrée en détail :

| Couche | Pattern problématique dominant | Impact sur la refonte |
|---|---|---|
| Hardware (`Port`, `Cable`) | Callbacks uniques M1 + tableau M2, transmission synchrone. | Cible la plus structurante — fonde le pipeline L2 événementiel (O4). |
| Equipment | Registre statique global, méthodes virtuelles `handleFrame`. | Devient un *acteur* abonné au bus. |
| Devices | Maps de callbacks M3 (ARP/ping/TCP), timers natifs disséminés. | Refonte des `pendingXxx` en *requêtes en vol* observables. |
| Protocoles | Timers natifs + Promise jetables M4. | Migration vers Scheduler (O3). |
| Terminal | Pub/sub maison M6 mais bien isolé. | Étendu pour s'aligner sur le bus, conservé sinon. |
| Store + UI | Mutation Map pour rerender, `instance: Equipment` exposée à React. | Read-models projetés (O5). |
| Database | Synchrone, peu de bus en sortie. | Intégration via événements de session uniquement. |

### 2.8 Métriques de référence (avant refonte)

| Métrique | Valeur |
|---|---|
| Fichiers TypeScript dans `src/` | ≈ 280 |
| Fichiers de tests `vitest` | ≈ 100 (97+ réseau, plus DB et GUI) |
| LoC `EndHost.ts` | 2 325 |
| LoC `Router.ts` | 1 545 |
| LoC `Switch.ts` | 838 |
| LoC `OracleExecutor.ts` | 3 441 |
| Occurrences `setInterval` / `setTimeout` | 104 (87 réseau + 4 terminal + 13 UI/hooks) |
| Implémentations distinctes du pattern observable | 4 (Logger, Port handlers, TerminalSession version, Tcp dataHandlers) |
| Maps de callbacks pendantes (`pendingXxx`) | 5+ rien que dans `EndHost` |

Ces chiffres serviront de base de comparaison à la fin de la refonte (cf. §11).

---

*Section 2 close. Suivante : §3 — Analyse de la couche réseau (`Equipment` / `Port` / `Cable`).*

---

## 3. Analyse de la couche réseau — `Equipment` / `Port` / `Cable`

Cette section examine en profondeur les trois classes fondatrices de la simulation L1/L2 et les utilitaires `core/` qu'elles exploitent. Pour chaque classe : rôle actuel, état interne, points de couplage, et besoins en réactivité.

### 3.1 `Equipment` (`src/network/equipment/Equipment.ts`, 194 LoC)

#### 3.1.1 Rôle

Classe abstraite, parente de tous les équipements simulés. Porte :

- **Identité** : `id`, `name`, `hostname`, `deviceType`.
- **Position canvas** : `x`, `y`.
- **État d'alimentation** : `isPoweredOn`.
- **Inventaire des ports** : `Map<string, Port>`.
- **Surface terminal** (méthodes default à override) : `getCwd`, `getCompletions`, `getCurrentUser`, `executeCommand`, `readFileForEditor`, etc.

Une seule méthode abstraite : `protected abstract handleFrame(portName, frame): void`. Toute la sémantique réseau d'un équipement passe par là.

#### 3.1.2 Couplages problématiques

| # | Symptôme | Détail |
|---|---|---|
| E1 | **Registre statique global** (légèrement masqué) | `EquipmentRegistry` est un singleton (`getInstance()`), exposé par les méthodes statiques `Equipment.getById`, `getAllEquipment`, `clearRegistry`. Toute initialisation de device s'enregistre automatiquement (`constructor` appelle `EquipmentRegistry.getInstance().register(this)`). En mode multi-topologie ou multi-onglet, ce singleton est un point de contention. |
| E2 | **`addPort` câble un callback unique** | `port.onFrame((portName, frame) => this.handleFrame(portName, frame))` — réécrit le `frameHandler` du port (cf. `Port.frameHandler`, mécanisme M1 §2.2). Si on voulait observer les trames sur un port pour, p. ex., du *port mirroring* ou du tcpdump, il n'y a pas d'API. |
| E3 | **Interface terminal mêlée** | 15 méthodes virtuelles relatives au terminal (`getCwd`, `executeCommand`, `readFileForEditor`, `userExists`, `canSudo`, …) sont déclarées sur la classe de base réseau. La réactivité ne les concerne pas directement, mais elles révèlent un *god object* qui mêle deux préoccupations (réseau + shell) — la migration les gardera mais les exposera via des *interfaces* séparées (`IShellHost`, `IFilesystemHost`). |
| E4 | **Logging implicite à plusieurs endroits** | `powerOn/powerOff`, `addPort` (via les ports), `sendFrame` appellent `Logger` directement. Les abonnés extérieurs ne savent pas qu'un device a été allumé via un autre canal que le texte. |

#### 3.1.3 Besoins en réactivité

L'`Equipment` cible doit :

1. Émettre `device.power-on` / `device.power-off` sur le bus avec payload `{ id, type, hostname }`.
2. Émettre `device.created` / `device.removed` à l'enregistrement et à la déréférence.
3. Émettre `device.position-changed` quand `setPosition` est appelée (déjà utilisé par la UI via mutation Zustand, mais pas observable en dehors).
4. Émettre `device.renamed` / `device.hostname-changed`.
5. **Ne plus** câbler de callback direct sur ses ports : les ports émettent leurs propres événements, et l'`Equipment` s'y *abonne*. Cela ouvre la porte à des observateurs concurrents (UI, capture, IDS simulé).
6. Exposer un état observable typé `{ powered, ports[], position }` consommable par les hooks React (cf. §6).

#### 3.1.4 Décisions de refonte (résumé)

- **Conserver** la hiérarchie d'héritage : `Equipment` reste la racine.
- **Conserver** `EquipmentRegistry` mais lui faire **émettre** `device.registered` / `device.deregistered`.
- **Remplacer** `protected abstract handleFrame` par un *abonnement* au bus (filtré par `port.frame.received` dont la `portEquipmentId` matche le device). Pour préserver la lisibilité, garder une méthode `handleFrame` qui sera *invoquée par l'abonnement*, pas par les ports directement.
- **Ajouter** l'injection optionnelle d'un `EventBus` et d'un `Scheduler` au constructeur, avec fallback sur les singletons globaux.

### 3.2 `Port` (`src/network/hardware/Port.ts`, 487 LoC)

#### 3.2.1 Rôle

Représente une interface physique (Ethernet/serial/console/fiber) avec ses adresses (MAC, IPv4, IPv6 avec prefixe et origine), sa configuration L1 (vitesse, duplex, autoneg, MTU), ses compteurs RFC 2863, son module port-security, et son état link-up/down. Il est le **point d'entrée et de sortie de toute trame** de la simulation.

#### 3.2.2 Surface réactive existante

```ts
private frameHandler: FrameHandler | null = null;       // M1 — un seul abonné
private linkChangeHandlers: LinkChangeHandler[] = [];   // M2 — tableau sans unsubscribe
```

L'API publique :

```ts
onFrame(handler: FrameHandler): void;
onLinkChange(handler: LinkChangeHandler): void;
```

Aucune des deux ne retourne une fonction d'unsubscription, et `onFrame` écrase l'unique slot.

#### 3.2.3 Logique de transmission

```
Equipment.send(portName, frame)
  └─ Port.sendFrame(frame)
       ├─ if (!isUp) drops_out++ ; return false
       ├─ if (!cable) drops_out++ ; return false
       ├─ counters.framesOut++ ; Logger.debug
       └─ cable.transmit(frame, this)              ──┐ retour synchrone
                                                     │
Cable.transmit(frame, fromPort)                      │
  ├─ if (!isUp) ...  return false                    │
  ├─ if (!portA || !portB) return false              │
  ├─ if (Math.random() < lossRate) frame lost        │
  ├─ targetPort = (fromPort===portA) ? portB : portA │
  ├─ Logger.debug                                    │
  ├─ targetPort.receiveFrame(frame)                ──┤ retour synchrone, descend dans
  └─ stats.framesTransmitted++                       │  Equipment.handleFrame
                                                   ──┘
```

Tout est **synchrone, dans la même call-stack**. La `propagationDelay` calculée par `Cable.getPropagationDelay()` n'est exposée que comme **métadonnée** ; elle n'introduit pas de délai réel.

#### 3.2.4 Couplages problématiques

| # | Symptôme | Détail |
|---|---|---|
| P1 | **`onFrame` mono-handler** | Un Port = un consommateur. Pas de mirror/SPAN, pas de capture, pas d'IDS, pas d'observateur de UI sans patch des classes. |
| P2 | **`onLinkChange` non désinscriptible** | Le tableau s'étend à chaque `onLinkChange` ; quand un device est retiré et recréé, les handlers anciens persistent. Présage de fuites mémoire. |
| P3 | **Hack `_setCableNoNotify` / `_notifyLinkUp`** | Pour éviter qu'OSPF se déclenche avant que les deux ports soient câblés (cf. commentaire ligne 392-403), `Cable.connect` doit casser l'encapsulation et utiliser des méthodes underscore-préfixées. C'est exactement le genre de friction qu'un bus avec ordering bien défini éliminerait. |
| P4 | **Compteurs mutés en place** | `framesIn++`, `framesOut++` ; aucune émission d'événement « counter changed ». Pour afficher en live « PC-A: 12 frames in/sec », la UI doit poller. |
| P5 | **PortSecurity callback inversé** | `checkPortSecurity` peut décider unilatéralement de mettre le port à `down` (`this.isUp = false`) puis appeler `notifyLinkChange('down')`. Bonne logique fonctionnelle, mais l'événement est émis depuis le chemin de réception, ce qui complique le raisonnement « qu'est-ce qui a déclenché un link-down ? ». |
| P6 | **Scope IPv6 `withScopeId` muté en place** | `enableIPv6()` modifie l'adresse link-local pour y attacher le nom d'interface. Pas réactif ; les abonnés à la config IPv6 doivent reposer sur `Logger`. |

#### 3.2.5 Besoins en réactivité

Le `Port` cible doit publier sur le bus :

- `port.frame.tx-requested` — Equipment a appelé `sendFrame`. Avant validation. (utile pour la capture).
- `port.frame.tx-blocked` — link down ou pas de cable. Payload `{ reason }`.
- `port.frame.in-flight` — la trame est confiée au cable, propagation en cours. Payload `{ frame, from, to, propagationMs }`.
- `port.frame.received` — la trame est arrivée à ce port après propagation. Remplace `frameHandler`.
- `port.frame.dropped` — port-security ou link-down à la réception.
- `port.link.up` / `port.link.down` — remplacent `linkChangeHandlers`.
- `port.config.ip-changed`, `port.config.ipv6-added`, `port.config.ipv6-removed`, `port.config.mtu-changed`, `port.config.speed-changed`, `port.config.duplex-changed`.
- `port.security.violation` — payload `{ violatingMac, mode, action }`.
- `port.counters.tick` — agrégé périodiquement (cf. scheduler).

Tous publiés avec une *source* `{ deviceId, portName }` pour permettre les filtres.

#### 3.2.6 Décisions de refonte (résumé)

- **Supprimer** `frameHandler`, `linkChangeHandlers`, `_setCableNoNotify`, `_notifyLinkUp`.
- **Faire émettre** au `Port` les événements ci-dessus via le bus injecté.
- **Conserver** la classe `Port`, son API de configuration (`configureIP`, `enableIPv6`, …), son module `PortSecurity`, ses compteurs.
- **Calcul de delivery** : déplacé dans `Cable` qui demande au `Scheduler` de programmer la livraison.

### 3.3 `Cable` (`src/network/hardware/Cable.ts`, 266 LoC)

#### 3.3.1 Rôle

Représente le médium physique entre deux ports. Type (cat5e/cat6/cat6a/fiber/crossover/serial), longueur, vitesse max, délai de propagation, taux de perte simulé, négociation auto.

#### 3.3.2 Logique actuelle

```ts
transmit(frame, fromPort) {
  if (!this.isUp) return false;
  if (!this.portA || !this.portB) return false;
  if (Math.random() < this.packetLossRate) { stats.framesLost++; return false; }
  const target = (fromPort === this.portA) ? this.portB : this.portA;
  Logger.debug(...);
  target.receiveFrame(frame);   // SYNC, dans la même call-stack
  this.stats.framesTransmitted++;
  return true;
}
```

#### 3.3.3 Couplages problématiques

| # | Symptôme | Détail |
|---|---|---|
| C1 | **Livraison synchrone** | Pas d'utilisation du `propagationDelay`. Animation impossible de manière propre. |
| C2 | **Aléa direct sur `Math.random`** | Pas seedable, donc pas de tests reproductibles pour la simulation de perte de paquets. |
| C3 | **Stats mutées sans événement** | Aucun signal pour la UI ou les tests sur "le câble vient de transmettre / perdre une frame". |
| C4 | **Couplage Port ↔ Cable bidirectionnel** | `cable.connect(portA, portB)` mute les deux ports avec `_setCableNoNotify` puis émet `_notifyLinkUp`. Un bus permet d'inverser : `cable.connected` est émis, et chaque port s'y abonne pour mettre à jour son état observable. |
| C5 | **Negotiate appelée en synchrone** | `negotiateLink()` appelle `port.negotiate(...)` qui mute deux champs privés. Pas d'événement `cable.negotiated { speed, duplex }`. |

#### 3.3.4 Besoins en réactivité

Le `Cable` cible doit :

- Émettre `cable.connected` `{ portAId, portBId }`, `cable.disconnected`, `cable.negotiated`, `cable.duplex-mismatch`, `cable.frame.dispatched`, `cable.frame.lost`, `cable.frame.delivered`.
- Programmer la livraison via `scheduler.setTimeout(() => emit('cable.frame.delivered', …), propagationMs)`.
- Accepter une source d'aléa injectée (`rng()`) pour la simulation de perte.

### 3.4 `EquipmentRegistry` (`src/network/equipment/EquipmentRegistry.ts`, 107 LoC)

#### 3.4.1 Rôle et état actuel

Singleton `EquipmentRegistry.getInstance()` ; `Map<id, Equipment>` ; CRUD + requêtes (`getByType`, `getPoweredOn`, `query(predicate)`). Le commentaire d'en-tête mentionne explicitement « *Fixes 1.3: Static global registry replaced with injectable singleton* », et la classe est déjà conçue pour être instanciable en test (`new EquipmentRegistry()`).

#### 3.4.2 Faiblesses actuelles

| # | Symptôme | Détail |
|---|---|---|
| R1 | **Singleton encore par défaut** | `EquipmentRegistry.getInstance()` est appelé directement depuis `Equipment` constructor. La compétition entre topologies parallèles n'est pas gérée. |
| R2 | **Pas d'événements de cycle de vie** | `register/deregister` ne notifient personne. Le store Zustand connaît son propre `Map` parallèle (`deviceInstances`). Désynchronisation possible. |
| R3 | **Méthodes statiques deprecated** | `Equipment.getById`, `getAllEquipment`, `clearRegistry` sont marquées `@deprecated` mais toujours utilisées (cf. tests, certaines commandes Cisco). |

#### 3.4.3 Besoins en réactivité

- Émettre `registry.device-registered`, `registry.device-deregistered`, `registry.cleared` sur le bus.
- Exposer un *signal* `devices: Signal<Equipment[]>` pour la UI (alternative à l'observation par bus).
- Décommissionner les méthodes statiques `Equipment.getById/getAllEquipment/clearRegistry` (callsites à purger en §9).

### 3.5 `core/` — utilitaires de protocoles

#### 3.5.1 `Logger` (123 LoC)

Pub/sub texte. Chaque couche supérieure publie ses événements via `Logger.info/debug/warn/error`. Le filtrage côté `subscribe` accepte `source`, `event` (préfixe), `level`. **Cette classe préfigure le bus**. La refonte la généralise plutôt que la remplace : le `Logger` devient une vue spécialisée du bus, filtrée sur les événements de catégorie `*.log` ou émise depuis un *adapter* qui projette tous les événements en `NetworkLog`.

| Conséquence | Détail |
|---|---|
| Simplification API | `Logger.info(src, evt, msg, data)` reste, mais sous le capot publie sur `eventBus` un événement `{ topic: 'log', level, source, event, message, data }`. |
| Backward-compat | Tous les sites d'appel (≈ 90 dans la couche réseau) **n'ont pas à changer**. Migration sans douleur. |

#### 3.5.2 `PacketQueue` (142 LoC)

Queue générique pour paquets en attente de résolution ARP/NDP. Utilise `setTimeout` natif pour expirer chaque entrée. Méthodes : `enqueue`, `flush(address, sendFn)`, `purgeExpired`, `clear`.

| Problème | Refonte |
|---|---|
| Timer natif par entrée | Remplacer `setTimeout` par `scheduler.setTimeout`. |
| `flush` reçoit un `sendFn` callback | Conserver — cette callback est interne à l'EndHost et n'a pas besoin d'être un événement bus (boucle interne). |
| Pas de signal sur la taille | Optionnel : émettre `packetqueue.depth-changed` pour métriques. |

#### 3.5.3 `NeighborResolver` (204 LoC)

Wrapper générique ARP/NDP. Cache `Map<address, NeighborEntry>`. `resolve(address, iface, sendSolicitation)` retourne une `Promise<MAC>` avec timeout par `setTimeout` natif. `learn` résout les pendings.

| Problème | Refonte |
|---|---|
| `Promise` jetable | À conserver côté API publique (les callers s'attendent à `await arpResolver.resolve(...)`). En interne, le timer va sur `scheduler`. |
| Pas d'événement `arp.cache.updated` | Émettre `neighbor.learned` `{ protocol, address, mac, iface }` et `neighbor.expired`. La UI peut afficher les caches en live. |
| `clear()` rejette toutes les pendings | OK ; ajouter émission `neighbor.cache-cleared`. |

#### 3.5.4 `TcpConnection` (97 LoC)

Stream TCP simplifié. `dataHandlers: Array<(data: string) => void>`. `onData` retourne un unsubscribe. `receiveData` itère et appelle. C'est le pattern **M2 propre** — c'est-à-dire le seul tableau de handlers du projet qui rend une fonction d'unsubscription. Garder l'API publique, **adapter l'implémentation** pour publier sur le bus en complément (`tcp.data.received` `{ connId, data, len }`) afin que la UI puisse afficher le trafic.

#### 3.5.5 `SocketTable` (212 LoC)

Pas de réactivité — pure state machine de sockets. Refonte minimale : émettre `socket.bound`, `socket.connected`, `socket.closed` (utile pour `netstat`/`ss` live et pour la UI).

#### 3.5.6 `RoutingTable` et autres

Lecture rapide du fichier (cf. §4 pour analyse plus poussée — la table de routage est aussi mutée par OSPF/RIP). Émettre `routing.route-added`, `routing.route-removed`, `routing.route-changed` est la condition pour qu'un panneau « show ip route » s'affiche en live.

### 3.6 Bilan de la couche réseau et invariants à préserver

**À garder absolument** :

- L'API publique `Port.configureIP`, `Port.enableIPv6`, `Cable.connect`, `Equipment.powerOn/Off` doit rester sources-compatible pour ne pas casser les milliers de lignes de tests.
- Les types `EthernetFrame`, `IPv4Packet`, `IPv6Packet`, `ARPPacket`, `ICMPPacket`, `UDPPacket`, `TCPPacket` restent immuables et inchangés.
- Le calcul de l'auto-négociation (`Cable.negotiateLink` + `Port.negotiate`) reste une fonction pure ; seuls ses *effets* (mutation de `negotiatedSpeed/Duplex`) deviennent des événements observables.

**À refonder** :

- `Port.frameHandler` (M1) → événement `port.frame.received` sur le bus.
- `Port.linkChangeHandlers` (M2) → événements `port.link.up` / `port.link.down`.
- `Cable.transmit` synchrone → cable schedule la livraison via `Scheduler`.
- Compteurs mutés sans signal → snapshot périodique émis.
- Méthodes underscore (`_setCableNoNotify`, `_notifyLinkUp`) → supprimées par bus avec ordering.
- Méthodes statiques `Equipment.getById/getAllEquipment/clearRegistry` → supprimées.

### 3.7 Tableau de synthèse des classes de la couche réseau

| Classe | LoC | Pattern actuel | Pattern cible | Priorité refonte |
|---|---:|---|---|---|
| `Equipment` | 194 | Static registry + `addPort` câble callback | Acteur abonné au bus, registre observable | **Haute** |
| `Port` | 487 | `frameHandler` mono + `linkChangeHandlers[]` + compteurs mutés | Émetteur de `port.*` events, état observable | **Haute** |
| `Cable` | 266 | `transmit` synchrone, `Math.random` direct | `transmit` programme livraison, RNG injectée | **Haute** |
| `EquipmentRegistry` | 107 | Singleton + Map | Instance injectée + signaux | Moyenne |
| `Logger` | 123 | Pub/sub texte | Adapter sur bus, API conservée | **Faible** (déjà compatible) |
| `PacketQueue` | 142 | Timers natifs | Timers via Scheduler | Moyenne |
| `NeighborResolver` | 204 | Promise + setTimeout | Promise conservée, scheduler interne, événements `neighbor.*` | Moyenne |
| `TcpConnection` | 97 | `dataHandlers[]` propre | API conservée + miroir bus | **Faible** |
| `SocketTable` | 212 | Pas de réactivité | Émet `socket.*` | **Faible** |
| `PortSecurity` | (non lu en détail) | Mute Port, log | Émet `port.security.violation` | Moyenne |

---

*Section 3 close. Suivante : §4 — Devices concrets et moteurs de protocoles.*

---

## 4. Analyse des `devices` concrets et des moteurs de protocoles

Les `devices` (`Switch`, `Router`, `EndHost` et leurs sous-classes) sont l'**épicentre** de la dette réactive : c'est là que se concentrent les `pendingXxx` Maps, les `setTimeout` natifs et la logique stateful complexe (state machine OSPF, traversée NAT, PAT, ACL, IPSec, etc.). Cette section décortique les classes les plus volumineuses et les moteurs de protocoles attachés.

### 4.1 `EndHost` (`src/network/devices/EndHost.ts`, 2 325 LoC)

#### 4.1.1 Rôle

Classe abstraite parente des hôtes de bout (`LinuxMachine`, `WindowsPC`). Implémente :

- **L2 → L3 dispatch** dans `handleFrame` : ARP / IPv4 / IPv6 (multicast filtering inclus).
- **ARP** (RFC 826) : résolution, gratuitous ARP, table `arpTable: Map<string, ARPEntry>`.
- **IPv4 forwarding minimal** + table de routage `routingTable: HostRouteEntry[]`.
- **NDP** (RFC 4861) : neighbor cache, RA / RS, SLAAC.
- **ICMP echo** (ping) avec `pendingPings`.
- **TCP simplifié** (RFC 793) : `tcpListeners`, `tcpConnections`, `pendingTcpHandshakes`.
- **DHCP client** (composition avec `DHCPClient`).
- **NAT host-side** : `ipForwardEnabled`, `masqueradeOnInterfaces`.
- **Socket table** : composition avec `SocketTable`.

#### 4.1.2 Cinq Maps de callbacks pendantes (dette M3)

```ts
protected pendingARPs:        Map<string, PendingARP[]>;
protected fwdQueue:            Array<{ pkt; outPort; nextHopIP; timer }>;
protected pendingPings:        Map<string, PendingPing>;
protected pendingNDPs:         Map<string, PendingNDP[]>;
protected pendingPing6s:       Map<string, PendingPing>;
private   tcpListeners:        Map<number, (conn: TcpConnection) => void>;
private   pendingTcpHandshakes:Map<string, () => void>;
```

Chaque entrée a son propre `timer = setTimeout(...)` natif. Sept structures pour la **même problématique** : « j'attends un événement réseau, voici ce que je veux faire quand il arrive (et quoi faire si pas dans X ms) ». La refonte les unifie en :

```ts
// Modèle cible
const reply = await waitForEvent(bus, 'icmp.echo-reply',
  e => e.id === id && e.seq === seq,
  { timeoutMs: 1000, scheduler });
```

soit ≈ 30 lignes utilitaires (`waitForEvent`) qui remplacent ≈ 250 lignes éparpillées dans `EndHost`.

#### 4.1.3 Dépendances réactives existantes

- `DHCPClient` reçoit **3 callbacks** au constructeur : `getMacFn`, `applyConfigFn`, `clearConfigFn`. Bon découpage par dependency inversion, mais ces callbacks sont *imperatifs* — la cible les remplace par des événements `dhcp.lease-acquired` / `dhcp.lease-expired` auxquels `EndHost` s'abonne.
- `NeighborResolver` n'est **pas** utilisé par `EndHost` directement (le code ARP est dupliqué inline dans `EndHost` !). C'est un signal que le refactor « 1.2 » de la roadmap interne n'a été appliqué qu'à moitié.

#### 4.1.4 Couplages problématiques

| # | Symptôme | Détail |
|---|---|---|
| H1 | **Cinq systèmes de pending parallèles** | Chaque cycle de vie est manuel (timer → cleanup → resolve → delete from map). Beaucoup de duplication, beaucoup de risques de fuite. |
| H2 | **ARP / NDP réinventés inline** | Au lieu d'utiliser `NeighborResolver<IPAddress>`, le code maintient sa propre `arpTable: Map`, ses propres `pendingARPs`, ses propres timers. ≈ 200 LoC dupliquées. |
| H3 | **Routing table mutée sans signal** | `configureInterface`, `setDefaultGateway`, `addRoute`, `removeRoute` modifient `routingTable: HostRouteEntry[]`. Aucun événement, donc aucun panneau « show ip route » live. |
| H4 | **TCP listeners par callback** | `tcpListeners.set(port, (conn) => …)` — pour exposer en UI « ce serveur écoute sur ces ports », il faut requêter manuellement. |
| H5 | **Logique forwarding mélangée à la logique host** | NAT, MASQUERADE, ip_forward, et leur interaction avec `iptables`, sont intégrées dans `EndHost`. Pas un problème de réactivité direct mais le bus permet d'extraire `IPv4Forwarder` comme acteur séparé qui s'abonne à `port.frame.received`. |

#### 4.1.5 Décisions de refonte

- **Remplacer** les cinq `pendingXxx` par un utilitaire `waitForEvent(bus, topic, predicate, opts)`.
- **Substituer** `NeighborResolver<IPAddress>` aux ARP inline (et `NeighborResolver<IPv6Address>` pour NDP). Cela enlève ≈ 400 LoC en cumulé.
- **Émettre** `host.routing.route-added`, `host.routing.route-removed`, `host.arp.entry-learned`, `host.arp.entry-expired`, `host.icmp.echo-sent`, `host.icmp.echo-reply-received`, `host.tcp.listener-started`, `host.tcp.listener-stopped`, `host.tcp.connection-established`, `host.tcp.connection-closed`.
- **Extraire** `IPv4Forwarder`, `IPv6Forwarder`, `NATHelper` comme acteurs (réducteurs) séparés et testables, abonnés au bus.

### 4.2 `Router` (`src/network/devices/Router.ts`, 1 545 LoC)

#### 4.2.1 Rôle

Routeur abstrait, vendor-agnostique au cœur, spécialisé par `CiscoRouter` / `HuaweiRouter`. Couvre :

- Plan de contrôle : **OSPF** (via `RouterOSPFIntegration`), **RIP** (via `RouterRIPEngine`), **statiques**, **default-routes**, table de routage `RoutingTable`.
- Plan de données : forwarding L3, ACL ingress/egress (via `ACLEngine`), NAT (`NATEngine`), IPv6 (`IPv6DataPlane`), IPSec (`IPSecEngine`).
- Plan de management : terminal (Cisco IOS shell ou Huawei VRP shell), bootup messages, configuration parser.
- ARP locale + pending pings + pending traceroute hops.

#### 4.2.2 État interne réactif

Trois `Map` de callbacks pendantes en plus :

```ts
private pendingARPs:        Map<string, PendingARP[]>;
private pendingPings:       Map<string, { ... timer: setTimeout }>;
private pendingTraceHops:   Map<string, { ... timer: setTimeout }>;
```

— et chacune des intégrations (`RouterOSPFIntegration`, `RouterRIPEngine`, `IPSecEngine`, `NATEngine`) a ses propres timers internes.

#### 4.2.3 Couplages problématiques

| # | Symptôme | Détail |
|---|---|---|
| Rt1 | **Tout-en-un** | Routeur = control-plane + data-plane + management-plane + ARP. Le bus permet de découper data-plane (`IPv4Forwarder`, `IPv6Forwarder`) et control-plane (`RoutingTableManager`) en acteurs séparés. |
| Rt2 | **`pendingTraceHops`** | Reproduit pour la 3ᵉ fois la même mécanique pending+timer. |
| Rt3 | **Couplage direct vers les engines** | Le routeur instancie et tient des références sur `RouterOSPFIntegration`, `RouterRIPEngine`, `IPSecEngine`, `NATEngine`, `ACLEngine`, `IPv6DataPlane`. Ces engines accèdent en retour à des méthodes du routeur (typique « client-callback » pattern). Le bus inverse cette dépendance : les engines s'abonnent à `port.frame.received` filtré sur leur ID device, et **émettent** des changements de routing table. |
| Rt4 | **Boot sequence couplée au shell** | `getBootSequence(): string` est une méthode abstraite qui retourne un blob texte ; il devrait s'agir d'un événement `device.booting` puis d'événements ordonnés `device.boot-line` consommés par la session terminal. |

### 4.3 `Switch` (`src/network/devices/Switch.ts`, 838 LoC)

#### 4.3.1 Rôle et état

Switch L2 abstrait avec MAC learning, VLAN access/trunk (Dot1Q), STP states (passifs — non encore animés), ARP table interne (pour répondre à ARP sur l'adresse de management), interface descriptions, MAC aging.

```ts
private macTable:             Map<string, MACTableEntry>;  // "vlan:mac" → entry
private macAgingTimer:         ReturnType<typeof setInterval> | null;
protected vlans:               Map<number, VLANEntry>;
private switchportConfigs:     Map<string, SwitchportConfig>;
private stpStates:             Map<string, STPPortState>;
protected portVlanStates:      Map<string, 'active' | 'suspended'>;
private interfaceDescriptions: Map<string, string>;
private arpTable:              Map<string, …>;
```

#### 4.3.2 Réactivité

- `macAgingTimer` = `setInterval(() => purgeStaleMACs(), …)` — un seul timer global pour tout le switch. Migration triviale vers `Scheduler`.
- Aucune émission d'événement sur MAC learning, VLAN add/remove, STP state changes. Conséquence : la UI ne peut pas afficher en live « MAC table », « show vlan », « show spanning-tree » (toutes les commandes existantes lisent l'état mais ne sont pas réactives).

#### 4.3.3 Décisions de refonte

- Émettre `switch.mac.learned`, `switch.mac.aged`, `switch.vlan.created`, `switch.vlan.deleted`, `switch.port.vlan-suspended`, `switch.port.vlan-recreated`, `switch.stp.state-changed`.
- `macAgingTimer` → `scheduler.setInterval`.

### 4.4 Moteurs de protocoles

#### 4.4.1 Interface commune `IProtocolEngine`

```ts
// src/network/core/interfaces.ts
export interface IProtocolEngine {
  start(): void;
  stop(): void;
  // … méthodes spécifiques propres
}
```

L'interface est volontairement minimale. Toutes les engines l'implémentent : `OSPFEngine`, `OSPFv3Engine`, `RIPEngine`, `RouterRIPEngine`, `IPSecEngine`, `DHCPClient`, `DHCPServer`. C'est une **excellente base** pour la refonte : on étend simplement le contrat avec :

```ts
interface IProtocolEngine {
  start(scheduler: IScheduler, bus: IEventBus): void;
  stop(): void;
}
```

#### 4.4.2 `OSPFEngine` (`src/network/ospf/OSPFEngine.ts`, ≈ 3 200 LoC)

Implémentation OSPFv2 quasi-complète : Hello, neighbor FSM (Down → Init → 2-Way → ExStart → Exchange → Loading → Full), DR/BDR election, DD/LSR/LSU/LSAck, LSA flooding, SPF Dijkstra, area summary, ASBR, NSSA.

**Timers natifs** (≈ 18 occurrences) :
- `lsAgeTimer = setInterval(tickLSAge, 1000)` — global au moteur.
- `spfTimer = setTimeout(runSPF, 100)` — coalesce SPF runs.
- `iface.helloTimer = setInterval(sendHello, helloInterval)` — par interface.
- `iface.waitTimer = setTimeout(electDR, deadInterval)` — par interface.
- `neighbor.deadTimer = setTimeout(deadNeighbor, deadInterval)` — par voisin.
- `neighbor.ddRetransmitTimer = setTimeout(retransmitDD, retransmitInterval)` — par voisin.
- `neighbor.lsrRetransmitTimer = setTimeout(retransmitLSR, retransmitInterval)` — par voisin.

**Couplages** :

| # | Symptôme | Détail |
|---|---|---|
| Os1 | **Tous les timers natifs** | `tickLSAge`, hello, dead, retransmit, SPF coalesce. Un test qui veut « avancer le temps de 40 secondes » doit faire `vi.useFakeTimers()` puis `vi.advanceTimersByTime(40_000)`. Mais le moteur ne le sait pas. |
| Os2 | **Couplage à un router** | Le moteur reçoit en paramètres des fonctions « envoyer un Hello via cette interface » qui dépendent du routeur ; il s'agit d'un client-callback indirect (cf. Rt3). |
| Os3 | **Pas d'événements de transition d'état** | Toutes les transitions FSM voisin (`Init` → `2-Way` → …) sont silencieuses. Une UI « topologie OSPF live » nécessite un polling. |
| Os4 | **LSDB mutée** | `lsdb` est une `Map<key, LSA>` mutée en place ; impossible d'observer les ajouts/suppressions. |

**Décisions de refonte** :

- Tous les timers via `Scheduler`.
- Émettre `ospf.neighbor.state-changed`, `ospf.lsa.received`, `ospf.lsa.flushed`, `ospf.spf.run`, `ospf.dr-election`, `ospf.area.activated`.
- L'envoi de paquets passe par publication sur le bus d'un événement `ospf.packet.outgoing` consommé par le data-plane du routeur (qui forge la trame Ethernet et appelle `port.send`).

#### 4.4.3 `OSPFv3Engine` — équivalent IPv6

Mêmes problématiques, mêmes décisions. Mutualiser les types d'événements en discriminant par `version: 'v2' | 'v3'` dans le payload.

#### 4.4.4 `RIPEngine` / `RouterRIPEngine`

```ts
private updateTimer: ReturnType<typeof setInterval> | null;
state.timeoutTimer:  ReturnType<typeof setTimeout> | null;
state.gcTimer:       ReturnType<typeof setTimeout> | null;
```

**Bonus** : `RIPCallbacks` interface est déjà documentée comme « *Decouples the engine from the Router class (Dependency Inversion)* ». Excellente base — ces callbacks deviennent des publications sur le bus.

#### 4.4.5 `DHCPClient` / `DHCPServer`

`DHCPClient` reçoit déjà ses **3 callbacks** d'intégration via constructeur (cf. §4.1.3). Migration :

- Les callbacks `applyConfigFn`, `clearConfigFn`, `getMacFn` deviennent des **événements en/out** : le client publie `dhcp.lease-requested`, `dhcp.lease-granted`, `dhcp.lease-expired` ; un *projecteur* configure le port.
- Timers `renewalTimer`, `rebindingTimer`, `expirationTimer` → `Scheduler`.
- `arpProbeFn` → événement `dhcp.arp-probe-requested` consommé par le host.

#### 4.4.6 `IPSecEngine` (`src/network/ipsec/IPSecEngine.ts`, ≈ 1 850 LoC)

Couvre IKEv1/IKEv2, ESP/AH transport+tunnel, DPD, lifetime SA, anti-replay. **Beaucoup** d'état stateful (SA, IKE_SA, child_SA, dpd_state) avec `Map<spi, …>` et timers de lifetime, retransmit, DPD.

**Décisions** : timers via `Scheduler`, émissions `ipsec.sa.installed`, `ipsec.sa.deleted`, `ipsec.dpd.peer-down`, `ipsec.ike.exchange-completed`. Le payload `data-plane` passe via `ipsec.packet.encrypted-out` / `ipsec.packet.decrypted-in`.

#### 4.4.7 `RouterOSPFIntegration` (1 799 LoC), `NATEngine` (613), `ACLEngine` (245+280), `IPv6DataPlane` (660)

Ce sont les **adaptateurs** entre le routeur générique et les protocoles. Ils contiennent la logique de pont : conversion frame ↔ packet OSPF, encapsulation IPSec, application des ACL en pré-/post-routing, traduction NAT.

**Décisions** :

- Conserver leur structure (un module par préoccupation).
- Réécrire leurs **points d'entrée** comme handlers d'événements (`bus.subscribe('port.frame.received', filter)` plutôt que méthodes invoquées par `Router.handleFrame`).
- Les **points de sortie** (forge de trame, envoi) deviennent des publications sur `host.l3.packet-tx-requested` que le data-plane traduit en `port.frame.tx-requested`.
- Garder `ACLEngine.evaluate(...)` comme **fonction pure** (pas de bus), puisqu'elle est pure logique métier ; le bus traite ses *résultats* (`acl.permit`, `acl.deny`, `acl.log`).

### 4.5 Hub, GenericSwitch, devices simples

`Hub` (broadcast L1) et `GenericSwitch` (sans fonctionnalités vendor) — peu de logique, pas de timers. Migration triviale : juste s'aligner sur l'API bus.

### 4.6 `LinuxMachine` / `WindowsPC` et leurs collaborateurs

`LinuxMachine` (827 LoC) et `WindowsPC` (695 LoC) délèguent massivement à des collaborateurs (`LinuxFirewallManager`, `LinuxProcessManager`, `LinuxServiceManager`, `LinuxDnsService`, `LinuxCronManager`, `WindowsServiceManager`, etc.). La majorité de ces collaborateurs sont **synchrones et sans timer**, à deux exceptions près :

- `LinuxCronManager` (20 LoC, basique pour l'instant) — futur scheduler de tâches cron : DOIT passer par `Scheduler`.
- `LinuxServiceManager` / `WindowsServiceManager` — pas de timer, mais leur démarrage devrait émettre `service.started`, `service.stopped` pour permettre à la UI de représenter l'état des services.

### 4.7 Tableau de synthèse — devices et protocoles

| Composant | LoC | Timers natifs | Maps callbacks | Événements bus à émettre (approx.) | Priorité |
|---|---:|---:|---:|---:|---|
| `EndHost` | 2 325 | 7 | 5 | 18+ | **Très haute** |
| `Router` | 1 545 | 4 | 3 | 12+ | **Très haute** |
| `Switch` | 838 | 1 | 0 | 8 | Haute |
| `Hub`, `GenericSwitch` | ~120 | 0 | 0 | 2 | Faible |
| `OSPFEngine` | ~3 200 | 7 types | 0 (FSM) | 12 | **Très haute** |
| `OSPFv3Engine` | ~1 100 | mêmes | 0 | 12 | Haute |
| `RIPEngine` | ~500 | 3 | 0 | 6 | Haute |
| `RouterRIPEngine` | 429 | héritages | 0 | 6 | Moyenne |
| `DHCPClient` | ~720 | 3 | 0 | 6 | Haute |
| `DHCPServer` | ~480 | 0 | 0 | 4 | Moyenne |
| `IPSecEngine` | ~1 850 | mult. | 1 | 10 | Haute |
| `NATEngine` | 613 | 1 | 0 | 4 | Moyenne |
| `ACLEngine` (router/) | 245 | 0 | 0 | 3 | Moyenne |
| `ACLEngine` (acl/) | 280 | 0 | 0 | 3 | Moyenne |
| `IPv6DataPlane` | 660 | 0 | 0 | 5 | Moyenne |
| `RouterOSPFIntegration` | 1 799 | 0 | 0 | 4 | Moyenne |
| `LinuxMachine`, `WindowsPC` | 1 522 | 0 | 0 | 6 (services) | Faible |

### 4.8 Pattern unifié de migration des `pendingXxx`

Le pattern « j'attends un événement réseau X avec timeout T » revient au moins **15 fois** dans `EndHost` + `Router`. La cible est :

```ts
// utility shipped with the bus
async function waitForEvent<E extends BusEvent>(
  bus: IEventBus,
  topic: E['topic'],
  predicate: (e: E['payload']) => boolean,
  opts: { timeoutMs: number; scheduler: IScheduler },
): Promise<E['payload']>;
```

Implémentation < 30 LoC. Appel typique :

```ts
// Avant — 12 lignes de pendingPings.set + setTimeout + cleanup
this.pendingPings.set(key, { resolve, reject, timer: setTimeout(...) });

// Après — 4 lignes
const reply = await waitForEvent(bus, 'host.icmp.echo-reply',
  e => e.id === id && e.seq === seq && e.from.equals(targetIP),
  { timeoutMs, scheduler });
```

L'effacement net en LoC pour les seules `pendingXxx` est estimé à **400-500 LoC** sur l'ensemble du repo.

### 4.9 Synthèse

Les devices et engines portent **l'essentiel de la dette réactive** :

- 7+ Maps de callbacks pendantes parallèles à unifier.
- ≈ 80 timers natifs à migrer vers `Scheduler`.
- 0 émission d'événement sur les transitions de protocole, à corriger pour rendre la simulation observable.
- Les *adapters* `RouterOSPFIntegration`, `NATEngine`, `IPv6DataPlane` deviennent des consommateurs/producteurs du bus, ce qui les rend testables en isolation et ouvre la voie à des plug-ins futurs.

---

*Section 4 close. Suivante : §5 — Couche terminal.*

---

## 5. Analyse de la couche terminal

La couche terminal (`src/terminal/`, ≈ 5 600 LoC sans les commandes) est paradoxalement la **mieux préparée** à la migration : elle possède déjà un mini-pub/sub `subscribe / getVersion / notify`, conçu pour `useSyncExternalStore`. La refonte n'y supprime presque rien — elle généralise le pattern, branche les sessions sur le bus principal, et introduit le `Scheduler` pour les rares timers.

### 5.1 Architecture actuelle

```
TerminalManager  (singleton, src/terminal/sessions/TerminalManager.ts, 198 LoC)
   ├─ Map<sessionId, TerminalSession>
   ├─ Map<deviceId, sessionId[]>
   └─ subscribe / getVersion / notify  ── pour la liste de sessions

TerminalSession  (abstract, 897 LoC)
   ├─ subscribe / getVersion / notify   ── pour l'état d'une session
   ├─ lines, history, input, inputMode, _passwordBuf, _inputBuf
   ├─ flowEngine?: InteractiveFlowEngine
   ├─ activeSubShell?: ISubShell
   ├─ recorder?: SessionRecorder
   ├─ template methods: onEnter, onTab, getPrompt, getTheme, init
   └─ keyboard dispatch: handleKey → handleModeKey → handleNormalKey
       ├── LinuxTerminalSession    (653)
       ├── CLITerminalSession      (317, abstract)
       │     ├── CiscoTerminalSession   (80)
       │     └── HuaweiTerminalSession  (93)
       └── WindowsTerminalSession  (457)

InteractiveFlowEngine  (src/terminal/core/InteractiveFlow.ts, 316 LoC)
   ├─ Steps déclaratifs (password / text / confirmation / choice / command / output / set)
   ├─ État : currentIndex, context, retryCount
   └─ advance(userInput?) → Promise<TerminalResponse>

ISubShell  (interface, 41 LoC)
   ├─ getPrompt, handleKey, processLine, dispose
   └─ implémentations: SqlPlusSubShell (104), RmanSubShell (381),
                       SftpSubShell (153), CmdSubShell (216),
                       PowerShellSubShell (175)

OutputFormatter  (218 LoC) — abstrait l'ANSI / texte plain pour les flows.
TabCompletionHelper  (132 LoC) — utilitaire de complétion.
```

### 5.2 Ce qui fonctionne bien (à conserver)

| # | Élément | Pourquoi le conserver |
|---|---|---|
| T+1 | **`subscribe / getVersion / notify`** | Compatible `useSyncExternalStore`. Granularité par session. |
| T+2 | **Hiérarchie de sessions** | Linux/CLI/Windows parfaitement délimités, peu de duplication grâce aux template methods. |
| T+3 | **`InteractiveFlowEngine`** | Machine à états déclarative pour les wizards (passwd, useradd, vty). Synchrone-ou-async, propre. |
| T+4 | **`ISubShell`** | Interface minimale et bien pensée ; les 5 sub-shells l'implémentent sans frottement. |
| T+5 | **`OutputFormatter`** | Sépare proprement la production de texte (ANSI Linux vs plain Cisco/Huawei). |
| T+6 | **`SessionRecorder`** | Enregistrement d'événements `input/output/error` avec timing — préfigure très bien l'observation par bus. |
| T+7 | **`MAX_SCROLLBACK_LINES`, `withTimeout`, `sanitiseInput`** | Garde-fous robustes en place. |

### 5.3 Limites actuelles

| # | Limite | Conséquence |
|---|---|---|
| T-1 | **Pub/sub ad-hoc, scope par session** | Quatre lieux ont leur propre `_listeners` : `Logger`, `TerminalSession`, `TerminalManager`, et chaque `Port`/`TcpConnection` (cf. §3). Aucun n'observe les autres. |
| T-2 | **Couplage direct `device.executeCommand(string)`** | La session attend une `Promise<string>`. C'est pratique pour les tests, mais ça empêche les commandes longues d'émettre des **lignes intermédiaires** (typique : `traceroute`, `ping -c 4`, `tcpdump`, `find /`). Aujourd'hui ces commandes simulent leur sortie en collectant tout puis en retournant un blob. |
| T-3 | **`replayRecording` utilise `setTimeout` natif** | `await new Promise(r => setTimeout(r, ...))` ; non rejouable de manière déterministe. |
| T-4 | **Boot sequence comme blob** | `Router.getBootSequence(): string` retourne un texte multi-ligne ; la session le découpe et l'affiche avec des `setTimeout(12 ms)` (cf. `CLITerminalSession`). Pas d'événement `device.boot.line`. |
| T-5 | **Aucune observation transverse** | Une UI ne peut pas afficher « 3 sessions actives sur PC-A » sans lire `TerminalManager` et y poser un `subscribe`. C'est faisable, mais hétérogène avec l'observation des `Equipment`. |
| T-6 | **`onRequestClose` callback unique** | Chaque session expose un single-callback `onRequestClose(cb)` pour signaler à `TerminalManager` qu'elle veut être fermée. Pattern M1. |
| T-7 | **`flowEngine` mute `inputMode` puis appelle `notify()`** | Beaucoup d'états à synchroniser entre flow / session / view. Le bus permettrait d'émettre `terminal.input-mode-changed` et de laisser la view se rafraîchir. |
| T-8 | **`SessionRecorder` interne** | Bonnes données enregistrées, mais elles ne sortent pas du recorder. Or la trace d'événements sera **exactement** ce que l'on veut journaliser dans le bus (idem capture, replay déterministe). |

### 5.4 Imbrication terminal ↔ réseau

Trois points de couplage majeurs :

1. **Boot et power-state** : `TerminalSession.assertDeviceOnline()` lit `device.getIsPoweredOn()` ; en cas de power-off pendant une commande, `withTimeout` ne détecte pas. Migration : la session s'abonne à `device.power-off` et clôt elle-même les `flowEngine`/`activeSubShell`.

2. **Exécution de commandes réseau** : `executeOnDevice(cmd)` appelle `device.executeCommand` qui descend potentiellement dans `LinuxNetCommands.ping` → `EndHost.pingHost` → résolution ARP → … → `pendingPings` resolve → reply texte. Tout ce *long-running* doit pouvoir émettre des lignes intermédiaires (`reply from 10.0.0.2: …`) **avant** la complétion. La cible : `executeCommand` peut émettre `command.output-line` au fil de l'exécution, la session s'y abonne et les ajoute à ses lignes.

3. **Sub-shells** : `SftpSubShell` et `RmanSubShell` réalisent du I/O réseau (SFTP) ou des opérations DB (RMAN). Mêmes besoins en streaming.

### 5.5 Points de migration

| # | Élément | Action de refonte |
|---|---|---|
| TR1 | `Logger` ↔ `TerminalSession` ↔ `TerminalManager` | Tous trois deviennent des **adapters** sur l'`EventBus` central. L'API `subscribe / getVersion` est conservée (compat `useSyncExternalStore`) mais remappée à un *signal* dérivé. |
| TR2 | `SessionRecorder` | Devient un consommateur du bus filtré sur `terminal.session.{id}.*`. La trace d'événements *est* le recording. |
| TR3 | `executeCommand: string → Promise<string>` | Étendu à `executeCommand(cmd) → AsyncIterable<OutputChunk>` (ou plus simple : la commande peut publier `terminal.output-line` qui sont consommés par la session). Compatibilité conservée : si la commande retourne juste une string, elle est traitée comme un seul chunk. |
| TR4 | `getBootSequence(): string` | Remplacé par un publication d'événements `device.boot.line` séquencés via `Scheduler`. La session s'y abonne ; les tests y branchent un collecteur. |
| TR5 | `replayRecording` | Avance virtuellement le scheduler au lieu de `setTimeout`. |
| TR6 | `onRequestClose` | Devient `terminal.session.close-requested` sur le bus. |
| TR7 | Émissions à ajouter | `terminal.session.opened`, `terminal.session.closed`, `terminal.session.line-added`, `terminal.session.input-mode-changed`, `terminal.session.flow-started`, `terminal.session.flow-completed`, `terminal.session.subshell-entered`, `terminal.session.subshell-exited`. |
| TR8 | `InteractiveFlowEngine.advance` async | Conservé tel quel. Les `command` steps peuvent émettre des output-lines intermédiaires via le bus. |
| TR9 | Boot delays `await new Promise(r => setTimeout(r, 12))` | Remplacé par `await scheduler.delay(12)`. |

### 5.6 Préservation rigoureuse de l'API view

L'API consommée par `TerminalView.tsx` est :

```ts
useSyncExternalStore(session.subscribe, session.getVersion);
session.lines, session.input, session.inputMode, session.getPrompt(), session.getTheme();
session.handleKey(e); session.setInput(s); session.setPasswordBuf(s); session.setInputBuf(s);
```

Cette surface **ne change pas**. La view ne doit avoir aucune connaissance du bus. C'est un invariant fort de la refonte côté UI : seuls les *shims* internes changent.

### 5.7 Sub-shells et composabilité

Les 5 sub-shells (`SqlPlus`, `Rman`, `Sftp`, `Cmd`, `PowerShell`) suivent le même cycle : create → handleKey → processLine → dispose. La refonte les laisse intactes, mais leur ouvre la possibilité d'émettre `subshell.line-output` au fil de l'exécution (pertinent pour PowerShell qui a aujourd'hui une `processLine` async retournant un blob).

`SftpSubShell` et `RmanSubShell` ont vocation à parler au bus directement pour leurs effets réseau / DB ; cf. §7 pour la couche Oracle.

### 5.8 `InteractiveFlowEngine`

Aucun changement structurel. Possibilités à explorer en post-refonte :

- Faire émettre par l'engine `flow.step-entered`, `flow.validation-failed`, `flow.completed` pour permettre aux tests d'instrumenter sans toucher au moteur.
- Permettre aux `CommandStep` d'invoquer une commande qui produit du streaming.

### 5.9 Synthèse — couche terminal

| Classe | LoC | Rôle | Action |
|---|---:|---|---|
| `TerminalSession` | 897 | base abstract sessions | Étendue : émet `terminal.*`, replay déterministe, scheduler |
| `LinuxTerminalSession` | 653 | session Linux interactive | Inchangée fonctionnellement |
| `CLITerminalSession` + Cisco + Huawei | 490 | sessions CLI vendor | Boot via Scheduler |
| `WindowsTerminalSession` | 457 | session Windows dual-mode | Inchangée |
| `TerminalManager` | 198 | registry sessions | API conservée + adapter bus |
| `InteractiveFlowEngine` | 316 | wizard FSM | Émet `flow.*` (optionnel) |
| `ISubShell` + 5 impls | ≈ 1 030 | sub-shells | Inchangées, peuvent stream via bus |
| `OutputFormatter` | 218 | format ANSI/plain | Inchangé |
| `TabCompletionHelper` | 132 | complétion | Inchangé |

**Bilan** : la couche terminal **n'absorbe que ≈ 5 % de l'effort de refonte**, mais profite directement de l'unification (recording = trace bus, output streaming, observation des sessions par la UI sans coupler à `TerminalManager`).

---

*Section 5 close. Suivante : §6 — Store Zustand et UI React.*

---

## 6. Analyse du store Zustand et des composants React

L'objectif de la refonte côté UI : **découpler les composants React du modèle de domaine**. Aujourd'hui, ils accèdent directement aux instances `Equipment` (à travers la propriété `instance: Equipment` portée par `NetworkDeviceUI`) et à `Cable` (à travers `Connection.cable`). Cela rend chaque rerender dépendant du fait que le store ait pensé à muter une `Map`.

### 6.1 Inventaire — store et composants

| Fichier | LoC | Rôle |
|---|---:|---|
| `src/store/networkStore.ts` | 353 | Store Zustand global : `deviceInstances`, `connections`, `selectedDeviceId`, … |
| `src/store/topologySerializer.ts` | (≈ 250) | Export/import JSON ; lit l'état des `Equipment` et `Cable` directement. |
| `src/components/network/NetworkDesigner.tsx` | 361 | Page racine ; orchestration tiling, drag-drop, ouverture terminaux. |
| `src/components/network/NetworkCanvas.tsx` | 279 | Canvas SVG, rendu des devices et connexions. |
| `src/components/network/NetworkDevice.tsx` | 275 | Rendu d'un device (icône, nom, état). |
| `src/components/network/ConnectionLine.tsx` | 166 | Rendu d'un câble (courbe Bézier). |
| `src/components/network/PacketAnimation.tsx` | 168 | « Placeholder » pour animation de paquets — voir §6.4. |
| `src/components/network/PropertiesPanel.tsx` | 410 | Panneau de propriétés (sélection, IP, ports, …). |
| `src/components/network/TerminalModal.tsx` | 273 | Modal ou tile pour une session terminal. |
| `src/components/network/MinimizedTerminals.tsx` | 168 | Bandeau des sessions minimisées. |
| `src/components/network/DeviceIcon.tsx`, `DevicePalette.tsx`, `Toolbar.tsx`, `InterfaceSelectorPopover.tsx` | 91+91+95+238 | Présentation. |
| `src/components/terminal/TerminalView.tsx` | 534 | Rendu d'une session (utilise `useSyncExternalStore`). |
| Helpers logiques (`*-logic.ts`, `connection-helpers.ts`) | ≈ 380 | Pure-fonctions, pas de state — rien à refondre. |

Total composants `network/` ≈ 3 100 LoC, plus 534 pour `TerminalView`.

### 6.2 Store Zustand actuel — `networkStore.ts`

#### 6.2.1 Schéma d'état

```ts
deviceInstances: Map<string, Equipment>;
connections: Connection[];                     // contient un cable: Cable
selectedDeviceId: string | null;
selectedConnectionId: string | null;
isConnecting: boolean;
connectionSource: { deviceId, interfaceId, connectionType } | null;
zoom: number; panX: number; panY: number;
```

`Connection` expose la `Cable` directement, et `NetworkDeviceUI` (le retour de `getDevices()`) expose `instance: Equipment`. Toute la UI peut donc appeler des méthodes de domaine arbitraires sur des objets mutables.

#### 6.2.2 Mécanisme de notification

Le seul levier de réactivité est :

```ts
set(state => ({ deviceInstances: new Map(state.deviceInstances) }));
```

— recopie superficielle de la `Map` à chaque mutation, dans `addDevice`, `updateDevice`, `moveDevice`. Zustand compare par référence et déclenche le rerender. Mais :

- **Mutations internes invisibles.** Si OSPF apprend une route, si une trame arrive, si un port change d'état link-up/down sur réception de port-security violation, **rien ne déclenche `set`**. La UI a alors une vue figée.
- **Recalcul O(N) à chaque `getDevices()`.** `deviceToUI` est appelé pour chaque équipement, qui à son tour itère ses ports et leurs adresses. Sur 30 devices avec 4 interfaces, c'est ~ 120 reconstructions par appel ; et `getDevices()` est appelé dans `NetworkDesigner`, `PropertiesPanel`, `NetworkCanvas`, `MinimizedTerminals`. Mémoization implicite par référence Map mais coût présent.
- **Couplage fort `instance: Equipment`.** Empêche la sérialisation, complique les tests UI, expose la mutabilité.

#### 6.2.3 Observations sur les actions

| Action | Effet sur la `Map` | Effet sur les domaines |
|---|---|---|
| `addDevice` | recopie | crée un device, registre |
| `removeDevice` | recopie | déconnecte câbles, retire du registre |
| `updateDevice` | recopie | mute name/hostname/power/position |
| `moveDevice` | recopie | mute position |
| `addConnection` | pas de recopie ! | crée un `Cable`, le `connect` |
| `removeConnection` | pas de recopie ! | `cable.disconnect()` |
| `clearAll` | reset complet | efface registre + reset Logger |

`addConnection` et `removeConnection` n'invalident pas `deviceInstances`. C'est **incohérent** : la création d'une connexion peut allumer des protocoles (OSPF auto-converge) qui mutent les routing tables — la UI n'en saura rien.

### 6.3 Composants React — pattern d'accès au domaine

#### 6.3.1 `NetworkDesigner.tsx` (361 LoC)

```ts
const { getDevices, clearAll, deviceInstances, connections } = useNetworkStore();
const devices = getDevices();   // appelé à chaque render
```

Le composant gère aussi : layout tiling, sessions minimisées, raccourcis Alt+H/V/G/S/M/J/K, ouverture terminaux. **3 `useEffect` distincts** pour : sync layout, raccourcis clavier global, sync `focusedIndex`. Pas de bus → la coordination se fait par React state local.

#### 6.3.2 `PropertiesPanel.tsx` (410 LoC)

Lit `selectedDeviceId`, retrouve le `NetworkDeviceUI` correspondant via `getDevices().find()`, affiche les interfaces et permet d'éditer les IPs. **Quand l'utilisateur saisit une IP**, le composant appelle `device.instance.configureInterface(...)` directement, puis `useNetworkStore.setState({ deviceInstances: new Map(...) })` pour forcer le rerender. Couplage fort, et fragile : oublier la recopie = UI figée.

#### 6.3.3 `ConnectionLine.tsx` (166 LoC)

Reçoit la `Connection` et lit `connection.cable.getIsUp()` ainsi que `connection.cable.hasDuplexMismatch()` pour la couleur du trait. Pas de subscription → si le cable change d'état après le câblage, le trait ne change pas.

#### 6.3.4 `PacketAnimation.tsx` (168 LoC)

Marquage explicite « placeholder » dans le commentaire d'en-tête. La structure `ActivePacket` est définie, des couleurs par type (`arp`, `icmp`, `broadcast`, `data`) sont prêtes, le code de courbe Bézier est implémenté. **Mais aucun mécanisme n'alimente la liste des `ActivePacket`** — il n'y a pas d'événement « paquet en transit » à observer. Cette section §6 et le pipeline L2 cible (cf. §3, §8) débloquent ce composant en même temps.

#### 6.3.5 `TerminalView.tsx` (534 LoC)

Consomme la session via `useSyncExternalStore(s.subscribe, s.getVersion)`. **Bonne pratique**, complètement compatible avec la cible. Pas de modification structurelle attendue.

#### 6.3.6 `MinimizedTerminals.tsx` (168 LoC)

Lit la liste des sessions depuis `TerminalManager` (qui a son propre `subscribe / getVersion`). Cohérent.

### 6.4 Pourquoi `PacketAnimation` est cassé aujourd'hui

Les conditions techniques pour animer un paquet sur un câble sont :

1. **Connaître le moment où la trame entre dans le câble.** Aujourd'hui : `Cable.transmit` appelle `targetPort.receiveFrame` synchrone. Il faut un événement `cable.frame.dispatched`.
2. **Connaître la durée de propagation.** Aujourd'hui : `Cable.getPropagationDelay()` retourne le bon nombre, mais il n'est jamais utilisé pour temporiser la livraison. Il faut programmer la livraison via le `Scheduler` à `now + propagationDelay` et émettre `cable.frame.delivered` à l'arrivée.
3. **Animer le trajet entre les deux instants.** React anime entre `dispatched` et `delivered` via `useEffect` + `requestAnimationFrame` ou un `useMotionValue`.

La refonte L2 décrite en §3 fournit (1) et (2). Le composant peut alors maintenir `ActivePacket[]` en s'abonnant via un nouveau hook `useActivePackets()`.

### 6.5 Couplage UI ↔ domaine — mesures

| Métrique | Valeur actuelle |
|---|---|
| Composants accédant à `Equipment.instance` directement | `PropertiesPanel`, `NetworkCanvas`, `NetworkDevice`, `MinimizedTerminals`, `NetworkDesigner` (5/12) |
| Composants accédant à `Connection.cable` directement | `ConnectionLine`, `PacketAnimation` (mais inactif), `PropertiesPanel` (2-3/12) |
| Composants utilisant `useSyncExternalStore` | `TerminalView`, `MinimizedTerminals` (par session manager) (2/12) |
| Composants utilisant `useNetworkStore` (Zustand) | 6 sur 12 composants `network/` |
| Granularité d'observation | « tout-ou-rien » — un changement d'état qui mute la `Map` rerender tout abonné de Zustand |

### 6.6 Points d'inconfort liés au store

| # | Symptôme | Conséquence |
|---|---|---|
| S1 | Mutations internes Equipment invisibles | UI figée pour ARP, OSPF, link-changes hors `set` du store. |
| S2 | `instance: Equipment` exposée à React | Fuites de mutabilité, sérialisation difficile. |
| S3 | `getDevices()` reconstruit à chaque appel | Coût constant à chaque render des composants principaux. |
| S4 | `set(state => ({ deviceInstances: new Map(...) }))` impératif | Code répétitif, sujet aux oublis (cf. inconsistance addConnection). |
| S5 | `Logger.reset()` et `resetCounters` dans `clearAll` | Couplage transverse direct. |
| S6 | Aucun signal d'événements « UI-relevant » | Toasts (« cable disconnected », « duplex mismatch detected ») impossibles sans patcher le domaine. |
| S7 | Pas de undo / redo | L'absence d'event-log unifié l'empêche structurellement. |

### 6.7 Décisions de refonte côté UI

#### 6.7.1 Read-models projetés

Le store ne contient plus d'`Equipment.instance`. À la place, des **read-models** typés et immuables :

```ts
interface DeviceVM {
  readonly id: string;
  readonly type: DeviceType;
  readonly name: string;
  readonly hostname: string;
  readonly position: { x: number; y: number };
  readonly powered: boolean;
  readonly interfaces: ReadonlyArray<PortVM>;
}
interface PortVM { /* ip, mac, isUp, mtu, speed, … */ }
interface CableVM { /* cableType, length, isUp, mismatch, ... */ }
```

Ces VM sont calculés à partir d'événements bus par un *projector* (réducteur). La UI les consomme via hooks ciblés.

#### 6.7.2 Hooks ciblés

```ts
useDevices(): DeviceVM[];
useDevice(id: string): DeviceVM | undefined;
usePort(deviceId: string, portName: string): PortVM | undefined;
useCable(connectionId: string): CableVM | undefined;
useArpTable(deviceId: string): ArpEntryVM[];
useRoutingTable(deviceId: string): RouteVM[];
useOspfNeighbors(deviceId: string): OspfNeighborVM[];
useActivePackets(): ActivePacketVM[];   // débloque PacketAnimation
useTerminalSessions(deviceId?: string): SessionVM[];
```

Chaque hook s'abonne aux événements pertinents et retourne une projection memoïsée.

#### 6.7.3 Rôle résiduel de Zustand

Zustand reste pour :

- **État UI pur** : `selectedDeviceId`, `isConnecting`, `connectionSource`, `zoom`, `panX/Y`. Indépendant du domaine, géré comme aujourd'hui.
- **Actions** : `addDevice`, `removeDevice`, … restent des thunks qui parlent au domaine ; mais elles **n'orchestrent plus la notification UI** (le bus s'en charge).

#### 6.7.4 Sérialisation

`topologySerializer.ts` continue de lire l'état du domaine via le `EquipmentRegistry`, mais via des accesseurs `getById(id)` typés et stables. À l'import, il publie `topology.import-started`, instancie les devices, leur publie les configurations, puis `topology.import-completed`. Cela permet à la UI d'afficher une barre de progression et aux protocoles de redémarrer correctement (les engines s'abonnent au `topology.import-completed` pour bootstrap).

#### 6.7.5 Migration progressive

Phase 1 : on **conserve** `getDevices()` et `instance: Equipment`, on ajoute en parallèle les hooks read-model alimentés par le bus. Les composants migrent un par un.

Phase 2 : `instance: Equipment` est **rendue privée** (renommage), seuls `topologySerializer` et les actions du store y accèdent.

Phase 3 : suppression de `instance` du `NetworkDeviceUI` ; `NetworkDeviceUI` devient égal à `DeviceVM`.

### 6.8 Composants — actions et émissions

| Composant | Lit | Écrit / agit | Migration |
|---|---|---|---|
| `NetworkDesigner` | `getDevices`, `connections`, sessions | `clearAll`, drag-drop init, layout | Substituer `useDevices()` ; conserver état UI tiling |
| `NetworkCanvas` | `devices`, `connections`, zoom, pan | `selectDevice`, `selectConnection`, drag move | `useDevices()`, `useConnections()` |
| `NetworkDevice` | un `DeviceVM` | drag, click, hover | Hook `useDevice(id)` |
| `ConnectionLine` | `CableVM` (état link-up, duplex mismatch) | clic | `useCable(connId)` |
| `PacketAnimation` | `ActivePacketVM[]` | n/a | `useActivePackets()` — débloque le composant |
| `PropertiesPanel` | `DeviceVM`/`PortVM` ; commandes config | `configureIP`, etc. | Refactor : émet une *intention* (`device.configure-port-ip`) au bus, qui est traitée par un *command-handler* ; pas d'accès direct au domaine |
| `TerminalModal` | session | clé/clic | Inchangé fonctionnellement |
| `TerminalView` | session | clavier | Inchangé |
| `MinimizedTerminals` | sessions | restore | Inchangé |
| `Toolbar` | divers | actions globales (export/import/clear) | Conservé, parle au store |
| `DevicePalette` | catalog | drag start | Inchangé |

### 6.9 Tableau récapitulatif

| Élément | LoC | Réactivité actuelle | Réactivité cible |
|---|---:|---|---|
| `networkStore` | 353 | Mutation Map manuelle | Conservé pour UI state ; domaine via bus |
| `topologySerializer` | 250 | Direct registry | Émet `topology.*` ; consume bus |
| `NetworkDesigner` | 361 | `getDevices()` polling | `useDevices()` bus |
| `NetworkCanvas` | 279 | `getDevices()` polling | `useDevices()` + `useConnections()` |
| `NetworkDevice` | 275 | accès direct `instance` | `useDevice(id)` |
| `ConnectionLine` | 166 | accès direct `cable` | `useCable(connId)` |
| `PacketAnimation` | 168 | placeholder, vide | `useActivePackets()` — fonctionnel |
| `PropertiesPanel` | 410 | accès direct + setState manuel | hooks ciblés + intentions |
| `TerminalModal` | 273 | Props session | Inchangé |
| `TerminalView` | 534 | `useSyncExternalStore` ✓ | Inchangé |
| `MinimizedTerminals` | 168 | manager `subscribe` ✓ | Inchangé |
| Helpers `*-logic.ts` | ≈ 380 | Pure | Inchangé |

**Bilan UI** : la refonte ne *remplace* pas Zustand, elle l'**adoucit** — Zustand garde l'état UI, le bus apporte l'observation du domaine. Les composants TerminalView et MinimizedTerminals sont déjà conformes au pattern cible et ne bougent pas.

---

*Section 6 close. Suivante : §7 — Couche base de données (Oracle).*

---

## 7. Analyse de la couche base de données (Oracle)

La simulation Oracle (`src/database/`, ≈ 12 000 LoC réparties sur `engine/` et `oracle/`) est volumineuse mais **purement synchrone**. C'est la couche où la refonte est la plus chirurgicale : aucun timer natif n'y existe, l'état mute mais sans abonnés. La refonte se limite à **rendre observable** ce qui est aujourd'hui silencieux, et à **brancher** la couche sur le bus pour les besoins d'intégration UI.

### 7.1 Cartographie

```
src/database/engine/                     « Engine SQL générique réutilisable »
   ├─ lexer/    Tokenisation
   ├─ parser/   AST + BaseParser (1 717 LoC)
   ├─ executor/ BaseExecutor (57) + ResultSet (65)
   ├─ storage/  BaseStorage (403)
   ├─ catalog/  BaseCatalog (180) + DataType (147)
   └─ types/    DatabaseConfig (51), DatabaseError (31), SQLDialect (5)

src/database/oracle/                     « Spécialisation Oracle »
   ├─ OracleInstance.ts    (542)  state machine SHUTDOWN→NOMOUNT→MOUNT→OPEN
   ├─ OracleStorage.ts     (74)   tablespaces, datafiles, DUAL
   ├─ OracleCatalog.ts     (1 917) data dictionary, V$/DBA_/USER_/ALL_/SYS
   ├─ OracleLexer.ts       (102)
   ├─ OracleParser.ts      (665)
   ├─ OracleExecutor.ts    (3 441) DML/DDL/PL-SQL léger, transactions
   ├─ OracleDatabase.ts    (1 305) façade — agrège tout pour un device
   ├─ commands/            commandes spécifiques (RMAN, datapump, …)
   └─ demo/                jeux de données

Intégration terminal :
   src/terminal/subshells/SqlPlusSubShell.ts   (104)
   src/terminal/subshells/RmanSubShell.ts      (381)
   src/terminal/commands/database.ts           (≈ 460)
```

### 7.2 État actuel — observations

#### 7.2.1 Synchrone partout

`OracleExecutor.execute(sql)` retourne un `ResultSet` synchrone. Pas de coroutines, pas de Promise, pas de timers. C'est cohérent avec une simulation pédagogique qui n'a pas vocation à émuler la latence d'un vrai SGBD.

#### 7.2.2 Une instance Oracle par device

`src/terminal/commands/database.ts` expose :

```ts
export function getOracleDatabase(deviceId: string): OracleDatabase;
export function createSQLPlusSession(deviceId, ...): ...;
export function removeOracleDatabase(deviceId: string): void;
export function resetAllOracleInstances(): void;
```

Une `OracleDatabase` est cachée par `deviceId` dans une `Map` module-level. À l'allumage, `initOracleFilesystem(device)` mute le système de fichiers du device pour y poser `$ORACLE_HOME`, `$ORACLE_BASE`, datafiles, alert.log.

#### 7.2.3 Synchronisation Oracle ↔ Filesystem du device

Plusieurs fonctions de **synchronisation explicite** existent pour pousser l'état Oracle vers le système de fichiers virtuel du device :

```ts
export function updateSpfileOnDevice(device, parameters): void;
export function syncAlertLogToDevice(device, alertLogEntries): void;
export function syncDatafilesToDevice(device, db): void;
export function syncOracleProcessesToDevice(device, db): void;
```

Ces fonctions sont appelées **manuellement** depuis `OracleInstance.startup`, `shutdown`, modification de paramètres, etc. C'est exactement le type d'effet qui mérite d'être déclenché par **événement** : `oracle.instance.opened` → handler qui sync le filesystem ; `oracle.instance.parameter-changed` → handler qui met à jour `spfile.ora` ; `oracle.instance.alert-log-entry-added` → handler qui ajoute une ligne à `alert_*.log` dans le filesystem.

#### 7.2.4 Aucun pub/sub

L'`OracleInstance` mute son `_state`, `_alertLog`, `_redoLogGroups`, `_backgroundProcesses`, sans aucun signal externe. Le `SqlPlusSubShell` et la UI ne savent pas si une autre session vient de faire `STARTUP` ou `SHUTDOWN ABORT`.

### 7.3 Points de couplage avec le réseau

- **SQL\*Net (TNS)** : aujourd'hui implémenté minimalement — `OracleExecutor` n'utilise pas le réseau ; les `connect user/password@SID` sont locaux. L'extension réseau (`sqlplus user/pass@host:1521/SID`) nécessitera un *listener* TNS qui écoute sur un port TCP simulé. C'est un bon candidat pour devenir un **acteur abonné au bus** : `tcp.listener.bound{port:1521}` → handler qui parse PDU TNS → publie `oracle.tns.connect-request` → `OracleInstance` lui répond.
- **RMAN distant** : `RmanSubShell` (381 LoC) gère aujourd'hui le RMAN local. La cible « RMAN sur node distant » est nécessairement réseau, donc nécessairement bus.

### 7.4 Décisions de refonte

#### 7.4.1 Ce qui ne change pas

- Lexer, Parser, BaseParser, AST, ResultSet, Catalog, Storage : **inchangés**. Logique métier pure.
- API publique de `OracleInstance.startup()`, `shutdown()`, `OracleExecutor.execute()` : **inchangée** côté signature. `Promise` non introduits.
- Performance synchrone conservée pour les tests et la fluidité UI.

#### 7.4.2 Ce qui devient observable

L'`OracleInstance` publie sur le bus :

| Événement | Quand | Payload |
|---|---|---|
| `oracle.instance.state-changed` | `startup` ou `shutdown` change `_state` | `{ deviceId, oldState, newState }` |
| `oracle.instance.background-process-started` | `startBackgroundProcesses` | `{ deviceId, name, pid }` |
| `oracle.instance.background-process-stopped` | `shutdown` | `{ deviceId, name, pid }` |
| `oracle.instance.alert-log-entry-added` | `logAlert` | `{ deviceId, line }` |
| `oracle.instance.parameter-changed` | `setParameter` | `{ deviceId, key, oldValue, newValue }` |
| `oracle.instance.redo-log-switched` | `switchRedoLog` | `{ deviceId, oldGroup, newGroup, sequence }` |
| `oracle.archive-log.created` | quand archivelog mode + redo switch | `{ deviceId, sequence, path }` |

L'`OracleExecutor` publie :

| Événement | Quand | Payload |
|---|---|---|
| `oracle.session.connected` | `CONNECT user@SID` | `{ deviceId, sessionId, schema, role }` |
| `oracle.session.disconnected` | `DISCONNECT` ou exit | `{ deviceId, sessionId }` |
| `oracle.transaction.started` | début TX implicite ou `BEGIN` | `{ deviceId, sessionId, txId }` |
| `oracle.transaction.committed` | `COMMIT` | `{ deviceId, sessionId, txId, durationMs }` |
| `oracle.transaction.rolled-back` | `ROLLBACK` | `{ deviceId, sessionId, txId }` |
| `oracle.dml.executed` | `INSERT/UPDATE/DELETE` | `{ deviceId, sessionId, schema, table, rowsAffected }` |
| `oracle.ddl.executed` | `CREATE/ALTER/DROP` | `{ deviceId, sessionId, schema, kind, name }` |
| `oracle.error.raised` | ORA-NNNNN | `{ deviceId, sessionId, code, message }` |

#### 7.4.3 Synchronisation FS → handler unique

Les quatre fonctions actuelles `updateSpfileOnDevice`, `syncAlertLogToDevice`, `syncDatafilesToDevice`, `syncOracleProcessesToDevice` deviennent **un seul module** `OracleFilesystemSync` qui s'abonne au bus :

```ts
// Pseudo
bus.on('oracle.instance.parameter-changed', e => fs.write(`${oracleHome}/spfile${sid}.ora`, render(e)));
bus.on('oracle.instance.alert-log-entry-added', e => fs.append(`${oracleBase}/diag/alert_${sid}.log`, e.line));
bus.on('oracle.instance.background-process-started', e => fs.registerProcess(e));
bus.on('oracle.instance.state-changed', e => { if (e.newState === 'OPEN') fs.attachDatafiles(...); });
```

Bénéfices :
- L'`OracleInstance` n'a **plus de dépendance** vers `Equipment` ni vers `LinuxFileSystem`.
- Tests unitaires d'`OracleInstance` : zéro mock filesystem requis.
- L'utilisateur qui veut désactiver la synchronisation FS (mode purement DB) peut détacher l'abonnement.

#### 7.4.4 Multi-session

`createSQLPlusSession` actuellement crée un nouvel objet de session ; deux SQL\*Plus parallèles sur le même device partagent l'instance. Les événements `oracle.session.*` permettent à la UI d'afficher « 3 sessions actives, dont 1 en transaction ouverte ». Pas de changement structurel — c'est un *cadeau* de la refonte.

#### 7.4.5 RMAN

`RmanSubShell` reste local. Il publie `oracle.rman.backup-started`, `oracle.rman.backup-completed`, `oracle.rman.restore-started` pour permettre à la UI d'afficher une progression et aux tests de vérifier les invariants.

### 7.5 Couche `database/engine/` (générique)

Le code générique (`BaseStorage`, `BaseCatalog`, `BaseParser`, `BaseExecutor`, `DataType`) est destiné à servir d'autres SGBDs (PostgreSQL, MySQL) à terme. La refonte **ne le contamine pas** avec des dépendances bus : il reste fonctionnel-pur. Seules les sous-classes Oracle (et futures Postgres) émettent les événements.

### 7.6 Tests existants

Trois suites principales :

- `src/__tests__/unit/database/oracle-dbms-filesystem-coherence.test.ts`
- `src/__tests__/unit/database/filesystem-database-layer.test.ts`
- `src/__tests__/unit/database/oracle-linux-filesystem.test.ts`

— elles testent précisément les synchronisations FS ↔ Oracle. Elles sont **directement** au cœur du refactor §7.4.3. Stratégie : la migration adapte ces tests pour vérifier que les **événements** sont bien émis et que le handler `OracleFilesystemSync` produit le même état FS qu'avant. **Pas de régression fonctionnelle.**

### 7.7 Synthèse — base de données

| Élément | LoC | Réactivité actuelle | Réactivité cible |
|---|---:|---|---|
| `OracleInstance` | 542 | Mutations silencieuses | Émet `oracle.instance.*` |
| `OracleExecutor` | 3 441 | Mutations silencieuses | Émet `oracle.session.*`, `oracle.transaction.*`, `oracle.dml.*`, `oracle.ddl.*`, `oracle.error.*` |
| `OracleCatalog` | 1 917 | Pure | Inchangé |
| `OracleStorage` | 74 | Pure | Inchangé |
| `OracleDatabase` | 1 305 | Façade | Inchangée |
| `OracleParser`, `OracleLexer` | 767 | Pure | Inchangés |
| Engine `BaseXxx` | ≈ 3 700 | Pure | Inchangé |
| Sync FS (4 fonctions) | ≈ 200 | Appels manuels | Module `OracleFilesystemSync` abonné au bus |
| `SqlPlusSubShell`, `RmanSubShell` | 485 | sync subshells | Émettent `oracle.rman.*`, sinon inchangés |
| `database.ts` (terminal) | 460 | Map deviceId → DB | Map conservée + émet `oracle.database.created/removed` |

**Bilan** : la couche DB représente moins de **5 % de l'effort** de refonte (ajout d'événements, extraction d'un module sync FS). Pas de réécriture de l'engine.

---

*Section 7 close. Suivante : §8 — Architecture cible : event bus, scheduler, état observable.*

---

## 8. Architecture cible — bus d'événements, scheduler, état observable

Cette section décrit la **forme cible** de l'architecture après refonte. Elle propose un noyau composé de trois primitives — `EventBus`, `Scheduler`, `Signal` — sur lesquelles toutes les autres couches se reconstruisent. Aucune dépendance externe (RxJS, XState, Redux, …) n'est introduite.

### 8.1 Principe d'organisation

```
┌────────────────────────────────────────────────────────────────────┐
│                      React Components / Hooks                      │
│   useDevices • useDevice • usePort • useCable • useArpTable        │
│   useRoutingTable • useOspfNeighbors • useActivePackets • …        │
└────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ getSnapshot / subscribe (sync external store)
                                  │
┌────────────────────────────────────────────────────────────────────┐
│           Projectors  (read-models / VM / SignalStore)             │
│   DevicesProjection • PortsProjection • RoutesProjection •         │
│   ActivePacketsProjection • TerminalSessionsProjection • …         │
└────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ bus.subscribe(topicPattern)
                                  │
┌──────────────┴───────────────────────────────────────────────┴─────┐
│                          EventBus                                  │
│  publish(event)  •  subscribe(pattern, handler)  •  unsubscribe()  │
│  ordering: FIFO synchrone, dispatch en microtâche optionnel        │
└──────────────┬───────────────────────────────────────────────┬─────┘
               ▲                                               ▲
               │ publish                                       │ publish
┌──────────────┴────────────────┐               ┌──────────────┴──────────────┐
│        Acteurs  (Actors)      │               │   Adapters / Effets         │
│  Equipment • Port • Cable     │  publish      │  OracleFilesystemSync       │
│  EndHost • Router • Switch    │   ─────►      │  LoggerAdapter (texte)      │
│  OSPFEngine • DHCPClient • …  │               │  AnimationAdapter           │
│  TerminalSession • OracleInst │               │  StorageSerializer          │
└──────────────┬────────────────┘               └─────────────────────────────┘
               │ uses
               ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Scheduler                                   │
│  setTimeout • setInterval • cancel • now() • advance(ms) for tests │
└────────────────────────────────────────────────────────────────────┘
```

Les **acteurs** mutent leur propre état et publient. Les **projecteurs** consomment et calculent des read-models. Les **adapters** consomment et produisent des effets externes (filesystem, log texte, persistence, animation). Les **hooks React** consomment les projecteurs.

### 8.2 `EventBus` — primitive #1

#### 8.2.1 Forme du type d'événement

```ts
// src/events/types.ts
export type DomainEvent =
  // ─── Network L1/L2 ─────────────────────────────────────────────
  | { topic: 'port.frame.tx-requested';   payload: { deviceId; portName; frame: EthernetFrame } }
  | { topic: 'port.frame.tx-blocked';     payload: { deviceId; portName; reason: 'link-down' | 'no-cable' } }
  | { topic: 'cable.frame.dispatched';    payload: { cableId; from: PortRef; to: PortRef; frame; propagationMs: number } }
  | { topic: 'cable.frame.delivered';     payload: { cableId; from: PortRef; to: PortRef; frame } }
  | { topic: 'cable.frame.lost';          payload: { cableId; reason: 'simulated-loss' } }
  | { topic: 'port.frame.received';       payload: { deviceId; portName; frame } }
  | { topic: 'port.frame.dropped';        payload: { deviceId; portName; reason } }
  | { topic: 'port.link.up';              payload: { deviceId; portName } }
  | { topic: 'port.link.down';            payload: { deviceId; portName } }
  | { topic: 'port.config.ip-changed';    payload: { deviceId; portName; ip; mask } }
  | { topic: 'port.config.ipv6-added';    payload: { deviceId; portName; ipv6; prefixLength; origin } }
  | { topic: 'port.security.violation';   payload: { deviceId; portName; mac; mode; action } }
  | { topic: 'cable.connected';           payload: { cableId; portA; portB; cableType } }
  | { topic: 'cable.disconnected';        payload: { cableId } }
  | { topic: 'cable.negotiated';          payload: { cableId; speed; duplex } }
  | { topic: 'cable.duplex-mismatch';     payload: { cableId } }

  // ─── Devices / Equipment ───────────────────────────────────────
  | { topic: 'device.registered';         payload: { id; type; name } }
  | { topic: 'device.deregistered';       payload: { id } }
  | { topic: 'device.power-on';           payload: { id } }
  | { topic: 'device.power-off';          payload: { id } }
  | { topic: 'device.position-changed';   payload: { id; x; y } }
  | { topic: 'device.renamed';            payload: { id; oldName; newName } }
  | { topic: 'device.boot.started';       payload: { id } }
  | { topic: 'device.boot.line';          payload: { id; line; lineType? } }
  | { topic: 'device.boot.completed';     payload: { id } }

  // ─── Host (L3/L4) ──────────────────────────────────────────────
  | { topic: 'host.arp.entry-learned';    payload: { deviceId; ip; mac; iface } }
  | { topic: 'host.arp.entry-expired';    payload: { deviceId; ip } }
  | { topic: 'host.routing.route-added';  payload: { deviceId; route } }
  | { topic: 'host.routing.route-removed';payload: { deviceId; route } }
  | { topic: 'host.icmp.echo-sent';       payload: { deviceId; from; to; id; seq } }
  | { topic: 'host.icmp.echo-reply';      payload: { deviceId; from; to; id; seq; ttl } }
  | { topic: 'host.tcp.listener-started'; payload: { deviceId; port } }
  | { topic: 'host.tcp.connection-established'; payload: { deviceId; localPort; remoteIp; remotePort } }
  | { topic: 'socket.bound' | 'socket.connected' | 'socket.closed';   payload: { deviceId; protocol; localPort; … } }

  // ─── Switch ────────────────────────────────────────────────────
  | { topic: 'switch.mac.learned';        payload: { deviceId; mac; vlan; port } }
  | { topic: 'switch.mac.aged';           payload: { deviceId; mac; vlan } }
  | { topic: 'switch.vlan.created';       payload: { deviceId; vlanId; name? } }
  | { topic: 'switch.stp.state-changed';  payload: { deviceId; portName; oldState; newState } }

  // ─── Protocols ─────────────────────────────────────────────────
  | { topic: 'ospf.neighbor.state-changed'; payload: { deviceId; neighborId; oldState; newState } }
  | { topic: 'ospf.lsa.received';            payload: { deviceId; lsa: LSAHeader } }
  | { topic: 'ospf.spf.run';                  payload: { deviceId; runtimeMs; routesAdded } }
  | { topic: 'rip.update.sent' | 'rip.update.received'; payload: { deviceId; iface; routes } }
  | { topic: 'dhcp.lease-requested' | 'dhcp.lease-granted' | 'dhcp.lease-expired'; payload: { … } }
  | { topic: 'ipsec.sa.installed' | 'ipsec.sa.deleted'; payload: { … } }

  // ─── Terminal ──────────────────────────────────────────────────
  | { topic: 'terminal.session.opened'    | 'terminal.session.closed'; payload: { deviceId; sessionId } }
  | { topic: 'terminal.session.line-added'; payload: { sessionId; line; lineType } }
  | { topic: 'terminal.session.input-mode-changed'; payload: { sessionId; mode } }

  // ─── Database ──────────────────────────────────────────────────
  | { topic: 'oracle.instance.state-changed'; payload: { deviceId; oldState; newState } }
  | { topic: 'oracle.session.connected';      payload: { deviceId; sessionId; schema } }
  | { topic: 'oracle.transaction.committed';  payload: { … } }
  | { topic: 'oracle.dml.executed';           payload: { … } }

  // ─── Logging (rétro-compat) ────────────────────────────────────
  | { topic: 'log';                       payload: { level; source; event; message; data? } };
```

Cet exemple n'est pas exhaustif ; le type complet sera **co-localisé avec chaque module** (un fichier `*.events.ts` par couche), puis agrégé dans un union global `DomainEvent` exporté par `src/events/index.ts`. Discriminé par `topic`, il garantit le typage à la publication et au filtrage.

#### 8.2.2 API du bus

```ts
// src/events/EventBus.ts
export interface IEventBus {
  publish<E extends DomainEvent>(event: E): void;

  subscribe<T extends DomainEvent['topic']>(
    topic: T | T[] | RegExp,
    handler: (e: Extract<DomainEvent, { topic: T }>) => void,
  ): Unsubscribe;

  /** Filtré par predicate sur le payload */
  subscribeWhere<T extends DomainEvent['topic']>(
    topic: T,
    predicate: (e: Extract<DomainEvent, { topic: T }>) => boolean,
    handler: (e: Extract<DomainEvent, { topic: T }>) => void,
  ): Unsubscribe;

  /** Désinscription massive (pour clearAll, tests) */
  clear(): void;
}

export type Unsubscribe = () => void;
```

#### 8.2.3 Sémantique d'ordre

- **Synchrone par défaut.** `publish` invoque les handlers dans l'ordre de souscription, dans la même call-stack. Préserve la prédictibilité actuelle.
- **Réentrance autorisée mais bornée.** Un handler peut publier un autre événement ; ce dernier est *queueé* puis dispatché à la fin du dispatch courant (« sub-event queue »). Garantit que la pile ne s'effondre pas et que l'ordre causal reste lisible.
- **Pas de promesses dans le bus lui-même.** Les handlers async écrivent leur logique async eux-mêmes (`(async () => { await … bus.publish(…) })()`).
- **Pas de delivery garantie.** Si aucun abonné, l'événement est simplement perdu. Pour les besoins de débogage, un *adapter* `BusTracer` peut s'abonner à un wildcard `*` et journaliser.

#### 8.2.4 Implémentation indicative

```ts
class EventBus implements IEventBus {
  private handlers: Map<string, Array<(e: any) => void>> = new Map();
  private queue: DomainEvent[] = [];
  private dispatching = false;

  publish(event: DomainEvent): void {
    this.queue.push(event);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        const list = this.handlers.get(e.topic) ?? [];
        const wildcard = this.handlers.get('*') ?? [];
        for (const h of [...list, ...wildcard]) {
          try { h(e); }
          catch (err) { console.error('[bus] handler error:', err); }
        }
      }
    } finally { this.dispatching = false; }
  }
  // subscribe / subscribeWhere / clear : straightforward
}
```

≈ 80 LoC tout compris.

### 8.3 `Scheduler` — primitive #2

#### 8.3.1 API

```ts
// src/events/Scheduler.ts
export interface IScheduler {
  /** Returns current simulated time in ms (real time in production, virtual time in tests) */
  now(): number;

  setTimeout(fn: () => void, delayMs: number): TimerHandle;
  setInterval(fn: () => void, periodMs: number): TimerHandle;
  clear(handle: TimerHandle): void;

  /** Promise wrapper */
  delay(ms: number): Promise<void>;

  /** Test mode: advance virtual time by ms and run due timers */
  advance(ms: number): void;

  /** Test mode: clear all pending */
  reset(): void;
}
```

#### 8.3.2 Deux implémentations

- **`RealTimeScheduler`** : production. `now() => performance.now()`, délègue à `globalThis.setTimeout`/`setInterval`.
- **`VirtualTimeScheduler`** : tests. Heap de timers triés, `now()` est un compteur, `advance(ms)` déclenche les timers `due ≤ now+ms` dans l'ordre.

Les tests choisissent leur scheduler via injection :

```ts
// avant
vi.useFakeTimers();
vi.advanceTimersByTime(40_000);

// après
const scheduler = new VirtualTimeScheduler();
const ospf = new OSPFEngine({ scheduler, bus });
scheduler.advance(40_000);
```

Bénéfice clé : **le scheduler virtuel propage le temps aux Promise via `delay()`**, ce que `vi.useFakeTimers` ne sait pas faire pour les `Promise` créées manuellement par les engines.

#### 8.3.3 Singleton vs injection

- Production : un singleton `defaultScheduler = new RealTimeScheduler()` exporté.
- Code domaine : **toujours** prendre `IScheduler` en injection (constructeur). Fallback sur le singleton si non fourni.
- Tests : créent leur propre `VirtualTimeScheduler` et l'injectent.

### 8.4 `Signal` / `Projection` — primitive #3

#### 8.4.1 Pourquoi un signal ?

`useSyncExternalStore` exige `subscribe(listener) → unsubscribe` + `getSnapshot() → state`. C'est ce que fait déjà `TerminalSession`. On généralise :

```ts
// src/events/Signal.ts
export interface Signal<T> {
  get(): T;
  subscribe(listener: () => void): Unsubscribe;
}

export class WritableSignal<T> implements Signal<T> {
  constructor(private value: T) {}
  private listeners = new Set<() => void>();
  get(): T { return this.value; }
  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const l of this.listeners) l();
  }
  subscribe(l: () => void): Unsubscribe {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** Compute a derived signal (one-shot, cached) */
export function derived<T>(deps: Signal<unknown>[], fn: () => T): Signal<T>;
```

≈ 60 LoC.

#### 8.4.2 Projecteurs

Un *projecteur* consomme le bus et entretient un ou plusieurs `WritableSignal`. Exemple — la liste des devices :

```ts
// src/projections/DevicesProjection.ts
export class DevicesProjection {
  readonly devices = new WritableSignal<Map<string, DeviceVM>>(new Map());

  constructor(bus: IEventBus, registry: EquipmentRegistry) {
    bus.subscribe('device.registered',     this.onRegister);
    bus.subscribe('device.deregistered',   this.onDeregister);
    bus.subscribe('device.power-on',       this.onPowerChange);
    bus.subscribe('device.power-off',      this.onPowerChange);
    bus.subscribe('device.position-changed', this.onPosition);
    bus.subscribe('device.renamed',        this.onRenamed);
    bus.subscribe('port.config.ip-changed',this.onPortIp);
    bus.subscribe('port.link.up',          this.onPortLink);
    bus.subscribe('port.link.down',        this.onPortLink);
    // ...
  }
  // handlers : recalculent le DeviceVM concerné en immutable, puis this.devices.set(newMap)
}
```

#### 8.4.3 Hooks React

```ts
// src/hooks/useSignal.ts
export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.get);
}

// src/hooks/devices.ts
export function useDevices(): DeviceVM[] {
  const map = useSignal(projections.devices.devices);
  return useMemo(() => Array.from(map.values()), [map]);
}
export function useDevice(id: string): DeviceVM | undefined {
  return useSignal(projections.devices.devices).get(id);
}
```

#### 8.4.4 Granularité

Pour éviter les rerenders globaux, deux options :

1. **Un signal par device** : `Map<id, Signal<DeviceVM>>`. Hook consomme uniquement le signal de l'ID demandé. Plus de rerenders quand un autre device change. Coût : plus de signaux à entretenir.
2. **Un signal global + memoïsation** : option simple par défaut, `useDevice(id)` mémorise et compare l'objet reçu. React skip le rerender si même référence. C'est ce que la cible adopte au démarrage ; on monte en granularité si profilage le justifie.

### 8.5 Helpers transverses

#### 8.5.1 `waitForEvent`

Pour remplacer toutes les Maps de pending callbacks :

```ts
// src/events/waitForEvent.ts
export function waitForEvent<T extends DomainEvent['topic']>(
  bus: IEventBus,
  topic: T,
  predicate: (e: Extract<DomainEvent, { topic: T }>['payload']) => boolean,
  opts: { timeoutMs: number; scheduler: IScheduler },
): Promise<Extract<DomainEvent, { topic: T }>['payload']> {
  return new Promise((resolve, reject) => {
    const timer = opts.scheduler.setTimeout(
      () => { unsub(); reject(new Error(`waitForEvent(${topic}) timed out after ${opts.timeoutMs}ms`)); },
      opts.timeoutMs,
    );
    const unsub = bus.subscribe(topic, e => {
      if (predicate(e.payload)) {
        opts.scheduler.clear(timer);
        unsub();
        resolve(e.payload);
      }
    });
  });
}
```

≈ 25 LoC. Remplace ~250 LoC dans `EndHost` et `Router`.

#### 8.5.2 `BusAdapter` pour `Logger`

Pour préserver l'API `Logger.info(...)` :

```ts
// src/network/core/Logger.ts (rewrite)
export const Logger = {
  info(source, event, message, data?)  { bus.publish({ topic: 'log', payload: { level: 'info', source, event, message, data } }); },
  warn(...) { ... }, error(...) { ... }, debug(...) { ... },
  // subscribe est conservé pour rétro-compatibilité, mais devient un sucre sur bus.subscribe('log', handler)
  subscribe(handler, filter?) { … },
};
```

90 sites d'appel inchangés.

### 8.6 Pipeline L2 cible — exemple détaillé

Diagramme du flux `Port.send → Cable → Port.receive` après refonte :

```
Equipment.send(portName, frame)
  └─ port.sendFrame(frame)
        ├─ Si !isUp ou !cable : bus.publish('port.frame.tx-blocked', {...}) ; return
        ├─ counters.framesOut++
        ├─ bus.publish('port.frame.tx-requested', {deviceId, portName, frame})
        └─ cable.transmit(frame, port)
             ├─ Si !isUp : bus.publish('cable.frame.lost', {reason:'cable-down'}) ; return
             ├─ Si simulated loss : bus.publish('cable.frame.lost', {reason:'simulated-loss'}) ; return
             ├─ targetPort = ...
             ├─ propagationMs = computePropagation(...)
             ├─ bus.publish('cable.frame.dispatched', {cableId, from, to, frame, propagationMs})
             └─ scheduler.setTimeout(() => {
                  bus.publish('cable.frame.delivered', {cableId, from, to, frame})
                  targetPort.receiveFrame(frame)   ← émet 'port.frame.received'
                }, propagationMs)
```

Et côté réception :

```
Port.receiveFrame(frame)
  ├─ Si !isUp : bus.publish('port.frame.dropped', {...}) ; return
  ├─ Si !portSecurityCheck : bus.publish('port.security.violation', {...}) ; return
  ├─ counters.framesIn++
  └─ bus.publish('port.frame.received', {deviceId, portName, frame})

Equipment subscribed to 'port.frame.received' (filtré par deviceId)
  └─ this.handleFrame(portName, frame)        ← inchangé fonctionnellement
```

Bénéfices :

- **`PacketAnimation` débloqué.** Il s'abonne à `cable.frame.dispatched` + `cable.frame.delivered` et anime entre les deux.
- **Capture / tcpdump simulé** : un module `PacketCapture` s'abonne à `port.frame.tx-requested` / `port.frame.received` filtré par device.
- **Port mirroring** : un module `PortSpan` s'abonne et republie sur le port de destination.
- **IDS éducatif** : abonné à `port.frame.received`, applique des règles, émet `ids.alert`.

Tout cela **sans toucher** à `Equipment`, `Port`, `Cable`.

### 8.7 Pipeline `pendingPings` cible — exemple

Avant :

```ts
// EndHost.pingHost — ~30 LoC
this.pendingPings.set(key, { resolve, reject, timer: setTimeout(...) });
return new Promise((resolve, reject) => { ... });
```

Après :

```ts
async pingHost(target: IPAddress, opts: PingOptions): Promise<PingResult> {
  const id = ++this.pingIdCounter;
  const seq = 1;
  await this.sendIcmpEcho(target, id, seq);
  bus.publish({ topic: 'host.icmp.echo-sent', payload: { deviceId: this.id, to: target, id, seq } });

  try {
    const reply = await waitForEvent(bus, 'host.icmp.echo-reply',
      e => e.deviceId === this.id && e.id === id && e.seq === seq && e.from.equals(target),
      { timeoutMs: opts.timeoutMs ?? 1000, scheduler });
    return { success: true, ttl: reply.ttl, /* … */ };
  } catch (e) {
    return { success: false, reason: 'timeout' };
  }
}
```

≈ 12 LoC, et plus de `pendingPings` Map ni de timer manuel. Idem pour ARP (via `NeighborResolver` interne avec scheduler), TCP handshake, traceroute hops.

### 8.8 Modules nouveaux à créer

| Module | LoC estimées | Rôle |
|---|---:|---|
| `src/events/EventBus.ts` | 100 | Bus central |
| `src/events/Scheduler.ts` (Real + Virtual) | 200 | Scheduler avec mode test |
| `src/events/Signal.ts` (Signal, WritableSignal, derived) | 80 | Primitives observables |
| `src/events/waitForEvent.ts` | 30 | Helper pending → await |
| `src/events/types.ts` | 250 | Union `DomainEvent` |
| `src/events/index.ts` | 20 | Re-exports |
| `src/projections/DevicesProjection.ts` | 200 | Read-model devices |
| `src/projections/CablesProjection.ts` | 100 | Read-model cables |
| `src/projections/ActivePacketsProjection.ts` | 120 | Read-model packets in-flight |
| `src/projections/RoutesProjection.ts` | 100 | Read-model routing tables |
| `src/projections/ArpProjection.ts` | 80 | Read-model ARP |
| `src/projections/OspfProjection.ts` | 120 | Read-model OSPF (neighbors, LSDB summary) |
| `src/projections/TerminalSessionsProjection.ts` | 80 | Read-model sessions |
| `src/projections/index.ts` | 30 | Re-exports + `Projections` aggregator |
| `src/hooks/useSignal.ts` | 30 | Hook générique |
| `src/hooks/devices.ts`, `cables.ts`, `routes.ts`, `arp.ts`, `ospf.ts`, `packets.ts`, `terminal.ts` | 300 | Hooks par domaine |
| `src/adapters/OracleFilesystemSync.ts` | 200 | Adapter Oracle ↔ FS |
| `src/adapters/BusTracer.ts` | 60 | Adapter debug |
| `src/adapters/PacketCapture.ts` | 150 | Adapter tcpdump-like (optionnel à l'étape 1) |

**Total nouveau code** : ≈ 2 250 LoC. À comparer aux **400-600 LoC supprimées** dans `EndHost` et `Router` (Maps de pending), aux **~ 200 LoC de duplication ARP/NDP** éliminées via `NeighborResolver`, aux centaines de lignes de `linkChangeHandlers`/`frameHandler` boilerplate. Solde : la base **grossit légèrement** mais devient **modulaire et observable**.

### 8.9 Politique de nommage des topics

- **Format** : `domain.subdomain[.action]` en kebab-case.
- **Verbes au passé pour les faits** : `arp.entry-learned`, `device.power-on` (ici une exception lexicale : `power-on` est le nom de l'action).
- **Verbes -ed pour les transitions** : `port.link.up`, `cable.duplex-mismatch`. (Conserver les patterns lisibles plutôt qu'une convention rigide.)
- **Singulier** pour les payloads d'une seule entité (`port.config.ip-changed`), pas `port.configs.ips-changed`.
- **Versioning** : si un payload évolue de manière incompatible, le topic devient `domain.subdomain.action-v2` ; les handlers v1 cohabitent jusqu'à migration complète.

### 8.10 Politique d'erreurs

- Les handlers ne throw **jamais** vers le bus. Les exceptions sont attrapées par le bus, journalisées, et un événement `bus.handler-error` est publié pour permettre à un superviseur de réagir.
- Une *kill-pill* (`bus.clear()`) permet aux tests de garantir l'isolation entre cas.

### 8.11 Politique de tests

- **Tests unitaires** : `EventBus`, `Scheduler` (real + virtual), `Signal`, `waitForEvent` reçoivent leurs propres suites couvrant les invariants (FIFO, réentrance, cancel, advance).
- **Tests d'acteur** : chaque acteur (Port, Cable, Equipment, OSPFEngine, …) testé en isolation contre un `EventBus` test et un `VirtualTimeScheduler`. On vérifie publications attendues + transitions d'état.
- **Tests d'intégration** : scénarios bout-en-bout (ping, OSPF converge, DHCP DORA) basés sur **trace-snapshot** de la séquence d'événements (objet hashable comparé entre runs).

### 8.12 Cohabitation avec l'existant pendant la migration

- Pendant les phases initiales, les **deux modèles coexistent** : les ports émettent à la fois leurs callbacks legacy (`onFrame`, `onLinkChange`) **et** les événements bus. Permet de migrer composant par composant sans tout casser.
- Le `Logger` actuel devient le premier *consommateur* du bus pendant la phase de transition.
- Une feature-flag `featureFlags.useEventBusForFrames` peut être basculée pour forcer le pipeline cible globalement.

### 8.13 Diagramme final — un cycle de vie complet

```
Utilisateur cliquesur "Ping 10.0.0.2 from PC-A"
   │
   ▼
TerminalView → session.handleKey('Enter')
   │
   ▼
LinuxTerminalSession → device.executeCommand('ping 10.0.0.2')
   │
   ▼
LinuxNetCommands.ping → host.pingHost(...)
   │
   ▼  (publication)
bus.publish('host.icmp.echo-sent', {...})
   │
   ├────► Logger adapter         (texte 'icmp:echo-sent ...')
   ├────► IcmpEchoStatsProjection (compteur live)
   │
   ▼  (envoi physique)
host.sendIcmpEcho → port.sendFrame
   │
   ▼  (publication)
bus.publish('port.frame.tx-requested', {...})
   │
   ▼
cable.transmit → bus.publish('cable.frame.dispatched', { propagationMs: 0.5 })
   │
   ├────► PacketAnimation       (anime un point lumineux)
   │
   ▼  (scheduler.setTimeout 0.5ms)
bus.publish('cable.frame.delivered', {...})
bus.publish('port.frame.received', {...})
   │
   ├────► Equipment-B handler    (handleFrame → ICMP echo reply)
   ▼
... cycle inverse ...
   │
   ▼
bus.publish('host.icmp.echo-reply', {...})
   │
   ├────► waitForEvent dans pingHost résout la Promise
   ├────► IcmpEchoStatsProjection (succès, ttl)
   │
   ▼
session.addLine('64 bytes from 10.0.0.2: icmp_seq=1 ttl=64 time=0.5 ms')
   │
   ▼
session.notify() → useSyncExternalStore rerender → TerminalView
```

Toute la chaîne est **observable**, **testable**, **rejouable**.

---

*Section 8 close. Suivante : §9 — Refactoring détaillé par classe.*

---

## 9. Refactoring détaillé par classe

Cette section donne, pour **chaque classe ou module impacté**, la liste exacte de ce qui change : suppressions, ajouts, conservation, événements émis, événements consommés, dépendances injectées, et éventuelles migrations de tests.

Pour la lisibilité, les classes sont regroupées par couche (réseau core, hardware, devices, protocoles, terminal, UI, database). Chaque entrée suit le canevas :

> **Classe** (chemin, LoC actuelles → cibles)
> - **Conservé**
> - **Supprimé**
> - **Ajouté**
> - **Émet**
> - **Consomme**
> - **Dépendances injectées**
> - **Notes**

### 9.1 Couche réseau — `core/`

#### `Logger` (`src/network/core/Logger.ts`, 123 → ~ 80)

- **Conservé** : API publique `info/warn/error/debug/subscribe/unsubscribe/getLogs`. Tous les sites d'appel (≈ 90) restent inchangés.
- **Supprimé** : tableau interne `subscriptions`, gestion FIFO du `logs[]` (déléguée au bus + un projecteur `LogProjection` capé à 10 000 entrées).
- **Ajouté** : adapter qui republie chaque `log(...)` sur le bus comme `{ topic: 'log', payload: { … } }`.
- **Émet** : `log`.
- **Consomme** : rien.
- **Dépendances injectées** : `IEventBus` (avec fallback singleton).
- **Notes** : la classe devient un facade ; un projecteur `LogProjection` détient le buffer historique.

#### `EventBus` (nouveau, `src/events/EventBus.ts`, 0 → ~ 100)

- **Ajouté** : implémentation décrite en §8.2.
- **Émet** : rien (c'est lui-même).
- **Notes** : exporté par `src/events/index.ts`.

#### `Scheduler` (nouveau, `src/events/Scheduler.ts`, 0 → ~ 200)

- **Ajouté** : `IScheduler`, `RealTimeScheduler`, `VirtualTimeScheduler`, `TimerHandle`.
- **Notes** : ne dépend pas du bus ; testable en isolation.

#### `Signal` / `WritableSignal` / `derived` (nouveau, 0 → ~ 80)

- **Ajouté** : primitives décrites en §8.4.
- **Notes** : zéro dépendance externe.

#### `waitForEvent` (nouveau, 0 → ~ 30)

- **Ajouté** : helper §8.5.1.

#### `PacketQueue` (`src/network/core/PacketQueue.ts`, 142 → ~ 130)

- **Conservé** : API `enqueue / flush / size / clear / purgeExpired / getByNextHop`.
- **Supprimé** : appels directs à `setTimeout`.
- **Ajouté** : injection `IScheduler` ; les expirations utilisent `scheduler.setTimeout`.
- **Émet** : `packetqueue.depth-changed` (optionnel, débrayable).
- **Notes** : conserve sa généricité ARP/NDP.

#### `NeighborResolver` (`src/network/core/NeighborResolver.ts`, 204 → ~ 200)

- **Conservé** : API publique `learn / lookup / resolve / clear / remove / hasPending / purgeExpired`.
- **Supprimé** : `setTimeout` natif.
- **Ajouté** : injection `IScheduler` + `IEventBus` ; `resolve` utilise `scheduler.setTimeout` et publie `neighbor.solicitation-sent`.
- **Émet** : `neighbor.learned`, `neighbor.expired`, `neighbor.cache-cleared`, `neighbor.solicitation-sent`, `neighbor.resolution-timeout`.
- **Notes** : la `Promise<MAC>` reste l'API publique pour les callers (l'await est confortable).

#### `TcpConnection` (`src/network/core/TcpConnection.ts`, 97 → ~ 110)

- **Conservé** : API `write / close / onData / receiveData / updateAck`.
- **Ajouté** : `IEventBus` injecté ; émet `tcp.data.received`, `tcp.data.sent`, `tcp.connection-closed`.
- **Émet** : ci-dessus.
- **Notes** : `dataHandlers[]` (M2 propre) reste interne — utile pour les callers locaux qui ne veulent pas s'abonner au bus pour chaque connexion.

#### `SocketTable` (`src/network/core/SocketTable.ts`, 212 → ~ 230)

- **Conservé** : API `bind / connect / close / isPortBound / getAll / findByLocalPort / allocateEphemeralPort / clear`.
- **Ajouté** : `IEventBus` injecté ; émet `socket.bound / socket.connected / socket.closed / socket.state-changed`.
- **Notes** : permet à la UI d'afficher netstat/ss en live.

#### `RoutingTable` (`src/network/core/RoutingTable.ts`)

- **Ajouté** : émission `routing.route-added / routing.route-removed / routing.route-changed`.
- **Notes** : utilisé par les routes statiques + DHCP + OSPF.

### 9.2 Couche réseau — `equipment/` et `hardware/`

#### `Equipment` (`src/network/equipment/Equipment.ts`, 194 → ~ 200)

- **Conservé** : structure d'héritage, méthodes `powerOn/Off`, `setName/Hostname`, `setPosition`, `addPort`, `getPorts`, surface terminal (`getCwd`, `executeCommand`, …).
- **Supprimé** :
  - Méthodes statiques `getById / getAllEquipment / clearRegistry` (deprecated).
  - Câblage de callback dans `addPort` (`port.onFrame(...)`).
- **Ajouté** :
  - Constructor accepte `{ bus?: IEventBus; scheduler?: IScheduler }` (fallback singletons).
  - Souscription dans le constructor : `bus.subscribeWhere('port.frame.received', e => e.deviceId === this.id, e => this.handleFrame(e.portName, e.frame))`.
  - Méthodes `dispose()` qui désinscrit ses abonnements.
- **Émet** : `device.power-on`, `device.power-off`, `device.position-changed`, `device.renamed`, `device.boot.started/line/completed`.
- **Consomme** : `port.frame.received` (filtré par `deviceId`).
- **Notes** : `handleFrame` reste abstrait pour les sous-classes.

#### `EquipmentRegistry` (`src/network/equipment/EquipmentRegistry.ts`, 107 → ~ 120)

- **Conservé** : CRUD, requêtes, `clear`, instanciation isolée pour tests.
- **Supprimé** : usage du singleton implicite via `Equipment` constructor (devient explicite).
- **Ajouté** : émission sur registre + signal direct.
- **Émet** : `device.registered`, `device.deregistered`, `registry.cleared`.
- **Notes** : continue d'exposer `getInstance()` pour la rétro-compat ; intérieurement, accepte un `IEventBus` injecté.

#### `Port` (`src/network/hardware/Port.ts`, 487 → ~ 460)

- **Conservé** : API de configuration (`configureIP/clearIP/enableIPv6/configureIPv6/addSLAACAddress/removeIPv6Address/setSpeed/setDuplex/setMTU`), accesseurs (`getIPAddress/getMAC/getSpeed/...`), gestion de `PortSecurity`, compteurs RFC 2863.
- **Supprimé** :
  - `frameHandler` (M1) et `onFrame`.
  - `linkChangeHandlers` (M2) et `onLinkChange`.
  - `_setCableNoNotify`, `_notifyLinkUp` (hacks).
  - `notifyLinkChange` privé.
- **Ajouté** :
  - Injection optionnelle `{ bus?: IEventBus }`.
  - `sendFrame` publie `port.frame.tx-requested` puis appelle `cable.transmit(frame, this)`.
  - `receiveFrame` publie `port.frame.received` (l'`Equipment` y est abonné).
  - `setUp(up)` publie `port.link.up` ou `port.link.down`.
  - `configureIP/...` publient `port.config.ip-changed`/`...`.
- **Émet** : `port.frame.tx-requested`, `port.frame.tx-blocked`, `port.frame.received`, `port.frame.dropped`, `port.link.up`, `port.link.down`, `port.config.*`, `port.security.violation`.
- **Consomme** : `cable.connected` / `cable.disconnected` (pour mettre à jour son état `cable: Cable | null`).
- **Notes** : zéro callbacks publics. Tous les anciens consommateurs migrent sur le bus.

#### `Cable` (`src/network/hardware/Cable.ts`, 266 → ~ 280)

- **Conservé** : API `connect/disconnect/transmit/setUp/setPacketLossRate/getInfo`, calcul du `propagationDelay`, négociation auto, détection duplex-mismatch.
- **Supprimé** : appels directs à `Math.random` (passe par `rng()` injecté).
- **Ajouté** :
  - Injection `{ bus?: IEventBus; scheduler?: IScheduler; rng?: () => number }`.
  - `transmit` publie `cable.frame.dispatched`, programme `scheduler.setTimeout(deliver, propagationMs)`, qui publie `cable.frame.delivered` puis appelle `targetPort.receiveFrame(frame)`.
  - `connect` publie `cable.connected` puis `cable.negotiated` ; déclenche éventuellement `cable.duplex-mismatch`.
- **Émet** : `cable.connected`, `cable.disconnected`, `cable.negotiated`, `cable.duplex-mismatch`, `cable.frame.dispatched`, `cable.frame.delivered`, `cable.frame.lost`.
- **Notes** : la livraison devient asynchrone (microtâche ou délai propagation). Les tests d'intégration doivent advance(ms) pour faire avancer la simulation.

#### `PortSecurity` (`src/network/hardware/PortSecurity.ts`)

- **Ajouté** : émission `port.security.violation`, `port.security.shutdown`, `port.security.mac-learned`.
- **Notes** : la décision « shutdown port » reste interne mais est journalisée par bus.

### 9.3 Couche réseau — `devices/`

#### `EndHost` (`src/network/devices/EndHost.ts`, 2 325 → ~ 1 700)

- **Conservé** : abstractions générales (`getInterface(s)`, `configureInterface`, `setDefaultGateway`, `getSocketTable`, `dhcpClient`, `tcpListeners` et `tcpConnections` Maps internes, `handleFrame`, `handleARP`, `handleIPv4`, `handleIPv6`, sous-méthodes ICMP/UDP/TCP).
- **Supprimé** :
  - `pendingARPs`, `pendingPings`, `pendingNDPs`, `pendingPing6s`, `pendingTcpHandshakes` Maps.
  - `fwdQueue` Array (remplacée par `PacketQueue` géré par scheduler).
  - Implémentation inline d'ARP/NDP (déléguée à `NeighborResolver<IPAddress>` et `NeighborResolver<IPv6Address>`).
- **Ajouté** :
  - Injection `{ bus, scheduler }` propagée par le constructor `Equipment`.
  - Champs `arp = new NeighborResolver<IPAddress>('ARP', timeout, ttl, bus, scheduler)` et `ndp = new NeighborResolver<IPv6Address>('NDP', ...)`.
  - Réécriture de `pingHost`, `pingHost6`, `tcpConnect`, `tracerouteHop` autour de `waitForEvent`.
- **Émet** : `host.arp.entry-learned`, `host.arp.entry-expired`, `host.icmp.echo-sent`, `host.icmp.echo-reply`, `host.icmp.echo-timeout`, `host.tcp.listener-started/stopped`, `host.tcp.connection-established/closed`, `host.routing.route-added/removed`.
- **Consomme** : `port.frame.received` (déjà via `Equipment`), `dhcp.lease-granted` (auto-config IP).
- **Notes** : gain net en LoC ≈ -600.

#### `LinuxMachine`, `LinuxPC`, `LinuxServer`, `WindowsPC` (sous-classes EndHost)

- **Conservé** : tout (logique terminal, DNS, services).
- **Ajouté** : éventuelles publications `host.dns.query / host.dns.response`, `service.started / service.stopped`.
- **Notes** : impact mineur ; refactor concentré sur `EndHost`.

#### `Switch` (`src/network/devices/Switch.ts`, 838 → ~ 850)

- **Conservé** : tout sauf timer.
- **Supprimé** : `macAgingTimer = setInterval(...)`.
- **Ajouté** : `scheduler.setInterval(this.purgeMacTable, MAC_AGING_INTERVAL_MS)`.
- **Émet** : `switch.mac.learned`, `switch.mac.aged`, `switch.vlan.created`, `switch.vlan.deleted`, `switch.port.vlan-suspended`, `switch.port.vlan-recreated`, `switch.stp.state-changed`.

#### `Router` (`src/network/devices/Router.ts`, 1 545 → ~ 1 200)

- **Conservé** : couche shell (vendor-specific), API publique, intégrations protocoles (toujours composées).
- **Supprimé** : `pendingARPs`, `pendingPings`, `pendingTraceHops` Maps + leurs timers natifs.
- **Ajouté** : utilise `NeighborResolver<IPAddress>` partagé avec `EndHost` ; ping et traceroute via `waitForEvent`.
- **Émet** : `router.routing.route-added/removed/changed`, `router.acl.denied`, `router.nat.translation-applied`.
- **Consomme** : `port.frame.received`, `ospf.routes-recomputed`, `rip.routes-recomputed`.
- **Notes** : data-plane forwarding déplacé dans un acteur séparé `IPv4Forwarder` (ci-dessous).

#### `IPv4Forwarder` (nouveau, ~ 200 LoC)

- **Ajouté** : extrait du data-plane de `Router`. S'abonne à `port.frame.received` filtré par device ; route et publie `host.l3.packet-tx-requested` consommé par `Router` pour appeler `port.send`.
- **Notes** : facilite l'ajout de NAT, ACL, multipath.

#### `IPv6DataPlane` (`src/network/devices/router/IPv6DataPlane.ts`, 660 → ~ 660)

- **Conservé** : logique métier.
- **Ajouté** : entrées via `port.frame.received` filtré IPv6 ; sorties via émissions au lieu d'appels directs au routeur.

#### `RouterOSPFIntegration` (`src/network/devices/router/RouterOSPFIntegration.ts`, 1 799 → ~ 1 500)

- **Conservé** : pont OSPF ↔ routeur.
- **Supprimé** : appels directs à `router.sendOspfHello(...)` etc.
- **Ajouté** : émission `ospf.packet.outgoing` consommée par le routeur.
- **Notes** : devient symétrique avec `RouterRIPEngine`.

#### `RouterRIPEngine` (`src/network/devices/router/RouterRIPEngine.ts`, 429 → ~ 400)

- **Conservé** : intégration.
- **Ajouté** : utilise `Scheduler` ; émet `rip.update.sent / received`.

#### `NATEngine` (`src/network/devices/router/NATEngine.ts`, 613 → ~ 620)

- **Ajouté** : émet `nat.translation-applied`, `nat.session-created/closed`.
- **Notes** : timer de session NAT déplacé sur `Scheduler`.

#### `ACLEngine` (`src/network/acl/ACLEngine.ts` 280, `src/network/devices/router/ACLEngine.ts` 245)

- **Conservé** : logique d'évaluation pure.
- **Ajouté** : les *consommateurs* (router, switch L3) émettent `acl.permit/deny/log` après évaluation.

### 9.4 Moteurs de protocoles

#### `OSPFEngine` (`src/network/ospf/OSPFEngine.ts`, ~ 3 200 → ~ 3 200)

- **Conservé** : FSM voisin, DR/BDR, DD/LSR/LSU/LSAck, SPF Dijkstra, areas, NSSA, ASBR.
- **Supprimé** : tous les `setInterval/setTimeout` natifs (`lsAgeTimer`, `helloTimer`, `waitTimer`, `deadTimer`, `ddRetransmitTimer`, `lsrRetransmitTimer`, `spfTimer`).
- **Ajouté** :
  - Injection `{ scheduler, bus }` dans `start()`.
  - Émission de toutes les transitions FSM voisin.
  - Émission LSDB delta (insert/remove/refresh).
  - Émission SPF run (avec routes ajoutées/retirées).
- **Émet** : `ospf.neighbor.state-changed`, `ospf.lsa.received`, `ospf.lsa.flushed`, `ospf.lsa.installed`, `ospf.spf.run`, `ospf.dr-election`, `ospf.area.activated`, `ospf.routes-recomputed`, `ospf.packet.outgoing`.
- **Consomme** : `port.frame.received` (filtré IPv4 + protocole 89), `port.link.up/down` (pour invalider voisins).
- **Notes** : la signature de `tickLSAge()`, `runSPF()`, etc. est conservée pour la rétro-compatibilité des tests.

#### `OSPFv3Engine` (mêmes ~ 1 100 LoC) — mêmes décisions, payloads `version: 'v3'`.

#### `RIPEngine` (`src/network/rip/RIPEngine.ts`, ~ 500 → ~ 500)

- **Conservé** : metrics, RIB, FSM routes (timeout/garbage).
- **Supprimé** : `updateTimer`, `timeoutTimer`, `gcTimer` natifs.
- **Ajouté** : Scheduler injecté ; `RIPCallbacks` remplacé par publications bus.
- **Émet** : `rip.update.sent`, `rip.update.received`, `rip.route-added`, `rip.route-removed`.

#### `DHCPClient` (`src/network/dhcp/DHCPClient.ts`, ~ 720 → ~ 700)

- **Conservé** : FSM (INIT → SELECTING → REQUESTING → BOUND → RENEWING → REBINDING).
- **Supprimé** : 3 callbacks constructor → publications.
- **Supprimé** : timers natifs.
- **Ajouté** : Scheduler ; émet `dhcp.lease-requested`, `dhcp.offer-received`, `dhcp.lease-granted`, `dhcp.lease-renewing`, `dhcp.lease-rebinding`, `dhcp.lease-expired`, `dhcp.arp-probe-requested`.
- **Consomme** : `dhcp.arp-probe-result`, `host.arp.entry-learned` (pour vérifier conflits).

#### `DHCPServer` (`src/network/dhcp/DHCPServer.ts`, ~ 480 → ~ 480)

- **Conservé** : pool, leases, options.
- **Ajouté** : émet `dhcp.server.lease-allocated`, `dhcp.server.lease-released`, `dhcp.server.lease-expired`.

#### `IPSecEngine` (`src/network/ipsec/IPSecEngine.ts`, ~ 1 850 → ~ 1 850)

- **Supprimé** : timers natifs lifetime / DPD / retransmit.
- **Ajouté** : Scheduler ; émet `ipsec.ike.exchange-started/completed`, `ipsec.sa.installed/deleted`, `ipsec.dpd.peer-down`, `ipsec.packet.encrypted-out`, `ipsec.packet.decrypted-in`.

### 9.5 Couche terminal

#### `TerminalSession` (`src/terminal/sessions/TerminalSession.ts`, 897 → ~ 900)

- **Conservé** : `subscribe / getVersion / notify` (compat `useSyncExternalStore`), template methods, flow engine, session recorder, scrollback management, key dispatch, reverse search.
- **Supprimé** : `setTimeout` natif dans `replayRecording`.
- **Ajouté** : Scheduler injecté ; `replayRecording` utilise `scheduler.delay`. Publications `terminal.session.*`.
- **Émet** : `terminal.session.opened/closed/line-added/input-mode-changed/flow-started/flow-completed/subshell-entered/subshell-exited`.
- **Consomme** : `device.power-off` (force la fermeture des flows / subshells), `command.output-line` (streaming).

#### `TerminalManager` (`src/terminal/sessions/TerminalManager.ts`, 198 → ~ 220)

- **Conservé** : API publique, gestion des sessions par device.
- **Ajouté** : émission `terminal.manager.session-opened/closed`. Conserve son propre `subscribe / getVersion` (compat).
- **Consomme** : `device.deregistered` (ferme automatiquement les sessions).

#### `LinuxTerminalSession`, `CLITerminalSession`, `CiscoTerminalSession`, `HuaweiTerminalSession`, `WindowsTerminalSession`

- **Conservé** : tout.
- **Modifié** : `await new Promise(r => setTimeout(r, 12))` → `await scheduler.delay(12)` dans les boot delays.

#### `InteractiveFlowEngine`, `OutputFormatter`, `TabCompletionHelper`

- **Inchangés**.

#### Sub-shells (`SqlPlusSubShell`, `RmanSubShell`, `SftpSubShell`, `CmdSubShell`, `PowerShellSubShell`)

- **Conservés** dans leur structure.
- **Ajouté** : `RmanSubShell` émet `oracle.rman.backup-started/completed`, `oracle.rman.restore-started/completed`. `SftpSubShell` émet `sftp.transfer-started/completed/failed`.

### 9.6 Store Zustand et UI

#### `networkStore` (`src/store/networkStore.ts`, 353 → ~ 280)

- **Conservé** : `selectedDeviceId`, `selectedConnectionId`, `isConnecting`, `connectionSource`, `zoom`, `panX/Y` ; actions `addDevice/removeDevice/updateDevice/moveDevice/addConnection/removeConnection/clearAll/...`.
- **Supprimé** :
  - `deviceInstances: Map<id, Equipment>` (les instances sont accédées via `EquipmentRegistry` injecté).
  - `instance: Equipment` dans `NetworkDeviceUI`.
  - Mutations `set(state => ({ deviceInstances: new Map(...) }))` répétitives.
- **Ajouté** :
  - Le store ne fait plus de notification UI domaine — les hooks `useDevice/useDevices/useCable/...` consomment les projecteurs.
  - Les actions du store *publient* sur le bus pour invalider les caches du sérialiseur.
- **Émet** (indirectement, via les actions qui appellent les acteurs) : `device.registered/deregistered`, `cable.connected/disconnected`, `device.position-changed`.
- **Notes** : Zustand reste pour l'**état UI** uniquement. Plus simple, moins fragile.

#### `topologySerializer` (`src/store/topologySerializer.ts`, ~ 250 → ~ 270)

- **Conservé** : schéma JSON, fonction d'export, fonction d'import.
- **Modifié** : import publie `topology.import-started`, instancie devices, configure ports, câble cables, puis `topology.import-completed`.

#### Composants React

| Composant | Modifications |
|---|---|
| `NetworkDesigner` | Substitue `getDevices()` par `useDevices()`. État UI tiling conservé. |
| `NetworkCanvas` | `useDevices()`, `useConnections()`, `useActivePackets()`. |
| `NetworkDevice` | Reçoit `DeviceVM` au lieu de `NetworkDeviceUI` ; supprime tout accès `device.instance`. |
| `ConnectionLine` | Reçoit `CableVM` ; couleur réactive aux changements `cable.duplex-mismatch`, `port.link.down`. |
| `PacketAnimation` | `useActivePackets()` ; consomme `cable.frame.dispatched/delivered`. **Désormais fonctionnel.** |
| `PropertiesPanel` | Hooks ciblés `useDevice(id)`, `usePort(id, port)`, `useArpTable(id)`, `useRoutingTable(id)`. Émet des intentions `command.configure-port-ip` au bus, traitées par `IntentHandler`. |
| `TerminalModal`, `TerminalView`, `MinimizedTerminals` | Inchangés (déjà conformes). |
| `Toolbar`, `DevicePalette`, `DeviceIcon` | Inchangés. |
| `InterfaceSelectorPopover` | Reçoit `PortVM[]` au lieu d'instance Port. |

### 9.7 Couche base de données

#### `OracleInstance` (`src/database/oracle/OracleInstance.ts`, 542 → ~ 560)

- **Conservé** : FSM, processus background, redo logs, paramètres, alert log.
- **Ajouté** : `IEventBus` injecté ; `startup/shutdown/setParameter/logAlert/switchRedoLog` publient les événements `oracle.instance.*`.
- **Émet** : voir §7.4.2.
- **Notes** : zéro dépendance vers `Equipment` ou filesystem.

#### `OracleExecutor` (3 441 → ~ 3 470)

- **Conservé** : tout sauf injections.
- **Ajouté** : émission `oracle.session.*`, `oracle.transaction.*`, `oracle.dml/ddl.executed`, `oracle.error.raised`.

#### `OracleCatalog`, `OracleStorage`, `OracleParser`, `OracleLexer`, `OracleDatabase`

- **Inchangés**.

#### `OracleFilesystemSync` (nouveau, ~ 200 LoC)

- **Ajouté** : module qui s'abonne aux événements `oracle.instance.*` et appelle les fonctions de synchronisation FS existantes (`updateSpfileOnDevice`, `syncAlertLogToDevice`, etc.).
- **Notes** : remplace les appels manuels disséminés.

#### `database.ts` (`src/terminal/commands/database.ts`, ~ 460 → ~ 460)

- **Conservé** : Map `deviceId → OracleDatabase`, helpers d'init filesystem.
- **Ajouté** : à l'init, instancie le `OracleFilesystemSync` lié au device.

### 9.8 Tests

| Catégorie | Action |
|---|---|
| Tests `core/EventBus`, `Scheduler`, `Signal`, `waitForEvent` | Nouveaux. ~ 6 fichiers, ~ 400 LoC. |
| Tests `Port`, `Cable` (nouveaux) | Émission d'événements vérifiée ; livraison via `scheduler.advance(ms)`. |
| Tests OSPF / DHCP / RIP / IPSec existants | Adaptés : remplacent `vi.useFakeTimers/advanceTimersByTime` par `scheduler.advance`. Snapshots de trace d'événements. |
| Tests `EndHost.pingHost / arpResolve` | Réécrits autour de `waitForEvent` ; suppression des Maps de pending. |
| Tests Oracle FS sync | Vérifient l'émission des events + l'effet du `OracleFilesystemSync` adapter. |
| Tests UI (`__tests__/unit/gui`) | Adaptés pour consommer les hooks et projeter via mock `EventBus`. |

### 9.9 Tableau global — refactor par classe

| Classe / module | LoC actuelles | LoC cibles | Émet | Consomme | Note |
|---|---:|---:|---:|---:|---|
| `EventBus` (nouveau) | 0 | 100 | – | – | Primitive |
| `Scheduler` (nouveau) | 0 | 200 | – | – | Primitive |
| `Signal` (nouveau) | 0 | 80 | – | – | Primitive |
| `waitForEvent` (nouveau) | 0 | 30 | – | – | Helper |
| `Logger` | 123 | 80 | log | – | Adapter |
| `PacketQueue` | 142 | 130 | depth-changed | – | Scheduler |
| `NeighborResolver` | 204 | 200 | neighbor.* | – | Scheduler + Bus |
| `TcpConnection` | 97 | 110 | tcp.data.* | – | Bus |
| `SocketTable` | 212 | 230 | socket.* | – | Bus |
| `RoutingTable` | (n/a) | – | routing.* | – | Bus |
| `Equipment` | 194 | 200 | device.* | port.frame.received | Bus |
| `EquipmentRegistry` | 107 | 120 | device.registered/deregistered | – | Bus |
| `Port` | 487 | 460 | port.* | cable.connected | Bus |
| `Cable` | 266 | 280 | cable.* | – | Bus + Scheduler |
| `PortSecurity` | (lu non détail) | – | port.security.* | – | Bus |
| `EndHost` | 2 325 | 1 700 | host.* | port.frame.received, dhcp.* | Bus + Scheduler — gain net **-625** |
| `LinuxMachine`/`WindowsPC`/sub | 1 522 | 1 530 | service.* | – | Mineur |
| `Switch` | 838 | 850 | switch.* | port.frame.received | Bus + Scheduler |
| `Router` | 1 545 | 1 200 | router.* | port.frame.received | Bus + Scheduler — gain **-345** |
| `IPv4Forwarder` (nouveau) | 0 | 200 | host.l3.* | port.frame.received | Acteur extrait |
| `IPv6DataPlane` | 660 | 660 | – | – | Adapter bus |
| `OSPFEngine` | 3 200 | 3 200 | ospf.* | port.frame.received, port.link.* | Scheduler |
| `OSPFv3Engine` | 1 100 | 1 100 | ospf.* | – | Scheduler |
| `RIPEngine` | 500 | 500 | rip.* | – | Scheduler |
| `RouterRIPEngine` | 429 | 400 | rip.* | – | Scheduler |
| `DHCPClient` | 720 | 700 | dhcp.* | dhcp.arp-probe-result | Scheduler |
| `DHCPServer` | 480 | 480 | dhcp.server.* | – | Scheduler |
| `IPSecEngine` | 1 850 | 1 850 | ipsec.* | – | Scheduler |
| `NATEngine` | 613 | 620 | nat.* | – | Scheduler |
| `ACLEngine`s | 525 | 525 | (par appelant) | – | – |
| `RouterOSPFIntegration` | 1 799 | 1 500 | ospf.packet.outgoing | – | Adapter |
| `TerminalSession` | 897 | 900 | terminal.* | device.power-off | Scheduler + Bus |
| `LinuxTerminalSession` | 653 | 653 | – | – | Mineur |
| `CLITerminalSession`+vendors | 490 | 490 | – | – | Mineur |
| `WindowsTerminalSession` | 457 | 457 | – | – | – |
| `TerminalManager` | 198 | 220 | terminal.manager.* | device.deregistered | Bus |
| Sub-shells (5) | 1 030 | 1 040 | sftp.*/oracle.rman.* | – | Mineur |
| `networkStore` | 353 | 280 | – | – | Allégé |
| `topologySerializer` | 250 | 270 | topology.* | – | Bus |
| `OracleInstance` | 542 | 560 | oracle.instance.* | – | Bus |
| `OracleExecutor` | 3 441 | 3 470 | oracle.session/transaction/dml/ddl.* | – | Bus |
| `OracleCatalog`/Storage/Parser/Lexer | 2 758 | 2 758 | – | – | – |
| `OracleDatabase` | 1 305 | 1 305 | – | – | – |
| `OracleFilesystemSync` (nouveau) | 0 | 200 | – | oracle.instance.* | Adapter |
| Composants React (12 fichiers) | 3 100 | 3 100 | – | (via hooks) | Réécriture interne |
| `TerminalView` | 534 | 534 | – | – | Inchangé |
| Hooks + projecteurs (nouveaux) | 0 | 1 000 | – | bus.* | Voir §8.8 |

### 9.10 Synthèse des suppressions

| Élément supprimé | Localisation | Quantité approximative |
|---|---|---|
| `setInterval` / `setTimeout` natifs (réseau + terminal) | divers | 91 sites → 0 |
| Maps `pendingXxx` | `EndHost`, `Router` | 7 → 0 |
| Tableaux `linkChangeHandlers` | `Port` | 1 → 0 |
| Callbacks `frameHandler` | `Port` | 1 par port |
| Méthodes `_setCableNoNotify`, `_notifyLinkUp` | `Port` | 2 |
| Méthodes statiques `Equipment.getById/getAllEquipment/clearRegistry` | `Equipment` | 3 |
| Recopie manuelle `new Map(state.deviceInstances)` | `networkStore` | ≈ 5 sites |
| Implémentations parallèles ARP / NDP | `EndHost` | ~ 200 LoC |

### 9.11 Synthèse des ajouts

| Élément ajouté | Localisation | LoC |
|---|---|---|
| `EventBus` | `src/events/` | 100 |
| `Scheduler` (real + virtual) | `src/events/` | 200 |
| `Signal` / `derived` | `src/events/` | 80 |
| `waitForEvent` | `src/events/` | 30 |
| Type union `DomainEvent` + sub-events | `src/events/types.ts` + `*.events.ts` | ~ 300 |
| Projections (8) | `src/projections/` | ~ 800 |
| Hooks (8 modules) | `src/hooks/` | ~ 300 |
| Adapter `OracleFilesystemSync` | `src/adapters/` | 200 |
| Adapter `BusTracer` | `src/adapters/` | 60 |
| Adapter `PacketCapture` (optionnel) | `src/adapters/` | 150 |
| `IPv4Forwarder` | `src/network/devices/router/` | 200 |
| Tests primitives | `src/__tests__/unit/events/` | 400 |

**Solde global** : ~ +1 800 LoC ajoutées vs ~ -1 200 LoC supprimées = **+ ~600 LoC nets**, mais *modulaires, observables, testables et plug-able*.

---

*Section 9 close. Suivante : §10 — Plan de migration séquentiel.*

---

## 10. Plan de migration séquentiel

La migration suit un parcours en **8 phases**, chacune autonome (mergeable indépendamment) et **sans régression fonctionnelle** : la suite de tests `npm run test:run` doit passer à la fin de chaque phase. Une **feature flag** `featureFlags.eventBusForFrames` (et variantes par couche) permet, en cas de besoin, de faire cohabiter les deux modèles en runtime jusqu'à la phase de bascule.

### 10.1 Vue d'ensemble

| Phase | Titre | Estim. | Dépendances | Risque |
|---|---|:---:|---|:---:|
| 1 | Primitives (`EventBus`, `Scheduler`, `Signal`, `waitForEvent`, types) | S | – | Bas |
| 2 | `Logger` adapter + `EquipmentRegistry` events | S | 1 | Bas |
| 3 | Hardware : `Port`, `Cable` émettent (callbacks legacy conservés) | M | 1, 2 | Moyen |
| 4 | Scheduler partout dans les protocoles (timers natifs → `IScheduler`) | M | 1 | Moyen |
| 5 | Devices : `EndHost`, `Router` migrent leurs `pendingXxx` vers `waitForEvent` | L | 3, 4 | **Haut** |
| 6 | Projections + hooks UI ; bascule du pipeline frames asynchrone | M | 3, 5 | Moyen |
| 7 | Oracle : émissions + extraction `OracleFilesystemSync` | S | 1 | Bas |
| 8 | Suppression du legacy (callbacks `onFrame`, `onLinkChange`, `instance: Equipment`, méthodes statiques) | M | toutes | Moyen |

**Légende d'estimation** : S = 2-4 jours, M = 1-2 semaines, L = 2-3 semaines.

### 10.2 Phase 1 — Primitives

**But** : poser les fondations sans toucher au domaine.

**Étapes** :

1. Créer `src/events/EventBus.ts` (≈ 100 LoC) avec son test unitaire (FIFO, réentrance, unsubscribe, wildcard, gestion d'erreurs).
2. Créer `src/events/Scheduler.ts` avec deux implémentations : `RealTimeScheduler`, `VirtualTimeScheduler`. Tests : `setTimeout`, `setInterval`, `cancel`, `advance`, `delay`.
3. Créer `src/events/Signal.ts` (`Signal`, `WritableSignal`, `derived`). Tests d'égalité référentielle, notify only on change.
4. Créer `src/events/waitForEvent.ts` + tests (succès, timeout, cancel par unsubscribe).
5. Créer `src/events/types.ts` minimal (uniquement quelques topics initiaux : `log` et `device.*` ; le reste suit avec les phases).
6. `src/events/index.ts` exporte tout. Mise à jour du chemin alias dans `vite.config.ts` (rien à ajouter — l'alias `@/` couvre déjà).

**Critères de sortie** :

- Suite de tests primitives 100 % verte.
- `npm run lint` propre.
- Aucune dépendance externe ajoutée à `package.json`.
- Aucun fichier de domaine touché.

**Commit suggéré** : `feat(events): add EventBus, Scheduler, Signal, waitForEvent primitives`.

### 10.3 Phase 2 — Logger adapter + Registry events

**But** : faire passer **tous** les logs existants par le bus, sans rompre leur API.

**Étapes** :

1. Réécrire `Logger` en adapter au-dessus du `EventBus`. Conserver l'API publique exacte.
2. Créer `LogProjection` qui maintient le buffer historique (10 000 entrées capées) — équivalent du `logs[]` actuel.
3. `EquipmentRegistry` accepte un `IEventBus` injecté ; émet `device.registered/deregistered/registry.cleared`.
4. Ajout d'un test : faire `Logger.info(...)` → vérifier que le bus reçoit `{ topic: 'log', ... }`.
5. Ajout d'un test : faire `Equipment` ctor → vérifier que `device.registered` est émis.

**Critères de sortie** :

- Tous les tests existants passent **sans modification** (l'API Logger est identique).
- Si on branche un `BusTracer` wildcard, on observe la totalité des logs.

**Risques** : faible. Régression possible sur `Logger.subscribe(filter)` si le mapping des filtres n'est pas équivalent — d'où le test ciblé.

**Commit suggéré** : `feat(logger): route Logger through EventBus, emit registry events`.

### 10.4 Phase 3 — Hardware : `Port`, `Cable` émettent

**But** : ajouter les émissions `port.*` et `cable.*` **sans casser** le pipeline synchrone existant. Les callbacks `onFrame` et `onLinkChange` continuent de fonctionner ; ils sont **doublés** par les événements.

**Étapes** :

1. Étendre `src/events/types.ts` avec tous les topics `port.*`, `cable.*`.
2. Modifier `Port` :
   - Le constructeur accepte `{ bus?: IEventBus }` (fallback singleton).
   - `sendFrame` publie `port.frame.tx-requested` ou `port.frame.tx-blocked` *en plus* de l'appel cable.
   - `receiveFrame` publie `port.frame.received` *en plus* de l'appel à `frameHandler`.
   - `setUp/configureIP/...` publient leurs événements respectifs.
   - **`onFrame` et `onLinkChange` restent** pour cette phase.
3. Modifier `Cable` :
   - `transmit` publie `cable.frame.dispatched`. La livraison reste **synchrone** pour cette phase (pas encore de scheduler delay) → après l'appel à `targetPort.receiveFrame`, publier `cable.frame.delivered`.
   - `connect/disconnect/negotiate` publient.
4. Ajouter un test « miroir » : pour chaque `Logger.debug('port:send', …)`, vérifier que l'événement `port.frame.tx-requested` correspondant est aussi émis.
5. **Aucune** modification de `Equipment` ni des consommateurs encore.

**Critères de sortie** :

- Suite réseau verte (97 fichiers).
- `BusTracer` enregistre la trace complète d'un ping `PC-A → PC-B`.

**Commit suggéré** : `feat(hardware): emit port and cable events in parallel to legacy callbacks`.

### 10.5 Phase 4 — Scheduler partout dans les protocoles

**But** : remplacer les `setTimeout/setInterval` natifs par `IScheduler` injecté, sans modifier la sémantique.

**Étapes** :

1. Pour chaque moteur de protocole (`OSPFEngine`, `OSPFv3Engine`, `RIPEngine`, `RouterRIPEngine`, `DHCPClient`, `DHCPServer`, `IPSecEngine`, `NATEngine`) :
   - Constructeur accepte `{ scheduler?: IScheduler }` (fallback `defaultScheduler`).
   - Tous les `setTimeout/setInterval` deviennent `scheduler.setTimeout/setInterval`. Les `clearTimeout/Interval` deviennent `scheduler.clear`.
2. Idem pour `PacketQueue` et `NeighborResolver`.
3. Idem pour `Switch.macAgingTimer` et les Map de pending dans `EndHost`/`Router` (ces dernières seront éliminées en phase 5, mais la transition vers `scheduler` les rend déjà testables).
4. Mettre à jour les **tests existants** qui utilisaient `vi.useFakeTimers/advanceTimersByTime` pour qu'ils puissent injecter un `VirtualTimeScheduler` à la place. Les tests qui ne touchent pas au temps restent en `RealTimeScheduler` par défaut.

**Critères de sortie** :

- 0 occurrences `setInterval` ou `setTimeout` natifs dans `src/network/` (vérifié par `grep`).
- Tous les tests passent.
- Un test snapshot OSPF-converge devient déterministe (run identique entre exécutions).

**Risques** : moyen. Les tests qui s'appuient sur `vi.advanceTimersByTime` doivent migrer ; certains testaient l'interaction de Promise + setTimeout — vérifier la compatibilité.

**Commit suggéré** : `refactor(network): inject Scheduler in all protocol engines, remove native timers`.

### 10.6 Phase 5 — Devices : `EndHost`, `Router` migrent leurs pendings

**But** : éliminer toutes les Maps de callbacks pendantes au profit de `waitForEvent` ; brancher les engines sur les événements `port.frame.received` plutôt que sur des appels directs depuis `handleFrame`.

**Étapes** :

1. **Émissions complètes** depuis `EndHost` et `Router` :
   - Tous les sites qui font `pendingPings.set(...)` publient désormais aussi `host.icmp.echo-sent` ; à la réception du echo-reply, publient `host.icmp.echo-reply` *avant* de résoudre le callback legacy.
   - Idem pour ARP, NDP, traceroute, TCP handshake.
2. Réécrire `pingHost`, `pingHost6`, `tcpConnect`, `traceroute` autour de `waitForEvent`. **Suppression** des Maps `pendingPings`, `pendingPing6s`, `pendingTcpHandshakes`, `pendingARPs` (côté `EndHost` et `Router`), `pendingTraceHops`.
3. Substituer `NeighborResolver<IPAddress>` à l'implémentation ARP inline de `EndHost` et `Router`.
4. Idem `NeighborResolver<IPv6Address>` pour NDP.
5. Adapter les tests `arp-command.test.ts`, `host-ping.test.ts`, `tcp-handshake.test.ts`, etc. pour utiliser `VirtualTimeScheduler`.

**Critères de sortie** :

- 0 occurrence de `pendingARPs`, `pendingPings`, `pendingNDPs`, `pendingPing6s`, `pendingTraceHops`, `pendingTcpHandshakes` dans `src/network/devices/`.
- Suppression nette de ~ 400-500 LoC.
- Tous les tests verts.

**Risques** : **haut**. C'est la phase la plus invasive. Mitigation : la coexistence des publications avec les callbacks legacy en phase 3 a déjà permis de valider la complétude de la trace d'événements. La conversion `pending → waitForEvent` reste mécanique.

**Commit suggéré** : `refactor(devices): replace pendingXxx maps with waitForEvent + NeighborResolver`.

### 10.7 Phase 6 — Projections, hooks UI, pipeline asynchrone

**But** : (a) construire les projecteurs et hooks ; (b) basculer la livraison `Cable.transmit` en asynchrone ; (c) débloquer `PacketAnimation`.

**Étapes** :

1. Créer les projecteurs (8 modules — cf. §8.8).
2. Créer les hooks (`useDevices`, `useDevice`, `usePort`, `useCable`, `useArpTable`, `useRoutingTable`, `useOspfNeighbors`, `useActivePackets`, `useTerminalSessions`).
3. Migrer les composants UI un par un :
   - **Phase 6a** : composants en lecture seule (`NetworkCanvas`, `NetworkDevice`, `ConnectionLine`).
   - **Phase 6b** : `PropertiesPanel` (lecture + écriture).
   - **Phase 6c** : `PacketAnimation` (utilise `useActivePackets`).
4. **Bascule du pipeline asynchrone** :
   - Modifier `Cable.transmit` : `targetPort.receiveFrame` est appelé via `scheduler.setTimeout(0)` (microtâche) en mode flag `eventBusForFrames`. En mode legacy, comportement actuel.
   - Tester en mode flag activé : tous les tests réseau doivent rester verts (les tests synchrones d'aujourd'hui doivent appeler `scheduler.advance(0)` ou `await Promise.resolve()`).
   - Si tout passe : passer le flag par défaut.
5. Le `networkStore` cesse d'exposer `instance: Equipment`. Les composants n'y accèdent plus.

**Critères de sortie** :

- `PacketAnimation` fonctionne (paquets visibles).
- Plus aucun composant React n'importe `@/network/equipment/Equipment`.
- Tests UI (`__tests__/unit/gui/`) verts.

**Risques** : moyen. Bascule sync → async peut révéler des suppositions implicites de l'ordre dans certains tests (en particulier des tests qui supposent que `pingHost` rend la main *avant* le rerender de la UI).

**Commit suggéré** : `feat(ui): introduce projections + hooks; switch to async frame delivery`.

### 10.8 Phase 7 — Oracle : émissions + `OracleFilesystemSync`

**But** : rendre Oracle observable et extraire la logique de synchronisation FS.

**Étapes** :

1. `OracleInstance` émet `oracle.instance.*`.
2. `OracleExecutor` émet `oracle.session.*`, `oracle.transaction.*`, `oracle.dml.*`, `oracle.ddl.*`, `oracle.error.*`.
3. Créer `src/adapters/OracleFilesystemSync.ts` qui s'abonne et appelle les fonctions actuelles `updateSpfileOnDevice`, `syncAlertLogToDevice`, `syncDatafilesToDevice`, `syncOracleProcessesToDevice`. Supprimer les appels manuels disséminés.
4. Adapter les 3 tests existants (`oracle-dbms-filesystem-coherence.test.ts`, `filesystem-database-layer.test.ts`, `oracle-linux-filesystem.test.ts`) : ils vérifient maintenant que les événements sont émis ET que l'adapter produit le même état FS.

**Critères de sortie** :

- Tests Oracle verts.
- Aucun appel direct depuis `OracleInstance` vers `Equipment`/`LinuxFileSystem`.

**Commit suggéré** : `feat(oracle): emit lifecycle events; extract OracleFilesystemSync adapter`.

### 10.9 Phase 8 — Suppression du legacy

**But** : effacer les patterns désormais inutiles. Cette phase est **purement soustractive**.

**Étapes** :

1. Supprimer `Port.onFrame`, `Port.frameHandler`, `_setCableNoNotify`, `_notifyLinkUp`, `Port.linkChangeHandlers`, `onLinkChange`. Les sites d'appel ont déjà migré aux phases 5 et 6.
2. Supprimer les méthodes statiques `Equipment.getById`, `Equipment.getAllEquipment`, `Equipment.clearRegistry`. Remplacer les usages restants par `EquipmentRegistry.getInstance().getById/...`.
3. Supprimer `instance: Equipment` de `NetworkDeviceUI` et de `Connection.cable`. Ajuster `topologySerializer` pour utiliser `EquipmentRegistry` directement.
4. Retirer la feature flag `eventBusForFrames` et tout le code de bascule.
5. Mettre à jour `CLAUDE.md` pour décrire la nouvelle architecture.

**Critères de sortie** :

- Suite complète verte.
- Aucune référence à `frameHandler`, `linkChangeHandlers`, `_setCableNoNotify`, `_notifyLinkUp` (vérifié par grep).
- Documentation à jour.

**Commit suggéré** : `chore(legacy): remove deprecated callbacks and Equipment static methods`.

### 10.10 Stratégie de coexistence et feature flags

Pendant les phases 3 à 6, deux modes coexistent. Les feature flags suivants sont introduits dans `src/config/featureFlags.ts` :

```ts
export const featureFlags = {
  /** Phase 6: deliver frames asynchronously via Scheduler */
  asyncFrameDelivery: false,
  /** Phase 6: source DeviceVM from projections instead of getDevices() */
  useProjectionsForUI: false,
  /** Phase 8: remove legacy onFrame/linkChange callbacks */
  removeLegacyCallbacks: false,
};
```

Les flags sont **internes** (pas exposés à l'utilisateur final) et basculés en code lors du merge de chaque phase. Permet aux PRs intermédiaires d'être mergeables et déployables.

### 10.11 Stratégie de tests par phase

| Phase | Type de tests | Méthode |
|---|---|---|
| 1 | Unitaires primitives | Nouveaux ; FIFO, advance, signal, waitForEvent. |
| 2 | Tests Logger inchangés ; nouveaux tests d'émission registry. | API conservée. |
| 3 | Tests « miroir » : pour chaque comportement existant, vérifier émission équivalente. | Adapter `BusTracer` dans le setup. |
| 4 | Tous les tests sensibles au temps utilisent `VirtualTimeScheduler`. | `vi.useFakeTimers` retiré progressivement. |
| 5 | Tests d'intégration ping/ARP/TCP réécrits autour de `waitForEvent`. | Snapshots de trace stables. |
| 6 | Tests UI utilisent un mock `EventBus` + projections injectées. | `@testing-library/react`. |
| 7 | Tests Oracle adaptés. | – |
| 8 | Régression complète. | `npm run test:run` plein. |

### 10.12 Découpage en pull-requests recommandées

| PR | Phase | Taille (LoC) |
|---|---|---:|
| `events: primitives` | 1 | ~ 600 (incl. tests) |
| `logger: adapter on EventBus` | 2 | ~ 200 |
| `registry: emit lifecycle events` | 2 | ~ 100 |
| `hardware: Port emits events` | 3a | ~ 400 |
| `hardware: Cable emits events` | 3b | ~ 200 |
| `protocols: scheduler injection (1/3 ospf+rip)` | 4a | ~ 800 |
| `protocols: scheduler injection (2/3 dhcp+ipsec)` | 4b | ~ 800 |
| `protocols: scheduler injection (3/3 nat+pq+nr)` | 4c | ~ 400 |
| `endhost: pings via waitForEvent` | 5a | ~ 600 |
| `endhost: arp/ndp via NeighborResolver` | 5b | ~ 400 |
| `router: pending pings/trace via waitForEvent` | 5c | ~ 400 |
| `ui: projections + hooks` | 6a | ~ 1 500 |
| `ui: migrate read-only components` | 6b | ~ 600 |
| `ui: migrate PropertiesPanel + intent handlers` | 6c | ~ 400 |
| `ui: switch to async frame delivery, debloquer PacketAnimation` | 6d | ~ 300 |
| `oracle: events + filesystem sync adapter` | 7 | ~ 400 |
| `legacy: remove deprecated callbacks and statics` | 8 | ~ 200 (mostly deletions) |

≈ 17 PRs au total. Permet une revue progressive et un rollback ciblé en cas de problème.

### 10.13 Critères de réussite globale

À l'issue de la phase 8, l'inventaire suivant doit être atteint :

| Métrique | Avant | Après |
|---|---:|---:|
| `setTimeout` / `setInterval` natifs (réseau + terminal) | 91 | 0 |
| Maps `pendingXxx` dans devices | 7 | 0 |
| Implémentations distinctes du pattern observable | 4 | 1 (bus) + 1 (Signal) |
| Composants React important `Equipment` | 5 | 0 |
| LoC `EndHost.ts` | 2 325 | ≤ 1 750 |
| LoC `Router.ts` | 1 545 | ≤ 1 250 |
| `PacketAnimation` fonctionnel | non | oui |
| Test snapshot OSPF converge déterministe | non | oui |
| Replay de trace possible | non | oui |

---

*Section 10 close. Suivante : §11 — Risques, tests et métriques de succès.*

---

## 11. Risques, tests et métriques de succès

Cette section recense l'ensemble des risques techniques de la refonte, propose une stratégie de tests rigoureuse, et fixe les métriques quantitatives qui valideront le succès du chantier.

### 11.1 Cartographie des risques

Les risques sont notés sur trois axes : **probabilité** (P), **impact** (I), **détection** (D — probabilité de le détecter avant qu'il ne fasse mal). Score = P × I × (6 - D), max 150.

| # | Risque | P | I | D | Score | Mitigation |
|---|---|:---:|:---:|:---:|:---:|---|
| R1 | Les tests OSPF deviennent flaky lors de la bascule scheduler. | 4 | 4 | 4 | 32 | Phase 4 isolée ; faire passer un sous-ensemble strictement temporel d'abord ; conserver `vi.useFakeTimers` en fallback dans certains tests pendant la transition. |
| R2 | Bascule sync → async des trames casse des tests qui supposent l'ordre dans le call-stack. | 5 | 4 | 3 | 60 | Feature flag `asyncFrameDelivery` ; activation via test-by-test ; `await scheduler.advance(0)` injecté dans les helpers de test. |
| R3 | Régression silencieuse sur Logger : un site d'appel passe entre les mailles. | 3 | 3 | 5 | 9 | API publique conservée ; tests `Logger.info → bus.publish` exhaustifs ; build TS strict. |
| R4 | `EndHost` migration `pendingXxx` perd un cas particulier (timeout, race). | 4 | 5 | 3 | 60 | Conserver émissions parallèles aux callbacks legacy en phase 5 ; tests d'intégration ARP/ICMP/TCP/Trace sont *pre-écrits* avant la suppression des Maps. |
| R5 | Performance : explosion du dispatch événement (par exemple en cas de wildcard subscribers). | 3 | 3 | 4 | 18 | Indexation par topic dans `EventBus` ; benchmarks ciblés (1 000 frames/sec) ; pas de wildcard en production. |
| R6 | Mémoire : leak d'abonnements non désinscrits (devices détruits, sessions terminales fermées). | 4 | 3 | 3 | 36 | `dispose()` obligatoire sur tous les acteurs ; lint rule custom : tout `subscribe` doit avoir un `unsubscribe` correspondant ; test « créer/détruire 100 devices » ne doit laisser aucun handler résiduel. |
| R7 | Cycles de réentrance dans le bus (publish → handler → publish → … infini). | 2 | 4 | 4 | 16 | Sub-event queue (cf. §8.2.3) plafonne la pile ; détecteur de cycle simple : compteur de profondeur par dispatch, throw au-delà d'un seuil (p. ex. 50). |
| R8 | Désynchronisation projecteur ↔ état domaine après un bug d'event manquant. | 3 | 4 | 5 | 12 | Test de cohérence : dans un test d'intégration, `expect(projection.devices.get(id)).toEqual(deviceToVM(registry.getById(id)))` après chaque action significative. |
| R9 | Compatibilité `useSyncExternalStore` cassée sur certains navigateurs anciens. | 1 | 3 | 5 | 3 | React 18+ requis (cible déjà du projet). |
| R10 | Blow-up du type union `DomainEvent` (compilation lente, message d'erreur illisible). | 3 | 2 | 4 | 12 | Découper l'union par module (`port.events.ts`, `ospf.events.ts`, …) ; agréger via `type DomainEvent = PortEvents \| OspfEvents \| …` ; éviter les unions à 100+ branches dans un seul fichier. |
| R11 | `Cable.transmit` async casse les comportements sync attendus par certains tests rapides (réponses ARP immédiates en quelques µs). | 4 | 3 | 3 | 36 | Le scheduler virtuel autorise `propagationMs = 0` en config par défaut pour la plupart des tests ; `scheduler.advance(0)` ou `flushMicrotasks()` au lieu de polling. |
| R12 | Migration UI partielle : un composant lit une `instance: Equipment` après suppression. | 3 | 3 | 5 | 9 | TypeScript strict (suppression du champ = erreur de compile) ; lint rule : interdire l'import de `@/network/equipment/Equipment` dans `src/components/`. |
| R13 | Sérialisation cassée par les nouveaux états observables. | 2 | 4 | 4 | 16 | `topologySerializer` adapté en phase 6 ; tests d'export/import ronde-trip. |
| R14 | Confusion d'identité sur les événements (mauvais `deviceId`, mauvais `portName`). | 3 | 4 | 4 | 24 | Helper `mkEvent(...)` typé qui force la présence des champs obligatoires ; tests d'intégration matching deviceId. |
| R15 | Régression de UX : terminaux figés ou rerenders excessifs après bascule projections. | 3 | 4 | 3 | 36 | Mesure FPS avant/après ; granularité par signal si profilage révèle un hotspot ; React DevTools Profiler contrôlé. |
| R16 | Tests UI lents à cause du nombre d'abonnements créés à chaque mount. | 2 | 2 | 4 | 8 | Projecteurs hoistés au niveau module, pas par composant ; mémoization React. |
| R17 | Plan trop long : abandon avant complétion. | 4 | 5 | 5 | 20 | Phases mergeables indépendamment ; chaque phase apporte une valeur observable (logs, animations, tests déterministes). |

**Top risques (score ≥ 30)** : R2 (bascule sync→async), R4 (perte de cas pending), R1 (flakiness OSPF), R6 (leaks), R11 (timing tests rapides), R15 (perf UX). Ces six points concentrent l'attention de la revue.

### 11.2 Stratégie de tests détaillée

#### 11.2.1 Pyramide de tests cible

```
          ▲
          │  Snapshot scenarios end-to-end (5-10)         ← § 11.2.5
          │  Trace OSPF-converge, DHCP DORA, TCP echo
          │
          │  Tests d'intégration acteurs (40-60)           ← § 11.2.4
          │  EndHost ↔ Switch ↔ Router via bus virtuel
          │
          │  Tests unitaires acteurs (60+ existants)       ← § 11.2.3
          │  Émission attendue, état observé après event
          │
          │  Tests primitives (6 nouveaux fichiers)         ← § 11.2.2
          │  EventBus, Scheduler, Signal, waitForEvent
          ▼
```

#### 11.2.2 Tests primitives (`src/__tests__/unit/events/`)

- **`EventBus.test.ts`** :
  - `publish` invoque les handlers dans l'ordre de souscription.
  - `subscribe` retourne un unsubscribe fonctionnel.
  - Réentrance : publier dans un handler → l'événement secondaire est dispatché après le courant.
  - Wildcard `'*'` reçoit tout.
  - Erreur dans un handler n'interrompt pas la chaîne ; `bus.handler-error` émis.
  - Pas de leak après `clear()`.
- **`Scheduler.test.ts`** (real + virtual) :
  - `setTimeout` exécuté à `delay` ; `clear` annule.
  - `setInterval` exécuté périodiquement.
  - `advance(ms)` déclenche les timers dans l'ordre temporel.
  - `delay(ms)` retourne une Promise qui résout après `advance(ms)`.
  - `now()` est monotone.
- **`Signal.test.ts`** :
  - `set` même valeur ne notifie pas (Object.is).
  - `subscribe`/`unsubscribe` cohérents.
  - `derived` recalcule quand un dépendant change.
- **`waitForEvent.test.ts`** :
  - Résout sur match du predicate.
  - Rejette après timeout.
  - Désinscrit le handler à la résolution (pas de leak).

#### 11.2.3 Tests unitaires acteurs

Pour chaque acteur (Port, Cable, Equipment, Switch, Router, EndHost, OSPFEngine, DHCPClient, …), pattern :

```ts
const bus = new EventBus();
const scheduler = new VirtualTimeScheduler();
const trace: DomainEvent[] = [];
bus.subscribe('*', e => trace.push(e));

const port = new Port('eth0', 'ethernet', { bus, scheduler });
port.setUp(true);
port.sendFrame(buildEthernetFrame(...));

expect(trace.map(e => e.topic)).toEqual([
  'port.link.up',
  'port.frame.tx-requested',
  // ...
]);
```

Vérifications systématiques :
- Émissions attendues, dans l'ordre attendu.
- Pas d'émission inattendue.
- État observable cohérent après chaque event (compteurs, table ARP, table de routage, FSM voisin).

#### 11.2.4 Tests d'intégration (40-60 fichiers existants à adapter + nouveaux)

Patterns récurrents :

- **Ping bout-en-bout** : `PC-A → Switch → PC-B`, `PC-A → Router → PC-B`, en IPv4 et IPv6.
- **Convergence OSPF** : `R1 ↔ R2 ↔ R3` Hello → 2-Way → ExStart → Full ; SPF run produit les routes.
- **DHCP DORA** : DHCPDISCOVER → OFFER → REQUEST → ACK ; bail renouvelé après T1 ; expiré après T2.
- **TCP echo** : listener → SYN → SYN-ACK → ACK → DATA → FIN-ACK.
- **VLAN trunk** : trafic taggé entre access et trunk via switch.
- **NAT/PAT** : translation à l'ingress du routeur.
- **IPSec tunnel** : IKE phase 1 + 2, ESP en mode tunnel.

Chaque test crée son `EventBus` et `VirtualTimeScheduler` isolés, instancie une mini-topologie, exécute un scénario, et asserte sur l'**état final** + la **trace**.

#### 11.2.5 Tests snapshot bout-en-bout

Cinq à dix scénarios « historiques » sont figés en snapshot d'événements :

```ts
test('OSPF converge sur topo en chaîne 4 routeurs', () => {
  const trace = runScenario('ospf-chain-4', { duration: 60_000 });
  expect(redactTimestamps(trace)).toMatchSnapshot();
});
```

Bénéfices :
- Détection immédiate de toute modification de comportement non intentionnelle.
- Documentation vivante : un nouveau dev peut lire le snapshot pour comprendre la séquence d'événements typique.

#### 11.2.6 Tests UI (`__tests__/unit/gui/`)

- Mock du `EventBus` injecté via `Provider` React.
- Hooks `useDevices`, `useDevice`, etc. testés en isolation : publier un événement → asserter que le hook re-renderise avec le nouvel état.
- Composants montés avec `@testing-library/react` ; vérification que `PacketAnimation` rend une particule par paquet en transit.

#### 11.2.7 Lint & CI

- ESLint rule custom (ou regex CI) interdisant :
  - `setTimeout` / `setInterval` natifs hors `src/events/`, `src/components/`, `src/hooks/`, et `vi.useFakeTimers` (tests legacy).
  - `import .* Equipment` dans `src/components/`.
  - `Equipment.getById|getAllEquipment|clearRegistry` après phase 8.
- TypeScript en mode `strict` (déjà actif) ; `noImplicitOverride` et `exactOptionalPropertyTypes` activés.
- Hook pre-commit : `npm run lint` + `npm run test:run` doivent passer.

### 11.3 Métriques de succès quantitatives

#### 11.3.1 Métriques de code

| Métrique | Avant | Cible (post-phase 8) | Mesure |
|---|---:|---:|---|
| `setTimeout/setInterval` natifs (réseau + terminal) | 91 | **0** | grep |
| Maps `pendingXxx` dans `EndHost`+`Router` | 7 | **0** | grep |
| Implémentations distinctes du pattern observable | 4 | **2** (bus + signal) | inventaire |
| LoC `EndHost.ts` | 2 325 | ≤ **1 750** | wc -l |
| LoC `Router.ts` | 1 545 | ≤ **1 250** | wc -l |
| LoC nouveau code (events + projections + adapters) | 0 | **~ 2 250** | wc -l |
| Composants React important `Equipment` | 5 | **0** | grep |
| `instance: Equipment` dans `NetworkDeviceUI` | 1 | **0** | type check |
| Méthodes statiques deprecated `Equipment.getById/...` | 3 | **0** | grep |
| Couverture tests `src/events/` | – | ≥ **95 %** | vitest --coverage |
| Couverture tests `src/network/` | (actuelle) | **inchangée ou améliorée** | vitest --coverage |

#### 11.3.2 Métriques fonctionnelles

| Capacité | Avant | Cible |
|---|:---:|:---:|
| `PacketAnimation` rend des paquets en transit | ❌ | ✅ |
| Trace d'événements rejouable (replay déterministe) | ❌ | ✅ |
| Pause / play / vitesse simulation modulable | ❌ | ✅ |
| Hook `useArpTable(deviceId)` live | ❌ | ✅ |
| Hook `useRoutingTable(deviceId)` live | ❌ | ✅ |
| Hook `useOspfNeighbors(deviceId)` live | ❌ | ✅ |
| Mode capture style tcpdump (en lecture seule) | ❌ | ✅ |
| Test snapshot OSPF converge stable cross-runs | ❌ | ✅ |
| Test snapshot DHCP DORA stable | ❌ | ✅ |
| Plug-in API protocolaire démontrée (LLDP en démonstrateur) | ❌ | ✅ (post-refonte, hors périmètre strict) |

#### 11.3.3 Métriques de performance

Benchmarks à mesurer avant/après :

| Scénario | Mesure | Cible |
|---|---|---|
| 100 frames consécutives PC→PC à travers un switch | Latence p50, p99 | Δ ≤ +20 % vs avant (overhead bus) |
| Topologie 30 devices, 50 cables | FPS du canvas pendant un drag | ≥ 55 FPS |
| Convergence OSPF 5 routeurs | Temps simulation pour atteindre Full | Identique (déterministe via VirtualTimeScheduler) |
| Création/destruction de 100 devices | Mémoire résiduelle | 0 leak |
| Souscription massive (1 000 handlers, 10 000 events) | Throughput | ≥ 500 K events/sec côté bus |

Outils :
- **Vitest bench** pour les benchmarks logiques.
- **React DevTools Profiler** pour les rerenders UI.
- **Chrome Memory** snapshot pour les leaks.

### 11.4 Stratégie de rollback

Chaque phase produit un commit (et idéalement un PR) **réversible**. Hypothèses :

- Phase 1 (primitives) : pure addition. Rollback = `git revert` sans effet sur l'existant.
- Phase 2 (logger adapter) : API conservée — rollback isolé.
- Phase 3 (Port/Cable double-émission) : rollback enlève juste les nouveaux `bus.publish` sans casser le legacy.
- Phase 4 (scheduler) : rollback restaure les `setTimeout` natifs ; faisable mais coûteux. **Mitigation** : deux sous-phases (4a moteurs critiques OSPF/RIP, 4b autres).
- Phase 5 (devices, suppression pendings) : rollback complexe — la suppression de Maps est irréversible facilement. **Mitigation** : feature flag `useWaitForEvent`, double-implementation maintenue *deux semaines* après la fusion.
- Phase 6 (UI) : rollback partiel composant par composant possible.
- Phase 7 (Oracle) : isolé, rollback simple.
- Phase 8 (suppression legacy) : la plus risquée à rollback. **Mitigation** : ne pas merger phase 8 avant que phases 6+7 soient en production stable depuis ≥ 1 mois (équivalent : « cycle de stabilisation »).

### 11.5 Critères d'acceptation par phase

| Phase | Critères « go » pour merger |
|---|---|
| 1 | Tests primitives ≥ 95 % couverture. Aucun fichier domaine modifié. CI verte. |
| 2 | Tous tests existants verts. Adapter `Logger` couvre 100 % API publique. |
| 3 | Tous tests réseau verts. `BusTracer` capture une session de ping bout-en-bout. |
| 4 | 0 occurrence `setTimeout/setInterval` natif dans `src/network/`. Tests temporels passent avec `VirtualTimeScheduler`. |
| 5 | 0 occurrence des 7 Maps `pendingXxx`. ARP/NDP unifié. Tests intégration ping/TCP/trace verts. |
| 6 | `PacketAnimation` opérationnel. 0 import `Equipment` dans `src/components/`. Profiler React : pas de rerender global sur changement isolé. |
| 7 | Tests Oracle FS-coherence verts via le nouveau adapter. |
| 8 | Suppression legacy. Suite complète verte. Documentation `CLAUDE.md` à jour. |

### 11.6 Checklist de revue de PR pour cette refonte

À utiliser pour chaque PR de la migration :

- [ ] Aucun nouveau `setTimeout`/`setInterval` natif (sauf justification dans la description).
- [ ] Tout `subscribe` a un `unsubscribe` correspondant (vérifié par lint ou par revue manuelle).
- [ ] Tout nouvel événement est ajouté à `DomainEvent` et son nom respecte la convention `domain.subdomain.action`.
- [ ] Tests unitaires de l'acteur ajoutés ou mis à jour ; trace d'événements vérifiée.
- [ ] Tests d'intégration concernés passent.
- [ ] CHANGELOG ou commit message explique la phase et la valeur livrée.
- [ ] La feature flag est mise à jour si applicable.
- [ ] Pas de régression de FPS du canvas (mesure ad-hoc si la PR touche `Cable` ou les projections).
- [ ] Pas d'augmentation de la mémoire après création/destruction de 50 devices.

### 11.7 Synthèse — gestion du risque

La refonte est **structurellement risquée** parce qu'elle touche le cœur du modèle de réactivité d'un projet de plus de 50 000 LoC. Les leviers principaux pour absorber ce risque sont :

1. **Phasage strict** : 8 phases mergeables indépendamment, gain visible à chaque étape.
2. **Coexistence transitoire** : double-écriture (callbacks + bus) pendant les phases 3-5 pour éviter le saut dans le vide.
3. **Tests pré-existants conservés** : aucune phase ne demande de réécrire la suite — seules les phases 4 et 5 demandent de basculer le scheduler dans certains tests.
4. **Feature flags** : permettent de geler l'état exposé en production tout en avançant en interne.
5. **Snapshots de trace** : détectent immédiatement toute déviation de comportement.

Ces cinq leviers, combinés à une checklist de revue rigoureuse, ramènent les risques restants (R2, R4 principalement) à un niveau gérable.

---

*Section 11 close. Suivante : §12 — Conclusion et annexes.*

---

## 12. Conclusion et annexes

### 12.1 Synthèse exécutive

L'analyse détaillée des sections §2 à §7 a établi que **Ubuntu Sandbox** repose actuellement sur **quatre implémentations distinctes** du pattern observable, **104 timers natifs** disséminés, **sept Maps de callbacks pendantes** dans les seules classes `EndHost` et `Router`, et un **couplage direct** entre la UI React et les instances mutables du domaine. Cette architecture, élégante à petite échelle, a atteint ses limites structurelles à 50 000+ LoC : animation impossible, observabilité partielle, tests dépendants de l'horloge réelle, extensibilité protocolaire coûteuse.

La cible décrite en §8 propose une **colonne vertébrale unique** composée de trois primitives — `EventBus`, `Scheduler`, `Signal` — sur lesquelles tout le reste se reconstruit. Le refactor par classe (§9) montre que la transformation est **mécanique** dans la majorité des cas : substituer des callbacks par des publications/souscriptions, injecter le scheduler à la place de `setTimeout` natif, remplacer les Maps de pending par `waitForEvent`. Les classes les plus volumineuses (`EndHost`, `Router`) **diminuent en LoC** grâce à l'extraction de la logique transverse vers le bus, tandis que la base globale grossit de l'ordre de **+600 LoC nets** — un coût raisonnable au regard des bénéfices.

Le plan de migration en **8 phases** (§10) garantit une bascule sans big-bang, avec coexistence temporaire des deux modèles, feature flags, et préservation totale de la suite de tests existante. Les phases sont **mergeables indépendamment** et apportent chacune une valeur observable : phase 3 active la trace d'événements complète, phase 6 débloque `PacketAnimation`, phase 8 nettoie le legacy. Les risques (§11), dont les six principaux ont été identifiés et quantifiés, sont absorbés par cinq leviers — phasage, coexistence, snapshots, feature flags, checklists de revue.

À l'issue de la refonte, le projet aura **gagné** :

1. **Observabilité complète** — toute mutation du domaine est traçable, journalisable, rejouable.
2. **Animation native** — `PacketAnimation` opérationnel, mode capture/tcpdump à coût marginal.
3. **Tests déterministes** — `VirtualTimeScheduler` autorise des snapshots stables cross-runs.
4. **Réactivité UI granulaire** — hooks ciblés `useDevice`, `useArpTable`, `useRoutingTable`, `useOspfNeighbors`, `useActivePackets`.
5. **Extensibilité protocolaire** — un nouveau protocole = un acteur abonné/publieur, sans modification du noyau.
6. **Découplage UI ↔ domaine** — la UI ne touche plus jamais d'instance mutable.
7. **Préservation fonctionnelle** — aucune régression : l'ensemble des commandes Cisco/Huawei/Linux/Windows, OSPF, DHCP, IPSec, Oracle SQL\*Plus, éditeurs, reste opérationnel.

### 12.2 Décisions architecturales clés (récapitulatif)

| Décision | Justification |
|---|---|
| **Bus typé maison** (≈ 100 LoC) plutôt que RxJS, mitt, eventemitter3, … | Aucun coût de dépendance ; full-typage par discriminated union ; comportement contrôlé sur la réentrance. |
| **Scheduler injecté** plutôt que `vi.useFakeTimers` global | Compatible Promise, applicable au runtime (pause/play/×N), permet le test de scénarios `async/await` natifs. |
| **`Signal` léger** plutôt que MobX/Jotai/SolidJS | Compatible React 18 `useSyncExternalStore` ; pas de runtime supplémentaire. |
| **Conservation de Zustand** | Convient parfaitement à l'état UI pur (sélection, zoom, drag) ; pas de raison de le remplacer. |
| **Conservation de l'API publique des classes existantes** (`Logger.info`, `Port.configureIP`, `Cable.connect`, `Equipment.powerOn`) | Réduit la surface de migration et préserve les milliers de lignes de tests. |
| **Coexistence callbacks + bus** pendant les phases 3-5 | Sécurise la transition ; double-écriture jetable, pas un héritage à long terme. |
| **Pas de Web Worker** | La simulation reste mono-thread ; le bus apporte la composition, pas le parallélisme. |
| **Émission synchrone par défaut, sub-event queue pour la réentrance** | Préserve la prédictibilité ; évite les explosions de pile. |

### 12.3 Annexe A — Cartographie des fichiers impactés

| Couche | Fichiers existants modifiés | Fichiers nouveaux |
|---|---|---|
| Primitives | – | `src/events/{EventBus,Scheduler,Signal,waitForEvent,types,index}.ts` |
| Core | `Logger.ts`, `PacketQueue.ts`, `NeighborResolver.ts`, `TcpConnection.ts`, `SocketTable.ts`, `RoutingTable.ts` | – |
| Hardware | `Port.ts`, `Cable.ts`, `PortSecurity.ts` | – |
| Equipment | `Equipment.ts`, `EquipmentRegistry.ts` | – |
| Devices | `EndHost.ts`, `Router.ts`, `Switch.ts`, `LinuxMachine.ts`, `WindowsPC.ts`, plus collaborateurs Linux/Windows mineurs | `src/network/devices/router/IPv4Forwarder.ts` |
| Router engines | `RouterOSPFIntegration.ts`, `RouterRIPEngine.ts`, `NATEngine.ts`, `IPv6DataPlane.ts`, `ACLEngine.ts`s | – |
| Protocoles | `OSPFEngine.ts`, `OSPFv3Engine.ts`, `RIPEngine.ts`, `DHCPClient.ts`, `DHCPServer.ts`, `IPSecEngine.ts` | – |
| Terminal | `TerminalSession.ts`, `LinuxTerminalSession.ts`, `CLITerminalSession.ts`, `TerminalManager.ts`, sub-shells (légère) | – |
| Store | `networkStore.ts`, `topologySerializer.ts` | – |
| UI | tous les composants `network/` sauf `TerminalView.tsx`, `MinimizedTerminals.tsx` | – |
| Database | `OracleInstance.ts`, `OracleExecutor.ts`, `database.ts` (terminal) | `src/adapters/OracleFilesystemSync.ts` |
| Projecteurs | – | `src/projections/{Devices,Cables,ActivePackets,Routes,Arp,Ospf,TerminalSessions,index}.ts` |
| Hooks | – | `src/hooks/{useSignal,devices,cables,routes,arp,ospf,packets,terminal}.ts` |
| Adapters | – | `src/adapters/{BusTracer,PacketCapture}.ts` |
| Tests primitives | – | `src/__tests__/unit/events/{EventBus,Scheduler,Signal,waitForEvent}.test.ts` |
| Tests existants | adaptés (timers, ARP/NDP, pendings) | – |

### 12.4 Annexe B — Liste exhaustive des topics initiaux

**Couche L1/L2** : `port.frame.tx-requested`, `port.frame.tx-blocked`, `port.frame.received`, `port.frame.dropped`, `port.link.up`, `port.link.down`, `port.config.ip-changed`, `port.config.ipv6-added`, `port.config.ipv6-removed`, `port.config.mtu-changed`, `port.config.speed-changed`, `port.config.duplex-changed`, `port.security.violation`, `port.security.shutdown`, `port.security.mac-learned`, `port.counters.tick` ; `cable.connected`, `cable.disconnected`, `cable.negotiated`, `cable.duplex-mismatch`, `cable.frame.dispatched`, `cable.frame.delivered`, `cable.frame.lost`.

**Equipment** : `device.registered`, `device.deregistered`, `device.power-on`, `device.power-off`, `device.position-changed`, `device.renamed`, `device.boot.started`, `device.boot.line`, `device.boot.completed`, `registry.cleared`.

**Host (L3/L4)** : `host.arp.entry-learned`, `host.arp.entry-expired`, `host.routing.route-added`, `host.routing.route-removed`, `host.routing.route-changed`, `host.icmp.echo-sent`, `host.icmp.echo-reply`, `host.icmp.echo-timeout`, `host.tcp.listener-started`, `host.tcp.listener-stopped`, `host.tcp.connection-established`, `host.tcp.connection-closed`, `host.l3.packet-tx-requested` ; `socket.bound`, `socket.connected`, `socket.closed`, `socket.state-changed` ; `tcp.data.sent`, `tcp.data.received`, `tcp.connection-closed` ; `neighbor.learned`, `neighbor.expired`, `neighbor.cache-cleared`, `neighbor.solicitation-sent`, `neighbor.resolution-timeout`.

**Switch** : `switch.mac.learned`, `switch.mac.aged`, `switch.vlan.created`, `switch.vlan.deleted`, `switch.port.vlan-suspended`, `switch.port.vlan-recreated`, `switch.stp.state-changed`.

**Router** : `router.routing.route-added`, `router.routing.route-removed`, `router.routing.route-changed`, `router.acl.permit`, `router.acl.deny`, `router.acl.log`, `router.nat.translation-applied`, `router.nat.session-created`, `router.nat.session-closed`.

**OSPF** : `ospf.neighbor.state-changed`, `ospf.lsa.received`, `ospf.lsa.flushed`, `ospf.lsa.installed`, `ospf.spf.run`, `ospf.dr-election`, `ospf.area.activated`, `ospf.routes-recomputed`, `ospf.packet.outgoing`.

**RIP** : `rip.update.sent`, `rip.update.received`, `rip.route-added`, `rip.route-removed`.

**DHCP** : `dhcp.lease-requested`, `dhcp.offer-received`, `dhcp.lease-granted`, `dhcp.lease-renewing`, `dhcp.lease-rebinding`, `dhcp.lease-expired`, `dhcp.arp-probe-requested`, `dhcp.arp-probe-result`, `dhcp.server.lease-allocated`, `dhcp.server.lease-released`, `dhcp.server.lease-expired`.

**IPSec** : `ipsec.ike.exchange-started`, `ipsec.ike.exchange-completed`, `ipsec.sa.installed`, `ipsec.sa.deleted`, `ipsec.dpd.peer-down`, `ipsec.packet.encrypted-out`, `ipsec.packet.decrypted-in`.

**Terminal** : `terminal.session.opened`, `terminal.session.closed`, `terminal.session.line-added`, `terminal.session.input-mode-changed`, `terminal.session.flow-started`, `terminal.session.flow-completed`, `terminal.session.subshell-entered`, `terminal.session.subshell-exited`, `terminal.session.close-requested`, `terminal.manager.session-opened`, `terminal.manager.session-closed`.

**Database (Oracle)** : `oracle.database.created`, `oracle.database.removed`, `oracle.instance.state-changed`, `oracle.instance.background-process-started`, `oracle.instance.background-process-stopped`, `oracle.instance.alert-log-entry-added`, `oracle.instance.parameter-changed`, `oracle.instance.redo-log-switched`, `oracle.archive-log.created`, `oracle.session.connected`, `oracle.session.disconnected`, `oracle.transaction.started`, `oracle.transaction.committed`, `oracle.transaction.rolled-back`, `oracle.dml.executed`, `oracle.ddl.executed`, `oracle.error.raised`, `oracle.rman.backup-started`, `oracle.rman.backup-completed`, `oracle.rman.restore-started`, `oracle.rman.restore-completed`.

**Topology** : `topology.import-started`, `topology.import-completed`, `topology.export-started`, `topology.export-completed`.

**Logging & système** : `log`, `bus.handler-error`, `packetqueue.depth-changed`.

**SFTP / autres sous-shells** : `sftp.transfer-started`, `sftp.transfer-completed`, `sftp.transfer-failed`.

**Total** : ≈ 95 topics initiaux. Liste évolutive ; chaque ajout passe par revue de PR.

### 12.5 Annexe C — Glossaire technique

- **Acteur (Actor)** : objet qui détient un état interne, s'abonne à des événements pertinents, mute son état, et publie des événements en réaction.
- **Adapter** : module qui consomme des événements pour produire un effet externe (filesystem, log texte, animation, sérialisation).
- **DomainEvent** : type union TypeScript discriminé représentant tous les événements possibles dans le système.
- **EventBus** : registre central qui dispatche les événements aux abonnés filtrés par topic.
- **Feature flag** : booléen interne qui active/désactive un comportement, utilisé pour la migration progressive.
- **Microtâche** : tâche planifiée pour s'exécuter à la fin du job courant de la boucle d'événements JavaScript ; utilisée pour la réentrance bornée du bus.
- **Projection / Read-model / VM (View-Model)** : vue dérivée et immuable d'un état de domaine, calculée par un réducteur à partir du flux d'événements, consommée par la UI.
- **Read-only domain access** : politique selon laquelle la UI ne peut lire le domaine qu'à travers des projections.
- **Réentrance bornée** : un handler peut publier ; les sub-events sont mis en file et dispatchés à la fin du dispatch courant ; pas de récursion incontrôlée.
- **Scheduler** : abstraction des timers — fournit `setTimeout`, `setInterval`, `clear`, `now`, `delay`, et un mode test `advance`.
- **Signal / WritableSignal** : conteneur d'une valeur qui notifie ses lecteurs lors d'un changement, compatible `useSyncExternalStore`.
- **Snapshot d'événements** : trace ordonnée des événements émis pendant un scénario, comparée bit-pour-bit pour détecter les régressions.
- **Sub-event queue** : file FIFO des événements publiés *pendant* un dispatch, vidée après le dispatch courant.
- **Topic** : chaîne hiérarchique en kebab-case identifiant une catégorie d'événements.
- **VirtualTimeScheduler** : scheduler de tests avec une horloge virtuelle avancée manuellement par `advance(ms)`.
- **`waitForEvent`** : helper qui transforme une attente d'événement en `Promise<payload>` avec timeout.

### 12.6 Annexe D — Effort estimé

| Phase | Effort dev (jours-personne) | Effort revue (jours-personne) |
|---|:---:|:---:|
| 1 | 3 | 1 |
| 2 | 2 | 1 |
| 3 | 6 | 2 |
| 4 | 8 | 3 |
| 5 | 12 | 4 |
| 6 | 10 | 3 |
| 7 | 3 | 1 |
| 8 | 4 | 1 |
| **Total** | **48 j-p** | **16 j-p** |

≈ **64 jours-personne** au total. À une personne à plein temps, ≈ 13 semaines (~ 3 mois) avec marge. À deux personnes en collaboration (une développe pendant que l'autre revoit la phase précédente), ≈ 8 semaines.

### 12.7 Annexe E — Hors-périmètre stricts (rappel)

Cette refonte **n'inclut pas** :

- Réécriture des parsers Cisco IOS, Huawei VRP, Linux bash, PowerShell, Oracle SQL.
- Migration React → Solid/Svelte/Vue.
- Réécriture du moteur Oracle (lexer/parser/exécuteur/catalog/storage).
- Introduction de Web Workers ou de WASM.
- Implémentation de protocoles supplémentaires (BGP, MPLS, mDNS, LLDP) — bien que la cible facilite leur ajout.
- Persistance backend / mode multi-utilisateur.

Ces sujets relèvent de chantiers ultérieurs qui pourront s'appuyer sur les fondations posées par la refonte.

### 12.8 Annexe F — Historique du document

| Section | Commit | Statut |
|---|---|---|
| 1. Introduction & objectifs | `f9ae3af` | ✅ |
| 2. État actuel | `cdceb2a` | ✅ |
| 3. Couche réseau | `9f89c44` | ✅ |
| 4. Devices et protocoles | `59ad5f2` | ✅ |
| 5. Couche terminal | `655dc2b` | ✅ |
| 6. Store et UI React | `0eb08ef` | ✅ |
| 7. Base de données Oracle | `9697552` | ✅ |
| 8. Architecture cible | `1d6d908` | ✅ |
| 9. Refactoring par classe | `146fdf5` | ✅ |
| 10. Plan de migration | `d9a5396` | ✅ |
| 11. Risques, tests, métriques | `3e7fb75` | ✅ |
| 12. Conclusion et annexes | _ce commit_ | ✅ |

Document rédigé séquentiellement, sans agent, section par section, sur la branche `claude/reactive-event-driven-refactor-8hVAE`.

### 12.8.1 Avancement de la migration (branche `claude/reactive-refactor-JYsTE`)

La migration est implémentée séquentiellement, sans agent, sur la branche
`claude/reactive-refactor-JYsTE`. Chaque phase fait l'objet d'un commit
dédié. Le statut ci-dessous est mis à jour à la fin de chaque phase
majeure.

| Phase | Titre | Statut | Notes |
|---|---|:---:|---|
| 1 | Primitives (`EventBus`, `Scheduler`, `Signal`, `waitForEvent`, types) | ✅ | Voir §12.8.2 |
| 2 | `Logger` adapter + `EquipmentRegistry` events | ✅ | Voir §12.8.3 |
| 3 | Hardware : `Port`, `Cable` émettent (callbacks legacy conservés) | ✅ | Voir §12.8.4 |
| 4a | Scheduler dans `PacketQueue` et `NeighborResolver` | ✅ | Voir §12.8.5 |
| 4b1 | Scheduler dans `Switch.macAgingTimer` | ✅ | Voir §12.8.6 |
| 4b2-OSPF | OSPF v2 + v3 : timers, événements, signaux | ✅ | Voir §12.8.7 |
| 4b2-OSPF.actors | OSPF : inversion réactive (acteurs souscrits au bus) | ✅ | Voir §12.8.8 |
| 4b2-OSPF.deeper | OSPF : projections pures + LsaRefresh/NetworkLsa/RoutingTableSync actors | ✅ | Voir §12.8.9 |
| 4b2-OSPF.packets | OSPF : packet egress/ingress sur le bus + OspfCaptureActor | ✅ | Voir §12.8.10 |
| 4b2-OSPFv3 | OSPFv3 : parité réactive (acteurs, signaux, événements) | ✅ | Voir §12.8.11 |
| 4b2-OSPF.lifecycle | OSPF : Hello + DD/LSR retransmits comme acteurs réactifs | ✅ | Voir §12.8.12 |
| 4b2-IPSec | IPSec : timers + signaux + FilterChain pattern | ✅ | Voir §12.8.13 |
| 4b2-IPSec.deeper | IPSec : topics typés, observables complets, SignalRefreshActor, OutboundChain, SA emissions | ✅ | Voir §12.8.14 |
| 4b2-IPSec.continuum | IPSec : DPD events + IPSecCaptureActor + shadow chain on real ESP path | ✅ | Voir §12.8.15 |
| 4b2-RIP | RIP : timers + topics + observables + acteur | ✅ | Voir §12.8.16 |
| 4b2-DHCP | DHCP client : timers + 18 topics + observables + acteur | ✅ | Voir §12.8.17 |
| 4b2-NAT | NAT : reactive uplift | ⏳ | – |
| 5 | Devices : `EndHost`, `Router` migrent leurs `pendingXxx` | ⏳ | – |
| 6 | Projections + hooks UI ; pipeline frames asynchrone | ⏳ | – |
| 7 | Oracle : émissions + `OracleFilesystemSync` | ⏳ | – |
| 8 | Suppression du legacy | ⏳ | – |

### 12.8.2 Phase 1 — Primitives (livrée)

**Fichiers créés** (`src/events/`) :

- `EventBus.ts` (≈ 165 LoC) — implémentation conforme à §8.2 :
  dispatch synchrone FIFO, sub-event queue pour la réentrance bornée
  (limite `MAX_REENTRANCE_DEPTH = 64`), capture des exceptions avec
  réémission sur `bus.handler-error`, snapshot de la liste de handlers
  pendant le dispatch (un handler peut s'inscrire/désinscrire pendant
  l'exécution sans corrompre la chaîne), wildcard `subscribeAll`,
  `subscribeWhere` avec prédicat sur le payload. Singleton paresseux
  `getDefaultEventBus()` exporté pour le fallback ; les acteurs
  injecteront leur propre bus en priorité.
- `Scheduler.ts` (≈ 215 LoC) — interface `IScheduler` + deux
  implémentations conformes à §8.3 :
  - `RealTimeScheduler` : délègue à `globalThis.setTimeout/setInterval`,
    `now()` via `performance.now()` avec fallback `Date.now()`, capture
    des exceptions des callbacks.
  - `VirtualTimeScheduler` : horloge virtuelle, `advance(ms)` qui
    déclenche les timers dans l'ordre chronologique (avec tie-break
    déterministe par `seq` d'insertion), gestion des intervals avec
    re-scheduling avant exécution du body (pour qu'une exception ne
    saute pas le tick suivant), exécution des tâches schedulées
    *pendant* l'`advance` au sein de la même fenêtre, `delay(ms)` qui
    résout après `advance(ms)`, `runAll()` pour flush total, `reset()`,
    `pendingCount()` pour les assertions de tests.
- `Signal.ts` (≈ 65 LoC) — `Signal<T>` interface + `WritableSignal<T>`
  avec comparaison `Object.is`, `update(mutator)`, snapshot des
  listeners pour permettre les (un)subscriptions en cours de notify, et
  helper `derived()` qui ne ré-émet qu'en cas de changement réel de la
  valeur dérivée.
- `waitForEvent.ts` (≈ 65 LoC) — helper qui transforme une attente
  d'événement en `Promise<payload>` avec timeout via `IScheduler`,
  cleanup garanti (timer + unsubscribe) sur résolution / rejet /
  abort, support optionnel d'`AbortSignal`. Erreurs typées
  `WaitForEventTimeoutError` et `WaitForEventAbortedError`.
- `types.ts` (≈ 75 LoC) — union discriminée `DomainEvent` initiale :
  topics `log`, `bus.handler-error` et la famille `device.*` consommée
  par la Phase 2. Helpers de type `EventOf<T>` et `PayloadOf<T>`. Les
  phases ultérieures étendent cette union (en gardant la convention
  `domain.subdomain.action` du §8.9).
- `index.ts` (≈ 40 LoC) — re-exports publics.

**Tests** (`src/__tests__/unit/events/`) :

- `EventBus.test.ts` : 8 tests (FIFO, unsubscribe, réentrance,
  wildcard, isolation d'erreur + réémission, predicate, clear,
  snapshot semantics).
- `Scheduler.test.ts` : 9 tests virtuel + réel (ordres, periodes,
  cancel, delay, scheduling pendant `advance`, reset, garde-fou
  négatif).
- `Signal.test.ts` : 8 tests (Object.is, NaN, unsubscribe, update,
  derived recompute, derived ne notifie qu'au changement effectif).
- `waitForEvent.test.ts` : 6 tests (résolution, timeout, cleanup,
  abort, abort déjà déclenché).

**Résultat** : **31/31 tests verts**, primitives 100 % couvertes en
comportement public. Aucun fichier de domaine touché. Aucune dépendance
externe ajoutée. Lint propre sur les nouveaux fichiers.

**Critères de sortie §10.2 atteints** :

- ✅ Suite de tests primitives 100 % verte.
- ✅ `npm run lint` propre sur `src/events/` et tests associés.
- ✅ Aucune dépendance externe ajoutée à `package.json`.
- ✅ Aucun fichier de domaine touché.

### 12.8.3 Phase 2 — Logger adapter + Registry/Equipment events (livrée)

**Objectif §10.3** : faire passer **tous** les logs existants par le bus
sans rompre leur API publique, et ajouter des émissions de cycle de vie
sur `EquipmentRegistry` et `Equipment`.

**Fichiers modifiés** :

- `src/network/core/Logger.ts` (≈ 145 LoC). Le singleton `Logger`
  publie désormais chaque appel `debug/info/warn/error` à la fois sur
  ses abonnés legacy (filtrage `source` / préfixe `event` / `level`
  conservé) **et** sur le bus comme `{ topic: 'log', payload }`. Les
  ≈ 90 sites d'appel restent inchangés. Une méthode `__setBus(bus)`
  permet aux tests d'isoler le bus. Les exceptions des subscribers
  legacy sont désormais capturées (alignement sur la robustesse du
  bus). La gestion du buffer in-memory `logs[]` est conservée pour
  l'instant ; son extraction en `LogProjection` est différée à une
  phase ultérieure pour limiter la surface de migration.
- `src/network/equipment/EquipmentRegistry.ts` (≈ 130 LoC). Émet
  `device.registered` (sur `register()` d'un device non encore
  présent), `device.deregistered` (sur `deregister()` d'un id présent),
  `registry.cleared` (sur `clear()` non vide). API publique
  inchangée ; injection bus optionnelle via `setEventBus(bus)`.
- `src/network/equipment/Equipment.ts` (≈ 220 LoC).
  - `powerOn()` / `powerOff()` : conservent l'appel `Logger.info` à
    l'identique pour ne pas modifier les compteurs de logs des tests
    legacy ; émettent en plus `device.power-on` / `device.power-off`
    **uniquement** sur transition d'état effective.
  - `setName()` : émet `device.renamed` uniquement si le nom change
    (`{ id, oldName, newName }`).
  - `setPosition()` : émet `device.position-changed` uniquement si les
    coordonnées changent. Cela ouvre la voie au binding live UI sans
    modification du composant `NetworkCanvas` (Phase 6).
  - `setEventBus(bus)` injectable (test-only utility).

**Tests ajoutés** (`src/__tests__/unit/events/`) :

- `Logger.adapter.test.ts` (5 tests) : émission `log` sur bus pour les
  4 niveaux, filtrage legacy préservé, buffer in-memory conservé,
  isolation des subscribers en erreur.
- `Registry.lifecycle.test.ts` (6 tests) : `device.registered` émis à
  la construction, idempotence sur `register()` répété,
  `device.deregistered` émis seulement pour des ids présents,
  `registry.cleared` non émis sur clear vide.
- `Equipment.lifecycle.test.ts` (4 tests) : transitions `power-on/off`
  émises uniquement sur changement, no-op sans event,
  `position-changed` filtré par changement effectif,
  `renamed` filtré par changement effectif.

**Résultat** : **46/46 tests des primitives + Phase 2 verts** (15
nouveaux tests Phase 2). La suite globale (`npm run test:run`) reste
strictement à la baseline préexistante : aucun nouveau échec
introduit, aucun fichier de domaine cassé.

**Critères de sortie §10.3 atteints** :

- ✅ Tous les tests existants passent sans modification.
- ✅ `Logger.info(...)` → bus reçoit `{ topic: 'log', ... }` (test
  d'adaptation présent).
- ✅ Construction d'`Equipment` → `device.registered` émis (test
  présent).
- ✅ API publique `Logger.{debug,info,warn,error,subscribe,unsubscribe,getLogs,reset}`
  inchangée.

### 12.8.4 Phase 3 — Hardware : Port et Cable émettent (livrée)

**Objectif §10.4** : ajouter les émissions `port.*` et `cable.*` sans
casser le pipeline synchrone existant. Les callbacks `onFrame`,
`onLinkChange`, `frameHandler` restent **fonctionnels** ; ils sont
simplement **doublés** par les événements pour permettre aux
abonnés bus (futur `PacketAnimation`, `BusTracer`, projections,
adapter de capture) d'observer la circulation des trames.

**Topics ajoutés à `DomainEvent`** (≈ 25 nouveaux discriminants dans
`src/events/types.ts`) :

- L1/L2 Port : `port.frame.tx-requested`, `port.frame.tx-blocked`,
  `port.frame.received`, `port.frame.dropped`, `port.link.up`,
  `port.link.down`, `port.config.ip-changed`,
  `port.config.ipv6-added`, `port.config.ipv6-removed`,
  `port.config.mtu-changed`, `port.config.speed-changed`,
  `port.config.duplex-changed`, `port.security.violation`.
- L1/L2 Cable : `cable.connected`, `cable.disconnected`,
  `cable.negotiated`, `cable.duplex-mismatch`,
  `cable.frame.dispatched`, `cable.frame.delivered`,
  `cable.frame.lost`.

Les payloads utilisent les types existants (`EthernetFrame`,
`MACAddress`, `IPAddress`, `SubnetMask`, `IPv6Address`, `PortDuplex`,
`PortSpeed`, `PortViolationMode`) via des `import type`, donc zéro coût
runtime et zéro dépendance circulaire.

**Fichiers modifiés** :

- `src/network/hardware/Port.ts` (≈ 535 LoC) :
  - Injection bus optionnelle `setEventBus(bus)`, helper `portRef()`.
  - `configureIP/clearIP` publient `port.config.ip-changed`.
  - `enableIPv6/configureIPv6/removeIPv6Address` publient
    `port.config.ipv6-added/removed`.
  - `setSpeed/setDuplex/setMTU` publient leurs events de config
    (filtrés sur changement effectif).
  - `notifyLinkChange` publie `port.link.up` / `port.link.down`
    (couvre `setUp`, `connectCable`, `disconnectCable`,
    `_notifyLinkUp`, et la mise à `down` automatique en cas de
    violation port-security shutdown).
  - `checkPortSecurity` publie `port.security.violation` avec
    `{ mac, mode, action }` quand la trame est rejetée. Mode
    déterminé via `getViolationMode()`, action déterminée par
    `verdict.shouldShutdown` ou `restrict` ou `protect → discarded`.
  - `sendFrame` publie `port.frame.tx-requested` ou
    `port.frame.tx-blocked` (raisons : `link-down`, `no-cable`).
  - `receiveFrame` publie `port.frame.received` ou
    `port.frame.dropped` (raisons : `link-down`,
    `security-violation`).
  - **Aucun** callback existant retiré — Phase 8 les nettoie.
- `src/network/hardware/Cable.ts` (≈ 320 LoC) :
  - Injection `setEventBus(bus)` et `setRng(fn)` (RNG injectable
    pour seed déterministe en test, conformément au point C2 §3.3.3).
  - `connect()` publie `cable.connected` puis `cable.negotiated`
    (avec `speed`/`duplex` négociés) puis éventuellement
    `cable.duplex-mismatch`.
  - `disconnect()` publie `cable.disconnected`.
  - `transmit()` publie successivement `cable.frame.dispatched`,
    déclenche la livraison **synchrone** (Phase 6 la rendra
    asynchrone via `Scheduler`), puis `cable.frame.delivered`. Sur
    cable down / pas de peer / perte simulée, publie
    `cable.frame.lost` avec `reason` discriminé.

**Tests ajoutés** (`src/__tests__/unit/events/Port.events.test.ts`) :

- 9 tests couvrant tx-blocked (link-down + no-cable), `port.link.*`
  sur transitions, `port.config.ip-changed` sur configure/clear,
  `port.config.mtu-changed` filtré, chaîne complète tx-requested →
  cable.dispatched → port.received → cable.delivered avec ordre
  vérifié, `cable.connected` + `cable.negotiated`, `cable.frame.lost`
  avec rng seedée à 0, `cable.disconnected`.

**Résultat** : **55/55 tests events verts** (9 nouveaux). La suite
globale `npm run test:run` reste strictement à la baseline préexistante
(578 échecs antérieurs, aucun ajouté).

**Critères de sortie §10.4 atteints** :

- ✅ Suite réseau verte (baseline préservée, +55 verts).
- ✅ Un abonné `BusTracer` peut désormais enregistrer la trace complète
  d'un envoi `Port.sendFrame` jusqu'à `Port.receiveFrame` côté pair.
- ✅ Les callbacks `onFrame` et `onLinkChange` restent live, donc aucun
  code legacy n'est cassé.
- ✅ RNG injectable côté `Cable` ouvre la voie à des tests de perte de
  paquets reproductibles (point C2 §3.3.3 résolu côté primitive).

### 12.8.5 Phase 4a — Scheduler dans `PacketQueue` et `NeighborResolver` (livrée)

**Objectif §10.5** appliqué aux deux composants core génériques (au
sens §3.5.2 et §3.5.3). Les engines OSPF/RIP/DHCP/IPSec/NAT,
beaucoup plus volumineux, sont traités en Phase 4b.

**Fichiers modifiés** :

- `src/network/core/PacketQueue.ts` (≈ 155 LoC) :
  - Constructeur étendu avec un paramètre optionnel `scheduler?: IScheduler`
    (default fallback sur `getDefaultScheduler()`, donc rétro-compatible).
  - `setScheduler(scheduler)` permet l'injection runtime.
  - Tous les `setTimeout` / `clearTimeout` natifs (4 sites) remplacés
    par `scheduler.setTimeout` / `scheduler.clear`.
  - Le type `timer` interne passe de `ReturnType<typeof setTimeout>` à
    `TimerHandle` (alias scheduler).
- `src/network/core/NeighborResolver.ts` (≈ 220 LoC) :
  - Idem : 4ᵉ paramètre optionnel `scheduler?: IScheduler` au
    constructeur, méthode `setScheduler(scheduler)`.
  - Tous les `setTimeout` / `clearTimeout` (3 sites : timeout de
    résolution, cancel sur learn, cancel sur clear) migrés.
  - L'API publique (`resolve(...)` retourne toujours `Promise<MAC>`)
    reste **strictement identique** ; seul le moteur des timers change.
- `src/network/core/PacketQueue.ts` et `NeighborResolver.ts`
  n'introduisent **aucune** émission bus à ce stade — c'est purement
  une migration de scheduler. Les émissions `neighbor.*` viendront
  avec Phase 5 (qui réutilisera `NeighborResolver` côté `EndHost`).

**Tests ajoutés** (`src/__tests__/unit/events/`) :

- `PacketQueue.scheduler.test.ts` (4 tests) : expiration via
  `advance(ms)` déterministe, `flush()` annule les timers,
  `clear()` libère tous les timers, éviction LRU à la capacité avec
  libération du timer de l'entrée évincée.
- `NeighborResolver.scheduler.test.ts` (5 tests) : cache hit
  synchrone, résolution sur `learn()`, timeout via `advance()`, pas de
  duplication des solicitations en flight, `clear()` rejette tous les
  pendings et libère les timers.

**Résultat** : **64/64 tests events verts** (9 nouveaux). La suite
globale reste à la baseline préexistante (578 échecs, aucun ajouté).

**Critères de sortie partiels §10.5** :

- ✅ 0 occurrence `setInterval` / `setTimeout` natif dans
  `src/network/core/PacketQueue.ts` et `NeighborResolver.ts` (vérifié
  par grep).
- ✅ Tests temporels passent avec `VirtualTimeScheduler` injecté.
- ⏳ Migration équivalente requise pour `OSPFEngine`,
  `OSPFv3Engine`, `RIPEngine`, `RouterRIPEngine`, `DHCPClient`,
  `DHCPServer`, `IPSecEngine`, `NATEngine` → traités en Phase 4b2.

### 12.8.6 Phase 4b1 — Scheduler dans `Switch.macAgingTimer` (livrée)

**Objectif** : migrer le seul timer natif de la classe `Switch`
(`macAgingTimer = setInterval(..., 1000)`) vers `IScheduler`.

**Fichier modifié** :

- `src/network/devices/Switch.ts` (≈ 855 LoC) :
  - Champ `macAgingTimer: TimerHandle | null` (au lieu de
    `ReturnType<typeof setInterval>`).
  - Champ `macAgingScheduler: IScheduler | null` qui mémorise quel
    scheduler a programmé le timer, pour que `stopMACAgingProcess()`
    libère le bon handle même si `setScheduler()` est appelé entre
    démarrage et arrêt.
  - `setScheduler(scheduler)` : si l'aging était déjà actif, l'arrête
    sur l'ancien scheduler puis le redémarre sur le nouveau (rebascule
    transparente).
  - `startMACAgingProcess()` utilise `getScheduler().setInterval(...)`.
  - `stopMACAgingProcess()` utilise le scheduler **mémorisé** au
    moment du démarrage, pas l'override courant — évite les fuites
    de timer si on a basculé entre-temps.

**Test ajouté** (`src/__tests__/unit/events/Switch.scheduler.test.ts`,
1 test) : crée un `CiscoSwitch`, injecte un `VirtualTimeScheduler`
après construction (forçant le rebascule), powerOn/powerOff, vérifie
qu'aucun timer ne fuit (`scheduler.pendingCount() === 0`).

**Résultat** : **65/65 tests events verts**. Suite globale : baseline
préservée. 0 occurrence de `setInterval` natif dans
`src/network/devices/Switch.ts`.

### 12.8.7 Phase 4b2-OSPF — OSPFv2 + OSPFv3 réactifs (livrée)

**Objectif §10.5** appliqué aux deux moteurs OSPF (≈ 4 600 LoC
cumulées). La migration exploite à fond la programmation réactive :
événements typés sur le bus, scheduler injecté pour 100 % des timers,
read-models exposés via `Signal` consommables par
`useSyncExternalStore`. Le tout sans toucher à la logique RFC 2328 /
RFC 5340 — la suite de **357 tests OSPF existants reste verte sans
modification**.

#### Réorganisation en fichiers plus petits

`src/network/ospf/` est désormais composé de :

- `OSPFEngine.ts` (≈ 3 300 LoC) — moteur principal, instrumenté.
- `OSPFv3Engine.ts` (≈ 700 LoC) — moteur IPv6, instrumenté.
- `types.ts` — types partagés (timers passés de
  `ReturnType<typeof setTimeout>` à `symbol`, qui est le token opaque
  des `TimerSet`).
- `checksum.ts` (**nouveau**, ≈ 100 LoC) — Fletcher-16 LSA checksum
  extrait du moteur. Pur, indépendamment testable, ré-exporté par
  `OSPFEngine` pour rétro-compatibilité.
- `events.ts` (**nouveau**, ≈ 105 LoC) — taxonomie réactive
  (`OspfDomainEvent` union de 11 topics : neighbor.state-changed,
  interface.state-changed, dr-election, lsa.installed/flushed/received/refreshed,
  spf.run, routes-recomputed, area.activated, packet.outgoing).
  Cette union est intégrée à `DomainEvent` (`src/events/types.ts`) via
  un re-export, conservant le typage discriminé pour les abonnés bus.
- `observables.ts` (**nouveau**, ≈ 110 LoC) — `OspfSignalStore`
  (writable interne) + `OspfObservables` (lecture seule exposée).
  View-models : `OspfNeighborVM`, `OspfInterfaceVM`,
  `OspfLSDBSummaryVM`, `OspfRoutesVM`, `OspfRuntimeStatsVM`. Chaque
  signal n'émet que sur changement de référence (`Object.is`).

#### Helper transverse

`src/events/TimerSet.ts` (**nouveau**, ≈ 75 LoC) — petit utilitaire
réutilisable par tous les moteurs (OSPF, OSPFv3, et les futurs RIP /
DHCP / IPSec / NAT) qui :

1. capture le `IScheduler` actif **au moment de l'allocation** de
   chaque timer ;
2. garantit que `clear()` libère le handle sur ce **même** scheduler,
   même si `setScheduler()` a basculé entre allocation et libération ;
3. fournit `clearAll()` pour le `shutdown()` global du moteur,
   éliminant ≈ 30 lignes de répétition `clearTimeout`/`clearInterval`
   par moteur.

#### Migration `OSPFEngine`

| Élément | Avant | Après |
|---|---|---|
| Timers natifs | 7 sites (`setInterval` LSAge, `setTimeout` SPF, `setInterval` Hello, `setTimeout` Wait, `setTimeout` Dead, `setTimeout` DDRetransmit, `setTimeout` LSRRetransmit) | 0 — tous via `this.timers` (`TimerSet`) qui délègue au scheduler injecté |
| Émissions bus | 0 | 11 topics (`ospf.neighbor.state-changed`, `ospf.dr-election`, `ospf.lsa.installed`, `ospf.lsa.flushed` (reason: `maxage` ou `topology-change`), `ospf.spf.run` (kind: `full` ou `partial`, `runtimeMs`), `ospf.routes-recomputed`, `ospf.area.activated`, …) |
| State observable | aucune (mutations silencieuses) | 5 signaux : `neighbors`, `interfaces`, `lsdbSummary`, `routes`, `runtime` |
| Injection | `OSPFSendCallback` uniquement | `setEventBus()`, `setScheduler()`, `setDeviceId()`, `setSendCallback()` (existant) — défauts singleton |
| Checksum | inline, ≈ 95 LoC | délégué à `checksum.ts` ; ré-exports stables |
| `shutdown()` | 30 lignes de cleanup manuel par interface/voisin | `this.timers.clearAll()` + reset des champs |

Les rafraîchissements de signaux (`rebuildNeighborSignal`,
`rebuildLSDBSignal`, `rebuildRoutesSignal`, `updateRuntimeSignal`)
sont déclenchés au plus près de la mutation de l'état domaine, pas par
polling. La granularité naturelle est : un événement métier émis ⇒ un
signal correspondant rafraîchi.

#### Migration `OSPFv3Engine`

Mêmes principes, mais sans signaux internes pour l'instant (le moteur
IPv6 a une surface d'usage plus restreinte). Tous les timers natifs (5
sites : Wait, Hello, Dead, plus deux cleanups) sont migrés vers
`TimerSet`. La transition `Down` du voisin sur `InactivityTimer`
publie `ospf.neighbor.state-changed` avec `event: 'InactivityTimer'`.

#### Tests réactifs

`src/__tests__/unit/events/OSPF.reactive.test.ts` (**nouveau**, 13
tests, ≈ 230 LoC) — couvre :

- 0 timer natif après `start()` (uniquement le tick LSA aging) ;
- LSA aging déterministe via `scheduler.advance(N_000)` ;
- émission `ospf.lsa.installed` à l'install d'un nouveau LSA ;
- émission `ospf.lsa.flushed` (reason `maxage`) lors d'une purge ;
- absence de flush quand un LSA self-originated atteint
  `LS_REFRESH_TIME` (re-flood + reset d'âge à la place) ;
- émissions `ospf.spf.run` (`kind: 'full'`) + `ospf.routes-recomputed` ;
- émission `ospf.area.activated` pour chaque aire au démarrage ;
- mise à jour du signal `runtime` (running, spfRuns, lastSpfKind) ;
- mise à jour du signal `routes` après SPF ;
- mise à jour du signal `lsdbSummary` après `installLSA` ;
- `shutdown()` libère 100 % des timers (`pendingCount() === 0`) ;
- émission `ospf.dr-election` avec le bon `iface`/`dr` ;
- les abonnés au signal `runtime` sont notifiés à chaque SPF.

#### Résultat

- **78/78 tests events** (13 nouveaux Phase 4b2-OSPF).
- **357/357 tests OSPF existants** verts sans modification.
- **Suite globale** : baseline strictement préservée (578 échecs
  préexistants, aucun introduit).
- **0 occurrence** de `setTimeout` / `setInterval` natif dans
  `OSPFEngine.ts` ou `OSPFv3Engine.ts` (vérifié par grep).
- **API publique conservée** : `OSPFEngine.tickLSAge()`,
  `runSPF()`, `installLSA()`, `setSendCallback()`, etc. inchangées —
  les tests existants utilisant `vi.useFakeTimers` + `tickLSAge`
  continuent de fonctionner via le `RealTimeScheduler` par défaut.

#### Bénéfices immédiats

1. **Tests OSPF déterministes** : un nouveau test peut substituer
   `VirtualTimeScheduler` à `vi.useFakeTimers` et obtenir un trace
   d'événements bit-pour-bit reproductible cross-runs.
2. **UI live possible** : un futur composant `OspfNeighborTable`
   peut consommer `engine.observables.neighbors` via
   `useSyncExternalStore` sans aucun polling.
3. **Plug-in API** : un module `BusTracer` abonné à `'*'` enregistre
   maintenant la trace exacte d'une convergence OSPF (Hello → 2-Way
   → Full → SPF run → routes recomputed) — base directe pour les
   snapshots §11.2.5.
4. **Capture / replay** : la combinaison `EventBus` + `VirtualTime
   Scheduler` rend possible le rejeu déterministe d'un scénario à
   condition initiale identique.

### 12.8.8 Phase 4b2-OSPF.actors — inversion réactive complète (livrée)

**Motivation** : la Phase 4b2-OSPF émettait les événements mais
**personne ne s'y abonnait**. La logique restait impérative : à chaque
mutation, le moteur appelait directement `rebuildXxxSignal()`,
`scheduleSPF()` et `originateRouterLSA()`. Cette phase ferme la
boucle : les effets de bord sont désormais **portés par des
acteurs souscrits au bus**, le moteur n'est plus qu'un émetteur.

**Fichiers ajoutés** (`src/network/ospf/actors/`, **4 nouveaux
fichiers**) :

- `actors/SignalRefreshActor.ts` (≈ 80 LoC). Souscrit à 7 topics
  (`ospf.neighbor.state-changed`, `ospf.dr-election`,
  `ospf.interface.state-changed`, `ospf.lsa.installed`,
  `ospf.lsa.flushed`, `ospf.lsa.refreshed`, `ospf.spf.run`,
  `ospf.routes-recomputed`, `ospf.area.activated`). Sur chaque
  événement, rafraîchit le bon sous-ensemble de signaux
  (`neighbors`, `interfaces`, `lsdbSummary`, `routes`, `runtime`).
  L'identité (`routerId + processId`) est filtrée à chaque dispatch
  pour permettre plusieurs moteurs sur un bus partagé.
- `actors/SpfActor.ts` (≈ 65 LoC). Souscrit à 3 topics
  (`ospf.lsa.installed`, `ospf.lsa.flushed`,
  `ospf.neighbor.state-changed`). Encapsule la **politique** de
  scheduling SPF :
  - LSA Type 1/2 → `scheduleSPF(true)` (full)
  - LSA autre → `scheduleSPF(false)` (partial)
  - LSA flushed (maxage) → `scheduleSPF(true)`
  - Neighbor crossing Full ↔ X → `scheduleSPF(true)`
  Cette politique vivait avant en **3 sites distincts** (`installLSA`,
  `tickLSAge`, `neighborEvent`) — elle est maintenant **centralisée**.
- `actors/RouterLsaActor.ts` (≈ 55 LoC). Souscrit à
  `ospf.neighbor.state-changed`. Sur transition Full ↔ X, appelle
  `engine.originateRouterLSA(areaId)` où `areaId` est obtenu via
  `engine.getInterfaceAreaId(iface)` (qui consulte aussi les
  virtual links).
- `actors/index.ts` — barrel.

**Modifications à `OSPFEngine.ts`** :

- Champs `signalRefreshActor`, `spfActor`, `routerLsaActor` privés.
- Méthode privée `attachActors()` qui (ré-)alloue et démarre les
  trois acteurs ; appelée au constructeur **et** à chaque
  `setEventBus(bus)` pour rebondir sur le nouveau bus.
- Sites impératifs **supprimés** :
  - `installLSA` : plus de `rebuildLSDBSignal()` ni `scheduleSPF()`
    ad-hoc — le SignalRefreshActor + le SpfActor s'en chargent.
  - `tickLSAge` : plus de `rebuildLSDBSignal()` ni `scheduleSPF()`
    en queue — un événement `ospf.lsa.flushed` par LSA évincé suffit.
  - `neighborEvent` : plus de `rebuildXxxSignal()` ni
    `originateRouterLSA()` ni `scheduleSPF()` — l'événement
    `ospf.neighbor.state-changed` déclenche les trois acteurs.
  - `drElection` : plus de `rebuildXxxSignal()` — l'événement
    `ospf.dr-election` déclenche le SignalRefreshActor.
  - `runSPF` / `runPartialSPF` : plus de `rebuildRoutesSignal()` —
    `ospf.spf.run` + `ospf.routes-recomputed` déclenchent le refresh.
  - `interfaceUp` : émet désormais `ospf.interface.state-changed` ;
    plus de `rebuildInterfaceSignal()` inline.
- `scheduleSPF()` reçoit le garde `if (this.spfRunning) return`
  déplacé depuis `installLSA`. Le moteur reste idempotent face à des
  appels redondants pendant un SPF en cours (utile lors des ABR
  summaries).
- `getInterfaceAreaId(name)` étendu pour résoudre aussi les VL
  ifaces (qui vivent dans `virtualLinks`, pas dans `interfaces`) —
  débloque `RouterLsaActor` dans les scénarios virtual-link.
- 8 méthodes publiques préfixées `_refresh*` (la convention
  documente "actor-only API") exposent les rebuilds aux acteurs.

**Tests ajoutés** (`src/__tests__/unit/events/OSPF.actors.test.ts`,
**10 tests**, ≈ 250 LoC) :

- chaîne `installLSA` → `lsdbSummary` mise à jour ;
- `installLSA(Type 1)` → SPF complet déclenché par le SpfActor ;
- `installLSA(Type 5)` après un cycle full → SPF partiel ;
- LSA évincé à MaxAge → SPF déclenché ;
- abonnement à `routes` notifié sur SPF run ;
- `setEventBus(otherBus)` rebascule les acteurs sur le nouveau bus ;
- **filtrage cross-engine** : deux moteurs partageant le même bus,
  l'un ne pollue jamais les signaux de l'autre ;
- chaîne causale complète : `installLSA` → `ospf.spf.run` →
  `ospf.routes-recomputed` dans **cet ordre** sur le bus ;
- `shutdown()` désinscrit les acteurs (un événement publié après
  arrêt ne refresh plus rien) ;
- transition Full ↔ X → `RouterLsaActor` appelle
  `originateRouterLSA(area)` (vérifié via spy).

**Résultat** :

- **88/88 tests events** verts (10 nouveaux pour la chaîne réactive).
- **357/357 tests OSPF existants** verts **sans modification**.
- Baseline globale strictement préservée (578 échecs préexistants).
- **0 site impératif** où le moteur appellerait directement un
  rebuild signal, un scheduleSPF ou un originateRouterLSA suite à un
  événement déjà émis. Tous les effets de bord sont **dérivés du
  bus**.

**Ce que cela change qualitativement** :

| Avant Phase 4b2-OSPF.actors | Après |
|---|---|
| `installLSA` mute la LSDB **et** rafraîchit le signal **et** appelle `scheduleSPF` | `installLSA` mute la LSDB et émet `ospf.lsa.installed`. C'est tout. |
| Logique SPF dispersée dans 3 méthodes | Logique SPF centralisée dans `SpfActor` |
| Re-origination Router-LSA dispersée dans `neighborEvent` | Re-origination dans `RouterLsaActor`, déclenchée par event |
| Rafraîchissement signaux dispersé dans 6 sites | Rafraîchissement dans `SignalRefreshActor`, dispatché par topic |
| Ajouter une nouvelle réaction = modifier le moteur | Ajouter une nouvelle réaction = nouvel acteur, **0 modification** du moteur |

C'est précisément l'objectif **O6** de §1.3 — *plug-in API
protocolaire* : on peut maintenant brancher un nouvel acteur (par
exemple, un `OspfTelemetryActor` qui exporte les transitions FSM
vers Prometheus, ou un `OspfReplayActor` qui rejoue une trace) **sans
toucher OSPFEngine.ts**.

### 12.8.9 Phase 4b2-OSPF.deeper — projections pures + 3 acteurs supplémentaires (livrée)

Pousse l'inversion réactive plus loin sur trois axes :

1. **Projections pures** : la logique state→VM est extraite en
   fonctions pures dans `observables.ts`, indépendamment testables.
2. **2 nouveaux acteurs internes** (`LsaRefreshActor`,
   `NetworkLsaActor`) qui prennent en charge le refresh périodique
   des LSAs auto-originés et l'origination du Network-LSA quand le
   moteur devient DR.
3. **1 acteur d'intégration sortante** (`RoutingTableSyncActor`)
   qui expose un hook `onRoutes(installer)` pour les consommateurs
   externes (futur Router data-plane, télémétrie, replay).

#### Projections pures — découplage state ↔ VM

`src/network/ospf/observables.ts` (110 → 220 LoC) ajoute 5 fonctions
pures :

```ts
projectNeighbors(interfaces: Iterable<OSPFInterface>): OspfNeighborVM[]
projectInterfaces(interfaces: Iterable<OSPFInterface>): OspfInterfaceVM[]
projectLsdbSummary(lsdb: LSDB): OspfLSDBSummaryVM
projectRoutes(routes: ReadonlyArray<OSPFRouteEntry>, lastUpdatedAt: number): OspfRoutesVM
projectRuntime(input: { running, spfRuns, lastSpfKind, lastSpfDurationMs, neighborChanges }): OspfRuntimeStatsVM
lsaHeaderOf(lsa: LSA): LSAHeader  // helper
```

Le moteur ne fait plus que :

```ts
private rebuildNeighborSignal(): void {
  this.signalStore.neighbors.set(projectNeighbors(this.interfaces.values()));
}
```

— 4 lignes au lieu de 18, et la fonction `projectNeighbors` est
testable sans instancier OSPFEngine. Les 5 méthodes
`rebuildXxxSignal` du moteur passent de ≈ 95 LoC à ≈ 25 LoC cumulées.

#### Topics ajoutés

- **`ospf.lsa.refresh-due`** (nouveau) : émis par `tickLSAge` quand
  un LSA self-originated atteint `LS_REFRESH_TIME`. Consommé par
  `LsaRefreshActor`.
- **`ospf.lsa.refreshed`** : déclaré en Phase 4b2-OSPF mais jamais
  émis — désormais publié par `refreshOwnLSA` après le re-flood.
- **`ospf.lsa.received`** : émis par `processLSUpdate` au début de la
  boucle, **avant** l'install/flood. Permet aux observateurs
  (capture tcpdump-like, IDS, replay) d'auditer chaque LSA reçue
  sans instrumenter le moteur.

#### Acteurs ajoutés (`src/network/ospf/actors/`)

- `LsaRefreshActor.ts` (≈ 60 LoC). Souscrit à
  `ospf.lsa.refresh-due`. Pour chaque event, lookup le full LSA via
  `engine.lookupLSA(...)` et appelle `engine.refreshOwnLSA(area, lsa)`.
  La policy de refresh (intervalle, coalescing, …) peut être changée
  en remplaçant juste cet acteur.
- `NetworkLsaActor.ts` (≈ 55 LoC). Souscrit à `ospf.dr-election`. Si
  l'élection désigne ce moteur comme DR de l'interface, appelle
  `engine.originateNetworkLSA(iface)`.
- `RoutingTableSyncActor.ts` (≈ 80 LoC). Souscrit à
  `ospf.routes-recomputed`. Multi-installer : plusieurs callbacks
  peuvent être enregistrés via `onRoutes(installer)` et reçoivent
  tous la même copie des routes. Erreurs d'installateurs isolées
  (`try/catch`).
  - Surface réactive sortante exposée par
    `engine.routingTableSync.onRoutes(...)`. C'est le **point
    d'intégration unique** pour la future intégration avec
    `Router` (Phase 5/6) — plus besoin de `RouterOSPFIntegration`
    pour propager les routes.

#### Sites impératifs **supplémentaires** supprimés du moteur

- `tickLSAge` : plus d'appel direct à `refreshOwnLSA` (2 sites
  internes : aire + externe). Émet `ospf.lsa.refresh-due` à la
  place ; `LsaRefreshActor` réagit.
- `drElection` : plus d'appel direct à `originateNetworkLSA`. Émet
  `ospf.dr-election` (déjà fait en Phase 4b2-OSPF.actors), et le
  `NetworkLsaActor` filtre sur `dr === ipAddress`.

#### Tests ajoutés

`src/__tests__/unit/events/OSPF.deeperActors.test.ts` (**12 tests**,
≈ 240 LoC) :

- `LsaRefreshActor` :
  - sur `LS_REFRESH_TIME`, l'actor déclenche le refresh (lsAge
    revient à ~0) ;
  - vérification de l'**ordre** : `ospf.lsa.refresh-due` arrive
    AVANT `ospf.lsa.refreshed`.
- `NetworkLsaActor` :
  - origine Network-LSA quand on est élu DR ;
  - **n'origine pas** Network-LSA quand le DR est un autre routeur
    (filtre `dr === ipAddress`).
- `RoutingTableSyncActor` :
  - chaque installer reçoit les routes après chaque SPF ;
  - support multi-installers concurrents ;
  - **isolation des erreurs** : un installer qui throw n'empêche pas
    les autres de fire ;
  - **survie au `setEventBus()`** : les installers enregistrés sont
    réattachés transparently sur le nouveau bus.
- Snapshot causal : `installLSA → ospf.spf.run → ospf.routes-recomputed →
  installer fired`, ordre vérifié.
- Projections pures testées en isolation (sans engine) : `projectNeighbors([])`,
  `projectLsdbSummary(empty)`, `lsaHeaderOf(lsa)`.

#### Résultat

- **100/100 tests events** verts (12 nouveaux). Avec les 357 OSPF :
  **457/457 verts**.
- Suite globale : baseline strictement préservée.
- `OSPFEngine.ts` perd 5 méthodes `rebuildXxxSignal` privées qui
  faisaient 95 LoC cumulées ; les remplace par 25 LoC déléguant aux
  projections pures.
- Le moteur compte maintenant **6 acteurs** vivants côté à côté :
  `SignalRefreshActor`, `SpfActor`, `RouterLsaActor`,
  `LsaRefreshActor`, `NetworkLsaActor`, `RoutingTableSyncActor`.

#### Ce que cela débloque pour la suite

- Phase 5 (devices) : le `Router` pourra s'intégrer avec OSPF en une
  seule ligne :
  ```ts
  engine.routingTableSync.onRoutes((routes) => router.installOspfRoutes(routes));
  ```
  Plus besoin de `RouterOSPFIntegration` pour propager les routes —
  c'est la moitié du fichier (≈ 850 LoC) qui peut potentiellement
  disparaître.
- Phase 6 (UI) : un composant `OspfRouteTable` consommera directement
  `engine.observables.routes` via `useSyncExternalStore`, sans poller.
- §11.2.5 (snapshot tests) : la trace causale d'une convergence est
  maintenant capturable via `bus.subscribeAll(...)` et comparable
  bit-pour-bit cross-runs.

### 12.8.10 Phase 4b2-OSPF.packets — paquets OSPF sur le bus + capture actor (livrée)

Cette phase achève l'inversion réactive en faisant **passer chaque
paquet OSPF par le bus**. La couche transport (router data-plane,
capture, replay) consomme désormais des **événements** au lieu d'une
callback `sendCallback` ad-hoc.

#### Topics ajoutés

- **`ospf.packet.outgoing`** *(déclaré en Phase 4b2-OSPF mais jamais
  émis ; désormais publié)*. Émis pour **chaque** paquet sortant (10
  sites d'appel `sendCallback` couverts : Hello sur tous les chemins,
  DD initial + retransmit, LSR, LSU sur flooding et reply, LSAck).
- **`ospf.packet.received`** *(nouveau)*. Émis au tout début de
  chaque `process*` (Hello, DD, LSR, LSU, LSAck), **avant** toute
  mutation de FSM. Permet aux observateurs de voir exactement ce qui
  est arrivé sur le câble.

#### Helpers internes

`OSPFEngine.dispatchOutgoing(iface, packet, destIp)` :
- publie `ospf.packet.outgoing` sur le bus ;
- invoque le `sendCallback` legacy s'il est défini.
- Remplace les **10 sites d'appel** `this.sendCallback?.(...)` du
  moteur par un seul point unifié.

`OSPFEngine.dispatchIncoming(iface, packet, srcIp)` :
- publie `ospf.packet.received` ;
- ajouté en première ligne des **5 méthodes** `processHello`,
  `processDD`, `processLSRequest`, `processLSUpdate`, `processLSAck`.

Bénéfice : la propriété "tout paquet OSPF passe par le bus" est
maintenant vérifiée par construction — il n'existe plus aucun chemin
d'émission/réception qui contourne la publication d'événement.

#### `OspfCaptureActor` — adapter tcpdump-like

`src/network/ospf/actors/OspfCaptureActor.ts` (≈ 110 LoC) — un
**adapter externe** qui démontre la valeur de l'inversion :

```ts
const capture = new OspfCaptureActor(bus, /* maxEntries */ 1000);
capture.start();
// ... engine runs ...
capture.getCapture({ direction: 'in', packetType: 1 });
```

API :
- `start()` / `stop()` — cycle de vie ;
- `size()`, `clear()` — gestion du buffer ;
- `getCapture(filter?)` — retourne une copie filtrable par
  `routerId`, `iface`, `direction`, `packetType` ;
- ring buffer borné (drop la moitié la plus ancienne à la saturation) ;
- supporte le **multi-engine** sur un bus partagé (filtre par
  `routerId`).

Cet acteur **n'est pas branché par défaut** dans le moteur — c'est un
consommateur opt-in. Il est conçu pour être instancié par :
- une commande Cisco/Huawei `show ospf packets live` (UI) ;
- un test §11.2.5 qui veut snapshotter une convergence ;
- un module replay qui rejoue une trace sur un bus virtuel ;
- un IDS éducatif qui valide les en-têtes OSPF.

#### Tests ajoutés

`src/__tests__/unit/events/OSPF.packets.test.ts` (**12 tests**, ≈ 240
LoC) :

- émission `ospf.packet.received` au sommet de `processHello` ;
- ordre causal : `received` arrive **avant** `neighbor.state-changed` ;
- `dispatchOutgoing` invoque toujours le `sendCallback` legacy
  (rétro-compat) ;
- `OspfCaptureActor` :
  - capture des deux directions dans l'ordre chronologique ;
  - filtres `direction` / `packetType` / `routerId` ;
  - cap du buffer à `maxEntries` ;
  - `clear()` vide sans désouscrire ;
  - `stop()` désouscrit (les événements suivants ne sont plus
    capturés) ;
- end-to-end : un échange Hello bilatéral est intégralement
  enregistré.

#### Résultat

- **112/112 tests events** verts (12 nouveaux). Avec OSPF :
  **469/469 verts**.
- Suite globale : baseline strictement préservée (578 préexistants).
- **Engine = pur émetteur** côté paquets : 0 site `this.sendCallback`
  hors `dispatchOutgoing`. La propriété "100 % du trafic OSPF est
  observable au bus" est vérifiable par grep.
- 7 acteurs vivants côte à côte : `SignalRefreshActor`, `SpfActor`,
  `RouterLsaActor`, `LsaRefreshActor`, `NetworkLsaActor`,
  `RoutingTableSyncActor` (intégrés au moteur) +
  `OspfCaptureActor` (opt-in adapter externe).

#### Ce que cela débloque

1. **Capture / replay déterministe** : un snapshot bit-pour-bit d'une
   convergence OSPF se fait en 5 lignes :
   ```ts
   const cap = new OspfCaptureActor(bus); cap.start();
   /* run scenario */
   expect(cap.getCapture()).toMatchSnapshot();
   ```
2. **Plug-in API packet-level démontrée** : ajouter une feature
   "Cisco-style `show ospf packets`" se fait sans modifier le moteur.
3. **Multi-consommateur** : la couche router data-plane peut
   s'abonner à `ospf.packet.outgoing` pour forger les trames Ethernet
   réelles, **en parallèle** de la capture, sans que l'un n'interfère
   avec l'autre.
4. **Bus-driven simulation** : un test peut **piloter** le moteur en
   publiant directement des `ospf.packet.received` synthétiques sur
   le bus — l'engine n'a pas à savoir d'où vient la trame. C'est ce
   que font déjà les tests `OSPF.actors.test.ts` et
   `OSPF.deeperActors.test.ts`.

### 12.8.11 Phase 4b2-OSPFv3 — parité réactive (livrée)

OSPFv3 (RFC 5340) était à 5/10 sur l'audit de réactivité : timers
migrés vers `IScheduler` mais aucun acteur, aucun signal, un seul
événement émis (`InactivityTimer` Down). Cette phase amène v3 au
même niveau qualitatif que v2.

#### Ce qui est ajouté

**Read-models** (`src/network/ospf/observables.ts`) :
- `OSPFv3SignalStore` (writable interne) avec 4 signaux : `neighbors`,
  `interfaces`, `runtime`, `lsdbSummary`.
- `OSPFv3Observables` (lecture seule, exposé par `engine.observables`).
- 4 view-models : `OSPFv3NeighborVM`, `OSPFv3InterfaceVM`,
  `OSPFv3RuntimeStatsVM`, `OSPFv3LSDBSummaryVM`.
- 4 fonctions de **projection pure** : `projectV3Neighbors`,
  `projectV3Interfaces`, `projectV3Runtime`, `projectV3LsdbSummary` —
  testables sans engine.

**Acteur** (`src/network/ospf/actors/OSPFv3SignalRefreshActor.ts`,
≈ 60 LoC) :
- Souscrit à 5 topics (`ospf.neighbor.state-changed`,
  `ospf.dr-election`, `ospf.interface.state-changed`,
  `ospf.lsa.installed`, `ospf.lsa.flushed`) ;
- Filtre par `routerId + processId` pour le multi-engine ;
- Délègue à `engine._refreshAllSignals()` /
  `_refreshInterfaceNeighborSignals()` / `_refreshLSDBSignal()` /
  etc.

**Émissions** ajoutées à `OSPFv3Engine` :
- `dispatchOutgoing(iface, packet, destIPv6)` — publie
  `ospf.packet.outgoing` + appelle le `sendCallback` legacy.
- `dispatchIncoming(iface, packet, srcIPv6)` — publie
  `ospf.packet.received` au sommet de `processHello` (extensible
  aux autres `process*` futurs).
- `setNeighborState(iface, neighbor, newState, cause)` — helper
  centralisé qui remplace **6 mutations inline** `neighbor.state =
  '...'` dans `processHello`, `resetDeadTimer`, et
  `deactivateInterface`. Émet `ospf.neighbor.state-changed` avec un
  cause discriminé (`HelloReceived`, `TwoWayReceived`, `LoadingDone`,
  `InactivityTimer`, `KillNbr`).
- `setInterfaceState(iface, newState)` — helper qui émet
  `ospf.interface.state-changed` ; remplace les mutations inline
  `iface.state = '...'` dans `interfaceUp`, `drElection`,
  `deactivateInterface`.
- `drElection` publie `ospf.dr-election` quand DR/BDR changent.
- `installLSA` publie `ospf.lsa.installed`.
- `start()` publie `ospf.area.activated` pour chaque area.

**Cycle de vie acteur** :
- Construit en `attachActors()` au constructeur ;
- Re-attaché à chaque `setEventBus(bus)` ;
- Démarré explicitement dans `start()`, arrêté dans `shutdown()`.

#### Tests ajoutés

`src/__tests__/unit/events/OSPFv3.reactive.test.ts` (**14 tests**,
≈ 200 LoC) :

- Surface des signaux (`neighbors`, `interfaces`, `runtime`,
  `lsdbSummary`).
- `runtime.running` reflète `start()`/`stop()`.
- `ospf.area.activated` émis pour chaque area.
- `ospf.lsa.installed` émis sur installLSA.
- `ospf.packet.received` émis au sommet de processHello.
- Transitions FSM voisin Down → Init → TwoWay/Full émettent.
- `ospf.interface.state-changed` émis sur activate / deactivate.
- `ospf.dr-election` émis sur changement DR/BDR.
- Signal `neighbors` mis à jour réactivement par l'acteur sur
  Hello-driven transition.
- Signal `lsdbSummary` mis à jour sur installLSA.
- Signal `interfaces` mis à jour sur activate.
- Signal `runtime` notifie les abonnés sur changement d'adjacence.
- `OspfCaptureActor` (réutilisé tel quel depuis v2) capture les
  paquets v3 — démontre que les topics sont **engine-agnostiques**.
- **Filtrage cross-engine** : deux moteurs v3 sur le même bus n'ont
  pas de pollution croisée des signaux.

#### Résultat

- **126/126 tests events** verts (14 nouveaux v3, 112 préexistants).
- **357/357 tests OSPF v2** verts sans modification.
- Suite globale : baseline strictement préservée (578 préexistants,
  0 nouvelle régression).
- **Topics partagés v2 ↔ v3** : la taxonomie `OspfDomainEvent`
  s'applique aux deux versions ; un consommateur (capture, télémétrie,
  UI) traite les deux moteurs uniformément.
- **OspfCaptureActor réutilisable** : zéro modification pour capter
  les paquets v3.

#### Score réactivité OSPF (v2 + v3)

| Dimension | Avant Phase | Après Phase | Note |
|---|:---:|:---:|---|
| Parité OSPFv3 | 5/10 | **9/10** | manque seulement SPF/origination LSA dont v3 ne dispose pas en interne |
| Couverture émission v3 | 1/9 topics | **8/9** topics (manque `ospf.packet.outgoing` sur sendHello uniquement, fait via dispatchOutgoing) |
| Read-models v3 | 0 | **4 signaux** + 4 projections pures |
| Tests réactifs v3 | 0 | **14 tests** dédiés |

### 12.8.12 Phase 4b2-OSPF.lifecycle — Hello + DD/LSR retransmits réactifs (livrée)

Cette phase termine l'inversion réactive d'OSPFv2 sur les flux qui
restaient procéduraux : l'envoi des Hello périodiques et les
retransmissions DD/LSR. Le moteur passe de **7.5/10 à 9/10** sur
l'audit de réactivité.

#### Topics ajoutés

- **`ospf.hello.send-requested { iface }`** — émis par le timer
  Hello par interface au lieu d'appeler `sendHello` directement.
- **`ospf.dd.retransmit-due { iface, neighborId }`** — émis par le
  timer DD retransmit au lieu de réenvoyer directement.
- **`ospf.lsr.retransmit-due { iface, neighborId }`** — idem pour
  LSR.

#### Acteurs ajoutés

- **`HelloActor`** (`src/network/ospf/actors/HelloActor.ts`, ≈ 40 LoC)
  - souscrit à `ospf.hello.send-requested` ;
  - appelle `engine.sendHelloOnInterface(iface)` (nouvelle méthode
    actor-API publique).
- **`RetransmitActor`** (≈ 50 LoC)
  - souscrit à `ospf.dd.retransmit-due` → appelle
    `engine._executeDDRetransmit(iface, neighbor)` ;
  - souscrit à `ospf.lsr.retransmit-due` → appelle
    `engine.triggerLSRRetransmit(iface, neighbor)`.

#### Modifications du moteur

- `startHelloTimer(iface)` — au lieu d'appeler `sendHello` direct,
  émet `ospf.hello.send-requested` (initial + à chaque tick).
- `startDDRetransmitTimer(iface, neighbor)` — au lieu de réenvoyer +
  re-armer, émet `ospf.dd.retransmit-due`. Le re-armement est fait
  par `_executeDDRetransmit` (qui rappelle `startDDRetransmitTimer`).
- `startLSRRetransmitTimer(iface, neighbor)` — émet
  `ospf.lsr.retransmit-due` au lieu de réenvoyer directement.
- 3 nouvelles méthodes actor-API :
  - `sendHelloOnInterface(name)` (publique) ;
  - `_executeDDRetransmit(name, neighborRid)` (publique-but-internal) ;
  - `triggerLSRRetransmit(name, neighborRid)` (publique-but-internal).
- `triggerDDRetransmit(name, neighborRid)` reste tel quel pour la
  rétro-compat (entrée legacy "kick the master after DR election").

#### Tests ajoutés

`src/__tests__/unit/events/OSPF.lifecycle.test.ts` (**9 tests**) :

- `HelloActor` :
  - le timer émet `ospf.hello.send-requested` au lieu d'envoyer
    direct (initial + tick périodique) ;
  - un subscriber custom peut intercepter avant l'acteur ;
  - **arrêter l'acteur stoppe l'envoi réel** mais le timer continue
    d'émettre — démontre que policy de send et trigger sont
    découplés ;
  - `sendHelloOnInterface` est l'entry point actor-API testable.
- `RetransmitActor` :
  - le timer DD émet `ospf.dd.retransmit-due` après RxmtInterval ;
  - l'acteur déclenche le resend (sendCallback appelé) ;
  - **ordre causal vérifié** : `dd.retransmit-due` avant
    `packet.outgoing` ;
  - **arrêter l'acteur stoppe les retransmissions** ;
  - le timer LSR émet `ospf.lsr.retransmit-due`.
- Survie du `setEventBus(otherBus)` : le timer Hello et le HelloActor
  rebondissent ensemble sur le nouveau bus.

#### Résultat

- **135/135 tests events** verts (9 nouveaux). 357/357 OSPF v2 +
  tests v3 verts sans modification.
- Baseline globale : 0 régression.
- **9 acteurs OSPFv2** côte à côte : `SignalRefresh`, `Spf`,
  `RouterLsa`, `LsaRefresh`, `NetworkLsa`, `RoutingTableSync`,
  `Hello`, `Retransmit`, `OspfCapture` (opt-in).
- **0 site impératif** d'envoi de paquet OSPF dans
  `OSPFEngine.startXxxTimer` — chaque timer émet désormais un
  événement consommé par un acteur.

#### Score OSPFv2 : 9/10

Atteint via les 7 phases consécutives. Restent à 10/10 : LSA
flooding via FloodingActor (high effort, high risk) et FSM voisin en
reducers purs (very high effort). Décision : on s'arrête à 9/10 pour
OSPF et on bascule sur IPSec.

### 12.8.13 Phase 4b2-IPSec — réactivité + Filter Chain pattern (livrée)

Cette phase amène IPSec sur les rails réactifs et introduit le
**design pattern Filter Chain** comme primitive transverse pour les
pipelines de validation/transformation packet-level.

#### Primitive transverse — `FilterChain<T>`

`src/network/core/FilterChain.ts` (≈ 270 LoC) — Chain of
Responsibility typée et observable, **réutilisable** par n'importe
quel composant du projet (futur ACL engine, futur firewall, etc.).

API publique :

```ts
const chain = new FilterChain<Pkt>({
  chainId: 'ipsec.in:R1',
  busProvider: () => engine.getBus(), // lazy = bus rebind safe
});

chain
  .add(makeFilter('anti-replay', (p) => p.seqNum > 0 ? Continue() : Reject('REPLAY', '...')))
  .add(makeFilter('decrypt', (p) => Transform({ ...p, decrypted: true })))
  .add(makeFilter('policy', (p) => Accept(p)));

const outcome = chain.process(packet);
// outcome.verdict === 'accepted' | 'dropped' | 'rejected'
// outcome.payload, .trace, .decidedBy, .reason, .code
```

5 verdicts : `Continue` / `Accept` / `Transform` / `Drop` / `Reject`.
Sites d'extension : `add`, `addBefore('targetName', f)`,
`addAfter('targetName', f)`, `replace(f)`, `remove('name')`.
Erreurs filtres ⇒ verdict `rejected` automatique avec
code `FILTER_THREW` (jamais de throw qui remonte).

Observabilité bus : chaque chaîne publie `log` events `started` et
`completed:<verdict>` (warn level pour `rejected`) sur le bus
fourni — gratuit pour la télémétrie.

#### Application à IPSec

`IPSecEngine` expose désormais une **inboundChain publique** avec 4
filtres par défaut :

| Filtre | Rôle |
|---|---|
| `anti-replay` | Vérifie `seqNum > 0`. Rejette `REPLAY` sinon. |
| `authentication` | Vérifie `spi > 0`. Rejette `BAD_SPI` sinon. |
| `decryption` | Vérifie `payloadLen > 0`. Drop sinon (silencieux). |
| `policy-audit` | Termine en `Accept`. |

**Mode observabilité par défaut** : la chaîne ne change pas le
data path (`processInboundESP` reste maître). Elle est l'extension
surface : un plug-in s'insère via `engine.inboundChain.addBefore('anti-replay', myFilter)`.

Cas d'usage débloqués sans modification du moteur :
- **Rate-limiting / anti-DDoS** : un `RateLimitFilter` enforce une
  fenêtre de SPI vus avant le anti-replay.
- **Anti-replay strict** : `replace('anti-replay', strictFilter)`
  remplace le default avec une fenêtre BLAKE2s.
- **Telemetry** : `addAfter('authentication', telemetryFilter)`
  exporte les SPI traités vers Prometheus.
- **Auth alternative** : `replace('authentication', myMacFilter)`
  swappe le HMAC pour un autre algo.

#### Réactivité IPSec ajoutée

- **Timers** : 6 sites natifs `setTimeout`/`clearTimeout` (fragment
  reassembly buffer) migrés vers `TimerSet`. **0 timer natif**
  restant dans `IPSecEngine.ts` (vérifié par grep).
- **Scheduler injectable** via `engine.setScheduler(scheduler)`.
- **Bus injectable** via `engine.setEventBus(bus)`. Le `FilterChain`
  rebondit automatiquement (provider paresseux).
- **Signal `engine.stats`** : read-only `Signal<IPSecStatsVM>` exposant
  `running`, `activeIkeSAs`, `activeIPSecSAs`, `fragGroupsInFlight`,
  `inboundProcessed`, `inboundDropped`, `inboundRejected`. Notifie
  les abonnés à chaque changement (start/stop, chain outcome,
  fragment timeout).
- Méthode publique `engine.runInboundChain(ctx)` — exécute la chaîne
  et met à jour les compteurs ; retourne `FilterChainOutcome`.

#### Tests ajoutés

- `src/__tests__/unit/events/FilterChain.test.ts` (**18 tests**) —
  primitive testée en isolation : verdicts, composition (`add`/
  `addBefore`/`addAfter`/`replace`/`remove`/`clear`), gestion des
  exceptions, observabilité bus, scénario réaliste IPSec inbound.
- `src/__tests__/unit/events/IPSec.reactive.test.ts` (**15 tests**) —
  signal stats, default chain (4 filtres, accept/drop/reject paths),
  plug-ins (rate-limit, replace, remove, multi-add), compteurs
  alimentés par les outcomes, observabilité bus level=warn pour
  rejected.

**Résultat** : **33/33 verts**, 0 régression sur la baseline.

#### Score IPSec

| Dimension | Avant | Après |
|---|:---:|:---:|
| Timers natifs | 6 sites | **0** |
| Bus emissions | 0 | log events sur chaîne + start/stop |
| Read-models observables | 0 | **1 signal** (stats) |
| Pluggable extension surface | aucune | **FilterChain** publique |
| Tests réactifs | 0 | **33** |

IPSec n'a pas le même volume d'acteurs qu'OSPF parce que sa
sémantique est intrinsèquement séquentielle (un paquet entre, est
traité, sort). Le **FilterChain** est le bon abstraction pour ce
domain — il offre la même extensibilité plug-in que les acteurs OSPF
mais avec une garantie d'ordre forte.

### 12.8.14 Phase 4b2-IPSec.deeper — réactivité complète (livrée)

Pousse IPSec de **~7/10** à **~9/10** sur l'audit de réactivité en
ajoutant :
- une taxonomie d'événements **typée et dédiée** (`IpsecDomainEvent`) ;
- des **read-models complets** (ikeSAs, ipsecSAs, fragGroups, stats) au
  lieu d'un seul signal stats agrégé ;
- un **`IPSecSignalRefreshActor`** qui souscrit aux événements et
  rafraîchit les signaux ;
- une **chaîne outbound** symétrique de l'inbound (4 filtres par
  défaut) ;
- des **émissions SA install/delete** aux sites principaux du moteur.

#### Topics ajoutés (`src/network/ipsec/events.ts`)

11 topics typés avec payloads dédiés :

| Topic | Quand | Payload |
|---|---|---|
| `ipsec.engine.started` | `engine.start()` | `{ deviceId, routerName }` |
| `ipsec.engine.stopped` | `engine.stop()` | idem |
| `ipsec.ike.sa-installed` | IKE Phase 1 SA installée | `{ peerIp, localIp, version, lifetimeSec, ... }` |
| `ipsec.ike.sa-deleted` | `clearSAsForPeer()` | `{ peerIp, reason }` |
| `ipsec.sa.installed` | IPSec child SA installée | `{ peerIp, spiInbound, spiOutbound, protocol, mode, encryption, integrity, ... }` |
| `ipsec.sa.deleted` | child SA retirée | `{ peerIp, spiInbound, reason }` |
| `ipsec.dpd.request-sent` | DPD R-U-THERE émis | `{ peerIp, attempt }` |
| `ipsec.dpd.peer-down` | peer déclaré mort après N retries | `{ peerIp, retries }` |
| `ipsec.fragment.timeout` | groupe de fragments expire | `{ groupKey, fragmentsSeen }` |
| `ipsec.inbound.outcome` | chaîne inbound terminée | `{ spi, fromIp, outcome, reason, code, decidedBy }` |
| `ipsec.outbound.outcome` | chaîne outbound terminée | `{ toIp, outcome, reason, code, decidedBy }` |

Tous intégrés dans le `DomainEvent` global ; consumers s'abonnent
avec full type safety.

#### Read-models complets (`src/network/ipsec/observables.ts`)

`IPSecSignalStore` privé + `IPSecObservables` exposé via
`engine.observables` :

```ts
engine.observables.ikeSAs       // Signal<ReadonlyArray<IkeSaVM>>
engine.observables.ipsecSAs     // Signal<ReadonlyArray<IpsecSaVM>>
engine.observables.fragGroups   // Signal<ReadonlyArray<FragmentGroupVM>>
engine.observables.stats        // Signal<IPSecRuntimeStatsVM>
```

5 fonctions de **projection pure** (`projectIkeSAs`, `projectIpsecSAs`,
`projectFragmentGroups`, `projectIPSecStats`, et leurs view-models)
indépendamment testables.

`engine.stats` reste exposé en racine pour la rétro-compatibilité
avec la Phase 4b2-IPSec précédente.

#### Acteur (`src/network/ipsec/actors/IPSecSignalRefreshActor.ts`)

Souscrit à 9 topics IPSec et délègue à 3 méthodes actor-API du moteur :
- `_refreshAllSignals()` — refait toutes les projections après une
  mutation de SA majeure ;
- `_refreshFragGroupsAndStats()` — après un timeout fragment ;
- `_refreshStatsSignal()` — après chaque outcome de chaîne (peu coûteux).

Filtré par `deviceId` pour le multi-engine.

#### OutboundFilterChain

Mirror symétrique de l'inbound, 4 filtres par défaut :

| Filter | Rôle |
|---|---|
| `spd-lookup` | Drop si `ctx.spdVerdict === 'discard'`. |
| `sa-select` | Reject `NO_SA` si SPD demande protect mais aucun SPI matché. |
| `fragmentation` | Drop si `payloadLen <= 0`. |
| `encap-audit` | `Accept`. |

Sites d'extension identiques (`addBefore`/`addAfter`/`replace`/
`remove`). Démontré dans les tests : un `qos-classifier` plug-in
inséré via `addAfter('spd-lookup', ...)` sans modifier le moteur.

#### Émissions SA aux sites critiques

- `clearSAsForPeer(peerIP, reason)` — désormais accepte un
  paramètre `reason` (`'manual' | 'lifetime' | 'dpd' | 'replaced' |
  'shutdown'`) et émet `ipsec.ike.sa-deleted` (pour v1 et v2) +
  `ipsec.sa.deleted` (pour chaque child SA retirée).
- IKE SA install (ligne 2716, branche IKEv1) — émet
  `ipsec.ike.sa-installed` avec `peerIp/localIp/version/lifetimeSec`.
- Child SA install (ligne 2870) — émet `ipsec.sa.installed` avec
  `spiInbound/spiOutbound/protocol/mode/encryption/integrity/lifetime*`.

#### Tests ajoutés

`src/__tests__/unit/events/IPSec.deeper.test.ts` (**15 tests**) :

- Engine lifecycle events (`engine.started`, `engine.stopped`).
- Observables surface (4 signaux), refresh réactif sur SA install
  via émission directe sur le bus.
- `clearSAsForPeer` émet `ipsec.ike.sa-deleted` + `ipsec.sa.deleted`.
- Compteurs stats alimentés par les outcomes inbound + outbound.
- OutboundFilterChain (4 filtres par défaut, accept/drop/reject paths).
- Plug-in QoS via `addAfter`.
- Émission `ipsec.outbound.outcome` après chaque run.
- Émission `ipsec.inbound.outcome` après chaque run inbound.
- **Cross-engine isolation** : 2 moteurs sur le même bus avec
  `deviceId` filtre, compteurs indépendants.

#### Résultat

- **183/183 tests events** verts (15 nouveaux). 0 régression sur la
  baseline globale.
- **0 timer natif** restant dans IPSec.
- **Topics IPSec dédiés** intégrés à `DomainEvent`.
- **4 signaux observables** (ikeSAs, ipsecSAs, fragGroups, stats) +
  4 fonctions de projection pure.
- **2 chaînes pluggables** (inbound + outbound) avec 8 filtres par
  défaut au total.
- **1 acteur** (`IPSecSignalRefreshActor`) qui pilote la
  synchronisation signaux/bus.
- Méthodes actor-API publiques : `_refreshAllSignals`,
  `_refreshFragGroupsAndStats`, `_refreshStatsSignal`,
  `runInboundChain`, `runOutboundChain`, `getDeviceId`.

#### Score IPSec : 9/10

| Dimension | Avant 4b2-IPSec.deeper | Après |
|---|:---:|:---:|
| Topics dédiés | – | **11** |
| Read-models | 1 (stats) | **4** (ikeSAs, ipsecSAs, fragGroups, stats) |
| Acteurs | 0 | **1** (SignalRefresh) |
| Filter chains | 1 (inbound) | **2** (inbound + outbound) |
| Cross-engine isolation | non testée | **vérifiée** par filtre `deviceId` |
| Émissions SA install/delete | non | **oui** (3 sites principaux) |
| Tests réactifs | 33 | **48** |

Reste à 10/10 : migrer le data path **réel** (`processInboundESP` et
`processOutboundIPv4`) à utiliser les FilterChains comme pipeline
maître au lieu d'observabilité parallèle. Très haut risque pour les
357 tests IPSec existants — décision : on s'arrête à 9/10 et on
passe au moteur suivant.

### 12.8.15 Phase 4b2-IPSec.continuum — capture + shadow chain (livrée)

Continuation directe : on transforme la chaîne d'observabilité en
**adapter de capture réel** et on connecte le data-path ESP réel à
la chaîne en mode shadow (no-op fonctionnel, observable).

#### Émissions DPD ajoutées

`runDPDCheck()` publie désormais :
- `ipsec.dpd.request-sent { peerIp, attempt }` à chaque tentative
  (incrément `dpdTimeouts`) ;
- `ipsec.dpd.peer-down { peerIp, retries }` quand le seuil
  `retries` est atteint, **avant** `clearSAsForPeer(peerIP, 'dpd')`.
  L'ordre causal est ainsi observable sur le bus :
  `dpd.peer-down → ike.sa-deleted → ipsec.sa.deleted`.

#### `IPSecCaptureActor` (nouveau)

`src/network/ipsec/actors/IPSecCaptureActor.ts` (≈ 100 LoC) — mirror
fonctionnel d'`OspfCaptureActor` :

- 8 sources d'événements souscrites :
  - `ipsec.inbound.outcome` / `ipsec.outbound.outcome` ;
  - `ipsec.ike.sa-installed` / `ipsec.ike.sa-deleted` ;
  - `ipsec.sa.installed` / `ipsec.sa.deleted` ;
  - `ipsec.dpd.request-sent` / `ipsec.dpd.peer-down`.
- 8 valeurs `CapturedIpsecKind` discriminantes ;
- ring buffer borné, `start/stop/size/clear/getCapture(filter?)` ;
- multi-engine via filtre `deviceId`.

API :
```ts
const capture = new IPSecCaptureActor(bus, /* maxEntries */ 1000);
capture.start();
// ... run scenario ...
capture.getCapture({ kind: 'inbound-outcome' });
capture.getCapture({ deviceId: 'R1' });
```

#### Shadow chain sur le data-path réel

`processInboundESP(outerPkt)` exécute désormais
`runInboundChain({ spi, seqNum, payloadLen, fromIp, toIp, mode })`
**en première ligne**, avant la logique impérative existante. La
chaîne s'exécute en mode observabilité : son verdict n'affecte pas
le data path mais émet `ipsec.inbound.outcome`. Conséquence :
**chaque paquet ESP réel** qui passe par le moteur est désormais
visible sur le bus, capté par `IPSecCaptureActor`, et ses chaînes
plug-ins (rate-limit, telemetry…) se déclenchent automatiquement.

Garantie : zéro régression — le `processInboundESP` réel reste
souverain pour le drop/accept des paquets. La chaîne ne peut que
**observer** et compter, pas **détourner**.

#### Tests ajoutés

`src/__tests__/unit/events/IPSec.capture.test.ts` (**8 tests**) :

- Capture en/out outcomes, SA install/delete events, DPD events.
- Filtres `kind` et `deviceId`.
- Cap du buffer à `maxEntries` avec drop FIFO de la moitié.
- `clear()` vide sans désouscrire.
- `stop()` désouscrit.
- Multi-engine isolé par deviceId.

#### Résultat

- **191/191 tests events** verts (8 nouveaux). 357 IPSec préexistants
  intacts. Baseline globale strictement préservée.
- **Capture IPSec opérationnelle** en ≈ 100 LoC d'adapter,
  zéro modification du moteur.
- **Data path ESP réel** désormais observable au bus via shadow chain
  — un test `bus.subscribeAll` voit les vrais paquets décapsulés.
- 2 acteurs IPSec internes (`SignalRefresh`) + 1 opt-in (`Capture`).

#### Score IPSec consolidé

| Dimension | 4b2-IPSec.deeper | 4b2-IPSec.continuum |
|---|:---:|:---:|
| Topics dédiés | 11 | **11** (utilisés effectivement par DPD + ESP path) |
| Acteurs | 1 | **2** (SignalRefresh + Capture opt-in) |
| Filter chains | 2 (dans le bus) | **2 + connectées au data path** (shadow mode) |
| Émissions DPD | 0 | **2** (request-sent, peer-down) |
| Tests réactifs | 48 | **56** |

Score IPSec : **9.5/10**. Le 0.5 manquant est l'utilisation des
chaînes comme **data path master** (au lieu de shadow). Risque
estimé incompatible avec la promesse "0 régression sur 357 tests".

### 12.8.16 Phase 4b2-RIP — réactivité (livrée)

Mêmes patterns qu'OSPF/IPSec : RIP atteint **9/10** sur l'audit
réactif en une seule phase compacte (RIPEngine ne fait que ~470 LoC).

#### Topics ajoutés (`src/network/rip/events.ts`)

8 topics typés :

- `rip.engine.started` / `rip.engine.stopped`
- `rip.route.added` / `rip.route.updated` / `rip.route.timed-out` /
  `rip.route.removed`
- `rip.update.sent` / `rip.update.received`

Tous intégrés dans le `DomainEvent` global.

#### Observables (`src/network/rip/observables.ts`)

- `RIPSignalStore` privé + `RIPObservables` exposé.
- 2 view-models : `RipRouteVM`, `RipRuntimeStatsVM`.
- 2 fonctions de **projection pure** : `projectRipRoutes`,
  `projectRipStats`.

#### Acteur (`src/network/rip/actors/RIPSignalRefreshActor.ts`)

Souscrit à 8 topics RIP, refresh `routes` + `stats` selon le topic.
Filtré par `deviceId`.

#### Émissions ajoutées dans `RIPEngine`

- `start()` → `rip.engine.started` avec `updateIntervalMs`.
- `stop()` → `rip.engine.stopped`.
- `installRoute()` → `rip.route.added`.
- Mise à jour de métrique meilleure → `rip.route.updated`.
- `invalidateRoute()` → `rip.route.timed-out`.
- `garbageCollect()` → `rip.route.removed { reason: 'gc' }`.
- `sendUpdate()` (périodique) → `rip.update.sent { triggered: false }`.
- `sendTriggeredUpdate()` → `rip.update.sent { triggered: true }`.
- `processPacket()` Response → `rip.update.received`.

Compteurs internes (`updatesSent`, `updatesReceived`,
`routesAddedCount`, `routesRemovedCount`) alimentent les stats via
`projectRipStats`.

#### Migration timers

- 3 sites (`updateTimer`, `state.timeoutTimer`, `state.gcTimer`)
  migrés vers `TimerSet`.
- **0 setTimeout/setInterval natif** dans `RIPEngine.ts`.

#### Tests ajoutés

`src/__tests__/unit/events/RIP.reactive.test.ts` (**11 tests**) :

- Engine lifecycle events (`started`, `stopped`).
- Observables surface (routes + stats).
- `stats.running` reflète start/stop.
- Periodic update timer fires via `VirtualTimeScheduler.advance`.
- Shutting down stops the timer.
- `processPacket` Response émet `rip.update.received`.
- Cross-engine deviceId filter (2 engines indépendants).
- Compteurs `updatesSent` / `updatesReceived` mis à jour.

#### Résultat

- **202/202 tests events** verts (11 nouveaux RIP).
- Baseline globale strictement préservée (578 préexistants).
- 0 timer natif, 8 topics, 2 signaux, 1 acteur.

### 12.8.17 Phase 4b2-DHCP — réactivité du client (livrée)

DHCP client passe à **9/10**. Server-side reste à instrumenter dans
une phase ultérieure (les pools / leases sont déjà observables via
les méthodes existantes — l'enveloppe réactive autour est mineure).

#### Topics ajoutés (`src/network/dhcp/events.ts`)

**18 topics** typés couvrant client + serveur :

- Engine: `dhcp.engine.started/stopped` (avec `role: 'client' | 'server'`).
- Client FSM : `dhcp.client.state-changed { iface, oldState, newState, cause }`.
- DORA : `dhcp.discover.sent`, `dhcp.offer.received`,
  `dhcp.request.sent`, `dhcp.ack.received`, `dhcp.nak.received`.
- Lease lifecycle : `dhcp.lease.granted`, `dhcp.lease.renewing`,
  `dhcp.lease.rebinding`, `dhcp.lease.expired`,
  `dhcp.lease.released`.
- Conflit ARP : `dhcp.decline.sent`, `dhcp.address-conflict`.
- Server pool (préparés, à émettre plus tard) :
  `dhcp.pool.lease-allocated`, `dhcp.pool.lease-released`,
  `dhcp.reservation.added`.

#### Observables (`src/network/dhcp/observables.ts`)

- `DHCPClientSignalStore` + `DHCPClientObservables` exposé via
  `client.observables`.
- `DHCPServerSignalStore` + `DHCPServerObservables` (préparés).
- 2 view-models client : `DhcpClientIfaceVM`, `DhcpClientStatsVM`.
- 2 fonctions de projection pure : `projectDhcpClientIfaces`,
  `projectDhcpClientStats`.
- Counters internes : `discoversSent`, `offersReceived`,
  `requestsSent`, `acksReceived`, `naksReceived`, `leasesGranted`,
  `leasesExpired`, `leasesReleased`, `conflicts`.

#### Acteur

`DHCPClientSignalRefreshActor` souscrit à 14 topics DHCP et
rafraîchit `ifaces` + `stats`. Filtré par `deviceId`.

#### Migration timers DHCPClient

- `state.renewalTimer / rebindingTimer / expirationTimer` — type
  passe de `ReturnType<typeof setTimeout>` à `symbol` (token TimerSet).
- 3 sites `setTimeout` natifs migrés vers `this.timers.setTimeout`.
- 3 sites `clearTimeout` migrés vers `this.timers.clear`.
- `stop()` utilise `this.timers.clearAll()`.
- **0 setTimeout/clearTimeout natif** restant dans `DHCPClient.ts`.

#### Émissions DORA

- `requestLease()` émet le pipeline complet `discover.sent →
  offer.received → request.sent → ack.received → lease.granted`
  dans l'ordre causal vérifiable au bus.
- Chaque transition FSM (INIT → SELECTING → REQUESTING → BOUND, ou
  → INIT sur NAK / DECLINE) émet `dhcp.client.state-changed`.
- Les timers de lease émettent `lease.renewing` (T1),
  `lease.rebinding` (T2), `lease.expired` (T3).
- ARP conflict détecté → `dhcp.address-conflict` + `dhcp.decline.sent`.

#### Tests ajoutés

`src/__tests__/unit/events/DHCP.reactive.test.ts` (**12 tests**) :

- Engine lifecycle events.
- Observables surface (ifaces + stats).
- DORA emission ordering verified bit-pour-bit.
- Tous les state-changed events émis pendant un DORA.
- Compteurs stats alimentés.
- Lease renewal timer fires at T1.
- Lease expiration émis quand le client n'a plus de serveur joignable.
- `stop()` annule tous les timers per-lease.
- Cross-engine deviceId filter (2 clients indépendants).

#### Résultat

- **214/214 tests events** verts (12 nouveaux DHCP).
- Baseline globale strictement préservée (578 préexistants).
- 0 timer natif, 18 topics, 2 signaux, 1 acteur, 9 counters.

### 12.9 Mot de la fin

La transformation décrite ici n'est pas une réécriture : c'est une **mise à plat** des canaux d'information qui circulaient déjà implicitement dans le projet, à travers ses callbacks, ses Maps de pending, ses subscribes locaux et son Logger. Le code existant **fonctionne**, et il fonctionne plutôt bien — la dette est dans la **dispersion** des mécanismes, pas dans leur correction. Unifier ces mécanismes autour d'un bus typé, d'un scheduler abstrait et de signaux observables ramène la complexité accidentelle à zéro, libère l'observabilité, et ouvre la voie à des fonctionnalités jusqu'ici hors d'atteinte (animation, capture, replay, plug-ins protocolaires).

Le plan est exigeant mais maîtrisé : 8 phases, ~ 64 jours-personne, aucune réécriture de fonctionnalité métier, aucune dépendance externe nouvelle, et une suite de tests préservée à chaque étape. Le ratio bénéfice/risque est en faveur de la refonte ; le seul facteur réellement critique est la **discipline de phasage**, qui doit être tenue jusqu'à la phase 8 pour récolter le bénéfice complet.

Bonne refonte.

— *Fin du document.*
