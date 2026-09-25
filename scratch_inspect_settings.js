const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  const settings = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const parsed = JSON.parse(settings.rows[0].settings_json);
  console.log("Security:", JSON.stringify(parsed.security, null, 2));
  console.log("Sub settings:", JSON.stringify(parsed.sub_settings, null, 2));

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
