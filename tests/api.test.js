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

test('Security & Cryptography: AES-256-GCM Magic Header & Stream Decryption', () => {
  const MAGIC_HEADER_GCM = Buffer.from([0x47, 0x43, 0x4D, 0x32, 0x35, 0x36, 0x01, 0x00]); // "GCM256\x01\x00"
  const secretKey = 'my-super-secret-vault-key-32bytes!';
  const key = crypto.createHash('sha256').update(secretKey, 'utf8').digest();
  const nonce = crypto.randomBytes(12);

  // Encrypt sample plaintext using standard AES-256-GCM
  const plaintext = Buffer.from('Hello Secure Telegram Cloud Storage Range and Stream Test Data!');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const fullPayload = Buffer.concat([MAGIC_HEADER_GCM, nonce, ciphertext]);

  // Assert header detection
  assert.equal(fullPayload.subarray(0, 8).equals(MAGIC_HEADER_GCM), true);

  // Assert random-access AES-256-CTR slice decryption matches original slice
  const pStart = 6;
  const pEnd = 24;
  const blockIndex = Math.floor(pStart / 16);
  const counterVal = 2 + blockIndex;
  const ctrIv = Buffer.alloc(16);
  nonce.copy(ctrIv, 0, 0, 12);
  ctrIv.writeUInt32BE(counterVal, 12);

  const alignedCByteStart = 20 + blockIndex * 16;
  const alignedCByteEnd = 20 + pEnd;
  const rawBytes = fullPayload.subarray(alignedCByteStart, alignedCByteEnd + 1);

  const decipher = crypto.createDecipheriv('aes-256-ctr', key, ctrIv);
  const decryptedBlock = Buffer.concat([decipher.update(rawBytes), decipher.final()]);
  const offsetInBlock = pStart % 16;
  const sliceLen = pEnd - pStart + 1;
  const actualSlice = decryptedBlock.subarray(offsetInBlock, offsetInBlock + sliceLen);

  assert.equal(actualSlice.toString('utf8'), plaintext.subarray(pStart, pEnd + 1).toString('utf8'));
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
  const localVer = { versionCode: 141, versionName: '2.6.3' };
  function calculateVersionCode(name) {
    const cleanName = (name || '').replace(/^v/, '').trim();
    if (localVer && localVer.versionName === cleanName && localVer.versionCode) {
      return localVer.versionCode;
    }
    return 106;
  }

  assert.equal(calculateVersionCode('v2.6.3'), 141);
  assert.equal(calculateVersionCode('2.6.3'), 141);
  assert.equal(calculateVersionCode('v2.6.2'), 106);
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

test('Share Creation: Allows unauthenticated requests if bot token is provided', () => {
  function validateShareAuth(req) {
    const userEmail = (req.authenticatedEmail && req.authenticatedEmail.includes('@')) ? req.authenticatedEmail.toLowerCase().trim() : '';
    const { botToken, chunks } = req.body || {};
    if (!userEmail && !botToken && (!Array.isArray(chunks) || chunks.length === 0 || !chunks[0].botTokenUsed)) {
      return { allowed: false, error: 'Missing bot token or authentication to create share link.' };
    }
    return { allowed: true, userEmail };
  }

  // 1. Unauthenticated with bot token: ALLOWED
  assert.deepEqual(validateShareAuth({ body: { botToken: '123456:ABC' } }), { allowed: true, userEmail: '' });

  // 2. Authenticated with JWT email: ALLOWED
  assert.deepEqual(validateShareAuth({ authenticatedEmail: 'user@example.com', body: {} }), { allowed: true, userEmail: 'user@example.com' });

  // 3. No email and no bot token: REJECTED
  assert.equal(validateShareAuth({ body: {} }).allowed, false);
});


