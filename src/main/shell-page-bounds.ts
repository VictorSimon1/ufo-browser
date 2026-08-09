import type { Rect } from "./types.js";

export const DEFAULT_CHAT_WIDTH = 0;
export const BROWSER_CHROME_HEIGHT = 94;

export type ShellLayout = {
  chat: Rect;
  content: Rect;
  overview: Rect;
  chrome: Rect;
  page: Rect;
  overlay: Rect;
};

export function calculateShellLayout(
  width: number,
  height: number,
  chatWidth = DEFAULT_CHAT_WIDTH,
): ShellLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const effectiveChat =
    chatWidth <= 0
      ? 0
      : Math.min(
          Math.max(320, Math.floor(chatWidth)),
          Math.max(320, safeWidth - 640),
        );
  const contentWidth = Math.max(1, safeWidth - effectiveChat);
  // Match Ego/Chromium's browser surface geometry: the page keeps a viewport
  // as tall as the complete content window while its native view starts below
  // Browser Chrome. AppKit clips the lower chrome-height portion at the window
  // edge. This preserves a full-height responsive viewport for the page and
  // keeps our separate native Chrome/Agent overlay outside page screenshots.
  const pageHeight = safeHeight;
  const visiblePageHeight = Math.max(1, safeHeight - BROWSER_CHROME_HEIGHT);
  return {
    chat: { x: 0, y: 0, width: effectiveChat, height: safeHeight },
    content: {
      x: effectiveChat,
      y: 0,
      width: contentWidth,
      height: safeHeight,
    },
    overview: {
      x: effectiveChat,
      y: 0,
      width: contentWidth,
      height: safeHeight,
    },
    chrome: {
      x: effectiveChat,
      y: 0,
      width: contentWidth,
      height: BROWSER_CHROME_HEIGHT,
    },
    page: {
      x: effectiveChat,
      y: BROWSER_CHROME_HEIGHT,
      width: contentWidth,
      height: pageHeight,
    },
    overlay: {
      x: effectiveChat,
      y: BROWSER_CHROME_HEIGHT,
      width: contentWidth,
      height: visiblePageHeight,
    },
  };
}
