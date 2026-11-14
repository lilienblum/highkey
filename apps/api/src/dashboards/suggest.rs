//! "Did you mean" suggestions, shared by formulas, catalog warnings and not-found hints.

/// The edit distance between two strings, in characters.
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

/// The candidate closest to `name`, when it is at most two edits away.
pub fn nearest<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    candidates
        .into_iter()
        .map(|candidate| (distance(name, candidate), candidate))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, candidate)| candidate)
}

/// How many candidates a hint lists when nothing is close.
const LISTED: usize = 20;

/// A hint for a name that matched nothing: the nearest candidate, else the candidates
/// themselves, else a note that there are none. `plural` names them ("dashboards").
pub fn missing_hint(name: &str, candidates: &[String], plural: &str) -> String {
    if let Some(close) = nearest(name, candidates.iter().map(String::as_str)) {
        return format!("did you mean `{close}`?");
    }
    if candidates.is_empty() {
        return format!("This project has no {plural} yet");
    }
    let listed: Vec<&str> = candidates.iter().take(LISTED).map(String::as_str).collect();
    let more = candidates.len().saturating_sub(LISTED);
    let tail = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    format!("Existing {plural}: {}{tail}", listed.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_picks_the_closest_within_two_edits() {
        assert_eq!(nearest("erors", ["errors", "requests"]), Some("errors"));
        assert_eq!(nearest("orbt", ["orbit", "orb"]), Some("orbit"));
        assert_eq!(nearest("nothing", ["errors", "requests"]), None);
        assert_eq!(nearest("a", []), None);
    }

    #[test]
    fn missing_hints_suggest_list_or_say_there_are_none() {
        let slugs = vec!["orbit".to_string(), "pulse".to_string()];
        assert_eq!(
            missing_hint("orbt", &slugs, "projects"),
            "did you mean `orbit`?"
        );
        assert_eq!(
            missing_hint("zzzzzz", &slugs, "projects"),
            "Existing projects: orbit, pulse"
        );
        assert_eq!(
            missing_hint("x", &[], "views"),
            "This project has no views yet"
        );
        let many: Vec<String> = (0..25).map(|n| format!("board-number-{n}")).collect();
        assert!(missing_hint("zzzzzz", &many, "dashboards").ends_with(" and 5 more"));
    }
}
