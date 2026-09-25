const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const duplicates = await pool.query(`
    SELECT file_name, count(*) as count, array_agg(id) as ids, array_agg(total_chunks) as chunks, array_agg(length(chunks_json)) as json_lens
    FROM backed_files
    GROUP BY file_name
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 20
  `);
  console.log(`Found ${duplicates.rows.length} files with duplicate rows in backed_files:`);
  for (const d of duplicates.rows) {
    console.log(`- ${d.file_name}: ${d.count} rows | IDs: [${d.ids.join(', ')}] | total_chunks: [${d.chunks.join(', ')}] | json_lens: [${d.json_lens.join(', ')}]`);
  }
  await pool.end();
}
run();
