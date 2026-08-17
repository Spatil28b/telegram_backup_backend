package com.example.telegrambackup

import android.content.Context
import android.os.Bundle
import android.os.Vibrator
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.example.telegrambackup.data.AppDatabase
import com.example.telegrambackup.data.AuthRepository
import com.example.telegrambackup.data.UploadedFile
import com.example.telegrambackup.theme.TelegramBackupTheme
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.ui.auth.AuthScreen
import com.example.telegrambackup.ui.drive.DriveExplorerScreen
import com.example.telegrambackup.ui.explorer.BackupExplorerScreen
import com.example.telegrambackup.ui.exceptions.BackupExceptionsScreen
import com.example.telegrambackup.ui.main.ActivityScreen
import com.example.telegrambackup.ui.main.DashboardHomeScreen
import com.example.telegrambackup.ui.main.ProfileScreen
import com.example.telegrambackup.ui.main.TrashBinScreen
import com.example.telegrambackup.ui.main.MonthlyArchiveScreen
import com.example.telegrambackup.ui.main.GuideScreen
import com.example.telegrambackup.ui.main.LocalFilesScreen
import com.example.telegrambackup.ui.main.LiveProgressScreen
import com.example.telegrambackup.ui.settings.BackupSettingsScreen
import com.example.telegrambackup.utils.AppPrefs
import com.example.telegrambackup.utils.BackupProgressTracker
import com.example.telegrambackup.utils.BiometricHelper
import com.example.telegrambackup.utils.FileViewerHelper
import com.example.telegrambackup.utils.SettingsDbManager
import com.example.telegrambackup.worker.BackupWorker
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.launch

private fun triggerHapticFeedback(context: Context, haptic: androidx.compose.ui.hapticfeedback.HapticFeedback) {
    try {
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        vibrator?.vibrate(30L)
    } catch (e: Exception) { }
}

enum class MainTab {
    HOME,
    DRIVE,
    LOCAL,
    PROGRESS,
    FILES,
    MONTHLY_ARCHIVE,
    GUIDE,
    TRASH,
    EXCEPTIONS,
    ACTIVITY,
    SETTINGS,
    PROFILE
}

class MainActivity : FragmentActivity() {
    private val authRepository by lazy { AuthRepository(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val context = LocalContext.current
            val prefs = remember { AppPrefs(context) }
            var currentThemeMode by remember { mutableIntStateOf(prefs.appTheme) }

            val systemDark = isSystemInDarkTheme()
            val isDark = when (currentThemeMode) {
                0 -> systemDark // 0 = System Default
                1 -> false      // 1 = Light Mode
                2 -> true       // 2 = Dark Mode
                else -> systemDark
            }

            TelegramBackupTheme(darkTheme = isDark) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    MainApp(
                        activity = this,
                        authRepository = authRepository,
                        onThemeChanged = { newTheme -> currentThemeMode = newTheme }
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainApp(
    activity: FragmentActivity,
    authRepository: AuthRepository,
    onThemeChanged: (Int) -> Unit = {}
) {
    val session by authRepository.session.collectAsState()
    var selectedTab by remember { mutableStateOf(MainTab.HOME) }
    var explorerInitialTab by remember { mutableStateOf(0) }
    var targetCategoryTitle by remember { mutableStateOf<String?>(null) }

    var isSearchActive by remember { mutableStateOf(false) }
    var topSearchQuery by remember { mutableStateOf("") }

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val prefs = remember { AppPrefs(context) }
    val haptic = LocalHapticFeedback.current

    val isBiometricActive = remember(prefs.isBiometricEnabled) {
        prefs.isBiometricEnabled && BiometricHelper.isBiometricAvailable(context)
    }
    var isAuthenticated by remember(isBiometricActive) { mutableStateOf(!isBiometricActive) }

    var backPressedTime by remember { mutableLongStateOf(0L) }
    var liveUploadedFiles by remember { mutableStateOf<List<UploadedFile>>(emptyList()) }
    var displayUserName by remember(prefs.displayName) { mutableStateOf(prefs.displayName) }
    val userEmail = session.email.ifEmpty { "user@mybackup.cloud" }

    var appUpdateInfo by remember { mutableStateOf<com.example.telegrambackup.ui.update.AppVersionInfo?>(null) }

    LaunchedEffect(Unit) {
        scope.launch(Dispatchers.IO) {
            try {
                val serverUrl = prefs.serverUrl.ifEmpty { "https://telegram-backup-backend.vercel.app" }
                val versionInfo = com.example.telegrambackup.network.ServerApi().getLatestAppVersion(serverUrl)
                val currentPkg = try {
                    context.packageManager.getPackageInfo(context.packageName, 0)
                } catch (_: Exception) { null }

                val currentVersionName = currentPkg?.versionName ?: "1.0.0"
                val currentVersionCode = if (currentPkg != null) {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) currentPkg.longVersionCode.toInt() else @Suppress("DEPRECATION") currentPkg.versionCode
                } else 1

                val isNewerVersionCode = versionInfo.versionCode > currentVersionCode
                val isNewerSemVer = com.example.telegrambackup.utils.SemVerUtils.isServerVersionNewer(versionInfo.versionName, currentVersionName)

                if (versionInfo.success && (isNewerVersionCode || isNewerSemVer) && versionInfo.downloadUrl.isNotEmpty()) {
                    withContext(Dispatchers.Main) {
                        appUpdateInfo = versionInfo
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("MainActivity", "App update check error on launch", e)
            }
        }
    }

    // Quick Upload File Picker Launcher
    // Fix #2: Previously inserted fake DB records with placeholder IDs.
    // Now only triggers BackupWorker which handles actual Telegram uploads.
    // The worker scans device storage and uploads any unbacked files.
    val quickUploadLauncher = rememberLauncherForActivityResult(contract = ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) {
            scope.launch(Dispatchers.IO) {
                // Trigger BackupWorker to scan & upload — it handles the real upload pipeline
                try {
                    val workRequest = OneTimeWorkRequestBuilder<BackupWorker>()
                        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                        .build()
                    WorkManager.getInstance(context).enqueueUniqueWork("ManualSyncWork", ExistingWorkPolicy.KEEP, workRequest)
                } catch (_: Exception) { }

                kotlinx.coroutines.withContext(Dispatchers.Main) {
                    Toast.makeText(context, "⚡ Backup started! ${uris.size} file(s) will be uploaded to Telegram Cloud.", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    // Instant High-Speed Parallel Auto Re-Sync on App Open & Background Worker Kickstart
    LaunchedEffect(Unit) {
        kotlinx.coroutines.withContext(Dispatchers.IO) {
            // STEP 1: Restore cloud file index into Room DB FIRST before starting worker!
            try { SettingsDbManager.restoreCloudFileIndexToRoom(context) } catch (_: Exception) {}
            try { SettingsDbManager.fetchAndSyncSettingsOnAppOpen(context) } catch (_: Exception) {}
            try { BackupProgressTracker.hydrateRecentCompleted(context) } catch (_: Exception) {}

            // Hydrate live files state for Home Screen
            try {
                val db = AppDatabase.getDatabase(context)
                val files = db.uploadedFileDao().getAllFiles()
                withContext(Dispatchers.Main) { liveUploadedFiles = files }
            } catch (_: Exception) {}

            // STEP 2: Kickstart background backup scan AFTER Room DB is fully restored!
            if (prefs.autoBackupEnabled && !prefs.stopAllBackups) {
                try {
                    val workRequest = OneTimeWorkRequestBuilder<BackupWorker>()
                        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                        .build()
                    WorkManager.getInstance(context).enqueueUniqueWork("ManualSyncWork", ExistingWorkPolicy.KEEP, workRequest)
                } catch (_: Exception) { }
            }
        }
    }

    LaunchedEffect(isBiometricActive) {
        if (isBiometricActive && !isAuthenticated) {
            BiometricHelper.showBiometricPrompt(
                activity = activity,
                title = "My Backup Cloud",
                subtitle = "Authenticate to access your cloud backup",
                onSuccess = { isAuthenticated = true },
                onError = { errorMsg ->
                    Toast.makeText(context, "Authentication Failed: $errorMsg", Toast.LENGTH_SHORT).show()
                }
            )
        }
    }

    BackHandler(enabled = isAuthenticated && session.isLoggedIn) {
        if (drawerState.isOpen) {
            scope.launch { drawerState.close() }
        } else if (isSearchActive) {
            isSearchActive = false
            topSearchQuery = ""
        } else if (selectedTab != MainTab.HOME) {
            targetCategoryTitle = null
            selectedTab = MainTab.HOME
        } else {
            val currentTime = System.currentTimeMillis()
            if (currentTime - backPressedTime < 2000) {
                activity.finish()
            } else {
                backPressedTime = currentTime
                triggerHapticFeedback(context, haptic)
                Toast.makeText(context, "Press back again to exit", Toast.LENGTH_SHORT).show()
            }
        }
    }

    LaunchedEffect(selectedTab) {
        scope.launch(Dispatchers.IO) {
            try {
                val db = AppDatabase.getDatabase(context)
                val files = db.uploadedFileDao().getAllFiles()
                liveUploadedFiles = files
            } catch (e: Exception) {
                liveUploadedFiles = emptyList()
            }
        }
    }

    var showPermissionSetupWizard by remember { mutableStateOf(false) }

    LaunchedEffect(session.isLoggedIn) {
        if (session.isLoggedIn && !com.example.telegrambackup.ui.auth.areAllRequiredPermissionsGranted(context)) {
            showPermissionSetupWizard = true
        }
    }

    if (showPermissionSetupWizard) {
        com.example.telegrambackup.ui.auth.PermissionSetupDialog(
            onDismiss = { showPermissionSetupWizard = false }
        )
    }

    if (!session.isLoggedIn) {
        AuthScreen(
            authRepository = authRepository,
            onAuthSuccess = {
                if (!com.example.telegrambackup.ui.auth.areAllRequiredPermissionsGranted(context)) {
                    showPermissionSetupWizard = true
                }
            }
        )
    } else if (!isAuthenticated) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier.padding(24.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(90.dp)
                        .clip(CircleShape)
                        .background(TelegramBlue.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.Fingerprint,
                        contentDescription = null,
                        tint = TelegramBlue,
                        modifier = Modifier.size(54.dp)
                    )
                }

                Spacer(modifier = Modifier.height(20.dp))

                Text(
                    text = "App Locked for Security",
                    style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold)
                )

                Spacer(modifier = Modifier.height(6.dp))

                Text(
                    text = "Fingerprint or PIN authentication is required to open My Backup.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(horizontal = 16.dp)
                )

                Spacer(modifier = Modifier.height(28.dp))

                Button(
                    onClick = {
                        BiometricHelper.showBiometricPrompt(
                            activity = activity,
                            title = "My Backup Cloud",
                            subtitle = "Authenticate Fingerprint or Device Lock PIN to open",
                            onSuccess = { isAuthenticated = true },
                            onError = { errorMsg ->
                                Toast.makeText(context, "Auth Error: $errorMsg", Toast.LENGTH_SHORT).show()
                            }
                        )
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue),
                    modifier = Modifier.fillMaxWidth().height(50.dp)
                ) {
                    Text("Unlock with Biometrics", fontWeight = FontWeight.Bold)
                }
            }
        }
    } else {
        ModalNavigationDrawer(
            drawerState = drawerState,
            drawerContent = {
                ModalDrawerSheet(
                    drawerContainerColor = Color(0xFF0F172A),
                    modifier = Modifier.width(300.dp)
                ) {
                    Spacer(modifier = Modifier.height(24.dp))

                    Row(
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .clip(CircleShape)
                                .background(TelegramBlue.copy(alpha = 0.25f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Default.CloudQueue,
                                contentDescription = "Logo",
                                tint = TelegramBlue,
                                modifier = Modifier.size(26.dp)
                            )
                        }
                        Spacer(modifier = Modifier.width(14.dp))
                        Column {
                            val drawerVersion = remember { try { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "2.1.19" } catch (_: Exception) { "2.1.19" } }
                            Text("Cloud Sync Engine v$drawerVersion", style = MaterialTheme.typography.labelSmall.copy(color = TelegramBlue))
                        }
                    }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp), color = Color.White.copy(alpha = 0.1f))

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Dashboard, contentDescription = null, tint = Color.White) },
                        label = { Text("Dashboard", color = Color.White) },
                        selected = selectedTab == MainTab.HOME,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            targetCategoryTitle = null
                            selectedTab = MainTab.HOME
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.CloudQueue, contentDescription = null, tint = Color.White) },
                        label = { Text("Cloud Drive", color = Color.White) },
                        selected = selectedTab == MainTab.DRIVE,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.DRIVE
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Smartphone, contentDescription = null, tint = Color.White) },
                        label = { Text("Local Storage (Unbacked)", color = Color.White) },
                        selected = selectedTab == MainTab.LOCAL,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.LOCAL
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.HourglassTop, contentDescription = null, tint = Color.White) },
                        label = { Text("Upload Progress (Live)", color = Color.White) },
                        selected = selectedTab == MainTab.PROGRESS,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.PROGRESS
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Folder, contentDescription = null, tint = Color.White) },
                        label = { Text("Files", color = Color.White) },
                        selected = selectedTab == MainTab.FILES,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            targetCategoryTitle = null
                            selectedTab = MainTab.FILES
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.CalendarMonth, contentDescription = null, tint = Color.White) },
                        label = { Text("Monthly Archive", color = Color.White) },
                        selected = selectedTab == MainTab.MONTHLY_ARCHIVE,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.MONTHLY_ARCHIVE
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.MenuBook, contentDescription = null, tint = Color.White) },
                        label = { Text("Complete Setup Guide", color = Color.White) },
                        selected = selectedTab == MainTab.GUIDE,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.GUIDE
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.DeleteSweep, contentDescription = null, tint = Color.White) },
                        label = { Text("Trash Bin", color = Color.White) },
                        selected = selectedTab == MainTab.TRASH,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.TRASH
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Block, contentDescription = null, tint = Color.White) },
                        label = { Text("Backup Exceptions", color = Color.White) },
                        selected = selectedTab == MainTab.EXCEPTIONS,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.EXCEPTIONS
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Notifications, contentDescription = null, tint = Color.White) },
                        label = { Text("Activity", color = Color.White) },
                        selected = selectedTab == MainTab.ACTIVITY,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.ACTIVITY
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Settings, contentDescription = null, tint = Color.White) },
                        label = { Text("Settings", color = Color.White) },
                        selected = selectedTab == MainTab.SETTINGS,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            selectedTab = MainTab.SETTINGS
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent, selectedContainerColor = Color.White.copy(alpha = 0.15f))
                    )

                    Spacer(modifier = Modifier.weight(1f))

                    NavigationDrawerItem(
                        icon = { Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null, tint = Color(0xFFEF4444)) },
                        label = { Text("Log Out", color = Color(0xFFEF4444)) },
                        selected = false,
                        onClick = {
                            triggerHapticFeedback(context, haptic)
                            scope.launch { drawerState.close() }
                            authRepository.logout()
                        },
                        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = Color.Transparent)
                    )

                    Spacer(modifier = Modifier.height(16.dp))
                }
            }
        ) {
            Scaffold(
                topBar = {
                    CenterAlignedTopAppBar(
                        title = {
                            if (isSearchActive) {
                                OutlinedTextField(
                                    value = topSearchQuery,
                                    onValueChange = { topSearchQuery = it },
                                    placeholder = { Text("Search backed up files...", style = MaterialTheme.typography.bodySmall) },
                                    singleLine = true,
                                    shape = RoundedCornerShape(20.dp),
                                    modifier = Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp, vertical = 2.dp)
                                )
                            } else {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.clickable {
                                        triggerHapticFeedback(context, haptic)
                                        selectedTab = MainTab.PROFILE
                                    }
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(32.dp)
                                            .clip(CircleShape)
                                            .background(TelegramBlue.copy(alpha = 0.2f)),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Icon(
                                            imageVector = when (selectedTab) {
                                                MainTab.HOME -> Icons.Default.Dashboard
                                                MainTab.DRIVE -> Icons.Default.CloudQueue
                                                MainTab.LOCAL -> Icons.Default.Smartphone
                                                MainTab.PROGRESS -> Icons.Default.HourglassTop
                                                MainTab.FILES -> Icons.Default.Folder
                                                MainTab.MONTHLY_ARCHIVE -> Icons.Default.CalendarMonth
                                                MainTab.GUIDE -> Icons.Default.MenuBook
                                                MainTab.TRASH -> Icons.Default.DeleteSweep
                                                MainTab.EXCEPTIONS -> Icons.Default.Block
                                                MainTab.ACTIVITY -> Icons.Default.Notifications
                                                MainTab.SETTINGS -> Icons.Default.Settings
                                                MainTab.PROFILE -> Icons.Default.Person
                                            },
                                            contentDescription = "Section Icon",
                                            tint = TelegramBlue,
                                            modifier = Modifier.size(18.dp)
                                        )
                                    }
                                    Spacer(modifier = Modifier.width(10.dp))
                                    Text(
                                        text = when (selectedTab) {
                                            MainTab.HOME -> "Dashboard"
                                            MainTab.DRIVE -> "Cloud Drive"
                                            MainTab.LOCAL -> "Local Unbacked Storage"
                                            MainTab.PROGRESS -> "Live Upload Progress"
                                            MainTab.FILES -> "Backup Explorer"
                                            MainTab.MONTHLY_ARCHIVE -> "Monthly Archive"
                                            MainTab.GUIDE -> "Complete Setup Guide"
                                            MainTab.TRASH -> "Trash Bin"
                                            MainTab.EXCEPTIONS -> "Backup Exceptions"
                                            MainTab.ACTIVITY -> "Sync Activity"
                                            MainTab.SETTINGS -> "Settings"
                                            MainTab.PROFILE -> "My Profile"
                                        },
                                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold)
                                    )
                                }
                            }
                        },
                        navigationIcon = {
                            IconButton(onClick = {
                                triggerHapticFeedback(context, haptic)
                                scope.launch { drawerState.open() }
                            }) {
                                Icon(Icons.Default.Menu, contentDescription = "Open Navigation Menu")
                            }
                        },
                        actions = {
                            IconButton(onClick = {
                                triggerHapticFeedback(context, haptic)
                                if (isSearchActive) {
                                    isSearchActive = false
                                    topSearchQuery = ""
                                } else {
                                    isSearchActive = true
                                    if (selectedTab != MainTab.DRIVE && selectedTab != MainTab.FILES) {
                                        selectedTab = MainTab.FILES
                                    }
                                }
                            }) {
                                Icon(if (isSearchActive) Icons.Default.Close else Icons.Default.Search, contentDescription = "Search", tint = MaterialTheme.colorScheme.onSurface)
                            }
                            IconButton(onClick = {
                                triggerHapticFeedback(context, haptic)
                                if (prefs.botToken.isEmpty() || prefs.chatId.isEmpty()) {
                                    Toast.makeText(context, "Please configure Bot Token & Chat ID in Settings first!", Toast.LENGTH_LONG).show()
                                    selectedTab = MainTab.SETTINGS
                                    return@IconButton
                                }
                                try {
                                    val workRequest = OneTimeWorkRequestBuilder<BackupWorker>()
                                        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                                        .build()
                                    WorkManager.getInstance(context).enqueueUniqueWork("ManualSyncWork", ExistingWorkPolicy.KEEP, workRequest)
                                    Toast.makeText(context, "Syncing files to Telegram Cloud...", Toast.LENGTH_SHORT).show()
                                } catch (e: Exception) {
                                    Toast.makeText(context, "Sync Error: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
                                }
                            }) {
                                Icon(Icons.Default.Sync, contentDescription = "Sync Cloud", tint = TelegramBlue)
                            }
                        }
                    )
                },
                bottomBar = {
                    NavigationBar {
                        NavigationBarItem(
                            selected = selectedTab == MainTab.HOME,
                            onClick = {
                                triggerHapticFeedback(context, haptic)
                                targetCategoryTitle = null
                                selectedTab = MainTab.HOME
                            },
                            icon = { Icon(Icons.Default.Home, contentDescription = "Home") },
                            label = { Text("Home") }
                        )
                        NavigationBarItem(
                            selected = selectedTab == MainTab.DRIVE,
                            onClick = {
                                triggerHapticFeedback(context, haptic)
                                selectedTab = MainTab.DRIVE
                            },
                            icon = { Icon(Icons.Default.CloudQueue, contentDescription = "Drive") },
                            label = { Text("Drive") }
                        )
                        FloatingActionButton(
                            onClick = {
                                triggerHapticFeedback(context, haptic)
                                quickUploadLauncher.launch("*/*")
                            },
                            containerColor = TelegramBlue,
                            contentColor = Color.White,
                            shape = CircleShape,
                            modifier = Modifier.size(48.dp)
                        ) {
                            Icon(Icons.Default.Add, contentDescription = "Quick Upload", modifier = Modifier.size(26.dp))
                        }
                        NavigationBarItem(
                            selected = selectedTab == MainTab.FILES,
                            onClick = {
                                triggerHapticFeedback(context, haptic)
                                targetCategoryTitle = null
                                selectedTab = MainTab.FILES
                            },
                            icon = { Icon(Icons.Default.Folder, contentDescription = "Files") },
                            label = { Text("Files") }
                        )
                        NavigationBarItem(
                            selected = selectedTab == MainTab.SETTINGS,
                            onClick = {
                                triggerHapticFeedback(context, haptic)
                                selectedTab = MainTab.SETTINGS
                            },
                            icon = { Icon(Icons.Default.Settings, contentDescription = "Settings") },
                            label = { Text("Settings") }
                        )
                    }
                }
            ) { paddingValues ->
                Box(modifier = Modifier.padding(paddingValues)) {
                    when (selectedTab) {
                        MainTab.HOME -> DashboardHomeScreen(
                            userName = displayUserName,
                            recentFiles = liveUploadedFiles,
                            onQuickActionClick = { catIndex ->
                                targetCategoryTitle = when (catIndex) {
                                    0 -> "Camera & Photos"
                                    1 -> "Videos"
                                    2 -> "Documents"
                                    3 -> "Downloads"
                                    4 -> "APKs"
                                    5 -> "Music"
                                    else -> "Camera & Photos"
                                }
                                explorerInitialTab = 0
                                selectedTab = MainTab.FILES
                            },
                            onViewAllClick = {
                                targetCategoryTitle = null
                                explorerInitialTab = 1
                                selectedTab = MainTab.FILES
                            },
                            onFileClick = { file ->
                                if (file.path.isNotEmpty()) {
                                    FileViewerHelper.openFile(context, file.path, file.fileName)
                                } else {
                                    Toast.makeText(context, "Opening ${file.fileName}...", Toast.LENGTH_SHORT).show()
                                }
                            }
                        )
                        MainTab.DRIVE -> DriveExplorerScreen(
                            externalSearchQuery = topSearchQuery
                        )
                        MainTab.LOCAL -> LocalFilesScreen()
                        MainTab.PROGRESS -> LiveProgressScreen()
                        MainTab.FILES -> BackupExplorerScreen(
                            initialTab = explorerInitialTab,
                            initialCategoryTitle = targetCategoryTitle,
                            externalSearchQuery = topSearchQuery,
                            onCategorySelected = { newCat -> targetCategoryTitle = newCat },
                            onBackToCategories = { targetCategoryTitle = null }
                        )
                        MainTab.ACTIVITY -> ActivityScreen()
                        MainTab.MONTHLY_ARCHIVE -> MonthlyArchiveScreen()
                        MainTab.GUIDE -> GuideScreen()
                        MainTab.TRASH -> TrashBinScreen()
                        MainTab.EXCEPTIONS -> BackupExceptionsScreen(onNavigateBack = { selectedTab = MainTab.HOME })
                        MainTab.SETTINGS -> BackupSettingsScreen(
                            onThemeChanged = onThemeChanged,
                            onLogout = { authRepository.logout() },
                            onNameUpdated = { newName -> displayUserName = newName }
                        )
                        MainTab.PROFILE -> ProfileScreen(
                            userName = displayUserName,
                            userEmail = userEmail,
                            onLogout = { authRepository.logout() }
                        )
                    }

                    com.example.telegrambackup.ui.common.DynamicTopProcessBar(
                        modifier = Modifier.align(Alignment.TopCenter)
                    )
                }
            }
        }
    }

    if (appUpdateInfo != null) {
        com.example.telegrambackup.ui.update.AppUpdaterDialog(
            versionInfo = appUpdateInfo!!,
            onDismiss = {
                appUpdateInfo = null
            }
        )
    }
}
