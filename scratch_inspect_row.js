const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const r = await pool.query("SELECT * FROM backed_files WHERE id IN (327603, 238670, 327602)");
  console.log(r.rows);
  await pool.end();
}
run();
