const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 存储在线用户
const users = new Map();

// Socket.io 连接处理
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);

    // 用户加入聊天室
    socket.on('join', (username) => {
        if (!username || username.trim() === '') {
            socket.emit('error', '用户名不能为空');
            return;
        }

        // 检查用户名是否已存在
        const existingUser = Array.from(users.values()).find(user => user.username === username);
        if (existingUser) {
            socket.emit('error', '用户名已存在，请选择其他用户名');
            return;
        }

        // 添加用户
        users.set(socket.id, {
            username: username,
            joinTime: new Date()
        });

        socket.username = username;

        // 通知所有用户有新用户加入
        socket.broadcast.emit('user-joined', {
            username: username,
            timestamp: new Date()
        });

        // 发送用户列表给新用户
        socket.emit('user-list', Array.from(users.values()).map(user => user.username));

        // 发送欢迎消息
        socket.emit('message', {
            username: '系统',
            message: `欢迎 ${username} 加入聊天室！`,
            timestamp: new Date(),
            type: 'system'
        });

        console.log(`用户 ${username} 加入聊天室`);
    });

    // 处理消息
    socket.on('message', (data) => {
        if (!socket.username) {
            socket.emit('error', '请先加入聊天室');
            return;
        }

        const messageData = {
            username: socket.username,
            message: data.message,
            timestamp: new Date(),
            type: 'user'
        };

        // 广播消息给所有用户
        io.emit('message', messageData);
        console.log(`${socket.username}: ${data.message}`);
    });

    // 用户正在输入
    socket.on('typing', () => {
        if (socket.username) {
            socket.broadcast.emit('typing', socket.username);
        }
    });

    // 用户停止输入
    socket.on('stop-typing', () => {
        if (socket.username) {
            socket.broadcast.emit('stop-typing', socket.username);
        }
    });

    // 用户断开连接
    socket.on('disconnect', () => {
        if (socket.username) {
            users.delete(socket.id);
            
            // 通知其他用户有用户离开
            socket.broadcast.emit('user-left', {
                username: socket.username,
                timestamp: new Date()
            });

            console.log(`用户 ${socket.username} 离开聊天室`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`聊天室服务器运行在 http://localhost:${PORT}`);
}); 