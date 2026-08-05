//! Reading the ```csv fence a sheet note stores its grid in.
//!
//! The app's sheet engine lives in TypeScript (`src/lib/sheet.ts`); the
//! scheduler runs in Rust and needs the same grid to find date cells, so this
//! is a deliberate, minimal TWIN of that file's `findFence` and `parseCsv` —
//! the two functions that decide what a row even is. Everything else about
//! sheets (formulas, typing, evaluation) stays on the TS side.
//!
//! Twin, not a fork: the parsing rules below are the TS rules, and the tests
//! at the bottom are the TS cases. If one side's grammar changes — the
//! quote-only-at-cell-start rule, the BOM skip, the closing-fence scan — the
//! other must change with it, or a sheet the grid shows one way notifies the
//! other way.

/// The rows a CSV fence holds, header row split off and data rows padded to
/// the header count — `parseSheet`'s `headers` / `rows`, nothing else.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grid {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl Grid {
    /// Index of a header, exact match first, then case-folded — sheet names
    /// bind case-insensitively everywhere else, and a
    /// header typed `Renewal` must answer to a `renewal:` metadata key.
    pub fn column(&self, name: &str) -> Option<usize> {
        if let Some(i) = self.headers.iter().position(|h| h == name) {
            return Some(i);
        }
        let folded = name.to_lowercase();
        self.headers.iter().position(|h| h.to_lowercase() == folded)
    }
}

/// The inner text of the first ` ```<lang> ` fence in `body`.
///
/// Twin of `findFence`. The closing ``` must start a line (or end the body)
/// and sit OUTSIDE quote state: a ``` inside a quoted CSV cell is data. When
/// no quote-balanced close exists (a cell with an unclosed quote), the first
/// closing-shaped ``` is taken anyway, so a malformed sheet still yields the
/// rows above the damage instead of nothing.
///
/// Scanning bytes is safe here: every sentinel is ASCII, and no byte of a
/// multi-byte UTF-8 sequence can equal an ASCII byte.
pub fn find_fence<'a>(body: &'a str, lang: &str) -> Option<&'a str> {
    let open = format!("```{lang}");
    let bytes = body.as_bytes();
    let multiline = lang == "csv";
    let mut from = body.find(&open)?;
    loop {
        let mut inner_start = from + open.len();
        if body[inner_start..].starts_with("\r\n") {
            inner_start += 2;
        } else if bytes.get(inner_start) == Some(&b'\n') {
            inner_start += 1;
        } else {
            // "```csv" mentioned mid-prose — look for a real opener after it
            from = body[from + 1..].find(&open).map(|k| from + 1 + k)?;
            continue;
        }
        let mut fallback: Option<usize> = None;
        let mut in_quotes = false;
        let mut i = inner_start;
        while i < bytes.len() {
            let c = bytes[i];
            if c == b'"' {
                if in_quotes && bytes.get(i + 1) == Some(&b'"') {
                    i += 2;
                } else {
                    in_quotes = !in_quotes;
                    i += 1;
                }
                continue;
            }
            let closing = c == b'`'
                && body[i..].starts_with("```")
                && (bytes[i - 1] == b'\n' || i + 3 == bytes.len());
            if closing {
                if fallback.is_none() {
                    fallback = Some(i);
                }
                if !in_quotes {
                    return Some(&body[inner_start..i]);
                }
                i += 3;
                continue;
            }
            // outside the csv fence a quote can't span lines (formula strings
            // are single-line), so line ends reset quote state there
            if c == b'\n' && !multiline {
                in_quotes = false;
            }
            i += 1;
        }
        if let Some(f) = fallback {
            return Some(&body[inner_start..f]);
        }
        from = body[from + 1..].find(&open).map(|k| from + 1 + k)?;
    }
}

/// Twin of `parseCsv`: RFC 4180 with the two tolerances the TS side has —
/// a leading UTF-8 BOM is skipped (Excel and Google Sheets emit one, and it
/// would otherwise sit before the first cell's opening quote and make that
/// quote read as literal text), and a lone `\r` is dropped so CRLF files
/// parse. A quote only opens a quoted cell at cell start; a bare quote
/// mid-cell (`12" single`) is literal text.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let chars: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut in_quotes = false;
    let mut i = usize::from(chars.first() == Some(&'\u{feff}'));
    while i < chars.len() {
        let c = chars[i];
        if in_quotes {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 2;
                } else {
                    in_quotes = false;
                    i += 1;
                }
            } else {
                cell.push(c);
                i += 1;
            }
        } else if c == '"' && cell.is_empty() {
            in_quotes = true;
            i += 1;
        } else if c == ',' {
            row.push(std::mem::take(&mut cell));
            i += 1;
        } else if c == '\n' {
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
            i += 1;
        } else if c == '\r' {
            i += 1;
        } else {
            cell.push(c);
            i += 1;
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// The sheet grid a note body holds, or None when it has no csv fence or the
/// fence is empty. Header cells are trimmed and data rows padded/truncated to
/// the header count, exactly as `parseSheet` does.
pub fn sheet_grid(body: &str) -> Option<Grid> {
    let inner = find_fence(body, "csv")?;
    let mut raw = parse_csv(inner);
    if raw.is_empty() {
        return None;
    }
    let headers: Vec<String> = raw.remove(0).iter().map(|h| h.trim().to_string()).collect();
    let rows = raw
        .into_iter()
        .map(|mut r| {
            r.truncate(headers.len());
            r.resize(headers.len(), String::new());
            r
        })
        .collect();
    Some(Grid { headers, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(body: &str) -> Grid {
        sheet_grid(body).expect("grid")
    }

    #[test]
    fn reads_headers_and_pads_short_rows() {
        let g = grid("```csv\nname, renewal ,cost\nNetflix,2026-08-12,12\nSpotify\n```\n");
        assert_eq!(g.headers, ["name", "renewal", "cost"]);
        assert_eq!(g.rows[0], ["Netflix", "2026-08-12", "12"]);
        assert_eq!(g.rows[1], ["Spotify", "", ""], "short row padded");
    }

    #[test]
    fn column_lookup_folds_case() {
        let g = grid("```csv\nName,Renewal\nNetflix,2026-08-12\n```");
        assert_eq!(g.column("Renewal"), Some(1));
        assert_eq!(g.column("renewal"), Some(1), "folded");
        assert_eq!(g.column("due"), None);
    }

    #[test]
    fn quoted_cells_keep_commas_newlines_and_escaped_quotes() {
        let rows = parse_csv("a,\"x,y\",\"line\none\",\"say \"\"hi\"\"\"\n");
        assert_eq!(rows, [["a", "x,y", "line\none", "say \"hi\""]]);
    }

    #[test]
    fn bare_quote_mid_cell_is_literal() {
        // the TS rule: a quote only opens at cell start
        let rows = parse_csv("12\" single,next\n");
        assert_eq!(rows, [["12\" single", "next"]]);
    }

    #[test]
    fn bom_and_crlf_are_tolerated() {
        let rows = parse_csv("\u{feff}\"a,b\",c\r\nd,e\r\n");
        assert_eq!(rows, [["a,b", "c"], ["d", "e"]]);
    }

    #[test]
    fn fence_ends_after_a_quoted_backtick_run() {
        // ``` inside a quoted cell is data, not the end of the fence
        let g = grid("```csv\nname,note\nNetflix,\"```\nstill data\"\ntail,x\n```\n");
        assert_eq!(g.rows.len(), 2);
        assert_eq!(g.rows[1][0], "tail");
    }

    #[test]
    fn unclosed_quote_falls_back_to_the_first_closing_fence() {
        let g = grid("```csv\nname,note\nNetflix,\"oops\n```\n");
        assert_eq!(g.headers, ["name", "note"]);
        assert_eq!(g.rows[0][0], "Netflix");
    }

    #[test]
    fn csv_fence_named_in_prose_is_not_an_opener() {
        let g = grid("write ```csv inline, then:\n\n```csv\na,b\n1,2\n```\n");
        assert_eq!(g.headers, ["a", "b"]);
    }

    #[test]
    fn no_fence_or_empty_fence_yields_nothing() {
        assert!(sheet_grid("plain note").is_none());
        assert!(sheet_grid("```csv\n```").is_none());
    }
}
