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

### PC Linux — `journalctl -f` / `journalctl --follow`

Catégorie « abonnement aux événements », côté hôte Linux. Même socle que `tail
-f` (job foreground streaming) : prompt verrouillé, flux ligne par ligne, arrêt
propre par Ctrl+C, isolation par session.

- **Anti-duplication** : le projet gérait déjà un `journalctl` complet
  (`LinuxLogManager.executeJournalctl` : parse `-n/-r/-q/-b/-o/-u/-p/_PID=/
  --output-fields=`, filtrage, formats `short`/`short-iso`/`json`/`cat`/
  `verbose`, en-tête `-- Logs begin at … --`). Réutilisé intégralement :
  - le parseur d'options est extrait en `parseJournalctlOptions` et partagé
    entre le dump snapshot (`executeJournalctl`) et le suivi (`-f`) — zéro
    logique d'arguments dupliquée. Le dump reste à comportement identique
    (`linux-journal` / `journalization-and-audit` verts).
  - le prédicat de filtrage par entrée est extrait en `matchesEntry` et partagé
    entre `filterEntries` (snapshot) et le fan-out live.
  - le formatage des lignes reste la fonction existante `formatEntry`.
- **Modèle** : `LinuxLogManager` devient émetteur. `addEntry` (point d'entrée
  unique de tout nouvel enregistrement journald — `logger`, `logAt`, projections
  de services) notifie désormais les abonnés actifs. `tryStartJournalctlFollow`
  retourne un descripteur `JournalFollowHandle` (`header`, `initial` = les 10
  dernières lignes filtrées ou `-n N`, `subscribe`). Les options terminantes
  (`--version`, `--disk-usage`, `--list-boots`, `--rotate`, `--flush`,
  `--vacuum-*`) et un journald arrêté ne suivent pas (retour `null` → dump).
- **Controller** : `LinuxCommandExecutor.tryStartJournalctlFollow` (même schéma
  que `startTailFollow`, via `simpleTokenize`), exposé par session avec
  `LinuxMachine.startJournalctlFollowInSession` (même `sessionSwap.withinSync`
  que `startTailFollowInSession` — l'abonnement vit sur le `LinuxLogManager`
  du device, indépendant des swaps d'exécuteur). `LinuxTerminalSession.
  tryStartJournalctlStream` intercepte `journalctl … -f` (hors version/usage),
  démarre un job foreground streaming : en-tête, tail initial, puis chaque
  nouvelle entrée au fil de l'eau ; Ctrl+C désabonne et libère le prompt.

Critères couverts : streaming temps réel ligne par ligne, prompt bloqué
(commande de monitoring), arrêt propre via Ctrl+C avec désabonnement effectif,
isolation des sessions (un follower par job), filtres réels (`-u` matché sur
unit/tag, `-p`, `_PID=`), impact sur l'état interne réel (les lignes viennent
des vraies entrées journald du device).

Validation : `linux-journalctl-follow-ui.test.ts` — 4/4 verts (header + stream
live d'une entrée `logger`, Ctrl+C qui détache l'abonnement, filtre `-u` qui
isole l'unité, `journalctl` sans `-f` inchangé). Régressions journal / syslog /
tail / ping : 143/143 verts.

## Suite

- Event Subscription : Firewall, Linux (conntrack `conntrack -E`).
- Real-Time Monitoring : Router (ping étendu / traceroute live).
- Background Commands : `show processes` / `ps`-style listing des jobs.
