# SSH — état de la conformité aux RFC

Ce document dit, RFC par RFC, ce que la pile SSH du simulateur fait réellement,
où cela vit dans le code et ce qui manque. Il remplace les paragraphes
d'intention de `SSH-IMPLEMENTATION-ANALYSIS.md` pour tout ce qui touche au fil :
ce qui est écrit ici a été mesuré, soit par une sonde du dépôt, soit contre un
client OpenSSH 8.9p1 réel compilé hors dépôt (voir « Comment c'est éprouvé »).

Les textes des RFC sont dans `docs/rfc/ssh/`. Le fichier `rfc6666.txt` est le
RFC 6666 (« A Discard Prefix for IPv6 ») : il n'a rien à voir avec SSH. Le RFC
visé est probablement le RFC 6668 (SHA-2 pour SSH, `hmac-sha2-256/512`), dont
les algorithmes sont bien implémentés mais dont le texte n'est pas dans le dépôt.

## Les trois couches sont de vrais messages

Un échange SSH traverse le câble en paquets binaires de la RFC 4253 §6, scellés
après NEWKEYS. Chaque octet que le simulateur appelle « SSH » est le contenu
d'un de ces paquets :

| Couche | RFC | Numéros de message | Code |
| --- | --- | --- | --- |
| Transport | 4253 (+ 4250, 4251) | 1–49 | `protocols/ssh/transport/` |
| Authentification | 4252 (+ 4256 pour `keyboard-interactive`) | 50–79 | `protocols/ssh/auth/` |
| Connexion | 4254 | 80–100 | `protocols/ssh/connection/` |

Il n'existe plus de message local : l'ancien message 192 (une enveloppe JSON
`{"op": …}` portée par un « canal » qui n'était qu'un entier) a disparu avec le
lot C. Les canaux, fenêtres, EOF/CLOSE et requêtes de la RFC 4254 les
remplacent partout : exec, shell, SFTP, SCP, `direct-tcpip`, `tcpip-forward`.

## RFC 4253 — transport

Fait : échange d'identifications (§4.2, y compris les lignes précédant la
chaîne `SSH-`), KEXINIT et négociation (§7.1), paquets binaires avec bourrage
et numéro de séquence (§6), NEWKEYS, dérivation des clés (§7.2), signature de
l'échange `H` par la clé d'hôte (§8), `SERVICE_REQUEST`/`ACCEPT` (§10),
`DISCONNECT` avec ses codes (§11.1), `IGNORE`/`DEBUG`/`UNIMPLEMENTED` (§11),
`SSH_MSG_EXT_INFO` et `server-sig-algs` (RFC 8308), et le ré-échange de clés
(§9) : l'un ou l'autre côté peut envoyer KEXINIT en pleine session, les
messages émis entre KEXINIT et NEWKEYS sont retenus puis livrés dans l'ordre,
l'identifiant de session et les numéros de séquence ne changent pas, et la clé
d'hôte doit rester la même. `RekeyLimit` (client `-o`, `ssh_config`, `sshd_config`)
le déclenche par le volume (défaut d'OpenSSH : 134 217 728 blocs du chiffrement)
ou par la durée, en temps virtuel.

Algorithmes réellement implémentés (les autres noms sont connus, validés dans
`-o`, mais ni offerts ni choisis — `SshAlgorithms.ts`, `IMPLEMENTED_*`) :

- échange de clés : `curve25519-sha256` (et `@libssh.org`), `ecdh-sha2-nistp256`,
  `diffie-hellman-group{1,14}-sha1`, `group14-sha256`, `group16-sha512`,
  `group18-sha512`, `group-exchange-sha1/sha256` (RFC 4419) ;
- clés d'hôte : `ssh-ed25519` (RFC 8709), `ecdsa-sha2-nistp256` (RFC 5656),
  `rsa-sha2-256/512`, `ssh-rsa` ;
- chiffrements : `chacha20-poly1305@openssh.com`, `aes{128,192,256}-ctr`,
  `aes{128,256}-gcm@openssh.com` (la variante OpenSSH de la RFC 5647),
  `aes*-cbc`, `3des-cbc` ;
- MAC : `hmac-sha2-256/512` (RFC 6668), `hmac-sha1`, `hmac-sha1-96` et les
  variantes `-etm@openssh.com` ;
- compression : `none` seulement.

Les listes par défaut reproduisent celles d'OpenSSH 8.9p1 pour un serveur
Ubuntu 22.04 ; un routeur IOS 15 offre celles de la page « SSH Algorithms for
Common Criteria » de Cisco (`CiscoSshAlgorithms.ts`), avec ses échanges de clés
anciens, et un client réel y accède par `-oKexAlgorithms=+…`.

Manque, et c'est dit :

- pas de compression (`zlib@openssh.com` est connu, non offert) ;
- les courbes P-384/P-521, `sntrup761x25519-sha512@openssh.com`, DSA et les
  clés `sk-*` sont connus mais non implémentés.

## RFC 4252 — authentification

Fait : `none`, `password`, `publickey` (requête sans signature → `PK_OK`, puis
requête signée sur `session id ‖ requête`, `UserauthSignature.ts`),
`keyboard-interactive` (RFC 4256), `USERAUTH_BANNER`, `USERAUTH_FAILURE` avec la
liste des méthodes qui peuvent continuer et le drapeau « succès partiel »,
`MaxAuthTries` et la déconnexion qui le suit, `LoginGraceTime`.

Manque : `hostbased` (le mot-clé est lu et rendu, aucun message n'est évalué),
GSSAPI, le changement de mot de passe expiré (`PASSWD_CHANGEREQ`).

## RFC 4254 — connexion

Fait (`connection/SshConnection.ts`) :

- canaux : `CHANNEL_OPEN` / `CONFIRMATION` / `FAILURE` (les quatre codes de §5.1),
  fenêtre initiale de 2 Mio et paquet maximal de 32 Kio comme OpenSSH, consommée
  par chaque octet de `DATA`/`EXTENDED_DATA`, réajustée par `WINDOW_ADJUST` selon
  la politique de `channel_check_window` ; donnée sur un canal inexistant ou au-delà
  de la fenêtre → déconnexion ; `EOF` puis `CLOSE`, chaque côté répondant `CLOSE` ;
- requêtes de canal, les réponses partant dans l'ordre : `pty-req` (modes de
  terminal, dont ECHO et ONLCR), `env` (`LANG`, `LC_*` seulement), `shell`,
  `exec`, `subsystem` (`sftp`), `signal`, `exit-status` ;
- requêtes globales : `tcpip-forward` / `cancel-tcpip-forward` (le serveur écoute
  vraiment, applique `AllowTcpForwarding` et `GatewayPorts`, répond le port alloué
  pour `0`, ouvre un `forwarded-tcpip` par connexion acceptée),
  `keepalive@openssh.com` (réponse `REQUEST_FAILURE`, qui suffit à `ClientAlive*`) ;
- canaux : `session`, `direct-tcpip` (`-L`, `-D`, `-J` : le serveur compose la
  cible, applique `PermitOpen` et les options de clé), `forwarded-tcpip` (`-R`).

Le serveur reconnaît aussi `scp -t` et `scp -f` dans un `exec` et parle le
protocole source/puits de `scp.c` sur le canal (`scp/ScpServerSession.ts`), si
bien que le `scp` historique d'un vrai client OpenSSH fonctionne.

Extensions locales : quelques requêtes de canal portent des données propres au
simulateur (prompt publié, complétion, éditeur distant, marqueurs de résultat),
nommées `…@ubuntu-sandbox.local` comme la RFC 4251 §6 le permet ; un client réel
les ignore (réponse `CHANNEL_FAILURE`). Elles sont listées dans
`connection/SandboxExtensions.ts`.

Manque :

- **pas de stdin pour un `exec`** : la commande s'exécute dès la requête, sans
  attendre les octets que le client enverrait ensuite (`ssh h 'cat > f' < local`) ;
- `window-change` est acquittée sans redimensionner le terminal distant ;
- pas de transfert X11 (`x11-req`), pas de `auth-agent-req@openssh.com` sur ce
  chemin, pas de multiplexage (`ControlMaster`), pas de `tun@openssh.com` ;
- `subsystem` n'accepte que `sftp`.

## SFTP

Version 3, la seule qu'OpenSSH négocie (`sftp/SftpWireCodec.ts`,
`SftpWireSession.ts`). Les attributs ont la disposition de
`draft-ietf-secsh-filexfer-02` §5 : `SIZE 0x1`, `UIDGID 0x2`, `PERMISSIONS 0x4`,
`ACMODTIME 0x8`, `EXTENDED 0x80000000`, le type du fichier étant dans les bits
`S_IFMT` du mode. Le serveur annonce `statvfs@openssh.com` dans `VERSION`
(c'est ce qui rend `df` possible), répond `STAT`, `FSTAT`, `SETSTAT`, `FSETSTAT`,
`READDIR` (avec un `longname` au format de `ls -l`), `OPEN` avec `CREAT`/`TRUNC`/
`EXCL`/`APPEND`, `READ`/`WRITE` à des décalages, `RENAME`, `REALPATH`, `SYMLINK`,
`READLINK`.

Limite assumée : le moteur propose aussi des versions 4 à 6 (négociées de 3 à 6),
mais leur disposition d'attributs n'est PAS celle des brouillons correspondants —
les textes de `draft-ietf-secsh-filexfer-04…13` ne sont pas dans le dépôt, et rien
n'est implémenté à l'aveugle. Un vrai client négocie 3. Le contenu d'un fichier
est tamponné en mémoire et écrit à `CLOSE`.

## Redirections de ports

`-L`, `-D` (SOCKS5 CONNECT) et `-R` des sessions interactives passent par des
canaux : l'écouteur local accepte, le client ouvre un `direct-tcpip` (ou, pour
`-R`, le serveur ouvre un `forwarded-tcpip` vers le client, qui compose la cible).
La politique est celle du SERVEUR, et ses refus arrivent au moment de la
connexion, dans les mots d'OpenSSH (`channel 0: open failed: administratively
prohibited: open failed`).

Reste l'ancien chemin `executeCommand` (`LinuxSshClient`/`SshForwardingTable`),
qui compose depuis la pile du serveur sans passer par SSH et lit la politique en
atteignant l'objet distant : voir « Reste à faire ».

## Comment c'est éprouvé

- sondes du dépôt : `probe-ssh-connexion-rfc-4254-*`, `probe-ssh-session-rfc-4254-*`,
  `probe-ssh-forwards-et-sftp-*`, `probe-scp-serveur-*` ;
- hors dépôt, contre un `ssh`/`sftp`/`scp` 8.9p1 réel compilé depuis les sources
  d'OpenSSH et relié à un `LinuxServer` du simulateur par une vraie socket :
  `exec` (stdout, stderr séparés, code de sortie), `-tt` et `-T`, `sftp`
  (`pwd`, `ls`, `ls -l`, `get`, `put`, `mkdir`, `rm`, `df`), `scp` vers le
  serveur, `-L` et `-R` ; contre le routeur IOS : `ssh -tt` et `exec`.
  C'est ce banc qui a révélé la disposition d'attributs SFTP fausse.

## Reste à faire

- stdin d'un `exec`, `window-change` effectif ;
- le chemin `executeCommand` des redirections, avec le reste du repli en mémoire
  de `runSshClient` (le même objet distant est lu pour la politique et pour
  l'état) ;
- SFTP v4–v6 sur le texte des brouillons, quand il sera disponible ;
- `hostbased`, GSSAPI, `zlib@openssh.com`.
