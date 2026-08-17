const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = 'REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_01';
const OWNER = 'spatil28a';
const REPO = 'telegram_backup_backend';
const NEW_TAG = 'v2.1.22';
const RELEASE_NAME = 'Release v2.1.22 — Well-Organized Settings UI';
const RELEASE_BODY = '✨ Release v2.1.22: Redesigned Settings Section with 4 structured feature hubs, real-time Search Bar, Live Status Badges, Hero Profile Card, and Quick Diagnostics.';
const APK_PATH = path.join(__dirname, 'Releases', 'TelegramBackup-v2.1.22.apk');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          resolve({ statusCode: res.statusCode, headers: res.headers, data: parsed, raw: body });
        } catch (e) {
          resolve({ statusCode: res.statusCode, headers: res.headers, data: body, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      if (Buffer.isBuffer(data)) {
        req.write(data);
      } else {
        req.write(typeof data === 'string' ? data : JSON.stringify(data));
      }
    }
    req.end();
  });
}

async function run() {
  console.log('Fetching existing releases from GitHub...');
  const listRes = await request({
    hostname: 'api.github.com',
    path: `/repos/${OWNER}/${REPO}/releases`,
    method: 'GET',
    headers: {
      'User-Agent': 'Node-Release-Script',
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (Array.isArray(listRes.data)) {
    for (const rel of listRes.data) {
      if (rel.tag_name !== NEW_TAG) {
        console.log(`Deleting old release: ${rel.tag_name} (ID: ${rel.id})...`);
        await request({
          hostname: 'api.github.com',
          path: `/repos/${OWNER}/${REPO}/releases/${rel.id}`,
          method: 'DELETE',
          headers: {
            'User-Agent': 'Node-Release-Script',
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });
      }
    }
  }

  console.log(`Creating release for ${NEW_TAG}...`);
  const createRes = await request({
    hostname: 'api.github.com',
    path: `/repos/${OWNER}/${REPO}/releases`,
    method: 'POST',
    headers: {
      'User-Agent': 'Node-Release-Script',
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    }
  }, {
    tag_name: NEW_TAG,
    target_commitish: 'main',
    name: RELEASE_NAME,
    body: RELEASE_BODY,
    draft: false,
    prerelease: false
  });

  if (!createRes.data || !createRes.data.id) {
    console.error('Failed to create release:', createRes.data);
    return;
  }

  const releaseId = createRes.data.id;
  const uploadUrlTemplate = createRes.data.upload_url;
  console.log(`Release created! ID: ${releaseId}`);

  const apkStats = fs.statSync(APK_PATH);
  const apkBuffer = fs.readFileSync(APK_PATH);
  console.log(`Uploading ${path.basename(APK_PATH)} (${(apkStats.size / (1024 * 1024)).toFixed(2)} MB)...`);

  const uploadUrlObj = new URL(uploadUrlTemplate.replace(/\{.*\}/, `?name=${encodeURIComponent('TelegramBackup-v2.1.22.apk')}`));
  const uploadRes = await request({
    hostname: uploadUrlObj.hostname,
    path: uploadUrlObj.pathname + uploadUrlObj.search,
    method: 'POST',
    headers: {
      'User-Agent': 'Node-Release-Script',
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': apkStats.size
    }
  }, apkBuffer);
  console.log(`v2.1.22 upload status: ${uploadRes.statusCode}`);

  console.log('Uploading TelegramBackup-latest.apk asset...');
  const uploadLatestUrl = new URL(uploadUrlTemplate.replace(/\{.*\}/, `?name=${encodeURIComponent('TelegramBackup-latest.apk')}`));
  const uploadLatestRes = await request({
    hostname: uploadLatestUrl.hostname,
    path: uploadLatestUrl.pathname + uploadLatestUrl.search,
    method: 'POST',
    headers: {
      'User-Agent': 'Node-Release-Script',
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': apkStats.size
    }
  }, apkBuffer);
  console.log(`Latest upload status: ${uploadLatestRes.statusCode}`);

  console.log('Done!');
}

run().catch(console.error);
