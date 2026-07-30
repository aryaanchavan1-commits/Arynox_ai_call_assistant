import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_SECURITY_POLICY,
  createWindowOptions,
  isAllowedLocalNavigation,
  isAllowedWindowOpen,
  normalizeWindowBounds,
  shouldAllowDownload,
  shouldAllowPermission,
} from '../electron/security.js';

test('BrowserWindow uses strict renderer security and a local preload', () => {
  const options = createWindowOptions('/tmp/preload.js');

  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.preload, '/tmp/preload.js');
});

test('content security policy denies network, objects, frames, and inline scripts', () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-eval|script-src[^;]*unsafe-inline/);
});

test('navigation allows only the packaged renderer file', () => {
  const renderer = 'file:///opt/agentcall/resources/app.asar/renderer/index.html';

  assert.equal(isAllowedLocalNavigation(renderer, renderer), true);
  assert.equal(isAllowedLocalNavigation('https://example.com', renderer), false);
  assert.equal(isAllowedLocalNavigation('file:///etc/passwd', renderer), false);
  assert.equal(isAllowedLocalNavigation('data:text/html,hello', renderer), false);
});

test('window-open and download guards deny all requests while microphone is renderer-scoped', () => {
  const renderer = 'file:///opt/agentcall/resources/app.asar/renderer/index.html';
  assert.deepEqual(isAllowedWindowOpen('https://example.com'), { action: 'deny' });
  assert.deepEqual(isAllowedWindowOpen('file:///tmp/other.html'), { action: 'deny' });
  assert.equal(shouldAllowPermission('media', renderer, renderer), true);
  assert.equal(shouldAllowPermission('media', 'https://evil.example/', renderer), false);
  assert.equal(shouldAllowPermission('notifications', renderer, renderer), false);
  assert.equal(shouldAllowDownload('file:///tmp/recording.wav'), false);
});

test('window bounds reject off-screen and undersized persisted values', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

  assert.deepEqual(
    normalizeWindowBounds({ x: 4000, y: 4000, width: 300, height: 200 }, workArea),
    { x: 160, y: 90, width: 1280, height: 800 },
  );
  assert.deepEqual(
    normalizeWindowBounds({ x: 20, y: 30, width: 1100, height: 720 }, workArea),
    { x: 20, y: 30, width: 1100, height: 720 },
  );
});
