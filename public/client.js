// WebSocket 连接
let socket;
let isConnected = false;

// DOM 元素
const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const loginError = document.getElementById('login-error');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const messages = document.getElementById('messages');
const userList = document.getElementById('user-list');
const onlineCount = document.getElementById('online-count');
const typingIndicator = document.getElementById('typing-indicator');
const logoutBtn = document.getElementById('logout-btn');
const sendBtn = document.getElementById('send-btn');

// 状态变量
let currentUsername = '';
let typingTimer;
let isTyping = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    usernameInput.focus();
});

// WebSocket 连接函数
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        console.log('WebSocket 连接成功');
        isConnected = true;
        reconnectAttempts = 0;
        
        // 如果有用户名，重新加入
        if (currentUsername) {
            sendMessage({
                type: 'join',
                username: currentUsername
            });
        }
    };
    
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        } catch (e) {
            console.error('解析服务器消息失败:', e);
        }
    };
    
    socket.onclose = () => {
        console.log('WebSocket 连接关闭');
        isConnected = false;
        
        if (chatScreen.classList.contains('hidden')) {
            return; // 如果还在登录页面，不需要重连
        }
        
        addSystemMessage('与服务器断开连接，正在尝试重新连接...', new Date());
        
        // 自动重连
        if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            setTimeout(() => {
                console.log(`尝试重新连接 (${reconnectAttempts}/${maxReconnectAttempts})`);
                connectWebSocket();
            }, 2000 * reconnectAttempts);
        } else {
            addSystemMessage('重连失败，请刷新页面重试', new Date());
        }
    };
    
    socket.onerror = (error) => {
        console.error('WebSocket 错误:', error);
    };
}

// 发送消息到服务器
function sendMessage(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

// 处理服务器消息
function handleServerMessage(data) {
    switch (data.type) {
        case 'user-list':
            loginScreen.classList.add('hidden');
            chatScreen.classList.remove('hidden');
            messageInput.focus();
            updateUserList(data.users);
            updateOnlineCount(data.users.length);
            break;
            
        case 'message':
            addMessage(data);
            break;
            
        case 'user-joined':
            addSystemMessage(`${data.username} 加入了聊天室`, new Date(data.timestamp));
            // 用户列表会通过其他消息更新
            break;
            
        case 'user-left':
            addSystemMessage(`${data.username} 离开了聊天室`, new Date(data.timestamp));
            // 更新用户列表
            const userItems = userList.querySelectorAll('.user-item');
            userItems.forEach(item => {
                if (item.textContent.includes(data.username)) {
                    item.remove();
                }
            });
            updateOnlineCount(userList.children.length);
            break;
            
        case 'typing':
            showTypingIndicator(data.username);
            break;
            
        case 'stop-typing':
            hideTypingIndicator(data.username);
            break;
            
        case 'error':
            loginError.textContent = data.message;
            usernameInput.focus();
            break;
    }
}

// 登录处理
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    
    if (username) {
        currentUsername = username;
        
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connectWebSocket();
            // 等待连接建立后再发送加入消息
            socket.addEventListener('open', () => {
                sendMessage({
                    type: 'join',
                    username: username
                });
            }, { once: true });
        } else {
            sendMessage({
                type: 'join',
                username: username
            });
        }
        
        loginError.textContent = '';
    }
});

// 消息发送处理
messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = messageInput.value.trim();
    
    if (message && isConnected) {
        sendMessage({
            type: 'message',
            message: message
        });
        messageInput.value = '';
        stopTyping();
    }
});

// 输入状态处理
messageInput.addEventListener('input', () => {
    if (!isTyping && isConnected) {
        isTyping = true;
        sendMessage({ type: 'typing' });
    }
    
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        stopTyping();
    }, 1000);
});

messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        messageForm.dispatchEvent(new Event('submit'));
    }
});

// 停止输入
function stopTyping() {
    if (isTyping && isConnected) {
        isTyping = false;
        sendMessage({ type: 'stop-typing' });
    }
    clearTimeout(typingTimer);
}

// 退出登录
logoutBtn.addEventListener('click', () => {
    if (socket) {
        socket.close();
    }
    location.reload();
});

// 工具函数

// 添加消息
function addMessage(data) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${data.msg_type === 'system' ? 'system' : (data.username === currentUsername ? 'own' : '')}`;
    
    const time = formatTime(new Date(data.timestamp));
    
    if (data.msg_type === 'system') {
        messageDiv.innerHTML = `
            <div class="message-content">${escapeHtml(data.message)}</div>
        `;
    } else {
        messageDiv.innerHTML = `
            <div class="message-header">
                <span class="message-username">${escapeHtml(data.username)}</span>
                <span class="message-time">${time}</span>
            </div>
            <div class="message-content">${escapeHtml(data.message)}</div>
        `;
    }
    
    messages.appendChild(messageDiv);
    scrollToBottom();
}

// 添加系统消息
function addSystemMessage(message, timestamp) {
    addMessage({
        username: '系统',
        message: message,
        timestamp: timestamp.getTime(),
        msg_type: 'system'
    });
}

// 更新用户列表
function updateUserList(users) {
    userList.innerHTML = '';
    users.forEach(username => {
        const userDiv = document.createElement('div');
        userDiv.className = 'user-item';
        userDiv.innerHTML = `
            <i class="fas fa-circle"></i>
            <span>${escapeHtml(username)}</span>
        `;
        userList.appendChild(userDiv);
    });
    updateOnlineCount(users.length);
}

// 更新在线人数
function updateOnlineCount(count) {
    onlineCount.textContent = count;
}

// 显示输入指示器
function showTypingIndicator(username) {
    if (username === currentUsername) return; // 不显示自己的输入状态
    
    const existingIndicator = typingIndicator.querySelector(`[data-user="${username}"]`);
    if (!existingIndicator) {
        const indicator = document.createElement('span');
        indicator.textContent = `${username} 正在输入...`;
        indicator.setAttribute('data-user', username);
        typingIndicator.appendChild(indicator);
    }
}

// 隐藏输入指示器
function hideTypingIndicator(username) {
    const indicator = typingIndicator.querySelector(`[data-user="${username}"]`);
    if (indicator) {
        indicator.remove();
    }
}

// 滚动到底部
function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
}

// 格式化时间
function formatTime(date) {
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 页面可见性变化处理
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && messageInput) {
        messageInput.focus();
    }
});

// 窗口大小变化处理
window.addEventListener('resize', () => {
    if (messages) {
        scrollToBottom();
    }
});

// 防止页面刷新时丢失连接
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.close();
    }
});

// 页面加载时建立连接
connectWebSocket(); 