package com.example.telegrambackup.utils

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import com.example.telegrambackup.data.AppDatabase
import com.example.telegrambackup.data.UploadedFile
import com.example.telegrambackup.network.ServerApi
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * DriveUploadManager
 * High-throughput parallel upload engine specifically for Cloud Drive files & folder trees.
 * Executes up to 4 parallel upload streams simultaneously without blocking UI navigation or background tasks.
 */
object DriveUploadManager {
    private const val TAG = "DriveUploadManager"
    private const val MAX_PARALLEL_UPLOADS = 4

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val parallelSemaphore = Semaphore(MAX_PARALLEL_UPLOADS)
    private val activeUploadCount = AtomicInteger(0)

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    fun enqueuePersonalFiles(context: Context, uris: List<Uri>, targetDirectoryPath: String, onUpdate: () -> Unit) {
        scope.launch {
            val appCtx = context.applicationContext
            val prefs = AppPrefs(appCtx)
            val botToken = prefs.botToken
            val chatId = prefs.chatId

            if (botToken.isEmpty() || chatId.isEmpty()) {
                Log.w(TAG, "Missing bot credentials for Drive upload.")
                return@launch
            }

            val db = AppDatabase.getDatabase(appCtx)
            val tempDir = File(appCtx.cacheDir, "drive_upload_temp")
            if (!tempDir.exists()) tempDir.mkdirs()

            val totalFiles = uris.size
            BackupProgressTracker.startBackupSession(totalFiles, "Cloud Drive: Uploading $totalFiles files in parallel...")

            val jobs = uris.map { uri ->
                launch {
                    parallelSemaphore.withPermit {
                        activeUploadCount.incrementAndGet()
                        try {
                            val fileName = uri.lastPathSegment?.substringAfterLast("/") ?: "Cloud_File_${System.currentTimeMillis()}"
                            val targetPath = "$targetDirectoryPath/$fileName"

                            val tempFile = File(tempDir, "${System.currentTimeMillis()}_$fileName")
                            appCtx.contentResolver.openInputStream(uri)?.use { input ->
                                tempFile.outputStream().use { output -> input.copyTo(output) }
                            }

                            if (tempFile.exists() && tempFile.length() > 0) {
                                processSingleDriveFileUpload(
                                    appCtx,
                                    prefs,
                                    db,
                                    botToken,
                                    chatId,
                                    tempFile,
                                    fileName,
                                    targetPath
                                )
                            }
                            if (tempFile.exists()) tempFile.delete()
                        } catch (e: Exception) {
                            Log.e(TAG, "Error in Drive personal file upload", e)
                        } finally {
                            activeUploadCount.decrementAndGet()
                            withContext(Dispatchers.Main) { onUpdate() }
                        }
                    }
                }
            }

            jobs.joinAll()
            withContext(Dispatchers.Main) { onUpdate() }
            BackupProgressTracker.finishBackupSession("☁️ Drive upload complete ($totalFiles files)")
        }
    }

    fun enqueueFolderTree(context: Context, treeUri: Uri, targetDirectoryPath: String, onUpdate: () -> Unit) {
        scope.launch {
            val appCtx = context.applicationContext
            try {
                appCtx.contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {}

            val docDir = DocumentFile.fromTreeUri(appCtx, treeUri) ?: return@launch
            if (!docDir.isDirectory) return@launch

            val prefs = AppPrefs(appCtx)
            val botToken = prefs.botToken
            val chatId = prefs.chatId
            if (botToken.isEmpty() || chatId.isEmpty()) return@launch

            val db = AppDatabase.getDatabase(appCtx)
            val folderName = docDir.name ?: "Uploaded_Folder"
            val baseFolderPath = "$targetDirectoryPath/$folderName"
            val now = System.currentTimeMillis()

            val rootMarker = UploadedFile(
                baseFolderPath,
                folderName,
                "DIR_MARKER",
                now,
                0L,
                0L
            ).apply { isDriveUpload = true }
            db.uploadedFileDao().insert(rootMarker)

            val userEmail = prefs.userEmail
            if (userEmail.isNotEmpty()) {
                try {
                    ServerApi().indexFile(prefs.serverUrl, userEmail, folderName, "DIR_MARKER", 0L, baseFolderPath, now, 0L, true)
                } catch (_: Exception) {}
            }

            val filesToUpload = mutableListOf<Pair<DocumentFile, String>>()

            suspend fun scanTree(dir: DocumentFile, currentPath: String) {
                dir.listFiles().forEach { child ->
                    if (child.isDirectory) {
                        val subName = child.name ?: "SubFolder"
                        val subPath = "$currentPath/$subName"
                        val subMarker = UploadedFile(subPath, subName, "DIR_MARKER", now, 0L, 0L).apply { isDriveUpload = true }
                        db.uploadedFileDao().insert(subMarker)
                        if (userEmail.isNotEmpty()) {
                            try { ServerApi().indexFile(prefs.serverUrl, userEmail, subName, "DIR_MARKER", 0L, subPath, now, 0L, true) } catch (_: Exception) {}
                        }
                        runBlocking { scanTree(child, subPath) }
                    } else if (child.isFile) {
                        filesToUpload.add(child to currentPath)
                    }
                }
            }

            scanTree(docDir, baseFolderPath)
            withContext(Dispatchers.Main) { onUpdate() }

            if (filesToUpload.isEmpty()) return@launch

            val tempDir = File(appCtx.cacheDir, "drive_folder_temp")
            if (!tempDir.exists()) tempDir.mkdirs()

            BackupProgressTracker.startBackupSession(filesToUpload.size, "Folder '$folderName': Uploading ${filesToUpload.size} files in parallel...")

            val jobs = filesToUpload.map { (docFile, parentPath) ->
                launch {
                    parallelSemaphore.withPermit {
                        activeUploadCount.incrementAndGet()
                        try {
                            val fName = docFile.name ?: "File_${System.currentTimeMillis()}"
                            val fullPath = "$parentPath/$fName"
                            val tempFile = File(tempDir, "${System.currentTimeMillis()}_$fName")

                            appCtx.contentResolver.openInputStream(docFile.uri)?.use { input ->
                                tempFile.outputStream().use { output -> input.copyTo(output) }
                            }

                            if (tempFile.exists() && tempFile.length() > 0) {
                                processSingleDriveFileUpload(
                                    appCtx,
                                    prefs,
                                    db,
                                    botToken,
                                    chatId,
                                    tempFile,
                                    fName,
                                    fullPath
                                )
                            }
                            if (tempFile.exists()) tempFile.delete()
                        } catch (e: Exception) {
                            Log.e(TAG, "Error uploading folder file", e)
                        } finally {
                            activeUploadCount.decrementAndGet()
                            withContext(Dispatchers.Main) { onUpdate() }
                        }
                    }
                }
            }

            jobs.joinAll()
            withContext(Dispatchers.Main) { onUpdate() }
            BackupProgressTracker.finishBackupSession("☁️ Folder '$folderName' upload complete")
        }
    }

    private suspend fun processSingleDriveFileUpload(
        context: Context,
        prefs: AppPrefs,
        db: AppDatabase,
        botToken: String,
        chatId: String,
        file: File,
        fileName: String,
        targetPath: String
    ) {
        val isEncrypted = prefs.encryptionEnabled
        val secretKey = prefs.encryptionKey
        val tempDir = File(context.cacheDir, "drive_proc_temp")
        if (!tempDir.exists()) tempDir.mkdirs()

        val fileToUpload: File
        if (isEncrypted) {
            val encFile = File(tempDir, "${fileName}.enc")
            FileEncryptor.encryptFile(file, encFile, secretKey)
            fileToUpload = encFile
        } else {
            fileToUpload = file
        }

        val totalChunks = FileChunker.getChunkCount(fileToUpload)
        var firstChunkFileId = ""
        var firstChunkMsgId = 0L

        for (chunkIdx in 1..totalChunks) {
            val chunkFile = File(tempDir, "${fileName}.part%03d".format(chunkIdx))
            FileChunker.extractSingleChunk(fileToUpload, chunkIdx, chunkFile)

            val caption = if (totalChunks > 1) "📦 Drive: $fileName [Part $chunkIdx/$totalChunks]" else "☁️ Drive: $fileName"
            val res = uploadSingleChunkWithRetry(botToken, chatId, chunkFile, caption, secretKey)
            if (chunkFile.exists()) chunkFile.delete()

            if (res != null) {
                if (chunkIdx == 1) {
                    firstChunkFileId = res.first
                    firstChunkMsgId = res.second
                }
                val chunkEntity = com.example.telegrambackup.data.ChunkProgressEntity(
                    sourcePath = targetPath,
                    chunkIndex = chunkIdx,
                    totalChunks = totalChunks,
                    telegramFileId = res.first,
                    messageId = res.second,
                    chunkSize = chunkFile.length(),
                    status = "COMPLETED",
                    uploadedAt = System.currentTimeMillis()
                )
                db.chunkProgressDao().insert(chunkEntity)
            } else {
                Log.e(TAG, "Failed chunk $chunkIdx for Drive file $fileName")
                if (isEncrypted && fileToUpload.exists()) fileToUpload.delete()
                return
            }
        }

        if (isEncrypted && fileToUpload.exists()) fileToUpload.delete()

        if (firstChunkFileId.isNotEmpty()) {
            val entity = UploadedFile(
                targetPath,
                fileName,
                firstChunkFileId,
                System.currentTimeMillis(),
                file.length(),
                firstChunkMsgId
            ).apply {
                isDriveUpload = true
                if (totalChunks > 1) this.totalChunks = totalChunks
            }
            db.uploadedFileDao().insert(entity)

            val userEmail = prefs.userEmail
            if (userEmail.isNotEmpty()) {
                try {
                    ServerApi().indexFile(
                        prefs.serverUrl,
                        userEmail,
                        fileName,
                        firstChunkFileId,
                        file.length(),
                        targetPath,
                        System.currentTimeMillis(),
                        firstChunkMsgId,
                        true
                    )
                } catch (_: Exception) {}
            }
            BackupProgressTracker.markFileCompleted(fileName, targetPath, file.length())
            Log.d(TAG, "⚡ Drive upload complete: $fileName")
        }
    }

    private suspend fun uploadSingleChunkWithRetry(
        botToken: String,
        chatId: String,
        file: File,
        caption: String,
        secretKey: String
    ): Pair<String, Long>? {
        var attempt = 1
        while (attempt <= 5) {
            val res = uploadSingleChunk(botToken, chatId, file, caption, secretKey)
            if (res != null) return res
            if (attempt < 5) delay(attempt * 2000L)
            attempt++
        }
        return null
    }

    private fun uploadSingleChunk(
        botToken: String,
        chatId: String,
        file: File,
        caption: String,
        secretKey: String
    ): Pair<String, Long>? {
        return try {
            val url = "https://api.telegram.org/bot$botToken/sendDocument"
            val obfuscatedName = if (secretKey.isNotEmpty()) FileEncryptor.obfuscateFileName(file.name, secretKey) else "ENC_${Math.abs(file.name.hashCode())}.bin"
            val encryptedCaption = if (secretKey.isNotEmpty()) "🔒 ENC:" + FileEncryptor.encryptText(caption, secretKey) else caption

            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("chat_id", chatId)
                .addFormDataPart("caption", encryptedCaption)
                .addFormDataPart("document", obfuscatedName, file.asRequestBody("application/octet-stream".toMediaTypeOrNull()))
                .build()

            val req = Request.Builder().url(url).post(body).build()
            val resp = client.newCall(req).execute()
            val respStr = resp.body?.string() ?: ""
            if (resp.isSuccessful && respStr.isNotEmpty()) {
                val json = JSONObject(respStr)
                if (json.optBoolean("ok")) {
                    val result = json.getJSONObject("result")
                    val messageId = result.optLong("message_id", 0L)
                    val doc = result.optJSONObject("document")
                    val fileId = doc?.optString("file_id", "") ?: ""
                    if (fileId.isNotEmpty()) return Pair(fileId, messageId)
                }
            }
            null
        } catch (e: Exception) {
            null
        }
    }
}
