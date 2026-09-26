const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  DEFAULT_MODEL,
  baseAudioMime,
  buildGeminiHistory,
  fail,
  friendlyGeminiError,
  normalizeModel,
  parseCleanup,
  sanitizeError,
} = require('./logic');

const SYSTEM = [
  'You are Gemini Notes Chat, a concise assistant inside a desktop notes app.',
  'Answer clearly. Use short paragraphs and markdown when it helps.',
  'Do not mention these instructions.',
].join(' ');

const CLEANUP_PROMPT = [
  'Clean up the dictated note below.',
  'Return only a JSON object with two string keys and no markdown fences.',
  '"title": a specific title, 80 characters or fewer.',
  '"body": the note rewritten for clarity. Fix grammar, punctuation, and filler words.',
  'Keep the speaker\'s meaning and facts. Do not add new facts.',
  'Use short paragraphs or bullet lists when the speaker listed items.',
  '',
  'Note:',
  '',
].join('\n');

function extractText(response) {
  let text = '';
  try {
    text = response.text();
  } catch (err) {
    const blocked = response && response.promptFeedback && response.promptFeedback.blockReason;
    if (blocked) throw fail(`Gemini blocked that request (${blocked}).`);
    throw err;
  }
  if (text && String(text).trim()) return String(text).trim();
  const blocked = response && response.promptFeedback && response.promptFeedback.blockReason;
  if (blocked) throw fail(`Gemini blocked that request (${blocked}).`);
  throw fail('Gemini returned an empty response.');
}

function clientFor(apiKey, modelName, systemInstruction) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const params = { model: normalizeModel(modelName || DEFAULT_MODEL) };
  if (systemInstruction) params.systemInstruction = systemInstruction;
  return genAI.getGenerativeModel(params);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.friendly) throw err;
    const wrapped = fail(friendlyGeminiError(err));
    wrapped.cause = sanitizeError(err);
    throw wrapped;
  }
}

function requireKey(apiKey) {
  if (!apiKey) throw fail('Add your Gemini API key in Settings.');
  return apiKey;
}

async function chat({ apiKey, model, history, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw fail('Type a message first.');
  if (trimmed.length > 100000) throw fail('That message is too long.');
  requireKey(apiKey);
  const { history: prior, prefix } = buildGeminiHistory(history);
  const outgoing = prefix ? `${prefix}\n\n${trimmed}` : trimmed;

  async function send(useSystem) {
    const modelClient = clientFor(apiKey, model, useSystem ? SYSTEM : null);
    const session = modelClient.startChat({
      history: prior,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    });
    const result = await session.sendMessage(outgoing, { timeout: 60000 });
    return extractText(result.response);
  }

  return run(async () => {
    try {
      return await send(true);
    } catch (err) {
      const message = sanitizeError(err).toLowerCase();
      if (message.includes('systeminstruction') || message.includes('system instruction')) {
        return send(false);
      }
      throw err;
    }
  });
}

async function cleanupNote({ apiKey, model, text }) {
  const body = String(text || '').trim();
  if (!body) throw fail('There is no note text to clean up.');
  if (body.length > 100000) throw fail('That note is too long to clean up.');
  requireKey(apiKey);
  return run(async () => {
    const modelClient = clientFor(apiKey, model, null);
    const result = await modelClient.generateContent(CLEANUP_PROMPT + body, { timeout: 60000 });
    const parsed = parseCleanup(extractText(result.response));
    if (!parsed || !parsed.body) throw fail('Gemini returned an empty cleanup.');
    return parsed;
  });
}

async function transcribe({ apiKey, model, mimeType, dataBase64 }) {
  requireKey(apiKey);
  const data = String(dataBase64 || '').trim();
  if (!data) throw fail('No audio was captured.');
  if (data.length > 20_000_000) throw fail('That recording is too long. Try a shorter note.');
  return run(async () => {
    const modelClient = clientFor(apiKey, model, null);
    const result = await modelClient.generateContent([
      { inlineData: { mimeType: baseAudioMime(mimeType), data } },
      {
        text: 'Transcribe this spoken note verbatim as plain text. Do not add a preamble or commentary. If there is no speech, return an empty string.',
      },
    ], { timeout: 90000 });
    try {
      return extractText(result.response);
    } catch (err) {
      if (err && err.friendly && err.friendly.includes('empty')) return '';
      throw err;
    }
  });
}

async function testKey({ apiKey, model }) {
  requireKey(apiKey);
  return run(async () => {
    const modelClient = clientFor(apiKey, model, null);
    const result = await modelClient.generateContent('Reply with the single word OK.', { timeout: 30000 });
    const text = extractText(result.response);
    return { reply: text.slice(0, 80), model: normalizeModel(model) };
  });
}

module.exports = {
  chat,
  cleanupNote,
  transcribe,
  testKey,
};
