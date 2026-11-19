import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, type User } from 'firebase/auth';
import { auth } from '../lib/firebase.ts';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'] as const;

const provider = new GoogleAuthProvider();
DRIVE_SCOPES.forEach((scope) => provider.addScope(scope));
provider.setCustomParameters({
  prompt: 'select_account consent',
  include_granted_scopes: 'true',
});

// Cache Google Drive OAuth access token strictly in memory (never in localStorage or sessionStorage).
// Meanwhile, Firebase Auth (`auth.currentUser`) stays persisted in IndexedDB indefinitely with zero 60-minute expiry!
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedGoogleUser: User | null = null;
let tokenIssuedAt: number | null = null;

export const initFirebaseCloudAuth = (
  onFirebaseUserReady: (user: User) => void,
  onFirebaseSignedOut?: () => void
) => {
  return onAuthStateChanged(auth, (user: User | null) => {
    cachedGoogleUser = user;
    if (user) {
      onFirebaseUserReady(user);
    } else {
      cachedAccessToken = null;
      tokenIssuedAt = null;
      if (onFirebaseSignedOut) onFirebaseSignedOut();
    }
  });
};

export const initGoogleAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void,
  onFirebaseUserOnly?: (user: User) => void
) => {
  return onAuthStateChanged(auth, (user: User | null) => {
    cachedGoogleUser = user;
    if (user) {
      if (onFirebaseUserOnly) onFirebaseUserOnly(user);
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        tokenIssuedAt = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      tokenIssuedAt = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Drive access token from Google Sign-In.');
    }
    cachedAccessToken = credential.accessToken;
    cachedGoogleUser = result.user;
    tokenIssuedAt = Date.now();
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (err: any) {
    const code = String(err?.code || '');
    const host = typeof window !== 'undefined' ? window.location.hostname : 'current domain';
    if (code === 'auth/unauthorized-domain') {
      throw new Error(
        `Firebase blocked Google Sign-In because "${host}" is not listed under Firebase Console -> Authentication -> Settings -> Authorized domains. Add "${host}" (plus ais-dev-bnfb7caj3qwg2uuy2kbaiw-643335972237.asia-northeast1.run.app and ais-pre-bnfb7caj3qwg2uuy2kbaiw-643335972237.asia-northeast1.run.app) in Firebase Console, then retry.`
      );
    }
    if (code === 'auth/popup-blocked') {
      throw new Error('Google Sign-In popup was blocked by your browser. Allow popups for this site and click Sign in with Google again.');
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new Error('Google Sign-In window was closed before completing authorization.');
    }
    throw err;
  } finally {
    isSigningIn = false;
  }
};

export const getGoogleAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const getGoogleTokenRemainingMinutes = (): number | null => {
  if (!cachedAccessToken || !tokenIssuedAt) return null;
  const elapsedMs = Date.now() - tokenIssuedAt;
  const remaining = Math.max(0, Math.round((58 * 60 * 1000 - elapsedMs) / 60000));
  return remaining;
};

export const getCachedGoogleUser = (): User | null => {
  return cachedGoogleUser || auth.currentUser;
};

export const googleLogout = async (): Promise<void> => {
  cachedAccessToken = null;
  cachedGoogleUser = null;
  tokenIssuedAt = null;
  await auth.signOut();
};
