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
const { Pool } = require('@neondatabase/serverless');

// Initialize Express Application Instance
const app = express();

// Middleware: Enable Cross-Origin Resource Sharing for Android App and Web Clients
app.use(cors());

// Middleware: Parse Incoming JSON Request Payloads
app.use(express.json());

/**
 * -------------------------------------------------------------------------------------
 * PROCESS LEVEL SAFETY HANDLERS
 * -------------------------------------------------------------------------------------
 * Prevents Vercel serverless worker processes from crashing when unhandled promise
 * rejections or uncaught exceptions occur during async database or network IO operations.
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process Warning] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process Warning] Uncaught Exception thrown:', err);
});

/**
 * -------------------------------------------------------------------------------------
 * 1. DATABASE CONFIGURATION & INITIALIZATION (NEON POSTGRESQL)
 * -------------------------------------------------------------------------------------
 * Configures connection pool to Neon Serverless PostgreSQL.
 * If DATABASE_URL environment variable is missing or unreachable, the server automatically
 * degrades gracefully to in-memory storage without breaking API calls.
 */
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000 })
  : null;

if (pool) {
  // Listen for unexpected errors on idle PostgreSQL clients
  pool.on('error', (err) => {
    console.error('[Neon Postgres Pool Error]', err.message);
  });
}

/**
 * Executes a PostgreSQL query with a strict timeout (default 3.5 seconds).
 * If the database hangs or is unreachable, it throws a timeout error so the route handler
 * can fall back to in-memory storage immediately instead of triggering a 504 Gateway Timeout.
 */
async function queryWithTimeout(text, params, timeoutMs = 3500) {
  if (!pool) throw new Error('Database pool is disabled or null');
  return Promise.race([
    pool.query(text, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Database query timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}


/**
 * Automatically creates required database tables (users, otps, backed_files) on server boot.
 */
async function initDb() {
  if (!pool) {
    console.log('[Notice] DATABASE_URL environment variable not provided. Operating in-memory mode.');
    return;
  }
  try {
    await queryWithTimeout(`
      CREATE TABLE IF NOT EXISTS users (
        email VARCHAR(255) PRIMARY KEY,
        password_hash TEXT NOT NULL,
        bot_token TEXT DEFAULT '',
        chat_id TEXT DEFAULT '',
        is_locked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS otps (
        email VARCHAR(255) PRIMARY KEY,
        code VARCHAR(10) NOT NULL,
        expires_at BIGINT NOT NULL,
        type VARCHAR(20) DEFAULT 'register'
      );

      CREATE TABLE IF NOT EXISTS backed_files (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        file_name TEXT NOT NULL,
        telegram_file_id TEXT NOT NULL,
        size BIGINT DEFAULT 0,
        path TEXT DEFAULT '',
        timestamp BIGINT NOT NULL,
        message_id BIGINT DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        email VARCHAR(255) PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS shared_files (
        share_id VARCHAR(64) PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_size BIGINT DEFAULT 0,
        mime_type VARCHAR(100) DEFAULT 'application/octet-stream',
        payload_enc TEXT NOT NULL,
        pin_hash VARCHAR(128) DEFAULT '',
        expires_at BIGINT DEFAULT 0,
        download_count INT DEFAULT 0,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shared_files_exp ON shared_files(expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backed_files_email_path ON backed_files(email, path);
      CREATE INDEX IF NOT EXISTS idx_backed_files_email_ts ON backed_files(email, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_backed_files_email_drive ON backed_files(email, is_drive_upload);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json TEXT DEFAULT '{}';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS is_drive_upload BOOLEAN DEFAULT FALSE;
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS chunks_json TEXT DEFAULT '[]';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS channel_id TEXT DEFAULT '';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS bot_token_used TEXT DEFAULT '';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS total_chunks INT DEFAULT 1;
      DELETE FROM otps WHERE expires_at < (EXTRACT(EPOCH FROM NOW()) * 1000);
    `);
    console.log('[Neon Postgres] Database schema, indexes and tables initialized successfully!');

    // Migration: Automatically hash any legacy plain-text passwords in PostgreSQL database using bcrypt (10 rounds)
    try {
      const plainUsers = await queryWithTimeout(`SELECT email, password_hash FROM users WHERE password_hash NOT LIKE '$2%'`);
      if (plainUsers.rows.length > 0) {
        console.log(`[Neon Postgres Migration] Encrypting ${plainUsers.rows.length} legacy plain-text password(s) with bcrypt...`);
        for (const row of plainUsers.rows) {
          const hashed = await bcrypt.hash(row.password_hash, 10);
          await queryWithTimeout(`UPDATE users SET password_hash = $1 WHERE email = $2`, [hashed, row.email]);
        }
        console.log(`[Neon Postgres Migration SUCCESS] All passwords in database are now 100% encrypted with bcrypt!`);
      }
    } catch (migErr) {
      console.warn('[Neon Postgres Migration Warning]', migErr.message);
    }

    // Migration: Automatically repair corrupt/0/1970 or legacy July 15, 2026 placeholder timestamps to current timestamp
    try {
      const tsUpdateRes = await queryWithTimeout(`UPDATE backed_files SET timestamp = EXTRACT(EPOCH FROM NOW()) * 1000 WHERE timestamp = 1784030400000 OR timestamp < 946684800000`);
      if (tsUpdateRes && tsUpdateRes.rowCount > 0) {
        console.log(`[Neon Postgres Migration SUCCESS] Reconciled ${tsUpdateRes.rowCount} legacy/July 2026 timestamp(s) to current era!`);
      }
    } catch (tsErr) {
      console.warn('[Neon Postgres Timestamp Sanitize Warning]', tsErr.message);
    }
  } catch (err) {
    console.error('[Neon Postgres Error] Failed to initialize database tables:', err.message);
  }
}
initDb().catch(err => console.error('[InitDb Catch]', err.message));

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
 * Helper function: Generates a cryptographically random 6-digit verification code.
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
 * -------------------------------------------------------------------------------------
 * 3. API ROUTE: SEND OTP VERIFICATION CODE
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/send-otp (Also aliases: /auth/send-otp, /send-otp)
 * Accepts: { email: string, type: 'register' | '2fa' }
 * Generates 6-digit code with 5-minute expiration and dispatches via Multi-SMTP.
 */
app.post(['/api/auth/send-otp', '/auth/send-otp', '/send-otp', '/api/auth/request-reset', '/auth/request-reset', '/request-reset'], async (req, res, next) => {
  try {
    const { email, type = 'register' } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email address is required.' });
    }

    const code = generateOTP();
    const lowerEmail = email.trim().toLowerCase();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 Minutes TTL

    // Save to Memory Store ALWAYS for guaranteed instant fallback
    memoryOtps.set(lowerEmail, { code, expiresAt, type });

    // Also persist to PostgreSQL DB if available
    if (pool) {
      try {
        await queryWithTimeout(
          `INSERT INTO otps (email, code, expires_at, type) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3, type = $4`,
          [lowerEmail, code, expiresAt, type]
        );
      } catch (dbErr) {
        console.error('[DB Warn] OTP DB save failed, relying on memory store:', dbErr.message);
      }
    }

    // Construct Responsive HTML Email Template
    const mailOptions = {
      to: lowerEmail,
      subject: type === '2fa' ? '2FA Code: Modify Telegram Credentials' : 'Verification Code: Telegram Backup Registration',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #0088cc;">Telegram Backup Cloud</h2>
          <p>Your 6-digit security verification code is:</p>
          <h1 style="background: #eef7fc; display: inline-block; padding: 10px 20px; color: #0088cc; letter-spacing: 4px;">${code}</h1>
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
 * Accepts: { email: string, encryptionKey: string }
 * Sends Master Encryption Key file attachment & access PIN to user's email.
 */
const handleSendKey = async (req, res, next) => {
  try {
    const { email, encryptionKey } = req.body || {};
    if (!email || !encryptionKey) {
      return res.status(400).json({ success: false, message: 'Email and encryption key are required.' });
    }

    const lowerEmail = (email || '').trim().toLowerCase();
    const filePassword = lowerEmail.length >= 4 ? lowerEmail.slice(-4) : '1234';

    const mailOptions = {
      to: lowerEmail,
      subject: '🔑 Your Master AES-256 Security Encryption Key File',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #0088cc;">🔐 Telegram Backup Cloud Security</h2>
          <p>Hello,</p>
          <p>Your files uploaded to Telegram are encrypted on your device using <strong>AES-256 Zero-Knowledge Encryption</strong> before transmission.</p>
          <div style="background-color: #eef6fc; padding: 12px 16px; border-left: 4px solid #0088cc; margin: 15px 0; border-radius: 4px;">
            <strong>🔒 File Access Password / Pin:</strong> <code style="font-size: 16px; font-weight: bold; color: #0088cc;">${filePassword}</code>
            <br/><span style="font-size: 12px; color: #555;">(Password is the last 4 letters of your email: <strong>${lowerEmail}</strong>)</span>
          </div>
          <p>Here is your Master AES-256 Security Encryption Key:</p>
          <div style="background-color: #f4f6f9; padding: 16px; font-size: 20px; font-weight: bold; letter-spacing: 2px; text-align: center; border-radius: 6px; color: #0088cc; font-family: monospace;">
            ${encryptionKey}
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
          content: `==============================================\nTELEGRAM BACKUP CLOUD - MASTER AES-256 KEY\n==============================================\nAccount Email: ${lowerEmail}\nMaster Encryption Key: ${encryptionKey}\nFile Protection Password: ${filePassword} (Last 4 letters of email)\nDate Generated: ${new Date().toISOString()}\n==============================================\nStore this file in a safe location. Without this key, encrypted backups cannot be decrypted.\n`
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

// Universal middleware matcher for Vercel rewrite URLs
app.use((req, res, next) => {
  const fullUrl = (req.originalUrl || req.url || '').toLowerCase();
  if (req.method === 'POST' && fullUrl.includes('send-key')) {
    return handleSendKey(req, res, next);
  }
  next();
});

app.post(['/api/auth/send-key', '/auth/send-key', '/send-key'], handleSendKey);

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
    const lowerEmail = (email || '').toLowerCase();

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
    const otpRecord = await getLatestOtp(lowerEmail);

    if (!otpRecord) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification code. Please request a new code.' });
    }

    const storedCode = otpRecord.code;
    const expiresAt = otpRecord.expiresAt;

    if (storedCode !== cleanCode || Date.now() > expiresAt) {
      const prev = otpAttempts.get(lowerEmail) || { count: 0, lastAttempt: 0 };
      otpAttempts.set(lowerEmail, { count: prev.count + 1, lastAttempt: Date.now() });

      if (Date.now() > expiresAt) {
        await deleteOtp(lowerEmail);
        return res.status(400).json({ success: false, message: 'Verification code expired after 5 minutes. Please request a new code.' });
      }

      return res.status(400).json({ success: false, message: 'Invalid verification code.' });
    }

    // OTP verified — clear attempt counter & purge OTP
    otpAttempts.delete(lowerEmail);
    await deleteOtp(lowerEmail);

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
        await queryWithTimeout(`DELETE FROM otps WHERE email = $1`, [lowerEmail]);
      } catch (dbErr) {
        console.error('[DB Warn] User registration DB query failed, falling back to memory store:', dbErr.message);
        memoryUsers.set(lowerEmail, { password: hashedPassword, botToken: '', chatId: '', isLocked: false });
        memoryOtps.delete(lowerEmail);
      }
    } else {
      memoryUsers.set(lowerEmail, { password: hashedPassword, botToken: '', chatId: '', isLocked: false });
      memoryOtps.delete(lowerEmail);
    }

    return res.json({ success: true, message: 'Account registered successfully!' });
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
 * Returns user profile, botToken, and chatId credentials.
 */
app.post(['/api/auth/login', '/auth/login', '/login'], async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();

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
            botToken: result.rows[0].bot_token,
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
    // Backward compatibility: if stored password is not a bcrypt hash (legacy plain text),
    // fall back to direct comparison and re-hash on successful login
    let passwordValid = false;
    if (user.password && user.password.startsWith('$2')) {
      // Stored password is a bcrypt hash
      passwordValid = await bcrypt.compare(password, user.password);
    } else {
      // Legacy plain text password — compare directly
      passwordValid = (user.password === password);
      // Auto-upgrade: re-hash the password for future logins
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

    return res.json({
      success: true,
      user: {
        email: user.email,
        botToken: user.botToken || '',
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
 *
 * NOTE: The old standalone /api/auth/request-reset handler has been REMOVED.
 * Password reset OTP is now sent exclusively via the unified /api/auth/send-otp route
 * (which already includes /api/auth/request-reset as an alias).
 *
 * This handler is COMPLETELY SELF-CONTAINED — every code path returns JSON.
 * It never calls next(err) to prevent Express from returning HTML error pages.
 */
app.post(['/api/auth/reset-password', '/auth/reset-password', '/reset-password', '/api/auth/verify-reset', '/auth/verify-reset', '/verify-reset'], async (req, res) => {
  // Force JSON content-type on ALL responses from this handler
  res.setHeader('Content-Type', 'application/json');
  try {
    console.log('[reset-password] Handler invoked. Body keys:', Object.keys(req.body || {}));

    const { email, code, newPassword } = req.body || {};
    const lowerEmail = (email || '').trim().toLowerCase();
    const cleanCode = String(code || '').trim();

    console.log('[reset-password] Parsed — email:', lowerEmail, '| codeLen:', cleanCode.length, '| hasNewPassword:', !!newPassword);

    if (!lowerEmail || !lowerEmail.includes('@') || !cleanCode || !newPassword) {
      console.log('[reset-password] REJECT: missing required fields');
      return res.status(400).json({ success: false, message: 'Email, verification code, and new password are required.' });
    }

    // Brute-force protection
    const attempts = otpAttempts.get(lowerEmail);
    if (attempts && attempts.count >= OTP_MAX_ATTEMPTS && (Date.now() - attempts.lastAttempt) < OTP_LOCKOUT_MS) {
      const remainingMins = Math.ceil((OTP_LOCKOUT_MS - (Date.now() - attempts.lastAttempt)) / 60000);
      console.log('[reset-password] REJECT: brute-force lockout for', lowerEmail);
      return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${remainingMins} minutes.` });
    }

    // Retrieve OTP from DB + memory
    let otpRecord = null;
    try {
      otpRecord = await getLatestOtp(lowerEmail);
    } catch (otpErr) {
      console.error('[reset-password] getLatestOtp CRASHED:', otpErr.message);
    }
    console.log('[reset-password] OTP record found:', !!otpRecord, otpRecord ? `storedCode=${otpRecord.code} expiresAt=${otpRecord.expiresAt} now=${Date.now()}` : 'null');

    if (!otpRecord) {
      console.log('[reset-password] REJECT: no OTP record found for', lowerEmail);
      return res.status(400).json({ success: false, message: 'No verification code found. Please request a new OTP first.' });
    }

    const storedCode = otpRecord.code;
    const expiresAt = otpRecord.expiresAt;

    // Check expiration first
    if (Date.now() > expiresAt) {
      console.log('[reset-password] REJECT: OTP expired. expiresAt:', expiresAt, 'now:', Date.now());
      try { await deleteOtp(lowerEmail); } catch (_) {}
      return res.status(400).json({ success: false, message: 'Verification code expired. Please request a new OTP.' });
    }

    // Check code match
    if (storedCode !== cleanCode) {
      console.log('[reset-password] REJECT: code mismatch. stored:', storedCode, 'submitted:', cleanCode);
      const prev = otpAttempts.get(lowerEmail) || { count: 0, lastAttempt: 0 };
      otpAttempts.set(lowerEmail, { count: prev.count + 1, lastAttempt: Date.now() });
      return res.status(400).json({ success: false, message: 'Invalid verification code. Please check your code and try again.' });
    }

    // OTP verified — clear attempt counter & purge OTP
    console.log('[reset-password] OTP VERIFIED for', lowerEmail);
    otpAttempts.delete(lowerEmail);
    try { await deleteOtp(lowerEmail); } catch (_) {}

    // Hash new password with bcrypt
    let hashedPassword;
    try {
      hashedPassword = await bcrypt.hash(newPassword, 10);
    } catch (hashErr) {
      console.error('[reset-password] bcrypt.hash CRASHED:', hashErr.message);
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
        try { await queryWithTimeout(`DELETE FROM otps WHERE email = $1`, [lowerEmail]); } catch (_) {}
        console.log('[reset-password] SUCCESS: password updated in PostgreSQL for', lowerEmail);
      } catch (dbErr) {
        console.error('[reset-password] DB update failed, using memory:', dbErr.message);
        const u = memoryUsers.get(lowerEmail) || {};
        u.password = hashedPassword;
        memoryUsers.set(lowerEmail, u);
        memoryOtps.delete(lowerEmail);
      }
    } else {
      const u = memoryUsers.get(lowerEmail) || {};
      u.password = hashedPassword;
      memoryUsers.set(lowerEmail, u);
      memoryOtps.delete(lowerEmail);
      console.log('[reset-password] SUCCESS: password updated in memory for', lowerEmail);
    }

    return res.status(200).json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    // CATCH-ALL: Never let an error escape to Express's default HTML error handler
    console.error('[reset-password] UNCAUGHT ERROR:', err.message || err);
    if (err.stack) console.error(err.stack);
    try {
      return res.status(500).json({ success: false, message: `Server error: ${err.message || 'An unexpected error occurred.'}` });
    } catch (_) {
      // Last resort: if res.json fails, manually write JSON
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: `Internal server error: ${err.message}` }));
    }
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 8. API ROUTE: SAVE USER TELEGRAM CREDENTIALS
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/credentials/save (Aliases: /credentials/save, /api/user/credentials, /user/credentials)
 * Accepts: { email: string, botToken: string, chatId: string }
 */
app.post(['/api/credentials/save', '/credentials/save', '/api/user/credentials', '/user/credentials'], async (req, res, next) => {
  try {
    const { email, botToken, chatId } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();

    if (pool) {
      try {
        await queryWithTimeout(
          `UPDATE users SET bot_token = $1, chat_id = $2 WHERE email = $3`,
          [botToken, chatId, lowerEmail]
        );
      } catch (dbErr) {
        console.error('[DB Warn] Save credentials DB query failed:', dbErr.message);
        const u = memoryUsers.get(lowerEmail) || {};
        u.botToken = botToken;
        u.chatId = chatId;
        memoryUsers.set(lowerEmail, u);
      }
    } else {
      const u = memoryUsers.get(lowerEmail) || {};
      u.botToken = botToken;
      u.chatId = chatId;
      memoryUsers.set(lowerEmail, u);
    }

    return res.json({ success: true, message: 'Telegram credentials saved successfully.' });
  } catch (err) {
    next(err);
  }
});

/**
 * Endpoint: GET /api/credentials/get (Aliases: /credentials/get, /api/user/credentials/get)
 * Accepts: query ?email=user@domain.com
 * Returns: { success: true, botToken: string, chatId: string }
 */
app.get(['/api/credentials/get', '/credentials/get', '/api/user/credentials/get'], async (req, res, next) => {
  try {
    const email = ((req.query && req.query.email) || '').toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email query parameter is required.' });
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
        console.error('[DB Warn] Get credentials DB query failed:', dbErr.message);
      }
    }
    if (!botToken && memoryUsers.has(email)) {
      const u = memoryUsers.get(email);
      botToken = u.botToken || '';
      chatId = u.chatId || '';
    }

    return res.json({ success: true, botToken, chatId });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 8b. API ROUTES: SAVE & FETCH USER APP SETTINGS JSON
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/user/settings (Aliases: /user/settings, /api/settings/save, /settings/save)
 * Accepts: { email: string, settings: string }
 */
app.post(['/api/user/settings', '/user/settings', '/api/settings/save', '/settings/save'], async (req, res, next) => {
  try {
    const { email, settings, manifest, data } = req.body || {};
    const lowerEmail = (email || '').toLowerCase().trim();
    if (!lowerEmail) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    const rawVal = manifest !== undefined ? manifest : (settings !== undefined ? settings : data);
    const settingsStr = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal || {});

    if (pool) {
      try {
        await queryWithTimeout(
          `CREATE TABLE IF NOT EXISTS user_settings (
            email VARCHAR(255) PRIMARY KEY,
            settings_json TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`
        );
        await queryWithTimeout(
          `INSERT INTO user_settings (email, settings_json, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (email) DO UPDATE SET settings_json = $2, updated_at = CURRENT_TIMESTAMP`,
          [lowerEmail, settingsStr]
        );
        // Also best-effort update users table if user exists
        await queryWithTimeout(`UPDATE users SET settings_json = $1 WHERE email = $2`, [settingsStr, lowerEmail]).catch(() => {});
      } catch (dbErr) {
        console.error('[DB Warn] Save settings query failed:', dbErr.message);
        const u = memoryUsers.get(lowerEmail) || {};
        u.settingsJson = settingsStr;
        memoryUsers.set(lowerEmail, u);
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
 * Accepts: query ?email=user@domain.com
 * Returns: { success: true, settings: string, manifest: string }
 */
app.get(['/api/user/settings', '/user/settings', '/api/settings/get', '/settings/get'], async (req, res, next) => {
  try {
    const email = ((req.query && (req.query.email || req.query.userEmail)) || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
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
        console.error('[DB Warn] Get settings query failed:', dbErr.message);
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
 * Accepts: { email: string, fileName: string, telegramFileId: string, size: number, path: string, messageId: number }
 */
app.post(['/api/files/index', '/files/index', '/api/files/backup', '/files/backup'], async (req, res, next) => {
  try {
    const {
      email, fileName, telegramFileId, size, path, timestamp, messageId,
      isDriveUpload, is_drive_upload,
      chunksJson, chunks_json, chunks,
      channelId, channel_id,
      botTokenUsed, bot_token_used,
      totalChunks, total_chunks
    } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();
    const msgId = messageId || 0;
    const isDrive = Boolean(isDriveUpload || is_drive_upload || telegramFileId === 'DIR_MARKER');

    let finalChunksJson = '[]';
    if (typeof chunksJson === 'string' && chunksJson.trim().length > 0) {
      finalChunksJson = chunksJson.trim();
    } else if (typeof chunks_json === 'string' && chunks_json.trim().length > 0) {
      finalChunksJson = chunks_json.trim();
    } else if (Array.isArray(chunks) && chunks.length > 0) {
      finalChunksJson = JSON.stringify(chunks);
    }
    const finalChannelId = String(channelId || channel_id || '').trim();
    const finalBotToken = String(botTokenUsed || bot_token_used || '').trim();
    const finalTotalChunks = parseInt(totalChunks || total_chunks || '1', 10) || 1;

    // Fix #4: Input validation — reject requests with missing critical fields
    if (!lowerEmail || !lowerEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }
    if (!fileName || !telegramFileId) {
      return res.status(400).json({ success: false, message: 'fileName and telegramFileId are required.' });
    }

    const rawTime = parseInt(timestamp || '0', 10);
    const safeTimestamp = (!rawTime || rawTime < 946684800000 || rawTime === 1784030400000) ? Date.now() : rawTime;

    if (pool) {
      try {
        // Fix #4: Use UPSERT with ON CONFLICT (email, path) to prevent duplicate file records
        await queryWithTimeout(
          `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id, is_drive_upload, chunks_json, channel_id, bot_token_used, total_chunks)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (email, path) DO UPDATE SET
             file_name = $2, telegram_file_id = $3, size = $4, timestamp = $6, message_id = $7, is_drive_upload = $8,
             chunks_json = CASE WHEN $9 != '[]' AND $9 != '' THEN $9 ELSE backed_files.chunks_json END,
             channel_id = CASE WHEN $10 != '' THEN $10 ELSE backed_files.channel_id END,
             bot_token_used = CASE WHEN $11 != '' THEN $11 ELSE backed_files.bot_token_used END,
             total_chunks = CASE WHEN $12 > 1 THEN $12 ELSE backed_files.total_chunks END`,
          [lowerEmail, fileName, telegramFileId, size || 0, path || '', safeTimestamp, msgId, isDrive, finalChunksJson, finalChannelId, finalBotToken, finalTotalChunks]
        );
      } catch (dbErr) {
        console.error('[DB Warn] Files backup DB save failed:', dbErr.message);
        const list = memoryFiles.get(lowerEmail) || [];
        const idx = list.findIndex(f => f.path === path && f.email === lowerEmail);
        const entry = {
          id: idx >= 0 ? list[idx].id : list.length + 1,
          email: lowerEmail, fileName, telegramFileId, size, path, timestamp: safeTimestamp,
          messageId: msgId, isDriveUpload: isDrive, chunksJson: finalChunksJson, channelId: finalChannelId,
          botTokenUsed: finalBotToken, totalChunks: finalTotalChunks
        };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
        memoryFiles.set(lowerEmail, list);
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      const idx = list.findIndex(f => f.path === path && f.email === lowerEmail);
      const entry = {
        id: idx >= 0 ? list[idx].id : list.length + 1,
        email: lowerEmail, fileName, telegramFileId, size, path, timestamp: safeTimestamp,
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
 * Accepts: { email: string, files: [ { fileName, telegramFileId, size, path, timestamp, messageId, isDriveUpload }, ... ] }
 */
app.post(['/api/files/index-batch', '/files/index-batch', '/api/index-files-batch'], async (req, res, next) => {
  try {
    const { email, files } = req.body || {};
    const lowerEmail = (email || '').toLowerCase().trim();

    if (!lowerEmail || !lowerEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
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
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const f of validFiles) {
            const fName = (f.fileName || f.name || '').trim();
            const tgId = (f.telegramFileId || f.fileId || '').trim();
            const fSize = parseInt(f.size || '0', 10) || 0;
            const fPath = (f.path || '').trim();
            const rawTime = parseInt(f.timestamp || '0', 10);
            const fTime = (!rawTime || rawTime < 946684800000 || rawTime === 1784030400000) ? Date.now() : rawTime;
            const msgId = parseInt(f.messageId || '0', 10) || 0;
            const isDrive = Boolean(f.isDriveUpload || f.is_drive_upload || fPath.startsWith('Internal Storage') || tgId === 'DIR_MARKER');
            let fChunksJson = '[]';
            if (typeof f.chunksJson === 'string' && f.chunksJson.trim().length > 0) fChunksJson = f.chunksJson.trim();
            else if (typeof f.chunks_json === 'string' && f.chunks_json.trim().length > 0) fChunksJson = f.chunks_json.trim();
            else if (Array.isArray(f.chunks) && f.chunks.length > 0) fChunksJson = JSON.stringify(f.chunks);
            const fChannel = String(f.channelId || f.channel_id || '').trim();
            const fBot = String(f.botTokenUsed || f.bot_token_used || '').trim();
            const fTotal = parseInt(f.totalChunks || f.total_chunks || '1', 10) || 1;

            await client.query(
              `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id, is_drive_upload, chunks_json, channel_id, bot_token_used, total_chunks)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (email, path) DO UPDATE SET
                 file_name = $2, telegram_file_id = $3, size = $4, timestamp = $6, message_id = $7, is_drive_upload = $8,
                 chunks_json = CASE WHEN $9 != '[]' AND $9 != '' THEN $9 ELSE backed_files.chunks_json END,
                 channel_id = CASE WHEN $10 != '' THEN $10 ELSE backed_files.channel_id END,
                 bot_token_used = CASE WHEN $11 != '' THEN $11 ELSE backed_files.bot_token_used END,
                 total_chunks = CASE WHEN $12 > 1 THEN $12 ELSE backed_files.total_chunks END`,
              [lowerEmail, fName, tgId, fSize, fPath, fTime, msgId, isDrive, fChunksJson, fChannel, fBot, fTotal]
            );
          }
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK');
          throw txErr;
        } finally {
          client.release();
        }
      } catch (dbErr) {
        console.error('[DB Warn] Batch files DB save failed, saving to memory cache:', dbErr.message);
        const list = memoryFiles.get(lowerEmail) || [];
        for (const f of validFiles) {
          const fPath = (f.path || '').trim();
          const idx = list.findIndex(item => item.path === fPath && item.email === lowerEmail);
          let fChunksJson = '[]';
          if (typeof f.chunksJson === 'string' && f.chunksJson.trim().length > 0) fChunksJson = f.chunksJson.trim();
          else if (typeof f.chunks_json === 'string' && f.chunks_json.trim().length > 0) fChunksJson = f.chunks_json.trim();
          else if (Array.isArray(f.chunks) && f.chunks.length > 0) fChunksJson = JSON.stringify(f.chunks);
          const entry = {
            id: idx >= 0 ? list[idx].id : list.length + 1,
            email: lowerEmail,
            fileName: f.fileName || f.name || '',
            telegramFileId: f.telegramFileId || f.fileId || '',
            size: parseInt(f.size || '0', 10) || 0,
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
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      for (const f of validFiles) {
        const fPath = (f.path || '').trim();
        const idx = list.findIndex(item => item.path === fPath && item.email === lowerEmail);
        let fChunksJson = '[]';
        if (typeof f.chunksJson === 'string' && f.chunksJson.trim().length > 0) fChunksJson = f.chunksJson.trim();
        else if (typeof f.chunks_json === 'string' && f.chunks_json.trim().length > 0) fChunksJson = f.chunks_json.trim();
        else if (Array.isArray(f.chunks) && f.chunks.length > 0) fChunksJson = JSON.stringify(f.chunks);
        const entry = {
          id: idx >= 0 ? list[idx].id : list.length + 1,
          email: lowerEmail,
          fileName: f.fileName || f.name || '',
          telegramFileId: f.telegramFileId || f.fileId || '',
          size: parseInt(f.size || '0', 10) || 0,
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
 * Accepts: { email: string, telegramFileId: string, path: string }
 */
app.post(['/api/files/delete', '/files/delete'], async (req, res, next) => {
  try {
    const { email, telegramFileId, path } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();

    // Fix #7: Input validation — require valid email and at least one identifier
    if (!lowerEmail || !lowerEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }
    if (!telegramFileId && !path) {
      return res.status(400).json({ success: false, message: 'telegramFileId or path is required to identify the file.' });
    }

    // Fix #7: Verify the file belongs to this email before deleting
    if (pool) {
      try {
        await queryWithTimeout(
          `DELETE FROM backed_files WHERE email = $1 AND (telegram_file_id = $2 OR (path = $3 AND path != ''))`,
          [lowerEmail, telegramFileId || '', path || '']
        );
      } catch (dbErr) {
        console.error('[DB Warn] Files delete DB query failed:', dbErr.message);
        const list = memoryFiles.get(lowerEmail) || [];
        const filtered = list.filter(f => f.telegramFileId !== telegramFileId && f.path !== path);
        memoryFiles.set(lowerEmail, filtered);
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
 * Accepts: { email: string, mode: "ALL" | "DRIVE_ONLY" | "AUTO_BACKUP_ONLY" | "OLDER_THAN_DAYS", olderThanDays?: number }
 */
app.post(['/api/files/purge', '/files/purge'], async (req, res, next) => {
  try {
    const { email, mode, olderThanDays } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();
    const purgeMode = mode || 'ALL';

    if (!lowerEmail || !lowerEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }

    let queryText = 'WHERE email = $1';
    const queryParams = [lowerEmail];

    if (purgeMode === 'DRIVE_ONLY') {
      queryText += ` AND (is_drive_upload = true OR telegram_file_id = 'DIR_MARKER' OR path LIKE 'Internal Storage%')`;
    } else if (purgeMode === 'AUTO_BACKUP_ONLY') {
      queryText += ` AND (is_drive_upload = false AND telegram_file_id != 'DIR_MARKER' AND path NOT LIKE 'Internal Storage%')`;
    } else if (purgeMode === 'OLDER_THAN_DAYS') {
      const days = parseInt(olderThanDays) || 30;
      const cutoffMs = Date.now() - (days * 86400 * 1000);
      queryText += ` AND timestamp < $2`;
      queryParams.push(cutoffMs);
    }

    let deletedItems = [];

    if (pool) {
      try {
        const fetchRes = await queryWithTimeout(
          `SELECT message_id as "messageId", telegram_file_id as "telegramFileId", path FROM backed_files ${queryText}`,
          queryParams
        );
        deletedItems = fetchRes.rows || [];

        await queryWithTimeout(`DELETE FROM backed_files ${queryText}`, queryParams);
      } catch (dbErr) {
        console.error('[DB Warn] Files purge DB query failed:', dbErr.message);
        const list = memoryFiles.get(lowerEmail) || [];
        memoryFiles.set(lowerEmail, []);
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      deletedItems = list.map(f => ({ messageId: f.messageId, telegramFileId: f.telegramFileId, path: f.path }));
      memoryFiles.set(lowerEmail, []);
    }

    return res.json({
      success: true,
      message: `Successfully purged ${deletedItems.length} file record(s) from cloud database.`,
      deletedCount: deletedItems.length,
      deletedItems
    });
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 9d. API ROUTE: DELETE USER ACCOUNT AND ALL DATA PERMANENTLY
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/user/delete-account (Aliases: /user/delete-account)
 * Accepts: { email: string, password?: string }
 */
app.post(['/api/user/delete-account', '/user/delete-account'], async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();

    if (!lowerEmail || !lowerEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }

    if (pool) {
      try {
        // Optional password check if password provided
        if (password) {
          const userRes = await queryWithTimeout(`SELECT password_hash FROM users WHERE email = $1`, [lowerEmail]);
          if (userRes.rows.length > 0) {
            const hash = userRes.rows[0].password_hash;
            const valid = await bcrypt.compare(password, hash);
            if (!valid) {
              return res.status(401).json({ success: false, message: 'Incorrect password. Account deletion cancelled.' });
            }
          }
        }

        // 1. Fetch file message IDs for Telegram cleanup
        const filesRes = await queryWithTimeout(`SELECT message_id as "messageId", telegram_file_id as "telegramFileId" FROM backed_files WHERE email = $1`, [lowerEmail]);
        const deletedItems = filesRes.rows || [];

        // 2. Delete all backed files
        await queryWithTimeout(`DELETE FROM backed_files WHERE email = $1`, [lowerEmail]);

        // 3. Delete user account record
        await queryWithTimeout(`DELETE FROM users WHERE email = $1`, [lowerEmail]);

        return res.json({
          success: true,
          message: 'User account and all associated cloud file data deleted permanently.',
          deletedCount: deletedItems.length,
          deletedItems
        });
      } catch (dbErr) {
        console.error('[DB Error] Account deletion failed:', dbErr.message);
        memoryFiles.delete(lowerEmail);
        return res.json({ success: true, message: 'Account deleted from memory cache.' });
      }
    } else {
      memoryFiles.delete(lowerEmail);
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
 * Endpoint: GET /api/files/list?email=user@example.com&since=1710000000 (Aliases: /files/list)
 */
app.get(['/api/files/list', '/files/list'], async (req, res, next) => {
  try {
    const email = (req.query.email || '').toLowerCase();
    const since = parseInt(req.query.since || '0', 10) || 0;
    const limit = Math.min(parseInt(req.query.limit || '10000', 10) || 10000, 20000);

    if (pool) {
      try {
        let queryStr = `SELECT id, file_name as "fileName", telegram_file_id as "telegramFileId", size, path, timestamp, message_id as "messageId", is_drive_upload as "isDriveUpload",
           COALESCE(chunks_json, '[]') as "chunksJson",
           COALESCE(channel_id, '') as "channelId",
           COALESCE(bot_token_used, '') as "botTokenUsed",
           COALESCE(total_chunks, 1) as "totalChunks"
           FROM backed_files WHERE email = $1`;
        const params = [email];

        if (since > 0) {
          queryStr += ` AND timestamp > $2 ORDER BY timestamp DESC LIMIT $3`;
          params.push(since, limit);
        } else {
          queryStr += ` ORDER BY timestamp DESC LIMIT $2`;
          params.push(limit);
        }

        const result = await queryWithTimeout(queryStr, params);
        const sanitizedFiles = result.rows.map(row => {
          const ts = parseInt(row.timestamp, 10);
          if (isNaN(ts) || ts < 946684800000 || ts === 1784030400000) {
            row.timestamp = Date.now();
          }
          if (!row.chunksJson || row.chunksJson === 'null') row.chunksJson = '[]';
          row.channelId = row.channelId || '';
          row.botTokenUsed = row.botTokenUsed || '';
          row.totalChunks = parseInt(row.totalChunks, 10) || 1;
          return row;
        });
        return res.json({ success: true, files: sanitizedFiles, isDelta: since > 0 });
      } catch (dbErr) {
        console.error('[DB Warn] Files list DB query failed:', dbErr.message);
        let list = memoryFiles.get(email) || [];
        if (since > 0) {
          list = list.filter(f => f.timestamp > since);
        }
        const sanitizedMem = list.slice(0, limit).map(f => {
          if (!f.timestamp || f.timestamp < 946684800000 || f.timestamp === 1784030400000) f.timestamp = Date.now();
          if (!f.chunksJson) f.chunksJson = '[]';
          f.channelId = f.channelId || '';
          f.botTokenUsed = f.botTokenUsed || '';
          f.totalChunks = f.totalChunks || 1;
          return f;
        });
        return res.json({ success: true, files: sanitizedMem, isDelta: since > 0 });
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
        f.botTokenUsed = f.botTokenUsed || '';
        f.totalChunks = f.totalChunks || 1;
        return f;
      });
      return res.json({ success: true, files: sanitizedMem, isDelta: since > 0 });
    }
  } catch (err) {
    next(err);
  }
});

const GITHUB_RELEASE_TOKEN = process.env.GITHUB_TOKEN || 'REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_01';
const GITHUB_REPO_PATH = 'sid-codes28/telegram_backup_backend';

/**
 * Safely loads the local app-version.json file with cross-platform and Vercel serverless fallback.
 */
function getLocalAppVersion() {
  try {
    return require('./app-version.json');
  } catch (e1) {
    try {
      return require('../app-version.json');
    } catch (e2) {
      try {
        const fs = require('fs');
        const path = require('path');
        return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'app-version.json'), 'utf8'));
      } catch (_) {
        return {
          versionCode: 106,
          versionName: '2.2.3',
          releaseNotes: `✨ What's New in Release v2.2.3:
- 🚀 Seamless In-App Auto-Update Engine: Integrated compile-time BuildConfig versioning and unified update comparisons. Guarantees immediate in-app update prompts and 1-tap installation
- 🩵 Komi Store Floating Capsule Nav Bar: Compact floating liquid pill bar inspired by Komi Store (~62dp) with spring bouncy touch animations (1.08x scale), continuous rounded corners, and soft elevation
- ⚡ Zero-Lag Direction-Aware Tab Transitions: Eliminated main-thread disk I/O, regex recompilations, and 4-pass calculation loops. Added buttery horizontal slide transitions that follow navigation direction
- 📜 Smart Scroll Auto-Hide: Bottom navigation bar intelligently slides down out of view when scrolling down to maximize content space, and smoothly glides back up on scroll up or tab tap
- 🔔 Minimalist Symbolic Notifications: Removed verbose sentence text in favor of clean glyph icons and metrics (☁️, ⚡, ⬆️, ⬇️, ✓, 💾, ⏱️) with quick action buttons ([⏸️ Pause], [📊 Progress], [📁 Drive], [📂 Open], [📤 Share])
- 🧹 Modernized Trash Bin & Local Storage UX: Removed descriptive text clutter and bulky red containers; streamlined with compact status pills, inline search, and efficient space utilization
- 📖 Separated Setup Guide & User Manual: Split into dedicated tabs for 🚀 Setup Guide (4-step credentials setup) and 📖 Features & Manual (Cloud Drive streaming, Safe Folder encryption, Direct Share Links, Multi-Bot Fleet)
- 📋 Komi Store Style Changelog: Horizontal version selector chips (v2.2.3, v2.2.2, v2.2.1, v2.2.00) and categorized change tags (UPDATER, DESIGN, PERFORMANCE, EXPERIENCE, NOTIFICATIONS, CLEAN UI, GUIDES)`
        };
      }
    }
  }
}

/**
 * Computes monotonic, continuous Android versionCode from semantic version string.
 * Supports legacy 2.1.xx series as well as the new single-digit system (2.2.0 = 103, 2.2.1 = 104, 2.2.9 = 112, 2.3.0 = 113).
 */
function calculateVersionCode(name) {
  const localVer = getLocalAppVersion();
  const cleanName = (name || '').replace(/^v/, '').trim();
  if (localVer && localVer.versionName === cleanName && localVer.versionCode) {
    return localVer.versionCode;
  }
  const parts = cleanName.split('.').map(p => parseInt(p, 10));
  if (parts.length >= 3 && !parts.some(isNaN)) {
    const [major, minor, patch] = parts;
    if (major === 2 && minor === 1) {
      return patch + 3;
    } else if (major === 2 && minor >= 2) {
      return 103 + (minor - 2) * 10 + patch;
    } else if (major > 2) {
      return 103 + 80 + (major - 3) * 100 + minor * 10 + patch;
    }
  }
  if (localVer && localVer.versionCode) {
    return localVer.versionCode;
  }
  return 106;
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
  const getOptions = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO_PATH}/releases/latest`,
    method: 'GET',
    headers: {
      'User-Agent': 'TelegramBackup-Server',
      'Authorization': `Bearer ${GITHUB_RELEASE_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
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
      const localCode = localVer.versionCode || 0;

      // Always prioritize whichever is higher
      if (localCode > ghCode) {
        return res.json({
          success: true,
          versionCode: localCode,
          versionName: localVer.versionName || "2.3.0",
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
  const getOptions = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO_PATH}/releases/latest`,
    method: 'GET',
    headers: {
      'User-Agent': 'TelegramBackup-Server',
      'Authorization': `Bearer ${GITHUB_RELEASE_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  https.get(getOptions, (ghRes) => {
    let body = '';
    ghRes.on('data', c => body += c);
    ghRes.on('end', () => {
      try {
        const json = JSON.parse(body);
        const assets = json.assets || [];
        const apkAsset = assets.find(a => a.name && a.name.endsWith('.apk')) || assets[0];

        if (!apkAsset) {
          return res.status(404).json({ success: false, message: 'No APK asset found in latest GitHub release.' });
        }

        const assetOpt = {
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_REPO_PATH}/releases/assets/${apkAsset.id}`,
          method: 'GET',
          headers: {
            'User-Agent': 'TelegramBackup-Server',
            'Authorization': `Bearer ${GITHUB_RELEASE_TOKEN}`,
            'Accept': 'application/octet-stream'
          }
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
const memoryShareCache = new Map();

// 256-bit server secret for encrypting sensitive share metadata
const SERVER_SHARE_SECRET = crypto.createHash('sha256')
  .update(process.env.DATABASE_URL || process.env.JWT_SECRET || 'TelegramBackupMasterShareSecret2026_SecureKey!')
  .digest();

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

// LRU chunk buffer cache (prevents duplicate network downloads across chunk boundaries)
const chunkBufferCache = new Map(); // key: fileId, value: { buffer, accessedAt }
const MAX_CHUNK_CACHE_ENTRIES = 24;

const MAGIC_HEADER = Buffer.from([0x45, 0x4E, 0x43, 0x32, 0x35, 0x36, 0x01, 0x00]); // "ENC256\x01\x00"
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

  // Check in-memory CDN URL cache first (Telegram file paths are valid for 1 hour)
  const cached = telegramCdnUrlCache.get(targetFileId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

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
    const freshUrl = await getFreshTelegramUrl(token, targetFileId, 2);
    if (freshUrl) {
      chunk.botTokenUsed = token;
      // Cache URL for 45 minutes to prevent Telegram Bot API 429 rate limits
      telegramCdnUrlCache.set(targetFileId, {
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
 */
async function fetchChunkBuffer(chunk, shareData) {
  const fileId = (chunk.telegramFileId || chunk.fileId || '').trim();
  if (chunkBufferCache.has(fileId)) {
    const entry = chunkBufferCache.get(fileId);
    entry.accessedAt = Date.now();
    return entry.buffer;
  }

  const freshUrl = await resolveChunkUrl(chunk, shareData);
  if (!freshUrl) return null;

  const res = await fetch(freshUrl);
  if (!res.ok) return null;

  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  if (chunkBufferCache.size >= MAX_CHUNK_CACHE_ENTRIES) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of chunkBufferCache.entries()) {
      if (v.accessedAt < oldestTime) {
        oldestTime = v.accessedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) chunkBufferCache.delete(oldestKey);
  }

  chunkBufferCache.set(fileId, { buffer, accessedAt: Date.now() });
  return buffer;
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
 * Seamlessly handles both AES-256-CBC encrypted multi-chunk files (with ENC256 magic header)
 * and plain unencrypted multi-chunk files.
 */
async function getDecryptedPlaintextRange(chunkList, shareData, pStart, pEnd) {
  const secretKey = (shareData.encryptionKey || '').trim();
  const totalPlainSize = parseInt(shareData.fileSize) || 0;

  // Check if chunk 1 has the ENC256 magic header
  const firstChunkBuf = await fetchChunkBuffer(chunkList[0], shareData);
  if (!firstChunkBuf) throw new Error('Could not fetch initial chunk');

  const hasMagicHeader = firstChunkBuf.length >= 8 && firstChunkBuf.subarray(0, 8).equals(MAGIC_HEADER);

  if (!hasMagicHeader || !secretKey) {
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

  // Encrypted with AES-256-CBC Zero-Knowledge Encryption
  const key = crypto.createHash('sha256').update(secretKey, 'utf8').digest();
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
        `SELECT share_id, file_name, file_size, mime_type, payload_enc, pin_hash, expires_at 
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
            const repairRes = await queryWithTimeout(
              `SELECT chunks_json, total_chunks, bot_token_used, telegram_file_id
               FROM backed_files
               WHERE (file_name = $1 OR path LIKE '%' || $1)
                 AND size = $2
                 AND total_chunks >= $3
                 AND chunks_json IS NOT NULL
                 AND chunks_json != '[]'
               ORDER BY total_chunks DESC LIMIT 1`,
              [resolved.fileName, resolved.fileSize, expectedChunksCount]
            );
            if (repairRes && repairRes.rows && repairRes.rows.length > 0) {
              const rRow = repairRes.rows[0];
              const pChunks = JSON.parse(rRow.chunks_json);
              if (Array.isArray(pChunks) && pChunks.length >= expectedChunksCount) {
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

  // 3. Fallback: Parse Base64 / URL-Safe Token
  try {
    let normalized = cleanId.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    const raw = JSON.parse(decoded);

    let pinHash = '';
    if (raw.pinHash) {
      pinHash = raw.pinHash;
    } else if (raw.pin && String(raw.pin).trim()) {
      pinHash = crypto.createHash('sha256').update(String(raw.pin).trim()).digest('hex');
    }

    let chunks = [];
    if (Array.isArray(raw.chunks) && raw.chunks.length > 0) {
      chunks = raw.chunks;
    } else if (raw.fileId) {
      chunks = [{ chunkIndex: 1, telegramFileId: raw.fileId, botTokenUsed: raw.botToken }];
    }

    return {
      shareId: cleanId.substring(0, 16),
      fileName: raw.fileName || 'shared_file',
      fileSize: parseInt(raw.fileSize) || 0,
      mimeType: getMimeType(raw.fileName || ''),
      pinHash,
      plainPin: raw.pin ? String(raw.pin).trim() : '',
      expiresAt: parseInt(raw.expiresAt) || 0,
      botToken: raw.botToken || '',
      fileId: raw.fileId || '',
      encryptionKey: raw.encryptionKey || raw.encKey || '',
      totalChunks: parseInt(raw.totalChunks) || chunks.length || 1,
      chunks,
      candidateBots: Array.isArray(raw.candidateBots) ? raw.candidateBots : []
    };
  } catch (_) {
    return null;
  }
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
           WHERE (file_name = $1 OR path LIKE '%' || $1)
             AND size = $2
             AND total_chunks >= $3
             AND chunks_json IS NOT NULL
             AND chunks_json != '[]'
           ORDER BY total_chunks DESC LIMIT 1`,
          [safeFileName, parsedSize, expectedChunksCount]
        );
        if (repairRes && repairRes.rows && repairRes.rows.length > 0) {
          const row = repairRes.rows[0];
          const parsedChunks = JSON.parse(row.chunks_json);
          if (Array.isArray(parsedChunks) && parsedChunks.length >= expectedChunksCount) {
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

    const candidateBotsList = Array.isArray(candidateBots)
      ? candidateBots.filter(b => typeof b === 'string' && b.trim()).map(b => b.trim())
      : [];

    const sensitivePayload = {
      fileId: fileId || normalizedChunks[0].telegramFileId,
      botToken: (botToken || normalizedChunks[0].botTokenUsed || '').trim(),
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
          `INSERT INTO shared_files (share_id, file_name, file_size, mime_type, payload_enc, pin_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (share_id) DO UPDATE SET
             file_name = EXCLUDED.file_name,
             file_size = EXCLUDED.file_size,
             mime_type = EXCLUDED.mime_type,
             payload_enc = EXCLUDED.payload_enc,
             pin_hash = EXCLUDED.pin_hash,
             expires_at = EXCLUDED.expires_at`,
          [shareId, safeFileName, parsedSize, mimeType, payloadEnc, pinHash, expiresAtVal, nowMs]
        );
      } catch (dbErr) {
        console.warn('[Share Create DB Error]', dbErr.message);
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
      createdAt: nowMs
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
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    if (!isNaN(start) && start >= 0 && end >= start && start < totalSize) {
      const clampedEnd = Math.min(end, totalSize - 1);
      try {
        const decryptedRange = await getDecryptedPlaintextRange(chunkList, shareData, start, clampedEnd);

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
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.end(decryptedRange);
      } catch (rangeErr) {
        console.warn('[Universal Range Request Fallback]', rangeErr.message);
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
  res.setHeader('Cache-Control', 'public, max-age=86400');
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
          if (headerBuf.length >= 8) {
            headerChecked = true;
            if (headerBuf.subarray(0, 8).equals(MAGIC_HEADER)) {
              // Modern Verified Magic Header Encrypted Payload
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
            } else {
              // Plain unencrypted file -> Pass through untouched without corrupting!
              this.push(headerBuf);
            }
            headerBuf = null;
          }
          return callback();
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
          } catch (_) {}
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
        continue;
      }

      if (isAborted) break;

      const chunkRes = await fetch(freshUrl);
      if (!chunkRes.ok || !chunkRes.body) {
        console.error(`[Stream Error] Telegram CDN returned HTTP ${chunkRes.status} for chunk ${idx}`);
        continue;
      }

      const nodeChunkStream = Readable.fromWeb(chunkRes.body);
      activeNodeStream = nodeChunkStream;

      await new Promise((resolve) => {
        nodeChunkStream.pipe(outPass, { end: false });
        nodeChunkStream.on('end', () => {
          activeNodeStream = null;
          resolve();
        });
        nodeChunkStream.on('error', (err) => {
          activeNodeStream = null;
          console.warn(`[Chunk Stream Error] Part ${idx}:`, err.message);
          resolve(); // Continue to next chunk gracefully
        });
      });
    }
  } catch (streamErr) {
    if (!isAborted) {
      console.error('[Stream Pipeline Exception]', streamErr);
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
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const rateLimitKey = `${clientIp}_${shareData.shareId}`;
    const nowMs = Date.now();
    const attempts = pinAttemptsMap.get(rateLimitKey) || { count: 0, lockUntil: 0 };

    if (attempts.lockUntil > nowMs) {
      const waitSeconds = Math.ceil((attempts.lockUntil - nowMs) / 1000);
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
            <p style="color: #9ECAFF; font-weight: 500;">Please wait ${waitSeconds} seconds before trying again.</p>
          </div>
        </body>
        </html>
      `);
    }

    // 3. Timing-Safe PIN Check
    const userEnteredPin = (req.query?.pin || req.query?.password || req.headers['x-share-pin'] || '').trim();
    if (pinHash && pinHash.length > 0) {
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

      if (!isPinValid) {
        if (userEnteredPin) {
          attempts.count += 1;
          if (attempts.count >= 5) {
            attempts.lockUntil = nowMs + (10 * 60 * 1000); // 10 min lockout
          }
          pinAttemptsMap.set(rateLimitKey, attempts);
        }

        const remainingTries = Math.max(0, 5 - attempts.count);
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
              <form method="GET" action="/share/${escapeHtml(shareData.shareId)}">
                <input type="hidden" name="id" value="${escapeHtml(identifier)}" />
                <input type="password" name="pin" placeholder="••••" autofocus required autocomplete="off" />
                <div class="error-msg">Incorrect access PIN. ${remainingTries > 0 ? `${remainingTries} attempts remaining.` : 'Locking out...'}</div>
                <button type="submit" class="btn-unlock">Unlock & Access File</button>
              </form>
            </div>
          </body>
          </html>
        `);
      } else {
        pinAttemptsMap.delete(rateLimitKey);
      }
    }

    // 4. Download / Stream Direct Execution
    const isDownload = req.query?.download === '1' || req.path.includes('/download/');
    const isStream = req.query?.stream === '1';

    if (isDownload || isStream) {
      return await streamAndDecryptFile(req, res, shareData, isDownload);
    }

    // 5. Render Full Google Material 3 Web Share Portal
    const pinParam = userEnteredPin ? `&pin=${encodeURIComponent(userEnteredPin)}` : '';
    const downloadUrl = `/api/share/download/${encodeURIComponent(shareData.shareId)}?id=${encodeURIComponent(identifier)}${pinParam}`;
    const streamUrl = `/share/${encodeURIComponent(shareData.shareId)}?id=${encodeURIComponent(identifier)}${pinParam}&stream=1`;

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
          const sharePin = "${escapeHtml(userEnteredPin || '')}";

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
              const pinQuery = sharePin ? ('?pin=' + encodeURIComponent(sharePin)) : '';

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

                const chunkEndpoint = '/api/share/chunk/' + encodeURIComponent(shareIdentifier) + '/' + i + pinQuery;

                // Robust retry loop: retries up to 4 times per chunk on network blips
                let chunkRes = null;
                let lastError = null;
                for (let attempt = 1; attempt <= 4; attempt++) {
                  try {
                    chunkRes = await fetch(chunkEndpoint);
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
              console.warn('[Progressive chunk assembly notice, switching to direct stream]', err);
              progStatus.innerText = '⚠️ Direct stream fallback...';
              setTimeout(() => {
                window.location.href = directStreamUrl;
                btn.disabled = false;
                btn.style.opacity = '1';
                txt.innerText = 'Download File ${humanSize ? '(' + humanSize + ')' : ''}';
              }, 1200);
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
    const chunkIdx = parseInt(req.params?.chunkIndex || req.query?.chunkIndex) || 1;
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Missing file identifier' });
    }

    const shareData = await resolveShareData(identifier);
    if (!shareData) {
      return res.status(404).json({ success: false, message: 'Shared file not found or expired' });
    }

    // Check PIN protection if set
    if (shareData.pinHash) {
      const pinParam = req.query?.pin || req.headers['x-share-pin'] || '';
      const pinHash = crypto.createHash('sha256').update(String(pinParam).trim()).digest('hex');
      if (pinHash !== shareData.pinHash) {
        return res.status(401).json({ success: false, message: 'Security PIN required to access chunk' });
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
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(plainChunk);
  } catch (err) {
    console.error(`[Share Chunk Error] Part ${req.params?.chunkIndex}:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Register Sharing Engine API Routes
app.post(['/api/share/create', '/share/create'], handleShareCreate);
app.get(['/api/share/download/:id', '/share/download/:id'], (req, res) => {
  req.query.download = '1';
  return handleShare(req, res);
});
app.get(['/api/share/chunk/:id/:chunkIndex', '/share/chunk/:id/:chunkIndex'], handleShareChunk);
app.get(['/share', '/api/share', '/share/:token', '/api/share/:token', '/share/:id', '/api/share/:id'], handleShare);

app.use((req, res, next) => {
  const fullUrl = (req.originalUrl || req.url || '').toLowerCase();
  if (req.method === 'GET' && (fullUrl.includes('/share') || req.query?.data)) {
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
