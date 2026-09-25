const { Pool } = require('@neondatabase/serverless');
require('dotenv').config({ path: 'server/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const res = await pool.query(`
    SELECT id, file_name, path, total_chunks, size, 
           jsonb_array_length(CASE WHEN chunks_json = '' OR chunks_json IS NULL THEN '[]'::jsonb ELSE chunks_json::jsonb END) as chunk_count
    FROM backed_files
    WHERE email = 'spatil28a@gmail.com' AND total_chunks > 1
    AND jsonb_array_length(CASE WHEN chunks_json = '' OR chunks_json IS NULL THEN '[]'::jsonb ELSE chunks_json::jsonb END) < total_chunks
    ORDER BY id DESC
  `);
  console.log('Remaining incomplete files in DB:', res.rows.length);
  for (const r of res.rows) {
    console.log(`[${r.id}] ${r.file_name} (${(r.size / (1024*1024)).toFixed(1)}MB) -> ${r.chunk_count}/${r.total_chunks} chunks | path: ${r.path}`);
  }
  await pool.end();
}
check();
