const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const {
  DEFAULT_MODEL,
  DEFAULT_SPEECH_LANG,
  MODELS,
  SPEECH_LANGS,
  createWelcomeNote,
  fail,
  keyHint,
  normalizeApiKey,
  normalizeChat,
  normalizeLang,
  normalizeModel,
  normalizeNote,
  sanitizeError,
} = require('./logic');

function createStore(userData) {
  fs.mkdirSync(userData, { recursive: true });
  const settingsPath = path.join(userData, 'settings.json');
  const notesPath = path.join(userData, 'notes.json');
  const chatsPath = path.join(userData, 'chats.json');

  function readJson(file, fallback) {
    if (!fs.existsSync(file)) return { data: fallback, existed: false };
    try {
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), existed: true };
    } catch (err) {
      const backup = `${file}.corrupt.bak`;
      try { fs.copyFileSync(file, backup); } catch (_) { /* keep going */ }
      console.error(`Could not read ${path.basename(file)}; backed it up. ${sanitizeError(err)}`);
      return { data: fallback, existed: true, corrupt: true };
    }
  }

  function writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows may ignore POSIX modes. */ }
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      console.error(`Could not write ${path.basename(file)}. ${sanitizeError(err)}`);
      throw fail('Could not save data on this computer. Check permissions for the data folder.');
    }
  }

  function sealKey(apiKey) {
    if (!apiKey) return null;
    if (safeStorage.isEncryptionAvailable()) {
      return {
        encrypted: true,
        data: safeStorage.encryptString(apiKey).toString('base64'),
      };
    }
    return { encrypted: false, data: apiKey };
  }

  function openKey(record) {
    if (!record) return '';
    if (typeof record === 'string') return record;
    if (!record.data) return '';
    try {
      if (record.encrypted) {
        if (!safeStorage.isEncryptionAvailable()) return '';
        return safeStorage.decryptString(Buffer.from(record.data, 'base64'));
      }
      return String(record.data);
    } catch (err) {
      console.error('Could not read the saved API key.', sanitizeError(err));
      return '';
    }
  }

  function defaultSettings() {
    return {
      model: DEFAULT_MODEL,
      speechLang: DEFAULT_SPEECH_LANG,
      apiKey: null,
    };
  }

  function readSettings() {
    const { data } = readJson(settingsPath, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultSettings();
    return {
      model: normalizeModel(data.model),
      speechLang: normalizeLang(data.speechLang),
      apiKey: data.apiKey || null,
    };
  }

  function writeSettings(settings) {
    writeJson(settingsPath, settings);
  }

  function migrateKey(settings, key) {
    if (!key || !settings.apiKey || settings.apiKey.encrypted !== false) return key;
    if (!safeStorage.isEncryptionAvailable()) return key;
    settings.apiKey = sealKey(key);
    writeSettings(settings);
    return key;
  }

  function getApiKey() {
    const settings = readSettings();
    const key = openKey(settings.apiKey);
    return migrateKey(settings, key);
  }

  function publicSettings() {
    getApiKey();
    const settings = readSettings();
    const apiKey = openKey(settings.apiKey);
    const encrypted = !!(settings.apiKey && settings.apiKey.encrypted && apiKey);
    return {
      hasApiKey: !!apiKey,
      keyHint: keyHint(apiKey),
      model: settings.model,
      models: MODELS.slice(),
      speechLang: settings.speechLang,
      speechLangs: SPEECH_LANGS.map((item) => ({ ...item })),
      encryption: encrypted || safeStorage.isEncryptionAvailable() ? 'os' : 'file',
      dataDir: userData,
    };
  }

  function saveSettings(input) {
    const body = input && typeof input === 'object' ? input : {};
    const current = readSettings();
    const next = {
      model: normalizeModel(body.model == null ? current.model : body.model),
      speechLang: normalizeLang(body.speechLang == null ? current.speechLang : body.speechLang),
      apiKey: current.apiKey || null,
    };
    if (body.clearKey) {
      next.apiKey = null;
    } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      next.apiKey = sealKey(normalizeApiKey(body.apiKey));
    }
    writeSettings(next);
    return publicSettings();
  }

  function revealKey() {
    const key = getApiKey();
    if (!key) throw fail('No API key is saved yet.');
    return key;
  }

  function readNotes() {
    const { data, existed } = readJson(notesPath, []);
    const notes = Array.isArray(data) ? data : [];
    return { notes, existed };
  }

  function listNotes() {
    const { notes, existed } = readNotes();
    if (!existed) {
      const seeded = [createWelcomeNote()];
      writeJson(notesPath, seeded);
      return seeded;
    }
    return notes;
  }

  function saveNote(input) {
    const { notes, existed } = readNotes();
    const list = existed ? notes.slice() : [];
    const requestedId = input && typeof input === 'object' ? input.id : '';
    const index = list.findIndex((note) => note && note.id === requestedId);
    const note = normalizeNote(input, index >= 0 ? list[index] : null);
    if (index >= 0) list[index] = note;
    else list.push(note);
    writeJson(notesPath, list);
    return note;
  }

  function deleteNote(id) {
    if (typeof id !== 'string' || !id) throw fail('Missing note id.');
    const { notes, existed } = readNotes();
    if (!existed) return false;
    const next = notes.filter((note) => note && note.id !== id);
    if (next.length === notes.length) return false;
    writeJson(notesPath, next);
    return true;
  }

  function readChats() {
    const { data, existed } = readJson(chatsPath, []);
    return { chats: Array.isArray(data) ? data : [], existed };
  }

  function listChats() {
    return readChats().chats;
  }

  function saveChat(input) {
    const { chats } = readChats();
    const list = chats.slice();
    const requestedId = input && typeof input === 'object' ? input.id : '';
    const index = list.findIndex((chat) => chat && chat.id === requestedId);
    const chat = normalizeChat(input, index >= 0 ? list[index] : null);
    if (index >= 0) list[index] = chat;
    else list.push(chat);
    writeJson(chatsPath, list);
    return chat;
  }

  function deleteChat(id) {
    if (typeof id !== 'string' || !id) throw fail('Missing chat id.');
    const { chats, existed } = readChats();
    if (!existed) return false;
    const next = chats.filter((chat) => chat && chat.id !== id);
    if (next.length === chats.length) return false;
    writeJson(chatsPath, next);
    return true;
  }

  return {
    dir: userData,
    getApiKey,
    publicSettings,
    saveSettings,
    revealKey,
    listNotes,
    saveNote,
    deleteNote,
    listChats,
    saveChat,
    deleteChat,
  };
}

module.exports = { createStore };
