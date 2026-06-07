const OFFICIAL_HOSTS = new Set([
  "fifa.com",
  "www.fifa.com",
  "uefa.com",
  "www.uefa.com",
  "the-afc.com",
  "www.the-afc.com",
  "cafonline.com",
  "www.cafonline.com",
  "concacaf.com",
  "www.concacaf.com",
  "conmebol.com",
  "www.conmebol.com"
]);

const REPUTABLE_SPORTS_HOSTS = new Set([
  "apnews.com",
  "www.apnews.com",
  "reuters.com",
  "www.reuters.com",
  "bbc.co.uk",
  "www.bbc.co.uk",
  "bbc.com",
  "www.bbc.com",
  "espn.com",
  "www.espn.com",
  "skysports.com",
  "www.skysports.com",
  "theguardian.com",
  "www.theguardian.com",
  "theathletic.com",
  "www.theathletic.com"
]);

const LOW_QUALITY_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "x.com",
  "twitter.com",
  "www.twitter.com",
  "reddit.com",
  "www.reddit.com"
]);

export function assessNewsSource(article) {
  const url = parseUrl(article.url);

  if (!url) {
    return { keep: false, reliability: 0.2, quality: "invalid_url", reason: "Article URL is not valid." };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (LOW_QUALITY_HOSTS.has(host)) {
    return { keep: false, reliability: 0.25, quality: "low_quality_host", reason: "Social posts are not counted as primary football news evidence." };
  }

  if (OFFICIAL_HOSTS.has(host)) {
    return { keep: true, reliability: 0.92, quality: "official_source", reason: "Official football body source." };
  }

  if (REPUTABLE_SPORTS_HOSTS.has(host)) {
    return { keep: true, reliability: 0.82, quality: "reputable_editorial_source", reason: "Recognised sports/editorial source." };
  }

  return { keep: true, reliability: 0.55, quality: "unclassified_source", reason: "Accepted but not strongly weighted until source quality is verified." };
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
