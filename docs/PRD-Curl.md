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

- **P4 (proxy, cookies, `--retry`, formulaires) n'est pas fait**, comme le
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
