# PRD — `nginx`

## 1. Pourquoi ce document

`docs/PRD-Curl.md` s'est terminé sur un constat qu'il ne pouvait pas
traiter lui-même : `curl` est désormais un vrai client, mais **aucune
machine Linux de ce simulateur n'héberge de serveur web**. Le seul
serveur HTTP livré est `WindowsIisRole`, côté Windows.

Or le TP le plus courant d'un cours réseau est exactement celui-là :
installer nginx, servir une page, la récupérer depuis un autre poste,
casser quelque chose, diagnostiquer. Aujourd'hui la première moitié est
impossible.

Et le problème n'est pas une absence. **C'est une contradiction** : la
machine affirme deux choses incompatibles au même instant.

## 2. État des lieux, vérifié dans le code

### 2.1 Le défaut, localisé à la ligne près

Trois faits, chacun vérifié :

1. **L'unité existe et est fidèle.** `LinuxServiceManager.ts`,
   `SERVER_UNITS` : `nginx`, `Type=forking`,
   `ExecStart=/usr/sbin/nginx -g "daemon on; master_process on;"`,
   `ExecReload=/usr/sbin/nginx -s reload`, `User=www-data`,
   `After=network.target remote-fs.target`, ni activée ni démarrée par
   défaut. C'est le fichier unité de Debian, correct.

2. **Le processus est réel.** `LinuxServiceManager.activate()` (~l. 834)
   appelle `processMgr.spawn({ command, user, uid, gid, serviceName,
   vsize, rss })` et affecte `u.mainPid = proc.pid`. Après un
   `systemctl start nginx`, `ps aux` montre un vrai processus nginx avec
   un vrai PID, sous `www-data`, avec un profil mémoire
   (`serviceMemoryProfile`, 55000/4900 Kio).

3. **Le port est un décor.** `SERVICE_LISTENERS.nginx` déclare
   `sockets: [{port: 80}, {port: 443}]`. `ServicePortProjection` s'abonne
   à `linux.service.started` et appelle `socketTable.bind(...)` — la
   table que lisent `ss` et `netstat`. Son propre en-tête l'affirme :
   « so `systemctl start nginx` genuinely makes `:80` appear ». Mais
   `TcpStack` tient une table **séparée** (`TcpStack.listeners`,
   alimentée uniquement par `TcpStack.listen()`), et c'est elle, seule,
   qui décide d'accepter ou de refuser une connexion entrante.
   `ServicePortProjection` ne l'appelle jamais.

Résultat observable, une machine, une seconde :

```
$ sudo systemctl start nginx
$ systemctl is-active nginx
active
$ ps aux | grep nginx
www-data   812  0.0  0.4  55000  4900 ?  Ss  17:02  0:00 /usr/sbin/nginx -g daemon on; master_process on;
$ ss -ltn
State      Recv-Q  Send-Q   Local Address:Port     Peer Address:Port  Process
LISTEN     0       511            0.0.0.0:80            0.0.0.0:*
$ curl http://localhost/
curl: (7) Failed to connect to localhost port 80: Connection refused
```

Le service est actif, le processus tourne, le port est affiché — et la
connexion est refusée.

### 2.2 Pourquoi c'est pire qu'une absence

Un manque enseigne « ce n'est pas simulé ». Une contradiction enseigne
une **règle fausse**.

L'apprenant à qui l'on demande de diagnostiquer applique la méthode
qu'on lui a apprise : le service est-il actif ? oui. Le processus
tourne-t-il ? oui. Le port est-il ouvert ? `ss` dit oui. Donc le
problème est ailleurs — le réseau, le pare-feu, le client. Il cherchera
là où il n'y a rien, et il en conclura, sur une vraie machine, que ces
trois vérifications ne prouvent rien. C'est exactement l'inverse de ce
qu'elles valent en réalité.

C'est le sixième exemplaire du motif que ce projet corrige
systématiquement — `df`, `ulimit -u`, `ulimit -n`, `MemoryMax=`,
`curl -s`/`-v` — mais c'est le premier où **deux vues du simulateur se
contredisent** au lieu qu'une seule soit inerte.

### 2.3 Ce qui n'existe pas du tout

| Élément | État |
|---|---|
| `/etc/nginx/nginx.conf` | absent du VFS |
| `/etc/nginx/sites-available/default` | absent |
| `/etc/nginx/sites-enabled/` | absent |
| `/var/www/html/index.nginx-debian.html` | absent |
| `/var/log/nginx/{access,error}.log` | absents |
| la commande `nginx` (`-t`, `-s`, `-T`, `-v`) | absente |
| `/usr/sbin/nginx` dans `STANDARD_BIN_PATHS` | absent |
| nginx dans `CriticalFiles.ts` | absent |

Conséquence de la dernière ligne : `rm /etc/nginx/nginx.conf` n'a
aucun effet, alors que rendre ce genre de suppression réellement
cassante est tout l'objet de `docs/PRD-Pannes.md` §6.2.

### 2.4 Ce qui existe déjà et qu'il ne faut surtout pas réécrire

C'est ce qui détermine tout le découpage — **aucun moteur HTTP n'est à
écrire**.

| Brique | Où | Ce qu'elle donne |
|---|---|---|
| `Http1ServerSession` | `http/http1/` | serveur HTTP/1.1 RFC 9112, connexions persistantes, un seul `Http1RequestHandler` |
| `HttpsServerSession` | `http/https/` | le même sur TLS 1.3 réel |
| `Http1ClientSession` | `http/http1/` | le client, pour `proxy_pass` (P6) |
| `contentTypeForPath` | `http/HttpTypes.ts` | la table MIME |
| `createHttpToHttpsRedirectHandler` | `http/https/` | 308 écrit et testé, jamais branché en production |
| `registerConfigCheck(unit, fn)` | `LinuxServiceManager` | `start`/`restart`/`reload` refusent une config invalide ; déjà utilisé par `named`, `ssh`, `auditd`, `freeradius` |
| `CriticalFiles.ts` | `linux/service/` | `CriticalFile` / `CriticalFileSet` (`anyOf`/`onAllMissing`) |
| `WindowsIisRole` | `windows/server/iis/` | le patron exact : un rôle possédant des sites, chacun avec port, chemin, état, session |
| `FtpServer` | `network/ftp/` | le patron d'un serveur Linux `listen()`/`stop()` sur `TcpStack` |
| VFS symlinks | `VirtualFileSystem.ts` | `createSymlink`, type `'symlink'` — nécessaire pour `sites-enabled` |
| `LinuxLogManager.appendToLogFile` | `linux/` | l'écriture de journal, avec la gestion du fichier supprimé |
| `processMgr.spawn` | déjà appelé | le PID, l'utilisateur, le profil mémoire |

Deux briques manquent et sont signalées ici parce qu'elles pèsent sur
les phases tardives : **il n'existe pas de commande `openssl`** (bloque
P5) et **`logrotate` existe** (`STANDARD_BIN_PATHS`, `LinuxLogManager`,
`CriticalFiles`) donc P4 peut s'y raccrocher.

## 3. Principes

Les mêmes que `docs/PRD-Pannes.md` et `docs/PRD-Curl.md`.

- **P1 — Rien qui mente.** Une directive acceptée agit, ou elle est
  refusée. Un `nginx.conf` contenant une directive que ce simulateur
  n'applique pas doit le dire à `nginx -t`, pas l'avaler.
- **P2 — Les messages sont ceux de nginx, verbatim**, numéro de ligne
  compris : c'est ce qui rend `nginx -t` utilisable pédagogiquement.
- **P3 — La configuration est la source de vérité.** Ce que sert le
  serveur vient des fichiers, pas d'un état en mémoire que les fichiers
  décriraient. Même règle qu'`AccountDatabaseParser` a imposée pour
  `/etc/passwd`, et pour la même raison : sinon `vim
  /etc/nginx/sites-available/default` ne change rien.
- **P4 — Une seule vérité par fait.** `ss`, `systemctl is-active`, `ps`
  et une connexion réelle doivent s'accorder — **dans les deux sens**.
- **P5 — Le transport reste réel.** Le serveur écoute sur la vraie pile
  TCP de la machine ; une requête traverse les vrais câbles, les vraies
  ACL, et apparaît dans une capture `tcpdump` de transit.

## 4. Phases

### P0 — Supprimer la contradiction (prérequis, livrable seul)

Le plus petit changement qui fait qu'`ss` cesse de mentir. **Deux voies,
et le choix n'est pas neutre.**

**(a) Étendre `ServicePortProjection`** pour appeler `TcpStack.listen()`
en plus de `socketTable.bind()`. Générique, règle nginx, apache2, mysql
et postgresql d'un coup. Mais un listener sans gestionnaire **accepte**
la connexion puis ne répond rien : `curl` passerait de
`Connection refused` (immédiat, clair) à `Empty reply from server`, voire
à une attente. On remplacerait un mensonge par un autre, moins lisible.

**(b) Un service n'ouvre un listener que s'il fournit un gestionnaire —
et un service sans gestionnaire n'apparaît pas non plus dans `ss`.**

**(b) est retenue.** P4 vaut dans les deux sens : un port affiché doit
être joignable, et un port injoignable ne doit pas être affiché.
`SERVICE_LISTENERS` cesse d'être une table décorative pour devenir une
déclaration que quelque chose doit honorer.

Mécaniquement : `ServicePortSource` gagne la notion de « ce service
a-t-il un gestionnaire enregistré ? », alimentée par le même
`registerServiceListener` qui existe déjà pour les unités dynamiques.

- **Acceptation :** il n'existe aucun état de la machine où `ss` montre
  un port qu'une connexion ne peut pas atteindre, ni l'inverse.
- **Conséquence assumée, à dire explicitement** : `mysql` et
  `postgresql` quittent `ss` tant que personne ne leur écrit de
  gestionnaire. C'est une régression *apparente* et une correction
  *réelle* — ces ports n'ont jamais accepté la moindre connexion. Le
  test qui l'épingle doit dire pourquoi, sinon quelqu'un « réparera »
  la ligne dans six mois.
- **Portée hors nginx :** `apache2` bénéficie de P0 sans rien d'autre.

### P1 — nginx sert vraiment un fichier

- **`LinuxNginxService`**, calqué sur `WindowsIisRole` : il possède des
  *server blocks*, chacun avec `listen`, `root`, `index`, `server_name`,
  et son `Http1ServerSession` sur la pile TCP de la machine.
- **Fichiers semés au démarrage**, avec le contenu réel de Debian
  (`nginx-common` / `nginx-core`) :
  - `/etc/nginx/nginx.conf` (le fichier principal, avec ses
    `include /etc/nginx/conf.d/*.conf;` et
    `include /etc/nginx/sites-enabled/*;`)
  - `/etc/nginx/sites-available/default`
  - `/etc/nginx/sites-enabled/default` → **un vrai lien symbolique**,
    parce que `ln -s`/`rm` est la moitié du TP
  - `/var/www/html/index.nginx-debian.html` (la page « Welcome to
    nginx! » de Debian, pas une page inventée)
  - `/usr/sbin/nginx` dans `STANDARD_BIN_PATHS`, pour que `rm` dessus
    donne `bash: /usr/sbin/nginx: No such file or directory` (§F7.7)
- **Cycle de vie** : `start` lit la configuration et ouvre les listeners
  qu'elle déclare ; `stop` les ferme ; `reload` relit **sans couper les
  connexions établies**, ce que `-s reload` fait réellement.
- **Réponses** : 200 avec `Server: nginx/1.24.0` et le `Content-Type`
  de `contentTypeForPath` ; 404 avec la page d'erreur de nginx ; 403 sur
  un répertoire sans `index` ni `autoindex`.
- **Acceptation :** `curl http://<ip>/` depuis un autre poste rend
  `index.nginx-debian.html`, et les compteurs de trames du câble
  intermédiaire ont bougé.

### P2 — La configuration est la source de vérité

C'est le cœur, et la phase la plus longue.

**Analyseur** : blocs `http {}` / `server {}` / `location {}`,
directives terminées par `;`, `include` (avec glob), commentaires `#`,
chaînes entre guillemets.

**Directives honorées** — chacune doit avoir un effet observable :

| Directive | Effet |
|---|---|
| `listen` | port, `default_server`, `ssl` (P5) |
| `server_name` | routage par en-tête `Host` |
| `root` | racine servie |
| `index` | fichier par défaut d'un répertoire |
| `try_files` | forme simple `$uri $uri/ =404` |
| `return` | `return 301 https://…`, `return 404` |
| `error_page` | page d'erreur personnalisée |
| `autoindex` | listing de répertoire |
| `access_log` / `error_log` | chemin des journaux (P4) |
| `worker_processes` / `worker_connections` | **acceptées sans effet** — voir §5 |

**`nginx -t`** — c'est la commande qui donne sa valeur pédagogique à
toute la phase, donc ses messages sont non négociables :

```
$ nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

```
$ nginx -t
nginx: [emerg] unexpected "}" in /etc/nginx/sites-enabled/default:34
nginx: configuration file /etc/nginx/nginx.conf test failed
```

Code 0 / code 1. Le **numéro de ligne et le fichier réel** (celui de
l'`include`, pas le principal) sont ce qui rend la commande utilisable.

**Branchement sur `registerConfigCheck('nginx', …)`** : une config
invalide fait **échouer** `systemctl start/restart/reload`, et le
service reste dans l'état où il était. C'est précisément ce qui rend
`nginx -t` utile *avant* de recharger en production, et le seam existe
déjà (`ssh` s'en sert exactement ainsi).

**Directive connue de nginx mais non appliquée ici** → refusée par
`nginx -t` avec un message qui dit cela. C'est la règle des trois
familles de `PRD-Curl.md` §7.3, transposée aux directives : une
directive appliquée agit ; une directive que nginx connaît et que ce
simulateur n'applique pas est refusée en le disant ; une directive
inexistante reçoit le `unknown directive` de nginx.

**Autres commandes** : `nginx -T` (dump de la config assemblée,
`include` résolus — la commande qu'on demande à quelqu'un d'exécuter
pour comprendre ce que le serveur voit vraiment), `nginx -v`,
`nginx -s reload|stop|quit|reopen`.

Chaque commande est un `LinuxCommand` dans son propre fichier
(`commands/net/Nginx.ts`), conformément à la règle du projet.

- **Acceptation :** éditer `sites-available/default` avec `vim`, changer
  `root`, `nginx -t`, `systemctl reload nginx`, et voir le contenu servi
  changer — sans redémarrer la machine, sans commande dédiée.

### P3 — Plusieurs sites, et les pannes qui vont avec

- **`sites-enabled/` réellement lu** : un lien symbolique présent = site
  actif. `ln -s ../sites-available/foo .` et `rm` suffisent. Aucun
  mécanisme spécial — c'est le VFS qui fait le travail.
- **`server_name`** : routage par en-tête `Host`, avec `default_server`
  pour ce qui ne correspond à rien. C'est ce qui rend `curl --resolve`
  (livré en P3 du PRD curl) pédagogiquement intéressant en face : un
  seul IP, plusieurs sites, et le `Host` décide.
- **Port déjà pris** : le second `listen` échoue avec
  `nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)`
  — la panne la plus fréquente du monde réel. `TcpStack.listen()` lève
  déjà `EADDRINUSE` ; il s'agit de traduire, pas d'inventer.
- **`CriticalFiles.ts`** : `nginx.conf` absent ⇒ refus de démarrer avec
  `nginx: [emerg] open() "/etc/nginx/nginx.conf" failed (2: No such
  file or directory)`. **À distinguer d'un fichier vide**, qui est une
  erreur de syntaxe et non une absence — même distinction que
  `CriticalFiles` impose déjà pour `sshd_config` (missing ≠ empty).
- **Permissions** : `/var/www/html` illisible par `www-data` ⇒ 403 et une
  ligne dans `error_log`. Le VFS a les permissions et l'utilisateur du
  service est réel ; il ne manque que la vérification.
- **Acceptation :** les scénarios de `docs/PRD-Pannes.md` s'appliquent à
  nginx comme ils s'appliquent déjà à sshd.

### P4 — Journaux

- `/var/log/nginx/access.log`, format `combined` réel :
  `$remote_addr - $remote_user [$time_local] "$request" $status
  $body_bytes_sent "$http_referer" "$http_user_agent"` — une ligne par
  requête servie. L'`User-Agent` y sera `curl/8.5.0`, ce que le PRD curl
  vient de rendre vrai.
- `/var/log/nginx/error.log` pour les 4xx/5xx et les refus de démarrage,
  au format `AAAA/MM/JJ HH:MM:SS [level] pid#tid: message`.
- `access_log off;` doit vraiment taire le journal.
- Rotation : `logrotate` existe déjà dans ce projet
  (`STANDARD_BIN_PATHS`, `LinuxLogManager`, `CriticalFiles`), donc
  brancher `/etc/logrotate.d/nginx` est une extension, pas un chantier.
- **Acceptation :** `tail -f /var/log/nginx/access.log` pendant qu'un
  autre poste fait des requêtes montre les lignes arriver — le TP
  d'observation le plus classique.

### P5 — HTTPS — **livré** (la question ouverte ci-dessous est levée)

`listen 443 ssl;` + `ssl_certificate` / `ssl_certificate_key` lus depuis
le VFS et servis par `HttpsServerSession`.

Le blocage est nommé : **il n'existe aucun chemin, sous Linux, par
lequel un certificat arrive dans le VFS.** Il y a une AC réelle
(`CertificateAuthority`), un magasin Windows (`WindowsCertStore`), et —
depuis le PRD curl — un magasin de racines de confiance sur les deux
plateformes. Mais aucune commande `openssl` (vérifié : absente des
commandes et de `STANDARD_BIN_PATHS`), donc aucun moyen de produire un
`.pem` que nginx lirait.

Deux ordres possibles :

1. écrire d'abord un chantier `openssl` (`req -x509 -newkey`, `x509
   -text -noout`, `verify`) adossé à `CertificateAuthority` ;
2. ou faire lire à nginx un certificat déposé par un test.

**Le second est refusé** : il produirait un certificat que rien d'autre
sur la machine ne sait fabriquer, donc un TP infaisable par un
apprenant. P5 attend P-openssl.

#### Résultat mesuré — P5 livré, par le premier ordre

`openssl` existe (`docs/PRD-OpenSSL.md`), donc le blocage nommé ci-dessus
a disparu, et c'est bien l'ordre 1 qui a été suivi : le certificat est
produit PAR LA MACHINE, avec la commande que l'apprenant tape, et nginx
lit ce que cette commande a écrit. Aucun test de cette phase ne dépose
un PEM à la main — c'est tout l'objet du refus rappelé plus haut, et un
test qui en planterait un ne prouverait rien sur la faisabilité du TP.

`ssl_certificate`/`ssl_certificate_key` quittent `KNOWN_UNSUPPORTED` et
sont stockés sur le bloc `server`. Les autres `ssl_*` (protocols,
ciphers, dhparam, session cache) restent refusés : ce sont des réglages
de poignée de main, or ce moteur TLS choisit lui-même sa suite et ses
groupes — les accepter reviendrait à stocker une valeur que rien ne lit,
la règle que ce fichier applique partout ailleurs.

Aucun moteur TLS neuf : `HttpsServerSession` conduisait déjà une vraie
`TlsServerSession` enregistrement par enregistrement. Il manquait la
lecture des deux fichiers.

**Trois sorties et non deux.** `tlsMaterialFor` rend `null` (le port est
en clair), la matière TLS, ou `'error'` — qui n'est PAS une variante de
`null`. Un port déclaré `ssl` dont le certificat est illisible garde son
port FERMÉ ; se rabattre sur du HTTP en clair sur 443 serait la pire
réponse possible, une machine servant en clair sur le port dont tout le
sens est qu'il ne l'est pas.

Trouvé en écrivant cette phase, et corrigé dans la foulée : **apache2
avait exactement ce défaut**, en vrai. Son `open()` construisait un
`Http1ServerSession` pour TOUS les ports, donc un `<VirtualHost *:443>`
était servi en clair sur 443, sans erreur ni avertissement. Les deux
serveurs partagent désormais la règle, chacun avec ses propres codes
(`AH00526`/`AH02572`/`AH02561` pour Apache). Corrigé aussi :
`HttpsServerSession.start()` ne prenait pas l'identité d'écoute, donc
`ss -ltnp` aurait montré un `:443` sans propriétaire à côté d'un `:80`
qui en a un — les deux vues de la même machine en désaccord.

### P6 — Proxy inverse — **livré** (et la prémisse ci-dessous était fausse)

`proxy_pass http://<amont>;`, plus `proxy_set_header`. C'est l'usage
moderne majoritaire de nginx et le plus intéressant en TP (nginx devant
une application), mais il suppose que nginx soit **client HTTP** autant
que serveur — donc qu'il réutilise `Http1ClientSession` sur sa propre
pile, ce qui fait passer sa requête sortante sur le vrai réseau. C'est
un chantier à part entière, à traiter après P2 et seulement si un TP le
demande.

> **Ce paragraphe est conservé pour ce qu'il a d'instructif : il est
> faux.** « Un chantier à part entière » reposait sur l'idée qu'un
> serveur devenu client doit attendre, donc être asynchrone. La mesure
> dit le contraire — voir §9.

## 5. Hors périmètre, et dit d'emblée

- **apache2.** Même trou, même patron de correction, grammaire de
  configuration entièrement différente (`<VirtualHost>`, `a2ensite`,
  `.htaccess`). Le traiter en même temps doublerait le chantier sans
  ajouter de leçon réseau nouvelle. **P0 s'y applique quand même** : son
  unité ne doit pas afficher un port qu'elle n'ouvre pas.
- **PHP, FastCGI, CGI.** Ce simulateur n'exécute pas d'application web ;
  `WindowsIisRole` a la même limite assumée pour ASP.NET.
- **HTTP/2, HTTP/3.** `listen 443 ssl http2;` doit être **refusé par
  `nginx -t`** tant que la couche HTTP ne les sert pas, pas accepté en
  silence. **Exigence tenue depuis §P6 — voir §9.7** ; elle ne l'était
  pas quand cette ligne a été écrite.
- **Limitation de débit, cache, `upstream` avec équilibrage.** Après P6,
  s'il y a une demande.
- **`worker_processes` / `worker_connections` : la seule exception à P1
  de ce document, et elle est explicite.** Aucune concurrence réelle
  n'est modélisée : ces directives décrivent un ordonnancement que ce
  simulateur n'a pas. Les refuser rendrait invalide **tout `nginx.conf`
  réel**, y compris celui que Debian livre — le refus coûterait plus de
  vérité qu'il n'en apporterait. Elles sont donc acceptées, sans effet,
  et cette page est le seul endroit où c'est écrit.

## 6. Vérification

Chaque phase : tests unitaires sur le comportement observable **plus**
un équivalent e2e dans le vrai terminal, comme pour les chantiers F5/F9
et curl.

Trois tests non négociables, parce qu'ils gardent les défauts que ce
document ouvre :

1. **Cohérence `ss` ⇄ connexion réelle**, dans les deux sens et pour
   chaque état du service. Ce test doit échouer si l'on retire P0 —
   à vérifier par neutralisation temporaire, comme pour les chantiers
   précédents.
2. **Transit réel** : compteurs de trames sur un câble intermédiaire
   avant/après une requête servie, pour que P5 (transport réel) ne
   puisse pas régresser en silence.
3. **La configuration décide** : éditer le fichier, recharger, constater
   que la réponse a changé. C'est le test qui empêche quelqu'un de
   réintroduire un état en mémoire que les fichiers décriraient.

## 7. Ordre recommandé, et pourquoi

- **P0 d'abord, seul, livrable seul.** Il ne construit rien : il
  **supprime une contradiction**, et il est le seul dont l'absence
  enseigne activement une règle fausse. Il bénéficie aussi à apache2,
  mysql et postgresql sans une ligne de plus.
- **P1 et P2 ensemble.** Servir un fichier sans lire la configuration
  violerait P3 dès le premier jour, et l'on écrirait deux fois le
  câblage. Les séparer coûterait plus cher que les faire d'un bloc.
- **P3 ensuite** : c'est là que le chantier devient un TP de
  diagnostic plutôt qu'une démonstration.
- **P4** est petit et à forte valeur d'observation.
- **P5 était bloqué** par une dépendance nommée (`openssl`), pas par sa
  difficulté propre — et c'est bien la dépendance qui l'a débloqué, dans
  l'ordre que ce PRD avait choisi.
- **P6** est un chantier à part entière.


## 8. Ce qui a été livré (P0 → P5)

### 8.1 Le décor supprimé, et jusqu'où

`ServiceSocketServer` est le port étroit : un service n'est inscrit dans
la `SocketTable` — donc dans `ss` — que s'il en fournit un et que celui-ci
a réellement ouvert son écoute. `apache2`, `mysql` et `postgresql`
quittent `ss` : régression apparente, correction réelle.

**La règle porte sur la table STATIQUE `SERVICE_LISTENERS`**, où vit le
décor. Une unité posée à l'exécution déclare son écoute, et cette
déclaration vaut serveur — c'est ce qui laisse le listener TNS d'Oracle
en place.

### 8.2 Trois dettes nommées plutôt que tues

- **Le listener TNS d'Oracle reste décoratif.** Rien n'appelle jamais
  `TcpStack.listen(1521)`. Il n'est pas assaini parce qu'un sous-système
  entier en dépend (la bannière, `lsnrctl`, la détection Oracle de
  `nmap`) ; la dette est écrite au point de liaison.
- ~~**Un listener posé directement sur `TcpStack` n'apparaît pas dans
  `ss`.**~~ **Remesuré lors de §P6 : c'est faux aujourd'hui.** Un
  `Http1ServerSession.start()` posé à la main sur la pile apparaît bien
  dans `ss -ltn` et dans `netstat -ltn`. La dette est levée ; la ligne
  est barrée plutôt que supprimée pour qu'on ne la rouvre pas sur la
  foi de ce document.
- **apache2 n'est pas traité**, comme annoncé au §5.

### 8.3 Ce que le chantier a révélé ailleurs

**Trois fichiers de test différents liaient la pile TCP à la main** pour
compenser un port décoratif, dont un avec le commentaire « *systemctl
projects mysqld into /proc/net/tcp but does not open a real TCP
accept-loop* ». D'autres avaient rencontré la contradiction et l'avaient
contournée sans la nommer.

Et **un test l'encodait** : `scenario-config-drift` écrivait
`listen 8080` puis exigeait que `ss` ne montre pas `:8080`. Il ne passait
que parce que la configuration était ignorée.

### 8.4 P3 — plusieurs sites, et les pannes

`sites-enabled/` est réellement lu : `ln -s` et `rm` suffisent. Routage
par `server_name` avec repli sur `default_server`. Port déjà pris →
`nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in
use)`, le service échoue et la trace part dans `error.log`.

**Un `nginx.conf` ABSENT et un `nginx.conf` VIDE sont deux pannes
distinctes** : l'absence est un `open()` qui échoue (`CriticalFiles`), le
vide une configuration syntaxiquement correcte à laquelle il manque la
section `events`. Deux messages, deux diagnostics — et `nginx -t` juge le
fichier exactement comme le démon, faute de quoi une commande dirait
« syntax is ok » d'une configuration que `systemctl start` refuse.

### 8.5 P4 — journaux

`access.log` au format `combined` réel (une ligne par requête servie,
méthode, cible, statut, taille, User-Agent), `error.log` pour les 4xx/5xx
avec le chemin cherché et l'errno, et pour les refus de démarrage.
`access_log off;` fait vraiment taire le journal.

### 8.6 Non fait

P5 (HTTPS) est livré : le chemin `openssl req` → PEM existe désormais
sous Linux, et c'est celui que le TP emprunte.

**P6 est livré depuis** — voir §9. La phrase qui suivait ici
(« `proxy_pass` reste refusé par `nginx -t` ») n'est plus vraie et est
conservée sous cette forme pour ne pas laisser deux réponses à la même
question : `proxy_pass` est désormais MIS EN ŒUVRE, et ce que `nginx -t`
refuse est une URL illisible ou la directive écrite hors d'une
`location` — deux refus qui ont changé de raison, pas disparu.

---

## 9. P6 — Le mandataire inverse, livré

### 9.1 La prémisse du PRD était fausse, et c'est la mesure qui l'a dit

§P6 différait ce chantier au motif qu'il « suppose que nginx soit client
HTTP autant que serveur ». C'est vrai, et ce n'était pas le problème :
le raisonnement implicite était qu'un serveur qui attend une réponse
doit être **asynchrone**, et que rendre asynchrone
`Http1ServerSession.handler` — partagé avec Apache et IIS — était le
vrai coût.

Mesuré avant d'écrire une ligne : **la livraison des trames est
synchrone dans ce simulateur**. `Http1ClientSession.send()` écrit,
l'`onData` du pair se déclenche dans le même tour, et la réponse est là
avant que `send()` ne revienne. Un gestionnaire de requête peut donc
appeler l'amont **en ligne** et écrire sa réponse dans la foulée. La
vérification a été faite avec deux `Http1ServerSession` nus, avant de
toucher à nginx.

Rien n'est devenu asynchrone. La signature du gestionnaire a bien été
élargie, mais pour une tout autre raison (§9.4).

### 9.2 Ce qui est livré

* **`proxy_pass http://hôte[:port][/chemin]`** dans une `location`. La
  réécriture du chemin suit la règle de nginx, qui est la plus mal
  comprise de cette directive : c'est la **présence** d'un chemin dans
  l'URI qui décide, pas sa valeur.

  | écrit | `/api/v1` devient |
  |---|---|
  | `proxy_pass http://amont;` | `/api/v1` (inchangé) |
  | `proxy_pass http://amont/;` | `/v1` (le préfixe de la `location` est REMPLACÉ) |
  | `proxy_pass http://amont/backend;` | `/backend/v1` |

  D'où `NginxProxyPass.path?: string` et non une chaîne : `undefined` et
  `''` sont deux configurations différentes, et les confondre casserait
  la première ligne du tableau.

* **Les blocs `upstream`**, avec `server <hôte>[:<port>] [down]`. Un
  membre `down` est sauté. Le groupe est consulté **avant** la
  résolution de nom, comme chez nginx : un `upstream` masque un hôte du
  même nom.

* **`proxy_set_header`**, avec `$host`, `$http_host`, `$proxy_host`,
  `$remote_addr`, `$scheme`, `$request_uri` et
  `$proxy_add_x_forwarded_for` — la seule qui AJOUTE, en empilant le
  client derrière la chaîne déjà reçue. Par défaut `Host` prend
  l'autorité de l'amont ; `proxy_set_header Host $host` est précisément
  ce qu'on écrit pour l'en empêcher, donc l'ordre compte.

* **Les en-têtes saut-par-saut** (RFC 9110 §7.6.1) ne sont relayés dans
  aucun sens.

* **La résolution passe par la MACHINE** qui exécute nginx — son
  `/etc/hosts`, son `/etc/resolv.conf`, via le même NSS que `ping` sur
  la même machine. Un service qui ne résoudrait pas comme le reste de la
  machine serait un piège.

* **Les pannes, qui sont l'objet du TP** : amont éteint, nom
  introuvable, amont `https`, boucle de mandat — toutes rendent `502
  Bad Gateway` avec la page de nginx, et la **raison** dans `error.log`,
  jamais dans la page. C'est là que le vrai nginx la met, et c'est ce
  qu'un opérateur doit apprendre à lire.

* **`nginx -t` juge** : `invalid URL prefix in "…"` pour une URL
  illisible, `"proxy_pass" directive is not allowed here` hors d'une
  `location`, `"server" directive is not allowed here` hors d'un
  `upstream`.

### 9.3 La boucle de mandat, et pourquoi elle est bornée explicitement

nginx qui se mandate lui-même est une configuration qu'un apprenant
écrit par accident. La livraison étant synchrone, c'est une **récursion
infinie** : l'onglet se fige, sans message. Un vrai nginx boucle aussi,
mais il finit par épuiser ses connexions de travail et répond une
erreur ; ici il n'y a rien à épuiser.

`MAX_PROXY_DEPTH` borne donc la profondeur, et au-delà le mandataire
rend `502` en écrivant `proxy loop detected after N hops`. La divergence
est assumée et écrite : le vrai nginx ne dit pas cela. Un onglet figé
n'apprend rien du tout.

### 9.4 Trois manquements trouvés AILLEURS, et corrigés

Aucun des trois n'était dans nginx, et aucun n'aurait été visible sans
ce chantier.

1. **Le gestionnaire de requête HTTP ignorait qui l'appelait.**
   `Http1RequestHandler` ne recevait que la requête ; la socket, elle,
   porte l'adresse du pair depuis toujours. Conséquence :
   `$remote_addr` ne pouvait valoir qu'un espace réservé — un
   `X-Real-IP: 0.0.0.0` n'apprend rien de ce que cet en-tête existe
   pour — et le journal d'accès commençait par `-` là où le format
   combiné veut l'adresse du client. Un `Http1Peer` optionnel est
   maintenant passé aux deux sessions (claire et TLS) ; les
   gestionnaires qui l'ignorent sont inchangés, et **Apache et IIS en
   bénéficient sans modification**.

2. **nginx écrivait une ligne `open() … failed` pour tout état ≥ 400.**
   Avant P6 c'était équivalent, puisque tout ce qui dépassait 400 venait
   d'une recherche de fichier. Un `502` de mandataire n'ouvre aucun
   fichier et a déjà écrit sa vraie raison : la ligne produisait une
   seconde explication, fausse. La condition est désormais `403 || 404`,
   les deux seuls états qui viennent réellement d'un `open()`.

3. **Une machine ne s'atteignait pas par sa PROPRE adresse.** Le plus
   lourd des trois, et sans rapport avec HTTP. `curl http://127.0.0.1/`
   répondait, `curl http://10.0.0.2/` sur la machine qui PORTE
   `10.0.0.2` restait sur `Trying…` indéfiniment. Sur un vrai Linux la
   table de routage `local` contient une entrée `local <adresse> dev lo`
   pour **chaque** adresse configurée, si bien qu'un paquet qui lui est
   destiné ne sort jamais sur le fil ; ici seule la boucle locale était
   traitée. `TcpStack.isLocalDestination()` couvre maintenant les deux,
   en v4 comme en v6, et il est consulté **avant** la recherche de route
   — c'est l'ordre du noyau. Cela vaut pour tout service, pas seulement
   nginx : un serveur joignable de toute la topologie ne l'était pas
   depuis la machine qui l'exécute.

### 9.5 Limites assumées

* **Un seul membre d'`upstream` est utilisé** : le premier qui n'est pas
  `down` et qui se résout. Il n'y a ni répartition de charge, ni
  `weight`, ni `least_conn`, ni détection de panne passive
  (`max_fails`/`fail_timeout`) — donc pas de bascule sur un amont qui
  refuse la connexion. Une répartition suppose de mesurer, et rien ici
  ne mesure encore ; annoncer `round-robin` en servant toujours le même
  serait exactement le genre de décor que ce PRD supprime.
* **Les délais de `proxy_*_timeout` sont acceptés et inertes**, comme
  les autres réglages temporels : la livraison étant synchrone, aucun
  délai ne peut expirer. Ils sont dans `ACCEPTED_INERT` et non refusés,
  parce qu'ils figurent dans toute configuration réelle.
* **`proxy_pass https://` est refusé** plutôt qu'ouvert en clair. Tout
  ce qui lit `https` attend du chiffré ; parler en clair sur cette foi
  serait la pire réponse disponible — la même règle que
  `tlsMaterialFor` applique déjà à un `listen … ssl` dont le certificat
  est illisible.
* **Un hôte d'amont introuvable donne `502` à la requête** et non un
  refus au démarrage. Le vrai nginx échoue au démarrage
  (`host not found in upstream`) ; ici la résolution dépend de l'état du
  réseau au moment de la requête, et la panne visible à l'exécution est
  celle que le TP cherche à montrer.
* **`proxy_redirect` n'est pas appliqué** : un `Location` renvoyé par
  l'amont traverse tel quel.

### 9.6 Mesures

`nginx-prd-p6-proxy.test.ts` (23 cas), **22 tombent par `git stash`**
des fichiers touchés. Le vingt-troisième est le cas « un 502 n'écrit pas
de ligne `open()` » : sa première rédaction ne portait que
l'assertion négative et passait des deux côtés — sans mandataire, aucune
ligne n'est écrite et le `not.toContain` était satisfait sans rien
prouver. L'assertion positive qui l'accompagne désormais l'en empêche.

Un piège de rédaction, noté parce qu'il a produit une fausse
conclusion : `printf` passe par le shell, qui mange un `$` non protégé.
Le premier jet écrivait `proxy_set_header Host ;` dans le fichier et
concluait que `proxy_set_header` n'était pas appliqué — alors que
l'analyseur était correct depuis le début.

### 9.7 Les paramètres de `listen`, rangés en trois familles

Trouvé en vérifiant l'exigence du §5 (« `listen 443 ssl http2;` doit
être refusé ») : elle n'était pas tenue. `parseListen` ne cherchait que
`default_server` et `ssl` et **ignorait tout le reste**, si bien que
`listen 443 ssl http2;` était accepté, le serveur démarrait, et il
servait du HTTP/1.1. C'est le cas de décor le plus trompeur de tout ce
document — un opérateur qui a écrit `http2` croit tenir du HTTP/2, et
rien dans la machine ne le détrompe.

Les paramètres suivent désormais la règle des trois familles que ce
dépôt applique déjà aux options de `curl` et d'`openssl` :

| famille | exemples | réponse |
|---|---|---|
| appliqués | `default_server`, `ssl` | agissent |
| connus, sans effet ici | `backlog=`, `deferred`, `reuseport`, `ipv6only=`, `so_keepalive`, `rcvbuf=`, `sndbuf=`, `bind`, `setfib=`, `fastopen=`, `accept_filter=` | acceptés |
| connus, effet non produit | `http2`, `http3`, `quic`, `spdy`, `proxy_protocol` | **refusés** en le disant |
| inexistants | `zorglub`, `backlog` sans valeur | `invalid parameter "…"`, le message de nginx |

`proxy_protocol` est dans la troisième et non la deuxième, et la
distinction est réelle : il change le format sur le fil ET la
provenance de l'adresse du client. L'accepter sans le produire
fausserait `$remote_addr`, que §9.4 vient précisément de rendre exact.

Les réglages de socket restent acceptés parce qu'ils figurent dans des
configurations réelles et ne décrivent rien d'observable ici — la même
exception, explicitement bornée, que `worker_processes`.

### 9.8 `a2ensite` / `a2enmod` : les commandes que le document décrivait sans les écrire

Trouvé en cherchant si Apache souffrait du même défaut qu'nginx (une
directive acceptée sans effet). Le vrai manquement était ailleurs et
plus simple : **les quatre commandes n'existaient pas**.
`a2ensite default-ssl` répondait `command not found`, à la deuxième
ligne de n'importe quel tutoriel Apache.

Le module entier les nommait pourtant — « `a2ensite` is only an
`ln -s` », « `a2enmod` is only an `ln -s` and `a2dismod` only an `rm` ».
L'observation est juste, et elle a servi de raison de ne pas les
écrire : faire marcher `ln -s` à la main n'exige pourtant pas que la
commande soit absente.

Elles restent **exactement** ce lien : un lien posé à la main vaut
autant, et `a2dissite` le retire tout de même — les deux gestes portent
sur le même objet, sans registre à part (c'est un cas de test). Deux
différences réelles sont reproduites parce qu'elles enseignent : un site
se **recharge**, un module se **redémarre** — charger du code dans le
serveur n'est pas relire un fichier ; et « déjà désactivé » n'est pas
« n'existe pas », l'un étant un état et l'autre une faute de frappe.

**`mods-available` n'existait pas non plus**, seul `mods-enabled` était
semé. `a2enmod ssl` n'aurait donc eu aucun fichier à lier — et c'est
précisément la distinction disponible/activé qui porte la leçon :
Debian livre `ssl`, `proxy`, `rewrite`, `headers` **éteints**, et les
allumer est la première ligne du TP. Les modules livrés actifs sont
désormais des LIENS et non des copies, sans quoi `a2dismod dir`
supprimerait un fichier que rien ne pourrait recréer.

`apache-a2ensite-a2enmod.test.ts` (13 cas), **les 13 tombent par
`git stash`**.

**Ce qui restait ouvert du côté d'Apache** — `apachectl configtest`
répondant `Syntax OK` à tout — **est traité au §9.9**, avec de quoi être
écrit correctement grâce à `mods-enabled` devenu manipulable.

### 9.9 `apachectl configtest` juge, et il juge par les MODULES

`apachectl configtest` répondait `Syntax OK` à **tout** : à
`Zorglub on`, à `ProxyPass`, à `Protocols h2`. Le parseur finissait
littéralement par `default: break; // the rest of the grammar is read
and ignored` — le jumeau exact du défaut que §P2 avait corrigé côté
nginx.

**La forme du contrôle n'est pas une liste de mots interdits**, et c'est
tout l'intérêt de ce lot. Apache ne dit jamais « directive inconnue » ;
il dit :

```
Invalid command 'ProxyPass', perhaps misspelled or defined by
a module not included in the server configuration
```

Son propre message reconnaît qu'il ne sait pas distinguer une faute de
frappe d'un module éteint, **parce que sa grammaire est définie par les
modules chargés**. Refuser `ProxyPass` en dur aurait donc énoncé quelque
chose de faux : ce qui cloche n'est pas la directive, c'est que
`mod_proxy` n'est pas allumé — et `a2enmod proxy` est la réponse. Ce lot
n'était écrivable qu'après §9.8, qui a rendu `mods-enabled`
manipulable.

D'où quatre issues, et non deux :

| situation | réponse |
|---|---|
| module chargé, directive appliquée | acceptée |
| module chargé, directive descriptive | acceptée (inerte) |
| module chargé, effet non produit ici | `the 'X' directive is not supported by this simulator` |
| module éteint **ou** directive inexistante | `Invalid command 'X', perhaps misspelled…` — le message d'Apache, le même pour les deux, comme chez lui |

La séquence que cela produit est celle d'un vrai serveur :
`ProxyPass` → *module absent* ; `a2enmod proxy` ; `ProxyPass` → *non
produit par ce simulateur*. Deux manques différents, deux messages
différents, et l'ordre enseigne.

**`<IfModule>` est honoré**, ce qui était la moitié manquante. Le bloc
était traité comme une ligne quelconque, si bien que le
`default-ssl.conf` de Debian — entièrement enveloppé dans
`<IfModule mod_ssl.c>` — était lu même sans `mod_ssl`. Apache SAUTE le
bloc. La différence porte tout le TP TLS :

* `a2ensite default-ssl` sans `a2enmod ssl` → `Syntax OK`, et **rien sur
  443**. C'est la confusion classique, reproduite plutôt qu'évitée.
* `a2enmod ssl` ensuite → le bloc est lu, et bute sur le certificat
  « snakeoil » que Debian nomme et que cette image ne fabrique pas.
  C'est la vraie première marche.

La forme niée (`<IfModule !mod_ssl.c>`) et l'imbrication sont traitées :
un bloc sauté ne fait pas juger ses directives, sans quoi un
`RewriteEngine` placé dans une garde serait refusé bien qu'Apache n'y
entre jamais.

**Une seule lecture des modules** (`loadedApacheModules`) sert
`apachectl -M` et `configtest`, et le nom vient de la ligne
`LoadModule` du fichier plutôt que du nom du lien — c'est `LoadModule`
qui nomme le module. Deux vues en désaccord sur ce qui est chargé
seraient la contradiction la plus déroutante possible ; un cas de test
les compare au même instant.

**Sept cas d'`apache2-https.test.ts` sont tombés, et c'était le
défaut** : ils montaient du TLS **sans jamais activer `mod_ssl`**, ce
qu'aucun Debian ne permet. Ils passaient parce que le simulateur
ignorait `<IfModule>` et ne jugeait aucune directive. Ils appellent
désormais `a2enmod ssl` en premier — le geste réel, devenu possible au
§9.8 — plutôt que d'affaiblir l'assertion.

**Limite assumée** : le contrôle ne porte que sur les directives lues
dans `sites-enabled`, à l'intérieur d'un `<VirtualHost>`. `apache2.conf`
et ses blocs `<Directory>` ne sont pas analysés — ils ne le sont pas
davantage aujourd'hui pour en extraire quoi que ce soit, et les juger
sans les lire n'aurait aucun sens.

`apache-configtest-juge.test.ts` (17 cas), **12 tombent par
`git stash`**. Les 5 qui passent des deux côtés sont les garde-fous de
non-régression, dont le plus important : **la configuration livrée par
Debian doit rester valide** — un contrôle qui refuserait le fichier que
la distribution installe coûterait plus de vérité qu'il n'en apporte.
