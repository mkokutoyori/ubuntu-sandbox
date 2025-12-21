/**
 * SQL Seed Data Tests
 *
 * These tests verify that the e-commerce seed data is properly
 * provisioned when creating psql and sqlplus sessions.
 */

import { describe, it, expect } from 'vitest';
import { createPsqlSession, executePsql } from '../terminal/sql/postgres/psql';
import { createSQLPlusSession, executeSQLPlus } from '../terminal/sql/oracle/sqlplus';

describe('PostgreSQL E-Commerce Seed Data', () => {
  it('creates session with seeded flag set to true', () => {
    const session = createPsqlSession();
    expect(session.seeded).toBe(true);
  });

  it('has categories table with data', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM categories;');

    expect(result.output).toContain('12');
  });

  it('has customers table with 10 customers', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM customers;');

    expect(result.output).toContain('10');
  });

  it('can query customer by email', () => {
    const session = createPsqlSession();
    const result = executePsql(session, "SELECT first_name, last_name FROM customers WHERE email = 'john.doe@email.com';");

    expect(result.output).toContain('John');
    expect(result.output).toContain('Doe');
  });

  it('has products table with 15 products', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM products;');

    expect(result.output).toContain('15');
  });

  it('can query products by category', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT name, price FROM products WHERE category_id = 6;');

    // Category 6 is Computers
    expect(result.output).toContain('ProBook 15 Laptop');
    expect(result.output).toContain('UltraSlim 14 Laptop');
  });

  it('has orders table with 10 orders', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM orders;');

    expect(result.output).toContain('10');
  });

  it('can query orders with status', () => {
    const session = createPsqlSession();
    const result = executePsql(session, "SELECT order_number, total FROM orders WHERE status = 'delivered';");

    expect(result.output).toContain('ORD-2024-001');
    expect(result.output).toContain('1403.99');
  });

  it('has order_items table', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM order_items;');

    // Should have at least 14 order items
    expect(result.error).toBeUndefined();
  });

  it('has reviews table with ratings', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM reviews WHERE rating = 5;');

    // Multiple 5-star reviews
    expect(result.error).toBeUndefined();
  });

  it('has coupons table with discount codes', () => {
    const session = createPsqlSession();
    const result = executePsql(session, "SELECT code, discount_value FROM coupons WHERE code = 'WELCOME10';");

    expect(result.output).toContain('WELCOME10');
    expect(result.output).toContain('10');
  });

  it('can perform JOIN query between orders and customers', () => {
    const session = createPsqlSession();
    const result = executePsql(session, `
      SELECT c.first_name, c.last_name, o.order_number, o.total
      FROM customers c
      JOIN orders o ON c.id = o.customer_id
      WHERE c.email = 'john.doe@email.com';
    `);

    expect(result.output).toContain('John');
    expect(result.output).toContain('ORD-2024-001');
  });

  it('can query shopping_carts table', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM shopping_carts;');

    expect(result.output).toContain('3');
  });

  it('can query addresses table', () => {
    const session = createPsqlSession();
    const result = executePsql(session, 'SELECT COUNT(*) FROM addresses;');

    expect(result.output).toContain('10');
  });
});

describe('Oracle E-Commerce Seed Data', () => {
  it('creates session with seeded flag set to true', () => {
    const session = createSQLPlusSession();
    expect(session.seeded).toBe(true);
  });

  it('has CATEGORIES table with data', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT COUNT(*) FROM CATEGORIES;');

    expect(result.output).toContain('12');
  });

  it('has CUSTOMERS table with 10 customers', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT COUNT(*) FROM CUSTOMERS;');

    expect(result.output).toContain('10');
  });

  it('can query customer by email', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, "SELECT FIRST_NAME, LAST_NAME FROM CUSTOMERS WHERE EMAIL = 'john.doe@email.com';");

    expect(result.output).toContain('John');
    expect(result.output).toContain('Doe');
  });

  it('has PRODUCTS table with 15 products', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT COUNT(*) FROM PRODUCTS;');

    expect(result.output).toContain('15');
  });

  it('can query products by category', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT NAME, PRICE FROM PRODUCTS WHERE CATEGORY_ID = 6;');

    // Category 6 is Computers
    expect(result.output).toContain('ProBook 15 Laptop');
  });

  it('has ORDERS table with 10 orders', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT COUNT(*) FROM ORDERS;');

    expect(result.output).toContain('10');
  });

  it('can query orders with status', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, "SELECT ORDER_NUMBER, TOTAL FROM ORDERS WHERE STATUS = 'delivered';");

    expect(result.output).toContain('ORD-2024-001');
  });

  it('has ORDER_ITEMS table', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT COUNT(*) FROM ORDER_ITEMS;');

    expect(result.error).toBeUndefined();
  });

  it('has REVIEWS table with ratings', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, 'SELECT COUNT(*) FROM REVIEWS WHERE RATING = 5;');

    expect(result.error).toBeUndefined();
  });

  it('can perform JOIN query between ORDERS and CUSTOMERS', () => {
    const session = createSQLPlusSession();
    const result = executeSQLPlus(session, `
      SELECT C.FIRST_NAME, C.LAST_NAME, O.ORDER_NUMBER, O.TOTAL
      FROM CUSTOMERS C
      JOIN ORDERS O ON C.ID = O.CUSTOMER_ID
      WHERE C.EMAIL = 'john.doe@email.com'
    `);

    expect(result.output).toContain('John');
    expect(result.output).toContain('ORD-2024-001');
  });
});

describe('SQL Seed Script Execution', () => {
  it('PostgreSQL tables have correct structure', () => {
    const session = createPsqlSession();

    // Check products table has all expected columns
    const result = executePsql(session, 'SELECT sku, name, price, stock_quantity FROM products WHERE id = 1;');

    expect(result.output).toContain('LAPTOP-001');
    expect(result.output).toContain('ProBook 15 Laptop');
    expect(result.output).toContain('1299.99');
    expect(result.output).toContain('50');
  });

  it('Oracle tables have correct structure', () => {
    const session = createSQLPlusSession();

    // Check PRODUCTS table has all expected columns
    const result = executeSQLPlus(session, 'SELECT SKU, NAME, PRICE, STOCK_QUANTITY FROM PRODUCTS WHERE ID = 1;');

    expect(result.output).toContain('LAPTOP-001');
    expect(result.output).toContain('ProBook 15 Laptop');
    expect(result.output).toContain('1299.99');
    expect(result.output).toContain('50');
  });

  it('PostgreSQL can aggregate order totals by customer', () => {
    const session = createPsqlSession();

    const result = executePsql(session, `
      SELECT c.first_name, c.last_name, SUM(o.total) as total_spent
      FROM customers c
      JOIN orders o ON c.id = o.customer_id
      GROUP BY c.id, c.first_name, c.last_name
      ORDER BY total_spent DESC;
    `);

    expect(result.error).toBeUndefined();
    expect(result.output).toContain('first_name');
  });

  it('Oracle can aggregate order totals by customer', () => {
    const session = createSQLPlusSession();

    const result = executeSQLPlus(session, `
      SELECT C.FIRST_NAME, C.LAST_NAME, SUM(O.TOTAL) AS TOTAL_SPENT
      FROM CUSTOMERS C
      JOIN ORDERS O ON C.ID = O.CUSTOMER_ID
      GROUP BY C.ID, C.FIRST_NAME, C.LAST_NAME
      ORDER BY TOTAL_SPENT DESC
    `);

    expect(result.error).toBeUndefined();
  });
});
