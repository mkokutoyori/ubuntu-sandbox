/**
 * SQL Seed Data for E-Commerce Database
 *
 * These scripts provision PostgreSQL and Oracle databases with
 * realistic e-commerce data including:
 * - Categories, Products, Customers
 * - Orders, Order Items, Reviews
 * - Shopping Carts, Inventory, Coupons
 */

import { SQLEngine } from '../generic/engine';
import { parseSQL } from '../generic/parser';

/**
 * PostgreSQL E-Commerce Seed Script
 */
export const POSTGRES_ECOMMERCE_SEED = `-- PostgreSQL E-Commerce Database Seed
-- Run this script to populate the database with sample data

-- Categories
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    parent_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (id, name, description, parent_id) VALUES
(1, 'Electronics', 'Electronic devices and accessories', NULL),
(2, 'Clothing', 'Apparel and fashion items', NULL),
(3, 'Books', 'Physical and digital books', NULL),
(4, 'Home & Garden', 'Home decor and garden supplies', NULL),
(5, 'Sports', 'Sports equipment and accessories', NULL),
(6, 'Computers', 'Desktop and laptop computers', 1),
(7, 'Smartphones', 'Mobile phones and tablets', 1),
(8, 'Audio', 'Headphones, speakers, and audio equipment', 1),
(9, 'Men Clothing', 'Clothing for men', 2),
(10, 'Women Clothing', 'Clothing for women', 2),
(11, 'Fiction', 'Fiction books and novels', 3),
(12, 'Non-Fiction', 'Educational and informational books', 3);

-- Customers
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1
);

INSERT INTO customers (id, email, password_hash, first_name, last_name, phone) VALUES
(1, 'john.doe@email.com', 'hashed_pwd_1', 'John', 'Doe', '+1-555-0101'),
(2, 'jane.smith@email.com', 'hashed_pwd_2', 'Jane', 'Smith', '+1-555-0102'),
(3, 'bob.wilson@email.com', 'hashed_pwd_3', 'Bob', 'Wilson', '+1-555-0103'),
(4, 'alice.johnson@email.com', 'hashed_pwd_4', 'Alice', 'Johnson', '+1-555-0104'),
(5, 'charlie.brown@email.com', 'hashed_pwd_5', 'Charlie', 'Brown', '+1-555-0105'),
(6, 'emma.davis@email.com', 'hashed_pwd_6', 'Emma', 'Davis', '+1-555-0106'),
(7, 'michael.garcia@email.com', 'hashed_pwd_7', 'Michael', 'Garcia', '+1-555-0107'),
(8, 'sophia.martinez@email.com', 'hashed_pwd_8', 'Sophia', 'Martinez', '+1-555-0108'),
(9, 'william.anderson@email.com', 'hashed_pwd_9', 'William', 'Anderson', '+1-555-0109'),
(10, 'olivia.taylor@email.com', 'hashed_pwd_10', 'Olivia', 'Taylor', '+1-555-0110');

-- Addresses
CREATE TABLE addresses (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    address_type VARCHAR(20) DEFAULT 'shipping',
    street_address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    postal_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) DEFAULT 'USA',
    is_default INTEGER DEFAULT 0
);

INSERT INTO addresses (id, customer_id, address_type, street_address, city, state, postal_code, is_default) VALUES
(1, 1, 'shipping', '123 Main Street', 'New York', 'NY', '10001', 1),
(2, 1, 'billing', '123 Main Street', 'New York', 'NY', '10001', 1),
(3, 2, 'shipping', '456 Oak Avenue', 'Los Angeles', 'CA', '90001', 1),
(4, 3, 'shipping', '789 Pine Road', 'Chicago', 'IL', '60601', 1),
(5, 4, 'shipping', '321 Elm Street', 'Houston', 'TX', '77001', 1),
(6, 5, 'shipping', '654 Maple Drive', 'Phoenix', 'AZ', '85001', 1),
(7, 6, 'shipping', '987 Cedar Lane', 'Philadelphia', 'PA', '19101', 1),
(8, 7, 'shipping', '147 Birch Court', 'San Antonio', 'TX', '78201', 1),
(9, 8, 'shipping', '258 Walnut Way', 'San Diego', 'CA', '92101', 1),
(10, 9, 'shipping', '369 Cherry Place', 'Dallas', 'TX', '75201', 1);

-- Products
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    cost DECIMAL(10, 2),
    category_id INTEGER,
    stock_quantity INTEGER DEFAULT 0,
    weight DECIMAL(8, 2),
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO products (id, sku, name, description, price, cost, category_id, stock_quantity, weight) VALUES
(1, 'LAPTOP-001', 'ProBook 15 Laptop', '15.6 Full HD, Intel i7, 16GB RAM, 512GB SSD', 1299.99, 950.00, 6, 50, 2.10),
(2, 'LAPTOP-002', 'UltraSlim 14 Laptop', '14 4K Display, Intel i5, 8GB RAM, 256GB SSD', 899.99, 650.00, 6, 75, 1.50),
(3, 'PHONE-001', 'SmartPhone Pro X', '6.7 OLED, 128GB, 5G, Triple Camera', 999.99, 700.00, 7, 100, 0.20),
(4, 'PHONE-002', 'SmartPhone Lite', '6.1 LCD, 64GB, 4G, Dual Camera', 499.99, 300.00, 7, 150, 0.18),
(5, 'HEADPHONE-001', 'NoiseCancel Pro Headphones', 'Wireless ANC Headphones, 30hr battery', 349.99, 180.00, 8, 200, 0.25),
(6, 'HEADPHONE-002', 'SportBuds Wireless', 'True Wireless Earbuds, Water resistant', 149.99, 70.00, 8, 300, 0.05),
(7, 'SHIRT-001', 'Classic Cotton T-Shirt', '100% Cotton, Crew neck, Multiple colors', 29.99, 8.00, 9, 500, 0.20),
(8, 'SHIRT-002', 'Premium Polo Shirt', 'Pique cotton polo, Button collar', 59.99, 18.00, 9, 300, 0.25),
(9, 'DRESS-001', 'Elegant Summer Dress', 'Floral print, A-line cut, Knee length', 89.99, 35.00, 10, 150, 0.30),
(10, 'DRESS-002', 'Professional Blazer', 'Tailored fit, Single breasted', 149.99, 60.00, 10, 100, 0.50),
(11, 'BOOK-001', 'The Art of Programming', 'Comprehensive guide to software development', 49.99, 15.00, 12, 200, 0.80),
(12, 'BOOK-002', 'Mystery at Midnight', 'Bestselling thriller novel', 24.99, 7.00, 11, 400, 0.40),
(13, 'BOOK-003', 'Cooking Made Easy', '500 recipes for beginners', 34.99, 12.00, 12, 250, 1.00),
(14, 'SPEAKER-001', 'BoomBox Portable Speaker', 'Bluetooth 5.0, 20W, 12hr battery', 79.99, 35.00, 8, 180, 0.60),
(15, 'TABLET-001', 'ProTab 10', '10.1 Tablet, 64GB, Wi-Fi LTE', 449.99, 280.00, 7, 80, 0.45);

-- Orders
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    order_number VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(30) DEFAULT 'pending',
    subtotal DECIMAL(10, 2) NOT NULL,
    tax DECIMAL(10, 2) DEFAULT 0,
    shipping_cost DECIMAL(10, 2) DEFAULT 0,
    total DECIMAL(10, 2) NOT NULL,
    shipping_address_id INTEGER,
    billing_address_id INTEGER,
    payment_method VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO orders (id, customer_id, order_number, status, subtotal, tax, shipping_cost, total, shipping_address_id, billing_address_id, payment_method) VALUES
(1, 1, 'ORD-2024-001', 'delivered', 1299.99, 104.00, 0.00, 1403.99, 1, 2, 'credit_card'),
(2, 2, 'ORD-2024-002', 'delivered', 529.98, 42.40, 5.99, 578.37, 3, 3, 'paypal'),
(3, 3, 'ORD-2024-003', 'shipped', 349.99, 28.00, 0.00, 377.99, 4, 4, 'credit_card'),
(4, 1, 'ORD-2024-004', 'processing', 89.97, 7.20, 5.99, 103.16, 1, 2, 'credit_card'),
(5, 4, 'ORD-2024-005', 'delivered', 999.99, 80.00, 0.00, 1079.99, 5, 5, 'debit_card'),
(6, 5, 'ORD-2024-006', 'pending', 179.98, 14.40, 5.99, 200.37, 6, 6, 'credit_card'),
(7, 2, 'ORD-2024-007', 'delivered', 449.99, 36.00, 0.00, 485.99, 3, 3, 'paypal'),
(8, 6, 'ORD-2024-008', 'shipped', 1799.98, 144.00, 0.00, 1943.98, 7, 7, 'credit_card'),
(9, 7, 'ORD-2024-009', 'processing', 74.98, 6.00, 5.99, 86.97, 8, 8, 'credit_card'),
(10, 3, 'ORD-2024-010', 'delivered', 149.99, 12.00, 5.99, 167.98, 4, 4, 'debit_card');

-- Order Items
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL
);

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, total_price) VALUES
(1, 1, 1, 1, 1299.99, 1299.99),
(2, 2, 4, 1, 499.99, 499.99),
(3, 2, 7, 1, 29.99, 29.99),
(4, 3, 5, 1, 349.99, 349.99),
(5, 4, 7, 3, 29.99, 89.97),
(6, 5, 3, 1, 999.99, 999.99),
(7, 6, 6, 1, 149.99, 149.99),
(8, 6, 7, 1, 29.99, 29.99),
(9, 7, 15, 1, 449.99, 449.99),
(10, 8, 1, 1, 1299.99, 1299.99),
(11, 8, 4, 1, 499.99, 499.99),
(12, 9, 12, 2, 24.99, 49.98),
(13, 9, 13, 1, 34.99, 34.99),
(14, 10, 10, 1, 149.99, 149.99);

-- Reviews
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    rating INTEGER,
    title VARCHAR(255),
    comment TEXT,
    is_verified INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO reviews (id, product_id, customer_id, rating, title, comment, is_verified) VALUES
(1, 1, 1, 5, 'Excellent laptop!', 'Fast, reliable, and great battery life.', 1),
(2, 1, 3, 4, 'Good but pricey', 'Great performance but expensive.', 1),
(3, 3, 5, 5, 'Best phone ever', 'Amazing camera and gorgeous screen.', 1),
(4, 5, 3, 5, 'Perfect ANC', 'These headphones are incredible.', 1),
(5, 7, 2, 4, 'Comfortable fit', 'Nice quality cotton.', 1),
(6, 11, 4, 5, 'Must-read', 'Every developer should read this.', 1),
(7, 12, 7, 4, 'Great thriller', 'Unexpected twists.', 1),
(8, 6, 6, 4, 'Great for workouts', 'Good sound quality.', 1),
(9, 15, 2, 5, 'Perfect tablet', 'Very versatile.', 1),
(10, 9, 8, 5, 'Beautiful dress', 'Excellent fabric quality.', 1);

-- Shopping Carts
CREATE TABLE shopping_carts (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cart_items (
    id SERIAL PRIMARY KEY,
    cart_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO shopping_carts (id, customer_id) VALUES (1, 8), (2, 9), (3, 10);
INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES (1, 1, 2, 1), (2, 1, 6, 2), (3, 2, 14, 1), (4, 2, 7, 3), (5, 3, 3, 1);

-- Coupons
CREATE TABLE coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type VARCHAR(20) NOT NULL,
    discount_value DECIMAL(10, 2) NOT NULL,
    min_order_amount DECIMAL(10, 2),
    max_uses INTEGER,
    current_uses INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
);

INSERT INTO coupons (id, code, discount_type, discount_value, min_order_amount, max_uses) VALUES
(1, 'WELCOME10', 'percentage', 10.00, 50.00, 1000),
(2, 'SAVE20', 'percentage', 20.00, 100.00, 500),
(3, 'FLAT50', 'fixed', 50.00, 200.00, 200),
(4, 'FREESHIP', 'shipping', 100.00, 75.00, NULL),
(5, 'VIP25', 'percentage', 25.00, 150.00, 100);
`;

/**
 * Oracle E-Commerce Seed Script (simplified for our engine)
 */
export const ORACLE_ECOMMERCE_SEED = `-- Oracle E-Commerce Database Seed
-- Run this script to populate the database with sample data

-- Categories
CREATE TABLE CATEGORIES (
    ID NUMBER PRIMARY KEY,
    NAME VARCHAR2(100) NOT NULL,
    DESCRIPTION VARCHAR2(4000),
    PARENT_ID NUMBER,
    CREATED_AT DATE DEFAULT SYSDATE
);

INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (1, 'Electronics', 'Electronic devices and accessories', NULL);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (2, 'Clothing', 'Apparel and fashion items', NULL);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (3, 'Books', 'Physical and digital books', NULL);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (4, 'Home and Garden', 'Home decor and garden supplies', NULL);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (5, 'Sports', 'Sports equipment and accessories', NULL);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (6, 'Computers', 'Desktop and laptop computers', 1);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (7, 'Smartphones', 'Mobile phones and tablets', 1);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (8, 'Audio', 'Headphones speakers and audio equipment', 1);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (9, 'Men Clothing', 'Clothing for men', 2);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (10, 'Women Clothing', 'Clothing for women', 2);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (11, 'Fiction', 'Fiction books and novels', 3);
INSERT INTO CATEGORIES (ID, NAME, DESCRIPTION, PARENT_ID) VALUES (12, 'Non-Fiction', 'Educational and informational books', 3);

-- Customers
CREATE TABLE CUSTOMERS (
    ID NUMBER PRIMARY KEY,
    EMAIL VARCHAR2(255) NOT NULL,
    PASSWORD_HASH VARCHAR2(255) NOT NULL,
    FIRST_NAME VARCHAR2(100) NOT NULL,
    LAST_NAME VARCHAR2(100) NOT NULL,
    PHONE VARCHAR2(20),
    CREATED_AT DATE DEFAULT SYSDATE,
    IS_ACTIVE NUMBER DEFAULT 1
);

INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (1, 'john.doe@email.com', 'hashed_pwd_1', 'John', 'Doe', '+1-555-0101');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (2, 'jane.smith@email.com', 'hashed_pwd_2', 'Jane', 'Smith', '+1-555-0102');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (3, 'bob.wilson@email.com', 'hashed_pwd_3', 'Bob', 'Wilson', '+1-555-0103');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (4, 'alice.johnson@email.com', 'hashed_pwd_4', 'Alice', 'Johnson', '+1-555-0104');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (5, 'charlie.brown@email.com', 'hashed_pwd_5', 'Charlie', 'Brown', '+1-555-0105');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (6, 'emma.davis@email.com', 'hashed_pwd_6', 'Emma', 'Davis', '+1-555-0106');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (7, 'michael.garcia@email.com', 'hashed_pwd_7', 'Michael', 'Garcia', '+1-555-0107');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (8, 'sophia.martinez@email.com', 'hashed_pwd_8', 'Sophia', 'Martinez', '+1-555-0108');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (9, 'william.anderson@email.com', 'hashed_pwd_9', 'William', 'Anderson', '+1-555-0109');
INSERT INTO CUSTOMERS (ID, EMAIL, PASSWORD_HASH, FIRST_NAME, LAST_NAME, PHONE) VALUES (10, 'olivia.taylor@email.com', 'hashed_pwd_10', 'Olivia', 'Taylor', '+1-555-0110');

-- Products
CREATE TABLE PRODUCTS (
    ID NUMBER PRIMARY KEY,
    SKU VARCHAR2(50) NOT NULL,
    NAME VARCHAR2(255) NOT NULL,
    DESCRIPTION VARCHAR2(4000),
    PRICE NUMBER(10, 2) NOT NULL,
    COST NUMBER(10, 2),
    CATEGORY_ID NUMBER,
    STOCK_QUANTITY NUMBER DEFAULT 0,
    WEIGHT NUMBER(8, 2),
    IS_ACTIVE NUMBER DEFAULT 1,
    CREATED_AT DATE DEFAULT SYSDATE
);

INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (1, 'LAPTOP-001', 'ProBook 15 Laptop', '15.6 Full HD Intel i7 16GB RAM 512GB SSD', 1299.99, 950.00, 6, 50, 2.10);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (2, 'LAPTOP-002', 'UltraSlim 14 Laptop', '14 4K Display Intel i5 8GB RAM 256GB SSD', 899.99, 650.00, 6, 75, 1.50);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (3, 'PHONE-001', 'SmartPhone Pro X', '6.7 OLED 128GB 5G Triple Camera', 999.99, 700.00, 7, 100, 0.20);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (4, 'PHONE-002', 'SmartPhone Lite', '6.1 LCD 64GB 4G Dual Camera', 499.99, 300.00, 7, 150, 0.18);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (5, 'HEADPHONE-001', 'NoiseCancel Pro Headphones', 'Wireless ANC Headphones 30hr battery', 349.99, 180.00, 8, 200, 0.25);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (6, 'HEADPHONE-002', 'SportBuds Wireless', 'True Wireless Earbuds Water resistant', 149.99, 70.00, 8, 300, 0.05);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (7, 'SHIRT-001', 'Classic Cotton T-Shirt', '100 Cotton Crew neck Multiple colors', 29.99, 8.00, 9, 500, 0.20);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (8, 'SHIRT-002', 'Premium Polo Shirt', 'Pique cotton polo Button collar', 59.99, 18.00, 9, 300, 0.25);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (9, 'DRESS-001', 'Elegant Summer Dress', 'Floral print A-line cut Knee length', 89.99, 35.00, 10, 150, 0.30);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (10, 'DRESS-002', 'Professional Blazer', 'Tailored fit Single breasted', 149.99, 60.00, 10, 100, 0.50);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (11, 'BOOK-001', 'The Art of Programming', 'Comprehensive guide to software development', 49.99, 15.00, 12, 200, 0.80);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (12, 'BOOK-002', 'Mystery at Midnight', 'Bestselling thriller novel', 24.99, 7.00, 11, 400, 0.40);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (13, 'BOOK-003', 'Cooking Made Easy', '500 recipes for beginners', 34.99, 12.00, 12, 250, 1.00);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (14, 'SPEAKER-001', 'BoomBox Portable Speaker', 'Bluetooth 5.0 20W 12hr battery', 79.99, 35.00, 8, 180, 0.60);
INSERT INTO PRODUCTS (ID, SKU, NAME, DESCRIPTION, PRICE, COST, CATEGORY_ID, STOCK_QUANTITY, WEIGHT) VALUES (15, 'TABLET-001', 'ProTab 10', '10.1 Tablet 64GB Wi-Fi LTE', 449.99, 280.00, 7, 80, 0.45);

-- Orders
CREATE TABLE ORDERS (
    ID NUMBER PRIMARY KEY,
    CUSTOMER_ID NUMBER NOT NULL,
    ORDER_NUMBER VARCHAR2(50) NOT NULL,
    STATUS VARCHAR2(30) DEFAULT 'pending',
    SUBTOTAL NUMBER(10, 2) NOT NULL,
    TAX NUMBER(10, 2) DEFAULT 0,
    SHIPPING_COST NUMBER(10, 2) DEFAULT 0,
    TOTAL NUMBER(10, 2) NOT NULL,
    SHIPPING_ADDRESS_ID NUMBER,
    BILLING_ADDRESS_ID NUMBER,
    PAYMENT_METHOD VARCHAR2(50),
    CREATED_AT DATE DEFAULT SYSDATE
);

INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (1, 1, 'ORD-2024-001', 'delivered', 1299.99, 104.00, 0.00, 1403.99, 1, 2, 'credit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (2, 2, 'ORD-2024-002', 'delivered', 529.98, 42.40, 5.99, 578.37, 3, 3, 'paypal');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (3, 3, 'ORD-2024-003', 'shipped', 349.99, 28.00, 0.00, 377.99, 4, 4, 'credit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (4, 1, 'ORD-2024-004', 'processing', 89.97, 7.20, 5.99, 103.16, 1, 2, 'credit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (5, 4, 'ORD-2024-005', 'delivered', 999.99, 80.00, 0.00, 1079.99, 5, 5, 'debit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (6, 5, 'ORD-2024-006', 'pending', 179.98, 14.40, 5.99, 200.37, 6, 6, 'credit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (7, 2, 'ORD-2024-007', 'delivered', 449.99, 36.00, 0.00, 485.99, 3, 3, 'paypal');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (8, 6, 'ORD-2024-008', 'shipped', 1799.98, 144.00, 0.00, 1943.98, 7, 7, 'credit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (9, 7, 'ORD-2024-009', 'processing', 74.98, 6.00, 5.99, 86.97, 8, 8, 'credit_card');
INSERT INTO ORDERS (ID, CUSTOMER_ID, ORDER_NUMBER, STATUS, SUBTOTAL, TAX, SHIPPING_COST, TOTAL, SHIPPING_ADDRESS_ID, BILLING_ADDRESS_ID, PAYMENT_METHOD) VALUES (10, 3, 'ORD-2024-010', 'delivered', 149.99, 12.00, 5.99, 167.98, 4, 4, 'debit_card');

-- Order Items
CREATE TABLE ORDER_ITEMS (
    ID NUMBER PRIMARY KEY,
    ORDER_ID NUMBER NOT NULL,
    PRODUCT_ID NUMBER NOT NULL,
    QUANTITY NUMBER NOT NULL,
    UNIT_PRICE NUMBER(10, 2) NOT NULL,
    TOTAL_PRICE NUMBER(10, 2) NOT NULL
);

INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (1, 1, 1, 1, 1299.99, 1299.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (2, 2, 4, 1, 499.99, 499.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (3, 2, 7, 1, 29.99, 29.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (4, 3, 5, 1, 349.99, 349.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (5, 4, 7, 3, 29.99, 89.97);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (6, 5, 3, 1, 999.99, 999.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (7, 6, 6, 1, 149.99, 149.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (8, 6, 7, 1, 29.99, 29.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (9, 7, 15, 1, 449.99, 449.99);
INSERT INTO ORDER_ITEMS (ID, ORDER_ID, PRODUCT_ID, QUANTITY, UNIT_PRICE, TOTAL_PRICE) VALUES (10, 8, 1, 1, 1299.99, 1299.99);

-- Reviews
CREATE TABLE REVIEWS (
    ID NUMBER PRIMARY KEY,
    PRODUCT_ID NUMBER NOT NULL,
    CUSTOMER_ID NUMBER NOT NULL,
    RATING NUMBER,
    TITLE VARCHAR2(255),
    REVIEW_TEXT VARCHAR2(4000),
    IS_VERIFIED NUMBER DEFAULT 0,
    CREATED_AT DATE DEFAULT SYSDATE
);

INSERT INTO REVIEWS (ID, PRODUCT_ID, CUSTOMER_ID, RATING, TITLE, REVIEW_TEXT, IS_VERIFIED) VALUES (1, 1, 1, 5, 'Excellent laptop', 'Fast reliable and great battery life', 1);
INSERT INTO REVIEWS (ID, PRODUCT_ID, CUSTOMER_ID, RATING, TITLE, REVIEW_TEXT, IS_VERIFIED) VALUES (2, 1, 3, 4, 'Good but pricey', 'Great performance but expensive', 1);
INSERT INTO REVIEWS (ID, PRODUCT_ID, CUSTOMER_ID, RATING, TITLE, REVIEW_TEXT, IS_VERIFIED) VALUES (3, 3, 5, 5, 'Best phone ever', 'Amazing camera and gorgeous screen', 1);
INSERT INTO REVIEWS (ID, PRODUCT_ID, CUSTOMER_ID, RATING, TITLE, REVIEW_TEXT, IS_VERIFIED) VALUES (4, 5, 3, 5, 'Perfect ANC', 'These headphones are incredible', 1);
INSERT INTO REVIEWS (ID, PRODUCT_ID, CUSTOMER_ID, RATING, TITLE, REVIEW_TEXT, IS_VERIFIED) VALUES (5, 7, 2, 4, 'Comfortable fit', 'Nice quality cotton', 1);
`;

/**
 * Execute a seed script against an SQL engine
 */
export function executeSeedScript(engine: SQLEngine, seedScript: string): { success: boolean; errors: string[] } {
  const errors: string[] = [];

  // Split script into individual statements and clean up comments
  const statements = seedScript
    .split(';')
    .map(s => {
      // Remove full-line comments from the statement
      const lines = s.split('\n');
      const cleanedLines = lines.filter(line => !line.trim().startsWith('--'));
      return cleanedLines.join('\n').trim();
    })
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    if (!stmt) continue;

    try {
      const parseResult = parseSQL(stmt + ';');

      if (!parseResult.success || parseResult.statements.length === 0) {
        // Skip unparseable statements (like comments)
        continue;
      }

      const parsedStmt = parseResult.statements[0];

      // Execute based on statement type
      let result;
      switch (parsedStmt.type) {
        case 'CREATE_TABLE':
          result = engine.createTable(parsedStmt as any);
          break;
        case 'INSERT':
          result = engine.executeInsert(parsedStmt as any);
          break;
        case 'CREATE_INDEX':
          // Skip index creation for now (not critical for demo)
          continue;
        case 'CREATE_SEQUENCE':
          result = engine.createSequence((parsedStmt as any).name, undefined, parsedStmt as any);
          break;
        default:
          // Try to execute unknown statement types
          continue;
      }

      if (result && !result.success) {
        const errorMsg = result.error?.message || JSON.stringify(result.error);
        errors.push(`Error executing: ${stmt.substring(0, 50)}... - ${errorMsg}`);
      }
    } catch (e) {
      errors.push(`Exception: ${(e as Error).message}`);
    }
  }

  return { success: errors.length === 0, errors };
}

/**
 * Initialize PostgreSQL with e-commerce seed data
 */
export function initializePostgresSeeds(engine: SQLEngine): { success: boolean; errors: string[] } {
  return executeSeedScript(engine, POSTGRES_ECOMMERCE_SEED);
}

/**
 * Initialize Oracle with e-commerce seed data
 */
export function initializeOracleSeeds(engine: SQLEngine): { success: boolean; errors: string[] } {
  return executeSeedScript(engine, ORACLE_ECOMMERCE_SEED);
}
