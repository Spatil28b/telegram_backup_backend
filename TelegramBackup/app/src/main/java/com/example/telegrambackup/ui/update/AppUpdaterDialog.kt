package com.example.telegrambackup.ui.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.NewReleases
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SystemUpdate
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
import java.util.Locale

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

    fun openApkFileManually(apkFile: File) {
        try {
            apkFile.setReadable(true, false)
            val apkUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
            val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newRawUri("TelegramBackupUpdate", apkUri)
            }
            val chooser = Intent.createChooser(viewIntent, "Install update with...")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(chooser)
        } catch (e: Exception) {
            Toast.makeText(context, "Error: ${e.localizedMessage}. File at: ${apkFile.absolutePath}", Toast.LENGTH_LONG).show()
        }
    }

    fun triggerInstallation(apkFile: File) {
        try {
            if (!apkFile.exists() || apkFile.length() == 0L) {
                Toast.makeText(context, "Downloaded update APK is missing or empty.", Toast.LENGTH_LONG).show()
                return
            }

            // Verify package archive integrity
            val pm = context.packageManager
            val pkgInfo = try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    pm.getPackageArchiveInfo(apkFile.absolutePath, PackageManager.PackageInfoFlags.of(0))
                } else {
                    @Suppress("DEPRECATION")
                    pm.getPackageArchiveInfo(apkFile.absolutePath, 0)
                }
            } catch (_: Exception) { null }

            if (pkgInfo == null) {
                downloadStatusText = "⚠️ Downloaded APK is incomplete or corrupted. Please try updating again."
                Toast.makeText(context, "Downloaded file is corrupted or not a valid APK.", Toast.LENGTH_LONG).show()
                return
            }

            apkFile.setReadable(true, false)
            val apkUri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                clipData = ClipData.newRawUri("TelegramBackupUpdate", apkUri)
            }

            val resInfoList = context.packageManager.queryIntentActivities(installIntent, PackageManager.MATCH_DEFAULT_ONLY)
            for (resolveInfo in resInfoList) {
                val packageName = resolveInfo.activityInfo.packageName
                context.grantUriPermission(packageName, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            context.startActivity(installIntent)
            isInstallerLaunched = true
            downloadStatusText = "🚀 Package Installer launched!\nTap 'Update' on the Android system prompt to finish."
            Toast.makeText(context, "Tap 'Update' on the Android installer prompt", Toast.LENGTH_LONG).show()
            Log.d("AppUpdater", "Launched FileProvider install Intent successfully with URI: $apkUri")
        } catch (e: Exception) {
            Log.e("AppUpdater", "FileProvider install failed: ${e.message}", e)
            Toast.makeText(context, "Launching default installer failed. Trying chooser...", Toast.LENGTH_SHORT).show()
            openApkFileManually(apkFile)
        }
    }

    val unknownAppSourcesLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (context.packageManager.canRequestPackageInstalls()) {
                downloadedApkFile?.let { apk ->
                    triggerInstallation(apk)
                }
            } else {
                Toast.makeText(context, "Permission to install unknown apps was not granted.", Toast.LENGTH_LONG).show()
                downloadStatusText = "⚠️ Unknown app installation permission required to proceed."
            }
        }
    }

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
                    }
                    unknownAppSourcesLauncher.launch(settingsIntent)
                    return
                }
            }

            triggerInstallation(apkFile)
        } catch (e: Exception) {
            Log.e("AppUpdater", "Failed to launch package installer", e)
            Toast.makeText(context, "Error opening package installer: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
        }
    }

    fun copyToDownloads(apkFile: File) {
        try {
            val publicDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            if (!publicDir.exists()) publicDir.mkdirs()
            val destFile = File(publicDir, "TelegramBackup_v${versionInfo.versionName}.apk")
            apkFile.copyTo(destFile, overwrite = true)
            Toast.makeText(context, "Saved to Downloads: ${destFile.name}", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Could not save to Downloads: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
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

                if (isDownloading || isInstallerLaunched || downloadedApkFile != null) {
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
                }
            }
        },
        confirmButton = {
            if (downloadedApkFile != null) {
                Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { installApk(downloadedApkFile!!) },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald)
                        ) {
                            Icon(Icons.Default.SystemUpdate, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Install Now", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        }
                        OutlinedButton(
                            onClick = { openApkFileManually(downloadedApkFile!!) },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)
                        ) {
                            Icon(Icons.Default.FolderOpen, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Open File", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        }
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { copyToDownloads(downloadedApkFile!!) },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White.copy(alpha = 0.8f))
                        ) {
                            Icon(Icons.Default.Download, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("To Downloads", fontSize = 12.sp)
                        }
                        Button(
                            onClick = { restartAppProcess() },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue)
                        ) {
                            Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("⚡ Restart", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        }
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
                                        downloadStatusText = "❌ Download failed (HTTP ${res.code})"
                                    }
                                    return@launch
                                }

                                val totalBytes = body.contentLength()
                                val updateDir = File(context.cacheDir, "updates").apply { mkdirs() }
                                val updateFile = File(updateDir, "TelegramBackup_v${versionInfo.versionName}.apk")
                                if (updateFile.exists()) {
                                    updateFile.delete()
                                }

                                body.byteStream().use { input ->
                                    FileOutputStream(updateFile).use { output ->
                                        val buffer = ByteArray(16384)
                                        var bytesRead: Int
                                        var downloadedBytes = 0L

                                        while (input.read(buffer).also { bytesRead = it } != -1) {
                                            output.write(buffer, 0, bytesRead)
                                            downloadedBytes += bytesRead

                                            if (totalBytes > 0) {
                                                val progress = downloadedBytes.toFloat() / totalBytes.toFloat()
                                                val mbDownloaded = String.format(Locale.US, "%.1f", downloadedBytes / (1024f * 1024f))
                                                val mbTotal = String.format(Locale.US, "%.1f", totalBytes / (1024f * 1024f))
                                                withContext(Dispatchers.Main) {
                                                    downloadProgress = progress
                                                    downloadStatusText = "Downloading update... $mbDownloaded MB / $mbTotal MB (${(progress * 100).toInt()}%)"
                                                }
                                            } else {
                                                val mbDownloaded = String.format(Locale.US, "%.1f", downloadedBytes / (1024f * 1024f))
                                                withContext(Dispatchers.Main) {
                                                    downloadStatusText = "Downloading update... $mbDownloaded MB"
                                                }
                                            }
                                        }
                                        output.flush()
                                    }
                                }

                                withContext(Dispatchers.Main) {
                                    isDownloading = false
                                    downloadedApkFile = updateFile
                                    downloadStatusText = "Verifying package & opening installer..."
                                    installApk(updateFile)
                                }
                            } catch (e: Exception) {
                                withContext(Dispatchers.Main) {
                                    isDownloading = false
                                    Toast.makeText(context, "Download error: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
                                    downloadStatusText = "❌ Download error: ${e.localizedMessage}"
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
                Text(if (isInstallerLaunched || downloadedApkFile != null) "Close" else "Later", color = Color.White.copy(alpha = 0.7f))
            }
        }
    )
}
