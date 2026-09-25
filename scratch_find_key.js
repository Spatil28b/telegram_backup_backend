const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// AES/CBC/PKCS5Padding with SHA256 key and MD5 IV
function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}
function deriveIV(secret) {
  return crypto.createHash('md5').update(secret, 'utf8').digest();
}

async function main() {
  // Let's get all possible keys from database: user credentials, settings, bots, etc.
  const users = await pool.query("SELECT * FROM users");
  const settings = await pool.query("SELECT * FROM user_settings");
  const files = await pool.query("SELECT DISTINCT bot_token_used, channel_id FROM backed_files");

  const candidateKeys = new Set();
  // Standard hardcoded candidate keys
  candidateKeys.add("");
  candidateKeys.add("default_aes_key");
  candidateKeys.add("telegram_backup_master_key");
  candidateKeys.add("TelegramBackupKey2025");
  candidateKeys.add("AES256-DEFAULT-KEY");
  candidateKeys.add("master_key");
  candidateKeys.add("backup_key");
  candidateKeys.add("password");
  candidateKeys.add("123456");

  for (const u of users.rows) {
    if (u.email) candidateKeys.add(u.email);
    if (u.credentials) {
      try {
        const c = typeof u.credentials === 'string' ? JSON.parse(u.credentials) : u.credentials;
        if (c.botToken) candidateKeys.add(c.botToken);
        if (c.chatId) candidateKeys.add(c.chatId);
        if (c.encryptionKey) candidateKeys.add(c.encryptionKey);
        if (c.masterKey) candidateKeys.add(c.masterKey);
      } catch (e) {}
    }
  }

  for (const s of settings.rows) {
    if (s.setting_value) candidateKeys.add(s.setting_value);
    if (s.value) candidateKeys.add(s.value);
  }

  for (const f of files.rows) {
    if (f.bot_token_used) candidateKeys.add(f.bot_token_used);
    if (f.channel_id) {
      candidateKeys.add(f.channel_id);
      candidateKeys.add(f.channel_id.replace('-100', ''));
      candidateKeys.add('-100' + f.channel_id.replace('-100', ''));
    }
  }

  console.log(`Testing ${candidateKeys.size} candidate keys on chunk1_head.bin...`);
  const encHeader = fs.readFileSync('chunk1_head.bin');
  // First 8 bytes are ENC256\x01\x00
  const ciphertext = encHeader.subarray(8);

  for (const key of candidateKeys) {
    try {
      const keyBuf = deriveKey(key);
      const ivBuf = deriveIV(key);
      const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, ivBuf);
      decipher.setAutoPadding(false); // don't require full block padding for first 57 bytes
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      
      // Check if decrypted starts with PK\x03\x04
      if (decrypted[0] === 0x50 && decrypted[1] === 0x4b && (decrypted[2] === 0x03 || decrypted[2] === 0x05 || decrypted[2] === 0x07)) {
        console.log(`\n🎉 SUCCESS! MATCHING KEY FOUND: "${key}"`);
        console.log("Decrypted bytes hex:", decrypted.subarray(0, 16).toString('hex'));
        console.log("Decrypted ASCII:", decrypted.subarray(0, 16).toString('latin1'));
        break;
      }
    } catch (e) {
      // ignore cipher error
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
