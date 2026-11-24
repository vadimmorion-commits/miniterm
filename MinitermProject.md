# MiniTerm — проект

MiniTerm: `C:\Work\miniterm`, публичный MIT-репозиторий `vadimmorion-commits/miniterm` (main, последний коммит «Installer: launch buttons…»). Tauri 2 + xterm.js + Rust (portable-pty). Важна экономия памяти: у владельца всегда открыто 5–6 вкладок. Владелец говорит по-русски. Работает и в WezTerm (конфиг `~/.wezterm.lua` готов: `phys:`-привязки, мгновенный Ctrl+V для распознавалки речи, Alt+V для скриншотов).

**Сборка:** `taskkill //IM miniterm.exe //F`, затем `npx tauri build --no-bundle` (~2–3 мин) → `src-tauri/target/release/miniterm.exe`. Git: коммит только по просьбе, пуш сразу (после коммита пушить сразу, под аккаунтом vadimmorion-commits), трейлер `Co-Authored-By: Claude Sonnet 5.5`.

**Сделано (плагины, панель 🧰, ленивая загрузка через `import()` в `src/plugins/index.ts`):**
- JSON-просмотр (цветное дерево, сохранение текста между вкладками), сравнение JSON, Parquet, время Unix/Киев.
- 🌐 HTTP (Postman-lite): вставка `curl` → разбор, методы, параметры/заголовки/тело/auth, `{{переменные}}`, сохранённые запросы по группам (`http.json` в app data), «копировать как curl». В GUI владельцем ещё не проверен.
- 📦 Установка версий (`src/plugins/install.ts` + команды в `main.rs`): чистая установка из архивов в Downloads в `C:\Work\Front\auto_<ver>` и `C:\Work\Back\auto_<ver>` (имя можно менять); подмена только exe («Подкинуть exe», бэкап в `_backup\<время>`, signed/unsigned); workplace.txt + browser (без backup, пустой cefcache) из существующей установки; шаблон конфига бэка (по умолчанию `C:\Work\Back\1300_test\cfg`) + `Database=<ver>_test` в `mdoconndef.ini`; кнопки ▶ Фронт (`Win64\keeper\FrontKeeper.exe`, сервер стартует сам) и ▶ Бэк (`mdorun.exe`) без параметров.
- Исправления: подчёркивание spellcheck, пустое поле diff, обрезанный prompt (размер PTY), низкое окно терминала при одной панели (`#main > .slot {height:100%}`).

**Why:** конфиг из полного архива с GitHub отличается от рабочего (порт 6432/пользователь master вместо 5432/postgres) и учётка не запускалась — поэтому берётся шаблон cfg из `1300_test`.

**Не проверено владельцем:** «Подкинуть exe» на `auto_1300`, HTTP-модуль, поведение PTY при восстановлении окна.

**Дальше:** дизайн, темы, фоны, шрифты (владелец сказал обсуждать позже); при ветке 1400+ проверить имя базы `<ver>_test` и шаблон cfg; возможно сохранять состояние Diff/Parquet как у JSON.

