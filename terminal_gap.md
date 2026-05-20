# Terminal Gap Analysis

Audit complet de l'implémentation des terminaux (UI + backend) du simulateur réseau
Ubuntu Sandbox. Le but est de relever toutes les anomalies, incohérences, comportements
non-réalistes ou facilement régressifs, puis de proposer/implémenter des corrections
qui s'inscrivent dans l'architecture event-bus + reactive du projet.

Convention :
- **Anomalie** — description du défaut observé dans le code
- **Impact** — ce que ressent l'utilisateur
- **Cause racine** — explication technique
- **Correctif** — patch implémenté ou design proposé
- Les fichiers/lignes citées sont au format `path:line` pour navigation rapide.

---

## Section 1 — Cycle de vie : terminaux orphelins lors de suppression / power-off

### 1.1 Suppression d'une machine : ses terminaux restent ouverts

**Anomalie.** `useNetworkStore.removeDevice()` (src/store/networkStore.ts:160) supprime
la machine du store, déconnecte ses câbles et la retire de l'état React, **mais** :
- ne désenregistre pas l'équipement de l'`EquipmentRegistry` (jamais appelé
  `EquipmentRegistry.getInstance().deregister(id)`) ;
- ne ferme aucune des sessions terminal ouvertes sur cette machine.

Conséquences :
1. Les `TerminalSession` restent vivantes dans le `TerminalManager` (singleton).
2. La taskbar continue à afficher la tuile « machine123 » avec son icône verte
   alors que la machine n'existe plus.
3. Les sessions SSH actives, les sub-shells (SQL\*Plus, RMAN, sftp), les forwarders
   `-L`/`-R`/`-D` et l'agent forwarding pointent vers un `Equipment` fantôme.
4. L'`EquipmentRegistry` leak ses devices : la prochaine itération
   `Equipment.getAllEquipment()` les retourne encore (utilisé par les protocoles
   OSPF, DHCP, etc. pour trouver des voisins).

### 1.2 Mise hors tension d'une machine : ses terminaux restent ouverts et trompeurs

**Anomalie.** `useNetworkStore.updateDevice({isPoweredOn:false})` appelle
`device.powerOff()` (qui émet correctement `device.power-off` sur l'event bus,
voir Equipment.ts:171) mais aucun composant côté terminal ne réagit. Le terminal
continue d'accepter du texte ; la première commande renvoie en erreur via
`assertDeviceOnline()` (TerminalSession.ts:297), mais :
- le prompt et la zone de saisie restent en mode « normal » comme si tout
  fonctionnait ;
- les processus en arrière-plan, les supervisors `systemd`, les sessions SSH
  sortantes continuent d'apparaître dans `ps`/`systemctl` jusqu'au prochain
  redémarrage UI.

### 1.3 « Clear all » : terminaux fantômes

**Anomalie.** `clearAll()` (src/store/networkStore.ts:331) appelle
`resetDeviceCounters()`, vide le store, mais ne ferme aucune session terminal. La
taskbar reste peuplée alors que les `Equipment` référencés sont déréférencés.

### 1.4 Aucune écoute réactive sur le bus d'événements

**Anomalie.** Le `TerminalManager` est entièrement piloté par l'UI (NetworkDesigner
appelle `closeTerminal` explicitement). Pourtant, le projet dispose déjà du
event-bus typé (`src/events/EventBus.ts`) qui publie :
- `device.power-on`, `device.power-off` (Equipment.ts)
- `device.deregistered`, `registry.cleared` (EquipmentRegistry.ts)
- `device.renamed`

Aucun de ces événements n'est consommé par la couche terminal. La doctrine
documentée dans `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` est violée : la couche
applicative *devrait* réagir aux événements domaine plutôt que d'être appelée
explicitement.

### 1.5 Sessions SSH/sub-shells non détruites quand la cible est éteinte

**Anomalie.** Quand la machine **distante** d'un `pushRemoteDevice()`
(LinuxTerminalSession.ts:1677) est mise hors tension, la pile SSH (`sshStack`)
reste valide. L'utilisateur reste piégé dans un prompt remote inopérant ;
`syncDeviceState()` ne fait rien parce que `device.getCwd()` répond toujours
(`/home/...`) — la classe est en mémoire, juste `isPoweredOn=false`.

### 1.6 Correctif implémenté

Trois changements coordonnés :

**(a) Le store appelle `deregister` et signale au bus la suppression.** On
introduit aussi un nouvel événement typé `device.removed` afin de distinguer
« suppression utilisateur » de « clear all » et de la déconnection silencieuse
post-clear. La modification est rétro-compatible.

**(b) Le `TerminalManager` s'abonne au bus.** Sur :
- `device.power-off`  → on **gèle** la session (ajout d'une ligne
  `Connection to <host> lost.`, on passe l'`InputMode` en `disconnected` pour
  interdire la saisie tout en conservant l'historique visible) ;
- `device.power-on`   → on dégèle la session (mode `normal`) ;
- `device.removed` / `device.deregistered` / `registry.cleared` → on **dispose**
  toutes les sessions associées (le device n'existe plus, conserver leur état
  serait factuellement faux).

**(c) Les sub-shells & SSH frames se replient proprement.** `closeTerminal`
déroule `sshStack` (appelant chaque `onPop` enregistré, ce qui dispose
`session.disconnect()` + les forwarders) et appelle `activeSubShell?.dispose?.()`
si l'interface le supporte.

Ce correctif touche : store, TerminalManager, TerminalSession, LinuxTerminalSession,
events/types.ts. Un nouveau type d'`InputMode` `disconnected` est ajouté ; la vue
le rend en lecture seule.

---
