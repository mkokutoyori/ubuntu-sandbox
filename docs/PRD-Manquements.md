# PRD — les manquements de notre propre travail

## 1. Pourquoi ce document

`PRD-Curl`, `PRD-Nginx` et `PRD-Sockets-Une-Seule-Verite` ont chacun
livré ce qu'ils annonçaient, et chacun a laissé derrière lui des limites
écrites honnêtement dans le code ou dans son §7. Ce document les
rassemble, les vérifie une par une, et les traite.

Une limite écrite reste une limite. Elle vaut mieux qu'un mensonge
silencieux — c'est la règle de ce projet — mais elle ne vaut pas une
fonctionnalité. Le but ici est de faire passer chacune de « déclarée »
à « faite », ou de dire pourquoi elle ne peut pas l'être et ce qu'il
faudrait pour cela.

**Rien n'est repris de mémoire.** Chaque manquement ci-dessous a été
reproduit avant d'être décrit, et le constat est écrit à côté.

## 2. Principes hérités

Ceux des PRD précédents, qui ne changent pas :

- **P1 — Une seule vérité par fait.** Deux vues d'une même machine ne
  doivent pas pouvoir se contredire.
- **P2 — Ce qui est affiché doit être joignable, ce qui répond doit
  être affiché.**
- **P3 — Une commande refuse plutôt que de faire semblant.** Un message
  honnête vaut mieux qu'un résultat inventé.
- **P4 — Mesurer avant de corriger.** Un correctif dont on n'a pas vu
  le défaut tomber n'est pas un correctif.

## 3. Inventaire des manquements

Chacun est classé par ce qu'il coûte à l'apprenant, pas par sa taille.

### Famille A — une machine se contredit elle-même

| # | Manquement | Constat mesuré |
|---|---|---|
| A1 | **Listener TNS décoratif à l'amorçage** | `ss` montre `:1521`, `lsnrctl status` dit « démarré », `ps` montre un vrai `tnslsnr` — et `nc` depuis une autre machine reçoit `Connection refused`. Le port ne devient joignable qu'APRÈS une commande Oracle tapée **sur la console du serveur**. |
| A2 | **Doublon manuel dans `OracleListenerNetworkBinding`** | 17ᵉ `socketTable.bind()` manuel, absent de l'inventaire §P0 parce qu'il vit sous `src/database/`, pas `src/network/`. |
| A3 | **`:::1521` sans écoute propre** | Même asymétrie IPv6 que sshd avant §P2b : la ligne v6 existait, l'écoute non. |
| A4 | **`DECOR_CONNU` périmé** | Le garde-fou autorise encore le 139 comme « décoratif », alors que §P2a lui a donné une vraie écoute. Il accepterait donc silencieusement une régression. |

### Famille B — le garde-fou ne garde pas tout

| # | Manquement | Constat mesuré |
|---|---|---|
| B1 | **`WindowsServer` hors du croisement** | Le test croise `LinuxServer`, `LinuxPC`, `WindowsPC`. C'est pourtant `WindowsServer` qui ouvre le plus d'écoutes (IIS, DNS, WSUS, LPD, Kerberos…). |
| B2 | **Services démarrés non croisés** | Seul nginx est vérifié après démarrage. dnsmasq, vsftpd, postfix, named ne le sont pas — mesurés sains, mais rien ne les retient. |
| B3 | **§P3 jamais écrit** | Le garde-fou que le PRD Sockets annonce comme sa dernière phase n'existe pas : rien n'échoue si une nouvelle divergence apparaît. |

### Famille C — limites déclarées des PRD précédents

| # | Manquement | Où c'est écrit |
|---|---|---|
| C1 | **UDP non traité** | `PRD-Sockets` §7. Même structure à deux tables ; un socket UDP n'a pas d'état `LISTEN` et se diagnostique autrement. |
| C2 | **Windows non unifié** | `PRD-Sockets` §7 : `WindowsServicePortProjection` et `PortProxySocketProjection` ont la même forme, à traiter après Linux. |
| C3 | **nginx sans HTTPS** | `PRD-Nginx` §P5, bloqué faute d'un chemin `openssl req` → PEM côté Linux. |
| C4 | **apache2 ne sert rien** | `systemctl start apache2` rend l'unité `active` et rien n'écoute. |
| C5 | **curl P4** | proxy, cookies, `--retry`, formulaires : refusés honnêtement, non implémentés. |

## 4. Phases

### §M1 — le listener TNS, réellement à l'écoute (A1, A2, A3)

**Ce que la mesure a montré, et qui change le diagnostic.** Le PRD
Sockets §P2 avait classé ce port en « à laisser, un vrai serveur TNS est
un chantier à part ». C'est faux, et c'est la mesure qui le dit :
`OracleListenerNetworkBinding.attach()` ouvre **déjà** une vraie écoute
(`stack.listen`, `onAccept` qui enregistre la sonde puis referme). Il ne
manquait pas un serveur TNS — il manquait un appel à l'amorçage.

La matérialisation est paresseuse : c'est `getOracleDatabase()`, déclenché
par la première commande Oracle locale, qui attache le binding. Exactement
la forme du défaut des rôles Windows corrigé par `PRD-Curl` §P2 (« install
the Web-Server role, `curl` from another machine, get `Connection
refused` »).

- `LinuxMachine.bindTnsListener()` ouvre à l'amorçage l'écoute que
  `dbstart`/systemd auraient posée — sur les **deux** familles, avec
  pid/processus/bannière portés par le `listen()`.
- `OracleListenerNetworkBinding.attach()` **reprend** le port (il ferme
  l'écoute en place avant d'ouvrir la sienne) : sans cela il lèverait
  `EADDRINUSE` et la base démarrerait sans jamais enregistrer ses sondes.
- Les quatre `socketTable.bind()` manuels du binding disparaissent :
  depuis §P1 l'identité voyage avec l'écoute.
- `detach()` ferme pour de bon — `lsnrctl stop` retire la ligne de `ss`
  au lieu de restaurer un décor.

- **Acceptation :** depuis une autre machine, `nc` sur 1521 réussit
  **avant** toute commande locale ; `lsnrctl stop` le fait échouer ; le
  croisement ne rend plus aucune entrée décorative sur aucune machine.

### §M2 — le garde-fou complet (A4, B1, B2, B3)

`DECOR_CONNU` devient vide, et c'est le point : après §M1 il ne reste
aucune entrée décorative à justifier. Une table vide qu'un test consulte
est un garde-fou ; une table pleine d'exceptions est une liste de
pardons.

- Le croisement couvre `WindowsServer` et les services démarrés.
- Le test échoue si une divergence apparaît **dans un sens ou dans
  l'autre**, sur n'importe quelle machine, sans liste d'exceptions.

- **Acceptation :** vérifié porteur par neutralisation — remettre une
  entrée décorative fait tomber le test.

#### §M1 — fait

Vérifié porteur par neutralisation : **5 des 7 cas tombent** quand
`bindTnsListener()` est débranché. Les 2 qui passent des deux côtés sont
exactement ceux qui touchent Oracle en local d'abord — c'est-à-dire le
seul chemin qui fonctionnait avant.

Trouvé en chemin, et corrigé dans la même passe : `detach()` restaurait
le décor qu'il venait de retirer, si bien qu'après `lsnrctl stop` le
port restait affiché sans rien derrière. Un listener arrêté n'est
désormais ni joignable ni affiché — le même fait, vu des deux côtés.

Le PRD Sockets §P2 se trompait sur ce point, et il faut l'écrire :
il avait classé ce port en « à laisser, un vrai serveur TNS est un
chantier à part ». C'était vrai de TNS, faux du port. La mesure a
départagé.

#### §M2 — fait

`DECOR_CONNU` est vide, et le reste : c'est désormais un cas de test à
part entière. `WindowsServer` entre au croisement, quatre services
démarrés de plus y entrent aussi, et §P3 énonce la règle plutôt que la
liste — écoute tardive, écoute sur adresse précise, cycle
ouverture/fermeture complet.

### §M3 — UDP (C1) — mesuré, et la prémisse était fausse

Le §3 de ce document annonçait « même structure à deux tables ». **C'est
faux**, et je l'avais écrit d'après la formulation du §7 de `PRD-Sockets`
plutôt que d'après le code. La mesure corrige :

- `EndHost.udpBind()` inscrit l'entrée de la `SocketTable` **et** pose le
  gestionnaire, en deux lignes voisines de la même fonction ;
  `udpClose()` retire les deux. Idem pour
  `udpBindAddress()`/`udpCloseAddress()`. Il n'y a pas de seconde table
  à faire diverger : **une seule fonction, une seule vérité**, par
  construction.
- L'ordre est bon, et ce n'est pas un hasard : `socketTable.bind()` est
  appelé **avant** le `set()` du gestionnaire, donc un `EADDRINUSE`
  échoue sans laisser de gestionnaire orphelin.
- La table statique des services ne déclare **qu'un seul** port UDP
  (`systemd-resolved` 53/udp), et il est réellement lié par
  `udpBindAddress()`. `WINDOWS_SERVICE_LISTENERS` n'en déclare **aucun**.

Il n'y avait donc rien à corriger ici, et le dire vaut mieux que
d'inventer un chantier. Ce qui reste utile, c'est le **garde-fou** : la
seule façon dont cette propriété peut se perdre est qu'on écrive un
`socketTable.bind('udp', …)` ailleurs que dans ces deux fonctions.

**Une asymétrie réelle, trouvée en mesurant, et non corrigée ici.**
`udpBind()` passe toujours `pid: undefined`, si bien que `ss -ulnp`
laisse la colonne PID vide pour tout socket UDP, alors que TCP la porte
depuis §P1. La corriger suppose de donner un pid à la vingtaine de
points de liaison UDP — et c'est exactement le piège que §P1 avait
relevé : `SocketTable.bind()` refuse avec `EMFILE` dès qu'un pid est
fourni et que le garde de descripteurs (§F9.3) dit non. Passer des pids
partout ferait donc entrer une vingtaine de services sous une contrainte
qu'ils ne subissaient pas. À traiter comme un chantier propre, avec sa
propre mesure, plutôt qu'en passant.

- **Acceptation :** un test échoue si une entrée UDP existe sans
  gestionnaire, ou l'inverse, sur chaque machine construite.

### §M4 — apache2 et nginx-HTTPS (C4, C3)

`LinuxNginxService` est déjà un `ServiceSocketServer` complet. apache2
n'a besoin de rien de neuf : il lui faut un serveur du même genre,
servant `/var/www/html` sur le 80, refusant de démarrer si nginx tient
déjà le port — le conflit que tout TP Linux rencontre.

HTTPS reste bloqué sur le même verrou qu'avant : aucun chemin
`openssl req` → PEM n'existe côté Linux. C'est ce verrou qu'il faut
lever, pas nginx qu'il faut contourner — et le lever sert aussi
`curl --cacert`, sshd et les rôles Windows. Traité seulement si §M1-§M3
laissent la place ; sinon nommé plutôt que bâclé.

### §M5 — Windows (C2) et curl P4 (C5)

Répliqués sur le motif éprouvé par §M1-§M2, une fois celui-ci vert.
curl P4 est une famille d'options, pas un défaut de cohérence : elle ne
ment sur rien aujourd'hui (`is not implemented in this simulator`), donc
elle passe en dernier.

## 5. Ordre, et pourquoi

A1 d'abord, parce que c'est le seul manquement de cette liste où une
machine **répond faux** à une question qu'un apprenant pose vraiment :
« le port est-il ouvert ? ». Les autres sont des absences.

B ensuite, parce que sans garde-fou A se défera.

C en dernier, parce que ces limites-là sont déjà dites à voix haute.

## 6. Vérification

Comme les précédents : unitaires sur le comportement observable,
équivalent e2e, discrimination par neutralisation ou `git stash`, et
régression complète avant de pousser — mesurée contre une baseline en
worktree, jamais contre un souvenir.
