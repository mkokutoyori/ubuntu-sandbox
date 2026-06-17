# Journal de bord — Émulation des commandes asynchrones

Itération dédiée à l'émulation correcte des commandes asynchrones pour tous
les équipements (routeurs, switches, firewalls, PC Linux, PC Windows), via un
pipeline unifié unique (philosophie « une bonne fois pour toutes »).

Branche de travail : `mandeng`.

## Architecture socle

Pipeline asynchrone unifié posé sous `src/terminal/async/` :

- `types.ts` — contrats publics partagés par tous les équipements :
  - `AsyncJobSpec` (forme générique) et ses spécialisations nommées
    `StreamingOutput`, `BackgroundProcess`, `EventSubscription`, regroupées sous
    `AsyncCommand`.
  - `AsyncJobContext` (`sink`, `signal`, `cancelled()`, `onCancel()`, `delay()`).
  - `AsyncJobSink` (`line` / `lines` / `write` streaming / `warn` / `error`).
  - `AsyncJobHandle` (vue listable et arrêtable d'un job en cours).
- `LineAssembler.ts` — assemblage incrémental chunk → lignes avec report de
  ligne partielle (généralise l'ancien `_tailCarry`/`emitTailChunk` du tail).
- `TerminalAsyncRuntime.ts` — moteur par session :
  - foreground (bloquant) : verrouille le prompt via `attachStream`, interrompu
    par Ctrl+C (`interruptForeground`) avec flush de ligne partielle, `^C`, puis
    hook `onInterrupt` (résumé final).
  - background : prompt libéré immédiatement, job persistant, listable
    (`listJobs`), arrêtable (`cancel`, `cancelWhere`).
  - annulation propre globale à la fermeture de session (`cancelAll`).
  - `delay()` abortable, `AbortSignal` exposé aux commandes.

Intégration dans la classe de base `TerminalSession` (donc héritée par toutes
les sessions vendeurs Linux / Cisco / Huawei / Windows) :

- instance `asyncRuntime` câblée sur `addLine` / `addLines` / `notify` /
  `attachStream`.
- API publique : `startAsyncCommand`, `listAsyncJobs`, `cancelAsyncJob`,
  `cancelAsyncJobsWhere`, getters `hasForegroundAsyncJob` /
  `hasBackgroundAsyncJobs`.
- `onCtrlC` de base délègue d'abord à `interruptForeground`.
- `dispose` annule tous les jobs en cours.

Migration de l'existant (enhancement, pas de mécanique parallèle) :

- `tail -f` / `tail -F` (`LinuxTerminalSession`) ne porte plus sa logique async
  custom (`activeTailStream`, `activeTailAttachment`, `_tailCarry`,
  `emitTailChunk`, `onCtrlC` dédié). Il passe désormais par
  `startAsyncCommand` (job foreground streaming). Le verrouillage du prompt, le
  Ctrl+C et le flush de ligne partielle sont gérés par le runtime commun.

Validation : `tail-follow-ui.test.ts`, `TailAttachStream.test.ts`,
`SessionInputHost.test.ts` — 14/14 verts. Aucune nouvelle erreur de type.

## Event Subscription Commands

### Router (Cisco IOS) — `debug ip ospf …` / `no debug …`

Première commande branchée sur le socle (catégorie « abonnement aux
événements »).

- `RouterDebugService` enrichi : registre de flags devenu émetteur pub/sub
  (`subscribe`, `hasAnyFlag`) et pont d'événements (`attachToBus` /
  `detachFromBus`). Il s'abonne au bus du device pour les topics OSPF
  (`ospf.neighbor.state-changed`, `ospf.interface.state-changed`,
  `ospf.spf.run`, `ospf.hello.send-requested`, `ospf.packet.*`) et, lorsque le
  flag de la catégorie correspondante est armé, formate une ligne de debug IOS
  réaliste qu'il diffuse à ses abonnés. Filtrage par `deviceId`.
- `Router.setEventBus` attache/détache le service de debug au bus (même schéma
  que `attachLoggingToBus` / SNMP `attachToBus`).
- `CLITerminalSession` expose un hook générique `afterCommandExecuted` appelé
  après chaque commande et son `updatePrompt`.
- `CiscoTerminalSession.afterCommandExecuted` réconcilie l'état : dès qu'un flag
  de debug est armé, un job d'abonnement (`mode: background`, `kind:
  subscription`) est démarré via le socle ; il s'abonne au service et déverse
  les lignes en temps réel dans le terminal (prompt libre, non bloquant). Quand
  plus aucun flag n'est armé (`no debug …` / `undebug all`), le job est annulé.

Critères couverts : streaming temps réel ligne par ligne, prompt non bloqué
(commande d'arrière-plan), arrêt propre via `no debug`, isolation des sessions
(chaque terminal a son propre runtime et son propre abonnement), impact sur
l'état interne réel (les lignes proviennent des vrais événements du bus du
device), privilège enable requis (commande `debug` en mode privilégié).

Validation : `cisco-debug-subscription.test.ts` — 4/4 verts (stream ADJCHG
live, prompt libre, arrêt sur `no debug`, isolation inter-sessions).

### Switch (Cisco IOS) — `debug spanning-tree …` / `no debug spanning-tree`

Deuxième commande de la catégorie « abonnement aux événements », même socle.

- Factorisation DRY : extraction de `DebugBroadcast`
  (`src/network/devices/diag/DebugBroadcast.ts`) — cœur générique de diffusion
  (set d'abonnés, fan-out, suivi/détachement des souscriptions bus) et interface
  `TerminalDebugSource` (`hasAnyFlag` + `subscribe`) que toute source de debug
  implémente. `RouterDebugService` est refactoré pour composer ce cœur (aucun
  changement de signature publique).
- `SwitchDebugService` (`src/network/devices/switch/SwitchDebugService.ts`) :
  source de debug STP bridgée au bus (`stp.role.changed`, `stp.state.changed`,
  `stp.root.changed`, `stp.topology.change`, `stp.bpdu.sent/received`,
  `stp.bpdu-guard.violation`), catégories `events` / `bpdu`, filtrage par
  `deviceId`.
- `CiscoSwitch` expose `getDebugService()` et l'attache/détache dans
  `setEventBus` (même schéma que le routeur).
- `CiscoSwitchShell` route `debug spanning-tree` / `no debug spanning-tree` /
  `undebug` / `no debug all` vers le service (tout en conservant l'affichage
  `show debugging` existant).
- `CiscoTerminalSession.afterCommandExecuted` généralisé : ne dépend plus de
  `instanceof Router` mais d'un duck-typing `getDebugService(): TerminalDebugSource`.
  Routeur et switch partagent ainsi exactement le même pipeline d'abonnement.

Validation : `cisco-switch-debug-subscription.test.ts` — 2/2 verts ; le test
routeur reste vert après refactor ; régressions STP / switch CLI vertes
(`cisco-stp`, `cisco-switch-exec-commands`, `switch-cli`).

### UI — indicateur de commandes background actives

Exigence du cahier des charges (« Indicateur visuel signalant qu'une ou
plusieurs commandes background sont actives »).

- `InfoBar` (`TerminalView.tsx`) affiche désormais un témoin pulsant à droite
  dès qu'au moins un job `mode: background` tourne : libellé du job s'il est
  unique (`● IOS debug output`), sinon `● N background tasks`. Piloté par
  `session.listAsyncJobs()` ; rafraîchi à chaque `notify` du socle via le
  `useSyncExternalStore` déjà en place.
- Rappel comportement réel : `debug spanning-tree` n'imprime que sur un
  événement STP réel (transition de port, BPDU, changement de topologie). Sur un
  switch isolé et déjà convergé, il n'y a rien à streamer — conforme à IOS. Le
  témoin permet désormais de voir que l'abonnement est bien armé.

Validation : `terminal-infobar-indicator.test.tsx` — 3/3 verts.

## Suite

- Event Subscription : Firewall → PC Linux → PC Windows.
- Puis Real-Time Monitoring, puis Background Commands.
