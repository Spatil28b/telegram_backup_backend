package com.example.telegrambackup.data;

import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import java.util.List;

@Dao
public interface UploadedFileDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insert(UploadedFile file);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertAll(List<UploadedFile> files);

    @Query("SELECT * FROM uploaded_files WHERE isDeleted = 0 ORDER BY timestamp DESC")
    List<UploadedFile> getAllFiles();

    @Query("SELECT * FROM uploaded_files WHERE isDeleted = 0 AND isDriveUpload = 1 ORDER BY timestamp DESC")
    List<UploadedFile> getDriveFiles();

    @Query("SELECT * FROM uploaded_files WHERE isDeleted = 1 ORDER BY deletedAt DESC")
    List<UploadedFile> getTrashFiles();

    @Query("SELECT * FROM uploaded_files WHERE path = :path LIMIT 1")
    UploadedFile getFileByPath(String path);

    @Query("SELECT COUNT(*) FROM uploaded_files WHERE isDeleted = 0")
    int getCount();

    @Query("UPDATE uploaded_files SET isDeleted = 1, deletedAt = :now WHERE path = :path OR telegramFileId = :telegramFileId")
    void softDelete(String path, String telegramFileId, long now);

    @Query("UPDATE uploaded_files SET isDeleted = 0, deletedAt = 0 WHERE path = :path OR telegramFileId = :telegramFileId")
    void restoreFile(String path, String telegramFileId);

    @Query("DELETE FROM uploaded_files WHERE telegramFileId = :telegramFileId")
    void deleteByTelegramFileId(String telegramFileId);

    @Query("DELETE FROM uploaded_files WHERE path = :path")
    void deleteByPath(String path);

    @Query("DELETE FROM uploaded_files WHERE isDeleted = 1 AND deletedAt > 0 AND deletedAt < :cutoffTimestamp")
    void deleteExpiredTrash(long cutoffTimestamp);

    @Query("SELECT MAX(messageId) FROM uploaded_files")
    Long getMaxMessageId();

    @Query("DELETE FROM uploaded_files")
    void deleteAll();
}
