-- Migration 005: multi-server application replicas.
--
-- Introduces `application_servers` — a many-to-many replica table that also
-- carries per-replica runtime state (process_state, expected_state, pid,
-- timestamps, alert debounce, currently-deployed release). The matching
-- state columns on `applications` are dropped; `applications.server_id` is
-- dropped; the old `UNIQUE (name, server_id)` key collapses to `UNIQUE (name)`.
--
-- Forward-only. Apply with the controller off.

USE controlplane;

-- 1. Guard: dedupe app names first — UNIQUE (name) is enforced later.
SET @dup := (SELECT COUNT(*) FROM (
  SELECT name FROM applications GROUP BY name HAVING COUNT(*) > 1
) t);
SET @sql := IF(@dup > 0,
  'SIGNAL SQLSTATE "45000" SET MESSAGE_TEXT = "duplicate application names — dedupe before migrating"',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Create application_servers.
CREATE TABLE IF NOT EXISTS application_servers (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id       BIGINT UNSIGNED NOT NULL,
  server_id            BIGINT UNSIGNED NOT NULL,

  process_state        ENUM('running','stopped','crashed','starting','unknown')
                         NOT NULL DEFAULT 'unknown',
  expected_state       ENUM('running','stopped') NOT NULL DEFAULT 'stopped',
  pid                  INT UNSIGNED NULL,
  last_started_at      TIMESTAMP NULL,
  last_exit_code       INT NULL,
  last_exit_at         TIMESTAMP NULL,
  uptime_seconds       BIGINT UNSIGNED NULL,
  last_alert_at        TIMESTAMP NULL,
  unreachable_count    INT NOT NULL DEFAULT 0,

  current_release_id   VARCHAR(64) NULL,
  current_artifact_id  BIGINT UNSIGNED NULL,

  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                         ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_application_servers_pair (application_id, server_id),
  KEY idx_application_servers_server    (server_id),
  KEY idx_application_servers_state     (process_state),
  CONSTRAINT fk_app_servers_app
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_app_servers_server
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_app_servers_artifact
    FOREIGN KEY (current_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 3. Seed replicas from the existing applications rows (only rows with a server_id).
-- Guard: only run if server_id column still exists on applications (skip on re-run).
SET @col := (SELECT COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND COLUMN_NAME = 'server_id');
SET @sql := IF(@col IS NOT NULL,
  'INSERT IGNORE INTO application_servers
     (application_id, server_id, process_state, expected_state,
      pid, last_started_at, last_exit_code, last_exit_at,
      uptime_seconds, last_alert_at)
   SELECT id, server_id,
          process_state, expected_state,
          pid, last_started_at, last_exit_code, last_exit_at,
          uptime_seconds, last_alert_at
     FROM applications
    WHERE server_id IS NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Drop the FK + indexes + columns from applications.
-- Drop FK first, then indexes, then the column (MySQL rejects in reverse).
SET @fk := (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE()
               AND TABLE_NAME = 'applications'
               AND CONSTRAINT_NAME = 'fk_applications_server');
SET @sql := IF(@fk IS NOT NULL, 'ALTER TABLE applications DROP FOREIGN KEY fk_applications_server', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_server' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX idx_applications_server', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_state' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX idx_applications_state', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'uq_applications_name_server' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX uq_applications_name_server', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND COLUMN_NAME = 'server_id');
SET @sql := IF(@col IS NOT NULL,
  'ALTER TABLE applications DROP COLUMN server_id, DROP COLUMN process_state, DROP COLUMN expected_state, DROP COLUMN pid, DROP COLUMN last_started_at, DROP COLUMN last_exit_code, DROP COLUMN last_exit_at, DROP COLUMN uptime_seconds, DROP COLUMN last_alert_at',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. Collapse the compound unique key to a single-column UNIQUE (name).
SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'uq_applications_name' LIMIT 1);
SET @sql := IF(@idx IS NULL,
  'ALTER TABLE applications ADD UNIQUE KEY uq_applications_name (name)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
