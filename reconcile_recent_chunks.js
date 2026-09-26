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

async function probeMessage(botToken, mId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        from_chat_id: CHAT_ID,
        message_id: mId,
        disable_notification: true
      }),
      signal: AbortSignal.timeout(5000)
    }).then(r => r.json());

    if (res.ok && res.result) {
      const copyMsg = res.result;
      const copyId = copyMsg.message_id;
      fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, message_id: copyId })
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
        return {
          mId,
          botToken,
          doc: copyMsg.document,
          caption
        };
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
  console.log(`Initialized fleet with ${bots.length} bots.`);

  // Load all remaining incomplete files from Neon DB
  const incompleteRes = await pool.query(
    "SELECT id, file_name, total_chunks, size, telegram_file_id FROM backed_files WHERE total_chunks > 1 AND (chunks_json IS NULL OR chunks_json = '[]')"
  );
  console.log(`Loaded ${incompleteRes.rows.length} remaining incomplete multi-chunk files from Neon DB.`);

  const fileMap = new Map();
  for (const row of incompleteRes.rows) {
    fileMap.set(row.file_name.toLowerCase(), row);
  }

  const discoveredMap = new Map();

  // Range of messages to crawl: 6380 down to 4700
  const START_MSG = 6380;
  const END_MSG = 4700;
  const BATCH_SIZE = Math.max(1, bots.length);

  console.log(`Crawling recent messages ${START_MSG} down to ${END_MSG}...`);
  let totalDocsFound = 0;
  let matchedChunksCount = 0;

  for (let current = START_MSG; current >= END_MSG; current -= BATCH_SIZE) {
    const promises = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const mId = current - i;
      if (mId < END_MSG) break;
      const bot = bots[i % bots.length];
      promises.push(probeMessage(bot, mId));
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      if (!r || !r.doc) continue;
      totalDocsFound++;

      const partMatch = r.caption.match(/\[Part\s*(\d+)\/(\d+)\]/i);
      if (partMatch) {
        const chunkIndex = parseInt(partMatch[1], 10);
        for (const [fnameLower, dbRow] of fileMap.entries()) {
          if (r.caption.toLowerCase().includes(fnameLower) || (r.doc.file_name && r.doc.file_name.toLowerCase().includes(fnameLower))) {
            if (!discoveredMap.has(dbRow.id)) {
              discoveredMap.set(dbRow.id, {
                dbRow,
                chunks: new Map()
              });
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
              matchedChunksCount++;
            }
            break;
          }
        }
      }
    }

    if ((current % 100) === 0 || current === END_MSG) {
      console.log(`Progress: Checked down to msg ${current} | Docs: ${totalDocsFound} | Matched chunks: ${matchedChunksCount} | Files touched: ${discoveredMap.size}`);
    }
  }

  console.log(`\nCrawl complete! Found chunks for ${discoveredMap.size} files.`);

  // Write discovered chunks to Neon DB
  for (const [id, entry] of discoveredMap.entries()) {
    const dbRow = entry.dbRow;
    const chunkArray = Array.from(entry.chunks.values()).sort((a, b) => a.chunkIndex - b.chunkIndex);
    const chunksJson = JSON.stringify(chunkArray);
    const minMsgId = chunkArray[0]?.messageId || 0;
    const firstTgId = chunkArray[0]?.telegramFileId || dbRow.telegram_file_id;
    const isComplete = chunkArray.length >= dbRow.total_chunks;

    console.log(`Updating [${id}] "${dbRow.file_name}": ${chunkArray.length}/${dbRow.total_chunks} chunks (msg_id: ${minMsgId}) - ${isComplete ? '✅ COMPLETE' : '⚠️ PARTIAL'}`);

    await pool.query(
      "UPDATE backed_files SET chunks_json = $1, message_id = $2, telegram_file_id = $3 WHERE id = $4",
      [chunksJson, minMsgId, firstTgId, id]
    );
  }

  await pool.end();
}

main().catch(console.error);
