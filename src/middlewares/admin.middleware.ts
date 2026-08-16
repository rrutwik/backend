import { NextFunction, Request, Response } from 'express';
import { ADMIN_API_KEY } from '@config';
import { logger } from '@utils/logger';

export const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || apiKey !== ADMIN_API_KEY) {
      logger.warn(`Unauthorized API access attempt to ${req.originalUrl}`);
      return res.status(401).json({ message: 'Unauthorized: Invalid API Key' });
    }

    next();
  } catch (error) {
    next(error);
  }
};
