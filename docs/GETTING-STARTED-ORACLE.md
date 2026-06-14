# Getting Started — Oracle Database dans Ubuntu Sandbox

Guide express (10 minutes) pour démarrer avec la simulation Oracle.
Pour le cours complet (architecture, PL/SQL, RMAN, diagnostic), voir
[tutoriel-oracle.md](./tutoriel-oracle.md).

## 1. Préparer le lab

Dans le designer, glisse un **Linux Server** sur le canvas — c'est le seul
type de machine qui embarque Oracle 19c. Ouvre son terminal (double-clic).

La première exécution de `sqlplus` provisionne tout, comme une vraie
installation : l'arborescence `/u01` (détenue par `oracle:oinstall`),
l'utilisateur OS `oracle` et les groupes `oinstall`/`dba`, l'instance
`ORCL` démarrée, le listener TNS, et les schémas de démo HR/SCOTT.

```bash
ls -l /u01/app/oracle/oradata/ORCL/     # datafiles, redo, control files
id oracle                               # uid=54321(oracle) ... oinstall, dba
cat /etc/oratab
```

## 2. Se connecter

```bash
sqlplus / as sysdba
```

La connexion « bequeath » est gardée par l'appartenance au groupe OS
`dba`, comme en vrai. Les comptes du lab (root, alice, bob, carl, dave)
sont enrôlés ; un compte fraîchement créé reçoit `ORA-01031`:

```bash
useradd -m eve && su - eve
sqlplus / as sysdba        # ERROR: ORA-01031: insufficient privileges
exit
usermod -aG dba eve        # et eve devient DBA
```

Connexion par mot de passe (comptes pré-créés : `system/oracle`,
`scott/tiger`) :

```bash
sqlplus system/oracle
```

## 3. Premier tour en SQL

```sql
SELECT table_name FROM user_tables;
SELECT ename, sal FROM scott.emp WHERE deptno = 10;
CREATE TABLE clients (id NUMBER PRIMARY KEY, nom VARCHAR2(40));
INSERT INTO clients VALUES (1, 'Mandeng');
COMMIT;
SHOW USER
EXIT
```

## 4. L'instance vue depuis l'OS

Tout est cohérent entre Oracle et le Linux qui l'héberge :

```bash
ps aux | grep ora_          # pmon, smon, lgwr, dbw0, ckpt...
ps aux | grep tnslsnr       # le daemon du listener
netstat -tlnp | grep 1521   # le port TNS, tenu par tnslsnr
systemctl status oracle-database-ORCL
```

Arrêter le listener libère réellement le port et tue le processus :

```bash
lsnrctl stop
netstat -tlnp | grep 1521   # plus rien
tnsping ORCL                # TNS-12541: TNS:no listener
lsnrctl start
```

`systemctl stop oracle-database-ORCL` arrête vraiment l'instance
(et inversement, `SHUTDOWN` dans SQL*Plus passe le service à inactive).

## 5. Accès distant à travers le réseau

Câble un second Linux Server (ou PC) sur le même switch, configure les IP
dans le panneau Propriétés (ex. client en `10.0.0.1`, serveur DB en
`10.0.0.2`), puis depuis le client :

```bash
tnsping //10.0.0.2:1521/ORCL
sqlplus system/oracle@//10.0.0.2/ORCL
```

La résolution suit la vraie échelle d'erreurs : alias absent du
`tnsnames.ora` → `ORA-12154`, hôte inconnu → `ORA-12545`, listener
distant arrêté → `ORA-12541`, mauvais service → `ORA-12514`.

Tu peux aussi déclarer un alias dans
`$ORACLE_HOME/network/admin/tnsnames.ora` (édite-le au `vi`) et te
connecter avec `sqlplus system/oracle@MONALIAS`.

## 6. Database links

Depuis la base locale, interroge une base distante :

```sql
CREATE DATABASE LINK fardb
  CONNECT TO system IDENTIFIED BY oracle
  USING '//10.0.0.2/ORCL';

SELECT * FROM emp@fardb;
SELECT owner, db_link, host FROM dba_db_links;
```

## 7. Vues matérialisées

```sql
CREATE MATERIALIZED VIEW mv_paie
  BUILD IMMEDIATE REFRESH COMPLETE ON COMMIT
  AS SELECT deptno, SUM(sal) AS total FROM scott.emp GROUP BY deptno;

UPDATE scott.emp SET sal = sal + 100 WHERE deptno = 10;
SELECT staleness FROM dba_mviews WHERE mview_name = 'MV_PAIE';  -- STALE
COMMIT;                                                          -- refresh auto
SELECT staleness FROM dba_mviews WHERE mview_name = 'MV_PAIE';  -- FRESH
```

Avec `ON DEMAND`, le rafraîchissement se fait par
`EXEC DBMS_MVIEW.REFRESH('MV_PAIE')`.

## 8. Pour aller plus loin

| Sujet | Outil / commande | Référence |
|---|---|---|
| Sauvegarde / restauration | `rman target /` | [tuto_rman.md](./tuto_rman.md) |
| Export / import | `expdp`, `impdp` | tutoriel complet §15 |
| Alert log | `adrci`, `tail -f .../alert_ORCL.log` | tutoriel complet §13 |
| Arrêt/démarrage fin | `STARTUP NOMOUNT/MOUNT/OPEN`, `SHUTDOWN IMMEDIATE` | tutoriel complet §8 |
| Casser pour apprendre | `rm` un datafile puis `STARTUP` → `ORA-01157` | tutoriel complet §16 |

Bon lab !
