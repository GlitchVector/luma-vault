// The webview is the UI; a console window on Windows would be a second,
// empty one. Only suppressed in release so `cargo run` still prints logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    luma_vault_lib::run()
}
