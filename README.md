# Telegram Backup Vercel Backend Server with Neon Postgres

A Node.js / Express Serverless API designed for Vercel deployment with **Neon Postgres Database**, **Google SMTP Email OTP Verification**, and **Telegram Credential Locking with 2FA Protection**.

---

## Features
- 🐘 **Neon Serverless Postgres Integration**: Automatically creates `users`, `otps`, and `backed_files` tables.
- 📧 **Google SMTP Email OTP**: Sends 6-digit verification codes to user emails via Gmail SMTP (`nodemailer`).
- 🔐 **2FA Credential Security**: Verifies Telegram Bot credentials live and locks them under user accounts. Modifying credentials requires 2FA Email OTP.
- ☁️ **Vercel Serverless Ready**: Includes `vercel.json` for zero-config deployment.

---

## Step 1: Get Your Free Neon Postgres Connection String

1. Go to [neon.tech](https://neon.tech) and create a free account.
2. Create a project named `telegram-backup-db`.
3. Copy the Postgres connection string from your dashboard:
   `postgresql://username:password@ep-xxxxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`

---

## Step 2: Get Google App Password for SMTP

1. Go to [Google Account Security](https://myaccount.google.com/security).
2. Ensure **2-Step Verification** is turned **ON**.
3. Search for **"App Passwords"** in the Google search bar.
4. Create an App Password named `Telegram Backup Server`.
5. Copy the 16-character generated password (e.g. `abcd efgh ijkl mnop`).

---

## Step 3: Vercel Environment Variables

In Vercel Dashboard -> **Settings -> Environment Variables**, add:
- `DATABASE_URL`: Your Neon Postgres Connection String
- `SMTP_EMAIL`: Your Gmail Address (`yourname@gmail.com`)
- `SMTP_APP_PASSWORD`: Your 16-character Google App Password
