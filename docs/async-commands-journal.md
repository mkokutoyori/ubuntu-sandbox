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

## Suite

- `mail`/`mailx` pour lire `/var/mail/<user>` (le `cat` marche déjà).
- Reprendre `ip monitor` (infrastructure d'événements `host.link.state-changed`
  / `host.address.changed` déjà posée).
