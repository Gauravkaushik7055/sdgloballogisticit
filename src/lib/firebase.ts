import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  onIdTokenChanged,
  setPersistence,
} from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Explicitly enforce permanent browser persistence across refreshes and browser restarts
setPersistence(auth, browserLocalPersistence).catch(() => {
  setPersistence(auth, indexedDBLocalPersistence).catch(() => {
    // fallback to SDK default persistence if storage is restricted
  });
});

function createPersistentFirestore(): Firestore {
  const dbId = firebaseConfig.firestoreDatabaseId || undefined;
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      dbId
    );
  } catch {
    return dbId ? getFirestore(app, dbId) : getFirestore(app);
  }
}

export const db = createPersistentFirestore();

let tokenKeepaliveStarted = false;

export function startFirebaseTokenKeepalive(): void {
  if (tokenKeepaliveStarted || typeof window === 'undefined') return;
  tokenKeepaliveStarted = true;

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const clearTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  onIdTokenChanged(auth, (fbUser) => {
    clearTimer();
    if (!fbUser) return;
    // Proactively refresh the Firebase Auth ID token every 45 minutes while online
    // so permanent Cloud Firestore sync and recovery tokens never lapse.
    refreshTimer = setInterval(() => {
      if (auth.currentUser && navigator.onLine !== false) {
        auth.currentUser.getIdToken(true).catch(() => {});
      }
    }, 45 * 60 * 1000);
  });

  window.addEventListener('online', () => {
    if (auth.currentUser) {
      auth.currentUser.getIdToken(true).catch(() => {});
    }
  });
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let connectionTested = false;

export async function testConnection(): Promise<boolean> {
  if (!auth.currentUser) {
    return false;
  }
  if (connectionTested) return true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    connectionTested = true;
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
    return false;
  }
}

export { firebaseConfig };
