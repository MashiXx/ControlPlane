-- 001_artifacts_and_build_strategy.sql
-- Adds build-once-deploy-many support:
--   - applications.build_strategy + artifact location
--   - servers.artifact_transfer + ssh_config (for rsync push)
--   - new artifacts table
-- Idempotent: safe to re-run.

USE controlplane;

-- ─── applications ───────────────────────────────────────────────────────
-- MySQL 8 supports IF NOT EXISTS on ADD COLUMN as of 8.0.29. Use a
-- defensive approach via information_schema for portability.

SET @s := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications' AND COLUMN_NAME = 'build_strategy');
SET @sql := IF(@s = 0,
  "ALTER TABLE applications
     ADD COLUMN build_strategy ENUM('target','controller','builder') NOT NULL DEFAULT 'target' AFTER runtime,
     ADD COLUMN artifact_pattern     VARCHAR(255) NULL AFTER build_strategy,
     ADD COLUMN remote_install_path  VARCHAR(512) NULL AFTER artifact_pattern,
     ADD COLUMN builder_server_id    BIGINT UNSIGNED NULL AFTER remote_install_path,
     ADD COLUMN launch_mode ENUM('wrapped','raw','pm2','systemd') NOT NULL DEFAULT 'wrapped' AFTER stop_cmd,
     ADD COLUMN status_cmd VARCHAR(512) NULL AFTER launch_mode,
     ADD COLUMN logs_cmd   VARCHAR(512) NULL AFTER status_cmd,
     ADD KEY idx_applications_builder (builder_server_id),
     ADD CONSTRAINT fk_applications_builder FOREIGN KEY (builder_server_id) REFERENCES servers(id) ON DELETE SET NULL",
  "SELECT 'applications already migrated'");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── servers ────────────────────────────────────────────────────────────
SET @s := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'servers' AND COLUMN_NAME = 'artifact_transfer');
SET @sql := IF(@s = 0,
  "ALTER TABLE servers
     ADD COLUMN artifact_transfer ENUM('http','rsync') NOT NULL DEFAULT 'http' AFTER labels,
     ADD COLUMN ssh_config JSON NULL AFTER artifact_transfer",
  "SELECT 'servers already migrated'");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── artifacts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id  BIGINT UNSIGNED NOT NULL,
  commit_sha      CHAR(40)      NULL,
  branch          VARCHAR(128)  NOT NULL,
  config_hash     CHAR(64)      NOT NULL,    -- sha256(install_cmd|build_cmd|artifact_pattern)
  sha256          CHAR(64)      NOT NULL,    -- sha256 of tar.gz
  path            VARCHAR(512)  NOT NULL,    -- controller-local path to tar.gz
  size_bytes      BIGINT UNSIGNED NOT NULL,
  build_job_id    BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_artifacts_dedupe (application_id, sha256),
  KEY idx_artifacts_app_commit (application_id, commit_sha),
  KEY idx_artifacts_build      (build_job_id),
  CONSTRAINT fk_artifacts_app   FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_artifacts_build FOREIGN KEY (build_job_id)   REFERENCES jobs(id)         ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ─── deployments: point to the artifact actually rolled out ────────────
SET @s := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deployments' AND COLUMN_NAME = 'artifact_id');
SET @sql := IF(@s = 0,
  "ALTER TABLE deployments
     ADD COLUMN artifact_id BIGINT UNSIGNED NULL AFTER branch,
     ADD COLUMN release_id  VARCHAR(64)     NULL AFTER artifact_id,
     ADD COLUMN previous_release_id VARCHAR(64) NULL AFTER release_id,
     ADD KEY idx_deployments_artifact (artifact_id),
     ADD CONSTRAINT fk_deployments_artifact FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL",
  "SELECT 'deployments already migrated'");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
