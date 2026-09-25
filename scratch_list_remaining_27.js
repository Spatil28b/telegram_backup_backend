const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const res = await pool.query(
    "SELECT id, file_name, total_chunks, size, timestamp, telegram_file_id " +
    "FROM backed_files WHERE total_chunks > 1 AND (chunks_json IS NULL OR chunks_json = '[]') " +
    "ORDER BY id ASC"
  );
  console.log(`Remaining ${res.rows.length} incomplete files:`);
  for (const r of res.rows) {
    const d = new Date(Number(r.timestamp)).toISOString();
    console.log(`- [${r.id}] ${r.file_name} | chunks=${r.total_chunks} | size=${r.size}b | date=${d}`);
  }
  await pool.end();
}
main().catch(console.error);
