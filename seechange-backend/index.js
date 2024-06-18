const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
  }
});
const NodeMediaServer = require('node-media-server');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const winston = require('winston');
const { spawn } = require('child_process');
const NodeRSA = require('node-rsa');

// Configure winston logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

// CORS Configuration
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  credentials: true
}));

// Generate RSA keys for the server
const serverPrivateKey = new NodeRSA({b: 2048});
const serverPublicKey = serverPrivateKey.exportKey('public');

// NMS Configuration
const nmsConfig = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    mediaroot: path.join(__dirname, 'media'),
    allow_origin: '*'
  },
  trans: {
    ffmpeg: '/opt/homebrew/bin/ffmpeg',
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=4:hls_list_size=6:hls_flags=delete_segments]',
        hlsKeepSegments: 6 // This keeps only the last 6 segments
      }
    ]
  }
};
const nms = new NodeMediaServer(nmsConfig);
nms.run();

// Track active streams
const activeStreams = {};
const JWT_SECRET = 'your_secret_key'; // Replace with a strong secret
const mongoUrl = 'mongodb://localhost:27017/seechange'; // Replace with your MongoDB connection string

// In-memory storage for user credentials and keys
const users = {
  'user1': { password: 'password1' },
  'user2': { password: 'password2' }
};

const userKeys = {};

// Connect to MongoDB
let dbClient;
(async () => {
  try {
    dbClient = new MongoClient(mongoUrl);
    await dbClient.connect();
    console.log('Connected to MongoDB');
    const db = dbClient.db('seechange');
    const usersCollection = db.collection('users');
    const streamsCollection = db.collection('streams');

    io.on('connection', (socket) => {
      console.log('User connected');
      let streamName = null;
      let userId = null;
      let ffmpegProcess = null;
      const frameBuffer = [];
      const MAX_BUFFER_SIZE = 100; // Example max buffer size
      let frameInterval = 40; // Assuming 25 fps

      const sendFrame = () => {
        if (frameBuffer.length > 0 && ffmpegProcess && ffmpegProcess.stdin.writable) {
          const frame = frameBuffer.shift();
          ffmpegProcess.stdin.write(frame);
        }
      };
      const frameTimer = setInterval(sendFrame, frameInterval);

      socket.on('login', async (username, password) => {
        try {
          const user = users[username];
          if (user && user.password === password) {
            // Generate RSA key pair for the user
            const key = new NodeRSA({b: 2048});
            userKeys[username] = {
              privateKey: key.exportKey('private'),
              publicKey: key.exportKey('public')
            };

            const token = jwt.sign({ userId: username }, JWT_SECRET);
            socket.emit('loginSuccess', token);
          } else {
            socket.emit('loginError', 'Invalid username or password');
          }
        } catch (error) {
          console.error('Login error:', error);
          socket.emit('loginError', 'Server error');
        }
      });

      socket.on('authenticate', (token) => {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          userId = decoded.userId;
          socket.emit('authenticationSuccess');
        } catch (error) {
          console.error('Authentication failed:', error);
          socket.emit('authenticationError', 'Invalid token');
        }
      });

      socket.on('startStream', async () => {
        if (userId) {
          streamName = `user_${userId}`;
          try {
            activeStreams[streamName] = true;
            socket.emit('streamStarted', streamName);
            io.emit('streamList', Object.keys(activeStreams));
            await streamsCollection.insertOne({
              userId: userId,
              streamName: streamName,
              startTime: new Date(),
              endTime: null
            });
            ffmpegProcess = spawn('ffmpeg', [
              '-framerate', '25',
              '-f', 'mjpeg',
              '-i', '-', // Input from stdin
              '-c:v', 'libx264',
              '-preset', 'veryfast',
              '-tune', 'zerolatency',
              '-f', 'flv',
              `rtmp://localhost/live/${streamName}`
            ]);
            ffmpegProcess.stderr.on('data', (data) => {
              console.error(`FFmpeg stderr: ${data}`);
            });
            ffmpegProcess.on('close', (code) => {
              console.log(`FFmpeg process exited with code ${code}`);
              frameBuffer.length = 0;
            });
            console.log(`Stream started: ${streamName}`);
          } catch (error) {
            console.error('Error starting stream:', error);
            socket.emit('streamError', 'Error starting stream');
          }
        } else {
          socket.emit('authenticationError', 'Not authenticated');
        }
      });

      socket.on('stopStream', async () => {
        if (streamName) {
          try {
            delete activeStreams[streamName];
            socket.emit('streamStopped', streamName);
            io.emit('streamList', Object.keys(activeStreams));
            if (ffmpegProcess) {
              ffmpegProcess.stdin.end();
              ffmpegProcess.kill('SIGINT');
            }
            await streamsCollection.updateOne(
              { streamName: streamName },
              { $set: { endTime: new Date() } }
            );
          } catch (error) {
            console.error('Error stopping stream:', error);
            socket.emit('streamError', 'Error stopping stream');
          }
        }
      });

      socket.on('videoData', (encryptedData, checksum) => {
        if (userId) {
          if (!encryptedData) {
            console.error('Received null video data');
            socket.emit('streamError', 'Received null video data');
            return;
          }
          try {
            const user = users[userId];
            const clientPrivateKey = new NodeRSA(userKeys[userId].privateKey, 'pkcs1-private-pem'); // Specify format
            const binaryData = Buffer.from(clientPrivateKey.decrypt(encryptedData, 'base64'), 'base64');
            const receivedChecksum = crypto.createHash('sha256').update(binaryData).digest('hex');
            if (receivedChecksum !== checksum) {
              console.error('Checksum mismatch');
              socket.emit('streamError', 'Checksum mismatch');
              return;
            }
            if (frameBuffer.length < MAX_BUFFER_SIZE) {
              frameBuffer.push(binaryData);
            } else {
              console.warn('Frame buffer is full, dropping frame');
            }
          } catch (error) {
            console.error('Error sending video data:', error);
            logger.error('Error sending video data:', error);
            socket.emit('streamError', 'Error sending video data');
          }
        } else {
          socket.emit('authenticationError', 'Not authenticated');
        }
      });

      socket.on('disconnect', async () => {
        if (streamName) {
          try {
            delete activeStreams[streamName];
            io.emit('streamList', Object.keys(activeStreams));
            if (ffmpegProcess) {
              ffmpegProcess.stdin.end();
              ffmpegProcess.kill('SIGINT');
            }
            await streamsCollection.updateOne(
              { streamName: streamName },
              { $set: { endTime: new Date() } }
            );
          } catch (error) {
            console.error('Error stopping stream on disconnect:', error);
          }
        }
        console.log('User disconnected');
      });
    });
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
  }
})();

http.listen(3001, () => {
  console.log('Server listening on port 3001');
});

process.on('SIGINT', async () => {
  await dbClient.close();
  console.log('Disconnected from MongoDB');
  process.exit(0);
});
