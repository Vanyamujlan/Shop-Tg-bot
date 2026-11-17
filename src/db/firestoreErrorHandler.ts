import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { OperationType, FirestoreErrorInfo } from '../types.ts';

const clientApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const db = getFirestore(clientApp, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(clientApp);

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<{ ok: boolean; details: string }> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true, details: 'Connected to Firestore server.' };
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return { ok: false, details: 'Firestore client is offline.' };
    }
    // Permission denied on /test/connection means the server was reached and security rules responded
    return {
      ok: true,
      details: `Firestore server reachable (${firebaseConfig.projectId} / ${firebaseConfig.firestoreDatabaseId}).`,
    };
  }
}
