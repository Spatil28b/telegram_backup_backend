const https = require('https');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const settings = JSON.parse(settingsRes.rows[0].settings_json);
  const botFleet = settings.bot_fleet || [];
  console.log(`Bot fleet count: ${botFleet.length}`);

  const activeBot = botFleet.find(b => b.is_primary) || botFleet[0];
  const token = activeBot.bot_token;
  console.log(`Using bot: ${activeBot.display_name} (${activeBot.bot_username || 'no user'})`);

  // Get primary channel
  const channels = settings.channels || {};
  console.log("Channels in settings:", channels);

  // Check channel from backed_files
  const channelRes = await pool.query("SELECT DISTINCT channel_id FROM backed_files WHERE channel_id != ''");
  const channelIds = channelRes.rows.map(r => r.channel_id);
  console.log("Channel IDs from backed_files:", channelIds);

  const channelId = channelIds[0] || "-1004335951585";

  // Let's inspect some of the incomplete files
  const incompleteFiles = await pool.query(
    "SELECT id, file_name, size, total_chunks, telegram_file_id, message_id FROM backed_files WHERE chunks_json = '[]' AND total_chunks > 1 ORDER BY id DESC LIMIT 10"
  );
  console.log(`Found ${incompleteFiles.rows.length} sample incomplete files:`);
  for (const f of incompleteFiles.rows) {
    console.log(`- ${f.file_name} (ID: ${f.id}, chunks: ${f.total_chunks}, msg_id: ${f.message_id})`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
