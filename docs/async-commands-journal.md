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

## Real-Time Monitoring Commands

### PC Linux / Firewall — `tcpdump …` (capture live en avant-plan)

Première commande de la catégorie « monitoring temps réel », sur le même socle.
Couvre aussi le besoin Firewall, le firewall étant un `LinuxPC` (cf. CLAUDE.md).

État de départ : `cmdTcpdump` (`LinuxNetCommands`) rendait un **dump unique** du
`PacketCaptureLog` puis rendait la main — exactement le « dump unique » que cette
itération veut remplacer par un affichage progressif bloquant.

- `PacketCaptureSource` (`src/network/devices/host/PacketCaptureSource.ts`) :
  source de capture live bridgée au bus du device. Réutilise le cœur générique
  `DebugBroadcast` (set d'abonnés + suivi/détachement des souscriptions bus) et
  formate des lignes tcpdump réalistes à partir des vrais événements
  `host.icmp.echo-sent` / `host.icmp.echo-reply` (`IP src > dst: ICMP echo
  request/reply, id, seq, length`), `host.arp.request-sent` (`ARP, Request
  who-has … tell …`) et `host.arp.entry-learned` (`ARP, Reply … is-at …`).
  Filtrage strict par `deviceId`.
- `EndHost.getPacketCaptureSource()` + `EndHost.setEventBus` attache/détache la
  source (même schéma que le routeur/switch). Posé sur `EndHost` pour couvrir
  Linux et Windows d'un coup.
- `LinuxTerminalSession.tryStartTcpdump` intercepte `tcpdump` / `sudo tcpdump`
  avant la délégation au shell bash et démarre un job **foreground streaming**
  (socle unifié, comme `tail -f`) : en-tête `listening on …`, lignes diffusées au
  fil de l'eau (prompt verrouillé), `-c <count>` arrête proprement après N
  paquets, et Ctrl+C (hook `onInterrupt`) imprime le résumé `N packets
  captured / N received by filter / 0 dropped by kernel`. Privilège root requis
  (sinon `You don't have permission to capture on that device`).
- Le chemin exécuteur (`LinuxCommandExecutor` → `cmdTcpdump`) reste inchangé pour
  l'usage non-interactif / pipe (suite `linux-lan-ssh-suite`), donc zéro
  régression.

Critères couverts : streaming temps réel ligne par ligne, prompt bloqué
(foreground), interruption propre via Ctrl+C avec résumé final, arrêt automatique
sur `-c`, isolation des sessions (chaque terminal a son runtime/abonnement),
impact sur l'état interne réel (lignes issues des vrais événements du bus du
device), privilège root respecté, message d'erreur fidèle à l'OS.

Validation : `linux-tcpdump-live.test.ts` — 5/5 verts (stream ICMP live + prompt
bloqué, refus non-root, résumé Ctrl+C, arrêt `-c`, isolation inter-sessions) ;
`linux-lan-ssh-suite` (dump exécuteur) + tests d'abonnement Cisco restent verts
(222/222).

## Suite

- Event Subscription : compléter PC Windows (`Get-WinEvent -Wait`, etc.).
- Real-Time Monitoring : capture live des handshakes TCP (rendre
  `PacketCaptureLog` observable), `ping`/`traceroute` progressifs, `watch`.
- Puis Background Commands.
