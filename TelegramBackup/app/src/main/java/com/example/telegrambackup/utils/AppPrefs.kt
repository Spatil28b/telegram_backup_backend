package com.example.telegrambackup.utils

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

class AppPrefs(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("telegram_backup_prefs", Context.MODE_PRIVATE)
    private val authPrefs: SharedPreferences = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)

    fun clearAll() {
        prefs.edit().clear().apply()
    }

    var serverUrl: String
        get() {
            val defaultUrl = "https://telegram-backup-backend.vercel.app"
            val stored = prefs.getString("server_url", defaultUrl) ?: defaultUrl
            val cleaned = stored.trim().trim('"', '\'', ' ', '\t', '\n', '\r')
            if (cleaned.contains("server-alpha-black") || cleaned.contains("gotrends") || cleaned.contains("server-eight-khaki") || cleaned.isBlank()) {
                prefs.edit().putString("server_url", defaultUrl).apply()
                return defaultUrl
            }
            return cleaned
        }
        set(value) {
            val sanitized = value.trim().trim('"', '\'', ' ', '\t', '\n', '\r')
            prefs.edit().putString("server_url", sanitized).apply()
        }

    var encryptionEnabled: Boolean
        get() = prefs.getBoolean("encryption_enabled", true)
        set(value) = prefs.edit().putBoolean("encryption_enabled", value).apply()

    var encryptionKey: String
        get() {
            var key = prefs.getString("encryption_key", "") ?: ""
            if (key.isEmpty() || key == "default_aes_key") {
                // Generate a unique 32-byte (256-bit) master key per user instance
                key = "AES256-" + UUID.randomUUID().toString().replace("-", "").take(24)
                prefs.edit().putString("encryption_key", key).apply()
            }
            return key
        }
        set(value) {
            // Master Key is locked once created to prevent breaking existing encrypted files
            if (!prefs.contains("encryption_key")) {
                prefs.edit().putString("encryption_key", value).apply()
            }
        }

    var recoveryEmail: String
        get() = prefs.getString("recovery_email", "") ?: ""
        set(value) = prefs.edit().putString("recovery_email", value).apply()

    var userEmail: String
        get() {
            val email = authPrefs.getString("user_email", "") ?: ""
            return if (email.isNotEmpty()) email else recoveryEmail
        }
        set(value) {
            authPrefs.edit().putString("user_email", value).apply()
        }

    var profilePictureUri: String
        get() = prefs.getString("profile_picture_uri", "") ?: ""
        set(value) = prefs.edit().putString("profile_picture_uri", value).apply()

    var displayName: String
        get() = prefs.getString("display_name", "My Cloud Account") ?: "My Cloud Account"
        set(value) = prefs.edit().putString("display_name", value).apply()

    var backupExceptions: Set<String>
        get() = prefs.getStringSet("backup_exceptions", emptySet()) ?: emptySet()
        set(value) = prefs.edit().putStringSet("backup_exceptions", value).apply()

    var smartScanIntervalHours: Int
        get() = prefs.getInt("smart_scan_interval_hours", 1)
        set(value) = prefs.edit().putInt("smart_scan_interval_hours", value).apply()

    var minFileSizeMB: Double
        get() = prefs.getFloat("min_file_size_mb", 0.0f).toDouble()
        set(value) = prefs.edit().putFloat("min_file_size_mb", value.toFloat()).apply()

    var maxFileSizeMB: Double
        get() = prefs.getFloat("max_file_size_mb", 2000.0f).toDouble()
        set(value) = prefs.edit().putFloat("max_file_size_mb", value.toFloat()).apply()

    var botToken: String
        get() = prefs.getString("bot_token", "") ?: ""
        set(value) = prefs.edit().putString("bot_token", value).apply()

    var chatId: String
        get() = prefs.getString("chat_id", "") ?: ""
        set(value) = prefs.edit().putString("chat_id", value).apply()

    var autoBackupEnabled: Boolean
        get() = prefs.getBoolean("auto_backup_enabled", false)
        set(value) = prefs.edit().putBoolean("auto_backup_enabled", value).apply()

    var backupMode: Int
        get() = prefs.getInt("backup_mode", 1)
        set(value) = prefs.edit().putInt("backup_mode", value).apply()

    var backupPriority: Int
        get() = prefs.getInt("backup_priority", 0)
        set(value) = prefs.edit().putInt("backup_priority", value).apply()

    var backupCamera: Boolean
        get() = prefs.getBoolean("backup_camera", true)
        set(value) = prefs.edit().putBoolean("backup_camera", value).apply()

    var backupPictures: Boolean
        get() = prefs.getBoolean("backup_pictures", true)
        set(value) = prefs.edit().putBoolean("backup_pictures", value).apply()

    var backupDownloads: Boolean
        get() = prefs.getBoolean("backup_downloads", true)
        set(value) = prefs.edit().putBoolean("backup_downloads", value).apply()

    var backupDocuments: Boolean
        get() = prefs.getBoolean("backup_documents", true)
        set(value) = prefs.edit().putBoolean("backup_documents", value).apply()

    var backupApks: Boolean
        get() = prefs.getBoolean("backup_apks", true)
        set(value) = prefs.edit().putBoolean("backup_apks", value).apply()

    var backupAllOther: Boolean
        get() = prefs.getBoolean("backup_all_other", true)
        set(value) = prefs.edit().putBoolean("backup_all_other", value).apply()

    var backupVideos: Boolean
        get() = prefs.getBoolean("backup_videos", true)
        set(value) = prefs.edit().putBoolean("backup_videos", value).apply()

    var backupAudio: Boolean
        get() = prefs.getBoolean("backup_audio", true)
        set(value) = prefs.edit().putBoolean("backup_audio", value).apply()

    var backupArchives: Boolean
        get() = prefs.getBoolean("backup_archives", true)
        set(value) = prefs.edit().putBoolean("backup_archives", value).apply()

    var backupLargeFiles: Boolean
        get() = prefs.getBoolean("backup_large_files", true)
        set(value) = prefs.edit().putBoolean("backup_large_files", value).apply()

    var wifiOnly: Boolean
        get() = prefs.getBoolean("wifi_only", false)
        set(value) = prefs.edit().putBoolean("wifi_only", value).apply()

    var showHiddenFiles: Boolean
        get() = prefs.getBoolean("show_hidden_files", false)
        set(value) = prefs.edit().putBoolean("show_hidden_files", value).apply()

    var hapticFeedback: Boolean
        get() = prefs.getBoolean("haptic_feedback", true)
        set(value) = prefs.edit().putBoolean("haptic_feedback", value).apply()

    var enableDataCompression: Boolean
        get() = prefs.getBoolean("enable_data_compression", true)
        set(value) = prefs.edit().putBoolean("enable_data_compression", value).apply()

    var optimizeBattery: Boolean
        get() = prefs.getBoolean("optimize_battery", true)
        set(value) = prefs.edit().putBoolean("optimize_battery", value).apply()

    var enableDevMode: Boolean
        get() = prefs.getBoolean("enable_dev_mode", false)
        set(value) = prefs.edit().putBoolean("enable_dev_mode", value).apply()

    var appTheme: Int
        get() = prefs.getInt("app_theme", 0)
        set(value) = prefs.edit().putInt("app_theme", value).apply()

    var isZeroKnowledgeEnabled: Boolean
        get() = prefs.getBoolean("is_zero_knowledge_enabled", false)
        set(value) = prefs.edit().putBoolean("is_zero_knowledge_enabled", value).apply()

    var zeroKnowledgePassphrase: String
        get() = prefs.getString("zero_knowledge_passphrase", "") ?: ""
        set(value) = prefs.edit().putString("zero_knowledge_passphrase", value).apply()

    var isBiometricEnabled: Boolean
        get() = prefs.getBoolean("is_biometric_enabled", false)
        set(value) = prefs.edit().putBoolean("is_biometric_enabled", value).apply()

    var stopAllBackups: Boolean
        get() = prefs.getBoolean("stop_all_backups", false)
        set(value) {
            val editor = prefs.edit()
            editor.putBoolean("stop_all_backups", value)
            if (value) editor.putLong("stop_all_backups_time", System.currentTimeMillis())
            else editor.remove("stop_all_backups_time")
            editor.apply()
        }

    var stopAllBackupsTimestamp: Long
        get() = prefs.getLong("stop_all_backups_time", 0L)
        set(value) = prefs.edit().putLong("stop_all_backups_time", value).apply()

    var appLanguage: String
        get() = prefs.getString("app_language", "English (US)") ?: "English (US)"
        set(value) = prefs.edit().putString("app_language", value).apply()

    var customDownloadDir: String
        get() = prefs.getString("custom_download_dir", "Internal Storage/Downloads") ?: "Internal Storage/Downloads"
        set(value) = prefs.edit().putString("custom_download_dir", value).apply()

    var autoLockDuration: String
        get() = prefs.getString("auto_lock_duration", "5 Minutes") ?: "5 Minutes"
        set(value) = prefs.edit().putString("auto_lock_duration", value).apply()

    var backupScheduleTime: String
        get() = prefs.getString("backup_schedule_time", "Daily at 10:00 PM") ?: "Daily at 10:00 PM"
        set(value) = prefs.edit().putString("backup_schedule_time", value).apply()

    var appVersionStr: String
        get() = prefs.getString("app_version_str", "2.1.16") ?: "2.1.16"
        set(value) = prefs.edit().putString("app_version_str", value).apply()

    // Smart Backup Mode: 0 = Continuous, 1 = Custom Schedule, 2 = Night Express
    var smartBackupMode: Int
        get() = prefs.getInt("smart_backup_mode", 0)
        set(value) = prefs.edit().putInt("smart_backup_mode", value).apply()

    // Night Express backup hour (1-5 AM range, default 2 AM)
    var nightBackupHour: Int
        get() = prefs.getInt("night_backup_hour", 2)
        set(value) = prefs.edit().putInt("night_backup_hour", value).apply()

    // Once credentials are saved + verified, lock them behind OTP
    var credentialsVerified: Boolean
        get() = prefs.getBoolean("credentials_verified", false)
        set(value) = prefs.edit().putBoolean("credentials_verified", value).apply()

    // Trash auto-clean: 0 = Never, 7/14/30/60/90 days
    var trashAutoCleanDays: Int
        get() = prefs.getInt("trash_auto_clean_days", 30)
        set(value) = prefs.edit().putInt("trash_auto_clean_days", value).apply()

    // Dismissed update version (to prevent repeated popups in same version)
    var dismissedUpdateVersion: String
        get() = prefs.getString("dismissed_update_version", "") ?: ""
        set(value) = prefs.edit().putString("dismissed_update_version", value).apply()
}
