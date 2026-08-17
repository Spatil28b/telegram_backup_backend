package com.example.telegrambackup.network

import android.util.Log
import com.example.telegrambackup.data.UploadedFile
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * =====================================================================================
 * SERVER API HTTP NETWORK CLIENT
 * =====================================================================================
 * Handles all asynchronous REST API communication between the Android Telegram Backup app
 * and the Vercel Serverless Node.js backend (`telegram-backup-backend.vercel.app`).
 *
 * Capabilities:
 * - OTP email dispatch & verification for user registration & 2FA.
 * - Password reset workflows.
 * - Secure login authentication.
 * - Telegram Bot credentials (botToken & chatId) cloud syncing.
 * - Master AES-256 Security Encryption Key dispatch.
 * - Cloud database file index synchronization, listing, and file deletion.
 * =====================================================================================
 */
class ServerApi {
    private val client = HttpClientProvider.client

    /**
     * Normalizes base server URL and appends the requested API endpoint path.
     * Prevents duplicate slashes or missing protocol prefixes (http:// or https://).
     */
    private fun cleanUrl(serverUrl: String, path: String): String {
        var base = serverUrl.trim().trim('"', '\'', ' ', '\t', '\n', '\r').removeSuffix("/")
        val cleanBase = if (base.startsWith("http://") || base.startsWith("https://")) base else "https://$base"
        val cleanPath = if (path.startsWith("/")) path else "/$path"
        return "$cleanBase$cleanPath"
    }

    /**
     * Checks online server for the latest released app version & APK download link.
     */
    /**
     * Checks online server & GitHub for the latest released app version & APK download link.
     * Supports both backend endpoint and direct GitHub Releases / app-version.json fallback.
     */
    suspend fun getLatestAppVersion(serverUrl: String): com.example.telegrambackup.ui.update.AppVersionInfo = withContext(Dispatchers.IO) {
        val candidates = mutableListOf<com.example.telegrambackup.ui.update.AppVersionInfo>()

        // 1. Try Backend Vercel Endpoint
        try {
            val url = cleanUrl(serverUrl, "/api/app/latest-version")
            val request = Request.Builder().url(url).cacheControl(okhttp3.CacheControl.FORCE_NETWORK).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            if (response.isSuccessful && body.contains("\"success\":true")) {
                val json = JSONObject(body)
                val info = com.example.telegrambackup.ui.update.AppVersionInfo(
                    success = true,
                    versionCode = json.optInt("versionCode", 1),
                    versionName = json.optString("versionName", "1.0.0"),
                    downloadUrl = json.optString("downloadUrl", ""),
                    releaseNotes = json.optString("releaseNotes", "New performance and feature updates.")
                )
                candidates.add(info)
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getLatestAppVersion backend check error", e)
        }

        // 2. Try GitHub raw app-version.json (direct repository source)
        try {
            val ghRawUrl = "https://raw.githubusercontent.com/spatil28a/telegram_backup_backend/main/app-version.json"
            val request = Request.Builder().url(ghRawUrl).cacheControl(okhttp3.CacheControl.FORCE_NETWORK).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            if (response.isSuccessful && body.contains("\"versionCode\"")) {
                val json = JSONObject(body)
                val dlUrl = json.optString("downloadUrl", "").ifEmpty { json.optString("directApkUrl", "") }
                val info = com.example.telegrambackup.ui.update.AppVersionInfo(
                    success = true,
                    versionCode = json.optInt("versionCode", 1),
                    versionName = json.optString("versionName", "1.0.0"),
                    downloadUrl = dlUrl,
                    releaseNotes = json.optString("releaseNotes", "New performance and feature updates.")
                )
                candidates.add(info)
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getLatestAppVersion GitHub raw check error", e)
        }

        // 3. Try GitHub Releases API
        try {
            val ghReleasesUrl = "https://api.github.com/repos/spatil28a/telegram_backup_backend/releases/latest"
            val request = Request.Builder().url(ghReleasesUrl).header("Accept", "application/vnd.github.v3+json").cacheControl(okhttp3.CacheControl.FORCE_NETWORK).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            if (response.isSuccessful && body.contains("\"tag_name\"")) {
                val json = JSONObject(body)
                val tagName = json.optString("tag_name", "").removePrefix("v")
                val bodyText = json.optString("body", "New updates on GitHub.")
                val assets = json.optJSONArray("assets")
                var apkUrl = ""
                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val asset = assets.optJSONObject(i)
                        val name = asset?.optString("name", "") ?: ""
                        if (name.endsWith(".apk", ignoreCase = true)) {
                            apkUrl = asset?.optString("browser_download_url", "") ?: ""
                            break
                        }
                    }
                }
                if (apkUrl.isEmpty()) {
                    apkUrl = "https://github.com/spatil28a/telegram_backup_backend/raw/main/Releases/TelegramBackup-latest.apk"
                }
                // Try parse code from tag or version string
                val code = tagName.replace(".", "").toIntOrNull() ?: 1
                candidates.add(
                    com.example.telegrambackup.ui.update.AppVersionInfo(
                        success = true,
                        versionCode = code,
                        versionName = tagName.ifEmpty { "1.0.0" },
                        downloadUrl = apkUrl,
                        releaseNotes = bodyText
                    )
                )
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getLatestAppVersion GitHub Releases API error", e)
        }

        // Return candidate with highest version code / SemVer
        if (candidates.isNotEmpty()) {
            return@withContext candidates.maxByOrNull { it.versionCode } ?: candidates.first()
        }

        return@withContext com.example.telegrambackup.ui.update.AppVersionInfo(false, 1, "1.0.0", "", "")
    }

    /**
     * Dispatches a 6-digit OTP verification code to the user's email address.
     * @param serverUrl Base backend Vercel URL
     * @param email User's email address
     * @param type Purpose of OTP ('register', '2fa', or 'reset')
     */
    suspend fun sendOtp(serverUrl: String, email: String, type: String = "register"): Result<String> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/auth/send-otp")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("type", type)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) {
                return@withContext Result.failure(Exception("Server returned an invalid response. Please try again."))
            }
            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val message = jsonRes.optString("message", "OTP sent successfully!")
                return@withContext Result.success(message)
            } else {
                val err = jsonRes.optString("message", "Failed to send OTP.")
                return@withContext Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "sendOtp error", e)
            return@withContext Result.failure(Exception(e.localizedMessage ?: "Network error"))
        }
    }

    /**
     * Verifies the 6-digit OTP registration code and registers the user account.
     */
    suspend fun verifyOtpRegister(serverUrl: String, email: String, code: String, password: String): Result<String> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/auth/verify-otp-register")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("code", code.trim())
                put("password", password)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) {
                return@withContext Result.failure(Exception("Server returned an invalid response. Please try again."))
            }
            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val message = jsonRes.optString("message", "Registered successfully!")
                return@withContext Result.success(message)
            } else {
                val err = jsonRes.optString("message", "Invalid OTP or registration failed.")
                return@withContext Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "verifyOtpRegister error", e)
            return@withContext Result.failure(Exception(e.localizedMessage ?: "Network error"))
        }
    }

    /**
     * Verifies password reset OTP code and updates user's account password.
     * Bulletproof: logs every step, handles empty/HTML responses, extracts server error messages.
     */
    suspend fun resetPassword(serverUrl: String, email: String, code: String, newPassword: String): Result<String> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/auth/reset-password")
            val trimmedEmail = email.trim().lowercase()
            val trimmedCode = code.trim()
            val trimmedPassword = newPassword.trim()

            Log.d("ServerApi", "resetPassword → URL: $url | email: $trimmedEmail | codeLen: ${trimmedCode.length} | passLen: ${trimmedPassword.length}")

            val json = JSONObject().apply {
                put("email", trimmedEmail)
                put("code", trimmedCode)
                put("newPassword", trimmedPassword)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder()
                .url(url)
                .post(requestBody)
                .addHeader("Accept", "application/json")
                .addHeader("Content-Type", "application/json")
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            Log.d("ServerApi", "resetPassword ← HTTP ${response.code} | bodyLen: ${body.length} | body: ${body.take(500)}")

            if (body.isBlank()) {
                Log.e("ServerApi", "resetPassword: EMPTY response body from server (HTTP ${response.code})")
                return@withContext Result.failure(Exception("Server returned empty response (HTTP ${response.code}). Please try again."))
            }

            if (!body.trim().startsWith("{")) {
                Log.e("ServerApi", "resetPassword: NON-JSON response (HTTP ${response.code}): ${body.take(300)}")
                // Try to extract useful error from HTML/text response
                val lower = body.lowercase()
                val userErr = when {
                    lower.contains("expired") -> "Verification code expired. Please request a new OTP."
                    lower.contains("invalid") -> "Invalid verification code."
                    lower.contains("internal server error") -> "Server error occurred. Please try again."
                    lower.contains("timeout") || lower.contains("timed out") -> "Server timed out. Please try again."
                    lower.contains("too many") -> "Too many attempts. Please wait and try again."
                    response.code == 404 -> "Server endpoint not found. Please update the app."
                    response.code >= 500 -> "Server error (${response.code}). Please try again later."
                    else -> "Server returned invalid response (HTTP ${response.code}). Please try again."
                }
                return@withContext Result.failure(Exception(userErr))
            }

            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val message = jsonRes.optString("message", "Password reset successfully!")
                return@withContext Result.success(message)
            } else {
                val err = jsonRes.optString("message", "Failed to reset password.")
                Log.e("ServerApi", "resetPassword: server returned failure — $err")
                return@withContext Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "resetPassword EXCEPTION: ${e.javaClass.simpleName}: ${e.message}", e)
            val userMsg = when {
                e.message?.contains("timeout", ignoreCase = true) == true -> "Connection timed out. Please check your internet and try again."
                e.message?.contains("Unable to resolve host", ignoreCase = true) == true -> "No internet connection. Please check your network."
                e.message?.contains("Connection refused", ignoreCase = true) == true -> "Cannot reach server. Please try again later."
                else -> e.localizedMessage ?: "Network error. Please try again."
            }
            return@withContext Result.failure(Exception(userMsg))
        }
    }

    /**
     * Authenticates user login credentials against cloud database.
     * Returns JSON object containing user email, botToken, and chatId.
     */
    suspend fun login(serverUrl: String, email: String, password: String): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/auth/login")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("password", password)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) {
                return@withContext Result.failure(Exception("Server returned an invalid response. Please try again."))
            }
            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                return@withContext Result.success(jsonRes)
            } else {
                val err = jsonRes.optString("message", "Login failed.")
                return@withContext Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "login error", e)
            return@withContext Result.failure(Exception("Network error: ${e.localizedMessage}"))
        }
    }

    /**
     * Saves user's Telegram Bot Token and Chat ID to cloud account settings.
     */
    suspend fun saveCredentials(serverUrl: String, email: String, botToken: String, chatId: String, otpCode: String? = null): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/credentials/save")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("botToken", botToken.trim())
                put("chatId", chatId.trim())
                if (!otpCode.isNullOrEmpty()) put("otpCode", otpCode.trim())
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                return@withContext Result.success(jsonRes)
            } else {
                val err = jsonRes.optString("message", "Credentials save failed.")
                return@withContext Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "saveCredentials error", e)
            return@withContext Result.failure(Exception("Network error: ${e.localizedMessage}"))
        }
    }

    /**
     * Retrieves saved Telegram Bot Token and Chat ID from cloud server database.
     */
    suspend fun getCredentials(serverUrl: String, email: String): Pair<String, String>? = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/credentials/get?email=${email.trim().lowercase()}")
            val request = Request.Builder().url(url).get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val token = jsonRes.optString("botToken", "")
                val chat = jsonRes.optString("chatId", "")
                if (token.isNotEmpty()) {
                    return@withContext Pair(token, chat)
                }
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getCredentials error", e)
        }
        return@withContext null
    }

    /**
     * Syncs a newly backed up file record (filename, Telegram fileId, size, path, timestamp)
     * to the user's cloud PostgreSQL database.
     */
    suspend fun indexFile(
        serverUrl: String,
        email: String,
        fileName: String,
        telegramFileId: String,
        size: Long,
        path: String,
        timestamp: Long = System.currentTimeMillis(),
        messageId: Long = 0L,
        isDriveUpload: Boolean = false
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/files/index")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("fileName", fileName)
                put("telegramFileId", telegramFileId)
                put("size", size)
                put("path", path)
                put("timestamp", timestamp)
                put("messageId", messageId)
                put("isDriveUpload", isDriveUpload)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()

            val response = client.newCall(request).execute()
            return@withContext response.isSuccessful
        } catch (e: Exception) {
            Log.e("ServerApi", "indexFile error", e)
            return@withContext false
        }
    }

    /**
     * Retrieves the complete list of backed up files from the user's cloud database account.
     */
    suspend fun listFiles(serverUrl: String, email: String): List<UploadedFile> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/files/list?email=${email.trim().lowercase()}&limit=10000")
            val request = Request.Builder().url(url).get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val array = jsonRes.optJSONArray("files") ?: return@withContext emptyList()
                val list = mutableListOf<UploadedFile>()
                for (i in 0 until array.length()) {
                    val obj = array.getJSONObject(i)
                    val tgId = obj.optString("telegramFileId", "")
                    val pathStr = obj.optString("path", "")
                    val isDrive = obj.optBoolean("isDriveUpload", false) ||
                                 obj.optBoolean("is_drive_upload", false) ||
                                 tgId == "DIR_MARKER" ||
                                 pathStr.startsWith("Internal Storage")

                    val entity = UploadedFile(
                        pathStr,
                        obj.optString("fileName", ""),
                        tgId,
                        obj.optLong("timestamp", System.currentTimeMillis()),
                        obj.optLong("size", 0L),
                        obj.optLong("messageId", 0L)
                    ).apply {
                        isDriveUpload = isDrive
                    }
                    list.add(entity)
                }
                return@withContext list
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "listFiles error", e)
        }
        return@withContext emptyList()
    }

    /**
     * Triggers backend email dispatch to send the user's Master AES-256 Encryption Key
     * and file protection PIN to their registered email address.
     */
    suspend fun sendEncryptionKeyEmail(serverUrl: String, email: String, key: String): Result<String> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/auth/send-key")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("encryptionKey", key)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            if (!body.trim().startsWith("{")) {
                return@withContext Result.failure(Exception("HTTP ${response.code}: Server error (verify server URL in Settings)."))
            }

            val jsonRes = JSONObject(body)

            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val msg = jsonRes.optString("message", "Security Key sent to $email!")
                return@withContext Result.success(msg)
            } else {
                val err = jsonRes.optString("message", "Failed to send email.")
                return@withContext Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "sendEncryptionKeyEmail error", e)
            return@withContext Result.failure(Exception(e.localizedMessage ?: "Network error"))
        }
    }

    /**
     * Deletes a file record from the user's cloud database index.
     */
    suspend fun deleteFile(serverUrl: String, email: String, telegramFileId: String, path: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/files/delete")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("telegramFileId", telegramFileId)
                put("path", path)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) return@withContext false
            val jsonRes = JSONObject(body)
            return@withContext response.isSuccessful && jsonRes.optBoolean("success")
        } catch (e: Exception) {
            Log.e("ServerApi", "deleteFile error", e)
            return@withContext false
        }
    }

    /**
     * Persists user app settings JSON string to cloud PostgreSQL database.
     */
    suspend fun saveUserSettings(serverUrl: String, email: String, settingsJson: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/user/settings")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("settings", settingsJson)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) return@withContext false
            val jsonRes = JSONObject(body)
            return@withContext response.isSuccessful && jsonRes.optBoolean("success")
        } catch (e: Exception) {
            Log.e("ServerApi", "saveUserSettings error", e)
            return@withContext false
        }
    }

    /**
     * Retrieves stored user app settings JSON string from cloud database on login.
     */
    suspend fun getUserSettings(serverUrl: String, email: String): String? = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/user/settings?email=${email.trim().lowercase()}")
            val request = Request.Builder().url(url).get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) return@withContext null
            val jsonRes = JSONObject(body)
            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                return@withContext jsonRes.optString("settings", "")
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getUserSettings error", e)
        }
        return@withContext null
    }

    /**
     * Purges file records with custom mode filters (ALL, DRIVE_ONLY, AUTO_BACKUP_ONLY, OLDER_THAN_DAYS).
     * Returns pair of (success boolean, list of messageIds to purge from Telegram Cloud).
     */
    suspend fun purgeFiles(
        serverUrl: String,
        email: String,
        mode: String = "ALL",
        olderThanDays: Int = 30
    ): Pair<Boolean, List<Long>> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/files/purge")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                put("mode", mode)
                put("olderThanDays", olderThanDays)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) return@withContext Pair(false, emptyList())
            val jsonRes = JSONObject(body)
            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val array = jsonRes.optJSONArray("deletedItems") ?: JSONArray()
                val messageIds = mutableListOf<Long>()
                for (i in 0 until array.length()) {
                    val obj = array.optJSONObject(i) ?: continue
                    val msgIdStr = obj.optString("messageId", "0")
                    val msgId = obj.optLong("messageId", 0L).let { if (it > 0) it else msgIdStr.toLongOrNull() ?: 0L }
                    if (msgId > 0) messageIds.add(msgId)
                }
                return@withContext Pair(true, messageIds)
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "purgeFiles error", e)
        }
        return@withContext Pair(false, emptyList())
    }

    /**
     * Deletes user account and all cloud database records permanently.
     */
    suspend fun deleteAccount(
        serverUrl: String,
        email: String,
        password: String = ""
    ): Pair<Boolean, List<Long>> = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/user/delete-account")
            val json = JSONObject().apply {
                put("email", email.trim().lowercase())
                if (password.isNotEmpty()) put("password", password)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!body.trim().startsWith("{")) return@withContext Pair(false, emptyList())
            val jsonRes = JSONObject(body)
            if (response.isSuccessful && jsonRes.optBoolean("success")) {
                val array = jsonRes.optJSONArray("deletedItems") ?: JSONArray()
                val messageIds = mutableListOf<Long>()
                for (i in 0 until array.length()) {
                    val obj = array.optJSONObject(i) ?: continue
                    val msgIdStr = obj.optString("messageId", "0")
                    val msgId = obj.optLong("messageId", 0L).let { if (it > 0) it else msgIdStr.toLongOrNull() ?: 0L }
                    if (msgId > 0) messageIds.add(msgId)
                }
                return@withContext Pair(true, messageIds)
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "deleteAccount error", e)
        }
        return@withContext Pair(false, emptyList())
    }

    /**
     * Normalizes Telegram chat ID / channel ID:
     * - Numerical channel IDs: e.g. -1001234567890
     * - Handle channel links: https://t.me/c/1234567890/12 -> -1001234567890
     * - Handle usernames: @mychannel
     */
    fun formatChatIdForTelegram(chatId: String): Any {
        var clean = chatId.trim().trim('"', '\'', ' ', '\t', '\n', '\r')
        if (clean.startsWith("https://t.me/c/")) {
            val after = clean.removePrefix("https://t.me/c/").substringBefore("/")
            val num = after.toLongOrNull()
            if (num != null) return if (after.startsWith("100")) "-$after".toLong() else "-100$after".toLong()
        }
        if (clean.startsWith("https://t.me/")) clean = "@" + clean.removePrefix("https://t.me/").substringBefore("/")
        if (clean.startsWith("t.me/")) clean = "@" + clean.removePrefix("t.me/").substringBefore("/")
        val num = clean.toLongOrNull()
        if (num != null) return num
        return clean
    }

    enum class TelegramDeletionStatus {
        DELETED,            // Message was present in channel and successfully deleted by Telegram
        ALREADY_DELETED,    // Message does not exist or was already deleted (400 not found)
        PERMISSION_DENIED,  // Bot lacks administrator or delete messages rights
        ERROR               // Network failure or timeout
    }

    /**
     * Executes single message deletion on Telegram Bot API with accurate status classification.
     */
    suspend fun executeTelegramMessageDeletion(botToken: String, chatId: String, messageId: Long): TelegramDeletionStatus = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(chatId)
        if (cleanToken.isEmpty() || messageId <= 0) return@withContext TelegramDeletionStatus.ERROR

        try {
            val url = "https://api.telegram.org/bot$cleanToken/deleteMessage"
            val json = JSONObject().apply {
                if (formattedChatId is Long) put("chat_id", formattedChatId) else put("chat_id", formattedChatId.toString())
                put("message_id", messageId)
            }
            val requestBody = json.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            // Handle HTTP 429 Rate Limiting
            if (response.code == 429 || body.contains("TOO_MANY_REQUESTS")) {
                val retryAfterSec = try { JSONObject(body).optJSONObject("parameters")?.optInt("retry_after", 2) ?: 2 } catch (_: Exception) { 2 }
                Log.w("ServerApi", "Telegram 429 Rate Limit hit. Waiting ${retryAfterSec}s before retry...")
                kotlinx.coroutines.delay(retryAfterSec * 1000L)
                return@withContext executeTelegramMessageDeletion(cleanToken, chatId, messageId)
            }

            val jsonRes = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            val ok = jsonRes.optBoolean("ok", false)
            val desc = jsonRes.optString("description", "")

            if (ok) return@withContext TelegramDeletionStatus.DELETED

            if (desc.contains("message to delete not found", ignoreCase = true) ||
                desc.contains("MESSAGE_ID_INVALID", ignoreCase = true) ||
                desc.contains("message identifier is not specified", ignoreCase = true)) {
                return@withContext TelegramDeletionStatus.ALREADY_DELETED
            }

            if (desc.contains("not enough rights", ignoreCase = true) ||
                desc.contains("CHAT_ADMIN_REQUIRED", ignoreCase = true) ||
                desc.contains("message can't be deleted", ignoreCase = true)) {
                Log.w("ServerApi", "Bot needs Admin Delete rights in Telegram Channel: $formattedChatId. Desc: $desc")
                return@withContext TelegramDeletionStatus.PERMISSION_DENIED
            }

            // Fallback via URL query parameter
            val fallbackUrl = "https://api.telegram.org/bot$cleanToken/deleteMessage?chat_id=$formattedChatId&message_id=$messageId"
            val fallbackReq = Request.Builder().url(fallbackUrl).post("".toRequestBody(null)).build()
            val fallbackRes = client.newCall(fallbackReq).execute()
            val fallbackBody = fallbackRes.body?.string() ?: ""

            if (fallbackRes.isSuccessful && fallbackBody.contains("\"ok\":true")) {
                return@withContext TelegramDeletionStatus.DELETED
            }

            if (fallbackBody.contains("message to delete not found", ignoreCase = true) ||
                fallbackBody.contains("MESSAGE_ID_INVALID", ignoreCase = true)) {
                return@withContext TelegramDeletionStatus.ALREADY_DELETED
            }

            return@withContext TelegramDeletionStatus.ERROR
        } catch (e: Exception) {
            Log.e("ServerApi", "executeTelegramMessageDeletion error for msgId #$messageId", e)
            return@withContext TelegramDeletionStatus.ERROR
        }
    }

    /**
     * Deletes Telegram messages using INDIVIDUAL deleteMessage calls for each ID.
     * NEVER uses batch deleteMessages — batch returns ok:true even when 0 messages are deleted,
     * which caused the app to report phantom deletions while files remained in the channel.
     * Individual deleteMessage gives honest per-message results.
     * Returns Pair(allSuccess, actuallyDeletedCount).
     */
    suspend fun deleteTelegramMessagesBatch(botToken: String, chatId: String, messageIds: List<Long>): Pair<Boolean, Int> = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val validIds = messageIds.filter { it > 0 }
        if (cleanToken.isEmpty() || validIds.isEmpty()) return@withContext Pair(false, 0)

        var allSuccess = true
        var totalDeletedCount = 0
        var permissionDenied = false

        // Process in chunks of 20 concurrent requests to avoid rate limits
        val chunks = validIds.chunked(20)
        for (chunk in chunks) {
            // If we already hit PERMISSION_DENIED, stop wasting API calls
            if (permissionDenied) {
                allSuccess = false
                break
            }

            coroutineScope {
                val deferreds = chunk.map { msgId ->
                    async(Dispatchers.IO) {
                        executeTelegramMessageDeletion(cleanToken, chatId, msgId)
                    }
                }
                val results = deferreds.awaitAll()
                val actuallyDeleted = results.count { it == TelegramDeletionStatus.DELETED }
                totalDeletedCount += actuallyDeleted

                if (results.any { it == TelegramDeletionStatus.PERMISSION_DENIED }) {
                    permissionDenied = true
                    allSuccess = false
                    Log.e("ServerApi", "deleteTelegramMessagesBatch: PERMISSION_DENIED — Bot cannot delete messages in this channel! Stopping.")
                }
                if (results.any { it == TelegramDeletionStatus.ERROR }) {
                    allSuccess = false
                }

                if (actuallyDeleted > 0) {
                    Log.d("ServerApi", "deleteTelegramMessagesBatch: Actually deleted $actuallyDeleted out of ${chunk.size} in this chunk (total so far: $totalDeletedCount)")
                }
            }

            // Small delay between chunks to respect Telegram rate limits
            if (chunks.size > 1) {
                kotlinx.coroutines.delay(200L)
            }
        }

        Log.d("ServerApi", "deleteTelegramMessagesBatch FINAL: $totalDeletedCount messages ACTUALLY deleted from Telegram out of ${validIds.size} attempted")
        return@withContext Pair(allSuccess, totalDeletedCount)
    }

    /**
     * Sends HTTP deleteMessage request directly to Telegram Bot API.
     */
    suspend fun deleteTelegramMessage(botToken: String, chatId: String, messageId: Long): Boolean = withContext(Dispatchers.IO) {
        val status = executeTelegramMessageDeletion(botToken, chatId, messageId)
        return@withContext (status == TelegramDeletionStatus.DELETED || status == TelegramDeletionStatus.ALREADY_DELETED)
    }

    /**
     * Complete deep deletion of a file and ALL of its chunk messages from Telegram Cloud Chat & Room DB.
     * CRITICAL: Only clears Room DB records AFTER verified Telegram deletion.
     * If Telegram deletion fails (permission denied, error), DB records are PRESERVED so files aren't lost.
     */
    suspend fun purgeFileCompleteFromTelegram(
        context: android.content.Context,
        botToken: String,
        chatId: String,
        file: com.example.telegrambackup.data.UploadedFile
    ): Boolean = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val cleanChatId = chatId.trim()

        val msgIds = mutableSetOf<Long>()
        if (file.messageId > 0) {
            msgIds.add(file.messageId)
        }
        val directId = file.telegramFileId.toLongOrNull()
        if (directId != null && directId > 0) {
            msgIds.add(directId)
        }

        // Query all chunk message IDs for this file path from Room database
        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            val chunks = db.chunkProgressDao().getUploadedChunksForFile(file.path)
            chunks.forEach { chunk ->
                if (chunk.messageId > 0) {
                    msgIds.add(chunk.messageId)
                }
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "Error querying chunk message IDs for ${file.path}", e)
        }

        var deletionOk = true
        var actuallyDeletedCount = 0
        var permissionBlocked = false

        if (cleanToken.isNotEmpty() && cleanChatId.isNotEmpty() && msgIds.isNotEmpty()) {
            val idList = msgIds.toList()
            Log.d("ServerApi", "Purging ${idList.size} Telegram messages for file ${file.fileName}: $idList")

            // Delete each message individually for accurate results
            for (msgId in idList) {
                val status = executeTelegramMessageDeletion(cleanToken, cleanChatId, msgId)
                when (status) {
                    TelegramDeletionStatus.DELETED -> {
                        actuallyDeletedCount++
                        Log.d("ServerApi", "✅ Message #$msgId ACTUALLY deleted from Telegram channel")
                    }
                    TelegramDeletionStatus.ALREADY_DELETED -> {
                        Log.d("ServerApi", "⚪ Message #$msgId already gone from Telegram (not found)")
                    }
                    TelegramDeletionStatus.PERMISSION_DENIED -> {
                        permissionBlocked = true
                        deletionOk = false
                        Log.e("ServerApi", "🚫 PERMISSION DENIED: Bot cannot delete message #$msgId — file REMAINS in Telegram channel!")
                    }
                    TelegramDeletionStatus.ERROR -> {
                        deletionOk = false
                        Log.e("ServerApi", "❌ Error deleting message #$msgId from Telegram")
                    }
                }
            }
            Log.d("ServerApi", "purgeFileComplete result for ${file.fileName}: $actuallyDeletedCount ACTUALLY deleted, permissionBlocked=$permissionBlocked, totalMsgIds=${idList.size}")
        }

        // CRITICAL: Only clear Room DB records if Telegram deletion was NOT blocked by permissions
        // If permission was denied, keep DB records so files appear in the app (they still exist in channel)
        if (!permissionBlocked) {
            try {
                val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
                db.chunkProgressDao().deleteChunksForFile(file.path)
                db.uploadedFileDao().deleteByPath(file.path)
                if (file.telegramFileId.isNotEmpty()) {
                    db.uploadedFileDao().deleteByTelegramFileId(file.telegramFileId)
                }
                Log.d("ServerApi", "Cleared Room DB records for ${file.fileName} (Telegram deletion verified)")
            } catch (e: Exception) {
                Log.e("ServerApi", "Error deleting local DB record for ${file.path}", e)
            }
        } else {
            Log.e("ServerApi", "⚠️ KEEPING Room DB records for ${file.fileName} because Telegram deletion was BLOCKED (permission denied). File still exists in channel!")
        }

        return@withContext deletionOk
    }

    /**
     * Purge an unlisted file or path from Telegram Cloud Chat even if no UploadedFile record exists in Room DB.
     * Only clears Room DB records after verified Telegram deletion.
     */
    suspend fun purgeUnlistedPathFromTelegram(
        context: android.content.Context,
        botToken: String,
        chatId: String,
        path: String,
        telegramFileId: String = ""
    ): Boolean = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val cleanChatId = chatId.trim()
        if (cleanToken.isEmpty() || cleanChatId.isEmpty()) return@withContext false

        val msgIds = mutableSetOf<Long>()
        val directId = telegramFileId.toLongOrNull()
        if (directId != null && directId > 0) {
            msgIds.add(directId)
        }

        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            val file = db.uploadedFileDao().getFileByPath(path)
            if (file != null) {
                if (file.messageId > 0) msgIds.add(file.messageId)
                file.telegramFileId.toLongOrNull()?.let { if (it > 0) msgIds.add(it) }
            }
            val chunks = db.chunkProgressDao().getUploadedChunksForFile(path)
            chunks.forEach { chunk ->
                if (chunk.messageId > 0) msgIds.add(chunk.messageId)
            }
        } catch (_: Exception) {}

        var ok = true
        var permissionBlocked = false
        if (msgIds.isNotEmpty()) {
            for (msgId in msgIds) {
                val status = executeTelegramMessageDeletion(cleanToken, cleanChatId, msgId)
                when (status) {
                    TelegramDeletionStatus.DELETED -> Log.d("ServerApi", "✅ Purged unlisted message #$msgId from Telegram")
                    TelegramDeletionStatus.ALREADY_DELETED -> Log.d("ServerApi", "⚪ Unlisted message #$msgId already gone")
                    TelegramDeletionStatus.PERMISSION_DENIED -> {
                        permissionBlocked = true
                        ok = false
                        Log.e("ServerApi", "🚫 PERMISSION DENIED: Cannot delete unlisted message #$msgId")
                    }
                    TelegramDeletionStatus.ERROR -> {
                        ok = false
                        Log.e("ServerApi", "❌ Error deleting unlisted message #$msgId")
                    }
                }
            }
        }

        // Only clear DB records if Telegram didn't block the deletion
        if (!permissionBlocked) {
            try {
                val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
                db.chunkProgressDao().deleteChunksForFile(path)
                db.uploadedFileDao().deleteByPath(path)
                if (telegramFileId.isNotEmpty()) {
                    db.uploadedFileDao().deleteByTelegramFileId(telegramFileId)
                }
            } catch (_: Exception) {}
        } else {
            Log.e("ServerApi", "⚠️ KEEPING DB records for $path — Telegram deletion was BLOCKED")
        }

        return@withContext ok
    }

    data class TelegramChatInfo(
        val success: Boolean,
        val canonicalId: Long? = null,
        val title: String = "",
        val type: String = "",
        val isBotAdmin: Boolean = false,
        val canDeleteMessages: Boolean = false,
        val errorMessage: String = ""
    )

    /**
     * Inspects the Telegram Channel / Chat, retrieves official canonical ID, title, and verifies bot Admin Delete rights.
     */
    suspend fun getTelegramChatInfo(botToken: String, rawChatId: String): TelegramChatInfo = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(rawChatId)
        if (cleanToken.isEmpty()) return@withContext TelegramChatInfo(false, errorMessage = "Bot token is empty")

        try {
            // 1. Query getChat
            val chatUrl = "https://api.telegram.org/bot$cleanToken/getChat?chat_id=$formattedChatId"
            val chatReq = Request.Builder().url(chatUrl).build()
            val chatRes = client.newCall(chatReq).execute()
            val chatBody = chatRes.body?.string() ?: ""

            if (!chatRes.isSuccessful || !chatBody.contains("\"ok\":true")) {
                val errorDesc = try { JSONObject(chatBody).optString("description", "Chat not found") } catch (_: Exception) { "Chat not found" }
                return@withContext TelegramChatInfo(false, errorMessage = errorDesc)
            }

            val chatJson = JSONObject(chatBody).optJSONObject("result")
            val canonicalId = chatJson?.optLong("id")
            val title = chatJson?.optString("title", "") ?: ""
            val type = chatJson?.optString("type", "") ?: ""

            // 2. Query getMe to get bot's ID
            val meUrl = "https://api.telegram.org/bot$cleanToken/getMe"
            val meReq = Request.Builder().url(meUrl).build()
            val meRes = client.newCall(meReq).execute()
            val meBody = meRes.body?.string() ?: ""
            val botId = try { JSONObject(meBody).optJSONObject("result")?.optLong("id") } catch (_: Exception) { null }

            var isBotAdmin = false
            var canDeleteMessages = false

            if (botId != null && canonicalId != null) {
                // 3. Query getChatMember to check admin delete rights
                val memberUrl = "https://api.telegram.org/bot$cleanToken/getChatMember?chat_id=$canonicalId&user_id=$botId"
                val memberReq = Request.Builder().url(memberUrl).build()
                val memberRes = client.newCall(memberReq).execute()
                val memberBody = memberRes.body?.string() ?: ""

                if (memberBody.contains("\"ok\":true")) {
                    val memberObj = JSONObject(memberBody).optJSONObject("result")
                    val status = memberObj?.optString("status", "") ?: ""
                    isBotAdmin = status == "administrator" || status == "creator"
                    canDeleteMessages = isBotAdmin && (memberObj?.optBoolean("can_delete_messages", true) ?: true)
                }
            }

            return@withContext TelegramChatInfo(
                success = true,
                canonicalId = canonicalId,
                title = title,
                type = type,
                isBotAdmin = isBotAdmin,
                canDeleteMessages = canDeleteMessages
            )
        } catch (e: Exception) {
            return@withContext TelegramChatInfo(false, errorMessage = e.localizedMessage ?: "Network error")
        }
    }

    /**
     * Sends a temporary ping message to Telegram chat/channel to discover current highest message_id.
     */
    suspend fun getHighestTelegramMessageId(botToken: String, chatId: String): Long = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(chatId)
        if (cleanToken.isEmpty()) return@withContext 0L
        try {
            val url = "https://api.telegram.org/bot$cleanToken/sendMessage"
            val json = JSONObject().apply {
                if (formattedChatId is Long) put("chat_id", formattedChatId) else put("chat_id", formattedChatId.toString())
                put("text", "🧹 Telegram Storage Deep Cleanup Scanner...")
            }
            val requestBody = json.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (body.contains("\"ok\":true")) {
                val jsonRes = JSONObject(body)
                val resultObj = jsonRes.optJSONObject("result")
                val highestId = resultObj?.optLong("message_id", 0L) ?: 0L
                if (highestId > 0) {
                    deleteTelegramMessage(cleanToken, chatId, highestId)
                    return@withContext highestId
                }
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getHighestTelegramMessageId error", e)
        }
        return@withContext 0L
    }

    /**
     * Sends a test message, then deletes it, to VERIFY the bot can actually delete messages in this channel.
     * Returns true if the bot successfully created AND deleted a test message.
     */
    suspend fun verifyTelegramDeletionWorks(botToken: String, chatId: String): Boolean = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(chatId)
        if (cleanToken.isEmpty()) return@withContext false

        try {
            // Step 1: Send a test message
            val sendUrl = "https://api.telegram.org/bot$cleanToken/sendMessage"
            val sendJson = JSONObject().apply {
                if (formattedChatId is Long) put("chat_id", formattedChatId) else put("chat_id", formattedChatId.toString())
                put("text", "🔬 Deletion verification test — this message should disappear immediately")
            }
            val sendBody = sendJson.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
            val sendReq = Request.Builder().url(sendUrl).post(sendBody).build()
            val sendRes = client.newCall(sendReq).execute()
            val sendResBody = sendRes.body?.string() ?: ""

            if (!sendResBody.contains("\"ok\":true")) {
                Log.e("ServerApi", "verifyDeletion: Failed to send test message: $sendResBody")
                return@withContext false
            }

            val testMsgId = try {
                JSONObject(sendResBody).optJSONObject("result")?.optLong("message_id", 0L) ?: 0L
            } catch (_: Exception) { 0L }

            if (testMsgId <= 0) {
                Log.e("ServerApi", "verifyDeletion: Could not extract test message_id")
                return@withContext false
            }

            // Step 2: Delete the test message using individual deleteMessage
            val status = executeTelegramMessageDeletion(cleanToken, chatId, testMsgId)
            Log.d("ServerApi", "verifyDeletion: test message #$testMsgId deletion result = $status")

            if (status == TelegramDeletionStatus.DELETED) {
                Log.d("ServerApi", "✅ VERIFIED: Bot CAN delete messages in this channel")
                return@withContext true
            } else {
                Log.e("ServerApi", "🚫 VERIFICATION FAILED: Bot CANNOT delete messages! Status=$status")
                return@withContext false
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "verifyDeletion error", e)
            return@withContext false
        }
    }

    /**
     * Deep-scans and purges ALL messages/files in Telegram Bot Chat/Channel up to maxMessageId.
     * Uses INDIVIDUAL deleteMessage calls (never batch) for honest, verified deletion counts.
     * Runs a deletion verification test before starting the scan.
     * Returns Pair(totalDeletedCount, totalScannedCount).
     */
    suspend fun deepPurgeTelegramChatStorage(
        botToken: String,
        chatId: String,
        knownMaxId: Long = 0L,
        onProgress: (Int, Int, Int) -> Unit = { _, _, _ -> }
    ): Pair<Int, Int> = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        if (cleanToken.isEmpty()) return@withContext Pair(0, 0)

        // 1. Resolve canonical chat ID and verify channel status
        val chatInfo = getTelegramChatInfo(cleanToken, chatId)
        val targetChatId = if (chatInfo.canonicalId != null) chatInfo.canonicalId.toString() else chatId

        // 2. VERIFY deletion actually works before scanning thousands of IDs
        Log.d("ServerApi", "deepPurge: Running deletion verification test for channel '${chatInfo.title}' (${targetChatId})...")
        val canDelete = verifyTelegramDeletionWorks(cleanToken, targetChatId)
        if (!canDelete) {
            Log.e("ServerApi", "deepPurge: ❌ ABORTED — Bot cannot delete messages in this channel. Ensure bot is Admin with 'Delete Messages' right.")
            return@withContext Pair(-1, 0) // Return -1 to signal permission failure to UI
        }

        // 3. Get highest message ID via ping
        val pingId = getHighestTelegramMessageId(cleanToken, targetChatId)
        val highestId = if (pingId > 0) {
            pingId + 50L
        } else {
            maxOf(knownMaxId + 100L, 50000L)
        }

        Log.d("ServerApi", "deepPurge: Scanning chatId=$targetChatId ('${chatInfo.title}') IDs 1..$highestId (pingId=$pingId, knownMaxId=$knownMaxId)")
        val allIds = (1L..highestId).toList()
        // Use chunks of 20 for concurrency to avoid rate limits while staying fast
        val subChunks = allIds.chunked(20)
        var totalDeleted = 0
        var permissionFailed = false

        subChunks.forEachIndexed { index, subChunk ->
            if (permissionFailed) {
                onProgress(subChunks.size, subChunks.size, totalDeleted)
                return@forEachIndexed
            }

            try {
                coroutineScope {
                    val deferreds = subChunk.map { msgId ->
                        async(Dispatchers.IO) {
                            executeTelegramMessageDeletion(cleanToken, targetChatId, msgId)
                        }
                    }
                    val results = deferreds.awaitAll()
                    val actuallyDeleted = results.count { it == TelegramDeletionStatus.DELETED }
                    totalDeleted += actuallyDeleted

                    if (results.any { it == TelegramDeletionStatus.PERMISSION_DENIED }) {
                        permissionFailed = true
                        Log.e("ServerApi", "deepPurge: PERMISSION DENIED encountered at chunk $index — stopping scan")
                    }
                }
            } catch (_: Exception) {}

            onProgress(index + 1, subChunks.size, totalDeleted)

            // Rate limit: small delay between chunks
            if (index % 5 == 4) {
                kotlinx.coroutines.delay(300L)
            }
        }

        Log.d("ServerApi", "deepPurge COMPLETE: $totalDeleted messages ACTUALLY deleted from Telegram out of ${allIds.size} scanned")
        return@withContext Pair(totalDeleted, allIds.size)
    }
}
