import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Webcam from 'react-webcam';
import axios from 'axios';
import NodeRSA from 'node-rsa';
import crypto from 'crypto';

function StreamingPage() {
  const [socket, setSocket] = useState(null);
  const webcamRef = useRef(null);
  const [userId, setUserId] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showLoginForm, setShowLoginForm] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [userPrivateKey, setUserPrivateKey] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState(null);
  const [registrationSuccess, setRegistrationSuccess] = useState(null);
  const [intervalId, setIntervalId] = useState(null);

  const frameQueue = useRef([]);
  const processingFrame = useRef(false);

  useEffect(() => {
    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    newSocket.on('authenticationSuccess', () => {
      setIsAuthenticated(true);
      setShowLoginForm(false);
      setAuthError(null);
    });

    newSocket.on('authenticationError', (error) => {
      console.error('Authentication error:', error);
      setAuthError(error);
    });

    newSocket.on('loginSuccess', (token, privateKey) => {
      localStorage.setItem('token', token);
      setUserPrivateKey(privateKey);
      newSocket.emit('authenticate', token);
    });

    newSocket.on('loginError', (error) => {
      console.error('Login error:', error);
      setLoginError(error);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const processFrameQueue = async () => {
    if (processingFrame.current || frameQueue.current.length === 0) return;

    processingFrame.current = true;
    const frame = frameQueue.current.shift();
    try {
      const videoDataUrl = frame;
      // Convert data URL to Blob
      const fetchResponse = await fetch(videoDataUrl);
      const blob = await fetchResponse.blob();

      // Convert Blob to ArrayBuffer for signing
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const userKey = new NodeRSA(userPrivateKey, 'private', { encryptionScheme: 'pkcs1' });
      const hash = crypto.createHash('sha256').update(buffer).digest('base64');
      const signature = userKey.sign(hash, 'base64');

      console.log(`Video data hash (frontend): ${hash}`);
      console.log(`Signature (frontend): ${signature}`);

      if (socket) {
        // Convert Blob to ArrayBuffer for sending
        const arrayBufferBlob = await blob.arrayBuffer();
        socket.emit('videoData', { videoBlob: arrayBufferBlob, signature: signature });
      }
    } catch (error) {
      console.error('Error processing video data:', error);
    }
    processingFrame.current = false;
    processFrameQueue();
  };

  const handleVideoData = async () => {
    if (webcamRef.current) {
      const videoDataUrl = webcamRef.current.getScreenshot();
      if (!videoDataUrl) {
        console.error('Failed to capture screenshot');
        return;
      }
      frameQueue.current.push(videoDataUrl);
      processFrameQueue();
    }
  };

  const handleStartStop = () => {
    if (!socket) {
      console.error('Socket not initialized');
      return;
    }

    if (isCapturing) {
      socket.emit('stopStream');
      setIsCapturing(false);
      clearInterval(intervalId);
      setIntervalId(null);
    } else {
      socket.emit('startStream');
      setIsCapturing(true);
      const id = setInterval(handleVideoData, 40); // Capture frame every 40ms (25 fps)
      setIntervalId(id);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError(null);
    if (!socket) {
      console.error('Socket not initialized');
      return;
    }

    try {
      socket.emit('login', username, password);
    } catch (error) {
      console.error('Login error:', error);
      setLoginError('Server error');
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setRegistrationError(null);
    setRegistrationSuccess(null);

    if (!username || !password) {
      setRegistrationError('Username and password are required');
      return;
    }

    try {
      const response = await axios.post('http://localhost:3001/register', { username, password });
      setRegistrationSuccess(response.data.message);
    } catch (error) {
      console.error('Registration error:', error);
      setRegistrationError(error.response?.data?.error || 'Registration failed');
    }
  };

  return (
    <div className="StreamingPage">
      <h1>Streaming</h1>
      {!isAuthenticated ? (
        <div>
          {isRegistering ? (
            <form onSubmit={handleRegister}>
              <h2>Register</h2>
              {registrationError && <p className="error">{registrationError}</p>}
              {registrationSuccess && <p className="success">{registrationSuccess}</p>}
              <div>
                <label htmlFor="username">Username:</label>
                <input
                  type="text"
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="password">Password:</label>
                <input
                  type="password"
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button type="submit">Register</button>
              <button type="button" onClick={() => setIsRegistering(false)}>
                Back to Login
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin}>
              <h2>Login</h2>
              {loginError && <p className="error">{loginError}</p>}
              <div>
                <label htmlFor="username">Username:</label>
                <input
                  type="text"
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="password">Password:</label>
                <input
                  type="password"
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button type="submit">Login</button>
              <button type="button" onClick={() => setIsRegistering(true)}>
                Register
              </button>
            </form>
          )}
          {authError && <p className="error">{authError}</p>}
        </div>
      ) : (
        <div>
          <input
            type="text"
            placeholder="Enter User ID"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={isCapturing}
          />
          <button onClick={handleStartStop} disabled={!userId || isCapturing}>
            {isCapturing ? 'Stop Streaming' : 'Start Streaming'}
          </button>
          {isCapturing && (
            <Webcam
              audio={false}
              ref={webcamRef}
              screenshotFormat="image/jpeg"
              width="640"
              height="360"
            />
          )}
          {!userId && <p>Enter a User ID to start streaming.</p>}
        </div>
      )}
    </div>
  );
}

export default StreamingPage;
