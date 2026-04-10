import { initializeApp } from 'firebase/app';
import { getAuth, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// TODO: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyA_TLMj9ULYJu6ARM1jfaGf50nCgzmpI5Q",
  authDomain: "spartans-a2110.firebaseapp.com",
  projectId: "spartans-a2110",
  storageBucket: "spartans-a2110.firebasestorage.app",
  messagingSenderId: "867504574561",
  appId: "1:867504574561:web:93e3927ca70b3dc2161a20"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Set persistence to local for Chrome extension popup
setPersistence(auth, browserLocalPersistence);

export { app, auth, db };
