const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  const cols = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='backed_files'"
  );
  console.log("Columns of backed_files:", cols.rows.map(c => c.column_name));

  const res = await pool.query(
    "SELECT * FROM backed_files WHERE file_name ILIKE '%.apk' ORDER BY id DESC LIMIT 10"
  );
  console.log(`Found ${res.rows.length} APK files in backed_files:`);
  for (const r of res.rows) {
    console.log(JSON.stringify(r, null, 2));
  }

  const users = await pool.query("SELECT * FROM users LIMIT 3");
  console.log("\nUsers:", users.rows);

  const settings = await pool.query("SELECT * FROM user_settings LIMIT 3");
  console.log("\nUser Settings:", settings.rows);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
