// Picks the right artifact transfer strategy per server and returns an
// ArtifactDescriptor ready to ship inside the EXECUTE frame.
//
//   http  → agent pulls via signed URL from the controller
//   rsync → controller pushes via rsync + ssh; the agent receives a
//           `prestagedPath` and skips the download.

import { ArtifactTransfer } from '@cp/shared/constants';
import { issueArtifactToken } from '../build/artifactTokens.js';
import { pushArtifact } from './rsyncTransfer.js';
import { createLogger } from '@cp/shared/logger';

const logger = createLogger({ service: 'transport.artifact' });

/**
 * @returns {Promise<object>} ArtifactDescriptor
 */
export async function prepareArtifactForTarget({
  server, app, artifact, releaseId, secret, publicBaseUrl, stagingBase,
}) {
  const base = {
    id: Number(artifact.id),
    sha256: artifact.sha256,
    sizeBytes: Number(artifact.size_bytes ?? artifact.sizeBytes),
    releaseId,
  };

  if (server.artifact_transfer === ArtifactTransfer.RSYNC) {
    logger.info({ serverId: server.id, artifactId: artifact.id }, 'transport:rsync');
    const { prestagedPath } = await pushArtifact({
      server, artifact, remoteInstallPath: app.remote_install_path, releaseId, stagingBase,
    });
    return { ...base, prestagedPath };
  }

  // default: HTTP pull
  const token = issueArtifactToken({ secret, artifactId: artifact.id });
  const url   = `${publicBaseUrl}/artifacts/${artifact.id}/blob?token=${encodeURIComponent(token)}`;
  return { ...base, downloadUrl: url, downloadToken: token };
}
