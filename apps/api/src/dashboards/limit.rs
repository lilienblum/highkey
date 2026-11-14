//! Per-project limit on dashboard writes, so an agent loop cannot hammer the API.
//!
//! A sliding window kept in memory: each project remembers the instants of its writes in the
//! last window. A write is refused once the project has made `max` of them, and the refusal says
//! when the oldest one leaves the window. State is per process and lost on restart, which is
//! fine for a politeness limit (the API owns its data directory exclusively).
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

pub const MAX_WRITES: usize = 30;
pub const WINDOW: Duration = Duration::from_secs(60);
/// Idle projects are dropped once the map holds more than this many.
const SWEEP_AT: usize = 1024;

pub struct WriteLimit {
    max: usize,
    window: Duration,
    seen: Mutex<HashMap<String, VecDeque<Instant>>>,
}
impl Default for WriteLimit {
    fn default() -> Self {
        Self::new(MAX_WRITES, WINDOW)
    }
}
impl WriteLimit {
    pub fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            seen: Mutex::default(),
        }
    }
    /// Records a write for `project`, or returns the whole seconds (at least 1) to wait.
    pub fn take(&self, project: &str) -> Result<(), u64> {
        self.take_at(project, Instant::now())
    }
    fn take_at(&self, project: &str, now: Instant) -> Result<(), u64> {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() > SWEEP_AT {
            seen.retain(|_, at| {
                at.back()
                    .is_some_and(|t| now.duration_since(*t) < self.window)
            });
        }
        let at = seen.entry(project.to_string()).or_default();
        while at
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.window)
        {
            at.pop_front();
        }
        if at.len() >= self.max {
            let wait = self.window - now.duration_since(at[0]);
            return Err(wait.as_secs_f64().ceil().max(1.0) as u64);
        }
        at.push_back(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_slides_and_projects_are_independent() {
        let limit = WriteLimit::new(2, Duration::from_secs(60));
        let start = Instant::now();
        assert!(limit.take_at("a", start).is_ok());
        assert!(limit.take_at("a", start + Duration::from_secs(10)).is_ok());
        assert_eq!(limit.take_at("a", start + Duration::from_secs(20)), Err(40));
        assert!(limit.take_at("b", start + Duration::from_secs(20)).is_ok());
        // The first write has left the window, so one more fits.
        assert!(limit.take_at("a", start + Duration::from_secs(61)).is_ok());
        assert_eq!(limit.take_at("a", start + Duration::from_secs(62)), Err(8));
    }
}
