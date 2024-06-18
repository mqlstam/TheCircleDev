import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Hls from 'hls.js';
import axios from 'axios';
import NodeRSA from 'node-rsa';
import crypto from 'crypto';

function WatchingPage() {
  const [socket, setSocket] = useState(null);
  const [streamUrl, setStreamUrl] = useState('');
  const videoPlayerRef = useRef(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamList, setStreamList] = useState([]);
  const [streamError, setStreamError] = useState(null);
  const [publicKeys, setPublicKeys] = useState({});
  const segmentQueue = useRef([]); 
  const processingSegment = useRef(false);

  useEffect(() => {
    console.log("WatchingPage component mounted"); // Debug: Component lifecycle

    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    newSocket.on('streamStarted', handleStreamStarted);
    newSocket.on('streamStopped', handleStreamStopped);
    newSocket.on('streamList', handleStreamList);
    newSocket.on('streamError', handleStreamError);

    return () => {
      newSocket.disconnect();
      console.log('Socket disconnected');
    };
  }, []);

  // Event Handlers 
  const handleStreamStarted = async (streamName) => {
    console.log('Stream started:', streamName);
    await fetchPublicKey(streamName);
    const url = `http://localhost:8000/live/${streamName}/index.m3u8`;
    console.log('Stream URL:', url);
    setStreamUrl(url); 
    setIsStreaming(true);
    setIsLoading(true);
  };

  const handleStreamStopped = (streamName) => {
    console.log('Stream stopped:', streamName);
    setStreamUrl('');
    setIsStreaming(false);
    setIsLoading(false);
  };

  const handleStreamList = (list) => {
    console.log('Stream list received:', list);
    setStreamList(list);
  };

  const handleStreamError = (error) => {
    console.error('Stream error:', error);
    setStreamError(error);
  };

  const fetchPublicKey = async (streamName) => {
    try {
      console.log('Fetching public key for stream:', streamName);
      const response = await axios.get(`http://localhost:3001/publicKey?streamName=${streamName}`);
      setPublicKeys((prevKeys) => ({
        ...prevKeys,
        [streamName]: response.data.publicKey,
      }));
      console.log('Public key fetched for stream:', streamName);
    } catch (error) {
      console.error('Error fetching public key:', error);
    }
  };

  const handleStreamSelect = async (streamName) => {
    console.log('Stream selected:', streamName);
    await fetchPublicKey(streamName);
    const url = `http://localhost:8000/live/${streamName}/index.m3u8`;
    console.log('Selected Stream URL:', url);
    setStreamUrl(url);
    setIsStreaming(true);
    setIsLoading(true);
  };

  useEffect(() => {
    console.log("useEffect for HLS setup triggered");
    console.log("streamUrl in useEffect:", streamUrl);

    let hls;
    let reconnectInterval;

    const setupHls = () => {
      console.log("setupHls called"); // Debug: Function call
      console.log("videoPlayerRef.current:", videoPlayerRef.current); // Debug: Video element

      if (streamUrl && videoPlayerRef.current) {
        console.log("Initializing HLS.js with URL:", streamUrl); 
        if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(streamUrl);
          hls.attachMedia(videoPlayerRef.current);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS Manifest Parsed');
            setIsLoading(false);
            hls.startLoad(hls.media.duration - 5);
          });

          hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
            const { frag } = data;
            segmentQueue.current.push(frag);
            processSegmentQueue(hls); 
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

    const processSegmentQueue = async (hlsInstance) => {
      if (processingSegment.current || segmentQueue.current.length === 0) return;
      processingSegment.current = true;

      try {
        const segment = segmentQueue.current.shift();
        const streamName = segment.url.split('/')[4]; 
        const publicKey = publicKeys[streamName]; 

        if (publicKey) {
          console.log('Fetching and verifying video segment for stream:', streamName);
          const videoData = await fetchVideoSegment(segment.url);
          const isVerified = verifyVideoSegment(videoData, publicKey);

          if (!isVerified) {
            console.error('Video segment verification failed.');
            setStreamError('Video segment verification failed.');
            // Potentially stop playback or handle the error differently
          } else {
            console.log('Video segment verification succeeded.');

            // If verification succeeds, manually append the segment to the HLS playlist
            hlsInstance.trigger(Hls.Events.FRAG_LOADED, {
              frag: segment,
              payload: {
                url: segment.url,
                data: videoData.buffer, // Pass the ArrayBuffer
              },
            });
          }
        } 

      } catch (error) {
        console.error('Error verifying video segment:', error);
        setStreamError('Error verifying video segment.');
      }

      processingSegment.current = false;
      processSegmentQueue(hlsInstance); // Process the next segment
    };

    const fetchVideoSegment = async (url) => {
      console.log('Fetching video segment from URL:', url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch video segment');
      }
      const videoData = await response.arrayBuffer();
      console.log('Video segment fetched');
      return new Uint8Array(videoData);
    };

    const verifyVideoSegment = (videoData, publicKey) => {
      const key = new NodeRSA(publicKey, 'public');
      const hash = crypto.createHash('sha256').update(videoData).digest('base64');
      const isVerified = key.verify(videoData, hash, 'buffer', 'base64');
      console.log('Video segment verification:', isVerified ? 'succeeded' : 'failed');
      return isVerified;
    };

    if (videoPlayerRef.current) { 
      setupHls();
    }

    return () => {
      if (hls) {
        hls.destroy();
        console.log('HLS.js instance destroyed');
      }
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        console.log('Reconnect interval cleared');
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
