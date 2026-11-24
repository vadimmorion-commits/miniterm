#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Ptys(Mutex<HashMap<u32, Pty>>);

fn spawn_shell(
    pair: &portable_pty::PtyPair,
    cwd: &Option<String>,
) -> Result<Box<dyn Child + Send + Sync>, String> {
    let mut last = String::new();
    for exe in ["pwsh.exe", "powershell.exe"] {
        let mut cmd = CommandBuilder::new(exe);
        cmd.arg("-NoLogo");
        if let Some(c) = cwd {
            if std::path::Path::new(c).is_dir() {
                cmd.cwd(c);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        match pair.slave.spawn_command(cmd) {
            Ok(c) => return Ok(c),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<Ptys>,
    id: u32,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let child = spawn_shell(&pair, &cwd)?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let ev_data = format!("pty-data-{id}");
    let ev_exit = format!("pty-exit-{id}");
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) => e.valid_up_to(),
            };
            let incomplete_tail = std::str::from_utf8(&pending)
                .err()
                .map(|e| e.error_len().is_none())
                .unwrap_or(false);
            let emit_len = if incomplete_tail || valid == pending.len() {
                valid
            } else {
                pending.len() // invalid bytes in the middle: emit lossy
            };
            if emit_len > 0 {
                let s = String::from_utf8_lossy(&pending[..emit_len]).into_owned();
                let _ = app.emit(&ev_data, s);
                pending.drain(..emit_len);
            }
        }
        let _ = app.emit(&ev_exit, ());
    });

    state
        .0
        .lock()
        .unwrap()
        .insert(id, Pty { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<Ptys>, id: u32, data: String) {
    if let Some(p) = state.0.lock().unwrap().get_mut(&id) {
        let _ = p.writer.write_all(data.as_bytes());
        let _ = p.writer.flush();
    }
}

#[tauri::command]
fn pty_resize(state: State<Ptys>, id: u32, cols: u16, rows: u16) {
    if let Some(p) = state.0.lock().unwrap().get(&id) {
        let _ = p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
fn pty_kill(state: State<Ptys>, id: u32) {
    if let Some(mut p) = state.0.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
    }
}

/// PSReadLine history, newest first, de-duplicated.
#[tauri::command]
fn read_history() -> Vec<String> {
    let Ok(appdata) = std::env::var("APPDATA") else { return vec![] };
    let path = std::path::Path::new(&appdata)
        .join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt");
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in text.lines().rev() {
        let l = line.trim();
        if l.is_empty() || !seen.insert(l.to_string()) {
            continue;
        }
        out.push(l.to_string());
        if out.len() >= 5000 {
            break;
        }
    }
    out
}

#[derive(serde::Serialize)]
struct Entry {
    name: String,
    dir: bool,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(serde::Serialize)]
struct Found {
    path: String,
    dir: bool,
}

/// Breadth-first name search under `root` (depth <= 6, <= 80 hits), skipping heavy folders.
#[tauri::command]
fn search_paths(root: String, query: String) -> Vec<Found> {
    let q = query.to_lowercase();
    let skip = ["node_modules", ".git", "target", "$RECYCLE.BIN", "System Volume Information", "__pycache__"];
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((std::path::PathBuf::from(&root), 0u8));
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 20000 || out.len() >= 80 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if name.to_lowercase().contains(&q) {
                out.push(Found { path: e.path().to_string_lossy().into_owned(), dir: is_dir });
                if out.len() >= 80 {
                    break;
                }
            }
            if is_dir && depth < 6 && !skip.contains(&name.as_str()) {
                queue.push_back((e.path(), depth + 1));
            }
        }
    }
    out
}

/// Current git branch for a folder (walks up to find .git/HEAD).
#[tauri::command]
fn git_branch(cwd: String) -> Option<String> {
    let mut p = std::path::PathBuf::from(cwd);
    loop {
        let head = p.join(".git").join("HEAD");
        if let Ok(s) = std::fs::read_to_string(&head) {
            let s = s.trim();
            return Some(match s.strip_prefix("ref: refs/heads/") {
                Some(b) => b.to_string(),
                None => s.chars().take(7).collect(),
            });
        }
        if !p.pop() {
            return None;
        }
    }
}

/// Read a text file (<= 50 MB) for the JSON tools.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 50 * 1024 * 1024 {
        return Err("file is larger than 50 MB".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct ParquetInfo {
    columns: Vec<(String, String)>,
    num_rows: i64,
    rows: Vec<serde_json::Value>,
}

/// Schema, total row count and the first `limit` rows of a Parquet file.
#[tauri::command]
fn parquet_read(path: String, limit: usize) -> Result<ParquetInfo, String> {
    use parquet::file::reader::{FileReader, SerializedFileReader};
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
    let meta = reader.metadata().file_metadata();
    let num_rows = meta.num_rows();
    let columns = meta
        .schema_descr()
        .columns()
        .iter()
        .map(|c| (c.path().string(), format!("{:?}", c.physical_type())))
        .collect();
    let rows = reader
        .get_row_iter(None)
        .map_err(|e| e.to_string())?
        .take(limit.min(5000))
        .filter_map(|r| r.ok())
        .map(|r| r.to_json_value())
        .collect();
    Ok(ParquetInfo { columns, num_rows, rows })
}

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, read_history, list_dir, search_paths, git_branch, read_text_file, parquet_read])
        .build(tauri::generate_context!())
        .expect("error while building app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state: State<Ptys> = app.state();
                let mut map = state.0.lock().unwrap();
                for (_, p) in map.iter_mut() {
                    let _ = p.child.kill();
                }
            }
        });
}
