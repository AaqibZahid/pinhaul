//! A fixture server for integration tests.
//!
//! It answers canned responses and records what it was asked, so the tests can
//! drive discovery, pagination, sections, downloads and failure handling against
//! the same request code the binary uses, without touching live Pinterest and
//! without any credentials in the repository.
//!
//! Each test binary includes this module separately and uses a different subset
//! of the helpers, so shared ones may be unused in a given binary.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

/// One canned answer: the status, the headers, and the body.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(value: serde_json::Value) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
            body: value.to_string().into_bytes(),
        }
    }

    pub fn body(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

/// A request the fixture server was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
}

impl Request {
    /// The request's path without its query string.
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Whether the body responded to a `Range: bytes=n-` request.
    pub fn range_start(&self) -> Option<u64> {
        let raw = self.header("range")?;
        let (_, start) = raw.split_once('=')?;
        let start = start.strip_suffix('-').unwrap_or(start);
        start.trim().parse().ok()
    }
}

/// The fixture server, and the record of what it was asked.
pub struct Fixture {
    base: String,
    request_log: Arc<Mutex<Vec<Request>>>,
    queue: Arc<Mutex<VecDeque<Reply>>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // The listener thread holds no shared state worth joining, and the port
        // is released by the OS once this process exits.
    }
}

impl Fixture {
    /// Starts a fixture server whose first answer is `first`. Later calls add
    /// answers in order; the last answer repeats.
    pub fn start(first: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().unwrap().port();
        let request_log = Arc::new(Mutex::new(Vec::new()));
        let queue = Arc::new(Mutex::new(VecDeque::from([first])));

        let log = Arc::clone(&request_log);
        let answers = Arc::clone(&queue);
        thread::spawn(move || serve(listener, log, answers));
        Self {
            base: format!("http://127.0.0.1:{port}"),
            request_log,
            queue,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Queues the next answer, for a scripted sequence of responses.
    pub fn then(&self, reply: Reply) -> &Self {
        self.queue.lock().unwrap().push_back(reply);
        self
    }

    pub fn requests(&self) -> Vec<Request> {
        self.request_log.lock().unwrap().clone()
    }

    pub fn request_count(&self) -> usize {
        self.request_log.lock().unwrap().len()
    }

    /// How many requests carried a byte range.
    pub fn ranged_request_count(&self) -> usize {
        self.request_log
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.range_start().is_some())
            .count()
    }
}

/// Serves one request per accepted connection, which is what a test needs.
fn serve(listener: TcpListener, log: Arc<Mutex<Vec<Request>>>, queue: Arc<Mutex<VecDeque<Reply>>>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let log = Arc::clone(&log);
        let queue = Arc::clone(&queue);
        thread::spawn(move || handle(stream, log, queue));
    }
}

fn handle(
    mut stream: TcpStream,
    log: Arc<Mutex<Vec<Request>>>,
    queue: Arc<Mutex<VecDeque<Reply>>>,
) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    });
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default().to_owned();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let line = line.trim_end_matches(['\r', '\n']).to_owned();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        let _ = reader.read(&mut body);
    }

    log.lock().unwrap().push(Request {
        method,
        target,
        headers,
    });

    let reply = {
        let mut answers = queue.lock().unwrap();
        if answers.len() > 1 {
            answers.pop_front().unwrap()
        } else {
            answers.front().cloned().unwrap_or_else(|| Reply::body(""))
        }
    };
    let status_line = match reply.status {
        200 => "200 OK",
        206 => "206 Partial Content",
        400 => "400 Bad Request",
        403 => "403 Forbidden",
        404 => "404 Not Found",
        416 => "416 Range Not Satisfiable",
        429 => "429 Too Many Requests",
        500 => "500 Internal Server Error",
        502 => "502 Bad Gateway",
        503 => "503 Service Unavailable",
        504 => "504 Gateway Timeout",
        other => return write_status(&mut stream, other),
    };
    let mut response = format!("HTTP/1.1 {status_line}\r\n");
    for (name, value) in &reply.headers {
        if name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str(&format!("Content-Length: {}\r\n", reply.body.len()));
    response.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(&reply.body);
    let _ = stream.flush();
}

fn write_status(stream: &mut TcpStream, status: u16) {
    let _ = stream.write_all(
        format!("HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
    );
    let _ = stream.flush();
}

/// A scratch directory that is removed when the test finishes.
pub fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pinpull-int-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A successful Pinterest resource response.
pub fn resource_response(data: serde_json::Value) -> Reply {
    Reply::json(serde_json::json!({"resource_response": {"status": "success", "data": data}}))
}

/// A paged resource response with a bookmark.
pub fn resource_page(data: serde_json::Value, bookmark: &str) -> Reply {
    Reply::json(
        serde_json::json!({"resource_response": {"status": "success", "data": data, "bookmark": bookmark}}),
    )
}

/// A pin that Pinterest permits to be downloaded.
pub fn image_pin(id: &str, url: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "is_eligible_for_image_download": true,
        "images": {
            "orig": {"url": url, "width": 1989, "height": 3000}
        }
    })
}

/// A pin page as Pinterest serves one: the pin's record registered behind the
/// relay global, which is where pin detail actually comes from.
pub fn pin_page(pin: serde_json::Value) -> Reply {
    let html = format!(
        r#"<script nonce="n" type="text/javascript">window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%22queryID%22%3A%221%22%7D", {{"data":{{"v3GetPinQueryv2":{{"__typename":"PinResponse","data":{}}}}}}})</script>"#,
        pin
    );
    Reply::body(html)
}
