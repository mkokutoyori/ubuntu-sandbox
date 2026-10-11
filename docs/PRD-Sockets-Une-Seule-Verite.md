# PRD — une seule vérité sur les ports ouverts

## 1. Pourquoi ce document

`docs/PRD-Nginx.md` §P0 a corrigé une contradiction : `ss` montrait un port
que rien n'ouvrait. Il a laissé ouverte **l'erreur symétrique**, et je l'ai
signalée en la livrant : un port réellement ouvert sur la pile TCP
n'apparaît pas dans `ss`.

Ce document traite la cause commune aux deux, qui n'est pas un bug mais une
**structure** : il y a deux tables de ports sur chaque machine, et rien ne
les oblige à s'accorder.

## 2. La structure, vérifiée dans le code

| Table | Qui l'écrit | Qui la lit |
|---|---|---|
| `SocketTable` | `socketTable.bind(...)` | `ss`, `netstat`, `/proc/net/tcp`, `lsof`, `nmap` (bannières) |
| `TcpStack.listeners` | `TcpStack.listen(...)` | **la décision d'accepter ou de refuser une connexion** |

Aucune des deux n'est dérivée de l'autre. Un port peut donc être :

- **dans les deux** — le cas normal ;
- **dans `SocketTable` seulement** — affiché, injoignable. C'est le décor
  que `PRD-Nginx` §P0 a retiré pour `apache2`, `mysql`, `postgresql` ;
- **dans `TcpStack` seulement** — joignable, invisible. C'est ce qui reste.

## 3. Ce que le code dit déjà de ce défaut

Il n'est pas nouveau, et **il a été rencontré au moins cinq fois** par des
auteurs différents, qui l'ont chaque fois contourné sans le nommer :

1. **`LinuxMachine.bindDnsServerPort()`**, commentaire verbatim :
   « `TcpStack.listen()` n'inscrit rien dans la table des sockets : sans
   ces deux lignes, `ss`/`netstat` ne montreraient ni le 53/tcp ni le 853,
   alors que les deux répondent réellement. » Suivi de deux
   `socketTable.bind()` manuels.
2. **`LinuxMachine.bindResolvedStub()`** : « L'unité systemd-resolved pose
   une entrée sans gestionnaire dans la table des sockets
   (`SERVICE_LISTENERS`) : c'est elle que `ss` montrait. On la reprend pour
   mettre un vrai service derrière. »
3. **`ssh-tunnel-bypass-acl.test.ts`** : « systemctl projects mysqld into
   /proc/net/tcp but does not open a real TCP accept-loop; bind one
   explicitly so the TCP stack answers SYNs. »
4. **`scenario-config-drift.test.ts`** liait 9090 à la main pour la même
   raison (retiré depuis, la vraie écoute existant enfin).
5. **`scenario-config-drift.test.ts`** encore : son cas « config stale »
   écrivait `listen 8080` puis exigeait que `ss` ne montre PAS `:8080` —
   il ne passait que parce que la configuration était ignorée.

**16 appels à `socketTable.bind()`** subsistent dans `src/network/` hors
tests, répartis sur 6 fichiers. Chacun est soit une projection légitime,
soit un doublon manuel de ce type. Les distinguer est le premier travail.

## 4. Pourquoi ça compte, et pour qui

Un apprenant à qui l'on enseigne le diagnostic réseau apprend une méthode :
le service tourne-t-il, le port est-il ouvert, la connexion passe-t-elle.
Sur une vraie machine ces trois questions se recoupent. Ici elles peuvent
se contredire dans les deux sens — et la contradiction est silencieuse.

C'est plus grave qu'une fonctionnalité absente : une absence enseigne
« ce n'est pas simulé », une contradiction enseigne une règle fausse.

## 5. Principes

- **P1 — Une seule vérité par fait.** Un port TCP en écoute est un fait ;
  il ne doit pas exister deux réponses à « ce port est-il ouvert ? ».
- **P2 — La vérité est celle du transport.** Entre les deux tables, celle
  qui décide d'accepter une connexion l'emporte : c'est la seule que
  l'opérateur peut vérifier par un `curl`.
- **P3 — Aucun doublon manuel.** Un appelant qui ouvre une écoute ne doit
  pas avoir à l'annoncer une seconde fois ; c'est la source des
  divergences, pas leur remède.
- **P4 — Ce que la `SocketTable` sait en plus doit survivre.** Elle porte
  le pid, le nom de processus et la bannière — que `TcpStack` ignore, et
  dont `nmap`, `lsof` et `/proc/net/tcp` dépendent. Unifier ne veut pas
  dire appauvrir.

## 6. Phases

### P0 — Inventorier, sans rien changer

Classer les 16 `socketTable.bind()` en trois familles :
**(a)** projection d'un service réel, **(b)** doublon manuel d'un
`TcpStack.listen()` voisin, **(c)** entrée décorative sans écoute.
Cet inventaire décide de tout le reste ; le produire avant d'écrire une
ligne est le même « cadrer avant, pas pendant » que `PRD-Curl` §P2.

- **Acceptation :** un test qui, pour chaque machine construite, croise
  `TcpStack.listListeners()` et la `SocketTable` et rend la liste des
  divergences. Il documente l'état avant de le corriger.

#### Résultat de l'inventaire

Les 16 appels, lus un par un :

| Site | Ports | Famille |
|---|---|---|
| `LinuxMachine.bindDnsServerPort()` | 53, 853 | **(b)** doublon d'un `listen()` voisin — le commentaire le dit lui-même |
| `LinuxMachine.initDefaultSockets()` — sshd | 22 v4+v6 | **(b)** doublon de `attachSshTcpListeners()` |
| `LinuxMachine.initDefaultSockets()` — tnslsnr | 1521 v4+v6 | **(c)** décoratif, déjà écrit au point de liaison |
| `LinuxMachine` — sshd d'après `sshd_config` | ports `Port` | **(b)** doublon, même écoute |
| `ServicePortProjection` | selon l'unité | **(a)** projection légitime, gardée par `ServiceSocketServer.open()` depuis `PRD-Nginx` §P0 |
| `EndHost.udpBind()` / `udpBindAddress()` | UDP | **(a)** projection légitime — hors périmètre (§7) |
| `WindowsPC.initDefaultSockets()` | 22, 445, 3389 | **(b)** doublon des `listen()` du même fichier |
| `WindowsPC.initDefaultSockets()` | 139 | **(c)** décoratif — aucun `listen(139)` nulle part |
| `WindowsServicePortProjection` | selon le service | **(a)** projection légitime |
| `PortProxySocketProjection` | port d'écoute | **(a)** projection, suivie d'un vrai `listen()` |

**L'erreur symétrique est la plus nombreuse**, et elle n'apparaît dans
aucun de ces 16 appels puisqu'elle consiste précisément à n'en faire
aucun. Écoutes réelles sans entrée dans la table :
`LinuxMachine.openActivationSocket()` (activation par socket systemd),
`RndcServer`, `SshForwardingTable` et les trois transitaires SSH
(`SshLocalForwarder`/`SshRemoteForwarder`/`SshDynamicForwarder`),
`FtpServer`, `SmtpServer`, `Http1ServerSession`, `Http2Connection`,
`HttpsServerSession`, `TacacsServerAgent`, `RadiusTcpTransport`, et côté
Windows le 5985 (WinRM), le 389 (LDAP), le 88 (Kerberos), la réplication
AD, DFSR, WSUS et LPD. Toutes répondent réellement ; aucune n'est visible
dans `ss`.

`Router` n'a pas de `SocketTable` du tout : ses écoutes 22/23 sont hors
périmètre, faute de commande qui lirait la table.

**Ce que l'inventaire décide.** La famille (b) ne peut pas être retirée
avant que l'inscription soit automatique, sinon les ports disparaissent
de `ss`. L'ordre est donc : P1 rend `listen()` annonçant, et seulement
ensuite les doublons deviennent redondants et se retirent.

### P1 — `TcpStack.listen()` annonce, `close()` retire

Le point unique où une écoute naît. Chaque `listen()` inscrit l'entrée
`LISTEN` correspondante, chaque `closeListener()` la retire.

L'appelant fournit pid/processus/bannière au moment du `listen()` — les
16 doublons manuels deviennent alors des arguments, et disparaissent.

**Le mécanisme, décidé après lecture du code.** `TcpStack.listen()`
publie déjà `tcp.listener.changed` sur le bus. S'y abonner serait le
chemin court, et ce serait une erreur : le bus par défaut est remis à
zéro avant chaque test (`setupGlobalState.ts`), et un abonné manqué ne
se voit pas. On branche donc un **sink étroit depuis l'intérieur de
`TcpStack`** — `ListenerSocketSink`, sur le modèle de
`ServiceRegistrySink` pour le registre Windows : une écoute ne peut pas
oublier de s'annoncer puisqu'il n'y a rien à annoncer. `EndHost`, qui
possède les deux tables, fournit le sink.

`TcpListenOptions` gagne `pid`/`processName`/`banner` : c'est ainsi que
P4 est tenu, l'identité voyage avec l'écoute au lieu d'être réinscrite à
côté par un appelant qui pourrait l'oublier.

**Deux pièges vérifiés dans le code, pas supposés.**

1. Les deux tables ne se clavent pas pareil. `TcpStack` clave par
   `ip:port`, `SocketTable` par `protocole:famille:port` — l'adresse
   n'entre pas dans sa clé. Deux écoutes sur le même port et des
   adresses différentes sont légales pour l'une et `EADDRINUSE` pour
   l'autre. Le sink doit donc consulter `isPortBound()` avant de lier,
   et se taire plutôt que de lever.
2. `SocketTable.bind()` refuse avec `EMFILE` quand un `pid` est fourni
   et que le garde de descripteurs (§F9.3) dit non. Une écoute qui
   n'annonce pas de pid n'est donc pas concernée — et aucune ne le fait
   aujourd'hui, ce qui rend la première passe inoffensive de ce côté.

**Le sink n'est additif qu'au départ, et c'est délibéré.** Il ne retire
que ce qu'il a lui-même posé. Les 16 `bind()` manuels gardent
exactement leur cycle de vie actuel, si bien que P1 ne peut faire
disparaître aucune ligne de `ss` — il ne peut qu'en ajouter. Les
doublons deviennent alors redondants et se retirent un par un en P2,
sous la protection du test de croisement.

- **Acceptation :** le test de P0 ne rend plus aucune divergence
  « joignable, invisible » — la famille la plus nombreuse, et celle que
  `PRD-Nginx` §P0 avait laissée ouverte —, et aucune suite existante ne
  régresse.

#### Ce que P1 a effectivement changé

Le sink a d'abord fait **échouer nginx**, et c'est le risque que cette
phase avait annoncé : `ServicePortProjection` ouvrait le serveur puis
liait le port une seconde fois, se heurtait à son propre `EADDRINUSE`, et
son rattrapage refermait le serveur qu'elle venait d'ouvrir. Réparé
comme P1 le prévoyait — l'identité passe par `ServiceSocketServer.open()`
jusqu'au `listen()`, et la projection ne lie plus que ce que personne n'a
annoncé. Le doublon a disparu au lieu d'être toléré.

Deux écoutes réelles sont sorties de l'ombre, et l'inventaire de P0 ne
les avait pas vues parce qu'elles ne se manifestent qu'une fois le
croisement écrit :

- **RADIUS-over-TCP (RFC 6613)**, port 1812 : une écoute authentique,
  invisible dans `ss`, à côté de ses propres sockets UDP qui, eux, s'y
  affichaient. Elle porte désormais le nom de son démon.
- **Le stub de systemd-resolved en TCP**, `127.0.0.53:53` : l'inverse —
  la ligne existait, rien n'écoutait derrière. Traité en P2 plutôt que
  masqué, puisqu'un vrai résolveur répond bien en TCP quand la réponse
  ne tient pas dans un datagramme (RFC 7766).

Enfin, `scenario-listen-vs-filtered.test.ts` — la troisième des cinq
rencontres documentées au §3 — posait à la main les deux moitiés que P1
réunit. Son contournement a été retiré, pas contourné à son tour.

### P2 — Les entrées décoratives, une par une

Ce que P0 aura classé en (c). Pour chacune : soit lui donner une écoute
réelle, soit la retirer, soit — si un sous-système entier en dépend — la
laisser en l'écrivant, comme le listener TNS d'Oracle l'est aujourd'hui.

Le listener TNS est le cas décisif : lui donner une vraie boucle
d'acceptation suppose un serveur TNS, et c'est un chantier à part entière
qu'il faut nommer plutôt que de le trancher au passage.

- **Acceptation :** toute entrée `LISTEN` restante sans écoute réelle est
  justifiée par un commentaire au point de liaison.

#### P2a — fait

- **DNS 53/tcp et DoT 853** : les deux `socketTable.bind()` manuels sont
  partis. Leur propre commentaire disait qu'ils n'existaient que parce
  que `listen()` n'inscrivait rien ; il inscrit, avec le nom du démon.
  Première des cinq rencontres du §3 à disparaître pour de bon.
- **Windows 22, 445, 3389** : trois doublons d'un `listen()` situé
  quelques lignes plus bas dans le même fichier. Leur pid et leur nom de
  processus voyagent maintenant avec l'écoute.
- **Windows 139** : le cas décoratif pur. `ss` l'annonçait depuis
  toujours et rien ne répondait. Il sert désormais le même SMB que le
  445 et s'éteint avec le même `LanmanServer` — un port joignable qui
  parle le bon protocole vaut mieux qu'un port affiché qui ne parle
  rien. Ce que ce raccourci ne fait pas, écrit au point de liaison : le
  préambule NetBIOS (RFC 1002 §4.3), faute de couche NBSS ici et de
  client qui l'attendrait.

#### P2b — fait

- **sshd 22 (v4 et v6) et les ports de `sshd_config`.** L'amorçage était
  déjà traité : `attachSshTcpListeners()` ouvre les deux familles en
  portant pid, nom et bannière, et `findListener` sert désormais une
  connexion v6 par l'écoute `::` plutôt qu'en la rabattant sur le
  générique v4.

  Restait le **cycle de vie**, et c'est là que le doublon avait survécu :
  `rebindPorts` — appelé sur `start`, `reload` et `restart` — refaisait
  les deux `socketTable.bind()` manuels après avoir retiré à la main
  toutes les lignes de sshd. Le résultat affiché était juste, ce qui est
  précisément pourquoi rien ne le signalait ; mais le puits redevenait
  muet pour sshd — son `announce` se tait sur un port déjà lié — donc
  après le premier `systemctl restart ssh` la ligne de `ss`
  n'appartenait plus à l'écoute et lui survivait. Ouvrir et refermer
  l'écoute suffit : les deux boucles manuelles sont parties, `rebindPorts`
  n'appelle plus que `attachSshTcpListeners()` et l'arrêt que
  `detachSshTcpListeners()`.

  Mesuré plutôt que supposé, et la première mesure était fausse : quatre
  cas étendent le croisement au cycle (`stop`, `start`, changement de
  `Port` suivi d'un `reload`, et fermeture de l'écoute), mais les trois
  premiers passent des deux côtés du correctif — le résultat affiché
  était juste, c'est bien pour cela que rien ne le signalait. Seul le
  quatrième distingue, et seulement s'il **redémarre le démon d'abord** :
  sans redémarrage, `rebindPorts` ne s'exécute pas et la ligne posée à
  l'amorçage appartient à son écoute de toute façon. Avec le `bind()`
  manuel, `ss` gardait `0.0.0.0:22` après la fermeture de l'écoute
  correspondante ; sans lui, la ligne s'en va avec elle.
- **Le listener TNS d'Oracle (1521).** Traité en P2c : il écoute
  réellement dès l'amorçage.

### P3 — Le garde-fou

Un test qui échoue si une nouvelle divergence apparaît. Sans lui, P1 et P2
se déferont au premier ajout : c'est exactement ainsi que ce défaut est né
et s'est reproduit cinq fois.

### P4 — Une connexion, plusieurs vues : les files, les minuteries, le propriétaire

P1 à P3 ont rendu les *ports* cohérents ; elles laissaient chaque vue (`ss`, `netstat`, `/proc/net/*`, `lsof`,
`/proc/<pid>/fd`) tenir sa propre copie du reste d'une connexion : files, minuterie, `tcp_info`, uid, inode,
descripteur. Mesuré sur `origin/mandeng 75c5280d8` avec une connexion qui retenait 785 octets non lus, `ss`
imprimait `Recv-Q 0`, `-o`, `-e` et `-i` étaient acceptés sans effet, `/proc/net/tcp` donnait l'uid 0 à une
prise du résolveur, `netstat` imprimait la colonne `PID/Program name` sans `-p`.

Les vues lisent désormais une seule jointure, `KernelSocketRows` : la `SocketTable` dit qui tient la prise
(pid, uid, nom, descripteur), la pile dit ce que la prise est (files, minuterie, `tcp_info`). `ss` est un
portage d'iproute2 5.15, `netstat` un portage de net-tools 2.10 sur `/proc/net/*`, et les rendus de
`/proc/net/{tcp,tcp6,udp,udp6,udplite,raw,raw6,unix,sockstat,sockstat6}` suivent le noyau 5.15. Une prise sans
processus vivant derrière elle n'a pas de propriétaire affiché : le propriétaire est un fait de la table des
processus, pas une étiquette de la table des sockets : un service qui veut être nommé par `ss -p` doit avoir
un vrai processus (le listener TNS d'Oracle, qui écoute dès l'amorçage sans processus `tnslsnr`, n'est donc
pas nommé tant qu'aucun processus ne le tient). `probe-ss-netstat-proc-net-une-seule-verite` est le garde-fou
de ce croisement.

### P5 — Une session SSH est des processus, des deux côtés

P4 posait qu'une prise n'a de propriétaire que si un processus vivant la tient. Il restait à donner de vrais
processus aux sessions SSH et à les faire mourir avec leur connexion. Mesuré sur `origin/mandeng 608f58462` :

- **Serveur.** Après `ssh user@h true`, après une session interactive nourrie sur l'entrée standard et après
  une session de terminal fermée par `exit`, `ps` listait toujours `sshd: user [priv]` et `-bash` (quatre paires
  après quatre commandes, chacune sur un `pts/N` de plus) alors que `who`, `w` et `loginctl` disaient que
  personne n'était connecté : `closeSshSessionRecord` appelait `reap`, qui ne retire qu'un zombie. Et il fermait
  « le plus ancien enregistrement de `(utilisateur, adresse)` » : la fin d'une commande depuis le même poste
  fermait donc le tunnel `ssh -f -N -L` ouvert avant elle.
- **Client.** Un `ssh` tapé dans un terminal ne laissait aucun processus : la connexion vers le port 22 et les
  écoutes `-L`/`-D` n'avaient pas de propriétaire pour `ss -p` ou `lsof`, et il n'y avait rien à tuer. Le
  terminal avait sa propre grammaire de `-L`/`-R`/`-D` (l'adresse de liaison était lue puis jetée) et sa propre
  orchestration des écoutes, en double de celles du chemin `executeCommand`.

Désormais l'enregistrement de session porte le port source de *sa* connexion : il le prend en réclamant la prise
acceptée que nul enregistrement ouvert ne tient, se ferme par ce port (`connectionClosed` reçoit le port de la
connexion qui se ferme) et fait alors sortir le shell puis le moniteur ; le faucheur de prises retire une ligne
de connexion par son quadruplet. Côté client, le `ssh` d'un terminal est un processus enfant du shell de ce
terminal, sur son tty, qui adopte la session ; ses redirections passent par la `SshForwardingTable` de la
machine (une seule orchestration) sur la grammaire de `SshPortForward` (une seule grammaire). Sa fin, qu'elle
vienne d'un `exit`, d'un raccrochage ou d'un `kill`, retire le processus, ferme les écoutes et raccroche la
connexion. Garde-fous : `probe-les-processus-de-session-sshd-suivent-leur-connexion` et
`probe-le-ssh-du-terminal-est-un-processus`.

Un processus qui sort ferme ses prises comme le fait `tcp_close()` du noyau 5.15 (`__tcp_close`, source lue) : un
FIN si rien n'attendait d'être lu, un RST s'il restait des octets reçus et non lus (RFC 9293 §3.6.1 SHLD-3, RFC 2525
§2.17), rien pour une connexion pas encore ouverte (§3.10.4) ; une prise en TIME-WAIT, qui n'appartient plus à
personne, survit à son ancien propriétaire avec sa ligne dans `ss`. Mesuré avant : un `kill` propre laissait le pair
en ESTAB sans fin (la prise locale disparaissait, aucune trame ne partait). Le faucheur de prises de `LinuxMachine`
ferme d'abord les prises du processus, retire la ligne d'une prise disparue, et ne fait que retirer le propriétaire
d'une prise qui survit ; l'application de la prise est prévenue de sa fermeture, une seule fois, dès la sortie du
processus. Garde-fou : `probe-un-processus-qui-sort-ferme-ses-prises-comme-tcp-close`.

Une session s'arrête avec ses processus, par un seul chemin (`LinuxMachine.endSshSession`) : la sortie ordinaire,
`loginctl terminate-session` / `kill-session` / `terminate-user` (systemd 249, `man/loginctl.xml` : « kills all
processes of the session and deallocates all resources attached to the session ») et la sortie du moniteur ou du
shell qu'il porte, que ce soit `kill`, `pkill` ou une sortie. Mesuré avant : tuer le shell laissait `who`,
`loginctl`, la connexion et le tunnel du client intacts, sans ligne `Removed session` ; l'action de `loginctl`
existait en deux exemplaires, celle de la machine et celle de l'exécuteur (le chemin de `sudo loginctl`), qui ne
retirait ni le nœud `pts`, ni la session logind, ni les lignes du journal ; seule la sortie du processus `ssh` du
client fermait la connexion, jamais l'inverse. La correspondance identifiant → session n'est plus écrite qu'une fois
(`loginctlSessionId`), l'exécuteur reçoit l'action de la machine, et une connexion perdue retire les redirections de
la session et fait sortir le processus `ssh` qui la tenait (`SshSession.onDisconnected`). Garde-fou :
`probe-tuer-le-processus-de-session-termine-la-session`.

Pas construit : l'enfant sans privilège `sshd: user@pts/0`, qui tient la connexion avec le moniteur dans un vrai
Linux ; une session sans terminal prend encore un numéro de `pts` ; un `ssh` tapé dans une session distante déjà
ouverte n'a pas de processus ; un moniteur tué par SIGKILL écrit la même ligne PAM de fermeture qu'un SIGTERM,
alors qu'un vrai sshd, qui ne s'exécute plus, n'en écrit aucune ; une session telnet n'a pas de processus propre
(elle porte le pid de telnetd) et finit avec sa connexion.

### P6 — Les machines Windows disent la même chose

Tout ce que P2 à P5 posent pour Linux vaut pour un `WindowsPC`, qui n'en tenait presque rien. Mesuré sur
`origin/mandeng 5df140bb3`, un LinuxPC et un WindowsPC câblés :

- **Les connexions n'existaient pas pour `netstat -ano` ni pour `Get-NetTCPConnection`.** Les deux lisent la
  `SocketTable` (une seule vérité, et c'est bien), mais la pile du WindowsPC n'y projetait que les écoutes : une
  connexion acceptée par `sshd.exe` (PID 1088) était dans la pile (`22->10.0.0.3:32768 established owner=null`) et
  nulle part ailleurs.
- **Une connexion acceptée n'avait pas de propriétaire**, ni sur Windows ni, pour tout service autre que sshd et
  telnetd, sur Linux : `ss -tnp` n'affichait pas de colonne `users:` et `kill` du démon laissait la connexion
  ESTAB des deux côtés.
- **Le faucheur de prises de Windows** appelait `abortSocketsOwnedBy`, un `_teardown` silencieux, puis retirait
  toute ligne portant la même adresse locale ou le même nom d'image : `taskkill /F /PID 1088` laissait la
  connexion ouverte chez le pair et pouvait emporter les lignes d'autres connexions ou d'autres instances de
  `svchost.exe`. L'arrêt d'un service retirait son processus de la table sans événement.
- **`ssh` lancé depuis le poste Windows** écrivait à la main une ligne TIME_WAIT (`10.0.0.7:55579`) que ni la pile
  ni le serveur ne connaissaient : le serveur avait vu le port 49153.

Désormais une prise acceptée appartient au processus qui tient l'écoute, comme le descripteur que rend `accept`
(`accept(2)` : « creates a new connected socket, and returns a new file descriptor » ; Winsock : « creates and
returns a handle to the new socket »), pour tous les services des deux plates-formes ; la pile du WindowsPC projette
ses connexions dans la table avec la même `TcpSocketStateProjection` que Linux (déplacée dans `tcp/`) ; et un
processus Windows qui s'arrête ferme les prises qu'il tient (`closeSocketsOwnedBy`, politique de sortie `reset`
pour une terminaison forcée -- `taskkill /F`, `Stop-Process`, TerminateProcess ; `graceful` sinon -- l'arrêt d'un
service) selon la documentation Microsoft : `ExitProcess` ferme les poignées du processus, `closesocket` sans
SO_LINGER est une fermeture ordinaire, et WSAECONNRESET « normally results if the peer application on the remote
host is suddenly stopped ». Ce qui reste en TIME_WAIT n'a plus de propriétaire (PID 0). Gardes-fous :
`probe-une-prise-acceptee-appartient-au-processus-qui-tient-l-ecoute` et
`probe-windows-un-processus-termine-ferme-ses-connexions`.

Les écoutes d'un service Windows sont de vraies écoutes de la pile et suivent le service (mesuré sur `15f994d0d`) :
`sc stop sshd` retirait la ligne 22 de `netstat -ano` et laissait l'écoute, si bien que `nc` y réussissait et que
`ssh` obtenait « Permission denied » d'un serveur arrêté ; la reprise après `taskkill /F` avec `sc failure ...
restart/` relançait `sshd.exe` sous un nouveau PID pendant que `netstat` affichait l'ancien (1088) d'une table
codée en dur, pour une pile qui n'écoutait plus ; un démarrage de la machine écrivait l'état des services sans
événement ni effet sur les processus ; un service hébergé par un svchost qui s'arrêtait puis redémarrait sortait de
`tasklist /svc`. Le gestionnaire de services porte maintenant l'effet sur le processus (`ServiceProcessHost`) avant
d'annoncer, par une seule fonction pour le démarrage, l'arrêt, la reprise après incident et le démarrage de la
machine -- les sept appels manuels à `onServiceStarted`/`onServiceStopped` (`sc`, `net`, `Start-Service`,
`Stop-Service`, `Restart-Service`, le tour d'horloge) disparaissent -- et `WindowsServicePortProjection` tient des
déclarations d'écoute (ports, propriétaire, prédicat d'activité) qu'il rapproche de l'état courant à chaque
événement de service et à la construction. Le propriétaire est lu dans la table des processus au moment de
l'ouverture : le processus qui héberge le service (`sshd.exe`), ou `System` (PID 4) pour 445 et 139, tenus par le
noyau. Garde-fou : `probe-un-service-windows-n-ecoute-que-tant-qu-il-tourne`.

Un port que sa fonctionnalité ne sert pas est refusé, et un port servi appartient au processus qui le sert (mesuré
sur `ce9f180db`) : à la construction d'un WindowsPC ou d'un WindowsServer neuf -- RDP désactivé, ni domaine ni rôle --
`nc` réussissait sur 3389, 5985, 389, 3268, 636, 3269, 88, 5722, 8530 et 515 et `netstat -ano` les listait tous en
`LISTENING`, neuf avec le PID 0 et 3389 avec le PID 1096 que `tasklist` ne connaissait pas. Les dix écoutes étaient
ouvertes par `initDefaultSockets` et chacune vérifiait sa fonctionnalité à l'acceptation, pour fermer la prise une fois
la poignée de main faite : un `Test-NetConnection` ou un `nmap` y voyait un port ouvert là où un Windows réel répond
par un refus, et un poste client portait les ports d'un contrôleur de domaine, de DFSR, de WSUS et d'un serveur
d'impression, des rôles qu'il ne peut pas installer. Elles sont maintenant des déclarations de
`WindowsServicePortProjection` (3389 quand RDP est activé, 5985 quand WinRM est configuré, 389/3268/636/3269 et 88
sur un contrôleur de domaine, 5722, 8530 et 515 quand le rôle correspondant est installé, 135 tant que `RpcSs` tourne),
rapprochées de l'état à chaque événement de service, à chaque écriture du registre (quel qu'en soit le chemin :
`reg add`, `Set-ItemProperty`, stratégie de groupe), à chaque changement de `WindowsWinRmConfig`, au cycle de vie des
rôles et à la promotion d'un contrôleur de domaine. RDP n'a plus qu'un interrupteur, la valeur de registre
`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections` (Microsoft Learn : 1 bloque toutes les
connexions, 0 les autorise), semée à 1 comme une installation neuve : `Enable-RemoteDesktop` l'écrit au lieu de
basculer un champ que le registre ne voyait pas, et une valeur ou une clé absente ferme RDP. Le propriétaire est lu
dans la table des processus : `lsass.exe` pour LDAP et le KDC, `System` (PID 4, HTTP.sys) pour WinRM et WSUS, l'hôte
de `RpcSs` pour 135, de `TermService` pour RDP, de `DFSR` pour 5722, du spouleur pour 515. `TermService` entre dans le
gestionnaire de services et un svchost (PID 1096) l'héberge, si bien que le PID de RDP existe enfin dans `tasklist` ;
`winrm quickconfig` démarre le service `WinRM` comme il l'annonce. Garde-fou :
`probe-un-port-windows-n-existe-que-si-sa-fonctionnalite-est-active`.

Un service de rôle tourne dans le processus où Windows le fait tourner (mesuré sur `2d36ab993`) :
`Install-WindowsFeature AD-Domain-Services` créait trois processus `ntds.exe`, `netlogon.exe` et `kdc.exe` là où NTDS, Netlogon
et Kdc ont `lsass.exe` pour chemin binaire ; DHCP, NPAS et Web-Server créaient `dhcpserver.exe`, `ias.exe` et `w3svc.exe`, des
processus nommés d'après le service, là où ils tournent dans un svchost (`svchost.exe -k iissvcs` pour W3SVC) ; `sc create MySvc
binPath= "C:\tools\agent.exe"` puis `sc start` lançait `mysvc.exe` ; `tasklist` listait `LanmanServer.exe` et
`LanmanWorkstation.exe`, des images qui n'existent pas ; il n'y avait pas de service IP Helper ; les services Exchange portaient
des noms de processus tirés de leur nom de service. Le processus d'un service est maintenant l'image que nomme son chemin
binaire (`serviceImageOf`), le type du service (`WIN32_OWN_PROCESS` ou `WIN32_SHARE_PROCESS`) en découle, `lsass.exe` et
`svchost.exe` sont des hôtes partagés qui ne meurent pas avec un de leurs services (un svchost créé pour un rôle sort avec lui),
la table des fonctionnalités porte l'image des services de rôle, chaque service Exchange a son image, et le 4688 d'un processus
de service enregistre le chemin binaire que `sc qc` affiche. Garde-fou :
`probe-un-service-de-role-tourne-dans-le-processus-ou-windows-le-fait-tourner`.

Pas construit dans ce lot : les écoutes que les rôles DNS, IIS, DHCP, NPS, Exchange et cluster ouvrent par leurs
propres sous-systèmes (TCP et UDP) et les sockets UDP du système (LLMNR, mDNS, client DHCP, client DNS) gardent le
PID 0 ; le port 135 d'une machine qui n'est pas contrôleur de domaine accepte puis ferme (le mappeur RPC n'existe pas) ;
`TermService` est affiché Automatic quand un Windows réel le dit Manual ; un service qui n'a jamais eu de processus
d'hébergement n'en reçoit pas en démarrant ; le processus par session d'OpenSSH pour Windows, le `ssh.exe` client comme
processus et `ssh -N` vers ou depuis Windows sont traités après.

## 7. Hors périmètre

- **UDP.** Même structure (`udpBindAddress` vs table), mais un socket UDP
  n'a pas d'état `LISTEN` et se diagnostique autrement. À traiter ensuite
  si P1 se passe bien.
- **Windows.** Traité en P6 pour les connexions, leur propriétaire, la
  mort d'un processus et les écoutes des services ;
  `PortProxySocketProjection` a encore la forme que P2 a retirée à Linux.
- **Le listener TNS d'Oracle.** Nommé en P2, traité ailleurs.

## 8. Vérification

Comme les précédents : tests unitaires sur le comportement observable plus
un équivalent e2e. Le test de croisement de P0 est le cœur — il doit
échouer si l'on retire P1, et rester le garde-fou de P3.
