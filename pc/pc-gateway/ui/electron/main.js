import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DesktopDaemonClient, desktopSocketFromEnv } from './daemon-client.js';
import { AgentAnsweringSupervisor, agentSupervisorConfiguration } from './agent-supervisor.js';
import { createIpcHandlers } from './ipc.js';
import { startWindowsGateway, windowsGatewayConfiguration } from './managed-gateway.js';
import { createRecordingMediaService, registerRecordingMediaScheme } from './recording-media.js';
import { incomingCallIdentity } from '../lib/phone.js';
import {
  CONTENT_SECURITY_POLICY,
  createWindowOptions,
  isAllowedLocalNavigation,
  isAllowedWindowOpen,
  normalizeWindowBounds,
  shouldAllowDownload,
  shouldAllowPermission,
} from './security.js';

const ROUTES = Object.freeze([
  ['Calls', 'CommandOrControl+1', 'calls'],
  ['Contacts', 'CommandOrControl+2', 'contacts'],
  ['Live Call', 'CommandOrControl+3', 'live-call'],
  ['MCP', 'CommandOrControl+4', 'mcp'],
  ['Android', 'CommandOrControl+5', 'android'],
  ['Speech', 'CommandOrControl+6', 'speech'],
  ['Recordings', 'CommandOrControl+7', 'recordings'],
  ['Policy', 'CommandOrControl+8', 'policy'],
  ['Settings', 'CommandOrControl+,', 'settings'],
]);
const PROJECT_URL = 'https://github.com/aryaanchavan1-commits/Arynox_ai_call_assistant';

export function buildApplicationMenu(navigate) {
  return [
    {
      label: 'Arynox AI Call Assistant',
      submenu: [
        ...ROUTES.map(([label, accelerator, route]) => ({ label, accelerator, click: () => navigate(route) })),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
  ];
}

export function registerIpcHandlers(ipcMain, options = {}) {
  const handlers = createIpcHandlers(options);
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, payload) => {
      const frame = event?.senderFrame;
      if (!frame || frame !== event?.sender?.mainFrame || frame.url !== options.rendererUrl) {
        throw new Error('Unauthorized IPC sender');
      }
      return handler(event, payload);
    });
  }
}

export function registerApplicationLifecycle({ app, BrowserWindow, createWindow, platform = process.platform }) {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit();
  });
}

export function createWindowStateStore(filePath, io = fs) {
  return {
    load(workArea) {
      try {
        return normalizeWindowBounds(JSON.parse(io.readFileSync(filePath, 'utf8')), workArea);
      } catch {
        return normalizeWindowBounds(null, workArea);
      }
    },
    save(bounds, workArea) {
      const safe = normalizeWindowBounds(bounds, workArea);
      io.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      io.writeFileSync(filePath, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    },
  };
}

export function superviseGatewayEvents(gateway, {
  onReady = () => {},
  retryDelayMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!gateway || typeof gateway.startEvents !== 'function' || typeof gateway.stopEvents !== 'function'
      || typeof gateway.on !== 'function' || typeof gateway.removeListener !== 'function') {
    throw new TypeError('gateway event client is required');
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 60_000) {
    throw new TypeError('retryDelayMs must be a bounded positive integer');
  }
  let stopped = false;
  let connecting = false;
  let retryTimer = null;
  const schedule = () => {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void connect();
    }, retryDelayMs);
    retryTimer?.unref?.();
  };
  const connect = async () => {
    if (stopped || connecting) return;
    connecting = true;
    try {
      await gateway.startEvents();
      if (stopped) {
        gateway.stopEvents();
        return;
      }
      void Promise.resolve(onReady()).catch(() => {});
    } catch {
      schedule();
    } finally {
      connecting = false;
    }
  };
  const onClosed = () => schedule();
  gateway.on('eventsClosed', onClosed);
  void connect();
  return () => {
    if (stopped) return;
    stopped = true;
    gateway.removeListener('eventsClosed', onClosed);
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    gateway.stopEvents();
  };
}

export function agentIntegrationConfiguration({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd(),
} = {}) {
  if (platform === 'win32') {
    const launcher = isPackaged
      ? path.join(resourcesPath, 'bin', 'agentcall-mcp.cmd')
      : `node "${path.resolve(appPath, '..', 'src', 'mcp-server.js')}"`;
    const command = isPackaged ? `"${launcher}"` : launcher;
    return Object.freeze({
      os: 'Windows',
      launcher,
      hermesAdd: `hermes mcp add agentcall --command ${command}`,
      openclawAdd: `openclaw mcp add agentcall --command ${command}`,
    });
  }
  const launcher = '/usr/bin/agentcall-mcp';
  return Object.freeze({
    os: 'Linux',
    launcher,
    hermesAdd: `hermes mcp add agentcall --command ${launcher}`,
    openclawAdd: `openclaw mcp add agentcall --command ${launcher}`,
  });
}

export async function startElectron() {
  const {
    app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, net, protocol, screen, session, shell,
  } = await import('electron');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rendererPath = path.resolve(here, '../renderer/index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;

  app.setPath('userData', process.env.ARYNOX_USER_DATA_DIR || path.join(app.getPath('appData'), 'agentcall-desktop'));
  registerRecordingMediaScheme(protocol);
  await app.whenReady();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing?.isMinimized()) existing.restore();
    existing?.focus();
  });
  const state = createWindowStateStore(path.join(app.getPath('userData'), 'window-state.json'));
  const userData = app.getPath('userData');
  const shouldManageGateway = process.platform === 'win32'
    && process.env.AGENTCALL_MANAGE_GATEWAYD !== 'false'
    && process.env.AGENTCALL_RPC_SOCKET === undefined;
  const managedConfiguration = shouldManageGateway ? windowsGatewayConfiguration({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userData,
  }) : null;
  const managedGateway = managedConfiguration ? startWindowsGateway(managedConfiguration) : null;
  app.once('before-quit', () => managedGateway?.stop());
  const socketPath = managedConfiguration?.socketPath ?? desktopSocketFromEnv(process.env);
  const recordingExportRoot = process.env.AGENTCALL_RECORDING_EXPORT_ROOT
    ?? (process.platform === 'win32'
      ? path.join(path.dirname(managedConfiguration?.recordingRoot ?? path.join(userData, 'gateway', 'recordings')), 'recording-exports')
      : path.join(path.dirname(socketPath), 'recording-exports'));
  const providerTestPath = managedConfiguration?.providerTestPath
    ?? (process.platform === 'win32'
      ? path.join(userData, 'gateway', 'provider-test.wav')
      : path.join(path.dirname(socketPath), 'provider-test.wav'));
  const gateway = new DesktopDaemonClient({ socketPath });
  const agentSupervisor = new AgentAnsweringSupervisor({
    configuration: agentSupervisorConfiguration({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      execPath: process.execPath,
      socketPath,
    }),
  });
  const recordingMedia = createRecordingMediaService({ protocol });
  const saveFile = async (source, suggestedName) => {
    const choice = await dialog.showSaveDialog({
      title: 'Save a copy of this recording',
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters: [{ name: 'Audio recording', extensions: [path.extname(suggestedName).slice(1)] }],
    });
    if (choice.canceled || !choice.filePath) return { saved: false, canceled: true };
    await fs.promises.copyFile(source, choice.filePath);
    return { saved: true, canceled: false };
  };
  const agentIntegration = agentIntegrationConfiguration({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

  registerIpcHandlers(ipcMain, {
    gateway,
    rendererUrl,
    recordingExportRoot,
    providerTestPath,
    agentIntegration,
    onAgentAnsweringConfigured: (mode) => agentSupervisor.sync(mode),
    onProviderConfigured: (receipt) => {
      if (receipt?.accepted === true && receipt.kind === 'tts') agentSupervisor.refresh();
    },
    createMediaUrl: recordingMedia.createMediaUrl,
    openProjectPage: () => shell.openExternal(PROJECT_URL),
    openPath: (mediaPath) => shell.openPath(mediaPath),
    saveFile,
    writeClipboard: (text) => clipboard.writeText(text),
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] },
  }));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(shouldAllowPermission(permission, contents.getURL(), rendererUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    shouldAllowPermission(permission, requestingOrigin, rendererUrl)
  ));
  let win = null;
  const createWindow = async () => {
    const workArea = screen.getPrimaryDisplay().workArea;
    win = new BrowserWindow(createWindowOptions(path.join(here, 'preload.cjs'), state.load(workArea)));
    win.webContents.setWindowOpenHandler(isAllowedWindowOpen);
    win.webContents.on('will-navigate', (event, url) => { if (!isAllowedLocalNavigation(url, rendererUrl)) event.preventDefault(); });
    win.webContents.session.on('will-download', (event) => { if (!shouldAllowDownload()) event.preventDefault(); });
    win.on('close', () => state.save(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea));
    win.once('ready-to-show', () => win.show());
    await win.loadFile(rendererPath);
  };
  const navigate = (route) => win?.webContents.send('navigation:route', route);
  let incomingNotification = null;
  let incomingNotificationCallId = null;
  let incomingNotificationGeneration = 0;
  const syncIncomingNotification = async () => {
    const generation = ++incomingNotificationGeneration;
    const [snapshot, contacts, calls] = await Promise.all([
      gateway.status().catch(() => null),
      gateway.listContacts({ limit: 500 }).catch(() => ({ rows: [] })),
      gateway.listCallLog({ limit: 200 }).catch(() => ({ rows: [] })),
    ]);
    if (generation !== incomingNotificationGeneration) return;
    const call = snapshot?.currentCall;
    const phase = String(call?.phase ?? call?.state ?? '').toLowerCase();
    const ringing = call?.direction === 'incoming' && ['incoming', 'ringing'].includes(phase);
    if (!ringing) {
      incomingNotification?.close();
      incomingNotification = null;
      incomingNotificationCallId = null;
      win?.flashFrame(false);
      return;
    }
    if (incomingNotificationCallId === call.callId) return;
    incomingNotification?.close();
    incomingNotificationCallId = call.callId;
    const identityRows = [
      ...(contacts?.rows ?? []),
      ...(calls?.rows ?? []).filter((row) => typeof row?.name === 'string' && row.name.length > 0),
    ];
    const identity = incomingCallIdentity(call, identityRows);
    if (Notification.isSupported()) {
      incomingNotification = new Notification({
        title: identity.name ? `Incoming call · ${identity.name}` : 'Incoming call',
        body: identity.number
          ? `${identity.number}\nOpen Arynox AI Call Assistant to answer or reject.`
          : 'Open Arynox AI Call Assistant to answer or reject.',
        silent: false,
        timeoutType: 'never',
        urgency: 'critical',
      });
      incomingNotification.on('click', () => {
        if (win?.isMinimized()) win.restore();
        win?.show();
        win?.focus();
        navigate('live-call');
      });
      incomingNotification.show();
    }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenu(navigate)));
  registerApplicationLifecycle({ app, BrowserWindow, createWindow });
  await createWindow();
  gateway.on('event', (event) => {
    win?.webContents.send('gateway:event', event);
    void syncIncomingNotification();
    if (event?.event === 'incoming') {
      if (win?.isMinimized()) win.restore();
      win?.show();
      win?.focus();
      win?.flashFrame(true);
      navigate('live-call');
    }
  });
  gateway.on('audio', ({ callId, payload }) => {
    win?.webContents.send('audio:downlink', { callId, pcm: Uint8Array.from(payload) });
  });
  gateway.on('audioClosed', ({ callId }) => win?.webContents.send('audio:closed', { callId }));
  let gatewayWasReady = false;
  const stopGatewayEvents = superviseGatewayEvents(gateway, {
    onReady: async () => {
      win?.webContents.send('gateway:event', { event: 'gateway_resynced' });
      agentSupervisor.sync(
        await gateway.agentAnsweringStatus().catch(() => ({ enabled: false })),
        { refresh: gatewayWasReady },
      );
      gatewayWasReady = true;
      const snapshot = await gateway.status().catch(() => null);
      const call = snapshot?.currentCall;
      if (!call?.callId) return;
      navigate('live-call');
      if (call.direction === 'incoming' && ['incoming', 'ringing'].includes(String(call.phase ?? call.state).toLowerCase())) {
        if (win?.isMinimized()) win.restore();
        win?.show();
        win?.focus();
        win?.flashFrame(true);
      }
      void syncIncomingNotification();
    },
  });
  app.once('before-quit', () => {
    incomingNotification?.close();
    agentSupervisor.stop();
    gateway.stopAudio();
    stopGatewayEvents();
  });
}

export function isApplicationEntrypoint(argv, modulePath, runtime = process) {
  const invokedDirectly = argv[1] && path.resolve(argv[1]) === path.resolve(modulePath);
  return Boolean(runtime.versions?.electron || invokedDirectly);
}

if (isApplicationEntrypoint(process.argv, fileURLToPath(import.meta.url))) {
  startElectron().catch(() => { process.stderr.write('desktop start failed\n'); process.exitCode = 1; });
}
