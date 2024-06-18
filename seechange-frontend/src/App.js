import React from 'react';
import { Routes, Route } from 'react-router-dom';
import StreamingPage from './StreamingPage'; // Import the new StreamingPage component
import WatchingPage from './WatchingPage'; // Import the new WatchingPage component
import HomePage from './HomePage'; // Assuming you have a HomePage component

function App() {
  return (
    <Routes>
      <Route path="/streaming" element={<StreamingPage />} />
      <Route path="/watching" element={<WatchingPage />} />
      <Route path="/" element={<HomePage />} />
    </Routes>
  );
}

export default App;
