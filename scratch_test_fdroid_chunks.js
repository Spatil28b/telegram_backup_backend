const { Pool } = require('@neondatabase/serverless');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  const res = await pool.query(
    "SELECT * FROM backed_files WHERE file_name = 'F-Droid.apk'"
  );
  const row = res.rows[0];
  console.log("F-Droid row:", row);

  const chunks = JSON.parse(row.chunks_json);
  console.log("Chunks count:", chunks.length);

  for (const c of chunks) {
    console.log(`Getting path for chunk ${c.chunkIndex}...`);
    const fileRes = await fetch(`https://api.telegram.org/bot${c.botTokenUsed}/getFile?file_id=${c.telegramFileId}`).then(r => r.json());
    if (!fileRes.ok) {
      console.error(`Failed to get file for chunk ${c.chunkIndex}:`, fileRes);
      continue;
    }
    const filePath = fileRes.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${c.botTokenUsed}/${filePath}`;
    console.log(`Chunk ${c.chunkIndex} telegram path: ${filePath}`);

    // Fetch first 256 bytes using Range
    const headRes = await fetch(fileUrl, { headers: { Range: 'bytes=0-255' } });
    const ab = await headRes.arrayBuffer();
    const buf = Buffer.from(ab);
    console.log(`Chunk ${c.chunkIndex} head length: ${buf.length}`);
    console.log(`Chunk ${c.chunkIndex} first 16 bytes hex:`, buf.subarray(0, 16).toString('hex'));
    console.log(`Chunk ${c.chunkIndex} first 16 bytes ascii:`, buf.subarray(0, 16).toString('latin1'));
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
