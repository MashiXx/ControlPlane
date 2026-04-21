-- Migration 004: agentless controller.
--
-- Collapses ControlPlane onto a single process: the controller drives every
-- target-server action over SSH. The agent workspace is deleted in this same
-- branch, so columns/values that only existed to support the WS agent are
-- dropped here.
--
-- One-way migration. Prior agent deployments are not supported after this.
--
-- Safe to apply while the controller is off. Mutates:
--   - applications.build_strategy        shrunk to a single value
--   - applications.builder_server_id     dropped (+ FK + index)
--   - servers.auth_token_hash            dropped (+ UNIQUE key)
--   - servers.agent_version              dropped
--   - servers.artifact_transfer          dropped (rsync+ssh is the only path)
--
-- Ordering notes:
--   - UPDATE first so the following ALTER … ENUM doesn't reject stale rows.
--   - Drop FK / UNIQUE before the column in every block (MySQL refuses
--     otherwise).
--   - If a previous attempt partially applied, re-running is safe: each step
--     is guarded against "column doesn't exist" via information_schema.

USE controlplane;

-- ─── applications ────────────────────────────────────────────────────────
-- Existing rows may still carry 'target' or 'builder'. We treat both as
-- 'controller' — the agent paths they relied on are gone.
UPDATE applications SET build_strategy = 'controller'
 WHERE build_strategy IN ('target', 'builder');

ALTER TABLE applications
  MODIFY COLUMN build_strategy ENUM('controller') NOT NULL DEFAULT 'controller';

-- builder_server_id pointed at a (never-shipped) builder pool. Gone.
SET @fk := (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE()
               AND TABLE_NAME = 'applications'
               AND CONSTRAINT_NAME = 'fk_applications_builder');
SET @sql := IF(@fk IS NOT NULL, 'ALTER TABLE applications DROP FOREIGN KEY fk_applications_builder', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_builder' LIMIT 1);
SET @sql := IF(@idx IS NOT NULL, 'ALTER TABLE applications DROP INDEX idx_applications_builder', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND COLUMN_NAME = 'builder_server_id');
SET @sql := IF(@col IS NOT NULL, 'ALTER TABLE applications DROP COLUMN builder_server_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── servers ─────────────────────────────────────────────────────────────
-- Drop UNIQUE before the column (MySQL rejects in reverse).
SET @uk := (SELECT INDEX_NAME FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'servers'
               AND INDEX_NAME = 'uq_servers_token' LIMIT 1);
SET @sql := IF(@uk IS NOT NULL, 'ALTER TABLE servers DROP INDEX uq_servers_token', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'servers'
                AND COLUMN_NAME = 'auth_token_hash');
SET @sql := IF(@col IS NOT NULL, 'ALTER TABLE servers DROP COLUMN auth_token_hash', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'servers'
                AND COLUMN_NAME = 'agent_version');
SET @sql := IF(@col IS NOT NULL, 'ALTER TABLE servers DROP COLUMN agent_version', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'servers'
                AND COLUMN_NAME = 'artifact_transfer');
SET @sql := IF(@col IS NOT NULL, 'ALTER TABLE servers DROP COLUMN artifact_transfer', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
