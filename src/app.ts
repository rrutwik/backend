import 'reflect-metadata';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import morgan from 'morgan';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { NODE_ENV, PORT, LOG_FORMAT, CREDENTIALS, ORIGINS } from '@config';
import { dbConnection } from '@database';
import { Routes } from '@interfaces/routes.interface';
import { ErrorMiddleware } from '@middlewares/error.middleware';
import { logger, stream } from '@utils/logger';
import cors from 'cors';
import { cache } from './cache';
import http from 'http';

export class App {
  public app: express.Application;
  public env: string;
  public port: string | number;
  public server: http.Server;

  constructor(routes: Routes[]) {
    this.app = express();
    this.server = http.createServer(this.app);
    this.env = NODE_ENV || 'development';
    this.port = PORT || 3000;
    try {
      this.connectToDatabase();
      this.initializeMiddlewares();
      this.initializeRoutes(routes);
      this.initializeSwagger();
      this.initializeErrorHandling();
    } catch (error) {
      console.error(error);
    }
  }

  public listen() {
    this.server.listen(this.port, () => {
      logger.info(`=================================`);
      logger.info(`======= ENV: ${this.env} =======`);
      logger.info(`🚀 App listening on the port ${this.port}`);
      logger.info(`=================================`);
    });
  }

  public getApp() {
    return this.app;
  }

  private async connectToDatabase() {
    try {
      logger.info('Connecting to the database...');
      await dbConnection();
      logger.info('Database connected');
      const redisConnected = await cache.testConnection();
      if (!redisConnected) {
        logger.error('Redis connection failed');
        // send SIGINT
        process.kill(process.pid, 'SIGINT');
      }
    } catch (error) {
      logger.error(`Error connecting to the database: ${error}`);
      // send SIGINT
      process.kill(process.pid, 'SIGINT');
    }
  }

  private initializeMiddlewares() {
    this.app.use(morgan(LOG_FORMAT, { stream: stream }));
    const origins = ORIGINS ? ORIGINS.split(',').map((origin) => origin.trim()) : [];
    this.app.set("trust proxy", true);
    this.app.use(cors({ origin: origins, credentials: CREDENTIALS }));
    this.app.use(hpp());
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());
  }

  private initializeRoutes(routes: Routes[]) {
    routes.forEach(route => {
      this.app.use('/', route.router);
    });
  }

  private initializeSwagger() {
    const options = {
      swaggerDefinition: {
        info: {
          title: 'REST API',
          version: '1.0.0',
          description: 'Example docs',
        },
      },
      apis: ['swagger.yaml'],
    };

    const specs = swaggerJSDoc(options);
    this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
  }

  private initializeErrorHandling() {
    this.app.use(ErrorMiddleware);
  }
}
