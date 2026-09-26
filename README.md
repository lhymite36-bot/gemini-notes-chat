# Gemini Notes Chat

Desktop app for chatting with Google Gemini and keeping notes on your computer. Notes and past conversations open offline. Sending a chat, cleaning up a note, or transcribing recorded audio needs a network connection and your own Gemini API key.

The key is entered in **Settings**. It is stored in the app’s data folder (encrypted with the operating system safe storage when that is available). It is not hardcoded and it is not written into this repository.

## Screenshots

Captured from the running app. Regenerate them with the command in [Capture screenshots](#capture-screenshots). Replace the files if you want updated placeholders in the docs.

![Chat view](docs/screenshots/chat.png)

![Notes view](docs/screenshots/notes.png)

![Settings view](docs/screenshots/settings.png)

## Requirements

- Node.js 20 or newer. This project uses Electron 44, whose package metadata asks for Node 22. On Node 20, `npm install` may print an `EBADENGINE` warning; the app still installs and runs.
- npm
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) for chat and note cleanup

## Install

```bash
npm install
```

## Run in development

```bash
npm start
```

The window opens on the Chat screen. Use **Settings** (or `Ctrl+,`) to paste and save the API key, then send a message. Use **Notes** to write or dictate a note.

On Linux, if Electron exits with a sandbox or SUID error, start it with Chromium’s sandbox disabled:

```bash
npx electron --no-sandbox --disable-gpu .
```

## Where the API key goes

1. Open **Settings**.
2. Paste the key from Google AI Studio.
3. Choose a model. The default is `gemini-2.0-flash`. `gemini-1.5-flash` is also listed, and you can enter another model id.
4. Click **Save settings**. **Test key** checks the key against the selected model.

The key is kept in `settings.json` inside the app data folder. **Settings** shows the exact path and can open that folder.

Typical locations:

| System | Folder |
| --- | --- |
| Linux | `~/.config/gemini-notes-chat/` |
| Windows | `%APPDATA%\gemini-notes-chat\` |
| macOS | `~/Library/Application Support/gemini-notes-chat/` |

Do not commit a key. `.env`, `api-key` files, `node_modules`, and build output are listed in `.gitignore`. The app does not read a key from `.env`.

## Notes and dictation

- **New** creates a note. **Save note** writes it to `notes.json`. **Delete** removes it.
- **Dictate** uses the Web Speech API (`SpeechRecognition` in Chromium) and saves the transcript when you press **Stop**.
- Live transcription usually needs a microphone and a network connection. It does not need an API key.
- If live transcription is unavailable, the app records audio with `MediaRecorder` and asks Gemini to transcribe it. That path needs an API key and a network connection.
- **Clean up & title with Gemini** (during dictation) or **Clean up with Gemini** (while editing) asks the model for a title and a cleaned-up body. Dictation still saves the raw transcript if cleanup fails.
- In chat, **Save as note** stores that message locally.

Dictation language is chosen in Settings. A take stops automatically after two minutes.

## Offline behavior

Saved notes and previous chats load from disk with no network. You can read, edit, create, and delete notes offline. Chat send, key test, cleanup, and audio transcription show a clear error until you are back online with a valid key.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Run the app in development with Electron |
| `npm run build` | Package an unpacked app for the current OS into `dist/` (`electron-builder --dir`) |
| `npm run dist` | Build installers for the current OS |
| `npm run dist:linux` | Linux AppImage and `.deb` |
| `npm run dist:win` | Windows NSIS installer and portable `.exe` |
| `npm run check` | Local checks for note formatting and Gemini request shaping (no network) |

## Build a Linux app

```bash
npm install
npm run build
```

The unpacked app is `dist/linux-unpacked/gemini-notes-chat`. You can run that binary directly.

An AppImage is written to `dist/GeminiNotesChat-1.0.0-x86_64.AppImage`:

```bash
npx electron-builder --linux AppImage --publish never
chmod +x dist/GeminiNotesChat-1.0.0-x86_64.AppImage
./dist/GeminiNotesChat-1.0.0-x86_64.AppImage
```

`npm run dist:linux` also builds a `.deb`. That step needs `fakeroot` (and usually `dpkg`). If it fails, use the unpacked directory or the AppImage.

## Build a Windows installer

Windows targets are already configured in `package.json`:

- NSIS installer: `GeminiNotesChat-Setup-<version>.exe` (per-user, you can choose the folder)
- Portable build: `GeminiNotesChat-Portable-<version>.exe`

On a Windows machine:

```bash
npm install
npm run dist:win
```

Building the Windows installer on Linux needs [Wine](https://www.winehq.org/), because NSIS runs under Wine there. electron-builder does not produce a native Windows `.exe` from Linux without it.

```bash
sudo apt install wine
npm run dist:win
```

Wine was not required to produce the Linux build from this project.

## Build on macOS

```bash
npm install
npx electron-builder --mac dmg
```

Package the Mac app on macOS. A 512×512 PNG is at `assets/icon.png`. electron-builder on macOS can turn that into an `.icns` icon.

## Project structure

```
electron/main.js       Window, menu, IPC, app:// pages
electron/preload.js    The only bridge the page can call
electron/store.js      Notes, chats, and the API key on disk
electron/gemini.js     @google/generative-ai calls
electron/logic.js      Validation and request shaping
renderer/              HTML, CSS, and the UI
assets/icon.png        App icon
assets/icon.ico        Windows icon
docs/screenshots/      Screenshot placeholders
```

## Capture screenshots

With a display available:

```bash
GEMINI_NOTES_SCREENSHOTS=1 npx electron --no-sandbox .
```

That writes `docs/screenshots/chat.png`, `notes.png`, and `settings.png`, then quits. It also stores a sample conversation and a sample note in the app data folder.

## Troubleshooting

- **The key test fails.** Confirm the key in Google AI Studio and try `gemini-1.5-flash` or another model id if `gemini-2.0-flash` is not enabled for that key.
- **“Could not reach Gemini.”** Chat needs the public Gemini API (`generativelanguage.googleapis.com`). A VPN, firewall, or offline network will block it. Notes still open.
- **Dictation does nothing.** Allow the microphone. If Chromium’s speech service is blocked, the app switches to recording plus Gemini transcription when a key is saved.
- **OS encryption unavailable.** On Linux this uses the desktop secret service. Without one, the key is stored in `settings.json` with user-only file permissions. The Settings screen says which mode is in use.
- **Sandbox error on Linux.** Launch with `--no-sandbox`.

## License

MIT. See [LICENSE](LICENSE).
