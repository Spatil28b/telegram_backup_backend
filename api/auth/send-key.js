const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL || 'testmail.28.11.a@gmail.com',
    pass: process.env.SMTP_APP_PASSWORD || 'fpmkqukxszaywgyz'
  }
});

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  const { email, encryptionKey } = req.body || {};
  if (!email || !encryptionKey) {
    return res.status(400).json({ success: false, message: 'Email and encryption key are required.' });
  }

  const lowerEmail = email.trim().toLowerCase();
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
    return res.status(200).json({ success: true, message: `Security Key file sent to ${lowerEmail}!` });
  } catch (err) {
    console.error('Failed to send encryption key email via SMTP:', err.message);
    return res.status(500).json({ success: false, message: `Email sending failed: ${err.message}` });
  }
};
