# Refonte vers une architecture réactive et événementielle

> Rapport d'analyse et plan de refonte pour Ubuntu Sandbox.
> Document vivant — rédigé section par section, chaque section faisant l'objet d'un commit dédié.
> Branche : `claude/reactive-event-driven-refactor-8hVAE`

---

## Table des matières

1. [Introduction & objectifs de la refonte](#1-introduction--objectifs-de-la-refonte)
2. [État actuel de l'architecture](#2-état-actuel-de-larchitecture)
3. Analyse de la couche réseau — `Equipment` / `Port` / `Cable` *(à venir)*
4. Analyse des `devices` concrets et des moteurs de protocoles *(à venir)*
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
