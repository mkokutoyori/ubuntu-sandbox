# Roadmap — Ubuntu Sandbox Network Simulator

> Document de suivi des fonctionnalites manquantes et a implementer.
> Genere le 2026-03-25 a partir d'un audit complet du code source.

---

## Table des matieres

1. [Oracle Database — SQL DML](#1-oracle-database--sql-dml)
2. [Oracle Database — SQL DDL](#2-oracle-database--sql-ddl)
3. [Oracle Database — PL/SQL](#3-oracle-database--plsql)
4. [Oracle Database — Transactions](#4-oracle-database--transactions)
5. [Oracle Database — Dictionnaire de donnees](#5-oracle-database--dictionnaire-de-donnees)
6. [Oracle Database — Packages built-in](#6-oracle-database--packages-built-in)
7. [Oracle Database — Fonctions SQL manquantes](#7-oracle-database--fonctions-sql-manquantes)
8. [Oracle Database — SQL*Plus](#8-oracle-database--sqlplus)
9. [Oracle Database — Fonctionnalites avancees](#9-oracle-database--fonctionnalites-avancees)
10. [Linux — Shell Bash](#10-linux--shell-bash)
11. [Linux — Commandes systeme](#11-linux--commandes-systeme)
12. [Linux — Filesystem virtuel](#12-linux--filesystem-virtuel)
13. [Reseau — Layer 2 (Data Link)](#13-reseau--layer-2-data-link)
14. [Reseau — Layer 3 (Network)](#14-reseau--layer-3-network)
15. [Reseau — Layer 4+ (Transport/Application)](#15-reseau--layer-4-transportapplication)
16. [Reseau — Shells CLI (Cisco IOS / Huawei VRP / Windows)](#16-reseau--shells-cli-cisco-ios--huawei-vrp--windows)
17. [Priorites d'implementation](#17-priorites-dimplementation)

---

## 1. Oracle Database — SQL DML

Fonctionnalites manquantes ou partielles dans le traitement des requetes DML (Data Manipulation Language).

### 1.1 SELECT — Fonctions manquantes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `REGEXP_SUBSTR(string, pattern [, pos [, occurrence [, flags [, group]]]])` | Haute | Extraction de sous-chaines par expression reguliere. Tres utilise dans les cours Oracle. |
| `REGEXP_REPLACE(string, pattern, replacement [, pos [, occurrence [, flags]]])` | Haute | Remplacement par regex. Indispensable pour la manipulation de texte avancee. |
| `REGEXP_INSTR(string, pattern [, pos [, occurrence [, return_opt [, flags [, group]]]]])` | Haute | Position d'un motif regex dans une chaine. |
| `REGEXP_LIKE(string, pattern [, flags])` | Haute | Condition de correspondance regex dans un WHERE. |
| `REGEXP_COUNT(string, pattern [, pos [, flags]])` | Moyenne | Nombre d'occurrences d'un motif regex. |
| `LISTAGG(expr, delimiter) WITHIN GROUP (ORDER BY ...)` | Haute | Actuellement le lexer reconnait le mot-cle mais l'execution ne collecte pas les valeurs a travers les lignes groupees. Doit produire une chaine concatenee. |
| `PERCENTILE_CONT(fraction) WITHIN GROUP (ORDER BY expr)` | Moyenne | Calcul de percentile continu (interpolation lineaire). |
| `PERCENTILE_DISC(fraction) WITHIN GROUP (ORDER BY expr)` | Moyenne | Calcul de percentile discret (valeur reelle la plus proche). |
| `CUME_DIST()` | Basse | Distribution cumulative dans une fenetre. |
| `PERCENT_RANK()` | Basse | Rang en pourcentage dans une fenetre. |
| `RATIO_TO_REPORT(expr) OVER (...)` | Basse | Ratio d'une valeur par rapport au total de la partition. |

### 1.2 SELECT — Clauses manquantes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `SELECT ... FOR UPDATE WAIT n` enforcement | Moyenne | La clause est parsee mais ne bloque pas reellement l'acces concurrent. Necessite l'implementation du systeme de verrous (voir section Transactions). |
| `SELECT ... FOR UPDATE SKIP LOCKED` | Basse | Clause permettant de sauter les lignes verrouillees. |
| `PIVOT / UNPIVOT` | Moyenne | Transformation de lignes en colonnes et inversement. Utilise dans les rapports. |
| `MODEL` clause | Basse | Clause Oracle pour le calcul inter-lignes style tableur. Rarement enseigne. |
| `FLASHBACK QUERY (AS OF TIMESTAMP / AS OF SCN)` | Moyenne | Lecture de donnees a un instant passe. Necessite un undo log (voir section Transactions). |
| `TABLE()` function (unnesting) | Basse | Desimbrication de collections PL/SQL en lignes SQL. Necessite les collections PL/SQL. |

### 1.3 INSERT — Fonctionnalites manquantes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| Multi-table INSERT execution | Moyenne | `INSERT ALL INTO t1 ... INTO t2 ... SELECT ...` et `INSERT FIRST WHEN cond THEN INTO t1 ...`. Le parsing est fait, l'execution doit etre completee pour inserer dans plusieurs tables conditionnellement. |
| `RETURNING ... INTO` (binding reel) | Moyenne | Actuellement basique. Doit retourner les valeurs reellement inserees dans des variables PL/SQL ou bind variables SQL*Plus. |

### 1.4 UPDATE / DELETE — Fonctionnalites manquantes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `RETURNING ... INTO` (binding reel) | Moyenne | Meme probleme que pour INSERT : le binding vers des variables n'est pas fonctionnel. |
| UPDATE avec sous-requete dans SET | Basse | `UPDATE t SET col = (SELECT ...)` — verifier la completude. |

### 1.5 MERGE — Fonctionnalites manquantes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `MERGE ... DELETE WHERE` | Basse | Clause optionnelle permettant de supprimer des lignes matchees apres l'update si une condition est remplie. |
| `MERGE ... LOG ERRORS` | Basse | Clause de journalisation des erreurs lors du merge. |

---

## 2. Oracle Database — SQL DDL

Fonctionnalites manquantes ou partielles dans les operations de definition de structure (Data Definition Language).

### 2.1 Tables — Partitionnement

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `PARTITION BY RANGE (column)` | Moyenne | Partitionnement par plage de valeurs. Fondamental pour les cours d'administration Oracle (tables volumineuses). Syntaxe : `CREATE TABLE t (...) PARTITION BY RANGE (date_col) (PARTITION p1 VALUES LESS THAN (TO_DATE('2025-01-01','YYYY-MM-DD')), ...)`. |
| `PARTITION BY LIST (column)` | Moyenne | Partitionnement par liste de valeurs discretes. `PARTITION BY LIST (region) (PARTITION p_east VALUES ('NY','NJ'), ...)`. |
| `PARTITION BY HASH (column)` | Basse | Partitionnement par hachage pour distribution uniforme. `PARTITION BY HASH (id) PARTITIONS 4`. |
| Composite partitioning (RANGE-LIST, RANGE-HASH) | Basse | Sous-partitionnement au sein d'une partition. |
| `ALTER TABLE ... ADD/DROP/SPLIT/MERGE/TRUNCATE PARTITION` | Moyenne | Operations de maintenance sur les partitions existantes. |
| `ALTER TABLE ... EXCHANGE PARTITION` | Basse | Echange d'une partition avec une table non-partitionnee. |

### 2.2 Tables — Contraintes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| Contrainte DEFERRABLE enforcement reel | Basse | Les contraintes marquees `DEFERRABLE INITIALLY DEFERRED` sont parsees mais verifiees immediatement au lieu d'etre verifiees au COMMIT. Necessite le support transactionnel complet. |
| `SET CONSTRAINTS ... IMMEDIATE / DEFERRED` | Basse | Commande pour changer le mode de verification des contraintes en cours de transaction. |

### 2.3 Index

| Fonctionnalite | Priorite | Description |
|---|---|---|
| Function-based INDEX | Moyenne | `CREATE INDEX idx ON t (UPPER(name))`. Permet d'indexer le resultat d'une expression. Le parsing n'est pas implemente. |
| `CREATE INDEX ... REVERSE` | Basse | Index inverse pour eviter la contention sur les sequences. |
| `CREATE INDEX ... COMPRESS n` | Basse | Compression de prefixe d'index. |
| Index partitionne (LOCAL / GLOBAL) | Basse | Index aligne ou non sur le partitionnement de la table. |
| CONTEXT INDEX (Oracle Text) | Basse | Index de recherche plein texte (`CREATE INDEX idx ON t(col) INDEXTYPE IS CTXSYS.CONTEXT`). |
| BITMAP INDEX execution reelle | Basse | L'index bitmap est cree mais n'est pas utilise dans l'evaluation des requetes. |

### 2.4 Materialized Views

| Fonctionnalite | Priorite | Description |
|---|---|---|
| Materialisation reelle (BUILD IMMEDIATE) | Moyenne | Actuellement stub : le CREATE MATERIALIZED VIEW est parse mais la requete sous-jacente n'est pas executee et les donnees ne sont pas stockees. |
| `REFRESH COMPLETE ON DEMAND` execution | Moyenne | Execution de `DBMS_MVIEW.REFRESH('mv_name', 'C')` ou `ALTER MATERIALIZED VIEW mv REFRESH COMPLETE`. |
| `REFRESH FAST ON COMMIT` | Basse | Rafraichissement incremental via materialized view logs. |
| Query rewrite | Basse | L'optimiseur redirige automatiquement les requetes vers la MV quand applicable. |
| Materialized View Logs | Basse | `CREATE MATERIALIZED VIEW LOG ON table WITH ROWID, PRIMARY KEY`. |

### 2.5 Database Links

| Fonctionnalite | Priorite | Description |
|---|---|---|
| Queries cross-link (`table@dblink`) | Moyenne | La syntaxe `SELECT * FROM emp@remote_db` n'est pas supportee. Le lien est cree mais aucune requete distante ne fonctionne. |
| Transactions distribuees (two-phase commit) | Basse | Commit a deux phases sur des liens distants. |

### 2.6 Autres objets DDL manquants

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `CREATE TYPE` (object types) | Basse | Types objet Oracle : `CREATE TYPE addr_type AS OBJECT (street VARCHAR2(100), city VARCHAR2(50))`. |
| `CREATE TYPE ... AS TABLE OF` | Basse | Types collection pour les nested tables. |
| `CREATE TYPE ... AS VARRAY` | Basse | Types tableau de taille fixe. |
| `CREATE DIRECTORY` execution reelle | Basse | Actuellement parse mais le repertoire n'est pas utilisable par UTL_FILE. |
| `CREATE CONTEXT` | Basse | Contexte applicatif pour SYS_CONTEXT. |

---

## 3. Oracle Database — PL/SQL

Fonctionnalites manquantes dans le moteur PL/SQL. C'est l'un des domaines avec le plus de lacunes critiques pour l'enseignement.

### 3.1 Curseurs explicites

**Priorite : Haute** — Les curseurs sont fondamentaux dans tout cours PL/SQL.

| Fonctionnalite | Description |
|---|---|
| `CURSOR cursor_name IS SELECT ...` | Declaration d'un curseur nomme dans la section DECLARE. |
| `OPEN cursor_name` | Ouverture du curseur (execution de la requete). |
| `FETCH cursor_name INTO var1, var2, ...` | Recuperation d'une ligne dans des variables. |
| `CLOSE cursor_name` | Fermeture du curseur et liberation des ressources. |
| `%FOUND` | Attribut : TRUE si le dernier FETCH a retourne une ligne. |
| `%NOTFOUND` | Attribut : TRUE si le dernier FETCH n'a pas retourne de ligne. |
| `%ROWCOUNT` | Attribut : nombre de lignes fetchees jusqu'a present. |
| `%ISOPEN` | Attribut : TRUE si le curseur est ouvert. |
| Cursor FOR LOOP | `FOR rec IN cursor_name LOOP ... END LOOP;` — ouverture, fetch et fermeture implicites. |
| Cursor FOR LOOP avec SELECT inline | `FOR rec IN (SELECT ...) LOOP ... END LOOP;` |
| Curseurs parametres | `CURSOR c(p_id NUMBER) IS SELECT ... WHERE id = p_id;` puis `OPEN c(10);` |
| Curseur avec RETURNING | Curseur pour capturer les lignes affectees par un DML. |

### 3.2 Curseurs implicites (SQL%)

**Priorite : Haute** — Utilise dans presque tous les blocs PL/SQL apres un DML.

| Fonctionnalite | Description |
|---|---|
| `SQL%ROWCOUNT` | Nombre de lignes affectees par le dernier DML (INSERT/UPDATE/DELETE). |
| `SQL%FOUND` | TRUE si le dernier DML a affecte au moins une ligne. |
| `SQL%NOTFOUND` | TRUE si le dernier DML n'a affecte aucune ligne. |
| `SQL%ISOPEN` | Toujours FALSE pour les curseurs implicites (mais doit etre supporte). |

### 3.3 Packages

**Priorite : Haute** — Les packages sont le mecanisme d'encapsulation principal en PL/SQL.

| Fonctionnalite | Description |
|---|---|
| `CREATE [OR REPLACE] PACKAGE pkg_name AS ... END;` | Specification du package : declarations publiques (types, constantes, procedures, fonctions, curseurs). |
| `CREATE [OR REPLACE] PACKAGE BODY pkg_name AS ... END;` | Corps du package : implementation des procedures/fonctions declarees dans la spec. |
| Variables de package (etat persistant par session) | Les variables declarees dans le corps du package persistent pendant toute la session. |
| Section d'initialisation | Bloc `BEGIN ... END;` a la fin du package body, execute une seule fois au premier appel. |
| Surcharge de procedures/fonctions | Plusieurs procedures avec le meme nom mais des signatures differentes dans un meme package. |
| Types definis dans le package | `TYPE rec_type IS RECORD (...)`, `TYPE tab_type IS TABLE OF ...`, etc. |
| Appel qualifie `pkg_name.proc_name(...)` | Appel d'une procedure/fonction via le nom du package. |
| Recompilation `ALTER PACKAGE pkg COMPILE [BODY]` | Recompilation du package ou de son corps. |
| Invalidation en cascade | Quand un objet reference par le package change, le package passe en INVALID. |

### 3.4 Collections

**Priorite : Moyenne** — Necessaire pour les traitements en masse et les retours multi-lignes.

| Fonctionnalite | Description |
|---|---|
| `TYPE name IS TABLE OF datatype` | Nested table : collection non bornee indexee par entier. |
| `TYPE name IS TABLE OF datatype INDEX BY PLS_INTEGER` | Tableau associatif (index-by table). |
| `TYPE name IS VARRAY(n) OF datatype` | Tableau de taille fixe. |
| Methodes de collection : `.COUNT`, `.FIRST`, `.LAST`, `.NEXT`, `.PRIOR`, `.EXISTS`, `.DELETE`, `.EXTEND`, `.TRIM` | Methodes standard sur les collections. |
| Collections imbriquees | Collections de collections ou de records. |

### 3.5 Bulk Operations

**Priorite : Moyenne** — Essentiel pour les traitements performants sur gros volumes.

| Fonctionnalite | Description |
|---|---|
| `BULK COLLECT INTO collection` | Recuperation de toutes les lignes d'un SELECT en une seule operation dans une collection. |
| `BULK COLLECT ... LIMIT n` | Recuperation par lots de n lignes. |
| `FORALL i IN collection.FIRST..collection.LAST` | Execution en masse d'un DML pour chaque element d'une collection. |
| `FORALL ... SAVE EXCEPTIONS` | Continue le FORALL meme si certaines lignes echouent. |
| `SQL%BULK_ROWCOUNT` | Nombre de lignes affectees par chaque iteration du FORALL. |
| `SQL%BULK_EXCEPTIONS` | Collection des exceptions levees pendant un FORALL SAVE EXCEPTIONS. |

### 3.6 Exceptions avancees

**Priorite : Moyenne**

| Fonctionnalite | Description |
|---|---|
| `RAISE exception_name` | Lever une exception nommee (predefined ou user-defined). |
| `RAISE_APPLICATION_ERROR(error_code, message)` | Lever une erreur applicative avec un code entre -20000 et -20999. |
| `PRAGMA EXCEPTION_INIT(exception_name, error_code)` | Associer un code ORA- a une exception nommee. |
| `EXCEPTION_INIT` dans DECLARE | Declaration et initialisation d'exception. |
| Propagation d'exceptions entre blocs imbriques | Un EXCEPTION non gere dans un bloc interne remonte au bloc parent. |
| `SQLCODE` variable | Code d'erreur Oracle dans le handler EXCEPTION. |

### 3.7 Triggers — Execution reelle

**Priorite : Haute** — Les triggers sont stockes mais ne se declenchent pas.

| Fonctionnalite | Description |
|---|---|
| Declenchement BEFORE INSERT | Executer le corps du trigger avant chaque INSERT sur la table cible. |
| Declenchement AFTER INSERT | Executer le corps du trigger apres chaque INSERT. |
| Declenchement BEFORE/AFTER UPDATE | Idem pour UPDATE, avec support de `OF column_list`. |
| Declenchement BEFORE/AFTER DELETE | Idem pour DELETE. |
| Pseudo-records `:NEW` et `:OLD` | Acces aux valeurs avant/apres modification dans un trigger FOR EACH ROW. |
| INSTEAD OF triggers sur vues | Execution du trigger a la place de l'operation DML sur une vue. |
| Statement-level triggers (sans FOR EACH ROW) | Declenchement une seule fois par instruction DML. |
| `WHEN` condition evaluation | La clause WHEN est stockee mais pas evaluee a l'execution. |
| Triggers en cascade | Un trigger qui modifie une table peut declencher un autre trigger. |
| `ALTER TRIGGER trg ENABLE / DISABLE` | Activation/desactivation effective d'un trigger. |

### 3.8 Structures de controle manquantes

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `GOTO label` | Saut inconditionnel vers un label. |
| `<<label>>` avant un LOOP | Labels nommes sur les boucles pour EXIT et CONTINUE qualifies. |
| `EXIT label WHEN condition` | Sortie d'une boucle nommee specifique. |
| `CONTINUE label WHEN condition` | Continuation d'une boucle nommee specifique. |
| `LOOP ... EXIT WHEN` (simple loop) | Boucle infinie avec condition de sortie. Verifier la completude. |
| Blocs PL/SQL imbriques avec scope de variables | Verifier que les variables du bloc externe sont accessibles dans le bloc interne. |

### 3.9 SQL dynamique

**Priorite : Moyenne**

| Fonctionnalite | Description |
|---|---|
| `EXECUTE IMMEDIATE sql_string` | Execution d'une chaine SQL dynamique. |
| `EXECUTE IMMEDIATE sql_string INTO var1, var2` | Execution avec recuperation de resultats. |
| `EXECUTE IMMEDIATE sql_string USING bind1, bind2` | Execution avec variables de binding. |
| `OPEN cursor FOR sql_string` | Ouverture d'un curseur refcursor sur une requete dynamique. |
| `DBMS_SQL.OPEN_CURSOR / PARSE / EXECUTE / FETCH_ROWS` | Package de SQL dynamique bas niveau (voir section Packages built-in). |

### 3.10 Records

**Priorite : Moyenne**

| Fonctionnalite | Description |
|---|---|
| `TYPE rec_type IS RECORD (field1 type1, field2 type2, ...)` | Definition d'un type record utilisateur. |
| `var rec_type` | Declaration d'une variable de type record. |
| `var.field` access | Acces aux champs du record. |
| `SELECT ... INTO rec_var` | Chargement d'une ligne dans un record. |
| Record dans curseur FOR LOOP | `FOR rec IN cursor LOOP rec.field ...` |

---

## 4. Oracle Database — Transactions

Le simulateur ne dispose actuellement d'aucun mecanisme transactionnel reel. COMMIT et ROLLBACK sont reconnus mais les modifications sont immediatement permanentes.

### 4.1 Undo Log et ROLLBACK reel

**Priorite : Haute** — Sans cela, ROLLBACK est trompeur pour les etudiants.

| Fonctionnalite | Description |
|---|---|
| Undo log (journal d'annulation) | Avant chaque INSERT/UPDATE/DELETE, sauvegarder l'etat precedent des lignes affectees dans un journal en memoire. |
| `ROLLBACK` effectif | Restaurer les donnees a leur etat precedent en rejouant le undo log en sens inverse. |
| `SAVEPOINT nom` | Creer un point de sauvegarde nomme dans la transaction courante. |
| `ROLLBACK TO SAVEPOINT nom` | Annuler les modifications jusqu'au savepoint specifie (sans annuler les modifications anterieures au savepoint). |
| Auto-commit implicite sur DDL | Un DDL (CREATE, ALTER, DROP) doit implicitement commiter la transaction en cours avant de s'executer. |
| Auto-rollback sur erreur non geree | Une erreur PL/SQL non geree doit annuler la transaction courante. |

### 4.2 Niveaux d'isolation

**Priorite : Basse** — Utile pour les cours avances.

| Fonctionnalite | Description |
|---|---|
| `SET TRANSACTION READ ONLY` | La transaction ne voit que les donnees commitees au debut de la transaction. |
| `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` | Comportement par defaut Oracle : chaque requete voit les donnees commitees au moment de son execution. |
| `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` | La transaction voit un snapshot au debut de la transaction. Les conflits levent ORA-08177. |

### 4.3 Verrouillage (Locking)

**Priorite : Moyenne** — Important pour illustrer les problemes de concurrence.

| Fonctionnalite | Description |
|---|---|
| Row-level locks sur UPDATE/DELETE | Verrouiller les lignes modifiees jusqu'au COMMIT/ROLLBACK. |
| `SELECT ... FOR UPDATE` enforcement | Verrouiller les lignes selectionnees. Les autres sessions qui tentent de modifier ces lignes doivent etre bloquees (ou recevoir une erreur). |
| `SELECT ... FOR UPDATE NOWAIT` | Lever ORA-00054 immediatement si les lignes sont deja verrouillees. |
| `SELECT ... FOR UPDATE WAIT n` | Attendre n secondes puis lever ORA-30006 si toujours verrouille. |
| `LOCK TABLE table IN mode MODE` | Verrouillage au niveau table (EXCLUSIVE, SHARE, ROW EXCLUSIVE, etc.). |
| Detection de deadlocks | Detecter les interblocages et lever ORA-00060. |
| `V$LOCK` dynamique | Mettre a jour V$LOCK avec les verrous reellement poses (actuellement donnees statiques). |

---

## 5. Oracle Database — Dictionnaire de donnees

Les 70 vues existantes couvrent bien les besoins. Quelques ameliorations restent necessaires.

### 5.1 Vues dynamiques (ameliorations)

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `DBA_AUDIT_TRAIL` dynamique | Moyenne | Actuellement retourne des donnees statiques. Doit etre alimente par les operations reelles (connexions, DDL, DML) pour reflete l'activite. |
| `V$LOCK` dynamique | Moyenne | Doit refleter les verrous reellement poses (quand le systeme de locking sera implemente). |
| `V$TRANSACTION` dynamique | Moyenne | Doit refleter les transactions ouvertes reelles (quand l'undo log sera implemente). |
| `V$SESSION` dynamique | Basse | Mettre a jour `SQL_ID`, `SQL_TEXT`, `STATUS` en temps reel lors de l'execution de requetes. |
| `V$SQL` / `V$SQLAREA` dynamique | Basse | Alimenter avec les requetes reellement executees (SQL text, execution count, elapsed time). |

### 5.2 Vues manquantes

| Vue | Priorite | Description |
|---|---|---|
| `DBA_PART_TABLES` | Basse | Tables partitionnees (quand le partitionnement sera implemente). |
| `DBA_TAB_PARTITIONS` | Basse | Partitions individuelles des tables. |
| `DBA_MVIEWS` | Basse | Materialized views avec dates de rafraichissement. |
| `DBA_MVIEW_LOGS` | Basse | Logs de materialized views. |
| `DBA_DEPENDENCIES` | Moyenne | Dependances entre objets (package X depend de table Y). Utile pour comprendre l'invalidation. |
| `DBA_ERRORS` | Moyenne | Erreurs de compilation PL/SQL. Actuellement `SHOW ERRORS` fonctionne mais la vue n'est pas interrogeable directement. |
| `DBA_RECYCLEBIN` / `RECYCLEBIN` | Basse | Corbeille Oracle (tables droppees recuperables). |
| `V$UNDOSTAT` | Basse | Statistiques d'utilisation de l'undo. |

### 5.3 Profils de securite — Enforcement

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `FAILED_LOGIN_ATTEMPTS` enforcement | Moyenne | Verrouiller le compte apres N tentatives echouees (actuellement parse mais pas applique). |
| `PASSWORD_LIFE_TIME` enforcement | Basse | Expiration du mot de passe apres N jours. |
| `PASSWORD_LOCK_TIME` enforcement | Basse | Duree de verrouillage apres echecs de connexion. |
| `IDLE_TIME` enforcement | Basse | Deconnexion apres N minutes d'inactivite. |
| `SESSIONS_PER_USER` enforcement | Basse | Limiter le nombre de sessions simultanees par utilisateur. |

---

## 6. Oracle Database — Packages built-in

Packages Oracle standard dont l'implementation est absente ou incomplete.

### 6.1 DBMS_SQL — SQL dynamique bas niveau

**Priorite : Moyenne**

| Procedure/Fonction | Description |
|---|---|
| `OPEN_CURSOR` | Retourne un identifiant de curseur dynamique. |
| `PARSE(cursor_id, sql_string, language_flag)` | Parse une chaine SQL dans le curseur. |
| `BIND_VARIABLE(cursor_id, name, value)` | Lie une variable de binding. |
| `DEFINE_COLUMN(cursor_id, position, variable)` | Definit une colonne de sortie. |
| `EXECUTE(cursor_id)` | Execute le curseur parse. |
| `FETCH_ROWS(cursor_id)` | Recupere la ligne suivante. |
| `COLUMN_VALUE(cursor_id, position, variable)` | Recupere la valeur d'une colonne. |
| `CLOSE_CURSOR(cursor_id)` | Ferme le curseur. |
| `IS_OPEN(cursor_id)` | Verifie si un curseur est ouvert. |

### 6.2 DBMS_LOB — Operations sur les LOBs

**Priorite : Basse**

| Procedure/Fonction | Description |
|---|---|
| `READ(lob, amount, offset, buffer)` | Lit une portion d'un LOB. |
| `WRITE(lob, amount, offset, buffer)` | Ecrit dans un LOB. |
| `SUBSTR(lob, amount, offset)` | Extrait une sous-chaine d'un CLOB. |
| `APPEND(dest_lob, src_lob)` | Concatene un LOB a un autre. |
| `ERASE(lob, amount, offset)` | Efface une portion d'un LOB. |
| `COPY(dest_lob, src_lob, amount, dest_offset, src_offset)` | Copie entre LOBs. |
| `TRIM(lob, newlen)` | Tronque un LOB. |
| `CREATETEMPORARY(lob, cache, dur)` | Cree un LOB temporaire. |
| `FREETEMPORARY(lob)` | Libere un LOB temporaire. |

### 6.3 UTL_FILE — Entrees/sorties fichier

**Priorite : Basse** — Necessite un filesystem Oracle (CREATE DIRECTORY).

| Procedure/Fonction | Description |
|---|---|
| `FOPEN(directory, filename, mode)` | Ouvre un fichier (mode R/W/A). Actuellement stub. |
| `FCLOSE(file_handle)` | Ferme un fichier. |
| `PUT_LINE(file_handle, text)` | Ecrit une ligne dans un fichier. |
| `GET_LINE(file_handle, buffer)` | Lit une ligne depuis un fichier. |
| `IS_OPEN(file_handle)` | Verifie si un fichier est ouvert. |
| `FFLUSH(file_handle)` | Force l'ecriture du buffer. |
| `FREMOVE(directory, filename)` | Supprime un fichier. |
| `FCOPY(src_dir, src_file, dest_dir, dest_file)` | Copie un fichier. |
| `FRENAME(src_dir, src_file, dest_dir, dest_file)` | Renomme un fichier. |

### 6.4 DBMS_STATS — Statistiques

**Priorite : Basse**

| Procedure/Fonction | Description |
|---|---|
| `GATHER_TABLE_STATS(owner, table_name, ...)` | Actuellement no-op. Doit calculer NUM_ROWS, BLOCKS, AVG_ROW_LEN et les stocker dans les vues DBA_TABLES et DBA_TAB_STATISTICS. |
| `GATHER_SCHEMA_STATS(owner)` | Idem pour toutes les tables d'un schema. |
| `GATHER_DATABASE_STATS` | Idem pour toute la base. |
| `DELETE_TABLE_STATS(owner, table_name)` | Supprime les statistiques d'une table. |
| `SET_TABLE_STATS(owner, table_name, numrows, ...)` | Fixe manuellement les statistiques. |

### 6.5 DBMS_SCHEDULER — Planification

**Priorite : Basse**

| Procedure/Fonction | Description |
|---|---|
| `CREATE_JOB(job_name, job_type, job_action, start_date, repeat_interval, ...)` | Actuellement stub. Doit creer un job visible dans `DBA_SCHEDULER_JOBS`. |
| `RUN_JOB(job_name)` | Execution immediate du job. |
| `DROP_JOB(job_name)` | Suppression du job. |
| `ENABLE(job_name)` / `DISABLE(job_name)` | Activation/desactivation. |
| Timer de declenchement periodique | Execution basee sur `repeat_interval` (simulation simplifiee). |

### 6.6 DBMS_CRYPTO — Chiffrement

**Priorite : Basse**

| Procedure/Fonction | Description |
|---|---|
| `ENCRYPT(src, typ, key)` | Chiffrement AES/DES/3DES. |
| `DECRYPT(src, typ, key)` | Dechiffrement. |
| `HASH(src, typ)` | Hachage MD5/SHA-1/SHA-256. |
| `MAC(src, typ, key)` | Code d'authentification de message. |
| Constantes : `ENCRYPT_AES256`, `CHAIN_CBC`, `PAD_PKCS5` | Constantes de configuration. |

### 6.7 DBMS_METADATA — Ameliorations

**Priorite : Basse**

| Procedure/Fonction | Description |
|---|---|
| `GET_DDL` pour PROCEDURE, FUNCTION, TRIGGER, PACKAGE | Actuellement supporte TABLE, INDEX, VIEW, SEQUENCE. Etendre aux autres types d'objets. |
| `GET_DEPENDENT_DDL(object_type, base_object)` | Retourner le DDL des objets dependants (index d'une table, triggers d'une table). Actuellement stub. |
| `SET_TRANSFORM_PARAM` | Parametrage de la sortie DDL (SQLTERMINATOR, PRETTY, SEGMENT_ATTRIBUTES, etc.). |

### 6.8 DBMS_SESSION

**Priorite : Basse**

| Procedure/Fonction | Description |
|---|---|
| `SET_ROLE(role_cmd)` | Activer/desactiver des roles pour la session courante. |
| `SET_NLS(param, value)` | Modifier un parametre NLS pour la session. |
| `CLOSE_DATABASE_LINK(dblink)` | Fermer une connexion de database link. |
| `SET_SQL_TRACE(sql_trace)` | Activer/desactiver le tracing SQL. |

---

## 7. Oracle Database — Fonctions SQL manquantes

Fonctions scalaires et d'agregation absentes du moteur d'evaluation.

### 7.1 Fonctions de chaines

| Fonction | Priorite | Signature | Description |
|---|---|---|---|
| `REGEXP_SUBSTR` | Haute | `(str, pattern [, pos [, occ [, flags [, grp]]]])` | Extraction par regex. |
| `REGEXP_REPLACE` | Haute | `(str, pattern, replace [, pos [, occ [, flags]]])` | Remplacement par regex. |
| `REGEXP_INSTR` | Haute | `(str, pattern [, pos [, occ [, ret [, flags [, grp]]]]])` | Position d'une correspondance regex. |
| `REGEXP_LIKE` | Haute | `(str, pattern [, flags])` | Condition de correspondance regex (WHERE). |
| `REGEXP_COUNT` | Moyenne | `(str, pattern [, pos [, flags]])` | Comptage d'occurrences regex. |
| `SOUNDEX` | Basse | `(str)` | Code phonetique d'une chaine. |
| `TRANSLATE` | Moyenne | `(str, from_set, to_set)` | Remplacement caractere par caractere. |
| `REVERSE` | Basse | `(str)` | Inverse une chaine. |
| `DUMP` | Basse | `(expr [, fmt [, start [, length]]])` | Representation interne d'une valeur. |
| `ASCII` | Basse | `(char)` | Code ASCII d'un caractere. |
| `CHR` | Basse | `(n)` | Caractere correspondant au code ASCII. |
| `INSTRB` / `SUBSTRB` / `LENGTHB` | Basse | Variantes byte | Versions byte-based des fonctions string. |

### 7.2 Fonctions de date

| Fonction | Priorite | Signature | Description |
|---|---|---|---|
| `ADD_MONTHS` | Haute | `(date, n)` | Ajoute n mois a une date. |
| `MONTHS_BETWEEN` | Haute | `(date1, date2)` | Nombre de mois entre deux dates. |
| `LAST_DAY` | Haute | `(date)` | Dernier jour du mois de la date donnee. |
| `NEXT_DAY` | Moyenne | `(date, day_of_week)` | Prochaine occurrence du jour de la semaine. |
| `TRUNC(date [, fmt])` | Haute | Troncature de date | Tronque a l'annee, mois, jour, heure, etc. |
| `ROUND(date [, fmt])` | Moyenne | Arrondi de date | Arrondit une date au format specifie. |
| `EXTRACT(field FROM date)` | Haute | `YEAR`, `MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND` | Partiellement implemente. Completer pour tous les champs et les types TIMESTAMP/INTERVAL. |
| `NEW_TIME` | Basse | `(date, tz1, tz2)` | Conversion de fuseau horaire (obsolete mais encore enseigne). |
| `NUMTODSINTERVAL` | Basse | `(n, unit)` | Nombre vers intervalle jour-seconde. |
| `NUMTOYMINTERVAL` | Basse | `(n, unit)` | Nombre vers intervalle annee-mois. |
| `TO_TIMESTAMP` | Moyenne | `(str [, fmt])` | Conversion chaine vers TIMESTAMP. |
| `TO_DSINTERVAL` | Basse | `(str)` | Chaine vers INTERVAL DAY TO SECOND. |
| `TO_YMINTERVAL` | Basse | `(str)` | Chaine vers INTERVAL YEAR TO MONTH. |
| `FROM_TZ` | Basse | `(timestamp, tz)` | Associe un fuseau horaire a un TIMESTAMP. |
| Arithmetique de dates complete | Moyenne | `date + INTERVAL`, `date - date` | Verifier que toutes les combinaisons d'operations arithmetiques sur dates/timestamps/intervals fonctionnent. |

### 7.3 Fonctions de conversion

| Fonction | Priorite | Signature | Description |
|---|---|---|---|
| `TO_TIMESTAMP` | Moyenne | `(str [, fmt])` | String vers TIMESTAMP. |
| `TO_CLOB` | Basse | `(str)` | Conversion vers CLOB. |
| `TO_BLOB` | Basse | `(raw)` | Conversion vers BLOB. |
| `TO_BINARY_FLOAT` / `TO_BINARY_DOUBLE` | Basse | `(expr)` | Conversions vers types flottants. |
| `HEXTORAW` / `RAWTOHEX` | Basse | `(str)` | Conversions hexadecimal / raw. |
| `ROWIDTOCHAR` / `CHARTOROWID` | Basse | `(rowid)` | Conversions ROWID. |

### 7.4 Fonctions numeriques manquantes

| Fonction | Priorite | Signature | Description |
|---|---|---|---|
| `WIDTH_BUCKET` | Basse | `(expr, min, max, num_buckets)` | Histogramme equi-largeur. |
| `REMAINDER` | Basse | `(n, m)` | Reste de la division (different de MOD). |
| `NANVL` | Basse | `(n, replacement)` | Remplacement des NaN. |
| `BIN_TO_NUM` | Basse | `(bit1, bit2, ...)` | Conversion binaire vers nombre. |
| `LN` / `LOG` | Basse | `(n)` / `(base, n)` | Logarithme naturel / en base quelconque. |
| `EXP` | Basse | `(n)` | Exponentielle (e^n). |
| `SIN` / `COS` / `TAN` / `ASIN` / `ACOS` / `ATAN` / `ATAN2` | Basse | Trigonometrie | Fonctions trigonometriques. |
| `SINH` / `COSH` / `TANH` | Basse | Hyperboliques | Fonctions hyperboliques. |

### 7.5 Fonctions systeme manquantes

| Fonction | Priorite | Signature | Description |
|---|---|---|---|
| `ORA_HASH` | Basse | `(expr [, max_bucket [, seed]])` | Fonction de hachage Oracle. |
| `USERENV` complet | Basse | `(parameter)` | Actuellement partiel. Completer pour `LANG`, `LANGUAGE`, `TERMINAL`, `CLIENT_INFO`, `ISDBA`, etc. |
| `SYS_CONTEXT` etendu | Basse | `(namespace, parameter)` | Ajouter le support de namespaces personalises via `CREATE CONTEXT`. |

---

## 8. Oracle Database — SQL*Plus

Commandes SQL*Plus manquantes ou partiellement implementees.

### 8.1 Execution de scripts

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `@filename` / `START filename` (execution reelle) | Moyenne | Actuellement retourne `SP2-0310 unable to open file`. Doit lire le fichier depuis le filesystem simule et executer chaque instruction. |
| `@@filename` (chemin relatif au script courant) | Basse | Execution d'un script relatif au script appelant. |
| Variables de substitution `&var` interactives | Moyenne | Le `&` est reconnu mais le prompt interactif pour saisir la valeur n'est pas implemente. Doit afficher `Enter value for var:` et attendre l'input. |
| `&&var` (definir et reutiliser) | Moyenne | Comme `&var` mais la valeur est memorisee pour les utilisations suivantes. |

### 8.2 Formatage de colonnes

| Fonctionnalite | Priorite | Description |
|---|---|---|
| `COLUMN col FORMAT A20` (largeur chaines) | Moyenne | Tronquer/padder les colonnes texte a la largeur specifiee. Parsing reconnu, formatage non applique. |
| `COLUMN col FORMAT 999,999.99` (format numerique) | Moyenne | Formater les nombres avec separateurs de milliers et decimales. |
| `COLUMN col FORMAT $999.99` (format monetaire) | Basse | Prefixe monetaire dans le format. |
| `COLUMN col JUSTIFY LEFT/CENTER/RIGHT` | Basse | Alignement de colonne. |
| `COLUMN col WORD_WRAPPED / TRUNCATED / WRAPPED` | Basse | Comportement de depassement de largeur. |
| `COLUMN col NOPRINT` | Basse | Masquer une colonne dans l'affichage. |
| `COLUMN col CLEAR` | Basse | Reinitialiser le format d'une colonne. |
| `BREAK ON col [SKIP n]` | Basse | Groupement visuel avec saut de lignes. |
| `COMPUTE SUM/AVG/COUNT OF col ON break_col` | Basse | Totaux automatiques sur les groupes de rupture. |
| `TTITLE` / `BTITLE` | Basse | Titre en haut/bas de page du rapport. |
| `REPHEADER` / `REPFOOTER` | Basse | En-tete/pied de rapport. |

### 8.3 Commandes manquantes

| Commande | Priorite | Description |
|---|---|---|
| `HOST` / `!` | Basse | Execution d'une commande shell depuis SQL*Plus. Doit deleguer au shell Linux simule. |
| `EDIT` / `ED` | Basse | Ouverture de l'editeur sur le buffer SQL. Pourrait ouvrir vi/nano simule. |
| `SAVE filename` | Basse | Sauvegarder le buffer SQL dans un fichier. |
| `GET filename` | Basse | Charger un fichier dans le buffer SQL. |
| `LIST` / `L` | Basse | Afficher le contenu du buffer SQL. |
| `INPUT` / `APPEND` | Basse | Ajouter des lignes au buffer SQL. |
| `DEL` | Basse | Supprimer une ligne du buffer SQL. |
| `CHANGE /old/new/` | Basse | Rechercher-remplacer dans le buffer SQL. |
| `UNDEFINE var` | Basse | Supprimer une variable de substitution. |
| `WHENEVER SQLERROR EXIT / CONTINUE` | Moyenne | Definir le comportement en cas d'erreur SQL (important pour les scripts). |
| `WHENEVER OSERROR EXIT / CONTINUE` | Basse | Definir le comportement en cas d'erreur OS. |
| `SET LONG n` | Basse | Longueur maximale d'affichage des colonnes LONG/CLOB. |
| `SET ARRAYSIZE n` | Basse | Taille du batch de fetch. |
| `SET AUTOTRACE ON/OFF` | Moyenne | Affichage automatique du plan d'execution et des statistiques apres chaque requete. |

---

## 9. Oracle Database — Fonctionnalites avancees

Fonctionnalites Oracle avancees non encore implementees.

### 9.1 Flashback

**Priorite : Moyenne** — Enseigne dans les cours d'administration.

| Fonctionnalite | Description |
|---|---|
| `FLASHBACK TABLE t TO BEFORE DROP` | Restauration d'une table droppee depuis la corbeille (RECYCLEBIN). |
| `FLASHBACK TABLE t TO TIMESTAMP expr` | Restauration d'une table a un instant donne. Necessite l'undo log. |
| `SELECT ... AS OF TIMESTAMP expr` | Lecture de donnees historiques. Necessite l'undo log. |
| `SELECT ... AS OF SCN n` | Lecture a un System Change Number specifique. |
| `FLASHBACK DATABASE TO TIMESTAMP expr` | Restauration de toute la base. |
| `DROP TABLE t` vers la corbeille | Au lieu de supprimer definitivement, renommer en `BIN$...` et rendre recuperable. |
| `PURGE RECYCLEBIN` / `PURGE TABLE t` | Suppression definitive depuis la corbeille. |
| `SELECT * FROM RECYCLEBIN` | Consultation de la corbeille. |

### 9.2 Partitionnement

**Priorite : Moyenne** — Enseigne dans les cours d'administration et de performance.

| Fonctionnalite | Description |
|---|---|
| `CREATE TABLE ... PARTITION BY RANGE (col) (...)` | Partitionnement par plage (dates, IDs). |
| `CREATE TABLE ... PARTITION BY LIST (col) (...)` | Partitionnement par liste de valeurs. |
| `CREATE TABLE ... PARTITION BY HASH (col) PARTITIONS n` | Partitionnement par hachage. |
| Composite partitioning (RANGE-LIST, RANGE-HASH) | Sous-partitionnement. |
| `ALTER TABLE ... ADD PARTITION` | Ajout d'une partition. |
| `ALTER TABLE ... DROP PARTITION` | Suppression d'une partition. |
| `ALTER TABLE ... SPLIT PARTITION ... AT (value)` | Division d'une partition. |
| `ALTER TABLE ... MERGE PARTITIONS` | Fusion de partitions. |
| `ALTER TABLE ... TRUNCATE PARTITION` | Vidage d'une partition. |
| `ALTER TABLE ... EXCHANGE PARTITION ... WITH TABLE` | Echange partition/table. |
| Partition pruning dans les requetes | L'evaluateur de requetes ne lit que les partitions pertinentes. |
| Index LOCAL / GLOBAL sur tables partitionnees | Index aligne ou non sur le schema de partitionnement. |

### 9.3 LOBs (Large Objects)

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Stockage reel CLOB/BLOB | Les colonnes CLOB/BLOB doivent pouvoir stocker des donnees volumineuses (actuellement le type est reconnu mais pas le stockage). |
| LOB locators | References vers les donnees LOB plutot que copie directe. |
| LOB en PL/SQL | `DECLARE v_clob CLOB; ... DBMS_LOB.WRITE(v_clob, ...)`. |
| LOB dans INSERT/UPDATE | `INSERT INTO t (clob_col) VALUES (TO_CLOB('...'))`. |

### 9.4 XML et JSON

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `XMLType` datatype | Type de donnees XML natif. |
| `JSON` datatype (21c+) | Type de donnees JSON natif. |
| `JSON_TABLE(json_col, '$.path' COLUMNS (...))` | Extraction de donnees JSON en lignes/colonnes SQL. |
| `JSON_VALUE(json_col, '$.path')` | Extraction d'une valeur scalaire depuis du JSON. |
| `JSON_QUERY(json_col, '$.path')` | Extraction d'un fragment JSON. |
| `JSON_EXISTS(json_col, '$.path')` | Test d'existence d'un chemin JSON. |
| `XMLELEMENT`, `XMLFOREST`, `XMLAGG` | Generation XML depuis SQL. |

### 9.5 Securite avancee

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Virtual Private Database (VPD) | Politiques de securite au niveau ligne : `DBMS_RLS.ADD_POLICY(...)`. Les requetes sont automatiquement filtrees. |
| Fine-Grained Audit (FGA) | `DBMS_FGA.ADD_POLICY(...)` : audit detaille sur des colonnes specifiques. |
| Transparent Data Encryption (TDE) | Chiffrement de colonnes/tablespaces transparent pour l'application. |
| Column-level encryption | `CREATE TABLE t (ssn VARCHAR2(11) ENCRYPT)`. |
| Unified Audit (12c+) | `CREATE AUDIT POLICY`, `AUDIT POLICY`, `NOAUDIT POLICY`. |
| `AUDIT` / `NOAUDIT` statements | Commandes d'audit traditionnel. |

### 9.6 Backup et Recovery

**Priorite : Basse** — Complexe a simuler.

| Fonctionnalite | Description |
|---|---|
| RMAN session interactive | Actuellement l'outil rman est accessible en shell mais ne fait rien. Simuler les commandes de base. |
| `RMAN> BACKUP DATABASE` | Simulation d'un backup complet. |
| `RMAN> BACKUP INCREMENTAL LEVEL 0/1` | Backup incremental. |
| `RMAN> RESTORE DATABASE` / `RECOVER DATABASE` | Restauration et recovery. |
| `RMAN> LIST BACKUP` | Liste des backups effectues. |
| `RMAN> REPORT NEED BACKUP` | Rapport des fichiers necessitant un backup. |
| Export/Import Data Pump (`expdp` / `impdp`) | Simulation des commandes d'export/import. |
| Archive log management | `ALTER SYSTEM ARCHIVE LOG ALL`, gestion des archived redo logs. |

### 9.7 Replication et Haute Disponibilite

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Data Guard concepts | Standby database (physical/logical), switchover, failover. |
| `ALTER DATABASE SWITCHOVER TO standby` | Basculement vers le standby. |
| `V$DATAGUARD_STATUS` | Vue de statut Data Guard. |
| Real Application Clusters (RAC) concepts | Multi-instance sur une base partagee (simulation conceptuelle). |

### 9.8 Networking avance

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Queries cross-link (`table@dblink`) | Resolution et execution de requetes a travers un database link. |
| Connection pooling (CMAN) | Simulation du Connection Manager. |
| Failover (TAF / FCF) | Transparent Application Failover. |
| Service management | `DBMS_SERVICE.CREATE_SERVICE`, `START_SERVICE`, `STOP_SERVICE`. |

---

## 10. Linux — Shell Bash

Fonctionnalites du shell bash qui ne sont pas encore implementees dans le terminal Linux simule.

### 10.1 Substitution de commandes

**Priorite : Moyenne** — Utilise frequemment dans les scripts et la ligne de commande.

| Fonctionnalite | Description |
|---|---|
| `$(command)` | Substitution de commande : executer `command` et remplacer par sa sortie standard. Ex: `echo "Today is $(date)"`. |
| `` `command` `` (backticks) | Syntaxe alternative (legacy) pour la substitution de commande. |
| Substitutions imbriquees | `$(echo $(whoami))` — substitution dans une substitution. |

### 10.2 Structures de controle

**Priorite : Moyenne** — Necessaire pour les scripts bash.

| Fonctionnalite | Description |
|---|---|
| `if condition; then ... elif ...; else ...; fi` | Conditionnelle. |
| `for var in list; do ...; done` | Boucle sur une liste. |
| `for ((i=0; i<10; i++)); do ...; done` | Boucle C-style. |
| `while condition; do ...; done` | Boucle tant que. |
| `until condition; do ...; done` | Boucle jusqu'a ce que. |
| `case $var in pattern) ... ;; esac` | Branchement par pattern matching. |
| `[[ condition ]]` / `[ condition ]` / `test` | Evaluation de conditions (fichiers, chaines, nombres). |
| Operateurs de test : `-f`, `-d`, `-e`, `-r`, `-w`, `-x`, `-z`, `-n`, `-eq`, `-ne`, `-lt`, `-gt` | Operateurs de comparaison et de test de fichiers. |
| `&&` et `\|\|` dans les conditions | Operateurs logiques dans les tests. |

### 10.3 Fonctions shell

**Priorite : Moyenne**

| Fonctionnalite | Description |
|---|---|
| `function_name() { ... }` | Definition de fonction. |
| `function function_name { ... }` | Syntaxe alternative. |
| `$1`, `$2`, ..., `$@`, `$#`, `$*` | Parametres positionnels. |
| `local var=value` | Variables locales a la fonction. |
| `return n` | Code de retour d'une fonction. |

### 10.4 Jobs et processus en arriere-plan

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `command &` | Lancer une commande en arriere-plan. |
| `jobs` | Lister les jobs en cours. |
| `fg %n` | Ramener le job n au premier plan. |
| `bg %n` | Reprendre le job n en arriere-plan. |
| `Ctrl+Z` | Suspendre le processus courant. |
| `wait [pid]` | Attendre la fin d'un processus. |
| `nohup command &` | Lancer un processus immune au SIGHUP. |

### 10.5 Expansions manquantes

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Brace expansion `{a,b,c}` | `echo file{1,2,3}.txt` → `file1.txt file2.txt file3.txt`. |
| Brace range `{1..10}` | `echo {1..10}` → `1 2 3 4 5 6 7 8 9 10`. |
| Character class globs `[abc]`, `[a-z]` | Pattern matching avec classes de caracteres dans les noms de fichiers. |
| Tilde expansion `~user` | `~oracle` → `/home/oracle`. Verifier la completude. |
| Arithmetic expansion `$((expr))` | `echo $((2 + 3))` → `5`. |
| Process substitution `<(command)` / `>(command)` | Substitution de processus comme fichier. |
| Here-strings `<<< "string"` | Redirection d'une chaine vers stdin. |

### 10.6 Aliases et configuration

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `alias name='command'` | Definition d'alias. |
| `unalias name` | Suppression d'alias. |
| `alias` (lister tous les alias) | Affichage des alias definis. |
| `.bash_profile` / `.bashrc` sourcing | Chargement automatique des fichiers de configuration au login. |
| `source filename` / `. filename` | Execution d'un script dans le shell courant. Verifier completude. |
| `export VAR=value` | Export de variable (verifier la persistence). |
| `set -e`, `set -x`, `set -u` | Options du shell (exit on error, debug, unset vars). |

### 10.7 Signaux et traps

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `trap 'command' SIGNAL` | Capture de signal. |
| `kill -SIGNAL pid` | Envoi de signal a un processus (actuellement basique). |
| `Ctrl+C` (SIGINT) handling | Interruption de commande en cours. |

---

## 11. Linux — Commandes systeme

Commandes Linux manquantes ou a implementer dans le terminal simule.

### 11.1 Gestion des processus

**Priorite : Moyenne**

| Commande | Description |
|---|---|
| `top` | Affichage dynamique des processus (mode interactif simplifie ou snapshot). Afficher PID, USER, %CPU, %MEM, COMMAND. |
| `htop` | Version amelioree de top (peut etre un alias vers top simule). |
| `kill pid` / `kill -9 pid` / `kill -TERM pid` | Envoi de signaux aux processus. Actuellement basique — completer avec les differents signaux. |
| `killall name` | Tuer tous les processus par nom. |
| `pkill pattern` | Tuer les processus dont le nom correspond au pattern. |
| `nice -n priority command` | Lancer une commande avec une priorite modifiee. |
| `renice priority pid` | Modifier la priorite d'un processus en cours. |
| `pgrep pattern` | Rechercher des processus par nom. |
| `pidof name` | Trouver le PID d'un processus par nom. |

### 11.2 Gestion des disques et du stockage

**Priorite : Moyenne** — Important pour les cours d'administration systeme.

| Commande | Description |
|---|---|
| `df -h` | Afficher l'espace disque utilise/disponible par filesystem. Simuler avec les tablespaces Oracle et le filesystem virtuel. |
| `du -sh path` | Afficher la taille d'un repertoire/fichier. |
| `mount` / `umount` | Monter/demonter des filesystems (simulation). |
| `lsblk` | Lister les peripheriques de stockage en bloc. |
| `fdisk -l` | Lister les partitions disque. |
| `mkfs.ext4 /dev/sdX` | Creer un filesystem (simulation). |
| `blkid` | Afficher les UUID et types de filesystems. |
| `free -h` | Afficher la memoire RAM et swap disponible. |

### 11.3 Gestion des paquets

**Priorite : Moyenne** — Fondamental pour l'administration Ubuntu/Debian.

| Commande | Description |
|---|---|
| `apt update` | Mettre a jour la liste des paquets (simulation : afficher la sortie typique). |
| `apt install package` | Installer un paquet (simulation : message de confirmation et succes). |
| `apt remove package` | Supprimer un paquet. |
| `apt search keyword` | Rechercher un paquet. |
| `apt list --installed` | Lister les paquets installes. |
| `dpkg -l` | Lister les paquets installes (format dpkg). |
| `dpkg -i package.deb` | Installer un .deb. |
| `apt-get` | Alias/variante de apt. |

### 11.4 Gestion des services

**Priorite : Haute** — Utilise constamment pour gerer Oracle, le listener, les services reseau.

| Commande | Description |
|---|---|
| `systemctl start service` | Demarrer un service (oracle, listener, networking, ssh, etc.). |
| `systemctl stop service` | Arreter un service. |
| `systemctl restart service` | Redemarrer un service. |
| `systemctl status service` | Afficher l'etat d'un service. |
| `systemctl enable service` | Activer le demarrage automatique. |
| `systemctl disable service` | Desactiver le demarrage automatique. |
| `systemctl list-units --type=service` | Lister les services. |
| `service name start/stop/status` | Commande legacy equivalente. |

### 11.5 Archivage et compression

**Priorite : Moyenne**

| Commande | Description |
|---|---|
| `tar -czf archive.tar.gz files...` | Creer une archive tar compressee en gzip. |
| `tar -xzf archive.tar.gz` | Extraire une archive tar gzip. |
| `tar -cjf archive.tar.bz2 files...` | Archive tar bzip2. |
| `tar -xjf archive.tar.bz2` | Extraire tar bzip2. |
| `tar -tf archive.tar.gz` | Lister le contenu d'une archive. |
| `gzip file` / `gunzip file.gz` | Compression/decompression gzip. |
| `zip archive.zip files...` / `unzip archive.zip` | Format zip. |
| `bzip2` / `bunzip2` | Format bzip2. |
| `xz` / `unxz` | Format xz. |

### 11.6 Reseau

**Priorite : Moyenne**

| Commande | Description |
|---|---|
| `curl url` | Telecharger une URL (simuler avec les serveurs du reseau virtuel). |
| `wget url` | Telecharger un fichier depuis une URL. |
| `ssh user@host` | Connexion SSH (simuler l'ouverture d'un terminal distant vers un autre equipement). |
| `scp source dest` | Copie de fichiers via SSH. |
| `telnet host port` | Connexion telnet. |
| `netstat -tlnp` | Afficher les ports en ecoute et les connexions actives. |
| `ss -tlnp` | Alternative moderne a netstat. |
| `nc` / `netcat` | Utilitaire reseau polyvalent. |
| `tcpdump` | Capture de paquets (simuler avec les frames qui traversent les interfaces). |
| `nmap host` | Scan de ports (simulation basique). |

### 11.7 Editeurs de texte (ameliorations)

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `sed 's/old/new/g' file` | Stream editor. Actuellement non implemente comme commande. |
| `awk` ameliore | Verifier la completude des fonctionnalites awk. |
| `diff file1 file2` | Comparaison de fichiers. |
| `patch` | Application de patchs. |
| `less` / `more` | Pagination de fichiers. |

### 11.8 Informations systeme

**Priorite : Basse**

| Commande | Description |
|---|---|
| `free -h` | Memoire RAM/swap (deja mentionne). |
| `lscpu` | Informations sur le CPU. |
| `lsmod` | Modules kernel charges. |
| `modprobe` | Charger un module kernel. |
| `sysctl` | Parametres kernel. |
| `dmidecode` | Informations hardware. |
| `lspci` / `lsusb` | Peripheriques PCI/USB. |

### 11.9 Commandes de texte manquantes

**Priorite : Basse**

| Commande | Description |
|---|---|
| `sed` | Stream editor (substitution, suppression, insertion). |
| `xargs` | Construction de lignes de commande a partir de stdin. |
| `paste` | Fusion de lignes de fichiers cote a cote. |
| `comm` | Comparaison de fichiers tries ligne a ligne. |
| `fold` | Repliement de lignes longues. |
| `column -t` | Mise en colonnes. |
| `rev` | Inversion de chaines par ligne. |
| `seq` | Generation de sequences de nombres. |
| `yes` | Repetition d'une chaine. |
| `tac` | cat inverse (derniere ligne en premier). |

---

## 12. Linux — Filesystem virtuel

Ameliorations du systeme de fichiers en memoire.

### 12.1 /proc — Processus et kernel

**Priorite : Moyenne** — Souvent consulte dans les cours d'administration.

| Chemin | Description |
|---|---|
| `/proc/cpuinfo` | Informations sur le(s) processeur(s) : model name, cpu MHz, cache size, etc. |
| `/proc/meminfo` | Informations memoire : MemTotal, MemFree, MemAvailable, Buffers, Cached, SwapTotal, SwapFree. |
| `/proc/version` | Version du kernel et infos de compilation. |
| `/proc/uptime` | Temps d'activite en secondes. |
| `/proc/loadavg` | Charge moyenne (1, 5, 15 minutes). |
| `/proc/mounts` | Filesystems montes. |
| `/proc/filesystems` | Types de filesystems supportes. |
| `/proc/partitions` | Partitions detectees. |
| `/proc/[pid]/status` | Informations sur un processus specifique. |
| `/proc/[pid]/cmdline` | Ligne de commande du processus. |
| `/proc/[pid]/environ` | Variables d'environnement du processus. |
| `/proc/net/dev` | Statistiques des interfaces reseau. |
| `/proc/net/tcp` / `/proc/net/udp` | Connexions reseau actives. |
| `/proc/sys/net/ipv4/ip_forward` | Parametre de routage IP (lecture/ecriture). |

### 12.2 /sys — Interface kernel

**Priorite : Basse**

| Chemin | Description |
|---|---|
| `/sys/class/net/` | Interfaces reseau et leurs attributs. |
| `/sys/block/` | Peripheriques de stockage en bloc. |
| `/sys/devices/` | Arborescence des peripheriques. |

### 12.3 /etc — Fichiers de configuration

**Priorite : Moyenne** — Consulte et modifie dans les TP d'administration.

| Fichier | Description |
|---|---|
| `/etc/passwd` | Fichier des utilisateurs (actuellement en memoire, doit etre visible comme fichier). Format : `user:x:uid:gid:comment:home:shell`. |
| `/etc/shadow` | Mots de passe haches (acces root uniquement). |
| `/etc/group` | Groupes (actuellement en memoire, doit etre visible comme fichier). |
| `/etc/gshadow` | Mots de passe de groupes. |
| `/etc/hostname` | Nom de la machine. |
| `/etc/hosts` | Resolution locale de noms. Actuellement basique — synchroniser avec les devices du reseau. |
| `/etc/resolv.conf` | Configuration DNS (nameserver). Doit etre dynamique, mis a jour par `dhclient`. |
| `/etc/fstab` | Table des montages automatiques. |
| `/etc/sudoers` | Configuration sudo. |
| `/etc/ssh/sshd_config` | Configuration du serveur SSH. |
| `/etc/sysctl.conf` | Parametres kernel persistants. |
| `/etc/crontab` | Crontab systeme. |
| `/etc/environment` | Variables d'environnement globales. |
| `/etc/profile` / `/etc/bash.bashrc` | Configuration shell globale. |
| `/etc/network/interfaces` | Configuration reseau (Debian/Ubuntu). |
| `/etc/netplan/*.yaml` | Configuration reseau moderne (Ubuntu 18+). |

### 12.4 Fichiers utilisateur

**Priorite : Basse**

| Fichier | Description |
|---|---|
| `~/.bash_profile` | Sourcing automatique au login. |
| `~/.bashrc` | Sourcing automatique pour les shells interactifs non-login. |
| `~/.bash_history` | Historique des commandes (persistance entre sessions). |
| `~/.bash_logout` | Script execute a la deconnexion. |
| `~/.ssh/` | Repertoire SSH (authorized_keys, known_hosts, config). |

### 12.5 Device files

**Priorite : Basse**

| Fichier | Description |
|---|---|
| `/dev/sda`, `/dev/sda1`, etc. | Disques et partitions (simulation). |
| `/dev/tty*` | Terminaux (simulation). |
| `/dev/pts/*` | Pseudo-terminaux. |
| `/dev/random` vs `/dev/urandom` | Generateurs aleatoires (verifier la completude). |

---

## 13. Reseau — Layer 2 (Data Link)

### 13.1 Spanning Tree Protocol (STP)

**Priorite : Haute** — Fondamental dans tout cours reseau pour la prevention des boucles.

| Fonctionnalite | Description |
|---|---|
| STP (IEEE 802.1D) base | Election du Root Bridge (plus petit Bridge ID). Calcul des Root Ports, Designated Ports, Blocked Ports. |
| BPDUs (Bridge Protocol Data Units) | Generation, envoi et reception de BPDUs entre les switches. Les BPDUs doivent etre des frames Ethernet reelles traversant les cables. |
| Port states : Blocking → Listening → Learning → Forwarding | Transitions d'etat avec timers (Forward Delay = 15s, Max Age = 20s, Hello = 2s). |
| Reconvergence | Quand un lien tombe, les switches doivent recalculer la topologie. |
| `show spanning-tree` | Affichage de l'arbre STP : Root ID, Bridge ID, port roles, port states, timers. |
| `spanning-tree vlan X root primary/secondary` | Configuration de la priorite pour forcer le Root Bridge. |
| `spanning-tree vlan X priority N` | Configuration manuelle de la priorite. |
| RSTP (IEEE 802.1w) | Rapid STP : convergence rapide avec les roles Alternate et Backup. Edge ports (PortFast). |
| PVST+ (Per-VLAN Spanning Tree Plus) | Un arbre STP par VLAN (Cisco). |
| MST (Multiple Spanning Tree, 802.1s) | Plusieurs VLANs mappes sur un meme arbre. |
| PortFast | Les ports d'acces passent directement en Forwarding (pas de Listening/Learning). |
| BPDU Guard | Desactive le port si un BPDU est recu (protection sur les ports PortFast). |
| BPDU Filter | Empeche l'envoi/reception de BPDUs sur un port. |
| Root Guard | Empeche un port de devenir Root Port. |
| Loop Guard | Detecte les boucles unidirectionnelles. |

### 13.2 EtherChannel / Link Aggregation

**Priorite : Moyenne**

| Fonctionnalite | Description |
|---|---|
| EtherChannel statique (mode `on`) | Aggregation manuelle de liens entre deux switches. |
| LACP (IEEE 802.3ad) | Protocole de negociation dynamique d'aggregation. Modes `active`/`passive`. |
| PAgP (Cisco) | Port Aggregation Protocol. Modes `desirable`/`auto`. |
| `channel-group N mode active/passive/on` | Configuration d'un port dans un group d'aggregation. |
| `interface Port-channel N` | Interface logique d'aggregation. |
| Load balancing (src-mac, dst-mac, src-dst-mac, src-ip, dst-ip, src-dst-ip) | Algorithme de repartition du trafic sur les liens physiques. |
| `show etherchannel summary` | Affichage de l'etat des EtherChannels. |

### 13.3 Discovery Protocols

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| CDP (Cisco Discovery Protocol) | Envoi/reception de packets CDP entre voisins Cisco. Informations : Device ID, Platform, Capabilities, Interface, IP Address. |
| `show cdp neighbors` / `show cdp neighbors detail` | Affichage des voisins decouverts. |
| `cdp run` / `no cdp run` | Activation/desactivation globale. |
| `cdp enable` / `no cdp enable` | Par interface. |
| LLDP (IEEE 802.1AB) | Standard equivalent multi-vendeur. |
| `lldp run` / `show lldp neighbors` | Commandes LLDP. |

### 13.4 VLANs — Ameliorations

**Priorite : Basse** — La fonctionnalite de base est implementee.

| Fonctionnalite | Description |
|---|---|
| VTP (VLAN Trunking Protocol) | Propagation automatique des VLANs entre switches. Modes : Server, Client, Transparent. |
| `vtp mode server/client/transparent` | Configuration VTP. |
| `show vtp status` | Affichage de l'etat VTP. |
| Private VLANs | VLANs isolees et communautaires a l'interieur d'un VLAN primaire. |
| VLAN range commands | `vlan 10-20,30` pour creer plusieurs VLANs a la fois. |

---

## 14. Reseau — Layer 3 (Network)

### 14.1 NAT / PAT

**Priorite : Haute** — Enseigne dans tous les cours CCNA et fondamental pour la connectivite Internet.

| Fonctionnalite | Description |
|---|---|
| Static NAT | `ip nat inside source static inside_ip outside_ip`. Traduction 1:1 permanente. |
| Dynamic NAT | `ip nat inside source list ACL pool POOL_NAME`. Traduction dynamique a partir d'un pool d'adresses publiques. |
| PAT / NAT Overload | `ip nat inside source list ACL interface GigabitEthernet0/1 overload`. Traduction de plusieurs IPs internes vers une seule IP externe avec differentiation par port. |
| `ip nat inside` / `ip nat outside` | Designation des interfaces internes et externes. |
| `ip nat pool NAME start end netmask mask` | Definition d'un pool d'adresses NAT. |
| Table de traduction NAT | Stockage des correspondances actives (inside local ↔ inside global). |
| Traduction des paquets en transit | Les paquets traversant le routeur doivent avoir leurs adresses IP source/destination modifiees selon la table NAT. |
| `show ip nat translations` | Affichage de la table de traduction NAT. |
| `show ip nat statistics` | Statistiques NAT (hits, misses, active translations). |
| `clear ip nat translation *` | Vidage de la table NAT. |
| `debug ip nat` | Debug des operations NAT (afficher les traductions en temps reel). |
| NAT pour ICMP (ping a travers NAT) | L'ICMP ID doit etre traduit pour le PAT. |
| NAT pour les paquets DNS | Traduction du payload DNS si necessaire. |

### 14.2 EIGRP

**Priorite : Moyenne** — Protocole proprietaire Cisco tres enseigne dans le cursus CCNA/CCNP.

| Fonctionnalite | Description |
|---|---|
| Configuration EIGRP | `router eigrp AS_NUMBER`, `network NETWORK WILDCARD`. |
| Algorithme DUAL (Diffusing Update Algorithm) | Calcul du successeur (meilleur chemin) et feasible successor (chemin de secours). |
| Metriques composites | Bandwidth, Delay, Reliability, Load (K-values). Par defaut K1=K3=1, K2=K4=K5=0. |
| Neighbor discovery (Hello packets) | Decouverte et maintenance des voisins EIGRP. |
| Neighbor table | Table des voisins avec Hold Time, Uptime, SRTT, RTO, Queue Count. |
| Topology table | Toutes les routes apprises avec Feasible Distance et Reported Distance. |
| Route table | Meilleures routes installees dans la table de routage. |
| Convergence rapide | Basculement instantane vers le feasible successor quand le successeur tombe. |
| Redistribution | `redistribute static`, `redistribute ospf`, `redistribute connected`. |
| Summarization | `ip summary-address eigrp AS_NUMBER NETWORK MASK`. |
| Passive interface | `passive-interface INTERFACE`. |
| Authentication MD5 | `ip authentication mode eigrp AS_NUMBER md5`. |
| `show ip eigrp neighbors` | Affichage des voisins. |
| `show ip eigrp topology` | Affichage de la table de topologie. |
| `show ip eigrp interfaces` | Interfaces participant a EIGRP. |

### 14.3 BGP

**Priorite : Moyenne** — Enseigne dans les cours CCNP et indispensable pour comprendre Internet.

| Fonctionnalite | Description |
|---|---|
| Configuration eBGP | `router bgp LOCAL_AS`, `neighbor IP remote-as REMOTE_AS`. |
| Configuration iBGP | Meme AS pour les voisins internes. |
| BGP neighbor states | Idle → Connect → OpenSent → OpenConfirm → Established. |
| BGP messages | OPEN, UPDATE, KEEPALIVE, NOTIFICATION. |
| BGP table (Adj-RIB-In, Loc-RIB, Adj-RIB-Out) | Tables de routage BGP. |
| Best path selection | Algorithme de selection : Weight → Local Pref → Locally originated → AS Path → Origin → MED → eBGP > iBGP → IGP metric → Router ID. |
| AS_PATH attribute | Chemin des systemes autonomes traverses. |
| NEXT_HOP attribute | Adresse du prochain saut. |
| LOCAL_PREF attribute | Preference locale (iBGP). |
| MED (Multi-Exit Discriminator) | Metrique inter-AS. |
| Route filtering (prefix-list, route-map) | Filtrage des annonces BGP. |
| `network NETWORK mask MASK` | Annonce de reseaux. |
| `show ip bgp` | Table BGP complete. |
| `show ip bgp summary` | Resume des voisins BGP. |
| `show ip bgp neighbors` | Detail des voisins. |

### 14.4 HSRP / VRRP / GLBP

**Priorite : Moyenne** — Redondance du premier saut.

| Fonctionnalite | Description |
|---|---|
| HSRP (Hot Standby Router Protocol) | Un routeur Active, un Standby. IP virtuelle partagee. Hello/Hold timers. |
| `standby GROUP ip VIRTUAL_IP` | Configuration HSRP. |
| `standby GROUP priority N` / `standby GROUP preempt` | Priorite et preemption. |
| `show standby` | Affichage de l'etat HSRP. |
| VRRP (Virtual Router Redundancy Protocol) | Standard IEEE. Master/Backup avec priorite. |
| `vrrp GROUP ip VIRTUAL_IP` | Configuration VRRP. |
| GLBP (Gateway Load Balancing Protocol) | Equilibrage de charge entre passerelles. |

### 14.5 Tunnels GRE

**Priorite : Basse** — Partiellement implemente (show only).

| Fonctionnalite | Description |
|---|---|
| Encapsulation GRE reelle | Les paquets doivent etre encapsules dans un header GRE + header IP externe avant d'etre envoyes a travers le reseau. |
| `interface Tunnel N` | Interface tunnel avec source/destination. |
| `tunnel source INTERFACE` / `tunnel destination IP` | Configuration des extremites du tunnel. |
| `tunnel mode gre ip` | Mode d'encapsulation. |
| Routage a travers le tunnel | Les routes pointant vers l'interface tunnel doivent fonctionner. |
| `show interface tunnel N` | Statistiques du tunnel. |

### 14.6 VRF (Virtual Routing and Forwarding)

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `ip vrf NAME` / `vrf definition NAME` | Creation d'une instance VRF. |
| `ip vrf forwarding NAME` | Association d'une interface a un VRF. |
| Tables de routage separees par VRF | Chaque VRF a sa propre table de routage. |
| `show ip route vrf NAME` | Table de routage d'un VRF specifique. |
| `ping vrf NAME destination` | Ping dans un contexte VRF. |

### 14.7 Policy-Based Routing (PBR)

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `route-map NAME permit/deny SEQ` | Definition de route-maps. |
| `match ip address ACL` | Condition de correspondance. |
| `set ip next-hop IP` | Action de routage. |
| `ip policy route-map NAME` | Application sur une interface. |

### 14.8 IPv6 — Ameliorations

**Priorite : Basse** — La base IPv6 est implementee.

| Fonctionnalite | Description |
|---|---|
| OSPFv3 authentication | Authentication IPsec pour OSPFv3. |
| EIGRPv6 | EIGRP pour IPv6 (quand EIGRP sera implemente). |
| BGP4+ (MP-BGP pour IPv6) | Extensions multi-protocole pour BGP. |
| DHCPv6 stateful | Attribution d'adresses IPv6 via DHCPv6 (pas seulement SLAAC). |
| IPv6 ACLs etendues | Verifier la completude des ACLs IPv6. |

---

## 15. Reseau — Layer 4+ (Transport/Application)

### 15.1 DNS — Ameliorations

**Priorite : Moyenne** — Le DNS est configure mais les requetes ne sont pas de vrais paquets.

| Fonctionnalite | Description |
|---|---|
| Paquets DNS reels (UDP port 53) | Les requetes `dig`, `nslookup`, `host` doivent generer de vrais paquets UDP DNS qui traversent le reseau jusqu'au serveur DNS configure. |
| Recursion DNS | Le serveur DNS doit supporter les requetes recursives (forwarder vers un autre serveur DNS si l'enregistrement n'est pas local). |
| Zone transfers (AXFR) | Transfert de zone entre serveurs DNS primaire et secondaire. |
| `AAAA` records dynamiques | Enregistrements IPv6 generes automatiquement a partir des interfaces. |
| `SOA` records | Enregistrement Start of Authority pour chaque zone. |
| `NS` records | Enregistrements Name Server. |
| `SRV` records | Enregistrements de service. |
| Reverse DNS zones | Zones `in-addr.arpa` et `ip6.arpa` pour les requetes PTR. |

### 15.2 HTTP / HTTPS

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Serveur HTTP basique sur LinuxServer | Ecoute sur le port 80, reponse avec le contenu de fichiers du filesystem simule. |
| Client HTTP (`curl`, `wget`) | Envoi de requetes HTTP vers les serveurs du reseau. |
| Paquets TCP simules (3-way handshake) | SYN → SYN-ACK → ACK simplifie pour les connexions HTTP. |
| HTTPS (TLS handshake simplifie) | Simulation basique du handshake TLS. |

### 15.3 SSH / Telnet

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `ssh user@host` | Ouvrir un terminal distant vers un autre equipement du reseau. Generer des paquets TCP (port 22) qui traversent le reseau. |
| `telnet host [port]` | Idem sur port 23 (ou port specifie). |
| Serveur SSH/Telnet sur les routeurs | Accepter les connexions entrantes et ouvrir un shell CLI. |
| `line vty 0 4` / `transport input ssh` | Configuration des lignes virtuelles Cisco. |
| `ip ssh version 2` | Configuration SSH sur les equipements Cisco. |

### 15.4 SNMP

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `snmp-server community STRING ro/rw` | Configuration SNMP v2c sur les routeurs/switches. |
| `snmp-server host IP version 2c COMMUNITY` | Destination des traps. |
| Reponse aux requetes SNMP GET/SET | Retourner les valeurs des OIDs simules (sysName, sysDescr, ifTable). |
| Traps SNMP | Envoi de traps lors d'evenements (link up/down, cold start). |
| `show snmp` | Statistiques SNMP. |

### 15.5 NTP

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `ntp server IP` | Configuration d'un serveur NTP. |
| Synchronisation d'horloge simulee | Les equipements clients ajustent leur horloge vers le serveur NTP. |
| `show ntp associations` | Affichage des associations NTP. |
| `show ntp status` | Statut de synchronisation. |
| `show clock` | Horloge synchronisee. |

### 15.6 Syslog — Transmission reelle

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `logging host IP` | Envoi de messages syslog via UDP 514 vers un serveur de logs. |
| Paquets syslog reels | Les messages de log doivent etre encapsules dans des paquets UDP et traverser le reseau. |
| Serveur syslog sur LinuxServer | Reception et stockage des messages syslog. |
| Niveaux de severite (0-7) | `logging trap LEVEL` pour filtrer les messages envoyes. |

### 15.7 FTP / TFTP

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| Serveur TFTP sur LinuxServer | Pour le transfert de configurations et d'images IOS. |
| `copy running-config tftp:` | Sauvegarde de configuration vers TFTP. |
| `copy tftp: running-config` | Restauration de configuration depuis TFTP. |
| Serveur FTP basique | Upload/download de fichiers. |

### 15.8 AAA (Authentication, Authorization, Accounting)

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `aaa new-model` | Activation du framework AAA. |
| `aaa authentication login METHOD_LIST` | Methodes d'authentification (local, radius, tacacs+). |
| `aaa authorization exec METHOD_LIST` | Autorisation de commandes. |
| Serveur RADIUS basique | Sur LinuxServer, repondre aux requetes d'authentification. |
| Serveur TACACS+ basique | Idem pour TACACS+. |
| `radius-server host IP key SECRET` | Configuration du serveur RADIUS. |
| `tacacs-server host IP key SECRET` | Configuration du serveur TACACS+. |

### 15.9 802.1X

**Priorite : Basse**

| Fonctionnalite | Description |
|---|---|
| `dot1x system-auth-control` | Activation globale de 802.1X. |
| `authentication port-control auto` | Configuration par port. |
| EAP (Extensible Authentication Protocol) | Echange EAP simplifie entre supplicant, authenticator et serveur RADIUS. |
| Port states : unauthorized → authorized | Transition apres authentification reussie. |

---

## 16. Reseau — Shells CLI (Cisco IOS / Huawei VRP / Windows)

### 16.1 Cisco IOS — Commandes show manquantes

| Commande | Priorite | Description |
|---|---|---|
| `show spanning-tree` | Haute | Arbre STP : Root ID, Bridge ID, port roles/states, timers, cost. |
| `show spanning-tree vlan N` | Haute | STP pour un VLAN specifique. |
| `show cdp neighbors` | Basse | Voisins CDP decouverts. |
| `show cdp neighbors detail` | Basse | Detail des voisins CDP. |
| `show etherchannel summary` | Moyenne | Resume des EtherChannels. |
| `show etherchannel detail` | Moyenne | Detail des EtherChannels. |
| `show ip nat translations` | Haute | Table de traduction NAT. |
| `show ip nat statistics` | Haute | Statistiques NAT. |
| `show ip eigrp neighbors` | Moyenne | Voisins EIGRP. |
| `show ip eigrp topology` | Moyenne | Table de topologie EIGRP. |
| `show ip bgp` | Moyenne | Table BGP. |
| `show ip bgp summary` | Moyenne | Resume BGP. |
| `show standby` | Moyenne | Etat HSRP. |
| `show vrrp` | Moyenne | Etat VRRP. |
| `show ip protocols` | Basse | Protocoles de routage actifs et leurs parametres. |
| `show ip traffic` | Basse | Statistiques de trafic IP. |
| `show ip interface brief` ameliore | Basse | Ajouter le statut du protocole (up/up, up/down, administratively down). |
| `show logging` | Basse | Buffer de log local. |
| `show ntp associations` | Basse | Associations NTP. |
| `show snmp` | Basse | Statistiques SNMP. |
| `show vtp status` | Basse | Statut VTP. |

### 16.2 Cisco IOS — Commandes de configuration manquantes

| Commande | Priorite | Description |
|---|---|---|
| `ip nat inside source static INSIDE OUTSIDE` | Haute | NAT statique. |
| `ip nat inside source list ACL pool POOL overload` | Haute | PAT / NAT dynamique. |
| `ip nat pool NAME START END netmask MASK` | Haute | Pool NAT. |
| `ip nat inside` / `ip nat outside` | Haute | Designation des interfaces NAT. |
| `spanning-tree mode rapid-pvst / mst` | Haute | Mode STP. |
| `spanning-tree vlan N root primary` | Haute | Forcer le Root Bridge. |
| `spanning-tree portfast` | Haute | PortFast sur un port. |
| `spanning-tree bpduguard enable` | Haute | BPDU Guard. |
| `channel-group N mode active/passive/on` | Moyenne | Configuration EtherChannel. |
| `router eigrp AS` | Moyenne | Configuration EIGRP. |
| `router bgp AS` / `neighbor IP remote-as AS` | Moyenne | Configuration BGP. |
| `standby GROUP ip VIRTUAL_IP` | Moyenne | Configuration HSRP. |
| `ntp server IP` | Basse | Configuration NTP. |
| `snmp-server community STRING ro/rw` | Basse | Configuration SNMP. |
| `logging host IP` | Basse | Configuration syslog distant. |
| `line vty 0 4` / `transport input ssh` | Basse | Lignes virtuelles. |
| `ip ssh version 2` | Basse | Configuration SSH. |
| `banner motd # MESSAGE #` | Basse | Banniere de connexion. |
| `service password-encryption` | Basse | Chiffrement des mots de passe en configuration. |
| `enable secret PASSWORD` | Basse | Mot de passe privileged mode. |
| `username USER secret PASSWORD` | Basse | Utilisateur local. |
| `aaa new-model` | Basse | Framework AAA. |
| `crypto key generate rsa` | Basse | Generation de cles RSA pour SSH. |

### 16.3 Huawei VRP — Commandes manquantes

| Commande | Priorite | Description |
|---|---|---|
| `display stp` | Haute | Etat STP (equivalent `show spanning-tree`). |
| `display eth-trunk` | Moyenne | Etat des trunks agreges. |
| `display bgp routing-table` | Moyenne | Table BGP. |
| `display nat session all` | Haute | Table NAT. |
| `display vrrp` | Moyenne | Etat VRRP. |
| `stp mode rstp / mstp` | Haute | Configuration STP. |
| `stp root primary / secondary` | Haute | Priorite STP. |
| `nat static global OUTSIDE inside INSIDE` | Haute | NAT statique Huawei. |
| `interface Eth-Trunk N` / `trunkport` | Moyenne | Configuration d'aggregation. |

### 16.4 Windows — Ameliorations

| Commande | Priorite | Description |
|---|---|---|
| `netstat -an` ameliore | Basse | Afficher les connexions TCP/UDP actives avec PID. |
| `nslookup` interactif | Basse | Mode interactif de nslookup (set type=MX, server, etc.). |
| `pathping` | Basse | Combinaison tracert + ping. |
| `Get-Process` (PowerShell) | Basse | Liste des processus. |
| `Get-Service` (PowerShell) | Basse | Liste des services. |
| `Test-NetConnection` (PowerShell) | Basse | Test de connectivite avance. |
| `Resolve-DnsName` (PowerShell) | Basse | Resolution DNS. |

---

## 17. Priorites d'implementation

Synthese des fonctionnalites par ordre de priorite, basee sur l'impact pedagogique et la frequence d'utilisation dans les cours.

### 17.1 Priorite Haute — Realisme fondamental

Ces fonctionnalites sont enseignees dans la majorite des cours et leur absence nuit a la credibilite du simulateur.

| # | Fonctionnalite | Section | Effort estime |
|---|---|---|---|
| 1 | **PL/SQL Curseurs explicites** (OPEN/FETCH/CLOSE, cursor FOR LOOP, %FOUND/%NOTFOUND/%ROWCOUNT) | 3.1, 3.2 | Moyen |
| 2 | **PL/SQL Curseurs implicites** (SQL%ROWCOUNT, SQL%FOUND, SQL%NOTFOUND) | 3.2 | Faible |
| 3 | **Transaction ROLLBACK reel** (undo log, SAVEPOINT tracking, annulation effective) | 4.1 | Eleve |
| 4 | **Trigger execution reelle** (declenchement sur INSERT/UPDATE/DELETE, :NEW/:OLD) | 3.7 | Moyen |
| 5 | **PL/SQL Packages** (specification + body, etat persistant, appel qualifie) | 3.3 | Eleve |
| 6 | **NAT / PAT** (static, dynamic, overload, traduction de paquets en transit) | 14.1 | Eleve |
| 7 | **STP / RSTP** (election Root Bridge, BPDUs, port states, convergence) | 13.1 | Eleve |
| 8 | **Fonctions REGEXP_*** (REGEXP_SUBSTR, REGEXP_REPLACE, REGEXP_INSTR, REGEXP_LIKE) | 7.1 | Moyen |
| 9 | **Fonctions de date** (ADD_MONTHS, MONTHS_BETWEEN, LAST_DAY, TRUNC(date)) | 7.2 | Moyen |
| 10 | **LISTAGG execution complete** | 1.1 | Faible |
| 11 | **systemctl / service** (start, stop, restart, status, enable, disable) | 11.4 | Moyen |
| 12 | **RAISE / RAISE_APPLICATION_ERROR** | 3.6 | Faible |
| 13 | **Commandes show STP** (show spanning-tree sur Cisco IOS et display stp sur Huawei VRP) | 16.1, 16.3 | Faible |
| 14 | **Commandes show/config NAT** (show ip nat translations, ip nat inside/outside) | 16.1, 16.2 | Faible |

### 17.2 Priorite Moyenne — Enrichissement significatif

Fonctionnalites enseignees dans les cours intermediaires/avances.

| # | Fonctionnalite | Section | Effort estime |
|---|---|---|---|
| 15 | **BGP** (eBGP/iBGP, best path selection, AS_PATH, show ip bgp) | 14.3 | Eleve |
| 16 | **EIGRP** (DUAL, metriques composites, neighbor/topology tables) | 14.2 | Eleve |
| 17 | **HSRP / VRRP** (redondance premier saut, IP virtuelle, preemption) | 14.4 | Moyen |
| 18 | **EtherChannel / LACP** (aggregation de liens, load balancing) | 13.2 | Moyen |
| 19 | **Shell : structures de controle** (if/for/while/case dans bash) | 10.2 | Moyen |
| 20 | **Shell : substitution de commandes** ($(...), backticks) | 10.1 | Moyen |
| 21 | **Shell : fonctions** (definition, parametres, local, return) | 10.3 | Moyen |
| 22 | **PL/SQL Collections** (TABLE OF, VARRAY, associative arrays) | 3.4 | Moyen |
| 23 | **BULK COLLECT / FORALL** | 3.5 | Moyen |
| 24 | **EXECUTE IMMEDIATE** (SQL dynamique) | 3.9 | Moyen |
| 25 | **PL/SQL Records** (TYPE IS RECORD, acces champs) | 3.10 | Faible |
| 26 | **Partitionnement Oracle** (RANGE, LIST, HASH, ALTER TABLE PARTITION) | 2.1, 9.2 | Eleve |
| 27 | **Flashback** (AS OF TIMESTAMP, DROP/UNDROP, RECYCLEBIN) | 9.1 | Moyen |
| 28 | **PIVOT / UNPIVOT** | 1.2 | Moyen |
| 29 | **Verrouillage** (row-level locks, FOR UPDATE enforcement, deadlock detection) | 4.3 | Eleve |
| 30 | **df, du, free** (gestion disques/memoire Linux) | 11.2 | Faible |
| 31 | **apt / dpkg** (gestion de paquets) | 11.3 | Moyen |
| 32 | **tar / gzip / zip** (archivage/compression) | 11.5 | Faible |
| 33 | **curl / wget** (clients HTTP simules) | 11.6 | Moyen |
| 34 | **/proc/cpuinfo, /proc/meminfo** (filesystem virtuel) | 12.1 | Faible |
| 35 | **/etc/passwd, /etc/group comme fichiers** | 12.3 | Faible |
| 36 | **DBA_DEPENDENCIES** vue | 5.2 | Faible |
| 37 | **DBA_AUDIT_TRAIL dynamique** | 5.1 | Moyen |
| 38 | **SQL*Plus scripts** (@filename execution reelle) | 8.1 | Moyen |
| 39 | **COLUMN FORMAT** dans SQL*Plus | 8.2 | Moyen |
| 40 | **Materialized Views** (materialisation reelle, refresh) | 2.4 | Moyen |
| 41 | **DNS paquets reels** (requetes UDP traversant le reseau) | 15.1 | Moyen |
| 42 | **Multi-table INSERT execution** | 1.3 | Faible |
| 43 | **Isolation levels** (READ COMMITTED, SERIALIZABLE) | 4.2 | Moyen |
| 44 | **DBMS_SQL** (dynamic SQL bas niveau) | 6.1 | Moyen |
| 45 | **FAILED_LOGIN_ATTEMPTS enforcement** | 5.3 | Faible |
| 46 | **Function-based INDEX** | 2.3 | Faible |
| 47 | **TO_TIMESTAMP** | 7.3 | Faible |
| 48 | **TRANSLATE** fonction | 7.1 | Faible |
| 49 | **SET AUTOTRACE** SQL*Plus | 8.3 | Moyen |
| 50 | **WHENEVER SQLERROR** SQL*Plus | 8.3 | Faible |

### 17.3 Priorite Basse — Fonctionnalites avancees

Fonctionnalites specialisees, rarement essentielles pour un simulateur pedagogique.

| # | Categorie | Fonctionnalites |
|---|---|---|
| 51 | **Oracle avance** | LOBs reels, XML/JSON, Types objets, VPD, TDE, Fine-Grained Audit |
| 52 | **Oracle backup** | RMAN interactif, expdp/impdp, archive log management |
| 53 | **Oracle HA** | Data Guard, RAC concepts |
| 54 | **Oracle networking** | Queries cross-link, connection pooling, TAF |
| 55 | **Oracle packages** | DBMS_LOB complet, UTL_FILE reel, DBMS_CRYPTO, DBMS_SCHEDULER execution |
| 56 | **Oracle fonctions** | Trigonometrie, hyperbolic, ORA_HASH, SOUNDEX, DUMP |
| 57 | **Oracle SQL*Plus** | HOST, EDIT, SAVE/GET, BREAK/COMPUTE, TTITLE/BTITLE |
| 58 | **Reseau L2** | CDP/LLDP, VTP, Private VLANs, MST |
| 59 | **Reseau L3** | GRE encapsulation reelle, VRF, PBR, IPv6 avance |
| 60 | **Reseau L4+** | HTTP/HTTPS, SSH/Telnet protocole, SNMP, NTP, Syslog paquets, FTP/TFTP |
| 61 | **Reseau securite** | AAA/RADIUS/TACACS+, 802.1X |
| 62 | **Linux shell** | Jobs/bg/fg, brace expansion, aliases, traps, signaux |
| 63 | **Linux filesystem** | /sys, /dev complet, ~/.bash_profile sourcing |
| 64 | **Linux commandes** | sed, xargs, ssh, scp, netstat, ss, tcpdump, nmap |
| 65 | **Linux systeme** | lscpu, lsmod, sysctl, dmidecode |
| 66 | **Windows** | netstat ameliore, PowerShell Get-Process/Get-Service, Test-NetConnection |

---

## Appendice A — Codes d'erreur Oracle a ajouter

Codes ORA- non encore implementes mais couramment rencontres :

| Code | Message | Contexte |
|---|---|---|
| ORA-00054 | resource busy and acquire with NOWAIT specified | Locking (FOR UPDATE NOWAIT) |
| ORA-00060 | deadlock detected while waiting for resource | Deadlock detection |
| ORA-01403 | no data found | PL/SQL SELECT INTO (verifier completude) |
| ORA-01410 | invalid ROWID | ROWID operations |
| ORA-01422 | exact fetch returns more than requested number of rows | SELECT INTO multiple rows |
| ORA-01489 | result of string concatenation is too long | String overflow |
| ORA-01502 | index or partition of such index is in unusable state | Index maintenance |
| ORA-02266 | unique/primary keys in table referenced by enabled foreign keys | Drop constraint |
| ORA-04068 | existing state of packages has been discarded | Package invalidation |
| ORA-06550 | line N, column N: PL/SQL compilation error | PL/SQL compilation |
| ORA-08177 | can't serialize access for this transaction | Serializable isolation |
| ORA-20000 a ORA-20999 | user-defined exception | RAISE_APPLICATION_ERROR |
| ORA-30006 | resource busy; acquire with WAIT timeout expired | FOR UPDATE WAIT timeout |

---

## Appendice B — Metriques actuelles

| Metrique | Valeur |
|---|---|
| Tests totaux (suite complete) | 2 710+ |
| Tests Oracle database | 362+ |
| Vues catalogue implementees | 70 (36 V$ + 34 DBA_/ALL_/USER_) |
| Codes ORA- implementes | 60+ |
| Protocoles reseau | OSPF, OSPFv3, RIPv2, ARP, ICMP, DHCP, IPsec, DNS (config) |
| Devices supportes | CiscoRouter, HuaweiRouter, CiscoSwitch, HuaweiSwitch, GenericSwitch, Hub, LinuxPC, WindowsPC, LinuxServer |
| Shells CLI | Cisco IOS, Huawei VRP, Linux bash, Windows cmd, PowerShell, Oracle SQL*Plus |
