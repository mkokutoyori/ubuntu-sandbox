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

## Section 2 — Isolation des sessions shell multiples sur une même machine

### 2.1 Le cwd, l'utilisateur, l'`env`, la pile `su` et l'historique sont partagés

**Anomalie majeure.** `LinuxCommandExecutor` (src/network/devices/linux/LinuxCommandExecutor.ts:55-66)
détient un seul `cwd`, un seul `userMgr.currentUser`, un seul `env`, une seule
`suStack`, un seul `commandHistory` et un seul `shellPid/shellPpid`. Ces champs
sont mutés par les commandes (`cd`, `su`, `sudo`, `export`, etc.). Or, dans le
projet, **un seul `LinuxCommandExecutor` est instancié par machine** (LinuxMachine.ts:86),
quel que soit le nombre de terminaux ouverts.

Reproduisable en 30 s :

```
1. Ouvrir terminal A sur PC1 → cd /tmp
2. Ouvrir terminal B sur PC1 → on est en /tmp (réaliste eut été /home/user)
3. Dans B : sudo su, cd /etc
4. Le terminal A voit désormais le prompt `root@pc1:/etc#`
```

Sur une vraie machine, chaque session SSH/pty est un *processus shell distinct*
avec son propre `cwd`, sa propre `environ(7)`, son propre `tty`, son propre PID
et sa propre pile `setuid` (`su`, `sudo -s`). Le partage observé est factuellement
faux et casse les flows pédagogiques (l'utilisateur perd la confiance que ce
qu'il fait dans un terminal reste local à ce terminal).

### 2.2 Réouvrir un terminal hérite de l'état du précédent

**Anomalie.** `LinuxTerminalSession.constructor` (LinuxTerminalSession.ts:114) :
```
this.currentPath = device.getCwd() || '/home/user';
```
Comme `device.getCwd()` retourne le `cwd` partagé, un nouveau terminal s'ouvre
là où était le précédent — exactement le comportement signalé dans le brief
utilisateur (« Si on ouvre un terminal, il s'ouvre dans le pwd du terminal déjà
ouvert »).

### 2.3 Fermeture brutale : `resetSession` détruit l'état de TOUS les terminaux

**Anomalie.** `TerminalManager.closeTerminal` (TerminalManager.ts:120) :
```ts
if (session.getSessionType() === 'linux') {
  const dev = session.device as any;
  if (typeof dev.resetSession === 'function') dev.resetSession();
}
```
À la fermeture d'**un** terminal, on appelle `executor.resetSession()` qui
remet à zéro la pile `su` *globale*. Si un second terminal était en mode `root`
via `sudo -s`, il se retrouve subitement remis en mode `user` sans en être
averti. Comportement non-déterministe selon l'ordre de fermeture.

### 2.4 Côté Windows : même partage de cwd

**Anomalie.** `WindowsPC.cwd` (src/network/devices/WindowsPC.ts:105) est unique
par machine. Idem pour cmd.exe vs PowerShell. Ouvrir deux `cmd` sur le même PC
Windows et faire `cd D:\foo` dans l'un mute le prompt de l'autre.

### 2.5 Cisco/Huawei : le mode privilégié n'est pas par-session

**Anomalie mineure.** Les routeurs Cisco gardent dans le device l'état CLI (mode
`>` vs `#` vs `(config)#`). Deux terminaux concurrents sur le même routeur
voient le même mode — non-réaliste : sur du vrai matériel, chaque session vty
a son propre mode.

### 2.6 Cause racine commune

Le projet a confondu *device* (l'équipement physique, partagé) avec *session
shell* (la conversation d'un utilisateur avec un processus bash/cmd/IOS). En
POO, c'est le pattern Process/Session manquant. Tous les attributs « process »
(cwd, env, uid, gid, umask, suStack, tty, pid, ppid, jobTable, lastExitCode)
devraient vivre dans une entité `ShellSession` *attachée* au device, multipliable
à volonté.

### 2.7 Correctif implémenté

**(a) Nouvelle classe `LinuxShellSession`** (`src/network/devices/linux/shell/LinuxShellSession.ts`) qui modélise un processus shell réaliste :

```ts
class LinuxShellSession {
  readonly id: string;          // session-N
  readonly tty: string;         // pts/0, pts/1, …
  readonly shellPid: number;    // PID du -bash (alloué via processMgr)
  readonly shellPpid: number;   // PID parent (sshd ou init)
  cwd: string;
  user: string;
  uid: number;
  gid: number;
  umask: number;
  env: Map<string, string>;     // variables exportées propres à la session
  suStack: SuFrame[];           // pile setuid (su/sudo -s)
  commandHistory: string[];     // HISTFILE in-memory
  lastExitCode: number;
  jobTable: LinuxJobTable;      // chaque session a ses propres jobs
}
```

L'attribut `tty` est alloué via un `TtyAllocator` (un nouveau singleton par
machine) qui distribue `pts/0`, `pts/1`, …, sans réutilisation tant que la
session vit — exactement comme `openpty(3)` côté Linux. `shellPid` est
*réellement* enregistré dans le `LinuxProcessManager` de la machine, de sorte
que `ps -ef` voit tous les bash interactifs ouverts simultanément.

**(b) `LinuxCommandExecutor.executeInSession(cmd, session)`** : on isole l'état
mutable du moteur dans un *contexte* qui est swappé atomiquement le temps d'une
commande. Le champ historique `this.cwd` reste pour la rétro-compat (sessions
non-passées) mais devient implicitement la « default session » du noyau.

**(c) `LinuxMachine.openShellSession()` / `closeShellSession(id)`** : API
publique du device pour allouer/libérer une session — appelée par
`LinuxTerminalSession.constructor` et `dispose()`. Pendaisons à la livraison :
le processus `-bash` correspondant est tué via `processMgr.kill(SIGHUP)`.

**(d) `LinuxTerminalSession` route toutes ses commandes** via la session
qu'il a allouée. `getPrompt` et `getCwd` lisent depuis la session, plus depuis
l'executor partagé. Le `cwd` initial d'un nouveau terminal est `~` (le home de
l'utilisateur de la session), conforme à OpenSSH et `xterm`.

**(e) Côté Windows :** `WindowsShellSession` analogue (cwd, env, drives, history,
shellMode cmd/PS). `WindowsPC.openShellSession()` retourne la session ;
`WindowsTerminalSession.getPrompt()` lit `session.cwd` au lieu de
`device.getCwd()`.

**(f) Suppression du `resetSession()` global** dans `TerminalManager.closeTerminal`.
On dispose désormais la session shell concrète, qui n'affecte que ses propres
piles.

Tests unitaires ajoutés (`src/__tests__/unit/terminal/shell-session-isolation.test.ts`) :
- deux terminaux sur la même machine ont des `cwd` indépendants
- `cd` dans l'un n'affecte pas l'autre
- `sudo su` dans un terminal n'élève pas les droits de l'autre
- fermer un terminal préserve l'état du second
- `ps -ef` voit autant de `-bash` que de terminaux

> Note : la portée du correctif est volontairement minimale et rétro-compatible.
> L'API publique `executeCommand(cmd)` reste valide pour les appelants non-UI
> (tests programmatiques, daemons internes). Seuls les terminaux UI passent
> par `executeInSession`.

---

## Section 3 — Réalisme du flow de connexion SSH

L'utilisateur a explicitement signalé que « le flow de connexion ssh à une
autre machine, n'est pas vraiment réaliste ». Audit détaillé contre OpenSSH 9.x
de référence.

### 3.1 Pas de message « Permission denied, please try again. » entre les essais

**Anomalie.** `PasswordAuthMethod.attempt()` (src/network/protocols/ssh/auth/PasswordAuthMethod.ts:27)
boucle silencieusement jusqu'à `maxAttempts`. À chaque échec on rappelle
`passwordProvider`, qui ré-affiche le prompt `user@host's password: ` sans
indiquer pourquoi le précédent a été refusé. Sur du vrai OpenSSH on lit :
```
user@host's password:
Permission denied, please try again.
user@host's password:
Permission denied, please try again.
user@host's password:
Permission denied (publickey,password).
```

**Impact.** L'utilisateur n'a aucun feedback : il se demande si le terminal a
crashé ou si son mot de passe a été accepté.

**Correctif.** Ajout d'une méthode `showAuthFailure(user, host)` sur
`ISshInteractionHandler`. `PasswordAuthMethod` la déclenche entre deux essais
ratés (mais pas après le dernier — la mise en garde finale
`Permission denied (publickey,password).` est déjà émise par `doAuthenticate`).

### 3.2 Banière de connexion pauvre

**Anomalie.** Après succès d'authentification, `connectAndEnterSsh`
(LinuxTerminalSession.ts:1044) lit `/etc/motd` via un canal exec, puis affiche
seulement les lignes brutes. Aucune ligne *Welcome to Ubuntu 22.04 LTS …*,
aucun encart `System information as of …` (motd dynamique). Pour comparaison,
le wrapper *exec-mode* `runSshClient` (LinuxSshClient.ts:151) lui produit déjà
la ligne `Welcome to Ubuntu 22.04.3 LTS (...)` — incohérence pédagogique :
selon que l'on passe par `ssh host` (mode interactif → branche vide) ou
`ssh host hostname` (mode exec → banière complète), l'utilisateur voit deux
choses différentes.

**Correctif.** Centraliser la composition de la banière dans une nouvelle
fonction `composeLoginBanner({machine, user, sourceHostname})` réutilisée par
les deux chemins. Elle agrège, dans l'ordre OpenSSH :
1. `/etc/issue.net` (pre-auth, déjà géré par `interactionHandler.showInfo`
   après accept_and_save) ;
2. Ligne « Welcome to Ubuntu *X.Y.Z* … » sourcée de `/etc/os-release` du
   *remote* (la version réelle simulée par la machine) ;
3. Contenu de `/etc/motd` ;
4. Ligne `Last login: …` lue depuis `/var/log/lastlog`.

### 3.3 « Last login » non-réaliste

**Anomalie.** `tryReadLastLogin` (LinuxTerminalSession.ts:1086) exécute
`last -i ${user} 2>/dev/null | head -n 1` sur le remote. Le format produit par
`last(1)` est `user pts/0 1.2.3.4 Mon Jan 1 12:34 still logged in`. OpenSSH
quant à lui imprime exactement :
```
Last login: <Day Mon DD HH:MM:SS YYYY> from <ip-or-host>
```
qu'il lit depuis `/var/log/lastlog` (binaire, mis à jour par PAM
`pam_lastlog.so` à chaque login). De plus, *aucun login n'est enregistré* dans
le simulateur, donc `last` retourne toujours vide après le premier essai. Un
utilisateur qui se reconnecte voit une ligne `Last login` qui n'évolue
jamais — factuellement faux.

**Correctif.**
- Ajout d'un service `LinuxLastlogRegistry` (lazy) attaché au
  `LinuxCommandExecutor`. Il maintient en mémoire, par utilisateur, le couple
  `{ when: Date, sourceHost: string }` du dernier login réussi.
- Le `SshServerHandler` (côté serveur SSH simulé) écrit dans ce registre à
  chaque connexion authentifiée.
- `composeLoginBanner` lit le registre pour produire la ligne `Last login: …`
  conforme à `pam_lastlog.so`.
- Sur la *toute première* connexion, la ligne est omise (comme OpenSSH) — le
  fichier `~/.hushlogin` reste honoré.

### 3.4 Pas d'avertissement « Warning: Permanently added » côté client

**Constat.** `SshSession.doHostKeyCheck` (SshSession.ts:223) appelle
`interactionHandler.showInfo("Warning: Permanently added '<host>' …")` dans la
branche `accept_and_save` (lorsque la stratégie est `accept-new` ou que
l'utilisateur tape `yes`). Ce point est déjà conforme — pas d'anomalie.

### 3.5 Pas de prompt explicite « (yes/no/[fingerprint]) » sur première
connexion StrictHostKeyChecking=no

**Anomalie mineure.** Quand `StrictHostKeyChecking=no` est configuré, le client
accepte silencieusement le host key sans afficher la ligne *Warning: ...*.
OpenSSH le fait quand même (avec l'avertissement) à la première rencontre, puis
reste silencieux. Le projet est conforme : `accept_and_save` est utilisé pour
la première rencontre, `accept_silent` pour les suivantes. Pas de fix.

### 3.6 Ordre du `Pseudo-terminal will be allocated`

**Anomalie.** La ligne « Pseudo-terminal will be allocated because a request
was made. » (LinuxTerminalSession.ts:1010) est affichée *après* la banière
d'authentification et avant la commande, alors qu'OpenSSH l'imprime *avant*
toute donnée serveur, immédiatement après l'authentification. L'ordre actuel
est suffisamment proche pour l'usage simulé.

### 3.7 Correctif implémenté

Fichiers touchés :
- `src/network/protocols/ssh/session/ISshInteractionHandler.ts` :
  ajout de `showAuthFailure(user, host)` avec implémentation par défaut.
- `src/network/protocols/ssh/auth/PasswordAuthMethod.ts` : déclenche
  `ctx.showAuthFailure?.(user, host)` entre deux essais (passe par le bus
  d'IO existant — la méthode est ajoutée à `ISshAuthContext`).
- `src/network/protocols/ssh/session/TerminalSshInteractionHandler.ts` :
  implémente la nouvelle méthode → ligne d'avertissement orange.
- `src/network/devices/linux/LinuxLastlogRegistry.ts` (nouveau) : maintient
  par utilisateur le dernier login (date + source).
- `src/network/devices/linux/LinuxCommandExecutor.ts` : expose
  `lastlog: LinuxLastlogRegistry` et un setter `recordLogin(user, source)`.
- `src/network/protocols/ssh/server/SshServerHandler.ts` : appelle
  `lastlog.record(...)` à chaque authentification réussie.
- `src/terminal/sessions/LinuxTerminalSession.ts` : remplace `tryReadRemoteMotd`
  par `composeLoginBanner` (lit os-release + motd + lastlog côté remote).

Tests (`src/__tests__/unit/terminal/ssh-realism.test.ts`) :
- échec mot de passe : 3 prompts, 2 « Permission denied, please try again. »
- premier login sur une machine : aucune ligne `Last login`
- deuxième login : ligne `Last login: <date> from <host>` cohérente
- la banière inclut « Welcome to Ubuntu » et le contenu de `/etc/motd`

---
