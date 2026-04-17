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
import { resolve } from 'path';
import { reject } from 'lodash';

process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err);
  process.exit(1); //mandatory (as per the Node.js docs)
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});
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

process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received.');
  try {
    await new Promise((resolve, reject) => {
      app.server.close(() => {
        resolve(null);
      });
    })
    await closeBullMQ();
    process.exit(0);
  } catch (error) {
    console.error('Error while shutting down server:', error);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received.');
  try {
    await new Promise((resolve, reject) => {
      app.server.close(() => {
        resolve(null);
      });
    })
    await closeBullMQ();
    process.exit(0);
  } catch (error) {
    console.error('Error while shutting down server:', error);
    process.exit(1);
  }
});

const chessService = new ChessService();

initSocket(app.server, chessService).then((io) => {
  app.server.setMaxListeners(0);
  app.getApp().set("io", io);

  // Restrict BullMQ cron/worker initialization to the primary PM2 instance (or local dev)
  if (!process.env.INSTANCE_ID || process.env.INSTANCE_ID === '0') {
    initBullMQ(io, chessService);
  }

  app.listen();
}).catch((error) => {
  console.error('Error initializing Socket.IO:', error);
  process.kill(process.pid, 'SIGINT')
});
