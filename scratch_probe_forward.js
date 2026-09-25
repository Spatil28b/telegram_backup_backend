const https = require('https');
const crypto = require('crypto');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const BOT_TOKEN = '8859989412:AAE4PZAfr4DR5b9JyfS-sRLMfxHOPw3BXVI';
const CHAT_ID = '-1004335951585';
const KEY = "AES256-b8c355d122b14ccbb724a86e";

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

async function testRange() {
  // Let's forward a message to chat to get the message object
  // Wait, if we forward from CHAT_ID to CHAT_ID, it creates a copy and returns the message with document!
  console.log('Testing forwardMessage on message 4692...');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      from_chat_id: CHAT_ID,
      message_id: 4692,
      disable_notification: true
    })
  }).then(r => r.json());

  console.log('Result for 4692:', JSON.stringify(res, null, 2));

  if (res.ok && res.result) {
    const copyId = res.result.message_id;
    // delete copy immediately
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: copyId })
    });
  }

  await pool.end();
}

testRange().catch(err => {
  console.error(err);
  process.exit(1);
});
