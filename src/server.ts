import { App } from '@/app';
import { AuthRoute } from '@routes/auth.route';
import { UserRoute } from '@routes/users.route';
import { ValidateEnv } from './utils/validateEnv';
import { WebHookRoute } from './routes/webhook.route';
import { ChatRoute } from './routes/chat.route';
import { IndexRoute } from './routes/index.route';
import { ChatBotRoute } from './routes/chatbot.route';
import { IFSCRoute } from './routes/ifsc.route';
import { AdminRoute } from './routes/admin.route';
import { ChessRoute } from './routes/chess.route';
import { initSocket } from './socket';
import { ChessService } from './services/chess.service';

process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err);
  process.exit(1); //mandatory (as per the Node.js docs)
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

ValidateEnv();

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

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received.');
  // Perform cleanup tasks here
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received.');
  // Perform cleanup tasks here
  process.exit(0);
});

const chessService = new ChessService();

initSocket(app.server, chessService).then((io) => {
  app.server.setMaxListeners(0);
  app.getApp().set("io", io);
  app.listen();
}).catch((error) => {
  console.error('Error initializing Socket.IO:', error);
  process.kill(process.pid, 'SIGINT')
});
