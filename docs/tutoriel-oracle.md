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

*La suite sera rédigée section par section. Les prochaines sections couvriront l'architecture Oracle, le laboratoire pratique, et les premières commandes.*
