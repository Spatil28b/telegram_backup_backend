const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = 'REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_01';
const OWNER = 'spatil28a';
const REPO = 'telegram_backup_backend';
const RELEASE_ID = '371833699';
const APK_PATH = path.join(__dirname, 'Releases', 'TelegramBackup-v2.1.22.apk');

function uploadAsset(assetName, buffer) {
  return new Promise((resolve, reject) => {
    const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(assetName)}`;
    const urlObj = new URL(uploadUrl);

    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'User-Agent': 'Node-Upload',
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': buffer.length
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });

    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function main() {
  const buf = fs.readFileSync(APK_PATH);
  console.log(`Uploading TelegramBackup-v2.1.22.apk (${(buf.length / (1024 * 1024)).toFixed(2)} MB)...`);
  const r1 = await uploadAsset('TelegramBackup-v2.1.22.apk', buf);
  console.log('r1 status:', r1.status);

  console.log(`Uploading TelegramBackup-latest.apk (${(buf.length / (1024 * 1024)).toFixed(2)} MB)...`);
  const r2 = await uploadAsset('TelegramBackup-latest.apk', buf);
  console.log('r2 status:', r2.status);
  console.log('DONE!');
}

main().catch(console.error);
