const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const zed = await pool.query("SELECT * FROM backed_files WHERE file_name ILIKE '%zed%'");
  console.log('Zed in DB:', JSON.stringify(zed.rows, null, 2));

  const apkList = await pool.query(
    "SELECT id, file_name, total_chunks, size, timestamp, message_id, " +
    "LENGTH(chunks_json) as chunks_len, chunks_json " +
    "FROM backed_files WHERE file_name ILIKE '%.apk' ORDER BY id ASC"
  );
  console.log('All APKs in DB:');
  for (const a of apkList.rows) {
    const chunkSummary = a.chunks_json && a.chunks_json !== '[]' ? `${JSON.parse(a.chunks_json).length} chunks recorded` : 'EMPTY CHUNKS';
    const dateStr = new Date(Number(a.timestamp)).toISOString();
    console.log(`- [${a.id}] ${a.file_name} (${a.total_chunks} parts, ${a.size}b) | msg_id=${a.message_id} | date=${dateStr} | ${chunkSummary}`);
  }
  await pool.end();
}
check().catch(console.error);
