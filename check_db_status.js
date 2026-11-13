const dns = require('dns');
try {
  const resolver = new dns.Resolver();
  resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const origLookup = dns.lookup;
  dns.lookup = function(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolver.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        if (options && options.all) {
          callback(null, addresses.map(a => ({ address: a, family: 4 })));
        } else {
          callback(null, addresses[0], 4);
        }
      } else {
        origLookup(hostname, options, callback);
      }
    });
  };
} catch {}

const { Pool } = require('@neondatabase/serverless');
require('dotenv').config({ path: __dirname + '/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    const res = await pool.query("SELECT COUNT(*) as count FROM backed_files WHERE email = 'spatil28a@gmail.com'");
    console.log("Backed files count for spatil28a@gmail.com:", res.rows[0].count);

    const chunkProgressRes = await pool.query("SELECT COUNT(*) as count FROM chunk_upload_progress");
    console.log("Chunk progress count in DB:", chunkProgressRes.rows[0].count);

    const sample = await pool.query("SELECT file_name, telegram_file_id, total_chunks, message_id, chunks_json FROM backed_files WHERE email = 'spatil28a@gmail.com' LIMIT 5");
    console.log("Sample records:", sample.rows.map(r => ({
      name: r.file_name,
      fileId: r.telegram_file_id,
      chunks: r.total_chunks,
      msgId: r.message_id,
      hasChunksJson: !!(r.chunks_json && r.chunks_json.length > 5)
    })));
  } catch (err) {
    console.error("DB error:", err);
  } finally {
    await pool.end();
  }
}

main();
