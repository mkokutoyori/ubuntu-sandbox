# Oracle Database Server - Guide d'utilisation

Ce document explique comment utiliser le serveur de base de données Oracle dans NetSim.

## Démarrage rapide

### 1. Créer un serveur Oracle

Dans le simulateur réseau, ajoutez un appareil de type **db-oracle** (Oracle Database Server). L'appareil viendra pré-installé avec:

- Oracle Database 21c Express Edition (`oracle-xe-21c`)
- Oracle Instant Client (`oracle-instantclient`)
- Oracle SQL*Plus (`oracle-sqlplus`)

### 2. Accéder au terminal

Double-cliquez sur l'appareil Oracle pour ouvrir le terminal. Vous verrez un terminal Linux standard (Ubuntu).

### 3. Lancer SQL*Plus

```bash
sqlplus
```

Ou avec des identifiants:
```bash
sqlplus system/oracle@ORCL
sqlplus scott/tiger@ORCL
```

Pour se connecter sans connexion initiale:
```bash
sqlplus /nolog
```

## Utilisation de SQL*Plus

### Commandes SQL de base

Une fois dans SQL*Plus, vous pouvez exécuter des requêtes SQL:

```sql
-- Créer une table
CREATE TABLE employees (
    id NUMBER PRIMARY KEY,
    name VARCHAR2(100),
    department VARCHAR2(50),
    salary NUMBER(10,2),
    hire_date DATE
);

-- Insérer des données
INSERT INTO employees VALUES (1, 'John Doe', 'IT', 75000, SYSDATE);
INSERT INTO employees VALUES (2, 'Jane Smith', 'HR', 65000, TO_DATE('2023-01-15', 'YYYY-MM-DD'));

-- Valider les changements
COMMIT;

-- Consulter les données
SELECT * FROM employees;

-- Mise à jour
UPDATE employees SET salary = 80000 WHERE id = 1;

-- Suppression
DELETE FROM employees WHERE id = 2;
```

### Commandes SQL*Plus

SQL*Plus supporte des commandes spéciales (sans point-virgule):

```
-- Afficher les paramètres
SHOW ALL
SHOW USER
SHOW LINESIZE

-- Configurer l'affichage
SET LINESIZE 200
SET PAGESIZE 50
SET FEEDBACK ON
SET ECHO ON

-- Formater les colonnes
COLUMN name FORMAT A30
COLUMN salary FORMAT 999,999.99

-- Décrire une table
DESC employees
DESCRIBE employees

-- Afficher l'aide
HELP
HELP SELECT

-- Quitter
EXIT
QUIT
```

### Vues du dictionnaire de données

Oracle fournit des vues système pour explorer la base:

```sql
-- Tables de l'utilisateur courant
SELECT table_name FROM user_tables;

-- Toutes les tables accessibles
SELECT owner, table_name FROM all_tables;

-- Colonnes d'une table
SELECT column_name, data_type, data_length
FROM user_tab_columns
WHERE table_name = 'EMPLOYEES';

-- Utilisateurs de la base
SELECT username, account_status FROM dba_users;

-- Sessions actives
SELECT sid, serial#, username, status FROM v$session;

-- Informations sur la base
SELECT * FROM v$database;
SELECT * FROM v$instance;
```

### Fonctions Oracle

Les fonctions Oracle courantes sont disponibles:

```sql
-- Fonctions de chaîne
SELECT UPPER('hello'), LOWER('WORLD'), INITCAP('john doe') FROM dual;
SELECT SUBSTR('Hello World', 1, 5) FROM dual;  -- 'Hello'
SELECT LENGTH('Oracle') FROM dual;  -- 6
SELECT TRIM('  spaces  ') FROM dual;
SELECT REPLACE('Hello', 'l', 'L') FROM dual;

-- Fonctions numériques
SELECT ROUND(123.456, 2), TRUNC(123.456, 1) FROM dual;
SELECT ABS(-10), CEIL(4.2), FLOOR(4.8) FROM dual;
SELECT MOD(10, 3), POWER(2, 8) FROM dual;

-- Fonctions de date
SELECT SYSDATE, SYSTIMESTAMP FROM dual;
SELECT TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI:SS') FROM dual;
SELECT TO_DATE('2024-12-25', 'YYYY-MM-DD') FROM dual;
SELECT ADD_MONTHS(SYSDATE, 3) FROM dual;
SELECT MONTHS_BETWEEN(SYSDATE, TO_DATE('2024-01-01', 'YYYY-MM-DD')) FROM dual;

-- Fonctions de conversion
SELECT TO_NUMBER('123.45') FROM dual;
SELECT NVL(NULL, 'valeur par défaut') FROM dual;
SELECT NVL2(NULL, 'non null', 'est null') FROM dual;
SELECT COALESCE(NULL, NULL, 'trouvé') FROM dual;

-- Fonction DECODE
SELECT DECODE(1, 1, 'un', 2, 'deux', 'autre') FROM dual;

-- Fonction CASE
SELECT
    CASE
        WHEN 1 = 1 THEN 'vrai'
        ELSE 'faux'
    END
FROM dual;
```

### Transactions

```sql
-- Démarrer une transaction implicitement avec INSERT/UPDATE/DELETE

-- Valider
COMMIT;

-- Annuler
ROLLBACK;

-- Point de sauvegarde
SAVEPOINT sp1;
-- ... opérations ...
ROLLBACK TO sp1;

-- Configuration auto-commit
SET AUTOCOMMIT ON
SET AUTOCOMMIT OFF
```

## Installation manuelle

Si vous utilisez un serveur Linux standard et souhaitez installer Oracle manuellement:

```bash
# Mettre à jour les paquets
apt update

# Installer Oracle Database Express Edition
apt install oracle-xe-21c

# Ou installer uniquement le client SQL*Plus
apt install oracle-sqlplus
```

## Limitations de la simulation

Cette simulation Oracle comprend:

- Lexer et parser SQL complets
- Moteur de base de données en mémoire
- Support CREATE TABLE, INSERT, UPDATE, DELETE, SELECT
- Jointures (INNER, LEFT, RIGHT, FULL)
- GROUP BY, HAVING, ORDER BY
- Fonctions Oracle (80+ fonctions)
- Vues du dictionnaire de données
- Interface SQL*Plus avec commandes SET/SHOW

Fonctionnalités non simulées:
- Stockage persistant (les données sont en mémoire)
- PL/SQL (procédures stockées, fonctions, packages)
- Déclencheurs (triggers)
- Séquences et index avancés
- Réplication et clustering

## Raccourcis clavier

Dans le terminal SQL*Plus:

- `Ctrl+D` - Quitter SQL*Plus
- `Ctrl+C` - Annuler la commande en cours
- `Ctrl+L` - Effacer l'écran
- `↑/↓` - Naviguer dans l'historique des commandes

## Dépannage

### "sqlplus: command not found"

Le package Oracle n'est pas installé. Installez-le avec:
```bash
apt install oracle-xe-21c
```

### Erreurs de syntaxe SQL

Assurez-vous que:
- Les commandes SQL se terminent par `;`
- Les commandes SQL*Plus (SET, SHOW, EXIT) n'ont pas de `;`
- Les noms de tables/colonnes sont valides

### Voir les erreurs détaillées

```sql
SHOW ERRORS
```

## Exemples avancés

### Création d'un schéma complet

```sql
-- Table des départements
CREATE TABLE departments (
    dept_id NUMBER PRIMARY KEY,
    dept_name VARCHAR2(50) NOT NULL,
    location VARCHAR2(100)
);

-- Table des employés avec clé étrangère
CREATE TABLE employees (
    emp_id NUMBER PRIMARY KEY,
    first_name VARCHAR2(50),
    last_name VARCHAR2(50),
    email VARCHAR2(100),
    dept_id NUMBER,
    salary NUMBER(10,2),
    hire_date DATE DEFAULT SYSDATE
);

-- Insertion de données
INSERT INTO departments VALUES (10, 'IT', 'Building A');
INSERT INTO departments VALUES (20, 'HR', 'Building B');
INSERT INTO departments VALUES (30, 'Sales', 'Building C');

INSERT INTO employees VALUES (1, 'John', 'Doe', 'john.doe@company.com', 10, 75000, TO_DATE('2020-01-15', 'YYYY-MM-DD'));
INSERT INTO employees VALUES (2, 'Jane', 'Smith', 'jane.smith@company.com', 20, 65000, TO_DATE('2021-03-20', 'YYYY-MM-DD'));
INSERT INTO employees VALUES (3, 'Bob', 'Johnson', 'bob.j@company.com', 10, 80000, TO_DATE('2019-06-01', 'YYYY-MM-DD'));

COMMIT;

-- Requête avec jointure
SELECT e.first_name, e.last_name, d.dept_name, e.salary
FROM employees e
INNER JOIN departments d ON e.dept_id = d.dept_id
ORDER BY e.salary DESC;

-- Agrégation par département
SELECT d.dept_name, COUNT(*) as emp_count, AVG(e.salary) as avg_salary
FROM employees e
JOIN departments d ON e.dept_id = d.dept_id
GROUP BY d.dept_name
HAVING COUNT(*) > 0
ORDER BY avg_salary DESC;
```
