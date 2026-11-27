import { ORACLE } from './plan';

export const SCRIPT_DIR = '/home/oracle/scripts';

export const SCHEMA_SCRIPT = [
  'SET ECHO OFF',
  'CREATE TABLESPACE shop_data DATAFILE SIZE 200M;',
  'CREATE TABLESPACE shop_idx DATAFILE SIZE 100M;',
  `CREATE USER ${ORACLE.appUser} IDENTIFIED BY "${ORACLE.appPassword}" DEFAULT TABLESPACE shop_data QUOTA UNLIMITED ON shop_data QUOTA UNLIMITED ON shop_idx;`,
  `GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE, CREATE VIEW TO ${ORACLE.appUser};`,
  `CREATE TABLE ${ORACLE.appUser}.customers (customer_id NUMBER PRIMARY KEY, email VARCHAR2(80) NOT NULL, full_name VARCHAR2(80) NOT NULL, city VARCHAR2(40), created_at DATE) TABLESPACE shop_data;`,
  `CREATE TABLE ${ORACLE.appUser}.products (product_id NUMBER PRIMARY KEY, sku VARCHAR2(20) NOT NULL, name VARCHAR2(80) NOT NULL, price NUMBER(10,2) NOT NULL, stock NUMBER NOT NULL) TABLESPACE shop_data;`,
  `CREATE TABLE ${ORACLE.appUser}.orders (order_id NUMBER PRIMARY KEY, customer_id NUMBER NOT NULL REFERENCES ${ORACLE.appUser}.customers (customer_id), order_date DATE, status VARCHAR2(12), total NUMBER(12,2)) TABLESPACE shop_data;`,
  `CREATE TABLE ${ORACLE.appUser}.order_items (order_id NUMBER NOT NULL REFERENCES ${ORACLE.appUser}.orders (order_id), line_no NUMBER NOT NULL, product_id NUMBER NOT NULL REFERENCES ${ORACLE.appUser}.products (product_id), quantity NUMBER NOT NULL, unit_price NUMBER(10,2) NOT NULL) TABLESPACE shop_data;`,
  `CREATE TABLE ${ORACLE.appUser}.payments (payment_id NUMBER PRIMARY KEY, order_id NUMBER NOT NULL REFERENCES ${ORACLE.appUser}.orders (order_id), amount NUMBER(12,2) NOT NULL, method VARCHAR2(12), paid_at DATE) TABLESPACE shop_data;`,
  `CREATE INDEX ${ORACLE.appUser}.orders_customer_ix ON ${ORACLE.appUser}.orders (customer_id) TABLESPACE shop_idx;`,
  'EXIT',
].join('\n');

const CUSTOMERS: readonly (readonly [number, string, string, string])[] = [
  [1, 'awa.ndiaye@example.com', 'Awa Ndiaye', 'Douala'],
  [2, 'paul.mbarga@example.com', 'Paul Mbarga', 'Yaounde'],
  [3, 'lea.dupont@example.com', 'Lea Dupont', 'Paris'],
  [4, 'karim.benali@example.com', 'Karim Benali', 'Lyon'],
  [5, 'sofia.rossi@example.com', 'Sofia Rossi', 'Marseille'],
  [6, 'tom.martin@example.com', 'Tom Martin', 'Lille'],
];

const PRODUCTS: readonly (readonly [number, string, string, number, number])[] = [
  [1, 'LAMP-001', 'Lampe de bureau Aurore', 39.9, 120],
  [2, 'LAMP-002', 'Suspension Lumiere', 89, 45],
  [3, 'BULB-010', 'Ampoule LED E27 (lot de 4)', 12.5, 500],
  [4, 'CAND-005', 'Bougie parfumee Vanille', 18, 260],
  [5, 'SHAD-020', 'Abat-jour lin naturel', 24.9, 90],
  [6, 'SWCH-003', 'Variateur connecte', 49, 75],
];

export const SEED_SCRIPT = [
  'SET ECHO OFF',
  ...CUSTOMERS.map(([id, email, name, city]) =>
    `INSERT INTO ${ORACLE.appUser}.customers VALUES (${id}, '${email}', '${name}', '${city}', SYSDATE);`),
  ...PRODUCTS.map(([id, sku, name, price, stock]) =>
    `INSERT INTO ${ORACLE.appUser}.products VALUES (${id}, '${sku}', '${name}', ${price}, ${stock});`),
  ...Array.from({ length: 12 }, (_, index) => {
    const orderId = 1000 + index + 1;
    const customer = (index % CUSTOMERS.length) + 1;
    const product = (index % PRODUCTS.length) + 1;
    const quantity = (index % 3) + 1;
    const price = PRODUCTS[product - 1][3];
    const total = Math.round(price * quantity * 100) / 100;
    const status = index % 4 === 3 ? 'SHIPPED' : index % 4 === 2 ? 'PAID' : 'NEW';
    return [
      `INSERT INTO ${ORACLE.appUser}.orders VALUES (${orderId}, ${customer}, SYSDATE, '${status}', ${total});`,
      `INSERT INTO ${ORACLE.appUser}.order_items VALUES (${orderId}, 1, ${product}, ${quantity}, ${price});`,
      ...(status === 'NEW' ? [] : [`INSERT INTO ${ORACLE.appUser}.payments VALUES (${5000 + index}, ${orderId}, ${total}, 'CARD', SYSDATE);`]),
    ];
  }).flat(),
  'COMMIT;',
  'EXIT',
].join('\n');

export const ARCHIVELOG_SCRIPT = [
  'SHUTDOWN IMMEDIATE',
  'STARTUP MOUNT',
  'ALTER DATABASE ARCHIVELOG;',
  'ALTER DATABASE FORCE LOGGING;',
  'ALTER DATABASE OPEN;',
  'ARCHIVE LOG LIST',
  'EXIT',
].join('\n');

export const HEALTH_SCRIPT = [
  'SET PAGESIZE 100 LINESIZE 150',
  'SELECT name, log_mode, force_logging, open_mode FROM v$database;',
  'SELECT tablespace_name, status FROM dba_tablespaces ORDER BY 1;',
  `SELECT COUNT(*) AS commandes FROM ${ORACLE.appUser}.orders;`,
  `SELECT status, COUNT(*) AS nb, SUM(total) AS montant FROM ${ORACLE.appUser}.orders GROUP BY status ORDER BY status;`,
  'EXIT',
].join('\n');
