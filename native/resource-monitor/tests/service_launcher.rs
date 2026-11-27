//! The `service-launch` mode the macOS boot service starts T3 through.
#![cfg(unix)]

use std::os::unix::process::ExitStatusExt;
use std::process::Command;

fn launcher() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_t3-resource-monitor"));
    command.arg("service-launch");
    command
}

#[test]
fn exits_with_the_program_status() {
    let status = launcher()
        .args(["/bin/sh", "-c", "exit 7"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(7));
}

#[test]
fn forwards_sigterm() {
    let mut child = launcher()
        .args([
            "/bin/sh",
            "-c",
            "trap 'exit 3' TERM; while :; do sleep 0.05; done",
        ])
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(3), "{status:?}");
    assert_eq!(status.signal(), None);
}

#[test]
fn reports_a_missing_program() {
    let status = launcher().arg("/nonexistent/t3").status().unwrap();
    assert_eq!(status.code(), Some(127));
}
