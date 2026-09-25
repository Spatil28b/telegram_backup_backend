const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const buckets = await pool.query(
    "SELECT FLOOR(message_id / 200) * 200 as msg_bucket, COUNT(*) as count, MIN(file_name) as sample_file " +
    "FROM backed_files WHERE message_id > 0 " +
    "GROUP BY msg_bucket ORDER BY msg_bucket ASC"
  );
  console.log('Message ID Buckets in backed_files:');
  for (const b of buckets.rows) {
    console.log(`- Msgs ${b.msg_bucket}..${Number(b.msg_bucket) + 199}: ${b.count} files (sample: ${b.sample_file})`);
  }

  // Also check if zed's telegram_file_id is in backed_files or chunk_upload_progress
  const zed = await pool.query("SELECT * FROM backed_files WHERE file_name ILIKE '%zed%'");
  console.log('\nZed record:', zed.rows[0]);

  await pool.end();
}
check().catch(console.error);
