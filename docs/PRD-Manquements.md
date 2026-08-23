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

### §M4 — apache2 et le verrou PEM (C4, C3)

#### Ce que la mesure a trouvé, et qui est pire que prévu

`openssl` **n'existe pas comme commande**. Ce n'est pas « le sous-mode
`req` manque » : il n'y a aucun fichier de commande, aucun `case`,
rien. Le seul endroit du dépôt qui en parle est
`PackageDatabase.ts`, où le paquet est déclaré `installed: true`.

Une machine affirme donc, par `dpkg -l` et `apt list --installed`,
qu'elle a un outil dont le binaire n'existe pas. C'est **la même
famille de défaut** que celle qui a motivé tout ce chantier — un fait
affiché que rien ne soutient —, appliquée cette fois à un paquet plutôt
qu'à un port, et c'est la cinquième fois qu'elle se présente.

#### Le verrou est levable, et la clé existe déjà

`src/network/pki/` porte de vrais objets : `PkiKeyPair.generate()`,
`generateSelfSignedCertificate()` (qui rend un couple certificat +
clé privée), `CertificateAuthority`, `CertificateVerifier`. Ce qui
manque n'est ni la cryptographie ni le format X.509 — c'est qu'un
certificat ne sait pas devenir un **fichier**. Aucun `toPem`/`fromPem`
n'existe nulle part.

C'est donc là qu'est le verrou, et il tient en un module : une armure
PEM réelle (`-----BEGIN CERTIFICATE-----`) autour d'une charge
simulée, exactement la convention que ce répertoire énonce déjà
(« simulated crypto, real protocol shape »). Le codec doit savoir
**relire** ce qu'il écrit, sans quoi le fichier ne sert à rien.

Une fois posé, il sert bien au-delà de nginx : `curl --cacert`, les
clés d'hôte sshd, les rôles Windows, et tout TP qui commence par
« générez-vous un certificat ».

- **§M4a — apache2.** `LinuxNginxService` est déjà un
  `ServiceSocketServer` complet ; apache2 en veut un du même genre,
  servant `/var/www/html`, lisant `Listen` dans `ports.conf`, et
  refusant de démarrer si nginx tient déjà le port — le conflit que
  tout TP Linux rencontre.
- **§M4b — le codec PEM**, puis la commande `openssl` (`req -x509`,
  `genrsa`, `x509 -in -noout -text/-subject/-dates`), puis
  `ssl_certificate`/`ssl_certificate_key` côté nginx.

- **Acceptation :** `openssl req -x509 -newkey rsa:2048 -keyout k.pem
  -out c.pem -subj /CN=…` écrit deux fichiers que `openssl x509 -in
  c.pem -noout -subject` relit, et que nginx sert en HTTPS ; `dpkg -l
  openssl` ne ment plus.

#### Résultat mesuré — §M4b, livré

`src/network/pki/pem.ts` lève le verrou (armure RFC 7468 réelle, 64
colonnes, charge JSON plutôt que DER — la signature étant simulée, un
DER exact ne serait de toute façon pas vérifiable par un vrai openssl).
`openssl` existe : `version`, `dgst` + alias, `enc`, `rand`, `base64`,
`passwd`, `genrsa`, `rsa`, `pkey`, `req`, `x509`, `verify`, `ca`, `crl`,
`ciphers`, `info`, `list`, `errstr`, `prime`, `ec`, `ecparam`, `pkcs8`,
`pkeyutl`, `rsautl`, `rehash`, `s_client`. Le contrat qui compte est
tenu : `sha256sum f` et `openssl dgst -sha256 f` rendent la MÊME
empreinte, parce qu'ils appellent le même moteur.

Deux limites honnêtes, écrites là où elles s'appliquent plutôt qu'ici :
`enc` **refuse** la sortie binaire brute vers un fichier en disant
pourquoi (le VFS stocke des chaînes UTF-8 ; des octets arbitraires
seraient remplacés à la lecture et le déchiffrement rendrait autre
chose, silencieusement) — `-a`, une option du vrai openssl, la lève ; et
**3DES est absent**, le §8.3 du PRD OpenSSL se trompant en l'annonçant
réel : `des.ts` exporte `desCbcEncrypt` et aucun `desCbcDecrypt`, donc
`enc -des-ede3-cbc` chiffrerait sans pouvoir déchiffrer.

Reste ouvert : `ssl_certificate`/`ssl_certificate_key` côté nginx
(`PRD-Nginx` §P5) — plus bloqué par le PEM, seulement pas encore câblé.

#### Résultat mesuré — §M4a, livré

apache2 écoute vraiment. `src/network/devices/linux/http/` est
désormais découpé par serveur (`apache/`, `nginx/`), chacun portant ses
fichiers de distribution, son analyseur et son `ServiceSocketServer` ;
aucun moteur HTTP neuf, les deux sont posés sur `Http1ServerSession`.
Le conflit du port 80 marche **dans les deux sens**, chacun avec ses
propres mots. `apachectl`/`apache2ctl` est un `LinuxCommand` unique
(les deux noms sont le même fichier chez Debian) qui LIT la machine :
`-M` suit `mods-enabled/`, `-S` suit les hôtes virtuels du disque,
`configtest` et le démon jugent le même fichier de la même façon.

Un écart assumé et un message qui n'est pas d'Apache, tous deux écrits
dans le code : `apachectl start|stop|restart|graceful` passe **par** le
gestionnaire de services, là où le vrai Ubuntu démarre httpd dans le dos
de systemd (reproduire cette incohérence apprendrait surtout à se méfier
du simulateur) ; et un `<VirtualHost *:8080>` sans `Listen 8080`
correspondant reçoit une note préfixée `NOTE:` — le vrai Apache se tait,
démarre, ne sert rien sur ce port et laisse chercher.

Trouvé en écrivant les tests, et corrigé : `envvars` n'était pas semé,
donc `CustomLog ${APACHE_LOG_DIR}/access.log` désignait un répertoire
nommé littéralement `${APACHE_LOG_DIR}` et aucune requête n'était
journalisée là où un opérateur la cherche. Corrigé aussi, mesuré au
passage : `/usr/sbin/nginx` n'était semé nulle part, si bien que le
garde « binaire supprimé » du §F7.7 aurait refusé `nginx -t` sur un
fichier que personne n'avait supprimé.

Un test préexistant prenait apache2 comme EXEMPLE d'un service qui
démarre sans rien ouvrir (`nginx-prd-p0-p2`) ; la règle qu'il protège
est intacte, c'est mysql qui l'illustre maintenant.

### §M5 — Windows (C2) et curl P4 (C5)

Répliqués sur le motif éprouvé par §M1-§M2, une fois celui-ci vert.
curl P4 est une famille d'options, pas un défaut de cohérence : elle ne
ment sur rien aujourd'hui (`is not implemented in this simulator`), donc
elle passe en dernier.

### §M6 — `isc-dhcp-server` : une machine Linux SERT le DHCP

`new DHCPServer` n'était instancié que par `Router`, `Switch`, le rôle
Windows et le pare-feu : un `LinuxServer` n'avait ni `dhcpd`, ni
`/etc/dhcp/dhcpd.conf`, ni unité. Le manquement était mesuré — le cas
« serveur générique (Linux) » de `routeur-adresse-par-dhcp.test.ts`
avait dû être remplacé par un commutateur de niveau 3.

Le moteur d'attribution n'est PAS réécrit : c'est le même `DHCPServer`
et le même `buildDhcpServerReply` que les quatre autres, comme nginx et
apache2 se sont posés sur `Http1ServerSession`. Ce qui est écrit, c'est
l'enveloppe Debian — les fichiers du paquet, l'analyseur de
`dhcpd.conf`, l'unité, le binaire, le fichier de baux.

Trois faits d'ISC portent la valeur pédagogique, et chacun est
observable plutôt que décoratif :

1. **Le `dhcpd.conf` livré par Debian n'a AUCUNE déclaration de
   sous-réseau**, si bien qu'un `systemctl start` sur une machine
   fraîche échoue — c'est la première expérience de tout le monde avec
   ce démon. Le refus nomme l'interface, son adresse, et ce qu'il faut
   écrire (`No subnet declaration for eth0 (…)` … `Not configured to
   listen on any interfaces!`).
2. **`dhcpd -t` ne teste QUE la syntaxe.** Une configuration sans
   sous-réseau la passe. La vérification d'interface appartient au
   démarrage, donc au `registerConfigCheck` de l'unité — deux questions
   distinctes, deux réponses distinctes, comme sur la vraie machine.
3. **Une plage est ce que le serveur sert, et rien d'autre.** Le moteur
   attribue tout le sous-réseau sauf exclusion : `restrictToRanges`
   exclut donc le complément des `range` déclarées, plutôt que
   d'énumérer les plages. Sans `range`, un sous-réseau est déclaré et ne
   distribue rien — ce qui est légal et courant (il n'est là que pour
   que l'interface soit servable).

Le fichier de baux est celui de `dhcpd.leases(5)` — `starts`/`ends` en
UTC précédés du jour de la semaine, `binding state active`,
`hardware ethernet`, `client-hostname` — et `dhcp-lease-list` le relit.
Deux vues d'un seul fait.

**Ce qui n'est pas attesté est dit** : la LIGNE que le vrai ISC désigne
quand un point-virgule manque n'a pas pu être vérifiée (le message est
`<fichier> line <n>: semicolon expected.`, mais rien ne dit si `n` est
la ligne de l'instruction inachevée ou celle du jeton qui a surpris
l'analyseur). Ce simulateur désigne l'instruction inachevée, qui est la
ligne que l'opérateur doit corriger. Hors périmètre et non simulé :
`omapi`, DHCPv6 (`dhcpd -6`), `failover peer`, les classes et
sous-classes, et l'évaluation d'expressions (`if`/`match`).

### §M7 — la sonde d'avant-offre, et les trois defauts des trois vendeurs

Un serveur DHCP ne doit pas offrir une adresse qu'une machine tient deja
en statique. La mesure de depart, faite sur les trois serveurs dans le
meme laboratoire, a corrige la premisse : **le routeur Cisco le faisait
deja** (`isCandidateAddressInUse`, une vraie requete ARP relue dans la
table), et seuls Windows et Linux distribuaient l'adresse squattee. Le
premier laboratoire ne discriminait rien — sa plage couvrait tout le
sous-reseau, donc le serveur servait `.2` sans jamais avoir a considerer
l'adresse tenue ; il a fallu exclure `.1`-`.9` pour que la question soit
posee.

**Le defaut par vendeur est un FAIT, pas un reglage uniforme**, et c'est
la seule chose qu'il ne fallait pas rater :

| | Reglage | Defaut reel | Ce que fait ce simulateur |
|---|---|---|---|
| IOS | `ip dhcp ping packets` | **2** (actif) | inchange, deja conforme |
| Windows | `Set-DhcpServerSetting -ConflictDetectionAttempts` | **0** (eteint) | eteint, 1..6 accepte, au-dela refuse |
| ISC | `ping-check` | **actif** (atteste, cf. ci-dessous) | actif ; `ping-check false;` l'eteint |

Uniformiser aurait ete plus simple et faux : un Windows qui refuserait
l'adresse squattee sans qu'on ait rien regle enseignerait un comportement
que la vraie machine n'a pas, et c'est justement ce que le controle
`ConflictDetectionAttempts` existe pour rendre visible.

**Une seule implementation de la sonde** : `arp/AddressProbe.ts`. Il y
avait trois constructions de requete ARP dans le depot (deux dans
`EndHost`, une dans `Router`) ; la sonde etait la quatrieme a ecrire.
`Router.isCandidateAddressInUse` delegue desormais, et
`EndHost.addressAnswersOnLink` est la meme fonction vue depuis un hote,
ce qui donne la sonde aux deux serveurs qui ne l'avaient pas.

**Le defaut de `ping-check` est desormais atteste, et il etait pris a
l'envers.** Il avait ete pose **eteint**, faute de source lisible, en
raisonnant sur le fait que le `dhcpd.conf` livre par Debian ne contient
pas la directive et que les guides d'administration l'ecrivent
explicitement. Les deux observations sont vraies et la conclusion etait
fausse. Le code d'ISC tranche : `do_ping_check()` (`server/dhcp.c`)
n'abandonne le controle que si l'option EXISTE et vaut faux
(`if (oc && !evaluate_boolean_option_cache(...)) return (0);`), donc une
option ABSENTE laisse le ping partir ; et `server/dhcpd.conf.5` decrit le
parametre dans ce sens — « if its value is false, no ping check is done ».
Le parametre existe pour ETEINDRE le controle. Le defaut est passe a
**actif**. Le message
`Abandoning IP address <ip>: pinged before offer`, lui, est atteste par
plusieurs archives de la liste `dhcp-users`. Et la sonde est un **ARP**
la ou les trois vendeurs envoient un **ICMP Echo** — inscrit au TODO
avec sa consequence observable plutot que passe sous silence.

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
