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

## Séparation Vue / Controller / Modèle (principe directeur)

Découpage explicite respecté par toutes les commandes async :

- **Modèle** (`src/network/…`) : exécution réelle et sources de données
  structurées. Ex. `EndHost.executePingStream` (vrai chemin ICMP : route + ARP +
  `sendPing`), `RouterDebugService` / `SwitchDebugService` (sources d'événements
  bus). Le modèle produit des objets (`PingResult`) / lignes de domaine, jamais
  de logique de terminal.
- **Présentation** (formatage, côté vue) : fonctions pures qui rendent les
  données en texte. Pour ping, ce sont les helpers **déjà existants**
  `formatPingHeader` / `formatPingReplyLine` / `formatPingStats`
  (`LinuxFormatHelpers.ts`), partagés entre le ping bloc historique et le ping
  streaming — zéro duplication. La vue React (`TerminalView`) rend les lignes et
  l'indicateur.
- **Controller** (`TerminalSession` + `TerminalAsyncRuntime`) : orchestre
  uniquement — parse l'entrée (via le parseur existant), lance le job, branche
  modèle → présentation → sink. Aucun formatage ni règle métier dans la session.

## Real-Time Monitoring — PC Linux : `ping` en streaming

- **Anti-duplication** : le projet gérait déjà un vrai `ping` complet
  (`linux/commands/net/Ping.ts` : parse `-c/-t/-s/-W/-i/-6`, `resolveHostname`,
  `pingSequence`, `formatPingOutput`). Réutilisé intégralement :
  - parseur extrait en `parsePingArgs` (Ping.ts) et partagé avec `runPing` ;
  - formatage extrait en `formatPingHeader/ReplyLine/Stats` (LinuxFormatHelpers)
    et partagé avec `renderPingBody` (le ping bloc reste byte-identique —
    `ping-through-switch` 20/20 verts) ;
  - résolution + exécution réutilisées via `LinuxMachine.pingStreamInSession`
    (résout l'hôte dans le modèle puis `executePingStream`).
- **Streaming** : `EndHost.executePingStream` réutilise `resolveRoute` /
  `resolveARP` / `sendPing` (mêmes primitives que `executePingSequence`) et émet
  chaque `PingResult` au fil de l'eau, avec espacement abortable et arrêt sur
  signal.
- **Controller** : `LinuxTerminalSession.tryStartPingStream` intercepte `ping`
  (hors pipes/redirections, IPv4), démarre un job foreground streaming : header,
  lignes progressives, prompt bloqué, Ctrl+C → `^C` + statistiques partielles.

Validation : `linux-ping-stream-ui.test.ts` — 3/3 (streaming progressif + prompt
verrouillé, interruption Ctrl+C avec résumé, vraie injoignabilité). Régressions
ping bloc / tail / debug / indicateur : 34/34.

## Sondage Playwright (probe UI réel) — manquements identifiés

Spec diagnostique `e2e/async-commands-probe.spec.ts` (pilote l'app réelle :
ping -t, reload in, debug ip ospf, debug spanning-tree, ping Linux).

Constats :

1. **BUG CRITIQUE (corrigé)** — `src/network/tcp/TcpStack.ts` importait
   `getDefaultScheduler` deux fois → `Identifier 'getDefaultScheduler' has
   already been declared` : le bundle navigateur plantait au chargement,
   `window.__networkStore` jamais exposé, **toute l'UI cassée**. Régression
   venue d'un merge récent (hors périmètre async). Corrigé. Build prod OK.
2. **Windows `ping -t`** — pas sur le pipeline async : sortie en bloc (pas de
   streaming progressif), prompt **non** verrouillé, et `-t` (continu) s'arrête
   tout seul après 10 paquets au lieu de tourner jusqu'à Ctrl+C. À brancher
   comme le ping Linux (job foreground streaming, continu, Ctrl+C + résumé).
3. **Cisco `reload in N`** — planifie un vrai reload mais via un `setTimeout`
   maison dans `CiscoShellBase` (async custom, exactement ce que le socle doit
   remplacer). Pas listé comme tâche background, pas d'indicateur, hors
   `TerminalAsyncRuntime`/`Scheduler`. Détail : message « 1 minutes ».
4. **OK** — `debug ip ospf` / `debug spanning-tree` : indicateur background
   « ● IOS debug output » présent, prompt libre, ack correct (lignes seulement
   sur événement réel).
5. **OK** — ping Linux : streaming + stats confirmés (le faux « grew=false » du
   probe est un artefact de timing : à -i 0.3s le ping finit avant le 1er
   snapshot ; couvert par le test unitaire).

## Corrections post-sondage + lab debug (vérifiés Playwright)

1. **Windows `ping -t` / `ping -n`** branché sur le pipeline (réutilise
   `WinPing` : `parseWinPingArgs` + `formatWinPingHeader/ReplyLine/Stats`
   extraits, `cmdPing` bloc recompose dessus). `WindowsPC.pingStreamInSession`
   (resolve + `executePingStream`). `WindowsTerminalSession` intercepte `ping`
   en mode cmd : job foreground streaming, `-t` continu jusqu'à Ctrl+C +
   statistiques. Vérifié unit + probe (`grewProgressively:true`, prompt
   verrouillé).
2. **`reload in`** routé via le `Scheduler` partagé (fin du `setTimeout` maison
   + hack `unref`), grammaire « 1 minute » / « N minutes ». Reste une action
   device-globale (le scheduler partagé, pas un job per-session, car un reload
   survit à la fermeture du terminal).
3. **BUG MAJEUR corrigé — le debug ne streamait pas du tout dans l'app réelle.**
   Le service de debug ne s'abonnait au bus que dans `setEventBus`, jamais
   appelé par le store : les équipements utilisent `getDefaultEventBus()`
   (singleton) via `Equipment.getBus()`, où les agents (STP/OSPF) publient,
   mais le service écoutait dans le vide. Correctif : `getDebugService()`
   s'abonne désormais à `this.getBus()` (et re-bind sur changement de bus via
   `DebugBroadcast.beginAttach`). Les tests unitaires passaient car ils
   câblaient le bus à la main — d'où l'importance du sondage Playwright.

## Lab de vérification debug (`e2e/debug-lab.spec.ts`)

- **STP** : 2 switches Cisco câblés → `debug spanning-tree` → lignes live
  `STP: Tx BPDU on FastEthernet0/0 ...` dans le terminal. ✅
- **OSPF** : 2 routeurs (hello-interval 1) câblés → `debug ip ospf adj/packet`
  → lignes live `OSPF: snd/rcv packet ...`. ✅
- Indicateur background présent, prompt libre, isolation par `deviceId`.

## Real-Time Monitoring — PC Linux : `watch`

- Exploration d'abord : `cron` est **déjà** fonctionnel (`LinuxMachine.startCronTicker`
  → `tickCron` toutes les 60 s exécute les jobs dus) → pas touché. `watch` en
  revanche était un **one-shot** (`handleWatch` rendait une seule frame) alors
  que le cahier des charges le liste comme moniteur temps réel.
- Correctif : `watch` branché sur le pipeline (job foreground streaming).
  Réutilisation totale de l'existant — `parseWatchArgs` (intervalle) +
  `runWatch`/`handleWatch` via `executor.executeInSession` (une frame par tick,
  tokenisation et exécution du shell réutilisées, zéro re-parsing). Le controller
  (`LinuxTerminalSession.tryStartWatchStream`) ne fait qu'orchestrer : repeint la
  frame **en place** (troncature à `baseLen` + ré-affichage) toutes les N s,
  prompt verrouillé, Ctrl+C arrête.
- `LinuxMachine.runWatchFrameInSession` produit une frame dans le contexte de la
  session (cwd/env du terminal).

Validation : `linux-watch-stream-ui.test.ts` (2/2) + probe Playwright
(`hasHeader`, `promptLockedWhileRunning`, `refreshedInPlace`).

## PC Linux : `top` (monitoring) et `journalctl -f` (event subscription)

- **Mutualisation** : extraction d'un `startRepaintingMonitor(commandLine,
  intervalMs)` dans `LinuxTerminalSession` (repeint une frame en place chaque
  intervalle, prompt verrouillé, Ctrl+C). `watch` et `top` l'utilisent tous les
  deux. `LinuxMachine.runWatchFrameInSession` renommé `runCommandFrameInSession`
  (générique : exécute n'importe quelle commande dans la session et renvoie sa
  sortie via `executor.executeInSession`).
- **`top`** : `tryStartTopStream` parse `-d` pour l'intervalle (3 s défaut),
  réutilise `cmdTop` via le moniteur générique. `-n`/`-b` (batch) → laissé au
  one-shot.
- **`journalctl -f`** : event subscription. `LinuxLogManager.followJournal(opts,
  listener)` — abonnés filtrés (unit/priority/pid) notifiés depuis `addEntry`
  (point unique déjà existant), formatés via `formatEntry('short')` réutilisé ;
  `filterEntries` refactoré sur le même `entryMatches`. La session affiche
  d'abord la queue (`journalctl -n 10` réutilisé) puis stream les nouvelles
  lignes en direct (filtre `-u` live), Ctrl+C se désabonne.

Validation : `linux-top-journalctl-stream-ui.test.ts` (2/2) + probes Playwright
(`top` : header/%Cpu, prompt verrouillé, repaint ; `journalctl -f` : entrée
`logger` streamée en direct, prompt verrouillé). Régressions journal/logging :
121/121.

## Fix — `reload in` ne rebootait jamais

Bug réel (antérieur, le `setTimeout` maison l'avait aussi) : le callback du timer
de reload appelait `this.d()` (la référence device n'est valide que *pendant*
`execute()`). Quand le timer se déclenche plus tard, `d()` lève « Device
reference not set » → l'exception est avalée (RealTimeScheduler la log) et
l'équipement ne reboote pas. Correctif : on **capture le device à l'armement**
(pendant execute) et le callback / `performScheduledReload(device)` l'utilisent.
`reload cancel` annule sur le même scheduler.

Validation : `cisco-reload-in-scheduler.test.ts` — le reboot (powerOff+powerOn)
se déclenche après l'écoulement (scheduler virtuel), `reload cancel` l'empêche ;
11/11 tests reload verts.

## Cron Linux — implémentation réaliste, exhaustive (TDD)

Exploration d'abord (sous-agent) : l'existant n'était qu'une table unique
in-memory + un ticker 60 s sans capture de sortie, sans per-user réel, sans env,
sans `-u/-e/-i`, sans `/etc/crontab`/`cron.d`/run-parts, sans permissions, sans
mail. Reconstruction cohérente avec VFS / process / services / bash / logs /
mail, sans stub.

Modèle (`src/network/devices/linux/cron/`) :
- `CronSchedule` enrichi : noms (jan-dec, sun-sat), `@reboot`, 0/7=dimanche,
  ranges/steps/lists/macros. Réexporté depuis `LinuxCronManager` (compat tests).
- `CrontabParser` : commentaires, lignes vides, assignations d'env (quotes,
  MAILTO), jobs (mode user et mode système avec champ user), snapshot d'env
  par job, erreurs de ligne.
- `LinuxCronManager` : tables per-user (compat legacy single-arg), `dueJobs`
  agrégé, `rebootJobs`, `getEnv`.
- `CronPermissions` : `cron.allow` / `cron.deny` (allow prioritaire, root
  toujours autorisé).
- `SystemCron` : `/etc/crontab` + `/etc/cron.d/*` (champ user).
- `CronEngine` : daemon injecté (dedup minute, `@reboot` au start, env
  SHELL/PATH/HOME/LOGNAME/USER + env crontab, log syslog `CRON[pid]: (user) CMD`,
  livraison du stdout en mail mbox vers MAILTO ou propriétaire, `MAILTO=""`
  supprime le mail).

Intégration :
- `crontab` réécrit : `-l/-r/-i`, `-u user` (privilège + user inconnu),
  install fichier/stdin, permissions, fichiers spool `/var/spool/cron/crontabs/<user>`,
  log RELOAD/DELETE.
- `run-parts [--test]` (exécute les scripts d'un répertoire) → `cron.daily/...`
  via le `/etc/crontab` standard seedé.
- `LinuxMachine` : `tickCron` remplacé par `CronEngine` (runner = contexte user
  + env + capture via `executeWithEnv`, mail mbox `/var/mail/<user>`), gating
  service cron, `@reboot` au (re)start.
- VFS seedé : `/etc/crontab` Debian standard, `/etc/cron.d`,
  `/var/spool/cron/crontabs`.
- UI : `crontab -e` ouvre l'éditeur (nano) sur un buffer temp pré-rempli ;
  à la sauvegarde → installation, à l'abandon → « no changes made to crontab ».

Tests (TDD, 76 scénarios) : `cron-model` (27), `cron-engine` (12),
`cron-firewall` (11, CF-03 rendu réaliste : RELOAD à l'install, CMD au tick),
`cron-integration` (18, full-stack via LinuxPC : permissions, mail, env,
run-parts, cron.daily, cron.d, @reboot, service stoppé), `cron-editor-ui` (5),
e2e `cron.spec.ts` (3 : install/list, -r, -e ouvre nano). Aucune régression
(386 tests linux fs/ssh/journal verts).

## tcpdump (capture live) + show processes

- **tcpdump** était un dump statique (`cmdTcpdump` rend le `PacketCaptureLog`).
  Ajout du suivi live : `PacketCaptureLog.subscribe(listener)` émis sur
  `capture()` ; parseur/formateur extraits et réutilisés
  (`parseTcpdumpArgs`/`tcpdumpHeader`/`tcpdumpFooter`/`formatTcpdumpPacket`/
  `packetMatchesPort`) ; `LinuxMachine.subscribeCapture`. Le controller
  `LinuxTerminalSession.tryStartTcpdump` lance un job foreground streaming :
  header, paquets en direct, filtre `port`, `-c N` s'arrête + résumé,
  Ctrl+C → « N packets captured … ». Le `tcpdump` device-level (non interactif)
  reste le dump bloc (suite SSH inchangée).
- **show processes** : ajout de la commande nue `show processes` (IOS) qui
  réutilise `showProcessesCpu()` ; `show processes cpu`/`memory` inchangés.

Validation : `linux-tcpdump-stream-ui.test.ts` (4), `cisco-show-processes.test.ts`
(3), e2e `tcpdump.spec.ts` (1 : capture live + résumé). Régressions tcpdump/SSH
verts (223).

## tcpdump bloc (batterie GitHub 1-150)

Les 150 tests ajoutés sur GitHub exercent le chemin bloc (`executeCommand`)
et non plus le streaming : `tcpdump` doit capturer du vrai trafic ICMP/ARP/IP
pendant une fenêtre, valider toute la CLI et les filtres BPF, puis rendre le
résumé.

- Nouveau module `network/tcpdump/` : `CaptureFrame` (modèle riche L2/L3/L4 +
  décodeur `EthernetFrame` et synthèse octets pour le hexdump), `TcpdumpCli`
  (parseur d'options/validation : `-i/-c/-s/-y/-w/-r/-C`, `-n/-nn`,
  `-t/-tt/-ttt/-tttt`, `-e/-v/-vv/-vvv/-q`, `-x/-xx/-X/-XX/-A`, `-D`,
  `--help/--version/--list-interfaces/--list-link-types`), `TcpdumpFilter`
  (compilateur d'expression BPF : `ip/ip6/arp/tcp/udp/icmp/icmp6`,
  `host/src/dst`, `net … /cidr` & `mask`, `port/portrange/range`, `proto`,
  `ether`, `vlan`, `less/greater`, parenthèses, `and/or/not`, slices
  `ip[..]`/`tcp[tcpflags]`), `TcpdumpFormat` (bannière, footer, lignes
  ICMP/ARP/TCP/UDP + horodatages + hexdump), `TcpdumpRunner` (driver async
  piloté par un `TcpdumpDeps`).
- `LinuxMachine.executeCommand` intercepte `tcpdump` et le route vers le runner
  async ; `openTcpdumpCapture` branche la capture promiscuous sur le bus
  (`port.frame.received`/`port.frame.tx-requested` filtrés par device+iface) et,
  pour `lo`/`any`, sur `host.icmp.echo-sent`/`echo-reply`. `-w` sérialise dans le
  VFS, `-r` relit (magic `TCPDUMPSIM1`, erreurs « No such file »/« bad dump file »).
- `EndHost.localEchoResults` émet désormais `host.icmp.echo-sent/reply` (le ping
  loopback est du vrai trafic ICMP, visible par `tcpdump -i lo`).
- `EndHost.handleARP` : alignement Linux `arp_accept=0` — une interface déjà
  configurée n'apprend plus un voisin *nouveau* depuis un ARP gratuit (seules
  les entrées existantes sont rafraîchies). Le cache reste froid pour une cible
  jamais résolue, donc un ping déclenche un vrai « who-has » que tcpdump capture.

Validation : `tcpdump.test.ts` (100) + `tcpdump2.test.ts` (50) verts ; suite
`network-v2` sans régression (seul `other-commands.test.ts` #163, pré-existant
et sans rapport, échoue). Le chemin streaming (`tryStartTcpdump`) inchangé.

## Real-Time Monitoring — PC Linux : `traceroute` en streaming

- **Constat** : `ping`, `tail -f`, `watch`, `top`, `journalctl -f`, `tcpdump`
  passaient déjà par le pipeline, mais `traceroute` restait sur le chemin
  synchrone (`tracerouteCommand.run` → un seul bloc rendu en fin d'exécution),
  alors que le vrai traceroute imprime chaque saut au fil de sa résolution.
- **Anti-duplication** : parseur d'arguments extrait en `parseTracerouteArgs`
  (`linux/commands/net/Traceroute.ts`) et partagé entre la commande bloc et le
  streaming (le bloc historique reste byte-identique). Formatage extrait en
  `formatTracerouteHeader` / `formatTracerouteHopLine` (`LinuxFormatHelpers.ts`),
  réutilisés par `formatTracerouteOutput` (bloc) et par le streaming — zéro
  duplication de rendu.
- **Modèle** : `EndHost.executeTraceroute` accepte un couple de hooks
  (`onHop` appelé dès qu'un saut se stabilise, `shouldStop` sondé entre les
  sauts pour un Ctrl+C prompt). Aucune logique de terminal dans le modèle ;
  types de domaine exportés (`TracerouteHopResult` / `TracerouteProbeResult`).
- **Controller** : `LinuxMachine.tracerouteStreamInSession` (résolution d'hôte
  sur le fil puis `executeTraceroute` câblé aux hooks), et
  `LinuxTerminalSession.tryStartTracerouteStream` intercepte `traceroute` (hors
  pipes/redirections) en job foreground streaming : header puis une ligne par
  saut au fil de l'eau, prompt verrouillé, Ctrl+C → `^C` + arrêt de la boucle de
  sondes. Hôte inconnu → `traceroute: unknown host …` ; aucune route → ` * * *
  Network is unreachable`, comme le bloc.

Validation : `traceroute-stream-ui.test.ts` (2/2 : job streaming engagé dès
l'Enter avec header rendu de façon asynchrone et tous les sauts, puis
déverrouillage ; interruption Ctrl+C). Régressions traceroute bloc / conformance
/ icmp / ipv4 / ping / aide / complétion + autres UI streaming : 145/145. Aucune
nouvelle erreur de lint.

## Event Subscription — PC Linux : `ip monitor`

Commande d'abonnement netlink (`ip monitor [all|link|address|route|neigh]`)
branchée sur le socle, en réutilisant l'infrastructure d'événements du bus
hôte plutôt qu'une mécanique parallèle.

- **Modèle** : `EndHost.addStaticRoute` / `addDeviceRoute` / `removeRoute`
  émettent désormais `host.routing.route-added` / `host.routing.route-removed`
  via les helpers `emitRouteAdded` / `emitRouteRemoved` **déjà présents mais
  jamais appelés** — un manque latent : ces topics étaient écoutés par
  `HostSignalRefreshActor` (rafraîchissement du signal de routes) sans jamais
  être publiés. Les publier complète le comportement attendu **et** alimente
  `ip monitor route` en vrais évènements. `host.link.state-changed`,
  `host.address.changed`, `host.arp.entry-learned/expired` étaient déjà émis.
- **Présentation** (fonctions pures, `LinuxIpCommand.ts`, à côté des formateurs
  `ip` existants) : `formatIpMonitorLink` réutilise `formatLinkInterface` (même
  bloc que `ip link show`), `formatIpMonitorAddr/Route/Neigh` rendent une ligne
  netlink réaliste depuis le payload de l'évènement (le `[ADDR]Deleted …` montre
  l'adresse retirée, que `formatAddrInterface` ne pourrait plus afficher après
  purge). `parseIpMonitorSpec` (alias `address|addr|a`, `route|r`, `neigh|n`,
  `all`) résout l'ensemble d'objets et le préfixe `[LINK]/[ADDR]/[ROUTE]/[NEIGH]`
  (affiché seulement en multi-objets, comme iproute2).
- **Modèle/abonnement** : `LinuxMachine.monitorNetlink(opts, listener)` —
  même schéma que `followJournal` — s'abonne aux topics du bus du device
  (`this.getBus()`), filtre par `deviceId`, formate et pousse chaque bloc.
  Retourne un désabonnement propre.
- **Controller** : `LinuxTerminalSession.tryStartIpMonitor` intercepte
  `ip [opts] monitor …` (hors pipes/redirections), démarre un job
  `mode: foreground`, `kind: subscription` : prompt verrouillé, lignes en
  direct, Ctrl+C se désabonne et libère le prompt. `executeIpCommand` rend `''`
  pour `monitor` en non-interactif (script/SSH) — pas de faux « unknown ».

Critères couverts : abonnement temps réel ligne par ligne, prompt bloquant
(foreground) avec interruption Ctrl+C propre, isolation des sessions (chaque
terminal a son propre runtime/abonnement), impact réel sur l'état (les lignes
proviennent des vrais évènements de mutation d'interface/route/voisin).

Validation : `linux-ip-monitor-stream-ui.test.ts` — 3/3 (stream LINK/ADDR/ROUTE
labellisé + prompt verrouillé + arrêt Ctrl+C ; filtre mono-objet non labellisé ;
isolation de deux sessions concurrentes). Régressions : streaming UI 34/34,
tests `route` 527/527, ARP/host 34/34. Aucune nouvelle erreur de type ni de lint
(le seul échec `network-v2`, `other-commands.test.ts` #163, est pré-existant et
sans rapport). 

## Event Subscription — Router (Cisco IOS) : `terminal monitor`

Commande d'abonnement aux événements de journalisation (syslog) du device,
branchée sur le socle, en réutilisant l'infrastructure de logging existante
plutôt qu'une mécanique parallèle. Avant : `terminal monitor` posait un flag
mort (`terminalMonitor`) jamais câblé — accepté silencieusement, sans effet.

- **Comportement réel (IOS)** : par défaut une ligne vty (telnet/SSH) ne reçoit
  pas la sortie syslog/debug ; `terminal monitor` l'abonne au flux de logs du
  device, `terminal no monitor` la désabonne. Réglage **par ligne**, pas global.
- **Modèle** (`LoggingConfig`, source unique des logs IOS, déjà projetée par
  `show logging`) : ajout d'un flux d'abonnement monitor. `append` (point
  d'émission unique alimenté par tous les vrais évènements bus — OSPF, link,
  interface, AAA, STP, NAT, crypto, …) diffuse désormais chaque entrée aux
  abonnés monitor, **filtrée par `monitorSeverity`** (le `logging monitor
  <level>` IOS). Extraction d'un formateur pur `formatEntry` réutilisé par le
  flux monitor **et** par le buffer de `show logging` (zéro duplication de
  rendu : `%TAG-SEV-MNEMONIC`). `attachToBus` rendu **idempotent** (garde
  bus+device) pour l'attache paresseuse.
- **Bug latent corrigé (même classe que le bug debug #3)** : `LoggingConfig`
  n'était attaché au bus que via `setEventBus`, jamais appelé par le store dans
  l'app réelle (`busOverride` reste nul, les agents publient sur
  `getDefaultEventBus()`). Nouveau `Router.getLoggingConfig()` attache
  paresseusement la config sur `this.getBus()` (exactement comme
  `getDebugService()`), donc le flux monitor capte les vrais évènements en
  conditions réelles, pas seulement dans les tests qui câblent le bus à la main.
- **Per-vty** : `terminalMonitor` ajouté à `VtySnapshot` + snapshot/apply
  (Cisco IOS et Huawei) ; il rotère désormais par ligne via le swap-and-restore
  de `executeCommandInVty` (corrige aussi un trou d'isolation : le flag vivait
  sur le shell partagé). Suppression du bloc `terminal monitor` dupliqué mort
  dans `handleTerminalCommand`.
- **Controller** (`CiscoTerminalSession`) : `afterCommandExecuted` factorisé en
  `reconcileDebugSubscription` + `reconcileTerminalMonitor`. Dès que la ligne a
  `terminalMonitor` armé, un job `mode: background`, `kind: subscription`
  (`command: 'terminal monitor'`, `label: 'syslog monitor'`) s'abonne à
  `subscribeMonitor` et déverse chaque ligne dans le terminal (prompt libre,
  non bloquant, intercalé sans casser la saisie). `terminal no monitor` annule
  le job ; la fermeture de session l'annule via `cancelAll`. L'indicateur
  background UI le signale automatiquement (même socle que debug).

Critères couverts : abonnement temps réel ligne par ligne, prompt non bloqué
(arrière-plan), arrêt propre via `no monitor` / fermeture de session, isolation
des sessions (chaque vty a son propre flag et son propre abonnement), impact réel
sur l'état (lignes issues des vrais évènements du device), gating de privilège
par sévérité (`logging monitor`), commande exec IOS.

Validation : `cisco-terminal-monitor.test.ts` — 6/6 (stream `%OSPF-5` live +
job background + flag per-vty ; prompt libre ; session non monitorée muette ;
`no monitor` coupe ; isolation deux sessions ; filtrage par `monitorSeverity`).
Régressions : `cisco-debug-subscription`, `cisco-switch-debug-subscription`,
`cli-terminal-length`, `logging-enhancements` — verts.

## Event Subscription — PC Linux : `ip monitor route` couvre la route par défaut

Complément à `ip monitor` : la route par défaut était le seul changement de
table de routage muet (`setDefaultGateway` / `clearDefaultGateway` mutaient la
table sans publier d'évènement, contrairement à `addStaticRoute` /
`addDeviceRoute` / `removeRoute` déjà câblés). `ip monitor route` ratait donc
l'ajout/suppression de la default — alors que c'est le changement de routage le
plus fréquent (DHCP, `ip route add default`, `route add default gw`).

- **Modèle** (`EndHost`) : `setDefaultGateway` capture l'ancienne default avant
  de la remplacer, puis émet `host.routing.route-removed` (ancienne) +
  `host.routing.route-added` (nouvelle, `type: 'default'`, destination
  `0.0.0.0/0`) via les helpers `emitRouteRemoved` / `emitRouteAdded` existants.
  `clearDefaultGateway` émet `host.routing.route-removed`. Aucune mécanique
  parallèle : réutilise les mêmes points d'émission que les routes statiques.
- **Idempotence** : `setDefaultGateway` est appelé à chaque renouvellement de
  bail DHCP avec la même passerelle ; un garde (même next-hop + même interface)
  supprime la double émission removed/added quand rien ne change — pas de churn
  netlink fantôme dans `ip monitor`.
- **Présentation** : aucune ligne nouvelle — `formatIpMonitorRoute` rend déjà
  `cidr === 0` → `default via <gw> dev <iface>` / `Deleted default dev <iface>`.

Validation : `linux-ip-monitor-stream-ui.test.ts` — 5/5 (2 nouveaux : default
ajoutée puis supprimée streamée live ; passerelle inchangée non ré-annoncée).
Régressions : `routing-table`, `hosts`, `linux-gateway-forwarding` (56),
DHCP (`dhcp_complete`, `dhcp_fixes`, `dhcp-resolv-conf`, 63) verts. Aucune
nouvelle erreur de lint (les 3 `any` d'`EndHost` sont pré-existants).

## Real-Time Monitoring — PC Linux : `netstat -c`

- **Constat** : `netstat` rendait un bloc unique et rendait la main, même avec
  `-c`/`--continuous` — le flag `c` était silencieusement avalé par `cmdNetstat`
  (aucune branche `hasFlag('c')`). Or `netstat -c` (net-tools) réimprime la
  table sélectionnée toutes les secondes en continu, jusqu'à Ctrl+C.
- **Anti-duplication** : aucune nouvelle logique de rendu. Le controller
  réutilise intégralement le renderer netstat existant
  (`runCommandFrameInSession`, qui rejoue la ligne de commande via
  `executor.executeInSession` dans le contexte cwd/env de la session). `-c`
  reste ignoré par `cmdNetstat`, donc chaque frame est la sortie netstat
  normale (`-t`/`-u`/`-l`/`-a`/`-n`/`-p` honorés comme en bloc).
- **Controller** : `LinuxTerminalSession.tryStartNetstatStream` intercepte
  `netstat` avec `-c` (court combiné, ex. `-tc`) ou `--continuous` (hors
  pipes/redirections), démarre un job `mode: foreground`, `kind: streaming` :
  réimpression du bloc complet (bannière + en-tête + lignes) toutes les secondes
  en mode défilement (append, pas de repaint en place — fidèle à net-tools qui
  ne nettoie pas l'écran), prompt verrouillé, Ctrl+C → `^C` et libération. Le
  `netstat` sans `-c` retombe sur le one-shot existant.

Critères couverts : affichage progressif (table réémise au fil de l'eau, pas un
dump unique), prompt bloquant (foreground) avec interruption Ctrl+C propre,
isolation des sessions (chaque terminal a son propre runtime/job), données
reflétant l'état interne réel (socket table du device via le renderer existant).

Validation : `linux-netstat-stream-ui.test.ts` — 3/3 (réimpression récurrente de
l'en-tête + prompt verrouillé + arrêt Ctrl+C ; `netstat -t` sans `-c` reste
one-shot ; isolation de deux sessions concurrentes). Régressions : `ss-netstat`,
streaming UI (`watch`, `top`/`journalctl`, `tcpdump`, `ping`, `ip monitor`,
`traceroute`, `tail`) — 55/55 verts. Typecheck `tsc --noEmit` : 0 erreur.

## Real-Time Monitoring — PC Linux : `dmesg -w`

- **Constat** : `dmesg` rendait un dump unique du ring buffer ; le flag `-w`/
  `--follow` était silencieusement avalé par `executeDmesg`. Or `dmesg -w`
  (util-linux 2.37) imprime le buffer existant puis reste attaché au flux noyau
  jusqu'à Ctrl+C.
- **Modèle** : extraction d'un `formatDmesgEntry(entry, opts)` privé partagé
  entre le dump bloc et le flux suiveur (zéro duplication de rendu — `-r` raw,
  `-T` humanTime, `-l` level filter honorés à l'identique). Nouveau `Set` de
  souscripteurs `dmesgFollowSubs` dans `LinuxLogManager` ; `addEntry` fan-out
  à chaque message kern poussé dans le ring buffer (point d'émission unique
  déjà existant). API publique `followDmesg(opts, listener)` symétrique de
  `followJournal`.
- **Controller** : `LinuxTerminalSession.tryStartDmesgFollow` détecte
  `dmesg -w`/`--follow` (hors pipes/redirections), foreground streaming job.
  `prepare` imprime d'abord la queue via `runCommandFrameInSession(dmesg <args
  sans -w>)` puis souscrit. Erreur de niveau invalide (`dmesg -w -l bogus`) →
  message d'erreur + prompt libéré (pas de verrouillage sur entrée mal formée).

Validation : `linux-dmesg-stream-ui.test.ts` — 5/5 (dump initial + entrée live +
Ctrl+C ; fallback one-shot ; filtre `--level=err` (warning droppé, err passé) ;
level inconnu n'engage pas le job ; isolation deux sessions). Régressions :
streaming UI (`netstat`, `top`/`journalctl`, `journal`, `logging`) 282/282.

## Helpers de session — `startScrollingMonitor` et `startFollowStream`

Avant de pouvoir documenter proprement les commandes Windows et Linux
suivantes, factorisation transverse pour ne pas dupliquer la boucle de
streaming à chaque nouvelle commande :

- **`TerminalSession.startScrollingMonitor({ commandLine, intervalMs,
  frame })`** — boucle `while (!ctx.cancelled()) { sink(frame()); delay() }`
  partagée. Consommée par Linux `netstat -c` (`runCommandFrameInSession`) et
  Windows `netstat <interval>` (`executeCommandInSession`) — un seul squelette
  vendor-agnostique.
- **`TerminalSession.startFollowStream({ commandLine, prepare, subscribe })`** —
  pattern « historique + souscription » partagé. Consommé par `journalctl -f`,
  `dmesg -w`, `ip monitor` — la mécanique `let unsubscribe; onCancel; resolve`
  vit en un seul endroit.

Les call sites des trois follow handlers et des deux scrolling handlers
collapsent de ~12 lignes chacun à ~5. Aucune nouvelle mécanique async.

## Real-Time Monitoring — Windows : `netstat <interval>`

- **Constat** : Windows `netstat -an 5` réimprime la table toutes les 5
  secondes ; la grammaire « entier positif final = intervalle en secondes » est
  spécifique à la version Windows de netstat. Notre handler ignorait l'entier.
- **Controller** : `WindowsTerminalSession.tryStartWinNetstatStream` détecte un
  entier positif final hors flag, strip-le pour reconstruire la commande sans
  l'intervalle, route via `startScrollingMonitor` qui réémet la table tous les
  N secondes via `executeCommandInSession`. Réutilise intégralement le renderer
  one-shot existant (`cmdNetstat`) — zéro nouvelle logique de format.

Validation : `windows-netstat-stream-ui.test.ts` — 4/4 (réimpression + Ctrl+C ;
fallback one-shot sans intervalle ; forme bare `netstat 1` ; isolation deux
sessions). Régressions : streaming UI 41/41 sur 12 fichiers (Linux + Windows).

## Real-Time Monitoring — Windows : `pathping`

- **Constat** : `pathping` n'était pas implémenté ; la commande sortait
  silencieusement. Real Windows pathping fait deux phases : discovery
  (traceroute simplifié, 1 probe par hop), puis statistics (N pings vers
  chaque hop, agrégation lost/sent + RTT moyen + perte par lien).
- **Modèle** : nouveau module `WinPathping.ts` — `parseWinPathpingArgs` (-h
  max-hops, -q queries, -p period, -w timeout, -n no-resolve, mapping
  -CommonTCPPort), formatters purs `formatPathpingHeader / DiscoveryHop /
  Computing / TableHeader / Table / Trailer / DurationSeconds`. Aucune logique
  réseau dans le format.
- **Controller** : `WindowsTerminalSession.tryStartWinPathpingStream` foreground
  streaming. Phase discovery : `tracerouteStreamInSession` (probesPerHop=1) →
  émet la liste des hops au fil de la résolution. Phase statistics : pour
  chaque hop, `pingStreamInSession` avec `count=queriesPerHop`, agrège
  lost/sent et RTT moyen ; loss de lien = différence de loss cumulative
  entre hops. Source row (hop 0) via nouveau `EndHost.getEgressIPFor()` ; le
  helper `getEgressFor()` ajouté ensuite retourne `{sourceIp, interfaceName,
  nextHopIP}` partagé.

Validation : `windows-pathping-stream-ui.test.ts` — 10/10 (UI bout en bout +
parser/formatters purs). Aucune mécanique ICMP / résolveur nouvelle.

## Real-Time Monitoring — PowerShell : `Test-NetConnection` réel dans le runtime

Itération avec un objectif explicite : remplacer le stub du cmdlet, **sans**
choisir la voie de la facilité (interception au prompt qui ne couvre pas les
scripts ; ou async-cascade dans tout `PSRuntime`).

- **Constat** : `TestNetConnectionCmdlet.execute` retournait des champs
  hardcodés (PingSucceeded toujours True, SourceAddress = gateway,
  TcpTestSucceeded = !!port, RemoteAddress = la chaîne brute du user). Le
  fallback `PowerShellExecutor.handleTestNetConnection` avait son propre stub
  avec un set de ports listening codé en dur `{80, 135, 443, 445, 5985,
  49152}`. Et une interception parallèle dans `WindowsTerminalSession` (mode
  PS) faisait du vrai ping/TCP mais seulement quand l'utilisateur tapait au
  prompt — `$r = Test-NetConnection ...`, `if ((Test-NetConnection ...).
  PingSucceeded)` et toute utilisation dans un script restaient au stub.
- **Primitives sync sur EndHost** : `sendPingProbeSync(target)` — souscrit
  sync à `host.icmp.echo-reply/echo-failed`, ARP sync via le bus (`publish`
  est *synchrone* — handlers fire inline, dispatch en ordre de souscription
  cf. `EventBus.ts`), transmet l'ICMP echo, observe la réponse dans le même
  tick JS. `tcpProbeSync(target, port)` — drive `tcpv2.connect` ; le SYN/
  SYN-ACK/ACK passe par le bus sync donc `socket.state === 'established'`
  est vrai à la sortie de `connect()`.
- **Provider** : trois nouvelles méthodes sur `INetworkProvider` —
  `testPingProbe`, `testTcpProbe`, `egressInfoFor`. Implémentées dans
  `WindowsNetworkAdapter` via `resolveHostnameSync` (literal IP / hosts file /
  localhost / hostname) + les deux probes. Le stub `testConnection()` du
  provider devient une simple façade qui appelle `testPingProbe?.success`.
- **Cmdlet** : `TestNetConnectionCmdlet` réécrit. Mapping `-CommonTCPPort`
  HTTP/SMB/RDP/WINRM, `-InformationLevel` Quiet/Detailed. Retourne un
  PSObject **plat** (tous scalaires) pour que `formatDefault` rende en
  Format-List comme le vrai Test-NetConnection. Le fallback
  `PowerShellExecutor.handleTestNetConnection` utilise les mêmes primitives,
  donc cmdlet et fallback sont cohérents (plus de divergence).
- **Suppression de l'interception** : `WindowsTerminalSession.
  tryStartWinTestNetConnection` et le module `WinTestNetConnection.ts`
  supprimés — c'était la voie facile. Le vrai cmdlet remplace tout.
- **Choix d'architecture documenté** : sync probe vs async cascade. Le
  runtime PS est ~3000 lignes synchrones, ~120 méthodes, ~500 call sites
  internes. Convertir en async pour un seul cmdlet aurait gutté la
  surface de test PowerShell. La propriété rare du simulateur — topologie
  visible inline + EventBus synchrone — rend la voie sync **fidèle** : on
  exchange les *mêmes paquets* via le *même bus* qu'un appel async ferait.
  La fidélité vient des paquets réels, pas du `await`.

Validation : `windows-test-netconnection-stream-ui.test.ts` — 7/7 (reachable
host avec vraies adresses source/interface ; unreachable ; -Port closed ;
Quiet ; Detailed avec NameResolutionResults + NetRouteNextHop ; usage
script `$r.PingSucceeded` ; chaîne `(...).TcpTestSucceeded`). Régressions :
streaming UI + PS network 67/67 sur 10 fichiers, y compris les anciens
tests `phase3-final-batches-migrated` et `ps-network-command` qui
exerçaient déjà l'ancien stub via `ps.execute` directement.

## Suite

- Linux : `vmstat <interval>` / `iostat <interval>` / `mpstat <interval>`
  (sysstat) — moniteurs périodiques de métriques système, candidats directs
  pour `startScrollingMonitor`.
- Cisco / Huawei : `monitor session` (SPAN) — capture live de trames sur un
  port miroir, similaire à `tcpdump` côté hôte.
- Huawei : `terminal debugging` (analog de Cisco `terminal monitor` +
  `debug ip`), si les sources d'évènements bus existent côté `HuaweiRouter`.
