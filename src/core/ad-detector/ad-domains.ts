/**
 * Known advertising / tracking iframe hosts.
 *
 * Used as ONE signal among many (spec §10). An iframe from one of these hosts
 * is strong evidence, but the classifier still requires the content scorer to
 * agree before anything is removed — §10 is explicit that iframes must not be
 * removed merely for being iframes, since many carry real embedded content.
 */

const AD_DOMAINS: readonly string[] = [
  // Google advertising stack
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'adservice.google.com',
  '2mdn.net',
  // Major exchanges and networks
  'amazon-adsystem.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'sharethrough.com',
  'indexww.com',
  'casalemedia.com',
  'smartadserver.com',
  'adform.net',
  'teads.tv',
  'yieldmo.com',
  'triplelift.com',
  'media.net',
  'revcontent.com',
  'zergnet.com',
  'mgid.com',
  'adroll.com',
  'quantserve.com',
  'scorecardresearch.com',
  'moatads.com',
  'serving-sys.com',
  'flashtalking.com',
  'bidswitch.net',
  'contextweb.com',
  'gumgum.com',
  'sovrn.com',
  'districtm.io',
  'onetag-sys.com',
  'ad-delivery.net',
  'adsrvr.org',
  'demdex.net',
  'everesttech.net',
  'rlcdn.com',
  'bluekai.com',
];

/**
 * Hosts that frequently appear in iframes but carry MEANINGFUL content.
 * Explicitly allow-listed so a video or map embed is never scored as an ad.
 */
const CONTENT_IFRAME_DOMAINS: readonly string[] = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'soundcloud.com',
  'spotify.com',
  'bandcamp.com',
  'codepen.io',
  'codesandbox.io',
  'jsfiddle.net',
  'stackblitz.com',
  'github.com',
  'gist.github.com',
  'google.com/maps',
  'openstreetmap.org',
  'datawrapper.dwcdn.net',
  'dwcdn.net',
  'flourish.studio',
  'public.flourish.studio',
  'tableau.com',
  'twitter.com',
  'x.com',
  'platform.twitter.com',
  'instagram.com',
  'facebook.com/plugins',
  'archive.org',
  'scribd.com',
  'slideshare.net',
  'figma.com',
  'loom.com',
  'wistia.com',
  'wistia.net',
  'brightcove.net',
  'jwplayer.com',
  'kaltura.com',
];

/** True when `host` is, or is a subdomain of, any domain in `list`. */
function matchesDomain(host: string, list: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, '');
  return list.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`) || normalized.includes(domain),
  );
}

export function isAdDomain(host: string): boolean {
  return matchesDomain(host, AD_DOMAINS);
}

/** Content embeds are checked first, so an allow-listed host is never an ad. */
export function isContentDomain(host: string): boolean {
  return matchesDomain(host, CONTENT_IFRAME_DOMAINS);
}

export { AD_DOMAINS, CONTENT_IFRAME_DOMAINS };
