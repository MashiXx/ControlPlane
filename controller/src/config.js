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
    jobDispatchTimeoutMs: Number(process.env.JOB_DISPATCH_TIMEOUT_MS ?? 15 * 60 * 1000),
    heartbeatMissLimitMs: Number(process.env.HEARTBEAT_MISS_MS ?? 35_000),

    // Controller-side build + artifact storage
    artifactStoreDir: process.env.ARTIFACT_STORE_DIR ?? '/var/lib/controlplane/artifacts',
    // Secret used to sign artifact download URLs (distinct from jwtSecret)
    artifactSecret:   process.env.ARTIFACT_SIGNING_SECRET ?? process.env.CONTROLLER_JWT_SECRET ?? 'change-me',
    // How agents reach the controller for artifact download (host:port external)
    publicBaseUrl:    process.env.CONTROLLER_PUBLIC_URL ?? 'http://127.0.0.1:8080',
  };
}

// CONTROLLER_API_TOKENS format: "name:token,name:token"
// Returns: [{ name, token }]
function parseApiTokens(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, ...rest] = s.split(':');
    return { name: name.trim(), token: rest.join(':').trim() };
  }).filter((t) => t.name && t.token);
}
