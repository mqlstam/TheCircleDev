import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import WebcamCapture from './WebcamCapture';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';

function App() {
  const [socket, setSocket] = useState(null);
  const [streamUrl, setStreamUrl] = useState('');
  const videoPlayerRef = useRef(null);
  const [userId, setUserId] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showLoginForm, setShowLoginForm] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(null);
  const [streamList, setStreamList] = useState([]);
  const [streamError, setStreamError] = useState(null);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    newSocket.on('streamStarted', (streamName) => {
      setStreamUrl(`http://localhost:8080/live/${streamName}/index.m3u8`);
      setIsStreaming(true);
      setIsLoading(true);
    });

    newSocket.on('streamStopped', (streamName) => {
      setStreamUrl('');
      setIsStreaming(false);
      setIsLoading(false);
    });

    newSocket.on('authenticationSuccess', () => {
      setIsAuthenticated(true);
      setShowLoginForm(false);
      setAuthError(null);
    });

    newSocket.on('authenticationError', (error) => {
      console.error('Authentication error:', error);
      setAuthError(error);
    });

    newSocket.on('loginSuccess', (token) => {
      localStorage.setItem('token', token);
      newSocket.emit('authenticate', token);
    });

    newSocket.on('loginError', (error) => {
      console.error('Login error:', error);
      setLoginError(error);
    });

    newSocket.on('streamList', (list) => {
      setStreamList(list);
    });

    newSocket.on('streamError', (error) => {
      setStreamError(error);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const handleStreamSelect = (streamName) => {
    setStreamUrl(`http://localhost:8080/live/${streamName}/index.m3u8`);
    setIsStreaming(true);
    setIsLoading(true);
  };

  useEffect(() => {
    let player;
    if (streamUrl && videoPlayerRef.current) {
      player = videojs(videoPlayerRef.current, {
        controls: true,
        autoplay: true,
        preload: 'auto',
        sources: [{ src: streamUrl, type: 'application/x-mpegURL' }],
      });

      player.on('play', () => {
        setIsLoading(false);
      });

      return () => {
        if (player) {
          player.dispose();
        }
      };
    }
  }, [streamUrl]);

  const handleVideoData = async (videoData, checksum) => {
    console.log(`Sending video data: ${videoData.slice(0, 100)}...`);
    console.log(`Calculated checksum: ${checksum}`);

    if (socket) {
      socket.emit('videoData', videoData, checksum);
      console.log(`Sent video data with checksum: ${checksum}`);
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
    } else {
      socket.emit('startStream');
      setIsCapturing(true);
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

  return (
    <div className="App">
      <h1>SeeChange</h1>
      {!isAuthenticated ? (
        <div>
          {showLoginForm && (
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
            </form>
          )}
          {!showLoginForm && <p>Please authenticate to access SeeChange.</p>}
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
          {isCapturing && <WebcamCapture onVideoData={handleVideoData} />}
          {isStreaming ? (
            <div>
              {isLoading && <p>Loading stream...</p>}
              <div data-vjs-player>
                <video
                  ref={videoPlayerRef}
                  className="video-js vjs-default-skin"
                  controls
                  autoPlay
                  muted
                  width="640"
                  height="360"
                />
              </div>
            </div>
          ) : !userId ? (
            <p>Enter a User ID to start streaming.</p>
          ) : (
            <p>Ready to stream. Click "Start Streaming".</p>
          )}
          {streamError && <p className="error">{streamError}</p>}
          <h2>Available Streams</h2>
          <ul>
            {streamList.map((streamName) => (
              <li key={streamName}>
                <button onClick={() => handleStreamSelect(streamName)}>
                  {streamName}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default App;
