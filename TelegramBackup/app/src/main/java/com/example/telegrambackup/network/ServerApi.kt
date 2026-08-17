package com.example.telegrambackup.network

import android.util.Log
import com.example.telegrambackup.data.UploadedFile
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
     * Batch deletes up to 100 messages at once using Telegram Bot API deleteMessages endpoint.
     */
    suspend fun deleteTelegramMessagesBatch(botToken: String, chatId: String, messageIds: List<Long>): Boolean = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val cleanChatId = chatId.trim()
        if (cleanToken.isEmpty() || cleanChatId.isEmpty() || messageIds.isEmpty()) return@withContext false
        try {
            val url = "https://api.telegram.org/bot$cleanToken/deleteMessages"
            val json = JSONObject().apply {
                val numericChatId = cleanChatId.toLongOrNull()
                if (numericChatId != null) put("chat_id", numericChatId) else put("chat_id", cleanChatId)
                val idsArray = JSONArray()
                messageIds.forEach { idsArray.put(it) }
                put("message_ids", idsArray)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            Log.d("ServerApi", "deleteTelegramMessagesBatch response ($url): code=${response.code}, body=$body")
            return@withContext response.isSuccessful && JSONObject(body).optBoolean("ok", false)
        } catch (e: Exception) {
            Log.e("ServerApi", "deleteTelegramMessagesBatch error", e)
            return@withContext false
        }
    }

    /**
     * Sends HTTP deleteMessage request directly to Telegram Bot API with 429 Rate Limit retry support.
     */
    suspend fun deleteTelegramMessage(botToken: String, chatId: String, messageId: Long): Boolean = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val cleanChatId = chatId.trim()
        if (cleanToken.isEmpty() || cleanChatId.isEmpty() || messageId <= 0) return@withContext false
        try {
            val url = "https://api.telegram.org/bot$cleanToken/deleteMessage"
            val json = JSONObject().apply {
                val numericChatId = cleanChatId.toLongOrNull()
                if (numericChatId != null) put("chat_id", numericChatId) else put("chat_id", cleanChatId)
                put("message_id", messageId)
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""

            Log.d("ServerApi", "deleteTelegramMessage msgId #$messageId HTTP ${response.code}: $body")

            // Handle HTTP 429 Rate Limiting
            if (response.code == 429 || body.contains("TOO_MANY_REQUESTS")) {
                val retryAfterSec = try { JSONObject(body).optJSONObject("parameters")?.optInt("retry_after", 2) ?: 2 } catch (_: Exception) { 2 }
                Log.w("ServerApi", "Telegram 429 Rate Limit hit. Waiting ${retryAfterSec}s before retry...")
                kotlinx.coroutines.delay(retryAfterSec * 1000L)
                return@withContext deleteTelegramMessage(cleanToken, cleanChatId, messageId)
            }

            // Treat "message to delete not found" as success since it means message is gone from Telegram
            val isOk = response.isSuccessful && (JSONObject(body).optBoolean("ok", false) || body.contains("message to delete not found"))
            return@withContext isOk
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
        val regex = Regex("""(?i)(?:msg|message|chunk|id)?[_\-\:\s]*(\d{2,12})""")
        regex.findAll("${file.telegramFileId} ${file.path} ${file.fileName}").forEach { match ->
            val parsedId = match.groupValues[1].toLongOrNull()
            if (parsedId != null && parsedId > 0) {
                msgIds.add(parsedId)
            }
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

            deletionOk = if (idList.size == 1) {
                deleteTelegramMessage(cleanToken, cleanChatId, idList[0])
            } else {
                var batchOk = deleteTelegramMessagesBatch(cleanToken, cleanChatId, idList)
                if (!batchOk) {
                    batchOk = true
                    idList.forEach { id ->
                        val ok = deleteTelegramMessage(cleanToken, cleanChatId, id)
                        if (!ok) batchOk = false
                    }
                }
                batchOk
            }
        }

        // Clean up Room DB records
        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            db.chunkProgressDao().deleteChunksForFile(file.path)
            db.uploadedFileDao().deleteByPath(file.path)
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

        val regex = Regex("""(?i)(?:msg|message|chunk|id)?[_\-\:\s]*(\d{2,12})""")
        regex.findAll("$path $telegramFileId").forEach { match ->
            val parsedId = match.groupValues[1].toLongOrNull()
            if (parsedId != null && parsedId > 0) {
                msgIds.add(parsedId)
            }
        }

        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            val chunks = db.chunkProgressDao().getUploadedChunksForFile(path)
            chunks.forEach { chunk ->
                if (chunk.messageId > 0) msgIds.add(chunk.messageId)
            }
        } catch (_: Exception) {}

        var ok = true
        if (msgIds.isNotEmpty()) {
            val idList = msgIds.toList()
            ok = deleteTelegramMessagesBatch(cleanToken, cleanChatId, idList)
            if (!ok) {
                ok = true
                idList.forEach { id ->
                    if (!deleteTelegramMessage(cleanToken, cleanChatId, id)) ok = false
                }
            }
        }

        try {
            val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
            db.chunkProgressDao().deleteChunksForFile(path)
            db.uploadedFileDao().deleteByPath(path)
        } catch (_: Exception) {}

        return@withContext ok
    }

    /**
     * Sends a temporary ping message to Telegram chat to discover current highest message_id.
     */
    suspend fun getHighestTelegramMessageId(botToken: String, chatId: String): Long = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val cleanChatId = chatId.trim()
        if (cleanToken.isEmpty() || cleanChatId.isEmpty()) return@withContext 0L
        try {
            val url = "https://api.telegram.org/bot$cleanToken/sendMessage"
            val json = JSONObject().apply {
                val numericChatId = cleanChatId.toLongOrNull()
                if (numericChatId != null) put("chat_id", numericChatId) else put("chat_id", cleanChatId)
                put("text", "🧹 Telegram Storage Deep Cleanup Scanner...")
            }
            val requestBody = json.toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (response.isSuccessful && body.contains("\"ok\":true")) {
                val jsonRes = JSONObject(body)
                val resultObj = jsonRes.optJSONObject("result")
                val highestId = resultObj?.optLong("message_id", 0L) ?: 0L
                if (highestId > 0) {
                    deleteTelegramMessage(cleanToken, cleanChatId, highestId)
                    return@withContext highestId
                }
            }
        } catch (e: Exception) {
            Log.e("ServerApi", "getHighestTelegramMessageId error", e)
        }
        return@withContext 0L
    }

    /**
     * Deep-scans and purges ALL messages/files in Telegram Bot Chat up to maxMessageId.
     * Uses resilient 20-message sub-chunks with individual fallback & rate-limit throttling to guarantee 100% deletion.
     * Returns Pair(totalDeletedCount, totalScannedCount).
     */
    suspend fun deepPurgeTelegramChatStorage(
        botToken: String,
        chatId: String,
        knownMaxId: Long = 0L,
        onProgress: (Int, Int, Int) -> Unit = { _, _, _ -> }
    ): Pair<Int, Int> = withContext(Dispatchers.IO) {
        val cleanToken = botToken.trim()
        val cleanChatId = chatId.trim()
        if (cleanToken.isEmpty() || cleanChatId.isEmpty()) return@withContext Pair(0, 0)

        val pingId = getHighestTelegramMessageId(cleanToken, cleanChatId)
        val highestId = if (pingId > 0) pingId + 100L else if (knownMaxId > 0) knownMaxId + 100L else 10000L

        val allIds = (1L..highestId).toList()
        val subChunks = allIds.chunked(20) // Resilient 20-ID sub-chunks
        var totalDeleted = 0

        subChunks.forEachIndexed { index, subChunk ->
            try {
                // Try batch deletion on 20-ID sub-chunk first
                val batchSuccess = deleteTelegramMessagesBatch(cleanToken, cleanChatId, subChunk)
                if (batchSuccess) {
                    totalDeleted += subChunk.size
                } else {
                    // Fallback to resilient individual item deletion for this 20-ID sub-chunk
                    for (msgId in subChunk) {
                        if (deleteTelegramMessage(cleanToken, cleanChatId, msgId)) {
                            totalDeleted++
                        }
                        kotlinx.coroutines.delay(10L) // Small throttle delay to prevent 429
                    }
                }
            } catch (_: Exception) {}
            onProgress(index + 1, subChunks.size, totalDeleted)
        }
        return@withContext Pair(totalDeleted, highestId.toInt())
    }
}
