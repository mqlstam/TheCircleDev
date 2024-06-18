const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const NodeRSA = require('node-rsa');
const winston = require('winston');
const bodyParser = require('body-parser');
const path = require('path');
const { spawn } = require('child_process');
const NodeMediaServer = require('node-media-server');
const { Buffer } = require('buffer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
  }
});

// Logger configuration
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

// Middleware setup
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  credentials: true
}));
app.use(bodyParser.json());

// MongoDB setup
const mongoUrl = 'mongodb://localhost:27017/seechange';
const JWT_SECRET = 'your_secret_key'; // Replace with a strong secret

let dbClient;
const activeStreams = {}; // Declare activeStreams at the correct scope

// NodeMediaServer configuration
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
    ffmpeg: '/opt/homebrew/bin/ffmpeg', // Ensure this is the correct path to your FFmpeg binary
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=4:hls_list_size=6:hls_flags=delete_segments]',
        hlsKeepSegments: 6,
        dash: true,
        dashFlags: '[f=webm:window_size=5:extra_window_size=5]'
      }
    ]
  }
};

const nms = new NodeMediaServer(nmsConfig);
nms.run();

(async () => {
  try {
    dbClient = new MongoClient(mongoUrl);
    await dbClient.connect();
    console.log('Connected to MongoDB');
    const db = dbClient.db('seechange');
    const usersCollection = db.collection('users');
    const streamsCollection = db.collection('streams');

    // User registration
    app.post('/register', async (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const existingUser = await usersCollection.findOne({ username });
      if (existingUser) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const key = new NodeRSA({ b: 2048 });
      const privateKey = key.exportKey('private');
      const publicKey = key.exportKey('public');

      await usersCollection.insertOne({ username, password, privateKey, publicKey });
      res.status(201).json({ message: 'User registered successfully' });
    });

    // Fetch public key
    app.get('/publicKey', async (req, res) => {
      const streamName = req.query.streamName;
      if (!streamName) {
        return res.status(400).json({ error: 'Stream name is required' });
      }

      const userId = streamName.split('_')[1];
      if (!userId) {
        return res.status(404).json({ error: 'Invalid stream name' });
      }

      try {
        const user = await usersCollection.findOne({ username: userId });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        const publicKey = user.publicKey;
        if (!publicKey) {
          return res.status(404).json({ error: 'Public key not found' });
        }

        res.json({ publicKey });
      } catch (error) {
        console.error('Error retrieving public key:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Socket.io handlers
    io.on('connection', (socket) => {
      console.log('User connected');
      let streamName = null;
      let userId = null;
      let ffmpegProcess = null;

      socket.on('login', async (username, password) => {
        try {
          const user = await usersCollection.findOne({ username });
          if (user && user.password === password) {
            const token = jwt.sign({ userId: username }, JWT_SECRET);
            socket.emit('loginSuccess', token, user.privateKey);
            console.log(`User ${username} logged in`);
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
              '-f', 'image2pipe',
              '-vcodec', 'mjpeg',
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
              ffmpegProcess = null;
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

      socket.on('videoData', async (data) => {
        const { videoBlob, signature } = data;
        if (userId) {
          console.log(`Received video data for user ${userId}`);

          if (!videoBlob || !signature) {
            console.error('Received null video data or signature');
            socket.emit('streamError', 'Received null video data or signature');
            return;
          }

          try {
            const user = await usersCollection.findOne({ username: userId });
            if (!user) {
              console.error('User not found');
              socket.emit('streamError', 'User not found');
              return;
            }

            const userPublicKey = new NodeRSA(user.publicKey, 'public', { encryptionScheme: 'pkcs1' });
            const videoBuffer = Buffer.from(videoBlob); // Convert videoBlob to Buffer correctly
            const hash = crypto.createHash('sha256').update(videoBuffer).digest('base64');
            console.log(`Public key for user ${userId}:`, user.publicKey);
            console.log(`Video data hash for user ${userId}:`, hash);
            console.log(`Signature received for user ${userId}:`, signature);

            const isVerified = userPublicKey.verify(hash, Buffer.from(signature, 'base64'), 'base64', 'base64');

            if (!isVerified) {
              console.error('Signature verification failed');
              socket.emit('streamError', 'Signature verification failed');
              return;
            }

            // Forward raw video data to FFmpeg process
            if (ffmpegProcess && ffmpegProcess.stdin.writable) {
              ffmpegProcess.stdin.write(videoBuffer);
            } else {
              console.error('FFmpeg process is not writable');
              socket.emit('streamError', 'FFmpeg process is not writable');
            }
          } catch (error) {
            console.error('Error during verification or video processing:', error);
            socket.emit('streamError', 'Error during verification or video processing');
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

server.listen(3001, () => {
  console.log('Server listening on port 3001');
});

process.on('SIGINT', async () => {
  await dbClient.close();
  console.log('Disconnected from MongoDB');
  process.exit(0);
});
