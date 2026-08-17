package com.example.telegrambackup.utils

import android.content.Context
import android.widget.Toast
import com.example.telegrambackup.data.AppDatabase
import com.example.telegrambackup.data.AppSettingEntity
import com.example.telegrambackup.network.ServerApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object SettingsDbManager {

    /**
     * Called on App Launch (in MainActivity).
     * Fetches all saved settings from Room Database table `app_settings`.
     * Hydrates AppPrefs with database values. If Database is empty on fresh install,
     * seeds initial default settings into Database.
     */
    suspend fun fetchAndSyncSettingsOnAppOpen(context: Context) {
        withContext(Dispatchers.IO) {
            try {
                val db = AppDatabase.getDatabase(context)
                val dao = db.appSettingDao()
                val prefs = AppPrefs(context)

                val savedSettings = dao.getAllSettings()

                if (savedSettings.isEmpty()) {
                    // Seed initial defaults into Room Database
                    val initialDefaults = listOf(
                        AppSettingEntity("server_url", prefs.serverUrl),
                        AppSettingEntity("recovery_email", prefs.recoveryEmail),
                        AppSettingEntity("profile_picture_uri", prefs.profilePictureUri),
                        AppSettingEntity("display_name", prefs.displayName),
                        AppSettingEntity("bot_token", prefs.botToken),
                        AppSettingEntity("chat_id", prefs.chatId),
                        AppSettingEntity("auto_backup_enabled", prefs.autoBackupEnabled.toString()),
                        AppSettingEntity("smart_backup_mode", prefs.smartBackupMode.toString()),
                        AppSettingEntity("night_backup_hour", prefs.nightBackupHour.toString()),
                        AppSettingEntity("smart_scan_interval_hours", prefs.smartScanIntervalHours.toString()),
                        AppSettingEntity("min_file_size_mb", prefs.minFileSizeMB.toString()),
                        AppSettingEntity("max_file_size_mb", prefs.maxFileSizeMB.toString()),
                        AppSettingEntity("backup_camera", prefs.backupCamera.toString()),
                        AppSettingEntity("backup_downloads", prefs.backupDownloads.toString()),
                        AppSettingEntity("backup_documents", prefs.backupDocuments.toString()),
                        AppSettingEntity("backup_videos", prefs.backupVideos.toString()),
                        AppSettingEntity("backup_apks", prefs.backupApks.toString()),
                        AppSettingEntity("wifi_only", prefs.wifiOnly.toString()),
                        AppSettingEntity("enable_data_compression", prefs.enableDataCompression.toString()),
                        AppSettingEntity("is_biometric_enabled", prefs.isBiometricEnabled.toString()),
                        AppSettingEntity("encryption_key", prefs.encryptionKey),
                        AppSettingEntity("app_theme", prefs.appTheme.toString()),
                        AppSettingEntity("trash_auto_clean_days", prefs.trashAutoCleanDays.toString()),
                        AppSettingEntity("stop_all_backups", prefs.stopAllBackups.toString()),
                        AppSettingEntity("credentials_verified", prefs.credentialsVerified.toString())
                    )
                    dao.saveSettings(initialDefaults)
                } else {
                    // Hydrate AppPrefs from Room Database records
                    val settingsMap = savedSettings.associate { it.key to it.value }

                    settingsMap["recovery_email"]?.let { prefs.recoveryEmail = it }
                    settingsMap["profile_picture_uri"]?.let { prefs.profilePictureUri = it }
                    settingsMap["display_name"]?.let { prefs.displayName = it }
                    settingsMap["bot_token"]?.let { prefs.botToken = it }
                    settingsMap["chat_id"]?.let { prefs.chatId = it }
                    settingsMap["auto_backup_enabled"]?.let { prefs.autoBackupEnabled = it.toBoolean() }
                    settingsMap["smart_backup_mode"]?.let { prefs.smartBackupMode = it.toIntOrNull() ?: 0 }
                    settingsMap["night_backup_hour"]?.let { prefs.nightBackupHour = it.toIntOrNull() ?: 2 }
                    settingsMap["smart_scan_interval_hours"]?.let { prefs.smartScanIntervalHours = it.toIntOrNull() ?: 1 }
                    settingsMap["min_file_size_mb"]?.let { prefs.minFileSizeMB = it.toDoubleOrNull() ?: 0.0 }
                    settingsMap["max_file_size_mb"]?.let { prefs.maxFileSizeMB = it.toDoubleOrNull() ?: 2000.0 }
                    settingsMap["backup_camera"]?.let { prefs.backupCamera = it.toBoolean() }
                    settingsMap["backup_downloads"]?.let { prefs.backupDownloads = it.toBoolean() }
                    settingsMap["backup_documents"]?.let { prefs.backupDocuments = it.toBoolean() }
                    settingsMap["backup_videos"]?.let { prefs.backupVideos = it.toBoolean() }
                    settingsMap["backup_apks"]?.let { prefs.backupApks = it.toBoolean() }
                    settingsMap["wifi_only"]?.let { prefs.wifiOnly = it.toBoolean() }
                    settingsMap["enable_data_compression"]?.let { prefs.enableDataCompression = it.toBoolean() }
                    settingsMap["is_biometric_enabled"]?.let { prefs.isBiometricEnabled = it.toBoolean() }
                    settingsMap["app_theme"]?.let { prefs.appTheme = it.toIntOrNull() ?: 0 }
                    settingsMap["trash_auto_clean_days"]?.let { prefs.trashAutoCleanDays = it.toIntOrNull() ?: 30 }
                    settingsMap["stop_all_backups"]?.let { prefs.stopAllBackups = it.toBoolean() }
                    settingsMap["credentials_verified"]?.let { prefs.credentialsVerified = it.toBoolean() }
                }

                // Cloud Telegram Bot Credentials & User Settings Restoration
                val authPrefs = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
                val userEmail = authPrefs.getString("user_email", "") ?: prefs.recoveryEmail
                if (userEmail.isNotEmpty()) {
                    val serverApi = ServerApi()
                    // 1. Restore Bot Credentials from PostgreSQL DB if local is empty or outdated
                    try {
                        val creds = serverApi.getCredentials(prefs.serverUrl, userEmail)
                        if (creds != null && creds.first.isNotEmpty()) {
                            prefs.botToken = creds.first
                            prefs.chatId = creds.second
                            prefs.credentialsVerified = true
                            dao.saveSettings(
                                listOf(
                                    AppSettingEntity("bot_token", creds.first),
                                    AppSettingEntity("chat_id", creds.second),
                                    AppSettingEntity("credentials_verified", "true")
                                )
                            )
                        } else if (prefs.botToken.isNotEmpty()) {
                            serverApi.saveCredentials(prefs.serverUrl, userEmail, prefs.botToken, prefs.chatId)
                        }
                    } catch (_: Exception) { }

                    // 2. Restore All User Settings from PostgreSQL DB
                    try {
                        val serverSettingsStr = serverApi.getUserSettings(prefs.serverUrl, userEmail)
                        if (!serverSettingsStr.isNullOrEmpty()) {
                            val serverSettingsJson = org.json.JSONObject(serverSettingsStr)
                            if (serverSettingsJson.has("display_name")) prefs.displayName = serverSettingsJson.optString("display_name")
                            if (serverSettingsJson.has("bot_token")) prefs.botToken = serverSettingsJson.optString("bot_token")
                            if (serverSettingsJson.has("chat_id")) prefs.chatId = serverSettingsJson.optString("chat_id")
                            if (serverSettingsJson.has("encryption_key")) prefs.encryptionKey = serverSettingsJson.optString("encryption_key")
                            if (serverSettingsJson.has("auto_backup_enabled")) prefs.autoBackupEnabled = serverSettingsJson.optBoolean("auto_backup_enabled", true)
                            if (serverSettingsJson.has("smart_backup_mode")) prefs.smartBackupMode = serverSettingsJson.optInt("smart_backup_mode", 0)
                            if (serverSettingsJson.has("wifi_only")) prefs.wifiOnly = serverSettingsJson.optBoolean("wifi_only", false)
                            if (serverSettingsJson.has("app_theme")) prefs.appTheme = serverSettingsJson.optInt("app_theme", 0)
                        }
                    } catch (_: Exception) { }
                }

                // Automatically restore cloud file index into local Room DB
                restoreCloudFileIndexToRoom(context)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    /**
     * Queries PostgreSQL Cloud Database for all files indexed under the user's email account.
     * Inserts any missing cloud files into local Room Database table `uploaded_files`.
     * Guarantees that app updates or database migrations NEVER lose previous backup history!
     */
    suspend fun restoreCloudFileIndexToRoom(context: Context): Int = withContext(Dispatchers.IO) {
        try {
            val authPrefs = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
            val prefs = AppPrefs(context)
            var userEmail = authPrefs.getString("user_email", "") ?: ""
            if (userEmail.isEmpty()) {
                userEmail = prefs.recoveryEmail.trim().lowercase()
            }
            if (userEmail.isEmpty()) return@withContext 0

            val serverApi = ServerApi()
            val cloudFiles = serverApi.listFiles(prefs.serverUrl, userEmail)

            val db = AppDatabase.getDatabase(context)
            val dao = db.uploadedFileDao()

            if (cloudFiles.isNotEmpty()) {
                dao.insertAll(cloudFiles)
            }

            // Two-Way Synchronization: Push any unsynced local Room DB records to PostgreSQL Cloud DB
            val localFiles = dao.getAllFiles()
            val cloudPathMap = cloudFiles.map { it.path }.toSet()
            val unsyncedLocal = localFiles.filter { !cloudPathMap.contains(it.path) }
            for (unsynced in unsyncedLocal) {
                try {
                    serverApi.indexFile(
                        prefs.serverUrl,
                        userEmail,
                        unsynced.fileName,
                        unsynced.telegramFileId,
                        unsynced.size,
                        unsynced.path,
                        unsynced.timestamp,
                        unsynced.messageId,
                        unsynced.isDriveUpload
                    )
                } catch (_: Exception) {}
            }

            return@withContext (cloudFiles.size + unsyncedLocal.size)
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return@withContext 0
    }

    /**
     * Saves a section/category of settings to Room Database and updates AppPrefs.
     * Displays a Toast feedback on main thread.
     */
    suspend fun saveCategorySettings(
        context: Context,
        categoryName: String,
        settingsMap: Map<String, String>,
        showToast: Boolean = true
    ) {
        withContext(Dispatchers.IO) {
            try {
                val db = AppDatabase.getDatabase(context)
                val dao = db.appSettingDao()
                val prefs = AppPrefs(context)
                val now = System.currentTimeMillis()

                val entities = settingsMap.map { (key, value) ->
                    AppSettingEntity(key = key, value = value, updatedAt = now)
                }

                dao.saveSettings(entities)

                // Sync keys to AppPrefs immediately
                settingsMap["profile_picture_uri"]?.let { prefs.profilePictureUri = it }
                settingsMap["display_name"]?.let { prefs.displayName = it }
                settingsMap["recovery_email"]?.let { prefs.recoveryEmail = it }
                settingsMap["bot_token"]?.let { prefs.botToken = it }
                settingsMap["chat_id"]?.let { prefs.chatId = it }
                settingsMap["auto_backup_enabled"]?.let { prefs.autoBackupEnabled = it.toBoolean() }
                settingsMap["smart_backup_mode"]?.let { prefs.smartBackupMode = it.toIntOrNull() ?: 0 }
                settingsMap["night_backup_hour"]?.let { prefs.nightBackupHour = it.toIntOrNull() ?: 2 }
                settingsMap["smart_scan_interval_hours"]?.let { prefs.smartScanIntervalHours = it.toIntOrNull() ?: 1 }
                settingsMap["min_file_size_mb"]?.let { prefs.minFileSizeMB = it.toDoubleOrNull() ?: 0.0 }
                settingsMap["max_file_size_mb"]?.let { prefs.maxFileSizeMB = it.toDoubleOrNull() ?: 2000.0 }

                // Sync Bot Token & Chat ID and complete User Settings to PostgreSQL server database
                val authPrefs = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
                val userEmail = authPrefs.getString("user_email", "") ?: prefs.recoveryEmail
                if (userEmail.isNotEmpty()) {
                    try {
                        val serverApi = ServerApi()
                        if (prefs.botToken.isNotEmpty()) {
                            serverApi.saveCredentials(prefs.serverUrl, userEmail, prefs.botToken, prefs.chatId)
                        }
                        val jsonSettings = org.json.JSONObject(settingsMap).toString()
                        serverApi.saveUserSettings(prefs.serverUrl, userEmail, jsonSettings)
                    } catch (_: Exception) { }
                }

                withContext(Dispatchers.Main) {
                    if (showToast) {
                        Toast.makeText(context, "💾 $categoryName Settings Saved to Database!", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    if (showToast) {
                        Toast.makeText(context, "Failed to save settings: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }
}
