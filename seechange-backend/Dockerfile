# Use the official Node.js image as the base image
FROM node:14

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Install nodemon globally
RUN npm install -g nodemon

# Create the media directory
RUN mkdir -p /app/media

# Install ffmpeg and clean up apt cache to reduce image size
RUN apt-get update && \
    apt-get install -y apt-transport-https && \
    apt-get install -y ffmpeg || apt-get --fix-missing install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy the rest of the application code
COPY . .

# Ensure any required subdirectories are created
RUN mkdir -p /app/path/to/required/files

# Expose ports for Node Media Server and WebSocket server
EXPOSE 1935
EXPOSE 8081
EXPOSE 8443
EXPOSE 8080

# Command to run the application with nodemon to monitor server.js
CMD ["node", "index.js"]