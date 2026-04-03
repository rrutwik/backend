import mongoose, { ConnectOptions, Connection, Document, Schema, connect, set } from 'mongoose';
import { NODE_ENV, DB_URL, DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD } from '@config';

export const dbConnection = async () => {
  set('strictQuery', true);

  const url: string = DB_URL;

  // Set options based on the environment
  const options: ConnectOptions = NODE_ENV === 'production' ? {
    dbName: DB_NAME,
    retryWrites: true,
    w: 'majority',
    autoCreate: true,
    autoIndex: true,
  } : {
    dbName: DB_NAME,
    user: DB_USERNAME,
    pass: DB_PASSWORD,
    authMechanism: 'SCRAM-SHA-1', // Common for local development setups
    authSource: 'admin', // Typically 'admin' is used for local, but adjust if different
    autoIndex: true,
    autoCreate: true,
  };

  // Enable debug mode for non-production environments
  if (NODE_ENV !== 'production') {
    set('debug', false);
  }

  await connect(url, options);
};

export const getDb = (dbName: string): Connection => {
  return mongoose.connection.useDb(dbName, { useCache: true });
};

export const getSecondDatabase = (collectionName: string, schema: Schema) => {
  const dbName: string = 'data';
  const conn: Connection = getDb(dbName);
  // first arg: model name; third arg: collection name
  return conn.model<Document>(collectionName, schema, collectionName);
};
