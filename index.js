// Load environment variables from .env file
require('dotenv').config();

// Import necessary modules and libraries
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');
const logger = require('./src/utils/logger'); // Ensure this module exports a logger (e.g., using winston or another logging library)
const messageHandler = require('./src/handlers/messageHandler'); // Ensure this module exports a function to handle incoming messages
const http = require('http');
const path = require('path');
const qrcode = require('qrcode-terminal');

// Environment variables and configurations
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://mateochatbot:xdtL2bYQ9eV3CeXM@gerald.r2hjy.mongodb.net/';
const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.resolve(__dirname, './auth_info_baileys'); // Use absolute path for SESSION_DIR
const SESSION_DATA = process.env.SESSION_DATA;

// Function to initialize MongoDB connection
async function initializeMongoStore() {
    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000
        });
        logger.info('Connected to MongoDB');
    } catch (error) {
        logger.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

// Function to connect to WhatsApp using Baileys
async function connectToWhatsApp() {
    try {
        // Initialize multi-file authentication state
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

        // If SESSION_DATA is provided, attempt to load it
        if (SESSION_DATA) {
            try {
                const sessionDataBuffer = Buffer.from(SESSION_DATA, 'base64');
                const sessionDataJson = sessionDataBuffer.toString();
                const sessionData = JSON.parse(sessionDataJson);

                // Validate that sessionData contains both creds and keys
                if (sessionData.creds && sessionData.keys) {
                    state.creds = sessionData.creds;
                    state.keys = sessionData.keys;
                    logger.info('Session data loaded from SESSION_DATA environment variable.');
                } else {
                    logger.warn('SESSION_DATA does not contain both creds and keys. Ignoring SESSION_DATA.');
                }
            } catch (error) {
                logger.error('Error parsing SESSION_DATA:', error);
            }
        }

        // Create WhatsApp socket connection
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: !SESSION_DATA, // Only print QR if SESSION_DATA is not provided
            defaultQueryTimeoutMs: 60000,
        });

        // Event listener for connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // If a QR code is received and SESSION_DATA is not provided, display the QR code
            if (qr && !SESSION_DATA) {
                qrcode.generate(qr, { small: true });
                logger.info('QR code generated for authentication. Scan the QR code to log in.');
            }

            // Handle connection closure
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                logger.info(`Connection closed due to ${JSON.stringify(lastDisconnect?.error)}, reconnecting: ${shouldReconnect}`);

                // Attempt to reconnect if not logged out
                if (shouldReconnect) {
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 3000); // Wait for 3 seconds before reconnecting
                }
            }

            // Handle successful connection
            else if (connection === 'open') {
                logger.info('Connected to WhatsApp');
                try {
                    await sock.sendMessage('status@broadcast', {
                        text: 'NexusCoders Bot is connected and ready to use!'
                    });
                    logger.info('Ready message sent to WhatsApp.');
                } catch (error) {
                    logger.error('Error sending ready message:', error);
                }
            }
        });

        // Event listener for incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe) { // Ignore messages sent by the bot itself
                        try {
                            logger.info('Received message:', JSON.stringify(msg));
                            await messageHandler(sock, msg); // Handle the message using your custom handler
                        } catch (error) {
                            logger.error('Error in message handler:', error);
                        }
                    }
                }
            }
        });

        // Event listener for credential updates to save them
        sock.ev.on('creds.update', saveCreds);

        return sock;
    } catch (error) {
        logger.error('Error in connectToWhatsApp:', error);
        setTimeout(() => {
            connectToWhatsApp();
        }, 3000); // Retry connection after 3 seconds on error
    }
}

// Create an HTTP server for health checks and basic response
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('NexusCoders WhatsApp bot is running!');
});

// Function to start the HTTP server
async function startServer() {
    server.listen(PORT, '0.0.0.0', () => {
        logger.info(`Server running on port ${PORT}`);
    });
}

// Function to set up keep-alive pings to prevent the app from idling (useful for platforms like Heroku)
function setupKeepAlive() {
    setInterval(() => {
        http.get(`http://localhost:${PORT}`, (res) => {
            if (res.statusCode === 200) {
                logger.info('Keep-alive ping successful');
            } else {
                logger.warn(`Keep-alive ping failed with status code: ${res.statusCode}`);
            }
        }).on('error', (err) => {
            logger.error('Keep-alive ping error:', err);
        });
    }, 5 * 60 * 1000); // Every 5 minutes
}

// Main function to initialize the bot
async function main() {
    try {
        // Initialize MongoDB connection
        await initializeMongoStore();

        // Connect to WhatsApp
        await connectToWhatsApp();

        // Start the HTTP server
        await startServer();

        // Set up keep-alive mechanism
        setupKeepAlive();

        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception:', error);
        });

        // Handle graceful shutdown on SIGINT (e.g., Ctrl+C)
        process.on('SIGINT', async () => {
            logger.info('NexusCoders Bot shutting down...');
            try {
                await mongoose.disconnect();
                server.close(() => {
                    logger.info('HTTP server closed.');
                });
                process.exit(0);
            } catch (error) {
                logger.error('Error during shutdown:', error);
                process.exit(1);
            }
        });
    } catch (error) {
        logger.error('Error in main function:', error);
        process.exit(1);
    }
}

// Execute the main function
main();
