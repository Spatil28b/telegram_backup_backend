const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function run() {
  const r = await pool.query("SELECT id, file_name, total_chunks, chunks_json, message_id FROM backed_files WHERE file_name LIKE '%VID_20260921_191748412%'");
  console.log(r.rows);
  await pool.end();
}
run();
