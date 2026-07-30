const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 800 });
const MIN_SIZE = Object.freeze({ width: 900, height: 640 });

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'self' blob: agentcall-media:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function createWindowOptions(preloadPath, bounds = DEFAULT_SIZE) {
  return {
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: '#eef2f5',
    autoHideMenuBar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  };
}

export function isAllowedLocalNavigation(candidateUrl, rendererUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const renderer = new URL(rendererUrl);
    return candidate.protocol === 'file:' && candidate.href === renderer.href;
  } catch {
    return false;
  }
}

export function isAllowedWindowOpen() {
  return { action: 'deny' };
}

export function shouldAllowPermission(permission, candidateUrl, rendererUrl) {
  return permission === 'media'
    && typeof candidateUrl === 'string'
    && candidateUrl === rendererUrl;
}

export function shouldAllowDownload() {
  return false;
}

export function normalizeWindowBounds(bounds, workArea) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const isValid = [width, height, x, y].every(Number.isFinite)
    && width >= MIN_SIZE.width
    && height >= MIN_SIZE.height
    && width <= workArea.width
    && height <= workArea.height
    && x >= workArea.x
    && y >= workArea.y
    && x + width <= workArea.x + workArea.width
    && y + height <= workArea.y + workArea.height;

  if (isValid) return { x, y, width, height };

  const safeWidth = Math.min(DEFAULT_SIZE.width, workArea.width);
  const safeHeight = Math.min(DEFAULT_SIZE.height, workArea.height);
  return {
    // Keep a predictable safe inset rather than restoring an off-screen
    // window. The 1/12 work-area inset leaves room for desktop panels/docks.
    x: workArea.x + Math.round(workArea.width / 12),
    y: workArea.y + Math.round(workArea.height / 12),
    width: safeWidth,
    height: safeHeight,
  };
}
