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
    suspend fun getLatestAppVersion(serverUrl: String): com.example.telegrambackup.ui.update.AppVersionInfo = withContext(Dispatchers.IO) {
        try {
            val url = cleanUrl(serverUrl, "/api/app/latest-version")
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            if (response.isSuccessful && body.contains("\"success\":true")) {
                val json = JSONObject(body)
                return@withContext com.example.telegrambackup.ui.update.AppVersionInfo(
                    success = true,
                    versionCode = json.optInt("versionCode", 1),
                    versionName = json.optString("versionName", "1.0.0"),
                    downloadUrl = json.optString("downloadUrl", ""),
                    releaseNotes = json.optString("releaseNotes", "New performance and feature updates.")
                )
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getLatestAppVersion error", e)
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

    /**
     * Batch deletes up to 100 messages at once using Telegram Bot API deleteMessages endpoint.
     * Automatically falls back to high-concurrency parallel deletion if batch fails.
     * Returns Pair(allSuccess, deletedCount).
     */
    suspend fun deleteTelegramMessagesBatch(botToken: String, chatId: String, messageIds: List<Long>): Pair<Boolean, Int> = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(chatId)
        val validIds = messageIds.filter { it > 0 }
        if (cleanToken.isEmpty() || validIds.isEmpty()) return@withContext Pair(false, 0)

        if (validIds.size == 1) {
            val ok = deleteTelegramMessage(cleanToken, chatId, validIds[0])
            return@withContext Pair(ok, if (ok) 1 else 0)
        }

        val chunks = validIds.chunked(100)
        var allSuccess = true
        var totalDeletedCount = 0

        for (chunk in chunks) {
            try {
                val url = "https://api.telegram.org/bot$cleanToken/deleteMessages"
                val json = JSONObject().apply {
                    if (formattedChatId is Long) put("chat_id", formattedChatId) else put("chat_id", formattedChatId.toString())
                    val idsArray = JSONArray()
                    chunk.forEach { idsArray.put(it) }
                    put("message_ids", idsArray)
                }
                val requestBody = json.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
                val request = Request.Builder().url(url).post(requestBody).build()
                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: ""

                val jsonRes = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
                val ok = response.isSuccessful && jsonRes.optBoolean("ok", false)

                if (ok) {
                    Log.d("ServerApi", "deleteTelegramMessagesBatch: Deleted ${chunk.size} messages in one batch")
                    totalDeletedCount += chunk.size
                } else {
                    Log.d("ServerApi", "deleteTelegramMessagesBatch batch not ok ($body), executing concurrent individual fallback for ${chunk.size} messages")
                    coroutineScope {
                        val deferreds = chunk.map { msgId ->
                            async(Dispatchers.IO) {
                                deleteTelegramMessage(cleanToken, chatId, msgId)
                            }
                        }
                        val results = deferreds.awaitAll()
                        val deletedInFallback = results.count { it }
                        totalDeletedCount += deletedInFallback
                        if (results.any { !it }) allSuccess = false
                    }
                }
            } catch (e: Exception) {
                Log.e("ServerApi", "deleteTelegramMessagesBatch chunk error, executing parallel fallback", e)
                coroutineScope {
                    val deferreds = chunk.map { msgId ->
                        async(Dispatchers.IO) {
                            deleteTelegramMessage(cleanToken, chatId, msgId)
                        }
                    }
                    val results = deferreds.awaitAll()
                    val deletedInFallback = results.count { it }
                    totalDeletedCount += deletedInFallback
                    if (results.any { !it }) allSuccess = false
                }
            }
        }
        return@withContext Pair(allSuccess, totalDeletedCount)
    }

    /**
     * Sends HTTP deleteMessage request directly to Telegram Bot API with 429 Rate Limit retry support,
     * query parameter fallback, and idempotent handling for already-deleted messages or channel messages.
     */
    suspend fun deleteTelegramMessage(botToken: String, chatId: String, messageId: Long): Boolean = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(chatId)
        if (cleanToken.isEmpty() || messageId <= 0) return@withContext false
        try {
            // Method 1: POST with application/json body
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
                return@withContext deleteTelegramMessage(cleanToken, chatId, messageId)
            }

            val jsonRes = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            val ok = jsonRes.optBoolean("ok", false)
            val desc = jsonRes.optString("description", "")

            if (ok) return@withContext true

            // Treat already deleted or missing messages as successfully cleared
            val isAlreadyGone = desc.contains("message to delete not found", ignoreCase = true) ||
                    desc.contains("MESSAGE_ID_INVALID", ignoreCase = true) ||
                    desc.contains("message identifier is not specified", ignoreCase = true)

            if (isAlreadyGone) return@withContext true

            // Method 2: Fallback to URL-Encoded form parameters
            val fallbackUrl = "https://api.telegram.org/bot$cleanToken/deleteMessage?chat_id=$formattedChatId&message_id=$messageId"
            val fallbackReq = Request.Builder().url(fallbackUrl).post("".toRequestBody(null)).build()
            val fallbackRes = client.newCall(fallbackReq).execute()
            val fallbackBody = fallbackRes.body?.string() ?: ""

            if (fallbackRes.isSuccessful && fallbackBody.contains("\"ok\":true")) {
                return@withContext true
            }

            if (fallbackBody.contains("message to delete not found", ignoreCase = true) ||
                fallbackBody.contains("MESSAGE_ID_INVALID", ignoreCase = true)) {
                return@withContext true
            }

            if (desc.contains("not enough rights", ignoreCase = true) || desc.contains("CHAT_ADMIN_REQUIRED", ignoreCase = true) || desc.contains("message can't be deleted", ignoreCase = true)) {
                Log.w("ServerApi", "Bot needs Admin Delete rights in Telegram Channel/Chat: $formattedChatId. Desc: $desc")
            }

            return@withContext false
        } catch (e: Exception) {
            Log.e("ServerApi", "deleteTelegramMessage error for msgId #$messageId", e)
            return@withContext false
        }
    }

    /**
     * Complete deep deletion of a file and ALL of its chunk messages from Telegram Cloud Chat & Room DB.
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
        if (cleanToken.isNotEmpty() && cleanChatId.isNotEmpty() && msgIds.isNotEmpty()) {
            val idList = msgIds.toList()
            Log.d("ServerApi", "Purging ${idList.size} Telegram messages for file ${file.fileName}: $idList")
            val (ok, _) = deleteTelegramMessagesBatch(cleanToken, cleanChatId, idList)
            deletionOk = ok
        }

        // Clean up Room DB records
        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            db.chunkProgressDao().deleteChunksForFile(file.path)
            db.uploadedFileDao().deleteByPath(file.path)
            if (file.telegramFileId.isNotEmpty()) {
                db.uploadedFileDao().deleteByTelegramFileId(file.telegramFileId)
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "Error deleting local DB record for ${file.path}", e)
        }

        return@withContext deletionOk
    }

    /**
     * Purge an unlisted file or path from Telegram Cloud Chat even if no UploadedFile record exists in Room DB.
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
        if (msgIds.isNotEmpty()) {
            val (batchOk, _) = deleteTelegramMessagesBatch(cleanToken, cleanChatId, msgIds.toList())
            ok = batchOk
        }

        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            db.chunkProgressDao().deleteChunksForFile(path)
            db.uploadedFileDao().deleteByPath(path)
            if (telegramFileId.isNotEmpty()) {
                db.uploadedFileDao().deleteByTelegramFileId(telegramFileId)
            }
        } catch (_: Exception) {}

        return@withContext ok
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
     * Deep-scans and purges ALL messages/files in Telegram Bot Chat/Channel up to maxMessageId.
     * Uses 100-message chunks with parallel concurrent fallback & rate-limit throttling to guarantee 100% deletion.
     * Returns Pair(totalDeletedCount, totalScannedCount).
     */
    suspend fun deepPurgeTelegramChatStorage(
        botToken: String,
        chatId: String,
        knownMaxId: Long = 0L,
        onProgress: (Int, Int, Int) -> Unit = { _, _, _ -> }
    ): Pair<Int, Int> = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val formattedChatId = formatChatIdForTelegram(chatId)
        if (cleanToken.isEmpty()) return@withContext Pair(0, 0)

        val pingId = getHighestTelegramMessageId(cleanToken, chatId)
        val highestId = maxOf(pingId + 20L, knownMaxId + 20L, 2000L)

        Log.d("ServerApi", "deepPurgeTelegramChatStorage starting for chatId $formattedChatId up to highestId $highestId (pingId=$pingId, knownMaxId=$knownMaxId)")
        val allIds = (1L..highestId).toList()
        val subChunks = allIds.chunked(100)
        var totalDeleted = 0

        subChunks.forEachIndexed { index, subChunk ->
            try {
                val (_, deletedCount) = deleteTelegramMessagesBatch(cleanToken, chatId, subChunk)
                totalDeleted += deletedCount
            } catch (_: Exception) {}
            onProgress(index + 1, subChunks.size, totalDeleted)
        }

        return@withContext Pair(totalDeleted, allIds.size)
    }
}
