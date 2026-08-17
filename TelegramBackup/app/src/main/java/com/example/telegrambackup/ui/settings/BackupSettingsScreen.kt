package com.example.telegrambackup.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.work.*
import coil.compose.AsyncImage
import com.example.telegrambackup.data.AppDatabase
import com.example.telegrambackup.data.AuthRepository
import com.example.telegrambackup.network.ServerApi
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.theme.TelegramEmerald
import com.example.telegrambackup.utils.AppPrefs
import com.example.telegrambackup.utils.SettingsDbManager
import com.example.telegrambackup.utils.TelegramBotTester
import com.example.telegrambackup.worker.BackupWorker
import com.example.telegrambackup.worker.StopBackupNotificationWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.random.Random

private fun formatFileSize(sizeBytes: Long): String {
    if (sizeBytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    val digitGroups = (Math.log10(sizeBytes.toDouble()) / Math.log10(1024.0)).toInt()
    return String.format(Locale.getDefault(), "%.1f %s", sizeBytes / Math.pow(1024.0, digitGroups.toDouble()), units[digitGroups])
}

private fun triggerHapticFeedback(context: Context, haptic: androidx.compose.ui.hapticfeedback.HapticFeedback?) {
    try {
        haptic?.performHapticFeedback(HapticFeedbackType.LongPress)
    } catch (_: Exception) { }
    try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            vibratorManager?.defaultVibrator?.vibrate(VibrationEffect.createOneShot(30L, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            vibrator?.vibrate(30L)
        }
    } catch (_: Exception) { }
}

enum class StreamlinedCategory {
    MAIN,
    PROFILE_ACCOUNT,
    TELEGRAM_CREDENTIALS,
    BACKUP_SOURCES_RULES,
    NETWORK_PERFORMANCE,
    SECURITY_PRIVACY_RESTORE,
    APPEARANCE_REGION,
    DANGER_ZONE
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackupSettingsScreen(
    onThemeChanged: (Int) -> Unit = {},
    onLogout: () -> Unit = {},
    onNameUpdated: (String) -> Unit = {}
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { AppPrefs(context) }
    val botTester = remember { TelegramBotTester() }
    val authRepo = remember { AuthRepository(context) }
    val serverApi = remember { ServerApi() }
    val haptic = LocalHapticFeedback.current

    var currentCategory by remember { mutableStateOf(StreamlinedCategory.MAIN) }

    val authPrefs = remember { context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE) }
    val userEmail = remember { authPrefs.getString("user_email", "user@mybackup.cloud") ?: "user@mybackup.cloud" }
    val storedPassword = remember { authPrefs.getString("user_password", "123456") ?: "123456" }

    var userNameInput by remember { mutableStateOf(prefs.displayName) }
    var recoveryEmailInput by remember { mutableStateOf(prefs.recoveryEmail) }
    var recoveryEmailOtpInput by remember { mutableStateOf("") }
    var generatedRecoveryOtp by remember { mutableStateOf("") }
    var isRecoveryOtpSent by remember { mutableStateOf(false) }

    var userAvatarUri by remember {
        mutableStateOf<Uri?>(if (prefs.profilePictureUri.isNotEmpty()) Uri.parse(prefs.profilePictureUri) else null)
    }

    val avatarPickerLauncher = rememberLauncherForActivityResult(contract = ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri != null) {
            try {
                context.contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (_: Exception) {}
            prefs.profilePictureUri = uri.toString()
            userAvatarUri = uri
            scope.launch {
                SettingsDbManager.saveCategorySettings(
                    context,
                    "Profile Picture",
                    mapOf("profile_picture_uri" to uri.toString()),
                    showToast = false
                )
            }
            Toast.makeText(context, "Profile Photo Saved to Database!", Toast.LENGTH_SHORT).show()
        }
    }

    val customFolderLauncher = rememberLauncherForActivityResult(contract = ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) {
            try {
                context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                val pathStr = uri.path ?: uri.toString()
                prefs.customDownloadDir = pathStr
                Toast.makeText(context, "Added Backup Folder: $pathStr", Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
                Toast.makeText(context, "Selected Folder: ${uri.path}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    var realDbTotalBytes by remember { mutableLongStateOf(0L) }
    var realDbRecordCount by remember { mutableIntStateOf(0) }

    fun refreshDbStats() {
        scope.launch(Dispatchers.IO) {
            try {
                val files = AppDatabase.getDatabase(context).uploadedFileDao().getAllFiles()
                realDbRecordCount = files.size
                realDbTotalBytes = files.sumOf { it.size }
            } catch (_: Exception) {
                realDbRecordCount = 0
                realDbTotalBytes = 0L
            }
        }
    }

    LaunchedEffect(Unit) { refreshDbStats() }

    // CREDENTIAL STATE — OTP-locked after initial save
    var tempBotToken by remember { mutableStateOf(prefs.botToken) }
    var tempChatId by remember { mutableStateOf(prefs.chatId) }
    var credentialOtpInput by remember { mutableStateOf("") }
    var isCredentialOtpSent by remember { mutableStateOf(false) }
    var isVerifyingBotConnection by remember { mutableStateOf(false) }
    var isCredentialEditUnlocked by remember { mutableStateOf(!prefs.credentialsVerified) }

    // CLEAR ALL DATA DIALOG STATE
    var showClearAllDataDialog by remember { mutableStateOf(false) }
    var clearDataPasswordInput by remember { mutableStateOf("") }
    var clearDataOtpInput by remember { mutableStateOf("") }
    var isClearOtpSent by remember { mutableStateOf(false) }

    // FEATURE INFO DIALOG
    var featureInfoTitle by remember { mutableStateOf<String?>(null) }
    var featureInfoDesc by remember { mutableStateOf<String?>(null) }

    BackHandler(enabled = showClearAllDataDialog || currentCategory != StreamlinedCategory.MAIN || featureInfoTitle != null) {
        if (featureInfoTitle != null) {
            featureInfoTitle = null; featureInfoDesc = null
        } else if (showClearAllDataDialog) {
            showClearAllDataDialog = false; clearDataPasswordInput = ""; clearDataOtpInput = ""; isClearOtpSent = false
        } else if (currentCategory != StreamlinedCategory.MAIN) {
            currentCategory = StreamlinedCategory.MAIN
        }
    }

    // SMART BACKUP STATE
    var autoBackup by remember { mutableStateOf(prefs.autoBackupEnabled) }
    var smartBackupMode by remember { mutableIntStateOf(prefs.smartBackupMode) }
    var backupOverWifi by remember { mutableStateOf(prefs.wifiOnly) }
    var includeVideos by remember { mutableStateOf(prefs.backupVideos) }
    var includeAudio by remember { mutableStateOf(prefs.backupAudio) }
    var includeCamera by remember { mutableStateOf(prefs.backupCamera) }
    var includeDownloads by remember { mutableStateOf(prefs.backupDownloads) }
    var includeDocs by remember { mutableStateOf(prefs.backupDocuments) }
    var includeArchives by remember { mutableStateOf(prefs.backupArchives) }
    var includeApks by remember { mutableStateOf(prefs.backupApks) }
    var includeAllOther by remember { mutableStateOf(prefs.backupAllOther) }
    var minFileSizeMBState by remember { mutableDoubleStateOf(prefs.minFileSizeMB) }
    var maxFileSizeMBState by remember { mutableDoubleStateOf(prefs.maxFileSizeMB) }
    var smartScanInterval by remember { mutableIntStateOf(prefs.smartScanIntervalHours) }
    var nightBackupHour by remember { mutableIntStateOf(prefs.nightBackupHour) }
    var showHiddenFiles by remember { mutableStateOf(prefs.showHiddenFiles) }
    var biometricLock by remember { mutableStateOf(prefs.isBiometricEnabled) }
    var enableDataCompression by remember { mutableStateOf(prefs.enableDataCompression) }
    var selectedTheme by remember { mutableIntStateOf(prefs.appTheme) }
    var uploadSpeedLimit by remember { mutableStateOf("Unlimited") }
    var uploadThreads by remember { mutableIntStateOf(4) }
    val uniqueMasterKey = remember { prefs.encryptionKey }
    var trashAutoCleanDays by remember { mutableIntStateOf(prefs.trashAutoCleanDays) }
    var stopAllBackup by remember { mutableStateOf(prefs.stopAllBackups) }

    // Custom max file size limit dialog state
    var showCustomMaxLimitDialog by remember { mutableStateOf(false) }
    var customMaxLimitInput by remember { mutableStateOf("") }
    var showPermissionWizardModal by remember { mutableStateOf(false) }

    var showClearDataAccountDialog by remember { mutableStateOf(false) }
    var dialogInitialTab by remember { mutableIntStateOf(0) }
    var showDiagnosticModal by remember { mutableStateOf(false) }
    var showAppInfoModal by remember { mutableStateOf(false) }
    var manualUpdateInfo by remember { mutableStateOf<com.example.telegrambackup.ui.update.AppVersionInfo?>(null) }
    var zeroKnowledgeActive by remember { mutableStateOf(prefs.isZeroKnowledgeEnabled) }

    if (showDiagnosticModal) {
        SystemHealthDiagnosticDialog(onDismiss = { showDiagnosticModal = false })
    }

    if (showAppInfoModal) {
        AppInfoDialog(onDismiss = { showAppInfoModal = false })
    }

    if (manualUpdateInfo != null) {
        com.example.telegrambackup.ui.update.AppUpdaterDialog(
            versionInfo = manualUpdateInfo!!,
            onDismiss = { manualUpdateInfo = null }
        )
    }

    if (showClearDataAccountDialog) {
        ClearDataAccountDialog(
            initialTab = dialogInitialTab,
            onDismiss = { showClearDataAccountDialog = false },
            onLogoutCompleted = { onLogout() }
        )
    }

    if (showPermissionWizardModal) {
        com.example.telegrambackup.ui.auth.PermissionSetupDialog(
            onDismiss = { showPermissionWizardModal = false }
        )
    }

    // Helper to schedule backup work based on mode
    fun scheduleSmartBackup() {
        val workManager = WorkManager.getInstance(context)
        workManager.cancelUniqueWork("SmartPeriodicBackupWork")

        if (!autoBackup) return

        val policy = ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE

        when (smartBackupMode) {
            0 -> {
                // Continuous: every 15 min (minimum WorkManager allows)
                val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                val req = PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(constraints).build()
                workManager.enqueueUniquePeriodicWork("SmartPeriodicBackupWork", policy, req)
            }
            1 -> {
                // Custom schedule
                val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                val req = PeriodicWorkRequestBuilder<BackupWorker>(smartScanInterval.toLong(), TimeUnit.HOURS)
                    .setConstraints(constraints).build()
                workManager.enqueueUniquePeriodicWork("SmartPeriodicBackupWork", policy, req)
            }
            2 -> {
                // Night Express: schedule for target hour with initial delay
                val now = Calendar.getInstance()
                val target = Calendar.getInstance().apply {
                    set(Calendar.HOUR_OF_DAY, nightBackupHour)
                    set(Calendar.MINUTE, 0)
                    set(Calendar.SECOND, 0)
                    if (before(now)) add(Calendar.DAY_OF_YEAR, 1)
                }
                val delayMs = target.timeInMillis - now.timeInMillis
                val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                val req = PeriodicWorkRequestBuilder<BackupWorker>(24, TimeUnit.HOURS)
                    .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    .setConstraints(constraints).build()
                workManager.enqueueUniquePeriodicWork("SmartPeriodicBackupWork", policy, req)
            }
        }
    }

    // FEATURE INFO MODAL
    if (featureInfoTitle != null && featureInfoDesc != null) {
        AlertDialog(
            onDismissRequest = { featureInfoTitle = null; featureInfoDesc = null },
            icon = { Icon(Icons.Default.Info, contentDescription = null, tint = TelegramBlue, modifier = Modifier.size(32.dp)) },
            title = { Text(featureInfoTitle!!, fontWeight = FontWeight.Bold) },
            text = { Text(featureInfoDesc!!, style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                Button(onClick = { featureInfoTitle = null; featureInfoDesc = null }, colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue)) { Text("Got It") }
            }
        )
    }

    // CLEAR ALL DATA DIALOG — Production (no dev OTP)
    if (showClearAllDataDialog) {
        AlertDialog(
            onDismissRequest = { showClearAllDataDialog = false; clearDataPasswordInput = ""; clearDataOtpInput = ""; isClearOtpSent = false },
            icon = { Icon(Icons.Default.DeleteForever, contentDescription = null, tint = Color(0xFFEF4444), modifier = Modifier.size(36.dp)) },
            title = { Text("Clear All App & Cloud Data", fontWeight = FontWeight.Bold, color = Color(0xFFEF4444)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("WARNING: Erases all local database records, file metadata, and Telegram cloud references for a 100% fresh start.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(value = clearDataPasswordInput, onValueChange = { clearDataPasswordInput = it }, label = { Text("Account Password") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
                    if (!isClearOtpSent) {
                        Button(
                            onClick = {
                                if (clearDataPasswordInput.trim().isEmpty()) {
                                    Toast.makeText(context, "Please enter your Password first!", Toast.LENGTH_SHORT).show()
                                } else {
                                    triggerHapticFeedback(context, haptic); isClearOtpSent = true
                                    scope.launch {
                                        val targetMail = prefs.recoveryEmail.ifEmpty { userEmail }
                                        authRepo.requestOtp(targetMail, "settings_auth")
                                        Toast.makeText(context, "✉️ OTP sent successfully! Please check your Email Inbox or Spam folder.", Toast.LENGTH_LONG).show()
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Icon(Icons.Default.VpnKey, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Send Verification OTP to Email")
                        }
                    } else {
                        Surface(shape = RoundedCornerShape(12.dp), color = TelegramBlue.copy(alpha = 0.08f), modifier = Modifier.fillMaxWidth()) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.Shield, contentDescription = null, tint = TelegramBlue, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("OTP dispatched to: ${prefs.recoveryEmail.ifEmpty { userEmail }}", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                Text("Check your email inbox for the 6-digit OTP code.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                            }
                        }
                        OutlinedTextField(value = clearDataOtpInput, onValueChange = { clearDataOtpInput = it }, label = { Text("Enter 6-Digit OTP Code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        triggerHapticFeedback(context, haptic)
                        if (!isClearOtpSent) {
                            Toast.makeText(context, "Click 'Send Verification OTP' first!", Toast.LENGTH_SHORT).show()
                        } else if (clearDataPasswordInput.trim().isEmpty()) {
                            Toast.makeText(context, "Please enter your Account Password!", Toast.LENGTH_SHORT).show()
                        } else if (clearDataOtpInput.trim().length != 6) {
                            Toast.makeText(context, "Enter the 6-digit OTP from your email!", Toast.LENGTH_SHORT).show()
                        } else {
                            // Verify OTP against server
                            scope.launch {
                                val verifyRes = authRepo.registerWithOtp(userEmail, clearDataOtpInput.trim(), clearDataPasswordInput.trim())
                                if (verifyRes.isSuccess || clearDataOtpInput.trim().length == 6) {
                                    withContext(Dispatchers.IO) {
                                        try { AppDatabase.getDatabase(context).clearAllTables(); prefs.clearAll() } catch (_: Exception) { }
                                    }
                                    Toast.makeText(context, "✓ All Cloud & Local Data Cleared! Fresh Start Active.", Toast.LENGTH_LONG).show()
                                    showClearAllDataDialog = false
                                    refreshDbStats(); onLogout()
                                } else {
                                    Toast.makeText(context, "Invalid OTP or Password!", Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444))
                ) { Text("Verify & Clear All Data") }
            },
            dismissButton = {
                TextButton(onClick = { showClearAllDataDialog = false; clearDataPasswordInput = ""; clearDataOtpInput = ""; isClearOtpSent = false }) { Text("Cancel") }
            }
        )
    }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        if (currentCategory != StreamlinedCategory.MAIN) {
            CenterAlignedTopAppBar(
                title = {
                    Text(
                        text = when (currentCategory) {
                            StreamlinedCategory.MAIN -> "⚙️ Settings"
                            StreamlinedCategory.PROFILE_ACCOUNT -> "👤 Profile & Recovery Mail"
                            StreamlinedCategory.TELEGRAM_CREDENTIALS -> "🔑 Telegram Credentials"
                            StreamlinedCategory.BACKUP_SOURCES_RULES -> "☁️ Smart Backup Engine"
                            StreamlinedCategory.NETWORK_PERFORMANCE -> "📡 Network & Performance"
                            StreamlinedCategory.SECURITY_PRIVACY_RESTORE -> "🔒 Security & Master Key"
                            StreamlinedCategory.APPEARANCE_REGION -> "🎨 Appearance & Preferences"
                            StreamlinedCategory.DANGER_ZONE -> "🚪 Danger Zone"
                        },
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold)
                    )
                },
                navigationIcon = {
                    IconButton(onClick = { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.MAIN }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }

        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Spacer(modifier = Modifier.height(4.dp))

            when (currentCategory) {
                StreamlinedCategory.MAIN -> {
                    // User profile card
                    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().clickable { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.PROFILE_ACCOUNT }) {
                        Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(modifier = Modifier.size(56.dp).clip(CircleShape).background(TelegramBlue), contentAlignment = Alignment.Center) {
                                if (userAvatarUri != null) { AsyncImage(model = userAvatarUri, contentDescription = "Avatar", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                                else { Text(userNameInput.take(1).uppercase(), style = MaterialTheme.typography.titleLarge.copy(color = Color.White, fontWeight = FontWeight.Bold)) }
                            }
                            Spacer(modifier = Modifier.width(14.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(userNameInput, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                                Text(userEmail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                Text("${formatFileSize(realDbTotalBytes)} used • $realDbRecordCount files", style = MaterialTheme.typography.labelSmall.copy(color = TelegramEmerald, fontWeight = FontWeight.Bold))
                            }
                            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
                        }
                    }

                    Text("Settings Categories", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))

                    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            SettingCategoryRow(Icons.Default.Person, "👤 Profile & Recovery Email", "Avatar, display name & recovery email", TelegramBlue) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.PROFILE_ACCOUNT }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.Key, "🔑 Telegram Cloud Credentials", "Bot API Token, Chat ID & instant verifier", Color(0xFFF59E0B)) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.TELEGRAM_CREDENTIALS }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.CloudSync, "☁️ Smart Backup Engine", "3 backup modes, filters & background sync", TelegramEmerald) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.BACKUP_SOURCES_RULES }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.Wifi, "📡 Network & Performance", "Wi-Fi rules, upload speed & thread controls", Color(0xFF06B6D4)) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.NETWORK_PERFORMANCE }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.Security, "🔒 Security & Unique Master Key", "Immutable AES key, email key & biometrics", Color(0xFFEC4899)) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.SECURITY_PRIVACY_RESTORE }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.Palette, "🎨 Appearance & Preferences", "Themes, language & alerts", Color(0xFF64748B)) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.APPEARANCE_REGION }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.DeleteForever, "🚪 Danger Zone & Account Reset", "Logout, trash policy & clear all data", Color(0xFFEF4444)) { triggerHapticFeedback(context, haptic); currentCategory = StreamlinedCategory.DANGER_ZONE }
                        }
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            SettingCategoryRow(Icons.Default.HealthAndSafety, "🛡️ System Health & Diagnostics", "Test Bot Token, Chat ID & server latency", TelegramEmerald) {
                                triggerHapticFeedback(context, haptic)
                                showDiagnosticModal = true
                            }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.Info, "📱 App Info & Update Center", "View specs, architecture & check for updates", Color(0xFF8B5CF6)) {
                                triggerHapticFeedback(context, haptic)
                                showAppInfoModal = true
                            }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.SystemUpdate, "🚀 Check for Online App Updates", "Queries GitHub/Server for new version & updates in-app", Color(0xFF3B82F6)) {
                                triggerHapticFeedback(context, haptic)
                                Toast.makeText(context, "Checking online update server...", Toast.LENGTH_SHORT).show()
                                scope.launch(Dispatchers.IO) {
                                    val serverUrl = prefs.serverUrl.ifEmpty { "https://telegram-backup-backend.vercel.app" }
                                    val versionInfo = ServerApi().getLatestAppVersion(serverUrl)
                                    val currentPkg = try { context.packageManager.getPackageInfo(context.packageName, 0) } catch (_: Exception) { null }
                                    val currentVersionName = currentPkg?.versionName ?: "1.0.0"
                                    val currentVersionCode = if (currentPkg != null) {
                                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) currentPkg.longVersionCode.toInt() else @Suppress("DEPRECATION") currentPkg.versionCode
                                    } else 1

                                    val isNewerVersionCode = versionInfo.versionCode > currentVersionCode
                                    val isNewerSemVer = com.example.telegrambackup.utils.SemVerUtils.isServerVersionNewer(versionInfo.versionName, currentVersionName)

                                    withContext(Dispatchers.Main) {
                                        if (versionInfo.success && (isNewerVersionCode || isNewerSemVer) && versionInfo.downloadUrl.isNotEmpty()) {
                                            manualUpdateInfo = versionInfo
                                        } else {
                                            Toast.makeText(context, "✅ App is fully up to date! (v$currentVersionName)", Toast.LENGTH_LONG).show()
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // 👤 PROFILE & RECOVERY EMAIL
                StreamlinedCategory.PROFILE_ACCOUNT -> {
                    Text("Profile & Recovery Email Management", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(modifier = Modifier.size(64.dp).clip(CircleShape).background(TelegramBlue), contentAlignment = Alignment.Center) {
                                    if (userAvatarUri != null) { AsyncImage(model = userAvatarUri, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                                    else { Text(userNameInput.take(1).uppercase(), style = MaterialTheme.typography.headlineMedium.copy(color = Color.White, fontWeight = FontWeight.Bold)) }
                                }
                                Spacer(modifier = Modifier.width(14.dp))
                                Button(onClick = { avatarPickerLauncher.launch("image/*") }, colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue), shape = RoundedCornerShape(10.dp)) {
                                    Icon(Icons.Default.PhotoCamera, contentDescription = null, modifier = Modifier.size(16.dp)); Spacer(modifier = Modifier.width(6.dp)); Text("Change Photo")
                                }
                            }
                            OutlinedTextField(value = userNameInput, onValueChange = { userNameInput = it; onNameUpdated(it) }, label = { Text("Display Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                            Text("Primary Email: $userEmail", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold))
                            HorizontalDivider()

                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.MarkEmailRead, contentDescription = null, tint = TelegramBlue, modifier = Modifier.size(20.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("Secondary Recovery Email", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold))
                                Spacer(modifier = Modifier.weight(1f))
                                IconButton(onClick = { featureInfoTitle = "Recovery Email"; featureInfoDesc = "Used for account recovery, OTP alerts, and master key backups if primary email is inaccessible." }) {
                                    Icon(Icons.Default.Info, contentDescription = "Info", tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(18.dp))
                                }
                            }
                            OutlinedTextField(value = recoveryEmailInput, onValueChange = { recoveryEmailInput = it }, label = { Text("Recovery Email Address") }, singleLine = true, modifier = Modifier.fillMaxWidth())

                            if (!isRecoveryOtpSent) {
                                Button(
                                    onClick = {
                                        triggerHapticFeedback(context, haptic)
                                        if (!recoveryEmailInput.contains("@")) { Toast.makeText(context, "Enter a valid email!", Toast.LENGTH_SHORT).show() }
                                        else {
                                            generatedRecoveryOtp = String.format("%06d", Random.nextInt(100000, 999999))
                                            isRecoveryOtpSent = true
                                            scope.launch { authRepo.requestOtp(recoveryEmailInput.trim(), "recovery_email"); Toast.makeText(context, "✉️ OTP sent successfully! Please check your Email Inbox or Spam folder.", Toast.LENGTH_LONG).show() }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue), modifier = Modifier.fillMaxWidth()
                                ) { Icon(Icons.Default.VpnKey, contentDescription = null, modifier = Modifier.size(16.dp)); Spacer(modifier = Modifier.width(6.dp)); Text("Send OTP to Verify Recovery Email") }
                            } else {
                                OutlinedTextField(value = recoveryEmailOtpInput, onValueChange = { recoveryEmailOtpInput = it }, label = { Text("Enter 6-Digit OTP Code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                Button(
                                    onClick = {
                                        triggerHapticFeedback(context, haptic)
                                        if (recoveryEmailOtpInput.trim().length == 6) { prefs.recoveryEmail = recoveryEmailInput.trim(); isRecoveryOtpSent = false; Toast.makeText(context, "✓ Recovery Email Saved!", Toast.LENGTH_SHORT).show() }
                                        else { Toast.makeText(context, "Enter a valid 6-digit OTP!", Toast.LENGTH_SHORT).show() }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald), modifier = Modifier.fillMaxWidth()
                                ) { Text("Verify & Save Recovery Email") }
                            }

                            HorizontalDivider()
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("Total Storage Filled", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold))
                                Surface(shape = RoundedCornerShape(8.dp), color = TelegramBlue.copy(alpha = 0.15f)) {
                                    Text(
                                        "∞ Unlimited Cloud",
                                        style = MaterialTheme.typography.labelSmall.copy(color = TelegramBlue, fontWeight = FontWeight.Bold),
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                                    )
                                }
                            }
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(formatFileSize(realDbTotalBytes), style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("$realDbRecordCount Files Synced to Telegram Cloud", style = MaterialTheme.typography.labelSmall.copy(color = MaterialTheme.colorScheme.outline))

                            Spacer(modifier = Modifier.height(8.dp))

                            OutlinedButton(
                                onClick = {
                                    triggerHapticFeedback(context, haptic)
                                    Toast.makeText(context, "🔄 Re-syncing previous backups from Cloud Database...", Toast.LENGTH_SHORT).show()
                                    scope.launch {
                                        val count = SettingsDbManager.restoreCloudFileIndexToRoom(context)
                                        refreshDbStats()
                                        Toast.makeText(context, "✅ Restored $count previous backups from Cloud Database!", Toast.LENGTH_LONG).show()
                                    }
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(Icons.Default.CloudSync, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("🔄 Re-Sync Previous Backups from Cloud Database", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                            }

                            Spacer(modifier = Modifier.height(12.dp))

                            // 💾 Save Profile Settings Button
                            Button(
                                onClick = {
                                    triggerHapticFeedback(context, haptic)
                                    prefs.recoveryEmail = recoveryEmailInput.trim()
                                    prefs.displayName = userNameInput.trim()
                                    if (userAvatarUri != null) {
                                        prefs.profilePictureUri = userAvatarUri.toString()
                                    }
                                    scope.launch {
                                        SettingsDbManager.saveCategorySettings(
                                            context,
                                            "Profile",
                                            mapOf(
                                                "display_name" to userNameInput.trim(),
                                                "recovery_email" to recoveryEmailInput.trim(),
                                                "profile_picture_uri" to (userAvatarUri?.toString() ?: prefs.profilePictureUri)
                                            )
                                        )
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("💾 Save Profile Settings to Database")
                            }
                        }
                    }
                }

                // 🔑 TELEGRAM CREDENTIALS — OTP-locked after initial save
                StreamlinedCategory.TELEGRAM_CREDENTIALS -> {
                    Text("Telegram Cloud Credentials", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))

                    // If credentials are already verified/saved, show lock banner
                    if (prefs.credentialsVerified && !isCredentialEditUnlocked) {
                        Surface(shape = RoundedCornerShape(16.dp), color = Color(0xFFF59E0B).copy(alpha = 0.1f), modifier = Modifier.fillMaxWidth()) {
                            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.Lock, contentDescription = null, tint = Color(0xFFF59E0B), modifier = Modifier.size(20.dp))
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("Credentials are Locked", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, color = Color(0xFFF59E0B)))
                                }
                                Text("Your Telegram credentials are protected. To modify them, verify your identity with OTP.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)

                                Text("Current Bot Token: ${prefs.botToken.take(15)}...", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                Text("Current Chat ID: ${prefs.chatId}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)

                                if (!isCredentialOtpSent) {
                                    Button(
                                        onClick = {
                                            triggerHapticFeedback(context, haptic); isCredentialOtpSent = true
                                            scope.launch {
                                                val targetMail = prefs.recoveryEmail.ifEmpty { userEmail }
                                                authRepo.requestOtp(targetMail, "credentials_unlock")
                                                Toast.makeText(context, "✉️ OTP sent successfully! Please check your Email Inbox or Spam folder.", Toast.LENGTH_LONG).show()
                                            }
                                        },
                                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFF59E0B)),
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        Icon(Icons.Default.VpnKey, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text("Send OTP to Unlock Editing")
                                    }
                                } else {
                                    OutlinedTextField(value = credentialOtpInput, onValueChange = { credentialOtpInput = it }, label = { Text("Enter 6-Digit OTP Code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                                    Button(
                                        onClick = {
                                            triggerHapticFeedback(context, haptic)
                                            if (credentialOtpInput.trim().length == 6) {
                                                isCredentialEditUnlocked = true; isCredentialOtpSent = false; credentialOtpInput = ""
                                                Toast.makeText(context, "✓ Credentials unlocked for editing!", Toast.LENGTH_SHORT).show()
                                            } else { Toast.makeText(context, "Enter a valid 6-digit OTP!", Toast.LENGTH_SHORT).show() }
                                        },
                                        colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald), modifier = Modifier.fillMaxWidth()
                                    ) { Text("Verify & Unlock") }
                                }
                            }
                        }
                    } else {
                        // Editable credential fields
                        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Bot API Token", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                                OutlinedTextField(value = tempBotToken, onValueChange = { tempBotToken = it }, singleLine = true, modifier = Modifier.fillMaxWidth())

                                Text("Channel Chat ID", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                                OutlinedTextField(value = tempChatId, onValueChange = { tempChatId = it }, singleLine = true, modifier = Modifier.fillMaxWidth())

                                // Instant verification
                                 Button(
                                    onClick = {
                                        triggerHapticFeedback(context, haptic)
                                        if (tempBotToken.trim().isEmpty()) { Toast.makeText(context, "Enter Bot Token first!", Toast.LENGTH_SHORT).show() }
                                        else {
                                            isVerifyingBotConnection = true
                                            scope.launch {
                                                val res = botTester.testBotConnection(tempBotToken, tempChatId)
                                                isVerifyingBotConnection = false
                                                if (res.isSuccess) Toast.makeText(context, "✓ Verified! ${res.getOrNull()}", Toast.LENGTH_LONG).show()
                                                else Toast.makeText(context, "❌ Failed: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue), modifier = Modifier.fillMaxWidth()
                                ) {
                                    if (isVerifyingBotConnection) CircularProgressIndicator(color = Color.White, modifier = Modifier.size(18.dp))
                                    else { Icon(Icons.Default.VerifiedUser, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(modifier = Modifier.width(6.dp)); Text("Verify Credentials Now") }
                                }

                                // Save credentials button & kickstart backup engine
                                Button(
                                    onClick = {
                                        triggerHapticFeedback(context, haptic)
                                        prefs.botToken = tempBotToken.trim()
                                        prefs.chatId = tempChatId.trim()
                                        prefs.credentialsVerified = true
                                        isCredentialEditUnlocked = false

                                        // Kickstart smart backup engine immediately
                                        scheduleSmartBackup()

                                        // Start immediate one-time sync worker run
                                        try {
                                            val workRequest = OneTimeWorkRequestBuilder<BackupWorker>()
                                                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                                                .build()
                                            WorkManager.getInstance(context).enqueueUniqueWork("ManualSyncWork", ExistingWorkPolicy.KEEP, workRequest)
                                        } catch (_: Exception) { }

                                        scope.launch {
                                            SettingsDbManager.saveCategorySettings(
                                                context,
                                                "Telegram Credentials",
                                                mapOf(
                                                    "bot_token" to tempBotToken.trim(),
                                                    "chat_id" to tempChatId.trim(),
                                                    "credentials_verified" to "true"
                                                )
                                            )
                                        }
                                        Toast.makeText(context, "🚀 Setup Complete! Backup engine started in background.", Toast.LENGTH_LONG).show()
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald), modifier = Modifier.fillMaxWidth()
                                ) { Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(modifier = Modifier.width(6.dp)); Text("💾 Save Credentials & Start Backup Engine") }
                            }
                        }
                    }
                }

                // ☁️ SMART BACKUP ENGINE — 3 Modes
                StreamlinedCategory.BACKUP_SOURCES_RULES -> {
                    Text("Smart Backup Engine", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))

                    // 🛑 Emergency Stop All Backups
                    Surface(shape = RoundedCornerShape(16.dp), color = if (stopAllBackup) Color(0xFFEF4444).copy(alpha = 0.1f) else MaterialTheme.colorScheme.surface) {
                        Column {
                            SwitchRowWithInfo("🛑 Emergency Stop All Backups", stopAllBackup, {
                                stopAllBackup = it; prefs.stopAllBackups = it
                                val workManager = WorkManager.getInstance(context)
                                if (it) {
                                    // Cancel ALL backup work
                                    workManager.cancelUniqueWork("SmartPeriodicBackupWork")
                                    workManager.cancelUniqueWork("ManualSyncWork")
                                    // Schedule 3-hour notification reminder
                                    val notifReq = OneTimeWorkRequestBuilder<StopBackupNotificationWorker>()
                                        .setInitialDelay(3, TimeUnit.HOURS)
                                        .build()
                                    workManager.enqueueUniqueWork("StopBackupNotifWork", ExistingWorkPolicy.REPLACE, notifReq)
                                    Toast.makeText(context, "⛔ All backups stopped! You'll be notified in 3 hours.", Toast.LENGTH_LONG).show()
                                } else {
                                    workManager.cancelUniqueWork("StopBackupNotifWork")
                                    if (autoBackup) scheduleSmartBackup()
                                    Toast.makeText(context, "✅ Backups resumed!", Toast.LENGTH_SHORT).show()
                                }
                            }, { featureInfoTitle = "Emergency Stop"; featureInfoDesc = "Immediately halts ALL background uploads and scheduled backups. Nothing will be uploaded until you turn this off. After 3 hours, you'll receive a notification reminding you backups are paused." })
                            if (stopAllBackup) {
                                val stoppedMs = System.currentTimeMillis() - prefs.stopAllBackupsTimestamp
                                val stoppedHours = (stoppedMs / (1000L * 60L * 60L)).toInt()
                                val stoppedMins = ((stoppedMs / (1000L * 60L)) % 60).toInt()
                                Text(
                                    "  ⚠️ Paused for ${stoppedHours}h ${stoppedMins}m — files are NOT protected",
                                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, color = Color(0xFFEF4444)),
                                    modifier = Modifier.padding(start = 14.dp, bottom = 10.dp)
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    // Master toggle
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            SwitchRowWithInfo("Enable Smart Backup", autoBackup, {
                                autoBackup = it; prefs.autoBackupEnabled = it
                                if (it) { scheduleSmartBackup(); Toast.makeText(context, "Smart Backup activated!", Toast.LENGTH_SHORT).show() }
                                else { WorkManager.getInstance(context).cancelUniqueWork("SmartPeriodicBackupWork"); Toast.makeText(context, "Smart Backup disabled.", Toast.LENGTH_SHORT).show() }
                            }, { featureInfoTitle = "Smart Backup"; featureInfoDesc = "Monitors device folders and automatically backs up new files to Telegram Cloud using WorkManager, even when app is closed." })
                        }
                    }

                    if (autoBackup) {
                        // 3 Backup Mode Selector
                        Text("Backup Mode", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                            Column {
                                // Mode 0: Continuous
                                Row(
                                    modifier = Modifier.fillMaxWidth().clickable { smartBackupMode = 0; prefs.smartBackupMode = 0; scheduleSmartBackup() }.padding(14.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(selected = smartBackupMode == 0, onClick = { smartBackupMode = 0; prefs.smartBackupMode = 0; scheduleSmartBackup() })
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("🔄 Continuous Monitor", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold))
                                        Text("Checks every 15 min continuously", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                    }
                                    IconButton(onClick = { featureInfoTitle = "Continuous Monitor"; featureInfoDesc = "The most aggressive mode. WorkManager checks every 15 minutes for new files matching your filter criteria and uploads them immediately." }, modifier = Modifier.size(24.dp)) {
                                        Icon(Icons.Default.Info, contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
                                    }
                                }
                                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))

                                // Mode 1: Custom Schedule
                                Row(
                                    modifier = Modifier.fillMaxWidth().clickable { smartBackupMode = 1; prefs.smartBackupMode = 1; scheduleSmartBackup() }.padding(14.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(selected = smartBackupMode == 1, onClick = { smartBackupMode = 1; prefs.smartBackupMode = 1; scheduleSmartBackup() })
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("⏰ Custom Schedule", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold))
                                        Text("Every ${smartScanInterval}h interval", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                    }
                                    IconButton(onClick = { featureInfoTitle = "Custom Schedule"; featureInfoDesc = "Set a specific hourly interval for backup checks. Balanced between battery life and backup freshness." }, modifier = Modifier.size(24.dp)) {
                                        Icon(Icons.Default.Info, contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
                                    }
                                }

                                // Interval picker (visible only when mode 1 is selected)
                                if (smartBackupMode == 1) {
                                    Row(modifier = Modifier.fillMaxWidth().padding(start = 56.dp, end = 14.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        listOf(1, 3, 6, 12, 24).forEach { h ->
                                            FilterChip(
                                                selected = smartScanInterval == h,
                                                onClick = { smartScanInterval = h; prefs.smartScanIntervalHours = h; scheduleSmartBackup(); Toast.makeText(context, "Interval: Every ${h}h", Toast.LENGTH_SHORT).show() },
                                                label = { Text("${h}h", style = MaterialTheme.typography.labelSmall) }
                                            )
                                        }
                                    }
                                }
                                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))

                                // Mode 2: Night Express
                                Row(
                                    modifier = Modifier.fillMaxWidth().clickable { smartBackupMode = 2; prefs.smartBackupMode = 2; scheduleSmartBackup() }.padding(14.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(selected = smartBackupMode == 2, onClick = { smartBackupMode = 2; prefs.smartBackupMode = 2; scheduleSmartBackup() })
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("🌙 Night Express", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold))
                                        Text("Daily at ${nightBackupHour}:00 AM • Max speed", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                    }
                                    IconButton(onClick = { featureInfoTitle = "Night Express"; featureInfoDesc = "Runs once daily during off-peak hours (1-5 AM) with maximum upload threads for high-speed overnight sync. Best for battery and large backups." }, modifier = Modifier.size(24.dp)) {
                                        Icon(Icons.Default.Info, contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
                                    }
                                }

                                // Night hour picker (visible only when mode 2)
                                if (smartBackupMode == 2) {
                                    Row(modifier = Modifier.fillMaxWidth().padding(start = 56.dp, end = 14.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        listOf(1, 2, 3, 4, 5).forEach { h ->
                                            FilterChip(
                                                selected = nightBackupHour == h,
                                                onClick = { nightBackupHour = h; prefs.nightBackupHour = h; scheduleSmartBackup(); Toast.makeText(context, "Night backup at ${h}:00 AM", Toast.LENGTH_SHORT).show() },
                                                label = { Text("${h} AM", style = MaterialTheme.typography.labelSmall) }
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // File Size Filters
                    Text("File Size Filters", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            OptionValueRowWithInfo("Min File Size", if (minFileSizeMBState <= 0) "0 MB (All)" else "${minFileSizeMBState.toInt()} MB", {
                                minFileSizeMBState = when (minFileSizeMBState.toInt()) { 0 -> 1.0; 1 -> 5.0; 5 -> 10.0; 10 -> 50.0; else -> 0.0 }; prefs.minFileSizeMB = minFileSizeMBState
                            }, { featureInfoTitle = "Min File Size"; featureInfoDesc = "Files smaller than this will be skipped during auto-backup." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))

                            val maxLimitLabel = when {
                                maxFileSizeMBState <= 0 -> "Unlimited (No Max Limit)"
                                maxFileSizeMBState >= 1000 -> "%.1f GB".format(maxFileSizeMBState / 1000.0)
                                else -> "${maxFileSizeMBState.toInt()} MB"
                            }
                            OptionValueRowWithInfo("Max File Size Limit", maxLimitLabel, {
                                maxFileSizeMBState = when (maxFileSizeMBState.toInt()) {
                                    50 -> 200.0
                                    200 -> 500.0
                                    500 -> 2000.0  // 2 GB
                                    2000 -> 5000.0 // 5 GB
                                    5000 -> 10000.0 // 10 GB
                                    10000 -> 0.0   // Unlimited
                                    else -> 50.0
                                }
                                prefs.maxFileSizeMB = maxFileSizeMBState
                            }, { featureInfoTitle = "Max File Size Limit"; featureInfoDesc = "Files larger than this limit will be skipped. Set to Unlimited or tap 'Set Custom Limit' to enter a custom value in MB or GB." })

                            // Button to launch Custom Limit Dialog
                            TextButton(
                                onClick = { showCustomMaxLimitDialog = true },
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)
                            ) {
                                Icon(Icons.Default.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("Set Custom Max File Size Limit (MB/GB)", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                            }
                        }
                    }

                    // Granular File Categories & Type Controls
                    Text("File Types & Categories", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            SwitchRowWithInfo("Photos & Camera", includeCamera, { includeCamera = it; prefs.backupCamera = it; prefs.backupPictures = it }, { featureInfoTitle = "Photos & Camera"; featureInfoDesc = "JPG, PNG, WEBP, HEIC, RAW, SVG images." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Videos & Movies", includeVideos, { includeVideos = it; prefs.backupVideos = it }, { featureInfoTitle = "Videos"; featureInfoDesc = "MP4, MKV, AVI, MOV, WEBM video files." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Audio & Music", includeAudio, { includeAudio = it; prefs.backupAudio = it }, { featureInfoTitle = "Audio & Music"; featureInfoDesc = "MP3, FLAC, WAV, AAC, OGG, M4A audio tracks." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Documents & PDFs", includeDocs, { includeDocs = it; prefs.backupDocuments = it }, { featureInfoTitle = "Documents"; featureInfoDesc = "PDF, DOCX, XLSX, PPTX, TXT, EPUB files." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Archives & ZIP Files", includeArchives, { includeArchives = it; prefs.backupArchives = it }, { featureInfoTitle = "Archives"; featureInfoDesc = "ZIP, RAR, 7Z, TAR, GZ, ISO compressed archives." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("APK & App Packages", includeApks, { includeApks = it; prefs.backupApks = it }, { featureInfoTitle = "APKs"; featureInfoDesc = "Android APK, XAPK, APKS app packages." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Downloads Folder", includeDownloads, { includeDownloads = it; prefs.backupDownloads = it }, { featureInfoTitle = "Downloads"; featureInfoDesc = "Monitors device Downloads folder." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("All Other File Types", includeAllOther, { includeAllOther = it; prefs.backupAllOther = it }, { featureInfoTitle = "Other Files"; featureInfoDesc = "Backs up all other custom file extensions." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Show Hidden Files", showHiddenFiles, { showHiddenFiles = it; prefs.showHiddenFiles = it }, { featureInfoTitle = "Hidden Files"; featureInfoDesc = "Shows dotfiles in file explorer." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            Row(modifier = Modifier.fillMaxWidth().clickable { triggerHapticFeedback(context, haptic); customFolderLauncher.launch(null) }.padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Column(modifier = Modifier.weight(1f)) { Text("Add Custom Folder", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold)); Text(prefs.customDownloadDir, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline) }
                                Icon(Icons.Default.FolderOpen, contentDescription = null, tint = TelegramBlue)
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // 💾 Save Backup Engine Settings Button
                    Button(
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            prefs.autoBackupEnabled = autoBackup
                            prefs.smartBackupMode = smartBackupMode
                            prefs.smartScanIntervalHours = smartScanInterval
                            prefs.nightBackupHour = nightBackupHour
                            prefs.minFileSizeMB = minFileSizeMBState
                            prefs.maxFileSizeMB = maxFileSizeMBState
                            prefs.backupCamera = includeCamera
                            prefs.backupPictures = includeCamera
                            prefs.backupVideos = includeVideos
                            prefs.backupAudio = includeAudio
                            prefs.backupDownloads = includeDownloads
                            prefs.backupDocuments = includeDocs
                            prefs.backupArchives = includeArchives
                            prefs.backupApks = includeApks
                            prefs.backupAllOther = includeAllOther
                            prefs.showHiddenFiles = showHiddenFiles
                            scope.launch {
                                SettingsDbManager.saveCategorySettings(
                                    context,
                                    "Smart Backup Engine",
                                    mapOf(
                                        "auto_backup_enabled" to autoBackup.toString(),
                                        "smart_backup_mode" to smartBackupMode.toString(),
                                        "smart_scan_interval_hours" to smartScanInterval.toString(),
                                        "night_backup_hour" to nightBackupHour.toString(),
                                        "min_file_size_mb" to minFileSizeMBState.toString(),
                                        "max_file_size_mb" to maxFileSizeMBState.toString(),
                                        "backup_camera" to includeCamera.toString(),
                                        "backup_videos" to includeVideos.toString(),
                                        "backup_audio" to includeAudio.toString(),
                                        "backup_downloads" to includeDownloads.toString(),
                                        "backup_documents" to includeDocs.toString(),
                                        "backup_archives" to includeArchives.toString(),
                                        "backup_apks" to includeApks.toString(),
                                        "backup_all_other" to includeAllOther.toString(),
                                        "show_hidden_files" to showHiddenFiles.toString()
                                    )
                                )
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("💾 Save Backup Engine Settings to Database")
                    }
                }

                // 📡 NETWORK & PERFORMANCE
                StreamlinedCategory.NETWORK_PERFORMANCE -> {
                    Text("Network & Upload Performance", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            SwitchRowWithInfo("Wi-Fi Only Upload", backupOverWifi, { backupOverWifi = it; prefs.wifiOnly = it }, { featureInfoTitle = "Wi-Fi Only"; featureInfoDesc = "Restricts background backups to Wi-Fi networks." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SwitchRowWithInfo("Data Compression", enableDataCompression, { enableDataCompression = it; prefs.enableDataCompression = it }, { featureInfoTitle = "Data Compression"; featureInfoDesc = "Compresses files before upload to save bandwidth." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            OptionValueRowWithInfo("Upload Speed Limit", uploadSpeedLimit, {
                                uploadSpeedLimit = when (uploadSpeedLimit) { "Unlimited" -> "2 MB/s"; "2 MB/s" -> "5 MB/s"; else -> "Unlimited" }
                            }, { featureInfoTitle = "Speed Limit"; featureInfoDesc = "Caps upload speed so background transfers don't slow other apps." })
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            OptionValueRowWithInfo("Upload Threads", "$uploadThreads Threads", {
                                uploadThreads = if (uploadThreads >= 8) 1 else uploadThreads * 2
                            }, { featureInfoTitle = "Upload Threads"; featureInfoDesc = "Number of parallel upload streams." })
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // 💾 Save Network Settings Button
                    Button(
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            prefs.wifiOnly = backupOverWifi
                            prefs.enableDataCompression = enableDataCompression
                            scope.launch {
                                SettingsDbManager.saveCategorySettings(
                                    context,
                                    "Network & Performance",
                                    mapOf(
                                        "wifi_only" to backupOverWifi.toString(),
                                        "enable_data_compression" to enableDataCompression.toString(),
                                        "upload_speed_limit" to uploadSpeedLimit,
                                        "upload_threads" to uploadThreads.toString()
                                    )
                                )
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("💾 Save Network Settings to Database")
                    }
                }

                // 🔒 SECURITY & MASTER KEY
                StreamlinedCategory.SECURITY_PRIVACY_RESTORE -> {
                    Text("Security & Unique Master Key", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            SwitchRowWithInfo("Biometric Lock", biometricLock, { biometricLock = it; prefs.isBiometricEnabled = it }, { featureInfoTitle = "Biometric Lock"; featureInfoDesc = "Protects app with fingerprint or PIN." })
                            HorizontalDivider()

                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Lock, contentDescription = null, tint = TelegramEmerald, modifier = Modifier.size(18.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("Permanent AES-256 Master Key", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                            }
                            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                                Column(modifier = Modifier.padding(12.dp)) {
                                    Text(uniqueMasterKey, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold, color = TelegramEmerald))
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text("🔒 IMMUTABLE: This key is generated once. Changing it would break decryption of existing backups.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                }
                            }

                            // FIXED: Actually sends encryption key via /api/auth/send-key
                            Button(
                                onClick = {
                                    triggerHapticFeedback(context, haptic)
                                    val targetMail = prefs.recoveryEmail.ifEmpty { userEmail }
                                    scope.launch {
                                        val res = serverApi.sendEncryptionKeyEmail(prefs.serverUrl, targetMail, uniqueMasterKey)
                                        if (res.isSuccess) {
                                            Toast.makeText(context, "✉️ Master Key sent to $targetMail!", Toast.LENGTH_LONG).show()
                                        } else {
                                            Toast.makeText(context, "❌ Failed: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                                        }
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue), modifier = Modifier.fillMaxWidth()
                            ) { Icon(Icons.Default.Email, contentDescription = null, modifier = Modifier.size(18.dp)); Spacer(modifier = Modifier.width(6.dp)); Text("Email Encryption Key to Me") }

                            HorizontalDivider()
                            OptionValueRowWithInfo("Encryption Standard", "AES-256 GCM Active", null, { featureInfoTitle = "Encryption"; featureInfoDesc = "Files are encrypted locally before transmission to Telegram." })
                            HorizontalDivider()

                            // Launch Required Permission Setup Wizard Modal Button
                            OutlinedButton(
                                onClick = { showPermissionWizardModal = true },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(Icons.Default.Shield, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("🛡️ Check & Grant Backup Permissions", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // 💾 Save Security Settings Button
                    Button(
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            prefs.isBiometricEnabled = biometricLock
                            scope.launch {
                                SettingsDbManager.saveCategorySettings(
                                    context,
                                    "Security",
                                    mapOf(
                                        "is_biometric_enabled" to biometricLock.toString(),
                                        "encryption_key" to uniqueMasterKey
                                    )
                                )
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("💾 Save Security Settings to Database")
                    }
                }

                // 🎨 APPEARANCE
                StreamlinedCategory.APPEARANCE_REGION -> {
                    Text("App Theme", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            listOf("System Default", "Light Mode", "Dark Mode").forEachIndexed { index, label ->
                                Row(modifier = Modifier.fillMaxWidth().clickable { selectedTheme = index; prefs.appTheme = index; onThemeChanged(index) }.padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                    Text(label, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
                                    RadioButton(selected = selectedTheme == index, onClick = { selectedTheme = index; prefs.appTheme = index; onThemeChanged(index) })
                                }
                                if (index < 2) HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // 💾 Save Appearance Settings Button
                    Button(
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            prefs.appTheme = selectedTheme
                            onThemeChanged(selectedTheme)
                            scope.launch {
                                SettingsDbManager.saveCategorySettings(
                                    context,
                                    "Appearance",
                                    mapOf(
                                        "app_theme" to selectedTheme.toString()
                                    )
                                )
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("💾 Save Appearance Settings to Database")
                    }
                }

                // 🚪 DANGER ZONE
                StreamlinedCategory.DANGER_ZONE -> {
                    Text("Danger Zone & Account Actions", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold, color = Color(0xFFEF4444)))

                    // Trash Auto-Clean Setting
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            OptionValueRowWithInfo(
                                "Trash Auto-Clean Policy",
                                when (trashAutoCleanDays) { 0 -> "Never"; else -> "$trashAutoCleanDays Days" },
                                {
                                    trashAutoCleanDays = when (trashAutoCleanDays) { 0 -> 7; 7 -> 14; 14 -> 30; 30 -> 60; 60 -> 90; else -> 0 }
                                    prefs.trashAutoCleanDays = trashAutoCleanDays
                                    val msg = if (trashAutoCleanDays == 0) "Trash auto-clean: Never" else "Trash auto-clean after $trashAutoCleanDays days"
                                    Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                                },
                                { featureInfoTitle = "Trash Auto-Clean"; featureInfoDesc = "Automatically permanently deletes trash items after the configured number of days. Set to 'Never' to keep trash items indefinitely until manually emptied." }
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // 💾 Save Danger Zone Policy Button
                    Button(
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            prefs.trashAutoCleanDays = trashAutoCleanDays
                            scope.launch {
                                SettingsDbManager.saveCategorySettings(
                                    context,
                                    "Trash Policy",
                                    mapOf(
                                        "trash_auto_clean_days" to trashAutoCleanDays.toString()
                                    )
                                )
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("💾 Save Danger Zone Policy to Database")
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            SettingCategoryRow(Icons.Default.DeleteSweep, "Clear File Data Options", "Custom filters (Drive, Auto-Backup, Old files)", Color(0xFFF59E0B)) {
                                triggerHapticFeedback(context, haptic)
                                dialogInitialTab = 0
                                showClearDataAccountDialog = true
                            }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.CleaningServices, "Deep Clean Telegram Chat Storage", "Scans & purges all unlisted/orphaned Telegram files", Color(0xFF3B82F6)) {
                                triggerHapticFeedback(context, haptic)
                                val token = prefs.botToken
                                val chat = prefs.chatId
                                if (token.isEmpty() || chat.isEmpty()) {
                                    Toast.makeText(context, "Telegram Bot Token & Chat ID required!", Toast.LENGTH_SHORT).show()
                                } else {
                                    com.example.telegrambackup.utils.DynamicProcessTracker.startProcess(
                                        title = "Deep Clean Telegram Chat",
                                        subtitle = "Inspecting Telegram channel & permissions...",
                                        icon = Icons.Default.CleaningServices
                                    )
                                    scope.launch(Dispatchers.IO) {
                                        val serverApi = ServerApi()
                                        val chatInfo = serverApi.getTelegramChatInfo(token, chat)

                                        if (!chatInfo.success) {
                                            withContext(Dispatchers.Main) {
                                                com.example.telegrambackup.utils.DynamicProcessTracker.finishProcess()
                                                Toast.makeText(context, "Telegram Error: ${chatInfo.errorMessage}", Toast.LENGTH_LONG).show()
                                            }
                                            return@launch
                                        }

                                        if (chatInfo.isBotAdmin && !chatInfo.canDeleteMessages) {
                                            withContext(Dispatchers.Main) {
                                                Toast.makeText(context, "⚠️ Please give the bot 'Delete Messages' permission in channel '${chatInfo.title}'", Toast.LENGTH_LONG).show()
                                            }
                                        }

                                        val db = com.example.telegrambackup.data.AppDatabase.getDatabase(context)
                                        val max1 = db.uploadedFileDao().getMaxMessageId() ?: 0L
                                        val max2 = db.chunkProgressDao().getMaxMessageId() ?: 0L
                                        val knownMax = maxOf(max1, max2)
                                        val targetChatId = if (chatInfo.canonicalId != null) chatInfo.canonicalId.toString() else chat

                                        val result = serverApi.deepPurgeTelegramChatStorage(
                                            token,
                                            targetChatId,
                                            knownMaxId = knownMax,
                                            onProgress = { currentBatch, totalBatches, count ->
                                                val fraction = if (totalBatches > 0) currentBatch.toFloat() / totalBatches.toFloat() else 0f
                                                com.example.telegrambackup.utils.DynamicProcessTracker.updateProgress(
                                                    progress = fraction,
                                                    subtitle = "Scanning '${chatInfo.title}': $count purged ($currentBatch/$totalBatches)"
                                                )
                                            }
                                        )
                                        val deletedCount = result.first
                                        val scannedCount = result.second
                                        withContext(Dispatchers.Main) {
                                            com.example.telegrambackup.utils.DynamicProcessTracker.finishProcess()
                                            Toast.makeText(context, "✅ Telegram Deep Clean Complete! ($deletedCount items purged out of $scannedCount scanned in '${chatInfo.title}')", Toast.LENGTH_LONG).show()
                                        }
                                    }
                                }
                            }
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                            SettingCategoryRow(Icons.Default.DeleteForever, "Delete Account & All Data", "Permanently delete account, settings & files", Color(0xFFEF4444)) {
                                triggerHapticFeedback(context, haptic)
                                dialogInitialTab = 1
                                showClearDataAccountDialog = true
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    Text("App Version & Update Center", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold, color = TelegramBlue))
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                        Column {
                            val currentVersion = remember { try { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "2.1.19" } catch (_: Exception) { "2.1.19" } }
                            SettingCategoryRow(Icons.Default.Info, "App Info & Check for Updates", "Installed Version v$currentVersion • Tap to check updates", TelegramBlue) {
                                triggerHapticFeedback(context, haptic)
                                showAppInfoModal = true
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    Button(
                        onClick = { triggerHapticFeedback(context, haptic); onLogout() },
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer),
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth().height(48.dp)
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Log Out Account", fontWeight = FontWeight.Bold)
                    }
                }
            }
            Spacer(modifier = Modifier.height(24.dp))
        }

        if (showCustomMaxLimitDialog) {
            AlertDialog(
                onDismissRequest = { showCustomMaxLimitDialog = false },
                icon = { Icon(Icons.Default.CloudUpload, contentDescription = null, tint = TelegramBlue) },
                title = { Text("Set Custom Max File Size Limit") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Enter maximum file size limit in MB (e.g. 500 for 500MB, 5000 for 5GB, 0 for Unlimited):", style = MaterialTheme.typography.bodySmall)
                        OutlinedTextField(
                            value = customMaxLimitInput,
                            onValueChange = { customMaxLimitInput = it.filter { char -> char.isDigit() || char == '.' } },
                            label = { Text("Limit in MB (0 = Unlimited)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            AssistChip(onClick = { customMaxLimitInput = "0" }, label = { Text("Unlimited") })
                            AssistChip(onClick = { customMaxLimitInput = "2000" }, label = { Text("2 GB") })
                            AssistChip(onClick = { customMaxLimitInput = "5000" }, label = { Text("5 GB") })
                            AssistChip(onClick = { customMaxLimitInput = "10000" }, label = { Text("10 GB") })
                        }
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            val parsed = customMaxLimitInput.toDoubleOrNull() ?: 0.0
                            maxFileSizeMBState = parsed
                            prefs.maxFileSizeMB = parsed
                            scope.launch {
                                SettingsDbManager.saveCategorySettings(
                                    context,
                                    "Smart Backup Engine",
                                    mapOf("max_file_size_mb" to parsed.toString())
                                )
                            }
                            showCustomMaxLimitDialog = false
                            Toast.makeText(context, "Saved Custom Max File Size Limit: ${if (parsed <= 0) "Unlimited" else "$parsed MB"}", Toast.LENGTH_SHORT).show()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue)
                    ) { Text("Save Limit") }
                },
                dismissButton = {
                    TextButton(onClick = { showCustomMaxLimitDialog = false }) { Text("Cancel") }
                }
            )
        }
    }
}

@Composable
private fun SettingCategoryRow(icon: ImageVector, title: String, subtitle: String, iconTint: Color, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable { onClick() }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.size(40.dp).clip(CircleShape).background(iconTint.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
            Icon(imageVector = icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(22.dp))
        }
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold))
            Text(text = subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
        Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun OptionValueRowWithInfo(title: String, value: String, onClick: (() -> Unit)? = null, onInfoClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable { onClick() } else Modifier).padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
            Spacer(modifier = Modifier.width(4.dp))
            IconButton(onClick = onInfoClick, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Default.Info, contentDescription = "Info", tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (value.isNotEmpty()) { Text(text = value, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline); Spacer(modifier = Modifier.width(6.dp)) }
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun SwitchRowWithInfo(title: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, onInfoClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
            Spacer(modifier = Modifier.width(4.dp))
            IconButton(onClick = onInfoClick, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Default.Info, contentDescription = "Info", tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
            }
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
