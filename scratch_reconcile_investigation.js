const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const allRes = await pool.query(
    "SELECT count(*) as total, " +
    "count(*) FILTER (WHERE total_chunks > 1 AND (chunks_json IS NULL OR chunks_json = '[]')) as incomplete, " +
    "count(*) FILTER (WHERE total_chunks > 1 AND chunks_json != '[]' AND chunks_json IS NOT NULL) as complete_multi, " +
    "count(*) FILTER (WHERE total_chunks <= 1) as single FROM backed_files"
  );
  console.log('Backed files stats:', allRes.rows[0]);

  const samples = await pool.query(
    "SELECT id, file_name, total_chunks, size, telegram_file_id, message_id, chunks_json " +
    "FROM backed_files WHERE total_chunks > 1 AND (chunks_json IS NULL OR chunks_json = '[]') " +
    "ORDER BY id DESC LIMIT 15"
  );
  console.log('\nSample incomplete files (latest 15):');
  for (const s of samples.rows) {
    const tgId = s.telegram_file_id ? s.telegram_file_id.substring(0, 15) + '...' : 'none';
    console.log(`ID ${s.id}: ${s.file_name} | total_chunks=${s.total_chunks} | size=${s.size} | msg_id=${s.message_id} | tg_id=${tgId}`);
  }

  // Check how many incomplete files have message_id > 0
  const msgCount = await pool.query(
    "SELECT count(*) as has_msg FROM backed_files WHERE total_chunks > 1 AND (chunks_json IS NULL OR chunks_json = '[]') AND message_id > 0"
  );
  console.log('\nIncomplete files with message_id > 0:', msgCount.rows[0].has_msg);

  // Check message_id distribution of incomplete files
  const msgDist = await pool.query(
    "SELECT min(message_id) as min_msg, max(message_id) as max_msg FROM backed_files WHERE message_id > 0"
  );
  console.log('Message ID range across all backed_files:', msgDist.rows[0]);

  await pool.end();
}
check().catch(console.error);
