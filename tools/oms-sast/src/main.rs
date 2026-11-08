use std::{fs, io::{self, Read}, path::{Component, Path}};

fn read_input(file: &str) -> Result<String, String> {
    let path = Path::new(file);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("expected a relative path without traversal".into());
    }
    let root = std::env::current_dir().map_err(|_| "cannot resolve working directory")?.canonicalize().map_err(|_| "cannot resolve working directory")?;
    let mut current = root.clone();
    for part in path.components() {
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|_| "cannot inspect source")?;
        if metadata.file_type().is_symlink() { return Err("symlinks are not source inputs".into()); }
    }
    let resolved = current.canonicalize().map_err(|_| "cannot resolve source")?;
    if !resolved.starts_with(&root) { return Err("source escaped working directory".into()); }
    let metadata = fs::metadata(&resolved).map_err(|_| "cannot inspect source")?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 { return Err("source must be a regular file under 1 MiB".into()); }
    let mut source = String::new();
    fs::File::open(&resolved).map_err(|_| "cannot read source")?.take(1024 * 1024 + 1)
        .read_to_string(&mut source).map_err(|_| "source is not UTF-8")?;
    if source.len() > 1024 * 1024 { return Err("source exceeds 1 MiB".into()); }
    Ok(source)
}
fn scan(file: &str, lock: Option<&str>) -> Result<oms_sast::Analysis, String> {
    if !file.ends_with(".rs") { return Err("expected a .rs source path".into()); }
    let source = read_input(file)?;
    let mut analysis = oms_sast::analyze(file, &source).map_err(|error| format!("invalid Rust syntax: {error}"))?;
    if let Some(lock) = lock {
        oms_sast::cve::append(&mut analysis, file, &source, &read_input(lock)?)?;
    }
    Ok(analysis)
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [version] if version == "--version" => println!("oms-sast 0.1.0"),
        [flag, file] if flag == "--inventory" => {
            let result = read_input(file).and_then(|source| {
                if file.ends_with(".rs") {
                    oms_sast::inventory::source(file, &source).and_then(|v| serde_json::to_value(v).map_err(|_| "serialization failed".into()))
                } else if Path::new(file).file_name().is_some_and(|n| n == "Cargo.toml") {
                    oms_sast::inventory::manifest(&source).and_then(|v| serde_json::to_value(v).map_err(|_| "serialization failed".into()))
                } else { Err("expected Rust source or Cargo.toml".into()) }
            });
            match result {
                Ok(value) => { if serde_json::to_writer(io::stdout(), &value).is_err() { std::process::exit(1); } }
                Err(error) => { eprintln!("oms-sast: {error}"); std::process::exit(1); }
            }
        },
        [flag, file] if flag == "--manifest" => match read_input(file).and_then(|source| oms_sast::manifest::analyze(file, &source)) {
            Ok(result) => { if serde_json::to_writer(io::stdout(), &result).is_err() { std::process::exit(1); } }
            Err(error) => { eprintln!("oms-sast: {error}"); std::process::exit(1); }
        },
        [flag, file] if flag == "--file" => match scan(file, None) {
            Ok(result) => { if serde_json::to_writer(io::stdout(), &result).is_err() { std::process::exit(1); } }
            Err(error) => { eprintln!("oms-sast: {error}"); std::process::exit(1); }
        },
        [flag, file, lock_flag, lock] if flag == "--file" && lock_flag == "--lockfile" => match scan(file, Some(lock)) {
            Ok(result) => { if serde_json::to_writer(io::stdout(), &result).is_err() { std::process::exit(1); } }
            Err(error) => { eprintln!("oms-sast: {error}"); std::process::exit(1); }
        },
        _ => { eprintln!("usage: oms-sast --version | --manifest <relative Cargo.toml> | --file <relative.rs> [--lockfile <relative Cargo.lock>]"); std::process::exit(2); }
    }
}
