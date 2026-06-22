// distraction-sites.js — Default distraction domains for heuristic drift

export const DEFAULT_DISTRACTION_SITES = [
  'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
  'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com',
];

export function getEffectiveDistractionSites(storedSites, fallback = DEFAULT_DISTRACTION_SITES) {
  if (Array.isArray(storedSites) && storedSites.length > 0) {
    return storedSites;
  }
  return fallback;
}