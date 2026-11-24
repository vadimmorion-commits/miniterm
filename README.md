# MiniTerm

A small, free and open-source terminal for Windows, built with **Tauri 2 + xterm.js + Rust**.
Warp-style layout (vertical tabs, mini file explorer), light on memory, easy to hack on.

## Features
- Vertical tabs with search, current folder and git branch
- Tabs and split panes restore on restart, each in its own folder
- Mini file explorer: browse, search, double-click to `cd` / insert a path
- Command history search overlay (`Ctrl+R`, reads PSReadLine history)
- Clipboard: text paste, and image paste for CLI tools (sends `Alt+V` when the clipboard holds only an image)
- Dark theme, own window controls

## Shortcuts
| Key | Action |
|---|---|
| Ctrl+T / Ctrl+W | new tab / close pane or tab |
| Ctrl+Tab, Ctrl+1..9 | switch tabs |
| Ctrl+Shift+D / Ctrl+Shift+E | split right / down |
| Alt+Arrows | move between panes |
| Ctrl+R | history search |
| Ctrl+B / Ctrl+Shift+B | toggle tabs / explorer |
| Ctrl+= / Ctrl+- / Ctrl+0 | font size |

## Build
Requirements: Node 20+, Rust (MSVC toolchain), WebView2 (included in Windows 11).

```
npm install
npm run tauri dev            # development
npx tauri build --no-bundle  # release exe in src-tauri/target/release
```

## Roadmap
- Design polish
- Themes, backgrounds, fonts
- Plugins ("mini toolbox"): JSON viewer and diff, Parquet viewer, Unix time converter

## License
MIT
