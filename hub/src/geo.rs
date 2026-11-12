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

/// Ceiling on one provider download, compressed or not, and the same ceiling
/// on what a gzip may expand to. A Country database is a few MiB and the City
/// database around 70, so 128 MiB covers the largest real database with room
/// to grow; the number exists so a hijacked or misbehaving endpoint cannot
/// fill the disk or the memory instead. Both phases stream through the disk,
/// never holding more than a chunk in memory, so the ceiling is about what
/// lands -- the mmdb reader still reads the whole file in, which is the
/// steady cost of City-level detail under the unit file's MemoryMax.
const MAX_DATABASE_BYTES: u64 = 128 * 1024 * 1024;

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
    let part = dest.with_extension("part");
    let tmp = dest.with_extension("tmp");

    let mut last_err = anyhow::anyhow!("no URL tried");
    for url in urls.split('|') {
        let cleanup = |last_err: anyhow::Error| {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&tmp);
            last_err
        };
        let mut request = app.http.get(url).timeout(std::time::Duration::from_secs(300));
        if let Some((account, key)) = credentials.as_ref() {
            if account.is_empty() || key.is_empty() {
                bail!("maxmind 需要先在设置里填入账户 ID 和 license key");
            }
            request = request.basic_auth(account, Some(key));
        }
        let fetched = request.send().await.and_then(|res| res.error_for_status());
        let mut res = match fetched {
            Ok(res) => res,
            Err(e) => {
                last_err = e.into();
                continue;
            }
        };
        // Streamed straight to disk: whatever the answer's size, only one
        // chunk is in memory at a time, and a body past the ceiling is cut off
        // mid-transfer rather than buffered first.
        if let Err(e) = stream_capped(&mut res, MAX_DATABASE_BYTES, &part).await {
            last_err = cleanup(e);
            continue;
        }
        // db-ip ships gzip; MaxMind's update endpoint answers the raw mmdb.
        // Told apart by magic bytes rather than the URL, so a provider changing
        // its mind about compression keeps working. Off the runtime and through
        // the disk for the same reason as the download: the expansion of a City
        // database never lives in memory on its way to the file.
        let expanded = {
            let (src, dst) = (part.clone(), tmp.clone());
            match tokio::task::spawn_blocking(move || expand_if_gzip(&src, &dst, MAX_DATABASE_BYTES)).await {
                Ok(Ok(expanded)) => expanded,
                Ok(Err(e)) => {
                    last_err = cleanup(e);
                    continue;
                }
                Err(e) => {
                    last_err = cleanup(e.into());
                    continue;
                }
            }
        };
        let _ = expanded; // only the file's own size is reported, read below
                          // Parsed before it replaces anything: a truncated or non-mmdb answer
                          // must not become the database lookups read.
        if let Err(e) = Reader::open_readfile(&tmp).context("the download is not an mmdb database") {
            last_err = cleanup(e);
            continue;
        }
        let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or_default();
        let _ = std::fs::remove_file(&part);
        std::fs::rename(&tmp, &dest)?;
        forget();
        return Ok((name.to_owned(), size as i64));
    }
    Err(last_err.context(format!("下载 {name} 数据库失败")))
}

/// Writes the response body to `to` as it arrives, refusing to write past
/// `cap` bytes. The hub's memory holds one chunk at a time; the disk under
/// `data/` is what a database of this size belongs on.
async fn stream_capped(res: &mut reqwest::Response, cap: u64, to: &std::path::Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(to).await?;
    let mut written: u64 = 0;
    while let Some(chunk) = res.chunk().await? {
        written += chunk.len() as u64;
        if written > cap {
            anyhow::bail!("the answer is larger than the {cap} bytes this fetch allows");
        }
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    Ok(())
}

/// Turns the file just downloaded at `src` into the one to install at `dst`:
/// gunzipped when its magic bytes say gzip, moved verbatim otherwise. The
/// expansion is capped like the download -- a small gzip that expands without
/// end is the other shape an oversized answer takes -- and truncated at the
/// cap exactly like one that fails to parse, below.
fn expand_if_gzip(src: &std::path::Path, dst: &std::path::Path, cap: u64) -> Result<bool> {
    use std::io::{BufReader, Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(src)?;
    let mut magic = [0u8; 2];
    let read = file.read(&mut magic)?;
    file.seek(SeekFrom::Start(0))?;
    if read == 2 && magic == [0x1f, 0x8b] {
        let mut decoder = flate2::read::GzDecoder::new(BufReader::new(file));
        let mut limited = (&mut decoder).take(cap);
        let mut out = std::fs::File::create(dst)?;
        std::io::copy(&mut limited, &mut out).context("gunzip")?;
        out.sync_all()?;
        Ok(true)
    } else {
        std::fs::rename(src, dst)?;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two shapes `expand_if_gzip` answers for: a gzip lands expanded, a
    /// plain file lands moved, and both report which. The cap is exercised by
    /// a gzip that would expand past it: the output is cut at the cap, exactly
    /// as a download past the cap is, and the caller's parse-or-refuse step
    /// below is what rejects it -- the reader cannot open half a database.
    #[test]
    fn a_download_expands_when_gzipped_and_moves_when_not() {
        use flate2::write::GzEncoder;
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("monitor-geo-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("downloaded");
        let dst = dir.join("installed");

        // Plain: moved, not copied through a decoder.
        std::fs::write(&src, b"not gzip at all").unwrap();
        assert!(!expand_if_gzip(&src, &dst, 1024).unwrap());
        assert_eq!(std::fs::read(&dst).unwrap(), b"not gzip at all");
        assert!(!src.exists(), "moved, not copied");

        // Gzip: expanded on the way to the file.
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"the database bytes").unwrap();
        std::fs::write(&src, encoder.finish().unwrap()).unwrap();
        assert!(expand_if_gzip(&src, &dst, 1024).unwrap());
        assert_eq!(std::fs::read(&dst).unwrap(), b"the database bytes");

        // A gzip expanding past the cap is cut at the cap, not buffered whole.
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&[0u8; 4096]).unwrap();
        std::fs::write(&src, encoder.finish().unwrap()).unwrap();
        assert!(expand_if_gzip(&src, &dst, 16).unwrap());
        assert_eq!(std::fs::metadata(&dst).unwrap().len(), 16, "truncated at the cap");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
