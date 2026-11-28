# Sauvegarder et restaurer Oracle avec RMAN — un parcours guidé dans l'entreprise « Lumière Boutique »

> **Ce tutoriel est fait pour toi qui débutes.** Tu n'as besoin de rien savoir : ni administration de bases de données, ni Oracle, ni RMAN, ni même le terminal Linux. On part de zéro, on avance par petites marches, et à la fin tu sais **réparer une base Oracle après une panne**.

> **Ce tutoriel n'a pas été écrit à la main.** Chaque bloc de sortie est la réponse **réelle** du simulateur, capturée en rejouant toutes les commandes sur le lab rouvert depuis `labs/ecommerce-lumiere/topology.json`. Un test (`src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts`) refait ce parcours à chaque modification du simulateur : si une commande cessait de produire ce que le tutoriel annonce, il échouerait. Les dates, les numéros de séquence et les noms de pièces changent d'une exécution à l'autre ; la structure, elle, ne change pas.

---

## Comment utiliser ce tutoriel

### Le parcours en cinq niveaux

| Niveau | Tu vas… | Chapitres | Temps indicatif |
|---|---|---|---|
| **1 · Découvrir** | Comprendre ce qu'est une base Oracle, ce qu'on y protège, et pourquoi | 1 à 3 | 1 h |
| **2 · Préparer et sauvegarder** | Mettre la base en état d'être sauvegardée, configurer RMAN, faire, planifier et **vérifier** tes sauvegardes | 4 à 9 | 2 h 30 |
| **3 · Réparer** | Vivre trois pannes (un fichier perdu, le « sommaire » perdu, une erreur humaine) et les réparer | 10 à 12 | 2 h |
| **4 · Protéger** | Contrôler qui a le droit de sauvegarder, puis survivre à la perte d'un site entier | 13 et 14 | 1 h 30 |
| **5 · T'entraîner** | Choisir la bonne réparation, t'exercer, consulter les erreurs courantes et l'aide-mémoire, t'auto-évaluer | 15 à 20 | à ton rythme |

Chaque chapitre se lit **dans l'ordre** : les pannes du niveau 3 supposent les sauvegardes du niveau 2.

### Comment chaque chapitre est construit

Tous les chapitres de manipulation suivent **le même plan**, pour que tu saches toujours où tu es :

| Repère | Ce que tu y trouves |
|---|---|
| 🎯 **Objectif** | Ce que tu sauras faire à la fin du chapitre — et **pourquoi** c'est utile |
| 🧠 **Comprendre** | L'idée, expliquée d'abord **sans commande**, avec une image ou un exemple |
| 🔧 **Manipuler** | Les commandes à taper, **dans l'ordre**, avec ce qu'elles font |
| 👀 **Lire la sortie** | Comment lire la réponse **ligne par ligne** : quelles lignes comptent, lesquelles sont du décor |
| ⚠️ **Piège** | L'erreur que font presque tous les débutants à cet endroit |
| ✅ **À retenir** | Une à trois phrases à garder en tête |
| 🧪 **Vérifie-toi** | Deux ou trois questions pour contrôler que tu as compris (réponses repliées) |

Les chapitres de panne (10 à 12, puis 14) ont un fil encore plus régulier : **situation → diagnostic → plan → réparation → vérification → leçon**. C'est exactement la démarche d'un administrateur de base de données de garde.

### Les conventions des blocs de code

L'**invite** (le début de ligne) te dit **qui** tape et **où** :

- `[oracle@ora-prd ~]$` : l'utilisateur `oracle`, dans le terminal de la machine `ORA-PRD` ;
- `[root@bkp-hq ~]#` : l'administrateur `root`, dans le terminal de `BKP-HQ` ;
- `SQL>` : une session **SQL\*Plus** (`sqlplus / as sysdba`) ;
- `RMAN>` : une session **RMAN** (`rman target /`).

Ce que tu tapes suit l'invite ; **le reste est la réponse**. Les dates et numéros changent chez toi : c'est normal.

> 💡 **Pas de panique.** Tu ne peux rien casser : si tu te perds ou si une manipulation tourne mal, réimporte `topology.json` (chapitre 3) et tu repars d'un lab neuf.

---

## Table des matières

1. [Les bases — pour partir vraiment de zéro](#1-les-bases--pour-partir-vraiment-de-zéro)
2. [L'entreprise et ses trois mauvais lundis](#2-lentreprise-et-ses-trois-mauvais-lundis)
3. [Le lab : l'entreprise dans ton navigateur](#3-le-lab--lentreprise-dans-ton-navigateur)
4. [Reconnaissance : qu'est-ce qu'on protège ?](#4-reconnaissance--quest-ce-quon-protège-)
5. [Préparer la base : le mode ARCHIVELOG](#5-préparer-la-base--le-mode-archivelog)
6. [Configurer RMAN une bonne fois pour toutes](#6-configurer-rman-une-bonne-fois-pour-toutes)
7. [La première sauvegarde](#7-la-première-sauvegarde)
8. [Une stratégie : niveau 0, niveau 1, journaux, cron](#8-une-stratégie--niveau-0-niveau-1-journaux-cron)
9. [Vérifier : une sauvegarde non testée n'existe pas](#9-vérifier--une-sauvegarde-non-testée-nexiste-pas)
10. [Panne n° 1 — Un fichier de données disparaît](#10-panne-n-1--un-fichier-de-données-disparaît)
11. [Panne n° 2 — Les fichiers de contrôle disparaissent](#11-panne-n-2--les-fichiers-de-contrôle-disparaissent)
12. [Panne n° 3 — Un `DROP TABLE` en production : retour dans le temps](#12-panne-n-3--un-drop-table-en-production--retour-dans-le-temps)
13. [Qui a le droit de sauvegarder ? Accès, audit et journaux](#13-qui-a-le-droit-de-sauvegarder--accès-audit-et-journaux)
14. [Panne n° 4 — Le siège brûle : le site de reprise](#14-panne-n-4--le-siège-brûle--le-site-de-reprise)
15. [Que faire quand ? L'arbre de décision](#15-que-faire-quand--larbre-de-décision)
16. [Exercices](#16-exercices)
17. [Les erreurs que tu rencontreras](#17-les-erreurs-que-tu-rencontreras)
18. [Aide-mémoire](#18-aide-mémoire)
19. [Ce que le simulateur fait comme Oracle — et ce qu'il ne fait pas](#19-ce-que-le-simulateur-fait-comme-oracle--et-ce-quil-ne-fait-pas)
20. [Conclusion](#20-conclusion)

---

## 1. Les bases — pour partir vraiment de zéro

> 🎯 **Objectif** — Comprendre, avec des mots simples, ce qu'est une base de données Oracle, de quoi elle est faite, et comment on lui parle. Tu n'as besoin de **rien d'autre** pour suivre le reste. Si tu connais déjà instance, datafile et `ARCHIVELOG`, saute au chapitre 2.

### 1.1 Une base de données, c'est quoi ?

🧠 **Comprendre.** Une **base de données** est un endroit organisé où un programme range des informations pour les retrouver vite et sans les perdre. Celle de Lumière Boutique contient les **clients**, les **produits**, les **commandes** et les **paiements** de la boutique.

L'information y est rangée dans des **tables**, comme des feuilles de tableur :

- une **table** = un sujet (les clients, les commandes…) ;
- une **ligne** = un élément (un client, une commande) ;
- une **colonne** = une caractéristique (le nom, la ville, le montant).

On parle à une base dans un langage qui s'appelle **SQL** : on lui **pose des questions** (`SELECT`), on lui **ajoute** des lignes (`INSERT`), on les **modifie** (`UPDATE`), on les **supprime** (`DELETE`).

🔧 **Manipuler.** Les trois premiers clients de la boutique :

```
SQL> SELECT customer_id, full_name, city FROM shop.customers WHERE ROWNUM <= 3;
CUSTOMER_ID FULL_NAME   CITY
----------- ----------- -------
          1 Awa Ndiaye  Douala
          2 Paul Mbarga Yaounde
          3 Lea Dupont  Paris

3 rows selected.
```

> 💡 **Deux conventions de ce tutoriel.** `WHERE ROWNUM <= 3` veut dire *« ne garde que les 3 premières lignes »* (`ROWNUM` est le numéro de ligne que fournit Oracle). Et quand un bloc contient **plusieurs commandes**, il les affiche d'abord, puis tous leurs résultats **dans le même ordre**.

👀 **Lire la sortie.** La première ligne, c'est ce que tu as demandé : *« donne-moi ces colonnes, dans la table `customers` du **schéma** `shop` »*. Un **schéma** est le « dossier » d'un utilisateur de la base : `shop` est le compte de l'application de la boutique. Ensuite, la réponse est un petit tableau (une ligne par client), puis un compte rendu (`3 rows selected.`).

✅ **À retenir.** Une base de données n'est pas un fichier que l'on ouvre avec un éditeur : c'est un **logiciel** (ici **Oracle**) qui gère des fichiers pour toi, protège les données quand plusieurs personnes écrivent en même temps, et sait refaire le travail après une panne. Ce tutoriel t'apprend à **lui faire survivre aux pannes**.

### 1.2 Oracle : une instance, une base, des fichiers

🧠 **Comprendre.** Quand on dit « la base Oracle », on parle en fait de **deux choses** :

| Terme | Ce que c'est | Où ça vit |
|---|---|---|
| **La base** (*database*) | Les **fichiers** sur le disque : les données et leurs journaux | Disque |
| **L'instance** | Les **programmes en cours d'exécution** et leur mémoire, qui ouvrent la base et répondent aux utilisateurs | Mémoire et processus |

Une image : la base est **un livre rangé dans une bibliothèque** ; l'instance est **le bibliothécaire**. On peut renvoyer le bibliothécaire chez lui : le livre reste sur l'étagère. On peut aussi faire venir le bibliothécaire sans ouvrir le livre. D'où les quatre **états** que tu verras partout :

| État de l'instance | Ce qui est fait | À quoi ça sert |
|---|---|---|
| `SHUTDOWN` | Rien ne tourne | Maintenance |
| `NOMOUNT` | Le bibliothécaire est là, **aucun fichier** n'est lu | Reconstruire le sommaire (chapitre 11) |
| `MOUNT` | Le **sommaire** (le *fichier de contrôle*) est lu : on sait où est chaque fichier, sans les ouvrir | **Restaurer** des fichiers (chapitre 10) |
| `OPEN` | Les fichiers de données sont ouverts : les utilisateurs travaillent | Fonctionnement normal |

🔧 **Manipuler.** L'instance et la base se voient par deux **vues** (une vue est une « table » que la base tient à jour elle-même pour parler d'elle) :

```
SQL> SELECT instance_name, status FROM v$instance;
SQL> SELECT name, open_mode FROM v$database;
INSTANCE_NAME STATUS
------------- ------
ORCL          OPEN

1 row selected.

NAME OPEN_MODE
---- ----------
ORCL READ WRITE

1 row selected.
```

👀 **Lire la sortie.** `STATUS OPEN` : l'instance a ouvert la base. `OPEN_MODE READ WRITE` : on peut lire **et** écrire. Dans Linux, l'instance est **un ensemble de processus**, chacun avec un métier :

```
[oracle@ora-prd ~]$ ps -ef | grep ora_ | grep -v grep
oracle        45       1  0 12:44 ?        00:00:00 ora_pmon_orcl
oracle        46       1  0 12:44 ?        00:00:00 ora_smon_orcl
oracle        47       1  0 12:44 ?        00:00:00 ora_dbw0_orcl
oracle        48       1  0 12:44 ?        00:00:00 ora_lgwr_orcl
oracle        49       1  0 12:44 ?        00:00:00 ora_ckpt_orcl
oracle        50       1  0 12:44 ?        00:00:00 ora_reco_orcl
oracle        51       1  0 12:44 ?        00:00:00 ora_mmon_orcl
oracle        52       1  0 12:44 ?        00:00:00 ora_mmnl_orcl
```

`pmon` surveille les sessions, `smon` répare après un arrêt brutal, `dbw` écrit les données sur le disque, `lgwr` écrit le **journal** des modifications, `ckpt` marque les points de contrôle. Tu n'as pas à retenir ces noms : retiens qu'**une instance = des processus** qu'on voit avec `ps`.

Les **fichiers** de la base sont de quatre sortes, et la suite du tutoriel ne parle que d'eux :

| Fichier | Contenu | Pourquoi on s'en soucie |
|---|---|---|
| **Fichiers de données** (*datafiles*, `.dbf`) | Les tables et les index | C'est **ce qu'on sauvegarde** et ce qui peut disparaître |
| **Journaux de reprise** (*redo logs*) | La liste de **tous les changements**, dans l'ordre | Ils permettent de **rejouer** le travail fait depuis la dernière sauvegarde |
| **Fichiers de contrôle** (*control files*) | Le « sommaire » : où sont les fichiers, l'état de la base, **l'historique des sauvegardes** | Sans lui, la base ne démarre pas |
| **Journaux archivés** (*archived logs*) | Les copies des journaux de reprise, **rangées au lieu d'être écrasées** | Ils permettent de revenir **jusqu'à la dernière transaction** |

Un **tablespace** est un regroupement logique de fichiers de données (« l'étagère » où l'on range des tables). Chez Lumière : `SHOP_DATA` (les tables) et `SHOP_IDX` (les index, qui accélèrent les recherches).

✅ **À retenir.** *Instance* = les programmes ; *base* = les fichiers. Quatre sortes de fichiers : **données, journaux, contrôle, journaux archivés**.

### 1.3 Le terminal Linux : dix commandes suffisent

🧠 **Comprendre.** Les serveurs Oracle tournent sous **Linux**. Tu les pilotes dans un **terminal** : tu tapes une commande après l'**invite**, tu lis la réponse.

```
[oracle@ora-prd ~]$ 
  │       │      │  └─ $ = utilisateur ordinaire    # = administrateur (root)
  │       │      └──── ~ = ton dossier personnel
  │       └─────────── le nom de la machine (ici ORA-PRD)
  └─────────────────── l'utilisateur connecté
```

| Commande | Ce qu'elle fait |
|---|---|
| `whoami` | Qui suis-je ? |
| `pwd` | Dans quel dossier suis-je ? |
| `ls` / `ls -l` | Liste les fichiers (`-l` : avec propriétaire, taille, date) |
| `cd dossier` | Change de dossier |
| `cat fichier` | Affiche le contenu d'un fichier |
| `mkdir`, `rm`, `cp`, `mv` | Crée un dossier, supprime, copie, déplace |
| `id` | Mon identifiant et mes groupes |
| `su - utilisateur` | Devenir cet utilisateur (`su - oracle`) |
| `sudo commande` | Lancer une commande avec les droits d'administrateur |
| `exit` | Quitter la session courante |

Un **utilisateur** Linux a un numéro (`uid`) et appartient à des **groupes** : ce sont les groupes qui décident de ce qu'on a le droit de faire.

🔧 **Manipuler.** Qui est l'utilisateur **`oracle`** — le propriétaire du logiciel Oracle et des fichiers de la base ?

```
[oracle@ora-prd ~]$ whoami
oracle
[oracle@ora-prd ~]$ pwd
/home/oracle
[oracle@ora-prd ~]$ id
uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba)
[oracle@ora-prd ~]$ ls -l /u01/app/oracle/oradata/ORCL
total 40
-rw-r--r-- 1 oracle oinstall 549 Nov 28 12:44 control01.ctl
-rw-r--r-- 1 oracle oinstall 549 Nov 28 12:44 control02.ctl
-rw-r--r-- 1 oracle oinstall  33 Nov 28 12:44 redo01.log
-rw-r--r-- 1 oracle oinstall  33 Nov 28 12:44 redo02.log
-rw-r--r-- 1 oracle oinstall  33 Nov 28 12:44 redo03.log
-rw-r--r-- 1 oracle oinstall  44 Nov 28 12:44 sysaux01.dbf
-rw-r--r-- 1 oracle oinstall  44 Nov 28 12:44 system01.dbf
-rw-r--r-- 1 oracle oinstall  42 Nov 28 12:44 temp01.dbf
-rw-r--r-- 1 oracle oinstall  42 Nov 28 12:44 undotbs01.dbf
-rw-r--r-- 1 oracle oinstall  43 Nov 28 12:44 users01.dbf
```

👀 **Lire la sortie.** `uid=54321(oracle)` : son numéro. `groups=…(oinstall),…(dba)` : ses groupes. **`dba`** (*database administrators*) est le groupe qui donne le droit de se connecter à la base **comme administrateur, sans mot de passe** (on y revient en 1.4). Plus bas, le contenu du dossier de la base : `.dbf` (données), `.ctl` (contrôle), `redo*.log` (journaux). Les tailles sont minuscules, car le simulateur représente les fichiers : seul leur **rôle** compte.

⚠️ **Piège.** **`root` n'est pas dans le groupe `dba`** : sur une vraie machine Oracle, `root` **ne peut pas** administrer la base. Le lab respecte cette règle :

```
[root@ora-prd ~]# whoami
root
[root@ora-prd ~]# sqlplus -s / as sysdba <<'E'
SELECT 1 FROM dual;
E
ERROR:
ORA-01031: insufficient privileges
```

`ORA-01031: insufficient privileges` : *« tu n'as pas le droit »*. Les erreurs Oracle ont toutes la forme `ORA-` + cinq chiffres ; on apprend à les reconnaître au chapitre 17. **Règle d'or du tutoriel : on administre Oracle en tant qu'`oracle`, jamais en root.**

### 1.4 SQL*Plus : parler à la base

🧠 **Comprendre.** **SQL\*Plus** est le programme en ligne de commande d'Oracle : tu y tapes du SQL, il affiche les réponses. On le lance avec `sqlplus`. La forme que nous utilisons, `sqlplus / as sysdba`, se lit :

- `/` : « ne me demande pas de mot de passe » (le système d'exploitation m'a déjà identifié) ;
- `as sysdba` : « connecte-moi avec le **rôle d'administrateur** » — le plus puissant d'Oracle (démarrer, arrêter, restaurer). Il est réservé aux membres du groupe `dba`.

🔧 **Manipuler.** L'invite devient `SQL>`. Tout ce qui se termine par `;` est envoyé à la base :

```
SQL> SHOW USER
SQL> SELECT 'bonjour' AS message FROM dual;
SQL> SELECT SYSDATE FROM dual;
USER is "SYS"

MESSAGE
-------
bonjour

1 row selected.

SYSDATE
---------
28-NOV-26

1 row selected.
```

👀 **Lire la sortie.** `SHOW USER` n'est pas du SQL : c'est une **commande SQL\*Plus** (pas de `;`). `SELECT 'bonjour' AS message FROM dual;` est du SQL : `dual` est une table spéciale d'**une seule ligne**, utile quand on veut juste calculer une valeur. `SYSDATE` est la date de la base. Pour quitter : `EXIT`.

Tu verras aussi des requêtes sur des noms qui commencent par `v$` ou `dba_` : ce sont les **vues du dictionnaire** (`v$database`, `v$datafile`…). C'est là qu'un administrateur lit l'état de la base.

### 1.5 Pourquoi sauvegarder, et de quoi ?

🧠 **Comprendre.** Une base peut être abîmée de trois façons très différentes, et **chacune demande une réponse différente** :

| Ce qui arrive | Exemple | Ce qui sauve |
|---|---|---|
| **Une panne de fichier** | Un disque lâche, un fichier est effacé | **Restaurer** le fichier depuis une sauvegarde, puis **rejouer** les journaux |
| **Une erreur humaine** | Un `DROP TABLE` en production, un `DELETE` sans `WHERE` | **Revenir dans le temps** à un instant d'avant l'erreur |
| **Un sinistre de site** | Incendie, inondation, panne totale du datacenter | Un **site de reprise** déjà prêt, ailleurs |

Une image pour comprendre le vocabulaire. Imagine que tu écris un livre :

- La **sauvegarde** (*backup*) est une **photocopie** du livre à une date donnée ;
- Les **journaux** sont un **cahier de notes** où tu écris *chaque modification* au moment où tu la fais ;
- **Restaurer** (*restore*) = récupérer la photocopie ;
- **Récupérer** (*recover*) = **rejouer** le cahier de notes sur la photocopie pour la ramener à aujourd'hui.

On **restaure toujours avant de récupérer** : on ne rejoue pas des notes sur un livre qui n'existe plus. C'est **LA** règle de ce tutoriel.

Deux chiffres mesurent une bonne stratégie, **fixés par l'entreprise** (pas par la technique) : le **RPO** (*Recovery Point Objective*) — combien de travail on accepte de **perdre** — et le **RTO** (*Recovery Time Objective*) — combien de temps on accepte d'être **hors service**.

### 1.6 RMAN : l'outil de sauvegarde d'Oracle

🧠 **Comprendre.** **RMAN** (*Recovery Manager*) est le programme livré avec Oracle pour sauvegarder, restaurer et récupérer. On le lance avec `rman target /` (« travaille sur la base **cible** de cette machine »). L'invite devient `RMAN>`.

🔧 **Manipuler.** Premier contact, sans rien casser : on lui demande quelles sauvegardes il connaît.

```
RMAN> LIST BACKUP SUMMARY;
connected to target database: ORCL (DBID=2297484771)

List of Backups
===============
no backup found in the repository
```

👀 **Lire la sortie.** `connected to target database: ORCL (DBID=…)` : RMAN est branché sur la base `ORCL` ; le **DBID** est son identifiant numérique. Puis `no backup found in the repository` : **aucune** sauvegarde, ce qui est normal. L'objectif des chapitres suivants est que cette réponse ne soit plus jamais vide.

💡 **Astuce.** RMAN écrit sa sortie **comme un journal de bord** : chaque ligne dit ce qu'il fait, sur quel fichier, avec quel résultat. Quand quelque chose ne va pas, la cause est dans les **dernières lignes** (`RMAN-` ou `ORA-`).

### 1.7 Glossaire

| Terme | Définition en une phrase |
|---|---|
| **Base de données** | Les fichiers qui contiennent les données (et ce qu'il faut pour les protéger) |
| **Instance** | Les processus et la mémoire d'Oracle, qui ouvrent la base et répondent |
| **Schéma** | L'ensemble des objets d'un utilisateur de la base (`shop`) |
| **SQL / SQL\*Plus** | Le langage pour interroger la base / le programme où on le tape |
| **SYSDBA** | Le rôle d'administrateur de la base ; réservé au groupe `dba` |
| **Vue `V$`** | Une « table » que la base tient à jour pour décrire son propre état |
| **Datafile / tablespace** | Un fichier de données / un regroupement logique de datafiles |
| **Redo log** | Le journal de **tous** les changements, écrit au fil de l'eau |
| **ARCHIVELOG** | Mode où chaque journal plein est **archivé** au lieu d'être écrasé |
| **Fichier de contrôle** | Le sommaire de la base ; sans lui, pas de démarrage |
| **SCN** | Le « numéro d'horloge » de la base : il augmente à chaque changement validé |
| **DBID** | L'identifiant numérique de la base |
| **RMAN** | L'outil de sauvegarde et de restauration d'Oracle |
| **Backup set / pièce** | Le résultat d'une sauvegarde : un ensemble contenant un ou plusieurs fichiers (les pièces) |
| **Niveau 0 / niveau 1** | Sauvegarde complète / sauvegarde de ce qui a changé depuis |
| **Restore / Recover** | Récupérer la copie ancienne / rejouer les changements dessus |
| **RESETLOGS** | Repartir d'une numérotation de journaux neuve après une récupération incomplète |
| **Incarnation** | Une « version de l'histoire » de la base, créée par un `RESETLOGS` |
| **Standby** | Une copie de la base tenue à jour sur un autre site |
| **RPO / RTO** | Perte de données tolérée / durée d'arrêt tolérée |

### 🧪 Vérifie-toi (chapitre 1)

1. Quelle est la différence entre l'**instance** et la **base** ? <details><summary>Réponse</summary>L'instance, ce sont les processus et la mémoire ; la base, ce sont les fichiers sur le disque. On peut arrêter l'instance sans toucher aux fichiers.</details>
2. Pourquoi `root` est-il refusé par `sqlplus / as sysdba` alors qu'`oracle` ne l'est pas ? <details><summary>Réponse</summary>`oracle` est dans le groupe `dba`, pas `root`. La connexion sans mot de passe s'appuie sur ce groupe du système d'exploitation.</details>
3. Complète : « on _____ la photocopie, puis on _____ le cahier de notes ». <details><summary>Réponse</summary>On **restaure** la photocopie (la sauvegarde), puis on **récupère** (on rejoue) le cahier de notes (les journaux).</details>

---

## 2. L'entreprise et ses trois mauvais lundis

> 🎯 **Objectif** — Comprendre **pourquoi** on sauvegarde en donnant un visage aux pannes, et poser les trois chiffres (RPO, RTO, rétention) qui guideront tout le reste. Pas de commande dans ce chapitre.

**Lumière Boutique** vend en ligne de la décoration lumineuse. Son site web tourne sur deux frontaux (`WEB-1`, `WEB-2`) ; les commandes, les clients et les paiements vivent dans **une base Oracle**, `ORCL`, sur le serveur `ORA-PRD` du siège. Si cette base disparaît, la boutique ne vend plus rien : plus de panier, plus de paiement, plus de suivi.

🧠 **Comprendre.** Imagine les trois courriels qu'un administrateur de base peut recevoir **un lundi matin** :

| 📧 De | Sujet | Ce qui est arrivé | Ce qu'il te faut | Chapitre |
|---|---|---|---|---|
| **L'exploitant** | « Un disque a lâché cette nuit » | Un fichier de données (`shop_data01.dbf`) est illisible | **Restaurer** le fichier, **rejouer** les journaux | 10 |
| **Le développeur** | « J'ai supprimé la table des paiements en prod » | Une erreur humaine : base ouverte, saine… mais amputée | **Revenir dans le temps**, juste avant l'erreur | 12 |
| **Le réseau** | « Le siège est hors service » | Tout le site est perdu : serveurs, baies, base | Un **site de reprise** déjà prêt | 14 |

Ces trois histoires sont le **fil rouge** du tutoriel : chacune sera vécue dans le lab, de la panne à la réparation.

Une bonne stratégie répond à trois questions, dont les réponses sont des **décisions d'entreprise** :

| Objectif | La question | Réponse retenue pour Lumière |
|---|---|---|
| **RPO** — perte de données tolérée | Combien de temps de commandes accepte-t-on de perdre ? | **≈ 0** si le siège brûle (la base de reprise reçoit les modifications en continu) ; **≤ 4 h** après une erreur logique (sauvegarde des journaux toutes les 4 h) |
| **RTO** — durée d'arrêt tolérée | Combien de temps la boutique peut-elle être fermée ? | **Quelques minutes** pour basculer sur le site de reprise ; **quelques dizaines de minutes** pour restaurer un fichier |
| **Rétention** | Combien de temps garde-t-on les sauvegardes ? | **7 jours** de fenêtre de récupération |

⚠️ **Piège.** **Une sauvegarde et un site de reprise ne répondent pas à la même question.** Le site de reprise copie *aussi* l'erreur : un `DROP TABLE` est rejoué sur la standby. Seule une **sauvegarde** permet de revenir *avant* l'erreur. Et seul le site de reprise survit à la perte du datacenter *avec* ses sauvegardes. **Il faut les deux.**

✅ **À retenir.** Trois pannes, trois réponses : *restaurer* (fichier perdu), *revenir dans le temps* (erreur humaine), *basculer* (site perdu). RPO = ce qu'on perd ; RTO = combien de temps on attend.

### 🧪 Vérifie-toi (chapitre 2)

1. Un développeur supprime une table par erreur. Le site de reprise peut-il t'aider ? <details><summary>Réponse</summary>Non : il a rejoué la suppression lui aussi. Il faut une sauvegarde et un retour dans le temps.</details>
2. La boutique perd au plus 4 h de commandes si le siège brûle : est-ce un RPO ou un RTO ? <details><summary>Réponse</summary>Un RPO (perte de données tolérée). Le RTO, lui, mesure la durée d'indisponibilité.</details>

---

## 3. Le lab : l'entreprise dans ton navigateur

> 🎯 **Objectif** — Savoir **ouvrir le lab**, repérer les machines qui comptent, et utiliser les terminaux avec la bonne identité. Après ce chapitre, tu es prêt à manipuler.

### 3.1 Les machines

🧠 **Comprendre.** Le lab est un jeu de **35 équipements** — trois constructeurs réseau (Cisco, Huawei, Fortinet) et des serveurs Linux et Windows — construit en tapant les mêmes commandes qu'un administrateur. Le détail est dans `labs/ecommerce-lumiere/README.md` ; voici l'essentiel :

```
        INTERNET (203.0.113.0/24)  ─  R-ISP, DNS public, client web, passerelle de paiement
              │
   ┌──────────┴───────────┐     tunnels IPsec IKEv2 (FortiGate en étoile)
   │                      │
 SIÈGE (HQ)  10.10.0.0/16   ══════════════════►  SITE DE REPRISE (DR)  10.20.0.0/16
 FGT-HQ  ── R-HQ (Cisco)                         FGT-DR  ── R-DR (Huawei)
   ├─ 10.10.10.0/24  DC1 (AD, DNS, DHCP)         ├─ 10.20.10.0/24  DC2 (AD, DNS)
   │                 LOG-HQ (rsyslog, RADIUS)    │
   ├─ 10.10.30.0/24  BASES                       ├─ 10.20.30.0/24  BASES
   │    ORA-PRD   10.10.30.10  ← la base ORCL    │    ORA-STB   10.20.30.10  ← future standby
   │    BKP-HQ    10.10.30.20  ← volume NFS      │    BKP-DR    10.20.30.20  ← volume NFS
   └─ DMZ 172.16.10.0/24  WEB-1, WEB-2, APP-1    └─ DMZ 172.17.10.0/24  WEB-DR
```

| Machine | Son rôle dans ce tutoriel |
|---|---|
| `ORA-PRD` | Le serveur de **production**. Il porte la base `ORCL` (schéma `SHOP` : clients, produits, commandes, paiements) |
| `BKP-HQ` | Le serveur de **sauvegarde**. Il **exporte** `/srv/backup/rman` par le réseau (NFS) ; `ORA-PRD` le monte sur `/backup` |
| `ORA-STB` | Le serveur Oracle du **site de reprise** : il deviendra la **base de secours** (*standby*) de `ORCL` |
| `BKP-DR` | Le volume de sauvegarde du site de reprise |
| `LOG-HQ` | Le serveur de **journaux** : toutes les machines Oracle, sauvegarde et web lui envoient leurs messages |
| `FGT-HQ` / `FGT-DR` | Les pare-feu **FortiGate** qui portent le tunnel IPsec entre les deux sites |

Deux notions réseau suffisent : **NFS** est un protocole qui permet à une machine de **monter** un dossier d'une autre comme s'il était local ; un **tunnel IPsec** est un « tuyau » chiffré entre les deux sites, à travers Internet.

> 🔌 **Un détail de câblage** : un routeur Cisco de ce modèle n'a que **trois interfaces**. `R-HQ` en utilise une vers le pare-feu et **une seule** vers les trois réseaux du siège (serveurs, utilisateurs, bases), qu'il sépare par des **VLAN** : c'est un *routeur sur un bâton* (*router-on-a-stick*), avec trois sous-interfaces `.10`, `.20`, `.30` sur un lien **trunk** dot1Q vers `SW-HQ-SRV`.

> ⚠️ **Règle du projet, et raison pour laquelle ce lab est instructif : tout ce qui circule entre deux machines passe par de vraies trames.** Quand `ORA-PRD` écrit une pièce de sauvegarde sur `/backup`, ce sont des appels NFSv3 qui traversent le câble jusqu'à `BKP-HQ`. Quand on construit la standby, ce sont les octets des fichiers de données qui traversent le tunnel IPsec. Tu pourras le **prouver** (chapitre 7).

### 3.2 Ouvrir le lab

🔧 **Manipuler.**

1. Lance l'application : `npm run dev`, puis ouvre <http://localhost:8080>.
2. Barre d'outils → **Importer** → choisis `labs/ecommerce-lumiere/topology.json`. Les 35 équipements et les 34 câbles se posent, sans avertissement.
3. Double-clique sur `ORA-PRD` pour ouvrir son terminal. **Il s'ouvre en `root`** (invite `#`). Tape `su - oracle` : l'invite devient `[oracle@ora-prd ~]$`. C'est sous cette identité que se joue presque tout le tutoriel ; `exit` te rend `root`.
4. Chaque bloc de code commence par une **invite** qui dit *qui* tape et *sur quelle machine* : suis-la. Un bloc `[root@bkp-hq ~]#` se tape dans le terminal de `BKP-HQ` ; un bloc `[root@ora-prd ~]#` dans celui d'`ORA-PRD`, en root.

👀 **Lire ce que tu vois.** Le fichier d'export est « une machine qui tournait et qui redémarre » : adresses, services, scripts et schéma `SHOP` sont là. **Le montage NFS, lui, est à refaire** : c'est exactement ce qui arrive à un vrai serveur qui démarre sans que le serveur de sauvegarde soit joignable, et c'est la première manipulation du chapitre 4.

💡 **Astuce.** Garde sous la main ce petit rappel : *root pour monter et administrer le système ; oracle pour tout ce qui touche à la base.*

### 3.3 Les cinq notions à retenir

La partie 1 a posé les bases ; voici, en cinq lignes, ce qui servira à lire **toutes** les sorties qui suivent.

| Notion | Ce que c'est | Pourquoi ça compte |
|---|---|---|
| **Datafile / tablespace** | Les fichiers qui contiennent les données | C'est ce qu'on sauvegarde et ce qui peut disparaître |
| **Redo / ARCHIVELOG** | Le journal de toutes les modifications ; en `ARCHIVELOG`, on le **garde** | Sans journaux archivés : restauration seulement **au moment de la sauvegarde**. Avec : **jusqu'à la dernière transaction** |
| **SCN** | Le numéro d'horloge de la base | C'est l'horloge de la récupération : `UNTIL SCN n` |
| **Fichier de contrôle** | Le sommaire (fichiers, journaux, **historique des sauvegardes**) | Le perdre rend la base muette ; RMAN l'**auto-sauvegarde** pour cette raison |
| **Incarnation / RESETLOGS** | Après une récupération *incomplète*, nouvelle numérotation de journaux | **Récupération incomplète ⇒ `OPEN RESETLOGS`** |

Et le vocabulaire RMAN : un **backup set** contient une ou plusieurs **pièces** (les vrais fichiers) ; un **niveau 0** est la base complète (la référence), un **niveau 1** ne contient que ce qui a changé depuis ; le **DBID** est l'identifiant numérique de la base (à noter **avant** le sinistre).

### 🧪 Vérifie-toi (chapitre 3)

1. Sur quelle machine tapes-tu un bloc dont l'invite est `[root@bkp-hq ~]#` ? <details><summary>Réponse</summary>Dans le terminal de `BKP-HQ`, en `root`.</details>
2. Pourquoi les sauvegardes passent-elles par le réseau jusqu'à un **autre** serveur ? <details><summary>Réponse</summary>Une sauvegarde qui meurt avec la machine qu'elle protège ne sert à rien : elle doit vivre ailleurs.</details>

---

## 4. Reconnaissance : qu'est-ce qu'on protège ?

> 🎯 **Objectif** — Avant de protéger quoi que ce soit, **savoir où l'on est et ce qu'on a** : qui tu es, où est le volume de sauvegarde, dans quel état est la base, quel est son DBID, où sont ses fichiers. C'est la même démarche qu'un médecin qui commence par un examen.

### 4.1 Qui suis-je, où suis-je ?

🔧 **Manipuler.** Tu es `oracle` sur `ORA-PRD` (chapitre 3) :

```
[oracle@ora-prd ~]$ id
uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba)
[oracle@ora-prd ~]$ hostname
ora-prd
```

👀 **Lire la sortie.** `uid=54321(oracle)` : le propriétaire des logiciels Oracle, membre du groupe `dba`. `ora-prd` : le nom de la machine. C'est pour cette raison que **tout le tutoriel se joue en `oracle`**.

### 4.2 Monter le volume de sauvegarde

🧠 **Comprendre.** Une sauvegarde doit vivre **hors de la machine qu'elle protège**. Ici, le volume est sur `BKP-HQ` et `ORA-PRD` le **monte** (le fait apparaître) dans le dossier `/backup`. Le montage est **déclaré** dans `/etc/fstab` mais n'est pas actif au démarrage du lab : `mount -a` (en root) monte tout ce qui est déclaré.

🔧 **Manipuler.**

```
[root@ora-prd ~]# mount -a
[root@ora-prd ~]# mount | grep backup
10.10.30.20:/srv/backup/rman on /backup type nfs (rw,relatime)
[root@ora-prd ~]# ls -ldn /backup
drwxrwxr-x 2 54321 54321 4096 Nov 28 12:44 /backup
[root@ora-prd ~]# df -h /backup
Filesystem                    Size  Used Avail Use% Mounted on
10.10.30.20:/srv/backup/rman   48G  8.3M   48G   1% /backup
```

👀 **Lire la sortie.**

- `10.10.30.20:/srv/backup/rman on /backup type nfs` : la **source** est le serveur de sauvegarde `BKP-HQ`, à travers le réseau (type `nfs`) ;
- `drwxrwxr-x 2 54321 54321` : le propriétaire du dossier est le **numéro 54321**, c'est-à-dire l'utilisateur `oracle` *de `BKP-HQ`* ;
- `df -h` : la **taille du volume distant**, lue sur le serveur par NFS (`Size`, `Used`, `Avail`, `Use%`). C'est la première chose qu'on regarde avant une sauvegarde : *y a-t-il de la place ?*

🧠 **Pourquoi le numéro 54321 ?** NFS ne transporte pas des **noms** d'utilisateurs, mais des **numéros**. Pour que `oracle` d'`ORA-PRD` puisse écrire dans un dossier de `BKP-HQ`, il faut le **même numéro** des deux côtés. C'est la raison pour laquelle le lab crée le compte `oracle` (uid 54321) sur `BKP-HQ`.

Un dernier test, en tant qu'`oracle`, que le volume est bien **accessible en écriture** — on crée un fichier, on le date, on attend, on le re-date, on le supprime :

```
[oracle@ora-prd ~]$ touch /backup/ecriture-test
[oracle@ora-prd ~]$ stat -c '%n %y' /backup/ecriture-test
/backup/ecriture-test 2026-11-28 12:44:27.000000000 +0000
[oracle@ora-prd ~]$ sleep 3
[oracle@ora-prd ~]$ touch /backup/ecriture-test
[oracle@ora-prd ~]$ stat -c '%n %y' /backup/ecriture-test
/backup/ecriture-test 2026-11-28 12:44:30.000000000 +0000
[oracle@ora-prd ~]$ rm /backup/ecriture-test
```

👀 **Lire la sortie.** Les deux dates `stat` diffèrent de quelques secondes : `touch` sur un fichier qui existe déjà met sa date à jour **sur le serveur**. Le volume est vivant.

⚠️ **Piège.** Un volume monté **en lecture seule** ou **plein** ne dit rien tant qu'on ne l'utilise pas : on le découvre à la première sauvegarde, c'est-à-dire trop tard. Ce petit test d'écriture se fait **avant**.

### 4.3 L'état de santé de la base

🔧 **Manipuler.** Un script livré avec le lab (`/home/oracle/scripts/health.sql`) résume l'essentiel :

```
SQL> @/home/oracle/scripts/health.sql
NAME LOG_MODE     FORCE_LOGGING OPEN_MODE
---- ------------ ------------- ----------
ORCL NOARCHIVELOG NO            READ WRITE

1 row selected.

TABLESPACE_NAME STATUS
--------------- ------
SHOP_DATA       ONLINE
SHOP_IDX        ONLINE
SYSAUX          ONLINE
SYSTEM          ONLINE
TEMP            ONLINE
UNDOTBS1        ONLINE
USERS           ONLINE

7 rows selected.

COMMANDES
---------
       12

1 row selected.

STATUS  NB MONTANT
------- -- -------
NEW      6   470.2
PAID     3   127.2
SHIPPED  3     343

3 rows selected.
Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
```

👀 **Lire la sortie.** Trois lignes comptent :

- `LOG_MODE NOARCHIVELOG` : les journaux sont **écrasés** quand ils sont pleins. C'est le défaut d'Oracle, et **l'erreur classique** des bases « de test » qui finissent en production. On la corrige au chapitre 5 ;
- les **tablespaces** `SHOP_DATA` et `SHOP_IDX` sont `ONLINE` : les données de la boutique sont accessibles ;
- `COMMANDES 12` et la répartition `NEW` / `PAID` / `SHIPPED` : l'état **actuel** des données. On le comparera après les pannes : c'est notre preuve que la réparation a marché.

### 4.4 Noter le DBID

🧠 **Comprendre.** Le **DBID** est le numéro d'identité de la base. Si tu perds le fichier de contrôle **et** le catalogue de RMAN (chapitre 11), c'est lui qui te permet de retrouver tes sauvegardes automatiques. Il faut donc le **noter ailleurs** que dans la base — dans un coffre, dans le runbook de l'équipe.

🔧 **Manipuler.**

```
SQL> SELECT name, dbid, log_mode, open_mode FROM v$database;
NAME       DBID LOG_MODE     OPEN_MODE
---- ---------- ------------ ----------
ORCL 2297484771 NOARCHIVELOG READ WRITE

1 row selected.
```

👀 **Lire la sortie.** `ORCL` est le nom de la base ; le nombre à côté est le DBID : ici `2297484771`.

✅ **À retenir.** **Note le DBID avant d'en avoir besoin.** Le jour où tu en auras besoin, la base ne pourra plus te le dire.

### 4.5 Où sont les fichiers ?

🔧 **Manipuler.**

```
SQL> SELECT file#, name FROM v$datafile ORDER BY 1;
SQL> SELECT name FROM v$controlfile;
SQL> SELECT group#, members, status FROM v$log;
FILE# NAME
----- --------------------------------------------
    1 /u01/app/oracle/oradata/ORCL/system01.dbf
    2 /u01/app/oracle/oradata/ORCL/sysaux01.dbf
    3 /u01/app/oracle/oradata/ORCL/undotbs01.dbf
    4 /u01/app/oracle/oradata/ORCL/users01.dbf
    5 /u01/app/oracle/oradata/ORCL/shop_data01.dbf
    6 /u01/app/oracle/oradata/ORCL/shop_idx01.dbf

6 rows selected.

NAME
------------------------------------------
/u01/app/oracle/oradata/ORCL/control01.ctl
/u01/app/oracle/oradata/ORCL/control02.ctl

2 rows selected.

GROUP# MEMBERS STATUS
------ ------- -------
     1       1 CURRENT
     2       1 UNUSED
     3       1 UNUSED

3 rows selected.
```

👀 **Lire la sortie.** Trois listes : les **fichiers de données** (`v$datafile` : `shop_data01.dbf`, numéro 5, et `shop_idx01.dbf`, numéro 6, sont ceux de la boutique) ; les **deux fichiers de contrôle** (`control01.ctl`, `control02.ctl` : Oracle les **multiplie** pour qu'on n'en perde pas un seul) ; les **groupes de journaux** (`v$log`). Ce sont ces objets-là que les pannes vont détruire.

### 🧪 Vérifie-toi (chapitre 4)

1. Pourquoi l'utilisateur `oracle` du serveur de sauvegarde doit-il avoir le **même numéro** (54321) que celui d'`ORA-PRD` ? <details><summary>Réponse</summary>NFS identifie les propriétaires par numéro, pas par nom : sans le même numéro, `oracle` d'`ORA-PRD` n'a pas le droit d'écrire sur le volume.</details>
2. Dans quel mode de journalisation la base est-elle livrée, et pourquoi est-ce un problème ? <details><summary>Réponse</summary>`NOARCHIVELOG` : les journaux sont écrasés, on ne peut restaurer qu'au point de la sauvegarde et on ne peut même pas sauvegarder à chaud (chapitre 5).</details>
3. Où note-t-on le DBID ? <details><summary>Réponse</summary>**Hors de la base** : dans le runbook ou le coffre de l'équipe.</details>

---

## 5. Préparer la base : le mode ARCHIVELOG

> 🎯 **Objectif** — Mettre la base en état **d'être sauvegardée sans l'arrêter** et de pouvoir être restaurée **jusqu'à la dernière transaction**. Sans cette préparation, rien de ce qui suit n'est possible. Tu vas d'abord **constater** l'échec, puis le corriger.

### 5.1 Ce qui se passe si on ne le fait pas

🧠 **Comprendre.** Chaque modification est écrite dans un **journal de reprise**. Oracle en tient **trois** (`redo01`, `redo02`, `redo03`), utilisés **à tour de rôle**. Quand le troisième est plein, il repart sur le premier — et **l'écrase**, sauf si la base est en mode **`ARCHIVELOG`**, auquel cas il **copie d'abord** le journal plein dans un fichier d'archive.

Image : le cahier de notes (chapitre 1) n'a que trois pages. En `NOARCHIVELOG`, quand on arrive à la fin on **efface la première page** pour réécrire dessus. En `ARCHIVELOG`, on la **photocopie et on la range** avant de l'effacer.

Premier réflexe d'un débutant : sauvegarder tout de suite. Essayons, **base ouverte**, telle qu'elle est livrée :

🔧 **Manipuler.**

```
RMAN> BACKUP DATABASE;
connected to target database: ORCL (DBID=2297484771)

Starting backup at 28-NOV-2026 12:44:30
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database

RMAN-00571: ===========================================================
RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============
RMAN-00571: ===========================================================
RMAN-03002: failure of backup command at 28-NOV-2026 12:44:30
RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode
```

👀 **Lire la sortie.** Le cadre `RMAN-00571 / RMAN-00569` est du **décor** : ignore-le. Les deux lignes utiles sont à la fin :

- `RMAN-03002: failure of backup command` : *quelle* commande a échoué ;
- **`RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode`** : *pourquoi*.

Oracle **refuse**, et il a raison : sans journaux archivés, une copie faite pendant que la base change serait **incohérente** et inutilisable. Il n'y a que deux issues : **arrêter la base** pour la sauvegarder à froid (inacceptable pour une boutique ouverte 24 h/24), ou passer en `ARCHIVELOG`.

### 5.2 Passer en ARCHIVELOG

🧠 **Comprendre.** Le passage demande un **redémarrage** : la commande n'est acceptée qu'à l'état `MOUNT` (chapitre 1.2). Le lab livre un script qui déroule toute la séquence :

1. `SHUTDOWN IMMEDIATE` — arrêt propre ;
2. `STARTUP MOUNT` — démarrage, sans ouvrir les fichiers ;
3. `ALTER DATABASE ARCHIVELOG` — **le changement de mode** ;
4. `ALTER DATABASE FORCE LOGGING` — plus aucune opération ne peut échapper au journal avec `NOLOGGING` (indispensable pour une standby, chapitre 14) ;
5. `ALTER DATABASE OPEN` — on rouvre ;
6. `ARCHIVE LOG LIST` — on vérifie.

🔧 **Manipuler.**

```
SQL> @/home/oracle/scripts/03_archivelog.sql
Database closed.
Database dismounted.
ORACLE instance shut down.

[... 13 lignes omises ...]
Database altered.
Database log mode              Archive Mode
Automatic archival             Enabled
Archive destination            LOCATION=/u01/app/oracle/archivelog
Archive format                 arch_%t_%s_%r.arc
Oldest online log sequence     1
Next log sequence to archive   0
Current log sequence           0
Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
```

👀 **Lire la sortie.** Cherche `Database log mode  Archive Mode` : c'est la confirmation. Puis on vérifie par la vue :

```
SQL> SELECT log_mode, force_logging FROM v$database;
LOG_MODE   FORCE_LOGGING
---------- -------------
ARCHIVELOG YES

1 row selected.
```

`LOG_MODE ARCHIVELOG` et `FORCE_LOGGING YES` : la base est prête.

⚠️ **Piège.** `ALTER DATABASE ARCHIVELOG` **en `OPEN`** est refusé (`ORA-01126`) : il faut passer par `MOUNT`. Et il faut **prévoir de la place** pour les archives : une zone d'archivage pleine **bloque la base** (`ORA-00257`). On verra au chapitre 8 comment l'éviter.

✅ **À retenir.** `ARCHIVELOG` = les journaux sont **gardés**. C'est la condition pour **sauvegarder à chaud** et pour **restaurer jusqu'à la dernière transaction**.

### 🧪 Vérifie-toi (chapitre 5)

1. Que garde-t-on, en `ARCHIVELOG`, que l'on perd en `NOARCHIVELOG` ? <details><summary>Réponse</summary>Les journaux de reprise pleins sont copiés dans des archives au lieu d'être écrasés.</details>
2. Pourquoi `BACKUP DATABASE` a-t-il été refusé base ouverte ? <details><summary>Réponse</summary>Sans journaux archivés, une sauvegarde faite pendant que la base change est incohérente : `RMAN-06149`.</details>
3. À quel état de l'instance la commande `ALTER DATABASE ARCHIVELOG` est-elle acceptée ? <details><summary>Réponse</summary>`MOUNT`.</details>

---

## 6. Configurer RMAN une bonne fois pour toutes

> 🎯 **Objectif** — Régler RMAN **une fois**, pour que toutes les sauvegardes suivantes aillent **au bon endroit**, avec la **bonne durée de conservation**, et que le fichier de contrôle soit **toujours sauvegardé avec elles**.

### 6.1 Ce que RMAN fait par défaut

🧠 **Comprendre.** RMAN range sa **configuration dans le fichier de contrôle** : on la règle une fois, elle vaut pour tous les `BACKUP` suivants.

🔧 **Manipuler.** On regarde d'abord les réglages d'usine :

```
RMAN> SHOW ALL;
connected to target database: ORCL (DBID=2297484771)

RMAN configuration parameters for database with db_unique_name ORCL are:
CONFIGURE RETENTION POLICY TO REDUNDANCY 1;
CONFIGURE BACKUP OPTIMIZATION OFF;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CONTROLFILE AUTOBACKUP OFF;
[... 8 lignes omises ...]
CONFIGURE EXCLUDE FOR TABLESPACE TEMP; # default, cleared if explicit
CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;
CONFIGURE SNAPSHOT CONTROLFILE NAME TO '/u01/app/oracle/product/19c/dbhome_1/dbs/snapcf_ORCL.f'; # default
```

👀 **Lire la sortie.** Trois réglages par défaut ne conviennent pas :

| Réglage d'usine | Le problème |
|---|---|
| `RETENTION POLICY TO REDUNDANCY 1` | On ne garde **qu'une** sauvegarde : au premier incident, plus de marge |
| `CONTROLFILE AUTOBACKUP OFF` | Le fichier de contrôle n'est **pas sauvegardé automatiquement** : le chapitre 11 serait impossible |
| Pas de `FORMAT` sur le canal | Les pièces iraient dans la zone de récupération locale, **sur le même disque que la base** : une sauvegarde qui meurt avec la base ne sert à rien |

### 6.2 Notre politique

🔧 **Manipuler.**

```
RMAN> CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
RMAN> CONFIGURE CONTROLFILE AUTOBACKUP ON;
RMAN> CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
RMAN> CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/backup/%d_%T_%U.bkp';
connected to target database: ORCL (DBID=2297484771)

new RMAN configuration parameters are successfully stored
new RMAN configuration parameters are successfully stored
new RMAN configuration parameters are successfully stored
new RMAN configuration parameters are successfully stored
```

| Réglage | Pourquoi |
|---|---|
| `RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS` | On doit pouvoir revenir à **n'importe quel instant des 7 derniers jours** ; RMAN garde ce qu'il faut pour cela et déclare le reste **obsolète** |
| `CONTROLFILE AUTOBACKUP ON` | Après chaque sauvegarde, RMAN sauvegarde **aussi** le fichier de contrôle |
| `CONTROLFILE AUTOBACKUP FORMAT … '/backup/cf_%F'` | Le fichier de contrôle est sauvegardé **sur le volume NFS**, sous un nom qui contient le DBID (`%F`) |
| `CHANNEL … FORMAT '/backup/%d_%T_%U.bkp'` | Toutes les pièces vont sur `/backup` ; `%d` nom de la base, `%T` date, `%U` identifiant unique |

On relit pour **vérifier** que la configuration a été prise en compte :

```
RMAN> SHOW RETENTION POLICY;
RMAN> SHOW CONTROLFILE AUTOBACKUP FORMAT;
connected to target database: ORCL (DBID=2297484771)

CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;

CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
```

👀 **Lire la sortie.** `RECOVERY WINDOW OF 7 DAYS` et le format `cf_%F` sont bien enregistrés. Réflexe d'administrateur : **toujours relire** après avoir configuré.

⚠️ **Piège.** Cette configuration vit **dans le fichier de contrôle**. Si tu le perds, RMAN **oublie tout** (c'est la leçon du chapitre 11).

### 🧪 Vérifie-toi (chapitre 6)

1. Que veut dire « fenêtre de récupération de 7 jours » ? <details><summary>Réponse</summary>On doit pouvoir restaurer la base à n'importe quel instant des 7 derniers jours ; RMAN conserve les sauvegardes nécessaires et déclare le reste obsolète.</details>
2. Pourquoi règle-t-on le format des pièces vers `/backup` ? <details><summary>Réponse</summary>Pour que les sauvegardes soient sur un **autre serveur** que la base, et survivent à sa perte.</details>

---

## 7. La première sauvegarde

> 🎯 **Objectif** — Faire ta première sauvegarde complète, **savoir lire sa sortie**, la retrouver dans le catalogue, et **prouver** qu'elle est bien arrivée sur l'autre serveur.

### 7.1 La commande

🧠 **Comprendre.** `BACKUP DATABASE PLUS ARCHIVELOG` sauvegarde les **fichiers de données** *et* les **journaux archivés** : c'est le strict minimum pour pouvoir récupérer jusqu'à la dernière transaction. `TAG 'PREMIERE'` est une **étiquette** pour s'y retrouver : elle ne s'applique qu'à la sauvegarde des **fichiers de données** ; RMAN en invente une (`TAG2026…`) pour la sauvegarde des journaux, et nomme `AUTOBACKUP` celle du fichier de contrôle.

🔧 **Manipuler.**

```
RMAN> BACKUP DATABASE PLUS ARCHIVELOG TAG 'PREMIERE';
connected to target database: ORCL (DBID=2297484771)

Starting backup at 28-NOV-2026 12:44:30
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/backup/ORCL_20261128_01tp7q26_1_1.bkp tag=PREMIERE
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 28-NOV-2026 12:45:09

Starting backup at 28-NOV-2026 12:45:09
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
channel ORA_DISK_1: starting archived log backup set
channel ORA_DISK_1: specifying archived log(s) in backup set
piece handle=/backup/ORCL_20261128_02tp7q39_1_1.bkp tag=TAG20261128T124509
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 28-NOV-2026 12:45:48

Starting backup at 28-NOV-2026 12:45:48
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=102 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
including current control file in backup set
piece handle=/backup/cf_c-2297484771-20261128-03 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 28-NOV-2026 12:45:49
```

👀 **Lire la sortie.** Lis-la comme un journal de bord :

- `Starting backup … / Finished backup …` : **trois blocs** — les fichiers de données, les journaux archivés, puis l'**auto-sauvegarde du fichier de contrôle** ;
- `piece handle=/backup/ORCL_….bkp tag=PREMIERE` : **le fichier créé** (la *pièce*) et son étiquette ;
- `elapsed time` : la durée, **calculée** à partir de la taille du fichier (50 Mo/s, voir le chapitre 19) ; l'horloge de la machine avance d'autant, donc `Finished backup at` − `Starting backup at` = `elapsed time`.

### 7.2 Ce qu'il y a dans le catalogue

🧠 **Comprendre.** RMAN tient un **catalogue** de tout ce qu'il a sauvegardé (dans le fichier de contrôle). Trois commandes de **supervision** à connaître : `LIST BACKUP SUMMARY` (ce que j'ai), `REPORT SCHEMA` (ce qu'il y a à protéger), `REPORT NEED BACKUP` (ce qui n'est **plus** assez protégé).

🔧 **Manipuler.**

```
RMAN> LIST BACKUP SUMMARY;
RMAN> REPORT SCHEMA;
RMAN> REPORT NEED BACKUP;
connected to target database: ORCL (DBID=2297484771)

List of Backups
===============
Key     TY LV S Device Type Completion Time      #Pieces #Copies Compressed Tag
------- -- -- - ----------- -------------------- ------- ------- ---------- ------------------
1       B  F  A DISK        28-NOV-2026 12:45:09 1       1       NO         PREMIERE
2       B  A  A DISK        28-NOV-2026 12:45:48 1       1       NO         TAG20261128T124509
3       B  F  A DISK        28-NOV-2026 12:45:49 1       1       NO         AUTOBACKUP

Report of database schema for database with db_unique_name ORCL

List of Permanent Datafiles
===========================
[... 12 lignes omises ...]
---- -------- -------------------- ----------- --------------------
1    100      TEMP                 32768       /u01/app/oracle/oradata/ORCL/temp01.dbf

RMAN retention policy will be applied to the command
RMAN retention policy is set to recovery window of 7 days
Report of files that must be backed up to satisfy 7 days recovery window
File Days  Name
---- ----- -----------------------------------------------------
1    0     /u01/app/oracle/oradata/ORCL/system01.dbf
2    0     /u01/app/oracle/oradata/ORCL/sysaux01.dbf
3    0     /u01/app/oracle/oradata/ORCL/undotbs01.dbf
4    0     /u01/app/oracle/oradata/ORCL/users01.dbf
5    0     /u01/app/oracle/oradata/ORCL/shop_data01.dbf
6    0     /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
```

👀 **Lire la sortie.** Dans `LIST BACKUP SUMMARY`, une ligne par **backup set** : `TY` le type (`B` = backup set), `LV` le niveau (`F` complet, `A` journaux), `S` l'état (`A` = *available*, disponible). `REPORT NEED BACKUP` confronte chaque fichier à la politique : la colonne `Days` donne le nombre de jours depuis la dernière sauvegarde de ce fichier (ici 0 : on vient de les sauvegarder tous). **Dans une supervision, c'est cette liste qu'on surveille.**

### 7.3 La preuve par le fil

🧠 **Comprendre.** Ces pièces sont-elles **vraiment** sur l'autre serveur ? Va le voir **sur `BKP-HQ`** :

🔧 **Manipuler.**

```
[root@bkp-hq ~]# ls -ln /srv/backup/rman
total 280
-rw-r--r-- 1 54321 54321   3645 Nov 28 12:44 cf_c-2297484771-20261128-03
-rw-r--r-- 1 54321 54321 276574 Nov 28 12:44 ORCL_20261128_01tp7q26_1_1.bkp
-rw-r--r-- 1 54321 54321     45 Nov 28 12:44 ORCL_20261128_02tp7q39_1_1.bkp
```

👀 **Lire la sortie.** Les pièces `ORCL_….bkp` et les trois `cf_c-….` sont là, avec le propriétaire **54321 / 54321** : c'est bien `oracle` d'`ORA-PRD` qui les a créées, **à travers le réseau** (NFSv3 sur le port 2049, trames réelles). C'est la raison pour laquelle on sauvegarde en `oracle` et non en `root` : en root, les pièces appartiendraient à `root` sur le serveur de sauvegarde.

### 7.4 Ce que la base sait de ses sauvegardes

🔧 **Manipuler.** Le catalogue se lit aussi par des vues `V$` :

```
SQL> SELECT handle, status FROM v$backup_piece;
SQL> SELECT session_key, input_type, status FROM v$rman_backup_job_details;
HANDLE                                 STATUS
-------------------------------------- ------
/backup/ORCL_20261128_01tp7q26_1_1.bkp A
/backup/ORCL_20261128_02tp7q39_1_1.bkp A
/backup/cf_c-2297484771-20261128-03    A

3 rows selected.

SESSION_KEY INPUT_TYPE  STATUS
----------- ----------- ---------
          1 FULL        COMPLETED
          2 ARCHIVELOG  COMPLETED
          3 CONTROLFILE COMPLETED

3 rows selected.
```

👀 **Lire la sortie.** `V$BACKUP_PIECE` liste les fichiers avec leur état ; `V$RMAN_BACKUP_JOB_DETAILS` l'**historique des travaux** (`COMPLETED`). Ce sont les vues qu'on interroge pour **superviser** une chaîne de sauvegarde depuis un outil de monitoring.

✅ **À retenir.** Une sauvegarde se **lit**, se **catalogue** et se **prouve** : trois contrôles, trois commandes.

### 🧪 Vérifie-toi (chapitre 7)

1. Que signifie `tag=PREMIERE` ? <details><summary>Réponse</summary>Une étiquette libre donnée à la sauvegarde pour la retrouver (et la distinguer des autres).</details>
2. Pourquoi la pièce appartient-elle à l'uid 54321 sur `BKP-HQ` ? <details><summary>Réponse</summary>Parce que c'est `oracle` d'`ORA-PRD` (uid 54321) qui l'a écrite par NFS, et que le même numéro existe sur `BKP-HQ`.</details>

---

## 8. Une stratégie : niveau 0, niveau 1, journaux, cron

> 🎯 **Objectif** — Passer d'**une** sauvegarde à une **stratégie** qui tient les objectifs (RPO ≤ 4 h) sans refaire une copie complète à chaque fois, **automatisée** et **tracée**.

### 8.1 Le plan

🧠 **Comprendre.** Refaire une copie complète toutes les heures serait lent et lourd. On combine :

| Quand | Quoi | Ce que ça protège |
|---|---|---|
| **Dimanche 02:00** | **Niveau 0** (base complète) | La **référence** |
| **Lundi–samedi 02:00** | **Niveau 1** (ce qui a changé depuis) | La nuit précédente, à peu de frais |
| **Toutes les 4 heures** | Sauvegarde des **journaux archivés**, puis suppression de ceux qui sont sauvegardés | **Le RPO** : on ne perd au plus que 4 h |

Une image : le niveau 0 est la photocopie du livre entier ; le niveau 1, une photocopie **des seules pages modifiées** depuis ; les journaux, le cahier de notes archivé.

### 8.2 Les scripts

🧠 **Comprendre.** Un `cron` (chapitre 8.5) lance des **commandes**, pas une session interactive. On écrit donc **trois fichiers de commandes RMAN** (`l0.rman`, `l1.rman`, `arc.rman`) et **un seul** script shell qui les lance, journalise leur sortie dans un fichier, et envoie le **code retour** au serveur de journaux (`logger`).

🔧 **Manipuler.**

```
[oracle@ora-prd ~]$ mkdir -p /home/oracle/logs
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/rman_job.sh <<'X'
#!/bin/bash
job=$1
rman target / cmdfile=/home/oracle/scripts/$job.rman log=/home/oracle/logs/$job.log
code=$?
logger -t rman-backup "job=$job code=$code"
exit $code
X
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/l0.rman <<'X'
RUN {
  BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DIMANCHE_L0';
}
X
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/l1.rman <<'X'
RUN {
  BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'QUOTIDIEN_L1';
}
X
[oracle@ora-prd ~]$ cat > /home/oracle/scripts/arc.rman <<'X'
RUN {
  BACKUP ARCHIVELOG ALL DELETE INPUT TAG 'JOURNAUX';
}
X
[oracle@ora-prd ~]$ chmod 750 /home/oracle/scripts/rman_job.sh
[oracle@ora-prd ~]$ ls -l /home/oracle/scripts
total 32
-rw-r--r-- 1 oracle oinstall 1540 Nov 28 12:44 01_schema.sql
-rw-r--r-- 1 oracle oinstall 3018 Nov 28 12:44 02_seed.sql
-rw-r--r-- 1 oracle oinstall  133 Nov 28 12:44 03_archivelog.sql
-rw-r--r-- 1 oracle oinstall   61 Nov 28 12:45 arc.rman
-rw-r--r-- 1 oracle oinstall  314 Nov 28 12:44 health.sql
-rw-r--r-- 1 oracle oinstall   65 Nov 28 12:45 l0.rman
-rw-r--r-- 1 oracle oinstall   66 Nov 28 12:45 l1.rman
-rwxr-x--- 1 oracle oinstall  166 Nov 28 12:45 rman_job.sh
```

👀 **Lire la sortie.** `rman target / cmdfile=… log=…` exécute un fichier de commandes **sans intervention** ; `$?` (le **code retour**) vaut **0 si tout va bien**. C'est lui que l'ordonnanceur et la supervision regardent.

### 8.3 Un niveau 0, des données qui changent, un niveau 1

🔧 **Manipuler.** Le niveau 0 d'abord :

```
[oracle@ora-prd ~]$ /home/oracle/scripts/rman_job.sh l0
[oracle@ora-prd ~]$ echo "code retour : $?"
code retour : 0
[oracle@ora-prd ~]$ tail -4 /home/oracle/logs/l0.log
piece handle=/backup/cf_c-2297484771-20261128-05 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 28-NOV-2026 12:46:29
```

On modifie ensuite des données (les commandes `NEW` passent en `PAID`) et on **force l'archivage** du journal courant :

```
SQL> UPDATE shop.orders SET status = 'PAID' WHERE status = 'NEW';
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT status, COUNT(*) AS nb FROM shop.orders GROUP BY status ORDER BY 1;
6 rows updated.

Commit complete.

System altered.

STATUS  NB
------- --
PAID     9
SHIPPED  3

2 rows selected.
```

Puis le niveau 1, qui est **quasi instantané** par rapport au niveau 0 : il ne contient que les changements.

```
[oracle@ora-prd ~]$ /home/oracle/scripts/rman_job.sh l1
[oracle@ora-prd ~]$ echo "code retour : $?"
code retour : 0
[oracle@ora-prd ~]$ tail -3 /home/oracle/logs/l1.log
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 28-NOV-2026 12:46:32
```

Une dernière modification, **après** le niveau 1 (le stock de la lampe passe de 120 à 115, une vente). Elle ne sera dans **aucune sauvegarde de fichier de données**, seulement dans les journaux. **C'est ce que le chapitre 10 utilisera pour montrer à quoi servent les journaux** :

```
SQL> UPDATE shop.products SET stock = stock - 5 WHERE product_id = 1;
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT stock FROM shop.products WHERE product_id = 1;
1 row updated.

Commit complete.

System altered.

STOCK
-----
  115

1 row selected.
```

### 8.4 Les journaux archivés

🧠 **Comprendre.** Avant de les sauvegarder, deux journaux archivés sont sur le disque. `CROSSCHECK ARCHIVELOG ALL` vérifie que **chaque fichier de journal que la base croit avoir existe réellement**.

🔧 **Manipuler.**

```
RMAN> CROSSCHECK ARCHIVELOG ALL;
connected to target database: ORCL (DBID=2297484771)

Starting crosscheck at 28-NOV-2026 12:46:32
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
validation succeeded for archived log
archived log file name=/u01/app/oracle/archivelog/1_1_arc.arc thread=1 sequence=1
validation succeeded for archived log
archived log file name=/u01/app/oracle/archivelog/1_2_arc.arc thread=1 sequence=2
Crosschecked 2 objects
Finished crosscheck at 28-NOV-2026 12:46:32
```

👀 **Lire la sortie.** `validation succeeded for archived log` suivi de `archived log file name=…` : le fichier est là. (Un fichier absent donnerait `validation failed for archived log`, et le journal serait marqué `EXPIRED`.)

Puis on sauvegarde les journaux **et on supprime ceux qui sont sauvegardés** (`DELETE INPUT`) :

```
[oracle@ora-prd ~]$ /home/oracle/scripts/rman_job.sh arc
[oracle@ora-prd ~]$ echo "code retour : $?"
code retour : 0
[oracle@ora-prd ~]$ tail -3 /home/oracle/logs/arc.log
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 28-NOV-2026 12:47:12
```

⚠️ **Piège.** Sans `DELETE INPUT`, la zone d'archivage **se remplit** et la base **se bloque** (`ORA-00257`) quand elle ne peut plus archiver. C'est l'**incident de production le plus banal** d'Oracle.

```
RMAN> LIST BACKUP SUMMARY;
RMAN> LIST ARCHIVELOG ALL;
connected to target database: ORCL (DBID=2297484771)

List of Backups
===============
Key     TY LV S Device Type Completion Time      #Pieces #Copies Compressed Tag
------- -- -- - ----------- -------------------- ------- ------- ---------- ------------------
1       B  F  A DISK        28-NOV-2026 12:45:09 1       1       NO         PREMIERE
2       B  A  A DISK        28-NOV-2026 12:45:48 1       1       NO         TAG20261128T124509
3       B  F  A DISK        28-NOV-2026 12:45:49 1       1       NO         AUTOBACKUP
4       B  0  A DISK        28-NOV-2026 12:46:28 1       1       NO         DIMANCHE_L0
5       B  F  A DISK        28-NOV-2026 12:46:29 1       1       NO         AUTOBACKUP
6       B  1  A DISK        28-NOV-2026 12:46:31 1       1       NO         QUOTIDIEN_L1
7       B  F  A DISK        28-NOV-2026 12:46:32 1       1       NO         AUTOBACKUP
8       B  A  A DISK        28-NOV-2026 12:47:11 1       1       NO         JOURNAUX
9       B  F  A DISK        28-NOV-2026 12:47:12 1       1       NO         AUTOBACKUP

specification does not match any archived log in the repository
```

👀 **Lire la sortie.** On lit la structure de la stratégie : `LV 0` (niveau 0), `LV 1` (niveau 1), `LV A` (journaux), `LV F` (les auto-sauvegardes du fichier de contrôle). `LIST ARCHIVELOG ALL` répond qu'**aucun journal n'est plus sur le disque** : ils ont été sauvegardés **puis supprimés**. On verra au chapitre 10 que RMAN sait les **récupérer depuis la sauvegarde** quand il en a besoin.

### 8.5 La planification

🧠 **Comprendre.** **cron** est le programme de Linux qui lance des commandes **à heures fixes**. On lui donne une liste dans un fichier, la **crontab**. Le format : `minute heure jour-du-mois mois jour-de-la-semaine commande` (`0 2 * * 0` = à 02:00 le dimanche).

🔧 **Manipuler.**

```
[oracle@ora-prd ~]$ (crontab -l 2>/dev/null; echo "0 2 * * 0 /home/oracle/scripts/rman_job.sh l0"; echo "0 2 * * 1-6 /home/oracle/scripts/rman_job.sh l1"; echo "0 */4 * * * /home/oracle/scripts/rman_job.sh arc") | crontab -
[oracle@ora-prd ~]$ crontab -l
0 2 * * 0 /home/oracle/scripts/rman_job.sh l0
0 2 * * 1-6 /home/oracle/scripts/rman_job.sh l1
0 */4 * * * /home/oracle/scripts/rman_job.sh arc
```

👀 **Lire la sortie.** Trois lignes dans la crontab de l'utilisateur `oracle` : niveau 0 le dimanche, niveau 1 du lundi au samedi, journaux toutes les 4 h (`0 */4 * * *`).

### 8.6 Le journal central

🧠 **Comprendre.** **rsyslog** est le service Linux qui collecte les messages des programmes ; il peut les **envoyer à un autre serveur** pour les centraliser. La commande `logger` écrit un message dans ce système depuis un script. Chaque exécution du script a envoyé son code retour à `LOG-HQ`.

🔧 **Manipuler.** Sur `LOG-HQ` :

```
[root@log-hq ~]# grep rman-backup /var/log/syslog
Nov 28 12:46:29 ora-prd rman-backup: job=l0 code=0
Nov 28 12:46:32 ora-prd rman-backup: job=l1 code=0
Nov 28 12:47:12 ora-prd rman-backup: job=arc code=0
```

👀 **Lire la sortie.** `ora-prd` : la machine émettrice. `job=l0 code=0` : quel travail, avec quel résultat. **C'est la trace centrale de la chaîne de sauvegarde** : une supervision n'a qu'à chercher `code=` différent de `0`. Le lab configure cet envoi (`*.* @10.10.10.40:514`) sur toutes les machines Oracle, sauvegarde et web.

✅ **À retenir.** Niveau 0 = référence ; niveau 1 = écart ; journaux = RPO ; **code retour** = ce que surveille la supervision ; **un seul journal central** = une seule trace où regarder.

### 🧪 Vérifie-toi (chapitre 8)

1. À quoi sert le niveau 1 par rapport à un niveau 0 quotidien ? <details><summary>Réponse</summary>Il ne copie que ce qui a changé : bien plus rapide et léger, pour une protection quasi équivalente.</details>
2. Pourquoi sauvegarder les journaux **toutes les 4 heures** ? <details><summary>Réponse</summary>Pour tenir le RPO : on ne perd au plus que 4 h de modifications. Et `DELETE INPUT` évite que la zone d'archivage ne se remplisse.</details>
3. Quel code retour dit que le travail a réussi ? <details><summary>Réponse</summary>`0`.</details>

---

## 9. Vérifier : une sauvegarde non testée n'existe pas

> 🎯 **Objectif** — Savoir **contrôler** ses sauvegardes à trois niveaux, du moins cher au plus cher, et gérer leur **durée de vie**. C'est ce qui sépare une sauvegarde **rassurante** d'une sauvegarde **utile**.

🧠 **Comprendre.** On peut s'assurer de trois choses, de plus en plus fortes :

| # | La question | La commande |
|---|---|---|
| 1 | Les **fichiers de la base** sont-ils lisibles ? | `VALIDATE DATABASE` |
| 2 | RMAN **pourrait-il restaurer** ? (sans rien écrire) | `RESTORE DATABASE VALIDATE` |
| 3 | Le **catalogue** correspond-il à la réalité du disque ? | `CROSSCHECK BACKUP` |

🔧 **Manipuler.**

**1. Les fichiers de la base sont-ils lisibles ?**

```
RMAN> VALIDATE DATABASE;
connected to target database: ORCL (DBID=2297484771)

Starting validate at 28-NOV-2026 12:47:12
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting validation of database
channel ORA_DISK_1: validating database
List of Datafiles
=================
[... 12 lignes omises ...]
6    OK     0              12799        12800           1000334
File Name: /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
channel ORA_DISK_1: validation complete, elapsed time: 00:00:01
Finished validate at 28-NOV-2026 12:47:12
```

**2. RMAN pourrait-il restaurer ?** Il lit **toutes les pièces nécessaires** et vérifie qu'elles sont lisibles et cohérentes, sans rien écrire :

```
RMAN> RESTORE DATABASE VALIDATE;
connected to target database: ORCL (DBID=2297484771)

Starting restore at 28-NOV-2026 12:47:12
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile backup set restore
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_01tp7q26_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_02tp7q39_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-2297484771-20261128-03
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_04tp7q4d_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-2297484771-20261128-05
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_06tp7q5h_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-2297484771-20261128-07
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_08tp7q5k_1_1.bkp
channel ORA_DISK_1: reading from backup piece /backup/cf_c-2297484771-20261128-09
channel ORA_DISK_1: validation complete, elapsed time: 00:00:01
Finished restore at 28-NOV-2026 12:47:12
```

C'est **le test à mettre dans ta supervision**.

**3. Le catalogue correspond-il à la réalité ?**

```
RMAN> CROSSCHECK BACKUP;
connected to target database: ORCL (DBID=2297484771)

Starting crosscheck at 28-NOV-2026 12:47:12
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
crosschecked backup piece: found to be 'AVAILABLE'
backup piece handle=/backup/ORCL_20261128_01tp7q26_1_1.bkp RECID=1 STAMP=1227876309
crosschecked backup piece: found to be 'AVAILABLE'
backup piece handle=/backup/ORCL_20261128_02tp7q39_1_1.bkp RECID=2 STAMP=1227876348
crosschecked backup piece: found to be 'AVAILABLE'
[... 11 lignes omises ...]
crosschecked backup piece: found to be 'AVAILABLE'
backup piece handle=/backup/cf_c-2297484771-20261128-09 RECID=9 STAMP=1227876432
Crosschecked 9 objects
Finished crosscheck at 28-NOV-2026 12:47:12
```

👀 **Lire la sortie.** `CROSSCHECK BACKUP` compare **toutes les sauvegardes** que RMAN connaît — fichiers de données **et** journaux — avec ce qu'il y a vraiment sur le disque : une pièce effacée à la main passerait en `EXPIRED`. (Le `CROSSCHECK ARCHIVELOG ALL` du chapitre 8 contrôle autre chose : les **fichiers** de journaux.)

Enfin, la **durée de vie** : la politique de rétention décide ce qui est **obsolète** :

```
RMAN> REPORT OBSOLETE;
RMAN> DELETE OBSOLETE NOPROMPT;
connected to target database: ORCL (DBID=2297484771)

RMAN retention policy will be applied to the command
RMAN retention policy is set to recovery window of 7 days
Report of obsolete backups and copies
Type                 Key    Completion Time    Filename/Handle
-------------------- ------ ------------------ --------------------
no obsolete backups found

Starting delete at 28-NOV-2026 12:47:12
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
RMAN retention policy will be applied to the command
using channel ORA_DISK_1
no obsolete backups found
Finished delete at 28-NOV-2026 12:47:12
```

`REPORT OBSOLETE` liste ce que la fenêtre de 7 jours permet de supprimer ; `DELETE OBSOLETE` le supprime. Tout est « récent » ici : rien n'est obsolète.

✅ **À retenir.** *« Le seul test valable d'une sauvegarde est une **restauration**. »* Les trois pannes qui suivent sont ce test.

### 🧪 Vérifie-toi (chapitre 9)

1. Quelle commande vérifie que RMAN **pourrait** restaurer, sans rien restaurer ? <details><summary>Réponse</summary>`RESTORE DATABASE VALIDATE`.</details>
2. Qu'est-ce qu'une sauvegarde **obsolète** ? <details><summary>Réponse</summary>Une sauvegarde dont la politique de rétention n'a plus besoin : elle est hors de la fenêtre de récupération.</details>

---

## 10. Panne n° 1 — Un fichier de données disparaît

> 🎯 **Objectif** — Réparer la perte d'un fichier de données **sans perdre une seule transaction**, base arrêtée puis base ouverte. Tu apprends le **geste de base** de toute restauration : `RESTORE`, puis `RECOVER`.

### La situation

📧 *L'exploitant :* « Un disque a lâché cette nuit. Plus de commandes. » Le fichier `shop_data01.dbf` (le tablespace `SHOP_DATA`, **toutes les tables de la boutique**) n'existe plus.

### Avant de toucher à quoi que ce soit : l'état de référence

🔧 **Manipuler.** On note ce qu'on **doit retrouver** à la fin :

```
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
COMMANDES
---------
       12

1 row selected.
```

👀 **Lire la sortie.** 12 commandes. À la fin, il faudra **12**, la mise à jour de la journée **et** le stock de la lampe à **115**.

### Le sinistre

🔧 **Manipuler.**

```
[oracle@ora-prd ~]$ rm -f /u01/app/oracle/oradata/ORCL/shop_data01.dbf
[oracle@ora-prd ~]$ ls /u01/app/oracle/oradata/ORCL
control01.ctl  redo02.log      sysaux01.dbf  undotbs01.dbf
control02.ctl  redo03.log      system01.dbf  users01.dbf
redo01.log     shop_idx01.dbf  temp01.dbf
```

🧠 **Pourquoi ne se passe-t-il rien ?** Tant que la base est ouverte, Oracle a le fichier **ouvert** ; il ne s'aperçoit de sa disparition qu'à un redémarrage (ou à la prochaine lecture sur disque). On simule la panne la plus brutale : l'arrêt immédiat de l'instance.

```
SQL> SHUTDOWN ABORT
Database closed.
Database dismounted.
ORACLE instance shut down.
```

### Le diagnostic

🧠 **Comprendre.** Premier réflexe : **ne rien réparer avant d'avoir compris**. On redémarre pour voir ce qu'Oracle dit :

🔧 **Manipuler.**

```
SQL> STARTUP MOUNT
SQL> ALTER DATABASE OPEN;
ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01157: cannot identify/lock data file 5 - see DBWR trace file
ORA-01110: data file 5: '/u01/app/oracle/oradata/ORCL/shop_data01.dbf'
```

👀 **Lire la sortie.** C'est **LE** message à reconnaître :

- `Database mounted.` : l'instance est **montée** — le fichier de contrôle est lisible, c'est lui qui connaît la liste des fichiers ;
- `ORA-01157: cannot identify/lock data file 5` : *impossible d'identifier le fichier* ;
- `ORA-01110: data file 5: '…/shop_data01.dbf'` : **le nom du fichier** — numéro 5, chemin complet.

L'**ouverture** échoue seulement parce qu'un fichier manque. Et c'est exactement l'état `MOUNT` dont on a besoin pour restaurer.

### Le plan en trois étapes

1. **`RESTORE DATAFILE 5`** — RMAN retrouve la sauvegarde la plus récente du fichier 5 et la **recopie à sa place** (depuis `/backup`, à travers le réseau) ;
2. **`RECOVER DATAFILE 5`** — le fichier restauré date de la sauvegarde : RMAN lui **rejoue les journaux** pour le ramener au présent. Les journaux ont été supprimés du disque après leur sauvegarde : RMAN les **extrait de la pièce de sauvegarde des journaux** avant de les rejouer ;
3. **`ALTER DATABASE OPEN`** — on ouvre.

### La réparation

🔧 **Manipuler.** Deux commandes RMAN, **toujours dans cet ordre** :

```
RMAN> RESTORE DATAFILE 5;
RMAN> RECOVER DATAFILE 5;
connected to target database: ORCL (DBID=2297484771)

Starting restore at 28-NOV-2026 12:47:12
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile 5 restore
channel ORA_DISK_1: restoring datafile 00005 to /u01/app/oracle/oradata/ORCL/shop_data01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:04
Finished restore at 28-NOV-2026 12:47:16

Starting recover at 28-NOV-2026 12:47:16
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
starting media recovery
recovering datafile 5
channel ORA_DISK_1: starting archived log restore to default destination
channel ORA_DISK_1: restoring archived log
archived log thread=1 sequence=1
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_08tp7q5k_1_1.bkp
channel ORA_DISK_1: restored backup piece 1
channel ORA_DISK_1: restore complete, elapsed time: 00:00:01
archived log file name=/u01/app/oracle/archivelog/1_1_arc.arc thread=1 sequence=1
channel ORA_DISK_1: starting archived log restore to default destination
channel ORA_DISK_1: restoring archived log
archived log thread=1 sequence=2
channel ORA_DISK_1: reading from backup piece /backup/ORCL_20261128_08tp7q5k_1_1.bkp
channel ORA_DISK_1: restored backup piece 1
channel ORA_DISK_1: restore complete, elapsed time: 00:00:01
archived log file name=/u01/app/oracle/archivelog/1_2_arc.arc thread=1 sequence=2
media recovery complete, elapsed time: 00:00:01
Finished recover at 28-NOV-2026 12:47:17
```

👀 **Lire la sortie.** `restoring datafile 00005` : le fichier est recopié. `starting archived log restore` / `reading from backup piece` : les journaux avaient été supprimés du disque après leur sauvegarde, RMAN les **ressort de la sauvegarde** ; `media recovery complete` : les journaux sont rejoués. Aucune ligne `RMAN-06054` (journal manquant) : la chaîne est complète.

⚠️ **Piège.** `RESTORE` ramène un état **ancien** ; `RECOVER` le **met à jour**. Sans `RECOVER`, le fichier est trop vieux par rapport au reste de la base et Oracle **refuse de l'ouvrir**.

### La vérification

🔧 **Manipuler.**

```
SQL> ALTER DATABASE OPEN;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
SQL> SELECT COUNT(*) AS payees FROM shop.orders WHERE status = 'PAID';
SQL> SELECT stock FROM shop.products WHERE product_id = 1;
Database altered.

COMMANDES
---------
       12

1 row selected.

PAYEES
------
     9

1 row selected.

STOCK
-----
  115

1 row selected.
```

👀 **Lire la sortie.** La base est ouverte ; les 12 commandes sont là ; neuf sont payées (la mise à jour de la journée est revenue avec le niveau 1) **et le stock de la lampe vaut 115**. Cette vente a eu lieu **après** le niveau 1 : elle n'était dans aucune sauvegarde de fichier de données, **seulement dans le journal archivé** que RMAN a retrouvé dans sa pièce. **C'est exactement ce que valent les journaux archivés** : sans eux, tu aurais retrouvé 120.

### Variante : réparer pendant que la boutique tourne

🧠 **Comprendre.** Si **seul un tablespace** est en cause, on n'est pas obligé d'arrêter la base : on met **uniquement** `SHOP_DATA` **hors ligne**, on le restaure, on le remet en ligne. Les autres tablespaces continuent de fonctionner. (Ici le fichier vient d'être restauré ; on met tout de même le tablespace hors ligne **comme si** son fichier était de nouveau perdu : c'est le geste à connaître.)

🔧 **Manipuler.**

```
SQL> ALTER TABLESPACE shop_data OFFLINE IMMEDIATE;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
SQL> SELECT COUNT(*) FROM shop.customers;
Tablespace altered.
SELECT COUNT(*) AS commandes FROM shop.orders
*
ERROR at line 1:
ORA-00376: file 5 cannot be read at this time
ORA-01110: data file 5: '/u01/app/oracle/oradata/ORCL/shop_data01.dbf'
SELECT COUNT(*) FROM shop.customers
*
ERROR at line 1:
ORA-00376: file 5 cannot be read at this time
ORA-01110: data file 5: '/u01/app/oracle/oradata/ORCL/shop_data01.dbf'
```

👀 **Lire la sortie.** Les deux erreurs sont celles qu'un utilisateur de la boutique verrait : `ORA-00376` (fichier illisible à ce moment) et `ORA-01110` (lequel). Restauration, **en ligne** :

```
RMAN> RESTORE TABLESPACE shop_data;
RMAN> RECOVER TABLESPACE shop_data;
connected to target database: ORCL (DBID=2297484771)

Starting restore at 28-NOV-2026 12:47:17
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting tablespace SHOP_DATA restore
channel ORA_DISK_1: restoring datafile 00005 to /u01/app/oracle/oradata/ORCL/shop_data01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:04
Finished restore at 28-NOV-2026 12:47:21

Starting recover at 28-NOV-2026 12:47:21
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
starting media recovery
recovering tablespace SHOP_DATA
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
media recovery complete, elapsed time: 00:00:01
Finished recover at 28-NOV-2026 12:47:22
```

```
SQL> ALTER TABLESPACE shop_data ONLINE;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
Tablespace altered.

COMMANDES
---------
       12

1 row selected.
```

⚠️ **Piège.** Cette restauration « en ligne » n'est possible **qu'en `ARCHIVELOG`** : en `NOARCHIVELOG`, Oracle refuse de mettre un tablespace `OFFLINE IMMEDIATE` (`ORA-01145`). Encore une raison du chapitre 5.

### ✅ La leçon

**`RESTORE` ramène, `RECOVER` met à jour — dans cet ordre, toujours.** Le diagnostic tient dans deux lignes : `ORA-01157` (quoi) + `ORA-01110` (quel fichier).

### 🧪 Vérifie-toi (chapitre 10)

1. Que dit `ORA-01110` que ne dit pas `ORA-01157` ? <details><summary>Réponse</summary>Le **nom** et le **numéro** du fichier en cause.</details>
2. Pourquoi retrouve-t-on le stock à 115 et non à 120 ? <details><summary>Réponse</summary>Parce que `RECOVER` a rejoué le journal archivé qui contenait cette vente, faite après la dernière sauvegarde de fichier.</details>
3. Dans quel état de l'instance restaure-t-on un fichier base arrêtée ? <details><summary>Réponse</summary>`MOUNT`.</details>

---

## 11. Panne n° 2 — Les fichiers de contrôle disparaissent

> 🎯 **Objectif** — Survivre à la perte du **sommaire** de la base : reconstruire le fichier de contrôle **depuis l'auto-sauvegarde**, avec seulement le **DBID** en main. Tu comprends pourquoi on le note à l'avance et pourquoi on active l'auto-sauvegarde.

### La situation

Pire que la panne précédente : les **deux** copies du fichier de contrôle sont perdues. La base ne peut plus ni se monter, ni dire où sont ses fichiers, ni où sont **ses sauvegardes** (le catalogue de RMAN vivait dedans). C'est là que **le DBID** (chapitre 4) et **l'auto-sauvegarde** (chapitre 6) servent.

### Le plan en cinq étapes

1. `STARTUP NOMOUNT` — l'instance sans fichiers ;
2. dire à RMAN **qui** il sauvegarde (`SET DBID`) et **où chercher** (`SET CONTROLFILE AUTOBACKUP FORMAT`) ;
3. `RESTORE CONTROLFILE FROM AUTOBACKUP` ;
4. `ALTER DATABASE MOUNT`, puis `RECOVER DATABASE` ;
5. `ALTER DATABASE OPEN RESETLOGS`.

### Le contexte avant la panne

🔧 **Manipuler.**

```
SQL> SELECT dbid FROM v$database;
SQL> SELECT name FROM v$controlfile;
      DBID
----------
2297484771

1 row selected.

NAME
------------------------------------------
/u01/app/oracle/oradata/ORCL/control01.ctl
/u01/app/oracle/oradata/ORCL/control02.ctl

2 rows selected.
```

### Le sinistre

🔧 **Manipuler.**

```
[oracle@ora-prd ~]$ rm -f /u01/app/oracle/oradata/ORCL/control01.ctl /u01/app/oracle/oradata/ORCL/control02.ctl
[oracle@ora-prd ~]$ ls /u01/app/oracle/oradata/ORCL | grep -c control
0
```

```
SQL> SHUTDOWN ABORT
Database closed.
Database dismounted.
ORACLE instance shut down.
```

```
SQL> STARTUP
ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
ORA-00205: error in identifying control file, check alert log for more info
```

👀 **Lire la sortie.** `ORACLE instance started.` — l'instance est démarrée, **mais** `ORA-00205: error in identifying control file` : aucun fichier de contrôle lisible. L'instance reste en **`NOMOUNT`**, ce qui est exactement ce qu'il faut : RMAN peut se connecter à une instance non montée.

### La restauration du fichier de contrôle

🧠 **Comprendre.** RMAN a **tout oublié** : sa configuration et son catalogue vivaient dans le fichier de contrôle. Il faut donc lui redire qui il sauvegarde (`SET DBID` — le numéro noté au chapitre 4) et **où chercher** les auto-sauvegardes (le même format qu'au chapitre 6).

🔧 **Manipuler.**

```
RMAN> SET DBID 2297484771;
RMAN> SET CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
RMAN> RESTORE CONTROLFILE FROM AUTOBACKUP;
connected to target database: ORCL (DBID=2297484771)

executing command: SET DBID
executing command: SET CONTROLFILE AUTOBACKUP FORMAT

Starting restore at 28-NOV-2026 12:47:22
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK

channel ORA_DISK_1: looking for AUTOBACKUP on day: 20261128
channel ORA_DISK_1: AUTOBACKUP found: /backup/cf_c-2297484771-20261128-09
channel ORA_DISK_1: restoring control file from AUTOBACKUP /backup/cf_c-2297484771-20261128-09
channel ORA_DISK_1: control file restore from AUTOBACKUP complete
output file name=/u01/app/oracle/oradata/ORCL/control01.ctl
Finished restore at 28-NOV-2026 12:47:22
```

👀 **Lire la sortie.** `AUTOBACKUP found: /backup/cf_c-<DBID>-<date>-<n>` : RMAN a trouvé **la plus récente**. Puis `control file restore from AUTOBACKUP complete` et `output file name=…/control01.ctl` : le fichier de contrôle est refait à sa place (le second est recréé à partir du premier).

⚠️ **Piège.** Sans `SET DBID`, RMAN ne sait pas **quelle** auto-sauvegarde chercher : `RMAN-06172`. C'est l'usage du DBID **noté à l'avance**.

### Montage et récupération

🧠 **Comprendre.** Le fichier de contrôle restauré dit que la base est « plus ancienne » que ses fichiers de données ; les journaux comblent l'écart.

```
SQL> ALTER DATABASE MOUNT;
SQL> SELECT name, log_mode FROM v$database;
Database altered.

NAME LOG_MODE
---- ----------
ORCL ARCHIVELOG

1 row selected.
```

```
RMAN> RECOVER DATABASE;
connected to target database: ORCL (DBID=2297484771)

Starting recover at 28-NOV-2026 12:47:22
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
starting media recovery
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
media recovery complete, elapsed time: 00:00:01
Finished recover at 28-NOV-2026 12:47:23
```

### L'ouverture : `RESETLOGS`

🔧 **Manipuler.**

```
SQL> ALTER DATABASE OPEN;
SQL> ALTER DATABASE OPEN RESETLOGS;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01589: must use RESETLOGS or NORESETLOGS option for database open

Database altered.

COMMANDES
---------
       12

1 row selected.
```

👀 **Lire la sortie.** Le premier `OPEN` est refusé : `ORA-01589: must use RESETLOGS or NORESETLOGS`. Un fichier de contrôle **restauré** n'est plus « celui de la base vivante » : Oracle exige `OPEN RESETLOGS`, qui crée une **nouvelle incarnation**. Les commandes sont toutes là.

🧠 **Réflexe après tout `RESETLOGS` :** faire **immédiatement** une nouvelle sauvegarde complète. La précédente est celle d'une incarnation antérieure : on peut s'en servir, mais on ne veut pas dépendre d'elle.

```
RMAN> LIST INCARNATION;
RMAN> BACKUP DATABASE PLUS ARCHIVELOG TAG 'POST_RESETLOGS';
connected to target database: ORCL (DBID=2297484771)

List of Database Incarnations
=============================
DB Key  Inc Key DB Name  DB ID            STATUS  Reset SCN  Reset Time
------- ------- -------- ---------------- ------- ---------- ----------
1       1       ORCL     2297484771       PARENT  1          2026-11-28
1       2       ORCL     2297484771       CURRENT 1000338    2026-11-28

Starting backup at 28-NOV-2026 12:47:23
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/backup/ORCL_20261128_0atp7q6z_1_1.bkp tag=POST_RESETLOGS
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 28-NOV-2026 12:48:02

Starting backup at 28-NOV-2026 12:48:02
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
channel ORA_DISK_1: starting archived log backup set
channel ORA_DISK_1: specifying archived log(s) in backup set
piece handle=/backup/ORCL_20261128_0btp7q82_1_1.bkp tag=TAG20261128T124802
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 28-NOV-2026 12:48:41

Starting backup at 28-NOV-2026 12:48:41
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=102 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
including current control file in backup set
piece handle=/backup/cf_c-2297484771-20261128-12 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 28-NOV-2026 12:48:42
```

👀 **Lire la sortie.** `LIST INCARNATION` montre l'incarnation d'origine (`PARENT`) et la nouvelle (`CURRENT`).

### ✅ La leçon

Trois réflexes qui sauvent : **noter le DBID hors de la base**, **activer l'auto-sauvegarde du fichier de contrôle**, **sauvegarder après tout `RESETLOGS`**.

### 🧪 Vérifie-toi (chapitre 11)

1. Pourquoi l'instance est-elle laissée en `NOMOUNT` ? <details><summary>Réponse</summary>Parce qu'on n'a pas de fichier de contrôle : `NOMOUNT` est le seul état qui n'en demande pas, et RMAN peut s'y connecter.</details>
2. Que se passe-t-il si on oublie `SET DBID` ? <details><summary>Réponse</summary>RMAN ne sait pas quelle auto-sauvegarde chercher : `RMAN-06172`.</details>
3. Pourquoi `RESETLOGS` est-il obligatoire ici ? <details><summary>Réponse</summary>Le fichier de contrôle restauré n'est pas celui de la base vivante : Oracle ouvre une nouvelle incarnation.</details>

---

## 12. Panne n° 3 — Un `DROP TABLE` en production : retour dans le temps

> 🎯 **Objectif** — Réparer une **erreur humaine** : aucun fichier n'est perdu, la base est saine, mais il manque des données. Tu apprends le **retour à un instant précis** (`UNTIL SCN`) et ses conséquences (`RESETLOGS`, incarnations).

### La situation

📧 *Le développeur :* « J'ai supprimé la table des paiements en prod. » Aucun fichier n'est perdu ; tout fonctionne… sauf qu'**il manque les paiements**. Le site de reprise **ne résout pas** ce cas (il a rejoué le `DROP TABLE` aussi) ; la sauvegarde le résout, grâce au **SCN**.

🧠 **Comprendre.** Le **SCN** est l'horloge de la base : un nombre qui augmente à chaque changement validé. « Revenir à 14 h 02 » se traduit par « revenir au SCN 1234567 ». En pratique, on retrouve cet instant dans les journaux, dans l'audit, ou en demandant à l'utilisateur « vers quelle heure ? ».

### Le plan en quatre étapes

1. **Noter** le SCN d'*avant* l'erreur ;
2. arrêter la base et la **monter** ;
3. **restaurer et récupérer jusqu'à ce SCN** (`RUN { SET UNTIL SCN … ; RESTORE ; RECOVER }`) ;
4. ouvrir avec **`RESETLOGS`**.

### Noter l'instant juste avant

🔧 **Manipuler.** On crée d'abord une commande **témoin** (la `2001`) : si elle réapparaît à la fin, c'est la preuve que l'on est revenu **après** elle et **avant** l'erreur. On relève aussi le nombre de paiements et le SCN :

```
SQL> INSERT INTO shop.orders VALUES (2001, 1, SYSDATE, 'NEW', 99.5);
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT COUNT(*) AS paiements FROM shop.payments;
SQL> SELECT current_scn FROM v$database;
1 row created.

Commit complete.

System altered.

PAIEMENTS
---------
        6

1 row selected.

CURRENT_SCN
-----------
    1000344

1 row selected.
```

👀 **Lire la sortie.** Le nombre de paiements, puis le **SCN** `1000344` : c'est notre **point de retour**.

### L'erreur

```
SQL> DROP TABLE shop.payments CASCADE CONSTRAINTS PURGE;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> SELECT COUNT(*) FROM shop.payments;
Table dropped.

System altered.
SELECT COUNT(*) FROM shop.payments
*
ERROR at line 1:
ORA-00942: table or view does not exist
```

👀 **Lire la sortie.** `Table dropped.` puis `ORA-00942: table or view does not exist` : la table est partie, **définitivement** (`PURGE`).

### Revenir dans le temps

🔧 **Manipuler.** On arrête, on monte, et on restaure **jusqu'au SCN**. Les deux commandes sont dans un bloc `RUN { … }` pour que le `SET UNTIL` s'applique aux deux :

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.
```

```
RMAN> RUN {
RMAN>   SET UNTIL SCN 1000344;
RMAN>   RESTORE DATABASE;
RMAN>   RECOVER DATABASE;
RMAN> }
connected to target database: ORCL (DBID=2297484771)

executing command: SET until clause

Starting restore at 28-NOV-2026 12:48:42
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile backup set restore
[... 17 lignes omises ...]
starting media recovery
archived log for thread 1 with sequence 1 is already on disk as file /u01/app/oracle/archivelog/1_1_arc.arc
archived log for thread 1 with sequence 2 is already on disk as file /u01/app/oracle/archivelog/1_2_arc.arc
archived log for thread 1 with sequence 3 is already on disk as file /u01/app/oracle/archivelog/1_3_arc.arc
archived log for thread 1 with sequence 4 is already on disk as file /u01/app/oracle/archivelog/1_4_arc.arc
media recovery complete, elapsed time: 00:00:01
Finished recover at 28-NOV-2026 12:49:23
```

👀 **Lire la sortie.** `SET UNTIL SCN 1000344` **borne** le travail : RMAN choisit la sauvegarde la plus récente **antérieure** à ce SCN, la restaure, puis ne rejoue les journaux **que jusqu'à ce SCN**. Les modifications d'après — dont le `DROP TABLE` — sont **ignorées**.

### L'ouverture avec `RESETLOGS`

```
SQL> ALTER DATABASE OPEN;
SQL> ALTER DATABASE OPEN RESETLOGS;
SQL> SELECT COUNT(*) AS paiements FROM shop.payments;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders WHERE order_id = 2001;
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01589: must use RESETLOGS or NORESETLOGS option for database open

Database altered.

PAIEMENTS
---------
        6

1 row selected.

COMMANDES
---------
        1

1 row selected.
```

👀 **Lire la sortie.** La table `PAYMENTS` est revenue **avec son contenu**, et la commande `2001` (créée *avant* l'erreur) aussi. Le premier `OPEN` est refusé (`ORA-01589`) : une récupération **incomplète** exige `RESETLOGS`.

### Les incarnations, et la sauvegarde d'après

🧠 **Comprendre.** `RESETLOGS` **ouvre une nouvelle « version de l'histoire »** de la base (une incarnation). Les journaux repartent d'une numérotation neuve, et les anciens ne s'appliquent plus à la nouvelle branche.

```
RMAN> LIST INCARNATION;
connected to target database: ORCL (DBID=2297484771)

List of Database Incarnations
=============================
DB Key  Inc Key DB Name  DB ID            STATUS  Reset SCN  Reset Time
------- ------- -------- ---------------- ------- ---------- ----------
1       1       ORCL     2297484771       PARENT  1          2026-11-28
1       2       ORCL     2297484771       PARENT  1000338    2026-11-28
1       3       ORCL     2297484771       CURRENT 1000348    2026-11-28
```

```
RMAN> BACKUP DATABASE PLUS ARCHIVELOG TAG 'APRES_PITR';
connected to target database: ORCL (DBID=2297484771)

Starting backup at 28-NOV-2026 12:49:23
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
channel ORA_DISK_1: specifying datafile(s) in backup set
channel ORA_DISK_1: backing up database
piece handle=/backup/ORCL_20261128_0dtp7qab_1_1.bkp tag=APRES_PITR
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 28-NOV-2026 12:50:02

Starting backup at 28-NOV-2026 12:50:02
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=101 device type=DISK
channel ORA_DISK_1: starting archived log backup set
channel ORA_DISK_1: specifying archived log(s) in backup set
piece handle=/backup/ORCL_20261128_0etp7qbe_1_1.bkp tag=TAG20261128T125002
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:39
Finished backup at 28-NOV-2026 12:50:41

Starting backup at 28-NOV-2026 12:50:41
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=102 device type=DISK
channel ORA_DISK_1: starting full datafile backup set
including current control file in backup set
piece handle=/backup/cf_c-2297484771-20261128-15 tag=AUTOBACKUP
channel ORA_DISK_1: backup set complete, elapsed time: 00:00:01
Finished backup at 28-NOV-2026 12:50:42
```

⚠️ **Piège : ce que tu as perdu.** En revenant au SCN `1000344`, tu perds tout ce qui est arrivé **après** — y compris des commandes légitimes passées entre-temps. Un retour dans le temps de **toute** la base est un instrument lourd ; en production on lui préfère souvent *Flashback Table* ou une restauration dans une **base auxiliaire** pour ne récupérer que la table. Ces techniques sortent du cadre de ce tutoriel.

### Variante : la méthode historique, sous SQL\*Plus

🧠 **Comprendre.** Avant RMAN, on récupérait « à la main » depuis SQL\*Plus, et les cours l'enseignent encore. Le principe est le même : une fois les fichiers **restaurés** (ici par RMAN), la commande `RECOVER DATABASE` rejoue les journaux. La forme `UNTIL CANCEL` demande une récupération **incomplète** : elle s'arrête quand on le décide.

🔧 **Manipuler.**

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.
```

```
RMAN> RESTORE DATABASE;
connected to target database: ORCL (DBID=2297484771)

Starting restore at 28-NOV-2026 12:50:42
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
channel ORA_DISK_1: starting datafile backup set restore
[... 9 lignes omises ...]
channel ORA_DISK_1: restore complete, elapsed time: 00:00:04
channel ORA_DISK_1: restoring datafile 00006 to /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:02
Finished restore at 28-NOV-2026 12:51:21
```

```
SQL> RECOVER DATABASE UNTIL CANCEL;
SQL> ALTER DATABASE OPEN;
SQL> ALTER DATABASE OPEN RESETLOGS;
SQL> SELECT COUNT(*) AS commandes FROM shop.orders;
Media recovery complete.
ALTER DATABASE OPEN
*
ERROR at line 1:
ORA-01589: must use RESETLOGS or NORESETLOGS option for database open

Database altered.

COMMANDES
---------
       13

1 row selected.
```

👀 **Lire la sortie.** `Media recovery complete.` : les journaux ont été rejoués. Et, comme pour toute récupération incomplète, le premier `OPEN` est refusé (`ORA-01589`) : **`RESETLOGS` est obligatoire**. C'est le même moteur que le `RECOVER` de RMAN, avec la même règle.

### ✅ La leçon

**Récupération incomplète ⇒ `OPEN RESETLOGS` ⇒ nouvelle incarnation ⇒ nouvelle sauvegarde.** Et un site de reprise ne remplace pas une sauvegarde.

### 🧪 Vérifie-toi (chapitre 12)

1. Pourquoi le site de reprise n'aurait-il pas pu corriger le `DROP TABLE` ? <details><summary>Réponse</summary>Il applique les mêmes journaux que la production : il a aussi supprimé la table.</details>
2. Que perd-on en revenant au SCN d'avant l'erreur ? <details><summary>Réponse</summary>Tout ce qui s'est passé **après** ce SCN, y compris des transactions légitimes.</details>
3. Quelle commande rend ces opérations cohérentes avec l'histoire de la base, et que crée-t-elle ? <details><summary>Réponse</summary>`ALTER DATABASE OPEN RESETLOGS` : elle crée une nouvelle incarnation.</details>

---

## 13. Qui a le droit de sauvegarder ? Accès, audit et journaux

> 🎯 **Objectif** — Comprendre qu'une sauvegarde est **aussi sensible que la base elle-même**, savoir qui peut la lancer, et constater que **chaque refus laisse une trace**.

🧠 **Comprendre.** Une sauvegarde contient **toute la base**, mots de passe hachés compris. Ceux qui peuvent la lancer — ou la restaurer — sont aussi puissants que le DBA. Chez Lumière, trois verrous se cumulent :

| Verrou | Où il est | Qui passe |
|---|---|---|
| Le **groupe `dba`** du système | Linux | Seuls ses membres se connectent `AS SYSDBA` / lancent `rman target /` |
| Le **volume NFS** | Exports de `BKP-HQ` | `rw` pour les bases du siège seulement ; `ro` pour le site de reprise |
| Les **journaux centralisés** | `LOG-HQ` (rsyslog) | Tout le monde est vu, **y compris les refus** |

### Un compte ordinaire essaie

🔧 **Manipuler.** Un stagiaire (compte `stagiaire`, simple utilisateur, **hors du groupe `dba`**) tente de lancer RMAN :

```
[root@ora-prd ~]# useradd -m stagiaire
[root@ora-prd ~]# sudo -u stagiaire rman target /
RMAN-00571: ===========================================================
RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============
RMAN-00571: ===========================================================
RMAN-00554: initialization of internal recovery manager package failed
RMAN-04005: error from target database:
ORA-01031: insufficient privileges
```

👀 **Lire la sortie.** `ORA-01031: insufficient privileges`, enveloppé dans `RMAN-00554` / `RMAN-04005` : *« erreur de la base cible »*. C'est la même erreur que celle de `root` au chapitre 1. La connexion « bequeath » (`rman target /` sans mot de passe) n'est possible que pour les membres du groupe **`dba`** : **c'est le système d'exploitation qui authentifie**.

### La trace

🧠 **Comprendre.** Cette tentative n'est pas perdue : elle est **auditée** côté base et inscrite au **journal d'alerte**.

🔧 **Manipuler.**

```
SQL> SELECT os_username, returncode FROM dba_audit_trail WHERE returncode = 1031;
OS_USERNAME RETURNCODE
----------- ----------
root              1031
stagiaire         1031

2 rows selected.
```

```
[oracle@ora-prd ~]$ grep -i "failed sysdba logon" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log | tail -2
2026-11-28 12:44:27: Failed SYSDBA logon: os_user=root not in dba group (ORA-01031)
2026-11-28 12:51:22: Failed SYSDBA logon: os_user=stagiaire not in dba group (ORA-01031)
```

👀 **Lire la sortie.** `stagiaire` est l'utilisateur système qui a essayé ; `1031` le code d'erreur. Un contrôle de sécurité efficace commence là : **chaque refus laisse une trace**, et la trace va au serveur de journaux (chapitre 8.6).

⚠️ **Piège.** « Donner le groupe `dba` pour que ça marche » est la mauvaise réponse : tu donnes le pouvoir de tout lire **et** de tout détruire. Le droit de sauvegarder se donne par un **compte dédié**, pas en élargissant `dba`.

✅ **À retenir.** *Qui peut sauvegarder = qui peut tout lire.* Contrôle d'accès + audit + journal central, **ensemble**.

### 🧪 Vérifie-toi (chapitre 13)

1. Qui peut lancer `rman target /` sans mot de passe ? <details><summary>Réponse</summary>Les membres du groupe Linux `dba`, et eux seuls (pas `root`).</details>
2. Où retrouve-t-on la trace d'une tentative refusée ? <details><summary>Réponse</summary>Dans l'audit de la base (`DBA_AUDIT_TRAIL`, code 1031), dans le journal d'alerte, et sur `LOG-HQ`.</details>

---

## 14. Panne n° 4 — Le siège brûle : le site de reprise

> 🎯 **Objectif** — Construire un **site de reprise vivant**, le tenir à jour **en continu**, comprendre les **trois modes de protection**, et **basculer** dessus sans perdre une transaction validée.

### La situation

📧 *Le réseau :* « Le siège est hors service. » `ORA-PRD`, `BKP-HQ`, tout. Les sauvegardes avaient été prises sur `BKP-HQ`… qui vient de brûler **avec** elles. Voilà pourquoi il faut un **site de reprise vivant**, qui reçoit les modifications **en continu**.

🧠 **Quelques mots avant de commencer.** Un **site de reprise** (*disaster recovery*, DR) est un second datacenter, loin du premier, relié par un **tunnel IPsec** tenu par les pare-feu **FortiGate**. Une **base de secours** (*standby*) est une **copie de la production** qui reçoit en continu ses journaux et les rejoue : elle reste « un pas derrière », prête à la remplacer. La production s'appelle alors la **primaire**.

### Le plan en cinq étapes

1. Vérifier que le **chemin** (le tunnel) est ouvert ;
2. Préparer la machine de secours (`NOMOUNT`) ;
3. **Dupliquer** la base active vers la standby (`DUPLICATE … FOR STANDBY`) ;
4. **Expédier** les journaux et les **appliquer** (à la main, puis avec le **broker**) ;
5. **Basculer** (`FAILOVER`) le jour du sinistre.

### 14.1 Le chemin est-il ouvert ?

🔧 **Manipuler.** Tout passe par le tunnel IPsec entre `FGT-HQ` et `FGT-DR` :

```
[root@fgt-hq ~]# get vpn ipsec tunnel summary
'to-dr' 203.0.113.2:0  selectors(total,up): 1/1  rx(pkt,err): 93/0  tx(pkt,err): 2/0
'to-ag1' 203.0.113.11:0  selectors(total,up): 1/1  rx(pkt,err): 8/0  tx(pkt,err): 0/0
'to-ag2' 203.0.113.12:0  selectors(total,up): 1/1  rx(pkt,err): 8/0  tx(pkt,err): 0/0
```

👀 **Lire la sortie.** `'to-dr'` : `selectors(total,up): 1/1` : le tunnel est établi. C'est lui que traverseront, **en trames chiffrées**, les fichiers de la base.

### 14.2 Préparer la machine de secours

🧠 **Comprendre.** `ORA-STB` doit être une **instance démarrée mais sans base** : `NOMOUNT` (chapitre 1.2).

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP NOMOUNT
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
```

### 14.3 Créer la standby depuis la base active

🧠 **Comprendre.** Depuis `ORA-PRD`, RMAN se connecte à la **cible** (la production) et à l'**auxiliaire** (la future standby, `10.20.30.10`), puis recopie toute la base **à travers le tunnel** :

🔧 **Manipuler.**

```
RMAN> CONNECT AUXILIARY sys/oracle@10.20.30.10:1521/ORCL;
RMAN> DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;
connected to target database: ORCL (DBID=2297484771)

connected to auxiliary database: ORCL

Starting Duplicate Db at 28-NOV-2026 12:51:22
allocated channel: ORA_DISK_1
channel ORA_DISK_1: SID=100 device type=DISK
contents of Memory Script:
{
   restore clone standby controlfile;
   sql clone "alter database mount standby database";
}
[... 11 lignes omises ...]
channel ORA_DISK_1: restore complete, elapsed time: 00:00:04
channel ORA_DISK_1: restoring datafile 00006 to /u01/app/oracle/oradata/ORCL/shop_idx01.dbf
channel ORA_DISK_1: restore complete, elapsed time: 00:00:02
sql statement: alter database mount standby database
recover clone database
Finished Duplicate Db at 28-NOV-2026 12:52:01
```

👀 **Lire la sortie.** `DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE` : *« fais-moi une standby de cette base, en lisant directement les fichiers de la base **ouverte** »*, sans sauvegarde intermédiaire. `DORECOVER` rejoue les journaux disponibles ; `NOFILENAMECHECK` autorise les mêmes noms de fichiers des deux côtés. Les octets des six fichiers de données ont **réellement traversé** le tunnel.

Sur `ORA-STB` :

```
SQL> SELECT database_role, open_mode, log_mode FROM v$database;
SQL> SELECT file#, name FROM v$datafile ORDER BY 1;
DATABASE_ROLE    OPEN_MODE LOG_MODE
---------------- --------- ----------
PHYSICAL STANDBY MOUNTED   ARCHIVELOG

1 row selected.

FILE# NAME
----- --------------------------------------------
    1 /u01/app/oracle/oradata/ORCL/system01.dbf
    2 /u01/app/oracle/oradata/ORCL/sysaux01.dbf
    3 /u01/app/oracle/oradata/ORCL/undotbs01.dbf
    4 /u01/app/oracle/oradata/ORCL/users01.dbf
    5 /u01/app/oracle/oradata/ORCL/shop_data01.dbf
    6 /u01/app/oracle/oradata/ORCL/shop_idx01.dbf

6 rows selected.
```

👀 **Lire la sortie.** `PHYSICAL STANDBY` + `MOUNTED` : c'est une standby ; les six fichiers de données y sont. (Une standby est toujours en `ARCHIVELOG`, car elle reçoit des journaux archivés.)

### 14.4 Expédier les journaux, les appliquer

🧠 **Comprendre.** Deux mécanismes, un de chaque côté :

- côté production, `log_archive_dest_2` dit **où envoyer** les journaux ;
- côté standby, la **récupération gérée** (*managed recovery*) les **applique**.

🔧 **Manipuler.**

```
SQL> ALTER SYSTEM SET log_archive_dest_2='SERVICE=10.20.30.10:1521/ORCL ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=ORCL_STB' SCOPE=BOTH;
SQL> ALTER SYSTEM SET log_archive_dest_state_2=ENABLE SCOPE=BOTH;
System altered.

System altered.
```

```
SQL> ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
Database altered.
```

### 14.4 bis — Préparer la réception : les *standby redo logs*

🧠 **Comprendre.** Quand la production envoie son redo en direct (modes `SYNC` et `ASYNC`), la standby a besoin d'un endroit où le **recevoir au fil de l'eau** : des **journaux de réception** (*standby redo logs*, SRL), distincts des journaux en ligne. Sans eux, le broker refuse de dire que tout va bien : il signale `ORA-16789: standby redo logs configured incorrectly`. On en crée un groupe sur **chaque** base (la primaire en aura besoin le jour où elle deviendra standby à son tour), de la même taille que les journaux en ligne.

🔧 **Manipuler.** Sur la production :

```
SQL> ALTER DATABASE ADD STANDBY LOGFILE GROUP 11 ('/u01/app/oracle/oradata/ORCL/srl11.log') SIZE 50M;
SQL> SELECT group#, thread#, bytes, status FROM v$standby_log;
Database altered.

GROUP# THREAD#    BYTES STATUS
------ ------- -------- ----------
    11       1 52428800 UNASSIGNED

1 row selected.
```

Et sur la standby :

```
SQL> ALTER DATABASE ADD STANDBY LOGFILE GROUP 11 ('/u01/app/oracle/oradata/ORCL/srl11.log') SIZE 50M;
SQL> SELECT group#, thread#, bytes, status FROM v$standby_log;
Database altered.

GROUP# THREAD#    BYTES STATUS
------ ------- -------- ----------
    11       1 52428800 UNASSIGNED

1 row selected.
```

👀 **Lire la sortie.** `Database altered.` : le groupe 11 existe, avec son fichier (`srl11.log`) sur le disque. `V$STANDBY_LOG` le montre `UNASSIGNED` : il n'est affecté à aucune primaire tant qu'aucun redo n'arrive. Dès qu'un `COMMIT` synchrone envoie le sien, le groupe passe `ACTIVE` (avec le DBID de la primaire et les octets utilisés) ; quand l'archive de ce journal arrive, il se libère.

### 14.5 Le broker : la même chose, gérée pour toi

🧠 **Comprendre.** Ces deux commandes, le **Data Guard Broker** les exécute à ta place. Son interface est un programme, **`dgmgrl`**, qui garde une **configuration** : *qui est la primaire, quelles sont les standbys, comment les journaux circulent*. `CREATE CONFIGURATION` la nomme, `ADD DATABASE` déclare la standby **par son identifiant de connexion**, `ENABLE CONFIGURATION` l'active (le broker pose la destination d'archivage et démarre l'application sur la standby par une session Oracle Net).

🔧 **Manipuler.**

```
[oracle@ora-prd ~]$ dgmgrl / <<'E'
CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;
ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS 10.20.30.10:1521/ORCL MAINTAINED AS PHYSICAL;
ENABLE CONFIGURATION;
SHOW CONFIGURATION;
E
DGMGRL for Linux: Release 19.0.0.0.0 - Production

Welcome to DGMGRL, type "help" for information.
Connected to "ORCL"
Connected as SYSDBA.
DGMGRL> CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl
Configuration "lumiere_dg" created with primary database "ORCL"
DGMGRL> ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS 10.20.30.10:1521/ORCL MAINTAINED AS PHYSICAL
Database "ORCL_STB" added
DGMGRL> ENABLE CONFIGURATION
Enabled.
DGMGRL> SHOW CONFIGURATION

Configuration - lumiere_dg

  Protection Mode: MaxPerformance
  Members:
  ORCL - Primary database
  ORCL_STB - Physical standby database
Fast-Start Failover: DISABLED

Configuration Status:
SUCCESS   (status updated 0 seconds ago)
```

👀 **Lire la sortie.** `Configuration Status: SUCCESS` : tout va bien. S'il y avait une erreur de transport, tu la lirais ici (`ORA-16778`) : c'est la commande de **supervision** d'un environnement Data Guard.

Le broker **copie la configuration sur chaque membre** : tu peux la relire depuis la **standby**, sur `ORA-STB`, et obtenir la même réponse.

```
[oracle@ora-stb ~]$ dgmgrl / <<'E'
SHOW CONFIGURATION;
E
DGMGRL for Linux: Release 19.0.0.0.0 - Production

Welcome to DGMGRL, type "help" for information.
Connected to "ORCL"
Connected as SYSDBA.
DGMGRL> SHOW CONFIGURATION

Configuration - lumiere_dg

  Protection Mode: MaxPerformance
  Members:
  ORCL - Primary database
  ORCL_STB - Physical standby database
Fast-Start Failover: DISABLED

Configuration Status:
SUCCESS   (status updated 0 seconds ago)
```

👀 **Lire la sortie.** Même configuration, vue de l'autre côté : `ORCL` est la primaire, `ORCL_STB` la standby. Si le site de production brûle, c'est ici que tu retrouves *qui était qui*. Un **changement** (`EDIT`, `ADD`...) tapé ici est **routé vers la primaire** par le broker, qui l'applique et le replique.

### 14.6 Les trois modes de protection

🧠 **Comprendre.** Entre la **vitesse** et la **certitude de ne rien perdre**, Data Guard offre trois modes :

| Mode | Comment le redo part | Si la standby ne répond plus | Perte de données possible |
|---|---|---|---|
| `MAXIMUM PERFORMANCE` (défaut) | **Asynchrone** : à l'archivage du journal | La production continue | Les dernières transactions |
| `MAXIMUM AVAILABILITY` | **Synchrone** : chaque `COMMIT` attend l'accusé de la standby | La production **continue** et repasse en asynchrone (`RESYNCHRONIZATION`), puis revient | Aucune tant que la standby répond |
| `MAXIMUM PROTECTION` | Synchrone, **obligatoire** | La production **s'arrête** (`ORA-03113`) plutôt que de valider sans copie | **Jamais** |

Le broker ne laisse activer un mode synchrone que si un membre est lui-même **synchrone** (`LogXptMode='SYNC'`) : `ORA-16627` sinon.

🔧 **Manipuler.** On passe la standby en `SYNC`, puis la configuration en `MaxAvailability` :

```
[oracle@ora-prd ~]$ dgmgrl / <<'E'
EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;
EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';
EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;
SHOW CONFIGURATION;
E
DGMGRL for Linux: Release 19.0.0.0.0 - Production

Welcome to DGMGRL, type "help" for information.
Connected to "ORCL"
Connected as SYSDBA.
DGMGRL> EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability
Error: ORA-16627: operation disallowed since no standby databases would remain to support protection mode
DGMGRL> EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC'
Property "logxptmode" updated
DGMGRL> EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability
Succeeded.
DGMGRL> SHOW CONFIGURATION

Configuration - lumiere_dg

  Protection Mode: MaxAvailability
  Members:
  ORCL - Primary database
  ORCL_STB - Physical standby database
Fast-Start Failover: DISABLED

Configuration Status:
SUCCESS   (status updated 0 seconds ago)
```

```
SQL> SELECT protection_mode, protection_level FROM v$database;
PROTECTION_MODE      PROTECTION_LEVEL
-------------------- --------------------
MAXIMUM AVAILABILITY MAXIMUM AVAILABILITY

1 row selected.
```

👀 **Lire la sortie.** `PROTECTION_MODE` est le mode **demandé**, `PROTECTION_LEVEL` celui qui est **effectivement tenu** à cet instant (il passerait à `RESYNCHRONIZATION` si la standby se taisait, et à `UNPROTECTED` sans destination synchrone). `MAXIMUM PROTECTION` se règle de la même façon, mais base **montée** (`ORA-01126` sinon) : la production **s'arrêterait** à la première validation sans accusé.

### 14.6 bis — Armer la bascule automatique (*fast-start failover*)

🧠 **Comprendre.** Plus loin (14.8) c'est **toi** qui taperas `FAILOVER`. En production, personne n'est là à 3 h du matin : le **fast-start failover** confie la décision à un petit programme, l'**observateur** (*observer*), lancé sur une **troisième machine** pour qu'il ne tombe pas avec le siège. Il sonde la primaire toutes les 3 secondes ; si elle se tait depuis `FastStartFailoverThreshold` secondes (**30** par défaut) **et** que la standby répond, il fait lui-même le `FAILOVER` et ouvre la nouvelle primaire. Les commandes, dans l'ordre. L'observateur tourne ici sur `BKP-HQ`, une machine **qui ne porte pas la base** : la production peut brûler, lui reste debout.

🔧 **Manipuler.**

```
[oracle@bkp-hq ~]$ dgmgrl sys/oracle@10.10.30.10:1521/ORCL <<'E'
ENABLE FAST_START FAILOVER;
START OBSERVER observateur1;
SHOW FAST_START FAILOVER;
E
DGMGRL for Linux: Release 19.0.0.0.0 - Production

Welcome to DGMGRL, type "help" for information.
Connected to "ORCL"
Connected as SYSDBA.
DGMGRL> ENABLE FAST_START FAILOVER
Warning: ORA-16827: Flashback Database is disabled
Enabled in Zero Data Loss Mode.
DGMGRL> START OBSERVER observateur1
Observer started
DGMGRL> SHOW FAST_START FAILOVER
Fast-Start Failover: Enabled in Zero Data Loss Mode
  Protection Mode:    MaxAvailability
  Lag Limit:          0 seconds
  Threshold:          30 seconds
  Ping Interval:      3000 milliseconds
  Ping Retry:         0
  Active Target:      ORCL_STB
  Potential Targets:  "ORCL_STB"
    ORCL_STB valid
  Observer:           bkp-hq
  Shutdown Primary:   TRUE
  Auto-reinstate:     TRUE
  Observer Reconnect: (none)
  Observer Override:  FALSE
Configurable Failover Conditions
  Health Conditions:
    Corrupted Controlfile          YES
    Corrupted Dictionary           YES
    Inaccessible Logfile            NO
    Stuck Archiver                  NO
    Datafile Write Errors          YES
  Oracle Error Conditions:
    (none)
```

👀 **Lire la sortie.** `Enabled in Zero Data Loss Mode.` : la bascule automatique est armée, *sans perte possible* puisque la standby est en `SYNC`. `Observer started` : l'observateur surveille. Dans `SHOW FAST_START FAILOVER`, retiens `Threshold: 30 seconds` (le silence toléré), `Active Target: ORCL_STB` (qui sera promue) et `Observer:` (qui surveille). Quelques secondes plus tard, l'observateur est enregistré et il a déjà sondé les deux bases :

```
[oracle@bkp-hq ~]$ dgmgrl sys/oracle@10.10.30.10:1521/ORCL <<'E'
SHOW OBSERVER;
E
DGMGRL for Linux: Release 19.0.0.0.0 - Production

Welcome to DGMGRL, type "help" for information.
Connected to "ORCL"
Connected as SYSDBA.
DGMGRL> SHOW OBSERVER
Configuration - lumiere_dg
Primary:               ORCL
Active Target Standby: ORCL_STB
Observer "observateur1" - Master
   Host Name:              bkp-hq
   Last Ping to Primary:   0 seconds ago
   Last Ping to Target:    3 seconds ago
```

Deux conditions, que le simulateur vérifie : le mode de protection doit être `MaxAvailability` et la standby doit être en `SYNC` (sinon `ORA-16693`). Tant qu'aucun observateur n'est démarré, `SHOW CONFIGURATION` affiche `ORA-16819: fast-start failover observer not started` sous chaque membre. `STOP OBSERVER` et `DISABLE FAST_START FAILOVER` ferment la porte.

> ℹ️ Le **déclenchement** (la primaire se tait 30 secondes, l'observateur bascule seul) n'est pas rejoué ici : le 14.8 bascule à la main juste après, et la base ne peut tomber qu'une fois. C'est le test `oracle-dgmgrl-observer` du dépôt qui le rejoue de bout en bout : la bascule au bout du seuil, rien avant, l'arrêt de l'observateur, la désactivation et le refus d'un quatrième observateur.

### 14.7 Une commande tombe, elle arrive de l'autre côté

🔧 **Manipuler.** Deux commandes validées : la `3001`, suivie d'un **changement de journal**, et la `3002`, validée **sans** changement de journal.

```
SQL> INSERT INTO shop.orders VALUES (3001, 2, SYSDATE, 'NEW', 42);
SQL> COMMIT;
SQL> ALTER SYSTEM SWITCH LOGFILE;
SQL> INSERT INTO shop.orders VALUES (3002, 3, SYSDATE, 'NEW', 17);
SQL> COMMIT;
SQL> SELECT dest_id, status, destination FROM v$archive_dest WHERE dest_id <= 2;
1 row created.

Commit complete.

System altered.

1 row created.

Commit complete.

DEST_ID STATUS DESTINATION
------- ------ --------------------------
      1 VALID  /u01/app/oracle/archivelog
      2 VALID  10.20.30.10:1521/ORCL

2 rows selected.
```

Maintenant, lisons côté standby (qu'on ouvre en **lecture seule** après avoir arrêté l'application) :

```
SQL> SELECT COUNT(*) AS logs_appliques FROM v$archived_log WHERE applied = 'YES';
SQL> ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
SQL> ALTER DATABASE OPEN READ ONLY;
SQL> SELECT COUNT(*) AS commande_3001 FROM shop.orders WHERE order_id = 3001;
SQL> SELECT COUNT(*) AS commande_3002 FROM shop.orders WHERE order_id = 3002;
LOGS_APPLIQUES
--------------
             1

1 row selected.

Database altered.

Database altered.

COMMANDE_3001
-------------
            1

1 row selected.

COMMANDE_3002
-------------
            1

1 row selected.
```

👀 **Lire la sortie.** `APPLIED = 'YES'` : les journaux sont appliqués. La `3001` est là parce que **son journal a été archivé et expédié**. La `3002`, elle, **n'a pas eu de journal archivé** : elle est lisible quand même, parce qu'en mode synchrone **son `COMMIT` a envoyé son redo à la standby avant de rendre la main**. C'est ce qui fait un RPO **réellement nul**.

### 14.8 Le sinistre et la bascule

🔧 **Manipuler.** On éteint brutalement la production : le siège est perdu.

```
SQL> SHUTDOWN ABORT
Database closed.
Database dismounted.
ORACLE instance shut down.
```

Sur le site de reprise, on **promeut** la standby :

```
SQL> SHUTDOWN IMMEDIATE
SQL> STARTUP MOUNT
SQL> ALTER DATABASE FAILOVER TO ORCL;
SQL> ALTER DATABASE OPEN;
SQL> SELECT database_role, open_mode FROM v$database;
SQL> SELECT COUNT(*) AS commande_3001 FROM shop.orders WHERE order_id = 3001;
SQL> SELECT COUNT(*) AS commande_3002 FROM shop.orders WHERE order_id = 3002;
Database closed.
Database dismounted.
ORACLE instance shut down.

ORACLE instance started.

Total System Global Area  536870912 bytes
Fixed Size                  2097152 bytes
Variable Size             167772160 bytes
Database Buffers          268435456 bytes
Redo Buffers                8388608 bytes
Database mounted.

Database altered.

Database altered.

DATABASE_ROLE OPEN_MODE
------------- ----------
PRIMARY       READ WRITE

1 row selected.

COMMANDE_3001
-------------
            1

1 row selected.

COMMANDE_3002
-------------
            1

1 row selected.
```

👀 **Lire la sortie.** `ALTER DATABASE FAILOVER TO ORCL` fait de la standby la **base primaire**, ouverte en `READ WRITE`. Les commandes `3001` **et** `3002` sont là : **aucune transaction validée n'a été perdue**. Il ne reste qu'à pointer les frontaux web (`WEB-DR`) sur cette base. (Avec le broker, la même opération se tape `FAILOVER TO 'ORCL_STB'` dans `dgmgrl`, connecté à la standby ; la bascule **programmée** depuis la production est `SWITCHOVER TO 'ORCL_STB'`.)

⚠️ **Piège.** Un `FAILOVER` est **à sens unique** : l'ancienne primaire, si elle revient, **ne peut plus rejoindre** la configuration sans être reconstruite. Un `SWITCHOVER`, lui, est réversible : c'est l'opération **planifiée**.

### ✅ La leçon

Le site de reprise répond au **sinistre de site** ; la sauvegarde répond à l'**erreur humaine** ; il faut **les deux**. Et le **mode de protection** est une décision d'entreprise (RPO) avant d'être un réglage technique.

### 🧪 Vérifie-toi (chapitre 14)

1. Pourquoi la commande `3002` est-elle lisible sur la standby sans journal archivé ? <details><summary>Réponse</summary>En mode synchrone, le `COMMIT` envoie son redo à la standby et attend l'accusé avant de rendre la main.</details>
2. Que se passe-t-il, sous `MAXIMUM AVAILABILITY`, si la standby se tait ? <details><summary>Réponse</summary>La production continue ; le niveau de protection passe à `RESYNCHRONIZATION` jusqu'au retour de la standby.</details>
3. Quelle différence entre `SWITCHOVER` et `FAILOVER` ? <details><summary>Réponse</summary>Switchover : bascule **planifiée** et réversible, les deux sites sont vivants. Failover : bascule d'**urgence**, l'ancienne primaire est présumée perdue.</details>

---

## 15. Que faire quand ? L'arbre de décision

> 🎯 **Objectif** — Savoir **quelle réparation choisir** devant un symptôme, sans repartir du début du tutoriel. À garder sous les yeux pendant une garde.

🧠 **Comprendre.** Devant une panne, on **diagnostique d'abord** (quel message, quelle ligne `ORA-`), puis on choisit. Voici le raisonnement, **de haut en bas** :

```
La base répond-elle ?
├── NON, l'instance ne démarre pas jusqu'à MOUNT
│     ├── ORA-00205 / « control file » ............. chapitre 11  (restaurer le fichier de contrôle)
│     └── sinon ................................... lire l'alerte : adrci / alert_ORCL.log
├── NON, elle monte mais n'ouvre pas
│     └── ORA-01157 + ORA-01110 « data file n » ..... chapitre 10  (RESTORE + RECOVER DATAFILE n)
├── OUI, mais un tablespace est illisible (ORA-00376)
│     └── ................................ chapitre 10  variante en ligne (OFFLINE, RESTORE, ONLINE)
├── OUI, mais des données ont disparu / une table a été supprimée
│     └── ................................ chapitre 12  (RESTORE + RECOVER jusqu'à un SCN, RESETLOGS)
└── Le site entier est perdu
      └── ................................ chapitre 14  (FAILOVER sur la standby)
```

| Symptôme | Cause probable | Réparation | Reperdre des données ? |
|---|---|---|---|
| `ORA-01157` + `ORA-01110` | Un fichier de données manque | `RESTORE DATAFILE n; RECOVER DATAFILE n;` | **Non** |
| `ORA-00205` au montage | Plus de fichier de contrôle | `SET DBID`, `RESTORE CONTROLFILE FROM AUTOBACKUP`, `MOUNT`, `RECOVER`, `OPEN RESETLOGS` | **Non** (si journaux présents) |
| Table / lignes supprimées par erreur | Erreur humaine | `UNTIL SCN`, `OPEN RESETLOGS` | **Oui** : tout ce qui suit le SCN |
| Datacenter perdu | Sinistre | `FAILOVER` sur la standby | **Non** en mode synchrone |
| `ORA-00257` | Zone d'archivage pleine | `BACKUP ARCHIVELOG ALL DELETE INPUT` | **Non** |

✅ **À retenir.** Trois questions : *qu'est-ce qui est cassé ? (le message) — que dit la base qui reste ? (l'état) — jusqu'où veux-je revenir ? (la borne)*.

---

## 16. Exercices

> 🎯 **Objectif** — T'entraîner, du plus facile au plus ouvert. Chacun se fait dans le lab rouvert (importe `topology.json` pour repartir d'un état propre). **Essaie avant de lire le corrigé.**

### Niveau 1 — Comprendre

1. **Qui est qui ?** Sans regarder, explique la différence entre *instance* et *base*, puis entre `NOMOUNT`, `MOUNT` et `OPEN`. <details><summary>Corrigé</summary>L'instance : processus et mémoire ; la base : fichiers. `NOMOUNT` : l'instance tourne, aucun fichier n'est lu ; `MOUNT` : le fichier de contrôle est lu, les fichiers sont fermés (l'état où l'on restaure) ; `OPEN` : tout est ouvert.</details>
2. **Pourquoi pas root ?** Lance `sqlplus / as sysdba` en root, puis en `oracle`. Qu'est-ce qui explique la différence ? <details><summary>Corrigé</summary>`oracle` est membre du groupe `dba`, pas `root`. Vérifie avec `id root` et `id oracle`.</details>
3. **Restore ou recover ?** « Je remets le fichier tel qu'il était à la sauvegarde » ; « je rejoue le journal sur ce fichier ». <details><summary>Corrigé</summary>`RESTORE` ; puis `RECOVER`. Toujours dans cet ordre.</details>

### Niveau 2 — Pratiquer

4. **Perte d'un fichier d'index.** Détruis `shop_idx01.dbf` (fichier 6), redémarre en `MOUNT`, restaure-le et récupère-le. *Indice : le chapitre 10 pour un autre numéro de fichier.* <details><summary>Corrigé</summary>`RESTORE DATAFILE 6;` puis `RECOVER DATAFILE 6;`, suivis de `ALTER DATABASE OPEN;` côté SQL\*Plus.</details>
5. **Le niveau 1 sert-il à quelque chose ?** Après un niveau 0 et un niveau 1, restaure `SHOP_DATA`. Quelles pièces RMAN lit-il ? *Indice : `LIST BACKUP SUMMARY`, colonne `LV`.* <details><summary>Corrigé</summary>Le niveau 0 puis le niveau 1 : RMAN part de la référence et applique ce qui a changé ensuite.</details>
6. **Une pièce disparaît.** Supprime à la main (`rm` sur `BKP-HQ`) la pièce du niveau 0, puis lance `CROSSCHECK BACKUP`. Que devient son statut ? Que répond `RESTORE DATABASE VALIDATE` ? <details><summary>Corrigé</summary>La pièce passe `EXPIRED` ; `RESTORE DATABASE VALIDATE` échoue faute de pièce ; `DELETE EXPIRED BACKUP` nettoie le catalogue — et il faut refaire un niveau 0.</details>
7. **Un journal archivé disparaît.** Supprime un fichier `.arc`, lance `CROSSCHECK ARCHIVELOG ALL`. Que lis-tu ? <details><summary>Corrigé</summary>`validation failed for archived log` + le nom du fichier absent. Le journal est marqué `EXPIRED` (`SELECT status FROM v$archived_log` → `X`).</details>

### Niveau 3 — Raisonner

*Ces exercices sont ouverts : il n'y a pas de corrigé unique, mais chacun se vérifie par une sortie que tu sais maintenant lire (voir le chapitre indiqué dans l'arbre de décision, chapitre 15).*

8. **Heure plutôt que SCN.** Refais le chapitre 12 avec `SET UNTIL TIME`. *Indice : `SELECT SYSDATE FROM dual` ; le format dépend de `NLS_DATE_FORMAT`.*
9. **Qui a lancé cette sauvegarde ?** Donne à `stagiaire` le groupe `dba` (`usermod -aG dba stagiaire`) et fais-lui lancer `rman target /`. Qu'est-ce qui change ? Et dans les journaux de `LOG-HQ` ? *Indice : il faut une nouvelle session pour que les groupes soient pris en compte.*
10. **Repartir à zéro.** Après la bascule du chapitre 14, que faudrait-il pour que le siège reconstruit redevienne un site de secours de `ORA-STB` ? *Indice : le même `DUPLICATE`, dans l'autre sens.*
11. **Mesurer ton RTO.** Chronomètre chaque panne (le temps simulé est dans les sorties : `elapsed time`). Laquelle est la plus longue ? Pourquoi ?
12. **Choisir un mode de protection.** Lumière peut-il accepter de **perdre** 30 secondes de commandes ? Quel mode de protection choisis-tu, et que se passe-t-il si le lien avec le site de reprise est coupé ? <details><summary>Corrigé</summary>Si oui : `MAXIMUM PERFORMANCE` (asynchrone, aucun frein). Si non : `MAXIMUM AVAILABILITY` (la boutique continue, mais en `RESYNCHRONIZATION`, donc non protégée, le temps de la coupure). `MAXIMUM PROTECTION` arrêterait la boutique à la coupure : à n'accepter que si la perte de données est **pire** que l'arrêt.</details>

---

## 17. Les erreurs que tu rencontreras

> 🎯 **Objectif** — Reconnaître une erreur **au premier coup d'œil** et savoir où aller. **Lire une erreur RMAN** : ignore l'encadré `RMAN-00571 / RMAN-00569` (c'est le décor). La **dernière** ligne numérotée dit la vraie raison, et très souvent elle est suivie d'un code `ORA-` qui donne la cause côté base.

| Code | Message | Cause | Solution |
|---|---|---|---|
| `ORA-01157` + `ORA-01110` | cannot identify/lock data file *n* | Le fichier *n* est absent ou illisible | `RESTORE DATAFILE n; RECOVER DATAFILE n;` (base en `MOUNT`) |
| `ORA-00376` | file *n* cannot be read at this time | Le tablespace est hors ligne ou le fichier attend une récupération | `RESTORE TABLESPACE …; RECOVER TABLESPACE …;` puis `ONLINE` |
| `ORA-00205` | error in identifying control file | Aucun fichier de contrôle lisible | `STARTUP NOMOUNT` puis `RESTORE CONTROLFILE FROM AUTOBACKUP` |
| `ORA-01589` | must use RESETLOGS or NORESETLOGS option | Récupération incomplète ou fichier de contrôle restauré | `ALTER DATABASE OPEN RESETLOGS` |
| `ORA-01139` | RESETLOGS option only valid after an incomplete recovery | `OPEN RESETLOGS` sans récupération incomplète | `ALTER DATABASE OPEN` simplement |
| `ORA-01031` | insufficient privileges | L'utilisateur du système n'est pas dans le groupe `dba` | Se connecter en `oracle` (ne pas élargir `dba` à la légère) |
| `ORA-01124` ¹ | cannot recover data file *n* - file is in use or recovery | `RECOVER` lancé base **ouverte** | Remettre la base en `MOUNT` |
| `RMAN-06149` | cannot BACKUP DATABASE in NOARCHIVELOG mode | Sauvegarde d'une base **ouverte** sans journaux archivés | Passer en `ARCHIVELOG` (chapitre 5), ou sauvegarder à froid en `MOUNT` |
| `RMAN-06172` | no autobackup found | `RESTORE CONTROLFILE FROM AUTOBACKUP` sans `SET DBID` ou mauvais format | `SET DBID`, `SET CONTROLFILE AUTOBACKUP FORMAT … %F` |
| `RMAN-06026` | no backup … to satisfy the requested SET UNTIL bound | Aucune sauvegarde **antérieure** au SCN demandé | Un SCN plus récent, ou une sauvegarde plus ancienne |
| `RMAN-06023` | no backup found to restore | Le catalogue ne connaît aucune sauvegarde | `LIST BACKUP` ; `CATALOG START WITH '/backup'` |
| `RMAN-06053` / `RMAN-06025` | unable to perform media recovery because of missing log | Un journal est absent **et** introuvable dans une sauvegarde | Vérifier que `BACKUP ARCHIVELOG … DELETE INPUT` a réussi *avant* de supprimer |
| `RMAN-04005` / `RMAN-00554` | error from target database | La connexion à la cible a échoué (privilèges, instance arrêtée) | Lire **la ligne `ORA-` qui suit** |
| `ORA-00257` ¹ | archiver error | La zone d'archivage est pleine | `BACKUP ARCHIVELOG ALL DELETE INPUT` |
| `ORA-16072` | a minimum of one standby database destination is required | Mode de protection synchrone sans destination `SYNC` | Déclarer la destination en `SYNC AFFIRM` |
| `ORA-16627` | operation disallowed since no standby databases would remain to support protection mode | Mode synchrone demandé avec un membre `ASYNC` | `EDIT DATABASE … SET PROPERTY LogXptMode='SYNC'` |
| `ORA-03113` | end-of-file on communication channel | La session est coupée (ici, la primaire s'est arrêtée sous `MAXIMUM PROTECTION`) | Réparer la standby ou le lien, redémarrer la primaire |

¹ *Erreur réelle d'Oracle, décrite ici pour que tu la reconnaisses, mais que le simulateur ne produit pas (il n'a ni zone d'archivage limitée ni `RECOVER` base ouverte refusé).*

---

## 18. Aide-mémoire

**Préparer**

```
sqlplus / as sysdba   ->  @03_archivelog.sql        (ARCHIVELOG + FORCE LOGGING)
rman target /         ->  CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
                          CONFIGURE CONTROLFILE AUTOBACKUP ON;
                          CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/backup/cf_%F';
                          CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/backup/%d_%T_%U.bkp';
```

**Sauvegarder**

```
BACKUP DATABASE PLUS ARCHIVELOG TAG '...';
BACKUP INCREMENTAL LEVEL 0 DATABASE TAG '...';
BACKUP INCREMENTAL LEVEL 1 DATABASE TAG '...';
BACKUP ARCHIVELOG ALL DELETE INPUT;
```

**Vérifier**

```
LIST BACKUP SUMMARY;     LIST ARCHIVELOG ALL;     LIST INCARNATION;
REPORT SCHEMA;           REPORT NEED BACKUP;      REPORT OBSOLETE;
VALIDATE DATABASE;       RESTORE DATABASE VALIDATE;
CROSSCHECK BACKUP;       CROSSCHECK ARCHIVELOG ALL;       DELETE OBSOLETE NOPROMPT;
```

**Restaurer**

| Panne | Séquence |
|---|---|
| Un datafile, base arrêtée (`MOUNT`) | `RESTORE DATAFILE n; RECOVER DATAFILE n;` puis `ALTER DATABASE OPEN;` |
| Un tablespace, base ouverte | `ALTER TABLESPACE t OFFLINE IMMEDIATE;` → `RESTORE TABLESPACE t; RECOVER TABLESPACE t;` → `ALTER TABLESPACE t ONLINE;` |
| Les fichiers de contrôle | `STARTUP NOMOUNT` → `SET DBID n; SET CONTROLFILE AUTOBACKUP FORMAT …; RESTORE CONTROLFILE FROM AUTOBACKUP;` → `ALTER DATABASE MOUNT;` → `RECOVER DATABASE;` → `ALTER DATABASE OPEN RESETLOGS;` |
| Retour à un instant | `RUN { SET UNTIL SCN n; RESTORE DATABASE; RECOVER DATABASE; }` → `ALTER DATABASE OPEN RESETLOGS;` |
| Sinistre de site | `DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE …` (en amont) → `ALTER DATABASE FAILOVER TO …;` → `ALTER DATABASE OPEN;` |

**Recouvrement manuel sous SQL\*Plus** (base en `MOUNT`, fichiers restaurés)

```
RECOVER DATABASE;                      -- complète : ALTER DATABASE OPEN;
RECOVER DATABASE UNTIL CANCEL;         -- incomplète : ALTER DATABASE OPEN RESETLOGS;
RECOVER DATABASE UNTIL CHANGE n;       -- jusqu'à un SCN
```

**Data Guard**

```
dgmgrl /  ->  CREATE CONFIGURATION 'nom' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;
              ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS hote:1521/ORCL MAINTAINED AS PHYSICAL;
              ENABLE CONFIGURATION;   SHOW CONFIGURATION;
              EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';
              EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;
              SWITCHOVER TO 'ORCL_STB';        -- planifiée        FAILOVER TO 'ORCL_STB';  -- urgence
```

**Les trois réflexes**

1. **Note le DBID** hors de la base.
2. **Teste la restauration**, pas seulement la sauvegarde.
3. **Après tout `RESETLOGS`, sauvegarde.**

---

## 19. Ce que le simulateur fait comme Oracle — et ce qu'il ne fait pas

Un tutoriel honnête dit où s'arrête son terrain. Pendant la rédaction de ce tutoriel, **onze écarts** entre le simulateur et un vrai Oracle ont été mesurés ; **onze sont fermés** et le tutoriel s'appuie sur leur comportement réel :

| Ce qu'un vrai Oracle fait | Où le voir |
|---|---|
| `BACKUP DATABASE` sur une base **ouverte** en `NOARCHIVELOG` est refusé : `RMAN-06149` | chapitre 5 |
| `df -h` sur un volume NFS donne la taille lue sur le **serveur**, et `touch` met à jour la date d'un fichier distant | chapitre 4 |
| `root` n'est **pas** administrateur de la base : `ORA-01031` ; seul `oracle` (groupe `dba`) l'est | chapitres 1 et 13 |
| `RECOVER DATABASE [UNTIL …]` existe sous SQL\*Plus, et une récupération incomplète exige `RESETLOGS` | chapitre 12 |
| `CROSSCHECK BACKUP` couvre toutes les sauvegardes (journaux compris) ; `CROSSCHECK ARCHIVELOG ALL` contrôle les **fichiers** de journaux | chapitres 8 et 9 |
| Un journal archivé retiré du disque est signalé par `CROSSCHECK ARCHIVELOG ALL` et marqué `EXPIRED` (`STATUS = 'X'` dans `V$ARCHIVED_LOG`) | exercice 7 |
| Les modes de protection Data Guard sont **imposés** (redo synchrone au `COMMIT`, arrêt de la primaire sous `MAXIMUM PROTECTION`) et le broker (`dgmgrl`) existe | chapitre 14 |
| Les **standby redo logs** existent (`ALTER DATABASE ADD STANDBY LOGFILE`, `V$STANDBY_LOG`, un fichier par membre) et le broker les exige : `ORA-16789` sans eux, et le *fast-start failover* ne s'active pas | chapitre 14.4 bis |
| La configuration du broker est **répliquée** sur chaque membre : `SHOW CONFIGURATION` la lit aussi sur la standby | chapitre 14 |
| Un changement tapé sur une standby, ou dans une session `dgmgrl` distante, est **routé vers la primaire** par le broker | chapitre 14.5 |
| Le **fast-start failover** : `ENABLE FAST_START FAILOVER`, un **observateur** (`START OBSERVER`) qui sonde la primaire et bascule seul au bout du seuil | chapitre 14.6 bis (armement et observation rejoués) et test `oracle-dgmgrl-observer` (déclenchement) |

Ce qui reste hors du terrain :

| Écart | Ce que fait un vrai Oracle | Ce que fait le simulateur |
|---|---|---|
| Le broker : observateurs multiples avec bascule du maître | Fonctionnent | Le *fast-start failover* en mode **Zero Data Loss** est réel (voir le chapitre 14.6 bis) ; les autres modes ne sont pas implémentés, l'ancienne primaire se réinstalle avec `REINSTATE DATABASE` (Flashback Database, puis conversion en standby) ou seule, par l'observateur, et `START OBSERVER` rend la main au lieu de bloquer |
| Temps de sauvegarde et de restauration | Dépend du disque, du réseau et de la charge | Une **seule règle** : taille du fichier ÷ **50 Mo/s** (minimum 1 s), la même pour `BACKUP`, `RESTORE` et `RECOVER`, et l'horloge de la machine avance d'autant. Le débit est un **modèle**, pas une mesure de disque : compare les durées entre elles, pas à ta production |

---

## 20. Conclusion

### Ce que tu sais faire maintenant

Dans une infrastructure de 35 équipements, tu as :

- **compris** ce qu'est une base Oracle (instance, fichiers, journaux, SCN) et **parlé** à la base en SQL\*Plus ;
- **préparé** une base pour la sauvegarde (`ARCHIVELOG`, `FORCE LOGGING`) et **configuré** RMAN (rétention, auto-sauvegarde, destination réseau) ;
- **sauvegardé** par niveaux, **planifié** (cron), **journalisé** de façon centrale, **vérifié** (`VALIDATE`, `RESTORE … VALIDATE`, `CROSSCHECK`) ;
- **réparé** un fichier de données (base arrêtée et base ouverte), **reconstruit** les fichiers de contrôle depuis l'auto-sauvegarde, **remonté le temps** après un `DROP TABLE` ;
- **contrôlé** qui peut lancer une sauvegarde, et vu que chaque refus laisse une trace ;
- **monté** un site de reprise à travers un tunnel IPsec, choisi un **mode de protection**, et **basculé** dessus sans perdre une transaction validée.

### Auto-évaluation

Tu maîtrises le processus si tu sais, **sans regarder**, répondre à ces cinq questions :

1. Pourquoi `RESTORE` précède-t-il toujours `RECOVER` ?
2. Pourquoi note-t-on le DBID **à l'avance** ?
3. Pourquoi un site de reprise **ne remplace pas** une sauvegarde ?
4. Devant `ORA-01157` + `ORA-01110`, qu'est-ce qui est cassé, et quelles sont les trois commandes de réparation ?
5. Pourquoi `RESETLOGS` impose-t-il une nouvelle sauvegarde ?

Si l'une d'elles t'arrête, retourne au chapitre indiqué dans l'arbre de décision (chapitre 15).

> 🔁 Le lab est entièrement rejouable : `UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts` refait ce document à partir d'une exécution fraîche.
