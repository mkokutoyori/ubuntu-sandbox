# PRD — File Transfer : FTP/FTPS (RFC 959, 2228, 4217, 3659, 2428), TFTP (RFC 1350, 2347-2349) et renforcement du fil SFTP/SCP (draft-ietf-secsh-filexfer)

**Version** : 1.0
**Date** : 2026-07-05
**Projet** : Ubuntu Sandbox — Module FTP/SFTP
**Auteur** : Claude Code
**Références normatives** : RFC 959 (File Transfer Protocol), RFC 2228
(extensions de sécurité FTP — commandes `AUTH`/`ADAT`/`PROT`/`PBSZ`/`CCC`),
RFC 4217 (sécurisation de FTP par TLS — mécanique précise d'`AUTH TLS`,
FTPS explicite vs implicite ; précise et s'appuie sur RFC 2228), RFC 3659
(extensions FTP : `FEAT`, `SIZE`, `MDTM`, `REST`, `MLST`/`MLSD`), RFC 2428
(extensions FTP IPv4/IPv6/NAT : `EPRT`/`EPSV`), RFC 1350 (TFTP — protocole
autonome, indépendant de FTP au-delà du nom), RFC 2347/2348/2349
(extensions d'option TFTP : négociation générique, `blksize`,
`timeout`/`tsize`), RFC 8446 (TLS 1.3 — prérequis externe pour FTPS, cf.
`PRD-TLS.md`, **déjà livré**), draft-ietf-secsh-filexfer-13 (SSH File
Transfer Protocol, versions 3 à 6 — jamais publié en RFC ; la version 3,
implémentée par OpenSSH, en est le standard de facto), RFC 4253/RFC 4254
(SSH Transport/Connection — déjà implémentés dans ce projet, référence
seulement).

---

## 0. Contexte et portée du document

Ce PRD couvre **quatre chantiers** réunis dans un même document parce
qu'ils portent tous sur le **transfert de fichiers** et partagent des
dépendances communes (TLS pour FTPS, le module SSH existant pour
SFTP/SCP) :

1. **FTP et FTPS** (RFC 959, RFC 2228/4217, RFC 3659, RFC 2428) :
   construction **greenfield** d'un canal de contrôle FTP réel, d'un
   canal de données actif/passif (y compris les transferts
   tiers « FXP »), des commandes de transfert/navigation, du mode de
   transfert compressé natif (`MODE C`), des extensions modernes
   (`FEAT`/`SIZE`/`MDTM`/`REST`/`MLST`/`MLSD`), de sa sécurisation par
   TLS, et de son passage à travers une traduction NAT (ALG). **Il
   n'existe aujourd'hui aucune implémentation FTP dans ce dépôt**
   (§ 1.1) — c'est un protocole entièrement à construire, comme RADIUS
   ou TLS l'étaient avant leurs propres PRD.
2. **TFTP** (RFC 1350, RFC 2347/2348/2349) : un protocole minimal sur
   UDP, sans rapport structurel avec FTP au-delà du nom, lui aussi
   **entièrement absent** de ce dépôt (§ 1.1) — un troisième port
   greenfield, indépendant des trois autres.
3. **Renforcement du fil SFTP** (draft-ietf-secsh-filexfer, versions 3 à
   6) : contrairement à FTP/TFTP, **SFTP existe déjà** dans ce projet
   (`src/network/protocols/ssh/sftp/`, ~2 200 lignes réparties sur 16
   fichiers) et fonctionne au niveau applicatif — client interactif,
   serveur, adaptateurs de système de fichiers par OS, décorateurs de
   permissions/chroot, répartiteur de commandes. Mais son encodage sur
   le fil est un PDU JSON simulé, ses transferts sont atomiques (pas de
   modèle de handle par plage d'octets), sa version est figée à 3 sans
   les attributs étendus/ACL des versions ultérieures, et ses erreurs
   sont un `Result`/`err` générique plutôt que les codes normalisés.
4. **Renforcement du fil SCP** : de la même façon, `ScpSession.ts`/
   `ScpTransfer.ts` existent déjà et fonctionnent au niveau sémantique
   (push/pull, récursion, préservation d'attributs) mais **ne parlent
   jamais le protocole `scp` réel** (lignes de contrôle
   `C<mode> <taille> <nom>`, acquittements `0x00`/`0x01`/`0x02`) — ils
   pilotent directement l'abstraction de système de fichiers existante.

Pour les chantiers 3 et 4, ce PRD **ne réécrit pas** la couche
sémantique déjà livrée (`ISftpFileSystem`, adaptateurs, décorateurs,
`SftpCommandDispatcher`, `ScpTransfer.ts`) — il ajoute une couche
d'encodage fil réel en-dessous, dans le même esprit que ce que
`PRD-TLS.md` a fait pour le key schedule : sémantique réutilisée,
fidélité protocolaire renforcée.

**FTPS n'est pas un protocole séparé** : comme HTTPS pour HTTP, c'est FTP
transporté (canal de contrôle, et optionnellement canal de données) par
TLS 1.3. Ce PRD **consomme** le moteur TLS déjà livré par `docs/PRD-TLS.md`
(§2.1) plutôt que de redéfinir TLS — cette dépendance est **déjà
satisfaite** (`PRD-TLS.md` est intégralement livré, P1 à P11), donc aucune
phase de ce document n'est bloquée en amont, contrairement à ce qu'ont connu
`PRD-QUIC.md`/`PRD-HTTP.md` au moment de leur rédaction.

Ce PRD **couvre aussi la migration** de tout ce qui existe déjà et touche
au transfert de fichiers (§ 2.1.20) : le stub `ftp server enable` de
`HuaweiVRPShell.ts`, les bascules de configuration NAT ALG sans effet
(`CiscoNATCommands.ts`/`HuaweiNATCommands.ts`), et l'encodage fil de
`SshSftpChannel.ts`/`SftpCommandDispatcher.ts`/`ScpTransfer.ts` — chacun
bascule sur le moteur réel correspondant une fois celui-ci stabilisé, en
conservant à l'identique son comportement observable.

Seule exception délibérée : un **client/serveur FTP graphique** (type
FileZilla) n'est **pas** demandé — seule l'interaction en ligne de
commande l'est (§ 2.1.11), à l'image de ce que ce dépôt fait déjà pour
SSH/SFTP/HTTP. C'est la seule fonctionnalité de ce document reléguée en
non-objectif aux côtés de la fidélité cryptographique bit-exacte
(§ 2.2 — héritée du reste du projet, pas un choix propre à ce PRD).

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
   │  SFTP (draft-ietf-secsh-filexfer) et SCP (§2.1.19) consomment le
   │  module SSH déjà livré (src/network/protocols/ssh/) — infrastructure
   │  existante et stable, mais qui n'est PAS un PRD frère de ce groupe
   │  (pas de `PRD-SSH.md` — le module a été construit avant
   │  l'introduction de cette convention de coordination multi-PRD)
   │
   │  L'ALG FTP à travers NAT (§2.1.10) consomme `NATEngine.ts` déjà
   │  livré (src/network/devices/router/) — même remarque : infrastructure
   │  existante, pas un PRD frère
   │
   │  TFTP (§2.1.13) n'a strictement aucune dépendance — protocole
   │  autonome sur UDP, sans canal de contrôle ni sécurisation
   ▼
(aucun consommateur PRD identifié pour l'instant)
```

Contrairement à `PRD-QUIC.md`/`PRD-HTTP.md` au moment de leur rédaction,
ce PRD **n'a aucune dépendance bloquante** : son unique dépendance externe
formelle (`PRD-TLS.md`) est déjà intégralement livrée, et ses autres
dépendances (le module SSH/SFTP et `NATEngine.ts`) sont du code déjà en
production dans ce dépôt, pas des chantiers en cours. Toutes les phases
du § 5 peuvent donc démarrer immédiatement, dans n'importe quel ordre
respectant leurs dépendances internes. C'est un PRD terminal — aucun
autre PRD connu n'en dépend à ce jour. Ce document **ne s'inscrit pas**
dans le journal de coordination multi-agent `docs/tls_quic_http_log.md`
(qui, comme son nom l'indique, est scopé à la seule triade TLS/QUIC/HTTP)
— un journal dédié devra être ouvert séparément si plusieurs agents
doivent se coordonner sur ce PRD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/devices/shells/HuaweiVRPShell.ts` | `ftp server enable` bascule un booléen global (`_setGlobalToggle('ftp', true)`) | **Aucune session FTP réelle** derrière ce commutateur — pas de canal de contrôle, pas de canal de données, pas de commande FTP interprétée |
| `src/network/devices/shells/cisco/CiscoNATCommands.ts` | Texte de `show ip nat statistics` | Déclare explicitement : *« Application Layer Gateways: none (FTP/SIP ALG and NAT64 not supported in this simulator) »* — commentaire à retirer pour la partie FTP une fois l'ALG livré (§ 2.1.10 ; le SIP ALG reste hors périmètre) |
| `src/network/devices/shells/huawei/HuaweiNATCommands.ts` (l. 208-221) | `nat alg`/`undo nat alg` | Bascule un état interne accepté par le parseur, mais **`NATEngine.ts` ne consulte jamais cet état** — aucun effet sur la traduction réelle des paquets |
| `src/network/devices/router/NATEngine.ts` | Moteur de traduction NAT (adresses/ports de couche 3/4) | **Aucune référence à FTP** — aucune inspection ni réécriture du payload applicatif ; condition bloquante pour l'ALG (§ 2.1.10) |
| `src/__tests__/unit/network-v2/nat-pat.test.ts`, `nat-pat-other.test.ts` | Tests de commandes NAT | Vérifient uniquement le **parsing** de `ip nat service ftp` (Cisco) / `nat alg ftp enable` (Huawei) comme bascules de configuration, et l'absence de l'ALG dans les statistiques — aucun test ne porte sur un protocole FTP réel |
| `src/network/core/WellKnownPorts.ts` (l. 29-30, 39) | Dictionnaire de noms de ports IANA | `{20: 'ftp-data'}`, `{21: 'ftp'}`, `{69: 'tftp'}` — noms statiques pour l'affichage (bannières, `nmap`), aucune sémantique protocolaire pour aucun des trois |
| `src/network/core/ports/IanaServiceRegistry.ts` (l. 41-42, 52) | Registre IANA miroir | Mêmes entrées, mêmes limites |
| `src/network/devices/DeviceFactory.ts` | Fabrique de périphériques | **Aucune référence à FTP/TFTP** — aucun rôle serveur n'existe à câbler |
| `src/network/protocols/ssh/sftp/*` (16 fichiers, ~2 200 lignes) | Client/serveur SFTP fonctionnel au-dessus de SSH (`SftpSession.ts`, `SftpCommandDispatcher.ts`, `ISftpFileSystem.ts`, adaptateurs Linux/Windows/Router/VFS, `PermissionCheckingFSDecorator.ts`, `ChrootedSftpFileSystem.ts`) | Sémantique **réelle et complète** au niveau applicatif mais **encodage fil simulé** (enveloppe JSON), **transferts atomiques** (pas de handle par plage d'octets), **pas de codes `SSH_FX_*` numériques**, **version figée à 3** sans attributs étendus/ACL des versions 4-6, aucune commande `SYMLINK`/`READLINK` |
| `src/network/protocols/ssh/scp/{ScpSession.ts,ScpTransfer.ts}` | SCP au-dessus de l'abstraction `ISftpFileSystem` | Fonctionnel et déjà testé au niveau sémantique (push/pull, récursion, `-p`), mais **aucun protocole fil réel** : pas de lignes de contrôle `C<mode> <taille> <nom>`/`D<mode> 0 <nom>`, pas d'octets d'acquittement `0x00`/`0x01`/`0x02` — objet de ce PRD (§ 2.1.19) |
| `src/network/protocols/ssh/session/SshSession.ts`, `channels/SshSftpChannel.ts`, `server/SshServerHandler.ts` | Transport SSH (connexion, authentification, canaux) | Solide et stable ; seul le **contenu transporté** change dans ce PRD, pas le transport SSH lui-même |

### 1.2 Ce qui existe déjà et est réutilisable

- **`TcpStack`/`TcpSocket`** (`src/network/tcp/`) — porte à la fois le
  canal de contrôle FTP (port 21) et le canal de données FTP (port
  éphémère négocié par `PORT`/`PASV`/`EPRT`/`EPSV`), exactement comme il
  porte déjà HTTP/TLS/SSH ; le canal de données TFTP (§ 2.1.13) s'appuie
  lui sur le mécanisme de `UDPPacket` déjà utilisé par DNS/RADIUS (pas de
  classe `UdpStack` dédiée dans ce projet, cf. `PRD-HTTP.md` § 7 pour la
  même remarque côté QUIC).
- **`@/network/pki` + `TlsClientSession`/`TlsServerSession`**
  (`docs/PRD-TLS.md`, **livré**) — consommés tels quels pour `AUTH TLS`,
  sans aucune nouvelle primitive cryptographique, à l'image de ce que
  `PRD-HTTP.md` a fait pour HTTPS.
- **`src/network/protocols/ssh/sftp/` en entier** : `ISftpFileSystem`
  (interface segmentée ISP), les adaptateurs Linux/Windows/Router/VFS,
  `PermissionCheckingFSDecorator`, `ChrootedSftpFileSystem`,
  `SftpCommandDispatcher` + `ISftpCommand` (pattern Command déjà en
  place) — **tout ceci reste la couche sémantique** ; ce PRD n'en
  réécrit que l'encodage fil, le modèle de handles, et l'étend de façon
  additive pour les attributs des versions 4-6 (§ 2.1.14-17).
- **`ScpTransfer.ts`** — logique de haut niveau (push/pull, récursion,
  préservation d'attributs) réutilisée telle quelle ; seul ce qu'elle
  émet/consomme change (§ 2.1.19).
- **`SshSession`/`SshChannelManager`/`ISshSftpChannel`** — transport SSH
  existant et stable ; seul le contenu transporté change.
- **`NATEngine.ts`** — moteur de traduction NAT déjà en place (adresses/
  ports de couche 3/4) ; l'ALG FTP (§ 2.1.10) s'y ajoute comme un point
  d'inspection applicative supplémentaire, sans réécrire le moteur de
  traduction existant.
- **`EventBus`/`Signal`** (`src/events/`) — bus d'événements typé déjà
  utilisé par TLS/QUIC/HTTP/RADIUS pour l'observabilité.
- **Convention de fidélité « crypto simulée, forme du protocole réelle »**
  déjà établie par `PkiKeyPair`, `SimulatedTls.ts`, le moteur TLS de
  `PRD-TLS.md` — directement applicable à FTPS et au fil SFTP/SCP.
- **`ChrootedSftpFileSystem`** — modèle de racine par utilisateur déjà
  résolu côté SFTP ; le serveur FTP réutilise le même principe (§ 2.1.9)
  plutôt que d'en inventer un nouveau.

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | Aucune implémentation du canal de contrôle FTP (connexion, commandes texte, réponses à codes numériques, machine à états de session) | RFC 959 §3-5 | Bloquant |
| 2 | Aucun modèle de canal de données actif/passif distinct du canal de contrôle | RFC 959 §2.3, RFC 2428 | Bloquant |
| 3 | Aucune sécurisation FTP (`AUTH TLS`/`PBSZ`/`PROT`) | RFC 2228, RFC 4217 | Élevée |
| 4 | Aucune extension moderne (`FEAT`/`SIZE`/`MDTM`/`REST`/`MLST`/`MLSD`) | RFC 3659 | Moyenne |
| 5 | Aucun mode de transfert compressé natif (`MODE C`) | RFC 959 §3.4.2 | Faible |
| 6 | Aucun support explicite des transferts tiers (FXP) | RFC 959 | Faible |
| 7 | L'ALG FTP à travers NAT n'a aucun effet réel (`NATEngine.ts` n'inspecte jamais le payload applicatif) malgré des commandes de configuration déjà acceptées par les deux parseurs vendeur | — | Moyenne |
| 8 | Aucune implémentation TFTP | RFC 1350, RFC 2347/2348/2349 | Bloquant (pour ce sous-protocole) |
| 9 | SFTP : encodage fil simulé (JSON), pas d'opcodes `SSH_FXP_*` réels ni de négociation de version | draft-ietf-secsh-filexfer §4 | Moyenne |
| 10 | SFTP : transferts atomiques, pas de modèle de handle `OPEN`/`READ`/`WRITE`/`CLOSE` par plage d'octets (pas de reprise ni de streaming partiel) | draft-ietf-secsh-filexfer §6.4-6.7 | Moyenne |
| 11 | SFTP : pas de codes de statut `SSH_FX_*` numériques normalisés, pas de `SYMLINK`/`READLINK` | draft-ietf-secsh-filexfer §7/§9 | Faible |
| 12 | SFTP : figé à la version 3, aucun attribut étendu/ACL/renommage-lien physique des versions 4-6 | draft-ietf-secsh-filexfer (v4-v6) | Faible |
| 13 | SCP : aucun protocole fil réel (pas de lignes de contrôle, pas d'octets d'acquittement) — piloté directement au niveau de l'abstraction de système de fichiers | — (protocole OpenSSH non normalisé) | Faible |

**Conclusion de la phase d'analyse** : FTP et TFTP sont des chantiers
entièrement greenfield — comparables à l'état de TLS ou RADIUS avant leur
propre PRD — tandis que SFTP et SCP sont des chantiers de **renforcement
de fidélité fil** sur une base sémantique déjà solide et déjà testée.
L'ALG FTP à travers NAT est un cas particulier : la commande de
configuration existe déjà (acceptée par les deux parseurs vendeur) mais
n'a aucun effet, ce qui en fait une dette technique préexistante plutôt
qu'une fonctionnalité totalement absente. Les quatre chantiers partagent
des dépendances externes déjà satisfaites (TLS livré, SSH/NAT déjà en
production) mais sont par ailleurs indépendants les uns des autres : rien
n'empêche de livrer l'un sans toucher aux autres, dans n'importe quel
ordre.

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
fichier, la seule courante), `MODE S` (flux, la seule courante — voir
aussi `MODE C`, objectif 5), `SYST`, `NOOP`, `QUIT`, `ABOR` (interruption
d'un transfert en cours).

**2. RFC 959 §2.3, RFC 2428 — Canal de données actif/passif.** Un
**deuxième** `TcpConnection`, réellement distinct du canal de contrôle,
négocié soit en mode actif (`PORT`/`EPRT` : le client ouvre un port et le
serveur s'y connecte), soit en mode passif (`PASV`/`EPSV` : le serveur
ouvre un port éphémère et communique son adresse/port, le client s'y
connecte) — un vrai deuxième port TCP réellement ouvert et réellement
utilisé pour le transfert, pas un indicateur booléen. `EPRT`/`EPSV`
(RFC 2428) généralisent `PORT`/`PASV` à IPv6 et évitent de coder en dur le
format d'adresse IPv4 dans la commande — pertinent puisque ce simulateur
a déjà IPv6. L'adresse fournie par `PORT`/`EPRT` n'est **volontairement
pas** contrainte à correspondre au pair de la connexion de contrôle
(cf. objectif 6, FXP).

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
(permission refusée ou chemin invalide) — chaque commande des objectifs
1/3 mappée vers son (ou ses) code(s) de réponse réel(s) selon la RFC, pas
un succès/échec binaire générique.

**5. RFC 959 §3.4.2 — Mode de transfert compressé (`MODE C`).** Un
troisième mode de transfert, alternatif à `MODE S` (flux, objectif 1),
défini nativement par la RFC elle-même — **pas** une compression
générique façon gzip (cf. § 2.2) : un octet descripteur précède chaque
segment et indique s'il s'agit d'une chaîne littérale, d'une réplication
d'un octet répété N fois, ou d'un remplissage. Un schéma simple,
entièrement spécifié par la RFC, donc testable **bit-exact**
(contrairement à HPACK/QPACK ou à la compression de contenu HTTP,
volontairement simplifiés ailleurs dans ce dépôt, cf. `PRD-HTTP.md` §2.2).
Négocié par `MODE C` avant `RETR`/`STOR`, honoré symétriquement par les
deux moteurs de canal de données (objectif 2).

**6. RFC 959 — FXP (transferts tiers, « File eXchange Protocol »).** Le
canal de données (objectif 2) n'exige pas que l'adresse fournie par
`PORT`/`EPRT` corresponde à l'adresse de la connexion de contrôle qui
l'émet : un client peut ouvrir une connexion de contrôle vers un serveur
A, une seconde vers un serveur B, exécuter un `PASV` sur A puis un
`PORT`/`EPRT` (avec l'adresse obtenue de A) sur B, pour que A et B
transfèrent directement entre eux sans que les octets ne transitent par
le client. Ce mode, permis par la RFC 959 elle-même sans commande dédiée,
découle directement du modèle de canal de données de l'objectif 2 dès
lors que l'adresse cible n'est pas comparée à celle du pair de contrôle —
aucune commande ni état supplémentaire n'est nécessaire, seule l'absence
de cette vérification restrictive doit être testée explicitement (voir
aussi § 7 pour la remarque historique sur le « FTP bounce »).

**7. RFC 2228 + RFC 4217 — FTPS explicite (dépend de `PRD-TLS.md`,
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

**8. RFC 3659 — Extensions modernes.** `FEAT` (annonce la liste des
extensions supportées par le serveur, une par ligne de la réponse `211`
multi-lignes). `SIZE` (taille exacte d'un fichier, mode binaire).
`MDTM` (date de dernière modification, format `YYYYMMDDHHMMSS`). `REST`
(reprise de transfert : positionne un offset réel avant le prochain
`RETR`/`STOR`, honoré par le moteur de canal de données). `MLST`/`MLSD`
(listage machine-readable normalisé, faits `type=file;size=1234;
modify=20260705120000;` par entrée, remplaçant l'ambiguïté de format de
`LIST`).

**9. Modèle de session serveur multi-utilisateur et racine confinée.**
Authentification `USER`/`PASS` contre un référentiel de comptes cohérent
avec les autres services du projet (même modèle que l'authentification
SSH/RADIUS existante). Racine par utilisateur confinée, sur le même
principe que `ChrootedSftpFileSystem` déjà livré côté SFTP (§ 1.2) —
réutilisation du concept, pas de nouvelle abstraction de confinement.

**10. ALG FTP à travers NAT (Application Layer Gateway).**
`NATEngine.ts` (§ 1.1) inspecte et réécrit, pour la seule commande FTP,
les adresses/ports IPv4 embarqués en clair dans le payload applicatif des
commandes `PORT`/`PASV` (et de la réponse `227` pour `PASV`) qui
traversent une traduction NAT — condition nécessaire pour qu'un client
FTP actif fonctionne à travers un routeur NAT sans configuration manuelle
du canal de données. Une entrée de traduction dynamique est ouverte pour
le port de données annoncé, le temps du transfert, symétriquement à ce
qu'un routeur réel fait. `nat alg ftp enable`/`disable` (Huawei, déjà
accepté par le parseur, § 1.1) et `ip nat service ftp` (Cisco) pilotent
réellement ce comportement au lieu de n'être que des bascules de
configuration sans effet.

**11. Client FTP en ligne de commande.** Un nouveau gestionnaire de
commande `ftp` exposé dans les shells Linux/Windows, consommant ce moteur
(connexion, authentification, `get`/`put`/`ls`/`cd`, mode passif par
défaut), à l'image de la manière dont `curl`/`wget` consomment le moteur
HTTP de `PRD-HTTP.md`.

**12. Observabilité FTP.** Événements bus dédiés
(`ftp.control.connected/authenticated/closed`,
`ftp.data.opened/closed`, `ftp.transfer.started/completed/failed`,
`ftp.command.received`, `ftps.tls.established`, `ftp.alg.rewrite`)
exploitables par les logs réseau et les tests, à l'image du reste du
projet.

**13. RFC 1350 (+ RFC 2347/2348/2349) — TFTP.** Protocole de transfert de
fichiers minimal sur UDP/69, entièrement indépendant du reste de ce PRD
(pas de canal de contrôle séparé, pas d'authentification, pas de
sécurisation) : cinq types de paquets (`RRQ`, `WRQ`, `DATA`, `ACK`,
`ERROR`), transfert en lock-step (un bloc de 512 octets — ou la taille
négociée — par `ACK` reçu), retransmission sur timeout, dernier bloc
identifié par une taille strictement inférieure au bloc nominal.
Extensions d'option (RFC 2347 « Option Extension », RFC 2348 `blksize`,
RFC 2349 `timeout`/`tsize`) négociées via `OACK`, pour des blocs plus
grands que 512 octets et une estimation de progression réelle. Chaque
transfert est sa propre conversation UDP, contrairement à FTP
(objectifs 1-2).

**14. draft-ietf-secsh-filexfer §4 — Encodage fil SFTP réel.** Un codec
qui encode/décode de vrais paquets `SSH_FXP_*` numérotés (`INIT`,
`VERSION`, `OPEN`, `CLOSE`, `READ`, `WRITE`, `LSTAT`, `FSTAT`, `SETSTAT`,
`OPENDIR`, `READDIR`, `REMOVE`, `MKDIR`, `RMDIR`, `REALPATH`, `RENAME`,
`READLINK`, `SYMLINK`, plus les réponses `STATUS`/`HANDLE`/`DATA`/`NAME`/
`ATTRS`), chacun porteur d'un identifiant de requête (`request-id`)
explicite, en remplacement de l'enveloppe JSON `{op, ...}` actuelle —
**réutilise entièrement** `ISftpFileSystem`/`SftpCommandDispatcher`/les
décorateurs déjà en place (§ 1.2) : seul l'encodage change, pas la
sémantique des opérations.

**15. draft-ietf-secsh-filexfer §6.4-6.7 — Modèle de handle réel.** `OPEN`
retourne un handle opaque (chaîne d'octets simulée) enregistré dans une
table de handles par session ; `READ`/`WRITE` opèrent par
`(handle, offset, longueur)` sur ce handle plutôt que sur le fichier
entier ; `CLOSE` libère le handle. Remplace le `get`/`put` atomique
actuel tout en gardant `ISftpReadable`/`ISftpWritable` comme
implémentation sous-jacente (le handle devient un curseur logique
au-dessus de ces mêmes méthodes).

**16. draft-ietf-secsh-filexfer §7/§9.1 — Codes de statut réels et
liens symboliques.** Table `SSH_FX_OK`/`SSH_FX_EOF`/`SSH_FX_NO_SUCH_FILE`/
`SSH_FX_PERMISSION_DENIED`/`SSH_FX_FAILURE`/`SSH_FX_BAD_MESSAGE`/
`SSH_FX_NO_CONNECTION`/`SSH_FX_CONNECTION_LOST`/`SSH_FX_OP_UNSUPPORTED`,
alimentée par une correspondance depuis le `Result`/`err({kind, message})`
existant (la couche sémantique garde son modèle d'erreur interne ; seule
la traduction en sortie de fil change). `SYMLINK`/`READLINK` complètent
le dispatcher de commandes existant. Négociation de version réelle
(`SSH_FXP_INIT`/`SSH_FXP_VERSION`, extensions en paires nom/donnée) — la
version 3 reste la version proposée par défaut (compatibilité OpenSSH la
plus large), mais l'échange lui-même devient réel au lieu d'être une
constante figée.

**17. draft-ietf-secsh-filexfer versions 4 à 6 — Attributs étendus, ACL
et opérations POSIX.** Négociation de version étendue (objectif 16)
jusqu'à la version 6 si le pair la propose : encodage `ATTRS` avec un
champ `type` explicite (fichier/répertoire/lien symbolique/spécial/
inconnu, introduit en v4), attributs étendus nommés (paires clé/valeur
arbitraires), une liste d'entrées ACL (sujet, type, indicateurs, masque
de permission — modélisées et **transportées fidèlement sur le fil**,
cf. § 2.2 pour la limite d'application réelle), `SSH_FXP_RENAME` avec
indicateurs (`OVERWRITE`/`ATOMIC`/`NATIVE`, v5), lien physique
(hardlink, v6). `ISftpFileSystem` (§ 1.2) est étendu de façon **additive**
(nouveaux champs optionnels sur les types d'attributs existants) pour
porter ces informations, sans réécriture de son contrat existant — les
objectifs 14-16 restent valides tels quels pour un pair qui négocie la
version 3.

**18. Observabilité SFTP.** Événements bus dédiés
(`sftp.packet.sent/received`, `sftp.handle.opened/closed`,
`sftp.transfer.progress`) — même convention que le reste du projet.

**19. Protocole SCP réel sur le fil.** `ScpSession.ts`/`ScpTransfer.ts`
(§ 1.1) pilotent aujourd'hui directement deux instances d'
`ISftpFileSystem` sans jamais construire le protocole `scp` réel. Ce
protocole (documenté par le code source/la page de protocole d'OpenSSH,
jamais normalisé en RFC) s'exécute sur un canal `exec` SSH invoquant
`scp -t`/`scp -f` : lignes de contrôle texte `C<mode> <taille> <nom>`
(fichier), `D<mode> 0 <nom>` (entrée de répertoire, `E` pour la sortie),
suivies des octets bruts du fichier, acquittées par un octet `0x00`
(succès), `0x01` (avertissement) ou `0x02` (erreur fatale, message texte
associé). Ce PRD construit ce codec de fil réel **sous**
`ScpTransfer.ts`, qui garde sa logique de haut niveau (push/pull,
récursion, préservation `-p`) mais l'exprime désormais en émettant/
consommant ces lignes de contrôle plutôt qu'en appelant directement
`ISftpFileSystem`.

**20. Migration des consommateurs existants.** Une fois les quatre
moteurs stabilisés (§ 5) :
- le stub `ftp server enable` de `HuaweiVRPShell.ts` bascule sur un vrai
  serveur FTP (port 21 réellement ouvert quand la fonctionnalité est
  activée) ;
- `nat alg ftp enable`/`disable` (Huawei) et `ip nat service ftp` (Cisco)
  pilotent réellement l'ALG de `NATEngine.ts` (objectif 10), et le texte
  « FTP/SIP ALG ... not supported » de `CiscoNATCommands.ts` est corrigé
  pour la partie FTP (le SIP ALG, hors périmètre, reste noté non
  supporté) ;
- `SshSftpChannel.ts`/`SftpCommandDispatcher.ts` basculent sur le nouvel
  encodage de paquets réel (objectifs 14-17) en conservant à l'identique
  le comportement observable de `SftpSession.ts`/
  `SftpInteractiveSession.ts` ;
- `ScpSession.ts`/`ScpTransfer.ts` basculent sur le nouveau codec de fil
  réel (objectif 19) en conservant à l'identique leur comportement
  observable (résultats de copie, messages `scp: ...`, résumés de
  transfert).

Aucune régression sur les suites SFTP/SCP/NAT/shell Huawei déjà vertes
(§ 7, risque dédié).

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Client/serveur FTP graphique ou synchronisation de répertoires**
  (type client façon FileZilla, miroir bidirectionnel) — seule
  l'interaction en ligne de commande est demandée (objectif 11), à
  l'image du `ftp`/`sftp` shell existants. **C'est l'exception
  explicitement demandée** — tous les autres non-objectifs envisagés
  pour ce PRD ont été promus en objectifs ci-dessus.
- **Vrai chiffrement/vraie négociation cryptographique bit-exacte** —
  contrairement au point précédent, celui-ci **n'est pas un choix de
  portée propre à FTP/SFTP** : c'est la convention transversale déjà
  actée par l'ensemble de ce dépôt (`PkiKeyPair`, `SimulatedTls.ts`, le
  moteur de `PRD-TLS.md`, EAP-TLS, RADIUS...). La remettre en cause ici
  contredirait chaque protocole déjà livré, pour un bénéfice qui ne
  serait spécifique à aucune des demandes de ce document — c'est la
  seule autre exclusion qui n'a pas été promue.
- **Compression de contenu façon HTTP** (gzip/deflate/br) — reste hors
  périmètre, à distinguer de `MODE C` (objectif 5) : ce dernier est un
  schéma natif RFC 959, différent, simple et bit-exact par construction,
  ce qui ne contredit pas cette exclusion (même logique que
  `PRD-HTTP.md` § 2.2 pour HPACK/QPACK).
- **SCP remote-à-remote** (copie directe entre deux serveurs distants
  sans passer par le client) — déjà explicitement rejeté par
  `ScpTransfer.ts` (« not supported in simulator ») ; le renforcement du
  fil SCP (objectif 19) ne change pas cette limite, il ne fait que
  réifier en protocole réel ce qui est déjà utilisé en push/pull.
- **Application réelle des ACL étendues SFTP v6 au niveau du système de
  fichiers** — les entrées ACL sont modélisées et transportées
  fidèlement sur le fil (objectif 17), mais l'évaluation d'accès reste
  celle déjà en place (`PermissionCheckingFSDecorator`, modèle
  propriétaire/groupe/autres) ; une vraie évaluation multi-entrées ACL
  n'est pas demandée.
- **Combinaison FXP + ALG NAT** (l'un des deux serveurs d'un transfert
  FXP est lui-même derrière une traduction NAT) — chaque fonctionnalité
  (objectifs 6 et 10) est testée indépendamment ; leur composition n'est
  pas un cas d'usage retenu.

---

## 3. Architecture cible

### 3.1 Principe directeur

**Additif d'abord, migration ensuite en un point de bascule net** — même
discipline que `PRD-TLS.md`/`PRD-HTTP.md`. FTP et TFTP sont construits
**greenfield**, en couches strictement empilées (canal de contrôle →
canal de données → sécurité/extensions pour FTP ; paquets lock-step
seuls pour TFTP), sans toucher à aucun fichier existant avant la phase
de migration dédiée (§ 5, P19). SFTP et SCP sont renforcés par
**remplacement progressif de leur seule couche d'encodage fil**
(`SftpWireCodec`/`SftpHandleTable`/`SftpStatusCodes`/`ScpWireCodec`, tous
nouveaux), sans jamais modifier la couche sémantique déjà livrée
(`ISftpFileSystem`/`ScpTransfer.ts` et leurs adaptateurs/décorateurs) —
le principe déjà appliqué par `PRD-TLS.md` (« le key schedule est une
fonction pure testable indépendamment de toute session réseau ») se
retrouve ici sous la forme « le codec fil est un adaptateur testable
indépendamment de toute logique de système de fichiers ». L'ALG FTP
(objectif 10) suit le même principe côté NAT : un point d'inspection
ajouté à `NATEngine.ts`, pas une réécriture de son moteur de traduction.

### 3.2 Diagramme de couches

```
┌────────────────────────────────────────────────────────────────────┐
│ Consommateurs (hors périmètre, inchangés tant que P19 n'est pas    │
│ atteinte) :                                                        │
│   ScpSession.ts/ScpTransfer.ts (logique haut niveau) ·              │
│   SftpInteractiveSession.ts · shells Linux/Windows/Cisco/Huawei      │
├────────────────────────────────────────────────────────────────────┤
│ Migré par ce PRD (§ 2.1.20, P19) :                                  │
│   HuaweiVRPShell.ts (« ftp server enable » → vrai serveur FTP)      │
│   CiscoNATCommands.ts/HuaweiNATCommands.ts → ALG réel (NATEngine.ts)│
│   SshSftpChannel.ts / SftpCommandDispatcher.ts (nouvel encodage)    │
│   ScpTransfer.ts (nouveau codec de fil)                             │
├────────────────────────────────────────────────────────────────────┤
│  FTP (959/2428/3659)   │  TFTP (1350)  │  SFTP/SCP (secsh-filexfer) │
│  ftp/ControlSession.ts  │  tftp/        │  sftp/SftpWireCodec.ts     │
│  ftp/DataChannel.ts     │   TftpSession │    (NOUVEAU)               │
│  ftp/commands/*.ts      │   .ts (NOUVEAU)│  sftp/SftpHandleTable.ts  │
│  ftp/replies.ts         │  tftp/options │    (NOUVEAU)               │
│  ftp/extensions.ts      │   .ts (NOUVEAU)│  sftp/SftpStatusCodes.ts  │
│  ftp/compressedMode.ts  │               │    (NOUVEAU)               │
│   (MODE C)              │               │  scp/ScpWireCodec.ts       │
│                         │               │    (NOUVEAU)               │
│                         │               │  sftp/SftpCommandDispatcher│
│                         │               │    .ts (existant, réutilisé)│
│                         │               │  sftp/ISftpFileSystem.ts+  │
│                         │               │    adapt. (existant)       │
├────────────────────────────────────────────────────────────────────┤
│  FTPS (2228/4217) — AUTH TLS/PBSZ/PROT via le moteur de             │
│  `PRD-TLS.md` (livré) : TlsClientSession/TlsServerSession           │
├────────────────────────────────────────────────────────────────────┤
│  ALG FTP (objectif 10) — point d'inspection additionnel dans le     │
│  pipeline de traduction existant de NATEngine.ts                    │
├────────────────────────────────────────────────────────────────────┤
│  TcpStack/TcpSocket (canal de contrôle + canal de données FTP) ·    │
│  UDPPacket (TFTP, comme DNS/RADIUS) ·                                │
│  src/network/protocols/ssh/ (transport SSH, inchangé)               │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/ftp/                       # NOUVEAU — protocole FTP entier
├── types.ts                           # ReplyCode, FtpCommand, DataChannelMode, etc.
├── ControlSession.ts                  # machine à états du canal de contrôle (client + serveur)
├── DataChannel.ts                     # canal de données actif (PORT/EPRT) / passif (PASV/EPSV)
├── compressedMode.ts                  # MODE C (RFC 959 §3.4.2)
├── commands/                          # une classe par commande (pattern Command), RETR/STOR/LIST/...
│   ├── ICommand.ts
│   ├── RetrCommand.ts, StorCommand.ts, ListCommand.ts, ...
│   └── CommandDispatcher.ts
├── replies.ts                         # dictionnaire codes 1xx-5xx + formattage multi-ligne (§4.2)
├── ftps.ts                            # AUTH TLS/PBSZ/PROT — consomme @/network/tls
├── extensions.ts                      # FEAT/SIZE/MDTM/REST/MLST/MLSD (RFC 3659)
├── events.ts                          # ftp.control.*, ftp.data.*, ftp.transfer.*, ftp.alg.*
└── observables.ts                     # flux dérivés (tests/UI)

src/network/tftp/                      # NOUVEAU — protocole TFTP entier
├── types.ts                           # TftpPacket (RRQ/WRQ/DATA/ACK/ERROR), TftpOptions
├── TftpSession.ts                     # transfert lock-step (client + serveur)
├── options.ts                         # négociation OACK : blksize/timeout/tsize (2347-2349)
├── events.ts, observables.ts          # tftp.transfer.*

src/network/devices/router/nat/
└── FtpAlg.ts                          # NOUVEAU — inspection/réécriture PORT/PASV, liaison dynamique

src/network/protocols/ssh/sftp/
├── SftpWireCodec.ts                   # NOUVEAU — encode/décode les paquets SSH_FXP_* réels (v3-v6)
├── SftpHandleTable.ts                 # NOUVEAU — handles opaques pour OPEN/READ/WRITE/CLOSE
├── SftpStatusCodes.ts                 # NOUVEAU — SSH_FX_* + correspondance depuis Result/err
├── events.ts, observables.ts          # NOUVEAU — sftp.packet.*, sftp.handle.*
├── SftpCommandDispatcher.ts           # existant, réutilisé tel quel (pattern Command)
├── ISftpFileSystem.ts                 # existant, étendu de façon additive (attributs v4-v6, § 2.1.17)
├── *Adapter.ts, PermissionCheckingFSDecorator.ts,
│   ChrootedSftpFileSystem.ts          # existants, réutilisés tels quels
└── SftpSession.ts, SftpCommands.ts    # existants — inchangés jusqu'à P19 (§ 2.1.20)

src/network/protocols/ssh/scp/
├── ScpWireCodec.ts                    # NOUVEAU — lignes de contrôle C/D/E, octets ACK/NAK 0/1/2
└── ScpSession.ts, ScpTransfer.ts      # existants — inchangés jusqu'à P19 (§ 2.1.20)
```

Note de frontière : ce PRD ne touche pas la logique interne des
adaptateurs de système de fichiers (`LinuxSftpFSAdapter.ts`,
`WindowsSftpFSAdapter.ts`, `RouterSftpFileSystem.ts`, `VfsSftpFileSystem.ts`)
ni le moteur de traduction NAT lui-même (`NATEngine.ts` reste le seul
point d'entrée, `FtpAlg.ts` s'y branche) — seule leur consommation change,
pas leur implémentation.

### 3.4 Design patterns retenus

- **Machine à états explicite** (`ControlSession`, `TftpSession`, côtés
  client et serveur), à l'image de `TlsClientSession`/`TlsServerSession`.
- **Command** côté FTP (une classe par verbe, `commands/`) — réplique
  volontairement le pattern déjà en place côté SFTP
  (`SftpCommandDispatcher`/`ISftpCommand`), pour que les protocoles de ce
  PRD partagent la même discipline architecturale.
- **Adapter** (`SftpWireCodec`, `ScpWireCodec`) : adaptent respectivement
  l'enveloppe JSON existante et l'appel direct à `ISftpFileSystem` vers
  de vrais protocoles fil simulés, sans toucher `ISftpFileSystem` ni
  `SftpCommandDispatcher`/`ScpTransfer.ts` — un point d'insertion net
  entre le transport (`SshSftpChannel`/canal `exec`) et la sémantique.
- **Décorateur/intercepteur** (`FtpAlg.ts`) : s'ajoute au pipeline de
  traduction existant de `NATEngine.ts` sans le réécrire, à l'image de
  `PermissionCheckingFSDecorator` côté SFTP.
- **Strategy** pour le canal de données (actif vs passif), à l'image des
  stratégies d'authentification (`ISshAuthMethod`) et de vérification de
  clé d'hôte déjà en place côté SSH.
- **Réutilisation stricte de la PKI/TLS** (`@/network/tls`,
  `@/network/pki`) — aucune nouvelle primitive cryptographique
  introduite, comme `PRD-HTTP.md` l'a fait pour HTTPS.
- **Décorateur** réutilisé tel quel côté SFTP
  (`PermissionCheckingFSDecorator`, `ChrootedSftpFileSystem`) — le
  serveur FTP applique le même principe de confinement par racine
  utilisateur (objectif 9) plutôt que d'introduire un mécanisme parallèle.

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
  readonly address: IPAddress | IPv6Address;  // pas nécessairement le pair de contrôle (FXP, §2.1.6)
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

### 4.5 ALG NAT (objectif 10)

```
interface FtpAlgBinding {
  readonly insideAddress: IPAddress;
  readonly insidePort: number;
  readonly outsideAddress: IPAddress;
  readonly outsidePort: number;
  readonly expiresAt: number;         // libérée à la fin du transfert ou après timeout
}
```

### 4.6 Paquet TFTP (RFC 1350 §5, RFC 2347/2348/2349)

```
type TftpOpcode = 'RRQ' | 'WRQ' | 'DATA' | 'ACK' | 'ERROR' | 'OACK';

interface TftpPacket {
  readonly opcode: TftpOpcode;
  readonly blockNumber?: number;       // DATA/ACK
  readonly data?: Uint8Array;          // DATA — < taille de bloc négociée => dernier bloc
  readonly errorCode?: number;
  readonly filename?: string;         // RRQ/WRQ
  readonly mode?: 'netascii' | 'octet';
  readonly options?: Readonly<Record<string, string>>;  // blksize/timeout/tsize (OACK/RRQ/WRQ)
}
```

### 4.7 Paquet SFTP (draft-ietf-secsh-filexfer §4)

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

### 4.8 Handle, statut et attributs étendus SFTP (§6.2, §9.1, v4-v6)

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

// Extension additive de l'attribut existant — v4+
interface SftpAclEntry {
  readonly type: 'allow' | 'deny' | 'audit' | 'alarm';
  readonly subject: string;            // utilisateur ou groupe
  readonly permissions: number;        // masque de bits, transporté fidèlement (§ 2.2)
}
```

### 4.9 Ligne de contrôle SCP (§2.1.19)

```
type ScpControlKind = 'C' | 'D' | 'E';  // fichier / entrée répertoire / fin de répertoire

interface ScpControlLine {
  readonly kind: ScpControlKind;
  readonly mode: string;               // ex. '0644'
  readonly size?: number;              // 'C' seulement
  readonly name: string;
}

type ScpAck = 0 | 1 | 2;               // succès / avertissement / erreur fatale
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Canal de contrôle FTP nominal (959 §3-5)** | `types.ts`/`ControlSession.ts`/`replies.ts` : connexion, bannière `220`, `USER`/`PASS`/`ACCT`, réponses à code + multi-lignes, `QUIT`/`NOOP`/`SYST` — testable sans canal de données | — |
| **P2 — Canal de données actif/passif + transfert (959 §2.3/§4)** | `DataChannel.ts`, `commands/` : `PORT`/`PASV`, `RETR`/`STOR`/`STOU`/`APPE`, `LIST`/`NLST` | P1 |
| **P3 — Navigation et gestion de fichiers (959 §4)** | `PWD`/`CWD`/`CDUP`/`MKD`/`RMD`/`DELE`/`RNFR`+`RNTO`, racine confinée par utilisateur (§2.1.9) | P1 |
| **P4 — Extensions IPv4/IPv6/NAT modernes (2428)** | `EPRT`/`EPSV` en généralisation de `PORT`/`PASV` | P2 |
| **P5 — Extensions RFC 3659** | `FEAT`, `SIZE`, `MDTM`, `REST` (reprise avec offset réel honoré par P2), `MLST`/`MLSD` | P2, P3 |
| **P6 — Mode de transfert compressé (959 §3.4.2)** | `compressedMode.ts` : `MODE C`, encodage/décodage RLE natif | P2 |
| **P7 — FXP (transferts tiers)** | Suppression de la contrainte adresse-cible = pair de contrôle sur `DataChannel.ts` ; tests dédiés serveur-à-serveur | P2 |
| **P8 — FTPS explicite (2228/4217, dépend du moteur TLS déjà livré)** | `ftps.ts` : `AUTH TLS`, `PBSZ 0`, `PROT C`/`P` sur le canal de contrôle et, sous `PROT P`, sur le canal de données | P1, **moteur TLS de `PRD-TLS.md` (livré)** |
| **P9 — Client FTP en ligne de commande** | Gestionnaire de commande `ftp` dans les shells Linux/Windows (§2.1.11) | P1–P8 |
| **P10 — Observabilité FTP** | `events.ts`/`observables.ts` | P1–P9 |
| **P11 — ALG FTP à travers NAT** | `FtpAlg.ts` : inspection/réécriture `PORT`/`PASV`/`227`, liaison dynamique, branchement sur `nat alg ftp`/`ip nat service ftp` déjà acceptés par les parseurs | P2, P4, `NATEngine.ts` existant |
| **P12 — TFTP (1350 + 2347-2349)** | `src/network/tftp/` complet : `RRQ`/`WRQ`/`DATA`/`ACK`/`ERROR`, retransmission sur timeout, `OACK`/`blksize`/`timeout`/`tsize` | — (indépendant) |
| **P13 — Encodage fil SFTP réel (draft-secsh-filexfer §4)** | `SftpWireCodec.ts` : paquets `SSH_FXP_*` + `request-id`, négociation `INIT`/`VERSION` réelle — branché entre `SshSftpChannel` et `SftpCommandDispatcher` sans modifier ce dernier | infrastructure SSH/SFTP existante (§ 1.2) |
| **P14 — Modèle de handle SFTP réel (§6.4-6.7)** | `SftpHandleTable.ts` : `OPEN`/`OPENDIR` → handle, `READ`/`WRITE` par offset+longueur, `CLOSE` | P13 |
| **P15 — Codes de statut réels + liens symboliques (§7/§9.1)** | `SftpStatusCodes.ts` (table `SSH_FX_*` + correspondance depuis `Result`/`err`), `SYMLINK`/`READLINK` dans le dispatcher existant | P13, P14 |
| **P16 — SFTP versions 4-6 (attributs étendus/ACL/rename-hardlink)** | Extension additive d'`ISftpFileSystem`, encodage `ATTRS` v4-v6, `SSH_FXP_RENAME` avec indicateurs, lien physique | P13–P15 |
| **P17 — Observabilité SFTP** | `events.ts`/`observables.ts` dans `src/network/protocols/ssh/sftp/` | P13–P16 |
| **P18 — Protocole SCP réel sur le fil** | `ScpWireCodec.ts` : lignes de contrôle `C`/`D`/`E`, octets `0x00`/`0x01`/`0x02` | infrastructure SSH/SFTP existante (`ISftpFileSystem`) |
| **P19 — Migration des consommateurs existants (§ 2.1.20)** | `HuaweiVRPShell.ts` (« ftp server enable » → vrai serveur FTP) ; `CiscoNATCommands.ts`/`HuaweiNATCommands.ts` → ALG réel ; `SshSftpChannel.ts`/`SftpCommandDispatcher.ts` → nouvel encodage SFTP ; `ScpSession.ts`/`ScpTransfer.ts` → nouveau codec SCP, comportement observable inchangé pour tous | P1–P18 |

Chaque phase suit le cycle rouge → vert → refactor. Pendant P1–P18, ce
module reste strictement additif (§ 3.4) : aucune suite existante
(`nat-pat`, `nat-pat-other`, les suites `sftp-*`/`scp-*`, les tests de
shell Huawei/Cisco) n'est censée changer. **P19 change délibérément ce
principe** pour les seules suites SFTP/SCP/NAT concernées : leur
comportement observable (résultats de `get`/`put`/`ls`/`mkdir`/etc.,
sorties de `ScpTransfer`, statistiques NAT) doit rester identique, mais
l'encodage interne du fil (SFTP/SCP) et l'effet réel de l'ALG changent
(§ 7).

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
5. **Unitaires `MODE C`** : round-trip encode/décode bit-exact sur des
   contenus répétitifs et non répétitifs, y compris les cas limites
   (fichier vide, un seul octet répété sur toute sa longueur).
6. **Unitaires/intégration FXP** : un transfert `PASV` sur le serveur A
   suivi d'un `PORT`/`EPRT` vers ce même serveur A émis depuis une
   session de contrôle ouverte sur le serveur B aboutit à un transfert
   direct A→B sans passer par le client pilote du test.
7. **Unitaires/intégration FTPS** : `AUTH TLS` aboutit à un vrai
   handshake TLS 1.3 (contre le moteur de `PRD-TLS.md`) sur le canal de
   contrôle ; `PROT P` protège effectivement le canal de données (un
   flux en clair intercepté ne doit pas être lisible tel quel) ; certificat
   serveur non approuvé → échec propre (alerte TLS), pas de repli
   silencieux en clair.
8. **Unitaires/intégration ALG NAT** : un client FTP actif derrière une
   traduction NAT complète un `RETR`/`STOR` sans configuration manuelle
   du canal de données (adresse/port réécrits dans `PORT`, ou dans la
   réponse `227` pour `PASV`, cohérents avec la liaison NAT réellement
   ouverte) ; la liaison dynamique expire après le transfert.
9. **Unitaires/intégration TFTP** : cycle `RRQ`→`DATA`→`ACK` complet,
   retransmission après timeout sans réponse, dernier bloc détecté par
   sa taille, négociation `OACK` avec `blksize` plus grand que 512
   octets, `tsize` cohérent avec la taille réelle du fichier.
10. **Unitaires codec fil SFTP** : round-trip encode/décode pour chacun
    des types `SSH_FXP_*`, `INIT`/`VERSION` négocie bien la version
    demandée, `request-id` correctement corrélé entre requête et réponse.
11. **Unitaires handle SFTP** : `OPEN` puis plusieurs `READ`/`WRITE`
    partiels à des offsets différents produisent le même résultat qu'un
    `get`/`put` atomique équivalent ; `CLOSE` invalide le handle (un
    `READ` ultérieur sur un handle fermé échoue avec le bon code de
    statut).
12. **Unitaires statuts/liens symboliques/attributs v4-v6** : chaque
    branche d'erreur de la couche `ISftpFileSystem` existante se traduit
    vers le bon `SSH_FX_*` ; `SYMLINK`/`READLINK` round-trip ; une entrée
    ACL round-trip fidèlement sur le fil (sans prétendre qu'elle est
    évaluée, § 2.2) ; `SSH_FXP_RENAME` avec l'indicateur `ATOMIC`.
13. **Unitaires codec fil SCP** : lignes de contrôle `C`/`D`/`E` bien
    formées et round-trip, acquittement `0x00`/`0x01`/`0x02` cohérent
    avec le résultat de l'opération, un fichier récursif produit la
    bonne séquence `D`.../`C`.../`E`.
14. **Non-régression (P1–P18)** : exécution complète des suites FTP/
    TFTP/SFTP nouvellement créées et des suites existantes (`nat-pat*`,
    `sftp-*`, `scp-*`, shells Huawei/Cisco) après chaque phase,
    garantissant l'absence d'effet de bord tant que P19 n'est pas
    atteinte.
15. **Migration (P19)** : suites SFTP/SCP/NAT existantes ré-exécutées
    après bascule sur les nouveaux moteurs — vérifier que les
    comportements observables (contenu transféré, listes de répertoire,
    codes d'erreur applicatifs, statistiques NAT) sont **identiques** à
    l'avant-migration ; test dédié pour le nouveau serveur FTP Huawei
    (le port 21 s'ouvre réellement une fois la fonctionnalité activée)
    et pour l'ALG (un scénario NAT existant qui échouait silencieusement
    pour FTP actif réussit désormais).

---

## 7. Risques et points d'attention

1. **Ampleur du chantier** : avec les non-objectifs promus, ce PRD
   couvre désormais quatre protocoles/renforcements distincts (FTP,
   TFTP, SFTP, SCP) plus l'ALG NAT — comparable en ampleur à
   `PRD-HTTP.md`. Refuser tout ajout non listé en § 2.1 sans mise à jour
   explicite de ce document ; ne pas laisser une phase déborder sur la
   suivante avant d'être verte.
2. **FTP est un chantier entièrement greenfield** : contrairement à
   SFTP/SCP, il n'y a aucune base existante à auditer au-delà de deux
   noms de port et d'un commentaire d'exclusion NAT — le risque n'est
   pas la régression mais la sous-estimation de la surface RFC 959
   (codes de réponse, cas d'erreur, interactions `TYPE`/`STRU`/`MODE`).
3. **Le canal de données est le point de complexité principal** :
   contrairement à HTTP/TLS/SFTP qui n'ouvrent qu'une seule connexion,
   FTP en ouvre structurellement deux, avec une négociation
   asymétrique (actif = client écoute, passif = serveur écoute) — ne pas
   sous-dimensionner `DataChannel.ts` en le traitant comme un simple flag
   sur le canal de contrôle.
4. **FXP et le « FTP bounce »** : historiquement, l'absence de
   vérification entre l'adresse `PORT` et le pair de contrôle a permis
   des attaques de rebond (balayage de ports tiers via un serveur FTP,
   documenté par RFC 2577) — ce PRD implémente le comportement RFC 959
   fidèle (donc vulnérable par construction, comme un vrai serveur FTP
   non durci) sans ajouter de protection dédiée ; ne pas confondre cette
   fidélité protocolaire avec une lacune de sécurité à corriger, mais la
   documenter clairement dans le code.
5. **FTPS hérite des limites de `PRD-TLS.md` §2.2** (cryptographie
   simulée, pas d'ECH, etc.) sans les redéfinir — documenter que ce PRD
   ne cherche pas à dépasser la fidélité déjà actée pour TLS.
6. **`PROT P` sur le canal de données est facile à oublier** : un
   développeur pressé pourrait ne protéger que le canal de contrôle
   (`AUTH TLS` seul) et laisser le canal de données en clair par défaut,
   contredisant RFC 4217 — les tests (§6.7) doivent vérifier
   explicitement les deux canaux séparément.
7. **L'ALG NAT est un point d'insertion, pas une réécriture** : toute
   tentation de dupliquer la logique de traduction de `NATEngine.ts`
   dans `FtpAlg.ts` plutôt que de s'y brancher serait une régression
   architecturale et un double point de vérité sur les liaisons NAT.
8. **TFTP n'a par construction aucune authentification/sécurité** — ne
   pas interpréter cette absence comme un gap à combler (RFC 1350 ne
   prévoit rien de tel) ; les tests ne doivent pas exiger de propriété
   de sécurité que le protocole réel ne fournit pas.
9. **SFTP/SCP : ne pas dupliquer la logique métier dans les nouveaux
   codecs** — `SftpWireCodec`/`SftpHandleTable`/`ScpWireCodec` doivent
   rester des adaptateurs purs au-dessus d'`ISftpFileSystem`/
   `SftpCommandDispatcher`/`ScpTransfer.ts` existants ; toute logique de
   permission/chroot dupliquée serait une régression architecturale
   (§ 3.4).
10. **SFTP : le modèle de handle change la surface d'erreur observable**
    — un `READ` sur un handle jamais ouvert, déjà fermé, ou périmé doit
    produire un code `SSH_FX_*` cohérent ; ne pas laisser cette surface
    nouvelle sous-testée.
11. **SFTP v4-v6 : ACL transportées mais pas appliquées** (§ 2.2) — les
    tests ne doivent jamais faire l'hypothèse qu'une entrée `deny` ACL
    bloque réellement un accès ; seul le modèle propriétaire/groupe/
    autres existant est évalué.
12. **Confinement par racine utilisateur (§2.1.9) dupliqué entre FTP et
    SFTP** : les deux protocoles visent le même principe
    (`ChrootedSftpFileSystem`) — vérifier qu'un même compte utilisateur
    voit la même racine confinée qu'il se connecte en FTP ou en SFTP,
    sans que les deux implémentations divergent silencieusement.
13. **Pas de dépendance bloquante, donc pas de séquencement imposé** :
    contrairement à `PRD-QUIC.md`/`PRD-HTTP.md`, aucune phase de ce PRD
    n'attend un chantier externe — le risque inverse existe : traiter les
    phases dans un ordre arbitraire sans respecter les dépendances
    internes du tableau § 5 (ex. tenter P8/FTPS avant P1/canal de
    contrôle).
14. **Absence de journal de coordination dédié** : si plusieurs agents
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
3. `MODE C` transfère un fichier contenant à la fois des séquences
   répétitives et non répétitives, round-trip bit-exact.
4. Un scénario FXP (deux connexions de contrôle vers deux serveurs
   distincts, `PASV` sur l'un puis `PORT`/`EPRT` vers ce même serveur
   depuis l'autre) transfère les octets directement entre les deux
   serveurs, sans passer par le pilote du test.
5. `AUTH TLS` sur un client/serveur FTP configurés avec un certificat non
   approuvé échoue proprement (pas de repli en clair silencieux) ; avec
   un certificat approuvé, un `PROT P` suivi d'un `STOR` protège
   effectivement le canal de données (vérifiable structurellement, pas
   juste par le succès du transfert).
6. Un client FTP actif situé derrière une traduction NAT complète un
   transfert sans configuration manuelle du canal de données, l'adresse/
   port annoncés dans `PORT` (ou dans la réponse `227` pour `PASV`) étant
   réellement cohérents avec la liaison NAT ouverte par `FtpAlg.ts`.
7. `REST 1024` suivi d'un `RETR` reprend effectivement à l'offset 1024
   plutôt que de retransférer le fichier entier.
8. `FEAT` annonce exactement l'ensemble des extensions RFC 3659
   implémentées, ni plus ni moins.
9. Un cycle TFTP complet (`RRQ` → plusieurs `DATA`/`ACK` → dernier bloc
   plus court que la taille négociée) transfère un fichier byte-exact ;
   une négociation `OACK` avec `blksize=4096` est honorée par les deux
   parties ; l'absence d'`ACK` déclenche une retransmission.
10. Une session SFTP pilotée directement au niveau paquet (`SSH_FXP_OPEN`
    → plusieurs `SSH_FXP_READ`/`SSH_FXP_WRITE` à des offsets différents →
    `SSH_FXP_CLOSE`) produit le même résultat qu'un `get`/`put` atomique
    équivalent via l'API existante de `SftpSession.ts`.
11. Une erreur de permission côté système de fichiers se traduit, au
    niveau du fil SFTP, par `SSH_FXP_STATUS` portant
    `SSH_FX_PERMISSION_DENIED` — pas un statut générique.
12. Une session SFTP négociée en version 6 round-trip une entrée ACL et
    un lien physique (`hardlink`) fidèlement sur le fil.
13. Un transfert `scp -r` produit une séquence de lignes de contrôle
    `D`/`C`/`E` cohérente avec l'arborescence copiée, chacune acquittée
    par le bon octet `0x00`/`0x01`/`0x02`.
14. Pendant P1–P18, toutes les suites existantes (`nat-pat`,
    `nat-pat-other`, les suites SFTP/SCP actuelles, les tests de shell
    Huawei/Cisco) passent **sans aucune modification**, confirmant que le
    module reste strictement additif jusqu'à P19.
15. Après P19 : `ftp server enable` sur un routeur Huawei ouvre
    réellement un port 21 accessible ; `nat alg ftp enable`
    (Huawei)/`ip nat service ftp` (Cisco) réécrivent réellement `PORT`/
    `PASV` à travers une traduction NAT ; `SshSftpChannel.ts`/
    `SftpCommandDispatcher.ts` et `ScpTransfer.ts` utilisent réellement
    leurs nouveaux encodages respectifs (vérifiable par un import direct
    dans le code), avec un résultat observable identique à
    l'avant-migration pour `SftpSession.ts`/`ScpTransfer.ts`.
