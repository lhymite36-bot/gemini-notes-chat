const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const gemini = require('./gemini');
const { friendlyGeminiError, normalizeApiKey, sanitizeError } = require('./logic');
const { installScreenshots, installSmoke, seedScreenshots } = require('./devhooks');

app.setName('gemini-notes-chat');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.gemininotes.chat');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let store = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const ALLOWED_LINKS = new Set([
  'https://aistudio.google.com/apikey',
  'https://ai.google.dev/gemini-api/docs',
]);

function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', action);
  }
}

function registerProtocol() {
  const rendererRoot = path.resolve(__dirname, '..', 'renderer');
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname).replace(/\0/g, '');
      const trimmed = (pathname === '/' || pathname === '') ? 'index.html' : pathname.replace(/^\/+/, '');
      const resolved = path.resolve(rendererRoot, trimmed);
      const relative = path.relative(rendererRoot, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const data = fs.readFileSync(resolved);
      const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': type },
      });
    } catch (err) {
      console.error(sanitizeError(err));
      return new Response('Internal error', { status: 500 });
    }
  });
}

function configureSession() {
  const allowed = new Set(['media', 'microphone', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function buildMenu() {
  const viewSubmenu = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (!app.isPackaged) {
    viewSubmenu.push(
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    );
  }

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-chat') },
        { label: 'New note', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('new-note') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: viewSubmenu },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Get an API key',
          click: () => shell.openExternal('https://aistudio.google.com/apikey'),
        },
        {
          label: 'Gemini API docs',
          click: () => shell.openExternal('https://ai.google.dev/gemini-api/docs'),
        },
        { type: 'separator' },
        {
          label: 'About Gemini Notes Chat',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Gemini Notes Chat',
              message: 'Gemini Notes Chat',
              detail: `Version ${app.getVersion()}\n\nChat with Gemini and keep notes on this computer.\nYour API key stays in the local data folder.\n\n${store ? store.dir : ''}`,
            });
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function attachWindowGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://local/')) event.preventDefault();
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: Number(process.env.GEMINI_NOTES_WIDTH) || (process.env.GEMINI_NOTES_SCREENSHOTS === '1' ? 1280 : 1180),
    height: Number(process.env.GEMINI_NOTES_HEIGHT) || (process.env.GEMINI_NOTES_SCREENSHOTS === '1' ? 800 : 780),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0c0e14',
    title: 'Gemini Notes Chat',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  attachWindowGuards(win);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.env.GEMINI_NOTES_SMOKE === '1') installSmoke(win);
  if (process.env.GEMINI_NOTES_SCREENSHOTS === '1') installScreenshots(win);

  win.loadURL('app://local/index.html');
  return win;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function registerIpc() {
  ipcMain.handle('settings:get', () => store.publicSettings());
  ipcMain.handle('settings:save', (_event, payload) => {
    try {
      return { ok: true, settings: store.saveSettings(asObject(payload)) };
    } catch (err) {
      return { ok: false, error: err.friendly || 'Could not save settings.' };
    }
  });
  ipcMain.handle('settings:reveal', () => {
    try {
      return { ok: true, apiKey: store.revealKey() };
    } catch (err) {
      return { ok: false, error: err.friendly || 'Could not read the API key.' };
    }
  });

  ipcMain.handle('notes:list', () => {
    try { return store.listNotes(); } catch (err) {
      console.error(sanitizeError(err));
      return [];
    }
  });
  ipcMain.handle('notes:save', (_event, payload) => {
    try {
      return { ok: true, note: store.saveNote(asObject(payload)) };
    } catch (err) {
      return { ok: false, error: err.friendly || 'Could not save the note.' };
    }
  });
  ipcMain.handle('notes:delete', (_event, id) => {
    try {
      return { ok: true, deleted: store.deleteNote(id) };
    } catch (err) {
      return { ok: false, error: err.friendly || 'Could not delete the note.' };
    }
  });

  ipcMain.handle('chats:list', () => {
    try { return store.listChats(); } catch (err) {
      console.error(sanitizeError(err));
      return [];
    }
  });
  ipcMain.handle('chats:save', (_event, payload) => {
    try {
      return { ok: true, chat: store.saveChat(asObject(payload)) };
    } catch (err) {
      return { ok: false, error: err.friendly || 'Could not save the chat.' };
    }
  });
  ipcMain.handle('chats:delete', (_event, id) => {
    try {
      return { ok: true, deleted: store.deleteChat(id) };
    } catch (err) {
      return { ok: false, error: err.friendly || 'Could not delete the chat.' };
    }
  });

  ipcMain.handle('gemini:chat', async (_event, payload) => {
    const body = asObject(payload);
    try {
      const text = await gemini.chat({
        apiKey: store.getApiKey(),
        model: store.publicSettings().model,
        history: body.history,
        text: body.text,
      });
      return { ok: true, text };
    } catch (err) {
      console.error('Gemini chat failed:', err.friendly || friendlyGeminiError(err));
      return { ok: false, error: err.friendly || friendlyGeminiError(err) };
    }
  });

  ipcMain.handle('gemini:cleanup', async (_event, payload) => {
    const body = asObject(payload);
    try {
      const note = await gemini.cleanupNote({
        apiKey: store.getApiKey(),
        model: store.publicSettings().model,
        text: body.text,
      });
      return { ok: true, title: note.title, body: note.body };
    } catch (err) {
      console.error('Gemini cleanup failed:', err.friendly || friendlyGeminiError(err));
      return { ok: false, error: err.friendly || friendlyGeminiError(err) };
    }
  });

  ipcMain.handle('gemini:transcribe', async (_event, payload) => {
    const body = asObject(payload);
    try {
      const text = await gemini.transcribe({
        apiKey: store.getApiKey(),
        model: store.publicSettings().model,
        mimeType: body.mimeType,
        dataBase64: body.dataBase64,
      });
      return { ok: true, text };
    } catch (err) {
      console.error('Gemini transcription failed:', err.friendly || friendlyGeminiError(err));
      return { ok: false, error: err.friendly || friendlyGeminiError(err) };
    }
  });

  ipcMain.handle('gemini:test', async (_event, payload) => {
    const body = asObject(payload);
    try {
      let apiKey = store.getApiKey();
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        apiKey = normalizeApiKey(body.apiKey);
      }
      const result = await gemini.testKey({
        apiKey,
        model: body.model || store.publicSettings().model,
      });
      return { ok: true, reply: result.reply, model: result.model };
    } catch (err) {
      console.error('Gemini key test failed:', err.friendly || friendlyGeminiError(err));
      return { ok: false, error: err.friendly || friendlyGeminiError(err) };
    }
  });

  ipcMain.handle('shell:open-data', async () => {
    const error = await shell.openPath(store.dir);
    return { ok: !error, error: error || '' };
  });

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (!ALLOWED_LINKS.has(url)) return { ok: false, error: 'Link is not allowed.' };
    shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text ?? '').slice(0, 500000));
    return { ok: true };
  });
}

if (gotLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    store = createStore(app.getPath('userData'));
    if (process.env.GEMINI_NOTES_SCREENSHOTS === '1') seedScreenshots(store);
    registerProtocol();
    configureSession();
    buildMenu();
    registerIpc();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
