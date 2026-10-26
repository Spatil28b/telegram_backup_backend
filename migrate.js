/**
 * =====================================================================================
 * NEON POSTGRESQL DATABASE SCHEMA MIGRATION & MAINTENANCE SCRIPT
 * =====================================================================================
 * Executes versioned database migrations outside of serverless request execution path.
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
  const ADVISORY_LOCK_ID = 88471295;

  try {
    // Acquire PostgreSQL advisory lock to ensure single-execution during concurrent deploys
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    // 0. Ensure schema_migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const appliedRes = await client.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(appliedRes.rows.map(r => r.version));

    // Helper to execute migration if not already applied
    async function applyMigration(version, description, migrationFn) {
      if (appliedVersions.has(version)) {
        console.log(`   ⏭️  [${version}] ${description} (already applied)`);
        return;
      }
      console.log(`   ⏳ [${version}] Applying: ${description}...`);
      await client.query('BEGIN');
      try {
        await migrationFn(client);
        await client.query(
          'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())',
          [version]
        );
        await client.query('COMMIT');
        appliedVersions.add(version);
        console.log(`   ✓ [${version}] ${description} completed.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`   ❌ [${version}] Migration failed:`, err.message);
        throw err;
      }
    }

    // 1. Initial Core Tables
    await applyMigration('v1_core_tables', 'Create core tables (users, otps, backed_files, user_settings, shared_files, file_chunks)', async (db) => {
      await db.query(`
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
    });

    // 2. Schema Evolution Columns
    await applyMigration('v2_schema_evolution', 'Add optional and evolution columns to tables', async (db) => {
      await db.query(`
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
    });

    // 3. Foreign Key on file_chunks with ON DELETE CASCADE
    await applyMigration('v3_file_chunks_foreign_key', 'Clean orphan chunks and establish foreign key constraint', async (db) => {
      // Clean up any orphan chunks before applying foreign key constraint
      const orphanCleanup = await db.query(`
        DELETE FROM file_chunks
        WHERE file_id NOT IN (SELECT id FROM backed_files)
      `);
      if (orphanCleanup.rowCount > 0) {
        console.log(`     Removed ${orphanCleanup.rowCount} orphan file_chunks records.`);
      }

      await db.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'file_chunks_file_fk'
          ) THEN
            ALTER TABLE file_chunks
            ADD CONSTRAINT file_chunks_file_fk
            FOREIGN KEY (file_id)
            REFERENCES backed_files(id)
            ON DELETE CASCADE;
          END IF;
        END $$;
      `);
    });

    // 4. Indexes Configuration (non-destructive)
    await applyMigration('v4_indexes_setup', 'Create high-performance indexes without repeated drops', async (db) => {
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_shared_files_exp ON shared_files(expires_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_backed_files_email_path ON backed_files(email, path) WHERE path IS NOT NULL AND path <> '';
        CREATE INDEX IF NOT EXISTS idx_backed_files_email_ts ON backed_files(email, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_backed_files_email_drive ON backed_files(email, is_drive_upload);
        CREATE INDEX IF NOT EXISTS idx_chunks_file ON file_chunks(file_id, chunk_index);
        DELETE FROM otps WHERE expires_at < (EXTRACT(EPOCH FROM NOW()) * 1000);
      `);
    });

    // 5. Password Migration (one-time idempotent)
    await applyMigration('v5_password_bcrypt', 'Ensure all passwords are hashed with bcrypt', async (db) => {
      const plainUsers = await db.query(`SELECT email, password_hash FROM users WHERE password_hash NOT LIKE '$2%'`);
      if (plainUsers.rows.length > 0) {
        console.log(`     Encrypting ${plainUsers.rows.length} legacy plain-text password(s) with bcrypt...`);
        for (const row of plainUsers.rows) {
          const hashed = await bcrypt.hash(row.password_hash, 10);
          await db.query(`UPDATE users SET password_hash = $1 WHERE email = $2`, [hashed, row.email]);
        }
      }
    });

    // 6. Scrub any legacy encryption keys from user_settings and users tables (Finding #6)
    await applyMigration('v6_scrub_encryption_keys', 'Scrub encryption keys and raw bot tokens from stored settings', async (db) => {
      const rows = await db.query(`SELECT email, settings_json FROM user_settings WHERE settings_json IS NOT NULL AND settings_json != ''`);
      for (const row of rows.rows) {
        try {
          const parsed = JSON.parse(row.settings_json);
          let modified = false;
          if (parsed && typeof parsed === 'object') {
            if (parsed.security && parsed.security.encryption_key) {
              delete parsed.security.encryption_key;
              modified = true;
            }
            if (parsed.encryption_key) {
              delete parsed.encryption_key;
              modified = true;
            }
            if (parsed.master_key) {
              delete parsed.master_key;
              modified = true;
            }
            if (Array.isArray(parsed.bots)) {
              parsed.bots = parsed.bots.map(b => {
                const copy = { ...b };
                delete copy.bot_token;
                return copy;
              });
              modified = true;
            }
            if (modified) {
              await db.query(`UPDATE user_settings SET settings_json = $1 WHERE email = $2`, [JSON.stringify(parsed), row.email]);
            }
          }
        } catch (_) {}
      }
    });

    // 7. Security Phase 4: Rate limits table, session revocation, and legacy PIN purge
    await applyMigration('v7_security_phase4', 'Create rate_limits table, add session_revoked_at to users, and purge legacy SHA-256 PINs', async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          key VARCHAR(255) PRIMARY KEY,
          attempts INT NOT NULL DEFAULT 1,
          first_attempt_at BIGINT NOT NULL,
          lock_until BIGINT NOT NULL DEFAULT 0
        );
      `);

      await db.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS session_revoked_at BIGINT DEFAULT 0;
      `);

      // Purge legacy SHA-256 PINs that have not been migrated to bcrypt
      await db.query(`
        UPDATE shared_files
        SET pin_hash = ''
        WHERE length(pin_hash) = 64 AND NOT (pin_hash LIKE '$2a$%' OR pin_hash LIKE '$2b$%');
      `);
    });

    console.log('\n🎉 [Neon Postgres Migration] All versioned migrations applied successfully!\n');
  } catch (err) {
    console.error('❌ [Migration Error]:', err.message);
    throw err;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    } catch (_) {}
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error('[Migration Fatal Error]:', err);
  process.exit(1);
});
