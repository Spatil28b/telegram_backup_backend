const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function deriveKey(secret) { return crypto.createHash('sha256').update(secret, 'utf8').digest(); }
function deriveIV(secret) { return crypto.createHash('md5').update(secret, 'utf8').digest(); }

async function fetchBuffer(url) {
  const res = await fetch(url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function main() {
  const res = await pool.query("SELECT * FROM backed_files WHERE file_name = 'F-Droid.apk'");
  const row = res.rows[0];
  const chunks = JSON.parse(row.chunks_json);
  console.log(`Downloading all ${chunks.length} chunks of F-Droid.apk...`);

  const parts = [];
  for (const c of chunks) {
    const fileRes = await fetch(`https://api.telegram.org/bot${c.botTokenUsed}/getFile?file_id=${c.telegramFileId}`).then(r => r.json());
    const filePath = fileRes.result.file_path;
    console.log(`Downloading chunk ${c.chunkIndex} (${fileRes.result.file_size} bytes)...`);
    const buf = await fetchBuffer(`https://api.telegram.org/file/bot${c.botTokenUsed}/${filePath}`);
    console.log(`Chunk ${c.chunkIndex} downloaded: ${buf.length} bytes`);
    parts.push({ index: c.chunkIndex, buf });
  }

  parts.sort((a, b) => a.index - b.index);
  const merged = Buffer.concat(parts.map(p => p.buf));
  console.log(`Merged size: ${merged.length} bytes (DB size: ${row.size})`);

  // Check header
  const magic = merged.subarray(0, 8);
  console.log('Magic header:', magic.toString('latin1'), 'Hex:', magic.toString('hex'));

  // Decrypt using key
  const key = 'AES256-b8c355d122b14ccbb724a86e';
  const ciphertext = merged.subarray(8); // skip ENC256\x01\x00
  const keyBuf = deriveKey(key);
  const ivBuf = deriveIV(key);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, ivBuf);
  // default PKCS7/PKCS5 padding
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  console.log(`Decrypted size: ${decrypted.length} bytes (expected ${row.size})`);

  // Verify ZIP / APK header
  const isZip = decrypted[0] === 0x50 && decrypted[1] === 0x4b && decrypted[2] === 0x03 && decrypted[3] === 0x04;
  console.log('Starts with PK\\x03\\x04:', isZip);

  // Write to disk
  fs.writeFileSync('test_decrypted_F-Droid.apk', decrypted);
  console.log('Saved test_decrypted_F-Droid.apk. Checking zip entries...');

  // Use zipinfo / tar / python or node to verify zip structure
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
