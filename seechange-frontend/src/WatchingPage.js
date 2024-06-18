import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Hls from 'hls.js';
import NodeRSA from 'node-rsa';
import crypto from 'crypto';

function WatchingPage() {
  const [socket, setSocket] = useState(null);
  const [streamList, setStreamList] = useState([]);
  const [selectedStream, setSelectedStream] = useState(null);
  const [videoPlayer, setVideoPlayer] = useState(null);
  const [publicKey, setPublicKey] = useState(null);
  const [verificationError, setVerificationError] = useState(null);
  const [isLoading, setIsLoading] = useState(false); 
  const videoRef = useRef(null);

  useEffect(() => {
    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    newSocket.on('connect', () => console.log('Socket connected'));
    newSocket.on('streamList', handleStreamList); 

    // Clean up on unmount
    return () => {
      newSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (socket) {
      socket.emit('streamList'); 
    }
  }, [socket]);

  const handleStreamList = (newStreamList) => {
    setStreamList(newStreamList);
  };

  const handleStreamSelect = (streamName) => {
    setSelectedStream(streamName);

    // Fetch public key and start playing stream
    fetchPublicKey(streamName);
  };

  const fetchPublicKey = async (streamName) => {
    try {
      const response = await fetch(`http://localhost:3001/publicKey?streamName=${streamName}`);
      const data = await response.json();
      setPublicKey(data.publicKey);
    } catch (error) {
      console.error('Error fetching public key:', error);
    }
  };

  const handlePlayStream = () => {
    if (!videoPlayer || !selectedStream) {
      return;
    }

    // Start HLS playback
    videoPlayer.loadSource(`http://localhost:8000/live/${selectedStream}.m3u8`);
    videoPlayer.play();
    setIsLoading(false);
  };

  useEffect(() => {
    if (selectedStream) {
      setIsLoading(true); // Show loading while fetching public key
      // Create HLS instance
      const hls = new Hls();
      hls.attachMedia(videoRef.current);

      // Initialize video player and handle playback
      setVideoPlayer(hls); 

      // Start playing after public key is fetched
      handlePlayStream();
    } else {
      // Stop HLS playback
      if (videoPlayer) {
        videoPlayer.stopLoad(); 
      }
      setPublicKey(null);
      setVerificationError(null);
    }
  }, [selectedStream]);

  const verifyStream = () => {
    if (!selectedStream || !videoPlayer || !publicKey) {
      return;
    }

    const videoData = videoRef.current.captureStream();
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const videoBuffer = Buffer.from(e.target.result);
        const hash = crypto.createHash('sha256').update(videoBuffer).digest('base64');
        const userKey = new NodeRSA(publicKey, 'public', { encryptionScheme: 'pkcs1' });
        const signature = videoPlayer.config.loader.getMediaData('metadata').signature;

        if (!signature) {
          throw new Error('Signature not found in stream metadata');
        }

        const isVerified = userKey.verify(hash, Buffer.from(signature, 'base64'), 'utf8', 'base64');

        if (isVerified) {
          setVerificationError(null);
          console.log('Stream verification successful!');
        } else {
          setVerificationError('Stream signature verification failed');
          console.error('Stream signature verification failed');
        }

      } catch (error) {
        setVerificationError('Stream verification failed');
        console.error('Error verifying stream:', error);
      }
    };

    reader.readAsArrayBuffer(videoData.getVideoTracks()[0].captureFrame());
  };

  return (
    <div className="WatchingPage">
      <h1>Video Streams</h1>
      {isLoading && <p>Loading stream...</p>}
      {verificationError && <p className="error">{verificationError}</p>}
      <ul>
        {streamList.map((streamName) => (
          <li key={streamName}>
            <button onClick={() => handleStreamSelect(streamName)}>
              {streamName}
            </button>
          </li>
        ))}
      </ul>

      {selectedStream && (
        <div>
          <video ref={videoRef} width="640" height="480" controls></video>
          <button onClick={verifyStream} disabled={!selectedStream}>
            Verify Stream
          </button>
        </div>
      )}
    </div>
  );
}

export default WatchingPage;