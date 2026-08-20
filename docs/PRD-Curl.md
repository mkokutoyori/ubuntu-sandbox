# PRD — `curl`

## 1. Pourquoi ce document

`curl` est la commande par laquelle un apprenant vérifie qu'un service web
répond. C'est aussi, dans ce simulateur, l'une des rares commandes dont le
transport est **déjà entièrement réel** : la requête part sur la vraie pile
TCP, traverse les vrais câbles, se fait filtrer par les vraies ACL et
apparaît dans une capture `tcpdump` de transit. Ce n'est pas un stub.

Le problème n'est donc pas le réseau. Il est que **la commande est un
guichet de quatre options sur les quelque quarante qu'un cours réseau
utilise**, et que deux de ces quatre sont acceptées puis ignorées — ce qui
est pire que de les refuser.

> **État : implémenté.** P0 à P3 sont livrés ; P4 reste hors périmètre,
> comme annoncé au §4. `--cacert` a été ajouté après coup, hors phases
> (§7.4 bis), parce que sans lui aucune vérification de certificat
> n'existait nulle part dans le simulateur. Le §7 en fin de document dit
> exactement ce qui a été fait, ce qui a dû être corrigé ailleurs pour
> que P2 ne mente pas, et ce qui reste ouvert.

## 2. État des lieux, vérifié

*(Cette section décrit l'état AVANT implémentation ; elle est conservée
telle quelle, parce que c'est elle qui justifie les phases.)*

`src/network/devices/linux/commands/net/Curl.ts` — 95 lignes.

### 2.1 Ce qui est réel, et l'est vraiment

- **HTTP** passe par `fetchHttp` → une vraie connexion TCP vers un
  équipement qui héberge réellement HTTP (IIS/W3SVC ou autre).
- **HTTPS** ouvre une `HttpsClientSession` sur la même pile, avec
  **vérification de certificat authentique** : chaîne via
  `CertificateVerifier`, correspondance du nom d'hôte via
  `certificateMatchesHostname`.
- Les erreurs portent les **vrais codes curl** : `(6)` hôte non résolu,
  `(7)` connexion refusée, `(60)` problème de certificat, `(35)` mauvaise
  version SSL, `(3)` URL malformée.
- `-I` / `--head` rend une vraie ligne de statut et les en-têtes réels de
  la réponse.

### 2.2 Ce qui ment

**`-s` / `--silent` et `-v` sont parsés puis jetés** (`continue` dans la
boucle d'arguments). L'opérateur les tape, `curl` les accepte, et rien ne
change. C'est le motif que ce projet a corrigé quatre fois ailleurs — `df`,
`ulimit -u`, `ulimit -n`, `MemoryMax=` — une option affichée que rien
n'honore. Ici c'est plus insidieux encore : il n'y a même pas de valeur à
lire, juste un silence.

`-v` est le plus coûteux des deux, parce que c'est **l'option de diagnostic
par excellence** : c'est elle qu'on demande à un apprenant de taper quand
« ça ne marche pas », et elle ne produit rien.

### 2.3 Ce qui manque

| Option | Rôle | Priorité |
|---|---|---|
| `-o FILE` / `-O` | écrire dans un fichier | P1 |
| `-w FORMAT` | `%{http_code}`, `%{time_total}` — le mode script | P1 |
| `-f` / `--fail` | code de sortie non nul sur ≥ 400 | P1 |
| `-L` | suivre les redirections | P2 |
| `-X METHOD` | POST/PUT/DELETE | P2 |
| `-d DATA` | corps de requête | P2 |
| `-H 'K: V'` | en-tête arbitraire | P2 |
| `-u user:pass` | authentification HTTP | P3 |
| `--resolve` | forcer une résolution | P3 |
| `--cacert FILE` | vérifier contre une ancre fabriquée par l'opérateur | hors phases, §7.4 bis |
| `-x` proxy, cookies, `--retry` | | P4 |

**Et un manque qui n'est pas une option** : `run` rend une `string`, donc
`curl` **n'a pas de code de sortie**. `curl … || echo échec` ne peut pas
fonctionner, ce qui retire à la commande son usage le plus fréquent en
script.

## 3. Principes

Les mêmes que `docs/PRD-Pannes.md`, et pour les mêmes raisons.

- **P1 — Rien qui mente.** Une option non implémentée est REFUSÉE avec le
  message de curl (`curl: option -Z: is unknown`), jamais avalée en
  silence. Le refus enseigne ; le silence égare.
- **P2 — Les messages sont ceux de curl, verbatim**, codes d'erreur
  compris. C'est ce qui permet à l'apprenant de reconnaître la situation
  sur une vraie machine.
- **P3 — Le transport reste réel.** Aucune phase ne doit introduire de
  raccourci qui contourne la pile TCP : ce qui fait la valeur de `curl`
  ici, c'est que la requête transite pour de bon.
- **P4 — Le code de sortie fait partie de la commande.** Une commande dont
  `$?` est toujours 0 n'est pas utilisable en script, donc pas utilisable
  en TP.

## 4. Phases

### P0 — Honnêteté immédiate (prérequis)

Le plus petit changement qui supprime le mensonge existant.

- `-s` et `-v` cessent d'être ignorés : soit implémentés (P1), soit
  refusés. **Refuser une option que curl connaît serait faux aussi** —
  donc ils sont implémentés, et c'est pourquoi P0 et P1 sont liés.
- Toute option inconnue est refusée avec le message de curl et le code 2.
- **Acceptation :** aucune option acceptée n'est sans effet observable.

### P1 — La commande devient scriptable

- **Code de sortie réel** : 0 succès, 6 hôte non résolu, 7 refus, 22 avec
  `-f` sur ≥ 400, 35/60 pour TLS. C'est le socle des trois autres phases.
- `-s` supprime la barre de progression et les erreurs non fatales ;
  `-S` les rétablit (`-sS` est l'idiome réel).
- `-v` écrit sur **stderr** le dialogue : `* Connected to …`, `> GET …`,
  `< HTTP/1.1 200`. C'est stderr et pas stdout, sinon `curl -v url > f`
  polluerait le fichier — détail qui distingue une implémentation réelle
  d'une imitation.
- `-o FILE` / `-O`, et `-w` avec au minimum `%{http_code}`.
- **Acceptation :** `curl -fsS URL || echo KO` se comporte comme sur une
  vraie machine, dans les deux issues.

### P2 — Les verbes et les en-têtes

`-X`, `-d`, `-H`, `-L`. Dépend de ce que la couche HTTP sait déjà servir :
**à cadrer avant, pas pendant** — inutile d'offrir `-X DELETE` si aucun
serveur du simulateur ne distingue les méthodes.

### P3 — Authentification et résolution forcée

`-u`, `--resolve`. `--resolve` a une vraie valeur pédagogique ici : il
sépare « le DNS est cassé » de « le service est cassé », qui est le
diagnostic que les TP réseau cherchent à faire acquérir.

### P4 — Le reste

Proxy, cookies, `--retry`, formulaires. À traiter seulement si un TP les
demande.

> **§P4 est livré, sauf le proxy** — témoins au §9, `--version` et
> quatre options au §10, formulaires et `--retry` au §11. Seul `-x`
> reste refusé, et le §11.3 dit pourquoi ce n'est pas un oubli.

## 5. Hors périmètre, et dit d'emblée

- **FTP, SFTP, SMTP et les autres protocoles de curl.** `curl` en gère une
  vingtaine ; ce simulateur héberge HTTP et HTTPS. Les autres schémas
  doivent être refusés avec le message réel
  (`curl: (1) Protocol "ftp" not supported`), pas simulés.
- **HTTP/2, HTTP/3.** Tant que la couche HTTP ne les sert pas, `--http2`
  n'a rien à négocier.
- **La barre de progression.** Elle suppose un transfert qui dure ; les
  réponses ici sont immédiates. `-s`/`-S` restent utiles pour les erreurs.

## 6. Vérification

Chaque phase : tests unitaires sur le comportement observable **plus** un
équivalent e2e dans le vrai terminal, comme pour les chantiers F5/F9. Un
test doit couvrir le transit réel (compteurs de trames sur un câble
intermédiaire) au moins une fois, pour que P3 ne puisse pas régresser en
silence.


## 7. Ce qui a été livré

### 7.1 Une seule implémentation, deux plateformes

`curl` n'est pas une commande Linux : Windows en livre une depuis la 1803
(`C:\Windows\System32\curl.exe`), et une machine Windows de ce simulateur
n'en avait aucune. Le moteur vit donc dans **`src/network/http/curl/`**, à
côté du `HttpClient.ts` que les deux plateformes partagent déjà :

| Fichier | Rôle |
|---|---|
| `CurlArgs.ts` | analyse de la ligne de commande, y compris les grappes courtes (`-fsS`) |
| `CurlTransfer.ts` | la requête réelle : HTTP/1.1, TLS, redirections, trace `-v` |
| `CurlWriteOut.ts` | `-w` |
| `CurlEngine.ts` | le comportement de la commande — sortie, stderr, code de sortie |
| `CurlHost.ts` | le port étroit que chaque plateforme remplit |

Chaque système n'apporte que son branchement : `Curl.ts` (LinuxCommand)
côté Linux, `WindowsPC.cmdCurl` côté cmd.exe et PowerShell. Résolution de
noms, pile TCP, ancres de confiance, écriture de fichier — rien d'autre.
`curl-one-engine-two-platforms.test.ts` épingle la propriété qui compte :
la même situation donne le même verdict des deux côtés.

### 7.2 Options implémentées

`-I` `-i` `-k` `-s` `-S` `-v` `-f` `-L` `-o` `-O` `-w` `-X` `-d` `-H` `-u`
`-A` `--resolve` `--max-redirs`, plus les formes longues correspondantes,
les grappes courtes et `--opt=valeur`.

Codes de sortie réels : 0, 1 (protocole), 2 (usage), 3 (URL), 6, 7, 22
(`-f`), 23 (écriture), 35, 47 (redirections), 52, 60.

### 7.3 Trois familles d'options, et pourquoi

Le §3 P1 dit qu'une option non implémentée est refusée, jamais avalée.
Appliqué littéralement, cela produisait un second mensonge : répondre
`curl: option -x: is unknown` pour `-x`, que curl connaît parfaitement.
Il y a donc trois cas, et non deux :

1. **implémentée** → elle agit ;
2. **connue de curl, non implémentée ici** → `curl: option -x: is not
   implemented in this simulator` ;
3. **inexistante** → `curl: option -Z: is unknown`, le message de curl.

Le 2 n'est pas un message de curl, et c'est assumé : aucun message de curl
ne dit cette chose-là, parce qu'aucun vrai curl n'est dans cette situation.
Le refus reste un refus, et il enseigne ce qui est vrai.

### 7.4 Ce que P2 a exigé du RESTE de la plateforme

Le §4 demandait de cadrer P2 avant de l'écrire. Le cadrage a montré que
`Http1ServerSession` transporte déjà méthode, corps et en-têtes réels —
mais que **le seul serveur HTTP livré avec le produit ignorait la
méthode** : `WindowsIisRole.buildResponse()` servait le fichier pour un
`DELETE` comme pour un `GET`. `-X` aurait donc été une option acceptée sans
effet observable, exactement ce que P0 interdit. Corrigé : `405 Method Not
Allowed` avec `Allow: GET, HEAD, OPTIONS, TRACE`, et `OPTIONS` répondu.

Trois incohérences trouvées en chemin, corrigées dans la même passe :

- **`Install-WindowsFeature Web-Server` ne faisait rien écouter.** Chaque
  rôle Windows était matérialisé paresseusement, à la première applet de
  commande qui le réclamait — ce qui se lit bien depuis la console du
  serveur et pas du tout depuis ailleurs : installer le rôle puis faire un
  `curl` depuis une autre machine donnait `Connection refused`. Le commentaire
  de `getDnsServerRole()` disait déjà que `RoleManager` n'avait « pas de
  point d'accroche par fonctionnalité » ; il en a un
  (`RoleManager.onFeatureLifecycle`), et les quatre rôles en profitent.
- **Windows n'avait aucun magasin de racines de confiance** pour ses
  clients sortants (limitation documentée dans `sendMailMessage`). Il a le
  même que Linux, et donc la même vérification de certificat.
- **cmd.exe lisait un `|` entre guillemets comme un tube.** `curl -w
  "%{http_code}|%{size_download}"` passait pour un pipeline. `splitCmdChain`
  savait déjà tenir compte des guillemets pour `||` ; la détection de tube
  le fait maintenant aussi.

### 7.4 bis — `--cacert`, et ce qu'il a révélé ailleurs

Ajouté après coup, hors des quatre phases, parce qu'il manquait la seule
chose qui rendait une PKI de labo utilisable : jusque-là on atteignait
son propre serveur avec `-k`, et `-k` veut dire « ne vérifie pas ». Rien
dans ce simulateur n'avait donc jamais contrôlé qu'un certificat était
utilisable — seulement que les deux bouts s'entendaient.

Ce qu'il fait : l'option REMPLACE le magasin de confiance au lieu de s'y
ajouter (sinon passer la mauvaise ancre réussirait quand même, et
l'option serait un `-k` décoré) ; un fichier absent échoue avant la
poignée de main, avec l'erreur 77 de curl ; `CurlHost` gagne `readFile`,
rempli des deux côtés, puisque c'est un seul moteur.

Ce qu'il a trouvé — trois défauts, aucun dans curl :

1. `subjectAltName` est rangé comme openssl l'écrit (`DNS:lab.local`) et
   la comparaison prenait la chaîne entière : un certificat portant un
   SAN ne correspondait à aucun hôte. Le SAN primant sur le nom commun,
   en ajouter un rendait le certificat *pire*.
2. Le repli sur le nom commun cherchait `CN=` collé, alors que la RFC
   4514 autorise les espaces et que l'`openssl req` de cette machine
   écrit `CN = lab.local` : aucun certificat émis ici ne pouvait
   correspondre par son nom commun.
3. `openssl req -x509 -addext subjectAltName=...` greffait l'extension
   après la signature, que `tbsPayload` couvre (voir
   `docs/PRD-OpenSSL.md`).

Ce que les tests ne discriminent PAS, dit plutôt que sous-entendu : le
magasin d'une machine Linux est vide ici, donc « remplacer » et
« ajouter » y sont indiscernables. Les deux correctifs du comparateur,
eux, sont discriminés par neutralisation (3 cas sur 9 tombent).

### 7.5 Limites assumées

- **De P4, seul le proxy (`-x`) n'est pas fait** — témoins §9,
  `--version` et quatre options §10, formulaires et `--retry` §11 —
  comme le
  §4 l'annonçait : « à traiter seulement si un TP les demande ». Ces
  options sont refusées par le cas 2 du §7.3, pas ignorées.
- **`%{time_total}` est mesuré pour de vrai** et vaut donc à peu près zéro,
  puisque les réponses sont immédiates. Les autres variables de temps
  (`time_connect`, `time_namelookup`, …) ne sont **pas** fournies : les
  faire toutes égales à `time_total` serait une ventilation inventée. Une
  variable non fournie est signalée (`curl: unknown --write-out
  variable: …`), jamais devinée.
- **`-I` envoie une vraie requête HEAD**, et le serveur y répond avec le
  corps que le `GET` aurait servi ; c'est le client qui le supprime, comme
  le fait `Http1ClientSession` (`suppressBody`). La sortie observable est
  identique à celle du vrai curl, `Content-Length` compris.
- **PowerShell traite `curl` comme `curl.exe`** (comportement de
  PowerShell 7), et non comme l'alias de `Invoke-WebRequest` de Windows
  PowerShell 5.1.
- **`nginx`/`apache2` existent comme unités systemd mais n'écoutent rien.**
  Ce n'est pas une lacune de `curl` — le transport est réel et le refus est
  correct — mais c'est la raison pour laquelle les TP HTTP côté Linux
  doivent aujourd'hui monter leur serveur autrement. À traiter dans un
  chantier « serveur HTTP Linux », sur le modèle de `WindowsIisRole`.


---

## 9. Les témoins — livré

### 9.1 Ce n'était pas une fonctionnalité à écrire

§P4 rangeait les témoins avec le proxy et les formulaires. La mesure a
renversé le calcul : `src/network/http/cookies/` contient un moteur
**RFC 6265 complet** — `domainMatch`, `pathMatch`, `Secure`,
`HttpOnly`, `SameSite`, `Max-Age` avec précédence sur `Expires`,
suppression d'un témoin dont l'échéance est passée — et **aucun
appelant hors de son propre répertoire**.

C'est le motif que ce dépôt corrige sans arrêt : un moteur sans porte.
Avec sa conséquence habituelle — un code que rien n'appelle est un code
que rien n'a jamais vérifié. La première chose faite ici a donc été de
l'exercer à la main : il s'est révélé juste sur les huit points
essayés, ce qui rend la porte d'autant plus rentable.

### 9.2 Ce qui est livré

`-b`/`--cookie` et `-c`/`--cookie-jar`, au **format Netscape** — celui
que `curl -c` écrit et que `curl -b` relit. Écrire un format à soi
aurait produit un fichier que rien ne consomme, et la séquence
`-b jar -c jar` que tout script emploie n'aurait pas bouclé.

`-b` distingue ses deux formes comme curl : un argument contenant `=`
est une chaîne de témoins, tout le reste est un nom de fichier. Un
fichier absent n'est pas une erreur — c'est le cas normal du PREMIER
appel de cette séquence.

**Le bocal vit pendant tout le transfert, redirections comprises**, et
c'est là qu'il sert vraiment : une session s'ouvre par un `302` qui
pose le témoin, et la page suivante doit le porter. Récolter les
`Set-Cookie` seulement sur la réponse finale aurait perdu exactement le
cas d'usage de l'option.

**Le bocal FILTRE, il ne récite pas.** Un témoin d'un autre chemin ne
part pas ; un témoin `Secure` ne part pas en clair ; un témoin expiré
n'est ni gardé ni renvoyé. C'est ce filtrage qui distingue `-b` d'un
simple `-H "Cookie: …"`, lequel serait envoyé à tout le monde.

### 9.3 Deux ajouts au moteur, et pourquoi ils étaient nécessaires

* **`CookieJar.add()`** — `setFromHeader` refuse un `Domain` qui ne
  correspond pas à l'hôte qui pose le témoin (RFC 6265 §5.3 étape 6),
  ce qui est juste quand un serveur parle et faux quand on RELIT un
  bocal : il n'y a alors aucun hôte qui pose quoi que ce soit, et le
  contrôle a déjà eu lieu à l'écriture.
* **`CookieJar.entries()`** — `all()` ne suffit pas pour écrire un
  bocal. Un témoin posé par `Max-Age` porte son échéance dans
  `expiryMs`, pas dans `Cookie.expires` ; le sérialiser depuis là en
  aurait fait un témoin de **session**, qui disparaît à la relecture.
  Un cas le mesure en comparant l'échéance écrite à l'horloge.

### 9.4 Limites assumées

* **`SameSite` est stocké et ne filtre rien ici** : `cookiesFor` sait
  s'en servir, mais curl n'a pas de « site courant » à lui passer — il
  n'y a pas de page qui en appelle une autre.
* **Le format Netscape ne porte pas `SameSite`** — le vrai fichier de
  curl non plus. Un témoin relu repart donc en `Lax`, la valeur par
  défaut.
* **Le reste de §P4 reste refusé et le dit** (`-x`, `--retry`, `-F`) —
  un cas le vérifie, pour qu'ouvrir cette porte-ci ne laisse pas croire
  que les autres le sont.

`curl-cookies.test.ts` (15 cas), **12 tombent par `git stash`**.


---

## 10. `--version` et quatre options — livré

### 10.1 Le point de départ est un DÉFAUT, pas une absence

`curl --version` répondait :

```
curl: option --version: is unknown
```

Or §3 pose trois familles d'options, et `is unknown` appartient à la
troisième — celle des options qui **n'existent pas chez curl**.
L'appliquer à `--version`, l'option la plus tapée de toutes, était le
seul message de ce fichier qui mentait sur ce que curl EST. Les autres
refus étaient honnêtes ; celui-là ne l'était pas.

### 10.2 Ce que la bannière annonce, et pourquoi pas plus

```
curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13
Release-Date: 2023-12-06
Protocols: http https
Features: IPv6 SSL
```

Les deux dernières lignes sont la partie qui demandait un choix.
Recopier celles du vrai curl (`ftp gopher imap ldap smtp telnet…`,
`HTTPS-proxy TLS-SRP UnixSockets…`) aurait fait annoncer une vingtaine
de schémas et une poignée de capacités que la commande refuse deux
lignes plus bas — exactement le décor que ces PRD passent leur temps à
retirer. Elles disent donc ce que ce curl SERT, et un cas vérifie
l'absence des autres.

`--version` n'exige pas d'URL, puisqu'elle ne transfère rien : l'exiger
ferait répondre le mode d'emploi à la commande qu'on tape précisément
sans URL.

### 10.3 Quatre options qui n'exigeaient aucune invention

Elles étaient refusées honnêtement, et chacune ne demandait qu'une
brique déjà là : un en-tête, une lecture de fichier, une écriture, un
encodage.

* **`-e`/`--referer`** — l'en-tête `Referer`.
* **`-T`/`--upload-file`** — un **PUT**, et non un POST : c'est un
  téléversement, et les confondre changerait la sémantique côté
  serveur. Aucun `Content-Type` n'est imposé, là où `-d` déclare
  `x-www-form-urlencoded` : un fichier n'est pas un formulaire. Un
  fichier absent échoue **avant toute connexion**, avec le code 26 de
  curl — il n'ouvre pas une socket pour découvrir qu'il n'a rien à
  envoyer.
* **`--data-urlencode`** — n'encode QUE la valeur d'une paire
  `nom=valeur`, et la chaîne entière sinon. Encoder le tout enverrait
  `a%3Db%20c`, que rien ne sait relire.
* **`-D`/`--dump-header`** — écrit le bloc d'en-têtes REÇUS dans un
  fichier, sans le corps. C'est ce qui la distingue de `-i`, laquelle
  les mêle au corps ; un cas mesure les deux fichiers séparément.

### 10.4 Ce qui reste refusé

`-x` (proxy), `--retry`, `-F` (formulaires) — un cas le vérifie, pour
qu'ouvrir cinq portes ne laisse pas croire que les autres le sont. Et
une option qui n'existe vraiment pas garde `is unknown`, ce qui
redevient vrai maintenant que `--version` n'y est plus.

`curl-version-et-options.test.ts` (17 cas), **13 tombent par
`git stash`**.


---

## 11. Formulaires et `--retry` — livré

### 11.1 `-F`, la seule option de §P4 qui demandait à ÉCRIRE

Les précédentes branchaient un moteur existant ou posaient un en-tête.
Celle-ci n'avait rien derrière elle : il n'existait nulle part de
sérialiseur `multipart/form-data`. Elle ne demandait pas de brique
nouvelle pour autant — lire un fichier et assembler des octets sont deux
choses que ce curl fait déjà.

Les trois formes de curl sont distinguées, et les confondre serait le
défaut :

| écrit | ce que la partie devient |
|---|---|
| `-F champ=valeur` | un champ ordinaire |
| `-F champ=@fichier` | un TÉLÉVERSEMENT : `filename` et `Content-Type` |
| `-F champ=<fichier` | un champ ordinaire dont la valeur vient du fichier |
| `--form-string champ=@x` | `@` sans aucun sens — sa raison d'être |

`;type=` impose le type d'une partie ; sans lui il se déduit de
l'extension. Un fichier de partie absent échoue **avant toute
connexion**, avec le code 26, comme `-T`.

**La frontière est tirée au hasard**, comme chez curl. Une frontière
fixe finirait par apparaître dans un contenu et couperait le corps en
deux. Les tests s'accrochent donc à sa FORME et à sa présence des deux
côtés — en-tête et corps — jamais à sa valeur. Le corps se termine par
CRLF (RFC 7578 §4.1, qui renvoie à RFC 2046) : un analyseur strict
rejette l'autre.

### 11.2 `--retry`, mesuré sur ce que l'amont a COMPTÉ

Un amont qui échoue deux fois puis répond prouve que la tentative a été
refaite ; compter des lignes de trace ne prouverait que la trace. Les
cas comptent donc les appels reçus par le serveur.

`--retry N` fait **N tentatives EN PLUS de la première** — le compte de
curl. Se tromper d'un ferait échouer un `--retry 1` que le vrai
réussit ; un cas l'épingle.

**Ce qui est transitoire est une liste courte, et c'est délibéré** :
408, 429, 5xx, plus les échecs de connexion (7, 28, 52, 56). Un `404`
ou un certificat invalide ne s'améliorent pas en insistant, et les
retenter ferait perdre du temps sans rien changer. `--retry-all-errors`
existe précisément pour passer outre, et n'a de sens que parce que le
défaut est restrictif — les deux comportements sont mesurés.

**Limite assumée** : `--retry-delay` et l'attente exponentielle de curl
n'existent pas ici, le temps ne s'écoulant pas entre deux requêtes. Le
message annonce donc `Will retry in 0 seconds`, ce qui est vrai de ce
simulateur et faux du vrai curl — l'écrire autrement aurait été
inventer une attente que rien ne subit. `--retry-delay` reste refusée
plutôt qu'acceptée sans effet.

### 11.3 `-x` reste refusée, et ce n'est pas un oubli

On pourrait écrire l'option en une heure. On ne pourrait rien lui faire
traverser : il n'existe aucun mandataire DIRECT dans ce simulateur vers
lequel pointer — le mandataire de nginx (§9 de `PRD-Nginx.md`) est un
mandataire INVERSE, qui ne parle pas le même dialogue. Livrer `-x`
supposerait donc d'écrire d'abord un serveur mandataire, ce qui est un
lot à part entière et non la fin de celui-ci.

`curl-form-et-retry.test.ts` (19 cas), **17 tombent par `git stash`**.

**Deux garde-fous des lots précédents sont tombés à cette occasion, et
c'était leur rôle** : `curl-cookies.test.ts` et
`curl-version-et-options.test.ts` épinglaient `--retry` et `-F` comme
refusées. Ils ne couvrent plus que `-x`.
