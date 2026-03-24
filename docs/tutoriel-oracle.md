# Oracle Database de Zéro à Héros : Comprendre et Administrer un SGBD Relationnel

> **À qui s'adresse ce tutoriel ?**
> Ce guide est fait pour toi si tu sais ce qu'est un fichier, une ligne de commande Linux, et que tu n'as pas peur du SQL. Pas besoin d'être un DBA certifié — on part vraiment de zéro et on construit ensemble, brique par brique. 🧱

---

## Table des matières

1. [Avant de commencer : quelques rappels essentiels](#1-avant-de-commencer--quelques-rappels-essentiels)
2. [Le problème que résout un SGBD](#2-le-problème-que-résout-un-sgbd)
3. [Qu'est-ce qu'Oracle Database exactement ?](#3-quest-ce-quoracle-database-exactement-)
4. [Les concepts clés d'Oracle](#4-les-concepts-clés-doracle)
5. [L'architecture Oracle en coulisses](#5-larchitecture-oracle-en-coulisses)
6. [Présentation de notre laboratoire](#6-présentation-de-notre-laboratoire)
7. [Installation et arborescence Oracle](#7-installation-et-arborescence-oracle)
8. [Démarrage et arrêt d'une instance Oracle](#8-démarrage-et-arrêt-dune-instance-oracle)
9. [SQL*Plus : ton couteau suisse Oracle](#9-sqlplus--ton-couteau-suisse-oracle)
10. [Créer et manipuler des données (SQL)](#10-créer-et-manipuler-des-données-sql)
11. [Administration de la base de données](#11-administration-de-la-base-de-données)
12. [PL/SQL : la programmation côté base](#12-plsql--la-programmation-côté-base)
13. [Les vues système et le diagnostic](#13-les-vues-système-et-le-diagnostic)
14. [Le réseau Oracle : Listener et TNS](#14-le-réseau-oracle--listener-et-tns)
15. [Cas pratiques et scénarios avancés](#15-cas-pratiques-et-scénarios-avancés)
16. [Les erreurs classiques et comment les éviter](#16-les-erreurs-classiques-et-comment-les-éviter)
17. [Aide-mémoire des commandes](#17-aide-mémoire-des-commandes)
18. [Conclusion](#18-conclusion)

---

## 1. Avant de commencer : quelques rappels essentiels

Avant de plonger dans le monde d'Oracle, posons quelques bases. Même si tu connais déjà ces notions, un petit rappel ne fait jamais de mal — et ça nous permettra d'être tous sur la même longueur d'onde. 😄

### 1.1 C'est quoi une base de données, déjà ?

Une **base de données**, c'est un endroit structuré où on stocke des informations. Imagine un immense classeur bien rangé : chaque tiroir contient des dossiers, chaque dossier contient des fiches, et chaque fiche a les mêmes rubriques (nom, prénom, date de naissance...).

En informatique, ce classeur s'appelle une **base de données**, les tiroirs sont des **tables**, les fiches sont des **lignes** (ou *rows*), et les rubriques sont des **colonnes** (ou *columns*).

```
Table "EMPLOYES"
+----+-----------+-----------+----------+---------+
| ID | NOM       | PRENOM    | SERVICE  | SALAIRE |
+----+-----------+-----------+----------+---------+
|  1 | DUPONT    | Marie     | RH       |   45000 |
|  2 | MARTIN    | Pierre    | IT       |   52000 |
|  3 | LEROY     | Sophie    | Finance  |   48000 |
+----+-----------+-----------+----------+---------+
```

### 1.2 C'est quoi SQL ?

**SQL** (Structured Query Language), c'est **le langage universel** pour parler à une base de données. Que tu utilises Oracle, MySQL, PostgreSQL ou SQL Server — tout le monde comprend le SQL. C'est un peu comme l'anglais dans un aéroport international : c'est la langue commune. ✈️

Avec SQL, tu peux :
- **Lire** des données : `SELECT * FROM employes;`
- **Ajouter** des données : `INSERT INTO employes VALUES (...);`
- **Modifier** des données : `UPDATE employes SET salaire = 55000 WHERE id = 2;`
- **Supprimer** des données : `DELETE FROM employes WHERE id = 3;`

On appelle ça les opérations **CRUD** : Create, Read, Update, Delete.

### 1.3 C'est quoi un SGBD ?

Un **SGBD** (Système de Gestion de Base de Données), c'est le logiciel qui fait tourner ta base de données. C'est le moteur sous le capot. Tu ne manipules pas les fichiers directement — tu parles au SGBD, et c'est lui qui s'occupe de tout : stocker les données, les retrouver rapidement, gérer les accès simultanés, faire des sauvegardes...

Les SGBD les plus connus :

| SGBD | Éditeur | Licence | Usage typique |
|------|---------|---------|---------------|
| **Oracle Database** | Oracle Corporation | Commercial | Grandes entreprises, banques, télécoms |
| PostgreSQL | Communauté | Open Source | Startups, web, DevOps |
| MySQL / MariaDB | Oracle / Communauté | Open Source | Web, CMS (WordPress, etc.) |
| SQL Server | Microsoft | Commercial | Écosystème Microsoft |
| SQLite | Communauté | Open Source | Mobile, embarqué, développement local |

### 1.4 C'est quoi un schéma ?

Dans le monde Oracle, un **schéma** c'est l'espace de travail d'un utilisateur. Quand tu crées un utilisateur Oracle (par exemple `HR`), il obtient automatiquement un schéma du même nom. Toutes les tables, vues, index, procédures que cet utilisateur crée sont rangées dans son schéma.

C'est un peu comme un bureau dans un open-space : chaque employé a son propre bureau (schéma), avec ses propres affaires (tables, vues...), mais tout le monde est dans le même bâtiment (la base de données). 🏢

### 1.5 C'est quoi un tablespace ?

Un **tablespace**, c'est le lien entre le monde logique (tes tables) et le monde physique (les fichiers sur le disque dur). Un tablespace contient un ou plusieurs **datafiles** (des fichiers `.dbf` sur le disque), et c'est dans ces fichiers que les données de tes tables sont physiquement stockées.

```
                    BASE DE DONNÉES
                         │
          ┌──────────────┼──────────────┐
          │              │              │
     TABLESPACE      TABLESPACE     TABLESPACE
      "SYSTEM"        "USERS"        "TEMP"
          │              │              │
     system01.dbf    users01.dbf   temp01.dbf
     (sur disque)    (sur disque)  (sur disque)
```

> 💡 **Analogie** : Si la base de données est un immeuble, les tablespaces sont les étages, et les datafiles sont les fondations physiques de chaque étage.

---

## 2. Le problème que résout un SGBD

Imaginons une situation concrète. Tu développes une application de gestion pour une entreprise de 500 employés. Tu dois stocker les informations des employés, les départements, les salaires, les congés, les projets... Comment fais-tu ?

### 2.1 L'approche fichier : la solution naïve

La première idée, c'est de tout mettre dans des fichiers CSV ou JSON. Un fichier `employes.csv`, un fichier `departements.csv`, etc.

```
employes.csv :
1,DUPONT,Marie,RH,45000
2,MARTIN,Pierre,IT,52000
3,LEROY,Sophie,Finance,48000
```

C'est faisable pour un petit projet. Mais imagine maintenant que 10 personnes doivent modifier ces fichiers en même temps... 😱

### 2.2 Les limites de l'approche fichier

- **Pas d'accès concurrent** : si deux personnes modifient le fichier en même temps, les données peuvent être corrompues.
- **Pas de sécurité** : n'importe qui peut lire ou modifier le fichier.
- **Pas de relations** : comment lier un employé à son département proprement ?
- **Pas de transactions** : si l'application plante en plein milieu d'une opération, les données sont dans un état incohérent.
- **Pas de requêtes complexes** : essaie de trouver "tous les employés du département IT dont le salaire est supérieur à 50 000 €, triés par nom" dans un fichier CSV...

### 2.3 Le SGBD à la rescousse

Un SGBD résout **tous** ces problèmes d'un coup :

| Problème | Solution du SGBD |
|----------|------------------|
| Accès concurrent | Verrouillage automatique et transactions |
| Sécurité | Utilisateurs, rôles, privilèges |
| Relations | Clés primaires, clés étrangères |
| Cohérence | Transactions ACID (Atomicité, Cohérence, Isolation, Durabilité) |
| Requêtes complexes | SQL ! |
| Performance | Index, optimiseur de requêtes, cache mémoire |
| Sauvegarde | Backup automatisé, recovery point-in-time |

C'est exactement pour ça qu'Oracle Database est le choix n°1 des grandes entreprises depuis plus de 40 ans. Et c'est ce qu'on va apprendre à utiliser ensemble. 💪

---

## 3. Qu'est-ce qu'Oracle Database exactement ?

**Oracle Database** est un **SGBD relationnel** (RDBMS — Relational Database Management System) développé par **Oracle Corporation** depuis 1979. C'est le SGBD le plus utilisé au monde dans les grandes entreprises.

### 3.1 Un peu d'histoire

| Année | Événement |
|-------|-----------|
| 1977 | Larry Ellison fonde SDL (Software Development Laboratories) |
| 1979 | Première version commerciale d'Oracle (v2) — le premier SGBD SQL commercial |
| 1983 | Oracle v3 : premier SGBD écrit en C (portable) |
| 1992 | Oracle 7 : PL/SQL, triggers, procédures stockées |
| 1997 | Oracle 8 : support objet-relationnel |
| 2001 | Oracle 9i : le "i" pour Internet, Real Application Clusters |
| 2007 | Oracle 11g : le "g" pour Grid Computing |
| 2013 | Oracle 12c : le "c" pour Cloud, architecture multitenant |
| 2019 | Oracle 19c : version Long Term Support, la plus déployée aujourd'hui |

> 💡 **Fun fact** : la première version d'Oracle s'appelait "v2" et non "v1", parce que Larry Ellison pensait que personne ne voudrait acheter une "version 1" ! 😄

### 3.2 Pourquoi Oracle est si populaire en entreprise ?

Oracle domine le marché des grandes entreprises pour plusieurs raisons :

- **Fiabilité** : Oracle garantit zéro perte de données grâce à ses mécanismes de redo log et recovery.
- **Performance** : l'optimiseur de requêtes Oracle est considéré comme le meilleur de l'industrie.
- **Scalabilité** : Oracle peut gérer des bases de données de plusieurs téraoctets avec des milliers d'utilisateurs simultanés.
- **Fonctionnalités** : PL/SQL, partitioning, RAC (Real Application Clusters), Data Guard, RMAN...
- **Support** : un support 24/7 de niveau entreprise.

### 3.3 Oracle vs les autres SGBD

| Critère | Oracle | PostgreSQL | MySQL |
|---------|--------|------------|-------|
| Licence | Commercial (~47k$/CPU) | Gratuit | Gratuit (+ version Enterprise) |
| PL/SQL | ✅ Natif | ✅ PL/pgSQL (compatible) | ❌ Limité |
| RAC (clustering) | ✅ | ❌ (mais Patroni) | ✅ (Group Replication) |
| Partitioning | ✅ Avancé | ✅ Basique | ✅ Basique |
| Optimiseur | Excellent | Très bon | Bon |
| DBA requis ? | Oui, c'est un métier | Souvent self-managed | Souvent self-managed |

> 🔑 **Le saviez-tu ?** Oracle est tellement présent en entreprise que "DBA Oracle" est un métier à part entière, avec des certifications dédiées (OCA, OCP, OCM).

---

## 4. Les concepts clés d'Oracle

Pour bien comprendre Oracle Database, il y a un certain nombre de concepts fondamentaux à maîtriser. Je vais te les expliquer un par un, avec des analogies pour que ce soit le plus clair possible. 😊

### 4.1 L'instance Oracle

C'est **le** concept le plus important. Une **instance Oracle**, c'est le moteur en mémoire qui permet d'accéder à une base de données. Concrètement, c'est un ensemble de **processus en arrière-plan** (background processes) et de **structures mémoire** qui tournent sur le serveur.

> 💡 **Analogie** : Si la base de données est un entrepôt rempli de marchandises (les données sur le disque), l'instance c'est l'équipe de manutentionnaires et le bureau de gestion (les processus et la mémoire) qui permettent de recevoir les commandes, aller chercher les produits et les livrer. Sans l'équipe, l'entrepôt est inaccessible. 🏭

Un point crucial : **instance ≠ base de données**. L'instance est en mémoire, la base de données est sur le disque. L'instance démarre, se connecte à la base, et c'est seulement à ce moment-là que tu peux travailler.

```
                 INSTANCE (en mémoire)
          ┌──────────────────────────────┐
          │   SGA (System Global Area)   │
          │   ┌────────┐ ┌────────────┐  │
          │   │ Buffer │ │ Shared     │  │
          │   │ Cache  │ │ Pool       │  │
          │   └────────┘ └────────────┘  │
          │   ┌────────────────────────┐ │
          │   │ Redo Log Buffer        │ │
          │   └────────────────────────┘ │
          │                              │
          │   Processus : PMON, SMON,    │
          │   DBW0, LGWR, CKPT...       │
          └──────────────┬───────────────┘
                         │ (accède à)
          ┌──────────────┴───────────────┐
          │  BASE DE DONNÉES (sur disque) │
          │  Datafiles, Redo Logs,       │
          │  Control Files               │
          └──────────────────────────────┘
```

### 4.2 La SGA (System Global Area)

La **SGA** est la zone de mémoire partagée principale d'une instance Oracle. C'est là que sont stockées temporairement les données les plus utilisées, les requêtes SQL analysées, et les journaux de transactions.

Elle se compose de plusieurs sous-parties :

| Composant | Rôle | Analogie |
|-----------|------|----------|
| **Buffer Cache** | Cache des blocs de données lus depuis le disque | Le comptoir de service rapide — les produits fréquemment demandés y sont gardés à portée de main 🏪 |
| **Shared Pool** | Cache des requêtes SQL analysées et du dictionnaire de données | Le classeur des procédures — on ne réécrit pas le mode d'emploi à chaque fois |
| **Redo Log Buffer** | Journal des modifications en cours (avant écriture sur disque) | Le carnet de bord du capitaine — tout y est noté avant d'être officialisé 📝 |
| **Java Pool** | Mémoire pour le code Java dans la base | Espace optionnel pour les programmes Java |
| **Large Pool** | Mémoire supplémentaire pour les opérations lourdes (backup, tri...) | La réserve de stockage pour les gros travaux |

> 🔑 **Pourquoi c'est important ?** Accéder à la mémoire (SGA) est **des milliers de fois plus rapide** qu'accéder au disque. Tout l'art du DBA Oracle consiste à dimensionner correctement la SGA pour que le maximum de données soient servies depuis la mémoire.

### 4.3 Les processus d'arrière-plan

L'instance Oracle fait tourner plusieurs **processus en arrière-plan** (background processes) qui s'occupent chacun d'une tâche précise. Les voici :

| Processus | Nom complet | Rôle |
|-----------|-------------|------|
| **PMON** | Process Monitor | Le surveillant. Nettoie les sessions mortes, libère les verrous orphelins |
| **SMON** | System Monitor | Le réparateur. Récupère l'instance après un crash, compacte l'espace libre |
| **DBW0** | Database Writer | L'écrivain. Écrit les blocs modifiés du Buffer Cache vers les datafiles |
| **LGWR** | Log Writer | Le greffier. Écrit le Redo Log Buffer vers les fichiers redo log sur disque |
| **CKPT** | Checkpoint | Le chronomètre. Déclenche les checkpoints pour synchroniser mémoire et disque |
| **ARC0** | Archiver | L'archiviste. Copie les redo logs pleins vers l'archive (si activé) |
| **RECO** | Recoverer | Le médiateur. Résout les transactions distribuées en suspens |

> 💡 **Analogie** : Imagine une cuisine de restaurant 👨‍🍳. Le **PMON** c'est le plongeur qui nettoie les tables abandonnées. Le **SMON** c'est le chef qui réorganise la cuisine après un incident. Le **DBW0** c'est le serveur qui apporte les plats en salle. Le **LGWR** c'est le caissier qui enregistre immédiatement chaque commande. Le **CKPT** c'est le manager qui vérifie régulièrement que tout est synchronisé.

### 4.4 Les fichiers de la base de données

Une base de données Oracle repose sur trois types de fichiers essentiels :

**1. Les Datafiles (fichiers de données)**

Ce sont les fichiers `.dbf` qui contiennent les données réelles : tes tables, tes index, tes procédures stockées... Chaque tablespace a au moins un datafile.

```
TABLESPACE "USERS"  →  /u01/app/oracle/oradata/ORCL/users01.dbf (100 Mo)
TABLESPACE "SYSTEM" →  /u01/app/oracle/oradata/ORCL/system01.dbf (800 Mo)
```

**2. Les Redo Log Files (fichiers de journalisation)**

Les redo logs enregistrent **toutes les modifications** apportées à la base de données. Si le serveur crashe, Oracle les rejoue pour retrouver un état cohérent. Ils fonctionnent de manière **circulaire** : quand un groupe est plein, on passe au suivant.

```
Groupe 1 (CURRENT)  →  redo01.log    ← on écrit ici
Groupe 2 (INACTIVE) →  redo02.log
Groupe 3 (INACTIVE) →  redo03.log
         └────── quand Groupe 1 est plein, on passe au Groupe 2
```

**3. Les Control Files (fichiers de contrôle)**

Le control file est le **fichier maître** de la base. Il contient la carte d'identité de la base : son nom, l'emplacement de tous les datafiles et redo logs, les informations de checkpoint... Sans lui, impossible d'ouvrir la base.

> ⚠️ **Attention** : La perte du control file est critique ! C'est pour ça qu'Oracle recommande d'en avoir au moins **2 copies multiplexées** sur des disques différents.

### 4.5 Les utilisateurs et les schémas

Dans Oracle, **un utilisateur = un schéma**. Quand tu crées un utilisateur (ex: `HR`), un schéma du même nom est automatiquement créé. Tout ce que cet utilisateur crée (tables, vues, index...) est rangé dans son schéma.

```sql
-- Créer un utilisateur (et donc un schéma)
CREATE USER stage IDENTIFIED BY motdepasse123
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

-- Lui donner les droits de se connecter et de créer des objets
GRANT CONNECT, RESOURCE TO stage;
```

Pour accéder aux objets d'un autre schéma, on préfixe avec le nom du schéma :

```sql
-- Accéder à la table EMPLOYEES du schéma HR
SELECT * FROM HR.EMPLOYEES;
```

> 💡 **Les utilisateurs pré-installés** : Oracle vient avec plusieurs utilisateurs par défaut :
> - **SYS** : le super-administrateur, propriétaire du dictionnaire de données
> - **SYSTEM** : l'administrateur courant, pour les tâches d'administration quotidiennes
> - **HR** : un schéma d'exemple avec des données d'employés (parfait pour apprendre !)
> - **SCOTT** : le schéma historique d'Oracle avec les tables DEPT et EMP (créé en 1977 !)

### 4.6 Les privilèges et les rôles

Oracle a un système de sécurité très granulaire basé sur les **privilèges**.

**Privilèges système** : le droit de faire quelque chose dans la base.
```sql
GRANT CREATE TABLE TO stage;        -- droit de créer des tables
GRANT CREATE SESSION TO stage;      -- droit de se connecter
GRANT SELECT ANY TABLE TO stage;    -- droit de lire toutes les tables
```

**Privilèges objet** : le droit d'agir sur un objet spécifique.
```sql
GRANT SELECT ON HR.EMPLOYEES TO stage;         -- lire cette table
GRANT INSERT, UPDATE ON HR.DEPARTMENTS TO stage; -- modifier cette table
```

Pour simplifier la gestion, on regroupe les privilèges dans des **rôles** :

| Rôle | Privilèges inclus | Usage |
|------|-------------------|-------|
| **CONNECT** | CREATE SESSION | Minimum pour se connecter |
| **RESOURCE** | CREATE TABLE, CREATE SEQUENCE, CREATE PROCEDURE... | Développeur qui crée des objets |
| **DBA** | Tous les privilèges système | Administrateur complet |

```sql
-- Créer un rôle personnalisé
CREATE ROLE lecteur_rh;
GRANT SELECT ON HR.EMPLOYEES TO lecteur_rh;
GRANT SELECT ON HR.DEPARTMENTS TO lecteur_rh;

-- L'attribuer à un utilisateur
GRANT lecteur_rh TO stage;
```

### 4.7 Les transactions et le modèle ACID

Une **transaction**, c'est un ensemble d'opérations SQL qui forment un tout indivisible. Soit toutes les opérations réussissent, soit aucune n'est appliquée.

Oracle garantit les propriétés **ACID** :

| Propriété | Signification | Exemple |
|-----------|---------------|---------|
| **A**tomicité | Tout ou rien | Un virement débite ET crédite, ou ne fait rien |
| **C**ohérence | La base reste dans un état valide | Les contraintes sont respectées avant et après |
| **I**solation | Les transactions concurrentes ne se voient pas | Tu ne vois pas les modifications non validées des autres |
| **D**urabilité | Une fois validée, c'est permanent | Même après un crash, les données validées sont là |

```sql
-- Exemple de transaction
UPDATE comptes SET solde = solde - 500 WHERE num_compte = 'A';
UPDATE comptes SET solde = solde + 500 WHERE num_compte = 'B';
COMMIT;   -- ← Les deux opérations sont validées ensemble

-- Oups, erreur ? On annule tout !
UPDATE comptes SET solde = solde - 500 WHERE num_compte = 'A';
UPDATE comptes SET solde = solde + 500 WHERE num_compte = 'C';  -- mauvais compte !
ROLLBACK; -- ← Rien n'est appliqué, on revient à l'état précédent
```

> 🔑 **Particularité Oracle** : Contrairement à MySQL, Oracle ne fait **pas d'auto-commit**. Tu dois explicitement valider tes modifications avec `COMMIT`. Les commandes DDL (`CREATE TABLE`, `ALTER TABLE`, etc.) font par contre un commit implicite automatique.

### 4.8 Le dictionnaire de données

Le **dictionnaire de données** (Data Dictionary), c'est la base de données *à l'intérieur* de la base de données. 🤯 Il contient toutes les métadonnées : la liste des tables, des colonnes, des utilisateurs, des privilèges, des tablespaces...

On y accède via des **vues système** organisées en familles :

| Préfixe | Portée | Exemple |
|---------|--------|---------|
| `USER_` | Objets appartenant à l'utilisateur connecté | `USER_TABLES`, `USER_COLUMNS` |
| `ALL_` | Objets accessibles par l'utilisateur | `ALL_TABLES`, `ALL_VIEWS` |
| `DBA_` | Tous les objets de la base (réservé aux admins) | `DBA_USERS`, `DBA_TABLESPACES` |
| `V$` | Vues dynamiques de performance (instance en cours) | `V$SESSION`, `V$INSTANCE` |

```sql
-- Lister toutes mes tables
SELECT table_name FROM USER_TABLES;

-- Voir les colonnes d'une table
SELECT column_name, data_type FROM ALL_TAB_COLUMNS
WHERE table_name = 'EMPLOYEES';

-- Voir les sessions actives (admin)
SELECT sid, serial#, username, status FROM V$SESSION;

-- Voir les tablespaces
SELECT tablespace_name, status FROM DBA_TABLESPACES;
```

> 💡 **Astuce** : La table `DICTIONARY` (ou `DICT`) liste toutes les vues du dictionnaire disponibles. Quand tu ne sais pas quelle vue chercher, commence par là !
> ```sql
> SELECT table_name, comments FROM DICTIONARY WHERE table_name LIKE '%TABLE%';
> ```

### 4.9 Les états d'une instance Oracle

Tout comme une adjacence OSPF passe par plusieurs états avant d'être pleinement opérationnelle, une instance Oracle passe par plusieurs **états** avant d'être prête à recevoir des requêtes :

```
SHUTDOWN → NOMOUNT → MOUNT → OPEN
```

| État | Ce qui se passe | Qui peut travailler ? |
|------|-----------------|----------------------|
| **SHUTDOWN** | Rien ne tourne. L'instance est éteinte. | Personne |
| **NOMOUNT** | L'instance démarre : la SGA est allouée, les processus d'arrière-plan sont lancés. Mais la base n'est pas encore associée. | Uniquement pour recréer un control file |
| **MOUNT** | Oracle lit le control file et connaît l'emplacement des fichiers. La base est associée mais pas encore accessible. | DBA uniquement (recovery, maintenance) |
| **OPEN** | Les datafiles et redo logs sont ouverts. La base est pleinement opérationnelle ! ✅ | Tout le monde |

```sql
-- Démarrer l'instance complètement
STARTUP;

-- Ou étape par étape
STARTUP NOMOUNT;
ALTER DATABASE MOUNT;
ALTER DATABASE OPEN;

-- Arrêter proprement
SHUTDOWN IMMEDIATE;
```

> ⚠️ **Modes d'arrêt** :
> - `SHUTDOWN NORMAL` : attend que toutes les sessions se déconnectent (peut prendre des heures !)
> - `SHUTDOWN IMMEDIATE` : coupe les sessions actives et fait un rollback des transactions en cours (le plus utilisé)
> - `SHUTDOWN ABORT` : arrêt brutal, comme débrancher la prise (recovery au prochain démarrage)

---

## 5. L'architecture Oracle en coulisses

Maintenant qu'on a les concepts de base, regardons comment Oracle fonctionne réellement sous le capot. C'est un peu comme regarder un film en coulisses. 🎬

### 5.1 Le parcours d'une requête SELECT

Quand tu tapes `SELECT * FROM HR.EMPLOYEES WHERE salary > 10000;`, voici tout ce qui se passe en coulisses, en quelques millisecondes :

**Étape 1 — Analyse syntaxique (Parse)**

Oracle vérifie d'abord que ta requête est du SQL valide. C'est le **parsing**. Il vérifie la syntaxe, l'existence des tables et des colonnes, et tes droits d'accès.

Mais avant de tout réanalyser, Oracle regarde d'abord dans le **Shared Pool** (dans la SGA) si cette même requête a déjà été exécutée. Si oui, on réutilise le plan d'exécution existant — c'est un **soft parse**, beaucoup plus rapide qu'un **hard parse** complet.

```
                         Requête SQL
                              │
                     ┌────────▼────────┐
                     │  Shared Pool :  │
                     │  déjà analysée ?│
                     └────────┬────────┘
                        Oui / │ \ Non
                       ┌──────┘  └──────┐
                  Soft Parse      Hard Parse
                  (rapide ⚡)    (complet 🔍)
                       │              │
                       └──────┬───────┘
                              │
                     Plan d'exécution
```

> 💡 **Pourquoi c'est important ?** Sur un système de production avec des milliers de requêtes par seconde, le soft parse est crucial. C'est pour ça qu'on utilise des **bind variables** (`:param` au lieu de valeurs en dur) — ça permet à Oracle de réutiliser le même plan d'exécution pour des requêtes similaires.

**Étape 2 — Optimisation**

L'**optimiseur** (Query Optimizer) est le cerveau d'Oracle. Il analyse ta requête et décide de la meilleure stratégie pour la traiter. Doit-il :
- Lire la table entière (**Full Table Scan**) ?
- Utiliser un index (**Index Scan**) ?
- Dans quel ordre joindre les tables ?
- Quel algorithme de jointure utiliser (Nested Loops, Hash Join, Sort Merge) ?

L'optimiseur Oracle est **basé sur les coûts** (Cost-Based Optimizer — CBO). Il estime le coût de chaque stratégie possible et choisit la moins coûteuse. Pour cela, il s'appuie sur les **statistiques** des tables (nombre de lignes, distribution des valeurs, etc.).

```sql
-- Voir le plan d'exécution choisi par l'optimiseur
EXPLAIN PLAN FOR
SELECT * FROM HR.EMPLOYEES WHERE salary > 10000;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
```

**Étape 3 — Exécution**

Le moteur d'exécution suit le plan établi par l'optimiseur :
1. Il cherche d'abord les blocs de données dans le **Buffer Cache** (SGA)
2. Si les blocs n'y sont pas → **cache miss** → il va les lire sur disque et les charge en mémoire
3. Il applique les filtres (`WHERE salary > 10000`)
4. Il trie, groupe, agrège selon les besoins
5. Il renvoie les résultats au client

```
  Buffer Cache (SGA)           Disque
  ┌──────────────────┐    ┌──────────────┐
  │ Bloc 42 ✅ trouvé│    │ users01.dbf  │
  │ Bloc 58 ✅ trouvé│    │              │
  │ Bloc 71 ❌ absent├───►│ Lecture bloc  │
  │     ...          │◄───┤ 71 → cache   │
  └──────────────────┘    └──────────────┘
```

> 🔑 **Le ratio de succès du Buffer Cache** (Buffer Cache Hit Ratio) est un indicateur clé de performance. Idéalement, on veut que plus de 95% des lectures soient servies depuis la mémoire.

### 5.2 Le parcours d'une requête DML (INSERT, UPDATE, DELETE)

Quand tu modifies des données, le processus est plus complexe car Oracle doit garantir la **recoverabilité** et la **cohérence**. Suivons un `UPDATE` étape par étape :

```sql
UPDATE HR.EMPLOYEES SET salary = 60000 WHERE employee_id = 100;
```

**Étape 1 — Génération des données d'annulation (Undo)**

Avant de modifier quoi que ce soit, Oracle sauvegarde l'**ancienne valeur** dans le **tablespace UNDO** (aussi appelé segment de rollback). C'est ce qui permet de faire un `ROLLBACK` si besoin, et aussi de fournir une lecture cohérente aux autres sessions.

```
Avant modification :
  salary = 52000  ──────►  Copié dans UNDO
                           (pour rollback éventuel)
```

**Étape 2 — Écriture dans le Redo Log Buffer**

Oracle écrit dans le **Redo Log Buffer** (en mémoire) une description de la modification : *"Sur le bloc X, à l'offset Y, remplacer 52000 par 60000"*. C'est le **redo** — il permet de *rejouer* la modification en cas de crash.

**Étape 3 — Modification du bloc en mémoire**

Le bloc de données contenant la ligne `employee_id = 100` est modifié **en mémoire** dans le Buffer Cache. Le bloc est marqué comme **dirty** (sale) — il diffère de sa version sur disque.

**Étape 4 — En attente du COMMIT**

À ce stade, la modification est faite en mémoire mais **pas encore permanente**. L'utilisateur peut encore faire un `ROLLBACK`. Les autres sessions qui lisent cette ligne voient toujours l'ancienne valeur (grâce à l'UNDO) — c'est la **lecture cohérente** (consistent read).

```
           Session A                    Session B
              │                            │
  UPDATE salary = 60000          SELECT salary FROM ...
              │                            │
         (pas de COMMIT)            Lit l'UNDO → voit 52000
              │                    (lecture cohérente ✅)
```

### 5.3 Que se passe-t-il au COMMIT ?

Quand tu tapes `COMMIT;`, voici la séquence critique :

1. **LGWR** (Log Writer) écrit le contenu du Redo Log Buffer vers les **fichiers redo log sur disque**. C'est une écriture **synchrone** — Oracle attend qu'elle soit terminée avant de confirmer le COMMIT.
2. Oracle renvoie "Commit complete." à l'utilisateur.
3. C'est tout ! Les blocs modifiés restent en mémoire pour l'instant.

> ⚠️ **Point crucial** : Au moment du COMMIT, les données modifiées ne sont **PAS** encore écrites dans les datafiles ! Elles sont toujours dans le Buffer Cache en mémoire. Seul le **redo** est écrit sur disque. C'est ce qu'on appelle le mécanisme de **write-ahead logging** — le journal passe toujours en premier.

**Mais alors, quand est-ce que les datafiles sont mis à jour ?**

C'est **DBW0** (Database Writer) qui s'en charge, mais **de manière asynchrone**, quand il le juge opportun :
- Quand le Buffer Cache est trop plein
- Lors d'un **checkpoint** (déclenché par CKPT)
- Quand il n'a rien d'autre à faire (idle writes)

```
  COMMIT
    │
    ├─► LGWR écrit le redo ──► Redo Log File (disque)  ← IMMÉDIAT ⚡
    │
    └─► DBW0 écrira les blocs ──► Datafile (disque)    ← PLUS TARD 🕐
```

> 💡 **Pourquoi cette architecture ?** Parce qu'écrire séquentiellement dans un fichier redo (comme LGWR) est **beaucoup plus rapide** qu'écrire des blocs dispersés dans les datafiles (comme DBW0). En cas de crash, Oracle n'a qu'à rejouer le redo pour retrouver toutes les modifications committées.

### 5.4 Le mécanisme de recovery (récupération après crash)

Imaginons le pire : le serveur perd l'alimentation électrique en plein fonctionnement. La mémoire est vidée, les blocs dirty du Buffer Cache sont perdus. Que se passe-t-il au redémarrage ?

**SMON** (System Monitor) entre en action et effectue un **Instance Recovery** en deux phases :

**Phase 1 — Roll Forward (rejeu)**

SMON lit les redo logs et **rejoue toutes les modifications** qui y sont enregistrées, y compris celles des transactions committées ET non committées. Ça remet la base dans l'état exact où elle était juste avant le crash.

**Phase 2 — Roll Back (annulation)**

SMON identifie les transactions qui n'avaient pas été committées au moment du crash et les **annule** en utilisant les données d'UNDO. Seules les transactions validées par un `COMMIT` survivent.

```
  CRASH ! 💥
    │
    ▼
  Redémarrage
    │
    ├─► Phase 1 : Roll Forward
    │   Rejoue TOUS les redo logs
    │   (transactions committées + non committées)
    │
    └─► Phase 2 : Roll Back
        Annule les transactions non committées
        (grâce aux données UNDO)
    │
    ▼
  Base cohérente ✅
  Aucune donnée committée perdue !
```

> 🔑 **C'est ça, la garantie de Durabilité du modèle ACID.** Tant que le COMMIT a été confirmé par Oracle, les données survivront à n'importe quel crash. C'est ce mécanisme qui fait la réputation de fiabilité d'Oracle en entreprise.

### 5.5 Le mécanisme de lecture cohérente (Consistent Read)

C'est l'un des mécanismes les plus élégants d'Oracle. Quand une session exécute un `SELECT`, elle voit les données **telles qu'elles étaient au moment où le SELECT a commencé**, même si d'autres sessions sont en train de les modifier en parallèle.

Comment Oracle fait-il ça ? Grâce au **tablespace UNDO** :

1. La session B lance un `SELECT * FROM employees;` à 14h00:00
2. À 14h00:01, la session A modifie une ligne et fait un COMMIT
3. La session B, toujours en train de lire, tombe sur le bloc modifié
4. Oracle détecte que ce bloc a été modifié **après** le début du SELECT
5. Oracle va chercher l'ancienne version dans l'**UNDO** et la présente à la session B

Résultat : la session B obtient une photo cohérente des données à 14h00:00, sans être bloquée par les modifications de la session A. **Les lecteurs ne bloquent jamais les écrivains, et les écrivains ne bloquent jamais les lecteurs.** 🎯

> 💡 **Comparaison** : Dans SQL Server ou MySQL (InnoDB en mode par défaut), les lectures peuvent être bloquées par des écritures en cours. Oracle, grâce au mécanisme d'UNDO, évite ce problème. C'est un avantage majeur pour les applications à forte concurrence.

### 5.6 Les verrous (Locks)

Même si les lecteurs ne bloquent pas les écrivains, il faut bien gérer le cas où **deux sessions veulent modifier la même ligne en même temps**. C'est le rôle des **verrous** (locks).

Oracle utilise un verrouillage **au niveau de la ligne** (row-level locking), pas au niveau de la table. Ça signifie que deux sessions peuvent modifier des lignes différentes de la même table simultanément, sans se gêner.

```
  Session A                         Session B
     │                                 │
  UPDATE ... WHERE id = 1;          UPDATE ... WHERE id = 2;
  (verrou sur ligne 1)              (verrou sur ligne 2)
     │                                 │
  Pas de conflit ! ✅               Pas de conflit ! ✅
```

Mais si la session B essaie de modifier la **même ligne** que la session A :

```
  Session A                         Session B
     │                                 │
  UPDATE ... WHERE id = 1;          UPDATE ... WHERE id = 1;
  (verrou acquis ✅)                (attend... ⏳)
     │                                 │
  COMMIT;                           (verrou libéré → modification appliquée)
```

La session B est **bloquée** jusqu'à ce que la session A fasse un `COMMIT` ou un `ROLLBACK`.

> ⚠️ **Le deadlock** : Si la session A attend un verrou détenu par B, et que B attend un verrou détenu par A, c'est un **deadlock** (interblocage). Oracle le détecte automatiquement et annule l'une des deux transactions avec l'erreur `ORA-00060: deadlock detected`.

### 5.7 L'architecture réseau : Listener et TNS

Oracle utilise une architecture client-serveur. Les clients (SQL*Plus, applications Java, etc.) ne se connectent pas directement à l'instance — ils passent par un intermédiaire : le **Listener**.

**Le Listener** est un processus qui écoute sur un port réseau (par défaut **1521**) les demandes de connexion entrantes. Quand un client se connecte, le Listener le redirige vers un **Server Process** dédié (ou partagé) qui traitera ses requêtes.

```
  ┌──────────┐         ┌───────────┐         ┌──────────────┐
  │ SQL*Plus │────────►│ Listener  │────────►│ Instance     │
  │ (client) │  TNS    │ (port 1521│  crée   │ Oracle       │
  └──────────┘         │  )        │  un     │              │
                       └───────────┘  server │ ┌──────────┐ │
  ┌──────────┐              │         process│ │ Server   │ │
  │ App Java │──────────────┘                │ │ Process  │ │
  │ (client) │                               │ └──────────┘ │
  └──────────┘                               └──────────────┘
```

**TNS (Transparent Network Substrate)** est le protocole réseau d'Oracle. La configuration côté client se fait dans le fichier `tnsnames.ora` :

```
ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 192.168.1.100)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = orcl)
    )
  )
```

```bash
# Connexion via SQL*Plus avec un TNS alias
sqlplus hr/hr@ORCL

# Tester la connectivité réseau
tnsping ORCL

# Gérer le Listener
lsnrctl start      # Démarrer le Listener
lsnrctl stop       # Arrêter le Listener
lsnrctl status     # Vérifier le statut
```

> 💡 **Les deux modes de connexion** :
> - **Dedicated Server** : un processus serveur par session client. Simple et isolé, c'est le mode par défaut.
> - **Shared Server** : un pool de processus serveur partagé entre plusieurs sessions. Économise la mémoire quand il y a beaucoup de connexions, mais plus complexe à configurer.

### 5.8 L'architecture mémoire complète : SGA + PGA

On a déjà parlé de la SGA, mais il y a une autre zone mémoire tout aussi importante : la **PGA** (Program Global Area).

La **PGA** est une zone mémoire **privée** à chaque processus serveur. Chaque session a sa propre PGA, qui contient :
- Les variables de session
- La zone de tri (pour les `ORDER BY`, `GROUP BY`, `DISTINCT`)
- La zone de hachage (pour les jointures Hash Join)
- Le contexte de la requête en cours

```
                    ┌─────────────────────────────────┐
                    │        MÉMOIRE DU SERVEUR        │
                    │                                   │
                    │  ┌────────────────────────────┐  │
                    │  │     SGA (partagée)          │  │
                    │  │  ┌────────┐ ┌───────────┐  │  │
                    │  │  │ Buffer │ │  Shared   │  │  │
                    │  │  │ Cache  │ │  Pool     │  │  │
                    │  │  └────────┘ └───────────┘  │  │
                    │  │  ┌────────┐ ┌───────────┐  │  │
                    │  │  │ Redo   │ │  Java     │  │  │
                    │  │  │ Log Buf│ │  Pool     │  │  │
                    │  │  └────────┘ └───────────┘  │  │
                    │  └────────────────────────────┘  │
                    │                                   │
                    │  ┌──────┐ ┌──────┐ ┌──────┐      │
                    │  │ PGA  │ │ PGA  │ │ PGA  │      │
                    │  │ (S1) │ │ (S2) │ │ (S3) │ ...  │
                    │  └──────┘ └──────┘ └──────┘      │
                    │  (une PGA par session)            │
                    └─────────────────────────────────┘
```

| Zone mémoire | Portée | Contenu principal |
|---|---|---|
| **SGA** | Partagée entre toutes les sessions | Buffer Cache, Shared Pool, Redo Log Buffer |
| **PGA** | Privée à chaque session | Zone de tri, zone de hachage, contexte de session |

> 🔑 **Dimensionnement** : Dans Oracle 11g et plus, tu peux utiliser la gestion automatique de la mémoire (**AMM** — Automatic Memory Management) qui laisse Oracle répartir la mémoire entre SGA et PGA selon les besoins :
> ```sql
> ALTER SYSTEM SET MEMORY_TARGET = 2G SCOPE=SPFILE;
> ALTER SYSTEM SET MEMORY_MAX_TARGET = 2G SCOPE=SPFILE;
> ```

### 5.9 Les checkpoints et les redo log switches

On a vu que DBW0 n'écrit pas immédiatement les blocs modifiés sur disque. Mais à un moment donné, il faut bien synchroniser la mémoire et le disque. C'est le rôle des **checkpoints**.

Un **checkpoint** ordonne à DBW0 d'écrire tous les blocs dirty du Buffer Cache vers les datafiles. Le processus **CKPT** met ensuite à jour les en-têtes des datafiles et le control file avec la position du checkpoint.

Les checkpoints se produisent lors des événements suivants :
- Un **redo log switch** (passage d'un groupe de redo log au suivant)
- Un `ALTER SYSTEM CHECKPOINT;` explicite
- Un `SHUTDOWN` (sauf ABORT)
- Selon l'intervalle configuré

**Le cycle des redo logs** fonctionne de manière circulaire :

```
     ┌─────────┐     ┌─────────┐     ┌─────────┐
     │ Groupe 1│────►│ Groupe 2│────►│ Groupe 3│
     │ CURRENT │     │ INACTIVE│     │ INACTIVE│
     └─────────┘     └─────────┘     └─────────┘
          ▲                                │
          │                                │
          └────────────────────────────────┘
                    (circulaire)
```

Quand le groupe courant est plein :
1. LGWR passe au groupe suivant → c'est un **log switch**
2. Le log switch déclenche un **checkpoint**
3. DBW0 écrit les blocs dirty
4. Si l'**archivage** est activé (ARCHIVELOG mode), **ARC0** copie le redo log plein vers l'espace d'archivage

> ⚠️ **ARCHIVELOG vs NOARCHIVELOG** :
> - En mode **NOARCHIVELOG** : les redo logs sont écrasés après chaque cycle. En cas de perte d'un datafile, tu ne peux restaurer que jusqu'au dernier backup. Suffisant pour le développement.
> - En mode **ARCHIVELOG** : chaque redo log est archivé avant d'être réutilisé. Tu peux restaurer à n'importe quel point dans le temps (**Point-in-Time Recovery**). **Obligatoire en production !**

```sql
-- Vérifier le mode d'archivage
ARCHIVE LOG LIST;

-- Passer en mode ARCHIVELOG (nécessite un redémarrage)
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;
```

### 5.10 Résumé : le cycle de vie complet d'une modification

Pour récapituler, voici le cycle de vie complet d'un `UPDATE` suivi d'un `COMMIT` :

```
1. Parse & Optimize    →  Analyse SQL, plan d'exécution
2. Undo generation     →  Ancienne valeur sauvée dans UNDO
3. Redo generation     →  Modification écrite dans Redo Log Buffer
4. Block modification  →  Bloc modifié dans Buffer Cache (dirty)
5. COMMIT              →  LGWR écrit le redo sur disque ← DURABILITÉ
6. Confirmation        →  "Commit complete." renvoyé au client
7. Checkpoint (+ tard) →  DBW0 écrit les dirty blocks dans les datafiles
```

Ce mécanisme a l'air complexe, mais c'est ce qui permet à Oracle de garantir :
- ✅ **Zéro perte de données** pour les transactions committées
- ✅ **Performance optimale** (les écritures disque coûteuses sont différées)
- ✅ **Lectures cohérentes** sans bloquer les écrivains
- ✅ **Recovery rapide** après un crash

C'est le cœur battant d'Oracle Database. 💓

---

*La suite arrive avec la Section 6 : Présentation de notre laboratoire...*
