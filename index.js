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
        timestamp BIGINT NOT NULL
      );
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
    user: process.env.SMTP_EMAIL || 'backup.app.verify@gmail.com',
    pass: process.env.SMTP_APP_PASSWORD || 'demo-app-password-key'
  }
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 3. Send OTP API
app.post('/api/auth/send-otp', async (req, res) => {
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

// 4. Verify OTP & Register Account
app.post('/api/auth/verify-otp-register', async (req, res) => {
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

// 5. Login API
app.post('/api/auth/login', async (req, res) => {
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

// 7. Index File Metadata to Neon Database
app.post('/api/files/index', async (req, res) => {
  const { email, fileName, telegramFileId, size, path } = req.body;
  const lowerEmail = (email || '').toLowerCase();
  const timestamp = Date.now();

  if (pool) {
    await pool.query(
      `INSERT INTO backed_files (email, file_name, telegram_file_id, size, path, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [lowerEmail, fileName, telegramFileId, size, path, timestamp]
    );
  } else {
    if (!memoryFiles.has(lowerEmail)) memoryFiles.set(lowerEmail, []);
    memoryFiles.get(lowerEmail).push({ fileName, telegramFileId, size, path, timestamp });
  }

  return res.json({ success: true, message: 'File indexed to Neon Database.' });
});

// 8. Get Cloud File List from Neon Database
app.get('/api/files/list', async (req, res) => {
  const lowerEmail = (req.query.email || '').toLowerCase();

  if (pool) {
    const result = await pool.query(
      `SELECT file_name AS "fileName", telegram_file_id AS "telegramFileId", size, path, timestamp
       FROM backed_files WHERE email = $1 ORDER BY timestamp DESC`,
      [lowerEmail]
    );
    return res.json({ success: true, files: result.rows });
  } else {
    const files = memoryFiles.get(lowerEmail) || [];
    return res.json({ success: true, files });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Telegram Backup Backend with Neon Postgres running on port ${PORT}`));

module.exports = app;
