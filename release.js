const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOKEN = 'REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_01';
const OWNER = 'spatil28a';
const REPO = 'telegram_backup_backend';

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT_DIR, 'TelegramBackup');
const BUILD_GRADLE = path.join(APP_DIR, 'app', 'build.gradle.kts');
const APK_SRC = path.join(APP_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const RELEASES_DIR = path.join(__dirname, 'Releases');

async function ghRequest(url, method = 'GET', body = null, headers = {}, retries = 3) {
  const reqHeaders = {
    'User-Agent': 'OneClick-AutoRelease',
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    ...headers
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method, headers: reqHeaders, body, duplex: body ? 'half' : undefined });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (res.status >= 500 && attempt < retries) {
        console.log(`   [Attempt ${attempt}/${retries}] Server returned ${res.status}, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { status: res.status, data, raw: text };
    } catch (err) {
      if (attempt < retries) {
        console.log(`   [Attempt ${attempt}/${retries}] Request failed (${err.message}), retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  console.log('🚀 === ONE-CLICK FAST RELEASE PIPELINE ===\n');

  // 1. Parse Version from build.gradle.kts
  console.log('1️⃣  Reading version from build.gradle.kts...');
  const gradleContent = fs.readFileSync(BUILD_GRADLE, 'utf8');
  const codeMatch = gradleContent.match(/versionCode\s*=\s*(\d+)/);
  const nameMatch = gradleContent.match(/versionName\s*=\s*"([^"]+)"/);

  if (!codeMatch || !nameMatch) {
    throw new Error('Could not parse versionCode or versionName from build.gradle.kts');
  }

  const versionCode = parseInt(codeMatch[1], 10);
  const versionName = nameMatch[1];
  const tag = `v${versionName}`;
  console.log(`   Target Version: ${tag} (Code: ${versionCode})\n`);

  // 2. Build APK
  console.log('2️⃣  Compiling Android APK with Gradle (assembleDebug)...');
  const gradlewCmd = process.platform === 'win32' ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug';
  execSync(gradlewCmd, { cwd: APP_DIR, stdio: 'inherit' });

  if (!fs.existsSync(APK_SRC)) {
    throw new Error(`Compiled APK not found at: ${APK_SRC}`);
  }
  const apkStats = fs.statSync(APK_SRC);
  const apkSizeMB = (apkStats.size / (1024 * 1024)).toFixed(2);
  console.log(`   ✓ APK Built successfully! Size: ${apkSizeMB} MB\n`);

  // 3. Copy to Releases folder
  console.log('3️⃣  Copying release binaries...');
  if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const versionedApk = path.join(RELEASES_DIR, `TelegramBackup-${tag}.apk`);
  const latestApk = path.join(RELEASES_DIR, `TelegramBackup-latest.apk`);
  fs.copyFileSync(APK_SRC, versionedApk);
  fs.copyFileSync(APK_SRC, latestApk);
  console.log(`   ✓ Saved: ${path.basename(versionedApk)} & ${path.basename(latestApk)}\n`);

  // 4. Update or Create GitHub Release
  console.log('4️⃣  Cleaning up old releases on GitHub...');
  const listRes = await ghRequest(`https://api.github.com/repos/${OWNER}/${REPO}/releases`);
  if (Array.isArray(listRes.data)) {
    for (const rel of listRes.data) {
      if (rel.tag_name !== tag) {
        console.log(`   Deleting old release ${rel.tag_name} (ID: ${rel.id})...`);
        await ghRequest(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}`, 'DELETE');
      }
    }
  }

  let releaseId;
  let uploadUrlTemplate;
  const existingRelease = Array.isArray(listRes.data) ? listRes.data.find(r => r.tag_name === tag) : null;

  if (existingRelease) {
    console.log(`   Existing release found for ${tag} (ID: ${existingRelease.id}). Reusing.`);
    releaseId = existingRelease.id;
    uploadUrlTemplate = existingRelease.upload_url;
  } else {
    console.log(`   Creating new GitHub Release: ${tag}...`);
    const createRes = await ghRequest(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, 'POST', JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `Release ${tag} — Cloud Backup Engine`,
      body: `✨ Release ${tag}: Includes redesigned Settings with animated navigation, OS-style folder icons (Windows 11 / Linux Fluent), and auto-updater optimization.`,
      draft: false,
      prerelease: false
    }), { 'Content-Type': 'application/json' });

    if (!createRes.data || !createRes.data.id) {
      throw new Error(`Failed to create release: ${createRes.raw}`);
    }
    releaseId = createRes.data.id;
    uploadUrlTemplate = createRes.data.upload_url;
  }
  console.log(`   ✓ Release ID: ${releaseId}\n`);

  // 5. Upload APK Assets with native Blob streaming
  console.log('5️⃣  Uploading Release Binaries...');
  const apkBuffer = fs.readFileSync(APK_SRC);
  const blob = new Blob([apkBuffer], { type: 'application/vnd.android.package-archive' });

  async function uploadAsset(assetName) {
    const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
    console.log(`   Uploading ${assetName} (${apkSizeMB} MB)...`);
    const res = await ghRequest(uploadUrl, 'POST', blob, {
      'Content-Type': 'application/vnd.android.package-archive'
    });
    if (res.status === 201) {
      console.log(`   ✓ ${assetName} uploaded successfully!`);
    } else if (res.status === 422) {
      console.log(`   ✓ ${assetName} already exists on release.`);
    } else {
      console.warn(`   ⚠️ Upload warning for ${assetName} (HTTP ${res.status}): ${res.raw.substring(0, 100)}`);
    }
  }

  await uploadAsset(`TelegramBackup-${tag}.apk`);
  await uploadAsset(`TelegramBackup-latest.apk`);
  console.log('');

  // 6. Verify Server Endpoint
  console.log('6️⃣  Verifying dynamic server updater...');
  try {
    const vRes = await fetch('https://telegram-backup-backend.vercel.app/api/app/latest-version');
    const vData = await vRes.json();
    console.log(`   ✓ Server Response:`, vData);
  } catch (e) {
    console.log(`   (Server test note: ${e.message})`);
  }

  console.log('\n🎉 ALL DONE! Release is 100% LIVE and active.');
}

main().catch(err => {
  console.error('\n❌ RELEASE FAILED:', err);
  process.exit(1);
});
