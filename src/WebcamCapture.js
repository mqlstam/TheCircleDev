import React, { useState, useEffect, useRef } from 'react';

function WebcamCapture({ onVideoData }) {
  const [videoStream, setVideoStream] = useState(null);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    const startCapture = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        setVideoStream(stream);
        videoRef.current.srcObject = stream;
        setError(null);
      } catch (error) {
        console.error('Error accessing webcam:', error);
        setError(error.message);
      }
    };

    startCapture();

    return () => {
      if (videoStream) {
        videoStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [videoStream]);

  useEffect(() => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const intervalId = setInterval(async () => {
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

        const videoData = canvas.toDataURL('image/jpeg');
        const checksum = await calculateChecksum(videoData);

        onVideoData(videoData, checksum);
      }, 100);

      return () => clearInterval(intervalId);
    }
  }, [videoRef.current]);

  const calculateChecksum = async (data) => {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <video ref={videoRef} autoPlay muted />
    </div>
  );
}

export default WebcamCapture;
