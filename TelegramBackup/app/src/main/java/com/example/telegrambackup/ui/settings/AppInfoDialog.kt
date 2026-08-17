package com.example.telegrambackup.ui.settings

import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.telegrambackup.R
import com.example.telegrambackup.network.ServerApi
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.theme.TelegramEmerald
import com.example.telegrambackup.ui.update.AppUpdaterDialog
import com.example.telegrambackup.ui.update.AppVersionInfo
import com.example.telegrambackup.utils.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppInfoDialog(
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { AppPrefs(context) }

    var isCheckingUpdate by remember { mutableStateOf(false) }
    var updateInfoAvailable by remember { mutableStateOf<AppVersionInfo?>(null) }
    var upToDateText by remember { mutableStateOf("") }

    val currentAppInfo = remember {
        try {
            val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
            val code = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) pkg.longVersionCode.toInt() else @Suppress("DEPRECATION") pkg.versionCode
            Pair(pkg.versionName ?: "2.1.15", if (code > 0) code else 18)
        } catch (_: Exception) { Pair("2.1.15", 18) }
    }

    if (updateInfoAvailable != null) {
        AppUpdaterDialog(
            versionInfo = updateInfoAvailable!!,
            onDismiss = { updateInfoAvailable = null }
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)),
        containerColor = Color(0xFF0F172A),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(36.dp).clip(CircleShape).background(TelegramBlue),
                    contentAlignment = Alignment.Center
                ) {
                    Image(
                        painter = painterResource(id = R.drawable.app_logo),
                        contentDescription = "App Logo",
                        modifier = Modifier.size(24.dp)
                    )
                }
                Spacer(modifier = Modifier.width(10.dp))
                Column {
                    Text(
                        "Telegram Backup",
                        style = MaterialTheme.typography.titleMedium.copy(color = Color.White, fontWeight = FontWeight.Bold)
                    )
                    Text(
                        "App Info & Update Center",
                        style = MaterialTheme.typography.labelSmall.copy(color = TelegramEmerald)
                    )
                }
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Installed Version:", style = MaterialTheme.typography.labelMedium.copy(color = Color.White.copy(alpha = 0.7f)))
                            Text("v${currentAppInfo.first} (Build ${currentAppInfo.second})", style = MaterialTheme.typography.labelMedium.copy(color = Color.White, fontWeight = FontWeight.Bold))
                        }
                        HorizontalDivider(color = Color.White.copy(alpha = 0.1f))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Architecture:", style = MaterialTheme.typography.labelMedium.copy(color = Color.White.copy(alpha = 0.7f)))
                            Text("Jetpack Compose 36", style = MaterialTheme.typography.labelMedium.copy(color = TelegramBlue, fontWeight = FontWeight.Bold))
                        }
                        HorizontalDivider(color = Color.White.copy(alpha = 0.1f))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Encryption Engine:", style = MaterialTheme.typography.labelMedium.copy(color = Color.White.copy(alpha = 0.7f)))
                            Text("AES-256 Zero-Knowledge", style = MaterialTheme.typography.labelMedium.copy(color = TelegramEmerald, fontWeight = FontWeight.Bold))
                        }
                        HorizontalDivider(color = Color.White.copy(alpha = 0.1f))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Cloud Server:", style = MaterialTheme.typography.labelMedium.copy(color = Color.White.copy(alpha = 0.7f)))
                            Text("Vercel & Neon DB", style = MaterialTheme.typography.labelMedium.copy(color = Color.White, fontWeight = FontWeight.Bold))
                        }
                    }
                }

                if (upToDateText.isNotEmpty()) {
                    Text(
                        upToDateText,
                        style = MaterialTheme.typography.bodySmall.copy(color = TelegramEmerald, fontWeight = FontWeight.Bold)
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (isCheckingUpdate) return@Button
                    isCheckingUpdate = true
                    upToDateText = "Checking online server for updates..."
                    scope.launch(Dispatchers.IO) {
                        val serverUrl = prefs.serverUrl.ifEmpty { "https://telegram-backup-backend.vercel.app" }
                        val versionInfo = ServerApi().getLatestAppVersion(serverUrl)
                        withContext(Dispatchers.Main) {
                            isCheckingUpdate = false
                            val isNewerVersionCode = versionInfo.versionCode > currentAppInfo.second
                            val isNewerSemVer = com.example.telegrambackup.utils.SemVerUtils.isServerVersionNewer(versionInfo.versionName, currentAppInfo.first)
                            if (versionInfo.success && (isNewerVersionCode || isNewerSemVer) && versionInfo.downloadUrl.isNotEmpty()) {
                                updateInfoAvailable = versionInfo
                                upToDateText = ""
                            } else {
                                upToDateText = "✅ Your app is fully up to date! (v${currentAppInfo.first})"
                            }
                        }
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue)
            ) {
                if (isCheckingUpdate) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Default.SystemUpdate, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Check for Updates", fontWeight = FontWeight.Bold)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Close", color = Color.White.copy(alpha = 0.7f))
            }
        }
    )
}
