-- ControlPlane — MySQL 8 schema (agentless)
-- Charset: utf8mb4 throughout. Engine: InnoDB for transactional integrity.
--
-- Reflects migrations 001 → 004. The controller now drives every target
-- action over SSH; there is no per-server agent process, no bearer token,
-- no HTTP artifact pull. Connection details (User / Port / IdentityFile /
-- ProxyJump) live in the controller's ~/.ssh/config — nothing is per-server
-- in the DB except the hostname alias.

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS controlplane
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE controlplane;

-- ─────────────────────────────────────────────────────────────────────────
-- groups — logical grouping of applications (e.g. "payment", "core")
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `groups` (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(64)  NOT NULL,
  description   VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_groups_name (name)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- servers — target hosts the controller drives over SSH
-- ─────────────────────────────────────────────────────────────────────────
-- `hostname` is passed as-is to `ssh` and `rsync`, so it can be a DNS name,
-- a raw IP, or — most usefully — a Host alias from the controller's
-- ~/.ssh/config. All connection details live there.
CREATE TABLE IF NOT EXISTS servers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  hostname        VARCHAR(255)  NOT NULL,
  -- operational state, updated by the controller's state poller
  status          ENUM('online','offline','unreachable','draining')
                  NOT NULL DEFAULT 'offline',
  last_seen_at    TIMESTAMP     NULL,
  os              VARCHAR(64)   NULL,
  -- free-form JSON for labels like {"region":"eu","env":"prod"}
  labels          JSON          NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_servers_name (name),
  KEY idx_servers_status (status),
  KEY idx_servers_last_seen (last_seen_at)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- server_groups — named bundles of servers used as deploy fan-out targets
-- ─────────────────────────────────────────────────────────────────────────
-- Separate from `groups` (which groups *applications*). A server_group is
-- purely a rollout concept: "deploy app X to server_group eu-payments" fans
-- out into one deploy job per member server. Membership is many-to-many.
CREATE TABLE IF NOT EXISTS server_groups (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(64)  NOT NULL,
  description   VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_server_groups_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS server_group_members (
  server_group_id BIGINT UNSIGNED NOT NULL,
  server_id       BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_group_id, server_id),
  KEY idx_sgm_server (server_id),
  CONSTRAINT fk_sgm_group  FOREIGN KEY (server_group_id) REFERENCES server_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_sgm_server FOREIGN KEY (server_id)       REFERENCES servers(id)       ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- applications — a managed application (server assignment via application_servers)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  group_id        BIGINT UNSIGNED NULL,

  runtime         ENUM('java') NOT NULL DEFAULT 'java',
  build_strategy  ENUM('controller') NOT NULL DEFAULT 'controller',

  artifact_pattern     VARCHAR(255) NULL,
  remote_install_path  VARCHAR(512) NULL,

  repo_url        VARCHAR(512)  NULL,
  branch          VARCHAR(128)  NOT NULL DEFAULT 'main',
  workdir         VARCHAR(512)  NOT NULL,
  install_cmd     VARCHAR(512)  NULL,
  build_cmd       VARCHAR(512)  NULL,
  start_cmd       VARCHAR(512)  NOT NULL,
  stop_cmd        VARCHAR(512)  NULL,
  launch_mode     ENUM('wrapped','raw','systemd') NOT NULL DEFAULT 'wrapped',
  status_cmd      VARCHAR(512)  NULL,
  logs_cmd        VARCHAR(512)  NULL,
  health_cmd      VARCHAR(512)  NULL,
  env             JSON          NULL,

  trusted         TINYINT(1)    NOT NULL DEFAULT 0,
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,

  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_applications_name (name),
  KEY idx_applications_group   (group_id),
  CONSTRAINT fk_applications_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- artifacts — built binaries stored on the controller for deploy
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id  BIGINT UNSIGNED NOT NULL,
  commit_sha      CHAR(40)      NULL,
  branch          VARCHAR(128)  NOT NULL,
  config_hash     CHAR(64)      NOT NULL,
  sha256          CHAR(64)      NOT NULL,
  path            VARCHAR(512)  NOT NULL,
  size_bytes      BIGINT UNSIGNED NOT NULL,
  build_job_id    BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_artifacts_dedupe    (application_id, sha256),
  KEY idx_artifacts_app_commit      (application_id, commit_sha),
  KEY idx_artifacts_build           (build_job_id),
  CONSTRAINT fk_artifacts_app   FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_artifacts_build FOREIGN KEY (build_job_id)   REFERENCES jobs(id)         ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- application_servers — per-replica runtime state (many-to-many: apps × servers)
-- ─────────────────────────────────────────────────────────────────────────
-- Each row represents one deployed replica of an application on a given server.
-- Per-replica runtime columns (process_state, expected_state, pid, etc.) live
-- here instead of on `applications`, enabling independent state tracking per host.
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

-- ─────────────────────────────────────────────────────────────────────────
-- jobs — every queued action is recorded here
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  queue_job_id    VARCHAR(64)   NOT NULL,
  parent_job_id   BIGINT UNSIGNED NULL,
  idempotency_key VARCHAR(128)  NULL,

  action          ENUM('start','stop','restart','build','deploy','healthcheck')
                  NOT NULL,
  target_type     ENUM('app','group','server','server_group') NOT NULL,
  application_id  BIGINT UNSIGNED NULL,
  group_id        BIGINT UNSIGNED NULL,
  server_id       BIGINT UNSIGNED NULL,

  status          ENUM('pending','running','success','failed','cancelled')
                  NOT NULL DEFAULT 'pending',
  attempts        INT UNSIGNED  NOT NULL DEFAULT 0,
  max_attempts    INT UNSIGNED  NOT NULL DEFAULT 3,

  triggered_by    VARCHAR(128)  NOT NULL,
  payload         JSON          NULL,
  result          JSON          NULL,
  error_message   TEXT          NULL,
  error_code      VARCHAR(64)   NULL,

  enqueued_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at      TIMESTAMP     NULL,
  finished_at     TIMESTAMP     NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_jobs_queue_job_id (queue_job_id),
  UNIQUE KEY uq_jobs_idempotency  (idempotency_key),
  KEY idx_jobs_status_enqueued    (status, enqueued_at),
  KEY idx_jobs_app                (application_id, enqueued_at),
  KEY idx_jobs_group              (group_id, enqueued_at),
  KEY idx_jobs_parent             (parent_job_id),
  CONSTRAINT fk_jobs_parent FOREIGN KEY (parent_job_id)  REFERENCES jobs(id)         ON DELETE SET NULL,
  CONSTRAINT fk_jobs_app    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL,
  CONSTRAINT fk_jobs_group  FOREIGN KEY (group_id)       REFERENCES `groups`(id)     ON DELETE SET NULL,
  CONSTRAINT fk_jobs_server FOREIGN KEY (server_id)      REFERENCES servers(id)      ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- audit_logs — append-only record of every action taken, with output
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  actor           VARCHAR(128)  NOT NULL,
  action          VARCHAR(64)   NOT NULL,
  target_type     VARCHAR(32)   NOT NULL,
  target_id       VARCHAR(64)   NULL,
  job_id          BIGINT UNSIGNED NULL,

  result          ENUM('success','failure','info') NOT NULL,
  http_status     SMALLINT UNSIGNED NULL,
  message         TEXT          NULL,
  metadata        JSON          NULL,

  PRIMARY KEY (id),
  KEY idx_audit_occurred_at (occurred_at),
  KEY idx_audit_actor       (actor, occurred_at),
  KEY idx_audit_target      (target_type, target_id, occurred_at),
  KEY idx_audit_job         (job_id),
  CONSTRAINT fk_audit_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- deployments — snapshot per successful build/deploy
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deployments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id  BIGINT UNSIGNED NOT NULL,
  job_id          BIGINT UNSIGNED NOT NULL,

  commit_sha      CHAR(40)      NULL,
  branch          VARCHAR(128)  NOT NULL,
  artifact_id     BIGINT UNSIGNED NULL,
  release_id      VARCHAR(64)   NULL,
  previous_release_id VARCHAR(64) NULL,
  status          ENUM('pending','building','deployed','failed','rolled_back')
                  NOT NULL DEFAULT 'pending',

  build_log_ref   VARCHAR(255)  NULL,
  artifact_path   VARCHAR(512)  NULL,
  deployed_at     TIMESTAMP     NULL,
  rolled_back_at  TIMESTAMP     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_deployments_app      (application_id, created_at),
  KEY idx_deployments_status   (status),
  KEY idx_deployments_artifact (artifact_id),
  UNIQUE KEY uq_deployments_job (job_id),
  CONSTRAINT fk_deployments_app      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_deployments_job      FOREIGN KEY (job_id)         REFERENCES jobs(id)         ON DELETE RESTRICT,
  CONSTRAINT fk_deployments_artifact FOREIGN KEY (artifact_id)    REFERENCES artifacts(id)    ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- api_tokens — reserved for future per-token DB-backed auth.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_tokens (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  token_hash      CHAR(64)      NOT NULL,
  scopes          JSON          NOT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at    TIMESTAMP     NULL,
  revoked_at      TIMESTAMP     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_tokens_hash (token_hash),
  UNIQUE KEY uq_api_tokens_name (name)
) ENGINE=InnoDB;
