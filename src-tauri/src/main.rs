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

#[derive(serde::Deserialize)]
struct HttpReq {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    insecure: bool,
    follow: bool,
    timeout_s: u64,
}

#[derive(serde::Serialize)]
struct HttpResp {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    size: usize,
    time_ms: u128,
    binary: bool,
}

fn do_request(req: HttpReq) -> Result<HttpResp, String> {
    use ureq::{http, tls::TlsConfig, Agent};
    let start = std::time::Instant::now();
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(if req.follow { 10 } else { 0 })
        .timeout_global(Some(std::time::Duration::from_secs(req.timeout_s.max(1))))
        .tls_config(TlsConfig::builder().disable_verification(req.insecure).build())
        .build()
        .into();
    let mut b = http::Request::builder().method(req.method.as_str()).uri(req.url.as_str());
    for (k, v) in &req.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let request = b.body(req.body.unwrap_or_default().into_bytes()).map_err(|e| e.to_string())?;
    let mut resp = agent.run(request).map_err(|e| e.to_string())?;
    let status = resp.status();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let bytes = resp
        .body_mut()
        .with_config()
        .limit(20 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| e.to_string())?;
    let size = bytes.len();
    let (body, binary) = match String::from_utf8(bytes) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    };
    Ok(HttpResp {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        size,
        time_ms: start.elapsed().as_millis(),
        binary,
    })
}

#[tauri::command]
async fn http_request(req: HttpReq) -> Result<HttpResp, String> {
    tauri::async_runtime::spawn_blocking(move || do_request(req))
        .await
        .map_err(|e| e.to_string())?
}

fn store_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err("bad store name".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
fn store_read(app: AppHandle, name: String) -> Result<String, String> {
    let p = store_path(&app, &name)?;
    if !p.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn store_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let p = store_path(&app, &name)?;
    std::fs::write(p, text).map_err(|e| e.to_string())
}

// ---------------- installer (versions, archives) ----------------
use std::path::{Path, PathBuf};

fn tar_extract(archive: &Path, dest: &Path, gz: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let tar = if Path::new(r"C:\Windows\System32\tar.exe").exists() { r"C:\Windows\System32\tar.exe" } else { "tar" };
    let mut cmd = std::process::Command::new(tar);
    cmd.arg(if gz { "-xzf" } else { "-xf" }).arg(archive).arg("-C").arg(dest).creation_flags(0x0800_0000);
    let out = cmd.output().map_err(|e| format!("tar: {e}"))?;
    if !out.status.success() {
        return Err(format!("распаковка {}: {}", archive.display(), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path, skip: &dyn Fn(&Path, bool) -> bool, n: &mut usize) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for ent in std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))?.flatten() {
        let p = ent.path();
        let is_dir = p.is_dir();
        if skip(&p, is_dir) {
            continue;
        }
        let t = dst.join(ent.file_name());
        if is_dir {
            copy_tree(&p, &t, skip, n)?;
        } else {
            std::fs::copy(&p, &t).map_err(|e| format!("{}: {e}", t.display()))?;
            *n += 1;
        }
    }
    Ok(())
}

fn find_inner_zip(root: &Path, ver: &str) -> Option<PathBuf> {
    let suffix = format!("_{ver}");
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case("win64.zip")).unwrap_or(false) {
                let parent = p.parent().and_then(|x| x.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if parent.ends_with(&suffix) {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn first_subdir(p: &Path) -> Option<PathBuf> {
    std::fs::read_dir(p).ok()?.flatten().map(|e| e.path()).find(|x| x.is_dir())
}

fn temp_dir(tag: &str) -> PathBuf {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    std::env::temp_dir().join(format!("miniterm_{tag}_{t}"))
}

#[derive(serde::Deserialize)]
struct InstReq {
    kind: String, // "front" | "back"
    full_zip: String,
    exe_zip: Option<String>,
    ver: String,
    dest: String,
    wp_src: Option<String>,      // existing Win64 folder to take workplace.txt from (front)
    browser_src: Option<String>, // existing browser folder (front)
    cfg_src: Option<String>,     // template cfg folder (back): copied over dest/cfg
    db_name: Option<String>,     // Database= value for cfg/mdoconndef.ini (back)
}

fn do_install(r: InstReq) -> Result<Vec<String>, String> {
    let mut log = vec![];
    let dest = PathBuf::from(&r.dest);
    if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("папка уже существует и не пуста: {}", r.dest));
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let tmp = temp_dir(&format!("inst_{}", r.kind));
    let res = (|| -> Result<(), String> {
        let t1 = tmp.join("full");
        tar_extract(Path::new(&r.full_zip), &t1, false)?;
        log.push(format!("распакован полный архив: {}", r.full_zip));
        let inner = find_inner_zip(&t1, &r.ver).ok_or_else(|| format!("в архиве нет вложенного win64.zip для версии {}", r.ver))?;
        if r.kind == "front" {
            tar_extract(&inner, &dest, false)?;
            log.push(format!("основа фронта -> {}", r.dest));
        } else {
            let t2 = tmp.join("inner");
            tar_extract(&inner, &t2, false)?;
            let w = first_subdir(&t2).ok_or("пустой win64.zip")?;
            let mut n = 0;
            copy_tree(&w, &dest, &|_, _| false, &mut n)?;
            log.push(format!("основа бэка -> {} ({n} файлов)", r.dest));
        }
        if let Some(ez) = &r.exe_zip {
            let t3 = tmp.join("exe");
            tar_extract(Path::new(ez), &t3, false)?;
            let mut n = 0;
            if r.kind == "front" {
                let tgz = std::fs::read_dir(&t3).map_err(|e| e.to_string())?.flatten().map(|e| e.path())
                    .find(|p| p.extension().map(|x| x == "tgz").unwrap_or(false)).ok_or("в архиве нет .tgz")?;
                let t4 = tmp.join("tgz");
                tar_extract(&tgz, &t4, true)?;
                let root = first_subdir(&t4).ok_or("пустой tgz")?;
                copy_tree(&root, &dest.join("Win64"), &|_, _| false, &mut n)?;
            } else {
                let exe = t3.join("Win64").join("mdorun.exe");
                std::fs::copy(&exe, dest.join("mdorun.exe")).map_err(|e| format!("mdorun.exe: {e}"))?;
                n = 1;
            }
            log.push(format!("наложены exe из {} ({n} файлов)", ez));
        }
        if r.kind == "back" {
            if let Some(c) = &r.cfg_src {
                let mut n = 0;
                copy_tree(Path::new(c), &dest.join("cfg"), &|_, _| false, &mut n)?;
                log.push(format!("конфиг из {c} ({n} файлов)"));
                if let Some(db) = &r.db_name {
                    let f = dest.join("cfg").join("mdoconndef.ini");
                    let txt = std::fs::read_to_string(&f).map_err(|e| format!("mdoconndef.ini: {e}"))?;
                    let mut found = false;
                    let out: Vec<String> = txt
                        .split('\n')
                        .map(|l| {
                            let t = l.trim_start_matches('\u{feff}').trim_start();
                            if t.to_lowercase().starts_with("database=") {
                                found = true;
                                let bom = if l.starts_with('\u{feff}') { "\u{feff}" } else { "" };
                                let cr = if l.ends_with('\r') { "\r" } else { "" };
                                format!("{bom}Database={db}{cr}")
                            } else {
                                l.to_string()
                            }
                        })
                        .collect();
                    if !found {
                        return Err("в mdoconndef.ini нет строки Database=".into());
                    }
                    std::fs::write(&f, out.join("\n")).map_err(|e| e.to_string())?;
                    log.push(format!("база: Database={db}"));
                }
            }
        }
        if r.kind == "front" {
            let w64 = dest.join("Win64");
            if let Some(wp) = &r.wp_src {
                for sub in ["keeper", "server"] {
                    let src = Path::new(wp).join(sub).join("workplace.txt");
                    if src.exists() {
                        std::fs::copy(&src, w64.join(sub).join("workplace.txt")).map_err(|e| format!("workplace.txt: {e}"))?;
                        log.push(format!("workplace.txt -> {sub}"));
                    } else {
                        log.push(format!("нет workplace.txt в {}", src.display()));
                    }
                }
            }
            if let Some(b) = &r.browser_src {
                let mut n = 0;
                let skip = |p: &Path, is_dir: bool| {
                    let name = p.file_name().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                    (is_dir && (name == "backup" || name == "cefcache")) || (!is_dir && name.ends_with(".log"))
                };
                copy_tree(Path::new(b), &w64.join("browser"), &skip, &mut n)?;
                std::fs::create_dir_all(w64.join("browser").join("cefcache")).map_err(|e| e.to_string())?;
                log.push(format!("браузер скопирован ({n} файлов), cefcache пуст, без backup"));
            }
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    res.map(|_| log)
}

#[tauri::command]
async fn install_version(req: InstReq) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || do_install(req)).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct FileDiff {
    rel: String,
    status: String, // new | changed | same
    exe: bool,
    size: u64,
}
#[derive(serde::Serialize)]
struct Preview {
    stage: String,
    files: Vec<FileDiff>,
}

fn same_bytes(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else { return false };
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let (Ok(na), Ok(nb)) = (fa.read(&mut ba), fb.read(&mut bb)) else { return false };
        if na != nb || ba[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

fn walk_files(root: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk_files(&p, base, out)
            } else {
                out.push(p.strip_prefix(base).unwrap().to_path_buf())
            }
        }
    }
}

fn do_preview(kind: String, exe_zip: String, dest: String) -> Result<Preview, String> {
    let stage_base = std::env::temp_dir().join("miniterm_stage");
    let _ = std::fs::remove_dir_all(&stage_base);
    let t3 = stage_base.join("exe");
    tar_extract(Path::new(&exe_zip), &t3, false)?;
    let (stage, target): (PathBuf, PathBuf) = if kind == "front" {
        let tgz = std::fs::read_dir(&t3).map_err(|e| e.to_string())?.flatten().map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "tgz").unwrap_or(false)).ok_or("в архиве нет .tgz")?;
        let t4 = stage_base.join("tgz");
        tar_extract(&tgz, &t4, true)?;
        (first_subdir(&t4).ok_or("пустой tgz")?, Path::new(&dest).join("Win64"))
    } else {
        (t3.join("Win64"), PathBuf::from(&dest))
    };
    let mut rels = vec![];
    walk_files(&stage, &stage, &mut rels);
    let mut files = vec![];
    for rel in rels {
        let src = stage.join(&rel);
        let dst = target.join(&rel);
        let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        let status = if !dst.exists() {
            "new"
        } else if std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0) != size || !same_bytes(&src, &dst) {
            "changed"
        } else {
            "same"
        };
        let exe = rel.extension().map(|x| x.to_string_lossy().eq_ignore_ascii_case("exe")).unwrap_or(false);
        files.push(FileDiff { rel: rel.to_string_lossy().replace('\\', "/"), status: status.into(), exe, size });
    }
    files.sort_by(|a, b| (!a.exe).cmp(&!b.exe).then(a.rel.cmp(&b.rel)));
    Ok(Preview { stage: stage.to_string_lossy().into_owned(), files })
}

#[tauri::command]
async fn update_preview(kind: String, exe_zip: String, dest: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || do_preview(kind, exe_zip, dest)).await.map_err(|e| e.to_string())?
}

fn stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}{m:02}{d:02}_{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[tauri::command]
async fn update_apply(kind: String, stage: String, dest: String, files: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let target = if kind == "front" { Path::new(&dest).join("Win64") } else { PathBuf::from(&dest) };
        let backup = target.join("_backup").join(stamp());
        let mut log = vec![];
        for rel in files {
            if rel.split('/').any(|c| c == ".." || c.is_empty()) || rel.contains(':') {
                return Err(format!("недопустимый путь: {rel}"));
            }
            let src = Path::new(&stage).join(&rel);
            let dst = target.join(&rel);
            if dst.exists() {
                let b = backup.join(&rel);
                if let Some(pp) = b.parent() {
                    std::fs::create_dir_all(pp).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&dst, &b).map_err(|e| format!("бэкап {rel}: {e}"))?;
            }
            if let Some(pp) = dst.parent() {
                std::fs::create_dir_all(pp).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&src, &dst).map_err(|e| format!("{rel}: {e} (возможно, программа запущена — закрой её)"))?;
            log.push(format!("✓ {rel}"));
        }
        log.push(format!("бэкап старых файлов: {}", backup.display()));
        Ok(log)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct ArchiveInfo {
    name: String,
    size: u64,
    mtime: u64,
}

#[tauri::command]
fn list_archives(dir: String) -> Result<Vec<ArchiveInfo>, String> {
    let mut v: Vec<ArchiveInfo> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().to_string();
            if !m.is_file() || !name.to_lowercase().ends_with(".zip") {
                return None;
            }
            let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some(ArchiveInfo { name, size: m.len(), mtime })
        })
        .collect();
    v.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    v.truncate(80);
    Ok(v)
}

#[tauri::command]
fn downloads_dir() -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    Ok(format!("{home}{}Downloads", std::path::MAIN_SEPARATOR))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, read_history, list_dir, search_paths, git_branch, read_text_file, parquet_read, http_request, store_read, store_write, install_version, update_preview, update_apply, list_archives, path_exists, downloads_dir])
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
