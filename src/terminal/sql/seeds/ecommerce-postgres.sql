-- =====================================================
-- PostgreSQL E-Commerce Database Seed Script
-- Database: shopdb
-- Description: Complete e-commerce database with
--              customers, products, orders, etc.
-- =====================================================

-- =====================================================
-- SCHEMA: Categories
-- =====================================================
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    parent_id INTEGER REFERENCES categories(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (name, description, parent_id) VALUES
('Electronics', 'Electronic devices and accessories', NULL),
('Clothing', 'Apparel and fashion items', NULL),
('Books', 'Physical and digital books', NULL),
('Home & Garden', 'Home decor and garden supplies', NULL),
('Sports', 'Sports equipment and accessories', NULL),
('Computers', 'Desktop and laptop computers', 1),
('Smartphones', 'Mobile phones and tablets', 1),
('Audio', 'Headphones, speakers, and audio equipment', 1),
('Men''s Clothing', 'Clothing for men', 2),
('Women''s Clothing', 'Clothing for women', 2),
('Fiction', 'Fiction books and novels', 3),
('Non-Fiction', 'Educational and informational books', 3);

-- =====================================================
-- SCHEMA: Customers
-- =====================================================
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

INSERT INTO customers (email, password_hash, first_name, last_name, phone) VALUES
('john.doe@email.com', '$2b$10$xyz123hashedpassword', 'John', 'Doe', '+1-555-0101'),
('jane.smith@email.com', '$2b$10$abc456hashedpassword', 'Jane', 'Smith', '+1-555-0102'),
('bob.wilson@email.com', '$2b$10$def789hashedpassword', 'Bob', 'Wilson', '+1-555-0103'),
('alice.johnson@email.com', '$2b$10$ghi012hashedpassword', 'Alice', 'Johnson', '+1-555-0104'),
('charlie.brown@email.com', '$2b$10$jkl345hashedpassword', 'Charlie', 'Brown', '+1-555-0105'),
('emma.davis@email.com', '$2b$10$mno678hashedpassword', 'Emma', 'Davis', '+1-555-0106'),
('michael.garcia@email.com', '$2b$10$pqr901hashedpassword', 'Michael', 'Garcia', '+1-555-0107'),
('sophia.martinez@email.com', '$2b$10$stu234hashedpassword', 'Sophia', 'Martinez', '+1-555-0108'),
('william.anderson@email.com', '$2b$10$vwx567hashedpassword', 'William', 'Anderson', '+1-555-0109'),
('olivia.taylor@email.com', '$2b$10$yza890hashedpassword', 'Olivia', 'Taylor', '+1-555-0110');

-- =====================================================
-- SCHEMA: Addresses
-- =====================================================
CREATE TABLE addresses (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    address_type VARCHAR(20) DEFAULT 'shipping',
    street_address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    postal_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) DEFAULT 'USA',
    is_default BOOLEAN DEFAULT FALSE
);

INSERT INTO addresses (customer_id, address_type, street_address, city, state, postal_code, country, is_default) VALUES
(1, 'shipping', '123 Main Street', 'New York', 'NY', '10001', 'USA', TRUE),
(1, 'billing', '123 Main Street', 'New York', 'NY', '10001', 'USA', TRUE),
(2, 'shipping', '456 Oak Avenue', 'Los Angeles', 'CA', '90001', 'USA', TRUE),
(3, 'shipping', '789 Pine Road', 'Chicago', 'IL', '60601', 'USA', TRUE),
(4, 'shipping', '321 Elm Street', 'Houston', 'TX', '77001', 'USA', TRUE),
(5, 'shipping', '654 Maple Drive', 'Phoenix', 'AZ', '85001', 'USA', TRUE),
(6, 'shipping', '987 Cedar Lane', 'Philadelphia', 'PA', '19101', 'USA', TRUE),
(7, 'shipping', '147 Birch Court', 'San Antonio', 'TX', '78201', 'USA', TRUE),
(8, 'shipping', '258 Walnut Way', 'San Diego', 'CA', '92101', 'USA', TRUE),
(9, 'shipping', '369 Cherry Place', 'Dallas', 'TX', '75201', 'USA', TRUE),
(10, 'shipping', '741 Ash Boulevard', 'San Jose', 'CA', '95101', 'USA', TRUE);

-- =====================================================
-- SCHEMA: Products
-- =====================================================
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    cost DECIMAL(10, 2),
    category_id INTEGER REFERENCES categories(id),
    stock_quantity INTEGER DEFAULT 0,
    weight DECIMAL(8, 2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO products (sku, name, description, price, cost, category_id, stock_quantity, weight) VALUES
('LAPTOP-001', 'ProBook 15 Laptop', '15.6" Full HD, Intel i7, 16GB RAM, 512GB SSD', 1299.99, 950.00, 6, 50, 2.10),
('LAPTOP-002', 'UltraSlim 14 Laptop', '14" 4K Display, Intel i5, 8GB RAM, 256GB SSD', 899.99, 650.00, 6, 75, 1.50),
('PHONE-001', 'SmartPhone Pro X', '6.7" OLED, 128GB, 5G, Triple Camera', 999.99, 700.00, 7, 100, 0.20),
('PHONE-002', 'SmartPhone Lite', '6.1" LCD, 64GB, 4G, Dual Camera', 499.99, 300.00, 7, 150, 0.18),
('HEADPHONE-001', 'NoiseCancel Pro Headphones', 'Wireless ANC Headphones, 30hr battery', 349.99, 180.00, 8, 200, 0.25),
('HEADPHONE-002', 'SportBuds Wireless', 'True Wireless Earbuds, Water resistant', 149.99, 70.00, 8, 300, 0.05),
('SHIRT-001', 'Classic Cotton T-Shirt', '100% Cotton, Crew neck, Multiple colors', 29.99, 8.00, 9, 500, 0.20),
('SHIRT-002', 'Premium Polo Shirt', 'Pique cotton polo, Button collar', 59.99, 18.00, 9, 300, 0.25),
('DRESS-001', 'Elegant Summer Dress', 'Floral print, A-line cut, Knee length', 89.99, 35.00, 10, 150, 0.30),
('DRESS-002', 'Professional Blazer', 'Tailored fit, Single breasted', 149.99, 60.00, 10, 100, 0.50),
('BOOK-001', 'The Art of Programming', 'Comprehensive guide to software development', 49.99, 15.00, 12, 200, 0.80),
('BOOK-002', 'Mystery at Midnight', 'Bestselling thriller novel', 24.99, 7.00, 11, 400, 0.40),
('BOOK-003', 'Cooking Made Easy', '500 recipes for beginners', 34.99, 12.00, 12, 250, 1.00),
('SPEAKER-001', 'BoomBox Portable Speaker', 'Bluetooth 5.0, 20W, 12hr battery', 79.99, 35.00, 8, 180, 0.60),
('TABLET-001', 'ProTab 10', '10.1" Tablet, 64GB, Wi-Fi + LTE', 449.99, 280.00, 7, 80, 0.45);

-- =====================================================
-- SCHEMA: Orders
-- =====================================================
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    order_number VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(30) DEFAULT 'pending',
    subtotal DECIMAL(10, 2) NOT NULL,
    tax DECIMAL(10, 2) DEFAULT 0,
    shipping_cost DECIMAL(10, 2) DEFAULT 0,
    total DECIMAL(10, 2) NOT NULL,
    shipping_address_id INTEGER REFERENCES addresses(id),
    billing_address_id INTEGER REFERENCES addresses(id),
    payment_method VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO orders (customer_id, order_number, status, subtotal, tax, shipping_cost, total, shipping_address_id, billing_address_id, payment_method) VALUES
(1, 'ORD-2024-001', 'delivered', 1299.99, 104.00, 0.00, 1403.99, 1, 2, 'credit_card'),
(2, 'ORD-2024-002', 'delivered', 529.98, 42.40, 5.99, 578.37, 3, 3, 'paypal'),
(3, 'ORD-2024-003', 'shipped', 349.99, 28.00, 0.00, 377.99, 4, 4, 'credit_card'),
(1, 'ORD-2024-004', 'processing', 89.97, 7.20, 5.99, 103.16, 1, 2, 'credit_card'),
(4, 'ORD-2024-005', 'delivered', 999.99, 80.00, 0.00, 1079.99, 5, 5, 'debit_card'),
(5, 'ORD-2024-006', 'pending', 179.98, 14.40, 5.99, 200.37, 6, 6, 'credit_card'),
(2, 'ORD-2024-007', 'delivered', 449.99, 36.00, 0.00, 485.99, 3, 3, 'paypal'),
(6, 'ORD-2024-008', 'shipped', 1799.98, 144.00, 0.00, 1943.98, 7, 7, 'credit_card'),
(7, 'ORD-2024-009', 'processing', 74.98, 6.00, 5.99, 86.97, 8, 8, 'credit_card'),
(3, 'ORD-2024-010', 'delivered', 149.99, 12.00, 5.99, 167.98, 4, 4, 'debit_card');

-- =====================================================
-- SCHEMA: Order Items
-- =====================================================
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL
);

INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price) VALUES
(1, 1, 1, 1299.99, 1299.99),
(2, 4, 1, 499.99, 499.99),
(2, 7, 1, 29.99, 29.99),
(3, 5, 1, 349.99, 349.99),
(4, 7, 3, 29.99, 89.97),
(5, 3, 1, 999.99, 999.99),
(6, 6, 1, 149.99, 149.99),
(6, 7, 1, 29.99, 29.99),
(7, 15, 1, 449.99, 449.99),
(8, 1, 1, 1299.99, 1299.99),
(8, 4, 1, 499.99, 499.99),
(9, 12, 2, 24.99, 49.98),
(9, 13, 1, 24.99, 24.99),
(10, 10, 1, 149.99, 149.99);

-- =====================================================
-- SCHEMA: Reviews
-- =====================================================
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id),
    customer_id INTEGER REFERENCES customers(id),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(255),
    comment TEXT,
    is_verified_purchase BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO reviews (product_id, customer_id, rating, title, comment, is_verified_purchase) VALUES
(1, 1, 5, 'Excellent laptop!', 'Fast, reliable, and great battery life. Highly recommend for developers.', TRUE),
(1, 3, 4, 'Good but pricey', 'Great performance but a bit expensive. Still worth it though.', TRUE),
(3, 5, 5, 'Best phone I''ve owned', 'Amazing camera and the screen is gorgeous. Battery lasts all day.', TRUE),
(5, 3, 5, 'Perfect noise cancellation', 'These headphones are incredible. Can''t hear anything with ANC on.', TRUE),
(7, 2, 4, 'Comfortable fit', 'Nice quality cotton, fits true to size. Would buy again.', TRUE),
(11, 4, 5, 'Must-read for programmers', 'Comprehensive and well-written. Every developer should read this.', TRUE),
(12, 7, 4, 'Couldn''t put it down', 'Great thriller with unexpected twists. Finished it in two days.', TRUE),
(6, 6, 4, 'Great for workouts', 'Good sound quality and they stay in place during exercise.', TRUE),
(15, 2, 5, 'Perfect tablet', 'Use it for reading, streaming, and light work. Very versatile.', TRUE),
(9, 8, 5, 'Beautiful dress', 'The fabric quality is excellent and it fits perfectly.', TRUE);

-- =====================================================
-- SCHEMA: Shopping Cart
-- =====================================================
CREATE TABLE shopping_carts (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cart_items (
    id SERIAL PRIMARY KEY,
    cart_id INTEGER REFERENCES shopping_carts(id),
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO shopping_carts (customer_id) VALUES (8), (9), (10);

INSERT INTO cart_items (cart_id, product_id, quantity) VALUES
(1, 2, 1),
(1, 6, 2),
(2, 14, 1),
(2, 7, 3),
(3, 3, 1);

-- =====================================================
-- SCHEMA: Inventory Log
-- =====================================================
CREATE TABLE inventory_log (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id),
    change_type VARCHAR(20) NOT NULL,
    quantity_change INTEGER NOT NULL,
    previous_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO inventory_log (product_id, change_type, quantity_change, previous_quantity, new_quantity, reason) VALUES
(1, 'sale', -1, 51, 50, 'Order ORD-2024-001'),
(4, 'sale', -1, 151, 150, 'Order ORD-2024-002'),
(7, 'sale', -1, 501, 500, 'Order ORD-2024-002'),
(5, 'sale', -1, 201, 200, 'Order ORD-2024-003'),
(3, 'sale', -1, 101, 100, 'Order ORD-2024-005'),
(1, 'restock', 20, 50, 70, 'Supplier delivery'),
(7, 'restock', 100, 497, 597, 'Supplier delivery');

-- =====================================================
-- SCHEMA: Coupons
-- =====================================================
CREATE TABLE coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type VARCHAR(20) NOT NULL,
    discount_value DECIMAL(10, 2) NOT NULL,
    min_order_amount DECIMAL(10, 2),
    max_uses INTEGER,
    current_uses INTEGER DEFAULT 0,
    valid_from TIMESTAMP,
    valid_until TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_uses, valid_from, valid_until) VALUES
('WELCOME10', 'percentage', 10.00, 50.00, 1000, '2024-01-01', '2024-12-31'),
('SAVE20', 'percentage', 20.00, 100.00, 500, '2024-01-01', '2024-06-30'),
('FLAT50', 'fixed', 50.00, 200.00, 200, '2024-01-01', '2024-12-31'),
('FREESHIP', 'shipping', 100.00, 75.00, NULL, '2024-01-01', '2024-12-31'),
('VIP25', 'percentage', 25.00, 150.00, 100, '2024-01-01', '2024-12-31');

-- =====================================================
-- Create indexes for performance
-- =====================================================
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_addresses_customer ON addresses(customer_id);

-- =====================================================
-- Database info
-- =====================================================
-- Tables: 12
-- Total records: ~100
-- Use cases: Customer management, Product catalog,
--            Order processing, Inventory tracking,
--            Reviews, Shopping cart, Promotions
-- =====================================================
