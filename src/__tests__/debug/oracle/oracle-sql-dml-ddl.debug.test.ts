/**
 * Debug — SQL DML & DDL Oracle.
 *
 * CREATE/ALTER/DROP TABLE, indexes, vues, séquences, contraintes,
 * INSERT/UPDATE/DELETE/MERGE, transactions, savepoints, isolation,
 * subqueries, joins, set operators, analytic functions.
 */

import { describe, it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { removeOracleDatabase, getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, runOracleDump, type OracleDebugLine } from './_oracle-dump';
import { monitoringSweep } from './_padding';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('debug — Oracle SQL DML & DDL', () => {
  it('parcourt CREATE / ALTER / DROP + INSERT / UPDATE / DELETE / MERGE + subqueries + joins', () => {
    const srv = new LinuxServer('linux-server', 'ora-sql', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. setup schema ──────────────────────────────────────────
      { section: 'setup schema', cmd: 'CREATE USER demo IDENTIFIED BY "Demo1#" QUOTA UNLIMITED ON users;' },
      'GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE, CREATE SYNONYM, UNLIMITED TABLESPACE TO demo;',
      'ALTER SESSION SET CURRENT_SCHEMA = demo;',

      // ── 2. CREATE TABLE — every flavour ─────────────────────────
      { section: 'CREATE TABLE basic', cmd:
        'CREATE TABLE customers (id NUMBER PRIMARY KEY, name VARCHAR2(100) NOT NULL, email VARCHAR2(200) UNIQUE, created DATE DEFAULT SYSDATE);' },
      "CREATE TABLE products (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code VARCHAR2(20) UNIQUE NOT NULL, name VARCHAR2(200) NOT NULL, price NUMBER(10,2) CHECK (price >= 0), stock INTEGER DEFAULT 0, active CHAR(1) DEFAULT 'Y' CHECK (active IN ('Y','N')), created TIMESTAMP DEFAULT SYSTIMESTAMP);",
      "CREATE TABLE orders (id NUMBER PRIMARY KEY, customer_id NUMBER NOT NULL, order_date DATE DEFAULT SYSDATE, status VARCHAR2(20) DEFAULT 'PENDING', total NUMBER(12,2) DEFAULT 0, CONSTRAINT fk_orders_cust FOREIGN KEY (customer_id) REFERENCES customers(id));",
      "CREATE TABLE order_lines (order_id NUMBER, line_no NUMBER, product_id NUMBER, qty NUMBER NOT NULL CHECK (qty > 0), unit_price NUMBER(10,2) NOT NULL, CONSTRAINT pk_ol PRIMARY KEY (order_id, line_no), CONSTRAINT fk_ol_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE, CONSTRAINT fk_ol_prod FOREIGN KEY (product_id) REFERENCES products(id));",
      'CREATE TABLE staging AS SELECT * FROM customers WHERE 1=0;',
      "CREATE TABLE backup_customers AS SELECT * FROM customers;",
      "CREATE GLOBAL TEMPORARY TABLE tmp_session (id NUMBER, payload VARCHAR2(4000)) ON COMMIT PRESERVE ROWS;",
      "CREATE GLOBAL TEMPORARY TABLE tmp_txn (id NUMBER) ON COMMIT DELETE ROWS;",
      "CREATE PRIVATE TEMPORARY TABLE ora$ptt_session (id NUMBER) ON COMMIT PRESERVE DEFINITION;",
      // partitioning
      'CREATE TABLE sales (id NUMBER, sale_date DATE, region VARCHAR2(50), amount NUMBER(12,2)) PARTITION BY RANGE (sale_date) (PARTITION p2023 VALUES LESS THAN (DATE \'2024-01-01\'), PARTITION p2024 VALUES LESS THAN (DATE \'2025-01-01\'), PARTITION p2025 VALUES LESS THAN (DATE \'2026-01-01\'), PARTITION p_max VALUES LESS THAN (MAXVALUE));',
      "CREATE TABLE customers_by_country (id NUMBER, name VARCHAR2(100), country VARCHAR2(2)) PARTITION BY LIST (country) (PARTITION p_us VALUES ('US'), PARTITION p_fr VALUES ('FR'), PARTITION p_other VALUES (DEFAULT));",
      'CREATE TABLE customers_hash (id NUMBER, name VARCHAR2(100)) PARTITION BY HASH (id) PARTITIONS 4;',
      // index-organized
      "CREATE TABLE iot_table (id NUMBER PRIMARY KEY, payload VARCHAR2(4000)) ORGANIZATION INDEX;",
      // external
      "CREATE TABLE ext_csv (id NUMBER, name VARCHAR2(100)) ORGANIZATION EXTERNAL (TYPE ORACLE_LOADER DEFAULT DIRECTORY data_dir ACCESS PARAMETERS (RECORDS DELIMITED BY NEWLINE FIELDS TERMINATED BY ',') LOCATION ('data.csv'));",
      // compression
      'CREATE TABLE compressed_t (id NUMBER, payload VARCHAR2(4000)) ROW STORE COMPRESS ADVANCED;',
      'CREATE TABLE compressed_archive (id NUMBER) COMPRESS FOR QUERY HIGH;',

      // ── 3. inspect what we created ───────────────────────────────
      { section: 'inspect schema', cmd: "SELECT table_name, tablespace_name, temporary, partitioned FROM user_tables ORDER BY table_name;" },
      'SELECT COUNT(*) AS user_tables FROM user_tables;',
      "SELECT table_name, column_name, data_type, data_length, nullable, data_default FROM user_tab_columns ORDER BY table_name, column_id;",
      "SELECT * FROM user_constraints WHERE table_name = 'CUSTOMERS';",
      "SELECT * FROM user_constraints WHERE table_name = 'PRODUCTS';",
      "SELECT * FROM user_constraints WHERE table_name = 'ORDERS';",
      "SELECT * FROM user_indexes WHERE table_name IN ('CUSTOMERS','PRODUCTS','ORDERS');",
      'SELECT * FROM user_tab_partitions ORDER BY table_name, partition_position;',

      // ── 4. ALTER TABLE — every modification ─────────────────────
      { section: 'ALTER TABLE', cmd: 'ALTER TABLE customers ADD phone VARCHAR2(30);' },
      'ALTER TABLE customers ADD (address VARCHAR2(200), city VARCHAR2(100));',
      'ALTER TABLE customers MODIFY name VARCHAR2(150) NOT NULL;',
      'ALTER TABLE customers MODIFY email NULL;',
      'ALTER TABLE customers RENAME COLUMN phone TO phone_number;',
      'ALTER TABLE customers DROP COLUMN address;',
      "ALTER TABLE customers DROP (city);",
      'ALTER TABLE customers SET UNUSED COLUMN created;',
      'ALTER TABLE customers DROP UNUSED COLUMNS;',
      'ALTER TABLE products MODIFY active DEFAULT \'A\';',
      'ALTER TABLE orders ADD CONSTRAINT ck_status CHECK (status IN (\'PENDING\',\'PAID\',\'SHIPPED\',\'CANCELLED\'));',
      'ALTER TABLE orders DROP CONSTRAINT ck_status;',
      'ALTER TABLE orders ADD CONSTRAINT uk_orders UNIQUE (id);',
      'ALTER TABLE orders DROP CONSTRAINT uk_orders;',
      'ALTER TABLE orders DISABLE CONSTRAINT fk_orders_cust;',
      'ALTER TABLE orders ENABLE CONSTRAINT fk_orders_cust;',
      'ALTER TABLE orders ENABLE NOVALIDATE CONSTRAINT fk_orders_cust;',
      'ALTER TABLE orders DROP CONSTRAINT fk_orders_cust CASCADE;',
      'ALTER TABLE orders ADD CONSTRAINT fk_orders_cust FOREIGN KEY (customer_id) REFERENCES customers(id);',
      'ALTER TABLE customers RENAME TO clients;',
      'RENAME clients TO customers;',
      'ALTER TABLE products MOVE TABLESPACE users;',
      'ALTER TABLE products SHRINK SPACE;',
      'ALTER TABLE products SHRINK SPACE COMPACT;',
      'ALTER TABLE products SHRINK SPACE CASCADE;',
      'ALTER TABLE customers ENABLE ROW MOVEMENT;',
      'ALTER TABLE customers DISABLE ROW MOVEMENT;',
      'ALTER TABLE customers LOGGING;',
      'ALTER TABLE customers NOLOGGING;',
      'ALTER TABLE customers PCTFREE 20 PCTUSED 50;',
      'ALTER TABLE customers ALLOCATE EXTENT (SIZE 10M);',
      'ALTER TABLE customers DEALLOCATE UNUSED;',
      "ALTER TABLE sales SPLIT PARTITION p_max AT (DATE '2027-01-01') INTO (PARTITION p2026, PARTITION p_max);",
      "ALTER TABLE sales TRUNCATE PARTITION p2023;",
      "ALTER TABLE sales DROP PARTITION p2023;",
      "ALTER TABLE sales ADD PARTITION p2027 VALUES LESS THAN (DATE '2028-01-01');",
      "ALTER TABLE sales MERGE PARTITIONS p2024, p2025 INTO PARTITION p2024_25;",
      'ALTER TABLE products COMPRESS FOR OLTP;',
      'ALTER TABLE products MOVE COMPRESS FOR QUERY HIGH;',
      'ALTER TABLE products NOCOMPRESS;',

      // ── 5. CREATE INDEX ──────────────────────────────────────────
      { section: 'indexes', cmd: 'CREATE INDEX idx_cust_name ON customers (name);' },
      'CREATE UNIQUE INDEX uk_prod_code ON products (code);',
      'CREATE INDEX idx_orders_cust ON orders (customer_id);',
      'CREATE INDEX idx_orders_date ON orders (order_date) ONLINE;',
      'CREATE BITMAP INDEX bx_prod_active ON products (active);',
      'CREATE INDEX idx_func_cust_upper ON customers (UPPER(name));',
      'CREATE INDEX idx_ol_prod ON order_lines (product_id);',
      'CREATE INDEX idx_orders_status_date ON orders (status, order_date);',
      'CREATE INDEX idx_orders_total ON orders (total) COMPRESS;',
      'CREATE INDEX idx_inv_prod ON products (name) INVISIBLE;',
      "CREATE INDEX idx_sales_region ON sales (region) LOCAL;",
      "CREATE INDEX idx_sales_amount ON sales (amount) GLOBAL PARTITION BY HASH (amount) PARTITIONS 4;",
      'ALTER INDEX idx_inv_prod VISIBLE;',
      'ALTER INDEX idx_inv_prod INVISIBLE;',
      'ALTER INDEX idx_inv_prod REBUILD ONLINE;',
      'ALTER INDEX idx_inv_prod REBUILD TABLESPACE users;',
      'ALTER INDEX idx_inv_prod COALESCE;',
      'ALTER INDEX idx_inv_prod MONITORING USAGE;',
      'ALTER INDEX idx_inv_prod NOMONITORING USAGE;',
      'ALTER INDEX idx_inv_prod UNUSABLE;',
      'ALTER INDEX idx_inv_prod REBUILD;',
      'DROP INDEX idx_func_cust_upper;',

      // ── 6. INSERT — variantes ────────────────────────────────────
      { section: 'INSERT', cmd: "INSERT INTO customers (id, name, email) VALUES (1, 'Alice Dupont', 'alice@example.com');" },
      "INSERT INTO customers (id, name, email) VALUES (2, 'Bob Martin', 'bob@example.com');",
      "INSERT INTO customers (id, name, email) VALUES (3, 'Carol Leroy', 'carol@example.com');",
      "INSERT INTO customers (id, name, email) VALUES (4, 'David Smith', 'david@example.com');",
      "INSERT INTO customers (id, name, email) VALUES (5, 'Eve Johnson', NULL);",
      "INSERT INTO customers VALUES (6, 'Frank Brown', 'frank@x.com', SYSDATE, NULL);",
      "INSERT INTO products (code, name, price, stock) VALUES ('SKU-001', 'Widget', 9.99, 100);",
      "INSERT INTO products (code, name, price, stock) VALUES ('SKU-002', 'Gadget', 19.99, 50);",
      "INSERT INTO products (code, name, price, stock) VALUES ('SKU-003', 'Gizmo', 4.99, 200);",
      "INSERT INTO products (code, name, price, stock) VALUES ('SKU-004', 'Thingamajig', 29.99, 30);",
      "INSERT INTO products (code, name, price, stock) VALUES ('SKU-005', 'Doohickey', 14.99, 75);",
      "INSERT INTO orders VALUES (101, 1, SYSDATE, 'PAID', 19.98);",
      "INSERT INTO orders VALUES (102, 2, SYSDATE - 1, 'SHIPPED', 39.98);",
      "INSERT INTO orders VALUES (103, 1, SYSDATE - 2, 'PENDING', 14.99);",
      "INSERT INTO order_lines VALUES (101, 1, 1, 2, 9.99);",
      "INSERT INTO order_lines VALUES (102, 1, 2, 2, 19.99);",
      "INSERT INTO order_lines VALUES (103, 1, 5, 1, 14.99);",
      "INSERT INTO orders SELECT 200 + level, 1, SYSDATE - level, 'PAID', 100 FROM dual CONNECT BY level <= 10;",
      "INSERT INTO sales VALUES (1, DATE '2024-06-15', 'EU', 1500);",
      "INSERT INTO sales VALUES (2, DATE '2025-03-20', 'US', 2500);",
      "INSERT INTO sales VALUES (3, DATE '2025-09-10', 'APAC', 1800);",
      // multitable insert
      "INSERT ALL INTO customers (id, name, email) VALUES (id, name, email) INTO staging (id, name, email) VALUES (id, name, email) SELECT 100 + level AS id, 'user_' || level AS name, 'user' || level || '@ex.com' AS email FROM dual CONNECT BY level <= 5;",
      "INSERT FIRST WHEN total > 50 THEN INTO big_orders WHEN total <= 50 THEN INTO small_orders SELECT id, total FROM orders;",
      "INSERT INTO customers (id, name) VALUES (7, 'Grace H');",
      "INSERT INTO customers SELECT 200, 'Henry I', 'h@x.com', SYSDATE, NULL FROM dual;",
      'COMMIT;',

      // ── 7. UPDATE ────────────────────────────────────────────────
      { section: 'UPDATE', cmd: "UPDATE customers SET phone_number = '555-0101' WHERE id = 1;" },
      'UPDATE products SET price = price * 1.05 WHERE active = \'Y\';',
      "UPDATE orders SET status = 'SHIPPED' WHERE order_date < SYSDATE - 5;",
      "UPDATE customers c SET phone_number = (SELECT '555-' || LPAD(id,4,'0') FROM dual);",
      'UPDATE order_lines SET unit_price = unit_price * 1.10;',
      "UPDATE orders SET total = (SELECT NVL(SUM(qty * unit_price), 0) FROM order_lines WHERE order_lines.order_id = orders.id);",
      'UPDATE (SELECT * FROM products WHERE active = \'Y\') SET stock = stock + 10;',
      'UPDATE customers SET name = \'Updated\' WHERE 1=0;',
      'COMMIT;',

      // ── 8. DELETE ────────────────────────────────────────────────
      { section: 'DELETE', cmd: 'DELETE FROM customers WHERE id = 7;' },
      'DELETE FROM products WHERE stock = 0;',
      "DELETE FROM orders WHERE status = 'CANCELLED';",
      'DELETE FROM order_lines WHERE order_id IN (SELECT id FROM orders WHERE status = \'CANCELLED\');',
      'DELETE FROM customers WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.customer_id = customers.id);',
      'TRUNCATE TABLE staging;',
      'TRUNCATE TABLE staging DROP STORAGE;',
      'TRUNCATE TABLE staging REUSE STORAGE;',
      'COMMIT;',

      // ── 9. MERGE ─────────────────────────────────────────────────
      { section: 'MERGE', cmd:
        "MERGE INTO customers c USING (SELECT 1 AS id, 'Alice Updated' AS name, 'alice2@x.com' AS email FROM dual UNION ALL SELECT 999, 'New Customer', 'new@x.com' FROM dual) src ON (c.id = src.id) WHEN MATCHED THEN UPDATE SET c.name = src.name, c.email = src.email WHEN NOT MATCHED THEN INSERT (id, name, email) VALUES (src.id, src.name, src.email);" },
      "MERGE INTO products p USING (SELECT 'SKU-001' AS code, 50 AS new_stock FROM dual) src ON (p.code = src.code) WHEN MATCHED THEN UPDATE SET stock = stock + src.new_stock;",
      "MERGE INTO products p USING (SELECT 'SKU-DELETE' AS code FROM dual) src ON (p.code = src.code) WHEN MATCHED THEN UPDATE SET active = 'N' DELETE WHERE active = 'N';",
      'COMMIT;',

      // ── 10. SELECT — joins, group by, having, order by ──────────
      { section: 'SELECT joins', cmd: 'SELECT * FROM customers ORDER BY id;' },
      'SELECT * FROM customers WHERE id IN (1,2,3);',
      "SELECT * FROM customers WHERE name LIKE 'A%';",
      'SELECT c.name, o.id, o.total FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY o.id;',
      'SELECT c.name, o.id FROM customers c LEFT JOIN orders o ON c.id = o.customer_id;',
      'SELECT c.name, o.id FROM customers c RIGHT JOIN orders o ON c.id = o.customer_id;',
      'SELECT c.name, o.id FROM customers c FULL OUTER JOIN orders o ON c.id = o.customer_id;',
      'SELECT c.name, o.id FROM customers c CROSS JOIN orders o WHERE rownum < 10;',
      'SELECT c.name, o.id FROM customers c, orders o WHERE c.id = o.customer_id;',
      'SELECT c.name, COUNT(o.id) AS orders_count, NVL(SUM(o.total), 0) AS total_spent FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.name ORDER BY total_spent DESC;',
      'SELECT customer_id, COUNT(*), SUM(total) FROM orders GROUP BY customer_id HAVING COUNT(*) > 1;',
      "SELECT customer_id, COUNT(*) FROM orders GROUP BY ROLLUP (customer_id);",
      "SELECT customer_id, status, COUNT(*) FROM orders GROUP BY CUBE (customer_id, status);",
      "SELECT customer_id, status, COUNT(*) FROM orders GROUP BY GROUPING SETS ((customer_id), (status), ());",
      // analytic functions
      'SELECT id, name, ROW_NUMBER() OVER (ORDER BY name) AS rn FROM customers;',
      'SELECT id, total, RANK() OVER (ORDER BY total DESC) AS rk FROM orders;',
      'SELECT id, total, DENSE_RANK() OVER (ORDER BY total DESC) AS drk FROM orders;',
      'SELECT customer_id, id, total, SUM(total) OVER (PARTITION BY customer_id) AS cust_total FROM orders;',
      'SELECT id, total, LAG(total) OVER (ORDER BY id) AS prev_total, LEAD(total) OVER (ORDER BY id) AS next_total FROM orders;',
      "SELECT id, total, NTILE(4) OVER (ORDER BY total) AS quartile FROM orders;",
      "SELECT id, total, AVG(total) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving_avg FROM orders;",
      "SELECT id, total, FIRST_VALUE(total) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS first_total FROM orders;",
      "SELECT id, total, LAST_VALUE(total) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_total FROM orders;",
      "SELECT customer_id, LISTAGG(id, ',') WITHIN GROUP (ORDER BY id) AS order_ids FROM orders GROUP BY customer_id;",
      // subqueries
      'SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE total > 30);',
      'SELECT * FROM customers c WHERE EXISTS (SELECT 1 FROM orders WHERE customer_id = c.id);',
      'SELECT (SELECT name FROM customers WHERE id = o.customer_id) AS name, o.id FROM orders o;',
      'SELECT * FROM (SELECT id, total FROM orders ORDER BY total DESC) WHERE rownum < 5;',
      // CTE / recursive
      'WITH top_orders AS (SELECT * FROM orders ORDER BY total DESC FETCH FIRST 5 ROWS ONLY) SELECT * FROM top_orders;',
      "WITH numbers (n) AS (SELECT 1 FROM dual UNION ALL SELECT n + 1 FROM numbers WHERE n < 10) SELECT * FROM numbers;",
      // set operators
      "SELECT id FROM customers UNION SELECT customer_id FROM orders;",
      "SELECT id FROM customers UNION ALL SELECT customer_id FROM orders;",
      "SELECT id FROM customers INTERSECT SELECT customer_id FROM orders;",
      "SELECT id FROM customers MINUS SELECT customer_id FROM orders;",
      // pivot / unpivot
      "SELECT * FROM (SELECT customer_id, status FROM orders) PIVOT (COUNT(*) FOR status IN ('PAID' AS paid, 'SHIPPED' AS shipped, 'PENDING' AS pending));",
      "SELECT * FROM (SELECT 1 AS id, 100 AS jan, 200 AS feb, 300 AS mar FROM dual) UNPIVOT (amount FOR mn IN (jan, feb, mar));",
      // hierarchical
      "SELECT level, name FROM customers START WITH id = 1 CONNECT BY PRIOR id = id - 1;",
      "SELECT SYS_CONNECT_BY_PATH(name, '/') FROM customers START WITH id = 1 CONNECT BY PRIOR id = id - 1;",
      // analytic + group
      "SELECT customer_id, status, COUNT(*) OVER (PARTITION BY customer_id) FROM orders;",
      "SELECT * FROM orders SAMPLE (50);",
      "SELECT * FROM orders SAMPLE BLOCK (10) SEED (42);",
      // model clause
      "SELECT * FROM orders MODEL DIMENSION BY (id) MEASURES (total) RULES (total[ANY] = total[CV()] * 1.1);",

      // ── 11. VIEWS ────────────────────────────────────────────────
      { section: 'views', cmd: 'CREATE OR REPLACE VIEW v_active_customers AS SELECT id, name, email FROM customers WHERE email IS NOT NULL;' },
      'CREATE OR REPLACE VIEW v_top_orders AS SELECT * FROM orders WHERE total > 30;',
      'CREATE OR REPLACE VIEW v_orders_summary AS SELECT customer_id, COUNT(*) AS cnt, SUM(total) AS tot FROM orders GROUP BY customer_id;',
      'CREATE OR REPLACE FORCE VIEW v_future AS SELECT * FROM not_yet_existing;',
      'CREATE MATERIALIZED VIEW mv_orders_summary BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND AS SELECT customer_id, COUNT(*) AS cnt, SUM(total) AS tot FROM orders GROUP BY customer_id;',
      "EXEC DBMS_MVIEW.REFRESH('mv_orders_summary');",
      "EXEC DBMS_MVIEW.REFRESH('mv_orders_summary', 'C');",
      "EXEC DBMS_MVIEW.REFRESH('mv_orders_summary', 'F');",
      'DROP MATERIALIZED VIEW mv_orders_summary;',
      'SELECT * FROM v_active_customers;',
      'SELECT * FROM v_top_orders;',
      'SELECT * FROM v_orders_summary;',
      'CREATE OR REPLACE VIEW v_complex AS SELECT c.id, c.name, COUNT(o.id) AS num_orders FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.id, c.name;',
      'DROP VIEW v_future;',

      // ── 12. SEQUENCES ────────────────────────────────────────────
      { section: 'sequences', cmd: 'CREATE SEQUENCE seq_customer_id START WITH 1000 INCREMENT BY 1 NOCACHE NOCYCLE;' },
      'CREATE SEQUENCE seq_order_id START WITH 1 CACHE 100;',
      "CREATE SEQUENCE seq_year MINVALUE 2020 MAXVALUE 2099 CYCLE INCREMENT BY 1;",
      'SELECT seq_customer_id.NEXTVAL FROM dual;',
      'SELECT seq_customer_id.NEXTVAL FROM dual;',
      'SELECT seq_customer_id.CURRVAL FROM dual;',
      'INSERT INTO customers (id, name) VALUES (seq_customer_id.NEXTVAL, \'Sequenced User\');',
      'ALTER SEQUENCE seq_customer_id INCREMENT BY 10;',
      'ALTER SEQUENCE seq_customer_id CACHE 50;',
      'DROP SEQUENCE seq_customer_id;',

      // ── 13. SYNONYMS ─────────────────────────────────────────────
      { section: 'synonyms', cmd: 'CREATE SYNONYM cust FOR customers;' },
      'CREATE PUBLIC SYNONYM pub_cust FOR demo.customers;',
      'CREATE OR REPLACE SYNONYM cust FOR demo.customers;',
      'SELECT * FROM cust WHERE rownum < 5;',
      'DROP SYNONYM cust;',
      'DROP PUBLIC SYNONYM pub_cust;',

      // ── 14. TRANSACTIONS ─────────────────────────────────────────
      { section: 'transactions', cmd: 'SAVEPOINT before_changes;' },
      "INSERT INTO customers VALUES (8888, 'Volatile', 'v@x.com', SYSDATE, NULL);",
      "UPDATE customers SET name = 'Volatile2' WHERE id = 8888;",
      'ROLLBACK TO SAVEPOINT before_changes;',
      "SELECT * FROM customers WHERE id = 8888;",
      "INSERT INTO customers VALUES (8889, 'Persistent', 'p@x.com', SYSDATE, NULL);",
      'COMMIT;',
      'ROLLBACK;',
      'SET TRANSACTION READ ONLY;',
      'SELECT * FROM customers WHERE rownum < 3;',
      'COMMIT;',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
      'COMMIT;',
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED;',
      "SET TRANSACTION NAME 'audit_session';",
      "BEGIN DBMS_TRANSACTION.SAVEPOINT('sp1'); END;",

      // ── 15. LOCKS ────────────────────────────────────────────────
      { section: 'locks', cmd: 'LOCK TABLE customers IN SHARE MODE NOWAIT;' },
      'LOCK TABLE customers IN EXCLUSIVE MODE;',
      'LOCK TABLE customers IN ROW SHARE MODE;',
      'LOCK TABLE customers IN ROW EXCLUSIVE MODE;',
      'LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE;',
      'COMMIT;',
      'SELECT * FROM customers FOR UPDATE;',
      'COMMIT;',
      'SELECT * FROM customers WHERE id = 1 FOR UPDATE NOWAIT;',
      'COMMIT;',
      'SELECT * FROM customers FOR UPDATE WAIT 10;',
      'COMMIT;',
      'SELECT * FROM customers FOR UPDATE SKIP LOCKED;',
      'COMMIT;',

      // ── 16. DROP ─────────────────────────────────────────────────
      { section: 'cleanup', cmd: 'DROP VIEW v_active_customers;' },
      'DROP VIEW v_top_orders;',
      'DROP VIEW v_orders_summary;',
      'DROP VIEW v_complex;',
      'DROP INDEX idx_cust_name;',
      'DROP INDEX uk_prod_code;',
      'DROP INDEX idx_orders_cust;',
      'DROP INDEX idx_orders_date;',
      'DROP INDEX bx_prod_active;',
      'DROP INDEX idx_ol_prod;',
      'DROP TABLE order_lines;',
      'DROP TABLE orders;',
      'DROP TABLE products PURGE;',
      'DROP TABLE customers CASCADE CONSTRAINTS PURGE;',
      'DROP TABLE staging PURGE;',
      'DROP TABLE backup_customers PURGE;',
      'DROP TABLE tmp_session;',
      'DROP TABLE tmp_txn;',
      'DROP TABLE sales PURGE;',
      'DROP TABLE customers_by_country PURGE;',
      'DROP TABLE customers_hash PURGE;',
      'DROP TABLE iot_table PURGE;',
      'DROP TABLE ext_csv PURGE;',
      'DROP TABLE compressed_t PURGE;',
      'DROP TABLE compressed_archive PURGE;',
      'DROP TABLE big_orders PURGE;',
      'DROP TABLE small_orders PURGE;',
      'PURGE RECYCLEBIN;',
      'ALTER SESSION SET CURRENT_SCHEMA = SYS;',
      'DROP USER demo CASCADE;',

      // ── 17. closing ─────────────────────────────────────────────
      { section: 'closing', cmd: 'SELECT user FROM dual;' },
      ...monitoringSweep('sql-dml-ddl'),
      'EXIT;',
    ];

    runOracleDump('oracle-sql-dml-ddl', 'LinuxServer ora-sql — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
