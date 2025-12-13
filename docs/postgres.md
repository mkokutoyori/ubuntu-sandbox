# PostgreSQL Database Server - Guide d'utilisation

Ce document explique comment utiliser le serveur PostgreSQL dans NetSim.

## Démarrage rapide

### 1. Créer un serveur PostgreSQL

Dans le simulateur réseau, ajoutez un appareil de type **db-postgres** (PostgreSQL Server). L'appareil viendra pré-installé avec:

- PostgreSQL 14 (`postgresql-14`)
- Client PostgreSQL (`postgresql-client-14`)

### 2. Accéder au terminal

Double-cliquez sur l'appareil PostgreSQL pour ouvrir le terminal. Vous verrez un terminal Linux standard (Ubuntu).

### 3. Lancer psql

```bash
psql
```

Ou avec des options:
```bash
psql -U postgres -d mydb
psql --username=admin --dbname=production
```

## Utilisation de psql

### Commandes SQL de base

Une fois dans psql, vous pouvez exécuter des requêtes SQL:

```sql
-- Créer une table
CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    department VARCHAR(50),
    salary NUMERIC(10,2),
    hire_date DATE DEFAULT CURRENT_DATE
);

-- Insérer des données
INSERT INTO employees (name, department, salary) VALUES ('John Doe', 'IT', 75000);
INSERT INTO employees (name, department, salary, hire_date) VALUES ('Jane Smith', 'HR', 65000, '2023-01-15');

-- Consulter les données
SELECT * FROM employees;

-- Mise à jour
UPDATE employees SET salary = 80000 WHERE id = 1;

-- Suppression
DELETE FROM employees WHERE id = 2;
```

### Méta-commandes psql

Les méta-commandes commencent par un backslash:

```
\?              -- Aide sur les méta-commandes
\h              -- Aide sur les commandes SQL
\h SELECT       -- Aide sur SELECT

\l              -- Lister les bases de données
\l+             -- Liste détaillée des bases

\c dbname       -- Se connecter à une base
\conninfo       -- Afficher les infos de connexion

\dt             -- Lister les tables
\dt+            -- Liste détaillée des tables
\d tablename    -- Décrire une table
\d+ tablename   -- Description détaillée

\di             -- Lister les index
\dv             -- Lister les vues
\ds             -- Lister les séquences
\dn             -- Lister les schémas
\du             -- Lister les rôles/utilisateurs
\df             -- Lister les fonctions
\db             -- Lister les tablespaces

\x              -- Basculer l'affichage étendu
\a              -- Basculer aligné/non-aligné
\t              -- Basculer affichage tuples seulement
\timing         -- Afficher le temps d'exécution

\p              -- Afficher le buffer de requête
\r              -- Réinitialiser le buffer
\g              -- Exécuter le buffer

\q              -- Quitter psql
```

### Tables système

PostgreSQL fournit des vues système pour explorer la base:

```sql
-- Tables dans le schéma public
SELECT tablename FROM pg_tables WHERE schemaname = 'public';

-- Colonnes d'une table
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'employees';

-- Rôles/utilisateurs
SELECT rolname, rolsuper, rolcreatedb FROM pg_roles;

-- Connexions actives
SELECT pid, usename, application_name, state, query
FROM pg_stat_activity;

-- Statistiques de la base
SELECT datname, numbackends, xact_commit, xact_rollback
FROM pg_stat_database;

-- Paramètres de configuration
SELECT name, setting, category FROM pg_settings;

-- Schémas disponibles
SELECT schema_name FROM information_schema.schemata;
```

### Fonctions PostgreSQL

Les fonctions PostgreSQL courantes sont disponibles:

```sql
-- Fonctions de chaîne
SELECT UPPER('hello'), LOWER('WORLD'), INITCAP('john doe');
SELECT SUBSTRING('Hello World', 1, 5);  -- 'Hello'
SELECT LENGTH('PostgreSQL');  -- 10
SELECT TRIM('  spaces  ');
SELECT REPLACE('Hello', 'l', 'L');
SELECT CONCAT('Hello', ' ', 'World');
SELECT CONCAT_WS(', ', 'a', 'b', 'c');  -- 'a, b, c'
SELECT LEFT('PostgreSQL', 4);  -- 'Post'
SELECT RIGHT('PostgreSQL', 3);  -- 'SQL'
SELECT REVERSE('abc');  -- 'cba'
SELECT REPEAT('ab', 3);  -- 'ababab'
SELECT SPLIT_PART('a,b,c', ',', 2);  -- 'b'

-- Fonctions numériques
SELECT ROUND(123.456, 2), TRUNC(123.456, 1);
SELECT ABS(-10), CEIL(4.2), FLOOR(4.8);
SELECT MOD(10, 3), POWER(2, 8);
SELECT SQRT(16), CBRT(27);
SELECT GREATEST(1, 5, 3), LEAST(1, 5, 3);

-- Fonctions de date/heure
SELECT NOW(), CURRENT_TIMESTAMP, CURRENT_DATE;
SELECT EXTRACT(YEAR FROM NOW());
SELECT EXTRACT(MONTH FROM NOW());
SELECT DATE_TRUNC('month', NOW());
SELECT AGE(CURRENT_DATE, '2020-01-01');
SELECT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS');
SELECT TO_DATE('2024-12-25', 'YYYY-MM-DD');
SELECT TO_TIMESTAMP(1609459200);
SELECT MAKE_DATE(2024, 12, 25);

-- Fonctions conditionnelles
SELECT COALESCE(NULL, NULL, 'default');
SELECT NULLIF(10, 10);  -- NULL
SELECT CASE WHEN 1 = 1 THEN 'yes' ELSE 'no' END;

-- Fonctions JSON
SELECT JSON_BUILD_OBJECT('name', 'John', 'age', 30);
SELECT JSON_BUILD_ARRAY(1, 2, 3);
SELECT JSON_TYPEOF('{"a": 1}'::json);

-- Fonctions système
SELECT VERSION();
SELECT CURRENT_DATABASE();
SELECT CURRENT_SCHEMA();
SELECT CURRENT_USER;
SELECT PG_BACKEND_PID();

-- Génération de données
SELECT GENERATE_SERIES(1, 5);
SELECT GEN_RANDOM_UUID();
```

### Transactions

```sql
-- Démarrer une transaction explicitement
BEGIN;

-- Opérations...
INSERT INTO employees (name, department, salary) VALUES ('Bob', 'Sales', 60000);
UPDATE employees SET salary = salary * 1.1 WHERE department = 'Sales';

-- Valider
COMMIT;

-- Ou annuler
ROLLBACK;

-- Point de sauvegarde
BEGIN;
INSERT INTO employees (name, department, salary) VALUES ('Alice', 'IT', 70000);
SAVEPOINT sp1;
DELETE FROM employees WHERE name = 'Alice';
ROLLBACK TO sp1;  -- Annule le DELETE
COMMIT;
```

## Installation manuelle

Si vous utilisez un serveur Linux standard et souhaitez installer PostgreSQL manuellement:

```bash
# Mettre à jour les paquets
apt update

# Installer PostgreSQL 14
apt install postgresql-14

# Ou installer uniquement le client psql
apt install postgresql-client-14
```

## Formatage de l'affichage

### Mode étendu (\x)

```sql
postgres=# \x
Expanded display is on.

postgres=# SELECT * FROM employees;
-[ RECORD 1 ]---+------------
id              | 1
name            | John Doe
department      | IT
salary          | 75000.00
hire_date       | 2024-01-15
```

### Options pset

```
\pset border 2       -- Style de bordure (0, 1, 2)
\pset format aligned -- Format d'affichage
\pset null '(null)'  -- Affichage des NULL
\pset footer off     -- Masquer le footer
```

## Raccourcis clavier

Dans psql:

- `Ctrl+D` - Quitter psql
- `Ctrl+C` - Annuler la commande en cours
- `Ctrl+L` - Effacer l'écran
- `↑/↓` - Naviguer dans l'historique des commandes

## Différences avec Oracle

| PostgreSQL | Oracle |
|------------|--------|
| `SERIAL` | `NUMBER` + SEQUENCE |
| `VARCHAR` | `VARCHAR2` |
| `BOOLEAN` | NUMBER(1) |
| `NOW()` | `SYSDATE` |
| `COALESCE` | `NVL` |
| `||` pour concaténation | `||` ou `CONCAT` |
| `\d table` | `DESC table` |
| `\dt` | `SELECT * FROM user_tables` |
| `\q` | `EXIT` |

## Exemples avancés

### Création d'un schéma complet

```sql
-- Table des départements
CREATE TABLE departments (
    dept_id SERIAL PRIMARY KEY,
    dept_name VARCHAR(50) NOT NULL,
    location VARCHAR(100)
);

-- Table des employés avec clé étrangère
CREATE TABLE employees (
    emp_id SERIAL PRIMARY KEY,
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    email VARCHAR(100) UNIQUE,
    dept_id INTEGER REFERENCES departments(dept_id),
    salary NUMERIC(10,2) CHECK (salary > 0),
    hire_date DATE DEFAULT CURRENT_DATE
);

-- Index
CREATE INDEX idx_employees_dept ON employees(dept_id);
CREATE INDEX idx_employees_name ON employees(last_name, first_name);

-- Insertion de données
INSERT INTO departments (dept_name, location) VALUES
    ('IT', 'Building A'),
    ('HR', 'Building B'),
    ('Sales', 'Building C');

INSERT INTO employees (first_name, last_name, email, dept_id, salary, hire_date) VALUES
    ('John', 'Doe', 'john.doe@company.com', 1, 75000, '2020-01-15'),
    ('Jane', 'Smith', 'jane.smith@company.com', 2, 65000, '2021-03-20'),
    ('Bob', 'Johnson', 'bob.j@company.com', 1, 80000, '2019-06-01');

-- Requête avec jointure
SELECT e.first_name, e.last_name, d.dept_name, e.salary
FROM employees e
INNER JOIN departments d ON e.dept_id = d.dept_id
ORDER BY e.salary DESC;

-- Agrégation par département
SELECT d.dept_name,
       COUNT(*) as emp_count,
       AVG(e.salary)::NUMERIC(10,2) as avg_salary,
       MAX(e.salary) as max_salary
FROM employees e
JOIN departments d ON e.dept_id = d.dept_id
GROUP BY d.dept_name
HAVING COUNT(*) > 0
ORDER BY avg_salary DESC;
```

### Common Table Expressions (CTE)

```sql
WITH dept_stats AS (
    SELECT dept_id,
           COUNT(*) as emp_count,
           AVG(salary) as avg_salary
    FROM employees
    GROUP BY dept_id
)
SELECT d.dept_name, ds.emp_count, ds.avg_salary
FROM departments d
JOIN dept_stats ds ON d.dept_id = ds.dept_id;
```

## Limitations de la simulation

Cette simulation PostgreSQL comprend:

- Lexer et parser SQL complets
- Moteur de base de données en mémoire
- Support CREATE TABLE, INSERT, UPDATE, DELETE, SELECT
- Jointures (INNER, LEFT, RIGHT, FULL)
- GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET
- Fonctions PostgreSQL (100+ fonctions)
- Vues système (pg_tables, pg_stat_activity, etc.)
- Interface psql avec méta-commandes

Fonctionnalités non simulées:
- Stockage persistant (les données sont en mémoire)
- PL/pgSQL (procédures stockées, fonctions)
- Déclencheurs (triggers)
- Vues matérialisées
- Partitionnement
- Réplication

## Dépannage

### "psql: command not found"

Le package PostgreSQL n'est pas installé:
```bash
apt install postgresql-14
```

### Erreurs de syntaxe

- Les commandes SQL se terminent par `;`
- Les méta-commandes (`\d`, `\dt`, etc.) n'ont pas de `;`
- PostgreSQL est sensible à la casse pour les identifiants entre guillemets

### Afficher les erreurs détaillées

```
\set VERBOSITY verbose
```
