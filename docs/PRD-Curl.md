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

## 2. État des lieux, vérifié

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
