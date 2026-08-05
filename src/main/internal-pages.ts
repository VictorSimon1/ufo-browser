export const X_BROWSER_DEFAULT_NEW_TAB_URL = "x-browser://newtab/";

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

export function logicalNavigationUrl(value: string, fallback: string) {
  if (isInternalNewTabUrl(value)) {
    return X_BROWSER_DEFAULT_NEW_TAB_URL;
  }
  if (value) return value;
  return isInternalNewTabUrl(fallback)
    ? X_BROWSER_DEFAULT_NEW_TAB_URL
    : fallback;
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
