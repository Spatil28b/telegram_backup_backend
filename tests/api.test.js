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
