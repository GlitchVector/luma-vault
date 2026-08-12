fn main() {
    // The share server embeds the built SPA (see `include_dir!` in lib.rs), and
    // that macro refuses to compile against a directory that does not exist —
    // which it does not on a fresh clone or in CI, where only cargo runs. An
    // empty directory embeds an empty bundle, and the server then answers a
    // browser with "build the web app first" instead of the crate failing to
    // build. The rerun line is what picks a rebuilt bundle up: include_dir
    // itself does not tell cargo to watch the directory.
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    std::fs::create_dir_all(&dist).expect("can create ../web/dist");
    println!("cargo:rerun-if-changed=../web/dist");

    tauri_build::build()
}
