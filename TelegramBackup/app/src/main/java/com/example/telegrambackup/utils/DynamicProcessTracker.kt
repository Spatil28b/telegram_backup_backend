package com.example.telegrambackup.utils

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector

object DynamicProcessTracker {
    var isProcessActive by mutableStateOf(false)
        private set

    var isMinimized by mutableStateOf(false)
        private set

    var processTitle by mutableStateOf("Background Operation")
        private set

    var processSubtitle by mutableStateOf("Processing...")
        private set

    var progressFraction by mutableFloatStateOf(0f)
        private set

    var processIcon: ImageVector by mutableStateOf(Icons.Default.CloudUpload)
        private set

    var onCancelAction: (() -> Unit)? by mutableStateOf(null)
        private set

    fun startProcess(
        title: String,
        subtitle: String,
        icon: ImageVector = Icons.Default.CloudUpload,
        onCancel: (() -> Unit)? = null
    ) {
        processTitle = title
        processSubtitle = subtitle
        processIcon = icon
        onCancelAction = onCancel
        progressFraction = 0f
        isProcessActive = true
        isMinimized = false
    }

    fun updateProgress(progress: Float, subtitle: String? = null) {
        progressFraction = progress.coerceIn(0f, 1f)
        if (subtitle != null) {
            processSubtitle = subtitle
        }
    }

    fun minimize() {
        if (isProcessActive) {
            isMinimized = true
        }
    }

    fun expand() {
        if (isProcessActive) {
            isMinimized = false
        }
    }

    fun finishProcess() {
        isProcessActive = false
        isMinimized = false
        progressFraction = 0f
        onCancelAction = null
    }

    fun cancelProcess() {
        onCancelAction?.invoke()
        finishProcess()
    }
}
