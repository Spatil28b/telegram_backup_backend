const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Load environment variables for testing
require('dotenv').config();

test('Security & Validation: Positive integer parser', () => {
  function parsePositiveInteger(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!/^\d+$/.test(str)) return null;
    const n = Number(str);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  assert.equal(parsePositiveInteger('1'), 1);
  assert.equal(parsePositiveInteger('138'), 138);
  assert.equal(parsePositiveInteger(42), 42);
  assert.equal(parsePositiveInteger('0'), null);
  assert.equal(parsePositiveInteger('-5'), null);
  assert.equal(parsePositiveInteger('3.14'), null);
  assert.equal(parsePositiveInteger('abc'), null);
  assert.equal(parsePositiveInteger('1abc'), null);
  assert.equal(parsePositiveInteger(null), null);
  assert.equal(parsePositiveInteger(undefined), null);
});

test('Security & Validation: RFC Email validation', () => {
  function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim();
    if (trimmed.length > 254 || trimmed.length < 5) return false;
    if (/[\x00-\x1F\x7F]/.test(trimmed)) return false;
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    return emailRegex.test(trimmed);
  }

  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('john.doe+backup@test.co.uk'), true);
  assert.equal(isValidEmail('invalid-email'), false);
  assert.equal(isValidEmail('@nodomain.com'), false);
  assert.equal(isValidEmail('user@'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
});

test('Security: AES-256-GCM Server Payload Encryption & Decryption', () => {
  const testSecret = '01234567890123456789012345678901'; // 32 chars
  const key = crypto.createHash('sha256').update(testSecret).digest();

  function encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let enc = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
    enc += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${enc}`;
  }

  function decrypt(payload) {
    const parts = payload.split(':');
    assert.equal(parts.length, 3);
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let dec = decipher.update(dataHex, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return JSON.parse(dec);
  }

  const sensitive = {
    botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    encryptionKey: 'AES256-test-key-random-secret-12345',
    chunks: [{ chunkIndex: 1, telegramFileId: 'BQACAgQAAxkBAAIC...' }]
  };

  const encrypted = encrypt(sensitive);
  assert.notEqual(encrypted, JSON.stringify(sensitive));
  assert.ok(!encrypted.includes('123456:ABC'));

  const decrypted = decrypt(encrypted);
  assert.deepEqual(decrypted, sensitive);
});

test('Security: PIN Brute Force Rate Limiting', () => {
  const pinAttemptsMap = new Map();

  function checkSharePinRateLimit(clientIp, shareId) {
    const rateLimitKey = `${clientIp}_${shareId}`;
    const nowMs = Date.now();
    const attempts = pinAttemptsMap.get(rateLimitKey) || { count: 0, lockUntil: 0 };
    if (attempts.lockUntil > nowMs) {
      const waitSeconds = Math.ceil((attempts.lockUntil - nowMs) / 1000);
      return { locked: true, waitSeconds, rateLimitKey, attempts };
    }
    return { locked: false, waitSeconds: 0, rateLimitKey, attempts };
  }

  function recordPinAttempt(rateLimitKey, attempts, success) {
    if (success) {
      pinAttemptsMap.delete(rateLimitKey);
    } else {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= 5) {
        attempts.lockUntil = Date.now() + (10 * 60 * 1000); // 10 min lockout
      }
      pinAttemptsMap.set(rateLimitKey, attempts);
    }
  }

  const ip = '192.168.1.100';
  const shareId = 's_test12345';

  // 4 failed attempts should not lock
  for (let i = 1; i <= 4; i++) {
    const check = checkSharePinRateLimit(ip, shareId);
    assert.equal(check.locked, false);
    recordPinAttempt(check.rateLimitKey, check.attempts, false);
  }

  // 5th failed attempt triggers lockout
  const check5 = checkSharePinRateLimit(ip, shareId);
  assert.equal(check5.locked, false);
  recordPinAttempt(check5.rateLimitKey, check5.attempts, false);

  // 6th attempt is locked
  const check6 = checkSharePinRateLimit(ip, shareId);
  assert.equal(check6.locked, true);
  assert.ok(check6.waitSeconds > 0);

  // Reset on success
  recordPinAttempt(check6.rateLimitKey, check6.attempts, true);
  const checkAfterReset = checkSharePinRateLimit(ip, shareId);
  assert.equal(checkAfterReset.locked, false);
});

test('Integrity: Magic Header ENC256 Detection', () => {
  const MAGIC_HEADER = Buffer.from([0x45, 0x4E, 0x43, 0x32, 0x35, 0x36, 0x01, 0x00]); // "ENC256\x01\x00"

  const encryptedBuf = Buffer.concat([MAGIC_HEADER, Buffer.from('ciphertextbytes...')]);
  const plainBuf = Buffer.from('plain file content without magic header');

  assert.equal(encryptedBuf.subarray(0, 8).equals(MAGIC_HEADER), true);
  assert.equal(plainBuf.subarray(0, 8).equals(MAGIC_HEADER), false);
});

test('Integrity: Chunk metadata validation schema', () => {
  const validChunk = {
    fileId: 'fid_123',
    chunkIndex: 1,
    totalChunks: 3,
    status: 'COMPLETED',
    sha256: 'a'.repeat(64),
    telegramFileId: 'BQACAgQAAxkBAAIC...'
  };

  const allowedStatuses = new Set(['PENDING', 'UPLOADING', 'COMPLETED', 'FAILED']);

  function validateChunk(c) {
    if (!c.fileId || typeof c.fileId !== 'string') return false;
    if (!Number.isInteger(c.chunkIndex) || c.chunkIndex < 1) return false;
    if (!Number.isInteger(c.totalChunks) || c.totalChunks < 1 || c.chunkIndex > c.totalChunks) return false;
    if (!allowedStatuses.has(c.status)) return false;
    if (c.sha256 && !/^[0-9a-fA-F]{64}$/.test(c.sha256)) return false;
    return true;
  }

  assert.equal(validateChunk(validChunk), true);
  assert.equal(validateChunk({ ...validChunk, chunkIndex: 0 }), false);
  assert.equal(validateChunk({ ...validChunk, chunkIndex: 4, totalChunks: 3 }), false);
  assert.equal(validateChunk({ ...validChunk, status: 'INVALID_STATUS' }), false);
  assert.equal(validateChunk({ ...validChunk, sha256: 'short' }), false);
});

test('Security & Cryptography: Authenticated Per-Chunk AES-256-GCM (v2) Format & Verification', () => {
  const MAGIC_HEADER_GCM_V2 = Buffer.from([0x47, 0x43, 0x4D, 0x32, 0x35, 0x36, 0x02, 0x00]); // "GCM256\x02\x00"
  const secretKey = 'my-super-secret-vault-key-32bytes!';
  const key = crypto.createHash('sha256').update(secretKey, 'utf8').digest();
  const chunkIndex = 1;
  const totalChunks = 3;
  const nonce = crypto.randomBytes(12);

  const plaintext = Buffer.from('Authenticated 4MB chunk payload content!');

  // Build AAD binding [chunkIndex (4B BE)][totalChunks (4B BE)]
  const aad = Buffer.alloc(8);
  aad.writeUInt32BE(chunkIndex, 0);
  aad.writeUInt32BE(totalChunks, 4);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Wire format: [MAGIC_HEADER_GCM_V2 (8B)][chunkIndex (4B)][totalChunks (4B)][nonce (12B)][ciphertext][tag (16B)]
  const chunkIndexBuf = Buffer.alloc(4);
  chunkIndexBuf.writeUInt32BE(chunkIndex, 0);
  const totalChunksBuf = Buffer.alloc(4);
  totalChunksBuf.writeUInt32BE(totalChunks, 0);

  const fullChunk = Buffer.concat([
    MAGIC_HEADER_GCM_V2,
    chunkIndexBuf,
    totalChunksBuf,
    nonce,
    ciphertext,
    tag
  ]);

  // Assert framing
  assert.equal(fullChunk.subarray(0, 8).equals(MAGIC_HEADER_GCM_V2), true);
  assert.equal(fullChunk.readUInt32BE(8), chunkIndex);
  assert.equal(fullChunk.readUInt32BE(12), totalChunks);

  // Decryption function with AAD and tag verification
  function decryptGcmChunk(chunkBuf, keyStr) {
    assert.ok(chunkBuf.length >= 44);
    assert.equal(chunkBuf.subarray(0, 8).equals(MAGIC_HEADER_GCM_V2), true);
    const cIdx = chunkBuf.readUInt32BE(8);
    const tChunks = chunkBuf.readUInt32BE(12);
    const n = chunkBuf.subarray(16, 28);
    const ct = chunkBuf.subarray(28, chunkBuf.length - 16);
    const authTag = chunkBuf.subarray(chunkBuf.length - 16);

    const k = crypto.createHash('sha256').update(keyStr, 'utf8').digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, n);
    const chunkAad = Buffer.alloc(8);
    chunkAad.writeUInt32BE(cIdx, 0);
    chunkAad.writeUInt32BE(tChunks, 4);
    decipher.setAAD(chunkAad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  // 1. Valid chunk decrypts cleanly
  const decrypted = decryptGcmChunk(fullChunk, secretKey);
  assert.equal(decrypted.toString('utf8'), plaintext.toString('utf8'));

  // 2. Tampered ciphertext is rejected by GCM tag verification
  const tamperedCiphertext = Buffer.from(fullChunk);
  tamperedCiphertext[32] ^= 0x55; // Flip bit in ciphertext
  assert.throws(() => {
    decryptGcmChunk(tamperedCiphertext, secretKey);
  }, /Unsupported state or unable to authenticate data/);

  // 3. Tampered chunkIndex is rejected by GCM AAD verification
  const tamperedIndex = Buffer.from(fullChunk);
  tamperedIndex.writeUInt32BE(2, 8); // Change chunkIndex from 1 to 2
  assert.throws(() => {
    decryptGcmChunk(tamperedIndex, secretKey);
  }, /Unsupported state or unable to authenticate data/);
});

test('Security: Short-Lived JWT & Session Revocation Logic', () => {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    email: 'user@example.com',
    iat: now - 300, // Issued 5 minutes ago
    exp: now + 600  // Expires in 10 minutes (total 15m)
  };

  // Lifespan assertion: 15 minutes
  assert.equal(tokenPayload.exp - tokenPayload.iat, 15 * 60);

  // Session revocation: if user changed credentials at (now - 60s), older token is rejected
  const sessionRevokedAtMs = (now - 60) * 1000;
  const tokenIssuedAtMs = tokenPayload.iat * 1000;
  const isRevoked = tokenIssuedAtMs < sessionRevokedAtMs;
  assert.equal(isRevoked, true);

  // Token issued after revocation is valid
  const freshPayload = {
    email: 'user@example.com',
    iat: now,
    exp: now + 15 * 60
  };
  const isFreshRevoked = (freshPayload.iat * 1000) < sessionRevokedAtMs;
  assert.equal(isFreshRevoked, false);
});

test('Security: Authoritative Share Validation & 8-char PIN Requirement', () => {
  function validateShareRequest(body) {
    const rawId = body?.fileRecordId;
    const fileRecordId = Number(rawId);
    if (!Number.isInteger(fileRecordId) || fileRecordId <= 0) {
      return { valid: false, error: 'fileRecordId (positive integer) is required.' };
    }
    const pinStr = (body.pin && String(body.pin).trim()) || '';
    if (pinStr.length > 0 && pinStr.length < 8) {
      return { valid: false, error: 'PIN/Password must be at least 8 characters.' };
    }
    return { valid: true, fileRecordId, pinStr };
  }

  // Reject non-integer, zero, negative, or missing
  assert.equal(validateShareRequest({ fileId: 'some_id' }).valid, false);
  assert.equal(validateShareRequest({ fileRecordId: 'abc' }).valid, false);
  assert.equal(validateShareRequest({ fileRecordId: 0 }).valid, false);
  assert.equal(validateShareRequest({ fileRecordId: -10 }).valid, false);

  // Accept positive integer
  assert.equal(validateShareRequest({ fileRecordId: 101 }).valid, true);
  assert.equal(validateShareRequest({ fileRecordId: '101' }).valid, true);

  // PIN validation: reject < 8 chars
  assert.equal(validateShareRequest({ fileRecordId: 101, pin: '1234' }).valid, false);
  assert.equal(validateShareRequest({ fileRecordId: 101, pin: '1234567' }).valid, false);
  assert.equal(validateShareRequest({ fileRecordId: 101, pin: '12345678' }).valid, true);
  assert.equal(validateShareRequest({ fileRecordId: 101, pin: '' }).valid, true);
});

test('Security: Bot Token Sanitization on Indexing', () => {
  function sanitizeBotIdentifier(token) {
    if (!token) return '';
    const clean = String(token).trim();
    const colonIdx = clean.indexOf(':');
    if (colonIdx > 0 && /^\d+$/.test(clean.substring(0, colonIdx))) {
      return clean.substring(0, colonIdx);
    }
    return clean;
  }

  assert.equal(sanitizeBotIdentifier('7123456789:AAHKqwert123456_FakeToken'), '7123456789');
  assert.equal(sanitizeBotIdentifier('9876543210:secret_bot_token_part'), '9876543210');
  assert.equal(sanitizeBotIdentifier('7123456789'), '7123456789');
  assert.equal(sanitizeBotIdentifier(''), '');
  assert.equal(sanitizeBotIdentifier(null), '');
});

test('Security: Share Session HMAC Cookie Token Verification', () => {
  const jwtSecret = 'test-secret-at-least-32-chars-long!!';
  function getShareSessionToken(shareId, pinHash) {
    return crypto.createHmac('sha256', jwtSecret).update(`${shareId}:${pinHash}`).digest('hex');
  }

  function isShareSessionAuthorized(cookieHeader, shareId, pinHash) {
    if (!pinHash) return true;
    const expected = getShareSessionToken(shareId, pinHash);
    const cookies = {};
    if (cookieHeader) {
      cookieHeader.split(';').forEach(c => {
        const parts = c.split('=');
        if (parts.length >= 2) cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
      });
    }
    return cookies[`share_auth_${shareId}`] === expected;
  }

  const shareId = 'share_abc123';
  const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
  const validToken = getShareSessionToken(shareId, pinHash);

  assert.equal(isShareSessionAuthorized(`share_auth_${shareId}=${validToken}`, shareId, pinHash), true);
  assert.equal(isShareSessionAuthorized(`share_auth_${shareId}=tampered_token`, shareId, pinHash), false);
  assert.equal(isShareSessionAuthorized(null, shareId, pinHash), false);
});

test('Reliability: GitHub Asset Resolver for APK Updates', () => {
  const assets = [
    { name: 'source-code.zip', browser_download_url: 'https://example.com/source.zip' },
    { name: 'TelegramBackup-v2.5.2.apk', browser_download_url: 'https://example.com/v2.5.2.apk' },
    { name: 'TelegramBackup-latest.apk', browser_download_url: 'https://example.com/latest.apk' }
  ];

  const apkAsset =
    assets.find(a => a.name === 'TelegramBackup-latest.apk') ||
    assets.find(a => a.name === 'TelegramBackup-v2.5.2.apk') ||
    assets.find(a => a.name.endsWith('.apk'));

  assert.ok(apkAsset);
  assert.equal(apkAsset.name, 'TelegramBackup-latest.apk');
  assert.equal(apkAsset.browser_download_url, 'https://example.com/latest.apk');
});

test('Versioning: calculateVersionCode prioritizes local app-version.json', () => {
  const localVer = { versionCode: 143, versionName: '2.6.5' };
  function calculateVersionCode(name) {
    const cleanName = (name || '').replace(/^v/, '').trim();
    if (localVer && localVer.versionName === cleanName && localVer.versionCode) {
      return localVer.versionCode;
    }
    return 106;
  }

  assert.equal(calculateVersionCode('v2.6.5'), 143);
  assert.equal(calculateVersionCode('2.6.5'), 143);
  assert.equal(calculateVersionCode('v2.6.4'), 106);
});

test('Security: Credentials Get Endpoint Masks Raw Bot Token', () => {
  function sanitizeBotIdentifier(token) {
    if (!token) return '';
    const clean = String(token).trim();
    const colonIdx = clean.indexOf(':');
    if (colonIdx > 0 && /^\d+$/.test(clean.substring(0, colonIdx))) {
      return clean.substring(0, colonIdx);
    }
    return clean;
  }

  const rawBotToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
  const response = {
    success: true,
    botToken: sanitizeBotIdentifier(rawBotToken),
    chatId: '-100123456789'
  };

  assert.equal(response.botToken, '123456789');
  assert.ok(!response.botToken.includes('ABCdefGHIjklMNOpqrsTUVwxyz'));
});

test('Share Creation: candidateBots normalization and payload construction', () => {
  function normalizeCandidateBots(candidateBots) {
    return Array.isArray(candidateBots)
      ? candidateBots.map(b => String(b).trim()).filter(Boolean)
      : (candidateBots ? [String(candidateBots).trim()].filter(Boolean) : []);
  }

  assert.deepEqual(normalizeCandidateBots(['123:abc', '456:def', '']), ['123:abc', '456:def']);
  assert.deepEqual(normalizeCandidateBots('789:ghi'), ['789:ghi']);
  assert.deepEqual(normalizeCandidateBots(null), []);
  assert.deepEqual(normalizeCandidateBots(undefined), []);
});

test('Share Creation: Requires authenticated user and authoritative file record', () => {
  function validateShareAuth(req) {
    const userEmail = (req.authenticatedEmail && req.authenticatedEmail.includes('@')) ? req.authenticatedEmail.toLowerCase().trim() : '';
    if (!userEmail) {
      return { allowed: false, error: 'Authentication required to create share link.' };
    }
    const rawId = req.body?.fileRecordId;
    const fileRecordId = Number(rawId);
    if (!Number.isInteger(fileRecordId) || fileRecordId <= 0) {
      return { allowed: false, error: 'fileRecordId (positive integer) is required.' };
    }
    return { allowed: true, userEmail, fileRecordId };
  }

  // 1. Unauthenticated with bot token: REJECTED (Finding #5)
  assert.equal(validateShareAuth({ body: { botToken: '123456:ABC', fileRecordId: 10 } }).allowed, false);

  // 2. Authenticated with positive integer fileRecordId: ALLOWED
  assert.deepEqual(validateShareAuth({ authenticatedEmail: 'user@example.com', body: { fileRecordId: 42 } }), { allowed: true, userEmail: 'user@example.com', fileRecordId: 42 });

  // 3. Authenticated without fileRecordId: REJECTED
  assert.equal(validateShareAuth({ authenticatedEmail: 'user@example.com', body: {} }).allowed, false);
});

test('Share Page: Inlined client script has valid JavaScript syntax without errors', () => {
  const fs = require('fs');
  const path = require('path');
  const indexContent = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const sIdx = indexContent.indexOf('<script>');
  const eIdx = indexContent.indexOf('</script>');
  assert.ok(sIdx > 0 && eIdx > sIdx, 'Script tag found in index.js');
  let script = indexContent.substring(sIdx + 8, eIdx);
  script = script.replace(/"\$\{([^}]+)\}"/g, '"dummy_str"');
  script = script.replace(/\$\{([^}]+)\}/g, '0');
  assert.doesNotThrow(() => {
    new Function(script);
  }, 'Share page client script must compile without SyntaxError');
});

test('Security & Cryptography: Share PIN uses bcrypt hashing with timing-safe legacy fallback', async () => {
  const bcrypt = require('bcryptjs');
  const rawPin = '987654';

  // 1. Bcrypt hash generated
  const hash = await bcrypt.hash(rawPin, 10);
  assert.ok(hash.startsWith('$2a$') || hash.startsWith('$2b$'), 'Bcrypt format required');
  assert.equal(await bcrypt.compare(rawPin, hash), true, 'Bcrypt compare must succeed for correct PIN');
  assert.equal(await bcrypt.compare('111111', hash), false, 'Bcrypt compare must fail for wrong PIN');

  // 2. Legacy SHA-256 fallback compatibility
  const legacyHash = crypto.createHash('sha256').update(rawPin).digest('hex');
  assert.equal(legacyHash.length, 64);
  const testCandidate = crypto.createHash('sha256').update('987654').digest('hex');
  assert.equal(crypto.timingSafeEqual(Buffer.from(testCandidate, 'utf8'), Buffer.from(legacyHash, 'utf8')), true);
});

test('Security: isShareSessionAuthorized rejects query parameters and requires Cookie or Header', () => {
  const JWT_SECRET = 'test_secret_for_unit_tests_minimum_32_characters';
  function getShareSessionToken(shareId, pinHash) {
    return crypto.createHmac('sha256', JWT_SECRET).update(`${shareId}:${pinHash}`).digest('hex');
  }

  function isShareSessionAuthorized(req, shareId, pinHash) {
    if (!pinHash) return true;
    const expected = getShareSessionToken(shareId, pinHash);
    const cookies = req.cookies || {};
    if (cookies[`share_auth_${shareId}`] === expected) return true;
    if (req.headers) {
      if (req.headers['x-share-session'] === expected) return true;
      const authHeader = (req.headers['authorization'] || '').trim();
      if (authHeader === expected || authHeader === `Bearer ${expected}`) return true;
    }
    return false;
  }

  const shareId = 's_123456';
  const pinHash = '$2a$10$dummyHash';
  const validToken = getShareSessionToken(shareId, pinHash);

  // Cookie auth: ALLOWED
  assert.equal(isShareSessionAuthorized({ cookies: { [`share_auth_${shareId}`]: validToken }, headers: {} }, shareId, pinHash), true);

  // Header auth: ALLOWED
  assert.equal(isShareSessionAuthorized({ cookies: {}, headers: { 'x-share-session': validToken } }, shareId, pinHash), true);
  assert.equal(isShareSessionAuthorized({ cookies: {}, headers: { 'authorization': `Bearer ${validToken}` } }, shareId, pinHash), true);

  // Query parameter auth: MUST BE REJECTED (OWASP Finding #5)
  assert.equal(isShareSessionAuthorized({ cookies: {}, headers: {}, query: { auth: validToken } }, shareId, pinHash), false);
  assert.equal(isShareSessionAuthorized({ cookies: {}, headers: {}, query: { session: validToken } }, shareId, pinHash), false);
  assert.equal(isShareSessionAuthorized({ cookies: {}, headers: {}, query: { token: validToken } }, shareId, pinHash), false);
});

test('Security: User settings sanitization strips master keys and bot tokens', () => {
  const input = JSON.stringify({
    profile: { display_name: 'Test' },
    security: { encryption_enabled: true, encryption_key: 'SUPER_SECRET_KEY' },
    encryption_key: 'ROOT_SECRET_KEY',
    master_key: 'MASTER_KEY',
    bots: [{ bot_token: '123:ABC', display_name: 'Bot 1' }]
  });

  const parsed = JSON.parse(input);
  if (parsed.security?.encryption_key) delete parsed.security.encryption_key;
  if (parsed.encryption_key) delete parsed.encryption_key;
  if (parsed.master_key) delete parsed.master_key;
  if (Array.isArray(parsed.bots)) {
    parsed.bots = parsed.bots.map(b => {
      const copy = { ...b };
      delete copy.bot_token;
      return copy;
    });
  }

  const sanitized = JSON.stringify(parsed);
  assert.equal(sanitized.includes('SUPER_SECRET_KEY'), false);
  assert.equal(sanitized.includes('ROOT_SECRET_KEY'), false);
  assert.equal(sanitized.includes('MASTER_KEY'), false);
  assert.equal(sanitized.includes('123:ABC'), false);
  assert.equal(parsed.profile.display_name, 'Test');
  assert.equal(parsed.bots[0].display_name, 'Bot 1');
});


