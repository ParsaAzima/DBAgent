/**
 * Creates ./demo.db with a tiny e-commerce schema for testing the agent.
 * Plain Node script (no build step needed).
 */

import { unlinkSync, existsSync } from 'node:fs';

// Prefer Node's built-in node:sqlite (Node >= 22.5); fall back to better-sqlite3.
let Database;
try {
  Database = (await import('node:sqlite')).DatabaseSync;
} catch {
  const { createRequire } = await import('node:module');
  Database = createRequire(import.meta.url)('better-sqlite3');
}

const FILE = 'demo.db';
if (existsSync(FILE)) unlinkSync(FILE);

const db = new Database(FILE);

db.exec(`
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled')),
  total REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL
);
`);

const insCustomer = db.prepare('INSERT INTO customers (name, email, city) VALUES (?, ?, ?)');
const insProduct = db.prepare('INSERT INTO products (name, category, price) VALUES (?, ?, ?)');
const insOrder = db.prepare('INSERT INTO orders (customer_id, status, total, created_at) VALUES (?, ?, ?, ?)');
const insItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');

const seed = () => {
  db.exec('BEGIN');
  try {
  const customers = [
    ['Ali Rezaei', 'ali@example.com', 'Tehran'],
    ['Sara Ahmadi', 'sara@example.com', 'Isfahan'],
    ['John Smith', 'john@example.com', 'Berlin'],
    ['Maryam Karimi', 'maryam@example.com', 'Shiraz'],
    ['Emma Mueller', 'emma@example.com', 'Munich'],
  ];
  const customerIds = customers.map((c) => insCustomer.run(...c).lastInsertRowid);

  const products = [
    ['Mechanical Keyboard', 'electronics', 89.99],
    ['USB-C Hub', 'electronics', 34.5],
    ['Coffee Mug', 'home', 12.0],
    ['Desk Lamp', 'home', 45.25],
    ['Notebook A5', 'stationery', 6.75],
  ];
  const productIds = products.map((p) => insProduct.run(...p).lastInsertRowid);

  const orders = [
    [customerIds[0], 'paid', 124.49, '2026-09-01 10:15:00'],
    [customerIds[1], 'shipped', 89.99, '2026-09-03 14:30:00'],
    [customerIds[2], 'paid', 51.75, '2026-09-10 09:00:00'],
    [customerIds[0], 'cancelled', 45.25, '2026-09-12 16:45:00'],
    [customerIds[3], 'pending', 18.75, '2026-09-20 11:20:00'],
    [customerIds[4], 'paid', 135.73, '2026-09-25 18:05:00'],
  ];
  const orderIds = orders.map((o) => insOrder.run(...o).lastInsertRowid);

  const items = [
    [orderIds[0], productIds[0], 1, 89.99],
    [orderIds[0], productIds[4], 3, 6.75],
    [orderIds[0], productIds[2], 1, 12.0],
    [orderIds[1], productIds[0], 1, 89.99],
    [orderIds[2], productIds[1], 1, 34.5],
    [orderIds[2], productIds[2], 1, 12.0],
    [orderIds[3], productIds[3], 1, 45.25],
    [orderIds[4], productIds[4], 1, 6.75],
    [orderIds[4], productIds[2], 1, 12.0],
    [orderIds[5], productIds[0], 1, 89.99],
    [orderIds[5], productIds[1], 1, 34.5],
  ];
    for (const i of items) insItem.run(...i);
  db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

seed();

console.log(`✓ Created ${FILE} with demo e-commerce data.`);
db.close();
