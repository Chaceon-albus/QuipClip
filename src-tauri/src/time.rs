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
