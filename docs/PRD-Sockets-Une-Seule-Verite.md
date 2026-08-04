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

### P3 — Le garde-fou

Un test qui échoue si une nouvelle divergence apparaît. Sans lui, P1 et P2
se déferont au premier ajout : c'est exactement ainsi que ce défaut est né
et s'est reproduit cinq fois.

## 7. Hors périmètre

- **UDP.** Même structure (`udpBindAddress` vs table), mais un socket UDP
  n'a pas d'état `LISTEN` et se diagnostique autrement. À traiter ensuite
  si P1 se passe bien.
- **Windows.** `WindowsServicePortProjection` et
  `PortProxySocketProjection` ont la même forme et méritent le même
  traitement, mais après Linux : le motif doit être éprouvé une fois avant
  d'être répliqué.
- **Le listener TNS d'Oracle.** Nommé en P2, traité ailleurs.

## 8. Vérification

Comme les précédents : tests unitaires sur le comportement observable plus
un équivalent e2e. Le test de croisement de P0 est le cœur — il doit
échouer si l'on retire P1, et rester le garde-fou de P3.
