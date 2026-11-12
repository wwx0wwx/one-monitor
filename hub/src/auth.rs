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

// Not `__Host-monitor_session`, deliberately: a `__Host-` cookie must carry
// Secure, and a browser then refuses it over the plain-HTTP ip:port entry
// point this hub supports out of the box (local development, an SSH tunnel).
// The cookie is already host-only (no Domain) and SameSite=Lax, so a subdomain
// can neither receive nor overwrite it; the prefix would buy nothing the
// supported deployments can keep.

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

// pub(crate) rather than pub: the panel tests read the hash back and check
// the one-time password file against the same test the login route runs.
pub(crate) fn verify_password(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// The throttle key for an address: the address itself, except that IPv6
/// counts by its /64. One subscriber holds a /64, so the addresses in it are
/// one party as often as they are many -- and a caller who owns the prefix can
/// mint a fresh address per attempt, which by exact address would give every
/// attempt its own empty counter. Counted by prefix, those attempts pool into
/// the lockout they are trying to escape.
pub(crate) fn throttle_key(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            let masked = [segments[0], segments[1], segments[2], segments[3], 0, 0, 0, 0];
            IpAddr::V6(masked.into())
        }
    }
}

/// TOTP failures counted across every address, not per address.
///
/// The second factor is only reached with the password already verified, so
/// these attempts come from someone holding half the credential. Per-address
/// throttling is the wrong shape against that: the remaining half is six
/// digits, and a caller with several addresses -- or a forged X-Forwarded-For
/// behind a private-network deployment -- gets a fresh counter for each. The
/// hub has one account, so one global counter cannot lock out anyone but the
/// attacker, and the operator who types a wrong code a few times waits out the
/// same window rather than being told their memory of it is a threat.
///
/// In memory, like `Throttle`: the alternative is a table row, and a row a
/// restart forgets costs nothing while the code is only six digits long.
pub struct TotpFailures {
    seen: Mutex<(u32, Instant)>,
}

impl Default for TotpFailures {
    fn default() -> Self {
        // A window that has already elapsed rather than one starting at the
        // process's birth: the first failure of the process begins a new one.
        Self { seen: Mutex::new((0, Instant::now() - LOCKOUT)) }
    }
}

impl TotpFailures {
    pub(crate) fn locked(&self) -> bool {
        let (count, since) = *self.seen.lock().unwrap_or_else(|e| e.into_inner());
        count >= MAX_ATTEMPTS && since.elapsed() < LOCKOUT
    }

    pub(crate) fn record_failure(&self) {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.1.elapsed() >= LOCKOUT {
            // A new window starts at this failure rather than carrying the
            // previous window's count, which would lock out on the first try.
            *seen = (0, Instant::now());
        }
        seen.0 += 1;
    }

    pub(crate) fn clear(&self) {
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = (0, Instant::now());
    }
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
        let ip = throttle_key(ip);
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
        let ip = throttle_key(ip);
        let mut map = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        // Addresses past their window are dropped here rather than allowed to
        // accumulate, which also restarts the count for a returning address.
        map.retain(|_, (_, since)| since.elapsed() < self.window);
        map.entry(ip).or_insert((0, Instant::now())).0 += 1;
    }

    pub(crate) fn clear(&self, ip: IpAddr) {
        let ip = throttle_key(ip);
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
/// see `App::secure_cookies`. The address the sign-in came from is stored with
/// the session, so the session list can tell the operator's own logins from
/// someone else's.
pub fn issue_session(app: &App, headers: &HeaderMap, ip: IpAddr) -> Result<String> {
    let token = random_token();
    app.db.create_session(
        &sha256(&token),
        Utc::now().timestamp() + SESSION_DAYS * 86_400,
        &ip.to_string(),
    )?;
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

/// The step `code` was derived from, if `secret` produces it now, one step ago,
/// or one step ahead -- the drift a clock-skewed phone needs. The highest
/// matching step is the answer, so replay bookkeeping never walks backwards.
///
/// The comparison is exact only, across all three steps, with no early return:
/// constant-time enough for six digits compared as strings.
fn totp_step_matched(secret: &str, code: &str) -> Option<i64> {
    let Ok(secret) = BASE32_NOPAD.decode(secret.to_ascii_uppercase().as_bytes()) else { return None };
    let now = Utc::now().timestamp();
    let mut hit = None;
    for drift in [-1, 0, 1] {
        let step = (now + drift * TOTP_STEP) / TOTP_STEP;
        if totp_at(&secret, step) == code {
            hit = Some(hit.unwrap_or(step).max(step));
        }
    }
    hit
}

/// The last time step whose code was accepted, from `setting`. Codes for steps
/// at or before it are replays: six digits are guessable in a phished window,
/// but only once. Absent on a hub that has never accepted a code, and on one
/// whose second factor is unbound again.
fn totp_last_step(app: &App) -> i64 {
    app.db.get("totp_last_step").and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Refuses a code whose step was already spent, and records the step it accepts.
/// A code verified here can still be typed into the sign-in page within its
/// window without this -- the two halves of one credential, spent separately.
fn totp_fresh(app: &App, secret: &str, code: &str) -> bool {
    let Some(step) = totp_step_matched(secret, code) else { return false };
    if step <= totp_last_step(app) {
        return false;
    }
    app.db.set("totp_last_step", &step.to_string()).is_ok()
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
    let ip =
        client_ip(trust_cf_ip(&app), trust_private_xff(&app), &trusted_proxies(&app), &headers, peer.ip());
    if app.throttle.locked(ip) {
        return (StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，请稍后再试").into_response();
    }
    // Held across the check below, which is its purpose.
    let Ok(_permit) = PASSWORD_GATE.try_acquire() else {
        return (StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，请稍后再试").into_response();
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
        return (StatusCode::UNAUTHORIZED, "密码不正确").into_response();
    }
    let via = match credential {
        Credential::Password => {
            if totp_bound(&app) {
                // Counted globally as well as per address: see `TotpFailures`.
                // Checked before the code is read, so a flood of wrong codes
                // cannot keep spending argon2 on the password in front of them.
                if app.totp.locked() {
                    return (StatusCode::TOO_MANY_REQUESTS, "两步验证尝试过多，请稍后再试").into_response();
                }
                let code = body.code.as_deref().unwrap_or_default().trim().to_owned();
                let Some(secret) = app.db.get("totp_secret").filter(|s| !s.is_empty()) else {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "两步验证数据不可读，请检查数据库")
                        .into_response();
                };
                if !totp_fresh(&app, &secret, &code) {
                    // Counted like a wrong password: the code is the other half
                    // of the credential, and an unlimited guessing room against
                    // six digits would spend them all. A code already accepted
                    // lands here too, whatever half of the credential it
                    // completed.
                    app.throttle.record_failure(ip);
                    app.totp.record_failure();
                    return (StatusCode::UNAUTHORIZED, "验证码不正确，请确认时间同步后重试").into_response();
                }
                app.totp.clear();
            }
            "密码"
        }
        Credential::Recovery => "应急密码",
    };
    app.throttle.clear(ip);
    // The one-time password file has served its purpose the moment a password
    // works: whoever holds it is inside, and can change the password under
    // Security. Left behind it would be a second copy of a credential that
    // outlives the sign-in it was printed for.
    let _ = std::fs::remove_file(app.secrets.join("initial-password"));
    match issue_session(&app, &headers, ip) {
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
    if !totp_fresh(&app, &body.secret, body.code.trim()) {
        return (StatusCode::BAD_REQUEST, "验证码不正确，请确认时间同步后重试").into_response();
    }
    // `totp_fresh` has spent the confirming code: it must not open the sign-in
    // page as well, inside the same window, through the secret it just bound.
    match app.db.set("totp_secret", body.secret.trim()) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Removes the second factor. An authenticated session stands behind this, as
/// behind every panel write. The secret goes first and the replay mark second:
/// between a failed second write the old secret would still be bound, and a
/// zeroed mark would reopen the window for codes it had already spent. Left
/// un-zeroed the stale mark can only refuse codes -- nothing is bound to it.
pub async fn totp_disable(_: crate::api::Admin, State(app): State<crate::Shared>) -> Response {
    match app.db.set("totp_secret", "") {
        Ok(()) => {
            let _ = app.db.set("totp_last_step", "0");
            Json(serde_json::json!({"ok": true})).into_response()
        }
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
/// The header is honoured only when the peer is itself local, or is one of the
/// addresses the operator named in `trusted_proxies`. Otherwise a caller could
/// mint a fresh identity per request, bypassing the lockout and growing the
/// throttle map without bound.
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
pub fn client_ip(
    trust_cf: bool,
    trust_private: bool,
    proxies: &str,
    headers: &HeaderMap,
    peer: IpAddr,
) -> IpAddr {
    let peer = peer.to_canonical();
    if !behind_local_proxy(peer, trust_private) && !named_proxy(peer, proxies) {
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

/// The `trusted_proxies` setting, read per request like its neighbours.
pub fn trusted_proxies(app: &App) -> String {
    app.db.get("trusted_proxies").unwrap_or_default()
}

/// Loopback or a private network, where a reverse proxy resides.
///
/// `trust_private` widens the loopback-only default to private ranges: a hub in
/// a container, fronted by a proxy in another container on the same bridge,
/// sees a private peer. That is also the shape of a network an untrusted
/// machine can sit on, so it is a setting (`trust_private_xff`) rather than a
/// constant -- a hub whose proxy is on loopback, or which faces the internet
/// directly, has nothing to gain and spoofing to refuse.
fn behind_local_proxy(ip: IpAddr, trust_private: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || (trust_private && (v4.is_private() || v4.is_link_local())),
        // Unique-local (fc00::/7) and link-local (fe80::/10); the stable
        // standard library provides no predicate for either.
        IpAddr::V6(v6) => {
            let head = v6.segments()[0];
            v6.is_loopback() || (trust_private && (head & 0xfe00 == 0xfc00 || head & 0xffc0 == 0xfe80))
        }
    }
}

/// One entry of `trusted_proxies`: an address, or a network with a prefix.
struct Net(IpAddr, u8);

impl Net {
    fn parse(entry: &str) -> Option<Self> {
        let (addr, prefix) = match entry.split_once('/') {
            Some((addr, prefix)) => {
                let addr: IpAddr = addr.parse().ok()?;
                let prefix = prefix.parse::<u8>().ok()?;
                let bits = if addr.is_ipv4() { 32 } else { 128 };
                if prefix > bits {
                    return None;
                }
                (addr, prefix)
            }
            None => {
                let addr: IpAddr = entry.parse().ok()?;
                let bits = if addr.is_ipv4() { 32 } else { 128 };
                (addr, bits)
            }
        };
        Some(Net(addr.to_canonical(), prefix))
    }

    /// A v4-mapped v6 address canonicalizes to v4, so both sides arrive in the
    /// family they were written in and a mismatch is a genuine one.
    fn contains(&self, ip: IpAddr) -> bool {
        match (self.0, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let bits = u32::from(self.1);
                let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
                let (net, ip) = (u32::from(net), u32::from(ip));
                net & mask == ip & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                // Whole segments up to the prefix boundary, then the masked
                // remainder of the segment it lands in.
                let bits = u32::from(self.1);
                let (full, rem) = ((bits / 16) as usize, bits % 16);
                let (net, ip) = (net.segments(), ip.segments());
                if net[..full] != ip[..full] {
                    return false;
                }
                rem == 0 || {
                    let mask = u16::MAX << (16 - rem);
                    net[full] & mask == ip[full] & mask
                }
            }
            _ => false,
        }
    }
}

/// Whether the peer is one of the networks `trusted_proxies` names -- the
/// precise form of the trust `trust_private_xff` hands to every private
/// address at once. An empty setting trusts nothing; malformed entries are
/// refused by the settings gate, and one that slips through is ignored here
/// rather than widening the trust it failed to describe.
fn named_proxy(peer: IpAddr, setting: &str) -> bool {
    setting
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|entry| !entry.is_empty())
        .any(|entry| Net::parse(entry).is_some_and(|net| net.contains(peer)))
}

/// Whether every entry of a `trusted_proxies` value names an address or a
/// network, for the settings gate: an unparsable entry is a spelling the
/// operator meant to trust, so it is refused outright rather than silently
/// narrowing (or, half-parsed, reinterpreting) the list.
pub fn trusted_proxies_valid(value: &str) -> bool {
    value
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|entry| !entry.is_empty())
        .all(|entry| Net::parse(entry).is_some())
}

/// Whether the panel trusts a private-network peer's X-Forwarded-For; on by
/// default, preserving container deployments, and read per request like
/// `trust_cf_ip` for the same reason.
pub fn trust_private_xff(app: &App) -> bool {
    app.db.get("trust_private_xff").as_deref() != Some("off")
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
        // The gate is one global permit, and any login-route test running in
        // parallel holds it across its argon2 for a moment. Waiting here is
        // not the behaviour under test -- the refusal past the limit, below,
        // is -- so the first grab retries while that neighbour finishes, and
        // the assert only fires if it never comes back at all.
        let held: Vec<_> = (0..PASSWORD_CHECKS)
            .map(|_| {
                for _ in 0..200 {
                    if let Ok(permit) = PASSWORD_GATE.try_acquire() {
                        return permit;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                panic!("a login-route test never released the gate")
            })
            .collect();
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
        assert_eq!(totp_step_matched("not base32!!", "000000"), None::<i64>);
        // The code for a far-away step does not verify.
        let far = totp_at(&key, 0);
        if totp_at(&key, Utc::now().timestamp() / TOTP_STEP) != far {
            assert_eq!(totp_step_matched(secret, &far), None::<i64>);
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

    /// IPv6 addresses inside one /64 share a lockout, and an address outside it
    /// has its own. The prefix, not the exact address, is the party.
    #[test]
    fn ipv6_attempts_pool_into_their_slash_64() {
        let t = Throttle::default();
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let a1 = ip("2001:db8:1:2:3:4:5:6");
        let a2 = ip("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
        let outside = ip("2001:db8:1:3::1");

        for _ in 0..MAX_ATTEMPTS {
            t.record_failure(a1);
        }
        assert!(t.locked(a1), "the address that failed is locked");
        assert!(t.locked(a2), "a neighbour in the same /64 shares the lockout");
        assert!(!t.locked(outside), "the next /64 has its own count");

        t.clear(a2);
        assert!(!t.locked(a1), "clearing one address clears the shared bucket");
    }

    /// A code matches its step and its neighbours, and reports the highest step
    /// it matched: replay bookkeeping that walked backwards would unlock a code
    /// it had already spent.
    #[test]
    fn a_matching_code_reports_its_highest_step() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let key = BASE32_NOPAD.decode(secret.as_bytes()).unwrap();
        let now = Utc::now().timestamp() / TOTP_STEP;
        assert_eq!(totp_step_matched(secret, &totp_at(&key, now)), Some(now));
        // The neighbour behind matches, and names its own step.
        assert_eq!(totp_step_matched(secret, &totp_at(&key, now - 1)), Some(now - 1));
        // Anything else is not a match at all.
        assert_eq!(totp_step_matched(secret, "000000"), None::<i64>);
    }

    /// The `trust_private_xff` half of the same gate: a hub whose proxy is on
    /// loopback, or which faces the internet directly, refuses the header from
    /// a private-network peer -- a network another machine can sit on -- while
    /// loopback peers keep it either way.
    #[test]
    fn a_private_peer_is_trusted_only_while_the_setting_says_so() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.9".parse().unwrap());

        for private in ["10.0.0.1", "172.18.0.4", "fd00::1"] {
            assert_eq!(
                client_ip(false, true, "", &headers, ip(private)).to_string(),
                "198.51.100.9",
                "{private}: trusted while on"
            );
            assert_eq!(
                client_ip(false, false, "", &headers, ip(private)),
                ip(private),
                "{private}: the peer itself while off"
            );
        }
        // Loopback is not a setting: the proxy the installer puts there is the
        // deployment's own, and nothing else can appear from it.
        assert_eq!(client_ip(false, false, "", &headers, ip("127.0.0.1")).to_string(), "198.51.100.9");
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
        assert_eq!(
            client_ip(false, true, "", &xff("198.51.100.9"), ip("127.0.0.1")).to_string(),
            "198.51.100.9"
        );

        // The caller supplied a header of its own. Both documented proxies
        // append, so the fabricated value sits at the head and the proxy's
        // observation at the tail; reading the head would let a caller choose its
        // own throttle bucket each request, or claim the operator's address.
        let forged = xff("10.0.0.2, 198.51.100.9");
        for peer in ["127.0.0.1", "10.0.0.1", "::1", "fd00::1"] {
            assert_eq!(client_ip(false, true, "", &forged, ip(peer)).to_string(), "198.51.100.9", "{peer}");
        }

        // A dual-stack `[::]` listener reports an IPv4 proxy as `::ffff:a.b.c.d`,
        // which is the same local peer.
        assert_eq!(client_ip(false, true, "", &forged, ip("::ffff:172.18.0.4")).to_string(), "198.51.100.9");
        assert_eq!(
            client_ip(false, true, "", &HeaderMap::new(), ip("::ffff:203.0.113.5")),
            ip("203.0.113.5")
        );

        // Directly from the internet the entire header is caller-supplied, and
        // honouring any part of it bypasses the lockout.
        assert_eq!(client_ip(false, true, "", &forged, ip("203.0.113.5")), ip("203.0.113.5"));
        assert_eq!(client_ip(false, true, "", &forged, ip("2001:db8::5")), ip("2001:db8::5"));
        // No header at all: the peer address is used.
        assert_eq!(client_ip(false, true, "", &HeaderMap::new(), ip("10.0.0.1")), ip("10.0.0.1"));
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
        assert_eq!(client_ip(false, true, "", &behind_edge, ip("127.0.0.1")).to_string(), "162.158.0.1");

        // On, the edge's answer wins: through Cloudflare the header was
        // overwritten by the edge itself, so it is the one value a caller
        // cannot choose.
        assert_eq!(client_ip(true, true, "", &behind_edge, ip("127.0.0.1")).to_string(), "198.51.100.9");

        // On but absent -- a deployment where Cloudflare fronts only some
        // hosts, or was switched off since: the X-Forwarded-For fallback
        // still applies.
        assert_eq!(
            client_ip(true, true, "", &headers(None, Some("198.51.100.9")), ip("127.0.0.1")).to_string(),
            "198.51.100.9"
        );

        // On and unparseable: same fallback.
        assert_eq!(
            client_ip(
                true,
                true,
                "",
                &headers(Some("not-an-address"), Some("198.51.100.9")),
                ip("127.0.0.1")
            )
            .to_string(),
            "198.51.100.9"
        );

        // Directly from the internet the header is caller-supplied even with
        // the setting on: the peer address is the only honest answer.
        let forged = headers(Some("10.0.0.2"), Some("10.0.0.2, 198.51.100.9"));
        assert_eq!(client_ip(true, true, "", &forged, ip("203.0.113.5")), ip("203.0.113.5"));
    }

    /// The precise form of the trust `trust_private_xff` grants a whole
    /// address range at once: a named proxy list admits exactly the proxies
    /// the deployment has, and nothing else on their network.
    #[test]
    fn a_named_proxy_is_trusted_and_its_neighbours_are_not() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let xff = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert("x-forwarded-for", v.parse().unwrap());
            h
        };

        // Off by default: an empty setting trusts no private peer.
        assert_eq!(client_ip(false, false, "", &xff("198.51.100.9"), ip("172.18.0.4")), ip("172.18.0.4"));
        // The one proxy the operator named.
        let named = "172.18.0.4";
        assert_eq!(
            client_ip(false, false, named, &xff("198.51.100.9"), ip("172.18.0.4")).to_string(),
            "198.51.100.9"
        );
        // Its neighbour on the same bridge is not the proxy, and a public peer
        // is never trusted however the setting reads.
        assert_eq!(client_ip(false, false, named, &xff("198.51.100.9"), ip("172.18.0.5")), ip("172.18.0.5"));
        assert_eq!(
            client_ip(false, false, named, &xff("198.51.100.9"), ip("203.0.113.5")),
            ip("203.0.113.5")
        );

        // A network names several proxies at once, in either family; a
        // v4-mapped peer of a v4 entry is the same proxy.
        let net = "10.0.0.0/24, 2001:db8:1::/64";
        assert_eq!(
            client_ip(false, false, net, &xff("198.51.100.9"), ip("10.0.0.199")).to_string(),
            "198.51.100.9"
        );
        assert_eq!(
            client_ip(false, false, net, &xff("198.51.100.9"), ip("::ffff:10.0.0.7")).to_string(),
            "198.51.100.9"
        );
        assert_eq!(client_ip(false, false, net, &xff("198.51.100.9"), ip("10.0.1.1")), ip("10.0.1.1"));
        assert_eq!(
            client_ip(false, false, net, &xff("198.51.100.9"), ip("2001:db8:1::dead")).to_string(),
            "198.51.100.9"
        );
        assert_eq!(
            client_ip(false, false, net, &xff("198.51.100.9"), ip("2001:db8:2::1")),
            ip("2001:db8:2::1")
        );

        // Separators, surrounding whitespace and junk entries: an entry that
        // is not an address matches nothing rather than widening the trust.
        for setting in [" 10.0.0.5 ,  not-an-address  ", "10.0.0.5\t10.0.0.6"] {
            assert_eq!(
                client_ip(false, false, setting, &xff("198.51.100.9"), ip("10.0.0.5")).to_string(),
                "198.51.100.9",
                "{setting:?}"
            );
            assert_eq!(
                client_ip(false, false, setting, &xff("198.51.100.9"), ip("10.0.0.7")),
                ip("10.0.0.7"),
                "{setting:?}"
            );
        }

        // A prefix past its family's width describes no network at all.
        assert!(Net::parse("10.0.0.0/33").is_none());
        assert!(Net::parse("2001:db8::/129").is_none());
        assert!(Net::parse("").is_none());
    }

    /// Two-step failures pool across addresses: the account has one second
    /// factor, and a caller with several addresses gets no fresh counter for
    /// each. The window expires on its own, as the per-address one does.
    #[test]
    fn totp_failures_pool_into_one_lockout_that_expires() {
        let t = TotpFailures::default();
        assert!(!t.locked());
        for _ in 0..MAX_ATTEMPTS {
            t.record_failure();
        }
        assert!(t.locked(), "the attempt past the limit is shut out");
        // A success clears it: the operator who misread their authenticator a
        // few times is not remembered for it.
        t.clear();
        assert!(!t.locked());
    }
}
