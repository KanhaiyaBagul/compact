/**
 * Fetches device metadata including IP and Geo-location.
 * Uses ipapi.co as a public provider.
 * @returns {Promise<Object>} Metadata object: { ip, city, country, region }
 */
export async function getDeviceMetadata() {
  try {
    // Try primary provider (Geo + IP)
    const response = await fetch('https://ipapi.co/json/');
    if (response.ok) {
      const data = await response.json();
      return {
        ip: data.ip || 'unknown',
        city: data.city || 'unknown',
        country: data.country_name || 'unknown',
        region: data.region || 'unknown'
      };
    }
  } catch (ipapiErr) {
    console.warn('[Audit] ipapi.co failed, trying fallback:', ipapiErr);
  }

  try {
    // Fallback to ipify for IP only
    const response = await fetch('https://api.ipify.org?format=json');
    if (response.ok) {
      const data = await response.json();
      return {
        ip: data.ip || 'unknown',
        city: 'unavailable',
        country: 'unavailable',
        region: 'unavailable'
      };
    }
  } catch (ipifyErr) {
    console.error('[Audit] All metadata providers failed:', ipifyErr);
  }

  return {
    ip: 'unknown',
    city: 'unknown',
    country: 'unknown',
    region: 'unknown'
  };
}
