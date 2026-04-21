-- Migration 006: single-placement applications.
--
-- Each application now belongs to exactly ONE server OR exactly ONE
-- server_group — never both, never multiple ad-hoc servers. The many-to-many
-- `application_servers` table stays, but its rows are now DERIVED from the
-- application's placement column (controller-managed, not hand-edited):
--   applications.server_id IS NOT NULL        → one row per app.
--   applications.server_group_id IS NOT NULL  → one row per group member.
--
-- At most-one is enforced by CHECK; exactly-one is enforced at the
-- application layer (zod + repository) so existing rows with no replicas
-- don't block the migration.
--
-- Forward-only. Apply with the controller off.

USE controlplane;

-- 1. Add columns (nullable). Idempotent if the migration is rerun.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME   = 'applications'
                AND COLUMN_NAME  = 'server_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE applications ADD COLUMN server_id BIGINT UNSIGNED NULL AFTER group_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME   = 'applications'
                AND COLUMN_NAME  = 'server_group_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE applications ADD COLUMN server_group_id BIGINT UNSIGNED NULL AFTER server_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Backfill placement from existing replicas.
--
-- Strategy: if an app currently has a single replica, pin its server_id.
-- If it has multiple replicas that exactly match one server_group's
-- membership, pin its server_group_id. Otherwise leave both NULL — an
-- operator will have to edit the app to assign a placement before actions
-- on it succeed.
UPDATE applications a
   SET a.server_id = (
         SELECT ar.server_id FROM application_servers ar
          WHERE ar.application_id = a.id
          LIMIT 1
       )
 WHERE a.server_id IS NULL
   AND a.server_group_id IS NULL
   AND (SELECT COUNT(*) FROM application_servers ar
         WHERE ar.application_id = a.id) = 1;

-- Apps with multiple replicas whose exact set matches one server_group →
-- prefer the group placement (preserves fan-out intent from the old model).
UPDATE applications a
  JOIN (
        SELECT ar.application_id, sg.id AS sg_id
          FROM application_servers ar
          JOIN server_group_members sgm
            ON sgm.server_id = ar.server_id
          JOIN server_groups sg
            ON sg.id = sgm.server_group_id
         GROUP BY ar.application_id, sg.id
        HAVING COUNT(DISTINCT ar.server_id) = (
                 SELECT COUNT(*) FROM server_group_members
                  WHERE server_group_id = sg.id)
           AND COUNT(DISTINCT ar.server_id) = (
                 SELECT COUNT(*) FROM application_servers
                  WHERE application_id = ar.application_id)
       ) m ON m.application_id = a.id
   SET a.server_group_id = m.sg_id
 WHERE a.server_id IS NULL
   AND a.server_group_id IS NULL;

-- 3. Foreign keys.
SET @fk := (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE()
               AND TABLE_NAME = 'applications'
               AND CONSTRAINT_NAME = 'fk_applications_server');
SET @sql := IF(@fk IS NULL,
  'ALTER TABLE applications
     ADD CONSTRAINT fk_applications_server
       FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE()
               AND TABLE_NAME = 'applications'
               AND CONSTRAINT_NAME = 'fk_applications_server_group');
SET @sql := IF(@fk IS NULL,
  'ALTER TABLE applications
     ADD CONSTRAINT fk_applications_server_group
       FOREIGN KEY (server_group_id) REFERENCES server_groups(id) ON DELETE RESTRICT',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. At-most-one placement. Exactly-one is enforced by the application
-- layer; this check exists so a concurrent UPDATE can't ever set both.
SET @chk := (SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS
              WHERE CONSTRAINT_SCHEMA = DATABASE()
                AND CONSTRAINT_NAME = 'chk_applications_placement');
SET @sql := IF(@chk IS NULL,
  'ALTER TABLE applications
     ADD CONSTRAINT chk_applications_placement
       CHECK (NOT (server_id IS NOT NULL AND server_group_id IS NOT NULL))',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. Indexes on the new placement columns.
SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_server_id' LIMIT 1);
SET @sql := IF(@idx IS NULL,
  'ALTER TABLE applications ADD INDEX idx_applications_server_id (server_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'applications'
                AND INDEX_NAME = 'idx_applications_server_group_id' LIMIT 1);
SET @sql := IF(@idx IS NULL,
  'ALTER TABLE applications ADD INDEX idx_applications_server_group_id (server_group_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
