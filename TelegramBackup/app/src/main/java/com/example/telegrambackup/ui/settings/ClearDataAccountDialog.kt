package com.example.telegrambackup.ui.settings

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.telegrambackup.data.AppDatabase
import com.example.telegrambackup.data.AuthRepository
import com.example.telegrambackup.network.ServerApi
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.utils.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val DangerRed = Color(0xFFEF4444)
private val WarningAmber = Color(0xFFF59E0B)
private val DarkCardBg = Color(0xFF0F172A)
private val SurfaceDark = Color(0xFF1E293B)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClearDataAccountDialog(
    initialTab: Int = 0, // 0 = Clear Data, 1 = Delete Account
    onDismiss: () -> Unit,
    onLogoutCompleted: () -> Unit = {}
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { AppPrefs(context) }
    val authRepository = remember { AuthRepository(context) }

    var selectedTab by remember { mutableIntStateOf(initialTab) }

    // Option 1 States (Clear Data Only)
    var purgeMode by remember { mutableStateOf("ALL") } // ALL, DRIVE_ONLY, AUTO_BACKUP_ONLY, OLDER_THAN_DAYS
    var selectedOlderDays by remember { mutableIntStateOf(30) }
    var purgeTelegramMessages by remember { mutableStateOf(true) }
    var deepCleanTelegramChat by remember { mutableStateOf(false) }
    var clearLocalDb by remember { mutableStateOf(true) }

    // Option 2 States (Delete Account)
    var confirmInput by remember { mutableStateOf("") }
    var accountPurgeTelegram by remember { mutableStateOf(true) }
    var isProcessing by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf("") }

    if (com.example.telegrambackup.utils.DynamicProcessTracker.isMinimized) {
        return
    }

    LaunchedEffect(isProcessing, statusMessage) {
        if (isProcessing) {
            if (!com.example.telegrambackup.utils.DynamicProcessTracker.isProcessActive) {
                com.example.telegrambackup.utils.DynamicProcessTracker.startProcess(
                    title = if (selectedTab == 0) "Clearing File Data" else "Deleting Account",
                    subtitle = statusMessage,
                    icon = Icons.Default.CleaningServices
                )
            }
            com.example.telegrambackup.utils.DynamicProcessTracker.updateProgress(0.5f, statusMessage)
        } else {
            if (com.example.telegrambackup.utils.DynamicProcessTracker.isProcessActive) {
                com.example.telegrambackup.utils.DynamicProcessTracker.finishProcess()
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!isProcessing) onDismiss() },
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)),
        containerColor = Color(0xFF0B1120),
        title = {
            Column {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = if (selectedTab == 0) Icons.Default.DeleteSweep else Icons.Default.Warning,
                            contentDescription = null,
                            tint = if (selectedTab == 0) WarningAmber else DangerRed,
                            modifier = Modifier.size(26.dp)
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Text(
                            if (selectedTab == 0) "Clear Data Options" else "Delete Account",
                            style = MaterialTheme.typography.titleMedium.copy(color = Color.White, fontWeight = FontWeight.Bold)
                        )
                    }

                    if (isProcessing) {
                        IconButton(onClick = { com.example.telegrambackup.utils.DynamicProcessTracker.minimize() }) {
                            Icon(Icons.Default.Remove, contentDescription = "Minimize", tint = TelegramBlue)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Segmented Selector Tabs
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(SurfaceDark)
                        .padding(4.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selectedTab == 0) WarningAmber.copy(alpha = 0.25f) else Color.Transparent)
                            .clickable(enabled = !isProcessing) { selectedTab = 0 }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "🗑️ Clear Data",
                            style = MaterialTheme.typography.bodySmall.copy(
                                color = if (selectedTab == 0) WarningAmber else Color.White.copy(alpha = 0.6f),
                                fontWeight = FontWeight.Bold
                            )
                        )
                    }

                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selectedTab == 1) DangerRed.copy(alpha = 0.25f) else Color.Transparent)
                            .clickable(enabled = !isProcessing) { selectedTab = 1 }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "🚨 Delete Account",
                            style = MaterialTheme.typography.bodySmall.copy(
                                color = if (selectedTab == 1) DangerRed else Color.White.copy(alpha = 0.6f),
                                fontWeight = FontWeight.Bold
                            )
                        )
                    }
                }
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                if (selectedTab == 0) {
                    // OPTION 1: CLEAR FILE DATA ONLY (KEEP ACCOUNT ACTIVE)
                    Text(
                        "Custom Data Filter Mode:",
                        style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.7f)),
                        modifier = Modifier.padding(bottom = 6.dp)
                    )

                    // Filter Mode 1: ALL
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { purgeMode = "ALL" }
                            .padding(vertical = 4.dp)
                    ) {
                        RadioButton(
                            selected = purgeMode == "ALL",
                            onClick = { purgeMode = "ALL" },
                            colors = RadioButtonDefaults.colors(selectedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Column {
                            Text("Delete ALL Backed-Up Files & Drive Items", style = MaterialTheme.typography.bodySmall.copy(color = Color.White, fontWeight = FontWeight.Bold))
                            Text("Full wipe of all file records", style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.5f)))
                        }
                    }

                    // Filter Mode 2: DRIVE_ONLY
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { purgeMode = "DRIVE_ONLY" }
                            .padding(vertical = 4.dp)
                    ) {
                        RadioButton(
                            selected = purgeMode == "DRIVE_ONLY",
                            onClick = { purgeMode = "DRIVE_ONLY" },
                            colors = RadioButtonDefaults.colors(selectedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Column {
                            Text("Delete ONLY Cloud Drive Uploads", style = MaterialTheme.typography.bodySmall.copy(color = Color.White, fontWeight = FontWeight.Bold))
                            Text("Leaves auto storage backups untouched", style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.5f)))
                        }
                    }

                    // Filter Mode 3: AUTO_BACKUP_ONLY
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { purgeMode = "AUTO_BACKUP_ONLY" }
                            .padding(vertical = 4.dp)
                    ) {
                        RadioButton(
                            selected = purgeMode == "AUTO_BACKUP_ONLY",
                            onClick = { purgeMode = "AUTO_BACKUP_ONLY" },
                            colors = RadioButtonDefaults.colors(selectedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Column {
                            Text("Delete ONLY Automatic Storage Backups", style = MaterialTheme.typography.bodySmall.copy(color = Color.White, fontWeight = FontWeight.Bold))
                            Text("Leaves Cloud Drive items untouched", style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.5f)))
                        }
                    }

                    // Filter Mode 4: OLDER_THAN_DAYS
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { purgeMode = "OLDER_THAN_DAYS" }
                            .padding(vertical = 4.dp)
                    ) {
                        RadioButton(
                            selected = purgeMode == "OLDER_THAN_DAYS",
                            onClick = { purgeMode = "OLDER_THAN_DAYS" },
                            colors = RadioButtonDefaults.colors(selectedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Column {
                            Text("Delete Files Older Than $selectedOlderDays Days", style = MaterialTheme.typography.bodySmall.copy(color = Color.White, fontWeight = FontWeight.Bold))
                            if (purgeMode == "OLDER_THAN_DAYS") {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    modifier = Modifier.padding(top = 4.dp)
                                ) {
                                    listOf(30, 60, 90).forEach { days ->
                                        FilterChip(
                                            selected = selectedOlderDays == days,
                                            onClick = { selectedOlderDays = days },
                                            label = { Text("$days Days", fontSize = 10.sp) },
                                            colors = FilterChipDefaults.filterChipColors(
                                                selectedContainerColor = WarningAmber,
                                                selectedLabelColor = Color.Black
                                            )
                                        )
                                    }
                                }
                            }
                        }
                    }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp), color = Color.White.copy(alpha = 0.1f))

                    // Customization Checkboxes
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { purgeTelegramMessages = !purgeTelegramMessages }
                    ) {
                        Checkbox(
                            checked = purgeTelegramMessages,
                            onCheckedChange = { purgeTelegramMessages = it },
                            colors = CheckboxDefaults.colors(checkedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("Purge messages from Telegram Cloud chat", style = MaterialTheme.typography.bodySmall.copy(color = Color.White))
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { deepCleanTelegramChat = !deepCleanTelegramChat }
                    ) {
                        Checkbox(
                            checked = deepCleanTelegramChat,
                            onCheckedChange = { deepCleanTelegramChat = it },
                            colors = CheckboxDefaults.colors(checkedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Column {
                            Text("🔥 Deep Scan & Purge Entire Telegram Chat Storage", style = MaterialTheme.typography.bodySmall.copy(color = WarningAmber, fontWeight = FontWeight.Bold))
                            Text("Deletes unlisted & orphaned files not visible in app", style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.5f)))
                        }
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { clearLocalDb = !clearLocalDb }
                    ) {
                        Checkbox(
                            checked = clearLocalDb,
                            onCheckedChange = { clearLocalDb = it },
                            colors = CheckboxDefaults.colors(checkedColor = WarningAmber)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("Clear matching local phone database records", style = MaterialTheme.typography.bodySmall.copy(color = Color.White))
                    }

                } else {
                    // OPTION 2: DELETE ACCOUNT WITH ALL DATA
                    Card(
                        colors = CardDefaults.cardColors(containerColor = DangerRed.copy(alpha = 0.15f)),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)
                    ) {
                        Row(modifier = Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Warning, contentDescription = null, tint = DangerRed, modifier = Modifier.size(20.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                "Permanent Deletion: Your user account, cloud settings, saved credentials, and all backed-up files will be deleted from PostgreSQL server & Telegram Cloud.",
                                style = MaterialTheme.typography.bodySmall.copy(color = Color.White.copy(alpha = 0.9f))
                            )
                        }
                    }

                    // Account Customizations
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { accountPurgeTelegram = !accountPurgeTelegram }
                    ) {
                        Checkbox(
                            checked = accountPurgeTelegram,
                            onCheckedChange = { accountPurgeTelegram = it },
                            colors = CheckboxDefaults.colors(checkedColor = DangerRed)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("Purge all user files from Telegram Bot chat", style = MaterialTheme.typography.bodySmall.copy(color = Color.White))
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { deepCleanTelegramChat = !deepCleanTelegramChat }
                    ) {
                        Checkbox(
                            checked = deepCleanTelegramChat,
                            onCheckedChange = { deepCleanTelegramChat = it },
                            colors = CheckboxDefaults.colors(checkedColor = DangerRed)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Column {
                            Text("🔥 Deep Scan & Purge Entire Telegram Chat Storage", style = MaterialTheme.typography.bodySmall.copy(color = DangerRed, fontWeight = FontWeight.Bold))
                            Text("Deletes all past uploads & unlisted files from Telegram", style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.5f)))
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    Text(
                        "Type DELETE to confirm account deletion:",
                        style = MaterialTheme.typography.labelSmall.copy(color = Color.White.copy(alpha = 0.7f))
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = confirmInput,
                        onValueChange = { confirmInput = it },
                        placeholder = { Text("Type DELETE", color = Color.White.copy(alpha = 0.3f)) },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = DangerRed,
                            unfocusedBorderColor = Color.White.copy(alpha = 0.3f),
                            focusedTextColor = Color.White,
                            unfocusedTextColor = Color.White
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                if (statusMessage.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        statusMessage,
                        style = MaterialTheme.typography.bodySmall.copy(color = if (selectedTab == 0) WarningAmber else DangerRed)
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (isProcessing) return@Button

                    val email = prefs.userEmail
                    val botToken = prefs.botToken
                    val chatId = prefs.chatId

                    if (selectedTab == 0) {
                        // EXECUTE CLEAR FILE DATA ONLY
                        isProcessing = true
                        statusMessage = "Collecting file records..."
                        scope.launch(Dispatchers.IO) {
                            try {
                                // 1. Pre-collect local Room DB message IDs BEFORE database wipe!
                                val db = AppDatabase.getDatabase(context)
                                val localFiles = try { db.uploadedFileDao().getAllFiles() } catch (_: Exception) { emptyList() }
                                val localMsgIds = localFiles.mapNotNull { if (it.messageId > 0) it.messageId else null }

                                withContext(Dispatchers.Main) { statusMessage = "Purging cloud database records..." }
                                val result = ServerApi().purgeFiles(
                                    prefs.serverUrl,
                                    email,
                                    mode = purgeMode,
                                    olderThanDays = selectedOlderDays
                                )

                                val serverMsgIds = result.second
                                val allMsgIds = (localMsgIds + serverMsgIds).toSet().toList()

                                var deepDeletedCount = 0
                                val shouldRunDeepPurge = purgeTelegramMessages || deepCleanTelegramChat
                                if (shouldRunDeepPurge && botToken.isNotEmpty() && chatId.isNotEmpty()) {
                                    if (allMsgIds.isNotEmpty()) {
                                        withContext(Dispatchers.Main) { statusMessage = "Purging ${allMsgIds.size} file messages from Telegram Cloud..." }
                                        val chunks = allMsgIds.chunked(20)
                                        for (chunk in chunks) {
                                            ServerApi().deleteTelegramMessagesBatch(botToken, chatId, chunk)
                                        }
                                    }

                                    // Deep Clean scan of entire Telegram Bot chat range to catch any unindexed or orphaned files
                                    withContext(Dispatchers.Main) { statusMessage = "Deep scanning & purging Telegram Chat storage..." }
                                    val res = ServerApi().deepPurgeTelegramChatStorage(
                                        botToken,
                                        chatId,
                                        onProgress = { currentChunk, totalChunks, count ->
                                            scope.launch(Dispatchers.Main) {
                                                statusMessage = "Deep purging Telegram... ($count items purged, batch $currentChunk/$totalChunks)"
                                            }
                                        }
                                    )
                                    deepDeletedCount = res.first
                                }

                                if (clearLocalDb) {
                                    if (purgeMode == "ALL") {
                                        db.uploadedFileDao().deleteAll()
                                    } else {
                                        ServerApi().listFiles(prefs.serverUrl, email).let { freshFiles ->
                                            db.uploadedFileDao().deleteAll()
                                            if (freshFiles.isNotEmpty()) db.uploadedFileDao().insertAll(freshFiles)
                                        }
                                    }
                                }

                                withContext(Dispatchers.Main) {
                                    isProcessing = false
                                    Toast.makeText(context, "✅ Data cleared & Telegram chat deep cleaned!", Toast.LENGTH_LONG).show()
                                    onDismiss()
                                }
                            } catch (e: Exception) {
                                withContext(Dispatchers.Main) {
                                    isProcessing = false
                                    statusMessage = "Error: ${e.localizedMessage}"
                                }
                            }
                        }

                    } else {
                        // EXECUTE DELETE ACCOUNT PERMANENTLY
                        if (confirmInput.trim().uppercase() != "DELETE") {
                            Toast.makeText(context, "Please type DELETE to confirm account deletion.", Toast.LENGTH_SHORT).show()
                            return@Button
                        }

                        isProcessing = true
                        statusMessage = "Collecting file records..."
                        scope.launch(Dispatchers.IO) {
                            try {
                                // 1. Pre-collect local Room DB message IDs BEFORE account wipe!
                                val db = AppDatabase.getDatabase(context)
                                val localFiles = try { db.uploadedFileDao().getAllFiles() } catch (_: Exception) { emptyList() }
                                val localMsgIds = localFiles.mapNotNull { if (it.messageId > 0) it.messageId else null }

                                withContext(Dispatchers.Main) { statusMessage = "Deleting account & cloud database..." }
                                val result = ServerApi().deleteAccount(prefs.serverUrl, email)
                                val serverMsgIds = result.second
                                val allMsgIds = (localMsgIds + serverMsgIds).toSet().toList()

                                if (accountPurgeTelegram && botToken.isNotEmpty() && chatId.isNotEmpty() && allMsgIds.isNotEmpty()) {
                                    withContext(Dispatchers.Main) { statusMessage = "Purging ${allMsgIds.size} files from Telegram Cloud..." }
                                    val chunks = allMsgIds.chunked(20)
                                    for (chunk in chunks) {
                                        ServerApi().deleteTelegramMessagesBatch(botToken, chatId, chunk)
                                    }
                                }

                                // Deep Clean scan of entire Telegram Bot chat range
                                var deepDeletedCount = 0
                                if (deepCleanTelegramChat && botToken.isNotEmpty() && chatId.isNotEmpty()) {
                                    withContext(Dispatchers.Main) { statusMessage = "Deep scanning & purging Telegram Chat storage..." }
                                    val res = ServerApi().deepPurgeTelegramChatStorage(
                                        botToken,
                                        chatId,
                                        onProgress = { currentChunk, totalChunks, count ->
                                            scope.launch(Dispatchers.Main) {
                                                statusMessage = "Deep purging Telegram... ($count items purged, batch $currentChunk/$totalChunks)"
                                            }
                                        }
                                    )
                                    deepDeletedCount = res.first
                                }

                                // Wipe local Room DB & session
                                db.uploadedFileDao().deleteAll()
                                authRepository.logout()

                                withContext(Dispatchers.Main) {
                                    isProcessing = false
                                    Toast.makeText(context, "👋 Account, data, & Telegram chat storage deleted permanently.", Toast.LENGTH_LONG).show()
                                    onLogoutCompleted()
                                    onDismiss()
                                }
                            } catch (e: Exception) {
                                withContext(Dispatchers.Main) {
                                    isProcessing = false
                                    statusMessage = "Error: ${e.localizedMessage}"
                                }
                            }
                        }
                    }
                },
                enabled = !isProcessing && (selectedTab == 0 || confirmInput.trim().uppercase() == "DELETE"),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (selectedTab == 0) WarningAmber else DangerRed
                )
            ) {
                if (isProcessing) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Text(
                        if (selectedTab == 0) "Wipe Selected Data" else "Delete Account Permanently",
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!isProcessing) onDismiss() }) {
                Text("Cancel", color = Color.White.copy(alpha = 0.7f))
            }
        }
    )
}
