import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Webcam from 'react-webcam';
import dashjs from 'dashjs';

function App() {
  const [socket, setSocket] = useState(null);
  const [streamUrl, setStreamUrl] = useState('');
  const videoPlayerRef = useRef(null);
  const webcamRef = useRef(null);
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
      setStreamUrl(`http://localhost:8080/live/${streamName}/index.mpd`);
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
    setStreamUrl(`http://localhost:8080/live/${streamName}/index.mpd`);
    setIsStreaming(true);
    setIsLoading(true);
  };

  useEffect(() => {
    if (streamUrl && videoPlayerRef.current) {
      const player = dashjs.MediaPlayer().create();
      player.initialize(videoPlayerRef.current, streamUrl, true);
      player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        setIsLoading(false);
      });

      return () => {
        player.reset();
      };
    }
  }, [streamUrl]);

  const handleVideoData = async () => {
    if (webcamRef.current) {
      const videoData = webcamRef.current.getScreenshot();
      if (!videoData) {
        console.error('Failed to capture screenshot');
        return;
      }

      try {
        const checksum = await calculateChecksum(videoData);
        if (socket) {
          socket.emit('videoData', videoData, checksum);
        }
      } catch (error) {
        console.error('Error sending video data:', error);
      }
    }
  };

  const calculateChecksum = async (data) => {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
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
          {isCapturing && (
            <Webcam
              audio={false}
              ref={webcamRef}
              screenshotFormat="image/jpeg"
              width="640"
              height="360"
              onUserMedia={() => {
                setInterval(handleVideoData, 40); // Capture frame every 40ms (25 fps)
              }}
            />
          )}
          {isStreaming ? (
            <div>
              {isLoading && <p>Loading stream...</p>}
              <div>
                <video
                  ref={videoPlayerRef}
                  className="dash-video-player"
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
