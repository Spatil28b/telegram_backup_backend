const crypto = require('crypto');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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

async function probeMessage(botToken, mId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, from_chat_id: CHAT_ID, message_id: mId, disable_notification: true }),
      signal: AbortSignal.timeout(3000)
    }).then(r => r.json());

    if (res.ok && res.result) {
      const copyMsg = res.result;
      fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, message_id: copyMsg.message_id })
      }).catch(() => {});

      const CANDIDATE_KEYS = [KEY, "", "default_aes_key", "TelegramBackupKey2025", "telegram_backup_master_key", "master_key", "spatil28a@gmail.com", "-1004335951585", "4335951585"];
      let caption = copyMsg.caption || '';
      if (caption.includes('ENC:')) {
        const encBody = caption.substring(caption.indexOf('ENC:') + 4).trim();
        for (const k of CANDIDATE_KEYS) {
          const dec = decryptText(encBody, k);
          if (dec && (dec.includes('[Part') || dec.includes('📦') || dec.includes('📤'))) {
            caption = dec;
            break;
          }
        }
      }

      if (copyMsg.document) {
        return { mId, botToken, doc: copyMsg.document, caption };
      }
    }
  } catch (e) {}
  return null;
}

function safeJsonParse(val, fallback = null) {
  try { return typeof val === 'string' ? JSON.parse(val) : (val || fallback); } catch { return fallback; }
}

async function main() {
  const settingsRes = await pool.query("SELECT settings_json FROM user_settings WHERE email='spatil28a@gmail.com'");
  const row = settingsRes.rows[0];
  if (!row || !row.settings_json) {
    console.error('❌ User settings not found. Cannot load bot fleet.');
    await pool.end();
    return;
  }
  const settings = safeJsonParse(row.settings_json, {});
  const bots = Array.isArray(settings?.bot_fleet)
    ? settings.bot_fleet.map(b => (b.bot_token || '').trim()).filter(Boolean)
    : [];
  if (bots.length === 0) {
    console.error('❌ No active Telegram bots configured in bot_fleet.');
    await pool.end();
    return;
  }

  // Load the remaining incomplete files
  const incompleteRes = await pool.query(
    "SELECT id, file_name, total_chunks, size, telegram_file_id FROM backed_files WHERE total_chunks > 1 AND (chunks_json IS NULL OR chunks_json = '[]')"
  );
  console.log(`Loaded ${incompleteRes.rows.length} remaining incomplete files.`);
  const fileMap = new Map();
  for (const row of incompleteRes.rows) {
    fileMap.set(row.file_name.toLowerCase(), row);
  }

  const discoveredMap = new Map();
  const START = 1600;
  const END = 1;
  const BATCH = Math.max(1, bots.length);

  console.log(`Scanning 1600 down to 1...`);
  let totalDocs = 0;
  let matched = 0;

  for (let current = START; current >= END; current -= BATCH) {
    const promises = [];
    for (let i = 0; i < BATCH; i++) {
      const mId = current - i;
      if (mId < END) break;
      promises.push(probeMessage(bots[i % bots.length], mId));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      if (!r || !r.doc) continue;
      totalDocs++;
      const partMatch = r.caption.match(/\[Part\s*(\d+)\/(\d+)\]/i);
      if (partMatch) {
        const chunkIndex = parseInt(partMatch[1], 10);
        for (const [fnameLower, dbRow] of fileMap.entries()) {
          if (r.caption.toLowerCase().includes(fnameLower) || (r.doc.file_name && r.doc.file_name.toLowerCase().includes(fnameLower))) {
            if (!discoveredMap.has(dbRow.id)) {
              discoveredMap.set(dbRow.id, { dbRow, chunks: new Map() });
            }
            const fileEntry = discoveredMap.get(dbRow.id);
            if (!fileEntry.chunks.has(chunkIndex)) {
              fileEntry.chunks.set(chunkIndex, {
                chunkIndex,
                telegramFileId: r.doc.file_id,
                botTokenUsed: r.botToken,
                messageId: r.mId,
                chunkSize: r.doc.file_size
              });
              matched++;
            }
            break;
          }
        }
      }
    }
    if ((current % 100) === 0 || current <= END) {
      console.log(`Msg ${current} | Docs: ${totalDocs} | Matched: ${matched} | Files: ${discoveredMap.size}`);
    }
  }

  console.log(`\nScan complete! Updating DB for ${discoveredMap.size} files...`);
  for (const [id, entry] of discoveredMap.entries()) {
    const dbRow = entry.dbRow;
    const chunkArray = Array.from(entry.chunks.values()).sort((a, b) => a.chunkIndex - b.chunkIndex);
    const chunksJson = JSON.stringify(chunkArray);
    const minMsgId = chunkArray[0]?.messageId || 0;
    const firstTgId = chunkArray[0]?.telegramFileId || dbRow.telegram_file_id;
    console.log(`Updating [${id}] "${dbRow.file_name}": ${chunkArray.length}/${dbRow.total_chunks} chunks`);
    await pool.query(
      "UPDATE backed_files SET chunks_json = $1, message_id = $2, telegram_file_id = $3 WHERE id = $4",
      [chunksJson, minMsgId, firstTgId, id]
    );
  }

  await pool.end();
}
main().catch(console.error);
