const assert = require('assert');
const logic = require('../electron/logic');
const format = require('../renderer/format');

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err);
  }
}

test('redacts API keys in errors', () => {
  const message = logic.sanitizeError(new Error('request failed key=AIzaSyABC1234567890XYZ and AIzaSyABC1234567890XYZ'));
  assert.strictEqual(message.includes('AIza'), false);
  assert.ok(message.includes('REDACTED'));
});

test('friendly network and key errors', () => {
  assert.match(logic.friendlyGeminiError(new Error('API key not valid')), /rejected the API key/);
  assert.match(logic.friendlyGeminiError(new Error('getaddrinfo ENOTFOUND')), /internet connection/);
  assert.match(logic.friendlyGeminiError(new Error('429 quota')), /quota/);
});

test('history alternates and folds a trailing user turn', () => {
  const { history, prefix } = logic.buildGeminiHistory([
    { role: 'model', text: 'skip me' },
    { role: 'user', text: 'Hello' },
    { role: 'user', text: 'Again' },
    { role: 'model', text: 'Hi' },
    { role: 'user', text: 'Latest' },
  ]);
  assert.strictEqual(history[0].role, 'user');
  assert.strictEqual(history[0].parts[0].text, 'Hello\n\nAgain');
  assert.strictEqual(history[1].role, 'model');
  assert.strictEqual(history.length, 2);
  assert.strictEqual(prefix, 'Latest');
});

test('parses fenced cleanup JSON and plain text', () => {
  const parsed = logic.parseCleanup('```json\n{"title":"Market","body":"Buy apples."}\n```');
  assert.strictEqual(parsed.title, 'Market');
  assert.strictEqual(parsed.body, 'Buy apples.');
  const plain = logic.parseCleanup('Just a sentence about trains.');
  assert.ok(plain.body.includes('trains'));
  assert.ok(plain.title.length > 0);
});

test('rejects empty notes and titles from the body', () => {
  assert.throws(() => logic.normalizeNote({ title: '   ', body: '\n' }), /before saving/);
  const note = logic.normalizeNote({ title: '', body: 'Pack the charger\nAnd a notebook' });
  assert.strictEqual(note.title, 'Pack the charger');
  assert.strictEqual(note.source, 'manual');
  assert.ok(logic.acceptableId(note.id));
});

test('normalizes chats and drops empty ones', () => {
  assert.throws(() => logic.normalizeChat({ messages: [] }), /empty/i);
  const chat = logic.normalizeChat({
    title: '',
    messages: [{ role: 'user', text: 'Plan the Sunday reset please' }],
  });
  assert.strictEqual(chat.messages.length, 1);
  assert.ok(chat.title.toLowerCase().includes('sunday'));
});

test('model and key validation', () => {
  assert.strictEqual(logic.normalizeModel('gemini-3.5-flash'), 'gemini-3.5-flash');
  assert.strictEqual(logic.normalizeModel('gemini-2.0-flash'), logic.DEFAULT_MODEL);
  assert.strictEqual(logic.normalizeModel('gemini-2.5-flash'), logic.DEFAULT_MODEL);
  assert.strictEqual(logic.normalizeModel('gemini-1.5-flash'), logic.DEFAULT_MODEL);
  assert.strictEqual(logic.normalizeModel('../etc/passwd'), logic.DEFAULT_MODEL);
  assert.strictEqual(logic.normalizeLang('en-US'), 'en-US');
  assert.throws(() => logic.normalizeApiKey('short'), /does not look valid/);
  assert.strictEqual(logic.normalizeApiKey(''), '');
  assert.strictEqual(logic.baseAudioMime('audio/webm;codecs=opus'), 'audio/webm');
});

test('markdown escapes html and renders lists', () => {
  const html = format.renderMarkdown('<script>alert(1)</script>\n\n**Bold** and `code`\n\n- One\n- Two\n\n```\nconst x = 1;\n```');
  assert.strictEqual(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>Bold</strong>'));
  assert.ok(html.includes('<li>One</li>'));
  assert.ok(html.includes('<pre class="codeblock">'));
  const link = format.renderMarkdown('[Docs](https://ai.google.dev/gemini-api/docs)');
  assert.ok(link.includes('href="https://ai.google.dev/gemini-api/docs"'));
  const bad = format.renderMarkdown('[x](javascript:alert(1))');
  assert.strictEqual(bad.includes('href="javascript:'), false);
});

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all checks passed');
