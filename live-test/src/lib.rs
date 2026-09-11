//! A clean starting point. Nothing here trips a rule.

#[derive(Debug, PartialEq)]
pub enum MathError {
    DivideByZero,
}

pub fn divide(a: i64, b: i64) -> Result<i64, MathError> {
    if b == 0 {
        return Err(MathError::DivideByZero);
    }
    Ok(a / b)
}

pub fn parse_count(s: &str) -> Result<i64, std::num::ParseIntError> {
    s.trim().parse()
}
