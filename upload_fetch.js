const fs = require('fs');
const path = require('path');

const TOKEN = 'REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_01';
const OWNER = 'spatil28a';
const REPO = 'telegram_backup_backend';
const RELEASE_ID = '371833699';
const APK_PATH = path.join(__dirname, 'Releases', 'TelegramBackup-v2.1.22.apk');

async function uploadFetch(name) {
  const buf = fs.readFileSync(APK_PATH);
  const blob = new Blob([buf], { type: 'application/vnd.android.package-archive' });
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(name)}`;

  console.log(`Uploading ${name} with native fetch (${(buf.length / (1024 * 1024)).toFixed(2)} MB)...`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'Node-Fetch-Uploader',
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/vnd.android.package-archive'
    },
    body: blob,
    duplex: 'half'
  });

  const text = await res.text();
  console.log(`${name} Status:`, res.status, text.substring(0, 100));
}

async function run() {
  await uploadFetch('TelegramBackup-v2.1.22.apk');
  await uploadFetch('TelegramBackup-latest.apk');
  console.log('SUCCESS!');
}

run().catch(console.error);
