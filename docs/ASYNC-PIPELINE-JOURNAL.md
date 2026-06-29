# Journal de bord — Émulation des commandes asynchrones (branche `mandeng`)

## Itération 0 — Audit de l'existant (préalable obligatoire)

### Constat principal

Le socle « moteur d'exécution asynchrone unifié » demandé existe **déjà** sur `mandeng`.
La tâche est donc une **mise en service / enhancement**, pas une création.

### Ce qui est déjà en place (unifié)

| Brique | Fichier | État |
|---|---|---|
| Moteur d'exécution async | `src/terminal/async/TerminalAsyncRuntime.ts` | Opérationnel (cycle prepare→run→complete/cancel, jobs foreground + background) |
| Contrats async | `src/terminal/async/types.ts` | `AsyncJobSpec`, `AsyncJobContext`, `AsyncJobSink`, `StreamingOutput`, `BackgroundProcess`, `EventSubscription` |
| Découpage de lignes | `src/terminal/async/LineAssembler.ts` | Buffer de lignes partielles |
| Intégration session | `src/terminal/sessions/TerminalSession.ts` | `startAsyncCommand()`, `startScrollingMonitor()`, `startFollowStream()`, `interruptForeground()` |
| Streaming Linux | `src/terminal/sessions/LinuxTerminalSession.ts` | ping, traceroute, tail -f, watch, vmstat, journalctl -f, dmesg -w, netstat -c… |
| Bus d'événements | `src/events/EventBus.ts`, `src/events/Signal.ts` | Pub/sub synchrone, topics typés |
| Pont debug routeur | `src/network/devices/router/diag/RouterDebugService.ts`, `DebugBroadcast.ts` | Registre de flags + bridge events→lignes debug |
| Ctrl+C unifié | `TerminalAsyncRuntime.interruptForeground()` + `AbortController` | Fonctionne sur tous les types de job |

### Vrais manques (les livrables réels de l'itération)

1. **Event Subscription non câblé côté terminal** — `RouterDebugService` émet déjà les lignes
   debug, mais aucune commande CLI (`debug ip ospf`, `terminal monitor`) ne s'y abonne pour
   les streamer dans la session. Contrat `EventSubscription` présent mais inutilisé.
2. **Background processes non exploités** — `BackgroundProcess` (mode='background') existe mais
   n'est utilisé ni pour `tcpdump -w`, ni pour `ping -t`, ni pour les daemons. `LinuxJobTable`
   gère `&` du bash mais ne stream pas la sortie.
3. **UI** — pas d'indicateur visuel « N commandes background actives », pas de panneau de jobs.
4. **Couverture hétérogène** — Cisco/Huawei/Windows ont des wrappers de streaming séparés
   (à confirmer) qui devraient passer par le même `AsyncJobSpec`.

### Top fichiers à connaître
`TerminalAsyncRuntime.ts`, `async/types.ts`, `TerminalSession.ts`, `LinuxTerminalSession.ts`,
`EventBus.ts`, `RouterDebugService.ts`, `OutputFormatter.ts`, `coreutils/TailCommand.ts`,
`shell/input/types.ts`, `WindowsTerminalSession.ts`.

### Décisions en attente (humain)
- **Branche** : la consigne tâche dit « mandeng uniquement », la policy de session désigne
  `claude/blissful-faraday-1cbe54` et interdit de pousser ailleurs sans accord explicite.
  `mandeng` est une branche partagée active (473 commits) → confirmation requise avant push.
- **Réorientation** : valider que l'objectif devient *brancher les commandes manquantes sur le
  pipeline existant* (Event Subscription → Background → couverture par équipement) plutôt que
  réécrire un socle.
</content>
</invoke>
