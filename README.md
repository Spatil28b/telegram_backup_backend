# Telegram Backup Vercel Backend Server

A Node.js / Express Serverless API designed for Vercel deployment with **Google SMTP Email OTP Verification** and **Telegram Credential Locking with 2FA Protection**.

---

## Features
- 📧 **Google SMTP Email OTP**: Sends 6-digit verification codes to user emails via Gmail SMTP (`nodemailer`).
- 🔐 **2FA Credential Security**: Verifies Telegram Bot credentials live and locks them under user accounts. Modifying credentials requires 2FA Email OTP.
- ☁️ **Vercel Serverless Ready**: Includes `vercel.json` for zero-config deployment.

---

## How to Get Google App Password for SMTP

1. Go to your [Google Account Security Settings](https://myaccount.google.com/security).
2. Ensure **2-Step Verification** is turned **ON**.
3. Search for **"App Passwords"** in the Google Account search bar.
4. Create a new App Password named `Telegram Backup Server`.
5. Copy the 16-character generated password (e.g. `abcd efgh ijkl mnop`).

---

## Deployment to Vercel via GitHub

### Step 1: Push Repository to GitHub
```bash
cd server
git init -b main
git add .
git commit -m "Initial Vercel Backend Server"
git remote add origin https://github.com/YOUR_USERNAME/telegram-backup-backend.git
git push -u origin main
```

### Step 2: Import into Vercel
1. Go to [Vercel Dashboard](https://vercel.com/dashboard) and click **"Add New" -> "Project"**.
2. Select your `telegram-backup-backend` GitHub repository.
3. In **Environment Variables**, add:
   - `SMTP_EMAIL`: Your Gmail Address (`yourname@gmail.com`)
   - `SMTP_APP_PASSWORD`: Your 16-character Google App Password
4. Click **Deploy**.

Vercel will build and provide your live server URL (e.g. `https://telegram-backup-backend.vercel.app`).
