require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Pool } = require('@neondatabase/serverless');

const app = express();
app.use(cors());
app.use(express.json());

// Process Safety Handlers (Prevent Vercel serverless process crashes)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process Warning] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process Warning] Uncaught Exception thrown:', err);
});

// 1. Neon Serverless Postgres Database Client
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('[Neon Postgres Pool Error]', err.message);
  });
}

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
initDb().catch(err => console.error('[InitDb Catch]', err.message));

// In-Memory Fallback Stores
const memoryUsers = new Map();
const memoryOtps = new Map();
const memoryFiles = new Map();

// 2. Dual Multi-SMTP Fallback Engine (Primary + Secondary)
const primarySender = process.env.SMTP_EMAIL || 'spatil28b@gmail.com';
const primaryPass = process.env.SMTP_APP_PASSWORD || 'rhppqybvdyvcqren';

const secondarySender = process.env.SMTP_EMAIL_2 || 'testmail.28.11.a@gmail.com';
const secondaryPass = process.env.SMTP_APP_PASSWORD_2 || 'fpmkqukxszaywgyz';

const primaryTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: primarySender,
    pass: primaryPass
  }
});

const secondaryTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: secondarySender,
    pass: secondaryPass
  }
});

async function sendMailWithFallback(mailOptions) {
  // Attempt 1: Primary SMTP (spatil28b@gmail.com)
  try {
    const optionsWithFrom = {
      ...mailOptions,
      from: mailOptions.from || `"Telegram Backup Cloud" <${primarySender}>`
    };
    console.log(`[SMTP Dispatch] Attempting Primary SMTP (${primarySender})...`);
    const info = await primaryTransporter.sendMail(optionsWithFrom);
    console.log(`[SMTP Dispatch SUCCESS] Primary SMTP (${primarySender}) sent email! Message ID: ${info.messageId}`);
    return { success: true, provider: primarySender, info };
  } catch (primaryErr) {
    console.warn(`[SMTP Dispatch WARNING] Primary SMTP (${primarySender}) failed: ${primaryErr.message}. Retrying with Secondary SMTP (${secondarySender})...`);

    // Attempt 2: Secondary SMTP Fallback (testmail.28.11.a@gmail.com)
    try {
      const optionsWithFrom2 = {
        ...mailOptions,
        from: `"Telegram Backup Cloud" <${secondarySender}>`
      };
      const info2 = await secondaryTransporter.sendMail(optionsWithFrom2);
      console.log(`[SMTP Dispatch SUCCESS] Secondary Fallback SMTP (${secondarySender}) sent email! Message ID: ${info2.messageId}`);
      return { success: true, provider: secondarySender, info: info2 };
    } catch (secondaryErr) {
      console.error(`[SMTP Dispatch ERROR] Both Primary and Secondary SMTP failed! Primary: ${primaryErr.message} | Secondary: ${secondaryErr.message}`);
      throw new Error(`Primary SMTP (${primarySender}) & Secondary SMTP (${secondarySender}) failed. Primary: ${primaryErr.message}`);
    }
  }
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 3. Send OTP API with Multi-SMTP Auto-Fallback
app.post(['/api/auth/send-otp', '/auth/send-otp', '/send-otp'], async (req, res, next) => {
  try {
    const { email, type = 'register' } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }

    const code = generateOTP();
    const lowerEmail = email.toLowerCase();
    const expiresAt = Date.now() + 5 * 60 * 1000;

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

// 3b. Send AES-256 Zero-Knowledge Security Encryption Key to User's Email
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

app.use((req, res, next) => {
  const fullUrl = (req.originalUrl || req.url || '').toLowerCase();
  if (req.method === 'POST' && fullUrl.includes('send-key')) {
    return handleSendKey(req, res, next);
  }
  next();
});

app.post(['/api/auth/send-key', '/auth/send-key', '/send-key'], handleSendKey);

// 4. Verify OTP & Register Account
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
        if (rec) {
          storedCode = rec.code;
          expiresAt = rec.expiresAt;
        }
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

// 5. Normal Email/Password Login
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

// 6. Request Reset Password OTP
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
      subject: 'Password Reset OTP - Telegram Backup',
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

// 7. Verify Reset Password OTP & Update Password
app.post(['/api/auth/verify-reset', '/auth/verify-reset', '/verify-reset'], async (req, res, next) => {
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
        if (rec && rec.type === 'reset') {
          storedCode = rec.code;
          expiresAt = rec.expiresAt;
        }
      }
    } else {
      const rec = memoryOtps.get(lowerEmail);
      if (rec && rec.type === 'reset') {
        storedCode = rec.code;
        expiresAt = rec.expiresAt;
      }
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

// 8. Save User Telegram Credentials
app.post(['/api/user/credentials', '/user/credentials'], async (req, res, next) => {
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

    return res.json({ success: true, message: 'Telegram credentials saved.' });
  } catch (err) {
    next(err);
  }
});

// 9. Database Backup Sync Records (Save Uploaded File to Cloud DB)
app.post(['/api/files/backup', '/files/backup'], async (req, res, next) => {
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

    return res.json({ success: true, message: 'File record synced to database.' });
  } catch (err) {
    next(err);
  }
});

// 10. Fetch User's Cloud Backed Up Files
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

// Root Health Check
app.get('/', (req, res) => {
  res.send('🚀 Telegram Backup Cloud Node.js API Server is Live & Healthy with Multi-SMTP Fallback!');
});

// Express Global Error Handler (Prevents serverless function invocation crash)
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]:', err.message || err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

module.exports = app;
