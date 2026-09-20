//! Sessions, the local password, the recovery password, and TOTP two-factor.
//!
//! The password plus a six-digit authenticator code is the sign-in path once
//! two-factor is bound. The recovery password is a second, independently set
//! credential that skips the code: it exists so a lost authenticator cannot
//! lock the owner out, at the cost of being a path around the second factor.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::App;

pub const COOKIE: &str = "monitor_session";
const SESSION_DAYS: i64 = 14;
/// Failed password attempts allowed per address before it is shut out.
const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(900);

/// How many password checks may run concurrently.
///
/// argon2 is deliberately expensive: one attempt costs 19 MiB and a tenth of a
/// core-second. Unbounded, that cost becomes a lever rather than a defence --
/// the lockout below bounds attempts per address, but nothing bounds the number
/// of addresses, which on IPv6 is a /64 the caller already controls.
///
/// Fixed at one: any limit at or above what the machine can run concurrently is
/// no limit at all. argon2 saturates a core, so a gate of four on a three-core
/// hub never reached four in flight and admitted a flood untouched -- 570 MB
/// against a unit file allowing 256. At one, 633 of 640 attempts are refused.
/// Deriving it from the core count would reopen the hole on smaller machines.
///
/// Refused rather than queued: a queue admits the same flood, merely later. The
/// cost is that two simultaneous sign-ins require one to retry.
const PASSWORD_CHECKS: usize = 1;
static PASSWORD_GATE: Semaphore = Semaphore::const_new(PASSWORD_CHECKS);

pub fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn random_token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

pub fn hash_password(password: &str) -> Result<String> {
    let salt =
        SaltString::encode_b64(&rand::random::<[u8; 16]>()).map_err(|e| anyhow::anyhow!("salt: {e}"))?;
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash password: {e}"))?
        .to_string())
}

fn verify_password(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// Per-address failure counter for the password endpoint.
pub struct Throttle {
    seen: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    /// How long a failure is remembered. A field rather than the constant so
    /// tests can observe a lockout expire without sleeping for 15 minutes.
    window: Duration,
}

impl Default for Throttle {
    fn default() -> Self {
        Self { seen: Mutex::default(), window: LOCKOUT }
    }
}

impl Throttle {
    pub(crate) fn locked(&self, ip: IpAddr) -> bool {
        let mut map = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&ip) {
            Some((n, since)) if since.elapsed() < self.window => *n >= MAX_ATTEMPTS,
            Some(_) => {
                map.remove(&ip);
                false
            }
            None => false,
        }
    }

    pub(crate) fn record_failure(&self, ip: IpAddr) {
        let mut map = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        // Addresses past their window are dropped here rather than allowed to
        // accumulate, which also restarts the count for a returning address.
        map.retain(|_, (_, since)| since.elapsed() < self.window);
        map.entry(ip).or_insert((0, Instant::now())).0 += 1;
    }

    pub(crate) fn clear(&self, ip: IpAddr) {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).remove(&ip);
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

/// True when the request carries a live session cookie.
pub fn authed(app: &App, headers: &HeaderMap) -> bool {
    cookie_value(headers, COOKIE).is_some_and(|token| app.db.session_valid(&sha256(&token)))
}

fn set_cookie(name: &str, value: &str, max_age: i64, secure: bool) -> String {
    let mut cookie = format!("{name}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Digest of the caller's own session, so a session list can mark it.
pub fn current_session(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, COOKIE).map(|token| sha256(&token))
}

/// When a session with this expiry was issued. `issue_session` sets the expiry
/// to the issue time plus `SESSION_DAYS`, so this is exact rather than an
/// estimate; the two move together.
pub fn issued_at(expires_at: i64) -> i64 {
    expires_at - SESSION_DAYS * 86_400
}

/// The request's headers decide the Secure flag when the hub has no `--site`;
/// see `App::secure_cookies`.
pub fn issue_session(app: &App, headers: &HeaderMap) -> Result<String> {
    let token = random_token();
    app.db.create_session(&sha256(&token), Utc::now().timestamp() + SESSION_DAYS * 86_400)?;
    Ok(set_cookie(COOKIE, &token, SESSION_DAYS * 86_400, app.secure_cookies(headers)))
}

#[derive(Deserialize)]
pub struct LoginBody {
    password: String,
    /// Six digits from the authenticator, required once TOTP is bound.
    #[serde(default)]
    code: Option<String>,
}

/// Which credential the caller presented, for the sign-in notification.
enum Credential {
    Password,
    Recovery,
}

/// RFC 6238: the six digits an authenticator shows for `secret` at `step`.
fn totp_at(secret: &[u8], step: i64) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("any key length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    // Dynamic truncation: the low nibble of the last byte picks four bytes,
    // the top bit is cleared, and what remains names a decimal code.
    let at = (digest[digest.len() - 1] & 0x0f) as usize;
    let word = u32::from_be_bytes([digest[at], digest[at + 1], digest[at + 2], digest[at + 3]]) & 0x7fff_ffff;
    format!("{:06}", word % 1_000_000)
}

/// The step a code is checked against, 30 seconds as every authenticator uses.
const TOTP_STEP: i64 = 30;

/// True when `code` is what an authenticator derived from `secret` shows now,
/// one step ago, or one step ahead -- the drift a clock-skewed phone needs.
fn totp_matches(secret: &str, code: &str) -> bool {
    let Ok(secret) = BASE32_NOPAD.decode(secret.to_ascii_uppercase().as_bytes()) else { return false };
    let now = Utc::now().timestamp();
    // Constant-time enough for six digits compared as strings, and exact
    // comparison only: no early return on the first matching step.
    let mut hit = false;
    for drift in [-1, 0, 1] {
        hit |= totp_at(&secret, (now + drift * TOTP_STEP) / TOTP_STEP) == code;
    }
    hit
}

/// Whether a second factor is bound, the flag the sign-in page needs.
pub fn totp_bound(app: &App) -> bool {
    app.db.get("totp_secret").is_some_and(|v| !v.is_empty())
}

pub async fn login(
    State(app): State<crate::Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    let ip = client_ip(trust_cf_ip(&app), &headers, peer.ip());
    if app.throttle.locked(ip) {
        return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, try again later").into_response();
    }
    // Held across the check below, which is its purpose.
    let Ok(_permit) = PASSWORD_GATE.try_acquire() else {
        return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, try again later").into_response();
    };
    let mut credential = Credential::Password;
    let verified = match app.db.get("admin_password_hash") {
        Some(stored) if verify_password(&body.password, &stored) => true,
        // The recovery password is the fallback path around the second factor;
        // it is checked only when the main one did not match, so it cannot be
        // discovered by trying the main one against it.
        _ => {
            let recovery = app.db.get("emergency_password_hash");
            let hit = recovery.as_deref().is_some_and(|stored| verify_password(&body.password, stored));
            if hit {
                credential = Credential::Recovery;
            }
            hit
        }
    };
    if !verified {
        app.throttle.record_failure(ip);
        return (StatusCode::UNAUTHORIZED, "invalid password").into_response();
    }
    let via = match credential {
        Credential::Password => {
            if totp_bound(&app) {
                let code = body.code.as_deref().unwrap_or_default().trim().to_owned();
                let Some(secret) = app.db.get("totp_secret").filter(|s| !s.is_empty()) else {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "second factor unreadable").into_response();
                };
                if !totp_matches(&secret, &code) {
                    // Counted like a wrong password: the code is the other half
                    // of the credential, and an unlimited guessing room against
                    // six digits would spend them all.
                    app.throttle.record_failure(ip);
                    return (StatusCode::UNAUTHORIZED, "invalid authenticator code").into_response();
                }
            }
            "密码"
        }
        Credential::Recovery => "应急密码",
    };
    app.throttle.clear(ip);
    match issue_session(&app, &headers) {
        Ok(cookie) => {
            crate::notify::signed_in(&app, via, ip);
            with_cookies(Json(serde_json::json!({"ok": true})), [cookie])
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn logout(State(app): State<crate::Shared>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_value(&headers, COOKIE) {
        let _ = app.db.drop_session(&sha256(&token));
    }
    with_cookies(
        Json(serde_json::json!({"ok": true})),
        [set_cookie(COOKIE, "", 0, app.secure_cookies(&headers))],
    )
}

/// Begins binding: a fresh secret the operator pastes into an authenticator
/// app by hand. No otpauth:// URL is derived from it: the panel shows the bare
/// secret only, so there is no issuer or label to get wrong. Nothing is stored
/// yet -- the binding completes only once a code derived from this secret is
/// confirmed, so an abandoned dialog leaves the sign-in path exactly as it was.
pub async fn totp_begin(_: crate::api::Admin, State(_): State<crate::Shared>) -> Response {
    let secret = BASE32_NOPAD.encode(&rand::random::<[u8; 20]>());
    Json(serde_json::json!({"secret": secret})).into_response()
}

#[derive(Deserialize)]
pub struct TotpConfirm {
    secret: String,
    code: String,
}

/// Completes the binding by proving the authenticator and the hub hold the
/// same secret: the code must be one this secret produces right now.
pub async fn totp_confirm(
    _: crate::api::Admin,
    State(app): State<crate::Shared>,
    Json(body): Json<TotpConfirm>,
) -> Response {
    if !totp_matches(&body.secret, body.code.trim()) {
        return (StatusCode::BAD_REQUEST, "验证码不正确，请确认时间同步后重试").into_response();
    }
    match app.db.set("totp_secret", body.secret.trim()) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Removes the second factor. An authenticated session stands behind this, as
/// behind every panel write.
pub async fn totp_disable(_: crate::api::Admin, State(app): State<crate::Shared>) -> Response {
    match app.db.set("totp_secret", "") {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Attaches several `Set-Cookie` headers to one response. An array of header
/// tuples is unsuitable: axum applies those with `HeaderMap::insert`, so a
/// second `Set-Cookie` replaces the first. Empty entries are skipped.
pub fn with_cookies<const N: usize>(response: impl IntoResponse, cookies: [String; N]) -> Response {
    let mut response = response.into_response();
    for cookie in cookies {
        if cookie.is_empty() {
            continue;
        }
        match cookie.parse() {
            Ok(value) => {
                response.headers_mut().append(header::SET_COOKIE, value);
            }
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "bad cookie").into_response(),
        }
    }
    response
}

/// Peer address, or the last hop in X-Forwarded-For when the request arrived
/// through a local reverse proxy. Used for throttling and for the address shown
/// beside a node, never for authorization.
///
/// The header is honoured only when the peer is itself local. Otherwise a
/// caller could mint a fresh identity per request, bypassing the lockout and
/// growing the throttle map without bound.
///
/// The last value is taken, not the first. Both documented proxies append
/// rather than replace -- nginx's `$proxy_add_x_forwarded_for`, caddy's
/// `reverse_proxy` default -- so a caller supplying its own `X-Forwarded-For`
/// leaves that value at the head while the address the proxy observed lands at
/// the tail. Reading the head would return control of the lockout to the
/// caller: rotating the header makes every attempt a fresh address, and writing
/// the operator's address locks them out of the sign-in page.
///
/// A second trusted proxy in front of the local one places its own address at
/// the tail instead. No single value in this header identifies the client, so
/// such a deployment must have its edge write the client address.
///
/// Both addresses are canonicalized: the default dual-stack `[::]` listener
/// reports IPv4 peers, 127.0.0.1 included, as `::ffff:a.b.c.d`, which no IPv6
/// range below recognizes as local.
///
/// A Cloudflare orange cloud is that second proxy. With the panel's
/// `cf_connecting_ip` setting on, the address the edge writes --
/// `CF-Connecting-IP`, overwritten on every pass through it -- is read before
/// this header: behind an untrusting proxy the tail here is Cloudflare's own
/// address, different on every connection, and the setting is what keeps a
/// node's country badge from churning with it.
pub fn client_ip(trust_cf: bool, headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    let peer = peer.to_canonical();
    if !behind_local_proxy(peer) {
        return peer;
    }
    if trust_cf {
        if let Some(ip) = headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<IpAddr>().ok())
        {
            return ip.to_canonical();
        }
    }
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(|v| v.trim().parse::<IpAddr>().ok())
        .map_or(peer, |ip| ip.to_canonical())
}

/// Whether the deployment says a Cloudflare edge sits in front of the local
/// proxy. Read per request rather than cached: the setting is flipped from the
/// panel, and a cached answer would keep the old addresses one restart long.
pub fn trust_cf_ip(app: &App) -> bool {
    app.db.get("cf_connecting_ip").as_deref() == Some("on")
}

/// Loopback or a private network, where a reverse proxy resides.
fn behind_local_proxy(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        // Unique-local (fc00::/7) and link-local (fe80::/10); the stable
        // standard library provides no predicate for either.
        IpAddr::V6(v6) => {
            let head = v6.segments()[0];
            v6.is_loopback() || head & 0xfe00 == 0xfc00 || head & 0xffc0 == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_password_round_trips_fails_closed_and_never_repeats_a_salt() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("Correct horse battery staple", &hash));
        assert!(!verify_password("", &hash));
        // A corrupt or empty stored hash must fail closed.
        assert!(!verify_password("anything", "not-a-hash"));
        assert!(!verify_password("anything", ""));
        // The salt is per hash, so cracking one row does not reveal every other
        // row sharing that password.
        assert_ne!(hash_password("same").unwrap(), hash_password("same").unwrap());
    }

    /// One address through the full lockout lifecycle: attempts up to the limit
    /// are allowed, the next locks the address out, the window expires on its
    /// own, and a success clears it early. The window is shortened so expiry is
    /// reachable within the test.
    #[test]
    fn a_lockout_lands_expires_on_its_own_and_clears_on_success() {
        let window = Duration::from_millis(60);
        let t = Throttle { window, ..Default::default() };
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let other: IpAddr = "203.0.113.8".parse().unwrap();
        let stale: IpAddr = "203.0.113.9".parse().unwrap();
        let held = || t.seen.lock().unwrap().len();

        t.record_failure(stale);
        for _ in 0..MAX_ATTEMPTS {
            assert!(!t.locked(ip), "attempts up to the limit are still allowed");
            t.record_failure(ip);
        }
        assert!(t.locked(ip), "the attempt past the limit is shut out");
        assert!(!t.locked(other), "the lockout must not spread to other addresses");

        // A lockout is a delay rather than a ban: the address is readmitted
        // automatically.
        std::thread::sleep(window * 2);
        assert!(!t.locked(ip), "an expired lockout must lift on its own");

        // `stale` is never queried, so only the sweep on entry can remove it.
        // Without it the map grows by one entry per address presented, for the
        // life of the process.
        assert_eq!(held(), 1, "the expired lockout is gone, stale is still held");
        t.record_failure(other);
        assert_eq!(held(), 1, "the stale address is swept, not carried");

        // A correct password clears the count, so two typos do not make the next
        // mistake a lockout.
        t.clear(other);
        assert_eq!(held(), 0);
    }

    /// The gate must refuse rather than queue: a queue admits the same flood,
    /// and each attempt that lands costs 19 MiB which remains in a thread's
    /// arena for the life of the process.
    #[test]
    fn the_password_gate_refuses_a_flood_rather_than_queueing_it() {
        let held: Vec<_> =
            (0..PASSWORD_CHECKS).map(|_| PASSWORD_GATE.try_acquire().expect("up to the limit")).collect();
        assert!(PASSWORD_GATE.try_acquire().is_err(), "the attempt past the limit must be refused");
        drop(held);
        assert!(PASSWORD_GATE.try_acquire().is_ok(), "permits come back when the checks finish");
    }

    /// RFC 6238 against published vectors: a known key and step must produce
    /// the documented code, the drift window must accept the neighbouring
    /// steps, and anything else must not verify.
    #[test]
    fn a_totp_code_matches_only_its_step_and_its_neighbours() {
        // RFC 6238's appendix B key, "12345678901234567890", base32-encoded;
        // the code for one step is the RFC 4226 HOTP of that counter.
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let key = BASE32_NOPAD.decode(secret.as_bytes()).unwrap();
        assert_eq!(totp_at(&key, 0), "755224");
        assert_eq!(totp_at(&key, 1), "287082");
        assert_eq!(totp_at(&key, 2), "359152");

        // A secret no authenticator could hold decodes to nothing and matches
        // nothing, rather than passing every check.
        assert!(!totp_matches("not base32!!", "000000"));
        // The code for a far-away step does not verify.
        let far = totp_at(&key, 0);
        if totp_at(&key, Utc::now().timestamp() / TOTP_STEP) != far {
            assert!(!totp_matches(secret, &far));
        }
    }

    /// A session cookie's round trip: the flags it is issued with, sharing a
    /// response with a second cookie, and being extracted from the single header
    /// the browser returns them in.
    #[test]
    fn a_session_cookie_goes_out_locked_down_alongside_others_and_parses_back() {
        let session = set_cookie(COOKIE, "abc123", 3_600, true);
        assert!(session.contains("HttpOnly") && session.contains("SameSite=Lax"));
        assert!(session.contains("Secure"));
        assert!(!set_cookie(COOKIE, "abc123", 3_600, false).contains("Secure"));

        // axum applies an array of header tuples with insert(), keeping only the
        // last Set-Cookie; this helper appends instead.
        let response = with_cookies(StatusCode::OK, [session, "x=1".to_owned()]);
        let set: Vec<_> = response.headers().get_all(header::SET_COOKIE).iter().collect();
        assert_eq!(set.len(), 2, "both cookies must reach the browser");
        // Empty entries are skipped rather than emitting a blank header.
        let response = with_cookies(StatusCode::OK, ["a=1".to_owned(), String::new()]);
        assert_eq!(response.headers().get_all(header::SET_COOKIE).iter().count(), 1);

        // And back: the browser returns them all in a single header.
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "other=1; monitor_session=abc123; x=2".parse().unwrap());
        assert_eq!(cookie_value(&h, COOKIE).as_deref(), Some("abc123"));
        assert_eq!(cookie_value(&h, "missing"), None);
        assert_eq!(cookie_value(&HeaderMap::new(), COOKIE), None);
    }

    #[test]
    fn forwarded_header_is_trusted_only_behind_a_local_proxy() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let xff = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert("x-forwarded-for", v.parse().unwrap());
            h
        };

        // Nothing arrived with the request: the proxy appended the single
        // address it observed, which is the entire header.
        assert_eq!(client_ip(false, &xff("198.51.100.9"), ip("127.0.0.1")).to_string(), "198.51.100.9");

        // The caller supplied a header of its own. Both documented proxies
        // append, so the fabricated value sits at the head and the proxy's
        // observation at the tail; reading the head would let a caller choose its
        // own throttle bucket each request, or claim the operator's address.
        let forged = xff("10.0.0.2, 198.51.100.9");
        for peer in ["127.0.0.1", "10.0.0.1", "::1", "fd00::1"] {
            assert_eq!(client_ip(false, &forged, ip(peer)).to_string(), "198.51.100.9", "{peer}");
        }

        // A dual-stack `[::]` listener reports an IPv4 proxy as `::ffff:a.b.c.d`,
        // which is the same local peer.
        assert_eq!(client_ip(false, &forged, ip("::ffff:172.18.0.4")).to_string(), "198.51.100.9");
        assert_eq!(client_ip(false, &HeaderMap::new(), ip("::ffff:203.0.113.5")), ip("203.0.113.5"));

        // Directly from the internet the entire header is caller-supplied, and
        // honouring any part of it bypasses the lockout.
        assert_eq!(client_ip(false, &forged, ip("203.0.113.5")), ip("203.0.113.5"));
        assert_eq!(client_ip(false, &forged, ip("2001:db8::5")), ip("2001:db8::5"));
        // No header at all: the peer address is used.
        assert_eq!(client_ip(false, &HeaderMap::new(), ip("10.0.0.1")), ip("10.0.0.1"));
    }

    #[test]
    fn the_cloudflare_header_is_read_only_when_the_setting_says_so() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let headers = |cf: Option<&str>, xff: Option<&str>| {
            let mut h = HeaderMap::new();
            if let Some(v) = cf {
                h.insert("cf-connecting-ip", v.parse().unwrap());
            }
            if let Some(v) = xff {
                h.insert("x-forwarded-for", v.parse().unwrap());
            }
            h
        };

        // Off, the default: the edge's answer is ignored and the proxy's own
        // observation -- Cloudflare's address, not the caller's -- is what the
        // X-Forwarded-For tail holds.
        let behind_edge = headers(Some("198.51.100.9"), Some("162.158.0.1"));
        assert_eq!(client_ip(false, &behind_edge, ip("127.0.0.1")).to_string(), "162.158.0.1");

        // On, the edge's answer wins: through Cloudflare the header was
        // overwritten by the edge itself, so it is the one value a caller
        // cannot choose.
        assert_eq!(client_ip(true, &behind_edge, ip("127.0.0.1")).to_string(), "198.51.100.9");

        // On but absent -- a deployment where Cloudflare fronts only some
        // hosts, or was switched off since: the X-Forwarded-For fallback
        // still applies.
        assert_eq!(
            client_ip(true, &headers(None, Some("198.51.100.9")), ip("127.0.0.1")).to_string(),
            "198.51.100.9"
        );

        // On and unparseable: same fallback.
        assert_eq!(
            client_ip(true, &headers(Some("not-an-address"), Some("198.51.100.9")), ip("127.0.0.1"))
                .to_string(),
            "198.51.100.9"
        );

        // Directly from the internet the header is caller-supplied even with
        // the setting on: the peer address is the only honest answer.
        let forged = headers(Some("10.0.0.2"), Some("10.0.0.2, 198.51.100.9"));
        assert_eq!(client_ip(true, &forged, ip("203.0.113.5")), ip("203.0.113.5"));
    }
}
