import { signInWithEmail, signUpWithEmail, signInWithGoogle } from './auth';
import { initializeUser } from './roles';

const btnSubmit = document.getElementById('btn-submit');
const btnGoogle = document.getElementById('btn-google');
const toggleMode = document.getElementById('toggle-mode');
const errorMsg = document.getElementById('error-msg');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');

let isSignUp = false;

toggleMode.addEventListener('click', () => {
  isSignUp = !isSignUp;
  document.getElementById('title').textContent = isSignUp ? 'Create account' : 'Welcome back';
  document.getElementById('subtitle').textContent = isSignUp ? 'Start your journey with Compact' : 'Sign in to continue to Compact AI';
  btnSubmit.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  toggleMode.textContent = isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up";
});

btnSubmit.addEventListener('click', async () => {
  const email = emailInput.value;
  const password = passwordInput.value;
  errorMsg.style.display = 'none';
  btnSubmit.disabled = true;
  btnSubmit.textContent = isSignUp ? 'Creating account...' : 'Signing in...';

  try {
    let credential;
    if (isSignUp) {
      console.log('[Auth] Attempting sign-up for:', email);
      credential = await signUpWithEmail(email, password);
    } else {
      console.log('[Auth] Attempting sign-in for:', email);
      credential = await signInWithEmail(email, password);
    }
    
    console.log('[Auth] Success. Initializing user profile...');
    try {
      await initializeUser(credential.user);
    } catch (roleErr) {
      console.warn('[Auth] Firestore profile init failed (is your database created?), but login was successful:', roleErr);
    }
    
    console.log('[Auth] Done. Closing login tab.');
    window.close();
  } catch (err) {
    console.error('[Auth] Error:', err.code, err.message);
    errorMsg.textContent = `${err.code ? '[' + err.code + '] ' : ''}${err.message}`;
    errorMsg.style.display = 'block';
    
    if (err.code === 'auth/user-not-found') {
      errorMsg.textContent = 'Account not found. Did you mean to Sign Up?';
    }
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  }
});

btnGoogle.addEventListener('click', async () => {
  errorMsg.style.display = 'none';
  try {
    console.log('[Auth] Starting Google Sign-In flow...');
    const credential = await signInWithGoogle();
    console.log('[Auth] Google Success. Initializing profile...');
    try {
      await initializeUser(credential.user);
    } catch (roleErr) {
      console.warn('[Auth] Firestore profile init failed, but Google login was successful:', roleErr);
    }
    window.close();
  } catch (err) {
    console.error('[Auth] Google Error:', err);
    errorMsg.textContent = err.message;
    errorMsg.style.display = 'block';
  }
});
