const { Pool } = require('@neondatabase/serverless');
require('dotenv').config({ path: 'server/.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const res = await pool.query("SELECT id, file_name, size, total_chunks, chunks_json FROM backed_files WHERE file_name LIKE '%WhatsApp.apk%' LIMIT 1");
  if (res.rows.length > 0) {
    const r = res.rows[0];
    const chunks = JSON.parse(r.chunks_json || '[]');
    console.log(r.file_name, 'Size:', r.size, 'Total chunks:', r.total_chunks, 'Resolved chunks count:', chunks.length);
    console.log('First 2 chunks:', chunks.slice(0, 2));
    console.log('Last chunk:', chunks[chunks.length - 1]);
  } else {
    console.log('WhatsApp.apk not found');
  }
  await pool.end();
}
check();
