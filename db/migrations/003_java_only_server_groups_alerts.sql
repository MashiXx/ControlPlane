-- 003_java_only_server_groups_alerts.sql
--
-- Phase-1 refactor of the application lifecycle:
--   1. Runtime is locked to 'java' (Node.js + PM2 support is deferred).
--   2. `server_groups` and `server_group_members` are introduced so the
--      deploy pipeline can fan out to multiple servers by group name.
--   3. `applications.expected_state` + `last_alert_at` drive alert-on-down:
--      the controller compares agent-reported process_state against what
--      the operator last asked for and pages on unexpected regressions.
--   4. `jobs.target_type` gets the new 'server_group' value so audit &
--      orchestrator rows correctly reflect fan-out jobs.
--
-- Idempotent: safe to re-run.

USE controlplane;

-- ─── 1. Runtime: lock to 'java' ─────────────────────────────────────────
-- Migrate any existing 'node' rows to 'java' so the new ENUM accepts them.
UPDATE applications SET runtime = 'java' WHERE runtime <> 'java';

-- Collapse the runtime enum down to java only. The enum keeps its shape for
-- forward compatibility when Node.js returns in phase 2.
ALTER TABLE applications
  MODIFY COLUMN runtime ENUM('java') NOT NULL DEFAULT 'java';

-- ─── 2. LaunchMode: drop pm2 (phase 2) ──────────────────────────────────
-- Anything currently flagged pm2 falls back to the wrapped launcher.
UPDATE applications SET launch_mode = 'wrapped' WHERE launch_mode = 'pm2';

ALTER TABLE applications
  MODIFY COLUMN launch_mode ENUM('wrapped','raw','systemd')
               NOT NULL DEFAULT 'wrapped';

-- ─── 3. expected_state + alert bookkeeping ──────────────────────────────
SET @s := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
             AND COLUMN_NAME = 'expected_state');
SET @sql := IF(@s = 0,
  "ALTER TABLE applications
     ADD COLUMN expected_state ENUM('running','stopped') NOT NULL DEFAULT 'stopped' AFTER process_state,
     ADD COLUMN last_alert_at TIMESTAMP NULL AFTER expected_state",
  "SELECT 'applications.expected_state already present'");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── 4. Server groups ────────────────────────────────────────────────────
-- A server_group is a named bundle of servers. It exists purely to drive
-- deploy fan-out — it has NO FK back from applications on purpose, so the
-- same group can be reused across apps without a cascade risk.
CREATE TABLE IF NOT EXISTS server_groups (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(64)  NOT NULL,
  description   VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_server_groups_name (name)
) ENGINE=InnoDB;

-- Many-to-many join table. Composite primary key doubles as the uniqueness
-- constraint that prevents adding the same server twice.
CREATE TABLE IF NOT EXISTS server_group_members (
  server_group_id BIGINT UNSIGNED NOT NULL,
  server_id       BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_group_id, server_id),
  KEY idx_sgm_server (server_id),
  CONSTRAINT fk_sgm_group  FOREIGN KEY (server_group_id) REFERENCES server_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_sgm_server FOREIGN KEY (server_id)       REFERENCES servers(id)       ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── 5. jobs.target_type gains 'server_group' ───────────────────────────
ALTER TABLE jobs
  MODIFY COLUMN target_type ENUM('app','group','server','server_group') NOT NULL;
