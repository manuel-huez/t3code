//! `t3-resource-monitor service-launch PROGRAM [ARGS...]` starts PROGRAM, forwards the signals
//! a service manager sends, and exits as PROGRAM did.
//!
//! macOS records Full Disk Access and other privacy grants for the program launchd starts, by
//! its path, and applies them to everything that program starts. T3's own executable moves to a
//! new directory with each version, so the macOS boot service starts it through a copy of this
//! binary at a fixed path. The launcher spawns rather than execs: after an exec, macOS would
//! check the moving executable instead.

use std::ffi::OsString;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, exit};
use std::sync::atomic::{AtomicI32, Ordering};

pub const COMMAND: &str = "service-launch";

const FORWARDED_SIGNALS: [libc::c_int; 6] = [
    libc::SIGTERM,
    libc::SIGINT,
    libc::SIGHUP,
    libc::SIGQUIT,
    libc::SIGUSR1,
    libc::SIGUSR2,
];

static CHILD_PID: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward_signal(signal: libc::c_int) {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        // kill is async-signal-safe.
        unsafe { libc::kill(pid, signal) };
    }
}

fn forwarded_set() -> libc::sigset_t {
    unsafe {
        let mut set = std::mem::zeroed::<libc::sigset_t>();
        libc::sigemptyset(&mut set);
        for signal in FORWARDED_SIGNALS {
            libc::sigaddset(&mut set, signal);
        }
        set
    }
}

pub fn run(mut args: impl Iterator<Item = OsString>) -> ! {
    let Some(program) = args.next() else {
        eprintln!("usage: t3-resource-monitor {COMMAND} PROGRAM [ARGS...]");
        exit(64);
    };
    let forwarded = forwarded_set();
    let mut original = unsafe { std::mem::zeroed::<libc::sigset_t>() };
    // Hold the signals until the child exists, so none arrives with no child to forward it to.
    unsafe {
        libc::sigprocmask(libc::SIG_BLOCK, &forwarded, &mut original);
        for signal in FORWARDED_SIGNALS {
            libc::signal(
                signal,
                forward_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
    let mut command = Command::new(&program);
    command.args(args);
    // exec resets the handlers in the child; the mask it would inherit is restored here.
    unsafe {
        command.pre_exec(move || {
            libc::sigprocmask(libc::SIG_SETMASK, &original, std::ptr::null_mut());
            Ok(())
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("t3-resource-monitor {COMMAND}: cannot start {program:?}: {error}");
            exit(127);
        }
    };
    CHILD_PID.store(child.id() as i32, Ordering::SeqCst);
    unsafe { libc::sigprocmask(libc::SIG_SETMASK, &original, std::ptr::null_mut()) };
    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            eprintln!("t3-resource-monitor {COMMAND}: cannot wait for {program:?}: {error}");
            exit(1);
        }
    };
    if let Some(code) = status.code() {
        exit(code);
    }
    let signal = status.signal().unwrap_or(libc::SIGTERM);
    // End by the same signal, so launchd sees how the program ended.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
    }
    exit(128 + signal);
}
