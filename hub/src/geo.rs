//! Where a node's country comes from.
//!
//! Three providers sit behind one switch, chosen in settings:
//!
//! * `ipinfo` -- the online API, one request per node per hour. No database, no
//!   credentials, and the default so an upgrade changes nothing.
//! * `maxmind` -- GeoLite2 Country as a local .mmdb, downloaded on demand from
//!   the panel. Needs the account id and license key a free MaxMind account
//!   issues.
//! * `dbip` -- db-ip's LITE country database, the same shape with no
//!   credentials at all.
//!
//! Both local providers answer from one file under `<data>/geoip/`, refreshed
//! by hand: the manual update button is deliberate, so an operator on a
//! metered link decides when the few megabytes are spent.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use chrono::{Datelike, Local};
use maxminddb::Reader;

use crate::App;

/// The selected provider, `ipinfo` when none is stored.
pub fn provider(app: &App) -> &'static str {
    match app.db.get("geoip_provider").as_deref() {
        Some("maxmind") => "maxmind",
        Some("dbip") => "dbip",
        _ => "ipinfo",
    }
}

/// The one file both local providers keep, beside the themes under `data/`.
fn mmdb_path(app: &App) -> PathBuf {
    let data = app.themes.parent().map(Path::to_path_buf).unwrap_or_default();
    data.join("geoip").join("country.mmdb")
}

/// The cached reader, opened at most once per file. `Arc` rather than a bare
/// `Reader` because the lookup path hands clones out under the lock instead of
/// holding it for the duration of a query.
type Cached = Option<Arc<Reader<Vec<u8>>>>;
static READER: OnceLock<Mutex<Cached>> = OnceLock::new();

/// Drops the cached reader, so the next lookup opens the file on disk again.
/// Called after a manual update; a restart does the same.
pub fn forget() {
    if let Some(held) = READER.get() {
        *held.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn reader(app: &App) -> Option<Arc<Reader<Vec<u8>>>> {
    let cell = READER.get_or_init(|| Mutex::new(None));
    let mut held = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = held.as_ref() {
        return Some(existing.clone());
    }
    let opened = Reader::open_readfile(mmdb_path(app)).ok()?;
    let shared = Arc::new(opened);
    *held = Some(shared.clone());
    Some(shared)
}

/// The country for `ip` from the local database, when the selected provider is
/// a local one and its database is present. `None` leaves the badge hidden,
/// the same state an unreachable online lookup leaves.
pub fn lookup(app: &App, ip: &str) -> Option<String> {
    if !matches!(provider(app), "maxmind" | "dbip") {
        return None;
    }
    let reader = reader(app)?;
    let address: IpAddr = ip.parse().ok()?;
    let found: maxminddb::geoip2::Country = reader.lookup(address).ok()?;
    let code = found.country?.iso_code?;
    Some(code.to_ascii_uppercase())
}

/// When the local database was last replaced, and how large it is: what the
/// settings page shows beside the update button. `None` when there is no file.
pub fn database_state(app: &App) -> Option<(i64, i64)> {
    let meta = std::fs::metadata(mmdb_path(app)).ok()?;
    Some((
        meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
        meta.len() as i64,
    ))
}

/// Where each provider publishes. db-ip's LITE database is named by month and
/// published a few days into it, so the previous month is asked for as well.
fn download_url(app: &App) -> (String, Option<(String, String)>) {
    match provider(app) {
        "maxmind" => (
            "https://download.maxmind.com/geoip/databases/GeoLite2-Country/update?db_format=mmdb".into(),
            Some((
                app.db.get("geoip_account_id").unwrap_or_default(),
                app.db.get("geoip_license_key").unwrap_or_default(),
            )),
        ),
        "dbip" => {
            let now = Local::now();
            let url = |year: i32, month: u32| {
                format!("https://download.db-ip.com/free/dbip-country-lite-{year}-{month:02}.mmdb.gz")
            };
            // db-ip keeps last month's file up until this month's lands, and a
            // URL for a month that does not exist yet simply 404s.
            let (mut year, mut month) = (now.year(), now.month());
            if month == 1 {
                year -= 1;
                month = 12;
            } else {
                month -= 1;
            }
            (format!("{}|{}", url(now.year(), now.month()), url(year, month)), None)
        }
        _ => ("https://ipinfo.io".into(), None),
    }
}

/// Fetches the selected provider's database onto disk, replacing whatever was
/// there, and returns its size in bytes.
///
/// Off the call path: the caller is the manual update button. The file lands
/// whole under a temporary name first, so a half-downloaded database never
/// becomes the one lookups read.
pub async fn download(app: &App) -> Result<(String, i64)> {
    let name = provider(app);
    if name == "ipinfo" {
        bail!("ipinfo 是在线接口，没有本地数据库可更新");
    }
    let (urls, credentials) = download_url(app);
    let dest = mmdb_path(app);
    std::fs::create_dir_all(dest.parent().expect("geoip/ under data/"))?;

    let mut last_err = anyhow::anyhow!("no URL tried");
    for url in urls.split('|') {
        let mut request = app.http.get(url).timeout(std::time::Duration::from_secs(300));
        if let Some((account, key)) = credentials.as_ref() {
            if account.is_empty() || key.is_empty() {
                bail!("maxmind 需要先在设置里填入账户 ID 和 license key");
            }
            request = request.basic_auth(account, Some(key));
        }
        let fetched = request.send().await.and_then(|res| res.error_for_status());
        let bytes = match fetched {
            Ok(res) => match res.bytes().await {
                Ok(bytes) => bytes,
                Err(e) => {
                    last_err = e.into();
                    continue;
                }
            },
            Err(e) => {
                last_err = e.into();
                continue;
            }
        };
        // db-ip ships gzip; MaxMind's update endpoint answers the raw mmdb.
        // Told apart by magic bytes rather than the URL, so a provider changing
        // its mind about compression keeps working.
        let raw = if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
            let mut out = Vec::new();
            std::io::Read::read_to_end(&mut decoder, &mut out).context("gunzip")?;
            out
        } else {
            bytes.to_vec()
        };
        // Parsed before it replaces anything: a truncated or non-mmdb answer
        // must not become the database lookups read.
        Reader::from_source(raw.clone()).context("the download is not an mmdb database")?;
        let tmp = dest.with_extension("tmp");
        std::fs::write(&tmp, &raw)?;
        std::fs::rename(&tmp, &dest)?;
        forget();
        return Ok((name.to_owned(), raw.len() as i64));
    }
    Err(last_err.context(format!("下载 {name} 数据库失败")))
}
