import React from 'react';
import { Link } from 'react-router-dom';

function HomePage() {
  return (
    <div className="HomePage">
      <h1>Welcome to SeeChange</h1>
      <Link to="/streaming">
        <button>Go to Streaming</button>
      </Link>
      <Link to="/watching">
        <button>Go to Watching</button>
      </Link>
    </div>
  );
}

export default HomePage;
