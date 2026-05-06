# Refonte vers une architecture réactive et événementielle

> Rapport d'analyse et plan de refonte pour Ubuntu Sandbox.
> Document vivant — rédigé section par section, chaque section faisant l'objet d'un commit dédié.
> Branche : `claude/reactive-event-driven-refactor-8hVAE`

---

## Table des matières

1. [Introduction & objectifs de la refonte](#1-introduction--objectifs-de-la-refonte)
2. État actuel de l'architecture *(à venir)*
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
