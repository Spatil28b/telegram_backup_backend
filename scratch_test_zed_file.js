const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const settings = JSON.parse(settingsRes.rows[0].settings_json);
  const bots = settings.bot_fleet.map(b => b.bot_token);

  const fileId = "BQACAgUAAyEGAAMBAnFe4QACEA9qs__ZWvoWqwrdGhmTMt47YLbGWgACCB8AAqwFoVXluk4-PGSGOj0E";
  console.log(`Testing getFile for zed chunk across ${bots.length} bots...`);

  for (let i = 0; i < bots.length; i++) {
    const token = bots[i];
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`).then(r => r.json());
      if (res.ok) {
        console.log(`✅ Bot ${i} found file! File size: ${res.result.file_size}, path: ${res.result.file_path}`);
        break;
      } else {
        console.log(`Bot ${i}: ${res.description}`);
      }
    } catch (e) {
      console.log(`Bot ${i} error: ${e.message}`);
    }
  }

  await pool.end();
}
check().catch(console.error);
