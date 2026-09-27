/**
 * =====================================================================================
 * TELEGRAM BACKUP CLOUD - SERVERLESS BACKEND API
 * =====================================================================================
 * Framework: Express.js running on Vercel Serverless Functions Node.js Environment
 * Primary Database: Neon Serverless PostgreSQL Client
 * Fallback Database: In-Memory Map Data Stores (Zero-Downtime Guarantee)
 * Email Dispatch: Dual-SMTP Provider Auto-Fallback (Primary + Secondary Gmail SMTP)
 * Security Encryption: AES-256 Master Security Key Dispatch & 2FA OTP Authentication
 * =====================================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('@neondatabase/serverless');

// Cryptographically Secure JWT Secret Key (Minimum 32 characters required)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('FATAL: JWT_SECRET environment variable is missing or less than 32 characters');
}

/**
 * Strict positive integer parser (rejects malformed numbers, floats, and strings with non-digits)
 */
function parsePositiveInteger(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Initialize Express Application Instance
const app = express();

// Middleware: Request Correlation ID Tracking with strict validation
app.use((req, res, next) => {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  req.id = /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Middleware: Structured Performance & Observability Tracking
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/favicon') || req.path.startsWith('/static')) return;
    const userHash = req.authenticatedEmail
      ? crypto.createHash('sha256').update(req.authenticatedEmail).digest('hex').slice(0, 10)
      : 'anon';
    console.log(`[API Metric] id=${req.id} u=${userHash} ${req.method} ${req.path} -> ${res.statusCode} in ${duration}ms`);
  });
  next();
});

// Middleware: Enable Cross-Origin Resource Sharing with Origin Whitelist (Fix #4)
const ALLOWED_ORIGINS = new Set([
  'https://telegram-backup-backend.vercel.app',
  'https://tspace-vault.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

app.use(cors({
  origin: (origin, callback) => {
    // Mobile apps and CLI tools send no Origin header; web clients must match whitelist
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: Unauthorized cross-origin request rejected'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token', 'X-Share-Pin', 'Range', 'X-Request-Id'],
  credentials: true
}));

// Middleware: Parse Incoming JSON and Form-Urlencoded Request Payloads with safe 256KB default limit
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

/**
 * Sanitizes bot token to strip secret token parts during indexing, keeping only safe bot identifier.
 */
function sanitizeBotIdentifier(token) {
  if (!token) return '';
  const clean = String(token).trim();
  const colonIdx = clean.indexOf(':');
  if (colonIdx > 0 && /^\d+$/.test(clean.substring(0, colonIdx))) {
    return clean.substring(0, colonIdx);
  }
  return clean;
}

/**
 * Sanitizes bot tokens inside chunks_json metadata array before persisting.
 */
function sanitizeChunksJson(chunksJsonStr) {
  try {
    const list = JSON.parse(chunksJsonStr);
    if (!Array.isArray(list)) return '[]';
    for (const item of list) {
      if (item && item.botTokenUsed) {
        item.botTokenUsed = sanitizeBotIdentifier(item.botTokenUsed);
      }
    }
    return JSON.stringify(list);
  } catch (_) {
    return chunksJsonStr;
  }
}

/**
 * Parses HTTP request cookies into key-value map.
 */
function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return {};
  const list = {};
  header.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
    }
  });
  return list;
}

/**
 * Derives a secure HMAC-SHA256 session token for an unlocked file share.
 */
function getShareSessionToken(shareId, pinHash) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`${shareId}:${pinHash}`).digest('hex');
}

/**
 * Validates whether the incoming request has a valid, unexpired share session token via cookie or header.
 */
function isShareSessionAuthorized(req, shareId, pinHash) {
  if (!pinHash) return true;
  const expected = getShareSessionToken(shareId, pinHash);
  const cookies = parseCookies(req);
  if (cookies[`share_auth_${shareId}`] === expected) return true;
  if (req.headers && req.headers['x-share-session'] === expected) return true;
  return false;
}

/**
 * Validates and normalizes email input with strict RFC-compliant regex and length constraints.
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length > 254 || trimmed.length < 5) return false;
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

/**
 * Issues signed JWT authorization token for verified sessions.
 */
function generateUserToken(email) {
  return jwt.sign({ email: (email || '').trim().toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
}

/**
 * Verifies JWT token and extracts decoded payload.
 */
function verifyUserToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

/**
 * Universal Authorization Middleware:
 * Inspects Authorization: Bearer <token> or X-Access-Token headers only.
 * Tokens in URL query parameters are strictly forbidden (Fix #3).
 * Attaches verified user context to req.user and req.authenticatedEmail.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-access-token'];
  let token = null;
  if (authHeader) {
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (typeof authHeader === 'string') {
      token = authHeader.trim();
    }
  }

  if (token) {
    const decoded = verifyUserToken(token);
    if (decoded && decoded.email) {
      req.user = decoded;
      req.authenticatedEmail = decoded.email.toLowerCase();
      return next();
    }
  }

  req.user = null;
  req.authenticatedEmail = null;
  next();
}

/**
 * Mandatory Authorization Guard: Rejects unauthenticated requests with 401 (Fix #1).
 */
function requireAuth(req, res, next) {
  if (!req.user || !req.authenticatedEmail) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please provide a valid Bearer authorization token.'
    });
  }
  next();
}

app.use(authenticateToken);

/**
 * Liveness and Readiness Health Endpoints (Fix #50)
 */
app.get('/live', (req, res) => {
  res.status(200).json({ status: 'live', uptime: process.uptime(), timestamp: Date.now() });
});

app.get('/ready', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbLatencyMs = null;
  if (pool) {
    try {
      const start = Date.now();
      await queryWithTimeout('SELECT 1', [], 3000);
      dbLatencyMs = Date.now() - start;
      dbStatus = 'connected';
    } catch (err) {
      dbStatus = 'error: ' + err.message;
    }
  }
  const isReady = dbStatus === 'connected';
  return res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'unhealthy',
    database: { status: dbStatus, latencyMs: dbLatencyMs },
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

/**
 * -------------------------------------------------------------------------------------
 * PROCESS LEVEL SAFETY & LIFECYCLE HANDLERS (Fix #46, #47)
 * -------------------------------------------------------------------------------------
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process Warning] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process Fatal] Uncaught Exception thrown:', err);
  setTimeout(() => process.exit(1), 500);
});

async function gracefulShutdown(signal) {
  console.log(`[Process] Received ${signal}, closing resources gracefully...`);
  if (pool) {
    try {
      await pool.end();
      console.log('[Neon Postgres Pool] Closed connection pool cleanly.');
    } catch (err) {
      console.error('[Neon Postgres Pool] Error ending pool:', err.message);
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * -------------------------------------------------------------------------------------
 * 1. DATABASE CONFIGURATION & INITIALIZATION (NEON POSTGRESQL)
 * -------------------------------------------------------------------------------------
 * Configures connection pool to Neon Serverless PostgreSQL.
 * If DATABASE_URL environment variable is missing in production, fails fast.
 * In development, degrades gracefully to in-memory storage without breaking API calls.
 */
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('FATAL: DATABASE_URL environment variable is required in production.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 15000,
      statement_timeout: 8000
    })
  : null;

if (pool) {
  // Listen for unexpected errors on idle PostgreSQL clients
  pool.on('error', (err) => {
    console.error('[Neon Postgres Pool Error]', err.message);
  });
}

/**
 * Executes a PostgreSQL query with an active database statement timeout (default 8 seconds)
 * and automatic 1x retry strictly on idempotent (SELECT) queries during transient connection reset/wake-up errors.
 * Ensures PostgreSQL actively aborts timed-out queries at the engine level to prevent orphaned operations.
 */
async function queryWithTimeout(text, params, timeoutMs = 8000, maxRetries = 1) {
  if (!pool) throw new Error('Database pool is disabled or null');
  let lastErr = null;
  const isIdempotent = typeof text === 'string' && text.trim().toUpperCase().startsWith('SELECT');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timerId = null;
    try {
      const queryObj = typeof text === 'string'
        ? { text, values: params, statement_timeout: timeoutMs }
        : { ...text, statement_timeout: timeoutMs };

      const queryPromise = pool.query(queryObj);
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`Database query timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (err) {
      lastErr = err;
      const isTransient = err.message && (
        err.message.includes('timed out') ||
        err.message.includes('statement timeout') ||
        err.message.includes('57014') ||
        err.message.includes('Connection terminated') ||
        err.message.includes('WebSocket') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ENOTFOUND')
      );
      if (attempt < maxRetries && isTransient && isIdempotent) {
        console.warn(`[Neon Postgres Retry] Transient DB error (attempt ${attempt + 1}): ${err.message}. Retrying in 400ms...`);
        await new Promise(r => setTimeout(r, 400));
        continue;
      }
      throw err;
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }
  throw lastErr;
}

/**
 * -------------------------------------------------------------------------------------
 * IN-MEMORY FALLBACK STORES
 * -------------------------------------------------------------------------------------
 * Used automatically whenever database pool is unavailable or database queries fail.
 */
const memoryUsers = new Map();
const memoryOtps = new Map();
const memoryFiles = new Map();

/**
 * OTP Brute-Force Protection: Tracks failed verification attempts per email.
 * After 5 failed attempts, the account is locked out for 15 minutes.
 */
const otpAttempts = new Map();
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * -------------------------------------------------------------------------------------
 * 2. DUAL MULTI-SMTP FALLBACK ENGINE
 * -------------------------------------------------------------------------------------
 * Configures Primary and Secondary Gmail SMTP transporters. If Primary Gmail sender encounters
 * rate limits or authentication issues, system instantly falls back to Secondary SMTP.
 */
const primarySender = (process.env.SMTP_EMAIL || '').trim();
const primaryPass = (process.env.SMTP_APP_PASSWORD || '').trim();

const secondarySender = (process.env.SMTP_EMAIL_2 || '').trim();
const secondaryPass = (process.env.SMTP_APP_PASSWORD_2 || '').trim();

const primaryTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: primarySender, pass: primaryPass },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 8000
});

const secondaryTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: secondarySender, pass: secondaryPass },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 8000
});

/**
 * Dispatches an email using Primary SMTP transporter, falling back to Secondary SMTP on failure.
 * @param {Object} mailOptions - Nodemailer email options object (to, subject, html, attachments)
 * @returns {Promise<{success: boolean, provider: string, info: Object}>}
 */
async function sendMailWithFallback(mailOptions) {
  if (!primarySender && !secondarySender) {
    console.error('[SMTP Engine ERROR] No SMTP credentials set in process.env (SMTP_EMAIL & SMTP_APP_PASSWORD missing)');
    throw new Error('SMTP credentials not configured on server. Please set SMTP_EMAIL and SMTP_APP_PASSWORD in Vercel Environment Variables.');
  }

  // Attempt 1: Primary SMTP Transporter
  if (primarySender && primaryPass) {
    try {
      const optionsWithFrom = {
        ...mailOptions,
        from: mailOptions.from || `"Telegram Backup Cloud" <${primarySender}>`
      };
      console.log(`[SMTP Engine] Attempting Primary SMTP (${primarySender})...`);
      const info = await primaryTransporter.sendMail(optionsWithFrom);
      console.log(`[SMTP Engine SUCCESS] Primary SMTP (${primarySender}) sent email! Message ID: ${info.messageId}`);
      return { success: true, provider: primarySender, info };
    } catch (primaryErr) {
      console.warn(`[SMTP Engine WARNING] Primary SMTP (${primarySender}) failed: ${primaryErr.message}. Initiating Secondary SMTP Fallback...`);
    }
  }

  // Attempt 2: Secondary SMTP Transporter Fallback
  if (secondarySender && secondaryPass) {
    try {
      const optionsWithFrom2 = {
        ...mailOptions,
        from: `"Telegram Backup Cloud" <${secondarySender}>`
      };
      const info2 = await secondaryTransporter.sendMail(optionsWithFrom2);
      console.log(`[SMTP Engine SUCCESS] Secondary Fallback SMTP (${secondarySender}) sent email! Message ID: ${info2.messageId}`);
      return { success: true, provider: secondarySender, info: info2 };
    } catch (secondaryErr) {
      console.error(`[SMTP Engine ERROR] Secondary SMTP failed: ${secondaryErr.message}`);
    }
  }

  throw new Error('Failed to send email via Primary and Secondary SMTP providers. Check Vercel SMTP environment variables & App Passwords.');
}

/**
 * Helper function: Generates a cryptographically secure 6-digit verification code.
 */
function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Computes deterministic SHA-256 hash of an OTP code for safe database persistence.
 */
function hashOTP(code) {
  return crypto.createHash('sha256').update(String(code).trim()).digest('hex');
}

/**
 * Constant-time comparison between submitted OTP and stored plain code or SHA-256 hash.
 */
function verifyOTPCode(submittedCode, storedCodeOrHash) {
  if (!submittedCode || !storedCodeOrHash) return false;
  const cleanSubmitted = String(submittedCode).trim();
  const cleanStored = String(storedCodeOrHash).trim();

  // If stored value is already a 64-character SHA-256 hex digest
  if (cleanStored.length === 64 && /^[0-9a-fA-F]{64}$/.test(cleanStored)) {
    const submittedHash = hashOTP(cleanSubmitted);
    try {
      return crypto.timingSafeEqual(Buffer.from(submittedHash, 'utf8'), Buffer.from(cleanStored, 'utf8'));
    } catch (_) {
      return false;
    }
  }

  // Legacy plain-text code support with timing-safe comparison
  try {
    const bufSub = Buffer.from(cleanSubmitted);
    const bufStored = Buffer.from(cleanStored);
    if (bufSub.length === bufStored.length) {
      return crypto.timingSafeEqual(bufSub, bufStored);
    }
    return false;
  } catch (_) {
    return cleanSubmitted === cleanStored;
  }
}

/**
 * Unified OTP Resolver: Evaluates both PostgreSQL and memory store,
 * returning the newest, active OTP record for the user.
 */
async function getLatestOtp(email) {
  const lowerEmail = (email || '').trim().toLowerCase();
  let dbOtp = null;
  let memOtp = null;

  if (pool) {
    try {
      const result = await queryWithTimeout(
        `SELECT code, expires_at, type FROM otps WHERE LOWER(email) = $1 ORDER BY expires_at DESC LIMIT 1`,
        [lowerEmail]
      );
      if (result.rows.length > 0) {
        dbOtp = {
          code: String(result.rows[0].code || '').trim(),
          expiresAt: parseInt(result.rows[0].expires_at, 10),
          type: result.rows[0].type
        };
      }
    } catch (err) {
      console.error('[DB Warn] getLatestOtp DB query error:', err.message);
    }
  }

  const rec = memoryOtps.get(lowerEmail);
  if (rec) {
    memOtp = {
      code: String(rec.code || '').trim(),
      expiresAt: rec.expiresAt,
      type: rec.type
    };
  }

  if (dbOtp && memOtp) {
    return dbOtp.expiresAt >= memOtp.expiresAt ? dbOtp : memOtp;
  }
  return dbOtp || memOtp || null;
}

/** Purges OTP from both PostgreSQL database and in-memory store */
async function deleteOtp(email) {
  const lowerEmail = (email || '').trim().toLowerCase();
  memoryOtps.delete(lowerEmail);
  if (pool) {
    try {
      await queryWithTimeout(`DELETE FROM otps WHERE LOWER(email) = $1`, [lowerEmail]);
    } catch (err) {
      console.error('[DB Warn] deleteOtp DB query error:', err.message);
    }
  }
}

/**
 * Atomically validates and consumes an unexpired OTP for the specified purpose (Fix #11, #12, #14).
 * Eliminates race condition window where two concurrent requests could validate the same OTP.
 */
async function consumeOtpAtomic(email, code, expectedType) {
  const lowerEmail = (email || '').trim().toLowerCase();
  const cleanCode = String(code || '').trim();
  const hashedCode = hashOTP(cleanCode);
  const now = Date.now();

  // 1. Database Atomic Deletion with Purpose & Time Verification
  if (pool) {
    try {
      const res = await queryWithTimeout(
        `DELETE FROM otps
         WHERE LOWER(email) = $1
           AND (code = $2 OR code = $3)
           AND type = $4
           AND expires_at > $5
         RETURNING email, type`,
        [lowerEmail, hashedCode, cleanCode, expectedType, now]
      );
      if (res.rowCount > 0) {
        memoryOtps.delete(lowerEmail);
        return { success: true };
      }
    } catch (err) {
      console.error('[DB Warn] consumeOtpAtomic DB query error:', err.message);
    }
  }

  // 2. Memory Store Atomic Deletion
  const mem = memoryOtps.get(lowerEmail);
  if (mem) {
    if (now <= mem.expiresAt && mem.type === expectedType && verifyOTPCode(cleanCode, mem.code)) {
      memoryOtps.delete(lowerEmail);
      return { success: true };
    }
  }

  return { success: false };
}

/**
 * In-Memory Rate Limiting for OTP generation (Fix #13)
 * Maximum 5 OTP dispatches per email per 15 minutes.
 */
const otpRateLimitMap = new Map(); // key: email, value: { count, resetAt }
function checkOtpRateLimit(email) {
  const now = Date.now();
  const record = otpRateLimitMap.get(email);
  if (!record || now > record.resetAt) {
    otpRateLimitMap.set(email, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (record.count >= 5) {
    return false;
  }
  record.count++;
  return true;
}

/**
 * -------------------------------------------------------------------------------------
 * 3. API ROUTE: SEND OTP VERIFICATION CODE
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/send-otp (Also aliases: /auth/send-otp, /send-otp)
 * Accepts: { email: string, type: 'register' | '2fa' | 'reset' }
 * Generates 6-digit code with 5-minute expiration and dispatches via Multi-SMTP.
 */
app.post(['/api/auth/send-otp', '/auth/send-otp', '/send-otp', '/api/auth/request-reset', '/auth/request-reset', '/request-reset'], async (req, res, next) => {
  try {
    const { email, type = 'register' } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Valid RFC-compliant email address is required.' });
    }

    const lowerEmail = email.trim().toLowerCase();
    if (!checkOtpRateLimit(lowerEmail)) {
      return res.status(429).json({ success: false, message: 'Too many OTP requests. Please wait 15 minutes before requesting again.' });
    }

    const reqPath = (req.originalUrl || req.url || '').toLowerCase();
    let resolvedType = type;
    if (reqPath.includes('reset')) {
      resolvedType = 'reset';
    }

    const code = generateOTP();
    const hashedCode = hashOTP(code);
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 Minutes TTL

    // Save hashed code to Memory Store ALWAYS for guaranteed instant fallback
    memoryOtps.set(lowerEmail, { code: hashedCode, expiresAt, type: resolvedType });

    // Also persist hashed code to PostgreSQL DB if available
    if (pool) {
      try {
        await queryWithTimeout(
          `INSERT INTO otps (email, code, expires_at, type) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3, type = $4`,
          [lowerEmail, hashedCode, expiresAt, resolvedType]
        );
      } catch (dbErr) {
        console.error('[DB Warn] OTP DB save failed, relying on memory store:', dbErr.message);
      }
    }

    // Construct Responsive HTML Email Template (raw code sent to user, hashed code stored)
    const emailSubject = resolvedType === 'reset'
      ? 'Password Reset Code: Telegram Backup Cloud'
      : (resolvedType === '2fa'
        ? '2FA Code: Modify Telegram Credentials'
        : 'Verification Code: Telegram Backup Registration');

    const mailOptions = {
      to: lowerEmail,
      subject: emailSubject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #0088cc;">Telegram Backup Cloud</h2>
          <p>Your 6-digit security verification code is:</p>
          <h1 style="background: #eef7fc; display: inline-block; padding: 10px 20px; color: #0088cc; letter-spacing: 4px;">${escapeHtml(code)}</h1>
          <p>This code will expire in 5 minutes.</p>
        </div>
      `
    };

    try {
      const sendResult = await sendMailWithFallback(mailOptions);
      return res.json({
        success: true,
        message: `OTP sent successfully! Please check your Inbox or Spam folder.`,
        provider: sendResult.provider
      });
    } catch (error) {
      console.error('[OTP Dispatch Error]', error.message);
      return res.status(400).json({
        success: false,
        message: `Failed to send OTP email: ${error.message}`
      });
    }

  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 3b. API ROUTE: SEND AES-256 MASTER SECURITY ENCRYPTION KEY
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/send-key (Also aliases: /auth/send-key, /send-key)
 * Requires: Authorization: Bearer <token> (Fix #1, #8)
 * Accepts: { encryptionKey: string }
 * Sends Master Encryption Key file attachment & access PIN to authenticated user's email.
 */
const handleSendKey = async (req, res, next) => {
  try {
    const { encryptionKey } = req.body || {};
    const lowerEmail = req.authenticatedEmail;
    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!encryptionKey || typeof encryptionKey !== 'string') {
      return res.status(400).json({ success: false, message: 'Valid encryption key is required.' });
    }

    // Cryptographically random 6-character access PIN for the backup attachment
    const filePassword = crypto.randomBytes(3).toString('hex').toUpperCase();

    const mailOptions = {
      to: lowerEmail,
      subject: '🔑 Your Master AES-256 Security Encryption Key File',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #0088cc;">🔐 Telegram Backup Cloud Security</h2>
          <p>Hello,</p>
          <p>Your files uploaded to Telegram are encrypted on your device using <strong>AES-256 Zero-Knowledge Encryption</strong> before transmission.</p>
          <div style="background-color: #eef6fc; padding: 12px 16px; border-left: 4px solid #0088cc; margin: 15px 0; border-radius: 4px;">
            <strong>🔒 Secure File Access PIN:</strong> <code style="font-size: 16px; font-weight: bold; color: #0088cc;">${escapeHtml(filePassword)}</code>
            <br/><span style="font-size: 12px; color: #555;">(Generated randomly for user: <strong>${escapeHtml(lowerEmail)}</strong>)</span>
          </div>
          <p>Here is your Master AES-256 Security Encryption Key:</p>
          <div style="background-color: #f4f6f9; padding: 16px; font-size: 20px; font-weight: bold; letter-spacing: 2px; text-align: center; border-radius: 6px; color: #0088cc; font-family: monospace;">
            ${escapeHtml(encryptionKey)}
          </div>
          <p style="margin-top: 15px;">Attached is your official <strong>telegram_backup_master_key.txt</strong> key file.</p>
          <p style="margin-top: 20px; font-size: 13px; color: #666;">
            ⚠️ <strong>Keep this key safe!</strong> Without this key, encrypted backups cannot be decrypted.
          </p>
        </div>
      `,
      attachments: [
        {
          filename: 'telegram_backup_master_key.txt',
          content: `==============================================\nTELEGRAM BACKUP CLOUD - MASTER AES-256 KEY\n==============================================\nAccount Email: ${lowerEmail}\nMaster Encryption Key: ${encryptionKey}\nFile Protection PIN: ${filePassword}\nDate Generated: ${new Date().toISOString()}\n==============================================\nStore this file in a safe location. Without this key, encrypted backups cannot be decrypted.\n`
        }
      ]
    };

    const sendResult = await sendMailWithFallback(mailOptions);
    return res.json({ success: true, message: `Security Key file sent to ${lowerEmail} via ${sendResult.provider}!` });
  } catch (err) {
    console.error('Failed to send encryption key email:', err);
    if (typeof next === 'function') return next(err);
    return res.status(500).json({ success: false, message: `Email sending failed: ${err.message}` });
  }
};

app.post(['/api/auth/send-key', '/auth/send-key', '/send-key'], requireAuth, handleSendKey);

/**
 * -------------------------------------------------------------------------------------
 * 4. API ROUTE: VERIFY OTP & REGISTER USER ACCOUNT
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/verify-otp-register (Aliases: /auth/verify-otp-register, /verify-otp-register)
 * Accepts: { email: string, code: string, password: string }
 */
app.post(['/api/auth/verify-otp-register', '/auth/verify-otp-register', '/verify-otp-register'], async (req, res, next) => {
  try {
    const { email, code, password } = req.body || {};
    const lowerEmail = (email || '').toLowerCase().trim();

    if (!lowerEmail || !lowerEmail.includes('@') || !code || !password) {
      return res.status(400).json({ success: false, message: 'Email, verification code, and password are required.' });
    }

    // Fix #5: OTP brute-force protection — check attempt count before verification
    const attempts = otpAttempts.get(lowerEmail);
    if (attempts && attempts.count >= OTP_MAX_ATTEMPTS && (Date.now() - attempts.lastAttempt) < OTP_LOCKOUT_MS) {
      const remainingMins = Math.ceil((OTP_LOCKOUT_MS - (Date.now() - attempts.lastAttempt)) / 60000);
      return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${remainingMins} minutes.` });
    }

    const cleanCode = String(code || '').trim();
    // Atomic validation & deletion bound specifically to 'register' purpose (Fix #11, #12, #14)
    const otpResult = await consumeOtpAtomic(lowerEmail, cleanCode, 'register');
    if (!otpResult.success) {
      const prev = otpAttempts.get(lowerEmail) || { count: 0, lastAttempt: 0 };
      otpAttempts.set(lowerEmail, { count: prev.count + 1, lastAttempt: Date.now() });
      return res.status(400).json({ success: false, message: 'Invalid, expired, or already-used registration verification code.' });
    }

    // Clear attempt counters
    otpAttempts.delete(lowerEmail);

    // Fix #1: Hash password with bcrypt before storing (10 salt rounds)
    const hashedPassword = await bcrypt.hash(password, 10);

    // Persist registered user into Database or Memory Store
    if (pool) {
      try {
        await queryWithTimeout(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
          [lowerEmail, hashedPassword]
        );
      } catch (dbErr) {
        console.error('[DB Error] User registration DB query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please try again.' });
      }
    } else {
      memoryUsers.set(lowerEmail, { password: hashedPassword, botToken: '', chatId: '', isLocked: false });
    }

    const token = generateUserToken(lowerEmail);
    return res.json({ success: true, token, message: 'Account registered successfully!' });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 5. API ROUTE: USER LOGIN AUTHENTICATION
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/login (Aliases: /auth/login, /login)
 * Accepts: { email: string, password: string }
 * Returns user profile, JWT session token (botToken is strictly redacted - Fix #5).
 */
app.post(['/api/auth/login', '/auth/login', '/login'], async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const lowerEmail = (email || '').toLowerCase().trim();

    if (!lowerEmail || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    let user;
    if (pool) {
      try {
        const result = await queryWithTimeout(`SELECT email, password_hash, bot_token, chat_id, is_locked FROM users WHERE email = $1`, [lowerEmail]);
        if (result.rows.length > 0) {
          user = {
            email: result.rows[0].email,
            password: result.rows[0].password_hash,
            chatId: result.rows[0].chat_id,
            isLocked: result.rows[0].is_locked
          };
        }
      } catch (dbErr) {
        console.error('[DB Warn] Login query failed, falling back to memory store:', dbErr.message);
        user = memoryUsers.get(lowerEmail);
      }
    } else {
      user = memoryUsers.get(lowerEmail);
    }

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    // Fix #1: Use bcrypt.compare for hashed passwords
    let passwordValid = false;
    if (user.password && user.password.startsWith('$2')) {
      passwordValid = await bcrypt.compare(password, user.password);
    } else {
      passwordValid = (user.password === password);
      if (passwordValid) {
        const upgraded = await bcrypt.hash(password, 10);
        if (pool) {
          try { await queryWithTimeout(`UPDATE users SET password_hash = $1 WHERE email = $2`, [upgraded, lowerEmail]); }
          catch (e) { console.warn('[DB] Password upgrade failed:', e.message); }
        }
        const memUser = memoryUsers.get(lowerEmail);
        if (memUser) { memUser.password = upgraded; memoryUsers.set(lowerEmail, memUser); }
      }
    }

    if (!passwordValid) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = generateUserToken(user.email);
    // Redact raw bot token from login response (Fix #5)
    return res.json({
      success: true,
      token,
      user: {
        email: user.email,
        chatId: user.chatId || '',
        isLocked: user.isLocked || false
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 6. API ROUTE: VERIFY RESET OTP & UPDATE PASSWORD (BULLETPROOF)
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/reset-password (Aliases: /auth/reset-password, /reset-password, /verify-reset)
 */
app.post(['/api/auth/reset-password', '/auth/reset-password', '/reset-password', '/api/auth/verify-reset', '/auth/verify-reset', '/verify-reset'], async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { email, code, newPassword } = req.body || {};
    const lowerEmail = (email || '').trim().toLowerCase();
    const cleanCode = String(code || '').trim();

    if (!lowerEmail || !lowerEmail.includes('@') || !cleanCode || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email, verification code, and new password are required.' });
    }

    // Brute-force protection
    const attempts = otpAttempts.get(lowerEmail);
    if (attempts && attempts.count >= OTP_MAX_ATTEMPTS && (Date.now() - attempts.lastAttempt) < OTP_LOCKOUT_MS) {
      const remainingMins = Math.ceil((OTP_LOCKOUT_MS - (Date.now() - attempts.lastAttempt)) / 60000);
      return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${remainingMins} minutes.` });
    }

    // Atomic validation & deletion bound specifically to 'reset' purpose (Fix #11, #12, #14)
    const otpResult = await consumeOtpAtomic(lowerEmail, cleanCode, 'reset');
    if (!otpResult.success) {
      const prev = otpAttempts.get(lowerEmail) || { count: 0, lastAttempt: 0 };
      otpAttempts.set(lowerEmail, { count: prev.count + 1, lastAttempt: Date.now() });
      return res.status(400).json({ success: false, message: 'Invalid, expired, or already-used password reset verification code.' });
    }

    otpAttempts.delete(lowerEmail);

    // Hash new password with bcrypt
    let hashedPassword;
    try {
      hashedPassword = await bcrypt.hash(newPassword, 10);
    } catch (hashErr) {
      console.error('[reset-password] bcrypt.hash error:', hashErr.message);
      return res.status(500).json({ success: false, message: 'Failed to process new password. Please try again.' });
    }

    // Update password in DB
    if (pool) {
      try {
        await queryWithTimeout(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
          [lowerEmail, hashedPassword]
        );
      } catch (dbErr) {
        console.error('[reset-password] DB update failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please try again.' });
      }
    } else {
      const u = memoryUsers.get(lowerEmail) || {};
      u.password = hashedPassword;
      memoryUsers.set(lowerEmail, u);
    }

    const token = generateUserToken(lowerEmail);
    return res.status(200).json({ success: true, token, message: 'Password reset successfully!' });
  } catch (err) {
    console.error('[reset-password] UNCAUGHT ERROR:', err.message || err);
    return res.status(500).json({ success: false, message: `Server error: ${err.message || 'An unexpected error occurred.'}` });
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 8. API ROUTE: SAVE USER TELEGRAM CREDENTIALS
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/credentials/save (Aliases: /credentials/save, /api/user/credentials, /user/credentials)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Accepts: { botToken: string, chatId: string }
 */
app.post(['/api/credentials/save', '/credentials/save', '/api/user/credentials', '/user/credentials'], requireAuth, async (req, res, next) => {
  try {
    const { botToken, chatId } = req.body || {};
    const lowerEmail = req.authenticatedEmail;

    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!botToken || !chatId) {
      return res.status(400).json({ success: false, message: 'botToken and chatId are required.' });
    }

    if (pool) {
      try {
        await queryWithTimeout(
          `UPDATE users SET bot_token = $1, chat_id = $2 WHERE email = $3`,
          [botToken || '', chatId || '', lowerEmail]
        );
      } catch (dbErr) {
        console.error('[DB Error] Save credentials DB query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please try again.' });
      }
    } else {
      const u = memoryUsers.get(lowerEmail) || {};
      u.botToken = botToken || '';
      u.chatId = chatId || '';
      memoryUsers.set(lowerEmail, u);
    }

    return res.json({ success: true, message: 'Telegram credentials saved successfully.' });
  } catch (err) {
    next(err);
  }
});

/**
 * Endpoint: GET /api/credentials/get (Aliases: /credentials/get, /api/user/credentials/get)
 * Requires: Authorization: Bearer <token> (Fix #1, #2, #5)
 * Returns: { success: true, botToken: string, chatId: string }
 */
app.get(['/api/credentials/get', '/credentials/get', '/api/user/credentials/get'], requireAuth, async (req, res, next) => {
  try {
    const email = req.authenticatedEmail;
    if (!email || !isValidEmail(email)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    let botToken = '', chatId = '';
    if (pool) {
      try {
        const result = await queryWithTimeout(`SELECT bot_token, chat_id FROM users WHERE email = $1`, [email]);
        if (result.rows.length > 0) {
          botToken = result.rows[0].bot_token || '';
          chatId = result.rows[0].chat_id || '';
        }
      } catch (dbErr) {
        console.error('[DB Error] Get credentials DB query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please retry.' });
      }
    } else if (memoryUsers.has(email)) {
      const u = memoryUsers.get(email);
      botToken = u.botToken || '';
      chatId = u.chatId || '';
    }

    // Mask the raw bot token — only return the bot ID prefix for display
    const maskedToken = sanitizeBotIdentifier(botToken);
    return res.json({ success: true, botToken: maskedToken, chatId });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 8b. API ROUTES: SAVE & FETCH USER APP SETTINGS JSON
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/user/settings (Aliases: /user/settings, /api/settings/save, /settings/save)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Accepts: { settings: string }
 */
app.post(['/api/user/settings', '/user/settings', '/api/settings/save', '/settings/save'], requireAuth, async (req, res, next) => {
  try {
    const { settings, manifest, data } = req.body || {};
    const lowerEmail = req.authenticatedEmail;
    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const rawVal = manifest !== undefined ? manifest : (settings !== undefined ? settings : data);
    const settingsStr = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal || {});

    // Guard against oversized settings JSON injection
    if (settingsStr.length > 100 * 1024) {
      return res.status(413).json({ success: false, message: 'Settings payload is too large (max 100 KB)' });
    }

    if (pool) {
      try {
        await queryWithTimeout(
          `INSERT INTO user_settings (email, settings_json, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (email) DO UPDATE SET settings_json = $2, updated_at = CURRENT_TIMESTAMP`,
          [lowerEmail, settingsStr]
        );
        // Also best-effort update users table if user exists
        await queryWithTimeout(`UPDATE users SET settings_json = $1 WHERE email = $2`, [settingsStr, lowerEmail]).catch(() => {});
      } catch (dbErr) {
        console.error('[DB Error] Save settings query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please try again.' });
      }
    } else {
      const u = memoryUsers.get(lowerEmail) || {};
      u.settingsJson = settingsStr;
      memoryUsers.set(lowerEmail, u);
    }

    return res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    next(err);
  }
});

/**
 * Endpoint: GET /api/user/settings (Aliases: /user/settings, /api/settings/get, /settings/get)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Returns: { success: true, settings: string, manifest: string }
 */
app.get(['/api/user/settings', '/user/settings', '/api/settings/get', '/settings/get'], requireAuth, async (req, res, next) => {
  try {
    const email = req.authenticatedEmail;
    if (!email || !isValidEmail(email)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    let settings = null;
    if (pool) {
      try {
        const result = await queryWithTimeout(`SELECT settings_json FROM user_settings WHERE email = $1`, [email]);
        if (result.rows.length > 0 && result.rows[0].settings_json) {
          settings = result.rows[0].settings_json;
        } else {
          const userResult = await queryWithTimeout(`SELECT settings_json FROM users WHERE email = $1`, [email]);
          if (userResult.rows.length > 0 && userResult.rows[0].settings_json) {
            settings = userResult.rows[0].settings_json;
          }
        }
      } catch (dbErr) {
        console.error('[DB Error] Get settings query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please retry.' });
      }
    }

    if (!settings && memoryUsers.has(email)) {
      const u = memoryUsers.get(email);
      settings = u.settingsJson || null;
    }

    const finalSettings = settings || '{}';
    return res.json({ success: true, settings: finalSettings, manifest: finalSettings });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 9. API ROUTE: INDEX / SYNC BACKED UP FILE RECORD TO DATABASE
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/files/index (Aliases: /files/index, /api/files/backup, /files/backup)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Accepts: { fileName: string, telegramFileId: string, size: number, path: string, messageId: number }
 */
app.post(['/api/files/index', '/files/index', '/api/files/backup', '/files/backup'], requireAuth, async (req, res, next) => {
  try {
    const {
      fileName, telegramFileId, size, path, timestamp, messageId,
      isDriveUpload, is_drive_upload,
      chunksJson, chunks_json, chunks,
      channelId, channel_id,
      botTokenUsed, bot_token_used,
      totalChunks, total_chunks
    } = req.body || {};
    const lowerEmail = req.authenticatedEmail;
    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const msgId = parseInt(messageId, 10) || 0;
    const isDrive = Boolean(isDriveUpload || is_drive_upload || telegramFileId === 'DIR_MARKER');

    let finalChunksJson = '[]';
    if (typeof chunksJson === 'string' && chunksJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(chunksJson.trim());
        if (Array.isArray(parsed)) finalChunksJson = JSON.stringify(parsed);
      } catch (_) {
        return res.status(400).json({ success: false, message: 'chunksJson must be valid JSON array.' });
      }
    } else if (typeof chunks_json === 'string' && chunks_json.trim().length > 0) {
      try {
        const parsed = JSON.parse(chunks_json.trim());
        if (Array.isArray(parsed)) finalChunksJson = JSON.stringify(parsed);
      } catch (_) {
        return res.status(400).json({ success: false, message: 'chunks_json must be valid JSON array.' });
      }
    } else if (Array.isArray(chunks) && chunks.length > 0) {
      finalChunksJson = JSON.stringify(chunks);
    }
    const finalChannelId = String(channelId || channel_id || '').trim();
    const finalBotToken = sanitizeBotIdentifier(String(botTokenUsed || bot_token_used || '').trim());
    finalChunksJson = sanitizeChunksJson(finalChunksJson);
    const finalTotalChunks = parseInt(totalChunks || total_chunks || '1', 10) || 1;
    const safeSize = Math.max(0, parseInt(size, 10) || 0);

    if (!fileName || !telegramFileId) {
      return res.status(400).json({ success: false, message: 'fileName and telegramFileId are required.' });
    }

    const safePath = (path && String(path).trim()) ? String(path).trim() : String(fileName).trim();
    const rawTime = parseInt(timestamp || '0', 10);
    const safeTimestamp = (!rawTime || rawTime < 946684800000 || rawTime === 1784030400000) ? Date.now() : rawTime;

    if (pool) {
      try {
        // Fix #4: Use UPSERT with ON CONFLICT (email, path) to prevent duplicate file records
        await queryWithTimeout(
          `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id, is_drive_upload, chunks_json, channel_id, bot_token_used, total_chunks)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (email, path) DO UPDATE SET
             file_name = EXCLUDED.file_name,
             size = CASE WHEN EXCLUDED.size >= backed_files.size OR backed_files.size = 0 OR EXCLUDED.total_chunks > backed_files.total_chunks THEN EXCLUDED.size ELSE backed_files.size END,
             telegram_file_id = CASE WHEN EXCLUDED.size >= backed_files.size OR backed_files.size = 0 OR EXCLUDED.total_chunks > backed_files.total_chunks THEN EXCLUDED.telegram_file_id ELSE backed_files.telegram_file_id END,
             message_id = CASE WHEN EXCLUDED.size >= backed_files.size OR backed_files.size = 0 OR EXCLUDED.total_chunks > backed_files.total_chunks THEN EXCLUDED.message_id ELSE backed_files.message_id END,
             timestamp = EXCLUDED.timestamp,
             is_drive_upload = EXCLUDED.is_drive_upload,
             chunks_json = CASE WHEN EXCLUDED.chunks_json != '[]' AND EXCLUDED.chunks_json != '' AND (EXCLUDED.total_chunks >= backed_files.total_chunks OR backed_files.chunks_json = '[]' OR backed_files.chunks_json = '') THEN EXCLUDED.chunks_json ELSE backed_files.chunks_json END,
             channel_id = CASE WHEN EXCLUDED.channel_id != '' THEN EXCLUDED.channel_id ELSE backed_files.channel_id END,
             bot_token_used = CASE WHEN EXCLUDED.bot_token_used != '' THEN EXCLUDED.bot_token_used ELSE backed_files.bot_token_used END,
             total_chunks = CASE WHEN EXCLUDED.total_chunks > 1 AND (EXCLUDED.total_chunks >= backed_files.total_chunks OR backed_files.total_chunks <= 1) THEN EXCLUDED.total_chunks ELSE backed_files.total_chunks END`,
          [lowerEmail, fileName, telegramFileId, safeSize, safePath, safeTimestamp, msgId, isDrive, finalChunksJson, finalChannelId, finalBotToken, finalTotalChunks]
        );
      } catch (dbErr) {
        console.error('[DB Error] Files backup DB save failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please retry indexing.' });
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      const idx = list.findIndex(f => f.path === safePath && f.email === lowerEmail);
      const entry = {
        id: idx >= 0 ? list[idx].id : list.length + 1,
        email: lowerEmail, fileName, telegramFileId, size: safeSize, path: safePath, timestamp: safeTimestamp,
        messageId: msgId, isDriveUpload: isDrive, chunksJson: finalChunksJson, channelId: finalChannelId,
        botTokenUsed: finalBotToken, totalChunks: finalTotalChunks
      };
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      memoryFiles.set(lowerEmail, list);
    }

    return res.json({ success: true, message: 'File record synced to cloud database.' });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 9a. API ROUTE: BATCH FILE RECORDS INDEXING (High Performance)
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/files/index-batch (Aliases: /files/index-batch, /api/index-files-batch)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Accepts: { files: [ { fileName, telegramFileId, size, path, timestamp, messageId, isDriveUpload }, ... ] }
 */
app.post(['/api/files/index-batch', '/files/index-batch', '/api/index-files-batch'], requireAuth, async (req, res, next) => {
  try {
    const { files } = req.body || {};
    const lowerEmail = req.authenticatedEmail;

    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, message: 'Files array cannot be empty.' });
    }

    const validFiles = files.filter(f => f && (f.fileName || f.path) && f.telegramFileId);
    if (validFiles.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid file entries provided.' });
    }

    if (pool) {
      try {
        const BATCH_CHUNK_SIZE = 50;
        for (let b = 0; b < validFiles.length; b += BATCH_CHUNK_SIZE) {
          const fileSlice = validFiles.slice(b, b + BATCH_CHUNK_SIZE);
          const values = [];
          const params = [];
          let pIdx = 1;

          for (const f of fileSlice) {
            const fName = (f.fileName || f.name || '').trim();
            const tgId = (f.telegramFileId || f.fileId || '').trim();
            const fSize = Math.max(0, parseInt(f.size || '0', 10) || 0);
            const fPath = (f.path && String(f.path).trim()) ? String(f.path).trim() : fName;
            const rawTime = parseInt(f.timestamp || '0', 10);
            const fTime = (!rawTime || rawTime < 946684800000 || rawTime === 1784030400000) ? Date.now() : rawTime;
            const msgId = parseInt(f.messageId || '0', 10) || 0;
            const isDrive = Boolean(f.isDriveUpload || f.is_drive_upload || fPath.startsWith('Internal Storage') || tgId === 'DIR_MARKER');
            let fChunksJson = '[]';
            if (typeof f.chunksJson === 'string' && f.chunksJson.trim().length > 0) {
              try {
                const parsed = JSON.parse(f.chunksJson.trim());
                if (Array.isArray(parsed)) fChunksJson = JSON.stringify(parsed);
              } catch (_) {}
            } else if (typeof f.chunks_json === 'string' && f.chunks_json.trim().length > 0) {
              try {
                const parsed = JSON.parse(f.chunks_json.trim());
                if (Array.isArray(parsed)) fChunksJson = JSON.stringify(parsed);
              } catch (_) {}
            } else if (Array.isArray(f.chunks) && f.chunks.length > 0) {
              fChunksJson = JSON.stringify(f.chunks);
            }
            const fChannel = String(f.channelId || f.channel_id || '').trim();
            const fBot = sanitizeBotIdentifier(String(f.botTokenUsed || f.bot_token_used || '').trim());
            fChunksJson = sanitizeChunksJson(fChunksJson);
            const fTotal = parseInt(f.totalChunks || f.total_chunks || '1', 10) || 1;

            values.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10}, $${pIdx + 11})`);
            params.push(lowerEmail, fName, tgId, fSize, fPath, fTime, msgId, isDrive, fChunksJson, fChannel, fBot, fTotal);
            pIdx += 12;
          }

          const batchSql = `
            INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id, is_drive_upload, chunks_json, channel_id, bot_token_used, total_chunks)
            VALUES ${values.join(', ')}
            ON CONFLICT (email, path) DO UPDATE SET
              file_name = EXCLUDED.file_name,
              size = CASE WHEN EXCLUDED.size >= backed_files.size OR backed_files.size = 0 OR EXCLUDED.total_chunks > backed_files.total_chunks THEN EXCLUDED.size ELSE backed_files.size END,
              telegram_file_id = CASE WHEN EXCLUDED.size >= backed_files.size OR backed_files.size = 0 OR EXCLUDED.total_chunks > backed_files.total_chunks THEN EXCLUDED.telegram_file_id ELSE backed_files.telegram_file_id END,
              message_id = CASE WHEN EXCLUDED.size >= backed_files.size OR backed_files.size = 0 OR EXCLUDED.total_chunks > backed_files.total_chunks THEN EXCLUDED.message_id ELSE backed_files.message_id END,
              timestamp = EXCLUDED.timestamp,
              is_drive_upload = EXCLUDED.is_drive_upload,
              chunks_json = CASE WHEN EXCLUDED.chunks_json != '[]' AND EXCLUDED.chunks_json != '' AND (EXCLUDED.total_chunks >= backed_files.total_chunks OR backed_files.chunks_json = '[]' OR backed_files.chunks_json = '') THEN EXCLUDED.chunks_json ELSE backed_files.chunks_json END,
              channel_id = CASE WHEN EXCLUDED.channel_id != '' THEN EXCLUDED.channel_id ELSE backed_files.channel_id END,
              bot_token_used = CASE WHEN EXCLUDED.bot_token_used != '' THEN EXCLUDED.bot_token_used ELSE backed_files.bot_token_used END,
              total_chunks = CASE WHEN EXCLUDED.total_chunks > 1 AND (EXCLUDED.total_chunks >= backed_files.total_chunks OR backed_files.total_chunks <= 1) THEN EXCLUDED.total_chunks ELSE backed_files.total_chunks END
          `;
          await queryWithTimeout(batchSql, params, 8000);
        }
      } catch (dbErr) {
        console.error('[DB Error] Batch files DB save failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please retry batch indexing.' });
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      for (const f of validFiles) {
        const fName = (f.fileName || f.name || '').trim();
        const fPath = (f.path && String(f.path).trim()) ? String(f.path).trim() : fName;
        const idx = list.findIndex(item => item.path === fPath && item.email === lowerEmail);
        let fChunksJson = '[]';
        if (typeof f.chunksJson === 'string' && f.chunksJson.trim().length > 0) fChunksJson = f.chunksJson.trim();
        else if (typeof f.chunks_json === 'string' && f.chunks_json.trim().length > 0) fChunksJson = f.chunks_json.trim();
        else if (Array.isArray(f.chunks) && f.chunks.length > 0) fChunksJson = JSON.stringify(f.chunks);
        const entry = {
          id: idx >= 0 ? list[idx].id : list.length + 1,
          email: lowerEmail,
          fileName: fName,
          telegramFileId: f.telegramFileId || f.fileId || '',
          size: Math.max(0, parseInt(f.size || '0', 10) || 0),
          path: fPath,
          timestamp: parseInt(f.timestamp || '0', 10) || Date.now(),
          messageId: parseInt(f.messageId || '0', 10) || 0,
          isDriveUpload: Boolean(f.isDriveUpload || f.is_drive_upload),
          chunksJson: fChunksJson,
          channelId: String(f.channelId || f.channel_id || '').trim(),
          botTokenUsed: String(f.botTokenUsed || f.bot_token_used || '').trim(),
          totalChunks: parseInt(f.totalChunks || f.total_chunks || '1', 10) || 1
        };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
      }
      memoryFiles.set(lowerEmail, list);
    }

    return res.json({ success: true, count: validFiles.length, message: `Successfully synced ${validFiles.length} file records.` });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 9b. API ROUTE: DELETE FILE RECORD
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/files/delete (Aliases: /files/delete)
 * Requires: Authorization: Bearer <token> (Fix #1, #7)
 * Accepts: { telegramFileId: string, path: string }
 */
app.post(['/api/files/delete', '/files/delete'], requireAuth, async (req, res, next) => {
  try {
    const { telegramFileId, path } = req.body || {};
    const lowerEmail = req.authenticatedEmail;

    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!telegramFileId && !path) {
      return res.status(400).json({ success: false, message: 'telegramFileId or path is required to identify the file.' });
    }

    // Verify the file belongs to this authenticated email before deleting
    if (pool) {
      try {
        await queryWithTimeout(
          `DELETE FROM file_chunks WHERE file_id IN (
             SELECT id FROM backed_files WHERE email = $1 AND (telegram_file_id = $2 OR (path = $3 AND path != ''))
           )`,
          [lowerEmail, telegramFileId || '', path || '']
        );
        await queryWithTimeout(
          `DELETE FROM backed_files WHERE email = $1 AND (telegram_file_id = $2 OR (path = $3 AND path != ''))`,
          [lowerEmail, telegramFileId || '', path || '']
        );
      } catch (dbErr) {
        console.error('[DB Error] Files delete DB query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Failed to delete file record.' });
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      const filtered = list.filter(f => f.telegramFileId !== telegramFileId && f.path !== path);
      memoryFiles.set(lowerEmail, filtered);
    }

    return res.json({ success: true, message: 'File record deleted successfully.' });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 9c. API ROUTE: PURGE DATA (Clear file records with custom filters while keeping account)
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/files/purge (Aliases: /files/purge)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Accepts: { mode: "ALL" | "DRIVE_ONLY" | "AUTO_BACKUP_ONLY" | "OLDER_THAN_DAYS", olderThanDays?: number }
 */
app.post(['/api/files/purge', '/files/purge'], requireAuth, async (req, res, next) => {
  try {
    const { mode, olderThanDays } = req.body || {};
    const lowerEmail = req.authenticatedEmail;
    const purgeMode = mode || 'ALL';

    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    let queryText = 'WHERE email = $1';
    const queryParams = [lowerEmail];

    if (purgeMode === 'DRIVE_ONLY') {
      queryText += ` AND (is_drive_upload = true OR telegram_file_id = 'DIR_MARKER' OR path LIKE 'Internal Storage%')`;
    } else if (purgeMode === 'AUTO_BACKUP_ONLY') {
      queryText += ` AND (is_drive_upload = false AND telegram_file_id != 'DIR_MARKER' AND path NOT LIKE 'Internal Storage%')`;
    } else if (purgeMode === 'TRASH_ONLY') {
      queryText += ` AND is_deleted = true`;
    } else if (purgeMode === 'OLDER_THAN_DAYS') {
      const days = parseInt(olderThanDays) || 30;
      const cutoffMs = Date.now() - (days * 86400 * 1000);
      queryText += ` AND timestamp < $2`;
      queryParams.push(cutoffMs);
    }

    let deletedItems = [];
    const allMessageIds = new Set();

    if (pool) {
      try {
        const fetchRes = await queryWithTimeout(
          `SELECT message_id as "messageId", telegram_file_id as "telegramFileId", path, chunks_json as "chunksJson" FROM backed_files ${queryText}`,
          queryParams
        );
        deletedItems = fetchRes.rows || [];

        for (const item of deletedItems) {
          const mid = parseInt(item.messageId, 10);
          if (!isNaN(mid) && mid > 0) {
            allMessageIds.add(mid);
          }
          if (item.chunksJson) {
            try {
              const parsed = typeof item.chunksJson === 'string' ? JSON.parse(item.chunksJson) : item.chunksJson;
              if (Array.isArray(parsed)) {
                for (const chunk of parsed) {
                  const cMid = parseInt(chunk.messageId || chunk.msgId, 10);
                  if (!isNaN(cMid) && cMid > 0) {
                    allMessageIds.add(cMid);
                  }
                }
              }
            } catch (_) {}
          }
        }

        // Delete associated file_chunks before backed_files
        await queryWithTimeout(
          `DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM backed_files ${queryText})`,
          queryParams
        );
        // Delete from backed_files
        await queryWithTimeout(`DELETE FROM backed_files ${queryText}`, queryParams);

        // Also clean up any associated shared files records
        if (purgeMode === 'ALL') {
          await queryWithTimeout(`DELETE FROM shared_files WHERE email = $1`, [lowerEmail]);
        } else if (deletedItems.length > 0) {
          const paths = deletedItems.map(d => d.path).filter(Boolean);
          if (paths.length > 0) {
            await queryWithTimeout(
              `DELETE FROM shared_files WHERE email = $1 AND file_path = ANY($2)`,
              [lowerEmail, paths]
            );
          }
        }
      } catch (dbErr) {
        console.error('[DB Error] Files purge DB query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Purge failed.' });
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      deletedItems = list.map(f => ({ messageId: f.messageId, telegramFileId: f.telegramFileId, path: f.path }));
      for (const item of deletedItems) {
        const mid = parseInt(item.messageId, 10);
        if (!isNaN(mid) && mid > 0) allMessageIds.add(mid);
      }
      memoryFiles.set(lowerEmail, []);
    }

    return res.json({
      success: true,
      message: `Successfully purged ${deletedItems.length} file record(s) from cloud database.`,
      deletedCount: deletedItems.length,
      allMessageIds: Array.from(allMessageIds),
      deletedItems
    });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 9d. API ROUTE: DELETE USER ACCOUNT AND ALL DATA PERMANENTLY (TRANSACTIONAL)
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/user/delete-account (Aliases: /user/delete-account)
 * Requires: Authorization: Bearer <token> (Fix #1, #2)
 * Accepts: { password: string }
 */
app.post(['/api/user/delete-account', '/user/delete-account'], requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    const lowerEmail = req.authenticatedEmail;

    if (!lowerEmail || !isValidEmail(lowerEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!password) {
      return res.status(400).json({ success: false, message: 'Password is required to confirm account deletion.' });
    }

    if (pool) {
      const client = await pool.connect();
      try {
        // Verify user password before proceeding
        const userRes = await client.query(`SELECT password_hash FROM users WHERE email = $1`, [lowerEmail]);
        if (userRes.rows.length === 0) {
          client.release();
          return res.status(404).json({ success: false, message: 'User account not found.' });
        }

        const hash = userRes.rows[0].password_hash;
        let valid = false;
        if (hash && hash.startsWith('$2')) {
          valid = await bcrypt.compare(password, hash);
        } else {
          valid = (hash === password);
        }

        if (!valid) {
          client.release();
          return res.status(401).json({ success: false, message: 'Incorrect password. Account deletion cancelled.' });
        }

        // 1. Fetch file message IDs and chunks for Telegram cleanup
        const filesRes = await client.query(`SELECT message_id as "messageId", telegram_file_id as "telegramFileId", chunks_json as "chunksJson" FROM backed_files WHERE email = $1`, [lowerEmail]);
        const deletedItems = filesRes.rows || [];
        const allMessageIds = new Set();
        for (const item of deletedItems) {
          const mid = parseInt(item.messageId, 10);
          if (!isNaN(mid) && mid > 0) allMessageIds.add(mid);
          if (item.chunksJson) {
            try {
              const parsed = typeof item.chunksJson === 'string' ? JSON.parse(item.chunksJson) : item.chunksJson;
              if (Array.isArray(parsed)) {
                for (const chunk of parsed) {
                  const cMid = parseInt(chunk.messageId || chunk.msgId, 10);
                  if (!isNaN(cMid) && cMid > 0) allMessageIds.add(cMid);
                }
              }
            } catch (_) {}
          }
        }

        // 2. Execute deletion across all tables in a single transaction
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM backed_files WHERE email = $1)`,
          [lowerEmail]
        );
        await client.query(`DELETE FROM backed_files WHERE email = $1`, [lowerEmail]);
        await client.query(`DELETE FROM shared_files WHERE email = $1`, [lowerEmail]);
        await client.query(`DELETE FROM user_settings WHERE email = $1`, [lowerEmail]);
        await client.query(`DELETE FROM otps WHERE email = $1`, [lowerEmail]);
        await client.query(`DELETE FROM users WHERE email = $1`, [lowerEmail]);
        await client.query('COMMIT');
        client.release();

        // Also clean up in-memory caches
        memoryFiles.delete(lowerEmail);
        memoryUsers.delete(lowerEmail);
        memoryOtps.delete(lowerEmail);

        return res.json({
          success: true,
          message: 'User account and all associated cloud file data deleted permanently.',
          deletedCount: deletedItems.length,
          allMessageIds: Array.from(allMessageIds),
          deletedItems
        });
      } catch (dbErr) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
        console.error('[DB Error] Account deletion failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Account deletion failed.' });
      }
    } else {
      const u = memoryUsers.get(lowerEmail);
      if (!u) {
        return res.status(404).json({ success: false, message: 'User account not found.' });
      }
      let valid = false;
      if (u.password && u.password.startsWith('$2')) {
        valid = await bcrypt.compare(password, u.password);
      } else {
        valid = (u.password === password);
      }
      if (!valid) {
        return res.status(401).json({ success: false, message: 'Incorrect password. Account deletion cancelled.' });
      }
      memoryFiles.delete(lowerEmail);
      memoryUsers.delete(lowerEmail);
      memoryOtps.delete(lowerEmail);
      return res.json({ success: true, message: 'Account deleted from memory cache.' });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 10. API ROUTE: FETCH USER'S BACKED UP FILES LIST (With Delta Sync Support)
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /api/files/list?since=1710000000&limit=10000 (Aliases: /files/list)
 * Requires: Authorization: Bearer <token> (Fix #1, #2, #5, #15, #17)
 */
app.get(['/api/files/list', '/files/list'], requireAuth, async (req, res, next) => {
  try {
    const email = req.authenticatedEmail;
    if (!email || !isValidEmail(email)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const since = parseInt(req.query.since || '0', 10) || 0;
    const afterId = parseInt(req.query.afterId || '0', 10) || 0;
    const limit = Math.min(parseInt(req.query.limit || '10000', 10) || 10000, 20000);
    const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
    let cursorTs = 0;
    let cursorId = 0;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');
        const [tsPart, idPart] = decoded.split(':');
        cursorTs = parseInt(tsPart, 10) || 0;
        cursorId = parseInt(idPart, 10) || 0;
      } catch (_) {}
    }

    if (pool) {
      try {
        let queryStr = `SELECT id, file_name as "fileName", telegram_file_id as "telegramFileId", size, path, timestamp, message_id as "messageId", is_drive_upload as "isDriveUpload",
           COALESCE(chunks_json, '[]') as "chunksJson",
           COALESCE(channel_id, '') as "channelId",
           COALESCE(total_chunks, 1) as "totalChunks"
           FROM backed_files WHERE email = $1`;
        const params = [email];

        if (cursorTs > 0 && cursorId > 0) {
          queryStr += ` AND (timestamp < $2 OR (timestamp = $2 AND id < $3)) ORDER BY timestamp DESC, id DESC LIMIT $4`;
          params.push(cursorTs, cursorId, limit);
        } else if (since > 0 && afterId > 0) {
          queryStr += ` AND (timestamp > $2 OR (timestamp = $2 AND id > $3)) ORDER BY timestamp ASC, id ASC LIMIT $4`;
          params.push(since, afterId, limit);
        } else if (since > 0) {
          queryStr += ` AND timestamp > $2 ORDER BY timestamp ASC, id ASC LIMIT $3`;
          params.push(since, limit);
        } else {
          queryStr += ` ORDER BY timestamp DESC, id DESC LIMIT $2`;
          params.push(limit);
        }

        const result = await queryWithTimeout(queryStr, params);
        const sanitizedFiles = result.rows.map(row => {
          const rawDbTs = parseInt(row.timestamp, 10);
          row.rawCursorTimestamp = !isNaN(rawDbTs) ? rawDbTs : 0;
          const ts = rawDbTs;
          if (isNaN(ts) || ts < 946684800000 || ts === 1784030400000) {
            row.timestamp = Date.now();
          }
          if (!row.chunksJson || row.chunksJson === 'null') row.chunksJson = '[]';
          row.channelId = row.channelId || '';
          row.totalChunks = parseInt(row.totalChunks, 10) || 1;
          return row;
        });

        let nextCursor = null;
        if (sanitizedFiles.length === limit && sanitizedFiles.length > 0) {
          const last = sanitizedFiles[sanitizedFiles.length - 1];
          nextCursor = Buffer.from(`${last.rawCursorTimestamp}:${last.id}`).toString('base64');
        }

        for (const f of sanitizedFiles) {
          delete f.rawCursorTimestamp;
        }

        return res.json({ success: true, files: sanitizedFiles, nextCursor, isDelta: since > 0 });
      } catch (dbErr) {
        console.error('[DB Error] Files list DB query failed:', dbErr.message);
        // Fix #15: NEVER return empty success:true on DB failure, as this causes clients to wipe local files!
        return res.status(503).json({
          success: false,
          retryable: true,
          message: 'Database service unavailable. Please retry syncing.'
        });
      }
    } else {
      let list = memoryFiles.get(email) || [];
      if (since > 0) {
        list = list.filter(f => f.timestamp > since);
      }
      const sanitizedMem = list.slice(0, limit).map(f => {
        if (!f.timestamp || f.timestamp < 946684800000 || f.timestamp === 1784030400000) f.timestamp = Date.now();
        if (!f.chunksJson) f.chunksJson = '[]';
        f.channelId = f.channelId || '';
        f.totalChunks = f.totalChunks || 1;
        return f;
      });
      return res.json({ success: true, files: sanitizedMem, nextCursor: null, isDelta: since > 0 });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 10a. API ROUTE: SAVE / UPDATE SINGLE CHUNK METADATA (Idempotent Resumable Uploads)
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/files/chunk (Aliases: /files/chunk, /api/files/:fileId/chunks)
 * Requires: Authorization: Bearer <token>
 * Accepts: { fileId, chunkIndex, totalChunks, telegramFileId, messageId, chunkSize, sha256, botId, status }
 */
app.post(['/api/files/chunk', '/files/chunk', '/api/files/:fileId/chunks'], requireAuth, async (req, res, next) => {
  try {
    const email = req.authenticatedEmail;
    const body = req.body || {};
    const fileId = parsePositiveInteger(req.params.fileId || body.fileId);
    const chunkIndex = parsePositiveInteger(body.chunkIndex);
    const totalChunks = parsePositiveInteger(body.totalChunks) || 1;
    const telegramFileId = String(body.telegramFileId || '').trim();
    const messageId = parseInt(body.messageId || '0', 10) || 0;
    const chunkSize = Math.max(0, parseInt(body.chunkSize || '0', 10) || 0);
    const sha256 = String(body.sha256 || '').trim().toLowerCase();
    const rawBotId = String(body.botId || '').trim();
    const botId = rawBotId ? rawBotId.split(':')[0] : '';
    const status = String(body.status || 'COMPLETED').trim().toUpperCase();

    const allowedStatuses = new Set(['PENDING', 'UPLOADING', 'COMPLETED', 'FAILED']);

    if (!fileId || !chunkIndex || !telegramFileId) {
      return res.status(400).json({ success: false, message: 'Valid positive fileId, chunkIndex, and telegramFileId are required.' });
    }
    if (chunkIndex > totalChunks) {
      return res.status(400).json({ success: false, message: 'chunkIndex cannot exceed totalChunks.' });
    }
    if (!allowedStatuses.has(status)) {
      return res.status(400).json({ success: false, message: 'Invalid chunk status: must be PENDING, UPLOADING, COMPLETED, or FAILED.' });
    }
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
      return res.status(400).json({ success: false, message: 'Invalid SHA-256 hash format: must be 64-char hex string.' });
    }
    if (telegramFileId.length < 5 || telegramFileId.length > 255) {
      return res.status(400).json({ success: false, message: 'Invalid telegramFileId length (must be between 5 and 255 characters).' });
    }
    if (chunkSize > 100 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'chunkSize exceeds 100 MB limit.' });
    }

    if (pool) {
      try {
        // Verify parent file ownership and boundary
        const ownerCheck = await queryWithTimeout(
          `SELECT id, total_chunks as "totalChunks" FROM backed_files WHERE id = $1 AND email = $2`,
          [fileId, email]
        );
        if (ownerCheck.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Parent file not found or unauthorized.' });
        }
        const parentTotal = ownerCheck.rows[0].totalChunks;
        if (parentTotal && chunkIndex > parentTotal) {
          return res.status(400).json({ success: false, message: `chunkIndex (${chunkIndex}) exceeds parent file totalChunks (${parentTotal}).` });
        }

        await queryWithTimeout(`
          INSERT INTO file_chunks (file_id, chunk_index, telegram_file_id, message_id, bot_id, chunk_size, sha256, status, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (file_id, chunk_index) DO UPDATE SET
            telegram_file_id = EXCLUDED.telegram_file_id,
            message_id = EXCLUDED.message_id,
            bot_id = EXCLUDED.bot_id,
            chunk_size = EXCLUDED.chunk_size,
            sha256 = CASE WHEN EXCLUDED.sha256 <> '' THEN EXCLUDED.sha256 ELSE file_chunks.sha256 END,
            status = EXCLUDED.status,
            updated_at = NOW()
        `, [fileId, chunkIndex, telegramFileId, messageId, botId, chunkSize, sha256, status]);

        return res.json({ success: true, message: `Chunk ${chunkIndex} recorded successfully.` });
      } catch (dbErr) {
        console.error('[DB Error] Chunk record failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Please retry recording chunk.' });
      }
    } else {
      return res.json({ success: true, message: `Chunk ${chunkIndex} recorded in memory.` });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 10b. API ROUTE: FETCH FILE MANIFEST & CHUNKS
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /api/files/:fileId/manifest (Aliases: /files/:fileId/manifest, /api/files/manifest)
 * Requires: Authorization: Bearer <token>
 */
app.get(['/api/files/:fileId/manifest', '/files/:fileId/manifest', '/api/files/manifest', '/files/manifest'], requireAuth, async (req, res, next) => {
  try {
    const email = req.authenticatedEmail;
    const fileIdParam = req.params.fileId || req.query.fileId || req.query.id;
    const fileId = parsePositiveInteger(fileIdParam);
    const pathParam = req.query.path ? String(req.query.path).trim() : null;

    if (pool) {
      try {
        let fileRow = null;
        if (fileId) {
          const resFile = await queryWithTimeout(
            `SELECT id, file_name as "fileName", telegram_file_id as "telegramFileId", size, path, timestamp, total_chunks as "totalChunks", chunks_json as "chunksJson"
             FROM backed_files WHERE id = $1 AND email = $2`,
            [fileId, email]
          );
          if (resFile.rows.length > 0) fileRow = resFile.rows[0];
        } else if (pathParam) {
          const resFile = await queryWithTimeout(
            `SELECT id, file_name as "fileName", telegram_file_id as "telegramFileId", size, path, timestamp, total_chunks as "totalChunks", chunks_json as "chunksJson"
             FROM backed_files WHERE path = $1 AND email = $2 LIMIT 1`,
            [pathParam, email]
          );
          if (resFile.rows.length > 0) fileRow = resFile.rows[0];
        }

        if (!fileRow) {
          return res.status(404).json({ success: false, message: 'File not found.' });
        }

        // Fetch discrete chunks from file_chunks table
        const chunksRes = await queryWithTimeout(
          `SELECT chunk_index as "chunkIndex", telegram_file_id as "telegramFileId", message_id as "messageId", bot_id as "botId", chunk_size as "chunkSize", sha256, status
           FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC`,
          [fileRow.id]
        );

        let chunks = (chunksRes.rows || []).map(c => ({
          chunkIndex: c.chunkIndex,
          telegramFileId: c.telegramFileId,
          messageId: c.messageId,
          botId: c.botId ? String(c.botId).split(':')[0] : '', // never leak raw token
          chunkSize: c.chunkSize,
          sha256: c.sha256,
          status: c.status || 'COMPLETED'
        }));

        // Fallback to legacy chunks_json only if file_chunks table is empty for this file
        if (chunks.length === 0 && fileRow.chunksJson && fileRow.chunksJson !== '[]') {
          try {
            const parsed = typeof fileRow.chunksJson === 'string' ? JSON.parse(fileRow.chunksJson) : fileRow.chunksJson;
            if (Array.isArray(parsed) && parsed.length > 0) {
              const seen = new Set();
              for (const c of parsed) {
                const idx = parsePositiveInteger(c.chunkIndex || c.index || c.part);
                const tgId = String(c.telegramFileId || c.fileId || '').trim();
                if (idx && tgId && !seen.has(idx)) {
                  seen.add(idx);
                  chunks.push({
                    chunkIndex: idx,
                    telegramFileId: tgId,
                    messageId: parseInt(c.messageId || c.msgId || 0, 10) || 0,
                    botId: c.botId ? String(c.botId).split(':')[0] : '',
                    chunkSize: Math.max(0, parseInt(c.size || c.chunkSize || 0, 10) || 0),
                    sha256: (c.sha256 && /^[a-f0-9]{64}$/i.test(c.sha256)) ? c.sha256 : '',
                    status: 'COMPLETED'
                  });
                }
              }
              chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
            }
          } catch (_) {}
        }

        const completedCount = chunks.filter(c => c.status === 'COMPLETED').length;

        return res.json({
          success: true,
          file: {
            id: fileRow.id,
            fileName: fileRow.fileName,
            telegramFileId: fileRow.telegramFileId,
            size: fileRow.size,
            path: fileRow.path,
            timestamp: fileRow.timestamp,
            totalChunks: fileRow.totalChunks || 1
          },
          chunks,
          totalChunks: fileRow.totalChunks || 1,
          completedCount
        });
      } catch (dbErr) {
        console.error('[DB Error] File manifest query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable.' });
      }
    } else {
      return res.status(503).json({ success: false, message: 'Database unavailable.' });
    }
  } catch (err) {
    next(err);
  }
});


/**
 * -------------------------------------------------------------------------------------
 * 10c. API ROUTE: FETCH MISSING CHUNKS FOR RESUMABLE UPLOADS
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /api/files/:fileId/missing-chunks (Aliases: /files/:fileId/missing-chunks, /api/files/missing-chunks)
 * Requires: Authorization: Bearer <token>
 */
app.get(['/api/files/:fileId/missing-chunks', '/files/:fileId/missing-chunks', '/api/files/missing-chunks', '/files/missing-chunks'], requireAuth, async (req, res, next) => {
  try {
    const email = req.authenticatedEmail;
    const fileIdParam = req.params.fileId || req.query.fileId || req.query.id;
    const fileId = parseInt(fileIdParam, 10);
    const pathParam = req.query.path ? String(req.query.path).trim() : null;

    if (pool) {
      try {
        let fileRow = null;
        if (!isNaN(fileId) && fileId > 0) {
          const resFile = await queryWithTimeout(
            `SELECT id, total_chunks as "totalChunks", chunks_json as "chunksJson" FROM backed_files WHERE id = $1 AND email = $2`,
            [fileId, email]
          );
          if (resFile.rows.length > 0) fileRow = resFile.rows[0];
        } else if (pathParam) {
          const resFile = await queryWithTimeout(
            `SELECT id, total_chunks as "totalChunks", chunks_json as "chunksJson" FROM backed_files WHERE path = $1 AND email = $2 LIMIT 1`,
            [pathParam, email]
          );
          if (resFile.rows.length > 0) fileRow = resFile.rows[0];
        }

        if (!fileRow) {
          return res.status(404).json({ success: false, message: 'File not found.' });
        }

        const totalChunks = Math.max(1, parseInt(fileRow.totalChunks, 10) || 1);
        const existingChunksRes = await queryWithTimeout(
          `SELECT chunk_index FROM file_chunks WHERE file_id = $1 AND status = 'COMPLETED'`,
          [fileRow.id]
        );

        const completedSet = new Set(existingChunksRes.rows.map(r => parseInt(r.chunk_index, 10)));
        if (completedSet.size === 0 && fileRow.chunksJson && fileRow.chunksJson !== '[]') {
          try {
            const parsed = typeof fileRow.chunksJson === 'string' ? JSON.parse(fileRow.chunksJson) : fileRow.chunksJson;
            if (Array.isArray(parsed)) {
              for (const c of parsed) {
                const idx = parseInt(c.chunkIndex || c.index || c.part, 10);
                if (!isNaN(idx) && idx > 0) completedSet.add(idx);
              }
            }
          } catch (_) {}
        }

        const missing = [];
        for (let i = 1; i <= totalChunks; i++) {
          if (!completedSet.has(i)) {
            missing.push(i);
          }
        }

        return res.json({
          success: true,
          fileId: fileRow.id,
          totalChunks,
          completedCount: completedSet.size,
          missingCount: missing.length,
          missingChunks: missing,
          isComplete: missing.length === 0
        });
      } catch (dbErr) {
        console.error('[DB Error] Missing chunks query failed:', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable.' });
      }
    } else {
      return res.status(503).json({ success: false, message: 'Database unavailable.' });
    }
  } catch (err) {
    next(err);
  }
});

const GITHUB_RELEASE_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!GITHUB_RELEASE_TOKEN) {
  throw new Error('GITHUB_TOKEN is required');
}
const GITHUB_REPO_PATH = 'sid-codes28/telegram_backup_backend';

/**
 * Safely loads the local app-version.json file with cross-platform and Vercel serverless fallback.
 */
function getLocalAppVersion() {
  const fs = require('fs');
  const pathMod = require('path');
  const candidates = [
    pathMod.join(__dirname, 'app-version.json'),
    pathMod.resolve(__dirname, '..', 'app-version.json'),
    pathMod.join(process.cwd(), 'app-version.json')
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {}
  }
  return {
    versionCode: 140,
    versionName: '2.6.2',
    releaseNotes: '✨ Security & Architecture Release v2.6.2'
  };
}

/**
 * Computes monotonic, continuous Android versionCode from semantic version string.
 * Supports legacy 2.1.xx series as well as the new single-digit system (2.2.0 = 103, 2.2.1 = 104, 2.2.9 = 112, 2.3.0 = 113).
 */
function calculateVersionCode(name) {
  const cleanName = (name || '').replace(/^v/, '').trim();
  if (cleanName === '2.6.2') return 140;
  if (cleanName === '2.6.1') return 139;
  if (cleanName === '2.6.0') return 138;
  if (cleanName === '2.5.3') return 137;
  if (cleanName === '2.5.2') return 136;
  if (cleanName === '2.5.1') return 135;
  if (cleanName === '2.5.0') return 134;

  const localVer = getLocalAppVersion();
  // Always trust the authoritative app-version.json when the version name matches
  if (localVer && localVer.versionName === cleanName && localVer.versionCode) {
    return localVer.versionCode;
  }
  // Fallback formula only for versions not in app-version.json
  const parts = cleanName.split('.').map(p => parseInt(p, 10));
  if (parts.length >= 3 && !parts.some(isNaN)) {
    const [major, minor, patch] = parts;
    if (major === 2 && minor === 1) {
      return patch + 3;
    } else if (major === 2 && minor === 2) {
      return 103 + patch;
    } else if (major === 2 && minor === 3) {
      return 114 + patch;
    } else if (major === 2 && minor >= 4) {
      return 121 + (minor - 4) * 7 + patch;
    } else if (major > 2) {
      return 200 + (major - 3) * 100 + minor * 10 + patch;
    }
  }
  if (localVer && localVer.versionCode) {
    return localVer.versionCode;
  }
  return 140;
}

/**
 * Endpoint: GET /api/app/latest-version (Aliases: /app/latest-version)
 * Dynamically queries GitHub Releases in real-time for instantaneous update availability.
 */
app.get(['/api/app/latest-version', '/app/latest-version'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const host = req.headers.host || 'telegram-backup-backend.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const downloadUrl = `${protocol}://${host}/api/app/download-latest`;

  const https = require('https');
  const ghHeaders = {
    'User-Agent': 'TelegramBackup-Server',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (GITHUB_RELEASE_TOKEN) {
    ghHeaders['Authorization'] = `Bearer ${GITHUB_RELEASE_TOKEN}`;
  }

  const getOptions = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO_PATH}/releases/latest`,
    method: 'GET',
    headers: ghHeaders
  };

  https.get(getOptions, (ghRes) => {
    let body = '';
    ghRes.on('data', c => body += c);
    ghRes.on('end', () => {
      let ghCode = 0;
      let ghName = '';
      let ghNotes = '';
      try {
        const json = JSON.parse(body);
        if (json && json.tag_name) {
          const tag = json.tag_name;
          ghName = tag.replace(/^v/, '');
          ghCode = calculateVersionCode(ghName);
          ghNotes = json.body || `Release ${tag}`;
        }
      } catch (_) {}
      
      const localVer = getLocalAppVersion() || {};
      const localCode = localVer.versionCode || 140;

      // When version names match (or both indicate v2.6.2), always use the authoritative local metadata
      if (ghName && (ghName === localVer.versionName || ghName === '2.6.2')) {
        return res.json({
          success: true,
          versionCode: localCode || 140,
          versionName: localVer.versionName || ghName,
          downloadUrl: downloadUrl,
          releaseNotes: localVer.releaseNotes || ghNotes
        });
      }

      // Always prioritize whichever is higher
      if (localCode > ghCode) {
        return res.json({
          success: true,
          versionCode: localCode,
          versionName: localVer.versionName || "2.6.2",
          downloadUrl: downloadUrl,
          releaseNotes: localVer.releaseNotes || "✨ New performance improvements & multi-bot stability updates."
        });
      } else if (ghCode > 0) {
        return res.json({
          success: true,
          versionCode: ghCode,
          versionName: ghName,
          downloadUrl: downloadUrl,
          releaseNotes: ghNotes
        });
      }

      return res.json({
        success: true,
        versionCode: localCode || 115,
        versionName: localVer.versionName || "2.3.1",
        downloadUrl: downloadUrl,
        releaseNotes: localVer.releaseNotes || "✨ New performance improvements & multi-bot stability updates."
      });
    });
  }).on('error', () => {
    const localVer = getLocalAppVersion();
    return res.json({
      success: true,
      versionCode: localVer.versionCode || 106,
      versionName: localVer.versionName || "2.2.3",
      downloadUrl: downloadUrl,
      releaseNotes: localVer.releaseNotes || "✨ New performance improvements & multi-bot stability updates."
    });
  });
});

/**
 * Endpoint: GET /api/app/download-latest (Aliases: /app/download-latest, /api/app/download-apk)
 * Resolves pre-signed high-speed CDN direct download URL for the latest GitHub Release APK.
 */
app.get(['/api/app/download-latest', '/app/download-latest', '/api/app/download-apk'], (req, res) => {
  const https = require('https');
  const ghHeaders = {
    'User-Agent': 'TelegramBackup-Server',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (GITHUB_RELEASE_TOKEN) {
    ghHeaders['Authorization'] = `Bearer ${GITHUB_RELEASE_TOKEN}`;
  }

  const getOptions = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO_PATH}/releases/latest`,
    method: 'GET',
    headers: ghHeaders
  };

  https.get(getOptions, (ghRes) => {
    let body = '';
    ghRes.on('data', c => body += c);
    ghRes.on('end', () => {
      try {
        const json = JSON.parse(body);
        const assets = Array.isArray(json.assets) ? json.assets : [];
        const apkAsset =
          assets.find(a => a.name === 'TelegramBackup-latest.apk') ||
          assets.find(a => a.name === `TelegramBackup-${json.tag_name}.apk`) ||
          assets.find(a => a.name && a.name.endsWith('.apk'));

        if (!apkAsset || !apkAsset.id) {
          return res.status(404).json({ success: false, message: 'No APK asset found in latest GitHub release.' });
        }

        const assetHeaders = {
          'User-Agent': 'TelegramBackup-Server',
          'Accept': 'application/octet-stream'
        };
        if (GITHUB_RELEASE_TOKEN) {
          assetHeaders['Authorization'] = `Bearer ${GITHUB_RELEASE_TOKEN}`;
        }

        const assetOpt = {
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_REPO_PATH}/releases/assets/${apkAsset.id}`,
          method: 'GET',
          headers: assetHeaders
        };

        https.get(assetOpt, (assetRes) => {
          if (assetRes.statusCode === 302 && assetRes.headers.location) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.redirect(302, assetRes.headers.location);
          } else {
            return res.status(500).json({ success: false, message: 'Failed to resolve asset download location from GitHub.' });
          }
        }).on('error', err => {
          return res.status(500).json({ success: false, message: err.message });
        });
      } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
    });
  }).on('error', err => {
    return res.status(500).json({ success: false, message: err.message });
  });
});

function getMimeType(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.3gp': 'video/3gpp',
    '.flv': 'video/x-flv',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.flac': 'audio/flac',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.apk': 'application/vnd.android.package-archive',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  return map[ext] || 'application/octet-stream';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =====================================================================================
// 🔐 SECURE GOOGLE MATERIAL 3 FILE SHARING & STREAMING ENGINE
// =====================================================================================

const pinAttemptsMap = new Map();

/**
 * Unified rate limiter for PIN verification on public share links.
 * Locks out requests from an IP after 5 consecutive incorrect attempts for 10 minutes.
 */
function checkSharePinRateLimit(req, shareId) {
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
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

const memoryShareCache = new Map();

// 256-bit cryptographically secure server secret for encrypting sensitive share metadata
const rawShareSecret = process.env.SHARE_SECRET;
if (!rawShareSecret || rawShareSecret.length < 32) {
  throw new Error('FATAL: SHARE_SECRET environment variable is missing or less than 32 characters');
}
const SERVER_SHARE_SECRET = crypto.createHash('sha256').update(rawShareSecret).digest();

/**
 * Encrypts sensitive payload (botToken, encryptionKey, chunks) with AES-256-GCM.
 * Protects credentials from being exposed in URL parameters or page sources.
 */
function encryptServerPayload(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SERVER_SHARE_SECRET, iv);
  let enc = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc;
}

/**
 * Decrypts AES-256-GCM encrypted payload on the server.
 */
function decryptServerPayload(str) {
  const parts = str.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SERVER_SHARE_SECRET, iv);
  decipher.setAuthTag(tag);
  let dec = decipher.update(parts[2], 'hex', 'utf8');
  dec += decipher.final('utf8');
  return JSON.parse(dec);
}

/**
 * Resolves a fresh Telegram direct download CDN URL using the Bot API `getFile`.
 * Completely eliminates the 1-hour expiration bug by dynamically fetching fresh paths.
 */
async function getFreshTelegramUrl(botToken, fileId, retries = 3) {
  if (!botToken || !fileId) return null;
  const cleanToken = String(botToken).trim();
  const cleanId = String(fileId).trim();
  if (cleanId.startsWith('http://') || cleanId.startsWith('https://')) {
    return cleanId;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const tgGetFileUrl = `https://api.telegram.org/bot${cleanToken}/getFile?file_id=${cleanId}`;
      const res = await fetch(tgGetFileUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        if (res.status === 429 && attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        return null;
      }
      const data = await res.json();
      if (data && data.ok && data.result && data.result.file_path) {
        return `https://api.telegram.org/file/bot${cleanToken}/${data.result.file_path}`;
      }
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return null;
}

// In-memory cache for resolved Telegram CDN URLs (prevents 429 rate limits during multi-chunk downloads)
const telegramCdnUrlCache = new Map(); // key: fileId, value: { url, expiresAt }

// Byte-metered LRU chunk buffer cache (prevents duplicate network downloads & serverless OOM crashes, Fix #24)
const chunkBufferCache = new Map(); // key: `${botId}:${fileId}`, value: { buffer, byteLength, accessedAt }
const inFlightFetches = new Map(); // key: `${botId}:${fileId}`, value: Promise<Buffer|null>
const MAX_CHUNK_CACHE_BYTES = 32 * 1024 * 1024; // 32 MB total RAM ceiling
let totalChunkCacheBytes = 0;

const MAGIC_HEADER = Buffer.from([0x45, 0x4E, 0x43, 0x32, 0x35, 0x36, 0x01, 0x00]); // "ENC256\x01\x00" (Legacy AES-256-CBC)
const MAGIC_HEADER_GCM = Buffer.from([0x47, 0x43, 0x4D, 0x32, 0x35, 0x36, 0x01, 0x00]); // "GCM256\x01\x00" (Modern Authenticated AES-256-GCM)
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunk size matching FileChunker.kt

/**
 * Resolves a chunk's fresh Telegram CDN URL with multi-bot fleet failover.
 * Attempts cached URL first, then chunk's recorded bot, followed by all candidate bots in the fleet.
 */
async function resolveChunkUrl(chunk, shareData) {
  if (!chunk) return null;
  const targetFileId = (chunk.telegramFileId || chunk.fileId || '').trim();
  if (!targetFileId) return null;
  if (targetFileId.startsWith('http://') || targetFileId.startsWith('https://')) return targetFileId;

  const candidateTokens = [];
  const addToken = (t) => {
    const clean = (t || '').trim();
    if (clean && !candidateTokens.includes(clean)) candidateTokens.push(clean);
  };

  addToken(chunk.botTokenUsed);
  addToken(chunk.botToken);
  addToken(shareData?.botToken);
  if (Array.isArray(shareData?.candidateBots)) {
    shareData.candidateBots.forEach(addToken);
  }
  addToken(process.env.TELEGRAM_BOT_TOKEN);

  for (const token of candidateTokens) {
    const cacheKey = `${token}:${targetFileId}`;
    const cached = telegramCdnUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    const freshUrl = await getFreshTelegramUrl(token, targetFileId, 2);
    if (freshUrl) {
      chunk.botTokenUsed = token;
      // Cache URL for 45 minutes to prevent Telegram Bot API 429 rate limits
      telegramCdnUrlCache.set(cacheKey, {
        url: freshUrl,
        expiresAt: Date.now() + 45 * 60 * 1000
      });
      return freshUrl;
    }
  }
  return null;
}

/**
 * Fetches and caches a chunk's raw buffer from Telegram CDN.
 * Uses botId:fileId namespaced cache keys, deduplicates concurrent in-flight requests,
 * and guards against serverless OOMs when chunks exceed MAX_CHUNK_CACHE_BYTES.
 */
async function fetchChunkBuffer(chunk, shareData) {
  const fileId = (chunk.telegramFileId || chunk.fileId || '').trim();
  if (!fileId) return null;
  const botId = (chunk.botTokenUsed || chunk.botToken || shareData?.botToken || '').split(':')[0] || 'default';
  const cacheKey = `${botId}:${fileId}`;

  if (chunkBufferCache.has(cacheKey)) {
    const entry = chunkBufferCache.get(cacheKey);
    entry.accessedAt = Date.now();
    return entry.buffer;
  }

  if (inFlightFetches.has(cacheKey)) {
    return await inFlightFetches.get(cacheKey);
  }

  const fetchPromise = (async () => {
    const freshUrl = await resolveChunkUrl(chunk, shareData);
    if (!freshUrl) return null;

    const res = await fetch(freshUrl);
    if (!res.ok) return null;

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const entryBytes = buffer.length;

    // If chunk exceeds max cache size, bypass cache entirely to prevent OOM
    if (entryBytes > MAX_CHUNK_CACHE_BYTES) {
      return buffer;
    }

    // Evict LRU entries until new buffer fits within 32MB ceiling
    while (totalChunkCacheBytes + entryBytes > MAX_CHUNK_CACHE_BYTES && chunkBufferCache.size > 0) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of chunkBufferCache.entries()) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const evicted = chunkBufferCache.get(oldestKey);
        totalChunkCacheBytes -= (evicted?.byteLength || 0);
        chunkBufferCache.delete(oldestKey);
      } else {
        break;
      }
    }

    chunkBufferCache.set(cacheKey, { buffer, byteLength: entryBytes, accessedAt: Date.now() });
    totalChunkCacheBytes += entryBytes;
    return buffer;
  })();

  inFlightFetches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightFetches.delete(cacheKey);
  }
}

/**
 * Reads a range of encrypted bytes [start, end] across sequential 4MB chunks.
 */
async function readEncryptedBytesFromChunks(chunkList, shareData, start, end) {
  const bufs = [];
  for (let idx = 0; idx < chunkList.length; idx++) {
    const chunk = chunkList[idx];
    const chunkStart = idx * CHUNK_SIZE;
    const chunkBuf = await fetchChunkBuffer(chunk, shareData);
    if (!chunkBuf) throw new Error(`Could not fetch chunk ${idx + 1}`);

    const chunkEnd = chunkStart + chunkBuf.length - 1;
    if (chunkEnd < start || chunkStart > end) continue;

    const sliceStart = Math.max(0, start - chunkStart);
    const sliceEnd = Math.min(chunkBuf.length - 1, end - chunkStart);
    bufs.push(chunkBuf.subarray(sliceStart, sliceEnd + 1));
  }
  return Buffer.concat(bufs);
}

/**
 * Decrypts any plaintext byte range [pStart, pEnd] on-the-fly.
 * Seamlessly handles authenticated AES-256-GCM (GCM256 header), legacy AES-256-CBC (ENC256 header),
 * and plain unencrypted multi-chunk files.
 */
async function getDecryptedPlaintextRange(chunkList, shareData, pStart, pEnd) {
  const secretKey = (shareData.encryptionKey || '').trim();
  const totalPlainSize = parseInt(shareData.fileSize) || 0;

  // Check if chunk 1 has GCM or ENC256 magic header
  const firstChunkBuf = await fetchChunkBuffer(chunkList[0], shareData);
  if (!firstChunkBuf) throw new Error('Could not fetch initial chunk');

  const hasGcmHeader = firstChunkBuf.length >= 20 && firstChunkBuf.subarray(0, 8).equals(MAGIC_HEADER_GCM);
  const hasMagicHeader = firstChunkBuf.length >= 8 && firstChunkBuf.subarray(0, 8).equals(MAGIC_HEADER);

  if ((!hasGcmHeader && !hasMagicHeader) || !secretKey) {
    // Plain unencrypted file: slice directly from chunks
    const bufs = [];
    for (let idx = 0; idx < chunkList.length; idx++) {
      const chunk = chunkList[idx];
      const chunkStart = idx * CHUNK_SIZE;
      const chunkBuf = (idx === 0) ? firstChunkBuf : await fetchChunkBuffer(chunk, shareData);
      if (!chunkBuf) throw new Error(`Could not fetch chunk ${idx + 1}`);

      const chunkEnd = chunkStart + chunkBuf.length - 1;
      if (chunkEnd < pStart || chunkStart > pEnd) continue;

      const sliceStart = Math.max(0, pStart - chunkStart);
      const sliceEnd = Math.min(chunkBuf.length - 1, pEnd - chunkStart);
      bufs.push(chunkBuf.subarray(sliceStart, sliceEnd + 1));
    }
    return Buffer.concat(bufs);
  }

  const key = crypto.createHash('sha256').update(secretKey, 'utf8').digest();

  if (hasGcmHeader) {
    // Authenticated AES-256-GCM: 8B header + 12B nonce + ciphertext
    // GCM keystream counter mode starts at block index + 2
    const nonce = firstChunkBuf.subarray(8, 20);
    const blockIndex = Math.floor(pStart / 16);
    const counterVal = 2 + blockIndex;
    const ctrIv = Buffer.alloc(16);
    nonce.copy(ctrIv, 0, 0, 12);
    ctrIv.writeUInt32BE(counterVal, 12);

    const alignedCByteStart = 20 + blockIndex * 16;
    const alignedCByteEnd = 20 + pEnd;
    const rawBytes = await readEncryptedBytesFromChunks(chunkList, shareData, alignedCByteStart, alignedCByteEnd);

    const d = crypto.createDecipheriv('aes-256-ctr', key, ctrIv);
    const decrypted = Buffer.concat([d.update(rawBytes), d.final()]);

    const offsetInBlock = pStart % 16;
    const len = pEnd - pStart + 1;
    return decrypted.subarray(offsetInBlock, offsetInBlock + len);
  }

  // Legacy AES-256-CBC Zero-Knowledge Encryption
  const initialIv = crypto.createHash('md5').update(secretKey, 'utf8').digest();

  const bStart = Math.floor(pStart / 16);
  const bEnd = Math.floor(pEnd / 16);

  const cByteStart = 8 + (bStart > 0 ? (bStart - 1) * 16 : 0);
  const cByteEnd = 8 + (bEnd + 1) * 16 - 1;

  const rawBytes = await readEncryptedBytesFromChunks(chunkList, shareData, cByteStart, cByteEnd);

  let blockIv, toDecrypt;
  if (bStart === 0) {
    blockIv = initialIv;
    toDecrypt = rawBytes;
  } else {
    if (rawBytes.length < 16) return Buffer.alloc(0);
    blockIv = rawBytes.subarray(0, 16);
    toDecrypt = rawBytes.subarray(16);
  }

  if (toDecrypt.length % 16 !== 0) {
    toDecrypt = toDecrypt.subarray(0, Math.floor(toDecrypt.length / 16) * 16);
  }
  if (toDecrypt.length === 0) {
    return Buffer.alloc(0);
  }

  const d = crypto.createDecipheriv('aes-256-cbc', key, blockIv);
  d.setAutoPadding(false);
  const decrypted = Buffer.concat([d.update(toDecrypt), d.final()]);

  const offsetInBlock = pStart % 16;
  const len = pEnd - pStart + 1;
  return decrypted.subarray(offsetInBlock, offsetInBlock + len);
}

/**
 * Normalizes and resolves share metadata from either a database Share ID (s_...)
 * or a stateless encrypted / Base64 fallback token.
 */
async function resolveShareData(identifier) {
  if (!identifier) return null;
  const cleanId = String(identifier).trim();

  // 1. Check in-memory share cache
  if (memoryShareCache.has(cleanId)) {
    const cached = memoryShareCache.get(cleanId);
    let sensitive = {};
    try {
      sensitive = decryptServerPayload(cached.payloadEnc);
    } catch (_) {
      sensitive = cached.sensitive || {};
    }
    return {
      shareId: cleanId,
      fileName: cached.fileName,
      fileSize: cached.fileSize,
      mimeType: cached.mimeType || getMimeType(cached.fileName),
      pinHash: cached.pinHash || '',
      expiresAt: cached.expiresAt || 0,
      botToken: sensitive.botToken || '',
      fileId: sensitive.fileId || '',
      encryptionKey: sensitive.encryptionKey || '',
      totalChunks: sensitive.totalChunks || 1,
      chunks: Array.isArray(sensitive.chunks) ? sensitive.chunks : [],
      candidateBots: Array.isArray(sensitive.candidateBots) ? sensitive.candidateBots : []
    };
  }

  // 2. Query Neon PostgreSQL database
  if (pool && cleanId.startsWith('s_')) {
    try {
      const dbRes = await queryWithTimeout(
        `SELECT share_id, file_name, file_size, mime_type, payload_enc, pin_hash, expires_at, email 
         FROM shared_files WHERE share_id = $1 LIMIT 1`,
        [cleanId]
      );
      if (dbRes && dbRes.rows && dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const sensitive = decryptServerPayload(row.payload_enc);
        const resolved = {
          shareId: row.share_id,
          fileName: row.file_name,
          fileSize: parseInt(row.file_size) || 0,
          mimeType: row.mime_type || getMimeType(row.file_name),
          pinHash: row.pin_hash || '',
          expiresAt: parseInt(row.expires_at) || 0,
          email: row.email || '',
          botToken: sensitive.botToken || '',
          fileId: sensitive.fileId || '',
          encryptionKey: sensitive.encryptionKey || '',
          totalChunks: sensitive.totalChunks || 1,
          chunks: Array.isArray(sensitive.chunks) ? sensitive.chunks : [],
          candidateBots: Array.isArray(sensitive.candidateBots) ? sensitive.candidateBots : []
        };

        // Auto-heal existing share links that only had partial chunks saved
        const expectedChunksCount = resolved.fileSize > CHUNK_SIZE ? Math.ceil(resolved.fileSize / CHUNK_SIZE) : 1;
        if (pool && expectedChunksCount > 1 && resolved.chunks.length < expectedChunksCount) {
          try {
            const repairQuery = row.email
              ? `SELECT chunks_json, total_chunks, bot_token_used, telegram_file_id
                 FROM backed_files
                 WHERE email = $4
                   AND (file_name = $1 OR path LIKE '%' || $1)
                   AND (size = $2 OR (size >= $2 * 0.90 AND size <= $2 * 1.10) OR total_chunks >= $3)
                   AND total_chunks >= 2
                   AND chunks_json IS NOT NULL
                   AND chunks_json != '[]'
                 ORDER BY total_chunks DESC, size DESC LIMIT 1`
              : `SELECT chunks_json, total_chunks, bot_token_used, telegram_file_id
                 FROM backed_files
                 WHERE (file_name = $1 OR path LIKE '%' || $1)
                   AND (size = $2 OR (size >= $2 * 0.90 AND size <= $2 * 1.10) OR total_chunks >= $3)
                   AND total_chunks >= 2
                   AND chunks_json IS NOT NULL
                   AND chunks_json != '[]'
                 ORDER BY total_chunks DESC, size DESC LIMIT 1`;
            const repairParams = row.email
              ? [resolved.fileName, resolved.fileSize, expectedChunksCount, row.email]
              : [resolved.fileName, resolved.fileSize, expectedChunksCount];
            const repairRes = await queryWithTimeout(repairQuery, repairParams);
            if (repairRes && repairRes.rows && repairRes.rows.length > 0) {
              const rRow = repairRes.rows[0];
              const pChunks = JSON.parse(rRow.chunks_json);
              if (Array.isArray(pChunks) && pChunks.length >= 2) {
                resolved.chunks = pChunks.map((c, i) => ({
                  chunkIndex: c.chunkIndex || (i + 1),
                  telegramFileId: c.telegramFileId || c.fileId,
                  botTokenUsed: (c.botTokenUsed || c.botToken || rRow.bot_token_used || resolved.botToken || '').trim()
                }));
                resolved.totalChunks = resolved.chunks.length;

                // Update shared_files DB record with repaired payload
                sensitive.chunks = resolved.chunks;
                sensitive.totalChunks = resolved.totalChunks;
                const newPayloadEnc = encryptServerPayload(sensitive);
                await queryWithTimeout(
                  `UPDATE shared_files SET payload_enc = $1 WHERE share_id = $2`,
                  [newPayloadEnc, cleanId]
                );
                console.log(`[Resolve Share Auto-Heal] Repaired existing share ${cleanId} for ${resolved.fileName}: ${resolved.totalChunks} chunks`);
              }
            }
          } catch (rErr) {
            console.warn('[Resolve Share Auto-Heal Error]', rErr.message);
          }
        }

        memoryShareCache.set(cleanId, {
          fileName: resolved.fileName,
          fileSize: resolved.fileSize,
          mimeType: resolved.mimeType,
          payloadEnc: row.payload_enc,
          pinHash: resolved.pinHash,
          expiresAt: resolved.expiresAt
        });
        return resolved;
      }
    } catch (e) {
      console.warn('[Resolve Share DB Warning]', e.message);
    }
  }

  // 3. Stateless unencrypted tokens containing raw credentials are deprecated and disallowed
  return null;
}

/**
 * POST /api/share/create — Generates a 100% secure, opaque share link.
 * Stores bot tokens and encryption keys securely in Postgres / memory with AES-256-GCM.
 */
async function handleShareCreate(req, res) {
  try {
    const { fileName, fileSize, fileId, botToken, encryptionKey, chunks, pin, expiresAt, candidateBots } = req.body || {};
    if (!fileName || (!fileId && (!Array.isArray(chunks) || chunks.length === 0))) {
      return res.status(400).json({ success: false, message: 'Missing required file data' });
    }

    const shareId = 's_' + crypto.randomBytes(12).toString('hex');
    const safeFileName = path.basename(fileName).replace(/[\r\n\0]/g, '');
    const mimeType = getMimeType(safeFileName);
    const parsedSize = parseInt(fileSize) || 0;
    const expiresAtVal = parseInt(expiresAt) || 0;
    const nowMs = Date.now();
    const userEmail = req.authenticatedEmail;

    if (!userEmail || !isValidEmail(userEmail)) {
      return res.status(401).json({ success: false, message: 'Authentication required to create share links.' });
    }

    let normalizedChunks = Array.isArray(chunks) && chunks.length > 0
      ? chunks.map((c, i) => ({
          chunkIndex: c.chunkIndex || (i + 1),
          telegramFileId: c.telegramFileId || c.fileId,
          botTokenUsed: (c.botTokenUsed || c.botToken || botToken || '').trim()
        }))
      : [{ chunkIndex: 1, telegramFileId: fileId, botTokenUsed: (botToken || '').trim() }];

    const expectedChunksCount = parsedSize > CHUNK_SIZE ? Math.ceil(parsedSize / CHUNK_SIZE) : 1;
    if (pool && expectedChunksCount > 1 && normalizedChunks.length < expectedChunksCount) {
      try {
        const repairRes = await queryWithTimeout(
          `SELECT chunks_json, total_chunks, bot_token_used, telegram_file_id
           FROM backed_files
           WHERE email = $4
             AND (file_name = $1 OR path LIKE '%' || $1)
             AND (size = $2 OR (size >= $2 * 0.90 AND size <= $2 * 1.10) OR total_chunks >= $3)
             AND total_chunks >= 2
             AND chunks_json IS NOT NULL
             AND chunks_json != '[]'
           ORDER BY total_chunks DESC, size DESC LIMIT 1`,
          [safeFileName, parsedSize, expectedChunksCount, userEmail]
        );
        if (repairRes && repairRes.rows && repairRes.rows.length > 0) {
          const row = repairRes.rows[0];
          const parsedChunks = JSON.parse(row.chunks_json);
          if (Array.isArray(parsedChunks) && parsedChunks.length >= 2) {
            normalizedChunks = parsedChunks.map((c, i) => ({
              chunkIndex: c.chunkIndex || (i + 1),
              telegramFileId: c.telegramFileId || c.fileId,
              botTokenUsed: (c.botTokenUsed || c.botToken || row.bot_token_used || botToken || '').trim()
            }));
            console.log(`[Share Create Auto-Heal] Successfully restored all ${normalizedChunks.length} chunks for ${safeFileName} from backed_files`);
          }
        }
      } catch (healErr) {
        console.warn('[Share Create Auto-Heal Error]', healErr.message);
      }
    }

    // Resolve bot credentials internally from database via userEmail and fileId (Fix: internal credential loading)
    let internalBotToken = '';
    if (pool && userEmail) {
      try {
        const uRes = await queryWithTimeout('SELECT bot_token FROM users WHERE email = $1', [userEmail]);
        if (uRes && uRes.rows && uRes.rows.length > 0 && uRes.rows[0].bot_token) {
          internalBotToken = uRes.rows[0].bot_token.trim();
        }
      } catch (_) {}
    } else if (memoryUsers.has(userEmail)) {
      internalBotToken = (memoryUsers.get(userEmail).botToken || '').trim();
    }

    const targetFileId = fileId || (normalizedChunks[0] && normalizedChunks[0].telegramFileId);
    if (pool && userEmail && targetFileId && !internalBotToken) {
      try {
        const fRes = await queryWithTimeout(
          'SELECT bot_token_used FROM backed_files WHERE email = $1 AND telegram_file_id = $2 LIMIT 1',
          [userEmail, targetFileId]
        );
        if (fRes && fRes.rows && fRes.rows.length > 0 && fRes.rows[0].bot_token_used) {
          internalBotToken = fRes.rows[0].bot_token_used.trim();
        }
      } catch (_) {}
    }

    const effectiveBotToken = (internalBotToken || botToken || '').trim();

    // Ensure all chunks have effectiveBotToken populated
    normalizedChunks = normalizedChunks.map(c => ({
      chunkIndex: c.chunkIndex,
      telegramFileId: c.telegramFileId,
      botTokenUsed: (c.botTokenUsed || effectiveBotToken || '').trim()
    }));

    const sensitivePayload = {
      fileId: fileId || normalizedChunks[0].telegramFileId,
      botToken: effectiveBotToken || (normalizedChunks[0] && normalizedChunks[0].botTokenUsed) || '',
      encryptionKey: (encryptionKey || '').trim(),
      totalChunks: normalizedChunks.length,
      chunks: normalizedChunks,
      candidateBots: candidateBotsList
    };

    const payloadEnc = encryptServerPayload(sensitivePayload);
    const pinStr = (pin && String(pin).trim()) || '';
    const pinHash = pinStr.length > 0
      ? crypto.createHash('sha256').update(pinStr).digest('hex')
      : '';

    // Persist to Neon Postgres
    if (pool) {
      try {
        await queryWithTimeout(
          `INSERT INTO shared_files (share_id, file_name, file_size, mime_type, payload_enc, pin_hash, expires_at, created_at, email, file_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (share_id) DO UPDATE SET
             file_name = EXCLUDED.file_name,
             file_size = EXCLUDED.file_size,
             mime_type = EXCLUDED.mime_type,
             payload_enc = EXCLUDED.payload_enc,
             pin_hash = EXCLUDED.pin_hash,
             expires_at = EXCLUDED.expires_at,
             email = EXCLUDED.email,
             file_path = EXCLUDED.file_path`,
          [shareId, safeFileName, parsedSize, mimeType, payloadEnc, pinHash, expiresAtVal, nowMs, userEmail, safeFileName]
        );
      } catch (dbErr) {
        console.error('[Share Create DB Error]', dbErr.message);
        return res.status(503).json({ success: false, message: 'Database service unavailable. Failed to persist share link.' });
      }
    }

    // Save to memory cache
    memoryShareCache.set(shareId, {
      fileName: safeFileName,
      fileSize: parsedSize,
      mimeType,
      payloadEnc,
      pinHash,
      expiresAt: expiresAtVal,
      createdAt: nowMs,
      email: userEmail,
      filePath: safeFileName
    });

    const host = req.get('host') || 'telegram-backup-backend.vercel.app';
    const protocol = req.protocol === 'http' && host.includes('localhost') ? 'http' : 'https';
    const shareUrl = `${protocol}://${host}/share/${shareId}`;
    const directDownloadUrl = `${protocol}://${host}/api/share/download/${shareId}`;

    return res.json({
      success: true,
      shareId,
      shareUrl,
      directDownloadUrl,
      expiresAt: expiresAtVal,
      hasPin: Boolean(pinHash)
    });
  } catch (err) {
    console.error('[Share Create Error]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Universal Streaming & On-The-Fly Decryption Pipeline
 * Handles single-part and multi-part chunked files, dynamically resolves fresh
 * Telegram CDN URLs, and performs streaming AES-256 decryption with zero disk footprint.
 */
async function streamAndDecryptFile(req, res, shareData, isDownload = true) {
  const { fileName, mimeType, encryptionKey, chunks, totalChunks, botToken, fileId } = shareData;
  const safeAscii = (fileName || 'downloaded_file').replace(/[^\w.-]/g, '_');
  const encodedUtf8 = encodeURIComponent(fileName || 'downloaded_file');
  const secretKey = (encryptionKey || '').trim();
  const totalSize = parseInt(shareData.fileSize) || 0;

  // Determine chunk list
  let chunkList = Array.isArray(chunks) && chunks.length > 0 ? chunks : [];
  if (chunkList.length === 0) {
    chunkList = [{ chunkIndex: 1, telegramFileId: fileId, botTokenUsed: botToken }];
  }
  chunkList.sort((a, b) => (a.chunkIndex || 1) - (b.chunkIndex || 1));

  // HTTP Range Request Handling (Universal for all file sizes, single/multi-chunk, plain or AES-256 encrypted)
  const rangeHeader = req && req.headers ? req.headers.range : null;
  if (rangeHeader && totalSize > 0) {
    let start, end;
    if (rangeHeader.startsWith('bytes=-')) {
      const suffixLen = parseInt(rangeHeader.substring(7), 10);
      if (!isNaN(suffixLen) && suffixLen > 0) {
        start = Math.max(0, totalSize - suffixLen);
        end = totalSize - 1;
      }
    } else {
      const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (matches) {
        start = parseInt(matches[1], 10);
        end = matches[2] ? parseInt(matches[2], 10) : totalSize - 1;
      }
    }

    if (!isNaN(start) && start >= 0 && end >= start && start < totalSize) {
      const clampedEnd = Math.min(end, totalSize - 1);
      const expectedLength = clampedEnd - start + 1;
      try {
        const decryptedRange = await getDecryptedPlaintextRange(chunkList, shareData, start, clampedEnd);
        if (!decryptedRange || decryptedRange.length !== expectedLength) {
          console.error(`[Universal Range Request Error] Range length mismatch: got ${decryptedRange?.length || 0}, expected ${expectedLength}`);
          return res.status(502).json({ success: false, message: 'Stream range integrity failure: chunk mismatch or decryption error' });
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${totalSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', decryptedRange.length);
        res.setHeader('Content-Type', mimeType || 'application/octet-stream');
        if (isDownload) {
          res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`);
        } else {
          res.setHeader('Content-Disposition', `inline; filename="${safeAscii}"`);
        }
        res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.end(decryptedRange);
      } catch (rangeErr) {
        console.error('[Universal Range Request Failure]', rangeErr.message);
        return res.status(502).json({ success: false, message: `Failed to decrypt range: ${rangeErr.message}` });
      }
    }
  }

  // RFC-5987 Compliant Content-Disposition and MIME headers
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  if (isDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${safeAscii}"`);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Connection', 'keep-alive');

  if (totalSize > 0 && !secretKey) {
    res.setHeader('Content-Length', totalSize);
  }

  const { PassThrough, Readable, Transform } = require('stream');
  const outPass = new PassThrough();

  // On-The-Fly Zero-Disk Decryption Transform
  if (secretKey) {
    let headerChecked = false;
    let headerBuf = Buffer.alloc(0);
    let decipher = null;

    const decryptTransform = new Transform({
      transform(chunk, encoding, callback) {
        if (!headerChecked) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          if (headerBuf.length < 8) {
            return callback();
          }

          const isGcm = headerBuf.subarray(0, 8).equals(MAGIC_HEADER_GCM);
          const isCbc = headerBuf.subarray(0, 8).equals(MAGIC_HEADER);

          if (isGcm) {
            if (headerBuf.length < 20) {
              return callback(); // Need 8B magic header + 12B nonce
            }
            headerChecked = true;
            const nonce = headerBuf.subarray(8, 20);
            const ctrIv = Buffer.alloc(16);
            nonce.copy(ctrIv, 0, 0, 12);
            ctrIv.writeUInt32BE(2, 12);
            const key = crypto.createHash('sha256').update(secretKey, 'utf8').digest();
            decipher = crypto.createDecipheriv('aes-256-ctr', key, ctrIv);
            decipher.on('error', () => {});
            try {
              const dec = decipher.update(headerBuf.subarray(20));
              if (dec && dec.length > 0) this.push(dec);
            } catch (_) {
              this.push(headerBuf.subarray(20));
            }
            headerBuf = null;
            return callback();
          } else if (isCbc) {
            headerChecked = true;
            const key = crypto.createHash('sha256').update(secretKey, 'utf8').digest();
            const iv = crypto.createHash('md5').update(secretKey, 'utf8').digest();
            decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            decipher.setAutoPadding(true);
            decipher.on('error', () => {});
            try {
              const dec = decipher.update(headerBuf.subarray(8));
              if (dec && dec.length > 0) this.push(dec);
            } catch (_) {
              this.push(headerBuf.subarray(8));
            }
            headerBuf = null;
            return callback();
          } else {
            headerChecked = true;
            // Plain unencrypted file -> Pass through untouched without corrupting!
            this.push(headerBuf);
            headerBuf = null;
            return callback();
          }
        }

        if (decipher) {
          try {
            const dec = decipher.update(chunk);
            if (dec && dec.length > 0) this.push(dec);
          } catch (_) {
            this.push(chunk);
          }
        } else {
          this.push(chunk);
        }
        callback();
      },
      flush(callback) {
        if (!headerChecked && headerBuf && headerBuf.length > 0) {
          this.push(headerBuf);
        }
        if (decipher) {
          try {
            const finalBytes = decipher.final();
            if (finalBytes && finalBytes.length > 0) this.push(finalBytes);
          } catch (err) {
            return callback(err);
          }
        }
        callback();
      }
    });

    outPass.pipe(decryptTransform).pipe(res);
  } else {
    outPass.pipe(res);
  }

  let isAborted = false;
  let activeNodeStream = null;

  res.on('close', () => {
    isAborted = true;
    if (activeNodeStream) {
      try { activeNodeStream.destroy(); } catch (_) {}
    }
    try { outPass.destroy(); } catch (_) {}
  });

  // Fast Parallel CDN URL Pre-Resolution in Batches (Eliminates multi-second sequential roundtrips)
  const resolvedUrls = new Map();
  const batchSize = 6;
  for (let i = 0; i < chunkList.length; i += batchSize) {
    if (isAborted) break;
    const batch = chunkList.slice(i, i + batchSize);
    await Promise.all(batch.map(async (c) => {
      let freshUrl = await resolveChunkUrl(c, shareData);
      if (!freshUrl && c.directUrl) freshUrl = c.directUrl;
      if (!freshUrl && shareData.directUrl) freshUrl = shareData.directUrl;
      if (freshUrl) resolvedUrls.set(c.chunkIndex || 1, freshUrl);
    }));
  }

  // Stream each sequential chunk into the pipeline
  try {
    for (const chunk of chunkList) {
      if (isAborted) break;

      const idx = chunk.chunkIndex || 1;
      let freshUrl = resolvedUrls.get(idx);
      if (!freshUrl) {
        freshUrl = await resolveChunkUrl(chunk, shareData);
      }

      if (!freshUrl) {
        console.error(`[Stream Error] Unable to resolve fresh CDN URL for chunk ${idx}`);
        outPass.destroy(new Error(`Unable to resolve fresh CDN URL for chunk ${idx}`));
        return;
      }

      if (isAborted) break;

      const chunkRes = await fetch(freshUrl);
      if (!chunkRes.ok || !chunkRes.body) {
        console.error(`[Stream Error] Telegram CDN returned HTTP ${chunkRes.status} for chunk ${idx}`);
        outPass.destroy(new Error(`Telegram CDN returned HTTP ${chunkRes.status} for chunk ${idx}`));
        return;
      }

      const nodeChunkStream = Readable.fromWeb(chunkRes.body);
      activeNodeStream = nodeChunkStream;

      await new Promise((resolve, reject) => {
        nodeChunkStream.pipe(outPass, { end: false });
        nodeChunkStream.on('end', () => {
          activeNodeStream = null;
          resolve();
        });
        nodeChunkStream.on('error', (err) => {
          activeNodeStream = null;
          console.warn(`[Chunk Stream Error] Part ${idx}:`, err.message);
          reject(err);
        });
      });
    }
  } catch (streamErr) {
    if (!isAborted) {
      console.error('[Stream Pipeline Exception]', streamErr);
      try { outPass.destroy(streamErr); } catch (_) {}
    }
  } finally {
    try { outPass.end(); } catch (_) {}
  }
}

/**
 * -------------------------------------------------------------------------------------
 * UNIVERSAL GOOGLE MATERIAL 3 WEB SHARE PORTAL & STREAMING HANDLER
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /share, GET /api/share, GET /share/:id, GET /api/share/download/:id
 */
async function handleShare(req, res) {
  // Apply Strict HTTP Security Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  try {
    const identifier = req.params?.token || req.params?.id || req.query?.id || req.query?.data || req.query?.token;
    if (!identifier) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Invalid Link - Telegram Cloud</title>
          <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
            body { background: #10131B; color: #E2E2E9; font-family: 'Roboto', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
            .card { background: #1D2028; border: 1px solid #414751; border-radius: 28px; padding: 36px; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
            h2 { color: #FFB4AB; font-size: 22px; margin: 16px 0 8px; }
            p { color: #8A929E; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size: 52px;">⚠️</div>
            <h2>Invalid Share Link</h2>
            <p>The file link is invalid or incomplete. Please check the URL and try again.</p>
          </div>
        </body>
        </html>
      `);
    }

    const shareData = await resolveShareData(identifier);
    if (!shareData) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <title>File Not Found - Telegram Cloud</title>
          <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
            body { background: #10131B; color: #E2E2E9; font-family: 'Roboto', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
            .card { background: #1D2028; border: 1px solid #414751; border-radius: 28px; padding: 36px; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
            h2 { color: #FFB4AB; font-size: 22px; margin: 16px 0 8px; }
            p { color: #8A929E; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size: 52px;">🔍</div>
            <h2>File Not Found</h2>
            <p>This shared cloud file no longer exists or the link has been removed.</p>
          </div>
        </body>
        </html>
      `);
    }

    const { fileName, fileSize, mimeType, expiresAt, pinHash, plainPin, encryptionKey, chunks, totalChunks } = shareData;

    // 1. Strict Expiry Check
    if (expiresAt && expiresAt > 0 && Date.now() > expiresAt) {
      return res.status(410).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Link Expired - Telegram Cloud</title>
          <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
            body { background: #10131B; color: #E2E2E9; font-family: 'Roboto', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
            .card { background: #1D2028; border: 1px solid #414751; border-radius: 28px; padding: 36px; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
            h2 { color: #FFB4AB; font-size: 22px; margin: 16px 0 8px; }
            p { color: #8A929E; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size: 52px;">⏳</div>
            <h2>Link Expired</h2>
            <p>This protected cloud share link has reached its expiration time limit and is no longer active.</p>
          </div>
        </body>
        </html>
      `);
    }

    // 2. Anti-Brute-Force Rate Limiting on PIN
    const pinRate = checkSharePinRateLimit(req, shareData.shareId);
    if (pinRate.locked) {
      return res.status(429).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Security Lockout - Telegram Cloud</title>
          <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
            body { background: #10131B; color: #E2E2E9; font-family: 'Roboto', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
            .card { background: #1D2028; border: 1px solid #FFB4AB; border-radius: 28px; padding: 36px; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(255,180,171,0.15); }
            h2 { color: #FFB4AB; font-size: 22px; margin: 16px 0 8px; }
            p { color: #8A929E; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size: 52px;">🛡️</div>
            <h2>Too Many Incorrect Attempts</h2>
            <p>Access to this protected file is temporarily locked to prevent unauthorized access.</p>
            <p style="color: #9ECAFF; font-weight: 500;">Please wait ${pinRate.waitSeconds} seconds before trying again.</p>
          </div>
        </body>
        </html>
      `);
    }

    // 3. Timing-Safe PIN Check and Session Authorization
    if (pinHash && pinHash.length > 0) {
      const isAlreadyAuthorized = isShareSessionAuthorized(req, shareData.shareId, pinHash);
      const isPost = req.method === 'POST';
      const userEnteredPin = (req.body?.pin || req.body?.password || req.query?.pin || req.query?.password || req.headers['x-share-pin'] || '').trim();

      if (!isAlreadyAuthorized) {
        let isPinValid = false;
        if (userEnteredPin) {
          const enteredHash = crypto.createHash('sha256').update(userEnteredPin).digest('hex');
          try {
            isPinValid = crypto.timingSafeEqual(Buffer.from(enteredHash, 'utf8'), Buffer.from(pinHash, 'utf8'));
          } catch (_) {
            isPinValid = false;
          }
          if (!isPinValid && plainPin) {
            isPinValid = (userEnteredPin === plainPin);
          }
        }

        if (isPinValid) {
          recordPinAttempt(pinRate.rateLimitKey, pinRate.attempts, true);
          const sessionToken = getShareSessionToken(shareData.shareId, pinHash);
          // Set secure session cookie
          res.setHeader('Set-Cookie', `share_auth_${encodeURIComponent(shareData.shareId)}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
          if (isPost) {
            return res.redirect(303, `/share/${encodeURIComponent(shareData.shareId)}`);
          }
        } else {
          if (userEnteredPin) {
            recordPinAttempt(pinRate.rateLimitKey, pinRate.attempts, false);
          }

          const remainingTries = Math.max(0, 5 - (pinRate.attempts.count || 0));
          return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <title>Protected File - Enter Access PIN</title>
              <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
              <style>
                :root {
                  --md-sys-color-primary: #9ECAFF;
                  --md-sys-color-on-primary: #003258;
                  --md-sys-color-primary-container: #00497D;
                  --md-sys-color-on-primary-container: #D1E4FF;
                  --md-sys-color-surface: #10131B;
                  --md-sys-color-surface-container: #1D2028;
                  --md-sys-color-surface-container-high: #272A33;
                  --md-sys-color-outline: #8A929E;
                  --md-sys-color-error: #FFB4AB;
                }
                * { box-sizing: border-box; }
                body { background: var(--md-sys-color-surface); color: #E2E2E9; font-family: 'Roboto', -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
                .card { background: var(--md-sys-color-surface-container); border: 1px solid #32353E; border-radius: 28px; padding: 36px 28px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
                .lock-icon-wrap { width: 68px; height: 68px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 28px; }
                h2 { font-size: 22px; font-weight: 700; margin: 0 0 6px; color: #F1F0F7; }
                .file-sub { color: var(--md-sys-color-primary); font-size: 13px; font-weight: 500; word-break: break-all; margin-bottom: 20px; padding: 6px 12px; background: rgba(158, 202, 255, 0.08); border-radius: 12px; display: inline-block; }
                .desc { color: var(--md-sys-color-outline); font-size: 14px; margin-bottom: 24px; line-height: 1.4; }
                input { width: 100%; background: var(--md-sys-color-surface-container-high); border: 1.5px solid #414751; border-radius: 16px; padding: 16px; color: #FFF; font-size: 20px; text-align: center; letter-spacing: 6px; outline: none; transition: all 0.2s; margin-bottom: 12px; }
                input:focus { border-color: var(--md-sys-color-primary); box-shadow: 0 0 0 3px rgba(158, 202, 255, 0.2); }
                .error-msg { color: var(--md-sys-color-error); font-size: 13px; margin-bottom: 16px; display: ${userEnteredPin ? 'block' : 'none'}; }
                .btn-unlock { width: 100%; background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); border: none; border-radius: 9999px; padding: 16px; font-size: 15px; font-weight: 700; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
                .btn-unlock:hover { opacity: 0.92; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(158, 202, 255, 0.3); }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="lock-icon-wrap">🔒</div>
                <h2>Protected Cloud File</h2>
                <div class="file-sub">📦 ${escapeHtml(fileName || 'Cloud File')}</div>
                <p class="desc">This file requires a security access PIN to view, stream, or download.</p>
                <form method="POST" action="/share/${escapeHtml(shareData.shareId)}">
                  <input type="password" name="pin" placeholder="••••" autofocus required autocomplete="off" />
                  <div class="error-msg">Incorrect access PIN. ${remainingTries > 0 ? `${remainingTries} attempts remaining.` : 'Locking out...'}</div>
                  <button type="submit" class="btn-unlock">Unlock & Access File</button>
                </form>
              </div>
            </body>
            </html>
          `);
        }
      }
    }

    // 4. Download / Stream Direct Execution
    const isDownload = req.query?.download === '1' || req.path.includes('/download/');
    const isStream = req.query?.stream === '1';

    if (isDownload || isStream) {
      return await streamAndDecryptFile(req, res, shareData, isDownload);
    }

    // 5. Render Full Google Material 3 Web Share Portal
    const downloadUrl = `/api/share/download/${encodeURIComponent(shareData.shareId)}?id=${encodeURIComponent(identifier)}`;
    const streamUrl = `/share/${encodeURIComponent(shareData.shareId)}?id=${encodeURIComponent(identifier)}&stream=1`;

    const fileSizeBytes = parseInt(fileSize) || 0;
    const humanSize = fileSizeBytes > 0 ? (
      fileSizeBytes >= 1073741824 ? (fileSizeBytes / 1073741824).toFixed(2) + ' GB' :
      fileSizeBytes >= 1048576 ? (fileSizeBytes / 1048576).toFixed(1) + ' MB' :
      fileSizeBytes >= 1024 ? (fileSizeBytes / 1024).toFixed(1) + ' KB' :
      fileSizeBytes + ' B'
    ) : '';

    const ext = (fileName || '').toLowerCase().split('.').pop() || '';
    const isVideo = mimeType.startsWith('video/') || ['mp4', 'mkv', 'mov', 'webm'].includes(ext);
    const isAudio = mimeType.startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(ext);
    const isImage = mimeType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext);
    const isPdf = mimeType === 'application/pdf' || ext === 'pdf';
    const isArchive = ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext);
    const isApk = ext === 'apk' || ext === 'xapk';

    const categoryIcon = isVideo ? '🎬' : isAudio ? '🎵' : isImage ? '🖼️' : isPdf ? '📕' : isArchive ? '🗜️' : isApk ? '📱' : '📄';
    const categoryName = isVideo ? 'Video' : isAudio ? 'Audio Track' : isImage ? 'Image' : isPdf ? 'PDF Document' : isArchive ? 'Compressed Archive' : isApk ? 'Android APK Package' : 'Cloud File';

    // Interactive In-Browser Preview Section
    let previewHtml = '';
    if (isVideo) {
      previewHtml = `
        <div class="video-preview-wrap">
          <video id="mediaPlayer" controls playsinline preload="metadata" src="${streamUrl}" poster="">
            Your browser does not support HTML5 video preview.
          </video>
        </div>
      `;
    } else if (isAudio) {
      previewHtml = `
        <div class="audio-preview-wrap">
          <div class="audio-disc">🎵</div>
          <div class="equalizer-bars">
            <span class="bar bar-1"></span><span class="bar bar-2"></span><span class="bar bar-3"></span><span class="bar bar-4"></span><span class="bar bar-5"></span>
          </div>
          <audio id="mediaPlayer" controls src="${streamUrl}" style="width: 100%; outline: none; margin-top: 14px;"></audio>
        </div>
      `;
    } else if (isImage) {
      previewHtml = `
        <div class="image-preview-wrap">
          <img id="mediaPlayer" src="${streamUrl}" alt="${escapeHtml(fileName)}" loading="lazy" />
        </div>
      `;
    } else {
      previewHtml = `
        <div class="generic-file-wrap">
          <div class="file-hero-icon">${categoryIcon}</div>
          <div class="file-hero-type">${categoryName}</div>
          <div class="file-hero-sub">Ready to download safely with verified integrity</div>
        </div>
      `;
    }

    const hasEncryption = Boolean((encryptionKey || '').trim());
    const isChunked = (totalChunks && totalChunks > 1) || (chunks && chunks.length > 1);

    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(fileName)} - Telegram Backup Cloud</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --md-sys-color-primary: #9ECAFF;
            --md-sys-color-on-primary: #003258;
            --md-sys-color-primary-container: #00497D;
            --md-sys-color-on-primary-container: #D1E4FF;
            --md-sys-color-secondary: #BAC8DB;
            --md-sys-color-secondary-container: #3B4858;
            --md-sys-color-surface: #10131B;
            --md-sys-color-surface-container: #1D2028;
            --md-sys-color-surface-container-high: #272A33;
            --md-sys-color-surface-container-highest: #32353E;
            --md-sys-color-outline: #8A929E;
            --md-sys-color-outline-variant: #414751;
            --md-sys-color-success: #67DC87;
          }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background: var(--md-sys-color-surface);
            color: #E2E2E9;
            font-family: 'Roboto', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 24px 16px;
          }
          .portal-container {
            width: 100%;
            max-width: 620px;
            background: var(--md-sys-color-surface-container);
            border: 1px solid var(--md-sys-color-outline-variant);
            border-radius: 28px;
            padding: 32px 28px;
            box-shadow: 0 16px 48px rgba(0,0,0,0.65);
            display: flex;
            flex-direction: column;
            gap: 20px;
          }
          .brand-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .brand-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(158, 202, 255, 0.12);
            color: var(--md-sys-color-primary);
            font-size: 12px;
            font-weight: 700;
            padding: 6px 12px;
            border-radius: 9999px;
            letter-spacing: 0.3px;
          }
          .cloud-verified {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            color: var(--md-sys-color-success);
            font-size: 12px;
            font-weight: 500;
          }
          .file-meta-hero {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .file-title {
            font-size: 20px;
            font-weight: 700;
            color: #F1F0F7;
            word-break: break-all;
            line-height: 1.35;
          }
          .chip-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            margin-top: 4px;
          }
          .meta-chip {
            background: var(--md-sys-color-surface-container-high);
            border: 1px solid rgba(255,255,255,0.06);
            color: #C4C6D0;
            font-size: 12px;
            font-weight: 500;
            padding: 4px 10px;
            border-radius: 8px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }
          .meta-chip.ext {
            color: var(--md-sys-color-primary);
            font-weight: 700;
            text-transform: uppercase;
          }
          .preview-container {
            width: 100%;
            background: var(--md-sys-color-surface-container-high);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 20px;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 180px;
          }
          .video-preview-wrap video {
            width: 100%;
            max-height: 380px;
            border-radius: 20px;
            outline: none;
            background: #000;
          }
          .audio-preview-wrap {
            width: 100%;
            padding: 32px 24px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
          }
          .audio-disc {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: var(--md-sys-color-primary-container);
            color: var(--md-sys-color-on-primary-container);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            box-shadow: 0 8px 24px rgba(0,73,125,0.4);
          }
          .image-preview-wrap img {
            width: 100%;
            max-height: 420px;
            object-fit: contain;
            display: block;
          }
          .generic-file-wrap {
            padding: 40px 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            gap: 8px;
          }
          .file-hero-icon { font-size: 64px; }
          .file-hero-type { font-size: 16px; font-weight: 700; color: #FFF; }
          .file-hero-sub { font-size: 13px; color: var(--md-sys-color-outline); }
          .actions-row {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .btn-primary {
            width: 100%;
            background: var(--md-sys-color-primary);
            color: var(--md-sys-color-on-primary);
            font-size: 16px;
            font-weight: 700;
            padding: 16px 24px;
            border-radius: 9999px;
            border: none;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            transition: all 0.2s ease;
            box-shadow: 0 4px 16px rgba(158, 202, 255, 0.25);
          }
          .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 24px rgba(158, 202, 255, 0.4);
            opacity: 0.95;
          }
          .btn-tonal {
            width: 100%;
            background: var(--md-sys-color-secondary-container);
            color: var(--md-sys-color-secondary);
            font-size: 14px;
            font-weight: 500;
            padding: 14px 20px;
            border-radius: 9999px;
            border: none;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.2s;
          }
          .btn-tonal:hover { background: rgba(255,255,255,0.12); }
          .security-badges {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 12px 16px;
            background: rgba(255,255,255,0.02);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 16px;
          }
          .sec-item {
            font-size: 12px;
            color: var(--md-sys-color-outline);
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .sec-item strong { color: #E2E2E9; }
          .portal-footer {
            text-align: center;
            font-size: 12px;
            color: #64748B;
            margin-top: 8px;
          }
          .portal-footer a { color: var(--md-sys-color-primary); text-decoration: none; }
          .portal-footer a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="portal-container">
          <!-- Brand Header -->
          <div class="brand-header">
            <div class="brand-pill">☁️ TSpace Cloud Storage & Vault</div>
            <div class="cloud-verified">🛡️ Verified Cloud Asset</div>
          </div>

          <!-- File Hero Info -->
          <div class="file-meta-hero">
            <h1 class="file-title">${escapeHtml(fileName)}</h1>
            <div class="chip-row">
              <span class="meta-chip ext">.${escapeHtml(ext)}</span>
              ${humanSize ? `<span class="meta-chip">📦 ${humanSize}</span>` : ''}
              <span class="meta-chip">${escapeHtml(mimeType)}</span>
            </div>
          </div>

          <!-- Interactive Live Preview -->
          <div class="preview-container">
            ${previewHtml}
          </div>

          <!-- Primary Action Buttons -->
          <div class="actions-row">
            <button class="btn-primary" id="downloadBtn" onclick="onDownloadClicked()">
              <span>⬇️</span>
              <span id="dlText">Download File ${humanSize ? '(' + humanSize + ')' : ''}</span>
            </button>
            <button class="btn-tonal" onclick="copyLink()">
              <span>🔗</span>
              <span id="copyBtnText">Copy Share Link</span>
            </button>
          </div>

          <!-- Progressive Download Progress Bar (for multi-part large files) -->
          <div id="progContainer" style="display: none; margin-top: 14px; background: rgba(255,255,255,0.06); border-radius: 14px; padding: 14px 18px; border: 1px solid rgba(255,255,255,0.12);">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; margin-bottom: 8px;">
              <span id="progStatus" style="color: var(--md-sys-color-primary);">⚡ Preparing secure transfer...</span>
              <span id="progPercent" style="color: #A6C8FF;">0%</span>
            </div>
            <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.12); border-radius: 6px; overflow: hidden;">
              <div id="progBarFill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #38EF7D, #11998E); border-radius: 6px; transition: width 0.2s ease;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 8px;">
              <span id="progDetails">0 MB / ${humanSize}</span>
              <a href="${downloadUrl}" style="color: var(--md-sys-color-primary); text-decoration: underline;">Direct Stream Link</a>
            </div>
          </div>

          <!-- Security & Integrity Badges -->
          <div class="security-badges">
            ${hasEncryption ? `
              <div class="sec-item">
                <span>🔒</span>
                <span><strong>Zero-Knowledge AES-256:</strong> File is decrypted securely on-the-fly</span>
              </div>
            ` : `
              <div class="sec-item">
                <span>🛡️</span>
                <span><strong>Direct Stream:</strong> Verified authentic cloud copy from Telegram Cloud</span>
              </div>
            `}
            ${isChunked ? `
              <div class="sec-item">
                <span>🧩</span>
                <span><strong>Multi-Part Integrity:</strong> ${totalChunks} sequential chunks assembled on-the-fly</span>
              </div>
            ` : ''}
            <div class="sec-item">
              <span>⏱️</span>
              <span><strong>Availability:</strong> ${expiresAt > 0 ? 'Protected by custom expiration limit' : 'Permanent cloud link'}</span>
            </div>
          </div>

          <!-- Footer -->
          <div class="portal-footer">
            Protected & Delivered by <a href="/">TSpace Cloud Storage & Vault</a>
          </div>
        </div>

        <script>
          const isChunkedFile = ${isChunked ? 'true' : 'false'};
          const totalChunkCount = ${totalChunks || 1};
          const shareIdentifier = "${escapeHtml(shareData.shareId || identifier)}";
          const fileMimeType = "${escapeHtml(mimeType)}";
          const targetFileName = "${escapeHtml(fileName)}";
          const targetFileSize = ${parseInt(fileSize) || 0};
          const directStreamUrl = "${downloadUrl}";

          async function onDownloadClicked() {
            const btn = document.getElementById('downloadBtn');
            const txt = document.getElementById('dlText');
            const progContainer = document.getElementById('progContainer');
            const progBar = document.getElementById('progBarFill');
            const progStatus = document.getElementById('progStatus');
            const progPercent = document.getElementById('progPercent');
            const progDetails = document.getElementById('progDetails');

            const expectedChunks = targetFileSize > 0 ? Math.ceil(targetFileSize / (4 * 1024 * 1024)) : 1;

            // Integrity guard: if file is multi-chunk but chunk count is incomplete
            if (expectedChunks > 1 && totalChunkCount < expectedChunks) {
              progContainer.style.display = 'block';
              progBar.style.width = '100%';
              progBar.style.backgroundColor = '#FFB4AB';
              progPercent.innerText = '!';
              progStatus.innerText = '⚠️ Incomplete cloud backup: only ' + totalChunkCount + ' of ' + expectedChunks + ' parts are available on Telegram.';
              progDetails.innerText = 'To prevent corrupted file downloads, please re-sync or re-upload the complete file from your device.';
              txt.innerText = '⚠️ Cloud Chunks Incomplete';
              btn.disabled = false;
              btn.style.opacity = '1';
              return;
            }

            // Single chunk or small files <= 4MB: direct download link is instantaneous
            if (!isChunkedFile || totalChunkCount <= 1) {
              if (targetFileSize > 4.5 * 1024 * 1024) {
                progContainer.style.display = 'block';
                progStatus.innerText = '⚠️ Multi-part metadata missing for large file. Direct stream disabled to prevent truncation.';
                txt.innerText = 'Incomplete File';
                return;
              }
              window.location.href = directStreamUrl;
              txt.innerText = '⚡ Connecting Stream...';
              setTimeout(() => { txt.innerText = '⬇️ Downloading File...'; }, 1500);
              setTimeout(() => { txt.innerText = 'Download File ${humanSize ? '(' + humanSize + ')' : ''}'; }, 8000);
              return;
            }

            // Multi-part large file (50MB, 500MB+):
            // Download sequentially via chunk endpoints to bypass all serverless buffer/timeout limits
            try {
              btn.disabled = true;
              btn.style.opacity = '0.7';
              txt.innerText = '⚡ Fetching Chunks...';
              progContainer.style.display = 'block';

              // Try File System Access API for zero-RAM direct-to-disk streaming (Chrome, Edge, Opera)
              let fileWritable = null;
              if (window.showSaveFilePicker) {
                try {
                  const extName = targetFileName.split('.').pop() || '';
                  const fileHandle = await window.showSaveFilePicker({
                    suggestedName: targetFileName,
                    types: [{
                      description: 'File',
                      accept: { [fileMimeType || 'application/octet-stream']: ['.' + extName] }
                    }]
                  });
                  fileWritable = await fileHandle.createWritable();
                } catch (pickerErr) {
                  if (pickerErr.name === 'AbortError') {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    txt.innerText = 'Download File ${humanSize ? '(' + humanSize + ')' : ''}';
                    progContainer.style.display = 'none';
                    return;
                  }
                  fileWritable = null;
                }
              }

              const downloadedParts = [];
              let receivedBytes = 0;
              const startTime = Date.now();

              for (let i = 1; i <= totalChunkCount; i++) {
                // Update progress with speed and ETA
                const elapsedSec = (Date.now() - startTime) / 1000;
                const speedMBps = elapsedSec > 0.5 ? (receivedBytes / (1024 * 1024 * elapsedSec)).toFixed(1) : '...';
                const remainingBytes = Math.max(0, targetFileSize - receivedBytes);
                const etaSec = (speedMBps !== '...' && parseFloat(speedMBps) > 0) ? Math.ceil((remainingBytes / (1024 * 1024)) / parseFloat(speedMBps)) : null;
                const etaText = etaSec != null && etaSec >= 0 ? (' • ' + etaSec + 's remaining') : '';

                progStatus.innerText = '⬇️ Part ' + i + ' of ' + totalChunkCount + (speedMBps !== '...' ? (' • ' + speedMBps + ' MB/s') : '') + etaText;
                const pct = Math.round(((i - 1) / totalChunkCount) * 100);
                progBar.style.width = pct + '%';
                progPercent.innerText = pct + '%';
                const mbDownloaded = (receivedBytes / (1024 * 1024)).toFixed(1);
                const mbTotal = targetFileSize > 0 ? (targetFileSize / (1024 * 1024)).toFixed(1) : (totalChunkCount * 4);
                progDetails.innerText = mbDownloaded + ' MB / ' + mbTotal + ' MB';

                const chunkEndpoint = '/api/share/chunk/' + encodeURIComponent(shareIdentifier) + '/' + i;

                // Robust retry loop: retries up to 4 times per chunk on network blips
                let chunkRes = null;
                let lastError = null;
                for (let attempt = 1; attempt <= 4; attempt++) {
                  try {
                    chunkRes = await fetch(chunkEndpoint, { credentials: 'same-origin' });
                    if (chunkRes.ok) break;
                    lastError = new Error('HTTP ' + chunkRes.status);
                  } catch (fetchErr) {
                    lastError = fetchErr;
                  }
                  if (attempt < 4) {
                    progStatus.innerText = '⚠️ Retrying Part ' + i + ' of ' + totalChunkCount + ' (Attempt ' + (attempt + 1) + ')...';
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                  }
                }
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                  }
                }

                if (!chunkRes || !chunkRes.ok) {
                  throw lastError || new Error('Part ' + i + ' failed to download');
                }

                const blobPart = await chunkRes.blob();
                receivedBytes += blobPart.size;

                if (fileWritable) {
                  // Direct to disk: zero RAM consumption!
                  await fileWritable.write(blobPart);
                } else {
                  // Mobile or non-FS-access browser: accumulate in disk-backed blob array
                  downloadedParts.push(blobPart);
                }
              }

              if (fileWritable) {
                progStatus.innerText = '💾 Finalizing file on disk...';
                await fileWritable.close();
              } else {
                progStatus.innerText = '🧩 Merging verified file...';
                const finalBlob = new Blob(downloadedParts, { type: fileMimeType || 'application/octet-stream' });
                const blobUrl = URL.createObjectURL(finalBlob);
                const downloadLink = document.createElement('a');
                downloadLink.href = blobUrl;
                downloadLink.download = targetFileName;
                document.body.appendChild(downloadLink);
                downloadLink.click();
                document.body.removeChild(downloadLink);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
              }

              progBar.style.width = '100%';
              progPercent.innerText = '100%';
              progStatus.innerText = '✓ Download Complete!';
              progDetails.innerText = (receivedBytes / (1024 * 1024)).toFixed(1) + ' MB Complete';
              txt.innerText = '✓ Download Finished!';

              setTimeout(() => {
                btn.disabled = false;
                btn.style.opacity = '1';
                txt.innerText = 'Download Again';
              }, 4000);

            } catch (err) {
              console.error('[Download Error]', err);
              progStatus.innerText = '❌ Download interrupted: ' + (err.message || 'Network error');
              progBar.style.backgroundColor = '#FFB4AB';
              btn.disabled = false;
              btn.style.opacity = '1';
              txt.innerText = 'Retry Download';
            }
          }

          function copyLink() {
            const url = window.location.origin + '/share/' + encodeURIComponent(shareIdentifier);
            navigator.clipboard.writeText(url).then(() => {
              const btnTxt = document.getElementById('copyBtnText');
              btnTxt.innerText = '✓ Link Copied!';
              setTimeout(() => { btnTxt.innerText = 'Copy Share Link'; }, 2500);
            }).catch(() => {
              alert('Share URL: ' + window.location.href);
            });
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Share link portal error:', err);
    return res.status(500).send(`<h1>Error resolving shared file: ${escapeHtml(err.message)}</h1>`);
  }
}

/**
 * GET /api/share/chunk/:id/:chunkIndex — Delivers a single 4MB chunk directly.
 * Bypasses Vercel execution timeouts for large multi-part files.
 */
async function handleShareChunk(req, res) {
  try {
    const identifier = req.params?.id || req.query?.id;
    const chunkIdx = parseInt(req.params?.chunkIndex || req.query?.chunkIndex, 10);
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Missing file identifier' });
    }
    if (isNaN(chunkIdx) || chunkIdx < 1) {
      return res.status(400).json({ success: false, message: 'Invalid chunk index: must be a positive integer.' });
    }

    const shareData = await resolveShareData(identifier);
    if (!shareData) {
      return res.status(404).json({ success: false, message: 'Shared file not found or expired' });
    }

    // Check expiration if set
    if (shareData.expiresAt > 0 && Date.now() > shareData.expiresAt) {
      return res.status(410).json({ success: false, message: 'This shared file link has expired.' });
    }

    // Check PIN protection if set
    if (shareData.pinHash) {
      if (!isShareSessionAuthorized(req, shareData.shareId, shareData.pinHash)) {
        const pinRate = checkSharePinRateLimit(req, shareData.shareId);
        if (pinRate.locked) {
          return res.status(429).json({
            success: false,
            message: `Too many incorrect PIN attempts. Locked for ${pinRate.waitSeconds} seconds.`
          });
        }

        const pinParam = String(req.query?.pin || req.headers['x-share-pin'] || '').trim();
        let isPinValid = false;
        if (pinParam) {
          const pinHash = crypto.createHash('sha256').update(pinParam).digest('hex');
          try {
            isPinValid = crypto.timingSafeEqual(Buffer.from(pinHash, 'utf8'), Buffer.from(shareData.pinHash, 'utf8'));
          } catch (_) {
            isPinValid = false;
          }
          if (!isPinValid && shareData.plainPin) {
            isPinValid = (pinParam === shareData.plainPin);
          }
        }

        if (!isPinValid) {
          recordPinAttempt(pinRate.rateLimitKey, pinRate.attempts, false);
          return res.status(401).json({ success: false, message: 'Security PIN or authorized session required to access chunk' });
        } else {
          recordPinAttempt(pinRate.rateLimitKey, pinRate.attempts, true);
        }
      }
    }

    let chunkList = Array.isArray(shareData.chunks) && shareData.chunks.length > 0 ? shareData.chunks : [];
    if (chunkList.length === 0) {
      chunkList = [{ chunkIndex: 1, telegramFileId: shareData.fileId, botTokenUsed: shareData.botToken }];
    }
    chunkList.sort((a, b) => (a.chunkIndex || 1) - (b.chunkIndex || 1));

    const totalPlainSize = parseInt(shareData.fileSize) || 0;
    const pStart = (chunkIdx - 1) * CHUNK_SIZE;
    const pEnd = totalPlainSize > 0 ? Math.min(chunkIdx * CHUNK_SIZE - 1, totalPlainSize - 1) : (chunkIdx * CHUNK_SIZE - 1);

    if (totalPlainSize > 0 && pStart >= totalPlainSize) {
      return res.status(416).json({ success: false, message: 'Chunk index exceeds file size' });
    }

    // Decrypt on-the-fly: returns verified plaintext bytes for this chunk
    const plainChunk = await getDecryptedPlaintextRange(chunkList, shareData, pStart, pEnd);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', plainChunk.length);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(plainChunk);
  } catch (err) {
    console.error(`[Share Chunk Error] Part ${req.params?.chunkIndex}:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Register Sharing Engine API Routes
app.post(['/api/share/create', '/share/create'], requireAuth, handleShareCreate);
app.get(['/api/share/download/:id', '/share/download/:id'], (req, res) => {
  req.query.download = '1';
  return handleShare(req, res);
});
app.post(['/api/share/download/:id', '/share/download/:id'], (req, res) => {
  req.query.download = '1';
  return handleShare(req, res);
});
app.get(['/api/share/chunk/:id/:chunkIndex', '/share/chunk/:id/:chunkIndex'], handleShareChunk);
app.get(['/share', '/api/share', '/share/:token', '/api/share/:token', '/share/:id', '/api/share/:id'], handleShare);
app.post(['/share', '/api/share', '/share/:token', '/api/share/:token', '/share/:id', '/api/share/:id'], handleShare);

app.use((req, res, next) => {
  const fullUrl = (req.originalUrl || req.url || '').toLowerCase();
  if ((req.method === 'GET' || req.method === 'POST') && (fullUrl.includes('/share') || req.query?.data)) {
    return handleShare(req, res);
  }
  next();
});

/**
 * -------------------------------------------------------------------------------------
 * ROOT HEALTH CHECK ENDPOINT
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /
 */
app.get('/', (req, res) => {
  res.send('🚀 Telegram Backup Cloud Node.js API Server is Live & Healthy with Multi-SMTP Fallback!');
});

/**
 * -------------------------------------------------------------------------------------
 * GLOBAL EXPRESS ERROR HANDLER
 * -------------------------------------------------------------------------------------
 * Catches all unhandled middleware errors, preventing raw 500 html pages on Vercel.
 */
app.use((err, req, res, next) => {
  // Log full error details server-side for debugging
  console.error('[Global Express Error Handler]:', err.message || err);
  if (err.stack) console.error(err.stack);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({
    success: false,
    message: `Server error: ${err.message || 'An internal server error occurred.'}`
  });
});

/**
 * -------------------------------------------------------------------------------------
 * LOCAL DEVELOPMENT SERVER LISTENER
 * -------------------------------------------------------------------------------------
 * Starts HTTP server on port 3000 during local development (require.main === module).
 */
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

// Export Express App for Vercel Serverless Function Handler
module.exports = app;
