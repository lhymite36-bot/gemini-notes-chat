(function () {
  const Format = window.GeminiFormat;
  const SUGGESTIONS = [
    'Help me outline a calm weekly review',
    'Turn these rough thoughts into a short plan: ship a notes app',
    'Give me three questions I can use to capture a meeting',
  ];
  const SOURCE_LABEL = {
    manual: 'Written',
    dictation: 'Dictated',
    chat: 'From chat',
    welcome: 'Guide',
  };

  const state = {
    view: 'chat',
    settings: null,
    notes: [],
    chats: [],
    activeChatId: null,
    sending: false,
    recording: false,
    recordMode: null,
    noteQuery: '',
    preview: false,
    busy: false,
  };

  let draft = null;
  let suppressDirty = false;
  let recognition = null;
  let listenSession = 0;
  let mediaRecorder = null;
  let recordStream = null;
  let recordChunks = [];
  let recordStartedAt = 0;
  let recordTick = null;
  let speechBase = '';
  let speechFinal = '';
  let modalResolver = null;

  const $ = (id) => document.getElementById(id);

  function uuid() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (symbol) => {
      const rand = Math.random() * 16 | 0;
      const value = symbol === 'x' ? rand : (rand & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  function sortByUpdated(list) {
    return list.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, 4200);
  }

  function confirmModal(options) {
    return new Promise((resolve) => {
      modalResolver = resolve;
      $('modal-title').textContent = options.title;
      $('modal-body').textContent = options.message;
      const confirmBtn = $('modal-confirm');
      confirmBtn.textContent = options.confirmLabel || 'Confirm';
      confirmBtn.className = options.danger ? 'btn danger' : 'btn primary';
      $('modal').hidden = false;
      confirmBtn.focus();
    });
  }

  function closeModal(value) {
    $('modal').hidden = true;
    const resolve = modalResolver;
    modalResolver = null;
    if (resolve) resolve(value);
  }

  function activeChat() {
    return state.chats.find((chat) => chat.id === state.activeChatId) || null;
  }

  function showView(view) {
    if (state.recording && view !== 'notes') {
      toast('Stop dictation before leaving Notes.', 'error');
      return;
    }
    state.view = view;
    for (const name of ['chat', 'notes', 'settings']) {
      $('view-' + name).hidden = name !== view;
      document.querySelector('[data-nav="' + name + '"]').classList.toggle('active', name === view);
    }
    $('chat-sidebar').hidden = view !== 'chat';
    $('sidebar-tip').hidden = view === 'chat';
    if (view === 'notes') ensureNoteSelection();
    updateHeader();
    updateBanners();
  }

  function updateHeader() {
    const titles = {
      chat: ['Chat', 'Conversations stay on this computer'],
      notes: ['Notes', 'Saved locally. Readable offline.'],
      settings: ['Settings', 'The API key never leaves this device'],
    };
    const pair = titles[state.view];
    $('view-title').textContent = pair[0];
    $('view-subtitle').textContent = pair[1];
    const model = state.settings && state.settings.model ? state.settings.model : '';
    $('model-pill').textContent = model;
    $('model-pill').hidden = !model;
    const chat = activeChat();
    $('top-delete-chat').hidden = state.view !== 'chat' || !chat;
  }

  function updateBanners() {
    const online = navigator.onLine;
    $('offline-banner').hidden = online;
    const needsKey = state.settings && !state.settings.hasApiKey && state.view !== 'settings';
    $('key-banner').hidden = !needsKey;
    $('net-dot').className = 'dot ' + (online ? 'on' : 'off');
    $('net-label').textContent = online ? 'Online' : 'Offline';
    const hasKey = !!(state.settings && state.settings.hasApiKey);
    $('key-dot').className = 'dot ' + (hasKey ? 'on' : 'warn');
    $('key-label').textContent = hasKey ? 'API key saved' : 'No API key';
    refreshComposerHint();
  }

  function refreshComposerHint(errorText) {
    const hint = $('composer-hint');
    if (errorText) {
      hint.textContent = errorText;
      hint.className = 'hint error';
      return;
    }
    hint.className = 'hint';
    if (!navigator.onLine) {
      hint.textContent = 'Offline — you can read this chat, but sending needs a connection.';
    } else if (!state.settings || !state.settings.hasApiKey) {
      hint.textContent = 'Add a Gemini API key in Settings to send messages.';
    } else {
      hint.textContent = 'Enter to send. Shift+Enter for a new line. Model: ' + state.settings.model;
    }
    const blocked = state.sending || !navigator.onLine || !state.settings || !state.settings.hasApiKey;
    $('send-btn').disabled = blocked || !$('composer-input').value.trim();
  }

  function renderChatList() {
    const list = $('chat-list');
    list.replaceChildren();
    if (!state.chats.length) {
      const empty = document.createElement('p');
      empty.className = 'item-meta';
      empty.textContent = 'No conversations yet.';
      list.appendChild(empty);
      return;
    }
    for (const chat of state.chats) {
      const row = document.createElement('div');
      row.className = 'chat-item' + (chat.id === state.activeChatId ? ' active' : '');
      row.setAttribute('role', 'listitem');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chat-item-main';
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = chat.title || 'New chat';
      const meta = document.createElement('span');
      meta.className = 'item-meta';
      meta.textContent = Format.formatWhen(chat.updatedAt);
      main.append(title, meta);
      main.addEventListener('click', () => openChat(chat.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-x';
      remove.setAttribute('aria-label', 'Delete conversation');
      remove.textContent = '×';
      remove.addEventListener('click', () => deleteChat(chat.id));
      row.append(main, remove);
      list.appendChild(row);
    }
  }

  function renderMessages() {
    const container = $('messages');
    const empty = $('chat-empty');
    const chat = activeChat();
    const messages = chat ? chat.messages : [];
    [...container.children].forEach((child) => {
      if (child !== empty) child.remove();
    });
    empty.hidden = messages.length > 0 || state.sending;
    for (const message of messages) container.appendChild(messageNode(message));
    if (state.sending) {
      const typing = document.createElement('div');
      typing.className = 'typing';
      typing.innerHTML = '<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span> Gemini is writing…';
      container.appendChild(typing);
    }
    container.scrollTop = container.scrollHeight;
    updateHeader();
  }

  function messageNode(message) {
    const article = document.createElement('article');
    article.className = 'msg ' + (message.role === 'user' ? 'user' : 'model');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const head = document.createElement('div');
    head.className = 'msg-head';
    const who = document.createElement('span');
    who.textContent = message.role === 'user' ? 'You' : 'Gemini';
    const when = document.createElement('span');
    when.textContent = Format.formatWhen(message.createdAt);
    head.append(who, when);
    const body = document.createElement('div');
    if (message.role === 'user') {
      body.className = 'plain';
      body.textContent = message.text;
    } else {
      body.className = 'markdown';
      body.innerHTML = Format.renderMarkdown(message.text);
    }
    bubble.append(head, body);
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.append(
      actionButton('Save as note', 'save-note', message.id),
      actionButton('Copy', 'copy', message.id),
    );
    article.append(bubble, actions);
    return article;
  }

  function actionButton(label, action, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn tiny ghost';
    button.dataset.action = action;
    button.dataset.id = id;
    button.textContent = label;
    return button;
  }

  function findMessage(id) {
    const chat = activeChat();
    if (!chat) return null;
    return chat.messages.find((message) => message.id === id) || null;
  }

  function openChat(id) {
    state.activeChatId = id;
    renderChatList();
    renderMessages();
    refreshComposerHint();
  }

  function newChat() {
    if (state.sending) return;
    state.activeChatId = null;
    showView('chat');
    renderChatList();
    renderMessages();
    $('composer-input').focus();
  }

  async function deleteChat(id) {
    const chat = state.chats.find((item) => item.id === id);
    if (!chat) return;
    const yes = await confirmModal({
      title: 'Delete this conversation?',
      message: '“' + (chat.title || 'New chat') + '” will be removed from this computer.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    const result = await window.api.deleteChat(id);
    if (!result.ok) {
      toast(result.error || 'Could not delete the chat.', 'error');
      return;
    }
    state.chats = state.chats.filter((item) => item.id !== id);
    if (state.activeChatId === id) state.activeChatId = state.chats[0] ? state.chats[0].id : null;
    renderChatList();
    renderMessages();
    toast('Conversation deleted.', 'success');
  }

  async function sendChat(event) {
    event.preventDefault();
    const text = $('composer-input').value.trim();
    if (!text || state.sending) return;
    if (!navigator.onLine) {
      refreshComposerHint('You are offline. Chat needs a network connection.');
      return;
    }
    if (!state.settings || !state.settings.hasApiKey) {
      refreshComposerHint('Add your Gemini API key in Settings.');
      showView('settings');
      return;
    }
    let chat = activeChat();
    let created = false;
    if (!chat) {
      chat = {
        id: uuid(),
        title: 'New chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      state.chats.unshift(chat);
      state.activeChatId = chat.id;
      created = true;
    }
    const userMessage = {
      id: uuid(),
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
    };
    chat.messages.push(userMessage);
    $('composer-input').value = '';
    autosize($('composer-input'));
    state.sending = true;
    refreshComposerHint();
    renderChatList();
    renderMessages();
    const history = chat.messages.slice(0, -1);
    let result;
    try {
      result = await window.api.chat({ history, text });
    } catch (err) {
      result = { ok: false, error: 'Could not reach Gemini.' };
    }
    state.sending = false;
    if (!result.ok) {
      chat.messages.pop();
      if (!$('composer-input').value.trim()) {
        $('composer-input').value = text;
        autosize($('composer-input'));
      }
      if (created) {
        state.chats = state.chats.filter((item) => item.id !== chat.id);
        state.activeChatId = state.chats[0] ? state.chats[0].id : null;
      }
      refreshComposerHint(result.error || 'Gemini request failed.');
      renderChatList();
      renderMessages();
      return;
    }
    chat.messages.push({
      id: uuid(),
      role: 'model',
      text: result.text,
      createdAt: new Date().toISOString(),
    });
    const saved = await window.api.saveChat(chat);
    if (!saved.ok) {
      toast(saved.error || 'The reply is on screen, but it could not be saved.', 'error');
    } else {
      replaceChat(saved.chat);
    }
    refreshComposerHint();
    renderChatList();
    renderMessages();
  }

  function replaceChat(chat) {
    const index = state.chats.findIndex((item) => item.id === chat.id);
    if (index >= 0) state.chats[index] = chat;
    else state.chats.unshift(chat);
    state.chats = sortByUpdated(state.chats);
    state.activeChatId = chat.id;
  }

  async function saveMessageAsNote(message) {
    const result = await window.api.saveNote({
      title: '',
      body: message.text,
      source: 'chat',
      chatMessageId: message.id,
    });
    if (!result.ok) {
      toast(result.error || 'Could not save the note.', 'error');
      return;
    }
    state.notes = sortByUpdated([result.note, ...state.notes.filter((note) => note.id !== result.note.id)]);
    toast('Saved as a note.', 'success');
    renderNoteList();
  }

  function filteredNotes() {
    const query = state.noteQuery.trim().toLowerCase();
    const notes = sortByUpdated(state.notes);
    if (!query) return notes;
    return notes.filter((note) => (
      (note.title || '').toLowerCase().includes(query)
      || (note.body || '').toLowerCase().includes(query)
    ));
  }

  function renderNoteList() {
    const list = $('note-list');
    list.replaceChildren();
    const notes = filteredNotes();
    if (!notes.length) {
      const empty = document.createElement('p');
      empty.className = 'item-meta';
      empty.textContent = state.notes.length ? 'No matching notes.' : 'No notes yet.';
      list.appendChild(empty);
      return;
    }
    for (const note of notes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-item' + (draft && draft.id === note.id ? ' active' : '');
      button.setAttribute('role', 'listitem');
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = note.title || 'Untitled note';
      const meta = document.createElement('span');
      meta.className = 'item-meta';
      meta.textContent = (SOURCE_LABEL[note.source] || 'Note') + ' · ' + Format.formatWhen(note.updatedAt);
      const snippet = document.createElement('span');
      snippet.className = 'item-snippet';
      snippet.textContent = String(note.body || '').replace(/\s+/g, ' ').slice(0, 90);
      button.append(title, meta, snippet);
      button.addEventListener('click', () => openNote(note.id));
      list.appendChild(button);
    }
  }

  function ensureNoteSelection() {
    if (draft) return;
    const notes = sortByUpdated(state.notes);
    if (notes[0]) openNote(notes[0].id, { skipConfirm: true });
    else showEditor(false);
  }

  function showEditor(open) {
    $('editor').hidden = !open;
    $('editor-empty').hidden = open;
  }

  async function maybeDiscard() {
    if (!draft || !draft.dirty) return true;
    return confirmModal({
      title: 'Discard unsaved changes?',
      message: 'This note has edits that are not saved on this computer yet.',
      confirmLabel: 'Discard',
      danger: true,
    });
  }

  function openNote(id, options) {
    if (state.recording) {
      toast('Stop dictation before opening another note.', 'error');
      return;
    }
    const run = async () => {
      if (!(options && options.skipConfirm)) {
        const ok = await maybeDiscard();
        if (!ok) return;
      }
      const note = state.notes.find((item) => item.id === id);
      if (!note) return;
      populateEditor(note, false);
    };
    run();
  }

  function populateEditor(note, isNew) {
    suppressDirty = true;
    draft = {
      id: note.id,
      title: note.title || '',
      body: note.body || '',
      source: note.source || 'manual',
      chatMessageId: note.chatMessageId || null,
      isNew,
      dirty: false,
      fromDictation: false,
      updatedAt: note.updatedAt || '',
    };
    $('note-title').value = isNew ? '' : (note.title || '');
    $('note-body').value = note.body || '';
    state.preview = false;
    $('note-preview').hidden = true;
    $('note-body').hidden = false;
    $('preview-btn').textContent = 'Preview';
    $('interim').hidden = true;
    suppressDirty = false;
    showEditor(true);
    updateNoteMeta();
    renderNoteList();
  }

  async function newNote() {
    if (state.recording) {
      toast('Stop dictation before starting another note.', 'error');
      return;
    }
    const ok = await maybeDiscard();
    if (!ok) return;
    showView('notes');
    populateEditor({
      id: uuid(),
      title: '',
      body: '',
      source: 'manual',
      chatMessageId: null,
    }, true);
    $('note-body').focus();
  }

  function markDirty(fromSpeech) {
    if (suppressDirty || !draft) return;
    draft.dirty = true;
    draft.title = $('note-title').value;
    draft.body = $('note-body').value;
    if (fromSpeech) draft.fromDictation = true;
    updateNoteMeta();
    if (state.preview) {
      $('note-preview').innerHTML = Format.renderMarkdown($('note-body').value);
    }
  }

  function updateNoteMeta() {
    if (!draft) {
      $('note-meta').textContent = '';
      return;
    }
    if (draft.dirty || draft.isNew) {
      $('note-meta').textContent = draft.isNew && !draft.dirty
        ? 'Not saved yet.'
        : 'Unsaved changes. Ctrl+S saves this note.';
      return;
    }
    const label = SOURCE_LABEL[draft.source] || 'Note';
    $('note-meta').textContent = label + (draft.updatedAt ? ' · saved ' + Format.formatWhen(draft.updatedAt) : '');
  }

  async function persistNote() {
    if (!draft || state.busy) return false;
    let source = draft.source || 'manual';
    if (draft.fromDictation) source = 'dictation';
    state.busy = true;
    let result;
    try {
      result = await window.api.saveNote({
        id: draft.id,
        title: $('note-title').value,
        body: $('note-body').value,
        source,
        chatMessageId: draft.chatMessageId || null,
      });
    } catch (err) {
      result = { ok: false, error: 'Could not save the note.' };
    }
    state.busy = false;
    if (!result.ok) {
      toast(result.error || 'Could not save the note.', 'error');
      return false;
    }
    state.notes = sortByUpdated([result.note, ...state.notes.filter((note) => note.id !== result.note.id && note.id !== draft.id)]);
    draft.id = result.note.id;
    draft.title = result.note.title;
    draft.body = result.note.body;
    draft.source = result.note.source;
    draft.isNew = false;
    draft.dirty = false;
    draft.fromDictation = false;
    draft.updatedAt = result.note.updatedAt;
    suppressDirty = true;
    $('note-title').value = result.note.title;
    suppressDirty = false;
    updateNoteMeta();
    renderNoteList();
    return true;
  }

  async function saveNoteFromForm(event) {
    if (event) event.preventDefault();
    const saved = await persistNote();
    if (saved) toast('Note saved.', 'success');
  }

  async function deleteCurrentNote() {
    if (!draft) return;
    if (state.recording) {
      toast('Stop dictation before deleting.', 'error');
      return;
    }
    if (draft.isNew && !draft.dirty) {
      draft = null;
      showEditor(false);
      renderNoteList();
      return;
    }
    const yes = await confirmModal({
      title: 'Delete this note?',
      message: 'It will be removed from this computer.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    if (!draft.isNew) {
      const result = await window.api.deleteNote(draft.id);
      if (!result.ok) {
        toast(result.error || 'Could not delete the note.', 'error');
        return;
      }
    }
    state.notes = state.notes.filter((note) => note.id !== draft.id);
    draft = null;
    showEditor(false);
    renderNoteList();
    ensureNoteSelection();
    toast('Note deleted.', 'success');
  }

  async function runCleanup(announce) {
    const text = $('note-body').value.trim();
    if (!text) {
      toast('Write or dictate something first.', 'error');
      return false;
    }
    if (!state.settings || !state.settings.hasApiKey) {
      toast('Add a Gemini API key in Settings to clean up notes.', 'error');
      return false;
    }
    if (!navigator.onLine) {
      toast('Cleanup needs a network connection.', 'error');
      return false;
    }
    state.busy = true;
    $('cleanup-btn').disabled = true;
    const result = await window.api.cleanupNote({ text });
    state.busy = false;
    $('cleanup-btn').disabled = false;
    if (!result.ok) {
      toast(result.error || 'Could not clean up the note.', 'error');
      return false;
    }
    suppressDirty = true;
    $('note-title').value = result.title;
    $('note-body').value = result.body;
    suppressDirty = false;
    if (draft) {
      draft.title = result.title;
      draft.body = result.body;
      draft.dirty = true;
      draft.fromDictation = true;
    }
    if (state.preview) $('note-preview').innerHTML = Format.renderMarkdown(result.body);
    updateNoteMeta();
    if (announce) toast('Cleaned up. Review the text, then save.', 'success');
    return true;
  }

  function joinText(base, addition) {
    const left = String(base || '').replace(/\s+$/, '');
    const right = String(addition || '').replace(/^\s+/, '');
    if (!left) return right;
    if (!right) return left;
    return left + '\n' + right;
  }

  function updateRecordUi() {
    const button = $('dictate-btn');
    button.classList.toggle('live', state.recording);
    button.textContent = state.recording ? 'Stop' : 'Dictate';
    button.setAttribute('aria-pressed', state.recording ? 'true' : 'false');
    if (!state.recording) {
      $('record-status').hidden = true;
      $('interim').hidden = true;
    }
  }

  function startTimer() {
    stopTimer();
    recordStartedAt = Date.now();
    recordTick = setInterval(() => {
      const seconds = Math.floor((Date.now() - recordStartedAt) / 1000);
      const lang = state.settings && state.settings.speechLang ? state.settings.speechLang : '';
      const label = state.recordMode === 'audio' ? 'Recording audio' : 'Listening';
      $('record-status').hidden = false;
      $('record-status').textContent = label + (lang ? ' · ' + lang : '') + ' · ' + Format.formatClock(seconds);
      if (seconds >= 120) stopDictation();
    }, 250);
  }

  function stopTimer() {
    if (recordTick) clearInterval(recordTick);
    recordTick = null;
  }

  function speechRecognitionAvailable() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  async function toggleDictation() {
    if (!draft) await newNote();
    if (!draft) return;
    if (state.recording) {
      await stopDictation();
      return;
    }
    if (speechRecognitionAvailable()) startSpeechRecognition();
    else await startAudioRecording();
  }

  function startSpeechRecognition() {
    const Session = window.SpeechRecognition || window.webkitSpeechRecognition;
    const session = ++listenSession;
    const rec = new Session();
    recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (state.settings && state.settings.speechLang) || 'en-US';
    speechBase = $('note-body').value;
    speechFinal = '';
    state.recording = true;
    state.recordMode = 'speech';
    updateRecordUi();
    startTimer();

    rec.onresult = (event) => {
      if (session !== listenSession) return;
      let interim = '';
      let finals = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finals += piece + ' ';
        else interim += piece;
      }
      if (finals) {
        speechFinal += finals;
        $('note-body').value = joinText(speechBase, speechFinal.trim());
        markDirty(true);
      }
      $('interim').hidden = !interim;
      $('interim').textContent = interim ? '…' + interim : '';
    };

    rec.onerror = (event) => {
      if (session !== listenSession) return;
      const code = event.error;
      if (code === 'aborted' || code === 'no-speech') return;
      if (code === 'not-allowed' || code === 'audio-capture') {
        listenSession += 1;
        state.recording = false;
        stopTimer();
        try { rec.abort(); } catch (_) { /* already stopped */ }
        recognition = null;
        updateRecordUi();
        toast(code === 'not-allowed'
          ? 'Microphone permission was blocked.'
          : 'No microphone was found.', 'error');
        return;
      }
      if (code === 'network' || code === 'service-not-allowed' || code === 'language-not-supported') {
        listenSession += 1;
        try { rec.abort(); } catch (_) { /* already stopped */ }
        recognition = null;
        state.recording = false;
        stopTimer();
        toast('Live transcription is unavailable. Recording audio for Gemini instead.', 'info');
        startAudioRecording();
      }
    };

    rec.onend = () => {
      if (session !== listenSession) return;
      if (state.recording && state.recordMode === 'speech') {
        try { rec.start(); } catch (_) { /* restart can race */ }
      }
    };

    try {
      rec.start();
    } catch (err) {
      state.recording = false;
      stopTimer();
      updateRecordUi();
      toast('Could not start dictation. You can type the note instead.', 'error');
    }
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    return '';
  }

  async function startAudioRecording() {
    if (!state.settings || !state.settings.hasApiKey) {
      state.recording = false;
      updateRecordUi();
      toast('Audio transcription uses Gemini. Add an API key in Settings, or type the note.', 'error');
      return;
    }
    if (!navigator.onLine) {
      toast('Audio transcription needs a network connection.', 'error');
      return;
    }
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast('Microphone permission was blocked.', 'error');
      return;
    }
    const mime = pickMime();
    recordChunks = [];
    mediaRecorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      const stream = recordStream;
      recordStream = null;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      mediaRecorder = null;
      finishAudio(blob);
    };
    mediaRecorder.start();
    state.recording = true;
    state.recordMode = 'audio';
    updateRecordUi();
    startTimer();
  }

  async function finishAudio(blob) {
    state.recording = false;
    stopTimer();
    updateRecordUi();
    if (!blob || !blob.size) {
      toast('No audio was captured.', 'error');
      return;
    }
    toast('Transcribing with Gemini…', 'info');
    const dataBase64 = await blobToBase64(blob);
    const result = await window.api.transcribe({
      mimeType: blob.type || 'audio/webm',
      dataBase64,
    });
    if (!result.ok) {
      toast(result.error || 'Could not transcribe that recording.', 'error');
      return;
    }
    if (!result.text || !result.text.trim()) {
      toast('No speech was detected in that recording.', 'error');
      return;
    }
    $('note-body').value = joinText($('note-body').value, result.text.trim());
    markDirty(true);
    await finishTranscript();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        resolve(comma >= 0 ? value.slice(comma + 1) : value);
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read audio.'));
      reader.readAsDataURL(blob);
    });
  }

  async function stopDictation() {
    if (!state.recording) return;
    const mode = state.recordMode;
    state.recording = false;
    stopTimer();
    if (mode === 'speech') {
      listenSession += 1;
      const rec = recognition;
      recognition = null;
      if (rec) {
        try { rec.stop(); } catch (_) { /* already ended */ }
      }
      const interim = $('interim').textContent.replace(/^…/, '').trim();
      if (interim) {
        speechFinal += interim + ' ';
        $('note-body').value = joinText(speechBase, speechFinal.trim());
        markDirty(true);
      }
      $('interim').hidden = true;
      $('interim').textContent = '';
      updateRecordUi();
      await finishTranscript();
      return;
    }
    updateRecordUi();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  async function finishTranscript() {
    if (!$('note-body').value.trim()) {
      toast('No speech was captured. You can type the note instead.', 'error');
      return;
    }
    let cleaned = false;
    if ($('cleanup-toggle').checked) cleaned = await runCleanup(false);
    const saved = await persistNote();
    if (!saved) return;
    if ($('cleanup-toggle').checked && !cleaned) {
      toast('Saved the transcript. Cleanup did not run.', 'info');
      return;
    }
    toast(cleaned ? 'Note cleaned up and saved.' : 'Note transcribed and saved.', 'success');
  }

  function togglePreview() {
    state.preview = !state.preview;
    $('note-preview').hidden = !state.preview;
    $('note-body').hidden = state.preview;
    $('preview-btn').textContent = state.preview ? 'Edit' : 'Preview';
    if (state.preview) $('note-preview').innerHTML = Format.renderMarkdown($('note-body').value);
  }

  function fillSettingsForm() {
    const settings = state.settings || {};
    const modelSelect = $('model-select');
    const langSelect = $('speech-lang');
    modelSelect.replaceChildren();
    const models = (settings.models || []).slice();
    if (settings.model && !models.includes(settings.model)) models.push(settings.model);
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model + (model === 'gemini-2.0-flash' ? ' (default)' : '');
      modelSelect.appendChild(option);
    }
    const custom = document.createElement('option');
    custom.value = '__custom';
    custom.textContent = 'Custom model id';
    modelSelect.appendChild(custom);
    if (settings.model && models.includes(settings.model)) {
      modelSelect.value = settings.model;
      $('model-custom').hidden = true;
      $('model-custom').value = '';
    } else if (settings.model) {
      modelSelect.value = '__custom';
      $('model-custom').hidden = false;
      $('model-custom').value = settings.model;
    }
    langSelect.replaceChildren();
    for (const lang of settings.speechLangs || []) {
      const option = document.createElement('option');
      option.value = lang.id;
      option.textContent = lang.label;
      langSelect.appendChild(option);
    }
    if (settings.speechLang) langSelect.value = settings.speechLang;
    $('data-dir').textContent = settings.dataDir || '';
    const hint = settings.keyHint ? ' It ends in ' + settings.keyHint + '.' : '';
    if (!settings.hasApiKey) {
      $('key-status').textContent = 'No key saved.';
    } else if (settings.encryption === 'os') {
      $('key-status').textContent = 'A key is saved and encrypted with the operating system.' + hint;
    } else {
      $('key-status').textContent = 'A key is saved in the local data folder. OS encryption is unavailable here.' + hint;
    }
    $('api-key').placeholder = settings.hasApiKey ? 'Saved — paste a new key to replace it' : 'Paste your Gemini API key';
  }

  function selectedModel() {
    if ($('model-select').value === '__custom') return $('model-custom').value.trim();
    return $('model-select').value;
  }

  async function saveSettings(event) {
    event.preventDefault();
    const payload = {
      model: selectedModel(),
      speechLang: $('speech-lang').value,
    };
    const typed = $('api-key').value.trim();
    if (typed) payload.apiKey = typed;
    $('save-settings').disabled = true;
    const result = await window.api.saveSettings(payload);
    $('save-settings').disabled = false;
    if (!result.ok) {
      $('settings-msg').textContent = result.error || 'Could not save settings.';
      $('settings-msg').className = 'hint error';
      return;
    }
    state.settings = result.settings;
    $('api-key').value = '';
    $('api-key').type = 'password';
    $('toggle-key').textContent = 'Show';
    fillSettingsForm();
    updateBanners();
    updateHeader();
    $('settings-msg').textContent = 'Settings saved.';
    $('settings-msg').className = 'hint ok';
    toast('Settings saved.', 'success');
  }

  async function testKey() {
    if (!navigator.onLine) {
      toast('Testing the key needs a network connection.', 'error');
      return;
    }
    const typed = $('api-key').value.trim();
    $('test-key').disabled = true;
    $('settings-msg').textContent = 'Contacting Gemini…';
    $('settings-msg').className = 'hint';
    const result = await window.api.testKey(typed ? { apiKey: typed, model: selectedModel() } : { model: selectedModel() });
    $('test-key').disabled = false;
    if (!result.ok) {
      $('settings-msg').textContent = result.error || 'The key test failed.';
      $('settings-msg').className = 'hint error';
      return;
    }
    $('settings-msg').textContent = 'Key works with ' + result.model + '.';
    $('settings-msg').className = 'hint ok';
  }

  async function revealKey() {
    const result = await window.api.revealKey();
    if (!result.ok) {
      toast(result.error || 'No API key is saved.', 'error');
      return;
    }
    $('api-key').value = result.apiKey;
    $('api-key').type = 'text';
    $('toggle-key').textContent = 'Hide';
  }

  async function clearKey() {
    if (!state.settings || !state.settings.hasApiKey) {
      toast('No API key is saved.', 'info');
      return;
    }
    const yes = await confirmModal({
      title: 'Clear the saved API key?',
      message: 'Chat, cleanup, and audio transcription will stop until you paste a key again.',
      confirmLabel: 'Clear key',
      danger: true,
    });
    if (!yes) return;
    const result = await window.api.saveSettings({
      clearKey: true,
      model: selectedModel(),
      speechLang: $('speech-lang').value,
    });
    if (!result.ok) {
      toast(result.error || 'Could not clear the key.', 'error');
      return;
    }
    state.settings = result.settings;
    $('api-key').value = '';
    fillSettingsForm();
    updateBanners();
    toast('API key cleared.', 'success');
  }

  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
  }

  function bindEvents() {
    document.querySelectorAll('[data-nav]').forEach((button) => {
      button.addEventListener('click', () => showView(button.dataset.nav));
    });
    $('brand-home').addEventListener('click', () => showView('chat'));
    $('new-chat').addEventListener('click', newChat);
    $('top-delete-chat').addEventListener('click', () => {
      if (state.activeChatId) deleteChat(state.activeChatId);
    });
    $('banner-settings').addEventListener('click', () => showView('settings'));
    $('composer').addEventListener('submit', sendChat);
    $('composer-input').addEventListener('input', () => {
      autosize($('composer-input'));
      refreshComposerHint();
    });
    $('composer-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('composer').requestSubmit();
      }
    });
    $('messages').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const message = findMessage(button.dataset.id);
      if (!message) return;
      if (button.dataset.action === 'save-note') await saveMessageAsNote(message);
      if (button.dataset.action === 'copy') {
        await window.api.copyText(message.text);
        toast('Copied.', 'success');
      }
    });

    $('new-note').addEventListener('click', newNote);
    $('note-search').addEventListener('input', () => {
      state.noteQuery = $('note-search').value;
      renderNoteList();
    });
    $('editor').addEventListener('submit', saveNoteFromForm);
    $('note-title').addEventListener('input', () => markDirty(false));
    $('note-body').addEventListener('input', () => markDirty(false));
    $('dictate-btn').addEventListener('click', toggleDictation);
    $('cleanup-btn').addEventListener('click', () => runCleanup(true));
    $('preview-btn').addEventListener('click', togglePreview);
    $('delete-note').addEventListener('click', deleteCurrentNote);

    $('settings-form').addEventListener('submit', saveSettings);
    $('model-select').addEventListener('change', () => {
      const custom = $('model-select').value === '__custom';
      $('model-custom').hidden = !custom;
      if (custom) $('model-custom').focus();
    });
    $('toggle-key').addEventListener('click', () => {
      const input = $('api-key');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('toggle-key').textContent = show ? 'Hide' : 'Show';
    });
    $('test-key').addEventListener('click', testKey);
    $('reveal-key').addEventListener('click', revealKey);
    $('clear-key').addEventListener('click', clearKey);
    $('open-data').addEventListener('click', async () => {
      const result = await window.api.openDataDir();
      if (!result.ok) toast(result.error || 'Could not open the data folder.', 'error');
    });
    $('open-ai-studio').addEventListener('click', () => {
      window.api.openExternal('https://aistudio.google.com/apikey');
    });

    $('modal-cancel').addEventListener('click', () => closeModal(false));
    $('modal-confirm').addEventListener('click', () => closeModal(true));
    $('modal').addEventListener('click', (event) => {
      if (event.target === $('modal')) closeModal(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('modal').hidden) {
        closeModal(false);
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 's' && state.view === 'notes' && draft) {
        event.preventDefault();
        saveNoteFromForm();
      }
    });
    window.addEventListener('online', updateBanners);
    window.addEventListener('offline', updateBanners);
    window.api.onMenuAction((action) => {
      if (action === 'new-chat') newChat();
      if (action === 'new-note') newNote();
      if (action === 'settings') showView('settings');
    });
  }

  function renderSuggestions() {
    const wrap = $('suggestions');
    wrap.replaceChildren();
    for (const text of SUGGESTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'suggestion';
      button.textContent = text;
      button.addEventListener('click', () => {
        $('composer-input').value = text;
        autosize($('composer-input'));
        refreshComposerHint();
        $('composer-input').focus();
      });
      wrap.appendChild(button);
    }
  }

  async function init() {
    if (!window.api || !Format) {
      document.body.textContent = 'Open Gemini Notes Chat with Electron (npm start).';
      return;
    }
    bindEvents();
    renderSuggestions();
    try {
      const [settings, notes, chats] = await Promise.all([
        window.api.getSettings(),
        window.api.listNotes(),
        window.api.listChats(),
      ]);
      state.settings = settings;
      state.notes = sortByUpdated(notes || []);
      state.chats = sortByUpdated(chats || []);
      state.activeChatId = state.chats[0] ? state.chats[0].id : null;
      fillSettingsForm();
      updateBanners();
      renderChatList();
      renderMessages();
      renderNoteList();
      showView('chat');
      document.documentElement.dataset.ready = '1';
    } catch (err) {
      document.documentElement.dataset.ready = 'error';
      toast('Could not load local notes and chats.', 'error');
    }
  }

  init();
}());
