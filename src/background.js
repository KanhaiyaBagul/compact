import { onAuthChanged } from './auth';

/**
 * Background Service Worker for Manifest V3
 * Handles token management and installation events.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('Compact AI Extension Installed');
});

// Periodic token refresh listener
onAuthChanged(async (user) => {
  if (user) {
    console.log('Auth state changed: User is signed in');
    // Store token in session storage for components to use
    const idToken = await user.getIdToken();
    chrome.storage.session.set({ idToken });
  } else {
    console.log('Auth state changed: User is signed out');
    chrome.storage.session.remove('idToken');
  }
});

// Listen for messages from popup or other parts of the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_AUTH_TOKEN') {
    chrome.storage.session.get(['idToken'], (result) => {
      sendResponse(result.idToken || null);
    });
    return true; // async response
  }
});
