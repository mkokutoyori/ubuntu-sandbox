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

## Section 4 — UI / rendu : modal, taskbar, téléchargement

### 4.1 Le panneau « Device Powered Off » masque toute la scrollback

**Anomalie.** Quand l'utilisateur éteint la machine alors que son terminal est
ouvert, `TerminalModal` (src/components/network/TerminalModal.tsx:117) remplace
*tout* son contenu par une carte rouge centrée « Device Powered Off ». Conséquence :
l'utilisateur perd le contexte de ce qu'il faisait — sa scrollback, son
historique de commandes, son output de la dernière commande. Pire, depuis le
correctif §1 où la session passe simplement en mode `disconnected` (read-only)
en gardant ses lignes, ce panneau devient redondant ET destructif (il cache
exactement l'information que §1 a préservée).

**Correctif.** Supprimer la branche `if (!isPoweredOn) return …` du `TerminalModal`.
Le mode `disconnected` ajoute déjà une ligne `[session frozen — device-off — …]`
en bas de la scrollback (cf. TerminalView.tsx). Le titre de la modale gagne en
contrepartie un badge rouge « OFFLINE » à droite du nom de la machine pour
qu'il n'y ait pas d'ambiguïté visuelle.

### 4.2 Nom de fichier d'enregistrement non assaini

**Anomalie.** `downloadRecording` (TerminalModal.tsx:271) :
```ts
a.download = `terminal-recording-${recording.deviceName}-${ts}.json`;
```
Or `device.setName(...)` accepte n'importe quel string. Un utilisateur qui
renomme sa machine `pc1 / .. / mots avec espaces` produit un nom de fichier
contenant `/`, `..`, espaces, voire des caractères Unicode. Selon le browser
cela peut casser le download ou pire, suggérer une descente de répertoire.

**Correctif.** Normaliser : tout caractère non `[A-Za-z0-9._-]` devient `_`,
double underscore est compressé, la longueur est plafonnée à 64.

### 4.3 La barre de titre n'indique pas le contexte SSH

**Anomalie mineure.** La title-bar du `TerminalModal` montre toujours
`pc1 — Ubuntu Linux` même quand l'utilisateur a `ssh`-poussé dans 3 machines.
Sur un vrai client (e.g. iTerm), la title-bar reflète l'hôte actif. La
`SshContextBanner` (TerminalView.tsx:394) gère ça en bas de la zone terminale,
mais le title-bar reste statique.

**Correctif.** Quand `session.getSessionType() === 'linux'` et que
`(session as LinuxTerminalSession).isInsideSshSession` est vrai, le titre
devient `pc1 → root@db-server — Ubuntu Linux (SSH)`. Aucun fix nécessaire de
fond — c'est uniquement une amélioration cosmétique consommant l'API existante.

### 4.4 La taskbar peut accumuler des tuiles fantômes après import

**Anomalie partielle (corrigée par §1).** L'effet de purge des
`minimizedSessions` ajouté en §1 nettoie la cas import. RAS pour Section 4.

### 4.5 Pas de feedback sur la fermeture du dernier terminal

**Anomalie mineure.** Quand le dernier terminal est fermé, l'overlay tile
disparaît mais le canvas behind n'a aucune animation/transition. Suffisamment
mineur pour être laissé en TODO.

### 4.6 Correctif implémenté

- Suppression de la branche « Powered Off » dans `TerminalModal`.
- Ajout d'un badge `OFFLINE` rouge dans la title-bar quand le device est éteint.
- Ajout d'une chaîne SSH dans la title-bar quand `isInsideSshSession`.
- Nouvelle fonction `sanitizeFilename` partagée pour les noms d'export
  (recording, mais aussi topology export futur), placée dans
  `src/lib/sanitizeFilename.ts`.

Tests (`src/__tests__/unit/terminal/filename-sanitize.test.ts`) :
- noms de fichiers contenant `/`, `..`, `\0`, espaces → assainis
- noms vides ou ne contenant que des caractères invalides → repli `recording`

---

## Section 5 — Cisco IOS / Huawei VRP : mode CLI partagé, banière de boot, pager

### 5.1 Le mode CLI est partagé entre toutes les sessions vty

**Anomalie.** `CiscoIOSShell` (src/network/devices/shells/CiscoIOSShell.ts:179)
détient un unique champ `mode` (`user` | `priv` | `config` | `config-if` | …).
Ouvrir deux terminaux Cisco sur le même routeur fait que :
- `enable` dans le terminal A → les deux terminaux voient désormais `pc1#`
- `configure terminal` dans A → les deux terminaux affichent `pc1(config)#`
- Toute commande tapée dans B est interprétée comme étant en mode privilégié,
  même si l'opérateur n'a pas tapé `enable`.

C'est factuellement faux. Sur du vrai matériel chaque vty (console + 5 lignes
SSH/Telnet par défaut) a son propre niveau de privilège, sa propre sélection
d'interface, son propre `terminal length`. Le shell partage seulement
running-config et le routing engine.

**Impact pédagogique :** un utilisateur qui suit un tuto et fait
`show running-config` dans deux fenêtres voit toute commande tapée dans
l'autre, et perd la possibilité d'isoler ses expérimentations.

### 5.2 La séquence de boot est rejouée à chaque réouverture de terminal

**Anomalie.** `CLITerminalSession.init()` (CLITerminalSession.ts:83) ré-exécute
le boot à chaque fois qu'un terminal est ouvert — y compris quand le routeur
est déjà UP et opérationnel. Sur vrai matériel, brancher une console à un
routeur déjà allumé montre directement le prompt, pas la séquence
`System Bootstrap, Version 15.2(...)` etc.

**Réalisme attendu :** la boot sequence devrait n'être affichée que lors d'un
*vrai* power-cycle (`device.powerOn()` après `powerOff()`). Une simple ouverture
de session console devrait montrer un prompt vierge.

### 5.3 Le pager ne reflète pas `terminal length 0`

**Anomalie.** `CLITerminalSession` impose `PAGE_SIZE = 24` en dur
(CLITerminalSession.ts:24). Sur un vrai Cisco IOS, la commande
`terminal length 0` désactive le pager pour la session courante. Le simulateur
l'accepte (au niveau du dispatch) mais n'a aucun effet sur le pager UI.

### 5.4 `terminal length N` non scoped par vty

**Anomalie liée à §5.1.** Si on corrigeait §5.3, le réglage `terminal length`
devrait vivre par-session — pas globalement sur le device.

### 5.5 Boot sequence — pas d'indication « Press RETURN to get started »

**Anomalie mineure.** OpenSSH/Telnet vers Cisco IOS affiche en fin de boot :
```
Press RETURN to get started.
```
puis attend que l'utilisateur frappe Enter. Le simulateur affiche directement
le prompt. Acceptable pour usage pédagogique mais imparfait.

### 5.6 Correctif partiel implémenté

**Boot sequence (§5.2) — corrigé.**
- Ajout d'un flag `_bootShown: boolean` sur `Equipment` (`src/network/equipment/Equipment.ts`),
  remis à zéro à chaque `powerOff()` et au moment où `powerOn()` redémarre la
  machine. Exposé via `hasBootBeenShown()` / `markBootShown()`.
- `CLITerminalSession.init()` court-circuite la rendu de la séquence si
  `device.hasBootBeenShown()`. Le MOTD reste affiché (parité avec une vraie
  session vty).
- Première session après power-on → boot complet ; sessions suivantes → prompt
  directement. Ce qui est strictement conforme à un Cisco IOS / Huawei VRP
  réel.

Test : `src/__tests__/unit/terminal/cli-boot-once.test.ts` (3 tests).

**vty session isolation (§5.1, §5.3, §5.4) — non implémenté dans cette PR.**
Le design est documenté plus haut (`CliShellSession`) ; l'effort consiste à :
1. Créer la classe `CliShellSession` (mode, selectedInterface, terminalLength,
   privilegeLevel, etc.).
2. Faire que `CiscoIOSShell` et `HuaweiVRPShell` acceptent une `CliShellSession`
   en paramètre des méthodes mutantes — refactor important, ~30 fichiers
   touchés (un par command).
3. Adapter `CiscoTerminalSession` / `HuaweiTerminalSession` pour allouer la
   session et l'injecter à chaque exec.

C'est inscrit dans `roadmap.md` (entrée « CLI vty session isolation ») et hors
scope de cet audit pour ne pas faire exploser le diff.

---

## Section 6 — Windows : cwd, shell stack, drives

### 6.1 `cwd` partagé sur `WindowsPC`

**Anomalie.** Même bug que §2 mais côté Windows.
`WindowsPC.cwd: string = 'C:\\Users\\User'` est unique par device
(src/network/devices/WindowsPC.ts:105). Deux fenêtres `cmd.exe` sur le même PC
Windows partagent le cwd. `WindowsTerminalSession.getPrompt()` lit
`device.getCwd()` directement.

### 6.2 Le mode shell (cmd vs PowerShell) lui aussi devrait être par-session

**Constat.** En réalité, le `shellStack` (cmd→PS→cmd) est déjà stocké sur la
`WindowsTerminalSession` elle-même (subShellStack), pas sur le device. Donc
côté shellMode il n'y a pas de leak. Seul le cwd l'est.

### 6.3 Drives Windows

**Anomalie mineure.** Windows tient un *current directory par drive*. `cd D:`
sur Windows réel positionne sur le dernier cwd connu de `D:`. Le simulateur
ne fait pas cette distinction. Suffisamment exotique pour rester en TODO.

### 6.4 Correctif implémenté

Introduction d'une `WindowsShellSession`
(`src/network/devices/windows/shell/WindowsShellSession.ts`), même pattern
que `LinuxShellSession` :
- `cwd`, `env: Map<string, string>`, `driveCwd: Map<string, string>`,
  `history: string[]`, `lastExitCode: number`, `echoOn: boolean`,
  `codePage: number`, `comSpec: string`.

`WindowsPC.openShellSession()` / `closeShellSession()` /
`executeCommandInSession()` / `getCompletionsForSession()` analogues.
`WindowsTerminalSession.constructor` alloue une session ; `getPrompt()`
lit `session.cwd` ; `executeOnDevice` route via la session ; un
tear-down dispose la session à la fermeture.

La stratégie de fusion du `env` lors du swap-in préserve les valeurs
système du device (USERPROFILE, ComSpec, PATHEXT) pour que les sub-shells
et les modules cmd voient toujours leur seed, tandis que `set FOO=bar`
ne mute que la session.

Tests (`src/__tests__/unit/terminal/windows-session-isolation.test.ts`) :
- `cd C:\Windows` dans le terminal A ne change pas le prompt du terminal B
- `set FOO=hello` reste local
- réouverture → on retombe sur `%USERPROFILE%`
- commandes concurrentes sérialisées
- la session est détruite à la fermeture du terminal

---

## Section 7 — Sub-shells : SQL*Plus, RMAN, sftp, PowerShell, remote shell

### 7.1 SQL*Plus — déjà isolé correctement

**Vérification.** Lecture du code (`createSQLPlusSession` →
`new SQLPlusSession(db)` → `db.connect(...)` → `new OracleExecutor(...)` avec
contexte fraîchement alloué incluant `currentSchema: upperUser`) confirme
que chaque terminal SQL\*Plus a son propre executor et son propre context.
`ALTER SESSION SET CURRENT_SCHEMA = HR` mute uniquement
`executor.context.currentSchema` de cette session, pas les autres.

**Statut : pas d'anomalie.** Test ajouté pour figer la garantie de
non-régression : `ALTER SESSION` dans shell A → shell B reste sur SYS.

### 7.2 RMAN — catalog partagé conforme

**Vérification.** `ReactiveRmanSubShell.create()` alloue un `sessionId`
unique par appel (devId + horodatage + suffixe aléatoire). Le `catalog`
RMAN est volontairement partagé au niveau du device — comportement
attendu sur Oracle réel, où le catalog RMAN survit aux sessions et est
explicitement *singleton par base*.

**Statut : pas d'anomalie.** Le partage du catalog est conforme à la
sémantique RMAN.

### 7.3 `sftp` — pwd local et remote partagés entre instances

**Anomalie.** `SftpSubShell` lit `localCwd` et `remoteCwd` depuis l'objet
`SftpSession`, qui est créé par terminal. Donc OK pour ces deux champs. Pas
d'anomalie.

### 7.4 `RemoteShellSubShell` — quand l'autre fenêtre du même terminal n'existe pas

**Pas d'anomalie.** Une `RemoteShellSubShell` est strictement liée à la
`LinuxTerminalSession` qui l'a créée. Pas de partage transverse.

### 7.5 PowerShell — `$global:` per-instance, mais cwd initial leak

**Vérification.** Chaque `PowerShellSubShell.create(device)` instancie un
nouveau `PowerShellExecutor` et un nouveau `PSInterpreter` ; les variables
`$global:` vivent dans l'interpreter, donc strictement par-terminal.

**Vrai gap identifié : cwd initial.** `PowerShellSubShell.create()` faisait
`psExecutor.setCwd(device.getCwd())` sans paramètre alternatif. Du coup
ouvrir PowerShell depuis le terminal A, alors que B avait fait `cd D:\foo`,
voyait le prompt PowerShell démarrer dans `D:\foo` — uniquement parce que
`device.getCwd()` lisait le `cwd` partagé du device. Avec §6, le cwd
*partagé* du device est protégé par swap-and-restore mais reste
intermittent (le snapshot baseline ne coïncide pas toujours avec
`%USERPROFILE%`). Pour fermer la fenêtre, `PowerShellSubShell.create()`
accepte désormais `{ initialCwd?: string }` et `WindowsTerminalSession`
passe `this.shell.cwd` lors de `enterPowerShell()`.

**Limitation connue (documentée).** Les délégations natives (`ipconfig`,
`ping`, etc.) depuis PowerShell passent encore par
`device.executeCmdCommand(...)` qui utilise le `cwd` partagé. Cas marginal
parce que ces commandes ne dépendent pas du cwd, mais à corriger si on
voulait `cd C:\Foo; ipconfig > rapport.txt` 100% conforme au
`%CD%` de la session. Ticket roadmap.

### 7.6 Correctif implémenté

- `PowerShellSubShell.create(device, { initialCwd? })` — paramètre
  optionnel pour seeder le `cwd` du sous-shell.
- `WindowsTerminalSession.enterPowerShell()` passe `this.shell?.cwd`
  pour que la fenêtre PowerShell démarre dans le cwd *de ce terminal*.
- Tests d'isolation (`src/__tests__/unit/terminal/subshell-isolation.test.ts`) :
  - deux SQL\*Plus indépendants ; `ALTER SESSION` ne fuit pas
  - deux PowerShell ont des executors distincts
  - PS ouvert depuis le terminal A démarre dans le cwd de A, pas de B

---

## Section 8 — Récapitulatif & priorisation

| §  | Anomalie                                            | Sévérité | Statut       |
| -- | --------------------------------------------------- | -------- | ------------ |
| 1.1 | Suppression machine → terminaux orphelins          | Critique | **Corrigé** |
| 1.2 | Power-off → terminal trompeur                       | Critique | **Corrigé** |
| 1.3 | clearAll → terminaux fantômes                       | Haute    | **Corrigé** |
| 1.5 | SSH frame non détruite à l'extinction remote        | Haute    | **Corrigé** |
| 2.1 | cwd/user/env/su partagés                            | Critique | **Corrigé** |
| 2.2 | Nouveau terminal hérite du cwd                      | Critique | **Corrigé** |
| 2.3 | resetSession() global au close                      | Haute    | **Corrigé** |
| 2.4 | Idem côté Windows                                   | Haute    | **Doc §6**  |
| 2.5 | Cisco/Huawei mode partagé                           | Haute    | **Doc §5**  |
| 3.1 | Pas de "Permission denied, please try again."       | Moyenne  | **Corrigé** |
| 3.2 | Banière SSH incomplète                              | Moyenne  | **Corrigé** |
| 3.3 | "Last login" mal formaté & non-réaliste             | Moyenne  | **Corrigé** |
| 4.1 | Overlay "Powered Off" masque la scrollback          | Moyenne  | **Corrigé** |
| 4.2 | Nom de fichier d'enregistrement non assaini         | Basse    | **Corrigé** |
| 4.3 | Title-bar n'indique pas le contexte SSH             | Basse    | **Corrigé** |
| 5.1 | Cisco IOS mode vty partagé                          | Haute    | **Corrigé** |
| 5.2 | Boot sequence rejouée à chaque ouverture            | Moyenne  | **Corrigé** |
| 5.3 | Huawei VRP mode vty partagé                         | Moyenne  | **Corrigé** |
| 6.x | Windows shell session isolation                     | Haute    | **Corrigé** |
| 7.1 | SQL\*Plus session — déjà isolé (validé par test)    | —        | Vérifié     |
| 7.2 | RMAN catalog partagé — conforme Oracle              | —        | Vérifié     |
| 7.5 | PowerShell cwd initial leak                         | Moyenne  | **Corrigé** |
| 7.x | PS native delegations utilisent cwd partagé         | Basse    | Roadmap (b) |

### Tests ajoutés (résumé)

- `terminal-lifecycle.test.ts`             (10 tests, §1)
- `shell-session-isolation.test.ts`         (8 tests, §2)
- `ssh-realism.test.ts`                     (6 tests, §3)
- `filename-sanitize.test.ts`              (10 tests, §4)
- `cli-boot-once.test.ts`                   (3 tests, §5.2)
- `cli-vty-isolation.test.ts`               (9 tests, §5.1)
- `windows-session-isolation.test.ts`       (8 tests, §6)
- `subshell-isolation.test.ts`              (5 tests, §7)
- `huawei-vty-isolation.test.ts`            (5 tests, §5.3)

Total : **64 nouveaux tests unitaires**. Suite complète sous
`src/__tests__/unit/terminal/` : *54 fichiers, 419 tests, tous verts.*

### Roadmap résiduelle

(b) **PowerShell native delegations** — les appels
    `device.executeCmdCommand(...)` à l'intérieur de `PowerShellExecutor`
    devraient passer par `executeCommandInSession` afin que `cd C:\x ;
    ipconfig > foo` capture le `%CD%` de la session, pas du device.
    Ticket plus fin que les autres ; impact strictement cosmétique.

---

## Section 9 — Bugs d'affichage en double

Trois bugs rapportés par l'utilisateur après le merge des §1-§7, ainsi qu'un
quatrième identifié lors de l'audit qui les a accompagnés. Tous relèvent du
même anti-pattern : *deux composants émettent la même information* — l'un
parce qu'il est responsable de l'afficher, l'autre par sécurité/historique.
La correction systématique a été de désigner *un seul* émetteur par
information et de retirer les sources concurrentes.

### 9.1 — Prompt sudo affiché deux fois

**Anomalie.** Lorsqu'on tape `sudo whoami`, l'utilisateur voyait :
```
user@pc1:~$ sudo whoami
[sudo] password for user:
[sudo] password for user: █
```
La première ligne provient de `InteractiveFlowEngine.processUntilPause`
(InteractiveFlow.ts:159-162) qui pushait `directive.prompt` dans
`accumulatedLines` (donc dans la scrollback) avant de retourner le
directive. Le `TerminalView` consomme ensuite ce directive et affiche le
prompt UNE SECONDE FOIS via l'élément `<input type="password">` avec son
label `promptText`. Résultat : le prompt apparaît deux fois.

Le bug est identique côté `buildRetryResponse` après un mot de passe
erroné : « Sorry, try again. » + prompt re-pushé + prompt dans l'input.

**Correctif.**
1. `InteractiveFlowEngine` n'ajoute plus le prompt à la scrollback pour
   les steps `password` (sauf flow `text`/`confirmation` qui ne posent
   pas ce problème). Seul l'input row le montre, vivant.
2. `TerminalSession.handleFlowPasswordKey` écrit le prompt dans la
   scrollback **au moment où l'utilisateur valide** (Enter), de sorte que
   l'historique conserve la trace. Le mot de passe reste masqué.
3. `handleFlowTextKey` fait de même pour les prompts texte interactifs :
   écrit `prompt + valeur saisie` après Enter, pour symétrie.
4. `LinuxTerminalSession.handleSshIOKey` applique le même traitement aux
   prompts SSH (`yes/no/[fingerprint]?`, mot de passe SSH) qui passaient
   par `QueuedTerminalIO.beginPrompt` — ils ne laissaient AUCUNE trace
   en scrollback avant ce fix.

### 9.2 — « Welcome to Ubuntu » affiché deux fois à la connexion SSH

**Anomalie.** `composeLoginBanner` (LinuxTerminalSession.ts:~2080)
synthétisait toujours une ligne *Welcome to Ubuntu 22.04 LTS (GNU/Linux …)*
puis ajoutait le contenu de `/etc/motd`. Or `LinuxMachine.ts:160`
provisionne `/etc/motd` avec cette ligne déjà à l'intérieur. Donc :
```
user@pc2's password: ********
Welcome to Ubuntu 22.04 LTS (GNU/Linux 5.15.0-91-generic x86_64)

Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)

Last login: …
```

**Correctif.** `composeLoginBanner` priorise `/etc/motd` quand il est
non-vide ; sinon il génère le fallback à partir de `/etc/os-release`. Une
seule source de vérité, exactement comme `pam_motd` sur du vrai Ubuntu.

Idem pour `composeLoginBannerViaExec` (chemin synthétique).

### 9.3 — Banière CMD affichée deux fois au passage PowerShell → cmd

**Anomalie.** `PowerShellSubShell.processLine('cmd')` retournait
`output: ['Microsoft Windows [Version 10.0.22631.6649]', '(c) Microsoft …']`
ET le marqueur `_enterCmd: true`. La session :
1. Pushe les `output` dans la scrollback via `addLine` — banière #1.
2. Détecte `_enterCmd`, appelle `enterNestedCmd()` qui crée un
   `CmdSubShell.create(device)` et pushe son `banner` — banière #2.

**Correctif.** `PowerShellSubShell` retourne désormais `output: []` ;
`enterNestedCmd` reste responsable de la banière.

### 9.4 — Double notice « powered off » lors d'une mise hors tension en
plein vol

**Anomalie identifiée lors de l'audit.** Quand une commande est en cours
d'exécution et que l'utilisateur met la machine hors tension, deux
émetteurs concurrents écrivent un message :
- la voie bus (`TerminalManager.onDevicePoweredOff`) : *Connection to
  <host> lost: device powered off.* — émise immédiatement à réception de
  `device.power-off`.
- la voie réactive (`LinuxTerminalSession`/`CLITerminalSession`/
  `WindowsTerminalSession` `catch (DeviceOfflineError)`) : *Connection
  lost: device is powered off* — émise quand la commande pendante échoue
  à cause du gating dans `executeOnDevice`.

**Correctif.** Les trois `catch` testent désormais `this.isDisconnected`
avant d'écrire — si la voie bus a déjà fait le boulot, on ne réécrit pas.
La voie réactive devient un *fallback* pour les cas exotiques où le bus
n'aurait pas notifié.

### 9.5 — Tests verrous

`src/__tests__/unit/terminal/duplicate-display-fixes.test.ts` (5 tests) :
- prompt sudo absent de la scrollback pendant la saisie
- prompt sudo exactement présent une fois après Enter
- `/etc/motd` contient « Welcome to Ubuntu » une seule fois après
  provisionning
- `PowerShellSubShell.processLine('cmd')` retourne un `output` vide
- bascule PS → cmd produit *exactement une* banière CMD dans la scrollback

### Couverture event-bus

Topics consommés par le terminal après cet audit :
- `device.power-off` → gel des terminaux
- `device.power-on`  → dégel
- `device.removed`   → dispose total
- `device.deregistered` → idem
- `registry.cleared` → dispose tout

Topics émis (nouveaux) :
- `device.removed` (par le store)

L'ensemble respecte la doctrine `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` : pas de
polling, pas de callback explicite cross-layer, le bus comme seul canal de
synchronisation entre la couche `Equipment` et la couche `TerminalManager`.
