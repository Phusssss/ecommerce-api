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
    const r1 = await client.query("select count(*)::int as count from categories");
    const r2 = await client.query("select count(*)::int as count from products");
    console.log("Database schema initialized:", JSON.stringify(r1.rows[0]), JSON.stringify(r2.rows[0]));
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});
