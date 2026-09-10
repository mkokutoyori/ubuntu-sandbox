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

La table ne revient pas. Et elle ne pouvait pas revenir, pour une raison
qui n'est ni un bug ni un oubli mais un **choix de représentation** :

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

**Trois écarts, tous petits :**

1. **La pièce de sauvegarde appartient à `root:root`** alors que le
   fichier de données appartient à `oracle:oinstall`. Un vrai RMAN écrit
   sous l'utilisateur `oracle`. Défaut d'une ligne, mais c'est le genre
   d'incohérence que le §3 de `CLAUDE.md` traque.
2. **La FRA est vide** — la pièce part dans `/u01/backup` alors que
   `db_recovery_file_dest` la désigne. `V$RECOVERY_FILE_DEST`, le quota
   et `%U`/`%d_%T_%s` n'existent pas.
3. **Pas de `chown`/permissions vérifiés à l'écriture** : rien ne dit
   qu'un RMAN lancé par un utilisateur sans droit serait refusé.

---

## 4. Pile RÉSEAU — la plus éloignée, et la plus contraire aux règles

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
| **R1** | **Sérialiser un tablespace** vers son `.dbf` et le relire | applicative | rien de crédible n'est possible avant ; c'est le lot qui transforme RMAN d'animation en outil |
| **R2** | `BACKUP` **lit** les fichiers, `RESTORE` les **réécrit** ; le cycle *sauvegarder / détruire / restaurer* referme la boucle | RMAN | le premier lot où la sonde du §1 devient verte |
| **R3** | `SHUTDOWN`/`STARTUP` **dans** RMAN | applicative | sans eux, R2 n'est pas jouable comme un vrai opérateur le joue |
| **R4** | **ARCHIVELOG** : mode, écriture du redo, `V$ARCHIVED_LOG`, `LOG SWITCH` | applicative | ouvre le PITR, `BACKUP ARCHIVELOG`, `RECOVER UNTIL` |
| **R5** | Fichier de contrôle réel + autobackup + `RESTORE CONTROLFILE` | applicative | ouvre la reprise depuis rien |
| **R6** | FRA réelle : quota, `%U`, `V$RECOVERY_FILE_DEST`, propriété `oracle` | OS | petit lot, forte fidélité |
| **R7** | `CONNECT TARGET …@tns` **sur le fil** | réseau | referme la violation du §4 |
| **R8** | Catalogue distant, `DUPLICATE`, transfert des pièces entre sites | réseau | le laboratoire DR devient réel |

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

L'architecture RMAN est en place et bien faite ; ce qui manque n'est pas
dans RMAN mais **sous** lui — une base dont les fichiers contiennent
quelque chose — et **à côté** de lui — un réseau que ses connexions
traversent vraiment.
