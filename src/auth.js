import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut as firebaseSignOut, 
  onAuthStateChanged,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithCredential
} from 'firebase/auth';
import { auth } from './firebase';

/**
 * Sign in with email and password
 */
export async function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/**
 * Sign up with email and password
 */
export async function signUpWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

/**
 * Sign out from Firebase
 */
export async function signOut() {
  return firebaseSignOut(auth);
}

/**
 * Listen for auth state changes
 */
export function onAuthChanged(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Get current user
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Sign in with Google using launchWebAuthFlow (MV3 compatible)
 * Requires 'identity' permission and valid OAuth client ID in manifest.
 */
export async function signInWithGoogle() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2.client_id;
  const scopes = manifest.oauth2.scopes.join(' ');
  
  const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&response_type=id_token&access_type=offline&redirect_uri=https://${chrome.runtime.id}.chromiumapp.org/&scope=${encodeURIComponent(scopes)}&nonce=${Math.random().toString(36).substring(2)}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        return reject(chrome.runtime.lastError || new Error('Google Sign-In failed'));
      }

      const params = new URLSearchParams(new URL(redirectUrl).hash.substring(1));
      const idToken = params.get('id_token');
      const credential = GoogleAuthProvider.credential(idToken);
      
      signInWithCredential(auth, credential).then(resolve).catch(reject);
    });
  });
}

/**
 * Sign in with GitHub using launchWebAuthFlow
 */
export async function signInWithGitHub() {
  const clientId = 'YOUR_GITHUB_CLIENT_ID'; // TODO: User must provide this
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=user:email&redirect_uri=https://${chrome.runtime.id}.chromiumapp.org/`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        return reject(chrome.runtime.lastError || new Error('GitHub Sign-In failed'));
      }

      // GitHub requires a secondary exchange step usually done on a backend,
      // but Firebase supports it via signInWithPopup/redirect which don't work in MV3 popups.
      // In a production extension, you typically handle the code exchange via a small Cloud Function.
      // For this MV3 implementation, we assume the user has configured Firebase Auth correctly.
      reject(new Error('GitHub OAuth in MV3 requires a backend exchange (Cloud Function). Email/Google recommended.'));
    });
  });
}
