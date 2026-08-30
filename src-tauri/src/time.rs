//! Exact rational time for frame-accurate editing.
//!
//! See `.agents/decisions/002-rational-time-model.md`. NTSC video runs at
//! 30000/1001 frames per second, and 1001/30000 has no exact binary
//! fraction. Floating-point values also do not provide exact equality or
//! ordering for frame-grid positions. Every time value in this module is
//! therefore kept as an exact fraction of two `i64`s, and is only turned
//! into a float or a decimal string at a boundary that needs one.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// The fixed decimal precision used for ffmpeg time arguments.
pub const FFMPEG_DECIMALS: u32 = 9;

const MAX_FORMAT_DECIMALS: u32 = 19;

/// An exact, reduced fraction with a positive denominator.
///
/// Every constructor, arithmetic method, and deserialization maintains
/// these invariants:
/// - `den` is always `> 0`; the sign lives on `num` alone. This is what
///   makes the derived `PartialEq`/`Hash` correct, and what lets `Ord`
///   below cross-multiply without worrying about a sign flip.
/// - the fraction is always reduced by its gcd, so `25/1` and `50/2` are
///   the same stored value, not merely two values that compare equal.
///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "RationalWire", into = "RationalWire")]
pub struct Rational {
    num: i64,
    den: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RationalWire {
    n: i64,
    d: i64,
}

impl TryFrom<RationalWire> for Rational {
    type Error = &'static str;

    fn try_from(value: RationalWire) -> Result<Self, Self::Error> {
        Self::new(value.n, value.d).ok_or("invalid rational")
    }
}

impl From<Rational> for RationalWire {
    fn from(value: Rational) -> Self {
        Self {
            n: value.num,
            d: value.den,
        }
    }
}

impl Rational {
    /// Build a reduced rational with a positive denominator.
    ///
    /// Returns `None` when `den` is zero or when the reduced numerator or
    /// positive denominator cannot be represented by `i64`.
    #[must_use]
    pub fn new(num: i64, den: i64) -> Option<Self> {
        Self::reduce(i128::from(num), i128::from(den))
    }

    /// Return the reduced numerator.
    #[must_use]
    pub const fn num(self) -> i64 {
        self.num
    }

    /// Return the positive denominator.
    #[must_use]
    pub const fn den(self) -> i64 {
        self.den
    }

    /// Parse the `"30000/1001"` (or bare `"25"`) form ffprobe prints for
    /// `avg_frame_rate` / `r_frame_rate`.
    ///
    /// ffprobe prints `"0/0"` when it does not know the rate; that falls
    /// out of the same `den == 0` rejection every other caller gets, no
    /// special case needed.
    #[must_use]
    pub fn from_ffprobe(s: &str) -> Option<Self> {
        let s = s.trim();
        match s.split_once('/') {
            Some((n, d)) => Self::new(n.trim().parse().ok()?, d.trim().parse().ok()?),
            None => Self::new(s.parse().ok()?, 1),
        }
    }

    /// Parse a base-10 integer or fixed-point decimal exactly.
    ///
    /// The accepted form is an optional sign, one or more integer digits,
    /// and an optional decimal point followed by one or more fractional
    /// digits. Surrounding whitespace is ignored. `None` indicates invalid
    /// syntax or an intermediate or stored-value overflow.
    #[must_use]
    pub fn from_decimal_str(s: &str) -> Option<Self> {
        let s = s.trim();
        let (negative, unsigned) = match s.as_bytes().first() {
            Some(b'-') => (true, &s[1..]),
            Some(b'+') => (false, &s[1..]),
            Some(_) => (false, s),
            None => return None,
        };
        let (integer, fraction) = match unsigned.split_once('.') {
            Some((integer, fraction)) if !fraction.contains('.') => (integer, fraction),
            None => (unsigned, ""),
            Some(_) => return None,
        };
        if integer.is_empty()
            || !integer.bytes().all(|byte| byte.is_ascii_digit())
            || (!fraction.is_empty() && !fraction.bytes().all(|byte| byte.is_ascii_digit()))
            || unsigned.ends_with('.')
        {
            return None;
        }

        let mut magnitude = 0i128;
        for byte in integer.bytes().chain(fraction.bytes()) {
            magnitude = magnitude
                .checked_mul(10)?
                .checked_add(i128::from(byte - b'0'))?;
        }
        let numerator = if negative {
            magnitude.checked_neg()?
        } else {
            magnitude
        };
        let fraction_len = u32::try_from(fraction.len()).ok()?;
        let denominator = 10i128.checked_pow(fraction_len)?;
        Self::reduce(numerator, denominator)
    }

    /// Multiply two rationals.
    ///
    /// Named to match `std::ops::Mul`, but deliberately not an impl of it:
    /// that trait's `Output` is infallible, and overflow here must return
    /// `None` rather than panic or wrap.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn mul(self, other: Rational) -> Option<Rational> {
        let n = i128::from(self.num).checked_mul(i128::from(other.num))?;
        let d = i128::from(self.den).checked_mul(i128::from(other.den))?;
        Self::reduce(n, d)
    }

    /// Divide by another rational. See [`Rational::mul`] for why this is an
    /// inherent method rather than a `std::ops::Div` impl.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn div(self, other: Rational) -> Option<Rational> {
        let n = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let d = i128::from(self.den).checked_mul(i128::from(other.num))?;
        Self::reduce(n, d)
    }

    /// Add two rationals. See [`Rational::mul`] for why this is an inherent
    /// method rather than a `std::ops::Add` impl.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
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
    #[must_use]
    pub fn sub(self, other: Rational) -> Option<Rational> {
        let a = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let b = i128::from(other.num).checked_mul(i128::from(self.den))?;
        let n = a.checked_sub(b)?;
        let d = i128::from(self.den).checked_mul(i128::from(other.den))?;
        Self::reduce(n, d)
    }

    /// Reciprocal. `None` for zero, whose reciprocal has no value.
    #[must_use]
    pub fn recip(self) -> Option<Rational> {
        Self::reduce(i128::from(self.den), i128::from(self.num))
    }

    /// Whether this value is exactly zero.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.num == 0
    }

    /// Approximate as an `f64`, for UI display only (e.g. a scrubber
    /// position). Never feed the result back into frame arithmetic — losing
    /// that precision is exactly the failure mode this type exists to
    /// prevent.
    #[must_use]
    pub fn to_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// Treating `self` as a frames-per-second timebase, the exact start
    /// time of `frame`: `frame / fps == frame * den / num`, kept as an
    /// exact fraction so a one-hour timeline cannot accumulate drift.
    ///
    /// Returns `None` when the frame rate is not positive or when the exact
    /// result cannot be represented by `Rational`.
    #[must_use]
    pub fn seconds_at_frame(self, frame: i64) -> Option<Rational> {
        if self.num <= 0 {
            return None;
        }
        let n = i128::from(frame).checked_mul(i128::from(self.den))?;
        Self::reduce(n, i128::from(self.num))
    }

    /// Treating `self` as a frames-per-second timebase, the frame that
    /// contains the instant `seconds`.
    ///
    /// Uses floor division (`div_euclid`), which stays correct for negative
    /// `seconds`: plain `/` truncates toward zero and would put -0.5s at
    /// frame 0 instead of frame -1.
    ///
    /// Returns `None` when the frame rate is not positive or when the frame
    /// index is outside the range of `i64`.
    #[must_use]
    pub fn frame_at_seconds(self, seconds: Rational) -> Option<i64> {
        if self.num <= 0 {
            return None;
        }
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
    ///
    /// Returns `None` when the frame rate is not positive, an intermediate
    /// calculation overflows, or the exact result cannot be represented by
    /// `Rational`.
    #[must_use]
    pub fn midpoint_seconds_at_frame(self, frame: i64) -> Option<Rational> {
        if self.num <= 0 {
            return None;
        }
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
    ///
    /// Returns `None` when the frame rate is not positive, the duration is
    /// negative, or the frame count is outside the range of `i64`.
    #[must_use]
    pub fn frame_count_for_duration(self, seconds: Rational) -> Option<i64> {
        if self.num <= 0 || seconds.num < 0 {
            return None;
        }
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
/// zero. Never routed through `f64`: 1001/30000 has no terminating binary
/// fraction. Returns `None` when `decimals` exceeds the precision that is
/// safe for every stored `Rational`.
#[must_use]
pub fn format_seconds(value: Rational, decimals: u32) -> Option<String> {
    if decimals > MAX_FORMAT_DECIMALS {
        return None;
    }
    let negative = value.num < 0;
    let num_mag = i128::from(value.num).unsigned_abs();
    let den_mag = i128::from(value.den).unsigned_abs();

    // Scale the magnitude up by 10^decimals before dividing, so every
    // fractional digit comes out of the same integer division as the whole
    // part, instead of a separate (lossy) floating-point step.
    let scale = 10u128.checked_pow(decimals)?;
    let scaled = num_mag.checked_mul(scale)?;
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
        Some(format!("{sign}{int_part}"))
    } else {
        Some(format!("{sign}{int_part}.{frac_part}"))
    }
}

/// Format a frame index as `HH:MM:SS:FF`.
///
/// `FF` counts frame slots inside one wall-clock second using `ceil(fps)`,
/// not `fps` itself: at 30000/1001 fps the true rate (29.97) is not an
/// integer, so `FF` cannot count "frames per second" literally — the
/// conventional (and only integral) choice is the number of frame slots
/// that occur within one second, which is 30, so `FF` runs `00..29`.
/// Negative frames print with a leading `-`. Returns `None` when the frame
/// rate is not positive.
#[must_use]
pub fn timecode(frame: i64, fps: Rational) -> Option<String> {
    if fps.num <= 0 {
        return None;
    }
    let fps_ceil = ceil_div_i128(i128::from(fps.num), i128::from(fps.den));
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
    Some(format!("{sign}{hh:02}:{mm:02}:{ss:02}:{ff:02}"))
}

/// Parse a timecode produced by [`timecode`] back into a frame index.
///
/// Hours and frame slots use at least two digits and no redundant leading
/// zeroes. Minutes and seconds use exactly two digits. The frame-slot field
/// must be below `ceil(fps)`. A leading `-` is accepted only for a nonzero
/// frame index. Returns `None` when the frame rate is not positive, the text
/// does not follow that format, or the resulting frame is outside the range
/// of `i64`.
#[must_use]
pub fn frame_from_timecode(text: &str, fps: Rational) -> Option<i64> {
    if fps.num <= 0 {
        return None;
    }
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let mut parts = rest.split(':');
    let hh_text = parts.next()?;
    let mm_text = parts.next()?;
    let ss_text = parts.next()?;
    let ff_text = parts.next()?;
    if parts.next().is_some() {
        return None; // reject a fifth field
    }
    if !is_min_width_two_unsigned(hh_text)
        || !is_exactly_two_digits(mm_text)
        || !is_exactly_two_digits(ss_text)
        || !is_min_width_two_unsigned(ff_text)
    {
        return None;
    }
    let hh: i64 = hh_text.parse().ok()?;
    let mm: i64 = mm_text.parse().ok()?;
    let ss: i64 = ss_text.parse().ok()?;
    let ff: i64 = ff_text.parse().ok()?;
    if !(0..60).contains(&mm) || !(0..60).contains(&ss) {
        return None;
    }

    let fps_ceil = ceil_div_i128(i128::from(fps.num), i128::from(fps.den));
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
    if negative && frame == 0 {
        return None;
    }
    i64::try_from(frame).ok()
}

fn is_exactly_two_digits(text: &str) -> bool {
    text.len() == 2 && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_min_width_two_unsigned(text: &str) -> bool {
    text.len() >= 2
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text.len() == 2 || !text.starts_with('0'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashSet};

    // ---- construction & reduction ----

    #[test]
    fn reduces_equivalent_fractions() {
        assert_eq!(Rational::new(50, 2), Rational::new(25, 1));
    }

    #[test]
    fn normalizes_sign_onto_numerator() {
        let r = Rational::new(1, -2).unwrap();
        assert_eq!(r, Rational::new(-1, 2).unwrap());
        assert_eq!(r.num(), -1);
        assert_eq!(r.den(), 2);
    }

    #[test]
    fn zero_den_is_rejected() {
        assert_eq!(Rational::new(1, 0), None);
    }

    #[test]
    fn from_ffprobe_ntsc() {
        let r = Rational::from_ffprobe("30000/1001").unwrap();
        assert_eq!(r.num(), 30000);
        assert_eq!(r.den(), 1001);
    }

    #[test]
    fn from_ffprobe_unknown_rate_is_none() {
        assert_eq!(Rational::from_ffprobe("0/0"), None);
    }

    #[test]
    fn from_ffprobe_bare_integer() {
        assert_eq!(Rational::from_ffprobe("25"), Rational::new(25, 1));
    }

    #[test]
    fn from_decimal_str_is_exact() {
        assert_eq!(
            Rational::from_decimal_str("14.014000"),
            Rational::new(7007, 500)
        );
        assert_eq!(Rational::from_decimal_str(" -0.125 "), Rational::new(-1, 8));
        assert_eq!(Rational::from_decimal_str("+25"), Rational::new(25, 1));
        assert_eq!(
            Rational::from_decimal_str("1.000000000000000000000"),
            Rational::new(1, 1)
        );
    }

    #[test]
    fn from_decimal_str_handles_i64_and_denominator_boundaries() {
        assert_eq!(
            Rational::from_decimal_str("9223372036854775807"),
            Rational::new(i64::MAX, 1)
        );
        assert_eq!(
            Rational::from_decimal_str("-9223372036854775808"),
            Rational::new(i64::MIN, 1)
        );
        assert_eq!(Rational::from_decimal_str("-9223372036854775809"), None);
        assert_eq!(
            Rational::from_decimal_str("0.000000000000000001"),
            Rational::new(1, 1_000_000_000_000_000_000)
        );
        assert_eq!(Rational::from_decimal_str("0.0000000000000000001"), None);
    }

    #[test]
    fn from_decimal_str_rejects_invalid_or_overflowing_values_without_panicking() {
        for text in [
            "",
            "+",
            ".5",
            "1.",
            "1.2.3",
            "1e3",
            "9223372036854775808",
            "999999999999999999999999999999999999999999999999999999999999",
        ] {
            assert_eq!(Rational::from_decimal_str(text), None, "accepted {text:?}");
        }
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

    #[test]
    fn deserialization_enforces_invariants() {
        let reduced: Rational = serde_json::from_str(r#"{"n":2,"d":4}"#).unwrap();
        assert_eq!(reduced, Rational::new(1, 2).unwrap());
        let normalized: Rational = serde_json::from_str(r#"{"n":1,"d":-2}"#).unwrap();
        assert_eq!(normalized, Rational::new(-1, 2).unwrap());
        assert!(serde_json::from_str::<Rational>(r#"{"n":1,"d":0}"#).is_err());
    }

    #[test]
    fn deserialization_rejects_rust_field_names() {
        assert!(serde_json::from_str::<Rational>(r#"{"num":1,"den":2}"#).is_err());
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
    fn arithmetic_handles_negative_operands() {
        let negative_half = Rational::new(-1, 2).unwrap();
        let third = Rational::new(1, 3).unwrap();
        assert_eq!(negative_half.add(third), Rational::new(-1, 6));
        assert_eq!(negative_half.sub(third), Rational::new(-5, 6));
        assert_eq!(negative_half.mul(third), Rational::new(-1, 6));
        assert_eq!(negative_half.div(third), Rational::new(-3, 2));
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

    #[test]
    fn ordering_equality_and_hashing_agree() {
        let half_from_wire: Rational = serde_json::from_str(r#"{"n":2,"d":4}"#).unwrap();
        let half = Rational::new(1, 2).unwrap();
        assert_eq!(half_from_wire, half);
        assert_eq!(half_from_wire.cmp(&half), Ordering::Equal);
        assert_eq!(BTreeSet::from([half_from_wire, half]).len(), 1);
        assert_eq!(HashSet::from([half_from_wire, half]).len(), 1);

        let values = [
            serde_json::from_str::<Rational>(r#"{"n":1,"d":-1}"#).unwrap(),
            Rational::new(0, 1).unwrap(),
            serde_json::from_str::<Rational>(r#"{"n":-1,"d":-1}"#).unwrap(),
        ];
        assert_eq!(
            values
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>(),
            [
                Rational::new(-1, 1).unwrap(),
                Rational::new(0, 1).unwrap(),
                Rational::new(1, 1).unwrap()
            ]
        );
    }

    // ---- the frame grid, 30000/1001 throughout ----

    fn ntsc() -> Rational {
        Rational::new(30000, 1001).unwrap()
    }

    #[test]
    fn seconds_at_frame_is_exact_at_large_frame_index() {
        // 3,600,000 frames at 30000/1001 fps is exactly 120,120 seconds —
        // a classic NTSC identity. Exact rational math does not drift.
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
    fn fps_methods_reject_nonpositive_rates() {
        let second = Rational::new(1, 1).unwrap();
        for fps in [Rational::new(0, 1).unwrap(), Rational::new(-25, 1).unwrap()] {
            assert_eq!(fps.seconds_at_frame(1), None);
            assert_eq!(fps.frame_at_seconds(second), None);
            assert_eq!(fps.midpoint_seconds_at_frame(1), None);
            assert_eq!(fps.frame_count_for_duration(second), None);
        }
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
    fn midpoint_has_the_exact_ntsc_value() {
        assert_eq!(
            ntsc().midpoint_seconds_at_frame(0),
            Rational::new(1001, 60_000)
        );
        assert_eq!(
            ntsc().midpoint_seconds_at_frame(10),
            Rational::new(7007, 20_000)
        );
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
        assert_eq!(
            fps.frame_count_for_duration(Rational::new(-2, 5).unwrap()),
            None
        );
    }

    #[test]
    fn common_ntsc_rates_round_trip_exactly() {
        for fps in [
            Rational::new(24_000, 1001).unwrap(),
            Rational::new(60_000, 1001).unwrap(),
        ] {
            for frame in [-60_000, -1, 0, 1, 60_000] {
                let seconds = fps.seconds_at_frame(frame).unwrap();
                assert_eq!(fps.frame_at_seconds(seconds), Some(frame));
                let label = timecode(frame, fps).unwrap();
                assert_eq!(frame_from_timecode(&label, fps), Some(frame));
            }
        }
    }

    // ---- decimal formatting ----

    #[test]
    fn format_seconds_exact_value() {
        let v = Rational::new(3, 2).unwrap();
        assert_eq!(format_seconds(v, 3).as_deref(), Some("1.500"));
    }

    #[test]
    fn format_seconds_rounds_half_away_from_zero() {
        // 1/8 = 0.125 exactly; to 2 decimals the half-way digit rounds up.
        let v = Rational::new(1, 8).unwrap();
        assert_eq!(format_seconds(v, 2).as_deref(), Some("0.13"));
        let neg = Rational::new(-1, 8).unwrap();
        assert_eq!(format_seconds(neg, 2).as_deref(), Some("-0.13"));
    }

    #[test]
    fn format_seconds_ntsc_default_precision() {
        // One NTSC frame's duration, 1001/30000 s, to the module's default
        // 9 decimal places.
        let one_frame = ntsc().recip().unwrap();
        assert_eq!(
            format_seconds(one_frame, FFMPEG_DECIMALS).as_deref(),
            Some("0.033366667")
        );
    }

    #[test]
    fn format_seconds_zero_decimals() {
        assert_eq!(
            format_seconds(Rational::new(7, 1).unwrap(), 0).as_deref(),
            Some("7")
        );
        assert_eq!(
            format_seconds(Rational::new(3, 2).unwrap(), 0).as_deref(),
            Some("2")
        );
    }

    #[test]
    fn format_seconds_suppresses_negative_zero() {
        assert_eq!(
            format_seconds(Rational::new(-1, 1000).unwrap(), 2).as_deref(),
            Some("0.00")
        );
    }

    #[test]
    fn format_seconds_rejects_unsupported_precision() {
        assert_eq!(
            format_seconds(Rational::new(1, 1).unwrap(), MAX_FORMAT_DECIMALS + 1),
            None
        );
    }

    #[test]
    fn format_seconds_supports_maximum_precision_at_i64_boundaries() {
        assert_eq!(
            format_seconds(Rational::new(i64::MAX, 1).unwrap(), MAX_FORMAT_DECIMALS).as_deref(),
            Some("9223372036854775807.0000000000000000000")
        );
        assert_eq!(
            format_seconds(Rational::new(i64::MIN, 1).unwrap(), MAX_FORMAT_DECIMALS).as_deref(),
            Some("-9223372036854775808.0000000000000000000")
        );
    }

    #[test]
    fn consecutive_ntsc_frames_have_strictly_increasing_ffmpeg_decimals() {
        let mut previous = -1i128;
        for frame in 0..10_000 {
            let text =
                format_seconds(ntsc().seconds_at_frame(frame).unwrap(), FFMPEG_DECIMALS).unwrap();
            let scaled: i128 = text.replace('.', "").parse().unwrap();
            assert!(scaled > previous, "frame {frame} did not increase");
            previous = scaled;
        }
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
            let tc = timecode(n, fps).unwrap();
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
            let tc = timecode(n, fps).unwrap();
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
        assert_eq!(timecode(29, fps).as_deref(), Some("00:00:00:29"));
        assert_eq!(timecode(30, fps).as_deref(), Some("00:00:01:00"));
    }

    #[test]
    fn timecode_negative_frame_has_leading_minus() {
        assert_eq!(
            timecode(-5, Rational::new(25, 1).unwrap()).as_deref(),
            Some("-00:00:00:05")
        );
    }

    #[test]
    fn timecode_rejects_nonpositive_rates() {
        assert_eq!(timecode(5, Rational::new(0, 1).unwrap()), None);
        assert_eq!(timecode(5, Rational::new(-25, 1).unwrap()), None);
    }

    #[test]
    fn timecode_round_trips_i64_boundaries_and_long_hours() {
        let fps = Rational::new(25, 1).unwrap();
        for frame in [i64::MIN, i64::MAX, 100 * 3600 * 25 + 7] {
            let label = timecode(frame, fps).unwrap();
            assert_eq!(frame_from_timecode(&label, fps), Some(frame));
        }
        assert_eq!(
            timecode(100 * 3600 * 25 + 7, fps).as_deref(),
            Some("100:00:00:07")
        );
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
        assert_eq!(frame_from_timecode("+5:00:00:00", fps), None);
        assert_eq!(frame_from_timecode("00:00:00:+5", fps), None);
        assert_eq!(frame_from_timecode("1:2:3:4", fps), None);
        assert_eq!(frame_from_timecode("000:00:00:00", fps), None);
        assert_eq!(frame_from_timecode("-00:00:00:00", fps), None);
    }

    #[test]
    fn frame_from_timecode_rejects_nonpositive_rates() {
        assert_eq!(
            frame_from_timecode("00:00:00:00", Rational::new(0, 1).unwrap()),
            None
        );
        assert_eq!(
            frame_from_timecode("00:00:00:00", Rational::new(-25, 1).unwrap()),
            None
        );
    }
}
