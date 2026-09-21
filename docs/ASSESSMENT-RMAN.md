# Assessment — ce qui manque pour un RMAN réaliste

**Date :** 2026-09-10 · **Méthode :** inventaire du code puis MESURE sur
laboratoire réel (un `LinuxServer` avec une base bootée, pilotage par
`rman target /` et par le moteur SQL), jamais par lecture seule.

> **Ce document ne part pas de zéro.** `src/terminal/subshells/rman/`
> porte déjà **73 fichiers / 5 735 lignes** : dispatcher table-driven,
> catalogue réactif, pool de canaux, moteur de jobs, 26 commandes,
> value objects (`Scn`, `RmanTag`, `BackupKey`, `DbId`). L'architecture
> est décrite dans `DESIGN-RMAN-REACTIVE.md` et elle est bonne. Ce qui
> suit ne juge pas l'architecture : il mesure l'écart entre ce que le
> RMAN actuel **dit** et ce qu'il **fait**.

---

## 1. La mesure qui décide de tout

Le seul test qui dit si un RMAN veut dire quelque chose : sauvegarder,
détruire, restaurer.

```
[0]  CREATE TABLE clients …                        ok
[1]  SELECT COUNT(*) FROM clients                  1 ligne
[2]  BACKUP DATABASE                               Finished backup
[3]  LIST BACKUP    BS Key 1  Full  1.61G  DISK
                    Piece Name: /u01/backup/ORCL_i3yna78y.bkp
[4]  DROP TABLE clients                            ok
[5]  RESTORE DATABASE                              RMAN-06403: database
                                                   must be mounted
[6]  SELECT COUNT(*) FROM clients                  ORA-00942
```

**Depuis les lots R1 et R2, la table revient.** Le même enchaînement,
mesuré après :

```
[8]  SELECT COUNT(*) FROM clients                  2
```

Trois pièces ont été mises bout à bout :

- un **checkpoint** (`ALTER SYSTEM CHECKPOINT`, un `SHUTDOWN` propre, un
  `OPEN`, ou le début d'un `BACKUP`) sérialise chaque tablespace
  permanent dans le **premier** fichier de données qui le porte ;
- `BACKUP` **lit** ces fichiers et écrit leur contenu dans la pièce OMF ;
  `RESTORE` **réécrit** les fichiers depuis la pièce ;
- l'`OPEN` relit les fichiers de données et recharge les tablespaces —
  une table détruite entre-temps est **recréée**, sa métadonnée voyageant
  avec ses lignes.

Ce qui suit décrit l'état AVANT ces deux lots, conservé parce qu'il
explique pourquoi la chaîne répondait « fini » sans rien faire :

```
[3c] ls -l /u01/backup
     -rw-r--r-- 1 root root 1730150400 ORCL_i3yna78y.bkp
[3d] cat /u01/backup/*.bkp
     "[ORACLE RMAN BACKUP PIECE - 1730150400 bytes]"

[4]  ls -l …/oradata/ORCL/users01.dbf
     -rw-r--r-- 1 oracle oinstall 43 users01.dbf
[4b] cat …/users01.dbf
     "[ORACLE DATAFILE - USERS tablespace - 100M]"
```

**Une pièce de sauvegarde de 1,73 Go dont le contenu est la phrase qui
annonce sa taille.** Un fichier de données de 43 octets qui annonce
100 M. Le code le dit lui-même, sans détour, dans `VfsAdapter` :

> « `declaredSizeBytes`, when given, is the logical size the backup piece
> should report to `ls -l`/`du`/`stat` even though `data` may be a much
> smaller (or empty) physical placeholder — real backup pieces can be
> gigabytes, too large to actually buffer in memory. »

Et `RmanJobEngine` écrit littéralement
`vfs.writeFile(path, new Uint8Array(0), df.sizeBytes)`.

**RMAN ne lit jamais les octets d'un fichier de données, parce qu'il n'y
en a pas.** C'est la question centrale de cet assessment, et elle ne se
tranche pas dans RMAN.

---

## 2. Pile APPLICATIVE (Oracle) — la racine

### 2.1 Les données ne sont pas dans les fichiers

`OracleStorage` range un tablespace comme **métadonnée pure** :

```ts
{ name: 'USERS', datafiles: [{ path: '…/users01.dbf', size: '100M', … }] }
```

`size` est une **chaîne**. Les lignes vivent dans `BaseStorage`, en
mémoire JS. Le `.dbf` est un décor cohérent — bon propriétaire
(`oracle:oinstall`), bon chemin, bonne place dans `V$DATAFILE` — mais
sans octets.

> **Conséquence :** aucun travail fait DANS RMAN ne peut produire une
> sauvegarde qui restaure. Tant que le contenu d'un tablespace n'est pas
> sérialisable vers son fichier, `RESTORE` ne peut être qu'une animation.

**C'est le seul verrou qui compte, et il est hors de RMAN.** Il se lève
en donnant à `OracleStorage` une frontière de sérialisation :
`serializeTablespace(name) -> bytes` / `loadTablespace(name, bytes)`.
Le format n'a pas à imiter un bloc Oracle ; il doit être **stable,
relisible, et de taille plausible**.

### 2.2 Ce qui existe déjà et qui est solide

| Brique | État mesuré |
|---|---|
| SCN | **réel et croissant** — `SELECT current_scn` → 1000319 |
| Groupes de redo | **réels** — `V$LOG` rend `1 CURRENT, 2 UNUSED, 3 UNUSED` |
| `V$DATAFILE`, `V$BACKUP_SET`, `V$BACKUP_PIECE`, `V$RMAN_STATUS`, `V$RMAN_OUTPUT`, `V$DATAFILE_HEADER`, `V$CONTROLFILE_RECORD_SECTION` | présentes |
| États d'instance | `SHUTDOWN`/`NOMOUNT`/`MOUNT`/`OPEN` portés et **respectés** — `RESTORE` sur base ouverte rend bien `RMAN-06403` |
| Codes d'erreur RMAN | conformes (`RMAN-00569/00571/03014/06403/01009`) |

C'est beaucoup, et c'est ce qui rend le chantier raisonnable.

### 2.3 Ce qui manque

| Manque | Mesure | Ce qu'il bloque |
|---|---|---|
| **ARCHIVELOG** | `SELECT log_mode` → `NOARCHIVELOG`, `V$ARCHIVED_LOG` → 0 ligne | tout PITR : `RECOVER UNTIL TIME/SCN/SEQUENCE`, `BACKUP ARCHIVELOG`, Data Guard réel |
| **Écriture du redo** | les groupes existent mais rien n'y écrit ; pas de `LOG SWITCH` observable | `RECOVER` ne peut rejouer aucune transaction |
| **Sérialisation des tablespaces** | §2.1 | `RESTORE`/`RECOVER`/`DUPLICATE`/`VALIDATE` |
| **Fichier de contrôle** | chemin déclaré, section `V$CONTROLFILE_RECORD_SECTION` présente ; pas de contenu | `RESTORE CONTROLFILE`, `RESYNC`, autobackup |
| **`SHUTDOWN`/`STARTUP` depuis RMAN** | `RMAN-01009: unknown command: SHUTDOWN IMMEDIATE` | le cycle de restauration entier, qui exige de descendre en `MOUNT` |

---

## 3. Pile OS — la moins éloignée

C'est la pile la plus prête, et c'est une bonne nouvelle.

| Brique | État mesuré |
|---|---|
| VFS, chemins `/u01/app/oracle/…` | réels, conformes à l'OFA |
| Propriété | `oracle:oinstall` sur les fichiers de données ✅ |
| Espace disque | `df -h /u01` → `100G / 16G utilisés / 84G dispo` **réel**, et la taille DÉCLARÉE d'une pièce consomme l'allocation (`/u01/backup` totalise 3 379 200 blocs) |
| `availableBytes()` | présent dans `VfsAdapter` |

**Trois écarts étaient relevés ici. Les trois sont fermés (lot R6).**

1. ~~**La pièce de sauvegarde appartient à `root:root`**~~ — elle est
   désormais écrite par le processus serveur Oracle
   (`writeFileAsOracle`), donc `oracle:oinstall` comme le fichier de
   données.
2. ~~**La FRA est vide**~~ — la destination par défaut est le
   `db_recovery_file_dest` que l'instance déclare, et la pièce y porte
   son nom OMF :
   `/u01/app/oracle/fast_recovery_area/ORCL/backupset/2026_09_10/o1_mf_nnndf_TAG20260910T155615_w2wy71ly_.bkp`.
   Le répertoire daté est créé par la base elle-même, comme la FRA est
   par définition un espace géré par Oracle.
3. ~~**Pas de permissions vérifiées à l'écriture**~~ — mesuré :

   ```
   mkdir -p /u01/backup_root                          (root:root)
   BACKUP DATABASE FORMAT '/u01/backup_root/%U';
     ORA-19504: failed to create file "/u01/backup_root/ORCL_ihtfdn05"
     ORA-27040: file create error, unable to create file

   mkdir -p /u01/backup_ora && chown oracle:oinstall /u01/backup_ora
   BACKUP DATABASE FORMAT '/u01/backup_ora/%U';
     Finished backup at 10-SEP-2026 15:56:15
   ```

   Une destination que le DBA crée sans la donner à `oracle` est refusée,
   exactement comme sur une vraie machine.

Deux écarts de plus, trouvés en fermant ceux-là, et fermés avec eux :

4. **Le quota de la FRA n'était évalué nulle part.** Quatre sauvegardes
   de 1,73 Go entraient dans une FRA de 4 Go sans un mot. Désormais :

   ```
   RMAN> BACKUP DATABASE;   (3e tour)
     RMAN-03014: RMAN-19811: ORA-19809: limit exceeded for recovery files
     ORA-19804: cannot reclaim 1730150400 bytes disk space from 4294967296 limit
   ```

   Une pièce écrite HORS de la FRA (`FORMAT '/u01/hors/%U'`) ne consomme
   pas ce quota — vérifié.

5. **`oracle.backup.recorded` n'était émis par personne**, donc HUIT
   vues V$ (`BACKUP_SET`, `BACKUP_PIECE`, `BACKUP_DATAFILE`,
   `BACKUP_FILES`, `BACKUP_REDOLOG`, `RMAN_STATUS`, `RMAN_OUTPUT`,
   `RECOVERY_AREA_USAGE`) restaient vides pendant que `LIST BACKUP`
   montrait les pièces et que `ls` les trouvait sur le disque. Un moteur
   sans porte, exactement la forme que le §3 traque. RMAN publie
   désormais chaque pièce dans l'état d'exécution de l'instance ; le
   calcul d'occupation de la FRA a une seule écriture
   (`storage/RecoveryArea.ts`) que les deux vues et RMAN lisent.

6. **Quatre variables de FORMAT sur huit n'étaient pas substituées** —
   `%d`, `%t`, `%n`, `%I` traversaient le nom de fichier telles quelles,
   et `%T` rendait le tag au lieu de la date :

   ```
   avant : %d_TAG20260910T160713_1_1_ORCL_71xyf4ig_%t_%n_%I.bkp
   après : ORCL_20260910_1_1_01tl5p4p_1_1_1789056889_ORCLxxxx_3942207946.bkp
   ```

   Un critère accepté par le parseur et jamais évalué (§6). La table
   complète (`%d %n %I %T %t %s %p %c %e %u %U %F`) vit maintenant dans
   `rman/core/formatSpec.ts`.

---

## 4. Pile RÉSEAU — la plus éloignée, et la plus contraire aux règles

> **Fermée depuis.** Ce que cette section décrit est l'état de départ.
> Les lots R2b, R8a (NFS), R8b, R7 et R7b l'ont refermée : la cible est
> résolue, la session Oracle Net est ouverte à travers routeur et
> pare-feu, les identifiants sont vérifiés, et chaque commande comme
> chaque accesseur pose sa question sur le fil (§5.0, §5.2, §5.3, §5.4).
> Le constat ci-dessous est conservé parce qu'il dit **pourquoi** cela
> comptait.

```ts
export class ConnectCommand implements IRmanCommand<string[]> {
  execute(_args: string[], { bus, ctx }: RmanCommandContext) {
    return ok([`connected to target database: ${ctx.dbName} …`]);
  }
}
```

**Les arguments sont ignorés.** `CONNECT TARGET sys/pw@DR_SITE` répond
« connected to target database: ORCL » — c'est-à-dire la base LOCALE,
sous le nom qu'on n'a pas demandé.

Cela viole frontalement le **§4 de `CLAUDE.md`** (« anything sent between
two machines MUST cross the simulated network as real frames »), qui est
la règle cardinale de ce dépôt. Un `rman-wan-disaster-recovery.debug.test.ts`
existe et met en scène un site DR : la scène est jouée, aucune trame ne
part.

### 4.1 La mesure en infrastructure d'entreprise

Le banc unitaire montrait le code ; un laboratoire d'entreprise montre
la conséquence. Deux LAN, un FortiGate entre eux, un serveur de base et
un serveur de sauvegarde
(`src/__tests__/debug/rman/rman-infra-entreprise.debug.test.ts`) :

| | mesure |
|---|---|
| **[A]** ping DB→BACKUP, aucune politique | `100% packet loss` |
| **[B]** ping, politique **ACCEPT** | `0% packet loss` |
| **[E]** ping, politique **DENY** | `100% packet loss` |
| **[C]** `CONNECT TARGET sys/oracle@10.10.20.20:1521/BKPCAT`, pare-feu **ouvert** | `connected to target database: ORCL` |
| **[F]** la même commande, pare-feu **FERMÉ** | `connected to target database: ORCL` |
| **[D]** table de sessions du pare-feu | `4` avant RMAN, `4` après |
| **[G]** `BACKUP … FORMAT '/mnt/backup_nfs/%U'` | `Finished backup`, `piece handle=/mnt/backup_nfs/ORCL_…` |
| **[H]** ce chemin, vu du serveur de sauvegarde | `No such file or directory` |

> **[G]/[H] sont FERMÉS** par le lot NFS (voir §5.1). La mesure est
> désormais : `piece handle=/mnt/backup_nfs/01tlcvep_1_1`, et `ls
> /srv/backup` **sur le serveur de sauvegarde** rend cette pièce. Les
> octets traversent le routeur puis le pare-feu ; politique passée à
> `deny`, le montage ne se fait plus. Sonde :
> `nfs-montage-reseau-reel`, 8 cas discriminants sur 10 (voir §5.2).

**[A]/[B]/[E] sont le témoin, et ils rendent le reste opposable.** Le
pare-feu de ce laboratoire bloque réellement : sans politique il jette,
avec `ACCEPT` il achemine, avec `DENY` il jette de nouveau. Que **[C]**
et **[F]** rendent la MÊME réponse ne peut donc pas s'expliquer par un
pare-feu inerte. La conclusion est plus simple et plus grave : *un
pare-feu ne bloque pas ce qui ne traverse rien*.

Et **[G]/[H]** disent la même chose du côté des données : une sauvegarde
annoncée « terminée » vers un point de montage distant écrit en réalité
dans le VFS **local**, à un chemin dont le nom suggère le contraire. Le
serveur de sauvegarde n'a jamais rien reçu.

> **Ce que cela change dans les priorités.** Dans la première rédaction
> de ce document, la pile réseau était classée « fidélité additive »
> (lots R7-R8, en fin de liste). C'était une erreur d'appréciation : en
> décor d'entreprise, ce n'est pas un manque de fidélité mais un
> **résultat faux** — un opérateur qui teste sa segmentation conclura
> que sa règle ne protège pas sa base, alors qu'aucun flux n'existe. Les
> lots réseau remontent (voir §5).

Ce qui manque, par ordre de dépendance :

1. **Résolution TNS** — `tnsnames.ora` est lu par `sqlplus` ; RMAN ne
   s'y branche pas. Le sous-système existe (`oracle/listener/`,
   `oracle/network/`), il faut l'atteindre, pas le réécrire.
2. **Une vraie connexion** target / auxiliary / catalog, chacune sur sa
   session, comptable sur le fil.
3. **Le transfert des pièces** entre sites — c'est ce qui donne son sens
   à `DUPLICATE … FROM ACTIVE DATABASE` et au catalogue distant.

---

## 5. Ce que je recommande, et dans quel ordre

L'ordre n'est pas négociable : chaque lot a besoin du précédent.

| # | Lot | Pile | Pourquoi ici |
|---|---|---|---|
| **R1** | ~~**Sérialiser un tablespace** vers son `.dbf` et le relire~~ **FAIT** | applicative | rien de crédible n'est possible avant ; c'est le lot qui transforme RMAN d'animation en outil |
| **R2** | ~~`BACKUP` **lit** les fichiers, `RESTORE` les **réécrit**~~ **FAIT** — la sonde du §1 est verte | RMAN | le premier lot où la sonde du §1 devient verte |
| **R3** | ~~`SHUTDOWN`/`STARTUP` **dans** RMAN~~ **FAIT** — plus `ALTER DATABASE OPEN` et `SQL '...'` ; restent `SWITCH DATAFILE` et `RESET DATABASE`, qui appartiennent au lot des incarnations (R5) | applicative | sans eux, R2 n'est pas jouable comme un vrai opérateur le joue |
| **R4** | ~~**ARCHIVELOG** : mode, écriture du redo, `V$ARCHIVED_LOG`, `LOG SWITCH`~~ **FAIT** — une ligne écrite après la sauvegarde revient par `RECOVER` | applicative | ouvre le PITR, `BACKUP ARCHIVELOG`, `RECOVER UNTIL` |
| **R4b** | ~~La limite nommée de R4 : le journal portait un **instantané** au switch, pas un flux de **vecteurs de changement**~~ **FAIT** — `COMMIT` rend son journal d'annulation, l'exécuteur l'estampille du SCN, le switch le vide dans le `.arc`, `RECOVER` le rejoue ; la granularité de `UNTIL SCN` descend à la transaction | applicative | c'est ce qui rend le PITR réel plutôt que quantifié au switch |
| **R5** | ~~Fichier de contrôle réel + autobackup + `RESTORE CONTROLFILE`~~ **FAIT** — la reprise depuis rien fonctionne, control file ET répertoire RMAN perdus ; restent `SWITCH DATAFILE` et `RESET DATABASE` (incarnations) | applicative | ouvre la reprise depuis rien |
| **R5b** | ~~La limite nommée de R5 : une base fraîche n'avait qu'une **bannière** dans son fichier de contrôle~~ **FAIT** — plus le §6 mesuré à côté : `V$CONTROLFILE_RECORD_SECTION.RECORDS_USED` valait `RECORDS_TOTAL/10` et contredisait `V$DATAFILE` ; chaque section délègue désormais à la vue qui énumère ses enregistrements | applicative | le fichier de contrôle devient la trace de la structure, pas seulement du répertoire RMAN |
| **R6** | ~~FRA réelle : `V$RECOVERY_FILE_DEST`, nom OMF, propriété `oracle`, quota, substitutions de FORMAT, vues V$ alimentées~~ **FAIT** | OS | petit lot, forte fidélité |
| **R7** | ~~`CONNECT TARGET …@tns` **sur le fil**~~ **FAIT** — plus R7b : les sept accesseurs d'une cible distante posent leur question au lieu de lire l'objet du pair | réseau | referme la violation du §4 |
| **R8a** | ~~**Transfert des pièces entre sites**~~ **FAIT** — NFSv3 réel (XDR, ONC RPC, portmap, mountd, nfsd) plus son branchement : une pièce écrite sous un montage réseau est sur le disque du SERVEUR | réseau | ferme [G]/[H], la dernière violation du §4 sur le chemin de sauvegarde |
| **R8b** | ~~Catalogue distant (`CONNECT CATALOG`) et `DUPLICATE`~~ **FAIT** — le catalogue est un jeu de tables `RC_` dans la base que `CONNECT CATALOG` a résolue, et `DUPLICATE` écrit par le VFS de la machine auxiliaire | réseau | le laboratoire DR est complet |

### 5.0 Lot R2b — la cible distante (fermé)

Une fois R1/R2 en place, la question « et sur TCP/IP ? » a trouvé trois
défauts, mesurés dans le laboratoire routeur + pare-feu
(`src/__tests__/support/rmanLab.ts`) :

```
ORA-PROD ── R-CORE (Cisco) ── FGT-DC (FortiGate) ── ORA-DR
10.10.10.10    .1 / 10.10.30.1    .2 / 10.10.20.1    10.10.20.20
```

| porte | annonçait | écrivait |
|---|---|---|
| `CONNECT TARGET @DR` | DBID de DR (juste) | FRA de **PROD** |
| `rman target …@DR` | DBID de **PROD** | FRA de **PROD** |
| `rman target …@injoignable` | rien | FRA de **PROD** |

Le troisième est le pire : la cible étant jetée (`connect(_target?)` ne
lisait pas son paramètre), rien ne pouvait échouer, et un opérateur au
lien coupé croyait sauvegarder son site distant.

Fermé par **un seul mécanisme** : `LinuxRmanContext.forTarget` résout un
identifiant en contexte de la machine cible, et `RetargetableRmanContext`
échange la cible courante — les deux portes passant déjà par
`connectTarget`, elles en bénéficient ensemble. Catalogue et
configuration suivent le device résolu.

**Ce que le fil porte, mesuré :** `tcpdump -i eth0` sur ORA-PROD montre
la vraie poignée de main à travers le routeur et le pare-feu —
`10.10.10.10.32768 > 10.10.20.20.1521 Flags [S]`, `[S.]`, `[.]`, puis un
`[P.]` de 36 octets du listener.

**Limite nommée, pas contournée :** la différence de trames entre
`CONNECT` seul et `CONNECT + BACKUP` est nulle. Que les DONNÉES ne
traversent pas est correct — un vrai RMAN fait écrire la pièce par le
processus serveur de la cible, sur le disque de la cible. Mais
l'aller-retour de la COMMANDE n'est pas tramé non plus, exactement comme
`SQLPlusSession` le documente déjà pour `sqlplus`.

**Tous les tests RMAN vivent désormais dans ce laboratoire** — sept
fichiers migrés, plus aucun ne démarre un `LinuxServer` nu.

### 5.1 Ordre révisé après la mesure en infrastructure (§4.1)

Les deux pistes sont **indépendantes** — R7 n'a pas besoin que les
fichiers de données aient un contenu — et elles ne répondent pas à la
même question :

- **R1 → R2** répond à « une sauvegarde restaure-t-elle ? ». C'est le
  socle : sans lui, RMAN est une animation.
- **R7 → R8** répond à « ce que je vois est-il vrai ? ». C'est plus
  urgent qu'estimé : aujourd'hui un opérateur qui ferme son pare-feu et
  voit RMAN se connecter quand même en tire une conclusion FAUSSE sur sa
  segmentation, et c'est le genre d'erreur qu'un simulateur pédagogique
  ne doit pas enseigner.

**Recommandation : R7 d'abord, puis R1+R2.** R7 est petit — il s'agit de
lire les arguments que `ConnectCommand` jette et de passer par la pile
TNS qui existe déjà — et il supprime un résultat faux. R1+R2 sont plus
gros et transforment RMAN en outil.

---

## 6. Ce que je n'ai pas pu établir

`docs.oracle.com` est **bloqué par le proxy de sortie** de cet
environnement — comme `cisco.com`, `support.huawei.com`,
`docs.fortinet.com` (voir les entrées correspondantes de `TODO.md`).

Ne sont donc **pas** sourcés, et devront l'être avant d'être implantés :

- le format exact d'une pièce de sauvegarde (il n'a pas à être imité
  octet pour octet, mais sa STRUCTURE — en-tête, jeu de blocs, somme de
  contrôle — décide de ce que `VALIDATE` peut vérifier) ;
- la nomenclature `%U`/`%d_%T_%s_%p` des noms de pièces ;
- les seuils exacts de `REPORT NEED BACKUP` / `REPORT OBSOLETE` ;
- le comportement précis de `RECOVER` quand il manque un archivelog.

Pour chacun, la règle du §8 s'applique : une transcription capturée sur
une vraie base vaut mieux qu'une documentation, et mieux vaut ne pas
implanter que deviner.

---

## 7. En une phrase

**État à l'ouverture de cet assessment :** l'architecture RMAN est en
place et bien faite ; ce qui manque n'est pas dans RMAN mais **sous**
lui — une base dont les fichiers contiennent quelque chose — et **à
côté** de lui — un réseau que ses connexions traversent vraiment.

**État après R1 → R8b.** Les deux manques sont fermés. Les fichiers de
données portent les octets de leurs tablespaces, une sauvegarde les lit
et une restauration les réécrit ; et le réseau est traversé pour de vrai,
de la poignée de main TNS jusqu'à l'aller-retour de chaque commande.

Le tableau du §5 n'a plus de ligne ouverte.

### 5.2 Lot NFS — le montage réseau porte vraiment les octets (fermé)

Le transfert des pièces entre sites (item 3 du lot R8) n'était pas un
manque de RMAN mais une couche plus bas. `PRD-Pannes.md` le disait en
toutes lettres : **« aucun protocole NFS n'est implanté »**. Conséquence
mesurée dans le laboratoire routeur + pare-feu :

| | avant | après |
|---|---|---|
| `exportfs -a` | `command not found` | silencieux, comme le vrai |
| `systemctl start nfs-kernel-server` | `Unit not found` | démarre |
| `ss -ltn` sur le serveur | rien sur 111/2049/20048 | les trois écoutent |
| `showmount -e <serveur>` | `command not found` | `Export list for …` |
| `mount -t nfs <serveur>:/srv/absent` | `rc=0` | `mount.nfs: … No such file or directory` |
| `echo X > /mnt/backup_nfs/f` puis `cat` **sur le serveur** | `No such file or directory` | `X` |
| `BACKUP … FORMAT '/mnt/backup_nfs/%U'` | pièce dans la FRA **locale** | `piece handle=/mnt/backup_nfs/…`, présente sur le serveur |

**L'autorité.** NFS est un standard ouvert adopté, donc les RFC sont bien
la référence (RFC 1813, 5531, 4506, 1833 ; 2049 et 111 à l'IANA). Leur
texte est **injoignable** depuis la machine de développement — le
mandataire refuse rfc-editor.org, ietf.org, datatracker.ietf.org,
tools.ietf.org, et les miroirs hjp.at et freesoft.org. Les nombres et la
disposition viennent donc de l'implantation de référence, qui est
joignable et qui *est* ce que le fil porte : `include/uapi/linux/nfs3.h`,
`include/uapi/linux/nfs.h`, `include/linux/sunrpc/msg_prot.h`, et
`fs/nfsd/nfs3xdr.c` pour la disposition exacte (fattr3 en 21 unités XDR,
wcc_attr en 6).

**Le point étroit.** `RemoteMountPort` dans le VFS, jumeau de
`setReadOnlyResolver` : le VFS ne connaît pas le réseau, il connaît un
port. C'est ce qui fait que `cat`, `echo >`, `ls`, `mv`, `rm` **et**
l'écriture de pièce de RMAN traversent tous le fil sans qu'aucun d'eux
n'ait été touché.

**Trouvé en chemin, et fermé.** `FORMAT "…"` entre guillemets doubles
était accepté et silencieusement ignoré — la sauvegarde partait dans la
FRA sous un autre nom que celui demandé (§6). `TAG` et `KEEP UNTIL TIME`
avaient le même défaut.

### 5.3 Lot R8b — le catalogue est une vraie base, DUPLICATE écrit vraiment (fermé)

`RecoveryCatalogCommands.ts` le disait en en-tête : *« accepted as
no-ops »*, *« we just echo the canonical success line »*. Mesure dans le
laboratoire routeur + pare-feu :

| | avant | après |
|---|---|---|
| `CONNECT CATALOG …@10.99.99.99/NEXISTEPAS` | `connected to recovery catalog database` | `RMAN-04004: … ORA-12545` |
| `CONNECT CATALOG …@10.10.20.20/ORCL` | la **même** phrase | connecté |
| `CREATE CATALOG` sans connexion | `recovery catalog created` | `RMAN-06171` |
| `CREATE CATALOG` puis `SELECT table_name … LIKE 'RC%'` **sur le serveur** | `no rows selected` | `RC_DATABASE`, `RC_BACKUP_SET` |
| `REGISTER DATABASE` deux fois | deux succès | `RMAN-20002` la seconde fois |
| `BACKUP` sous catalogue, puis `SELECT COUNT(*) FROM rc_backup_set` | table inexistante | la sauvegarde y est |
| `CONNECT AUXILIARY …@10.99.99.99` | `connected to auxiliary database: ORCL` (la base **locale**) | `RMAN-04006: … ORA-12545` |
| `DUPLICATE TARGET DATABASE TO DUPDB` | quatre fichiers annoncés, aucun écrit nulle part | écrits dans `/u01/…/DUPDB/` **sur la machine auxiliaire** |

**L'autorité** pour les deux codes vient de transcriptions capturées :
`RMAN-04004: error from recovery catalog database: ORA-…` et
`RMAN-04006: error from auxiliary database: ORA-…`. La documentation
Oracle reste injoignable depuis la machine de développement.

**Le §1 a décidé de la forme.** `CONNECT CATALOG` passe par le même
`resolveOracleConnectTarget` que `CONNECT TARGET` depuis R2b — pas un
second client Oracle Net. `RemoteRecoveryCatalog` est une seconde
implantation d'`IRmanCatalogRepository`, l'interface que le moteur
consommait déjà.

**Limite, et elle n'est pas neuve.** Une fois la connexion établie et
comptée sur le fil, les ordres SQL s'exécutent contre l'objet
`OracleDatabase` résolu ; ils ne repartent pas en paquets de données
Oracle Net. C'est le comportement de `sqlplus user/pass@hôte` dans ce
dépôt depuis toujours, repris par R2b. Rendre le plan de données
d'Oracle Net réel est un lot à lui seul, et il concernerait sqlplus
autant que RMAN.

### 5.4 Lot R7 — la commande traverse le fil, pas seulement la connexion (fermé)

La §5.0 avait fermé la CIBLE (le bon DBID, la bonne FRA, un lien coupé
qui refuse) et nommé ce qu'elle laissait ouvert :

> la différence de trames entre `CONNECT` seul et `CONNECT + BACKUP` est
> nulle […] l'aller-retour de la **commande** n'est pas tramé non plus.

**Mesuré sur une commande qui ne transporte aucune donnée**, pour lever
l'ambiguïté avec `BACKUP` — dont les octets ne *doivent* pas traverser :

```
CONNECT seul                   9 trames
CONNECT + SQL '...'            8      différence  -1
CONNECT + REPORT SCHEMA        8      différence  -1
CONNECT + BACKUP DATABASE      8      différence  -1
```

Le `-1` est le bruit d'un ARP que seule la première résolution paie.
Autrement dit **zéro** : `REPORT SCHEMA` lisait le schéma de la cible
sur l'objet du pair.

**Le port existait déjà.** `resolveOracleConnectTarget` — que RMAN
appelle depuis toujours — rend `{ db, remote, session, descriptor }`, où
`session` est une vraie `OracleNetSession` ouverte à travers routeur et
pare-feu. RMAN lisait `db` et **jetait `session`** ; `SQLPlusSession`, sur
la même fonction, la garde. R7 n'était donc pas à écrire : c'était un
port étroit à brancher.

Trois choses que la mesure a imposées, dans cet ordre :

1. **Les identifiants n'étaient lus par personne.** Les trois portes
   (`CONNECT TARGET`, `rman target …`, `CONNECT CATALOG`/`AUXILIARY`)
   n'extrayaient que ce qui suit le `@`. Le serveur a refusé le `Logon`
   (`ORA-01017`) — c'est la mesure qui l'a montré, pas la lecture. Un
   mot de passe **faux** valait donc un mot de passe juste.
2. **Le rôle dépend de la porte** : TARGET et AUXILIARY ouvrent une
   session SYSDBA, CATALOG non.
3. **Les accesseurs demandent** (lot R7b). Chacun interroge la vue qui
   porte son fait — `V$DATAFILE`, `V$DATABASE`, `V$INSTANCE`,
   `V$PARAMETER`, `V$CONTROLFILE`, `V$ARCHIVED_LOG`,
   `V$RECOVERY_FILE_DEST` — par un port unique.

**Pourquoi le compte de trames, et pas le contenu.** `forTarget`
construit le contexte *sur* la machine cible : `getCurrentScn()` rendait
déjà le **bon** SCN, celui de DR. La valeur était juste ; c'est le moyen
qui ne l'était pas. Un témoin de contenu n'aurait rien distingué — le
piège exact que CLAUDE.md §4 décrit. Après :

```
getDatafiles / getCurrentScn / getInstanceState / getSpfileParam
getControlFilePaths / getArchivelogPaths / getRecoveryAreaUsedBytes
                               0 trame  →  2 trames chacun
```

**Contre-témoin, qui compte autant** : une cible **locale** continue à ne
mettre *rien* sur le fil. Une connexion bequeath n'a aucun réseau à
traverser, et tout router serait le défaut symétrique.

**Trois tests épinglaient le défaut**, corrigés en le disant :
`oracle-rman-remote-target` exigeait que la différence de trames soit
**nulle** ; `oracle-rman-catalogue-distant` se passait d'un compte `rman`
sur la base distante et cherchait les tables `RC_` dans le schéma de SYS
— les deux ne tenaient que parce que rien n'authentifiait.

Non-régression : `src/__tests__/audit/rman-accesseurs-distants-preuves.test.ts`
(6 cas discriminants sur 9).
