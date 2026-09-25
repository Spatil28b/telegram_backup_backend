const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const res = await pool.query("SELECT count(*) as c FROM backed_files WHERE chunks_json = '[]' AND total_chunks > 1");
  console.log('Incomplete multi-chunk files in Neon DB:', res.rows[0].c);

  const files = await pool.query("SELECT id, file_name, total_chunks, size FROM backed_files WHERE chunks_json = '[]' AND total_chunks > 1 ORDER BY total_chunks DESC");
  console.log('Top 15 largest chunk files:');
  for (let i = 0; i < Math.min(15, files.rows.length); i++) {
    const f = files.rows[i];
    console.log(`- ${f.file_name} (${f.total_chunks} chunks, ${f.size} bytes)`);
  }
  await pool.end();
}
run().catch(console.error);
