const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

(async () => {
  const client = await pool.connect();
  try {
    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    await client.query(schema);
    const categories = await client.query("select count(*)::int as count from categories");
    const products = await client.query("select count(*)::int as count from products");
    console.log("Database schema initialized:", categories.rows[0].count, "categories,", products.rows[0].count, "products");
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});
