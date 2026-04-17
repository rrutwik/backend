import { cleanEnv, port, str, bool, num } from 'envalid';
import { config } from 'dotenv';

config({ path: `.env.${process.env.NODE_ENV || 'development'}.local` });

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ default: 'development' }),
  PORT: port({ default: 3000 }),
  CREDENTIALS: bool({ default: true }),
  SECRET_KEY: str({ default: 'secretKey' }),
  LOG_FORMAT: str({ default: 'dev' }),
  LOG_DIR: str({ default: '../logs' }),
  ORIGINS: str({ default: '*' }),
  
  DB_HOST: str({ default: 'localhost' }),
  DB_URL: str({ default: 'mongodb://localhost:27017' }),
  DB_PORT: port({ default: 27017 }),
  DB_NAME: str({ default: 'devDatabase' }),
  DB_USERNAME: str({ default: 'root' }),
  DB_PASSWORD: str({ default: 'password' }),

  REDIS_URL: str({ default: 'redis://127.0.0.1:6379' }),
  REDIS_HOST: str({ default: '127.0.0.1' }),
  REDIS_PORT: port({ default: 6379 }),

  RAZORPAY_KEY: str({ default: '' }),
  RAZORPAY_SECRET: str({ default: '' }),

  GOOGLE_CLIENT_SECRET: str({ default: '' }),
  GOOGLE_CLIENT_ID: str({ default: '' }),
  OPENAI_KEY: str({ default: '' }),
  OPENAI_MODEL_NAME: str({ default: 'gpt-3.5-turbo' }),
  MAXIMUM_CHAT_BUFFER: num({ default: 10 }),
});
