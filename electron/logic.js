const crypto = require('crypto');

// Google limits 2.x models to projects that already used them; new AI Studio keys (AQ.…) cannot use them.
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MODELS = [
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];
// 1.x / 2.x models: saved settings using them migrate to the default.
const LEGACY_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0|2\.5)(-|$)/i;

const DEFAULT_SPEECH_LANG = 'en-US';
const SPEECH_LANGS = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-ES', label: 'Spanish (Spain)' },
  { id: 'es-MX', label: 'Spanish (Mexico)' },
  { id: 'fr-FR', label: 'French' },
  { id: 'de-DE', label: 'German' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)' },
  { id: 'it-IT', label: 'Italian' },
  { id: 'hi-IN', label: 'Hindi' },
  { id: 'ja-JP', label: 'Japanese' },
  { id: 'ko-KR', label: 'Korean' },
  { id: 'zh-CN', label: 'Chinese (Mandarin)' },
];

const SOURCES = new Set(['manual', 'dictation', 'chat', 'welcome']);
const AUDIO_MIME = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);

function newId() {
  return crypto.randomUUID();
}

function acceptableId(id) {
  return typeof id === 'string' && (
    id === 'welcome'
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
}

function fail(message) {
  const error = new Error(message);
  error.friendly = message;
  return error;
}

function sanitizeError(err) {
  const raw = err && (err.friendly || err.message) ? (err.friendly || err.message) : String(err || 'Unknown error');
  return String(raw)
    .replace(/key=[^&\s]+/gi, 'key=REDACTED')
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, 'REDACTED_KEY')
    .replace(/\bAQ\.[0-9A-Za-z\-_.]{10,}/g, 'REDACTED_KEY')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer REDACTED');
}

function friendlyGeminiError(err) {
  const message = sanitizeError(err);
  const lower = message.toLowerCase();
  if (
    lower.includes('api key not valid')
    || lower.includes('api_key_invalid')
    || lower.includes('permission denied')
    || (lower.includes('api key') && (lower.includes('invalid') || lower.includes('rejected')))
  ) {
    return 'Gemini rejected the API key. Check the key in Settings.';
  }
  if (lower.includes('quota') || lower.includes('resource_exhausted') || lower.includes('rate limit') || lower.includes('429')) {
    return 'Gemini rate limit or quota was reached. Wait a bit and try again.';
  }
  if ((lower.includes('not found') || lower.includes('404') || lower.includes('not supported')) && lower.includes('model')) {
    return 'That model is not available for this API key. Pick another model in Settings.';
  }
  if (
    lower.includes('enotfound')
    || lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('enetunreach')
    || lower.includes('fetch failed')
    || lower.includes('network')
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('socket')
  ) {
    return 'Could not reach Gemini. Check your internet connection and try again.';
  }
  if (lower.includes('blocked') || lower.includes('safety')) {
    return 'Gemini blocked that request because of its safety filters.';
  }
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.slice(0, 400) || 'Gemini request failed.';
}

function titleFromText(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || 'Untitled note';
  const stripped = line.replace(/^[#>*\-\d.)\s]+/, '').trim() || line;
  if (stripped.length <= 80) return stripped;
  return stripped.slice(0, 77).trimEnd() + '…';
}

function cleanDate(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function normalizeModel(model) {
  const value = String(model || '').trim();
  if (/^[a-zA-Z0-9._-]{3,80}$/.test(value) && !LEGACY_MODEL_RE.test(value)) return value;
  return DEFAULT_MODEL;
}

function normalizeLang(lang) {
  const value = String(lang || '').trim();
  if (SPEECH_LANGS.some((item) => item.id === value)) return value;
  if (/^[a-z]{2,3}-[A-Z]{2}$/.test(value)) return value;
  return DEFAULT_SPEECH_LANG;
}

function normalizeApiKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length < 10 || key.length > 256 || /\s/.test(key)) {
    throw fail('That API key does not look valid.');
  }
  return key;
}

function parseCleanup(text) {
  if (!text || !String(text).trim()) return null;
  let raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      const body = typeof obj.body === 'string' ? obj.body.trim() : '';
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      if (body) {
        return {
          title: (title || titleFromText(body)).slice(0, 120),
          body,
        };
      }
    } catch (_) {
      // The model sometimes wraps JSON in prose. Fall through to plain text.
    }
  }
  const body = String(text).trim();
  return { title: titleFromText(body).slice(0, 120), body };
}

function buildGeminiHistory(messages) {
  const history = [];
  const source = (Array.isArray(messages) ? messages : []).slice(-30);
  for (const message of source) {
    const role = message && message.role === 'model' ? 'model' : 'user';
    const text = String(message && message.text || '').trim().slice(0, 20000);
    if (!text) continue;
    if (message && message.role !== 'model' && message.role !== 'user') continue;
    const last = history[history.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += '\n\n' + text;
    } else {
      history.push({ role, parts: [{ text }] });
    }
  }
  while (history.length && history[0].role !== 'user') history.shift();
  let prefix = '';
  if (history.length && history[history.length - 1].role === 'user') {
    prefix = history.pop().parts[0].text;
  }
  return { history, prefix };
}

function normalizeMessage(input) {
  if (!input || typeof input !== 'object') return null;
  const role = input.role === 'model' ? 'model' : input.role === 'user' ? 'user' : null;
  if (!role) return null;
  const text = String(input.text ?? '').replace(/\u0000/g, '');
  if (!text.trim()) return null;
  if (text.length > 200000) throw fail('That message is too long to store.');
  const id = acceptableId(input.id) && input.id !== 'welcome' ? input.id : newId();
  return {
    id,
    role,
    text,
    createdAt: cleanDate(input.createdAt),
  };
}

function normalizeChat(input, existing) {
  if (!input || typeof input !== 'object') throw fail('Invalid chat.');
  const messages = [];
  for (const item of (Array.isArray(input.messages) ? input.messages.slice(-400) : [])) {
    const message = normalizeMessage(item);
    if (message) messages.push(message);
  }
  if (!messages.length) throw fail('Chat is empty.');
  const now = new Date().toISOString();
  const id = existing?.id || (acceptableId(input.id) && input.id !== 'welcome' ? input.id : newId());
  let title = String(input.title || '').trim().slice(0, 120);
  if (!title || title === 'New chat') {
    const firstUser = messages.find((message) => message.role === 'user');
    title = firstUser ? titleFromText(firstUser.text).slice(0, 80) : 'New chat';
  }
  return {
    id,
    title,
    createdAt: existing?.createdAt || cleanDate(input.createdAt) || now,
    updatedAt: now,
    messages,
  };
}

function normalizeNote(input, existing) {
  if (!input || typeof input !== 'object') throw fail('Invalid note.');
  const titleInput = String(input.title ?? '').replace(/\u0000/g, '').trim();
  const body = String(input.body ?? '').replace(/\u0000/g, '');
  if (!titleInput && !body.trim()) throw fail('Write or dictate something before saving.');
  if (body.length > 200000) throw fail('That note is too long to save.');
  const title = (titleInput || titleFromText(body)).slice(0, 200);
  const source = SOURCES.has(input.source) ? input.source : (existing?.source || 'manual');
  const now = new Date().toISOString();
  const id = existing?.id || (acceptableId(input.id) ? input.id : newId());
  return {
    id,
    title,
    body,
    source,
    createdAt: existing?.createdAt || cleanDate(input.createdAt),
    updatedAt: now,
    chatMessageId: input.chatMessageId ? String(input.chatMessageId).slice(0, 80) : (existing?.chatMessageId || null),
  };
}

function createWelcomeNote() {
  const now = new Date().toISOString();
  return {
    id: 'welcome',
    title: 'Welcome to Gemini Notes Chat',
    body: [
      'This note lives on your computer. You can read, edit, and delete notes without an internet connection.',
      '',
      'Dictation: open a note and press Dictate. Speech is transcribed into the editor and saved. Turn on “Clean up & title with Gemini” if you want the wording polished before it is saved.',
      '',
      'Chat: add a Gemini API key in Settings, then send a message. Use Save as note on any message to keep a copy here.',
      '',
      'Your API key stays in this app’s data folder. It is never written into the project files.',
    ].join('\n'),
    source: 'welcome',
    createdAt: now,
    updatedAt: now,
    chatMessageId: null,
  };
}

function baseAudioMime(mime) {
  const value = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  if (value === 'audio/x-wav') return 'audio/wav';
  if (AUDIO_MIME.has(value)) return value;
  return 'audio/webm';
}

function keyHint(key) {
  if (!key || key.length < 4) return '';
  return key.slice(-4);
}

module.exports = {
  DEFAULT_MODEL,
  MODELS,
  DEFAULT_SPEECH_LANG,
  SPEECH_LANGS,
  newId,
  acceptableId,
  fail,
  sanitizeError,
  friendlyGeminiError,
  titleFromText,
  normalizeModel,
  normalizeLang,
  normalizeApiKey,
  parseCleanup,
  buildGeminiHistory,
  normalizeMessage,
  normalizeChat,
  normalizeNote,
  createWelcomeNote,
  baseAudioMime,
  keyHint,
};
