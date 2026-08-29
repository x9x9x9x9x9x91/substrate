fn main() {
    // Tauri validates externalBin paths while compiling the package, before
    // its beforeBundleCommand has had a chance to build our second bin target.
    // Seed an ignored, non-serving placeholder so ordinary `cargo test --lib`
    // and the main app compile can reach that hook. The hook always replaces
    // it with the real same-profile `substrate-mcp` and fails the bundle if it
    // cannot; a placeholder can therefore never enter a successful package.
    //
    // It has to land in the source tree, not OUT_DIR: `externalBin` in
    // tauri.macos.conf.json is a path relative to that config file and takes no
    // build-time expansion, so the file Tauri validates is the one under
    // `binaries/`. That makes it a build artifact sitting among tracked
    // sources, so `.gitignore` covers `/src-tauri/binaries/substrate-mcp-*` —
    // stage explicit paths, never `git add -A` from a stale checkout.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("no cargo manifest dir"),
        );
        let target = std::env::var("TARGET").expect("no cargo target triple");
        let path = manifest.join("binaries").join(format!("substrate-mcp-{target}"));
        if !path.exists() {
            std::fs::create_dir_all(path.parent().expect("sidecar path has no parent"))
                .expect("could not create sidecar staging dir");
            std::fs::write(&path, b"#!/bin/sh\nexit 1\n")
                .expect("could not create sidecar placeholder");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .expect("could not mark sidecar placeholder executable");
            }
        }
    }
    // The view evaluator the MCP door runs is built into the same staged
    // directory by `scripts/build-view-engine.ts`, from the same build hooks,
    // and needs the same seeding for the same reason: `tauri_build::build()`
    // fails on a resource path that is not there, and a bare `cargo build` or
    // `cargo test` runs no hook. Outside the marked region below because this
    // one is not a prune — every build of this app carries the engine, so the
    // public snapshot seeds it too.
    {
        let dir = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("no cargo manifest dir"),
        )
        .join("gen")
        .join("bundle-resources")
        .join("viewengine");
        std::fs::create_dir_all(&dir).expect("could not create staged resource dir");
    }

    tauri_build::build()
}
