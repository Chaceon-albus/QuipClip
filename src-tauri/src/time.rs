//! Exact timestamp and rational-time primitives.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::cmp::Ordering;

/// The fixed decimal precision used for future FFmpeg time arguments.
pub const FFMPEG_DECIMALS: u32 = 9;
const MAX_FORMAT_DECIMALS: u32 = 19;

/// A video presentation timestamp in its source stream time base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pts(i64);

impl Pts {
    /// Construct a source presentation timestamp.
    #[must_use]
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// Return the signed timestamp value.
    #[must_use]
    pub const fn value(self) -> i64 {
        self.0
    }
}

/// A non-negative count of source stream ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TickCount(i64);

impl TickCount {
    /// Construct a tick count, or return `None` for a negative value.
    #[must_use]
    pub const fn new(value: i64) -> Option<Self> {
        if value < 0 {
            None
        } else {
            Some(Self(value))
        }
    }

    /// Return the non-negative tick count.
    #[must_use]
    pub const fn value(self) -> i64 {
        self.0
    }
}

/// A non-negative count of reported video frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FrameCount(i64);

impl FrameCount {
    /// Construct a frame count, or return `None` for a negative value.
    #[must_use]
    pub const fn new(value: i64) -> Option<Self> {
        if value < 0 {
            None
        } else {
            Some(Self(value))
        }
    }

    /// Return the non-negative reported frame count.
    #[must_use]
    pub const fn value(self) -> i64 {
        self.0
    }
}

fn parse_canonical_i64(text: &str) -> Option<i64> {
    if text.is_empty() || text.starts_with('+') || text.trim() != text {
        return None;
    }
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty()
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
        || text == "-0"
    {
        return None;
    }
    text.parse().ok()
}

macro_rules! decimal_string_serde {
    ($type:ty, $parse:expr) => {
        impl Serialize for $type {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.value().to_string())
            }
        }

        impl<'de> Deserialize<'de> for $type {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let text = String::deserialize(deserializer)?;
                $parse(&text).ok_or_else(|| de::Error::custom("invalid canonical decimal string"))
            }
        }
    };
}

decimal_string_serde!(Pts, |text: &str| parse_canonical_i64(text).map(Pts));
decimal_string_serde!(TickCount, |text: &str| {
    parse_canonical_i64(text).and_then(TickCount::new)
});
decimal_string_serde!(FrameCount, |text: &str| {
    parse_canonical_i64(text).and_then(FrameCount::new)
});

/// An exact reduced fraction with a positive denominator.
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

    /// Parse the rational form emitted by ffprobe.
    #[must_use]
    pub fn from_ffprobe(text: &str) -> Option<Self> {
        let text = text.trim();
        match text.split_once('/') {
            Some((numerator, denominator)) => Self::new(
                numerator.trim().parse().ok()?,
                denominator.trim().parse().ok()?,
            ),
            None => Self::new(text.parse().ok()?, 1),
        }
    }

    /// Parse a base-10 integer or fixed-point decimal exactly.
    #[must_use]
    pub fn from_decimal_str(text: &str) -> Option<Self> {
        let text = text.trim();
        let (negative, unsigned) = match text.as_bytes().first() {
            Some(b'-') => (true, &text[1..]),
            Some(b'+') => (false, &text[1..]),
            Some(_) => (false, text),
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
        let denominator = 10i128.checked_pow(u32::try_from(fraction.len()).ok()?)?;
        Self::reduce(numerator, denominator)
    }

    /// Multiply two rational values exactly.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn mul(self, other: Rational) -> Option<Rational> {
        Self::reduce(
            i128::from(self.num).checked_mul(i128::from(other.num))?,
            i128::from(self.den).checked_mul(i128::from(other.den))?,
        )
    }

    /// Divide by another rational value exactly.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn div(self, other: Rational) -> Option<Rational> {
        Self::reduce(
            i128::from(self.num).checked_mul(i128::from(other.den))?,
            i128::from(self.den).checked_mul(i128::from(other.num))?,
        )
    }

    /// Add another rational value exactly.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn add(self, other: Rational) -> Option<Rational> {
        let left = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let right = i128::from(other.num).checked_mul(i128::from(self.den))?;
        Self::reduce(
            left.checked_add(right)?,
            i128::from(self.den).checked_mul(i128::from(other.den))?,
        )
    }

    /// Subtract another rational value exactly.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn sub(self, other: Rational) -> Option<Rational> {
        let left = i128::from(self.num).checked_mul(i128::from(other.den))?;
        let right = i128::from(other.num).checked_mul(i128::from(self.den))?;
        Self::reduce(
            left.checked_sub(right)?,
            i128::from(self.den).checked_mul(i128::from(other.den))?,
        )
    }

    /// Return the reciprocal, or `None` for zero.
    #[must_use]
    pub fn recip(self) -> Option<Rational> {
        Self::reduce(i128::from(self.den), i128::from(self.num))
    }

    /// Return whether this value is exactly zero.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.num == 0
    }

    /// Approximate this value for a browser or UI boundary.
    #[must_use]
    pub fn to_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    fn reduce(num: i128, den: i128) -> Option<Rational> {
        if den == 0 {
            return None;
        }
        let negative = (num < 0) != (den < 0);
        let numerator_magnitude = num.unsigned_abs();
        let denominator_magnitude = den.unsigned_abs();
        let divisor = gcd(numerator_magnitude, denominator_magnitude);
        let numerator_magnitude = i128::try_from(numerator_magnitude / divisor).ok()?;
        let denominator_magnitude = i128::try_from(denominator_magnitude / divisor).ok()?;
        let signed_numerator = if negative {
            numerator_magnitude.checked_neg()?
        } else {
            numerator_magnitude
        };
        Some(Rational {
            num: i64::try_from(signed_numerator).ok()?,
            den: i64::try_from(denominator_magnitude).ok()?,
        })
    }
}

fn gcd(a: u128, b: u128) -> u128 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
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
        let left = i128::from(self.num) * i128::from(other.den);
        let right = i128::from(other.num) * i128::from(self.den);
        left.cmp(&right)
    }
}

/// Convert a source presentation timestamp into exact seconds, in the source's own PTS
/// origin, with no start-time subtraction.
///
/// The export renderer (ADR 014) computes an input seek as
/// `inPts * videoTimeBase - formatStartTime - margin`, clamped to zero, and the renderer
/// omits `-ss` entirely when that clamped result is zero; its second graph shape uses one
/// such seek before the first segment rather than one per input. It also converts video
/// PTS into audio ticks as `round(pts * videoTimeBase * sampleRate)`. Both computations
/// start by multiplying a `Pts` by its stream `time_base`. This helper composes that step
/// once so a caller does not rebuild `Rational::new(pts.value(), 1)` by hand and risk
/// getting the overflow handling subtly wrong.
///
/// The result is an absolute value on the source's own PTS timeline; this function never
/// subtracts a source start time. The frontend's `ptsElapsedSeconds` is the near-homonym
/// that performs that subtraction, and ADR 014's measurement 2 warns that a container's
/// start time and its video stream's start time can differ, so the two functions are not
/// interchangeable.
///
/// ADR 002 requires exact rational arithmetic for timestamps and permits a source to
/// start at a negative PTS. This function performs no floating-point arithmetic and
/// accepts the full signed `Pts` range, including `i64::MIN`.
///
/// `time_base` must be strictly positive (`time_base.num() > 0`), matching every other
/// stream time base check in this codebase (`probe.rs` filters on `num() > 0`,
/// `project/mod.rs` calls `validate_positive_rational`, and the frontend calls
/// `assertPositiveTimeBase`). A zero or negative `time_base` cannot represent elapsed
/// time; returning `None` for it prevents a zero or negative time base from silently
/// producing zero (or negative) elapsed seconds, which the export path would read as a
/// silently wrong cut. This function also returns `None` when the exact product cannot be
/// represented as a reduced `Rational`.
#[must_use]
pub fn pts_seconds(pts: Pts, time_base: Rational) -> Option<Rational> {
    if time_base.num() <= 0 {
        return None;
    }
    // `Rational::new(pts.value(), 1)` cannot fail: the denominator is 1, so `reduce`
    // always finds a divisor of 1 and the numerator round-trips through `i64` unchanged.
    // Only the following `mul` can return `None`.
    Rational::new(pts.value(), 1)?.mul(time_base)
}

/// Print a rational number of seconds as a fixed-point decimal.
#[must_use]
pub fn format_seconds(value: Rational, decimals: u32) -> Option<String> {
    if decimals > MAX_FORMAT_DECIMALS {
        return None;
    }
    let negative = value.num < 0;
    let numerator = i128::from(value.num).unsigned_abs();
    let denominator = i128::from(value.den).unsigned_abs();
    let scale = 10u128.checked_pow(decimals)?;
    let scaled = numerator.checked_mul(scale)?;
    let quotient = scaled / denominator;
    let remainder = scaled % denominator;
    let rounded = if remainder * 2 >= denominator {
        quotient.checked_add(1)?
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
    let (integer, fraction) = padded.split_at(padded.len() - decimals);
    let sign = if negative && rounded != 0 { "-" } else { "" };
    if decimals == 0 {
        Some(format!("{sign}{integer}"))
    } else {
        Some(format!("{sign}{integer}.{fraction}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pts_serializes_full_i64_range_as_strings() {
        for value in [i64::MIN, -1, 0, 1, i64::MAX] {
            let pts = Pts::new(value);
            let json = serde_json::to_string(&pts).unwrap();
            assert_eq!(json, format!("\"{value}\""));
            assert_eq!(serde_json::from_str::<Pts>(&json).unwrap(), pts);
        }
    }

    #[test]
    fn pts_rejects_noncanonical_decimal_strings_and_json_numbers() {
        for json in [
            r#"""#,
            r#""+1""#,
            r#"" 1""#,
            r#""01""#,
            r#""-0""#,
            r#""1.0""#,
            r#""9223372036854775808""#,
            "1",
        ] {
            assert!(
                serde_json::from_str::<Pts>(json).is_err(),
                "accepted {json}"
            );
        }
    }

    #[test]
    fn tick_count_rejects_negative_and_noncanonical_values() {
        assert_eq!(TickCount::new(-1), None);
        assert_eq!(
            serde_json::to_string(&TickCount::new(0).unwrap()).unwrap(),
            r#""0""#
        );
        for json in [r#""-1""#, r#""00""#, r#""+1""#, "1"] {
            assert!(serde_json::from_str::<TickCount>(json).is_err());
        }
    }

    #[test]
    fn frame_count_has_the_same_wire_rules_but_a_distinct_type() {
        let count = FrameCount::new(300).unwrap();
        assert_eq!(serde_json::to_string(&count).unwrap(), r#""300""#);
        assert_eq!(
            serde_json::from_str::<FrameCount>(r#""300""#).unwrap(),
            count
        );
        for json in [r#""-1""#, r#""0300""#, "300"] {
            assert!(serde_json::from_str::<FrameCount>(json).is_err());
        }
    }

    #[test]
    fn rational_reduces_and_orders_exactly() {
        assert_eq!(Rational::new(50, 2), Rational::new(25, 1));
        assert!(Rational::new(1001, 30000).unwrap() < Rational::new(1, 29).unwrap());
    }

    #[test]
    fn rational_parsers_and_arithmetic_remain_exact() {
        let ntsc = Rational::from_ffprobe("30000/1001").unwrap();
        assert_eq!(ntsc, Rational::new(30000, 1001).unwrap());
        assert_eq!(
            Rational::from_decimal_str("14.014"),
            Rational::new(7007, 500)
        );
        assert_eq!(
            Rational::new(1, 3)
                .unwrap()
                .add(Rational::new(1, 6).unwrap()),
            Rational::new(1, 2)
        );
        assert_eq!(
            Rational::new(2, 3)
                .unwrap()
                .mul(Rational::new(9, 4).unwrap()),
            Rational::new(3, 2)
        );
    }

    #[test]
    fn rational_serde_rejects_unknown_fields_and_zero_denominator() {
        assert!(serde_json::from_str::<Rational>(r#"{"n":1,"d":0}"#).is_err());
        assert!(serde_json::from_str::<Rational>(r#"{"n":1,"d":2,"x":3}"#).is_err());
    }

    #[test]
    fn pts_seconds_converts_a_positive_timestamp_exactly() {
        let time_base = Rational::new(1, 12800).unwrap();
        assert_eq!(
            pts_seconds(Pts::new(128000), time_base),
            Rational::new(10, 1)
        );
    }

    #[test]
    fn pts_seconds_handles_a_negative_source_start() {
        let time_base = Rational::new(1, 2).unwrap();
        assert_eq!(pts_seconds(Pts::new(-5), time_base), Rational::new(-5, 2));
    }

    #[test]
    fn pts_seconds_is_zero_at_the_origin() {
        let time_base = Rational::new(1, 12800).unwrap();
        assert_eq!(pts_seconds(Pts::new(0), time_base), Rational::new(0, 1));
    }

    #[test]
    fn pts_seconds_stays_exact_for_a_non_terminating_decimal_time_base() {
        // 1001/30000 is NTSC frame timing. Its decimal expansion never terminates, so a
        // correct result only survives as a fraction: any float would round it.
        let time_base = Rational::new(1001, 30000).unwrap();
        assert_eq!(
            pts_seconds(Pts::new(1), time_base),
            Rational::new(1001, 30000)
        );
    }

    #[test]
    fn pts_seconds_returns_none_on_overflow() {
        let time_base = Rational::new(2, 1).unwrap();
        assert_eq!(pts_seconds(Pts::new(i64::MAX), time_base), None);
    }

    #[test]
    fn pts_seconds_result_is_reduced_with_a_positive_denominator() {
        // 6/8 reduces to 3/4 at construction; the product must reduce again to 3/1.
        let time_base = Rational::new(6, 8).unwrap();
        let seconds = pts_seconds(Pts::new(4), time_base).unwrap();
        assert_eq!(seconds, Rational::new(3, 1).unwrap());
        assert_eq!(seconds.num(), 3);
        assert_eq!(seconds.den(), 1);
        assert!(seconds.den() > 0);
    }

    #[test]
    fn pts_seconds_fails_a_float_based_reimplementation_above_two_pow_53() {
        // f64 cannot exactly represent every i64 above 2^53. A reimplementation that
        // routes the multiplication through f64 rounds 9007199254740993 (2^53 + 1) down
        // to 9007199254740992 before it ever reaches the denominator, and reports
        // 17592186044416/25 instead of the exact value below. This test exists to fail
        // any float-based reimplementation of `pts_seconds`.
        let time_base = Rational::new(1, 12800).unwrap();
        assert_eq!(
            pts_seconds(Pts::new(9_007_199_254_740_993), time_base),
            Rational::new(9_007_199_254_740_993, 12800)
        );
    }

    #[test]
    fn pts_seconds_handles_the_most_negative_pts_without_panicking() {
        // ADR 002 permits a source to start at i64::MIN. This is only safe today
        // because `reduce` widens to i128 before it takes a magnitude; negating
        // i64::MIN directly, or taking its i64 `abs()`, would panic in debug.
        assert_eq!(
            pts_seconds(Pts::new(i64::MIN), Rational::new(1, 1).unwrap()),
            Rational::new(i64::MIN, 1)
        );
    }

    #[test]
    fn pts_seconds_succeeds_at_the_largest_product_that_still_fits_in_i64() {
        let time_base = Rational::new(2, 1).unwrap();
        assert_eq!(
            pts_seconds(Pts::new(4_611_686_018_427_387_903), time_base),
            Rational::new(9_223_372_036_854_775_806, 1)
        );
    }

    #[test]
    fn pts_seconds_returns_none_one_tick_past_the_positive_overflow_boundary() {
        let time_base = Rational::new(2, 1).unwrap();
        assert_eq!(
            pts_seconds(Pts::new(4_611_686_018_427_387_904), time_base),
            None
        );
    }

    #[test]
    fn pts_seconds_reaches_i64_min_exactly_at_the_negative_boundary() {
        let time_base = Rational::new(2, 1).unwrap();
        assert_eq!(
            pts_seconds(Pts::new(-4_611_686_018_427_387_904), time_base),
            Rational::new(i64::MIN, 1)
        );
    }

    #[test]
    fn pts_seconds_rejects_a_zero_time_base() {
        // A zero time base cannot represent elapsed time. Returning `Some(0/1)` here
        // would silently turn a real PTS into a zero-second seek in the export path.
        assert_eq!(
            pts_seconds(Pts::new(12345), Rational::new(0, 1).unwrap()),
            None
        );
    }

    #[test]
    fn pts_seconds_rejects_a_negative_time_base() {
        let time_base = Rational::new(-1, 12800).unwrap();
        assert_eq!(pts_seconds(Pts::new(12345), time_base), None);
    }

    #[test]
    fn formats_seconds_without_floating_point() {
        assert_eq!(
            format_seconds(Rational::new(1, 8).unwrap(), 2).as_deref(),
            Some("0.13")
        );
        assert_eq!(
            format_seconds(Rational::new(-1, 1000).unwrap(), 2).as_deref(),
            Some("0.00")
        );
    }
}
