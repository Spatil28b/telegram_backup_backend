package com.example.telegrambackup.ui.main

import android.content.Context
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.unit.dp
import com.example.telegrambackup.data.AppDatabase
import com.example.telegrambackup.data.UploadedFile
import com.example.telegrambackup.theme.TelegramBlue
import com.example.telegrambackup.theme.TelegramEmerald
import com.example.telegrambackup.ui.explorer.formatFileSize
import com.example.telegrambackup.utils.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun TrashBinScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { AppPrefs(context) }
    var trashFiles by remember { mutableStateOf<List<UploadedFile>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var autoCleanedCount by remember { mutableIntStateOf(0) }

    // Multi-select state
    var selectedPaths by remember { mutableStateOf<Set<String>>(emptySet()) }
    var isSelectionMode by remember { mutableStateOf(false) }

    BackHandler(enabled = isSelectionMode) {
        selectedPaths = emptySet()
        isSelectionMode = false
    }

    fun refreshTrash() {
        scope.launch(Dispatchers.IO) {
            try {
                val db = AppDatabase.getDatabase(context)
                val dao = db.uploadedFileDao()

                // Auto-clean expired trash items based on user setting
                val autoCleanDays = prefs.trashAutoCleanDays
                if (autoCleanDays > 0) {
                    val cutoff = System.currentTimeMillis() - (autoCleanDays.toLong() * 24L * 60L * 60L * 1000L)
                    try {
                        val trashBefore = dao.getTrashFiles()
                        dao.deleteExpiredTrash(cutoff)
                        val trashAfter = dao.getTrashFiles()
                        val cleaned = trashBefore.size - trashAfter.size
                        if (cleaned > 0) autoCleanedCount = cleaned
                    } catch (e: Exception) { /* ignore auto-clean errors */ }
                }

                val files = dao.getTrashFiles()
                withContext(Dispatchers.Main) {
                    trashFiles = files
                    isLoading = false
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    trashFiles = emptyList()
                    isLoading = false
                    Toast.makeText(context, "Error loading trash: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        refreshTrash()
    }

    // Show auto-clean notification
    LaunchedEffect(autoCleanedCount) {
        if (autoCleanedCount > 0) {
            Toast.makeText(context, "🗑️ Auto-cleaned $autoCleanedCount expired items (${prefs.trashAutoCleanDays}-day policy)", Toast.LENGTH_LONG).show()
        }
    }

    val dateFormat = remember { SimpleDateFormat("dd MMM yyyy, hh:mm a", Locale.getDefault()) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        // Trash Info Header Card
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                    Icon(
                        imageVector = Icons.Default.DeleteSweep,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(28.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = "Trash Bin Recycle Storage",
                            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                            color = MaterialTheme.colorScheme.onErrorContainer
                        )
                        Text(
                            text = "${trashFiles.size} Items in Trash Bin",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.8f)
                        )
                        // Show auto-clean policy
                        val policyText = if (prefs.trashAutoCleanDays > 0) "Auto-clean after ${prefs.trashAutoCleanDays} days" else "Auto-clean: Never"
                        Text(
                            text = policyText,
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                            color = TelegramBlue
                        )
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Button(
                        onClick = {
                            val token = prefs.botToken
                            val chat = prefs.chatId
                            if (token.isEmpty() || chat.isEmpty()) {
                                Toast.makeText(context, "Telegram Bot Token & Chat ID required!", Toast.LENGTH_SHORT).show()
                                return@Button
                            }
                            com.example.telegrambackup.utils.DynamicProcessTracker.startProcess(
                                title = "Purging Telegram Channel",
                                subtitle = "Inspecting Telegram channel & permissions...",
                                icon = Icons.Default.CleaningServices
                            )
                            scope.launch(Dispatchers.IO) {
                                try {
                                    val serverApi = com.example.telegrambackup.network.ServerApi()
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

                                    val db = AppDatabase.getDatabase(context)
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
                                    withContext(Dispatchers.Main) {
                                        com.example.telegrambackup.utils.DynamicProcessTracker.finishProcess()
                                        if (result.first == -1) {
                                            Toast.makeText(context, "🚫 Bot CANNOT delete messages! Make bot Admin with 'Delete Messages' permission in channel '${chatInfo.title}'", Toast.LENGTH_LONG).show()
                                        } else if (result.first > 0) {
                                            Toast.makeText(context, "✅ ACTUALLY deleted ${result.first} messages from Telegram channel '${chatInfo.title}' (scanned ${result.second} IDs)", Toast.LENGTH_LONG).show()
                                        } else {
                                            Toast.makeText(context, "Channel '${chatInfo.title}' is already clean — 0 messages found in ${result.second} scanned IDs", Toast.LENGTH_LONG).show()
                                        }
                                        refreshTrash()
                                    }
                                } catch (e: Exception) {
                                    withContext(Dispatchers.Main) {
                                        com.example.telegrambackup.utils.DynamicProcessTracker.finishProcess()
                                        Toast.makeText(context, "Deep Clean failed: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = TelegramBlue),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text("🧹 Purge Unlisted", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                    }

                    if (trashFiles.isNotEmpty()) {
                        Button(
                            onClick = {
                                scope.launch(Dispatchers.IO) {
                                    try {
                                        val db = AppDatabase.getDatabase(context)
                                        val serverApi = com.example.telegrambackup.network.ServerApi()
                                        val authPrefs = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
                                        val userEmail = authPrefs.getString("user_email", "") ?: prefs.recoveryEmail
                                        
                                        trashFiles.forEach { file ->
                                            // 1. Delete from Telegram Cloud Chat (all chunks & message IDs) + Room DB
                                            try { serverApi.purgeFileCompleteFromTelegram(context, prefs.botToken, prefs.chatId, file) } catch (_: Exception) {}
                                            // 2. Delete from PostgreSQL Server DB
                                            if (userEmail.isNotEmpty()) {
                                                try { serverApi.deleteFile(prefs.serverUrl, userEmail, file.telegramFileId, file.path) } catch (_: Exception) {}
                                            }
                                        }
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(context, "Emptied Trash Bin permanently!", Toast.LENGTH_SHORT).show()
                                            refreshTrash()
                                        }
                                    } catch (e: Exception) {
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(context, "Error emptying trash: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Empty Trash", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                        }
                    }
                }
            }
        }

        // Multi-select action bar
        if (isSelectionMode && selectedPaths.isNotEmpty()) {
            Spacer(modifier = Modifier.height(8.dp))
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = TelegramBlue.copy(alpha = 0.12f),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        "${selectedPaths.size} selected",
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold, color = TelegramBlue)
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        // Restore Selected
                        Button(
                            onClick = {
                                val count = selectedPaths.size
                                val pathsToRestore = selectedPaths.toList()
                                scope.launch(Dispatchers.IO) {
                                    try {
                                        val dao = AppDatabase.getDatabase(context).uploadedFileDao()
                                        pathsToRestore.forEach { path ->
                                            dao.restoreFile(path, "")
                                        }
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(context, "Restored $count items!", Toast.LENGTH_SHORT).show()
                                            selectedPaths = emptySet()
                                            isSelectionMode = false
                                            refreshTrash()
                                        }
                                    } catch (e: Exception) {
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(context, "Restore failed: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = TelegramEmerald),
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Icon(Icons.Default.Restore, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Restore", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                        }

                        // Delete Permanently
                        Button(
                            onClick = {
                                val count = selectedPaths.size
                                val pathsToDelete = selectedPaths.toList()
                                scope.launch(Dispatchers.IO) {
                                    try {
                                        val dao = AppDatabase.getDatabase(context).uploadedFileDao()
                                        val serverApi = com.example.telegrambackup.network.ServerApi()
                                        val authPrefs = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
                                        val userEmail = authPrefs.getString("user_email", "") ?: prefs.recoveryEmail

                                        pathsToDelete.forEach { path ->
                                            val fileRecord = dao.getFileByPath(path)
                                            if (fileRecord != null) {
                                                try { serverApi.purgeFileCompleteFromTelegram(context, prefs.botToken, prefs.chatId, fileRecord) } catch (_: Exception) {}
                                                if (userEmail.isNotEmpty()) {
                                                    try { serverApi.deleteFile(prefs.serverUrl, userEmail, fileRecord.telegramFileId, path) } catch (_: Exception) {}
                                                }
                                            } else {
                                                try { serverApi.purgeUnlistedPathFromTelegram(context, prefs.botToken, prefs.chatId, path) } catch (_: Exception) {}
                                                if (userEmail.isNotEmpty()) {
                                                    try { serverApi.deleteFile(prefs.serverUrl, userEmail, "", path) } catch (_: Exception) {}
                                                }
                                                dao.deleteByPath(path)
                                            }
                                        }
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(context, "Permanently deleted $count items", Toast.LENGTH_SHORT).show()
                                            selectedPaths = emptySet()
                                            isSelectionMode = false
                                            refreshTrash()
                                        }
                                    } catch (e: Exception) {
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(context, "Delete failed: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Icon(Icons.Default.DeleteForever, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Delete", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold))
                        }

                        TextButton(
                            onClick = {
                                selectedPaths = emptySet()
                                isSelectionMode = false
                            },
                            contentPadding = PaddingValues(horizontal = 8.dp)
                        ) {
                            Text("Cancel", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        if (isLoading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else if (trashFiles.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                    Icon(Icons.Default.DeleteOutline, contentDescription = null, tint = TelegramBlue, modifier = Modifier.size(64.dp))
                    Spacer(modifier = Modifier.height(16.dp))
                    Text("Recycle Bin is Empty", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold))
                    val policyMsg = if (prefs.trashAutoCleanDays > 0) {
                        "Deleted files are auto-cleaned after ${prefs.trashAutoCleanDays} days."
                    } else {
                        "Deleted files stay here until you manually empty the trash."
                    }
                    Text(policyMsg, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                }
            }
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 24.dp)
            ) {
                itemsIndexed(trashFiles, key = { index, file -> "${file.path}_$index" }) { _, file ->
                    val isSelected = selectedPaths.contains(file.path)
                    Surface(
                        shape = RoundedCornerShape(14.dp),
                        color = if (isSelected) TelegramBlue.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
                        tonalElevation = 1.dp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .combinedClickable(
                                onClick = {
                                    if (isSelectionMode) {
                                        selectedPaths = if (isSelected) selectedPaths - file.path else selectedPaths + file.path
                                        if (selectedPaths.isEmpty()) isSelectionMode = false
                                    }
                                },
                                onLongClick = {
                                    isSelectionMode = true
                                    selectedPaths = selectedPaths + file.path
                                }
                            )
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            if (isSelectionMode) {
                                Checkbox(
                                    checked = isSelected,
                                    onCheckedChange = { checked ->
                                        selectedPaths = if (checked) selectedPaths + file.path else selectedPaths - file.path
                                        if (selectedPaths.isEmpty()) isSelectionMode = false
                                    },
                                    modifier = Modifier.size(24.dp)
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }

                            Box(
                                modifier = Modifier
                                    .size(40.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.15f)),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Delete,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error,
                                    modifier = Modifier.size(20.dp)
                                )
                            }

                            Spacer(modifier = Modifier.width(12.dp))

                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = file.fileName,
                                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                                    maxLines = 1
                                )
                                Text(
                                    text = formatFileSize(file.size),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.outline
                                )
                                // Show when it was deleted and days remaining
                                if (file.deletedAt > 0) {
                                    val deletedDate = dateFormat.format(Date(file.deletedAt))
                                    val daysInTrash = ((System.currentTimeMillis() - file.deletedAt) / (24L * 60L * 60L * 1000L)).toInt()
                                    val remainingDays = if (prefs.trashAutoCleanDays > 0) (prefs.trashAutoCleanDays - daysInTrash).coerceAtLeast(0) else -1
                                    val remainText = if (remainingDays >= 0) " • ${remainingDays}d left" else ""
                                    Text(
                                        text = "Deleted: $deletedDate$remainText",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (remainingDays in 0..3) Color(0xFFEF4444) else MaterialTheme.colorScheme.outline
                                    )
                                }
                            }

                            if (!isSelectionMode) {
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    IconButton(
                                        onClick = {
                                            scope.launch(Dispatchers.IO) {
                                                try {
                                                    AppDatabase.getDatabase(context).uploadedFileDao().restoreFile(file.path, file.telegramFileId)
                                                    withContext(Dispatchers.Main) {
                                                        Toast.makeText(context, "Restored ${file.fileName}", Toast.LENGTH_SHORT).show()
                                                        refreshTrash()
                                                    }
                                                } catch (e: Exception) {
                                                    withContext(Dispatchers.Main) {
                                                        Toast.makeText(context, "Restore failed: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                                                    }
                                                }
                                            }
                                        }
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Restore,
                                            contentDescription = "Restore File",
                                            tint = TelegramEmerald
                                        )
                                    }

                                    IconButton(
                                        onClick = {
                                            scope.launch(Dispatchers.IO) {
                                                try {
                                                    val db = AppDatabase.getDatabase(context)
                                                    val serverApi = com.example.telegrambackup.network.ServerApi()
                                                    val authPrefs = context.getSharedPreferences("auth_prefs", Context.MODE_PRIVATE)
                                                    val userEmail = authPrefs.getString("user_email", "") ?: prefs.recoveryEmail

                                                    // 1. Delete from Telegram Cloud Chat (all chunks & message IDs) + Room DB
                                                    try { serverApi.purgeFileCompleteFromTelegram(context, prefs.botToken, prefs.chatId, file) } catch (_: Exception) {}
                                                    // 2. Delete from PostgreSQL Server DB
                                                    if (userEmail.isNotEmpty()) {
                                                        try { serverApi.deleteFile(prefs.serverUrl, userEmail, file.telegramFileId, file.path) } catch (_: Exception) {}
                                                    }

                                                    withContext(Dispatchers.Main) {
                                                        Toast.makeText(context, "Permanently deleted ${file.fileName} from app and Telegram!", Toast.LENGTH_SHORT).show()
                                                        refreshTrash()
                                                    }
                                                } catch (e: Exception) {
                                                    withContext(Dispatchers.Main) {
                                                        Toast.makeText(context, "Delete failed: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                                                    }
                                                }
                                            }
                                        }
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.DeleteForever,
                                            contentDescription = "Delete Permanently",
                                            tint = MaterialTheme.colorScheme.error
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
