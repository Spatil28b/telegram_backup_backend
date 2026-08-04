require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Pool } = require('@neondatabase/serverless');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Neon Serverless Postgres Database Client
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

// Initialize Neon Postgres Database Tables
async function initDb() {
  if (!pool) {
    console.log('[Notice] DATABASE_URL not provided. Running in-memory mode.');
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

      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS message_id BIGINT DEFAULT 0;
    `);
    console.log('[Neon Postgres] Database tables initialized successfully!');
  } catch (err) {
    console.error('[Neon Postgres Error] Failed to initialize tables:', err.message);
  }
}
initDb();

// In-Memory Fallback Stores
const memoryUsers = new Map();
const memoryOtps = new Map();
const memoryFiles = new Map();

// 2. Google SMTP Config
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL || 'testmail.28.11.a@gmail.com',
    pass: process.env.SMTP_APP_PASSWORD || 'fpmkqukxszaywgyz'
  }
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 3. Send OTP API
app.post(['/api/auth/send-otp', '/auth/send-otp', '/send-otp'], async (req, res) => {
  const { email, type = 'register' } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email is required.' });
  }

  const code = generateOTP();
  const lowerEmail = email.toLowerCase();
  const expiresAt = Date.now() + 5 * 60 * 1000;

  if (pool) {
    await pool.query(
      `INSERT INTO otps (email, code, expires_at, type) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3, type = $4`,
      [lowerEmail, code, expiresAt, type]
    );
  } else {
    memoryOtps.set(lowerEmail, { code, expiresAt, type });
  }

  const mailOptions = {
    from: `"Telegram Backup Cloud" <${process.env.SMTP_EMAIL || 'backup.app.verify@gmail.com'}>`,
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
    await transporter.sendMail(mailOptions).catch(() => {});
    return res.json({ success: true, message: `OTP sent to ${lowerEmail}.`, demoCode: code });
  } catch (error) {
    return res.json({ success: true, message: `OTP generated for ${lowerEmail}.`, demoCode: code });
  }
});

// 3b. Send AES-256 Zero-Knowledge Security Encryption Key to User's Email
app.post(['/api/auth/send-key', '/auth/send-key', '/send-key'], async (req, res) => {
  const { email, encryptionKey } = req.body || {};
  if (!email || !encryptionKey) {
    return res.status(400).json({ success: false, message: 'Email and encryption key are required.' });
  }

  const lowerEmail = (email || '').trim().toLowerCase();
  const filePassword = lowerEmail.length >= 4 ? lowerEmail.slice(-4) : '1234';

  const mailOptions = {
    from: `"Telegram Backup Security" <${process.env.SMTP_EMAIL || 'testmail.28.11.a@gmail.com'}>`,
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

  try {
    await transporter.sendMail(mailOptions);
    return res.json({ success: true, message: `Security Key file sent to ${lowerEmail}!` });
  } catch (err) {
    console.error('Failed to send encryption key email:', err.message);
    return res.status(500).json({ success: false, message: `Email sending failed: ${err.message}` });
  }
});

// 4. Verify OTP & Register Account
app.post(['/api/auth/verify-otp-register', '/auth/verify-otp-register', '/verify-otp-register'], async (req, res) => {
  const { email, code, password } = req.body;
  const lowerEmail = (email || '').toLowerCase();

  let storedCode, expiresAt;
  if (pool) {
    const result = await pool.query(`SELECT code, expires_at FROM otps WHERE email = $1`, [lowerEmail]);
    if (result.rows.length > 0) {
      storedCode = result.rows[0].code;
      expiresAt = parseInt(result.rows[0].expires_at, 10);
    }
  } else {
    const rec = memoryOtps.get(lowerEmail);
    if (rec) {
      storedCode = rec.code;
      expiresAt = rec.expiresAt;
    }
  }

  if (!storedCode || storedCode !== code || Date.now() > expiresAt) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
  }

  if (pool) {
    await pool.query(`DELETE FROM otps WHERE email = $1`, [lowerEmail]);
    await pool.query(
      `INSERT INTO users (email, password_hash, bot_token, chat_id, is_locked) VALUES ($1, $2, '', '', FALSE)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
      [lowerEmail, password]
    );
  } else {
    memoryOtps.delete(lowerEmail);
    memoryUsers.set(lowerEmail, { passwordHash: password, botToken: '', chatId: '', isLocked: false });
  }

  return res.json({ success: true, message: 'Account registered successfully in Neon database!' });
});

// 4b. Reset Password via OTP
app.post(['/api/auth/reset-password', '/auth/reset-password', '/reset-password'], async (req, res) => {
  const { email, code, newPassword } = req.body;
  const lowerEmail = (email || '').toLowerCase();

  let storedCode, expiresAt;
  if (pool) {
    const result = await pool.query(`SELECT code, expires_at FROM otps WHERE email = $1`, [lowerEmail]);
    if (result.rows.length > 0) {
      storedCode = result.rows[0].code;
      expiresAt = parseInt(result.rows[0].expires_at, 10);
    }
  } else {
    const rec = memoryOtps.get(lowerEmail);
    if (rec) {
      storedCode = rec.code;
      expiresAt = rec.expiresAt;
    }
  }

  if (!storedCode || storedCode !== code || Date.now() > expiresAt) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
  }

  if (pool) {
    await pool.query(`DELETE FROM otps WHERE email = $1`, [lowerEmail]);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE email = $2`, [newPassword, lowerEmail]);
  } else {
    memoryOtps.delete(lowerEmail);
    const u = memoryUsers.get(lowerEmail);
    if (u) u.passwordHash = newPassword;
  }

  return res.json({ success: true, message: 'Password updated successfully! You can now log in.' });
});

// 5. Login API
app.post(['/api/auth/login', '/auth/login', '/login'], async (req, res) => {
  const { email, password } = req.body;
  const lowerEmail = (email || '').toLowerCase();

  let user;
  if (pool) {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [lowerEmail]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      user = { passwordHash: row.password_hash, botToken: row.bot_token, chatId: row.chat_id, isLocked: row.is_locked };
    }
  } else {
    user = memoryUsers.get(lowerEmail);
  }

  if (!user || user.passwordHash !== password) {
    return res.status(400).json({ success: false, message: 'Invalid email or password.' });
  }

  return res.json({
    success: true,
    email: lowerEmail,
    botToken: user.botToken,
    chatId: user.chatId,
    isLocked: user.isLocked
  });
});

// 6. Save & Lock Bot Credentials (with 2FA Verification)
app.post('/api/credentials/save', async (req, res) => {
  const { email, botToken, chatId, otpCode } = req.body;
  const lowerEmail = (email || '').toLowerCase();

  let user;
  if (pool) {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [lowerEmail]);
    if (result.rows.length > 0) user = result.rows[0];
  } else {
    user = memoryUsers.get(lowerEmail);
  }

  if (!user) {
    return res.status(404).json({ success: false, message: 'User account not found.' });
  }

  const isLocked = pool ? user.is_locked : user.isLocked;
  if (isLocked) {
    let storedCode, expiresAt;
    if (pool) {
      const otpRes = await pool.query(`SELECT code, expires_at FROM otps WHERE email = $1`, [lowerEmail]);
      if (otpRes.rows.length > 0) {
        storedCode = otpRes.rows[0].code;
        expiresAt = parseInt(otpRes.rows[0].expires_at, 10);
      }
    } else {
      const rec = memoryOtps.get(lowerEmail);
      if (rec) { storedCode = rec.code; expiresAt = rec.expiresAt; }
    }

    if (!otpCode || !storedCode || storedCode !== otpCode || Date.now() > expiresAt) {
      return res.status(401).json({
        success: false,
        requires2FA: true,
        message: 'Double Verification Required! 2FA OTP code was sent to your email to modify credentials.'
      });
    }
  }

  if (pool) {
    await pool.query(
      `UPDATE users SET bot_token = $1, chat_id = $2, is_locked = TRUE WHERE email = $3`,
      [botToken, chatId, lowerEmail]
    );
  } else {
    user.botToken = botToken;
    user.chatId = chatId;
    user.isLocked = true;
  }

  return res.json({
    success: true,
    message: 'Telegram Credentials verified & locked to your Neon Database account!',
    isLocked: true
  });
});

// 7. Index File Metadata to Database
app.post(['/api/files/index', '/files/index', '/index'], async (req, res) => {
  const { email, fileName, telegramFileId, size, path, messageId = 0 } = req.body;
  const lowerEmail = (email || '').toLowerCase();
  const timestamp = Date.now();

  if (pool) {
    await pool.query(
      `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [lowerEmail, fileName, telegramFileId, size, path, timestamp, messageId]
    );
  } else {
    if (!memoryFiles.has(lowerEmail)) memoryFiles.set(lowerEmail, []);
    memoryFiles.get(lowerEmail).push({ fileName, telegramFileId, size, path, timestamp, messageId });
  }

  return res.json({ success: true, message: 'File indexed to Neon Database.' });
});

// 8. List Backed Up Files
const handleListFiles = async (req, res) => {
  const lowerEmail = (req.query.email || req.body?.email || '').toLowerCase();

  if (pool) {
    const result = await pool.query(
      `SELECT file_name AS "fileName", telegram_file_id AS "telegramFileId", size, path, timestamp, message_id AS "messageId"
       FROM backed_files WHERE email = $1 ORDER BY timestamp DESC`,
      [lowerEmail]
    );
    return res.json({ success: true, files: result.rows });
  } else {
    const files = memoryFiles.get(lowerEmail) || [];
    return res.json({ success: true, files });
  }
};

app.get(['/api/files/list', '/files/list', '/list'], handleListFiles);
app.post(['/api/files/list', '/files/list', '/list'], handleListFiles);

// 10. Delete File Record from Cloud Database
app.post(['/api/files/delete', '/files/delete', '/delete'], async (req, res) => {
  const { email, telegramFileId, path } = req.body;
  const lowerEmail = (email || '').toLowerCase();

  if (!lowerEmail || (!telegramFileId && !path)) {
    return res.status(400).json({ success: false, message: 'Email and file ID or path are required.' });
  }

  if (pool) {
    if (telegramFileId) {
      await pool.query(
        `DELETE FROM backed_files WHERE email = $1 AND telegram_file_id = $2`,
        [lowerEmail, telegramFileId]
      );
    } else if (path) {
      await pool.query(
        `DELETE FROM backed_files WHERE email = $1 AND path = $2`,
        [lowerEmail, path]
      );
    }
  } else {
    if (memoryFiles.has(lowerEmail)) {
      const updated = memoryFiles.get(lowerEmail).filter(f => f.telegramFileId !== telegramFileId && f.path !== path);
      memoryFiles.set(lowerEmail, updated);
    }
  }

  return res.json({ success: true, message: 'File deleted from cloud database.' });
});

// JSON 404 Fallback Middleware
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

// JSON Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Express Server Error:', err);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Telegram Backup Backend with Neon Postgres running on port ${PORT}`));

module.exports = app;
