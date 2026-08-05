const INTERNAL_NEW_TAB_PATH = /(?:^|\/)newtab\.html$/i;

export function displayNavigationAddress(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "about:blank") return "";
  try {
    const url = new URL(raw);
    if (
      (url.protocol === "file:" && INTERNAL_NEW_TAB_PATH.test(url.pathname)) ||
      (url.protocol === "x-browser:" && url.hostname === "newtab")
    ) {
      return "";
    }
  } catch {
    // Keep incomplete user-facing values readable instead of hiding them.
  }
  return raw;
}
