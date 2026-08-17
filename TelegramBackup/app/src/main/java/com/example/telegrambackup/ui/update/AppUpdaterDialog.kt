package com.example.telegrambackup.ui.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.NewReleases
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
import androidx.core.content.FileProvider
import com.example.telegrambackup.network.HttpClientProvider
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.theme.TelegramEmerald
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream

import android.content.pm.PackageManager
import android.util.Log

data class AppVersionInfo(
    val success: Boolean,
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val releaseNotes: String
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppUpdaterDialog(
    versionInfo: AppVersionInfo,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var isDownloading by remember { mutableStateOf(false) }
    var isInstallerLaunched by remember { mutableStateOf(false) }
    var downloadedApkFile by remember { mutableStateOf<File?>(null) }
    var downloadProgress by remember { mutableFloatStateOf(0f) }
    var downloadStatusText by remember { mutableStateOf("") }

    fun installApk(apkFile: File) {
        try {
            if (!apkFile.exists() || apkFile.length() == 0L) {
                Toast.makeText(context, "Downloaded update APK is missing or empty.", Toast.LENGTH_LONG).show()
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (!context.packageManager.canRequestPackageInstalls()) {
                    Toast.makeText(context, "Please allow 'Install Unknown Apps' for My Backup to install update", Toast.LENGTH_LONG).show()
                    val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                        data = Uri.parse("package:${context.packageName}")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(settingsIntent)
                    return
                }
            }

            val apkUri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
            }

            // Grant read URI permission to all package installer handlers on device
            val resInfoList = context.packageManager.queryIntentActivities(installIntent, PackageManager.MATCH_DEFAULT_ONLY)
            for (resolveInfo in resInfoList) {
                val packageName = resolveInfo.activityInfo.packageName
                context.grantUriPermission(packageName, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }

            context.startActivity(installIntent)
            isInstallerLaunched = true
            downloadStatusText = "🚀 Package Installer launched!\nTap 'Update' on the system prompt to complete installation."
            Toast.makeText(context, "Tap 'Update' on the Android system installer prompt", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Log.e("AppUpdater", "Failed to launch package installer", e)
            Toast.makeText(context, "Error opening package installer: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
        }
    }

    fun restartAppProcess() {
        try {
            val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
            if (intent != null) {
                context.startActivity(intent)
            }
            Runtime.getRuntime().exit(0)
        } catch (_: Exception) {
            System.exit(0)
        }
    }

    AlertDialog(
        onDismissRequest = { if (!isDownloading) onDismiss() },
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)),
        containerColor = Color(0xFF0F172A),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.NewReleases, contentDescription = null, tint = TelegramEmerald, modifier = Modifier.size(28.dp))
                Spacer(modifier = Modifier.width(10.dp))
                Text(
                    "New Update Available! 🚀",
                    style = MaterialTheme.typography.titleMedium.copy(color = Color.White, fontWeight = FontWeight.Bold)
                )
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Version ${versionInfo.versionName} is ready to install directly inside the app:",
                    style = MaterialTheme.typography.bodySmall.copy(color = Color.White.copy(alpha = 0.8f))
                )

                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("✨ What's New:", style = MaterialTheme.typography.labelSmall.copy(color = TelegramBlue, fontWeight = FontWeight.Bold))
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(versionInfo.releaseNotes, style = MaterialTheme.typography.bodySmall.copy(color = Color.White))
                    }
                }

                if (isDownloading || isInstallerLaunched) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        downloadStatusText,
                        style = MaterialTheme.typography.bodySmall.copy(color = if (isInstallerLaunched) TelegramEmerald else Color.White, fontWeight = FontWeight.Bold)
                    )
                    if (isDownloading) {
                        LinearProgressIndicator(
                            progress = { downloadProgress },
                            modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                            color = TelegramEmerald,
                            trackColor = Color.White.copy(alpha = 0.2f)
                        )
                    }
                    if (isInstallerLaunched) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            "💡 Tip: If installer closes without updating, uninstall your previous build once so the new signature key takes effect! All future updates will update with 1 tap.",
                            style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.6f))
                        )
                    }
                }
            }
        },
        confirmButton = {
            if (isInstallerLaunched) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Button(
                        onClick = { restartAppProcess() },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue)
                    ) {
                        Text("⚡ Restart App Now", fontWeight = FontWeight.Bold)
                    }
                }
            } else {
                Button(
                    onClick = {
                        if (isDownloading) return@Button
                        isDownloading = true
                        downloadStatusText = "Connecting to update server..."

                        scope.launch(Dispatchers.IO) {
                            try {
                                val client = HttpClientProvider.client
                                val req = Request.Builder().url(versionInfo.downloadUrl).build()
                                val res = client.newCall(req).execute()

                                val body = res.body
                                if (!res.isSuccessful || body == null) {
                                    withContext(Dispatchers.Main) {
                                        isDownloading = false
                                        Toast.makeText(context, "Download failed (HTTP ${res.code}). Server error or URL issue.", Toast.LENGTH_LONG).show()
                                    }
                                    return@launch
                                }

                                val totalBytes = body.contentLength()
                                val downloadsDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.cacheDir
                                val updateFile = File(downloadsDir, "TelegramBackup_${versionInfo.versionName}.apk")

                                body.byteStream().use { input ->
                                    FileOutputStream(updateFile).use { output ->
                                        val buffer = ByteArray(8192)
                                        var bytesRead: Int
                                        var downloadedBytes = 0L

                                        while (input.read(buffer).also { bytesRead = it } != -1) {
                                            output.write(buffer, 0, bytesRead)
                                            downloadedBytes += bytesRead

                                            if (totalBytes > 0) {
                                                val progress = downloadedBytes.toFloat() / totalBytes.toFloat()
                                                val mbDownloaded = downloadedBytes / (1024 * 1024)
                                                val mbTotal = totalBytes / (1024 * 1024)
                                                withContext(Dispatchers.Main) {
                                                    downloadProgress = progress
                                                    downloadStatusText = "Downloading update... $mbDownloaded MB / $mbTotal MB (${(progress * 100).toInt()}%)"
                                                }
                                            }
                                        }
                                        output.flush()
                                    }
                                }

                                withContext(Dispatchers.Main) {
                                    isDownloading = false
                                    downloadedApkFile = updateFile
                                    downloadStatusText = "Opening Package Installer..."
                                    installApk(updateFile)
                                }
                            } catch (e: Exception) {
                                withContext(Dispatchers.Main) {
                                    isDownloading = false
                                    Toast.makeText(context, "Download error: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
                                }
                            }
                        }
                    },
                    enabled = !isDownloading,
                    colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald)
                ) {
                    if (isDownloading) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                    } else {
                        Text("🚀 Update Now", fontWeight = FontWeight.Bold)
                    }
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!isDownloading) onDismiss() }) {
                Text(if (isInstallerLaunched) "Close" else "Later", color = Color.White.copy(alpha = 0.7f))
            }
        }
    )
}
