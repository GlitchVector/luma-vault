//! Keeping the machine usable while the pipeline runs.
//!
//! # Why this is pacing and not a cap
//!
//! A process cannot portably impose a hard CPU ceiling on itself. Windows has
//! job objects with a hard rate cap and Linux has cgroups, but both are
//! OS-specific, need privileges this app does not ask for, and would have to be
//! taught about the Python workers and ffmpeg children separately.
//!
//! So the ceiling is reached from the other side, with the two levers that
//! actually decide how much CPU this app uses:
//!
//! 1. **How many things run at once.** The pool size and the thumbnail thread
//!    count are both derived from the target, and the workers are told to keep
//!    ONNX to a single thread each — which matters more than it sounds, because
//!    eight unconstrained workers were measured holding ~77 threads *each* on a
//!    16-core machine.
//! 2. **How often they run at all.** After each unit of work the phase sleeps
//!    for a multiple of however long that unit took.
//!
//! Concurrency does as much of the job as it can, and pacing covers the
//! remainder — which is what makes a target mean the same thing on a 4-core
//! laptop as on a 16-core desktop. At 25% of sixteen cores, four single-threaded
//! workers hit the mark with no sleeping at all; at 5% the same arithmetic asks
//! for 0.8 of a worker, so one worker runs at an 80% duty cycle instead.
//!
//! # What the percentages mean
//!
//! A share of the **whole machine**, so the figure is comparable to what a task
//! manager shows. It is an average over seconds, not an instantaneous ceiling:
//! a single ONNX inference cannot be interrupted halfway, so the true shape is
//! bursts of work separated by sleeps.

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::Duration;

/// Where the setting is remembered between launches.
pub const SETTING_KEY: &str = "throttle_level";

/// Never sleep longer than this after one unit of work.
///
/// A single video can take tens of seconds to classify. Without a ceiling, one
/// slow item would put the pipeline to sleep for minutes and make the app look
/// wedged rather than throttled.
const MAX_SLEEP: Duration = Duration::from_secs(20);

/// Sleeping for less than this costs more in scheduler churn than it saves.
const MIN_SLEEP: Duration = Duration::from_millis(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThrottleLevel {
    /// Everything the machine has. The default, and right when you are not
    /// using it for anything else.
    Off,
    /// About a quarter of the machine: the desktop stays completely responsive
    /// and a large scan still finishes in hours rather than days.
    Background,
    /// About a twentieth. For when the machine is busy with something that
    /// matters more, at the cost of taking most of a day over a big folder.
    Idle,
}

impl ThrottleLevel {
    /// Share of the whole machine to aim for, or `None` for no limit.
    pub fn target_share(self) -> Option<f64> {
        match self {
            Self::Off => None,
            Self::Background => Some(0.25),
            Self::Idle => Some(0.05),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Background => "background",
            Self::Idle => "idle",
        }
    }

    /// Unknown values read as `Off` rather than failing: a setting written by a
    /// newer build must not leave an older one unable to scan at all.
    pub fn parse(value: &str) -> Self {
        match value {
            "background" => Self::Background,
            "idle" => Self::Idle,
            _ => Self::Off,
        }
    }

    fn code(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Background => 1,
            Self::Idle => 2,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Background,
            2 => Self::Idle,
            _ => Self::Off,
        }
    }
}

#[derive(Debug)]
pub struct Throttle {
    level: AtomicU8,
    /// Bumped on every change, so a phase already running can notice.
    ///
    /// Both of the throttle's levers are fixed when a phase *starts*: the rayon
    /// pool is built once and the classifier pool handed out as an `Arc` the
    /// phase holds for its whole run. Over a 165,000-file library that run is
    /// hours, and without this the setting would appear to do nothing at all
    /// until the phase happened to end.
    generation: AtomicU64,
}

impl Throttle {
    pub fn new(level: ThrottleLevel) -> Self {
        Self {
            level: AtomicU8::new(level.code()),
            generation: AtomicU64::new(0),
        }
    }

    /// Changes whenever the level does. A phase captures this when it starts
    /// and abandons its work loop when it no longer matches, so the next pass
    /// rebuilds both pools at the new size.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn level(&self) -> ThrottleLevel {
        ThrottleLevel::from_code(self.level.load(Ordering::Relaxed))
    }

    /// Returns whether the value actually changed, so the caller knows whether
    /// the classifier pool needs rebuilding at its new size.
    pub fn set(&self, level: ThrottleLevel) -> bool {
        let changed = self.level.swap(level.code(), Ordering::SeqCst) != level.code();
        if changed {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        changed
    }

    /// How many parallel units this phase may use.
    ///
    /// Derived from the target rather than fixed at one, so a 25% throttle on a
    /// big machine actually uses four cores instead of crawling on one. Never
    /// zero: a phase that cannot run at all is a stalled scan, and the point is
    /// to be slow, not stopped.
    pub fn limit(&self, normal: usize) -> usize {
        self.limit_with(normal, num_cpus::get())
    }

    fn limit_with(&self, normal: usize, cores: usize) -> usize {
        let Some(target) = self.level().target_share() else {
            return normal;
        };
        let wanted = (target * cores.max(1) as f64).round() as usize;
        wanted.clamp(1, normal.max(1))
    }

    /// Sleep so that `worked` averages out to the target share of the machine.
    ///
    /// Only covers the part of the target that [`limit`](Self::limit) could not
    /// express. Concurrency is granular — you cannot run 0.8 of a worker — so
    /// whenever the rounded worker count overshoots, this makes up the
    /// difference by idling.
    pub fn pace(&self, worked: Duration) {
        let cores = num_cpus::get();
        let Some(sleep) = self.sleep_for(worked, cores, self.limit_with(usize::MAX, cores)) else {
            return;
        };
        std::thread::sleep(sleep);
    }

    /// Split out so the arithmetic is testable without actually sleeping.
    fn sleep_for(
        &self,
        worked: Duration,
        cores: usize,
        parallel: usize,
    ) -> Option<Duration> {
        let target = self.level().target_share()?;
        // While awake, `parallel` single-threaded units cost `parallel / cores`
        // of the machine. Averaging `target` therefore means being awake this
        // fraction of the time.
        let duty = (target * cores.max(1) as f64) / parallel.max(1) as f64;
        if duty >= 1.0 {
            return None; // concurrency alone is already at or under the target
        }
        let sleep = worked.mul_f64((1.0 - duty) / duty);
        if sleep < MIN_SLEEP {
            return None;
        }
        Some(sleep.min(MAX_SLEEP))
    }

    /// Threads each external process may use, or `None` when unthrottled.
    ///
    /// One, whenever a limit applies: the whole model rests on a unit of work
    /// costing a single thread, and anything with its own internal thread pool
    /// breaks that assumption invisibly. Measured the hard way — OpenCV's pool
    /// alone held 35% of a 16-core machine from one worker aiming at 5%.
    pub fn process_threads(&self) -> Option<usize> {
        match self.level() {
            ThrottleLevel::Off => None,
            _ => Some(1),
        }
    }

    /// Environment for a classifier worker started under this setting.
    ///
    /// ONNX Runtime sizes its intra-op pool from the core count *per session*,
    /// and a worker holds three. Left alone under a throttle it would answer a
    /// one-thread budget with dozens, and the pacing would be metering
    /// something far larger than it thinks.
    pub fn worker_env(&self) -> Vec<(&'static str, &'static str)> {
        if self.level() == ThrottleLevel::Off {
            Vec::new()
        } else {
            vec![
                ("LUMA_ORT_THREADS", "1"),
                ("OMP_NUM_THREADS", "1"),
                ("OPENBLAS_NUM_THREADS", "1"),
                ("MKL_NUM_THREADS", "1"),
            ]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(level: ThrottleLevel) -> Throttle {
        Throttle::new(level)
    }

    #[test]
    fn off_changes_nothing() {
        let throttle = at(ThrottleLevel::Off);
        assert_eq!(throttle.limit_with(8, 16), 8);
        assert!(throttle.worker_env().is_empty());
        assert_eq!(
            throttle.sleep_for(Duration::from_millis(100), 16, 8),
            None,
            "no target means no pacing"
        );
    }

    #[test]
    fn concurrency_carries_the_target_where_it_can() {
        // 25% of 16 cores is four whole workers, so this level costs nothing in
        // idling — the throttle is expressed entirely as "run fewer things".
        let background = at(ThrottleLevel::Background);
        assert_eq!(background.limit_with(8, 16), 4);
        assert_eq!(
            background.sleep_for(Duration::from_millis(100), 16, 4),
            None,
            "four of sixteen cores is already the target"
        );
    }

    #[test]
    fn pacing_covers_what_concurrency_cannot_express() {
        // 5% of 16 cores is 0.8 of a worker. You cannot run 0.8 of a worker, so
        // one runs at an 80% duty cycle: 25ms of sleep per 100ms of work.
        let idle = at(ThrottleLevel::Idle);
        assert_eq!(idle.limit_with(8, 16), 1);
        let sleep = idle
            .sleep_for(Duration::from_millis(100), 16, 1)
            .expect("paced");
        assert_eq!(sleep.as_millis(), 25);
    }

    #[test]
    fn the_same_level_means_the_same_share_on_a_smaller_machine() {
        // The point of deriving both levers from one target: a quarter of a
        // 4-core laptop is one worker flat out, and a quarter of a 16-core
        // desktop is four. Neither needs to idle.
        let background = at(ThrottleLevel::Background);
        assert_eq!(background.limit_with(8, 4), 1);
        assert_eq!(background.sleep_for(Duration::from_millis(100), 4, 1), None);

        // But 5% of a 4-core machine is 0.2 of a worker, so idle must sleep
        // four times as long as it works.
        let idle = at(ThrottleLevel::Idle);
        assert_eq!(idle.limit_with(8, 4), 1);
        let sleep = idle.sleep_for(Duration::from_millis(100), 4, 1).expect("paced");
        assert_eq!(sleep.as_millis(), 400);
    }

    #[test]
    fn a_throttle_never_stops_the_pipeline_outright() {
        // Rounding 5% of two cores gives zero workers, which would be a stall
        // rather than a throttle.
        assert_eq!(at(ThrottleLevel::Idle).limit_with(8, 2), 1);
        assert_eq!(at(ThrottleLevel::Idle).limit_with(8, 1), 1);
        assert_eq!(at(ThrottleLevel::Background).limit_with(8, 1), 1);
    }

    #[test]
    fn one_slow_video_does_not_put_the_pipeline_to_sleep_for_minutes() {
        // A 60-frame video can take a minute. Uncapped, the 4-core idle duty
        // cycle would follow it with four minutes of silence, which reads as a
        // hang rather than a throttle.
        let sleep = at(ThrottleLevel::Idle)
            .sleep_for(Duration::from_secs(60), 4, 1)
            .expect("paced");
        assert_eq!(sleep, MAX_SLEEP);
    }

    #[test]
    fn a_trivial_unit_of_work_is_not_worth_a_context_switch() {
        assert_eq!(
            at(ThrottleLevel::Idle).sleep_for(Duration::from_micros(200), 16, 1),
            None
        );
    }

    #[test]
    fn levels_round_trip_and_unknown_values_are_safe() {
        for level in [
            ThrottleLevel::Off,
            ThrottleLevel::Background,
            ThrottleLevel::Idle,
        ] {
            assert_eq!(ThrottleLevel::parse(level.as_str()), level);
        }
        // A setting written by a newer build must not leave this one unable to
        // scan; the safe reading of "unknown" is "no limit".
        assert_eq!(ThrottleLevel::parse("turbo"), ThrottleLevel::Off);
        assert_eq!(ThrottleLevel::parse(""), ThrottleLevel::Off);
    }

    #[test]
    fn set_reports_whether_the_pool_must_be_rebuilt() {
        let throttle = at(ThrottleLevel::Off);
        assert!(throttle.set(ThrottleLevel::Idle), "off -> idle is a change");
        assert!(!throttle.set(ThrottleLevel::Idle), "idle -> idle is not");
        assert_eq!(throttle.level(), ThrottleLevel::Idle);
    }

    #[test]
    fn a_running_phase_can_tell_the_level_changed_under_it() {
        // Without this a phase keeps the pools it built when it started, and
        // over a library this size that is hours of the setting doing nothing.
        let throttle = at(ThrottleLevel::Off);
        let started = throttle.generation();

        throttle.set(ThrottleLevel::Idle);
        assert_ne!(throttle.generation(), started, "the phase must notice");

        // A no-op write must not churn every running phase into a restart.
        let settled = throttle.generation();
        throttle.set(ThrottleLevel::Idle);
        assert_eq!(throttle.generation(), settled);
    }
}
