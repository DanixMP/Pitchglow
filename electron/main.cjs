// Desktop app (Electron): a window around the built web app (dist/).
//
// The app is served from a privileged `app://recorder/` scheme rather than file://, so the page is a
// secure origin like the website: microphone, AudioWorklets and module workers load normally and
// IndexedDB (takes, songs) persists. Permissions: microphone (audio only) and MIDI; everything else
// is refused. Links to other sites open in the default browser. One window at a time (one copy of
// the song database).
//
//   npm run electron        build, then run the desktop app
//   npm run electron:dev    run it against `npm run dev` (http://localhost:5173), with DevTools
//   npm run dist:win        build the Windows installer + portable .exe into release/

const { app, BrowserWindow, Menu, net, protocol, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://recorder`;
const DIST = path.join(__dirname, '..', 'dist');
const devUrl = process.argv.find((a) => a.startsWith('--dev-url='))?.slice('--dev-url='.length) ?? null;

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
}

/** Serves dist/ on app://recorder/ (no way out of the folder). */
function serveApp() {
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(DIST, relative));
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function isAppUrl(url) {
  return url.startsWith(`${ORIGIN}/`) || (devUrl !== null && url.startsWith(devUrl));
}

function allowPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      // The microphone only (no camera).
      const types = details.mediaTypes ?? [];
      return callback(types.length > 0 && types.every((t) => t === 'audio'));
    }
    callback(permission === 'midi');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'midi');
}

async function start() {
  serveApp();
  allowPermissions();
  // macOS asks the user for the microphone once (Info.plist explains why).
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  // The app has its own UI: no menu bar on Windows/Linux (macOS keeps the standard app menu).
  if (process.platform !== 'darwin' && !devUrl) Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    title: 'Recorder',
    backgroundColor: '#08080a',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Audio keeps playing smoothly when the window is in the background.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Other sites (GitHub profile, license links) open in the default browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isAppUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  if (devUrl) {
    await win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadURL(`${ORIGIN}/index.html`);
  }
}

app.on('window-all-closed', () => app.quit());
