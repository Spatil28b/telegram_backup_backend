const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CHAT_ID = "-1004335951585";

async function main() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const bots = JSON.parse(settingsRes.rows[0].settings_json).bot_fleet.map(b => b.bot_token);
  const botToken = bots[0];

  const fileId = "BQACAgUAAyEGAAMBAnFe4QACEA9qs__ZWvoWqwrdGhmTMt47YLbGWgACCB8AAqwFoVXluk4-PGSGOj0E";
  console.log("Sending document with fileId to read its metadata/caption...");

  // Send document to channel with disable_notification, get result, then delete
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      document: fileId,
      disable_notification: true
    })
  }).then(r => r.json());

  console.log("Send result:", JSON.stringify(res, null, 2));

  if (res.ok && res.result) {
    const copyId = res.result.message_id;
    await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: copyId })
    });
    console.log("Cleaned up temp probe message", copyId);
  }

  await pool.end();
}
main().catch(console.error);
