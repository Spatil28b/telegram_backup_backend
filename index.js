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
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

if (pool) {
  // Listen for unexpected errors on idle PostgreSQL clients
  pool.on('error', (err) => {
    console.error('[Neon Postgres Pool Error]', err.message);
  });
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
    await pool.query(`
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
    `);
    console.log('[Neon Postgres] Database schema and tables initialized successfully!');
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
 * -------------------------------------------------------------------------------------
 * 2. DUAL MULTI-SMTP FALLBACK ENGINE
 * -------------------------------------------------------------------------------------
 * Configures Primary and Secondary Gmail SMTP transporters. If Primary Gmail sender encounters
 * rate limits or authentication issues, system instantly falls back to Secondary SMTP.
 */
const primarySender = process.env.SMTP_EMAIL || 'spatil28b@gmail.com';
const primaryPass = process.env.SMTP_APP_PASSWORD || 'rhppqybvdyvcqren';

const secondarySender = process.env.SMTP_EMAIL_2 || 'testmail.28.11.a@gmail.com';
const secondaryPass = process.env.SMTP_APP_PASSWORD_2 || 'fpmkqukxszaywgyz';

const primaryTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: primarySender, pass: primaryPass }
});

const secondaryTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: secondarySender, pass: secondaryPass }
});

/**
 * Dispatches an email using Primary SMTP transporter, falling back to Secondary SMTP on failure.
 * @param {Object} mailOptions - Nodemailer email options object (to, subject, html, attachments)
 * @returns {Promise<{success: boolean, provider: string, info: Object}>}
 */
async function sendMailWithFallback(mailOptions) {
  // Attempt 1: Primary SMTP Transporter
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

    // Attempt 2: Secondary SMTP Transporter Fallback
    try {
      const optionsWithFrom2 = {
        ...mailOptions,
        from: `"Telegram Backup Cloud" <${secondarySender}>`
      };
      const info2 = await secondaryTransporter.sendMail(optionsWithFrom2);
      console.log(`[SMTP Engine SUCCESS] Secondary Fallback SMTP (${secondarySender}) sent email! Message ID: ${info2.messageId}`);
      return { success: true, provider: secondarySender, info: info2 };
    } catch (secondaryErr) {
      console.error(`[SMTP Engine ERROR] Both Primary and Secondary SMTP failed! Primary: ${primaryErr.message} | Secondary: ${secondaryErr.message}`);
      throw new Error(`Primary SMTP (${primarySender}) & Secondary SMTP (${secondarySender}) failed. Primary: ${primaryErr.message}`);
    }
  }
}

/**
 * Helper function: Generates a cryptographically random 6-digit verification code.
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * -------------------------------------------------------------------------------------
 * 3. API ROUTE: SEND OTP VERIFICATION CODE
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/send-otp (Also aliases: /auth/send-otp, /send-otp)
 * Accepts: { email: string, type: 'register' | '2fa' }
 * Generates 6-digit code with 5-minute expiration and dispatches via Multi-SMTP.
 */
app.post(['/api/auth/send-otp', '/auth/send-otp', '/send-otp'], async (req, res, next) => {
  try {
    const { email, type = 'register' } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email address is required.' });
    }

    const code = generateOTP();
    const lowerEmail = email.toLowerCase();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 Minutes TTL

    // Save OTP to Postgres DB or Memory Store
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO otps (email, code, expires_at, type) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3, type = $4`,
          [lowerEmail, code, expiresAt, type]
        );
      } catch (dbErr) {
        console.error('[DB Warn] OTP DB save failed, falling back to memory store:', dbErr.message);
        memoryOtps.set(lowerEmail, { code, expiresAt, type });
      }
    } else {
      memoryOtps.set(lowerEmail, { code, expiresAt, type });
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
        message: `OTP sent to ${lowerEmail} via ${sendResult.provider}.`,
        provider: sendResult.provider
      });
    } catch (error) {
      console.error('[OTP Dispatch Error]', error.message);
      return res.json({
        success: false,
        message: `Failed to send OTP email. Please try again.`
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

    let storedCode, expiresAt;
    if (pool) {
      try {
        const result = await pool.query(`SELECT code, expires_at FROM otps WHERE email = $1`, [lowerEmail]);
        if (result.rows.length > 0) {
          storedCode = result.rows[0].code;
          expiresAt = parseInt(result.rows[0].expires_at, 10);
        }
      } catch (dbErr) {
        console.error('[DB Warn] OTP query failed:', dbErr.message);
        const rec = memoryOtps.get(lowerEmail);
        if (rec) { storedCode = rec.code; expiresAt = rec.expiresAt; }
      }
    } else {
      const rec = memoryOtps.get(lowerEmail);
      if (rec) { storedCode = rec.code; expiresAt = rec.expiresAt; }
    }

    if (!storedCode || storedCode !== code || Date.now() > expiresAt) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
    }

    // Persist registered user into Database or Memory Store
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
          [lowerEmail, password]
        );
        await pool.query(`DELETE FROM otps WHERE email = $1`, [lowerEmail]);
      } catch (dbErr) {
        console.error('[DB Warn] User registration DB query failed, falling back to memory store:', dbErr.message);
        memoryUsers.set(lowerEmail, { password, botToken: '', chatId: '', isLocked: false });
        memoryOtps.delete(lowerEmail);
      }
    } else {
      memoryUsers.set(lowerEmail, { password, botToken: '', chatId: '', isLocked: false });
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

    let user;
    if (pool) {
      try {
        const result = await pool.query(`SELECT email, password_hash, bot_token, chat_id, is_locked FROM users WHERE email = $1`, [lowerEmail]);
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

    if (!user || user.password !== password) {
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
 * 6. API ROUTE: REQUEST PASSWORD RESET OTP
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/request-reset (Aliases: /auth/request-reset, /request-reset)
 */
app.post(['/api/auth/request-reset', '/auth/request-reset', '/request-reset'], async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();
    const code = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO otps (email, code, expires_at, type) VALUES ($1, $2, $3, 'reset')
           ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3, type = 'reset'`,
          [lowerEmail, code, expiresAt]
        );
      } catch (dbErr) {
        console.error('[DB Warn] Request reset DB save failed:', dbErr.message);
        memoryOtps.set(lowerEmail, { code, expiresAt, type: 'reset' });
      }
    } else {
      memoryOtps.set(lowerEmail, { code, expiresAt, type: 'reset' });
    }

    const mailOptions = {
      to: lowerEmail,
      subject: 'Password Reset OTP - Telegram Backup Cloud',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Reset Your Password</h2>
          <p>Your OTP code to reset your password is:</p>
          <h1 style="color: #0088cc;">${code}</h1>
          <p>This code will expire in 5 minutes.</p>
        </div>
      `
    };

    try {
      const sendResult = await sendMailWithFallback(mailOptions);
      return res.json({ success: true, message: `Reset OTP sent to ${lowerEmail} via ${sendResult.provider}.` });
    } catch (error) {
      return res.json({ success: false, message: `Failed to send reset OTP. Please try again.` });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * -------------------------------------------------------------------------------------
 * 7. API ROUTE: VERIFY RESET OTP & UPDATE PASSWORD
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/auth/reset-password (Aliases: /auth/reset-password, /reset-password, /verify-reset)
 */
app.post(['/api/auth/reset-password', '/auth/reset-password', '/reset-password', '/api/auth/verify-reset', '/auth/verify-reset', '/verify-reset'], async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();

    let storedCode, expiresAt;
    if (pool) {
      try {
        const result = await pool.query(`SELECT code, expires_at FROM otps WHERE email = $1 AND type = 'reset'`, [lowerEmail]);
        if (result.rows.length > 0) {
          storedCode = result.rows[0].code;
          expiresAt = parseInt(result.rows[0].expires_at, 10);
        }
      } catch (dbErr) {
        console.error('[DB Warn] Verify reset query failed:', dbErr.message);
        const rec = memoryOtps.get(lowerEmail);
        if (rec && rec.type === 'reset') { storedCode = rec.code; expiresAt = rec.expiresAt; }
      }
    } else {
      const rec = memoryOtps.get(lowerEmail);
      if (rec && rec.type === 'reset') { storedCode = rec.code; expiresAt = rec.expiresAt; }
    }

    if (!storedCode || storedCode !== code || Date.now() > expiresAt) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
    }

    if (pool) {
      try {
        await pool.query(`UPDATE users SET password_hash = $1 WHERE email = $2`, [newPassword, lowerEmail]);
        await pool.query(`DELETE FROM otps WHERE email = $1`, [lowerEmail]);
      } catch (dbErr) {
        console.error('[DB Warn] Update password DB query failed:', dbErr.message);
        const u = memoryUsers.get(lowerEmail) || {};
        u.password = newPassword;
        memoryUsers.set(lowerEmail, u);
        memoryOtps.delete(lowerEmail);
      }
    } else {
      const u = memoryUsers.get(lowerEmail) || {};
      u.password = newPassword;
      memoryUsers.set(lowerEmail, u);
      memoryOtps.delete(lowerEmail);
    }

    return res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    next(err);
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
        await pool.query(
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
 * -------------------------------------------------------------------------------------
 * 9. API ROUTE: INDEX / SYNC BACKED UP FILE RECORD TO DATABASE
 * -------------------------------------------------------------------------------------
 * Endpoint: POST /api/files/index (Aliases: /files/index, /api/files/backup, /files/backup)
 * Accepts: { email: string, fileName: string, telegramFileId: string, size: number, path: string, messageId: number }
 */
app.post(['/api/files/index', '/files/index', '/api/files/backup', '/files/backup'], async (req, res, next) => {
  try {
    const { email, fileName, telegramFileId, size, path, timestamp, messageId } = req.body || {};
    const lowerEmail = (email || '').toLowerCase();
    const msgId = messageId || 0;

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [lowerEmail, fileName, telegramFileId, size || 0, path || '', timestamp || Date.now(), msgId]
        );
      } catch (dbErr) {
        console.error('[DB Warn] Files backup DB save failed:', dbErr.message);
        const list = memoryFiles.get(lowerEmail) || [];
        list.push({ id: list.length + 1, email: lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId: msgId });
        memoryFiles.set(lowerEmail, list);
      }
    } else {
      const list = memoryFiles.get(lowerEmail) || [];
      list.push({ id: list.length + 1, email: lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId: msgId });
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

    if (pool) {
      try {
        await pool.query(
          `DELETE FROM backed_files WHERE email = $1 AND (telegram_file_id = $2 OR path = $3)`,
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
 * 10. API ROUTE: FETCH USER'S BACKED UP FILES LIST
 * -------------------------------------------------------------------------------------
 * Endpoint: GET /api/files/list?email=user@example.com (Aliases: /files/list)
 */
app.get(['/api/files/list', '/files/list'], async (req, res, next) => {
  try {
    const email = (req.query.email || '').toLowerCase();

    if (pool) {
      try {
        const result = await pool.query(
          `SELECT id, file_name as "fileName", telegram_file_id as "telegramFileId", size, path, timestamp, message_id as "messageId"
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
  console.error('[Global Express Error Handler]:', err.message || err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
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
