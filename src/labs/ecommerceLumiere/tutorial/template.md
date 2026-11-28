# Oracle & RMAN dans une vraie infrastructure : le lab « Lumière Boutique »

> **À qui s'adresse ce tutoriel ?**
> À **toi qui débutes**. Il part de zéro : tu n'as besoin de connaître ni l'administration de bases de données, ni Oracle, ni RMAN, ni même le terminal Linux. La [partie 0](#0-les-bases--pour-partir-vraiment-de-zéro) explique chaque notion avant qu'elle serve. L'objectif : **comprendre et maîtriser la sauvegarde et la restauration d'une base Oracle avec RMAN**, non pas sur une machine isolée, mais dans une entreprise réaliste : plusieurs sites, plusieurs constructeurs, un site de reprise, des journaux centralisés, des accès contrôlés. Si tu cherches le cours de référence sur RMAN lui-même (toutes les commandes, une par une), ouvre d'abord `docs/tuto_rman.md` : ici on **applique** RMAN à une infrastructure complète, on casse des choses, et on les répare.

> **Ce tutoriel n'a pas été écrit à la main.** Chaque bloc de sortie ci-dessous est la réponse **réelle** du simulateur, capturée en rejouant toutes les commandes sur le lab rouvert depuis `labs/ecommerce-lumiere/topology.json`. Un test (`src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts`) refait ce parcours à chaque modification du simulateur : si une commande cessait de produire ce que le tutoriel annonce, il échouerait. Les dates, les numéros de séquence et les noms de pièces de sauvegarde changent d'une exécution à l'autre ; la structure, elle, ne change pas.

---

## Table des matières

0. [Les bases — pour partir vraiment de zéro](#0-les-bases--pour-partir-vraiment-de-zéro)
1. [L'entreprise et son problème](#1-lentreprise-et-son-problème)
2. [L'infrastructure du lab](#2-linfrastructure-du-lab)
3. [Les cinq notions à retenir](#3-les-cinq-notions-à-retenir)
4. [Étape 1 — Reconnaissance : qu'est-ce qu'on protège ?](#4-étape-1--reconnaissance--quest-ce-quon-protège-)
5. [Étape 2 — Passer la base en ARCHIVELOG](#5-étape-2--passer-la-base-en-archivelog)
6. [Étape 3 — Configurer RMAN une bonne fois pour toutes](#6-étape-3--configurer-rman-une-bonne-fois-pour-toutes)
7. [Étape 4 — La première sauvegarde](#7-étape-4--la-première-sauvegarde)
8. [Étape 5 — Une stratégie : niveau 0, niveau 1, journaux, cron](#8-étape-5--une-stratégie--niveau-0-niveau-1-journaux-cron)
9. [Étape 6 — Vérifier : une sauvegarde non testée n'existe pas](#9-étape-6--vérifier--une-sauvegarde-non-testée-nexiste-pas)
10. [Scénario A — Un datafile disparaît](#10-scénario-a--un-datafile-disparaît)
11. [Scénario B — Les fichiers de contrôle disparaissent](#11-scénario-b--les-fichiers-de-contrôle-disparaissent)
12. [Scénario C — Un `DROP TABLE` en production : retour dans le temps](#12-scénario-c--un-drop-table-en-production--retour-dans-le-temps)
13. [Accès, audit et journaux : qui a le droit de sauvegarder ?](#13-accès-audit-et-journaux--qui-a-le-droit-de-sauvegarder-)
14. [Scénario D — Le siège brûle : le site de reprise](#14-scénario-d--le-siège-brûle--le-site-de-reprise)
15. [Exercices](#15-exercices)
16. [Les erreurs que tu rencontreras](#16-les-erreurs-que-tu-rencontreras)
17. [Aide-mémoire](#17-aide-mémoire)
18. [Ce que le simulateur fait comme Oracle — et ce qu'il ne fait pas](#18-ce-que-le-simulateur-fait-comme-oracle--et-ce-quil-ne-fait-pas)
19. [Conclusion](#19-conclusion)

---

## 0. Les bases — pour partir vraiment de zéro

> **Pour qui ?** Pour toi qui n'as jamais administré une base de données, ou qui n'as jamais ouvert un terminal Linux. Rien n'est supposé connu. Si tu sais déjà ce qu'est une instance Oracle, un datafile et un `ARCHIVELOG`, saute directement à la [section 1](#1-lentreprise-et-son-problème).
>
> **Comment lire ces pages ?** Chaque notion est expliquée **avant** d'être utilisée, puis tu la **vois** dans le lab : les blocs de code sont de vraies sorties du simulateur. Ouvre le lab (section 2.1) et tape les commandes en même temps que tu lis ; rien ne peut casser, le lab se rouvre à l'état neuf à tout moment.

### 0.1 Une base de données, c'est quoi ?

Une **base de données** est un endroit organisé où un programme range des informations pour les retrouver vite et sans les perdre. Celle de Lumière Boutique contient les **clients**, les **produits**, les **commandes** et les **paiements** de la boutique.

L'information y est rangée dans des **tables**, comme des feuilles de tableur :

- une **table** = un sujet (les clients, les commandes…) ;
- une **ligne** = un élément (un client, une commande) ;
- une **colonne** = une caractéristique (le nom, la ville, le montant).

On parle à une base dans un langage qui s'appelle **SQL** (« langage de requêtes ») : on lui **pose des questions** (`SELECT`), on lui **ajoute** des lignes (`INSERT`), on les **modifie** (`UPDATE`), on les **supprime** (`DELETE`). Voici les trois premiers clients de la boutique :

{{step:zero-clients}}

Lis la première ligne de la réponse : `SELECT ... FROM shop.customers` veut dire « donne-moi ces colonnes, dans la table `customers` qui appartient au schéma `shop` ». Un **schéma** est le « dossier » d'un utilisateur de la base : `shop` est le compte de l'application de la boutique. La réponse est un petit tableau, une ligne par client.

> 💡 **À retenir** : une base de données n'est pas un fichier que l'on ouvre avec un éditeur. C'est un **logiciel** (ici **Oracle**) qui gère des fichiers pour toi, protège les données pendant que plusieurs personnes y écrivent en même temps, et sait refaire le travail après une panne. Ce tutoriel apprend à lui **faire survivre aux pannes**.

### 0.2 Oracle : une instance, une base, des fichiers

Quand on dit « la base Oracle », on parle en fait de **deux choses** qu'il faut distinguer :

| Terme | Ce que c'est | Où ça vit |
|---|---|---|
| **La base** (*database*) | Les **fichiers** sur le disque : les données et leurs journaux | Disque |
| **L'instance** | Les **programmes en cours d'exécution** et leur mémoire, qui ouvrent la base et répondent aux utilisateurs | Mémoire et processus |

On peut éteindre l'instance : la base (les fichiers) reste sur le disque. On peut démarrer l'instance sans ouvrir la base. Cette distinction explique les commandes `STARTUP NOMOUNT`, `MOUNT` et `OPEN` que tu verras partout :

| État de l'instance | Ce qui est fait | À quoi ça sert |
|---|---|---|
| `SHUTDOWN` | Rien ne tourne | Maintenance |
| `NOMOUNT` | Les processus et la mémoire sont démarrés, **aucun fichier** n'est lu | Recréer le fichier de contrôle (scénario B) |
| `MOUNT` | Le **fichier de contrôle** est lu : l'instance sait où sont les fichiers, sans les ouvrir | **Restaurer** des fichiers de données (scénario A) |
| `OPEN` | Les fichiers de données sont ouverts : les utilisateurs peuvent travailler | Fonctionnement normal |

On voit l'instance et la base avec deux **vues** (une vue est une « table » que la base tient à jour elle-même) :

{{step:zero-instance}}

Et on voit les **processus** de l'instance dans Linux : chacun a un rôle (`pmon` surveille les sessions, `smon` répare après un arrêt brutal, `dbw` écrit les données sur le disque, `lgwr` écrit le journal, `arc` archive le journal, `ckpt` marque les points de contrôle) :

{{step:zero-processus}}

Les **fichiers** de la base sont de quatre sortes, et la suite du tutoriel ne parle que d'eux :

| Fichier | Contenu | Pourquoi on s'en soucie |
|---|---|---|
| **Fichiers de données** (*datafiles*, `.dbf`) | Les tables et les index | C'est **ce qu'on sauvegarde** et ce qui peut disparaître |
| **Journaux de reprise** (*redo logs*) | La liste de **tous les changements**, dans l'ordre | Ils permettent de **rejouer** le travail fait depuis la dernière sauvegarde |
| **Fichiers de contrôle** (*control files*) | Le « sommaire » : où sont les fichiers, l'état de la base, **l'historique des sauvegardes** | Sans lui, la base ne peut pas démarrer |
| **Journaux archivés** (*archived logs*) | Les copies des journaux de reprise, rangées au lieu d'être écrasées | Ils permettent de revenir **jusqu'à la dernière transaction** |

Un **tablespace** est un regroupement logique de fichiers de données (« l'étagère » où l'on range des tables). Chez Lumière : `SHOP_DATA` (les tables) et `SHOP_IDX` (les index, qui accélèrent les recherches).

### 0.3 Le terminal Linux : dix commandes suffisent

Les serveurs Oracle tournent sous **Linux**. Tu les pilotes dans un **terminal** : tu tapes une commande après l'**invite** (le début de ligne qui t'indique **qui** tu es et **où**), tu lis la réponse.

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

Un **utilisateur** Linux a un numéro (`uid`) et appartient à des **groupes**. Ce sont les groupes qui décident de ce qu'on a le droit de faire. Regarde qui est l'utilisateur **`oracle`** : c'est le propriétaire du logiciel Oracle et des fichiers de la base.

{{step:zero-linux}}

(Les fichiers du simulateur sont de petites représentations : leurs tailles ne sont pas réalistes, seul leur **rôle** compte.)

Deux groupes comptent : **`oinstall`** (le groupe des fichiers du logiciel) et **`dba`** (*database administrators*). Être dans le groupe `dba` est ce qui donne le droit de se connecter à la base **sans mot de passe** comme administrateur (`AS SYSDBA`, voir 0.4). **L'administrateur Linux, `root`, n'en fait pas partie** : sur une vraie machine Oracle, `root` ne peut pas administrer la base. Le lab respecte cette règle :

{{step:zero-root-refuse}}

`ORA-01031: insufficient privileges` : *« tu n'as pas le droit »*. Les erreurs Oracle ont toutes la forme `ORA-` suivie d'un numéro de cinq chiffres ; on apprend à les reconnaître (section 16). **Règle d'or du tutoriel : on administre Oracle en tant qu'`oracle`, jamais en root.**

### 0.4 SQL*Plus : parler à la base

**SQL\*Plus** est le programme en ligne de commande d'Oracle : tu y tapes du SQL, il affiche les réponses. On le lance avec `sqlplus`. La forme que nous utilisons, `sqlplus / as sysdba`, veut dire :

- `/` : « ne me demande pas de mot de passe » (le système d'exploitation m'a déjà identifié) ;
- `as sysdba` : « connecte-moi avec le rôle d'administrateur de la base » — le plus puissant d'Oracle (démarrer, arrêter, restaurer). Il est réservé aux membres du groupe `dba`.

L'invite devient `SQL>`. Tout ce qui se termine par `;` est envoyé à la base :

{{step:zero-sqlplus}}

`SHOW USER` n'est pas du SQL : c'est une **commande SQL\*Plus** (elle n'a pas de `;`). `SELECT 'bonjour' AS message FROM dual;` est du SQL : `dual` est une table spéciale d'une seule ligne, qu'on utilise quand on veut juste calculer une valeur. `SYSDATE` est la date courante de la base. Pour quitter : `EXIT`.

Tu verras aussi des requêtes sur des noms qui commencent par `v$` ou `dba_` : ce sont les **vues du dictionnaire** — des tables que la base tient à jour pour parler d'elle-même (`v$database`, `v$datafile`, `dba_tablespaces`…). C'est là qu'un administrateur va lire l'état de la base.

### 0.5 Pourquoi sauvegarder, et de quoi ?

Une base de données peut être abîmée de trois façons très différentes, et **chacune demande une réponse différente** :

| Ce qui arrive | Exemple | Ce qui sauve |
|---|---|---|
| **Une panne matérielle ou fichier** | Un disque lâche, un fichier est effacé | **Restaurer** le fichier depuis une sauvegarde, puis **rejouer** les journaux |
| **Une erreur humaine** | Un `DROP TABLE` en production, un `DELETE` sans `WHERE` | **Revenir dans le temps** à un instant d'avant l'erreur |
| **Un sinistre de site** | Incendie, inondation, panne totale du datacenter | Un **site de reprise** déjà prêt, ailleurs |

Une image pour comprendre le vocabulaire. Imagine que tu écris un livre :

- La **sauvegarde** (*backup*) est une **photocopie** du livre à une date donnée.
- Les **journaux** sont un **cahier de notes** où tu écris *chaque modification* au moment où tu la fais.
- **Restaurer** (*restore*) = récupérer la photocopie (le livre tel qu'il était à cette date).
- **Récupérer** (*recover*) = **rejouer** le cahier de notes sur la photocopie pour la ramener à aujourd'hui.

On **restaure toujours avant de récupérer** : on ne peut pas rejouer des notes sur un livre qui n'existe plus. C'est LA règle de ce tutoriel.

Deux chiffres mesurent une bonne stratégie : le **RPO** (*Recovery Point Objective*) — combien de travail on accepte de **perdre** — et le **RTO** (*Recovery Time Objective*) — combien de temps on accepte d'être **hors service**. Ils sont fixés par l'entreprise, pas par la technique : la technique sert à les tenir.

### 0.6 RMAN : l'outil de sauvegarde d'Oracle

**RMAN** (*Recovery Manager*) est le programme livré avec Oracle pour sauvegarder, restaurer et récupérer. On le lance avec `rman target /` (« travaille sur la base **cible** de cette machine »). L'invite devient `RMAN>`. Premier contact, sans rien casser : on lui demande quelles sauvegardes il connaît.

{{step:zero-rman}}

Réponse : `no backup found in the repository` — **aucune**, ce qui est normal : personne n'a encore sauvegardé cette base. Le but des sections qui suivent est que cette réponse ne soit plus jamais vide.

> 💡 RMAN écrit **sa sortie comme un journal de bord** : chaque ligne dit ce qu'il fait, sur quel fichier, avec quel résultat. Quand quelque chose ne va pas, c'est dans les **dernières lignes** (`RMAN-` ou `ORA-`) qu'on lit la cause (section 16).

### 0.7 Petit glossaire

| Terme | Définition en une phrase |
|---|---|
| **Base de données** | Les fichiers qui contiennent les données (et ce qu'il faut pour les protéger) |
| **Instance** | Les processus et la mémoire d'Oracle, qui ouvrent la base et répondent |
| **Schéma** | L'ensemble des objets d'un utilisateur de la base (`shop`) |
| **Table, ligne, colonne** | Une feuille de données, un élément, une caractéristique |
| **SQL** | Le langage pour interroger et modifier une base |
| **SQL\*Plus** | Le programme où l'on tape du SQL (`sqlplus`) |
| **SYSDBA** | Le rôle d'administrateur de la base ; réservé au groupe `dba` |
| **Vue `V$`** | Une « table » que la base tient à jour pour décrire son propre état |
| **Datafile** | Un fichier qui contient des tables ou des index (`.dbf`) |
| **Tablespace** | Un regroupement logique de datafiles |
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

---


## 1. L'entreprise et son problème

**Lumière Boutique** vend en ligne. Son site web tourne sur deux frontaux (`WEB-1`, `WEB-2`) en DMZ ; les commandes, les clients, les paiements vivent dans **une base Oracle**, `ORCL`, sur le serveur `ORA-PRD` du siège. Si cette base disparaît, la boutique ne vend plus rien : plus de panier, plus de paiement, plus de suivi de commande.

Imagine les trois e-mails qu'un DBA peut recevoir un lundi matin :

| 📧 De | Sujet | Ce qui est arrivé | Ce qu'il te faut |
|---|---|---|---|
| **L'exploitant** | « Un disque a lâché cette nuit » | Un fichier de données (`shop_data01.dbf`) est illisible | Une **restauration** du fichier et un **rejeu des journaux** |
| **Le développeur** | « J'ai supprimé la table des paiements en prod » | Une erreur humaine, base ouverte et saine | Un **retour dans le temps** juste avant l'erreur |
| **Le réseau** | « Le siège est hors service » | Tout le site est perdu : serveurs, baies, base | Un **site de reprise** déjà prêt (Paris → Lyon… ici `DR`) |

Une bonne stratégie répond à trois chiffres :

| Objectif | Question | Réponse retenue pour Lumière |
|---|---|---|
| **RPO** (perte de données tolérée) | Combien de temps de commandes accepte-t-on de perdre ? | **≈ 0** si le siège brûle (la base du site de reprise reçoit les journaux en continu) ; **≤ 4 h** après une erreur logique (sauvegarde des journaux toutes les 4 h) |
| **RTO** (durée d'indisponibilité) | Combien de temps la boutique peut-elle être fermée ? | **Quelques minutes** pour basculer sur le site de reprise ; **quelques dizaines de minutes** pour restaurer un fichier |
| **Rétention** | Combien de temps garde-t-on les sauvegardes ? | **7 jours** de fenêtre de récupération sur le volume de sauvegarde |

> 💡 **Le point à retenir dès maintenant** : une sauvegarde et un site de reprise ne répondent **pas** à la même question. Le site de reprise copie *aussi* l'erreur (un `DROP TABLE` est rejoué sur la standby). Seule une **sauvegarde** te permet de revenir *avant* l'erreur. Il faut les deux.

---

## 2. L'infrastructure du lab

Le lab est un jeu de **35 équipements** — trois constructeurs réseau (Cisco, Huawei, Fortinet) et des serveurs Linux et Windows — construit en tapant les mêmes commandes qu'un administrateur. Le détail est dans `labs/ecommerce-lumiere/README.md` ; voici ce qui compte pour ce tutoriel :

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

Les rôles à connaître :

| Machine | Rôle dans ce tutoriel |
|---|---|
| `ORA-PRD` | Serveur de production. Il porte la base `ORCL` (schéma `SHOP` : clients, produits, commandes, paiements) |
| `BKP-HQ` | Serveur de sauvegarde. Il **exporte** `/srv/backup/rman` en NFS ; `ORA-PRD` le monte sur `/backup` (déclaré dans `/etc/fstab`) |
| `ORA-STB` | Serveur Oracle du site de reprise. Il deviendra la **base de secours** (standby) de `ORCL` |
| `BKP-DR` | Volume de sauvegarde du site de reprise |
| `LOG-HQ` | Serveur de journaux (rsyslog UDP 514) : toutes les machines Oracle, sauvegarde et web lui envoient leurs journaux |
| `FGT-HQ` / `FGT-DR` | Les FortiGate qui portent le tunnel IPsec entre les deux sites : c'est par là que passeront les fichiers de données de la standby |

> 🔌 **Un détail de câblage qui a son importance** : un routeur Cisco de ce modèle n'a que **trois interfaces**. `R-HQ` en utilise une vers le pare-feu et **une seule** vers les trois réseaux du siège (serveurs, utilisateurs, bases), qu'il sépare par des **VLAN** : c'est un *routeur sur un bâton* (*router-on-a-stick*), avec trois sous-interfaces `.10`, `.20`, `.30` sur un lien **trunk** dot1Q vers `SW-HQ-SRV`.

> ⚠️ **Règle du projet, et raison pour laquelle ce lab est instructif : tout ce qui circule entre deux machines passe par de vraies trames.** Quand `ORA-PRD` écrit une pièce de sauvegarde sur `/backup`, ce sont des appels NFSv3 qui traversent le câble jusqu'à `BKP-HQ`. Quand on construit la standby, ce sont les octets des fichiers de données qui traversent le tunnel IPsec. Tu pourras le **prouver** (étape 4).

### 2.1 Ouvrir le lab

1. Lance l'application : `npm run dev`, puis ouvre <http://localhost:8080>.
2. Barre d'outils → **Importer** → choisis `labs/ecommerce-lumiere/topology.json`.
3. Double-clique sur `ORA-PRD` pour ouvrir son terminal. **Il s'ouvre en `root`** (invite `#`). Tape `su - oracle` : l'invite devient `[oracle@ora-prd ~]$`. C'est sous cette identité que se joue presque tout le tutoriel ; `exit` te rend `root`.
4. Chaque bloc de code du tutoriel commence par une **invite** qui dit *qui* tape et *sur quelle machine* : suis-la. Un bloc `[root@bkp-hq ~]#` se tape dans le terminal de `BKP-HQ` ; un bloc `[root@ora-prd ~]#` dans celui d'`ORA-PRD` en root.
5. **Si tu te perds ou si tu casses quelque chose**, ce n'est pas grave : réimporte `topology.json` (étape 2) et tu repars d'un lab neuf.

Le fichier d'export est « une machine qui tournait et qui redémarre » : adresses, services, scripts, schéma `SHOP` sont là. **Le montage NFS, lui, est à refaire** : c'est exactement ce qui se passe sur un vrai serveur qui démarre sans que le serveur de sauvegarde soit joignable, et c'est la première commande de l'étape 1.

> 💡 Dans les blocs qui suivent, l'invite te dit **qui tape quoi, et où** : `[oracle@ora-prd ~]$` est le shell de l'utilisateur `oracle` sur `ORA-PRD`, `[root@bkp-hq ~]#` celui de root sur `BKP-HQ`, `SQL>` une session SQL*Plus (`sqlplus / as sysdba`), `RMAN>` une session RMAN (`rman target /`). **En production, on sauvegarde en tant qu'`oracle`, jamais en root** : on le verra à l'œuvre à l'étape 4.

---

## 3. Les cinq notions à retenir

La partie 0 a posé les bases ; voici, en cinq lignes, ce qui servira à lire **toutes** les sorties qui suivent.

| Notion | Ce que c'est | Pourquoi ça compte |
|---|---|---|
| **Datafile / tablespace** | Les fichiers qui contiennent les données. Chez Lumière : `SHOP_DATA` (tables) et `SHOP_IDX` (index) | C'est ce qu'on sauvegarde et ce qui peut disparaître |
| **Redo / ARCHIVELOG** | Le journal de toutes les modifications. Quand un groupe de redo est plein, Oracle l'**archive** (`ARCHIVELOG`) au lieu de l'écraser | Sans journaux archivés, on ne peut restaurer qu'**au moment de la sauvegarde** ; avec, **jusqu'à la dernière transaction** |
| **SCN** | Le numéro de série du temps de la base : il augmente à chaque changement validé | C'est l'horloge de la récupération : `RECOVER ... UNTIL SCN n` |
| **Fichier de contrôle** | Le petit fichier qui sait où est tout le reste (fichiers, journaux, **historique des sauvegardes**) | Le perdre rend la base muette ; RMAN l'**auto-sauvegarde** pour cette raison |
| **Incarnation / RESETLOGS** | Après une récupération *incomplète*, Oracle repart d'une nouvelle numérotation des journaux : une nouvelle « incarnation » | Une règle simple : **récupération incomplète ⇒ `OPEN RESETLOGS`** |

Et le vocabulaire RMAN : un **backup set** contient une ou plusieurs **pièces** (`piece handle=...`, les vrais fichiers) ; un **niveau 0** est la base complète (la référence), un **niveau 1** ne contient que ce qui a changé depuis ; le **DBID** est l'identifiant numérique de la base (à noter **avant** le sinistre).

---

## 4. Étape 1 — Reconnaissance : qu'est-ce qu'on protège ?

On commence par savoir où l'on est. Tu es `oracle` sur `ORA-PRD`.

### 4.1 Qui suis-je, où suis-je ?

{{step:identite}}

`uid=54321(oracle)` : le propriétaire des logiciels Oracle, membre du groupe `dba` (celui qui a le droit de se connecter `AS SYSDBA` sans mot de passe). C'est pour cette raison que **tout ce tutoriel se joue en `oracle`** : root, lui, est refusé (partie 0.3).

### 4.2 Monter le volume de sauvegarde

Le volume est **déclaré** dans `/etc/fstab`, mais il n'est pas monté au démarrage de ce lab. Un `mount -a` (en root) monte tout ce qui est déclaré :

{{step:montage-sauvegarde}}

`df -h` donne la **taille du volume distant**, lue sur le serveur par le protocole NFS (procédure `FSSTAT`) : `Size`, `Used`, `Avail`, `Use%`. C'est la première chose qu'on regarde avant une sauvegarde : *y a-t-il de la place ?*

Trois choses à voir :

- la source est `10.10.30.20:/srv/backup/rman` : le **serveur de sauvegarde** (`BKP-HQ`), à travers le réseau ;
- le propriétaire du dossier est **54321** : l'utilisateur `oracle` *du serveur de sauvegarde*. Pour que `oracle` d'`ORA-PRD` puisse y écrire, il faut le **même uid** des deux côtés. C'est la raison pour laquelle le lab crée le compte `oracle` (uid 54321) sur `BKP-HQ` : NFS ne transporte pas des noms, il transporte des **numéros** ;
- l'export est `rw` pour le réseau des bases du siège, et `ro` (lecture seule) pour celui du site de reprise.

Un dernier test, en tant qu'`oracle`, que le volume est bien **accessible en écriture** — on crée un fichier, on le date, on le supprime :

{{step:test-ecriture-sauvegarde}}

`touch` sur un fichier qui existe déjà met sa date à jour **sur le serveur** (NFS `SETATTR`) : les deux dates diffèrent bien.

### 4.3 L'état de santé de la base

Un script livré avec le lab (`/home/oracle/scripts/health.sql`) résume l'essentiel :

{{step:sante}}

Deux lignes comptent : la base est en **`NOARCHIVELOG`** (la valeur par défaut, et l'erreur classique des bases « de test » qui finissent en production), et le schéma contient **12 commandes** réparties en `NEW`, `PAID`, `SHIPPED`.

### 4.4 Noter le DBID

{{step:identite-base}}

> 📝 **Note le DBID** (ici `{{var:DBID}}`) quelque part **en dehors** de la base : dans le runbook, dans le coffre de l'équipe. Si tu perds le fichier de contrôle *et* le catalogue, c'est lui qui te permet de retrouver tes sauvegardes automatiques (scénario B).

### 4.5 Où sont les fichiers ?

{{step:fichiers}}

Retiens l'emplacement des **deux fichiers de contrôle** (`control01.ctl`, `control02.ctl` : Oracle les multiplexe) et des fichiers de données ; ce sont eux que les scénarios vont détruire.

---

## 5. Étape 2 — Passer la base en ARCHIVELOG

### 5.1 Ce qui se passe si on ne le fait pas

Premier réflexe d'un débutant : sauvegarder tout de suite. Essayons, **base ouverte**, telle qu'elle est livrée :

{{step:noarchivelog-refus}}

`RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode` : Oracle **refuse**. La raison : en `NOARCHIVELOG`, Oracle **écrase** les journaux quand ils sont pleins : on ne peut sauvegarder la base qu'**arrêtée proprement**, et on ne peut restaurer qu'au point de la sauvegarde. Une copie faite pendant que la base change serait **incohérente** et inutilisable. Il n'y a que deux issues : **arrêter la base** pour la sauvegarder à froid (inacceptable pour une boutique ouverte 24 h/24), ou passer en `ARCHIVELOG`.

### 5.2 Passer en ARCHIVELOG

Le passage demande un **redémarrage** (la commande n'est acceptée qu'en `MOUNT`) ; le lab livre le script `03_archivelog.sql` qui le fait :

{{step:passage-archivelog}}

Ce que le script fait, ligne à ligne : `SHUTDOWN IMMEDIATE`, `STARTUP MOUNT`, `ALTER DATABASE ARCHIVELOG`, `ALTER DATABASE FORCE LOGGING` (aucune opération ne peut plus échapper au journal avec `NOLOGGING`, ce qui est indispensable pour une standby), `ALTER DATABASE OPEN`, puis `ARCHIVE LOG LIST`. On vérifie :

{{step:verif-archivelog}}

---

## 6. Étape 3 — Configurer RMAN une bonne fois pour toutes

On lance `rman target /` (en tant qu'`oracle`). RMAN stocke sa configuration **dans le fichier de contrôle** : on la règle une fois, elle vaut pour tous les `BACKUP` suivants.

### 6.1 Ce que RMAN fait par défaut

{{step:show-all}}

Trois réglages par défaut ne nous conviennent pas : la rétention est de **1 sauvegarde** (`REDUNDANCY 1`), l'**auto-sauvegarde du fichier de contrôle est éteinte**, et les pièces iraient dans la zone de récupération locale (`fast_recovery_area`), c'est-à-dire **sur le même disque que la base**. Une sauvegarde qui meurt avec la base ne sert à rien.

### 6.2 Notre politique

{{step:configure}}

| Réglage | Pourquoi |
|---|---|
| `RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS` | On doit pouvoir revenir à n'importe quel instant des 7 derniers jours ; RMAN garde ce qu'il faut pour cela et déclare le reste **obsolète** |
| `CONTROLFILE AUTOBACKUP ON` | Après chaque sauvegarde, RMAN sauvegarde aussi le fichier de contrôle. C'est ce qui rend le scénario B possible |
| `CONTROLFILE AUTOBACKUP FORMAT ... '/backup/cf_%F'` | Le fichier de contrôle est sauvegardé **sur le volume NFS**, sous un nom qui contient le DBID (`%F`) |
| `CHANNEL ... FORMAT '/backup/%d_%T_%U.bkp'` | Toutes les pièces vont sur `/backup` ; `%d` nom de la base, `%T` date, `%U` identifiant unique |

{{step:show-config}}

---

## 7. Étape 4 — La première sauvegarde

### 7.1 La commande

`BACKUP DATABASE PLUS ARCHIVELOG` sauvegarde les fichiers de données **et** les journaux archivés, ce qui est le strict minimum pour pouvoir récupérer jusqu'à la dernière transaction :

{{step:premiere-sauvegarde}}

Lis la sortie comme un journal de bord :

- `piece handle=/backup/ORCL_...bkp tag=PREMIERE` : **le fichier créé** et l'étiquette de la sauvegarde (le `tag`) ;
- trois blocs `Starting backup / Finished backup` : les fichiers de données, les journaux archivés, puis l'**auto-sauvegarde du fichier de contrôle** (`tag=AUTOBACKUP`, nommée `cf_c-<DBID>-<date>-<n>`).

### 7.2 Ce qu'il y a dans le catalogue

{{step:liste-sauvegardes}}

`LIST BACKUP SUMMARY` : une ligne par backup set (`TY` type — `B` backup set ; `LV` niveau — `F` full, `A` journaux ; `S` état — `A` available). `REPORT SCHEMA` liste ce qu'il y a à protéger. `REPORT NEED BACKUP` confronte chaque fichier à la politique de rétention : la colonne `Days` donne le nombre de jours écoulés depuis la dernière sauvegarde de ce fichier (ici 0 : on vient de les sauvegarder tous). Dans une supervision, c'est elle qu'on surveille : un fichier dont `Days` dépasse la fenêtre n'est plus protégé.

### 7.3 La preuve par le fil

Va sur **l'autre machine**, `BKP-HQ`, et regarde ce qui est arrivé :

{{step:preuve-par-le-fil}}

Les pièces et les trois fichiers `cf_c-...` sont là, et ils appartiennent à l'uid **54321** : c'est bien `oracle` d'`ORA-PRD` qui les a créés, **à travers le réseau** (NFSv3 sur le port 2049, trames réelles), pas un fichier local qui prétend l'être. C'est la raison pour laquelle on sauvegarde en tant qu'`oracle` et non en root : en root, les pièces appartiendraient à `root` sur le serveur de sauvegarde.

### 7.4 Ce que la base sait de ses sauvegardes

Le catalogue de RMAN vit dans le fichier de contrôle ; la base l'expose par des vues `V$` :

{{step:vues-sauvegardes}}

`V$BACKUP_PIECE` liste les fichiers, `V$RMAN_BACKUP_JOB_DETAILS` l'historique des travaux avec leur état. Ce sont les vues qu'on interroge pour **superviser** une chaîne de sauvegarde.

---

## 8. Étape 5 — Une stratégie : niveau 0, niveau 1, journaux, cron

Une seule sauvegarde ne fait pas une stratégie. Voici celle de Lumière :

| Quand | Quoi | Ce que ça protège |
|---|---|---|
| **Dimanche 02:00** | Niveau 0 (base complète) | La référence |
| **Lundi–samedi 02:00** | Niveau 1 (ce qui a changé) | La nuit précédente, à peu de frais |
| **Toutes les 4 heures** | Sauvegarde des journaux archivés, puis suppression de ceux qui sont sauvegardés | **Le RPO** : on ne perd au plus que 4 h de commandes |

### 8.1 Les scripts

Trois fichiers de commandes RMAN (`l0.rman`, `l1.rman`, `arc.rman`) et **un seul** script shell qui les lance, journalise leur sortie dans un fichier, et envoie le **code retour** au serveur de journaux avec `logger` :

{{step:ecriture-scripts}}

`rman target / cmdfile=... log=...` exécute un fichier de commandes sans intervention ; le code retour (`$?`) vaut 0 si tout va bien. C'est lui que l'ordonnanceur et la supervision regardent.

### 8.2 Un niveau 0, des données qui changent, un niveau 1

{{step:niveau-0}}

On modifie des données (les commandes `NEW` passent en `PAID`) et on force l'archivage du journal courant :

{{step:donnees-du-jour}}

{{step:niveau-1}}

Le niveau 1 est quasi instantané par rapport au niveau 0 : il ne contient que les changements.

Une dernière modification, **après** le niveau 1 (le stock de la lampe passe de 120 à 115, une vente) : elle ne sera dans **aucune sauvegarde de fichier de données**, seulement dans les journaux. C'est ce que le scénario A utilisera pour montrer à quoi servent les journaux :

{{step:donnees-apres-niveau-1}}

### 8.3 Les journaux archivés

Avant de les sauvegarder, deux journaux archivés sont sur le disque. `CROSSCHECK ARCHIVELOG ALL` vérifie que **chaque fichier de journal que la base croit avoir existe réellement** :

{{step:crosscheck-journaux}}

{{step:sauvegarde-journaux}}

`DELETE INPUT` supprime du disque les journaux **une fois sauvegardés** : sans cela, la zone d'archivage se remplit et la base **se bloque** (`ORA-00257`) quand elle ne peut plus archiver. C'est l'incident de production le plus banal d'Oracle.

{{step:liste-niveaux}}

On lit maintenant la structure de la stratégie : `LV 0` (niveau 0), `LV 1` (niveau 1), `LV A` (journaux), `LV F` (les auto-sauvegardes du fichier de contrôle). `LIST ARCHIVELOG ALL` répond que plus aucun journal n'est sur le disque : ils ont tous été sauvegardés **puis supprimés** (on verra au scénario A que RMAN sait les **récupérer depuis la sauvegarde** au moment d'en avoir besoin).

### 8.4 La planification

**cron** est le programme de Linux qui lance des commandes à heures fixes. On lui donne une liste dans un fichier appelé **crontab**.

{{step:planification}}

Trois lignes de `crontab`, dans le crontab de l'utilisateur `oracle`. Le format est celui de cron : `minute heure jour-du-mois mois jour-de-la-semaine commande` (`0 2 * * 0` : à 02:00 le dimanche).

### 8.5 Le journal central

**rsyslog** est le service Linux qui collecte les messages (« journaux ») des programmes ; il peut les **envoyer à un autre serveur** pour les centraliser. La commande `logger` écrit un message dans ce système depuis un script.

Chaque exécution du script a envoyé son code retour à `LOG-HQ` par rsyslog. Sur `LOG-HQ` :

{{step:journal-central}}

C'est la **trace centrale** de la chaîne de sauvegarde : `ora-prd` est le nom de la machine émettrice, `job=l0 code=0` dit quel travail et avec quel résultat. Une supervision n'a qu'à chercher `code=` différent de `0`. Le lab configure cet envoi (`/etc/rsyslog.d/90-forward-lumiere.conf`, `*.* @10.10.10.40:514`) sur toutes les machines Oracle, sauvegarde et web.

---

## 9. Étape 6 — Vérifier : une sauvegarde non testée n'existe pas

Trois niveaux de vérification, du moins cher au plus cher.

**1. Les fichiers de la base sont-ils lisibles ?**

{{step:validate}}

**2. RMAN pourrait-il restaurer ?** (sans rien écrire : il lit les pièces)

{{step:restore-validate}}

`RESTORE DATABASE VALIDATE` lit **toutes les pièces nécessaires** à une restauration complète et vérifie qu'elles sont lisibles et cohérentes. C'est le test que tu mets dans ta supervision.

**3. Le catalogue correspond-il à la réalité ?**

{{step:crosscheck}}

`CROSSCHECK BACKUP` compare **toutes les sauvegardes** que RMAN connaît — celles des fichiers de données **et** celles des journaux — avec ce qu'il y a vraiment sur le disque : une pièce effacée à la main passerait en `EXPIRED`. (`CROSSCHECK ARCHIVELOG ALL`, vu en 8.3, contrôle autre chose : les **fichiers** de journaux archivés eux-mêmes.) Enfin, la politique de rétention :

{{step:obsolete}}

`REPORT OBSOLETE` liste ce que la fenêtre de 7 jours permet de supprimer ; `DELETE OBSOLETE` le supprime. Tout est « récent » ici : rien n'est obsolète.

> 💡 **La règle d'or** : le seul test valable d'une sauvegarde est une **restauration**. Les trois scénarios qui suivent sont ce test.

---

## 10. Scénario A — Un datafile disparaît

*Un disque a lâché : le fichier de données `shop_data01.dbf` (le tablespace `SHOP_DATA`, avec toutes les tables de la boutique) n'existe plus.*

### 10.1 Avant

{{step:a-avant}}

### 10.2 Le sinistre

{{step:a-sinistre}}

Rien ne se passe, et c'est **normal** : tant que la base est ouverte, Oracle a le fichier ouvert ; il ne s'aperçoit de sa disparition qu'à un redémarrage (ou à la prochaine lecture sur disque). On simule la panne la plus brutale : l'arrêt immédiat de l'instance.

{{step:a-arret}}

### 10.3 Le diagnostic

{{step:a-demarrage}}

C'est **LE** message à reconnaître : `ORA-01157` (impossible d'identifier le fichier), suivi de `ORA-01110` qui **nomme le fichier** : numéro 5, chemin complet. Remarque deux choses : l'instance est bien **montée** (`Database mounted.`, le fichier de contrôle est lisible : c'est lui qui connaît la liste des fichiers) ; c'est seulement l'**ouverture** qui échoue, parce qu'un fichier manque.

### 10.4 La réparation

Deux commandes RMAN, dans cet ordre, et **toujours** dans cet ordre :

{{step:a-restauration}}

- `RESTORE DATAFILE 5` : RMAN retrouve **la sauvegarde la plus récente du fichier 5** et la recopie à sa place (depuis `/backup`, c'est-à-dire à travers le réseau) ;
- `RECOVER DATAFILE 5` : le fichier restauré date de la sauvegarde ; RMAN lui **rejoue les journaux** pour le ramener au présent. Ici, ceux-ci ont été supprimés du disque après leur sauvegarde : RMAN les **extrait de la pièce de sauvegarde des journaux** avant de les rejouer.

> 💡 `RESTORE` ramène un état **ancien** ; `RECOVER` le **met à jour**. Sans `RECOVER`, le fichier est trop vieux par rapport au reste de la base et Oracle refuse de l'ouvrir.

{{step:a-ouverture}}

La base est ouverte, les 12 commandes sont là, neuf sont payées (la mise à jour de la journée est revenue avec le niveau 1) **et le stock de la lampe vaut 115** : cette vente a eu lieu **après** le niveau 1, elle n'était dans aucune sauvegarde de fichier de données, seulement dans le journal archivé que RMAN a retrouvé dans sa pièce. C'est exactement ce que valent les journaux archivés : sans eux, tu aurais retrouvé 120.

### 10.5 Variante : réparer pendant que la boutique tourne

Si **seul le tablespace** est en cause, on n'est pas obligé d'arrêter la base : on met **uniquement** `SHOP_DATA` hors ligne, on le restaure, on le remet en ligne. Les autres tablespaces (et donc, par exemple, la connexion des clients dans leurs tables d'index ou de sessions) continuent de fonctionner.

{{step:a2-hors-ligne}}

Les deux erreurs sont celles qu'un utilisateur de la boutique verrait : `ORA-00376` (fichier illisible) et `ORA-01110` (lequel). Restauration, **en ligne** :

{{step:a2-restauration-en-ligne}}

{{step:a2-remise-en-ligne}}

> 💡 Cette restauration « en ligne » n'est possible qu'en `ARCHIVELOG`. En `NOARCHIVELOG`, Oracle refuse de mettre un tablespace `OFFLINE IMMEDIATE` (`ORA-01145`) : encore une raison de l'étape 2.

---

## 11. Scénario B — Les fichiers de contrôle disparaissent

*Pire : les **deux** copies du fichier de contrôle sont perdues. La base ne peut plus ni se monter, ni dire où sont ses fichiers, ni où sont ses sauvegardes (le catalogue RMAN vivait dedans).*

C'est là que **le DBID noté à l'étape 1** et **l'auto-sauvegarde** servent.

### 11.1 Le contexte avant la panne

{{step:c-identite}}

### 11.2 Le sinistre

{{step:c-sinistre}}

{{step:c-arret}}

{{step:c-demarrage}}

`ORA-00205` : l'instance démarre (`ORACLE instance started`), mais ne peut pas lire son fichier de contrôle. Elle reste dans l'état `NOMOUNT`, ce qui est exactement ce qu'il faut pour la suite : RMAN peut se connecter à une instance non montée.

### 11.3 La restauration du fichier de contrôle

RMAN a **tout oublié** : sa configuration (stockée dans le fichier de contrôle) et son catalogue. Il faut donc lui dire qui il sauvegarde (`SET DBID`) et **où chercher** les auto-sauvegardes (`SET CONTROLFILE AUTOBACKUP FORMAT`, le même format que celui de l'étape 3) :

{{step:c-restauration-controle}}

RMAN a trouvé `cf_c-<DBID>-<date>-<n>`, **la plus récente**, et en a refait les deux fichiers de contrôle. Plus bas, `MOUNT` puis `RECOVER` : le fichier de contrôle restauré dit que la base est « plus ancienne » que ses fichiers de données ; les journaux comblent l'écart.

{{step:c-montage}}

{{step:c-recover}}

### 11.4 L'ouverture : `RESETLOGS`

{{step:c-ouverture}}

Un fichier de contrôle **restauré** n'est plus « celui de la base vivante » : Oracle exige `OPEN RESETLOGS` (`ORA-01589` sinon) et crée une **nouvelle incarnation**. Les commandes sont toutes là.

> 📌 **Réflexe après tout `RESETLOGS`** : faire immédiatement une **nouvelle sauvegarde complète** (en dessous). La précédente est celle d'une incarnation antérieure : on peut s'en servir, mais on ne veut pas dépendre d'elle.

{{step:c-sauvegarde-apres}}

`LIST INCARNATION` montre l'incarnation d'origine (`PARENT`) et la nouvelle (`CURRENT`).

---

## 12. Scénario C — Un `DROP TABLE` en production : retour dans le temps

*Un développeur supprime la table des paiements. La base est saine, ouverte, tout fonctionne… sauf qu'il manque les paiements. Aucun fichier n'est perdu : il faut revenir **avant** l'erreur.*

C'est le cas que le site de reprise **ne résout pas** (il a rejoué le `DROP TABLE` aussi) et que la sauvegarde résout, grâce au **SCN**.

### 12.1 Noter l'instant juste avant

En pratique, on retrouve cet instant dans les journaux, dans l'audit, ou en demandant à l'utilisateur « vers quelle heure ? ». Ici, on le relève juste avant :

{{step:b-avant}}

Le SCN `{{var:SCN}}` est notre **point de retour**.

### 12.2 L'erreur

{{step:b-erreur}}

### 12.3 Revenir dans le temps

On arrête la base, on la monte, et on restaure **jusqu'à un SCN** précis. Les deux commandes sont dans un bloc `RUN { ... }` pour que le `SET UNTIL` s'applique aux deux :

{{step:b-arret-montage}}

{{step:b-pitr}}

`SET UNTIL SCN {{var:SCN}}` borne le travail : RMAN choisit la sauvegarde la plus récente **antérieure** à ce SCN, la restaure, puis ne rejoue les journaux **que jusqu'à ce SCN**. Les modifications d'après (dont le `DROP TABLE`) sont ignorées.

### 12.4 L'ouverture avec `RESETLOGS`

{{step:b-ouverture}}

La table `PAYMENTS` est revenue **avec son contenu**, la commande `2001` (créée *avant* l'erreur) aussi. Le premier `OPEN` est refusé (`ORA-01589`) : une récupération **incomplète** exige `RESETLOGS`.

### 12.5 Les incarnations, et la sauvegarde d'après

{{step:b-incarnations}}

{{step:b-sauvegarde-apres}}

> 💡 **Ce que tu as perdu** en revenant au SCN `{{var:SCN}}` : tout ce qui est arrivé **après**, y compris des commandes légitimes passées entre-temps. Un retour dans le temps de toute la base est un instrument lourd ; en production on lui préfère souvent *Flashback Table* ou une restauration dans une **base auxiliaire** pour ne récupérer que la table. Ces deux techniques sortent du cadre de ce tutoriel.

### 12.6 La méthode historique : `RECOVER` sous SQL\*Plus

Avant RMAN, on récupérait « à la main » depuis SQL\*Plus, et les cours l'enseignent encore. Le principe est le même : une fois les fichiers **restaurés** (ici par RMAN), la commande `RECOVER DATABASE` rejoue les journaux. La forme `UNTIL CANCEL` demande une récupération **incomplète** : elle s'arrête quand on le décide.

{{step:sp-montage}}

{{step:sp-restauration}}

{{step:sp-recover}}

`Media recovery complete.` : les journaux ont été rejoués. Et, comme pour toute récupération incomplète, le premier `OPEN` est refusé (`ORA-01589`) : **`RESETLOGS` est obligatoire**. C'est exactement le même moteur que le `RECOVER` de RMAN, avec la même règle.

---

## 13. Accès, audit et journaux : qui a le droit de sauvegarder ?

Une sauvegarde contient **toute la base**, mots de passe hachés compris. Ceux qui peuvent la lancer — ou la restaurer — sont aussi puissants que le DBA.

### 13.1 Un compte ordinaire essaie

Un stagiaire (compte `stagiaire`, simple utilisateur, **hors du groupe `dba`**) tente de lancer RMAN :

{{step:acces-intrus}}

`ORA-01031: insufficient privileges`, enveloppé dans `RMAN-00554` / `RMAN-04005` — la même erreur que celle de `root` en partie 0.3. Sur la machine, la connexion « bequeath » (`rman target /` sans mot de passe) n'est possible que pour les membres du groupe **`dba`** ; c'est le système d'exploitation qui authentifie.

### 13.2 La trace

Cette tentative **n'est pas perdue** : elle est auditée côté base, et inscrite au journal d'alerte :

{{step:acces-audit}}

{{step:journal-alerte}}

Ligne à ligne : `stagiaire` est l'utilisateur système qui a essayé, `1031` le code d'erreur. Un contrôle de sécurité efficace commence par là : **chaque refus laisse une trace**, et la trace va au serveur de journaux (§8.5).

### 13.3 À retenir pour ton organisation

| Contrôle | Où |
|---|---|
| Qui peut lancer RMAN / se connecter `AS SYSDBA` ? | Les membres du groupe OS `dba` (et eux seuls) |
| Qui peut **écrire** les sauvegardes ? | Le volume NFS `rw` pour les bases du siège seulement ; `ro` pour le site de reprise |
| Qui voit passer les travaux ? | `LOG-HQ` (rsyslog) : code retour de chaque travail |
| Qui administre les équipements réseau ? | FreeRADIUS sur `LOG-HQ` (Cisco-AVPair `priv-lvl=15`) |

---

## 14. Scénario D — Le siège brûle : le site de reprise

> **Quelques mots avant de commencer.** Un **site de reprise** (*disaster recovery*, DR) est un second datacenter, loin du premier. Les deux sites sont reliés par un **tunnel IPsec** : un « tuyau » chiffré à travers Internet, tenu par les pare-feu **FortiGate**. Une **base de secours** (*standby*) est une **copie de la base de production** qui reçoit en continu ses journaux et les rejoue : elle reste « un pas derrière » la production, prête à la remplacer. La production s'appelle alors la **primaire**.

*Le siège est perdu : `ORA-PRD`, `BKP-HQ`, tout. Les sauvegardes avaient été prises sur `BKP-HQ`… qui vient de brûler avec elles. Voilà pourquoi on a besoin d'un **site de reprise vivant**, qui reçoit les modifications **en continu**.*

La technique : une **base de secours physique** (*physical standby*) sur `ORA-STB`, créée par RMAN depuis la base active, alimentée par l'envoi des journaux, que l'on **promeut** en base primaire le jour du sinistre.

### 14.1 Le chemin est-il ouvert ?

Tout passe par le tunnel IPsec entre `FGT-HQ` et `FGT-DR` :

{{step:dr-tunnel}}

`'to-dr'` : `selectors(total,up): 1/1` : le tunnel est établi. C'est lui que traverseront, **en trames chiffrées**, les fichiers de la base.

### 14.2 Préparer la machine de secours

`ORA-STB` doit être une **instance démarrée mais sans base** : `NOMOUNT`.

{{step:dr-nomount}}

### 14.3 Créer la standby depuis la base active

Depuis `ORA-PRD`, RMAN se connecte à la **cible** (la production) et à l'**auxiliaire** (la future standby, `10.20.30.10`), puis recopie toute la base à travers le tunnel :

{{step:dr-duplicate}}

`DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE` : *« fais-moi une standby de cette base, en lisant directement les fichiers de la base ouverte »*, sans passer par une sauvegarde intermédiaire. `DORECOVER` rejoue les journaux disponibles, `NOFILENAMECHECK` autorise les mêmes noms de fichiers des deux côtés. Les octets des six fichiers de données ont **réellement traversé** le tunnel.

Sur `ORA-STB` :

{{step:dr-role}}

`PHYSICAL STANDBY` + `MOUNTED` : c'est une standby ; les six fichiers de données y sont. (Une standby est toujours en `ARCHIVELOG`, car elle reçoit des journaux archivés.)

### 14.4 Expédier les journaux, les appliquer

On dit à la production d'envoyer ses journaux vers la standby (`log_archive_dest_2`), et on démarre sur la standby le processus qui les **applique** (*managed recovery*) :

{{step:dr-expedition}}

{{step:dr-application}}

### 14.4 bis Le broker : la même chose, gérée pour toi

Les deux commandes précédentes sont celles que le **Data Guard Broker** exécute à ta place. Son interface est un programme, **`dgmgrl`**, qui garde une **configuration** : *qui est la primaire, quelles sont les standbys, comment les journaux circulent*. `CREATE CONFIGURATION` la nomme, `ADD DATABASE` déclare la standby **par son identifiant de connexion**, `ENABLE CONFIGURATION` l'active (le broker pose la destination d'archivage, et démarre l'application sur la standby par une session Oracle Net) :

{{step:dr-broker}}

`Configuration Status: SUCCESS` : tout va bien. S'il y avait une erreur de transport, tu la lirais ici (`ORA-16778`) : c'est la commande de **supervision** d'un environnement Data Guard.

### 14.4 ter Les trois modes de protection

Entre la **vitesse** et la **certitude de ne rien perdre**, Data Guard offre trois modes :

| Mode | Comment le redo part | Si la standby ne répond plus | Perte de données possible |
|---|---|---|---|
| `MAXIMUM PERFORMANCE` (défaut) | **Asynchrone** : à l'archivage du journal | La production continue | Les dernières transactions |
| `MAXIMUM AVAILABILITY` | **Synchrone** : chaque `COMMIT` attend l'accusé de réception de la standby | La production **continue** et repasse en asynchrone (`RESYNCHRONIZATION`), puis revient | Aucune tant que la standby répond |
| `MAXIMUM PROTECTION` | Synchrone, **obligatoire** | La production **s'arrête** (`ORA-03113`) plutôt que de valider sans copie | **Jamais** |

Le broker ne laisse activer un mode synchrone que si un membre est lui-même **synchrone** (`LogXptMode='SYNC'`) : `ORA-16627` sinon. On passe la standby en `SYNC`, puis la configuration en `MaxAvailability` :

{{step:dr-protection}}

{{step:dr-niveau}}

`PROTECTION_MODE` est le mode **demandé**, `PROTECTION_LEVEL` celui qui est **effectivement tenu** à cet instant (il passerait à `RESYNCHRONIZATION` si la standby se taisait, et à `UNPROTECTED` sans destination synchrone). `MAXIMUM PROTECTION` se règle de la même façon, mais base **montée** (`ORA-01126` sinon) : la production **s'arrêterait** à la première validation sans accusé de la standby.

### 14.5 Une commande tombe, elle arrive de l'autre côté

{{step:dr-commande}}

Deux commandes validées : la `3001`, suivie d'un **changement de journal**, et la `3002`, validée **sans** changement de journal. Le dernier `SELECT` montre la destination 2 (`10.20.30.10:1521/ORCL`) à l'état `VALID`. Maintenant, lisons côté standby (qu'on ouvre en **lecture seule** après avoir arrêté l'application) :

{{step:dr-lecture}}

`APPLIED = 'YES'` : les journaux sont appliqués. La commande `3001` est là parce que son journal a été archivé et expédié. La commande `3002`, elle, **n'a pas eu de journal archivé** : elle est lisible quand même, parce qu'en mode synchrone son `COMMIT` a **envoyé son redo à la standby avant de rendre la main**. C'est ce qui fait un RPO **réellement nul**.

### 14.6 Le sinistre et la bascule

On éteint brutalement la production : le siège est perdu.

{{step:dr-sinistre}}

Sur le site de reprise, on **promeut** la standby :

{{step:dr-bascule}}

`ALTER DATABASE FAILOVER TO ORCL` fait de la standby la **base primaire**, ouverte en `READ WRITE`. Les commandes `3001` et `3002` sont là : **aucune transaction validée n'a été perdue**. (Avec le broker, la même opération se tape `FAILOVER TO 'ORCL_STB'` dans `dgmgrl`, connecté à la standby ; la bascule **programmée** depuis la production, elle, est `SWITCHOVER TO 'ORCL_STB'`.) Il ne reste qu'à pointer les frontaux web (`WEB-DR`) sur cette base.

---

## 15. Exercices

Chacun se fait dans le lab rouvert (importe `topology.json` pour repartir d'un état propre). **Essaie avant de lire le corrigé.**

**Pour vérifier que tu as compris les bases**

1. **Qui est qui ?** Sans regarder, explique la différence entre *instance* et *base*, puis entre `NOMOUNT`, `MOUNT` et `OPEN`. <details><summary>Corrigé</summary>L'instance est l'ensemble des processus et de la mémoire ; la base est l'ensemble des fichiers. `NOMOUNT` : l'instance tourne, aucun fichier n'est lu ; `MOUNT` : le fichier de contrôle est lu, on sait où sont les fichiers mais ils sont fermés (c'est l'état où l'on restaure) ; `OPEN` : tout est ouvert, les utilisateurs travaillent.</details>
2. **Pourquoi pas root ?** Lance `sqlplus / as sysdba` en root, puis en `oracle`. Qu'est-ce qui explique la différence ? <details><summary>Corrigé</summary>`oracle` est membre du groupe `dba`, pas `root` ; l'authentification « sans mot de passe » (`/`) s'appuie sur ce groupe. Vérifie avec `id root` et `id oracle`.</details>
3. **Restore ou recover ?** Pour chaque phrase, dis s'il s'agit de `RESTORE` ou de `RECOVER` : « je remets le fichier tel qu'il était à la sauvegarde » ; « je rejoue le journal sur ce fichier ». <details><summary>Corrigé</summary>Premier : `RESTORE`. Second : `RECOVER`. Toujours dans cet ordre.</details>

**Pour pratiquer**

4. **Perte d'un fichier d'index.** Détruis `shop_idx01.dbf` (fichier 6), redémarre en `MOUNT`, restaure-le et récupère-le. Combien de commandes RMAN faut-il ? *Indice : c'est le scénario A pour un autre numéro de fichier.* <details><summary>Corrigé</summary>Deux : `RESTORE DATAFILE 6;` puis `RECOVER DATAFILE 6;`, suivies de `ALTER DATABASE OPEN;` côté SQL\*Plus.</details>
5. **Le niveau 1 sert-il à quelque chose ?** Après un niveau 0 et un niveau 1, restaure `SHOP_DATA`. Dans la sortie de `RESTORE`, quelles pièces RMAN lit-il ? *Indice : `LIST BACKUP SUMMARY` et la colonne `LV`.* <details><summary>Corrigé</summary>Le niveau 0 puis le niveau 1 : RMAN part de la référence et applique ce qui a changé ensuite.</details>
6. **Une pièce disparaît.** Supprime à la main (`rm` sur `BKP-HQ`) la pièce du niveau 0, puis lance `CROSSCHECK BACKUP`. Que passe-t-il à son statut ? Que répond `RESTORE DATABASE VALIDATE` ? *Indice : `EXPIRED`, puis `DELETE EXPIRED BACKUP`.* <details><summary>Corrigé</summary>La pièce passe `EXPIRED` ; `RESTORE DATABASE VALIDATE` échoue faute de pièce ; `DELETE EXPIRED BACKUP` nettoie le catalogue — et il faut refaire un niveau 0.</details>
7. **Un journal archivé disparaît.** Supprime un fichier `.arc` du disque, lance `CROSSCHECK ARCHIVELOG ALL`. Que lis-tu ? <details><summary>Corrigé</summary>`validation failed for archived log` suivi du nom du fichier absent : c'est le contrôle des **fichiers** de journaux, distinct de celui des sauvegardes.</details>
8. **Retour à une heure plutôt qu'à un SCN.** Refais le scénario C avec `SET UNTIL TIME` au lieu de `SET UNTIL SCN`. *Indice : l'heure se lit dans `SELECT SYSDATE FROM dual` ; le format dépend de `NLS_DATE_FORMAT`.*
9. **Qui a lancé cette sauvegarde ?** Donne à `stagiaire` le groupe `dba` (`usermod -aG dba stagiaire`) et fais-lui lancer `rman target /`. Qu'est-ce qui a changé ? Et dans les journaux de `LOG-HQ` ? *Indice : il faut ouvrir une nouvelle session pour que les groupes soient pris en compte.*
10. **Repartir à zéro.** Après la bascule du scénario D, que faudrait-il faire pour que le siège reconstruit redevienne un site de secours de `ORA-STB` ? *Indice : c'est le même `DUPLICATE`, dans l'autre sens.*
11. **Mesurer ton RTO.** Chronomètre, dans le simulateur, chaque scénario (le temps simulé est indiqué dans les sorties : `elapsed time`). Lequel est le plus long ? Pourquoi ?

---

## 16. Les erreurs que tu rencontreras

| Code | Message | Cause | Solution |
|---|---|---|---|
| `ORA-01157` + `ORA-01110` | cannot identify/lock data file *n* | Le fichier *n* est absent ou illisible | `RESTORE DATAFILE n; RECOVER DATAFILE n` (base en `MOUNT`) |
| `ORA-00376` | file *n* cannot be read at this time | Le tablespace est hors ligne ou le fichier en attente de récupération | `RESTORE TABLESPACE ...; RECOVER TABLESPACE ...;` puis `ONLINE` |
| `ORA-00205` | error in identifying control file | Aucun fichier de contrôle lisible | `STARTUP NOMOUNT` puis `RESTORE CONTROLFILE FROM AUTOBACKUP` |
| `ORA-01589` | must use RESETLOGS or NORESETLOGS option | Récupération incomplète ou fichier de contrôle restauré | `ALTER DATABASE OPEN RESETLOGS` |
| `ORA-01139` | RESETLOGS option only valid after an incomplete database recovery | `OPEN RESETLOGS` sans récupération incomplète | `ALTER DATABASE OPEN` simplement |
| `ORA-01031` | insufficient privileges | L'utilisateur du système n'est pas dans le groupe `dba` | `usermod -aG dba` (en connaissance de cause !) |
| `RMAN-06172` | no autobackup found | `RESTORE CONTROLFILE FROM AUTOBACKUP` sans `SET DBID` ou mauvais format | `SET DBID`, `SET CONTROLFILE AUTOBACKUP FORMAT ... %F` |
| `RMAN-06026` | no backup or copy of the database is available to satisfy the requested SET UNTIL bound | Aucune sauvegarde **antérieure** au SCN demandé | Choisir un SCN plus récent, ou une sauvegarde plus ancienne |
| `RMAN-06023` | no backup found to restore | Le catalogue ne connaît aucune sauvegarde | `LIST BACKUP` ; `CATALOG START WITH '/backup'` |
| `RMAN-06053` / `RMAN-06025` | unable to perform media recovery because of missing log | Un journal est absent **et** introuvable dans une sauvegarde | Vérifier que `BACKUP ARCHIVELOG ... DELETE INPUT` a réussi *avant* de supprimer |
| `RMAN-06149` | cannot BACKUP DATABASE in NOARCHIVELOG mode | Sauvegarde d'une base **ouverte** sans journaux archivés | Passer en `ARCHIVELOG` (section 5), ou sauvegarder à froid en `MOUNT` |
| `RMAN-04005` / `RMAN-00554` | error from target database | La connexion à la cible a échoué (privilèges, instance arrêtée) | Lire **la ligne `ORA-` qui suit** |
| `ORA-01124` | cannot recover data file *n* - file is in use or recovery | `RECOVER` lancé sur une base **ouverte** | Remettre la base en `MOUNT` (`SHUTDOWN IMMEDIATE`, `STARTUP MOUNT`) |
| `ORA-00257` | archiver error | La zone d'archivage est pleine | `BACKUP ARCHIVELOG ALL DELETE INPUT` |

> 💡 **Lire une erreur RMAN** : ignore l'encadré `RMAN-00571 / RMAN-00569` (c'est le décor). La **dernière** ligne numérotée dit la vraie raison, et très souvent elle est suivie d'un code `ORA-` qui donne la cause côté base.

---

## 17. Aide-mémoire

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
CROSSCHECK BACKUP;       DELETE OBSOLETE NOPROMPT;
```

**Recouvrement manuel sous SQL\*Plus** (base en `MOUNT`, fichiers restaurés)

```
RECOVER DATABASE;                      -- complète : ALTER DATABASE OPEN;
RECOVER DATABASE UNTIL CANCEL;         -- incomplète : ALTER DATABASE OPEN RESETLOGS;
RECOVER DATABASE UNTIL CHANGE n;       -- jusqu'à un SCN
```

**Restaurer**

| Panne | Séquence |
|---|---|
| Un datafile, base arrêtée (`MOUNT`) | `RESTORE DATAFILE n; RECOVER DATAFILE n;` puis `ALTER DATABASE OPEN;` |
| Un tablespace, base ouverte | `ALTER TABLESPACE t OFFLINE IMMEDIATE;` → `RESTORE TABLESPACE t; RECOVER TABLESPACE t;` → `ALTER TABLESPACE t ONLINE;` |
| Les fichiers de contrôle | `STARTUP NOMOUNT` → `SET DBID n; SET CONTROLFILE AUTOBACKUP FORMAT ...; RESTORE CONTROLFILE FROM AUTOBACKUP;` → `ALTER DATABASE MOUNT;` → `RECOVER DATABASE;` → `ALTER DATABASE OPEN RESETLOGS;` |
| Retour à un instant | `RUN { SET UNTIL SCN n; RESTORE DATABASE; RECOVER DATABASE; }` → `ALTER DATABASE OPEN RESETLOGS;` |
| Sinistre de site | `DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE ...` (en amont) → `ALTER DATABASE FAILOVER TO ...;` → `ALTER DATABASE OPEN;` |

**Les trois réflexes**

1. **Note le DBID** hors de la base.
2. **Teste la restauration**, pas seulement la sauvegarde.
3. **Après tout `RESETLOGS`, sauvegarde.**

---

## 18. Ce que le simulateur fait comme Oracle — et ce qu'il ne fait pas

Un tutoriel honnête dit où s'arrête son terrain. Pendant la rédaction de ce tutoriel, **sept écarts** entre le simulateur et un vrai Oracle ont été mesurés ; **six sont fermés** et le tutoriel s'appuie sur leur comportement réel :

| Ce qu'un vrai Oracle fait | Où le voir |
|---|---|
| `BACKUP DATABASE` sur une base **ouverte** en `NOARCHIVELOG` est refusé : `RMAN-06149` | section 5.1 |
| `df -h` sur un volume NFS donne la taille lue sur le **serveur**, et `touch` met à jour la date d'un fichier distant | section 4.2 |
| `root` n'est **pas** administrateur de la base : `ORA-01031` ; seul `oracle` (groupe `dba`) l'est | parties 0.3 et 13 |
| `RECOVER DATABASE [UNTIL ...]` existe sous SQL\*Plus, et une récupération incomplète exige `RESETLOGS` | section 12.6 |
| `CROSSCHECK BACKUP` couvre toutes les sauvegardes (journaux compris) ; `CROSSCHECK ARCHIVELOG ALL` contrôle les **fichiers** de journaux | sections 8.3 et 9 |
| Les modes de protection Data Guard sont **imposés** (redo synchrone au `COMMIT`, arrêt de la primaire sous `MAXIMUM PROTECTION`) et le broker (`dgmgrl`) existe | section 14.4 bis et ter |

Ce qui reste hors du terrain :

| Écart | Ce que fait un vrai Oracle | Ce que fait le simulateur |
|---|---|---|
| Le broker (`dgmgrl`) | La configuration est **répliquée** sur tous les membres, et le broker surveille et peut basculer seul (*fast-start failover*) | La configuration vit sur la base à laquelle on est connecté ; pas d'observateur |
| Temps de sauvegarde | Dépend du disque et du réseau | Durées simulées (indicatives) |
| Un journal archivé retiré du disque | Marqué `EXPIRED` dans le fichier de contrôle | Signalé par `CROSSCHECK` (`validation failed`), sans être marqué |

---

## 19. Conclusion

Tu as, dans une infrastructure de 35 équipements :

- **préparé** une base pour la sauvegarde (`ARCHIVELOG`, `FORCE LOGGING`) et **configuré** RMAN (rétention, auto-sauvegarde, destination réseau) ;
- **sauvegardé** par niveaux, **planifié** (cron), **journalisé** de façon centrale, **vérifié** (`VALIDATE`, `RESTORE ... VALIDATE`, `CROSSCHECK`) ;
- **réparé** un fichier de données (base arrêtée et base ouverte), **reconstruit** les fichiers de contrôle depuis l'auto-sauvegarde, **remonté le temps** après un `DROP TABLE` ;
- **contrôlé** qui peut lancer une sauvegarde, et vu que chaque refus laisse une trace ;
- **monté** un site de reprise à travers un tunnel IPsec, et **basculé** dessus sans perdre une transaction validée.

Si tu sais refaire ces six gestes sans regarder le tutoriel — et expliquer pourquoi `RESTORE` précède `RECOVER`, pourquoi le DBID se note à l'avance, et pourquoi un site de reprise ne remplace pas une sauvegarde — tu maîtrises le processus.

> 🔁 Le lab est entièrement rejouable : `UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/ecommerce-lumiere-tutorial.test.ts` refait ce document à partir d'une exécution fraîche.
