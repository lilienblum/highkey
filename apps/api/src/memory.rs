//! A ceiling on the API's own memory.
//!
//! DuckDB's `memory_limit` covers its buffers and aggregate states, not every allocation: a
//! single string or list value, among others, is untracked. Without a ceiling, one runaway
//! query grows until the kernel's OOM killer takes the API down (ingestion included), or
//! starves the rest of the host. So on Linux the API sets `RLIMIT_DATA` at startup: an
//! allocation past it fails instead, which DuckDB reports as an Out of Memory error for that
//! one query. An allocation of the API's own that fails still ends the process, as the OOM
//! killer would, but the host keeps its memory.
//!
//! `RLIMIT_DATA` counts the process's private writable mappings (heap, `mmap`ed allocations
//! and thread stacks) whether or not they are resident, so the default leaves a fifth of the
//! host's memory for everything else.
use std::path::{Path, PathBuf};

/// The setting that overrides the default ceiling.
pub const SETTING: &str = "PIKO_MEMORY_LIMIT";
/// The default ceiling is this share (in percent) of the smaller of the cgroup memory limit and
/// the host's memory.
const SHARE_PERCENT: u64 = 80;

/// The ceiling to set, and why.
#[derive(Debug, PartialEq, Eq)]
pub enum Ceiling {
    /// From `PIKO_MEMORY_LIMIT`.
    Configured(u64),
    /// `SHARE_PERCENT` of `of`, the smaller of the cgroup limit and the host's memory.
    Derived { bytes: u64, of: u64 },
    /// `PIKO_MEMORY_LIMIT` is `0` or `off`.
    Off,
    /// Neither a cgroup limit nor the host's memory could be read.
    Unknown,
    /// Not Linux, where `RLIMIT_DATA` would not count every allocation the same way.
    Unsupported,
}
impl Ceiling {
    pub fn bytes(&self) -> Option<u64> {
        match self {
            Self::Configured(bytes) | Self::Derived { bytes, .. } => Some(*bytes),
            Self::Off | Self::Unknown | Self::Unsupported => None,
        }
    }
}

/// `PIKO_MEMORY_LIMIT`: bytes with an optional `K`, `M` or `G` suffix (powers of 1,024), or
/// `0` or `off` for no ceiling, which is `None`.
pub fn parse_setting(text: &str) -> Result<Option<u64>, String> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("off") {
        return Ok(None);
    }
    let (digits, scale) = match text.char_indices().last() {
        Some((at, unit)) if unit.is_ascii_alphabetic() => {
            let scale: u64 = match unit.to_ascii_uppercase() {
                'K' => 1 << 10,
                'M' => 1 << 20,
                'G' => 1 << 30,
                _ => return Err(invalid(text)),
            };
            (&text[..at], scale)
        }
        _ => (text, 1),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid(text));
    }
    let bytes = digits
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(scale))
        .ok_or_else(|| invalid(text))?;
    Ok((bytes > 0).then_some(bytes))
}

fn invalid(text: &str) -> String {
    format!(
        "{SETTING} must be bytes with an optional K, M or G suffix (such as 2G), or 0 or off for no limit; got `{text}`"
    )
}

/// A cgroup limit file's value: cgroup v2 `memory.max` (`max` when unlimited) or cgroup v1
/// `memory.limit_in_bytes` (a huge number when unlimited, which the host's memory undercuts).
fn cgroup_limit(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

/// `MemTotal` from `/proc/meminfo`, in bytes.
fn mem_total(meminfo: &str) -> Option<u64> {
    let line = meminfo.lines().find(|l| l.starts_with("MemTotal:"))?;
    let mut parts = line["MemTotal:".len()..].split_whitespace();
    let n: u64 = parts.next()?.parse().ok()?;
    match parts.next() {
        Some("kB") | None => n.checked_mul(1024),
        Some(_) => None,
    }
}

/// The ceiling for a `setting` (the value of `PIKO_MEMORY_LIMIT`, if set), the contents of the
/// cgroup limit files that apply to the process, and `/proc/meminfo`.
pub fn ceiling(
    setting: Option<&str>,
    cgroup_limits: &[String],
    meminfo: Option<&str>,
) -> Result<Ceiling, String> {
    if let Some(text) = setting {
        return Ok(match parse_setting(text)? {
            Some(bytes) => Ceiling::Configured(bytes),
            None => Ceiling::Off,
        });
    }
    let of = cgroup_limits
        .iter()
        .filter_map(|text| cgroup_limit(text))
        .chain(meminfo.and_then(mem_total))
        .min();
    Ok(match of {
        Some(of) => Ceiling::Derived {
            bytes: (of as u128 * u128::from(SHARE_PERCENT) / 100) as u64,
            of,
        },
        None => Ceiling::Unknown,
    })
}

/// The cgroup limit files that apply to a process whose `/proc/self/cgroup` is `cgroups`: its
/// own cgroup's and every ancestor's, for cgroup v2 and for a v1 memory controller. Inside a
/// container with its own cgroup namespace, the process's cgroup is the root of `root`.
pub fn cgroup_files(cgroups: &str, root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for line in cgroups.lines() {
        let mut fields = line.splitn(3, ':');
        let (Some(_), Some(controllers), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (base, file) = if controllers.is_empty() {
            (root.to_path_buf(), "memory.max")
        } else if controllers.split(',').any(|c| c == "memory") {
            (root.join("memory"), "memory.limit_in_bytes")
        } else {
            continue;
        };
        let mut at = Some(Path::new(path.trim()));
        while let Some(dir) = at {
            let relative = dir.strip_prefix("/").unwrap_or(dir);
            files.push(base.join(relative).join(file));
            at = dir.parent();
        }
    }
    files
}

/// Reads the limits that apply to this process and sets the ceiling, which it returns. Only
/// Linux has one; elsewhere (development on macOS) this checks the setting and returns
/// `Unsupported`.
pub fn apply() -> anyhow::Result<Ceiling> {
    let setting = std::env::var(SETTING).ok();
    #[cfg(target_os = "linux")]
    {
        let read = |path: &Path| std::fs::read_to_string(path).ok();
        let cgroups = read(Path::new("/proc/self/cgroup")).unwrap_or_default();
        let limits: Vec<String> = cgroup_files(&cgroups, Path::new("/sys/fs/cgroup"))
            .iter()
            .filter_map(|path| read(path))
            .collect();
        let meminfo = read(Path::new("/proc/meminfo"));
        let ceiling =
            ceiling(setting.as_deref(), &limits, meminfo.as_deref()).map_err(anyhow::Error::msg)?;
        if let Some(bytes) = ceiling.bytes() {
            set_data_limit(bytes)?;
        }
        Ok(ceiling)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Check the setting anyway, so a mistake shows up before it reaches a server.
        if let Some(text) = setting.as_deref() {
            parse_setting(text).map_err(anyhow::Error::msg)?;
        }
        Ok(Ceiling::Unsupported)
    }
}

/// Lowers the soft `RLIMIT_DATA` to `bytes`, or to the hard limit if that is lower. A soft
/// limit that is already lower stays.
#[cfg(target_os = "linux")]
fn set_data_limit(bytes: u64) -> anyhow::Result<()> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `current` is a valid `rlimit` for getrlimit to fill.
    if unsafe { libc::getrlimit(libc::RLIMIT_DATA, &mut current) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let soft = bytes.min(current.rlim_max);
    if current.rlim_cur != libc::RLIM_INFINITY && current.rlim_cur <= soft {
        return Ok(());
    }
    let limit = libc::rlimit {
        rlim_cur: soft,
        rlim_max: current.rlim_max,
    };
    // SAFETY: `limit` is a valid `rlimit`; setrlimit only reads it.
    if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &limit) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    #[test]
    fn settings_are_bytes_with_a_suffix_or_off() {
        assert_eq!(parse_setting("1073741824"), Ok(Some(GIB)));
        assert_eq!(parse_setting("2G"), Ok(Some(2 * GIB)));
        assert_eq!(parse_setting("512m"), Ok(Some(512 << 20)));
        assert_eq!(parse_setting(" 64K "), Ok(Some(64 << 10)));
        assert_eq!(parse_setting("0"), Ok(None));
        assert_eq!(parse_setting("off"), Ok(None));
        assert_eq!(parse_setting("OFF"), Ok(None));
        for bad in [
            "",
            "G",
            "2GB",
            "1.5G",
            "-1",
            "2 G",
            "lots",
            "99999999999999999999",
        ] {
            let error = parse_setting(bad).unwrap_err();
            assert!(
                error.starts_with("PIKO_MEMORY_LIMIT must be"),
                "{bad}: {error}"
            );
        }
    }

    #[test]
    fn the_default_is_most_of_the_smaller_of_the_cgroup_and_the_host() {
        let meminfo = "MemTotal:        8388608 kB\nMemFree:         1024 kB\n";
        // The host alone: 80% of 8 GiB.
        assert_eq!(
            ceiling(None, &[], Some(meminfo)),
            Ok(Ceiling::Derived {
                bytes: 8 * GIB * 4 / 5,
                of: 8 * GIB
            })
        );
        // A cgroup v2 limit below the host's memory wins; `max` means no limit.
        let limits = vec!["max\n".to_string(), format!("{}\n", 2 * GIB)];
        assert_eq!(
            ceiling(None, &limits, Some(meminfo)),
            Ok(Ceiling::Derived {
                bytes: 2 * GIB * 4 / 5,
                of: 2 * GIB
            })
        );
        // An unlimited cgroup v1 value is larger than the host, so the host wins.
        let unlimited = vec!["9223372036854771712\n".to_string()];
        assert_eq!(
            ceiling(None, &unlimited, Some(meminfo)).unwrap().bytes(),
            Some(8 * GIB * 4 / 5)
        );
        // Only `max`, and no meminfo: nothing to go by.
        assert_eq!(
            ceiling(None, &["max".to_string()], None),
            Ok(Ceiling::Unknown)
        );
        assert_eq!(ceiling(None, &[], Some("garbage")), Ok(Ceiling::Unknown));
    }

    #[test]
    fn the_setting_overrides_or_disables_the_default() {
        let meminfo = Some("MemTotal: 8388608 kB\n");
        let limits = vec![format!("{GIB}")];
        assert_eq!(
            ceiling(Some("3G"), &limits, meminfo),
            Ok(Ceiling::Configured(3 * GIB))
        );
        assert_eq!(ceiling(Some("off"), &limits, meminfo), Ok(Ceiling::Off));
        assert_eq!(ceiling(Some("0"), &limits, meminfo), Ok(Ceiling::Off));
        assert!(ceiling(Some("3 gigs"), &limits, meminfo).is_err());
        assert_eq!(Ceiling::Off.bytes(), None);
    }

    #[test]
    fn cgroup_files_cover_the_process_cgroup_and_its_ancestors() {
        let root = Path::new("/sys/fs/cgroup");
        // cgroup v2 inside a container with its own namespace.
        assert_eq!(
            cgroup_files("0::/\n", root),
            [PathBuf::from("/sys/fs/cgroup/memory.max")]
        );
        // cgroup v2 under systemd.
        assert_eq!(
            cgroup_files("0::/system.slice/piko.service\n", root),
            [
                "/sys/fs/cgroup/system.slice/piko.service/memory.max",
                "/sys/fs/cgroup/system.slice/memory.max",
                "/sys/fs/cgroup/memory.max",
            ]
            .map(PathBuf::from)
        );
        // cgroup v1: only the memory controller's line counts.
        assert_eq!(
            cgroup_files("12:cpu,cpuacct:/docker/abc\n4:memory:/docker/abc\n", root),
            [
                "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes",
                "/sys/fs/cgroup/memory/docker/memory.limit_in_bytes",
                "/sys/fs/cgroup/memory/memory.limit_in_bytes",
            ]
            .map(PathBuf::from)
        );
        assert!(cgroup_files("", root).is_empty());
    }
}
