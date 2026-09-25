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

  console.log(`Probing Telegram channel messages (4700 down to 4000) for "zed"...`);

  const found = [];
  for (let mId = 4700; mId >= 4000; mId--) {
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

        if (caption.toLowerCase().includes('zed') || (copyMsg.document && copyMsg.document.file_name && copyMsg.document.file_name.toLowerCase().includes('zed'))) {
          console.log(`🎯 FOUND ZED at Msg ${mId}: "${caption}" doc=${copyMsg.document ? copyMsg.document.file_id : 'no_doc'}`);
          found.push({
            mId,
            caption,
            doc: copyMsg.document
          });
        }
      }
    } catch (e) {}
  }

  console.log(`Found ${found.length} messages for zed.`);
  await pool.end();
}

main().catch(console.error);
