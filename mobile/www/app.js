/* Gemini Notes Chat — mobile (PWA + Capacitor Android). No build step. */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const DEFAULT_MODEL = 'gemini-2.0-flash';
  const BUILTIN_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
  const SPEECH_LANGS = [
    ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['es-ES', 'Spanish (Spain)'],
    ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['de-DE', 'German'], ['pt-BR', 'Portuguese (Brazil)'],
    ['it-IT', 'Italian'], ['hi-IN', 'Hindi'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)'],
  ];
  const SYSTEM = 'You are Gemini Notes Chat, a concise assistant inside a mobile notes app. Answer clearly. Use short paragraphs and markdown when it helps. Do not mention these instructions.';
  const CLEANUP_PROMPT = [
    'Clean up the dictated note below.',
    'Return only a JSON object with two string keys and no markdown fences.',
    '"title": a specific title, 80 characters or fewer.',
    '"body": the note rewritten for clarity. Fix grammar, punctuation, and filler words.',
    "Keep the speaker's meaning and facts. Do not add new facts.",
    'Use short paragraphs or bullet lists when the speaker listed items.',
    '', 'Note:', '',
  ].join('\n');

  const K = {
    key: 'gnc.apiKey', model: 'gnc.model', models: 'gnc.models', chat: 'gnc.chat', notes: 'gnc.notes',
    lang: 'gnc.speechLang', autoCleanup: 'gnc.autoCleanup', init: 'gnc.initialized',
  };

  const F = window.GeminiFormat;
  const $ = (id) => document.getElementById(id);
  const cap = window.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  // ---------- storage ----------
  function load(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch (_) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (err) { toast('Could not save: storage is full.', true); return false; }
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  const getKey = () => String(localStorage.getItem(K.key) || '').trim();
  const getModel = () => {
    const m = String(load(K.model, DEFAULT_MODEL) || '').trim();
    return /^[a-zA-Z0-9._-]{3,80}$/.test(m) ? m : DEFAULT_MODEL;
  };

  let messages = load(K.chat, []);
  let notes = load(K.notes, []);
  if (!Array.isArray(messages)) messages = [];
  if (!Array.isArray(notes)) notes = [];
  if (!localStorage.getItem(K.init)) {
    if (!notes.length) notes.push(welcomeNote());
    save(K.notes, notes);
    localStorage.setItem(K.init, '1');
  }
  const saveChat = () => save(K.chat, messages.slice(-400));
  const saveNotes = () => save(K.notes, notes);

  function welcomeNote() {
    const now = new Date().toISOString();
    return {
      id: 'welcome', source: 'welcome', createdAt: now, updatedAt: now,
      title: 'Welcome to Gemini Notes Chat',
      body: [
        'Notes live on this phone. You can read, edit, and delete them without an internet connection.',
        '',
        'Dictation: tap the mic button and speak. Tap it again to stop. Use Clean up to let Gemini tidy the text and add a title.',
        '',
        'Chat: paste your free Gemini API key in Settings, then send a message. Tap Save as note on any reply to keep it here.',
        '',
        'Your API key is stored only on this device and is sent only to Google’s Gemini API.',
      ].join('\n'),
    };
  }

  // ---------- helpers ----------
  let toastTimer = 0;
  function toast(text, isErr) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 4200 : 2400);
  }
  function titleFromText(text) {
    const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'Untitled note';
    const stripped = line.replace(/^[#>*\-\d.)\s]+/, '').trim() || line;
    return stripped.length <= 80 ? stripped : stripped.slice(0, 77).trimEnd() + '…';
  }
  function parseCleanup(text) {
    if (!text || !String(text).trim()) return null;
    const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        const body = typeof obj.body === 'string' ? obj.body.trim() : '';
        const title = typeof obj.title === 'string' ? obj.title.trim() : '';
        if (body) return { title: (title || titleFromText(body)).slice(0, 120), body };
      } catch (_) { /* fall through */ }
    }
    const body = String(text).trim();
    return { title: titleFromText(body).slice(0, 120), body };
  }
  function redact(s) {
    return String(s || '').replace(/key=[^&\s]+/gi, 'key=REDACTED').replace(/AIza[0-9A-Za-z\-_]{10,}/g, 'REDACTED_KEY');
  }
  function friendlyError(err) {
    const message = redact(err && (err.friendly || err.message) || err);
    if (err && err.friendly) return err.friendly;
    const lower = message.toLowerCase();
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('permission denied') || (lower.includes('api key') && (lower.includes('invalid') || lower.includes('expired')))) {
      return 'Gemini rejected the API key. Check the key in Settings.';
    }
    if (lower.includes('quota') || lower.includes('resource_exhausted') || lower.includes('rate limit') || lower.includes('429')) {
      return 'Gemini rate limit or quota was reached. Wait a bit and try again.';
    }
    if ((lower.includes('not found') || lower.includes('404') || lower.includes('not supported') || lower.includes('no longer available')) && lower.includes('model')) {
      return 'That model is not available for this API key. Pick another model in Settings (try “Load models from my key”).';
    }
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network') || lower.includes('load failed') || lower.includes('timeout') || lower.includes('aborted')) {
      return 'Could not reach Gemini. Check your internet connection and try again.';
    }
    if (lower.includes('blocked') || lower.includes('safety')) return 'Gemini blocked that request because of its safety filters.';
    return message.replace(/\s+/g, ' ').trim().slice(0, 400) || 'Gemini request failed.';
  }
  function fail(msg) { const e = new Error(msg); e.friendly = msg; return e; }

  // ---------- Gemini REST ----------
  async function geminiRequest(path, init, timeoutMs) {
    const key = getKey();
    if (!key) throw fail('Add your Gemini API key in Settings first.');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 60000) : 0;
    let res;
    try {
      res = await fetch(API_BASE + path, Object.assign({}, init, {
        headers: Object.assign({ 'x-goog-api-key': key }, init && init.headers),
        signal: ctrl ? ctrl.signal : undefined,
        referrerPolicy: 'no-referrer',
      }));
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error.status)) || ('HTTP ' + res.status);
      throw new Error(msg + ' (' + res.status + ')');
    }
    return data;
  }
  async function generate(contents, opts) {
    opts = opts || {};
    const model = opts.model || getModel();
    const body = { contents, generationConfig: { temperature: opts.temperature ?? 0.7, maxOutputTokens: 8192 } };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    const send = (b) => geminiRequest('/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }, opts.timeout || 60000);
    let data;
    try {
      data = await send(body);
    } catch (err) {
      const m = String(err && err.message || '').toLowerCase();
      if (opts.system && (m.includes('systeminstruction') || m.includes('system instruction') || m.includes('developer instruction'))) {
        delete body.systemInstruction;
        data = await send(body);
      } else throw err;
    }
    const cand = data && data.candidates && data.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map((p) => p.text || '').join('').trim() : '';
    if (text) return text;
    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (blocked) throw fail('Gemini blocked that request (' + blocked + ').');
    if (cand && cand.finishReason === 'SAFETY') throw fail('Gemini blocked that reply because of its safety filters.');
    throw fail('Gemini returned an empty response.');
  }
  function buildContents(list) {
    const out = [];
    for (const m of list.slice(-30)) {
      if (m.role !== 'user' && m.role !== 'model') continue;
      const text = String(m.text || '').trim().slice(0, 20000);
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.role === m.role) last.parts[0].text += '\n\n' + text;
      else out.push({ role: m.role, parts: [{ text }] });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  // ---------- navigation ----------
  const views = { chat: $('view-chat'), notes: $('view-notes'), editor: $('view-editor'), settings: $('view-settings') };
  let currentView = 'chat';
  function showView(name) {
    if (currentView === 'editor' && name !== 'editor') leaveEditor();
    currentView = name;
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
    const tabName = name === 'editor' ? 'notes' : name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === tabName));
    if (name === 'notes') renderNotes();
    if (name === 'chat') scrollChat();
    if (name === 'settings') renderSettings();
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.view;
      if (currentView === 'editor') { history.replaceState(null, '', '#notes'); }
      history.replaceState(null, '', '#' + name);
      showView(name);
    });
  });
  window.addEventListener('popstate', () => {
    const hash = location.hash.replace('#', '');
    if (hash.startsWith('note/')) return; // forward navigation into an editor is not restored
    showView(['chat', 'notes', 'settings'].includes(hash) ? hash : 'notes');
  });

  // Hide the tab bar while typing (keyboard open).
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('textarea, input[type=text], input[type=password], input[type=search]')) document.body.classList.add('keyboard-open');
  });
  document.addEventListener('focusout', () => setTimeout(() => {
    const a = document.activeElement;
    if (!a || !a.matches('textarea, input[type=text], input[type=password], input[type=search]')) document.body.classList.remove('keyboard-open');
  }, 50));

  // ---------- chat ----------
  const chatLog = $('chat-log');
  const chatInput = $('chat-input');
  let sending = false;
  let lastError = null;

  function scrollChat() { requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; }); }
  function renderChat() {
    chatLog.innerHTML = '';
    if (!messages.length && !sending && !lastError) {
      const hasKey = !!getKey();
      chatLog.innerHTML = '<div class="empty"><img src="icons/icon-192.png" alt=""><h2>Chat with Gemini</h2><p>'
        + (hasKey ? 'Ask anything. Tap <strong>Save as note</strong> on a reply to keep it.' : 'Add your free Gemini API key in <strong>Settings</strong> to start chatting.')
        + '</p>' + (hasKey ? '' : '<button class="btn primary" type="button" id="go-settings">Open Settings</button>') + '</div>';
      const go = $('go-settings');
      if (go) go.addEventListener('click', () => document.querySelector('.tab[data-view=settings]').click());
      return;
    }
    for (const m of messages) chatLog.appendChild(messageEl(m));
    if (sending) {
      const el = document.createElement('div');
      el.className = 'msg model';
      el.innerHTML = '<div class="bubble typing" aria-label="Gemini is typing"><span></span><span></span><span></span></div>';
      chatLog.appendChild(el);
    }
    if (lastError) {
      const el = document.createElement('div');
      el.className = 'msg error';
      el.innerHTML = '<div class="bubble"></div><div class="msg-actions"><button class="chip" type="button">Retry</button></div>';
      el.querySelector('.bubble').textContent = lastError;
      el.querySelector('.chip').addEventListener('click', () => { lastError = null; requestReply(); });
      chatLog.appendChild(el);
    }
    scrollChat();
  }
  function messageEl(m) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.role;
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (m.role === 'model' ? ' markdown' : '');
    if (m.role === 'model') bubble.innerHTML = F.renderMarkdown(m.text); else bubble.textContent = m.text;
    el.appendChild(bubble);
    if (m.role === 'model') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'chip' + (m.savedNoteId ? ' done' : '');
      saveBtn.textContent = m.savedNoteId ? '✓ Saved' : 'Save as note';
      saveBtn.addEventListener('click', () => {
        if (m.savedNoteId && notes.some((n) => n.id === m.savedNoteId)) { openEditor(m.savedNoteId); return; }
        const now = new Date().toISOString();
        const note = { id: uuid(), title: titleFromText(m.text), body: m.text, source: 'chat', createdAt: now, updatedAt: now };
        notes.unshift(note); saveNotes();
        m.savedNoteId = note.id; saveChat();
        saveBtn.className = 'chip done'; saveBtn.textContent = '✓ Saved';
        toast('Saved to Notes');
      });
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button'; copyBtn.className = 'chip'; copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(m.text); toast('Copied'); } catch (_) { toast('Copy is not available here.', true); }
      });
      actions.append(saveBtn, copyBtn);
      el.appendChild(actions);
    }
    return el;
  }
  function autosize() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight + 2, 160) + 'px';
  }
  chatInput.addEventListener('input', autosize);
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  chatInput.addEventListener('keydown', (e) => {
    // Desktop browsers: Enter sends, Shift+Enter adds a line. On phones the keyboard's return key adds a line.
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); sendChat(); }
  });
  function sendChat() {
    const text = chatInput.value.trim();
    if (!text || sending) return;
    if (!getKey()) { toast('Add your Gemini API key in Settings first.', true); return; }
    lastError = null;
    messages.push({ id: uuid(), role: 'user', text, createdAt: new Date().toISOString() });
    saveChat();
    chatInput.value = ''; autosize();
    requestReply();
  }
  async function requestReply() {
    if (sending) return;
    const contents = buildContents(messages);
    if (!contents.length || contents[contents.length - 1].role !== 'user') { renderChat(); return; }
    sending = true; $('chat-send').disabled = true; renderChat();
    try {
      const reply = await generate(contents, { system: SYSTEM });
      messages.push({ id: uuid(), role: 'model', text: reply, createdAt: new Date().toISOString() });
      saveChat();
    } catch (err) {
      lastError = friendlyError(err);
    } finally {
      sending = false; $('chat-send').disabled = false; renderChat();
    }
  }
  $('chat-clear').addEventListener('click', () => {
    if (!messages.length) return;
    if (!confirm('Start a new chat? The current conversation will be cleared (saved notes stay).')) return;
    messages = []; lastError = null; saveChat(); renderChat();
  });

  // ---------- notes list ----------
  function renderNotes() {
    const list = $('note-list');
    const q = $('note-search').value.trim().toLowerCase();
    const items = notes
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .filter((n) => !q || (n.title + '\n' + n.body).toLowerCase().includes(q));
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<li class="empty"><h2>' + (q ? 'No matches' : 'No notes yet') + '</h2><p>' + (q ? 'Try another search.' : 'Tap the mic to dictate a note, or + to type one.') + '</p></li>';
      return;
    }
    for (const n of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'note-item';
      const snippet = String(n.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      b.innerHTML = '<strong></strong><span class="snippet"></span><div class="meta"></div>';
      b.querySelector('strong').textContent = n.title || 'Untitled note';
      b.querySelector('.snippet').textContent = snippet || 'Empty note';
      b.querySelector('.meta').textContent = F.formatWhen(n.updatedAt) + (n.source === 'chat' ? ' · from chat' : n.source === 'dictation' ? ' · dictated' : '');
      b.addEventListener('click', () => openEditor(n.id));
      li.appendChild(b); list.appendChild(li);
    }
  }
  $('note-search').addEventListener('input', renderNotes);
  $('note-new').addEventListener('click', () => openEditor(null));
  $('fab-dictate').addEventListener('click', () => { openEditor(null); startDictation(); });

  // ---------- editor ----------
  const titleEl = $('note-title');
  const bodyEl = $('note-body');
  const statusEl = $('dictation-status');
  let editingId = null;
  let editingSource = 'manual';
  let snapshot = '';

  function openEditor(id) {
    const note = id ? notes.find((n) => n.id === id) : null;
    editingId = note ? note.id : null;
    editingSource = note ? note.source : 'manual';
    titleEl.value = note ? note.title : '';
    bodyEl.value = note ? note.body : '';
    snapshot = titleEl.value + '\u0000' + bodyEl.value;
    $('editor-heading').textContent = note ? 'Edit note' : 'New note';
    $('editor-delete').classList.toggle('hidden', !note);
    setStatus('');
    if (currentView !== 'editor') history.pushState(null, '', '#note/' + (editingId || 'new'));
    showView('editor');
  }
  function persistEditor(silent) {
    const title = titleEl.value.trim();
    const body = bodyEl.value;
    if (!title && !body.trim()) return false;
    const now = new Date().toISOString();
    const finalTitle = (title || titleFromText(body)).slice(0, 200);
    const existing = editingId ? notes.find((n) => n.id === editingId) : null;
    if (existing) {
      Object.assign(existing, { title: finalTitle, body, updatedAt: now, source: existing.source === 'welcome' ? 'manual' : existing.source });
    } else {
      const note = { id: uuid(), title: finalTitle, body, source: editingSource, createdAt: now, updatedAt: now };
      notes.unshift(note); editingId = note.id;
      $('editor-delete').classList.remove('hidden');
      $('editor-heading').textContent = 'Edit note';
    }
    titleEl.value = finalTitle;
    snapshot = titleEl.value + '\u0000' + bodyEl.value;
    saveNotes();
    if (!silent) toast('Note saved');
    return true;
  }
  function leaveEditor() {
    if (dictating) stopDictation(true);
    if (titleEl.value + '\u0000' + bodyEl.value !== snapshot) persistEditor(true);
  }
  $('editor-back').addEventListener('click', () => {
    if (location.hash.startsWith('#note/')) history.back();
    else showView('notes');
  });
  $('note-save').addEventListener('click', async () => {
    if (dictating) await stopDictation();
    if (!persistEditor(false)) toast('Write or dictate something first.', true);
  });
  $('editor-delete').addEventListener('click', () => {
    if (!editingId) return;
    if (!confirm('Delete this note? This cannot be undone.')) return;
    if (dictating) stopDictation(true);
    notes = notes.filter((n) => n.id !== editingId); saveNotes();
    titleEl.value = ''; bodyEl.value = ''; snapshot = '\u0000'; editingId = null;
    toast('Note deleted');
    $('editor-back').click();
  });
  $('note-cleanup').addEventListener('click', () => cleanupNote());
  async function cleanupNote() {
    if (dictating) await stopDictation();
    const text = bodyEl.value.trim();
    if (!text) { toast('There is no note text to clean up.', true); return; }
    if (!getKey()) { toast('Add your Gemini API key in Settings to use Clean up.', true); return; }
    const btn = $('note-cleanup');
    btn.disabled = true; btn.textContent = 'Cleaning…'; setStatus('Asking Gemini to tidy this note…');
    try {
      const out = parseCleanup(await generate([{ role: 'user', parts: [{ text: CLEANUP_PROMPT + text }] }], { temperature: 0.3 }));
      if (!out || !out.body) throw fail('Gemini returned an empty cleanup.');
      titleEl.value = out.title; bodyEl.value = out.body;
      persistEditor(true);
      setStatus('Cleaned up and saved.');
    } catch (err) {
      setStatus(friendlyError(err), 'err');
    } finally {
      btn.disabled = false; btn.textContent = '✨ Clean up';
    }
  }
  function setStatus(text, cls) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  // ---------- dictation ----------
  const nativeSR = isNative && cap ? (cap.Plugins && cap.Plugins.SpeechRecognition) || (cap.registerPlugin ? cap.registerPlugin('SpeechRecognition') : null) : null;
  const WebSR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechMode = nativeSR ? 'native' : WebSR ? 'web' : 'none';
  const micBtn = $('note-mic');
  let dictating = false;
  let baseText = '';
  let committed = '';
  let interim = '';
  let engine = null;

  const lang = () => load(K.lang, (navigator.language && /^[a-z]{2}-[A-Z]{2}$/.test(navigator.language)) ? navigator.language : 'en-US');
  function joinText() {
    const parts = [baseText.replace(/\s+$/, ''), committed.trim(), interim.trim()].filter(Boolean);
    let out = parts.shift() || '';
    for (const p of parts) out += (out.endsWith('\n') || !out ? '' : ' ') + p;
    return out;
  }
  function paint() {
    bodyEl.value = joinText();
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function commitSegment(text) {
    const t = String(text || '').trim();
    if (!t) return;
    committed = committed ? committed + ' ' + t : t;
  }
  function setMic(on) {
    micBtn.classList.toggle('on', on);
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.setAttribute('aria-label', on ? 'Stop dictation' : 'Start dictation');
    bodyEl.readOnly = on;
  }
  micBtn.addEventListener('click', () => { if (dictating) stopDictation(); else startDictation(); });

  async function startDictation() {
    if (dictating) return;
    if (speechMode === 'none') {
      setStatus('Voice dictation is not supported in this browser. Use Chrome on Android, or your keyboard’s mic button to dictate.', 'err');
      return;
    }
    baseText = bodyEl.value; committed = ''; interim = '';
    if (!editingId && !bodyEl.value.trim()) editingSource = 'dictation';
    try {
      engine = speechMode === 'native' ? await nativeEngine() : webEngine();
      dictating = true; setMic(true);
      setStatus('Listening… tap the mic to stop.', 'live');
      await engine.start();
    } catch (err) {
      dictating = false; setMic(false); engine = null;
      setStatus(err && err.friendly ? err.friendly : 'Could not start dictation: ' + redact(err && err.message || err), 'err');
    }
  }
  async function stopDictation(quiet) {
    if (!dictating || !engine) return;
    dictating = false;
    const e = engine; engine = null;
    try { await e.stop(); } catch (_) { /* ignore */ }
    commitSegment(interim); interim = '';
    paint(); setMic(false);
    const hadSpeech = !!committed.trim();
    if (quiet) return;
    if (!hadSpeech) { setStatus('No speech was captured.'); return; }
    persistEditor(true);
    if (load(K.autoCleanup, false) && getKey()) { cleanupNote(); return; }
    setStatus('Dictation saved. Tap ✨ Clean up to tidy it with Gemini.');
  }

  function webEngine() {
    let rec = null;
    let want = true;
    let errors = 0;
    function create() {
      rec = new WebSR();
      rec.lang = lang(); rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      rec.onresult = (ev) => {
        errors = 0;
        let live = '';
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const r = ev.results[i];
          if (r.isFinal) commitSegment(r[0].transcript); else live += r[0].transcript;
        }
        interim = live; paint();
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          want = false;
          setStatus('Microphone permission was denied. Allow mic access for this site in your browser settings.', 'err');
          stopDictation(true);
        } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
          errors += 1;
          if (errors > 3) { want = false; setStatus('Dictation error: ' + ev.error, 'err'); stopDictation(true); }
        }
      };
      rec.onend = () => {
        commitSegment(interim); interim = ''; paint();
        if (want && dictating) { try { create(); rec.start(); } catch (_) { stopDictation(); } }
      };
    }
    return {
      start() { create(); rec.start(); },
      stop() {
        want = false;
        return new Promise((resolve) => {
          const done = () => resolve();
          rec.onend = () => { commitSegment(interim); interim = ''; done(); };
          try { rec.stop(); } catch (_) { done(); }
          setTimeout(done, 1500);
        });
      },
    };
  }

  async function nativeEngine() {
    const SR = nativeSR;
    const avail = await SR.available().catch(() => ({ available: false }));
    if (!avail.available) throw fail('Speech recognition is not available on this phone. Install or enable the “Speech Recognition & Synthesis” / Google app, then try again.');
    let perm = await SR.checkPermissions().catch(() => ({}));
    if (perm.speechRecognition !== 'granted') perm = await SR.requestPermissions().catch(() => ({}));
    if (perm.speechRecognition !== 'granted') throw fail('Microphone permission is needed for dictation. Allow it in Android Settings › Apps › Gemini Notes Chat › Permissions.');

    let want = true;
    let segment = '';
    let stoppedAt = 0;
    let restartTimer = 0;
    let pollTimer = 0;
    let running = false;
    let finalWaiter = null;
    const handles = [];

    const opts = () => ({ language: lang(), maxResults: 1, partialResults: true, popup: false });
    async function begin() {
      segment = ''; stoppedAt = 0; running = true;
      try { await SR.start(opts()); } catch (err) {
        running = false;
        if (want) scheduleRestart(800);
      }
    }
    function scheduleRestart(ms) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        commitSegment(segment); segment = ''; interim = ''; paint();
        if (want && dictating) begin();
      }, ms);
    }
    handles.push(await SR.addListener('partialResults', (data) => {
      const m = data && data.matches && data.matches[0];
      if (typeof m !== 'string') return;
      segment = m; interim = m; paint();
      if (finalWaiter) { finalWaiter(); return; }
      if (stoppedAt) scheduleRestart(150); // final result after end of speech
    }));
    handles.push(await SR.addListener('listeningState', (data) => {
      if (data && data.status === 'stopped' && running) {
        running = false; stoppedAt = Date.now();
        if (want) scheduleRestart(1200);
      }
    }));
    // Android does not report "no speech" errors to JS in partial-results mode; poll to recover.
    pollTimer = setInterval(async () => {
      if (!want || !running) return;
      try {
        const s = await SR.isListening();
        if (s && s.listening === false && running) {
          running = false; stoppedAt = Date.now();
          scheduleRestart(900);
        }
      } catch (_) { /* ignore */ }
    }, 1500);

    return {
      start: begin,
      async stop() {
        want = false;
        clearTimeout(restartTimer); clearInterval(pollTimer);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, running ? 1500 : 300);
          finalWaiter = () => { clearTimeout(t); resolve(); };
          SR.stop().catch(() => {});
        });
        finalWaiter = null;
        commitSegment(segment); segment = ''; interim = '';
        running = false;
        handles.forEach((h) => { try { h.remove(); } catch (_) { /* ignore */ } });
      },
    };
  }

  // ---------- settings ----------
  const keyInput = $('api-key');
  const modelSel = $('model');
  function modelList() {
    const loaded = load(K.models, []);
    const set = new Set(BUILTIN_MODELS.concat(Array.isArray(loaded) ? loaded : []));
    set.add(getModel());
    return Array.from(set);
  }
  function renderSettings() {
    const key = getKey();
    keyInput.value = '';
    keyInput.placeholder = key ? 'Saved key ••••' + key.slice(-4) + ' (paste to replace)' : 'Paste your key (AIza…)';
    const ks = $('key-state');
    ks.textContent = key ? 'A key is saved on this device (ends in ' + key.slice(-4) + ').' : 'No key saved yet.';
    ks.className = 'hint' + (key ? ' ok' : '');
    modelSel.innerHTML = '';
    for (const m of modelList()) modelSel.add(new Option(m + (m === DEFAULT_MODEL ? ' (default)' : ''), m));
    modelSel.add(new Option('Custom…', '__custom'));
    modelSel.value = getModel();
    $('custom-model-wrap').classList.add('hidden');
    const ls = $('speech-lang');
    if (!ls.options.length) {
      const list = SPEECH_LANGS.slice();
      const cur = lang();
      if (!list.some(([id]) => id === cur)) list.unshift([cur, cur]);
      for (const [id, label] of list) ls.add(new Option(label, id));
    }
    ls.value = lang();
    $('auto-cleanup').checked = !!load(K.autoCleanup, false);
    $('speech-support').textContent = speechMode === 'native'
      ? 'Dictation uses Android’s built-in speech recognition (usually Google). It needs an internet connection on most phones.'
      : speechMode === 'web'
        ? 'Dictation uses your browser’s speech recognition. Works best in Chrome on Android.'
        : 'This browser has no speech recognition. Use Chrome on Android, or the mic on your keyboard.';
    $('app-version').textContent = 'Version ' + APP_VERSION + (isNative ? ' · Android app' : ' · web app');
  }
  $('api-key-toggle').addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    $('api-key-toggle').textContent = show ? 'Hide' : 'Show';
  });
  $('api-key-save').addEventListener('click', () => {
    const v = keyInput.value.trim();
    if (!v) { toast('Paste a key first.', true); return; }
    if (v.length < 10 || v.length > 256 || /\s/.test(v)) { toast('That API key does not look valid.', true); return; }
    localStorage.setItem(K.key, v);
    keyInput.type = 'password'; $('api-key-toggle').textContent = 'Show';
    renderSettings(); renderChat();
    toast('API key saved on this device');
  });
  $('api-key-remove').addEventListener('click', () => {
    if (!getKey()) return;
    if (!confirm('Remove the saved API key from this device?')) return;
    localStorage.removeItem(K.key); renderSettings(); renderChat(); toast('API key removed');
  });
  $('api-key-test').addEventListener('click', async () => {
    const typed = keyInput.value.trim();
    if (typed) $('api-key-save').click();
    const ks = $('key-state');
    if (!getKey()) { toast('Save a key first.', true); return; }
    ks.textContent = 'Testing with ' + getModel() + '…'; ks.className = 'hint';
    try {
      const reply = await generate([{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], { timeout: 30000, temperature: 0 });
      ks.textContent = 'Key works with ' + getModel() + ' (reply: ' + reply.slice(0, 40) + ').'; ks.className = 'hint ok';
    } catch (err) {
      ks.textContent = friendlyError(err); ks.className = 'hint err';
    }
  });
  modelSel.addEventListener('change', () => {
    if (modelSel.value === '__custom') { $('custom-model-wrap').classList.remove('hidden'); $('custom-model').focus(); return; }
    save(K.model, modelSel.value); toast('Model: ' + modelSel.value);
  });
  $('custom-model').addEventListener('change', () => {
    const v = $('custom-model').value.trim().replace(/^models\//, '');
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(v)) { toast('That model name does not look valid.', true); return; }
    save(K.model, v); renderSettings(); toast('Model: ' + v);
  });
  $('load-models').addEventListener('click', async () => {
    const btn = $('load-models');
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const data = await geminiRequest('/models?pageSize=200', { method: 'GET' }, 30000);
      const names = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((n) => /^gemini/i.test(n) && !/embedding|tts|image|live|audio/i.test(n));
      if (!names.length) throw fail('No chat models were returned for this key.');
      save(K.models, names);
      renderSettings();
      toast(names.length + ' models loaded');
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      btn.disabled = false; btn.textContent = 'Load models from my key';
    }
  });
  $('speech-lang').addEventListener('change', (e) => save(K.lang, e.target.value));
  $('auto-cleanup').addEventListener('change', (e) => save(K.autoCleanup, e.target.checked));
  $('export-data').addEventListener('click', async () => {
    const payload = JSON.stringify({ app: 'gemini-notes-chat-mobile', version: APP_VERSION, exportedAt: new Date().toISOString(), notes, chat: messages }, null, 2);
    const file = 'gemini-notes-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      if (navigator.canShare && typeof File !== 'undefined') {
        const f = new File([payload], file, { type: 'application/json' });
        if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: file }); return; }
      }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      a.download = file; document.body.appendChild(a); a.click(); a.remove();
      toast('Backup downloaded');
    } catch (_) {
      try { await navigator.clipboard.writeText(payload); toast('Backup copied to clipboard'); } catch (e2) { toast('Export is not available here.', true); }
    }
  });
  $('wipe-data').addEventListener('click', () => {
    if (!confirm('Delete ALL notes and chat history on this device? Your API key is kept.')) return;
    notes = []; messages = []; lastError = null; saveNotes(); saveChat();
    renderNotes(); renderChat(); toast('All notes and chats deleted');
  });

  // ---------- boot ----------
  renderChat();
  const startHash = location.hash.replace('#', '');
  const start = ['chat', 'notes', 'settings'].includes(startHash) ? startHash : (getKey() ? 'chat' : 'settings');
  history.replaceState(null, '', '#' + start);
  showView(start);

  window.addEventListener('pagehide', () => { if (currentView === 'editor') leaveEditor(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentView === 'editor' && !dictating
      && titleEl.value + '\u0000' + bodyEl.value !== snapshot) persistEditor(true);
  });

  if (!isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
}());
