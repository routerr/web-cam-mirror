use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use futures_util::{StreamExt, SinkExt};
use serde::Deserialize;
use local_ip_address::local_ip;

#[derive(Deserialize)]
struct RegisterMsg {
    #[serde(rename = "type")]
    msg_type: String,
    role: String,
}

struct Peer {
    tx: tokio::sync::mpsc::UnboundedSender<Message>,
}

#[derive(Default)]
struct ServerState {
    sender: Option<Peer>,
    receiver: Option<Peer>,
}

type SharedState = Arc<Mutex<ServerState>>;

async fn handle_connection(stream: tokio::net::TcpStream, state: SharedState) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("Error during websocket handshake: {}", e);
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    // Spawn task to forward internal channel messages to the websocket client
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut my_role = None;

    // Read the first message to register
    if let Some(Ok(Message::Text(text))) = ws_rx.next().await {
        if let Ok(reg) = serde_json::from_str::<RegisterMsg>(&text) {
            if reg.msg_type == "register" {
                let mut s = state.lock().await;
                if reg.role == "sender" {
                    s.sender = Some(Peer { tx: tx.clone() });
                    my_role = Some("sender");
                    println!("WebRTC signaling: Sender (iPhone) registered.");
                    // If receiver is present, notify the sender
                    if let Some(ref rec) = s.receiver {
                        let _ = rec.tx.send(Message::Text(r#"{"type":"peer_connected","role":"sender"}"#.to_string()));
                    }
                } else if reg.role == "receiver" {
                    s.receiver = Some(Peer { tx: tx.clone() });
                    my_role = Some("receiver");
                    println!("WebRTC signaling: Receiver (Tauri) registered.");
                    // Notify the sender
                    if let Some(ref send) = s.sender {
                        let _ = send.tx.send(Message::Text(r#"{"type":"peer_connected","role":"receiver"}"#.to_string()));
                    }
                }
            }
        }
    }

    if my_role.is_none() {
        return; // Registration failed
    }

    // Main loop: forward messages between sender and receiver
    while let Some(result) = ws_rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_text() || msg.is_binary() {
                    let s = state.lock().await;
                    if my_role == Some("sender") {
                        if let Some(ref rec) = s.receiver {
                            let _ = rec.tx.send(msg);
                        }
                    } else if my_role == Some("receiver") {
                        if let Some(ref send) = s.sender {
                            let _ = send.tx.send(msg);
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }

    // Cleanup on disconnect
    let mut s = state.lock().await;
    if my_role == Some("sender") {
        s.sender = None;
        println!("WebRTC signaling: Sender disconnected.");
        if let Some(ref rec) = s.receiver {
            let _ = rec.tx.send(Message::Text(r#"{"type":"peer_disconnected","role":"sender"}"#.to_string()));
        }
    } else if my_role == Some("receiver") {
        s.receiver = None;
        println!("WebRTC signaling: Receiver disconnected.");
        if let Some(ref send) = s.sender {
            let _ = send.tx.send(Message::Text(r#"{"type":"peer_disconnected","role":"receiver"}"#.to_string()));
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    local_ip()
        .map(|ip| ip.to_string())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn set_always_on_top(window: tauri::Window, always_on_top: bool) -> Result<(), String> {
    window.set_always_on_top(always_on_top).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_app(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = SharedState::default();
    tauri::async_runtime::spawn(async move {
        let addr = "0.0.0.0:5175";
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind WebSocket server to {}: {}", addr, e);
                return;
            }
        };
        println!("WebRTC WebSocket signaling server listening on: ws://{}", addr);

        while let Ok((stream, _)) = listener.accept().await {
            let state = state.clone();
            tokio::spawn(handle_connection(stream, state));
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_local_ip, set_always_on_top, close_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
