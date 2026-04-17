import { App } from '@/app';
import { AuthRoute } from '@routes/auth.route';
import { UserRoute } from '@routes/users.route';
import { WebHookRoute } from './routes/webhook.route';
import { ChatRoute } from './routes/chat.route';
import { IndexRoute } from './routes/index.route';
import { ChatBotRoute } from './routes/chatbot.route';
import { IFSCRoute } from './routes/ifsc.route';
import { AdminRoute } from './routes/admin.route';
import { ChessRoute } from './routes/chess.route';
import { initSocket } from './socket';
import { ChessService } from './services/chess.service';
import { closeBullMQ, initBullMQ } from './jobs';
import { logger } from './utils/logger';
import { Server } from "socket.io";

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err}`);
  process.exit(1); // fatal, exit
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  // do NOT exit immediately, allow logging/cleanup
});

// --- APP INIT ---
const app = new App([
  new IndexRoute(),
  new ChatBotRoute(),
  new UserRoute(),
  new ChatRoute(),
  new AuthRoute(),
  new WebHookRoute(),
  new IFSCRoute(),
  new AdminRoute(),
  new ChessRoute(),
]);

const chessService = new ChessService();

let ioInstance: Server;
let isShuttingDown = false;

// --- GRACEFUL SHUTDOWN ---
async function closeServer() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutdown signal received');

  const forceExit = setTimeout(() => {
    logger.error('Force shutdown after 20s');
    process.exit(1);
  }, 20000);

  try {
    // 3. Close BullMQ (workers, queues, redis)
    logger.info('Closing BullMQ');
    await closeBullMQ();
    logger.info('BullMQ closed');

    // 1. Close Socket.IO
    if (ioInstance) {
      logger.info('Closing Socket.IO');
      await ioInstance.close();
    }
    logger.info('Closing HTTP server');
    await new Promise<void>((resolve) => {
      app.server.close((err) => {
        if (err) {
          logger.error(`Error during HTTP server close: ${err}`);
        }
        resolve();
      });
    });
    logger.info('HTTP server closed');

    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    logger.error(`Error during shutdown: ${error}`);
    process.exit(1);
  }
}

// --- SIGNAL HANDLERS (PM2 + SYSTEM) ---
['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'].forEach((signal) => {
  process.on(signal, closeServer);
});

// --- START SERVER + SOCKET ---
initSocket(app.server, chessService)
  .then(async (io) => {
    ioInstance = io;

    app.server.setMaxListeners(0);
    app.getApp().set('io', io);

    app.listen();

    // Only run BullMQ in primary instance
    if (!process.env.INSTANCE_ID || process.env.INSTANCE_ID === '0') {
      await initBullMQ(io, chessService);
    }

    // Notify PM2 readiness (if using wait_ready)
    process.send?.('ready');
  })
  .catch((error) => {
    console.error('Error initializing Socket.IO:', error);
    process.exit(1);
  });