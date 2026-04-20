-- 002_drop_ssh_config
-- -----------------------------------------------------------------------
-- Drop servers.ssh_config column.
--
-- The controller no longer stores SSH connection details per server. When
-- artifact_transfer='rsync', the controller invokes `ssh <hostname>` and
-- `rsync ... <hostname>:...`, which OpenSSH resolves through its standard
-- ~/.ssh/config lookup. User, Port, IdentityFile, ProxyJump, etc. live
-- there — not in the database.
--
-- Apply manually:
--   mysql -uroot -p controlplane < db/migrations/002_drop_ssh_config.sql

SET @has_column := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'servers'
    AND column_name = 'ssh_config'
);

SET @sql := IF(@has_column > 0,
  'ALTER TABLE servers DROP COLUMN ssh_config',
  'SELECT "column ssh_config already dropped" AS noop'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
