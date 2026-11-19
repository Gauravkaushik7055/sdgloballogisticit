import { Router } from 'express';
import { requireAuth, requireRole, writeAuditLog, type AuthRequest } from '../auth.ts';
import {
  exportDatabaseSnapshotForCloud,
  getCloudBootstrapState,
  hydrateDatabaseFromCloudSnapshot,
  verifyFirebaseIdTokenViaIdentityToolkit,
} from '../cloudDbService.ts';
import { isLocalDatabaseFresh, markLocalDatabaseCloudSynced } from '../googleDriveSync.ts';

const CLOUD_OWNER_EMAIL = 'a88593347@gmail.com';
const router = Router();

// Public/bootstrap check so freshly restarted containers can auto-recover from Cloud Firestore
router.get('/cloud-db/bootstrap-status', (_req, res) => {
  res.json(getCloudBootstrapState());
});

// Export full database snapshot for authenticated Super Admin to sync to Cloud Firestore
router.get('/cloud-db/export', requireAuth, requireRole('super_admin'), (_req, res) => {
  res.json(exportDatabaseSnapshotForCloud());
});

// Mark local runtime SQLite as synchronized with Cloud Firestore so future edits always push forward
router.post('/cloud-db/mark-synced', requireAuth, requireRole('super_admin'), (req, res) => {
  const lastSeq = typeof req.body?.lastSeq === 'number' ? req.body.lastSeq : undefined;
  const cloudUpdatedAtIso =
    typeof req.body?.cloudUpdatedAtIso === 'string' ? req.body.cloudUpdatedAtIso : null;
  markLocalDatabaseCloudSynced('firestore_sync', lastSeq, cloudUpdatedAtIso);
  res.json({ ok: true });
});

// Manual or authenticated restore from Cloud Firestore into server runtime SQLite
router.post('/cloud-db/hydrate', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const result = await hydrateDatabaseFromCloudSnapshot(req.body, {
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      source: 'super_admin',
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to hydrate database from Cloud Firestore.' });
  }
});

// Automatic startup recovery using verified Google Firebase ID token ONLY when local server DB is fresh
router.post('/cloud-db/auto-hydrate', async (req, res) => {
  try {
    const idToken = (req.header('X-Firebase-Id-Token') || '').trim();
    if (!idToken) {
      return res.status(401).json({ error: 'X-Firebase-Id-Token header is required.' });
    }
    const verified = await verifyFirebaseIdTokenViaIdentityToolkit(idToken);
    if (verified.email.trim().toLowerCase() !== CLOUD_OWNER_EMAIL) {
      writeAuditLog({
        userEmail: verified.email,
        action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        entityType: 'cloud_db_auto_hydrate',
        entityId: verified.uid,
        details: { reason: 'Firebase user not on authorized Cloud Firestore restore allowlist' },
        ipAddress: req.ip,
      });
      return res.status(403).json({
        error: `Access denied: only the authorized owner account (${CLOUD_OWNER_EMAIL}) may auto-hydrate Cloud Firestore.`,
      });
    }
    if (!isLocalDatabaseFresh()) {
      return res.json({ ok: true, skipped: true, reason: 'database_already_populated' });
    }
    const result = await hydrateDatabaseFromCloudSnapshot(req.body, {
      userId: null,
      userEmail: verified.email,
      roleName: 'super_admin',
      source: 'firebase_boot',
    });
    res.json({ ...result, skipped: false });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Cloud Firestore auto-hydration failed.' });
  }
});

export default router;
