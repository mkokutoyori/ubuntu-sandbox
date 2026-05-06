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
10. Plan de migration séquentiel *(à venir)*
11. Risques, tests et métriques de succès *(à venir)*
12. Conclusion et annexes *(à venir)*

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
