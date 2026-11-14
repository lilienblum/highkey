//! Arithmetic formulas over widget query ids, such as `errors / requests * 100`.
use std::collections::BTreeSet;

const MAX_LEN: usize = 200;
const MAX_DEPTH: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Func {
    Min,
    Max,
    Abs,
}
impl Func {
    fn named(name: &str) -> Option<Self> {
        match name {
            "min" => Some(Self::Min),
            "max" => Some(Self::Max),
            "abs" => Some(Self::Abs),
            _ => None,
        }
    }
    fn arity(self) -> usize {
        if self == Self::Abs { 1 } else { 2 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Number(f64),
    Query(String),
    Neg(Box<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormulaError {
    /// 1-based position in characters.
    pub column: usize,
    pub message: String,
}
impl std::fmt::Display for FormulaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "column {}: {}", self.column, self.message)
    }
}
impl std::error::Error for FormulaError {}

fn error<T>(column: usize, message: impl Into<String>) -> Result<T, FormulaError> {
    Err(FormulaError {
        column,
        message: message.into(),
    })
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Number(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Open,
    Close,
    Comma,
    End,
}
impl Token {
    fn describe(&self) -> String {
        match self {
            Self::Number(_) => "a number".into(),
            Self::Ident(name) => format!("`{name}`"),
            Self::Plus => "`+`".into(),
            Self::Minus => "`-`".into(),
            Self::Star => "`*`".into(),
            Self::Slash => "`/`".into(),
            Self::Open => "`(`".into(),
            Self::Close => "`)`".into(),
            Self::Comma => "`,`".into(),
            Self::End => "the end of the formula".into(),
        }
    }
}

fn tokenize(chars: &[char]) -> Result<Vec<(usize, Token)>, FormulaError> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let column = i + 1;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let single = match c {
            '+' => Some(Token::Plus),
            '-' => Some(Token::Minus),
            '*' => Some(Token::Star),
            '/' => Some(Token::Slash),
            '(' => Some(Token::Open),
            ')' => Some(Token::Close),
            ',' => Some(Token::Comma),
            _ => None,
        };
        if let Some(token) = single {
            tokens.push((column, token));
            i += 1;
        } else if c.is_ascii_digit() || c == '.' {
            let start = i;
            let digits = |i: &mut usize| {
                while *i < chars.len() && chars[*i].is_ascii_digit() {
                    *i += 1;
                }
            };
            digits(&mut i);
            if i < chars.len() && chars[i] == '.' {
                i += 1;
                digits(&mut i);
            }
            if i < chars.len() && chars[i] == 'e' {
                let mut j = i + 1;
                if j < chars.len() && matches!(chars[j], '+' | '-') {
                    j += 1;
                }
                if j < chars.len() && chars[j].is_ascii_digit() {
                    i = j;
                    digits(&mut i);
                } else {
                    return error(i + 1, "expected digits in the exponent");
                }
            }
            let text: String = chars[start..i].iter().collect();
            match text.parse::<f64>() {
                Ok(n) if n.is_finite() => tokens.push((column, Token::Number(n))),
                _ => return error(column, format!("`{text}` is not a valid number")),
            }
        } else if c.is_ascii_lowercase() {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_lowercase() || chars[i].is_ascii_digit() || chars[i] == '_')
            {
                i += 1;
            }
            tokens.push((column, Token::Ident(chars[start..i].iter().collect())));
        } else {
            return error(column, format!("unexpected character `{c}`"));
        }
    }
    tokens.push((chars.len() + 1, Token::End));
    Ok(tokens)
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (above + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(ca != *cb));
            diagonal = above;
        }
    }
    row[b.len()]
}

struct Parser<'a> {
    tokens: Vec<(usize, Token)>,
    at: usize,
    depth: usize,
    known: &'a [&'a str],
}
impl Parser<'_> {
    fn peek(&self) -> &(usize, Token) {
        &self.tokens[self.at]
    }
    fn next(&mut self) -> (usize, Token) {
        let token = self.tokens[self.at].clone();
        if token.1 != Token::End {
            self.at += 1;
        }
        token
    }
    fn enter(&mut self, column: usize) -> Result<(), FormulaError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return error(column, format!("nesting is deeper than {MAX_DEPTH} levels"));
        }
        Ok(())
    }
    fn expect(&mut self, wanted: Token) -> Result<(), FormulaError> {
        let (column, token) = self.next();
        if token == wanted {
            Ok(())
        } else {
            error(
                column,
                format!("expected {}, found {}", wanted.describe(), token.describe()),
            )
        }
    }
    fn expr(&mut self) -> Result<Expr, FormulaError> {
        let mut left = self.term()?;
        loop {
            let op = match self.peek().1 {
                Token::Plus => Op::Add,
                Token::Minus => Op::Sub,
                _ => return Ok(left),
            };
            self.next();
            left = Expr::Binary(op, Box::new(left), Box::new(self.term()?));
        }
    }
    fn term(&mut self) -> Result<Expr, FormulaError> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek().1 {
                Token::Star => Op::Mul,
                Token::Slash => Op::Div,
                _ => return Ok(left),
            };
            self.next();
            left = Expr::Binary(op, Box::new(left), Box::new(self.unary()?));
        }
    }
    fn unary(&mut self) -> Result<Expr, FormulaError> {
        if self.peek().1 == Token::Minus {
            self.next();
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        self.atom()
    }
    fn atom(&mut self) -> Result<Expr, FormulaError> {
        let (column, token) = self.next();
        match token {
            Token::Number(n) => Ok(Expr::Number(n)),
            Token::Open => {
                self.enter(column)?;
                let inner = self.expr()?;
                self.expect(Token::Close)?;
                self.depth -= 1;
                Ok(inner)
            }
            Token::Ident(name) if self.peek().1 == Token::Open => {
                let Some(func) = Func::named(&name) else {
                    return error(
                        column,
                        format!("unknown function `{name}`; available functions: min, max, abs"),
                    );
                };
                self.next();
                self.enter(column)?;
                let mut args = vec![self.expr()?];
                while self.peek().1 == Token::Comma {
                    self.next();
                    args.push(self.expr()?);
                }
                self.expect(Token::Close)?;
                self.depth -= 1;
                if args.len() != func.arity() {
                    return error(
                        column,
                        format!(
                            "`{name}` takes {} argument{}, found {}",
                            func.arity(),
                            if func.arity() == 1 { "" } else { "s" },
                            args.len()
                        ),
                    );
                }
                Ok(Expr::Call(func, args))
            }
            Token::Ident(name) => {
                if self.known.contains(&name.as_str()) {
                    return Ok(Expr::Query(name));
                }
                let suggestion = self
                    .known
                    .iter()
                    .map(|k| (distance(&name, k), *k))
                    .filter(|(d, _)| *d <= 2)
                    .min_by_key(|(d, _)| *d);
                error(
                    column,
                    match suggestion {
                        Some((_, k)) => format!("unknown query `{name}`; did you mean `{k}`?"),
                        None => format!("unknown query `{name}`"),
                    },
                )
            }
            other => error(
                column,
                format!(
                    "expected a number, query or `(`, found {}",
                    other.describe()
                ),
            ),
        }
    }
}

/// Parses `source`, accepting only the query ids in `known`.
pub fn parse(source: &str, known: &[&str]) -> Result<Expr, FormulaError> {
    let chars: Vec<char> = source.chars().collect();
    if chars.len() > MAX_LEN {
        return error(
            MAX_LEN + 1,
            format!("formula is longer than {MAX_LEN} characters"),
        );
    }
    let mut parser = Parser {
        tokens: tokenize(&chars)?,
        at: 0,
        depth: 0,
        known,
    };
    let expr = parser.expr()?;
    let (column, token) = parser.next();
    if token != Token::End {
        return error(column, format!("unexpected {}", token.describe()));
    }
    Ok(expr)
}

impl Expr {
    /// Evaluates to `None` for a missing operand, division by zero or a non-finite result.
    pub fn eval(&self, lookup: &dyn Fn(&str) -> Option<f64>) -> Option<f64> {
        let value = match self {
            Self::Number(n) => *n,
            Self::Query(id) => lookup(id)?,
            Self::Neg(inner) => -inner.eval(lookup)?,
            Self::Binary(op, left, right) => {
                let (l, r) = (left.eval(lookup)?, right.eval(lookup)?);
                match op {
                    Op::Add => l + r,
                    Op::Sub => l - r,
                    Op::Mul => l * r,
                    Op::Div if r == 0.0 => return None,
                    Op::Div => l / r,
                }
            }
            Self::Call(func, args) => {
                let values = args
                    .iter()
                    .map(|a| a.eval(lookup))
                    .collect::<Option<Vec<_>>>()?;
                match func {
                    Func::Min => values[0].min(values[1]),
                    Func::Max => values[0].max(values[1]),
                    Func::Abs => values[0].abs(),
                }
            }
        };
        value.is_finite().then_some(value)
    }

    /// The query ids the formula uses.
    pub fn references(&self) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        self.collect(&mut found);
        found
    }
    fn collect(&self, found: &mut BTreeSet<String>) {
        match self {
            Self::Number(_) => {}
            Self::Query(id) => {
                found.insert(id.clone());
            }
            Self::Neg(inner) => inner.collect(found),
            Self::Binary(_, left, right) => {
                left.collect(found);
                right.collect(found);
            }
            Self::Call(_, args) => args.iter().for_each(|a| a.collect(found)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precedence_and_parentheses() {
        let e = parse("errors / requests * 100", &["errors", "requests"]).unwrap();
        assert_eq!(
            e.eval(&|q| Some(if q == "errors" { 5.0 } else { 200.0 })),
            Some(2.5)
        );
        assert_eq!(
            parse("-(a + 2) * 3", &["a"]).unwrap().eval(&|_| Some(1.0)),
            Some(-9.0)
        );
        assert_eq!(
            parse("max(a, b) - min(a, b) + abs(-2)", &["a", "b"])
                .unwrap()
                .eval(&|q| Some(if q == "a" { 1.0 } else { 4.0 })),
            Some(5.0)
        );
    }
    #[test]
    fn nulls_division_by_zero_and_non_finite_are_null() {
        let e = parse("a / b", &["a", "b"]).unwrap();
        assert_eq!(
            e.eval(&|q| if q == "a" { Some(1.0) } else { Some(0.0) }),
            None
        );
        assert_eq!(e.eval(&|q| if q == "a" { None } else { Some(2.0) }), None);
        assert_eq!(
            parse("a * 1e308 * 10", &["a"])
                .unwrap()
                .eval(&|_| Some(1.0)),
            None
        );
    }
    #[test]
    fn unknown_query_reports_column_and_suggestion() {
        let err = parse("erors / requests", &["errors", "requests"]).unwrap_err();
        assert_eq!(err.column, 1);
        assert!(
            err.message.contains("did you mean `errors`"),
            "{}",
            err.message
        );
    }
    #[test]
    fn limits_and_syntax_errors() {
        assert!(parse(&"a+".repeat(101), &["a"]).is_err());
        assert!(parse(&format!("{}a{}", "(".repeat(17), ")".repeat(17)), &["a"]).is_err());
        assert!(parse(&format!("{}a{}", "(".repeat(16), ")".repeat(16)), &["a"]).is_ok());
        assert_eq!(parse("a +", &["a"]).unwrap_err().column, 4);
        assert!(
            parse("pow(a, 2)", &["a"])
                .unwrap_err()
                .message
                .contains("min, max, abs")
        );
        assert!(parse("min(a)", &["a"]).is_err());
    }
    #[test]
    fn references_lists_query_ids() {
        let e = parse("a / (b + a)", &["a", "b", "c"]).unwrap();
        assert_eq!(
            e.references().into_iter().collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }
}
