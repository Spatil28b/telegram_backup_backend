/**
 * =====================================================================================
 * NEON POSTGRESQL DATABASE SCHEMA MIGRATION & MAINTENANCE SCRIPT
 * =====================================================================================
 * Executes database migrations outside of serverless request execution path.
 * Run during deployment or locally via: node migrate.js
 * =====================================================================================
 */

require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('[Migration] DATABASE_URL not set in environment. Skipping database migration.');
  process.exit(0);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000
});

async function runMigrations() {
  console.log('🚀 [Neon Postgres Migration] Starting database schema migration...');
  const client = await pool.connect();
  try {
    console.log('1️⃣  Creating core tables if not exist...');
    await client.query(`
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
        code VARCHAR(128) NOT NULL,
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
        email VARCHAR(255) DEFAULT '',
        file_path TEXT DEFAULT '',
        file_name TEXT NOT NULL,
        file_size BIGINT DEFAULT 0,
        mime_type VARCHAR(100) DEFAULT 'application/octet-stream',
        payload_enc TEXT NOT NULL,
        pin_hash VARCHAR(128) DEFAULT '',
        expires_at BIGINT DEFAULT 0,
        download_count INT DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_chunks (
        file_id BIGINT NOT NULL,
        chunk_index INT NOT NULL,
        telegram_file_id TEXT NOT NULL,
        message_id BIGINT DEFAULT 0,
        bot_id TEXT DEFAULT '',
        chunk_size BIGINT DEFAULT 0,
        sha256 TEXT DEFAULT '',
        PRIMARY KEY (file_id, chunk_index)
      );
    `);
    console.log('   ✓ Core tables verified.');

    console.log('2️⃣  Adding schema evolution columns safely...');
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json TEXT DEFAULT '{}';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS is_drive_upload BOOLEAN DEFAULT FALSE;
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS chunks_json TEXT DEFAULT '[]';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS channel_id TEXT DEFAULT '';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS bot_token_used TEXT DEFAULT '';
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS total_chunks INT DEFAULT 1;
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
      ALTER TABLE backed_files ADD COLUMN IF NOT EXISTS deleted_at BIGINT DEFAULT 0;

      ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';
      ALTER TABLE shared_files ADD COLUMN IF NOT EXISTS file_path TEXT DEFAULT '';

      ALTER TABLE file_chunks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'COMPLETED';
      ALTER TABLE file_chunks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);
    console.log('   ✓ Columns verified.');

    console.log('3️⃣  Configuring high-performance indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shared_files_exp ON shared_files(expires_at);
      DROP INDEX IF EXISTS idx_backed_files_email_path;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backed_files_email_path ON backed_files(email, path) WHERE path IS NOT NULL AND path <> '';
      CREATE INDEX IF NOT EXISTS idx_backed_files_email_ts ON backed_files(email, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_backed_files_email_drive ON backed_files(email, is_drive_upload);
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON file_chunks(file_id, chunk_index);
      DELETE FROM otps WHERE expires_at < (EXTRACT(EPOCH FROM NOW()) * 1000);
    `);
    console.log('   ✓ Indexes configured and expired OTPs cleaned.');

    console.log('4️⃣  Checking legacy password hashes...');
    const plainUsers = await client.query(`SELECT email, password_hash FROM users WHERE password_hash NOT LIKE '$2%'`);
    if (plainUsers.rows.length > 0) {
      console.log(`   Encrypting ${plainUsers.rows.length} legacy plain-text password(s) with bcrypt...`);
      for (const row of plainUsers.rows) {
        const hashed = await bcrypt.hash(row.password_hash, 10);
        await client.query(`UPDATE users SET password_hash = $1 WHERE email = $2`, [hashed, row.email]);
      }
      console.log(`   ✓ All legacy passwords encrypted with bcrypt.`);
    } else {
      console.log('   ✓ All passwords properly hashed.');
    }

    console.log('5️⃣  Checking legacy timestamp sanitization...');
    const tsRes = await client.query(`UPDATE backed_files SET timestamp = EXTRACT(EPOCH FROM NOW()) * 1000 WHERE timestamp = 1784030400000 OR timestamp < 946684800000`);
    if (tsRes.rowCount > 0) {
      console.log(`   ✓ Reconciled ${tsRes.rowCount} legacy timestamp(s) to current era.`);
    } else {
      console.log('   ✓ All timestamps valid.');
    }

    console.log('\n🎉 [Neon Postgres Migration] Database schema is 100% UP TO DATE!\n');
  } catch (err) {
    console.error('❌ [Migration Error]:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error('[Migration Fatal Error]:', err);
  process.exit(1);
});
