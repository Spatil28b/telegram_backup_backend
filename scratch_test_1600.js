const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CHAT_ID = "-1004335951585";

async function main() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const bots = JSON.parse(settingsRes.rows[0].settings_json).bot_fleet.map(b => b.bot_token);

  console.log("Probing 1600 down to 1580 with 5s timeout...");
  for (let m = 1600; m >= 1580; m--) {
    const bot = bots[m % bots.length];
    try {
      const res = await fetch(`https://api.telegram.org/bot${bot}/forwardMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, from_chat_id: CHAT_ID, message_id: m, disable_notification: true }),
        signal: AbortSignal.timeout(5000)
      }).then(r => r.json());
      console.log(`Msg ${m}: ok=${res.ok} desc=${res.description || 'none'}`);
      if (res.ok && res.result) {
        fetch(`https://api.telegram.org/bot${bot}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, message_id: res.result.message_id })
        }).catch(() => {});
      }
    } catch (e) {
      console.log(`Msg ${m}: error ${e.message}`);
    }
  }
  await pool.end();
}
main().catch(console.error);
