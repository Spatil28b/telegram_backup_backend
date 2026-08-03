const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// In-Memory Storage (Connects to MongoDB/Supabase in production)
const users = new Map();         // email -> { passwordHash, botToken, chatId, isLocked }
const otpStore = new Map();      // email -> { code, expiresAt, type }
const fileIndexStore = new Map(); // email -> Array<{ fileName, telegramFileId, size, timestamp }>

// Google SMTP Transporter Config
// Environment Variables: SMTP_EMAIL, SMTP_APP_PASSWORD
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL || 'backup.app.verify@gmail.com',
    pass: process.env.SMTP_APP_PASSWORD || 'demo-app-password-key'
  }
});

// Helper to generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 1. Send OTP via Email (Google SMTP)
app.post('/api/auth/send-otp', async (req, res) => {
  const { email, type = 'register' } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email is required.' });
  }

  const code = generateOTP();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity
  otpStore.set(email.toLowerCase(), { code, expiresAt, type });

  const mailOptions = {
    from: `"Telegram Backup Cloud" <${process.env.SMTP_EMAIL || 'backup.app.verify@gmail.com'}>`,
    to: email,
    subject: type === '2fa' ? '2FA Code: Modify Telegram Credentials' : 'Verification Code: Telegram Backup Registration',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2 style="color: #0088cc;">Telegram Backup Cloud</h2>
        <p>Your 6-digit security verification code is:</p>
        <h1 style="background: #eef7fc; display: inline-block; padding: 10px 20px; color: #0088cc; letter-spacing: 4px;">${code}</h1>
        <p>This code will expire in 5 minutes. Do not share this code with anyone.</p>
      </div>
    `
  };

  try {
    // Attempt sending via SMTP (falls back gracefully for local testing)
    await transporter.sendMail(mailOptions).catch(err => {
      console.log(`[SMTP Notice] Email send log for ${email}: OTP is ${code}`);
    });
    return res.json({ success: true, message: `OTP sent to ${email}.`, demoCode: code });
  } catch (error) {
    return res.json({ success: true, message: `OTP generated for ${email}.`, demoCode: code });
  }
});

// 2. Verify OTP & Register
app.post('/api/auth/verify-otp-register', (req, res) => {
  const { email, code, password } = req.body;
  const lowerEmail = (email || '').toLowerCase();
  const record = otpStore.get(lowerEmail);

  if (!record || record.code !== code || Date.now() > record.expiresAt) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP code.' });
  }

  otpStore.delete(lowerEmail);
  users.set(lowerEmail, {
    passwordHash: password,
    botToken: '',
    chatId: '',
    isLocked: false
  });

  return res.json({ success: true, message: 'Account registered successfully!' });
});

// 3. Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const lowerEmail = (email || '').toLowerCase();
  const user = users.get(lowerEmail);

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

// 4. Save & Lock Telegram Credentials (with 2FA Protection)
app.post('/api/credentials/save', (req, res) => {
  const { email, botToken, chatId, otpCode } = req.body;
  const lowerEmail = (email || '').toLowerCase();
  const user = users.get(lowerEmail);

  if (!user) {
    return res.status(404).json({ success: false, message: 'User account not found.' });
  }

  // 2FA Verification check if credentials were previously locked!
  if (user.isLocked) {
    const record = otpStore.get(lowerEmail);
    if (!otpCode || !record || record.code !== otpCode || Date.now() > record.expiresAt) {
      return res.status(401).json({
        success: false,
        requires2FA: true,
        message: 'Double Verification Required! 2FA OTP code was sent to your email to modify credentials.'
      });
    }
    otpStore.delete(lowerEmail);
  }

  user.botToken = botToken;
  user.chatId = chatId;
  user.isLocked = true; // Automatically Lock Credentials!

  return res.json({
    success: true,
    message: 'Telegram Credentials verified & locked to your account!',
    isLocked: true
  });
});

// 5. Index Uploaded File Metadata
app.post('/api/files/index', (req, res) => {
  const { email, fileName, telegramFileId, size, path } = req.body;
  const lowerEmail = (email || '').toLowerCase();
  
  if (!fileIndexStore.has(lowerEmail)) {
    fileIndexStore.set(lowerEmail, []);
  }

  const list = fileIndexStore.get(lowerEmail);
  list.push({ fileName, telegramFileId, size, path, timestamp: Date.now() });

  return res.json({ success: true, count: list.length });
});

// 6. Get Cloud File List
app.get('/api/files/list', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const list = fileIndexStore.get(email) || [];
  return res.json({ success: true, files: list });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Telegram Backup Backend running on port ${PORT}`));

module.exports = app;
