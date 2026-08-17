package com.example.telegrambackup.ui.explorer

import android.content.Context
import android.os.Environment
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.telegrambackup.data.UploadedFile
import com.example.telegrambackup.network.HttpClientProvider
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.theme.TelegramEmerald
import com.example.telegrambackup.utils.AppPrefs
import com.example.telegrambackup.utils.DynamicProcessTracker
import com.example.telegrambackup.utils.FileEncryptor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CloudRestoreWizardDialog(
    filesToRestore: List<UploadedFile>,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { AppPrefs(context) }

    var isRestoring by remember { mutableStateOf(false) }
    var currentFileIndex by remember { mutableIntStateOf(0) }
    var currentFileName by remember { mutableStateOf("") }
    var progressFraction by remember { mutableFloatStateOf(0f) }
    var statusMessage by remember { mutableStateOf("") }

    val restoreFolder = remember {
        File(Environment.getExternalStorageDirectory(), "Restored_Backups").apply { if (!exists()) mkdirs() }
    }

    if (DynamicProcessTracker.isMinimized) {
        return
    }

    AlertDialog(
        onDismissRequest = { if (!isRestoring) onDismiss() },
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)),
        containerColor = Color(0xFF0F172A),
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.CloudDownload, contentDescription = null, tint = TelegramEmerald, modifier = Modifier.size(28.dp))
                    Spacer(modifier = Modifier.width(10.dp))
                    Text(
                        "Cloud Restore Wizard",
                        style = MaterialTheme.typography.titleMedium.copy(color = Color.White, fontWeight = FontWeight.Bold)
                    )
                }
                if (isRestoring) {
                    IconButton(onClick = { DynamicProcessTracker.minimize() }) {
                        Icon(Icons.Default.Remove, contentDescription = "Minimize", tint = TelegramBlue)
                    }
                }
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Restoring ${filesToRestore.size} file(s) to internal storage folder:",
                    style = MaterialTheme.typography.bodySmall.copy(color = Color.White.copy(alpha = 0.7f))
                )

                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(modifier = Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Folder, contentDescription = null, tint = TelegramBlue, modifier = Modifier.size(20.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            restoreFolder.absolutePath,
                            style = MaterialTheme.typography.labelSmall.copy(color = Color.White, fontWeight = FontWeight.Bold)
                        )
                    }
                }

                if (isRestoring) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        "File ${currentFileIndex + 1} of ${filesToRestore.size}: $currentFileName",
                        style = MaterialTheme.typography.bodySmall.copy(color = Color.White, fontWeight = FontWeight.Bold)
                    )
                    LinearProgressIndicator(
                        progress = { progressFraction },
                        modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                        color = TelegramEmerald,
                        trackColor = Color.White.copy(alpha = 0.2f)
                    )
                    Text(
                        statusMessage,
                        style = MaterialTheme.typography.labelSmall.copy(color = TelegramBlue)
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (isRestoring) return@Button
                    if (filesToRestore.isEmpty()) {
                        Toast.makeText(context, "No files selected to restore.", Toast.LENGTH_SHORT).show()
                        return@Button
                    }

                    val botToken = prefs.botToken.trim()
                    if (botToken.isEmpty()) {
                        Toast.makeText(context, "Telegram Bot Token required to download files!", Toast.LENGTH_LONG).show()
                        return@Button
                    }

                    isRestoring = true
                    com.example.telegrambackup.utils.DynamicProcessTracker.startProcess(
                        title = "Restoring Files (${filesToRestore.size})",
                        subtitle = "Starting Cloud Restore...",
                        icon = androidx.compose.material.icons.Icons.Default.CloudDownload
                    )

                    scope.launch(Dispatchers.IO) {
                        var restoredSuccess = 0
                        val client = HttpClientProvider.client

                        filesToRestore.forEachIndexed { idx, item ->
                            val currentFrac = idx.toFloat() / filesToRestore.size.toFloat()
                            withContext(Dispatchers.Main) {
                                currentFileIndex = idx
                                currentFileName = item.fileName
                                progressFraction = currentFrac
                                statusMessage = "Downloading ${item.fileName}..."
                                com.example.telegrambackup.utils.DynamicProcessTracker.updateProgress(
                                    progress = currentFrac,
                                    subtitle = "Restoring ${idx + 1}/${filesToRestore.size}: ${item.fileName}"
                                )
                            }

                            try {
                                val targetFile = File(restoreFolder, item.fileName)
                                if (item.telegramFileId.isNotEmpty() && item.telegramFileId != "DIR_MARKER") {
                                    // 1. Get File Path from Telegram Bot API
                                    val getFileUrl = "https://api.telegram.org/bot$botToken/getFile?file_id=${item.telegramFileId}"
                                    val req = Request.Builder().url(getFileUrl).build()
                                    val res = client.newCall(req).execute()
                                    val body = res.body?.string() ?: ""

                                    if (res.isSuccessful && body.contains("\"ok\":true")) {
                                        val filePath = org.json.JSONObject(body).optJSONObject("result")?.optString("file_path", "") ?: ""
                                        if (filePath.isNotEmpty()) {
                                            val downloadUrl = "https://api.telegram.org/file/bot$botToken/$filePath"
                                            val dlReq = Request.Builder().url(downloadUrl).build()
                                            val dlRes = client.newCall(dlReq).execute()

                                            dlRes.body?.byteStream()?.use { input ->
                                                FileOutputStream(targetFile).use { output ->
                                                    input.copyTo(output)
                                                }
                                            }

                                            // Decrypt file if encrypted
                                            if (prefs.encryptionKey.isNotEmpty()) {
                                                withContext(Dispatchers.Main) { statusMessage = "Decrypting file..." }
                                                FileEncryptor.decryptFileInPlace(targetFile, prefs.encryptionKey)
                                            }

                                            restoredSuccess++
                                        }
                                    }
                                }
                            } catch (e: Exception) {
                                android.util.Log.e("CloudRestore", "Failed to restore ${item.fileName}", e)
                            }
                        }

                        withContext(Dispatchers.Main) {
                            isRestoring = false
                            com.example.telegrambackup.utils.DynamicProcessTracker.finishProcess()
                            Toast.makeText(context, "✅ Successfully restored $restoredSuccess of ${filesToRestore.size} files to ${restoreFolder.name}", Toast.LENGTH_LONG).show()
                            onDismiss()
                        }
                    }
                },
                enabled = !isRestoring && filesToRestore.isNotEmpty(),
                colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald)
            ) {
                if (isRestoring) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Text("Start Restore", fontWeight = FontWeight.Bold)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!isRestoring) onDismiss() }) {
                Text("Cancel", color = Color.White.copy(alpha = 0.7f))
            }
        }
    )
}
