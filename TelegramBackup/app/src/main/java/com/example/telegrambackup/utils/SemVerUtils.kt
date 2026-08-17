package com.example.telegrambackup.utils

object SemVerUtils {
    /**
     * Compares two semantic version strings (e.g., "2.0.20" vs "2.0.2" or "2.1.0" vs "2.0.20").
     * Handles "v" prefix if present (e.g. "v2.1.0").
     * Returns true if serverVersion is strictly newer than currentVersion.
     */
    fun isServerVersionNewer(serverVersion: String, currentVersion: String): Boolean {
        try {
            val cleanServer = serverVersion.trim().lowercase().removePrefix("v")
            val cleanCurrent = currentVersion.trim().lowercase().removePrefix("v")

            if (cleanServer == cleanCurrent) return false

            val v1Parts = cleanServer.split(".").mapNotNull { part ->
                part.takeWhile { it.isDigit() }.toIntOrNull()
            }
            val v2Parts = cleanCurrent.split(".").mapNotNull { part ->
                part.takeWhile { it.isDigit() }.toIntOrNull()
            }

            val maxLength = maxOf(v1Parts.size, v2Parts.size)
            for (i in 0 until maxLength) {
                val p1 = v1Parts.getOrElse(i) { 0 }
                val p2 = v2Parts.getOrElse(i) { 0 }
                if (p1 > p2) return true
                if (p1 < p2) return false
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return false
    }
}
