use regex::Regex;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::time::Duration;
use url::Url;

/// What a page offers about itself — nothing beyond title and description is
/// ever read, and both are optional.
#[derive(Debug)]
pub struct UrlMeta {
    pub title: Option<String>,
    pub description: Option<String>,
}

const MAX_BODY_BYTES: u64 = 384 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_DESC_CHARS: usize = 300;
const MAX_REDIRECTS: usize = 4;

/// One polite GET for the page's own metadata: short timeouts, honest
/// User-Agent, html only, body capped. Any failure is the caller's cue to
/// keep the bare-URL note as is.
///
/// Redirects are followed by hand rather than by ureq (SUB-427): a URL that
/// arrives in the vault is untrusted input, and every hop — not just the one
/// the user pasted — has to clear [`guard_url`] before a socket opens. An
/// agent with `redirects(4)` would happily walk hop 1 (public) into hop 2
/// (`http://127.0.0.1:11434/…`) with nothing watching.
pub fn fetch_url_meta(url: &str) -> Result<UrlMeta, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .user_agent("Substrate/0.1 (personal notes; fetches link titles only)")
        .build();
    fetch_with_guard(&agent, guard_url, url)
}

/// The redirect loop itself, with the per-hop guard as a parameter. Only
/// [`fetch_url_meta`] calls it in production, always with [`guard_url`]; the
/// seam exists so the loop can be driven against a local scripted server in
/// tests, where a real [`guard_url`] would refuse the 127.0.0.1 listener
/// before the first hop.
fn fetch_with_guard(
    agent: &ureq::Agent,
    guard: impl Fn(&str) -> Result<Url, String>,
    url: &str,
) -> Result<UrlMeta, String> {
    let mut current = guard(url)?;
    let mut hops = 0;
    let resp = loop {
        let resp = agent
            .get(current.as_str())
            .set("Accept", "text/html,application/xhtml+xml")
            .call()
            .map_err(|e| e.to_string())?;
        // redirects(0) hands 3xx back as a plain response instead of an error
        if !(300..400).contains(&resp.status()) {
            break resp;
        }
        hops += 1;
        if hops > MAX_REDIRECTS {
            return Err("too many redirects".into());
        }
        let location = resp.header("location").ok_or("redirect without location")?;
        let next = current.join(location).map_err(|e| format!("bad redirect target: {e}"))?;
        current = guard(next.as_str())?;
    };

    let ct = resp.content_type().to_string();
    if !ct.contains("html") {
        return Err(format!("not an html page ({ct})"));
    }
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_BODY_BYTES).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(extract_meta(&String::from_utf8_lossy(&bytes)))
}

/// One USD→EUR quote as the dashboards want it: the rate and the day the
/// reference bank published it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxQuote {
    pub usd_eur: f64,
    pub as_of: String,
}

/// The whole rate table the app converts through (SUB-834): one base and the
/// majors quoted against it, plus the day the reference bank published them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxRates {
    pub base: String,
    pub rates: std::collections::BTreeMap<String, f64>,
    pub as_of: String,
}

const FX_URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR";

/// EUR base, majors only. EUR is the base because every cross rate the app
/// computes goes through it, so the table needs no second hop — and the ECB
/// reference set frankfurter republishes is EUR-quoted at source.
const FX_RATES_URL: &str = "https://api.frankfurter.dev/v1/latest?base=EUR\
&symbols=USD,GBP,CHF,JPY,CAD,AUD,SEK,NOK,DKK,PLN,CZK";

/// The app's one FX read (SUB-667). It lives in Rust for the same reason link
/// titles do: the shipped CSP allows no remote origin in `connect-src`, so a
/// browser `fetch()` here could never work outside dev — and every outbound
/// request has to pass [`guard_url`] anyway.
///
/// No redirect loop: frankfurter answers directly, and a redirect on a
/// hardcoded API URL is a surprise worth failing on rather than following.
pub fn fetch_usd_eur() -> Result<FxQuote, String> {
    let body = fetch_fx_body(FX_URL, "reads one FX rate")?;
    parse_fx_quote(&body, "EUR")
}

/// The multi-currency read (SUB-834) — same single call, same guard, one row
/// per major instead of one number. Still one request per refresh: the table
/// is what every pair converts through, so nothing here fans out per currency.
pub fn fetch_fx_rates() -> Result<FxRates, String> {
    let body = fetch_fx_body(FX_RATES_URL, "reads FX reference rates")?;
    parse_fx_rates(&body)
}

/// The shared GET both FX reads use — see [`fetch_usd_eur`] for why it lives
/// in Rust and why a redirect is a failure rather than a hop to follow.
fn fetch_fx_body(url: &str, purpose: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .user_agent(&format!("Substrate/0.1 (personal notes; {purpose})"))
        .build();
    let url = guard_url(url)?;
    let resp = agent
        .get(url.as_str())
        .set("Accept", "application/json")
        .call()
        .map_err(|e| e.to_string())?;
    if (300..400).contains(&resp.status()) {
        return Err(format!("unexpected redirect ({})", resp.status()));
    }
    resp.into_string().map_err(|e| e.to_string())
}

/// Pull one symbol's rate out of a frankfurter `/v1/latest` payload. Anything
/// that isn't a finite positive number is an error, never a silent zero —
/// the caller shows the failure instead of a wrong figure.
pub fn parse_fx_quote(body: &str, symbol: &str) -> Result<FxQuote, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("bad json from frankfurter: {e}"))?;
    let rate = v
        .get("rates")
        .and_then(|r| r.get(symbol))
        .and_then(|r| r.as_f64())
        .ok_or_else(|| format!("no {symbol} rate in response"))?;
    if !rate.is_finite() || rate <= 0.0 {
        return Err(format!("implausible {symbol} rate ({rate})"));
    }
    let as_of = v.get("date").and_then(|d| d.as_str()).unwrap_or_default().to_string();
    Ok(FxQuote { usd_eur: rate, as_of })
}

/// Pull the whole `rates` object out of a frankfurter `/v1/latest` payload
/// (SUB-834). Per-symbol junk is DROPPED rather than fatal — one bad row in a
/// table of eleven shouldn't cost the user the other ten — but a payload with
/// no usable row at all is an error, like the single-quote parser.
///
/// The base is taken from the response, not assumed: the frontend converts
/// through whatever base came back, so a base that silently differed from the
/// request would produce wrong figures rather than a missing rate.
pub fn parse_fx_rates(body: &str) -> Result<FxRates, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("bad json from frankfurter: {e}"))?;
    let base =
        v.get("base").and_then(|b| b.as_str()).ok_or("no base in response")?.to_ascii_uppercase();
    let obj = v.get("rates").and_then(|r| r.as_object()).ok_or("no rates in response")?;
    let mut rates = std::collections::BTreeMap::new();
    for (code, val) in obj {
        let Some(rate) = val.as_f64() else { continue };
        if !rate.is_finite() || rate <= 0.0 {
            continue;
        }
        rates.insert(code.to_ascii_uppercase(), rate);
    }
    if rates.is_empty() {
        return Err("no usable rates in response".into());
    }
    let as_of = v.get("date").and_then(|d| d.as_str()).unwrap_or_default().to_string();
    Ok(FxRates { base, rates, as_of })
}

/// Parse + vet one URL before it becomes a connection: http(s) only, a real
/// host, and every address that host resolves to must be publicly routable.
/// Resolution happens here so a DNS name pointing at 127.0.0.1 (or at the
/// cloud metadata address) is refused as firmly as the literal IP.
///
/// This is a *fetch* guard, not a sandbox: DNS can change between this check
/// and ureq's own connect (classic rebind window). It closes the realistic
/// hole — a synced note whose link quietly probes the local network — without
/// pretending to be airtight.
pub fn guard_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("bad url: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme ({other})")),
    }
    let host = url.host_str().ok_or("url has no host")?;
    if is_blocked_host_name(host) {
        return Err(format!("refusing local address ({host})"));
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<IpAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {host}: {e}"))?
        .map(|s| s.ip())
        .collect();
    if addrs.is_empty() {
        return Err(format!("cannot resolve {host}"));
    }
    // ALL addresses must be public — one private answer in a round-robin set
    // is enough to make the fetch a probe
    if let Some(bad) = addrs.iter().find(|ip| !is_public_ip(ip)) {
        return Err(format!("refusing non-public address ({bad})"));
    }
    Ok(url)
}

/// A URL safe to write to the app log: the `user:pass@` userinfo is dropped,
/// everything else is kept so a log line stays diagnosable (SUB-780).
///
/// A string that doesn't parse into a host-bearing URL is replaced wholesale
/// rather than logged raw. `Url::parse` is lenient enough to be dangerous
/// here: `alice:hunter2@example.com` parses "successfully" as scheme `alice`
/// with the rest as an opaque path, so there is no userinfo to clear and the
/// password would survive verbatim.
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else { return "<unparseable url>".into() };
    if url.cannot_be_a_base() || url.host().is_none() {
        return "<unparseable url>".into();
    }
    if url.username().is_empty() && url.password().is_none() {
        return url.into();
    }
    // both setters only fail on a cannot-be-a-base url, which then has no
    // userinfo to leak either way
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.into()
}

/// The capture-boundary twin of `redact_url`: drops a `user:pass@` userinfo so
/// credentials never reach the vault — not the filename, not the `url:` prop,
/// not the outbound title fetch (SUB-789).
///
/// Unlike `redact_url` this is not log semantics: a string that doesn't parse,
/// or that carries no userinfo, is returned VERBATIM. Re-serializing every URL
/// would normalize it (`example.com` → `example.com/`, host lowercased) and
/// silently change the title of every ordinary capture, so only the
/// credentialed path is rewritten.
pub(crate) fn strip_userinfo(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else { return raw.to_string() };
    if url.cannot_be_a_base() || url.host().is_none() {
        return raw.to_string();
    }
    if url.username().is_empty() && url.password().is_none() {
        return raw.to_string();
    }
    // both setters only fail on a cannot-be-a-base url, excluded above
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.into()
}

/// Strip userinfo from any URL embedded in a message. ureq formats its errors
/// as `<url>: <kind>` (`ureq::Error`'s Display), so redacting only the URL a
/// caller holds still leaks the credentials back through `{e}`.
pub fn redact_message(msg: &str) -> String {
    static CREDS: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let creds =
        CREDS.get_or_init(|| Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/?#\s@]*@").unwrap());
    creds.replace_all(msg, "$1").into_owned()
}

/// Names that never need a resolver to be obviously local. `.localhost` is
/// reserved for loopback by RFC 6761; `.local` is mDNS on the LAN.
pub fn is_blocked_host_name(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h == "local" || h.ends_with(".local")
}

/// True only for addresses that make sense to fetch from the open internet.
/// Everything ambiguous is refused — the cost of a false negative is one link
/// title that doesn't auto-fill.
pub fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback()            // 127/8
        || ip.is_private()        // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()     // 169.254/16 — cloud metadata lives here
        || ip.is_unspecified()    // 0.0.0.0
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0              // 0.0.0.0/8
        || (o[0] == 100 && (64..128).contains(&o[1]))  // 100.64/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)     // 192.0.0/24 IETF
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // 198.18/15 benchmarking
        || o[0] >= 240) // 240/4 reserved
}

fn is_public_v6(ip: &Ipv6Addr) -> bool {
    // an IPv4 address wearing an IPv6 hat gets judged as the IPv4 it is
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(&v4);
    }
    if let Some(v4) = ip.to_ipv4() {
        return is_public_v4(&v4);
    }
    let seg = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (seg[0] & 0xfe00) == 0xfc00   // fc00::/7 unique local
        || (seg[0] & 0xffc0) == 0xfe80) // fe80::/10 link local
}

/// Pull og:title / <title> and og:description / meta description out of raw
/// HTML. Regex over meta tags is enough here — attribute order varies, so the
/// key and content are matched independently within each tag.
pub fn extract_meta(html: &str) -> UrlMeta {
    let meta_tag = Regex::new(r"(?is)<meta\s[^>]*>").unwrap();
    let key_attr =
        Regex::new(r#"(?is)\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#)
            .unwrap();
    let content_attr =
        Regex::new(r#"(?is)\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap();

    let mut og_title = None;
    let mut og_desc = None;
    let mut meta_desc = None;
    for tag in meta_tag.find_iter(html) {
        let tag = tag.as_str();
        let key = key_attr
            .captures(tag)
            .and_then(|c| c.get(1).or(c.get(2)).or(c.get(3)))
            .map(|m| m.as_str().to_lowercase());
        let content = content_attr
            .captures(tag)
            .and_then(|c| c.get(1).or(c.get(2)).or(c.get(3)))
            .map(|m| m.as_str().to_string());
        let (Some(key), Some(content)) = (key, content) else { continue };
        match key.as_str() {
            "og:title" if og_title.is_none() => og_title = Some(content),
            "og:description" if og_desc.is_none() => og_desc = Some(content),
            "description" if meta_desc.is_none() => meta_desc = Some(content),
            _ => {}
        }
    }

    let tag_title = Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
        .unwrap()
        .captures(html)
        .map(|c| c[1].to_string());

    UrlMeta {
        title: clean(og_title.or(tag_title), MAX_TITLE_CHARS),
        description: clean(og_desc.or(meta_desc), MAX_DESC_CHARS),
    }
}

/// Entity-decode, collapse whitespace, cap length; empty results become None.
fn clean(s: Option<String>, max_chars: usize) -> Option<String> {
    let s = decode_entities(&s?);
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > max_chars {
        let mut cut: String = s.chars().take(max_chars).collect();
        cut.push('…');
        Some(cut)
    } else {
        Some(s)
    }
}

/// The handful of entities that actually show up in titles; numeric forms
/// first, `&amp;` last so nothing double-decodes.
fn decode_entities(s: &str) -> String {
    let numeric = Regex::new(r"&#(x?)([0-9a-fA-F]+);").unwrap();
    let s = numeric.replace_all(s, |caps: &regex::Captures| {
        let radix = if caps[1].is_empty() { 10 } else { 16 };
        u32::from_str_radix(&caps[2], radix)
            .ok()
            .and_then(char::from_u32)
            .map(String::from)
            .unwrap_or_else(|| caps[0].to_string())
    });
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&ndash;", "–")
        .replace("&mdash;", "—")
        .replace("&hellip;", "…")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_url_drops_userinfo_and_keeps_the_rest() {
        assert_eq!(
            redact_url("https://alice:hunter2@example.com/page?q=1#frag"),
            "https://example.com/page?q=1#frag"
        );
        // username with no password still identifies an account
        assert_eq!(redact_url("https://alice@example.com/p"), "https://example.com/p");
        assert_eq!(redact_url("https://example.com/p"), "https://example.com/p");
    }

    #[test]
    fn redact_url_refuses_to_echo_an_unparseable_string() {
        // SUB-780: not a usable URL, still a password. The second case parses
        // as scheme `alice` + opaque path, so a userinfo-only clear misses it.
        // `htp` IS a valid scheme to url::Url, so this one parses with a real
        // host and gets its userinfo stripped rather than replaced
        assert_eq!(redact_url("htp://alice:hunter2@example.com"), "htp://example.com");
        assert_eq!(redact_url("alice:hunter2@example.com"), "<unparseable url>");
        assert_eq!(redact_url("not a url at all"), "<unparseable url>");
    }

    #[test]
    fn strip_userinfo_clears_credentials_only_on_the_credentialed_path() {
        assert_eq!(
            strip_userinfo("https://alice:hunter2@example.com/page?q=1#frag"),
            "https://example.com/page?q=1#frag"
        );
        assert_eq!(strip_userinfo("https://alice@example.com/x"), "https://example.com/x");
    }

    #[test]
    fn strip_userinfo_returns_credential_free_input_verbatim() {
        // SUB-789: no re-serialization on the ordinary path — `Url::parse`
        // would append a trailing `/` and lowercase the host, silently
        // changing the captured note's title
        assert_eq!(strip_userinfo("https://Example.COM"), "https://Example.COM");
        assert_eq!(strip_userinfo("https://example.com/p"), "https://example.com/p");
        assert_eq!(strip_userinfo("not a url at all"), "not a url at all");
        // parses as scheme `alice` + opaque path: no userinfo to clear, and
        // create_reference's http(s) guard refuses it anyway
        assert_eq!(strip_userinfo("alice:hunter2@example.com"), "alice:hunter2@example.com");
    }

    #[test]
    fn redact_message_strips_userinfo_from_embedded_urls() {
        let msg = "https://alice:hunter2@example.com/p: Dns Failed: resolve";
        let out = redact_message(msg);
        assert!(!out.contains("hunter2"), "{out}");
        assert!(!out.contains("alice"), "{out}");
        assert!(out.starts_with("https://example.com/p: Dns Failed"), "{out}");
    }

    #[test]
    fn redact_message_leaves_credential_free_text_alone() {
        let msg = "https://example.com/p: status code 404 (redirected from https://a.example/x)";
        assert_eq!(redact_message(msg), msg);
    }

    #[test]
    fn og_tags_win_over_title_tag() {
        let html = r#"<html><head>
            <title>Fallback title</title>
            <meta property="og:title" content="The OG Title" />
            <meta property="og:description" content="A short description." />
        </head></html>"#;
        let m = extract_meta(html);
        assert_eq!(m.title.as_deref(), Some("The OG Title"));
        assert_eq!(m.description.as_deref(), Some("A short description."));
    }

    #[test]
    fn falls_back_to_title_tag_and_meta_description() {
        let html = r#"<head><title>
            Plain  Page
        </title><meta name="description" content="From meta desc."></head>"#;
        let m = extract_meta(html);
        assert_eq!(m.title.as_deref(), Some("Plain Page"));
        assert_eq!(m.description.as_deref(), Some("From meta desc."));
    }

    #[test]
    fn content_before_property_attribute_order() {
        let html = r#"<meta content="Reversed order" property="og:title">"#;
        let m = extract_meta(html);
        assert_eq!(m.title.as_deref(), Some("Reversed order"));
    }

    #[test]
    fn single_quoted_and_uppercase_attrs() {
        let html = r#"<META PROPERTY='og:title' CONTENT='Loud Tag'>"#;
        let m = extract_meta(html);
        assert_eq!(m.title.as_deref(), Some("Loud Tag"));
    }

    #[test]
    fn nothing_found_is_none() {
        let m = extract_meta("<html><body>hi</body></html>");
        assert!(m.title.is_none());
        assert!(m.description.is_none());
    }

    #[test]
    fn entities_decode_and_amp_last() {
        assert_eq!(
            decode_entities("Fish &amp; Chips &#8212; a &quot;guide&quot; &#x2019;24"),
            "Fish & Chips — a \"guide\" ’24"
        );
        // &amp;lt; must NOT double-decode into "<"
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
    }

    /* ---- FX quote (SUB-667) ----------------------------------------- */

    /// A real `/v1/latest?base=USD&symbols=EUR` body, captured 2026-07-30.
    const FX_PAYLOAD: &str =
        r#"{"amount":1.0,"base":"USD","date":"2026-07-29","rates":{"EUR":0.85911}}"#;

    #[test]
    fn parses_a_captured_frankfurter_payload() {
        let q = parse_fx_quote(FX_PAYLOAD, "EUR").unwrap();
        assert_eq!(q.usd_eur, 0.85911);
        assert_eq!(q.as_of, "2026-07-29");
    }

    #[test]
    fn fx_missing_date_degrades_but_rate_is_required() {
        let q = parse_fx_quote(r#"{"rates":{"EUR":0.9}}"#, "EUR").unwrap();
        assert_eq!(q.usd_eur, 0.9);
        assert_eq!(q.as_of, "");
        // an integer rate is still a number to serde_json
        assert_eq!(parse_fx_quote(r#"{"rates":{"EUR":1}}"#, "EUR").unwrap().usd_eur, 1.0);
    }

    #[test]
    fn fx_rejects_junk_rather_than_returning_a_wrong_figure() {
        for body in [
            "not json",
            "{}",
            r#"{"rates":{}}"#,
            r#"{"rates":{"GBP":0.78}}"#, // asked for EUR, got something else
            r#"{"rates":{"EUR":"0.86"}}"#, // string, not a number
            r#"{"rates":{"EUR":0}}"#,
            r#"{"rates":{"EUR":-0.86}}"#,
        ] {
            assert!(parse_fx_quote(body, "EUR").is_err(), "{body} should be rejected");
        }
    }

    #[test]
    fn the_fx_endpoint_clears_the_ssrf_guard_shape() {
        // no DNS here — only that the hardcoded URL is https with a public host
        for raw in [FX_URL, FX_RATES_URL] {
            let url = Url::parse(raw).unwrap();
            assert_eq!(url.scheme(), "https");
            assert!(!is_blocked_host_name(url.host_str().unwrap()));
        }
    }

    /* ---- FX rate table (SUB-834) ------------------------------------ */

    /// A real `/v1/latest?base=EUR&symbols=…` body, captured 2026-08-03.
    const FX_TABLE_PAYLOAD: &str = r#"{"amount":1.0,"base":"EUR","date":"2026-08-01","rates":{"AUD":1.7823,"CAD":1.5941,"CHF":0.9312,"CZK":24.615,"DKK":7.4602,"GBP":0.86445,"JPY":171.24,"NOK":11.7615,"PLN":4.2678,"SEK":11.0842,"USD":1.16401}}"#;

    #[test]
    fn parses_a_captured_frankfurter_table() {
        let t = parse_fx_rates(FX_TABLE_PAYLOAD).unwrap();
        assert_eq!(t.base, "EUR");
        assert_eq!(t.as_of, "2026-08-01");
        assert_eq!(t.rates.len(), 11);
        assert_eq!(t.rates["USD"], 1.16401);
        assert_eq!(t.rates["JPY"], 171.24);
        // every symbol the app asks for came back
        for code in ["USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK"] {
            assert!(t.rates.contains_key(code), "missing {code}");
        }
    }

    #[test]
    fn the_requested_symbols_match_the_table_the_parser_expects() {
        // the URL and the fixture drifting apart would leave the app quietly
        // short a currency, with every test still green
        let query = Url::parse(FX_RATES_URL).unwrap();
        let symbols = query
            .query_pairs()
            .find(|(k, _)| k == "symbols")
            .map(|(_, v)| v.to_string())
            .expect("symbols param");
        let asked: std::collections::BTreeSet<&str> = symbols.split(',').collect();
        let table = parse_fx_rates(FX_TABLE_PAYLOAD).unwrap();
        let got: std::collections::BTreeSet<&str> =
            table.rates.keys().map(|k| k.as_str()).collect();
        assert_eq!(asked, got);
    }

    #[test]
    fn fx_table_drops_bad_rows_but_keeps_the_good_ones() {
        // one unusable row costs that currency, not the whole refresh
        let body = r#"{"base":"EUR","date":"2026-08-01","rates":{"USD":1.164,"GBP":"0.86","CHF":0,"JPY":-1}}"#;
        let t = parse_fx_rates(body).unwrap();
        assert_eq!(t.rates.len(), 1);
        assert_eq!(t.rates["USD"], 1.164);
    }

    #[test]
    fn fx_table_missing_date_degrades_but_base_and_rates_are_required() {
        let t = parse_fx_rates(r#"{"base":"EUR","rates":{"USD":1.1}}"#).unwrap();
        assert_eq!(t.as_of, "");
        assert_eq!(t.base, "EUR");
        for body in [
            "not json",
            "{}",
            r#"{"rates":{"USD":1.1}}"#,                // no base
            r#"{"base":"EUR"}"#,                       // no rates
            r#"{"base":"EUR","rates":{}}"#,            // empty table
            r#"{"base":"EUR","rates":{"USD":"1.1"}}"#, // nothing usable left
        ] {
            assert!(parse_fx_rates(body).is_err(), "{body} should be rejected");
        }
    }

    /// Network smoke test — excluded from the default gate like the others.
    #[test]
    #[ignore]
    fn fetch_fx_rates_smoke() {
        let t = fetch_fx_rates().expect("fetch failed");
        assert_eq!(t.base, "EUR");
        assert!(t.rates.len() >= 10, "rates: {:?}", t.rates.keys().collect::<Vec<_>>());
        let usd = t.rates["USD"];
        assert!(usd > 0.1 && usd < 10.0, "usd: {usd}");
        assert_eq!(t.as_of.len(), 10, "as_of: {}", t.as_of);
    }

    /// Network smoke test — excluded from the default gate like the two below.
    #[test]
    #[ignore]
    fn fetch_usd_eur_smoke() {
        let q = fetch_usd_eur().expect("fetch failed");
        assert!(q.usd_eur > 0.0 && q.usd_eur < 10.0, "rate: {}", q.usd_eur);
        assert_eq!(q.as_of.len(), 10, "as_of: {}", q.as_of);
    }

    /* ---- SSRF guard (SUB-427) -------------------------------------- */

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn loopback_private_and_link_local_v4_are_not_public() {
        for s in [
            "127.0.0.1",
            "127.9.9.9",
            "0.0.0.0",
            "10.0.0.5",
            "172.16.4.1",
            "172.31.255.255",
            "192.168.1.10",
            "169.254.169.254", // cloud metadata
            "100.64.0.1",      // CGNAT
            "192.0.0.1",
            "198.18.0.1",
            "224.0.0.1", // multicast
            "255.255.255.255",
            "240.0.0.1",
        ] {
            assert!(!is_public_ip(&ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn routable_v4_is_public() {
        for s in ["93.184.216.34", "8.8.8.8", "172.32.0.1", "192.167.0.1", "100.63.255.255"] {
            assert!(is_public_ip(&ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn v6_loopback_ula_link_local_and_mapped_v4() {
        for s in ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"] {
            assert!(!is_public_ip(&ip(s)), "{s} should be blocked");
        }
        // IPv4-mapped/compatible forms must not sneak loopback past the guard
        assert!(!is_public_ip(&ip("::ffff:127.0.0.1")));
        assert!(!is_public_ip(&ip("::ffff:10.1.2.3")));
        assert!(is_public_ip(&ip("2606:4700:4700::1111")));
    }

    #[test]
    fn local_host_names_are_blocked_without_dns() {
        for h in ["localhost", "LOCALHOST", "localhost.", "api.localhost", "printer.local"] {
            assert!(is_blocked_host_name(h), "{h} should be blocked");
        }
        for h in ["example.com", "localhostile.net", "notlocal.com"] {
            assert!(!is_blocked_host_name(h), "{h} should be allowed");
        }
    }

    #[test]
    fn guard_rejects_non_http_schemes() {
        for u in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "data:text/html,<title>x</title>",
            "javascript:alert(1)",
        ] {
            assert!(guard_url(u).is_err(), "{u} should be rejected");
        }
    }

    #[test]
    fn guard_rejects_literal_local_addresses() {
        // literal IPs need no resolver, so these assertions are offline-safe
        for u in [
            "http://127.0.0.1:11434/api",
            "http://[::1]:8080/",
            "http://169.254.169.254/latest/meta-data/",
            "http://192.168.0.1/admin",
            "http://localhost:1420/",
        ] {
            assert!(guard_url(u).is_err(), "{u} should be rejected");
        }
    }

    #[test]
    fn guard_rejects_urls_without_a_host() {
        assert!(guard_url("http:///nohost").is_err());
        assert!(guard_url("not a url").is_err());
    }

    /// Network smoke test — excluded from the default gate; run explicitly
    /// with `cargo test --lib -- --ignored` when the fetch path changes.
    #[test]
    #[ignore]
    fn fetch_real_page_smoke() {
        let m = fetch_url_meta("https://example.com/").expect("fetch failed");
        assert_eq!(m.title.as_deref(), Some("Example Domain"));
    }

    /// Same exclusion: proves the hand-rolled redirect loop still lands on the
    /// destination page now that ureq no longer follows hops itself.
    #[test]
    #[ignore]
    fn fetch_follows_redirects_smoke() {
        let m = fetch_url_meta("http://github.com/").expect("fetch failed");
        assert!(
            m.title.as_deref().is_some_and(|t| t.contains("GitHub")),
            "title after redirect: {:?}",
            m.title
        );
    }

    /* ---- redirect loop, offline (SUB-779) --------------------------- */

    /// Serve one scripted response per REQUEST, in order, then stop — the
    /// client keeps the connection alive across same-origin hops, so
    /// responses cannot be tied to accepts. The join value is the number of
    /// requests served, which is how a test asserts how far the loop walked.
    fn scripted_server(responses: Vec<String>) -> (String, std::thread::JoinHandle<usize>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            let mut served = 0;
            // A miscounted script must fail the test, not wedge the suite:
            // the deadline caps a wait for a request that never comes.
            while served < responses.len() && std::time::Instant::now() < deadline {
                let mut sock = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => return served,
                };
                // BSD accepts inherit the listener's O_NONBLOCK; the
                // conversation itself must block, with a timeout as the
                // backstop instead
                sock.set_nonblocking(false).unwrap();
                sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut r = BufReader::new(sock.try_clone().unwrap());
                // keep answering on this connection until the client moves
                // on (redirects to the same origin reuse the socket)
                while served < responses.len() {
                    // drain the request head so the client isn't writing
                    // into a closed socket while we reply
                    let mut line = String::new();
                    let mut got_request = false;
                    while r.read_line(&mut line).is_ok_and(|n| n > 0) {
                        got_request = true;
                        if line == "\r\n" || line == "\n" {
                            break;
                        }
                        line.clear();
                    }
                    if !got_request {
                        break; // client hung up; wait for the next connection
                    }
                    if sock.write_all(responses[served].as_bytes()).is_err() {
                        break;
                    }
                    let _ = sock.flush();
                    served += 1;
                }
            }
            served
        });
        (origin, handle)
    }

    fn redirect(location: &str) -> String {
        format!(
            "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
        )
    }

    fn page(title: &str) -> String {
        let body = format!("<html><head><title>{title}</title></head></html>");
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    fn test_agent() -> ureq::Agent {
        ureq::AgentBuilder::new().timeout(Duration::from_secs(5)).redirects(0).build()
    }

    /// The production guard with one hole punched for the test listener:
    /// everything else — schemes, blocked names, non-public addresses — is
    /// judged by the real [`guard_url`], so a redirect to the metadata
    /// address fails for the real reason.
    fn guard_allowing(origin: &str) -> impl Fn(&str) -> Result<Url, String> + '_ {
        move |raw: &str| {
            let url = Url::parse(raw).map_err(|e| format!("bad url: {e}"))?;
            if raw.starts_with(origin) {
                return Ok(url);
            }
            guard_url(raw)
        }
    }

    #[test]
    fn redirect_chain_within_the_limit_reaches_the_page() {
        let (origin, srv) =
            scripted_server(vec![redirect("/one"), redirect("/two"), page("Destination")]);
        let m = fetch_with_guard(&test_agent(), guard_allowing(&origin), &origin).unwrap();
        assert_eq!(m.title.as_deref(), Some("Destination"));
        assert_eq!(srv.join().unwrap(), 3, "should have walked both hops");
    }

    #[test]
    fn a_redirect_into_a_guarded_target_is_refused() {
        // the hop the user never sees is the one that matters: hop 1 is a
        // plain public-looking redirect, hop 2 aims at cloud metadata
        let (origin, srv) =
            scripted_server(vec![redirect("http://169.254.169.254/latest/meta-data/")]);
        let err = fetch_with_guard(&test_agent(), guard_allowing(&origin), &origin).unwrap_err();
        assert!(err.contains("non-public address"), "guard message: {err}");
        srv.join().unwrap();
    }

    #[test]
    fn a_redirect_to_loopback_is_refused() {
        // the SUB-427 scenario verbatim: public hop → local service probe
        let (origin, srv) = scripted_server(vec![redirect("http://127.0.0.1:11434/api/tags")]);
        // guard only the entry origin; the loopback hop is a DIFFERENT port,
        // so the real guard judges it
        let entry = origin.clone();
        let guard = move |raw: &str| {
            if raw == entry || raw == format!("{entry}/") {
                Url::parse(raw).map_err(|e| format!("bad url: {e}"))
            } else {
                guard_url(raw)
            }
        };
        let err = fetch_with_guard(&test_agent(), guard, &origin).unwrap_err();
        assert!(err.contains("non-public address"), "guard message: {err}");
        srv.join().unwrap();
    }

    #[test]
    fn more_than_max_redirects_gives_up() {
        // MAX_REDIRECTS hops are allowed, so the loop issues one more
        // request than that and gives up on its 3xx — never asking for a
        // further page, which is why the script has no destination in it
        let hops: Vec<String> =
            (0..=MAX_REDIRECTS).map(|i| redirect(&format!("/hop{i}"))).collect();
        let (origin, srv) = scripted_server(hops);
        let err = fetch_with_guard(&test_agent(), guard_allowing(&origin), &origin).unwrap_err();
        assert_eq!(err, "too many redirects");
        // it gave up ON the over-limit hop, not one request later
        assert_eq!(srv.join().unwrap(), MAX_REDIRECTS + 1);
    }

    #[test]
    fn a_3xx_without_location_is_an_error() {
        let (origin, srv) =
            scripted_server(vec!["HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n".to_string()]);
        let err = fetch_with_guard(&test_agent(), guard_allowing(&origin), &origin).unwrap_err();
        assert_eq!(err, "redirect without location");
        srv.join().unwrap();
    }

    #[test]
    fn a_guarded_entry_url_never_opens_a_socket() {
        // the loop's first act is the guard, before any request
        let err =
            fetch_with_guard(&test_agent(), guard_url, "http://169.254.169.254/").unwrap_err();
        assert!(err.contains("non-public address"), "guard message: {err}");
    }

    #[test]
    fn a_non_html_destination_is_refused_after_the_hops() {
        let (origin, srv) = scripted_server(vec![
            redirect("/data"),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
                .to_string(),
        ]);
        let err = fetch_with_guard(&test_agent(), guard_allowing(&origin), &origin).unwrap_err();
        assert!(err.contains("not an html page"), "message: {err}");
        srv.join().unwrap();
    }

    #[test]
    fn long_titles_truncate_with_ellipsis() {
        let long = "x".repeat(300);
        let m = extract_meta(&format!("<title>{long}</title>"));
        let t = m.title.unwrap();
        assert_eq!(t.chars().count(), 201);
        assert!(t.ends_with('…'));
    }
}
