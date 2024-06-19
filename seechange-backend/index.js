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
    origin: ["http://localhost:3000", "http://localhost:4200"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
  }
});

// Logger Configuration
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

// Middleware Setup
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:4200'], // Add Angular's origin
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  credentials: true 
}));
app.use(bodyParser.json());

// MongoDB Setup
const mongoUrl = 'mongodb://localhost:27017/seechange';
const JWT_SECRET = 'your_secret_key'; // **Replace with a strong, randomly generated secret**

let dbClient;
const activeStreams = {};

// NodeMediaServer Configuration
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
    ffmpeg: '/opt/homebrew/bin/ffmpeg', // **Adjust the path for your system**
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=10:hls_list_size=4:hls_flags=delete_segments]', // Set hls_time to 10         hlsKeepSegments: 4,
        hlsKeepSegments: 4,
    }
    ]
  }
};

const nms = new NodeMediaServer(nmsConfig);
nms.run();

(async () => {
  try {
    // Database Connection
    dbClient = new MongoClient(mongoUrl);
    await dbClient.connect();
    console.log('Connected to MongoDB');
    const db = dbClient.db('seechange');
    const usersCollection = db.collection('users');
    const streamsCollection = db.collection('streams');

    // User Registration 
    app.post('/register', async (req, res) => {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      try {
        const existingUser = await usersCollection.findOne({ username });
        if (existingUser) {
          return res.status(409).json({ error: 'User already exists' }); // Use 409 (Conflict)
        }

        const key = new NodeRSA({ b: 2048 });
        const privateKey = key.exportKey('private');
        const publicKey = key.exportKey('public');

        await usersCollection.insertOne({ username, password, privateKey, publicKey });
        res.status(201).json({ message: 'User registered successfully' }); // Use 201 (Created)
      } catch (error) {
        logger.error('Registration Error:', error); // Log the error for debugging
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    // Fetch Public Key
    app.get('/publicKey', async (req, res) => {
      const streamName = req.query.streamName;
      if (!streamName) {
        return res.status(400).json({ error: 'Stream name is required' }); 
      }

      const userId = streamName.split('_')[1]; 
      if (!userId) {
        return res.status(400).json({ error: 'Invalid stream name' }); 
      }

      try {
        const user = await usersCollection.findOne({ username: userId });
        if (!user) {
          return res.status(404).json({ error: 'User not found' }); 
        }

        const publicKey = user.publicKey;
        if (!publicKey) {
          return res.status(500).json({ error: 'Public key not found for user' });
        }

        res.json({ publicKey }); 
      } catch (error) {
        logger.error('Public Key Retrieval Error:', error);
        res.status(500).json({ error: 'Internal Server Error' }); 
      }
    });

    // Socket.io Connection Handler
    io.on('connection', (socket) => {
      console.log('User connected'); 
      let streamName = null;
      let userId = null;
      let ffmpegProcess = null;

        // Emit the current stream list to the newly connected client
  socket.emit('streamList', Object.keys(activeStreams)); 

      // Login Handler
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
          logger.error('Login Error:', error); 
          socket.emit('loginError', 'Server error'); 
        }
      });

      // Authentication Handler (after successful login)
      socket.on('authenticate', (token) => {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          userId = decoded.userId;
          socket.emit('authenticationSuccess'); 
        } catch (error) {
          logger.error('Authentication failed:', error); 
          socket.emit('authenticationError', 'Invalid token'); 
        }
      });

      // Start Stream Handler
      socket.on('startStream', async () => {
        if (!userId) {
          return socket.emit('authenticationError', 'Not authenticated'); 
        }

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

          // Start FFmpeg Process
          ffmpegProcess = spawn('ffmpeg', [
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-i', '-', 
            '-c:v', 'libx264',
            '-preset', 'ultrafast', // Prioritize speed over compression
            '-tune', 'zerolatency',
            '-crf', '18',          // Lower quality, higher speed 
            '-f', 'flv',
            `rtmp://localhost/live/${streamName}`
          ]);

          // FFmpeg Error Handling
          ffmpegProcess.stderr.on('data', (data) => {
            console.error(`FFmpeg stderr: ${data}`); 
          });

          ffmpegProcess.on('error', (error) => {
            console.error('FFmpeg process error:', error); 
            socket.emit('streamError', 'Error starting FFmpeg process'); 
          });

          ffmpegProcess.on('close', (code) => {
            console.log(`FFmpeg process exited with code ${code}`);
            ffmpegProcess = null; 
          });

          console.log(`Stream started: ${streamName}`); 

           // Emit updated stream list to all connected clients
           io.emit('streamList', Object.keys(activeStreams));  
  
        } catch (error) {
          logger.error('Stream Start Error:', error); 
          socket.emit('streamError', 'Error starting stream'); 
        }
      });

      

      // Video Data Batch Handler
      socket.on('videoDataBatch', async (batch) => {
        if (!userId) {
          return socket.emit('authenticationError', 'Not authenticated'); 
        }

        try {
          console.log(`Received video data batch from user ${userId}`);

          // Batch Verification
          const userPublicKey = new NodeRSA((await usersCollection.findOne({ username: userId })).publicKey, 'public', { encryptionScheme: 'pkcs1' });
          for (const frameData of batch) {
            const { videoBlob, signature } = frameData;

            if (!videoBlob || !signature) {
              console.error('Invalid data in batch'); 
              return socket.emit('streamError', 'Invalid data in batch'); 
            }

            const videoBuffer = Buffer.from(videoBlob); 
            const hash = crypto.createHash('sha256').update(videoBuffer).digest('base64');
            const isVerified = userPublicKey.verify(hash, Buffer.from(signature, 'base64'), 'utf8', 'base64');

            if (!isVerified) {
              console.error('Signature verification failed in batch'); 
              return socket.emit('streamError', 'Signature verification failed'); 
            }
          }

          console.log('Batch signature verification successful');

          // Send Batch to FFmpeg 
          if (ffmpegProcess && ffmpegProcess.stdin.writable) {
            for (const frameData of batch) {
              ffmpegProcess.stdin.write(Buffer.from(frameData.videoBlob));
            }
          } else {
            console.error('FFmpeg process is not writable');
            socket.emit('streamError', 'FFmpeg process error');
          }
        } catch (error) {
          logger.error('Batch Processing Error:', error); 
          socket.emit('streamError', 'Error processing video batch');
        }
      });

      
      // Stop Stream Handler
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

                       // Emit updated stream list to all connected clients
    io.emit('streamList', Object.keys(activeStreams));  
  
          } catch (error) {
            logger.error('Stream Stop Error:', error); 
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
