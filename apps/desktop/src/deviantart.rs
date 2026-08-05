//! Posting to DeviantArt: authorization, staging to Sta.sh, publishing.
//!
//! # Why OAuth and not a password
//!
//! Nothing here ever sees an account password, and that is deliberate rather
//! than incidental. A password in a config file is the one credential that also
//! unlocks the email it was reused on, and storing one would mean asking
//! someone to turn *off* two-factor auth to make an art uploader work. The
//! authorization-code flow costs one browser round trip — with 2FA, normally,
//! in the browser where it already works — and yields a token that only does
//! what its scopes allow.
//!
//! # The two-step submission
//!
//! `stash/submit` puts a file in Sta.sh, which is private staging inside
//! DeviantArt Studio. `stash/publish` turns a staged item into a public
//! deviation. Splitting them is what makes "upload everything, then look at it,
//! then post" possible: after staging, nothing is visible to anyone and the
//! work can be abandoned by simply not publishing.
//!
//! # What is stored where
//!
//! The client id and the redirect URI are configuration and live in the
//! settings table. The client secret and the refresh token are bearer
//! credentials for someone's account and live in the OS credential store —
//! SQLite would put them in plaintext in a file that travels with backups.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::types::{DeviantArtAccount, DeviantArtDraft, DeviantArtResult, DeviantArtSummary};

const AUTHORIZE_URL: &str = "https://www.deviantart.com/oauth2/authorize";
const TOKEN_URL: &str = "https://www.deviantart.com/oauth2/token";
const API: &str = "https://www.deviantart.com/api/v1/oauth2";

/// `basic` is required for `whoami`; the other two are the feature.
const SCOPES: &str = "basic stash publish";

pub const CLIENT_ID_KEY: &str = "deviantart_client_id";
pub const REDIRECT_KEY: &str = "deviantart_redirect_uri";
const USERNAME_KEY: &str = "deviantart_username";
const SCOPES_KEY: &str = "deviantart_scopes";

/// Fixed, not ephemeral: DeviantArt matches the redirect URI against the app's
/// whitelist character for character, so a port chosen at runtime could never
/// have been registered. High enough to need no privileges, and clear of 4340
/// where this app's own dev server lives.
const DEFAULT_REDIRECT: &str = "http://localhost:14340/deviantart";

const KEYCHAIN_SERVICE: &str = "net.glitchvector.luma-vault.deviantart";
const REFRESH_TOKEN_ENTRY: &str = "refresh-token";
const CLIENT_SECRET_ENTRY: &str = "client-secret";

/// How long to leave the callback listener up. Long enough to log in and pass a
/// 2FA challenge without hurrying, short enough that an abandoned attempt does
/// not hold the port until the app is quit.
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(300);

/// Progress while a batch uploads. One event shape for both phases.
pub const PROGRESS_EVENT: &str = "luma://deviantart";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviantArtProgress {
    /// `uploading`, `publishing` or `done`.
    pub phase: String,
    pub done: i64,
    pub total: i64,
    pub current: Option<String>,
}

pub struct DeviantArt {
    db: Arc<Db>,
    client: reqwest::Client,
    /// Access tokens last an hour, so one is worth keeping for a batch rather
    /// than refreshing per file. In memory only — it is not worth persisting
    /// something that expires before most sessions end.
    access: Mutex<Option<Access>>,
}

struct Access {
    token: String,
    expires_at: Instant,
}

impl DeviantArt {
    pub fn new(db: Arc<Db>) -> Self {
        Self {
            db,
            client: reqwest::Client::builder()
                // Generous: a 4K PNG is tens of megabytes and this is the one
                // place in the app that talks to something other than
                // localhost, so the link is whatever the user's link is.
                .timeout(Duration::from_secs(180))
                .build()
                .expect("the HTTP client has no fallible configuration"),
            access: Mutex::new(None),
        }
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    fn client_id(&self) -> Option<String> {
        self.db
            .setting(CLIENT_ID_KEY)
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
    }

    pub fn redirect_uri(&self) -> String {
        self.db
            .setting(REDIRECT_KEY)
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_REDIRECT.to_string())
    }

    /// Store the registered application's identifiers.
    ///
    /// The secret is optional: an app registered as *public* has none, which is
    /// the correct shape for something running on a desktop where a secret
    /// could never actually be kept. PKCE is what protects the exchange either
    /// way.
    pub fn configure(&self, client_id: &str, client_secret: Option<&str>) -> Result<()> {
        self.db.set_setting(CLIENT_ID_KEY, client_id.trim())?;
        match client_secret.map(str::trim).filter(|value| !value.is_empty()) {
            Some(secret) => set_secret(CLIENT_SECRET_ENTRY, secret)?,
            None => clear_secret(CLIENT_SECRET_ENTRY),
        }
        // A different application means different tokens. Keeping the old ones
        // would leave the app "connected" as an account the new client id
        // cannot act for, which fails later and confusingly.
        self.forget_authorization();
        Ok(())
    }

    pub fn set_redirect_uri(&self, uri: &str) -> Result<()> {
        let parsed = url::Url::parse(uri.trim()).context("that is not a URL")?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            bail!("the redirect must be an http or https URL");
        }
        // Loopback only. A redirect pointing anywhere else would send the
        // authorization code to a machine that is not this one.
        match parsed.host_str() {
            Some("localhost" | "127.0.0.1" | "[::1]") => {}
            _ => bail!("the redirect must point at localhost — the code comes back to this app"),
        }
        if parsed.port().is_none() {
            bail!("the redirect needs an explicit port, so this app knows where to listen");
        }
        self.db.set_setting(REDIRECT_KEY, parsed.as_str())?;
        Ok(())
    }

    fn forget_authorization(&self) {
        clear_secret(REFRESH_TOKEN_ENTRY);
        let _ = self.db.set_setting(USERNAME_KEY, "");
        let _ = self.db.set_setting(SCOPES_KEY, "");
        if let Ok(mut access) = self.access.lock() {
            *access = None;
        }
    }

    pub fn disconnect(&self) {
        self.forget_authorization();
    }

    pub fn account(&self) -> DeviantArtAccount {
        let scopes: Vec<String> = self
            .db
            .setting(SCOPES_KEY)
            .ok()
            .flatten()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect();

        DeviantArtAccount {
            configured: self.client_id().is_some(),
            connected: secret(REFRESH_TOKEN_ENTRY).is_some(),
            username: self
                .db
                .setting(USERNAME_KEY)
                .ok()
                .flatten()
                .filter(|value| !value.is_empty()),
            client_id: self.client_id(),
            redirect_uri: self.redirect_uri(),
            can_publish: scopes.iter().any(|scope| scope == "publish"),
            scopes,
        }
    }

    // -----------------------------------------------------------------------
    // Authorization
    // -----------------------------------------------------------------------

    /// Run the authorization-code flow and remember the result.
    ///
    /// The listener is bound *before* the browser opens, so a port that is
    /// already taken fails immediately rather than after someone has logged in
    /// and been redirected into nothing.
    pub async fn connect(&self, app: &AppHandle) -> Result<DeviantArtAccount> {
        use tauri_plugin_opener::OpenerExt;

        let client_id = self
            .client_id()
            .ok_or_else(|| anyhow!("no client id yet — register an app on DeviantArt first"))?;
        let redirect = self.redirect_uri();
        let parsed = url::Url::parse(&redirect).context("the stored redirect URI is not a URL")?;
        let port = parsed
            .port()
            .ok_or_else(|| anyhow!("the redirect URI needs an explicit port"))?;

        let listener = TcpListener::bind(("127.0.0.1", port)).with_context(|| {
            format!("cannot listen on port {port} — another program is using it")
        })?;

        // 32 bytes of OS randomness, base64url'd: comfortably inside the 43-128
        // character range PKCE requires, and unguessable, which is the entire
        // point of the verifier.
        let verifier = random_token(32)?;
        let challenge =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_token(16)?;

        let mut authorize = url::Url::parse(AUTHORIZE_URL)?;
        authorize
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("scope", SCOPES)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");

        app.opener()
            .open_url(authorize.as_str(), None::<&str>)
            .map_err(|error| anyhow!("cannot open the browser: {error}"))?;

        let expected = state.clone();
        let code = tauri::async_runtime::spawn_blocking(move || {
            await_code(listener, &expected, AUTHORIZE_TIMEOUT)
        })
        .await
        .map_err(|error| anyhow!("the callback listener panicked: {error}"))??;

        let secret = secret(CLIENT_SECRET_ENTRY);
        let mut form = vec![
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("client_id".to_string(), client_id),
            ("code".to_string(), code),
            ("redirect_uri".to_string(), redirect),
            ("code_verifier".to_string(), verifier),
        ];
        if let Some(secret) = secret {
            form.push(("client_secret".to_string(), secret));
        }

        let body = self.token_request(&form).await?;
        self.remember_tokens(&body)?;

        // Asked for now rather than at display time: it confirms the token
        // actually works, and it means the settings panel can say *which*
        // account is connected instead of just "connected".
        if let Ok(username) = self.whoami().await {
            let _ = self.db.set_setting(USERNAME_KEY, &username);
        }
        Ok(self.account())
    }

    async fn token_request(&self, form: &[(String, String)]) -> Result<Value> {
        let response = self
            .client
            .post(TOKEN_URL)
            .form(form)
            .send()
            .await
            .context("cannot reach DeviantArt")?;

        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("DeviantArt's reply was not JSON")?;

        if let Some(error) = body.get("error").and_then(Value::as_str) {
            let detail = body
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or(error);
            // The two failures worth naming, because the fix for each is
            // something the person has to go and do rather than retry.
            if error == "invalid_client" {
                bail!("DeviantArt rejected the client id or secret ({detail})");
            }
            if error == "invalid_grant" {
                bail!("the authorization expired or was already used ({detail}) — connect again");
            }
            bail!("DeviantArt refused the token request: {detail}");
        }
        if !status.is_success() {
            bail!("DeviantArt returned HTTP {status} for the token request");
        }
        Ok(body)
    }

    fn remember_tokens(&self, body: &Value) -> Result<()> {
        let access = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("DeviantArt's reply carried no access token"))?;

        // Refreshing may or may not rotate the refresh token. When it does not,
        // the reply simply omits it and the stored one stays valid.
        if let Some(refresh) = body.get("refresh_token").and_then(Value::as_str) {
            set_secret(REFRESH_TOKEN_ENTRY, refresh)?;
        }
        if let Some(scope) = body.get("scope").and_then(Value::as_str) {
            let _ = self.db.set_setting(SCOPES_KEY, scope);
        }

        let lifetime = body.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
        // A minute of headroom, so a token cannot expire between the check and
        // the request it was checked for.
        let expires_at = Instant::now() + Duration::from_secs(lifetime.max(120) as u64 - 60);
        *self.access.lock().expect("token mutex poisoned") = Some(Access {
            token: access.to_string(),
            expires_at,
        });
        Ok(())
    }

    /// A usable access token, refreshing if the cached one has aged out.
    async fn access_token(&self) -> Result<String> {
        // Scoped so the guard is dropped before the await below — a MutexGuard
        // held across one would make this future non-Send.
        {
            let cached = self.access.lock().expect("token mutex poisoned");
            if let Some(access) = cached.as_ref() {
                if access.expires_at > Instant::now() {
                    return Ok(access.token.clone());
                }
            }
        }

        let refresh = secret(REFRESH_TOKEN_ENTRY)
            .ok_or_else(|| anyhow!("not connected to DeviantArt yet"))?;
        let client_id = self
            .client_id()
            .ok_or_else(|| anyhow!("no client id — reconnect from the DeviantArt settings"))?;

        let mut form = vec![
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("client_id".to_string(), client_id),
            ("refresh_token".to_string(), refresh),
        ];
        if let Some(secret) = secret(CLIENT_SECRET_ENTRY) {
            form.push(("client_secret".to_string(), secret));
        }

        let body = self.token_request(&form).await.map_err(|error| {
            // DeviantArt expires refresh tokens after three months, and by then
            // nobody remembers connecting. Say what happened rather than
            // reporting a bare rejection.
            anyhow!("{error:#}. DeviantArt expires this after three months — connect again.")
        })?;
        self.remember_tokens(&body)?;

        let token = self
            .access
            .lock()
            .expect("token mutex poisoned")
            .as_ref()
            .map(|access| access.token.clone())
            .ok_or_else(|| anyhow!("the refresh produced no token"))?;
        Ok(token)
    }

    async fn whoami(&self) -> Result<String> {
        let token = self.access_token().await?;
        let response = self
            .client
            .get(format!("{API}/user/whoami"))
            .bearer_auth(token)
            .send()
            .await
            .context("cannot reach DeviantArt")?;
        let body = read_api_body(response).await?;
        body.get("username")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow!("DeviantArt did not say who you are"))
    }

    // -----------------------------------------------------------------------
    // Submitting
    // -----------------------------------------------------------------------

    /// Upload one file into Sta.sh. Returns the item id `publish` needs.
    ///
    /// Nothing is public at this point — a staged item is visible only to the
    /// account that uploaded it.
    async fn submit(
        &self,
        draft: &DeviantArtDraft,
        path: &Path,
        stack: Option<&str>,
        stack_id: Option<i64>,
    ) -> Result<(i64, Option<i64>)> {
        let token = self.access_token().await?;

        // Off the async runtime: this library lives on a network share, where
        // reading thirty megabytes is seconds of genuinely blocking I/O. Doing
        // it inline would park a tokio worker for the whole read.
        let owned = path.to_path_buf();
        let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&owned))
            .await
            .map_err(|error| anyhow!("the file read panicked: {error}"))?
            .with_context(|| format!("cannot read {}", path.display()))?;

        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "upload".to_string());

        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name)
            .mime_str(mime_of(path))?;

        let mut form = reqwest::multipart::Form::new()
            .text("title", draft.title.clone())
            .text("artist_comments", draft.description.clone())
            .text("is_ai_generated", flag(draft.is_ai_generated))
            .text("noai", flag(draft.noai))
            .part("file", part);

        // Indexed keys rather than a repeated bare name. DeviantArt's API is
        // PHP-backed, where `tags[0]` and `tags[]` both parse, and the indexed
        // form is what their own console emits — so it is the one with evidence
        // behind it.
        for (index, tag) in draft.tags.iter().enumerate() {
            form = form.text(format!("tags[{index}]"), tag.clone());
        }

        // A stack is a Sta.sh folder, and it is what makes a batch findable
        // again: DeviantArt's own "merge to multi-image" works on a selection in
        // Studio, and hunting twenty files out of a flat list to select them is
        // the whole difficulty. `stack` names a new one and only works on a
        // first submission; every later file joins it by `stackid`.
        if let Some(id) = stack_id {
            form = form.text("stackid", id.to_string());
        } else if let Some(name) = stack {
            form = form.text("stack", name.to_string());
        }

        let response = self
            .client
            .post(format!("{API}/stash/submit"))
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
            .context("the upload did not reach DeviantArt")?;

        let body = read_api_body(response).await?;
        let item_id = body
            .get("itemid")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("DeviantArt accepted the file but returned no item id"))?;
        Ok((item_id, body.get("stackid").and_then(Value::as_i64)))
    }

    /// Turn a staged item into a public deviation.
    async fn publish(&self, item_id: i64, draft: &DeviantArtDraft) -> Result<(String, String)> {
        let token = self.access_token().await?;

        let mut form = vec![
            ("itemid".to_string(), item_id.to_string()),
            ("is_mature".to_string(), flag(draft.is_mature)),
            ("is_ai_generated".to_string(), flag(draft.is_ai_generated)),
            ("noai".to_string(), flag(draft.noai)),
            // Undocumented in the current reference but required by every
            // earlier version of this endpoint, and harmless if it has since
            // been dropped — an unrecognised form field is ignored. Omitting
            // one that is still required fails the whole publish.
            ("agree_submission".to_string(), "1".to_string()),
            ("agree_tos".to_string(), "1".to_string()),
        ];

        if draft.is_mature {
            // The API rejects `is_mature` without a level, so this is not
            // optional in practice however the docs describe it.
            form.push((
                "mature_level".to_string(),
                draft.mature_level.clone().unwrap_or_else(|| "strict".to_string()),
            ));
            for (index, reason) in draft.mature_classification.iter().enumerate() {
                form.push((format!("mature_classification[{index}]"), reason.clone()));
            }
        }
        for (index, tag) in draft.tags.iter().enumerate() {
            form.push((format!("tags[{index}]"), tag.clone()));
        }

        let response = self
            .client
            .post(format!("{API}/stash/publish"))
            .bearer_auth(token)
            .form(&form)
            .send()
            .await
            .context("cannot reach DeviantArt")?;

        let body = read_api_body(response).await?;
        let url = body
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let deviation = body
            .get("deviationid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok((url, deviation))
    }

    /// Upload a whole selection, optionally publishing each as it lands.
    ///
    /// Per-item failures are rows in the summary, never an early return: one
    /// file DeviantArt rejects for its dimensions must not cost the other
    /// nineteen their upload. That is the same rule the scan pipeline follows.
    pub async fn send(
        &self,
        app: &AppHandle,
        drafts: &[DeviantArtDraft],
        publish_now: bool,
        stack: Option<&str>,
    ) -> DeviantArtSummary {
        let mut summary = DeviantArtSummary::default();
        let total = drafts.len() as i64;
        // Learned from the first upload that succeeds, then reused. Not from the
        // first *attempt*: if file one is rejected there is no stack yet, and
        // file two still has to create it or the rest land loose.
        let mut stack_id: Option<i64> = None;

        for (index, draft) in drafts.iter().enumerate() {
            let _ = app.emit(
                PROGRESS_EVENT,
                DeviantArtProgress {
                    phase: "uploading".to_string(),
                    done: index as i64,
                    total,
                    current: Some(draft.title.clone()),
                },
            );

            let mut result = DeviantArtResult {
                media_id: draft.media_id,
                title: draft.title.clone(),
                item_id: None,
                url: None,
                deviation_id: None,
                published: false,
                error: None,
            };

            // Resolved here rather than taken from the frontend: the webview
            // never names a file for the backend to read and upload.
            let path = match self.db.media_by_id(draft.media_id) {
                Ok(Some(item)) => item.path,
                Ok(None) => {
                    result.error = Some("no longer in the library".to_string());
                    summary.failed += 1;
                    summary.results.push(result);
                    continue;
                }
                Err(error) => {
                    result.error = Some(format!("{error:#}"));
                    summary.failed += 1;
                    summary.results.push(result);
                    continue;
                }
            };

            match self.submit(draft, Path::new(&path), stack, stack_id).await {
                Ok((item_id, created_stack)) => {
                    result.item_id = Some(item_id);
                    summary.staged += 1;
                    if stack_id.is_none() {
                        stack_id = created_stack;
                    }

                    if publish_now {
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            DeviantArtProgress {
                                phase: "publishing".to_string(),
                                done: index as i64,
                                total,
                                current: Some(draft.title.clone()),
                            },
                        );
                        match self.publish(item_id, draft).await {
                            Ok((url, deviation)) => {
                                result.published = true;
                                result.url = (!url.is_empty()).then_some(url);
                                result.deviation_id = (!deviation.is_empty()).then_some(deviation);
                                summary.published += 1;
                            }
                            Err(error) => {
                                // Staged but not published: the upload is not
                                // lost, it is sitting in Studio waiting. Say so,
                                // because "failed" would suggest otherwise.
                                result.error = Some(format!(
                                    "uploaded, but publishing failed: {error:#}. It is in your Studio."
                                ));
                                summary.failed += 1;
                            }
                        }
                    }
                }
                Err(error) => {
                    result.error = Some(format!("{error:#}"));
                    summary.failed += 1;
                }
            }

            summary.results.push(result);
        }

        let _ = app.emit(
            PROGRESS_EVENT,
            DeviantArtProgress {
                phase: "done".to_string(),
                done: total,
                total,
                current: None,
            },
        );
        summary
    }
}

// ---------------------------------------------------------------------------
// The callback listener
// ---------------------------------------------------------------------------

/// Wait for the browser to come back with an authorization code.
///
/// Blocking; the caller runs it off the main thread. Polled rather than left in
/// a blocking `accept`, because there has to be a way to give up: without a
/// deadline, closing the browser tab would leave this thread and the port held
/// for as long as the app runs.
fn await_code(listener: TcpListener, expected_state: &str, timeout: Duration) -> Result<String> {
    listener
        .set_nonblocking(true)
        .context("cannot configure the callback listener")?;
    let deadline = Instant::now() + timeout;

    loop {
        if Instant::now() >= deadline {
            bail!("timed out waiting for DeviantArt — the browser tab may have been closed");
        }
        match listener.accept() {
            Ok((stream, _)) => {
                // A browser fetches /favicon.ico and may probe the port before
                // following the redirect. Those carry no code, and treating one
                // as a failure would abort a flow that is going fine.
                if let Some(code) = handle_callback(stream, expected_state)? {
                    return Ok(code);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(error) => return Err(error).context("the callback listener failed"),
        }
    }
}

/// Read one request. `Ok(None)` means "not the redirect, keep waiting".
fn handle_callback(mut stream: TcpStream, expected_state: &str) -> Result<Option<String>> {
    // The listener is non-blocking and the accepted socket can inherit that,
    // which would make the read below return WouldBlock instead of waiting.
    stream.set_nonblocking(false).ok();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();

    let mut request = String::new();
    if BufReader::new(&stream).read_line(&mut request).is_err() {
        return Ok(None);
    }

    // "GET /deviantart?code=…&state=… HTTP/1.1"
    let target = request.split_whitespace().nth(1).unwrap_or("/");
    let Ok(url) = url::Url::parse(&format!("http://localhost{target}")) else {
        return Ok(None);
    };

    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = Some(value.into_owned()),
            _ => {}
        }
    }

    if let Some(error) = error {
        let detail = description.unwrap_or_else(|| error.clone());
        reply(&mut stream, "Not connected", &format!("DeviantArt said: {detail}"));
        bail!("DeviantArt refused: {detail}");
    }

    let Some(code) = code else {
        reply(&mut stream, "Waiting", "This window can be closed.");
        return Ok(None);
    };

    // The state check is the whole defence against someone else's
    // authorization code being fed to this listener. A mismatch is not a
    // retryable hiccup, so it ends the flow.
    if state.as_deref() != Some(expected_state) {
        reply(&mut stream, "Not connected", "The reply did not match this request.");
        bail!("the callback did not match the request that started it — nothing was connected");
    }

    reply(
        &mut stream,
        "Connected",
        "Luma Vault is connected to DeviantArt. You can close this tab.",
    );
    Ok(Some(code))
}

fn reply(stream: &mut TcpStream, title: &str, message: &str) {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <body style=\"font:16px system-ui;background:#18181b;color:#e4e4e7;\
         display:grid;place-items:center;height:100vh;margin:0\">\
         <main style=\"text-align:center\"><h1 style=\"font-size:18px\">{title}</h1>\
         <p style=\"color:#a1a1aa\">{message}</p></main>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Read an API reply, treating the body as authoritative about failure.
///
/// **A DeviantArt error can arrive with HTTP 200.** `stash/submit` switches to
/// chunked encoding partway through a large upload, by which point the status
/// line is already on the wire — so it answers 200 and describes the failure in
/// the body. Checking the status first would report those as successes and then
/// fail later, looking for an item id that was never issued.
async fn read_api_body(response: reqwest::Response) -> Result<Value> {
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .context("DeviantArt's reply could not be read")?;
    interpret_api_body(status, &text)
}

/// The half of [`read_api_body`] that is a decision rather than I/O.
///
/// Split out so the 200-with-an-error rule can be pinned by a plain unit test
/// instead of a mocked HTTP stack.
fn interpret_api_body(status: u16, text: &str) -> Result<Value> {
    let Ok(body) = serde_json::from_str::<Value>(text) else {
        bail!("DeviantArt returned HTTP {status} and something that was not JSON");
    };

    if let Some(error) = body.get("error").and_then(Value::as_str) {
        let detail = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        // Field-level validation comes back as a map of what was wrong with
        // which parameter, which is far more useful than the summary line.
        if let Some(details) = body.get("error_details").and_then(Value::as_object) {
            let fields: Vec<String> = details
                .iter()
                .map(|(field, message)| {
                    format!("{field}: {}", message.as_str().unwrap_or_default())
                })
                .collect();
            if !fields.is_empty() {
                bail!("{detail} ({})", fields.join("; "));
            }
        }
        bail!("{detail}");
    }

    if !(200..300).contains(&status) {
        bail!("DeviantArt returned HTTP {status}");
    }
    Ok(body)
}

/// PHP reads `1`/`0` as booleans from form data; `true`/`false` it does not.
fn flag(value: bool) -> String {
    if value { "1".to_string() } else { "0".to_string() }
}

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => "image/jpeg",
    }
}

/// `bytes` bytes of OS randomness, base64url-encoded.
///
/// From the OS CSPRNG rather than a seeded generator: a predictable code
/// verifier is exactly the thing PKCE exists to make impossible.
fn random_token(bytes: usize) -> Result<String> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|error| anyhow!("no system randomness: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer))
}

// ---------------------------------------------------------------------------
// The credential store
// ---------------------------------------------------------------------------

fn entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name)
        .map_err(|error| anyhow!("cannot reach the credential store: {error}"))
}

fn secret(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

fn set_secret(name: &str, value: &str) -> Result<()> {
    entry(name)?
        .set_password(value)
        .map_err(|error| anyhow!("cannot save to the credential store: {error}"))
}

fn clear_secret(name: &str) {
    // Best effort: "it was not there" and "it is gone now" are the same outcome
    // for a caller that is trying to disconnect.
    if let Ok(entry) = entry(name) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn booleans_go_over_the_wire_as_php_reads_them() {
        // `true`/`false` as strings are both truthy to PHP, which would make
        // `noai=false` mean the opposite of what it says.
        assert_eq!(flag(true), "1");
        assert_eq!(flag(false), "0");
    }

    #[test]
    fn a_verifier_is_long_enough_for_pkce_and_never_repeats() {
        // RFC 7636 requires 43-128 characters. 32 bytes base64url'd is 43.
        let first = random_token(32).unwrap();
        let second = random_token(32).unwrap();
        assert!(first.len() >= 43 && first.len() <= 128, "got {}", first.len());
        assert_ne!(first, second);
    }

    #[test]
    fn a_verifier_carries_no_characters_that_need_escaping() {
        // It travels as a query parameter and as a form field. base64url is
        // chosen precisely so neither encoding can alter it.
        let token = random_token(32).unwrap();
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn the_mime_type_follows_the_extension_and_defaults_to_jpeg() {
        assert_eq!(mime_of(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_of(Path::new("a.webp")), "image/webp");
        // Unknown extensions are far likelier to be a JPEG variant than
        // anything else in a library like this, and DeviantArt sniffs the
        // bytes anyway.
        assert_eq!(mime_of(Path::new("a.jfif")), "image/jpeg");
        assert_eq!(mime_of(Path::new("a")), "image/jpeg");
    }

    #[test]
    fn an_error_in_a_200_body_is_still_an_error() {
        // stash/submit answers 200 and describes the failure in the body once
        // it has switched to chunked encoding. Trusting the status would report
        // that as a success and then fail later looking for an item id that was
        // never issued.
        let error = interpret_api_body(
            200,
            r#"{"error":"invalid_request","error_description":"file is too large"}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("too large"), "got: {error}");
    }

    #[test]
    fn field_level_validation_is_reported_with_the_field() {
        // "validation failed" alone does not tell anyone what to fix.
        let error = interpret_api_body(
            400,
            r#"{"error":"invalid_request","error_description":"validation failed",
                "error_details":{"title":"is too long"}}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("title: is too long"), "got: {error}");
    }

    #[test]
    fn a_clean_body_comes_back_parsed() {
        let body = interpret_api_body(200, r#"{"status":"success","itemid":12345}"#).unwrap();
        assert_eq!(body["itemid"].as_i64(), Some(12345));
    }

    #[test]
    fn a_failing_status_with_no_error_field_still_fails() {
        // A gateway or WAF page carries no `error` key. Falling through to
        // `Ok` there would hand the caller an empty body to look for an item id
        // in, and report "returned no item id" for what is really a 502.
        let error = interpret_api_body(502, r#"{"message":"bad gateway"}"#).unwrap_err();
        assert!(error.to_string().contains("502"), "got: {error}");
    }

    #[test]
    fn a_non_json_body_names_the_status_rather_than_the_parse_error() {
        let error = interpret_api_body(503, "<html>maintenance</html>").unwrap_err();
        assert!(error.to_string().contains("503"), "got: {error}");
    }
}
