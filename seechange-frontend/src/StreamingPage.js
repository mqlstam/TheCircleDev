
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
  const [userPrivateKey, setUserPrivateKey] = useState(null); // Start as null 
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState(null);
  const [registrationSuccess, setRegistrationSuccess] = useState(null);
  const [intervalId, setIntervalId] = useState(null);

  const frameQueue = useRef([]);
  const processingFrame = useRef(false);

  // Configuration (Experiment for best balance)
  const BATCH_SIZE = 5;        // Number of frames per batch
  const CAPTURE_INTERVAL = 40; // Capture every 40ms (~25fps)

  useEffect(() => {
    // Establish Socket Connection
    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    // Socket Event Handlers
    newSocket.on('connect', () => console.log('Socket connected'));
    newSocket.on('authenticationSuccess', handleAuthenticationSuccess);
    newSocket.on('authenticationError', handleAuthenticationError);
    newSocket.on('loginSuccess', handleLoginSuccess);
    newSocket.on('loginError', handleLoginError);

    // Clean Up on Unmount
    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Authentication Effect (Runs after login and when socket connects)
  useEffect(() => {
    if (socket && localStorage.getItem('token') && userPrivateKey) { // Key is available now
      socket.emit('authenticate', localStorage.getItem('token'));
    }
  }, [socket, userPrivateKey]); 

  
   // Event Handler Functions (Keep code organized)
   const handleAuthenticationSuccess = () => {
    setIsAuthenticated(true);
    setShowLoginForm(false);
    setAuthError(null);
  };

  const handleAuthenticationError = (error) => {
    console.error('Authentication error:', error);
    setAuthError(error);
  };

  const handleLoginSuccess = (token, privateKey) => {
    localStorage.setItem('token', token);
    setUserPrivateKey(privateKey);
    // The useEffect will handle authentication
  };

  const handleLoginError = (error) => {
    console.error('Login error:', error);
    setLoginError(error);
  };

  const processFrameQueue = async () => {
    if (processingFrame.current || frameQueue.current.length === 0 || !userPrivateKey) { 
      return; // Don't process if busy, queue is empty, or no private key
    }
    processingFrame.current = true;

    try {
      const batch = [];

      while (frameQueue.current.length > 0 && batch.length < BATCH_SIZE) {
        const videoDataUrl = frameQueue.current.shift();

        const fetchResponse = await fetch(videoDataUrl);
        const blob = await fetchResponse.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const userKey = new NodeRSA(userPrivateKey, 'private', { encryptionScheme: 'pkcs1' });
        const hash = crypto.createHash('sha256').update(buffer).digest('base64');
        const signature = userKey.sign(hash, 'base64');

        batch.push({
          videoBlob: arrayBuffer,
          signature: signature
        });
      }

      if (batch.length > 0 && socket) {
        socket.emit('videoDataBatch', batch);
      }

    } catch (error) {
      console.error('Error processing video data:', error);
      // Handle error (e.g., display to the user)
    }

    processingFrame.current = false;
    processFrameQueue(); 
  };

  const handleVideoData = async () => {
    if (webcamRef.current && webcamRef.current.state.hasUserMedia) { // Check initialization and permissions 
      setTimeout(() => { 
        const videoDataUrl = webcamRef.current.getScreenshot();
        if (!videoDataUrl) {
          console.error('Failed to capture screenshot');
          return;
        }
        frameQueue.current.push(videoDataUrl);
        processFrameQueue();
      }, 500); // Adjust delay as needed
    }
  };

  const handleStartStop = () => {
    if (!socket) return; // Short-circuit if no socket connection

    if (isCapturing) {
      socket.emit('stopStream');
      setIsCapturing(false);
      clearInterval(intervalId);
    } else {
      socket.emit('startStream');
      setIsCapturing(true);
      const id = setInterval(handleVideoData, CAPTURE_INTERVAL); 
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
    width={320} // Reduced width
    height={240} // Reduced height
 />
          )}
          {!userId && <p>Enter a User ID to start streaming.</p>}
        </div>
      )}
    </div>
  );
}

export default StreamingPage;
