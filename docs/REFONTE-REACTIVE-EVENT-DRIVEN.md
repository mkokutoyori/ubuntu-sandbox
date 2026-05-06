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
5. Analyse de la couche terminal *(à venir)*
6. Analyse du store Zustand et des composants React *(à venir)*
7. Analyse de la couche base de données (Oracle) *(à venir)*
8. Architecture cible — bus d'événements, scheduler, état observable *(à venir)*
9. Refactoring détaillé par classe *(à venir)*
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
