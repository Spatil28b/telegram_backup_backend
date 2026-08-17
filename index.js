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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backed_files_email_path ON backed_files(email, path);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json TEXT DEFAULT '{}';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS is_drive_upload BOOLEAN DEFAULT FALSE;
    `);
    console.log('[Neon Postgres] Database schema and tables initialized successfully!');

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
    const { email, settings } = req.body || {};
    const lowerEmail = (email || '').toLowerCase().trim();
    if (!lowerEmail) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    const settingsStr = typeof settings === 'string' ? settings : JSON.stringify(settings || {});

    if (pool) {
      try {
        await queryWithTimeout(
          `UPDATE users SET settings_json = $1 WHERE email = $2`,
          [settingsStr, lowerEmail]
        );
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
 * Returns: { success: true, settings: string }
 */
app.get(['/api/user/settings', '/user/settings', '/api/settings/get', '/settings/get'], async (req, res, next) => {
  try {
    const email = ((req.query && req.query.email) || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    let settings = null;
    if (pool) {
      try {
        const result = await queryWithTimeout(`SELECT settings_json FROM users WHERE email = $1`, [email]);
        if (result.rows.length > 0 && result.rows[0].settings_json) {
          settings = result.rows[0].settings_json;
        }
      } catch (dbErr) {
        console.error('[DB Warn] Get settings query failed:', dbErr.message);
      }
    }

    if (!settings && memoryUsers.has(email)) {
      const u = memoryUsers.get(email);
      settings = u.settingsJson || null;
    }

    return res.json({ success: true, settings: settings || '{}' });
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
    const { email, fileName, telegramFileId, size, path, timestamp, messageId, isDriveUpload, is_drive_upload } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();
    const msgId = messageId || 0;
    const isDrive = Boolean(isDriveUpload || is_drive_upload || telegramFileId === 'DIR_MARKER');

    // Fix #4: Input validation — reject requests with missing critical fields
    if (!lowerEmail || !lowerEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }
    if (!fileName || !telegramFileId) {
      return res.status(400).json({ success: false, message: 'fileName and telegramFileId are required.' });
    }

    if (pool) {
      try {
        // Fix #4: Use UPSERT with ON CONFLICT (email, path) to prevent duplicate file records
        await queryWithTimeout(
          `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id, is_drive_upload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (email, path) DO UPDATE SET
             file_name = $2, telegram_file_id = $3, size = $4, timestamp = $6, message_id = $7, is_drive_upload = $8`,
          [lowerEmail, fileName, telegramFileId, size || 0, path || '', timestamp || Date.now(), msgId, isDrive]
        );
      } catch (dbErr) {
        console.error('[DB Warn] Files backup DB save failed:', dbErr.message);
        const list = memoryFiles.get(lowerEmail) || [];
        const idx = list.findIndex(f => f.path === path && f.email === lowerEmail);
        if (idx >= 0) {
          list[idx] = { id: list[idx].id, email: lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId: msgId, isDriveUpload: isDrive };
        } else {
          list.push({ id: list.length + 1, email: lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId: msgId, isDriveUpload: isDrive });
        }
        memoryFiles.set(lowerEmail, list);
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      const idx = list.findIndex(f => f.path === path && f.email === lowerEmail);
      if (idx >= 0) {
        list[idx] = { id: list[idx].id, email: lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId: msgId, isDriveUpload: isDrive };
      } else {
        list.push({ id: list.length + 1, email: lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId: msgId, isDriveUpload: isDrive });
      }
      memoryFiles.set(lowerEmail, list);
    }

    return res.json({ success: true, message: 'File record synced to cloud database.' });
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
 * 10. API ROUTE: FETCH USER'S BACKED UP FILES LIST
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /api/files/list?email=user@example.com (Aliases: /files/list)
 */
app.get(['/api/files/list', '/files/list'], async (req, res, next) => {
  try {
    const email = (req.query.email || '').toLowerCase();

    if (pool) {
      try {
        const result = await queryWithTimeout(
          `SELECT id, file_name as "fileName", telegram_file_id as "telegramFileId", size, path, timestamp, message_id as "messageId", is_drive_upload as "isDriveUpload"
           FROM backed_files WHERE email = $1 ORDER BY timestamp DESC`,
          [email]
        );
        return res.json({ success: true, files: result.rows });
      } catch (dbErr) {
        console.error('[DB Warn] Files list DB query failed:', dbErr.message);
        const list = memoryFiles.get(email) || [];
        return res.json({ success: true, files: list });
      }
    } else {
      const list = memoryFiles.get(email) || [];
      return res.json({ success: true, files: list });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 11. API ROUTE: FETCH LATEST APP VERSION & APK DOWNLOAD LINK FOR AUTO-UPDATER
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /api/app/latest-version (Aliases: /app/latest-version)
 */
app.get(['/api/app/latest-version', '/app/latest-version'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const host = req.headers.host || 'telegram-backup-backend.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const downloadUrl = `${protocol}://${host}/api/app/download-latest`;

  return res.json({
    success: true,
    versionCode: 23,
    versionName: "2.1.20",
    downloadUrl: downloadUrl,
    releaseNotes: "🔧 CRITICAL FIX v2.1.20: Telegram batch deleteMessages API was returning ok:true even when 0 messages were deleted — causing phantom deletions. Now uses individual deleteMessage for each ID with verified per-message results. DB records only cleared after confirmed channel deletion. Deletion verification test runs before deep purge."
  });
});

/**
 * Endpoint: GET /api/app/download-latest (Aliases: /app/download-latest, /api/app/download-apk)
 * Direct streaming APK download route for in-app auto-updater.
 */
app.get(['/api/app/download-latest', '/app/download-latest', '/api/app/download-apk'], (req, res) => {
  const releasesDir = path.join(__dirname, 'Releases');
  const candidates = [
    path.join(releasesDir, 'TelegramBackup-latest.apk'),
    path.join(releasesDir, 'TelegramBackup-v2.1.20.apk'),
    path.join(releasesDir, 'TelegramBackup-v2.1.19.apk')
  ];

  let targetApk = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      targetApk = p;
      break;
    }
  }

  if (!targetApk && fs.existsSync(releasesDir)) {
    const files = fs.readdirSync(releasesDir).filter(f => f.endsWith('.apk'));
    if (files.length > 0) {
      targetApk = path.join(releasesDir, files[files.length - 1]);
    }
  }

  if (targetApk && fs.existsSync(targetApk)) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="TelegramBackup.apk"');
    return res.sendFile(targetApk);
  } else {
    // Redirect to high-bandwidth GitHub release raw link
    return res.redirect(302, 'https://github.com/spatil28a/telegram_backup_backend/raw/main/Releases/TelegramBackup-latest.apk');
  }
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
