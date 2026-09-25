const crypto = require('crypto');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const KEY = "AES256-b8c355d122b14ccbb724a86e";
const CHAT_ID = "-1004335951585";

function deriveKey(secretKey) { return crypto.createHash('sha256').update(secretKey, 'utf8').digest(); }
function deriveIV(secretKey) { return crypto.createHash('md5').update(secretKey, 'utf8').digest(); }

function decryptText(cipherText, secretKey) {
  try {
    const key = deriveKey(secretKey);
    const iv = deriveIV(secretKey);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(true);
    const decoded = Buffer.from(cipherText, 'base64');
    return Buffer.concat([decipher.update(decoded), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

async function main() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const settings = JSON.parse(settingsRes.rows[0].settings_json);
  const bots = settings.bot_fleet.map(b => b.bot_token);
  console.log(`Available bots: ${bots.length}`);

  // Let's get all incomplete files in DB
  const incomplete = await pool.query(
    "SELECT id, file_name, total_chunks, size, telegram_file_id FROM backed_files WHERE chunks_json = '[]' AND total_chunks > 1"
  );
  console.log(`Incomplete files needing chunks: ${incomplete.rows.length}`);

  // Map by filename
  const neededMap = new Map();
  for (const f of incomplete.rows) {
    neededMap.set(f.file_name, f);
  }

  // Probe a range of messages (e.g. 4100 to 4750)
  console.log("Probing messages 4150 to 4250 to see sample chunks...");
  let foundChunks = 0;

  for (let mId = 4220; mId >= 4180; mId--) {
    const botToken = bots[mId % bots.length];
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          from_chat_id: CHAT_ID,
          message_id: mId,
          disable_notification: true
        })
      }).then(r => r.json());

      if (res.ok && res.result) {
        const copyMsg = res.result;
        const copyId = copyMsg.message_id;
        // delete copy immediately
        fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, message_id: copyId })
        }).catch(() => {});

        let rawCaption = copyMsg.caption || '';
        let caption = rawCaption;
        if (rawCaption.includes('ENC:')) {
          const encBody = rawCaption.substring(rawCaption.indexOf('ENC:') + 4).trim();
          const dec = decryptText(encBody, KEY);
          if (dec) caption = dec;
        }

        const doc = copyMsg.document;
        if (doc) {
          console.log(`Msg ${mId}: doc=${doc.file_name} (${doc.file_size}b) | caption="${caption}"`);
          foundChunks++;
        }
      }
    } catch (e) {
      console.warn(`Msg ${mId} err:`, e.message);
    }
  }

  console.log(`Probed batch done, found ${foundChunks} chunks.`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
