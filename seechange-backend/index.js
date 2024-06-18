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

// Secret key for JWT (Replace with a strong secret)
const JWT_SECRET = 'your_secret_key';

// MongoDB connection URL (Replace with your MongoDB connection string)
const mongoUrl = 'mongodb://localhost:27017/seechange';

// Connect to MongoDB
let dbClient;
(async () => {
  try {
    dbClient = new MongoClient(mongoUrl);
    await dbClient.connect();
    console.log('Connected to MongoDB');

    // Access the database and collection
    const db = dbClient.db('seechange');
    const usersCollection = db.collection('users');
    const streamsCollection = db.collection('streams');

    // In-memory user credentials (replace with a database in a real application)
    const users = {
      'user1': { password: 'password1' },
      'user2': { password: 'password2' }
    };

    // Socket.io Connection
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
            // Generate JWT
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
      
            // Start ffmpeg process
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
              // Clean up
              frameBuffer.length = 0;
            });
      
            // Verify the stream start
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

            // Stop ffmpeg process
            if (ffmpegProcess) {
              ffmpegProcess.stdin.end();
              ffmpegProcess.kill('SIGINT');
            }

            // Update stream metadata in MongoDB
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

      socket.on('videoData', (videoData, checksum) => {
        if (userId) {
          if (!videoData) {
            console.error('Received null video data');
            socket.emit('streamError', 'Received null video data');
            return;
          }

          try {
            const binaryData = Buffer.from(videoData.split(',')[1], 'base64');
            const receivedChecksum = crypto.createHash('sha256').update(binaryData).digest('hex');
            // logger.info(`Received checksum: ${receivedChecksum}, Expected checksum: ${checksum}`);

            // Add frame to buffer if there's space
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

            // Stop ffmpeg process
            if (ffmpegProcess) {
              ffmpegProcess.stdin.end();
              ffmpegProcess.kill('SIGINT');
            }

            // Update stream metadata in MongoDB
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

// Start HTTP server
http.listen(3001, () => {
  console.log('Server listening on port 3001');
});

// Close MongoDB connection on server shutdown
process.on('SIGINT', async () => {
  await dbClient.close();
  console.log('Disconnected from MongoDB');
  process.exit(0);
});
