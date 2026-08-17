package com.example.telegrambackup.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Entity(
    tableName = "chunk_upload_progress",
    primaryKeys = ["sourcePath", "chunkIndex"]
)
data class ChunkProgressEntity(
    val sourcePath: String,
    val chunkIndex: Int,
    val totalChunks: Int,
    val telegramFileId: String,
    val messageId: Long,
    val chunkSize: Long,
    val status: String = "COMPLETED",
    val uploadedAt: Long = System.currentTimeMillis()
)

@Dao
interface ChunkProgressDao {
    @Query("SELECT * FROM chunk_upload_progress WHERE sourcePath = :sourcePath ORDER BY chunkIndex ASC")
    fun getUploadedChunksForFile(sourcePath: String): List<ChunkProgressEntity>

    @Query("SELECT * FROM chunk_upload_progress WHERE sourcePath = :sourcePath AND chunkIndex = :chunkIndex LIMIT 1")
    fun getChunk(sourcePath: String, chunkIndex: Int): ChunkProgressEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insert(chunk: ChunkProgressEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAll(chunks: List<ChunkProgressEntity>)

    @Query("DELETE FROM chunk_upload_progress WHERE sourcePath = :sourcePath AND chunkIndex = :chunkIndex")
    fun deleteChunk(sourcePath: String, chunkIndex: Int)

    @Query("DELETE FROM chunk_upload_progress WHERE sourcePath = :sourcePath")
    fun deleteChunksForFile(sourcePath: String)

    @Query("SELECT MAX(messageId) FROM chunk_upload_progress")
    fun getMaxMessageId(): Long?

    @Query("DELETE FROM chunk_upload_progress")
    fun deleteAll()
}
