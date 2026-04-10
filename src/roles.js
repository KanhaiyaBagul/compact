import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

/**
 * Gets the role of a user from Firestore.
 * @param {string} uid User ID
 * @returns {Promise<string>} Role: "admin" | "user"
 */
export async function getUserRole(uid) {
  const userDoc = await getDoc(doc(db, 'users', uid));
  if (userDoc.exists()) {
    return userDoc.data().role || 'user';
  }
  return 'user';
}

/**
 * Initializes a new user document in Firestore with 'user' role.
 * @param {Object} user Firebase User object
 */
export async function initializeUser(user) {
  const userRef = doc(db, 'users', user.uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    await setDoc(userRef, {
      email: user.email,
      displayName: user.displayName || '',
      role: 'user', // Default role
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp()
    });
  } else {
    await setDoc(userRef, { lastLogin: serverTimestamp() }, { merge: true });
  }
}
