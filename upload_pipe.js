const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = 'REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_01';
const OWNER = 'spatil28a';
const REPO = 'telegram_backup_backend';
const RELEASE_ID = '371833699';
const APK_PATH = path.join(__dirname, 'Releases', 'TelegramBackup-v2.1.22.apk');

function uploadPipe(name) {
  return new Promise((resolve, reject) => {
    const stats = fs.statSync(APK_PATH);
    const options = {
      hostname: 'uploads.github.com',
      path: `/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(name)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'Node-Uploader-Stream',
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stats.size
      }
    };

    console.log(`Starting piped stream for ${name} (${(stats.size/(1024*1024)).toFixed(2)} MB)...`);
    const req = https.request(options, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        console.log(`${name} HTTP Status:`, res.statusCode);
        resolve(res.statusCode);
      });
    });

    req.on('error', reject);
    const stream = fs.createReadStream(APK_PATH);
    stream.pipe(req);
  });
}

async function start() {
  await uploadPipe('TelegramBackup-v2.1.22.apk');
  await uploadPipe('TelegramBackup-latest.apk');
  console.log('ALL DONE!');
}

start().catch(console.error);
