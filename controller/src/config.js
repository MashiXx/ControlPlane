import { fileURLToPath } from 'node:url';
import path from 'node:path';

// controller/src/config.js → project root is two levels up (src → controller → repo).
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadControllerConfig() {
  // When the dashboard is enabled (password hash present), the cookie-signing
  // secret must be a real, sufficiently long secret — otherwise sessions are
  // signed with the placeholder default and can be trivially forged.
  if (process.env.DASHBOARD_PASSWORD_HASH) {
    const secret = process.env.CONTROLLER_JWT_SECRET ?? '';
    if (!secret || secret === 'change-me' || secret === 'change-me-in-prod' || secret.length < 32) {
      throw new Error(
        'CONTROLLER_JWT_SECRET must be set to a non-default value of at least 32 characters when DASHBOARD_PASSWORD_HASH is set'
      );
    }
  }

  return {
    host: process.env.CONTROLLER_HOST ?? '0.0.0.0',
    port: Number(process.env.CONTROLLER_PORT ?? 8080),
    jwtSecret: process.env.CONTROLLER_JWT_SECRET ?? 'change-me',
    apiTokens: parseApiTokens(process.env.CONTROLLER_API_TOKENS ?? ''),
    dashboardPasswordHash: process.env.DASHBOARD_PASSWORD_HASH ?? '',
    isProd: process.env.NODE_ENV === 'production',
    db: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? 'root',
      database: process.env.DB_NAME ?? 'controlplane',
      connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10),
    },
    // Controller-side build + artifact storage. All ephemeral/app-owned files
    // live under a single project-local `tmp/` tree by default so operators
    // can tail and inspect them next to the source. CP_TMP_DIR moves the whole
    // tree; the per-subdir vars override a single leaf.
    ...resolveTmpLayout(),
  };
}

function resolveTmpLayout() {
  const tmpDir = resolveDir(process.env.CP_TMP_DIR, path.join(PROJECT_ROOT, 'tmp'));
  return {
    tmpDir,
    buildWorkdirBase: resolveDir(process.env.BUILD_WORKDIR_BASE, path.join(tmpDir, 'builds')),
    rsyncStagingDir:  resolveDir(process.env.RSYNC_STAGING_DIR,  path.join(tmpDir, 'staging')),
    artifactStoreDir: resolveDir(process.env.ARTIFACT_STORE_DIR, path.join(tmpDir, 'artifacts')),
  };
}

function resolveDir(envValue, fallbackAbs) {
  if (envValue && envValue.trim()) {
    const v = envValue.trim();
    return path.isAbsolute(v) ? v : path.resolve(PROJECT_ROOT, v);
  }
  return fallbackAbs;
}

// CONTROLLER_API_TOKENS format: "name:token,name:token"
// Returns: [{ name, token }]
function parseApiTokens(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, ...rest] = s.split(':');
    return { name: name.trim(), token: rest.join(':').trim() };
  }).filter((t) => t.name && t.token);
}
