# Changelog

Journal des évolutions du socle `command-kernel` et de sa migration
progressive par équipement. Un push = une entrée = une fonctionnalité
complète et testée (voir `CLAUDE.md` / le framework de migration pour les
principes directeurs).

## Routeur Cisco — filtrage BGP par voisin (`neighbor <ip> prefix-list <name> in|out`)

**Changement de couche métier** (fin du lot Windows Server AD DS — retour
à la simulation réseau générale). `ip prefix-list`/`route-map` existaient
déjà côté CLI (`PolicyRepository`, `CiscoPolicyCommands.ts`) mais
n'avaient **aucun effet réel** : `show ip prefix-list`/`show route-map`
projetaient un état jamais consulté par un moteur de protocole — un vrai
trou de couche métier derrière une façade CLI qui répondait normalement.

`PolicyRepository` gagne `evaluatePrefixList(name, network, prefixLength)`
— longest-first-match réel (bornes `ge`/`le`, sans elles une entrée exige
une longueur de préfixe exacte, sémantique IOS authentique), `null` si la
liste n'existe pas ou qu'aucune entrée ne correspond (deny implicite,
charge à l'appelant). Exposé via un nouveau hook optionnel
`IRouterShell.evaluatePrefixList` (implémenté par `CiscoIOSShell`),
propagé paresseusement à travers `RoutingDeviceContext`/
`DynamicRoutingCtx` jusqu'à `BGPEngine` (aucun changement d'ownership,
aucun souci d'ordre de construction — uniquement des fermetures
différées, sur le modèle déjà établi de `getRipEngine`/`getOspfIntegration`).

`BgpNeighborCfg` gagne `prefixListIn`/`prefixListOut` ; `BGPEngine` les
applique désormais réellement : `onUpdate` (Adj-RIB-In) rejette toute
NLRI entrante que la liste nommée ne permet pas explicitement, et
`advertiseTo` (Adj-RIB-Out) n'annonce à ce voisin que ce que la liste
nommée permet. CLI : `neighbor <ip> prefix-list <name> in|out` dans
`router bgp`, reflété dans `show ip bgp neighbors`.

**Validation** : `PolicyRepository.evaluatePrefixList` (5 tests unitaires
— première correspondance par ordre de seq, bornes ge/le, correspondance
de longueur exacte sans ge/le, liste inconnue) + 4 nouveaux tests
`BGPEngine` (filtrage entrant, filtrage sortant, liste inexistante =
deny implicite, absence de filtre = comportement inchangé) + 1 test CLI
bout-en-bout (deux `CiscoRouter` réellement câblés, `ip prefix-list` +
`neighbor ... prefix-list ... in` filtrant un préfixe appris sur
`show ip route`). Suite BGP élargie (engine/bestpath/session/messages/
intégration CLI EIGRP+BGP) : 52/52 au vert. Régression routeur plus
large (architecture/HSRP/ACL/NAT/show) : 127/127 au vert. Typecheck et
lint ciblés propres (mêmes 8 erreurs `tsc` et mêmes avertissements
`eslint` pré-existants qu'avant ce changement, aucun nouveau).

## Linux — Phase 16 : `md5sum` / `sha1sum` / `sha256sum`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commandes migrées** : `md5sum`/`sha1sum`/`sha256sum [-c] FICHIER...` —
calcul (`hash  fichier`) et vérification (`-c`) d'empreintes, portées par
une base commune `ChecksumCommand` et trois sous-classes (une par
algorithme).

- La lecture des fichiers passe par `ctx.machine.fs` ; les fonctions de
  hachage restent **partagées** (`@/crypto/hash` : `md5Hex`/`sha1Hex`/
  `sha256Hex`), pas resimulées. Mode `-c` : parsing des lignes
  `empreinte  chemin`, `OK`/`FAILED`, avertissement + code 1 en cas
  d'échec ; mode direct : code 0 même si un fichier manque (quirk legacy
  conservé).
- **Legacy supprimé** : le `case 'md5sum'/'sha256sum'/'sha1sum'`, la
  fonction `checksumVfs()` et l'import `md5Hex/sha1Hex/sha256Hex` retirés
  de `LinuxCommandExecutor`. Nouveaux tests (empreintes connues de
  « hello » + vérification `-c`).

Validation : tests checksum verts (md5/sha1/sha256 de « hello » exacts,
`-c` → `OK`) ; cohérence stricte + archive-commands verts ; aucune
régression (83 tests).

## Linux — Phase 15 : `locale`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `locale` — affiche les paramètres régionaux actifs,
portée par `LocaleCommand`.

- Les catégories (`LANG`, `LANGUAGE`, `LC_CTYPE`…`LC_ALL`) sont dérivées de
  l'environnement de la session (`ctx.session.env`) ; chaque `LC_*` non
  défini retombe sur la locale effective (`LC_ALL` sinon `LANG` sinon `C`),
  exactement comme le legacy.
- **Legacy supprimé** : le `case 'locale'` retiré de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `locale`
  (`export LANG=… ; locale`).

Validation : test `locale` vert (LANG reflété, repli des catégories) ;
cohérence stricte + host-identity verts ; aucune régression (74 tests).

## Linux — Phase 14 : `file`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `file FICHIER...` — devine le type de chaque fichier
(lien symbolique, répertoire, périphérique caractère, archive gz/tar/zip,
script `#!`, texte ASCII, données binaires), portée par `FileCommand`.

- La classification reproduit à l'identique la logique historique
  `describeFile`, désormais alimentée par `ctx.machine.fs` (`lstat` +
  lecture, `symlinkTarget`) et le détecteur d'archives pur **partagé**
  `describeArchiveContent`.
- **Legacy supprimé** : le `case 'file'` **et** la méthode `describeFile()`
  retirés de `LinuxCommandExecutor`, import `describeArchiveContent`
  devenu inutile nettoyé.

Validation : `archive-commands.test.ts` passe intégralement (16/16, dont
les 8 assertions `file` : texte, `.gz`, `.tar`, `.zip`, répertoire,
fichier absent, vide, script `#!`) ; cohérence stricte verte ; aucune
régression (67 tests).

## Linux — Phase 13 : `mktemp`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `mktemp [OPTION]... [MODÈLE]` — portée par
`MktempCommand`.

- Renvoie un nom de fichier temporaire unique au format `/tmp/tmp.<aléa>`
  (10 caractères base36). Le simulateur ne matérialise pas le fichier
  (comportement historique conservé à l'identique) ; les options
  (`-d`, template `XXXXXX`...) sont acceptées mais ignorées.
- **Legacy supprimé** : le `case 'mktemp'` retiré de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `mktemp` (format + unicité).

Validation : test `mktemp` vert ; aucune régression.

## Linux — Phase 12 : `truncate`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `truncate -s TAILLE FICHIER...` — portée par
`TruncateCommand`.

- Le simulateur ne modélisant pas les tailles d'octets, la commande se
  limite (comme le legacy) à créer un fichier vide s'il n'existe pas, et
  publie les évènements d'audit `fsAccess`/`syscall` « truncate » via la
  capacité `ctx.machine.audit` — indispensable pour que `auditctl -w`
  capte l'accès.
- **Legacy supprimé** : le `case 'truncate'` retiré de
  `LinuxCommandExecutor.dispatch()`.

Validation : `auditctl-other.test.ts` passe intégralement (150/150, dont
le suivi `syscall=truncate` d'un fichier surveillé) ; cohérence stricte
verte ; aucune régression (67 tests).

## Linux — Phase 11 : `tty`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `tty [-s]` — affiche le nom du terminal relié à
l'entrée standard, portée par `TtyCommand`.

- En mode exec SSH sans pseudo-terminal (le client pose `SSH_NO_TTY=1`,
  lu depuis `ctx.session.env`), répond « not a tty » avec le code de
  sortie 1 ; sinon `/dev/pts/0`. Option `-s` (silencieux) gérée. Le
  formatage du chemin reste porté par le helper pur partagé `cmdTty`.
- **Legacy supprimé** : le `case 'tty'` retiré de
  `LinuxCommandExecutor.dispatch()`, import `cmdTty` devenu inutile
  nettoyé.

Validation : `linux-system-info.test.ts` (`tty` → `/dev/pts/0`) et les cas
SSH `cross-equipment-ssh-suite.test.ts` (`ssh -t … tty` → `/dev/pts`,
`ssh … tty` → `not a tty`) passent ; aucune régression (les 19 échecs
préexistants de cette suite, sans rapport avec `tty`, sont identiques
avant/après).

## Linux — Phase 10 : `printenv`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `printenv [VARIABLE...]` — affiche tout
l'environnement (`NOM=valeur`) ou la valeur de variables nommées (une par
ligne, code de sortie 1 si l'une est absente), portée par
`PrintenvCommand`.

- L'environnement est lu depuis la session command-kernel
  (`ctx.session.env`) — qui reflète bien les affectations `export`
  antérieures dans la même ligne/pipeline (validé par
  `export MYTOKEN=… ; printenv MYTOKEN`).
- **Legacy supprimé** : le `case 'printenv'` retiré de
  `LinuxCommandExecutor.dispatch()`.

Validation : `env-vars.test.ts` passe intégralement (9/9, dont
`printenv`, `printenv SHELL`, export puis lecture, variable absente) ;
cohérence stricte verte ; aucune régression (66 tests).

## Linux — Phase 9 : `rev`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `rev [fichier...]` — inverse l'ordre des caractères
de chaque ligne, portée par `RevCommand`.

- Lit désormais l'entrée standard **ou les fichiers** passés en argument
  (comportement GNU ; le legacy était limité à stdin) via les helpers
  partagés `readTextInput`/`splitLines`/`joinLines`. La structure des
  lignes et le saut de ligne final sont préservés à l'octet près (mêmes
  résultats que le legacy pour le cas stdin).
- **Legacy supprimé** : le `case 'rev'` retiré de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `rev` ajouté
  (`linux-commands-and-oracle-tools.test.ts`).

Validation : tests `rev` verts, cohérence stricte verte ; aucune
régression (67 tests).

## Linux — Phase 8 : `sleep`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `sleep NOMBRE[SUFFIXE]...` — portée par la commande
command-kernel `SleepCommand`.

- Le simulateur étant synchrone, la durée calculée est ignorée (exactement
  comme le legacy) : seule la **validation** des opérandes compte (`1`,
  `1s`, `2m`, `1h`, `1d`, `0.5`, sommes de plusieurs durées, erreur
  « invalid time interval » sur token invalide). Le parsing des durées
  reste porté par le module pur **partagé** `runSleep` (`coreutils/Sleep.ts`).
- **Legacy supprimé** : le `case 'sleep'` retiré de
  `LinuxCommandExecutor.dispatch()`, import `runSleep` devenu inutile
  nettoyé ; `sleep` reste dans la liste des commandes connues.

Validation : `test-expr-seq-sleep-time-watch.test.ts` passe intégralement
(53/53, dont les cas `sleep 1 && echo DONE`, suffixes, `sleep || echo BAD`,
`sleep abc`, `sleep 0.5`) ; cohérence stricte verte ; aucune régression
Linux voisine (77 tests).

## Linux — Phase 7 : `expr`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `expr EXPRESSION` — évaluation d'expressions
(arithmétique, comparaison, chaînes), portée par la commande
command-kernel `ExprCommand`.

- Toute l'évaluation (priorités, opérateurs `+ - * / % = < > | &`,
  `match`/`substr`/`length`/`index`) reste assurée par l'évaluateur pur
  **partagé** `runExpr` (`coreutils/ExprEvaluator.ts`). `ExprCommand` capte
  les opérandes bruts (`lenientOptions`), termine la sortie par un saut de
  ligne (comportement GNU) et conserve les codes de sortie exacts de GNU
  `expr` (`0` vrai, `1` faux, `2`/`3` erreur).
- **Legacy supprimé** : le `case 'expr'` et son wrapper `handleExpr()`
  retirés de `LinuxCommandExecutor`, import `runExpr` devenu inutile
  nettoyé ; `expr` reste dans la liste des commandes connues.

Validation : le fichier `test-expr-seq-sleep-time-watch.test.ts` (qui
pilote un `LinuxCommandExecutor` nu, résolu via son shell command-kernel
par défaut) passe intégralement (53/53) ; cohérence stricte verte ; aucune
régression Linux voisine (130 tests).

## Linux — Phase 6 : `seq`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `seq [OPTION]... PREMIER [PAS] DERNIER` — génération
d'une suite de nombres, portée par la commande command-kernel
`SeqCommand`.

- Le rendu (formats GNU `-w`/`-f`/`-s`/`-t`, précision décimale, pas
  négatif, largeur égale) reste assuré par le générateur pur **partagé**
  `runSeq` (`coreutils/SeqGenerator.ts`) — pas de resimulation. `SeqCommand`
  capte les opérandes bruts (`lenientOptions`, le parsing des options
  appartient à `runSeq`) et termine la sortie par un saut de ligne dès
  qu'elle est non vide (comportement GNU, indispensable en pipeline
  `seq N | wc -l`).
- **Legacy supprimé** : le `case 'seq'` retiré de
  `LinuxCommandExecutor.dispatch()` et l'import `runSeq` devenu inutile
  nettoyé ; `seq` reste dans la liste des commandes connues.

Validation : les tests `seq` de `linux-commands-and-oracle-tools.test.ts`
passent, cas limites vérifiés (séparateur `-s`, largeur `-w`, pipeline,
premier négatif, pas) ; cohérence stricte inter-machines verte ; aucune
régression Linux voisine (143 tests).

## Linux — Phase 5 : `basename` / `dirname`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commandes migrées** : `basename NOM [SUFFIXE]` / `basename -a [-s SUFFIXE]
NOM...` et `dirname NOM...` — manipulation de chemin purement textuelle
(aucun accès au VFS), portée par les commandes command-kernel
`BasenameCommand` / `DirnameCommand`.

- Sémantique POSIX complète (là où le legacy était simpliste) : les slashs
  finaux sont ignorés (`basename /usr/` → `usr`, `dirname /usr/bin/` →
  `/usr`), un chemin entièrement composé de slashs donne `/`, et les
  formes multiples (`-a`, `-s SUFFIXE`, séparateur NUL `-z`) sont gérées —
  aucune capacité `MachineApi` requise (chaînes pures).
- **Legacy supprimé** : les `case 'basename'` et `case 'dirname'` retirés
  de `LinuxCommandExecutor.dispatch()` — aucun autre appelant, absents du
  framework `LinuxCommand`. Les deux restent dans la liste des commandes
  connues (résolution `which`/`command -v` inchangée).

Validation : les tests `basename`/`dirname` de
`linux-commands-and-oracle-tools.test.ts` passent, cohérence stricte
inter-machines `ssh-lan-strict-coherence.test.ts` (SC34) verte ; aucune
régression sur les suites Linux voisines (command-kernel, vfs-path,
availability, bash-scripts, sftp — 227 tests).

## Windows Server — application du bit `SMARTCARD_REQUIRED` (`userAccountControl`)

Totalement absent jusqu'ici. `checkPassword` (bind simple LDAP, même
périmètre volontaire que le verrouillage/l'expiration/`maxPasswordAge`)
refuse désormais systématiquement l'authentification par mot de passe
dès que le bit `SMARTCARD_REQUIRED` (`0x40000`) est posé — comportement
réel d'AD : seule une ouverture de session par carte à puce (PKINIT,
non modélisée ici) fonctionnerait. `AdUser` gagne
`smartcardRequired: boolean` ; `setUser` accepte désormais
`smartcardRequired` en lecture-modification-écriture du bit, sans
toucher aux autres bits (`enabled`/`passwordNeverExpires`).

**Validation** : nouveau `ad-smartcard-required.test.ts` (5 tests) —
valeur par défaut, blocage de l'authentification une fois le bit posé
même avec le bon mot de passe, réauthentification après levée du bit,
non-altération des bits UAC non liés, absence d'effet sur
`enabled`/`lockedOut`. Suite élargie (`ad-directory-store`/expiration/
politique de mot de passe/dernière-connexion/types de chiffrement
Kerberos/échange AS) : 85/85 au vert. Typecheck et lint ciblés propres.

## Windows Server — application de `msDS-SupportedEncryptionTypes` (Kerberos)

Totalement absent jusqu'ici : le KDC (`KdcSession`) émettait toujours un
ticket AES256, sans jamais consulter la restriction de types de
chiffrement d'un compte. `AdUser`/`AdComputer` gagnent
`supportedEncryptionTypes: number` (bitmask), avec accesseurs
`get/setUserSupportedEncryptionTypes` et `get/setComputerSupportedEncryptionTypes`
sur `DirectoryStore`, et `supportsAes256(sam, isComputer)` pour
l'application. Valeur par défaut quand l'attribut n'a jamais été posé :
`0x1C` (RC4+AES128+AES256), reflet du comportement réel d'un domaine
moderne — un `0` explicite reste distinct de « jamais configuré » et
désactive bien AES256.

`handleAsReq` (AS-REQ) refuse désormais avec `KDC_ERR_ETYPE_NOSUPP` dès
que le compte authentifiant (utilisateur ou ordinateur) n'a pas le bit
AES256, ou que le client n'offre pas l'etype 18 — AES256 étant le seul
chiffrement réellement implémenté par ce simulateur (`crypto.ts`), un
compte restreint ne peut pas être « replié » sur un autre algorithme.
**Périmètre volontairement borné à l'AS-REQ** (authentification
initiale) — le TGS-REQ/S4U2Proxy n'est pas touché, cohérent avec la
discipline déjà appliquée au verrouillage/à l'expiration de compte.

**Validation** : nouveau `ad-supported-encryption-types.test.ts` (9 tests :
valeur par défaut, accesseurs get/set utilisateur et ordinateur, échec
sur identité inconnue, `supportsAes256`, `0` explicite vs non configuré,
plus 3 tests d'intégration bout-en-bout sur un vrai câble TCP/88 —
échange réussi par défaut, refus après restriction, rétablissement après
réautorisation). Suite Kerberos élargie (AS/TGS/S4U2Proxy/RBCD/
`ad-directory-store`/dernière-connexion/contacts) : 86/86 au vert.
Typecheck et lint ciblés propres.

## Windows Server — refactor : extraction de `ContactStore` hors de `DirectoryStore.ts`

**Refactor, pas une nouvelle fonctionnalité.** `DirectoryStore.ts` avait
dépassé les 1000 lignes au fil du lot de 10+ fonctionnalités (discipline
du projet : pas de fichier au-delà de ~400 lignes, déjà appliquée une
fois cette session pour `WindowsServer.ts` via l'extraction de
`DomainControllerOps.ts`). La section Contacts (`newContact`/
`getContact`/`listContacts` + projection) était la tranche la plus
proprement isolable — elle ne partage d'état avec le reste de
`DirectoryStore` que l'arbre LDAP (`tree`) et l'OU `Users` par défaut.

Extraite vers `ad/contact/ContactStore.ts` (même schéma que
`ManagedServiceAccountStore`/`PasswordReplicationPolicy` : classe
composée par référence, prenant `tree` + `usersOuDn`, avec ses propres
petits helpers dupliqués plutôt que d'exporter les helpers internes de
`DirectoryStore`). `DirectoryStore` ne garde que des méthodes de
délégation fines ; `newContact` continue de résoudre le conteneur OU
et d'allouer le RID/objectSid lui-même avant de déléguer.

**Validation** : aucune régression de comportement — `ad-contacts.test.ts`
(7 tests, écrit contre l'API publique de `DirectoryStore`, donc inchangé
par ce refactor) plus la suite élargie (verrouillage/expiration/
groupes/RBCD/réplication/dernière-connexion/politique de mot de passe/
`ad-directory-store`) : 101/101 au vert. Typecheck et lint ciblés propres.

## Windows Server — suivi de la dernière connexion (`lastLogonTimestamp`)

Totalement absent jusqu'ici. `checkPassword` (bind simple LDAP, même
périmètre volontaire que le verrouillage/l'expiration) tamponne
désormais `lastLogonTimestamp` sur chaque authentification réussie,
fondu dans le même appel `modifyEntry` que la remise à zéro de
`badPwdCount`. `AdUser` gagne `lastLogonTimestamp: number | null`.

**Simplification documentée** : AD réel distingue `lastLogon`
(par-DC, jamais répliqué) de `lastLogonTimestamp` (répliqué, mais mis
à jour seulement au-delà d'un certain seuil d'ancienneté pour éviter
les tempêtes de réplication) — ce simulateur ne modélise que
l'équivalent de `lastLogonTimestamp`, mis à jour à chaque succès sans
palier d'ancienneté.

**Validation** : nouveau `ad-last-logon.test.ts` (4 tests) — `null`
avant toute authentification, tamponné après un succès, jamais
tamponné après un échec, avance à chaque nouveau succès. Suite élargie
(verrouillage/politique de mot de passe/expiration/`ad-directory-store`) :
66/66 au vert. Typecheck et lint ciblés propres.

## Windows Server — introspection des métadonnées de réplication (`Get-ADReplicationAttributeMetadata`)

Le timbre par attribut (`AttributeReplStamp`, ajouté par la mise à
niveau de réplication par attribut) n'était utilisable que par le
moteur de réplication lui-même. Nouveau `getReplicationMetadataFor(dn)`
sur `DirectoryStore`, projetant la `Map` interne en tableau plat
`ReplicationAttributeMetadata[]` (`attributeName` +
`originatingInvocationId`/`originatingUsn`/`version`/`timestamp`) —
`null` si l'objet n'existe pas, `[]` s'il existe mais n'a jamais été
timbré.

**Validation** : nouveau `ad-replication-metadata.test.ts` (3 tests) —
une écriture réelle fait progresser `version` (1 puis 2 après un second
changement), `null` sur un DN inconnu, deux DC convergent vers des
timbres strictement identiques (`originatingInvocationId`, `version`,
`originatingUsn`) pour un attribut après un cycle de réplication réel.
Suite élargie (`ad-replication`, `ad-directory-store`, `ad-rodc`) :
65/65 au vert. Typecheck et lint ciblés propres.

## Windows Server — délégation contrainte basée sur la ressource (RBCD)

Seule la délégation contrainte classique (front-end, `msDS-
AllowedToDelegateTo` déclaré côté service intermédiaire) existait.
Ajout du sens inverse (MS-SFU, `msDS-AllowedToActOnBehalfOfOtherIdentity`) :
la ressource elle-même autorise des principaux spécifiques à déléguer
vers elle, plutôt que l'inverse. Nouveaux
`setResourceBasedConstrainedDelegation(resourceComputerName,
allowedPrincipalSams)`/`getResourceBasedConstrainedDelegation(...)` sur
`DirectoryStore` — même simplification de liste directe de sam déjà
établie pour `PrincipalsAllowedToRetrieveManagedPassword` du gMSA.

`isDelegationAllowedFrom` (le portail S4U2Proxy de `KdcSession`)
vérifie désormais les deux voies — classique OU basée sur la ressource
— sans aucun changement à `KdcSession.ts` : le même échange KDC S4U2Proxy
existant sert les deux mécanismes, seule l'autorisation gagne une
deuxième voie.

**Validation** : nouveau `kerberos-rbcd.test.ts` (3 tests) — délégation
autorisée uniquement via RBCD (sans configuration classique), refus
quand la ressource ne liste pas le service délégant, échec propre sur
un ordinateur ressource inconnu. Suite élargie (`kerberos-s4u2proxy`,
`ad-directory-store`, `ad-contacts`) : 62/62 au vert, aucune régression
sur la délégation classique. Typecheck et lint ciblés propres.

## Windows Server — objets contact (`New-ADObject -Type contact`)

Absent jusqu'ici : `AdContact` (`AdTypes.ts`) et `newContact`/`getContact`/
`listContacts` sur `DirectoryStore` — une personne externe sans capacité
de connexion (`objectClass: ['top','person','organizationalPerson',
'contact']`, ni `sAMAccountName`, ni `userAccountControl`, ni mot de
passe). Attributs `displayName`/`mail`/`telephoneNumber`, placement en
OU optionnel (même convention que `newUser`). Reçoit tout de même un
`objectSid` du pool de RID local, comme tout autre objet ici (AD réel en
attribue aussi un, même si un contact n'est jamais un principal de
sécurité utile).

**Validation** : nouveau `ad-contacts.test.ts` (7 tests) — création avec
attributs complets/vides, placement en OU, refus de doublon,
énumération, retour `null` sur un contact inconnu, confirmation qu'un
contact n'apparaît jamais via `getUser`/`listUsers` (`findUserEntry`
filtre déjà sur l'objectClass `user`, absent des contacts). Suite
élargie (3 fichiers) : 78/78 au vert. Typecheck et lint ciblés propres.

## Windows Server — imbrication de groupes protégée contre les cycles

`addGroupMember` n'acceptait jusqu'ici qu'un utilisateur ou un
ordinateur comme membre — aucune voie publique n'existait pour imbriquer
un groupe dans un autre. Résout désormais aussi les groupes (comme
`Add-ADGroupMember` réel), avec une vérification anti-cycle : refuse
l'auto-appartenance directe (`Cannot make a group a member of itself`,
message réel d'AD) et transitive, via un nouveau
`isReachableViaMembership` privé qui parcourt l'appartenance imbriquée
du membre candidat pour vérifier si le groupe cible y est déjà
atteignable. `removeGroupMember` mis à jour symétriquement pour
résoudre aussi les groupes.

**Validation** : nouveau `ad-group-nesting.test.ts` (6 tests) —
imbrication simple autorisée, auto-appartenance directe refusée, cycle
à deux et trois niveaux refusé, diamant non cyclique (deux groupes
parents partageant un même groupe enfant) autorisé,
`removeGroupMember` retire bien un membre imbriqué. Suite élargie
(5 fichiers, y compris la conversion de portée de groupe de la tâche
précédente) : 111/111 au vert. Typecheck et lint ciblés propres.

## Windows Server — règles de conversion de portée de groupe (`Set-ADGroup -GroupScope`)

Aucune règle n'était appliquée jusqu'ici — n'importe quel changement de
portée réussissait sans condition. `DirectoryStore` gagne
`setGroupScope(sam, newScope)`, appliquant la vraie matrice de
conversion d'AD :

- `Global` ↔ `DomainLocal` : jamais direct (il faut passer par
  `Universal`).
- `Global` → `Universal` : refusé si le groupe est déjà membre d'un
  autre groupe de portée `Global`.
- `DomainLocal` → `Universal` : refusé si le groupe a un membre de
  portée `DomainLocal`.
- `Universal` → `Global` : refusé si le groupe a un membre de portée
  `Universal`.
- `Universal` → `DomainLocal` : toujours autorisé.
- Même portée demandée que la portée actuelle : succès immédiat, sans
  écriture.

Nouveau helper privé `groupScopeOfDn(dn)` — résout un DN `member`/
`memberOf` vers la portée du groupe qu'il désigne, réutilisant le même
schéma d'attribut déjà établi partout ailleurs dans ce fichier.

**Validation** : nouveau `ad-group-scope-conversion.test.ts` (11 tests)
— chacune des 5 règles testée dans son sens autorisé et son sens
refusé, no-op sur portée identique, échec propre sur un groupe inconnu.
Suite élargie (`ad-directory-store`, `ad-builtin-groups`, `ad-forest`) :
78/78 au vert. Typecheck et lint ciblés propres.

## Windows Server — groupes de sécurité intégrés (`Administrators`, `Account Operators`, etc.)

Seuls Domain Admins/Domain Users/Domain Computers étaient semés
jusqu'ici. `seedDefaults` sème désormais 8 groupes intégrés
supplémentaires (`Administrators`, `Account Operators`, `Backup
Operators`, `Server Operators`, `Print Operators`, `Cert Publishers`,
`Group Policy Creator Owners`, `DnsAdmins`), portée `DomainLocal`.
`Administrator` devient membre d'`Administrators` en plus de Domain
Admins/Domain Users.

**Simplification documentée** : AD réel place la plupart de ces groupes
dans un conteneur `CN=Builtin` dédié, sous des SID bien connus non
relatifs au domaine (`S-1-5-32-544` pour Administrators, etc.) —
`formatObjectSid` de ce simulateur ne modélise que des RID relatifs au
domaine, donc ces groupes sont semés dans `CN=Users` avec des SID
ordinaires du pool de RID local, comme tout autre objet ici. Enterprise
Admins/Schema Admins (niveau forêt) restent délibérément hors périmètre.

`SdProp.ts`'s `PROTECTED_GROUPS` passe de `['Domain Admins']` à
`['Domain Admins', 'Administrators', 'Account Operators', 'Backup
Operators', 'Server Operators', 'Print Operators']` — une passe SDProp
marque désormais aussi les membres de ces groupes fraîchement protégés.

**Deux assertions à liste exacte corrigées** dans
`ad-directory-store.test.ts` (« listGroups includes seeded and created
groups », « Administrator's memberOf reflects seeded group
membership ») — mécaniquement affectées par les 8 nouveaux groupes et
la nouvelle appartenance d'Administrator.

**Validation** : nouveau `ad-builtin-groups.test.ts` (5 tests) —
existence et portée `DomainLocal` de chaque groupe intégré,
appartenance d'Administrator, un utilisateur ordinaire n'y appartient
pas par défaut, SDProp marque les membres d'Account Operators/Backup
Operators/Server Operators/Print Operators. Suite élargie (9 fichiers,
verrouillage/politique de mot de passe/expiration/forêt/GPO) : 69/69 au
vert après correction des deux assertions. Typecheck et lint ciblés
propres.

## Convergence de branche : Windows Server (expiration de mot de passe) + Windows Phases 25-27 (`dnscmd`/`runas`/`slmgr`) + correctif `whoami`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `command-kernel`, sans recouvrement de
fichiers en dehors de `CHANGELOG.md`.

### Windows Phase 30 : migration de `query session` / `qwinsta` / `logoff` / `rwinsta` vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration des utilitaires de session Bureau à distance (`query session`,
`qwinsta`, `logoff`, `rwinsta`) — jusqu'ici non dispatchés — vers le socle
`command-kernel`.

- Nouvelle capacité optionnelle `rdpSessions?: RdpSessionsApi` sur
  `MachineApi` : `list()` (introspection de la table de sessions RDP) et
  `logoff(sessionId)` (fermeture). Type `RdpSessionInfo` au contrat. Les
  sessions RDP vivent sur tout `WindowsPC` (client comme serveur) — pas de
  frontière serveur ici.
- Commandes `QueryCommand` (sous-commande `session`), `QwinstaCommand`,
  `LogoffCommand`, `RwinstaCommand` : parsing, aide en `usage`, mise en
  page de la table (`SESSIONNAME`/`USERNAME`/`ID`/`STATE`/`TYPE`) et
  messages (`No session exists for ID …`) portés côté commande via des
  helpers partagés.
- Fichier mort `WinRdpCommands.ts` supprimé (migrate-then-delete).

Validation : `rdp-negotiation.test.ts` passe intégralement (5/5, contre
3/5 auparavant) ; aucune régression.

## Windows Phase 29 : migration de `certreq` / `certutil` vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration de `certreq` / `certutil -submit` (demande de certificat à AD CS,
MS-WCCE) — jusqu'ici non dispatchés — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `certificateServices?: CertificateServicesApi`
  sur `MachineApi` : `submitRequest(subject, template, eku)` (émission
  signée par l'AC + stockage du certificat dans le magasin local). Types
  `CertificateServicesApi` / `CertificateIssuance` au contrat.
- `WindowsMachineApi` expose `certificateServices` en **getter live**
  (jamais mémoïsé) car le rôle AD CS peut être installé après la
  construction du shell ; `null` tant que l'AC n'est pas installée.
- Commandes `CertreqCommand` / `CertutilCommand` : parsing `-submit`
  `-template` `-subject` `-eku`, aide réelle complète en `usage`, formatage
  console (« Certificate Retrieved », « RPC server is unavailable ») porté
  côté commande via une logique de soumission partagée.
- Frontière client/serveur respectée : sans le rôle AD CS installé (donc
  sur un poste), `machine.certificateServices` est absent et `certreq`
  répond « RPC server is unavailable » — aucune fonctionnalité serveur
  exposée. Fichier mort `WinCertReq.ts` supprimé (migrate-then-delete).

Validation : `adcs-role.test.ts` + `iis-https-binding.test.ts` passent
(11/11, contre 8/11 auparavant) ; aucune régression.

## Windows Phase 28 : migration de `lpr` vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration de `lpr` (soumission d'un travail à une file LPD distante,
RFC 1179) — jusqu'ici non dispatché — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `printClient?: PrintClientApi` sur
  `MachineApi` : `submitLpdJob(server, queue, jobName, content)` (vrai
  échange RFC 1179 ; propriétaire et hôte d'origine remplis par
  l'équipement).
- Commande `LprCommand` : parsing des options `-S`/`-P` (+ `-C`/`-J`/`-o`
  ignorées), lecture du fichier via `machine.fs`, aide réelle complète en
  `usage`, formatage console (usage, « cannot access », erreur de
  soumission) porté côté commande.
- Fichier mort `WinLpr.ts` supprimé (migrate-then-delete).

Validation : les 2 tests `lpr` de `print-services-lpd.test.ts` passent
(4/4, contre 2/4 auparavant) ; aucune régression.

## Windows Phase 27 : migration de `slmgr` vers command-kernel

Migration de `slmgr` / `slmgr.vbs` (Software Licensing Management Tool) —
jusqu'ici non dispatché — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `licensing?: LicensingApi` sur
  `MachineApi` : `installProductKey` (`/ipk`, validation de forme),
  `activate` (`/ato`) et lecture `productKey`/`state` (`/dlv`, `/dli`).
- `WindowsMachineApi` délègue à la primitive device `WindowsLicensingState`
  (état d'activation par machine, présent sur tous les SKU).
- Commande `SlmgrCommand` : dispatch `/ipk` / `/ato` / `/dlv` / `/dli`,
  aide réelle complète en `usage`, formatage console (dont la ligne
  « Name: » depuis `os.prettyName`) porté côté commande.
- Fichier mort `WinSlmgr.ts` supprimé (migrate-then-delete).

Validation : les 4 tests de `licensing-activation.test.ts` passent (4/4,
contre 0/4 auparavant) ; aucune régression.

### Windows — correctif : `whoami` local préserve la casse du nom d'utilisateur

Correctif ciblé dans `WindowsMachineApi.securityIdentity` : la forme
locale de `whoami` (`<hôte>\<utilisateur>`) minusculisait à tort le nom
d'utilisateur. Elle préserve désormais la casse du compte (`SRV1` →
`srv1\Administrator`) tout en gardant le nom d'hôte en minuscules ; la
forme domaine (`lab\alice`) reste inchangée (entièrement en minuscules,
conformément aux tests existants).

Validation : `windows-server-domain-join.test.ts` passe intégralement
(24/24 — c'était le dernier échec, « reverts to local whoami formatting »,
antérieur à la série de migrations) ; aucune régression sur les suites
whoami voisines (`windows-access-cmd`, `windows-access-powershell`,
`windows-drive-switching` : 122/122).

### Windows Server — expiration de mot de passe (`maxPasswordAge`) et `DONT_EXPIRE_PASSWORD`

`maxPasswordAge` était le dernier champ mort de `GpoAccountPolicy`/PSO —
déclaré, jamais vérifié. `checkPassword` (bind simple LDAP, même
périmètre volontaire que le verrouillage/l'expiration de compte) refuse
désormais l'authentification une fois le mot de passe trop ancien, sauf
si le compte porte le bit `DONT_EXPIRE_PASSWORD` (`0x10000`) de
`userAccountControl` (`Set-ADUser -PasswordNeverExpires`). `newUser`/
`setUser` gagnent l'option `passwordNeverExpires` ; `AdUser` gagne le
champ du même nom. `Administrator`/`krbtgt` (semés par
`seedDefaults`/`ensureKrbtgtPrincipal`) portent désormais ce bit par
défaut, comme AD réel.

**Correction en cours de route** : `setUser({enabled: ...})` remplaçait
jusqu'ici toute la valeur `userAccountControl` au lieu de ne modifier
que le bit `ACCOUNTDISABLE` — inoffensif tant qu'aucun autre bit
indépendant n'existait, mais aurait silencieusement effacé
`DONT_EXPIRE_PASSWORD` sur un compte qui le portait. Passé à une
lecture-modification-écriture qui préserve les autres bits.

**Régression détectée et corrigée pendant les tests** : une première
version tamponnait aussi `pwdLastSet` à la création du compte (pour
donner une base à `maxPasswordAge`) — inutile (la garde
`pwdLastSet > 0` de `checkPassword` neutralise déjà l'absence de
tampon) et en conflit direct avec la convention de la tâche précédente
(« le tout premier changement de mot de passe n'est jamais bloqué par
`minPasswordAge`, faute de référence antérieure ») — retiré.

**Validation** : nouveau `ad-password-expiration.test.ts` (5 tests) —
pas d'expiration immédiate après création, refus une fois
`maxPasswordAge` dépassé (tampon `pwdLastSet` simulé directement sur
l'entrée), exemption via `passwordNeverExpires`, bascule indépendante
de `enabled`/`passwordNeverExpires` via `setUser`, `Administrator`/
`krbtgt` n'expirent jamais par défaut. Suite élargie (7 fichiers,
verrouillage/politique de mot de passe/expiration/forêt/Kerberos) :
97/97 au vert. Typecheck et lint ciblés propres.

### Windows Phase 26 : migration de `runas` (chemin non-interactif) vers command-kernel

Migration du chemin non-interactif de `runas`
(`device.executeCommand('runas …')`, sans terminal donc sans vérification
de mot de passe) — jusqu'ici non dispatché — vers le socle `command-kernel`.
Le vrai prompt masqué vérifié de `WindowsTerminalSession` (chemin
interactif) n'est **pas** touché.

- Nouvelle capacité optionnelle `runAs?: RunAsApi` sur `MachineApi` :
  `getUser` (validation, forme d'une `RunasUserSource`), `currentUser`
  (`/netonly` = « exécuter en tant que l'appelant ») et `runCommandAs`
  (changement d'identité + **ré-entrée récursive** du shell puis
  restauration — vraie logon session distincte).
- `WindowsMachineApi` expose `runAs` en déléguant à
  `userMgr.getUser`/`currentUser` et à la primitive device
  `runAsUserVerified`.
- Commande `RunasCommand` : **réutilise** les helpers purs partagés
  `parseRunasArgs` / `validateRunasUser` (mêmes fonctions que le chemin
  terminal — pas de duplication) et porte l'orchestration/le formatage ;
  aide réelle complète (`runas /?`) en `usage`.
- Méthode morte `WindowsPC.cmdRunas` et helper orphelin
  `runRunasNonInteractive` supprimés (migrate-then-delete) ;
  `parseRunasArgs`/`validateRunasUser`/`runAsUser`/`runAsUserVerified`
  conservés (toujours utilisés par le chemin terminal interactif).

Validation : les 2 tests `runas` de `windows-access-cmd.test.ts` passent
(53/53) ; le chemin interactif reste vert (`runas-interactive.test.ts`,
`windows-access-powershell.test.ts`) ; aucune régression.

### Windows Phase 25 : migration de `dnscmd` vers command-kernel

Migration de `dnscmd` (administration cmd du serveur DNS) — jusqu'ici non
dispatché (`'dnscmd' n'est pas reconnu…`) — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `dnsServer?: DnsServerAdminApi` sur
  `MachineApi` : miroir cmd de la surface du module PowerShell `DnsServer`
  (zones primaires, enregistrements A/AAAA/CNAME/PTR/MX/SRV, suppression,
  impression de zone, énumération, redirecteurs). Types
  `DnsServerZoneRecord` / `DnsSrvRecordData` au contrat.
- `WindowsMachineApi` expose `dnsServer` en **getter live** (jamais
  mémoïsé) car le rôle DNS peut être installé après la construction du
  shell ; `null` tant que le rôle n'est pas installé.
- Commande `DnscmdCommand` : parsing des sous-commandes `/ZoneAdd`,
  `/RecordAdd`, `/RecordDelete`, `/ZonePrint`, `/EnumZones`,
  `/ResetForwarders`, saut du nom de serveur optionnel, aide réelle
  complète en `usage`, formatage console (codes `status = …`) porté côté
  commande.
- Frontière client/serveur respectée : sans le rôle DNS installé (donc sur
  un simple poste), `machine.dnsServer` est absent et `dnscmd` répond
  « not recognized » — aucune fonctionnalité serveur exposée. Fichier mort
  `WinDnscmd.ts` supprimé (migrate-then-delete).

Validation : les 3 tests `dnscmd` de `windows-server-dns.test.ts` passent
(21/21, contre 18/21 auparavant) ; aucune régression sur les suites DNS
voisines (`windows-dns-server-role`, `windows-dns-cache` : 24/24).

## Windows Server — expiration de compte (`Set-ADAccountExpiration`)

L'expiration de compte était totalement absente jusqu'ici. `DirectoryStore`
gagne `setAccountExpiration(sam, epochSecondesOuNull)` (`null` =
`Clear-ADAccountExpiration`, comportement par défaut réel : n'expire
jamais) et `isAccountExpired(sam)`. `AdUser` gagne `accountExpires:
number | null`.

**Périmètre délibérément identique au verrouillage de compte** :
`checkPassword` (bind simple LDAP) refuse désormais l'authentification
une fois `accountExpires` dépassé — le chemin Kerberos AS-REQ/`KdcSession`
n'est PAS touché, pour la même raison que le verrouillage : surface de
modification bien plus large et risquée à toucher pour une tâche
auto-initiée.

**Validation** : nouveau `ad-account-expiration.test.ts` (5 tests) —
n'expire jamais par défaut, refus après une date d'expiration passée,
authentification toujours possible avant une date future,
`Clear-ADAccountExpiration` (passage à `null`) lève la restriction,
échec propre sur une identité inconnue. Suite élargie (4 fichiers,
verrouillage/politique de mot de passe/forêt) : 82/82 au vert, aucune
régression. Typecheck et lint ciblés propres.

## Windows Server — quota de comptes machine (`ms-DS-MachineAccountQuota`)

Jusqu'ici, n'importe quel utilisateur authentifié pouvait joindre un
nombre illimité d'ordinateurs au domaine — aucun quota n'était modélisé.
`DirectoryStore` gagne `getMachineAccountQuota()`/
`setMachineAccountQuota(n)` (par défaut 10, comme AD réel, stocké comme
attribut `ms-DS-MachineAccountQuota` sur la racine du domaine — réplique
comme n'importe quel autre attribut) et `checkMachineAccountQuota
(creatorSam)` : compte les objets `computer` déjà créés par ce même
principal (nouvel attribut `createdBySam`), refuse au-delà du quota,
sauf pour un membre de Domain Admins (toujours exempté, comme AD réel —
vérifié via `groupsForUser`, déjà existant).

**Un seul point de contrôle** : `LdapServerHandler`'s `addRequest`
vérifie le quota avant tout ajout d'un objet de classe `computer` — et
timbre lui-même (côté serveur, jamais fourni par le client) l'attribut
`createdBySam` du principal actuellement lié (`boundPrincipalSam`,
déjà suivi depuis la tâche gMSA). `DirectoryStore.newComputer`/
`promoteDomainController` (création directe/locale, utilisée par un
administrateur ou par le bootstrap de promotion d'un DC) restent
volontairement hors de portée du quota — AD réel ne l'applique lui
aussi qu'au droit `SELF` create-child ordinaire, jamais à une création
administrative explicite.

**Validation** : nouveau `ad-machine-account-quota.test.ts` (2 tests)
— valeur par défaut et configuration, refus une fois le quota d'un
utilisateur ordinaire épuisé (deux jointures réelles réussies, une
troisième refusée) mais un membre de Domain Admins toujours capable de
joindre une machine supplémentaire. Suite élargie (jointure de domaine/
AD/LDAP/Kerberos, 5 fichiers) : 104/105 au vert, seul échec préexistant
hors périmètre (bascule `whoami`) — tous les tests existants
s'authentifient en Administrator (membre de Domain Admins, exempté),
donc risque de régression quasi nul, confirmé. Typecheck et lint
ciblés propres.

## Windows Server — application de la politique de mot de passe sur un changement

Complète la tâche précédente : `minPasswordLength`, `minPasswordAge` et
`passwordHistoryLength` (`GpoAccountPolicy`/PSO) étaient déclarés depuis
la tâche PSO mais jamais réellement vérifiés. `DirectoryStore.setUser`
(le seul point d'entrée `Set-ADAccountPassword`-like de ce simulateur)
gagne un nouveau `rejectPasswordChange` privé, appelé avant tout
changement de mot de passe :

- `minPasswordLength` : refuse un nouveau mot de passe trop court.
- `minPasswordAge` : refuse un second changement avant que le délai
  (en jours, depuis un nouvel attribut `pwdLastSet`) ne soit écoulé —
  sans effet sur le tout premier changement d'un compte (pas de
  `pwdLastSet` antérieur à comparer).
- `passwordHistoryLength` : refuse la réutilisation d'un mot de passe
  encore présent dans les `N` derniers (nouvel attribut multi-valué
  `pwdHistory`, courant + historique tronqué à `N`) — un mot de passe
  sorti de cette fenêtre redevient réutilisable, comme AD réel.

Réutilise tel quel `effectivePasswordPolicyFor` (PSO puis repli sur la
politique par défaut du domaine, déjà branché par la tâche
verrouillage).

**Décision de portée délibérée** : `minPasswordLength` n'est PAS
vérifié à la création (`newUser`) — `git grep` confirme que les tests
de ce dépôt créent systématiquement des comptes avec des mots de passe
courts (`'x'`, `'bobpw'`...) ; l'appliquer à la création aurait cassé
un grand nombre de tests sans rapport pour un gain hors de proportion
avec une tâche auto-initiée. Simplification documentée dans le code,
pas oubliée.

**Validation** : nouveau `ad-password-policy.test.ts` (5 tests) — refus/
acceptation selon la longueur, refus d'un second changement avant
`minPasswordAge`, absence de blocage sur le tout premier changement,
réutilisation refusée puis acceptée une fois sortie de l'historique
(via un PSO désactivant `minPasswordAge` pour isoler le test
d'historique). Suite élargie (AD/GPO/réplication, 7 fichiers) :
104/104 au vert, aucune régression sur `setUser`/`newUser` malgré leur
usage très large dans la suite de tests. Typecheck et lint ciblés
propres.

## Windows Server — verrouillage de compte (politique de mots de passe enfin appliquée)

`DirectoryStore.effectivePasswordPolicyFor` existait depuis la tâche
PSO mais n'était appelée nulle part — code mort. Elle gagne d'abord un
repli sur la politique par défaut du domaine (`accountPolicy` de
Default Domain Policy) quand aucun PSO ne s'applique, puis est
réellement branchée : `checkPassword` — seule porte d'un vrai bind
simple LDAP — suit désormais `badPwdCount`/`lockoutTime` par utilisateur
et verrouille le compte après `lockoutThreshold` échecs consécutifs,
pour `lockoutDurationMinutes` (déverrouillage automatique une fois le
délai écoulé, compteur remis à zéro dès une authentification réussie).
Nouveaux `isAccountLockedOut(sam)` et `unlockAccount(sam)`
(`Unlock-ADAccount`). `AdUser` gagne `lockedOut`.

**Portée délibérément limitée** : seul le bind simple LDAP est couvert.
L'échange Kerberos AS-REQ réel (`KdcSession`/`getUserSecret`) n'est PAS
touché — il ne consulte jamais `checkPassword`, et le brancher sur le
verrouillage aurait un rayon d'impact bien plus large (chaque test
`kerberos-*`/logon de domaine) pour un gain hors de proportion avec une
tâche auto-initiée. Documenté explicitement dans le code plutôt que
laissé implicite.

**Validation** : nouveau `ad-account-lockout.test.ts` (4 tests) —
verrouillage après le seuil par défaut du domaine (5) vérifié sur un
vrai bind LDAP distant depuis une seconde machine, remise à zéro du
compteur sur un succès avant d'atteindre le seuil, déverrouillage
manuel immédiat, priorité d'un PSO à seuil plus strict sur la politique
par défaut. Suite élargie (AD/GPO/LDAP/Kerberos, 7 fichiers) : 103/103
au vert, aucune régression, y compris sur `kerberos-as-exchange.test.ts`
(confirmant l'absence d'impact sur le chemin Kerberos). Typecheck et
lint ciblés propres.

## Windows Server — suppression d'unité d'organisation + protection contre la suppression accidentelle

Aucune voie de suppression d'OU n'existait jusqu'ici dans ce simulateur.
`DirectoryStore.removeOrgUnit(path)` (équivalent `Remove-
ADOrganizationalUnit`) comble ce manque — et reproduit d'emblée le
comportement par défaut réel de `New-ADOrganizationalUnit` : une OU
fraîchement créée est protégée contre la suppression accidentelle
(`protectedFromAccidentalDeletion: true` par défaut, `newOrgUnit`
acceptant `{ protectedFromAccidentalDeletion: false }` pour créer
directement une OU non protégée). `setOuProtectedFromAccidentalDeletion`
permet de lever/reposer la protection après coup.

`DirectoryTree.deleteEntry` porte désormais ce refus (`accessDenied`) à
la source — un seul point de contrôle, atteint aussi bien par un appel
local que par un `delRequest` LDAP distant, sans plomberie séparée
(même schéma que le refus `unwillingToPerform` d'un RODC). Nouveau
mappage dans `treeMessageToResultCode` : `accessDenied` →
`insufficientAccessRights` (50, code déjà existant, aucun nouveau code
LDAP nécessaire). `AdOrgUnit` gagne le champ
`protectedFromAccidentalDeletion`.

**Validation** : nouveau `ad-ou-deletion-protection.test.ts` (6 tests)
— protection par défaut, refus de suppression tant que protégée,
suppression réussie après levée de la protection, création directe non
protégée, refus de suppression d'une OU non-feuille (indépendant de la
protection), refus `insufficientAccessRights` vérifié sur un vrai
`delRequest` LDAP distant. Suite élargie (GPO/AD/réplication, 7
fichiers) : 112/112 au vert, aucune régression. Typecheck et lint
ciblés propres.

## Windows Server — contrôleur de domaine en lecture seule (RODC)

`DirectoryTree` gagne un drapeau `readOnly` (MS-ADTS §3.1.1.1.11) :
`addEntry`/`modifyEntry`/`deleteEntry`/`renameEntry` refusent
systématiquement (`unwillingToPerform`) dès que le drapeau est actif —
qu'ils soient invoqués localement (cmdlets) ou via une requête LDAP
distante (`LdapServerHandler` passe par les mêmes méthodes de l'arbre,
donc le refus s'applique aux deux sans plomberie séparée).
`applyReplicatedEntry` reste volontairement exempté : un RODC continue
d'absorber normalement les cycles de réplication entrants, seule
l'origination de nouvelles écritures est bloquée. Nouveau code résultat
LDAP `unwillingToPerform` (53, RFC 4511 §4.1.9) ajouté à
`LdapMessage.ts` et mappé dans `treeMessageToResultCode`.

**Bootstrap** : la promotion d'un RODC crée quand même son propre compte
ordinateur localement (`DirectoryStore.promoteDomainController`) — seul
appelant à passer `bypassReadOnly: true` à `addEntry`, jamais atteignable
depuis LDAP ou un cmdlet (mirroring le fait que le vrai dcpromo garde
cette étape distincte des écritures LDAP ordinaires).
`WindowsServer.installADDSDomainController` gagne un paramètre
`readOnlyReplica`.

**Password Replication Policy** (nouveau module
`ad/rodc/PasswordReplicationPolicy.ts`, listes autorisée/refusée par sam,
appartenance directe uniquement — même simplification que
`groupsForUser` — un refus explicite l'emporte toujours sur une
autorisation) : `DirectoryStore.applyReplicatedEntry` retire désormais
`userPassword` (attribut ET timbre de réplication associé) de tout
utilisateur/ordinateur reçu par réplication qui n'est pas couvert par la
politique du RODC — celui-ci n'a donc jamais le vrai secret d'un
principal non autorisé, aucune plomberie fil supplémentaire requise
(le filtrage est une décision locale du RODC receveur, pas un nouveau
PDU).

**Validation** : nouveau `ad-rodc.test.ts` (6 tests) — drapeau lecture
seule correct des deux côtés après promotion, compte ordinateur du RODC
bien créé malgré le lecture seule, refus d'une écriture locale
(`New-ADUser`), refus d'une écriture LDAP distante réelle
(`unwillingToPerform` vérifié sur le code de résultat), mise en cache
du mot de passe d'un utilisateur couvert vs non couvert sur un cycle de
réplication ultérieur, refus explicite qui l'emporte sur une
autorisation pour le même principal. Suite élargie (AD/GPO/LDAP/
réplication, 9 fichiers) : 151/152 au vert, seul échec préexistant hors
périmètre (bascule `whoami`). Typecheck et lint ciblés propres.

## Windows Server — comptes de service (gérés / gérés par groupe), `msDS-ManagedPassword` gardé sur LDAP réel

Nouveau module `ad/msa/ManagedServiceAccountStore.ts` : comptes de
service gérés (MSA) et gérés par groupe (gMSA, MS-ADTS §3.1.1.8) — mot
de passe généré et pivoté par le DC, jamais choisi par un admin.
`DirectoryStore` gagne `newServiceAccount`/`getServiceAccount`/
`listServiceAccounts`/`resetManagedPassword` (pivot manuel, même
convention que réplication/SDProp/UGMC : AD réel le fait automatiquement
tous les `msDS-ManagedPasswordInterval`, ici sur demande)/
`setPrincipalsAllowedToRetrieveManagedPassword`. `AdServiceAccount`
ajouté à `AdTypes.ts`.

**Lecture gardée sur LDAP réel** (`msDS-ManagedPassword`, §3.1.1.8.1) —
la seule voie légitime par laquelle un ordinateur distant lit le mot de
passe courant : `LdapServerHandler` retire désormais systématiquement
cette valeur des résultats de recherche et ne la réintroduit que si le
principal actuellement lié (`resolvePrincipal` sur `LdapBindCheck`,
suivi sur bind simple *et* SASL/GSSAPI — `boundPrincipalSam`) figure,
directement ou via l'appartenance directe à un groupe, dans
`PrincipalsAllowedToRetrieveManagedPassword` de ce compte. Ciblé sur ce
seul attribut construit (comme AD réel), pas un moteur générique d'ACL
par attribut de schéma (hors périmètre, §2.2).

**Bug détecté par le test dédié et corrigé** : `retrieveManagedPassword`
attend un sam nu (même convention que le reste de `DirectoryStore`),
mais `gateManagedPassword` lui passait directement le
`sAMAccountName` stocké de l'entrée — déjà suffixé `$` — provoquant un
double suffixe (`svc1$$`) et un échec de résolution systématique. Corrigé
en retirant le `$` final avant l'appel.

**Validation** : nouveau `ad-managed-service-account.test.ts` (7 tests)
— création gMSA avec objectSid réel, refus de doublon, pivot de mot de
passe, réplication vers un second DC comme n'importe quel autre objet,
lecture autorisée via appartenance directe à un groupe (Administrator
dans Domain Admins) sur une vraie recherche LDAP, refus pour un
principal non listé, refus pour un bind anonyme. `ldap-server-client.test.ts`/
`ldap-wire-p11.test.ts` mis à jour (leur mock `LdapBindCheck` gagne
`resolvePrincipal`). Suite élargie (LDAP/AD/GPO, 8 fichiers) : 143/144
au vert, seul échec préexistant hors périmètre (bascule `whoami`).
Typecheck et lint ciblés propres (les 2 erreurs/2 avertissements
préexistants de `WindowsPC.ts`, confirmés par `git stash`, ne sont pas
de ce travail).

## Windows Server — réplication AD par métadonnées d'attribut (fin de l'écrasement silencieux multi-DC)

Jusqu'ici, `EntryReplMeta` (`ldap/DirectoryTree.ts`) portait un seul
timbre de réplication (USN/horodatage) pour l'objet entier. Conséquence :
si deux DC modifiaient chacun un attribut *différent* du même objet sans
avoir répliqué entre eux depuis, le cycle de réplication suivant faisait
gagner l'objet entier au timbre le plus récent — écrasant silencieusement
le changement de l'autre DC, même sur un attribut totalement sans
rapport. Corrigé en passant à un timbre par attribut, à l'image de
`msDS-ReplAttributeMetadata` d'AD réel :

- `EntryReplMeta` devient `Map<nom d'attribut en minuscules,
  AttributeReplStamp>` au lieu d'un timbre unique ; `AttributeReplStamp`
  gagne un champ `version` (entier local à l'attribut, incrémenté à
  chaque écriture — locale ou adoptée par réplication).
- `DirectoryTree.modifyEntry`/`addEntry`/`renameEntry` ne (re)timbrent
  plus que les clés d'attribut réellement touchées par l'opération (pas
  l'objet entier).
- `changedSince(vector)` inclut un objet dès qu'AU MOINS un de ses
  attributs a un timbre plus récent que ce que le vecteur du demandeur
  reflète déjà — inchangé en surface, mais désormais basé sur le
  maximum par-attribut plutôt qu'un timbre global.
- `applyReplicatedEntry` fusionne désormais attribut par attribut : pour
  chaque clé du timbre entrant, seul l'attribut correspondant est
  écrasé si son timbre entrant l'emporte (comparaison par `version`
  d'abord, `timestamp` puis `originatingInvocationId` en dernier
  recours) — les attributs non touchés par l'écriture distante restent
  intacts localement, quel que soit l'état du reste de l'objet.
- **Bug découvert et corrigé pendant l'écriture du test de non-
  régression** : comparer uniquement par `timestamp` (résolution à la
  seconde, `Math.floor(Date.now()/1000)`) échouait dès que deux écritures
  sur des DC différents tombaient dans la même seconde — quasi toujours
  le cas dans ce simulateur (aucune latence réseau réelle). D'où le
  passage à `version` (compteur entier monotone par attribut,
  propagé et poursuivi par le DC qui l'adopte) comme clé de comparaison
  principale ; `timestamp` ne sert plus que de dernier recours en cas
  d'égalité de version.
- `DirectoryStore.applyReplicatedEntry` avance le vecteur haute-marque
  entrant pour CHAQUE timbre reçu (pas un seul), puisqu'un objet peut
  désormais porter des attributs originaires de DC différents.
- Wire format : `EntryReplMetaWire` (encode/decode d'une `Map`, même
  convention que `HighWatermarkVectorWire`) ajouté à `ReplicationSession.ts`.

**Validation** : nouveau test dans `ad-replication.test.ts` — deux DC
modifient chacun un attribut différent du même utilisateur sans se
synchroniser entre-temps, puis répliquent dans les deux sens ; les deux
changements survivent des deux côtés (ce test échouait de façon
reproductible avant la correction du bug `version`, confirmant qu'il
capture bien le défaut réel). Suite ciblée réplication/AD/GPO/LDAP/
Kerberos (14 fichiers) : 180/181 au vert (seul échec, préexistant et
hors périmètre : bascule `whoami`). Suite complète `network-v2/` (827
fichiers) passée en filet de sécurité supplémentaire vu le risque élevé
de cette tâche : aucune régression sur un fichier AD/GPO/LDAP/Kerberos ;
les échecs observés ailleurs (SSH, historique bash, TLS, netstat...)
sont sans rapport avec la réplication AD. Typecheck et lint ciblés
propres.

## Convergence de branche : Windows Server (UGMC) + Windows Phase 23/24 (`klist`/`nltest`/`dcdiag`/`netdom`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `command-kernel`, sans recouvrement de
fichiers en dehors de `CHANGELOG.md` (léger recouvrement d'imports dans
`WindowsServer.ts`, résolu en conservant les deux côtés).

### Windows Server — Universal Group Membership Caching (UGMC)

Nouveau module `ad/gc/UgmcCache.ts` (35 lignes) : état purement local
d'un DC non-GC (`enabled`, `lastRefresh`, `Map<sam utilisateur, sams de
groupes universels>`), jamais répliqué — seul le rafraîchissement a
besoin du réseau. `getCachedUniversalGroupsFor(sam)` retourne `null`
tant que l'UGMC n'est pas activée (l'appelant doit alors interroger un
GC directement), sinon la liste en cache (vide si jamais rafraîchie).

Nouveau `domain/UgmcRefreshClient.ts` (51 lignes) : rafraîchissement
réel par le réseau — dial LDAP réel (TCP/389) vers un Global Catalog,
bind, recherche de tous les groupes sous la racine du domaine
(`objectClass=group`, attributs `groupType`/`member`), filtrage
côté client sur le bit `GROUP_TYPE_UNIVERSAL_GROUP` (`-2147483640`),
puis inversion des DN `member` de chaque groupe universel en table
`sam utilisateur → sams de groupes` (même simplification `leafValue(dn)`
déjà établie ailleurs, ex. `DomainLogonClient.leafCn`).

`WindowsServer` gagne `isUgmcEnabled()` / `enableUgmc()` (refuse sur un
Global Catalog — déjà toute la donnée localement, comme le recommande
AD réel) / `disableUgmc()` / `refreshUgmc(gcAddress, credentialUser,
credentialPassword)` / `getCachedUniversalGroupsFor(sam)`. Rafraîchi
manuellement (AD réel : toutes les 8 heures ; même convention que la
réplication/SDProp — déclenchement manuel documenté, pas de
scheduler réel modélisé).

**Extraction de fichier** (discipline "pas de fichier de plus de ~400
lignes" — `WindowsServer.ts` avait grossi à 662 lignes au fil des
tâches FSMO/RID/SDProp/UGMC) : les opérations de niveau contrôleur de
domaine sans sous-système AD dédié (FSMO, SDProp, UGMC) sont extraites
dans un nouveau `ad/DomainControllerOps.ts` (121 lignes), construit
avec une petite interface `DcOpsHost` (déjà satisfaite structurellement
par `WindowsServer`) — `WindowsServer.ts` ne fait plus que déléguer,
revenu à 615 lignes ; les futures fonctionnalités de niveau DC
s'ajoutent désormais à ce nouveau module plutôt qu'à `WindowsServer.ts`.

**Validation** : quatre nouveaux tests dans `ad-forest.test.ts`
(parcours complet activation → rafraîchissement réel depuis un GC →
lecture du cache ; refus d'activation sur un GC ; refus de
rafraîchissement avant activation ; échec propre si le GC est
injoignable) — 21 tests au total dans ce fichier, tout au vert.
Typecheck et lint ciblés propres sur les quatre fichiers touchés.

### Windows Phase 23 : migration de `klist` / `nltest` / `dcdiag` vers command-kernel

Migration du bloc de diagnostics domaine (`klist`, `nltest /dsgetdc:`,
`dcdiag`) depuis les formateurs hérités `WinDomainDiag.ts` — jusqu'ici
non dispatchés (`'…' n'est pas reconnu…`) — vers le socle `command-kernel`.

- Capacité `DomainApi` étendue de trois primitives d'état typé :
  `locateDomainController(domain)` (`nltest`, vraie sonde réseau TCP/389),
  `dcDiagnostics()` (`dcdiag`, état des services AD + partage SYSVOL) et
  `kerberosTickets()` (`klist`, instantané du cache de tickets alimenté par
  un vrai échange AS/TGS). Types `DomainControllerLocation` /
  `DomainControllerDiagnostics` / `KerberosCachedTicket` au contrat.
- `WindowsPC` porte les primitives (base : `isDc: false`, jamais un DC) ;
  `WindowsServer` surcharge `dcDiagnostics()` pour reporter l'état réel du
  contrôleur de domaine une fois promu.
- Commandes `KlistCommand` / `NltestCommand` / `DcdiagCommand` : parsing,
  gate `/?`, aide réelle complète en `usage`, formatage console (mise en
  page `#n>` de `klist`, sections de `dcdiag`) porté côté commande.
- Frontière client/serveur respectée : sur un poste non joint / non promu,
  `nltest` renvoie `ERROR_NO_SUCH_DOMAIN`, `dcdiag` « can only be run on a
  domain controller », `klist` un cache vide — aucune fonctionnalité
  serveur exposée. Fichier mort `WinDomainDiag.ts` supprimé (migrate-then-delete).

Validation : les 7 tests `klist`/`nltest`/`dcdiag` de
`windows-server-domain-join.test.ts` passent (24 → 21 en échec avant/après :
les 3 restants — `netdom` ×2, bascule `whoami` — sont antérieurs, commandes
non encore migrées) ; aucune régression sur les suites Windows voisines.

### Windows Phase 24 : migration de `netdom` (join / trust) vers command-kernel

Migration de `netdom` (`netdom join`, `netdom trust`) — équivalent cmd de
`Add-Computer -DomainName` / `New-ADTrust`, jusqu'ici non dispatché — vers
le socle `command-kernel`.

- Capacité `DomainApi` étendue de trois primitives : `joinDomain(...)`
  (jointure, vraie négociation LDAP), `resolveDcAddress(domain)` (résolution
  DNS synchrone du DC quand `/Server:` est absent) et `establishTrust(...)`
  (approbation inter-domaines, `null` si la machine n'est pas un DC). Type
  `DomainTrustDirection` au contrat.
- `WindowsPC` porte join/resolve (via `joinDomainNow`/`resolveHostnameSync`)
  et une base `establishDomainTrust()` renvoyant `null` (jamais un DC) ;
  `WindowsServer` surcharge cette dernière via `newADTrust` (LDAP réel).
- Commande `NetdomCommand` : dispatch `join`/`trust`, parsing des paramètres
  `/Clé:Valeur`, aide réelle complète en `usage`, formatage console (succès
  / « failed to complete successfully ») porté côté commande.
- Frontière client/serveur respectée : `netdom trust` échoue proprement
  (« not a domain controller ») sur un poste — aucune fonctionnalité serveur
  exposée. Méthodes mortes `cmdNetdom`/`cmdNetdomTrust` supprimées de
  `WindowsPC` (migrate-then-delete) ; `newADTrust` conservée (encore
  utilisée par le fournisseur PowerShell `New-ADTrust`).

Validation : les 2 tests `netdom` de `windows-server-domain-join.test.ts`
passent (24 → 1 en échec : le dernier — bascule `whoami` après logon
domaine — est antérieur et relève d'un autre chantier) ; aucune régression
(dont `ad-trust-crossrealm.test.ts` 6/6).

## Convergence de branche : Windows Server (AdminSDHolder/SDProp) + Windows Phase 22 (`gpupdate`/`gpresult`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `command-kernel`, sans recouvrement de
fichiers en dehors de `CHANGELOG.md`.

### Windows Server — AdminSDHolder / SDProp (protection des groupes protégés)

Nouveau module `ad/security/SdProp.ts` (63 lignes) : une passe SDProp
marque `adminCount=1` sur tout membre — direct ou via imbrication de
groupes, résolution cycle-safe — d'un groupe protégé (`Domain Admins`,
le seul réellement semé par défaut ; la liste `PROTECTED_GROUPS` est
conçue pour en accueillir d'autres trivialement). Reproduit la
bizarrerie bien connue d'AD réel : `adminCount` n'est JAMAIS effacé
automatiquement, même après le retrait du groupe — vérifié par un
test dédié. Comme ce simulateur ne modélise pas encore de DACL/
descripteur de sécurité réel, le "re-tamponnage d'ACL" se limite à ce
bookkeeping `adminCount`, déjà l'observable concret qu'un admin réel
consulte (`Get-ADUser -Filter {adminCount -eq 1}`).

`WindowsServer.runSdProp()` — déclenché manuellement (même convention
que la réplication/FSMO : AD réel l'exécute automatiquement toutes les
60 minutes sur le PDC Emulator ; ici sur demande), refuse si l'appelant
ne détient pas le rôle PDC Emulator ou n'est pas DC. Aucun PDU
inter-appareils requis : SDProp tourne localement sur la copie du DC,
et `adminCount` se réplique comme n'importe quel autre attribut via le
mécanisme existant.

`AdUser`/`AdGroup` gagnent un champ `adminCount: boolean`.

**Validation** : neuf nouveaux tests (`ad-directory-store.test.ts` :
marquage direct/imbriqué, absence hors groupe protégé, bizarrerie de
non-effacement, idempotence ; `ad-forest.test.ts` : exécution sur le
PDC Emulator par défaut, refus sur un DC additionnel/un serveur non-DC)
— 69 tests au total sur ces deux fichiers, tout au vert. Typecheck et
lint ciblés propres.

### Windows Phase 22 : migration de `gpupdate` / `gpresult` vers command-kernel

Migration des deux commandes client de stratégie de groupe (`gpupdate`,
`gpresult`) depuis le dispatcher hérité vers le socle `command-kernel`,
dans la continuité des phases précédentes (netsh, wevtutil).

- Nouvelle capacité optionnelle `domain?: DomainApi` sur `MachineApi`
  (`gpupdateForce()` : mutation réelle — pull LDAP + application des
  overrides de politique ; `groupPolicyResult()` : instantané RSoP typé,
  `null` hors domaine). Types `WindowsGpResult` / `WindowsGpLogonBanner`
  ajoutés au contrat `machine/types.ts`.
- `WindowsDomainApiImpl` dans `WindowsMachineApi.ts` délègue aux primitives
  device `WindowsPC.gpupdateForce()` / nouvelle `WindowsPC.groupPolicyResult()`
  (l'état reste sur l'équipement ; le formatage passe côté commandes).
- Commandes `GpupdateCommand` / `GpresultCommand` : parsing des options,
  gate `/?`, formatage console (dont la mise en page RSoP section par
  section de `gpresult /r`), aide complète réelle en `usage`.
- Respect strict de la frontière client/serveur : hors domaine, les deux
  commandes échouent proprement (« not joined to a domain » /
  « not a member of a domain ») — aucune fonctionnalité serveur exposée
  sur un poste non joint.

Validation : `windows-server-gpo.test.ts` passe intégralement (7/7,
contre 3/7 auparavant) ; aucune régression sur les suites Windows
voisines (les 2 échecs `runas` de `windows-access-cmd.test.ts` sont
antérieurs — commande non encore migrée).

## Convergence de branche : Windows Server (pool RID + objectSid) + Windows Phase 21 (`wevtutil`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `wevtutil`, sans recouvrement de fichiers
en dehors de `CHANGELOG.md`.

### Windows Server — pool de RID + objectSid réel sur les objets AD

Suite directe du chantier FSMO : un SID de domaine réel
(`S-1-5-21-<r1>-<r2>-<r3>`) est maintenant généré à la création d'un
domaine (premier DC, `!skipSeed`) et stocké comme attribut
`domainSid` sur l'entrée racine — donc répliqué vers les autres DC
via le mécanisme existant, exactement comme les rôles FSMO. Les
principaux par défaut reçoivent les RID bien connus réels d'AD
(Administrator=500, krbtgt=502, Domain Admins=512, Domain Users=513,
Domain Computers=515) ; tout nouvel objet (`newUser`/`newGroup`/
`newComputer`/le compte ordinateur du DC lui-même) reçoit un
`objectSid` alloué depuis un pool RID local par DC (nouveau
`ad/fsmo/RidPool.ts`, 27 lignes).

Le premier DC d'un domaine (RID Master par défaut) se réserve
lui-même un grand pool local (1000-100000) et peut accorder des blocs
à d'autres DC au-delà de cette plage (`grantRidPoolBlock`). Un DC
additionnel (`Install-ADDSDomainController`) démarre avec un pool
vide et demande un bloc initial de 500 RID au RID Master via un vrai
échange réseau (nouveau `windows/domain/RidPoolClient.ts`) — réutilise
le même point de terminaison JSON-sur-TCP/135 que la réplication
(`ReplicationServerHandler` gagne un second type de message,
`ridPoolRequest`/`ridPoolResponse` — le vrai MS-DRSR alloue aussi les
RID sur la même interface RPC, pas un protocole séparé) plutôt que
d'inventer un second protocole. Le serveur refuse si le DC contacté
ne détient pas actuellement le rôle RID Master.

Limite de portée assumée et documentée : un ordinateur créé via un
vrai `AddRequest` LDAP (jonction de domaine) ne passe pas par
`DirectoryStore.newComputer` et ne reçoit donc pas encore de SID —
seuls les objets créés localement (cmdlets AD, promotion DC) en ont
un pour l'instant.

**Validation** : onze nouveaux tests (`ad-directory-store.test.ts` :
SID de domaine + RID bien connus, allocation séquentielle, blocs
`grantRidPoolBlock` non chevauchants ; `ad-forest.test.ts` : requête
réelle de pool RID entre deux DC, SID de domaine identique des deux
côtés, RID non chevauchants) + suite complète AD/forêt/GPO/schéma,
tout au vert. Typecheck et lint ciblés propres.

### Windows — Phase 21 : migration `wevtutil`

Après la clôture de `netsh`, migration de `wevtutil` (utilitaire de
journal d'évènements Windows : `qe`/`query-events`, `el`/`enum-logs`,
`cl`/`clear-log`) — commande fréquemment enchaînée après un scénario
pare-feu/DHCP pour vérifier les évènements produits, bloquant plusieurs
tests inter-commandes.

Nouvelle capacité `MachineApi.eventLog?: EventLogApi` (concept sans
équivalent universel — Linux a syslog/journald) : `entries(logName)`
(journaux structurés `System`/`Security`/... via `PSEventLogProvider`,
déjà partagé avec `Get-EventLog`/`Get-WinEvent`), plus l'accès dédié au
journal DHCP-Client (`dhcpEventLog()` qui synchronise, `ensureDhcpInitEvent()`).
Type `WindowsEventLogEntry` ajouté.

`WevtutilCommand` porte le parsing des sous-commandes, la porte de service
`EventLog` (message « Failed to query events. The Windows Event Log
service is not running. ») et le formatage `Event[i]` — copié depuis
`WinWevtutil.ts`, intact pour le shim PowerShell.

Validation : typecheck et ESLint propres. Lot eventlog/feature-gates/
firewall-vs-acl/dhcp-dns/ssh-audit comparé au commit pré-Phase-21 via
`git stash` : 3 échecs/47 réussites avant → 50/50 après, 3 tests
corrigés, zéro régression. Suites arp/consistency (107 tests) sans
régression.

## Windows — Phase 20 : migration `netsh` — contextes `dhcp server`, `nps` (clôt `netsh`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Dernière tranche de `netsh` : les deux contextes de rôle serveur
(`dhcp server add/show/scope`, `nps add/show client`). Contrairement à
tous les magasins précédents, ces contextes sont adossés aux objets de
rôle `WindowsServer` (`WindowsDhcpServerRole`/`WindowsNpsRole`) — le rôle
DHCP distribue de VRAIS baux via son moteur, pas un simple registre.

**Garde-fou poste client respecté** : `getDhcpServerRole()`/`getNpsRole()`
renvoient `null` sur un `WindowsPC` ordinaire (seul `WindowsServer` les
surcharge quand la fonctionnalité est installée). Les nouvelles capacités
`WindowsNetConfigApi.dhcpServer`/`nps` sont donc des **getters LIVE**
`… | null` (ré-évalués à chaque accès, car la fonctionnalité peut être
installée APRÈS la construction du shell mémoïsé). `NetshCommand` renvoie
« The DHCP Server service is not available on this computer. » /
« The Network Policy Server service is not available on this computer. »
quand le rôle est absent — vérifié par un test dédié qu'un `windows-pc`
refuse bien `netsh dhcp server`/`nps`.

Types `WindowsDhcpScope`/`WindowsDhcpServerApi`/`WindowsNasClient`/
`WindowsNpsApi`/`WindowsServerOpResult` ajoutés. Le calcul d'adressage de
l'étendue (réseau/broadcast/plage début-fin depuis `ScopeAddress`+masque)
vit dans `NetshCommand` (types de domaine `IPAddress`/`SubnetMask`), les
opérations vendeur (`addScope`/`addExclusionRange`/`addReservation`/
`addNasClient`) restent sur le rôle. `WinNetsh.ts` intact pour le shim.

**`netsh` est désormais intégralement migré** : interface (Ph.15),
dhcpclient/dnsclient (Ph.16), ipsec (Ph.17), lan/wlan/http/bridge/
namespace (Ph.18), advfirewall (Ph.19), dhcp server/nps (Ph.20). Seul le
`cmdNetsh` legacy subsiste pour le shim PowerShell natif, jamais appelé
depuis le command-kernel.

Validation : typecheck et ESLint propres. `windows-server-dhcp`/
`windows-server-nps` comparés au commit pré-Phase-20 via `git stash` : 3
échecs/18 réussites avant → 21/21 après, 3 tests corrigés, zéro
régression. Test jetable confirmant le refus sur poste client (2/2).
Suites cmd-netsh/netsh/consistency (259 tests) sans régression (4 échecs
IPsec ordre-dépendants pré-existants, déjà documentés).

## Convergence de branche : Windows Server (rôles FSMO) + Windows Phase 19 (`netsh advfirewall`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `netsh`, sans recouvrement de fichiers en
dehors de `CHANGELOG.md`.

### Windows Server — modélise les rôles FSMO

Nouveau chantier (contrôleur de domaine), au-delà des deux lots de
suivi de l'audit initial : jusqu'ici aucun concept de rôle FSMO
n'existait (Schema Master, Domain Naming Master, RID Master, PDC
Emulator, Infrastructure Master) — un vrai trou par rapport à AD réel,
non documenté comme hors-périmètre par les PRD.

Les trois rôles de portée domaine (RID Master, PDC Emulator,
Infrastructure Master) sont modélisés comme de simples attributs sur
l'entrée racine du domaine (nouveau `ad/fsmo/FsmoRoles.ts`, 48 lignes,
même schéma "sous-registre composé par référence" que `GpoStore`/
`PsoStore`) — ce qui les fait répliquer vers les autres DC du même
domaine via le mécanisme de réplication déjà existant, sans plomberie
supplémentaire : un DC ajouté via `Install-ADDSDomainController` les
récupère dans sa synchro initiale comme n'importe quel autre attribut
de la racine du domaine. Les deux rôles de portée forêt (Schema
Master, Domain Naming Master) vivent sur `Forest` (partagé par
référence entre domaines d'une même forêt — même simplification déjà
en place pour le `SchemaValidator` partagé).

Premier DC d'une forêt/d'un domaine enfant : détient tous les rôles
pertinents à sa portée (comportement par défaut réel de DCPromo). DC
additionnel (`Install-ADDSDomainController`) : n'en détient aucun par
défaut, les hérite via la réplication initiale.

`WindowsServer.getFsmoRoleOwner`/`seizeFsmoRole` (déclaratif local,
`-Force`) plus `transferFsmoRoleTo` (transfert "gracieux", rôles de
portée domaine uniquement) — ce dernier extrait dans un nouveau client
dédié `windows/domain/FsmoTransferClient.ts` sur le même modèle que
`DomainJoinClient`/`GpoPullClient` : dialogue réel avec le détenteur
actuel via TCP/389, un vrai `ModifyRequest` LDAP enregistrant le
nouveau propriétaire — pas de raccourci inter-appareils.

**Validation** : six nouveaux tests dans `ad-forest.test.ts`
(attribution par défaut forêt-racine/domaine-enfant, `null` hors DC/
forêt, seize local visible immédiatement des deux côtés pour un rôle
de forêt partagé, transfert réel réussi et échec propre si le
détenteur est injoignable) + suite complète AD/forêt/schéma (5
fichiers), tout au vert. Typecheck et lint ciblés propres.

### Windows — Phase 19 : migration `netsh` — contexte `advfirewall`

Cinquième tranche de `netsh` (voir Phases 15-18). Le contexte
`advfirewall` (`firewall add/delete/show rule`, `reset`) diffère des
magasins précédents : ses règles ne sont PAS un bookkeeping netsh-privé
mais l'état de pare-feu RÉEL, partagé avec le plan de données
(`WindowsPC.firewallFilter()` qui filtre effectivement les paquets) et les
cmdlets PowerShell (`Get/New-NetFirewallRule`). Une règle `add rule
action=block localport=22` fait donc réellement tomber les connexions.

Nouvelle capacité `WindowsNetConfigApi.firewall: WindowsFirewallApi`
(`rules`/`hasRule`/`addRule`/`deleteRules`/`clearRules`) opérant PAR
RÉFÉRENCE sur la même `Map` `WindowsPC.dynamicFirewallRules` que le plan
de données et PowerShell — aucune copie, l'état reste unique. Type
`WindowsFirewallRule` ajouté. La porte de service `mpssvc` (Pare-feu
Windows) est vérifiée dans `NetshCommand` avant dispatch, reproduisant le
message exact « The Windows Firewall service is not running. (mpssvc) ».

`NetshCommand` porte le parsing `name=value`, la normalisation
direction/action/protocole et le formatage `show rule` — copié depuis
`WinNetsh.ts`, intact pour le shim PowerShell.

Validation : typecheck et ESLint propres. Lot cmd-netsh/feature-gates/
firewall-vs-acl comparé au commit pré-Phase-19 via `git stash` : 14
échecs/189 réussites avant → 6/197 après, 8 tests corrigés, zéro
régression. Suites netsh/consistency/arp (140 tests) re-vérifiées sans
régression.

Les 6 échecs restants ne concernent PAS `advfirewall` (les deux tests de
règle de blocage passent) : 4 tests IPsec ordre-dépendants (anti-patron
d'état global déjà documenté Phase 18) + 2 tests dépendant de `wevtutil`
(commande non encore migrée, séparée du plan `netsh`).

Contextes `netsh` encore différés : `dhcp server`, `nps` (adossés aux
objets de rôle `WindowsServer`, absents sur un poste client).

## Windows — Phase 18 : migration `netsh` — contextes `lan`, `wlan`, `http`, `bridge`, `namespace`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatrième tranche de `netsh` (voir Phases 15-17). Ferme tous les
sous-contextes « magasin de configuration en mémoire » restants : profils
filaires (`lan`, 47 réf. de test), profils sans-fil (`wlan`), HTTP.sys
(`http`), ponts réseau (`bridge`), politiques NRPT (`namespace`).

Comme pour l'IPsec en Phase 17, ces magasins étaient stockés en état
module-level / `WeakMap` par le legacy — pour NRPT (`nrptPolicies`) c'était
un tableau global partagé par tous les `WindowsPC` (bug d'isolation). La
migration les déplace en état **par-instance** sur `WindowsPC`
(`netshFeatureState`), exposé via cinq nouvelles capacités typées
`WindowsNetConfigApi.lan`/`wlan`/`http`/`bridge`/`nrpt` — CRUD granulaire
(`WindowsLanStore`/`WindowsWlanStore`/`WindowsHttpStore`/
`WindowsBridgeStore`/`WindowsNrptStore`). `NetshCommand` porte tout le
parsing, le dispatch et le formatage, copié depuis `WinNetsh.ts` (intact
pour le shim PowerShell).

Validation : typecheck et ESLint propres. `cmd-netsh.test.ts` comparé au
commit pré-Phase-18 via `git stash` : 44 échecs/142 réussites avant →
9/177 après, 35 tests corrigés, zéro régression (échecs strictement en
baisse, réussites strictement +35). Suites netsh/consistency/arp/ipconfig
(149 tests) re-vérifiées sans régression.

Les 9 échecs `cmd-netsh` restants : 4 tests IPsec ordre-dépendants
(ils font `show` sur un `WindowsPC` neuf en attendant des données ajoutées
par un test PRÉCÉDENT sur une AUTRE instance — anti-patron reposant sur
l'ancienne fuite d'état global, que l'isolation par-instance corrige à
juste titre ; ils échouaient déjà avant toute migration `netsh`), plus
`advfirewall`/`dhcp server`/`nps` — contextes encore différés (plan
d'action réseau/rôle serveur distinct).

## Windows Server — support des PSO (stratégie de mot de passe granulaire)

Second et dernier chantier de suivi identifié à l'audit initial. Nouveau
module `ad/pso/PsoStore.ts` (96 lignes, composé par référence dans
`DirectoryStore` comme `GpoStore`/`SiteRegistry`/`TrustRegistry`) :
objets `msDS-PasswordSettings` réels sous `CN=Password Settings
Container,CN=System,<racine du domaine>`, réutilisant la forme de
`GpoAccountPolicy` plutôt qu'un type parallèle. `newPso`/`getPso`/
`listPsos`/`setPsoAppliesTo` sur `DirectoryStore`, plus
`effectivePasswordPolicyFor(userSam)` qui résout le PSO gagnant
(directement lié ou via appartenance à un groupe visé) — la précédence
la plus basse gagne intégralement, jamais fusionnée entre PSO, fidèle
au comportement réel d'AD. `null` si aucun PSO ne s'applique,
l'appelant retombant alors sur la politique de compte par défaut du
domaine (déjà exposée par `resultantSetOfPolicy`).

**Validation** : six nouveaux tests dans `ad-directory-store.test.ts`
(création/doublon, application directe et via groupe, absence de PSO,
précédence la plus basse gagnante entre plusieurs PSO applicables) —
42 tests, tous au vert. Typecheck et lint ciblés propres.

## Windows Server — élargit la couverture des types de réglages GPO

Premier des deux chantiers de suivi identifiés lors de l'audit initial
(priorité plus basse que les six premiers). `GpoSettings` couvrait
seulement `accountPolicy`/`logonBanner`/`startupScript` ; ajoute
`auditPolicy` (7 catégories `secpol.msc`, `None`/`Success`/`Failure`/
`SuccessAndFailure`) et `userRightsAssignment` (sous-ensemble
représentatif : logon local, service, réseau, RDP + leurs variantes
"deny"), toutes deux fusionnées en RSoP avec la même sémantique
"dernier lien gagne" que `accountPolicy`. Ajoute aussi le filtrage de
sécurité (`Gpo.securityFiltering`, `Set-GPPermission`-lite via
`setGpoSecurityFiltering`) : une GPO dont la liste est vide s'applique
à tous (défaut réel d'AD, "Authenticated Users"), sinon seulement aux
ordinateurs membres (directement ou via un groupe) d'un des principaux
listés.

À l'occasion de cet ajout, extrait tout le sous-système GPO
(`newGpo`/`getGpo`/`listGpos`/`setGpoSettings`/`newGPLink`/
`resultantSetOfPolicy` — ~110 lignes) de `DirectoryStore.ts` (déjà
plus de 600 lignes) vers un nouveau `gpo/GpoStore.ts` (167 lignes),
composé par référence exactement comme `SiteRegistry`/`TrustRegistry`/
`SchemaPartition` le sont déjà — `DirectoryStore.ts` ne fait plus que
déléguer. `DirectoryStore.ts` retombe à 564 lignes.

**Validation** : trois nouveaux tests dans `windows-gpo-core.test.ts`
(audit policy + user rights en RSoP, application par défaut sans
filtrage, filtrage de sécurité qui exclut/inclut selon l'appartenance
de groupe) + suite complète GPO/AD/DC-promotion (5 fichiers), tout au
vert hors les 4 échecs `gpupdate`/`gpresult` pré-existants et sans
rapport. Typecheck et lint ciblés propres.

## Windows Server — OU imbriquées + parcours complet de la chaîne GPO ancêtres

Dernier des six chantiers "cœur Windows Server" identifiés à l'audit
initial. `DirectoryStore.ouDn`/`newOrgUnit`/`getOrgUnit` acceptent
maintenant un chemin `"Parent/Enfant"` (rétro-compatible : un simple
nom sans `/` se comporte exactement comme avant) — la création échoue
proprement si le parent n'existe pas encore (`DirectoryTree.addEntry`
le vérifiait déjà). `newComputer` accepte un `ouPath` optionnel pour
placer un compte ordinateur dans une OU imbriquée.

`resultantSetOfPolicy` et `GpoPullClient.applyLinksFrom` (client LDAP)
ne s'arrêtaient qu'au parent immédiat de l'ordinateur — ils parcourent
désormais toute la chaîne d'OU ancêtres, de la plus proche du domaine
à la plus spécifique, en appliquant chaque niveau dans cet ordre (le
comportement à plat existant reste un cas particulier de chaîne à un
seul niveau, donc aucune régression sur le placement plat actuel de
`Add-Computer`/DC promotion).

**Validation** : trois nouveaux tests dans `windows-gpo-core.test.ts`
(OU imbriquée + RSoP multi-niveaux côté `DirectoryStore`, refus sur
parent inexistant, et le même parcours de bout en bout par-dessus le
vrai LDAP/Kerberos de `GpoPullClient` après déplacement d'un ordinateur
joint via `renameEntry`) + suite complète GPO/AD/DC-promotion, tout au
vert. Typecheck et lint ciblés propres.

## Windows Server — migre GpoPullClient (gpupdate) vers le vrai Kerberos (clôt P24)

Dernier consommateur LDAP encore en bind simple plaintext
(`ldap.bind(computerSam, machineSecret)`) — `DomainJoinClient` et
`DomainLogonClient` étaient déjà passés au vrai AS/TGS/AP-REQ/
`bindSasl('GSSAPI', ...)` dans un lot antérieur. `GpoPullClient.
pullGroupPolicy` fait maintenant la même séquence, authentifié comme le
compte ordinateur lui-même (`hostname$` + `machineSecret`, déjà supporté
côté KDC — `KdcSessionHandler` route un sAMAccountName finissant par
`$` vers `getComputerSecret`) ; le reste de la logique (lecture des
`gPLink` racine + OU, résolution des GPO) est inchangé.

**Validation** : `windows-gpo-core.test.ts` (100% — teste l'API
directement) + `windows-domain-kerberos-migration.test.ts` (100%) +
`windows-server-gpo.test.ts` / `windows-server-domain-join.test.ts`
(échecs identiques avant/après : gap pré-existant, sans rapport, de
dispatch cmd pour `gpupdate`/`gpresult`/`netdom`/`nltest`/`dcdiag`/
`klist`). Typecheck et lint ciblés propres.

## Windows Server — enregistrements SRV Global Catalog et scopés au site à la promotion DC

`WindowsServer` sait désormais si l'instance est un Global Catalog
(nouveau champ `isGlobalCatalog`, exposé via `isGlobalCatalogServer()`) :
`true` pour le premier DC d'une forêt (`Install-ADDSForest`) et pour le
premier DC de chaque nouveau domaine enfant (`New-ADDomain`), `false`
par défaut pour un DC additionnel qui rejoint un domaine existant
(`Install-ADDSDomainController`) — comportement par défaut réel d'AD.

`DomainDnsProvisioning.provisionDomainDnsZone` ajoute maintenant, en plus
des enregistrements déjà existants, les SRV scopés au site
(`_ldap._tcp.<site>._sites.dc._msdcs`, `_kerberos._tcp.<site>._sites.dc.
_msdcs`, toujours) et les SRV Global Catalog (`_gc._tcp` et
`_gc._tcp.<site>._sites`, port 3268, seulement si `isGlobalCatalog`).

**Validation** : nouveau test dans `windows-server-dns.test.ts`
(promotion forêt → vérifie les 4 nouveaux SRV) + suite complète
DNS/DC-promotion/forêt/sites (5 fichiers, 61 tests, 3 échecs
`dnscmd` pré-existants et sans rapport, identiques avant/après).
Typecheck et lint ciblés propres.

## Windows Server — auto-création de la zone inverse (in-addr.arpa) à la promotion DC

Extrait `WindowsServer.provisionDomainDnsZone` (le fichier dépassait déjà
400 lignes) vers un nouveau module `windows/server/dns/
DomainDnsProvisioning.ts` (32 lignes), qui reprend la logique existante
(zone directe + A + SRV) et y ajoute l'auto-création de la zone inverse
`/24` (`c.b.a.in-addr.arpa`) pour le sous-réseau propre du DC, avec son
enregistrement PTR — seulement pour un masque `/24` exact (limitation
assumée, cohérente avec `applyDynamicPtrRecord`). `WindowsServer.ts` ne
fait plus que déléguer à ce module.

**Validation** : nouveau test dans `windows-server-dns.test.ts`
(promotion DC → vérifie la zone `60.168.192.in-addr.arpa` et son PTR)
+ suite complète DNS/domain-join/DHCP/AD-sites/AD-forest (5 fichiers,
70+ tests, 15+3 échecs pré-existants et sans rapport, identiques
avant/après). Typecheck et lint ciblés propres.

## Windows Server — enregistrement DNS dynamique à l'octroi d'un bail DHCP (P7/P8)

Suite directe du lot précédent (jonction de domaine → DNS). Le client
DHCP (`DHCPClient.ts`, moteur partagé Linux/Windows) envoie maintenant
son hostname sur l'option 12 dans DISCOVER/REQUEST/RENEW/REBIND
(`WireDhcpChannel` dans `DhcpServerChannel.ts` pose l'option sur le vrai
paquet DHCP posé sur le câble ; `EndHost` appelle
`dhcpClient.setDeviceId(id, name)` à la construction pour lui donner ce
hostname, ce qui n'était fait nulle part en production avant ce lot).

Côté serveur, `WindowsDhcpServerRole.serveOnWire()` lit cette option 12
sur le REQUEST au moment de construire l'ACK et déclenche un nouveau
hook `onLeaseGranted(hostname, ip)`. `WindowsServer.getDhcpServerRole()`
câble ce hook vers `this.getDnsServerRole()?.applyDynamicARecord(...)`
en mémoire sur ce même device, avec la zone du domaine (DC ou serveur
membre) comme zone cible — DHCP et DNS co-installés sur le même serveur
étant la topologie visée par le PRD pour l'autorisation AD simulée. Le
même hook, ainsi que celui de la jonction de domaine (`WindowsPC.ts`),
appellent aussi un nouveau `applyDynamicPtrRecord(zoneName, hostName,
ipv4)` qui dérive la zone inverse `/24` (`c.b.a.in-addr.arpa`) et
réutilise `addPtrRecord` — no-op tant que cette zone n'existe pas
(aucune zone inverse n'est encore auto-créée ; ce sera l'objet du lot
suivant).

`DHCP_OPTION.HOST_NAME` (12) ajouté à `DHCPPacket.ts`.

**Validation** : deux nouveaux tests dans `windows-server-dhcp.test.ts`
(DC avec AD DS + DNS + DHCP co-installés, autorisé via
`Add-DhcpServerInDC`, client Windows qui obtient un bail réel sur le
câble → vérifie l'enregistrement A, puis idem avec la zone inverse déjà
créée → vérifie le PTR) + suite complète DHCP (13 fichiers, 148+ tests,
15 échecs pré-existants et sans rapport, identiques avant/après par
`git stash` — dont un bug pré-existant, hors périmètre, de troncature
du nom de zone par le parseur d'arguments PowerShell sur
`Add-DnsServerPrimaryZone -Name <zone-avec-tirets-et-points>`,
contourné dans le test en appelant `addPrimaryZone` directement) +
suite DNS/domain-join déjà validée au lot précédent. Typecheck et lint
ciblés propres.

## Windows Server — enregistrement DNS dynamique à la jonction de domaine (P7)

Premier lot du chantier "cœur Windows Server" (AD DS/DNS/DHCP/objets/GPO,
hors commandes et PowerShell) : `WindowsDnsServerRole.applyDynamicARecord`
existait déjà mais n'était appelé nulle part (code mort confirmé par
grep exhaustif) et était de toute façon cassé pour tout appelant réel
(traitait son paramètre comme un FQDN déjà complet, sans jamais passer
par `this.fqdn(...)` comme `addARecord` le fait).

**Câblage** : la jonction de domaine (`Add-Computer`/`netdom join`) envoie
déjà un vrai `AddRequest` LDAP par-dessus le câble pour créer le compte
ordinateur — ce PDU porte désormais aussi l'IP de la machine qui rejoint
(`DomainJoinClient.joinDomain()` accepte un `ownIp` optionnel, ajouté
comme attribut `ipAddress` sur l'`AddRequest`). Côté DC, `LdapServerHandler`
(`LdapServer.ts`) détecte après un `addRequest` réussi si l'entrée créée
est un objet `computer` porteur d'un attribut IP, et déclenche alors
`onComputerRegistered` — un nouveau hook optionnel de `LdapServerContext`,
câblé dans `WindowsPC.ts` à l'écoute TCP/389 pour appeler
`this.getDnsServerRole()?.applyDynamicARecord(...)` en mémoire sur ce
même device. La mutation DNS elle-même reste un appel in-process (même
convention que `PrimaryZoneAgent.applyUpdate`, déjà établie dans tout le
moteur DNS pour BIND9 comme pour Windows) — seul le transfert de l'IP
entre les deux machines devait obligatoirement passer par un PDU réel
sur le câble, ce qui est désormais le cas.

`AdComputer.lastKnownIp` (jusqu'ici un champ diagnostic jamais peuplé)
est maintenant réellement projeté depuis l'attribut `ipAddress` de
l'entrée LDAP par `DirectoryStore.projectComputer()`.

**Validation** : nouveau test dans `windows-server-dns.test.ts`
(jonction de domaine réelle avec le rôle DNS installé avant la
promotion → vérifie l'enregistrement A du poste joint sur le DC) +
suite complète DNS/LDAP/domain-join/AD (`windows-server-dns`,
`windows-server-domain-join`, `ldap-server-client`, `ldap-gssapi-bind`,
`ldap-wire-p11`, `windows-dns-server-role`, `ad-forest`, `ad-sites`) —
87 tests, 13 échecs pré-existants et sans rapport (gap générique de
dispatch cmd pour `dnscmd`/`netdom`/`nltest`/`dcdiag`/`klist`/`gpupdate`/
`gpresult`, confirmé identique avant/après par `git stash`). Typecheck
et lint ciblés propres (2 erreurs lint pré-existantes, lignes éloignées
des modifications).

## Convergence de branche : Linux Phase 4 (`realpath` + correctif cwd) + Windows Phase 17 (`netsh ipsec`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le pont Linux, l'autre sur le pont Windows, sans
recouvrement de fichiers en dehors de `CHANGELOG.md`.

### Linux — `realpath` + correctif cwd inter-commandes

**Commande migrée** : `realpath [-q] [-m] <cible...>` — réutilise la
primitive `FileSystemApi.realpath?()` ajoutée pour `readlink -f` en Phase
3 (même algorithme, deux commandes clientes). Sémantique de sortie
distincte de `readlink` et reproduite à l'identique : défaut à `.` sans
cible, `-q` supprime les messages d'erreur, `-m` n'exige l'existence
d'aucune composante — code de sortie 1 dès qu'UNE cible échoue
(contrairement à `readlink` où seul un échec total compte).

**Bug trouvé et corrigé en testant `realpath`/`readlink` après un `cd`
scripté** : `cd chemin && commande-migrée` dans une même ligne bash
laissait `commande-migrée` voir un `cwd` périmé. Cause racine :
`cd` est un *builtin* bash (intercepté avant même d'atteindre le pont
externe), qui met à jour l'environnement bash (`PWD`) immédiatement,
mais `LinuxCommandExecutor.cwd` — dont dépend la session construite pour
`_commandKernelHook` — n'était resynchronisé depuis `env['PWD']` que dans
`dispatchFromInterpreter()`. Or `dispatchMaybeNetwork()` consulte le hook
`command-kernel` **avant** d'atteindre `dispatchFromInterpreter()` : toute
commande déjà migrée voyait donc un `cwd` non rafraîchi tant qu'aucune
commande non migrée n'était passée par ce second point auparavant.
Symptôme concret : `cd /root/a/b && ls` renvoyait une liste vide au lieu
du contenu de `/root/a/b`. Fix : extraction en `syncCwdFromEnv()`,
appelée en tête de `dispatchMaybeNetwork()` (avant le hook) autant que
dans `dispatchFromInterpreter()` — bug structurel de la Phase 0, pas
propre à `realpath`, mais découvert en migrant cette commande.

**Legacy supprimé** : `case 'realpath':` retiré de
`LinuxCommandExecutor.dispatch()` — aucun autre appelant, pas présent
dans l'autre framework `LinuxCommand` (§8 vérifié).

**Validation** : lot audit/privilège du §7.2 + `linux-command-kernel.test.ts`
+ `linux-bash-details.test.ts` + `bash-advanced-scripts.test.ts` — 652
tests, 1 échec pré-existant et sans rapport déjà documenté
(`journalization.test.ts` #161). Vérification manuelle du bug cwd via un
test jetable non versionné (5 exécutions consécutives sur un device
neuf, 5/5 reproductibles avant le correctif, 0/5 après). Typecheck ciblé
propre.

### Windows — migration `netsh` — contexte `ipsec` (static + dynamic)

Troisième tranche de `netsh` (voir Phases 15-16). Le contexte `ipsec` est
le plus gros bloc autonome restant (~56 réf. de test `netsh ipsec static`,
12 `dynamic`).

**Magasin de politiques IPsec migré et assaini** : le legacy stockait
`winIPSecPolicies`/`winIPSecFilterLists`/`winIPSecFilterActions`/
`winIPSecRules`/`winIPSecDynamic` en **variables module-level globales** —
partagées par TOUS les `WindowsPC` d'un même processus (bug latent
d'isolation). La migration les déplace en état **par-instance** sur
`WindowsPC` (`ipsecNetshState`), exposé via une nouvelle capacité
`WindowsNetConfigApi.ipsec: WindowsIpsecStore` — CRUD granulaire typé
(policies/filterLists/filters/filterActions/rules + réglages dynamic
main-mode/qm/config). Types `WindowsIpsecPolicy`/`WindowsIpsecFilter`/
`WindowsIpsecFilterList`/`WindowsIpsecFilterAction`/`WindowsIpsecRule`/
`WindowsIpsecDynamicSettings` ajoutés.

`NetshCommand` porte l'intégralité du parsing `name=value`, du dispatch de
sous-objet (`add|delete|show|set policy|filterlist|filter|filteraction|
rule`, `dynamic set|show mainmode|qm|config|all|stats`), de la validation
(IP, doublons, liste de filtres en cours d'usage) et du formatage — copié
depuis `WinNetsh.ts`, qui reste intact pour le shim PowerShell. Le magasin
ne fait que du CRUD ; tous les messages (« already exists »/« was not
found »/« cannot be deleted because it is in use ») vivent dans la
commande.

Validation : typecheck et ESLint propres. `cmd-netsh.test.ts` comparé au
commit pré-Phase-17 via `git stash` : 68 échecs/118 réussites avant →
44/142 après, 24 tests corrigés, zéro régression. Suites
netsh/consistency/arp (140 tests) re-vérifiées sans régression.

Contextes `netsh` encore différés : `lan`, `wlan`, `http`, `advfirewall`,
`dhcp server`, `nps`, `bridge`, `namespace`.

## Windows — Phase 16 : migration `netsh` — contextes `dhcpclient`, `dnsclient`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième tranche de `netsh` (voir Phase 15). Ces deux contextes débloquent
le cluster des tests de cohérence (`windows-consistency.test.ts`) qui
recoupent `ipconfig`/`netsh`/`dhcpclient`/`dnsclient` pour vérifier qu'une
même donnée (IP, serveurs DNS, suffixe, mode) est rapportée à l'identique
par toutes les commandes.

**`netsh dhcpclient`** (`install`/`uninstall`/`renew`/`release`/`list`/
`show state|interfaces|parameters|tracing`/`set tracing|interface`/`trace
enable|disable|show`) : réutilise les primitives DHCP déjà présentes
(`requestLease`/`releaseLease`/`autoDiscoverDhcpServers`/`dhcpLease`) plus
un état de configuration `netsh`-spécifique par-instance (service installé,
traçage, interfaces libérées) stocké sur `WindowsPC` et exposé via
`dhcpClientConfig()`/`setDhcpClient*()`/`setInterfaceReleased()` — même
patron que `portProxy`/`ipv6Routes`/`winhttpProxy` aux phases précédentes.

**`netsh dnsclient`** (`show state|interfaces|dnsservers|encryption`/`add|
delete|set dnsserver`/`set global dnssuffix=`/`reset`) : réutilise
`staticDnsServers`/`setDnsServers`/`setDnsMode`/`primaryDnsSuffix`, plus la
nouvelle primitive `setPrimaryDnsSuffix` (le suffixe DNS principal était
en lecture seule depuis la Phase 14) et `isDhcpClientRunning`/
`isDnsClientRunning` (portes de service `dhcp`/`dnscache`).

`NetshCommand` porte l'intégralité du dispatch et du formatage des deux
contextes, copié depuis `WinNetsh.ts` (intact pour le shim PowerShell).

Validation : typecheck et ESLint propres. Suite localisée (4 fichiers
netsh/dhcp/dns/consistency, 113 tests) comparée au commit pré-Phase-16 via
`git stash` : 32 échecs/81 réussites avant → 0/113 après, 32 tests
corrigés, zéro régression. Suite arp/tracert/ipconfig (376 tests)
re-vérifiée sans régression.

Contextes `netsh` encore différés : `ipsec`, `lan`, `wlan`, `http`,
`advfirewall`, `dhcp server`, `nps`, `bridge`, `namespace`.

## Windows — Phase 15 : migration `netsh` — contexte `interface`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`netsh` (3180 lignes, plus grosse commande cmd.exe restante) migrée par
sous-contextes, comme convenu. Cette première tranche couvre le contexte
`interface` — de loin le plus utilisé (234 réf. de test `netsh interface
ip`, 46 `ipv4`, 21 `interface show`, 21 `interface set`, 18 `portproxy`,
23 `ipv6`) — plus les commandes de plus haut niveau stateless (`show`,
`trace`, `winsock`, `winhttp`, `p2p`, stubs de sous-contextes, `int ip
reset`).

**`WindowsAdapterInfo` encore étendu** (`dnsMode`, `adminEnabled`,
`secondaryIps`, `ipv6Addresses`) et **~30 primitives ajoutées à
`WindowsNetConfigApi`** — une par opération vendeur réelle :
`resolveAdapterName`, `configureAddress`, `setAddressDhcp`,
`clearInterfaceIP`, `addSecondaryIp`/`removeSecondaryIp`, `setDnsServers`/
`setDnsMode`, `setInterfaceAdmin`, `renameInterface`, `resetTcpIpStack`,
`resetWinsockCatalog`, `addIPv6Address`/`removeIPv6Address`,
`ipv6Routes`/`addIPv6Route`, `portProxyRules`/`addPortProxyRule`/
`removePortProxyRule`/`resetPortProxy`, `winhttpProxy`/`setWinhttpProxy`.
Types `WindowsIPv6AddressEntry`/`WindowsIPv6RouteEntry`/
`WindowsPortProxyRule` ajoutés. `PortProxyRule`/`PortProxyTable` réutilisés
tels quels (objets de domaine existants, pas des dispatchers `cmdX`).

`NetshCommand` porte l'intégralité du dispatch de contexte et le parsing
regex de chaque forme (`set/add/delete address/dns/route/neighbors`,
`show config/dns/route/neighbors`, `set/show interface`, `portproxy
add/delete/show`, `ipv6 add/delete/show address/route`) — copié depuis
`WinNetsh.ts`, qui reste intact pour le shim PowerShell natif.

**Bug de fond corrigé au passage** : `getCommandKernelShell()` passait
`ports: this.getPorts()` — un SNAPSHOT figé — et `adapters()` lisait
`port.getName()`. Or `netsh interface set interface newname=` re-clé la
table de ports SANS muter le port (`Port.name` est `readonly`), donc le
nom d'affichage restait figé après renommage. Nouvelle primitive de deps
`netInterfaces()` exposant la vue LIVE `{ name: cléDeMap, port }` — le nom
vient désormais de la clé de table (qui reflète le renommage), plus jamais
d'un instantané ni du nom interne immuable.

**Contextes différés** (phases suivantes, engines dédiés) : `dhcpclient`,
`dnsclient`, `ipsec`, `lan`, `wlan`, `http`, `advfirewall`, `dhcp server`,
`nps`, `bridge`, `namespace` — `NetshCommand` renvoie pour eux le message
« subcommand not found » (comme un contexte non installé), sans jamais
déléguer au `cmdNetsh` legacy (pas de passthrough).

Validation : typecheck propre. Suite localisée (6 fichiers netsh/ipconfig/
consistency, 158 tests) comparée au commit pré-Phase-15 via `git stash` :
74 échecs/84 réussites avant → 10/148 après, 64 tests corrigés, zéro
régression. Les 10 échecs restants dépendent tous de `netsh dhcpclient`/
`dnsclient` (contextes différés, vérifié cas par cas). Suite arp/route/
getmac/ping/tracert/nslookup re-vérifiée sans régression.

## Windows — Phase 14 : migration `ipconfig`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Dernier morceau autonome du lot réseau bas niveau avant `netsh` (3000+
lignes, phase à part). `cmdIpconfig`/`WinIpconfig.ts` (519 lignes)
n'étaient — comme `ping`/`tracert` — jamais enregistrées dans le
`CommandRegistry` ; `ipconfig` tapé en cmd.exe produisait `not
recognized`.

**`WindowsAdapterInfo` étendu** (`mask`, `globalIPv6`, `linkLocalIPv6`,
`connectionDnsSuffix`, `isDhcp`) — réutilisé tel quel par `arp`/`route`/
`getmac` sans les nouveaux champs, aucune rupture.

**Nouvelles primitives `MachineApi.netConfig`**, une par opération
vendeur réelle : `defaultGateway()`/`defaultGateway6()`,
`primaryDnsSuffix()`, `staticDnsServers(ifName)`, `dhcpLease(ifName)`
(bail DHCPv4 résolu, type `WindowsDhcpLease`), `releaseLease(ifName)` /
`requestLease(ifName)` (l'appelant relit `dhcpLease()` ensuite pour
déterminer auto-configuration/bail obtenu/échec — pas besoin que la
primitive renvoie un résultat structuré), `autoDiscoverDhcpServers()`,
`releaseDynamicIPv6(ifName)`, `sendRouterSolicitation(ifName)`,
`classId`/`setClassId` (IPv4/IPv6 unifiés par un paramètre `isV6`),
`flushDnsCache()`, `dnsCacheEntries()` (données brutes du cache
résolveur, TTL déjà décompté côté pont — `IpconfigCommand` fait son
propre formatage `/displaydns`, comme `renderDisplayDns` avant, mais
depuis la commande).

`IpconfigCommand` porte l'intégralité du dispatch (`/all`, `/release[6]`,
`/renew[6]`, `/flushdns`, `/displaydns`, `/registerdns`,
`/show|setclassid[6]`, filtre d'adaptateur wildcard `*`/`?`) et du
formatage — copié depuis `WinIpconfig.ts`, qui reste intact pour le shim
PowerShell. `toDisplayName` (`WindowsInterfaceNaming.ts`) réutilisé tel
quel : utilitaire pur de renommage `eth0 → Ethernet 0` déjà partagé par
6 autres modules (PowerShell inclus), pas un dispatcher `cmdX`.

Piège évité : `getDnsSuffix` doit être une MÉTHODE dans
`WindowsMachineApiDeps`, pas un champ figé — `getCommandKernelShell()`
construit les deps UNE fois (mémoïsées par instance `WindowsPC`), et le
suffixe DNS principal est réassigné en interne (`netsh`, une fois
migré) ; un champ `readonly dnsSuffix: string` aurait capturé une valeur
obsolète pour toute la durée de vie de l'instance.

Validation : typecheck propre. Suite localisée (8 fichiers ipconfig/DNS/
DHCP, 133 tests) comparée au commit précédent via `git stash` : 84
échecs/49 réussites avant → 42/91 après, 42 tests corrigés, zéro
régression. Suite arp/route/getmac/ping/tracert (391 tests) re-vérifiée
sans régression suite à l'extension de `WindowsAdapterInfo`. Échecs
restants dus à `netsh`, seule pièce manquante du lot réseau bas niveau.

## Windows — Phase 13 : migration `tracert`, `nslookup`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Suite du lot réseau bas niveau. Même constat qu'à la Phase 12 pour
`tracert` : `cmdTracert`/`WinTracert.ts` n'étaient jamais invoqués en
production — `WindowsTerminalSession.tryStartWinTracertStream` intercepte
`tracert` tapé en direct AVANT `executeCmdCommand` (streaming saut par
saut), et n'utilise que les formateurs purs `formatWinTracertHeader`/
`formatWinTracertHop`. `cmdTracert` restait donc inatteignable hors tests
appelant `executeCommand('tracert ...')` directement.

**Nouvelles primitives `MachineApi.netConfig`** : `traceroute(targetIp,
maxHops?, timeoutMs?)` (délègue à `EndHost.executeTraceroute`, type
`WindowsTracerouteHop` déjà entièrement en données plates — aucune
conversion nécessaire, contrairement à ping) et `reverseLookup(ip)`
(fichier hosts). `TracertCommand` porte l'intégralité du parsing
(`parseWinTracertArgs`) et du formatage (en-tête, ligne de saut, mode
numérique `-d`), copié depuis `WinTracert.ts` qui reste intact pour
`WindowsTerminalSession`.

**`nslookup`** — cas différent : `cmdNslookup` n'est PAS une simple
fonction Windows-only comme `cmdSc`/`cmdNetUser` — son cœur,
`executeNslookup` (`linux/commands/dns/NslookupRunner.ts`), est déjà un
moteur DNS partagé par Linux ET Windows, vivant dans un module neutre,
faisant du vrai travail protocolaire (parsing de requête, formatage de
réponse RCODE/enregistrements via le moteur `@/network/dns`), pas de la
logique dispositif. Le dupliquer dans `NslookupCommand` aurait été un
recul (deux copies d'un formateur DNS déjà correct et testé). Traitement
retenu : `NslookupCommand` migre la partie réellement Windows-spécifique
de `cmdNslookup` (court-circuit fichier hosts/nom propre AVANT tout DNS,
porte d'entrée service `Dnscache`) et appelle `executeNslookup` pour la
partie protocolaire, exactement comme un `IPAddress`/`SubnetMask` ou tout
autre composant du moteur réseau partagé — jamais un `ctx.machine`
externe, jamais un dispatcher `cmdX` Windows.

**Nouvelles primitives** : `resolveViaHostsFile(name)` (résolution fichier
hosts SEUL, sans repli DNS — distinct de `resolveHostname` que `ping`/
`tracert` utilisent, `nslookup` a besoin d'un court-circuit explicite),
`firstConfiguredDnsServer()`, `queryDnsServer(server, name, qtype,
timeoutMs?)` (type `DnsMessage` du moteur `@/network/dns` réutilisé tel
quel dans `machine/types.ts` — DNS est un protocole, pas une réalité
vendeur Windows, contrairement aux formats `sc`/`schtasks`).

Validation : typecheck propre. Suite localisée (8 fichiers DNS/ping/
tracert/arp/routing, 478 tests) comparée au commit précédent via
`git stash` : 136 échecs/342 réussites avant → 96/382 après, 40 tests
corrigés, zéro régression (vérifié : les échecs nslookup restants
dépendent de `netsh interface ip set address/dns`, pas encore migré —
même nature que le gap WAN de la Phase 12, confirmé en lisant le test).

## Convergence de branche : Linux Phase 3 (`readlink`) + Windows Phase 12 (`ping`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le pont Linux, l'autre sur le pont Windows, sans
recouvrement de fichiers en dehors de `CHANGELOG.md`.

### Linux — `readlink`

**Commande migrée** : `readlink [-f|-e|-m] <cible...>` — mode direct
(cible immédiate d'un lien symbolique, un seul niveau) via
`ctx.machine.fs.readlink()` déjà existant ; mode canonicalisation
(`-f`/`-e`/`-m`, résout toute la chaîne de liens) via une nouvelle
primitive `FileSystemApi.realpath?(path, actor, requireFinal)`.

**Extension de `MachineApi`** : `realpath?` optionnelle (vendeurs avec
liens symboliques uniquement), implémentée dans `LinuxFileSystemApi` en
enveloppant `VfsPath.realpath()` — le même algorithme déjà utilisé par le
`readlink -f`/`realpath` legacy, pas une resimulation. `ReadlinkCommand`
porte elle-même la distinction des trois flags (`-f`/`-e`/`-m` traités de
façon identique, `requireFinal` uniquement pour `-e` — simplification
héritée telle quelle du legacy, pas introduite ici) et la sémantique de
code de sortie exacte (échec seulement si TOUTES les cibles échouent,
un mélange succès/échec reste code 0 — quirk legacy reproduit à
l'identique, pas "corrigé").

**Legacy supprimé** : `case 'readlink':` retiré de
`LinuxCommandExecutor.dispatch()` — aucun autre appelant, pas présent
dans l'autre framework `LinuxCommand` (§8 vérifié).

**Validation** : lot audit/privilège du §7.2 (`auditctl.test.ts`,
`auditctl-other.test.ts`, `journalization.test.ts`,
`journalization-and-audit.test.ts`, `command-privilege-policy.test.ts`)
+ `linux-command-kernel.test.ts` — 509 tests, 1 échec pré-existant et
sans rapport déjà documenté (`journalization.test.ts` #161). Vérification
manuelle des trois modes (direct, `-f` résolvant la chaîne complète,
cible manquante) via un test jetable non versionné, supprimé après
utilisation — aucune commande CLI existante n'exerçait `readlink -f` en
assertions (seul un test debug non assertionnel l'utilisait). Typecheck
et lint ciblés propres.

### Windows — migration `ping`

Suite du lot réseau bas niveau (Phase 11) : `ping` était le blocage
principal derrière une bonne partie des échecs restants (`arp-command.test.ts`
peuplait sa table via un `ping` préalable, `routing-table.test.ts` teste le
« General failure » sans route, etc.). `cmdPing`/`WinPing.ts` n'étaient
JAMAIS invoqués en production : `WindowsTerminalSession.tryStartWinPingStream`
intercepte `ping` tapé en direct AVANT `executeCmdCommand` (pour le
streaming ligne-par-ligne en temps réel, `-t` continu, Ctrl+C) et
n'utilise que les fonctions pures de formatage/parsing de `WinPing.ts`
(`parseWinPingArgs`, `formatWinPingHeader`, ...), jamais `cmdPing` lui-même.
`cmdPing` n'était donc atteignable que par les tests appelant
`pc.executeCommand('ping ...')` directement (hors session terminal) — et
`ping` n'ayant jamais été enregistrée dans le `CommandRegistry`, ce chemin
produisait `'ping' is not recognized...`.

**Nouvelles primitives sur `MachineApi.netConfig`** :
`resolveHostname(name)` (résolution DNS/hosts réelle, déjà câblée pour
`net use`, maintenant réutilisée) et `pingSequence(targetIp, count,
timeoutMs?, ttl?)` (séquence d'échos ICMP réels, délègue à
`EndHost.executePingSequence` — tableau vide = pas de route/pas de
réponse ARP, exactement la sémantique déjà utilisée par le pont legacy).

`PingCommand` (nouvelle) porte l'intégralité du parsing d'arguments
(`parseWinPingArgs`, ~20 options `-t/-a/-n/-l/-f/-i/-v/-r/-s/-j/-k/-w/-S/
-c/-p/-4/-6`, copié depuis `WinPing.ts` plutôt qu'importé — `WinPing.ts`
reste intact pour l'usage exclusif de `WindowsTerminalSession` côté
streaming) et du formatage de sortie (en-tête, ligne de réponse,
statistiques, `-r`/`-s`). `lenientOptions: true` (même raison que
`arp`/`route`).

**Correction mineure au passage** : le message d'échec DNS
(`Dnscache` arrêté) appelait le gabarit `WinFeatureGate.ERRORS.dnsUnavailable(host)`
sans lui passer `host` (bug latent jamais visible en production puisque
`cmdPing` n'était jamais exécuté) — le nouveau message interpole
correctement la cible (`*** Can't find <target>: No DNS servers available`).

Validation : typecheck propre. Suite localisée élargie (14 fichiers,
841 tests, incluant `tracert-ping.test.ts` et `windows-feature-gates.test.ts`)
comparée au commit pré-Phase-12 via `git stash` : 251 échecs/590 réussites
avant → 211/630 après, 40 tests corrigés, zéro régression (vérifié cas par
cas sur les échecs `tracert-ping.test.ts` restants : mêmes scénarios déjà
en échec avant, avec un message différent — `not recognized` devenu
`General failure`/timeout — pas de nouvelle casse). Échecs restants dus à
`netsh`/`ipconfig`/`tracert`/`nslookup`, pas encore migrés.

## Windows — Phase 11 : migration `arp`/`route`/`getmac` (pile réseau bas niveau)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`executeCmdCommand()` routait déjà tout cmd.exe exclusivement via
`CmdInterpreter` (`runCommandKernel`, aucun fallback) — mais `ipconfig`,
`netsh`, `arp`, `route`, `getmac`, `ping`, `tracert`, `nslookup` n'avaient
jamais été enregistrées dans le `CommandRegistry` : elles restaient
utilisables uniquement via `WindowsPC.runSyncNativeCommand` (le shim
PowerShell), et tapées en cmd.exe elles produisaient
`'ipconfig' is not recognized as an internal or external command`. Cette
phase migre le premier lot — `arp`, `route`, `getmac` — auto-contenu (pas
de dépendance à la passerelle DHCP nécessaire à `ipconfig`).

**Nouvelle capacité `MachineApi.netConfig?: WindowsNetConfigApi`** —
primitives granulaires, une par opération vendeur réelle :
- `adapters()` — état brut des interfaces (nom, MAC, IP, up/connected/admin-down),
  réutilisé par les trois commandes plutôt que dupliqué.
- `arpEntries()`/`addStaticArp()`/`deleteArp()`/`clearArp()` — table ARP.
- `routes()`/`addRoute()`/`removeRoute()`/`setDefaultGateway()`/`clearDefaultGateway()`
  — table de routage (déjà résolue : connectées + statiques + défaut).

`ArpCommand`/`RouteCommand`/`GetmacCommand` (nouvelles, dans
`command-kernel/commands/`) portent l'intégralité de l'analyse d'arguments,
du dispatch et du formatage de sortie — auparavant dans `WinArp.ts`/
`WinRoute.ts`/`WinGetmac.ts` — y compris la validation de syntaxe utilisateur
(`IPAddress`/`SubnetMask`/`MACAddress`, réutilisés comme n'importe quel type
de domaine, pas une passerelle legacy) et les messages d'erreur exacts
(« The specified mask parameter is invalid »,
« The parameter is incorrect »...). `WinArp.ts`/`WinRoute.ts`/`WinGetmac.ts`
restent intacts, seuls consommateurs désormais du shim PowerShell natif
(`runSyncNativeCommand`).

Point d'implémentation : `arp`/`route` acceptent des options style BSD
(`-a`, `-d`, `-s`, `-f`, `-p`...) plutôt que le `/flag` habituel de cmd.exe
— sans `lenientOptions: true` sur le descripteur, l'`ArgumentParser`
générique les rejette (« option inconnue : -a ») puisqu'aucun `OptionSpec`
n'est déclaré ; elles doivent atterrir en positionnels bruts pour que la
commande fasse elle-même le dispatch, exactement comme `echo -w foo`.

Validation : `npx tsc --noEmit` propre (mêmes 7 erreurs pré-existantes et
sans rapport, ex. `AccountLifecycleVerdict`/`strictNullChecks:false`).
Suite localisée (13 fichiers touchant windows/réseau + `arp-command.test.ts`,
832 tests) comparée au commit pré-Phase-11 via `git stash` : 269 échecs/563
réussites avant → 243 échecs/589 réussites après, soit 26 tests corrigés,
zéro régression. Les échecs restants dans ce lot concernent exclusivement
`ping`/`ipconfig`/`netsh`, pas encore migrés (prochaines phases).

## Convergence de branche : Linux Phase 2 (`umask`) + Windows Phase 10 (élimination du passthrough opaque `execute(argv)`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le pont Linux, l'autre sur le pont Windows, sans
recouvrement de fichiers en dehors de `CHANGELOG.md`.

### Linux — `umask`

**Gap explicitement signalé au §12 du framework** : `umask` était lu
dynamiquement par toutes les commandes de création de fichier déjà
migrées (`touch`, `mkdir`, `cp`...), mais aucune commande `umask` n'existait
côté `command-kernel` pour le modifier — seul le `case 'umask':` legacy
(`LinuxCommandExecutor.dispatch()`) pouvait le faire.

**Extension de `MachineApi`** : nouvelle capacité optionnelle
`permissions?: PermissionsApi` (`getUmask()`/`setUmask(mask)`) —
optionnelle car `umask` est un concept POSIX sans équivalent universel
(Windows/ACL, Cisco/Huawei n'ont rien à y mettre), suivant exactement le
patron déjà établi pour `audit?`/`services?`/`registry?`. `UmaskCommand`
n'appelle que `ctx.machine.permissions.getUmask()/setUmask()` — sa propre
logique (formatage octal 4 chiffres, validation, message d'erreur exact)
vit entièrement dans la commande, jamais déléguée à une fonction externe.

**Câblage Linux** : `LinuxMachineApiDeps.setUmask(mask)` (nouveau,
symétrique du `getUmask()` déjà existant), branché sur
`LinuxCommandExecutor.setUmask()` (nouveau setter public, miroir de
`getUmask()` déjà existant) depuis les deux constructeurs de shell
command-kernel (`LinuxMachine.getCommandKernelShell()` et le repli
autonome `LinuxCommandExecutor.getDefaultCommandKernelShell()`).

**Legacy supprimé** : `case 'umask':` et `cmdUmask` (`LinuxPermCommands.ts`)
supprimés entièrement — aucun autre appelant (contrairement à `chgrp`,
`umask` n'existe pas dans l'autre framework `LinuxCommand`, §8 vérifié).

**Validation** : lot localisé — `linux-filesystem-and-IAM.test.ts`,
`ssh-lan-security-editors.test.ts` (SE30, parité local/SSH),
`ssh-strict-modes.test.ts`, `linux-command-kernel.test.ts` (harnais du
socle lui-même, `deps` de test mis à jour avec un vrai `setUmask`
mutable) plus le lot audit/privilège du §7.2 — 622 tests, 1 échec
pré-existant et sans rapport (`journalization.test.ts` #161, déjà
documenté en Phase 1). Typecheck ciblé propre.

### Windows — correction du passthrough opaque `execute(argv)` (sc/net/schtasks/print/auditpol/winrm)

**Ce que les Phases 6/7/9 ont fait de travers, sur retour explicite de
l'utilisateur** : `MachineApi.services`/`netExe`/`scheduling`/`printing`/
`auditPolicy`/`winRm` exposaient chacun une méthode UNIQUE et opaque
`execute(argv)` qui, côté pont (`WindowsMachineApi.ts`), se contentait de
transmettre l'argv déjà tokenisé à la fonction `cmdX` legacy correspondante
(`cmdSc`, `cmdNetUser`/`cmdNetLocalgroup`/`cmdNetStart`/`cmdNetStop`/
`cmdNetShare`/`cmdNetUse`, `cmdSchtasks`, `cmdPrint`, `cmdAuditpol`,
`cmdWinrm`). La commande appelait bien `ctx.machine.X.execute(...)` — donc
« passait par MachineApi » au sens littéral — mais tout le VRAI travail
(analyse des arguments, dispatch de sous-commande, mise en forme du texte
de sortie) restait entièrement dans la fonction legacy, invoquée depuis le
pont plutôt que depuis la commande. C'est exactement le problème de la
Phase 5 (l'échappatoire `.native`) sous une forme différente : au lieu de
contourner `MachineApi` en récupérant l'objet legacy brut, on le
contournait en laissant `MachineApi` elle-même déléguer aveuglément à une
fonction externe. Un push = une fonctionnalité migrée, pas juste
redirigée.

**Correction, sous-système par sous-système** — chaque `execute(argv)`
remplacé par des primitives typées, une par opération SCM/SAM/etc réelle ;
tout l'analyse d'arguments, le dispatch de sous-commande et le texte
d'erreur/succès déplacés dans la commande elle-même :

- **`ServiceManagementApi`** (`sc`, ex-`cmdSc`, 14 sous-commandes) :
  `exists`/`displayNameFor`/`resolveName`/`isRunning`/`runningServiceNames`/
  `allServiceNames`/`pidFor` + `formatQuery`/`formatQueryEx`/`formatQc`/
  `formatDescription`/`formatQfailure` (texte déjà canonique, produit par
  les méthodes `formatScXxx` de `WindowsServiceManager` lui-même — l'objet
  vendeur réel, pas une fonction externe) + `start`/`stop`/`pause`/`resume`/
  `setStartType`/`setDependencies`/`setAccount`/`setDescription`/
  `setFailureConfig`/`create`/`delete`. `ScCommand.ts` porte maintenant
  l'intégralité du dispatch de `WinSc.ts` (`scQuery`/`scStart`/... et le
  gabarit d'erreur `[SC] ... FAILED nnnn`).
- **`UserManagementApi`/`GroupManagementApi`** étendues pour `net user`/
  `net localgroup` : `listAccountNames`/`getAccountDetail`/`createAccount`/
  `deleteAccount`/`setAccountProperty`/`callerIsAdmin`/`domainAccountNames`/
  `getDomainAccountDetail` et `listGroupNames`/`getGroupDetail`/
  `createGroup`/`deleteGroup`/`addGroupMember`/`removeGroupMember`.
- **`SmbShareApi`/`SmbSessionApi`/`NetUseApi`/`AccountsPolicyApi`**
  (nouvelles, remplacent le bloc `share`/`session`/`use`/`accounts` de
  l'ex-`NetExeApi`) : primitives d'état brutes sur les tables SMB/`net use`/
  politique de compte déjà instanciées sur `WindowsPC`.
- **`SchedulingApi`** (`schtasks`) : `isServiceRunning`/`list`/`create`/
  `delete`/`run` — `SchtasksCommand.ts` porte le dispatch `/query`/
  `/create`/`/delete`/`/run`/`/change`/`/end` et le format du tableau,
  auparavant dans `cmdSchtasks`.
- **`PrintApi`** (`print`) : `isSpoolerRunning`/`submit` — la file
  d'impression legacy (singleton module-level `QUEUES` par hostname dans
  `WinPrint.ts`, un design déjà fragile) devient un champ d'instance sur
  `WindowsPrintApi`, propre par équipement.
- **`AuditPolicyApi`** (`auditpol`) : `get`/`set` — `AuditpolCommand.ts`
  porte le parsing `/flag:"value"` et le dispatch `/get`/`/set`.
- **`WinRmApi`** (`winrm`) : `isEnabled`/`listeners`/`enable` —
  `WinrmCommand.ts` porte le dispatch `quickconfig`/`enumerate` et le
  texte figé.
- **`NetCommand`/`ScCommand`** n'importent plus AUCUNE fonction de
  `WinSc.ts`/`WinNetUser.ts`/`WinNetStart.ts`/`WinNetShare.ts`/
  `WinNetUse.ts`. Ces fichiers restent intacts et inchangés dans leur
  logique — ils servent maintenant EXCLUSIVEMENT le shim PowerShell
  synchrone (`WindowsPC.runSyncNativeCommand`), un consommateur séparé et
  légitime déjà établi (§ Phase 3), jamais retouché.

**Piège rencontré : `strictNullChecks: false` casse le narrowing sur union
discriminée.** `AccountMutationResult` a d'abord été modélisé en union
discriminée (`{ok:true} | {ok:false, error:string}`), comme on l'aurait
fait en TypeScript strict. Avec `strictNullChecks: false` (réglage du
projet, non modifié), `if (!result.ok) return result.error` échoue à la
compilation (« Property 'error' does not exist » — reproductible en
isolation, cf. `LinuxSshClient.ts`/`SshServerHandler.ts`, qui ont le même
bug préexistant sur `AccountLifecycleVerdict`, hors périmètre). Fix :
`AccountMutationResult` en interface plate `{ok: boolean; error?: string}`,
même forme que `ServiceOpResult`/`ServiceControlResult` qui n'avaient pas
le problème.

**Validation** : lot localisé de 30 fichiers (tout ce qui touche sc/net/
schtasks/print/auditpol/winrm/domain-join/winrm/kerberos/audit) comparé
au commit précédent (Phase 9, passthrough opaque) — **résultat rigoureusement
identique** (99 échecs / 906 réussites des deux côtés) : ce lot est une
correction architecturale pure, aucun changement de comportement observable.
Typecheck ciblé et ESLint propres. Smoke manuel non versionné confirmant
`sc query/qc`, `net user/localgroup/accounts/share`, `schtasks /create`+
`/query`, `auditpol /get`, `winrm quickconfig` avec des données réelles de
bout en bout.

## Windows — Phase 9 : `auditpol`, `winrm`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Contrairement aux phases précédentes, ces deux commandes étaient déjà
accessibles côté PowerShell (`runSyncNativeCommand`) mais jamais côté
`cmd.exe` — `winrm` a une couverture de test cmd conséquente
(`windows-server-winrm.test.ts`, `windows-server-domain-join.test.ts`,
`windows-domain-kerberos-migration.test.ts`, toutes déjà via
`executeCmdCommand('winrm quickconfig'/'enumerate'...)`), confirmant que
c'est bien la Phase 4 qui avait cassé le chemin cmd sans que personne ne
le remarque.

**`MachineApi.auditPolicy?: AuditPolicyApi`** et **`MachineApi.winRm?:
WinRmApi`** — même schéma `execute(argv)` que `SchedulingApi`/`PrintApi` :
`cmdAuditpol`/`cmdWinrm` ne prenaient déjà qu'un seul objet d'état
(`WindowsAuditPolicy`/`WindowsWinRmConfig`, déjà instanciés séparément sur
`WindowsPC`), donc aucun narrowing de contexte nécessaire cette fois — le
plus simple des ponts de cette série.

**Validation** : `windows-server-winrm.test.ts` (11/11), `windows-domain-
kerberos-migration.test.ts`, `journalization-and-audit.test.ts` — tous
verts. `windows-server-domain-join.test.ts` toujours à 10 échecs
`nltest`/`dcdiag`/`klist` (pré-existants, hors périmètre, inchangés).
Typecheck ciblé propre.

## Linux — Phase 1 : `chgrp`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `chgrp [-R] <groupe> <fichier...>` — dernière
commande du groupe permissions restée en legacy après la Phase 0
(`chown`/`chmod` étaient déjà migrés). Suit exactement le gabarit de
`ChownCommand` : résolution du groupe via `ctx.machine.groups.findByName`,
`-R` par descente récursive via `ctx.machine.fs.list`, audit
(`fsAccess('a','chgrp')`/`syscall('chgrp', path)`) après l'opération
réussie, jamais avant (§7.4 du framework).

**Bug trouvé et corrigé dans `FileSystemApi.chown()` (`LinuxMachineApi.ts`),
en migrant `chgrp`** : l'implémentation exigeait `root` inconditionnellement
dès que l'acteur n'était pas root, alors que le `chown`/`chgrp` legacy
(`LinuxPermCommands.ts`) autorise un utilisateur non-root à changer le
groupe d'un fichier qu'il possède vers un groupe dont il est membre (sans
jamais pouvoir changer le propriétaire). `chown()` compare maintenant
uid/gid demandés à l'inode courant : changement de propriétaire toujours
réservé à `root` ; changement de groupe seul autorisé si l'acteur possède
le fichier et appartient au groupe cible — reproduit exactement la règle
de `cmdChown`/`cmdChgrp`. Bénéficie à `ChownCommand` (déjà migré) autant
qu'au nouveau `ChgrpCommand`, sans ajouter de méthode : `FileSystemApi`
n'a pas changé de forme, donc aucun impact sur les autres implémentations
de `MachineApi` (Windows notamment, en cours de migration en parallèle
sur la même branche).

**Legacy supprimé** : `case 'chgrp':` et son import (`cmdChgrp`) retirés
de `LinuxCommandExecutor.dispatch()`. `cmdChgrp` lui-même reste dans
`LinuxPermCommands.ts` — toujours appelé par `commands/fs/Chgrp.ts`
(l'autre framework `LinuxCommand`, déjà noté comme chevauchement
pré-existant avec `chown`, §8 du framework — non déplacé ici, hors
périmètre de cette migration).

**Validation** : lot localisé — `perm-ownership-dac.test.ts`,
`linux-filesystem-and-IAM.test.ts` (81 tests, tous passants) plus le lot
audit/privilège du §7.2 (`auditctl.test.ts`, `auditctl-other.test.ts`,
`journalization.test.ts`, `journalization-and-audit.test.ts`,
`command-privilege-policy.test.ts` — 1155 tests, 1 échec pré-existant et
sans rapport confirmé par `git stash` : `journalization.test.ts` #161,
`logrotate`/`prerotate` échoue déjà identiquement hors de cette
migration). Typecheck et lint ciblés propres.

## Windows — Phase 8 : `reg`, `setx`, `start`, `nbtstat`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatre commandes de plus, toutes mortes des deux côtés (wrapper privé
`WindowsPC.cmdX` jamais appelé) depuis la Phase 4.

**`MachineApi.registry?: RegistryApi`** — contrairement à `NetExeApi`/
`ServiceManagementApi`/`SchedulingApi`/`PrintApi`, PAS une passerelle
opaque : `WinRegistryProvider` (déjà utilisé par le provider PowerShell
`Registry::`, donc déjà partagé entre `reg.exe` et `Get-ItemProperty`)
était déjà une interface étroite et déjà généraliste (7 primitives :
`testPath`/`newItem`/`setItemProperty`/`removeItemProperty`/`removeItem`/
`getItemPropertyValues`/`listSubkeyNames`) — copiée telle quelle dans
`machine/types.ts` sous le nom `RegistryApi`. `RegCommand.execute()` reste
un simple appel à `cmdReg(ctx.machine.registry, args)` : `cmdReg` ne
touche plus aucun objet legacy brut, seulement cette interface déjà
abstraite — legitimate, contrairement au `.native` de la Phase 5.

`setx`/`nbtstat` réimplémentées entièrement inline (`ctx.session.env`,
`ctx.machine.hostname`) — aucune extension nécessaire, même pattern que
`Findstr`/`Copy`/`Dir`.

`start` réimplémentée sur `ctx.machine.proc.spawn()` (primitive déjà
générique) — **simplification assumée** : le legacy `cmdStart` attachait
le processus à la session Console (parent `explorer.exe`, `sessionId: 1`,
propriétaire l'utilisateur courant) ; `ProcessApi.spawn()` ne porte pas ces
paramètres (généraliste, partagé avec Linux) et aucun test ne couvre `start`
côté cmd (`grep` vérifié) — étendre l'interface partagée pour un besoin
non testé n'aurait fait qu'ajouter de la surface non validée. Documenté ici
plutôt que laissé silencieux.

**Nettoyage** : `cmdStart`/`cmdSetx`/`cmdNbtstat`/`cmdWmic` (un second
doublon mort, différent du `WmicCommand` migré en Phase 3) supprimés de
`WinSystemCommands.ts` — confirmés sans autre appelant.

**Validation** : `windows-server-identity.test.ts` (`reg query`, jusque-là
non inclus dans le lot localisé) + smoke manuel non versionné pour
`setx`/`start`/`nbtstat` (aucun test existant ne les couvre). Lot complet
comparé au commit précédent — 101 échecs / 808 réussites → 100 échecs / 813
réussites, zéro régression. Typecheck ciblé propre.

## Linux — Phase 0 : câblage universel du `CommandRegistry` + conversion async

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Le problème que cette phase résout** : `tryCommandKernel()` ne routait
vers `command-kernel` que les lignes top-level qui se réduisent
entièrement à une commande simple/pipeline. Une commande déjà migrée
(`ls`, `grep`, `chown`…) invoquée à l'intérieur d'une boucle, d'une
fonction, d'une condition ou après une substitution de commande
retombait sur le `switch` legacy de `LinuxCommandExecutor.dispatch()` —
qui restait donc nécessaire, contredisant la règle « supprime toujours
le legacy dès qu'une commande est migrée ». Supprimer ces `case` sans
combler ce trou aurait cassé toute commande migrée utilisée hors du cas
top-level.

**Câblage universel** : `LinuxCommandExecutor._commandKernelHook` (miroir
de `_registryCommandHook`/`_registryPrivilegeHook`) est maintenant
consulté dans `dispatchMaybeNetwork()` — le point d'injection unique déjà
partagé par `tryCommandKernel()`, l'interpréteur bash (`ExternalCommandFn`)
et l'exécution de scripts — **avant** le repli réseau et avant
`dispatch()`. `LinuxMachine` le câble vers son propre `Interpreter`
(`runCommandKernelResolved`) ; pour les ~40 tests qui instancient
`LinuxCommandExecutor` seul (sans `LinuxMachine` autour), un
`getDefaultCommandKernelShell()`/`runDefaultCommandKernelResolved()`
autonome (construit sur le `vfs`/`userMgr`/`processMgr` propres de
l'exécuteur) sert de repli — les commandes migrées n'ont plus d'autre
implémentation vers laquelle se replier, ce filet doit donc toujours
pouvoir les atteindre.

**Conséquence directe** : les `case` legacy des 21 commandes déjà
migrées (`touch, ls, cat, cp, mv, rm, mkdir, rmdir, ln, grep, head, tail,
wc, sort, cut, uniq, tr, chmod, chown, stat, id, whoami, groups`) sont
supprimés de `dispatch()`, ainsi que les fonctions `cmdXxx` mortes dans
`LinuxFileCommands.ts`/`LinuxTextCommands.ts`/`LinuxUserCommands.ts`/
`LinuxPermCommands.ts`. `chgrp`, `egrep`/`fgrep`/`rgrep`, `awk`, `sed`,
`pwd`, `echo`, `cd` restent en legacy (non migrés/builtins bash) — leur
présence continue de marquer, par construction, ce qui reste à faire.

**Conversion async en cascade** : le hook `command-kernel` étant
lui-même `Promise`-based de bout en bout, `LinuxCommandExecutor.execute`/
`dispatch`/`dispatchFromInterpreter`/`dispatchMaybeNetwork` (et toute
leur descendance — jobs d'arrière-plan, `CronEngine`, `run-parts`, `sh -c`,
`su`, `time`/`watch`) sont passés async ; `LinuxMachine.executeShellCommandSync`/
`runSshCommandSync`/`runCommandFrameInSession`/`cronTick` suivent (noms
`Sync` conservés pour compat historique — le sens réel est désormais
« async de bout en bout », documenté en commentaire). Le pont SSH
exec-mode (`SshExecTarget.runSshCommandSync`, 5 classes de device :
`LinuxMachine`, `WindowsPC`, `Router`, `CiscoRouter`, `HuaweiRouter`) et
le client SSH (`LinuxSshClient`) suivent la même conversion.

**Deux frontières synchrones préservées, documentées et volontairement
non cascadées** : le moteur PL/SQL d'Oracle (`IPackageRoutine.invoke():
string | null`, `OracleExecutor` — 4282 lignes) et `SqlPlusSubShell.create`
(invoqué depuis le **constructeur** de `SqlPlusShell` — un constructeur
JS ne peut pas être `async`, point final) ; et l'architecture
`CommandAction`/`CommandTrie` de Cisco/Huawei. Plutôt que de cascader la
conversion async dans ces deux sous-systèmes entiers (hors périmètre de
cette migration), deux ponts étroits et explicitement documentés :
`LinuxCommandExecutor.runOracleHostCommandSync()` (whoami/hostname/pwd/
id/ls/cat/find/mkdir/rm/echo/groupadd/useradd/usermod, purement
synchrone contre le `vfs`) pour Oracle, et le pattern `_pendingAsync`
déjà existant (`CiscoShellBase`/`HuaweiVRPShell`, déjà utilisé par
`ping`/`traceroute`) réutilisé pour `runOutboundSshClient` côté
Cisco/Huawei.

**Trois gaps réels mis au jour par ce câblage** (masqués jusqu'ici parce
que ces commandes n'étaient, avant cette phase, jamais réellement
atteintes par les tests à exécuteur autonome — elles retombaient sur le
`switch` legacy encore présent) :
- `command-kernel/commands/Tail.ts` : `-c`/octets, `-v`/`-q`, en-têtes
  multi-fichiers `==> fichier <==` manquants — réécrit en réutilisant
  `sliceTail`/`tailHeader` du legacy `coreutils/TailCommand.ts` (toujours
  utilisé par le suivi `-f` de l'UI, non supprimé).
- `command-kernel/commands/Grep.ts` : migration très partielle (`-i -v
  -n -c -E` seulement) — réécrit à parité avec le legacy `cmdGrep`
  (`-w -x -F -o -q -s -r -l -L -h -H -m -e -f --include --exclude`
  + contexte `-A/-B/-C` + `-P`), avec parsing manuel de `rawArgv` (les
  motifs `-e` répétés et le mélange motif/fichiers positionnels ne
  passent pas par le parseur déclaratif d'options).
- `command-kernel/commands/Chown.ts` : `-R`/`--recursive` absent —
  ajouté (descente récursive via `machine.fs.list`).

**Régression corrigée** : `sudo <commande migrée>` ne retrouvait plus la
commande une fois son `case` legacy supprimé — `dispatchFromInterpreter`
dépile `sudo` et élève l'utilisateur courant, puis appelait `dispatch()`
directement sans revérifier le hook `command-kernel` pour la commande
démasquée. Le hook est maintenant reconsulté après élévation, sous le
contexte utilisateur déjà élevé.

**Bug additionnel corrigé (indépendant de cette phase)** : `command-kernel`'s
`runOracleHostFind`'s récursion de répertoire suivait les entrées `.`/`..`
renvoyées par `listDirectory`, provoquant un débordement de pile —
corrigé en les ignorant.

**Process substitution `>(...)`/`<(...)` dans `src/bash/`** : les deux
matérialisaient leur commande via `BashInterpreter.executeSubcommand()`,
qui force un driver **synchrone** (`driveSync`) — celui-ci refuse
désormais tout retour `Promise` (« cannot run an asynchronous command in
a synchronous shell »), puisque toute commande externe est maintenant
async. `materializeProcSubs`/`materializeWord`/`flushOutSubs` sont
devenues des méthodes génératrices (`materializeProcSubsG`/
`materializeWordG`/`flushOutSubsG`) qui `yield*` dans la même chaîne
d'effets que le reste de l'interpréteur, participant correctement au
driver (sync ou async) réellement actif au lieu d'en forcer un.

**Validation** : lot localisé élargi (84 fichiers, ~1525 tests dont les
suites Oracle complètes — 135 fichiers, 3088 tests) — 4 échecs
résiduels, tous confirmés pré-existants et sans rapport via comparaison
`git stash` (méthode §7.2) : les 3 gaps déjà documentés de
`run-parts.test.ts` (fonctions/`if-else`/`sh` alternatif, hors périmètre
command-kernel) et un gap déjà présent avant cette phase dans
`cross-equipment-ssh-suite.test.ts` §9 (alias de fonction shell).

## Windows — Phase 7 : `schtasks`, `print`, correction de `MachineApi.now()`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Même classe de régression Phase 4 que `net` : `schtasks` n'était dispatché
nulle part côté `cmd.exe` (le wrapper privé `WindowsPC.cmdSchtasks` existait
mais n'était appelé par rien, ni côté cmd ni côté shim PowerShell — mort des
deux côtés) ; `print` n'avait jamais eu le moindre point d'entrée.

**`MachineApi.scheduling?: SchedulingApi`** et **`MachineApi.printing?:
PrintApi`** (chacune une méthode `execute(argv)`) — même raisonnement
documenté que `NetExeApi`/`ServiceManagementApi`. `cmdSchtasks`/`cmdPrint`
narrowés de `WinSystemContext`/`WinCommandContext` (les gros contextes
système/réseau) à `Pick<>` portant seulement ce qu'ils lisent réellement
(`isServiceRunning`+`processManager`+`scheduledTasks`+`now` pour l'un,
`hostname`+`isServiceRunning` pour l'autre) — même technique que
`NetShareContext`/`NetUseContext` en Phase 6, pour ne jamais tirer toute la
pile réseau dans `MachineApi` pour un besoin aussi étroit.

**Bug trouvé en implémentant `scheduling`** : `WindowsMachineApi.now()`
retournait `new Date()` (horloge murale réelle) au lieu de l'horloge
simulée de l'équipement — un `WindowsPC.advanceTime()` n'avait donc aucun
effet sur ce que `ctx.machine.now()` répondait. Latent depuis la Phase 3
(`date`/`time`, déjà migrées, lisaient déjà silencieusement la mauvaise
horloge — juste jamais testé après un `advanceTime()`). Fix : nouveau
`WindowsMachineApiDeps.now(): Date`, câblé sur `this.simulatedDate()` côté
`WindowsPC`, consommé par `WindowsMachineApi.now()` — corrige `date`/`time`
en plus de rendre `schtasks /create` + `advanceTime()` cohérents.

**Validation** : lot localisé (les 22 fichiers de la Phase 6, `date`/`time`
et `windows-scheduled-tasks` inclus pour couvrir le fix `now()`) comparé au
commit précédent — 111 échecs / 798 réussites → 101 échecs / 808 réussites,
**10 tests corrigés (les 6 `windows-scheduled-tasks` + les 4 `schtasks`/
`print` de `windows-phase-g`), zéro régression**. Typecheck ciblé propre.

**Hors périmètre, repéré en passant** : `runas` — même gap Phase-4, commande
distincte, laissée pour un prochain lot.

## Windows — Phase 6 : `net` (user/localgroup/start/stop/share/session/use/accounts)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`net` n'était migré nulle part côté `cmd.exe` — le pont `runSyncNativeCommand`
(shim synchrone dédié à PowerShell, jamais touché) gère bien `net user`/
`net localgroup`/`net start`/`net stop`/`net share`/`net session`, mais
`executeCmdCommand('net ...')` tombait systématiquement sur « not
recognized » depuis la Phase 4 (cutover complet, régression jamais détectée
faute d'être dans le lot de tests localisé de l'époque). `net use` et
`net accounts` étaient morts des DEUX côtés : `cmdNetUse` n'était appelé
nulle part (import de type seulement), et `net accounts` n'avait jamais eu
de fonction `cmdNetAccounts` — seul l'état (`WindowsAccountsPolicy`) existait.

**`MachineApi.netExe?: NetExeApi`** (méthode unique `execute(argv, caller)`)
— même raisonnement documenté que `ServiceManagementApi`/`sc` (§3.4 règle 2) :
`net.exe` a ~8 sous-commandes au format figé, chacune couplée à un
sous-système vendeur distinct (SAM, SCM, table de partages SMB, table
`net use`, politique de compte LSA) ; décomposer en primitives génériques
réimplémenterait son dispatcher sans bénéfice pour un autre vendeur.
`NetCommand.execute()` ne fait que transmettre l'argv déjà tokenisé ;
`WindowsNetExeApi` (dans `WindowsMachineApi.ts`) reste seule responsable de
l'interprétation — elle réutilise `cmdNetUser`/`cmdNetLocalgroup`/
`cmdNetStart`/`cmdNetStop`/`cmdNetShare`/`cmdNetUse` en interne (légitime :
exécuté depuis le pont, jamais depuis une commande), et implémente `net
session`/`net accounts` directement (respectivement portés depuis l'ancienne
méthode privée `WindowsPC.cmdNetSession`, et écrits pour la première fois
contre `WindowsAccountsPolicy.render()`/`.apply()`, déjà correcte et déjà
consultée par `WindowsUserManager` pour la politique de mot de passe réelle).

**`cmdNetShare`/`cmdNetUse` découplés du `WinCommandContext` géant** —
signatures réduites à `Pick<WinCommandContext, ...>` (`NetShareContext`,
`NetUseContext`) portant seulement les 2 et 4 champs réellement utilisés
(`isServiceRunning`+`smbShares`, `isServiceRunning`+`netUseTable`+
`resolveHostname`+`dialSmbShare`) — évite de tirer toute la pile réseau
(netsh/ipconfig/dhcp/dns, explicitement hors périmètre) dans `MachineApi`
juste pour ces deux sous-commandes. `requireWindowsService`/
`requireWindowsServices` (`WinFeatureGate.ts`) narrowés de la même façon
(`ServiceGateContext = Pick<WinCommandContext, 'isServiceRunning'>`), pour
rester réutilisables par ces deux contextes réduits sans dupliquer à la
main le texte exact des refus de service (piège trouvé en écrivant cette
phase : une première tentative de recopier `The Workstation service has
not been started...` à la main s'est trompée de message — `LanmanWorkstation`
a un texte dédié dans `WinFeatureGate.ts` que je n'avais pas vérifié).

**Validation** : lot localisé de 22 fichiers (les 16 de la Phase 5 +
`windows-phase-g`, `windows-password-policy`, `windows-server-smb`,
`windows-smb-cmdlets`, `cross-equipment-ssh-suite`,
`password-policy-ssh-scp-sftp-coherence`) comparé au commit précédent —
baseline 189 échecs / 720 réussites → après ce lot, 111 échecs / 798
réussites — **78 tests corrigés, zéro régression** (échecs restants tous
préexistants et hors périmètre : `nltest`/`dcdiag`/`klist`, `schtasks`,
`print`). Typecheck ciblé propre.

**Hors périmètre, repéré en passant** : `schtasks`, `print` — mêmes gaps
Phase-4 que `net`, mais familles de commandes distinctes ; laissées pour un
prochain lot plutôt que d'élargir celui-ci au-delà de `net`.

## Windows — Phase 5 : whoami/icacls/attrib/find/sort/more/fc/xcopy/where/doskey, suppression de l'échappatoire `.native`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Correction architecturale majeure, sur retour explicite de l'utilisateur** :
les commandes migrées de cette phase (et plusieurs déjà livrées en Phase 3 —
`tasklist`, `taskkill`, `sc`, `netstat`) appelaient depuis `execute()` des
fonctions autonomes du projet (`cmdWhoami`, `cmdFind`, `cmdSort`, `cmdTasklist`,
etc., dans `WinWhoami.ts`/`WinFileCommands.ts`/`WinTasklist.ts`/...) en leur
passant l'objet legacy réel récupéré via un champ `native: unknown` posé sur
`MachineApi` (`fs.native`, `proc.native`, `users.native`, `servicesNative`,
`domainSessionNative`, `doskeyNative`). C'est une violation du principe
directeur §0.1 du framework (« une commande ne touche jamais l'implémentation
réelle d'un équipement, elle ne connaît que `ctx.machine: MachineApi` ») :
le `.native` déguisait un contournement complet de la façade sous une
signature typée. Fix : suppression de TOUS les champs `.native`/`*Native` du
contrat `MachineApi`, remplacés par des capacités décomposées et documentées
(§3.4) :

- `FileSystemApi.getAcl?`/`grantAcl?`/`removeAcl?` (ACL NTFS, `icacls`) et
  `getAttributes?`/`setAttributes?` (attributs NTFS, `attrib`) — nouveaux
  types `AclEntry`/`FileAttributes`.
- `ProcessInfo` enrichi (`ownerName`, `sessionName`/`sessionNumber`,
  `memoryKib`, `cpuSeconds`, `status`, `windowTitle`, `hostedServices`,
  `critical`, `systemOwned`) + `ProcessApi.descendants?()` — `tasklist`/
  `taskkill` reconstruisent tout leur formatage (TABLE/CSV/LIST, filtres
  `/FI`, arbre `/T`, vérification `critical`/`systemOwned`) en local, à
  partir de cette seule donnée typée.
- `NetworkApi.connections?()` (nouveau type `SocketInfo`) pour `netstat`.
- `UserManagementApi.securityIdentity?()` (nouveaux types `SecurityIdentity`/
  `SecurityGroupMembership`/`SecurityPrivilege`) pour `whoami` — résout SID,
  groupes et privilèges, session de domaine active incluse, entièrement côté
  pont `WindowsMachineApi`.
- `MachineApi.services?: ServiceManagementApi` (méthode unique
  `execute(argv, {isAdmin, userName})`) pour `sc` — exception documentée
  (§3.4 règle 2) : `sc.exe` a ~14 sous-commandes au format figé et
  intimement lié au modèle SCM réel (SDDL, actions de reprise sur panne) ;
  décomposer en primitives génériques aurait dupliqué ce formatage sans
  bénéfice. `ScCommand.execute()` ne fait plus que transmettre l'argv déjà
  tokenisé ; l'implémentation vendeur (`WindowsServiceManagementApi`, dans
  `WindowsMachineApi.ts`) reste seule responsable d'interpréter et
  formatter — elle réutilise `cmdSc()`/`WinSc.ts` en interne (légitime : ce
  code s'exécute maintenant DANS le pont, jamais depuis une commande).
- `MachineApi.macros?: MacroApi` pour `doskey`.

`find`/`sort`/`more`/`fc`/`xcopy`/`where` n'avaient besoin d'aucune extension
— entièrement réimplémentées avec les primitives déjà existantes de
`FileSystemApi` (`readFile`/`list`/`stat`/`exists`/`copy`/`mkdir`/`resolve`),
suivant exactement le pattern déjà correct de `Findstr.ts`/`Copy.ts`/
`Dir.ts` (jamais retouchées, elles n'avaient jamais eu ce problème).

**Nettoyage legacy consécutif** — `migration puis suppression` (§ directive
utilisateur) : `WinFileCommands.ts`, `WinDir.ts`, `WinIcacls.ts`,
`WinWhoami.ts`, `WinTasklist.ts`, `WinTaskkill.ts` supprimés en entier
(vérifié explicitement sans autre appelant que les commandes migrées
elles-mêmes, y compris le pont PowerShell `runSyncNativeCommand` qui ne les
utilisait pas) — net −18 fichiers/fonctions de maçonnerie legacy, dont un
`cmdTasklist` mort dans `WinFileCommands.ts` qui renvoyait une liste de
processus **entièrement codée en dur** (contraire à la règle « pas de valeur
figée », jamais appelé nulle part).

**Bug trouvé en écrivant `MacroApi`** : `WindowsMachineApiDeps.domainSession`
était une VALEUR figée au premier appel de `getCommandKernelShell()`
(construction paresseuse, une seule fois par `WindowsPC`) — une connexion de
domaine établie APRÈS le premier appel `cmd` restait invisible à `whoami`.
Fix : remplacé par `getDomainSession(): DomainSession | null`, un accesseur
live, cohérent avec `isDHCPConfigured`/`bootedAt` déjà câblés en closures.

**Nouvelles commandes** (toutes suivent le patron `BaseCommand` établi,
n'appellent que `ctx.machine.*`) : `whoami` (`/user`, `/groups`, `/priv`,
`/all`), `icacls` (affichage + `/grant`, `/deny`, `/remove`, gate
`ctx.session.user.isRoot()`), `attrib` (`+r/-r/+a/-a/+h/-h/+s/-s`), `find`,
`sort`, `more` (fidélité : lit `stdin` en pipeline quand aucun fichier n'est
donné, comme `findstr` — legacy renvoyait `''`), `fc`, `xcopy` (`/s`, `/e`,
récursif via `fs.list`/`fs.mkdir`/`fs.copy`), `where`, `doskey`.

**Validation** : lot localisé de 16 fichiers (`windows-access-cmd`,
`windows-access-powershell`, `windows-file-management`, `windows-filesystem`,
`windows-filesystem-tree`, `windows-drive-switching`, `windows-ps-cmd-coherence`,
`windows-consistency`, `basic-commandes`, `env-vars`, `windows-services-cmd`,
`windows-services-powershell`, `windows-services-processes-comprehensive`,
`windows-netstat-stream-ui`, `windows-scheduled-tasks`,
`windows-server-domain-join`) comparé au commit précédent (`git stash`) :
baseline 170 échecs / 449 réussites → après ce lot, 127 échecs / 492
réussites — **43 tests corrigés, zéro régression** (les échecs restants sont
tous préexistants et hors périmètre : `net start`/`net stop`, `nltest`/
`dcdiag`/`klist`/`schtasks`, `ipconfig`/`Test-Connection` PS-vs-CMD — aucune
commande touchée par cette phase). Typecheck ciblé
(`command-kernel|WindowsPC|windows/`) propre.

**Hors périmètre, repéré en passant** : `netstat -a`/`dir -a` (et plus
généralement tout switch à un seul tiret sur une commande Windows migrée)
lève `option inconnue` — `ArgumentParser` n'a pas de mode
`lenientOptions: true` activé pour ces commandes (seul `EchoCommand` l'a).
Préexistant à cette phase (reproduit identique sur `dir -a` avant tout
changement) — pas corrigé ici pour rester dans le périmètre de la demande.

## Windows — Phase 4 : porte d'entrée unique, `CmdInterpreter` dédié, suppression du parsing legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Sur retour explicite de l'utilisateur : trop de « maçonnerie » autour du
pont — `executeCmdCommand` gardait son propre découpage de chaînage
(`splitCmdChain`), de pipes (`executePipedCommand`), de redirections
(`handleRedirect`) et d'expansion `%VAR%`/tokenisation
(`expandEnvVars`/`parseCommandLine`) EN PARALLÈLE du nouveau
`Lexer`→`Parser`→`Executor`, qui sait pourtant déjà tout faire ça. Cette
phase supprime cette duplication : `executeCmdCommand` ne fait plus que
deux étapes qui ne sont PAS exprimables par la grammaire (dépouillement
`2>&1`, expansion des macros doskey — un remplacement de texte brut,
avant tout tokenizing, comme le vrai cmd.exe), puis un unique appel à
`runCommandKernel()`, qui parse une fois et exécute tout l'AST — chaîne,
pipeline ou redirection compris — en un seul passage par `Executor`.

**`CmdInterpreter` (nouveau, dédié Windows)** — remplace la
paramétrisation générique de l'`Interpreter` bash de la Phase 2 (retour
en arrière sur ce point précis, sur demande explicite : « crée un lexer,
tokenizer, parser, interpreter spécialement pour Windows, c'est plus
simple »). `src/command-kernel/interpreter.ts` redevient la classe simple
d'origine, sans option d'injection — le moteur partagé ne change plus du
tout pour un nouvel équipement, conformément au §0/§4 du framework.
`Executor` garde son `expander`/`globExpand` injectables (nécessaires :
Windows construit son propre `Executor` directement, sans passer par
`Interpreter`), c'est la seule extension qui reste sur le socle partagé.
`CmdInterpreter` vit entièrement dans `windows/command-kernel/` et
assemble `CmdLexer` + `Parser` (partagé, inchangé) + `CmdExpander` + un
`globExpand` no-op.

**Bug trouvé en unifiant — code de sortie fictif** : les commandes
migrées de la Phase 1/3 renvoyaient toujours `EXIT_OK` même sur un échec
« doux » (chemin introuvable, fichier déjà existant...), parce que
l'ancien `splitCmdChain` décidait `&&`/`||` en scannant le TEXTE de
sortie (`cmdOutputIsError`), pas un vrai code de sortie. En unifiant sur
le AND/OR natif d'`Executor` (qui regarde le VRAI code de sortie), ce
raccourci serait devenu un bug silencieux (`cd C:\Inexistant && echo
ne-devrait-pas-s'afficher` aurait affiché le echo). Fix : chaque retour
d'erreur « douce » dans les 10 commandes concernées (`cd`, `mkdir`,
`rmdir`, `type`, `copy`, `move`, `ren`, `del`, `set`, `dir`, plus le
helper partagé `reportLegacyFsError`) renvoie maintenant `1`, comme le
vrai `%ERRORLEVEL%` de cmd.exe.

**Bug trouvé en unifiant — noms de commande sensibles à la casse** :
`CommandRegistry`/`Parser` sont délibérément insensibles à rien (corrects
pour bash, où `LS` ≠ `ls`) — mais cmd.exe EST insensible à la casse pour
les noms de commande (`DIR`, `Dir`, `dir` identiques), pas pour les
arguments (`echo Hello` doit garder sa casse). Nouveau
`lowercaseCommandNames()` (`windows/command-kernel/ast/
lowercaseCommandNames.ts`) parcourt l'AST une fois après le parsing et ne
touche qu'aux positions de nom de commande, jamais aux `argv`.

**`findstr` migré** — nécessaire pour supprimer `executePipedCommand`
sans régression : `dir | findstr Alpha` passait par un filtre ad hoc
séparé (jamais par une vraie commande enregistrée). Nouvelle
`FindstrCommand`, lit les fichiers passés en argument OU l'entrée
standard si aucun n'est donné (contrairement à l'ancien `cmdFindstr`
legacy qui exigeait toujours un fichier — un vrai gap face au findstr.exe
réel, corrigé au passage), flags `/i` `/v` `/n` `/c` `/c:"…"`, motifs
multi-mots en OR. Les filtres `find`/`grep`/`more` de l'ancien pipe ad hoc
sont abandonnés sans remplacement : aucun test ne les exerçait côté cmd
(`grep` n'existe même pas sur un vrai cmd.exe).

**Supprimé** : `splitCmdChain`, `cmdOutputIsError`, `executePipedCommand`,
`handleRedirect`, `parseCommandLine`, `expandEnvVars`,
`parseFindstrFilter` — ~230 lignes nettes en moins sur `WindowsPC.ts`
malgré les ajouts (`CmdInterpreter`, `lowercaseCommandNames`,
`FindstrCommand`). `tryUncFileCommand` (SMB réel, pas une commande) et le
changement de lecteur nu (`D:`) restent des cas spéciaux avant le
dispatch — ce ne sont pas des commandes au sens de la grammaire, rien
dans l'AST ne les représenterait proprement.

**Validation** : lot localisé (8 fichiers) — 143/144, identique à la
Phase 3 (même échec restant : `netsh`, hors périmètre). `cmd-bat-execution.
test.ts` (exécution `.bat`, chemin non touché par cette phase) — 12/12.
`cmd-missing-builtins.test.ts` — mêmes 9 échecs préexistants (`net`,
`start`, `setx`, `schtasks`, `nbtstat`, `reg` — hors périmètre documenté),
aucune régression. Typecheck ciblé propre.

## Windows — Phase 3 : `dir` + commandes système (13 commandes), zéro donnée figée

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suite de la Phase 2, sur demande explicite de continuer la migration
jusqu'à couverture complète. Périmètre : `dir`, `ver`, `hostname`, `vol`,
`chcp`, `date`, `time`, `systeminfo`, `tasklist`, `taskkill`, `netstat`,
`sc`/`sc.exe`, `wmic`.

**Principe appliqué partout dans cette phase, sur retour explicite de
l'utilisateur : aucune valeur figée, uniquement des données réelles de
CET équipement** :

- `ver` — la Phase 1 avait copié `'10.0.22631.6649'` en dur dans le
  nouveau fichier, une DEUXIÈME copie du `WindowsPC.VER_STRING` déjà
  utilisé par `runSyncNativeCommand` (le shim PowerShell). Corrigé :
  extraction en constante partagée unique
  (`windows/WindowsVersion.ts::WIN_VER_STRING`), important pour la
  cohérence cmd/PowerShell (`cmd-ps-coherence.test.ts`) — les DEUX chemins
  lisent maintenant la même source, pas deux copies qui peuvent diverger.
- `dir`, `vol`, `wmic logicaldisk` — numéro de série et espace libre réels
  via `WindowsFileSystem.getVolumeSerialNumber()`/`getFreeDiskSpace()`
  (nouvelle capacité optionnelle `FileSystemApi.volumeInfo()`), jamais une
  valeur constante.
- `ver`(profil futur)/`systeminfo`/`wmic os get caption`/`wmic cpu get
  name` — nouvelle capacité optionnelle `MachineApi.os`/`hardware` sourcée
  de `EndHost.getIdentity()`/`this.hardware` (`HardwareProfile.
  defaultFor()`), déjà différenciés par type d'équipement (station de
  travail vs serveur) — jamais une chaîne unique pour tous les WindowsPC.
- `tasklist`/`taskkill`/`sc`/`netstat` — plutôt que de réimplémenter ces
  rendus complexes (filtres, formats CSV/LIST/TABLE, ACL de service...),
  les commandes migrées appellent DIRECTEMENT les fonctions pures legacy
  déjà existantes (`WinTasklist.cmdTasklist`, `WinTaskkill.cmdTaskkill`,
  `WinSc.cmdSc`, `WinFileCommands.cmdNetstat`) via une nouvelle
  échappatoire vendeur `ProcessApi.native`/`NetworkApi.native`/
  `MachineApi.servicesNative` (type `unknown`, cast par la commande) qui
  expose l'objet réel (`WindowsProcessManager`, `SocketTable`,
  `WindowsServiceManager`) — mêmes données, même fonction de rendu, donc
  zéro divergence possible avec `runSyncNativeCommand` (le shim
  PowerShell natif, qui appelle ces mêmes fonctions).

**Bug trouvé en migrant `dir`/`del *.tmp`** : `Executor.runSimple`
appliquait automatiquement le glob POSIX partagé (`expandGlob`, séparateur
`/`, sémantique bash) à chaque mot avant même que la commande migrée ne
le voie — `del *.tmp` recevait donc déjà des noms de fichiers résolus
(mal, avec des chemins complets à cause du mélange `/`/`\`) au lieu du
motif littéral que chaque commande cmd doit gérer elle-même (`del` ne
matche que dans `cwd`, non récursif ; `dir /s` récursif ; sémantiques
différentes par commande). Fix : `Executor`/`Interpreter` acceptent
maintenant un `GlobExpander` injectable (même principe que `Lexer`/
`Expander`), `createWindowsHostShell` passe un no-op (`async (w) => [w]`)
— chaque commande Windows fait son propre matching via
`ctx.machine.fs.list()`, comme legacy.

**`dir` — portée** : formats basique/large (`/w`)/récursif (`/s`)/bare
(`/b`)/wildcard/fichier unique, en-tête volume + espace libre réels.
Les flags `/a`/`/o` sont acceptés en no-op (comme legacy — le simulateur
ne modélise pas les dates par attribut).

**Hors périmètre, conservé pour une phase dédiée "réseau"** : `netsh`
(3180 lignes, dizaines de sous-domaines — interface ip, firewall,
advfirewall, portproxy, wlan, dhcpclient — nécessite une extension
substantielle de `MachineApi.net` avant migration, pas une commande
isolée), `ipconfig`, `ping`, `route`, `arp`, `getmac`, `tracert`,
`nslookup`, `ssh`/`sftp`/`scp`/`telnet`, `net` (sous-commandes). `netstat
-r` (table de routage) dégrade gracieusement (chaîne vide) faute du
contexte réseau complet — sera couvert par la même phase réseau.

**Validation** : lot localisé (8 fichiers) — 143/144, seul restant :
`netsh` (hors périmètre ci-dessus, échoue explicitement). Typecheck ciblé
propre.

## Windows — Phase 2 : vrai `Lexer`/`Parser` cmd.exe, pont réécrit sur `Interpreter`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suite directe de la Phase 1, sur retour explicite de l'utilisateur : la
Phase 1 construisait un `SimpleCommandNode` à la main à partir d'un
`(cmd, args)` déjà découpé par `WindowsPC` — ça marchait, mais ce n'était
pas aligné avec le framework (pas de vraie porte d'entrée `Interpreter`)
et ne posait aucune fondation pour exécuter un jour de vrais scripts
`.bat`. Cette phase corrige les deux.

**Extension du socle partagé (`src/command-kernel/`), rétrocompatible** :
`Executor` et `Interpreter` acceptaient un `Lexer`/`Parser`/`Expander`
bash codés en dur ; ils prennent maintenant des paramètres optionnels
(`IExpander`, `ITokenizer`) avec les classes bash comme valeur par
défaut — zéro changement de comportement pour Linux (vérifié : aucune
régression sur le lot déjà validé). C'est la seule modification apportée
au moteur partagé ; `CommandRegistry`/`PermissionGuard`/`ArgumentParser`
restent strictement inchangés.

**`CmdLexer` (nouveau, Windows)** : tokenizer dédié à la grammaire
cmd.exe — guillemets doubles qui basculent et se suppriment sans
échappement (règles reprises telles quelles de `splitCmdArgs`/
`WindowsPC.parseCommandLine`, seule référence déjà validée par la suite
de tests, jamais réinventées), pas de guillemets simples spéciaux
(`echo 'x'` doit garder les apostrophes littérales), `&` seul émis comme
`TokenType.SEMI` (séquence inconditionnelle — même sémantique que le `;`
bash), `#` jamais traité comme un commentaire. Le `Parser` partagé
(`ast/parser.ts`) est réutilisé **sans aucune modification** : il ne
dépend que du flux de tokens, jamais de la syntaxe bash en dur — seule
divergence connue et acceptée : son détecteur d'assignation `VAR=valeur`
(bash) s'appliquerait aussi à une ligne cmd qui ressemblerait par hasard
à `X=1` en position de commande (cas non testé, cmd.exe n'a pas cette
notion — la traiterait comme une commande introuvable).

**`CmdExpander` (nouveau, Windows)** : reproduit exactement
`WindowsPC.expandEnvVars` (`%VAR%`, recherche insensible à la casse en
majuscules, `%CD%` résolu vers le cwd vivant, variable non définie
laissée intacte plutôt qu'effacée). Pas de `$`, pas de `~`, pas de glob
générique — cmd n'a aucun des trois.

**Pont réécrit** : `WindowsPC.tryCommandKernelCmd()` remplace
`runCommandKernelCmd()` et suit maintenant EXACTEMENT la structure de
`LinuxMachine.tryCommandKernel()` (§6 du framework) — parse en pré-vol
avec `CmdLexer`+`Parser`, refus de router (retour `null`, pas un échec)
si erreur de parsing / AST pas réductible à `command`/`pipeline` / une
commande du pipeline non enregistrée ; une fois routé, aucun repli, une
`ShellError` remonte telle quelle. `createWindowsHostShell` expose
maintenant un vrai `Interpreter` (au lieu du couple `{registry, executor}`
brut de la Phase 1).

**Portée actuelle de ce pont, honnêtement documentée** : `WindowsPC.
executeCmdCommand` continue de découper lui-même le chaînage (`&&`/`||`/
`&`) et les pipes (`|`) AVANT d'atteindre le pont — chaque segment simple
est donc ce qui arrive au `Interpreter`, jamais une ligne composite. Le
`Parser`/`Executor` savent déjà traiter `pipeline`/`and`/`or`/`sequence`
en un seul appel (utile dès qu'on voudra exécuter une ligne composite ou
un script multi-lignes sans repasser par le découpage `WindowsPC`), mais
ce chemin n'est pas encore exercé par l'intégration actuelle — fondation
posée, pas encore branchée. `CmdSubShell.executeBat()` (exécution des
`.bat`) n'est PAS touché dans cette phase : les scripts batch réels
utilisent `if`/`goto`/`for`/labels, une grammaire entièrement différente
de la ligne interactive cmd que `CmdLexer` couvre aujourd'hui — brancher
`executeBat` sur `Interpreter` prématurément aurait fait échouer tout
script utilisant un mot-clé batch non supporté, une vraie régression sur
`cmd-bat-execution.test.ts`. Chantier séparé, à faire une fois ces
mots-clés supportés par un parser batch dédié.

**Réponse à « toutes les commandes supprimées doivent être migrées » :
audit** — aucune implémentation legacy n'a été supprimée du dépôt en
Phase 1 ; seul le ROUTAGE (le `switch` dans `executeCmdCommand`) a été
retiré. Vérifié fichier par fichier (`WinDir.ts`, `WinPing.ts`,
`WinIpconfig.ts`, `WinNetsh.ts`, `WinTasklist.ts`, `WinSc.ts`, etc.) :
chaque fonction `cmdXxx` existe toujours, intacte, prête à être migrée
commande par commande — c'est du matériel de référence en attente, pas
du code perdu. `WindowsPC.executeCommand()` (méthode publique la plus
utilisée par la suite de tests) délègue directement à
`executeCmdCommand()` — c'est donc déjà, et reste, le point d'entrée
observable pour mesurer la progression de la migration à chaque
exécution de la suite de tests, sans changement nécessaire de ce côté.

**Validation** : même lot localisé qu'en Phase 1 (8 fichiers) — 118/144,
identique à la Phase 1 (aucune régression introduite par la réécriture).
Lot élargi (`windows-consistency`, `basic-commandes`, `env-vars`) :
86/149, cohérent avec l'écart déjà documenté (commandes réseau/système
hors périmètre). Typecheck ciblé propre sur `command-kernel` (socle +
Windows) et `WindowsPC.ts`.

## Windows — Phase 1 : pont `command-kernel` + commandes fichiers/session de `cmd`, cutover complet du dispatcher legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Premier équipement non-Linux sur `command-kernel` (§4 du framework). Aucun
pont Windows n'existait auparavant — tout est nouveau : `WindowsMachineApi`
(`src/network/devices/windows/command-kernel/WindowsMachineApi.ts`),
`WindowsUser`/`resolveWindowsUser`, `createWindowsHostShell`.

**Décision d'architecture — pas de `Lexer`/`Parser` partagé pour cmd.exe** :
la syntaxe cmd (`%VAR%`, `&` inconditionnel, lettres de lecteur, macros
doskey, `.bat`) diverge trop du grammaire bash de `command-kernel` pour
réutiliser son `Lexer`. `WindowsPC.executeCmdCommand` fait déjà tout ce
travail de découpage (chaînage `&&`/`||`/`&`, pipes, redirections,
changement de lecteur, expansion `%VAR%`, macros doskey) — le pont
(`runCommandKernelCmd`) construit directement un `SimpleCommandNode` à
partir du `(cmd, args)` déjà résolu et appelle `Executor.run()` sans
passer par `Interpreter`/`Lexer`/`Parser`, qui restent donc inchangés et
partagés uniquement au niveau moteur (`Executor`/`CommandRegistry`/
`PermissionGuard`/`ArgumentParser`), pas au niveau syntaxe.

**`MachineApi.fs` pour un filesystem sans owner/mode POSIX** : NTFS n'a ni
bits de permission Unix ni uid/gid — `FileStat.mode/ownerUid/ownerGid`
portent une valeur fixe (`0o666`/`0`/`0`), jamais lue par aucune commande
migrée (l'ACL réelle passe par `icacls`, non migré). `User.uid/gid` sont
dérivés d'un hash stable du SID Windows (pas d'identifiant numérique natif
dans ce modèle) — voir `numericIdFromSid` dans `WindowsUser.ts`.

**Périmètre migré (fichiers/session)** : `cd`/`chdir`, `mkdir`/`md`,
`rmdir`/`rd`, `type`, `copy`, `move`, `ren`/`rename`, `del`/`erase`,
`tree`, `set`, `cls`, `echo` (variante Windows dédiée — `echo -n foo`
affiche `-n foo` littéralement, contrairement à l'`EchoCommand` bash de
`registerCoreCommands` qui interprète `-n`/`-e`).

**Cutover complet du dispatcher, sur demande explicite de l'utilisateur**
(pas de fallback, même temporaire, vers le legacy) : tout
`executeCmdCommand` routait auparavant vers un switch de ~50 commandes
fichiers/système, un routeur `net <sous-commande>`, et un second switch
réseau (~14 commandes : `ipconfig`, `ping`, `netsh`, `ssh`, `route`,
`arp`, `nslookup`...). Les trois sont supprimés d'un bloc : le
dispatcher ne route plus que ce qui est enregistré dans
`createWindowsHostShell` ; toute commande non enregistrée renvoie
désormais le message exact `'<cmd>' is not recognized as an internal or
external command, operable program or batch file.` — un échec est donc,
par construction, le signal qu'une commande n'est pas encore migrée, plus
jamais un aiguillage silencieux vers une implémentation parallèle.
Les implémentations legacy encore utiles (`WinDir.ts`, `WinSystemCommands.ts`,
les commandes process/service/réseau de `WinFileCommands.ts`, etc.) sont
laissées en place, inutilisées, comme matériel de référence pour leurs
migrations futures (§3.1 étape 1 du framework — les supprimer maintenant
détruirait la seule référence de fidélité exacte disponible) ; elles sont
supprimées au fur et à mesure de leur migration réelle, jamais avant.
`runSyncNativeCommand` (pont synchrone séparé utilisé par les cmdlets
PowerShell natifs) n'est pas concerné par ce cutover — c'est un
consommateur distinct, hors périmètre de cette phase.

**Bugs trouvés en migrant (cause racine, pas juste le symptôme)** :

- `rmdir` utilisait initialement `WindowsFileSystem.deleteDirectory()`
  (suppression inconditionnelle) au lieu de `rmdir()`/`rmdirRecursive()`
  — perdait donc la vérification « répertoire non vide » que legacy
  `cmdRmdir` faisait réellement. Fix : `WindowsFileSystemApi.remove()`
  appelle `rmdir()`/`rmdirRecursive()`, jamais `deleteDirectory()`,
  exactement comme legacy (piège identique au §7.5 du framework, version
  Windows : deux méthodes VFS d'apparence équivalente, comportement
  différent).
- `ren`/`rename` : `renameEntry()` (legacy) rejette une collision de nom
  AVANT toute mutation (« A duplicate file name exists... ») et préserve
  l'entrée d'origine (mtime, attributs, ACL) ; le slot générique
  `FileSystemApi.rename()` (nécessairement `moveFile()`-backed pour
  rester utilisable par `move`, qui doit pouvoir traverser les
  répertoires) écraserait silencieusement une cible existante et recrée
  une entrée neuve. `RenCommand` reproduit donc la vérification de
  collision explicitement (avec exception pour un changement de casse
  pur, `ren a.txt A.txt`) avant d'appeler `rename()` — limitation connue
  et documentée : la préservation exacte de mtime/attributs/ACL au
  travers d'un `ren` n'est pas garantie (non couverte par la suite de
  tests localisée, donc non bloquante pour cette phase).

**Hors périmètre, échoue désormais explicitement avec « not recognized »
jusqu'à sa propre migration** : `dir`, `ver`, `hostname`, `systeminfo`,
`tasklist`, `netstat`, `vol`, `wmic`, `sc`, `netsh`, `ipconfig`, `ping`,
`ssh`/`sftp`/`scp`/`telnet`, `route`, `arp`, `nslookup`, `net`
(user/localgroup/start/stop/use/share/session/accounts/help), `auditpol`,
`winrm`, `whoami`, `icacls`, `runas`, `chcp`, `date`, `time`, `start`,
`setx`, `schtasks`, `print`, `lpr`, `slmgr`, `nbtstat`, `reg`, `nltest`,
`dcdiag`, `klist`, `netdom`, `dnscmd`, `certreq`, `certutil`, `query`,
`qwinsta`, `logoff`, `rwinsta`, `gpupdate`, `gpresult`, `iisreset`,
`doskey`, `powershell`/`pwsh` (sous-shell depuis cmd), `find`, `findstr`,
`where`, `more`, `fc`, `xcopy`, `sort`, `attrib`, `taskkill`.

**Validation** : lot localisé (8 fichiers ciblés fichiers/session/cwd —
`windows-filesystem`, `windows-drive-switching`, `windows-per-drive-cwd`,
`cmd-ps-coherence`, `subshell-isolation`, `windows-session-isolation`,
`windows-session-migration`, `prompt-cwd`) : 118/144 passent. Les 26
échecs restants pointent tous, sans exception, vers une commande
explicitement hors périmètre ci-dessus (`dir`, `ver`, `hostname`,
`systeminfo`, `tasklist`, `netstat`, `vol`, `wmic`, `sc`, `netsh`) —
aucune régression sur le périmètre migré. Typecheck ciblé propre
(`tsc --noEmit`, zéro erreur dans `command-kernel`/`WindowsPC`/
`WinFileCommands` ; les erreurs préexistantes ailleurs dans le dépôt —
`LinuxSshClient.ts`, `CiscoSwitchShell.ts`, `SshServerHandler.ts`,
`vlan-filter-ordering.test.ts` — ne touchent aucun fichier de cette
session). Lint ciblé non exécutable dans cet environnement (dépendance
`@eslint/js` absente du sandbox, pré-existant, sans rapport avec ce
changement).

**Suite (prochaines phases)** : `dir` en priorité (nécessite son propre
travail — numéro de série de volume, espace libre, correspondance
wildcard, formats large/récursif — pas réductible au `FileSystemApi`
générique sans l'étendre), puis `ver`/`hostname`/`systeminfo`/`tasklist`/
`netstat`/`vol` (commandes système simples), puis le périmètre réseau
(`ipconfig`, `ping`, `netsh`...) qui délèguera à `MachineApi.net` en
s'appuyant sur `EndHost`/`Port`/`Cable` existants (§2 du framework),
jamais une resimulation parallèle.

## Linux — Phase 5 : `rmdir`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Extension du socle** : `FileSystemApi.rmdir(path, actor)` — distinct de
`remove(path, actor, recursive)` : échoue avec `ENOTEMPTY` si le
répertoire n'est pas vide, ne supprime jamais récursivement, même avec
un futur flag. Implémenté via `VirtualFileSystem.rmdir()` (déjà utilisé
par le legacy `cmdRmdir`). Le contrôle du bit sticky et de la permission
du parent, identique à celui de `rm`, a été factorisé dans
`LinuxFileSystemApi.assertStickyRemovable()` (partagé par `remove()` et
`rmdir()`) plutôt que dupliqué — les deux commandes legacy (`cmdRm`/
`cmdRmdir`) ont exactement la même logique de vérification.

**Commande migrée** : `rmdir <répertoire...>` — message d'erreur au
format `rmdir: failed to remove '<cible>': <raison>`, audit
(`syscall=rmdir`) après succès uniquement.

**Validation** : même lot localisé qu'à la phase précédente, `run-parts.
test.ts` inclus — 39 fichiers, 1604 tests, mêmes 3 échecs pré-existants
et sans rapport déjà documentés (bash script `if/then`/fonctions, hors
périmètre command-kernel).

## Linux — Phase 4 : `ln` (liens physiques et symboliques)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Extension du socle** : `FileSystemApi` gagne `link(targetPath, path,
actor)` — lien physique, distinct de `symlink()` déjà existant.
Implémenté dans `LinuxFileSystemApi` via `VirtualFileSystem.createHardLink`
(déjà utilisé par le legacy `cmdLn`, partage réellement le même inode et
incrémente `linkCount` — vérifié par `ls -i` sur les deux noms). Ajouté
aussi dans `testing/in-memory-machine.ts` (le `MachineApi` factice du
socle) en partageant la même référence d'objet entre les deux chemins.

**Commande migrée** : `ln [-s] <cible> <lien>` — lien physique par
défaut, symbolique avec `-s`, message d'erreur au format legacy exact
(`ln: failed to create <kind> '<lien>': <raison>`), audit
(`syscall=symlink`/`syscall=link`) après succès uniquement (§7.4 du
framework).

**Validation** : lot localisé étendu à `run-parts.test.ts` (contient des
créations de liens symboliques cassés/valides) en plus du lot déjà établi
— 39 fichiers, 1604 tests, 3 échecs **confirmés pré-existants et sans
rapport** (méthode §7.2 : mêmes 3 échecs avec `git stash` des changements
de cette phase). Ces 3 échecs concernent l'interpréteur bash de scripts
(`src/bash/`, hors périmètre de `command-kernel`) sur des scripts
utilisant `if/then/else` et des déclarations de fonction — un vrai trou,
mais dans un sous-système entièrement différent, à traiter séparément.

## Linux — Phase 3 : lecteurs d'identité (`id`, `whoami`, `groups`) + durcissement `rm`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suit `migration_framework.md` : vérifié au préalable que `id`/`whoami`/
`groups` n'existent nulle part dans l'autre framework de migration
(`src/network/devices/linux/commands/iam/`) et qu'aucune entrée de
`defaultCommandPrivileges.ts` ne les restreint — `PrivilegeLevel.ANY`
est donc bien équivalent au comportement legacy.

**Périmètre migré** :

- `id` — format par défaut (`uid=…(…) gid=…(…) groups=…`), `-u`/`-g`/`-G`
  (avec `-n` pour les noms), rejet des combinaisons invalides
  (`-n` seul, plusieurs sélecteurs) avec les mêmes messages et le même
  code de sortie que legacy (`0`, sauf utilisateur inexistant → `1`).
- `whoami`, `groups [utilisateur]` (format `nom : groupes` uniquement si
  l'utilisateur est passé explicitement, comme legacy).
- Aucun de ces trois n'a d'effet de bord filesystem — seul le prélude
  générique `publishCommandExecve` (déjà en place, voir la phase
  précédente) s'applique, pas de nouvel appel d'audit par commande.

**Bug trouvé en élargissant les tests localisés (`rm-preserve-root.test.ts`,
jamais inclus dans un lot précédent)** — pas une régression de cette
session, un trou déjà présent depuis la Phase 1 sur `rm`, découvert en
suivant la règle du framework « élargir le filet dès qu'on touche à
IAM/privilège » :

- `rm` n'implémentait ni `--preserve-root`/`--no-preserve-root` (refus de
  `rm -rf /`), ni le bit sticky de `/tmp` (`rm` d'un fichier d'autrui dans
  un répertoire sticky doit échouer avec « Operation not permitted »), ni
  le format de message exact `rm: cannot remove '<cible>': <raison>`
  (le pont renvoyait `rm: <chemin résolu>: <raison>`, sans le préfixe
  `cannot remove`). Fix : `LinuxFileSystemApi.remove()` réplique l'ordre
  exact des vérifications legacy (répertoire non récursif → bit sticky →
  suppression), `RmCommand` porte la logique `--preserve-root` (propre à
  `rm`, pas une notion de filesystem générique) et reformate les erreurs
  au format exact.

**Nettoyage** : déplacement de la validation `cut` (« une option -f, -c ou
-b est requise ») dans `validate()`, sur le modèle déjà établi par
`ChmodCommand` — c'est une incohérence purement syntaxique entre
arguments déjà parsés, indépendante de `ctx.machine`, donc elle n'a pas
sa place dans `execute()`. Les autres validations argument-dépendantes
(`chown` résout un utilisateur/groupe réel, `cut` calcule des plages qui
dépendent de la longueur de chaque ligne) restent dans `execute()` car
elles ont besoin de `ctx.machine` ou d'un état runtime que `validate()`
n'a pas.

**Validation** : lot localisé élargi (38 fichiers, 1457 tests, 0 échec) —
IAM/filesystem, ACL, privilège, audit/journalisation, su/sudo, et
l'ensemble déjà établi des phases précédentes.

## Linux — Fix critique : parité d'audit/trace pour les commandes déjà migrées

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Découvert en élargissant les tests localisés à `auditctl.test.ts`,
`auditctl-other.test.ts`, `journalization.test.ts` et
`journalization-and-audit.test.ts` (480 tests, jamais exécutés contre le
bridge command-kernel avant ce tour) : **25 régressions réelles**,
confirmées par comparaison directe avec le commit précédant l'existence de
command-kernel (480/480 passaient avant migration).

**Cause racine.** `LinuxCommandExecutor.dispatch()` — le point d'entrée
legacy — exécute un prélude AVANT le `switch` de chaque commande : bascule
`currentCommandHead`, puis `publishFsAccess`/`publishSyscall('execve', …)`
pour la commande elle-même, et pour les commandes filesystem, un second
jeu d'appels par argument (`open`/`mkdir`/`unlink`/`rename`/`chmod`/
`chown`…) qui alimente `auditd`/`ausearch`/`aureport` simulés. Le pont
`tryCommandKernel` contourne entièrement `dispatch()` — il n'exécutait
donc ni le prélude, ni les appels par commande, rendant tout audit
silencieusement absent pour les commandes déjà migrées (Phases 1 et 2).

**Fix (pas de repli sur l'ancien chemin — le comportement est reproduit,
pas contourné)** :

- `MachineApi` gagne une capacité optionnelle `audit?: AuditApi`
  (`fsAccess(path, perm, syscall?)`, `syscall(name, path?)`) — absente
  pour les profils qui n'en ont pas besoin, les commandes l'appellent via
  `ctx.machine.audit?.`.
- `LinuxMachineApiDeps` gagne `publishFsAccess`/`publishSyscall`, câblés
  dans `LinuxMachine.getCommandKernelShell()` sur les wrappers publics
  déjà existants `LinuxCommandExecutor.publishAuditFsAccess`/
  `publishAuditSyscall`.
- Nouveau `LinuxCommandExecutor.publishCommandExecve(cmd)` — réplique
  exactement le prélude de `dispatch()` (bookkeeping + accès `/usr/bin/
  <cmd>`+`/bin/<cmd>` + `execve`) ; appelé par `tryCommandKernel` pour
  chaque étage d'un pipeline avant exécution.
- `LinuxFileSystemApi.writeFile()` publie désormais `('w','open')` avant
  d'écrire — couvre à la fois `touch` (avant sa réécriture, voir
  ci-dessous) et toute redirection `>`/`>>` (`FileOutputStream` passe par
  `writeFile`, donc `echo … >> fichier` publie correctement).
- Chaque commande fichier migrée (`ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`,
  `chmod`, `chown`) publie l'événement correspondant, à l'identique de son
  `case` legacy — **après** l'opération réussie (pas avant), pour ne
  jamais logger un accès qui a en fait échoué.
- Nouvelle méthode `FileSystemApi.touch(path, actor)` (implémentée via
  `VirtualFileSystem.touch()`, pas `writeFile()`) : `touch` sur un fichier
  déjà existant ne fait que rafraîchir sa date de modification, sans
  passer par le chemin d'écriture générique — corrige une régression
  fonctionnelle distincte où `touch` déclenchait à tort les observateurs
  `vfs.onWrite()` d'une règle `-w` (donc ignorait les règles
  d'exclusion `-a never,exit -F dir=…`, que `vfs.touch()` ne traverse
  jamais).

**Deux bugs fonctionnels distincts trouvés au passage (mêmes tests)** :

- **`chown user:group_name`** : `ChownCommand` n'acceptait qu'un gid
  numérique après `:` (limitation documentée en Phase 1), alors que
  legacy résout aussi un nom de groupe. Fix : `resolveGid()` (miroir de
  `resolveUid()`) via `ctx.machine.groups.findByName`.
- **`echo "-w ...token qui ressemble à une option inconnue"`** :
  `ArgumentParser` levait `UsageError` sur tout token `-x` non reconnu,
  alors que le vrai `echo` n'échoue jamais sur une option inconnue (il
  l'affiche littéralement). Nouveau `CommandDescriptor.lenientOptions`
  (opt-in, seul `EchoCommand` l'utilise) : un token dash non reconnu
  devient un positional au lieu de lever une erreur.

**Validation** : les 4 fichiers d'audit (480 tests) + l'ensemble déjà
établi (IAM, ACL, text-processing, bash) repassés intégralement —
36 fichiers, 1359 tests, 0 échec.

## Linux — Phase 2 : traitement de texte (coreutils)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Câblée sur le même point d'entrée que la Phase 1, validée contre les
suites de tests dédiées (`linux-cut-flags`, `linux-sort-flags`,
`linux-wc-flags`, `linux-tr-uniq-flags`) et l'ensemble de la Phase 1 +
`linux-bash-details` (pipes, substitutions, échappements) sans
régression.

**Périmètre migré** (`src/network/devices/linux/command-kernel/commands/`) :

- `grep` — `-i`, `-v`, `-n`, `-c`, `-E`, multi-fichiers (préfixe `label:`).
- `head` / `tail` — `-n N` (raccourci numérique `-N`), `head -c N` (octets).
- `wc` — `-l`/`-w`/`-c`/`-m`/`-b`/`-L`, ligne `total` multi-fichiers,
  erreur `wc: <fichier>: No such file or directory` par fichier manquant
  sans interrompre le traitement des fichiers valides.
- `sort` — `-n`, `-r`, `-u`, `-h` (suffixes K/M/G), `-V` (version-sort),
  `-M` (mois), `-f` (insensible à la casse), `-t DELIM` + `-k KEY[,KEY][n]`
  (tri par colonne avec override de type par clé).
- `cut` — `-d`/`-f` (listes et plages `1-3`/`2-`/`-2`), `-c`/`-b`
  (caractères/octets), `-s`/`--only-delimited`, `--output-delimiter`,
  `--complement`.
- `uniq` — `-c`, `-d`, `-u`, `-i`, `-f N`.
- `tr` — `-d`, `-s`, `-c`, classes POSIX (`[:upper:]`...), échappements,
  plages `a-z`.
- `textInput.ts` — helper partagé (`splitLines`/`joinLines`,
  `readTextInput`/`readPerFileInputs`) pour une gestion fidèle du saut de
  ligne final, réutilisé par toutes les commandes ci-dessus.

**Extensions du socle** :

- `ArgumentParser` : valeur courte collée (`-d,` / `-n5`) via
  `matchGluedShortValue`.
- `Executor` : expansion générique de globs (`*`, `?`, `[...]`) au niveau
  du moteur (`exec/glob-expand.ts`), respecte `Word.noExpand`.
- Marqueur interne `ESCAPED_DOLLAR` (`ast/tokens.ts`) : un `\$` (guillemets
  doubles ou nu) survit au lexing sans être expansé comme variable, puis
  restitué en `$` littéral par l'`Expander` — et symétriquement par
  l'`Executor` pour les mots `noExpand` (guillemets simples).

**Bugs trouvés puis corrigés en testant contre la suite existante** :

- **`grep` avalait une ligne vide fantôme.** `content.split('\n')`
  produisait une dernière entrée vide pour tout contenu se terminant par
  `\n` ; avec `-v`, cette ligne vide (ne contenant jamais le motif) était
  incluse à tort, ajoutant un saut de ligne fantôme en sortie — détecté
  via un pipeline `echo | grep -v ... | wc -l` qui comptait une ligne de
  trop. Fix : `grep` utilise désormais `splitLines` (même utilitaire que
  `cat`/`head`/`tail`) au lieu d'un `split('\n')` brut.
- **`\$` échappé était expansé comme variable.** Le lexer réduisait
  `\$dollar` à `$dollar` avant l'expansion, donc l'Expander tentait de
  substituer une variable `dollar` inexistante et l'effaçait. Fix :
  marqueur `ESCAPED_DOLLAR` posé au lexing, restitué en `$` littéral
  après expansion (ou directement pour les mots `noExpand`).
- **`cat` refusait de lire l'entrée standard.** L'argument `files` était
  `required: true`, donc `cat` en fin de pipe (`... | cat`) échouait avec
  « argument requis manquant » au lieu de lire `stdin`. Fix : `files`
  devient optionnel, avec repli sur `ctx.io.stdin.readAll()` — même motif
  que `sort`/`cut`/`head`/`tail`.
- **`sort -k F,Fn` dupliquait le champ.** La reconstruction de clé
  ajoutait un `endTail` même quand `startField === endField`, produisant
  une clé du type `"11 1"` au lieu de `"11"`. Fix : la troncature ne
  s'applique que si un caractère de fin est explicitement spécifié sur le
  même champ ; la valeur du champ seul est utilisée sinon.

**Hors périmètre de cette phase** : réseau, IAM avancé, matériel, audit,
systemd (inchangé depuis la Phase 1).

## Linux — Phase 1 : filesystem & session (coreutils)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Cette phase est câblée sur le vrai point d'entrée
(`LinuxMachine.executeCommand`) et validée contre plus de 20 fichiers de
tests déjà existants dans le projet (filesystem/IAM, ACL POSIX,
substitution de commande, variables d'environnement, hardware, cron,
logging...), en plus des tests dédiés du socle.

**Câblage réel** (`LinuxMachine.tryCommandKernel`, appelé depuis
`executeCommand`) :

- Une ligne passe par `command-kernel` uniquement si elle se réduit, une
  fois parsée, à une commande simple ou un pipeline (jamais `;`, `&&`,
  `||`, boucles, conditions, sous-shells — ceux-ci restent intégralement
  sur `src/bash/` + `LinuxCommandExecutor`) ET si chaque commande qu'elle
  nomme est déjà enregistrée sur le profil Linux. Sinon, repli intégral
  et silencieux sur l'ancien chemin (aucune exécution partielle).
- Le `cwd` et l'`umask` sont lus/réécrits sur `this.executor` à chaque
  appel (pas d'état dupliqué) ; l'identité vient de
  `LinuxUserManager.currentUser`.

**Périmètre migré vers `command-kernel`** (`src/network/devices/linux/command-kernel/`) :

- `LinuxMachineApi` — implémentation réelle de `MachineApi`, pont direct
  vers `VirtualFileSystem` (via `VfsPath` pour les contrôles d'accès
  POSIX), `LinuxUserManager`, `LinuxProcessManager` et les ports
  matériels. Aucun état parallèle : `LinuxCommand`/`LinuxCommandExecutor`
  continuent d'opérer sur les mêmes `VirtualFileSystem`/`LinuxUserManager`
  sous-jacents.
- `LinuxUser` — adapte un `LinuxUserAccount` réel au contrat `User` de
  command-kernel (uid/gid/groupes/gids supplémentaires).
- Commandes : `pwd`, `cd`, `ls` (`-l`, `-a`, `-d`, `-S`, `-R`, `-i`,
  cibles multiples, résolution owner/group par nom), `cat` (`-n`),
  `mkdir` (`-p`), `touch`, `rm` (`-r`, `-f`), `cp`, `mv`, `stat`
  (format par défaut + `-c FORMAT`), `chmod` (octal et symbolique
  `u+w,g-w,o=r`/`a-x`/`u+s`/`g+s`/`o+t`), `chown` (utilisateur par nom,
  groupe par gid numérique).
- `createLinuxHostShell()` — bootstrap par profil d'équipement (§3.2 du
  framework), compose `registerCoreCommands` (universel : `exit`, `echo`)
  + les coreutils ci-dessus.

**Extensions du socle `command-kernel`** (nécessaires, pas de façade
parallèle créée) :

- `FileSystemApi` prend désormais un `FileSystemActor` (uid/gid/gids)
  explicite à chaque appel — le contrôle d'accès dépend de qui appelle,
  pas de quelle machine répond ; une seule `MachineApi` reste partagée
  entre toutes les sessions/terminaux d'un équipement.
- `FileStat` enrichi (`type`, `ownerGid`, `linkCount`, `inode`,
  `symlinkTarget`) ; `FileSystemApi` gagne `lstat`, `exists`, `copy`,
  `rename`, `symlink`, `readlink`.
- Nouvelle erreur `FileSystemError` (ENOENT/EACCES/ENOTDIR/EISDIR/EEXIST/
  ENOTEMPTY), alignée sur `VfsPath.PathError`.
- `User` gagne `supplementaryGids` (gids numériques, distincts des noms
  de groupe utilisés pour `PrivilegePolicy`).
- `UserManagementApi.findByUid` + nouvelle `GroupManagementApi`
  (`findByGid`/`findByName`) sur `MachineApi.groups` — nécessaires pour
  que `ls -l`/`stat` affichent des noms, pas des identifiants numériques.
- `ArgumentParser` : options courtes combinables (`-la` = `-l -a`) ;
  correction d'un bug où un positional variadique optionnel resté vide
  faisait répondre `ParsedArgs.has()` par « présent ».
- L'AST distingue désormais les mots issus de guillemets simples
  (`Word.noExpand`) : un argument comme `'texte $VAR'` n'est plus expansé
  par erreur — bug trouvé en migrant des scripts réels.
- Commandes universelles (`registerCoreCommands`) : `EchoCommand` sait
  interpréter `-e`/`-n`/`-E` (échappements bash `\n`, `\t`...).

**Bugs trouvés puis corrigés en testant contre la suite existante** :

- **ACL POSIX contournées.** `FileSystemActor` ne portait que des
  identifiants numériques (uid/gid/gids) ; `VfsPath.allows()` ne consulte
  les ACL (`setfacl`) que si `PathActor.user`/`groupNames` (des noms) sont
  renseignés. Fix : `FileSystemActor` et `toFileSystemActor()` portent
  désormais `name`/`groupNames`, propagés jusqu'à `VfsPath` par
  `LinuxMachineApi`.
- **Substitution de commande non supportée.** L'Expander de
  command-kernel ne gère pas `$(...)`/`` `...` ``. `tryCommandKernel`
  refuse maintenant le routage dès que la ligne brute contient l'un des
  deux (repli intégral sur l'ancien chemin, qui les supporte).
- **Variables d'environnement non alimentées.** La session construite par
  le pont avait un `env` toujours vide. `LinuxCommandExecutor.getEnvSnapshot()`
  expose maintenant le même environnement complet (statique + calculé :
  `HOSTNAME`, `HOME`, `USER`...) que celui que `LinuxCommandExecutor`
  construit pour son propre interpréteur bash (`buildEnvVars()`), utilisé
  pour peupler la session à chaque appel.

**Hors périmètre de cette phase (volontairement, à traiter en phases
suivantes)** :

- Réseau (`ip`, `ping`, `iptables`…), IAM avancé (`useradd`, `passwd`,
  `chage`…), matériel (`lspci`…), audit, services systemd — restent sur
  `LinuxCommand`. `LinuxMachineApi.net`/`.proc`/`.users` existent déjà
  (réels, pas des stubs) mais aucune commande de ce périmètre n'est
  encore migrée.
- `chown` : groupe par gid numérique uniquement, pas par nom (pas de
  résolution de groupe par nom câblée dans la commande elle-même, bien
  que `MachineApi.groups` existe désormais).
- `umask` fixé à la valeur courante de `LinuxCommandExecutor` au moment
  de l'appel (lu dynamiquement, mais aucune commande `umask` n'est
  migrée pour le modifier depuis command-kernel).
- Pas de vérification du bit d'exécution sur les répertoires ancêtres
  lors de la traversée de chemin (le `VirtualFileSystem` sous-jacent ne
  l'implémente pas non plus — pas une régression introduite ici).

## command-kernel — socle initial

Architecture d'interpréteur de commandes indépendante du vendeur
(`src/command-kernel/`) : sessions & `PrivilegePolicy` portée par la
commande, `CommandIO`/pipes, façade `MachineApi`, parsing d'arguments
typé, `ICommand`/`CommandRegistry`, Lexer/Parser/AST/Executor complets
(pipes, `&&`/`||`, `if`/`for`/`while`, sous-shells isolés, redirections
`>`/`>>`/`<`), `Interpreter`, `Terminal`/`VirtualTerminal`, `Shell` (REPL,
historique, prompt).
