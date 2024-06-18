import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Hls from 'hls.js';

function WatchingPage() {
  const [socket, setSocket] = useState(null);
  const [streamUrl, setStreamUrl] = useState('');
  const videoPlayerRef = useRef(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamList, setStreamList] = useState([]);
  const [streamError, setStreamError] = useState(null);

  useEffect(() => {
    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    newSocket.on('streamStarted', (streamName) => {
      const url = `http://localhost:8000/live/${streamName}/index.m3u8`;
      console.log('Stream URL:', url);
      setStreamUrl(url);
      setIsStreaming(true);
      setIsLoading(true);
    });

    newSocket.on('streamStopped', (streamName) => {
      setStreamUrl('');
      setIsStreaming(false);
      setIsLoading(false);
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
    const url = `http://localhost:8000/live/${streamName}/index.m3u8`;
    console.log('Selected Stream URL:', url);
    setStreamUrl(url);
    setIsStreaming(true);
    setIsLoading(true);
  };

  useEffect(() => {
    let hls;
    let reconnectInterval;

    const setupHls = () => {
      if (streamUrl && videoPlayerRef.current) {
        console.log('Initializing HLS.js with URL:', streamUrl);
        if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(streamUrl);
          hls.attachMedia(videoPlayerRef.current);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS Manifest Parsed');
            setIsLoading(false);
            // Set to play the latest segment
            hls.startLoad(hls.media.duration - 5);
          });
          hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS.js Error:', event, data);
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.log('Fatal network error encountered, try to recover');
                  hls.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.log('Fatal media error encountered, try to recover');
                  hls.recoverMediaError();
                  break;
                default:
                  hls.destroy();
                  console.error('Unrecoverable error encountered, attempting to reconnect in 3 seconds...');
                  reconnectInterval = setInterval(() => {
                    console.log('Attempting to reconnect...');
                    setupHls();
                  }, 3000);
                  break;
              }
            }
          });
        } else if (videoPlayerRef.current.canPlayType('application/vnd.apple.mpegurl')) {
          videoPlayerRef.current.src = streamUrl;
          videoPlayerRef.current.addEventListener('loadedmetadata', () => {
            console.log('Native HLS loaded metadata');
            setIsLoading(false);
          });
          videoPlayerRef.current.addEventListener('error', () => {
            console.error('Native HLS Error, attempting to reconnect in 3 seconds...');
            reconnectInterval = setInterval(() => {
              console.log('Attempting to reconnect...');
              setupHls();
            }, 3000);
          });
        } else {
          console.error('HLS is not supported in this browser.');
        }
      }
    };

    setupHls();

    return () => {
      if (hls) {
        hls.destroy();
      }
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
      }
    };
  }, [streamUrl]);

  return (
    <div className="WatchingPage">
      <h1>Live Streaming</h1>
      {isStreaming ? (
        <div>
          {isLoading && <p>Loading stream...</p>}
          <div>
            <video
              ref={videoPlayerRef}
              className="hls-video-player"
              controls
              autoPlay
              muted
              width="640"
              height="360"
            />
          </div>
        </div>
      ) : (
        <p>Select a stream to start watching.</p>
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
  );
}

export default WatchingPage;
