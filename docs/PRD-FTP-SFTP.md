# PRD — File Transfer : FTP / FTPS (RFC 959, RFC 2228, RFC 4217, RFC 3659, RFC 2428) et renforcement du fil SFTP (draft-ietf-secsh-filexfer)

**Version** : 1.0
**Date** : 2026-07-05
**Projet** : Ubuntu Sandbox — Module FTP/SFTP
**Auteur** : Claude Code
**Références normatives** : RFC 959 (File Transfer Protocol), RFC 2228
(extensions de sécurité FTP — commandes `AUTH`/`ADAT`/`PROT`/`PBSZ`/`CCC`),
RFC 4217 (sécurisation de FTP par TLS — mécanique précise d'`AUTH TLS`,
FTPS explicite vs implicite ; précise et s'appuie sur RFC 2228), RFC 3659
(extensions FTP : `FEAT`, `SIZE`, `MDTM`, `REST`, `MLST`/`MLSD`), RFC 2428
(extensions FTP IPv4/IPv6/NAT : `EPRT`/`EPSV`), RFC 8446 (TLS 1.3 —
prérequis externe pour FTPS, cf. `PRD-TLS.md`, **déjà livré**), draft-ietf-secsh-filexfer-13
(SSH File Transfer Protocol — jamais publié en RFC ; la version 3 du
protocole, implémentée par OpenSSH, en est le standard de facto et la
cible de ce document), RFC 4253/RFC 4254 (SSH Transport/Connection —
déjà implémentés dans ce projet, référence seulement), RFC 1350 (TFTP —
cité uniquement pour justifier son exclusion, § 2.2).

---

## 0. Contexte et portée du document

Ce PRD couvre deux chantiers distincts mais réunis dans un même document
parce qu'ils portent tous deux sur le **transfert de fichiers** et
partagent une dépendance TLS commune :

1. **FTP et FTPS** (RFC 959, RFC 2228/4217, RFC 3659, RFC 2428) :
   construction **greenfield** d'un canal de contrôle FTP réel (connexion,
   commandes texte, réponses à codes numériques), d'un canal de données
   distinct négocié en actif (`PORT`/`EPRT`) ou passif (`PASV`/`EPSV`),
   des commandes de transfert et de navigation, des extensions modernes
   (`FEAT`/`SIZE`/`MDTM`/`REST`/`MLST`/`MLSD`), et de sa sécurisation par
   TLS (`AUTH TLS`/`PBSZ`/`PROT`). **Il n'existe aujourd'hui aucune
   implémentation FTP dans ce dépôt** (§ 1.1) — c'est un protocole
   entièrement à construire, comme RADIUS ou TLS l'étaient avant leurs
   propres PRD.
2. **Renforcement du fil SFTP** (draft-ietf-secsh-filexfer) : contrairement
   à FTP, **SFTP existe déjà** dans ce projet
   (`src/network/protocols/ssh/sftp/`, ~2 200 lignes réparties sur 16
   fichiers) et fonctionne — client interactif, serveur, adaptateurs de
   système de fichiers par OS, décorateurs de permissions/chroot,
   répartiteur de commandes. Mais son encodage sur le fil est un PDU JSON
   simulé (`{op, path, content, ...}`), pas de vrais paquets
   `SSH_FXP_*` numérotés, ses transferts `get`/`put` sont atomiques
   (pas de modèle `OPEN`/`READ`/`WRITE`/`CLOSE` par handle et par plage
   d'octets), et ses erreurs sont un `Result`/`err` générique plutôt que
   les codes `SSH_FX_*` normalisés. Ce PRD **ne réécrit pas** la couche
   sémantique déjà livrée (`ISftpFileSystem`, adaptateurs, décorateurs,
   `SftpCommandDispatcher`) — il ajoute une couche d'encodage fil réel
   en-dessous, dans le même esprit que ce que `PRD-TLS.md` a fait pour le
   key schedule : sémantique réutilisée, fidélité protocolaire renforcée.

**FTPS n'est pas un protocole séparé** : comme HTTPS pour HTTP, c'est FTP
transporté (canal de contrôle, et optionnellement canal de données) par
TLS 1.3. Ce PRD **consomme** le moteur TLS déjà livré par `docs/PRD-TLS.md`
(§2.1) plutôt que de redéfinir TLS — cette dépendance est **déjà
satisfaite** (`PRD-TLS.md` est intégralement livré, P1 à P11), donc aucune
phase de ce document n'est bloquée en amont, contrairement à ce qu'ont connu
`PRD-QUIC.md`/`PRD-HTTP.md` au moment de leur rédaction.

Ce PRD **couvre aussi une migration** (§ 2.1.14) : le seul point de contact
FTP existant dans ce dépôt, le stub `ftp server enable` de
`HuaweiVRPShell.ts` (qui se contente de basculer un booléen global sans
ouvrir la moindre connexion), bascule sur un vrai serveur FTP une fois ce
moteur stabilisé. Côté SFTP, `SshSftpChannel.ts` et
`SftpCommandDispatcher.ts` basculent sur le nouvel encodage de paquets réel
en conservant à l'identique le comportement observable de
`SftpSession.ts`/`ScpTransfer.ts` (aucune régression sur les suites SFTP/
SCP déjà vertes).

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-TLS.md (RFC 8446) — livré, P1 à P11
   │  moteur TLS 1.3 réel (TlsClientSession/TlsServerSession)
   │
   ▼
PRD-FTP-SFTP.md                                          ◄── VOUS ÊTES ICI
   │  FTPS (RFC 2228/4217) consomme directement TlsClientSession/
   │  TlsServerSession — dépendance déjà satisfaite, aucun blocage
   │
   │  SFTP (draft-ietf-secsh-filexfer) consomme le module SSH déjà
   │  livré (src/network/protocols/ssh/) — infrastructure existante et
   │  stable, mais qui n'est PAS un PRD frère de ce groupe (pas de
   │  `PRD-SSH.md` — le module a été construit avant l'introduction de
   │  cette convention de coordination multi-PRD)
   ▼
(aucun consommateur PRD identifié pour l'instant)
```

Contrairement à `PRD-QUIC.md`/`PRD-HTTP.md` au moment de leur rédaction,
ce PRD **n'a aucune dépendance bloquante** : son unique dépendance externe
(`PRD-TLS.md`) est déjà intégralement livrée, et son autre dépendance
(le module SSH/SFTP existant) est du code déjà en production dans ce
dépôt, pas un chantier en cours. Toutes les phases du § 5 peuvent donc
démarrer immédiatement, dans n'importe quel ordre respectant leurs
dépendances internes. C'est un PRD terminal — aucun autre PRD connu n'en
dépend à ce jour. Ce document **ne s'inscrit pas** dans le journal de
coordination multi-agent `docs/tls_quic_http_log.md` (qui, comme son nom
l'indique, est scopé à la seule triade TLS/QUIC/HTTP) — un journal dédié
devra être ouvert séparément si plusieurs agents doivent se coordonner
sur ce PRD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/devices/shells/HuaweiVRPShell.ts` | `ftp server enable` bascule un booléen global (`_setGlobalToggle('ftp', true)`) | **Aucune session FTP réelle** derrière ce commutateur — pas de canal de contrôle, pas de canal de données, pas de commande FTP interprétée |
| `src/network/devices/shells/cisco/CiscoNATCommands.ts` | Texte de `show ip nat statistics` | Déclare explicitement : *« Application Layer Gateways: none (FTP/SIP ALG and NAT64 not supported in this simulator) »* — l'absence de FTP est un choix déjà assumé et documenté côté NAT |
| `src/__tests__/unit/network-v2/nat-pat.test.ts`, `nat-pat-other.test.ts` | Tests de commandes NAT | Vérifient uniquement le **parsing** de `ip nat service ftp` (Cisco) / `nat alg ftp enable` (Huawei) comme bascules de configuration, et l'absence de l'ALG dans les statistiques — aucun test ne porte sur un protocole FTP réel |
| `src/network/core/WellKnownPorts.ts` (l. 29-30) | Dictionnaire de noms de ports IANA | `{20: 'ftp-data'}`, `{21: 'ftp'}` — noms statiques pour l'affichage (bannières, `nmap`), aucune sémantique protocolaire |
| `src/network/core/ports/IanaServiceRegistry.ts` (l. 41-42) | Registre IANA miroir | Mêmes deux entrées, mêmes limites |
| `src/network/devices/DeviceFactory.ts` | Fabrique de périphériques | **Aucune référence à FTP** — aucun rôle serveur FTP n'existe à câbler |
| `src/network/protocols/ssh/sftp/*` (16 fichiers, ~2 200 lignes) | Client/serveur SFTP fonctionnel au-dessus de SSH (`SftpSession.ts`, `SftpCommandDispatcher.ts`, `ISftpFileSystem.ts`, adaptateurs Linux/Windows/Router/VFS, `PermissionCheckingFSDecorator.ts`, `ChrootedSftpFileSystem.ts`) | Sémantique **réelle et complète** au niveau applicatif (`get`/`put`/`ls`/`mkdir`/`rm`/`rmdir`/`rename`/`chmod`/`chown`/`stat`/`df`/`version`/`cd`/`pwd`) mais **encodage fil simulé** : enveloppe JSON `{op, path, content, ...}` sur `SshSftpChannel`, pas d'opcodes `SSH_FXP_*` numérotés, **transferts `get`/`put` atomiques** (tout le fichier en un aller-retour, pas de `OPEN`/`READ`/`WRITE`/`CLOSE` par handle et par plage d'octets), **pas de codes `SSH_FX_*` numériques** (un `Result`/`err({kind, message})` générique à la place), **version SFTP figée à 3 sans négociation `SSH_FXP_INIT`/`VERSION` réelle**, aucune commande `SYMLINK`/`READLINK` |
| `src/network/protocols/ssh/scp/{ScpSession.ts,ScpTransfer.ts}` | SCP au-dessus de l'abstraction `ISftpFileSystem` | Fonctionnel et déjà testé ; **aucun gap identifié** ne justifie d'y toucher dans ce PRD (§ 2.2) |
| `src/network/protocols/ssh/session/SshSession.ts`, `channels/SshSftpChannel.ts`, `server/SshServerHandler.ts` | Transport SSH (connexion, authentification, canaux) | Solide et stable ; seul le **contenu transporté** par `ISshSftpChannel.sendRequest`/la boucle `onData` change dans ce PRD, pas le transport SSH lui-même |

### 1.2 Ce qui existe déjà et est réutilisable

- **`TcpStack`/`TcpSocket`** (`src/network/tcp/`) — porte à la fois le
  canal de contrôle FTP (port 21) et le canal de données FTP (port
  éphémère négocié par `PORT`/`PASV`/`EPRT`/`EPSV`), exactement comme il
  porte déjà HTTP/TLS/SSH.
- **`@/network/pki` + `TlsClientSession`/`TlsServerSession`**
  (`docs/PRD-TLS.md`, **livré**) — consommés tels quels pour `AUTH TLS`,
  sans aucune nouvelle primitive cryptographique, à l'image de ce que
  `PRD-HTTP.md` a fait pour HTTPS (§2.1.K de ce PRD frère).
- **`src/network/protocols/ssh/sftp/` en entier** : `ISftpFileSystem`
  (interface segmentée ISP : `ISftpNavigable`/`ISftpReadable`/
  `ISftpWritable`), les adaptateurs Linux/Windows/Router/VFS,
  `PermissionCheckingFSDecorator`, `ChrootedSftpFileSystem`,
  `SftpCommandDispatcher` + `ISftpCommand` (pattern Command déjà en
  place) — **tout ceci reste la couche sémantique** ; ce PRD n'en
  réécrit que l'encodage fil et le modèle de handles (§ 2.1.10-13).
- **`SshSession`/`SshChannelManager`/`ISshSftpChannel`** — transport SSH
  existant et stable ; seul le contenu transporté (encodage des paquets
  SFTP) change.
- **`EventBus`/`Signal`** (`src/events/`) — bus d'événements typé déjà
  utilisé par TLS/QUIC/HTTP/RADIUS pour l'observabilité (§ 2.1.9/2.1.14).
- **Convention de fidélité « crypto simulée, forme du protocole réelle »**
  déjà établie par `PkiKeyPair`, `SimulatedTls.ts`, le moteur TLS de
  `PRD-TLS.md` — directement applicable à FTPS et au fil SFTP.
- **`ChrootedSftpFileSystem`** — modèle de racine par utilisateur déjà
  résolu côté SFTP ; le serveur FTP réutilise le même principe (§2.1.8)
  plutôt que d'en inventer un nouveau.

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | Aucune implémentation du canal de contrôle FTP (connexion, commandes texte, réponses à codes numériques, machine à états de session) | RFC 959 §3-5 | Bloquant |
| 2 | Aucun modèle de canal de données actif/passif distinct du canal de contrôle | RFC 959 §2.3, RFC 2428 | Bloquant |
| 3 | Aucune sécurisation FTP (`AUTH TLS`/`PBSZ`/`PROT`) | RFC 2228, RFC 4217 | Élevée |
| 4 | Aucune extension moderne (`FEAT`/`SIZE`/`MDTM`/`REST`/`MLST`/`MLSD`) | RFC 3659 | Moyenne |
| 5 | SFTP : encodage fil simulé (JSON), pas d'opcodes `SSH_FXP_*` réels ni de négociation de version | draft-ietf-secsh-filexfer §4 | Moyenne |
| 6 | SFTP : transferts atomiques, pas de modèle de handle `OPEN`/`READ`/`WRITE`/`CLOSE` par plage d'octets (pas de reprise ni de streaming partiel) | draft-ietf-secsh-filexfer §6.4-6.7 | Moyenne |
| 7 | SFTP : pas de codes de statut `SSH_FX_*` numériques normalisés, pas de `SYMLINK`/`READLINK` | draft-ietf-secsh-filexfer §7/§9 | Faible |
| 8 | L'ALG FTP à travers NAT (réécriture des adresses/ports dans `PORT`/`PASV`) reste non supporté même après ce PRD | — (déjà noté non supporté par `CiscoNATCommands.ts`) | Faible (non-objectif assumé, § 2.2) |

**Conclusion de la phase d'analyse** : FTP est un chantier entièrement
greenfield — comparable à l'état de TLS ou RADIUS avant leur propre PRD —
tandis que SFTP est un chantier de **renforcement de fidélité fil** sur une
base sémantique déjà solide et déjà testée. Les deux chantiers partagent
une dépendance TLS commune (déjà satisfaite) mais sont par ailleurs
indépendants l'un de l'autre : rien n'empêche de livrer FTP sans toucher
SFTP, ou l'inverse, dans n'importe quel ordre.

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

**1. RFC 959 — Canal de contrôle FTP.** Connexion TCP/21, échange de
commandes texte (verbe + argument optionnel, terminées par CRLF) et de
réponses à code numérique à 3 chiffres (classes 1xx/2xx/3xx/4xx/5xx) avec
texte explicatif, y compris les réponses multi-lignes (§4.2, dernière ligne
préfixée par `code espace`, lignes intermédiaires par `code-`). Machine à
états de session (non connecté → attente d'authentification →
authentifié → transfert en cours) modélisée explicitement, à l'image de
`TlsClientSession`/`TlsServerSession`. Commandes minimales : `USER`,
`PASS`, `ACCT`, `TYPE` (`A`/`I` — ASCII/Image), `STRU F` (structure
fichier, la seule courante), `MODE S` (flux, la seule courante), `SYST`,
`NOOP`, `QUIT`, `ABOR` (interruption d'un transfert en cours).

**2. RFC 959 §2.3, RFC 2428 — Canal de données actif/passif.** Un
**deuxième** `TcpConnection`, réellement distinct du canal de contrôle,
négocié soit en mode actif (`PORT`/`EPRT` : le client ouvre un port et le
serveur s'y connecte), soit en mode passif (`PASV`/`EPSV` : le serveur
ouvre un port éphémère et communique son adresse/port, le client s'y
connecte) — un vrai deuxième port TCP réellement ouvert et réellement
utilisé pour le transfert, pas un indicateur booléen. `EPRT`/`EPSV`
(RFC 2428) généralisent `PORT`/`PASV` à IPv6 et évitent de coder en dur le
format d'adresse IPv4 dans la commande — pertinent puisque ce simulateur
a déjà IPv6.

**3. RFC 959 §4 — Commandes de transfert et de navigation.** Transfert :
`RETR` (téléchargement), `STOR`/`STOU`/`APPE` (envoi, envoi avec nom
unique, ajout en fin de fichier). Listing : `LIST` (format
« humain », proche de `ls -l`), `NLST` (noms seuls). Navigation/gestion :
`PWD`, `CWD`, `CDUP`, `MKD`, `RMD`, `DELE`, `RNFR`+`RNTO` (renommage en
deux commandes, comme le prescrit la RFC).

**4. Sémantique des réponses fidèle.** Dictionnaire de codes complet avec
leur texte conventionnel et leurs cas d'usage réels : `220` (bannière),
`230` (authentifié), `331` (mot de passe requis), `425` (impossible
d'ouvrir le canal de données), `426` (transfert interrompu), `450`/`550`
(fichier indisponible/non trouvé), `530` (non authentifié), `550`
(permission refusée ou chemin invalide) — chaque commande du § 2.1.1/2.1.3
mappée vers son (ou ses) code(s) de réponse réel(s) selon la RFC, pas un
succès/échec binaire générique.

**5. RFC 2228 + RFC 4217 — FTPS explicite (dépend de `PRD-TLS.md`,
**déjà livré**).** `AUTH TLS` bascule le canal de contrôle sur un vrai
handshake `TlsClientSession`/`TlsServerSession` (RFC 8446, moteur déjà
construit — aucune nouvelle primitive cryptographique introduite ici).
`PBSZ 0` puis `PROT P` (protection totale du canal de données, chiffré
lui aussi) ou `PROT C` (canal de données en clair, seul le contrôle est
protégé) sont réellement honorés : un canal de données ouvert sous
`PROT P` négocie lui aussi un handshake TLS. FTPS **explicite** (RFC 4217,
`AUTH TLS` sur le port 21 standard) est l'objectif principal ; FTPS
**implicite** (TLS dès l'ouverture de la connexion, port 990
conventionnel, sans échange `AUTH`) est une variante de configuration du
même moteur, pas un protocole distinct.

**6. RFC 3659 — Extensions modernes.** `FEAT` (annonce la liste des
extensions supportées par le serveur, une par ligne de la réponse `211`
multi-lignes). `SIZE` (taille exacte d'un fichier, mode binaire).
`MDTM` (date de dernière modification, format `YYYYMMDDHHMMSS`). `REST`
(reprise de transfert : positionne un offset réel avant le prochain
`RETR`/`STOR`, honoré par le moteur de canal de données). `MLST`/`MLSD`
(listage machine-readable normalisé, faits `type=file;size=1234;
modify=20260705120000;` par entrée, remplaçant l'ambiguïté de format de
`LIST`).

**7. Modèle de session serveur multi-utilisateur et racine confinée.**
Authentification `USER`/`PASS` contre un référentiel de comptes cohérent
avec les autres services du projet (même modèle que l'authentification
SSH/RADIUS existante). Racine par utilisateur confinée, sur le même
principe que `ChrootedSftpFileSystem` déjà livré côté SFTP (§ 1.2) —
réutilisation du concept, pas de nouvelle abstraction de confinement.

**8. Client FTP en ligne de commande.** Un nouveau gestionnaire de
commande `ftp` exposé dans les shells Linux/Windows, consommant ce moteur
(connexion, authentification, `get`/`put`/`ls`/`cd`, mode passif par
défaut), à l'image de la manière dont `curl`/`wget` consomment le moteur
HTTP de `PRD-HTTP.md`.

**9. Observabilité FTP.** Événements bus dédiés
(`ftp.control.connected/authenticated/closed`,
`ftp.data.opened/closed`, `ftp.transfer.started/completed/failed`,
`ftp.command.received`, `ftps.tls.established`) exploitables par les
logs réseau et les tests, à l'image du reste du projet.

**10. draft-ietf-secsh-filexfer §4 — Encodage fil SFTP réel.** Un codec
qui encode/décode de vrais paquets `SSH_FXP_*` numérotés (`INIT`,
`VERSION`, `OPEN`, `CLOSE`, `READ`, `WRITE`, `LSTAT`, `FSTAT`, `SETSTAT`,
`OPENDIR`, `READDIR`, `REMOVE`, `MKDIR`, `RMDIR`, `REALPATH`, `RENAME`,
`READLINK`, `SYMLINK`, plus les réponses `STATUS`/`HANDLE`/`DATA`/`NAME`/
`ATTRS`), chacun porteur d'un identifiant de requête (`request-id`)
explicite, en remplacement de l'enveloppe JSON `{op, ...}` actuelle —
**réutilise entièrement** `ISftpFileSystem`/`SftpCommandDispatcher`/les
décorateurs déjà en place (§ 1.2) : seul l'encodage change, pas la
sémantique des opérations.

**11. draft-ietf-secsh-filexfer §6.4-6.7 — Modèle de handle réel.** `OPEN`
retourne un handle opaque (chaîne d'octets simulée) enregistré dans une
table de handles par session ; `READ`/`WRITE` opèrent par
`(handle, offset, longueur)` sur ce handle plutôt que sur le fichier
entier ; `CLOSE` libère le handle. Remplace le `get`/`put` atomique
actuel tout en gardant `ISftpReadable`/`ISftpWritable` comme
implémentation sous-jacente (le handle devient un curseur logique
au-dessus de ces mêmes méthodes).

**12. draft-ietf-secsh-filexfer §7/§9.1 — Codes de statut réels et
liens symboliques.** Table `SSH_FX_OK`/`SSH_FX_EOF`/`SSH_FX_NO_SUCH_FILE`/
`SSH_FX_PERMISSION_DENIED`/`SSH_FX_FAILURE`/`SSH_FX_BAD_MESSAGE`/
`SSH_FX_NO_CONNECTION`/`SSH_FX_CONNECTION_LOST`/`SSH_FX_OP_UNSUPPORTED`,
alimentée par une correspondance depuis le `Result`/`err({kind, message})`
existant (la couche sémantique garde son modèle d'erreur interne ; seule
la traduction en sortie de fil change). `SYMLINK`/`READLINK` complètent
le dispatcher de commandes existant.

**13. draft-ietf-secsh-filexfer §4 — Négociation de version réelle.**
Échange `SSH_FXP_INIT` (version proposée par le client) /
`SSH_FXP_VERSION` (version retenue par le serveur, extensions
optionnelles en paires nom/donnée) — la version 3 reste la version cible
(compatibilité OpenSSH la plus large, cohérent avec l'existant), mais la
négociation elle-même devient réelle au lieu d'être une constante figée.

**14. Observabilité SFTP.** Événements bus dédiés
(`sftp.packet.sent/received`, `sftp.handle.opened/closed`,
`sftp.transfer.progress`) — même convention que le reste du projet.

**15. Migration des consommateurs existants.** Une fois les deux moteurs
stabilisés (§ 5, phases P1-P12 vertes) : le stub `ftp server enable` de
`HuaweiVRPShell.ts` bascule sur un vrai serveur FTP (le port 21 s'ouvre
réellement quand la fonctionnalité est activée, avec le canal de contrôle
et les commandes de ce PRD) ; côté SFTP, `SshSftpChannel.ts` et
`SftpCommandDispatcher.ts` basculent sur le nouvel encodage de paquets
réel (§2.1.10-13) en conservant à l'identique le comportement observable
de `SftpSession.ts`/`ScpTransfer.ts`/`SftpInteractiveSession.ts` (aucune
régression sur les suites SFTP/SCP déjà vertes — § 7 risque dédié).
`ScpSession.ts`/`ScpTransfer.ts` ne sont **pas** migrés (§ 2.2) : ils
restent au-dessus de `ISftpFileSystem`, qui ne change pas.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **FTP ALG à travers NAT** (réécriture des adresses/ports embarqués dans
  `PORT`/`PASV`/`EPRT`/`EPSV` par un routeur NAT en chemin) — déjà
  explicitement non supporté (`CiscoNATCommands.ts`, § 1.1), reste hors
  périmètre ; un chantier NAT dédié serait nécessaire et n'est pas
  demandé ici.
- **FXP** (File eXchange Protocol, transfert serveur-à-serveur direct
  via `PASV` sur un serveur et `PORT` vers ce même serveur depuis un
  autre) — techniquement permis par RFC 959 mais aucun cas d'usage
  identifié dans ce simulateur ; écarté du même principe que SCP écarte
  déjà le remote-to-remote (§ 1.1).
- **SFTP versions 4/5/6** (révisions ultérieures du brouillon : ACL
  étendues, types de fichiers spéciaux, attributs étendus) — la version 3
  reste la cible, cohérent avec l'implémentation existante et avec la
  compatibilité OpenSSH la plus large.
- **Réécriture de la couche sémantique SFTP existante**
  (`ISftpFileSystem`, adaptateurs par OS, décorateurs,
  `SftpCommandDispatcher`) — réutilisée telle quelle ; seuls l'encodage
  fil et le modèle de handle évoluent (§ 2.1.10-13).
- **SCP** — déjà fonctionnel au-dessus de `ISftpFileSystem` ; aucun gap
  identifié en § 1.3 ne justifie d'y toucher.
- **TFTP** (RFC 1350) — protocole distinct (UDP, pas de canal de
  contrôle textuel, pas d'authentification), sans rapport structurel avec
  FTP au-delà du nom ; hors périmètre.
- **Vrai chiffrement/vraie négociation cryptographique** — déjà simulé au
  niveau de `@/network/tls`/`@/network/pki` ; ce PRD ne remet pas en
  cause cette convention (§2.2 de `PRD-TLS.md`, hérité tel quel).
- **`MODE C`** (mode de transfert compressé, RFC 959, rarement voire
  jamais utilisé par les clients/serveurs réels courants) — écarté.
- **Client/serveur FTP graphique ou synchronisation de répertoires**
  (type client FTP façon FileZilla, miroir bidirectionnel) — seule
  l'interaction en ligne de commande est demandée (§2.1.8), à l'image du
  `ftp`/`sftp` shell existants.

---

## 3. Architecture cible

### 3.1 Principe directeur

**Additif d'abord, migration ensuite en un point de bascule net** — même
discipline que `PRD-TLS.md`/`PRD-HTTP.md`. FTP est construit
**greenfield**, en couches strictement empilées (canal de contrôle →
canal de données → sécurité FTPS → extensions modernes), sans toucher à
aucun fichier existant avant la phase de migration dédiée (§ 5, P13). SFTP
est renforcé par **remplacement progressif de sa seule couche d'encodage
fil** (`SftpWireCodec`/`SftpHandleTable`/`SftpStatusCodes`, tous
nouveaux), sans jamais modifier la couche sémantique déjà livrée
(`ISftpFileSystem` et ses adaptateurs/décorateurs) — le principe déjà
appliqué par `PRD-TLS.md` (« le key schedule est une fonction pure
testable indépendamment de toute session réseau ») se retrouve ici sous
la forme « le codec fil SFTP est un adaptateur testable indépendamment de
toute logique de système de fichiers ».

### 3.2 Diagramme de couches

```
┌────────────────────────────────────────────────────────────────────┐
│ Consommateurs (hors périmètre, inchangés tant que P13 n'est pas    │
│ atteinte) :                                                        │
│   ScpSession.ts/ScpTransfer.ts · SftpInteractiveSession.ts ·        │
│   shells Linux/Windows/Cisco/Huawei                                │
├────────────────────────────────────────────────────────────────────┤
│ Migré par ce PRD (§ 2.1.15, P13) :                                  │
│   HuaweiVRPShell.ts (« ftp server enable » → vrai serveur FTP)      │
│   SshSftpChannel.ts / SftpCommandDispatcher.ts (nouvel encodage)    │
├────────────────────────────────────────────────────────────────────┤
│  FTP (RFC 959/2428/3659)          │  SFTP (draft-secsh-filexfer)    │
│  ftp/ControlSession.ts             │  sftp/SftpWireCodec.ts (NOUVEAU)│
│  ftp/DataChannel.ts                │  sftp/SftpHandleTable.ts(NOUVEAU)│
│  ftp/commands/*.ts                 │  sftp/SftpStatusCodes.ts(NOUVEAU)│
│  ftp/replies.ts                     │  sftp/SftpCommandDispatcher.ts │
│  ftp/extensions.ts (RFC 3659)       │    (existant, réutilisé)      │
│                                     │  sftp/ISftpFileSystem.ts+adapt.│
│                                     │    (existant, réutilisé)      │
├────────────────────────────────────────────────────────────────────┤
│  FTPS (RFC 2228/4217) — AUTH TLS/PBSZ/PROT via le moteur de         │
│  `PRD-TLS.md` (livré) : TlsClientSession/TlsServerSession           │
├────────────────────────────────────────────────────────────────────┤
│  TcpStack/TcpSocket (canal de contrôle + canal de données FTP)      │
│  src/network/protocols/ssh/ (transport SSH, inchangé)               │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/ftp/                       # NOUVEAU — protocole FTP entier
├── types.ts                           # ReplyCode, FtpCommand, DataChannelMode, etc.
├── ControlSession.ts                  # machine à états du canal de contrôle (client + serveur)
├── DataChannel.ts                     # canal de données actif (PORT/EPRT) / passif (PASV/EPSV)
├── commands/                          # une classe par commande (pattern Command), RETR/STOR/LIST/...
│   ├── ICommand.ts
│   ├── RetrCommand.ts, StorCommand.ts, ListCommand.ts, ...
│   └── CommandDispatcher.ts
├── replies.ts                         # dictionnaire codes 1xx-5xx + formattage multi-ligne (§4.2)
├── ftps.ts                            # AUTH TLS/PBSZ/PROT — consomme @/network/tls
├── extensions.ts                      # FEAT/SIZE/MDTM/REST/MLST/MLSD (RFC 3659)
├── events.ts                          # ftp.control.*, ftp.data.*, ftp.transfer.*
└── observables.ts                     # flux dérivés (tests/UI)

src/network/protocols/ssh/sftp/
├── SftpWireCodec.ts                   # NOUVEAU — encode/décode les paquets SSH_FXP_* réels
├── SftpHandleTable.ts                 # NOUVEAU — handles opaques pour OPEN/READ/WRITE/CLOSE
├── SftpStatusCodes.ts                 # NOUVEAU — SSH_FX_* + correspondance depuis Result/err
├── events.ts, observables.ts          # NOUVEAU — sftp.packet.*, sftp.handle.*
├── SftpCommandDispatcher.ts           # existant, réutilisé tel quel (pattern Command)
├── ISftpFileSystem.ts, *Adapter.ts,   # existants, réutilisés tels quels
│   PermissionCheckingFSDecorator.ts,
│   ChrootedSftpFileSystem.ts
└── SftpSession.ts, SftpCommands.ts    # existants — inchangés jusqu'à P13 (§ 2.1.15)
```

Note de frontière : ce PRD **ne touche pas**
`src/network/protocols/ssh/scp/` (SCP, § 2.2) ni la logique interne des
adaptateurs de système de fichiers (`LinuxSftpFSAdapter.ts`,
`WindowsSftpFSAdapter.ts`, `RouterSftpFileSystem.ts`, `VfsSftpFileSystem.ts`)
— seule leur consommation via le nouveau codec fil change, pas leur
implémentation.

### 3.4 Design patterns retenus

- **Machine à états explicite** (`ControlSession`, côtés client et
  serveur), à l'image de `TlsClientSession`/`TlsServerSession`.
- **Command** côté FTP (une classe par verbe, `commands/`) — réplique
  volontairement le pattern déjà en place côté SFTP
  (`SftpCommandDispatcher`/`ISftpCommand`), pour que les deux protocoles
  de ce PRD partagent la même discipline architecturale.
- **Adapter** (`SftpWireCodec`) : adapte l'enveloppe JSON existante
  vers/depuis de vrais paquets `SSH_FXP_*` simulés, sans toucher
  `ISftpFileSystem` ni `SftpCommandDispatcher` — un point d'insertion net
  entre le transport (`SshSftpChannel`) et la sémantique (dispatcher).
- **Strategy** pour le canal de données (actif vs passif), à l'image des
  stratégies d'authentification (`ISshAuthMethod`) et de vérification de
  clé d'hôte déjà en place côté SSH.
- **Réutilisation stricte de la PKI/TLS** (`@/network/tls`,
  `@/network/pki`) — aucune nouvelle primitive cryptographique
  introduite, comme `PRD-HTTP.md` l'a fait pour HTTPS.
- **Décorateur** réutilisé tel quel côté SFTP
  (`PermissionCheckingFSDecorator`, `ChrootedSftpFileSystem`) — le
  serveur FTP applique le même principe de confinement par racine
  utilisateur (§ 2.1.7) plutôt que d'introduire un mécanisme parallèle.

---

## 4. Modèle de données

### 4.1 Commande et réponse FTP (RFC 959 §4)

```
interface FtpCommand {
  readonly verb: string;              // 'USER', 'RETR', 'PASV', ...
  readonly argument?: string;
}

interface FtpReply {
  readonly code: number;              // 220, 230, 331, 425, 530, 550, ...
  readonly lines: readonly string[];  // >1 ligne => format multi-ligne §4.2
}
```

### 4.2 Canal de données (RFC 959 §2.3, RFC 2428)

```
type DataChannelMode = 'active' | 'passive';

interface DataChannelEndpoint {
  readonly mode: DataChannelMode;
  readonly address: IPAddress | IPv6Address;
  readonly port: number;              // port éphémère réellement ouvert
}
```

### 4.3 État FTPS (RFC 2228, RFC 4217)

```
interface FtpsState {
  readonly controlProtected: boolean;       // AUTH TLS réussi sur le canal de contrôle
  readonly dataProtectionLevel: 'C' | 'P';  // PROT C (clair) ou PROT P (protégé)
  readonly controlTls: TlsClientSession | TlsServerSession | null;
  readonly dataTls: TlsClientSession | TlsServerSession | null;
}
```

### 4.4 Extensions RFC 3659

```
interface MlsxFact {
  readonly type: 'file' | 'dir' | 'cdir' | 'pdir';
  readonly size?: number;
  readonly modify: string;            // YYYYMMDDHHMMSS
  readonly perm?: string;
}
```

### 4.5 Paquet SFTP (draft-ietf-secsh-filexfer §4)

```
type SftpPacketType =
  | 'SSH_FXP_INIT' | 'SSH_FXP_VERSION'
  | 'SSH_FXP_OPEN' | 'SSH_FXP_CLOSE' | 'SSH_FXP_READ' | 'SSH_FXP_WRITE'
  | 'SSH_FXP_LSTAT' | 'SSH_FXP_FSTAT' | 'SSH_FXP_SETSTAT'
  | 'SSH_FXP_OPENDIR' | 'SSH_FXP_READDIR'
  | 'SSH_FXP_REMOVE' | 'SSH_FXP_MKDIR' | 'SSH_FXP_RMDIR'
  | 'SSH_FXP_REALPATH' | 'SSH_FXP_RENAME'
  | 'SSH_FXP_READLINK' | 'SSH_FXP_SYMLINK'
  | 'SSH_FXP_STATUS' | 'SSH_FXP_HANDLE' | 'SSH_FXP_DATA'
  | 'SSH_FXP_NAME' | 'SSH_FXP_ATTRS';

interface SftpPacket {
  readonly type: SftpPacketType;
  readonly requestId: number;
  readonly payload: Uint8Array;        // encodage spécifique au type
}
```

### 4.6 Handle et statut SFTP (draft-ietf-secsh-filexfer §6.2, §9.1)

```
interface SftpHandle {
  readonly id: string;                 // opaque, généré à l'OPEN/OPENDIR
  readonly path: string;
  readonly mode: 'read' | 'write' | 'dir';
  readonly fs: ISftpFileSystem;        // délégation vers la couche existante
}

type SftpStatusCode =
  | 'SSH_FX_OK' | 'SSH_FX_EOF' | 'SSH_FX_NO_SUCH_FILE'
  | 'SSH_FX_PERMISSION_DENIED' | 'SSH_FX_FAILURE' | 'SSH_FX_BAD_MESSAGE'
  | 'SSH_FX_NO_CONNECTION' | 'SSH_FX_CONNECTION_LOST'
  | 'SSH_FX_OP_UNSUPPORTED';
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Canal de contrôle FTP nominal (959 §3-5)** | `types.ts`/`ControlSession.ts`/`replies.ts` : connexion, bannière `220`, `USER`/`PASS`/`ACCT`, réponses à code + multi-lignes, `QUIT`/`NOOP`/`SYST` — testable sans canal de données | — |
| **P2 — Canal de données actif/passif + transfert (959 §2.3/§4)** | `DataChannel.ts`, `commands/` : `PORT`/`PASV`, `RETR`/`STOR`/`STOU`/`APPE`, `LIST`/`NLST` | P1 |
| **P3 — Navigation et gestion de fichiers (959 §4)** | `PWD`/`CWD`/`CDUP`/`MKD`/`RMD`/`DELE`/`RNFR`+`RNTO`, racine confinée par utilisateur (§2.1.7) | P1 |
| **P4 — Extensions IPv4/IPv6/NAT modernes (2428)** | `EPRT`/`EPSV` en généralisation de `PORT`/`PASV` | P2 |
| **P5 — Extensions RFC 3659** | `FEAT`, `SIZE`, `MDTM`, `REST` (reprise avec offset réel honoré par P2), `MLST`/`MLSD` | P2, P3 |
| **P6 — FTPS explicite (2228/4217, dépend du moteur TLS déjà livré)** | `ftps.ts` : `AUTH TLS`, `PBSZ 0`, `PROT C`/`P` sur le canal de contrôle et, sous `PROT P`, sur le canal de données | P1, **moteur TLS de `PRD-TLS.md` (livré)** |
| **P7 — Client FTP en ligne de commande** | Gestionnaire de commande `ftp` dans les shells Linux/Windows (§2.1.8) | P1–P6 |
| **P8 — Observabilité FTP** | `events.ts`/`observables.ts` | P1–P7 |
| **P9 — Encodage fil SFTP réel (draft-secsh-filexfer §4)** | `SftpWireCodec.ts` : paquets `SSH_FXP_*` + `request-id`, négociation `INIT`/`VERSION` réelle — branché entre `SshSftpChannel` et `SftpCommandDispatcher` sans modifier ce dernier | infrastructure SSH/SFTP existante (§ 1.2) |
| **P10 — Modèle de handle SFTP réel (§6.4-6.7)** | `SftpHandleTable.ts` : `OPEN`/`OPENDIR` → handle, `READ`/`WRITE` par offset+longueur, `CLOSE` | P9 |
| **P11 — Codes de statut réels + liens symboliques (§7/§9.1)** | `SftpStatusCodes.ts` (table `SSH_FX_*` + correspondance depuis `Result`/`err`), `SYMLINK`/`READLINK` dans le dispatcher existant | P9, P10 |
| **P12 — Observabilité SFTP** | `events.ts`/`observables.ts` dans `src/network/protocols/ssh/sftp/` | P9–P11 |
| **P13 — Migration des consommateurs existants (§ 2.1.15)** | `HuaweiVRPShell.ts` (« ftp server enable » → vrai serveur FTP) ; `SshSftpChannel.ts`/`SftpCommandDispatcher.ts` basculent sur le nouvel encodage réel, comportement observable inchangé pour `SftpSession.ts`/`ScpTransfer.ts`/`SftpInteractiveSession.ts` | P1–P12 |

Chaque phase suit le cycle rouge → vert → refactor. Pendant P1–P12, ce
module reste strictement additif (§ 3.4) : aucune suite existante
(`nat-pat`, `nat-pat-other`, les suites `sftp-*`/`scp-*`, les tests de
shell Huawei/Cisco) n'est censée changer. **P13 change délibérément ce
principe** pour les seules suites SFTP/SCP concernées : leur comportement
observable (résultats de `get`/`put`/`ls`/`mkdir`/etc., sorties de
`ScpTransfer`) doit rester identique, mais l'encodage interne du fil SFTP
change (§ 7).

---

## 6. Stratégie de test

1. **Unitaires canal de contrôle FTP** : parsing/formatage
   commande ↔ réponse, machine à états (transitions valides/invalides,
   ex. `RETR` avant authentification → `530`), réponses multi-lignes
   round-trip.
2. **Unitaires canal de données** : `PORT` (client ouvre, serveur se
   connecte) et `PASV` (serveur ouvre, client se connecte) aboutissent
   chacun à un vrai transfert d'octets sur un port distinct du contrôle ;
   `EPRT`/`EPSV` round-trip pour une adresse IPv6.
3. **Unitaires transfert/navigation** : `RETR`/`STOR` round-trip
   byte-exact (y compris binaire arbitraire, pas seulement ASCII),
   `LIST`/`NLST` cohérents avec le contenu réel du répertoire,
   `RNFR`+`RNTO` renomme effectivement, `DELE`/`RMD` échouent proprement
   (`550`) sur un chemin inexistant.
4. **Unitaires extensions RFC 3659** : `FEAT` annonce exactement les
   extensions implémentées, `SIZE`/`MDTM` cohérents avec le système de
   fichiers, `REST` suivi d'un `RETR` reprend bien à l'offset demandé,
   `MLSD` produit des faits `type=`/`size=`/`modify=` corrects.
5. **Unitaires/intégration FTPS** : `AUTH TLS` aboutit à un vrai
   handshake TLS 1.3 (contre le moteur de `PRD-TLS.md`) sur le canal de
   contrôle ; `PROT P` protège effectivement le canal de données (un
   flux en clair intercepté ne doit pas être lisible tel quel) ; certificat
   serveur non approuvé → échec propre (alerte TLS), pas de repli
   silencieux en clair.
6. **Unitaires codec fil SFTP** : round-trip encode/décode pour chacun
   des types `SSH_FXP_*`, `INIT`/`VERSION` négocie bien la version 3,
   `request-id` correctement corrélé entre requête et réponse.
7. **Unitaires handle SFTP** : `OPEN` puis plusieurs `READ`/`WRITE`
   partiels à des offsets différents produisent le même résultat qu'un
   `get`/`put` atomique équivalent ; `CLOSE` invalide le handle (un
   `READ` ultérieur sur un handle fermé échoue avec le bon code de
   statut).
8. **Unitaires statuts/liens symboliques** : chaque branche d'erreur de
   la couche `ISftpFileSystem` existante se traduit vers le bon
   `SSH_FX_*` ; `SYMLINK`/`READLINK` round-trip sur les adaptateurs qui
   supportent déjà les symlinks dans leur typage (`EntryType`).
9. **Non-régression (P1–P12)** : exécution complète des suites FTP/SFTP
   nouvellement créées et des suites existantes (`nat-pat*`, `sftp-*`,
   `scp-*`, shells Huawei/Cisco) après chaque phase, garantissant
   l'absence d'effet de bord tant que P13 n'est pas atteinte.
10. **Migration (P13)** : suites SFTP/SCP existantes ré-exécutées après
    bascule sur le nouveau codec fil — vérifier que les comportements
    observables (contenu transféré, listes de répertoire, codes
    d'erreur applicatifs) sont **identiques** à l'avant-migration ; test
    dédié pour le nouveau serveur FTP Huawei (le port 21 s'ouvre
    réellement une fois la fonctionnalité activée).

---

## 7. Risques et points d'attention

1. **FTP est un chantier entièrement greenfield** : contrairement à SFTP,
   il n'y a aucune base existante à auditer au-delà de deux noms de port
   et d'un commentaire d'exclusion NAT — le risque n'est pas la
   régression mais la sous-estimation de la surface RFC 959 (codes de
   réponse, cas d'erreur, interactions `TYPE`/`STRU`/`MODE`).
2. **Le canal de données est le point de complexité principal** :
   contrairement à HTTP/TLS/SFTP qui n'ouvrent qu'une seule connexion,
   FTP en ouvre structurellement deux, avec une négociation
   asymétrique (actif = client écoute, passif = serveur écoute) — ne pas
   sous-dimensionner `DataChannel.ts` en le traitant comme un simple flag
   sur le canal de contrôle.
3. **FTPS hérite des limites de `PRD-TLS.md` §2.2** (cryptographie
   simulée, pas d'ECH, etc.) sans les redéfinir — documenter que ce PRD
   ne cherche pas à dépasser la fidélité déjà actée pour TLS.
4. **`PROT P` sur le canal de données est facile à oublier** : un
   développeur pressé pourrait ne protéger que le canal de contrôle
   (`AUTH TLS` seul) et laisser le canal de données en clair par défaut,
   contredisant RFC 4217 — les tests (§6.5) doivent vérifier
   explicitement les deux canaux séparément.
5. **SFTP : ne pas dupliquer la logique métier dans le nouveau codec** —
   `SftpWireCodec`/`SftpHandleTable` doivent rester des adaptateurs purs
   au-dessus de `ISftpFileSystem`/`SftpCommandDispatcher` existants ;
   toute logique de permission/chroot dupliquée dans le codec serait une
   régression architecturale (§ 3.4).
6. **SFTP : le modèle de handle change la surface d'erreur observable** —
   un `READ` sur un handle jamais ouvert, déjà fermé, ou périmé doit
   produire un code `SSH_FX_*` cohérent ; ne pas laisser cette surface
   nouvelle (absente du modèle atomique actuel) sous-testée.
7. **Confinement par racine utilisateur (§2.1.7) dupliqué entre FTP et
   SFTP** : les deux protocoles visent le même principe
   (`ChrootedSftpFileSystem`) — vérifier qu'un même compte utilisateur
   voit la même racine confinée qu'il se connecte en FTP ou en SFTP,
   sans que les deux implémentations divergent silencieusement.
8. **Pas de dépendance bloquante, donc pas de séquencement imposé** :
   contrairement à `PRD-QUIC.md`/`PRD-HTTP.md`, aucune phase de ce PRD
   n'attend un chantier externe — le risque inverse existe : traiter les
   phases dans un ordre arbitraire sans respecter les dépendances
   internes du tableau § 5 (ex. tenter P6/FTPS avant P1/canal de
   contrôle).
9. **Absence de journal de coordination dédié** : si plusieurs agents
   travaillent en parallèle sur ce PRD, `docs/tls_quic_http_log.md`
   n'est **pas** le bon endroit (§ 0.1) — un journal séparé devra être
   créé avant tout travail multi-agent, pour éviter toute confusion avec
   la coordination TLS/QUIC/HTTP déjà en place.

---

## 8. Critères d'acceptation

1. Une session FTP complète (`USER`/`PASS` → `230`, `PASV`, `STOR` d'un
   fichier binaire arbitraire, `RETR` du même fichier depuis une autre
   session) round-trip byte-exact sur `TcpStack`.
2. `PORT` et `PASV` aboutissent chacun à un transfert réussi sur un port
   de données réellement distinct du port de contrôle (21), vérifiable
   par inspection des connexions TCP ouvertes pendant le test.
3. `AUTH TLS` sur un client/serveur FTP configurés avec un certificat non
   approuvé échoue proprement (pas de repli en clair silencieux) ; avec
   un certificat approuvé, un `PROT P` suivi d'un `STOR` protège
   effectivement le canal de données (vérifiable structurellement, pas
   juste par le succès du transfert).
4. `REST 1024` suivi d'un `RETR` reprend effectivement à l'offset 1024
   plutôt que de retransférer le fichier entier.
5. `FEAT` annonce exactement l'ensemble des extensions RFC 3659
   implémentées, ni plus ni moins.
6. Une session SFTP pilotée directement au niveau paquet (`SSH_FXP_OPEN`
   → plusieurs `SSH_FXP_READ`/`SSH_FXP_WRITE` à des offsets différents →
   `SSH_FXP_CLOSE`) produit le même résultat qu'un `get`/`put` atomique
   équivalent via l'API existante de `SftpSession.ts`.
7. Une erreur de permission côté système de fichiers se traduit, au
   niveau du fil SFTP, par `SSH_FXP_STATUS` portant
   `SSH_FX_PERMISSION_DENIED` — pas un statut générique.
8. Pendant P1–P12, toutes les suites existantes (`nat-pat`,
   `nat-pat-other`, les suites SFTP/SCP actuelles, les tests de shell
   Huawei/Cisco) passent **sans aucune modification**, confirmant que le
   module reste strictement additif jusqu'à P13.
9. Après P13 : `ftp server enable` sur un routeur Huawei ouvre
   réellement un port 21 accessible (vérifiable par une connexion TCP
   réelle depuis un test), et `SshSftpChannel.ts`/
   `SftpCommandDispatcher.ts` utilisent réellement le nouvel encodage
   `SSH_FXP_*` (vérifiable par un import direct dans le code), avec un
   résultat observable identique à l'avant-migration pour
   `SftpSession.ts`/`ScpTransfer.ts`.
