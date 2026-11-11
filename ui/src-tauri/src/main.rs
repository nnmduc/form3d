#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const DEFAULT_PORT: u16 = 8000;

struct SidecarState(Mutex<Option<Child>>);

fn is_backend_healthy(port: u16) -> bool {
    if let Ok(stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(250),
    ) {
        use std::io::{Read, Write};
        let mut s = stream;
        let _ = s.set_read_timeout(Some(Duration::from_millis(300)));
        let req = format!(
            "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            port
        );
        if s.write_all(req.as_bytes()).is_ok() {
            let mut buf = [0u8; 512];
            if let Ok(n) = s.read(&mut buf) {
                let resp = String::from_utf8_lossy(&buf[..n]);
                return resp.contains("\"status\": \"ok\"") || resp.contains("\"status\":\"ok\"");
            }
        }
    }
    false
}

fn target_triple_suffixes() -> Vec<String> {
    let arch = std::env::consts::ARCH;
    let ext = std::env::consts::EXE_SUFFIX;
    if cfg!(target_os = "macos") {
        vec![format!("{}-apple-darwin{}", arch, ext)]
    } else if cfg!(target_os = "windows") {
        vec![
            format!("{}-pc-windows-msvc{}", arch, ext),
            format!("{}-windows{}", arch, ext),
        ]
    } else {
        vec![
            format!("{}-unknown-linux-gnu{}", arch, ext),
            format!("{}-linux{}", arch, ext),
        ]
    }
}

fn find_sidecar_binary() -> Option<PathBuf> {
    let ext = std::env::consts::EXE_SUFFIX;
    let suffixes = target_triple_suffixes();

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // 1. Inside bundled app (Contents/MacOS/form3d-backend)
            let bundled = exe_dir.join(format!("form3d-backend{}", ext));
            if bundled.exists() {
                return Some(bundled);
            }
            // 2. Next to binary with target triple suffix
            for suffix in &suffixes {
                let with_triple = exe_dir.join(format!("form3d-backend-{}", suffix));
                if with_triple.exists() {
                    return Some(with_triple);
                }
            }
        }
    }

    // 3. Fallback for `tauri dev` in src-tauri
    let binaries_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    for suffix in &suffixes {
        let dev_bin = binaries_dir.join(format!("form3d-backend-{}", suffix));
        if dev_bin.exists() {
            return Some(dev_bin);
        }
    }

    let fallback_arm = binaries_dir.join("form3d-backend-aarch64-apple-darwin");
    if fallback_arm.exists() {
        return Some(fallback_arm);
    }

    None
}

fn build_enriched_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    #[cfg(windows)]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        format!("{}\\.local\\bin;{}\\.cargo\\bin;{}", home, home, current)
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!(
            "{}/.local/bin:{}/.gemini/antigravity-cli/bin:{}/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{}",
            home, home, home, current
        )
    }
}

fn kill_sidecar(state: &SidecarState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            #[cfg(unix)]
            {
                let pid = child.id() as i32;
                let _ = Command::new("kill")
                    .args(["-TERM", &format!("-{}", pid)])
                    .status();
            }
            #[cfg(windows)]
            {
                let pid = child.id();
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            if !is_backend_healthy(DEFAULT_PORT) {
                if let Some(bin_path) = find_sidecar_binary() {
                    let mut cmd = Command::new(&bin_path);
                    cmd.env("PORT", DEFAULT_PORT.to_string())
                        .env("PATH", build_enriched_path());

                    let log_file = std::env::var("HOME").ok().and_then(|home| {
                        let log_dir = PathBuf::from(home).join("Library/Logs/Form 3D");
                        let _ = std::fs::create_dir_all(&log_dir);
                        std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(log_dir.join("backend.log"))
                            .ok()
                    });

                    if let Some(ref file) = log_file {
                        if let Ok(file_out) = file.try_clone() {
                            if let Ok(file_err) = file.try_clone() {
                                cmd.stdout(Stdio::from(file_out)).stderr(Stdio::from(file_err));
                            } else {
                                cmd.stdout(Stdio::null()).stderr(Stdio::null());
                            }
                        } else {
                            cmd.stdout(Stdio::null()).stderr(Stdio::null());
                        }
                    } else {
                        cmd.stdout(Stdio::null()).stderr(Stdio::null());
                    }

                    #[cfg(unix)]
                    cmd.process_group(0);

                    #[cfg(windows)]
                    cmd.creation_flags(CREATE_NO_WINDOW);

                    if let Ok(child) = cmd.spawn() {
                        let state = app.state::<SidecarState>();
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        };

                        // Wait up to 5 seconds for backend to become healthy
                        let start = Instant::now();
                        while start.elapsed() < Duration::from_secs(5) {
                            if is_backend_healthy(DEFAULT_PORT) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(150));
                        }
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Form 3D Studio Tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<SidecarState>();
                kill_sidecar(&state);
            }
        });
}
