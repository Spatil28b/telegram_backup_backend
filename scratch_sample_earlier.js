const crypto = require('crypto');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const KEY = "AES256-b8c355d122b14ccbb724a86e";
const CHAT_ID = "-1004335951585";

function deriveKey(k) { return crypto.createHash('sha256').update(k).digest(); }
function deriveIV(k) { return crypto.createHash('md5').update(k).digest(); }

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

async function probe(botToken, mId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, from_chat_id: CHAT_ID, message_id: mId, disable_notification: true })
    }).then(r => r.json());

    if (res.ok && res.result) {
      const copyMsg = res.result;
      fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, message_id: copyMsg.message_id })
      }).catch(() => {});

      let caption = copyMsg.caption || '';
      if (caption.includes('ENC:')) {
        const dec = decryptText(caption.substring(caption.indexOf('ENC:') + 4).trim(), KEY);
        if (dec) caption = dec;
      }
      return { mId, doc: copyMsg.document ? copyMsg.document.file_name : null, caption };
    }
  } catch (e) {}
  return null;
}

async function main() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const bots = JSON.parse(settingsRes.rows[0].settings_json).bot_fleet.map(b => b.bot_token);

  console.log("Sampling 1000 to 2900 in steps of 200...");
  for (let m = 2900; m >= 1000; m -= 200) {
    const r = await probe(bots[m % bots.length], m);
    if (r) {
      console.log(`Msg ${m}: doc=${r.doc} | "${r.caption}"`);
    } else {
      console.log(`Msg ${m}: not found`);
    }
  }
  await pool.end();
}
main().catch(console.error);
