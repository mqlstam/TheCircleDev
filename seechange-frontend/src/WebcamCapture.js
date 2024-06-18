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
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
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
      const captureFrame = async () => {
        if (videoRef.current && videoRef.current.videoWidth && videoRef.current.videoHeight) {
          canvas.width = videoRef.current.videoWidth;
          canvas.height = videoRef.current.videoHeight;
          context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

          canvas.toBlob(async (blob) => {
            const arrayBuffer = await blob.arrayBuffer();
            const checksum = await calculateChecksum(arrayBuffer);

            onVideoData(blob, checksum);
          }, 'image/jpeg', 0.7); // Adjust quality (0.7 is 70% quality)
        }
      };
      
      const intervalId = setInterval(captureFrame, 66); // Capture at approximately 15 fps

      return () => clearInterval(intervalId);
    }
  }, [videoRef, onVideoData]);

  const calculateChecksum = async (data) => {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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
