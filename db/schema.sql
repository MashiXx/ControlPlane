-- ControlPlane — MySQL 8 schema
-- Charset: utf8mb4 throughout. Engine: InnoDB for transactional integrity.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS controlplane
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
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
-- servers — physical or virtual hosts running an agent
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS servers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  hostname        VARCHAR(255)  NOT NULL,
  -- SHA-256 hash of the bearer token the agent presents on connect.
  -- Raw token is shown to the operator exactly once at provisioning time.
  auth_token_hash CHAR(64)      NOT NULL,
  -- operational state
  status          ENUM('online','offline','unreachable','draining')
                  NOT NULL DEFAULT 'offline',
  last_seen_at    TIMESTAMP     NULL,
  agent_version   VARCHAR(32)   NULL,
  os              VARCHAR(64)   NULL,
  -- free-form JSON for labels like {"region":"eu","env":"prod"}
  labels          JSON          NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_servers_name (name),
  UNIQUE KEY uq_servers_token (auth_token_hash),
  KEY idx_servers_status (status),
  KEY idx_servers_last_seen (last_seen_at)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- applications — a managed process on a specific server
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  server_id       BIGINT UNSIGNED NOT NULL,
  group_id        BIGINT UNSIGNED NULL,

  runtime         ENUM('node','java') NOT NULL,
  -- git
  repo_url        VARCHAR(512)  NULL,
  branch          VARCHAR(128)  NOT NULL DEFAULT 'main',
  -- Absolute path on the target server. Must be inside AGENT_WORKDIR.
  workdir         VARCHAR(512)  NOT NULL,
  -- Shell-quoted commands. Only built-in templates are accepted unless
  -- the app is flagged as trusted (see `trusted` below).
  install_cmd     VARCHAR(512)  NULL,
  build_cmd       VARCHAR(512)  NULL,
  start_cmd       VARCHAR(512)  NOT NULL,
  stop_cmd        VARCHAR(512)  NULL,
  health_cmd      VARCHAR(512)  NULL,
  -- env vars are serialized as JSON object, opaque to the controller
  env             JSON          NULL,

  -- runtime state (updated by agent heartbeats / events)
  process_state   ENUM('running','stopped','crashed','starting','unknown')
                  NOT NULL DEFAULT 'unknown',
  pid             INT UNSIGNED  NULL,
  last_started_at TIMESTAMP     NULL,
  last_exit_code  INT           NULL,
  last_exit_at    TIMESTAMP     NULL,
  uptime_seconds  BIGINT UNSIGNED NULL,

  -- controls whether raw (non-templated) commands are permitted for this app
  trusted         TINYINT(1)    NOT NULL DEFAULT 0,
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,

  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_applications_name_server (name, server_id),
  KEY idx_applications_group (group_id),
  KEY idx_applications_server (server_id),
  KEY idx_applications_state (process_state),
  CONSTRAINT fk_applications_server  FOREIGN KEY (server_id) REFERENCES servers(id)   ON DELETE RESTRICT,
  CONSTRAINT fk_applications_group   FOREIGN KEY (group_id)  REFERENCES `groups`(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- jobs — every queued action is recorded here
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- BullMQ job id (string). Unique so the worker and API can dedupe.
  queue_job_id    VARCHAR(64)   NOT NULL,
  -- Parent job, used when a group action fans out into N per-app jobs.
  parent_job_id   BIGINT UNSIGNED NULL,
  idempotency_key VARCHAR(128)  NULL,

  action          ENUM('start','stop','restart','build','deploy','healthcheck')
                  NOT NULL,
  target_type     ENUM('app','group','server') NOT NULL,
  application_id  BIGINT UNSIGNED NULL,
  group_id        BIGINT UNSIGNED NULL,
  server_id       BIGINT UNSIGNED NULL,

  status          ENUM('pending','running','success','failed','cancelled')
                  NOT NULL DEFAULT 'pending',
  attempts        INT UNSIGNED  NOT NULL DEFAULT 0,
  max_attempts    INT UNSIGNED  NOT NULL DEFAULT 3,

  -- user who triggered the job: e.g. "telegram:12345", "web:alice", "system"
  triggered_by    VARCHAR(128)  NOT NULL,
  -- request payload (as submitted) and final result (stdout/stderr, timings)
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

  actor           VARCHAR(128)  NOT NULL,   -- "telegram:12345" / "web:alice" / "system"
  action          VARCHAR(64)   NOT NULL,   -- "restart","build","deploy","agent.connect", ...
  target_type     VARCHAR(32)   NOT NULL,   -- "app","group","server","job"
  target_id       VARCHAR(64)   NULL,       -- stringified id or name
  job_id          BIGINT UNSIGNED NULL,

  result          ENUM('success','failure','info') NOT NULL,
  http_status     SMALLINT UNSIGNED NULL,
  -- last ~8KB of stdout/stderr or controller-side message
  message         TEXT          NULL,
  -- structured metadata (ip, user-agent, diff, etc.)
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
  status          ENUM('pending','building','deployed','failed','rolled_back')
                  NOT NULL DEFAULT 'pending',

  build_log_ref   VARCHAR(255)  NULL,  -- pointer to object storage / file path
  artifact_path   VARCHAR(512)  NULL,  -- resolved artifact on disk
  deployed_at     TIMESTAMP     NULL,
  rolled_back_at  TIMESTAMP     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_deployments_app      (application_id, created_at),
  KEY idx_deployments_status   (status),
  UNIQUE KEY uq_deployments_job (job_id),
  CONSTRAINT fk_deployments_app FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_deployments_job FOREIGN KEY (job_id)         REFERENCES jobs(id)         ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────────────────
-- api_tokens — for human + service clients hitting the REST API
-- Keeping separate from servers.auth_token because lifecycle is different.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_tokens (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(64)   NOT NULL,
  token_hash      CHAR(64)      NOT NULL,
  scopes          JSON          NOT NULL,  -- e.g. ["apps:read","jobs:write"]
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at    TIMESTAMP     NULL,
  revoked_at      TIMESTAMP     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_tokens_hash (token_hash),
  UNIQUE KEY uq_api_tokens_name (name)
) ENGINE=InnoDB;
