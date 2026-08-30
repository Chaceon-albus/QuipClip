//! Exact rational time for frame-accurate editing.
//!
//! See `.agents/decisions/002-rational-time-model.md`. NTSC video runs at
//! 30000/1001 frames per second, and 1001/30000 has no exact binary
//! fraction. An `f64` accumulates a small error on every addition to it,
//! and over a one-hour timeline that error passes one whole frame — so the
//! export would start on the wrong frame. Every time value in this module
//! is therefore kept as an exact fraction of two `i64`s, and is only ever
//! turned into a float or a decimal string at the boundary where ffmpeg or
//! the DOM actually needs one.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// An exact fraction `num / den`.
///
/// Invariants, maintained by every constructor and arithmetic method below
/// (not by the type system — the fields are public so that the
/// TypeScript-facing `{ n, d }` JSON shape can also be built as a plain
/// struct literal on the Rust side):
/// - `den` is always `> 0`; the sign lives on `num` alone. This is what
///   makes the derived `PartialEq`/`Hash` correct, and what lets `Ord`
///   below cross-multiply without worrying about a sign flip.
/// - the fraction is always reduced by its gcd, so `25/1` and `50/2` are
///   the same stored value, not merely two values that compare equal.
///
/// A value assembled by hand (`Rational { num, den }`) skips both of these,
/// so prefer `Rational::new` or an arithmetic method, which enforce them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rational {
    #[serde(rename = "n")]
    pub num: i64,
    #[serde(rename = "d")]
    pub den: i64,
}

impl Rational {
    /// Build a reduced rational. `None` if `den == 0`, which has no value.
    pub fn new(num: i64, den: i64) -> Option<Self> {
        Self::reduce(i128::from(num), i128::from(den))
    }

    /// Parse the `"30000/1001"` (or bare `"25"`) form ffprobe prints for
    /// `avg_frame_rate` / `r_frame_rate`.
    ///
    /// ffprobe prints `"0/0"` when it does not know the rate; that falls
    /// out of the same `den == 0` rejection every other caller gets, no
    /// special case needed.
    pub fn from_ffprobe(s: &str) -> Option<Self> {
        let s = s.trim();
        match s.split_once('/') {
            Some((n, d)) => Self::new(n.trim().parse().ok()?, d.trim().parse().ok()?),
            None => Self::new(s.parse().ok()?, 1),
        }
    }

    /// Multiply two rationals.
    ///
    /// Named to match `std::ops::Mul`, but deliberately not an impl of it:
    /// that trait's `Output` is infallible, and overflow here must return
    /// `None` rather than panic or wrap.
    #[allow(clippy::should_implement_trait)]
    pub fn mul(self, other: Rational) -> Option<Rational> {
        let n = i128::from(self.num).checked_mul(i128::from(other.num))?;
        let d = i128::from(self.den).checked_mul(i128::from(other.den))?;
        Self::reduce(n, d)
    }

    /// Divide by another rational. See [`Rational::mul`] for why this is an
    /// inherent method rather than a `std::ops::Div` impl.
    #[allow(clippy::should_implement_trait)]
    pub fn div(self, other: Rational) -> Option<Rational> {
        let n = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let d = i128::from(self.den).checked_mul(i128::from(other.num))?;
        Self::reduce(n, d)
    }

    /// Add two rationals. See [`Rational::mul`] for why this is an inherent
    /// method rather than a `std::ops::Add` impl.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: Rational) -> Option<Rational> {
        let a = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let b = i128::from(other.num).checked_mul(i128::from(self.den))?;
        let n = a.checked_add(b)?;
        let d = i128::from(self.den).checked_mul(i128::from(other.den))?;
        Self::reduce(n, d)
    }

    /// Subtract another rational. See [`Rational::mul`] for why this is an
    /// inherent method rather than a `std::ops::Sub` impl.
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, other: Rational) -> Option<Rational> {
        let a = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let b = i128::from(other.num).checked_mul(i128::from(self.den))?;
        let n = a.checked_sub(b)?;
        let d = i128::from(self.den).checked_mul(i128::from(other.den))?;
        Self::reduce(n, d)
    }

    /// Reciprocal. `None` for zero, whose reciprocal has no value.
    pub fn recip(self) -> Option<Rational> {
        Self::reduce(i128::from(self.den), i128::from(self.num))
    }

    /// Whether this value is exactly zero.
    pub fn is_zero(self) -> bool {
        self.num == 0
    }

    /// Approximate as an `f64`, for UI display only (e.g. a scrubber
    /// position). Never feed the result back into frame arithmetic — losing
    /// that precision is exactly the failure mode this type exists to
    /// prevent.
    pub fn to_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// Treating `self` as a frames-per-second timebase, the exact start
    /// time of `frame`: `frame / fps == frame * den / num`, kept as an
    /// exact fraction so a one-hour timeline cannot accumulate drift.
    pub fn seconds_at_frame(&self, frame: i64) -> Option<Rational> {
        let n = i128::from(frame).checked_mul(i128::from(self.den))?;
        Self::reduce(n, i128::from(self.num))
    }

    /// Treating `self` as a frames-per-second timebase, the frame that
    /// contains the instant `seconds`.
    ///
    /// Uses floor division (`div_euclid`), which stays correct for negative
    /// `seconds`: plain `/` truncates toward zero and would put -0.5s at
    /// frame 0 instead of frame -1.
    pub fn frame_at_seconds(&self, seconds: Rational) -> Option<i64> {
        let n = i128::from(seconds.num).checked_mul(i128::from(self.num))?;
        let d = i128::from(seconds.den).checked_mul(i128::from(self.den))?;
        if d == 0 {
            return None;
        }
        i64::try_from(n.div_euclid(d)).ok()
    }

    /// The seek target from ADR 003: `(frame * 2 + 1) * den / (2 * num)`.
    ///
    /// A seek to the *exact* boundary between frame `n` and frame `n + 1`
    /// can land the decoder on either neighbour, because that PTS is the
    /// shared edge of both frames' time spans. Seeking to the midpoint of
    /// frame `n`'s span instead is unambiguously inside frame `n`, so the
    /// decoder always resolves to it.
    pub fn midpoint_seconds_at_frame(&self, frame: i64) -> Option<Rational> {
        let doubled_plus_one = i128::from(frame).checked_mul(2)?.checked_add(1)?;
        let n = doubled_plus_one.checked_mul(i128::from(self.den))?;
        let d = i128::from(2).checked_mul(i128::from(self.num))?;
        Self::reduce(n, d)
    }

    /// How many frames of this grid are needed to cover a duration of
    /// `seconds`, treating `self` as a frames-per-second timebase.
    ///
    /// Rounds up, not down: out points are exclusive (ADR 002 rule 3), so a
    /// segment `[0, N)` needs `N` frames to cover any instant up to and
    /// including a duration that ends mid-frame — a duration that lands one
    /// nanosecond into a frame still requires that whole frame.
    pub fn frame_count_for_duration(&self, seconds: Rational) -> Option<i64> {
        let n = i128::from(seconds.num).checked_mul(i128::from(self.num))?;
        let d = i128::from(seconds.den).checked_mul(i128::from(self.den))?;
        if d == 0 {
            return None;
        }
        let q = n.div_euclid(d);
        let r = n.rem_euclid(d);
        let count = if r == 0 { q } else { q.checked_add(1)? };
        i64::try_from(count).ok()
    }

    /// Reduce a numerator/denominator pair already computed in `i128` down
    /// into a stored `Rational`, or `None` if the denominator is zero or
    /// the reduced value still overflows `i64`.
    ///
    /// Every public constructor and arithmetic method funnels its result
    /// through here. That is deliberate: "reduced, with the sign on the
    /// numerator" is the one invariant every other method in this file
    /// relies on, so it must be enforced in exactly one place rather than
    /// re-derived (and potentially gotten wrong for some signed or
    /// overflowing input) at every call site.
    fn reduce(num: i128, den: i128) -> Option<Rational> {
        if den == 0 {
            return None;
        }
        let negative = (num < 0) != (den < 0);
        // `unsigned_abs` cannot panic, even for `i128::MIN` — unlike
        // `.abs()`, which would for that one value.
        let num_mag = num.unsigned_abs();
        let den_mag = den.unsigned_abs();
        // `den_mag > 0` here (den == 0 was rejected above), so gcd >= 1
        // always; there is no zero-gcd case left to special-case.
        let g = gcd(num_mag, den_mag);
        let num_mag = i128::try_from(num_mag / g).ok()?;
        let den_mag = i128::try_from(den_mag / g).ok()?;
        let signed_num = if negative {
            num_mag.checked_neg()?
        } else {
            num_mag
        };
        Some(Rational {
            num: i64::try_from(signed_num).ok()?,
            den: i64::try_from(den_mag).ok()?,
        })
    }
}

/// Euclid's algorithm on magnitudes. Unsigned throughout so there is no
/// negation step that could overflow, regardless of which input is larger.
fn gcd(a: u128, b: u128) -> u128 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

impl PartialOrd for Rational {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Rational {
    fn cmp(&self, other: &Self) -> Ordering {
        // Cross-multiply in i128 rather than compare `to_f64`: values like
        // 1001/30000 and its neighbours are precisely what `f64` cannot
        // tell apart, which is the whole reason this type exists. `den` is
        // always positive by construction, so the cross product's sign
        // tracks the comparison directly with no case split needed.
        let lhs = i128::from(self.num) * i128::from(other.den);
        let rhs = i128::from(other.num) * i128::from(self.den);
        lhs.cmp(&rhs)
    }
}

/// Ceiling division for a positive divisor, derived from floor division
/// (`div_euclid`) via `ceil(x) == -floor(-x)`. Used to turn a fractional
/// fps into the integer number of frame slots inside one wall-clock
/// second.
fn ceil_div_i128(num: i128, den: i128) -> i128 {
    -((-num).div_euclid(den))
}

/// Print a `Rational` as a fixed-point decimal with exactly `decimals`
/// digits after the point — the form ffmpeg's command line expects for a
/// `-ss`/`-t` argument.
///
/// Computed entirely in integer (`u128`) math and rounded half away from
/// zero. Never routed through `f64`: that would reintroduce exactly the
/// drift this module exists to avoid, since 1001/30000 has no terminating
/// binary fraction. `decimals` is a display precision (ffmpeg arguments use
/// at most a handful of digits; 9 is the default); it is expected to stay
/// modest, and an unreasonably large value saturates rather than panics.
pub fn format_seconds(value: Rational, decimals: u32) -> String {
    debug_assert!(
        value.den != 0,
        "Rational with den == 0 is not a valid time value"
    );
    let negative = (value.num < 0) != (value.den < 0);
    let num_mag = i128::from(value.num).unsigned_abs();
    let den_mag = i128::from(value.den).unsigned_abs();
    if den_mag == 0 {
        // Defensive fallback for a hand-built, invariant-breaking Rational
        // (see the struct doc comment) — never hit through the public
        // constructors, but this keeps the function panic-free regardless.
        return format!("0.{}", "0".repeat(decimals as usize));
    }

    // Scale the magnitude up by 10^decimals before dividing, so every
    // fractional digit comes out of the same integer division as the whole
    // part, instead of a separate (lossy) floating-point step.
    let scale = 10u128.saturating_pow(decimals);
    let scaled = num_mag.saturating_mul(scale);
    let quotient = scaled / den_mag;
    let remainder = scaled % den_mag;
    // remainder < den_mag, and den_mag is bounded by an i64 magnitude, so
    // doubling it here cannot overflow u128.
    let rounded = if remainder * 2 >= den_mag {
        quotient + 1
    } else {
        quotient
    };

    let decimals = decimals as usize;
    let digits = rounded.to_string();
    let padded = if digits.len() <= decimals {
        format!("{digits:0>width$}", width = decimals + 1)
    } else {
        digits
    };
    let split_at = padded.len() - decimals;
    let (int_part, frac_part) = padded.split_at(split_at);
    // Suppress the sign when the rounded magnitude is zero, so a tiny
    // negative value that rounds to zero prints "0", not "-0".
    let sign = if negative && rounded != 0 { "-" } else { "" };
    if decimals == 0 {
        format!("{sign}{int_part}")
    } else {
        format!("{sign}{int_part}.{frac_part}")
    }
}

/// Format a frame index as `HH:MM:SS:FF`.
///
/// `FF` counts frame slots inside one wall-clock second using `ceil(fps)`,
/// not `fps` itself: at 30000/1001 fps the true rate (29.97) is not an
/// integer, so `FF` cannot count "frames per second" literally — the
/// conventional (and only integral) choice is the number of frame slots
/// that occur within one second, which is 30, so `FF` runs `00..29`.
/// Negative frames print with a leading `-`.
pub fn timecode(frame: i64, fps: Rational) -> String {
    let fps_ceil = ceil_div_i128(i128::from(fps.num), i128::from(fps.den)).max(1);
    let negative = frame < 0;
    // i128 avoids the classic `i64::MIN.abs()` overflow panic for the most
    // negative frame index.
    let abs_frame = i128::from(frame).unsigned_abs();
    let fps_ceil_u = fps_ceil.unsigned_abs();
    let total_seconds = abs_frame / fps_ceil_u;
    let ff = abs_frame % fps_ceil_u;
    let hh = total_seconds / 3600;
    let mm = (total_seconds / 60) % 60;
    let ss = total_seconds % 60;
    let sign = if negative { "-" } else { "" };
    format!("{sign}{hh:02}:{mm:02}:{ss:02}:{ff:02}")
}

/// Parse a `HH:MM:SS:FF` timecode back into a frame index — the inverse of
/// [`timecode`]. Rejects an `FF` field that is not below `ceil(fps)`, the
/// same bound `timecode` produces.
pub fn frame_from_timecode(text: &str, fps: Rational) -> Option<i64> {
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let mut parts = rest.split(':');
    let hh: i64 = parts.next()?.parse().ok()?;
    let mm: i64 = parts.next()?.parse().ok()?;
    let ss: i64 = parts.next()?.parse().ok()?;
    let ff: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // reject a fifth field
    }
    if hh < 0 || !(0..60).contains(&mm) || !(0..60).contains(&ss) || ff < 0 {
        return None;
    }

    let fps_ceil = ceil_div_i128(i128::from(fps.num), i128::from(fps.den)).max(1);
    if i128::from(ff) >= fps_ceil {
        return None;
    }

    let total_seconds = i128::from(hh)
        .checked_mul(3600)?
        .checked_add(i128::from(mm).checked_mul(60)?)?
        .checked_add(i128::from(ss))?;
    let magnitude = total_seconds
        .checked_mul(fps_ceil)?
        .checked_add(i128::from(ff))?;
    let frame = if negative {
        magnitude.checked_neg()?
    } else {
        magnitude
    };
    i64::try_from(frame).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- construction & reduction ----

    #[test]
    fn reduces_equivalent_fractions() {
        assert_eq!(Rational::new(50, 2), Rational::new(25, 1));
    }

    #[test]
    fn normalizes_sign_onto_numerator() {
        let r = Rational::new(1, -2).unwrap();
        assert_eq!(r, Rational::new(-1, 2).unwrap());
        assert!(r.den > 0);
    }

    #[test]
    fn zero_den_is_rejected() {
        assert_eq!(Rational::new(1, 0), None);
    }

    #[test]
    fn from_ffprobe_ntsc() {
        let r = Rational::from_ffprobe("30000/1001").unwrap();
        assert_eq!(r.num, 30000);
        assert_eq!(r.den, 1001);
    }

    #[test]
    fn from_ffprobe_unknown_rate_is_none() {
        assert_eq!(Rational::from_ffprobe("0/0"), None);
    }

    #[test]
    fn from_ffprobe_bare_integer() {
        assert_eq!(Rational::from_ffprobe("25"), Rational::new(25, 1));
    }

    // ---- serde wire shape ----

    #[test]
    fn serializes_as_n_d() {
        let r = Rational::new(30000, 1001).unwrap();
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(json, r#"{"n":30000,"d":1001}"#);
        let back: Rational = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
    }

    // ---- arithmetic ----

    #[test]
    fn basic_arithmetic() {
        let half = Rational::new(1, 2).unwrap();
        let third = Rational::new(1, 3).unwrap();
        assert_eq!(half.add(third), Rational::new(5, 6));
        assert_eq!(half.sub(third), Rational::new(1, 6));
        assert_eq!(half.mul(third), Rational::new(1, 6));
        assert_eq!(half.div(third), Rational::new(3, 2));
        assert_eq!(half.recip(), Rational::new(2, 1));
    }

    #[test]
    fn is_zero_and_zero_recip() {
        let zero = Rational::new(0, 5).unwrap();
        assert!(zero.is_zero());
        assert_eq!(zero.recip(), None);
    }

    #[test]
    fn overflow_returns_none_not_panic() {
        let huge = Rational::new(i64::MAX, 1).unwrap();
        assert_eq!(huge.mul(huge), None);
        assert_eq!(huge.add(Rational::new(1, 1).unwrap()), None);
        // Negating i64::MIN as a denominator would overflow i64 even though
        // the numerator alone is fine — this must fail, not wrap.
        assert_eq!(Rational::new(1, i64::MIN), None);
        // i64::MIN as a numerator is representable and must succeed.
        assert!(Rational::new(i64::MIN, 1).is_some());
    }

    #[test]
    fn ordering_uses_cross_multiplication() {
        let a = Rational::new(1, 3).unwrap();
        let b = Rational::new(1001, 3000).unwrap(); // slightly more than 1/3
        assert!(a < b);
        assert!(b > a);
        assert_eq!(
            Rational::new(2, 4)
                .unwrap()
                .cmp(&Rational::new(1, 2).unwrap()),
            Ordering::Equal
        );
    }

    // ---- the frame grid, 30000/1001 throughout ----

    fn ntsc() -> Rational {
        Rational::new(30000, 1001).unwrap()
    }

    #[test]
    fn seconds_at_frame_is_exact_at_large_frame_index() {
        // 3,600,000 frames at 30000/1001 fps is exactly 120,120 seconds —
        // a classic NTSC drop-frame identity. An f64 accumulating
        // 1001/30000 additions would show visible error at this scale;
        // exact rational math does not drift at all.
        let seconds = ntsc().seconds_at_frame(3_600_000).unwrap();
        assert_eq!(seconds, Rational::new(120_120, 1).unwrap());
    }

    #[test]
    fn frame_at_seconds_round_trip_ntsc() {
        let fps = ntsc();
        for n in [-1_000_000i64, -1, 0, 1, 25, 3_600_000, 7_919_999] {
            let s = fps.seconds_at_frame(n).unwrap();
            assert_eq!(
                fps.frame_at_seconds(s),
                Some(n),
                "round trip failed for frame {n}"
            );
        }
    }

    #[test]
    fn frame_at_seconds_round_trip_25fps() {
        let fps = Rational::new(25, 1).unwrap();
        for n in -10_000i64..10_000 {
            let s = fps.seconds_at_frame(n).unwrap();
            assert_eq!(
                fps.frame_at_seconds(s),
                Some(n),
                "round trip failed for frame {n}"
            );
        }
    }

    #[test]
    fn frame_at_seconds_floors_negative_values() {
        let fps = Rational::new(25, 1).unwrap();
        // -0.5s should land on frame -13 (floor of -12.5), not -12 — plain
        // truncating division would wrongly give -12.
        let s = Rational::new(-1, 2).unwrap();
        assert_eq!(fps.frame_at_seconds(s), Some(-13));
    }

    #[test]
    fn midpoint_lies_strictly_between_frame_boundaries() {
        for fps in [Rational::new(25, 1).unwrap(), ntsc()] {
            for n in [-100i64, 0, 1, 12345] {
                let start = fps.seconds_at_frame(n).unwrap();
                let next = fps.seconds_at_frame(n + 1).unwrap();
                let mid = fps.midpoint_seconds_at_frame(n).unwrap();
                assert!(start < mid, "midpoint not after frame start (n={n})");
                assert!(mid < next, "midpoint not before next frame start (n={n})");
            }
        }
    }

    #[test]
    fn frame_count_for_duration_rounds_up() {
        let fps = Rational::new(25, 1).unwrap();
        // Exactly 4 seconds at 25fps is exactly 100 frames.
        assert_eq!(
            fps.frame_count_for_duration(Rational::new(4, 1).unwrap()),
            Some(100)
        );
        // 4 seconds plus one nanosecond-ish sliver still needs a 101st frame.
        let just_over = Rational::new(4, 1)
            .unwrap()
            .add(Rational::new(1, 1_000_000).unwrap())
            .unwrap();
        assert_eq!(fps.frame_count_for_duration(just_over), Some(101));
    }

    // ---- decimal formatting ----

    #[test]
    fn format_seconds_exact_value() {
        let v = Rational::new(3, 2).unwrap();
        assert_eq!(format_seconds(v, 3), "1.500");
    }

    #[test]
    fn format_seconds_rounds_half_away_from_zero() {
        // 1/8 = 0.125 exactly; to 2 decimals the half-way digit rounds up.
        let v = Rational::new(1, 8).unwrap();
        assert_eq!(format_seconds(v, 2), "0.13");
        let neg = Rational::new(-1, 8).unwrap();
        assert_eq!(format_seconds(neg, 2), "-0.13");
    }

    #[test]
    fn format_seconds_ntsc_default_precision() {
        // One NTSC frame's duration, 1001/30000 s, to the module's default
        // 9 decimal places.
        let one_frame = ntsc().recip().unwrap();
        assert_eq!(format_seconds(one_frame, 9), "0.033366667");
    }

    #[test]
    fn format_seconds_zero_decimals() {
        assert_eq!(format_seconds(Rational::new(7, 1).unwrap(), 0), "7");
    }

    // ---- timecode ----

    #[test]
    fn timecode_round_trip_25fps() {
        let fps = Rational::new(25, 1).unwrap();
        for n in [
            0i64,
            1,
            24,
            25,
            26,
            3661 * 25 + 13,
            -1,
            -25,
            -3661 * 25 - 13,
        ] {
            let tc = timecode(n, fps);
            assert_eq!(
                frame_from_timecode(&tc, fps),
                Some(n),
                "round trip failed for {tc}"
            );
        }
    }

    #[test]
    fn timecode_round_trip_ntsc() {
        let fps = ntsc();
        for n in [0i64, 1, 29, 30, 31, 3600 * 30 + 15, -1, -30, -12345] {
            let tc = timecode(n, fps);
            assert_eq!(
                frame_from_timecode(&tc, fps),
                Some(n),
                "round trip failed for {tc}"
            );
        }
    }

    #[test]
    fn timecode_ntsc_ff_runs_0_to_29() {
        let fps = ntsc();
        assert_eq!(timecode(29, fps), "00:00:00:29");
        assert_eq!(timecode(30, fps), "00:00:01:00");
    }

    #[test]
    fn timecode_negative_frame_has_leading_minus() {
        assert_eq!(timecode(-5, Rational::new(25, 1).unwrap()), "-00:00:00:05");
    }

    #[test]
    fn frame_from_timecode_rejects_ff_at_or_above_ceil_fps() {
        let fps = ntsc();
        // ceil(30000/1001) == 30, so FF must be < 30.
        assert_eq!(frame_from_timecode("00:00:00:30", fps), None);
        assert!(frame_from_timecode("00:00:00:29", fps).is_some());
    }

    #[test]
    fn frame_from_timecode_rejects_malformed_input() {
        let fps = Rational::new(25, 1).unwrap();
        assert_eq!(frame_from_timecode("not a timecode", fps), None);
        assert_eq!(frame_from_timecode("00:00:00", fps), None);
        assert_eq!(frame_from_timecode("00:00:00:00:00", fps), None);
        assert_eq!(frame_from_timecode("00:60:00:00", fps), None);
    }
}
