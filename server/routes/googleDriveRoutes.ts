import { Router } from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../auth.ts';
import {
  clearGoogleDriveSession,
  deleteSyncedDriveFile,
  getGoogleDriveStatus,
  registerGoogleDriveSession,
  runGoogleDriveSyncCycle,
  updateGoogleDriveConfig,
  verifyTargetDriveFolder,
} from '../googleDriveSync.ts';

const router = Router();

function extractGoogleToken(req: AuthRequest): string {
  const headerToken = req.header('X-Google-Access-Token') || '';
  if (headerToken.startsWith('Bearer ')) {
    return headerToken.slice(7).trim();
  }
  return headerToken.trim();
}

router.get('/integrations/google-drive/status', requireAuth, requireRole('super_admin'), (_req, res) => {
  res.json(getGoogleDriveStatus());
});

router.post('/integrations/google-drive/session', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const accessToken = extractGoogleToken(req);
    if (!accessToken) {
      return res.status(400).json({ error: 'X-Google-Access-Token header is required.' });
    }
    const confirmSync = Boolean(req.body?.confirmSync);
    const profile = await registerGoogleDriveSession({
      accessToken,
      actorUser: req.user!,
      confirmSync,
    });
    if (confirmSync) {
      await runGoogleDriveSyncCycle({ force: true, actorUser: req.user! });
    }
    res.json({ ok: true, profile, status: getGoogleDriveStatus() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to verify Google Drive OAuth session.' });
  }
});

router.post('/integrations/google-drive/disconnect', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  clearGoogleDriveSession(req.user!);
  res.json({ ok: true, status: getGoogleDriveStatus() });
});

router.put('/integrations/google-drive/config', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const incomingToken = extractGoogleToken(req);
    if (incomingToken) {
      await registerGoogleDriveSession({
        accessToken: incomingToken,
        actorUser: req.user!,
        confirmSync: Boolean(req.body?.syncConfirmed),
      });
    }
    const status = await updateGoogleDriveConfig({
      driveFolderUrl: req.body?.driveFolderUrl,
      syncIntervalMs: req.body?.syncIntervalMs,
      syncEnabled: req.body?.syncEnabled,
      syncConfirmed: req.body?.syncConfirmed,
      actorUser: req.user!,
    });
    res.json({ ok: true, status });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to update Google Drive sync configuration.' });
  }
});

router.post('/integrations/google-drive/sync-now', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const incomingToken = extractGoogleToken(req);
    if (incomingToken) {
      await registerGoogleDriveSession({
        accessToken: incomingToken,
        actorUser: req.user!,
        confirmSync: true,
      });
    }
    const result = await runGoogleDriveSyncCycle({ force: true, actorUser: req.user! });
    res.json({ ok: true, ...result, status: getGoogleDriveStatus() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Google Drive sync failed.' });
  }
});

router.post('/integrations/google-drive/verify-folder', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const incomingToken = extractGoogleToken(req);
    if (incomingToken) {
      await registerGoogleDriveSession({
        accessToken: incomingToken,
        actorUser: req.user!,
        confirmSync: false,
      });
    }
    const folder = await verifyTargetDriveFolder({
      driveFolderUrl: req.body?.driveFolderUrl,
      actorUser: req.user!,
    });
    res.json({ ok: true, folder, status: getGoogleDriveStatus() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to verify Google Drive folder access.' });
  }
});

router.delete('/integrations/google-drive/files/:fileId', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const result = await deleteSyncedDriveFile(String(req.params.fileId), req.user!);
    res.json({ ...result, status: getGoogleDriveStatus() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to delete file from Google Drive.' });
  }
});

export default router;
