use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use dashmap::DashMap;
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};
use uuid::Uuid;

// 消息类型定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "join")]
    Join { username: String },
    #[serde(rename = "message")]
    Message { message: String },
    #[serde(rename = "typing")]
    Typing,
    #[serde(rename = "stop-typing")]
    StopTyping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageData {
    pub username: String,
    pub message: String,
    pub timestamp: u64,
    #[serde(rename = "type")]
    pub msg_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "user-list")]
    UserList { users: Vec<String> },
    #[serde(rename = "message")]
    Message(MessageData),
    #[serde(rename = "user-joined")]
    UserJoined { username: String, timestamp: u64 },
    #[serde(rename = "user-left")]
    UserLeft { username: String, timestamp: u64 },
    #[serde(rename = "typing")]
    Typing { username: String },
    #[serde(rename = "stop-typing")]
    StopTyping { username: String },
    #[serde(rename = "error")]
    Error { message: String },
}

// 用户信息
#[derive(Debug, Clone)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub join_time: u64,
}

// 应用状态
#[derive(Clone)]
pub struct AppState {
    pub users: Arc<DashMap<Uuid, User>>,
    pub tx: broadcast::Sender<ServerMessage>,
}

impl AppState {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1000);
        Self {
            users: Arc::new(DashMap::new()),
            tx,
        }
    }

    pub fn add_user(&self, username: String) -> Result<User, String> {
        // 检查用户名是否已存在
        for entry in self.users.iter() {
            if entry.value().username == username {
                return Err("用户名已存在，请选择其他用户名".to_string());
            }
        }

        let user = User {
            id: Uuid::new_v4(),
            username: username.clone(),
            join_time: current_timestamp(),
        };

        self.users.insert(user.id, user.clone());
        info!("用户 {} 加入聊天室", username);

        // 通知其他用户
        let _ = self.tx.send(ServerMessage::UserJoined {
            username: username.clone(),
            timestamp: current_timestamp(),
        });

        Ok(user)
    }

    pub fn remove_user(&self, user_id: Uuid) {
        if let Some((_, user)) = self.users.remove(&user_id) {
            info!("用户 {} 离开聊天室", user.username);
            
            // 通知其他用户
            let _ = self.tx.send(ServerMessage::UserLeft {
                username: user.username,
                timestamp: current_timestamp(),
            });
        }
    }

    pub fn get_user_list(&self) -> Vec<String> {
        self.users.iter().map(|entry| entry.value().username.clone()).collect()
    }

    pub fn broadcast_message(&self, message: ServerMessage) {
        let _ = self.tx.send(message);
    }
}

// 获取当前时间戳
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// WebSocket 处理器
async fn websocket_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (sender, mut receiver) = socket.split();
    let mut user_id: Option<Uuid> = None;
    let mut username: Option<String> = None;

    // 使用 channel 来发送消息到发送任务
    let (tx_to_sender, mut rx_from_handler) = tokio::sync::mpsc::unbounded_channel::<String>();

    // 创建广播接收器
    let mut rx_broadcast = state.tx.subscribe();
    let tx_to_sender_clone = tx_to_sender.clone();

    // 处理广播消息的任务
    let broadcast_task = tokio::spawn(async move {
        while let Ok(msg) = rx_broadcast.recv().await {
            let json = match serde_json::to_string(&msg) {
                Ok(json) => json,
                Err(e) => {
                    error!("序列化消息失败: {}", e);
                    continue;
                }
            };
            
            if tx_to_sender_clone.send(json).is_err() {
                break;
            }
        }
    });

    // 发送消息的任务
    let mut sender = sender;
    let send_task = tokio::spawn(async move {
        while let Some(json) = rx_from_handler.recv().await {
            if sender.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // 处理客户端消息
    while let Some(msg) = receiver.next().await {
        let msg = match msg {
            Ok(msg) => msg,
            Err(e) => {
                warn!("WebSocket 消息错误: {}", e);
                break;
            }
        };

        match msg {
            Message::Text(text) => {
                let client_msg: ClientMessage = match serde_json::from_str(&text) {
                    Ok(msg) => msg,
                    Err(e) => {
                        error!("解析客户端消息失败: {}", e);
                        continue;
                    }
                };

                match client_msg {
                    ClientMessage::Join { username: new_username } => {
                        if new_username.trim().is_empty() {
                            let error_msg = ServerMessage::Error {
                                message: "用户名不能为空".to_string(),
                            };
                            let json = serde_json::to_string(&error_msg).unwrap();
                            let _ = tx_to_sender.send(json);
                            continue;
                        }

                        match state.add_user(new_username.clone()) {
                            Ok(user) => {
                                user_id = Some(user.id);
                                username = Some(user.username.clone());

                                                                // 发送用户列表
                                let user_list_msg = ServerMessage::UserList {
                                    users: state.get_user_list(),
                                };
                                let json = serde_json::to_string(&user_list_msg).unwrap();
                                let _ = tx_to_sender.send(json);

                                // 发送欢迎消息
                                let welcome_msg = ServerMessage::Message(MessageData {
                                    username: "系统".to_string(),
                                    message: format!("欢迎 {} 加入聊天室！", user.username),
                                    timestamp: current_timestamp(),
                                    msg_type: "system".to_string(),
                                });
                                let json = serde_json::to_string(&welcome_msg).unwrap();
                                let _ = tx_to_sender.send(json);
                            }
                            Err(error) => {
                                let error_msg = ServerMessage::Error {
                                    message: error,
                                };
                                let json = serde_json::to_string(&error_msg).unwrap();
                                let _ = tx_to_sender.send(json);
                            }
                        }
                    }
                    ClientMessage::Message { message } => {
                        if let Some(ref user_name) = username {
                            let msg = ServerMessage::Message(MessageData {
                                username: user_name.clone(),
                                message,
                                timestamp: current_timestamp(),
                                msg_type: "user".to_string(),
                            });
                            state.broadcast_message(msg);
                        }
                    }
                    ClientMessage::Typing => {
                        if let Some(ref user_name) = username {
                            let msg = ServerMessage::Typing {
                                username: user_name.clone(),
                            };
                            state.broadcast_message(msg);
                        }
                    }
                    ClientMessage::StopTyping => {
                        if let Some(ref user_name) = username {
                            let msg = ServerMessage::StopTyping {
                                username: user_name.clone(),
                            };
                            state.broadcast_message(msg);
                        }
                    }
                }
            }
            Message::Close(_) => {
                info!("WebSocket 连接关闭");
                break;
            }
            _ => {}
        }
    }

    // 清理用户
    if let Some(id) = user_id {
        state.remove_user(id);
    }

    broadcast_task.abort();
    send_task.abort();
}

// 主页路由
async fn index() -> Html<&'static str> {
    Html(include_str!("../public/index.html"))
}

// CSS 文件路由
async fn style_css() -> impl IntoResponse {
    let css_content = include_str!("../public/style.css");
    (
        [("content-type", "text/css")],
        css_content
    )
}

// JS 文件路由
async fn client_js() -> impl IntoResponse {
    let js_content = include_str!("../public/client.js");
    (
        [("content-type", "application/javascript")],
        js_content
    )
}

#[tokio::main]
async fn main() {
    // 初始化日志
    tracing_subscriber::fmt::init();

    let state = AppState::new();

    // 构建路由
    let app = Router::new()
        .route("/", get(index))
        .route("/style.css", get(style_css))
        .route("/client.js", get(client_js))
        .route("/ws", get(websocket_handler))
        .layer(
            ServiceBuilder::new()
                .layer(CorsLayer::permissive())
        )
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    info!("聊天室服务器运行在 http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
} 