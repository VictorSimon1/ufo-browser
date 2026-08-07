export const X_BROWSER_DEFAULT_NEW_TAB_URL = "https://www.google.com/";

const INTERNAL_NEW_TAB_PATH = /(?:^|\/)newtab\.html$/i;

export function isInternalNewTabUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "x-browser:" && url.hostname === "newtab") ||
      (url.protocol === "file:" && INTERNAL_NEW_TAB_PATH.test(url.pathname))
    );
  } catch {
    return false;
  }
}

export function isDefaultNewTabUrl(value: string) {
  if (isInternalNewTabUrl(value)) return true;
  try {
    const url = new URL(value);
    return isGoogleHomeUrl(url);
  } catch {
    return false;
  }
}

export function logicalNavigationUrl(value: string, fallback: string) {
  if (isInternalNewTabUrl(value)) {
    return X_BROWSER_DEFAULT_NEW_TAB_URL;
  }
  if (isDefaultNewTabUrl(fallback) && isDefaultNewTabUrl(value)) {
    return X_BROWSER_DEFAULT_NEW_TAB_URL;
  }
  if (value) return value;
  return isInternalNewTabUrl(fallback)
    ? X_BROWSER_DEFAULT_NEW_TAB_URL
    : fallback;
}

function isGoogleHomeUrl(url: URL) {
  return (
    url.protocol === "https:" &&
    /^(?:www\.)?google\.[a-z.]{2,12}$/i.test(url.hostname) &&
    (url.pathname === "/" || url.pathname === "/webhp")
  );
}

export function normalizeNavigationUrl(input: string) {
  const value = input.trim();
  if (!value) return X_BROWSER_DEFAULT_NEW_TAB_URL;
  try {
    return new URL(value).toString();
  } catch {
    if (/^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
      return `https://${value}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  }
}
