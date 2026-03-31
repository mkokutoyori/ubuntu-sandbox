/**
 * DemoSchemas — Pre-built HR and SCOTT schemas with sample data.
 *
 * These are the classic Oracle demo schemas used for learning and testing.
 * Call installHRSchema() and/or installSCOTTSchema() after database startup.
 */

import type { OracleDatabase } from '../OracleDatabase';
import type { OracleExecutor } from '../OracleExecutor';
import { installFcubsliveSchema } from './fcubslive';

/**
 * Install the HR (Human Resources) demo schema.
 * Tables: REGIONS, COUNTRIES, LOCATIONS, DEPARTMENTS, JOBS, EMPLOYEES, JOB_HISTORY
 */
export function installHRSchema(db: OracleDatabase): void {
  const { executor } = db.connectAsSysdba();

  // Ensure HR schema exists
  db.storage.ensureSchema('HR');

  const ddl = [
    // REGIONS
    `CREATE TABLE HR.REGIONS (
       REGION_ID NUMBER(2) NOT NULL,
       REGION_NAME VARCHAR2(25)
     )`,
    // COUNTRIES
    `CREATE TABLE HR.COUNTRIES (
       COUNTRY_ID CHAR(2) NOT NULL,
       COUNTRY_NAME VARCHAR2(40),
       REGION_ID NUMBER(2)
     )`,
    // LOCATIONS
    `CREATE TABLE HR.LOCATIONS (
       LOCATION_ID NUMBER(4) NOT NULL,
       STREET_ADDRESS VARCHAR2(40),
       POSTAL_CODE VARCHAR2(12),
       CITY VARCHAR2(30) NOT NULL,
       STATE_PROVINCE VARCHAR2(25),
       COUNTRY_ID CHAR(2)
     )`,
    // DEPARTMENTS
    `CREATE TABLE HR.DEPARTMENTS (
       DEPARTMENT_ID NUMBER(4) NOT NULL,
       DEPARTMENT_NAME VARCHAR2(30) NOT NULL,
       MANAGER_ID NUMBER(6),
       LOCATION_ID NUMBER(4)
     )`,
    // JOBS
    `CREATE TABLE HR.JOBS (
       JOB_ID VARCHAR2(10) NOT NULL,
       JOB_TITLE VARCHAR2(35) NOT NULL,
       MIN_SALARY NUMBER(6),
       MAX_SALARY NUMBER(6)
     )`,
    // EMPLOYEES
    `CREATE TABLE HR.EMPLOYEES (
       EMPLOYEE_ID NUMBER(6) NOT NULL,
       FIRST_NAME VARCHAR2(20),
       LAST_NAME VARCHAR2(25) NOT NULL,
       EMAIL VARCHAR2(25) NOT NULL,
       PHONE_NUMBER VARCHAR2(20),
       HIRE_DATE DATE NOT NULL,
       JOB_ID VARCHAR2(10) NOT NULL,
       SALARY NUMBER(8,2),
       COMMISSION_PCT NUMBER(2,2),
       MANAGER_ID NUMBER(6),
       DEPARTMENT_ID NUMBER(4)
     )`,
    // JOB_HISTORY
    `CREATE TABLE HR.JOB_HISTORY (
       EMPLOYEE_ID NUMBER(6) NOT NULL,
       START_DATE DATE NOT NULL,
       END_DATE DATE NOT NULL,
       JOB_ID VARCHAR2(10) NOT NULL,
       DEPARTMENT_ID NUMBER(4)
     )`,
  ];

  for (const sql of ddl) {
    db.executeSql(executor, sql);
  }

  // ── Insert data ──────────────────────────────────────────────────

  const inserts = [
    // REGIONS
    `INSERT INTO HR.REGIONS VALUES (1, 'Europe')`,
    `INSERT INTO HR.REGIONS VALUES (2, 'Americas')`,
    `INSERT INTO HR.REGIONS VALUES (3, 'Asia')`,
    `INSERT INTO HR.REGIONS VALUES (4, 'Middle East and Africa')`,

    // COUNTRIES (subset)
    `INSERT INTO HR.COUNTRIES VALUES ('US', 'United States of America', 2)`,
    `INSERT INTO HR.COUNTRIES VALUES ('CA', 'Canada', 2)`,
    `INSERT INTO HR.COUNTRIES VALUES ('UK', 'United Kingdom', 1)`,
    `INSERT INTO HR.COUNTRIES VALUES ('DE', 'Germany', 1)`,
    `INSERT INTO HR.COUNTRIES VALUES ('FR', 'France', 1)`,
    `INSERT INTO HR.COUNTRIES VALUES ('JP', 'Japan', 3)`,
    `INSERT INTO HR.COUNTRIES VALUES ('CN', 'China', 3)`,
    `INSERT INTO HR.COUNTRIES VALUES ('IN', 'India', 3)`,
    `INSERT INTO HR.COUNTRIES VALUES ('BR', 'Brazil', 2)`,
    `INSERT INTO HR.COUNTRIES VALUES ('MX', 'Mexico', 2)`,

    // LOCATIONS
    `INSERT INTO HR.LOCATIONS VALUES (1000, '1297 Via Cola di Rie', '00989', 'Roma', NULL, 'IT')`,
    `INSERT INTO HR.LOCATIONS VALUES (1100, '93091 Calle della Testa', '10934', 'Venice', NULL, 'IT')`,
    `INSERT INTO HR.LOCATIONS VALUES (1200, '2017 Shinjuku-ku', '1689', 'Tokyo', 'Tokyo Prefecture', 'JP')`,
    `INSERT INTO HR.LOCATIONS VALUES (1400, '2014 Jabberwocky Rd', '26192', 'Southlake', 'Texas', 'US')`,
    `INSERT INTO HR.LOCATIONS VALUES (1500, '2011 Interiors Blvd', '99236', 'South San Francisco', 'California', 'US')`,
    `INSERT INTO HR.LOCATIONS VALUES (1700, '2004 Charade Rd', '98199', 'Seattle', 'Washington', 'US')`,
    `INSERT INTO HR.LOCATIONS VALUES (1800, '460 Bloor St. W.', 'ON M5S 1X8', 'Toronto', 'Ontario', 'CA')`,
    `INSERT INTO HR.LOCATIONS VALUES (2400, '8204 Arthur St', NULL, 'London', NULL, 'UK')`,

    // DEPARTMENTS
    `INSERT INTO HR.DEPARTMENTS VALUES (10, 'Administration', 200, 1700)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (20, 'Marketing', 201, 1800)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (30, 'Purchasing', 114, 1700)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (40, 'Human Resources', 203, 2400)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (50, 'Shipping', 121, 1500)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (60, 'IT', 103, 1400)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (70, 'Public Relations', 204, 2400)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (80, 'Sales', 145, 2400)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (90, 'Executive', 100, 1700)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (100, 'Finance', 108, 1700)`,
    `INSERT INTO HR.DEPARTMENTS VALUES (110, 'Accounting', 205, 1700)`,

    // JOBS
    `INSERT INTO HR.JOBS VALUES ('AD_PRES', 'President', 20080, 40000)`,
    `INSERT INTO HR.JOBS VALUES ('AD_VP', 'Administration Vice President', 15000, 30000)`,
    `INSERT INTO HR.JOBS VALUES ('AD_ASST', 'Administration Assistant', 3000, 6000)`,
    `INSERT INTO HR.JOBS VALUES ('FI_MGR', 'Finance Manager', 8200, 16000)`,
    `INSERT INTO HR.JOBS VALUES ('FI_ACCOUNT', 'Accountant', 4200, 9000)`,
    `INSERT INTO HR.JOBS VALUES ('AC_MGR', 'Accounting Manager', 8200, 16000)`,
    `INSERT INTO HR.JOBS VALUES ('AC_ACCOUNT', 'Public Accountant', 4200, 9000)`,
    `INSERT INTO HR.JOBS VALUES ('SA_MAN', 'Sales Manager', 10000, 20080)`,
    `INSERT INTO HR.JOBS VALUES ('SA_REP', 'Sales Representative', 6000, 12008)`,
    `INSERT INTO HR.JOBS VALUES ('PU_MAN', 'Purchasing Manager', 8000, 15000)`,
    `INSERT INTO HR.JOBS VALUES ('PU_CLERK', 'Purchasing Clerk', 2500, 5500)`,
    `INSERT INTO HR.JOBS VALUES ('ST_MAN', 'Stock Manager', 5500, 8500)`,
    `INSERT INTO HR.JOBS VALUES ('ST_CLERK', 'Stock Clerk', 2008, 5000)`,
    `INSERT INTO HR.JOBS VALUES ('SH_CLERK', 'Shipping Clerk', 2500, 5500)`,
    `INSERT INTO HR.JOBS VALUES ('IT_PROG', 'Programmer', 4000, 10000)`,
    `INSERT INTO HR.JOBS VALUES ('MK_MAN', 'Marketing Manager', 9000, 15000)`,
    `INSERT INTO HR.JOBS VALUES ('MK_REP', 'Marketing Representative', 4000, 9000)`,
    `INSERT INTO HR.JOBS VALUES ('HR_REP', 'Human Resources Representative', 4000, 9000)`,
    `INSERT INTO HR.JOBS VALUES ('PR_REP', 'Public Relations Representative', 4500, 10500)`,

    // EMPLOYEES (representative subset — 20 employees)
    `INSERT INTO HR.EMPLOYEES VALUES (100, 'Steven', 'King', 'SKING', '515.123.4567', DATE '2003-06-17', 'AD_PRES', 24000, NULL, NULL, 90)`,
    `INSERT INTO HR.EMPLOYEES VALUES (101, 'Neena', 'Kochhar', 'NKOCHHAR', '515.123.4568', DATE '2005-09-21', 'AD_VP', 17000, NULL, 100, 90)`,
    `INSERT INTO HR.EMPLOYEES VALUES (102, 'Lex', 'De Haan', 'LDEHAAN', '515.123.4569', DATE '2001-01-13', 'AD_VP', 17000, NULL, 100, 90)`,
    `INSERT INTO HR.EMPLOYEES VALUES (103, 'Alexander', 'Hunold', 'AHUNOLD', '590.423.4567', DATE '2006-01-03', 'IT_PROG', 9000, NULL, 102, 60)`,
    `INSERT INTO HR.EMPLOYEES VALUES (104, 'Bruce', 'Ernst', 'BERNST', '590.423.4568', DATE '2007-05-21', 'IT_PROG', 6000, NULL, 103, 60)`,
    `INSERT INTO HR.EMPLOYEES VALUES (105, 'David', 'Austin', 'DAUSTIN', '590.423.4569', DATE '2005-06-25', 'IT_PROG', 4800, NULL, 103, 60)`,
    `INSERT INTO HR.EMPLOYEES VALUES (107, 'Diana', 'Lorentz', 'DLORENTZ', '590.423.5567', DATE '2007-02-07', 'IT_PROG', 4200, NULL, 103, 60)`,
    `INSERT INTO HR.EMPLOYEES VALUES (108, 'Nancy', 'Greenberg', 'NGREENBE', '515.124.4569', DATE '2002-08-17', 'FI_MGR', 12008, NULL, 101, 100)`,
    `INSERT INTO HR.EMPLOYEES VALUES (109, 'Daniel', 'Faviet', 'DFAVIET', '515.124.4169', DATE '2002-08-16', 'FI_ACCOUNT', 9000, NULL, 108, 100)`,
    `INSERT INTO HR.EMPLOYEES VALUES (110, 'John', 'Chen', 'JCHEN', '515.124.4269', DATE '2005-09-28', 'FI_ACCOUNT', 8200, NULL, 108, 100)`,
    `INSERT INTO HR.EMPLOYEES VALUES (114, 'Den', 'Raphaely', 'DRAPHEAL', '515.127.4561', DATE '2002-12-07', 'PU_MAN', 11000, NULL, 100, 30)`,
    `INSERT INTO HR.EMPLOYEES VALUES (115, 'Alexander', 'Khoo', 'AKHOO', '515.127.4562', DATE '2003-05-18', 'PU_CLERK', 3100, NULL, 114, 30)`,
    `INSERT INTO HR.EMPLOYEES VALUES (120, 'Matthew', 'Weiss', 'MWEISS', '650.123.1234', DATE '2004-07-18', 'ST_MAN', 8000, NULL, 100, 50)`,
    `INSERT INTO HR.EMPLOYEES VALUES (121, 'Adam', 'Fripp', 'AFRIPP', '650.123.2234', DATE '2005-04-10', 'ST_MAN', 8200, NULL, 100, 50)`,
    `INSERT INTO HR.EMPLOYEES VALUES (145, 'John', 'Russell', 'JRUSSEL', '011.44.1344.429268', DATE '2004-10-01', 'SA_MAN', 14000, 0.40, 100, 80)`,
    `INSERT INTO HR.EMPLOYEES VALUES (146, 'Karen', 'Partners', 'KPARTNER', '011.44.1344.467268', DATE '2005-01-05', 'SA_MAN', 13500, 0.30, 100, 80)`,
    `INSERT INTO HR.EMPLOYEES VALUES (176, 'Jonathon', 'Taylor', 'JTAYLOR', '011.44.1644.429265', DATE '2006-03-24', 'SA_REP', 8600, 0.20, 145, 80)`,
    `INSERT INTO HR.EMPLOYEES VALUES (200, 'Jennifer', 'Whalen', 'JWHALEN', '515.123.4444', DATE '2003-09-17', 'AD_ASST', 4400, NULL, 101, 10)`,
    `INSERT INTO HR.EMPLOYEES VALUES (201, 'Michael', 'Hartstein', 'MHARTSTE', '515.123.5555', DATE '2004-02-17', 'MK_MAN', 13000, NULL, 100, 20)`,
    `INSERT INTO HR.EMPLOYEES VALUES (205, 'Shelley', 'Higgins', 'SHIGGINS', '515.123.8080', DATE '2002-06-07', 'AC_MGR', 12008, NULL, 101, 110)`,

    // JOB_HISTORY
    `INSERT INTO HR.JOB_HISTORY VALUES (102, DATE '2001-01-13', DATE '2006-07-24', 'IT_PROG', 60)`,
    `INSERT INTO HR.JOB_HISTORY VALUES (101, DATE '2001-10-28', DATE '2005-03-15', 'AC_ACCOUNT', 110)`,
    `INSERT INTO HR.JOB_HISTORY VALUES (101, DATE '2005-03-15', DATE '2005-09-21', 'AC_MGR', 110)`,
    `INSERT INTO HR.JOB_HISTORY VALUES (200, DATE '2002-07-01', DATE '2006-12-31', 'AD_ASST', 90)`,
    `INSERT INTO HR.JOB_HISTORY VALUES (176, DATE '2006-03-24', DATE '2006-12-31', 'SA_REP', 80)`,
  ];

  for (const sql of inserts) {
    db.executeSql(executor, sql);
  }

  // Create sequences
  db.executeSql(executor, `CREATE SEQUENCE HR.EMPLOYEES_SEQ START WITH 207 INCREMENT BY 1`);
  db.executeSql(executor, `CREATE SEQUENCE HR.DEPARTMENTS_SEQ START WITH 280 INCREMENT BY 10`);
  db.executeSql(executor, `CREATE SEQUENCE HR.LOCATIONS_SEQ START WITH 3300 INCREMENT BY 100`);
}

/**
 * Install the SCOTT demo schema (classic EMP/DEPT).
 */
export function installSCOTTSchema(db: OracleDatabase): void {
  const { executor } = db.connectAsSysdba();

  db.storage.ensureSchema('SCOTT');

  const ddl = [
    // DEPT
    `CREATE TABLE SCOTT.DEPT (
       DEPTNO NUMBER(2) NOT NULL,
       DNAME VARCHAR2(14),
       LOC VARCHAR2(13)
     )`,
    // EMP
    `CREATE TABLE SCOTT.EMP (
       EMPNO NUMBER(4) NOT NULL,
       ENAME VARCHAR2(10),
       JOB VARCHAR2(9),
       MGR NUMBER(4),
       HIREDATE DATE,
       SAL NUMBER(7,2),
       COMM NUMBER(7,2),
       DEPTNO NUMBER(2)
     )`,
    // BONUS
    `CREATE TABLE SCOTT.BONUS (
       ENAME VARCHAR2(10),
       JOB VARCHAR2(9),
       SAL NUMBER,
       COMM NUMBER
     )`,
    // SALGRADE
    `CREATE TABLE SCOTT.SALGRADE (
       GRADE NUMBER,
       LOSAL NUMBER,
       HISAL NUMBER
     )`,
  ];

  for (const sql of ddl) {
    db.executeSql(executor, sql);
  }

  const inserts = [
    // DEPT
    `INSERT INTO SCOTT.DEPT VALUES (10, 'ACCOUNTING', 'NEW YORK')`,
    `INSERT INTO SCOTT.DEPT VALUES (20, 'RESEARCH', 'DALLAS')`,
    `INSERT INTO SCOTT.DEPT VALUES (30, 'SALES', 'CHICAGO')`,
    `INSERT INTO SCOTT.DEPT VALUES (40, 'OPERATIONS', 'BOSTON')`,

    // EMP
    `INSERT INTO SCOTT.EMP VALUES (7369, 'SMITH', 'CLERK', 7902, DATE '1980-12-17', 800, NULL, 20)`,
    `INSERT INTO SCOTT.EMP VALUES (7499, 'ALLEN', 'SALESMAN', 7698, DATE '1981-02-20', 1600, 300, 30)`,
    `INSERT INTO SCOTT.EMP VALUES (7521, 'WARD', 'SALESMAN', 7698, DATE '1981-02-22', 1250, 500, 30)`,
    `INSERT INTO SCOTT.EMP VALUES (7566, 'JONES', 'MANAGER', 7839, DATE '1981-04-02', 2975, NULL, 20)`,
    `INSERT INTO SCOTT.EMP VALUES (7654, 'MARTIN', 'SALESMAN', 7698, DATE '1981-09-28', 1250, 1400, 30)`,
    `INSERT INTO SCOTT.EMP VALUES (7698, 'BLAKE', 'MANAGER', 7839, DATE '1981-05-01', 2850, NULL, 30)`,
    `INSERT INTO SCOTT.EMP VALUES (7782, 'CLARK', 'MANAGER', 7839, DATE '1981-06-09', 2450, NULL, 10)`,
    `INSERT INTO SCOTT.EMP VALUES (7788, 'SCOTT', 'ANALYST', 7566, DATE '1987-04-19', 3000, NULL, 20)`,
    `INSERT INTO SCOTT.EMP VALUES (7839, 'KING', 'PRESIDENT', NULL, DATE '1981-11-17', 5000, NULL, 10)`,
    `INSERT INTO SCOTT.EMP VALUES (7844, 'TURNER', 'SALESMAN', 7698, DATE '1981-09-08', 1500, 0, 30)`,
    `INSERT INTO SCOTT.EMP VALUES (7876, 'ADAMS', 'CLERK', 7788, DATE '1987-05-23', 1100, NULL, 20)`,
    `INSERT INTO SCOTT.EMP VALUES (7900, 'JAMES', 'CLERK', 7698, DATE '1981-12-03', 950, NULL, 30)`,
    `INSERT INTO SCOTT.EMP VALUES (7902, 'FORD', 'ANALYST', 7566, DATE '1981-12-03', 3000, NULL, 20)`,
    `INSERT INTO SCOTT.EMP VALUES (7934, 'MILLER', 'CLERK', 7782, DATE '1982-01-23', 1300, NULL, 10)`,

    // SALGRADE
    `INSERT INTO SCOTT.SALGRADE VALUES (1, 700, 1200)`,
    `INSERT INTO SCOTT.SALGRADE VALUES (2, 1201, 1400)`,
    `INSERT INTO SCOTT.SALGRADE VALUES (3, 1401, 2000)`,
    `INSERT INTO SCOTT.SALGRADE VALUES (4, 2001, 3000)`,
    `INSERT INTO SCOTT.SALGRADE VALUES (5, 3001, 9999)`,
  ];

  for (const sql of inserts) {
    db.executeSql(executor, sql);
  }
}

/**
 * Install all demo schemas.
 */
export function installAllDemoSchemas(db: OracleDatabase): void {
  installHRSchema(db);
  installSCOTTSchema(db);
  installFcubsliveSchema(db);
}

// Re-export for direct access
export { installFcubsliveSchema } from './fcubslive';
