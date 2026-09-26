const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEMO_CHAT_ID = '11111111-1111-4111-8111-111111111111';
const DEMO_NOTE_ID = '22222222-2222-4222-8222-222222222222';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilReady(win) {
  const ready = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const read = () => document.documentElement.dataset.ready || '';
    if (read()) { resolve(read()); return; }
    const observer = new MutationObserver(() => {
      if (read()) { observer.disconnect(); resolve(read()); }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ready'] });
    setTimeout(() => resolve(read() || 'timeout'), 15000);
  })`);
  if (ready !== '1') {
    throw new Error('UI did not become ready (' + ready + ').');
  }
}

function installSmoke(win) {
  const timer = setTimeout(() => {
    console.error('SMOKE_FAIL timeout');
    app.exit(1);
  }, 20000);

  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('SMOKE_FAIL load ' + code + ' ' + description);
    app.exit(1);
  });

  win.webContents.on('console-message', (event) => {
    const level = event.level || event.type;
    if (level === 'error' || level === 3) {
      console.error('[renderer] ' + event.message);
    }
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      await waitUntilReady(win);
      const flow = await win.webContents.executeJavaScript(`(async () => {
        const settings = await window.api.getSettings();
        const note = await window.api.saveNote({
          title: 'Smoke note',
          body: 'Stored locally.',
          source: 'manual',
        });
        const notes = await window.api.listNotes();
        const found = !!(note.ok && notes.some((item) => item.id === note.note.id && item.body.includes('Stored locally')));
        const removed = await window.api.deleteNote(note.note && note.note.id);
        const after = await window.api.listNotes();
        const gone = !!(note.ok && after.every((item) => item.id !== note.note.id));
        const chatSave = await window.api.saveChat({
          title: 'Smoke chat',
          messages: [{ role: 'user', text: 'hello from smoke', createdAt: new Date().toISOString() }],
        });
        const chats = await window.api.listChats();
        const chatFound = !!(chatSave.ok && chats.some((item) => item.id === chatSave.chat.id));
        const chatRemoved = await window.api.deleteChat(chatSave.chat && chatSave.chat.id);
        const reply = await window.api.chat({ history: [], text: 'hi' });
        const cleanup = await window.api.cleanupNote({ text: 'um hello this is a note' });
        return {
          ok: found && removed.ok && gone && chatFound && chatRemoved.ok
            && settings.hasApiKey === false && reply.ok === false && cleanup.ok === false,
          found, removed: removed.ok, gone, chatFound, chatRemoved: chatRemoved.ok,
          hasKey: settings.hasApiKey, chatOk: reply.ok, cleanupOk: cleanup.ok,
          model: settings.model, dataDir: settings.dataDir,
        };
      })()`);
      console.log('SMOKE_FLOW ' + JSON.stringify(flow));
      if (!flow.ok) {
        console.error('SMOKE_FAIL flow');
        app.exit(1);
        return;
      }
      clearTimeout(timer);
      console.log('SMOKE_OK');
      app.exit(0);
    } catch (err) {
      console.error('SMOKE_FAIL ' + (err && err.message ? err.message : err));
      app.exit(1);
    }
  });
}

function seedScreenshots(store) {
  store.listNotes();
  const now = new Date().toISOString();
  store.saveNote({
    id: DEMO_NOTE_ID,
    title: 'Packing list',
    source: 'dictation',
    body: [
      '- Charger and cable',
      '- Notebook',
      '- One extra shirt',
      '',
      'Leave the house keys on the front table.',
    ].join('\n'),
  });
  store.saveChat({
    id: DEMO_CHAT_ID,
    title: 'Sunday reset',
    messages: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        role: 'user',
        text: 'Help me plan a calm Sunday reset.',
        createdAt: now,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        role: 'model',
        text: [
          'A Sunday reset works best when it stays short.',
          '',
          '- Clear the desk and close leftover tabs',
          '- Write down three priorities for Monday',
          '- Capture one open loop as a note so it is not stuck in your head',
          '',
          'You can save this reply as a note and read it offline.',
        ].join('\n'),
        createdAt: now,
      },
    ],
  });
}

function installScreenshots(win) {
  const timer = setTimeout(() => {
    console.error('SHOT_FAIL timeout');
    app.exit(1);
  }, 25000);
  const dir = process.env.GEMINI_NOTES_SHOT_DIR
    ? path.resolve(process.env.GEMINI_NOTES_SHOT_DIR)
    : path.join(__dirname, '..', 'docs', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });

  win.webContents.once('did-finish-load', async () => {
    try {
      await waitUntilReady(win);
      const shots = [
        ['chat.png', null],
        ['notes.png', 'notes'],
        ['settings.png', 'settings'],
      ];
      for (const [name, nav] of shots) {
        if (nav) {
          await win.webContents.executeJavaScript(
            `document.querySelector('[data-nav="${nav}"]').click()`,
          );
        }
        await wait(400);
        const image = await win.capturePage();
        const file = path.join(dir, name);
        fs.writeFileSync(file, image.toPNG());
        const size = image.getSize();
        console.log(`SHOT ${name} ${size.width}x${size.height}`);
        if (!size.width || !size.height) throw new Error('Empty screenshot ' + name);
      }
      clearTimeout(timer);
      console.log('SHOT_OK');
      app.exit(0);
    } catch (err) {
      console.error('SHOT_FAIL ' + (err && err.message ? err.message : err));
      app.exit(1);
    }
  });
}

module.exports = {
  seedScreenshots,
  installSmoke,
  installScreenshots,
};
