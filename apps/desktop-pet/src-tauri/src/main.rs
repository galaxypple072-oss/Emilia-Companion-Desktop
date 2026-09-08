// Release builds are a desktop application, not a console tool. Without this
// Windows opens a Terminal window for the Tauri process just to receive stderr
// diagnostics from the frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os();
    let _executable = args.next();
    let command = args.next();
    if command.as_deref() == Some(std::ffi::OsStr::new("--profile-status-file")) {
        let Some(path) = args.next() else {
            eprintln!("missing status file path");
            std::process::exit(2);
        };
        if let Err(error) = std::fs::write(path, personal_companion_desktop_lib::connection_profile_status_json()) {
            eprintln!("cannot write profile status: {error}");
            std::process::exit(1);
        }
        return;
    }
    if command.as_deref() == Some(std::ffi::OsStr::new("--import-profile-file")) {
        let Some(path) = args.next() else {
            eprintln!("missing profile file path");
            std::process::exit(2);
        };
        let result = std::fs::read_to_string(&path)
            .map_err(|error| format!("无法读取连接配置：{error}"))
            .and_then(personal_companion_desktop_lib::import_connection_profile_json);
        let _ = std::fs::remove_file(&path);
        match result {
            Ok(()) => {
                println!("connection profile imported");
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    personal_companion_desktop_lib::run();
}
